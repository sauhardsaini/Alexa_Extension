import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaylistQueue } from '../library/playlist-queue.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const target = 'Veezha Veera (From "OM Chapter 1: Udhiram - The Blood Wood") [Tamil]';
const wrong = { state: 'PLAYING', title: 'Wrong recording', artist: 'Wrong artist', providerName: 'Apple Music', mediaId: 'wrong', durationMs: 300000, positionMs: 10000 };
const manual = (positionMs = 1000, patch = {}) => ({ state: 'PLAYING', title: target, artist: 'Sai Abhyankkar', album: 'OM Chapter 1', providerName: 'Spotify', mediaId: 'manual', durationMs: 300000, positionMs, ...patch });
function sleeper() {
  const pending = [];
  const sleep = (ms, signal) => new Promise(resolve => {
    const entry = { done: false, ms, release() { if (entry.done) return; entry.done = true; signal?.removeEventListener('abort', entry.release); resolve(); } };
    pending.push(entry);
    if (signal?.aborted) entry.release(); else signal?.addEventListener('abort', entry.release, { once: true });
  });
  return { pending, sleep, async step() { const entry = pending.find(value => !value.done); assert.ok(entry); entry.release(); await flush(); } };
}
async function fixture(t, { failure = 'unmatched', baseline = wrong } = {}) {
  let sequence = 0, time = 1000, live = baseline;
  const monitor = sleeper(), adoption = sleeper(), commands = [], custom = [];
  const playback = { intent: 0, queue: Promise.resolve(), current: null,
    status() { return this.current && { id: this.current.id, state: this.current.state, active: this.current.active, reportedProviderName: 'Apple Music' }; },
    cancel() { ++this.intent; if (this.current) this.current.active = false; },
    reserve(options) { this.cancel(); return this.current = { ...options, id: 'request-' + ++sequence, state: 'preparing', active: true, task: Promise.resolve() }; },
    start(job, track) { commands.push({ track, providerId: job.providerId }); job.state = commands.length === 1 ? failure : 'matched'; job.active = false; job.lastPlayer = baseline; },
    async customCommand(deviceId, text) { this.cancel(); custom.push({ deviceId, text }); return { status: 'sent', commandId: 'custom-' + custom.length }; },
    async control() { this.cancel(); return { status: 'sent' }; },
  };
  const bridge = { requireDevice(id) { assert.equal(id, 'echo'); }, async freshPlayer() { return { player: live }; } };
  const queue = new PlaylistQueue({ bridge, playback, clock: () => ++time, sleep: monitor.sleep, adoptionSleep: adoption.sleep, adoptionPollMs: 1, adoptionAttempts: 2 });
  const source = { id: 'playlist', name: 'Ten songs', source: 'local', country: 'IN', tracks: Array.from({ length: 10 }, (_, index) => ({ id: 'source-' + index, title: index === 4 ? target : 'Song ' + (index + 1), artist: index === 4 ? 'Sai Abhyankkar' : 'Artist', country: 'IN', source: 'itunes' })) };
  queue.startLocal({ playlist: source, deviceId: 'echo', providerId: 'apple-music', country: 'IN', repeatAll: true });
  queue.current.index = 4;
  await queue.current.task;
  assert.equal(queue.status().state, 'needs_attention');
  t.after(() => queue.cancel());
  return { queue, playback, commands, custom, monitor, adoption, setLive(value) { live = value; } };
}

function acceptFallback(c) {
  assert.equal(c.queue.observePlayer('echo', { ...wrong, positionMs: 11000 }), false);
  return c.queue.observePlayer('echo', { ...wrong, positionMs: 12000 });
}
test('exhausted mismatches keep actual audio in the same slot and naturally advance the unchanged tail', async t => {
  const c = await fixture(t), before = c.queue.status(), ids = before.items.map(x => x.id);
  assert.equal(acceptFallback(c), true); await flush();
  const after = c.queue.status();
  assert.equal(after.index, 4); assert.equal(after.total, 10); assert.equal(after.currentTrack.title, wrong.title);
  assert.equal(after.currentTrack.requestedTitle, target); assert.equal(after.currentTrack.fallback, true);
  assert.match(after.warning, /Could not play/); assert.ok(after.warning.includes(target)); assert.ok(after.warning.includes(wrong.title));
  assert.deepEqual(after.items.map(x => x.id), ids); assert.equal(c.commands.length, 1);
  assert.equal(c.queue.current.cycleTracks[4].title, target);
  c.setLive({ ...wrong, positionMs: 299500 }); await c.monitor.step();
  assert.equal(c.commands.at(-1).track.title, 'Song 6'); assert.equal(c.commands.at(-1).providerId, 'apple-music');
  assert.equal(c.queue.status().index, 5); assert.equal(c.queue.status().warning, null);
});
test('Next leaves substitute audio for the original next item and Previous retries the requested song', async t => {
  const c = await fixture(t); acceptFallback(c); await flush();
  await c.queue.control('next'); await flush(); assert.equal(c.commands.at(-1).track.title, 'Song 6');
  await c.queue.control('previous'); await flush(); assert.equal(c.commands.at(-1).track.title, target);
  assert.equal(c.queue.status().warning, null); assert.equal(c.queue.status().total, 10);
});
test('a substitute can play on a different reported service while the next request keeps the selected service', async t => {
  const player = { ...wrong, providerName: 'Spotify' };
  const c = await fixture(t, { baseline: player });
  c.queue.observePlayer('echo', { ...player, positionMs: 11000 });
  assert.equal(c.queue.observePlayer('echo', { ...player, positionMs: 12000 }), true); await flush();
  c.setLive({ ...player, positionMs: 299500 }); await c.monitor.step();
  assert.equal(c.commands.at(-1).providerId, 'apple-music'); assert.equal(c.commands.at(-1).track.title, 'Song 6');
});
test('unknown request outcomes do not accept baseline audio as an exhausted mismatch', async t => {
  const c = await fixture(t, { failure: 'unverified' });
  assert.equal(acceptFallback(c), false); assert.equal(c.queue.status().state, 'needs_attention'); assert.equal(c.commands.length, 1);
});
test('paused, incomplete, unchanged-progress and cancelled observations cannot advance the queue', async t => {
  const c = await fixture(t);
  for (const patch of [{state:'PAUSED'}, {artist:''}, {providerName:''}, {durationMs:0}, {positionMs:NaN}]) {
    c.queue.observePlayer('echo', { ...wrong, ...patch });
    assert.equal(c.queue.observePlayer('echo', { ...wrong, ...patch }), false);
  }
  c.queue.observePlayer('echo', wrong); assert.equal(c.queue.observePlayer('echo', wrong), false);
  assert.equal(c.commands.length, 1); c.queue.cancel(); assert.equal(acceptFallback(c), false);
});

test('a manual correction after substitute monitoring still inserts as current and preserves the original next song', async t => {
  const c = await fixture(t); acceptFallback(c); await flush();
  await c.queue.customCommand('echo', 'Play the correct song');
  c.setLive(manual(1000));
  assert.equal(c.queue.status().state, 'needs_attention');
  c.queue.observePlayer('echo', manual(2000));
  assert.equal(c.queue.observePlayer('echo', manual(3000)), true); await flush();
  assert.equal(c.queue.status().index, 5); assert.equal(c.queue.status().total, 11);
  assert.equal(c.queue.status().currentTrack.title, target); assert.equal(c.queue.status().warning, null);
  await c.queue.control('next'); await flush(); assert.equal(c.commands.at(-1).track.title, 'Song 6');
});
