import { randomUUID } from 'node:crypto';
import { AppError, COUNTRIES } from './catalog.mjs';
import { comparePlayback, getMusicRequestCandidates, isTitleTrackAlbumPlayback } from './music-matching.mjs';
import { resolveMusicProvider, compareMusicProvider } from './music-providers.mjs';
import { normalizeCustomCommand } from './command-journal.mjs';
import { validateSeekRequest } from './seek.mjs';
import { normalizeReleaseYear } from './track-release.mjs';

const reportedProvider = player => typeof player?.providerName === 'string' && player.providerName.trim() && player.providerName.length <= 250 && !/[\u0000-\u001f\u007f]/u.test(player.providerName) ? player.providerName.replace(/\s+/gu, ' ').trim() : null;
const fingerprint = player => {
  if (!player || player.state !== 'PLAYING' || !player.title || !player.artist) return null;
  const provider = reportedProvider(player)?.toLowerCase() || null;
  if (player.mediaId) return JSON.stringify(['media', player.mediaId, provider]);
  return JSON.stringify([player.title.trim().toLowerCase(), player.artist.trim().toLowerCase(), player.durationMs || null, provider]);
};

export function normalizeRequestMode(requestMode = 'standard', providerId = 'alexa-default') {
  if (!['standard', 'music-request-test'].includes(requestMode)) throw new AppError(400, 'INVALID_REQUEST_MODE', 'Choose the standard song request or the music request test.');
  if (requestMode === 'music-request-test' && resolveMusicProvider(providerId).kind !== 'music') throw new AppError(400, 'MUSIC_REQUEST_PROVIDER_REQUIRED', 'Choose a specific on-demand music service before testing music requests.');
  return requestMode;
}

const superseded = () => new AppError(409, 'PLAYBACK_CHANGED', 'A newer playback choice replaced this request.');
const wait = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener('abort', finish, { once: true });
});

export class PlaybackCoordinator {
  constructor({ bridge, artistPreferences = null, artistResolver = null, releaseYearResolver = null, clock = Date.now, sleep = wait, pollMs = 2500, graceMs = 9000, attemptMs = 18000, commandGapMs = 1250 } = {}) {
    if (!bridge) throw new Error('bridge required');
    this.bridge = bridge;
    this.artistPreferences = artistPreferences;
    this.artistResolver = artistResolver;
    this.releaseYearResolver = releaseYearResolver;
    this.clock = clock;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.graceMs = graceMs;
    this.attemptMs = attemptMs;
    this.commandGapMs = commandGapMs;
    this.current = null;
    this.intent = 0;
    this.queue = Promise.resolve();
    this.lastSendFinished = -Infinity;
    this.lastCreatedAt = 0;
  }
  status() {
    if (!this.current) return null;
    const { id, state, active, deviceId, country, title, artist, requestArtist, providerId, providerName, reportedProviderName, requestMode, attempt, maxAttempts, message, createdAt, updatedAt } = this.current;
    return { id, state, active, deviceId, country, title, artist, requestArtist, providerId, providerName, reportedProviderName, requestMode, attempt, maxAttempts, message, createdAt, updatedAt };
  }
  isCurrent(job) { return this.current === job && job.intent === this.intent && !job.abort.signal.aborted && job.active; }
  update(job, changes) {
    if (!this.isCurrent(job)) return false;
    Object.assign(job, changes, { updatedAt: Math.max(this.clock(), job.updatedAt + 1) });
    return true;
  }
  finish(job, state, message) { this.update(job, { state, message, active: false }); }
  cancel(message = 'Song checking and further attempts cancelled.', requestId = null) {
    const job = this.current;
    if (requestId && job?.id !== requestId) return this.status();
    ++this.intent;
    if (job?.active) {
      job.abort.abort();
      Object.assign(job, { state: 'cancelled', active: false, message, updatedAt: Math.max(this.clock(), job.updatedAt + 1) });
    }
    return this.status();
  }
  reserve({ deviceId, country, trackHint, providerId = 'alexa-default', requestMode = 'standard' }) {
    const provider = resolveMusicProvider(providerId);
    requestMode = normalizeRequestMode(requestMode, provider.id);
    if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose the catalogue country before playing.');
    this.bridge.requireDevice(deviceId);
    this.cancel('Replaced by your newer song selection.');
    const createdAt = this.lastCreatedAt = Math.max(this.clock(), this.lastCreatedAt + 1);
    this.current = {
      id: randomUUID(), intent: this.intent, abort: new AbortController(), active: true, state: 'preparing', deviceId, country,
      title: trackHint?.title || '', artist: trackHint?.artist || '', requestArtist: '', providerId: provider.id, providerName: provider.name, reportedProviderName: null, requestMode, attempt: 0, maxAttempts: 0,
      message: 'Preparing your song…', createdAt, updatedAt: createdAt,
    };
    return this.current;
  }
  failReservation(job) { this.finish(job, 'error', 'The song could not be prepared. Search again and try another result.'); }
  start(job, track) {
    if (!this.isCurrent(job)) throw superseded();
    const preferred = this.artistPreferences?.apply(track, job.country)?.requestArtist;
    const candidates = getMusicRequestCandidates(track, { preferredArtist: preferred });
    if (!candidates.length) {
      this.failReservation(job);
      throw new AppError(400, 'INVALID_TRACK', 'Choose a song with a title and artist.');
    }
    job.track = { ...track };
    job.matchTrack = { ...track };
    job.preferredArtist = preferred;
    job.candidates = candidates;
    this.update(job, { title: track.title, artist: track.artist, maxAttempts: candidates.length, message: 'Request received. Checking what your Echo plays…' });
    job.task = Promise.resolve().then(() => this.run(job)).catch(() => {
      this.finish(job, 'unverified', 'The Echo request could not be confirmed. Further attempts stopped.');
    });
    return { status: 'sent', requestId: job.id, playback: this.status(), message: job.message };
  }
  enqueue(valid, operation) {
    const pending = this.queue.then(async () => {
      if (!valid()) return null;
      const delay = this.commandGapMs - (this.clock() - this.lastSendFinished);
      if (delay > 0) await this.sleep(delay);
      if (!valid()) return null;
      try { return await operation(); } finally { this.lastSendFinished = this.clock(); }
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  async control(deviceId, action) {
    this.bridge.requireDevice(deviceId);
    if (!['pause', 'resume', 'next', 'previous'].includes(action)) throw new AppError(400, 'INVALID_ACTION', 'Choose a supported playback control.');
    this.cancel('Song checking cancelled by your playback control.');
    const intent = this.intent;
    const response = await this.enqueue(() => this.intent === intent, () => this.bridge.control(deviceId, action));
    if (!response) throw superseded();
    return response;
  }
  async setVolume(deviceId, volume) {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new AppError(400, 'INVALID_VOLUME', 'Choose a volume between 0 and 100%.');
    this.bridge.requireDevice(deviceId);
    const generation = this.bridge.generation;
    // Share command spacing with song requests without replacing their playback intent.
    const response = await this.enqueue(() => this.bridge.generation === generation, () => this.bridge.setVolume(deviceId, volume));
    if (!response) throw new AppError(409, 'CONNECTION_CHANGED', 'The Echo connection changed. Please try again.');
    return response;
  }
  async seek(deviceId, positionMs, expected) {
    const target = validateSeekRequest(positionMs, expected);
    this.bridge.requireDevice(deviceId);
    const generation = this.bridge.generation, intent = this.intent;
    const valid = () => this.bridge.generation === generation && this.intent === intent;
    const response = await this.enqueue(valid, () => this.bridge.seek(deviceId, positionMs, target, { isCurrent: valid }));
    if (this.bridge.generation !== generation) throw new AppError(409, 'CONNECTION_CHANGED', 'The Echo connection changed. Please try again.');
    if (!response || !valid()) throw superseded();
    return response;
  }
  async nativePlaylist(deviceId, playlist) {
    this.bridge.requireDevice(deviceId);
    if (resolveMusicProvider(playlist?.source).kind !== 'music') throw new AppError(400, 'INVALID_PLAYLIST_SOURCE', 'Choose an on-demand music service for this playlist.');
    const title = normalizeCustomCommand(playlist.title);
    if (title.length > 250) throw new AppError(400, 'INVALID_PLAYLIST', 'This playlist name is too long to request.');
    this.cancel('Individual song retries replaced by your playlist.');
    const intent = this.intent;
    const response = await this.enqueue(() => this.intent === intent, () => this.bridge.playPlaylist(playlist, deviceId));
    if (!response) throw superseded();
    return response;
  }
  async customCommand(deviceId, text) {
    text = normalizeCustomCommand(text);
    this.bridge.requireDevice(deviceId);
    this.cancel('Automatic song retries cancelled by your command.');
    const intent = this.intent;
    const response = await this.enqueue(() => this.intent === intent, () => this.bridge.sendTextCommand(text, deviceId));
    if (!response) throw superseded();
    return response;
  }
  async observe(job) {
    try {
      const result = await this.bridge.freshPlayer(job.deviceId);
      if (!this.isCurrent(job)) return null;
      const player = result?.player || null;
      job.lastPlayer = player ? { ...player } : null;
      this.update(job, { reportedProviderName: reportedProvider(player) });
      return player;
    } catch { return null; }
  }
  compare(job, player) {
    const song = comparePlayback(job.matchTrack || job.track, player, { candidateArtists: job.candidates.map(candidate => candidate.requestArtist) });
    const provider = compareMusicProvider(job.providerId, reportedProvider(player));
    // Explicit selections cannot be confirmed, or retried blindly, without service evidence.
    if (provider.verdict !== 'match') return provider;
    return song;
  }
  async run(job) {
    if (this.artistResolver) {
      this.update(job, { state: 'preparing', message: 'Checking the song’s artist credits…' });
      try {
        const enriched = await this.artistResolver.resolve(job.track, job.country, { signal: job.abort.signal });
        if (!this.isCurrent(job)) return;
        const candidates = getMusicRequestCandidates(enriched, { preferredArtist: job.preferredArtist });
        if (candidates.length) {
          job.candidates = candidates;
          job.matchTrack = { ...enriched, requestArtists: [...(enriched.requestArtists || [])] };
          this.update(job, { maxAttempts: candidates.length });
        }
      } catch { /* Optional credit lookup never prevents the original request. */ }
    }
    if (!this.isCurrent(job)) return;
    const baseline = await this.observe(job);
    if (!this.isCurrent(job)) return;
    const alreadyMatched = this.compare(job, baseline).verdict === 'match';
    const baselineIdentity = fingerprint(baseline);
    let titleTrackCorrectionUsed = false, yearRequestUsed = false, releaseYearLookupAttempted = false;
    let releaseYear = normalizeReleaseYear(job.matchTrack?.releaseYear) ?? normalizeReleaseYear(job.track?.releaseYear);
    for (let index = 0; index < job.candidates.length; index++) {
      if (!this.isCurrent(job)) return;
      const candidate = job.candidates[index];
      this.update(job, { state: index ? 'retrying' : 'sending', attempt: index + 1, requestArtist: candidate.requestArtist,
        message: index ? `Trying ${candidate.requestArtist} (${index + 1}/${job.candidates.length})…` : `Asking Alexa for ${job.title} by ${candidate.requestArtist}…` });
      try {
        await this.enqueue(() => this.isCurrent(job), () => this.bridge.play(candidate, job.deviceId, job.providerId, { requestMode: job.requestMode, valid: () => this.isCurrent(job) }));
      } catch (error) {
        const safeTestReason = job.requestMode === 'music-request-test' && error instanceof AppError && typeof error.message === 'string'
          && error.message.trim() && error.message.length <= 500 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(error.message) ? error.message.trim() : null;
        this.finish(job, 'unverified', safeTestReason
          ? `${safeTestReason} The app did not retry using the current method.`
          : 'Alexa did not confirm the request. Further attempts stopped to avoid sending it twice.');
        return;
      }
      if (!this.isCurrent(job)) return;
      this.update(job, { state: 'checking', message: `Checking what your Echo plays (${index + 1}/${job.candidates.length})…` });
      let startedAt = this.clock(), correctedAttempt = false;
      let albumReadings = 0, albumFingerprint = null, restartReadings = 0;
      let matches = 0, mismatches = 0, latestVerdict = 'unknown';
      let matchFingerprint = null, wrongFingerprint = null, wrongFingerprintCount = 0, stableWrongFingerprint = null;
      let observedPlaying = false;
      while (this.isCurrent(job) && this.clock() - startedAt < this.attemptMs) {
        await this.sleep(this.pollMs, job.abort.signal);
        if (!this.isCurrent(job)) return;
        const player = await this.observe(job);
        if (!this.isCurrent(job)) return;
        const remainedPaused = player?.state === 'PAUSED' && baseline?.state === 'PAUSED' && !observedPlaying
          && (baseline.mediaId && player.mediaId ? baseline.mediaId === player.mediaId : baseline.title === player.title && baseline.artist === player.artist);
        const result = remainedPaused && compareMusicProvider(job.providerId, reportedProvider(player)).verdict === 'match' ? { verdict: 'mismatch', reason: 'The Echo remains paused on its previous recording.' } : this.compare(job, player);
        latestVerdict = result.verdict;
        const identity = fingerprint(player);
        matches = result.verdict === 'match' ? (identity === matchFingerprint ? matches + 1 : 1) : 0;
        matchFingerprint = result.verdict === 'match' ? identity : null;
        mismatches = result.verdict === 'mismatch' ? mismatches + 1 : 0;
        if (result.verdict === 'mismatch' && identity) {
          wrongFingerprintCount = identity === wrongFingerprint ? wrongFingerprintCount + 1 : 1;
          wrongFingerprint = identity;
          if (wrongFingerprintCount >= 2) {
            if (stableWrongFingerprint && identity !== stableWrongFingerprint) {
              this.finish(job, 'cancelled', 'Playback changed to another song. Further attempts stopped.');
              return;
            }
            stableWrongFingerprint = identity;
          }
        } else { wrongFingerprint = null; wrongFingerprintCount = 0; }
        if (matches >= 2) {
          // Neither old matching metadata nor corrected request wording proves this artist alias worked.
          if (!alreadyMatched && !correctedAttempt && this.isCurrent(job)) {
            try { this.artistPreferences?.set(job.track, job.country, candidate.requestArtist); } catch { /* Playback still succeeded if the local preference cannot be saved. */ }
          }
          this.finish(job, 'matched', job.reportedProviderName ? `Your Echo reports the selected song playing on ${job.reportedProviderName}.` : 'Your Echo reports the selected song playing.');
          return;
        }
        const elapsed = this.clock() - startedAt;
        const titleTrackAlbum = result.verdict === 'mismatch' && identity && identity !== baselineIdentity
          && reportedProvider(player) && compareMusicProvider(job.providerId, reportedProvider(player)).verdict === 'match'
          && isTitleTrackAlbumPlayback(job.matchTrack || job.track, player, { candidateArtists: job.candidates.map(item => item.requestArtist) });
        albumReadings = titleTrackAlbum ? (identity === albumFingerprint ? albumReadings + 1 : 1) : 0;
        albumFingerprint = titleTrackAlbum ? identity : null;
        const clarifyTitleTrack = !titleTrackCorrectionUsed && job.requestMode === 'standard' && elapsed >= this.graceMs && albumReadings >= 2
          && typeof this.bridge.sendTextCommand === 'function';
        // Replaying an already-wrong edition may keep its media ID. A clear
        // position reset supplies new-request evidence without accepting stale metadata.
        const restartedSinceBaseline = identity && identity === baselineIdentity
          && Number.isFinite(baseline?.positionMs) && Number.isFinite(player?.positionMs) && player.positionMs >= 0
          && baseline.positionMs - player.positionMs >= 5000 && player.positionMs <= elapsed + 5000;
        restartReadings = restartedSinceBaseline ? restartReadings + 1 : 0;
        const yearBackupEligible = !yearRequestUsed && job.requestMode === 'standard' && elapsed >= this.graceMs
          && result.verdict === 'mismatch' && mismatches >= 2 && wrongFingerprintCount >= 2 && identity
          && (identity !== baselineIdentity || restartReadings >= 2)
          && player?.state === 'PLAYING' && reportedProvider(player)
          && compareMusicProvider(job.providerId, reportedProvider(player)).verdict === 'match';
        if (!clarifyTitleTrack && yearBackupEligible && releaseYear === null && !releaseYearLookupAttempted && this.releaseYearResolver) {
          releaseYearLookupAttempted = true;
          const lookupStarted = this.clock();
          this.update(job, { state: 'checking', message: 'Checking the selected song’s release year for a backup request…' });
          try { releaseYear = normalizeReleaseYear(await this.releaseYearResolver.resolve(job.matchTrack || job.track, job.country, { signal: job.abort.signal })); }
          catch { /* Missing or ambiguous release metadata leaves normal artist retries available. */ }
          if (!this.isCurrent(job)) return;
          startedAt += Math.max(0, this.clock() - lookupStarted);
          // A metadata lookup can outlast a manual skip or a late successful
          // request. Recheck before a year backup or an artist retry.
          const fresh = await this.observe(job);
          if (!this.isCurrent(job)) return;
          const freshResult = this.compare(job, fresh), freshIdentity = fingerprint(fresh);
          if (freshResult.verdict === 'match') {
            matches = 1; matchFingerprint = freshIdentity; latestVerdict = 'match'; mismatches = 0;
            wrongFingerprint = null; wrongFingerprintCount = 0; stableWrongFingerprint = null;
            albumReadings = 0; albumFingerprint = null; restartReadings = 0;
            continue;
          }
          if (freshIdentity !== identity || freshResult.verdict !== 'mismatch'
            || !reportedProvider(fresh) || compareMusicProvider(job.providerId, reportedProvider(fresh)).verdict !== 'match') {
            this.finish(job, freshResult.verdict === 'unknown' ? 'unverified' : 'cancelled', 'Playback changed or could not be verified while checking the release year. Further attempts stopped.');
            return;
          }
        }
        const addReleaseYear = yearBackupEligible && releaseYear !== null;
        if (clarifyTitleTrack || addReleaseYear) {
          if (clarifyTitleTrack) titleTrackCorrectionUsed = true; else yearRequestUsed = true;
          this.update(job, { state: 'retrying', message: clarifyTitleTrack
            ? 'Alexa appears to be playing the album. Asking for just the title track…'
            : `The recording did not match. Trying ${job.title} with its release year, ${releaseYear}…` });
          try {
            await this.enqueue(() => this.isCurrent(job), () => clarifyTitleTrack
              ? this.bridge.sendTextCommand('No, just play the title track', job.deviceId, { kind: 'music' })
              : this.bridge.play({ ...candidate, requestYear: releaseYear }, job.deviceId, job.providerId, { requestMode: job.requestMode, valid: () => this.isCurrent(job) }));
          } catch {
            this.finish(job, 'unverified', clarifyTitleTrack
              ? 'Alexa did not confirm the title-track correction. Further attempts stopped to avoid sending it twice.'
              : 'Alexa did not confirm the release-year backup. Further attempts stopped to avoid sending it twice.');
            return;
          }
          if (!this.isCurrent(job)) return;
          correctedAttempt = true;
          this.update(job, { state: 'checking', message: clarifyTitleTrack ? 'Checking the title track on your Echo…' : 'Checking the requested recording on your Echo…' });
          // These requests intentionally change the recording. Start a fresh
          // confirmation window instead of treating their result as a manual skip.
          startedAt = this.clock(); matches = 0; mismatches = 0; latestVerdict = 'unknown';
          matchFingerprint = null; wrongFingerprint = null; wrongFingerprintCount = 0; stableWrongFingerprint = null;
          albumReadings = 0; albumFingerprint = null; restartReadings = 0; observedPlaying = false;
          continue;
        }
        if (elapsed >= this.graceMs && player?.state === 'STOPPED' && observedPlaying) {
          this.finish(job, 'cancelled', 'Playback stopped. Further attempts stopped.');
          return;
        }
        if (player?.state === 'PLAYING') observedPlaying = true;
        if (elapsed >= this.graceMs && player?.state === 'PAUSED' && !remainedPaused) {
          this.finish(job, 'cancelled', 'Playback is paused. Further attempts stopped.');
          return;
        }
        if (elapsed >= this.graceMs && mismatches >= 2) break;
      }
      if (!this.isCurrent(job)) return;
      if (latestVerdict !== 'mismatch' || mismatches < 2) {
        this.finish(job, 'unverified', 'The Echo has not provided enough information to confirm this song. Further attempts stopped.');
        return;
      }
    }
    this.finish(job, 'unmatched', job.providerId === 'alexa-default' ? 'Your Echo did not report the selected song after the available artist attempts.' : `Your Echo did not report the selected song on ${job.providerName} after the available artist attempts.`);
  }
}
