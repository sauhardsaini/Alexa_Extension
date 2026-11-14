import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../../library/public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../library/public/index.html', import.meta.url), 'utf8');
function frontendFunction(name) {
  const expression = new RegExp('^  (?:async )?function ' + name + '\\(', 'm');
  const match = expression.exec(script); assert.ok(match, 'frontend function exists: ' + name);
  const rest = script.slice(match.index); const next = /\n  (?:async )?function /g; next.lastIndex = 1;
  const end = next.exec(rest); return end ? rest.slice(0, end.index) : rest;
}
class Node {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this._value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.open = false; const classes = new Set(); this.classList = { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } }; }
  appendChild(node) { this.children.push(node); node.parentNode = this; if (this.tagName === 'SELECT' && this.children.length === 1) this._value = node.value; return node; }
  replaceChildren(...nodes) { this.children = []; if (this.tagName === 'SELECT') this._value = ''; nodes.forEach(node => this.appendChild(node)); }
  get options() { return this.children; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  async click() { if (this.listeners.click) await this.listeners.click({ preventDefault() {}, stopPropagation() {} }); }
  focus() {}
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function harness(response = async () => ({})) {
  const nodes = new Map(); const get = id => { if (!nodes.has(id)) nodes.set(id, new Node(['playlist-source', 'playlist-save-target', 'playlist-save-country', 'country-select'].includes(id) ? 'select' : 'div')); return nodes.get(id); };
  get('country-select').value = 'IN'; get('playlist-save-country').value = 'IN';
  const calls = [], toasts = [], stored = new Map(), observations = {}, elements = [];
  const state = { country: 'IN', view: 'search', playlists: [], playlistsSource: 'local', playlistSourceSaved: false, playlistAccountsFingerprint: null, playlistGeneration: 0, playlistPreviewGeneration: 0, localPlaylistGeneration: 0, localPlaylist: null, playlistSourceCache: new Map(), playlistSync: null, playlistSyncGeneration: 0, playlistsLoading: false, playlistBusy: false, localMutationBusy: false, playlistDialogBusy: false, queueBusy: false, queueModeBusy: false, queueModeWriteId: 0, shuffle: false, repeatAll: false, queueEpoch: 0, playbackEpoch: 0, pendingTrack: null, providersLoading: false, providerId: 'apple-music', deviceId: '', queue: null, playback: null, connection: { state: 'disconnected' }, devices: [], accounts: [], playlistDialog: null };
  const context = vm.createContext({ state, observations, countries: ['IN', 'US', 'GB'], $: get, document: { createElement: tag => new Node(tag), querySelectorAll: selector => selector === '[data-song-action]' ? elements.filter(node => node.dataset.songAction) : [] }, localStorage: { setItem: (key, value) => stored.set(key, value) }, console, JSON, Promise, encodeURIComponent, Set, Map, URL,
    element(tag, className, text) { const node = new Node(tag); elements.push(node); node.className = className || ''; if (text !== undefined) node.textContent = text; return node; },
    connectedAccounts: () => state.accounts, normalizeCountry: value => String(value || '').toUpperCase(), countryName: value => ({ IN: 'India', US: 'United States', GB: 'United Kingdom' })[value] || value,
    selectedProvider: () => ({ id: state.providerId, name: 'Apple Music', kind: state.providerId === 'tunein' ? 'radio' : 'music' }), selectedDevice: () => state.devices.find(device => device.id === state.deviceId), providerName: value => value,
    canPlay: () => state.connection.state === 'connected' && state.devices.some(device => device.id === state.deviceId && device.online !== false),
    activePlayback: () => !!state.playback?.active,
    api: async (path, options) => { const call = { path, body: options?.body ? JSON.parse(options.body) : null }; calls.push(call); return response(path, call.body); },
    playIcon: () => new Node('svg'), canRequestSong: () => state.connection.state === 'connected' && !!state.deviceId, setArtwork(node, url) { node.artwork = url; }, safeUrl: value => /^https:\/\//.test(value || '') ? value : '', renderPlaylistActions() {}, renderPlaylistPreview() {}, renderLocalPlaylist() {}, renderLocalReadiness() {}, renderPlaylistDialog() {}, renderSongActionReadiness() {}, renderPreviewReadiness() {}, updatePlayButtons() {}, renderPlayback() {}, renderQueue() {}, scheduleStatus() {}, refreshPlayer() {}, setTimeout() {},
    toggleQueue: open => { state.queueOpen = open === undefined ? !state.queueOpen : !!open; state.sidebarOpen = state.queueOpen; if (state.queueOpen) state.sidebarTab = 'queue'; },
    toast: (message, error) => toasts.push({ message, error }),
    applyQueue: queue => { state.queue = queue; }, applyPlayback: playback => { state.playback = playback; },
    previewPlaylist: playlist => { observations.preview = playlist; }, openLocalPlaylist: id => { observations.local = id; }, playSelection: selection => { observations.play = selection; }, openPlaylistDialog: value => { observations.dialog = value; }, refreshCreatedPlaylists: async () => { observations.refreshed = true; }, closePlaylistDialog: () => { state.playlistDialog = null; }
  });
  const names = ['playlistSourceName', 'renderPlaylistSources', 'loadPlaylists', 'playlistStillListed', 'playlistOriginInfo', 'playlistOriginalUrl', 'playlistSourceAuthor', 'renderPlaylistAttribution', 'playlistSourceLabel', 'playlistCover', 'playlistSourceMetadata', 'loadPlaylistSourceMetadata', 'renderLocalPlaylistIdentity', 'renderPlaylistCards', 'songHandoffBusy', 'canQueueSong', 'playNativePlaylist', 'selectionIsCurrent', 'validQueueText', 'playlistSongArtwork', 'artworkSlot', 'localArtwork', 'loadLocalArtwork', 'songMenu', 'selectionInCountry', 'renderSongActionReadiness', 'enqueueSelection', 'queuePlaybackModes', 'saveQueuePlaybackModes', 'renderQueueModes', 'toggleQueueMode', 'queueReady', 'activeQueue', 'queueControl', 'savePlaylistDialog', 'renderPlaylistSync', 'openPlaylistSync', 'closePlaylistSync', 'applyPlaylistSync'];
  vm.runInContext(names.map(frontendFunction).join('\n'), context);
  const listener = script.split('\n').find(line => line.includes("$('playlist-source').addEventListener('change'")); assert.ok(listener); vm.runInContext(listener, context);
  return { state, get, calls, toasts, observations, stored, run: code => vm.runInContext(code, context), context };
}
function service(source, name = source) { return { source, name }; }
function online(h) { h.state.connection.state = 'connected'; h.state.deviceId = 'echo'; h.state.devices = [{ id: 'echo', name: 'Living room', online: true }]; }

test('Created is available without an account; connected accounts default to All only before an explicit choice', () => {
  const h = harness(); h.run('renderPlaylistSources()'); assert.equal(h.state.playlistsSource, 'local'); assert.equal(h.get('playlist-source').disabled, false); assert.deepEqual(h.get('playlist-source').options.map(option => option.value), ['all', 'local']);
  h.state.accounts = [service('spotify', 'Spotify')]; h.run('renderPlaylistSources()'); assert.equal(h.state.playlistsSource, 'all');
  h.get('playlist-source').value = 'local'; h.get('playlist-source').listeners.change(); assert.equal(h.stored.get('echo-library-playlist-source'), 'local');
  h.state.accounts = [service('spotify'), service('apple-music')]; h.run('renderPlaylistSources()'); assert.equal(h.state.playlistsSource, 'local');
  h.state.accounts = []; h.run('renderPlaylistSources()'); assert.equal(h.state.playlistsSource, 'local');
  h.get('playlist-source').value = 'all'; h.get('playlist-source').listeners.change(); h.state.accounts = [service('youtube-music')]; h.run('renderPlaylistSources()'); h.state.accounts = []; h.run('renderPlaylistSources()'); assert.equal(h.state.playlistsSource, 'all');
});

test('All retains local and successful account playlists when another provider fails', async () => {
  const h = harness(async path => { if (path === '/api/local-playlists') return { playlists: [{ id: 'same', name: 'Made here', country: 'IN', itemCount: 1 }] }; if (path.includes('spotify')) throw new Error('Reconnect Spotify'); return { playlists: [{ id: 'same', title: 'Apple favourites', itemCount: 2 }] }; });
  h.state.accounts = [service('apple-music'), service('spotify')]; h.state.playlistsSource = 'all'; h.state.playlistSourceSaved = true; h.run('renderPlaylistSources()'); await h.run('loadPlaylists()');
  assert.deepEqual(Array.from(h.state.playlists, playlist => [playlist.id, playlist.source]), [['same', 'local'], ['same', 'apple-music']]); assert.match(h.get('playlist-status').textContent, /Spotify: Reconnect Spotify/);
  const cards = h.get('playlist-grid').children; assert.equal(cards.length, 2); assert.match(cards[0].children.find(node => node.className === 'playlist-source-badge').textContent, /Created.*India/); assert.equal(cards[1].children.find(node => node.className === 'playlist-source-badge').textContent, 'Apple Music · Apple favourites');
});

test('All cards dispatch by each card source, including duplicate IDs, rather than the dropdown', async () => {
  const h = harness(async () => ({ message: 'Accepted' })); online(h); h.state.playlistsSource = 'all'; h.state.playlists = [{ id: 'same', title: 'Local', source: 'local' }, { id: 'same', title: 'Apple', source: 'apple-music' }, { id: 'same', title: 'Spotify', source: 'spotify' }, { id: 'same', title: 'YouTube', source: 'youtube-music' }]; h.run('renderPlaylistCards()');
  const buttons = h.get('playlist-grid').children.map(card => card.children.find(node => node.tagName === 'BUTTON'));
  await buttons[0].click(); assert.equal(h.observations.local, 'same'); await buttons[3].click(); assert.equal(h.observations.preview.source, 'youtube-music');
  await buttons[1].click(); await new Promise(resolve => setImmediate(resolve)); await buttons[2].click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.filter(call => call.path === '/api/play-playlist').map(call => call.body.source), ['apple-music', 'spotify']);
});

test('an older All response cannot replace a later Created result', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; }); let localReads = 0;
  const h = harness(async path => path === '/api/local-playlists' ? ++localReads === 1 ? delayed : { playlists: [{ id: 'new', title: 'Current' }] } : { playlists: [{ id: 'remote' }] });
  h.state.accounts = [service('spotify')]; h.state.playlistsSource = 'all'; h.state.playlistSourceSaved = true; h.run('renderPlaylistSources()'); const old = h.run('loadPlaylists()'); h.state.playlistsSource = 'local'; await h.run('loadPlaylists()'); release({ playlists: [{ id: 'old' }] }); await old;
  assert.deepEqual(Array.from(h.state.playlists, playlist => playlist.id), ['new']); assert.equal(h.state.playlistsSource, 'local');
});

test('a search selection creates and saves a country-bound playlist while completely disconnected', async () => {
  const h = harness(async (path, body) => path === '/api/local-playlists' ? { playlist: { id: 'created', name: body.name, country: body.country } } : { playlist: { id: 'created', tracks: [{ id: 'entry' }] } });
  h.state.playlistDialog = { song: { title: '<img onerror=bad>', artist: 'Artist', selection: { source: 'catalogue', trackId: 'track', country: 'IN' } }, rename: null, created: null };
  h.get('playlist-save-name').value = 'My favourites'; await h.run('savePlaylistDialog({preventDefault(){}})');
  assert.deepEqual(h.calls.map(call => call.path), ['/api/local-playlists', '/api/local-playlists/created/tracks']); assert.deepEqual(h.calls[0].body, { name: 'My favourites', country: 'IN' }); assert.equal(h.calls[1].body.selection.source, 'catalogue'); assert.equal(h.state.playlistDialog, null); assert.equal(h.observations.refreshed, true);
});

test('failed song save reuses the already-created playlist on retry', async () => {
  let adds = 0; const h = harness(async path => { if (path === '/api/local-playlists') return { playlist: { id: 'one' } }; if (++adds === 1) throw new Error('Try again'); return { playlist: { id: 'one' } }; });
  h.state.playlistDialog = { song: { selection: { source: 'catalogue', trackId: 'track', country: 'IN' } }, rename: null, created: null }; h.get('playlist-save-name').value = 'One'; await h.run('savePlaylistDialog({preventDefault(){}})'); assert.match(h.get('playlist-dialog-status').textContent, /Try again/); await h.run('savePlaylistDialog({preventDefault(){}})'); assert.equal(h.calls.filter(call => call.path === '/api/local-playlists').length, 1);
});

test('Add to queue stages without an Echo and later mutations carry the captured queue ID', async () => {
  const h = harness(async (_path, body) => ({ queue: { id: 'staged', state: 'ready', active: true, country: body.country, providerId: body.providerId, items: [] } }));
  await h.run("enqueueSelection({source:'catalogue',trackId:'song',country:'IN'},'last',()=>true)"); assert.equal(h.calls[0].body.deviceId, null); assert.equal(h.calls[0].body.queueId, undefined); assert.equal(h.calls[0].body.placement, 'last'); assert.equal(h.state.queue.state, 'ready');
  await h.run("enqueueSelection({source:'catalogue',trackId:'next',country:'IN'},'next',()=>true)"); assert.equal(h.calls[1].body.queueId, 'staged'); assert.equal(h.calls[1].body.placement, 'next');
  assert.equal(h.calls.some(call => call.path.includes('/control') || call.path === '/api/play'), false);
});

test('queue changes are blocked during an unverified handoff or stale selection, while the save action remains available', async () => {
  const h = harness(); h.state.playback = { active: true }; await h.run("enqueueSelection({source:'catalogue',trackId:'song',country:'IN'},'last',()=>true)"); assert.equal(h.calls.length, 0);
  h.state.playback = null; await h.run("enqueueSelection({source:'catalogue',trackId:'song',country:'IN'},'last',()=>false)"); assert.equal(h.calls.length, 0);
  const menu = h.run("songMenu({title:'<script>bad</script>',artist:'Artist'},()=>({source:'catalogue',trackId:'song',country:'IN'}),()=>true)"); const summary = menu.children[0]; assert.match(summary.attributes['aria-label'], /<script>bad<\/script>/); await menu.children[1].children[3].click(); assert.equal(h.observations.dialog.selection.trackId, 'song');
});

test('ready Start requires an online Echo and the saved country/service; it always binds the captured queue ID', async () => {
  const h = harness(async () => ({ queue: { id: 'queue', active: true, state: 'playing' } })); h.state.queue = { id: 'queue', active: true, state: 'ready', country: 'IN', providerId: 'apple-music' };
  await h.run("queueControl('start')"); assert.equal(h.calls.length, 0); online(h); h.get('country-select').value = 'US'; await h.run("queueControl('start')"); assert.equal(h.calls.length, 0); h.get('country-select').value = 'IN'; h.state.providerId = 'spotify'; await h.run("queueControl('start')"); assert.equal(h.calls.length, 0); h.state.providerId = 'apple-music'; await h.run("queueControl('start')");
  assert.deepEqual(h.calls[0].body, { action: 'start', requestId: 'queue', deviceId: 'echo', providerId: 'apple-music', country: 'IN' });
});

test('playlist form and static IDs agree with the frontend, including the 100-character name bound', () => {
  assert.match(html, /id="playlist-save-name"[^>]*maxlength="100"/); const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]); assert.equal(new Set(ids).size, ids.length);
  for (const match of script.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), 'DOM ID exists: ' + match[1]);
});


test('playlist artwork is a named native play button with the same readiness and stale-selection guards', async () => {
  const h = harness();
  h.context.current = true;
  const button = h.run("playlistSongArtwork({title:'Alfaaz',artist:'Hamza Malik',artwork:'https://i.scdn.co/image/cover'},()=>({source:'local',playlistId:'saved',entryId:'one',country:'IN'}),()=>current)");
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.type, 'button');
  assert.match(button.attributes['aria-label'], /Play Alfaaz by Hamza Malik on your Echo/);
  assert.equal(button.artworkContainer.artwork, 'https://i.scdn.co/image/cover');
  assert.equal(button.children[1].className, 'playlist-song-play-overlay');
  h.run('renderSongActionReadiness()'); assert.equal(button.disabled, true);
  await button.click(); assert.equal(h.observations.play, undefined);
  online(h); h.run('renderSongActionReadiness()'); assert.equal(button.disabled, false);
  await button.click(); assert.equal(h.observations.play.entryId, 'one');
  h.observations.play = null; h.context.current = false; await button.click(); assert.equal(h.observations.play, null);
  h.context.current = true; h.get('country-select').value = 'US'; h.run('renderSongActionReadiness()'); assert.equal(button.disabled, true);
  h.get('country-select').value = 'IN'; h.state.playback = { active: true }; h.run('renderSongActionReadiness()'); assert.equal(button.disabled, true);
});


test('artwork redraws share requests, stay globally bounded, and never paint stale rows', async () => {
  const pending = [], h = harness(async path => new Promise(resolve => pending.push({ path, resolve })));
  Object.assign(h.state, { view: 'playlists', playlistArtworkCache: new Map(), playlistArtworkActive: 0, playlistArtworkWaiters: [], playlistArtworkRevision: 1, localPlaylistGeneration: 1 });
  const playlist = h.state.localPlaylist = { id: 'saved' };
  const entries = () => Array.from({ length: 8 }, (_, index) => ({ track: { id: 'entry' + index }, art: new Node() }));
  h.context.playlist = playlist; h.context.oldEntries = entries(); h.context.newEntries = entries();
  const old = h.run('loadLocalArtwork(playlist,1,1,oldEntries)'); await new Promise(resolve => setImmediate(resolve)); assert.equal(pending.length, 4);
  h.state.playlistArtworkRevision = 2; const latest = h.run('loadLocalArtwork(playlist,1,2,newEntries)'); await new Promise(resolve => setImmediate(resolve)); assert.equal(pending.length, 4, 'a redraw shares the four in-flight entry requests');
  pending.slice(0, 4).forEach(item => item.resolve({ entryId: item.path.split('/')[5], artwork: 'https://i.scdn.co/image/' + item.path.split('/')[5] })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 8); assert.equal(h.state.playlistArtworkActive, 4);
  pending.slice(4).forEach(item => item.resolve({ entryId: item.path.split('/')[5], artwork: 'https://i.scdn.co/image/' + item.path.split('/')[5] })); await Promise.all([old, latest]);
  assert.equal(h.state.playlistArtworkActive, 0);
  assert.ok(h.context.oldEntries.every(entry => entry.art.artwork === undefined));
  assert.ok(h.context.newEntries.every(entry => entry.art.artwork.startsWith('https://i.scdn.co/image/')));
  await h.run('loadLocalArtwork(playlist,1,2,newEntries)'); assert.equal(pending.length, 8, 'completed artwork is cached');
});

test('hiding a playlist stops further artwork rows from being scheduled', async () => {
  const pending = [], h = harness(async path => new Promise(resolve => pending.push({ path, resolve })));
  Object.assign(h.state, { view: 'playlists', playlistArtworkCache: new Map(), playlistArtworkActive: 0, playlistArtworkWaiters: [], playlistArtworkRevision: 1, localPlaylistGeneration: 1 });
  h.context.playlist = h.state.localPlaylist = { id: 'saved' }; h.context.entries = Array.from({ length: 8 }, (_, index) => ({ track: { id: 'entry' + index }, art: new Node() }));
  const work = h.run('loadLocalArtwork(playlist,1,1,entries)'); await new Promise(resolve => setImmediate(resolve)); h.state.view = 'search';
  pending.forEach(item => item.resolve({ entryId: item.path.split('/')[5], artwork: 'https://i.scdn.co/image/cover' })); await work;
  assert.equal(pending.length, 4); assert.ok(h.context.entries.every(entry => entry.art.artwork === undefined));
});


test('given playlist names remain primary while source names and original covers stay separate', async () => {
  const h = harness();
  h.state.playlists = [{ id: 'saved', name: 'My given name', title: 'My given name', source: 'local', country: 'IN', itemCount: 50, origin: { source: 'spotify', name: 'Top 50 - India', url: null, artwork: 'https://i.scdn.co/image/original' } }];
  h.run('renderPlaylistCards()');
  const card = h.get('playlist-grid').children[0];
  assert.equal(card.children.find(node => node.tagName === 'H2').textContent, 'My given name');
  assert.equal(card.children.find(node => node.className === 'playlist-source-badge').textContent, 'Spotify · Top 50 - India');
  assert.equal(card.children.find(node => node.className === 'playlist-art').artwork, 'https://i.scdn.co/image/original');
  h.context.playlist = h.state.playlists[0]; h.run('renderLocalPlaylistIdentity(playlist)');
  assert.equal(h.get('local-playlist-title').textContent, 'My given name');
  assert.equal(h.get('local-playlist-source').textContent, 'Spotify · Top 50 - India');
  assert.equal(h.get('local-playlist-art').artwork, 'https://i.scdn.co/image/original');
  assert.equal(h.get('local-playlist-meta').textContent, '0 songs · India');
});

test('source metadata fills existing playlist covers without renaming the given playlist or painting stale cards', async () => {
  let resolve; const h = harness(async () => new Promise(done => { resolve = done; }));
  const playlist = { id: 'saved', name: 'Test Spotify', source: 'local', updatedAt: 1, origin: { source: 'spotify', name: 'Top 50 - India', url: 'https://open.spotify.com/playlist/1234567890123456789012' } };
  h.context.playlist = playlist; h.context.current = true; h.context.rendered = 0;
  const one = h.run('loadPlaylistSourceMetadata(playlist,()=>current,()=>{rendered++})');
  const two = h.run('loadPlaylistSourceMetadata(playlist,()=>false,()=>{rendered++})');
  await new Promise(done => setImmediate(done)); assert.equal(h.calls.length, 1);
  resolve({ playlistId: 'saved', origin: { ...playlist.origin, artwork: 'https://i.scdn.co/image/cover' }, artwork: 'https://i.scdn.co/image/cover' });
  await Promise.all([one, two]); assert.equal(h.context.rendered, 1); assert.equal(playlist.name, 'Test Spotify'); assert.equal(playlist.origin.name, 'Top 50 - India'); assert.equal(playlist.artwork, 'https://i.scdn.co/image/cover');
  await h.run('loadPlaylistSourceMetadata(playlist,()=>true,()=>{rendered++})'); assert.equal(h.calls.length, 1, 'source covers are cached');
});

test('playing a playlist song publishes the returned tail queue and opens it', async () => {
  const h = harness(async () => ({ queue: { id: 'tail', active: true, state: 'preparing', total: 3 } })); online(h);
  vm.runInContext(frontendFunction('playSelection'), h.context);
  await h.run("playSelection({source:'local',playlistId:'saved',entryId:'middle',country:'IN'},{title:'Middle',artist:'Artist'},()=>true)");
  assert.deepEqual(h.calls[0].body.selection, { source: 'local', playlistId: 'saved', entryId: 'middle', country: 'IN' });
  assert.equal(h.state.queue.id, 'tail'); assert.equal(h.state.queueOpen, true); assert.equal(h.state.sidebarTab, 'queue');
});

test('sync previews source changes and requires explicit acceptance of an incomplete replacement', async () => {
  const preview = { previewId: 'opaque', playlistId: 'saved', source: 'spotify', sourceName: 'Top 50 - India', oldCount: 50, newCount: 48, added: 1, removed: 3, requiresPartialConfirmation: true, warnings: ['The full count is unverified.'] };
  const updated = { id: 'saved', name: 'Given name', country: 'IN', source: 'local', tracks: [], origin: { source: 'spotify', name: 'Top 50 - India', url: 'https://open.spotify.com/playlist/1234567890123456789012' } };
  const h = harness(async path => path.endsWith('/sync-preview') ? preview : { playlist: updated });
  h.state.localPlaylist = { ...updated, tracks: [{ id: 'old' }] };
  await h.run('openPlaylistSync()');
  assert.equal(h.get('playlist-sync-dialog').open, true); assert.match(h.get('playlist-sync-summary').textContent, /Spotify.*Top 50 - India.*50 songs → 48 songs.*1 added, 3 removed.*Given name/);
  assert.equal(h.get('playlist-sync-partial-group').hidden, false); assert.equal(h.get('playlist-sync-apply').disabled, true);
  await h.run('applyPlaylistSync({preventDefault(){}})'); assert.equal(h.calls.length, 1, 'unchecked partial preview cannot commit');
  h.get('playlist-sync-accept-partial').checked = true; h.run('renderPlaylistSync()'); assert.equal(h.get('playlist-sync-apply').disabled, false);
  await h.run('applyPlaylistSync({preventDefault(){}})');
  assert.deepEqual(h.calls[1].body, { previewId: 'opaque', acceptPartial: true });
  assert.equal(h.state.localPlaylist.name, 'Given name'); assert.equal(h.get('playlist-sync-dialog').open, false); assert.equal(h.observations.refreshed, true);
});

test('closing a source sync preview ignores its late result without changing the saved playlist', async () => {
  let resolve; const h = harness(async () => new Promise(done => { resolve = done; }));
  const playlist = h.state.localPlaylist = { id: 'saved', name: 'Given', origin: { source: 'spotify', name: 'Source name', url: 'https://open.spotify.com/playlist/1234567890123456789012' } };
  const pending = h.run('openPlaylistSync()'); h.run('closePlaylistSync()');
  resolve({ previewId: 'old', playlistId: 'saved', source: 'spotify', sourceName: 'Source' }); await pending;
  assert.equal(h.state.playlistSync, null); assert.equal(h.get('playlist-sync-dialog').open, false); assert.equal(h.state.localPlaylist, playlist); assert.equal(h.calls.length, 1);
});


test('YouTube full-playlist edits are attached once for Play now while Save and Add to queue stay lightweight', async () => {
  const h = harness(async () => ({ queue: { id: 'tail', active: true } })); online(h);
  h.state.playlistPreview = { id: 'yt', tracks: [{ id: 'previous', title: 'Previous', artist: 'Artist' }, { id: 'selected', title: 'Reviewed title', artist: 'Reviewed artist' }, { id: 'next', title: 'Next', artist: 'Next artist' }] };
  h.context.selection = { source: 'youtube-music', playlistId: 'yt', trackId: 'selected', title: 'Reviewed title', artist: 'Reviewed artist', country: 'IN' };
  vm.runInContext(frontendFunction('playSelection'), h.context);
  await h.run("enqueueSelection(selection,'last',()=>true)");
  assert.equal(h.calls[0].body.selection.edits, undefined);
  await h.run("playSelection(selection,{title:'Reviewed title',artist:'Reviewed artist'},()=>true)");
  assert.deepEqual(h.calls[1].body.selection.edits, [{ id: 'previous', title: 'Previous', artist: 'Artist' }, { id: 'selected', title: 'Reviewed title', artist: 'Reviewed artist' }, { id: 'next', title: 'Next', artist: 'Next artist' }]);
  assert.equal(h.context.selection.edits, undefined, 'the reusable Save/Add selection remains small');
});


test('playlist mode preferences toggle before playback without sending an Echo request', async () => {
  const h = harness();
  h.run('renderQueueModes()'); assert.equal(h.get('shuffle-button').attributes['aria-pressed'], 'false'); assert.equal(h.get('repeat-all-button').attributes['aria-pressed'], 'false');
  await h.run("toggleQueueMode('shuffle')"); await h.run("toggleQueueMode('repeatAll')");
  assert.equal(h.calls.length, 0); assert.equal(h.state.shuffle, true); assert.equal(h.state.repeatAll, true);
  assert.equal(h.stored.get('echo-library-shuffle'), 'true'); assert.equal(h.stored.get('echo-library-repeat-all'), 'true');
  assert.equal(h.get('shuffle-button').attributes['aria-pressed'], 'true'); assert.equal(h.get('repeat-all-button').classList.contains('is-active'), true);
  assert.match(h.get('shuffle-button').title, /next playlist/);
});

test('live playlist mode changes bind the queue ID, wait for confirmation, and never send song controls', async () => {
  let resolve; const h = harness(async () => new Promise(done => { resolve = done; }));
  h.state.queue = { id: 'queue', active: true, shuffle: false, repeatAll: false, state: 'playing' };
  const pending = h.run("toggleQueueMode('shuffle')");
  assert.deepEqual(h.calls[0], { path: '/api/queue/mode', body: { requestId: 'queue', shuffle: true } });
  assert.equal(h.get('shuffle-button').disabled, true); assert.equal(h.get('repeat-all-button').disabled, true);
  await h.run("toggleQueueMode('repeatAll')"); assert.equal(h.calls.length, 1, 'a second mutation cannot overlap');
  vm.runInContext(frontendFunction('playSelection'), h.context); online(h);
  await h.run("playSelection({source:'local',playlistId:'saved',entryId:'middle',country:'IN'},{title:'Middle',artist:'Artist'},()=>true)");
  await h.run("enqueueSelection({source:'local',playlistId:'saved',entryId:'middle',country:'IN'},'last',()=>true)");
  assert.equal(h.calls.length, 1, 'playlist playback and queue mutations wait for the mode acknowledgement');
  resolve({ queue: { id: 'queue', active: true, state: 'playing', shuffle: true, repeatAll: false } }); await pending;
  assert.equal(h.state.queue.shuffle, true); assert.equal(h.get('shuffle-button').attributes['aria-pressed'], 'true');
  assert.equal(h.get('shuffle-button').disabled, false); assert.equal(h.calls.some(call => /control|command|play-selection/.test(call.path)), false);
});

test('a stale mode response cannot replace a newer playlist queue', async () => {
  let resolve; const h = harness(async () => new Promise(done => { resolve = done; }));
  h.state.queue = { id: 'old', active: true, shuffle: false, repeatAll: false };
  const pending = h.run("toggleQueueMode('repeatAll')");
  h.state.queue = { id: 'new', active: true, shuffle: true, repeatAll: false };
  resolve({ queue: { id: 'old', active: true, shuffle: false, repeatAll: true } }); await pending;
  assert.equal(h.state.queue.id, 'new'); assert.equal(h.get('repeat-all-button').attributes['aria-pressed'], 'false'); assert.equal(h.get('shuffle-button').attributes['aria-pressed'], 'true');
});

test('playlist playback carries configured modes while catalogue selections stay independent', async () => {
  const h = harness(async () => ({ queue: { id: 'new', active: true, shuffle: true, repeatAll: true } })); online(h); h.state.shuffle = true; h.state.repeatAll = true;
  vm.runInContext(frontendFunction('playSelection'), h.context);
  await h.run("playSelection({source:'local',playlistId:'saved',entryId:'middle',country:'IN'},{title:'Song',artist:'Artist'},()=>true)");
  assert.equal(h.calls[0].body.shuffle, true); assert.equal(h.calls[0].body.repeatAll, true);
  await h.run("playSelection({source:'catalogue',trackId:'song',country:'IN'},{title:'Song',artist:'Artist'},()=>true)");
  assert.equal(h.calls[1].body.shuffle, undefined); assert.equal(h.calls[1].body.repeatAll, undefined);
});


test('playlist source attribution shows the original author and safe original link separately from the chosen name', () => {
  const h = harness();
  h.context.playlist = { id: 'saved', name: 'My chosen title', country: 'IN', source: 'local', origin: { source: 'spotify', name: 'Top 50 - India', author: 'Spotify', url: 'https://open.spotify.com/playlist/1234567890123456789012', artwork: 'https://i.scdn.co/image/original' } };
  h.run('renderLocalPlaylistIdentity(playlist)');
  assert.equal(h.get('local-playlist-title').textContent, 'My chosen title');
  assert.equal(h.get('local-playlist-source').textContent, 'Spotify · Top 50 - India');
  const attribution = h.get('local-playlist-attribution');
  assert.equal(attribution.hidden, false);
  assert.equal(attribution.children[0].textContent, 'By Spotify');
  const link = attribution.children[1];
  assert.equal(link.tagName, 'A'); assert.equal(link.textContent, 'Open original playlist ↗');
  assert.equal(link.href, 'https://open.spotify.com/playlist/1234567890123456789012');
  assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(h.get('local-playlist-art').artwork, 'https://i.scdn.co/image/original');
  assert.equal(h.calls.length, 0, 'viewing attribution does not send playback commands or require an account');
});

test('unknown authors stay hidden while available original links remain visible; locally created playlists have neither', () => {
  const h = harness();
  h.context.playlist = { name: 'Unknown author', country: 'IN', origin: { source: 'youtube-music', name: 'Original name', url: 'https://music.youtube.com/playlist?list=PLtest' } };
  h.run('renderLocalPlaylistIdentity(playlist)');
  const attribution = h.get('local-playlist-attribution');
  assert.equal(attribution.children.length, 1); assert.equal(attribution.children[0].tagName, 'A');
  h.run("renderLocalPlaylistIdentity({name:'Created here',country:'IN'})");
  assert.equal(attribution.hidden, true); assert.equal(attribution.children.length, 0);
});

test('author text stays plain text and original playlist links reject unsafe schemes, credentials, and control characters', () => {
  const h = harness();
  h.context.playlist = { name: 'Given', country: 'IN', origin: { source: 'apple-music', name: 'Original', author: '<img src=x onerror=bad>', url: 'javascript:alert(1)' } };
  h.run('renderLocalPlaylistIdentity(playlist)');
  const attribution = h.get('local-playlist-attribution');
  assert.equal(attribution.children.length, 1); assert.equal(attribution.children[0].tagName, 'SPAN');
  assert.equal(attribution.children[0].textContent, 'By <img src=x onerror=bad>'); assert.equal(attribution.children[0].children.length, 0);
  for (const url of ['http://music.apple.com/in/playlist/test/pl.test', 'data:text/html,hello', 'https://user:password@music.apple.com/in/playlist/test/pl.test', 'https://music.apple.com/\nplaylist/test', '', null]) {
    h.context.url = url; assert.equal(h.run('playlistOriginalUrl(url)'), '');
  }
  for (const source of ['apple-music', 'spotify', 'youtube-music', 'amazon-music', 'jiosaavn']) {
    h.context.playlist = { country: 'IN', origin: { source, name: 'Original', author: '   ', url: 'https://music.example/playlist/test' } };
    h.run('renderLocalPlaylistIdentity(playlist)');
    assert.equal(attribution.children.length, 1); assert.equal(attribution.children[0].href, 'https://music.example/playlist/test');
  }
});

test('connected playlist cards show known authors and original links without relying on a saved-copy origin', () => {
  const h = harness();
  h.state.playlists = [{ id: 'yt', title: 'My mix', source: 'youtube-music', author: 'Original curator', url: 'https://music.youtube.com/playlist?list=PLmix' }];
  h.run('renderPlaylistCards()');
  const row = h.get('playlist-grid').children[0].children.find(node => node.className === 'playlist-source-attribution');
  assert.equal(row.children[0].textContent, 'By Original curator'); assert.equal(row.children[1].href, 'https://music.youtube.com/playlist?list=PLmix');
  assert.equal(h.calls.length, 0);
});

test('existing source artwork does not prevent author hydration, and shared metadata updates the existing card', async () => {
  let resolve; const h = harness(async () => new Promise(done => { resolve = done; }));
  const playlist = { id: 'saved', name: 'My name', source: 'local', updatedAt: 1, origin: { source: 'spotify', name: 'Source name', url: 'https://open.spotify.com/playlist/1234567890123456789012', artwork: 'https://i.scdn.co/image/already-known' } };
  h.state.playlists = [playlist]; h.run('renderPlaylistCards()');
  await new Promise(done => setImmediate(done)); assert.equal(h.calls.length, 1);
  const row = h.get('playlist-grid').children[0].children.find(node => node.className === 'playlist-source-attribution');
  assert.equal(row.children.length, 1);
  resolve({ playlistId: playlist.id, origin: { ...playlist.origin, author: 'Source curator' }, artwork: playlist.origin.artwork });
  await new Promise(done => setImmediate(done));
  assert.equal(row.children[0].textContent, 'By Source curator'); assert.equal(playlist.name, 'My name');
  h.context.playlist = playlist; await h.run('loadPlaylistSourceMetadata(playlist,()=>true,()=>{})'); assert.equal(h.calls.length, 1, 'author and cover requests share the source cache');
  assert.equal(h.calls.some(call => call.path.includes('/control') || call.path === '/api/play' || call.path === '/api/queue'), false);
});

test('late author metadata cannot update a newer version or source of the same playlist object', async () => {
  for (const change of ['url', 'updatedAt']) {
    let resolve; const h = harness(async () => new Promise(done => { resolve = done; }));
    const original = { source: 'spotify', name: 'Old source', url: 'https://open.spotify.com/playlist/1234567890123456789012' };
    h.context.playlist = { id: 'same', name: 'Given', updatedAt: 1, origin: { ...original } }; h.context.painted = 0;
    const pending = h.run('loadPlaylistSourceMetadata(playlist,()=>true,()=>{painted++})'); await new Promise(done => setImmediate(done));
    if (change === 'url') h.context.playlist.origin.url = 'https://open.spotify.com/playlist/abcdefghijklmnopqrstuv';
    else h.context.playlist.updatedAt = 2;
    resolve({ playlistId: 'same', origin: { ...original, author: 'Old author' } }); await pending;
    assert.equal(h.context.painted, 0); assert.equal(h.context.playlist.origin.author, undefined);
  }
});
