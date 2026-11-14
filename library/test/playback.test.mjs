import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackCoordinator } from '../playback.mjs';
import { buildMusicCommand } from '../catalog.mjs';

const track = { id: 'track1', title: 'OBVIOUS (feat. Hasan Raheem)', artist: 'Umair', requestArtist: 'Umair', durationMs: 195000 };
const wrong = { state: 'PLAYING', title: 'Other Song', artist: 'Other Artist' };
const right = { state: 'PLAYING', title: 'OBVIOUS (feat. Hasan Raheem)', artist: 'Umair', durationMs: 195000 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup({ observe, play, preferences, sleep, artistResolver } = {}) {
  let time = 1000;
  const sent = [], sentProviders = [], controls = [], saves = [];
  const bridge = {
    requireDevice(id) { if (id !== 'echo1') throw new Error('invalid device'); },
    async freshPlayer() { return { player: observe ? await observe(sent) : sent.length ? right : wrong }; },
    async play(candidate, deviceId, providerId) { sent.push(candidate.requestArtist); sentProviders.push(providerId); if (play) await play(candidate, deviceId, providerId); return { status: 'sent' }; },
    async control(id, action) { controls.push(action); return { status: 'sent' }; },
  };
  const prefs = preferences || { apply: value => value, set: (...values) => saves.push(values) };
  const coordinator = new PlaybackCoordinator({ bridge, artistPreferences: prefs, artistResolver, clock: () => time, sleep: sleep || (async ms => { time += ms; }), pollMs: 10, graceMs: 30, attemptMs: 60, commandGapMs: 0 });
  const begin = (value = track, providerId = 'alexa-default') => {
    const reservation = coordinator.reserve({ deviceId: 'echo1', country: 'IN', trackHint: value, providerId });
    const response = coordinator.start(reservation, value);
    return { reservation, response };
  };
  return { coordinator, sent, sentProviders, controls, saves, begin };
}

test('checks primary, retries featured artist, confirms two fresh readings and learns original recording identity', async () => {
  const context = setup({ observe: sent => sent.at(-1) === 'Hasan Raheem' ? right : wrong });
  const { reservation, response } = context.begin();
  assert.equal(response.status, 'sent');
  assert.equal(response.playback.active, true);
  await reservation.task;
  assert.deepEqual(context.sent, ['Umair', 'Hasan Raheem']);
  assert.equal(context.coordinator.status().state, 'matched');
  assert.equal(context.saves.length, 1);
  assert.equal(context.saves[0][0].requestArtist, 'Umair');
  assert.equal(context.saves[0][1], 'IN');
  assert.equal(context.saves[0][2], 'Hasan Raheem');
});

test('correct first attempt stops without another command', async () => {
  const context = setup();
  const { reservation } = context.begin();
  await reservation.task;
  assert.deepEqual(context.sent, ['Umair']);
  assert.equal(context.coordinator.status().state, 'matched');
});

test('learned artist is tried first and attempts stay bounded', async () => {
  const context = setup({ preferences: { apply: value => ({ ...value, requestArtist: 'Known Artist' }), set() {} }, observe: () => wrong });
  const { reservation } = context.begin({ ...track, requestArtists: ['Another Artist', 'Fourth Artist'] });
  await reservation.task;
  assert.deepEqual(context.sent, ['Known Artist', 'Umair', 'Hasan Raheem']);
  assert.equal(context.coordinator.status().state, 'unmatched');
});

test('unknown or incomplete playing metadata never causes blind retries', async () => {
  for (const player of [{ state: 'UNKNOWN' }, { state: 'PLAYING', title: 'OBVIOUS', artist: '' }]) {
    const context = setup({ observe: () => player });
    const { reservation } = context.begin();
    await reservation.task;
    assert.deepEqual(context.sent, ['Umair']);
    assert.equal(context.coordinator.status().state, 'unverified');
    assert.equal(context.saves.length, 0);
  }
});

test('one matching reading does not confirm or learn', async () => {
  let reads = 0;
  const context = setup({ observe: () => (++reads % 2 === 0 ? right : { state: 'UNKNOWN' }) });
  const { reservation } = context.begin();
  await reservation.task;
  assert.equal(context.coordinator.status().state, 'unverified');
  assert.equal(context.saves.length, 0);
});

test('paused Echo ends checking without restarting playback', async () => {
  const context = setup({ observe: sent => sent.length ? ({ state: 'PAUSED', title: 'Other Song', artist: 'Other Artist' }) : wrong });
  const { reservation } = context.begin();
  await reservation.task;
  assert.deepEqual(context.sent, ['Umair']);
  assert.equal(context.coordinator.status().state, 'cancelled');
});

test('transport failure stops attempts since accepted cloud execution is uncertain', async () => {
  const context = setup({ play: () => { throw new Error('upstream secret timeout'); } });
  const { reservation } = context.begin();
  await reservation.task;
  assert.deepEqual(context.sent, ['Umair']);
  assert.equal(context.coordinator.status().state, 'unverified');
  assert.equal(JSON.stringify(context.coordinator.status()).includes('secret'), false);
});

test('already matching baseline cannot teach a new artist alias', async () => {
  const context = setup({ observe: () => right });
  const { reservation } = context.begin();
  await reservation.task;
  assert.equal(context.coordinator.status().state, 'matched');
  assert.equal(context.saves.length, 0);
});

test('cancelled or superseded preparation cannot send a command', async () => {
  const context = setup();
  const first = context.coordinator.reserve({ deviceId: 'echo1', country: 'IN', trackHint: track });
  context.coordinator.cancel();
  assert.throws(() => context.coordinator.start(first, track), { code: 'PLAYBACK_CHANGED' });
  context.begin();
  assert.throws(() => context.coordinator.start(first, track), { code: 'PLAYBACK_CHANGED' });
  await context.coordinator.current.task;
  assert.deepEqual(context.sent, ['Umair']);
});

test('new song supersedes blocked observation and a stale targeted cancel leaves it active', async () => {
  const block = deferred();
  let reads = 0;
  const context = setup({ observe: async sent => ++reads === 1 ? block.promise : sent.length ? right : wrong });
  const first = context.begin();
  await Promise.resolve();
  const second = context.begin();
  context.coordinator.cancel('stale cancel', first.reservation.id);
  assert.equal(context.coordinator.status().id, second.reservation.id);
  assert.equal(context.coordinator.status().active, true);
  block.resolve(wrong);
  await Promise.all([first.reservation.task, second.reservation.task]);
  assert.deepEqual(context.sent, ['Umair']);
  assert.equal(context.coordinator.status().state, 'matched');
});

test('a pause during in-flight submission is ordered after it and suppresses all retries', async () => {
  const block = deferred(), entered = deferred();
  const context = setup({ play: async () => { entered.resolve(); await block.promise; } });
  const { reservation } = context.begin();
  await entered.promise;
  const control = context.coordinator.control('echo1', 'pause');
  assert.deepEqual(context.controls, []);
  block.resolve();
  await Promise.all([reservation.task, control]);
  assert.deepEqual(context.sent, ['Umair']);
  assert.deepEqual(context.controls, ['pause']);
  assert.equal(context.coordinator.status().state, 'cancelled');
  assert.equal(context.saves.length, 0);
});

test('new selection waits for prior in-flight submission without overlap', async () => {
  const block = deferred(), entered = deferred();
  let pending = 0, peak = 0;
  const context = setup({ play: async () => { peak = Math.max(peak, ++pending); if (context.sent.length === 1) { entered.resolve(); await block.promise; } --pending; } });
  const first = context.begin();
  await entered.promise;
  const second = context.begin();
  block.resolve();
  await Promise.all([first.reservation.task, second.reservation.task]);
  assert.deepEqual(context.sent, ['Umair', 'Umair']);
  assert.equal(peak, 1);
  assert.equal(context.saves.length, 0, 'baseline already matched for second choice');
});

test('changing matching media identifiers needs two stable readings', async () => {
  let reads = 0;
  const context = setup({ observe: sent => sent.length ? { ...right, mediaId: String(++reads) } : wrong });
  const { reservation } = context.begin();
  await reservation.task;
  assert.equal(context.coordinator.status().state, 'unverified');
  assert.equal(context.saves.length, 0);
});

test('another stable wrong song appearing cancels further retries', async () => {
  let reads = 0;
  const context = setup({ observe: sent => !sent.length ? wrong : ++reads <= 2 ? { ...wrong, mediaId: 'wrong-a' } : { ...wrong, title: 'Manually selected song', mediaId: 'wrong-b' } });
  context.coordinator.graceMs = 50;
  const { reservation } = context.begin();
  await reservation.task;
  assert.equal(context.coordinator.status().state, 'cancelled');
  assert.deepEqual(context.sent, ['Umair']);
});

test('repeated stopped state permits a bounded alternate artist attempt', async () => {
  const context = setup({ observe: sent => sent.at(-1) === 'Hasan Raheem' ? right : { state: 'STOPPED' } });
  const { reservation } = context.begin();
  await reservation.task;
  assert.deepEqual(context.sent, ['Umair', 'Hasan Raheem']);
  assert.equal(context.coordinator.status().state, 'matched');
});

test('cancellation during submission does not poll or save after it returns', async () => {
  let reads = 0;
  const entered = deferred(), block = deferred();
  const context = setup({ observe: () => { reads++; return wrong; }, play: async () => { entered.resolve(); await block.promise; } });
  const { reservation } = context.begin();
  await entered.promise;
  context.coordinator.cancel();
  block.resolve();
  await reservation.task;
  assert.equal(reads, 1);
  assert.equal(context.saves.length, 0);
  assert.deepEqual(context.sent, ['Umair']);
});

test('unchanged initially paused playback permits an alternate artist when the first request starts nothing', async () => {
  const context = setup({ observe: sent => sent.at(-1) === 'Hasan Raheem' ? right : { state: 'PAUSED', title: 'Old Song', artist: 'Old Artist', mediaId: 'old' } });
  const { reservation } = context.begin();
  await reservation.task;
  assert.deepEqual(context.sent, ['Umair', 'Hasan Raheem']);
  assert.equal(context.coordinator.status().state, 'matched');
});


test('explicit provider selection rejects a right song playing on the wrong known service', async () => {
  const context = setup({ observe: sent => ({ ...(sent.length ? right : wrong), providerName: 'Spotify' }) });
  const { reservation } = context.begin(track, 'apple-music');
  await reservation.task;
  const status = context.coordinator.status();
  assert.equal(status.state, 'unmatched');
  assert.equal(status.providerId, 'apple-music');
  assert.equal(status.providerName, 'Apple Music');
  assert.equal(status.reportedProviderName, 'Spotify');
  assert.deepEqual(context.sentProviders, ['apple-music', 'apple-music']);
  assert.equal(context.saves.length, 0);
});

test('explicit selection remains unverified when the actual provider is missing', async () => {
  const context = setup();
  const { reservation } = context.begin(track, 'apple-music');
  await reservation.task;
  assert.equal(context.coordinator.status().state, 'unverified');
  assert.equal(context.coordinator.status().reportedProviderName, null);
  assert.deepEqual(context.sentProviders, ['apple-music']);
  assert.equal(context.saves.length, 0);
});

test('two matching song and provider readings confirm the requested service and report its actual name', async () => {
  const context = setup({ observe: sent => ({ ...(sent.length ? right : wrong), providerName: 'Apple Music' }) });
  const { reservation } = context.begin(track, 'apple-music');
  await reservation.task;
  const status = context.coordinator.status();
  assert.equal(status.state, 'matched');
  assert.equal(status.providerId, 'apple-music');
  assert.equal(status.reportedProviderName, 'Apple Music');
  assert.match(status.message, /playing on Apple Music/);
  assert.deepEqual(context.sentProviders, ['apple-music']);
});

test('Alexa default permits the actual reported service without pretending to select it', async () => {
  const context = setup({ observe: sent => ({ ...(sent.length ? right : wrong), providerName: 'Spotify' }) });
  const { reservation } = context.begin();
  await reservation.task;
  const status = context.coordinator.status();
  assert.equal(status.state, 'matched');
  assert.equal(status.providerId, 'alexa-default');
  assert.equal(status.reportedProviderName, 'Spotify');
  assert.match(status.message, /playing on Spotify/);
  assert.deepEqual(context.sentProviders, ['alexa-default']);
});

test('alternate artist retries stay on the explicitly selected provider', async () => {
  const context = setup({ observe: sent => ({ ...(sent.at(-1) === 'Hasan Raheem' ? right : wrong), providerName: 'Apple Music' }) });
  const { reservation } = context.begin(track, 'apple-music');
  await reservation.task;
  assert.equal(context.coordinator.status().state, 'matched');
  assert.deepEqual(context.sent, ['Umair', 'Hasan Raheem']);
  assert.deepEqual(context.sentProviders, ['apple-music', 'apple-music']);
});

test('a new provider choice supersedes an older request while an invalid provider preserves it', async () => {
  const block = deferred();
  let reads = 0;
  const context = setup({ observe: async sent => ++reads === 1 ? block.promise : ({ ...(sent.length ? right : wrong), providerName: 'Spotify' }) });
  const first = context.begin(track, 'apple-music');
  await Promise.resolve();
  assert.throws(() => context.coordinator.reserve({ deviceId: 'echo1', country: 'IN', trackHint: track, providerId: 'unknown-service' }), { code: 'INVALID_MUSIC_PROVIDER' });
  assert.equal(context.coordinator.status().id, first.reservation.id);
  assert.equal(context.coordinator.status().active, true);
  const second = context.begin(track, 'spotify');
  assert.equal(first.reservation.state, 'cancelled');
  assert.equal(context.coordinator.status().providerId, 'spotify');
  block.resolve({ ...wrong, providerName: 'Apple Music' });
  await Promise.all([first.reservation.task, second.reservation.task]);
  assert.equal(context.coordinator.status().state, 'matched');
  assert.deepEqual(context.sentProviders, ['spotify']);
});

test('alternating actual service names cannot satisfy two stable reads even for one media ID', async () => {
  let reads = 0;
  const context = setup({ observe: sent => sent.length ? ({ ...right, mediaId: 'same-media-id', providerName: ++reads % 2 ? 'Spotify' : 'Apple Music' }) : wrong });
  const { reservation } = context.begin();
  await reservation.task;
  assert.equal(context.coordinator.status().state, 'unverified');
  assert.equal(context.saves.length, 0);
  assert.deepEqual(context.sentProviders, ['alexa-default']);
});


test('an unchanged paused baseline cannot bypass missing explicit-provider evidence', async () => {
  const context = setup({ observe: () => ({ state: 'PAUSED', title: 'Old Song', artist: 'Old Artist', mediaId: 'old' }) });
  const { reservation } = context.begin(track, 'apple-music');
  await reservation.task;
  assert.equal(context.coordinator.status().state, 'unverified');
  assert.deepEqual(context.sentProviders, ['apple-music']);
  assert.equal(context.saves.length, 0);
});


test('saved joined credits are resolved before one individual-artist command is sent', async () => {
  const original = { title: 'Pesamale', artist: 'Siri Xander, Arra Aria Khayal', requestArtist: 'Siri Xander, Arra Aria Khayal', requestArtists: ['Siri Xander, Arra Aria Khayal'], source: 'spotify' };
  const commands = [], calls = [];
  const context = setup({
    artistResolver: { async resolve(value, country, options) { calls.push({ value, country, signal: options.signal }); return { ...value, requestArtist: 'Siri Xander', requestArtists: ['Siri Xander', 'Arra Aria Khayal'] }; } },
    observe: sent => sent.length ? { state: 'PLAYING', title: 'Pesamale', artist: 'Siri Xander & Arra Aria Khayal', providerName: 'Apple Music' } : wrong,
    play: (value, device, provider) => commands.push(buildMusicCommand(value, provider)),
  });
  const { reservation } = context.begin(original, 'apple-music');
  await reservation.task;
  assert.deepEqual(commands, ['play song Pesamale by Siri Xander on Apple Music']);
  assert.equal(context.coordinator.status().state, 'matched');
  assert.equal(calls[0].country, 'IN');
  assert.equal(calls[0].signal, reservation.abort.signal);
  assert.equal(original.requestArtist, original.artist);
  assert.equal(context.saves[0][0].requestArtist, original.artist, 'learn against the original saved recording identity');
});

test('resolved alternatives retry one artist at a time and never request the joined display credit', async () => {
  const original = { title: 'Pesamale', artist: 'Siri Xander, Arra Aria Khayal', requestArtist: 'Siri Xander, Arra Aria Khayal' };
  const commands = [];
  const context = setup({
    artistResolver: { async resolve(value) { return { ...value, requestArtist: 'Siri Xander', requestArtists: ['Siri Xander', 'Arra Aria Khayal'] }; } },
    observe: sent => sent.at(-1) === 'Arra Aria Khayal' ? { state: 'PLAYING', title: 'Pesamale', artist: original.artist } : wrong,
    play: value => commands.push(buildMusicCommand(value)),
  });
  const { reservation } = context.begin(original);
  await reservation.task;
  assert.deepEqual(commands, ['play song Pesamale by Siri Xander', 'play song Pesamale by Arra Aria Khayal']);
  assert.equal(context.coordinator.status().state, 'matched');
});

test('cancelling during artist lookup prevents every song command', async () => {
  const entered = deferred(), block = deferred();
  let signal;
  const context = setup({ artistResolver: { async resolve(value, country, options) { signal = options.signal; entered.resolve(); await block.promise; return value; } } });
  const { reservation } = context.begin();
  await entered.promise;
  context.coordinator.cancel();
  assert.equal(signal.aborted, true);
  block.resolve();
  await reservation.task;
  assert.deepEqual(context.sent, []);
  assert.equal(context.coordinator.status().state, 'cancelled');
});

test('an unavailable optional artist lookup preserves known single-artist playback', async () => {
  const context = setup({ artistResolver: { async resolve() { throw new Error('catalogue unavailable'); } } });
  const { reservation } = context.begin();
  await reservation.task;
  assert.deepEqual(context.sent, ['Umair']);
  assert.equal(context.coordinator.status().state, 'matched');
});
