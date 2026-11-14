import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../../library/public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../library/public/index.html', import.meta.url), 'utf8');
function frontendFunction(name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(script); assert.ok(match, name);
  const rest = script.slice(match.index), next = /\n  (?:async )?function /g; next.lastIndex = 1; const end = next.exec(rest); return end ? rest.slice(0, end.index) : rest;
}
class Node {
  constructor() { this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.open = false; this.dataset = {}; this.listeners = {}; }
  addEventListener(event, handler) { this.listeners[event] = handler; }
  setAttribute() {}
}
function harness(response = async () => ({})) {
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const calls = [], cancellations = [], toasts = [], persistence = [];
  const context = vm.createContext({ console, Promise, JSON, Set, Map, encodeURIComponent, $: get, fallbackProviders: [{ id: 'apple-music', name: 'Apple Music', kind: 'music', reportedByAlexa: false }], document: { querySelectorAll: () => [] }, localStorage: { getItem: () => 'music-request-test', setItem: (...args) => persistence.push(args) },
    renderSearchReadiness() {}, renderPlayer() {}, renderPlaylistActions() {}, renderSongActionReadiness() {}, renderQueue() {}, renderPlayback() {}, updatePlayButtons() {}, scheduleStatus() {},
    toast: (message, error) => toasts.push({ message, error }),
    api: async (path, options) => { const body = options?.body ? JSON.parse(options.body) : null; calls.push({ path, body }); return response(path, body); },
    cancelPlayback: async options => { cancellations.push(options); },
    applyPlayback: job => { context.state.playback = job; }, applyQueue: queue => { context.state.queue = queue; }, toggleQueue: open => { context.state.queueOpen = open; },
    normalizeCountry: value => String(value || '').toUpperCase()
  });
  const declaration = script.split('\n').find(line => line.startsWith('  const state = ')); assert.ok(declaration); vm.runInContext(declaration.replace('const state = ', 'globalThis.state = '), context);
  const state = context.state; state.connection.state = 'connected'; state.devices = [{ id: 'echo', name: 'Echo Dot', online: true }]; state.deviceId = 'echo'; state.providers = [{ id: 'apple-music', name: 'Apple Music', kind: 'music', reportedByAlexa: true }, { id: 'spotify', name: 'Spotify', kind: 'music', reportedByAlexa: false }, { id: 'alexa-default', name: 'Alexa default', kind: 'default', reportedByAlexa: true }, { id: 'tunein', name: 'TuneIn', kind: 'radio', reportedByAlexa: true }]; state.resultsCountry = 'IN'; state.resultsSource = 'itunes'; get('country-select').value = 'IN';
  const names = ['selectedDevice', 'canPlay', 'canPlayResult', 'providerName', 'selectedProvider', 'requestModeProblem', 'canRequestSong', 'requestModeName', 'renderRequestMode', 'sendTrack', 'selectionIsCurrent', 'selectionInCountry', 'playSelection', 'songHandoffBusy', 'canQueueSong', 'enqueueSelection', 'queuePlaybackModes', 'queueReady', 'activeQueue'];
  vm.runInContext(names.map(frontendFunction).join('\n'), context); vm.runInContext('function activePlayback(){return !!(state.playback && state.playback.active)}', context);
  return { state, get, calls, cancellations, toasts, persistence, run: code => vm.runInContext(code, context), context };
}

const track = { id: 'song', title: 'Lover', artist: 'Taylor Swift' };
function searchTrack(h) { h.state.tracks = [track]; h.context.track = track; }

test('the playback test controls, styling hooks and listener are removed while every page defaults to standard', async () => {
  const h = harness(); assert.equal(h.state.requestMode, 'standard'); h.state.requestMode = 'music-request-test'; h.run('renderRequestMode()'); assert.equal(h.state.requestMode, 'standard');
  assert.equal(/id="(?:playback-test|request-mode-[^"]+)"/.test(html), false); assert.equal(/\$\('(?:playback-test|request-mode-[^']+)'\)/.test(script), false); assert.equal(/function changeRequestMode\(/.test(script), false); const css = await readFile(new URL('../../library/public/app.css', import.meta.url), 'utf8'); assert.equal(css.includes('.playback-test'), false); assert.equal(h.persistence.length, 0);
});

test('standard search-song requests explicitly retain normal playback payloads', async () => {
  const h = harness(async () => ({ status: 'sent', playback: { id: 'job', state: 'checking', requestMode: 'standard' } })); searchTrack(h); await h.run('sendTrack(track)');
  assert.deepEqual(h.calls[0], { path: '/api/play', body: { trackId: 'song', deviceId: 'echo', country: 'IN', providerId: 'apple-music', requestMode: 'standard' } });
});

test('hidden stale experimental state cannot block or change either individual song request path', async () => {
  const h = harness(async () => ({ status: 'sent', playback: { id: 'job', state: 'matched', active: false, requestMode: 'standard' } })); searchTrack(h); h.state.requestMode = 'music-request-test'; h.state.requestModeChanging = true; await h.run('sendTrack(track)'); h.state.requestMode = 'music-request-test'; await h.run("playSelection({source:'local',playlistId:'saved',entryId:'entry',country:'IN'},track,()=>true)");
  assert.deepEqual(h.calls.map(call => [call.path, call.body.requestMode]), [['/api/play', 'standard'], ['/api/play-selection', 'standard']]); assert.equal(h.state.requestMode, 'standard'); assert.equal(h.cancellations.length, 0);
});

test('Alexa default, radio and unreported services retain their normal song request behavior', async () => {
  for (const provider of ['alexa-default', 'tunein', 'spotify', 'unsupported-saved-service']) {
    const h = harness(); searchTrack(h); h.state.requestMode = 'music-request-test'; h.state.providerId = provider; assert.equal(h.run('canRequestSong()'), true, provider); assert.equal(h.run('requestModeProblem()'), ''); await h.run('sendTrack(track)'); assert.equal(h.calls.length, 1, provider); assert.equal(h.calls[0].body.requestMode, 'standard'); assert.equal(h.calls[0].body.providerId, provider);
  }
});

test('normal readiness still blocks disconnected devices, stale-country results and overlapping submissions', async () => {
  const h = harness(); searchTrack(h); h.state.connection.state = 'disconnected'; await h.run('sendTrack(track)'); assert.equal(h.calls.length, 0); h.state.connection.state = 'connected'; h.state.resultsCountry = 'US'; await h.run('sendTrack(track)'); assert.equal(h.calls.length, 0); h.state.resultsCountry = 'IN'; h.state.pendingTrack = 'previous'; await h.run('sendTrack(track)'); assert.equal(h.calls.length, 0);
});

test('queue payloads and selected streaming providers remain independent of obsolete diagnostic state', async () => {
  const h = harness(async () => ({ queue: { id: 'queue', active: true, state: 'ready', country: 'IN', providerId: 'spotify', items: [] } })); h.state.requestMode = 'music-request-test'; h.state.providerId = 'spotify'; assert.equal(h.run('canQueueSong()'), true); await h.run("enqueueSelection({source:'catalogue',trackId:'song',country:'IN'},'last',()=>true)"); assert.equal(h.calls[0].path, '/api/queue/items'); assert.equal(h.calls[0].body.requestMode, undefined); assert.equal(h.calls[0].body.providerId, 'spotify');
});

test('normalizing old UI state neither cancels active work nor changes a queue', () => {
  for (const phase of ['ready', 'paused', 'playing']) { const h = harness(); h.state.queue = { id: 'queue', active: true, state: phase }; h.state.playback = { id: 'current', active: phase !== 'ready' }; h.state.requestMode = 'music-request-test'; h.run('renderRequestMode();canRequestSong()'); assert.equal(h.state.requestMode, 'standard'); assert.equal(h.state.queue.state, phase); assert.equal(h.state.playback.id, 'current'); assert.equal(h.cancellations.length, 0); assert.equal(h.calls.length, 0); }
});

test('historical attempt feedback can still identify the method actually reported by the server', () => {
  const h = harness(); assert.equal(h.run("requestModeName('music-request-test')"), 'Music request test'); assert.equal(h.run("requestModeName('standard')"), 'Current method'); assert.match(frontendFunction('renderPlayback'), /requestModeName\(selection\.requestMode\)/);
});
