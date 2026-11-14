import { parsePlaylistLink, normalizePlaylistOrigin, safePlaylistAuthor } from './playlist-links.mjs';
import { safeTrackArtwork } from './track-artwork.mjs';

/** Read-only, bounded source metadata hydration for imported playlists saved before cover and author metadata were retained. */
export class PlaylistSourceResolver {
  constructor({ importer, clock = Date.now } = {}) { this.importer = importer; this.clock = clock; this.cache = new Map(); this.inflight = new Map(); }
  async resolve(playlist) {
    if (!playlist?.origin) return null;
    const origin = normalizePlaylistOrigin(playlist.origin);
    if (!origin.url || origin.artwork && origin.author || typeof this.importer !== 'function') return { ...origin, artwork: origin.artwork || null };
    const merge = metadata => ({ ...origin, artwork: metadata?.artwork || origin.artwork || null, ...(metadata?.author ? { author: metadata.author } : {}) });
    const link = parsePlaylistLink(origin.url, playlist.country);
    const key = JSON.stringify([link.url, playlist.country]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.clock()) return merge(cached);
    this.cache.delete(key);
    let pending = this.inflight.get(key);
    if (!pending) {
      if (this.inflight.size >= 4) return merge(null);
      let timer;
      pending = Promise.race([Promise.resolve().then(() => this.importer(link.url, playlist.country)), new Promise(resolve => { timer = setTimeout(() => resolve(null), 12000); })])
        .then(result => ({ artwork: safeTrackArtwork(result?.artwork), author: safePlaylistAuthor(result?.author) })).catch(() => ({ artwork: null, author: null })).then(metadata => {
          const now = this.clock();
          for (const [id, value] of this.cache) if (value.expires <= now) this.cache.delete(id);
          this.cache.set(key, { ...metadata, expires: now + (metadata.artwork && metadata.author ? 24 * 60 * 60_000 : 60_000) });
          while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
          return metadata;
        }).finally(() => { clearTimeout(timer); this.inflight.delete(key); });
      this.inflight.set(key, pending);
    }
    return merge(await pending);
  }
}
