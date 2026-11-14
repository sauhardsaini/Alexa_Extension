import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { normalizeReleaseYear, releaseYearFromDate, releaseYearMetadata } from '../library/track-release.mjs';
import { AppleMusicService } from '../library/apple-music.mjs';
import { SpotifyService } from '../library/spotify.mjs';
import { YouTubeMusicService } from '../library/youtube-music.mjs';
import { Catalog } from '../library/catalog.mjs';
import { PlaylistQueue } from '../library/playlist-queue.mjs';
import { LocalPlaylists, normalizeLocalTrack } from '../library/local-playlists.mjs';
import { importOpenPlaylist } from '../library/open-playlist-imports.mjs';
import { importPublicPlaylist } from '../library/public-playlist-imports.mjs';

const spotifyId = '1234567890123456789012';
const spotifyUrl = 'https://open.spotify.com/playlist/' + spotifyId;
const appleUrl = 'https://music.apple.com/in/playlist/example/pl.example';
const songUrl = 'https://music.apple.com/in/song/song/123';
const htmlResponse = html => ({ ok: true, status: 200, headers: { get: name => name === 'content-type' ? 'text/html' : null }, text: async () => html });
const appleSong = releaseDate => ({ id: '123', type: 'songs', attributes: { name: 'Selected song', artistName: 'Artist', albumName: "Album (Taylor’s Version)", url: songUrl, releaseDate, playParams: { id: '123', kind: 'song' } } });
const spotifySong = releaseDate => ({ id: spotifyId, type: 'track', name: 'Selected song', artists: [{ id: spotifyId, type: 'artist', name: 'Artist' }], album: { name: "Album (Taylor's Version)", release_date: releaseDate }, external_urls: { spotify: 'https://open.spotify.com/track/' + spotifyId }, is_playable: true });
const maps = () => ({ tracks: new Map(), cache: new Map(), clock: () => 0 });

test('release years use explicit strict dates with supported source precision and no calendar rollover', () => {
  for (const value of ['2014', '2014-10', '2014-10-27', '2014-10-27T00:00:00Z', '2014-10-27T00:00:00.123+05:30']) assert.equal(releaseYearFromDate(value), 2014, value);
  assert.equal(releaseYearFromDate('2000-02-29'), 2000);
  for (const value of ['', 2014, null, {}, '99', '0000', '0999', '2014 extra', ' 2014', '2014-00', '2014-13', '2014-02-29', '1900-02-29', '2014-04-31', '2014-10-00', '2014-10-27T99:00:00Z']) assert.equal(releaseYearFromDate(value), null, String(value));
  for (const value of [2014, 1000, 9999]) assert.equal(normalizeReleaseYear(value), value);
  for (const value of ['2014', null, {}, 999, 10000, 2014.5, NaN]) assert.equal(normalizeReleaseYear(value), null);
  assert.deepEqual(releaseYearMetadata('2014-10-27'), { releaseYear: 2014 });
  assert.deepEqual(releaseYearMetadata('not a date'), {});
});

test('Apple catalogue and prepared song keep the selected release year and album edition label', async () => {
  const row = appleSong('2023-10-27');
  const context = { ...maps(), request: async () => ({ results: { songs: { data: [row] } } }) };
  const result = await AppleMusicService.prototype.loadSearch.call(context, 'selected', 'IN', 'key');
  assert.equal(result.tracks[0].releaseYear, 2023);
  assert.equal(result.tracks[0].album, row.attributes.albumName);
  const id = result.tracks[0].id, entry = context.tracks.get(id);
  context.request = async () => ({ data: [row] });
  const prepared = await AppleMusicService.prototype.verifyTrack.call(context, entry, id, 'IN');
  assert.equal(prepared.releaseYear, 2023);
  context.request = async () => ({ results: { songs: { data: [appleSong('2023-02-30')] } } });
  const invalid = await AppleMusicService.prototype.loadSearch.call(context, 'selected', 'IN', 'invalid');
  assert.equal(Object.hasOwn(invalid.tracks[0], 'releaseYear'), false);
});

test('Spotify catalogue, prepared track and connected playlist carry album release dates', async () => {
  const row = spotifySong('2014-10-27');
  const context = { ...maps(), generation: 0, guard() {}, request: async () => ({ tracks: { items: [row] } }) };
  const result = await SpotifyService.prototype.loadSearch.call(context, 'selected', 'IN', 'key', 0);
  assert.equal(result.tracks[0].releaseYear, 2014);
  const id = result.tracks[0].id, entry = context.tracks.get(id);
  context.request = async () => row;
  const prepared = await SpotifyService.prototype.verifyTrack.call(context, entry, id, 'IN', 0);
  assert.equal(prepared.releaseYear, 2014);
  const importer = { generation: 0, requireCountry() {}, guard() {}, async request(resource) { return resource.startsWith('/v1/playlists/' + spotifyId + '/items') ? { items: [{ item: row }], total: 1, offset: 0, next: null } : { id: spotifyId, type: 'playlist', name: 'List', items: { total: 1 } }; } };
  const playlist = await SpotifyService.prototype.importPlaylist.call(importer, spotifyUrl, 'IN');
  assert.equal(playlist.tracks[0].releaseYear, 2014);
  assert.equal(playlist.tracks[0].album, row.album.name);
});

test('Apple public import uses the individual song date rather than playlist publication year', async () => {
  const schema = { '@type': 'MusicPlaylist', name: 'List', url: appleUrl, numTracks: 1, datePublished: '2026-11-14', track: [{ name: 'Selected song', url: songUrl, datePublished: '2014-10-27' }] };
  const serialized = { data: [{ data: { sections: [{ items: [{ title: 'Selected song', artistName: 'Artist', contentDescriptor: { kind: 'song', url: songUrl, identifiers: { storeAdamID: '123' } } }] }] } }] };
  const html = '<script id="schema:music-playlist" type="application/ld+json">' + JSON.stringify(schema) + '</script><script id="serialized-server-data">' + JSON.stringify(serialized) + '</script>';
  const context = { generation: 0, clock: () => 0, calls: [], activeRequests: 0, fetcher: async () => htmlResponse(html) };
  const result = await AppleMusicService.prototype.importPublicPlaylist.call(context, { id: 'pl.example', slug: 'example' }, 'IN');
  assert.equal(result.tracks[0].releaseYear, 2014);
});

test('public Spotify and JioSaavn retain explicit track-level dates, not playlist-level years', async () => {
  const entity = { type: 'playlist', id: spotifyId, uri: 'spotify:playlist:' + spotifyId, name: 'List', releaseDate: '2026-11-14', totalCount: 1, trackList: [{ uri: 'spotify:track:' + spotifyId, title: 'Selected song', subtitle: 'Artist', releaseDate: '2014-10-27' }] };
  const spotifyHtml = '<script id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } }) + '</script>';
  const spotify = await importOpenPlaylist(spotifyUrl, 'IN', { fetcher: async () => htmlResponse(spotifyHtml) });
  assert.equal(spotify.tracks[0].releaseYear, 2014);
  const url = 'https://www.jiosaavn.com/featured/my-list/AbCdEf12';
  const playlist = { type: 'playlist', title: 'List', perma_url: url, list_count: 2, year: '2026', list: [{ type: 'song', title: 'First', year: '2014', artists: [{ role: 'singer', name: 'Artist' }] }, { type: 'song', title: 'Second', artists: [{ role: 'singer', name: 'Artist' }] }] };
  const jio = await importPublicPlaylist(url, 'IN', { fetcher: async () => htmlResponse('<script>window.__INITIAL_DATA__=' + JSON.stringify({ playlist: { playlist } }) + ';</script>') });
  assert.equal(jio.tracks[0].releaseYear, 2014);
  assert.equal(Object.hasOwn(jio.tracks[1], 'releaseYear'), false);
});

test('Amazon song dates require exact playlist and recording identity and never use playlist date', async () => {
  const url = 'https://music.amazon.in/playlists/B012345678', trackUrl = 'https://music.amazon.in/albums/B012345679?trackAsin=B012345680';
  const row = '<music-image-row><music-playback-button></music-playback-button>1 <a href="/albums/B012345679?trackAsin=B012345680">Selected song</a><a href="/artists/B012345681">Artist</a>3:00</music-image-row>';
  for (const [recording, expected] of [[{ '@type': 'MusicRecording', name: 'Selected song', url: trackUrl, datePublished: '2014-10-27' }, 2014], [{ '@type': 'MusicRecording', name: 'Other song', url: trackUrl, datePublished: '2014-10-27' }, undefined], [null, undefined]]) {
    const schema = { '@type': 'MusicPlaylist', url, datePublished: '2026-11-14', track: recording ? [recording] : [] };
    const html = '<h1>List</h1>1 SONGS' + row + '<script type="application/ld+json">' + JSON.stringify(schema) + '</script>';
    const result = await importPublicPlaylist(url, 'IN', { fetcher: async () => htmlResponse(html) });
    assert.equal(result.tracks[0].releaseYear, expected);
  }
});

test('YouTube upload dates and title years never become a song release year', async () => {
  const row = { kind: 'youtube#playlistItem', id: 'entry', contentDetails: { videoId: 'abcdefghijk', videoPublishedAt: '2026-11-14T00:00:00Z' }, snippet: { title: 'Selected song 2014', publishedAt: '2026-11-14T00:00:00Z', videoOwnerChannelTitle: 'Artist - Topic' } };
  const service = { ...maps(), generation: 0, playlistCache: new Map(), api: async () => ({ items: [row] }) };
  const result = await YouTubeMusicService.prototype.loadPlaylist.call(service, 'list', { nativeId: 'native', entry: { title: 'List' } });
  assert.equal(Object.hasOwn(result.tracks[0], 'releaseYear'), false);
});

test('local playlist add, save, sync and restart retain valid optional release years', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-release-year-metadata-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new LocalPlaylists({ dataDir });
  const song = { title: 'Selected song', artist: 'Artist', album: "Album (Taylor's Version)", releaseYear: 2023, source: 'spotify', country: 'IN', url: 'https://open.spotify.com/track/' + spotifyId };
  const created = store.create({ name: 'Created', country: 'IN' });
  const added = store.add(created.id, song);
  assert.equal(added.tracks[0].releaseYear, 2023);
  const origin = { source: 'spotify', name: 'Original', url: spotifyUrl };
  const imported = store.importTracks({ name: 'Imported', country: 'IN', tracks: [song], origin });
  const synced = store.sync(imported.id, { expectedUpdatedAt: imported.updatedAt, tracks: [{ ...song, releaseYear: 2014 }], origin });
  assert.equal(synced.tracks[0].releaseYear, 2014);
  const restored = new LocalPlaylists({ dataDir });
  assert.equal(restored.get(created.id).tracks[0].releaseYear, 2023);
  assert.equal(restored.get(imported.id).tracks[0].releaseYear, 2014);
  for (const releaseYear of [null, '2014', 999, 10000, 2014.5]) assert.equal(Object.hasOwn(normalizeLocalTrack({ ...song, releaseYear }), 'releaseYear'), false);
});

test('unchanged import preview keeps the year but editing song identity drops stale release metadata', async () => {
  const script = await fs.readFile(new URL('../library/public/app.js', import.meta.url), 'utf8');
  const start = script.indexOf('  function parsePlaylistImport('), end = script.indexOf('\n  function ', start + 1);
  const context = vm.createContext({ playlistImportSource: value => value === 'spotify' ? value : '', validQueueText: value => typeof value === 'string' && value.length > 0 && value.length <= 250, preview: [{ title: 'Selected song', artist: 'Artist', source: 'spotify', releaseYear: 2014 }] });
  vm.runInContext(script.slice(start, end), context);
  assert.equal(vm.runInContext("parsePlaylistImport('Selected song — Artist',preview,'IN','spotify')[0].releaseYear", context), 2014);
  assert.equal(vm.runInContext("parsePlaylistImport('Different song — Artist',preview,'IN','spotify')[0].releaseYear", context), undefined);
});


test('public iTunes search and preparation retain valid release dates and omit malformed dates', async () => {
  const catalog = new Catalog({ fetcher: async () => ({ ok: true, json: async () => ({ results: ['2014-10-27T00:00:00Z', '2014-02-30', undefined].map((releaseDate, i) => ({ country: 'IND', kind: 'song', trackId: i + 1, trackName: 'Song ' + i, artistName: 'Artist', collectionName: 'Album', trackViewUrl: 'https://music.apple.com/in/album/album/99?i=' + (i + 1), releaseDate })) }) }) });
  const result = await catalog.search('Song', 'IN');
  assert.equal(result.tracks[0].releaseYear, 2014);
  const prepared = await catalog.prepareTrack(result.tracks[0].id, 'IN');
  assert.equal(prepared.releaseYear, 2014);
  assert.equal(Object.hasOwn(result.tracks[1], 'releaseYear'), false);
  assert.equal(Object.hasOwn(result.tracks[2], 'releaseYear'), false);
});

test('queue snapshots, status and selection retain release years, while edited identities drop the old year', () => {
  const queue = new PlaylistQueue({ bridge: { requireDevice() {} }, playback: { status: () => null, intent: 0, cancel() {} } });
  queue.launch = () => {}; // Inspect a prepared queue without invoking any playback transport.
  const track = { id: 'entry', title: 'Song', artist: 'Artist', album: 'Album', source: 'spotify', country: 'IN', releaseYear: 2014 };
  queue.startLocal({ playlist: { id: 'list', source: 'local', name: 'Saved', country: 'IN', tracks: [track] }, deviceId: 'echo', country: 'IN', providerId: 'apple-music' });
  assert.equal(queue.current.tracks[0].releaseYear, 2014);
  assert.equal(queue.status().items[0].releaseYear, 2014);
  assert.equal(queue.status().currentTrack.releaseYear, 2014);
  assert.equal(queue.getTrack(queue.current.tracks[0].id, queue.current.id).releaseYear, 2014);
  const playlist = { id: 'yt-list', source: 'youtube-music', title: 'YouTube', tracks: [{ ...track, source: 'youtube-music' }] };
  queue.start({ playlist, edits: [], deviceId: 'echo', country: 'IN', providerId: 'apple-music' });
  assert.equal(queue.getTrack('entry', queue.current.id).releaseYear, 2014);
  queue.start({ playlist, edits: [{ id: 'entry', title: 'A different song' }], deviceId: 'echo', country: 'IN', providerId: 'apple-music' });
  assert.equal(queue.getTrack('entry', queue.current.id).releaseYear, undefined);
  queue.cancel();
});
