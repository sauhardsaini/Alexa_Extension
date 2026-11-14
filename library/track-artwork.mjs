import { fetchTrackMetadata, sourceTrackIdentity, sameArtistCredits } from './track-artists.mjs';

const text = value => typeof value === 'string' && value.trim() && value.length <= 250 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
const keyText = value => text(value) ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase() : '';
const hosts = ['scdn.co', 'spotifycdn.com', 'mzstatic.com', 'ytimg.com', 'googleusercontent.com', 'ggpht.com', 'saavncdn.com', 'aiv-cdn.net', 'media-amazon.com', 'ssl-images-amazon.com'];
export function normalizeArtworkTemplate(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{w\}|%7bw%7d/giu, '300').replace(/\{h\}|%7bh%7d/giu, '300')
    .replace(/\{c\}|%7bc%7d/giu, 'bb').replace(/\{f\}|%7bf%7d/giu, 'jpg');
}
export function safeTrackArtwork(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(normalizeArtworkTemplate(value));
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : null;
  } catch { return null; }
}
function youtubeArtwork(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const id = ['youtube.com', 'www.youtube.com', 'music.youtube.com'].includes(url.hostname) && url.pathname === '/watch' && url.searchParams.getAll('v').length === 1 ? url.searchParams.get('v')
      : url.hostname === 'youtu.be' ? /^\/([A-Za-z0-9_-]{11})\/?$/u.exec(url.pathname)?.[1] : null;
    return /^[A-Za-z0-9_-]{11}$/u.test(id || '') ? 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' : null;
  } catch { return null; }
}

/** Loads covers only for an existing song's verified source identity. */
export class TrackArtworkResolver {
  constructor({ fetcher = fetch, clock = Date.now } = {}) {
    this.fetcher = fetcher; this.clock = clock; this.cache = new Map(); this.inflight = new Map();
  }
  async resolve(track, country) {
    const saved = safeTrackArtwork(track?.artwork);
    if (saved) return saved;
    if (!text(track?.title) || !text(track?.artist)) return null;
    const youtube = youtubeArtwork(track.url);
    if (youtube) return youtube;
    const identity = sourceTrackIdentity(track, country);
    if (!identity) return null;
    const key = JSON.stringify([identity.source, identity.id, country, keyText(track.title), keyText(track.artist)]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.clock()) return cached.artwork;
    this.cache.delete(key);
    if (this.inflight.has(key)) return this.inflight.get(key);
    // The page loads four at a time; enforce a server-side upper bound too.
    if (this.inflight.size >= 8) return null;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    const request = Promise.race([
      this.load(identity, track, country, controller.signal),
      new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true })),
    ]).catch(() => null).then(artwork => {
      const now = this.clock();
      for (const [id, value] of this.cache) if (value.expires <= now) this.cache.delete(id);
      this.cache.set(key, { artwork, expires: now + (artwork ? 24 * 60 * 60_000 : 5 * 60_000) });
      while (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value);
      return artwork;
    }).finally(() => { clearTimeout(timer); this.inflight.delete(key); });
    this.inflight.set(key, request);
    return request;
  }
  async load(identity, track, country, signal) {
    if (identity.source === 'spotify') {
      const html = await fetchTrackMetadata(this.fetcher, new URL('https://open.spotify.com/embed/track/' + identity.id), signal);
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)].filter(match => /\bid\s*=\s*(?:"__NEXT_DATA__"|'__NEXT_DATA__')/u.test(match[1]));
      if (scripts.length !== 1) return null;
      const entity = JSON.parse(scripts[0][2])?.props?.pageProps?.state?.data?.entity;
      if (entity?.type !== 'track' || entity.id !== identity.id || entity.uri !== 'spotify:track:' + identity.id || keyText(entity.title || entity.name) !== keyText(track.title) || !Array.isArray(entity.artists) || !entity.artists.length || entity.artists.length > 30) return null;
      if (entity.artists.some(artist => !text(artist?.name) || !/^spotify:artist:[A-Za-z0-9]{22}$/u.test(artist.uri || ''))) return null;
      if (!sameArtistCredits(track.artist, entity.artists.map(artist => artist.name))) return null;
      const images = entity.visualIdentity?.image || entity.images || [];
      return Array.isArray(images) ? images.map(image => safeTrackArtwork(image?.url)).find(Boolean) || null : null;
    }
    const url = new URL('https://itunes.apple.com/lookup');
    url.search = new URLSearchParams({ id: identity.id, entity: 'song', country }).toString();
    const data = JSON.parse(await fetchTrackMetadata(this.fetcher, url, signal, true));
    const songs = Array.isArray(data.results) ? data.results.filter(row => row?.kind === 'song' && String(row.trackId) === identity.id && keyText(row.trackName) === keyText(track.title) && keyText(row.artistName) === keyText(track.artist)) : [];
    return songs.length === 1 ? safeTrackArtwork(songs[0].artworkUrl600) || safeTrackArtwork(songs[0].artworkUrl100) || safeTrackArtwork(songs[0].artworkUrl60) : null;
  }
}
