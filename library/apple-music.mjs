import { releaseYearMetadata } from './track-release.mjs';
import { safePlaylistAuthor } from './playlist-links.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { AppError, COUNTRIES } from './catalog.mjs';
import { normalizeArtworkTemplate } from './track-artwork.mjs';

const SOURCE = 'apple-music';
const APP = Object.freeze({ name: 'Echo Library', build: '0.2.0' });
const text = (value, max = 250) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const catalogId = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const userToken = value => typeof value === 'string' && value.length >= 8 && value.length <= 16_384 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const tokenPart = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const setupError = () => new AppError(503, 'APPLE_SETUP_REQUIRED', 'Add valid Apple Music developer credentials in Connect Apple Music, then try again.');
const unavailable = () => new AppError(502, 'APPLE_UNAVAILABLE', 'Apple Music availability could not be verified. Please try again.');
const changed = () => new AppError(409, 'APPLE_CONNECTION_CHANGED', 'Your Apple Music connection changed. Please try again.');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function privateWrite(file, value) {
  const temp = file + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw new AppError(500, 'APPLE_SAVE_FAILED', 'The Apple Music connection could not be saved in this project folder.');
  }
}
function safeUrl(value, hosts) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : null;
  } catch { return null; }
}
function decodeDeveloperToken(value, now) {
  try {
    if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return null;
    const [h, p, s] = value.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (header.alg !== 'ES256' || !/^[A-Z0-9]{10}$/.test(header.kid || '') || !/^[A-Z0-9]{10}$/.test(claims.iss || '') || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > seconds + 60 || claims.exp <= seconds + 30 || claims.exp <= claims.iat || claims.exp - claims.iat > 15_777_000 || Buffer.from(s, 'base64url').length !== 64) return null;
    // Parsing checks syntax and expiry. Apple verifies the signature on the API request.
    return { token: value, expires: claims.exp * 1000 };
  } catch { return null; }
}
function keyConfiguration(value) {
  if (!/^[A-Z0-9]{10}$/.test(value?.teamId || '') || !/^[A-Z0-9]{10}$/.test(value?.keyId || '') || typeof value?.privateKey !== 'string' || value.privateKey.length > 8192) return null;
  try {
    const key = createPrivateKey(value.privateKey);
    if (key.asymmetricKeyType !== 'ec' || !['prime256v1', 'P-256'].includes(key.asymmetricKeyDetails?.namedCurve)) return null;
    return { type: 'key', teamId: value.teamId, keyId: value.keyId, privateKey: value.privateKey };
  } catch { return null; }
}
function normalizeSong(row, country, id = randomUUID()) {
  const a = row?.attributes;
  if (row?.type !== 'songs' || !catalogId(row.id) || !a || !catalogId(a.playParams?.id) || a.playParams.kind !== 'song' || !text(a.name) || !text(a.artistName)) return null;
  if (typeof row.href === 'string' && !row.href.startsWith(`/v1/catalog/${country.toLowerCase()}/songs/`)) return null;
  const url = safeUrl(a.url, ['music.apple.com']);
  if (!url || new URL(url).pathname.split('/')[1] !== country.toLowerCase()) return null;
  const artists = row.relationships?.artists?.data;
  const requestArtists = Array.isArray(artists) ? [...new Set(artists.slice(0, 30).filter(item => item?.type === 'artists' && catalogId(item.id) && text(item.attributes?.name)).map(item => item.attributes.name.replace(/\s+/gu, ' ').trim()))] : [];
  const artwork = typeof a.artwork?.url === 'string' ? normalizeArtworkTemplate(a.artwork.url) : null;
  return {
    track: Object.freeze({ id, title: a.name.trim(), artist: a.artistName.trim(), album: text(a.albumName) ? a.albumName.trim() : '', ...releaseYearMetadata(a.releaseDate), artwork: safeUrl(artwork, ['mzstatic.com']), url, durationMs: Number.isFinite(a.durationInMillis) && a.durationInMillis >= 0 ? a.durationInMillis : 0, explicit: a.contentRating === 'explicit' }),
    requestArtist: requestArtists[0] || a.artistName.trim(), requestArtists: Object.freeze(requestArtists), catalogId: row.id,
  };
}
const copyResult = result => ({ ...result, tracks: result.tracks.map(track => ({ ...track })) });

const incompletePlaylistImport = () => new AppError(409, 'APPLE_IMPORT_INCOMPLETE', 'Apple Music did not return a complete, consistent playlist. No partial playlist was imported.');
const largePlaylistImport = () => new AppError(413, 'APPLE_IMPORT_TOO_LARGE', 'Import a playlist with at most 500 entries. No partial playlist was imported.');
function importPlaylistLink(value) {
  const invalid = () => new AppError(400, 'INVALID_APPLE_PLAYLIST_LINK', 'Paste a public music.apple.com playlist link with its country and playlist identifier.');
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw invalid();
  let url;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  const match = url.pathname.match(/^\/([a-z]{2})\/playlist\/(?:([^/]+)\/)?(pl\.[A-Za-z0-9_-]{1,128})\/?$/iu);
  if (url.protocol !== 'https:' || url.hostname !== 'music.apple.com' || url.username || url.password || url.port || !match) throw invalid();
  return { id: match[3], slug: match[2] || 'playlist' };
}
const PUBLIC_PLAYLIST_BYTES = 8 * 1024 * 1024;
const publicPlaylistUnavailable = () => new AppError(502, 'APPLE_PUBLIC_PLAYLIST_UNAVAILABLE', 'The public Apple Music playlist page could not be read. Try again or paste song titles and artists.');
function publicTrackId(value, country) {
  const safe = safeUrl(value, ['music.apple.com']);
  if (!safe) return null;
  const url = new URL(safe), parts = url.pathname.split('/');
  if (url.hostname !== 'music.apple.com' || parts[1] !== country.toLowerCase()) return null;
  const id = parts[2] === 'album' && url.searchParams.getAll('i').length === 1 ? url.searchParams.get('i') : parts[2] === 'song' ? parts.at(-1) : null;
  return catalogId(id) ? id : null;
}
function publicPlaylistUrl(value, id, country) {
  const safe = safeUrl(value, ['music.apple.com']);
  if (!safe) return false;
  const url = new URL(safe), parts = url.pathname.replace(/\/$/u, '').split('/');
  return url.hostname === 'music.apple.com' && !url.port && parts.length === 5 && parts[1] === country.toLowerCase() && parts[2] === 'playlist' && parts[4] === id;
}
async function publicPlaylistHtml(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > PUBLIC_PLAYLIST_BYTES) throw new AppError(413, 'APPLE_PUBLIC_PLAYLIST_TOO_LARGE', 'The public playlist page is too large to import safely. No playlist was imported.');
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
      if (size > PUBLIC_PLAYLIST_BYTES) throw new AppError(413, 'APPLE_PUBLIC_PLAYLIST_TOO_LARGE', 'The public playlist page is too large to import safely. No playlist was imported.');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  }
  if (typeof response.text !== 'function') throw publicPlaylistUnavailable();
  const html = await response.text();
  if (typeof html !== 'string') throw publicPlaylistUnavailable();
  if (Buffer.byteLength(html) > PUBLIC_PLAYLIST_BYTES) throw new AppError(413, 'APPLE_PUBLIC_PLAYLIST_TOO_LARGE', 'The public playlist page is too large to import safely. No playlist was imported.');
  return html;
}
function parsePublicPlaylist(html, id, country, canonicalUrl) {
  let schema = null, serialized = null;
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    const attribute = name => { const match = [...attributes.matchAll(/(?:^|\s)([a-z][a-z0-9_:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)].find(item => item[1].toLowerCase() === name); return match ? match[2] ?? match[3] ?? match[4] : undefined; };
    const scriptId = attribute('id');
    if (scriptId !== 'serialized-server-data' && scriptId !== 'schema:music-playlist') continue;
    let value;
    try { value = JSON.parse(body); } catch { throw incompletePlaylistImport(); }
    if (scriptId === 'serialized-server-data') { if (serialized) throw incompletePlaylistImport(); serialized = value; }
    else { if (schema || attribute('type')?.toLowerCase() !== 'application/ld+json') throw incompletePlaylistImport(); schema = value; }
  }
  if (!schema || schema['@type'] !== 'MusicPlaylist' || !text(schema.name) || !publicPlaylistUrl(schema.url, id, country)
    || !Number.isSafeInteger(schema.numTracks) || schema.numTracks < 0 || !Array.isArray(schema.track)) throw incompletePlaylistImport();
  const total = schema.numTracks;
  if (total > 500) throw largePlaylistImport();
  if (schema.track.length !== total || !serialized || !Array.isArray(serialized.data)) throw incompletePlaylistImport();
  const ids = schema.track.map(track => {
    if (!track || typeof track !== 'object' || !text(track.name)) throw incompletePlaylistImport();
    const found = publicTrackId(track.url, country); if (!found) throw incompletePlaylistImport(); return found;
  });
  const candidates = [];
  for (const frame of serialized.data.slice(0, 20)) {
    const sections = frame?.data?.sections;
    if (!Array.isArray(sections)) continue;
    for (const section of sections.slice(0, 100)) {
      const rows = section?.items;
      if (!Array.isArray(rows) || rows.length !== total) continue;
      if (rows.every((row, index) => row?.contentDescriptor?.identifiers?.storeAdamID === ids[index]
        && publicTrackId(row.contentDescriptor.url, country) === ids[index])) candidates.push(rows);
    }
  }
  if (candidates.length !== 1) throw incompletePlaylistImport();
  const tracks = []; let skipped = 0;
  for (let index = 0; index < total; index++) {
    const row = candidates[0][index];
    if (row.contentDescriptor.kind !== 'song') { ++skipped; continue; }
    if (!text(row.title) || row.title.normalize('NFKC').trim() !== schema.track[index].name.normalize('NFKC').trim()
      || (row.artistName !== undefined && row.artistName !== '' && !text(row.artistName))) throw incompletePlaylistImport();
    const artist = typeof row.artistName === 'string' ? row.artistName.trim() : '';
    const template = row.artwork?.dictionary?.url;
    const artwork = typeof template === 'string' ? normalizeArtworkTemplate(template) : null;
    tracks.push({ id: randomUUID(), title: row.title.trim(), artist, album: '', ...releaseYearMetadata(row.releaseDate || schema.track[index].datePublished),
      durationMs: Number.isSafeInteger(row.duration) && row.duration >= 0 && row.duration <= 86400000 ? row.duration : 0,
      artwork: safeUrl(artwork, ['mzstatic.com']), url: row.contentDescriptor.url, requestArtist: artist, requestArtists: artist ? [artist] : [],
      needsReview: !artist, source: SOURCE, country });
  }
  const notes = ['Loaded public page metadata. Apple Music streaming availability in this country and playback on your Echo are unverified.'];
  if (skipped) notes.push(`${skipped} unsupported ${skipped === 1 ? 'entry was' : 'entries were'} skipped.`);
  const missing = tracks.filter(track => track.needsReview).length;
  if (missing) notes.push(`${missing} ${missing === 1 ? 'song needs' : 'songs need'} an artist before saving or playing.`);
  const imageMeta = [...html.matchAll(/<meta\b([^>]*)>/giu)].map(match => { const attr = name => new RegExp('\\b' + name + '=([\"\'])(.*?)\\1', 'iu').exec(match[1])?.[2]; return /^(?:og:image|og:image:secure_url)$/u.test(attr('property') || '') ? attr('content')?.replaceAll('&amp;', '&') : null; }).find(Boolean);
  const playlistArtwork = safeUrl(normalizeArtworkTemplate(typeof schema.image === 'string' ? schema.image : imageMeta), ['mzstatic.com']);
  const author = safePlaylistAuthor(typeof schema.author === 'string' ? schema.author : schema.author?.name);
  return { name: schema.name.trim(), ...(author ? { author } : {}), artwork: playlistArtwork, source: SOURCE, url: canonicalUrl, method: 'public-page', availability: 'unverified', tracks, total, skipped, notes };
}
function importedSong(row, country) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !text(row.type, 100) || !text(row.id, 100)) throw incompletePlaylistImport();
  if (row.type !== 'songs') return null;
  if (!catalogId(row.id)) throw incompletePlaylistImport();
  const a = row.attributes;
  if (a === undefined || a === null) return null;
  if (typeof a !== 'object' || Array.isArray(a)) throw incompletePlaylistImport();
  if (!catalogId(a.playParams?.id) || a.playParams.kind !== 'song') return null;
  const storefront = country.toLowerCase();
  if (row.href !== undefined && row.href !== `/v1/catalog/${storefront}/songs/${row.id}`) return null;
  const url = safeUrl(a.url, ['music.apple.com']);
  if (a.url !== undefined && (!url || new URL(url).hostname !== 'music.apple.com' || new URL(url).pathname.split('/')[1] !== storefront)) return null;
  if (!text(a.name) || (a.artistName !== undefined && a.artistName !== '' && !text(a.artistName))) throw incompletePlaylistImport();
  const artist = typeof a.artistName === 'string' ? a.artistName.trim() : '';
  const artists = row.relationships?.artists?.data;
  const requestArtists = Array.isArray(artists) ? [...new Set(artists.slice(0, 30).filter(item => item?.type === 'artists' && catalogId(item.id) && text(item.attributes?.name)).map(item => item.attributes.name.replace(/\s+/gu, ' ').trim()))] : [];
  const artwork = typeof a.artwork?.url === 'string' ? normalizeArtworkTemplate(a.artwork.url) : null;
  return { id: randomUUID(), title: a.name.trim(), artist, album: text(a.albumName) ? a.albumName.trim() : '', ...releaseYearMetadata(a.releaseDate),
    durationMs: Number.isSafeInteger(a.durationInMillis) && a.durationInMillis >= 0 && a.durationInMillis <= 86400000 ? a.durationInMillis : 0,
    artwork: safeUrl(artwork, ['mzstatic.com']), url, source: SOURCE, country,
    requestArtist: requestArtists[0] || artist, requestArtists, needsReview: !artist };
}


export class AppleMusicService {
  constructor({ dataDir, fetcher = fetch, clock = Date.now } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('Apple Music data directory required');
    this.dataDir = dataDir;
    this.fetcher = fetcher;
    this.clock = clock;
    this.configFile = path.join(dataDir, 'apple-config.json');
    this.userFile = path.join(dataDir, 'apple-user.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    this.generation = 0;
    this.cache = new Map();
    this.tracks = new Map();
    this.inflight = new Map();
    this.trackInflight = new Map();
    this.playlistEntries = new Map();
    this.calls = [];
    this.activeRequests = 0;
    this.generatedToken = null;
    const saved = readJson(this.configFile);
    this.configuration = null;
    if (saved?.type === 'key') {
      const validated = keyConfiguration(saved);
      if (validated && typeof saved.configurationId === 'string') this.configuration = { ...validated, configurationId: saved.configurationId };
    } else if (saved?.type === 'token' && decodeDeveloperToken(saved.developerToken, clock()) && typeof saved.configurationId === 'string') {
      this.configuration = { type: 'token', developerToken: saved.developerToken, configurationId: saved.configurationId };
    }
    const user = readJson(this.userFile);
    this.session = this.configuration && user?.configurationId === this.configuration.configurationId && userToken(user.musicUserToken) && /^[a-z]{2}$/.test(user.storefront || '') ? { musicUserToken: user.musicUserToken, storefront: user.storefront } : null;
  }
  isConfigured() {
    return !!this.configuration && (this.configuration.type === 'key' || !!decodeDeveloperToken(this.configuration.developerToken, this.clock()));
  }
  status() {
    const configured = this.isConfigured();
    const connected = configured && !!this.session;
    return { configured, connected, needsSetup: !configured, message: !configured ? 'Add your Apple Music app credentials, then sign in to verify your catalogue country.' : connected ? `Apple Music connected (${this.session.storefront.toUpperCase()}). Songs are checked for streaming availability in the selected country.` : 'Apple Music app credentials are ready. Sign in with your Apple Music account.', storefront: connected ? this.session.storefront : null, source: SOURCE };
  }
  developerToken() {
    if (!this.isConfigured()) throw setupError();
    if (this.configuration.type === 'token') return this.configuration.developerToken;
    const now = this.clock();
    if (this.generatedToken && this.generatedToken.expires > now + 5 * 60_000) return this.generatedToken.token;
    try {
      const issued = Math.floor(now / 1000);
      const header = tokenPart({ alg: 'ES256', kid: this.configuration.keyId, typ: 'JWT' });
      const claims = tokenPart({ iss: this.configuration.teamId, iat: issued, exp: issued + 3600 });
      const input = `${header}.${claims}`;
      const signature = sign('sha256', Buffer.from(input), { key: this.configuration.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      this.generatedToken = { token: `${input}.${signature}`, expires: (issued + 3600) * 1000 };
      return this.generatedToken.token;
    } catch { throw setupError(); }
  }
  publicConfig() {
    const token = this.developerToken();
    const expiry = decodeDeveloperToken(token, this.clock());
    return { developerToken: token, expiresAt: expiry?.expires || null, app: { ...APP } };
  }
  configure(value) {
    let configuration;
    if (value && Object.hasOwn(value, 'developerToken')) {
      if (!decodeDeveloperToken(value.developerToken, this.clock())) throw new AppError(400, 'INVALID_APPLE_CONFIGURATION', 'Use an unexpired Apple Music developer token signed with ES256.');
      configuration = { type: 'token', developerToken: value.developerToken };
    } else {
      configuration = keyConfiguration(value);
      if (!configuration) throw new AppError(400, 'INVALID_APPLE_CONFIGURATION', 'Provide the 10-character Team ID, 10-character Key ID, and the Media Services private key downloaded from Apple.');
    }
    const next = { ...configuration, configurationId: randomUUID() };
    privateWrite(this.configFile, next);
    this.configuration = next;
    this.generatedToken = null;
    this.disconnect();
    return this.status();
  }
  clearCaches() { this.playlistEntries.clear(); this.cache.clear(); this.tracks.clear(); this.inflight.clear(); this.trackInflight.clear(); }
  disconnect() {
    ++this.generation;
    this.session = null;
    this.clearCaches();
    try { fs.rmSync(this.userFile, { force: true }); } catch { throw new AppError(500, 'APPLE_SAVE_FAILED', 'The saved Apple Music sign-in could not be removed.'); }
    return this.status();
  }
  clearConfiguration() {
    this.disconnect();
    this.configuration = null;
    this.generatedToken = null;
    try { fs.rmSync(this.configFile, { force: true }); } catch { throw new AppError(500, 'APPLE_SAVE_FAILED', 'The saved Apple Music app credentials could not be removed.'); }
    return this.status();
  }
  async authorize(token) {
    if (!userToken(token)) throw new AppError(400, 'INVALID_APPLE_AUTHORIZATION', 'Complete the Apple Music sign-in window and try again.');
    const generation = this.generation;
    const payload = await this.request('/v1/me/storefront', { musicUserToken: token });
    const storefront = payload?.data?.length === 1 && payload.data[0]?.type === 'storefronts' && payload.data[0].id;
    if (typeof storefront !== 'string' || !/^[a-z]{2}$/.test(storefront)) throw unavailable();
    if (generation !== this.generation || !this.configuration) throw changed();
    privateWrite(this.userFile, { musicUserToken: token, storefront, configurationId: this.configuration.configurationId });
    this.session = { musicUserToken: token, storefront };
    ++this.generation;
    this.clearCaches();
    return this.status();
  }
  requireCountry(country) {
    if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose one of the supported catalogue countries.');
    if (!this.isConfigured()) throw setupError();
    if (this.session && this.session.storefront !== country.toLowerCase()) throw new AppError(409, 'APPLE_STOREFRONT_MISMATCH', `Your Apple Music account uses ${this.session.storefront.toUpperCase()}. Select that catalogue country or sign in with an account for ${country}.`);
  }
  async request(resource, { musicUserToken = this.session?.musicUserToken } = {}) {
    const developerToken = this.developerToken();
    const generation = this.generation;
    const now = this.clock();
    this.calls = this.calls.filter(at => now - at < 60_000);
    if (this.activeRequests >= 8 || this.calls.length >= 40) throw new AppError(429, 'APPLE_RATE_LIMIT', 'Too many Apple Music requests. Please wait a minute and try again.');
    this.calls.push(now);
    ++this.activeRequests;
    try {
      let response;
      try {
        response = await this.fetcher(new URL(resource, 'https://api.music.apple.com'), { signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json', Authorization: `Bearer ${developerToken}`, ...(musicUserToken ? { 'Music-User-Token': musicUserToken } : {}) } });
      } catch { throw unavailable(); }
      if (generation !== this.generation) throw changed();
      if (!response || typeof response.ok !== 'boolean') throw unavailable();
      if (response.status === 401) throw new AppError(401, 'APPLE_CREDENTIALS_REJECTED', 'Apple Music rejected the app credentials. Check the developer setup and try again.');
      if (response.status === 403) throw new AppError(403, 'APPLE_AUTHORIZATION_REJECTED', 'Apple Music could not authorize this request. Sign in again with an active Apple Music subscription.');
      if (response.status === 404) return { data: [] };
      if (response.status === 429) throw new AppError(429, 'APPLE_RATE_LIMIT', 'Apple Music is receiving too many requests. Please wait a minute and try again.');
      if (!response.ok) throw unavailable();
      let payload;
      try { payload = await response.json(); } catch { throw unavailable(); }
      if (generation !== this.generation) throw changed();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.errors) throw unavailable();
      return payload;
    } finally { --this.activeRequests; }
  }
  async importPlaylist(value, country = 'IN') {
    const link = importPlaylistLink(value), { id } = link;
    if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose a catalogue country before importing a playlist.');
    if (!this.isConfigured()) return this.importPublicPlaylist(link, country);
    const generation = this.generation, storefront = country.toLowerCase(), base = `/v1/catalog/${storefront}/playlists/${id}`, path = `${base}/tracks`;
    const guard = () => { if (generation !== this.generation) throw changed(); };
    const read = async resource => {
      try { const result = await this.request(resource, { musicUserToken: null }); guard(); return result; }
      catch (error) {
        if (error instanceof AppError && error.code === 'APPLE_AUTHORIZATION_REJECTED') throw new AppError(403, 'APPLE_PLAYLIST_ACCESS_REJECTED', 'Apple Music rejected access to this public playlist. Check the app credentials and selected country.');
        throw error;
      }
    };
    const metadata = await read(base);
    if (!Array.isArray(metadata.data)) throw incompletePlaylistImport();
    if (!metadata.data.length) throw new AppError(404, 'APPLE_PLAYLIST_UNAVAILABLE', 'This public playlist could not be found in the selected country.');
    const playlist = metadata.data[0];
    if (metadata.data.length !== 1 || playlist?.type !== 'playlists' || playlist.id !== id || !text(playlist.attributes?.name)
      || (playlist.href !== undefined && playlist.href !== base)) throw incompletePlaylistImport();
    const playlistUrl = playlist.attributes.url;
    if (playlistUrl !== undefined) {
      const safe = safeUrl(playlistUrl, ['music.apple.com']);
      if (!safe || new URL(safe).hostname !== 'music.apple.com' || new URL(safe).pathname.split('/')[1] !== storefront
        || new URL(safe).pathname.replace(/\/$/u, '').split('/').at(-1) !== id) throw incompletePlaylistImport();
    }
    let declared = null;
    const total = value => {
      if (value === undefined) return;
      if (!Number.isSafeInteger(value) || value < 0) throw incompletePlaylistImport();
      if (value > 500) throw largePlaylistImport();
      if (declared !== null && declared !== value) throw incompletePlaylistImport();
      declared = value;
    };
    total(playlist.attributes.trackCount); total(playlist.relationships?.tracks?.meta?.total);
    const embedded = playlist.relationships?.tracks?.data;
    const minimum = Array.isArray(embedded) ? embedded.length : 0;
    if (minimum > 500) throw largePlaylistImport();
    const tracks = [], offsets = new Set([0]);
    let received = 0, skipped = 0, next = `${path}?limit=100&include=artists`;
    for (let page = 0; next && page < 20; page++) {
      const payload = await read(next);
      if (!Array.isArray(payload.data) || payload.data.length > 100) throw incompletePlaylistImport();
      total(payload.meta?.total);
      for (const row of payload.data) {
        if (++received > 500) throw largePlaylistImport();
        if (declared !== null && received > declared) throw incompletePlaylistImport();
        const track = importedSong(row, country);
        if (track) tracks.push(track); else ++skipped;
      }
      const location = payload.next;
      if (location === undefined || location === null || location === '') { next = null; break; }
      if (!payload.data.length || typeof location !== 'string' || location.length > 2048 || location.split('?')[0] !== path || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(location)) throw incompletePlaylistImport();
      let link;
      try { link = new URL(location, 'https://api.music.apple.com'); } catch { throw incompletePlaylistImport(); }
      if (link.origin !== 'https://api.music.apple.com' || link.pathname !== path || link.hash
        || [...link.searchParams.keys()].some(key => !['offset', 'limit', 'include', 'l', 'extend'].includes(key))
        || link.searchParams.getAll('offset').length !== 1 || !/^(?:0|[1-9]\d*)$/u.test(link.searchParams.get('offset') || '')) throw incompletePlaylistImport();
      const offset = Number(link.searchParams.get('offset'));
      if (!Number.isSafeInteger(offset) || offset !== received || offsets.has(offset)) throw incompletePlaylistImport();
      offsets.add(offset);
      if (received >= 500) throw largePlaylistImport();
      next = `${path}?limit=100&include=artists&offset=${offset}`;
    }
    guard();
    if (next || received < minimum || (declared !== null && declared !== received)) throw incompletePlaylistImport();
    const notes = ['Imported metadata does not verify playback availability on your Echo.'];
    if (skipped) notes.push(`${skipped} unsupported, unavailable or wrong-country ${skipped === 1 ? 'entry was' : 'entries were'} skipped.`);
    const review = tracks.filter(track => track.needsReview).length;
    if (review) notes.push(`${review} ${review === 1 ? 'song needs' : 'songs need'} an artist before saving or playing.`);
    return { name: playlist.attributes.name.trim(), ...(safePlaylistAuthor(playlist.attributes.curatorName) ? { author: safePlaylistAuthor(playlist.attributes.curatorName) } : {}), artwork: safeUrl(normalizeArtworkTemplate(playlist.attributes.artwork?.url), ['mzstatic.com']), source: SOURCE, url: playlist.attributes.url || `https://music.apple.com/${storefront}/playlist/${link.slug}/${id}`, method: 'apple-music-api', availability: 'unverified', tracks, total: received, skipped, notes };
  }
  async importPublicPlaylist({ id, slug }, country) {
    const generation = this.generation, storefront = country.toLowerCase();
    const canonical = `https://music.apple.com/${storefront}/playlist/${slug}/${id}`;
    const guard = () => { if (generation !== this.generation) throw changed(); };
    const now = this.clock(); this.calls = this.calls.filter(at => now - at < 60_000);
    if (this.activeRequests >= 8 || this.calls.length >= 40) throw new AppError(429, 'APPLE_RATE_LIMIT', 'Too many Apple Music requests. Please wait a minute and try again.');
    this.calls.push(now); ++this.activeRequests;
    try {
      let address = canonical; const visited = new Set();
      for (let redirects = 0; redirects <= 3; redirects++) {
        guard();
        if (visited.has(address)) throw publicPlaylistUnavailable(); visited.add(address);
        let response;
        try { response = await this.fetcher(new URL(address), { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(12_000), headers: { accept: 'text/html' } }); }
        catch { throw publicPlaylistUnavailable(); }
        guard();
        if ([301, 302, 303, 307, 308].includes(response?.status)) {
          const location = response.headers?.get?.('location');
          let target;
          try { target = new URL(location, address); } catch { throw publicPlaylistUnavailable(); }
          if (typeof location !== 'string' || !location || !publicPlaylistUrl(target.href, id, country) || target.username || target.password || target.hash || redirects === 3) throw publicPlaylistUnavailable();
          target.search = ''; address = target.href; continue;
        }
        if (response?.status === 404) throw new AppError(404, 'APPLE_PLAYLIST_UNAVAILABLE', 'This public playlist could not be found in the selected country.');
        if (!response?.ok) throw publicPlaylistUnavailable();
        const contentType = response.headers?.get?.('content-type');
        if (contentType && !/^text\/html(?:;|$)/iu.test(contentType)) throw publicPlaylistUnavailable();
        let html;
        try { html = await publicPlaylistHtml(response); }
        catch (error) { if (error instanceof AppError) throw error; throw publicPlaylistUnavailable(); }
        guard();
        return parsePublicPlaylist(html, id, country, address);
      }
      throw publicPlaylistUnavailable();
    } finally { --this.activeRequests; }
  }
  async playlists() {
    if (!this.status().connected) throw new AppError(401, 'APPLE_SIGNIN_REQUIRED', 'Connect Apple Music to browse your playlists.');
    const generation = this.generation;
    const playlists = [], seenPages = new Set();
    let next = '/v1/me/library/playlists?limit=100';
    while (next && playlists.length < 200) {
      if (!next.startsWith('/v1/me/library/playlists?') || seenPages.has(next)) throw unavailable();
      seenPages.add(next);
      const payload = await this.request(next);
      if (generation !== this.generation) throw changed();
      if (!Array.isArray(payload.data)) throw unavailable();
      for (const row of payload.data) {
        const a = row?.attributes;
        if (row?.type !== 'library-playlists' || !text(row.id, 100) || !text(a?.name)) continue;
        const existing = [...this.playlistEntries.values()].find(entry => entry.nativeId === row.id && entry.generation === generation);
        const id = existing?.playlist.id || randomUUID();
        const artwork = typeof a.artwork?.url === 'string' ? normalizeArtworkTemplate(a.artwork.url) : null;
        const playlist = { id, title: a.name.trim(), ...(safePlaylistAuthor(a.curatorName) ? { author: safePlaylistAuthor(a.curatorName) } : {}), artwork: safeUrl(artwork, ['mzstatic.com']), itemCount: Number.isInteger(a.trackCount) && a.trackCount >= 0 ? a.trackCount : null, source: SOURCE, url: safeUrl(a.url, ['music.apple.com']) };
        this.playlistEntries.set(id, { playlist, nativeId: row.id, generation, expires: this.clock() + 30 * 60_000 });
        playlists.push({ ...playlist });
        if (playlists.length >= 200) break;
      }
      next = typeof payload.next === 'string' ? payload.next : null;
    }
    while (this.playlistEntries.size > 500) this.playlistEntries.delete(this.playlistEntries.keys().next().value);
    return { playlists, truncated: !!next };
  }
  async playlist(id) {
    const entry = typeof id === 'string' && this.playlistEntries.get(id);
    if (!this.status().connected || !entry || entry.generation !== this.generation || entry.expires <= this.clock()) throw new AppError(400, 'EXPIRED_PLAYLIST', 'Refresh your playlists, then choose one again.');
    return { ...entry.playlist };
  }
  async search(query, country = 'IN') {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!text(q, 140) || q.length < 2) throw new AppError(400, 'INVALID_SEARCH', 'Enter at least two characters to search.');
    this.requireCountry(country);
    const key = `${country}:${q.toLocaleLowerCase()}`;
    const saved = this.cache.get(key);
    if (saved && saved.expires > this.clock()) return copyResult(saved.result);
    if (this.inflight.has(key)) return copyResult(await this.inflight.get(key));
    if (this.inflight.size >= 8) throw new AppError(429, 'APPLE_RATE_LIMIT', 'Please wait for your current searches to finish.');
    const pending = this.loadSearch(q, country, key);
    this.inflight.set(key, pending);
    try { return copyResult(await pending); } finally { if (this.inflight.get(key) === pending) this.inflight.delete(key); }
  }
  async loadSearch(query, country, key) {
    const params = new URLSearchParams({ types: 'songs', term: query, limit: '25', include: 'artists' });
    const payload = await this.request(`/v1/catalog/${country.toLowerCase()}/search?${params}`);
    const rows = payload?.results?.songs?.data;
    if (rows !== undefined && !Array.isArray(rows)) throw unavailable();
    if (!payload.results || typeof payload.results !== 'object') throw unavailable();
    const tracks = [], seen = new Set();
    for (const row of (rows || []).slice(0, 50)) {
      if (seen.has(row?.id)) continue;
      const item = normalizeSong(row, country);
      if (!item) continue;
      seen.add(row.id);
      tracks.push(item.track);
      this.tracks.set(item.track.id, { ...item, country, expires: this.clock() + 30 * 60_000 });
    }
    const result = { tracks, source: SOURCE, country, availability: 'catalogue-playable' };
    this.cache.set(key, { result, expires: this.clock() + 5 * 60_000 });
    for (const [id, value] of this.tracks) if (value.expires <= this.clock()) this.tracks.delete(id);
    while (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
    while (this.tracks.size > 1500) this.tracks.delete(this.tracks.keys().next().value);
    return result;
  }
  getTrack(id) {
    const entry = typeof id === 'string' && this.tracks.get(id);
    if (!entry || entry.expires <= this.clock()) throw new AppError(400, 'EXPIRED_RESULT', 'Search again, then choose a song from the verified results.');
    return { ...entry.track };
  }
  async prepareTrack(id, expectedCountry = 'IN') {
    this.requireCountry(expectedCountry);
    this.getTrack(id);
    const entry = this.tracks.get(id);
    if (entry.country !== expectedCountry) throw new AppError(409, 'APPLE_COUNTRY_CHANGED', 'The catalogue country changed. Search again before playing this song.');
    const key = `${expectedCountry}:${id}`;
    if (this.trackInflight.has(key)) return { ...await this.trackInflight.get(key) };
    if (this.trackInflight.size >= 8) throw new AppError(429, 'APPLE_RATE_LIMIT', 'Please wait for the current availability checks to finish.');
    const pending = this.verifyTrack(entry, id, expectedCountry);
    this.trackInflight.set(key, pending);
    try { return { ...await pending }; } finally { if (this.trackInflight.get(key) === pending) this.trackInflight.delete(key); }
  }
  async verifyTrack(entry, id, country) {
    const payload = await this.request(`/v1/catalog/${country.toLowerCase()}/songs/${entry.catalogId}?include=artists`);
    if (!Array.isArray(payload.data)) throw unavailable();
    const row = payload.data.find(song => song?.id === entry.catalogId);
    const verified = normalizeSong(row, country, id);
    if (!verified) {
      this.tracks.delete(id);
      this.cache.clear();
      throw new AppError(409, 'APPLE_SONG_UNAVAILABLE', 'This song is no longer verified as streamable in the selected country. Please choose another result.');
    }
    this.tracks.set(id, { ...verified, country, expires: this.clock() + 30 * 60_000 });
    return { ...verified.track, requestArtist: verified.requestArtist, requestArtists: verified.requestArtists };
  }
}
