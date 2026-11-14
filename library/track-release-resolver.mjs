import { COUNTRIES } from './catalog.mjs';
import { comparePlayback } from './music-matching.mjs';
import { normalizeReleaseYear, releaseYearFromDate } from './track-release.mjs';
import { fetchTrackMetadata } from './track-artists.mjs';

const COUNTRY_ALPHA3 = Object.freeze({ IN: 'IND', US: 'USA', GB: 'GBR', DE: 'DEU', CA: 'CAN', AU: 'AUS', JP: 'JPN' });
const TIMEOUT_MS = 8000;
const CACHE_LIMIT = 256;
const MAX_INFLIGHT = 4;
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 250 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
const clean = value => value.replace(/\s+/gu, ' ').trim();
const keyText = value => text(value) ? clean(value.normalize('NFKC')).toLowerCase() : '';
const duration = value => Number.isFinite(value) && value > 0 && value <= 86400000 ? value : 0;

function safeStorefront(value, country) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['music.apple.com', 'itunes.apple.com'].includes(url.hostname)
      && url.pathname.split('/')[1] === country.toLowerCase();
  } catch { return false; }
}
function trackKey(track, country) {
  return JSON.stringify([country, keyText(track.title), keyText(track.artist), keyText(track.requestArtist), keyText(track.album), duration(track.durationMs),
    (Array.isArray(track.requestArtists) ? track.requestArtists.slice(0, 30) : []).map(keyText)]);
}

/** Anonymous, optional year lookup for a selected recording whose source omitted its release date. */
export class TrackReleaseYearResolver {
  constructor({ fetcher = fetch, clock = Date.now } = {}) {
    this.fetcher = fetcher;
    this.clock = clock;
    this.cache = new Map();
    this.inflight = new Map();
    this.activeRequests = 0;
  }
  async resolve(track, country, { signal } = {}) {
    if (signal?.aborted || !COUNTRIES.has(country) || !text(track?.title) || !text(track?.artist)) return null;
    const known = normalizeReleaseYear(track.releaseYear);
    if (known !== null) return known;
    const selected = { ...track, ...(Array.isArray(track.requestArtists) ? { requestArtists: [...track.requestArtists] } : {}) };
    const key = trackKey(selected, country), cached = this.cache.get(key);
    if (cached && cached.expires > this.clock()) return cached.year;
    this.cache.delete(key);
    let entry = this.inflight.get(key);
    if (!entry || entry.cancelled) {
      if (this.activeRequests >= MAX_INFLIGHT) return null;
      entry = { controller: new AbortController(), subscribers: new Set(), settled: false, cancelled: false };
      ++this.activeRequests;
      this.inflight.set(key, entry);
      const timer = setTimeout(() => entry.controller.abort(new Error('Release year lookup timed out')), TIMEOUT_MS);
      entry.promise = this.load(selected, country, entry.controller.signal).catch(() => null).then(year => {
        entry.settled = true;
        if (!entry.cancelled) {
          const now = this.clock();
          for (const [id, value] of this.cache) if (value.expires <= now) this.cache.delete(id);
          this.cache.set(key, { year, expires: now + (year === null ? 5 * 60_000 : 24 * 60 * 60_000) });
          while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
        }
        return year;
      }).finally(() => {
        clearTimeout(timer);
        --this.activeRequests;
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      });
    }
    return this.subscribe(entry, signal);
  }
  subscribe(entry, signal) {
    const subscriber = {};
    entry.subscribers.add(subscriber);
    return new Promise(resolve => {
      let finished = false;
      const finish = year => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', aborted);
        entry.subscribers.delete(subscriber);
        resolve(signal?.aborted ? null : year);
      };
      const aborted = () => {
        finish(null);
        if (!entry.settled && entry.subscribers.size === 0) {
          entry.cancelled = true;
          entry.controller.abort(new Error('Release year lookup cancelled'));
        }
      };
      if (signal?.aborted) return aborted();
      signal?.addEventListener('abort', aborted, { once: true });
      entry.promise.then(finish);
    });
  }
  async load(track, country, signal) {
    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({ term: clean(track.title) + ' ' + clean(track.artist), country, entity: 'song', media: 'music', limit: '25', explicit: 'Yes' }).toString();
    // The shared reader bounds the response to 1 MiB, rejects redirects, and
    // parses JavaScript-labelled iTunes responses as JSON without execution.
    const payload = JSON.parse(await fetchTrackMetadata(this.fetcher, url, signal, true));
    if (!Array.isArray(payload.results) || payload.results.length > 1000) return null;
    const years = new Set();
    let uncertain = false;
    for (const row of payload.results) {
      if (row?.kind !== 'song' || row.country !== COUNTRY_ALPHA3[country] || row.isStreamable === false
        || !text(row.trackName) || !text(row.artistName) || !safeStorefront(row.trackViewUrl, country)) continue;
      const player = { state: 'PLAYING', title: row.trackName, artist: row.artistName,
        album: text(row.collectionName) ? row.collectionName : '', durationMs: duration(row.trackTimeMillis) };
      const result = comparePlayback(track, player);
      if (result.verdict === 'unknown') { uncertain = true; continue; }
      if (result.verdict !== 'match') continue;
      const year = releaseYearFromDate(row.releaseDate);
      if (year === null) uncertain = true;
      else years.add(year);
      if (years.size > 1) return null;
    }
    return !signal.aborted && !uncertain && years.size === 1 ? [...years][0] : null;
  }
}
