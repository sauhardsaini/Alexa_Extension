import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const sourceCode = await fs.readFile(new URL('../extension/sources.js', import.meta.url), 'utf8');
const controlsCode = await fs.readFile(new URL('../extension/source-controls.js', import.meta.url), 'utf8');
const contentCode = await fs.readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const probeCode = await fs.readFile(new URL('../extension/page-metadata.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL, URLSearchParams }); vm.runInContext(sourceCode, context); vm.runInContext(controlsCode, context);
const { control } = context.EchoSources, { run } = context.EchoSourceControls;
const url = 'https://music.youtube.com/watch?v=abcdefghijk';
const oldTrack = { source: 'youtube-music', title: 'Old Song', artist: 'Artist', trackId: 'abcdefghijk', state: 'playing', confidence: 'high', isAd: false };
const newTrack = { ...oldTrack, title: 'New Song', trackId: 'lmnopqrstuv' };
const node = (attrs = {}, children = {}, click = undefined) => ({ getAttribute: key => attrs[key] ?? null, hasAttribute: key => Object.hasOwn(attrs, key), querySelector: selector => children[selector] || null, click });
function player({ label = 'Pause', disabled = false } = {}) {
  const calls = [];
  const playback = node({ 'aria-label': label }, {}, () => calls.push('playback'));
  const next = node(disabled ? { disabled: '' } : {}, {}, () => calls.push('next'));
  const root = node({}, { '#play-pause-button': node({ title: label }, { 'button[aria-label]': playback, button: playback }), '#next-button': node({}, { button: next }) });
  const globalNext = node({}, {}, () => calls.push('WRONG GLOBAL NEXT'));
  const document = node({}, { 'ytmusic-player-bar': root, 'button[aria-label="Next"]': globalNext });
  return { document, calls, playback, next };
}
test('source controls click only the scoped player button and use nested labels', () => {
  const f = player(); assert.equal(control(f.document, url, 'next').ok, true); assert.deepEqual(f.calls, ['next']);
  assert.equal(control(f.document, url, 'pause').ok, true); assert.deepEqual(f.calls, ['next', 'playback']);
  assert.equal(control(f.document, url, 'play').clicked, false);
});
test('disabled controls, unknown source state and unsupported sites never click', () => {
  const f = player({ disabled: true }); assert.equal(control(f.document, url, 'next').ok, false); assert.deepEqual(f.calls, []);
  const unknown = player({ label: '' }); assert.equal(control(unknown.document, url, 'pause').ok, false);
  assert.equal(control(f.document, 'https://example.com/', 'next').ok, false); assert.equal(control(f.document, url, 'arbitrary command').ok, false);
});
function simulation(read, { timeoutMs = 5000, settleMs = 600 } = {}) {
  let time = 0; const calls = []; let played = false;
  return { calls, execute: action => run(action, { read: () => read(time, played), control: (action, state) => { calls.push({ action, state, at: time }); if (action === 'play') played = true; return { ok: true }; }, now: () => time, wait: async ms => { time += ms; }, timeoutMs, settleMs }) };
}
test('Next waits for a new stable playing song and never returns the original', async () => {
  const f = simulation(time => time < 600 ? oldTrack : newTrack);
  const result = await f.execute('next'); assert.equal(result.ok, true); assert.equal(result.track.title, 'New Song'); assert.deepEqual(f.calls.map(x => x.action), ['next']);
});
test('URL or track-id change alone cannot confirm Next using old title and artist', async () => {
  const f = simulation(time => time ? { ...oldTrack, trackId: 'changed-only-url' } : oldTrack, { timeoutMs: 1200, settleMs: 300 });
  const result = await f.execute('next'); assert.equal(result.ok, false); assert.equal(result.track, undefined); assert.deepEqual(f.calls.map(x => x.action), ['next']);
});
test('Next holds through ads and incomplete metadata until a confirmed new song', async () => {
  const f = simulation(time => time < 150 ? oldTrack : time < 600 ? { ...newTrack, title: 'Sponsored', isAd: true } : time < 1200 ? { ...newTrack, artist: '', confidence: 'review' } : newTrack);
  const result = await f.execute('next'); assert.equal(result.ok, true); assert.equal(result.track.title, 'New Song');
});
test('Next starts the new item once if the source keeps it paused', async () => {
  const f = simulation((time, played) => time < 300 ? oldTrack : { ...newTrack, state: played ? 'playing' : 'paused' });
  const result = await f.execute('next'); assert.equal(result.ok, true); assert.equal(result.track.state, 'playing'); assert.deepEqual(f.calls.map(x => x.action), ['next', 'play']);
});
test('Play and Pause wait for their actual reported state', async () => {
  for (const [action, initial, desired] of [['play', 'paused', 'playing'], ['pause', 'playing', 'paused']]) {
    const f = simulation(time => ({ ...oldTrack, state: time < 450 ? initial : desired }));
    const result = await f.execute(action); assert.equal(result.ok, true); assert.equal(result.track.state, desired);
  }
});
test('source-control failures and missing songs return an explicit failure without old metadata', async () => {
  const result = await run('next', { read: () => oldTrack, control: () => ({ ok: false, message: 'Disabled' }) });
  assert.equal(result.ok, false); assert.equal(result.message, 'Disabled'); assert.equal(result.track, undefined);
  assert.equal((await run('next', { read: () => null })).ok, false);
});
test('Media Session polling detects keyboard metadata/state changes without a click or URL event', () => {
  const published = [], intervals = [];
  const session = { metadata: { title: 'Old Song', artist: 'Artist', album: 'Album' }, playbackState: 'playing' };
  const ctx = vm.createContext({ window: {}, navigator: { mediaSession: session }, document: { querySelectorAll: () => [], addEventListener() {}, dispatchEvent: event => published.push(JSON.parse(event.detail)) }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, setInterval: callback => intervals.push(callback) });
  vm.runInContext(probeCode, ctx); assert.equal(published.at(-1).title, 'Old Song');
  session.metadata = { title: 'Keyboard Next Song', artist: 'Second Artist', album: 'Album' }; intervals[0]();
  assert.equal(published.at(-1).title, 'Keyboard Next Song'); assert.equal(published.at(-1).artist, 'Second Artist');
  session.playbackState = 'paused'; intervals[0](); assert.equal(published.at(-1).state, 'paused');
});
function contentHarness({ runControl = run } = {}) {
  let time = 0, timerId = 0, observed = oldTrack, mutation, messageListener;
  const timers = new Map(), intervals = [], updates = [];
  const ctx = vm.createContext({ EchoSources: { read: () => observed, mediaInfo: value => value }, EchoSourceControls: { run: runControl }, location: { href: url }, document: { documentElement: {}, addEventListener() {} }, MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} }, chrome: { runtime: { id: 'a'.repeat(32), sendMessage: async value => { updates.push(value); }, onMessage: { addListener(callback) { messageListener = callback; } } } }, setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: time + delay }); return id; }, clearTimeout: id => timers.delete(id), setInterval: callback => intervals.push(callback) });
  vm.runInContext(contentCode, ctx);
  const advance = milliseconds => { const target = time + milliseconds; let count = 0; while (++count < 1000) { const due = [...timers].filter(([_id, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); time = due[1].at; due[1].callback(); } time = target; };
  return { updates, advance, intervals, mutate: track => { observed = track; mutation(); }, changeWithoutEvent: track => { observed = track; }, message: (...args) => messageListener(...args) };
}
test('content watchdog forwards keyboard song changes without DOM click or navigation', () => {
  const f = contentHarness(); f.advance(1000); assert.equal(f.updates.at(-1).track.title, 'Old Song');
  f.changeWithoutEvent(newTrack); f.intervals[0](); f.advance(1100); assert.equal(f.updates.at(-1).track.title, 'New Song');
});
test('content mutation observation notices new metadata with the URL unchanged', () => {
  const f = contentHarness(); f.advance(1000); f.mutate(newTrack); f.advance(1000); assert.equal(f.updates.at(-1).track.title, 'New Song');
});
test('content rejects source-control commands from source tabs or other extensions', () => {
  const f = contentHarness(); let response;
  assert.equal(f.message({ type: 'CONTROL_SOURCE', action: 'next' }, { id: 'a'.repeat(32), tab: { id: 1 } }, value => { response = value; }), false); assert.equal(response.ok, false);
  assert.equal(f.message({ type: 'CONTROL_SOURCE', action: 'next' }, { id: 'b'.repeat(32) }, value => { response = value; }), false); assert.equal(response.ok, false);
});

test('native media changes publish fresh metadata without relying on a background timer', () => {
  const published = [], listeners = new Map();
  const session = { metadata: { title: 'Old Song', artist: 'Artist' }, playbackState: 'playing' };
  const ctx = vm.createContext({ window: {}, navigator: { mediaSession: session }, document: { querySelectorAll: () => [], addEventListener: (name, callback) => listeners.set(name, callback), dispatchEvent: event => published.push(JSON.parse(event.detail)) }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, setInterval() {} });
  vm.runInContext(probeCode, ctx);
  session.metadata = { title: 'Keyboard Changed Song', artist: 'Second Artist' };
  listeners.get('loadedmetadata')(); assert.equal(published.at(-1).title, 'Keyboard Changed Song');
  session.playbackState = 'paused'; listeners.get('pause')(); assert.equal(published.at(-1).state, 'paused');
});

test('content observations and snapshots carry increasing bounded session revisions', () => {
  const f = contentHarness(); let snapshot;
  f.advance(1000); const first = f.updates.at(-1);
  assert.equal(first.revision, 1); assert.equal(Number.isSafeInteger(first.revision), true);
  f.mutate(newTrack); f.advance(1000); const second = f.updates.at(-1);
  assert.ok(second.revision > first.revision); assert.ok(second.revision <= Number.MAX_SAFE_INTEGER);
  f.message({ type: 'GET_TRACK' }, {}, value => { snapshot = value; });
  assert.equal(snapshot.revision, second.revision); assert.equal(snapshot.track.title, 'New Song');
});
test('successful source-control replies stamp the fresh confirmed observation', async () => {
  const f = contentHarness({ runControl: async () => ({ ok: true, track: newTrack }) });
  f.advance(1000); const beforeRevision = f.updates.at(-1).revision;
  f.changeWithoutEvent(newTrack);
  const response = await new Promise(resolve => f.message({ type: 'CONTROL_SOURCE', action: 'next' }, { id: 'a'.repeat(32) }, resolve));
  assert.equal(response.ok, true); assert.equal(response.track.title, 'New Song'); assert.ok(response.revision > beforeRevision);
  let snapshot; f.message({ type: 'GET_TRACK' }, {}, value => { snapshot = value; }); assert.equal(snapshot.revision, response.revision);
});
test('a delayed source-control result cannot stamp an older song after a newer observation', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const f = contentHarness({ runControl: () => delayed });
  f.advance(1000);
  const pending = new Promise(resolve => f.message({ type: 'CONTROL_SOURCE', action: 'next' }, { id: 'a'.repeat(32) }, resolve));
  f.mutate(newTrack); f.advance(1000);
  const secondNext = { ...newTrack, title: 'Second Next Song', trackId: 'second-next-id' };
  f.mutate(secondNext); f.advance(1000); const newest = f.updates.at(-1);
  release({ ok: true, track: newTrack });
  const result = await pending; assert.equal(result.ok, false); assert.equal(result.track, undefined);
  let snapshot; f.message({ type: 'GET_TRACK' }, {}, value => { snapshot = value; });
  assert.equal(snapshot.track.title, 'Second Next Song'); assert.equal(snapshot.revision, newest.revision);
});

test('valid Next reply accepts fresh DOM even when an old-song progress observation committed later', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const f = contentHarness({ runControl: () => delayed }); f.advance(1000);
  const pending = new Promise(resolve => f.message({ type: 'CONTROL_SOURCE', action: 'next' }, { id: 'a'.repeat(32) }, resolve));
  f.mutate({ ...oldTrack, positionMs: 30000 }); f.advance(1000); const progressRevision = f.updates.at(-1).revision;
  f.changeWithoutEvent(newTrack); release({ ok: true, track: newTrack });
  const result = await pending; assert.equal(result.ok, true); assert.equal(result.track.title, 'New Song'); assert.ok(result.revision > progressRevision);
});
test('source replies keep fresh full metadata while ignoring harmless album and duration differences', async () => {
  const resultTrack = { ...newTrack, album: 'Prior album text', durationMs: 190000 };
  const f = contentHarness({ runControl: async () => ({ ok: true, track: resultTrack }) }); f.advance(1000);
  f.changeWithoutEvent({ ...newTrack, album: 'Fresh album text', durationMs: 200000 });
  const response = await new Promise(resolve => f.message({ type: 'CONTROL_SOURCE', action: 'play' }, { id: 'a'.repeat(32) }, resolve));
  assert.equal(response.ok, true); assert.equal(response.track.album, 'Fresh album text'); assert.equal(response.track.durationMs, 200000);
});

test('held Next pauses the new song immediately and returns stable paused metadata without resuming', async () => {
  let time = 0, paused = false; const calls = [];
  const result = await run('next', {
    hold: true, expectedTrack: oldTrack,
    read: () => time < 300 ? oldTrack : { ...newTrack, state: paused ? 'paused' : 'playing', durationMs: 210000, positionMs: 500 },
    control: (action, state, expected) => { calls.push({ action, at: time, expected: expected.title }); if (action === 'pause') paused = true; return { ok: true }; },
    now: () => time, wait: async ms => { time += ms; }, settleMs: 800, timeoutMs: 3000
  });
  assert.equal(result.ok, true); assert.equal(result.track.state, 'paused'); assert.equal(result.track.title, 'New Song');
  assert.equal(result.track.durationMs, 210000); assert.equal(result.track.positionMs, 500);
  assert.deepEqual(calls.map(value => value.action), ['next', 'pause']);
  assert.equal(calls[1].at, 300); assert.equal(calls[1].expected, 'New Song'); assert.ok(time >= 1100);
});
test('held Next leaves an already paused new queue item paused', async () => {
  let time = 0; const calls = [];
  const result = await run('next', { hold: true, read: () => time < 150 ? oldTrack : { ...newTrack, state: 'paused' }, control: action => { calls.push(action); return { ok: true }; }, now: () => time, wait: async ms => { time += ms; }, settleMs: 300, timeoutMs: 1500 });
  assert.equal(result.ok, true); assert.equal(result.track.state, 'paused'); assert.deepEqual(calls, ['next']);
});
test('held Next does not pause an ad or incomplete transition before a reliable new song', async () => {
  let time = 0, paused = false; const calls = [];
  const result = await run('next', {
    hold: true,
    read: () => time < 150 ? oldTrack : time < 600 ? { ...newTrack, isAd: true } : time < 1200 ? { ...newTrack, artist: '', confidence: 'review' } : { ...newTrack, state: paused ? 'paused' : 'playing' },
    control: action => { calls.push({ action, at: time }); if (action === 'pause') paused = true; return { ok: true }; },
    now: () => time, wait: async ms => { time += ms; }, settleMs: 300, timeoutMs: 2500
  });
  assert.equal(result.ok, true); assert.equal(result.track.state, 'paused');
  assert.deepEqual(calls, [{ action: 'next', at: 0 }, { action: 'pause', at: 1200 }]);
});
test('held Next cannot return a playing song when the native pause never takes effect', async () => {
  let time = 0; const calls = [];
  const result = await run('next', { hold: true, read: () => time < 150 ? oldTrack : newTrack, control: action => { calls.push(action); return { ok: true }; }, now: () => time, wait: async ms => { time += ms; }, settleMs: 300, timeoutMs: 1200 });
  assert.equal(result.ok, false); assert.equal(result.track, undefined); assert.deepEqual(calls, ['next', 'pause']);
});
test('an older Play or Pause handoff never clicks a newer selected recording', async () => {
  for (const action of ['play', 'pause']) {
    const calls = [];
    const result = await run(action, { expectedTrack: oldTrack, read: () => newTrack, control: value => { calls.push(value); return { ok: true }; } });
    assert.equal(result.ok, false); assert.equal(result.stale, true); assert.equal(result.track, undefined); assert.deepEqual(calls, []);
  }
  const result = await run('pause', { expectedTrack: oldTrack, read: () => ({ ...oldTrack, trackId: 'different-recording-id' }), control: () => { throw new Error('must not click'); } });
  assert.equal(result.stale, true);
});
test('expected recording is checked again immediately before the native click', async () => {
  let reads = 0; const calls = [];
  const result = await run('pause', { expectedTrack: oldTrack, read: () => ++reads === 1 ? oldTrack : newTrack, control: action => { calls.push(action); return { ok: true }; } });
  assert.equal(result.stale, true); assert.deepEqual(calls, []);
});
test('a Play or Pause result cannot confirm a different song that appears while awaiting native state', async () => {
  let time = 0; const calls = [];
  const result = await run('pause', { expectedTrack: oldTrack, read: () => time < 150 ? oldTrack : { ...newTrack, state: 'paused' }, control: action => { calls.push(action); return { ok: true }; }, now: () => time, wait: async ms => { time += ms; }, settleMs: 300, timeoutMs: 1200 });
  assert.equal(result.stale, true); assert.equal(result.track, undefined); assert.deepEqual(calls, ['pause']);
});
test('a held Next does not pause or resume a later selection after its first new song was held', async () => {
  let time = 0, paused = false; const calls = [];
  const second = { ...newTrack, title: 'Another Selection', trackId: 'another-track-id' };
  const result = await run('next', {
    hold: true,
    read: () => time < 150 ? oldTrack : time < 450 ? { ...newTrack, state: paused ? 'paused' : 'playing' } : second,
    control: action => { calls.push(action); if (action === 'pause') paused = true; return { ok: true }; },
    now: () => time, wait: async ms => { time += ms; }, settleMs: 800, timeoutMs: 2000
  });
  assert.equal(result.stale, true); assert.equal(result.track, undefined); assert.deepEqual(calls, ['next', 'pause']);
});
test('invalid expected identities cannot trigger native playback controls', async () => {
  for (const expectedTrack of [{ ...oldTrack, artist: '', trackId: '' }, { ...oldTrack, title: 'x'.repeat(251) }, { ...oldTrack, source: 'untrusted' }, { ...oldTrack, trackId: 12 }, []]) {
    const result = await run('play', { expectedTrack, read: () => oldTrack, control: () => { throw new Error('must not click'); } });
    assert.equal(result.ok, false);
  }
});
test('content forwards held Next and expected identity options only through its trusted control path', async () => {
  let options;
  const heldTrack = { ...newTrack, state: 'paused' };
  const f = contentHarness({ runControl: async (_action, value) => { options = value; return { ok: true, track: heldTrack }; } });
  f.advance(1000); f.changeWithoutEvent(heldTrack);
  const result = await new Promise(resolve => f.message({ type: 'CONTROL_SOURCE', action: 'next', hold: true, expectedTrack: oldTrack }, { id: 'a'.repeat(32) }, resolve));
  assert.equal(result.ok, true); assert.equal(result.track.state, 'paused'); assert.equal(options.hold, true); assert.equal(options.expectedTrack, oldTrack);
});
function probeHarness({ media = [], scoped = [], hostname = 'music.youtube.com', playbackState = 'playing' } = {}) {
  const published = [], intervals = [], listeners = new Map();
  const session = { metadata: { title: 'Song', artist: 'Artist' }, playbackState };
  const ctx = vm.createContext({ window: {}, location: { hostname }, navigator: { mediaSession: session }, document: { querySelectorAll: selector => selector === 'audio, video' ? media : scoped, addEventListener: (name, callback) => listeners.set(name, callback), dispatchEvent: event => published.push(JSON.parse(event.detail)) }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, setInterval: callback => intervals.push(callback) });
  vm.runInContext(probeCode, ctx); return { published, intervals, listeners, session };
}
test('loaded paused browser media retains position and duration and overrides stale playing state', () => {
  const media = { readyState: 1, paused: true, ended: false, duration: 210, currentTime: 17.25 };
  const f = probeHarness({ media: [media] });
  assert.equal(f.published.at(-1).state, 'paused'); assert.equal(f.published.at(-1).durationMs, 210000); assert.equal(f.published.at(-1).positionMs, 17250);
});
test('native pause, resume and natural end preserve the selected media clock', () => {
  const media = { readyState: 4, paused: false, ended: false, duration: 210, currentTime: 17.25 };
  const f = probeHarness({ media: [media], playbackState: 'paused' });
  assert.equal(f.published.at(-1).state, 'playing');
  media.paused = true; f.session.playbackState = 'playing'; f.listeners.get('pause')();
  assert.equal(f.published.at(-1).state, 'paused'); assert.equal(f.published.at(-1).positionMs, 17250); assert.equal(f.published.at(-1).durationMs, 210000);
  media.paused = false; f.session.playbackState = 'paused'; f.listeners.get('play')(); assert.equal(f.published.at(-1).state, 'playing');
  media.ended = true; media.currentTime = 210; f.listeners.get('ended')();
  assert.equal(f.published.at(-1).state, 'paused'); assert.equal(f.published.at(-1).positionMs, 210000); assert.equal(f.published.at(-1).durationMs, 210000);
});
test('a scoped paused song never borrows an unrelated playing preview clock', () => {
  const song = { readyState: 2, paused: true, ended: false, duration: 210, currentTime: 5 };
  const preview = { readyState: 4, paused: false, ended: false, duration: 30, currentTime: 22 };
  const f = probeHarness({ media: [song, preview], scoped: [song] });
  assert.equal(f.published.at(-1).state, 'paused'); assert.equal(f.published.at(-1).durationMs, 210000); assert.equal(f.published.at(-1).positionMs, 5000);
});
test('ambiguous unscoped media and unloaded player do not invent a current clock', () => {
  const song = { readyState: 2, paused: true, ended: false, duration: 210, currentTime: 5 };
  const preview = { readyState: 4, paused: false, ended: false, duration: 30, currentTime: 22 };
  for (const options of [{ media: [song, preview] }, { media: [preview], scoped: [{ ...song, readyState: 0 }] }]) {
    const f = probeHarness(options); const payload = f.published.at(-1);
    assert.equal(payload.durationMs, undefined); assert.equal(payload.positionMs, undefined);
  }
});


test('fresh native state keeps Play and Pause idempotent even when the button label lags', () => {
  const paused = player({ label: 'Pause' });
  assert.equal(control(paused.document, url, 'pause', 'paused').clicked, false); assert.deepEqual(paused.calls, []);
  const playing = player({ label: 'Play' });
  assert.equal(control(playing.document, url, 'play', 'playing').clicked, false); assert.deepEqual(playing.calls, []);
});


test('missing source artist can be held and resumed when a reliable recording ID anchors the selection', async () => {
  const cases = [
    { source: 'youtube-music', trackId: 'abcdefghijk' },
    { source: 'spotify', trackId: '1234567890123456789012' },
    { source: 'apple-music', trackId: '1468058173' }
  ];
  for (const provider of cases) for (const action of ['pause', 'play']) {
    let time = 0, changed = false; const calls = [];
    const expectedTrack = { ...oldTrack, ...provider, artist: '' };
    const initialState = action === 'pause' ? 'playing' : 'paused', desiredState = action === 'pause' ? 'paused' : 'playing';
    const result = await run(action, {
      expectedTrack,
      read: () => ({ ...expectedTrack, artist: time > 0 ? 'Artist filled in later' : '', state: changed ? desiredState : initialState }),
      control: command => { calls.push(command); changed = true; return { ok: true }; },
      now: () => time, wait: async ms => { time += ms; }, settleMs: 300, timeoutMs: 1500
    });
    assert.equal(result.ok, true, provider.source + ' ' + action); assert.equal(result.track.state, desiredState);
    assert.equal(result.track.artist, 'Artist filled in later'); assert.deepEqual(calls, [action]);
  }
});
test('a filled artist before the native click still matches an originally incomplete source recording', async () => {
  let reads = 0, time = 0; const calls = [];
  const expectedTrack = { ...oldTrack, artist: '' };
  const result = await run('pause', {
    expectedTrack, read: () => ++reads === 1 ? expectedTrack : { ...oldTrack, state: 'paused' },
    control: action => { calls.push(action); return { ok: true }; }, now: () => time, wait: async ms => { time += ms; }, settleMs: 300, timeoutMs: 1200
  });
  assert.equal(result.ok, true); assert.equal(result.track.artist, 'Artist'); assert.deepEqual(calls, ['pause']);
});
test('missing-artist expectations never fall back to a title-only match or a malformed provider ID', async () => {
  const invalid = [
    { source: 'youtube-music', trackId: '' }, { source: 'youtube-music', trackId: 'short' },
    { source: 'spotify', trackId: 'abcdefghijk' }, { source: 'apple-music', trackId: 'non-numeric' }
  ];
  for (const provider of invalid) {
    const expectedTrack = { ...oldTrack, ...provider, artist: '' };
    const result = await run('play', { expectedTrack, read: () => expectedTrack, control: () => { throw new Error('must not click'); } });
    assert.equal(result.ok, false);
  }
  for (const changed of [{ trackId: 'lmnopqrstuv' }, { source: 'spotify', trackId: '1234567890123456789012' }, { title: 'A different song' }]) {
    const expectedTrack = { ...oldTrack, artist: '' };
    const result = await run('play', { expectedTrack, read: () => ({ ...oldTrack, ...changed }), control: () => { throw new Error('must not click'); } });
    assert.equal(result.ok, false); assert.equal(result.stale, true);
  }
});
test('a different recording appearing after an incomplete source was paused cannot confirm or resume it', async () => {
  let time = 0; const calls = [];
  const expectedTrack = { ...oldTrack, artist: '' };
  const result = await run('pause', {
    expectedTrack, read: () => time < 150 ? expectedTrack : { ...oldTrack, trackId: 'lmnopqrstuv', state: 'paused' },
    control: action => { calls.push(action); return { ok: true }; }, now: () => time, wait: async ms => { time += ms; }, settleMs: 300, timeoutMs: 1200
  });
  assert.equal(result.stale, true); assert.equal(result.track, undefined); assert.deepEqual(calls, ['pause']);
});
