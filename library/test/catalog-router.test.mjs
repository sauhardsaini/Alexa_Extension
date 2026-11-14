import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../catalog.mjs';
import { CatalogRouter } from '../catalog-router.mjs';

function fixture() {
  let configured = false, connected = false;
  let now = 1000;
  const calls = [];
  const publicTrack = { id: 'public-opaque-id', title: 'Baby', artist: 'Justin Bieber' };
  const appleTrack = { id: 'apple-opaque-id', title: 'Darmiyaan', artist: 'Rekha Bhardwaj' };
  const publicCatalog = {
    async search(query, country) { calls.push(['public-search', query, country]); return { tracks: [publicTrack], country, source: 'itunes' }; },
    async prepareTrack(id, country) { calls.push(['public-prepare', id, country]); return { ...publicTrack, requestArtist: publicTrack.artist }; },
    getTrack() { return publicTrack; },
  };
  const appleMusic = {
    status() { return { configured, connected }; },
    async search(query, country) { calls.push(['apple-search', query, country]); return { tracks: [appleTrack], country, source: 'apple-music', availability: 'catalogue-playable' }; },
    async prepareTrack(id, country) { calls.push(['apple-prepare', id, country]); return { ...appleTrack, requestArtist: appleTrack.artist }; },
    getTrack() { return appleTrack; },
  };
  const router = new CatalogRouter({ publicCatalog, appleMusic, clock: () => now });
  return { router, publicCatalog, appleMusic, calls, configure: value => { configured = value; if (!value) connected = false; }, connect: value => { connected = value; }, advance: ms => { now += ms; } };
}

test('search and play work through the public catalogue without an Apple Music connection', async () => {
  const f = fixture();
  const result = await f.router.search('Baby', 'IN');
  assert.equal(result.source, 'itunes');
  assert.equal(result.country, 'IN');
  assert.equal(result.availability, 'unverified');
  const track = await f.router.prepareTrack(result.tracks[0].id, 'IN');
  assert.equal(track.title, 'Baby');
  assert.deepEqual(f.calls.map(call => call[0]), ['public-search', 'public-prepare']);
});


test('app credentials alone never make Apple Music sign-in mandatory for public browsing', async () => {
  const f = fixture();
  f.configure(true);
  const result = await f.router.search('Baby', 'IN');
  assert.equal(result.source, 'itunes');
  assert.equal(result.availability, 'unverified');
  assert.equal((await f.router.prepareTrack(result.tracks[0].id, 'IN')).title, 'Baby');
  assert.deepEqual(f.calls.map(call => call[0]), ['public-search', 'public-prepare']);
});

test('connected Apple Music uses the official verified catalogue', async () => {
  const f = fixture();
  f.configure(true); f.connect(true);
  const result = await f.router.search('Darmiyaan', 'IN');
  assert.equal(result.source, 'apple-music');
  assert.equal(result.availability, 'catalogue-playable');
  assert.equal((await f.router.prepareTrack(result.tracks[0].id, 'IN')).title, 'Darmiyaan');
  assert.deepEqual(f.calls.map(call => call[0]), ['apple-search', 'apple-prepare']);
});

test('switching catalogue sources prevents a previous result being treated as Apple-verified', async () => {
  const f = fixture();
  const publicResult = await f.router.search('Baby', 'IN');
  f.configure(true); f.connect(true);
  await assert.rejects(f.router.prepareTrack(publicResult.tracks[0].id, 'IN'), { status: 409, code: 'CATALOGUE_CHANGED' });
  const officialResult = await f.router.search('Darmiyaan', 'IN');
  f.configure(false);
  await assert.rejects(f.router.prepareTrack(officialResult.tracks[0].id, 'IN'), { code: 'CATALOGUE_CHANGED' });
  assert.equal(f.calls.some(call => call[0].endsWith('prepare')), false);
});

test('a result is restricted to its original country', async () => {
  const f = fixture();
  const result = await f.router.search('Baby', 'IN');
  await assert.rejects(f.router.prepareTrack(result.tracks[0].id, 'US'), { status: 409, code: 'CATALOGUE_CHANGED' });
  await assert.rejects(f.router.search('Baby', 'ZZ'), { code: 'INVALID_COUNTRY' });
  assert.deepEqual(f.calls.map(call => call[0]), ['public-search']);
});

test('official authorization or availability failures never fall back to public unverified results', async () => {
  const f = fixture();
  f.configure(true); f.connect(true);
  f.appleMusic.search = async () => { throw new AppError(403, 'APPLE_AUTHORIZATION_REJECTED', 'Sign in again.'); };
  await assert.rejects(f.router.search('Darmiyaan', 'IN'), { status: 403, code: 'APPLE_AUTHORIZATION_REJECTED' });
  assert.equal(f.calls.length, 0);
});

test('forged and expired result identifiers cannot reach either provider', async () => {
  const f = fixture();
  await assert.rejects(f.router.prepareTrack('forged-id', 'IN'), { code: 'EXPIRED_RESULT' });
  assert.equal(f.calls.length, 0);
  const result = await f.router.search('Baby', 'IN');
  f.advance(30 * 60_000);
  await assert.rejects(f.router.prepareTrack(result.tracks[0].id, 'IN'), { code: 'EXPIRED_RESULT' });
  assert.deepEqual(f.calls.map(call => call[0]), ['public-search']);
});

test('a source change during search or playback cannot publish results with stale provenance', async () => {
  const f = fixture();
  let release;
  const original = f.publicCatalog.search;
  f.publicCatalog.search = (...args) => new Promise(resolve => { release = async () => resolve(await original(...args)); });
  const pending = f.router.search('Baby', 'IN');
  f.configure(true); f.connect(true);
  await release();
  await assert.rejects(pending, { code: 'CATALOGUE_CHANGED' });
  f.configure(false);
  f.publicCatalog.search = original;
  const result = await f.router.search('Baby', 'IN');
  f.publicCatalog.prepareTrack = () => new Promise(resolve => { release = () => resolve({ ...result.tracks[0] }); });
  const playing = f.router.prepareTrack(result.tracks[0].id, 'IN');
  f.configure(true); f.connect(true);
  release();
  await assert.rejects(playing, { code: 'CATALOGUE_CHANGED' });
});

test('an inconsistent provider response cannot acquire official availability labels', async () => {
  const f = fixture();
  f.configure(true); f.connect(true);
  f.appleMusic.search = async () => ({ source: 'itunes', country: 'IN', tracks: [{ id: 'mislabelled' }] });
  await assert.rejects(f.router.search('Baby', 'IN'), { code: 'CATALOGUE_UNAVAILABLE' });
  await assert.rejects(f.router.prepareTrack('mislabelled', 'IN'), { code: 'EXPIRED_RESULT' });
});

test('Spotify accounts without country-verified catalogue access keep public country search available', async () => {
  const f = fixture();
  f.router.spotify = { status: () => ({ connected: true, catalogReady: false }), search: () => { throw new Error('must not select country-unknown Spotify'); } };
  const result = await f.router.search('Baby', 'IN');
  assert.equal(result.source, 'itunes');
  assert.equal(result.country, 'IN');
});

test('Spotify-ready routing preserves availability labels and rejects stale source choices', async () => {
  const f = fixture();
  let connected = true;
  const track = { id: 'spotify-opaque', title: 'Baby', artist: 'Justin Bieber' };
  f.router.spotify = {
    status: () => ({ connected, catalogReady: connected }),
    search: async (query, country) => ({ tracks: [track], source: 'spotify', country, availability: 'unverified' }),
    getTrack: () => track, prepareTrack: async () => ({ ...track, requestArtist: track.artist }),
  };
  const result = await f.router.search('Baby', 'IN');
  assert.equal(result.source, 'spotify');
  assert.equal(result.availability, 'unverified');
  assert.equal((await f.router.prepareTrack(track.id, 'IN')).artist, 'Justin Bieber');
  connected = false;
  await assert.rejects(f.router.prepareTrack(track.id, 'IN'), { code: 'CATALOGUE_CHANGED' });
});
