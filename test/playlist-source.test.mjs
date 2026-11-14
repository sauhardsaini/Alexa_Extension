import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLibrary } from '../library/index.mjs';
import { PlaylistSourceResolver } from '../library/playlist-source.mjs';
import { AppError } from '../library/errors.mjs';
import { normalizePlaylistOrigin } from '../library/playlist-links.mjs';

const URL = 'https://open.spotify.com/playlist/1234567890123456789012';
const ART = 'https://i.scdn.co/image/playlist-cover';
const song = (title, id) => ({ title, artist: 'Artist', source: 'spotify', country: 'IN', url: 'https://open.spotify.com/track/' + String(id).padStart(22, '0') });
const source = (patch = {}) => ({ name: 'Original source name', author: 'Original curator', artwork: ART, source: 'spotify', tracks: [song('One', 1), song('Two', 2)], total: 2, skipped: 0, notes: [], ...patch });
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-playlist-source-'));
  let result = source(), failure = null, imports = 0;
  const importer = async () => { ++imports; if (failure) throw failure; return structuredClone(result); };
  const bridge = { status: () => ({ settings: { country: 'IN' } }), restore() {}, requireDevice() {} };
  const playback = { queue: Promise.resolve(), cancel() {} }, queue = { cancel() {} };
  const library = createLibrary({ dataDir, bridge, playback, queue, publicPlaylistImporter: importer, playlistSourceResolver: new PlaylistSourceResolver({ importer }) });
  const server = http.createServer(library.handleAuthenticated); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body) => { const response = await fetch('http://127.0.0.1:' + server.address().port + route, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
  const saved = library.localPlaylists.importTracks({ name: 'My renamed copy', country: 'IN', tracks: source().tracks, origin: { source: 'spotify', name: 'Original source name', url: URL, playbackName: 'Spoken list name' }, originUnchanged: true });
  const root = '/api/local-playlists/' + saved.id;
  t.after(async () => { await library.stop(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { library, dataDir, saved, root, request, set: value => { result = value; }, fail: error => { failure = error; }, imports: () => imports };
}

test('original playlist cover and name survive import, custom spoken name, local rename and restart', async t => {
  const f = await fixture(t);
  const preview = await f.request('/api/playlist-import/preview', { url: URL, country: 'IN' });
  const imported = await f.request('/api/local-playlists/import', { name: 'Local alias', country: 'IN', tracks: preview.body.tracks, previewId: preview.body.previewId, nativeName: 'Spoken override' });
  assert.equal(imported.status, 201);
  assert.equal(imported.body.playlist.origin.name, 'Original source name');
  assert.equal(imported.body.playlist.origin.playbackName, 'Spoken override');
  assert.equal(imported.body.playlist.origin.artwork, ART);
  assert.equal(imported.body.playlist.origin.author, 'Original curator');
  const renamed = f.library.localPlaylists.rename(imported.body.playlist.id, 'Another local name');
  assert.equal(renamed.origin.name, 'Original source name'); assert.equal(renamed.origin.author, 'Original curator');
  assert.equal(f.library.localPlaylists.list().find(p => p.id === renamed.id).artwork, ART);
  const raw = JSON.parse(await fs.readFile(path.join(f.dataDir, 'library', 'playlists.json'), 'utf8'));
  assert.equal(raw.playlists.find(p => p.id === renamed.id).origin.name, 'Original source name');
});

test('source hydration fills old imported covers without rewriting saved data or local/source names', async t => {
  const f = await fixture(t), file = path.join(f.dataDir, 'library', 'playlists.json'), before = await fs.readFile(file, 'utf8');
  const result = await f.request(f.root + '/source');
  assert.equal(result.status, 200); assert.equal(result.body.playlistId, f.saved.id); assert.equal(result.body.origin.name, 'Original source name'); assert.equal(result.body.artwork, ART); assert.equal(result.body.origin.author, 'Original curator');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await f.request(f.root + '/source'); assert.equal(f.imports(), 1);
});

test('sync previews latest songs without a mutation, then atomically applies source order and keeps local identity', async t => {
  const f = await fixture(t); f.set(source({ name: 'Latest source title', author: 'Latest curator', artwork: 'https://i.scdn.co/image/latest-cover', tracks: [song('Two', 2), song('Three', 3)] }));
  const preview = await f.request(f.root + '/sync-preview', {});
  assert.equal(preview.status, 200); assert.equal(preview.body.oldCount, 2); assert.equal(preview.body.newCount, 2); assert.equal(preview.body.added, 1); assert.equal(preview.body.removed, 1);
  assert.equal(preview.body.requiresPartialConfirmation, false); assert.equal(f.library.localPlaylists.get(f.saved.id).tracks[0].title, 'One');
  const applied = await f.request(f.root + '/sync', { previewId: preview.body.previewId, tracks: [song('Forged', 9)] });
  assert.equal(applied.status, 200); const playlist = applied.body.playlist;
  assert.equal(playlist.name, 'My renamed copy'); assert.equal(playlist.id, f.saved.id); assert.equal(playlist.origin.name, 'Latest source title'); assert.equal(playlist.origin.playbackName, 'Spoken list name');
  assert.equal(playlist.origin.author, 'Latest curator'); assert.equal(playlist.origin.artwork, 'https://i.scdn.co/image/latest-cover'); assert.deepEqual(playlist.tracks.map(t => t.title), ['Two', 'Three']); assert.equal(playlist.tracks[0].id, f.saved.tracks[1].id);
  const backups = await fs.readdir(path.join(f.dataDir, 'library', 'sync-backups')); assert.equal(backups.length, 1);
  const backup = JSON.parse(await fs.readFile(path.join(f.dataDir, 'library', 'sync-backups', backups[0]), 'utf8')); assert.equal(backup.playlist.tracks[0].title, 'One');
  assert.equal((await f.request(f.root + '/sync', { previewId: preview.body.previewId })).status, 409);
});

test('partial or unknown-total source previews require explicit acknowledgement before replacement', async t => {
  const f = await fixture(t); f.set(source({ tracks: [song('One', 1)], total: null, truncated: true }));
  const preview = await f.request(f.root + '/sync-preview', {}); assert.equal(preview.body.requiresPartialConfirmation, true); assert.match(preview.body.warnings.join(' '), /only the returned songs/);
  assert.equal((await f.request(f.root + '/sync', { previewId: preview.body.previewId })).status, 409); assert.equal(f.library.localPlaylists.get(f.saved.id).tracks.length, 2);
  const result = await f.request(f.root + '/sync', { previewId: preview.body.previewId, acceptPartial: true }); assert.equal(result.status, 200); assert.equal(result.body.playlist.tracks.length, 1); assert.equal(result.body.playlist.originUnchanged, false);
});

test('changed playlists and cross-playlist tokens cannot apply stale sync previews', async t => {
  const f = await fixture(t), preview = await f.request(f.root + '/sync-preview', {});
  const other = f.library.localPlaylists.importTracks({ name: 'Other', country: 'IN', tracks: source().tracks, origin: { source: 'spotify', name: 'Original', url: URL } });
  assert.equal((await f.request('/api/local-playlists/' + other.id + '/sync', { previewId: preview.body.previewId })).status, 409);
  f.library.localPlaylists.rename(f.saved.id, 'A new local name');
  const result = await f.request(f.root + '/sync', { previewId: preview.body.previewId }); assert.equal(result.status, 409); assert.equal(result.body.error, 'PLAYLIST_SYNC_CHANGED');
  await assert.rejects(fs.readdir(path.join(f.dataDir, 'library', 'sync-backups')), { code: 'ENOENT' });
});

test('unavailable sources and malformed previews leave the prior saved library unchanged', async t => {
  const f = await fixture(t), file = path.join(f.dataDir, 'library', 'playlists.json'), before = await fs.readFile(file, 'utf8');
  f.fail(new AppError(502, 'SOURCE_UNAVAILABLE', 'Source unavailable'));
  assert.equal((await f.request(f.root + '/sync-preview', {})).status, 502); assert.equal((await f.request(f.root + '/sync', { previewId: 'forged' })).status, 409);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('unsafe source images are discarded and complete source metadata needs no lookup', async () => {
  assert.equal(normalizePlaylistOrigin({ source: 'spotify', name: 'Name', url: URL, artwork: 'https://evil.test/image' }).artwork, null);
  let calls = 0; const resolver = new PlaylistSourceResolver({ importer: async () => { ++calls; return source(); } });
  const result = await resolver.resolve({ country: 'IN', origin: { source: 'spotify', name: 'Known', author: 'Known curator', url: URL, artwork: ART } }); assert.equal(result.artwork, ART); assert.equal(calls, 0);
});


test('failed sync backup prevents every saved playlist mutation', async t => {
  const f = await fixture(t), preview = await f.request(f.root + '/sync-preview', {});
  await fs.writeFile(path.join(f.dataDir, 'library', 'sync-backups'), 'blocked directory');
  const before = f.library.localPlaylists.get(f.saved.id), applied = await f.request(f.root + '/sync', { previewId: preview.body.previewId });
  assert.equal(applied.status, 500); assert.equal(applied.body.error, 'PLAYLIST_SYNC_BACKUP_FAILED');
  assert.deepEqual(f.library.localPlaylists.get(f.saved.id), before);
});
