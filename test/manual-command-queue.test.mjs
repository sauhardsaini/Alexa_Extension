import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLibrary } from '../library/index.mjs';
import { PlaylistQueue } from '../library/playlist-queue.mjs';
import { AppError } from '../library/errors.mjs';

const DEVICE = 'test-echo';
const FAILED = 'Veezha Veera (From "OM Chapter 1: Udhiram - The Blood Wood") [Tamil]';
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const currentSong = (title, extra = {}) => ({ state: 'PLAYING', title, artist: 'Test Artist', album: 'Test Album', providerName: 'Apple Music', mediaId: 'media-' + title, durationMs: 300000, positionMs: 1000, ...extra });
const manualSong = () => currentSong('Veezha Veera', { artist: 'Sai Abhyankkar', providerName: 'Spotify', mediaId: 'manual-correct-recording' });
async function until(predicate, label) { for (let i = 0; i < 100; i++) { if (predicate()) return; await flush(); } assert.fail(label || 'expected state did not appear'); }

async function fixture(t, { custom } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-command-queue-'));
  let time = 1000, sequence = 0, live = currentSong('Before queue'), playerReadHook = null;
  const songs = [], commands = [], controls = [], sleepers = [], adoptionSleepers = [];
  const bridge = {
    generation: 0,
    requireDevice(id) { if (id !== DEVICE) throw new AppError(400, 'INVALID_DEVICE', 'Choose a connected Echo.'); return { id, name: 'Test Echo', online: true }; },
    status() { return { connection: { state: 'connected' }, settings: { country: 'IN', region: 'IN', locale: 'en-IN' }, devices: [{ id: DEVICE, name: 'Test Echo', online: true }] }; },
    async freshPlayer(id) { this.requireDevice(id); return { player: structuredClone(live) }; },
    async player(id) { const result = await this.freshPlayer(id); return playerReadHook ? await playerReadHook(result) : result; },
    commands() { return { commands: [], retention: 'session' }; },
    restore() {},
  };
  const playback = {
    current: null, intent: 0, queue: Promise.resolve(),
    status() { return this.current ? { id: this.current.id, state: this.current.state, active: this.current.active, reportedProviderName: this.current.reportedProviderName } : null; },
    cancel(message, requestId = null) {
      if (requestId && requestId !== this.current?.id) return this.status();
      ++this.intent;
      if (this.current?.active) Object.assign(this.current, { active: false, state: 'cancelled', message });
      return this.status();
    },
    reserve(context) { this.cancel('New song'); return this.current = { id: 'request-' + ++sequence, ...context, active: true, state: 'preparing', task: Promise.resolve() }; },
    start(job, track) {
      songs.push({ track: structuredClone(track), deviceId: job.deviceId, providerId: job.providerId });
      if (track.title === FAILED) { live = currentSong('Wrong recording'); Object.assign(job, { active: false, state: 'unmatched' }); }
      else { live = currentSong(track.title, { artist: track.artist }); Object.assign(job, { active: false, state: 'matched', reportedProviderName: 'Apple Music' }); }
      job.task = Promise.resolve();
      return { status: 'sent', requestId: job.id };
    },
    async customCommand(id, text) {
      bridge.requireDevice(id); this.cancel('Manual command'); commands.push({ deviceId: id, text });
      if (custom) await custom({ text, setLive: value => { live = value; } });
      else if (/^play\b/i.test(text)) live = manualSong();
      return { status: 'sent', commandId: 'typed-' + commands.length, message: 'Request sent.' };
    },
    async control(id, action) { bridge.requireDevice(id); this.cancel('Control'); controls.push({ id, action }); return { status: 'sent' }; },
  };
  const gated = collection => (ms, signal) => new Promise(resolve => {
    const item = { done: false, release() { if (item.done) return; item.done = true; time += ms; signal?.removeEventListener('abort', item.release); resolve(); } };
    collection.push(item); if (signal?.aborted) item.release(); else signal?.addEventListener('abort', item.release, { once: true });
  });
  const queue = new PlaylistQueue({ bridge, playback, clock: () => time, sleep: gated(sleepers), adoptionSleep: gated(adoptionSleepers), pollMs: 10, adoptionPollMs: 10 });
  const library = createLibrary({ dataDir, bridge, playback, queue, fetcher: async () => { throw new Error('No external request is allowed in this fixture'); } });
  const server = http.createServer(library.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, body, extraHeaders = {}) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { Origin: base, 'X-Echo-App': '1', 'Content-Type': 'application/json' }), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const playlist = { id: 'saved-playlist', name: 'Ten songs', source: 'local', country: 'IN', tracks: Array.from({ length: 10 }, (_, index) => ({ id: 'entry-' + (index + 1), title: index === 4 ? FAILED : 'Song ' + (index + 1), artist: 'Test Artist', country: 'IN', source: 'local' })) };
  t.after(async () => { queue.cancel(); await library.stop(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const beginFailure = async () => {
    queue.startLocal({ playlist, deviceId: DEVICE, providerId: 'apple-music', country: 'IN' });
    await until(() => queue.status()?.state === 'playing');
    for (let index = 1; index <= 4; index++) {
      const next = await request('/api/queue/control', { action: 'next', queueId: queue.status().id }); assert.equal(next.status, 202);
      await until(() => queue.status()?.index === index && queue.status()?.state === (index === 4 ? 'needs_attention' : 'playing'));
    }
    // Let the failed-attempt baseline be captured before a later manual change.
    await flush(); await flush();
    return structuredClone(queue.status());
  };
  const observe = async (times = 3) => { for (let i = 0; i < times; i++) { if (live.state === 'PLAYING' && Number.isFinite(live.positionMs)) live.positionMs += 1000; const response = await request('/api/player?deviceId=' + DEVICE + '&fresh=1'); assert.equal(response.status, 200); await flush(); } };
  const stepMonitor = async value => { live = value; const pending = sleepers.find(item => !item.done); assert.ok(pending, 'queue monitor must be waiting'); pending.release(); await flush(); };
  return { bridge, playback, queue, request, songs, commands, controls, beginFailure, observe, stepMonitor, playlist, setLive: value => { live = value; }, setPlayerReadHook: value => { playerReadHook = value; } };
}

test('typed correction inserts the observed song as sixth and Next retains the original sixth song', async t => {
  const f = await fixture(t), before = await f.beginFailure();
  assert.equal(before.index, 4); assert.equal(before.total, 10);
  const response = await f.request('/api/command', { deviceId: DEVICE, text: 'Play Veezha Veera by Sai Abhyankkar' });
  assert.equal(response.status, 202); assert.equal(response.body.queue.id, before.id);
  await f.observe();
  const after = f.queue.status();
  assert.equal(after.id, before.id); assert.equal(after.active, true); assert.equal(after.state, 'playing'); assert.equal(after.index, 5); assert.equal(after.total, 11);
  assert.equal(after.currentTrack.title, 'Veezha Veera'); assert.equal(after.currentTrack.adopted, true); assert.equal(after.currentProviderName, 'Spotify');
  assert.deepEqual(after.items.slice(0, 5).map(item => item.id), before.items.slice(0, 5).map(item => item.id));
  assert.deepEqual(after.items.slice(6).map(item => item.id), before.items.slice(5).map(item => item.id));
  assert.equal(f.songs.length, 5, 'adopting an already playing song must not replay it');
  const next = await f.request('/api/queue/control', { action: 'next', queueId: before.id }); assert.equal(next.status, 202);
  await until(() => f.songs.length === 6);
  assert.equal(f.songs.at(-1).track.title, 'Song 6'); assert.equal(f.songs.at(-1).providerId, 'apple-music');
});

test('a spoken song observed through player refresh clears the old queue without sending a song command', async t => {
  const f = await fixture(t); await f.beginFailure(); const songs = f.songs.length;
  f.setLive(manualSong()); await f.observe();
  assert.equal(f.queue.status(), null); assert.equal(f.commands.length, 0); assert.equal(f.songs.length, songs);
});

test('nonmusic commands and unchanged failed playback preserve the queue without adding a duplicate', async t => {
  const f = await fixture(t), before = await f.beginFailure();
  const response = await f.request('/api/command', { deviceId: DEVICE, text: 'What is the weather?' }); assert.equal(response.status, 202);
  await f.observe(4);
  const after = f.queue.status(); assert.equal(after.active, true); assert.equal(after.index, 4); assert.equal(after.total, 10);
  assert.deepEqual(after.items.map(item => item.id), before.items.map(item => item.id)); assert.equal(f.songs.length, 5);
});

test('invalid text, invalid device and cross-origin commands cannot change an existing queue', async t => {
  const f = await fixture(t), before = await f.beginFailure();
  assert.equal((await f.request('/api/command', { deviceId: DEVICE, text: 'play\nstop' })).status, 400);
  assert.equal((await f.request('/api/command', { deviceId: 'unknown-device', text: 'Play music' })).status, 400);
  assert.equal((await f.request('/api/command', { deviceId: DEVICE, text: 'Play music' }, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal(f.commands.length, 0);
  const after = f.queue.status(); assert.equal(after.active, true); assert.equal(after.index, before.index); assert.deepEqual(after.items.map(item => item.id), before.items.map(item => item.id));
});

test('uncertain custom-command transport keeps the tail and can adopt a later observed recording', async t => {
  const f = await fixture(t, { custom: async () => { throw new Error('private transport detail'); } }), before = await f.beginFailure();
  const response = await f.request('/api/command', { deviceId: DEVICE, text: 'Play Veezha Veera' }); assert.ok(response.status >= 400); assert.equal(JSON.stringify(response.body).includes('private transport'), false);
  assert.equal(f.commands.length, 1); assert.equal(f.queue.status().total, 10); assert.equal(f.queue.status().active, true);
  f.setLive(manualSong()); await f.observe();
  assert.equal(f.queue.status().currentTrack.title, 'Veezha Veera'); assert.equal(f.queue.status().total, 11);
  assert.deepEqual(f.queue.status().items.slice(6).map(item => item.id), before.items.slice(5).map(item => item.id));
});

test('clearing the queue during an in-flight manual command prevents later adoption from reviving it', async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { custom: async ({ setLive }) => { entered.resolve(); await release.promise; setLive(manualSong()); } });
  const before = await f.beginFailure();
  const pending = f.request('/api/command', { deviceId: DEVICE, text: 'Play Veezha Veera' }); await entered.promise;
  const cleared = await f.request('/api/queue/control', { action: 'clear', queueId: before.id }); assert.equal(cleared.status, 202);
  release.resolve(); await pending; await f.observe();
  assert.equal(f.queue.status().active, false); assert.equal(f.queue.status().id, before.id); assert.equal(f.queue.status().total, 5);
  assert.equal(f.queue.status().items.some(item => item.title === 'Veezha Veera'), false);
});

test('a new queue during a pending manual command cannot be replaced by the old command result', async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { custom: async ({ setLive }) => { entered.resolve(); await release.promise; setLive(manualSong()); } });
  const oldQueue = await f.beginFailure();
  const pending = f.request('/api/command', { deviceId: DEVICE, text: 'Play Veezha Veera' }); await entered.promise;
  const replacement = { ...f.playlist, id: 'replacement', name: 'New queue', tracks: f.playlist.tracks.slice(5) };
  f.queue.startLocal({ playlist: replacement, deviceId: DEVICE, providerId: 'apple-music', country: 'IN' }); await flush();
  const newQueue = f.queue.status(); assert.notEqual(newQueue.id, oldQueue.id);
  release.resolve(); await pending; await f.observe();
  assert.equal(f.queue.status(), null); assert.notEqual(newQueue.id, oldQueue.id);
});


test('a player read started before a manual command cannot seed its new recovery confirmation', async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t), before = await f.beginFailure();
  const candidate = currentSong('Later manually played song', { mediaId: 'later-manual', positionMs: 1000 });
  f.setLive(candidate);
  f.setPlayerReadHook(async result => { entered.resolve(); await release.promise; return result; });
  const oldRead = f.request('/api/player?deviceId=' + DEVICE + '&fresh=1'); await entered.promise;
  f.setLive(currentSong('Wrong recording'));
  assert.equal((await f.request('/api/command', { deviceId: DEVICE, text: 'What is the weather?' })).status, 202);
  release.resolve(); assert.equal((await oldRead).status, 200);
  f.setPlayerReadHook(null); f.setLive({ ...candidate, positionMs: 2000 });
  assert.equal((await f.request('/api/player?deviceId=' + DEVICE + '&fresh=1')).status, 200);
  assert.equal(f.queue.status().index, 4, 'one post-command observation cannot combine with a stale pre-command read');
  assert.equal(f.queue.status().total, before.total);
  await f.observe(1);
  assert.equal(f.queue.status().index, 5); assert.equal(f.queue.status().currentTrack.title, candidate.title);
});
