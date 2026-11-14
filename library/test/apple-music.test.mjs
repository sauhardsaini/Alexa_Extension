import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, verify } from 'node:crypto';
import { AppleMusicService } from '../apple-music.mjs';

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 10, 13, 10, 0, 0);
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const credentials = { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: keys.privateKey };
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function song(id = '123', country = 'in', change = {}) {
  return { id, type: 'songs', href: `/v1/catalog/${country}/songs/${id}`, attributes: { name: 'Darmiyaan (From "Musafir Cafe")', artistName: 'Rekha Bhardwaj, Raghav Kaushik & Amrita Saluja', albumName: 'Musafir Cafe', playParams: { kind: 'song', id }, url: `https://music.apple.com/${country}/album/test/100?i=${id}`, artwork: { url: 'https://is1-ssl.mzstatic.com/image/{w}x{h}.jpg' }, durationInMillis: 200000, contentRating: 'explicit', ...change }, relationships: { artists: { data: [{ id: '99', type: 'artists', attributes: { name: 'Rekha Bhardwaj' } }] } } };
}
function context(fetcher = async () => response({ results: { songs: { data: [song()] } } })) {
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, '.apple-scratch-'));
  let now = NOW;
  const service = new AppleMusicService({ dataDir: dir, fetcher, clock: () => now });
  return { dir, service, tick: ms => { now += ms; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('Apple search fails closed without credentials and never fabricates India availability', async () => {
  const c = context(() => { throw new Error('must not call upstream'); });
  try {
    assert.deepEqual(c.service.status(), { configured: false, connected: false, needsSetup: true, message: 'Add your Apple Music app credentials, then sign in to verify your catalogue country.', storefront: null, source: 'apple-music' });
    await assert.rejects(c.service.search('Darmiyaan', 'IN'), { status: 503, code: 'APPLE_SETUP_REQUIRED' });
    assert.throws(() => c.service.publicConfig(), { code: 'APPLE_SETUP_REQUIRED' });
    await assert.rejects(c.service.search('Darmiyaan', 'ZZ'), { code: 'INVALID_COUNTRY' });
  } finally { c.cleanup(); }
});

test('Apple configuration signs ES256 JWTs, persists privately and never publishes the key in status', () => {
  const c = context();
  try {
    const status = c.service.configure(credentials);
    assert.equal(status.configured, true);
    assert.equal(status.connected, false);
    const config = c.service.publicConfig();
    assert.deepEqual(config.app, { name: 'Echo Library', build: '0.2.0' });
    assert.equal(Object.hasOwn(config, 'privateKey'), false);
    const [h, p, signature] = config.developerToken.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const payload = JSON.parse(Buffer.from(p, 'base64url'));
    assert.equal(header.alg, 'ES256');
    assert.equal(header.kid, credentials.keyId);
    assert.equal(payload.iss, credentials.teamId);
    assert.equal(payload.exp - payload.iat, 3600);
    assert.equal(verify('sha256', Buffer.from(`${h}.${p}`), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
    assert.equal(fs.statSync(c.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(c.dir, 'apple-config.json')).mode & 0o777, 0o600);
    const restored = new AppleMusicService({ dataDir: c.dir, clock: () => NOW });
    assert.equal(restored.status().configured, true);
    assert.equal(JSON.stringify(status).includes('PRIVATE KEY'), false);
    assert.equal(JSON.stringify(status).includes(config.developerToken), false);
    c.tick(56 * 60_000);
    assert.notEqual(c.service.publicConfig().developerToken, config.developerToken);
  } finally { c.cleanup(); }
});

test('supplied developer tokens require valid shape and expiry; Apple still verifies their signature', async () => {
  const source = context();
  const c = context(async () => response({ errors: [{ detail: 'secret-token-rejected' }] }, 401));
  try {
    source.service.configure(credentials);
    const developerToken = source.service.publicConfig().developerToken;
    assert.throws(() => c.service.configure({ developerToken: 'secret-malformed-token' }), { code: 'INVALID_APPLE_CONFIGURATION' });
    c.service.configure({ developerToken });
    await assert.rejects(c.service.search('Darmiyaan'), err => err.code === 'APPLE_CREDENTIALS_REJECTED' && !err.message.includes('secret'));
    c.tick(61 * 60_000);
    assert.equal(c.service.status().configured, false);
    await assert.rejects(c.service.search('Darmiyaan'), { code: 'APPLE_SETUP_REQUIRED' });
  } finally { source.cleanup(); c.cleanup(); }
});

test('official India search filters unplayable, unsafe and wrong-storefront rows and shares concurrent requests', async () => {
  let calls = 0;
  const c = context(async (url, options) => {
    ++calls;
    assert.equal(url.origin, 'https://api.music.apple.com');
    assert.equal(url.pathname, '/v1/catalog/in/search');
    assert.equal(url.searchParams.get('types'), 'songs');
    assert.equal(url.searchParams.get('include'), 'artists');
    assert.equal(options.headers.Authorization.startsWith('Bearer '), true);
    return response({ results: { songs: { data: [song(), song('2', 'in', { playParams: undefined }), song('3', 'in', { url: 'javascript:secret' }), song('4', 'in', { name: 'bad\nname' }), song('5', 'us'), song('7', 'in', { url: 'https://music.apple.com/us/album/test/100?i=7' }), song('123'), song('6', 'in', { artwork: { url: 12 } })] } } });
  });
  try {
    c.service.configure(credentials);
    const [a, b] = await Promise.all([c.service.search('Darmiyaan', 'IN'), c.service.search('darmiyaan', 'IN')]);
    assert.equal(calls, 1);
    assert.equal(a.country, 'IN');
    assert.equal(a.source, 'apple-music');
    assert.equal(a.availability, 'catalogue-playable');
    assert.equal(a.tracks.length, 2);
    assert.deepEqual(a, b);
    assert.equal(a.tracks[0].artist, song().attributes.artistName);
    assert.equal(a.tracks[0].artwork, 'https://is1-ssl.mzstatic.com/image/300x300.jpg');
    assert.notEqual(a.tracks[0].id, '123');
    a.tracks[0].title = 'client mutation';
    assert.notEqual(c.service.getTrack(a.tracks[0].id).title, 'client mutation');
    await c.service.search('Darmiyaan', 'IN');
    assert.equal(calls, 1);
  } finally { c.cleanup(); }
});

test('Apple authorization verifies the account storefront before saving, restores it, and preserves app setup on disconnect', async () => {
  const musicUserToken = 'fake-user-token-private';
  let verifyUser = false;
  const c = context(async (url, options) => {
    assert.equal(url.pathname, '/v1/me/storefront');
    assert.equal(options.headers['Music-User-Token'], musicUserToken);
    return response({ data: verifyUser ? [{ id: 'in', type: 'storefronts' }] : [{ id: 'bad-secret-storefront', type: 'storefronts' }] });
  });
  try {
    c.service.configure(credentials);
    await assert.rejects(c.service.authorize(musicUserToken), { code: 'APPLE_UNAVAILABLE' });
    assert.equal(fs.existsSync(path.join(c.dir, 'apple-user.json')), false);
    verifyUser = true;
    const status = await c.service.authorize(musicUserToken);
    assert.equal(status.connected, true);
    assert.equal(status.storefront, 'in');
    assert.equal(JSON.stringify(status).includes(musicUserToken), false);
    assert.equal(fs.statSync(path.join(c.dir, 'apple-user.json')).mode & 0o777, 0o600);
    const restored = new AppleMusicService({ dataDir: c.dir, clock: () => NOW });
    assert.equal(restored.status().connected, true);
    await assert.rejects(c.service.search('Darmiyaan', 'US'), { code: 'APPLE_STOREFRONT_MISMATCH' });
    c.service.disconnect();
    assert.equal(c.service.status().configured, true);
    assert.equal(c.service.status().connected, false);
    assert.equal(fs.existsSync(path.join(c.dir, 'apple-user.json')), false);
  } finally { c.cleanup(); }
});

test('play preparation revalidates the same storefront and retains canonical artist identity without splitting names', async () => {
  let stillPlayable = true;
  const requests = [];
  const c = context(async url => {
    requests.push(url.pathname);
    if (url.pathname.endsWith('/search')) return response({ results: { songs: { data: [song()] } } });
    assert.equal(url.pathname, '/v1/catalog/in/songs/123');
    return response({ data: [song('123', 'in', { playParams: stillPlayable ? { id: '123', kind: 'song' } : undefined })] });
  });
  try {
    c.service.configure(credentials);
    const { tracks } = await c.service.search('Darmiyaan', 'IN');
    await assert.rejects(c.service.prepareTrack(tracks[0].id, 'US'), { code: 'APPLE_COUNTRY_CHANGED' });
    assert.equal(requests.length, 1, 'cross-country play is rejected before an upstream call');
    const track = await c.service.prepareTrack(tracks[0].id, 'IN');
    assert.equal(track.artist, song().attributes.artistName);
    assert.equal(track.requestArtist, 'Rekha Bhardwaj');
    assert.deepEqual(track.requestArtists, ['Rekha Bhardwaj']);
    stillPlayable = false;
    await assert.rejects(c.service.prepareTrack(tracks[0].id, 'IN'), { code: 'APPLE_SONG_UNAVAILABLE' });
    assert.throws(() => c.service.getTrack(tracks[0].id), { code: 'EXPIRED_RESULT' });
    await assert.rejects(c.service.prepareTrack('forged', 'IN'), { code: 'EXPIRED_RESULT' });
  } finally { c.cleanup(); }
});

test('country caches are separate and absence of artist relationships preserves the original credited name', async () => {
  const c = context(async url => {
    const country = url.pathname.split('/')[3];
    const row = song('123', country);
    delete row.relationships;
    return response(url.pathname.endsWith('/search') ? { results: { songs: { data: [row] } } } : { data: [row] });
  });
  try {
    c.service.configure(credentials);
    const india = await c.service.search('Darmiyaan', 'IN');
    const usa = await c.service.search('Darmiyaan', 'US');
    assert.notEqual(india.tracks[0].id, usa.tracks[0].id);
    assert.equal((await c.service.prepareTrack(india.tracks[0].id, 'IN')).requestArtist, song().attributes.artistName);
  } finally { c.cleanup(); }
});

test('upstream transport and response failures never expose credentials or diagnostics', async () => {
  const secret = 'do-not-return-this-secret';
  const outcomes = [async () => { throw new Error(secret); }, async () => ({ status: 200, ok: true, json: async () => { throw new Error(secret); } }), async () => response({ errors: [{ detail: secret }] }), async () => response({ message: secret }, 500)];
  for (const fetcher of outcomes) {
    const c = context(fetcher);
    try {
      c.service.configure(credentials);
      await assert.rejects(c.service.search('Darmiyaan'), err => err.code === 'APPLE_UNAVAILABLE' && !err.message.includes(secret) && !err.message.includes('PRIVATE KEY'));
    } finally { c.cleanup(); }
  }
});

test('late authorization results cannot restore an Apple account after disconnect', async () => {
  let release;
  const c = context(() => new Promise(resolve => { release = () => resolve(response({ data: [{ id: 'in', type: 'storefronts' }] })); }));
  try {
    c.service.configure(credentials);
    const pending = c.service.authorize('fake-user-token');
    c.service.disconnect();
    release();
    await assert.rejects(pending, { code: 'APPLE_CONNECTION_CHANGED' });
    assert.equal(c.service.status().connected, false);
    assert.equal(fs.existsSync(path.join(c.dir, 'apple-user.json')), false);
  } finally { c.cleanup(); }
});


test('prepared Apple tracks expose separate trusted artist resources and preserve band names', async () => {
  const row = song('123', 'in', { artistName: 'Rekha Bhardwaj, Earth, Wind & Fire' });
  row.relationships.artists.data = [
    { id: '99', type: 'artists', attributes: { name: 'Rekha Bhardwaj' } },
    { id: '100', type: 'artists', attributes: { name: 'Earth, Wind & Fire' } },
    { id: '100', type: 'artists', attributes: { name: 'Earth, Wind & Fire' } },
    { id: '101', type: 'songs', attributes: { name: 'Wrong resource type' } },
    { id: 'bad-id', type: 'artists', attributes: { name: 'Invalid resource ID' } },
    { id: '102', type: 'artists', attributes: { name: 'bad\nname' } },
  ];
  const c = context(async url => response(url.pathname.endsWith('/search') ? { results: { songs: { data: [row] } } } : { data: [row] }));
  try {
    c.service.configure(credentials);
    const result = await c.service.search('Song', 'IN');
    const prepared = await c.service.prepareTrack(result.tracks[0].id, 'IN');
    assert.equal(prepared.artist, 'Rekha Bhardwaj, Earth, Wind & Fire');
    assert.equal(prepared.requestArtist, 'Rekha Bhardwaj');
    assert.deepEqual(prepared.requestArtists, ['Rekha Bhardwaj', 'Earth, Wind & Fire']);
    assert.equal(result.tracks[0].requestArtists, undefined, 'display metadata is unchanged');
  } finally { c.cleanup(); }
});

test('connected Apple library playlists use opaque identities and bounded same-origin pagination', async () => {
  const calls = [];
  const c = context(async url => {
    calls.push(url.href);
    if (url.pathname === '/v1/me/storefront') return response({ data: [{ type: 'storefronts', id: 'in' }] });
    return response({ data: [{ type: 'library-playlists', id: url.searchParams.has('offset') ? 'p.second' : 'p.first', attributes: { name: url.searchParams.has('offset') ? 'Second playlist' : 'Favourites', artwork: { url: 'https://is1-ssl.mzstatic.com/image/{w}x{h}.jpg' } } }], ...(url.searchParams.has('offset') ? {} : { next: '/v1/me/library/playlists?limit=100&offset=100' }) });
  });
  try {
    await assert.rejects(c.service.playlists(), { code: 'APPLE_SIGNIN_REQUIRED' });
    c.service.configure(credentials); await c.service.authorize('test-user-authorization');
    const result = await c.service.playlists();
    assert.equal(result.playlists.length, 2);
    assert.equal(result.playlists[0].source, 'apple-music');
    assert.notEqual(result.playlists[0].id, 'p.first');
    assert.equal((await c.service.playlist(result.playlists[0].id)).title, 'Favourites');
    await assert.rejects(c.service.playlist('p.first'), { code: 'EXPIRED_PLAYLIST' });
    assert.equal(calls.length, 3);
    c.service.disconnect();
    await assert.rejects(c.service.playlist(result.playlists[0].id), { code: 'EXPIRED_PLAYLIST' });
  } finally { c.cleanup(); }
});

test('Apple playlist pagination cannot redirect user credentials to another host', async () => {
  let calls = 0;
  const c = context(async url => {
    calls++;
    if (url.pathname === '/v1/me/storefront') return response({ data: [{ type: 'storefronts', id: 'in' }] });
    return response({ data: [], next: 'https://untrusted.example/collect' });
  });
  try {
    c.service.configure(credentials); await c.service.authorize('test-user-authorization');
    await assert.rejects(c.service.playlists(), { code: 'APPLE_UNAVAILABLE' });
    assert.equal(calls, 2);
  } finally { c.cleanup(); }
});


test('Apple catalogue artwork resolves size, crop and output-format placeholders', async () => {
  const c = context(async () => response({ results: { songs: { data: [song('123', 'in', { artwork: { url: 'https://is1-ssl.mzstatic.com/image/{w}x{h}{c}.{f}' } })] } } }));
  try {
    c.service.configure(credentials);
    const result = await c.service.search('Darmiyaan', 'IN');
    assert.equal(result.tracks[0].artwork, 'https://is1-ssl.mzstatic.com/image/300x300bb.jpg');
  } finally { c.cleanup(); }
});
