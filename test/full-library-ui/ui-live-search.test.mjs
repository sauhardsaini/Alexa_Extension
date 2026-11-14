import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../../library/public/app.js', import.meta.url), 'utf8');
function frontendFunction(name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(script);
  assert.ok(match, 'frontend function exists: ' + name);
  const rest = script.slice(match.index), next = /\n  (?:async )?function /g; next.lastIndex = 1;
  const end = next.exec(rest); return end ? rest.slice(0, end.index) : rest;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const nodes = new Map(), timers = new Map(), calls = [], rendered = []; let serial = 0;
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, listeners: {}, setAttribute() {}, focus() {}, addEventListener(name, callback) { this.listeners[name] = callback; } });
    return nodes.get(id);
  };
  get('country-select').value = 'IN';
  const state = { apple: { connected: false }, catalogueSource: 'itunes', view: 'search', tracks: [], resultsCountry: null, resultsSource: null, searchGeneration: 0, searchController: null, searchTimer: null, searchComposing: false, searchRequestKey: '', searchCompletedKey: '', searching: false, playlistsSource: 'local', playlists: [{}], localPlaylist: null, playlistArtworkRevision: 0 };
  const context = vm.createContext({ state, JSON, String, encodeURIComponent, AbortController, $: get,
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    countryName: country => country, normalizeCountry: value => value,
    clearSearchResults() { state.tracks = []; state.resultsCountry = null; state.resultsSource = null; }, renderSearchReadiness() {}, updatePlayButtons() {}, renderCatalogueSource() {}, renderPlaylistSources() {}, renderLocalPlaylist() {}, loadPlaylists() {},
    renderTracks(query) { rendered.push({ query, ids: Array.from(state.tracks, track => track.id) }); },
    fetch(path, options) { let resolve; const promise = new Promise(done => { resolve = done; }); calls.push({ path, signal: options.signal, reply(data) { resolve({ ok: true, json: async () => data }); } }); return promise; },
  });
  const names = ['clearSearchTimer', 'searchSource', 'searchKey', 'invalidateSearch', 'scheduleLiveSearch', 'search', 'setBrowseView'];
  vm.runInContext(names.map(frontendFunction).join('\n'), context);
  for (const line of script.split('\n').filter(line => /\$\('search-(?:input|form)'\)\.addEventListener/.test(line))) vm.runInContext(line, context);
  return { state, calls, rendered, get, timers, run: code => vm.runInContext(code, context), type(value) { get('search-input').value = value; get('search-input').listeners.input(); },
    fire(delay = 600) { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, 'matching timer is pending'); timers.delete(entry[0]); entry[1].callback(); },
    event(id, name) { return get(id).listeners[name]({ preventDefault() {} }); },
  };
}
const result = id => ({ country: 'IN', source: 'itunes', tracks: [{ id }] });

test('typing searches once after the debounce and Enter submits immediately without a duplicate request', async () => {
  const h = harness(); h.type('L'); assert.equal(h.timers.size, 0);
  h.type('Lo'); h.type('Lov'); h.type('Lover'); assert.equal(h.calls.length, 0); assert.equal([...h.timers.values()].filter(timer => timer.delay === 600).length, 1);
  h.fire(); assert.equal(h.calls.length, 1); assert.match(h.calls[0].path, /q=Lover&country=IN/);
  h.event('search-form', 'submit'); assert.equal(h.calls.length, 1, 'Enter does not duplicate an active identical search');
  h.calls[0].reply(result('lover')); await flush(); assert.deepEqual(h.rendered, [{ query: 'Lover', ids: ['lover'] }]);
  h.type(' Lover '); assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 1, 'the same completed query is reused');
  h.type('Taylor'); h.event('search-form', 'submit'); assert.equal(h.calls.length, 2); assert.equal([...h.timers.values()].some(timer => timer.delay === 600), false);
  h.calls[1].reply(result('taylor')); await flush();
});

test('a new typed query invalidates old results immediately and late responses cannot replace the latest query', async () => {
  const h = harness(); h.type('Old song'); h.fire();
  h.type('New song'); assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.state.resultsCountry, null); assert.deepEqual(h.state.tracks, []);
  h.fire(); h.calls[1].reply(result('new')); await flush(); h.calls[0].reply(result('old')); await flush();
  assert.deepEqual(h.rendered, [{ query: 'New song', ids: ['new'] }]);
  assert.equal(h.state.searching, false);
});

test('clearing or shortening a query cancels requests and no old results reappear', async () => {
  for (const value of ['', 'A']) {
    const h = harness(); h.type('Lover'); h.fire(); h.type(value);
    assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.state.searching, false); assert.equal([...h.timers.values()].some(timer => timer.delay === 600), false);
    h.calls[0].reply(result('stale')); await flush(); assert.deepEqual(h.rendered, []); assert.deepEqual(h.state.tracks, []);
  }
});

test('input composition waits until complete and switching to playlists cancels the typing timer', () => {
  const h = harness(); h.event('search-input', 'compositionstart'); h.type('गीत'); h.event('search-form', 'submit'); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
  h.event('search-input', 'compositionend'); assert.equal([...h.timers.values()].filter(timer => timer.delay === 600).length, 1);
  h.run("setBrowseView('playlists')"); assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 0);
});

test('country and catalogue changes reject old responses and invalidate pending debounce context', async () => {
  const h = harness(); h.type('Lover'); h.fire(); h.get('country-select').value = 'US'; h.run("invalidateSearch('')");
  h.calls[0].reply(result('india')); await flush(); assert.deepEqual(h.rendered, []);
  h.get('country-select').value = 'IN'; h.type('Lover'); h.fire(); h.state.catalogueSource = 'spotify'; h.calls[1].reply(result('old-source')); await flush(); assert.deepEqual(h.rendered, []);
  h.run("invalidateSearch('')"); h.type('New country'); h.get('country-select').value = 'US'; h.fire(); assert.equal(h.calls.length, 2, 'a stale timer cannot submit its former context');
});
