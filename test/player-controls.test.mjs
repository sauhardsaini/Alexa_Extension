import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AlexaBridge, normalizePlayer, normalizeVolume } from '../alexa/bridge.mjs';

const payload = (changes = {}) => ({ playerInfo: { state: 'PLAYING', infoText: { title: 'Lover', subText1: 'Taylor Swift' }, provider: { providerName: 'Apple Music' }, progress: { mediaLength: 180, mediaProgress: 20 }, volume: { volume: 25 }, ...changes } });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-player-controls-'));
  const calls = [], device = { serialNumber: 'echo', accountName: 'Echo', deviceType: 'type' };
  const remote = {
    find: id => id === 'echo' ? device : null,
    getPlayerInfo: (id, callback) => { calls.push(['player', id]); callback(null, payload()); },
    getAllDeviceVolumes: callback => callback(null, { volumes: [{ dsn: 'echo', speakerVolume: 31 }] }),
    sendCommand: (id, action, value, callback) => { calls.push(['command', id, action, value]); callback(null, { success: true }); },
    createSequenceNode: (action, text, id) => { calls.push(['node', action, text, id]); return { operationPayload: { text } }; },
    sendSequenceCommand: (id, sequence, callback) => { calls.push(['sequence', id, sequence]); callback(null, { success: true }); },
    stop() {}, stopProxyServer() {}
  };
  const bridge = new AlexaBridge({ dataDir: dir, responseDelays: [] }); bridge.remote = remote; bridge.connection = { state: 'connected' }; bridge.devices = [{ id: 'echo', name: 'Echo', online: true }];
  t.after(async () => { bridge.disconnect({ forget: false }); await fs.rm(dir, { recursive: true, force: true }); });
  return { bridge, remote, calls };
}
test('normalized Echo player exposes reported progress, duration, and bounded volume', () => {
  const player = normalizePlayer(payload(), 'echo'); assert.equal(player.positionMs, 20000); assert.equal(player.durationMs, 180000); assert.equal(player.volume, 25);
  for (const volume of [-1, 101, '25', NaN]) assert.equal(normalizeVolume({ playerInfo: { volume: { volume } } }), null);
});
test('native volume dispatch includes the selected Echo and does not replace song observation ownership', async t => {
  const f = await fixture(t); const music = { id: 'music-command', at: Date.now(), kind: 'music' }; f.bridge.latestCommands.set('echo', music);
  const result = await f.bridge.setVolume('echo', 0); assert.equal(result.status, 'sent'); assert.equal(result.volume, 0); assert.deepEqual(f.calls[0], ['command', 'echo', 'volume', 0]); assert.equal(f.bridge.latestCommands.get('echo'), music);
  for (const volume of [-1, 101, 3.5, '25']) await assert.rejects(f.bridge.setVolume('echo', volume), { code: 'INVALID_VOLUME' });
});
test('fresh selected player reads report idle speaker volume using its own device setting', async t => {
  const f = await fixture(t); f.remote.getPlayerInfo = (_id, callback) => callback(null, { playerInfo: { state: 'STOPPED' } });
  const result = await f.bridge.player('echo', { fresh: true }); assert.equal(result.player.state, 'STOPPED'); assert.equal(result.volume, 31);
});
test('seek converts an absolute Echo position into a fixed bounded spoken adjustment', async t => {
  const f = await fixture(t); const result = await f.bridge.seek('echo', 60000, { title: 'Lover', artist: 'Taylor Swift' });
  assert.equal(result.status, 'sent'); assert.equal(result.confirmed, false); assert.equal(result.targetPositionMs, 60000);
  assert.equal(f.calls.find(call => call[0] === 'node')[2], 'fast forward 40 seconds'); assert.equal(f.calls.find(call => call[0] === 'sequence')[2].startNode.operationPayload.locale, 'en-IN');
  assert.equal(f.calls.some(call => call[0] === 'command' && call[2] === 'seek'), false);
  f.bridge.lastCommandAt = 0; await f.bridge.seek('echo', 10000); assert.equal(f.calls.filter(call => call[0] === 'node').at(-1)[2], 'rewind 10 seconds');
});
test('seek rejects a stale song, missing progress, or a target beyond the recording', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.seek('echo', 180000), { code: 'INVALID_POSITION' }); f.bridge.lastCommandAt = 0;
  await assert.rejects(f.bridge.seek('echo', 60000, { title: 'Another Song', artist: 'Taylor Swift' }), { code: 'SONG_CHANGED' }); f.bridge.lastCommandAt = 0;
  f.remote.getPlayerInfo = (_id, callback) => callback(null, payload({ progress: null })); await assert.rejects(f.bridge.seek('echo', 60000), { code: 'SEEK_UNAVAILABLE' });
  assert.equal(f.calls.filter(call => call[0] === 'node').length, 0);
  for (const position of [-1, 4.5, '1000', 86400001]) await assert.rejects(f.bridge.seek('echo', position), { code: 'INVALID_POSITION' });
});
test('a player read started before seeking cannot restore stale position afterwards', async t => {
  const f = await fixture(t); let oldCallback, reads = 0;
  f.remote.getPlayerInfo = (_id, callback) => { if (++reads === 1) oldCallback = callback; else callback(null, payload()); };
  const stale = f.bridge.freshPlayer('echo'); await f.bridge.seek('echo', 60000);
  oldCallback(null, payload({ progress: { mediaLength: 180, mediaProgress: 5 } })); const result = await stale;
  assert.equal(result.player.positionMs, undefined); assert.equal(f.bridge.playerCache.has('echo'), false);
});
