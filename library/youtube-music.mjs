import { safePlaylistAuthor } from './playlist-links.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.mjs';

const SOURCE = 'youtube-music';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const API = 'https://www.googleapis.com/youtube/v3/';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const text = (value, max = 250) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const nativeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const tokenText = value => typeof value === 'string' && value.length >= 8 && value.length <= 16384 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const unavailable = () => new AppError(502, 'YOUTUBE_UNAVAILABLE', 'YouTube playlists could not be reached. Please try again.');
const authRequired = () => new AppError(401, 'YOUTUBE_AUTH_REQUIRED', 'Connect your Google account again to read your YouTube playlists.');
const changed = () => new AppError(409, 'YOUTUBE_CONNECTION_CHANGED', 'The YouTube connection changed. Please try again.');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const copy = value => structuredClone(value);
function savePrivate(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw new AppError(500, 'YOUTUBE_SAVE_FAILED', 'The YouTube connection could not be saved in this project folder.');
  }
}
function validateConfiguration(value) {
  if (!value || typeof value.clientId !== 'string' || !/^\d{6,30}-[A-Za-z0-9_-]{10,120}\.apps\.googleusercontent\.com$/.test(value.clientId) || typeof value.clientSecret !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(value.clientSecret)) return null;
  return { clientId: value.clientId, clientSecret: value.clientSecret };
}
function safeArtwork(snippet) {
  for (const key of ['high', 'medium', 'default', 'standard', 'maxres']) {
    try {
      const url = new URL(snippet?.thumbnails?.[key]?.url);
      if (url.protocol === 'https:' && !url.username && !url.password && ['ytimg.com', 'ggpht.com', 'googleusercontent.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return url.href;
    } catch { /* Missing or unsafe artwork is optional. */ }
  }
  return null;
}
function scopeMatches(scope, allowMissing = false) {
  if (scope === undefined && allowMissing) return true;
  return typeof scope === 'string' && scope.trim().split(/\s+/u).every(value => value === SCOPE) && scope.trim() === SCOPE;
}
function normalizedTokens(payload, now, previous = null) {
  if (!payload || !tokenText(payload.access_token) || typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in) || payload.expires_in < 1 || payload.expires_in > 86400 || (payload.token_type || '').toLowerCase() !== 'bearer' || !scopeMatches(payload.scope, !!previous)) return null;
  const refreshToken = payload.refresh_token === undefined ? previous?.refreshToken : payload.refresh_token;
  if (refreshToken !== undefined && refreshToken !== null && !tokenText(refreshToken)) return null;
  return { accessToken: payload.access_token, refreshToken: refreshToken || null, expiresAt: now + Math.floor(payload.expires_in * 1000), scope: SCOPE };
}
function stripProvenance(title) {
  // Recording versions such as Live, Remix, Acoustic, Cover and Remastered remain intact.
  return title.replace(/\s*[([]\s*(?:official\s+(?:music\s+video|video|audio|lyric\s+video)|music\s+video|audio|lyrics?|lyric\s+video)\s*[)\]]/giu, ' ').replace(/\s+/gu, ' ').trim();
}
function trackFromItem(row) {
  const snippet = row?.snippet;
  const videoId = row?.contentDetails?.videoId || snippet?.resourceId?.videoId;
  if (row?.kind !== 'youtube#playlistItem' || !nativeId(row.id) || !text(snippet?.title) || !/^[A-Za-z0-9_-]{11}$/.test(videoId || '') || (snippet?.resourceId?.kind && snippet.resourceId.kind !== 'youtube#video') || /^(?:deleted|private|unavailable) video$/iu.test(snippet.title.trim()) || row.status?.privacyStatus === 'private') return null;
  let title = stripProvenance(snippet.title.trim());
  if (!text(title)) return null;
  let artist = '';
  const owner = snippet.videoOwnerChannelTitle;
  if (text(owner) && / - Topic$/u.test(owner.trim())) {
    artist = owner.trim().slice(0, -8).trim();
    if (title.toLocaleLowerCase().startsWith((artist + ' - ').toLocaleLowerCase())) title = title.slice(artist.length + 3).trim();
  } else {
    const pieces = title.split(' - ');
    if (pieces.length === 2 && pieces.every(value => text(value) && value.trim())) [artist, title] = pieces.map(value => value.trim());
  }
  if (!text(title) || (artist && !text(artist))) return null;
  return { id: randomUUID(), title, artist, artwork: safeArtwork(snippet) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, url: `https://www.youtube.com/watch?v=${videoId}`, durationMs: 0, needsReview: !artist };
}

function importPlaylistId(value) {
  const invalid = () => new AppError(400, 'INVALID_YOUTUBE_PLAYLIST_LINK', 'Paste a normal YouTube or YouTube Music playlist link with a PL playlist ID.');
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw invalid();
  let url;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'music.youtube.com'].includes(url.hostname)
    || url.username || url.password || url.port || url.pathname !== '/playlist' || url.searchParams.getAll('list').length !== 1) throw invalid();
  const id = url.searchParams.get('list');
  if (/^RD/iu.test(id || '')) throw new AppError(400, 'YOUTUBE_DYNAMIC_MIX', 'This link opens a generated mix or radio station. Save the songs to a normal YouTube playlist, then import that playlist link.');
  if (!/^PL[A-Za-z0-9_-]{1,126}$/.test(id || '')) throw invalid();
  return id;
}
const incompleteImport = () => new AppError(409, 'YOUTUBE_IMPORT_INCOMPLETE', 'YouTube did not return a complete, consistent playlist. Refresh the playlist and try again; no partial playlist was imported.');
const largeImport = () => new AppError(413, 'YOUTUBE_IMPORT_TOO_LARGE', 'Import a playlist with at most 500 items. No partial playlist was imported.');

export class YouTubeMusicService {
  constructor({ dataDir, port = 4318, fetcher = fetch, clock = Date.now } = {}) {
    if (typeof dataDir !== 'string' || !dataDir || !Number.isInteger(port) || port < 1024 || port > 65534) throw new Error('YouTube project directory and local app port are required');
    this.dataDir = dataDir;
    this.redirectUri = `http://127.0.0.1:${port}/api/youtube/callback`;
    this.fetcher = fetcher;
    this.clock = clock;
    this.configFile = path.join(dataDir, 'youtube-config.json');
    this.tokensFile = path.join(dataDir, 'youtube-tokens.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    const saved = readJson(this.configFile), configuration = validateConfiguration(saved);
    this.configuration = configuration && typeof saved.configurationId === 'string' ? { ...configuration, configurationId: saved.configurationId } : null;
    const tokens = readJson(this.tokensFile);
    this.tokens = this.configuration && tokens?.configurationId === this.configuration.configurationId && tokenText(tokens.accessToken) && (tokens.refreshToken === null || tokenText(tokens.refreshToken)) && Number.isFinite(tokens.expiresAt) && tokens.scope === SCOPE ? { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scope: SCOPE } : null;
    this.generation = 0;
    this.pendingAuthorization = null;
    this.authorizationSequence = 0;
    this.refreshFlight = null;
    this.controllers = new Set();
    this.activeRequests = 0;
    this.calls = [];
    this.playlistEntries = new Map();
    this.nativeToOpaque = new Map();
    this.listCache = null;
    this.listFlight = null;
    this.playlistCache = new Map();
    this.playlistFlights = new Map();
    this.tracks = new Map();
  }
  status() {
    const configured = !!this.configuration;
    const connected = configured && !!this.tokens && (this.tokens.expiresAt > this.clock() || !!this.tokens.refreshToken);
    return { configured, connected, needsSetup: !configured, source: SOURCE, redirectUri: this.redirectUri, message: !configured ? 'Add Google Desktop app credentials, then connect your account to read YouTube / YouTube Music playlists.' : connected ? 'Google connected. Owned YouTube playlists are available; this may not include your complete YouTube Music library.' : 'Google app setup is ready. Connect your Google account to read your playlists.' };
  }
  configure(value) {
    const configuration = validateConfiguration(value);
    if (!configuration) throw new AppError(400, 'INVALID_YOUTUBE_CONFIGURATION', 'Provide the client ID and client secret for a Google Desktop app with YouTube Data API v3 enabled.');
    const next = { ...configuration, configurationId: randomUUID() };
    savePrivate(this.configFile, next);
    this.configuration = next;
    this.disconnect();
    return this.status();
  }
  requireSetup() {
    if (!this.configuration) throw new AppError(503, 'YOUTUBE_SETUP_REQUIRED', 'Add your Google Desktop app credentials before connecting YouTube playlists.');
  }
  requireConnection() {
    this.requireSetup();
    if (!this.status().connected) throw authRequired();
  }
  beginAuthorization() {
    this.requireSetup();
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const expiresAt = this.clock() + 10 * 60_000;
    this.pendingAuthorization = { state, verifier, expiresAt, generation: this.generation, sequence: ++this.authorizationSequence };
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: this.configuration.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: SCOPE, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' }).toString();
    return { authorizationUrl: url.href, expiresAt };
  }
  async completeAuthorization({ state, code, error } = {}) {
    this.requireSetup();
    const pending = this.pendingAuthorization;
    const stateValid = typeof state === 'string' && /^[A-Za-z0-9_-]{43}$/.test(state) && pending && state.length === pending.state.length && timingSafeEqual(Buffer.from(state), Buffer.from(pending.state));
    if (!stateValid || pending.expiresAt <= this.clock() || pending.generation !== this.generation) {
      if (pending && pending.expiresAt <= this.clock()) this.pendingAuthorization = null;
      throw new AppError(400, 'INVALID_YOUTUBE_STATE', 'This Google sign-in request is invalid or expired. Start connecting again.');
    }
    this.pendingAuthorization = null;
    if (error) throw new AppError(400, 'YOUTUBE_AUTH_CANCELLED', 'Google sign-in was cancelled. You can connect again when ready.');
    if (typeof code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(code)) throw new AppError(400, 'INVALID_YOUTUBE_CODE', 'Google did not return a valid sign-in code. Start connecting again.');
    const generation = this.generation;
    const payload = await this.tokenRequest({ client_id: this.configuration.clientId, client_secret: this.configuration.clientSecret, redirect_uri: this.redirectUri, grant_type: 'authorization_code', code, code_verifier: pending.verifier });
    if (generation !== this.generation || pending.sequence !== this.authorizationSequence) throw changed();
    const tokens = normalizedTokens(payload, this.clock());
    if (!tokens) throw new AppError(401, 'YOUTUBE_AUTH_REJECTED', 'Google did not grant the requested read-only YouTube access. Connect again and approve that permission.');
    const verified = await this.apiWithToken('playlists', { part: 'id', mine: 'true', maxResults: '1' }, tokens.accessToken);
    if (!Array.isArray(verified.items)) throw unavailable();
    if (generation !== this.generation || pending.sequence !== this.authorizationSequence) throw changed();
    savePrivate(this.tokensFile, { ...tokens, configurationId: this.configuration.configurationId });
    this.tokens = tokens;
    ++this.generation;
    this.clearCaches();
    return this.status();
  }
  clearCaches() {
    this.playlistEntries.clear(); this.nativeToOpaque.clear(); this.listCache = null; this.listFlight = null;
    this.playlistCache.clear(); this.playlistFlights.clear(); this.tracks.clear();
  }
  disconnect() {
    ++this.generation;
    ++this.authorizationSequence;
    this.pendingAuthorization = null;
    this.tokens = null;
    this.refreshFlight = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.clearCaches();
    try { fs.rmSync(this.tokensFile, { force: true }); } catch { throw new AppError(500, 'YOUTUBE_SAVE_FAILED', 'The saved Google connection could not be removed.'); }
    return this.status();
  }
  async fetchJson(url, options = {}) {
    const generation = this.generation, now = this.clock();
    this.calls = this.calls.filter(at => now - at < 60_000);
    if (this.activeRequests >= 8 || this.calls.length >= 60) throw new AppError(429, 'YOUTUBE_RATE_LIMIT', 'Please wait a minute before requesting more YouTube playlists.');
    this.calls.push(now); ++this.activeRequests;
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 12_000); timer.unref();
    try {
      let response;
      try { response = await this.fetcher(url, { ...options, signal: controller.signal }); } catch { if (generation !== this.generation) throw changed(); throw unavailable(); }
      if (generation !== this.generation) throw changed();
      if (!response || typeof response.ok !== 'boolean') throw unavailable();
      let payload;
      try { payload = await response.json(); } catch { throw unavailable(); }
      if (generation !== this.generation) throw changed();
      return { response, payload };
    } finally { clearTimeout(timer); this.controllers.delete(controller); --this.activeRequests; }
  }
  async tokenRequest(parameters) {
    const { response, payload } = await this.fetchJson(new URL(TOKEN_URL), { method: 'POST', headers: { accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters).toString() });
    if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error) {
      if (response.status === 400 || response.status === 401) throw authRequired();
      throw unavailable();
    }
    return payload;
  }
  async refreshAccessToken() {
    this.requireConnection();
    if (this.refreshFlight) return this.refreshFlight;
    if (!this.tokens.refreshToken) throw authRequired();
    const generation = this.generation, previous = this.tokens;
    const pending = (async () => {
      let payload;
      try { payload = await this.tokenRequest({ client_id: this.configuration.clientId, client_secret: this.configuration.clientSecret, refresh_token: previous.refreshToken, grant_type: 'refresh_token' }); }
      catch (error) { if (generation === this.generation && error instanceof AppError && error.code === 'YOUTUBE_AUTH_REQUIRED') this.disconnect(); throw error; }
      const tokens = normalizedTokens(payload, this.clock(), previous);
      if (!tokens) { if (generation === this.generation) this.disconnect(); throw authRequired(); }
      if (generation !== this.generation) throw changed();
      savePrivate(this.tokensFile, { ...tokens, configurationId: this.configuration.configurationId });
      this.tokens = tokens;
      return tokens.accessToken;
    })();
    this.refreshFlight = pending;
    try { return await pending; } finally { if (this.refreshFlight === pending) this.refreshFlight = null; }
  }
  async accessToken() {
    this.requireConnection();
    return this.tokens.expiresAt > this.clock() + 60_000 ? this.tokens.accessToken : this.refreshAccessToken();
  }
  async apiWithToken(resource, parameters, token) {
    const url = new URL(resource, API); url.search = new URLSearchParams(parameters).toString();
    const { response, payload } = await this.fetchJson(url, { headers: { accept: 'application/json', Authorization: `Bearer ${token}` } });
    if (response.status === 401) throw authRequired();
    if (response.status === 403) {
      const reason = payload?.error?.errors?.[0]?.reason;
      if (['quotaExceeded', 'dailyLimitExceeded'].includes(reason)) throw new AppError(429, 'YOUTUBE_QUOTA_LIMIT', 'The Google app has reached its YouTube daily quota. Please try later.');
      if (['accessNotConfigured', 'serviceDisabled'].includes(reason)) throw new AppError(503, 'YOUTUBE_API_NOT_ENABLED', 'Enable YouTube Data API v3 for the Google app, then connect again.');
      throw new AppError(403, 'YOUTUBE_ACCESS_DENIED', 'YouTube denied access. Check the app’s read-only permission and your account’s YouTube access.');
    }
    if (response.status === 404) throw new AppError(404, 'YOUTUBE_PLAYLIST_UNAVAILABLE', 'This YouTube playlist is no longer available. Refresh your playlists and choose another.');
    if (response.status === 429) throw new AppError(429, 'YOUTUBE_RATE_LIMIT', 'YouTube is receiving too many requests. Please try again later.');
    if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error) throw unavailable();
    return payload;
  }
  async api(resource, parameters) {
    const generation = this.generation;
    const token = await this.accessToken();
    if (generation !== this.generation) throw changed();
    try { return await this.apiWithToken(resource, parameters, token); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'YOUTUBE_AUTH_REQUIRED' || !this.tokens?.refreshToken || generation !== this.generation) throw error;
      const refreshed = await this.refreshAccessToken();
      if (generation !== this.generation) throw changed();
      return this.apiWithToken(resource, parameters, refreshed);
    }
  }
  async importPlaylist(value, _country, { metadataOnly = false } = {}) {
    const playlistId = importPlaylistId(value);
    this.requireConnection();
    const generation = this.generation;
    const guard = () => { if (generation !== this.generation) throw changed(); };
    const metadata = await this.api('playlists', { part: 'snippet,contentDetails', id: playlistId, maxResults: '1' });
    guard();
    if (!Array.isArray(metadata.items)) throw incompleteImport();
    if (!metadata.items.length) throw new AppError(404, 'YOUTUBE_PLAYLIST_UNAVAILABLE', 'This playlist could not be read. Check that the link is accessible to your connected Google account.');
    const selected = metadata.items[0];
    if (metadata.items.length !== 1 || selected?.kind !== 'youtube#playlist' || selected.id !== playlistId || !text(selected.snippet?.title)
      || !Number.isSafeInteger(selected.contentDetails?.itemCount) || selected.contentDetails.itemCount < 0) throw incompleteImport();
    if (metadataOnly) return { name: selected.snippet.title.trim(), ...(safePlaylistAuthor(selected.snippet.channelTitle) ? { author: safePlaylistAuthor(selected.snippet.channelTitle) } : {}), artwork: safeArtwork(selected.snippet), source: SOURCE };
    const total = selected.contentDetails.itemCount;
    if (total > 500) throw largeImport();
    const tracks = [], itemIds = new Set(), pages = new Set();
    let nextPage = null, received = 0, skipped = 0;
    for (let page = 0; page < 10; page++) {
      const payload = await this.api('playlistItems', { part: 'snippet,contentDetails,status', playlistId, maxResults: '50', ...(nextPage ? { pageToken: nextPage } : {}) });
      guard();
      if (!Array.isArray(payload.items) || payload.items.length > 50 || (payload.pageInfo?.totalResults !== undefined
        && (!Number.isSafeInteger(payload.pageInfo.totalResults) || payload.pageInfo.totalResults !== total))) throw incompleteImport();
      for (const row of payload.items) {
        if (row?.kind !== 'youtube#playlistItem' || !nativeId(row.id) || itemIds.has(row.id) || !row.snippet || typeof row.snippet !== 'object'
          || (row.snippet.playlistId !== undefined && row.snippet.playlistId !== playlistId)
          || (row.snippet.position !== undefined && row.snippet.position !== received)) throw incompleteImport();
        itemIds.add(row.id); ++received;
        if (received > 500) throw largeImport();
        if (received > total) throw incompleteImport();
        const track = trackFromItem(row);
        if (track) tracks.push({ ...track, source: SOURCE }); else ++skipped;
      }
      const token = payload.nextPageToken;
      if (token === undefined || token === null || token === '') { nextPage = null; break; }
      if (!payload.items.length || !text(token, 2048) || pages.has(token)) throw incompleteImport();
      pages.add(token); nextPage = token;
      if (page === 9) { if (received >= 500) throw largeImport(); throw incompleteImport(); }
    }
    guard();
    if (nextPage || received !== total) throw incompleteImport();
    const notes = [];
    if (skipped) notes.push(`${skipped} unavailable or unrecognized playlist ${skipped === 1 ? 'item was' : 'items were'} skipped.`);
    const review = tracks.filter(track => track.needsReview).length;
    if (review) notes.push(`${review} ${review === 1 ? 'song needs' : 'songs need'} an artist before saving or playing.`);
    return { name: selected.snippet.title.trim(), ...(safePlaylistAuthor(selected.snippet.channelTitle) ? { author: safePlaylistAuthor(selected.snippet.channelTitle) } : {}), artwork: safeArtwork(selected.snippet), source: SOURCE, tracks, total, skipped, notes };
  }
  async playlists() {
    this.requireConnection();
    if (this.listCache && this.listCache.expires > this.clock()) return copy(this.listCache.result);
    if (this.listFlight) return copy(await this.listFlight);
    const pending = this.loadPlaylists(); this.listFlight = pending;
    try { return copy(await pending); } finally { if (this.listFlight === pending) this.listFlight = null; }
  }
  async loadPlaylists() {
    const generation = this.generation;
    const playlists = [], seen = new Set(), pages = new Set();
    let nextPage = null, truncated = false;
    for (let page = 0; page < 4; page++) {
      const payload = await this.api('playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...(nextPage ? { pageToken: nextPage } : {}) });
      if (generation !== this.generation) throw changed();
      if (!Array.isArray(payload.items)) throw unavailable();
      for (const row of payload.items.slice(0, 50)) {
        if (row?.kind !== 'youtube#playlist' || !nativeId(row.id) || seen.has(row.id) || !text(row.snippet?.title)) continue;
        seen.add(row.id);
        const id = this.nativeToOpaque.get(row.id) || randomUUID(); this.nativeToOpaque.set(row.id, id);
        const entry = { id, title: row.snippet.title.trim(), ...(safePlaylistAuthor(row.snippet.channelTitle) ? { author: safePlaylistAuthor(row.snippet.channelTitle) } : {}), artwork: safeArtwork(row.snippet), itemCount: Number.isSafeInteger(row.contentDetails?.itemCount) && row.contentDetails.itemCount >= 0 ? row.contentDetails.itemCount : 0, source: SOURCE, url: `https://www.youtube.com/playlist?list=${encodeURIComponent(row.id)}` };
        playlists.push(entry);
        this.playlistEntries.set(id, { entry, nativeId: row.id, expires: this.clock() + 30 * 60_000 });
      }
      nextPage = payload.nextPageToken;
      if (!nextPage) break;
      if (!text(nextPage, 2048) || pages.has(nextPage)) { truncated = true; break; }
      pages.add(nextPage);
      if (page === 3) truncated = true;
    }
    for (const [id, entry] of this.playlistEntries) if (entry.expires <= this.clock()) this.playlistEntries.delete(id);
    while (this.playlistEntries.size > 200) this.playlistEntries.delete(this.playlistEntries.keys().next().value);
    while (this.nativeToOpaque.size > 200) this.nativeToOpaque.delete(this.nativeToOpaque.keys().next().value);
    const result = { playlists, truncated };
    this.listCache = { result, expires: this.clock() + 2 * 60_000 };
    return result;
  }
  async playlist(id) {
    this.requireConnection();
    const selected = typeof id === 'string' && this.playlistEntries.get(id);
    if (!selected || selected.expires <= this.clock()) throw new AppError(400, 'YOUTUBE_PLAYLIST_EXPIRED', 'Refresh your YouTube playlists, then choose one from the list.');
    const cached = this.playlistCache.get(id);
    if (cached && cached.expires > this.clock()) return copy(cached.result);
    if (this.playlistFlights.has(id)) return copy(await this.playlistFlights.get(id));
    if (this.playlistFlights.size >= 4) throw new AppError(429, 'YOUTUBE_RATE_LIMIT', 'Please wait for your current playlists to finish loading.');
    const pending = this.loadPlaylist(id, selected); this.playlistFlights.set(id, pending);
    try { return copy(await pending); } finally { if (this.playlistFlights.get(id) === pending) this.playlistFlights.delete(id); }
  }
  async loadPlaylist(id, selected) {
    const generation = this.generation;
    const tracks = [], seenItems = new Set(), pages = new Set();
    let nextPage = null, truncated = false;
    for (let page = 0; page < 10; page++) {
      const payload = await this.api('playlistItems', { part: 'snippet,contentDetails,status', playlistId: selected.nativeId, maxResults: '50', ...(nextPage ? { pageToken: nextPage } : {}) });
      if (generation !== this.generation) throw changed();
      if (!Array.isArray(payload.items)) throw unavailable();
      for (const row of payload.items.slice(0, 50)) {
        if (seenItems.has(row?.id)) continue;
        const track = trackFromItem(row);
        if (!track) continue;
        seenItems.add(row.id); tracks.push(track);
        this.tracks.set(track.id, { track, expires: this.clock() + 30 * 60_000 });
      }
      nextPage = payload.nextPageToken;
      if (!nextPage) break;
      if (!text(nextPage, 2048) || pages.has(nextPage)) { truncated = true; break; }
      pages.add(nextPage);
      if (page === 9) truncated = true;
    }
    const result = { id, title: selected.entry.title, artwork: selected.entry.artwork, url: selected.entry.url, source: SOURCE, tracks, truncated };
    this.playlistCache.set(id, { result, expires: this.clock() + 2 * 60_000 });
    while (this.playlistCache.size > 10) this.playlistCache.delete(this.playlistCache.keys().next().value);
    for (const [trackId, entry] of this.tracks) if (entry.expires <= this.clock()) this.tracks.delete(trackId);
    while (this.tracks.size > 5000) this.tracks.delete(this.tracks.keys().next().value);
    return result;
  }
  getTrack(id) {
    const entry = typeof id === 'string' && this.tracks.get(id);
    if (!entry || entry.expires <= this.clock()) throw new AppError(400, 'YOUTUBE_TRACK_EXPIRED', 'Load the YouTube playlist again before choosing this song.');
    return { ...entry.track };
  }
}
