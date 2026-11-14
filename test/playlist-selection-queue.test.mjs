import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLibrary } from '../library/index.mjs';
import { AppError } from '../library/errors.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const song = (id, title = id, extra = {}) => ({ id, title, artist: 'First Artist, Second Artist', requestArtist: 'First Artist', requestArtists: ['First Artist', 'Second Artist'], source: 'spotify', country: 'IN', durationMs: 180000, artwork: 'https://i.scdn.co/image/test', url: 'https://open.spotify.com/track/' + '1'.repeat(22), ...extra });

async function fixture(t, tracks = [song('first'), song('middle'), song('last')]) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-playlist-tail-'));
  const commands = [], controls = []; let current = null, sequence = 0;
  const bridge = {
    status: () => ({ connection: { state: 'connected' }, settings: { country: 'IN' }, devices: [{ id: 'echo' }] }),
    requireDevice(id) { if (id !== 'echo') throw new AppError(400, 'INVALID_DEVICE', 'Choose your Echo.'); },
    async freshPlayer() { return { player: { state: 'UNKNOWN' } }; },
    async requireMusicRequestProvider(_provider, { valid }) { assert.equal(valid(), true); },
  };
  const playback = {
    intent: 0, queue: Promise.resolve(),
    status: () => current ? { id: current.id, state: current.state, active: current.active } : null,
    cancel(_message, requestId) { if (requestId && current?.id !== requestId) return this.status(); this.intent++; if (current) { current.active = false; current.state = 'cancelled'; current.done.resolve(); } return this.status(); },
    reserve(context) { this.cancel(); const done = deferred(); current = { ...context, id: 'request-' + ++sequence, state: 'preparing', active: true, done, task: done.promise }; return current; },
    start(job, track) { job.state = 'checking'; commands.push({ track: structuredClone(track), context: job }); return { status: 'sent', requestId: job.id }; },
    failReservation() {},
    async control(deviceId, action) { controls.push({ deviceId, action }); this.cancel(); return { status: 'sent' }; },
  };
  let youtubePlaylist = { id: 'yt-list', title: 'Original YouTube mix', source: 'youtube-music', tracks: tracks.map(track => ({ ...track, source: 'youtube-music' })) };
  let loadPlaylist = async id => { if (id !== 'yt-list') throw new AppError(400, 'EXPIRED_PLAYLIST', 'Refresh the playlist.'); return structuredClone(youtubePlaylist); };
  const youtube = { status: () => ({ source: 'youtube-music', connected: true }), playlist: id => loadPlaylist(id) };
  const library = createLibrary({ dataDir, bridge, playback, youtube, queueOptions: { random: () => 0 }, fetcher: async () => { throw new Error('No network request expected'); } });
  const playlist = library.localPlaylists.importTracks({ name: 'My saved mix', country: 'IN', tracks });
  const server = http.createServer(library.handle); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (selection, extra = {}) => {
    const response = await fetch(base + '/api/play-selection', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Echo-App': '1' }, body: JSON.stringify({ selection, deviceId: 'echo', providerId: 'apple-music', country: 'IN', ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  const mode = async body => { const response = await fetch(base + '/api/queue/mode', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Echo-App': '1' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const local = at => ({ source: 'local', playlistId: playlist.id, entryId: playlist.tracks[at].id, country: 'IN' });
  const yt = at => ({ source: 'youtube-music', playlistId: 'yt-list', trackId: tracks[at].id, country: 'IN' });
  t.after(async () => { await library.stop(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { library, playback, playlist, request, mode, local, yt, commands, controls, get current() { return current; }, setYoutube: value => { youtubePlaylist = value; }, setLoader: value => { loadPlaylist = value; } };
}

test('saved playlist song starts at its stable entry and wraps the full source order', async t => {
  const f = await fixture(t);
  const result = await f.request(f.local(1)); await flush();
  assert.equal(result.status, 202); assert.equal(result.body.mode, 'playlist-queue');
  assert.deepEqual(f.library.queue.status().items.map(item => item.title), ['middle', 'last', 'first']);
  assert.equal(f.commands.length, 1); assert.equal(f.commands[0].track.title, 'middle');
  assert.deepEqual(f.commands[0].track.requestArtists, ['First Artist', 'Second Artist']);
  assert.equal(f.commands[0].context.providerId, 'apple-music');
  assert.equal(f.playlist.tracks.length, 3);
});

test('starting at the last song wraps to the first and duplicate titles select by entry ID', async t => {
  const f = await fixture(t, [song('a', 'Same title'), song('b', 'Same title'), song('c', 'Same title')]);
  let result = await f.request(f.local(1)); await flush();
  assert.equal(result.status, 202); assert.equal(f.library.queue.status().total, 3);
  assert.equal(f.library.queue.current.tracks[0].entryId, f.playlist.tracks[1].id);
  result = await f.request(f.local(2)); await flush();
  assert.equal(result.status, 202); assert.equal(f.library.queue.status().total, 3);
  assert.equal(f.library.queue.current.tracks[0].entryId, f.playlist.tracks[2].id);
});

test('invalid or cross-country saved selections leave the existing queue intact', async t => {
  const f = await fixture(t); await f.request(f.local(0)); await flush();
  const original = f.library.queue.status().id, intent = f.playback.intent;
  for (const [selection, extra] of [
    [{ ...f.local(1), entryId: 'missing' }, {}],
    [{ ...f.local(1), playlistId: 'missing' }, {}],
    [{ ...f.local(1), country: 'US' }, {}],
    [f.local(1), { country: 'US' }],
    [f.local(1), { deviceId: 'other' }],
    [f.local(1), { providerId: 'tunein' }],
  ]) { const result = await f.request(selection, extra); assert.ok(result.status >= 400); assert.equal(f.library.queue.status().id, original); assert.equal(f.playback.intent, intent); }
  assert.equal(f.commands.length, 1);
});

test('YouTube playback rotates the full reviewed playlist and retains per-artist resources', async t => {
  const tracks = [song('earlier', 'Earlier'), song('chosen', 'Chosen'), song('next', 'Next')];
  const f = await fixture(t, tracks.map(track => track.id === 'earlier' ? song('earlier', 'Earlier') : track));
  f.setYoutube({ id: 'yt-list', title: 'Original YouTube mix', source: 'youtube-music', tracks });
  const selection = { ...f.yt(1), title: 'Chosen', artist: tracks[1].artist, edits: [{ id: 'chosen', title: 'Chosen', artist: tracks[1].artist }, { id: 'next', title: 'Next edited', artist: 'Edited Artist' }] };
  const result = await f.request(selection); await flush();
  assert.equal(result.status, 202); assert.deepEqual(f.library.queue.status().items.map(item => item.title), ['Chosen', 'Next edited', 'Earlier']);
  assert.deepEqual(f.commands[0].track.requestArtists, ['First Artist', 'Second Artist']);
  assert.equal(f.commands[0].track.artwork, tracks[1].artwork); assert.equal(f.commands[0].track.url, tracks[1].url);
  const next = f.library.queue.current.tracks[1]; assert.equal(next.requestArtist, 'Edited Artist'); assert.deepEqual(next.requestArtists, ['Edited Artist']); assert.equal(next.durationMs, 0);
});

test('unreviewed songs anywhere in the circular YouTube playlist fail before replacing playback', async t => {
  const f = await fixture(t); await f.request(f.local(0)); await flush();
  const previous = f.library.queue.status().id, intent = f.playback.intent;
  for (const badAt of [0, 2]) {
    const tracks = [song('first'), song('middle'), song('last')]; tracks[badAt] = { ...tracks[badAt], artist: '', needsReview: true };
    f.setYoutube({ id: 'yt-list', title: 'YouTube mix', source: 'youtube-music', tracks });
    const result = await f.request(f.yt(1)); assert.equal(result.status, 400); assert.equal(result.body.error, 'QUEUE_REVIEW_REQUIRED');
    assert.equal(f.library.queue.status().id, previous); assert.equal(f.playback.intent, intent); assert.equal(f.commands.length, 1);
  }
});

test('a stale asynchronous playlist fetch cannot replace a newer song selection', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.setLoader(async () => { entered.resolve(); return gate.promise; });
  const pending = f.request(f.yt(1)); await entered.promise;
  await f.request(f.local(2)); await flush(); const newer = f.library.queue.status().id;
  gate.resolve({ id: 'yt-list', title: 'Old playlist', source: 'youtube-music', tracks: [song('first'), song('middle'), song('last')] });
  const old = await pending; assert.equal(old.status, 409); assert.equal(f.library.queue.status().id, newer); assert.equal(f.commands.length, 1); assert.equal(f.commands[0].track.title, 'last');
});


test('an explicit request mode remains bound to every song in the selected playlist cycle', async t => {
  const f = await fixture(t);
  const result = await f.request(f.local(1), { requestMode: 'music-request-test' }); await flush();
  assert.equal(result.status, 202); assert.equal(f.commands[0].context.requestMode, 'music-request-test');
  await f.library.queue.control('next'); await flush();
  assert.equal(f.commands[1].track.title, 'last'); assert.equal(f.commands[1].context.requestMode, 'music-request-test');
});


test('ten-song playlist starting at five queues5through10then1through4 exactly once', async t => {
  const f = await fixture(t, Array.from({ length: 10 }, (_, at) => song(String(at + 1))));
  const result = await f.request(f.local(4)); await flush();
  assert.equal(result.status, 202); assert.equal(result.body.queue.repeatAll, false); assert.equal(result.body.queue.shuffle, false);
  assert.deepEqual(f.library.queue.status().items.map(item => item.title), ['5','6','7','8','9','10','1','2','3','4']);
  for (let count = 0; count < 10; count++) { await f.library.queue.control('next'); await flush(); }
  assert.deepEqual(f.commands.map(item => item.track.title), ['5','6','7','8','9','10','1','2','3','4']);
  assert.equal(f.library.queue.status().state, 'completed');
});

test('Repeat All cycles back to the originally selected fifth song after the full playlist', async t => {
  const f = await fixture(t, Array.from({ length: 10 }, (_, at) => song(String(at + 1))));
  const result = await f.request(f.local(4), { repeatAll: true }); await flush();
  for (let count = 0; count < 10; count++) { await f.library.queue.control('next'); await flush(); }
  assert.equal(result.status, 202); assert.equal(f.library.queue.status().repeatAll, true);
  assert.deepEqual(f.commands.map(item => item.track.title), ['5','6','7','8','9','10','1','2','3','4','5']);
  assert.equal(f.library.queue.current.cycle, 1); assert.equal(f.library.queue.status().index, 0);
});

test('live Shuffle preserves current/history and turning it off restores upcoming rotated source order', async t => {
  const f = await fixture(t, Array.from({ length: 10 }, (_, at) => song(String(at + 1))));
  await f.request(f.local(4)); await flush();
  await f.library.queue.control('next'); await flush(); await f.library.queue.control('next'); await flush();
  const before = f.library.queue.status(), revision = f.library.queue.current.revision, intent = f.playback.intent;
  let result = await f.mode({ requestId: before.id, shuffle: true });
  assert.equal(result.status, 200); assert.equal(result.body.queue.shuffle, true);
  assert.deepEqual(result.body.queue.items.slice(0, 3).map(item => item.title), ['5','6','7']);
  assert.notDeepEqual(result.body.queue.items.slice(3).map(item => item.title), ['8','9','10','1','2','3','4']);
  assert.equal(f.commands.length, 3); assert.equal(f.playback.intent, intent); assert.equal(f.library.queue.current.revision, revision);
  result = await f.mode({ requestId: before.id, shuffle: false, repeatAll: true });
  assert.deepEqual(result.body.queue.items.map(item => item.title), ['5','6','7','8','9','10','1','2','3','4']);
  assert.equal(result.body.queue.repeatAll, true); assert.equal(f.commands.length, 3);
});

test('Shuffle can be configured before starting while keeping the selected song first', async t => {
  const f = await fixture(t, Array.from({ length: 6 }, (_, at) => song(String(at + 1))));
  const result = await f.request(f.local(2), { shuffle: true, repeatAll: true }); await flush();
  assert.equal(result.status, 202); assert.equal(result.body.queue.shuffle, true); assert.equal(result.body.queue.repeatAll, true);
  assert.equal(result.body.queue.items[0].title, '3'); assert.equal(f.commands[0].track.title, '3');
  assert.deepEqual([...result.body.queue.items.map(item => item.title)].sort(), ['1','2','3','4','5','6']);
});

test('invalid and stale mode changes never mutate the queue or send playback commands', async t => {
  const f = await fixture(t); await f.request(f.local(1)); await flush();
  const before = f.library.queue.status(), intent = f.playback.intent;
  for (const body of [{ requestId: 'old', shuffle: true }, { requestId: before.id, shuffle: 'true' }, { requestId: before.id, repeatAll: 1 }, { requestId: before.id }]) {
    const result = await f.mode(body); assert.ok(result.status >= 400); assert.equal(f.library.queue.status().shuffle, false); assert.equal(f.library.queue.status().repeatAll, false);
    assert.deepEqual(f.library.queue.status().items, before.items); assert.equal(f.playback.intent, intent); assert.equal(f.commands.length, 1);
  }
  const bad = await f.request(f.local(0), { shuffle: 'yes' }); assert.equal(bad.status, 400); assert.equal(f.library.queue.status().id, before.id); assert.equal(f.commands.length, 1);
});

test('manual pending moves retain other source ordering when Shuffle is turned off', async t => {
  const f = await fixture(t, Array.from({ length: 6 }, (_, at) => song(String(at + 1))));
  await f.request(f.local(2)); await flush(); let current = f.library.queue.status();
  await f.mode({ requestId: current.id, shuffle: true }); current = f.library.queue.status();
  const item = title => current.items.find(track => track.title === title).id;
  f.library.queue.move({ queueId: current.id, itemId: item('6'), beforeItemId: item('4') });
  const result = await f.mode({ requestId: current.id, shuffle: false });
  assert.deepEqual(result.body.queue.items.map(track => track.title), ['3','6','4','5','1','2']);
  assert.equal(f.commands.length, 1);
});


test('automatic end detection repeats the complete selected cycle without user Next commands', async t => {
  const f = await fixture(t), start = f.playback.start.bind(f.playback), observed = [];
  f.playback.start = function (job, track) { const result = start(job, track); job.state = 'matched'; job.active = false; job.done.resolve(); return result; };
  f.library.queue.monitor = async function (job) { observed.push(job.tracks[job.index].title); if (observed.length === 4) { this.cancel('Test complete'); return false; } return true; };
  await f.request(f.local(1), { repeatAll: true }); await f.library.queue.current.task;
  assert.deepEqual(f.commands.map(item => item.track.title), ['middle','last','first','middle']);
  assert.deepEqual(observed, ['middle','last','first','middle']); assert.equal(f.controls.length, 0);
});

test('pending additions and removals remain consistent in the next Repeat All cycle', async t => {
  const f = await fixture(t); await f.request(f.local(1), { repeatAll: true }); await flush();
  let current = f.library.queue.status(); const removed = current.items.find(item => item.title === 'last');
  f.library.queue.remove({ queueId: current.id, itemId: removed.id });
  await f.library.queue.enqueue({ queueId: current.id, track: song('added'), placement: 'last', deviceId: 'echo', providerId: 'apple-music', country: 'IN' });
  assert.deepEqual(f.library.queue.status().items.map(item => item.title), ['middle','first','added']); assert.equal(f.commands.length, 1);
  for (let count = 0; count < 3; count++) { await f.library.queue.control('next'); await flush(); }
  current = f.library.queue.status();
  assert.deepEqual(f.commands.map(item => item.track.title), ['middle','first','added','middle']);
  assert.equal(current.items.some(item => item.id === removed.id), false);
  assert.deepEqual(current.items.map(item => item.title), ['middle','first','added']);
});
