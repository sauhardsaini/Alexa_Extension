import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LocalPlaylists } from '../local-playlists.mjs';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const track = { id: 'transient-search-id', title: 'Song (Live)', artist: 'Earth, Wind & Fire', album: 'Album', durationMs: 215000, country: 'IN', source: 'itunes', requestArtist: 'Earth, Wind & Fire', requestArtists: ['Earth, Wind & Fire'], artwork: 'https://is1-ssl.mzstatic.com/image.jpg?token=private', url: 'https://music.apple.com/in/album/song/123?i=456&token=private#private', accessToken: 'never-save' };
function fixture(t) { const dataDir = fs.mkdtempSync(path.join(ROOT, '.scratch-local-playlists-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true })); return { dataDir, store: new LocalPlaylists({ dataDir, clock: () => 1000 }) }; }

test('local playlists persist stable snapshots and duplicate entries without transient catalogue IDs or credentials', t => {
  const { dataDir, store } = fixture(t), list = store.create({ name: ' My songs ', country: 'IN' });
  store.add(list.id, track); const added = store.add(list.id, track);
  assert.equal(added.name, 'My songs'); assert.equal(added.title, 'My songs'); assert.equal(added.source, 'local'); assert.equal(added.itemCount, 2);
  assert.notEqual(added.tracks[0].id, added.tracks[1].id);
  assert.equal(added.tracks[0].requestArtist, 'Earth, Wind & Fire');
  assert.deepEqual(added.tracks[0].requestArtists, ['Earth, Wind & Fire']);
  const raw = fs.readFileSync(path.join(dataDir, 'playlists.json'), 'utf8');
  for (const secret of ['transient-search-id', 'never-save', 'private', 'accessToken']) assert.equal(raw.includes(secret), false);
  assert.equal(added.tracks[0].url, 'https://music.apple.com/in/album/song/123?i=456');
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(dataDir, 'playlists.json')).mode & 0o777, 0o600);
  assert.deepEqual(new LocalPlaylists({ dataDir }).get(list.id), added);
  added.tracks[0].title = 'Client mutation'; added.tracks[1].requestArtists.push('Injected');
  assert.equal(store.get(list.id).tracks[0].title, track.title); assert.deepEqual(store.get(list.id).tracks[1].requestArtists, track.requestArtists);
});

test('CRUD, ordering, entry removal and summaries remain independent of music accounts', t => {
  const { store } = fixture(t), list = store.create({ name: 'First', country: 'IN' });
  store.add(list.id, { ...track, title: 'One' }); let value = store.add(list.id, { ...track, title: 'Two' });
  const [first, second] = value.tracks;
  value = store.moveTrack(list.id, second.id, 'up'); assert.deepEqual(value.tracks.map(item => item.title), ['Two', 'One']);
  value = store.moveTrack(list.id, second.id, 'down'); assert.deepEqual(value.tracks.map(item => item.id), [first.id, second.id]);
  assert.deepEqual(store.moveTrack(list.id, first.id, 'up').tracks.map(item => item.id), [first.id, second.id]);
  assert.equal(store.rename(list.id, 'Renamed').name, 'Renamed');
  assert.equal(store.list()[0].itemCount, 2); assert.equal('tracks' in store.list()[0], false);
  store.removeTrack(list.id, first.id); assert.equal(store.getTrack(list.id, second.id).title, 'Two');
  assert.throws(() => store.getTrack(list.id, first.id), { code: 'LOCAL_TRACK_NOT_FOUND' });
  assert.deepEqual(store.delete(list.id), { deleted: true }); assert.deepEqual(store.list(), []);
  assert.throws(() => store.get(list.id), { code: 'LOCAL_PLAYLIST_NOT_FOUND' });
});

test('invalid names, countries and unsafe song metadata fail without changing saved playlists', t => {
  const { store } = fixture(t);
  for (const label of ['', 'x'.repeat(101), 'Name\ncommand', null]) assert.throws(() => store.create({ name: label, country: 'IN' }), { code: 'INVALID_PLAYLIST_NAME' });
  assert.throws(() => store.create({ name: 'Songs', country: 'ZZ' }), { code: 'INVALID_COUNTRY' });
  const list = store.create({ name: 'Songs', country: 'IN' });
  for (const patch of [{ title: '' }, { artist: 'bad\nartist' }, { country: 'US' }, { durationMs: -1 }, { source: 'arbitrary' }, { requestArtists: ['bad\u2028text'] }]) assert.throws(() => store.add(list.id, { ...track, ...patch }), { code: 'INVALID_LOCAL_TRACK' });
  assert.equal(store.get(list.id).itemCount, 0);
  assert.throws(() => store.moveTrack(list.id, 'unknown', 'sideways'), { code: 'INVALID_PLAYLIST_MOVE' });
});

test('unsafe or unrelated URLs are omitted and only supported content IDs remain in links', t => {
  const { store } = fixture(t), list = store.create({ name: 'Links', country: 'IN' });
  for (const value of ['javascript:alert(1)', 'https://user:secret@music.apple.com/in/song', 'https://evil.example/song']) {
    const saved = store.add(list.id, { ...track, url: value, artwork: value });
    assert.equal(saved.tracks.at(-1).url, null); assert.equal(saved.tracks.at(-1).artwork, null);
  }
  const saved = store.add(list.id, { ...track, source: 'youtube-music', url: 'https://www.youtube.com/watch?v=abcdefghijk&access_token=secret', artwork: null });
  assert.equal(saved.tracks.at(-1).url, 'https://www.youtube.com/watch?v=abcdefghijk');
});

test('playlist and entry count limits reject additions without overwriting valid data', t => {
  const { dataDir } = fixture(t), file = path.join(dataDir, 'playlists.json');
  const entries = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(), name: 'List ' + index, country: 'IN', createdAt: 1, updatedAt: 1, tracks: index ? [] : Array.from({ length: 500 }, () => ({ ...track, id: randomUUID() })) }));
  fs.writeFileSync(file, JSON.stringify({ version: 1, playlists: entries }));
  const store = new LocalPlaylists({ dataDir });
  assert.throws(() => store.create({ name: 'Extra', country: 'IN' }), { code: 'LOCAL_PLAYLIST_LIMIT' });
  assert.throws(() => store.add(entries[0].id, track), { code: 'LOCAL_PLAYLIST_FULL' });
  assert.equal(store.list().length, 100); assert.equal(store.get(entries[0].id).itemCount, 500);
});

test('corrupt storage is preserved and never silently replaced by an empty library', t => {
  const { dataDir } = fixture(t), file = path.join(dataDir, 'playlists.json');
  fs.writeFileSync(file, '{broken saved playlists'); const store = new LocalPlaylists({ dataDir });
  assert.throws(() => store.list(), { code: 'LOCAL_PLAYLISTS_UNREADABLE' });
  assert.throws(() => store.create({ name: 'New', country: 'IN' }), { code: 'LOCAL_PLAYLISTS_UNREADABLE' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken saved playlists');
});

test('failed atomic saves do not commit an in-memory mutation or disclose filesystem details', t => {
  const { dataDir, store } = fixture(t), list = store.create({ name: 'Kept', country: 'IN' });
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.throws(() => store.rename(list.id, 'Lost'), error => error.code === 'LOCAL_PLAYLIST_SAVE_FAILED' && !error.message.includes(dataDir));
  assert.equal(store.get(list.id).name, 'Kept');
});


test('saved Apple artwork with an unresolved encoded format is exposed as a usable JPEG URL', t => {
  const c = fixture(t), playlist = c.store.create({ name: 'Artwork', country: 'IN' });
  const saved = c.store.add(playlist.id, { ...track, artwork: 'https://is1-ssl.mzstatic.com/image/cover.jpg/300x300bb.%7Bf%7D' });
  assert.equal(saved.tracks[0].artwork, 'https://is1-ssl.mzstatic.com/image/cover.jpg/300x300bb.jpg');
  const restored = new LocalPlaylists({ dataDir: c.dataDir });
  assert.equal(restored.get(playlist.id).tracks[0].artwork, saved.tracks[0].artwork);
});
