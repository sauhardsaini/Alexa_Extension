import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaylistQueue } from '../playlist-queue.mjs';
import { PlaybackCoordinator } from '../playback.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const playlist = (count = 2) => ({ id: 'list1', title: 'My playlist', source: 'youtube-music', tracks: Array.from({ length: count }, (_, index) => ({ id: `track${index}`, title: `Song ${index}`, artist: `Artist ${index}`, needsReview: false })) });
const player = (index = 0, positionMs = 0, extra = {}) => ({ state: 'PLAYING', title: `Song ${index}`, artist: `Artist ${index}`, providerName: 'Spotify', mediaId: `media${index}`, durationMs: 300000, positionMs, ...extra });

function setup({ read, control } = {}) {
  let time = 1000, sequence = 0;
  const sleepers = [], reads = [], commands = [], controls = [], cancellations = [], reservations = [];
  const bridge = {
    requireDevice(id) { if (id !== 'echo1') throw new Error('invalid device'); },
    async freshPlayer(id) { reads.push(id); return { player: read ? await read(reads.length) : observations.shift() ?? { state: 'UNKNOWN' } }; },
  };
  const observations = [];
  const playback = {
    current: null, intent: 0,
    status() { return this.current ? { id: this.current.id, state: this.current.state, active: this.current.active, reportedProviderName: this.current.reportedProviderName } : null; },
    cancel(message, requestId = null) {
      if (requestId && this.current?.id !== requestId) return this.status();
      ++this.intent;
      cancellations.push(this.current?.id ?? null);
      if (this.current?.active) { this.current.active = false; this.current.state = 'cancelled'; this.current.done.resolve(); }
      return this.status();
    },
    reserve({ deviceId, country, providerId, trackHint }) {
      this.cancel('replace');
      const done = deferred();
      this.current = { id: `music${++sequence}`, deviceId, country, providerId, trackHint, active: true, state: 'preparing', done, task: done.promise };
      reservations.push(this.current);
      return this.current;
    },
    start(job, track) {
      commands.push({ track, deviceId: job.deviceId, providerId: job.providerId, country: job.country });
      job.state = 'checking';
      return { status: 'sent', requestId: job.id };
    },
    async control(deviceId, action) {
      this.cancel('control');
      controls.push({ deviceId, action });
      return control ? await control(action) : { status: 'sent' };
    },
  };
  const sleep = (ms, signal) => new Promise(resolve => {
    const entry = { done: false, release: () => { if (entry.done) return; entry.done = true; time += ms; signal?.removeEventListener('abort', entry.release); resolve(); } };
    sleepers.push(entry);
    if (signal?.aborted) entry.release(); else signal?.addEventListener('abort', entry.release, { once: true });
  });
  const queue = new PlaylistQueue({ bridge, playback, clock: () => time, sleep, pollMs: 10 });
  const start = (extra = {}) => queue.start({ playlist: playlist(), deviceId: 'echo1', providerId: 'spotify', country: 'IN', ...extra });
  const complete = async (state = 'matched', job = playback.current) => { job.state = state; job.active = false; job.done.resolve(); await flush(); };
  const step = async value => {
    observations.push(value);
    const pending = sleepers.find(entry => !entry.done);
    assert.ok(pending, 'a monitor sleep must be pending');
    pending.release();
    await flush();
  };
  return { queue, playback, bridge, start, complete, step, commands, controls, cancellations, reservations, reads, sleepers, observations };
}

test('returns immediately, confirms one song at a time and exposes only safe copied status', async () => {
  const context = setup();
  const source = playlist();
  const { queue } = context.start({ playlist: source });
  assert.equal(queue.index, 0);
  assert.equal(queue.state, 'preparing');
  assert.equal(queue.playbackRequestId, null);
  assert.equal(queue.deviceId, 'echo1');
  source.tracks[0].title = 'Mutation';
  await flush();
  assert.equal(context.commands.length, 1);
  assert.equal(context.commands[0].track.title, 'Song 0');
  assert.equal(context.reads.length, 0);
  assert.deepEqual(context.commands[0].track.requestArtists, ['Artist 0']);
  assert.equal(context.commands[0].track.durationMs, 0);
  assert.equal(context.queue.status().playbackRequestId, 'music1');
  const copy = context.queue.status();
  copy.currentTrack.title = 'Another mutation';
  assert.equal(context.queue.status().currentTrack.title, 'Song 0');
  assert.equal(JSON.stringify(copy).includes('expectedIntent'), false);
  await context.complete();
  assert.equal(context.queue.status().state, 'playing');
  assert.equal(context.commands.length, 1);
  context.queue.cancel();
});

test('actual progressing position within one second of the end advances one song', async () => {
  const context = setup();
  context.start(); await flush(); await context.complete();
  await context.step(player(0, 1000));
  assert.equal(context.commands.length, 1);
  await context.step(player(0, 299200));
  assert.equal(context.commands.length, 2);
  assert.equal(context.queue.status().index, 1);
  assert.equal(context.queue.status().playbackRequestId, 'music2');
  assert.ok(context.commands.every(command => command.providerId === 'spotify' && command.country === 'IN'));
  context.queue.cancel();
});

test('STOPPED only advances after observed progressing position near the end', async () => {
  for (const nearEnd of [false, true]) {
    const context = setup();
    context.start(); await flush(); await context.complete();
    await context.step(player(0, 1000));
    await context.step(player(0, nearEnd ? 296000 : 2000));
    await context.step({ state: 'STOPPED' });
    assert.equal(context.commands.length, nearEnd ? 2 : 1);
    assert.equal(context.queue.status().state, nearEnd ? 'preparing' : 'needs_attention');
    context.queue.cancel();
  }
});

test('changed tracks hold both early and near the end without guessing that the song ended', async () => {
  for (const nearEnd of [false, true]) {
    const context = setup();
    context.start(); await flush(); await context.complete();
    await context.step(player(0, 1000));
    await context.step(player(0, nearEnd ? 296000 : 2000));
    await context.step(player(9));
    assert.equal(context.commands.length, 1);
    assert.equal(context.queue.status().state, 'needs_attention');
    context.queue.cancel();
  }
});

test('late media changes, progress resets and actual provider changes always hold', async () => {
  const cases = [
    { value: player(0, 299500, { mediaId: 'different-recording' }), providerId: 'spotify' },
    { value: player(0, 0), providerId: 'spotify' },
    { value: player(0, 299500, { providerName: 'Apple Music' }), providerId: 'alexa-default' },
    { value: { state: 'STOPPED', mediaId: 'different-recording' }, providerId: 'spotify' },
  ];
  for (const { value, providerId } of cases) {
    const context = setup();
    context.start({ providerId }); await flush(); await context.complete();
    await context.step(player(0, 1000));
    await context.step(player(0, 296000));
    await context.step(value);
    assert.equal(context.queue.status().state, 'needs_attention');
    assert.equal(context.commands.length, 1);
    assert.equal(context.queue.current.matched, false);
    context.queue.cancel();
  }
});

test('actual provider from coordinator confirmation is bound before the first monitor read', async () => {
  const context = setup();
  context.start({ providerId: 'alexa-default' }); await flush();
  context.playback.current.reportedProviderName = 'Spotify';
  await context.complete();
  await context.step(player(0, 299500, { providerName: 'Apple Music' }));
  assert.equal(context.queue.status().state, 'needs_attention');
  assert.equal(context.commands.length, 1);
  context.queue.cancel();
});

test('unknown metadata holds after bounded reads without advancing or spinning', async () => {
  const context = setup();
  context.start(); await flush(); await context.complete();
  for (let index = 0; index < 3; index++) await context.step({ state: 'UNKNOWN' });
  await context.queue.current.task;
  assert.equal(context.queue.status().state, 'needs_attention');
  assert.equal(context.queue.status().active, true);
  assert.equal(context.reads.length, 3);
  assert.equal(context.commands.length, 1);
  assert.equal(context.sleepers.filter(entry => !entry.done).length, 0);
  context.queue.cancel();
});

test('missing song progress never uses catalogue duration or an elapsed timer to advance', async () => {
  const context = setup();
  context.start(); await flush(); await context.complete();
  for (let index = 0; index < 3; index++) await context.step(player(0, undefined, { durationMs: undefined }));
  assert.equal(context.queue.status().state, 'needs_attention');
  assert.equal(context.commands.length, 1);
  context.queue.cancel();
});

test('stalled progress holds after bounded reads instead of looping forever', async () => {
  const context = setup();
  context.start(); await flush(); await context.complete();
  for (let index = 0; index < 7; index++) await context.step(player(0, 1000));
  await context.queue.current.task;
  assert.equal(context.queue.status().state, 'needs_attention');
  assert.equal(context.commands.length, 1);
  context.queue.cancel();
});

test('unconfirmed coordinator result holds; user Next explicitly continues', async () => {
  const context = setup();
  context.start(); await flush(); await context.complete('unmatched');
  assert.equal(context.queue.status().state, 'needs_attention');
  assert.equal(context.commands.length, 1);
  const result = await context.queue.control('next');
  assert.equal(result.status, 'sent');
  await flush();
  assert.equal(context.commands.length, 2);
  assert.equal(context.queue.status().index, 1);
  context.queue.cancel();
});

test('physical pause holds indefinitely; Resume monitors the verified song without restarting it', async () => {
  const context = setup();
  context.start({ playlist: playlist(1) }); await flush(); await context.complete();
  await context.step(player(0, 1000));
  await context.step(player(0, 1000, { state: 'PAUSED' }));
  await context.queue.current.task;
  assert.equal(context.queue.status().state, 'paused');
  assert.equal(context.controls.length, 0);
  assert.equal(context.sleepers.filter(entry => !entry.done).length, 0);
  context.observations.push(player(0, 1000, { state: 'PAUSED' }));
  await context.queue.control('resume'); await flush();
  assert.deepEqual(context.controls, [{ deviceId: 'echo1', action: 'resume' }]);
  assert.equal(context.commands.length, 1);
  await context.step(player(0, 299500));
  assert.equal(context.queue.status().state, 'completed');
  assert.equal(context.queue.status().active, false);
  assert.equal(context.commands.length, 1);
});

test('Resume rechecks a held pause so a later voice takeover cannot resume unrelated music', async () => {
  const context = setup();
  context.start(); await flush(); await context.complete();
  await context.step(player(0, 1000));
  await context.step(player(0, 1000, { state: 'PAUSED' }));
  assert.equal(context.queue.status().state, 'paused');
  context.observations.push(player(9, 1000, { state: 'PAUSED' }));
  await context.queue.control('resume'); await flush();
  assert.equal(context.commands.length, 2);
  assert.equal(context.commands[1].track.title, 'Song 0');
  assert.equal(context.commands[1].providerId, 'spotify');
  assert.equal(context.controls.length, 0);
  context.queue.cancel();
});

test('unrelated or unidentified paused playback holds and Resume re-requests the selected song', async () => {
  const cases = [
    player(9, 1000, { state: 'PAUSED' }),
    player(0, 1000, { state: 'PAUSED', mediaId: 'different-recording' }),
    player(0, 1000, { state: 'PAUSED', mediaId: undefined }),
    player(0, 1000, { state: 'PAUSED', artist: '' }),
    player(0, 1000, { state: 'PAUSED', providerName: 'Apple Music' }),
    player(0, 1000, { state: 'PAUSED', providerName: undefined }),
    { state: 'PAUSED' },
  ];
  for (const paused of cases) {
    const context = setup();
    context.start({ providerId: 'alexa-default' }); await flush(); await context.complete();
    await context.step(player(0, 1000));
    await context.step(paused);
    assert.equal(context.queue.status().state, 'needs_attention');
    assert.equal(context.queue.current.matched, false);
    await context.queue.control('resume'); await flush();
    assert.equal(context.commands.length, 2);
    assert.equal(context.commands[1].track.title, 'Song 0');
    assert.equal(context.commands[1].providerId, 'alexa-default');
    assert.equal(context.controls.length, 0);
    context.queue.cancel();
  }
});

test('app Pause during verification cancels retries; Resume may verify the same track again', async () => {
  const context = setup();
  context.start(); await flush();
  const old = context.playback.current;
  await context.queue.control('pause');
  assert.equal(old.state, 'cancelled');
  assert.equal(context.queue.status().state, 'paused');
  await context.queue.control('resume'); await flush();
  assert.equal(context.commands.length, 2);
  assert.equal(context.commands[1].track.id, 'track0');
  assert.deepEqual(context.controls.map(row => row.action), ['pause']);
  context.queue.cancel();
});

test('Resume after an early wrong song re-requests the current selection without resuming the wrong recording', async () => {
  const context = setup();
  context.start(); await flush(); await context.complete();
  await context.step(player(9));
  assert.equal(context.queue.status().state, 'needs_attention');
  await context.queue.control('resume'); await flush();
  assert.equal(context.commands.length, 2);
  assert.equal(context.commands[1].track.title, 'Song 0');
  assert.equal(context.commands[1].providerId, 'spotify');
  assert.equal(context.queue.status().index, 0);
  assert.equal(context.queue.status().state, 'preparing');
  assert.equal(context.controls.length, 0);
  context.queue.cancel();
});

test('Next and Previous invalidate old verification tasks and retain provider selection', async () => {
  const context = setup();
  context.start(); await flush();
  const old = context.playback.current;
  await context.queue.control('next'); await flush();
  assert.equal(context.queue.status().index, 1);
  await context.complete('matched', old);
  assert.equal(context.queue.status().state, 'preparing');
  await context.queue.control('previous'); await flush();
  assert.equal(context.queue.status().index, 0);
  assert.deepEqual(context.commands.map(row => row.track.id), ['track0', 'track1', 'track0']);
  assert.ok(context.commands.every(row => row.providerId === 'spotify'));
  context.queue.cancel();
});

test('queue cancellation stops future verification without sending pause or stop', async () => {
  const context = setup();
  const initial = context.start(); await flush();
  assert.equal(context.queue.cancel('Old cancellation', 'other-id').active, true);
  const requestId = context.queue.status().playbackRequestId;
  const result = context.queue.cancel(undefined, requestId);
  assert.equal(result.state, 'cancelled');
  await context.complete();
  assert.equal(context.commands.length, 1);
  assert.equal(context.controls.length, 0);
  assert.equal(context.queue.status().id, initial.queue.id);
});

test('new external playback takes ownership; cancelling stale queue never cancels it', async () => {
  const context = setup();
  context.start(); await flush(); await context.complete();
  const other = context.playback.reserve({ deviceId: 'echo1', country: 'IN', providerId: 'apple-music', trackHint: {} });
  context.playback.start(other, { title: 'External', artist: 'Someone' });
  const before = context.cancellations.length;
  context.queue.cancel();
  assert.equal(other.active, true);
  assert.equal(context.cancellations.length, before);
  assert.equal(context.queue.status().state, 'cancelled');
});

test('external control invalidates even a matched job whose status ID stays the same', async () => {
  const context = setup();
  context.start(); await flush(); await context.complete();
  const originalId = context.playback.status().id;
  await context.playback.control('echo1', 'next');
  assert.equal(context.playback.status().id, originalId);
  const before = context.cancellations.length;
  assert.equal(context.queue.status().state, 'cancelled');
  context.queue.cancel();
  assert.equal(context.cancellations.length, before);
  await flush();
  assert.equal(context.commands.length, 1);
});

test('new queue and cancellation guard a stale in-flight Echo observation', async () => {
  const gate = deferred();
  const context = setup({ read: () => gate.promise });
  context.start(); await flush(); await context.complete();
  const pending = context.step(player());
  await flush();
  const old = context.queue.current;
  const replacement = playlist(1); replacement.id = 'replacement'; replacement.title = 'New queue';
  context.start({ playlist: replacement }); await flush();
  context.queue.cancel();
  gate.resolve(player(0, 299500)); await pending; await old.task;
  assert.equal(context.commands.length, 2);
  assert.equal(context.queue.status().title, 'New queue');
  assert.equal(context.queue.status().state, 'cancelled');
});

test('all validation completes before replacing the current queue', async () => {
  const context = setup();
  const first = context.start(); await flush();
  const invalid = [
    { edits: [{ id: 'foreign', artist: 'Person' }] },
    { edits: [{ id: 'track0', artist: 'Person\nCommand' }] },
    { edits: [{ id: 'track0', artist: 'Person', command: 'anything' }] },
    { edits: [{ id: 'track0', artist: 'A' }, { id: 'track0', title: 'B' }] },
    { playlist: { ...playlist(), source: 'spotify' } },
    { playlist: { ...playlist(), tracks: [] } },
    { playlist: playlist(501) },
    { playlist: { ...playlist(), tracks: [{ id: 'x', title: 'Song', artist: '', needsReview: true }] } },
    { country: 'ZZ' }, { providerId: 'youtube-music' }, { providerId: 'tunein' }, { deviceId: 'other' },
  ];
  const before = context.cancellations.length;
  for (const extra of invalid) {
    assert.throws(() => context.start(extra));
    assert.equal(context.queue.status().id, first.queue.id);
    assert.equal(context.queue.status().active, true);
  }
  assert.equal(context.cancellations.length, before);
  assert.equal(context.commands.length, 1);
  context.queue.cancel();
});

test('review edits resolve missing artist while preserving whole band names and song versions', async () => {
  const context = setup();
  const source = { ...playlist(1), tracks: [{ id: 'track0', title: 'The Song (Live)', artist: '', needsReview: true }] };
  context.start({ playlist: source, edits: [{ id: 'track0', artist: 'Earth, Wind & Fire' }] }); await flush();
  assert.equal(context.commands[0].track.title, 'The Song (Live)');
  assert.equal(context.commands[0].track.requestArtist, 'Earth, Wind & Fire');
  assert.deepEqual(context.commands[0].track.requestArtists, ['Earth, Wind & Fire']);
  context.queue.cancel();
});

test('explicit streaming service stays bound; unknown or wrong service cannot advance', async () => {
  for (const service of ['Apple Music', undefined]) {
    const context = setup();
    context.start(); await flush(); await context.complete();
    for (let index = 0; index < (service ? 1 : 3); index++) await context.step(player(0, 299500, { providerName: service }));
    assert.equal(context.queue.status().state, 'needs_attention');
    assert.equal(context.commands.length, 1);
    assert.equal(context.commands[0].providerId, 'spotify');
    context.queue.cancel();
  }
});

test('Alexa default accepts the actual reported service and completes without a service override', async () => {
  const context = setup();
  context.start({ playlist: playlist(1), providerId: 'alexa-default' }); await flush(); await context.complete();
  await context.step(player(0, 1000, { providerName: 'Apple Music' }));
  await context.step(player(0, 299500, { providerName: 'Apple Music' }));
  assert.equal(context.queue.status().state, 'completed');
  assert.equal(context.commands[0].providerId, 'alexa-default');
  assert.equal(context.controls.length, 0);
});

test('a newer external intent supersedes a pending pause without being cancelled', async () => {
  const gate = deferred();
  const context = setup({ control: () => gate.promise });
  context.start(); await flush();
  const pending = context.queue.control('pause');
  const external = context.playback.reserve({ deviceId: 'echo1', country: 'IN', providerId: 'spotify', trackHint: {} });
  context.playback.start(external, { title: 'External', artist: 'Someone' });
  gate.resolve({ status: 'sent' });
  await assert.rejects(pending, { code: 'PLAYBACK_CHANGED' });
  assert.equal(external.active, true);
  assert.equal(context.queue.status().state, 'cancelled');
});

test('works with the real PlaybackCoordinator interface and waits for verified metadata', async () => {
  let time = 1000, requested = null, reads = 0;
  const sent = [];
  const bridge = {
    requireDevice() {},
    async play(track, deviceId, providerId) { sent.push({ track, deviceId, providerId }); requested = track; return { status: 'sent' }; },
    async freshPlayer() {
      ++reads;
      if (!requested) return { player: { state: 'UNKNOWN' } };
      if (reads <= 3) return { player: player(0) };
      return { player: { state: 'UNKNOWN' } };
    },
  };
  const sleep = async ms => { time += ms; };
  const playback = new PlaybackCoordinator({ bridge, clock: () => time, sleep, pollMs: 10, graceMs: 30, attemptMs: 60, commandGapMs: 0 });
  const queue = new PlaylistQueue({ bridge, playback, clock: () => time, sleep, pollMs: 10 });
  queue.start({ playlist: playlist(1), deviceId: 'echo1', country: 'IN', providerId: 'spotify' });
  await queue.current.task;
  assert.equal(playback.status().state, 'matched');
  assert.equal(queue.status().state, 'needs_attention');
  assert.equal(queue.status().playbackRequestId, playback.status().id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].providerId, 'spotify');
});


test('resolved individual credits survive confirmation into queue monitoring for a four-artist song', async () => {
  let time = 1000, requested = false, reads = 0;
  const credits = ['Primary Artist', 'Second Artist', 'Third Artist', 'Earth, Wind & Fire'];
  const original = { id: 'saved', source: 'spotify', country: 'IN', title: 'Collaboration', artist: credits.join(', '), requestArtist: credits.join(', '), requestArtists: [credits.join(', ')], durationMs: 300000 };
  const sent = [];
  const bridge = {
    requireDevice() {},
    async play(track) { requested = true; sent.push(track.requestArtist); return { status: 'sent' }; },
    async freshPlayer() {
      if (!requested) return { player: { state: 'UNKNOWN' } };
      return { player: { state: 'PLAYING', title: original.title, artist: 'Primary Artist, Second Artist, Third Artist & Earth, Wind & Fire', providerName: 'Spotify', durationMs: 300000, positionMs: ++reads <= 3 ? 1000 : 299500 } };
    },
  };
  const sleep = async ms => { time += ms; };
  const playback = new PlaybackCoordinator({ bridge, artistResolver: { async resolve(track) { return { ...track, requestArtist: credits[0], requestArtists: credits }; } }, clock: () => time, sleep, pollMs: 10, graceMs: 30, attemptMs: 60, commandGapMs: 0 });
  const queue = new PlaylistQueue({ bridge, playback, clock: () => time, sleep, pollMs: 10 });
  queue.startLocal({ playlist: { id: 'list', title: 'Saved playlist', source: 'local', country: 'IN', tracks: [original] }, deviceId: 'echo1', country: 'IN', providerId: 'spotify' });
  await queue.current.task;
  assert.equal(playback.status().state, 'matched');
  assert.equal(queue.status().state, 'completed');
  assert.deepEqual(sent, ['Primary Artist']);
  assert.deepEqual(original.requestArtists, [original.artist], 'the source playlist stays intact');
});
