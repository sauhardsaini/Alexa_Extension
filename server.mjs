import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { libraryRoute } from './extension/library-protocol.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCES = new Map([['youtube-music', 'music.youtube.com'], ['spotify', 'open.spotify.com'], ['apple-music', 'music.apple.com']]);
const COUNTRIES = new Set(['IN', 'US', 'GB', 'DE', 'CA', 'AU', 'JP']);
const BASE_PROVIDERS = [
  { id: 'alexa-default', name: 'Alexa default', kind: 'default', commandName: '' },
  { id: 'apple-music', name: 'Apple Music', kind: 'music', commandName: 'Apple Music' },
  { id: 'amazon-music', name: 'Amazon Music', kind: 'music', commandName: 'Amazon Music' },
  { id: 'spotify', name: 'Spotify', kind: 'music', commandName: 'Spotify' },
  { id: 'jiosaavn', name: 'JioSaavn', kind: 'music', commandName: 'JioSaavn' }
];
const EXTENSION_ID = /^[a-p]{32}$/;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const AMAZON_REGIONS = [
  { id: 'IN', name: 'India', locale: 'en-IN', country: 'IN' },
  { id: 'US', name: 'United States', locale: 'en-US', country: 'US' },
  { id: 'UK', name: 'United Kingdom', locale: 'en-GB', country: 'GB' },
  { id: 'DE', name: 'Germany', locale: 'de-DE', country: 'DE' },
  { id: 'CA', name: 'Canada', locale: 'en-CA', country: 'CA' },
  { id: 'AU', name: 'Australia', locale: 'en-AU', country: 'AU' },
  { id: 'JP', name: 'Japan', locale: 'ja-JP', country: 'JP' }
];
const AMAZON_LOCALES = [
  { id: 'en-IN', name: 'English (India)' }, { id: 'hi-IN', name: 'Hindi (India)' },
  { id: 'en-US', name: 'English (United States)' }, { id: 'en-GB', name: 'English (United Kingdom)' },
  { id: 'en-CA', name: 'English (Canada)' }, { id: 'fr-CA', name: 'French (Canada)' },
  { id: 'en-AU', name: 'English (Australia)' }, { id: 'de-DE', name: 'German' }, { id: 'ja-JP', name: 'Japanese' }
];
class CompanionError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new CompanionError(status, code, message); };
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
const normalize = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim().replace(/\s+/gu, ' ') : '';
const identityKey = value => normalize(value) || safeText(value).toLowerCase();
const digest = value => createHash('sha256').update(value).digest('hex');
function safeText(value, max = 250) { return typeof value === 'string' && value.trim() && value.length <= max && !CONTROL.test(value) ? value.trim().replace(/\s+/gu, ' ') : ''; }
function requiredText(value, label, max = 250) {
  const result = safeText(value, max);
  if (!result) fail(400, 'INVALID_METADATA', `${label} must be a single line of up to ${max} characters.`);
  return result;
}
function safeSourceUrl(value, source) {
  if (!value) return '';
  let url; try { url = new URL(value); } catch { fail(400, 'INVALID_SOURCE_URL', 'Choose a song from a supported music website.'); }
  if (url.protocol !== 'https:' || url.hostname !== SOURCES.get(source) || url.username || url.password || url.port) fail(400, 'INVALID_SOURCE_URL', 'The song link does not belong to its music website.');
  const clean = new URL(url.origin + url.pathname);
  for (const key of source === 'youtube-music' ? ['v'] : source === 'apple-music' ? ['i'] : []) {
    const id = url.searchParams.get(key); if (id && /^[\w-]{1,100}$/.test(id)) clean.searchParams.set(key, id);
  }
  return clean.href;
}
export function validateTrack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SOURCES.has(value.source)) fail(400, 'INVALID_TRACK', 'Choose a song from Apple Music, Spotify, or YouTube Music.');
  if (value.isAd === true) fail(400, 'ADVERTISEMENT', 'Advertisements cannot be sent as songs.');
  const title = requiredText(value.title, 'Song title'), artist = requiredText(value.artist, 'Artist');
  const track = { title, artist, source: value.source, album: value.album === undefined || value.album === '' ? '' : requiredText(value.album, 'Album'), url: safeSourceUrl(value.url, value.source) };
  if (value.trackId !== undefined && value.trackId !== '') track.trackId = requiredText(value.trackId, 'Song identifier', 200);
  if (value.artistNames !== undefined) {
    if (!Array.isArray(value.artistNames) || value.artistNames.length > 12) fail(400, 'INVALID_ARTIST_CREDITS', 'Use at most 12 separately identified artist credits.');
    const seen = new Set();
    track.artistNames = value.artistNames.map(name => requiredText(name, 'Artist credit')).filter(name => {
      const key = identityKey(name); if (!key || seen.has(key)) return false; seen.add(key); return true;
    });
  }
  if (value.durationMs !== undefined) {
    if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs <= 0 || value.durationMs > 24 * 60 * 60_000) fail(400, 'INVALID_DURATION', 'The song duration could not be read.');
    track.durationMs = Math.round(value.durationMs);
  }
  return track;
}
function publicPlayer(value, suppliedVolume = undefined) {
  if (!value || typeof value !== 'object') return null;
  const result = { state: ['PLAYING', 'PAUSED', 'STOPPED', 'IDLE', 'FINISHED', 'UNKNOWN', 'BUFFERING'].includes(value.state) ? value.state : 'UNKNOWN', title: safeText(value.title, 500), artist: safeText(value.artist, 500), album: safeText(value.album, 500), providerName: safeText(value.providerName, 100), deviceId: safeText(value.deviceId, 250) };
  if (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs > 0) result.durationMs = value.durationMs;
  if (typeof value.positionMs === 'number' && Number.isFinite(value.positionMs) && value.positionMs >= 0) result.positionMs = value.positionMs;
  const volume = suppliedVolume === undefined ? value.volume : suppliedVolume;
  result.volume = Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : null;
  return result;
}
function publicCommand(value) {
  if (!value || typeof value !== 'object' || !safeText(value.id, 100) || !['music', 'control', 'custom'].includes(value.kind)) return null;
  const status = ['sending', 'sent', 'failed'].includes(value.status) ? value.status : 'unknown';
  let responseStatus = ['pending', 'available', 'unavailable', 'ambiguous'].includes(value.responseStatus) ? value.responseStatus : 'unavailable';
  const response = responseStatus === 'available' ? safeText(value.response, 500) || null : null;
  if (responseStatus === 'available' && !response) responseStatus = 'unavailable';
  const observation = value.observation && typeof value.observation === 'object' ? { state: publicPlayer(value.observation)?.state || 'UNKNOWN', title: safeText(value.observation.title, 500), artist: safeText(value.observation.artist, 500), providerName: safeText(value.observation.providerName, 100) } : null;
  return { id: safeText(value.id, 100), text: safeText(value.text, 500), kind: value.kind, deviceId: safeText(value.deviceId, 250), deviceName: safeText(value.deviceName, 100), status, message: ({ sending: 'Sending your command…', sent: 'Alexa accepted the request.', failed: 'Alexa did not confirm the request.', unknown: 'The command status is unavailable.' })[status], createdAt: Number.isFinite(value.createdAt) ? value.createdAt : 0, updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0, responseStatus, response, observation };
}
function publicDevices(value) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map(device => ({ id: safeText(device?.id, 250), name: safeText(device?.name, 100) })).filter(device => device.id && device.name);
}
function publicConnection(value, devices = []) {
  const messages = {
    disconnected: 'Connect your Amazon account here to find your Echo.',
    connecting: 'Preparing your local Amazon connection…',
    awaiting_login: 'Open Amazon sign-in, complete any verification, then return here.',
    connected: devices.length ? 'Amazon connected. Choose your Echo to play music.' : 'Amazon connected, but no Echo was found. Check the account used to register your Echo.',
    error: 'Amazon could not be connected. Check the account country, disconnect, and try again.',
    unavailable: 'The Amazon connection is not available. Restart Echo Companion and try again.'
  };
  const state = Object.hasOwn(messages, value?.state) ? value.state : 'unavailable';
  const connection = { state, message: messages[state] };
  if (state === 'awaiting_login' && ['http://127.0.0.1:4321/', 'http://localhost:4321/'].includes(value.loginUrl)) connection.loginUrl = value.loginUrl;
  return connection;
}
function publicSettings(value) {
  const region = AMAZON_REGIONS.find(item => item.id === value?.region) || AMAZON_REGIONS[0];
  return { region: region.id, locale: AMAZON_LOCALES.some(item => item.id === value?.locale) ? value.locale : region.locale, country: region.country };
}
export function publicAmazonStatus(value) {
  const devices = publicDevices(value?.devices);
  return { connection: publicConnection(value?.connection, devices), settings: publicSettings(value?.settings), devices, regions: copy(AMAZON_REGIONS), locales: copy(AMAZON_LOCALES) };
}
function providerMatches(provider, name) {
  if (provider.id === 'alexa-default') return true;
  const aliases = provider.id === 'amazon-music' ? ['Amazon Music', 'Amazon Prime Music', 'Prime Music', 'Amazon Music Unlimited'] : provider.id === 'jiosaavn' ? ['JioSaavn', 'Jio Saavn', 'Saavn'] : [provider.name, provider.commandName];
  return aliases.some(alias => normalize(alias) === normalize(name));
}
export function getArtistCandidates(track, max = 4) {
  const seen = new Set(), candidates = [];
  const credits = (Array.isArray(track?.artistNames) ? track.artistNames.slice(0, 12) : []).filter(name => safeText(name));
  const values = credits.length ? credits : [track?.artist];
  for (const value of values) {
    const name = safeText(value), key = identityKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key); candidates.push(name);
  }
  // Punctuation belongs to many band names. Only separately identified credits
  // supply additional artist wordings; never split commas, '&', or 'and' here.
  return candidates.slice(0, Math.max(1, Math.min(4, Number.isInteger(max) ? max : 4)));
}
function trailingFeaturedTitle(value) {
  const title = safeText(value, 500);
  const match = /^(.*?)\s*(?:\(\s*(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+)\s*\)|\[\s*(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+)\s*\])$/iu.exec(title);
  if (!match) return null;
  const base = safeText(match[1], 500), credit = safeText(match[2] || match[3]);
  // A featured credit alone can vary between services; nested or mixed
  // recording/version annotations must retain their exact title identity.
  if (!base || !credit || /[()[\]]/u.test(base) || /\b(?:live|remix|mix|acoustic|edit|version|remaster(?:ed)?|instrumental|demo|cover|karaoke|slowed|reverb|sped|radio|extended|session|mono|stereo)\b/iu.test(credit)) return null;
  return { base, credit };
}
function oneSidedFeaturedTitle(left, right) {
  const leftFeatured = trailingFeaturedTitle(left), rightFeatured = trailingFeaturedTitle(right);
  if (!!leftFeatured === !!rightFeatured) return null;
  const featured = leftFeatured || rightFeatured, bare = leftFeatured ? right : left;
  return identityKey(featured.base) === identityKey(bare) ? featured : null;
}
const artistSpellingKey = value => identityKey(typeof value === 'string' ? value.replace(/['‘’]/gu, '') : value);
const artistCreditKey = value => safeText(value, 500).normalize('NFKC').toLowerCase().replace(/['‘’]/gu, '').replace(/\s+/gu, ' ').trim();
function trustedArtistCredit(track, reported) {
  const known = (Array.isArray(track?.artistNames) ? track.artistNames.slice(0, 12) : []).filter(name => safeText(name));
  const spelling = artistSpellingKey(reported);
  if ([track?.artist, ...known].some(name => safeText(name) && artistSpellingKey(name) === spelling)) return true;
  // Consume whole structured names, including punctuation inside a band name.
  // Only delimiters BETWEEN known names may differ; unknown or partial names fail.
  const names = [...new Set(known.map(artistCreditKey))].filter(Boolean).sort((a, b) => b.length - a.length);
  let remaining = artistCreditKey(reported);
  const used = new Set(), separator = /^(?:\s*,\s*(?:(?:&|\band\b)\s*)?|\s*&\s*|\s+(?:and|featuring|feat\.?|ft\.?)\s+)/u;
  while (remaining && used.size < names.length) {
    const name = names.find(value => !used.has(value) && remaining.startsWith(value) && (!remaining.slice(value.length) || separator.test(remaining.slice(value.length))));
    if (!name) return false;
    used.add(name); remaining = remaining.slice(name.length);
    if (!remaining) return used.size >= 2;
    const delimiter = separator.exec(remaining);
    if (!delimiter) return false;
    remaining = remaining.slice(delimiter[0].length);
    if (!remaining) return false;
  }
  return false;
}
function soundtrackTitle(value) {
  const match = /^(.*?)\s*\(\s*from\s+([^()[\]]+)\s*\)$/iu.exec(safeText(value, 500));
  if (!match) return null;
  const base = safeText(match[1], 500), film = identityKey(match[2]);
  if (!base || !film || /[()[\]]/u.test(base)) return null;
  return { base, film };
}
function oneSidedSoundtrackTitle(left, right, album) {
  const leftSoundtrack = soundtrackTitle(left), rightSoundtrack = soundtrackTitle(right);
  if (!!leftSoundtrack === !!rightSoundtrack) return false;
  const qualified = leftSoundtrack || rightSoundtrack, bare = leftSoundtrack ? right : left;
  const albumKey = identityKey(album).replace(/\s+(?:original motion picture soundtrack|motion picture soundtrack|original soundtrack|soundtrack|ost)$/u, '');
  return !!albumKey && qualified.film === albumKey && identityKey(qualified.base) === identityKey(bare);
}
export function compareReported(track, player, provider) {
  if (!player || player.state !== 'PLAYING' || !player.title || !player.artist) return 'unknown';
  // Keep version labels: Lover, Lover (Remix), and Lover (Live) are different recordings.
  const creditedArtists = (Array.isArray(track?.artistNames) ? track.artistNames.slice(0, 12) : []).filter(name => safeText(name)).map(identityKey);
  const artistKeys = [track?.artist].filter(name => safeText(name)).map(identityKey).concat(creditedArtists);
  const titleKey = identityKey(track?.title);
  if (!titleKey || !artistKeys.length) return 'unknown';
  let needsCorroboration = !artistKeys.includes(identityKey(player.artist));
  if (needsCorroboration && !trustedArtistCredit(track, player.artist)) return 'mismatch';
  if (titleKey !== identityKey(player.title)) {
    const featured = oneSidedFeaturedTitle(track?.title, player.title);
    const knownFeature = featured && creditedArtists.includes(identityKey(featured.credit));
    if (!knownFeature && !oneSidedSoundtrackTitle(track?.title, player.title, track?.album)) return 'mismatch';
    needsCorroboration = true;
  }
  // A credited-artist subset or title annotation needs stronger evidence than
  // an exact identity: an explicit actual service and both measured durations.
  if (needsCorroboration && (provider.id === 'alexa-default' || !player.providerName || ![track.durationMs, player.durationMs].every(value => Number.isFinite(value) && value > 0))) return 'unknown';
  if (provider.id !== 'alexa-default' && !player.providerName) return 'unknown';
  if (!providerMatches(provider, player.providerName)) return 'mismatch';
  if (track.durationMs && player.durationMs && Math.abs(track.durationMs - player.durationMs) > Math.max(5000, track.durationMs * .03)) return 'mismatch';
  return 'match';
}
export function buildCommand(track, provider) {
  const command = `play song ${track.title} by ${track.artist}${provider.commandName ? ` on ${provider.commandName}` : ''}`;
  if (command.length > 500) fail(400, 'COMMAND_TOO_LONG', 'Shorten the song title or artist before sending it to your Echo.');
  return command;
}

class PairingStore {
  constructor(file) { this.file = file; this.value = null; this.chain = Promise.resolve(); }
  async load() {
    try { const value = JSON.parse(await fs.readFile(this.file, 'utf8')); if (/^[a-f0-9]{64}$/.test(value?.hash) && (!value.extensionId || EXTENSION_ID.test(value.extensionId))) this.value = { hash: value.hash, extensionId: value.extensionId || '', createdAt: value.createdAt || 0 }; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw new Error('The local pairing settings could not be read.'); }
    if (this.value) await this.persist();
  }
  status() { return { paired: !!this.value, extensionId: this.value?.extensionId || '', createdAt: this.value?.createdAt || null }; }
  async persist() {
    const snapshot = this.value ? JSON.stringify(this.value) + '\n' : null;
    const save = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }); await fs.chmod(path.dirname(this.file), 0o700);
      if (snapshot === null) { await fs.rm(this.file, { force: true }); return; }
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, snapshot, { mode: 0o600 }); await fs.rename(temporary, this.file); await fs.chmod(this.file, 0o600); }
      finally { await fs.rm(temporary, { force: true }); }
    };
    const promise = this.chain.then(save, save); this.chain = promise.catch(() => {}); return promise;
  }
  async create() {
    const token = randomBytes(32).toString('base64url'); this.value = { hash: digest(token), extensionId: '', createdAt: Date.now() }; await this.persist(); return token;
  }
  async revoke() { this.value = null; await this.persist(); }
  async authorize(req) {
    const headerId = req.headers['x-echo-extension'];
    const origin = req.headers.origin;
    const originId = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin.slice('chrome-extension://'.length) : '';
    const extensionId = typeof headerId === 'string' && EXTENSION_ID.test(headerId) ? headerId : originId;
    if (!extensionId || (origin !== undefined && origin !== `chrome-extension://${extensionId}`)) fail(403, 'EXTENSION_ORIGIN_REQUIRED', 'Use the paired browser extension for this request.');
    if (this.value?.extensionId && this.value.extensionId !== extensionId) fail(403, 'EXTENSION_NOT_PAIRED', 'This extension is not paired with the local helper.');
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    const tokenHash = token ? digest(token) : '';
    if (!this.value || !tokenHash || !timingSafeEqual(Buffer.from(tokenHash), Buffer.from(this.value.hash))) fail(401, 'PAIRING_REQUIRED', 'Create a pairing code in the local helper, then paste it into the extension.');
    const value = this.value;
    if (!value.extensionId) { value.extensionId = extensionId; await this.persist(); if (this.value !== value) fail(401, 'PAIRING_CHANGED', 'The pairing code changed. Pair this extension again.'); }
    return extensionId;
  }
}

export class Companion {
  constructor({ upstream, pollDelayMs = 4000, pollAttempts = 8, seekPollDelayMs = 1200, seekPollAttempts = 3, queueStartTimeoutMs = 2000, quietSearch = false, quietVolume = 1, commandGapMs = 1250, quietConfirmDelayMs = 200, quietConfirmAttempts = 3, diagnostic = null, clock = Date.now } = {}) {
    this.upstream = upstream; this.pollDelayMs = pollDelayMs; this.pollAttempts = pollAttempts; this.clock = clock;
    this.diagnostic = typeof diagnostic === 'function' ? diagnostic : null;
    if (!Number.isInteger(quietVolume) || quietVolume < 1 || quietVolume > 5) throw new Error('Quiet checking volume must be an integer from 1 to 5.');
    this.quietVolume = quietVolume;
    this.quietSearch = quietSearch === true; this.commandGapMs = this.quietSearch ? Math.max(0, commandGapMs) : 0; this.lastDispatchAt = 0; this.quietLease = null; this.quietCleanup = Promise.resolve(true); this.quietConfirmDelayMs = Math.max(0, quietConfirmDelayMs); this.quietConfirmAttempts = Math.max(1, Math.min(5, quietConfirmAttempts));
    this.seekPollDelayMs = seekPollDelayMs; this.seekPollAttempts = seekPollAttempts; this.seekCurrent = null; this.seekGeneration = 0;
    this.queueStartTimeoutMs = Math.max(1, Math.min(2000, Number.isFinite(queueStartTimeoutMs) ? queueStartTimeoutMs : 2000));
    this.intent = 0; this.current = null; this.chain = Promise.resolve(); this.jobs = new Map(); this.ids = new Map(); this.customRequests = new Map(); this.timers = new Set(); this.stopped = false;
    this.providers = BASE_PROVIDERS.map(copy); this.providersUntil = 0; this.providerFlight = null; this.providerGeneration = 0;
  }
  quietEvent(job, phase, volume = null) {
    if (!this.diagnostic) return;
    const level = value => Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
    try { this.diagnostic({ jobId: job.id, phase, volume: level(volume), checkVolume: level(job.quietSearch?.checkVolume), restoreVolume: level(job.quietSearch?.restoreVolume), attempt: job.attempt || 0, maxAttempts: job.maxAttempts || 0 }); } catch {}
  }
  quietStatus() { return this.quietLease ? copy(this.quietLease.public) : null; }
  updateQuiet(lease, phase, message) {
    Object.assign(lease.public, { active: lease.active, phase, checkVolume: lease.checkVolume, restoreVolume: lease.restoreVolume, message, updatedAt: this.clock() });
    lease.job.updatedAt = this.clock();
    this.quietEvent(lease.job, phase, lease.lastObservedVolume);
  }
  async dispatch(route, options, guard = null) {
    const delay = this.commandGapMs - (Date.now() - this.lastDispatchAt);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (guard && !guard()) throw new Error('replaced');
    this.lastDispatchAt = Date.now();
    return this.upstream(route, options);
  }
  async quietPlayer(deviceId) {
    const payload = await this.upstream(`/api/player?deviceId=${encodeURIComponent(deviceId)}`, { timeoutMs: 6000 });
    const player = publicPlayer(payload?.player, payload?.volume);
    if (player?.deviceId && player.deviceId !== deviceId) throw new Error('wrong device');
    const volume = Object.hasOwn(payload || {}, 'volume') ? payload.volume : player?.volume;
    const level = Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : null;
    if (this.quietLease?.deviceId === deviceId) {
      this.quietLease.lastObservedVolume = level;
      this.quietEvent(this.quietLease.job, this.quietLease.public.phase + '/volume', level);
    }
    return { player, volume: level };
  }
  async quietReadUntil(deviceId, predicate) {
    let value = null;
    for (let index = 0; index < this.quietConfirmAttempts; index++) {
      try { value = await this.quietPlayer(deviceId); if (predicate(value)) return value; } catch {}
      if (index + 1 < this.quietConfirmAttempts) await new Promise(resolve => setTimeout(resolve, this.quietConfirmDelayMs));
    }
    return value;
  }
  relinquishQuiet(lease, volume, message = 'The Echo volume changed outside Companion. Checks stopped and your new volume was left unchanged.') {
    if (this.quietLease !== lease) return;
    lease.restoreVolume = volume; lease.active = false;
    this.updateQuiet(lease, 'failed', message); this.quietLease = null;
  }
  async acquireQuiet(job) {
    if (!this.quietSearch) return true;
    if (this.quietLease && !await this.releaseQuiet(this.quietLease)) { this.finish(job, 'error', 'The previous quiet check could not restore Echo volume safely. Stop Echo playback in Alexa and restore its volume before trying again.'); return false; }
    if (!this.isCurrent(job)) return false;
    job.quietSearch = { active: false, phase: 'preparing', checkVolume: this.quietVolume, restoreVolume: null, deviceId: job.deviceId, jobId: job.id, message: 'Reading Echo volume before checking quietly…', updatedAt: this.clock() };
    let lease = null;
    try {
      const before = await this.quietReadUntil(job.deviceId, value => value.volume !== null);
      if (!this.isCurrent(job)) return false;
      if (!before || before.volume === null) throw new Error('unknown volume');
      if (before.volume === 0) {
        Object.assign(job.quietSearch, { active: false, phase: 'failed', restoreVolume: 0, message: 'Choose an Echo playback volume above 0 before using very quiet song checks. No song candidate was sent and volume was not raised.' });
        this.quietEvent(job, 'baseline-zero', 0); this.finish(job, 'error', job.quietSearch.message); return false;
      }
      lease = { job, jobId: job.id, deviceId: job.deviceId, checkVolume: Math.min(this.quietVolume, before.volume), restoreVolume: before.volume, lastObservedVolume: before.volume, active: true, quietConfirmed: false, candidateSent: false, restoring: false, restoreVolumes: new Set(), cleanupPromise: null, public: job.quietSearch };
      this.quietLease = lease; this.updateQuiet(lease, 'preparing', `Setting Echo very quiet at ${lease.checkVolume}% while song candidates are checked…`);
      await this.dispatch('/api/control', { method: 'POST', body: { deviceId: job.deviceId, action: 'volume', volume: lease.checkVolume }, timeoutMs: 6000 }, () => this.isCurrent(job));
      if (!this.isCurrent(job)) return false;
      const quiet = await this.quietReadUntil(job.deviceId, value => value.volume === lease.checkVolume);
      if (!this.isCurrent(job)) return false;
      if (!quiet || quiet.volume !== lease.checkVolume) {
        if (quiet?.volume !== null && quiet?.volume !== undefined && quiet.volume !== lease.restoreVolume) this.relinquishQuiet(lease, quiet.volume, 'Echo did not confirm the very quiet level. No song candidate was sent; the externally changed volume was left unchanged.');
        throw new Error('quiet level unconfirmed');
      }
      lease.quietConfirmed = true; this.updateQuiet(lease, 'muted', `Echo stays very quiet at ${lease.checkVolume}% while the selected song is checked.`); return true;
    } catch {
      job.quietSearch.active = !!lease?.active;
      job.quietSearch.phase = 'failed'; job.quietSearch.message = 'Very quiet playback could not be confirmed. No song candidate was sent.';
      this.finish(job, 'error', job.quietSearch.message); return false;
    }
  }
  async ensureQuietCandidate(job) {
    if (!this.quietSearch) return true;
    const lease = this.quietLease;
    if (!lease || lease.job !== job || !lease.active || !lease.quietConfirmed) return false;
    const current = await this.quietReadUntil(job.deviceId, value => value.volume !== null);
    if (!this.isCurrent(job)) return false;
    if (current?.volume !== lease.checkVolume) {
      if (current?.volume !== null && current?.volume !== undefined) this.relinquishQuiet(lease, current.volume);
      this.finish(job, 'unverified', 'Echo was no longer at the expected very quiet level. Further song attempts stopped.'); return false;
    }
    return true;
  }
  async releaseQuiet(lease, { matchedJob = null, provider = null } = {}) {
    if (!lease || !lease.active || this.quietLease !== lease) return true;
    try {
      let current = await this.quietReadUntil(lease.deviceId, value => value.volume !== null);
      if (!current || current.volume === null) throw new Error('unknown volume');
      if (current.volume !== lease.checkVolume && !lease.restoreVolumes.has(current.volume) && (lease.quietConfirmed || current.volume !== lease.restoreVolume)) { this.relinquishQuiet(lease, current.volume); return !matchedJob; }
      if (matchedJob) {
        if (!this.isCurrent(matchedJob) || compareReported(matchedJob.track, current.player, provider) !== 'match' || current.volume !== lease.checkVolume) throw new Error('song changed');
      } else if (lease.candidateSent) {
        // An uncertain candidate must be observed stopped before restoring volume.
        try { await this.dispatch('/api/control', { method: 'POST', body: { deviceId: lease.deviceId, action: 'pause' }, timeoutMs: 6000 }); } catch {}
        current = await this.quietReadUntil(lease.deviceId, value => value.player && ['PAUSED', 'STOPPED', 'IDLE', 'FINISHED'].includes(value.player.state));
        if (!current?.player || !['PAUSED', 'STOPPED', 'IDLE', 'FINISHED'].includes(current.player.state)) throw new Error('pause unconfirmed');
      }
      this.updateQuiet(lease, 'restoring', matchedJob ? 'The correct song is confirmed. Restoring Echo volume…' : 'Playback is safe to restore volume. Restoring Echo volume…');
      lease.restoring = true;
      for (let attempt = 0; attempt < 3; attempt++) {
        const target = lease.restoreVolume;
        await this.dispatch('/api/control', { method: 'POST', body: { deviceId: lease.deviceId, action: 'volume', volume: target }, timeoutMs: 6000 }, () => {
          if (matchedJob && !this.isCurrent(matchedJob)) return false;
          lease.restoreVolumes.add(target); return true;
        });
        if (matchedJob && !this.isCurrent(matchedJob)) throw new Error('replaced during restore');
        const restored = await this.quietReadUntil(lease.deviceId, value => value.volume === target);
        if (!restored || restored.volume !== target) throw new Error('restore unconfirmed');
        if (matchedJob && (!this.isCurrent(matchedJob) || compareReported(matchedJob.track, restored.player, provider) !== 'match')) throw new Error('song changed during restore');
        if (target !== lease.restoreVolume) continue;
        lease.active = false; this.updateQuiet(lease, 'restored', 'Echo volume restored.');
        if (this.quietLease === lease) this.quietLease = null;
        return true;
      }
      throw new Error('target changing');
    } catch {
      lease.restoring = false;
      this.updateQuiet(lease, 'failed', 'Echo volume could not be restored safely. Stop playback in the Alexa app, then set its volume there, or change the saved volume here to retry safe cleanup.');
      return false;
    }
  }
  cleanup() {
    const lease = this.quietLease;
    if (!lease || !lease.active) return this.quietCleanup.then(() => true);
    if (lease.cleanupPromise) return lease.cleanupPromise;
    const promise = this.queue(() => this.releaseQuiet(lease));
    lease.cleanupPromise = promise;
    this.quietCleanup = promise.finally(() => { if (lease.cleanupPromise === promise) lease.cleanupPromise = null; });
    return this.quietCleanup;
  }
  status() { return copy(this.current); }
  jobStatus(id) {
    const jobId = requiredText(id, 'Song request identifier', 100), job = this.jobs.get(jobId);
    if (!job) fail(404, 'JOB_NOT_FOUND', 'This song request is no longer available.');
    return { job: copy(job), isCurrent: this.current === job && job.intent === this.intent && !this.stopped, currentJobId: this.current?.id || null };
  }
  async readCommands() {
    let payload;
    try { payload = await this.upstream('/api/commands'); }
    catch { fail(502, 'COMMAND_HISTORY_UNAVAILABLE', 'The command history could not be read. Try again.'); }
    return { commands: (Array.isArray(payload?.commands) ? payload.commands : []).slice(0, 100).map(publicCommand).filter(Boolean), retention: 'session' };
  }
  isCurrent(job) { return !this.stopped && this.current === job && job.active && job.intent === this.intent; }
  finish(job, state, message) {
    if (!this.isCurrent(job)) return;
    job.state = state; job.active = false; job.message = message; job.updatedAt = this.clock();
    if (state !== 'matched' && this.quietLease?.job === job) this.cleanup();
  }
  cancel(message = 'Song checks cancelled. An unconfirmed quiet candidate will be paused before volume is restored.') {
    if (this.current?.active) {
      Object.assign(this.current, { active: false, state: 'cancelled', message, updatedAt: this.clock() });
      const attempt = this.current.attempts?.at(-1);
      if (attempt && ['sending', 'checking'].includes(attempt.state)) Object.assign(attempt, { state: 'cancelled', message, updatedAt: this.clock() });
    }
    ++this.intent; ++this.seekGeneration;
    if (this.seekCurrent?.active) Object.assign(this.seekCurrent, { active: false, state: 'cancelled', confirmed: false, message, updatedAt: this.clock() });
    for (const timer of this.timers) { clearTimeout(timer.handle); timer.resolve(false); } this.timers.clear();
    if (this.quietLease) this.cleanup();
    return this.status();
  }
  connectionChanged() {
    this.cancel('The Amazon connection changed.');
    ++this.providerGeneration; this.providers = BASE_PROVIDERS.map(copy); this.providersUntil = 0; this.providerFlight = null;
    return this.cleanup();
  }
  stop() { this.cancel('The local helper closed.'); this.stopped = true; return this.cleanup(); }
  wait(job) {
    return new Promise(resolve => {
      const timer = { resolve, handle: null };
      timer.handle = setTimeout(() => { this.timers.delete(timer); resolve(this.isCurrent(job)); }, this.pollDelayMs);
      timer.handle.unref?.(); this.timers.add(timer);
    });
  }
  async loadProviders() {
    if (this.clock() < this.providersUntil) return this.providers;
    if (this.providerFlight) return this.providerFlight;
    const generation = this.providerGeneration;
    const flight = (async () => {
      try {
        const payload = await this.upstream('/api/music-providers');
        if (generation !== this.providerGeneration) return this.providers;
        const map = new Map(BASE_PROVIDERS.map(item => [item.id, copy(item)]));
        for (const row of Array.isArray(payload.providers) ? payload.providers.slice(0, 100) : []) {
          if (!row || typeof row.id !== 'string' || !/^[a-z][a-z0-9-]{1,79}$/.test(row.id) || !['music', 'default', 'radio'].includes(row.kind)) continue;
          const name = safeText(row.name, 64); if (!name || !/^[\p{L}\p{N}][\p{L}\p{N} .&’'+()\-]{1,63}$/u.test(name)) continue;
          if (!map.has(row.id)) map.set(row.id, { id: row.id, name, kind: row.kind, commandName: name });
        }
        this.providers = [...map.values()]; this.providersUntil = this.clock() + 60_000;
      } catch { if (generation === this.providerGeneration) this.providersUntil = this.clock() + 10_000; }
      return this.providers;
    })();
    this.providerFlight = flight; try { return await flight; } finally { if (this.providerFlight === flight) this.providerFlight = null; }
  }
  seekStatus(deviceId = '') { return this.seekCurrent && (!deviceId || this.seekCurrent.deviceId === deviceId) ? copy(this.seekCurrent) : null; }
  async readPlayer(deviceId) {
    deviceId = requiredText(deviceId, 'Echo speaker', 250);
    try {
      const result = await this.upstream(`/api/player?deviceId=${encodeURIComponent(deviceId)}`);
      const player = publicPlayer(result.player || { state: 'UNKNOWN', deviceId }, result.volume);
      // A response for another Echo must never populate the selected Echo controls.
      if (player.deviceId && player.deviceId !== deviceId) throw new Error('Device changed');
      player.deviceId = deviceId;
      return { player, volume: player.volume, playerError: '', seek: this.seekStatus(deviceId) };
    } catch { return { player: null, volume: null, playerError: 'The selected Echo is not reporting its playback right now. Try again in a moment.', seek: this.seekStatus(deviceId) }; }
  }
  async readStatus(deviceId = '') {
    if (deviceId) deviceId = requiredText(deviceId, 'Echo speaker', 250);
    // The selected player, providers, and connection are independent reads.
    const [loadedProviders, payload, selected] = await Promise.all([
      this.loadProviders(),
      this.upstream('/api/status').catch(() => null),
      deviceId ? this.readPlayer(deviceId) : Promise.resolve(null)
    ]);
    const providers = loadedProviders.map(({ id, name, kind }) => ({ id, name, kind }));
    try {
      if (!payload) throw new Error('Amazon connection unavailable');
      const devices = publicDevices(payload.devices), connection = publicConnection(payload.connection, devices), settings = publicSettings(payload.settings);
      const connectionState = connection.state, player = selected ? selected.player : publicPlayer(payload.player);
      return { connected: connectionState === 'connected', connectionState, connection, settings, devices, providers, player, volume: selected ? selected.volume : player?.volume ?? null, playerError: selected?.playerError || '', seek: this.seekStatus(deviceId), quietSearch: this.quietStatus(), job: this.status(), message: connection.message };
    } catch { const connection = publicConnection({ state: 'unavailable' }); return { connected: false, connectionState: 'unavailable', connection, settings: publicSettings(null), devices: [], providers, player: null, volume: null, playerError: selected?.playerError || '', seek: this.seekStatus(deviceId), quietSearch: this.quietStatus(), job: this.status(), message: connection.message }; }
  }
  queue(action) { const next = this.chain.catch(() => {}).then(action); this.chain = next.catch(() => {}); return next; }
  play(body) {
    const track = validateTrack(body.track);
    const deviceId = requiredText(body.deviceId, 'Echo speaker', 250);
    const providerId = body.providerId ?? 'apple-music';
    if (typeof providerId !== 'string' || !/^[a-z][a-z0-9-]{1,79}$/.test(providerId)) fail(400, 'INVALID_PROVIDER', 'Choose an Echo streaming service.');
    const country = body.country ?? 'IN'; if (!COUNTRIES.has(country)) fail(400, 'INVALID_COUNTRY', 'Choose a supported country.');
    const requestId = body.requestId === undefined ? randomUUID() : requiredText(body.requestId, 'Request identifier', 100);
    const fingerprint = JSON.stringify({ track, deviceId, providerId, country });
    if (this.customRequests.has(requestId)) fail(409, 'REQUEST_CHANGED', 'Send a new request identifier for a different action.');
    const prior = this.ids.get(requestId);
    if (prior) { if (prior.fingerprint !== fingerprint) fail(409, 'REQUEST_CHANGED', 'Send a new request identifier for a different song.'); return { ok: true, job: copy(this.jobs.get(prior.jobId)), message: 'This song request was already received.' }; }
    this.cancel('Replaced by your newer browser song selection.');
    const job = { id: randomUUID(), requestId, intent: this.intent, active: true, state: 'preparing', message: 'Preparing your Echo request…', track, title: track.title, artist: track.artist, deviceId, providerId, country, countryAvailability: 'unverified', createdAt: this.clock(), updatedAt: this.clock(), command: '', observation: null, observationVerdict: 'unknown', matchingSamples: 0, attempt: 0, maxAttempts: getArtistCandidates(track).length, requestArtist: '', attempts: [] };
    this.current = job; this.jobs.set(job.id, job); this.ids.set(requestId, { fingerprint, jobId: job.id });
    while (this.jobs.size > 100) this.jobs.delete(this.jobs.keys().next().value);
    while (this.ids.size > 100) this.ids.delete(this.ids.keys().next().value);
    this.prepare(job).catch(() => this.finish(job, 'error', 'The Echo request could not be prepared. Check the local connection and try again.'));
    return { ok: true, job: copy(job), message: 'Song received. Preparing the Echo request.' };
  }
  async prepare(job) {
    const providers = await this.loadProviders(); if (!this.isCurrent(job)) return;
    const provider = providers.find(item => item.id === job.providerId);
    if (!provider || provider.kind === 'radio') { this.finish(job, 'error', 'Choose a music streaming service that supports song requests.'); return; }
    const status = await this.upstream('/api/status'); if (!this.isCurrent(job)) return;
    if (status.connection?.state !== 'connected' || !Array.isArray(status.devices) || !status.devices.some(device => device.id === job.deviceId)) { this.finish(job, 'error', 'Connect Amazon in Echo Companion and choose an Echo before sending songs.'); return; }
    const candidates = getArtistCandidates(job.track);
    job.providerName = provider.name; job.maxAttempts = candidates.length;
    if (!await this.queue(() => this.acquireQuiet(job)) || !this.isCurrent(job)) return;
    for (let index = 0; index < candidates.length; index++) {
      if (!this.isCurrent(job)) return;
      const artist = candidates[index], command = buildCommand({ ...job.track, artist }, provider);
      const attempt = { number: index + 1, artist, command, state: 'sending', message: 'Sending the song request to Alexa…', createdAt: this.clock(), updatedAt: this.clock() };
      job.attempt = index + 1; job.requestArtist = artist; job.command = command; job.attempts.push(attempt);
      const sent = await this.queue(async () => {
        if (!this.isCurrent(job) || !await this.ensureQuietCandidate(job)) return false;
        Object.assign(job, { state: 'sending', message: `Trying ${artist} (${job.attempt} of ${job.maxAttempts})…`, updatedAt: this.clock() });
        try {
          if (this.quietLease?.job === job) this.quietLease.candidateSent = true;
          const response = await this.dispatch('/api/command', { method: 'POST', body: { deviceId: job.deviceId, text: command }, timeoutMs: 18_000 }, () => this.isCurrent(job));
          if (!this.isCurrent(job)) return false;
          if (response.status !== 'sent' && !response.commandId) throw new Error('not accepted');
          const commandId = safeText(response.commandId, 100);
          Object.assign(attempt, { state: 'checking', message: 'Alexa accepted the request. Checking reported playback…', commandId, updatedAt: this.clock() });
          Object.assign(job, { state: 'checking', message: `Checking your Echo after requesting ${artist} (${job.attempt} of ${job.maxAttempts})…`, commandId, updatedAt: this.clock() });
          return true;
        } catch {
          const message = 'Alexa did not confirm the request. It may still have reached your Echo; check before trying again.';
          Object.assign(attempt, { state: 'error', message, updatedAt: this.clock() });
          this.finish(job, 'error', message); return false;
        }
      });
      if (!sent || !this.isCurrent(job)) return;
      const result = await this.check(job, provider);
      if (!result || !this.isCurrent(job)) return;
      Object.assign(attempt, { state: result.state, message: result.message, observation: copy(job.observation), updatedAt: this.clock() });
      if (result.state === 'matched' && this.quietSearch) {
        const lease = this.quietLease;
        const restored = lease?.job === job && await this.queue(() => this.releaseQuiet(lease, { matchedJob: job, provider }));
        if (!this.isCurrent(job)) return;
        if (!restored) { this.finish(job, 'unverified', 'The selected song was found, but safe Echo volume restoration could not be confirmed. The browser stays paused.'); return; }
      }
      if (result.state === 'matched' || result.retry === false || index === candidates.length - 1) {
        const message = result.state === 'matched' ? result.message : `${result.message}${candidates.length > 1 && index === candidates.length - 1 ? ' No more artist wordings are available for this song.' : ''}`;
        this.finish(job, result.state, message); return;
      }
      Object.assign(job, { state: 'retrying', message: `The selected song was not confirmed. Trying the next credited artist: ${candidates[index + 1]}.`, updatedAt: this.clock() });
    }
  }
  async check(job, provider) {
    let matches = 0, sawMismatch = false;
    for (let sample = 0; sample < this.pollAttempts; sample++) {
      if (!await this.wait(job)) return null;
      let payload; try { payload = await this.upstream(`/api/player?deviceId=${encodeURIComponent(job.deviceId)}`); }
      catch { return { state: 'unverified', retry: false, message: 'The song request was sent, but your Echo is not reporting its current song. Further artist attempts stopped.' }; }
      if (!this.isCurrent(job)) return null;
      let player = publicPlayer(payload.player, payload.volume);
      if (this.quietSearch && this.quietLease?.job === job) {
        let volume = Object.hasOwn(payload, 'volume') ? payload.volume : player?.volume;
        if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
          // Player responses can temporarily omit speaker volume. Keep owning
          // the quiet setting and reread fresh state before another candidate.
          this.quietEvent(job, 'verification/volume-unknown');
          const recovered = await this.quietReadUntil(job.deviceId, value => value.volume !== null);
          if (!this.isCurrent(job)) return null;
          if (!recovered || recovered.volume === null) return { state: 'unverified', retry: false, message: 'Echo volume is temporarily unavailable. No further song attempts were sent; safe volume cleanup is being checked.' };
          volume = recovered.volume; player = recovered.player;
        }
        this.quietLease.lastObservedVolume = volume;
        this.quietEvent(job, 'verification/volume', volume);
        if (volume !== this.quietLease.checkVolume) {
          this.relinquishQuiet(this.quietLease, volume);
          return { state: 'unverified', retry: false, message: 'Echo volume changed outside Companion. Further song attempts stopped and the new volume was left unchanged.' };
        }
      }
      job.observation = player; job.updatedAt = this.clock();
      const verdict = player?.deviceId && player.deviceId !== job.deviceId ? 'mismatch' : compareReported(job.track, player, provider);
      matches = verdict === 'match' ? matches + 1 : 0;
      job.observationVerdict = verdict; job.matchingSamples = matches;
      if (verdict === 'mismatch') sawMismatch = true;
      if (matches >= 2) return { state: 'matched', retry: false, message: 'Your Echo reports the selected song playing.' };
    }
    return { state: sawMismatch ? 'unmatched' : 'unverified', retry: true, message: sawMismatch ? 'Your Echo reported a different song, artist, recording version, or streaming service.' : 'Alexa accepted the request, but the selected song could not be confirmed.' };
  }
  async verifySeek(seek) {
    let matches = 0;
    const current = () => !this.stopped && this.seekCurrent === seek && seek.active && seek.generation === this.seekGeneration;
    const finish = (state, message) => { if (current()) Object.assign(seek, { active: false, state, confirmed: state === 'confirmed', message, updatedAt: this.clock() }); };
    for (let index = 0; index < this.seekPollAttempts; index++) {
      const proceed = await new Promise(resolve => {
        const timer = { resolve, handle: null };
        timer.handle = setTimeout(() => { this.timers.delete(timer); resolve(current()); }, this.seekPollDelayMs); timer.handle.unref?.(); this.timers.add(timer);
      });
      if (!proceed) return;
      let result; try { result = await this.upstream(`/api/player?deviceId=${encodeURIComponent(seek.deviceId)}`); }
      catch { finish('unverified', 'Seek requested, but the Echo’s new position could not be confirmed.'); return; }
      if (!current()) return;
      const player = publicPlayer(result.player, result.volume); seek.observation = player;
      const sameTrack = player && (!player.deviceId || player.deviceId === seek.deviceId) && identityKey(player.title) === identityKey(seek.track.title) && identityKey(player.artist) === identityKey(seek.track.artist) && (!seek.track.providerName || normalize(player.providerName) === normalize(seek.track.providerName));
      if (player?.title && player?.artist && !sameTrack) { finish('unverified', 'The Echo song changed, so the position request could not be confirmed.'); return; }
      const elapsed = player?.state === 'PLAYING' ? Math.max(0, this.clock() - seek.referenceAt) : 0;
      const expected = Math.min(seek.targetPositionMs + elapsed, seek.track.durationMs - 1);
      const durationMatches = player?.durationMs && Math.abs(player.durationMs - seek.track.durationMs) <= Math.max(5000, seek.track.durationMs * .03);
      const nearTarget = sameTrack && ['PLAYING', 'PAUSED'].includes(player.state) && Number.isFinite(player.positionMs) && durationMatches && Math.abs(player.positionMs - expected) <= 5000;
      matches = nearTarget ? matches + 1 : 0;
      if (matches >= 2) { finish('confirmed', 'Your Echo reports the requested song position.'); return; }
    }
    finish('unverified', 'Seek requested, but the Echo’s new position was not confirmed. This service may not support seeking.');
  }
  customCommand(body) {
    const deviceId = requiredText(body.deviceId, 'Echo speaker', 250), text = requiredText(body.text, 'Command', 500);
    const requestId = body.requestId === undefined ? randomUUID() : requiredText(body.requestId, 'Request identifier', 100);
    const fingerprint = JSON.stringify({ deviceId, text }), prior = this.customRequests.get(requestId);
    if (this.ids.has(requestId) || prior && prior.fingerprint !== fingerprint) fail(409, 'REQUEST_CHANGED', 'Send a new request identifier for a different action.');
    if (prior) return prior.promise.then(copy);
    if (this.quietLease?.active) {
      this.cancel('A custom Alexa command stopped the quiet song check.');
      const result = { ok: false, status: 'not_sent', confirmed: false, requestId, message: 'Echo is finishing quiet playback cleanup. This command was not sent. Try again after volume is restored.' };
      const promise = Promise.resolve(result); this.customRequests.set(requestId, { fingerprint, promise });
      while (this.customRequests.size > 100) this.customRequests.delete(this.customRequests.keys().next().value);
      return promise.then(copy);
    }
    this.cancel('A custom Alexa command replaced the current song check.');
    const intent = this.intent, connectionGeneration = this.providerGeneration, deadline = this.clock() + this.queueStartTimeoutMs;
    let expired = false, started = false, startTimer;
    const notSent = () => ({ ok: false, status: 'not_sent', confirmed: false, requestId, message: 'Previous Echo request is still finishing. This command was not sent. Try again.' });
    const current = () => !this.stopped && intent === this.intent && connectionGeneration === this.providerGeneration;
    const replaced = () => ({ ok: false, status: 'cancelled', confirmed: false, requestId, message: 'A newer request replaced this command. It was not sent.' });
    const queued = this.queue(async () => {
      if (expired || this.clock() >= deadline) { expired = true; return notSent(); }
      started = true; clearTimeout(startTimer);
      if (!current()) return replaced();
      let status;
      try { status = await this.upstream('/api/status'); }
      catch { return { ok: false, status: 'not_sent', confirmed: false, requestId, message: 'The Amazon connection could not be checked. This command was not sent.' }; }
      if (!current()) return replaced();
      if (status.connection?.state !== 'connected' || !Array.isArray(status.devices) || !status.devices.some(device => device.id === deviceId)) return { ok: false, status: 'not_sent', confirmed: false, requestId, message: 'Connect Amazon in Echo Companion and choose an Echo before sending commands.' };
      try {
        const result = await this.dispatch('/api/custom-command', { method: 'POST', body: { deviceId, text }, timeoutMs: 18000 }, current);
        if (result.status !== 'sent' && !safeText(result.commandId, 100)) throw new Error('not accepted');
        const commandId = safeText(result.commandId, 100), command = publicCommand(result.command);
        // Acceptance is distinct from Alexa's answer. The existing journal only
        // publishes a response after its independent history match succeeds.
        return { ok: true, status: 'sent', confirmed: false, requestId, commandId, command, message: 'Alexa accepted the command. Its response may appear in command history.' };
      } catch {
        return { ok: false, status: 'unverified', confirmed: false, requestId, message: 'Alexa did not confirm this command. It may still have reached your Echo; check before trying again.' };
      }
    });
    const waiting = new Promise(resolve => { startTimer = setTimeout(() => { if (!started) { expired = true; resolve(notSent()); } }, this.queueStartTimeoutMs); });
    const promise = Promise.race([queued, waiting]).finally(() => clearTimeout(startTimer));
    this.customRequests.set(requestId, { fingerprint, promise });
    while (this.customRequests.size > 100) this.customRequests.delete(this.customRequests.keys().next().value);
    return promise.then(copy);
  }
  control(body) {
    const deviceId = requiredText(body.deviceId, 'Echo speaker', 250), action = body.action;
    if (!['pause', 'resume', 'next', 'previous', 'seek', 'volume'].includes(action)) fail(400, 'INVALID_CONTROL', 'Choose a supported Echo playback control.');
    if (action === 'volume' && (!Number.isInteger(body.volume) || body.volume < 0 || body.volume > 100)) fail(400, 'INVALID_VOLUME', 'Choose a volume between 0 and 100%.');
    if (action === 'seek' && (!Number.isInteger(body.positionMs) || body.positionMs < 0 || body.positionMs > 24 * 60 * 60_000)) fail(400, 'INVALID_POSITION', 'Choose a valid position in the current song.');
    const expectedTrack = action === 'seek' && body.expectedTrack ? { title: requiredText(body.expectedTrack.title, 'Echo song title', 500), artist: requiredText(body.expectedTrack.artist, 'Echo artist', 500) } : null;
    const quiet = this.quietLease;
    if (action === 'volume' && quiet?.active && quiet.deviceId === deviceId) {
      quiet.restoreVolume = body.volume;
      const failed = quiet.public.phase === 'failed';
      this.updateQuiet(quiet, quiet.public.phase, failed ? 'Saved the new volume. Retrying safe cleanup before restoring Echo volume…' : `Volume saved for after song confirmation. Echo stays very quiet at ${quiet.checkVolume}% while checking.`);
      if (failed) this.cleanup();
      return Promise.resolve({ ok: true, confirmed: false, volume: body.volume, quiet: true, message: quiet.public.message });
    }
    if (action !== 'volume' && quiet?.active) {
      this.cancel('Playback controls stopped the quiet song check.');
      return Promise.resolve({ ok: false, status: 'not_sent', confirmed: false, message: 'Echo is finishing quiet playback cleanup. This control was not sent. Try again after volume is restored.' });
    }
    const connectionGeneration = this.providerGeneration;
    // Volume leaves song verification and Follow intact. Seek leaves Follow intact
    // in the extension, but cancels artist retries that could restart this song.
    if (action !== 'volume') this.cancel(action === 'seek' ? 'A position request replaced the current song check.' : 'Echo playback controls replaced the current song check.');
    const intent = this.intent;
    let seek = null;
    if (action === 'seek') {
      seek = { id: randomUUID(), deviceId, active: true, state: 'preparing', confirmed: false, targetPositionMs: body.positionMs, generation: this.seekGeneration, createdAt: this.clock(), updatedAt: this.clock(), message: 'Preparing the Echo position request…' };
      this.seekCurrent = seek;
    }
    const deadline = this.clock() + this.queueStartTimeoutMs;
    let expired = false, started = false, startTimer;
    const notSent = () => {
      const message = 'Previous Echo request is still finishing. This control was not sent. Try again.';
      if (seek && this.seekCurrent === seek && seek.active) Object.assign(seek, { active: false, confirmed: false, state: 'error', message, updatedAt: this.clock() });
      return { ok: false, confirmed: false, message };
    };
    const queued = this.queue(async () => {
      // A timed-out control stays in the serial queue as a no-op. This flag and
      // deadline check guarantee it cannot dispatch after its caller was told no.
      if (expired || this.clock() >= deadline) { expired = true; return notSent(); }
      started = true; clearTimeout(startTimer);
      if (this.stopped || connectionGeneration !== this.providerGeneration || (action !== 'volume' && intent !== this.intent)) return { ok: false, confirmed: false, message: 'A newer request replaced this control.' };
      const payload = { deviceId, action, ...(action === 'volume' ? { volume: body.volume } : {}), ...(action === 'seek' ? { positionMs: body.positionMs, ...(expectedTrack ? { expectedTrack } : {}) } : {}) };
      try {
        const result = await this.dispatch('/api/control', { method: 'POST', body: payload, timeoutMs: action === 'seek' ? 22000 : 18000 }, () => !this.stopped && connectionGeneration === this.providerGeneration && (action === 'volume' || intent === this.intent));
        if (this.stopped || connectionGeneration !== this.providerGeneration || (action !== 'volume' && intent !== this.intent)) return { ok: false, confirmed: false, message: 'A newer request replaced this control.' };
        if (action === 'volume') return { ok: true, confirmed: false, volume: body.volume, message: 'Volume request sent to your Echo.' };
        if (action === 'seek') {
          const track = result.track;
          if (!track || !safeText(track.title, 500) || !safeText(track.artist, 500) || !Number.isFinite(track.durationMs) || track.durationMs <= 0 || !Number.isInteger(result.targetPositionMs)) {
            Object.assign(seek, { active: false, state: 'unverified', message: 'Seek requested, but its new position could not be confirmed.', updatedAt: this.clock() });
          } else {
            Object.assign(seek, { state: 'checking', targetPositionMs: result.targetPositionMs, referenceAt: Number.isFinite(result.referenceAt) ? result.referenceAt : this.clock(), track: { title: safeText(track.title, 500), artist: safeText(track.artist, 500), providerName: safeText(track.providerName, 100), durationMs: track.durationMs }, message: 'Seek requested. Checking the position reported by your Echo…', updatedAt: this.clock() });
            this.verifySeek(seek).catch(() => { if (this.seekCurrent === seek && seek.active) Object.assign(seek, { active: false, confirmed: false, state: 'unverified', message: 'Seek requested, but its new position could not be confirmed.', updatedAt: this.clock() }); });
          }
          return { ok: true, confirmed: false, seek: this.seekStatus(deviceId), message: seek.message };
        }
        return { ok: true, message: 'Playback control sent to your Echo.' };
      } catch (error) {
        const message = action === 'seek' ? ({ SEEK_UNAVAILABLE: 'Your Echo is not reporting a song position and duration. Try again while a song is playing.', SONG_CHANGED: 'The Echo song changed. Refresh its position before seeking.', INVALID_POSITION: 'Choose a position before the end of the current Echo song.' }[error?.code] || 'Alexa did not confirm the position request. It may still have reached your Echo.') : action === 'volume' ? 'Alexa did not confirm the volume request.' : 'Alexa did not confirm that playback control.';
        if (seek && this.seekCurrent === seek) Object.assign(seek, { active: false, confirmed: false, state: 'error', message, updatedAt: this.clock() });
        return { ok: false, confirmed: false, message };
      }
    });
    const waiting = new Promise(resolve => {
      startTimer = setTimeout(() => {
        if (started) return;
        expired = true; resolve(notSent());
      }, this.queueStartTimeoutMs);
    });
    return Promise.race([queued, waiting]).finally(() => clearTimeout(startTimer));
  }

}

async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'JSON_REQUIRED', 'Use the controls in the local helper or extension.');
  let raw = ''; for await (const chunk of req) { raw += chunk.toString('utf8'); if (Buffer.byteLength(raw) > 8192) fail(413, 'REQUEST_TOO_LARGE', 'This request is too large.'); }
  let body; try { body = JSON.parse(raw); } catch { fail(400, 'INVALID_JSON', 'This request could not be read.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_JSON', 'This request could not be read.');
  return body;
}

export async function createApp({ port = 4320, dataDir = path.join(ROOT, '.local'), upstream = null, amazonConnection = null, library = null, pollDelayMs = 4000, pollAttempts = 8, seekPollDelayMs = 1200, seekPollAttempts = 3, queueStartTimeoutMs = 2000, quietSearch = true, quietVolume = 1, commandGapMs = 1250, quietConfirmDelayMs = 200, quietConfirmAttempts = 3, diagnostic = null, clock = Date.now } = {}) {
  if (!upstream) {
    if (!amazonConnection) {
      const { createAmazonConnection } = await import('./alexa-connection.mjs');
      amazonConnection = createAmazonConnection({ dataDir: path.join(dataDir, 'amazon'), proxyPort: 4321 });
    }
    upstream = (route, options) => amazonConnection.upstream(route, options);
  }
  const amazonStatus = () => publicAmazonStatus(amazonConnection?.status?.() || amazonConnection?.bridge?.status?.() || { connection: { state: 'unavailable' } });
  const pair = new PairingStore(path.join(dataDir, 'pairing.json')); await pair.load();
  const companion = new Companion({ upstream, pollDelayMs, pollAttempts, seekPollDelayMs, seekPollAttempts, queueStartTimeoutMs, quietSearch, quietVolume, commandGapMs, quietConfirmDelayMs, quietConfirmAttempts, diagnostic, clock });
  const server = http.createServer(async (req, res) => {
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const actualPort = server.address()?.port || port;
      const origins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);
      if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(req.headers.host)) fail(403, 'LOCAL_ONLY', 'Open the helper through its local address.');
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || '') ? req.headers.origin : '';
      const isLocal = (!req.headers.origin || origins.has(req.headers.origin)) && req.headers['sec-fetch-site'] !== 'cross-site';
      if (extensionOrigin && (!pair.value?.extensionId || extensionOrigin === `chrome-extension://${pair.value.extensionId}`)) {
        res.setHeader('Access-Control-Allow-Origin', extensionOrigin); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Echo-Extension');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') {
        if (!extensionOrigin || (pair.value?.extensionId && extensionOrigin !== `chrome-extension://${pair.value.extensionId}`)) fail(403, 'CROSS_ORIGIN', 'This browser extension is not paired.');
        res.writeHead(204); return res.end();
      }
      if (library && req.method === 'GET' && ['/', '/app.js', '/app.css', '/media-session.wav', '/favicon.ico'].includes(url.pathname)) {
        const publicNavigation = url.pathname === '/' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
        if (!isLocal && !publicNavigation) fail(403, 'CROSS_ORIGIN', 'Open Echo Library through its local helper.');
        if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.wav') ? 'audio/wav' : 'text/css';
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://js-cdn.music.apple.com; style-src 'self'; connect-src 'self' https://api.music.apple.com https://*.music.apple.com https://*.itunes.apple.com; frame-src https://*.music.apple.com https://*.itunes.apple.com; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        const content = await fs.readFile(path.join(ROOT, 'library', 'public', file));
        res.writeHead(200, { 'Content-Type': type + (file.endsWith('.wav') ? '' : '; charset=utf-8'), 'Cache-Control': 'no-store' }); return res.end(content);
      }
      if (req.method === 'GET' && ['/', '/setup', '/setup/', '/helper.js', '/helper.css', '/favicon.ico'].includes(url.pathname)) {
        // Opening the public pairing page from the extension is a cross-site navigation.
        // Only the top-level document is public; actions and asset fetches keep their guards.
        const topLevelOpen = ['/', '/setup', '/setup/'].includes(url.pathname) && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
        if (!isLocal && !topLevelOpen) fail(403, 'CROSS_ORIGIN', 'Open the helper directly through its local address.');
        if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
        const file = ['/', '/setup', '/setup/'].includes(url.pathname) ? 'index.html' : url.pathname.slice(1);
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css';
        const content = await fs.readFile(path.join(ROOT, 'helper', file)); res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); return res.end(content);
      }
      if (['/api/amazon/status', '/api/amazon/connect', '/api/amazon/disconnect'].includes(url.pathname)) {
        if (!isLocal) fail(403, 'LOCAL_APP_REQUIRED', 'Use the Amazon connection controls in the local helper.');
        if (req.method === 'GET' && url.pathname === '/api/amazon/status') return json(200, { ok: true, ...amazonStatus() });
        if (req.method !== 'POST' || !origins.has(req.headers.origin) || req.headers['x-echo-companion'] !== '1') fail(403, 'LOCAL_APP_REQUIRED', 'Use the Amazon connection controls in the local helper.');
        const body = await readBody(req);
        if (!amazonConnection || (!amazonConnection.connect && !amazonConnection.bridge?.connect)) fail(503, 'AMAZON_UNAVAILABLE', 'The Amazon connection is not available. Restart Echo Companion and try again.');
        if (url.pathname === '/api/amazon/connect') {
          const region = body.region ?? amazonStatus().settings.region;
          if (!AMAZON_REGIONS.some(item => item.id === region)) fail(400, 'INVALID_REGION', 'Choose your Amazon account country.');
          const locale = body.locale === '' || body.locale === undefined ? AMAZON_REGIONS.find(item => item.id === region).locale : body.locale;
          if (!AMAZON_LOCALES.some(item => item.id === locale)) fail(400, 'INVALID_LOCALE', 'Choose a supported Echo language.');
          library?.cancel('The Amazon connection changed.');
          if (!await companion.connectionChanged()) fail(409, 'QUIET_CLEANUP_PENDING', 'Echo volume could not be restored safely. Stop Echo playback and restore its volume in Alexa before changing this connection.');
          try { await (amazonConnection.connect ? amazonConnection.connect({ region, locale }) : amazonConnection.bridge.connect({ region, locale })); }
          catch (error) {
            if (error?.code === 'CONNECTION_BUSY') fail(409, 'CONNECTION_BUSY', 'Amazon sign-in is already in progress. Finish it or disconnect before trying again.');
            if (error?.code === 'LOGIN_PORT_BUSY') fail(409, 'LOGIN_PORT_BUSY', 'The local Amazon sign-in port is busy. Close the other sign-in window and try again.');
            fail(502, 'AMAZON_CONNECT_FAILED', 'Amazon sign-in could not be started. Disconnect, check the account country, and try again.');
          }
          return json(202, { ok: true, ...amazonStatus() });
        }
        if (url.pathname === '/api/amazon/disconnect') {
          library?.cancel('The Amazon connection changed.');
          if (!await companion.connectionChanged()) fail(409, 'QUIET_CLEANUP_PENDING', 'Echo volume could not be restored safely. Stop Echo playback and restore its volume in Alexa before changing this connection.');
          try { await (amazonConnection.disconnect ? amazonConnection.disconnect() : amazonConnection.bridge.disconnect()); }
          catch { fail(502, 'AMAZON_DISCONNECT_FAILED', 'The Amazon connection could not be closed. Restart Echo Companion and try again.'); }
          return json(200, { ok: true, ...amazonStatus() });
        }
        fail(404, 'NOT_FOUND', 'This action was not found.');
      }
      if (['/api/pair', '/api/revoke', '/api/pair-status'].includes(url.pathname)) {
        if (!isLocal) fail(403, 'LOCAL_APP_REQUIRED', 'Use the pairing controls in the local helper.');
        if (req.method === 'GET' && url.pathname === '/api/pair-status') return json(200, { ok: true, ...pair.status() });
        if (req.method !== 'POST' || !origins.has(req.headers.origin) || req.headers['x-echo-companion'] !== '1') fail(403, 'LOCAL_APP_REQUIRED', 'Use the pairing controls in the local helper.');
        await readBody(req); companion.cancel('Browser extension pairing changed.'); library?.cancel('Browser extension pairing changed.');
        if (url.pathname === '/api/pair') return json(200, { ok: true, token: await pair.create(), ...pair.status(), message: 'Paste this pairing code into the extension. It is shown only now.' });
        if (url.pathname === '/api/revoke') { await pair.revoke(); return json(200, { ok: true, ...pair.status(), message: 'The extension has been disconnected from the helper.' }); }
        fail(404, 'NOT_FOUND', 'This action was not found.');
      }
      if (library && req.method === 'GET' && ['/api/spotify/callback', '/api/youtube/callback'].includes(url.pathname)) {
        await (library.handleCallback || library.handle)(req, res);
        return;
      }
      if (library && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/library/')) {
        if (!isLocal) fail(403, 'LOCAL_APP_REQUIRED', 'Use Echo Library through its local helper.');
        if (req.method === 'POST' && (!origins.has(req.headers.origin) || req.headers['x-echo-app'] !== '1')) fail(403, 'LOCAL_APP_REQUIRED', 'Use the controls in the local music library.');
        if (!libraryRoute(url.pathname + url.search, req.method) || req.url.includes('#')) fail(404, 'LIBRARY_ACTION_UNAVAILABLE', 'This music library action is unavailable.');
        await library.handle(req, res);
        return;
      }
      await pair.authorize(req);
      if (url.pathname.startsWith('/api/library/')) {
        const route = '/api' + url.pathname.slice('/api/library'.length) + url.search;
        if (!library || !libraryRoute(route, req.method) || req.url.includes('#')) fail(404, 'LIBRARY_ACTION_UNAVAILABLE', 'This music library action is unavailable.');
        req.url = route;
        await (library.handleAuthenticated || library.handle)(req, res);
        return;
      }
      if (library) fail(410, 'LIBRARY_UPDATE_REQUIRED', 'Reload Echo Companion and open the music library. Following a music tab has been replaced by browsing and playlist imports.');
      if (req.method === 'GET' && url.pathname === '/api/status') return json(200, { ok: true, ...await companion.readStatus(url.searchParams.get('deviceId') || '') });
      if (req.method === 'GET' && url.pathname === '/api/player') return json(200, { ok: true, ...await companion.readPlayer(url.searchParams.get('deviceId')) });
      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) return json(200, { ok: true, ...companion.jobStatus(url.pathname.slice('/api/jobs/'.length)) });
      if (req.method === 'GET' && url.pathname === '/api/commands') return json(200, { ok: true, ...await companion.readCommands() });
      if (req.method === 'POST' && url.pathname === '/api/command') return json(200, await companion.customCommand(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/api/play') return json(202, companion.play(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/api/control') return json(200, await companion.control(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/api/cancel') {
        const body = await readBody(req);
        if (body.requestId !== undefined && body.requestId !== companion.current?.requestId && body.requestId !== companion.current?.id) return json(200, { ok: true, job: companion.status(), message: 'A newer song request is already active.' });
        return json(200, { ok: true, job: companion.cancel() });
      }
      fail(404, 'NOT_FOUND', 'This page was not found.');
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof CompanionError) return json(error.status, { ok: false, error: error.code, message: error.message });
      return json(500, { ok: false, error: 'LOCAL_ERROR', message: 'The local helper could not complete this request. Try again.' });
    }
  });
  server.requestTimeout = 25_000; server.headersTimeout = 10_000; server.companion = companion; server.pairing = pair;
  server.amazonConnection = amazonConnection; server.library = library;
  let stopPromise = null;
  server.stopResources = () => {
    if (!stopPromise) stopPromise = (async () => { const restored = await companion.stop(); await library?.stop?.(); try { amazonConnection?.stop?.(); } catch {} return restored; })();
    return stopPromise;
  };
  server.on('close', () => { server.stopResources().catch(() => {}); }); return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const { createAmazonConnection } = await import('./alexa-connection.mjs');
  const { createLibrary } = await import('./library/index.mjs');
  const library = createLibrary({ dataDir: path.join(ROOT, '.local'), port: 4320 });
  const amazonConnection = createAmazonConnection({ dataDir: path.join(ROOT, '.local', 'amazon'), proxyPort: 4321, bridgeFactory: () => library.bridge });
  const app = await createApp({ amazonConnection, library });
  app.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'The Echo Companion helper is already running, or port 4320 is busy.' : 'The Echo Companion helper could not start.'); process.exitCode = 1; });
  app.listen(4320, '127.0.0.1', () => {
    console.log('Echo Companion is ready: http://127.0.0.1:4320');
    amazonConnection.restore().catch(() => console.error('Open Echo Companion to connect your Amazon account.'));
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const restored = await app.stopResources();
    if (!restored) console.error('Echo volume could not be restored safely. Stop playback and restore volume in the Alexa app.');
    app.closeAllConnections?.(); app.close(() => process.exit(restored ? 0 : 1));
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
