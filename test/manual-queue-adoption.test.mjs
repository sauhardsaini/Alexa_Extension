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
async function fixture(t) {
  let sequence = 0, time = 1000, live = wrong;
  const monitor = sleeper(), adoption = sleeper(), commands = [], custom = [];
  const playback = { intent: 0, queue: Promise.resolve(), current: null,
    status() { return this.current && { id: this.current.id, state: this.current.state, active: this.current.active, reportedProviderName: 'Apple Music' }; },
    cancel() { ++this.intent; if (this.current) this.current.active = false; },
    reserve(options) { this.cancel(); return this.current = { ...options, id: 'request-' + ++sequence, state: 'preparing', active: true, task: Promise.resolve() }; },
    start(job, track) { commands.push({ track, providerId: job.providerId }); job.state = commands.length === 1 ? 'unmatched' : 'matched'; job.active = false; job.lastPlayer = wrong; },
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
function observe(queue, first = manual(1000), second = manual(2000)) {
  assert.equal(queue.observePlayer('echo', first), false);
  return queue.observePlayer('echo', second);
}

test('a manually corrected fifth song inserts as sixth and keeps every history/pending/cycle item', async t => {
  const c = await fixture(t), before = c.queue.status(), pending = before.items.slice(5).map(item => item.id), history = before.items.slice(0, 5).map(item => item.id);
  assert.equal(observe(c.queue), true); await flush();
  const after = c.queue.status();
  assert.equal(after.id, before.id); assert.equal(after.index, 5); assert.equal(after.total, 11); assert.equal(after.currentTrack.title, target); assert.equal(after.currentTrack.adopted, true);
  assert.equal(after.currentProviderName, 'Spotify'); assert.equal(after.providerId, 'apple-music');
  assert.deepEqual(after.items.slice(0, 5).map(item => item.id), history); assert.deepEqual(after.items.slice(6).map(item => item.id), pending);
  assert.equal(c.queue.current.cycleTracks[5].id, after.currentTrack.id); assert.equal(after.repeatAll, true); assert.equal(c.commands.length, 1);
  await c.queue.control('next', { queueId: after.id }); await flush();
  assert.equal(c.commands.at(-1).track.title, 'Song 6'); assert.equal(c.commands.at(-1).providerId, 'apple-music');
});

test('an adopted manual song advances naturally to the original sixth song', async t => {
  const c = await fixture(t); assert.equal(observe(c.queue), true); await flush();
  c.setLive(manual(299500)); await c.monitor.step();
  assert.equal(c.commands.at(-1).track.title, 'Song 6'); assert.equal(c.queue.status().index, 6);
});

test('stale failed audio and incomplete, paused or nonadvancing manual metadata cannot be adopted', async t => {
  const c = await fixture(t);
  for (const value of [wrong, manual(1000, { artist: '' }), manual(1000, { providerName: '' }), manual(1000, { durationMs: undefined }), manual(1000, { positionMs: NaN }), manual(1000, { state: 'PAUSED' })]) {
    assert.equal(c.queue.observePlayer('echo', value), false); assert.equal(c.queue.observePlayer('echo', value), false);
  }
  assert.equal(observe(c.queue, manual(1000), manual(1000)), false); assert.equal(c.queue.status().total, 10); assert.equal(c.commands.length, 1);
  assert.equal(c.queue.observePlayer('echo', manual(2000)), true);
});

test('explicit cancel and Next invalidate delayed recovery observations', async t => {
  const c = await fixture(t); const oldRecovery = c.queue.current.manualRecovery;
  c.queue.observePlayer('echo', manual(1000));
  await c.queue.control('next'); await flush();
  assert.notEqual(c.queue.current.manualRecovery, oldRecovery);
  c.queue.observePlayer('echo', manual(2000)); assert.equal(c.queue.status().total, 10);
  c.queue.cancel(); assert.equal(c.queue.observePlayer('echo', manual(3000)), false); assert.equal(c.queue.status().total, 10);
});

test('custom commands preserve the queue while only newly observed advancing audio is inserted', async t => {
  const c = await fixture(t), before = c.queue.status();
  const response = await c.queue.customCommand('echo', 'Play the correct song');
  assert.equal(response.status, 'sent'); assert.equal(response.queue.id, before.id); assert.equal(response.queue.active, true); assert.equal(response.queue.state, 'needs_attention');
  assert.equal(c.custom.length, 1); assert.equal(observe(c.queue), true); assert.equal(c.queue.status().total, 11);
});

test('passive polling continues with backoff and can adopt after its fast polling phase', async t => {
  const c = await fixture(t); c.setLive(wrong);
  await c.adoption.step(); await c.adoption.step();
  assert.ok(c.adoption.pending.some(item => !item.done && item.ms === 15000));
  c.setLive(manual(1000)); await c.adoption.step(); c.setLive(manual(2000)); await c.adoption.step();
  assert.equal(c.queue.status().currentTrack.adopted, true); assert.equal(c.queue.status().total, 11);
});

test('a weather command resumes monitoring an unchanged previously confirmed song without inserting it again', async t => {
  const c = await fixture(t), current = manual(10000, { providerName: 'Apple Music', mediaId: 'confirmed' });
  const job = c.queue.current;
  job.matched = true; job.state = 'playing'; job.verifiedProvider = 'applemusic';
  job.progress = { mediaId: current.mediaId, actualProvider: 'applemusic', position: 10000, duration: 300000, progressed: true, nearEnd: false };
  c.setLive(current);
  await c.queue.customCommand('echo', 'What is the weather?');
  assert.equal(c.queue.observePlayer('echo', { ...current, state: 'PAUSED' }), false);
  assert.equal(c.queue.observePlayer('echo', { ...current, state: 'PAUSED' }), false);
  assert.equal(c.queue.status().state, 'needs_attention');
  assert.equal(observe(c.queue, { ...current, positionMs: 11000 }, { ...current, positionMs: 12000 }), true); await flush();
  assert.equal(c.queue.status().state, 'playing'); assert.equal(c.queue.status().index, 4); assert.equal(c.queue.status().total, 10);
  assert.equal(c.queue.status().currentTrack.adopted, false); assert.equal(c.commands.length, 1); assert.equal(c.queue.status().manualRecovery, false);
  c.setLive({ ...current, positionMs: 299500 }); await c.monitor.step();
  assert.equal(c.commands.at(-1).track.title, 'Song 6');
});

test('a non-music command cannot mark unchanged failed audio as a confirmed queue song', async t => {
  const c = await fixture(t);
  await c.queue.customCommand('echo', 'What is the weather?');
  assert.equal(observe(c.queue, { ...wrong, positionMs: 11000 }, { ...wrong, positionMs: 12000 }), false);
  assert.equal(c.queue.status().state, 'needs_attention'); assert.equal(c.queue.current.matched, false); assert.equal(c.queue.status().total, 10);
});

test('a verified paused queue stays paused after a non-music command without an audio command or duplicate', async t => {
  const c = await fixture(t), current = manual(10000, { state: 'PAUSED', providerName: 'Apple Music', mediaId: 'confirmed' });
  const job = c.queue.current; job.matched = true; job.state = 'paused'; job.verifiedProvider = 'applemusic';
  job.progress = { mediaId: current.mediaId, actualProvider: 'applemusic', position: 10000, duration: 300000, progressed: false, nearEnd: false };
  c.setLive(current); await c.queue.customCommand('echo', 'What time is it?');
  assert.equal(observe(c.queue, current, current), true);
  assert.equal(c.queue.status().state, 'paused'); assert.equal(c.queue.status().total, 10); assert.equal(c.commands.length, 1);
});
