import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Companion, createApp } from '../server.mjs';

const DEVICE = 'echo-1', OTHER_DEVICE = 'echo-2', CHECK_VOLUME = 1;
const TRACK = {
  source: 'youtube-music', title: 'Desired Song', artist: 'First Artist, Second Artist, Third Artist & Correct Artist',
  artistNames: ['First Artist', 'Second Artist', 'Third Artist', 'Correct Artist'], durationMs: 200000,
  url: 'https://music.youtube.com/watch?v=abcdefghijk'
};
const SINGLE = { ...TRACK, artist: 'Correct Artist', artistNames: ['Correct Artist'] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'Expected quiet-search condition was not reached') {
  for (let index = 0; index < 500; index++) { if (check()) return; await sleep(3); }
  assert.fail(message);
}
function deferred() {
  let resolve; const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(t, options = {}) {
  const events = [], gates = [];
  const players = new Map([DEVICE, OTHER_DEVICE].map(deviceId => [deviceId, {
    deviceId, state: 'PLAYING', title: 'Previously Playing Song', artist: 'Previous Artist', providerName: 'Apple Music',
    durationMs: 200000, positionMs: 10000, volume: options.initialVolume === undefined ? 37 : options.initialVolume
  }]));
  const model = {
    events, players, songCount: 0, playerReads: 0,
    gate() { const gate = deferred(); gates.push(gate); return gate; },
    player(deviceId = DEVICE) { return players.get(deviceId); }
  };
  const upstream = async (route, request) => {
    if (route === '/api/music-providers') return { providers: [] };
    if (route === '/api/status') return { connection: { state: 'connected' }, devices: [...players.keys()].map(id => ({ id, name: id })) };
    if (route.startsWith('/api/player')) {
      const deviceId = new URL(route, 'http://127.0.0.1').searchParams.get('deviceId');
      model.playerReads++;
      const replacement = await options.onPlayer?.(deviceId, model);
      const player = { ...model.player(deviceId) };
      const response = replacement === undefined ? { player, volume: player.volume } : replacement;
      events.push({ type: 'observation', deviceId, title: response?.player?.title, state: response?.player?.state, volume: response?.volume ?? response?.player?.volume });
      return response;
    }
    if (route === '/api/control') {
      const body = request.body, player = model.player(body.deviceId);
      events.push({ type: 'control', action: body.action, volume: body.volume, deviceId: body.deviceId, stateAtDispatch: player.state, previousVolume: player.volume });
      const replacement = await options.onControl?.(body, model);
      if (replacement?.apply !== false) {
        if (body.action === 'volume') player.volume = body.volume;
        if (body.action === 'pause') player.state = 'PAUSED';
      }
      return replacement?.response || { status: 'sent' };
    }
    if (route === '/api/command') {
      const body = request.body, player = model.player(body.deviceId), number = ++model.songCount;
      events.push({ type: 'song', text: body.text, deviceId: body.deviceId, volumeAtDispatch: player.volume, number });
      await options.onCommand?.(body, model, number);
      const desired = options.resolveSong ? options.resolveSong(body, model, number) : {
        title: /play song (.*?) by /u.exec(body.text)?.[1] || SINGLE.title, artist: SINGLE.artist
      };
      Object.assign(player, { state: 'PLAYING', title: desired.title, artist: desired.artist, durationMs: desired.durationMs || 200000, positionMs: 0 });
      return { status: 'sent', commandId: 'command-' + number };
    }
    if (route === '/api/custom-command') { events.push({ type: 'custom', text: request.body.text }); return { status: 'sent', commandId: 'custom-1' }; }
    throw new Error('Unexpected quiet-search upstream route: ' + route);
  };
  const companion = new Companion({ upstream, quietSearch: true, quietVolume: options.quietVolume ?? CHECK_VOLUME, commandGapMs: 0, quietConfirmDelayMs: 0, pollDelayMs: 2, pollAttempts: 2 });
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await Promise.resolve(companion.stop());
    if (typeof companion.cleanup === 'function') await companion.cleanup();
    await companion.chain.catch(() => {});
  });
  return { companion, model, events, upstream, play: (track = SINGLE, extra = {}) => companion.play({ track, deviceId: DEVICE, providerId: 'apple-music', country: 'IN', ...extra }) };
}
const songs = events => events.filter(event => event.type === 'song');
const restores = (events, target = 37) => events.filter(event => event.type === 'control' && event.action === 'volume' && event.volume === target && event.deviceId === DEVICE);
async function settled(f) {
  await until(() => f.companion.status() && !f.companion.status().active);
  if (typeof f.companion.cleanup === 'function') await f.companion.cleanup();
  await f.companion.chain.catch(() => {});
}

test('four artist candidates all dispatch quietly and only the confirmed recording gets the playback volume', async t => {
  const f = fixture(t, { resolveSong: body => body.text.includes(' by Correct Artist on Apple Music') ? { title: TRACK.title, artist: TRACK.artist } : { title: 'Wrong Song', artist: 'Unrelated Artist' } });
  f.play(TRACK); await settled(f);
  assert.equal(f.companion.status().state, 'matched'); assert.equal(f.companion.status().attempt, 4);
  assert.equal(songs(f.events).length, 4); assert.ok(songs(f.events).every(event => event.volumeAtDispatch === CHECK_VOLUME));
  assert.equal(f.model.player().volume, 37); assert.equal(restores(f.events).length, 1);
  const unmuteAt = f.events.findIndex(event => event === restores(f.events)[0]);
  const matching = f.events.slice(0, unmuteAt).filter(event => event.type === 'observation' && event.title === TRACK.title && event.volume === CHECK_VOLUME);
  assert.ok(matching.length >= 2, 'volume must stay at the check level until distinct matching playback samples exist');
  assert.equal(restores(f.events)[0].stateAtDispatch, 'PLAYING');
});

test('an accepted quiet-volume request cannot dispatch music before the selected Echo reports the check level', async t => {
  let confirmation;
  const f = fixture(t, { onPlayer: async (_deviceId, model) => { if (!model.songCount && model.player().volume === CHECK_VOLUME) await confirmation.promise; } });
  confirmation = f.model.gate();
  f.play(); await until(() => f.events.some(event => event.type === 'control' && event.action === 'volume' && event.volume === CHECK_VOLUME));
  await sleep(12); assert.equal(songs(f.events).length, 0); assert.equal(f.model.player().volume, CHECK_VOLUME);
  confirmation.resolve(); await settled(f); assert.equal(f.companion.status().state, 'matched');
});

test('matched is not published while restoring the audible volume is still pending', async t => {
  let restore;
  const f = fixture(t, { onControl: async (body, model) => { if (body.action === 'volume' && body.volume === 37 && model.songCount) await restore.promise; } });
  restore = f.model.gate();
  f.play(); await until(() => restores(f.events).length === 1);
  assert.equal(f.model.player().volume, CHECK_VOLUME); assert.equal(f.companion.status().active, true); assert.notEqual(f.companion.status().state, 'matched');
  restore.resolve(); await settled(f); assert.equal(f.companion.status().state, 'matched'); assert.equal(f.model.player().volume, 37);
});

test('missing initial volume and a player reported for another Echo cannot start a candidate', async t => {
  for (const scenario of ['unknown-volume', 'wrong-device', 'read-error']) await t.test(scenario, async t => {
    const f = fixture(t, { onPlayer: (_deviceId, model) => {
      if (scenario === 'read-error') throw new Error('Player unavailable');
      return { player: { ...model.player(), deviceId: scenario === 'wrong-device' ? OTHER_DEVICE : DEVICE, volume: scenario === 'unknown-volume' ? null : 37 }, volume: scenario === 'unknown-volume' ? null : 37 };
    } });
    f.play(); await settled(f); assert.notEqual(f.companion.status().state, 'matched'); assert.equal(songs(f.events).length, 0);
  });
});

test('a native quiet-volume request that is accepted but never observed prevents every candidate request', async t => {
  const f = fixture(t, { onControl: body => body.action === 'volume' && body.volume === CHECK_VOLUME ? { apply: false } : undefined });
  f.play(); await settled(f); assert.notEqual(f.companion.status().state, 'matched'); assert.equal(songs(f.events).length, 0);
});

test('an initially silent Echo stays at zero and no candidate starts until a playback volume is chosen', async t => {
  const f = fixture(t, { initialVolume: 0 }); f.play(); await settled(f);
  assert.notEqual(f.companion.status().state, 'matched'); assert.equal(f.companion.status().active, false);
  assert.equal(f.model.player().volume, 0); assert.equal(songs(f.events).length, 0);
  assert.equal(f.events.filter(event => event.type === 'control' && event.action === 'volume').length, 0);
  assert.match(f.companion.status().message, /volume/iu);
  assert.match(f.companion.status().message, /(?:above|greater than)\s*0|nonzero|positive/iu);
});

test('exhausted wrong candidates are paused before the original volume is restored', async t => {
  const f = fixture(t, { resolveSong: () => ({ title: 'Wrong Song', artist: 'Unrelated Artist' }) });
  f.play(TRACK); await settled(f);
  assert.notEqual(f.companion.status().state, 'matched'); assert.equal(songs(f.events).length, 4);
  assert.ok(songs(f.events).every(event => event.volumeAtDispatch === CHECK_VOLUME));
  await until(() => restores(f.events).length === 1);
  assert.equal(restores(f.events)[0].stateAtDispatch, 'PAUSED'); assert.equal(f.model.player().volume, 37);
  const pauseAt = f.events.findIndex(event => event.type === 'control' && event.action === 'pause');
  const restoreAt = f.events.indexOf(restores(f.events)[0]);
  assert.ok(pauseAt >= 0 && pauseAt < restoreAt);
  assert.ok(f.events.slice(pauseAt, restoreAt).some(event => event.type === 'observation' && ['PAUSED', 'STOPPED', 'IDLE'].includes(event.state)));
});

test('failure to pause or confirm paused playback keeps wrong candidates quiet', async t => {
  for (const scenario of ['pause-rejected', 'pause-unconfirmed']) await t.test(scenario, async t => {
    const f = fixture(t, { resolveSong: () => ({ title: 'Wrong Song', artist: 'Unrelated Artist' }), onControl: body => {
      if (body.action !== 'pause') return;
      if (scenario === 'pause-rejected') throw new Error('Pause not accepted');
      return { apply: false };
    } });
    f.play(); await settled(f); assert.notEqual(f.companion.status().state, 'matched');
    assert.equal(f.model.player().volume, CHECK_VOLUME); assert.equal(restores(f.events).length, 0);
  });
});

test('cancelling an in-flight candidate waits for it, then pauses before restoring without another candidate', async t => {
  let dispatched;
  const f = fixture(t, { onCommand: async () => { await dispatched.promise; }, resolveSong: () => ({ title: 'Wrong Song', artist: 'Unrelated Artist' }) });
  dispatched = f.model.gate(); f.play(TRACK); await until(() => songs(f.events).length === 1);
  f.companion.cancel(); assert.equal(f.companion.status().state, 'cancelled'); assert.equal(f.model.player().volume, CHECK_VOLUME);
  dispatched.resolve(); await settled(f); await until(() => restores(f.events).length === 1);
  assert.equal(songs(f.events).length, 1); assert.equal(restores(f.events)[0].stateAtDispatch, 'PAUSED'); assert.equal(f.model.player().volume, 37);
});

test('a newer song cannot inherit a stale quiet restore target or be unmuted by the older cancelled search', async t => {
  let dispatched;
  const f = fixture(t, {
    onCommand: async (_body, _model, number) => { if (number === 1) await dispatched.promise; },
    resolveSong: body => body.text.includes('Old Intent') ? { title: 'Wrong Old Song', artist: 'Unrelated Artist' } : { title: 'New Intent', artist: SINGLE.artist }
  });
  dispatched = f.model.gate(); f.play({ ...SINGLE, title: 'Old Intent' }, { requestId: 'quiet-old' }); await until(() => songs(f.events).length === 1);
  const newer = f.play({ ...SINGLE, title: 'New Intent' }, { requestId: 'quiet-new' }); await sleep(8);
  assert.equal(songs(f.events).length, 1); assert.equal(f.model.player().volume, CHECK_VOLUME);
  dispatched.resolve(); await settled(f);
  assert.equal(f.companion.status().id, newer.job.id); assert.equal(f.companion.status().state, 'matched');
  assert.equal(songs(f.events).length, 2); assert.ok(songs(f.events).every(event => event.volumeAtDispatch === CHECK_VOLUME)); assert.equal(f.model.player().volume, 37);
  for (const event of restores(f.events)) assert.ok(event.stateAtDispatch === 'PAUSED' || event.stateAtDispatch === 'PLAYING' && f.events.slice(0, f.events.indexOf(event)).filter(item => item.type === 'observation' && item.title === 'New Intent' && item.volume === CHECK_VOLUME).length >= 2, 'stale cleanup must never expose an unconfirmed playing candidate');
});

test('volume changes during a quiet search change its restore target without exposing the candidate', async t => {
  let checking;
  const f = fixture(t, { onPlayer: async (_deviceId, model) => { if (model.songCount) await checking.promise; } });
  checking = f.model.gate(); f.play(); await until(() => songs(f.events).length === 1);
  const control = await f.companion.control({ deviceId: DEVICE, action: 'volume', volume: 63 });
  assert.equal(control.ok, true); assert.equal(f.companion.status().active, true); assert.equal(f.model.player().volume, CHECK_VOLUME);
  assert.equal(restores(f.events, 63).length, 0);
  checking.resolve(); await settled(f); assert.equal(f.companion.status().state, 'matched'); assert.equal(f.model.player().volume, 63);
  assert.equal(restores(f.events, 37).length, 0); assert.equal(restores(f.events, 63).length, 1);
});

test('another Echo volume remains independent while the selected Echo is held quiet', async t => {
  let checking;
  const f = fixture(t, { onPlayer: async (deviceId, model) => { if (deviceId === DEVICE && model.songCount) await checking.promise; } });
  checking = f.model.gate(); f.play(); await until(() => songs(f.events).length === 1);
  const control = await f.companion.control({ deviceId: OTHER_DEVICE, action: 'volume', volume: 22 });
  assert.equal(control.ok, true); assert.equal(f.model.player(OTHER_DEVICE).volume, 22); assert.equal(f.model.player().volume, CHECK_VOLUME);
  checking.resolve(); await settled(f); assert.equal(f.model.player().volume, 37); assert.equal(f.model.player(OTHER_DEVICE).volume, 22);
});


test('volume restoration must be observed before a job reports matched', async t => {
  let observedRestore = false, confirmation;
  const f = fixture(t, { onPlayer: async (_deviceId, model) => {
    if (model.songCount && model.player().volume === 37) { observedRestore = true; await confirmation.promise; }
  } });
  confirmation = f.model.gate(); f.play(); await until(() => observedRestore);
  assert.equal(f.companion.status().active, true); assert.notEqual(f.companion.status().state, 'matched');
  confirmation.resolve(); await settled(f); assert.equal(f.companion.status().state, 'matched');
});

test('an external changed volume relinquishes quiet-search ownership without pausing or restoring over the user', async t => {
  let checking;
  const f = fixture(t, { onPlayer: async (_deviceId, model) => { if (model.songCount) await checking.promise; }, resolveSong: () => ({ title: 'Wrong Song', artist: 'Unrelated Artist' }) });
  checking = f.model.gate(); f.play(TRACK); await until(() => songs(f.events).length === 1);
  assert.equal(f.model.player().volume, CHECK_VOLUME);
  f.model.player().volume = 55; const changedAt = f.events.push({ type: 'external-volume', volume: 55 }) - 1;
  checking.resolve(); await settled(f);
  assert.notEqual(f.companion.status().state, 'matched'); assert.equal(songs(f.events).length, 1); assert.equal(f.model.player().volume, 55);
  assert.equal(f.events.slice(changedAt + 1).some(event => event.type === 'control'), false);
});

test('a rejected native quiet-volume request never falls through to an audible candidate', async t => {
  const f = fixture(t, { onControl: body => { if (body.action === 'volume' && body.volume === CHECK_VOLUME) throw new Error('Quiet volume not accepted'); } });
  f.play(); await settled(f); assert.notEqual(f.companion.status().state, 'matched'); assert.equal(songs(f.events).length, 0);
});

test('the paired HTTP runtime applies quiet search before forwarding an accepted song request', async t => {
  const f = fixture(t), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-quiet-runtime-'));
  const app = await createApp({ port: 0, dataDir: dir, upstream: f.upstream, pollDelayMs: 2, pollAttempts: 2, commandGapMs: 0, quietConfirmDelayMs: 0 });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.companion.stop(); await new Promise(resolve => { app.closeAllConnections?.(); app.close(resolve); }); await fs.rm(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.address().port;
  const paired = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Echo-Companion': '1' }, body: '{}' });
  assert.equal(paired.status, 200); const token = (await paired.json()).token, extension = 'a'.repeat(32);
  const response = await fetch(base + '/api/play', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://' + extension, Authorization: 'Bearer ' + token, 'X-Echo-Extension': extension }, body: JSON.stringify({ track: SINGLE, deviceId: DEVICE, providerId: 'apple-music', country: 'IN' }) });
  assert.equal(response.status, 202); await response.json();
  await until(() => app.companion.status() && !app.companion.status().active); await app.companion.cleanup();
  assert.equal(app.companion.status().state, 'matched'); assert.equal(songs(f.events).length, 1);
  assert.equal(songs(f.events)[0].volumeAtDispatch, CHECK_VOLUME); assert.equal(f.model.player().volume, 37);
});


test('briefly stale quiet-volume observations are retried before any candidate becomes eligible', async t => {
  let lag = true;
  const f = fixture(t, { onPlayer: (_deviceId, model) => {
    if (!model.songCount && model.player().volume === CHECK_VOLUME && lag) { lag = false; return { player: { ...model.player(), volume: 37 }, volume: 37 }; }
  } });
  f.play(); await settled(f);
  assert.equal(f.companion.status().state, 'matched'); assert.equal(lag, false); assert.equal(songs(f.events).length, 1); assert.equal(songs(f.events)[0].volumeAtDispatch, CHECK_VOLUME);
});

test('briefly stale pause observations keep cleanup quiet until a fresh stopped state arrives', async t => {
  let lag = true;
  const f = fixture(t, { resolveSong: () => ({ title: 'Wrong Song', artist: 'Unrelated Artist' }), onPlayer: (_deviceId, model) => {
    if (model.player().state === 'PAUSED' && lag) { lag = false; return { player: { ...model.player(), state: 'PLAYING' }, volume: model.player().volume }; }
  } });
  f.play(); await settled(f);
  assert.notEqual(f.companion.status().state, 'matched'); assert.equal(lag, false); assert.equal(f.model.player().volume, 37);
  const pauseAt = f.events.findIndex(event => event.type === 'control' && event.action === 'pause'), restoreAt = f.events.indexOf(restores(f.events)[0]);
  const observations = f.events.slice(pauseAt, restoreAt).filter(event => event.type === 'observation');
  assert.equal(observations[0].state, 'PLAYING'); assert.equal(observations[0].volume, CHECK_VOLUME); assert.ok(observations.some(event => event.state === 'PAUSED' && event.volume === CHECK_VOLUME));
});

test('custom and playback requests during quiet cleanup return promptly and never dispatch later', async t => {
  for (const action of ['custom', 'next']) await t.test(action, async t => {
    let candidate;
    const f = fixture(t, { onCommand: async () => { await candidate.promise; } });
    candidate = f.model.gate(); f.play(); await until(() => songs(f.events).length === 1);
    const requested = action === 'custom' ? f.companion.customCommand({ deviceId: DEVICE, text: 'What time is it?', requestId: 'quiet-custom' }) : f.companion.control({ deviceId: DEVICE, action: 'next' });
    const response = await Promise.race([requested, sleep(80).then(() => ({ timedOut: true }))]);
    assert.notEqual(response.timedOut, true, 'cleanup must not hold the caller behind an in-flight Alexa command');
    assert.equal(response.status, 'not_sent'); assert.equal(response.ok, false); assert.equal(f.model.player().volume, CHECK_VOLUME);
    candidate.resolve(); await settled(f);
    assert.equal(f.events.filter(event => event.type === 'custom').length, 0);
    assert.equal(f.events.filter(event => event.type === 'control' && event.action === 'next').length, 0);
    assert.equal(f.model.player().state, 'PAUSED'); assert.equal(f.model.player().volume, 37);
  });
});

test('graceful stop waits for an in-flight candidate and pauses it before restoring volume', async t => {
  let candidate;
  const f = fixture(t, { onCommand: async () => { await candidate.promise; }, resolveSong: () => ({ title: 'Wrong Song', artist: 'Unrelated Artist' }) });
  candidate = f.model.gate(); f.play(); await until(() => songs(f.events).length === 1);
  let finished = false; const stopping = Promise.resolve(f.companion.stop()).then(value => { finished = true; return value; });
  await sleep(8); assert.equal(finished, false); assert.equal(f.model.player().volume, CHECK_VOLUME);
  candidate.resolve(); assert.equal(await stopping, true);
  assert.equal(songs(f.events).length, 1); assert.equal(f.model.player().state, 'PAUSED'); assert.equal(f.model.player().volume, 37);
  assert.equal(restores(f.events)[0].stateAtDispatch, 'PAUSED');
});

test('cancelling while matched volume restoration is in flight still pauses the old recording', async t => {
  let restoring, intercepted = false;
  const f = fixture(t, { onControl: async (body, model) => {
    if (!intercepted && body.action === 'volume' && body.volume === 37 && model.songCount) { intercepted = true; await restoring.promise; }
  } });
  restoring = f.model.gate(); f.play(); await until(() => intercepted);
  assert.equal(f.model.player().volume, CHECK_VOLUME); f.companion.cancel(); assert.equal(f.companion.status().state, 'cancelled');
  restoring.resolve(); await settled(f);
  assert.equal(f.model.player().state, 'PAUSED'); assert.equal(f.model.player().volume, 37);
  assert.ok(f.events.some(event => event.type === 'control' && event.action === 'pause'), 'the completed old unmute must retain cleanup ownership after cancellation');
  assert.equal(f.companion.status().state, 'cancelled');
});

test('a newer job waits for cleanup of a cancelled in-flight restoration and checks its own candidates at the check level', async t => {
  let restoring, intercepted = false;
  const f = fixture(t, {
    onControl: async (body, model) => { if (!intercepted && body.action === 'volume' && body.volume === 37 && model.songCount) { intercepted = true; await restoring.promise; } },
    resolveSong: body => body.text.includes('Old Intent') ? { title: 'Old Intent', artist: SINGLE.artist } : body.text.includes(' by Correct Artist on Apple Music') ? { title: 'New Intent', artist: TRACK.artist } : { title: 'Wrong New Candidate', artist: 'Unrelated Artist' }
  });
  restoring = f.model.gate(); const old = f.play({ ...SINGLE, title: 'Old Intent' }, { requestId: 'restore-old' }); await until(() => intercepted);
  const newer = f.play({ ...TRACK, title: 'New Intent' }, { requestId: 'restore-new' }); await sleep(8);
  assert.equal(songs(f.events).length, 1); assert.equal(f.model.player().volume, CHECK_VOLUME);
  restoring.resolve(); await settled(f);
  assert.equal(f.companion.status().id, newer.job.id); assert.equal(f.companion.status().state, 'matched'); assert.equal(f.companion.jobStatus(old.job.id).job.state, 'cancelled');
  const newerSongs = songs(f.events).filter(event => event.text.includes('New Intent'));
  assert.equal(newerSongs.length, 4); assert.ok(newerSongs.every(event => event.volumeAtDispatch === CHECK_VOLUME)); assert.equal(f.model.player().volume, 37);
  const firstNewAt = f.events.indexOf(newerSongs[0]);
  assert.ok(f.events.slice(0, firstNewAt).some(event => event.type === 'control' && event.action === 'pause'), 'old matched playback must be paused before handing over to the new quiet job');
  for (const event of restores(f.events)) if (f.events.indexOf(event) > firstNewAt) {
    const confirmedNew = f.events.slice(firstNewAt, f.events.indexOf(event)).filter(sample => sample.type === 'observation' && sample.title === 'New Intent' && sample.volume === CHECK_VOLUME);
    assert.ok(confirmedNew.length >= 2, 'the new job cannot inherit the old match to restore volume early');
  }
});

test('a song changed while the fresh restored-player read is pending cannot be published as matched', async t => {
  let restoredRead, reading = false;
  const f = fixture(t, { onPlayer: async (_deviceId, model) => { if (model.songCount && model.player().volume === 37 && !reading) { reading = true; await restoredRead.promise; } } });
  restoredRead = f.model.gate(); f.play(); await until(() => reading);
  Object.assign(f.model.player(), { title: 'Different Recording', artist: 'Unrelated Artist' });
  restoredRead.resolve(); await settled(f);
  assert.notEqual(f.companion.status().state, 'matched'); assert.equal(f.companion.status().active, false);
});

test('failed cleanup can relinquish an externally changed volume and does not poison later stop', async t => {
  const f = fixture(t, { resolveSong: () => ({ title: 'Wrong Song', artist: 'Unrelated Artist' }), onControl: body => body.action === 'pause' ? { apply: false } : undefined });
  f.play(); await settled(f);
  assert.equal(f.model.player().volume, CHECK_VOLUME); assert.equal(await f.companion.cleanup(), false);
  f.model.player().volume = 55; const changedAt = f.events.push({ type: 'external-volume', volume: 55 }) - 1;
  assert.equal(await f.companion.cleanup(), true); assert.equal(await f.companion.stop(), true);
  assert.equal(f.model.player().volume, 55); assert.equal(f.events.slice(changedAt + 1).some(event => event.type === 'control'), false);
});

test('a transient missing volume after a candidate recovers on a bounded fresh read without another artist request', async t => {
  let missing = true;
  const f = fixture(t, { resolveSong: () => ({ title: TRACK.title, artist: TRACK.artist }), onPlayer: (_deviceId, model) => {
    if (model.songCount && missing) { missing = false; return { player: { ...model.player(), volume: null }, volume: null }; }
  } });
  f.play(TRACK); await settled(f);
  assert.equal(missing, false); assert.equal(f.companion.status().state, 'matched'); assert.equal(f.companion.status().attempt, 1);
  assert.equal(songs(f.events).length, 1); assert.equal(songs(f.events)[0].volumeAtDispatch, CHECK_VOLUME); assert.equal(f.model.player().volume, 37);
  assert.ok(f.events.some(event => event.type === 'observation' && event.volume === null));
});

test('permanently missing volume after a candidate stops further attempts and keeps playback quiet', async t => {
  const f = fixture(t, { resolveSong: () => ({ title: TRACK.title, artist: TRACK.artist }), onPlayer: (_deviceId, model) => {
    if (model.songCount) return { player: { ...model.player(), volume: null }, volume: null };
  } });
  f.play(TRACK); await settled(f);
  assert.notEqual(f.companion.status().state, 'matched'); assert.equal(f.companion.status().active, false);
  assert.equal(songs(f.events).length, 1); assert.equal(f.model.player().volume, CHECK_VOLUME); assert.equal(restores(f.events).length, 0);
});

test('apparent check volume from another Echo after a candidate cannot confirm or release the selected Echo', async t => {
  const f = fixture(t, { resolveSong: () => ({ title: TRACK.title, artist: TRACK.artist }), onPlayer: (_deviceId, model) => {
    if (model.songCount) return { player: { ...model.player(), deviceId: OTHER_DEVICE, volume: CHECK_VOLUME }, volume: CHECK_VOLUME };
  } });
  f.play(TRACK); await settled(f);
  assert.notEqual(f.companion.status().state, 'matched'); assert.equal(songs(f.events).length, 1);
  assert.equal(f.model.player().volume, CHECK_VOLUME); assert.equal(restores(f.events).length, 0);
});


test('a saved playback target of zero during checking restores silence only after the correct song is confirmed', async t => {
  let checking;
  const f = fixture(t, { onPlayer: async (_deviceId, model) => { if (model.songCount) await checking.promise; } });
  checking = f.model.gate(); f.play(); await until(() => songs(f.events).length === 1);
  const control = await f.companion.control({ deviceId: DEVICE, action: 'volume', volume: 0 });
  assert.equal(control.ok, true); assert.equal(f.model.player().volume, CHECK_VOLUME); assert.equal(restores(f.events, 0).length, 0);
  checking.resolve(); await settled(f);
  assert.equal(f.companion.status().state, 'matched'); assert.equal(f.model.player().volume, 0); assert.equal(restores(f.events, 0).length, 1);
  assert.equal(f.companion.status().quietSearch.checkVolume, CHECK_VOLUME); assert.equal(f.companion.status().quietSearch.restoreVolume, 0);
});

test('an external change to zero relinquishes ownership rather than raising a silent Echo back to the check level', async t => {
  let checking;
  const f = fixture(t, { onPlayer: async (_deviceId, model) => { if (model.songCount) await checking.promise; }, resolveSong: () => ({ title: 'Wrong Song', artist: 'Unrelated Artist' }) });
  checking = f.model.gate(); f.play(TRACK); await until(() => songs(f.events).length === 1);
  assert.equal(f.model.player().volume, CHECK_VOLUME); f.model.player().volume = 0;
  const changedAt = f.events.push({ type: 'external-volume', volume: 0 }) - 1;
  checking.resolve(); await settled(f);
  assert.notEqual(f.companion.status().state, 'matched'); assert.equal(songs(f.events).length, 1); assert.equal(f.model.player().volume, 0);
  assert.equal(f.events.slice(changedAt + 1).some(event => event.type === 'control'), false);
});

test('a configured check volume is used and reported without replacing the saved playback volume', async t => {
  const f = fixture(t, { quietVolume: 2 }); f.play(); await settled(f);
  assert.equal(f.companion.status().state, 'matched'); assert.equal(songs(f.events).length, 1); assert.equal(songs(f.events)[0].volumeAtDispatch, 2);
  assert.equal(f.companion.status().quietSearch.checkVolume, 2); assert.equal(f.companion.status().quietSearch.restoreVolume, 37);
  assert.equal(f.model.player().volume, 37);
});
