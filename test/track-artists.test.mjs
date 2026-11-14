import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackArtistResolver } from '../library/track-artists.mjs';

const ID = '2lo95sXI2RkrXLOYTXpZwe';
const FIRST = '1YN9DIwQxOUnAzfgOWWiNR';
const SECOND = '3ktOCDucYtvRTm3UZosG93';
const PESAMALE = { id: 'saved-entry', source: 'spotify', title: 'Pesamale', artist: 'Siri Xander, Arra Aria Khayal', requestArtist: 'Siri Xander, Arra Aria Khayal', requestArtists: ['Siri Xander, Arra Aria Khayal'], url: 'https://open.spotify.com/track/' + ID, durationMs: 178124, country: 'IN', album: 'Pesamale', artwork: 'https://example.test/art.jpg' };
const ENTITY = { type: 'track', id: ID, uri: 'spotify:track:' + ID, title: 'Pesamale', duration: 178124, artists: [{ name: 'Siri Xander', uri: 'spotify:artist:' + FIRST }, { name: 'Arra Aria Khayal', uri: 'spotify:artist:' + SECOND }] };
const html = (entity = ENTITY) => '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } }) + '</script>';
const reply = (value, json = false, options = {}) => new Response(json ? JSON.stringify(value) : value, { status: 200, headers: { 'content-type': json ? 'application/json' : 'text/html' }, ...options });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const APPLE = { ...PESAMALE, source: 'apple-music', title: 'Collaboration', artist: 'First Artist & Second Artist', requestArtist: 'First Artist & Second Artist', requestArtists: [], url: 'https://music.apple.com/in/album/collaboration/123?i=456' };
const SONG = { kind: 'song', trackId: 456, trackName: APPLE.title, artistName: APPLE.artist, artistId: 789 };
const ARTIST = { wrapperType: 'artist', artistId: 789, artistName: 'First Artist' };
function spotifyFetcher(entity = ENTITY) {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return reply(html(entity)); };
  return { fetcher, calls };
}
function appleFetcher(song = SONG, artist = ARTIST) {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return reply({ results: [new URL(url).searchParams.get('entity') === 'song' ? song : artist] }, true); };
  return { fetcher, calls };
}

test('Pesamale uses separately identified Spotify artists without changing display or song identity', async () => {
  const f = spotifyFetcher(), resolver = new TrackArtistResolver(f);
  const original = structuredClone(PESAMALE), resolved = await resolver.resolve(PESAMALE, 'IN');
  assert.equal(resolved.requestArtist, 'Siri Xander');
  assert.deepEqual(resolved.requestArtists, ['Siri Xander', 'Arra Aria Khayal']);
  assert.deepEqual({ ...resolved, requestArtist: original.requestArtist, requestArtists: original.requestArtists }, original);
  assert.deepEqual(PESAMALE, original);
  assert.notEqual(resolved, PESAMALE);
  assert.equal(f.calls[0].url, 'https://open.spotify.com/embed/track/' + ID);
  assert.equal(f.calls[0].options.credentials, 'omit');
  assert.equal(f.calls[0].options.redirect, 'manual');
  assert.equal(f.calls[0].options.cache, 'no-store');
  assert.equal(Object.keys(f.calls[0].options.headers).some(name => /cookie|authorization/iu.test(name)), false);
});

test('different separators between complete Spotify resources are accepted while names stay intact', async () => {
  const entity = { ...ENTITY, title: 'Song', artists: [{ name: 'Earth, Wind & Fire', uri: 'spotify:artist:' + FIRST }, { name: 'Guest Artist', uri: 'spotify:artist:' + SECOND }] };
  for (const artist of ['Earth, Wind & Fire, Guest Artist', 'Earth, Wind & Fire & Guest Artist', 'Earth, Wind & Fire and Guest Artist']) {
    const track = { ...PESAMALE, title: 'Song', artist, requestArtist: artist, requestArtists: [artist] };
    const result = await new TrackArtistResolver(spotifyFetcher(entity)).resolve(track, 'IN');
    assert.equal(result.requestArtist, 'Earth, Wind & Fire');
    assert.deepEqual(result.requestArtists, ['Earth, Wind & Fire', 'Guest Artist']);
  }
});

test('a single band resource is preserved as a single artist', async () => {
  const entity = { ...ENTITY, title: 'September', artists: [{ name: 'Earth, Wind & Fire', uri: 'spotify:artist:' + FIRST }] };
  const track = { ...PESAMALE, title: 'September', artist: 'Earth, Wind & Fire', requestArtist: 'Earth, Wind & Fire', requestArtists: [] };
  const result = await new TrackArtistResolver(spotifyFetcher(entity)).resolve(track, 'IN');
  assert.equal(result.requestArtist, 'Earth, Wind & Fire');
  assert.deepEqual(result.requestArtists, ['Earth, Wind & Fire']);
});

test('good structured or canonical credits avoid public lookups', async () => {
  const f = spotifyFetcher(), resolver = new TrackArtistResolver(f);
  for (const track of [
    { ...PESAMALE, requestArtists: ['Siri Xander', 'Arra Aria Khayal'] },
    { ...PESAMALE, requestArtist: 'Siri Xander' },
    { ...PESAMALE, requestArtist: undefined, requestArtists: ['Siri Xander'] },
  ]) assert.deepEqual(await resolver.resolve(track, 'IN'), track);
  assert.equal(f.calls.length, 0);
});

test('unsupported or unsafe source URLs and countries never initiate a lookup', async () => {
  const f = spotifyFetcher(), resolver = new TrackArtistResolver(f);
  for (const url of [
    'http://open.spotify.com/track/' + ID,
    'https://open.spotify.com.evil.test/track/' + ID,
    'https://name:password@open.spotify.com/track/' + ID,
    'https://open.spotify.com:444/track/' + ID,
    'https://open.spotify.com/playlist/' + ID,
    'https://open.spotify.com/track/invalid',
    'https://music.apple.com/us/album/name/123?i=456',
    'https://music.apple.com/in/album/name/123',
    'https://music.apple.com/in/album/name/123?i=456&i=457',
    'https://music.apple.com/in/song/name/456?i=457',
  ]) assert.deepEqual(await resolver.resolve({ ...PESAMALE, url }, 'IN'), { ...PESAMALE, url });
  assert.deepEqual(await resolver.resolve(PESAMALE, 'XX'), PESAMALE);
  assert.equal(f.calls.length, 0);
});

test('wrong Spotify identity, title or full credits cannot replace the saved artists', async () => {
  for (const entity of [
    { ...ENTITY, type: 'album' },
    { ...ENTITY, id: 'x'.repeat(22) },
    { ...ENTITY, uri: 'spotify:track:' + 'x'.repeat(22) },
    { ...ENTITY, title: 'Pesamale (Live)' },
    { ...ENTITY, artists: [{ name: 'Siri', uri: 'spotify:artist:' + FIRST }, ENTITY.artists[1]] },
    { ...ENTITY, artists: [{ name: 'Other Artist', uri: 'spotify:artist:' + FIRST }, ENTITY.artists[1]] },
    { ...ENTITY, artists: [{ name: 'Siri Xander', uri: 'spotify:album:' + FIRST }, ENTITY.artists[1]] },
    { ...ENTITY, artists: [{ name: 'Siri Xander\nstop', uri: 'spotify:artist:' + FIRST }, ENTITY.artists[1]] },
  ]) assert.deepEqual(await new TrackArtistResolver(spotifyFetcher(entity)).resolve(PESAMALE, 'IN'), PESAMALE);
});

test('Apple same-country song identity resolves its canonical primary artist', async () => {
  const f = appleFetcher(), result = await new TrackArtistResolver(f).resolve(APPLE, 'IN');
  assert.equal(result.requestArtist, 'First Artist');
  assert.deepEqual(result.requestArtists, ['First Artist']);
  assert.deepEqual({ ...result, requestArtist: APPLE.requestArtist, requestArtists: APPLE.requestArtists }, APPLE);
  assert.deepEqual(f.calls.map(call => Object.fromEntries(new URL(call.url).searchParams)), [
    { id: '456', entity: 'song', country: 'IN' },
    { id: '789', entity: 'musicArtist', country: 'IN' },
  ]);
  for (const call of f.calls) {
    assert.equal(new URL(call.url).origin, 'https://itunes.apple.com');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'manual');
  }
});

test('Apple JSON lookups accept the live iTunes JavaScript content type without executing it', async () => {
  for (const type of ['text/javascript; charset=utf-8', 'application/javascript; charset=utf-8']) {
    const fetcher = async url => reply({ results: [new URL(url).searchParams.get('entity') === 'song' ? SONG : ARTIST] }, true, { headers: { 'content-type': type } });
    const result = await new TrackArtistResolver({ fetcher }).resolve(APPLE, 'IN');
    assert.equal(result.requestArtist, 'First Artist');
    assert.deepEqual(result.requestArtists, ['First Artist']);
  }
  const resolver = new TrackArtistResolver({ fetcher: async () => reply('window.untrustedCode = true;', false, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }) });
  assert.deepEqual(await resolver.resolve(APPLE, 'IN'), APPLE);
});

test('Apple song URLs also resolve without an album query', async () => {
  const f = appleFetcher(), track = { ...APPLE, url: 'https://music.apple.com/in/song/collaboration/456' };
  assert.equal((await new TrackArtistResolver(f).resolve(track, 'IN')).requestArtist, 'First Artist');
  assert.equal(f.calls.length, 2);
});

test('Apple mismatched song or artist identity cannot change saved credits', async () => {
  for (const [song, artist, expectedCalls] of [
    [{ ...SONG, kind: 'music-video' }, ARTIST, 1],
    [{ ...SONG, trackId: 457 }, ARTIST, 1],
    [{ ...SONG, trackName: 'Another Song' }, ARTIST, 1],
    [{ ...SONG, artistName: 'Other Artist' }, ARTIST, 1],
    [SONG, { ...ARTIST, artistId: 790 }, 2],
    [SONG, { ...ARTIST, wrapperType: 'collection' }, 2],
  ]) {
    const f = appleFetcher(song, artist);
    assert.deepEqual(await new TrackArtistResolver(f).resolve(APPLE, 'IN'), APPLE);
    assert.equal(f.calls.length, expectedCalls);
  }
});

test('redirects, unexpected final URLs, bad status and excessive responses fail optionally', async () => {
  for (const response of [
    new Response('', { status: 302, headers: { location: 'https://evil.test' } }),
    { ok: true, status: 200, url: 'https://evil.test', text: async () => html() },
    { ok: true, status: 200, redirected: true, text: async () => html() },
    new Response('', { status: 429 }),
    reply(html(), false, { headers: { 'content-type': 'text/html', 'content-length': '1048577' } }),
    reply('x'.repeat(1048577)),
    reply('not-json', true),
  ]) {
    const resolver = new TrackArtistResolver({ fetcher: async () => response });
    assert.deepEqual(await resolver.resolve(PESAMALE, 'IN'), PESAMALE);
  }
});

test('public metadata successes are cached per source identity, country, title and display artist', async () => {
  let now = 0;
  const f = spotifyFetcher(), resolver = new TrackArtistResolver({ ...f, clock: () => now });
  const first = await resolver.resolve(PESAMALE, 'IN');
  first.requestArtists.push('Do not leak');
  now = 299999;
  assert.deepEqual((await resolver.resolve(PESAMALE, 'IN')).requestArtists, ['Siri Xander', 'Arra Aria Khayal']);
  assert.equal(f.calls.length, 1);
  now = 300000;
  await resolver.resolve(PESAMALE, 'IN');
  assert.equal(f.calls.length, 2);
  await resolver.resolve(PESAMALE, 'US');
  await resolver.resolve({ ...PESAMALE, title: 'Other Song' }, 'IN');
  assert.equal(f.calls.length, 4);
});

test('missing or failed optional lookups are cached to avoid repeated delays', async () => {
  let calls = 0;
  const resolver = new TrackArtistResolver({ fetcher: async () => { calls++; throw new Error('Offline'); } });
  assert.deepEqual(await resolver.resolve(PESAMALE, 'IN'), PESAMALE);
  assert.deepEqual(await resolver.resolve(PESAMALE, 'IN'), PESAMALE);
  assert.equal(calls, 1);
});

test('concurrent preparations share one lookup and return independent artist arrays', async () => {
  const gate = deferred(); let calls = 0;
  const resolver = new TrackArtistResolver({ fetcher: async () => { calls++; await gate.promise; return reply(html()); } });
  const first = resolver.resolve(PESAMALE, 'IN'), second = resolver.resolve(PESAMALE, 'IN');
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0].requestArtists, ['Siri Xander', 'Arra Aria Khayal']);
  assert.notEqual(results[0].requestArtists, results[1].requestArtists);
});

test('pre-cancelled requests never fetch and cancelling the last waiter aborts without poisoning the cache', async () => {
  const gate = deferred(), signals = []; let calls = 0;
  const resolver = new TrackArtistResolver({ fetcher: async (_url, options) => { signals.push(options.signal); if (++calls === 1) await gate.promise; return reply(html()); } });
  const before = new AbortController(); before.abort();
  assert.deepEqual(await resolver.resolve(PESAMALE, 'IN', { signal: before.signal }), PESAMALE);
  assert.equal(calls, 0);
  const during = new AbortController(), pending = resolver.resolve(PESAMALE, 'IN', { signal: during.signal });
  during.abort();
  assert.deepEqual(await pending, PESAMALE);
  assert.equal(signals[0].aborted, true);
  assert.equal((await resolver.resolve(PESAMALE, 'IN')).requestArtist, 'Siri Xander');
  assert.equal(calls, 2);
  gate.resolve();
});

test('one cancelled waiter does not abort another preparation sharing its lookup', async () => {
  const gate = deferred(); let sharedSignal;
  const resolver = new TrackArtistResolver({ fetcher: async (_url, options) => { sharedSignal = options.signal; await gate.promise; return reply(html()); } });
  const controller = new AbortController();
  const first = resolver.resolve(PESAMALE, 'IN', { signal: controller.signal });
  const second = resolver.resolve(PESAMALE, 'IN');
  controller.abort();
  assert.deepEqual(await first, PESAMALE);
  assert.equal(sharedSignal.aborted, false);
  gate.resolve();
  assert.equal((await second).requestArtist, 'Siri Xander');
});

test('Apple canonical band names remain complete resources', async () => {
  const track = { ...APPLE, artist: 'Earth, Wind & Fire, Guest Artist', requestArtist: 'Earth, Wind & Fire, Guest Artist' };
  const f = appleFetcher({ ...SONG, artistName: track.artist }, { ...ARTIST, artistName: 'Earth, Wind & Fire' });
  const result = await new TrackArtistResolver(f).resolve(track, 'IN');
  assert.equal(result.requestArtist, 'Earth, Wind & Fire');
  assert.deepEqual(result.requestArtists, ['Earth, Wind & Fire']);
});

test('cached misses have bounded retention instead of growing for every inspected song', async () => {
  let calls = 0;
  const resolver = new TrackArtistResolver({ fetcher: async () => { calls++; return reply(html({ ...ENTITY, artists: [] })); } });
  for (let index = 0; index <= 256; index++) await resolver.resolve({ ...PESAMALE, title: 'Song ' + index }, 'IN');
  assert.equal(calls, 257);
  await resolver.resolve({ ...PESAMALE, title: 'Song 256' }, 'IN');
  assert.equal(calls, 257);
  await resolver.resolve({ ...PESAMALE, title: 'Song 0' }, 'IN');
  assert.equal(calls, 258);
});

test('the whole optional lookup finishes within its deadline even if a fetch ignores cancellation', { timeout: 11000 }, async () => {
  let signal;
  const resolver = new TrackArtistResolver({ fetcher: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.deepEqual(await resolver.resolve(PESAMALE, 'IN'), PESAMALE);
  assert.equal(signal.aborted, true);
});
