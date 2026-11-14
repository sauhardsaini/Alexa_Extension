import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackReleaseYearResolver } from '../library/track-release-resolver.mjs';

const track = { title: 'Shake It Off', artist: 'Taylor Swift', requestArtist: 'Taylor Swift', album: '1989', durationMs: 219000 };
const song = { kind: 'song', country: 'IND', trackName: track.title, artistName: track.artist, collectionName: '1989', trackTimeMillis: track.durationMs,
  trackViewUrl: 'https://music.apple.com/in/album/1989/123?i=456', releaseDate: '2014-10-27T07:00:00Z' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = (rows = [song], type = 'application/json', options = {}) => new Response(JSON.stringify({ results: rows }), { headers: { 'content-type': type }, ...options });
function fixture(rows = [song], options = {}) {
  const calls = [];
  const resolver = new TrackReleaseYearResolver({ ...options, fetcher: async (url, request) => { calls.push({ url, request }); return reply(rows); } });
  return { resolver, calls };
}

test('year lookup requires matching selected recording and uses bounded anonymous country-aware song search', async () => {
  const f = fixture(), before = structuredClone(track);
  assert.equal(await f.resolver.resolve(track, 'IN'), 2014);
  assert.deepEqual(track, before);
  const { url, request } = f.calls[0], query = new URL(url);
  assert.equal(query.origin + query.pathname, 'https://itunes.apple.com/search');
  assert.deepEqual(Object.fromEntries(query.searchParams), { term: 'Shake It Off Taylor Swift', country: 'IN', entity: 'song', media: 'music', limit: '25', explicit: 'Yes' });
  assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'manual'); assert.equal(request.cache, 'no-store');
  assert.equal(Object.keys(request.headers).some(key => /cookie|authorization/i.test(key)), false);
});

test('known release year and invalid/aborted input do not initiate a lookup', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  assert.equal(await f.resolver.resolve({ ...track, releaseYear: 2014 }, 'IN'), 2014);
  for (const value of [null, {}, { ...track, title: '' }, { ...track, artist: 'bad\nartist' }]) assert.equal(await f.resolver.resolve(value, 'IN'), null);
  assert.equal(await f.resolver.resolve(track, 'XX'), null);
  assert.equal(await f.resolver.resolve(track, 'IN', { signal: controller.signal }), null);
  assert.equal(f.calls.length, 0);
});

test('wrong country, title, artist, version, duration and unsafe storefront rows cannot supply a year', async () => {
  for (const row of [
    { ...song, country: 'USA' }, { ...song, kind: 'music-video' }, { ...song, trackName: 'Another song' },
    { ...song, artistName: 'Taylor Swift tribute' }, { ...song, trackName: "Shake It Off (Taylor's Version)", collectionName: "1989 (Taylor's Version)", releaseDate: '2023-10-27' },
    { ...song, trackName: 'Shake It Off (Live)' }, { ...song, trackTimeMillis: 400000 },
    { ...song, trackViewUrl: 'https://music.apple.com/us/album/1989/123?i=456' },
    { ...song, trackViewUrl: 'https://music.apple.com.evil.test/in/album/1989/123?i=456' },
    { ...song, trackViewUrl: 'https://name:password@music.apple.com/in/album/1989/123?i=456' },
    { ...song, trackViewUrl: 'https://music.apple.com:444/in/album/1989/123?i=456' },
    { ...song, trackViewUrl: 'http://music.apple.com/in/album/1989/123?i=456' }, { ...song, isStreamable: false },
  ]) assert.equal(await fixture([row]).resolver.resolve(track, 'IN'), null, JSON.stringify(row));
});

test('matching rows must agree on a valid release year without missing-date ambiguity', async () => {
  assert.equal(await fixture([song, { ...song, releaseDate: '2014' }]).resolver.resolve(track, 'IN'), 2014);
  for (const rows of [[song, { ...song, releaseDate: '2020-01-01' }], [song, { ...song, releaseDate: undefined }], [{ ...song, releaseDate: '2014-02-30' }], [{ ...song, releaseDate: 'YouTube upload 2014' }], []]) {
    assert.equal(await fixture(rows).resolver.resolve(track, 'IN'), null);
  }
});

test('a selected rerecording matches edition evidence in the album and cannot assume an unlabelled edition', async () => {
  const selected = { ...track, title: "Shake It Off (Taylor's Version)", album: "1989 (Taylor's Version)" };
  const row = { ...song, collectionName: "1989 (Taylor's Version)", releaseDate: '2023-10-27' };
  assert.equal(await fixture([row]).resolver.resolve(selected, 'IN'), 2023);
  assert.equal(await fixture([row, { ...song, collectionName: undefined }]).resolver.resolve(selected, 'IN'), null);
});

test('successful and missing lookups have separate expiry caches and preserve recording identity in the key', async () => {
  let time = 1000;
  const success = fixture([song], { clock: () => time }), miss = fixture([], { clock: () => time });
  await success.resolver.resolve(track, 'IN'); await miss.resolver.resolve(track, 'IN');
  time += 5 * 60_000 + 1;
  assert.equal(await success.resolver.resolve(track, 'IN'), 2014); await miss.resolver.resolve(track, 'IN');
  assert.equal(success.calls.length, 1); assert.equal(miss.calls.length, 2);
  await success.resolver.resolve({ ...track, title: 'Shake It Off (Live)' }, 'IN'); assert.equal(success.calls.length, 2);
  time += 24 * 60 * 60_000;
  await success.resolver.resolve(track, 'IN'); assert.equal(success.calls.length, 3);
});

test('concurrent identical lookups share work and cancelling one subscriber leaves the other usable', async () => {
  const block = deferred(), calls = [], one = new AbortController();
  const resolver = new TrackReleaseYearResolver({ fetcher: async (url, options) => { calls.push(options); return block.promise; } });
  const first = resolver.resolve(track, 'IN', { signal: one.signal }), second = resolver.resolve(track, 'IN');
  assert.equal(calls.length, 1); one.abort(); assert.equal(await first, null); assert.equal(calls[0].signal.aborted, false);
  block.resolve(reply()); assert.equal(await second, 2014);
});

test('cancelling all subscribers aborts lookup and cannot cache its eventual response', async () => {
  const block = deferred(), calls = [], controller = new AbortController();
  const resolver = new TrackReleaseYearResolver({ fetcher: async (url, options) => { calls.push(options); return calls.length === 1 ? block.promise : reply(); } });
  const pending = resolver.resolve(track, 'IN', { signal: controller.signal }); controller.abort();
  assert.equal(await pending, null); assert.equal(calls[0].signal.aborted, true);
  block.resolve(reply()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await resolver.resolve(track, 'IN'), 2014); assert.equal(calls.length, 2);
});

test('at most four distinct source requests are active and the bounded cache retains 256 entries', async () => {
  const block = deferred(); let calls = 0;
  const resolver = new TrackReleaseYearResolver({ fetcher: async () => { calls++; return block.promise; } });
  const pending = Array.from({ length: 4 }, (_, index) => resolver.resolve({ ...track, title: 'Song ' + index }, 'IN'));
  assert.equal(await resolver.resolve({ ...track, title: 'Song fifth' }, 'IN'), null); assert.equal(calls, 4);
  block.resolve(reply([])); await Promise.all(pending);
  resolver.fetcher = async () => reply([]);
  for (let index = 0; index < 260; index++) await resolver.resolve({ ...track, title: 'Song ' + index }, 'IN');
  assert.equal(resolver.cache.size, 256);
});

test('JavaScript MIME is parsed only as JSON and malformed, redirected or oversized responses are ignored', async () => {
  for (const type of ['text/javascript; charset=utf-8', 'application/javascript; charset=utf-8']) {
    assert.equal(await new TrackReleaseYearResolver({ fetcher: async () => reply([song], type) }).resolve(track, 'IN'), 2014);
  }
  const responses = [
    new Response('globalThis.untrusted = true', { headers: { 'content-type': 'text/javascript' } }),
    reply([song], 'text/html'), reply([song], 'application/json', { status: 302 }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) } }),
    new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of responses) assert.equal(await new TrackReleaseYearResolver({ fetcher: async () => response }).resolve(track, 'IN'), null);
});
