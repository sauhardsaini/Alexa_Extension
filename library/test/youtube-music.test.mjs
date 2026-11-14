import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { YouTubeMusicService } from '../youtube-music.mjs';

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const credentials = { clientId: '123456789012-desktoptestclient123.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-client-secret-private' };
const tokenPayload = (extra = {}) => ({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', expires_in: 3600, token_type: 'Bearer', scope: SCOPE, ...extra });
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const playlistRow = (id = 'PLexample', title = 'My music') => ({ kind: 'youtube#playlist', id, snippet: { title, thumbnails: { high: { url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' } } }, contentDetails: { itemCount: 8 } });
const item = (id = 'item-one', title = 'Artist - Song (Official Music Video)', owner = 'Video channel') => ({ kind: 'youtube#playlistItem', id, snippet: { title, channelTitle: 'Playlist Owner Must Not Become Artist', videoOwnerChannelTitle: owner, resourceId: { kind: 'youtube#video', videoId: 'abcdefghijk' }, thumbnails: { medium: { url: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg' } } }, contentDetails: { videoId: 'abcdefghijk' }, status: { privacyStatus: 'public' } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(handler = null) {
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, '.youtube-scratch-'));
  let now = NOW;
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (handler) { const handled = await handler(new URL(url), options, calls); if (handled !== undefined) return handled; }
    if (url.origin === 'https://oauth2.googleapis.com') return response(tokenPayload());
    if (url.searchParams.get('part') === 'id') return response({ kind: 'youtube#playlistListResponse', items: [] });
    if (url.pathname.endsWith('/playlists')) return response({ kind: 'youtube#playlistListResponse', items: [playlistRow()] });
    if (url.pathname.endsWith('/playlistItems')) return response({ kind: 'youtube#playlistItemListResponse', items: [item()] });
    throw new Error('unexpected test request');
  };
  const service = new YouTubeMusicService({ dataDir: dir, port: 4318, fetcher, clock: () => now });
  return { dir, service, calls, tick: ms => { now += ms; }, async connect() { service.configure(credentials); const auth = service.beginAuthorization(); await service.completeAuthorization({ state: new URL(auth.authorizationUrl).searchParams.get('state'), code: 'test-code-value' }); }, cleanup() { service.disconnect(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('YouTube is optional and missing setup fails without any external request', async () => {
  const c = fixture();
  try {
    assert.equal(c.service.status().source, 'youtube-music');
    assert.equal(c.service.status().configured, false);
    assert.equal(c.service.status().redirectUri, 'http://127.0.0.1:4318/api/youtube/callback');
    assert.throws(() => c.service.beginAuthorization(), { code: 'YOUTUBE_SETUP_REQUIRED' });
    await assert.rejects(c.service.playlists(), { code: 'YOUTUBE_SETUP_REQUIRED' });
    assert.equal(c.calls.length, 0);
  } finally { c.cleanup(); }
});

test('Desktop configuration is private, safe in status, and validates Google credential format', () => {
  const c = fixture();
  try {
    for (const value of [{}, { ...credentials, clientId: 'attacker.example' }, { ...credentials, clientSecret: 'secret\nvalue' }]) assert.throws(() => c.service.configure(value), { code: 'INVALID_YOUTUBE_CONFIGURATION' });
    const status = c.service.configure(credentials);
    assert.equal(status.configured, true);
    assert.equal(status.connected, false);
    assert.equal(JSON.stringify(status).includes(credentials.clientSecret), false);
    assert.equal(JSON.stringify(status).includes(credentials.clientId), false);
    assert.equal(fs.statSync(c.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(c.dir, 'youtube-config.json')).mode & 0o777, 0o600);
    const restored = new YouTubeMusicService({ dataDir: c.dir });
    assert.equal(restored.status().configured, true);
  } finally { c.cleanup(); }
});

test('authorization uses a fixed loopback callback, one read-only scope, and PKCE matched to the code exchange', async () => {
  const c = fixture();
  try {
    c.service.configure(credentials);
    const auth = c.service.beginAuthorization();
    const url = new URL(auth.authorizationUrl);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('scope'), SCOPE);
    assert.equal(url.searchParams.get('redirect_uri'), c.service.status().redirectUri);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.has('client_secret'), false);
    assert.equal(auth.expiresAt, NOW + 10 * 60_000);
    const state = url.searchParams.get('state');
    assert.equal(state.length, 43);
    await c.service.completeAuthorization({ state, code: 'test-code' });
    const exchange = c.calls.find(call => call.url.origin === 'https://oauth2.googleapis.com');
    const body = new URLSearchParams(exchange.options.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('client_secret'), credentials.clientSecret);
    assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:4318/api/youtube/callback');
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
    const verification = c.calls.find(call => call.url.searchParams.get('part') === 'id');
    assert.equal(verification.url.pathname, '/youtube/v3/playlists');
    assert.equal(verification.url.searchParams.get('mine'), 'true');
    assert.equal(verification.options.headers.Authorization, 'Bearer private-access-token');
    assert.equal(c.service.status().connected, true);
    assert.equal(fs.statSync(path.join(c.dir, 'youtube-tokens.json')).mode & 0o777, 0o600);
    await assert.rejects(c.service.completeAuthorization({ state, code: 'replayed-code' }), { code: 'INVALID_YOUTUBE_STATE' });
  } finally { c.cleanup(); }
});

test('bad, expired, cancelled, and superseded OAuth state cannot save tokens', async () => {
  const c = fixture();
  try {
    c.service.configure(credentials);
    let state = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
    await assert.rejects(c.service.completeAuthorization({ state: 'x'.repeat(43), code: 'code' }), { code: 'INVALID_YOUTUBE_STATE' });
    await assert.rejects(c.service.completeAuthorization({ state: 'é'.repeat(43), code: 'code' }), { code: 'INVALID_YOUTUBE_STATE' });
    await assert.rejects(c.service.completeAuthorization({ state, error: 'private-diagnostic-denied' }), { code: 'YOUTUBE_AUTH_CANCELLED' });
    state = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
    c.tick(10 * 60_000);
    await assert.rejects(c.service.completeAuthorization({ state, code: 'code' }), { code: 'INVALID_YOUTUBE_STATE' });
    const old = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
    c.service.beginAuthorization();
    await assert.rejects(c.service.completeAuthorization({ state: old, code: 'code' }), { code: 'INVALID_YOUTUBE_STATE' });
    assert.equal(c.calls.length, 0);
    assert.equal(fs.existsSync(path.join(c.dir, 'youtube-tokens.json')), false);
  } finally { c.cleanup(); }
});

test('API authorization is verified before persistence and raw Google errors are never exposed', async () => {
  const secret = 'private-upstream-token-diagnostic';
  const c = fixture(async url => url.origin === 'https://www.googleapis.com' ? response({ error: { message: secret } }, 403) : undefined);
  try {
    c.service.configure(credentials);
    const state = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
    await assert.rejects(c.service.completeAuthorization({ state, code: 'code' }), error => error.code === 'YOUTUBE_ACCESS_DENIED' && !error.message.includes(secret));
    assert.equal(c.service.status().connected, false);
    assert.equal(fs.existsSync(path.join(c.dir, 'youtube-tokens.json')), false);
  } finally { c.cleanup(); }
});

test('broader or missing initial scopes are rejected before YouTube access or token storage', async () => {
  for (const scope of [undefined, SCOPE + ' https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube']) {
    const c = fixture(async url => url.origin === 'https://oauth2.googleapis.com' ? response(tokenPayload({ scope })) : undefined);
    try {
      c.service.configure(credentials);
      const state = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
      await assert.rejects(c.service.completeAuthorization({ state, code: 'code' }), { code: 'YOUTUBE_AUTH_REJECTED' });
      assert.equal(c.calls.length, 1);
      assert.equal(fs.existsSync(path.join(c.dir, 'youtube-tokens.json')), false);
    } finally { c.cleanup(); }
  }
});

test('owned playlists have opaque local IDs, safe artwork, and only trusted selections can be opened', async () => {
  const c = fixture(async url => url.pathname.endsWith('/playlists') && url.searchParams.get('part') !== 'id' ? response({ items: [playlistRow(), { ...playlistRow('bad-playlist'), snippet: { title: 'unsafe\nname' } }, { ...playlistRow('no-art'), snippet: { title: 'No artwork', thumbnails: { high: { url: 'https://attacker.example/image' } } } }] }) : undefined);
  try {
    await c.connect();
    const result = await c.service.playlists();
    assert.equal(result.truncated, false);
    assert.equal(result.playlists.length, 2);
    assert.notEqual(result.playlists[0].id, 'PLexample');
    assert.equal(result.playlists[0].source, 'youtube-music');
    assert.equal(result.playlists[1].artwork, null);
    const listRequest = c.calls.find(call => call.url.searchParams.get('part') === 'snippet,contentDetails');
    assert.equal(listRequest.url.searchParams.get('mine'), 'true');
    assert.equal(listRequest.url.searchParams.get('maxResults'), '50');
    const count = c.calls.length;
    await assert.rejects(c.service.playlist('PLexample'), { code: 'YOUTUBE_PLAYLIST_EXPIRED' });
    await assert.rejects(c.service.playlist('https://attacker.example'), { code: 'YOUTUBE_PLAYLIST_EXPIRED' });
    assert.equal(c.calls.length, count);
    result.playlists[0].title = 'client mutation';
    assert.equal((await c.service.playlists()).playlists[0].title, 'My music');
  } finally { c.cleanup(); }
});

test('playlist tracks infer artists conservatively and preserve recording versions', async () => {
  const c = fixture(async url => url.pathname.endsWith('/playlistItems') ? response({ items: [
    item('topic', 'Save Your Tears (Official Audio)', 'The Weeknd - Topic'),
    item('delimited', 'Taylor Swift - Lover (Official Music Video)'),
    item('live', 'Band - Song (Live)'), item('remix', 'Band - Song [Remix]'),
    item('unclear', 'A useful song title (Lyrics)'), item('many-delimiters', 'Artist - Song - Live'),
    item('deleted', 'Deleted video'), item('private', 'Private video'),
    { ...item('private-status'), status: { privacyStatus: 'private' } },
    { ...item('bad-video'), contentDetails: { videoId: 'bad' } },
  ] }) : undefined);
  try {
    await c.connect();
    const listed = await c.service.playlists();
    const result = await c.service.playlist(listed.playlists[0].id);
    assert.equal(result.source, 'youtube-music');
    assert.equal(result.tracks.length, 6);
    assert.deepEqual(result.tracks.map(track => [track.title, track.artist, track.needsReview]), [
      ['Save Your Tears', 'The Weeknd', false], ['Lover', 'Taylor Swift', false],
      ['Song (Live)', 'Band', false], ['Song [Remix]', 'Band', false],
      ['A useful song title', '', true], ['Artist - Song - Live', '', true],
    ]);
    for (const track of result.tracks) {
      assert.equal(track.durationMs, 0);
      assert.equal(track.url, 'https://www.youtube.com/watch?v=abcdefghijk');
      assert.notEqual(track.artist, 'Playlist Owner Must Not Become Artist');
    }
    assert.equal(c.service.getTrack(result.tracks[0].id).artist, 'The Weeknd');
    assert.throws(() => c.service.getTrack('forged-track'), { code: 'YOUTUBE_TRACK_EXPIRED' });
  } finally { c.cleanup(); }
});

test('pagination is bounded to 200 playlists and 500 ordered playlist items, with honest truncation', async () => {
  let lists = 0, items = 0;
  const c = fixture(async url => {
    if (url.pathname.endsWith('/playlists') && url.searchParams.get('part') !== 'id') {
      const page = lists++;
      return response({ items: Array.from({ length: 50 }, (_, index) => playlistRow('PLpage' + page + '-' + index)), nextPageToken: 'list-next-' + page });
    }
    if (url.pathname.endsWith('/playlistItems')) {
      const page = items++;
      return response({ items: Array.from({ length: 50 }, (_, index) => item('item-' + page + '-' + index, 'Artist - Song ' + (page * 50 + index))), nextPageToken: 'items-next-' + page });
    }
  });
  try {
    await c.connect();
    const result = await c.service.playlists();
    assert.equal(result.playlists.length, 200);
    assert.equal(result.truncated, true);
    assert.equal(lists, 4);
    const playlist = await c.service.playlist(result.playlists[0].id);
    assert.equal(playlist.tracks.length, 500);
    assert.equal(playlist.truncated, true);
    assert.equal(items, 10);
    assert.equal(playlist.tracks[0].title, 'Song 0');
    assert.equal(playlist.tracks[499].title, 'Song 499');
    assert.equal(new Set(playlist.tracks.map(track => track.id)).size, 500);
  } finally { c.cleanup(); }
});

test('repeated page tokens stop pagination and duplicate playlist entries do not multiply', async () => {
  let pages = 0;
  const c = fixture(async url => url.pathname.endsWith('/playlists') && url.searchParams.get('part') !== 'id' ? response({ items: [playlistRow()], nextPageToken: (++pages, 'same-page') }) : undefined);
  try {
    await c.connect();
    const result = await c.service.playlists();
    assert.equal(result.playlists.length, 1);
    assert.equal(result.truncated, true);
    assert.equal(pages, 2);
  } finally { c.cleanup(); }
});

test('expired access tokens refresh once across simultaneous playlist requests', async () => {
  let refreshes = 0;
  const c = fixture(async (url, options) => {
    if (url.origin === 'https://oauth2.googleapis.com' && new URLSearchParams(options.body).get('grant_type') === 'refresh_token') {
      refreshes++;
      return response(tokenPayload({ access_token: 'private-refreshed-token', refresh_token: undefined, scope: undefined }));
    }
    if (url.origin === 'https://oauth2.googleapis.com') return response(tokenPayload({ expires_in: 120 }));
  });
  try {
    await c.connect();
    const initial = await c.service.playlists();
    c.tick(121 * 1000);
    await Promise.all([c.service.playlists(), c.service.playlist(initial.playlists[0].id)]);
    assert.equal(refreshes, 1);
    const refreshedCalls = c.calls.filter(call => call.options.headers?.Authorization === 'Bearer private-refreshed-token');
    assert.equal(refreshedCalls.length, 2);
    assert.equal(c.service.status().connected, true);
  } finally { c.cleanup(); }
});

test('invalid refresh grants remove the local connection while retaining app setup', async () => {
  const c = fixture(async (url, options) => url.origin === 'https://oauth2.googleapis.com' && new URLSearchParams(options.body).get('grant_type') === 'refresh_token' ? response({ error: 'invalid_grant', error_description: 'private-secret-error' }, 400) : undefined);
  try {
    await c.connect();
    c.tick(3600 * 1000);
    await assert.rejects(c.service.playlists(), error => error.code === 'YOUTUBE_AUTH_REQUIRED' && !error.message.includes('secret'));
    assert.equal(c.service.status().configured, true);
    assert.equal(c.service.status().connected, false);
    assert.equal(fs.existsSync(path.join(c.dir, 'youtube-tokens.json')), false);
  } finally { c.cleanup(); }
});

test('disconnect prevents delayed authorization from persisting credentials and aborts its request', async () => {
  const gate = deferred(); let signal;
  const c = fixture(async (url, options) => {
    if (url.origin === 'https://oauth2.googleapis.com') { signal = options.signal; await gate.promise; return response(tokenPayload()); }
  });
  try {
    c.service.configure(credentials);
    const state = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
    const pending = c.service.completeAuthorization({ state, code: 'test-code' });
    c.service.disconnect();
    assert.equal(signal.aborted, true);
    gate.resolve();
    await assert.rejects(pending, { code: 'YOUTUBE_CONNECTION_CHANGED' });
    assert.equal(fs.existsSync(path.join(c.dir, 'youtube-tokens.json')), false);
  } finally { gate.resolve(); c.cleanup(); }
});

test('late playlist results cannot repopulate trusted IDs after disconnect', async () => {
  const gate = deferred(), entered = deferred();
  let hold = false;
  const c = fixture(async url => {
    if (hold && url.pathname.endsWith('/playlists')) { entered.resolve(); await gate.promise; return response({ items: [playlistRow()] }); }
  });
  try {
    await c.connect(); hold = true;
    const pending = c.service.playlists();
    await entered.promise;
    c.service.disconnect(); gate.resolve();
    await assert.rejects(pending, { code: 'YOUTUBE_CONNECTION_CHANGED' });
    assert.equal(c.service.playlistEntries.size, 0);
    assert.equal(c.service.status().connected, false);
  } finally { gate.resolve(); c.cleanup(); }
});

test('tokens restore privately and disconnect removes only account tokens', async () => {
  const c = fixture();
  try {
    await c.connect();
    const restored = new YouTubeMusicService({ dataDir: c.dir, clock: () => NOW });
    assert.equal(restored.status().connected, true);
    assert.equal(JSON.stringify(restored.status()).includes('private-'), false);
    restored.disconnect();
    assert.equal(restored.status().configured, true);
    assert.equal(restored.status().connected, false);
    assert.equal(fs.existsSync(path.join(c.dir, 'youtube-tokens.json')), false);
    assert.equal(fs.existsSync(path.join(c.dir, 'youtube-config.json')), true);
  } finally { c.cleanup(); }
});


test('a newly started sign-in supersedes an older code exchange still in flight', async () => {
  const gate = deferred(); let first = true;
  const c = fixture(async url => {
    if (url.origin === 'https://oauth2.googleapis.com' && first) { first = false; await gate.promise; return response(tokenPayload()); }
  });
  try {
    c.service.configure(credentials);
    const oldState = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
    const old = c.service.completeAuthorization({ state: oldState, code: 'old-code' });
    const newState = new URL(c.service.beginAuthorization().authorizationUrl).searchParams.get('state');
    gate.resolve();
    await assert.rejects(old, { code: 'YOUTUBE_CONNECTION_CHANGED' });
    assert.equal(fs.existsSync(path.join(c.dir, 'youtube-tokens.json')), false);
    await c.service.completeAuthorization({ state: newState, code: 'new-code' });
    assert.equal(c.service.status().connected, true);
  } finally { gate.resolve(); c.cleanup(); }
});


test('connected YouTube songs use validated video thumbnails when the API omits artwork', async () => {
  const row = item(); delete row.snippet.thumbnails;
  const c = fixture(async url => url.pathname.endsWith('/playlistItems') ? response({ items: [row] }) : undefined);
  try {
    await c.connect();
    const lists = await c.service.playlists();
    const result = await c.service.playlist(lists.playlists[0].id);
    assert.equal(result.tracks[0].artwork, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  } finally { c.cleanup(); }
});
