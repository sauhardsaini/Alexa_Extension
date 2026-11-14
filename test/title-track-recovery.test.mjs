import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackCoordinator } from '../library/playback.mjs';
import { isTitleTrackAlbumPlayback } from '../library/music-matching.mjs';

const PHRASE = 'No, just play the title track';
const selected = { id: 'lover', title: 'Lover', album: 'Lover', artist: 'Taylor Swift', requestArtist: 'Taylor Swift', requestArtists: ['Taylor Swift'], durationMs: 221000 };
const old = { state: 'PLAYING', title: 'Old song', artist: 'Other artist', album: 'Old album', mediaId: 'old-media', providerName: 'Apple Music' };
const albumSong = { state: 'PLAYING', title: 'I Forgot That You Existed', artist: 'Taylor Swift', album: 'Lover', mediaId: 'album-first-song', providerName: 'Apple Music', durationMs: 170000 };
const titleTrack = { state: 'PLAYING', title: 'Lover', artist: 'Taylor Swift', album: 'Lover', mediaId: 'selected-title-track', providerName: 'Apple Music', durationMs: 221000 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ observe, send, sleep: sleepHook, commandGapMs = 0, attemptMs = 80 } = {}) {
  let time = 1000, reads = 0;
  const requests = [], corrections = [], saves = [];
  let coordinator;
  const bridge = {
    requireDevice(id) { assert.equal(id, 'echo'); },
    async freshPlayer() {
      reads++;
      const state = { requests, corrections, reads, coordinator };
      return { player: observe ? await observe(state) : requests.length ? corrections.length ? titleTrack : albumSong : old };
    },
    async play(track, deviceId, providerId) { requests.push({ track: { ...track }, deviceId, providerId }); return { status: 'sent' }; },
    async sendTextCommand(text, deviceId, options) { corrections.push({ text, deviceId, options }); if (send) await send({ requests, corrections, coordinator }); return { status: 'sent' }; },
  };
  coordinator = new PlaybackCoordinator({ bridge, artistPreferences: { apply: value => value, set: (...args) => saves.push(args) }, clock: () => time,
    sleep: async (ms, signal) => { if (sleepHook) await sleepHook({ ms, signal, requests, corrections, coordinator }); time += ms; },
    pollMs: 10, graceMs: 30, attemptMs, commandGapMs });
  const begin = (track = selected, providerId = 'apple-music', requestMode = 'standard') => {
    const job = coordinator.reserve({ deviceId: 'echo', country: 'IN', trackHint: track, providerId, requestMode });
    coordinator.start(job, track); return job;
  };
  return { coordinator, requests, corrections, saves, begin, get reads() { return reads; } };
}

test('title-track album detection requires known same-title album and matching artist identity', () => {
  assert.equal(isTitleTrackAlbumPlayback(selected, albumSong), true);
  assert.equal(isTitleTrackAlbumPlayback({ ...selected, title: 'Lóver', album: 'Lover' }, albumSong), true);
  for (const [track, player] of [
    [{ ...selected, album: '' }, albumSong],
    [{ ...selected, album: 'Different album' }, albumSong],
    [{ ...selected, title: 'Lover (Live)' }, albumSong],
    [selected, { ...albumSong, album: 'Lover (Remix)' }],
    [selected, { ...albumSong, album: '' }],
    [selected, { ...albumSong, title: 'Lover' }],
    [selected, { ...albumSong, artist: 'Taylor Swift tribute' }],
    [selected, { ...albumSong, artist: '' }],
    [selected, { ...albumSong, state: 'PAUSED' }],
    [selected, { ...albumSong, state: 'STOPPED' }],
    [selected, { ...albumSong, state: 'UNKNOWN' }],
  ]) assert.equal(isTitleTrackAlbumPlayback(track, player), false, JSON.stringify({ track, player }));
});

test('album detector respects separately known multi-artist credits and whole band names', () => {
  assert.equal(isTitleTrackAlbumPlayback({ ...selected, artist: 'Taylor Swift, Guest Artist', requestArtists: ['Taylor Swift', 'Guest Artist'] }, { ...albumSong, artist: 'Taylor Swift & Guest Artist' }), true);
  assert.equal(isTitleTrackAlbumPlayback({ ...selected, artist: 'Earth', requestArtist: 'Earth', requestArtists: ['Earth'] }, { ...albumSong, artist: 'Earth, Wind & Fire' }), false);
});

test('matching-album playback gets the exact contextual correction once and two fresh title-track confirmations', async () => {
  const f = fixture(); const job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'matched');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.corrections, [{ text: PHRASE, deviceId: 'echo', options: { kind: 'music' } }]);
  assert.ok(f.reads >= 6, 'baseline, stable album observations and two target confirmations are required');
  assert.equal(f.saves.length, 0, 'a contextual correction does not prove a new artist wording');
});

test('Alexa-default recovery retains the reported service without changing the selected provider', async () => {
  const f = fixture(); const job = f.begin(selected, 'alexa-default'); await job.task;
  assert.equal(f.coordinator.status().state, 'matched'); assert.equal(f.coordinator.status().reportedProviderName, 'Apple Music');
  assert.equal(f.requests[0].providerId, 'alexa-default'); assert.equal(f.corrections.length, 1);
});

test('a transient album reading followed by unknown metadata never triggers a contextual correction', async () => {
  let albumReads = 0;
  const f = fixture({ observe: ({ requests }) => !requests.length ? old : ++albumReads === 1 ? albumSong : { state: 'UNKNOWN' } });
  const job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'unverified'); assert.equal(f.corrections.length, 0);
});

test('a correct first song is left alone and never receives the title-track correction', async () => {
  const f = fixture({ observe: ({ requests }) => requests.length ? titleTrack : old });
  const job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'matched'); assert.equal(f.corrections.length, 0); assert.equal(f.requests.length, 1);
});

test('wrong or missing service, arbitrary wrong track, stale baseline, paused and stopped playback do not get contextual correction', async () => {
  const cases = [
    { player: { ...albumSong, providerName: 'Spotify' } },
    { player: { ...albumSong, providerName: undefined } },
    { player: { ...albumSong, providerName: undefined }, providerId: 'alexa-default' },
    { player: { ...albumSong, album: 'Different album' } },
    { player: { ...albumSong, artist: 'Different artist' } },
    { player: { ...albumSong, state: 'PAUSED' } },
    { player: { ...albumSong, state: 'STOPPED' } },
    { player: { ...albumSong, state: 'UNKNOWN' } },
    { player: albumSong, baseline: albumSong },
    { player: albumSong, track: { ...selected, album: '' } },
  ];
  for (const item of cases) {
    const f = fixture({ observe: ({ requests }) => requests.length ? item.player : item.baseline || old });
    const job = f.begin(item.track || selected, item.providerId || 'apple-music'); await job.task;
    assert.equal(f.corrections.length, 0, JSON.stringify(item));
  }
});

test('diagnostic music-request mode never falls back to a conversational title-track command', async () => {
  const f = fixture(); const job = f.begin(selected, 'apple-music', 'music-request-test'); await job.task;
  assert.equal(f.corrections.length, 0); assert.equal(f.requests.length, 1);
});

test('one target reading after correction is not enough to confirm the selected song', async () => {
  let correctedReads = 0;
  const f = fixture({ observe: ({ requests, corrections }) => !requests.length ? old : !corrections.length ? albumSong : ++correctedReads === 1 ? titleTrack : { state: 'UNKNOWN' } });
  const job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'unverified'); assert.equal(f.corrections.length, 1); assert.equal(f.saves.length, 0);
});

test('an unsuccessful contextual correction is bounded to once across all alternative artist attempts', async () => {
  const f = fixture({ observe: ({ requests }) => requests.length ? albumSong : old });
  const job = f.begin({ ...selected, requestArtists: ['Taylor Swift', 'Guest One', 'Guest Two'] }); await job.task;
  assert.equal(f.corrections.length, 1); assert.ok(f.requests.length <= 3); assert.equal(f.coordinator.status().state, 'unmatched'); assert.equal(f.saves.length, 0);
});

test('uncertain correction submission stops further song retries', async () => {
  const f = fixture({ send: async () => { throw new Error('transport uncertainty'); } });
  const job = f.begin({ ...selected, requestArtists: ['Taylor Swift', 'Guest Artist'] }); await job.task;
  assert.equal(f.coordinator.status().state, 'unverified'); assert.equal(f.requests.length, 1); assert.equal(f.corrections.length, 1); assert.equal(f.saves.length, 0);
});

test('cancellation during the spacing wait prevents a queued correction from being sent', async () => {
  const f = fixture({ commandGapMs: 40, sleep: ({ signal, requests, coordinator }) => { if (!signal && requests.length) coordinator.cancel('Cancelled while waiting to clarify.'); } });
  const job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'cancelled'); assert.equal(f.requests.length, 1); assert.equal(f.corrections.length, 0);
});

test('cancellation while correction is in flight suppresses all later checks, retries and preference writes', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ send: async () => { entered.resolve(); await release.promise; } });
  const job = f.begin(); await entered.promise;
  const reads = f.reads; f.coordinator.cancel('User cancelled.'); release.resolve(); await job.task;
  assert.equal(f.coordinator.status().state, 'cancelled'); assert.equal(f.reads, reads); assert.equal(f.requests.length, 1); assert.equal(f.corrections.length, 1); assert.equal(f.saves.length, 0);
});

test('a new song selection invalidates an older album observation before it can send a correction', async () => {
  const entered = deferred(), release = deferred(); let albumReads = 0, blocked = false;
  const next = { ...selected, id: 'other', title: 'Another selection', album: 'Another album' };
  const f = fixture({ observe: ({ requests }) => {
    if (!requests.length) return old;
    if (requests.at(-1).track.id === next.id) return { ...titleTrack, title: next.title, album: next.album, mediaId: 'new-selection' };
    if (!blocked && ++albumReads === 3) { blocked = true; entered.resolve(); return release.promise; }
    return albumSong;
  } });
  const first = f.begin(); await entered.promise;
  const second = f.begin(next); release.resolve(albumSong);
  await Promise.all([first.task, second.task]);
  assert.equal(first.state, 'cancelled'); assert.equal(f.coordinator.status().id, second.id); assert.equal(f.coordinator.status().state, 'matched'); assert.equal(f.corrections.length, 0);
});
