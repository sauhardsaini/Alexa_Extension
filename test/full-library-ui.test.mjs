import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import './full-library-ui/ui-playback-mode.test.mjs';
import './full-library-ui/ui-playlists.test.mjs';
import './full-library-ui/ui-live-search.test.mjs';
import './full-library-ui/ui-playlist-import.test.mjs';
import './full-library-ui/ui-sidebar.test.mjs';
const script = await readFile(new URL('../library/public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../library/public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../library/public/app.css', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };
const TRACK = { id: 'song-1', title: 'Lover', artist: 'Taylor Swift', album: 'Lover', durationMs: 221000, country: 'IN', url: 'https://music.apple.com/in/song/lover/1' };
function harness({ response, saved = {} } = {}) {
  const calls = [], messages = [], timers = new Map(), nodes = new Map(), stored = new Map(Object.entries(saved)); let serial = 0;
  const document = { hidden: false, activeElement: null, listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, removeEventListener(name) { delete this.listeners[name]; } };
  class Node {
    constructor(tag = 'div', id = '') { this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.open = false; this.tabIndex = 0; this.isConnected = true; this.style = { setProperty() {} }; const names = new Set(); this.classList = { add: value => names.add(value), remove: value => names.delete(value), contains: value => names.has(value), toggle(value, force) { const active = force === undefined ? !names.has(value) : force; if (active) names.add(value); else names.delete(value); return active; } }; }
    appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
    replaceChildren(...nodes) { this.children = []; nodes.forEach(node => this.appendChild(node)); }
    get options() { return this.children; }
    get firstElementChild() { return this.children[0] || null; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'hidden') this.hidden = true; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'hidden') this.hidden = false; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    getClientRects() { return this.hidden ? [] : [{}]; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 50, bottom: 50 }; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelectorAll() { return []; }
    querySelector(selector) { let node = this.children.find(child => child.tagName === selector.toUpperCase()); if (!node) node = this.appendChild(new Node(selector)); return node; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() { this.isConnected = false; }
    reset() { this.resetCalled = true; }
    removeEventListener(name, callback) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== callback); }
    async dispatch(name, extra = {}) { const event = { preventDefault() {}, stopPropagation() {}, target: this, currentTarget: this, ...extra }; for (const callback of this.listeners[name] || []) await callback(event); }
  }
  for (const match of html.matchAll(/<([a-z0-9-]+)\b[^>]*\bid="([^"]+)"[^>]*>/giu)) {
    const node = new Node(match[1], match[2]); node.hidden = /\shidden(?:\s|>)/u.test(match[0]); node.disabled = /\sdisabled(?:\s|>)/u.test(match[0]); nodes.set(node.id, node);
  }
  for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/giu)) {
    const node = nodes.get(match[1]); for (const option of match[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/giu)) { const child = new Node('option'); child.value = option[1]; child.textContent = option[2]; node.appendChild(child); }
    node.value = node.children[0]?.value || '';
  }
  const get = id => { assert.ok(nodes.has(id), 'UI references an existing element: ' + id); return nodes.get(id); };
  document.head = new Node('head'); document.body = new Node('body'); document.documentElement = new Node('html'); document.activeElement = document.body;
  const shell = document.body.appendChild(new Node('div', 'app-shell')), player = document.body.appendChild(new Node('section', 'player-bar'));
  document.getElementById = get; document.createTextNode = text => { const node = new Node('#text'); node.textContent = text; return node; }; document.createElement = tag => new Node(tag); document.createElementNS = (_ns, tag) => new Node(tag);
  document.querySelector = selector => ({ '.app-shell': shell, '.player-bar': player }[selector] || null);
  document.querySelectorAll = () => [];
  const defaultResponse = async path => {
    if (path === '/api/status') return { connection: { state: 'connected', message: 'Connected' }, settings: { region: 'IN', locale: 'en-IN', country: 'IN' }, devices: [{ id: 'echo', name: 'Living room Echo', online: true }], catalogue: { source: 'itunes' }, player: null, playback: null, queue: null };
    if (path === '/api/music-providers') return { providers: [], discovery: 'ready', defaultProviderId: 'apple-music' };
    if (path.startsWith('/api/player')) return { player: null, volume: 25 };
    if (path === '/api/commands') return { commands: [], retention: 'session' };
    if (path.startsWith('/api/search')) return { tracks: [TRACK], source: 'itunes', country: new URL(path, 'http://test').searchParams.get('country') || 'IN' };
    if (path === '/api/local-playlists') return { playlists: [{ id: 'list-1', name: 'Saved here', country: 'IN', itemCount: 1 }] };
    if (path === '/api/play') return { message: 'Song accepted', playback: { id: 'job-1', state: 'checking', active: true, deviceId: 'echo', providerId: 'apple-music', title: TRACK.title, artist: TRACK.artist, attempt: 1, maxAttempts: 4 } };
    return {};
  };
  const context = vm.createContext({ document, console, URL, AbortController, Promise, JSON, Date, Set, Map, Array, Number, String, Object, Math, performance: { now: () => Date.now() },
    setTimeout(callback, ms) { const id = ++serial; timers.set(id, { callback, ms }); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() { return ++serial; },
    localStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, String(value)) },

  });
  const popups = [];
  context.window = { location: { href: 'http://127.0.0.1:4320/', origin: 'http://127.0.0.1:4320' }, history: { replaceState() {} }, innerWidth: 1440, innerHeight: 900, matchMedia: () => ({ matches: false }), addEventListener() {}, open(initial,name,features) { const popup = { closed: false, opener: {}, location: { href: initial, replace(value) { this.href = value; } }, focus() {}, close() { this.closed = true; } }; popups.push({initial,name,features,popup}); return popup; } };
  context.fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, signal: options.signal });
    const value = response ? await response(path, options, defaultResponse) : await defaultResponse(path);
    return { ok: true, status: 200, json: async () => value };
  };
  const expose = "\n  globalThis.library = { state, search, sendTrack, setBrowseView, loadPlaylists, openPlaylistImport, loadPlaylistImport, savePlaylistImport, renderPlaylistImport, refreshStatus, chooseCataloguePlatform, connectOAuth, saveOAuthSetup, connectApple, loadMusicKit, applyQueue, sendCustomCommand, control, queueControl, cancelPlayback, renderQueue };\n";
  vm.runInContext(script.replace(/\}\(\)\);\s*$/u, expose + '}());'), context);
  return { get, nodes, calls, messages, timers, context, library: context.library, stored, popups };
}

test('full helper-hosted page keeps web-app account setup, search, playlists, queue and playback', () => {
  for (const id of ['music-catalogue','catalogue-platform-select','apple-connect-button','apple-setup-form','spotify-connect-button','spotify-setup-form','youtube-connect-button','youtube-setup-form','search-form','import-playlist-button','queue-items','custom-command-input','volume-slider','seek-slider']) assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(html, /id="local-helper-link" href="\/setup"[^>]*>Local helper · 0\.4\.0 ↗<\/a>/u);
  assert.ok(!html.includes('extension-api.js')); assert.ok(!script.includes('echoExtensionFetch')); assert.ok(!script.includes('chrome.runtime'));
  assert.match(html, /src="\/app\.js" defer/u); assert.match(script, /https:\/\/js-cdn\.music\.apple\.com\/musickit\/v3\/musickit\.js/u);
});

test('the full app boots against the helper origin, including the account catalogue chooser', async () => {
  const h=harness(); await flush();
  assert.equal(h.get('country-select').value,'IN'); assert.equal(h.library.state.deviceId,'echo');
  assert.equal(h.get('catalogue-platform-select').value,'apple-music');
  assert.equal(h.get('apple-section').hidden,false); assert.equal(h.get('spotify-section').hidden,true);
  h.library.chooseCataloguePlatform('spotify',true);
  assert.equal(h.get('spotify-section').hidden,false); assert.equal(h.get('apple-section').hidden,true);
  assert.ok(h.calls.some(call=>call.path==='/api/status')); assert.ok(h.calls.some(call=>call.path==='/api/music-providers'));
});

test('search keeps the selected country and standard native Echo playback payload', async () => {
  const h=harness();await flush();await h.library.search('Lover');await h.library.sendTrack(h.library.state.tracks[0]);
  assert.match(h.calls.find(call=>call.path.startsWith('/api/search')).path,/country=IN/u);
  assert.deepEqual(h.calls.find(call=>call.path==='/api/play').body,{trackId:'song-1',deviceId:'echo',country:'IN',providerId:'apple-music',requestMode:'standard'});
  assert.equal(h.library.state.playback.state,'checking');
});

test('Spotify sign-in uses its normal helper-backed OAuth endpoint and exact authorization origin', async () => {
  const h=harness({response:async(path,options,fallback)=>path==='/api/spotify/connect'?{authorizationUrl:'https://accounts.spotify.com/authorize?state=fixture'}:fallback(path,options)});await flush();
  h.library.state.spotify.configured=true; await h.library.connectOAuth('spotify');
  assert.equal(h.popups.length,1); assert.equal(h.popups[0].popup.opener,null);
  assert.equal(h.popups[0].popup.location.href,'https://accounts.spotify.com/authorize?state=fixture');
  assert.ok(h.calls.some(call=>call.path==='/api/spotify/connect'&&call.method==='POST'));
});

test('unrecognized account authorization destinations never receive popup navigation', async () => {
  const h=harness({response:async(path,options,fallback)=>path==='/api/youtube/connect'?{authorizationUrl:'https://evil.test/o/oauth2/v2/auth'}:fallback(path,options)});await flush();
  h.library.state.youtube.configured=true; await h.library.connectOAuth('youtube');
  assert.equal(h.popups[0].popup.closed,true); assert.equal(h.popups[0].popup.location.href,'about:blank');
  assert.match(h.get('toast').textContent,/sign-in address was not recognized/u);
});

test('unconfigured catalogue accounts keep their app setup flow instead of requesting credentials from a music website', async () => {
  const h=harness();await flush(); await h.library.connectOAuth('youtube');
  assert.equal(h.get('youtube-setup').open,true);assert.equal(h.context.document.activeElement,h.get('youtube-client-id'));assert.equal(h.popups.length,0);
  assert.match(html,/id="apple-private-key"[^>]*type="file"/u);assert.match(html,/id="youtube-client-secret" type="password"/u);
});

test('public playlist previews retain honest unknown-total warnings in the full account-enabled app',async()=>{
  const h=harness({response:async(path,options,fallback)=>path==='/api/playlist-import/preview'?{source:'spotify',name:'Visible playlist',tracks:[TRACK],total:null,truncated:true,fullCountUnverified:true,previewId:'preview-1'}:fallback(path,options)});await flush();
  h.library.openPlaylistImport();h.get('playlist-import-url').value='https://open.spotify.com/playlist/1234567890123456789012';await h.library.loadPlaylistImport();
  assert.equal(h.library.state.playlistImport.preview.total,null);assert.match(h.get('playlist-import-status').textContent,/visible entries.*count could not be verified.*partial/u);assert.doesNotMatch(h.get('playlist-import-status').textContent,/1 of 1/u);
  assert.ok(!h.calls.some(call=>call.path==='/api/play'||call.path==='/api/queue'));
});


function failedManualQueue() {
  const items = Array.from({ length: 10 }, (_, index) => ({ id: 'queue-song-' + (index + 1), title: 'Song ' + (index + 1), artist: 'Artist', state: index < 4 ? 'played' : index === 4 ? 'current' : 'pending' }));
  return { id: 'manual-queue', active: true, state: 'needs_attention', title: 'Saved playlist', index: 4, total: 10, deviceId: 'echo', country: 'IN', providerId: 'apple-music', providerName: 'Apple Music', items, currentTrack: items[4], message: 'The selected song could not be confirmed.', shuffle: false, repeatAll: false };
}
function manuallyAdoptedQueue(previous) {
  const items = previous.items.map(item => ({ ...item, state: item.state === 'current' ? 'played' : item.state }));
  const adopted = { id: 'manual-current', title: 'Manually requested song', artist: 'Manual Artist', state: 'current', source: 'player' };
  items.splice(5, 0, adopted);
  return { ...previous, state: 'playing', index: 5, total: 11, items, currentTrack: { ...adopted, adopted: true }, currentProviderName: 'Apple Music', message: 'Your manual song is playing; queued songs follow.' };
}
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('manual playback response inserts current song after failed fifth item and keeps the remaining queue controls working', async () => {
  const failed = failedManualQueue(), adopted = manuallyAdoptedQueue(failed);
  const next = { ...adopted, index: 6, currentTrack: adopted.items[6], items: adopted.items.map((item, index) => ({ ...item, state: index < 6 ? 'played' : index === 6 ? 'current' : 'pending' })) };
  const h = harness({ response: async (path, options, fallback) => path === '/api/command' ? { message: 'Manual request sent.', queue: adopted } : path === '/api/control' ? { queue: next } : fallback(path, options) }); await flush();
  h.library.applyQueue(failed, { fromMutation: true }); h.get('custom-command-input').value = 'Play the correct song';
  await h.library.sendCustomCommand({ preventDefault() {} });
  assert.equal(h.library.state.queue.id, failed.id); assert.equal(h.library.state.queue.active, true); assert.equal(h.library.state.queue.index, 5); assert.equal(h.library.state.queue.total, 11);
  assert.deepEqual(plain(h.library.state.queue.items.map(item => item.id)), ['queue-song-1', 'queue-song-2', 'queue-song-3', 'queue-song-4', 'queue-song-5', 'manual-current', 'queue-song-6', 'queue-song-7', 'queue-song-8', 'queue-song-9', 'queue-song-10']);
  assert.match(h.get('queue-track').textContent, /Current · Manually requested song · Manual Artist/u);
  assert.deepEqual(h.get('queue-items').children.map(row => row.children[0].children[1].textContent), ['Manually requested song', 'Song 6', 'Song 7', 'Song 8', 'Song 9', 'Song 10']);
  assert.equal(h.get('queue-next').hidden, false); assert.equal(h.get('queue-next').disabled, false);
  await h.library.control('next');
  assert.deepEqual(h.calls.find(call => call.path === '/api/control').body, { deviceId: 'echo', action: 'next' });
  assert.equal(h.library.state.queue.currentTrack.title, 'Song 6'); assert.match(h.get('queue-track').textContent, /Song 6/u);
});

test('manual command keeps a waiting queue active and ignores intermediate status until its response is applied', async () => {
  const pending = gate(), failed = failedManualQueue();
  const h = harness({ response: async (path, options, fallback) => path === '/api/command' ? pending.promise : fallback(path, options) }); await flush();
  h.library.applyQueue(failed, { fromMutation: true }); h.get('custom-command-input').value = 'Play the correct song';
  const sending = h.library.sendCustomCommand({ preventDefault() {} }); await flush();
  assert.equal(h.get('queue-next').disabled, true);
  h.library.applyQueue({ ...failed, active: false, state: 'cancelled' }, { queueEpoch: h.library.state.queueEpoch });
  assert.equal(h.library.state.queue.active, true);
  const count = h.calls.length; await h.library.queueControl('next'); assert.equal(h.calls.length, count);
  pending.resolve({ queue: { ...failed, message: 'Waiting to verify your manual song.' } }); await sending;
  assert.equal(h.library.state.queue.active, true); assert.equal(h.library.state.queue.items.length, 10); assert.match(h.get('queue-message').textContent, /Waiting to verify/u);
  const adopted = manuallyAdoptedQueue(failed); h.library.applyQueue(adopted, { queueEpoch: h.library.state.queueEpoch });
  assert.equal(h.library.state.queue.currentTrack.id, 'manual-current');
});

test('a late manual-command response cannot replace a newer queue or a different selected Echo', async () => {
  for (const change of ['queue', 'device']) {
    const pending = gate(), failed = failedManualQueue(), adopted = manuallyAdoptedQueue(failed);
    const h = harness({ response: async (path, options, fallback) => path === '/api/command' ? pending.promise : fallback(path, options) }); await flush();
    h.library.applyQueue(failed, { fromMutation: true }); h.get('custom-command-input').value = 'Play the correct song';
    const sending = h.library.sendCustomCommand({ preventDefault() {} }); await flush();
    if (change === 'queue') { ++h.library.state.queueEpoch; h.library.applyQueue({ ...failed, id: 'newer-queue', title: 'New choice' }, { fromMutation: true }); }
    else h.library.state.deviceId = 'another-echo';
    pending.resolve({ queue: adopted }); await sending;
    assert.equal(h.library.state.queue.id, change === 'queue' ? 'newer-queue' : failed.id);
    assert.equal(h.library.state.queue.items.length, 10, change);
  }
});

test('explicit cancellation during a manual request cannot be undone by its response or a later active status', async () => {
  const pending = gate(), failed = failedManualQueue(), adopted = manuallyAdoptedQueue(failed), cancelled = { ...failed, active: false, state: 'cancelled' };
  const h = harness({ response: async (path, options, fallback) => path === '/api/command' ? pending.promise : path === '/api/cancel-playback' ? { queue: cancelled } : fallback(path, options) }); await flush();
  h.library.applyQueue(failed, { fromMutation: true }); h.get('custom-command-input').value = 'Play the correct song';
  const sending = h.library.sendCustomCommand({ preventDefault() {} }); await flush();
  await h.library.cancelPlayback({ requestId: failed.id }); pending.resolve({ queue: adopted }); await sending;
  assert.equal(h.library.state.queue.active, false); assert.equal(h.library.state.queue.items.length, 10);
  h.library.applyQueue(adopted, { queueEpoch: h.library.state.queueEpoch }); assert.equal(h.library.state.queue.active, false);
});

test('a non-music manual command retains its returned queue without inventing a duplicate current song', async () => {
  const queue = { ...failedManualQueue(), state: 'playing' };
  const h = harness({ response: async (path, options, fallback) => path === '/api/command' ? { queue } : path === '/api/queue/control' ? { queue } : fallback(path, options) }); await flush();
  h.library.applyQueue(queue, { fromMutation: true }); h.get('custom-command-input').value = 'What time is it?';
  await h.library.sendCustomCommand({ preventDefault() {} });
  assert.equal(h.library.state.queue.items.length, 10); assert.equal(h.library.state.queue.currentTrack.id, 'queue-song-5');
  await h.library.queueControl('next'); assert.deepEqual(h.calls.find(call => call.path === '/api/queue/control').body, { action: 'next', requestId: queue.id });
});


test('queue Clear remains available during a manual request and its late response cannot restore the queue', async () => {
  const pending = gate(), failed = failedManualQueue(), adopted = manuallyAdoptedQueue(failed), cancelled = { ...failed, active: false, state: 'cancelled' };
  const h = harness({ response: async (path, options, fallback) => path === '/api/command' ? pending.promise : path === '/api/queue/control' ? { queue: cancelled } : fallback(path, options) }); await flush();
  h.library.applyQueue(failed, { fromMutation: true }); h.get('custom-command-input').value = 'Play the correct song';
  const sending = h.library.sendCustomCommand({ preventDefault() {} }); await flush();
  assert.equal(h.get('queue-next').disabled, true); assert.equal(h.get('queue-cancel').disabled, false);
  await h.library.queueControl('clear'); pending.resolve({ queue: adopted }); await sending;
  assert.equal(h.library.state.queue.active, false); assert.equal(h.library.state.queue.items.length, 10);
  assert.deepEqual(h.calls.find(call => call.path === '/api/queue/control').body, { action: 'clear', requestId: failed.id });
});
