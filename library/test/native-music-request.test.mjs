import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import AlexaRemote from 'alexa-remote2';
import { AlexaBridge } from '../bridge.mjs';
import { parseMusicProviders, resolveDiscoveredMusicProvider } from '../music-providers.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const supported = (id = 'APPLE_MUSIC', extra = {}) => ({ id, availability: 'AVAILABLE', supportedOperations: ['Alexa.Music.PlaySearchPhrase'], displayName: id === 'APPLE_MUSIC' ? 'Apple Music' : 'Music service', ...extra });
const track = { title: 'Baby (feat. Ludacris)', artist: 'Justin Bieber', requestArtist: 'Justin Bieber' };
const native = { requestMode: 'music-request-test' };
class FakeRemote extends EventEmitter {
  constructor() {
    super();
    this.serialNumbers = { echo1: { serialNumber: 'echo1', deviceType: 'ECHO_TYPE', deviceOwnerCustomerId: 'owner-one', deviceFamily: 'ECHO', accountName: 'Bedroom Echo', hasMusicPlayer: true, online: true } };
    this.providers = [supported()]; this.discoveryCalls = 0; this.validations = []; this.sent = []; this.textNodes = [];
  }
  init(options, callback) { callback(null); }
  find(id) { return this.serialNumbers[id]; }
  getMusicProviders(callback) { ++this.discoveryCalls; if (this.discoveryHook) return this.discoveryHook(callback); callback(null, this.providers); }
  httpsGet(url, callback, flags) {
    const request = { url, flags, operation: JSON.parse(flags.data) }; this.validations.push(request);
    if (this.validationHook) return this.validationHook(request, callback);
    callback(null, { result: 'VALID', operationPayload: request.operation.operationPayload });
  }
  createSequenceNode(command, text, deviceId) { this.textNodes.push({ command, text, deviceId }); return { type: 'Alexa.TextCommand', operationPayload: { text: text.toLowerCase(), locale: 'ALEXA_CURRENT_LOCALE' } }; }
  sendSequenceCommand(deviceId, sequence, callback) { this.sent.push({ deviceId, sequence }); if (this.sendHook) return this.sendHook(callback); callback(null, {}); }
  stop() {}
  stopProxyServer() {}
}
async function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.scratch-native-request-'));
  const remote = new FakeRemote();
  const bridge = new AlexaBridge({ dataDir: dir, createRemote: () => remote, portCheck: async () => {}, responseDelays: [], musicRequestTimeoutMs: 1000, ...options });
  t.after(() => { bridge.disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
  await bridge.connect({ region: 'IN', locale: 'en-IN' });
  return { bridge, remote };
}
const payloadOf = remote => JSON.parse(remote.validations[0].operation.operationPayload);
const sentPayload = remote => { const payload = remote.sent[0].sequence.startNode.operationPayload; return typeof payload === 'string' ? JSON.parse(payload) : payload; };

test('native test uses discovered ID, trusted device owner and configured Indian locale, then dispatches once', async t => {
  const { bridge, remote } = await setup(t);
  const result = await bridge.play(track, 'echo1', 'apple-music', native);
  assert.equal(remote.discoveryCalls, 1); assert.equal(remote.validations.length, 1); assert.equal(remote.sent.length, 1); assert.equal(remote.textNodes.length, 0);
  assert.equal(remote.validations[0].url, '/api/behaviors/operation/validate'); assert.equal(remote.validations[0].flags.method, 'POST');
  assert.equal(remote.validations[0].operation.type, 'Alexa.Music.PlaySearchPhrase');
  assert.deepEqual(payloadOf(remote), { deviceType: 'ECHO_TYPE', deviceSerialNumber: 'echo1', locale: 'en-IN', customerId: 'owner-one', musicProviderId: 'APPLE_MUSIC', searchPhrase: 'song Baby by Justin Bieber' });
  assert.equal(remote.sent[0].deviceId, 'echo1'); assert.equal(remote.sent[0].sequence.startNode.type, 'Alexa.Music.PlaySearchPhrase');
  assert.deepEqual(sentPayload(remote), payloadOf(remote)); assert.equal(result.requestMode, 'music-request-test'); assert.equal(result.status, 'sent');
  assert.match(result.message, /^Music request test sent/); assert.doesNotMatch(result.message, /autoplay (?:enabled|confirmed)/i);
  assert.equal(JSON.stringify(result).includes('owner-one'), false); assert.equal(JSON.stringify(result).includes('operationPayload'), false);
});

test('standard path keeps the original phrase, TextCommand transport, locale and acknowledgement', async t => {
  const { bridge, remote } = await setup(t);
  const result = await bridge.play(track, 'echo1', 'apple-music');
  assert.equal(remote.discoveryCalls, 0); assert.equal(remote.validations.length, 0); assert.equal(remote.sent.length, 1);
  assert.deepEqual(remote.textNodes[0], { command: 'textCommand', text: 'play song Baby by Justin Bieber on Apple Music', deviceId: 'echo1' });
  assert.equal(remote.sent[0].sequence.startNode.type, 'Alexa.TextCommand'); assert.equal(remote.sent[0].sequence.startNode.operationPayload.locale, 'en-IN');
  assert.equal(result.message, 'Request sent to Bedroom Echo. Requested on Apple Music.'); assert.equal(result.requestMode, 'standard');
  assert.equal(bridge.commands().commands[0].text, 'play song baby by justin bieber on apple music');
});

test('native journal preserves the usual displayed command and labels only its acknowledgement as a test', async t => {
  const { bridge } = await setup(t); const result = await bridge.play(track, 'echo1', 'apple-music', native);
  const entry = bridge.commands().commands.find(item => item.id === result.commandId);
  assert.equal(entry.text, 'play song Baby by Justin Bieber on Apple Music'); assert.equal(entry.kind, 'music');
  assert.equal(entry.message, 'Alexa accepted the music request test.'); assert.equal(entry.response, null); assert.equal(entry.responseStatus, 'unavailable');
  assert.equal(bridge.latestCommands.get('echo1').id, result.commandId); assert.equal(bridge.responseJobs.size, 0);
  assert.equal(JSON.stringify(entry).includes('customerId'), false); assert.equal(JSON.stringify(entry).includes('owner-one'), false);
});

test('no guessed provider, default provider, radio provider or fallback can enter the native transport', async t => {
  const { bridge, remote } = await setup(t);
  for (const id of ['alexa-default', 'tunein']) await assert.rejects(bridge.play(track, 'echo1', id, native), { code: 'MUSIC_REQUEST_PROVIDER_REQUIRED' });
  await assert.rejects(bridge.play(track, 'echo1', 'spotify', native), { code: 'MUSIC_REQUEST_PROVIDER_UNAVAILABLE' });
  assert.equal(remote.validations.length, 0); assert.equal(remote.sent.length, 0); assert.equal(remote.textNodes.length, 0);
});

test('provider discovery must advertise AVAILABLE and the exact music search operation', async t => {
  const { bridge, remote } = await setup(t);
  for (const row of [supported('APPLE_MUSIC', { availability: 'UNAVAILABLE' }), supported('APPLE_MUSIC', { supportedOperations: [] }), supported('SPOTIFY'), { id: 'APPLE_MUSIC', availability: 'AVAILABLE' }]) {
    bridge.lastCommandAt = 0; remote.providers = [row];
    await assert.rejects(bridge.play(track, 'echo1', 'apple-music', native), { code: 'MUSIC_REQUEST_PROVIDER_UNAVAILABLE' });
  }
  assert.equal(remote.validations.length, 0); assert.equal(remote.sent.length, 0);
});

test('read-only eligibility preflight has no journal, audio or busy side effects', async t => {
  const { bridge, remote } = await setup(t);
  const provider = await bridge.requireMusicRequestProvider('apple-music');
  assert.equal(provider.nativeId, 'APPLE_MUSIC'); assert.equal(bridge.busy, false); assert.equal(bridge.lastCommandAt, 0);
  assert.equal(bridge.commands().commands.length, 0); assert.equal(remote.sent.length, 0); assert.equal(remote.validations.length, 0);
  await assert.rejects(bridge.requireMusicRequestProvider('spotify'), { code: 'MUSIC_REQUEST_PROVIDER_UNAVAILABLE' });
  assert.equal(bridge.commands().commands.length, 0);
});

test('native mapping uses the actually discovered alias and keeps it out of public provider data', () => {
  const rows = [supported('JIO_SAAVN')]; const selected = resolveDiscoveredMusicProvider(rows, 'jiosaavn');
  assert.equal(selected.nativeId, 'JIO_SAAVN');
  assert.equal(JSON.stringify(parseMusicProviders(rows, 'IN')).includes('nativeId'), false);
  assert.throws(() => resolveDiscoveredMusicProvider([supported('SAAVN'), supported('JIO_SAAVN')], 'jiosaavn'), { code: 'MUSIC_REQUEST_PROVIDER_UNAVAILABLE' });
});

test('invalid validation result, missing payload and malformed or oversized payload never dispatch', async t => {
  const { bridge, remote } = await setup(t);
  for (const result of [{ result: 'INVALID', operationPayload: '{}' }, { result: 'VALID' }, { result: 'VALID', operationPayload: 'not-json' }, { result: 'VALID', operationPayload: '[]' }, { result: 'VALID', operationPayload: JSON.stringify({ padding: 'x'.repeat(65536) }) }]) {
    bridge.lastCommandAt = 0; remote.validationHook = (request, callback) => callback(null, result);
    await assert.rejects(bridge.play(track, 'echo1', 'apple-music', native), { code: 'MUSIC_REQUEST_INVALID' });
  }
  assert.equal(remote.sent.length, 0); assert.equal(remote.textNodes.length, 0);
});

test('validated payload must preserve the selected device, owner, locale, service and query', async t => {
  const { bridge, remote } = await setup(t);
  for (const change of [{ deviceSerialNumber: 'other-device' }, { customerId: 'other-owner' }, { locale: 'de-DE' }, { musicProviderId: 'SPOTIFY' }, { searchPhrase: 'some other request' }]) {
    bridge.lastCommandAt = 0;
    remote.validationHook = (request, callback) => callback(null, { result: 'VALID', operationPayload: JSON.stringify({ ...JSON.parse(request.operation.operationPayload), ...change }) });
    await assert.rejects(bridge.play(track, 'echo1', 'apple-music', native), { code: 'MUSIC_REQUEST_INVALID' });
  }
  assert.equal(remote.sent.length, 0);
});

test('usable object-form validated payload is accepted without adding an autoplay or queue flag', async t => {
  const { bridge, remote } = await setup(t);
  remote.validationHook = (request, callback) => callback(null, { result: 'VALID', operationPayload: JSON.parse(request.operation.operationPayload) });
  await bridge.play(track, 'echo1', 'apple-music', native);
  assert.equal(typeof remote.sent[0].sequence.startNode.operationPayload, 'object');
  const payload = sentPayload(remote); assert.deepEqual(Object.keys(payload).sort(), ['customerId', 'deviceSerialNumber', 'deviceType', 'locale', 'musicProviderId', 'searchPhrase']);
  assert.equal(Object.keys(payload).some(key => /autoplay|queue|repeat/i.test(key)), false); assert.equal(remote.sent.length, 1);
});

test('validation timeout fails safely, ignores its eventual callback and never falls back', async t => {
  const { bridge, remote } = await setup(t, { musicRequestTimeoutMs: 25 }); let finish;
  remote.validationHook = (request, callback) => { finish = () => callback(null, { result: 'VALID', operationPayload: request.operation.operationPayload }); };
  await assert.rejects(bridge.play(track, 'echo1', 'apple-music', native), { code: 'ALEXA_UNAVAILABLE' });
  finish(); await flush(); assert.equal(remote.sent.length, 0); assert.equal(remote.textNodes.length, 0); assert.equal(bridge.busy, false);
  assert.equal(bridge.commands().commands[0].status, 'failed');
});

test('raw discovery, validation and preview errors never expose upstream secrets or double-send', async t => {
  const { bridge, remote } = await setup(t);
  for (const stage of ['discovery', 'validation', 'preview']) {
    bridge.lastCommandAt = 0; remote.discoveryHook = null; remote.validationHook = null; remote.sendHook = null;
    if (stage === 'discovery') remote.discoveryHook = callback => callback(new Error('private-cookie-and-token'));
    if (stage === 'validation') remote.validationHook = (request, callback) => callback(null, { errorMessage: 'private-cookie-and-token' });
    if (stage === 'preview') remote.sendHook = callback => callback(new Error('private-cookie-and-token'));
    const before = remote.sent.length;
    await assert.rejects(bridge.play(track, 'echo1', 'apple-music', native), error => error.code === 'ALEXA_UNAVAILABLE' && !error.message.includes('private'));
    assert.equal(remote.sent.length - before, stage === 'preview' ? 1 : 0); assert.equal(remote.textNodes.length, 0);
  }
  assert.equal(JSON.stringify(bridge.commands()).includes('private-cookie'), false);
});

test('invalid intent before discovery performs no discovery or dispatch', async t => {
  const { bridge, remote } = await setup(t);
  await assert.rejects(bridge.play(track, 'echo1', 'apple-music', { ...native, valid: () => false }), { code: 'PLAYBACK_CHANGED' });
  assert.equal(remote.discoveryCalls, 0); assert.equal(remote.validations.length, 0); assert.equal(remote.sent.length, 0); assert.equal(bridge.commands().commands.length, 0);
});

test('a newer intent during discovery cannot validate or dispatch the older test', async t => {
  const { bridge, remote } = await setup(t); let valid = true, finish;
  remote.discoveryHook = callback => { finish = () => callback(null, [supported()]); };
  const request = bridge.play(track, 'echo1', 'apple-music', { ...native, valid: () => valid }); await flush();
  valid = false; finish(); await assert.rejects(request, { code: 'PLAYBACK_CHANGED' });
  assert.equal(remote.validations.length, 0); assert.equal(remote.sent.length, 0);
});

test('a newer intent during or immediately after validation cannot dispatch the older test', async t => {
  const { bridge, remote } = await setup(t); let valid = true;
  remote.validationHook = (request, callback) => { callback(null, { result: 'VALID', operationPayload: request.operation.operationPayload }); valid = false; };
  await assert.rejects(bridge.play(track, 'echo1', 'apple-music', { ...native, valid: () => valid }), { code: 'PLAYBACK_CHANGED' });
  assert.equal(remote.sent.length, 0); assert.equal(remote.textNodes.length, 0);
});

test('connection changes during discovery or validation cannot send to a replacement Echo connection', async t => {
  const { bridge, remote } = await setup(t);
  let finish;
  remote.validationHook = (request, callback) => { finish = () => callback(null, { result: 'VALID', operationPayload: request.operation.operationPayload }); };
  const request = bridge.play(track, 'echo1', 'apple-music', native); await flush();
  bridge.disconnect(); finish(); await assert.rejects(request, { code: 'CONNECTION_CHANGED' });
  assert.equal(remote.sent.length, 0); assert.equal(remote.textNodes.length, 0);
});

test('preflight discovery also observes current intent and connection guards', async t => {
  const { bridge, remote } = await setup(t); let valid = true, finish;
  remote.discoveryHook = callback => { finish = () => callback(null, [supported()]); };
  const request = bridge.requireMusicRequestProvider('apple-music', { valid: () => valid }); await flush();
  valid = false; finish(); await assert.rejects(request, { code: 'PLAYBACK_CHANGED' });
  assert.equal(remote.sent.length, 0); assert.equal(bridge.commands().commands.length, 0);
});

test('invalid mode and missing trusted device owner fail before any native command', async t => {
  const { bridge, remote } = await setup(t);
  await assert.rejects(bridge.play(track, 'echo1', 'apple-music', { requestMode: 'unknown' }), { code: 'INVALID_REQUEST_MODE' });
  remote.serialNumbers.echo1.deviceOwnerCustomerId = '';
  await assert.rejects(bridge.play(track, 'echo1', 'apple-music', native), { code: 'MUSIC_REQUEST_DEVICE_UNAVAILABLE' });
  assert.equal(remote.sent.length, 0); assert.equal(remote.validations.length, 0);
});


test('installed stock pipeline preserves the validation payload type on the actual preview wire', async t => {
  const { bridge, remote } = await setup(t);
  for (const rawType of ['object', 'string']) {
    let stockPreview;
    const stock = Object.create(AlexaRemote.prototype);
    stock.find = () => remote.serialNumbers.echo1;
    stock.httpsGet = (url, callback, flags) => {
      const request = JSON.parse(flags.data);
      if (url === '/api/behaviors/operation/validate') {
        const payload = JSON.parse(request.operationPayload);
        callback(null, { result: 'VALID', operationPayload: rawType === 'object' ? payload : JSON.stringify(payload) });
      } else { assert.equal(url, '/api/behaviors/preview'); stockPreview = JSON.parse(request.sequenceJson); callback(null, {}); }
    };
    stock.playMusicProvider('echo1', 'APPLE_MUSIC', 'song Baby by Justin Bieber', () => {});
    assert.equal(typeof stockPreview.startNode.operationPayload, rawType);
    bridge.lastCommandAt = 0; remote.sent.length = 0;
    remote.validationHook = (request, callback) => { const payload = JSON.parse(request.operation.operationPayload); callback(null, { result: 'VALID', operationPayload: rawType === 'object' ? payload : JSON.stringify(payload) }); };
    await bridge.play(track, 'echo1', 'apple-music', native);
    let appPreview;
    stock.httpsGet = (url, callback, flags) => { assert.equal(url, '/api/behaviors/preview'); appPreview = JSON.parse(JSON.parse(flags.data).sequenceJson); callback(null, {}); };
    stock.sendSequenceCommand('echo1', remote.sent[0].sequence, () => {});
    assert.equal(typeof appPreview.startNode.operationPayload, typeof stockPreview.startNode.operationPayload);
    assert.equal((typeof appPreview.startNode.operationPayload === 'string' ? JSON.parse(appPreview.startNode.operationPayload) : appPreview.startNode.operationPayload).locale, 'en-IN');
  }
});

test('no-audio inspection reports raw object and string types without values or command side effects', async t => {
  const { bridge, remote } = await setup(t);
  for (const rawType of ['object', 'string']) {
    remote.validationHook = (request, callback) => {
      const payload = { ...JSON.parse(request.operation.operationPayload), privateToken: 'private-value-do-not-return' };
      callback(null, { result: 'VALID', operationPayload: rawType === 'object' ? payload : JSON.stringify(payload) });
    };
    const result = await bridge.inspectMusicRequestTest(track, 'echo1', 'apple-music');
    assert.equal(result.status, 'checked'); assert.equal(result.audioSent, false); assert.equal(result.diagnostics.payloadType, rawType);
    assert.equal(result.diagnostics.previewPayloadType, rawType); assert.equal(result.diagnostics.checks.payloadUsable, true);
    assert.deepEqual(result.diagnostics.fields.find(field => field.name === 'customerId'), { name: 'customerId', type: 'string' });
    assert.equal(result.diagnostics.fields.find(field => field.name === 'privateToken').type, 'string');
    const exposed = JSON.stringify(result);
    for (const value of ['owner-one', 'echo1', 'ECHO_TYPE', 'Baby', 'Justin Bieber', 'private-value-do-not-return']) assert.equal(exposed.includes(value), false, value);
    assert.equal(bridge.lastCommandAt, 0); assert.equal(bridge.busy, false); assert.equal(bridge.commands().commands.length, 0);
    assert.equal(remote.sent.length, 0); assert.equal(remote.textNodes.length, 0); assert.equal(bridge.latestCommands.size, 0);
  }
});

test('inspection exposes safe null, malformed and rejected response shape instead of hiding it behind an error', async t => {
  const { bridge, remote } = await setup(t);
  for (const [operationPayload, expectedType] of [[null, 'null'], [undefined, 'missing'], ['not-json-private-value', 'string'], [[], 'array'], [42, 'number']]) {
    remote.validationHook = (request, callback) => callback(null, { result: 'INVALID', operationPayload });
    const result = await bridge.inspectMusicRequestTest(track, 'echo1', 'apple-music');
    assert.equal(result.diagnostics.payloadType, expectedType); assert.equal(result.diagnostics.checks.validationValid, false);
    assert.equal(result.diagnostics.checks.payloadUsable, false); assert.equal(result.audioSent, false);
    assert.equal(JSON.stringify(result).includes('not-json-private-value'), false);
  }
  assert.equal(remote.sent.length, 0); assert.equal(bridge.commands().commands.length, 0);
});

test('inspection returns identity mismatch booleans and bounded field names, never raw mismatched values', async t => {
  const { bridge, remote } = await setup(t);
  remote.validationHook = (request, callback) => {
    const payload = { ...JSON.parse(request.operation.operationPayload), customerId: 'private-other-owner', deviceSerialNumber: 'private-other-device', locale: 'private-other-locale' };
    for (let index = 0; index < 40; index++) payload['field' + index] = 'private-extra-value';
    payload['unsafe\nfield'] = 'private-unsafe-value';
    callback(null, { result: 'VALID', operationPayload: payload });
  };
  const result = await bridge.inspectMusicRequestTest(track, 'echo1', 'apple-music');
  assert.equal(result.diagnostics.checks.validationValid, true); assert.equal(result.diagnostics.checks.payloadUsable, false);
  assert.equal(result.diagnostics.checks.deviceMatches, false); assert.equal(result.diagnostics.checks.customerMatches, false); assert.equal(result.diagnostics.checks.localeMatches, false);
  assert.equal(result.diagnostics.fields.length, 32); assert.equal(result.diagnostics.fieldsTruncated, true);
  assert.equal(result.diagnostics.fields.every(field => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(field.name)), true);
  assert.equal(JSON.stringify(result).includes('private-'), false); assert.equal(remote.sent.length, 0);
});

test('inspection observes intent changes after validation and cannot dispatch or publish stale diagnostics', async t => {
  const { bridge, remote } = await setup(t); let valid = true;
  remote.validationHook = (request, callback) => { callback(null, { result: 'VALID', operationPayload: JSON.parse(request.operation.operationPayload) }); valid = false; };
  await assert.rejects(bridge.inspectMusicRequestTest(track, 'echo1', 'apple-music', { valid: () => valid }), { code: 'PLAYBACK_CHANGED' });
  assert.equal(remote.sent.length, 0); assert.equal(bridge.commands().commands.length, 0); assert.equal(bridge.lastCommandAt, 0);
});
