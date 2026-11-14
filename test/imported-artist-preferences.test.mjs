import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RequestArtistPreferences } from '../library/request-artists.mjs';
import { getMusicRequestCandidates } from '../library/music-matching.mjs';

const title = 'Veezha Veera (From "OM Chapter 1: Udhiram - The Blood Wood") [Tamil]';
const credits = ['Sai Abhyankkar', 'Tippu', 'Arun Srinivasan'];
const spotify = { title, artist: credits.join(', '), requestArtist: credits[0], requestArtists: credits, source: 'spotify', url: 'https://open.spotify.com/track/2ch1SJBrQ4Q4j6kGDJfbPz' };
const youtube = { ...spotify, source: 'youtube-music', url: 'https://music.youtube.com/watch?v=abcdefghijk' };
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-imported-artists-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, file: path.join(dataDir, 'request-artists.json'), prefs: new RequestArtistPreferences({ dataDir }) };
}

test('Spotify preference survives restart and canonical artist refresh while full credits remain intact', async t => {
  const f = await fixture(t); f.prefs.set(spotify, 'IN', 'Arun Srinivasan');
  const restarted = new RequestArtistPreferences({ dataDir: f.dataDir });
  const synced = { ...spotify, requestArtist: 'Tippu', requestArtists: [...credits] };
  const applied = restarted.apply(synced, 'IN');
  assert.equal(applied.requestArtist, 'Arun Srinivasan'); assert.equal(applied.artist, spotify.artist); assert.deepEqual(applied.requestArtists, credits);
  assert.equal(getMusicRequestCandidates(applied)[0].requestArtist, 'Arun Srinivasan');
  assert.equal(synced.requestArtist, 'Tippu', 'applying a preference must not mutate the saved source snapshot');
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
});

test('YouTube preference persists across supported video URL forms and a refreshed canonical artist', async t => {
  const f = await fixture(t); f.prefs.set(youtube, 'IN', 'Arun Srinivasan');
  const restarted = new RequestArtistPreferences({ dataDir: f.dataDir });
  for (const url of ['https://www.youtube.com/watch?v=abcdefghijk', 'https://youtube.com/watch?v=abcdefghijk', 'https://youtu.be/abcdefghijk']) {
    const applied = restarted.apply({ ...youtube, url, requestArtist: 'Tippu' }, 'IN');
    assert.equal(applied.requestArtist, 'Arun Srinivasan'); assert.equal(applied.artist, youtube.artist); assert.deepEqual(applied.requestArtists, credits);
  }
});

test('imported preferences remain fenced to source content ID, country, title and complete artist identity', async t => {
  const f = await fixture(t); f.prefs.set(spotify, 'IN', 'Arun Srinivasan');
  const cases = [
    [{ ...spotify, requestArtist: 'Tippu' }, 'US'],
    [{ ...spotify, title: 'Veezha Veera (Live)' }, 'IN'],
    [{ ...spotify, artist: 'A different complete artist credit' }, 'IN'],
    [{ ...spotify, url: 'https://open.spotify.com/track/3ch1SJBrQ4Q4j6kGDJfbPz' }, 'IN'],
    [youtube, 'IN'],
  ];
  for (const [track, country] of cases) assert.equal(f.prefs.apply(track, country).requestArtist, track.requestArtist);
  f.prefs.set(spotify, 'US', 'Tippu');
  const restarted = new RequestArtistPreferences({ dataDir: f.dataDir });
  assert.equal(restarted.apply(spotify, 'IN').requestArtist, 'Arun Srinivasan'); assert.equal(restarted.apply(spotify, 'US').requestArtist, 'Tippu');
});

test('legacy Apple preference records retain their key and primary-artist fence', async t => {
  const f = await fixture(t);
  const apple = { ...spotify, source: 'itunes', url: 'https://music.apple.com/in/album/veezha/123?i=456' };
  await fs.writeFile(f.file, JSON.stringify({ version: 1, entries: [{ country: 'IN', catalogId: '456', title: apple.title.toLowerCase(), artist: apple.artist.toLowerCase(), primary: apple.requestArtist.toLowerCase(), requestArtist: 'Arun Srinivasan' }] }), { mode: 0o600 });
  const restarted = new RequestArtistPreferences({ dataDir: f.dataDir });
  assert.equal(restarted.apply(apple, 'IN').requestArtist, 'Arun Srinivasan');
  assert.equal(restarted.apply({ ...apple, requestArtist: 'Tippu' }, 'IN').requestArtist, 'Tippu');
  restarted.set(apple, 'IN', 'Tippu');
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(saved.version, 1); assert.equal(saved.entries.length, 1); assert.equal(saved.entries[0].catalogId, '456'); assert.equal(Object.hasOwn(saved.entries[0], 'source'), false);
});

test('numeric Spotify IDs cannot collide with legacy Apple IDs', async t => {
  const f = await fixture(t), id = '1234567890123456789012';
  const spotifyNumeric = { ...spotify, url: 'https://open.spotify.com/track/' + id };
  const appleNumeric = { ...spotify, source: 'itunes', url: 'https://music.apple.com/in/album/track/1?i=' + id };
  f.prefs.set(spotifyNumeric, 'IN', 'Arun Srinivasan'); f.prefs.set(appleNumeric, 'IN', 'Tippu');
  const restarted = new RequestArtistPreferences({ dataDir: f.dataDir });
  assert.equal(restarted.apply(spotifyNumeric, 'IN').requestArtist, 'Arun Srinivasan'); assert.equal(restarted.apply(appleNumeric, 'IN').requestArtist, 'Tippu');
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(saved.entries.length, 2);
  assert.deepEqual(saved.entries.map(entry => entry.source || 'legacy-apple').sort(), ['legacy-apple', 'spotify']);
});

test('unsafe URLs and malformed source IDs cannot save or replace a valid preference', async t => {
  const f = await fixture(t); f.prefs.set(spotify, 'IN', 'Arun Srinivasan'); const before = await fs.readFile(f.file, 'utf8');
  for (const url of [
    'http://open.spotify.com/track/2ch1SJBrQ4Q4j6kGDJfbPz',
    'https://user:secret@open.spotify.com/track/2ch1SJBrQ4Q4j6kGDJfbPz',
    'https://open.spotify.com:4320/track/2ch1SJBrQ4Q4j6kGDJfbPz',
    'https://open.spotify.com.evil.example/track/2ch1SJBrQ4Q4j6kGDJfbPz',
    'https://open.spotify.com/track/short',
    'https://open.spotify.com/album/2ch1SJBrQ4Q4j6kGDJfbPz',
    'https://music.youtube.com/watch?v=abcdefghij',
    'https://music.youtube.com/watch?v=abcdefghijk&v=ABCDEFGHIJK',
    'https://youtu.be/abcdefghijk/extra',
    'https://music.apple.com/us/album/track/1?i=456',
  ]) assert.throws(() => f.prefs.set({ ...spotify, url }, 'IN', 'Tippu'), { code: 'INVALID_TRACK_IDENTITY' }, url);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.throws(() => f.prefs.set(spotify, 'XX', 'Tippu'), { code: 'INVALID_COUNTRY' });
});

test('source-tagged saved entries are validated and invalid imported IDs do not become active preferences', async t => {
  const f = await fixture(t); f.prefs.set(spotify, 'IN', 'Arun Srinivasan');
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8')), valid = saved.entries[0];
  saved.entries.push({ ...valid, source: 'unknown', requestArtist: 'Injected' }, { ...valid, catalogId: 'short', requestArtist: 'Injected' }, { ...valid, source: 'youtube-music', catalogId: valid.catalogId, requestArtist: 'Injected' });
  await fs.writeFile(f.file, JSON.stringify(saved));
  const restarted = new RequestArtistPreferences({ dataDir: f.dataDir });
  assert.equal(restarted.apply(spotify, 'IN').requestArtist, 'Arun Srinivasan'); assert.equal(restarted.entries.size, 1);
});

test('persisted imported preferences contain only validated content identity and sanitized artist text', async t => {
  const f = await fixture(t);
  f.prefs.set({ ...spotify, url: spotify.url + '?access_token=private-token#secret-fragment' }, 'IN', '  Arun   Srinivasan  ');
  const raw = await fs.readFile(f.file, 'utf8'), saved = JSON.parse(raw).entries[0];
  assert.equal(saved.source, 'spotify'); assert.equal(saved.catalogId, '2ch1SJBrQ4Q4j6kGDJfbPz'); assert.equal(saved.requestArtist, 'Arun Srinivasan');
  for (const absent of ['private-token', 'access_token', 'secret-fragment', 'open.spotify.com']) assert.equal(raw.includes(absent), false);
});
