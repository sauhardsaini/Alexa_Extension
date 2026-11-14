import { normalizeReleaseYear } from './track-release.mjs';
import { randomUUID } from 'node:crypto';
import { AppError, COUNTRIES } from './catalog.mjs';
import { comparePlayback } from './music-matching.mjs';
import { compareMusicProvider, resolveMusicProvider } from './music-providers.mjs';
import { validateSeekRequest, validateSeekTarget } from './seek.mjs';
import { normalizeRequestMode } from './playback.mjs';
import { normalizeCustomCommand } from './command-journal.mjs';

const text = (value, max = 250) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
const providerIdentity = value => text(value) ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') || null : null;
const mediaIdentity = value => text(value, 2048) ? value : null;
const changed = () => new AppError(409, 'PLAYBACK_CHANGED', 'A newer playback choice replaced this queue action.');
const wait = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener('abort', finish, { once: true });
});

// Passive recovery is separate from the normal queue task. Its timers do not
// keep a stopped/test process alive, and cancellation wakes it immediately.
const adoptionWait = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms); timer.unref?.();
  signal?.addEventListener('abort', finish, { once: true });
});
const playerKey = player => {
  if (!player || !text(player.title) || !text(player.artist) || !providerIdentity(player.providerName)) return null;
  const key = value => text(value) ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase() : '';
  return JSON.stringify([mediaIdentity(player.mediaId), key(player.title), key(player.artist), key(player.album), providerIdentity(player.providerName), player.durationMs || 0]);
};
const adoptablePlayer = player => player?.state === 'PLAYING' && playerKey(player)
  && Number.isFinite(player.durationMs) && player.durationMs > 0 && player.durationMs <= 86400000
  && Number.isFinite(player.positionMs) && player.positionMs >= 0 && player.positionMs <= player.durationMs;

function prepare(playlist, edits, startTrackId, country) {
  if (playlist?.source !== 'youtube-music' || !text(playlist.id) || !text(playlist.title, 500)
    || !Array.isArray(playlist.tracks) || !playlist.tracks.length || playlist.tracks.length > 500) {
    throw new AppError(400, 'INVALID_PLAYLIST', 'Choose a YouTube Music playlist with between 1 and 500 songs.');
  }
  if (!Array.isArray(edits) || edits.length > playlist.tracks.length) throw new AppError(400, 'INVALID_QUEUE_EDITS', 'Review the song edits and try again.');
  const ids = new Set();
  for (const track of playlist.tracks) {
    if (!text(track?.id) || ids.has(track.id)) throw new AppError(400, 'INVALID_PLAYLIST', 'Reload this playlist before playing it.');
    ids.add(track.id);
  }
  let first = 0;
  if (startTrackId !== undefined) {
    first = playlist.tracks.findIndex(track => track.id === startTrackId);
    if (!text(startTrackId) || first < 0) throw new AppError(400, 'INVALID_PLAYLIST_ENTRY', 'Choose a song in this playlist.');
  }
  const ordered = playlist.tracks.slice(first).concat(playlist.tracks.slice(0, first));
  const changes = new Map();
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) || !ids.has(edit.id) || changes.has(edit.id)
      || Object.keys(edit).some(key => !['id', 'title', 'artist'].includes(key))
      || (!Object.hasOwn(edit, 'title') && !Object.hasOwn(edit, 'artist'))
      || (Object.hasOwn(edit, 'title') && !text(edit.title)) || (Object.hasOwn(edit, 'artist') && !text(edit.artist))) {
      throw new AppError(400, 'INVALID_QUEUE_EDITS', 'Edit only the title and artist of songs in this playlist.');
    }
    changes.set(edit.id, edit);
  }
  return ordered.map(original => {
    const edit = changes.get(original.id);
    const title = edit?.title ?? original.title, artist = edit?.artist ?? original.artist;
    if (!text(title) || !text(artist) || (original.needsReview && !edit?.artist)) {
      throw new AppError(400, 'QUEUE_REVIEW_REQUIRED', 'Add a song title and artist for every song before starting the queue.');
    }
    const artistChanged = edit?.artist !== undefined && edit.artist.trim() !== original.artist?.trim();
    const titleChanged = edit?.title !== undefined && edit.title.trim() !== original.title?.trim();
    const prepared = { ...original, title: title.trim(), artist: artist.trim(), source: 'youtube-music',
      ...(artistChanged ? { requestArtist: artist.trim(), requestArtists: [artist.trim()] } : {}),
      ...(artistChanged || titleChanged ? { durationMs: 0, releaseYear: undefined } : {}) };
    return { ...snapshotTrack(prepared, country), id: original.id };
  });
}

const SOURCES = new Set(['local', 'itunes', 'apple-music', 'spotify', 'youtube-music', 'player']);
const webUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } };
function snapshotTrack(track, country) {
  if (!track || typeof track !== 'object' || !text(track.title) || !text(track.artist)
    || (track.country !== undefined && track.country !== country)
    || (track.requestArtist !== undefined && !text(track.requestArtist))
    || (track.requestArtists !== undefined && (!Array.isArray(track.requestArtists) || track.requestArtists.length > 30 || track.requestArtists.some(artist => !text(artist))))) {
    throw new AppError(400, 'INVALID_QUEUE_TRACK', 'Choose a song with a title and artist from the selected country.');
  }
  return { id: randomUUID(), entryId: text(track.id) ? track.id : null, title: track.title.trim(), artist: track.artist.trim(),
    requestArtist: track.requestArtist?.trim() || track.artist.trim(), requestArtists: track.requestArtists ? track.requestArtists.map(artist => artist.trim()) : [track.artist.trim()],
    album: text(track.album) ? track.album.trim() : '', ...(normalizeReleaseYear(track.releaseYear) !== null ? { releaseYear: track.releaseYear } : {}), artwork: webUrl(track.artwork), url: webUrl(track.url),
    durationMs: Number.isSafeInteger(track.durationMs) && track.durationMs >= 0 && track.durationMs <= 86400000 ? track.durationMs : 0,
    country, source: SOURCES.has(track.source) ? track.source : 'local' };
}
function queueModes({ shuffle = false, repeatAll = false } = {}) {
  if (typeof shuffle !== 'boolean' || typeof repeatAll !== 'boolean') throw new AppError(400, 'INVALID_QUEUE_MODE', 'Shuffle and Repeat All must be on or off.');
  return { shuffle, repeatAll };
}
function queueContext(providerId, country) {
  const provider = resolveMusicProvider(providerId);
  if (!['music', 'default'].includes(provider.kind)) throw new AppError(400, 'INVALID_QUEUE_PROVIDER', 'Choose an on-demand music service for queued songs.');
  if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose a catalogue country before adding songs.');
  return provider;
}

export class PlaylistQueue {
  constructor({ bridge, playback, clock = Date.now, sleep = wait, pollMs = 2500, random = Math.random, adoptionSleep = adoptionWait, adoptionPollMs = 2500, adoptionAttempts = 120 } = {}) {
    if (!bridge || !playback) throw new Error('bridge and playback required');
    this.bridge = bridge;
    this.playback = playback;
    this.clock = clock;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.random = random;
    this.adoptionSleep = adoptionSleep;
    this.adoptionPollMs = adoptionPollMs;
    this.adoptionAttempts = adoptionAttempts;
    this.current = null;
    this.lastCreatedAt = 0;
    this.mutation = 0;
  }
  status() {
    const job = this.current;
    if (!job) return null;
    if (job.active && job.state !== 'ready' && !this.ownsIntent(job)) this.finish(job, 'cancelled', 'Queue cancelled because another playback choice took over.');
    const { id, state, active, title, index, total, message, providerId, providerName, deviceId, country, createdAt, updatedAt, playbackRequestId } = job;
    const track = job.state === 'ready' ? null : job.tracks[index];
    const items = job.tracks.map((item, at) => ({ id: item.id, title: item.title, artist: item.artist, album: item.album || '', ...(normalizeReleaseYear(item.releaseYear) !== null ? { releaseYear: item.releaseYear } : {}), artwork: item.artwork || '', source: item.source || 'youtube-music',
      state: job.state === 'ready' ? 'pending' : at < index ? 'played' : at === index ? 'current' : 'pending' }));
    return { id, state, active, title, index, total, currentTrack: track ? { id: track.id, title: track.title, artist: track.artist, source: track.source || 'youtube-music', ...(normalizeReleaseYear(track.releaseYear) !== null ? { releaseYear: track.releaseYear } : {}), adopted: Boolean(track.adopted), ...(track.fallbackWarning ? { requestedTitle: track.requestedTrack.title, fallback: true } : {}) } : null, items,
      currentProviderName: track?.adoptedProviderName || null, warning: track?.fallbackWarning || null,
      manualRecovery: Boolean(job.manualRecovery), message, providerId, providerName, deviceId, country, createdAt, updatedAt, playbackRequestId, seeking: Boolean(job.seekBusy), shuffle: Boolean(job.shuffle), repeatAll: Boolean(job.repeatAll) };
  }
  providerFor(job) { return job.tracks[job.index]?.adopted ? 'alexa-default' : job.providerId; }
  createJob({ tracks, title, deviceId = null, provider, country, state = 'ready', matched = false, progress = null, shuffle = false, repeatAll = false }) {
    const modes = queueModes({ shuffle, repeatAll }), cycleTracks = [...tracks];
    if (modes.shuffle) tracks = state === 'ready' ? this.shuffled(tracks) : tracks.slice(0, 1).concat(this.shuffled(tracks.slice(1)));
    const createdAt = this.lastCreatedAt = Math.max(this.clock(), this.lastCreatedAt + 1);
    const job = this.current = { id: randomUUID(), state, active: true, title, tracks, cycleTracks, ...modes, cycle: 0, index: 0, total: tracks.length,
      message: state === 'ready' ? 'Songs are ready. Choose an Echo and Start when you want to play them.' : state === 'paused' ? 'Your current song is paused. Queued songs will wait until you resume.' : 'Watching your current song. Queued songs will start after its end is confirmed.',
      providerId: provider.id, providerName: provider.name, deviceId, country, createdAt, updatedAt: createdAt,
      playbackRequestId: null, revision: 0, matched, progress, verifiedProvider: progress?.actualProvider || null, seekBusy: false, abort: new AbortController(), task: Promise.resolve() };
    ++this.mutation;
    this.captureIntent(job);
    return job;
  }
  shuffled(tracks) {
    const copy = [...tracks];
    for (let index = copy.length - 1; index > 0; index--) {
      const value = this.random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Invalid shuffle random value');
      const other = Math.floor(value * (index + 1));
      [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
  }
  mode({ requestId, shuffle, repeatAll } = {}) {
    const snapshot = this.status(), job = this.current;
    if (!snapshot?.active) throw new AppError(409, 'NO_ACTIVE_QUEUE', 'Start a playlist queue first.');
    if (typeof requestId !== 'string' || requestId !== job.id) throw new AppError(409, 'QUEUE_CHANGED', 'A newer queue replaced this mode change.');
    if ((shuffle === undefined && repeatAll === undefined) || (shuffle !== undefined && typeof shuffle !== 'boolean') || (repeatAll !== undefined && typeof repeatAll !== 'boolean')) throw new AppError(400, 'INVALID_QUEUE_MODE', 'Choose Shuffle or Repeat All on or off.');
    let tracks = job.tracks;
    if (shuffle !== undefined && shuffle !== Boolean(job.shuffle)) {
      const firstPending = job.state === 'ready' ? 0 : job.index + 1;
      const upcoming = tracks.slice(firstPending);
      if (shuffle) tracks = tracks.slice(0, firstPending).concat(this.shuffled(upcoming));
      else {
        const order = new Map(job.cycleTracks.map((track, index) => [track.id, index]));
        tracks = tracks.slice(0, firstPending).concat(upcoming.sort((left, right) => order.get(left.id) - order.get(right.id)));
      }
    }
    ++this.mutation;
    this.update(job, { tracks, ...(shuffle === undefined ? {} : { shuffle }), ...(repeatAll === undefined ? {} : { repeatAll }) });
    return { queue: this.status(), message: 'Queue playback options updated.' };
  }
  repeat(job) {
    let tracks = [...job.cycleTracks];
    if (!tracks.length) return false;
    if (job.shuffle) tracks = tracks.slice(0, 1).concat(this.shuffled(tracks.slice(1)));
    this.update(job, { tracks, index: 0, total: tracks.length, cycle: job.cycle + 1, matched: false, progress: null, verifiedProvider: null, state: 'preparing', message: 'Repeating this playlist from its first selected song…' });
    return true;
  }
  startLocal({ playlist, deviceId, providerId = 'alexa-default', country, startEntryId, requestMode = 'standard', shuffle = false, repeatAll = false } = {}) {
    const provider = queueContext(providerId, country), modes = queueModes({ shuffle, repeatAll });
    requestMode = normalizeRequestMode(requestMode, provider.id);
    const title = playlist?.title || playlist?.name;
    if (playlist?.source !== 'local' || !text(playlist.id) || !text(title, 500) || playlist.country !== country
      || !Array.isArray(playlist.tracks) || !playlist.tracks.length || playlist.tracks.length > 500) {
      throw new AppError(400, 'INVALID_PLAYLIST', 'Choose a local playlist from the selected country with 1 to 500 songs.');
    }
    const tracks = playlist.tracks.map(track => snapshotTrack(track, country));
    let first = 0;
    if (startEntryId !== undefined) {
      first = tracks.findIndex(track => track.entryId === startEntryId);
      if (!text(startEntryId) || first < 0) throw new AppError(400, 'INVALID_PLAYLIST_ENTRY', 'Choose a song in this playlist.');
    }
    this.bridge.requireDevice(deviceId);
    this.cancel('Replaced by your local playlist selection.');
    const job = this.createJob({ tracks: tracks.slice(first).concat(tracks.slice(0, first)), title: title.trim(), deviceId, provider, country, state: 'preparing', ...modes });
    job.requestMode = requestMode;
    this.launch(job);
    return { queue: this.status() };
  }
  async enqueue({ track, placement = 'last', deviceId = null, providerId = 'alexa-default', country, queueId, shuffle = false, repeatAll = false } = {}) {
    const provider = queueContext(providerId, country), modes = queueModes({ shuffle, repeatAll });
    const item = snapshotTrack(track, country);
    if (!['next', 'last'].includes(placement)) throw new AppError(400, 'INVALID_QUEUE_PLACEMENT', 'Choose Play next or Add to queue.');
    if (deviceId !== null && deviceId !== undefined && !text(deviceId)) throw new AppError(400, 'INVALID_DEVICE', 'Choose an Echo from your connected account.');
    const snapshot = this.status(), previous = this.current;
    if (queueId !== undefined && queueId !== snapshot?.id) throw new AppError(409, 'QUEUE_CHANGED', 'A newer queue replaced this selection.');
    if (snapshot?.active) {
      if (snapshot.country !== country || snapshot.providerId !== provider.id || (snapshot.state !== 'ready' && snapshot.deviceId !== deviceId)) {
        throw new AppError(409, 'QUEUE_CONTEXT_CHANGED', 'Use this queue’s Echo, country, and streaming service, or clear it before choosing another.');
      }
      if (previous.total >= 500) throw new AppError(400, 'QUEUE_FULL', 'This queue already contains 500 songs.');
      const at = placement === 'last' ? previous.tracks.length : previous.state === 'ready' ? 0 : previous.index + 1;
      previous.tracks.splice(at, 0, item);
      const cycleAt = placement === 'last' ? previous.cycleTracks.length : previous.state === 'ready' ? 0 : previous.cycleTracks.findIndex(track => track.id === previous.tracks[previous.index].id) + 1;
      previous.cycleTracks.splice(cycleAt, 0, item); ++this.mutation;
      this.update(previous, { total: previous.tracks.length });
      return { queue: this.status() };
    }
    if (this.playback.status()?.active) throw new AppError(409, 'QUEUE_WAIT_FOR_SONG', 'Wait until the current song request is checked before creating its queue.');
    const mutation = this.mutation, intent = this.playback.intent, playbackId = this.playback.status()?.id ?? null, generation = this.bridge.generation;
    let current = null, canRead = Boolean(deviceId);
    if (canRead) {
      try { this.bridge.requireDevice(deviceId); }
      catch (error) { if (['NOT_CONNECTED', 'DEVICE_OFFLINE'].includes(error.code)) canRead = false; else throw error; }
    }
    if (canRead) { try { current = (await this.bridge.freshPlayer(deviceId))?.player; } catch { current = null; } }
    if (this.current !== previous || this.mutation !== mutation || this.playback.intent !== intent
      || (this.playback.status()?.id ?? null) !== playbackId || this.bridge.generation !== generation) throw changed();
    const adopt = ['PLAYING', 'PAUSED'].includes(current?.state) && text(current.title) && text(current.artist)
      && providerIdentity(current.providerName) && Number.isFinite(current.durationMs) && current.durationMs > 0 && current.durationMs <= 86400000
      && Number.isFinite(current.positionMs) && current.positionMs >= 0 && current.positionMs <= current.durationMs;
    if (!adopt) {
      const job = this.createJob({ tracks: [item], title: 'Up next', provider, country, ...modes });
      if (current?.state === 'PLAYING' || current?.state === 'PAUSED') this.update(job, { message: 'Your Echo’s current audio could not be identified. Start will play your queued songs when you choose.' });
      return { queue: this.status() };
    }
    const adopted = snapshotTrack({ ...current, source: 'player', country }, country);
    adopted.adopted = true; adopted.adoptedProviderName = current.providerName.trim();
    const progress = { position: current.positionMs, duration: current.durationMs, mediaId: mediaIdentity(current.mediaId), actualProvider: providerIdentity(current.providerName), progressed: false, nearEnd: false, unknown: 0, stalled: 0 };
    const job = this.createJob({ tracks: [adopted, item], title: 'Up next', deviceId, provider, country, state: current.state === 'PAUSED' ? 'paused' : 'playing', matched: true, progress, ...modes });
    if (current.state === 'PLAYING') this.launch(job);
    return { queue: this.status() };
  }
  async customCommand(deviceId, command) {
    command = normalizeCustomCommand(command);
    this.bridge.requireDevice(deviceId);
    const snapshot = this.status(), job = this.current;
    if (!snapshot?.active || snapshot.state === 'ready' || job.deviceId !== deviceId) return this.playback.customCommand(deviceId, command);
    const resumable = job.matched && ['playing', 'paused'].includes(job.state)
      ? { track: job.tracks[job.index], state: job.state, mediaId: job.progress?.mediaId || null, provider: job.progress?.actualProvider || job.verifiedProvider || null }
      : null;
    // Retain every queue entry while cancelling only automatic song work.
    this.invalidate(job); job.abort = new AbortController();
    this.cancelOwned(job, 'Automatic playlist retries paused for your command.');
    this.captureIntent(job);
    const revision = job.revision;
    this.update(job, { state: 'needs_attention', matched: false, progress: null,
      message: 'Your command will play independently. Waiting to confirm its song before continuing this queue…' });
    // Finish an already-dispatched request before measuring the command baseline.
    await Promise.resolve(this.playback.queue).catch(() => {});
    if (!this.valid(job, revision)) throw changed();
    let baseline = null;
    try { baseline = (await this.bridge.freshPlayer(deviceId))?.player || null; } catch {}
    if (!this.valid(job, revision)) throw changed();
    const resume = resumable && ['PLAYING', 'PAUSED'].includes(baseline?.state) && playerKey(baseline)
      && comparePlayback(resumable.track, { ...baseline, state: 'PLAYING' }, { candidateArtists: [resumable.track.artist] }).verdict === 'match'
      && compareMusicProvider(this.providerFor(job), baseline.providerName).verdict === 'match'
      && (!resumable.mediaId || resumable.mediaId === mediaIdentity(baseline.mediaId))
      && (!resumable.provider || resumable.provider === providerIdentity(baseline.providerName))
      ? { trackId: resumable.track.id, state: resumable.state } : null;
    const pending = this.playback.customCommand(deviceId, command);
    // customCommand changes playback intent synchronously, before awaiting I/O.
    this.captureIntent(job);
    try {
      const response = await pending;
      if (!this.valid(job, revision)) throw changed();
      this.startManualRecovery(job, baseline, { allowFirst: true, resume, fromCommand: true });
      return { ...response, queue: this.status() };
    } catch (error) {
      if (this.valid(job, revision)) {
        this.startManualRecovery(job, baseline, { allowFirst: true, resume, fromCommand: true });
        this.update(job, { message: 'The command was not confirmed. Your upcoming songs are kept; waiting for identifiable new playback, or choose Next.' });
      }
      throw error;
    }
  }
  startManualRecovery(job, baseline, { allowFirst = false, resume = null, allowFailedPlayback = false, fromCommand = false } = {}) {
    const recovery = { revision: job.revision, baseline: playerKey(baseline), seeded: Boolean(playerKey(baseline)) || allowFirst,
      candidate: null, position: null, readings: 0, watching: true, resume, allowFailedPlayback, fromCommand, commandUntil: fromCommand ? this.clock() + 30000 : 0 };
    job.manualRecovery = recovery;
    job.manualTask = this.watchManualRecovery(job, recovery).catch(() => {});
  }
  async watchManualRecovery(job, recovery) {
    for (let count = 0; job.manualRecovery === recovery && this.valid(job, recovery.revision); count++) {
      const delay = count < this.adoptionAttempts ? this.adoptionPollMs : Math.max(15000, this.adoptionPollMs);
      await this.adoptionSleep(delay, job.abort.signal);
      if (job.manualRecovery !== recovery || !this.valid(job, recovery.revision)) return;
      let player = null;
      try { player = (await this.bridge.freshPlayer(job.deviceId))?.player || null; } catch {}
      if (job.manualRecovery !== recovery || !this.valid(job, recovery.revision)) return;
      this.observePlayer(job.deviceId, player);
    }
    if (job.manualRecovery === recovery) recovery.watching = false;
  }
  observeOutsidePlayback(deviceId, player) {
    const job = this.current;
    const ready = job?.state === 'ready' || job?.outsidePlayback?.previousState === 'ready';
    const inactiveTail = job && !job.active && job.index + 1 < job.tracks.length;
    if (!job || (!job.active && !inactiveTail) || (!inactiveTail && !ready && ((!job.matched && !job.outsidePlayback) || (!['playing', 'paused'].includes(job.state) && !job.outsidePlayback)))
      || (job.deviceId && job.deviceId !== deviceId) || job.seekBusy || this.playback.status()?.active || (!inactiveTail && !ready && !this.ownsIntent(job))) return null;
    if (inactiveTail && playerKey(player) === job.cancelledPlayback) { job.outsidePlayback = null; return null; }
    if (!adoptablePlayer(player)) { if (job.outsidePlayback) job.outsidePlayback.key = null; return null; }
    const track = job.tracks[job.index], progress = job.progress;
    const song = comparePlayback(track, player, { candidateArtists: [track.artist] });
    const service = compareMusicProvider(this.providerFor(job), player.providerName);
    const changedMedia = progress?.mediaId && mediaIdentity(player.mediaId) && progress.mediaId !== mediaIdentity(player.mediaId);
    if (!ready && song.verdict !== 'mismatch' && service.verdict !== 'mismatch' && !changedMedia) {
      if (job.active && job.outsidePlayback) this.update(job, { matched: true, state: job.outsidePlayback.previousState, message: 'The original queue recording is still playing.' });
      job.outsidePlayback = null; return null;
    }
    const key = playerKey(player), previous = job.outsidePlayback;
    if (previous?.key === key && player.positionMs > previous.position) {
      this.clear(job.id, { keepCurrent: false });
      return 'cleared';
    }
    job.outsidePlayback = { key, position: player.positionMs, previousState: previous?.previousState || job.state };
    if (job.active) this.update(job, { matched: false, state: 'needs_attention', message: 'Checking whether playback outside this queue has taken over…' });
    return 'pending';
  }
  observePlayer(deviceId, player) {
    const outside = this.observeOutsidePlayback(deviceId, player);
    if (outside) return outside === 'cleared';
    const job = this.current, recovery = job?.manualRecovery;
    if (!recovery || job.deviceId !== deviceId || job.state !== 'needs_attention' || !this.valid(job, recovery.revision)) return false;
    const identity = playerKey(player);
    if (!recovery.seeded) {
      if (identity) { recovery.baseline = identity; recovery.seeded = true; }
      return false;
    }
    const restoreCurrent = identity === recovery.baseline && recovery.resume?.trackId === job.tracks[job.index]?.id;
    const verifiedPaused = restoreCurrent && recovery.resume.state === 'paused' && player?.state === 'PAUSED' && adoptablePlayer({ ...player, state: 'PLAYING' });
    if ((!adoptablePlayer(player) && !verifiedPaused) || (identity === recovery.baseline && !restoreCurrent && !recovery.allowFailedPlayback)) {
      recovery.candidate = null; recovery.readings = 0; recovery.position = null; return false;
    }
    const same = identity === recovery.candidate;
    const advancing = same && player.positionMs > recovery.position;
    recovery.readings = same && player.positionMs >= recovery.position ? recovery.readings + 1 : 1;
    recovery.candidate = identity;
    recovery.position = player.positionMs;
    if (recovery.readings < 2 || (!advancing && !verifiedPaused)) return false;
    if (restoreCurrent) {
      const paused = player.state === 'PAUSED';
      this.update(job, { matched: true, playbackRequestId: null, verifiedProvider: providerIdentity(player.providerName),
        progress: { position: player.positionMs, duration: player.durationMs, mediaId: mediaIdentity(player.mediaId), actualProvider: providerIdentity(player.providerName), progressed: !paused, nearEnd: !paused && player.durationMs - player.positionMs <= 5000, unknown: 0, stalled: 0 },
        state: paused ? 'paused' : 'playing', message: paused ? 'Your current song is still paused. The remaining queue is kept.' : 'Your current song is still playing. Continuing the same queue.' });
      this.captureIntent(job);
      if (paused) this.invalidate(job); else this.launch(job);
      return true;
    }
    if ((!recovery.fromCommand || this.clock() > recovery.commandUntil) && identity !== recovery.baseline) {
      this.clear(job.id, { keepCurrent: false });
      return true;
    }
    const adopted = snapshotTrack({ ...player, source: 'player', country: job.country }, job.country);
    adopted.adopted = true; adopted.adoptedProviderName = player.providerName.trim();
    const prior = job.tracks[job.index], at = job.index + 1;
    if (identity === recovery.baseline && recovery.allowFailedPlayback) {
      // Occupy only this runtime slot. The canonical repeat cycle and saved
      // playlist retain the requested song, and every pending item keeps its ID.
      adopted.id = prior.id;
      adopted.requestedTrack = prior.requestedTrack || prior;
      adopted.fallbackWarning = `Warning: Could not play “${adopted.requestedTrack.title}”. Alexa is playing “${adopted.title}” by ${adopted.artist} instead. The queue will continue after this song.`;
      job.tracks[job.index] = adopted;
      ++this.mutation;
      this.update(job, { matched: true, playbackRequestId: null, verifiedProvider: providerIdentity(player.providerName),
        progress: { position: player.positionMs, duration: player.durationMs, mediaId: mediaIdentity(player.mediaId), actualProvider: providerIdentity(player.providerName), progressed: true, nearEnd: player.durationMs - player.positionMs <= 5000, unknown: 0, stalled: 0 },
        state: 'playing', message: adopted.fallbackWarning });
      this.captureIntent(job); this.launch(job);
      return true;
    }
    job.tracks.splice(at, 0, adopted);
    const cycleAt = job.cycleTracks.findIndex(track => track.id === prior.id);
    job.cycleTracks.splice(cycleAt < 0 ? job.cycleTracks.length : cycleAt + 1, 0, adopted);
    ++this.mutation;
    this.update(job, { index: at, total: job.tracks.length, matched: true, playbackRequestId: null,
      verifiedProvider: providerIdentity(player.providerName),
      progress: { position: player.positionMs, duration: player.durationMs, mediaId: mediaIdentity(player.mediaId), actualProvider: providerIdentity(player.providerName), progressed: true, nearEnd: player.durationMs - player.positionMs <= 5000, unknown: 0, stalled: 0 },
      state: 'playing', message: 'Your manually played song is now current. The remaining queue is unchanged.' });
    this.captureIntent(job);
    this.launch(job);
    return true;
  }
  getTrack(itemId, queueId = null) {
    const job = this.current;
    if (!job || (queueId !== null && queueId !== job.id)) throw new AppError(409, 'QUEUE_CHANGED', 'A newer queue replaced this selection.');
    const item = job.tracks.find(track => track.id === itemId);
    if (!item) throw new AppError(404, 'QUEUE_ITEM_NOT_FOUND', 'That song is no longer in this queue.');
    const { id, title, artist, requestArtist, requestArtists, album, releaseYear, artwork, url, durationMs, source } = item;
    return { id, title, artist, requestArtist, requestArtists: [...(requestArtists || [])], album: album || '', ...(normalizeReleaseYear(releaseYear) !== null ? { releaseYear } : {}), artwork: artwork || '', url: url || '', durationMs: durationMs || 0, source: source || 'youtube-music', country: job.country };
  }
  pendingItem(itemId, queueId) {
    const job = this.current;
    if (!job || queueId !== job.id) throw new AppError(409, 'QUEUE_CHANGED', 'A newer queue replaced this edit.');
    const at = job.tracks.findIndex(track => track.id === itemId);
    if (at < 0) throw new AppError(404, 'QUEUE_ITEM_NOT_FOUND', 'That song is no longer in this queue.');
    if (job.state !== 'ready' && at <= job.index) throw new AppError(409, 'QUEUE_ITEM_CURRENT', 'Only songs waiting in Up next can be edited.');
    return { job, at };
  }
  remove({ itemId, queueId } = {}) {
    const { job, at } = this.pendingItem(itemId, queueId);
    const [removed] = job.tracks.splice(at, 1); job.cycleTracks = job.cycleTracks.filter(track => track.id !== removed.id); ++this.mutation;
    this.update(job, { total: job.tracks.length });
    if (!job.total) this.finish(job, 'completed', 'The queue is empty.');
    return { queue: this.status() };
  }
  move({ itemId, beforeItemId, queueId } = {}) {
    const { job, at } = this.pendingItem(itemId, queueId);
    if (beforeItemId !== null) this.pendingItem(beforeItemId, queueId);
    if (beforeItemId === itemId) return { queue: this.status() };
    const [item] = job.tracks.splice(at, 1);
    const target = beforeItemId === null ? job.tracks.length : job.tracks.findIndex(track => track.id === beforeItemId);
    job.tracks.splice(target, 0, item);
    const baseAt = job.cycleTracks.findIndex(track => track.id === item.id);
    const [baseItem] = job.cycleTracks.splice(baseAt, 1);
    const baseTarget = beforeItemId === null ? job.cycleTracks.length : job.cycleTracks.findIndex(track => track.id === beforeItemId);
    job.cycleTracks.splice(baseTarget, 0, baseItem); ++this.mutation;
    this.update(job, {});
    return { queue: this.status() };
  }
  clear(queueId = null, { keepCurrent = true } = {}) {
    const job = this.current;
    if (queueId !== null && queueId !== job?.id) throw new AppError(409, 'QUEUE_CHANGED', 'A newer queue replaced this control.');
    const ready = job?.state === 'ready';
    this.cancel('Queue cleared. The current song may continue playing.');
    if (!keepCurrent) this.current = null;
    else if (job) { job.tracks = ready ? [] : job.tracks.slice(0, job.index + 1); job.cycleTracks = [...job.tracks]; this.update(job, { total: job.tracks.length }); }
    return { queue: this.status() };
  }
  captureIntent(job) {
    job.expectedPlaybackId = this.playback.status()?.id ?? null;
    job.expectedIntent = typeof this.playback.intent === 'number' ? this.playback.intent : null;
  }
  ownsIntent(job) {
    return (this.playback.status()?.id ?? null) === job.expectedPlaybackId
      && (job.expectedIntent === null || this.playback.intent === job.expectedIntent);
  }
  valid(job, revision) {
    if (this.current !== job || !job.active || job.revision !== revision) return false;
    if (!this.ownsIntent(job)) { this.finish(job, 'cancelled', 'Queue cancelled because another playback choice took over.'); return false; }
    return true;
  }
  update(job, changes) { Object.assign(job, changes, { updatedAt: Math.max(this.clock(), job.updatedAt + 1) }); }
  invalidate(job) {
    ++job.revision; job.abort?.abort(); job.manualRecovery = null; job.outsidePlayback = null;
    if (job.seekBusy) { job.matched = false; job.progress = null; }
    job.seekBusy = false;
  }
  finish(job, state, message) { this.invalidate(job); this.update(job, { state, active: false, message }); }
  cancelOwned(job, message) {
    if (job.playbackRequestId && this.ownsIntent(job) && this.playback.status()?.id === job.playbackRequestId) {
      this.playback.cancel(message, job.playbackRequestId);
      this.captureIntent(job);
    }
  }
  start({ playlist, deviceId, providerId = 'alexa-default', country, edits = [], startTrackId, requestMode = 'standard', shuffle = false, repeatAll = false } = {}) {
    const provider = resolveMusicProvider(providerId), modes = queueModes({ shuffle, repeatAll });
    requestMode = normalizeRequestMode(requestMode, provider.id);
    const tracks = prepare(playlist, edits, startTrackId, country).map(track => ({ ...track, country, source: 'youtube-music' }));
    if (!['music', 'default'].includes(provider.kind)) throw new AppError(400, 'INVALID_QUEUE_PROVIDER', 'Choose an on-demand music service for playlist songs.');
    if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose a catalogue country before starting the queue.');
    this.bridge.requireDevice(deviceId);
    // Nothing above this point can disturb the currently playing queue.
    this.cancel('Replaced by your newer playlist queue.');
    const job = this.createJob({ tracks, title: playlist.title.trim(), deviceId, provider, country, state: 'preparing', ...modes });
    job.requestMode = requestMode;
    this.launch(job);
    return { queue: this.status() };
  }
  launch(job) {
    this.invalidate(job);
    job.abort = new AbortController();
    const revision = job.revision;
    job.task = Promise.resolve().then(() => this.run(job, revision)).catch(() => {
      if (this.valid(job, revision)) this.update(job, { state: 'needs_attention', matched: false, progress: null, message: 'The next song could not be confirmed. Choose Next to continue or cancel the queue.' });
    });
  }
  cancel(message = 'Queue cancelled. The current song may continue playing.', requestId = null) {
    const job = this.current;
    if (requestId && requestId !== job?.id && requestId !== job?.playbackRequestId) return this.status();
    ++this.mutation;
    if (!job || !job.active) return this.status();
    job.cancelledPlayback = job.manualRecovery?.baseline || job.outsidePlayback?.key || null;
    this.cancelOwned(job, 'Automatic playlist requests cancelled.');
    this.finish(job, 'cancelled', text(message, 500) ? message : 'Queue cancelled. The current song may continue playing.');
    return this.status();
  }
  async seek(deviceId, positionMs, expected) {
    expected = validateSeekRequest(positionMs, expected);
    const snapshot = this.status(), job = this.current;
    if (!snapshot?.active || deviceId !== job.deviceId) throw new AppError(409, 'QUEUE_SEEK_CHANGED', 'The selected Echo is not playing this queue.');
    if (job.seekBusy) throw new AppError(409, 'SEEK_BUSY', 'Wait for the current position change to be checked.');
    if (!job.matched || !['playing', 'paused'].includes(job.state)) throw new AppError(409, 'QUEUE_SEEK_UNAVAILABLE', 'Wait until the Echo confirms the current queue song before seeking.');
    const track = job.tracks[job.index];
    const identity = comparePlayback(track, { ...expected, state: 'PLAYING' }, { candidateArtists: [track.artist] });
    const knownMedia = job.progress?.mediaId;
    const knownProvider = job.progress?.actualProvider || job.verifiedProvider;
    const knownDuration = job.progress?.duration;
    if (identity.verdict !== 'match' || (knownMedia && expected.mediaId && expected.mediaId !== knownMedia)
      || (knownProvider && expected.providerName && providerIdentity(expected.providerName) !== knownProvider)
      || (knownDuration && Math.abs(knownDuration - expected.durationMs) > 1000)
      || (expected.providerName && compareMusicProvider(this.providerFor(job), expected.providerName).verdict !== 'match')) {
      throw new AppError(409, 'QUEUE_SEEK_CHANGED', 'The reported song changed. Refresh playback before seeking.');
    }
    this.bridge.requireDevice(deviceId);
    const paused = job.state === 'paused';
    const guard = { track: { ...track, durationMs: expected.durationMs }, mediaId: knownMedia || mediaIdentity(expected.mediaId),
      provider: knownProvider || providerIdentity(expected.providerName), paused };
    // Retire end detection before the command or any readback can yield. Old reads cannot advance the queue.
    this.invalidate(job);
    job.abort = new AbortController();
    const revision = job.revision;
    job.seekBusy = true;
    this.update(job, { message: 'Changing the current song position. Waiting for the Echo to report it…' });
    let response;
    try {
      response = await this.playback.seek(deviceId, positionMs, { ...expected });
      if (!this.valid(job, revision)) throw changed();
      const targetPositionMs = response?.targetPositionMs ?? positionMs;
      if (!Number.isSafeInteger(targetPositionMs) || targetPositionMs < 0 || targetPositionMs >= expected.durationMs) throw new AppError(502, 'SEEK_UNVERIFIED', 'The Echo position request could not be checked.');
      const startedAt = this.clock();
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt) await this.sleep(Math.min(this.pollMs, 1000), job.abort.signal);
        if (!this.valid(job, revision)) throw changed();
        let player;
        try { player = (await this.bridge.freshPlayer(deviceId))?.player; }
        catch { throw new AppError(502, 'SEEK_UNVERIFIED', 'The Echo accepted the position request, but its new position could not be checked.'); }
        if (!this.valid(job, revision)) throw changed();
        const actualMedia = mediaIdentity(player?.mediaId), actualProvider = providerIdentity(player?.providerName);
        const song = comparePlayback(guard.track, ['PLAYING', 'PAUSED'].includes(player?.state) ? { ...player, state: 'PLAYING' } : player, { candidateArtists: [track.artist] });
        const provider = compareMusicProvider(this.providerFor(job), player?.providerName);
        if (song.verdict === 'mismatch' || provider.verdict === 'mismatch'
          || (guard.mediaId && actualMedia && guard.mediaId !== actualMedia)
          || (guard.provider && actualProvider && guard.provider !== actualProvider)) {
          throw new AppError(409, 'SEEK_PLAYBACK_CHANGED', 'Playback changed while the position request was being checked.');
        }
        let exactIdentity = false;
        try { validateSeekTarget(player, targetPositionMs, expected); exactIdentity = true; }
        catch (error) {
          if (error.code !== 'SEEK_UNAVAILABLE') throw new AppError(409, 'SEEK_PLAYBACK_CHANGED', 'Playback changed while the position request was being checked.');
        }
        const completeIdentity = song.verdict === 'match' && provider.verdict === 'match'
          && (!guard.mediaId || guard.mediaId === actualMedia) && actualProvider && (!guard.provider || guard.provider === actualProvider);
        const positionKnown = Number.isFinite(player?.positionMs) && player.positionMs >= 0 && player.positionMs <= expected.durationMs + 1000;
        // Playing audio advances while the fresh read is in flight; paused audio does not.
        const elapsedMs = player?.state === 'PLAYING' ? Math.max(0, this.clock() - startedAt) : 0;
        const expectedPositionMs = Math.min(expected.durationMs, targetPositionMs + elapsedMs);
        // A reported target resets all earlier end evidence; an accepted command alone cannot do so.
        if (exactIdentity && completeIdentity && positionKnown && Math.abs(player.positionMs - expectedPositionMs) <= 3000) {
          job.progress = { position: player.positionMs, duration: player.durationMs, mediaId: actualMedia || guard.mediaId,
            actualProvider, progressed: false, nearEnd: false, unknown: 0, stalled: 0 };
          job.verifiedProvider = actualProvider;
          job.seekBusy = false;
          const remainPaused = paused || player.state === 'PAUSED';
          this.update(job, { state: remainPaused ? 'paused' : 'playing', message: remainPaused ? 'Position confirmed. The playlist queue remains paused.' : 'Position confirmed. Watching the current song before playing the next one…' });
          if (!remainPaused) this.launch(job);
          return { ...response, seekVerified: true, reportedPositionMs: player.positionMs, queue: this.status() };
        }
        if (this.clock() - startedAt > 10000) break;
      }
      throw new AppError(502, 'SEEK_UNVERIFIED', 'The Echo has not confirmed the requested position. The queue is waiting for your next choice.');
    } catch (error) {
      if (!this.valid(job, revision)) throw changed();
      job.seekBusy = false;
      this.attention(job, 'The position change could not be confirmed. Choose Resume to request this song again, or Next to continue.');
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'SEEK_UNVERIFIED', 'The Echo position change could not be confirmed.');
    }
  }
  async control(action, options = {}) {
    if (!['pause', 'resume', 'next', 'previous', 'cancel', 'clear', 'start'].includes(action)) throw new AppError(400, 'INVALID_ACTION', 'Choose a supported queue control.');
    const contextId = options.queueId ?? options.requestId;
    if (contextId !== undefined && contextId !== this.current?.id) throw new AppError(409, 'QUEUE_CHANGED', 'A newer queue replaced this control.');
    if (action === 'clear') return { status: 'sent', message: 'Queue cleared. The current song may continue playing.', ...this.clear(contextId ?? null) };
    if (action === 'cancel') return { status: 'sent', message: 'Queue cancelled. The current song may continue playing.', queue: this.cancel() };
    const snapshot = this.status(), job = this.current;
    if (!snapshot?.active) throw new AppError(409, 'NO_ACTIVE_QUEUE', 'Start a playlist queue first.');
    if (action === 'start') {
      if (job.state !== 'ready' || !job.total) throw new AppError(409, 'QUEUE_NOT_READY', 'Choose Start on a queue waiting to play.');
      const provider = queueContext(options.providerId ?? job.providerId, options.country ?? job.country);
      if (provider.id !== job.providerId || (options.country ?? job.country) !== job.country) throw new AppError(409, 'QUEUE_CONTEXT_CHANGED', 'Start this queue with its selected country and streaming service.');
      this.bridge.requireDevice(options.deviceId);
      ++this.mutation; job.deviceId = options.deviceId; job.matched = false; job.progress = null;
      this.captureIntent(job); this.update(job, { state: 'preparing', message: 'Preparing the first queued song…' }); this.launch(job);
      return { status: 'sent', message: 'Starting your queued songs.', queue: this.status() };
    }
    if (job.state === 'ready') throw new AppError(409, 'QUEUE_NOT_STARTED', 'Choose Start when you want the queued songs to play.');
    if (action === 'next' || action === 'previous') {
      this.invalidate(job);
      this.cancelOwned(job, 'Replaced by your queue selection.');
      const index = action === 'next' ? job.index + 1 : Math.max(0, job.index - 1);
      if (index >= job.total && job.repeatAll && this.repeat(job)) this.launch(job);
      else if (index >= job.total) this.finish(job, 'completed', 'Playlist queue completed.');
      else {
        this.update(job, { index, state: 'preparing', message: 'Preparing your selected song…', matched: false, progress: null });
        this.launch(job);
      }
      return { status: 'sent', message: action === 'next' ? 'Moving to the next queue song.' : 'Moving to the previous queue song.', queue: this.status() };
    }
    if (action === 'resume' && ['playing', 'preparing'].includes(job.state)) return { status: 'sent', message: 'The playlist queue is already running.', queue: this.status() };
    if (action === 'resume' && job.state === 'paused' && job.matched) {
      // A paused queue does not poll; verify again before resuming possibly changed audio.
      const revision = job.revision;
      let player;
      try { player = (await this.bridge.freshPlayer(job.deviceId))?.player; } catch { player = null; }
      if (!this.valid(job, revision)) throw changed();
      const expectedProvider = job.progress?.actualProvider || job.verifiedProvider;
      const expectedMedia = job.progress?.mediaId;
      const sameSong = ['PLAYING', 'PAUSED'].includes(player?.state)
        && comparePlayback(job.tracks[job.index], { ...player, state: 'PLAYING' }, { candidateArtists: [job.tracks[job.index].artist] }).verdict === 'match';
      const sameProvider = expectedProvider && providerIdentity(player?.providerName) === expectedProvider
        && compareMusicProvider(this.providerFor(job), player?.providerName).verdict === 'match';
      if (!sameSong || !sameProvider || (expectedMedia && mediaIdentity(player?.mediaId) !== expectedMedia)) {
        this.attention(job, 'The paused recording changed or could not be identified. Requesting your selected queue song again.');
      }
    }
    if (action === 'resume' && (job.state !== 'paused' || !job.matched)) {
      this.invalidate(job);
      this.cancelOwned(job, 'Preparing the current queue song again.');
      this.update(job, { state: 'preparing', matched: false, progress: null, message: 'Requesting the selected current song again…' });
      this.launch(job);
      return { status: 'sent', message: 'Requesting the selected current song again.', queue: this.status() };
    }
    if (action === 'pause' && job.state === 'paused') return { status: 'sent', message: 'The playlist queue is paused.', queue: this.status() };
    this.invalidate(job);
    const revision = job.revision;
    this.update(job, { state: action === 'pause' ? 'paused' : 'preparing', message: action === 'pause' ? 'Playlist queue paused. Choose Resume to continue.' : 'Resuming the playlist queue…' });
    try {
      const pending = this.playback.control(job.deviceId, action);
      this.captureIntent(job);
      await pending;
      if (!this.valid(job, revision)) throw changed();
    } catch (error) {
      if (!this.valid(job, revision)) throw changed();
      this.update(job, { state: 'needs_attention', message: 'This queue control could not be confirmed. Try the control again or cancel the queue.' });
      throw new AppError(502, 'QUEUE_CONTROL_UNAVAILABLE', 'The Echo queue control could not be confirmed.');
    }
    if (action === 'resume') {
      this.update(job, { state: job.matched ? 'playing' : 'preparing', message: job.matched ? 'Watching the current song before playing the next one…' : 'Preparing the current song again…' });
      this.launch(job);
    }
    return { status: 'sent', message: action === 'pause' ? 'Playlist queue paused.' : 'Playlist queue resumed.', queue: this.status() };
  }
  async run(job, revision) {
    while (this.valid(job, revision)) {
      if (!job.matched && job.tracks[job.index]?.requestedTrack) job.tracks[job.index] = job.tracks[job.index].requestedTrack;
      const track = job.tracks[job.index];
      if (!job.matched) {
        if (track.adopted) { delete track.adopted; delete track.adoptedProviderName; job.verifiedProvider = null; }
        this.update(job, { state: 'preparing', message: `Checking song ${job.index + 1} of ${job.total}: ${track.title}…` });
        const reservation = this.playback.reserve({ deviceId: job.deviceId, country: job.country, providerId: job.providerId, requestMode: job.requestMode || 'standard', trackHint: track });
        job.playbackRequestId = reservation.id;
        this.captureIntent(job);
        this.playback.start(reservation, { ...track, requestArtists: [...track.requestArtists] });
        this.captureIntent(job);
        await reservation.task;
        if (!this.valid(job, revision)) return;
        const verification = this.playback.status();
        if (verification?.state !== 'matched') {
          this.update(job, { state: 'needs_attention', matched: false, progress: null,
            message: 'The Echo did not confirm this song. Use a typed command to correct it, choose Next, or play independently on Alexa.' });
          let baseline = reservation.lastPlayer || null;
          if (!baseline) { try { baseline = (await this.bridge.freshPlayer(job.deviceId))?.player || null; } catch {} }
          if (!this.valid(job, revision)) return;
          this.startManualRecovery(job, baseline, { allowFailedPlayback: verification?.state === 'unmatched' && (job.requestMode || 'standard') === 'standard' });
          return;
        }
        // Keep verified individual credits in this queue's private snapshot so
        // subsequent monitoring and resume use the same recording evidence.
        // Keep requestArtist intact: it is part of the learned preference identity.
        if (reservation.matchTrack) {
          track.requestArtists = [...(reservation.matchTrack.requestArtists || [])];
        }
        job.matched = true;
        job.verifiedProvider = providerIdentity(verification.reportedProviderName);
        job.progress = null;
      }
      this.update(job, { state: 'playing', message: `Playing song ${job.index + 1} of ${job.total}. Waiting for the Echo to report its end…` });
      const ended = await this.monitor(job, revision, track);
      if (!ended || !this.valid(job, revision)) return;
      if (job.index + 1 >= job.total) {
        if (job.repeatAll && this.repeat(job)) continue;
        this.finish(job, 'completed', 'Playlist queue completed.'); return;
      }
      this.update(job, { index: job.index + 1, matched: false, progress: null });
    }
  }
  attention(job, message) {
    const track = job.tracks[job.index];
    const baseline = track?.fallbackWarning ? { ...track, providerName: track.adoptedProviderName,
      mediaId: job.progress?.mediaId, durationMs: job.progress?.duration || track.durationMs, positionMs: job.progress?.position } : null;
    this.update(job, { state: 'needs_attention', matched: false, progress: null, message });
    if (baseline) this.startManualRecovery(job, baseline);
    return false;
  }
  async monitor(job, revision, track) {
    const progress = job.progress ||= { position: null, duration: null, mediaId: null, actualProvider: job.verifiedProvider || null, progressed: false, nearEnd: false, unknown: 0, stalled: 0 };
    while (this.valid(job, revision)) {
      const nearEndPolling = progress.position !== null && progress.duration - progress.position <= 7500;
      await this.sleep(nearEndPolling ? Math.min(this.pollMs, 1000) : this.pollMs, job.abort.signal);
      if (!this.valid(job, revision)) return false;
      let player;
      try { player = (await this.bridge.freshPlayer(job.deviceId))?.player; } catch { player = null; }
      if (!this.valid(job, revision)) return false;
      const outside = this.observeOutsidePlayback(job.deviceId, player);
      if (outside === 'cleared') return false;
      if (outside === 'pending') continue;
      const actualProvider = providerIdentity(player?.providerName);
      const actualMedia = mediaIdentity(player?.mediaId);
      const provider = compareMusicProvider(this.providerFor(job), player?.providerName);
      const song = comparePlayback(track, player?.state === 'PAUSED' || ['STOPPED', 'IDLE', 'FINISHED'].includes(player?.state)
        ? { ...player, state: 'PLAYING' } : player, { candidateArtists: [track.artist] });
      // A change of recording or service is a takeover, even during the final seconds.
      if (provider.verdict === 'mismatch' || (progress.actualProvider && actualProvider && progress.actualProvider !== actualProvider)) {
        return this.attention(job, 'The Echo changed streaming service. Choose Next to request the next song on your selected service.');
      }
      if (progress.mediaId && actualMedia && progress.mediaId !== actualMedia) {
        return this.attention(job, 'The Echo changed recordings. Choose Next to continue the queue.');
      }
      if (song.verdict === 'mismatch') return this.attention(job, 'The Echo changed songs. Choose Next to continue the queue.');
      if (player?.state === 'PAUSED') {
        const sameProvider = progress.actualProvider && actualProvider === progress.actualProvider;
        const sameMedia = !progress.mediaId || actualMedia === progress.mediaId;
        if (song.verdict !== 'match' || provider.verdict !== 'match' || !sameProvider || !sameMedia) {
          return this.attention(job, 'The paused recording could not be identified. Resume will request your selected queue song again.');
        }
        this.update(job, { state: 'paused', message: 'The Echo is paused. Choose Resume to continue the playlist queue.' });
        return false;
      }
      if (['STOPPED', 'IDLE', 'FINISHED'].includes(player?.state)) {
        if (progress.progressed && progress.nearEnd) return true;
        return this.attention(job, 'Playback stopped before a song end was confirmed. Choose Next or Resume to continue.');
      }
      const missingIdentity = (progress.actualProvider && !actualProvider) || (progress.mediaId && !actualMedia);
      if (provider.verdict !== 'match' || song.verdict !== 'match' || missingIdentity) {
        if (++progress.unknown >= 3) return this.attention(job, 'The Echo has not provided enough song information. Choose Next to continue the queue.');
        continue;
      }
      if (!progress.actualProvider && actualProvider) progress.actualProvider = actualProvider;
      const { durationMs, positionMs } = player;
      if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(positionMs) || positionMs < 0 || positionMs > durationMs + 5000) {
        if (++progress.unknown >= 3) return this.attention(job, 'The Echo has not provided song progress. Choose Next when you want to continue the queue.');
        continue;
      }
      progress.unknown = 0;
      if (progress.position !== null && positionMs + 5000 < progress.position) {
        return this.attention(job, 'Playback progress changed unexpectedly. Choose Next to continue the queue.');
      }
      if (progress.position !== null && positionMs > progress.position) { progress.progressed = true; progress.stalled = 0; }
      else if (progress.position !== null && ++progress.stalled >= 6) return this.attention(job, 'The Echo stopped reporting advancing song progress. Choose Next to continue the queue.');
      progress.position = positionMs;
      progress.duration = durationMs;
      if (actualMedia) progress.mediaId = actualMedia;
      const remaining = durationMs - positionMs;
      if (progress.progressed && remaining <= 5000) progress.nearEnd = true;
      if (progress.progressed && remaining <= 1000) return true;
    }
    return false;
  }
}
