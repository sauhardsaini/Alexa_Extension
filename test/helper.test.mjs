import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createApp, Companion, validateTrack, buildCommand, compareReported, publicAmazonStatus, getArtistCandidates } from '../server.mjs';

const EXT = 'a'.repeat(32), OTHER = 'b'.repeat(32);
const ORIGIN = 'chrome-extension://' + EXT;
const TRACK = { title: 'Lover', artist: 'Taylor Swift', source: 'apple-music', url: 'https://music.apple.com/in/album/lover/1468058165?i=1468058173' };
const SPEAKER = { id: 'echo-1', name: 'Living room Echo' };
const PROVIDER = { id: 'apple-music', name: 'Apple Music', kind: 'music', commandName: 'Apple Music' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await sleep(3); } assert.fail('Expected helper state was not reached'); }
function upstreamMock({ player, providers = [], command, customCommand, commands = [], status } = {}) {
  const calls = []; let reads = 0;
  const upstream = async (route, options) => {
    calls.push({ route, options });
    if (route === '/api/status') return status ? status() : { connection: { state: 'connected' }, devices: [SPEAKER], player: null };
    if (route === '/api/music-providers') return { providers };
    if (route === '/api/command') return command ? command(options) : { status: 'sent', commandId: 'command-' + calls.length };
    if (route === '/api/custom-command') return customCommand ? customCommand(options) : { status: 'sent', commandId: 'custom-' + calls.length };
    if (route === '/api/commands') return { commands: typeof commands === 'function' ? commands() : commands };
    if (route.startsWith('/api/player')) return { player: typeof player === 'function' ? player(reads++) : player };
    if (route === '/api/control') return { status: 'sent' };
    throw new Error('unexpected route');
  };
  return { upstream, calls };
}
async function fixture(t, mock = upstreamMock(), amazonConnection = null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-companion-test-'));
  const app = await createApp({ port: 0, dataDir: dir, upstream: mock.upstream, amazonConnection, pollDelayMs: 5, pollAttempts: 4, quietSearch: false });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + app.address().port;
  t.after(async () => { app.companion.stop(); await new Promise(resolve => { app.closeAllConnections?.(); app.close(resolve); }); await fs.rm(dir, { recursive: true, force: true }); });
  const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(url + route, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { response, data };
  };
  const local = body => ({ method: 'POST', body, headers: { Origin: url, 'X-Echo-Companion': '1' } });
  const pairResult = await request('/api/pair', local({}));
  assert.equal(pairResult.response.status, 200);
  const token = pairResult.data.token;
  const auth = { Authorization: 'Bearer ' + token, Origin: ORIGIN, 'X-Echo-Extension': EXT };
  return { dir, app, url, request, local, token, auth, calls: mock.calls };
}

test('pairing creates a private hash, binds one extension, and revokes access', async t => {
  const f = await fixture(t);
  let data = JSON.parse(await fs.readFile(path.join(f.dir, 'pairing.json'), 'utf8'));
  assert.equal(data.hash.length, 64); assert.ok(!JSON.stringify(data).includes(f.token)); assert.equal((await fs.stat(path.join(f.dir, 'pairing.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.dir)).mode & 0o777, 0o700);
  let result = await f.request('/api/status', { headers: f.auth });
  assert.equal(result.response.status, 200); assert.equal(result.data.connected, true); assert.deepEqual(result.data.devices, [SPEAKER]);
  data = JSON.parse(await fs.readFile(path.join(f.dir, 'pairing.json'), 'utf8')); assert.equal(data.extensionId, EXT);
  result = await f.request('/api/status', { headers: { ...f.auth, Origin: 'chrome-extension://' + OTHER, 'X-Echo-Extension': OTHER } }); assert.equal(result.response.status, 403);
  assert.equal((await f.request('/api/revoke', f.local({}))).response.status, 200);
  assert.equal((await f.request('/api/status', { headers: f.auth })).response.status, 401);
  await assert.rejects(fs.stat(path.join(f.dir, 'pairing.json')), { code: 'ENOENT' });
});

test('pairing rotation invalidates the previous token', async t => {
  const f = await fixture(t); const next = await f.request('/api/pair', f.local({}));
  assert.notEqual(next.data.token, f.token);
  assert.equal((await f.request('/api/status', { headers: f.auth })).response.status, 401);
  assert.equal((await f.request('/api/status', { headers: { ...f.auth, Authorization: 'Bearer ' + next.data.token } })).response.status, 200);
});

test('host, web origins, missing token, mismatched origin, and forged ids are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/status')).response.status, 403);
  assert.equal((await f.request('/api/status', { headers: { 'X-Echo-Extension': EXT } })).response.status, 401);
  assert.equal((await f.request('/api/status', { headers: { ...f.auth, Authorization: 'Bearer ' + 'z'.repeat(43) } })).response.status, 401);
  assert.equal((await f.request('/api/status', { headers: { ...f.auth, Origin: 'https://music.apple.com' } })).response.status, 403);
  assert.equal((await f.request('/api/status', { headers: { ...f.auth, Origin: 'null' } })).response.status, 403);
  assert.equal((await f.request('/api/status', { headers: { ...f.auth, 'X-Echo-Extension': OTHER } })).response.status, 403);
  const wrongHost = await new Promise((resolve, reject) => { const req = http.get(f.url + '/api/status', { headers: { ...f.auth, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); });
  assert.equal(wrongHost, 403);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example', 'X-Echo-Companion': '1' } })).response.status, 403);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: {}, headers: { Origin: f.url } })).response.status, 403);
  assert.equal((await f.request('/', { headers: { Origin: 'https://evil.example' } })).response.status, 403);
});

test('host-permitted extension requests without Origin still require id and token', async t => {
  const f = await fixture(t); const headers = { Authorization: 'Bearer ' + f.token, 'X-Echo-Extension': EXT };
  assert.equal((await f.request('/api/status', { headers })).response.status, 200);
  assert.equal((await f.request('/api/status', { headers: { ...headers, 'X-Echo-Extension': OTHER } })).response.status, 403);
});

test('preflight only allows extension origins and never grants arbitrary websites CORS', async t => {
  const f = await fixture(t);
  let r = await f.request('/api/play', { method: 'OPTIONS', headers: { Origin: ORIGIN } }); assert.equal(r.response.status, 204); assert.equal(r.response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  r = await f.request('/api/play', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }); assert.equal(r.response.status, 403); assert.equal(r.response.headers.get('Access-Control-Allow-Origin'), null);
  await f.request('/api/status', { headers: f.auth });
  assert.equal((await f.request('/api/play', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://' + OTHER } })).response.status, 403);
});

test('metadata validation excludes ads, malformed sources, control characters, and hostile source URLs', () => {
  assert.equal(validateTrack(TRACK).title, 'Lover');
  for (const track of [{ ...TRACK, title: '' }, { ...TRACK, artist: '' }, { ...TRACK, source: 'evil' }, { ...TRACK, isAd: true }, { ...TRACK, title: 'Hello\nstop' }, { ...TRACK, artist: 'A\u2028B' }, { ...TRACK, title: 'x'.repeat(251) }, { ...TRACK, url: 'https://evil.example/song' }, { ...TRACK, url: 'https://user:password@music.apple.com/in/song' }, { ...TRACK, durationMs: 0 }]) assert.throws(() => validateTrack(track));
  const stripped = validateTrack({ ...TRACK, url: TRACK.url + '&access_token=private#token' }); assert.equal(stripped.url, TRACK.url);
  assert.throws(() => buildCommand({ title: 'x'.repeat(250), artist: 'y'.repeat(250) }, PROVIDER));
});

test('commands preserve song wording, artist, versions, and chosen service', () => {
  assert.equal(buildCommand(TRACK, PROVIDER), 'play song Lover by Taylor Swift on Apple Music');
  assert.equal(buildCommand({ ...TRACK, title: 'Lover (Live From Paris)' }, { commandName: 'Spotify' }), 'play song Lover (Live From Paris) by Taylor Swift on Spotify');
  assert.equal(buildCommand(TRACK, { commandName: '' }), 'play song Lover by Taylor Swift');
});

test('confirmation requires reported playback, matching version, artist, provider, and duration', () => {
  const p = { state: 'PLAYING', title: TRACK.title, artist: TRACK.artist, providerName: 'Apple Music', durationMs: 221000 };
  assert.equal(compareReported(TRACK, p, PROVIDER), 'match');
  for (const patch of [{ title: 'I Forgot That You Existed' }, { title: 'Lover (Live From Paris)' }, { artist: 'Someone Else' }, { providerName: 'Amazon Music' }]) assert.equal(compareReported(TRACK, { ...p, ...patch }, PROVIDER), 'mismatch');
  assert.equal(compareReported(TRACK, { ...p, state: 'PAUSED' }, PROVIDER), 'unknown');
  assert.equal(compareReported(TRACK, { ...p, providerName: '' }, PROVIDER), 'unknown');
  assert.equal(compareReported({ ...TRACK, durationMs: 100000 }, p, PROVIDER), 'mismatch');
});

const BANNI = { title: 'BANNI', artist: 'Aneesh, Krtin Kay & Kunnu', artistNames: ['Aneesh', 'Krtin Kay', 'Kunnu', 'Gargei Lavekar'], source: 'youtube-music', durationMs: 125000 };
const BANNI_PLAYER = { state: 'PLAYING', title: 'BANNI (feat. Gargei Lavekar)', artist: BANNI.artist, providerName: 'Apple Music', durationMs: 125000 };
test('a known trailing featured credit can differ on one title side with artist, service, and duration corroboration', () => {
  for (const suffix of ['(feat. Gargei Lavekar)', '[ft. Gargei Lavekar]', '[featuring Gargei Lavekar]']) {
    const full = 'BANNI ' + suffix;
    assert.equal(compareReported(BANNI, { ...BANNI_PLAYER, title: full }, PROVIDER), 'match', full);
    assert.equal(compareReported({ ...BANNI, title: full }, { ...BANNI_PLAYER, title: 'BANNI', artist: 'Aneesh', durationMs: 126000 }, PROVIDER), 'match', full + ' reverse');
  }
  assert.equal(buildCommand(BANNI, PROVIDER), 'play song BANNI by Aneesh, Krtin Kay & Kunnu on Apple Music');
});
test('featured title aliases cannot confirm without a known guest, trusted artist, actual service, and both durations', () => {
  for (const track of [{ ...BANNI, artistNames: undefined }, { ...BANNI, artistNames: ['Aneesh', 'Different Guest'] }]) assert.equal(compareReported(track, BANNI_PLAYER, PROVIDER), 'mismatch');
  for (const patch of [{ title: 'BANNI (feat. Different Guest)' }, { title: 'Different Song (feat. Gargei Lavekar)' }, { artist: 'Unrelated Artist' }, { providerName: 'Amazon Music' }, { durationMs: 145000 }]) assert.equal(compareReported(BANNI, { ...BANNI_PLAYER, ...patch }, PROVIDER), 'mismatch', JSON.stringify(patch));
  for (const durationMs of [undefined, 0, NaN]) {
    assert.equal(compareReported({ ...BANNI, durationMs }, BANNI_PLAYER, PROVIDER), 'unknown');
    assert.equal(compareReported(BANNI, { ...BANNI_PLAYER, durationMs }, PROVIDER), 'unknown');
  }
  assert.equal(compareReported(BANNI, { ...BANNI_PLAYER, providerName: '' }, PROVIDER), 'unknown');
  assert.equal(compareReported(BANNI, BANNI_PLAYER, { id: 'alexa-default', name: 'Alexa default', commandName: '' }), 'unknown');
  assert.equal(compareReported({ ...BANNI, title: 'BANNI (feat. First Guest)', artistNames: [...BANNI.artistNames, 'First Guest'] }, BANNI_PLAYER, PROVIDER), 'mismatch');
});
test('featured title aliases never remove recording versions or mixed and nested annotations', () => {
  const cases = [
    ['BANNI', 'BANNI (Live)'], ['BANNI', 'BANNI (Remix)'], ['BANNI', 'BANNI (Acoustic)'],
    ['BANNI (feat. Gargei Lavekar)', 'BANNI (Remix)'],
    ['BANNI (Live)', 'BANNI (Live) (feat. Gargei Lavekar)'],
    ['BANNI', 'BANNI (feat. Gargei Lavekar) (Live)'],
    ['BANNI', 'BANNI (feat. Gargei Lavekar (Live))'],
    ['BANNI', 'BANNI (Live feat. Gargei Lavekar)'],
    ['BANNI', 'BANNI (feat. Gargei Lavekar - Remix)'],
    ['BANNI', 'BANNI [ft. Gargei Lavekar - Acoustic]'],
    ['BANNI', 'BANNI (feat. Gargei Lavekar]']
  ];
  for (const [title, reported] of cases) assert.equal(compareReported({ ...BANNI, title }, { ...BANNI_PLAYER, title: reported }, PROVIDER), 'mismatch', title + ' / ' + reported);
  // Exact-title confirmation keeps its existing behavior when durations are absent.
  const title = 'BANNI (feat. Gargei Lavekar)';
  assert.equal(compareReported({ ...BANNI, title, durationMs: undefined, artistNames: [] }, { ...BANNI_PLAYER, durationMs: undefined }, PROVIDER), 'match');
});
test('two corroborated featured-title samples confirm the song without another artist request', async () => {
  const mock = upstreamMock({ player: BANNI_PLAYER });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 3, pollAttempts: 2 });
  try {
    c.play({ track: BANNI, deviceId: SPEAKER.id }); await until(() => !c.status().active);
    assert.equal(c.status().state, 'matched'); assert.equal(c.status().attempt, 1);
    assert.equal(mock.calls.filter(call => call.route === '/api/command').length, 1);
    assert.equal(mock.calls.filter(call => call.route.startsWith('/api/player')).length, 2);
    assert.equal(c.status().observation.title, BANNI_PLAYER.title);
  } finally { c.stop(); }
});

test('HTTP play is asynchronous, only generates song commands, and does not claim country availability', async t => {
  const f = await fixture(t); const r = await f.request('/api/play', { method: 'POST', headers: f.auth, body: { track: TRACK, deviceId: SPEAKER.id, providerId: 'apple-music', country: 'IN', requestId: 'r1' } });
  assert.equal(r.response.status, 202); assert.equal(r.data.job.countryAvailability, 'unverified');
  await until(() => f.calls.some(call => call.route === '/api/command'));
  assert.deepEqual(f.calls.find(call => call.route === '/api/command').options.body, { deviceId: SPEAKER.id, text: 'play song Lover by Taylor Swift on Apple Music' });
  const bad = await f.request('/api/command', { method: 'POST', headers: f.auth, body: { text: 'unlock something' } }); assert.equal(bad.response.status, 400);
  const invalid = await f.request('/api/play', { method: 'POST', headers: f.auth, body: { track: TRACK, deviceId: SPEAKER.id, country: 'XX' } }); assert.equal(invalid.response.status, 400);
  const oversized = await f.request('/api/play', { method: 'POST', headers: f.auth, body: JSON.stringify({ track: { ...TRACK, title: 'x'.repeat(9000) } }) }); assert.equal(oversized.response.status, 413);
});

test('two matching distinct polling samples are needed before confirmation', async () => {
  let reads = 0; const mock = upstreamMock({ player: () => { reads++; return { state: 'PLAYING', title: 'Lover', artist: 'Taylor Swift', providerName: 'Apple Music' }; } });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 5, pollAttempts: 3 });
  try { c.play({ track: TRACK, deviceId: SPEAKER.id }); await until(() => c.status()?.state === 'matched'); assert.equal(reads, 2); }
  finally { c.stop(); }
});

test('wrong recording and unknown provider remain unconfirmed', async () => {
  for (const [patch, expected] of [[{ title: 'I Forgot That You Existed' }, 'unmatched'], [{ providerName: '' }, 'unverified']]) {
    const mock = upstreamMock({ player: { state: 'PLAYING', title: 'Lover', artist: 'Taylor Swift', providerName: 'Apple Music', ...patch } });
    const c = new Companion({ upstream: mock.upstream, pollDelayMs: 5, pollAttempts: 2 });
    try { c.play({ track: TRACK, deviceId: SPEAKER.id }); await until(() => !c.status()?.active); assert.equal(c.status().state, expected); }
    finally { c.stop(); }
  }
});

test('latest song reserves intent before provider loading completes', async () => {
  const gate = deferred(); const calls = [];
  const c = new Companion({ pollDelayMs: 5, pollAttempts: 1, upstream: async (route, options) => {
    if (route === '/api/music-providers') return gate.promise;
    if (route === '/api/status') return { connection: { state: 'connected' }, devices: [SPEAKER] };
    if (route === '/api/command') { calls.push(options.body.text); return { status: 'sent' }; }
    if (route.startsWith('/api/player')) return { player: null };
  } });
  try {
    c.play({ track: TRACK, deviceId: SPEAKER.id, requestId: 'first' }); c.play({ track: { ...TRACK, title: 'Delicate' }, deviceId: SPEAKER.id, requestId: 'second' });
    gate.resolve({ providers: [] }); await until(() => calls.length === 1); assert.deepEqual(calls, ['play song Delicate by Taylor Swift on Apple Music']);
  } finally { c.stop(); }
});

test('cancelling during status loading prevents a later Alexa command', async () => {
  const gate = deferred(); const calls = [];
  const mock = upstreamMock({ status: () => gate.promise, command: options => { calls.push(options); return { status: 'sent' }; } });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 5 });
  try { c.play({ track: TRACK, deviceId: SPEAKER.id }); await until(() => mock.calls.some(call => call.route === '/api/status')); c.cancel(); gate.resolve({ connection: { state: 'connected' }, devices: [SPEAKER] }); await sleep(15); assert.equal(calls.length, 0); assert.equal(c.status().state, 'cancelled'); }
  finally { c.stop(); }
});

test('already-dispatched Alexa commands finish serially before the newer song is sent', async () => {
  const first = deferred(); const calls = [];
  const mock = upstreamMock({ command: options => { calls.push(options.body.text); return calls.length === 1 ? first.promise : { status: 'sent' }; } });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 5 });
  try {
    c.play({ track: TRACK, deviceId: SPEAKER.id }); await until(() => calls.length === 1);
    c.play({ track: { ...TRACK, title: 'Delicate' }, deviceId: SPEAKER.id }); await sleep(12); assert.equal(calls.length, 1);
    first.resolve({ status: 'sent' }); await until(() => calls.length === 2); assert.equal(calls[1], 'play song Delicate by Taylor Swift on Apple Music'); assert.equal(c.status().title, 'Delicate');
  } finally { c.stop(); }
});

test('retries with one request id are idempotent, but changed payload is rejected', async () => {
  const mock = upstreamMock(); const c = new Companion({ upstream: mock.upstream, pollDelayMs: 5 });
  const body = { track: TRACK, deviceId: SPEAKER.id, requestId: 'retry' };
  try {
    const first = c.play(body), second = c.play(body); assert.equal(first.job.id, second.job.id);
    assert.throws(() => c.play({ ...body, track: { ...TRACK, title: 'Another Song' } }), error => error.status === 409);
    await until(() => mock.calls.some(call => call.route === '/api/command')); assert.equal(mock.calls.filter(call => call.route === '/api/command').length, 1);
  } finally { c.stop(); }
});

test('invalid or radio providers and unavailable devices never send song commands', async () => {
  for (const providerId of ['not-a-service', 'tunein']) {
    const mock = upstreamMock({ providers: [{ id: 'tunein', name: 'TuneIn', kind: 'radio' }, { id: 'alexa-bad', name: 'evil\nstop', kind: 'music' }] });
    const c = new Companion({ upstream: mock.upstream, pollDelayMs: 5 });
    try { c.play({ track: TRACK, deviceId: SPEAKER.id, providerId }); await until(() => !c.status().active); assert.equal(c.status().state, 'error'); assert.equal(mock.calls.filter(call => call.route === '/api/command').length, 0); }
    finally { c.stop(); }
  }
  const mock = upstreamMock(); const c = new Companion({ upstream: mock.upstream });
  try { c.play({ track: TRACK, deviceId: 'missing' }); await until(() => !c.status().active); assert.equal(mock.calls.filter(call => call.route === '/api/command').length, 0); }
  finally { c.stop(); }
});

test('upstream errors are reduced to authored messages', async t => {
  const f = await fixture(t, { upstream: async () => { throw new Error('secret-upstream-cookie=value'); }, calls: [] });
  const status = await f.request('/api/status', { headers: f.auth }); assert.equal(status.response.status, 200); assert.equal(status.data.connected, false); assert.ok(!JSON.stringify(status.data).includes('secret'));
  const r = await f.request('/api/play', { method: 'POST', headers: f.auth, body: { track: TRACK, deviceId: SPEAKER.id } }); assert.equal(r.response.status, 202);
  await until(() => !f.app.companion.status().active); assert.ok(!JSON.stringify(f.app.companion.status()).includes('secret'));
});


test('public pairing page accepts cross-site top-level navigation but keeps fetch and pairing guards', async t => {
  const f = await fixture(t);
  const raw = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(f.url + route, { method, headers }, response => { let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text })); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  const navigate = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const page = await raw('/', { headers: navigate }); assert.equal(page.status, 200); assert.match(page.text, /Echo Companion/);
  assert.ok(!page.text.includes(f.token));
  assert.equal((await raw('/', { headers: { ...navigate, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } })).status, 403);
  assert.equal((await raw('/', { headers: { ...navigate, 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
  assert.equal((await raw('/helper.js', { headers: navigate })).status, 403);
  assert.equal((await raw('/api/pair-status', { headers: navigate })).status, 403);
  assert.equal((await raw('/api/pair', { method: 'POST', headers: { ...navigate, Origin: 'https://evil.example', 'X-Echo-Companion': '1', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await raw('/api/revoke', { method: 'POST', headers: { ...navigate, Origin: 'https://evil.example', 'X-Echo-Companion': '1', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
});


test('status and provider lookups run concurrently while preserving safe fallbacks', async () => {
  const providerGate = deferred(), statusGate = deferred(); const calls = [];
  const c = new Companion({ upstream: (route) => { calls.push(route); if (route === '/api/music-providers') return providerGate.promise; if (route === '/api/status') return statusGate.promise; throw new Error('unexpected route'); } });
  try {
    const pending = c.readStatus();
    assert.deepEqual(calls, ['/api/music-providers', '/api/status']);
    statusGate.resolve({ connection: { state: 'connected' }, devices: [SPEAKER] });
    providerGate.reject(new Error('private-provider-error'));
    const result = await pending; assert.equal(result.connected, true); assert.deepEqual(result.devices, [SPEAKER]);
    assert.ok(result.providers.some(provider => provider.id === 'apple-music')); assert.ok(!JSON.stringify(result).includes('private-provider-error'));
  } finally { c.stop(); }
});


function amazonMock() {
  let state = { connection: { state: 'disconnected', secret: 'cookie-secret', message: 'private-error-token' }, settings: { region: 'IN', locale: 'en-IN', country: 'IN' }, devices: [] };
  const calls = [];
  return {
    calls,
    status: () => state,
    connect: async settings => { calls.push({ action: 'connect', settings }); state = { ...state, settings: { ...settings, country: settings.region === 'UK' ? 'GB' : settings.region }, connection: { state: 'awaiting_login', loginUrl: 'http://127.0.0.1:4321/', message: 'private-error-token' } }; return state; },
    disconnect: async () => { calls.push({ action: 'disconnect' }); state = { ...state, connection: { state: 'disconnected' }, devices: [] }; return state; },
    stop: () => { calls.push({ action: 'stop' }); },
    setStatus: next => { state = next; }
  };
}

test('Amazon status uses only safe connection fields and a fixed local login address', () => {
  const status = publicAmazonStatus({ connection: { state: 'awaiting_login', message: 'secret-token', loginUrl: 'https://evil.example/?cookie=private', cookie: 'private' }, settings: { region: 'UK', locale: 'not-real', country: 'private' }, devices: [{ id: 'echo-1', name: 'Echo', token: 'private' }, { id: '', name: 'bad' }], registration: 'private' });
  assert.deepEqual(status.settings, { region: 'UK', locale: 'en-GB', country: 'GB' }); assert.deepEqual(status.devices, [{ id: 'echo-1', name: 'Echo' }]);
  assert.ok(!JSON.stringify(status).includes('private')); assert.ok(!JSON.stringify(status).includes('secret')); assert.equal(status.connection.loginUrl, undefined);
  const local = publicAmazonStatus({ connection: { state: 'awaiting_login', loginUrl: 'http://127.0.0.1:4321/' } }); assert.equal(local.connection.loginUrl, 'http://127.0.0.1:4321/');
  assert.ok(status.regions.some(region => region.id === 'IN')); assert.ok(status.locales.some(locale => locale.id === 'hi-IN'));
});

test('Amazon login is local-only, validates setup, and uses the independent adapter', async t => {
  const amazon = amazonMock(); const f = await fixture(t, upstreamMock(), amazon);
  const initial = await f.request('/api/amazon/status'); assert.equal(initial.response.status, 200); assert.equal(initial.data.connection.state, 'disconnected');
  assert.ok(!JSON.stringify(initial.data).includes('cookie-secret')); assert.ok(!JSON.stringify(initial.data).includes('private-error-token'));
  assert.equal((await f.request('/api/amazon/status', { headers: f.auth })).response.status, 403);
  assert.equal((await f.request('/api/amazon/status', { headers: { Origin: 'https://evil.example' } })).response.status, 403);
  assert.equal((await f.request('/api/amazon/connect', { method: 'POST', headers: { Origin: f.url }, body: { region: 'IN' } })).response.status, 403);
  assert.equal((await f.request('/api/amazon/connect', { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Echo-Companion': '1' }, body: { region: 'IN' } })).response.status, 403);
  assert.equal((await f.request('/api/amazon/connect', f.local({ region: 'XX' }))).response.status, 400);
  assert.equal((await f.request('/api/amazon/connect', f.local({ region: 'IN', locale: 'en-IN\nsecret' }))).response.status, 400);
  assert.equal(amazon.calls.length, 0);
  const connected = await f.request('/api/amazon/connect', f.local({ region: 'UK', locale: '' })); assert.equal(connected.response.status, 202); assert.equal(connected.data.connection.state, 'awaiting_login'); assert.equal(connected.data.connection.loginUrl, 'http://127.0.0.1:4321/');
  assert.deepEqual(amazon.calls[0], { action: 'connect', settings: { region: 'UK', locale: 'en-GB' } });
  assert.equal((await f.request('/api/amazon/disconnect', f.local({}))).response.status, 200); assert.equal(amazon.calls[1].action, 'disconnect');
});

test('Amazon sign-in failures use authored messages and never expose upstream secrets', async t => {
  const amazon = amazonMock(); amazon.connect = async () => { throw new Error('private-cookie-secret'); };
  const f = await fixture(t, upstreamMock(), amazon);
  const response = await f.request('/api/amazon/connect', f.local({ region: 'IN' })); assert.equal(response.response.status, 502); assert.equal(response.data.error, 'AMAZON_CONNECT_FAILED'); assert.ok(!JSON.stringify(response.data).includes('private-cookie-secret'));
  amazon.connect = async () => { const error = new Error('private-secret'); error.code = 'CONNECTION_BUSY'; throw error; };
  assert.equal((await f.request('/api/amazon/connect', f.local({ region: 'IN' }))).response.status, 409);
});

test('extension status exposes safe own Amazon connection data', async t => {
  const mock = upstreamMock({ status: () => ({ connection: { state: 'awaiting_login', loginUrl: 'http://127.0.0.1:4321/', cookie: 'private', message: 'private-error' }, devices: [], settings: { region: 'IN', locale: 'hi-IN', country: 'IN' } }) });
  const f = await fixture(t, mock, amazonMock());
  const status = await f.request('/api/status', { headers: f.auth }); assert.equal(status.response.status, 200); assert.equal(status.data.connection.state, 'awaiting_login'); assert.equal(status.data.connection.loginUrl, 'http://127.0.0.1:4321/'); assert.equal(status.data.settings.locale, 'hi-IN'); assert.ok(!JSON.stringify(status.data).includes('private'));
});

test('Amazon connection change cancels a pending song before it can send', async t => {
  const gate = deferred(); const mock = upstreamMock({ status: () => gate.promise }); const f = await fixture(t, mock, amazonMock());
  await f.request('/api/play', { method: 'POST', headers: f.auth, body: { track: TRACK, deviceId: SPEAKER.id } });
  await until(() => mock.calls.some(call => call.route === '/api/status'));
  assert.equal((await f.request('/api/amazon/disconnect', f.local({}))).response.status, 200);
  gate.resolve({ connection: { state: 'connected' }, devices: [SPEAKER] }); await sleep(12);
  assert.equal(mock.calls.filter(call => call.route === '/api/command').length, 0); assert.equal(f.app.companion.status().state, 'cancelled');
});

test('connection changes invalidate providers and prevent stale provider lookups from repopulating cache', async () => {
  const old = deferred(); let calls = 0;
  const c = new Companion({ upstream: async route => { if (route !== '/api/music-providers') throw new Error('unexpected'); return ++calls === 1 ? old.promise : { providers: [{ id: 'alexa-new', name: 'New Music', kind: 'music' }] }; } });
  try {
    const first = c.loadProviders(); c.connectionChanged(); const second = await c.loadProviders(); assert.ok(second.some(provider => provider.id === 'alexa-new'));
    old.resolve({ providers: [{ id: 'alexa-old', name: 'Old Music', kind: 'music' }] }); await first;
    assert.ok(c.providers.some(provider => provider.id === 'alexa-new')); assert.ok(!c.providers.some(provider => provider.id === 'alexa-old'));
  } finally { c.stop(); }
});

test('closing the helper stops its Amazon adapter exactly once', async t => {
  const amazon = amazonMock(); const f = await fixture(t, upstreamMock(), amazon);
  await f.app.stopResources(); await f.app.stopResources(); assert.deepEqual(amazon.calls, [{ action: 'stop' }]);
});


test('local account and pairing actions require an explicit same-local Origin', async t => {
  const amazon = amazonMock(); const f = await fixture(t, upstreamMock(), amazon);
  for (const route of ['/api/amazon/connect', '/api/amazon/disconnect', '/api/pair', '/api/revoke']) {
    const result = await f.request(route, { method: 'POST', headers: { 'X-Echo-Companion': '1' }, body: { region: 'IN' } }); assert.equal(result.response.status, 403);
  }
  assert.equal(amazon.calls.length, 0);
});

test('connection changes cancel a queued playback control before its send', async t => {
  const gate = deferred(); const mock = upstreamMock({ command: () => gate.promise }); const f = await fixture(t, mock, amazonMock());
  await f.request('/api/play', { method: 'POST', headers: f.auth, body: { track: TRACK, deviceId: SPEAKER.id } });
  await until(() => mock.calls.some(call => call.route === '/api/command'));
  const pendingControl = f.app.companion.control({ deviceId: SPEAKER.id, action: 'pause' });
  await f.request('/api/amazon/disconnect', f.local({})); gate.resolve({ status: 'sent' });
  const result = await pendingControl; assert.equal(result.ok, false); assert.equal(mock.calls.filter(call => call.route === '/api/control').length, 0);
});

test('createApp uses its own injected Amazon adapter without an external web app', async t => {
  const amazon = amazonMock(), mock = upstreamMock(); amazon.upstream = mock.upstream;
  const f = await fixture(t, { upstream: null, calls: mock.calls }, amazon);
  const status = await f.request('/api/status', { headers: f.auth }); assert.equal(status.response.status, 200); assert.equal(status.data.connected, true); assert.deepEqual(status.data.devices, [SPEAKER]);
  await f.request('/api/play', { method: 'POST', headers: f.auth, body: { track: TRACK, deviceId: SPEAKER.id } });
  await until(() => mock.calls.some(call => call.route === '/api/command'));
  assert.equal(mock.calls.find(call => call.route === '/api/command').options.body.text, 'play song Lover by Taylor Swift on Apple Music');
});


const MADIRA = { title: 'Madira', artist: 'Hardik Bhardwaj & Scxtch', artistNames: ['Hardik Bhardwaj', 'Scxtch'], source: 'youtube-music', url: 'https://music.youtube.com/watch?v=abc123' };

test('structured artist credits are bounded, validated, and deduplicated while keeping display credits', () => {
  const track = validateTrack({ ...MADIRA, artistNames: ['Hardik Bhardwaj', ' Scxtch ', 'scxtch'] });
  assert.equal(track.artist, 'Hardik Bhardwaj & Scxtch'); assert.deepEqual(track.artistNames, ['Hardik Bhardwaj', 'Scxtch']);
  for (const artistNames of ['Hardik', Array(13).fill('Artist'), [''], ['Hardik\nstop'], [123]]) assert.throws(() => validateTrack({ ...MADIRA, artistNames }));
});

test('single artist credits are attempted first, with no combined-credit attempt and a four-artist cap', () => {
  assert.deepEqual(getArtistCandidates(MADIRA), ['Hardik Bhardwaj', 'Scxtch']);
  assert.deepEqual(getArtistCandidates({ ...MADIRA, artistNames: ['Hardik Bhardwaj', 'Hardik Bhardwaj', 'Scxtch', 'Third', 'Fourth', 'Fifth'] }), ['Hardik Bhardwaj', 'Scxtch', 'Third', 'Fourth']);
  assert.deepEqual(getArtistCandidates({ artist: 'Earth, Wind & Fire' }), ['Earth, Wind & Fire']);
  assert.deepEqual(getArtistCandidates({ artist: 'Earth, Wind & Fire & Another Artist', artistNames: ['Earth, Wind & Fire', 'Another Artist'] }), ['Earth, Wind & Fire', 'Another Artist']);
});

test('a first-artist match stops all further requests and preserves the original credits', async () => {
  const mock = upstreamMock({ player: { state: 'PLAYING', title: 'Madira', artist: 'Hardik Bhardwaj', providerName: 'Apple Music' } });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 3, pollAttempts: 2 });
  try {
    c.play({ track: MADIRA, deviceId: SPEAKER.id }); await until(() => !c.status().active);
    assert.equal(c.status().state, 'matched'); assert.equal(c.status().artist, MADIRA.artist); assert.equal(c.status().requestArtist, 'Hardik Bhardwaj');
    assert.equal(c.status().attempt, 1); assert.equal(c.status().maxAttempts, 2); assert.equal(c.status().attempts.length, 1);
    assert.deepEqual(mock.calls.filter(call => call.route === '/api/command').map(call => call.options.body.text), ['play song Madira by Hardik Bhardwaj on Apple Music']);
  } finally { c.stop(); }
});

test('a wrong first song triggers the next individual artist, stopping when the correct recording is confirmed', async () => {
  let command = 0;
  const mock = upstreamMock({ command: () => { command++; return { status: 'sent', commandId: 'attempt-' + command }; }, player: () => command === 1 ? { state: 'PLAYING', title: 'Different Song', artist: 'Hardik Bhardwaj', providerName: 'Apple Music' } : { state: 'PLAYING', title: 'Madira', artist: 'Scxtch', providerName: 'Apple Music' } });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 3, pollAttempts: 2 });
  try {
    c.play({ track: MADIRA, deviceId: SPEAKER.id }); await until(() => !c.status().active);
    assert.equal(c.status().state, 'matched'); assert.equal(c.status().attempt, 2); assert.equal(c.status().requestArtist, 'Scxtch'); assert.equal(c.status().title, 'Madira');
    assert.deepEqual(c.status().attempts.map(attempt => attempt.state), ['unmatched', 'matched']);
    assert.deepEqual(mock.calls.filter(call => call.route === '/api/command').map(call => call.options.body.text), ['play song Madira by Hardik Bhardwaj on Apple Music', 'play song Madira by Scxtch on Apple Music']);
  } finally { c.stop(); }
});

test('unconfirmed first playback permits the next artist without treating acceptance as success', async () => {
  let command = 0;
  const mock = upstreamMock({ command: () => { command++; return { status: 'sent' }; }, player: () => ({ state: command === 1 ? 'PAUSED' : 'PLAYING', title: 'Madira', artist: 'Scxtch', providerName: 'Apple Music' }) });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 3, pollAttempts: 2 });
  try { c.play({ track: MADIRA, deviceId: SPEAKER.id }); await until(() => !c.status().active); assert.equal(c.status().state, 'matched'); assert.deepEqual(c.status().attempts.map(attempt => attempt.state), ['unverified', 'matched']); }
  finally { c.stop(); }
});

test('wrong versions, services, durations, and unrelated artists cannot confirm an artist retry', async () => {
  const base = { state: 'PLAYING', title: 'Madira', artist: 'Scxtch', providerName: 'Apple Music', durationMs: 200000 };
  assert.equal(compareReported(MADIRA, base, PROVIDER), 'match');
  for (const patch of [{ title: 'Madira (Live)' }, { artist: 'Unrelated Artist' }, { providerName: 'Amazon Music' }]) assert.equal(compareReported(MADIRA, { ...base, ...patch }, PROVIDER), 'mismatch');
  assert.equal(compareReported({ ...MADIRA, durationMs: 100000 }, base, PROVIDER), 'mismatch');
});

test('all failed artist attempts stop at four while exposing their outcomes', async () => {
  const track = { ...MADIRA, artistNames: ['First', 'Second', 'Third', 'Fourth', 'Fifth'] };
  const mock = upstreamMock({ player: { state: 'PLAYING', title: 'Different Song', artist: 'Someone Else', providerName: 'Apple Music' } });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 3, pollAttempts: 2 });
  try {
    c.play({ track, deviceId: SPEAKER.id }); await until(() => !c.status().active);
    assert.equal(c.status().state, 'unmatched'); assert.equal(c.status().attempt, 4); assert.equal(c.status().maxAttempts, 4); assert.equal(c.status().attempts.length, 4);
    assert.deepEqual(mock.calls.filter(call => call.route === '/api/command').map(call => call.options.body.text), ['First', 'Second', 'Third', 'Fourth'].map(name => 'play song Madira by ' + name + ' on Apple Music'));
  } finally { c.stop(); }
});

test('cancel during an artist check prevents every later artist request', async () => {
  const gate = deferred(); const mock = upstreamMock({ player: () => gate.promise });
  // A player payload is held until after cancellation to simulate a late Echo response.
  const upstream = async (route, options) => route.startsWith('/api/player') ? (mock.calls.push({ route, options }), { player: await gate.promise }) : mock.upstream(route, options);
  const c = new Companion({ upstream, pollDelayMs: 3, pollAttempts: 2 });
  try {
    c.play({ track: MADIRA, deviceId: SPEAKER.id }); await until(() => mock.calls.some(call => call.route.startsWith('/api/player')));
    c.cancel(); gate.resolve({ state: 'PLAYING', title: 'Different Song', artist: 'Someone', providerName: 'Apple Music' }); await sleep(12);
    assert.equal(c.status().state, 'cancelled'); assert.equal(c.status().attempts[0].state, 'cancelled'); assert.equal(mock.calls.filter(call => call.route === '/api/command').length, 1);
  } finally { c.stop(); }
});

test('a newer song supersedes an old artist retry even when its playback response arrives late', async () => {
  const gate = deferred(); const mock = upstreamMock({ player: { state: 'PLAYING', title: 'Delicate', artist: 'Taylor Swift', providerName: 'Apple Music' } }); let firstRead = true;
  const upstream = async (route, options) => {
    if (route.startsWith('/api/player') && firstRead) { firstRead = false; mock.calls.push({ route, options }); return { player: await gate.promise }; }
    return mock.upstream(route, options);
  };
  const c = new Companion({ upstream, pollDelayMs: 3, pollAttempts: 2 });
  try {
    c.play({ track: MADIRA, deviceId: SPEAKER.id }); await until(() => !firstRead);
    c.play({ track: { ...TRACK, title: 'Delicate' }, deviceId: SPEAKER.id }); gate.resolve({ state: 'PLAYING', title: 'Wrong Old Song', artist: 'Scxtch', providerName: 'Apple Music' });
    await until(() => !c.status().active); assert.equal(c.status().state, 'matched'); assert.equal(c.status().title, 'Delicate');
    assert.deepEqual(mock.calls.filter(call => call.route === '/api/command').map(call => call.options.body.text), ['play song Madira by Hardik Bhardwaj on Apple Music', 'play song Delicate by Taylor Swift on Apple Music']);
  } finally { c.stop(); }
});

test('read failures stop unverified instead of blindly issuing more artist requests', async () => {
  const mock = upstreamMock(); const upstream = async (route, options) => { if (route.startsWith('/api/player')) throw new Error('private-upstream-error'); return mock.upstream(route, options); };
  const c = new Companion({ upstream, pollDelayMs: 3, pollAttempts: 2 });
  try { c.play({ track: MADIRA, deviceId: SPEAKER.id }); await until(() => !c.status().active); assert.equal(c.status().state, 'unverified'); assert.equal(mock.calls.filter(call => call.route === '/api/command').length, 1); assert.ok(!JSON.stringify(c.status()).includes('private-upstream-error')); }
  finally { c.stop(); }
});


test('punctuation-only artist names remain one bounded attempt and cannot alias another artist', async () => {
  const track = { ...TRACK, artist: '!!!' };
  assert.deepEqual(getArtistCandidates(track), ['!!!']);
  assert.equal(compareReported(track, { state: 'PLAYING', title: 'Lover', artist: '?', providerName: 'Apple Music' }, PROVIDER), 'mismatch');
  const mock = upstreamMock({ player: null }); const c = new Companion({ upstream: mock.upstream, pollDelayMs: 3, pollAttempts: 1 });
  try { c.play({ track, deviceId: SPEAKER.id }); await until(() => !c.status().active); assert.equal(c.status().state, 'unverified'); assert.equal(c.status().maxAttempts, 1); }
  finally { c.stop(); }
});


test('selected Echo status contains its own current progress and volume instead of another Echo snapshot', async t => {
  const mock = upstreamMock({ status: () => ({ connection: { state: 'connected' }, devices: [SPEAKER], player: { state: 'PLAYING', deviceId: 'another-echo', title: 'Wrong Echo Song', artist: 'Other Artist' } }), player: { state: 'PAUSED', deviceId: SPEAKER.id, title: 'Lover', artist: 'Taylor Swift', positionMs: 17000, durationMs: 221000, volume: 23 } });
  const f = await fixture(t, mock);
  const response = await f.request('/api/status?deviceId=' + SPEAKER.id, { headers: f.auth }); assert.equal(response.response.status, 200); assert.equal(response.data.player.deviceId, SPEAKER.id); assert.equal(response.data.player.title, 'Lover'); assert.equal(response.data.player.positionMs, 17000); assert.equal(response.data.player.durationMs, 221000); assert.equal(response.data.player.volume, 23); assert.equal(response.data.volume, 23); assert.equal(response.data.playerError, '');
  assert.equal((await f.request('/api/player?deviceId=' + SPEAKER.id)).response.status, 403);
});

test('player read failures preserve browsing status and remove stale controls without raw errors', async t => {
  const mock = upstreamMock(), upstream = async (route, options) => { if (route.startsWith('/api/player')) throw new Error('private-player-cookie'); return mock.upstream(route, options); };
  const f = await fixture(t, { upstream, calls: mock.calls });
  const response = await f.request('/api/status?deviceId=' + SPEAKER.id, { headers: f.auth }); assert.equal(response.response.status, 200); assert.equal(response.data.connected, true); assert.equal(response.data.player, null); assert.equal(response.data.volume, null); assert.ok(response.data.playerError); assert.ok(!JSON.stringify(response.data).includes('private-player-cookie'));
  const missing = await f.request('/api/player', { headers: f.auth }); assert.equal(missing.response.status, 400);
});

test('volume and seek controls enforce strict numeric bounds before sending', async t => {
  const f = await fixture(t);
  for (const volume of [-1, 101, 3.2, '50', null]) assert.equal((await f.request('/api/control', { method: 'POST', headers: f.auth, body: { deviceId: SPEAKER.id, action: 'volume', volume } })).response.status, 400);
  for (const positionMs of [-1, 1.5, '1000', null, 86400001]) assert.equal((await f.request('/api/control', { method: 'POST', headers: f.auth, body: { deviceId: SPEAKER.id, action: 'seek', positionMs } })).response.status, 400);
  assert.equal(mockControlCount(f.calls), 0);
});
function mockControlCount(calls) { return calls.filter(call => call.route === '/api/control').length; }

test('volume preserves active artist verification and its intent while sending the selected Echo value', async () => {
  const mock = upstreamMock({ player: { state: 'PAUSED', title: 'Madira', artist: 'Hardik Bhardwaj', providerName: 'Apple Music' } });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 50, pollAttempts: 2 });
  try {
    c.play({ track: MADIRA, deviceId: SPEAKER.id }); await until(() => c.status().state === 'checking'); const intent = c.intent, jobId = c.status().id;
    const result = await c.control({ deviceId: SPEAKER.id, action: 'volume', volume: 37 }); assert.equal(result.ok, true); assert.equal(result.confirmed, false); assert.equal(c.intent, intent); assert.equal(c.status().id, jobId); assert.equal(c.status().active, true);
    assert.deepEqual(mock.calls.find(call => call.route === '/api/control').options.body, { deviceId: SPEAKER.id, action: 'volume', volume: 37 });
  } finally { c.stop(); }
});

function seekMock(playerFactory = () => ({ state: 'PLAYING', title: 'Lover', artist: 'Taylor Swift', providerName: 'Apple Music', durationMs: 180000, positionMs: 60000 })) {
  const mock = upstreamMock({ player: playerFactory }); const upstream = async (route, options) => {
    if (route === '/api/control' && options.body.action === 'seek') { mock.calls.push({ route, options }); return { status: 'sent', confirmed: false, targetPositionMs: options.body.positionMs, referenceAt: 100000, track: { title: 'Lover', artist: 'Taylor Swift', providerName: 'Apple Music', durationMs: 180000 } }; }
    return mock.upstream(route, options);
  };
  return { ...mock, upstream };
}

test('seek cancels artist retries and only confirms after two fresh same-track positions', async () => {
  let reads = 0; const mock = seekMock(() => { reads++; return { state: 'PLAYING', title: 'Lover', artist: 'Taylor Swift', providerName: 'Apple Music', durationMs: 180000, positionMs: 60000 }; });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 50, seekPollDelayMs: 3, clock: () => 100000 });
  try {
    c.play({ track: MADIRA, deviceId: SPEAKER.id }); await until(() => c.status().state === 'checking');
    const response = await c.control({ deviceId: SPEAKER.id, action: 'seek', positionMs: 60000, expectedTrack: { title: 'Lover', artist: 'Taylor Swift' } });
    assert.equal(c.status().state, 'cancelled'); assert.equal(response.confirmed, false); assert.equal(response.seek.state, 'checking'); assert.equal(c.seekStatus().confirmed, false);
    await until(() => !c.seekStatus().active); assert.equal(c.seekStatus().state, 'confirmed'); assert.equal(c.seekStatus().confirmed, true); assert.equal(reads, 2); assert.equal(mockControlCount(mock.calls), 1);
  } finally { c.stop(); }
});

test('accepted seek with unchanged position stays unconfirmed and never repeats the command', async () => {
  const mock = seekMock(() => ({ state: 'PLAYING', title: 'Lover', artist: 'Taylor Swift', providerName: 'Apple Music', durationMs: 180000, positionMs: 20000 }));
  const c = new Companion({ upstream: mock.upstream, seekPollDelayMs: 3, clock: () => 100000 });
  try { const result = await c.control({ deviceId: SPEAKER.id, action: 'seek', positionMs: 60000 }); assert.equal(result.ok, true); assert.equal(result.confirmed, false); await until(() => !c.seekStatus().active); assert.equal(c.seekStatus().state, 'unverified'); assert.equal(c.seekStatus().confirmed, false); assert.equal(mockControlCount(mock.calls), 1); }
  finally { c.stop(); }
});

test('a different song or Echo cannot falsely confirm a pending seek', async () => {
  for (const change of [{ title: 'Different Song' }, { deviceId: 'another-echo' }]) {
    const mock = seekMock(() => ({ state: 'PLAYING', title: 'Lover', artist: 'Taylor Swift', providerName: 'Apple Music', durationMs: 180000, positionMs: 60000, ...change }));
    const c = new Companion({ upstream: mock.upstream, seekPollDelayMs: 3, clock: () => 100000 });
    try { await c.control({ deviceId: SPEAKER.id, action: 'seek', positionMs: 60000 }); await until(() => !c.seekStatus().active); assert.equal(c.seekStatus().state, 'unverified'); assert.equal(c.seekStatus().confirmed, false); }
    finally { c.stop(); }
  }
});

test('connection change cancels a pending seek and ignores its late confirmation', async () => {
  const gate = deferred(); const mock = upstreamMock(); const c = new Companion({ seekPollDelayMs: 3, clock: () => 100000, upstream: async (route, options) => { if (route === '/api/control') return gate.promise; return mock.upstream(route, options); } });
  try {
    const pending = c.control({ deviceId: SPEAKER.id, action: 'seek', positionMs: 60000 }); await sleep(4); c.connectionChanged();
    gate.resolve({ status: 'sent', targetPositionMs: 60000, referenceAt: 100000, track: { title: 'Lover', artist: 'Taylor Swift', durationMs: 180000 } }); const result = await pending;
    assert.equal(result.ok, false); assert.equal(c.seekStatus().state, 'cancelled'); assert.equal(c.seekStatus().confirmed, false); assert.equal(mock.calls.filter(call => call.route.startsWith('/api/player')).length, 0);
  } finally { c.stop(); }
});


test('a control waiting behind a held request expires promptly and can never dispatch later', async () => {
  const held = deferred(); const mock = upstreamMock({ command: () => held.promise });
  const c = new Companion({ upstream: mock.upstream, queueStartTimeoutMs: 12, seekPollDelayMs: 3 });
  try {
    c.play({ track: TRACK, deviceId: SPEAKER.id }); await until(() => mock.calls.some(call => call.route === '/api/command'));
    const response = await c.control({ deviceId: SPEAKER.id, action: 'seek', positionMs: 60000 });
    // The previous call is still held: the UI response arrived before it finished.
    assert.equal(response.ok, false); assert.match(response.message, /This control was not sent/); assert.equal(c.seekStatus().active, false); assert.equal(mockControlCount(mock.calls), 0);
    held.resolve({ status: 'sent' }); await sleep(15); assert.equal(mockControlCount(mock.calls), 0);
  } finally { held.resolve({ status: 'sent' }); c.stop(); }
});

test('deadline check rejects an overdue queue entry even before its timeout callback runs', async () => {
  const held = deferred(); const mock = upstreamMock({ command: () => held.promise }); let now = 100000;
  const c = new Companion({ upstream: mock.upstream, queueStartTimeoutMs: 1000, clock: () => now });
  try {
    c.play({ track: TRACK, deviceId: SPEAKER.id }); await until(() => mock.calls.some(call => call.route === '/api/command'));
    const pending = c.control({ deviceId: SPEAKER.id, action: 'volume', volume: 35 });
    now += 1001; held.resolve({ status: 'sent' }); const response = await pending;
    assert.equal(response.ok, false); assert.match(response.message, /This control was not sent/); assert.equal(mockControlCount(mock.calls), 0);
  } finally { held.resolve({ status: 'sent' }); c.stop(); }
});

test('a control that starts within the queue deadline retains its normal operation budget', async () => {
  const held = deferred(); const mock = upstreamMock();
  const upstream = async (route, options) => { if (route === '/api/control') { mock.calls.push({ route, options }); return held.promise; } return mock.upstream(route, options); };
  const c = new Companion({ upstream, queueStartTimeoutMs: 5 }); let settled = false;
  try {
    const pending = c.control({ deviceId: SPEAKER.id, action: 'volume', volume: 35 }); pending.then(() => { settled = true; });
    await until(() => mockControlCount(mock.calls) === 1); await sleep(15); assert.equal(settled, false);
    held.resolve({ status: 'sent', volume: 35 }); const response = await pending; assert.equal(response.ok, true); assert.equal(mockControlCount(mock.calls), 1); assert.equal(mock.calls.at(-1).options.timeoutMs, 18000);
  } finally { held.resolve({ status: 'sent' }); c.stop(); }
});


test('paired job polling returns copied current and historical snapshots without more upstream reads', async t => {
  const mock = upstreamMock({ player: { state: 'PLAYING', title: TRACK.title, artist: TRACK.artist, providerName: PROVIDER.name } });
  const f = await fixture(t, mock), first = f.app.companion.play({ track: TRACK, deviceId: SPEAKER.id });
  await until(() => f.app.companion.status()?.state === 'matched');
  const count = mock.calls.length;
  const one = await f.request('/api/jobs/' + first.job.id, { headers: f.auth });
  assert.equal(one.response.status, 200); assert.equal(one.data.isCurrent, true); assert.equal(one.data.job.state, 'matched'); assert.equal(one.data.job.observationVerdict, 'match'); assert.equal(one.data.job.matchingSamples, 2); assert.equal(mock.calls.length, count);
  one.data.job.track.title = 'Mutated'; one.data.job.observation.title = 'Mutated';
  assert.equal(f.app.companion.jobStatus(first.job.id).job.track.title, TRACK.title);
  const second = f.app.companion.play({ track: { ...TRACK, title: 'Other' }, deviceId: SPEAKER.id });
  const old = await f.request('/api/jobs/' + first.job.id, { headers: f.auth });
  assert.equal(old.data.isCurrent, false); assert.equal(old.data.currentJobId, second.job.id); assert.equal(old.data.job.state, 'matched');
  assert.equal((await f.request('/api/jobs/' + first.job.id)).response.status, 403);
  assert.equal((await f.request('/api/jobs/missing', { headers: f.auth })).response.status, 404);
  f.app.companion.cancel(); assert.equal(f.app.companion.jobStatus(second.job.id).isCurrent, false);
});
test('a wrong Echo cannot release a song handoff even with matching song metadata', async () => {
  const mock = upstreamMock({ player: { state: 'PLAYING', deviceId: 'different-echo', title: TRACK.title, artist: TRACK.artist, providerName: PROVIDER.name } });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 3, pollAttempts: 2 });
  try { const first = c.play({ track: TRACK, deviceId: SPEAKER.id }); await until(() => !c.status().active); const result = c.jobStatus(first.job.id); assert.equal(result.job.state, 'unmatched'); assert.equal(result.job.observationVerdict, 'mismatch'); assert.equal(result.job.matchingSamples, 0); }
  finally { c.stop(); }
});
test('custom commands require paired access, bounded single-line text, and a connected selected Echo', async t => {
  const mock = upstreamMock(), f = await fixture(t, mock);
  assert.equal((await f.request('/api/command', { method: 'POST', body: { deviceId: SPEAKER.id, text: 'What time is it?' } })).response.status, 403);
  assert.equal((await f.request('/api/command', { method: 'POST', headers: { ...f.auth, Origin: 'https://evil.test' }, body: { deviceId: SPEAKER.id, text: 'What time is it?' } })).response.status, 403);
  for (const text of ['', ' ', 'stop\nplay', 'stop\u2028play', 'x'.repeat(501), null]) assert.equal((await f.request('/api/command', { method: 'POST', headers: f.auth, body: { deviceId: SPEAKER.id, text } })).response.status, 400);
  const result = await f.request('/api/command', { method: 'POST', headers: f.auth, body: { deviceId: 'unknown-echo', text: 'What time is it?' } });
  assert.equal(result.data.ok, false); assert.equal(result.data.status, 'not_sent'); assert.equal(mock.calls.filter(call => call.route === '/api/custom-command').length, 0);
});
test('a custom command cancels song checks, sends once for an idempotent request, and separates acceptance from response', async () => {
  const gate = deferred(), mock = upstreamMock({ customCommand: () => gate.promise });
  const c = new Companion({ upstream: mock.upstream, pollDelayMs: 1000 });
  try {
    const song = c.play({ track: TRACK, deviceId: SPEAKER.id }); await until(() => c.status()?.state === 'checking');
    const body = { deviceId: SPEAKER.id, text: 'What time is it?', requestId: 'manual-1' };
    const first = c.customCommand(body), duplicate = c.customCommand(body);
    assert.equal(c.jobStatus(song.job.id).isCurrent, false); assert.equal(c.status().state, 'cancelled');
    await until(() => mock.calls.some(call => call.route === '/api/custom-command'));
    gate.resolve({ status: 'sent', commandId: 'manual-command', command: { id: 'manual-command', text: body.text, kind: 'custom', deviceId: SPEAKER.id, status: 'sent', responseStatus: 'pending', response: 'unmatched answer', cookie: 'never-export' } });
    const result = await first; assert.equal(result.ok, true); assert.equal(result.confirmed, false); assert.equal(result.commandId, 'manual-command'); assert.equal(result.command.responseStatus, 'pending'); assert.equal(result.command.response, null); assert.equal(JSON.stringify(result).includes('never-export'), false);
    assert.deepEqual(await duplicate, result); assert.deepEqual(await c.customCommand(body), result);
    assert.equal(mock.calls.filter(call => call.route === '/api/custom-command').length, 1);
    assert.throws(() => c.customCommand({ ...body, text: 'Different command' }), { code: 'REQUEST_CHANGED' });
    assert.throws(() => c.play({ track: TRACK, deviceId: SPEAKER.id, requestId: 'manual-1' }), { code: 'REQUEST_CHANGED' });
  } finally { c.stop(); }
});
test('queued custom commands expire promptly and never dispatch later, while connection changes invalidate pending sends', async () => {
  const gate = deferred(), mock = upstreamMock(), c = new Companion({ upstream: mock.upstream, queueStartTimeoutMs: 15 });
  const held = c.queue(() => gate.promise);
  try {
    const result = await c.customCommand({ deviceId: SPEAKER.id, text: 'What time is it?', requestId: 'expired' });
    assert.equal(result.status, 'not_sent'); assert.equal(result.ok, false); assert.equal(mock.calls.length, 0);
    gate.resolve(); await held; await c.chain;
    assert.equal(mock.calls.filter(call => call.route === '/api/custom-command').length, 0);
    const statusGate = deferred(), original = c.upstream;
    c.upstream = (route, options) => route === '/api/status' ? statusGate.promise : original(route, options);
    const pending = c.customCommand({ deviceId: SPEAKER.id, text: 'What time is it?', requestId: 'connection-change' });
    await sleep(1); c.connectionChanged(); statusGate.resolve({ connection: { state: 'connected' }, devices: [SPEAKER] });
    assert.equal((await pending).status, 'cancelled'); assert.equal(mock.calls.filter(call => call.route === '/api/custom-command').length, 0);
  } finally { gate.resolve(); c.stop(); }
});
test('command history only exposes safe entries and independently available Alexa responses', async t => {
  const entry = { id: 'one', text: 'What time is it?', kind: 'custom', deviceId: SPEAKER.id, deviceName: SPEAKER.name, status: 'sent', message: 'raw cookie=never-export', createdAt: 100, updatedAt: 200, responseStatus: 'available', response: 'It is three o’clock.', cookie: 'never-export', observation: { state: 'PLAYING', title: 'Lover', artist: 'Taylor Swift', cookie: 'never-export' } };
  const mock = upstreamMock({ commands: [entry, { ...entry, id: 'two', responseStatus: 'ambiguous', response: 'wrong transcript' }, { ...entry, id: 'three', responseStatus: 'pending', response: 'wrong transcript' }, { ...entry, id: 'four', responseStatus: 'available', response: 'bad\ntranscript' }] });
  const f = await fixture(t, mock);
  assert.equal((await f.request('/api/commands')).response.status, 403);
  const result = await f.request('/api/commands', { headers: f.auth });
  assert.equal(result.data.retention, 'session'); assert.equal(result.data.commands.length, 4); assert.equal(result.data.commands[0].response, entry.response);
  assert.equal(JSON.stringify(result.data).includes('never-export'), false); assert.equal(JSON.stringify(result.data).includes('wrong transcript'), false);
  assert.equal(result.data.commands[1].responseStatus, 'ambiguous'); assert.equal(result.data.commands[3].responseStatus, 'unavailable');
});
test('custom command failures remain ambiguous and idempotent without leaking upstream errors', async () => {
  const mock = upstreamMock({ customCommand: () => { throw new Error('cookie=never-export'); } }), c = new Companion({ upstream: mock.upstream });
  try { const body = { deviceId: SPEAKER.id, text: 'What time is it?', requestId: 'failed' }; const result = await c.customCommand(body); assert.equal(result.ok, false); assert.equal(result.status, 'unverified'); assert.equal(JSON.stringify(result).includes('never-export'), false); assert.deepEqual(await c.customCommand(body), result); assert.equal(mock.calls.filter(call => call.route === '/api/custom-command').length, 1); }
  finally { c.stop(); }
});


const MAHIYA = { title: 'Mahiya', artist: "Pritam, Annie, Suzanne D'Mello & Sayeed Quadri", artistNames: ['Pritam', 'Annie', "Suzanne D'Mello", 'Sayeed Quadri'], album: 'Awarapan (Original Motion Picture Soundtrack)', durationMs: 264000, source: 'youtube-music' };
const MAHIYA_PLAYER = { state: 'PLAYING', title: 'Mahiya', artist: 'Pritam, Annie & Suzanne Dmello', providerName: 'Apple Music', durationMs: 264000 };
test('Mahiya matches a complete trusted artist subset with apostrophe spelling differences', () => {
  for (const artist of ['Pritam, Annie & Suzanne Dmello', 'Pritam, Annie and Suzanne Dmello', 'Pritam & Suzanne D’Mello', 'Suzanne Dmello']) assert.equal(compareReported(MAHIYA, { ...MAHIYA_PLAYER, artist }, PROVIDER), 'match', artist);
  for (const patch of [{ artist: 'Pritam, Annie & Another Artist' }, { artist: 'Pritam, Annie Mac & Suzanne Dmello' }, { artist: 'Pritam Singh, Annie & Suzanne Dmello' }, { artist: 'Pritam, Annie & Suzanne Dmellox' }, { artist: 'PritamAnnie & Suzanne Dmello' }, { artist: 'Pritam, Annie &' }, { artist: 'Pritam, Pritam & Annie' }, { providerName: 'Amazon Music' }, { durationMs: 290000 }, { title: 'Tere Piche' }]) assert.equal(compareReported(MAHIYA, { ...MAHIYA_PLAYER, ...patch }, PROVIDER), 'mismatch', JSON.stringify(patch));
  assert.equal(compareReported({ ...MAHIYA, artistNames: [] }, MAHIYA_PLAYER, PROVIDER), 'mismatch');
  assert.equal(compareReported({ ...MAHIYA, durationMs: undefined }, MAHIYA_PLAYER, PROVIDER), 'unknown');
  assert.equal(compareReported(MAHIYA, { ...MAHIYA_PLAYER, durationMs: undefined }, PROVIDER), 'unknown');
  assert.equal(compareReported(MAHIYA, MAHIYA_PLAYER, { id: 'alexa-default' }), 'unknown');
});
test('trusted subset matching preserves whole band names and rejects partial credits', () => {
  const track = { ...MAHIYA, title: 'Song', artist: 'Earth, Wind & Fire, Another Artist & Third Artist', artistNames: ['Earth, Wind & Fire', 'Another Artist', 'Third Artist'] };
  assert.equal(compareReported(track, { ...MAHIYA_PLAYER, title: 'Song', artist: 'Earth, Wind & Fire & Another Artist' }, PROVIDER), 'match');
  for (const artist of ['Earth & Another Artist', 'Wind & Fire & Another Artist', 'Earth, Wind & Fire & Unrelated Artist']) assert.equal(compareReported(track, { ...MAHIYA_PLAYER, title: 'Song', artist }, PROVIDER), 'mismatch', artist);
});
test('a soundtrack title qualifier matches only its exact corroborated source album', () => {
  for (const title of ['Mahiya (From Awarapan)', 'Mahiya (From "Awarapan")']) {
    assert.equal(compareReported(MAHIYA, { ...MAHIYA_PLAYER, title }, PROVIDER), 'match', title);
    assert.equal(compareReported({ ...MAHIYA, title }, MAHIYA_PLAYER, PROVIDER), 'match', title + ' reverse');
  }
  for (const album of ['', 'Different Album (Original Motion Picture Soundtrack)', 'Awarapan Deluxe', 'The Best of Awarapan']) assert.equal(compareReported({ ...MAHIYA, album }, { ...MAHIYA_PLAYER, title: 'Mahiya (From Awarapan)' }, PROVIDER), 'mismatch', album);
  const titles = ['Mahiya (From Different Film)', 'Mahiya (Live)', 'Mahiya (Remix)', 'Mahiya (Acoustic)', 'Mahiya (From Awarapan - Remix)', 'Mahiya (From Awarapan) (Live)', 'Mahiya (Live) (From Awarapan)', 'Mahiya (From Awarapan (Live))'];
  for (const title of titles) assert.equal(compareReported(MAHIYA, { ...MAHIYA_PLAYER, title }, PROVIDER), 'mismatch', title);
  assert.equal(compareReported({ ...MAHIYA, title: 'Mahiya (From Different Film)' }, { ...MAHIYA_PLAYER, title: 'Mahiya (From Awarapan)' }, PROVIDER), 'mismatch');
});
test('both actual Mahiya metadata forms stop retries after the correct first Pritam request', async () => {
  for (const player of [MAHIYA_PLAYER, { ...MAHIYA_PLAYER, title: 'Mahiya (From Awarapan)', artist: 'Pritam, Annie, Suzanne Dmello & Sayeed Quadri' }]) {
    const mock = upstreamMock({ player }), c = new Companion({ upstream: mock.upstream, pollDelayMs: 3, pollAttempts: 2 });
    try {
      c.play({ track: MAHIYA, deviceId: SPEAKER.id }); await until(() => !c.status().active);
      assert.equal(c.status().state, 'matched'); assert.equal(c.status().attempt, 1); assert.equal(c.status().matchingSamples, 2);
      assert.deepEqual(mock.calls.filter(call => call.route === '/api/command').map(call => call.options.body.text), ['play song Mahiya by Pritam on Apple Music']);
    } finally { c.stop(); }
  }
});
