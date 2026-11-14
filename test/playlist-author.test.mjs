import test from 'node:test';
import assert from 'node:assert/strict';
import { importOpenPlaylist } from '../library/open-playlist-imports.mjs';
import { importPublicPlaylist } from '../library/public-playlist-imports.mjs';
import { normalizePlaylistOrigin } from '../library/playlist-links.mjs';
import { PlaylistSourceResolver } from '../library/playlist-source.mjs';
import { AppleMusicService } from '../library/apple-music.mjs';
import { SpotifyService } from '../library/spotify.mjs';
import { YouTubeMusicService } from '../library/youtube-music.mjs';

const SPOTIFY_ID = '1234567890123456789012', URL = 'https://open.spotify.com/playlist/' + SPOTIFY_ID;
const ART = 'https://i.scdn.co/image/playlist';
const response = html => ({ ok: true, status: 200, headers: { get: key => key === 'content-type' ? 'text/html' : null }, text: async () => html });
const spotifyHtml = extra => '<script id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: { state: { data: { entity: { type: 'playlist', id: SPOTIFY_ID, uri: 'spotify:playlist:' + SPOTIFY_ID, name: 'Source list', totalCount: 1, trackList: [{ uri: 'spotify:track:' + SPOTIFY_ID, title: 'Song', subtitle: 'Track artist' }], ...extra } } } } } }) + '</script>';

test('public Spotify author comes from playlist ownership rather than track credits', async () => {
  for (const [fields, expected] of [[{ owner: { display_name: 'Owner' }, subtitle: 'Fallback curator' }, 'Owner'], [{ subtitle: 'Spotify' }, 'Spotify'], [{}, undefined], [{ subtitle: 'Bad\nauthor' }, undefined]]) {
    const result = await importOpenPlaylist(URL, 'IN', { fetcher: async () => response(spotifyHtml(fields)), metadataOnly: true });
    assert.equal(result.author, expected);
  }
});

test('public YouTube author is playlist owner, separately from each video uploader', async () => {
  const id = 'PLoriginalOwner', data = { metadata: { playlistMetadataRenderer: { title: 'Playlist' } }, header: { playlistHeaderRenderer: { numVideosText: { simpleText: '1 video' } } }, sidebar: { playlistSidebarRenderer: { items: [{ playlistSidebarSecondaryInfoRenderer: { videoOwner: { videoOwnerRenderer: { title: { runs: [{ text: 'Playlist curator' }] } } } } }] } }, contents: { playlistVideoListRenderer: { playlistId: id, contents: [{ playlistVideoRenderer: { videoId: 'abcdefghijk', title: { simpleText: 'Song' }, shortBylineText: { simpleText: 'Song artist - Topic' } } }] } } };
  const result = await importOpenPlaylist('https://music.youtube.com/playlist?list=' + id, 'IN', { fetcher: async () => response('<script>var ytInitialData = ' + JSON.stringify(data) + ';</script>'), metadataOnly: true });
  assert.equal(result.author, 'Playlist curator'); assert.equal(result.tracks[0].artist, 'Song artist');
});

test('JioSaavn author is retained only from playlist owner metadata', async () => {
  const url = 'https://www.jiosaavn.com/featured/my-list/AbCdEf12', playlist = { type: 'playlist', title: 'My list', owner_name: 'Jio curator', perma_url: url, list_count: 1, list: [{ type: 'song', title: 'Song', artists: [{ role: 'singer', name: 'Artist' }] }] };
  const result = await importPublicPlaylist(url, 'IN', { fetcher: async () => response('<script>window.__INITIAL_DATA__=' + JSON.stringify({ playlist: { playlist } }) + ';</script>') });
  assert.equal(result.author, 'Jio curator');
});

test('Amazon author requires exact playlist schema identity and never uses song artists', async () => {
  const url = 'https://music.amazon.in/playlists/B012345678', row = '<music-image-row><music-playback-button></music-playback-button>1 <a href="/albums/B012345679?trackAsin=B012345680">Song</a><a href="/artists/B012345681">Artist</a>3:00</music-image-row>';
  for (const [identity, expected] of [[url, 'Original curator'], ['https://music.amazon.in/playlists/B012345682', undefined]]) {
    const schema = { '@type': 'MusicPlaylist', url: identity, author: { '@type': 'Person', name: 'Original curator' } };
    const result = await importPublicPlaylist(url, 'IN', { fetcher: async () => response('<h1>Playlist</h1>1 SONGS' + row + '<script type="application/ld+json">' + JSON.stringify(schema) + '</script>') });
    assert.equal(result.author, expected);
  }
});

test('optional authors are normalized and invalid text is omitted without harming source identity', () => {
  const origin = { source: 'spotify', name: 'Original', url: URL };
  assert.equal(normalizePlaylistOrigin({ ...origin, author: '  Original   curator ' }).author, 'Original curator');
  for (const author of [null, {}, 12, '', 'Bad\nname', 'x'.repeat(251)]) assert.equal(normalizePlaylistOrigin({ ...origin, author }).author, undefined);
});

test('missing author hydrates even with cover, deduplicates and keeps persisted origin untouched', async () => {
  let calls = 0; const origin = { source: 'spotify', name: 'Saved name', url: URL, artwork: ART };
  const resolver = new PlaylistSourceResolver({ importer: async () => { ++calls; return { name: 'Different current title', author: 'Curator' }; } });
  const [one, two] = await Promise.all([resolver.resolve({ origin, country: 'IN' }), resolver.resolve({ origin, country: 'IN' })]);
  assert.equal(one.author, 'Curator'); assert.equal(one.artwork, ART); assert.equal(one.name, 'Saved name'); assert.deepEqual(one, two); assert.equal(calls, 1); assert.equal(origin.author, undefined);
});

test('metadata misses preserve known values, do not invent authors and retry after short cache expiry', async () => {
  let calls = 0, now = 0; const origin = { source: 'spotify', name: 'Saved', url: URL, artwork: ART };
  const resolver = new PlaylistSourceResolver({ clock: () => now, importer: async () => { ++calls; throw new Error('upstream unavailable'); } });
  const one = await resolver.resolve({ origin, country: 'IN' }); assert.equal(one.artwork, ART); assert.equal(one.author, undefined);
  await resolver.resolve({ origin, country: 'IN' }); assert.equal(calls, 1);
  now = 60001; await resolver.resolve({ origin, country: 'IN' }); assert.equal(calls, 2);
  const known = await resolver.resolve({ origin: { ...origin, artwork: null, author: 'Known curator' }, country: 'IN' }); assert.equal(known.author, 'Known curator');
});


test('public Apple playlist schema retains its author independently of song artists', async () => {
  const id = 'pl.example', url = 'https://music.apple.com/in/playlist/example/' + id, songUrl = 'https://music.apple.com/in/song/song/123';
  const schema = { '@type': 'MusicPlaylist', name: 'Source list', url, numTracks: 1, author: { '@type': 'Person', name: 'Selected.' }, track: [{ name: 'Song', url: songUrl }] };
  const serialized = { data: [{ data: { sections: [{ items: [{ contentDescriptor: { kind: 'song', url: songUrl, identifiers: { storeAdamID: '123' } }, title: 'Song', artistName: 'Song artist' }] }] } }] };
  const html = '<script id="schema:music-playlist" type="application/ld+json">' + JSON.stringify(schema) + '</script><script id="serialized-server-data">' + JSON.stringify(serialized) + '</script>';
  const service = { generation: 0, clock: () => 0, calls: [], activeRequests: 0, fetcher: async () => response(html) };
  const result = await AppleMusicService.prototype.importPublicPlaylist.call(service, { id, slug: 'example' }, 'IN');
  assert.equal(result.author, 'Selected.'); assert.equal(result.tracks[0].artist, 'Song artist');
});

test('connected metadata lookup reads Spotify owner and YouTube channel without fetching songs', async () => {
  let requests = 0;
  const spotify = { generation: 0, requireCountry() {}, guard() {}, async request() { ++requests; return { id: SPOTIFY_ID, type: 'playlist', name: 'List', owner: { display_name: 'Spotify account owner' }, tracks: { total: 1 } }; } };
  const sp = await SpotifyService.prototype.importPlaylist.call(spotify, URL, 'IN', { metadataOnly: true });
  assert.equal(sp.author, 'Spotify account owner'); assert.equal(requests, 1);
  const youtube = { generation: 0, requireConnection() {}, async api(resource) { assert.equal(resource, 'playlists'); return { items: [{ kind: 'youtube#playlist', id: 'PLexample', snippet: { title: 'List', channelTitle: 'YouTube account owner' }, contentDetails: { itemCount: 1 } }] }; } };
  const yt = await YouTubeMusicService.prototype.importPlaylist.call(youtube, 'https://music.youtube.com/playlist?list=PLexample', 'IN', { metadataOnly: true });
  assert.equal(yt.author, 'YouTube account owner');
});
