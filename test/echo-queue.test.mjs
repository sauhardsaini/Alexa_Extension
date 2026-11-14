import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEchoQueue } from '../library/echo-queue.mjs';
import { AlexaBridge } from '../library/bridge.mjs';
import { libraryRoute } from '../extension/library-protocol.mjs';

test('Alexa queue parsing returns display metadata only and labels ordering only when reported', () => {
  const value = normalizeEchoQueue({ currentIndex: 1, provider: { name: 'Apple Music' }, secret: 'private', queue: [
    { title: 'Past', artist: 'A' },
    { title: 'Current', artist: { name: 'B' }, token: 'do-not-expose' },
    { title: { text: 'Next' }, subtitle: 'C', playbackUrl: 'https://example.com/private' },
  ] });
  assert.equal(value.state, 'available'); assert.equal(value.providerName, 'Apple Music');
  assert.deepEqual(value.items.map(item => [item.title, item.artist, item.state]), [['Current', 'B', 'current'], ['Next', 'C', 'pending']]);
  assert.doesNotMatch(JSON.stringify(value), /secret|private|token|playbackUrl/);
  const unknown = normalizeEchoQueue({ queue: [{ title: 'Reported song', artist: 'Artist' }] });
  assert.equal(unknown.items[0].state, 'reported'); assert.match(unknown.message, /partial/);
});
test('empty, unsupported and malformed responses never imply a complete or invented queue', () => {
  for (const raw of [null, {}, { queue: [] }, { queue: [{ token: 'secret' }] }]) {
    const value = normalizeEchoQueue(raw); assert.equal(value.state, 'unavailable'); assert.deepEqual(value.items, []); assert.match(value.message, /did not provide/);
  }
  const many = normalizeEchoQueue({ items: Array.from({ length: 100 }, () => ({ title: 'Song', artist: 'Artist' })) }); assert.equal(many.items.length, 50);
});
test('the bridge reads the selected Echo queue without playback commands and the local route is allowlisted', async () => {
  const bridge = Object.create(AlexaBridge.prototype), calls = [];
  bridge.requireDevice = id => { assert.equal(id, 'echo'); };
  bridge.call = async (method, args) => { calls.push([method, args]); return { queue: [{ title: 'Alexa song', artist: 'Artist' }] }; };
  assert.equal((await bridge.playerQueue('echo')).items[0].title, 'Alexa song');
  assert.deepEqual(calls, [['getPlayerQueue', ['echo', 50]]]);
  assert.equal(libraryRoute('/api/echo-queue?deviceId=echo'), '/api/echo-queue?deviceId=echo'); assert.equal(libraryRoute('/api/echo-queue', 'POST'), null);
  bridge.requireDevice = () => { throw new Error('invalid device'); }; await assert.rejects(bridge.playerQueue('unknown')); assert.equal(calls.length, 1);
});
