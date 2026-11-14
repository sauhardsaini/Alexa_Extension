import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { resolveMusicProvider } from './music-providers.mjs';
import { normalizeReleaseYear, releaseYearMetadata } from './track-release.mjs';
import { hasTaylorsVersion } from './music-matching.mjs';
import { cleanSongTitle } from './song-title.mjs';
export { AppError } from './errors.mjs';

export const COUNTRIES = new Set(['IN', 'US', 'GB', 'DE', 'CA', 'AU', 'JP']);
const COUNTRY_ALPHA3 = Object.freeze({ IN: 'IND', US: 'USA', GB: 'GBR', DE: 'DEU', CA: 'CAN', AU: 'AUS', JP: 'JPN' });
const cleanText = (value, max = 250) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const safeUrl = (value, hosts) => {
  try { const url = new URL(value); return url.protocol === 'https:' && hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : null; } catch { return null; }
};

export class Catalog {
  constructor({ fetcher = fetch, clock = Date.now } = {}) {
    this.fetcher = fetcher;
    this.clock = clock;
    this.cache = new Map();
    this.tracks = new Map();
    this.inflight = new Map();
    this.artistCache = new Map();
    this.artistInflight = new Map();
    this.calls = [];
  }
  async search(query, country = 'IN') {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!cleanText(q, 140) || q.length < 2) throw new AppError(400, 'INVALID_SEARCH', 'Enter at least two characters to search.');
    if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose one of the supported catalogue countries.');
    const key = country + ':' + q.toLocaleLowerCase();
    const now = this.clock();
    const saved = this.cache.get(key);
    if (saved && saved.expires > now) return saved.result;
    if (this.inflight.has(key)) return this.inflight.get(key);
    if (!this.reserveCall()) throw new AppError(429, 'SEARCH_LIMIT', 'Too many searches. Please wait a minute and try again.');
    const request = this.load(q, country, key);
    this.inflight.set(key, request);
    try { return await request; } finally { this.inflight.delete(key); }
  }
  async load(q, country, key) {
    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({ term: q, country, entity: 'song', media: 'music', limit: '24', explicit: 'Yes' }).toString();
    let response, payload;
    try {
      response = await this.fetcher(url, { signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('upstream');
      payload = await response.json();
      if (!Array.isArray(payload.results)) throw new Error('shape');
    } catch { throw new AppError(502, 'CATALOG_UNAVAILABLE', 'Apple’s catalogue could not be reached. Try again in a moment.'); }
    const seen = new Set();
    const tracks = [];
    for (const row of payload.results) {
      if (row?.country !== COUNTRY_ALPHA3[country] || row.isStreamable === false) continue;
      if (row.kind !== 'song' || !Number.isSafeInteger(row.trackId) || !cleanText(row.trackName) || !cleanText(row.artistName) || seen.has(row.trackId)) continue;
      const link = safeUrl(row.trackViewUrl, ['apple.com']);
      if (!link || new URL(link).pathname.split('/')[1] !== country.toLowerCase()) continue;
      seen.add(row.trackId);
      // IDs refer only to trusted results retained by this server, never to an Alexa playback ID.
      const id = randomUUID();
      const track = { id, ...releaseYearMetadata(row.releaseDate), title: row.trackName, artist: row.artistName, album: cleanText(row.collectionName) ? row.collectionName : '', artwork: safeUrl(row.artworkUrl100, ['mzstatic.com']), url: link, durationMs: Number.isFinite(row.trackTimeMillis) ? row.trackTimeMillis : 0, explicit: row.trackExplicitness === 'explicit' };
      tracks.push(track);
      this.tracks.set(id, { track, artistId: Number.isSafeInteger(row.artistId) && row.artistId > 0 ? row.artistId : null, country, expires: this.clock() + 30 * 60_000 });
    }
    // Storefront consistency does not establish Apple Music subscription availability.
    const result = { tracks, source: 'itunes', country, availability: 'unverified' };
    this.cache.set(key, { result, expires: this.clock() + 5 * 60_000 });
    while (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
    for (const [id, entry] of this.tracks) if (entry.expires < this.clock()) this.tracks.delete(id);
    while (this.tracks.size > 1500) this.tracks.delete(this.tracks.keys().next().value);
    return result;
  }
  reserveCall() {
    const now = this.clock();
    this.calls = this.calls.filter(at => now - at < 60_000);
    if (this.calls.length >= 18) return false;
    this.calls.push(now);
    return true;
  }
  async prepareTrack(id, expectedCountry) {
    const track = this.getTrack(id);
    const { artistId, country } = this.tracks.get(id);
    if (expectedCountry !== undefined && !COUNTRIES.has(expectedCountry)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose one of the supported catalogue countries.');
    if (expectedCountry !== undefined && expectedCountry !== country) throw new AppError(409, 'COUNTRY_MISMATCH', 'These results are from another catalogue country. Search again for the selected country.');
    const requestArtist = await this.resolveArtist(artistId, country);
    // The displayed credits remain intact; only the spoken request uses the canonical artist.
    return { ...track, requestArtist: requestArtist || track.artist, requestArtists: requestArtist ? [requestArtist] : [] };
  }
  async resolveArtist(artistId, country) {
    if (!Number.isSafeInteger(artistId) || artistId < 1 || !COUNTRIES.has(country)) return null;
    const key = country + ':' + artistId;
    const saved = this.artistCache.get(key);
    if (saved && saved.expires > this.clock()) return saved.artist;
    this.artistCache.delete(key);
    if (this.artistInflight.has(key)) return this.artistInflight.get(key);
    // Artist enrichment is optional and shares the catalogue's upstream request budget.
    if (this.artistInflight.size >= 18 || !this.reserveCall()) return null;
    const request = this.loadArtist(artistId, country, key);
    this.artistInflight.set(key, request);
    try { return await request; } finally { this.artistInflight.delete(key); }
  }
  async loadArtist(artistId, country, key) {
    const url = new URL('https://itunes.apple.com/lookup');
    url.search = new URLSearchParams({ id: String(artistId), entity: 'musicArtist', country }).toString();
    let artist = null;
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('upstream');
      const payload = await response.json();
      if (!Array.isArray(payload.results)) throw new Error('shape');
      const row = payload.results.find(row => row?.wrapperType === 'artist' && row.artistId === artistId && cleanText(row.artistName) && row.artistName.trim());
      if (row) artist = row.artistName.replace(/\s+/gu, ' ').trim();
    } catch { /* A failed artist lookup must not prevent the original song request. */ }
    const now = this.clock();
    // Briefly cache unsuccessful lookups too, so a retry does not keep delaying playback.
    this.artistCache.set(key, { artist, expires: now + (artist ? 24 * 60 * 60_000 : 60_000) });
    for (const [id, entry] of this.artistCache) if (entry.expires <= now) this.artistCache.delete(id);
    while (this.artistCache.size > 256) this.artistCache.delete(this.artistCache.keys().next().value);
    return artist;
  }
  getTrack(id) {
    const entry = typeof id === 'string' && this.tracks.get(id);
    if (!entry || entry.expires < this.clock()) throw new AppError(400, 'EXPIRED_RESULT', 'Please search again, then select the song from the results.');
    return entry.track;
  }
}

export function buildMusicCommand(track, providerId = 'alexa-default') {
  const provider = resolveMusicProvider(providerId);
  if (!cleanText(track?.title) || !cleanText(track?.artist)) throw new AppError(400, 'INVALID_TRACK', 'This song cannot be requested.');
  let title = cleanSongTitle(track.title);
  const artist = (cleanText(track.requestArtist) ? track.requestArtist : track.artist).replace(/\s+/gu, ' ').trim();
  if (!title || !artist) throw new AppError(400, 'INVALID_TRACK', 'This song cannot be requested.');
  if (hasTaylorsVersion(track) && !hasTaylorsVersion({ title })) title += " (Taylor's Version)";
  const requestYear = normalizeReleaseYear(track.requestYear);
  if (requestYear !== null) title += ' ' + requestYear;
  return `play song ${title} by ${artist}${provider.commandName ? ` on ${provider.commandName}` : ''}`;
}
