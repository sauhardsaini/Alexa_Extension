import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SpotifyService } from '../spotify.mjs';

const CLIENT = 'a'.repeat(32), TRACK = 'T'.repeat(22), ARTIST = 'A'.repeat(22), PLAYLIST = 'P'.repeat(22);
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const song = (changes = {}) => ({ id: TRACK, type: 'track', uri: `spotify:track:${TRACK}`, name: 'OBVIOUS (feat. Hasan Raheem)', artists: [{ id: ARTIST, type: 'artist', name: 'Umair' }], album: { name: 'ROCKSTAR WITHOUT A GUITAR', images: [{ url: 'https://i.scdn.co/image/test' }] }, external_urls: { spotify: `https://open.spotify.com/track/${TRACK}` }, duration_ms: 195000, explicit: true, is_playable: true, ...changes });
const playlist = (id = PLAYLIST, changes = {}) => ({ id, type: 'playlist', name: 'My playlist', images: [{ url: 'https://mosaic.scdn.co/image/test' }], items: { total: 7 }, external_urls: { spotify: `https://open.spotify.com/playlist/${id}` }, ...changes });
function context(t, { profile = { account_id: 'spotify-account', country: 'IN' }, override } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-spotify-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = 1000, currentProfile = profile, count = 0;
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const custom = override ? await override(new URL(url), options, calls) : undefined;
    if (custom !== undefined) return custom;
    if (url.hostname === 'accounts.spotify.com' && url.pathname === '/api/token') return response({ access_token: 'fake-access-token-' + ++count, refresh_token: 'fake-refresh-token-' + count, token_type: 'Bearer', expires_in: 3600 });
    if (url.pathname === '/v1/me') return response(currentProfile);
    if (url.pathname === '/v1/search') return response({ tracks: { items: [song()] } });
    if (url.pathname === '/v1/tracks/' + TRACK) return response(song());
    if (url.pathname === '/v1/me/playlists') return response({ items: [playlist()], next: null });
    throw new Error('Unexpected mocked request');
  };
  const service = new SpotifyService({ dataDir, fetcher, clock: () => now });
  const connect = async () => {
    service.configure({ clientId: CLIENT });
    const authorization = service.beginAuthorization();
    const state = new URL(authorization.authorizationUrl).searchParams.get('state');
    await service.completeAuthorization({ code: 'fake-auth-code', state });
    return authorization;
  };
  return { service, dataDir, fetcher, calls, connect, tick: ms => { now += ms; }, setProfile: value => { currentProfile = value; }, clock: () => now };
}

test('optional Spotify setup has a fixed loopback callback and never exposes credentials', t => {
  const c = context(t);
  assert.equal(c.service.status().configured, false);
  assert.equal(c.service.status().catalogReady, false);
  assert.equal(c.service.status().redirectUri, 'http://127.0.0.1:4318/api/spotify/callback');
  assert.throws(() => c.service.beginAuthorization(), { code: 'SPOTIFY_SETUP_REQUIRED' });
  assert.throws(() => c.service.configure({ clientId: 'not-valid' }), { code: 'INVALID_SPOTIFY_CLIENT_ID' });
  assert.equal(c.service.configure({ clientId: CLIENT }).configured, true);
  assert.equal(fs.statSync(c.dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(c.dataDir, 'spotify-config.json')).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(c.service.status()).includes(CLIENT), false);
});

test('PKCE exchanges a one-time state and server-only verifier using the registered callback and minimal scopes', async t => {
  const c = context(t);
  const authorization = await c.connect();
  const url = new URL(authorization.authorizationUrl);
  assert.equal(url.origin, 'https://accounts.spotify.com');
  assert.equal(url.pathname, '/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), c.service.status().redirectUri);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(url.searchParams.get('scope').split(' '), ['user-read-private', 'playlist-read-private', 'playlist-read-collaborative']);
  assert.equal(authorization.expiresAt, 601000);
  const tokenCall = c.calls.find(call => call.url.pathname === '/api/token');
  const form = new URLSearchParams(tokenCall.options.body);
  const verifier = form.get('code_verifier');
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(form.get('client_id'), CLIENT);
  assert.equal(form.get('redirect_uri'), c.service.status().redirectUri);
  assert.equal(form.has('client_secret'), false);
  assert.equal(tokenCall.options.method, 'POST');
  assert.equal(tokenCall.options.redirect, 'error');
  assert.ok(tokenCall.options.signal instanceof AbortSignal);
  assert.equal(c.service.status().connected, true);
  assert.equal(c.service.status().country, 'IN');
  assert.equal(c.service.status().catalogReady, true);
  await assert.rejects(c.service.completeAuthorization({ code: 'fake-auth-code', state: url.searchParams.get('state') }), { code: 'INVALID_SPOTIFY_STATE' });
  const publicStatus = JSON.stringify(c.service.status());
  assert.equal(publicStatus.includes('fake-access'), false);
  assert.equal(publicStatus.includes('fake-refresh'), false);
  assert.equal(publicStatus.includes(verifier), false);
  assert.equal(fs.statSync(path.join(c.dataDir, 'spotify-user.json')).mode & 0o777, 0o600);
  const restored = new SpotifyService({ dataDir: c.dataDir, fetcher: c.fetcher, clock: c.clock });
  assert.equal(restored.status().connected, true);
  assert.equal(restored.status().country, 'IN');
});

test('invalid, expired, denied, and non-ASCII state callbacks are consumed without token requests', async t => {
  for (const variant of ['wrong', 'expired', 'denied', 'unicode']) await t.test(variant, async t => {
    const c = context(t); c.service.configure({ clientId: CLIENT });
    const original = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
    if (variant === 'expired') c.tick(600000);
    const state = variant === 'wrong' ? 'x'.repeat(43) : variant === 'unicode' ? 'é'.repeat(43) : original;
    await assert.rejects(c.service.completeAuthorization({ code: 'fake-auth-code', state, ...(variant === 'denied' ? { error: 'raw-upstream-secret' } : {}) }), error => !error.message.includes('raw-upstream-secret'));
    await assert.rejects(c.service.completeAuthorization({ code: 'fake-auth-code', state: original }), { code: 'INVALID_SPOTIFY_STATE' });
    assert.equal(c.calls.length, 0);
  });
});

test('current development-mode profiles may connect without country while country-specific search stays blocked', async t => {
  const c = context(t, { profile: { account_id: 'account-without-country', display_name: 'Listener' } });
  await c.connect();
  assert.equal(c.service.status().connected, true);
  assert.equal(c.service.status().country, null);
  assert.equal(c.service.status().catalogReady, false);
  await assert.rejects(c.service.search('OBVIOUS', 'IN'), { code: 'SPOTIFY_COUNTRY_UNAVAILABLE' });
  const result = await c.service.playlists();
  assert.equal(result.playlists.length, 1, 'personal playlists do not claim India track availability');
  assert.equal(c.calls.some(call => call.url.pathname === '/v1/search'), false);
});

test('account market must equal the selected country before any catalogue request', async t => {
  const c = context(t, { profile: { id: 'legacy-account', country: 'US' } });
  await c.connect();
  const before = c.calls.length;
  await assert.rejects(c.service.search('OBVIOUS', 'IN'), { code: 'SPOTIFY_COUNTRY_MISMATCH' });
  assert.equal(c.calls.length, before);
  assert.equal(c.service.status().country, 'US');
});

test('Spotify search uses the current ten-result API contract and returns opaque immutable country-bound choices', async t => {
  const c = context(t); await c.connect();
  const result = await c.service.search('OBVIOUS', 'IN');
  assert.equal(result.source, 'spotify');
  assert.equal(result.country, 'IN');
  assert.equal(result.availability, 'catalogue-playable');
  const selected = result.tracks[0];
  assert.notEqual(selected.id, TRACK);
  assert.equal(selected.title, 'OBVIOUS (feat. Hasan Raheem)');
  assert.equal(selected.artist, 'Umair');
  assert.equal(selected.durationMs, 195000);
  assert.equal(selected.explicit, true);
  const searchCall = c.calls.find(call => call.url.pathname === '/v1/search');
  assert.equal(searchCall.url.searchParams.get('type'), 'track');
  assert.equal(searchCall.url.searchParams.get('market'), 'IN');
  assert.equal(searchCall.url.searchParams.get('limit'), '10');
  selected.title = 'mutated';
  assert.equal((await c.service.search('obvious', 'IN')).tracks[0].title, 'OBVIOUS (feat. Hasan Raheem)');
  const prepared = await c.service.prepareTrack(selected.id, 'IN');
  assert.equal(prepared.id, selected.id);
  assert.equal(prepared.requestArtist, 'Umair');
  assert.deepEqual(prepared.requestArtists, ['Umair']);
  const trackCall = c.calls.find(call => call.url.pathname === '/v1/tracks/' + TRACK);
  assert.equal(trackCall.url.searchParams.get('market'), 'IN');
  await assert.rejects(c.service.prepareTrack(selected.id, 'US'), { code: 'SPOTIFY_COUNTRY_MISMATCH' });
  await assert.rejects(c.service.prepareTrack('forged', 'IN'), { code: 'EXPIRED_RESULT' });
  c.tick(31 * 60000);
  assert.throws(() => c.service.getTrack(selected.id), { code: 'EXPIRED_RESULT' });
});

test('unplayable, restricted, unsafe, local, and foreign-market tracks are filtered; absent playability stays unverified', async t => {
  const changeId = (id, changes) => song({ id, uri: `spotify:track:${id}`, external_urls: { spotify: `https://open.spotify.com/track/${id}` }, ...changes });
  const rows = [song({ is_playable: undefined }), changeId('B'.repeat(22), { is_playable: false }), changeId('C'.repeat(22), { restrictions: { reason: 'market' } }), changeId('D'.repeat(22), { is_local: true }), changeId('E'.repeat(22), { available_markets: ['US'] }), changeId('F'.repeat(22), { external_urls: { spotify: `https://evil.example/track/${'F'.repeat(22)}` } }), changeId('G'.repeat(22), { external_urls: { spotify: `https://open.spotify.com/track/${'X'.repeat(22)}` } })];
  const c = context(t, { override: url => url.pathname === '/v1/search' ? response({ tracks: { items: rows } }) : undefined });
  await c.connect();
  const result = await c.service.search('OBVIOUS', 'IN');
  assert.equal(result.tracks.length, 1);
  assert.equal(result.availability, 'unverified');
});

test('preparation fails closed when Spotify removes a recording or returns a relinked different identifier', async t => {
  for (const kind of ['unplayable', 'different-id', 'not-found']) await t.test(kind, async t => {
    const c = context(t, { override: url => url.pathname.startsWith('/v1/tracks/') ? kind === 'not-found' ? response({}, 404) : response(kind === 'unplayable' ? song({ is_playable: false }) : song({ id: 'Z'.repeat(22) })) : undefined });
    await c.connect();
    const id = (await c.service.search('OBVIOUS')).tracks[0].id;
    await assert.rejects(c.service.prepareTrack(id), { code: 'SPOTIFY_SONG_UNAVAILABLE' });
    assert.throws(() => c.service.getTrack(id), { code: 'EXPIRED_RESULT' });
  });
});

test('expired access tokens refresh once across concurrent requests and preserve a non-rotated refresh token', async t => {
  const c = context(t, { override: (url, options) => url.pathname === '/api/token' && new URLSearchParams(options.body).get('grant_type') === 'refresh_token' ? response({ access_token: 'fake-refreshed-access', token_type: 'Bearer', expires_in: 3600 }) : undefined });
  await c.connect(); c.tick(3600000);
  const results = await Promise.all([c.service.search('First song'), c.service.search('Second song')]);
  assert.equal(results.length, 2);
  const refreshes = c.calls.filter(call => call.url.pathname === '/api/token' && new URLSearchParams(call.options.body).get('grant_type') === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(new URLSearchParams(refreshes[0].options.body).get('client_id'), CLIENT);
  const saved = JSON.parse(fs.readFileSync(path.join(c.dataDir, 'spotify-user.json'), 'utf8'));
  assert.equal(saved.refreshToken, 'fake-refresh-token-1');
  assert.equal(saved.accessToken, 'fake-refreshed-access');
  assert.equal(fs.statSync(path.join(c.dataDir, 'spotify-user.json')).mode & 0o777, 0o600);
});

test('refresh detects a changed account country before sending a catalogue request in the old country', async t => {
  const c = context(t); await c.connect();
  const id = (await c.service.search('First song')).tracks[0].id;
  c.tick(3600000); c.setProfile({ account_id: 'spotify-account', country: 'US' });
  await assert.rejects(c.service.search('Second song', 'IN'), { code: 'SPOTIFY_CONNECTION_CHANGED' });
  assert.equal(c.service.status().country, 'US');
  assert.equal(c.calls.filter(call => call.url.pathname === '/v1/search').length, 1);
  assert.throws(() => c.service.getTrack(id), { code: 'EXPIRED_RESULT' });
});

test('revoked refresh authorization removes the user session while keeping optional app setup', async t => {
  const c = context(t, { override: (url, options) => url.pathname === '/api/token' && new URLSearchParams(options.body).get('grant_type') === 'refresh_token' ? response({ error: 'invalid_grant', detail: 'secret' }, 400) : undefined });
  await c.connect(); c.tick(3600000);
  await assert.rejects(c.service.search('OBVIOUS'), error => error.code === 'SPOTIFY_REFRESH_REJECTED' && !error.message.includes('secret'));
  assert.equal(c.service.status().configured, true);
  assert.equal(c.service.status().connected, false);
  assert.equal(fs.existsSync(path.join(c.dataDir, 'spotify-user.json')), false);
});

test('late token and profile callbacks cannot restore an account after disconnect', async t => {
  for (const point of ['token', 'profile-json']) await t.test(point, async t => {
    const entered = deferred(), block = deferred();
    const c = context(t, { override: async url => {
      if (point === 'token' && url.pathname === '/api/token') { entered.resolve(); return block.promise; }
      if (point === 'profile-json' && url.pathname === '/v1/me') return { status: 200, ok: true, json: async () => { entered.resolve(); return block.promise; } };
    } });
    c.service.configure({ clientId: CLIENT });
    const state = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
    const pending = c.service.completeAuthorization({ code: 'fake-auth-code', state });
    await entered.promise; c.service.disconnect();
    block.resolve(point === 'token' ? response({ access_token: 'fake-late-access', refresh_token: 'fake-late-refresh', token_type: 'Bearer', expires_in: 3600 }) : { account_id: 'late-account', country: 'IN' });
    await assert.rejects(pending, { code: 'SPOTIFY_CONNECTION_CHANGED' });
    assert.equal(c.service.status().connected, false);
    assert.equal(fs.existsSync(path.join(c.dataDir, 'spotify-user.json')), false);
  });
});

test('API access errors are authored and do not include upstream response diagnostics', async t => {
  for (const status of [401, 403, 429, 500]) await t.test(String(status), async t => {
    const c = context(t, { override: url => url.pathname === '/v1/search' ? response({ error: { message: 'secret-diagnostic', access_token: 'secret' } }, status) : undefined });
    await c.connect();
    await assert.rejects(c.service.search('OBVIOUS'), error => !error.message.includes('secret'));
  });
});

test('personal playlists use opaque choices, current item counts, safe artwork and independent cached copies', async t => {
  const c = context(t, { override: url => url.pathname === '/v1/me/playlists' ? response({ items: [playlist(PLAYLIST, { tracks: { total: 99 } }), playlist('Q'.repeat(22), { external_urls: { spotify: 'https://evil.example/playlist/id' } })], next: null }) : undefined });
  await c.connect();
  const [first, concurrent] = await Promise.all([c.service.playlists(), c.service.playlists()]);
  assert.equal(first.playlists.length, 1);
  assert.equal(first.truncated, false);
  const item = first.playlists[0];
  assert.notEqual(item.id, PLAYLIST);
  assert.equal(item.source, 'spotify');
  assert.equal(item.itemCount, 7);
  assert.equal(item.artwork, 'https://mosaic.scdn.co/image/test');
  assert.equal(c.service.playlist(item.id).title, 'My playlist');
  item.title = 'mutated';
  assert.equal(concurrent.playlists[0].title, 'My playlist');
  assert.equal((await c.service.playlists()).playlists[0].title, 'My playlist');
  assert.equal(c.calls.filter(call => call.url.pathname === '/v1/me/playlists').length, 1);
  c.service.disconnect();
  assert.throws(() => c.service.playlist(item.id), { code: 'EXPIRED_PLAYLIST' });
  assert.equal(c.service.status().configured, true);
});

test('playlist paging is capped at 200 and does not follow unsafe upstream pagination URLs', async t => {
  await t.test('bounded pages', async t => {
    const c = context(t, { override: url => {
      if (url.pathname !== '/v1/me/playlists') return undefined;
      const offset = Number(url.searchParams.get('offset'));
      return response({ items: Array.from({ length: 50 }, (_, i) => playlist(String(offset + i).padStart(22, '0'))), next: `https://api.spotify.com/v1/me/playlists?limit=50&offset=${offset + 50}` });
    } });
    await c.connect();
    const result = await c.service.playlists();
    assert.equal(result.playlists.length, 200);
    assert.equal(result.truncated, true);
    assert.equal(c.calls.filter(call => call.url.pathname === '/v1/me/playlists').length, 4);
  });
  await t.test('unsafe next URL', async t => {
    const c = context(t, { override: url => url.pathname === '/v1/me/playlists' ? response({ items: [], next: 'https://evil.example/v1/me/playlists?token=secret' }) : undefined });
    await c.connect();
    await assert.rejects(c.service.playlists(), { code: 'SPOTIFY_UNAVAILABLE' });
    assert.equal(c.calls.some(call => call.url.hostname === 'evil.example'), false);
  });
});


test('a newer login prevents an older in-flight callback from establishing a session', async t => {
  const entered = deferred(), block = deferred();
  const c = context(t, { override: async url => {
    if (url.pathname === '/api/token') { entered.resolve(); return block.promise; }
  } });
  c.service.configure({ clientId: CLIENT });
  const first = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
  const pending = c.service.completeAuthorization({ code: 'first-auth-code', state: first });
  await entered.promise;
  const second = c.service.beginAuthorization();
  assert.notEqual(new URL(second.authorizationUrl).searchParams.get('state'), first);
  block.resolve(response({ access_token: 'fake-old-access', refresh_token: 'fake-old-refresh', token_type: 'Bearer', expires_in: 3600 }));
  await assert.rejects(pending, { code: 'SPOTIFY_CONNECTION_CHANGED' });
  assert.equal(c.service.status().connected, false);
  assert.equal(fs.existsSync(path.join(c.dataDir, 'spotify-user.json')), false);
});
