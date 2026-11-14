import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createAmazonConnection } from '../alexa-connection.mjs';
import { AlexaBridge } from '../alexa/bridge.mjs';
import { AppError } from '../alexa/errors.mjs';
function fixture() {
  const calls = [];
  const bridge = {
    settings: { region: 'IN', locale: 'en-IN' },
    snapshot: { connection: { state: 'disconnected', message: 'not for export', secret: 'never-export' }, settings: { region: 'IN', locale: 'en-IN', cookie: 'never-export' }, devices: [] },
    status() { return this.snapshot; },
    async connect(settings) { calls.push(['connect', settings]); this.snapshot.connection = { state: 'awaiting_login', loginUrl: 'http://127.0.0.1:4321/' }; },
    disconnect(options) { calls.push(['disconnect', options]); this.snapshot.connection = { state: 'disconnected' }; },
    async restore() { calls.push(['restore']); },
    async musicProviders() { calls.push(['providers']); return { providers: [] }; },
    async freshPlayer(id) { calls.push(['player', id]); return { player: { state: 'PLAYING', title: 'Lover', artist: 'Taylor Swift' } }; },
    commands() { return { commands: [{ id: 'cmd', kind: 'custom', text: 'What time is it?', status: 'sent', responseStatus: 'pending', response: null }], retention: 'session' }; },
    async sendTextCommand(text, id, options) { calls.push(['command', text, id, options]); return { status: 'sent', commandId: 'cmd' }; },
    async control(id, action) { calls.push(['control', id, action]); return { status: 'sent' }; },
    async setVolume(id, volume) { calls.push(['volume', id, volume]); return { status: 'sent', volume }; },
    async seek(id, positionMs, expectedTrack) { calls.push(['seek', id, positionMs, expectedTrack]); return { status: 'sent', confirmed: false, targetPositionMs: positionMs }; }
  };
  const connection = createAmazonConnection({ dataDir: '/tmp/unused-echo-test', bridgeFactory: options => { calls.push(['construct', options]); return bridge; } });
  return { connection, bridge, calls };
}
test('standalone connection owns its session directory and dedicated login port', () => {
  const f = fixture(); assert.equal(f.calls[0][1].proxyPort, 4321); assert.equal(f.calls[0][1].dataDir, '/tmp/unused-echo-test');
  const status = f.connection.status(); assert.equal(status.settings.country, 'IN'); assert.equal(status.connection.state, 'disconnected');
  assert.equal(JSON.stringify(status).includes('never-export'), false); assert.ok(status.regions.some(row => row.id === 'IN')); assert.ok(status.locales.some(row => row.id === 'en-IN'));
});
test('connect uses region defaults and exposes only the exact local sign-in URL', async () => {
  const f = fixture(); const status = await f.connection.connect({ region: 'UK', locale: '' });
  assert.deepEqual(f.calls[1], ['connect', { region: 'UK', locale: 'en-GB' }]);
  assert.equal(status.connection.loginUrl, 'http://127.0.0.1:4321/');
  for (const loginUrl of ['https://evil.test/', 'http://127.0.0.1:4321/?token=secret', 'http://user:pass@127.0.0.1:4321/', 'http://127.0.0.1:4319/']) {
    f.bridge.snapshot.connection.loginUrl = loginUrl; assert.equal(f.connection.status().connection.loginUrl, undefined);
  }
});
test('invalid account country and locale never start sign-in', async () => {
  const f = fixture(); await assert.rejects(f.connection.connect({ region: 'ZZ' }), { code: 'INVALID_REGION' });
  await assert.rejects(f.connection.connect({ region: 'IN', locale: 'bad' }), { code: 'INVALID_LOCALE' });
  assert.equal(f.calls.length, 1);
});
test('cleanup handles setup failures without exposing raw errors or deleting saved sessions', async () => {
  const f = fixture(); f.bridge.connect = async () => { f.bridge.snapshot.connection.state = 'connecting'; throw new Error('cookie=super-secret'); };
  await assert.rejects(f.connection.connect({}), error => error.code === 'AMAZON_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(f.connection.status().connection.state, 'disconnected'); assert.deepEqual(f.calls.at(-1), ['disconnect', { forget: false }]);
});
test('duplicate connection keeps the existing sign-in running', async () => {
  const f = fixture(); f.bridge.connect = async () => { throw new AppError(409, 'CONNECTION_BUSY', 'A connection is already in progress.'); };
  await assert.rejects(f.connection.connect({}), { code: 'CONNECTION_BUSY' }); assert.equal(f.calls.length, 1);
});
test('shutdown keeps this session; explicit disconnect forgets this session', async () => {
  const f = fixture(); f.connection.stop(); assert.deepEqual(f.calls.at(-1), ['disconnect', { forget: false }]);
  f.connection.disconnect(); assert.deepEqual(f.calls.at(-1), ['disconnect', { forget: true }]);
  await f.connection.restore(); assert.deepEqual(f.calls.at(-1), ['restore']);
});
test('fixed adapter dispatches directly to Alexa without the original web app', async () => {
  const f = fixture(); await f.connection.upstream('/api/status'); await f.connection.upstream('/api/music-providers'); await f.connection.upstream('/api/player?deviceId=echo');
  await f.connection.upstream('/api/command', { method: 'POST', body: { text: 'play song Lover by Taylor Swift in Apple Music', deviceId: 'echo' } });
  await f.connection.upstream('/api/control', { method: 'POST', body: { deviceId: 'echo', action: 'pause' } });
  assert.ok(f.calls.some(call => call[0] === 'player' && call[1] === 'echo'));
  assert.deepEqual(f.calls.find(call => call[0] === 'command').slice(1), ['play song Lover by Taylor Swift in Apple Music', 'echo', { kind: 'music' }]);
  assert.ok(f.calls.some(call => call[0] === 'control'));
  await assert.rejects(f.connection.upstream('https://evil.test/api/status'), { code: 'UNSUPPORTED_ACTION' });
  await assert.rejects(f.connection.upstream('/api/control', { method: 'POST', body: { action: 'volume' } }), { code: 'INVALID_VOLUME' });
});
test('only authored bridge errors reach the caller; timeouts do not expose upstream data', async () => {
  const f = fixture(); f.bridge.musicProviders = async () => { throw new Error('secret upstream cookie'); };
  await assert.rejects(f.connection.upstream('/api/music-providers'), error => error.code === 'AMAZON_UNAVAILABLE' && !error.message.includes('secret'));
  f.bridge.musicProviders = () => new Promise(() => {});
  const hold = setTimeout(() => {}, 100);
  try { await assert.rejects(f.connection.upstream('/api/music-providers', { timeoutMs: 5 }), { code: 'AMAZON_TIMEOUT' }); } finally { clearTimeout(hold); }
});
class FakeRemote extends EventEmitter {
  init(options, callback) { this.options = options; this.callback = callback; callback('Please open http://127.0.0.1:4321/'); }
  stop() { this.stopped = true; }
  stopProxyServer() { this.proxyStopped = true; }
}
test('real vendored bridge connects locally and stale callbacks cannot save a forgotten session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-amazon-auth-')); const remotes = [];
  const connection = createAmazonConnection({ dataDir: dir, bridgeFactory: options => new AlexaBridge({ ...options, portCheck: async () => {}, responseDelays: [], createRemote: () => { const remote = new FakeRemote(); remotes.push(remote); return remote; } }) });
  try {
    assert.equal((await connection.connect({ region: 'IN' })).connection.state, 'awaiting_login');
    const remote = remotes[0]; assert.equal(remote.options.proxyPort, 4321); assert.equal(remote.options.proxyListenBind, '127.0.0.1'); assert.equal(remote.options.amazonPage, 'amazon.in');
    connection.disconnect(); remote.cookieData = { localCookie: 'not-a-real-cookie' }; remote.emit('cookie'); remote.serialNumbers = { echo: { deviceFamily: 'ECHO', serialNumber: 'echo', accountName: 'Echo' } }; remote.callback(null);
    await assert.rejects(fs.stat(path.join(dir, 'session.json')), { code: 'ENOENT' }); assert.equal(connection.status().connection.state, 'disconnected'); assert.equal(remote.stopped, true); assert.equal(remote.proxyStopped, true);
  } finally { connection.stop(); await fs.rm(dir, { recursive: true, force: true }); }
});


test('adapter dispatches validated volume and seek controls and uses selected fresh playback reads', async () => {
  const f = fixture();
  f.bridge.player = async (id, options) => { f.calls.push(['selected-player', id, options]); return { player: { state: 'PAUSED', deviceId: id, positionMs: 20000, durationMs: 180000 }, volume: 34 }; };
  const player = await f.connection.upstream('/api/player?deviceId=echo-2'); assert.equal(player.volume, 34); assert.deepEqual(f.calls.at(-1), ['selected-player', 'echo-2', { fresh: true, timeoutMs: 2500 }]);
  assert.equal((await f.connection.upstream('/api/control', { method: 'POST', body: { deviceId: 'echo-2', action: 'volume', volume: 0 } })).volume, 0); assert.deepEqual(f.calls.at(-1), ['volume', 'echo-2', 0]);
  const expectedTrack = { title: 'Lover', artist: 'Taylor Swift' };
  const result = await f.connection.upstream('/api/control', { method: 'POST', body: { deviceId: 'echo-2', action: 'seek', positionMs: 60000, expectedTrack } }); assert.equal(result.confirmed, false); assert.deepEqual(f.calls.at(-1), ['seek', 'echo-2', 60000, expectedTrack]);
  for (const volume of [-1, 101, 2.5, '25', null]) await assert.rejects(f.connection.upstream('/api/control', { method: 'POST', body: { deviceId: 'echo-2', action: 'volume', volume } }), { code: 'INVALID_VOLUME' });
  for (const positionMs of [-1, 1.5, '3000', null, Infinity, 86400001]) await assert.rejects(f.connection.upstream('/api/control', { method: 'POST', body: { deviceId: 'echo-2', action: 'seek', positionMs } }), { code: 'INVALID_POSITION' });
});


test('custom command adapter uses custom journal kind and exposes existing response history without inventing transcripts', async () => {
  const f = fixture();
  const result = await f.connection.upstream('/api/custom-command', { method: 'POST', body: { deviceId: 'echo', text: 'What time is it?' }, timeoutMs: 18000 });
  assert.deepEqual(f.calls.find(call => call[0] === 'command').slice(1), ['What time is it?', 'echo', { kind: 'custom' }]);
  assert.equal(result.commandId, 'cmd'); assert.equal(result.command.responseStatus, 'pending'); assert.equal(result.command.response, null);
  const history = await f.connection.upstream('/api/commands'); assert.equal(history.commands[0].id, 'cmd');
  for (const text of ['', ' ', 'bad\ncommand', 'x'.repeat(501), null]) await assert.rejects(f.connection.upstream('/api/custom-command', { method: 'POST', body: { deviceId: 'echo', text } }), { code: 'INVALID_COMMAND' });
  assert.equal(f.calls.filter(call => call[0] === 'command').length, 1);
});
