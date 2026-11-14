import test from 'node:test';
import assert from 'node:assert/strict';
import { importOpenPlaylist } from '../library/open-playlist-imports.mjs';

const SPOTIFY_ID = '1234567890123456789012', YT_ID = 'PLpublicMusicList';
const SPOTIFY = 'https://open.spotify.com/playlist/' + SPOTIFY_ID;
const YOUTUBE = 'https://music.youtube.com/playlist?list=' + YT_ID;
const trackUri = index => 'spotify:track:' + String(index).padStart(22, '0');
function spotifyEntity(patch = {}) {
  return { type: 'playlist', id: SPOTIFY_ID, uri: 'spotify:playlist:' + SPOTIFY_ID, name: 'Public favourites', trackList: [
    { uri: trackUri(1), title: 'First Song', subtitle: 'Earth, Wind & Fire', duration: 180000, entityType: 'track' },
    { uri: trackUri(2), title: 'Second Song', subtitle: 'Second Artist', duration: 200000, entityType: 'track' }
  ], ...patch };
}
const spotifyHtml = entity => '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } }) + '</script>';
const text = value => ({ simpleText: value });
const oldVideo = (id, title, owner = 'Artist - Topic', length = '3:20') => ({ playlistVideoRenderer: { videoId: id, title: text(title), shortBylineText: text(owner), lengthText: text(length), navigationEndpoint: { watchEndpoint: { videoId: id, playlistId: YT_ID } } } });
function youtubeData({ rows = [oldVideo('abcdefghijk', 'First Song'), oldVideo('bcdefghijkl', 'Performer - Second Song (Official Music Video)', 'Uploader')], total = 2, id = YT_ID, canonical = 'https://www.youtube.com/playlist?list=' + id } = {}) {
  return { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { playlistId: id, contents: rows } }] } }] } } } }] } },
    metadata: { playlistMetadataRenderer: { title: 'Public music' } }, microformat: { microformatDataRenderer: { urlCanonical: canonical } }, header: total === null ? {} : { playlistHeaderRenderer: { numVideosText: text(String(total) + ' videos') } } };
}
const youtubeHtml = data => '<script>var ytInitialData = ' + JSON.stringify(data) + ';</script>';
function response(html, { status = 200, headers = {}, url = '' } = {}) {
  return { status, ok: status >= 200 && status < 300, url, headers: { get: key => headers[key.toLowerCase()] ?? (key.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) }, text: async () => html };
}
function fetcherFor(html, options) {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return response(html, options); };
  return { calls, fetcher };
}

test('Spotify public embeds retain visible songs without inventing a complete playlist count', async () => {
  const fixture = fetcherFor(spotifyHtml(spotifyEntity()));
  const result = await importOpenPlaylist(SPOTIFY + '?si=tracking', 'IN', fixture);
  assert.equal(result.tracks.length, 2); assert.equal(result.total, null); assert.equal(result.truncated, true); assert.equal(result.fullCountUnverified, true);
  assert.equal(result.source, 'spotify'); assert.equal(result.country, 'IN'); assert.equal(result.availability, 'unverified'); assert.equal(result.method, 'public-page');
  assert.match(result.notes.join(' '), /partial list/); assert.equal(result.url, SPOTIFY);
  assert.equal(fixture.calls[0].url, 'https://open.spotify.com/embed/playlist/' + SPOTIFY_ID);
  assert.equal(fixture.calls[0].init.credentials, 'omit'); assert.equal(fixture.calls[0].init.redirect, 'manual');
  assert.equal(Object.keys(fixture.calls[0].init.headers).some(key => /cookie|authorization/i.test(key)), false);
  assert.deepEqual(result.tracks[0].requestArtists, ['Earth, Wind & Fire'], 'never split band punctuation into invented individual artists');
});

test('known Spotify totals distinguish complete and partial public previews', async () => {
  const complete = await importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(spotifyHtml(spotifyEntity({ totalCount: 2 }))));
  assert.equal(complete.total, 2); assert.equal(complete.truncated, false); assert.equal(complete.fullCountUnverified, false);
  const partial = await importOpenPlaylist(SPOTIFY, 'US', fetcherFor(spotifyHtml(spotifyEntity({ totalCount: 4 }))));
  assert.equal(partial.total, 4); assert.equal(partial.truncated, true); assert.match(partial.notes[0], /incomplete/);
});

test('Spotify missing artists require review and separately structured artist names stay intact', async () => {
  const row = { uri: trackUri(1), title: 'Song', subtitle: '', duration: 1000 };
  const result = await importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(spotifyHtml(spotifyEntity({ totalCount: 1, trackList: [row] }))));
  assert.equal(result.tracks[0].needsReview, true); assert.equal(result.tracks[0].artist, ''); assert.match(result.notes.join(' '), /needs an artist/);
  const structured = { ...row, artists: [{ name: 'One' }, { name: 'Simon & Garfunkel' }] };
  const withArtists = await importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(spotifyHtml(spotifyEntity({ trackList: [structured], totalCount: 1 }))));
  assert.deepEqual(withArtists.tracks[0].requestArtists, ['One', 'Simon & Garfunkel']);
});

test('Spotify rejects wrong playlist identities, gated pages and inconsistent totals', async () => {
  for (const entity of [
    spotifyEntity({ id: 'x'.repeat(22) }), spotifyEntity({ uri: 'spotify:playlist:' + 'x'.repeat(22) }), spotifyEntity({ type: 'album' }),
    spotifyEntity({ isPrivate: true }), spotifyEntity({ public: false }), spotifyEntity({ totalCount: 1 }),
    spotifyEntity({ totalCount: 2, trackCount: 4 }), spotifyEntity({ trackList: [] }),
    spotifyEntity({ trackList: [{ uri: 'spotify:episode:' + 'x'.repeat(22), title: 'Episode' }] })
  ]) await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(spotifyHtml(entity))), { code: 'PUBLIC_PLAYLIST_UNAVAILABLE' });
  for (const html of ['<h1>Sign in</h1>', '<script id="__NEXT_DATA__">{"props":{}}</script>', spotifyHtml(spotifyEntity()) + spotifyHtml(spotifyEntity())]) await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(html)), { code: 'PUBLIC_PLAYLIST_UNAVAILABLE' });
});

test('public YouTube playlists infer only corroborated song artists and preserve versions', async () => {
  const fixture = fetcherFor(youtubeHtml(youtubeData({ rows: [
    oldVideo('abcdefghijk', 'First Song (Live)', 'First Artist - Topic'),
    oldVideo('bcdefghijkl', 'Second Artist - Second Song (Official Music Video)', 'Uploader')
  ] })));
  const result = await importOpenPlaylist(YOUTUBE + '&si=tracking', 'IN', fixture);
  assert.equal(result.total, 2); assert.equal(result.truncated, false); assert.equal(result.skipped, 0);
  assert.deepEqual(result.tracks.map(track => [track.title, track.artist]), [['First Song (Live)', 'First Artist'], ['Second Song', 'Second Artist']]);
  assert.equal(result.tracks[0].durationMs, 200000);
  assert.match(fixture.calls[0].url, /^https:\/\/www\.youtube\.com\/playlist\?list=PLpublicMusicList&hl=en&gl=IN$/);
  assert.equal(result.url, YOUTUBE);
});

test('YouTube continuations are explicit partial previews instead of complete playlist claims', async () => {
  const rows = [oldVideo('abcdefghijk', 'Song'), { continuationItemRenderer: { token: 'not-followed' } }];
  const result = await importOpenPlaylist(YOUTUBE, 'IN', fetcherFor(youtubeHtml(youtubeData({ rows, total: 20 }))));
  assert.equal(result.tracks.length, 1); assert.equal(result.total, 20); assert.equal(result.truncated, true);
  assert.match(result.notes.join(' '), /incomplete/);
  const unknown = await importOpenPlaylist(YOUTUBE, 'IN', fetcherFor(youtubeHtml(youtubeData({ rows, total: null }))));
  assert.equal(unknown.total, null); assert.equal(unknown.fullCountUnverified, true);
});

test('private videos are skipped explicitly and uncorroborated uploaders are not treated as artists', async () => {
  const rows = [oldVideo('abcdefghijk', 'Private video'), oldVideo('bcdefghijkl', 'A song with unknown artist', 'A fan uploader')];
  const result = await importOpenPlaylist(YOUTUBE, 'IN', fetcherFor(youtubeHtml(youtubeData({ rows }))));
  assert.equal(result.skipped, 1); assert.equal(result.truncated, true); assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].artist, ''); assert.equal(result.tracks[0].needsReview, true);
  assert.match(result.notes.join(' '), /artist/);
});

function modernView(id, title, owner = 'Performer - Topic') {
  return { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: id,
    metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: owner } }] }] } } } },
    contentImage: { thumbnailViewModel: { overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: '4:21' } }] } }] } },
    rendererContext: { commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: id, playlistId: YT_ID } } } } } };
}
test('current YouTube lockup views and HTTP canonical metadata are read without any HTTP request', async () => {
  const data = youtubeData({ total: 2, canonical: 'http://www.youtube.com/playlist?list=' + YT_ID });
  data.contents = { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
    { lockupViewModel: modernView('abcdefghijk', 'Performer - Song (Official Audio)') },
    { lockupViewModel: modernView('bcdefghijkl', 'Second Song') }
  ] } }] } } } }] } };
  const fixture = fetcherFor(youtubeHtml(data));
  const result = await importOpenPlaylist(YOUTUBE, 'IN', fixture);
  assert.equal(result.tracks.length, 2); assert.equal(result.truncated, false); assert.equal(result.tracks[0].title, 'Song'); assert.equal(result.tracks[0].artist, 'Performer'); assert.equal(result.tracks[0].durationMs, 261000);
  assert.ok(fixture.calls.every(call => call.url.startsWith('https://')));
});

test('YouTube rejects wrong canonical identities, wrong playlist renderers and error alerts', async () => {
  const cases = [youtubeData({ id: 'PLdifferent' }), youtubeData({ canonical: 'https://www.youtube.com/playlist?list=PLdifferent' }), { ...youtubeData(), alerts: [{ alertRenderer: { type: 'ERROR', text: text('Private playlist') } }] }];
  for (const data of cases) await assert.rejects(importOpenPlaylist(YOUTUBE, 'IN', fetcherFor(youtubeHtml(data))), { code: 'PUBLIC_PLAYLIST_UNAVAILABLE' });
  await assert.rejects(importOpenPlaylist(YOUTUBE, 'IN', fetcherFor('<h1>Sign in to view</h1>')), { code: 'PUBLIC_PLAYLIST_UNAVAILABLE' });
});

test('public bootstrap JSON is parsed as data and page scripts are never executed', async () => {
  delete globalThis.__echoImporterExecuted;
  const rows = [oldVideo('abcdefghijk', 'Artist - Song with {braces} and "quotes" (Official Audio)')];
  const html = youtubeHtml(youtubeData({ rows, total: 1 })) + '<script>globalThis.__echoImporterExecuted = true;</script>';
  const result = await importOpenPlaylist(YOUTUBE, 'IN', fetcherFor(html));
  assert.equal(result.tracks[0].title, 'Song with {braces} and "quotes"');
  assert.equal(globalThis.__echoImporterExecuted, undefined);
  await assert.rejects(importOpenPlaylist(YOUTUBE, 'IN', fetcherFor('<script>var ytInitialData = (() => {globalThis.__echoImporterExecuted=true; return {}})();</script>')), { code: 'PUBLIC_PLAYLIST_UNAVAILABLE' });
  assert.equal(globalThis.__echoImporterExecuted, undefined);
});

test('invalid source URLs and countries fail before any outgoing request', async () => {
  let calls = 0; const fetcher = async () => { calls++; return response(''); };
  for (const url of ['http://open.spotify.com/playlist/' + SPOTIFY_ID, 'https://open.spotify.com.evil.test/playlist/' + SPOTIFY_ID, 'https://user:password@open.spotify.com/playlist/' + SPOTIFY_ID, 'https://open.spotify.com:444/playlist/' + SPOTIFY_ID, 'https://spotify.link/short', 'https://music.youtube.com/watch?list=' + YT_ID, 'https://music.youtube.com/playlist?list=RDgenerated', 'https://evil.test/playlist?list=' + YT_ID]) await assert.rejects(importOpenPlaylist(url, 'IN', { fetcher }));
  await assert.rejects(importOpenPlaylist(SPOTIFY, 'ZZ', { fetcher }), { code: 'INVALID_COUNTRY' });
  assert.equal(calls, 0);
});

test('redirects stay on the same allowlisted HTTPS playlist and omit account credentials', async () => {
  const calls = [];
  const result = await importOpenPlaylist(SPOTIFY, 'IN', { fetcher: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? response('', { status: 302, headers: { location: '/embed/playlist/' + SPOTIFY_ID + '?utm_source=generator' } }) : response(spotifyHtml(spotifyEntity({ totalCount: 2 })));
  } });
  assert.equal(result.tracks.length, 2); assert.equal(calls.length, 2);
  for (const location of ['https://accounts.spotify.com/login', 'https://127.0.0.1/private', 'http://open.spotify.com/embed/playlist/' + SPOTIFY_ID, '/embed/playlist/' + 'x'.repeat(22), 'http://[']) {
    let reads = 0;
    await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', { fetcher: async () => { reads++; return response('', { status: 302, headers: { location } }); } }), { code: 'PUBLIC_PLAYLIST_UNAVAILABLE' });
    assert.equal(reads, 1);
  }
});

test('redirect loops and fetchers that follow an unexpected response URL are rejected', async () => {
  let reads = 0;
  await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', { fetcher: async () => { reads++; return response('', { status: 302, headers: { location: '/embed/playlist/' + SPOTIFY_ID } }); } }), { code: 'PUBLIC_PLAYLIST_UNAVAILABLE' });
  assert.equal(reads, 4);
  await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(spotifyHtml(spotifyEntity()), { url: 'https://evil.test/page' })), { code: 'PUBLIC_PLAYLIST_UNAVAILABLE' });
});

test('HTML body limits, content types and service errors have authored fallback messages', async () => {
  await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', fetcherFor('', { headers: { 'content-length': String(6 * 1024 * 1024 + 1) } })), { code: 'PUBLIC_PLAYLIST_TOO_LARGE' });
  await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', fetcherFor('{}', { headers: { 'content-type': 'application/json' } })), { code: 'PUBLIC_PLAYLIST_UNAVAILABLE' });
  await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', fetcherFor('', { status: 429 })), { code: 'PUBLIC_PLAYLIST_RATE_LIMIT' });
  await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', { fetcher: async () => { throw new Error('cookie=never-export'); } }), error => error.code === 'PUBLIC_PLAYLIST_UNREACHABLE' && !error.message.includes('never-export'));
});

test('known totals and visible lists above the 500-song cap are rejected without partial success', async () => {
  await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(spotifyHtml(spotifyEntity({ totalCount: 501 })))), { code: 'PUBLIC_PLAYLIST_TOO_LARGE' });
  await assert.rejects(importOpenPlaylist(YOUTUBE, 'IN', fetcherFor(youtubeHtml(youtubeData({ total: 501 })))), { code: 'PUBLIC_PLAYLIST_TOO_LARGE' });
  const trackList = Array.from({ length: 501 }, (_, index) => ({ uri: trackUri(index), title: 'Song', subtitle: 'Artist' }));
  await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(spotifyHtml(spotifyEntity({ trackList })))), { code: 'PUBLIC_PLAYLIST_TOO_LARGE' });
});

test('duplicate playlist songs remain ordered and get distinct local preview identifiers', async () => {
  const repeated = spotifyEntity().trackList[0];
  const result = await importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(spotifyHtml(spotifyEntity({ totalCount: 2, trackList: [repeated, repeated] }))));
  assert.equal(result.tracks.length, 2); assert.notEqual(result.tracks[0].id, result.tracks[1].id); assert.equal(result.tracks[0].url, result.tracks[1].url);
});


const continuation = token => ({ continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } } } } });
const configuredYouTube = data => youtubeHtml(data) + '<script>ytcfg.set({"INNERTUBE_API_KEY":"public-website-key","INNERTUBE_CLIENT_VERSION":"2.20261114.01.00","VISITOR_DATA":"never-forward"});</script>';
function jsonResponse(value, options = {}) { return response(JSON.stringify(value), { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } }); }
const appended = (items, targetId = YT_ID) => ({ onResponseReceivedActions: [{ appendContinuationItemsAction: { targetId, continuationItems: items } }] });

test('public YouTube continuation loads every accessible song without account credentials', async () => {
  const rows = [oldVideo('abcdefghijk', 'One'), oldVideo('bcdefghijkl', 'Two'), continuation('page-2')];
  const calls = [];
  const result = await importOpenPlaylist(YOUTUBE, 'IN', { fetcher: async (url, init) => {
    calls.push({ url, init });
    if (init.method !== 'POST') return response(configuredYouTube(youtubeData({ rows, total: 4 })));
    const payload = JSON.parse(init.body);
    assert.equal(payload.continuation, 'page-2');
    assert.deepEqual(payload.context, { client: { clientName: 'WEB', clientVersion: '2.20261114.01.00', hl: 'en', gl: 'IN' } });
    assert.equal(JSON.stringify(payload).includes('never-forward'), false);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual');
    assert.equal(new URL(url).origin, 'https://www.youtube.com'); assert.equal(new URL(url).pathname, '/youtubei/v1/browse');
    assert.ok(!Object.keys(init.headers).some(name => /cookie|authorization/i.test(name)));
    return jsonResponse(appended([oldVideo('cdefghijklm', 'Three'), oldVideo('defghijklmn', 'Four')]));
  } });
  assert.equal(calls.length, 2); assert.equal(result.tracks.length, 4); assert.equal(result.total, 4); assert.equal(result.skipped, 0); assert.equal(result.truncated, false);
  assert.deepEqual(result.tracks.map(item => item.title), ['One', 'Two', 'Three', 'Four']);
  assert.equal(JSON.stringify(result).includes('public-website-key'), false);
  assert.equal(JSON.stringify(result).includes('page-2'), false);
});

test('modern playlist continuations are scoped to the song container, excluding recommendation tokens', async () => {
  const data = youtubeData({ total: 3 });
  data.contents = { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [{ lockupViewModel: modernView('abcdefghijk', 'One') }, { lockupViewModel: modernView('bcdefghijkl', 'Two') }, continuation('song-page-2')] } },
    continuation('recommendations-not-songs')
  ] } } } }] } };
  let token;
  const result = await importOpenPlaylist(YOUTUBE, 'IN', { fetcher: async (_url, init) => {
    if (init.method !== 'POST') return response(configuredYouTube(data));
    token = JSON.parse(init.body).continuation;
    return jsonResponse(appended([{ lockupViewModel: modernView('cdefghijklm', 'Three') }]));
  } });
  assert.equal(token, 'song-page-2'); assert.equal(result.tracks.length, 3); assert.equal(result.truncated, false);
});

test('unavailable continuation entries remain explicit skipped/incomplete metadata', async () => {
  const rows = [oldVideo('abcdefghijk', 'One'), continuation('page-2')];
  const result = await importOpenPlaylist(YOUTUBE, 'IN', { fetcher: async (_url, init) => init.method === 'POST'
    ? jsonResponse(appended([oldVideo('bcdefghijkl', 'Two'), oldVideo('cdefghijklm', 'Private video')]))
    : response(configuredYouTube(youtubeData({ rows, total: 3 }))) });
  assert.equal(result.tracks.length, 2); assert.equal(result.skipped, 1); assert.equal(result.total, 3); assert.equal(result.truncated, true);
  assert.match(result.notes.join(' '), /incomplete/);
});

test('blocked public continuation requests keep only the explicitly partial visible preview', async () => {
  const rows = [oldVideo('abcdefghijk', 'One'), continuation('page-2')];
  for (const failure of [
    () => response('', { status: 403 }),
    () => response('', { status: 302, headers: { location: 'https://accounts.google.com/login' } }),
    () => jsonResponse(appended([oldVideo('bcdefghijkl', 'Other playlist')], 'PLwrong')),
    () => jsonResponse(appended([oldVideo('bcdefghijkl', 'Wrong origin')]), { url: 'https://evil.test/browse' }),
    () => { throw new Error('authorization=never-export'); }
  ]) {
    const calls = [];
    const result = await importOpenPlaylist(YOUTUBE, 'IN', { fetcher: async (url, init) => { calls.push({ url, init }); return init.method === 'POST' ? failure() : response(configuredYouTube(youtubeData({ rows, total: 3 }))); } });
    assert.equal(result.tracks.length, 1); assert.equal(result.truncated, true); assert.equal(result.total, 3); assert.equal(result.skipped, 0);
    assert.equal(calls.length, 2); assert.equal(JSON.stringify(result).includes('never-export'), false);
  }
});

test('continuation token loops stop without duplicating page songs', async () => {
  const rows = [oldVideo('abcdefghijk', 'One'), continuation('same-token')];
  let posts = 0;
  const result = await importOpenPlaylist(YOUTUBE, 'IN', { fetcher: async (_url, init) => {
    if (init.method !== 'POST') return response(configuredYouTube(youtubeData({ rows, total: 3 })));
    posts++; return jsonResponse(appended([oldVideo('bcdefghijkl', 'Duplicate page'), continuation('same-token')]));
  } });
  assert.equal(posts, 1); assert.equal(result.tracks.length, 1); assert.equal(result.truncated, true);
});

test('continuation page and song-count budgets stay bounded', async () => {
  const rows = [oldVideo('abcdefghijk', 'One'), continuation('page-1')];
  let posts = 0;
  const limited = await importOpenPlaylist(YOUTUBE, 'IN', { fetcher: async (_url, init) => {
    if (init.method !== 'POST') return response(configuredYouTube(youtubeData({ rows, total: null })));
    posts++; return jsonResponse(appended([oldVideo(String(posts).padStart(11, '0'), 'Song ' + posts), continuation('page-' + (posts + 1))]));
  } });
  assert.equal(posts, 8); assert.equal(limited.tracks.length, 9); assert.equal(limited.total, null); assert.equal(limited.truncated, true);
  const initial = [oldVideo('abcdefghijk', 'One'), continuation('page-2')];
  const oversized = Array.from({ length: 500 }, (_, index) => oldVideo(String(index).padStart(11, '0'), 'Song ' + index));
  await assert.rejects(importOpenPlaylist(YOUTUBE, 'IN', { fetcher: async (_url, init) => init.method === 'POST' ? jsonResponse(appended(oversized)) : response(configuredYouTube(youtubeData({ rows: initial, total: null }))) }), { code: 'PUBLIC_PLAYLIST_TOO_LARGE' });
});

test('missing or invalid website client configuration never initiates a continuation request', async () => {
  const rows = [oldVideo('abcdefghijk', 'One'), continuation('page-2')];
  for (const suffix of ['', '<script>ytcfg.set({"INNERTUBE_CLIENT_VERSION":"bad\\nversion"});</script>']) {
    let calls = 0;
    const result = await importOpenPlaylist(YOUTUBE, 'IN', { fetcher: async () => { calls++; return response(youtubeHtml(youtubeData({ rows, total: 3 })) + suffix); } });
    assert.equal(calls, 1); assert.equal(result.truncated, true); assert.equal(result.tracks.length, 1);
  }
});



test('failed public body streams never export raw upstream errors', async () => {
  await assert.rejects(importOpenPlaylist(SPOTIFY, 'IN', { fetcher: async () => ({ ...response(''), text: async () => { throw new Error('cookie=never-export'); } }) }), error => error.code === 'PUBLIC_PLAYLIST_UNAVAILABLE' && !error.message.includes('never-export'));
});


test('public imports preserve supplied Spotify covers and derive YouTube thumbnails from validated video IDs', async () => {
  const cover = 'https://image-cdn-ak.spotifycdn.com/image/cover';
  const row = { ...spotifyEntity().trackList[0], images: [{ url: cover }] };
  const result = await importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(spotifyHtml(spotifyEntity({ trackList: [row], totalCount: 1 }))));
  assert.equal(result.tracks[0].artwork, cover);
  const youtube = await importOpenPlaylist(YOUTUBE, 'IN', fetcherFor(youtubeHtml(youtubeData({ rows: [oldVideo('abcdefghijk', 'Song')], total: 1 }))));
  assert.equal(youtube.tracks[0].artwork, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
});


test('public Spotify playlist artwork belongs to the source playlist, independently of song covers', async () => {
  const entity = spotifyEntity({ visualIdentity: { image: [{ url: 'https://charts-images.scdn.co/playlist-cover.jpg' }] } });
  const result = await importOpenPlaylist(SPOTIFY, 'IN', fetcherFor(spotifyHtml(entity)));
  assert.equal(result.artwork, 'https://charts-images.scdn.co/playlist-cover.jpg');
  assert.equal(result.tracks[0].artwork, null);
});
