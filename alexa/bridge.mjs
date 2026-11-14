import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import AlexaRemote from 'alexa-remote2';
import { AppError, buildMusicCommand } from './catalog.mjs';
import { fallbackMusicProviders, parseMusicProviders, resolveMusicProvider } from './music-providers.mjs';
import { CommandJournal, normalizeCustomCommand } from './command-journal.mjs';
import { findAlexaResponse } from './alexa-responses.mjs';

export const REGIONS = Object.freeze({
  IN: { amazonPage: 'amazon.in', locale: 'en-IN', country: 'IN' },
  US: { amazonPage: 'amazon.com', locale: 'en-US', country: 'US' },
  UK: { amazonPage: 'amazon.co.uk', locale: 'en-GB', country: 'GB' },
  DE: { amazonPage: 'amazon.de', locale: 'de-DE', country: 'DE' },
  CA: { amazonPage: 'amazon.ca', locale: 'en-CA', country: 'CA' },
  AU: { amazonPage: 'amazon.com.au', locale: 'en-AU', country: 'AU' },
  JP: { amazonPage: 'amazon.co.jp', locale: 'ja-JP', country: 'JP' },
});
const LOCALES = new Set(['en-IN', 'en-US', 'en-GB', 'en-CA', 'en-AU', 'de-DE', 'ja-JP', 'hi-IN', 'fr-CA']);
const appError = message => new AppError(502, 'ALEXA_UNAVAILABLE', message);
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writePrivate(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}
const stopRemote = remote => {
  if (!remote) return;
  try { remote.stop(); } catch {}
  try { remote.stopProxyServer(); } catch {}
};
function availablePort(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new AppError(409, 'LOGIN_PORT_BUSY', 'The local sign-in port is busy. Close the other Alexa connection and try again.')));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
export function normalizePlayer(payload, deviceId) {
  const info = payload?.playerInfo;
  if (!info || typeof info !== 'object') return { state: 'UNKNOWN', title: '', artist: '', deviceId };
  const text = info.infoText || {};
  const state = ['PLAYING', 'PAUSED', 'STOPPED', 'IDLE'].includes(info.state) ? (info.state === 'IDLE' ? 'STOPPED' : info.state) : 'UNKNOWN';
  const str = value => typeof value === 'string' ? value.slice(0, 500) : '';
  let artwork = str(info.mainArt?.url);
  if (!artwork.startsWith('https://')) artwork = '';
  const player = { state, title: str(text.title), artist: str(text.subText1), album: str(text.subText2), artwork, deviceId };
  const reportedProvider = info.provider?.providerName;
  if (typeof reportedProvider === 'string' && reportedProvider.trim() && reportedProvider.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(reportedProvider)) player.providerName = reportedProvider.trim();
  if (typeof info.mediaId === 'string' && info.mediaId.length > 0 && info.mediaId.length <= 2048) player.mediaId = info.mediaId;
  const length = info.progress?.mediaLength;
  // Alexa devices report seconds; some upstream responses use milliseconds.
  if (typeof length === 'number' && Number.isFinite(length) && length > 0) {
    const scale = length < 10000 ? 1000 : 1;
    player.durationMs = Math.round(length * scale);
    const progress = info.progress?.mediaProgress;
    if (typeof progress === 'number' && Number.isFinite(progress) && progress >= 0) player.positionMs = Math.round(progress * scale);
  }
  player.volume = normalizeVolume(payload);
  return player;
}

export function normalizeVolume(payload) {
  const volume = payload?.playerInfo?.volume?.volume;
  return typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 && volume <= 100 ? Math.round(volume) : null;
}

export class AlexaBridge {
  constructor({ dataDir, proxyPort = 4321, createRemote = () => new AlexaRemote(), portCheck = availablePort, journal = new CommandJournal(), responseDelays = [3000, 8000, 15000] } = {}) {
    this.dataDir = dataDir;
    this.journal = journal;
    this.responseDelays = responseDelays;
    this.responseJobs = new Map();
    this.historyFlight = null;
    this.latestCommands = new Map();
    this.proxyPort = proxyPort;
    this.createRemote = createRemote;
    this.portCheck = portCheck;
    this.remote = null;
    this.generation = 0;
    this.devices = [];
    this.lastPlayer = null;
    this.playerCache = new Map();
    this.playerFlights = new Map();
    this.volumeRevisions = new Map();
    this.positionRevisions = new Map();
    this.providerCache = null;
    this.providerFlight = null;
    this.playerReadSequence = 0;
    this.playerAppliedSequence = 0;
    this.busy = false;
    this.lastCommandAt = 0;
    this.timer = null;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    const savedSettings = readJson(path.join(dataDir, 'settings.json'));
    const region = REGIONS[savedSettings?.region] ? savedSettings.region : 'IN';
    this.settings = { region, country: REGIONS[region].country, locale: LOCALES.has(savedSettings?.locale) ? savedSettings.locale : REGIONS[region].locale };
    this.connection = { state: 'disconnected', message: 'Connect your Amazon account to find your Echo.' };
  }
  status() { return { connection: { ...this.connection }, settings: { ...this.settings }, devices: [...this.devices], player: this.lastPlayer }; }
  async restore() {
    if (readJson(path.join(this.dataDir, 'session.json'))?.data) await this.connect(this.settings);
  }
  async connect({ region = this.settings.region, locale } = {}) {
    if (!REGIONS[region]) throw new AppError(400, 'INVALID_REGION', 'Choose your Amazon account’s country.');
    locale = locale || REGIONS[region].locale;
    if (!LOCALES.has(locale)) throw new AppError(400, 'INVALID_LOCALE', 'Choose one of the supported Echo languages.');
    if (['connecting', 'awaiting_login'].includes(this.connection.state)) throw new AppError(409, 'CONNECTION_BUSY', 'A connection is already in progress. Complete sign-in or disconnect first.');
    const generation = ++this.generation;
    this.stopResponseCapture();
    this.latestCommands.clear();
    this.providerCache = null;
    this.providerFlight = null;
    stopRemote(this.remote);
    this.remote = null;
    this.devices = [];
    this.lastPlayer = null;
    this.playerCache.clear();
    this.playerFlights.clear();
    this.volumeRevisions.clear();
    this.positionRevisions.clear();
    this.connection = { state: 'connecting', message: 'Preparing your local Amazon connection…' };
    try { await this.portCheck(this.proxyPort); } catch (err) { if (generation === this.generation) this.connection = { state: 'error', message: err.message }; throw err; }
    if (generation !== this.generation) return this.status();
    this.settings = { region, locale, country: REGIONS[region].country };
    writePrivate(path.join(this.dataDir, 'settings.json'), this.settings);
    const saved = readJson(path.join(this.dataDir, 'session.json'));
    const remote = this.createRemote();
    this.remote = remote;
    const current = () => generation === this.generation && remote === this.remote;
    remote.on('error', () => { /* Upstream errors can contain credentials; never log them. */ });
    remote.on('cookie', () => {
      if (!current() || !remote.cookieData?.localCookie) return;
      try { writePrivate(path.join(this.dataDir, 'session.json'), { region, data: remote.cookieData }); }
      catch { this.connection = { state: 'error', message: 'The local session could not be saved. Check the project folder permissions.' }; }
    });
    const options = {
      amazonPage: REGIONS[region].amazonPage,
      acceptLanguage: locale,
      amazonPageProxyLanguage: locale.replace('-', '_'),
      proxyOnly: true,
      setupProxy: true,
      proxyOwnIp: '127.0.0.1',
      proxyListenBind: '127.0.0.1',
      proxyPort: this.proxyPort,
      proxyLogLevel: 'silent',
      usePushConnection: false,
      useWsMqtt: false,
      bluetooth: false,
      cookieRefreshInterval: 4 * 24 * 60 * 60 * 1000,
      formerDataStorePath: path.join(this.dataDir, 'registration.json'),
      ...(saved?.region === region && saved.data ? { cookie: saved.data } : {}),
      // Do not supply a logger: upstream debug output includes cookies and tokens.
    };
    const timeout = setTimeout(() => {
      if (!current()) return;
      this.connection = { state: 'error', message: 'Sign-in timed out. Disconnect, then connect again to retry.' };
      ++this.generation;
      stopRemote(remote);
      this.remote = null;
      this.devices = [];
    }, 10 * 60_000);
    timeout.unref();
    clearTimeout(this.timer);
    this.timer = timeout;
    try {
      remote.init(options, err => {
        if (!current()) return;
        if (err) {
          const message = typeof err === 'string' ? err : String(err?.message || '');
          if (message.startsWith(`Please open http://127.0.0.1:${this.proxyPort}/`)) {
            this.connection = { state: 'awaiting_login', message: 'Open Amazon sign-in below, then return here. Complete any Amazon verification prompts there.', loginUrl: `http://127.0.0.1:${this.proxyPort}/` };
          } else {
            clearTimeout(this.timer);
            this.connection = { state: 'error', message: 'Amazon could not be connected. Check your account country, disconnect, and try signing in again.' };
            ++this.generation;
            stopRemote(remote);
            this.remote = null;
            this.devices = [];
          }
          return;
        }
        clearTimeout(this.timer);
        this.devices = Object.values(remote.serialNumbers || {})
          .filter(device => device.deviceFamily === 'ECHO' && device.serialNumber && device.hasMusicPlayer !== false)
          .map(device => ({ id: device.serialNumber, name: device.accountName || 'Echo', online: device.online !== false }));
        this.connection = { state: 'connected', message: this.devices.length ? 'Amazon connected. Choose your Echo to play music.' : 'Amazon connected, but no Echo was found. Check that it is registered to this account.' };
      });
    } catch {
      clearTimeout(this.timer);
      this.connection = { state: 'error', message: 'The Amazon connection could not be started. Disconnect and try again.' };
      ++this.generation;
      stopRemote(remote);
      this.remote = null;
    }
    return this.status();
  }
  requireDevice(deviceId) {
    if (this.connection.state !== 'connected' || !this.remote) throw new AppError(409, 'NOT_CONNECTED', 'Connect your Amazon account first.');
    const device = this.devices.find(item => item.id === deviceId);
    if (!device || !this.remote.find(deviceId)) throw new AppError(400, 'INVALID_DEVICE', 'Choose an Echo from your connected account.');
    if (!device.online) throw new AppError(409, 'DEVICE_OFFLINE', 'That Echo is offline. Reconnect it to Wi-Fi and connect again here.');
    return device;
  }
  call(method, args, message, { timeoutMs = 15_000 } = {}) {
    const remote = this.remote;
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (generation !== this.generation || remote !== this.remote) return reject(new AppError(409, 'CONNECTION_CHANGED', 'The Echo connection changed. Please try again.'));
        const rejected = value && typeof value === 'object' && (value.__type || value.error || value.errorMessage || (Array.isArray(value.errors) ? value.errors.length > 0 : value.errors) || value.success === false || Number(value.statusCode) >= 400);
        if (err || rejected) return reject(appError(message));
        resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('timeout')), Math.max(1, Math.min(timeoutMs, 15_000)));
      timer.unref();
      try { remote[method](...args, finish); } catch { finish(new Error('failed')); }
    });
  }
  commands() { return { commands: this.journal.list(), retention: 'session' }; }
  async sendTextCommand(text, deviceId, { kind = 'custom' } = {}) {
    text = normalizeCustomCommand(text);
    const device = this.requireDevice(deviceId);
    return this.runCommand(async () => {
      const node = this.remote.createSequenceNode('textCommand', text, deviceId);
      node.operationPayload.locale = this.settings.locale;
      const wireText = normalizeCustomCommand(node.operationPayload.text);
      const entry = this.journal.begin({ text: wireText, kind, deviceId, deviceName: device.name });
      const sequence = { '@type': 'com.amazon.alexa.behaviors.model.Sequence', startNode: node };
      try {
        await this.call('sendSequenceCommand', [deviceId, sequence], 'Alexa did not confirm this command. Try again.');
        this.journal.sent(entry.id, 'Alexa accepted the request.');
        this.latestCommands.set(deviceId, { id: entry.id, at: Date.now(), kind });
        this.playerCache.delete(deviceId);
        this.captureResponse(entry, Math.max(entry.createdAt, Date.now()));
        return { status: 'sent', commandId: entry.id, message: `Request sent to ${device.name}.` };
      } catch (error) { this.journal.failed(entry.id, 'Alexa did not confirm the request.'); throw error; }
    });
  }
  async play(track, deviceId, providerId = 'alexa-default') {
    const provider = resolveMusicProvider(providerId);
    const result = await this.sendTextCommand(buildMusicCommand(track, provider.id), deviceId, { kind: 'music' });
    return { ...result, message: `${result.message} ${provider.id === 'alexa-default' ? 'Alexa will choose the music service.' : `Requested on ${provider.name}.`}` };
  }
  async playPlaylist(playlist, deviceId) {
    if (!['apple-music', 'spotify'].includes(playlist?.source)) throw new AppError(400, 'INVALID_PLAYLIST_SOURCE', 'Choose an Apple Music or Spotify playlist.');
    const provider = resolveMusicProvider(playlist.source);
    const title = normalizeCustomCommand(playlist.title);
    if (title.length > 250) throw new AppError(400, 'INVALID_PLAYLIST', 'This playlist name is too long to request.');
    return this.sendTextCommand(`play my playlist ${title} on ${provider.commandName}`, deviceId, { kind: 'music' });
  }
  async control(deviceId, action) {
    const device = this.requireDevice(deviceId);
    if (!['pause', 'resume', 'next', 'previous'].includes(action)) throw new AppError(400, 'INVALID_ACTION', 'Choose a supported playback control.');
    return this.runCommand(async () => {
      const labels = { pause: 'Pause playback', resume: 'Resume playback', next: 'Next song', previous: 'Previous song' };
      const entry = this.journal.begin({ text: labels[action], kind: 'control', deviceId, deviceName: device.name });
      try {
        await this.call('sendCommand', [deviceId, action === 'resume' ? 'play' : action, undefined], 'Alexa did not accept this control. Try again.');
        this.journal.sent(entry.id, 'Alexa accepted the playback control.');
        this.journal.response(entry.id, null, { status: 'unavailable' });
        this.latestCommands.set(deviceId, { id: entry.id, at: Date.now(), kind: 'control' });
        this.playerCache.delete(deviceId);
        return { status: 'sent', commandId: entry.id, message: `Request sent to ${device.name}.` };
      } catch (error) { this.journal.failed(entry.id, 'Alexa did not confirm the playback control.'); throw error; }
    });
  }
  async setVolume(deviceId, volume) {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new AppError(400, 'INVALID_VOLUME', 'Choose a volume between 0 and 100%.');
    const device = this.requireDevice(deviceId);
    return this.runCommand(async () => {
      const invalidate = () => {
        this.volumeRevisions.set(deviceId, (this.volumeRevisions.get(deviceId) || 0) + 1);
        this.playerCache.delete(deviceId);
        this.playerFlights.delete(deviceId);
      };
      const entry = this.journal.begin({ text: `Set volume to ${volume}%`, kind: 'control', deviceId, deviceName: device.name });
      invalidate();
      try {
        await this.call('sendCommand', [deviceId, 'volume', volume], 'Alexa did not accept the volume change. Try again.');
        this.journal.sent(entry.id, 'Alexa accepted the volume change.');
        this.journal.response(entry.id, null, { status: 'unavailable' });
        // Volume does not replace the song request being verified or its observations.
        return { status: 'sent', volume, commandId: entry.id, message: `Volume request sent to ${device.name}.` };
      } catch (error) {
        this.journal.failed(entry.id, 'Alexa did not confirm the volume change.');
        throw error;
      } finally { invalidate(); }
    });
  }
  async seek(deviceId, positionMs, expectedTrack = null) {
    if (!Number.isInteger(positionMs) || positionMs < 0 || positionMs > 24 * 60 * 60_000) throw new AppError(400, 'INVALID_POSITION', 'Choose a song position between zero and the end of the current song.');
    const device = this.requireDevice(deviceId);
    if (expectedTrack !== null && (!expectedTrack || typeof expectedTrack !== 'object' || !['title', 'artist'].every(key => typeof expectedTrack[key] === 'string' && expectedTrack[key].trim() && expectedTrack[key].length <= 500 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(expectedTrack[key])))) throw new AppError(400, 'INVALID_TRACK', 'Refresh the Echo song before seeking.');
    return this.runCommand(async () => {
      const { player } = await this.freshPlayer(deviceId, { timeoutMs: 4000 });
      if (!['PLAYING', 'PAUSED'].includes(player.state) || !player.title || !player.artist || !Number.isFinite(player.durationMs) || !Number.isFinite(player.positionMs)) throw new AppError(409, 'SEEK_UNAVAILABLE', 'Your Echo is not reporting a song position and duration. Try again while a song is playing.');
      const key = text => text.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
      if (expectedTrack && (key(expectedTrack.title) !== key(player.title) || key(expectedTrack.artist) !== key(player.artist))) throw new AppError(409, 'SONG_CHANGED', 'The Echo song changed. Refresh its position before seeking.');
      if (positionMs >= player.durationMs) throw new AppError(400, 'INVALID_POSITION', 'Choose a position before the end of the current song.');
      const targetPositionMs = Math.min(Math.round(positionMs / 1000) * 1000, Math.max(0, player.durationMs - 1000));
      const deltaSeconds = Math.round((targetPositionMs - player.positionMs) / 1000), referenceAt = Date.now();
      const snapshot = { title: player.title, artist: player.artist, state: player.state, providerName: player.providerName || '', durationMs: player.durationMs };
      if (!deltaSeconds) return { status: 'unchanged', requested: false, confirmed: false, targetPositionMs, referenceAt, track: snapshot, message: 'Your Echo is already near that position. Checking its reported position…' };
      // The installed remote API has no absolute-seek command. Use a fixed,
      // bounded spoken adjustment, then let the companion verify the position.
      const text = deltaSeconds > 0 ? `fast forward ${deltaSeconds} seconds` : `rewind ${-deltaSeconds} seconds`;
      const entry = this.journal.begin({ text, kind: 'control', deviceId, deviceName: device.name });
      const invalidate = () => { this.positionRevisions.set(deviceId, (this.positionRevisions.get(deviceId) || 0) + 1); this.playerCache.delete(deviceId); this.playerFlights.delete(deviceId); };
      invalidate();
      try {
        const node = this.remote.createSequenceNode('textCommand', text, deviceId); node.operationPayload.locale = this.settings.locale;
        const sequence = { '@type': 'com.amazon.alexa.behaviors.model.Sequence', startNode: node };
        await this.call('sendSequenceCommand', [deviceId, sequence], 'Alexa did not confirm the position request. Try again.');
        this.journal.sent(entry.id, 'Alexa accepted the position request.'); this.journal.response(entry.id, null, { status: 'unavailable' });
        return { status: 'sent', requested: true, confirmed: false, targetPositionMs, referenceAt, track: snapshot, commandId: entry.id, message: 'Seek requested. The new position has not been confirmed yet.' };
      } catch (error) { this.journal.failed(entry.id, 'Alexa did not confirm the position request.'); throw error; }
      finally { invalidate(); }
    });
  }
  stopResponseCapture() {
    for (const job of this.responseJobs.values()) {
      for (const timer of job.timers) clearTimeout(timer);
      this.journal.response(job.entry.id, null, { status: 'unavailable' });
    }
    this.responseJobs.clear();
    this.historyFlight = null;
  }
  captureResponse(entry, completedAt) {
    if (!this.responseDelays.length) { this.journal.response(entry.id, null, { status: 'unavailable' }); return; }
    const generation = this.generation;
    const job = { entry, completedAt, generation, timers: [] };
    this.responseJobs.set(entry.id, job);
    for (let index = 0; index < this.responseDelays.length; index++) {
      const timer = setTimeout(() => this.checkResponse(job, index === this.responseDelays.length - 1).catch(() => {}), this.responseDelays[index]);
      timer.unref?.(); job.timers.push(timer);
    }
  }
  async checkResponse(job, final) {
    if (this.generation !== job.generation || this.responseJobs.get(job.entry.id) !== job) return;
    let records = null;
    if (!this.historyFlight) {
      const startTime = Math.max(0, Math.min(...[...this.responseJobs.values()].map(item => item.entry.createdAt)) - 2000);
      const request = this.call('getCustomerHistoryRecords', [{ startTime, endTime: Date.now() + 1000, filter: false, forceRequest: true, recordType: 'VOICE_HISTORY' }], 'Alexa response history is unavailable.').catch(() => null);
      this.historyFlight = request;
      request.finally(() => { if (this.historyFlight === request) this.historyFlight = null; });
    }
    records = await this.historyFlight;
    if (this.generation !== job.generation || this.responseJobs.get(job.entry.id) !== job) return;
    let result = findAlexaResponse(records, { text: job.entry.text, deviceId: job.entry.deviceId, sentAt: job.entry.createdAt, completedAt: job.completedAt });
    if (result.status === 'available') {
      // Closely repeated identical commands have no causal history ID; never guess which one was answered.
      const key = text => text.normalize('NFKC').replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').toLowerCase().replace(/^alexa(?:\s*[,!:]\s*|\s+)/u, '').replace(/[.!?]+$/u, '').replace(/\s+/gu, ' ').trim();
      if (this.journal.list().some(entry => entry.id !== job.entry.id && entry.kind !== 'control' && entry.deviceId === job.entry.deviceId && Math.abs(entry.createdAt - job.entry.createdAt) <= 32000 && key(entry.text) === key(job.entry.text))) result = { status: 'ambiguous', response: null };
    }
    if (result.status === 'available' || result.status === 'ambiguous' || final) {
      const fullText = typeof result.response === 'string' ? result.response.replace(/\s+/gu, ' ').trim() : null;
      const text = fullText && fullText.length > 500 ? fullText.slice(0, 499) + '…' : fullText;
      this.journal.response(job.entry.id, text, { status: result.status });
      for (const timer of job.timers) clearTimeout(timer);
      this.responseJobs.delete(job.entry.id);
    }
  }
  async runCommand(fn) {
    if (this.busy || Date.now() - this.lastCommandAt < 1200) throw new AppError(429, 'COMMAND_BUSY', 'Please wait a moment before sending another request.');
    this.busy = true;
    this.lastCommandAt = Date.now();
    try { return await fn(); } finally { this.busy = false; }
  }
  async player(deviceId, { fresh = false, timeoutMs = 15_000 } = {}) {
    this.requireDevice(deviceId);
    const revision = this.volumeRevisions.get(deviceId) || 0;
    const cached = this.playerCache.get(deviceId);
    const usableCache = !fresh && cached && Date.now() - cached.at < 3500 && cached.volumeRevision === revision && cached.positionRevision === (this.positionRevisions.get(deviceId) || 0);
    if (usableCache && cached.volume !== null) return { player: cached.player, volume: cached.volume };
    if (!fresh && this.playerFlights.has(deviceId)) return this.playerFlights.get(deviceId);
    const request = (async () => {
      const result = usableCache ? { player: cached.player, volume: cached.volume } : await this.freshPlayer(deviceId, { timeoutMs });
      if (revision !== (this.volumeRevisions.get(deviceId) || 0)) return { ...result, volume: null };
      if (result.volume !== null) return result;
      // An idle Echo may omit the player volume. Read its speaker setting instead.
      let payload;
      try { payload = await this.call('getAllDeviceVolumes', [], 'Echo volume is temporarily unavailable.', { timeoutMs }); }
      catch (error) { if (error.code === 'CONNECTION_CHANGED') throw error; return result; }
      if (revision !== (this.volumeRevisions.get(deviceId) || 0)) return { ...result, volume: null };
      const rows = Array.isArray(payload?.volumes) ? payload.volumes.filter(item => item?.dsn === deviceId) : [];
      const volume = rows.length === 1 ? normalizeVolume({ playerInfo: { volume: { volume: rows[0].speakerVolume } } }) : null;
      const saved = this.playerCache.get(deviceId);
      if (saved?.player === result.player && saved.volumeRevision === revision) saved.volume = volume;
      return { ...result, volume };
    })();
    this.playerFlights.set(deviceId, request);
    try { return await request; } finally { if (this.playerFlights.get(deviceId) === request) this.playerFlights.delete(deviceId); }
  }
  async musicProviders() {
    const fallback = () => fallbackMusicProviders(this.settings.country);
    if (this.connection.state !== 'connected' || !this.remote) return fallback();
    if (this.providerCache && Date.now() < this.providerCache.expiresAt) return this.providerCache.value;
    if (this.providerFlight) return this.providerFlight;
    const generation = this.generation;
    const request = (async () => {
      let value;
      try { value = parseMusicProviders(await this.call('getMusicProviders', [], 'Music services could not be read.'), this.settings.country); }
      catch { value = fallback(); }
      if (generation !== this.generation) return fallback();
      this.providerCache = { value, expiresAt: Date.now() + (value.discovery === 'ready' ? 300000 : 15000) };
      return value;
    })();
    this.providerFlight = request;
    try { return await request; } finally { if (this.providerFlight === request) this.providerFlight = null; }
  }
  async freshPlayer(deviceId, { timeoutMs = 15_000 } = {}) {
    this.requireDevice(deviceId);
    const sequence = ++this.playerReadSequence;
    const volumeRevision = this.volumeRevisions.get(deviceId) || 0;
    const positionRevision = this.positionRevisions.get(deviceId) || 0;
    const observedCommand = this.latestCommands.get(deviceId);
    const payload = await this.call('getPlayerInfo', [deviceId], 'Now playing is temporarily unavailable.', { timeoutMs });
    const player = normalizePlayer(payload, deviceId);
    const volume = volumeRevision === (this.volumeRevisions.get(deviceId) || 0) ? normalizeVolume(payload) : null;
    player.volume = volume;
    if (positionRevision !== (this.positionRevisions.get(deviceId) || 0)) delete player.positionMs;
    if (observedCommand && this.latestCommands.get(deviceId) === observedCommand && Date.now() - observedCommand.at < 30000 && observedCommand.kind !== 'custom') this.journal.observe(observedCommand.id, player);
    if (sequence > this.playerAppliedSequence) {
      this.playerAppliedSequence = sequence;
      this.playerCache.set(deviceId, { player, volume, volumeRevision, positionRevision, at: Date.now() });
      this.lastPlayer = player;
    }
    return { player, volume };
  }
  disconnect({ forget = true } = {}) {
    ++this.generation;
    this.stopResponseCapture();
    this.latestCommands.clear();
    this.providerCache = null;
    this.providerFlight = null;
    clearTimeout(this.timer);
    stopRemote(this.remote);
    this.remote = null;
    this.devices = [];
    this.lastPlayer = null;
    this.playerCache.clear();
    this.playerFlights.clear();
    this.volumeRevisions.clear();
    this.positionRevisions.clear();
    this.connection = { state: 'disconnected', message: 'Connect your Amazon account to find your Echo.' };
    if (forget) for (const file of ['session.json', 'session.json.tmp', 'registration.json']) fs.rmSync(path.join(this.dataDir, file), { force: true });
    return this.status();
  }
}
