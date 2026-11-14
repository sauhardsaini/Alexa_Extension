import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../extension/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/app.html', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };
const TRACK = { id: 'song-1', title: 'Lover', artist: 'Taylor Swift', album: 'Lover', durationMs: 221000, country: 'IN', url: 'https://music.apple.com/in/song/lover/1' };
function harness({ response, paired = true, helperAvailable = true, saved = {} } = {}) {
  const calls = [], messages = [], timers = new Map(), nodes = new Map(), stored = new Map(Object.entries(saved)); let serial = 0;
  const document = { hidden: false, activeElement: null, listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; } };
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
  document.body = new Node('body'); document.documentElement = new Node('html'); document.activeElement = document.body;
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
    chrome: { runtime: { getManifest: () => ({ version: '0.3.0' }), sendMessage: async message => { messages.push(message); if (message.type === 'GET_CONNECTION') return { ok: true, paired, helperAvailable, version: '0.3.0' }; if (message.type === 'SET_PAIR_TOKEN') paired = true; return { ok: true }; } } }
  });
  context.window = { location: { href: 'chrome-extension://test/app.html' }, innerWidth: 1440, innerHeight: 900, matchMedia: () => ({ matches: false }), addEventListener() {}, echoExtensionFetch: async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, signal: options.signal });
    const value = response ? await response(path, options, defaultResponse) : await defaultResponse(path);
    return { ok: true, status: 200, json: async () => value };
  } };
  const expose = "\n  globalThis.library = { state, search, sendTrack, setBrowseView, loadPlaylists, openPlaylistImport, loadPlaylistImport, savePlaylistImport, renderPlaylistImport, refreshExtensionConnection, saveExtensionPairing, refreshStatus };\n";
  vm.runInContext(script.replace(/\}\(\)\);\s*$/u, expose + '}());'), context);
  return { get, nodes, calls, messages, timers, context, library: context.library, stored };
}

test('library entry has search, saved playlists, imports and Echo controls without account connection or tab-following UI', () => {
  for (const id of ['search-form', 'playlists-tab', 'import-playlist-button', 'playlist-import-url', 'queue-items', 'commands-toggle', 'custom-command-input', 'volume-slider', 'seek-slider', 'extension-pairing-code']) assert.match(html, new RegExp('id="' + id + '"'));
  for (const text of ['id="music-catalogue"', 'id="apple-connect-button"', 'id="spotify-connect-button"', 'id="youtube-connect-button"', 'Follow this tab']) assert.ok(!html.includes(text), text);
  assert.ok(!/MusicKit|connectOAuth|\/api\/(?:apple|spotify|youtube)\//u.test(script));
  assert.match(html, /src="extension-api\.js" defer><\/script>\s*<script src="app\.js" defer>/u);
});

test('the complete app boots with the real HTML elements and uses only the extension transport', async () => {
  const h = harness(); await flush();
  assert.equal(h.get('country-select').value, 'IN'); assert.equal(h.library.state.deviceId, 'echo');
  assert.equal(h.get('extension-version').textContent, 'Echo Companion 0.3.0'); assert.equal(h.get('extension-pairing-form').hidden, true);
  assert.equal(h.get('playlist-source').options.length, 1); assert.equal(h.get('playlist-source').options[0].value, 'local');
  assert.ok(h.calls.some(call => call.path === '/api/status')); assert.ok(h.calls.some(call => call.path === '/api/music-providers'));
  assert.ok(h.calls.every(call => call.path.startsWith('/api/') && !/\/api\/(apple|spotify|youtube)\//u.test(call.path)));
});

test('search and one-click playback use the chosen country and catalogue selection, without a music player tab', async () => {
  const h = harness(); await flush(); await h.library.search('Lover');
  assert.match(h.calls.find(call => call.path.startsWith('/api/search')).path, /country=IN/u); assert.equal(h.library.state.tracks[0].title, 'Lover');
  await h.library.sendTrack(h.library.state.tracks[0]);
  assert.deepEqual(h.calls.find(call => call.path === '/api/play').body, { trackId: 'song-1', deviceId: 'echo', country: 'IN', providerId: 'apple-music', requestMode: 'standard' });
  assert.equal(h.library.state.playback.state, 'checking'); assert.ok(!h.messages.some(message => /FOLLOW|TRACK_UPDATE|CONTROL_SOURCE/u.test(message.type)));
});

test('changing country discards a stale search response before it can replace current results', async () => {
  let release;
  const h = harness({ response: async (path, options, fallback) => path.startsWith('/api/search') ? new Promise(resolve => { release = resolve; }) : fallback(path, options) }); await flush();
  const pending = h.library.search('Lover'); h.get('country-select').value = 'US';
  release({ tracks: [TRACK], source: 'itunes', country: 'IN' }); await pending;
  assert.equal(h.library.state.tracks.length, 0); assert.equal(h.library.state.resultsCountry, null);
});

test('saved playlists load from the local library only and remain available without catalogue sign-in', async () => {
  const h = harness(); await flush(); await h.library.loadPlaylists();
  assert.equal(h.library.state.playlists[0].id, 'list-1'); assert.equal(h.library.state.playlists[0].source, 'local'); assert.equal(h.get('playlist-grid').children.length, 1);
  assert.ok(!h.calls.some(call => call.path.startsWith('/api/playlists')));
});

test('unknown public playlist totals are visibly partial rather than invented as complete', async () => {
  const h = harness({ response: async (path, options, fallback) => path === '/api/playlist-import/preview' ? { source: 'spotify', name: 'Visible playlist', tracks: [TRACK], total: null, truncated: true, fullCountUnverified: true, previewId: 'preview-1' } : fallback(path, options) }); await flush();
  h.library.openPlaylistImport(); h.get('playlist-import-url').value = 'https://open.spotify.com/playlist/1234567890123456789012';
  await h.library.loadPlaylistImport();
  assert.equal(h.library.state.playlistImport.preview.total, null); assert.equal(h.library.state.playlistImport.preview.truncated, true);
  assert.match(h.get('playlist-import-status').textContent, /1 visible entries.*count could not be verified.*partial/u); assert.doesNotMatch(h.get('playlist-import-status').textContent, /1 of 1/u);
  assert.match(h.get('playlist-import-text').value, /Lover — Taylor Swift/u); assert.ok(!h.calls.some(call => call.path === '/api/play' || call.path === '/api/queue'));
});

test('known truncated playlist totals keep the source total and an explicit partial warning', async () => {
  const h = harness({ response: async (path, options, fallback) => path === '/api/playlist-import/preview' ? { source: 'youtube-music', name: 'Public playlist', tracks: [TRACK], total: 100, truncated: true } : fallback(path, options) }); await flush();
  h.library.openPlaylistImport(); h.get('playlist-import-url').value = 'https://music.youtube.com/playlist?list=PLabc'; await h.library.loadPlaylistImport();
  assert.equal(h.library.state.playlistImport.preview.total, 100); assert.match(h.get('playlist-import-status').textContent, /Loaded 1 of 100 entries.*partial/u);
});

test('an import response cannot overwrite song edits made while the link is loading', async () => {
  let release;
  const h = harness({ response: async (path, options, fallback) => path === '/api/playlist-import/preview' ? new Promise(resolve => { release = resolve; }) : fallback(path, options) }); await flush();
  h.library.openPlaylistImport(); h.get('playlist-import-url').value = 'https://open.spotify.com/playlist/1234567890123456789012';
  const pending = h.library.loadPlaylistImport(); h.get('playlist-import-text').value = 'My edit — My artist'; ++h.library.state.playlistImport.revision;
  release({ source: 'spotify', name: 'Old response', tracks: [TRACK], total: 1 }); await pending;
  assert.equal(h.get('playlist-import-text').value, 'My edit — My artist'); assert.match(h.get('playlist-import-status').textContent, /Your edits were kept/u);
});

test('helper pairing remains separate from Amazon login and clears the submitted code after success', async () => {
  const h = harness({ paired: false }); await flush(); assert.equal(h.get('extension-pairing').open, true); assert.equal(h.get('extension-pairing-form').hidden, false);
  h.get('extension-pairing-code').value = 't'.repeat(43); await h.library.saveExtensionPairing({ preventDefault() {} });
  assert.equal(h.messages.find(message => message.type === 'SET_PAIR_TOKEN').token, 't'.repeat(43)); assert.equal(h.get('extension-pairing-code').value, ''); assert.equal(h.get('extension-pairing-form').hidden, true);
});


test('a previously paired but unavailable helper keeps pairing recovery and retry accessible', async () => {
  const h = harness({ paired: true, helperAvailable: false }); await flush();
  assert.equal(h.get('extension-pairing').open, true); assert.equal(h.get('extension-pairing-form').hidden, false);
  assert.ok(h.get('extension-helper-retry').listeners.click.length);
  await h.get('extension-open-helper').dispatch('click'); assert.ok(h.messages.some(message => message.type === 'OPEN_HELPER'));
});
