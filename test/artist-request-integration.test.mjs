import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLibrary } from '../library/index.mjs';
import { buildMusicCommand } from '../library/catalog.mjs';

// Exercise the real standalone library wiring and saved-playlist path. The
// metadata service and Echo are fakes, so this test cannot produce any audio.
test('a saved Spotify playlist restores artist resources and sends one artist through the complete library', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-artist-request-'));
  let time = 1000, sent = false, reads = 0;
  const commands = [], urls = [];
  const track = { title: 'Pesamale', artist: 'Siri Xander, Arra Aria Khayal', requestArtist: 'Siri Xander, Arra Aria Khayal', requestArtists: ['Siri Xander, Arra Aria Khayal'], source: 'spotify', country: 'IN', durationMs: 178124, url: 'https://open.spotify.com/track/2lo95sXI2RkrXLOYTXpZwe' };
  const bridge = {
    requireDevice() {},
    async play(candidate, deviceId, providerId) { commands.push(buildMusicCommand(candidate, providerId)); sent = true; return { status: 'sent' }; },
    async freshPlayer() {
      if (!sent) return { player: { state: 'UNKNOWN' } };
      return { player: { state: 'PLAYING', title: track.title, artist: 'Siri Xander & Arra Aria Khayal', providerName: 'Apple Music', durationMs: track.durationMs, positionMs: ++reads <= 3 ? 1000 : 177500 } };
    },
  };
  const fetcher = async (url, options) => {
    urls.push(url);
    assert.equal(options.credentials, 'omit');
    const entity = { type: 'track', id: '2lo95sXI2RkrXLOYTXpZwe', uri: 'spotify:track:2lo95sXI2RkrXLOYTXpZwe', title: track.title, artists: [{ name: 'Siri Xander', uri: 'spotify:artist:1YN9DIwQxOUnAzfgOWWiNR' }, { name: 'Arra Aria Khayal', uri: 'spotify:artist:3ktOCDucYtvRTm3UZosG93' }] };
    return new Response('<script id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } }) + '</script>', { headers: { 'content-type': 'text/html' } });
  };
  const timing = { clock: () => time, sleep: async ms => { time += ms; }, pollMs: 10 };
  const library = createLibrary({ dataDir, bridge, fetcher, playbackOptions: { ...timing, graceMs: 30, attemptMs: 60, commandGapMs: 0 }, queueOptions: timing });
  t.after(async () => { await library.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const playlist = library.localPlaylists.importTracks({ name: 'Saved', country: 'IN', tracks: [track] });
  library.queue.startLocal({ playlist, deviceId: 'echo1', country: 'IN', providerId: 'apple-music' });
  await library.queue.current.task;
  assert.equal(library.queue.status().state, 'completed');
  assert.deepEqual(commands, ['play song Pesamale by Siri Xander on Apple Music']);
  assert.deepEqual(urls, ['https://open.spotify.com/embed/track/2lo95sXI2RkrXLOYTXpZwe']);
  assert.equal(library.localPlaylists.get(playlist.id).tracks[0].requestArtist, track.requestArtist);
  assert.deepEqual(library.localPlaylists.get(playlist.id).tracks[0].requestArtists, track.requestArtists);
});
