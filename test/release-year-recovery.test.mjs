import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackCoordinator } from '../library/playback.mjs';
import { buildMusicCommand } from '../library/catalog.mjs';
import { comparePlayback } from '../library/music-matching.mjs';

const selected = { id: 'shake-original', title: 'Shake It Off', album: '1989', artist: 'Taylor Swift', requestArtist: 'Taylor Swift', requestArtists: ['Taylor Swift'], releaseYear: 2014, durationMs: 219000 };
const old = { state: 'PLAYING', title: 'Old song', artist: 'Other artist', album: 'Old album', mediaId: 'old-media', providerName: 'Apple Music' };
const wrong = { state: 'PLAYING', title: 'Shake It Off', artist: 'Taylor Swift', album: '1989 (Taylor’s Version)', mediaId: 'rerecording', providerName: 'Apple Music', durationMs: 219000 };
const right = { ...wrong, album: '1989', mediaId: 'original-recording' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ observe, send, sleep: sleepHook, commandGapMs = 0, attemptMs = 80, releaseYearResolver } = {}) {
  let time = 1000, reads = 0;
  const requests = [], corrections = [], saves = [];
  let coordinator;
  const bridge = {
    requireDevice(id) { assert.equal(id, 'echo'); },
    async freshPlayer() {
      reads++;
      return { player: observe ? await observe({ requests, corrections, reads, coordinator }) : !requests.length ? old : requests.at(-1).track.requestYear ? right : wrong };
    },
    async play(track, deviceId, providerId, options) {
      requests.push({ track: { ...track }, deviceId, providerId, options, command: buildMusicCommand(track, providerId) });
      if (send) await send({ track, requests, corrections, coordinator });
      return { status: 'sent' };
    },
    async sendTextCommand(text, deviceId, options) { corrections.push({ text, deviceId, options }); return { status: 'sent' }; },
  };
  coordinator = new PlaybackCoordinator({ bridge, releaseYearResolver, artistPreferences: { apply: value => value, set: (...args) => saves.push(args) }, clock: () => time,
    sleep: async (ms, signal) => { if (sleepHook) await sleepHook({ ms, signal, requests, corrections, coordinator }); time += ms; },
    pollMs: 10, graceMs: 30, attemptMs, commandGapMs });
  const begin = (track = selected, providerId = 'apple-music', requestMode = 'standard') => {
    const job = coordinator.reserve({ deviceId: 'echo', country: 'IN', trackHint: track, providerId, requestMode });
    coordinator.start(job, track); return job;
  };
  return { coordinator, requests, corrections, saves, begin, get reads() { return reads; } };
}

const yearRequests = f => f.requests.filter(item => item.track.requestYear !== undefined);

test('edition matching checks title and album while preserving explicit recording versions', () => {
  assert.equal(comparePlayback(selected, wrong).verdict, 'mismatch', 'plain song title cannot hide the rerecorded album');
  assert.equal(comparePlayback(selected, { ...wrong, title: "Shake It Off (Taylor's Version)", album: '' }).verdict, 'mismatch');
  const tv = { ...selected, title: 'Shake It Off (Taylor’s Version)', album: '1989 (Taylor’s Version)', releaseYear: 2023 };
  assert.equal(comparePlayback(tv, wrong).verdict, 'match', 'album evidence can supply the edition omitted from the reported title');
  assert.equal(comparePlayback({ ...tv, title: 'Shake It Off' }, { ...wrong, title: "Shake It Off (Taylor's Version)" }).verdict, 'match');
  assert.equal(comparePlayback(tv, right).verdict, 'mismatch');
  assert.equal(comparePlayback(tv, { ...right, album: '' }).verdict, 'unknown', 'missing album data does not identify an unlabelled rerecording');
  assert.equal(comparePlayback({ ...tv, title: 'Shake It Off (Taylor’s Version) (Live)' }, wrong).verdict, 'mismatch');
  assert.equal(comparePlayback(selected, { ...right, title: 'Shake It Off (Live)' }).verdict, 'mismatch');
  assert.equal(comparePlayback(selected, { state: 'PLAYING' }).verdict, 'unknown');
});

test('normal command stays unchanged and the selected release year is used only for the backup request', async () => {
  const f = fixture(); const original = structuredClone(selected), job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'matched');
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].command, 'play song Shake It Off by Taylor Swift on Apple Music');
  assert.equal(f.requests[0].track.requestYear, undefined);
  assert.equal(f.requests[1].command, 'play song Shake It Off 2014 by Taylor Swift on Apple Music');
  assert.equal(f.requests[1].track.title, 'Shake It Off');
  assert.equal(f.requests[1].track.requestYear, 2014);
  assert.deepEqual(selected, original);
  assert.equal(job.track.title, selected.title); assert.equal(job.matchTrack.title, selected.title);
  assert.equal(f.saves.length, 0, 'year-qualified recovery does not prove a new artist alias');
  assert.ok(f.reads >= 6, 'stable mismatch and two fresh matching readings are required');
});

test('generic songs use their own reliable year rather than a Taylor-specific hardcoded value', async () => {
  const track = { id: 'generic', title: 'Ordinary Song', album: 'Studio album', artist: 'Artist', requestArtist: 'Artist', requestArtists: ['Artist'], releaseYear: 2019, durationMs: 200000 };
  const bad = { state: 'PLAYING', title: 'Ordinary Song (Live)', artist: 'Artist', album: 'Live album', mediaId: 'live', providerName: 'Apple Music', durationMs: 200000 };
  const good = { ...bad, title: track.title, album: track.album, mediaId: 'studio' };
  const f = fixture({ observe: ({ requests }) => !requests.length ? old : requests.at(-1).track.requestYear ? good : bad });
  const job = f.begin(track); await job.task;
  assert.equal(f.coordinator.status().state, 'matched');
  assert.deepEqual(yearRequests(f).map(item => item.track.requestYear), [2019]);
  assert.equal(f.requests[0].command, 'play song Ordinary Song by Artist on Apple Music');
  assert.equal(f.requests[1].command, 'play song Ordinary Song 2019 by Artist on Apple Music');
});

test('a selected rerecording keeps its version identity and own year in fallback wording', async () => {
  const tv = { ...selected, title: 'Shake It Off (Taylor’s Version)', album: '1989 (Taylor’s Version)', releaseYear: 2023 };
  const f = fixture({ observe: ({ requests }) => !requests.length ? old : requests.at(-1).track.requestYear ? wrong : right });
  const job = f.begin(tv); await job.task;
  assert.equal(f.coordinator.status().state, 'matched');
  assert.equal(f.requests[0].command, 'play song Shake It Off (Taylor’s Version) by Taylor Swift on Apple Music');
  assert.equal(f.requests[1].command, 'play song Shake It Off (Taylor’s Version) 2023 by Taylor Swift on Apple Music');
  assert.ok(f.requests.every(item => !item.command.includes('2014')));
});

test('an exact first recording never gets a year-qualified retry', async () => {
  const f = fixture({ observe: ({ requests }) => requests.length ? right : old }); const job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'matched'); assert.equal(f.requests.length, 1); assert.equal(yearRequests(f).length, 0);
});

test('missing or invalid selected release years are never invented for a recording mismatch', async () => {
  for (const releaseYear of [undefined, null, '2014', 999, 10000, NaN]) {
    const f = fixture(); const job = f.begin({ ...selected, releaseYear }); await job.task;
    assert.equal(yearRequests(f).length, 0, String(releaseYear));
  }
});

test('unknown, paused, stopped, wrong-service and stale observations do not trigger year recovery', async () => {
  for (const item of [
    { player: { state: 'UNKNOWN' } },
    { player: { ...wrong, title: '', artist: '' } },
    { player: { ...wrong, state: 'PAUSED' } },
    { player: { ...wrong, state: 'STOPPED' } },
    { player: { ...wrong, providerName: 'Spotify' } },
    { player: { ...wrong, providerName: undefined } },
    { player: { ...wrong, providerName: undefined }, provider: 'alexa-default' },
    { player: wrong, baseline: wrong },
  ]) {
    const f = fixture({ observe: ({ requests }) => requests.length ? item.player : item.baseline || old });
    const job = f.begin(selected, item.provider || 'apple-music'); await job.task;
    assert.equal(yearRequests(f).length, 0, JSON.stringify(item));
  }
});

test('one transient mismatch followed by unknown state cannot trigger a year retry', async () => {
  let mismatchReads = 0;
  const f = fixture({ observe: ({ requests }) => !requests.length ? old : ++mismatchReads === 1 ? wrong : { state: 'UNKNOWN' } });
  const job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'unverified'); assert.equal(yearRequests(f).length, 0);
});

test('Alexa default retains its selected routing and known actual service for the qualified retry', async () => {
  const f = fixture(); const job = f.begin(selected, 'alexa-default'); await job.task;
  assert.equal(f.coordinator.status().state, 'matched'); assert.equal(yearRequests(f).length, 1);
  assert.equal(f.requests[1].providerId, 'alexa-default');
  assert.equal(f.requests[1].command, 'play song Shake It Off 2014 by Taylor Swift');
});

test('music-request diagnostic mode does not silently add a standard year fallback', async () => {
  const f = fixture(); const job = f.begin(selected, 'apple-music', 'music-request-test'); await job.task;
  assert.equal(yearRequests(f).length, 0); assert.equal(f.requests.length, 1);
});

test('the year-qualified fallback occurs once before continuing bounded artist alternatives', async () => {
  const f = fixture({ observe: ({ requests }) => requests.length ? wrong : old });
  const job = f.begin({ ...selected, requestArtists: ['Taylor Swift', 'Guest One', 'Guest Two'] }); await job.task;
  assert.equal(yearRequests(f).length, 1); assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests.map(item => [item.track.requestArtist, item.track.requestYear]), [
    ['Taylor Swift', undefined], ['Taylor Swift', 2014], ['Guest One', undefined], ['Guest Two', undefined],
  ]);
  assert.equal(f.coordinator.status().state, 'unmatched'); assert.equal(f.saves.length, 0);
});

test('one matching reading after a year retry does not establish success or teach an artist', async () => {
  let matchingReads = 0;
  const f = fixture({ observe: ({ requests }) => !requests.length ? old : !requests.at(-1).track.requestYear ? wrong : ++matchingReads === 1 ? right : { state: 'UNKNOWN' } });
  const job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'unverified'); assert.equal(yearRequests(f).length, 1); assert.equal(f.saves.length, 0);
});

test('uncertain year-request submission stops further retries', async () => {
  const f = fixture({ send: async ({ track }) => { if (track.requestYear) throw new Error('transport uncertainty'); } });
  const job = f.begin({ ...selected, requestArtists: ['Taylor Swift', 'Guest Artist'] }); await job.task;
  assert.equal(f.coordinator.status().state, 'unverified'); assert.equal(f.requests.length, 2); assert.equal(yearRequests(f).length, 1); assert.equal(f.saves.length, 0);
});

test('cancellation during command spacing prevents a scheduled year retry', async () => {
  const f = fixture({ commandGapMs: 40, sleep: ({ signal, requests, coordinator }) => { if (!signal && requests.length) coordinator.cancel('Cancelled while waiting for year retry.'); } });
  const job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'cancelled'); assert.equal(f.requests.length, 1); assert.equal(yearRequests(f).length, 0);
});

test('cancelling an in-flight year retry prevents later observations, alternatives and preference writes', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ send: async ({ track }) => { if (track.requestYear) { entered.resolve(); await release.promise; } } });
  const job = f.begin(); await entered.promise;
  const reads = f.reads; f.coordinator.cancel('User cancelled.'); release.resolve(); await job.task;
  assert.equal(f.coordinator.status().state, 'cancelled'); assert.equal(f.reads, reads); assert.equal(f.requests.length, 2); assert.equal(f.saves.length, 0);
});

test('a newer song invalidates a blocked older mismatch before the year retry can dispatch', async () => {
  const entered = deferred(), release = deferred(); let mismatchReads = 0, blocked = false;
  const next = { ...selected, id: 'new-song', title: 'Next selection', album: 'Another album', releaseYear: 2020 };
  const f = fixture({ observe: ({ requests }) => {
    if (!requests.length) return old;
    if (requests.at(-1).track.id === next.id) return { ...right, title: next.title, album: next.album, mediaId: 'new-selection' };
    if (!blocked && ++mismatchReads === 3) { blocked = true; entered.resolve(); return release.promise; }
    return wrong;
  } });
  const first = f.begin(); await entered.promise;
  const second = f.begin(next); release.resolve(wrong); await Promise.all([first.task, second.task]);
  assert.equal(first.state, 'cancelled'); assert.equal(f.coordinator.status().id, second.id); assert.equal(f.coordinator.status().state, 'matched'); assert.equal(yearRequests(f).length, 0);
});

test('same-named album recovery retains priority over a generic release-year retry', async () => {
  const lover = { ...selected, id: 'lover', title: 'Lover', album: 'Lover', releaseYear: 2019, durationMs: 221000 };
  const otherAlbumSong = { ...wrong, title: 'I Forgot That You Existed', album: 'Lover', mediaId: 'lover-album-first' };
  const titleTrack = { ...right, title: 'Lover', album: 'Lover', mediaId: 'lover-title-track', durationMs: 221000 };
  const f = fixture({ observe: ({ requests, corrections }) => !requests.length ? old : corrections.length ? titleTrack : otherAlbumSong });
  const job = f.begin(lover); await job.task;
  assert.equal(f.coordinator.status().state, 'matched'); assert.equal(yearRequests(f).length, 0); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.corrections.map(item => item.text), ['No, just play the title track']);
});


test('builder preserves an edition specified only by the selected album without adding a year initially', () => {
  const tv = { ...selected, title: 'Shake It Off', album: '1989 (Taylor’s Version)', releaseYear: 2023 };
  assert.equal(buildMusicCommand(tv, 'apple-music'), "play song Shake It Off (Taylor's Version) by Taylor Swift on Apple Music");
  assert.equal(buildMusicCommand({ ...tv, requestYear: 2023 }, 'apple-music'), "play song Shake It Off (Taylor's Version) 2023 by Taylor Swift on Apple Music");
  assert.equal(buildMusicCommand({ ...selected, title: 'Shake It Off (Live)', requestYear: 2014 }, 'spotify'), 'play song Shake It Off (Live) 2014 by Taylor Swift on Spotify');
  assert.equal(tv.title, 'Shake It Off');
});

test('a known release year needs no lookup and a correct first request never looks one up', async () => {
  let lookups = 0;
  const resolver = { async resolve() { lookups++; throw new Error('must not be used'); } };
  const known = fixture({ releaseYearResolver: resolver }); const first = known.begin(); await first.task;
  assert.equal(known.coordinator.status().state, 'matched'); assert.equal(lookups, 0);
  const correct = fixture({ releaseYearResolver: resolver, observe: ({ requests }) => requests.length ? right : old });
  const second = correct.begin({ ...selected, releaseYear: undefined }); await second.task;
  assert.equal(correct.coordinator.status().state, 'matched'); assert.equal(lookups, 0);
});

test('a missing year is resolved lazily once after mismatch and used only on the backup command', async () => {
  let lookups = 0;
  const f = fixture({ releaseYearResolver: { async resolve(track, country, options) {
    lookups++; assert.equal(track.title, selected.title); assert.equal(country, 'IN'); assert.equal(options.signal.aborted, false); return 2014;
  } } });
  const job = f.begin({ ...selected, releaseYear: undefined }); await job.task;
  assert.equal(f.coordinator.status().state, 'matched'); assert.equal(lookups, 1);
  assert.deepEqual(yearRequests(f).map(item => item.track.requestYear), [2014]);
  assert.equal(f.requests[0].track.requestYear, undefined); assert.equal(job.track.releaseYear, undefined);
});

test('a failed year lookup is bounded to once while ordinary artist alternatives remain available', async () => {
  let lookups = 0;
  const f = fixture({ releaseYearResolver: { async resolve() { lookups++; return null; } }, observe: ({ requests }) => requests.length ? wrong : old });
  const job = f.begin({ ...selected, releaseYear: undefined, requestArtists: ['Taylor Swift', 'Guest One', 'Guest Two'] }); await job.task;
  assert.equal(f.coordinator.status().state, 'unmatched'); assert.equal(lookups, 1); assert.equal(f.requests.length, 3); assert.equal(yearRequests(f).length, 0);
});

test('cancelling a release-year lookup prevents its late result from sending any backup', async () => {
  const entered = deferred(), release = deferred(); let signal;
  const f = fixture({ releaseYearResolver: { async resolve(track, country, options) { signal = options.signal; entered.resolve(); return release.promise; } } });
  const job = f.begin({ ...selected, releaseYear: undefined }); await entered.promise;
  f.coordinator.cancel('Cancelled during release-year lookup.'); assert.equal(signal.aborted, true);
  release.resolve(2014); await job.task;
  assert.equal(f.coordinator.status().state, 'cancelled'); assert.equal(f.requests.length, 1); assert.equal(yearRequests(f).length, 0); assert.equal(f.saves.length, 0);
});

test('a new song selection supersedes an old year lookup without waiting for its result', async () => {
  const entered = deferred(), release = deferred();
  const next = { ...selected, id: 'lookup-next', title: 'Another song', album: 'Another album', releaseYear: 2020 };
  const f = fixture({ releaseYearResolver: { async resolve() { entered.resolve(); return release.promise; } }, observe: ({ requests }) => {
    if (!requests.length) return old;
    return requests.at(-1).track.id === next.id ? { ...right, title: next.title, album: next.album, mediaId: 'next-after-lookup' } : wrong;
  } });
  const first = f.begin({ ...selected, releaseYear: undefined }); await entered.promise;
  const second = f.begin(next); release.resolve(2014); await Promise.all([first.task, second.task]);
  assert.equal(first.state, 'cancelled'); assert.equal(f.coordinator.status().id, second.id); assert.equal(f.coordinator.status().state, 'matched'); assert.equal(yearRequests(f).length, 0);
});

test('a late successful original request during lookup is confirmed without sending a year retry', async () => {
  let lookedUp = false;
  const f = fixture({ releaseYearResolver: { async resolve() { lookedUp = true; return 2014; } }, observe: ({ requests }) => !requests.length ? old : lookedUp ? right : wrong });
  const job = f.begin({ ...selected, releaseYear: undefined }); await job.task;
  assert.equal(f.coordinator.status().state, 'matched'); assert.equal(f.requests.length, 1); assert.equal(yearRequests(f).length, 0);
});

test('a manual skip during a year lookup stops both year and ordinary artist retries even when no year is found', async () => {
  for (const year of [2014, null]) {
    let lookedUp = false;
    const changed = { ...old, title: 'Manual selection', mediaId: 'manually-changed' };
    const f = fixture({ releaseYearResolver: { async resolve() { lookedUp = true; return year; } }, observe: ({ requests }) => !requests.length ? old : lookedUp ? changed : wrong });
    const job = f.begin({ ...selected, releaseYear: undefined, requestArtists: ['Taylor Swift', 'Guest Artist'] }); await job.task;
    assert.equal(f.coordinator.status().state, 'cancelled', String(year)); assert.equal(f.requests.length, 1, String(year)); assert.equal(yearRequests(f).length, 0);
  }
});

test('a year or album edition cannot turn a blank cleaned song title into a request', () => {
  for (const title of ['   ', '(feat. Guest)', '[from Film]']) {
    assert.throws(() => buildMusicCommand({ ...selected, title, album: '1989 (Taylor’s Version)', requestYear: 2014 }, 'apple-music'), { code: 'INVALID_TRACK' });
  }
});

test('a confirmed near-start replay of the same wrong recording permits the one-time year backup', async () => {
  let reads = 0;
  const baseline = { ...wrong, positionMs: 120000 };
  const f = fixture({ observe: ({ requests }) => {
    if (!requests.length) return baseline;
    if (requests.at(-1).track.requestYear) return { ...right, positionMs: 1000 };
    return { ...wrong, positionMs: 1000 + ++reads * 10 };
  } });
  const job = f.begin(); await job.task;
  assert.equal(f.coordinator.status().state, 'matched'); assert.equal(yearRequests(f).length, 1);
  assert.equal(f.requests[0].track.requestYear, undefined); assert.equal(f.requests[1].track.requestYear, 2014);
});

test('same-media playback without a valid near-start reset remains stale and cannot trigger year recovery', async () => {
  for (const [baselinePosition, currentPosition] of [
    [120000, 120010], [120000, 60000], [4000, 0], [undefined, 0], [120000, undefined],
    [Infinity, 0], [120000, NaN], [120000, -1], [120000, '0'],
  ]) {
    const baseline = { ...wrong, positionMs: baselinePosition };
    const f = fixture({ observe: ({ requests }) => requests.length ? { ...wrong, positionMs: currentPosition } : baseline });
    const job = f.begin(); await job.task;
    assert.equal(yearRequests(f).length, 0, String(baselinePosition) + ' -> ' + String(currentPosition));
  }
});

test('one transient reset reading among unchanged baseline playback cannot trigger a year backup', async () => {
  let reads = 0;
  const baseline = { ...wrong, positionMs: 120000 };
  const f = fixture({ observe: ({ requests }) => !requests.length ? baseline : { ...wrong, positionMs: ++reads === 3 ? 0 : 120000 + reads * 10 } });
  const job = f.begin(); await job.task;
  assert.equal(yearRequests(f).length, 0); assert.equal(f.requests.length, 1);
});
