import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TrackArtworkResolver } from '../library/track-artwork.mjs';
import { createLibrary } from '../library/index.mjs';
import { libraryRoute } from '../extension/library-protocol.mjs';

const ID = '2lo95sXI2RkrXLOYTXpZwe', ARTIST = '1YN9DIwQxOUnAzfgOWWiNR';
const COVER = 'https://image-cdn-ak.spotifycdn.com/image/album-cover';
const track = { title: 'Pesamale', artist: 'Siri Xander', source: 'spotify', country: 'IN', requestArtist: 'Siri Xander', requestArtists: ['Siri Xander'], url: 'https://open.spotify.com/track/' + ID, artwork: null };
const entity = { type: 'track', id: ID, uri: 'spotify:track:' + ID, title: track.title, artists: [{ name: track.artist, uri: 'spotify:artist:' + ARTIST }], visualIdentity: { image: [{ url: COVER }] } };
const html = value => '<script id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: { state: { data: { entity: value } } } } }) + '</script>';
const reply = value => new Response(html(value), { headers: { 'content-type': 'text/html' } });

test('public Spotify cover lookup works even when artist names are already resolved', async () => {
  const calls = [], resolver = new TrackArtworkResolver({ fetcher: async (url, options) => { calls.push({ url, options }); return reply(entity); } });
  assert.equal(await resolver.resolve(track, 'IN'), COVER);
  assert.equal(calls[0].url, 'https://open.spotify.com/embed/track/' + ID);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(Object.keys(calls[0].options.headers).some(key => /authorization|cookie/iu.test(key)), false);
  assert.equal(track.artwork, null);
});

test('cover lookup requires exact song and full artist resources and a trusted image host', async () => {
  for (const patch of [
    { id: 'x'.repeat(22) }, { uri: 'spotify:track:' + 'x'.repeat(22) }, { title: 'Different song' },
    { artists: [{ name: 'Wrong artist', uri: 'spotify:artist:' + ARTIST }] },
    { visualIdentity: { image: [{ url: 'https://example.test/cover.jpg' }] } },
  ]) assert.equal(await new TrackArtworkResolver({ fetcher: async () => reply({ ...entity, ...patch }) }).resolve(track, 'IN'), null);
});

test('whole band names are retained while credit separators may differ', async () => {
  const band = { ...track, artist: 'Earth, Wind & Fire, Guest Artist' };
  const row = { ...entity, artists: [{ name: 'Earth, Wind & Fire', uri: 'spotify:artist:' + ARTIST }, { name: 'Guest Artist', uri: 'spotify:artist:' + ARTIST }] };
  assert.equal(await new TrackArtworkResolver({ fetcher: async () => reply(row) }).resolve(band, 'IN'), COVER);
});

test('Apple saved covers use the selected country and parse iTunes JSON-labelled JavaScript responses', async () => {
  const calls = [], apple = { ...track, url: 'https://music.apple.com/in/album/song/123?i=456', artist: 'Siri Xander & Guest' };
  const resolver = new TrackArtworkResolver({ fetcher: async url => { calls.push(url); return new Response(JSON.stringify({ results: [{ kind: 'song', trackId: 456, trackName: apple.title, artistName: apple.artist, artworkUrl100: 'https://is1-ssl.mzstatic.com/image/cover.jpg' }] }), { headers: { 'content-type': 'text/javascript; charset=utf-8' } }); } });
  assert.equal(await resolver.resolve(apple, 'IN'), 'https://is1-ssl.mzstatic.com/image/cover.jpg');
  assert.equal(new URL(calls[0]).searchParams.get('country'), 'IN');
  assert.equal(await resolver.resolve({ ...apple, url: apple.url.replace('/in/', '/us/') }, 'IN'), null);
  assert.equal(calls.length, 1);
});

test('existing trusted artwork and validated YouTube video IDs need no metadata request', async () => {
  const resolver = new TrackArtworkResolver({ fetcher: async () => { throw new Error('unexpected fetch'); } });
  assert.equal(await resolver.resolve({ ...track, artwork: COVER }, 'IN'), COVER);
  assert.equal(await resolver.resolve({ ...track, url: 'https://music.youtube.com/watch?v=abcdefghijk' }, 'IN'), 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  for (const url of ['https://youtube.com.evil.test/watch?v=abcdefghijk', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/watch?v=abcdefghijk&v=bcdefghijkl', 'https://example.test/private']) assert.equal(await resolver.resolve({ ...track, url }, 'IN'), null);
});

test('successful and missing covers are cached and concurrent identical requests are deduplicated', async () => {
  let calls = 0, time = 1000;
  const resolver = new TrackArtworkResolver({ clock: () => time, fetcher: async () => { ++calls; return reply(entity); } });
  assert.deepEqual(await Promise.all([resolver.resolve(track, 'IN'), resolver.resolve(track, 'IN')]), [COVER, COVER]);
  assert.equal(await resolver.resolve(track, 'IN'), COVER); assert.equal(calls, 1);
  time += 24 * 60 * 60_000 + 1; await resolver.resolve(track, 'IN'); assert.equal(calls, 2);
  let misses = 0;
  const missing = new TrackArtworkResolver({ fetcher: async () => { ++misses; return reply({ ...entity, visualIdentity: {} }); } });
  assert.equal(await missing.resolve(track, 'IN'), null); assert.equal(await missing.resolve(track, 'IN'), null); assert.equal(misses, 1);
});

test('redirects and oversized metadata are ignored without fetching another destination', async () => {
  let calls = 0;
  const redirected = new TrackArtworkResolver({ fetcher: async () => { ++calls; return new Response(null, { status: 302, headers: { location: 'https://example.test' } }); } });
  assert.equal(await redirected.resolve(track, 'IN'), null); assert.equal(calls, 1);
  const oversized = new TrackArtworkResolver({ fetcher: async () => new Response('too large', { headers: { 'content-type': 'text/html', 'content-length': String(1024 * 1024 + 1) } }) });
  assert.equal(await oversized.resolve(track, 'IN'), null);
});

test('artwork requests reference only existing saved tracks and keep the library unchanged', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-artwork-api-')), seen = [];
  const bridge = { status: () => ({ settings: { country: 'IN' } }), requireDevice() {} };
  const library = createLibrary({ dataDir, bridge, artworkResolver: { async resolve(value, country) { seen.push({ value, country }); return COVER; } } });
  const playlist = library.localPlaylists.importTracks({ name: 'Saved', country: 'IN', tracks: [track] }), entry = playlist.tracks[0];
  const server = http.createServer(library.handle); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await library.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const route = '/api/local-playlists/' + playlist.id + '/tracks/' + entry.id + '/artwork';
  assert.equal(libraryRoute(route), route); assert.equal(libraryRoute(route, 'POST'), null);
  const base = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(base + route + '?url=https://example.test/private');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { entryId: entry.id, artwork: COVER });
  assert.equal(seen[0].value.url, track.url); assert.equal(seen[0].country, 'IN');
  assert.equal(library.localPlaylists.get(playlist.id).tracks[0].artwork, null);
  assert.equal((await fetch(base + route.replace(entry.id, 'missing'))).status, 404);
  assert.equal((await fetch(base + route, { headers: { origin: 'https://example.test' } })).status, 403);
  assert.equal(seen.length, 1);
});


test('saved Apple format placeholders are resolved before the browser requests the cover', async () => {
  const resolver = new TrackArtworkResolver({ fetcher: async () => { throw new Error('saved cover needs no lookup'); } });
  for (const suffix of ['{w}x{h}{c}.{f}', '300x300bb.%7Bf%7D']) {
    assert.equal(await resolver.resolve({ ...track, artwork: 'https://is1-ssl.mzstatic.com/image/cover.jpg/' + suffix }, 'IN'), 'https://is1-ssl.mzstatic.com/image/cover.jpg/300x300bb.jpg');
  }
});
