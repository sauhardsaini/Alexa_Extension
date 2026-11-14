import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const script = await readFile(new URL('../../library/public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../library/public/index.html', import.meta.url), 'utf8');
function frontendFunction(name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(script); assert.ok(match, name); const rest = script.slice(match.index), next = /\n  (?:async )?function /g; next.lastIndex = 1; const end = next.exec(rest); return end ? rest.slice(0, end.index) : rest;
}
class Node {
  constructor() { this.value = ''; this.textContent = ''; this.disabled = false; this.open = false; this.children = []; this.dataset = {}; this.listeners = {}; }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function harness(response = async () => ({})) {
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const calls = [], observations = [], stored = new Map(), timers = new Map(); let timerSerial = 0; get('country-select').value = 'IN';
  const context = vm.createContext({ $: get, fallbackProviders: [], URL, document: { querySelectorAll: () => [] }, element: (tag, className, text) => { const node = new Node(); node.tagName = tag.toUpperCase(); node.className = className || ''; if (text !== undefined) node.textContent = text; return node; }, countries: ['IN', 'US', 'GB', 'DE', 'CA', 'AU', 'JP'], countryName: value => value === 'IN' ? 'India' : value === 'US' ? 'United States' : value, Promise, JSON, Set, Map, console,
    localStorage: { setItem: (key, value) => stored.set(key, value) },
    setTimeout(callback, ms) { const id = ++timerSerial; timers.set(id, { callback, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    api: async (path, options) => { const body = options?.body ? JSON.parse(options.body) : null; calls.push({ path, body }); return response(path, body); },
    setBrowseView: view => observations.push(['view', view]), loadPlaylists: async () => observations.push(['refresh']), openLocalPlaylist: async id => observations.push(['open', id]), toast: message => observations.push(['toast', message]),
    closeSidebar: () => observations.push(['close-sidebar']),
    providerName: source => ({ 'amazon-music': 'Amazon Music', jiosaavn: 'JioSaavn', deezer: 'Deezer' })[source] || source, normalizeCountry: value => String(value || '').toUpperCase(), canPlay: () => true, songHandoffBusy: () => false, selectedProvider: () => context.state.providers.find(provider => provider.id === context.state.providerId) || { id: context.state.providerId, kind: 'music' }, updatePlayButtons() {}, renderPlaylistActions() {}, renderSongActionReadiness() {}, setArtwork() {}, safeUrl: () => '', songMenu: () => new Node(), scheduleStatus() {}, applyQueue: queue => observations.push(['queue', queue]), toggleQueue: open => observations.push(['queue-view', open])
  });
  const declaration = script.split('\n').find(line => line.startsWith('  const state = ')); vm.runInContext(declaration.replace('const state = ', 'globalThis.state = '), context);
  vm.runInContext(['queuePlaybackModes', 'nativeLocalPlaylist', 'renderLocalReadiness', 'playLocalPlaylist', 'playLocalPlaylistNative', 'renderLocalPlaylist', 'renderPlaylistCards', 'playlistOriginInfo', 'playlistOriginalUrl', 'playlistSourceAuthor', 'renderPlaylistAttribution', 'playlistSourceLabel', 'playlistCover', 'renderLocalPlaylistIdentity', 'playlistStillListed', 'renderLocalImportNotice', 'playlistSourceName', 'playlistImportSource', 'playlistImportLinkSupported', 'renderPlaylistImportPlatforms', 'playlistImportPlatformFromUrl', 'playlistImportCountryFromUrl', 'clearPlaylistImportAutoload', 'playlistImportLoadKey', 'playlistImportHasSongEdits', 'playlistImportHasCurrentPreview', 'playlistImportNeedsLinkReview', 'detectPlaylistImportLink', 'schedulePlaylistImportLoad', 'setPlaylistImportPlatform', 'playlistImportPreviewId', 'validQueueText', 'importLineText', 'parsePlaylistImport', 'openPlaylistImport', 'closePlaylistImport', 'renderPlaylistImport', 'editPlaylistImport', 'loadPlaylistImport', 'savePlaylistImport', 'commandsKeydown'].map(frontendFunction).join('\n'), context);
  const nativeBinding = script.split('\n').find(line => line.includes("$('playlist-import-native-name').addEventListener")); vm.runInContext(nativeBinding, context);
  const nameBinding = script.split('\n').find(line => line.includes("$('playlist-import-name').addEventListener")); vm.runInContext(nameBinding, context);
  const editBinding = script.split('\n').find(line => line.includes("['playlist-import-text', 'playlist-import-country', 'playlist-import-url'].forEach")); vm.runInContext(editBinding, context);
  return { get, state: context.state, calls, observations, stored, timers, fireAuto() { return Promise.all([...timers].filter(([, timer]) => timer.ms === 400).map(([id, timer]) => { timers.delete(id); return timer.callback(); })); }, run: code => vm.runInContext(code, context), context };
}
const plain = value => JSON.parse(JSON.stringify(value));
const submit = h => h.run('savePlaylistImport({preventDefault(){}})');
function fill(h, name = 'My songs', text = 'Lover — Taylor Swift') { h.get('playlist-import-name').value = name; h.get('playlist-import-text').value = text; }

test('parser uses the final spaced em dash and preserves same-index unchanged preview metadata', () => {
  const h = harness(); h.context.preview = [{ title: 'Title — Live', artist: 'Artist', album: 'Album', durationMs: 123000, artwork: 'https://example.com/art', url: 'https://example.com/song', requestArtist: 'Artist', requestArtists: ['Artist', 'Guest'], needsReview: true }];
  const tracks = h.run("parsePlaylistImport('Title — Live — Artist',preview,'IN')");
  assert.deepEqual(plain(tracks[0]), { title: 'Title — Live', artist: 'Artist', album: 'Album', durationMs: 123000, artwork: 'https://example.com/art', url: 'https://example.com/song', requestArtist: 'Artist', requestArtists: ['Artist', 'Guest'], source: 'youtube-music', country: 'IN' }); assert.equal(h.context.preview[0].needsReview, true);
});

test('edited or reordered rows lose old metadata and retain the selected import country', () => {
  const h = harness(); h.context.preview = [{ title: 'First', artist: 'Artist', durationMs: 120000, album: 'Old', artwork: 'https://example.com/old' }];
  assert.deepEqual(plain(h.run("parsePlaylistImport('Edited — Artist',preview,'US')")), [{ title: 'Edited', artist: 'Artist', durationMs: 0, source: 'youtube-music', country: 'US' }]);
  assert.deepEqual(plain(h.run("parsePlaylistImport('First — Artist',preview,'US')"))[0].country, 'US');
});

test('one malformed or missing-artist row rejects the whole import; 500 is the exact limit', () => {
  const h = harness(); assert.throws(() => h.run("parsePlaylistImport('Valid — Artist\\nMissing artist — ',[],'IN')"), /Line 2/); assert.throws(() => h.run("parsePlaylistImport('No separator',[],'IN')"), /spaced em dash/);
  h.context.text = Array.from({ length: 500 }, (_, i) => `Song ${i} — Artist`).join('\n'); assert.equal(h.run("parsePlaylistImport(text,[],'IN').length"), 500); h.context.text += '\nOne too many — Artist'; assert.throws(() => h.run("parsePlaylistImport(text,[],'IN')"), /up to 500/);
});

test('73 pasted songs save atomically without any account, Echo or playback request', async () => {
  const h = harness(async () => ({ playlist: { id: 'imported', name: 'My 73 songs' } })); h.run('openPlaylistImport()'); assert.equal(h.get('playlist-import-country').value, 'IN'); fill(h, 'My 73 songs', Array.from({ length: 73 }, (_, index) => `Song ${index + 1} — Artist ${index + 1}`).join('\n'));
  await submit(h); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, '/api/local-playlists/import'); assert.equal(h.calls[0].body.tracks.length, 73); assert.equal(h.calls[0].body.country, 'IN'); assert.equal(h.calls[0].body.tracks[72].durationMs, 0); assert.equal(h.state.playlistsSource, 'local'); assert.equal(h.stored.get('echo-library-playlist-source'), 'local'); assert.ok(h.observations.some(item => item[0] === 'open' && item[1] === 'imported')); assert.equal(h.get('playlist-import-dialog').open, false);
});

test('link preview displays skipped/review/missing counts and keeps edited playlist names', async () => {
  const h = harness(async () => ({ name: 'Original name', total: 4, skipped: 2, notes: ['Some entries were private.'], tracks: [{ title: 'One', artist: 'Artist', durationMs: 120000 }, { title: 'Two', artist: '', needsReview: true }] })); h.run('openPlaylistImport()'); h.get('playlist-import-url').value = 'https://music.youtube.com/playlist?list=PLtest'; h.get('playlist-import-name').value = 'My edited name'; await h.run('loadPlaylistImport()');
  assert.deepEqual(h.calls[0].body, { url: 'https://music.youtube.com/playlist?list=PLtest', country: 'IN' }); assert.equal(h.get('playlist-import-name').value, 'My edited name'); assert.equal(h.get('playlist-import-text').value, 'One — Artist\nTwo — '); assert.match(h.get('playlist-import-status').textContent, /Loaded 2 of 4 entries\. 2 skipped/); assert.match(h.get('playlist-import-status').textContent, /1 need a title or artist/); assert.match(h.get('playlist-import-status').textContent, /1 marked for review/); assert.match(h.get('playlist-import-status').textContent, /private/); await submit(h); assert.equal(h.calls.length, 1);
});

test('preview failure keeps the account-free paste fallback and never clears existing edits', async () => {
  const h = harness(async () => { throw new Error('Connect Google to load this link.'); }); h.run('openPlaylistImport()'); fill(h); h.get('playlist-import-url').value = 'https://youtube.com/playlist?list=PLtest'; await h.run('loadPlaylistImport()'); assert.equal(h.get('playlist-import-text').value, 'Lover — Taylor Swift'); assert.match(h.get('playlist-import-status').textContent, /still paste/); assert.equal(h.get('playlist-import-save').disabled, false); h.run('editPlaylistImport()'); assert.equal(h.get('playlist-import-status').textContent, ''); assert.match(h.get('playlist-import-review').textContent, /1 song ready/);
});

test('a closed/reopened dialog ignores a late preview and retains its new country/name/text', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; }); const h = harness(() => delayed); h.run('openPlaylistImport()'); h.get('playlist-import-url').value = 'https://youtube.com/playlist?list=old'; const pending = h.run('loadPlaylistImport()'); h.run('closePlaylistImport();openPlaylistImport()'); fill(h, 'New draft', 'New song — New artist'); h.get('playlist-import-country').value = 'US'; release({ name: 'Old name', tracks: [{ title: 'Old song', artist: 'Old artist' }] }); await pending;
  assert.equal(h.get('playlist-import-dialog').open, true); assert.equal(h.get('playlist-import-name').value, 'New draft'); assert.equal(h.get('playlist-import-text').value, 'New song — New artist'); assert.equal(h.get('playlist-import-country').value, 'US');
});

test('edits made during link loading win over its later response', async () => {
  let release; const h = harness(() => new Promise(resolve => { release = resolve; })); h.run('openPlaylistImport()'); h.get('playlist-import-url').value = 'https://youtube.com/playlist?list=test'; const pending = h.run('loadPlaylistImport()'); h.get('playlist-import-text').value = 'User song — User artist'; h.run('editPlaylistImport()'); release({ tracks: [{ title: 'Remote', artist: 'Artist' }] }); await pending; assert.equal(h.get('playlist-import-text').value, 'User song — User artist'); assert.match(h.get('playlist-import-status').textContent, /edits were kept/);
});

test('duplicate saves are blocked across close/reopen and the old result cannot close or mutate a new draft', async () => {
  let release; const h = harness(() => new Promise(resolve => { release = resolve; })); h.run('openPlaylistImport()'); fill(h); const first = submit(h); await submit(h); assert.equal(h.calls.length, 1); h.run('closePlaylistImport();openPlaylistImport()'); fill(h, 'New draft', 'New — Artist'); await submit(h); assert.equal(h.calls.length, 1); assert.equal(h.get('playlist-import-save').disabled, true); release({ playlist: { id: 'old-import', name: 'Old' } }); await first;
  assert.equal(h.get('playlist-import-dialog').open, true); assert.equal(h.get('playlist-import-name').value, 'New draft'); assert.equal(h.get('playlist-import-text').value, 'New — Artist'); assert.equal(h.get('playlist-import-save').disabled, false); assert.equal(h.observations.length, 0);
});

test('a failed atomic save leaves all draft details available for correction', async () => {
  const h = harness(async () => { throw new Error('Storage is unavailable.'); }); h.run('openPlaylistImport()'); fill(h); await submit(h); assert.equal(h.get('playlist-import-dialog').open, true); assert.equal(h.get('playlist-import-text').value, 'Lover — Taylor Swift'); assert.equal(h.get('playlist-import-save').disabled, false); assert.match(h.get('playlist-import-status').textContent, /Storage is unavailable/);
});

test('import dialog owns Escape and its markup exposes labels, status and a plain close icon', () => {
  const h = harness(); h.run('openPlaylistImport()'); h.state.sidebarOpen = true; h.run("commandsKeydown({key:'Escape',defaultPrevented:false})"); assert.equal(h.observations.length, 0); assert.match(html, /id="playlist-import-form" novalidate/); assert.match(html, /id="playlist-import-close"[^>]*aria-label="Close playlist import"/); assert.match(html, /<label for="playlist-import-text">/); assert.match(html, /id="playlist-import-status" role="status"/); assert.match(html, /Playback availability[^<]*unverified/);
});


test('late post-save refresh cannot reopen a saved detail over a new import draft', async () => {
  let releaseRefresh; const h = harness(async () => ({ playlist: { id: 'saved', name: 'Saved' } })); h.context.loadPlaylists = () => new Promise(resolve => { releaseRefresh = resolve; });
  h.run('openPlaylistImport()'); fill(h); const pending = submit(h); await new Promise(resolve => setImmediate(resolve)); h.run('openPlaylistImport()'); fill(h, 'New draft', 'New — Artist'); releaseRefresh(); await pending;
  assert.equal(h.get('playlist-import-dialog').open, true); assert.equal(h.get('playlist-import-name').value, 'New draft'); assert.equal(h.observations.some(item => item[0] === 'open'), false);
});

test('Created detail persistently labels imported metadata as unverified and hides it for other playlists', () => {
  const h = harness(); h.run("renderLocalImportNotice({country:'IN',tracks:[{source:'youtube-music'}]})"); assert.equal(h.get('local-playlist-import-note').hidden, false); assert.match(h.get('local-playlist-import-note').textContent, /service in India is unverified/);
  h.run("renderLocalImportNotice({country:'US',tracks:[{source:'itunes'}]})"); assert.equal(h.get('local-playlist-import-note').hidden, true); assert.equal(h.get('local-playlist-import-note').textContent, ''); h.run('renderLocalImportNotice(null)'); assert.equal(h.get('local-playlist-import-note').hidden, true);
});


test('an untouched preview artist containing the delimiter keeps its complete artist and metadata', () => {
  const h = harness(); h.context.preview = [{ title: 'Song', artist: 'Primary artist — Guest artist', album: 'Album', durationMs: 183000, requestArtist: 'Primary artist', requestArtists: ['Primary artist', 'Guest artist'] }];
  const tracks = plain(h.run("parsePlaylistImport('Song — Primary artist — Guest artist',preview,'IN')"));
  assert.deepEqual(tracks[0], { ...h.context.preview[0], source: 'youtube-music', country: 'IN' }); assert.equal(tracks[0].artist, 'Primary artist — Guest artist');
  const pasted = plain(h.run("parsePlaylistImport('Song — Primary artist — Guest artist',[],'IN')")); assert.equal(pasted[0].title, 'Song — Primary artist'); assert.equal(pasted[0].artist, 'Guest artist');
});


test('editing a successfully loaded list retains its source omission report', async () => {
  const h = harness(async () => ({ name: 'Loaded', total: 2, skipped: 1, tracks: [{ title: 'Song', artist: 'Artist' }] })); h.run('openPlaylistImport()'); h.get('playlist-import-url').value = 'https://youtube.com/playlist?list=test'; await h.run('loadPlaylistImport()'); const report = h.get('playlist-import-status').textContent; h.get('playlist-import-text').value = 'Edited song — Artist'; h.run('editPlaylistImport()'); assert.equal(h.get('playlist-import-status').textContent, report); assert.match(report, /1 skipped/);
});


const importLinks = {
  'youtube-music': 'https://music.youtube.com/playlist?list=PLexample',
  spotify: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
  'apple-music': 'https://music.apple.com/in/playlist/deep-house-2026/pl.28397407efb24386ad02df00ddc70700',
  'amazon-music': 'https://music.amazon.in/playlists/B0EXAMPLE',
  jiosaavn: 'https://www.jiosaavn.com/featured/example-playlist/AbCdEf123'
};

test('five canonical playlist link types are detected without accepting lookalike hosts or arbitrary URLs', () => {
  const h = harness(); for (const [source, link] of Object.entries(importLinks)) { h.context.link = link; assert.equal(h.run('playlistImportPlatformFromUrl(link)'), source); }
  for (const link of ['https://music.apple.com.evil.test/in/playlist/test/pl.123', 'https://open.spotify.com.evil.test/playlist/123', 'https://youtube.com@evil.test/playlist?list=PLx', 'http://music.amazon.in/playlists/B0X', 'https://www.jiosaavn.com/song/example/id', 'https://music.apple.com:8443/in/playlist/test/pl.123']) { h.context.link = link; assert.equal(h.run('playlistImportPlatformFromUrl(link)'), ''); }
});

test('pasted rows use each chosen platform without account access and reject unrecognized or radio sources', async () => {
  for (const source of Object.keys(importLinks)) { const h = harness(async () => ({ playlist: { id: 'saved' } })); h.run('openPlaylistImport()'); h.context.source = source; h.run('setPlaylistImportPlatform(source)'); fill(h); await submit(h); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].body.tracks[0].source, source); assert.equal(h.calls[0].body.previewId, undefined); assert.equal(h.calls[0].body.nativeName, undefined); }
  const h = harness(); assert.throws(() => h.run("parsePlaylistImport('Song — Artist',[],'IN','evil')"), /supported playlist platform/); h.state.providers = [{ id: 'tunein', kind: 'radio', name: 'TuneIn' }]; assert.throws(() => h.run("parsePlaylistImport('Song — Artist',[],'IN','tunein')"), /supported playlist platform/);
});

test('link paste switches only the import platform and does not make a network request or change Echo service', () => {
  const h = harness(); h.run('openPlaylistImport()'); h.state.providerId = 'apple-music'; h.get('playlist-import-url').value = importLinks.spotify; h.run("editPlaylistImport({target:{id:'playlist-import-url'}})"); assert.equal(h.state.playlistImport.platform, 'spotify'); assert.equal(h.state.providerId, 'apple-music'); assert.equal(h.calls.length, 0); assert.match(h.get('playlist-import-status').textContent, /Link detected: Spotify/);
});

test('platform changes keep editable text, clear old row metadata and provenance, and report the new source', () => {
  const h = harness(); h.run('openPlaylistImport()'); fill(h); h.state.playlistImport.previewTracks = [{ title: 'Lover', artist: 'Taylor Swift', source: 'youtube-music', album: 'Old album', durationMs: 200000 }]; h.state.playlistImport.preview = { previewId: 'old' }; h.get('playlist-import-native-name').value = 'Old remote name'; h.run("setPlaylistImportPlatform('spotify')");
  assert.equal(h.get('playlist-import-text').value, 'Lover — Taylor Swift'); assert.equal(h.state.playlistImport.previewTracks.length, 0); assert.equal(h.state.playlistImport.preview, null); assert.equal(h.get('playlist-import-native-name').value, ''); assert.match(h.get('playlist-import-status').textContent, /metadata was cleared/); assert.equal(h.get('playlist-import-platform').value, 'spotify');
});

test('a platform change rejects a late preview without restoring its old source or metadata', async () => {
  let release; const h = harness(() => new Promise(resolve => { release = resolve; })); h.run('openPlaylistImport()'); fill(h); h.get('playlist-import-url').value = importLinks['youtube-music']; const pending = h.run('loadPlaylistImport()'); h.run("setPlaylistImportPlatform('apple-music')"); release({ source: 'youtube-music', tracks: [{ title: 'Remote', artist: 'Artist' }] }); await pending; assert.equal(h.state.playlistImport.platform, 'apple-music'); assert.equal(h.get('playlist-import-text').value, 'Lover — Taylor Swift'); assert.equal(h.state.playlistImport.previewTracks.length, 0);
});

test('a genuine preview keeps source and metadata, and trusted previewId survives song edits but not source context edits', async () => {
  const h = harness(async path => path.includes('/preview') ? { previewId: 'trusted-preview', source: 'apple-music', name: 'Remote original', url: importLinks['apple-music'], total: 1, skipped: 0, tracks: [{ title: 'Original', artist: 'Artist', album: 'Album', durationMs: 183000 }] } : { playlist: { id: 'saved' } });
  h.run('openPlaylistImport()'); h.get('playlist-import-url').value = importLinks['apple-music']; await h.run('loadPlaylistImport()'); assert.equal(h.state.playlistImport.platform, 'apple-music'); assert.equal(h.get('playlist-import-native-name').value, 'Remote original'); assert.equal(h.state.playlistImport.nativeNameEdited, false); h.get('playlist-import-name').value = 'Local copy'; h.get('playlist-import-text').value = 'Edited — Artist'; h.run("editPlaylistImport({target:{id:'playlist-import-text'}})"); await submit(h);
  const saved = h.calls[1].body; assert.equal(saved.previewId, 'trusted-preview'); assert.equal(saved.nativeName, undefined); assert.equal(saved.origin, undefined); assert.equal(saved.tracks[0].source, 'apple-music'); assert.equal(saved.tracks[0].durationMs, 0);
  const second = harness(); second.run('openPlaylistImport()'); second.state.playlistImport.preview = { previewId: 'id', source: 'youtube-music', country: 'IN', inputUrl: importLinks['youtube-music'] }; second.get('playlist-import-url').value = importLinks['youtube-music']; assert.equal(second.run("playlistImportPreviewId(state.playlistImport,'IN')"), 'id'); second.run("editPlaylistImport({target:{id:'playlist-import-country'}})"); assert.equal(second.run("playlistImportPreviewId(state.playlistImport,'IN')"), null);
});

test('manual remote playlist name is forwarded only after explicit user editing, never inferred from the Created name', async () => {
  const h = harness(async () => ({ playlist: { id: 'saved' } })); h.run('openPlaylistImport()'); h.run("setPlaylistImportPlatform('jiosaavn')"); fill(h, 'Local favourites'); h.get('playlist-import-native-name').value = 'Exact existing playlist'; h.get('playlist-import-native-name').listeners.input(); await submit(h); assert.equal(h.calls[0].body.nativeName, 'Exact existing playlist'); assert.equal(h.calls[0].body.tracks[0].source, 'jiosaavn');
  const second = harness(async () => ({ playlist: { id: 'saved' } })); second.run('openPlaylistImport()'); second.run("setPlaylistImportPlatform('amazon-music')"); fill(second, 'Only a local name'); await submit(second); assert.equal(second.calls[0].body.nativeName, undefined);
});

test('direct original playback and saved-song queue playback remain separate actions for matching on-demand services', async () => {
  for (const source of ['apple-music', 'spotify', 'amazon-music', 'jiosaavn', 'deezer']) { const h = harness(async path => path.endsWith('/play-native') ? { mode: 'native-playlist', status: 'sent', message: 'Request accepted.' } : { queue: { id: 'queue' } }); h.state.providers = [{ id: source, kind: 'music', name: source }]; h.state.providerId = source; h.state.deviceId = 'echo'; h.state.localPlaylist = { id: 'saved', country: 'IN', origin: { source, name: 'Original' }, originUnchanged: false, tracks: [{ title: 'Edited', artist: 'Artist' }] }; h.run('renderLocalReadiness()'); assert.equal(h.get('local-playlist-native-play').hidden, false); assert.equal(h.get('local-playlist-play').disabled, false); await h.run('playLocalPlaylistNative()'); assert.match(h.calls[0].path, /\/play-native$/); assert.equal(h.observations.some(item => item[0] === 'queue-view'), false); await h.run('playLocalPlaylist()'); assert.match(h.calls[1].path, /\/play$/); assert.ok(h.observations.some(item => item[0] === 'queue-view')); }
});

test('direct playback stays hidden for radio, Alexa default, YouTube, or a mismatched service', () => {
  const h = harness(); for (const [source, kind, selected] of [['tunein', 'radio', 'tunein'], ['alexa-default', 'default', 'alexa-default'], ['youtube-music', 'music', 'youtube-music'], ['spotify', 'music', 'apple-music']]) { h.state.providerId = selected; h.state.providers = [{ id: selected, kind }]; h.context.playlist = { origin: { source } }; assert.equal(h.run('nativeLocalPlaylist(playlist)'), false); }
});

test('every Created card and detail distinguishes local ownership from its imported platform', () => {
  const h = harness(); h.state.playlists = [{ id: 'apple', source: 'local', country: 'IN', title: 'Apple copy', importedSource: 'apple-music' }, { id: 'manual', source: 'local', country: 'IN', title: 'Made here' }]; h.run('renderPlaylistCards()'); const labels = h.get('playlist-grid').children.map(card => card.children.find(child => child.className === 'playlist-source-badge').textContent); assert.deepEqual(labels, ['Apple Music · Original name unavailable', 'Created here · India']);
  h.state.localPlaylist = { id: 'apple', title: 'Copy', country: 'IN', imported: true, importSource: 'apple-music', tracks: [] }; h.run('renderLocalPlaylist()'); assert.equal(h.get('local-playlist-source').textContent, 'Apple Music · Original name unavailable'); assert.equal(h.get('local-playlist-import-note').hidden, false); h.run("renderLocalImportNotice({country:'IN',tracks:[{source:'spotify'}]})"); assert.equal(h.get('local-playlist-import-note').hidden, true);
});

test('additional Alexa music providers support manual import and exact remote names without pretending their links can load', async () => {
  const h = harness(); h.state.providers = [{ id: 'deezer', name: 'Deezer', kind: 'music' }, { id: 'tunein', name: 'TuneIn', kind: 'radio' }]; h.run('openPlaylistImport()'); h.run("setPlaylistImportPlatform('deezer')"); assert.ok(h.get('playlist-import-platform').children.some(option => option.value === 'deezer')); assert.equal(h.get('playlist-import-platform').children.some(option => option.value === 'tunein'), false); h.get('playlist-import-url').value = 'https://example.com/playlist'; h.run('renderPlaylistImport()'); assert.equal(h.get('playlist-import-load').disabled, true); await h.run('loadPlaylistImport()'); assert.equal(h.calls.length, 0); assert.match(h.get('playlist-import-link-note').textContent, /not available/);
});


test('Apple import guidance allows public loading and detector follows the shared country/pl.id path contract', () => {
  const h = harness(); h.run('openPlaylistImport();setPlaylistImportPlatform("apple-music")'); assert.match(h.get('playlist-import-link-note').textContent, /loaded without sign-in/); assert.match(h.get('playlist-import-link-note').textContent, /official catalogue/);
  for (const link of ['https://music.apple.com/in/playlist/pl.ABC_123-test', 'https://music.apple.com/US/playlist/a-slug/pl.ABC_123-test']) { h.context.link = link; assert.equal(h.run('playlistImportPlatformFromUrl(link)'), 'apple-music'); }
  for (const link of ['https://music.apple.com/playlist/pl.ABC123', 'https://music.apple.com/in/playlist/name/p.ABC123', 'https://music.apple.com/in/playlist/name/pl.ABC.123']) { h.context.link = link; assert.equal(h.run('playlistImportPlatformFromUrl(link)'), ''); }
});


test('import choices and parser reject unknown discovered services while allowing persisted supported extras', () => {
  const h = harness(); h.state.providers = [{ id: 'custom-alexa-service', name: 'Custom Alexa service', kind: 'music' }, { id: 'tidal', name: 'Tidal', kind: 'music' }]; h.run('openPlaylistImport()'); const sources = h.get('playlist-import-platform').children.map(option => option.value); assert.equal(sources.includes('custom-alexa-service'), false); assert.equal(sources.includes('tidal'), true); assert.throws(() => h.run("parsePlaylistImport('Song — Artist',[],'IN','custom-alexa-service')"), /supported playlist platform/); assert.equal(h.run("parsePlaylistImport('Song — Artist',[],'IN','tidal')[0].source"), 'tidal');
});


test('Amazon detection accepts full personal shared playlist IDs and enforces the shared length bound', () => {
  const h = harness(); for (const link of ['https://music.amazon.in/user-playlists/12345678-abcd_EFGH/', 'https://music.amazon.com/playlists/B0EXAMPLE']) { h.context.link = link; assert.equal(h.run('playlistImportPlatformFromUrl(link)'), 'amazon-music'); }
  for (const id of ['short', 'x'.repeat(161)]) { h.context.link = 'https://music.amazon.com/user-playlists/' + id; assert.equal(h.run('playlistImportPlatformFromUrl(link)'), ''); }
});


test('new imports default to service-prefixed original source names for each music platform', async () => {
  const samples = [
    ['spotify', 'Spotify', 'https://open.spotify.com/playlist/1234567890123456789012'],
    ['apple-music', 'Apple Music', 'https://music.apple.com/in/playlist/original/pl.example123'],
    ['youtube-music', 'YouTube Music', 'https://music.youtube.com/playlist?list=PLtest'],
  ];
  for (const [source, label, url] of samples) {
    const original = 'Original source playlist';
    const h = harness(async () => ({ source, name: original, total: 1, skipped: 0, tracks: [{ title: 'Song', artist: 'Artist' }] }));
    h.run('openPlaylistImport()'); h.get('playlist-import-url').value = url;
    await h.run('loadPlaylistImport()');
    assert.equal(h.get('playlist-import-name').value, label + ': ' + original);
    assert.equal(h.state.playlistImport.preview.name, original);
  }
});

test('loading another source updates only an untouched automatic import name', async () => {
  let name = 'First source', source = 'spotify';
  const h = harness(async () => ({ source, name, total: 1, skipped: 0, tracks: [{ title: 'Song', artist: 'Artist' }] }));
  h.run('openPlaylistImport()'); h.get('playlist-import-url').value = 'https://open.spotify.com/playlist/1234567890123456789012'; await h.run('loadPlaylistImport()');
  assert.equal(h.get('playlist-import-name').value, 'Spotify: First source');
  name = 'Second source'; source = 'apple-music'; h.get('playlist-import-url').value = 'https://music.apple.com/in/playlist/second/pl.example123'; await h.run('loadPlaylistImport()');
  assert.equal(h.get('playlist-import-name').value, 'Apple Music: Second source');
  h.get('playlist-import-name').value = 'My own label'; h.get('playlist-import-name').listeners.input();
  name = 'Third source'; source = 'youtube-music'; h.get('playlist-import-url').value = 'https://music.youtube.com/playlist?list=PLtest'; await h.run('loadPlaylistImport()');
  assert.equal(h.get('playlist-import-name').value, 'My own label');
  assert.equal(h.state.playlistImport.preview.name, 'Third source');
});

test('a custom name entered while an import loads is preserved and long defaults retain full source identity', async () => {
  let resolve; const h = harness(async () => new Promise(done => { resolve = done; }));
  h.run('openPlaylistImport()'); h.get('playlist-import-url').value = 'https://open.spotify.com/playlist/1234567890123456789012'; const pending = h.run('loadPlaylistImport()');
  h.get('playlist-import-name').value = 'My custom playlist'; h.get('playlist-import-name').listeners.input();
  resolve({ source: 'spotify', name: 'Source playlist', tracks: [{ title: 'Song', artist: 'Artist' }] }); await pending;
  assert.equal(h.get('playlist-import-name').value, 'My custom playlist');
  const original = 'Long source name '.repeat(12), long = harness(async () => ({ source: 'spotify', name: original, total: 1, skipped: 0, tracks: [{ title: 'Song', artist: 'Artist' }] }));
  long.run('openPlaylistImport()'); long.get('playlist-import-url').value = 'https://open.spotify.com/playlist/1234567890123456789012'; await long.run('loadPlaylistImport()');
  assert.equal(long.get('playlist-import-name').value.length, 100); assert.match(long.get('playlist-import-name').value, /^Spotify: /);
  assert.equal(long.state.playlistImport.preview.name, original.trim());
});


const sharedYouTubeLink = 'https://music.youtube.com/playlist?list=PLDwn4EGkswYOV1Hs7Vvx-SzNxFLBskEAl&si=jVkxtQPeIuvIB5og&drli=1';
const flushImport = async () => { for (let at = 0; at < 6; at++) await new Promise(resolve => setImmediate(resolve)); };
function pasteLink(h, value) { h.get('playlist-import-url').value = value; h.get('playlist-import-url').listeners.input({ target: { id: 'playlist-import-url' } }); }

test('the supplied YouTube Music share link automatically loads its source name and keeps India', async () => {
  const tracks = Array.from({ length: 26 }, (_, index) => ({ title: 'Song ' + index, artist: index < 4 ? 'Artist' : '', needsReview: index >= 4 }));
  const h = harness(async () => ({ source: 'youtube-music', name: 'best song', tracks, total: 28, skipped: 0, truncated: true, notes: ['Only 26 visible songs were returned.'] }));
  h.run('openPlaylistImport()'); assert.equal(h.get('playlist-import-url').focused, true);
  pasteLink(h, sharedYouTubeLink); assert.equal(h.calls.length, 0); assert.equal(h.state.playlistImport.platform, 'youtube-music');
  await h.fireAuto();
  assert.deepEqual(h.calls[0].body, { url: sharedYouTubeLink, country: 'IN' });
  assert.equal(h.get('playlist-import-name').value, 'YouTube Music: best song');
  assert.equal(h.get('playlist-import-country').value, 'IN');
  assert.match(h.get('playlist-import-status').textContent, /Loaded 26 of 28 entries.*partial.*22 need a title or artist/);
});

test('all supported playlist services load automatically from a valid pasted link', async () => {
  for (const [source, url] of Object.entries(importLinks)) {
    const h = harness(async () => ({ source, name: 'Original playlist', total: 1, skipped: 0, tracks: [{ title: 'Song', artist: 'Artist' }] }));
    h.run('openPlaylistImport()'); pasteLink(h, url);
    assert.equal(h.state.playlistImport.platform, source); assert.equal(h.calls.length, 0);
    await h.fireAuto();
    assert.equal(h.calls.length, 1, source); assert.equal(h.calls[0].body.country, 'IN');
    assert.equal(h.state.playlistImport.preview.name, 'Original playlist');
    assert.match(h.get('playlist-import-name').value, /: Original playlist$/);
    assert.equal(h.state.providerId, 'apple-music', 'Echo streaming selection is independent of import source');
  }
});

test('country detection uses explicit storefronts, marketplaces or region parameters, never language or share tokens', () => {
  const h = harness();
  const cases = [
    ['https://music.apple.com/US/playlist/example/pl.example123', 'US'],
    ['https://music.amazon.co.uk/playlists/B0EXAMPLE', 'GB'],
    ['https://music.amazon.com.au/user-playlists/12345678', 'AU'],
    ['https://open.spotify.com/playlist/1234567890123456789012?market=CA', 'CA'],
    [sharedYouTubeLink + '&gl=DE', 'DE'],
    ['https://open.spotify.com/intl-en/playlist/1234567890123456789012', ''],
    [sharedYouTubeLink, ''],
    [sharedYouTubeLink + '&gl=IN&gl=US', ''],
    ['https://music.apple.com/fr/playlist/example/pl.example123', ''],
    [importLinks.jiosaavn, ''],
  ];
  for (const [url, country] of cases) { h.context.link = url; assert.equal(h.run('playlistImportCountryFromUrl(link)'), country, url); }
  h.get('country-select').value = 'AU'; h.run('openPlaylistImport()'); pasteLink(h, sharedYouTubeLink);
  assert.equal(h.get('playlist-import-country').value, 'AU');
});

test('an explicit country is inferred once per new link and a manual override survives re-pasting that link', async () => {
  const h = harness(async () => ({ source: 'apple-music', name: 'Original', total: 1, skipped: 0, tracks: [{ title: 'Song', artist: 'Artist' }] }));
  const first = 'https://music.apple.com/us/playlist/first/pl.first';
  h.run('openPlaylistImport()'); pasteLink(h, first); assert.equal(h.get('playlist-import-country').value, 'US');
  h.get('playlist-import-country').value = 'GB'; h.get('playlist-import-country').listeners.input({ target: { id: 'playlist-import-country' } });
  pasteLink(h, first); await h.fireAuto(); assert.equal(h.calls[0].body.country, 'GB');
  pasteLink(h, 'https://music.apple.com/ca/playlist/second/pl.second'); assert.equal(h.get('playlist-import-country').value, 'CA');
});

test('a newer pasted link waits for the old lookup and only the newest result is published', async () => {
  let release;
  const h = harness(async (_path, body) => body.url === importLinks.spotify ? new Promise(resolve => { release = resolve; }) : { source: 'youtube-music', name: 'Newest', total: 1, skipped: 0, tracks: [{ title: 'New song', artist: 'New artist' }] });
  h.run('openPlaylistImport()'); pasteLink(h, importLinks.spotify); const old = h.fireAuto();
  pasteLink(h, sharedYouTubeLink); await h.fireAuto(); assert.equal(h.calls.length, 1);
  release({ source: 'spotify', name: 'Old source', tracks: [{ title: 'Old song', artist: 'Old artist' }] }); await old; await flushImport();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].body.url, sharedYouTubeLink);
  assert.equal(h.get('playlist-import-name').value, 'YouTube Music: Newest');
  assert.equal(h.get('playlist-import-text').value, 'New song — New artist');
});

test('manual song edits invalidate an in-flight auto lookup and cancel its queued replacement', async () => {
  let release; const h = harness(async () => new Promise(resolve => { release = resolve; }));
  h.run('openPlaylistImport()'); pasteLink(h, importLinks.spotify); const old = h.fireAuto();
  pasteLink(h, sharedYouTubeLink); await h.fireAuto();
  h.get('playlist-import-name').value = 'My custom label'; h.get('playlist-import-name').listeners.input();
  h.get('playlist-import-text').value = 'My review — My artist'; h.get('playlist-import-text').listeners.input({ target: { id: 'playlist-import-text' } });
  release({ source: 'spotify', name: 'Old source', tracks: [{ title: 'Old song', artist: 'Old artist' }] }); await old; await flushImport();
  assert.equal(h.calls.length, 1); assert.equal(h.get('playlist-import-name').value, 'My custom label');
  assert.equal(h.get('playlist-import-text').value, 'My review — My artist');
  pasteLink(h, sharedYouTubeLink); await h.fireAuto(); assert.equal(h.calls.length, 1, 're-paste cannot overwrite reviewed song text automatically');
});

test('duplicate paste and an immediate Load songs click do not duplicate one request', async () => {
  let release; const h = harness(async () => new Promise(resolve => { release = resolve; }));
  h.run('openPlaylistImport()'); pasteLink(h, sharedYouTubeLink); const request = h.run('loadPlaylistImport()');
  pasteLink(h, sharedYouTubeLink); await h.fireAuto(); assert.equal(h.calls.length, 1);
  release({ source: 'youtube-music', name: 'Shared', tracks: [{ title: 'Song', artist: 'Artist' }] }); await request;
  assert.equal(h.get('playlist-import-name').value, 'YouTube Music: Shared');
  pasteLink(h, sharedYouTubeLink); await h.fireAuto(); assert.equal(h.calls.length, 1);
});

test('optional empty, unfinished, generated-mix and unsupported links never auto-load; closing cancels the timer', async () => {
  for (const url of ['', 'https://open.spotify.com/playlist/short', 'https://youtube.com/playlist?list=RDgenerated', sharedYouTubeLink + '&list=PLduplicate', 'https://example.com/playlist']) {
    const h = harness(); h.run('openPlaylistImport()'); pasteLink(h, url); await h.fireAuto(); assert.equal(h.calls.length, 0, url);
  }
  const h = harness(); h.run('openPlaylistImport()'); pasteLink(h, sharedYouTubeLink); h.run('closePlaylistImport();openPlaylistImport()'); await h.fireAuto();
  assert.equal(h.calls.length, 0); assert.equal(h.get('playlist-import-name').value, '');
});


test('saving waits for a pasted replacement link instead of importing the previous rows', async () => {
  const h = harness(async (path, body) => path.endsWith('/preview') ? { source: 'youtube-music', name: body.url === sharedYouTubeLink ? 'First' : 'Second', total: 1, skipped: 0, tracks: [{ title: body.url === sharedYouTubeLink ? 'First song' : 'Second song', artist: 'Artist' }] } : { playlist: { id: 'saved' } });
  h.run('openPlaylistImport()'); pasteLink(h, sharedYouTubeLink); await h.fireAuto();
  pasteLink(h, 'https://music.youtube.com/playlist?list=PLsecond');
  assert.equal(h.get('playlist-import-save').disabled, true); await submit(h); assert.equal(h.calls.length, 1);
  await h.fireAuto(); assert.equal(h.get('playlist-import-text').value, 'Second song — Artist');
  assert.equal(h.get('playlist-import-save').disabled, false); await submit(h);
  assert.equal(h.calls[2].body.tracks[0].title, 'Second song');
});

test('a failed replacement link cannot save previous auto-filled rows until a deliberate song edit', async () => {
  const h = harness(async (path, body) => path.endsWith('/preview') ? body.url === sharedYouTubeLink ? { source: 'youtube-music', name: 'First', total: 1, skipped: 0, tracks: [{ title: 'First song', artist: 'Artist' }] } : Promise.reject(new Error('New link unavailable.')) : { playlist: { id: 'saved' } });
  h.run('openPlaylistImport()'); pasteLink(h, sharedYouTubeLink); await h.fireAuto();
  pasteLink(h, 'https://music.youtube.com/playlist?list=PLsecond'); await h.fireAuto();
  assert.equal(h.get('playlist-import-save').disabled, true); assert.match(h.get('playlist-import-status').textContent, /previous link’s songs were kept/);
  await submit(h); assert.equal(h.calls.length, 2);
  h.get('playlist-import-text').listeners.input({ target: { id: 'playlist-import-text' } });
  assert.equal(h.get('playlist-import-save').disabled, false); await submit(h); assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].body.previewId, undefined);
});

test('away-and-back URL and country changes reload the latest context after rejecting an old response', async () => {
  for (const field of ['url', 'country']) {
    let release; const h = harness(async () => h.calls.length === 1 ? new Promise(resolve => { release = resolve; }) : { source: 'youtube-music', name: 'Current', total: 1, skipped: 0, tracks: [{ title: 'Current song', artist: 'Artist' }] });
    h.run('openPlaylistImport()'); pasteLink(h, sharedYouTubeLink); const first = h.fireAuto();
    if (field === 'url') { pasteLink(h, 'https://music.youtube.com/playlist?list=PLother'); pasteLink(h, sharedYouTubeLink); }
    else { for (const country of ['US', 'IN']) { h.get('playlist-import-country').value = country; h.get('playlist-import-country').listeners.input({ target: { id: 'playlist-import-country' } }); } }
    await h.fireAuto(); release({ source: 'youtube-music', name: 'Stale', tracks: [{ title: 'Stale song', artist: 'Artist' }] });
    await first; await flushImport();
    assert.equal(h.calls.length, 2, field); assert.deepEqual(h.calls[1].body, { url: sharedYouTubeLink, country: 'IN' });
    assert.equal(h.get('playlist-import-text').value, 'Current song — Artist');
  }
});

test('an already loaded preview reloads after its country is changed away and back', async () => {
  const h = harness(async () => ({ source: 'youtube-music', name: 'Current', total: 1, skipped: 0, tracks: [{ title: 'Song', artist: 'Artist' }] }));
  h.run('openPlaylistImport()'); pasteLink(h, sharedYouTubeLink); await h.fireAuto();
  for (const country of ['US', 'IN']) { h.get('playlist-import-country').value = country; h.get('playlist-import-country').listeners.input({ target: { id: 'playlist-import-country' } }); }
  await h.fireAuto(); assert.equal(h.calls.length, 2); assert.equal(h.get('playlist-import-save').disabled, false);
});
