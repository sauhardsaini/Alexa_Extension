import { COUNTRIES } from './catalog.mjs';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8000;
const CACHE_MS = 5 * 60_000;
const CACHE_LIMIT = 256;
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 250 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
const keyText = value => text(value) ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase() : null;
const clean = value => value.replace(/\s+/gu, ' ').trim();
const copyTrack = track => ({ ...track, ...(Array.isArray(track?.requestArtists) ? { requestArtists: [...track.requestArtists] } : {}) });
const numericId = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && /^[1-9]\d{0,29}$/u.test(value) ? value : null;
const sameText = (left, right) => keyText(left) !== null && keyText(left) === keyText(right);
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Separators are flexible only between entire artist resources. A comma or an
// ampersand inside a resource name remains part of that artist or band's name.
function sameCredits(display, artists) {
  if (!text(display) || !artists.length || artists.some(artist => !text(artist))) return false;
  const separator = '(?:\\s*[,;&]\\s*|\\s+(?:and|feat\\.?|ft\\.?|featuring)\\s+)+';
  const pattern = artists.map(artist => escapePattern(keyText(artist))).join(separator);
  return new RegExp('^' + pattern + '$', 'u').test(keyText(display));
}
function needsArtists(track) {
  if (!text(track?.title) || !text(track?.artist)) return false;
  if (text(track.requestArtist) && !sameText(track.requestArtist, track.artist)) return false;
  if (track.requestArtists !== undefined && !Array.isArray(track.requestArtists)) return false;
  const artists = track.requestArtists || [];
  return artists.length === 0 || artists.length === 1 && sameText(artists[0], track.artist);
}
function sourceIdentity(track, country) {
  if (!COUNTRIES.has(country) || typeof track?.url !== 'string' || track.url.length > 4096) return null;
  try {
    const url = new URL(track.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'open.spotify.com') {
      const id = /^\/track\/([A-Za-z0-9]{22})\/?$/u.exec(url.pathname)?.[1];
      return id ? { source: 'spotify', id } : null;
    }
    if (url.hostname !== 'music.apple.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== country.toLowerCase()) return null;
    if (parts[1] === 'album') {
      const ids = url.searchParams.getAll('i');
      return ids.length === 1 && numericId(ids[0]) ? { source: 'apple-music', id: ids[0] } : null;
    }
    if (parts[1] === 'song') {
      const id = numericId(parts.at(-1));
      if (!id || url.searchParams.has('i')) return null;
      return { source: 'apple-music', id };
    }
  } catch { /* Unsupported or malformed links cannot initiate a request. */ }
  return null;
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Cancelled'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new Error('Cancelled'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
async function responseText(response, signal, json) {
  const type = response.headers?.get?.('content-type');
  if (type && !(json ? /^(?:application\/(?:json|javascript)|text\/javascript)(?:;|$)/iu : /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu).test(type)) throw new Error('Unexpected response');
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/u.test(length) && Number(length) > MAX_BYTES) throw new Error('Response too large');
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, value = '';
    try {
      while (true) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) throw new Error('Response too large');
        value += decoder.decode(part.value, { stream: true });
      }
      return value + decoder.decode();
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock?.(); }
  }
  const value = await abortable(response.text(), signal);
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw new Error('Response too large');
  return value;
}

/** Optional public metadata enrichment. Display credits and song identity stay intact. */
export class TrackArtistResolver {
  constructor({ fetcher = fetch, clock = Date.now } = {}) {
    this.fetcher = fetcher;
    this.clock = clock;
    this.cache = new Map();
    this.inflight = new Map();
  }
  async resolve(track, country, { signal } = {}) {
    const copy = copyTrack(track);
    if (signal?.aborted || !needsArtists(track)) return copy;
    const identity = sourceIdentity(track, country);
    if (!identity) return copy;
    const key = JSON.stringify([identity.source, identity.id, country, keyText(track.title), keyText(track.artist)]);
    const saved = this.cache.get(key);
    if (saved && saved.expires > this.clock()) return this.apply(copy, saved.artists);
    this.cache.delete(key);
    let entry = this.inflight.get(key);
    if (!entry || entry.cancelled) {
      entry = { controller: new AbortController(), subscribers: new Set(), settled: false, cancelled: false };
      this.inflight.set(key, entry);
      const timer = setTimeout(() => entry.controller.abort(new Error('Metadata lookup timed out')), TIMEOUT_MS);
      entry.promise = abortable(this.load(identity, track, country, entry.controller.signal), entry.controller.signal)
        .catch(() => null)
        .then(artists => {
          entry.settled = true;
          if (!entry.cancelled) {
            const now = this.clock();
            for (const [cachedKey, value] of this.cache) if (value.expires <= now) this.cache.delete(cachedKey);
            this.cache.set(key, { artists, expires: now + CACHE_MS });
            while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
          }
          return artists;
        }).finally(() => {
          clearTimeout(timer);
          if (this.inflight.get(key) === entry) this.inflight.delete(key);
        });
    }
    const artists = await this.subscribe(entry, signal);
    return signal?.aborted ? copy : this.apply(copy, artists);
  }
  apply(track, artists) {
    return artists?.length ? { ...track, requestArtist: artists[0], requestArtists: [...artists] } : track;
  }
  subscribe(entry, signal) {
    const subscriber = {};
    entry.subscribers.add(subscriber);
    return new Promise(resolve => {
      let finished = false;
      const finish = artists => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', aborted);
        entry.subscribers.delete(subscriber);
        resolve(artists);
      };
      const aborted = () => {
        finish(null);
        if (!entry.settled && entry.subscribers.size === 0) {
          entry.cancelled = true;
          entry.controller.abort(new Error('Metadata lookup cancelled'));
        }
      };
      if (signal?.aborted) return aborted();
      signal?.addEventListener('abort', aborted, { once: true });
      entry.promise.then(finish);
    });
  }
  async fetchText(url, signal, json = false) { return fetchTrackMetadata(this.fetcher, url, signal, json); }
  async load(identity, track, country, signal) {
    if (identity.source === 'spotify') {
      const html = await this.fetchText(new URL('https://open.spotify.com/embed/track/' + identity.id), signal);
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)].filter(match => /\bid\s*=\s*(?:"__NEXT_DATA__"|'__NEXT_DATA__')/u.test(match[1]));
      if (scripts.length !== 1) return null;
      const entity = JSON.parse(scripts[0][2])?.props?.pageProps?.state?.data?.entity;
      if (entity?.type !== 'track' || entity.id !== identity.id || entity.uri !== 'spotify:track:' + identity.id || !sameText(entity.title || entity.name, track.title) || !Array.isArray(entity.artists) || !entity.artists.length || entity.artists.length > 30) return null;
      if (entity.artists.some(artist => !text(artist?.name) || !/^spotify:artist:[A-Za-z0-9]{22}$/u.test(artist.uri || ''))) return null;
      const artists = [...new Set(entity.artists.map(artist => clean(artist.name)))];
      return sameCredits(track.artist, artists) ? artists : null;
    }
    const songUrl = new URL('https://itunes.apple.com/lookup');
    songUrl.search = new URLSearchParams({ id: identity.id, entity: 'song', country }).toString();
    const payload = JSON.parse(await this.fetchText(songUrl, signal, true));
    const songs = Array.isArray(payload.results) ? payload.results.filter(row => row?.kind === 'song' && numericId(row.trackId) === identity.id) : [];
    if (songs.length !== 1 || !sameText(songs[0].trackName, track.title) || !sameText(songs[0].artistName, track.artist)) return null;
    const artistId = numericId(songs[0].artistId);
    if (!artistId) return null;
    const artistUrl = new URL('https://itunes.apple.com/lookup');
    artistUrl.search = new URLSearchParams({ id: artistId, entity: 'musicArtist', country }).toString();
    const artists = JSON.parse(await this.fetchText(artistUrl, signal, true));
    const rows = Array.isArray(artists.results) ? artists.results.filter(row => row?.wrapperType === 'artist' && numericId(row.artistId) === artistId && text(row.artistName)) : [];
    return rows.length === 1 ? [clean(rows[0].artistName)] : null;
  }
}

export async function fetchTrackMetadata(fetcher, url, signal, json = false) {
  const response = await abortable(fetcher(url.href, {
    redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
    headers: { accept: json ? 'application/json' : 'text/html' },
  }), signal);
  if (!response?.ok || response.status >= 300 || response.redirected || response.url && response.url !== url.href) throw new Error('Metadata unavailable');
  return responseText(response, signal, json);
}

export { sourceIdentity as sourceTrackIdentity, sameCredits as sameArtistCredits };
