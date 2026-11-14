import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaylistQueue } from '../playlist-queue.mjs';
import { AppError } from '../errors.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const song = (title = 'Next Song', extra = {}) => ({ id: `source-${title}`, title, artist: 'Next Artist', requestArtist: 'Canonical Artist', requestArtists: ['Canonical Artist', 'Guest Artist'], album: 'Album', source: 'itunes', country: 'IN', durationMs: 200000, url: 'https://music.apple.com/in/album/example/123?i=456', ...extra });
const current = (positionMs = 1000, extra = {}) => ({ state: 'PLAYING', title: 'Current Song', artist: 'Earth, Wind & Fire', durationMs: 300000, positionMs, providerName: 'Apple Music', mediaId: 'current-media', ...extra });
function setup({ initial = current(), matched = true, connected = true } = {}) {
  let time = 1000, sequence = 0, live = initial, online = connected;
  const reads = [], observations = [], sleepers = [], commands = [], controls = [], cancellations = [], seeks = [];
  const bridge = { generation: 1,
    requireDevice(id) { if (!online) throw new AppError(409, 'NOT_CONNECTED', 'Connect an Echo.'); if (id !== 'echo1') throw new AppError(400, 'INVALID_DEVICE', 'Choose an Echo.'); },
    async freshPlayer(id) { reads.push(id); return { player: await (observations.length ? observations.shift() : live) }; },
  };
  const playback = { intent: 0, current: null,
    status() { return this.current ? { id: this.current.id, state: this.current.state, active: this.current.active, reportedProviderName: 'Spotify' } : null; },
    cancel(message, id = null) {
      if (id && this.current?.id !== id) return this.status(); ++this.intent; cancellations.push(this.current?.id ?? null);
      if (this.current?.active) { this.current.state = 'cancelled'; this.current.active = false; this.current.done.resolve(); }
      return this.status();
    },
    reserve(options) { this.cancel('replace'); const done = deferred(); return this.current = { ...options, id: `music${++sequence}`, state: 'preparing', active: true, done, task: done.promise }; },
    start(job, track) { commands.push({ track: { ...track }, providerId: job.providerId, deviceId: job.deviceId }); if (matched) { job.state = 'matched'; job.active = false; job.done.resolve(); } },
    async control(deviceId, action) { this.cancel('control'); controls.push({ deviceId, action }); return { status: 'sent' }; },
    async seek(deviceId, positionMs, expected) { seeks.push({ deviceId, positionMs, expected }); return { status: 'sent', targetPositionMs: positionMs }; },
  };
  const sleep = (ms, signal) => new Promise(resolve => {
    const item = { done: false, release() { if (item.done) return; item.done = true; time += ms; signal?.removeEventListener('abort', item.release); resolve(); } };
    sleepers.push(item); if (signal?.aborted) item.release(); else signal?.addEventListener('abort', item.release, { once: true });
  });
  const queue = new PlaylistQueue({ bridge, playback, clock: () => time, sleep, pollMs: 10 });
  const add = (track = song(), extra = {}) => queue.enqueue({ track, placement: 'last', deviceId: 'echo1', providerId: 'spotify', country: 'IN', ...extra });
  const step = async value => { observations.push(value); const pending = sleepers.find(item => !item.done); assert.ok(pending, 'monitor must be waiting'); pending.release(); await flush(); };
  const local = tracks => ({ id: 'local1', name: 'My saved songs', country: 'IN', source: 'local', tracks });
  return { queue, bridge, playback, add, step, local, reads, observations, commands, controls, cancellations, seeks, sleepers, setLive: value => { live = value; }, setConnected: value => { online = value; } };
}

test('adding to a playing Echo adopts its current song without sending any music command', async () => {
  const c = setup(); const result = await c.add(); await flush();
  assert.equal(c.commands.length, 0); assert.equal(c.playback.intent, 0); assert.equal(c.cancellations.length, 0);
  assert.equal(result.queue.state, 'playing'); assert.equal(result.queue.currentTrack.title, 'Current Song');
  assert.equal(result.queue.currentTrack.adopted, true); assert.equal(result.queue.currentProviderName, 'Apple Music');
  assert.deepEqual(result.queue.items.map(item => item.state), ['current', 'pending']);
  const adopted = c.queue.getTrack(result.queue.currentTrack.id, result.queue.id);
  assert.equal(adopted.requestArtist, 'Earth, Wind & Fire'); assert.deepEqual(adopted.requestArtists, ['Earth, Wind & Fire']);
  await c.step(current(299500));
  assert.equal(c.commands.length, 1); assert.equal(c.commands[0].track.title, 'Next Song');
  assert.equal(c.commands[0].providerId, 'spotify'); c.queue.cancel();
});

test('Play next is LIFO and Add to queue is FIFO without restarting or invalidating the current monitor', async () => {
  const c = setup(); await c.add(song('A')); await flush(); const revision = c.queue.current.revision, intent = c.playback.intent;
  await c.add(song('B')); await c.add(song('X'), { placement: 'next' }); await c.add(song('Y'), { placement: 'next' });
  assert.deepEqual(c.queue.status().items.map(item => item.title), ['Current Song', 'Y', 'X', 'A', 'B']);
  assert.equal(c.queue.current.revision, revision); assert.equal(c.playback.intent, intent); assert.equal(c.commands.length, 0);
  await c.step(current(299500)); assert.equal(c.commands[0].track.title, 'Y'); c.queue.cancel();
});

test('duplicates get distinct queue item IDs and stored canonical artists survive enqueue', async () => {
  const c = setup(); await c.add(); await c.add(); const snapshot = c.queue.status();
  assert.notEqual(snapshot.items[1].id, snapshot.items[2].id);
  assert.equal(new Set(snapshot.items.map(item => item.id)).size, 3);
  const trusted = c.queue.getTrack(snapshot.items[1].id, snapshot.id);
  assert.equal(trusted.requestArtist, 'Canonical Artist'); assert.deepEqual(trusted.requestArtists, ['Canonical Artist', 'Guest Artist']);
  trusted.requestArtists[0] = 'Mutation'; snapshot.items[1].title = 'Mutation';
  assert.equal(c.queue.getTrack(trusted.id, snapshot.id).requestArtists[0], 'Canonical Artist');
  assert.equal(c.queue.status().items[1].title, 'Next Song'); c.queue.cancel();
});

test('paused adoption waits silently and resumes the actual service before playing queued target service', async () => {
  const c = setup({ initial: current(1000, { state: 'PAUSED' }) }); await c.add();
  assert.equal(c.queue.status().state, 'paused'); assert.equal(c.commands.length, 0); assert.equal(c.controls.length, 0);
  assert.equal(c.sleepers.filter(item => !item.done).length, 0);
  await c.queue.control('resume'); await flush(); assert.deepEqual(c.controls, [{ deviceId: 'echo1', action: 'resume' }]);
  assert.equal(c.commands.length, 0); await c.step(current(299500));
  assert.equal(c.commands[0].providerId, 'spotify'); assert.equal(c.commands[0].track.title, 'Next Song'); c.queue.cancel();
});

test('adopted current seeking validates its actual provider even when queued service differs', async () => {
  const c = setup(); await c.add(); await flush(); c.observations.push(current(60000));
  const result = await c.queue.seek('echo1', 60000, { title: 'Current Song', artist: 'Earth, Wind & Fire', providerName: 'Apple Music', mediaId: 'current-media', durationMs: 300000 });
  assert.equal(result.seekVerified, true); assert.equal(c.commands.length, 0); assert.equal(c.seeks.length, 1);
  assert.equal(c.queue.status().providerId, 'spotify'); assert.equal(c.queue.status().currentProviderName, 'Apple Music'); c.queue.cancel();
});

test('retrying an adopted song clears its adopted service identity when it becomes a selected-service request', async () => {
  const c = setup(); await c.add(); await flush(); await c.step(current(1000, { title: 'Other song' }));
  assert.equal(c.queue.status().state, 'needs_attention');
  await c.queue.control('resume'); await flush();
  assert.equal(c.commands.length, 1); assert.equal(c.commands[0].track.title, 'Current Song'); assert.equal(c.commands[0].providerId, 'spotify');
  assert.equal(c.queue.status().currentTrack.adopted, false); assert.equal(c.queue.status().currentProviderName, null);
  assert.equal(c.queue.providerFor(c.queue.current), 'spotify'); c.queue.cancel();
});

test('no Echo or stopped audio creates a ready queue that only explicit Start plays', async () => {
  for (const noDevice of [false, true]) {
    const c = setup({ initial: { state: 'STOPPED' }, connected: !noDevice });
    const result = await c.add(song(), { deviceId: noDevice ? null : 'echo1' }); await flush();
    assert.equal(result.queue.state, 'ready'); assert.equal(result.queue.active, true);
    assert.equal(result.queue.deviceId, null); assert.equal(result.queue.currentTrack, null); assert.equal(result.queue.items[0].state, 'pending');
    assert.equal(c.commands.length, 0); assert.equal(c.playback.intent, 0);
    c.setConnected(true); await c.queue.control('start', { deviceId: 'echo1', providerId: 'spotify', country: 'IN', queueId: result.queue.id }); await flush();
    assert.equal(c.commands.length, 1); assert.equal(c.commands[0].track.title, 'Next Song'); assert.equal(c.commands[0].deviceId, 'echo1'); c.queue.cancel();
  }
});

test('unknown or live playing audio is never adopted or interrupted automatically', async () => {
  for (const initial of [current(1000, { artist: '' }), current(1000, { durationMs: undefined }), current(1000, { providerName: undefined }), { state: 'UNKNOWN' }]) {
    const c = setup({ initial }); const result = await c.add(); await flush();
    assert.equal(result.queue.state, 'ready'); assert.equal(result.queue.currentTrack, null); assert.equal(c.commands.length, 0);
    assert.equal(c.controls.length, 0); assert.equal(c.playback.intent, 0); c.queue.cancel();
  }
});

test('ready queues ignore intervening playback intent until explicit Start and retain their items', async () => {
  const c = setup({ initial: { state: 'STOPPED' } }); const result = await c.add();
  c.playback.cancel('Echo reconnect'); ++c.bridge.generation;
  assert.equal(c.queue.status().state, 'ready'); assert.equal(c.queue.status().items.length, 1);
  await c.add(song('Second'), { deviceId: null, queueId: result.queue.id });
  await c.queue.control('start', { queueId: result.queue.id, deviceId: 'echo1', providerId: 'spotify', country: 'IN' }); await flush();
  assert.equal(c.commands.length, 1); assert.equal(c.queue.status().items.length, 2); c.queue.cancel();
});

test('pending remove and reorder keep current playback intent and monitor generation unchanged', async () => {
  const c = setup(); await c.add(song('A')); await c.add(song('B')); await c.add(song('C')); await flush();
  const before = c.queue.status(), [playing, a, b, d] = before.items, revision = c.queue.current.revision, intent = c.playback.intent;
  c.queue.move({ itemId: d.id, beforeItemId: a.id, queueId: before.id }); c.queue.remove({ itemId: b.id, queueId: before.id });
  assert.deepEqual(c.queue.status().items.map(item => item.title), ['Current Song', 'C', 'A']);
  assert.equal(c.queue.current.revision, revision); assert.equal(c.playback.intent, intent); assert.equal(c.commands.length, 0);
  assert.throws(() => c.queue.remove({ itemId: playing.id, queueId: before.id }), { code: 'QUEUE_ITEM_CURRENT' });
  assert.throws(() => c.queue.move({ itemId: a.id, beforeItemId: playing.id, queueId: before.id }), { code: 'QUEUE_ITEM_CURRENT' });
  await c.step(current(299500)); assert.equal(c.commands[0].track.title, 'C'); c.queue.cancel();
});

test('ready queue edits include the first pending item and deleting the last item leaves no active queue', async () => {
  const c = setup({ initial: { state: 'STOPPED' } }); await c.add(song('A')); await c.add(song('B'));
  let q = c.queue.status(); c.queue.move({ itemId: q.items[0].id, beforeItemId: null, queueId: q.id });
  assert.deepEqual(c.queue.status().items.map(item => item.title), ['B', 'A']);
  for (const item of c.queue.status().items) c.queue.remove({ itemId: item.id, queueId: q.id });
  q = c.queue.status(); assert.equal(q.items.length, 0); assert.equal(q.total, 0); assert.equal(q.active, false); assert.equal(c.commands.length, 0);
});

test('Clear queue removes pending songs and leaves current audio untouched; ready clear is empty', async () => {
  for (const ready of [false, true]) {
    const c = setup({ initial: ready ? { state: 'STOPPED' } : current() }); await c.add(); await c.add(song('Another'));
    const result = await c.queue.control('clear', { queueId: c.queue.status().id });
    assert.equal(result.queue.active, false); assert.equal(result.queue.items.filter(item => item.state === 'pending').length, 0);
    assert.equal(result.queue.items.length, ready ? 0 : 1); assert.equal(c.commands.length, 0); assert.equal(c.controls.length, 0);
  }
});

test('active queue mutations reject wrong country, device, provider, IDs or track metadata before changing playback', async () => {
  const c = setup(); await c.add(); await flush(); const before = c.queue.status(), revision = c.queue.current.revision;
  for (const extra of [{ country: 'US' }, { deviceId: 'echo2' }, { providerId: 'apple-music' }, { queueId: 'other' }, { placement: 'invalid' }, { track: song('Bad', { artist: 'A\nB' }) }, { providerId: 'tunein' }]) {
    await assert.rejects(c.add(song(), extra)); assert.deepEqual(c.queue.status().items, before.items);
  }
  assert.throws(() => c.queue.remove({ itemId: before.items[1].id, queueId: 'other' }), { code: 'QUEUE_CHANGED' });
  assert.throws(() => c.queue.move({ itemId: before.items[1].id, beforeItemId: 'missing', queueId: before.id }), { code: 'QUEUE_ITEM_NOT_FOUND' });
  assert.throws(() => c.queue.getTrack(before.items[1].id, 'other'), { code: 'QUEUE_CHANGED' });
  assert.equal(c.queue.current.revision, revision); assert.equal(c.playback.intent, 0); assert.equal(c.commands.length, 0); c.queue.cancel();
});

test('initial adoption rejects active external verification rather than capturing its old current song', async () => {
  const c = setup({ matched: false }); const external = c.playback.reserve({ deviceId: 'echo1' }); c.playback.start(external, song('Being checked'));
  const intent = c.playback.intent; await assert.rejects(c.add(), { code: 'QUEUE_WAIT_FOR_SONG' });
  assert.equal(c.queue.status(), null); assert.equal(c.reads.length, 0); assert.equal(c.playback.intent, intent); assert.equal(external.active, true);
});

test('appending to an owned queue during verification is safe and does not cancel its request', async () => {
  const c = setup({ matched: false });
  c.queue.startLocal({ playlist: c.local([song('A')]), deviceId: 'echo1', providerId: 'spotify', country: 'IN' }); await flush();
  const intent = c.playback.intent, id = c.playback.current.id;
  await c.add(song('B')); assert.equal(c.playback.intent, intent); assert.equal(c.playback.current.id, id); assert.equal(c.playback.current.active, true);
  assert.equal(c.queue.status().total, 2); assert.equal(c.commands.length, 1); c.queue.cancel();
});

test('outside playback, Clear or Cancel during adoption cannot install a stale new queue', async () => {
  for (const action of ['outside', 'clear', 'cancel']) {
    const read = deferred(); const c = setup(); c.observations.push(read.promise);
    const operation = assert.rejects(c.add(), { code: 'PLAYBACK_CHANGED' }); await flush();
    if (action === 'outside') { const job = c.playback.reserve({ deviceId: 'echo1' }); c.playback.start(job, song('Outside')); }
    else if (action === 'clear') await c.queue.control('clear'); else c.queue.cancel();
    const intent = c.playback.intent; read.resolve(current()); await operation;
    assert.equal(c.queue.status(), null); assert.equal(c.playback.intent, intent);
  }
});

test('two concurrent initial additions cannot overwrite each other after adoption reads', async () => {
  const first = deferred(), second = deferred(); const c = setup(); c.observations.push(first.promise, second.promise);
  const a = c.add(song('A')), b = assert.rejects(c.add(song('B')), { code: 'PLAYBACK_CHANGED' }); await flush();
  first.resolve(current()); await a; second.resolve(current()); await b;
  assert.deepEqual(c.queue.status().items.map(item => item.title), ['Current Song', 'A']); assert.equal(c.commands.length, 0); c.queue.cancel();
});

test('local playlist starts from stable selected entry and preserves prepared artist snapshots without catalogue lookup', async () => {
  const c = setup(); const a = song('A'), b = song('B'), d = song('C');
  const result = c.queue.startLocal({ playlist: c.local([a, b, d]), startEntryId: b.id, deviceId: 'echo1', providerId: 'spotify', country: 'IN' }); await flush();
  assert.equal(result.queue.total, 3); assert.deepEqual(c.queue.status().items.map(item => item.title), ['B', 'C', 'A']);
  assert.equal(c.commands[0].track.requestArtist, 'Canonical Artist'); assert.deepEqual(c.commands[0].track.requestArtists, ['Canonical Artist', 'Guest Artist']);
  assert.notEqual(c.commands[0].track.id, b.id); assert.equal(c.reads.length, 0); c.queue.cancel();
});

test('invalid local playlist or ready Start validation never cancels existing playback', async () => {
  const c = setup(); await c.add(); const before = c.queue.status(), intent = c.playback.intent;
  const args = { playlist: c.local([song()]), deviceId: 'echo1', providerId: 'spotify', country: 'IN' };
  for (const extra of [{ country: 'US' }, { startEntryId: 'missing' }, { playlist: c.local([song('Bad', { artist: '' })]) }, { providerId: 'tunein' }, { deviceId: 'echo2' }]) assert.throws(() => c.queue.startLocal({ ...args, ...extra }));
  assert.equal(c.queue.status().id, before.id); assert.equal(c.playback.intent, intent); assert.equal(c.commands.length, 0); c.queue.cancel();
  const d = setup({ initial: { state: 'STOPPED' } }); await d.add();
  await assert.rejects(d.queue.control('start', { deviceId: 'echo1', country: 'US', providerId: 'spotify' }), { code: 'QUEUE_CONTEXT_CHANGED' });
  await assert.rejects(d.queue.control('resume'), { code: 'QUEUE_NOT_STARTED' });
  assert.equal(d.queue.status().state, 'ready'); assert.equal(d.commands.length, 0); d.queue.cancel();
});

test('native playlist handoff discards all old queue entries without a playback control', async () => {
  for (const state of ['playing', 'ready', 'cancelled']) {
    const c = setup({ initial: state === 'ready' ? { state: 'STOPPED' } : current() });
    await c.add(); await c.add(song('Old tail')); await flush();
    if (state === 'cancelled') c.queue.cancel('Replaced by a direct playlist.');
    const id = c.queue.status().id;
    const result = c.queue.clear(id, { keepCurrent: false }); await flush();
    assert.equal(result.queue, null); assert.equal(c.queue.status(), null);
    assert.equal(c.commands.length, 0); assert.equal(c.controls.length, 0);
    assert.equal(c.queue.observePlayer('echo1', current(2000)), false);
  }
});

test('two stable advancing outside-song observations clear an app queue without controlling Echo', async () => {
  for (const mode of ['playing', 'paused', 'cancelled', 'ready']) {
    const c = setup({ initial: current(1000, { state: mode === 'ready' ? 'STOPPED' : mode === 'paused' ? 'PAUSED' : 'PLAYING' }) }); await c.add(); await flush();
    if (mode === 'cancelled') c.queue.cancel();
    const outside = { ...current(), title: 'Voice-requested song', artist: 'Outside artist', mediaId: 'outside' };
    assert.equal(c.queue.observePlayer('other', outside), false);
    assert.equal(c.queue.observePlayer('echo1', outside), false); assert.ok(c.queue.status());
    assert.equal(c.queue.observePlayer('echo1', outside), false); assert.ok(c.queue.status());
    assert.equal(c.queue.observePlayer('echo1', { ...outside, positionMs: 2000 }), true);
    assert.equal(c.queue.status(), null); assert.equal(c.commands.length, 0); assert.equal(c.controls.length, 0);
  }
});

test('own playback, missing metadata and unstable outside samples do not clear the queue', async () => {
  const c = setup(); await c.add(); await flush(); const id = c.queue.status().id;
  assert.equal(c.queue.observePlayer('echo1', current(2000)), false);
  const outside = { ...current(), title: 'Outside song', artist: 'Outside artist', mediaId: 'outside' };
  c.queue.observePlayer('echo1', outside); c.queue.observePlayer('echo1', { ...outside, artist: '' });
  assert.equal(c.queue.observePlayer('echo1', { ...outside, positionMs: 2000 }), false);
  assert.equal(c.queue.status().id, id); c.queue.cancel();
});

test('the helper monitor confirms an outside takeover even without a player UI poll', async () => {
  const c = setup(); await c.add(); await flush();
  const outside = { ...current(), title: 'Outside song', artist: 'Other artist', mediaId: 'new' };
  await c.step(outside); assert.equal(c.queue.status().state, 'needs_attention');
  await c.step({ ...outside, positionMs: 2000 }); assert.equal(c.queue.status(), null);
  assert.equal(c.commands.length, 0); assert.equal(c.controls.length, 0);
});
