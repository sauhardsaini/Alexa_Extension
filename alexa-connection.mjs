import path from 'node:path';
import { AlexaBridge, REGIONS } from './alexa/bridge.mjs';
import { AppError } from './alexa/errors.mjs';
import { AppError as LibraryAppError } from './library/errors.mjs';

export const AMAZON_REGIONS = Object.entries(REGIONS).map(([id, value]) => ({ id, name: ({ IN: 'India', US: 'United States', UK: 'United Kingdom', DE: 'Germany', CA: 'Canada', AU: 'Australia', JP: 'Japan' })[id], locale: value.locale, country: value.country }));
export const AMAZON_LOCALES = [
  ['en-IN', 'English (India)'], ['hi-IN', 'Hindi (India)'], ['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['en-CA', 'English (Canada)'], ['fr-CA', 'French (Canada)'], ['en-AU', 'English (Australia)'], ['de-DE', 'German'], ['ja-JP', 'Japanese']
].map(([id, name]) => ({ id, name }));
export class AmazonConnectionError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new AmazonConnectionError(status, code, message); };
const safeText = (value, max = 250) => typeof value === 'string' && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ? value.trim() : '';
const messages = {
  disconnected: 'Connect your Amazon account to find your Echo.',
  connecting: 'Preparing your Amazon connection…',
  awaiting_login: 'Open Amazon sign-in and complete any verification there, then return here.',
  connected: 'Amazon connected. Choose your Echo in the extension.',
  error: 'Amazon could not be connected. Check your account country, disconnect, and try signing in again.'
};
function safeFailure(error) {
  if (error instanceof AmazonConnectionError) return error;
  // Only the vendored bridge's deliberately authored AppErrors may reach the UI.
  if (error instanceof AppError || error instanceof LibraryAppError) return new AmazonConnectionError(error.status, error.code, error.message);
  return new AmazonConnectionError(502, 'AMAZON_UNAVAILABLE', 'The Amazon connection could not complete this request. Try again.');
}
function within(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new AmazonConnectionError(504, 'AMAZON_TIMEOUT', 'Amazon did not confirm this request in time.')), timeoutMs); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
export function createAmazonConnection({ dataDir, proxyPort = 4321, bridgeFactory = options => new AlexaBridge(options) } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('A private Amazon session folder is required.');
  // alexa-cookie2's registration store also inherits this owner-only default.
  process.umask(0o077);
  const bridge = bridgeFactory({ dataDir: path.resolve(dataDir), proxyPort });
  const status = () => {
    const raw = bridge.status();
    const state = Object.hasOwn(messages, raw.connection?.state) ? raw.connection.state : 'error';
    const connection = { state, message: messages[state] };
    if (state === 'awaiting_login' && raw.connection?.loginUrl === `http://127.0.0.1:${proxyPort}/`) connection.loginUrl = raw.connection.loginUrl;
    const region = REGIONS[raw.settings?.region] ? raw.settings.region : 'IN';
    const settings = { region, country: REGIONS[region].country, locale: AMAZON_LOCALES.some(row => row.id === raw.settings?.locale) ? raw.settings.locale : REGIONS[region].locale };
    const devices = (Array.isArray(raw.devices) ? raw.devices : []).slice(0, 100).map(device => ({ id: safeText(device?.id), name: safeText(device?.name, 100), online: device?.online !== false })).filter(device => device.id && device.name);
    if (state === 'connected' && !devices.length) connection.message = 'Amazon connected, but no Echo was found. Check that it is registered to this account.';
    return { connection, settings, devices, regions: AMAZON_REGIONS, locales: AMAZON_LOCALES };
  };
  const connect = async ({ region = bridge.settings?.region || 'IN', locale } = {}) => {
    if (!REGIONS[region]) fail(400, 'INVALID_REGION', 'Choose your Amazon account’s country.');
    if (locale && !AMAZON_LOCALES.some(row => row.id === locale)) fail(400, 'INVALID_LOCALE', 'Choose a supported Echo language.');
    try { await bridge.connect({ region, locale: locale || REGIONS[region].locale }); return status(); }
    catch (error) {
      if (!['CONNECTION_BUSY', 'INVALID_REGION', 'INVALID_LOCALE'].includes(error?.code)) {
        try { bridge.disconnect({ forget: false }); } catch {}
      }
      throw safeFailure(error);
    }
  };
  const disconnect = () => { try { bridge.disconnect({ forget: true }); return status(); } catch (error) { throw safeFailure(error); } };
  const upstream = async (route, { method = 'GET', body, timeoutMs = 6000 } = {}) => {
    try {
      if (method === 'GET' && route === '/api/status') return { ...status(), player: bridge.status().player || null };
      if (method === 'GET' && route === '/api/music-providers') return await within(bridge.musicProviders(), Math.min(timeoutMs, 6000));
      if (method === 'GET' && /^\/api\/player\?deviceId=[^&#]+$/.test(route)) {
        const deviceId = new URL(route, 'http://127.0.0.1').searchParams.get('deviceId');
        return await within(bridge.player ? bridge.player(deviceId, { fresh: true, timeoutMs: 2500 }) : bridge.freshPlayer(deviceId), Math.min(timeoutMs, 6000));
      }
      if (method === 'POST' && route === '/api/command') return await within(bridge.sendTextCommand(body?.text, body?.deviceId, { kind: 'music' }), Math.min(timeoutMs, 18000));
      if (method === 'GET' && route === '/api/commands') return bridge.commands();
      if (method === 'POST' && route === '/api/custom-command') {
        const text = safeText(body?.text, 500), deviceId = safeText(body?.deviceId);
        if (!text) fail(400, 'INVALID_COMMAND', 'Enter a single-line command of 1 to 500 characters.');
        if (!deviceId) fail(400, 'INVALID_DEVICE', 'Choose your Echo speaker first.');
        const result = await within(bridge.sendTextCommand(text, deviceId, { kind: 'custom' }), Math.min(timeoutMs, 18000));
        const command = bridge.commands().commands.find(entry => entry.id === result.commandId) || null;
        return { ...result, command };
      }
      if (method === 'POST' && route === '/api/control') {
        if (body?.action === 'volume') {
          if (!Number.isInteger(body.volume) || body.volume < 0 || body.volume > 100) fail(400, 'INVALID_VOLUME', 'Choose a volume between 0 and 100%.');
          return await within(bridge.setVolume(body.deviceId, body.volume), Math.min(timeoutMs, 18000));
        }
        if (body?.action === 'seek') {
          if (!Number.isInteger(body.positionMs) || body.positionMs < 0 || body.positionMs > 24 * 60 * 60_000) fail(400, 'INVALID_POSITION', 'Choose a valid song position.');
          return await within(bridge.seek(body.deviceId, body.positionMs, body.expectedTrack || null), Math.min(timeoutMs, 22000));
        }
        if (!['pause', 'resume', 'next', 'previous'].includes(body?.action)) fail(400, 'INVALID_CONTROL', 'Choose a supported playback control.');
        return await within(bridge.control(body?.deviceId, body?.action), Math.min(timeoutMs, 18000));
      }
      fail(400, 'UNSUPPORTED_ACTION', 'This Amazon action is unavailable.');
    } catch (error) { throw safeFailure(error); }
  };
  const restore = async () => {
    try { await bridge.restore(); } catch { try { bridge.disconnect({ forget: false }); } catch {} }
    return status();
  };
  const stop = () => { try { bridge.disconnect({ forget: false }); } catch {} };
  return { bridge, upstream, status, connect, disconnect, restore, stop };
}
