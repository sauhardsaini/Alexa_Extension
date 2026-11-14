import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLibrary } from '../library/index.mjs';
import { AppError } from '../library/catalog.mjs';
// The current web application's focused engine regressions also run against
// the actual copied engine used by this extension, not its old tab follower.
import '../library/test/music-matching.test.mjs';
import '../library/test/native-music-request.test.mjs';
import '../library/test/mutable-queue.test.mjs';
import '../library/test/playback.test.mjs';
import '../library/test/local-playlists.test.mjs';
import '../library/test/playlist-queue.test.mjs';
import '../library/test/public-country.test.mjs';
import '../library/test/catalog-router.test.mjs';

const device = 'echo-1';
const song = { title: 'Mahiya', artist: 'Pritam, Annie & Suzanne Dmello', source: 'apple-music', country: 'IN', durationMs: 264000, album: 'Awarapan' };
const row = { country: 'IND', kind: 'song', trackId: 1, trackName: song.title, artistName: song.artist, collectionName: song.album, trackViewUrl: 'https://music.apple.com/in/album/aw arapan/123?i=1'.replace(' ',''), artworkUrl100: 'https://is1-ssl.mzstatic.com/image/test.jpg', trackTimeMillis: song.durationMs };
async function fixture(t, { importer, catalog } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-extension-library-')), events = [];
  let playbackState = null, queueState = null;
  const bridge = {
    status() { return { connection: { state: 'connected', message: 'Connected' }, settings: { region: 'IN', locale: 'en-IN', country: 'IN' }, devices: [{ id: device, name: 'Test Echo', online: true }], player: null }; },
    requireDevice(value) { if (value !== device) throw new AppError(400, 'INVALID_DEVICE', 'Choose a connected Echo.'); return { id: device }; },
    async musicProviders() { return { providers: [{ id: 'apple-music', name: 'Apple Music', kind: 'music' }] }; },
    async player(value) { this.requireDevice(value); return { player: { deviceId: value, state: 'PLAYING', ...song, providerName: 'Apple Music', volume: 17 }, volume: 17 }; },
    async freshPlayer(value) { return this.player(value); },
    commands() { return { commands: [{ id: 'one', text: 'What time is it?', status: 'sent', responseStatus: 'unavailable', response: null }], retention: 'session' }; },
    async requireMusicRequestProvider(providerId, { valid }) { events.push({ type: 'native-preflight', providerId }); if (!valid()) throw new AppError(409, 'PLAYBACK_CHANGED', 'Playback changed.'); },
    async connect() { events.push({ type: 'connect' }); return this.status(); }, disconnect() { events.push({ type: 'disconnect' }); return this.status(); }, restore() {},
  };
  const playback = { intent: 0, queue: Promise.resolve(),
    status: () => playbackState,
    cancel(message) { ++this.intent; if (playbackState) playbackState = { ...playbackState, active: false, state: 'cancelled', message }; events.push({ type: 'cancel', message }); return playbackState; },
    reserve(context) { this.cancel('New song'); playbackState = { id: 'song-request', active: true, state: 'preparing', ...context }; return playbackState; },
    start(job, track) { events.push({ type: 'play', track, context: job }); return { status: 'sent', requestId: job.id, playback: { ...job, state: 'checking' } }; }, failReservation() {},
    async customCommand(deviceId, text) { bridge.requireDevice(deviceId); this.cancel('Custom'); events.push({ type: 'custom', deviceId, text }); return { status: 'sent', confirmed: false }; },
    async nativePlaylist(deviceId, playlist) { bridge.requireDevice(deviceId); events.push({ type: 'native-playlist', playlist }); return { status: 'sent' }; },
    async setVolume(deviceId, volume) { bridge.requireDevice(deviceId); if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new AppError(400, 'INVALID_VOLUME', 'Invalid volume'); events.push({ type: 'volume', volume }); return { status: 'sent', volume }; },
    async seek(deviceId, positionMs, expected) { bridge.requireDevice(deviceId); events.push({ type: 'seek', positionMs, expected }); return { status: 'sent' }; },
    async control(deviceId, action) { bridge.requireDevice(deviceId); events.push({ type: 'control', action }); return { status: 'sent' }; }
  };
  const queue = {
    status: () => queueState,
    clear(_id, options) { queueState = null; events.push({ type: 'queue-clear', options }); return { queue: null }; },
    cancel(message) { if (queueState) queueState = { ...queueState, active: false, state: 'cancelled' }; events.push({ type: 'queue-cancel', message }); return queueState; },
    startLocal(context) { events.push({ type: 'queue-start', context }); queueState = { id: 'local-queue', state: 'preparing', active: true, ...context }; return { queue: queueState }; },
    async enqueue(context) { events.push({ type: 'enqueue', context }); queueState = { id: 'queue-items', state: 'ready', active: true, country: context.country, providerId: context.providerId }; return { queue: queueState }; },
    remove(context) { events.push({ type: 'queue-remove', context }); return { queue: queueState }; },
    move(context) { events.push({ type: 'queue-move', context }); return { queue: queueState }; },
    async control(action) { events.push({ type: 'queue-control', action }); return { queue: queueState }; }
  };
  const library = createLibrary({ dataDir, bridge, playback, queue, catalog, fetcher: async () => ({ ok: true, json: async () => ({ results: [row] }) }), publicPlaylistImporter: importer || (async (url, country) => ({ name: 'Public list', source: 'apple-music', tracks: [{ ...song, country }], total: 1, skipped: 0, notes: [], url, availability: 'unverified' })) });
  const server = http.createServer(library.handleAuthenticated); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await library.stop(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = async (route, body, method) => {
    const result = await fetch('http://127.0.0.1:' + server.address().port + route, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { host: '127.0.0.1:4320', ...(body === undefined ? {} : {'Content-Type':'application/json'}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() };
  };
  return { library, request, events, dataDir };
}
const appleUrl = 'https://music.apple.com/in/playlist/test/pl.example123';

test('extension library searches public India catalogue without a music account and retains opaque selections', async t => {
  const f = await fixture(t), result = await f.request('/api/search?q=Mahiya&country=IN');
  assert.equal(result.status, 200); assert.equal(result.body.source, 'itunes'); assert.equal(result.body.country, 'IN'); assert.equal(result.body.tracks[0].title, song.title);
  assert.match(result.body.tracks[0].id, /^[a-f0-9-]{36}$/); assert.equal(f.events.length, 0);
  assert.equal((await f.request('/api/search?q=Mahiya&country=XX')).status, 400);
  const status = await f.request('/api/status'); assert.equal(status.body.catalogue.source, 'itunes');
  for (const account of ['apple','spotify','youtube']) assert.equal(status.body[account].connected, false);
});

test('catalogue play retains the web app native music request mode and rejects forged or cross-country selections', async t => {
  const f = await fixture(t), results = await f.request('/api/search?q=Mahiya&country=IN'), id = results.body.tracks[0].id;
  const result = await f.request('/api/play', { trackId: id, deviceId: device, providerId: 'apple-music', country: 'IN', requestMode: 'music-request-test' });
  assert.equal(result.status, 202); const play = f.events.find(row => row.type === 'play'); assert.equal(play.context.requestMode, 'music-request-test'); assert.equal(play.track.title, song.title);
  assert.ok(f.events.findIndex(row => row.type === 'native-preflight') < f.events.findIndex(row => row.type === 'play'));
  const count = f.events.length;
  assert.equal((await f.request('/api/play', { trackId: 'forged', deviceId: device, providerId: 'apple-music', country: 'IN' })).status, 400);
  assert.equal((await f.request('/api/play', { trackId: id, deviceId: device, providerId: 'apple-music', country: 'US' })).status, 409);
  assert.equal(f.events.length, count);
});

test('public link previews and saving an imported playlist do not start any music or queue', async t => {
  const f = await fixture(t), preview = await f.request('/api/playlist-import/preview', { url: appleUrl, country: 'IN' });
  assert.equal(preview.status, 200); assert.equal(preview.body.availability, 'unverified');
  const saved = await f.request('/api/local-playlists/import', { name: 'Imported list', country: 'IN', previewId: preview.body.previewId, tracks: preview.body.tracks });
  assert.equal(saved.status, 201); assert.equal(saved.body.playlist.itemCount, 1); assert.deepEqual(f.events, []);
  assert.equal((await f.request('/api/local-playlists')).body.playlists[0].name, 'Imported list');
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'library', 'playlists.json'), 'utf8')); assert.equal(persisted.playlists.length, 1);
});

test('partial public previews remain explicit and cannot claim native playlist equivalence', async t => {
  const f = await fixture(t, { importer: async (url, country) => ({ name: 'Visible songs', tracks: [{ ...song, country }], total: null, skipped: 0, truncated: true, fullCountUnverified: true, notes: ['Only visible songs loaded.'], url }) });
  const preview = await f.request('/api/playlist-import/preview', { url: appleUrl, country: 'IN' });
  assert.equal(preview.body.total, null); assert.equal(preview.body.truncated, true); assert.equal(preview.body.fullCountUnverified, true);
  const saved = await f.request('/api/local-playlists/import', { name: 'Partial list', country: 'IN', previewId: preview.body.previewId, tracks: preview.body.tracks });
  assert.equal(saved.status, 201); assert.equal(saved.body.playlist.originUnchanged, false);
});

test('pasted playlists can queue in saved order or request their original supported service explicitly', async t => {
  const f = await fixture(t), saved = await f.request('/api/local-playlists/import', { name: 'My list', country: 'IN', nativeName: 'Original list', tracks: [song, { ...song, title: 'Second song' }] });
  assert.equal(saved.status, 201); const playlist = saved.body.playlist;
  const queued = await f.request('/api/local-playlists/' + playlist.id + '/play', { deviceId: device, country: 'IN', providerId: 'apple-music' });
  assert.equal(queued.status, 202); assert.deepEqual(f.events.find(row => row.type === 'queue-start').context.playlist.tracks.map(track => track.title), [song.title, 'Second song']);
  assert.equal((await f.request('/api/local-playlists/' + playlist.id + '/play-native', { deviceId: device, country: 'IN', providerId: 'spotify' })).status, 409);
  const native = await f.request('/api/local-playlists/' + playlist.id + '/play-native', { deviceId: device, country: 'IN', providerId: 'apple-music' });
  assert.equal(native.status, 202); assert.equal(native.body.queue, null); assert.equal(f.library.queue.status(), null); assert.equal(f.events.find(row => row.type === 'queue-clear').options.keepCurrent, false); assert.equal(f.events.find(row => row.type === 'native-playlist').playlist.title, 'Original list');
});

test('search results enqueue as trusted country-bound songs without a music webpage', async t => {
  const f = await fixture(t), results = await f.request('/api/search?q=Mahiya&country=IN');
  const result = await f.request('/api/queue/items', { selection: { source: 'catalogue', trackId: results.body.tracks[0].id, country: 'IN', title: 'Forged title' }, placement: 'next', deviceId: device, providerId: 'apple-music', country: 'IN' });
  assert.equal(result.status, 202); assert.equal(f.events.find(row => row.type === 'enqueue').context.track.title, song.title);
});

test('typed commands and Echo controls retain selected-device validation and separate command responses', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/command', { deviceId: device, text: 'What time is it?' })).status, 202);
  assert.equal(f.events.find(row => row.type === 'custom').text, 'What time is it?');
  assert.equal((await f.request('/api/command', { deviceId: 'other', text: 'Play something' })).status, 400);
  assert.equal((await f.request('/api/volume', { deviceId: device, volume: 17 })).status, 202);
  assert.equal((await f.request('/api/volume', { deviceId: device, volume: 101 })).status, 400);
  assert.equal((await f.request('/api/player?deviceId=' + device)).body.volume, 17);
  assert.equal((await f.request('/api/commands')).body.commands[0].response, null);
});

test('catalogue account routes are restored while credentials remain optional for public browsing', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/apple/config')).status, 503);
  assert.equal((await f.request('/api/spotify/setup', { clientId: 'a'.repeat(32) })).status, 200);
  assert.equal((await f.request('/api/youtube/setup', { clientId: '123456789012-exampleclientid.apps.googleusercontent.com', clientSecret: 'synthetic-secret' })).status, 200);
  assert.equal((await f.request('/api/apple/setup', {})).status, 400);
  const status = await f.request('/api/status');
  assert.equal(status.body.spotify.configured, true); assert.equal(status.body.youtube.configured, true);
  assert.equal(status.body.spotify.connected, false); assert.equal(status.body.youtube.connected, false);
  assert.equal((await f.request('/api/search?q=Mahiya&country=IN')).status, 200);
  assert.equal(f.events.filter(event => ['play','queue-start','custom'].includes(event.type)).length, 0);
});
