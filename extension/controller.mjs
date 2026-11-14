import { HELPER, sourceForUrl, normalizeTrack, cleanText, canFollow, followDecision, safeSettings, trackKey } from './protocol.mjs';
const observationRevision = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const activeHandoff = value => value?.active === true && ['holding', 'requesting', 'waiting', 'resuming'].includes(value.phase);
const sourceIdentity = track => track ? [track.source, cleanText(track.title).normalize('NFKC').toLocaleLowerCase(), cleanText(track.artist).normalize('NFKC').toLocaleLowerCase(), track.trackId || ''].join('\u001f') : '';
const sameKnownRecording = (actual, expected) => {
  const idPattern = { 'youtube-music': /^[\w-]{11}$/u, spotify: /^[a-zA-Z0-9]{22}$/u, 'apple-music': /^\d{1,24}$/u }[expected?.source];
  return !!actual && !!expected && !!idPattern?.test(expected.trackId || '') && actual.source === expected.source && actual.trackId === expected.trackId && cleanText(actual.title).normalize('NFKC').toLocaleLowerCase() === cleanText(expected.title).normalize('NFKC').toLocaleLowerCase();
};
const matchesSourceTrack = (actual, expected) => {
  if (!actual || !expected) return false;
  if (cleanText(expected.artist)) return sourceIdentity(actual) === sourceIdentity(expected);
  return sameKnownRecording(actual, expected);
};
const emptyFollow = () => ({ enabled: false, tabId: null, source: null, lastKey: null, lastPositionMs: null, lastSourceState: null, sourceTitle: '', echoPausedBySource: false });
export class CompanionController {
  constructor(api, { fetchImpl = globalThis.fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), handoffPollMs = 1000, handoffTimeoutMs = 240000 } = {}) {
    this.api = api; this.fetch = fetchImpl.bind(globalThis); this.now = now; this.token = ''; this.settings = safeSettings(); this.follow = emptyFollow(); this.snapshots = new Map(); this.readerStatuses = new Map(); this.lastResult = null; this.generation = 0; this.ownAutoJob = null; this.sourceAction = null; this.handoff = null; this.handoffTask = Promise.resolve(); this.lastPlayback = null; this.sleep = sleep; this.handoffPollMs = handoffPollMs; this.handoffTimeoutMs = handoffTimeoutMs;
    this.ready = this.initialize();
  }
  async initialize() {
    await this.api.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    const [local, session] = await Promise.all([this.api.storage.local.get(['pairToken', 'settings']), this.api.storage.session.get(['follow', 'lastResult', 'ownAutoJob', 'handoff', 'lastPlayback'])]);
    this.token = typeof local.pairToken === 'string' ? local.pairToken : ''; this.settings = safeSettings(local.settings);
    if (session.follow && Number.isInteger(session.follow.tabId)) this.follow = { ...emptyFollow(), ...session.follow };
    this.lastResult = session.lastResult || null; this.ownAutoJob = typeof session.ownAutoJob === 'string' ? session.ownAutoJob : null;
    this.lastPlayback = session.lastPlayback || null; this.handoff = session.handoff || null;
    if (activeHandoff(this.handoff)) {
      this.handoff.generation = this.generation;
      if (this.handoff.jobId) { const restored = this.handoff; Promise.resolve().then(() => { this.handoffTask = this.watchHandoff(restored).catch(error => this.failHandoff(restored, error)); }); }
      else { this.handoff.active = false; this.handoff.phase = 'failed'; this.handoff.message = 'The extension restarted during the handoff. The tab stays paused; use Play on Echo to retry.'; await this.persist(); }
    }
  }
  async persist() { await this.api.storage.session.set({ follow: this.follow, lastResult: this.lastResult, ownAutoJob: this.ownAutoJob, handoff: this.handoff, lastPlayback: this.lastPlayback }); }
  async request(path, body, token = this.token) {
    if (!token) throw new Error('Pair the extension with the local helper first.');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ['/api/control', '/api/command'].includes(path) ? 26000 : 10000);
    try {
      const response = await this.fetch(HELPER + path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal, headers: { Authorization: 'Bearer ' + token, 'X-Echo-Extension': this.api.runtime.id, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(cleanText(data.message, 500) || 'The local helper could not complete this request.');
      return data;
    } catch (error) {
      if (error?.name === 'AbortError' || error instanceof TypeError) throw new Error(['/api/control', '/api/command'].includes(path) ? 'The playback control could not be confirmed. Alexa may still have received it; check your Echo before trying again.' : 'The browser could not reach Echo Companion. Open the helper and allow its local connection if prompted, then retry.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async activeTab() { const [tab] = await this.api.tabs.query({ active: true, currentWindow: true }); return tab || null; }
  async controlTab() {
    if (this.follow.enabled && Number.isInteger(this.follow.tabId)) {
      try { const tab = await this.api.tabs.get(this.follow.tabId); return sourceForUrl(tab?.url) === this.follow.source ? tab : null; }
      catch { return null; }
    }
    const tab = await this.activeTab(); return sourceForUrl(tab?.url) ? tab : null;
  }
  async capture(tab) {
    if (!tab || !Number.isInteger(tab.id) || !sourceForUrl(tab.url)) return null;
    try {
      const response = await this.api.tabs.sendMessage(tab.id, { type: 'GET_TRACK' });
      if (!response || typeof response !== 'object' || !Object.hasOwn(response, 'track')) throw new Error('Reader unavailable');
      this.readerStatuses.set(tab.id, { state: 'ready', message: '' });
      const track = normalizeTrack(response.track, tab.url); this.snapshots.set(tab.id, { track, revision: observationRevision(response.revision), at: this.now() }); return track;
    } catch {
      this.readerStatuses.set(tab.id, { state: 'unavailable', message: 'Reload this music webpage after updating Echo Companion to reconnect song detection.' });
      this.snapshots.delete(tab.id); return null;
    }
  }
  trustedPopup(sender) { return sender?.id === this.api.runtime.id && sender.url === this.api.runtime.getURL('popup.html') && !sender.tab; }
  trustedSource(sender) { return sender?.id === this.api.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && !!sourceForUrl(sender.url) && sourceForUrl(sender.url) === sourceForUrl(sender.tab?.url); }
  currentHandoff(handoff) { return this.handoff === handoff && activeHandoff(handoff) && handoff.generation === this.generation; }
  async cancelHandoff(message = 'Handoff cancelled. The browser stays paused.', { invalidate = true } = {}) {
    const handoff = this.handoff;
    if (!activeHandoff(handoff)) return;
    if (invalidate) ++this.generation;
    Object.assign(handoff, { active: false, phase: 'cancelled', message, updatedAt: this.now() });
    await this.persist();
    if (handoff.jobId && this.token) await this.request('/api/cancel', { requestId: handoff.jobId }).catch(() => {});
  }
  async stopFollowing({ cancel = true } = {}) {
    const generation = ++this.generation, job = this.ownAutoJob;
    this.follow = emptyFollow(); this.ownAutoJob = null;
    const handoffJob = activeHandoff(this.handoff) ? this.handoff.jobId : null;
    await this.cancelHandoff('Following stopped. The browser stays paused.', { invalidate: false });
    await this.persist();
    if (cancel && job && job !== handoffJob && this.token) await this.request('/api/cancel', { requestId: job }).catch(() => {});
    return generation;
  }
  async sourceCommand(tab, action, expectedTrack, extra = {}, stillCurrent = () => true) {
    const current = await this.api.tabs.get(tab.id);
    if (!stillCurrent()) throw new Error('A newer choice cancelled this browser control.');
    if (sourceForUrl(current?.url) !== sourceForUrl(tab.url)) throw new Error('The music tab changed. No playback action was sent to the new page.');
    const result = await this.api.tabs.sendMessage(tab.id, { type: 'CONTROL_SOURCE', action, ...(expectedTrack ? { expectedTrack } : {}), ...extra });
    if (result?.ok !== true) throw new Error(cleanText(result?.message, 500) || 'The browser player could not complete this action. Refresh the music tab and retry.');
    return { ...result, track: normalizeTrack(result.track, current.url) };
  }
  async startHandoff(track, sourceTrack, tab, { auto = false, generation = this.generation, settings = { ...this.settings } } = {}) {
    if (!track?.title || !track.artist || track.isAd) throw new Error('Review the song title and artist before sending it.');
    if (!settings.deviceId) throw new Error('Choose your Echo speaker first.');
    if (generation !== this.generation || (auto && !this.follow.enabled)) return { ok: false, message: 'A newer choice replaced this song.' };
    await this.cancelHandoff('Replaced by your newer song selection.', { invalidate: false });
    if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this song.' };
    const handoff = { id: crypto.randomUUID(), requestId: crypto.randomUUID(), generation, active: true, phase: 'holding', message: 'Holding the muted browser while your Echo starts…', trackTitle: track.title, track, sourceTrack, tabId: tab.id, tabUrl: tab.url, settings, auto, jobId: null, createdAt: this.now(), updatedAt: this.now() };
    this.handoff = handoff;
    if (this.follow.enabled && this.follow.tabId === tab.id) {
      this.follow.lastKey = trackKey(sourceTrack); this.follow.lastPositionMs = sourceTrack.positionMs ?? null;
      this.follow.sourceTitle = sourceTrack.title; this.follow.lastSourceState = 'playing'; this.follow.echoPausedBySource = false; this.follow.pendingHandoffTitle = null;
    }
    await this.persist();
    this.handoffTask = this.runHandoff(handoff).catch(error => this.failHandoff(handoff, error));
    return { ok: true, message: handoff.message, handoff: { ...handoff } };
  }
  async runHandoff(handoff) {
    if (!this.currentHandoff(handoff)) return;
    const tab = await this.api.tabs.get(handoff.tabId);
    if (!this.currentHandoff(handoff)) return;
    if (sourceForUrl(tab?.url) !== handoff.sourceTrack.source) throw new Error('The music tab changed before the handoff.');
    await this.api.tabs.update(tab.id, { muted: true });
    if (!this.currentHandoff(handoff)) return;
    const held = await this.sourceCommand(tab, 'pause', handoff.sourceTrack, {}, () => this.currentHandoff(handoff));
    if (!this.currentHandoff(handoff)) return;
    if (!held.track || held.track.state !== 'paused' || !matchesSourceTrack(held.track, handoff.sourceTrack)) throw new Error('The selected browser song could not be held.');
    const requestMatchesSource = handoff.track.title === handoff.sourceTrack.title && handoff.track.artist === handoff.sourceTrack.artist;
    handoff.sourceTrack = held.track;
    if (requestMatchesSource && held.track.durationMs > 0) handoff.track.durationMs = held.track.durationMs;
    Object.assign(handoff, { phase: 'requesting', message: 'Starting the selected song on your Echo…', updatedAt: this.now() }); await this.persist();
    if (!this.currentHandoff(handoff)) return;
    const result = await this.request('/api/play', { track: handoff.track, ...handoff.settings, requestId: handoff.requestId });
    const jobId = result.job?.id;
    if (!this.currentHandoff(handoff)) { if (jobId) await this.request('/api/cancel', { requestId: jobId }).catch(() => {}); return; }
    if (result.ok === false || typeof jobId !== 'string') throw new Error(result.message || 'The Echo did not accept this song request.');
    handoff.jobId = jobId; if (handoff.auto) this.ownAutoJob = jobId;
    Object.assign(handoff, { phase: 'waiting', message: 'Waiting for the correct song on Echo. The tab stays paused…', updatedAt: this.now() });
    this.lastResult = { ok: true, message: handoff.message, job: result.job, updatedAt: this.now() }; await this.persist();
    await this.watchHandoff(handoff);
  }
  async watchHandoff(handoff) {
    while (this.currentHandoff(handoff)) {
      if (this.now() - handoff.createdAt > this.handoffTimeoutMs) throw new Error('Echo playback was not confirmed in time. The tab stays paused; use Play on Echo to retry.');
      const result = await this.request('/api/jobs/' + encodeURIComponent(handoff.jobId));
      if (!this.currentHandoff(handoff)) return;
      const job = result.job;
      if (!job || job.id !== handoff.jobId || job.deviceId && job.deviceId !== handoff.settings.deviceId || result.isCurrent !== true) throw new Error('A newer Echo choice replaced this handoff. The tab stays paused.');
      if (job.state === 'matched') {
        Object.assign(handoff, { phase: 'resuming', message: 'Echo is playing the selected song. Starting the muted tab…', updatedAt: this.now() }); await this.persist();
        if (!this.currentHandoff(handoff)) return;
        const tab = await this.api.tabs.get(handoff.tabId);
        if (!this.currentHandoff(handoff)) return;
        const resumed = await this.sourceCommand(tab, 'play', handoff.sourceTrack, {}, () => this.currentHandoff(handoff));
        if (!this.currentHandoff(handoff)) return;
        if (!resumed.track || resumed.track.state !== 'playing' || !matchesSourceTrack(resumed.track, handoff.sourceTrack)) throw new Error('Echo started, but the browser could not resume the selected song.');
        this.lastPlayback = { tabId: tab.id, sourceKey: sourceIdentity(resumed.track), settings: handoff.settings };
        if (this.follow.enabled && this.follow.tabId === tab.id) { this.follow.lastKey = trackKey(resumed.track); this.follow.sourceTitle = resumed.track.title; this.follow.lastPositionMs = resumed.track.positionMs ?? null; this.follow.lastSourceState = 'playing'; this.follow.echoPausedBySource = false; }
        Object.assign(handoff, { active: false, phase: 'completed', message: 'Echo started first. The muted tab is now playing.', updatedAt: this.now() });
        this.lastResult = { ok: true, message: handoff.message, updatedAt: this.now() }; await this.persist(); return;
      }
      if (['error', 'unmatched', 'unverified', 'cancelled'].includes(job.state)) throw new Error((job.message || 'The selected song could not be confirmed on Echo.') + ' The tab stays paused.');
      handoff.message = cleanText(job.message, 500) || 'Waiting for the correct song on Echo. The tab stays paused…'; handoff.updatedAt = this.now(); await this.persist();
      await this.sleep(this.handoffPollMs);
    }
  }
  async failHandoff(handoff, error) {
    if (!this.currentHandoff(handoff)) return;
    const message = cleanText(error?.message, 500) || 'The Echo handoff could not finish. The tab stays paused.';
    Object.assign(handoff, { active: false, phase: 'failed', message, updatedAt: this.now() });
    this.lastResult = { ok: false, message, updatedAt: this.now() }; await this.persist();
    if (handoff.jobId && this.token) await this.request('/api/cancel', { requestId: handoff.jobId }).catch(() => {});
  }
  async echoControl(action, extra = {}, generation = this.generation) {
    if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this control.' };
    const result = await this.request('/api/control', { deviceId: this.settings.deviceId, action, ...extra });
    if (generation === this.generation) {
      this.lastResult = { ok: result.ok !== false, message: result.message || 'Playback control sent to your Echo.', updatedAt: this.now() };
      await this.persist();
    }
    return { ok: result.ok !== false, ...result };
  }
  async trackUpdate(message, sender) {
    if (!this.trustedSource(sender)) return { ok: false, message: 'Unsupported source.' };
    this.readerStatuses.set(sender.tab.id, { state: 'ready', message: '' });
    const track = normalizeTrack(message.track, sender.url); this.snapshots.set(sender.tab.id, { track, revision: observationRevision(message.revision), at: this.now() });
    if (this.sourceAction?.tabId === sender.tab.id || !track) return { ok: true };
    if (activeHandoff(this.handoff) && this.handoff.tabId === sender.tab.id) {
      const uncertainSameRecording = !track.isAd && !cleanText(track.artist) && track.confidence === 'review' && sameKnownRecording(track, this.handoff.sourceTrack);
      // A momentary credit gap on the same known recording is not a new song.
      // Native Play still requires its separate, strict source-control guard.
      if (uncertainSameRecording || matchesSourceTrack(track, this.handoff.sourceTrack)) return { ok: true };
      const cancellationGeneration = this.generation + 1;
      if (this.follow.enabled && this.follow.tabId === sender.tab.id) this.follow.pendingHandoffTitle = track.title;
      await this.cancelHandoff('Replaced by the newer browser song.');
      if (cancellationGeneration !== this.generation) return { ok: true };
    }
    if (!this.follow.enabled || this.follow.tabId !== sender.tab.id) return { ok: true };
    if (!track.isAd && track.title) {
      const titleIdentity = value => cleanText(value).normalize('NFKC').toLocaleLowerCase();
      const changed = this.follow.sourceTitle && titleIdentity(this.follow.sourceTitle) !== titleIdentity(track.title);
      this.follow.sourceTitle = track.title;
      if (changed) {
        // A new selection must stop old artist retries even while its details settle.
        const generation = ++this.generation, previousJob = this.ownAutoJob; this.ownAutoJob = null;
        await this.persist();
        if (previousJob && this.token) await this.request('/api/cancel', { requestId: previousJob }).catch(() => {});
        if (generation !== this.generation) return { ok: true };
      }
    }
    const decision = followDecision(this.follow, track);
    if (this.follow.pendingHandoffTitle === track.title && canFollow(track) && track.state === 'paused') { decision.send = true; decision.key = trackKey(track); }
    const pause = !decision.send && track.state === 'paused' && this.follow.lastSourceState === 'playing';
    if (!pause && !canFollow(track)) return { ok: true };
    const resume = track.state === 'playing' && this.follow.echoPausedBySource && !decision.send;
    if (pause || resume) {
      const generation = ++this.generation;
      this.follow.lastSourceState = track.state; this.follow.echoPausedBySource = pause;
      if (pause) this.ownAutoJob = null;
      await this.persist();
      try { return { ...await this.echoControl(pause ? 'pause' : 'resume', {}, generation), synced: true }; }
      catch (error) {
        if (generation === this.generation) { this.lastResult = { ok: false, message: error.message, updatedAt: this.now() }; await this.persist(); }
        return { ok: false, message: error.message };
      }
    }
    if (decision.send) {
      const generation = ++this.generation;
      this.follow.lastKey = decision.key; this.follow.lastPositionMs = track.positionMs ?? null;
      this.follow.lastSourceState = 'playing'; this.follow.echoPausedBySource = false; await this.persist();
      try { return { ...await this.startHandoff(track, track, sender.tab, { auto: true, generation }), synced: true }; }
      catch (error) { if (generation === this.generation) { await this.stopFollowing({ cancel: false }); this.lastResult = { ok: false, message: error.message, updatedAt: this.now() }; await this.persist(); } return { ok: false, message: error.message }; }
    }
    if (track.state === 'playing') this.follow.lastSourceState = 'playing';
    if (Number.isFinite(track.positionMs) && !track.isAd && decision.key) this.follow.lastPositionMs = track.positionMs;
    await this.persist();
    return { ok: true };
  }
  async playbackControl(message) {
    const action = message.action === 'resume' ? 'play' : message.action;
    if (!['play', 'pause', 'next', 'seek', 'volume'].includes(action)) throw new Error('Choose a supported playback control.');
    if (!this.settings.deviceId) throw new Error('Choose your Echo speaker first.');
    const extra = {};
    if (action === 'volume') {
      if (!Number.isInteger(message.volume) || message.volume < 0 || message.volume > 100) throw new Error('Choose a volume between 0 and 100%.');
      extra.volume = message.volume;
    }
    if (action === 'seek') {
      if (activeHandoff(this.handoff)) throw new Error('Wait for the song to start on Echo, or cancel the handoff before seeking.');
      if (!Number.isInteger(message.positionMs) || message.positionMs < 0 || message.positionMs > 86_400_000) throw new Error('Choose a valid position in the current song.');
      extra.positionMs = message.positionMs;
      if (message.expectedTrack) {
        const title = cleanText(message.expectedTrack.title), artist = cleanText(message.expectedTrack.artist);
        if (!title || !artist) throw new Error('Refresh the current Echo song before seeking.');
        extra.expectedTrack = { title, artist };
      }
    }
    if (action === 'volume' || action === 'seek') {
      const generation = this.generation;
      try { return await this.echoControl(action, extra, generation); }
      catch (error) { if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this control.' }; throw error; }
    }
    if (this.sourceAction) throw new Error('Wait for the browser player to finish the previous change.');
    const generation = ++this.generation, settings = { ...this.settings };
    await this.cancelHandoff('Replaced by your playback control.', { invalidate: false });
    const operation = { generation, tabId: this.follow.enabled ? this.follow.tabId : null, action }; this.sourceAction = operation;
    try {
      const tab = await this.controlTab();
      if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this control.' };
      if (!tab && action === 'next') throw new Error('Open a supported music tab or enable Follow this tab before using Next.');
      if (!tab) return await this.echoControl(action === 'play' ? 'resume' : 'pause', {}, generation);
      operation.tabId = tab.id;
      let track = await this.capture(tab);
      if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this control.' };
      if (!track) throw new Error('Choose a song in the browser and refresh its details.');
      if (action === 'next') {
        await this.request('/api/cancel', {});
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this control.' };
        const result = await this.sourceCommand(tab, 'next', undefined, { hold: true }, () => generation === this.generation);
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this control.' };
        const latest = this.snapshots.get(tab.id), newer = latest && latest.revision > observationRevision(result.revision);
        track = newer ? latest.track : result.track;
        if (!canFollow(track) || !['playing', 'paused'].includes(track.state)) throw new Error('The new browser song could not be confirmed. No old song was sent to Echo.');
        this.sourceAction = null;
        return await this.startHandoff(track, track, tab, { auto: this.follow.enabled && this.follow.tabId === tab.id, generation, settings });
      }
      if (action === 'pause') {
        await this.sourceCommand(tab, 'pause', track, {}, () => generation === this.generation);
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this control.' };
        if (this.follow.enabled && this.follow.tabId === tab.id) { this.follow.lastSourceState = 'paused'; this.follow.echoPausedBySource = true; this.follow.pendingHandoffTitle = null; }
        await this.persist(); return await this.echoControl('pause', {}, generation);
      }
      const samePlayedSong = this.lastPlayback?.tabId === tab.id && this.lastPlayback.sourceKey === sourceIdentity(track) && JSON.stringify(this.lastPlayback.settings) === JSON.stringify(settings);
      if (samePlayedSong) {
        await this.api.tabs.update(tab.id, { muted: true });
        const echoed = await this.echoControl('resume', {}, generation);
        if (echoed.ok === false || generation !== this.generation) return echoed;
        await this.sourceCommand(tab, 'play', track, {}, () => generation === this.generation);
        if (this.follow.enabled && this.follow.tabId === tab.id) { this.follow.lastSourceState = 'playing'; this.follow.echoPausedBySource = false; await this.persist(); }
        return echoed;
      }
      this.sourceAction = null;
      return await this.startHandoff(track, track, tab, { auto: this.follow.enabled && this.follow.tabId === tab.id, generation, settings });
    } catch (error) {
      if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this control.' };
      throw error;
    } finally { if (this.sourceAction === operation) this.sourceAction = null; }
  }
  async popupState() {
    const tab = await this.activeTab(); const supported = !!sourceForUrl(tab?.url); const track = supported ? await this.capture(tab) : null;
    let helper = { connected: false, devices: [], providers: [] }, error = '';
    if (this.token) try {
      const [statusResult, commandsResult] = await Promise.allSettled([
        this.request('/api/status' + (this.settings.deviceId ? '?deviceId=' + encodeURIComponent(this.settings.deviceId) : '')),
        this.request('/api/commands')
      ]);
      if (statusResult.status !== 'fulfilled') throw statusResult.reason;
      helper = statusResult.value; helper.commands = commandsResult.status === 'fulfilled' && Array.isArray(commandsResult.value.commands) ? commandsResult.value.commands : [];
      if (!this.settings.deviceId && helper.devices?.length) { this.settings.deviceId = helper.devices[0].id; await this.api.storage.local.set({ settings: this.settings }); }
    } catch (failure) { error = failure.message; }
    const controlTab = await this.controlTab();
    if (controlTab && controlTab.id !== tab?.id) await this.capture(controlTab);
    const sourceStatus = supported ? this.readerStatuses.get(tab.id) || { state: 'unavailable', message: 'Reload this music webpage to reconnect song detection.' } : { state: 'unsupported', message: 'Open Apple Music, Spotify or YouTube Music in this tab.' };
    const controlSourceStatus = controlTab ? this.readerStatuses.get(controlTab.id) || { state: 'unavailable' } : { state: 'unsupported' };
    return { ok: true, tabId: tab?.id ?? null, controlTabId: controlTab?.id ?? null, sourceStatus, controlSourceStatus, sourceControlsAvailable: !!controlTab && controlSourceStatus.state === 'ready', handoff: this.handoff, supported, track, paired: !!this.token, helper, settings: this.settings, follow: this.follow, lastResult: this.lastResult, error };
  }
  async handle(message, sender) {
    await this.ready;
    if (!message || typeof message.type !== 'string') return { ok: false, message: 'Unknown request.' };
    if (message.type === 'TRACK_UPDATE') return this.trackUpdate(message, sender);
    if (!this.trustedPopup(sender)) return { ok: false, message: 'Use the extension popup.' };
    let actionGeneration = null;
    try {
      if (message.type === 'GET_POPUP_STATE' || message.type === 'REFRESH_TRACK') return await this.popupState();
      if (message.type === 'RELOAD_SOURCE') {
        const tab = await this.activeTab();
        if (!tab || !sourceForUrl(tab.url)) throw new Error('Open the music webpage before reconnecting song detection.');
        await this.api.tabs.reload(tab.id);
        this.snapshots.delete(tab.id);
        this.readerStatuses.set(tab.id, { state: 'unavailable', message: 'Reloading the music webpage. Waiting for song detection…' });
        return { ok: true, message: 'Music webpage reloaded. Song detection will reconnect when it finishes loading.' };
      }
      if (message.type === 'OPEN_HELPER' || message.type === 'OPEN_AMAZON_SETUP') { await this.api.tabs.create({ url: HELPER + (message.type === 'OPEN_AMAZON_SETUP' ? '/#amazon-connection' : '') }); return { ok: true }; }
      if (message.type === 'SET_PAIR_TOKEN') {
        const token = cleanText(message.token, 150);
        const generation = actionGeneration = await this.stopFollowing();
        if (!/^[A-Za-z0-9_-]{32,150}$/.test(token)) throw new Error('Paste the pairing code shown by the local helper.');
        await this.request('/api/status', undefined, token);
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced pairing.' };
        this.token = token; await this.api.storage.local.set({ pairToken: token });
        this.lastResult = { ok: true, message: 'Paired with Echo Companion.' }; await this.persist(); return { ok: true, message: this.lastResult.message };
      }
      if (message.type === 'SAVE_SETTINGS') {
        const next = safeSettings(message.settings);
        if (JSON.stringify(next) !== JSON.stringify(this.settings)) { const generation = actionGeneration = await this.stopFollowing(); if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced these settings.' }; }
        this.settings = next; await this.api.storage.local.set({ settings: next }); return { ok: true };
      }
      if (message.type === 'PLAY_TRACK') {
        if (this.sourceAction) throw new Error('Wait for the browser player to finish the previous change.');
        const tab = await this.activeTab();
        const keepFollowing = this.follow.enabled && this.follow.tabId === tab?.id && this.follow.source === sourceForUrl(tab?.url);
        const generation = actionGeneration = keepFollowing ? ++this.generation : await this.stopFollowing();
        const settings = { ...this.settings };
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this song.' };
        const detected = await this.capture(tab);
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this song.' };
        if (!detected) throw new Error('Start a song in Apple Music, Spotify or YouTube Music, then refresh the tab.');
        const title = cleanText(message.track?.title), artist = cleanText(message.track?.artist);
        const sameIdentity = title === detected.title && artist === detected.artist;
        const metadata = { ...detected, title, artist, confidence: 'review' };
        // Structured credits and recording measurements belong to the detected song.
        // Editing the request must not reuse those credits for a different identity.
        if (!sameIdentity) for (const key of ['artistNames', 'featuredArtists', 'trackId', 'durationMs', 'positionMs']) delete metadata[key];
        const track = normalizeTrack(metadata, tab.url);
        return await this.startHandoff(track, detected, tab, { auto: keepFollowing, generation, settings });
      }
      if (message.type === 'SET_FOLLOW') {
        const generation = actionGeneration = await this.stopFollowing();
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced following.' };
        const settings = { ...this.settings };
        if (message.enabled !== true) return { ok: true, message: 'Following stopped. Pending song checks are cancelled.' };
        const tab = await this.activeTab(), track = await this.capture(tab);
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced following.' };
        if (!tab || !sourceForUrl(tab.url)) throw new Error('Open Apple Music, Spotify or YouTube Music before enabling Follow this tab.');
        const helper = await this.request('/api/status');
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced following.' };
        if (!helper.connected || !helper.devices?.some(device => device.id === settings.deviceId)) throw new Error('Connect Amazon in Echo Companion and choose your Echo first.');
        await this.api.tabs.update(tab.id, { muted: true });
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced following.' };
        this.follow = { ...emptyFollow(), enabled: true, tabId: tab.id, source: sourceForUrl(tab.url), sourceTitle: track?.title || '', lastSourceState: track?.state ?? null }; await this.persist();
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced following.' };
        if (canFollow(track) && track.state === 'playing') return await this.trackUpdate({ track }, { id: this.api.runtime.id, frameId: 0, url: tab.url, tab });
        const followMessage = this.readerStatuses.get(tab.id)?.state === 'unavailable' ? 'Following enabled. Reload this music webpage to reconnect song detection.' : track?.isAd ? 'Following enabled. Waiting for a song after the advertisement.' : !canFollow(track) ? 'Following enabled. Waiting for reliable song details.' : 'Following this tab. Play a song to send it to your Echo.';
        return { ok: true, message: followMessage };
      }
      if (message.type === 'CUSTOM_COMMAND') {
        const text = cleanText(message.text, 500), deviceId = this.settings.deviceId;
        if (!text) throw new Error('Enter a single-line Alexa command of 1 to 500 characters.');
        if (!deviceId) throw new Error('Choose your Echo speaker first.');
        const generation = actionGeneration = await this.stopFollowing();
        if (generation !== this.generation) return { ok: false, message: 'A newer choice replaced this command.' };
        const result = await this.request('/api/command', { deviceId, text, requestId: crypto.randomUUID() });
        if (generation === this.generation) { this.lastResult = { ok: result.ok !== false, message: result.message || 'Command sent to Alexa.', commandId: result.commandId, updatedAt: this.now() }; await this.persist(); }
        return { ok: result.ok !== false, ...result };
      }
      if (message.type === 'CONTROL') return await this.playbackControl(message);
      throw new Error('Unknown request.');
    } catch (error) {
      if (actionGeneration !== null && actionGeneration !== this.generation) return { ok: false, message: 'A newer choice replaced this request.' };
      this.lastResult = { ok: false, message: cleanText(error.message, 500) || 'This request could not be completed.', updatedAt: this.now() }; await this.persist();
      return { ok: false, message: this.lastResult.message };
    }
  }
  async tabRemoved(tabId) { await this.ready; this.snapshots.delete(tabId); this.readerStatuses.delete(tabId); if (this.follow.tabId === tabId || activeHandoff(this.handoff) && this.handoff.tabId === tabId) await this.stopFollowing(); }
  async tabUpdated(tabId, changes) { await this.ready; if (!changes.url) return; const source = sourceForUrl(changes.url); if (this.follow.tabId === tabId && source !== this.follow.source || activeHandoff(this.handoff) && this.handoff.tabId === tabId && source !== this.handoff.sourceTrack.source) await this.stopFollowing(); }
  async startup() { await this.ready; await this.stopFollowing({ cancel: false }); }
}
