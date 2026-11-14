import { AppError, COUNTRIES } from './catalog.mjs';

const changed = () => new AppError(409, 'CATALOGUE_CHANGED', 'The catalogue connection changed. Search again, then choose a song from the new results.');
const expired = () => new AppError(400, 'EXPIRED_RESULT', 'Please search again, then select a song from the results.');
const unavailable = () => new AppError(502, 'CATALOGUE_UNAVAILABLE', 'The music catalogue could not return verified results. Please try again.');

export class CatalogRouter {
  constructor({ publicCatalog, appleMusic, spotify = null, clock = Date.now } = {}) {
    if (!publicCatalog || !appleMusic) throw new Error('Both music catalogues are required');
    this.publicCatalog = publicCatalog;
    this.appleMusic = appleMusic;
    this.spotify = spotify;
    this.clock = clock;
    this.entries = new Map();
  }
  selection() {
    return this.appleMusic.status().connected
      ? { source: 'apple-music', provider: this.appleMusic, availability: 'catalogue-playable' }
      : this.spotify?.status().catalogReady
        ? { source: 'spotify', provider: this.spotify, availability: null }
        : { source: 'itunes', provider: this.publicCatalog, availability: 'unverified' };
  }
  requireCountry(country) {
    if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose one of the supported catalogue countries.');
  }
  async search(query, country = 'IN') {
    this.requireCountry(country);
    const selected = this.selection();
    // An active official connection must surface its own errors. A public fallback
    // here would mislabel results after a failed Apple availability check.
    const result = await selected.provider.search(query, country);
    if (this.selection().source !== selected.source) throw changed();
    if (!result || !Array.isArray(result.tracks) || result.country !== country || result.source !== selected.source || (selected.source === 'apple-music' && result.availability !== 'catalogue-playable') || (selected.source === 'spotify' && !['catalogue-playable', 'unverified'].includes(result.availability))) throw unavailable();
    const now = this.clock();
    for (const [id, entry] of this.entries) if (entry.expires <= now) this.entries.delete(id);
    const tracks = [];
    for (const track of result.tracks) {
      if (!track || typeof track.id !== 'string' || !track.id || track.id.length > 200) continue;
      tracks.push({ ...track });
      // Only server-returned IDs are remembered; request bodies cannot choose a source.
      this.entries.set(track.id, { source: selected.source, country, provider: selected.provider, expires: now + 30 * 60_000 });
    }
    while (this.entries.size > 1500) this.entries.delete(this.entries.keys().next().value);
    return { ...result, tracks, source: selected.source, country, availability: selected.availability || result.availability };
  }
  entry(id, country) {
    this.requireCountry(country);
    const entry = typeof id === 'string' && this.entries.get(id);
    if (!entry || entry.expires <= this.clock()) {
      if (entry) this.entries.delete(id);
      throw expired();
    }
    if (entry.country !== country || entry.source !== this.selection().source) throw changed();
    return entry;
  }
  async prepareTrack(id, country = 'IN') {
    const entry = this.entry(id, country);
    const track = await entry.provider.prepareTrack(id, country);
    if (this.selection().source !== entry.source) throw changed();
    if (!track || track.id !== id) throw unavailable();
    return { ...track };
  }
  getTrack(id, country) {
    const known = typeof id === 'string' && this.entries.get(id);
    const entry = this.entry(id, country ?? known?.country ?? 'IN');
    const track = entry.provider.getTrack(id);
    if (!track || track.id !== id) throw unavailable();
    return { ...track };
  }
}
