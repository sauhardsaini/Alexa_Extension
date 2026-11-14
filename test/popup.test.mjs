import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);

// A small DOM/runtime boundary keeps these checks focused on user interactions.
// Browser rendering and real Echo requests are verified separately.
class Element {
  constructor() {
    this.value = ''; this.dataset = {}; this.options = []; this.listeners = new Map();
    this.span = {}; this.attributes = {}; this.disabled = false; this.hidden = false;
  }
  addEventListener(name, listener) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
  }
  querySelector() { return this.span; }
  replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

async function fixture() {
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  elements['country-select'].options = [{ value: 'IN' }];
  elements['echo-volume'].value = '0'; elements['echo-seek'].value = '0';
  const state = {
    ok: true, paired: true, supported: true, tabId: 1, sourceControlsAvailable: true,
    track: { source: 'youtube-music', title: 'Ocean', artist: 'Singer', confidence: 'high', state: 'playing' },
    helper: {
      connected: true, devices: [{ id: 'echo', name: 'My Echo' }], providers: [],
      player: { deviceId: 'echo', title: 'Ocean', artist: 'Singer', state: 'PLAYING', positionMs: 9000, durationMs: 180000, volume: 0 }
    },
    settings: { deviceId: 'echo', providerId: 'apple-music', country: 'IN' },
    follow: { enabled: true, tabId: 1 }, error: ''
  };
  const calls = [];
  let interval, messageHandler = null;
  const flush = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setImmediate(resolve)); };
  const context = {
    document: { getElementById: id => elements[id], visibilityState: 'visible', addEventListener() {} },
    window: { addEventListener() {} },
    Option: class { constructor(name, value) { this.textContent = name; this.value = value; } },
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          calls.push(JSON.parse(JSON.stringify(message)));
          if (messageHandler?.(message, callback) === true) return;
          callback(message.type === 'GET_POPUP_STATE' ? structuredClone(state) : { ok: true, message: 'Control submitted.' });
        }
      }
    },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval(callback) { interval = callback; return 1; }, clearInterval() {}
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  await flush();
  return {
    elements, state, calls, flush,
    onMessage(handler) { messageHandler = handler; },
    controls: () => calls.filter(call => call.type === 'CONTROL'),
    async poll() { interval(); await flush(); },
    async fire(id, name, event = {}) {
      for (const listener of elements[id].listeners.get(name) || []) await listener(event);
      await flush();
    }
  };
}

test('Echo sliders show reported values, including zero volume, and disable missing measurements', async () => {
  const f = await fixture(), e = f.elements;
  assert.equal(e['echo-position'].textContent, '0:09');
  assert.equal(e['echo-duration'].textContent, '3:00');
  assert.equal(e['echo-volume-value'].textContent, '0%');
  assert.equal(e['echo-volume'].disabled, false);
  f.state.helper.player = null; await f.poll();
  assert.equal(e['echo-seek'].disabled, true);
  assert.equal(e['echo-volume'].disabled, true);
  assert.equal(e['echo-position'].textContent, '—');
  assert.equal(e['echo-volume-value'].textContent, '—');
  f.state.helper.player = { title: 'Ocean', artist: 'Singer', positionMs: 10000, durationMs: null, volume: null }; await f.poll();
  assert.equal(e['echo-seek'].disabled, true);
  assert.match(e['echo-seek-note'].textContent, /not reported the song duration/);
  assert.equal(e['echo-volume'].disabled, true);
  assert.equal(e['echo-volume-value'].textContent, '—');
});

test('seek drag survives polling and sends one committed request for the displayed Echo song', async () => {
  const f = await fixture(), e = f.elements;
  await f.fire('echo-seek', 'pointerdown');
  e['echo-seek'].value = '45000'; await f.fire('echo-seek', 'input');
  e['echo-seek'].value = '46000'; await f.fire('echo-seek', 'input');
  assert.equal(f.controls().length, 0, 'dragging must not spam Echo commands');
  f.state.helper.player.positionMs = 12000; await f.poll();
  assert.equal(e['echo-seek'].value, '46000', 'polling must preserve the drag preview');
  await f.fire('echo-seek', 'change');
  await f.fire('echo-seek', 'blur');
  assert.deepEqual(f.controls(), [{ type: 'CONTROL', action: 'seek', positionMs: 46000, expectedTrack: { title: 'Ocean', artist: 'Singer' } }]);
  assert.equal(f.calls.some(call => call.type === 'SET_FOLLOW'), false);
  assert.equal(f.state.follow.enabled, true);
});

test('seek range ends strictly before the recording finishes', async () => {
  const f = await fixture(), e = f.elements;
  assert.equal(e['echo-seek'].max, '179000', 'an exact three-minute recording must not offer its ending position');
  await f.fire('echo-seek', 'pointerdown');
  e['echo-seek'].value = '180000'; await f.fire('echo-seek', 'input'); await f.fire('echo-seek', 'change');
  assert.equal(f.controls().length, 0, 'a stale or forged ending position must not reach the helper');
  f.state.helper.player.durationMs = 180001; await f.poll();
  assert.equal(e['echo-seek'].max, '180000', 'a partial final second remains inside this recording');
  await f.fire('echo-seek', 'pointerdown');
  e['echo-seek'].value = '180000'; await f.fire('echo-seek', 'input'); await f.fire('echo-seek', 'change');
  assert.equal(f.controls().at(-1).positionMs, 180000);
});

test('a song or speaker change during a seek drag prevents an old seek request', async () => {
  for (const change of ['song', 'speaker']) {
    const f = await fixture(), e = f.elements;
    await f.fire('echo-seek', 'pointerdown');
    e['echo-seek'].value = '60000'; await f.fire('echo-seek', 'input');
    if (change === 'song') f.state.helper.player.title = 'Another song';
    else {
      f.state.settings.deviceId = 'other-echo';
      f.state.helper.devices.push({ id: 'other-echo', name: 'Other Echo' });
      f.state.helper.player.deviceId = 'other-echo';
    }
    await f.poll(); await f.fire('echo-seek', 'change');
    assert.equal(f.controls().length, 0);
    assert.match(e['result-message'].textContent, /playback changed/);
  }
});

test('keyboard volume changes wait for key release and polling preserves the chosen value', async () => {
  const f = await fixture(), e = f.elements;
  await f.fire('echo-volume', 'keydown', { key: 'ArrowRight' });
  e['echo-volume'].value = '54'; await f.fire('echo-volume', 'input'); await f.fire('echo-volume', 'change');
  e['echo-volume'].value = '55'; await f.fire('echo-volume', 'input'); await f.fire('echo-volume', 'change');
  assert.equal(f.controls().length, 0, 'held arrow keys should not send a command for every repeat');
  f.state.helper.player.volume = 20; await f.poll();
  assert.equal(e['echo-volume'].value, '55');
  await f.fire('echo-volume', 'keyup', { key: 'ArrowRight' });
  await f.fire('echo-volume', 'blur');
  assert.deepEqual(f.controls(), [{ type: 'CONTROL', action: 'volume', volume: 55 }]);
  assert.equal(f.calls.some(call => call.type === 'SET_FOLLOW'), false);
});

test('transport controls send Play, Pause and source Next while unavailable source Next stays disabled', async () => {
  const f = await fixture(), e = f.elements;
  for (const id of ['resume-button', 'pause-button', 'next-button']) await f.fire(id, 'click');
  assert.deepEqual(f.controls().map(call => call.action), ['play', 'pause', 'next']);
  assert.equal(f.calls.some(call => call.type === 'SET_FOLLOW'), false);
  f.state.sourceControlsAvailable = false; await f.poll();
  assert.equal(e['next-button'].disabled, true);
  assert.equal(e['resume-button'].disabled, false);
  assert.equal(e['pause-button'].disabled, false);
  await f.fire('next-button', 'click');
  assert.equal(f.controls().length, 3);
});

test('active seek and newer control results are visible above a cancelled song job', async () => {
  const f = await fixture(), e = f.elements;
  f.state.helper.job = { id: 'old', state: 'cancelled', message: 'Song checking cancelled.', updatedAt: 100 };
  f.state.helper.seek = { id: 'seek', state: 'checking', message: 'Checking the new Echo position.', updatedAt: 100 };
  await f.poll(); assert.equal(e['result-message'].textContent, 'Checking the new Echo position.');
  f.state.helper.seek = { ...f.state.helper.seek, state: 'matched', message: 'Echo position confirmed.', updatedAt: 110 };
  await f.poll(); assert.equal(e['result-message'].textContent, 'Echo position confirmed.');
  f.state.lastResult = { ok: true, message: 'Volume request sent.', updatedAt: 120 };
  await f.poll(); assert.equal(e['result-message'].textContent, 'Volume request sent.');
});

test('unpaired setup distinguishes Amazon sign-in, keeps real failures visible, and clears recovered state errors', async () => {
  const f = await fixture(), e = f.elements;
  f.state.paired = false; f.state.helper = { connected: false }; f.state.error = 'The local helper could not be reached.';
  await f.poll();
  assert.equal(e['amazon-setup-title'].textContent, 'Finish extension setup');
  assert.equal(e['connect-amazon-button'].textContent, 'Open setup ↗');
  assert.match(e['amazon-setup-note'].textContent, /sign-in and browser pairing are separate/);
  assert.equal(e['pairing-section'].open, true);
  assert.equal(e['result-message'].textContent, f.state.error);
  await f.fire('connect-amazon-button', 'click');
  assert.ok(f.calls.some(call => call.type === 'OPEN_HELPER'));
  f.state.error = ''; await f.poll();
  assert.equal(e['result-message'].hidden, true);
});


test('Follow can be enabled on a paired supported tab before song details settle', async () => {
  for (const metadata of ['empty', 'review', 'ad']) {
    const f = await fixture(), e = f.elements;
    f.state.follow = { enabled: false };
    if (metadata === 'empty') f.state.track = null;
    else if (metadata === 'review') f.state.track.confidence = 'review';
    else f.state.track.isAd = true;
    await f.poll();
    assert.equal(e['follow-toggle'].disabled, false, 'startup metadata must not prevent enabling Follow: ' + metadata);
    assert.match(e['follow-note'].textContent, /enable following now/);
    e['follow-toggle'].checked = true; await f.fire('follow-toggle', 'change');
    assert.ok(f.calls.some(call => call.type === 'SET_FOLLOW' && call.enabled === true));
    assert.equal(f.calls.some(call => call.type === 'PLAY_TRACK'), false, 'enabling Follow is separate from forcing an uncertain song request');
  }
});

test('new Follow remains disabled for unsupported tabs, unpaired browsers and offline helpers', async () => {
  for (const unavailable of ['unsupported', 'unpaired', 'offline']) {
    const f = await fixture(), e = f.elements;
    f.state.follow = { enabled: false };
    if (unavailable === 'unsupported') f.state.supported = false;
    else if (unavailable === 'unpaired') f.state.paired = false;
    else f.state.helper.connected = false;
    await f.poll(); assert.equal(e['follow-toggle'].disabled, true, unavailable);
  }
});

test('enabled Follow explains why it is waiting for metadata, ads or browser playback', async () => {
  const f = await fixture(), e = f.elements;
  f.state.track = null; await f.poll(); assert.match(e['follow-note'].textContent, /Waiting for reliable song details/);
  f.state.track = { source: 'youtube-music', title: 'Ocean', artist: 'Singer', confidence: 'review', state: 'playing' };
  await f.poll(); assert.match(e['follow-note'].textContent, /Waiting for reliable song details/);
  f.state.track = { ...f.state.track, confidence: 'high', isAd: true };
  await f.poll(); assert.match(e['follow-note'].textContent, /advertisement/);
  f.state.track = { ...f.state.track, isAd: false, state: 'paused' };
  await f.poll(); assert.match(e['follow-note'].textContent, /Play the browser/);
  assert.equal(e['follow-toggle'].disabled, false, 'the active Follow switch must remain stoppable while waiting');
});

test('an unavailable source reader shows a real tab reload action and disables its Next control', async () => {
  const f = await fixture(), e = f.elements;
  f.state.track = null; f.state.controlTabId = f.state.tabId;
  f.state.sourceStatus = { state: 'unavailable', message: 'The music page reader did not respond.' };
  await f.poll();
  assert.equal(e['source-reader-warning'].hidden, false);
  assert.equal(e['source-reader-message'].textContent, 'The music page reader did not respond.');
  assert.match(html, /Reload this music webpage after updating Echo Companion/);
  assert.equal(e['next-button'].disabled, true);
  assert.equal(e['follow-toggle'].disabled, false, 'following can wait for the reader to reconnect');
  assert.match(e['follow-note'].textContent, /Reload this music webpage/);
  await f.fire('reload-source-button', 'click');
  assert.ok(f.calls.some(call => call.type === 'RELOAD_SOURCE'));
  assert.equal(f.controls().length, 0, 'reloading the reader must not send an Echo command');
  f.state.sourceStatus = { state: 'ready', message: '' }; await f.poll();
  assert.equal(e['source-reader-warning'].hidden, true);
});

test('an unavailable active page does not disable controls for a different followed music tab', async () => {
  const f = await fixture(), e = f.elements;
  f.state.controlTabId = 9; f.state.follow.tabId = 9;
  f.state.sourceStatus = { state: 'unavailable', message: 'Reload this music page.' };
  await f.poll();
  assert.equal(e['next-button'].disabled, false, 'the controller has separately confirmed the followed tab is ready');
});


test('featured credits appear with the artist while the bare title and primary request artist stay intact', async () => {
  const f = await fixture(), e = f.elements;
  const main = 'Aneesh, Krtin Kay & Kunnu';
  f.state.track = {
    ...f.state.track, title: 'BANNI', artist: main,
    artistNames: ['Aneesh', 'Krtin Kay', 'Kunnu', 'Gargei Lavekar'],
    featuredArtists: ['Gargei Lavekar']
  };
  await f.poll();
  assert.equal(e['track-title'].textContent, 'BANNI');
  assert.equal(e['track-artist'].textContent, main + ' (feat. Gargei Lavekar)');
  assert.equal(e['song-title'].value, 'BANNI');
  assert.equal(e['song-artist'].value, main);
  assert.equal(e['song-featured-credit'].hidden, false);
  assert.equal(e['song-featured-credit'].textContent, 'Featuring Gargei Lavekar');
  await f.fire('play-button', 'click');
  const play = f.calls.find(call => call.type === 'PLAY_TRACK');
  assert.equal(play.track.title, 'BANNI');
  assert.equal(play.track.artist, main);
  assert.deepEqual(play.track.artistNames, ['Aneesh', 'Krtin Kay', 'Kunnu', 'Gargei Lavekar']);
  assert.deepEqual(play.track.featuredArtists, ['Gargei Lavekar']);
  e['song-artist'].value = 'Edited artist'; await f.fire('song-artist', 'input');
  assert.equal(e['song-featured-credit'].hidden, true, 'old source credits must not be presented as part of an edited request');
});


test('custom Alexa commands work without a music tab and preserve their exact wording', async () => {
  const f = await fixture(), e = f.elements;
  f.state.supported = false; f.state.track = null; f.state.follow = { enabled: false }; await f.poll();
  assert.equal(e['custom-command-send'].disabled, true);
  e['custom-command-input'].value = '  What is two plus two?  '; await f.fire('custom-command-input', 'input');
  assert.equal(e['custom-command-send'].disabled, false);
  await f.fire('custom-command-form', 'submit', { preventDefault() {} });
  assert.deepEqual(f.calls.find(call => call.type === 'CUSTOM_COMMAND'), { type: 'CUSTOM_COMMAND', text: 'What is two plus two?' });
  assert.equal(f.calls.some(call => call.type === 'PLAY_TRACK'), false);
  assert.equal(e['custom-command-input'].value, '');
  assert.equal(e['custom-command-text'].textContent, 'What is two plus two?');
  assert.equal(e['custom-command-result'].hidden, false);
  assert.equal(e['custom-command-response'].textContent, 'Waiting for Alexa response…');
});

test('custom commands reject multiline and oversized text and require a paired Echo connection', async () => {
  for (const text of ['line one\nline two', 'line one\u2028line two', 'x'.repeat(501)]) {
    const f = await fixture(), e = f.elements;
    e['custom-command-input'].value = text; await f.fire('custom-command-input', 'input');
    assert.equal(e['custom-command-send'].disabled, true);
    await f.fire('custom-command-form', 'submit', { preventDefault() {} });
    assert.equal(f.calls.some(call => call.type === 'CUSTOM_COMMAND'), false);
  }
  const f = await fixture(), e = f.elements;
  e['custom-command-input'].value = 'Tell me a joke'; await f.fire('custom-command-input', 'input');
  f.state.helper.connected = false; await f.poll();
  assert.equal(e['custom-command-send'].disabled, true);
  f.state.helper.connected = true; f.state.paired = false; await f.poll();
  assert.equal(e['custom-command-send'].disabled, true);
});

test('custom request responses come only from matched selected-Echo custom journal entries', async () => {
  const f = await fixture(), e = f.elements;
  const command = { id: 'custom', kind: 'custom', deviceId: 'echo', text: 'What is two plus two?', createdAt: 100, status: 'sent', message: 'Alexa accepted the request.', responseStatus: 'pending', response: 'This unconfirmed text must not be shown.' };
  f.state.helper.commands = [
    { ...command, id: 'other-device', deviceId: 'other-echo', createdAt: 300, responseStatus: 'available', response: 'Wrong Echo response' },
    { ...command, id: 'music', kind: 'music', createdAt: 200, responseStatus: 'available', response: 'Wrong music response' },
    command
  ];
  await f.poll();
  assert.equal(e['custom-command-text'].textContent, command.text);
  assert.equal(e['custom-command-status'].textContent, 'Alexa accepted the request.');
  assert.equal(e['custom-command-response'].textContent, 'Waiting for Alexa response…');
  command.responseStatus = 'unavailable'; await f.poll();
  assert.equal(e['custom-command-response'].textContent, 'Alexa response unavailable.');
  command.responseStatus = 'available'; command.response = '<b>2 plus 2 is 4</b>'; await f.poll();
  assert.equal(e['custom-command-response'].textContent, '<b>2 plus 2 is 4</b>', 'transcripts are rendered as text');
  f.state.helper.commands = []; await f.poll();
  assert.equal(e['custom-command-result'].hidden, true, 'responses from another Echo or music request must never be substituted');
});

test('Echo-first waiting is shown as an intentional browser hold and keeps Next available', async () => {
  const f = await fixture(), e = f.elements;
  f.state.track.state = 'paused';
  f.state.helper.job = { id: 'old', state: 'cancelled', message: 'An old song check was cancelled.', updatedAt: 100 };
  f.state.handoff = { phase: 'waiting', message: 'Waiting for Echo to confirm BANNI.', trackTitle: 'BANNI' };
  await f.poll();
  assert.equal(e['handoff-status'].hidden, false);
  assert.equal(e['handoff-heading'].textContent, 'Waiting for your Echo');
  assert.equal(e['handoff-song'].textContent, 'BANNI');
  assert.equal(e['handoff-message'].textContent, 'Waiting for Echo to confirm BANNI.');
  assert.match(e['follow-note'].textContent, /intentionally held/);
  assert.match(e['track-note'].textContent, /intentionally held/);
  assert.equal(e['result-message'].hidden, true, 'an old cancellation must not mask the active handoff');
  assert.equal(e['next-button'].disabled, false, 'a newer source choice can supersede this handoff');
  assert.equal(e['cancel-handoff-button'].disabled, false);
});

test('Cancel handoff bypasses an outstanding popup action and suppresses its late success message', async () => {
  const f = await fixture(), e = f.elements;
  f.state.handoff = { phase: 'waiting', message: 'Waiting for Echo.', trackTitle: 'Ocean' }; await f.poll();
  let release;
  f.onMessage((message, callback) => {
    if (message.type === 'PLAY_TRACK') { release = callback; return true; }
    if (message.type === 'SET_FOLLOW' && message.enabled === false) { f.state.follow = { enabled: false }; f.state.handoff = null; }
    return false;
  });
  await f.fire('play-button', 'click');
  assert.equal(typeof release, 'function');
  assert.equal(e['follow-toggle'].disabled, false, 'Stop Follow must remain available while a popup request waits');
  assert.equal(e['cancel-handoff-button'].disabled, false);
  await f.fire('cancel-handoff-button', 'click');
  assert.ok(f.calls.some(call => call.type === 'SET_FOLLOW' && call.enabled === false));
  assert.equal(e['handoff-status'].hidden, true);
  release({ ok: true, message: 'Old request accepted after cancellation.' }); await f.flush();
  assert.notEqual(e['result-message'].textContent, 'Old request accepted after cancellation.');
  assert.equal(f.state.follow.enabled, false);
});

test('manual handoffs remain cancellable when Follow is off or a different page is active', async () => {
  const f = await fixture(), e = f.elements;
  f.state.supported = false; f.state.follow = { enabled: false };
  f.state.handoff = { phase: 'requesting', trackTitle: 'Ocean' }; await f.poll();
  assert.equal(e['cancel-handoff-button'].hidden, false);
  assert.equal(e['cancel-handoff-button'].disabled, false);
  await f.fire('cancel-handoff-button', 'click');
  assert.ok(f.calls.some(call => call.type === 'SET_FOLLOW' && call.enabled === false));
});


test('seek is held during an Echo-first handoff while volume remains available', async () => {
  const f = await fixture(), e = f.elements;
  await f.fire('echo-seek', 'pointerdown');
  e['echo-seek'].value = '45000'; await f.fire('echo-seek', 'input');
  f.state.handoff = { phase: 'waiting', message: 'Waiting for Echo.' }; await f.poll();
  assert.equal(e['echo-seek'].disabled, true);
  assert.match(e['echo-seek-note'].textContent, /confirmed on Echo before seeking/);
  assert.equal(e['echo-volume'].disabled, false);
  await f.fire('echo-seek', 'change');
  assert.equal(f.controls().length, 0, 'a seek begun before the handoff must not commit during it');
  f.state.handoff = null; await f.poll();
  assert.equal(e['echo-seek'].disabled, false);
});


test('quiet checking displays its 1% verification level and saved playback target and accepts a zero restoration target', async () => {
  const f = await fixture(), e = f.elements;
  f.state.helper.job = { id: 'song-job', deviceId: 'echo', state: 'checking', quietSearch: { active: true, phase: 'muted', checkVolume: 1, restoreVolume: 37 } };
  f.state.helper.player.volume = 1;
  await f.poll();
  assert.equal(e['echo-quiet-status'].hidden, false);
  assert.match(e['echo-quiet-heading'].textContent, /very quietly at 1%/);
  assert.match(e['echo-quiet-message'].textContent, /may still be audible/);
  assert.equal(e['echo-volume-label'].textContent, 'Volume after song confirmation');
  assert.equal(e['echo-volume-value'].textContent, '37%');
  assert.equal(e['echo-volume'].value, '37', 'the temporary verification level must not replace the saved target');
  assert.match(e['echo-volume-note'].textContent, /keeps checking at 1%/);
  assert.equal(e['echo-seek'].disabled, true, 'candidate playback must not be seekable even without an extension handoff');
  await f.fire('echo-volume', 'pointerdown');
  e['echo-volume'].value = '38'; await f.fire('echo-volume', 'input');
  f.state.helper.job.quietSearch.restoreVolume = 30; await f.poll();
  assert.equal(e['echo-volume'].value, '38', 'polling must preserve an in-progress target adjustment');
  f.onMessage((message, callback) => {
    if (message.type !== 'CONTROL') return false;
    f.state.helper.job.quietSearch.restoreVolume = message.volume;
    callback({ ok: true, quiet: true, volume: message.volume, message: 'Volume saved for after song confirmation.' });
    return true;
  });
  await f.fire('echo-volume', 'change');
  await f.fire('echo-volume', 'blur');
  assert.deepEqual(f.controls(), [{ type: 'CONTROL', action: 'volume', volume: 38 }]);
  assert.equal(e['echo-volume-value'].textContent, '38%');
  assert.equal(f.state.helper.player.volume, 1, 'adjusting the saved target must not change the reported verification level');
  await f.fire('echo-volume', 'pointerdown');
  e['echo-volume'].value = '0'; await f.fire('echo-volume', 'input');
  await f.fire('echo-volume', 'change');
  assert.deepEqual(f.controls(), [{ type: 'CONTROL', action: 'volume', volume: 38 }, { type: 'CONTROL', action: 'volume', volume: 0 }]);
  assert.equal(e['echo-volume-value'].textContent, '0%', 'zero is a valid desired volume after confirmation');
  assert.equal(e['echo-volume'].disabled, false);
  assert.equal(f.state.helper.player.volume, 1);
});

test('a selected-Echo quiet lease remains visible through cancellation, restoration and recovery', async () => {
  const f = await fixture(), e = f.elements;
  f.state.helper.job = { id: 'new-job', deviceId: 'another-echo', state: 'preparing' };
  f.state.helper.quietSearch = { jobId: 'old-job', deviceId: 'echo', active: true, phase: 'restoring', restoreVolume: 40, message: 'Waiting for the saved volume to be confirmed.' };
  f.state.helper.player = null;
  await f.poll();
  assert.equal(e['echo-quiet-status'].hidden, false, 'cleanup can outlive the current song job');
  assert.equal(e['echo-volume'].disabled, false, 'a known saved target is adjustable without a current player report');
  assert.equal(e['echo-volume'].value, '40');
  assert.match(e['echo-volume-note'].textContent, /confirm restoration/);
  f.state.helper.quietSearch = { ...f.state.helper.quietSearch, phase: 'failed', restoreVolume: null, message: 'Pause could not be confirmed. Check your Echo before restoring volume.' };
  await f.poll();
  assert.equal(e['echo-volume'].disabled, true);
  assert.equal(e['echo-volume-value'].textContent, '—');
  assert.equal(e['echo-quiet-message'].textContent, f.state.helper.quietSearch.message);
  assert.match(e['echo-quiet-heading'].textContent, /needs attention/);
  f.state.helper.quietSearch = { ...f.state.helper.quietSearch, active: false, phase: 'failed', restoreVolume: null };
  f.state.helper.player = { deviceId: 'echo', title: 'Ocean', artist: 'Singer', volume: 0 };
  await f.poll();
  assert.equal(e['echo-volume'].disabled, false, 'a released failed check must allow explicit recovery from a known actual zero volume');
  assert.equal(e['echo-volume-value'].textContent, '0%');
  assert.equal(e['echo-volume-label'].textContent, 'Echo volume');
  f.state.helper.quietSearch = { ...f.state.helper.quietSearch, active: false, phase: 'restored', restoreVolume: 40 };
  f.state.helper.player = { deviceId: 'echo', title: 'Ocean', artist: 'Singer', volume: 39 };
  await f.poll();
  assert.equal(e['echo-quiet-status'].hidden, true);
  assert.equal(e['echo-volume-label'].textContent, 'Echo volume');
  assert.equal(e['echo-volume-value'].textContent, '39%', 'after restoration the actual reported volume is authoritative');
  f.state.helper.quietSearch = { deviceId: 'another-echo', active: true, phase: 'muted', restoreVolume: 90 };
  await f.poll();
  assert.equal(e['echo-quiet-status'].hidden, true, 'another speaker’s quiet lease must not replace this speaker’s volume');
  assert.equal(e['echo-volume-value'].textContent, '39%');
});
