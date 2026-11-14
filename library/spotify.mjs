import { releaseYearMetadata } from './track-release.mjs';
import { safePlaylistAuthor } from './playlist-links.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.mjs';
import { COUNTRIES } from './catalog.mjs';

const SOURCE = 'spotify';
const text = (value, max = 250) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
const tokenText = value => typeof value === 'string' && value.length >= 8 && value.length <= 16384 && !/[\s\p{Cc}]/u.test(value);
const spotifyId = value => typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
const clientId = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const countryCode = value => typeof value === 'string' && /^[A-Z]{2}$/.test(value);
const readJson = file => { try { if (fs.statSync(file).size > 65536) return null; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const changed = () => new AppError(409, 'SPOTIFY_CONNECTION_CHANGED', 'Your Spotify connection changed. Please try again.');
const unavailable = () => new AppError(502, 'SPOTIFY_UNAVAILABLE', 'Spotify could not be reached or returned an unexpected response. Please try again.');
const setupRequired = () => new AppError(503, 'SPOTIFY_SETUP_REQUIRED', 'Add the Spotify app Client ID before connecting your account.');
const signInRequired = () => new AppError(401, 'SPOTIFY_SIGNIN_REQUIRED', 'Connect your Spotify account before browsing its catalogue.');
function privateWrite(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw new AppError(500, 'SPOTIFY_SAVE_FAILED', 'The Spotify connection could not be saved in this project folder.');
  }
}
function profileIdentity(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const accountId = text(profile.account_id, 250) ? profile.account_id : text(profile.id, 250) ? profile.id : null;
  if (!accountId && !text(profile.display_name)) return null;
  return { accountId, country: countryCode(profile.country) ? profile.country : null };
}
function safeImage(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['scdn.co', 'spotifycdn.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : null; } catch { return null; }
}
function normalizeTrack(row, country, id = randomUUID()) {
  if (!row || row.type !== 'track' || !spotifyId(row.id) || !text(row.name) || row.is_local === true || row.is_playable === false || row.restrictions != null || row.album?.restrictions != null) return null;
  if (Array.isArray(row.available_markets) && !row.available_markets.includes(country)) return null;
  if (row.uri !== undefined && row.uri !== `spotify:track:${row.id}`) return null;
  let url;
  try {
    url = new URL(row.external_urls?.spotify);
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.username || url.password || url.port || url.pathname !== `/track/${row.id}`) return null;
  } catch { return null; }
  const requestArtists = Array.isArray(row.artists) ? [...new Set(row.artists.slice(0, 30).filter(artist => artist?.type === 'artist' && spotifyId(artist.id) && text(artist.name)).map(artist => artist.name.replace(/\s+/gu, ' ').trim()))] : [];
  if (!requestArtists.length || !text(requestArtists.join(', '))) return null;
  const images = Array.isArray(row.album?.images) ? row.album.images.slice(0, 10) : [];
  const artwork = images.map(image => safeImage(image?.url)).find(Boolean) || null;
  return { track: Object.freeze({ id, title: row.name.trim(), artist: requestArtists.join(', '), album: text(row.album?.name) ? row.album.name.trim() : '', ...releaseYearMetadata(row.album?.release_date), artwork, url: url.href, durationMs: typeof row.duration_ms === 'number' && Number.isFinite(row.duration_ms) && row.duration_ms >= 0 ? row.duration_ms : 0, explicit: row.explicit === true }), sourceId: row.id, requestArtists: Object.freeze(requestArtists), playable: row.is_playable === true };
}
function importPlaylistId(value) {
  const invalid = () => new AppError(400, 'INVALID_SPOTIFY_PLAYLIST_LINK', 'Paste an HTTPS open.spotify.com playlist link. Shortened links are not supported.');
  if (!text(value, 2048)) throw invalid();
  let url; try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.port || url.username || url.password) throw invalid();
  const match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{22})$/);
  if (!match) throw invalid();
  return match[1];
}
const incompleteImport = () => new AppError(409, 'SPOTIFY_IMPORT_INCOMPLETE', 'Spotify did not return a complete, consistent playlist. Refresh it and try again; no partial playlist was imported.');
const largeImport = () => new AppError(413, 'SPOTIFY_IMPORT_TOO_LARGE', 'Import a playlist with at most 500 items. No partial playlist was imported.');
const playlistAccessRequired = () => new AppError(403, 'SPOTIFY_PLAYLIST_ACCESS_REQUIRED', 'Spotify did not provide this playlist’s songs. Connect its owner or a collaborator, and check the app’s developer access. A public link alone may provide only playlist details.');
function importTrack(row, country) {
  if (!row || row.type !== 'track' || !spotifyId(row.id) || !text(row.name) || row.is_local === true || row.is_playable === false
    || row.restrictions != null || row.album?.restrictions != null || (Array.isArray(row.available_markets) && !row.available_markets.includes(country))
    || (row.uri !== undefined && row.uri !== `spotify:track:${row.id}`)) return null;
  let url;
  try { url = new URL(row.external_urls?.spotify); if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.username || url.password || url.port || url.pathname !== `/track/${row.id}`) return null; url.search = ''; url.hash = ''; } catch { return null; }
  const requestArtists = Array.isArray(row.artists) ? [...new Set(row.artists.slice(0, 30).filter(artist => artist?.type === 'artist' && text(artist.name)
    && (artist.id == null || spotifyId(artist.id))).map(artist => artist.name.replace(/\s+/gu, ' ').trim()))] : [];
  const artist = requestArtists.join(', ');
  if (artist && !text(artist)) return null;
  const images = Array.isArray(row.album?.images) ? row.album.images.slice(0, 10) : [];
  return { id: randomUUID(), title: row.name.trim(), artist, album: text(row.album?.name) ? row.album.name.trim() : '', ...releaseYearMetadata(row.album?.release_date),
    durationMs: Number.isSafeInteger(row.duration_ms) && row.duration_ms >= 0 && row.duration_ms <= 86400000 ? row.duration_ms : 0,
    artwork: images.map(image => safeImage(image?.url)).find(Boolean) || null, url: url.href,
    requestArtist: requestArtists[0] || '', requestArtists, needsReview: !artist, source: SOURCE, country };
}
const copyResult = result => ({ ...result, tracks: result.tracks.map(track => ({ ...track })) });
const copyPrepared = track => ({ ...track, requestArtists: [...track.requestArtists] });

export class SpotifyService {
  constructor({ dataDir, port = 4318, fetcher = fetch, clock = Date.now } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('Spotify data directory required');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Valid local Spotify callback port required');
    this.fetcher = fetcher;
    this.clock = clock;
    this.redirectUri = `http://127.0.0.1:${port}/api/spotify/callback`;
    this.configFile = path.join(dataDir, 'spotify-config.json');
    this.userFile = path.join(dataDir, 'spotify-user.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    this.generation = 0;
    this.authorization = null;
    this.refreshFlight = null;
    this.cache = new Map();
    this.tracks = new Map();
    this.inflight = new Map();
    this.trackInflight = new Map();
    this.playlistEntries = new Map();
    this.playlistCache = null;
    this.playlistFlight = null;
    this.calls = [];
    this.activeRequests = 0;
    const saved = readJson(this.configFile);
    this.configuration = clientId(saved?.clientId) && text(saved?.configurationId) ? { clientId: saved.clientId, configurationId: saved.configurationId } : null;
    const user = readJson(this.userFile);
    this.session = this.configuration && user?.configurationId === this.configuration.configurationId && tokenText(user.accessToken) && tokenText(user.refreshToken) && typeof user.expiresAt === 'number' && Number.isFinite(user.expiresAt) && (user.country === null || countryCode(user.country)) ? { accessToken: user.accessToken, refreshToken: user.refreshToken, expiresAt: user.expiresAt, country: user.country, accountId: text(user.accountId) ? user.accountId : null } : null;
  }
  status() {
    const configured = !!this.configuration, connected = configured && !!this.session;
    const country = connected ? this.session.country : null;
    const catalogReady = connected && COUNTRIES.has(country);
    const message = !configured ? 'Optional: add your Spotify app Client ID, then connect Spotify. Development access requires the app owner to have Spotify Premium and your account to be allowlisted.' : !connected ? 'Spotify app setup is ready. Connect your Spotify account.' : !country ? 'Spotify connected. Spotify did not provide your account country; India browsing can continue through the public catalogue.' : !catalogReady ? `Spotify connected (${country}). This account country is not supported by the catalogue selector.` : `Spotify connected (${country}). Its catalogue can be searched for that account country.`;
    return { configured, connected, needsSetup: !configured, catalogReady, source: SOURCE, country, message, redirectUri: this.redirectUri };
  }
  configure(value) {
    const nextId = typeof value?.clientId === 'string' ? value.clientId.trim().toLowerCase() : '';
    if (!clientId(nextId)) throw new AppError(400, 'INVALID_SPOTIFY_CLIENT_ID', 'Use the 32-character Spotify app Client ID from the developer dashboard.');
    const configuration = { clientId: nextId, configurationId: randomUUID() };
    privateWrite(this.configFile, configuration);
    this.configuration = configuration;
    this.disconnect();
    return this.status();
  }
  clearCaches() { this.cache.clear(); this.tracks.clear(); this.inflight.clear(); this.trackInflight.clear(); this.playlistEntries.clear(); this.playlistCache = null; this.playlistFlight = null; }
  disconnect() {
    ++this.generation;
    this.authorization = null;
    this.session = null;
    this.refreshFlight = null;
    this.clearCaches();
    try { fs.rmSync(this.userFile, { force: true }); } catch { throw new AppError(500, 'SPOTIFY_SAVE_FAILED', 'The saved Spotify sign-in could not be removed.'); }
    return this.status();
  }
  guard(generation) { if (generation !== this.generation) throw changed(); }
  beginAuthorization() {
    if (!this.configuration) throw setupRequired();
    ++this.generation;
    this.refreshFlight = null;
    this.clearCaches();
    const verifier = randomBytes(64).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const expiresAt = this.clock() + 10 * 60_000;
    this.authorization = { verifier, state, expiresAt, generation: this.generation, configurationId: this.configuration.configurationId };
    const authorizationUrl = new URL('https://accounts.spotify.com/authorize');
    authorizationUrl.search = new URLSearchParams({ client_id: this.configuration.clientId, response_type: 'code', redirect_uri: this.redirectUri, scope: 'user-read-private playlist-read-private playlist-read-collaborative', state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    return { authorizationUrl: authorizationUrl.href, expiresAt };
  }
  async completeAuthorization({ code, state, error } = {}) {
    const pending = this.authorization;
    this.authorization = null; // Every callback consumes the state, including denial or invalid input.
    if (!pending || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state) || pending.state.length !== state.length || !timingSafeEqual(Buffer.from(pending.state), Buffer.from(state)) || pending.expiresAt <= this.clock()) throw new AppError(400, 'INVALID_SPOTIFY_STATE', 'Spotify sign-in expired or could not be verified. Start Connect Spotify again.');
    this.guard(pending.generation);
    if (!this.configuration || this.configuration.configurationId !== pending.configurationId) throw changed();
    if (error) throw new AppError(400, 'SPOTIFY_AUTHORIZATION_DENIED', 'Spotify sign-in was cancelled or not approved. You can connect again when ready.');
    if (!text(code, 4096)) throw new AppError(400, 'INVALID_SPOTIFY_CODE', 'Spotify did not return a valid sign-in code. Connect again.');
    const tokens = await this.exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: this.configuration.clientId, code, redirect_uri: this.redirectUri, code_verifier: pending.verifier }), pending.generation);
    this.guard(pending.generation);
    const profile = profileIdentity(await this.apiGet('/v1/me', tokens.accessToken, pending.generation));
    this.guard(pending.generation);
    if (!profile) throw unavailable();
    const session = { ...tokens, ...profile };
    privateWrite(this.userFile, { ...session, configurationId: this.configuration.configurationId });
    this.session = session;
    ++this.generation;
    this.clearCaches();
    return this.status();
  }
  async fetchJson(url, options, generation, { tokenRequest = false, refreshing = false, allowMissing = false } = {}) {
    this.guard(generation);
    const now = this.clock();
    this.calls = this.calls.filter(at => now - at < 60_000);
    if (this.activeRequests >= 8 || this.calls.length >= 40) throw new AppError(429, 'SPOTIFY_RATE_LIMIT', 'Too many Spotify requests. Please wait a minute and try again.');
    this.calls.push(now); ++this.activeRequests;
    try {
      let response;
      try { response = await this.fetcher(new URL(url), { ...options, redirect: 'error', signal: AbortSignal.timeout(12_000) }); } catch { this.guard(generation); throw unavailable(); }
      this.guard(generation);
      if (!response || typeof response.ok !== 'boolean') throw unavailable();
      if (response.status === 429) throw new AppError(429, 'SPOTIFY_RATE_LIMIT', 'Spotify is receiving too many requests. Please wait a minute and try again.');
      if (tokenRequest && [400, 401].includes(response.status)) throw new AppError(401, refreshing ? 'SPOTIFY_REFRESH_REJECTED' : 'SPOTIFY_AUTHORIZATION_REJECTED', 'Spotify could not authorize this sign-in. Connect Spotify again.');
      if (response.status === 401) throw new AppError(401, 'SPOTIFY_SIGNIN_REQUIRED', 'Spotify could not authorize this request. Disconnect and connect Spotify again.');
      if (response.status === 403) throw new AppError(403, 'SPOTIFY_ACCESS_DENIED', 'Spotify did not allow this request. Check the app owner’s Premium subscription, allowlisted users, and developer access.');
      if (response.status === 404 && allowMissing) return null;
      if (!response.ok) throw unavailable();
      let payload;
      try { payload = await response.json(); } catch { this.guard(generation); throw unavailable(); }
      this.guard(generation);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error || payload.errors) throw unavailable();
      return payload;
    } finally { --this.activeRequests; }
  }
  async exchange(form, generation, previous = null) {
    const payload = await this.fetchJson('https://accounts.spotify.com/api/token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }, generation, { tokenRequest: true, refreshing: !!previous });
    this.guard(generation);
    const refreshToken = payload.refresh_token === undefined ? previous?.refreshToken : payload.refresh_token;
    if (!tokenText(payload.access_token) || !tokenText(refreshToken) || typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer' || !Number.isInteger(payload.expires_in) || payload.expires_in < 1 || payload.expires_in > 31 * 24 * 3600) throw unavailable();
    return { accessToken: payload.access_token, refreshToken, expiresAt: this.clock() + payload.expires_in * 1000 };
  }
  apiGet(resource, accessToken, generation, allowMissing = false) {
    const url = new URL(resource, 'https://api.spotify.com');
    if (url.origin !== 'https://api.spotify.com' || !url.pathname.startsWith('/v1/')) throw unavailable();
    return this.fetchJson(url, { headers: { accept: 'application/json', Authorization: `Bearer ${accessToken}` } }, generation, { allowMissing });
  }
  async accessToken() {
    if (!this.configuration) throw setupRequired();
    if (!this.session) throw signInRequired();
    if (this.session.expiresAt > this.clock() + 30_000) return this.session.accessToken;
    if (this.refreshFlight) return this.refreshFlight;
    const previous = this.session, generation = this.generation;
    const pending = this.refresh(previous, generation);
    this.refreshFlight = pending;
    try { return await pending; } finally { if (this.refreshFlight === pending) this.refreshFlight = null; }
  }
  async refresh(previous, generation) {
    try {
      const tokens = await this.exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previous.refreshToken, client_id: this.configuration.clientId }), generation, previous);
      this.guard(generation);
      const profile = profileIdentity(await this.apiGet('/v1/me', tokens.accessToken, generation));
      this.guard(generation);
      if (!profile || (previous.accountId && profile.accountId && previous.accountId !== profile.accountId)) throw unavailable();
      const session = { ...tokens, ...profile };
      privateWrite(this.userFile, { ...session, configurationId: this.configuration.configurationId });
      this.session = session;
      if (session.country !== previous.country) { ++this.generation; this.clearCaches(); }
      return session.accessToken;
    } catch (error) {
      if (error instanceof AppError && error.code === 'SPOTIFY_REFRESH_REJECTED' && generation === this.generation) this.disconnect();
      throw error;
    }
  }
  requireCountry(country) {
    if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose one of the supported catalogue countries.');
    if (!this.configuration) throw setupRequired();
    if (!this.session) throw signInRequired();
    if (!this.session.country) throw new AppError(409, 'SPOTIFY_COUNTRY_UNAVAILABLE', 'Spotify did not provide your account country. Country-specific browsing can continue through the public catalogue.');
    if (this.session.country !== country) throw new AppError(409, 'SPOTIFY_COUNTRY_MISMATCH', `Your Spotify account uses ${this.session.country}. Select that catalogue country or use another catalogue source.`);
  }
  async request(resource, country, allowMissing = false) {
    const generation = this.generation;
    const accessToken = await this.accessToken();
    this.guard(generation);
    this.requireCountry(country); // Refresh may have changed or removed the verified account country.
    return this.apiGet(resource, accessToken, generation, allowMissing);
  }
  async accountRequest(resource) {
    const generation = this.generation;
    const accessToken = await this.accessToken();
    this.guard(generation);
    return this.apiGet(resource, accessToken, generation);
  }
  async importPlaylist(value, country = 'IN', { metadataOnly = false } = {}) {
    const playlistId = importPlaylistId(value);
    this.requireCountry(country);
    const generation = this.generation;
    const read = async resource => {
      try {
        const result = await this.request(resource, country, true);
        this.guard(generation);
        if (!result) throw new AppError(404, 'SPOTIFY_PLAYLIST_UNAVAILABLE', 'This Spotify playlist could not be found or is not accessible to your connected account.');
        return result;
      } catch (error) {
        this.guard(generation);
        if (error instanceof AppError && error.code === 'SPOTIFY_ACCESS_DENIED') throw playlistAccessRequired();
        throw error;
      }
    };
    const metadataPath = `/v1/playlists/${playlistId}?${new URLSearchParams({ market: country })}`;
    const checkMetadata = payload => {
      if (payload?.id !== playlistId || payload.type !== 'playlist' || !text(payload.name)
        || (payload.snapshot_id !== undefined && !text(payload.snapshot_id, 1024))) throw incompleteImport();
      if (payload.items === undefined && payload.tracks === undefined) throw playlistAccessRequired();
      const contents = payload.items !== undefined ? payload.items : payload.tracks;
      if (!contents || typeof contents !== 'object' || !Number.isSafeInteger(contents.total) || contents.total < 0) throw incompleteImport();
      if (contents.total > 500) throw largeImport();
      return { total: contents.total, snapshot: payload.snapshot_id };
    };
    const metadata = await read(metadataPath), initial = checkMetadata(metadata), total = initial.total;
    if (metadataOnly) return { name: metadata.name.trim(), ...(safePlaylistAuthor(metadata.owner?.display_name) ? { author: safePlaylistAuthor(metadata.owner.display_name) } : {}), artwork: (Array.isArray(metadata.images) ? metadata.images.map(image => safeImage(image?.url)).find(Boolean) : null) || null, source: SOURCE };
    let snapshot = initial.snapshot;
    const itemsPath = `/v1/playlists/${playlistId}/items`;
    const resourceAt = offset => `${itemsPath}?${new URLSearchParams({ market: country, limit: '50', offset: String(offset), additional_types: 'track,episode' })}`;
    const seenPages = new Set();
    const tracks = [];
    let resource = resourceAt(0), received = 0, skipped = 0;
    for (let page = 0; page < 10; page++) {
      if (seenPages.has(resource)) throw incompleteImport(); seenPages.add(resource);
      const payload = await read(resource);
      if (!Array.isArray(payload.items) || payload.items.length > 50 || !Number.isSafeInteger(payload.total) || payload.total !== total
        || (payload.offset !== undefined && payload.offset !== received) || !Object.hasOwn(payload, 'next')) throw incompleteImport();
      if (payload.snapshot_id !== undefined) {
        if (!text(payload.snapshot_id, 1024) || (snapshot !== undefined && snapshot !== payload.snapshot_id)) throw incompleteImport();
        snapshot = payload.snapshot_id;
      }
      for (const entry of payload.items) {
        ++received;
        if (received > 500) throw largeImport();
        if (received > total) throw incompleteImport();
        if (entry === null) { ++skipped; continue; }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || (!Object.hasOwn(entry, 'item') && !Object.hasOwn(entry, 'track'))) throw incompleteImport();
        const row = Object.hasOwn(entry, 'item') ? entry.item : entry.track;
        const track = entry.is_local === true ? null : importTrack(row, country);
        if (track) tracks.push(track); else ++skipped;
      }
      if (payload.next === null) { resource = null; break; }
      if (!payload.items.length || !text(payload.next, 4096)) throw incompleteImport();
      let next;
      try {
        next = new URL(payload.next);
        if (next.origin !== 'https://api.spotify.com' || next.port || next.username || next.password || next.hash || next.pathname !== itemsPath) throw new Error('unsafe');
        const allowed = new Set(['market', 'limit', 'offset', 'additional_types']);
        for (const key of next.searchParams.keys()) if (!allowed.has(key) || next.searchParams.getAll(key).length !== 1) throw new Error('unsafe');
        if ((next.searchParams.has('market') && next.searchParams.get('market') !== country)
          || (next.searchParams.has('limit') && next.searchParams.get('limit') !== '50')
          || (next.searchParams.has('additional_types') && next.searchParams.get('additional_types') !== 'track,episode')
          || !/^(?:0|[1-9]\d{0,3})$/.test(next.searchParams.get('offset') || '') || Number(next.searchParams.get('offset')) !== received) throw new Error('unsafe');
      } catch { throw incompleteImport(); }
      resource = resourceAt(received);
      if (page === 9) { if (received >= 500) throw largeImport(); throw incompleteImport(); }
    }
    if (resource || received !== total) throw incompleteImport();
    // Spotify item pages do not normally carry a snapshot; re-read metadata to catch concurrent edits.
    const final = checkMetadata(await read(metadataPath));
    if (final.total !== total || (snapshot !== undefined && final.snapshot !== snapshot)) throw incompleteImport();
    this.guard(generation);
    const notes = [];
    if (skipped) notes.push(`${skipped} unavailable, local, non-song, or unrecognized playlist ${skipped === 1 ? 'item was' : 'items were'} skipped.`);
    const review = tracks.filter(track => track.needsReview).length;
    if (review) notes.push(`${review} ${review === 1 ? 'song needs' : 'songs need'} an artist before saving or playing.`);
    return { name: metadata.name.trim(), ...(safePlaylistAuthor(metadata.owner?.display_name) ? { author: safePlaylistAuthor(metadata.owner.display_name) } : {}), artwork: (Array.isArray(metadata.images) ? metadata.images.map(image => safeImage(image?.url)).find(Boolean) : null) || null, source: SOURCE, tracks, total, skipped, notes };
  }
  async playlists() {
    if (!this.configuration) throw setupRequired();
    if (!this.session) throw signInRequired();
    if (this.playlistCache && this.playlistCache.expires > this.clock()) return { ...this.playlistCache.result, playlists: this.playlistCache.result.playlists.map(item => ({ ...item })) };
    if (this.playlistFlight) { const result = await this.playlistFlight; return { ...result, playlists: result.playlists.map(item => ({ ...item })) }; }
    const generation = this.generation;
    const pending = this.loadPlaylists(generation);
    this.playlistFlight = pending;
    try { const result = await pending; return { ...result, playlists: result.playlists.map(item => ({ ...item })) }; } finally { if (this.playlistFlight === pending) this.playlistFlight = null; }
  }
  async loadPlaylists(generation) {
    const playlists = [], entries = new Map(), seen = new Set();
    let resource = '/v1/me/playlists?limit=50&offset=0', truncated = false;
    for (let page = 0; page < 4; page++) {
      const payload = await this.accountRequest(resource);
      this.guard(generation);
      if (!Array.isArray(payload.items)) throw unavailable();
      for (const row of payload.items.slice(0, 50)) {
        if (!row || row.type !== 'playlist' || !spotifyId(row.id) || !text(row.name) || seen.has(row.id)) continue;
        let url;
        try { url = new URL(row.external_urls?.spotify); if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.username || url.password || url.port || url.pathname !== `/playlist/${row.id}`) continue; } catch { continue; }
        seen.add(row.id);
        const count = row.items?.total ?? row.tracks?.total;
        const images = Array.isArray(row.images) ? row.images.slice(0, 10) : [];
        const item = Object.freeze({ id: randomUUID(), title: row.name.trim(), ...(safePlaylistAuthor(row.owner?.display_name) ? { author: safePlaylistAuthor(row.owner.display_name) } : {}), artwork: images.map(image => safeImage(image?.url)).find(Boolean) || null, itemCount: Number.isSafeInteger(count) && count >= 0 ? count : null, source: SOURCE, url: url.href });
        playlists.push(item); entries.set(item.id, { item, generation, expires: this.clock() + 30 * 60_000 });
      }
      if (!payload.next) { truncated = payload.items.length > 50; break; }
      let next;
      try { next = new URL(payload.next); if (next.protocol !== 'https:' || next.hostname !== 'api.spotify.com' || next.port || next.username || next.password || next.pathname !== '/v1/me/playlists') throw new Error('unsafe'); } catch { throw unavailable(); }
      if (page === 3) { truncated = true; break; }
      resource = next.pathname + next.search;
    }
    this.guard(generation);
    const result = { playlists, truncated };
    this.playlistEntries = entries;
    this.playlistCache = { result, expires: this.clock() + 5 * 60_000 };
    return result;
  }
  playlist(id) {
    const entry = typeof id === 'string' && this.playlistEntries.get(id);
    if (!this.session || !entry || entry.generation !== this.generation || entry.expires <= this.clock()) throw new AppError(400, 'EXPIRED_PLAYLIST', 'Load your Spotify playlists again, then choose one from the list.');
    return { ...entry.item };
  }
  async search(query, country = 'IN') {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!text(q, 140) || q.length < 2) throw new AppError(400, 'INVALID_SEARCH', 'Enter at least two characters to search.');
    this.requireCountry(country);
    const generation = this.generation, key = `${country}:${q.toLocaleLowerCase()}`;
    const saved = this.cache.get(key);
    if (saved && saved.expires > this.clock()) return copyResult(saved.result);
    if (this.inflight.has(key)) return copyResult(await this.inflight.get(key));
    if (this.inflight.size >= 8) throw new AppError(429, 'SPOTIFY_RATE_LIMIT', 'Please wait for your current Spotify searches to finish.');
    const pending = this.loadSearch(q, country, key, generation);
    this.inflight.set(key, pending);
    try { return copyResult(await pending); } finally { if (this.inflight.get(key) === pending) this.inflight.delete(key); }
  }
  async loadSearch(query, country, key, generation) {
    const payload = await this.request(`/v1/search?${new URLSearchParams({ q: query, type: 'track', market: country, limit: '10' })}`, country);
    this.guard(generation);
    if (!Array.isArray(payload.tracks?.items)) throw unavailable();
    const tracks = [], seen = new Set(); let playable = true;
    for (const row of payload.tracks.items.slice(0, 10)) {
      if (seen.has(row?.id)) continue;
      const item = normalizeTrack(row, country);
      if (!item) continue;
      seen.add(row.id); tracks.push(item.track); playable = playable && item.playable;
      this.tracks.set(item.track.id, { ...item, country, generation, expires: this.clock() + 30 * 60_000 });
    }
    const result = { tracks, source: SOURCE, country, availability: tracks.length && playable ? 'catalogue-playable' : 'unverified' };
    this.cache.set(key, { result, expires: this.clock() + 5 * 60_000 });
    for (const [id, entry] of this.tracks) if (entry.expires <= this.clock()) this.tracks.delete(id);
    while (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
    while (this.tracks.size > 1500) this.tracks.delete(this.tracks.keys().next().value);
    return result;
  }
  getTrack(id) {
    const entry = typeof id === 'string' && this.tracks.get(id);
    if (!entry || entry.expires <= this.clock() || entry.generation !== this.generation) throw new AppError(400, 'EXPIRED_RESULT', 'Search Spotify again, then choose a song from the results.');
    return { ...entry.track };
  }
  async prepareTrack(id, country = 'IN') {
    this.requireCountry(country); this.getTrack(id);
    const entry = this.tracks.get(id);
    if (entry.country !== country) throw new AppError(409, 'SPOTIFY_COUNTRY_CHANGED', 'The catalogue country changed. Search again before playing this song.');
    const key = `${country}:${id}`, generation = this.generation;
    if (this.trackInflight.has(key)) return copyPrepared(await this.trackInflight.get(key));
    if (this.trackInflight.size >= 8) throw new AppError(429, 'SPOTIFY_RATE_LIMIT', 'Please wait for your current Spotify availability checks to finish.');
    const pending = this.verifyTrack(entry, id, country, generation);
    this.trackInflight.set(key, pending);
    try { return copyPrepared(await pending); } finally { if (this.trackInflight.get(key) === pending) this.trackInflight.delete(key); }
  }
  async verifyTrack(entry, id, country, generation) {
    const payload = await this.request(`/v1/tracks/${entry.sourceId}?${new URLSearchParams({ market: country })}`, country, true);
    this.guard(generation);
    const verified = payload?.id === entry.sourceId && normalizeTrack(payload, country, id);
    if (!verified) {
      this.tracks.delete(id); this.cache.clear();
      throw new AppError(409, 'SPOTIFY_SONG_UNAVAILABLE', 'Spotify no longer lists this recording as available for your account country. Choose another result.');
    }
    this.tracks.set(id, { ...verified, country, generation, expires: this.clock() + 30 * 60_000 });
    return { ...verified.track, requestArtist: verified.requestArtists[0], requestArtists: [...verified.requestArtists] };
  }
}
