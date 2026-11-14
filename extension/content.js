(() => {
  'use strict';
  if (globalThis.__echoLibraryContentV1 || !globalThis.EchoSources) return;
  globalThis.__echoLibraryContentV1 = true;
  const EVENT = 'echo-library:media-state-v1';
  const SETTLE_MS = 800;
  let metadata = {}, sourceControlBusy = false, currentRevision = 0, candidate = null, candidateKey = '', current = null, deliveredKey = '', settleTimer = null, readTimer = null, disconnected = false;
  const fingerprint = track => track ? JSON.stringify([track.source, track.title, track.artist, track.artistNames || [], track.featuredArtists || [], track.album, track.trackId, track.url, track.state, track.isAd, track.confidence, track.durationMs || null]) : 'null';
  const controlFingerprint = track => track ? JSON.stringify([track.source, track.title, track.artist, track.trackId || '', track.state, track.confidence, track.isAd === true]) : 'null';
  function snapshot() { try { return EchoSources.read(document, location, metadata); } catch (_) { return null; } }
  const nextRevision = () => { currentRevision = Math.min(Number.MAX_SAFE_INTEGER, currentRevision + 1); return currentRevision; };
  function send(track, revision = currentRevision) {
    if (disconnected) return;
    try { Promise.resolve(chrome.runtime.sendMessage({ type: 'TRACK_UPDATE', track, revision })).catch(() => {}); }
    catch (_) { disconnected = true; }
  }
  function commit() {
    settleTimer = null;
    const latest = snapshot(), latestKey = fingerprint(latest);
    if (latestKey !== candidateKey) { inspect(); return; }
    current = latest;
    // Progress updates let the worker distinguish an intentional repeat of the same recording.
    const progressKey = latest && Number.isFinite(latest.positionMs) ? Math.floor(latest.positionMs / 1000) : null;
    const nextKey = latestKey + ':' + progressKey;
    if (nextKey !== deliveredKey) { deliveredKey = nextKey; send(current, nextRevision()); }
  }
  function inspect() {
    readTimer = null;
    const latest = snapshot(), nextKey = fingerprint(latest);
    if (nextKey !== candidateKey) {
      candidate = latest; candidateKey = nextKey;
      clearTimeout(settleTimer); settleTimer = setTimeout(commit, SETTLE_MS);
    } else if (!settleTimer) commit();
  }
  function schedule() { if (!readTimer) readTimer = setTimeout(inspect, 100); }
  document.addEventListener(EVENT, event => {
    if (typeof event.detail !== 'string' || event.detail.length > 2048) return;
    try {
      const value = JSON.parse(event.detail);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      metadata = EchoSources.mediaInfo(value); schedule();
    } catch (_) {}
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === 'GET_TRACK') { respond({ track: current, revision: currentRevision }); return false; }
    if (message?.type !== 'CONTROL_SOURCE') return false;
    if (sender?.id !== chrome.runtime.id || sender.tab || !globalThis.EchoSourceControls) { respond({ ok: false, message: 'Use the extension’s playback controls.' }); return false; }
    if (sourceControlBusy) { respond({ ok: false, message: 'Wait for the current browser playback action to finish.' }); return false; }
    sourceControlBusy = true;
    EchoSourceControls.run(message.action, { read: snapshot, control: (action, state) => EchoSources.control(document, location, action, state), hold: message.hold === true, expectedTrack: message.expectedTrack })
      .then(result => {
        if (!result.ok || !result.track) { respond(result); return; }
        const latest = snapshot(), resultKey = controlFingerprint(result.track);
        if (controlFingerprint(latest) !== resultKey) {
          respond({ ok: false, message: 'The music website changed again before that action finished. Refresh its song details.' }); return;
        }
        current = latest;
        const revision = nextRevision();
        schedule(); respond({ ...result, track: current, revision });
      })
      .catch(() => respond({ ok: false, message: 'The browser playback action could not be completed.' }))
      .finally(() => { sourceControlBusy = false; });
    return true;
  });
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'href', 'is-ad', 'class', 'title'] });
  document.addEventListener('play', schedule, true);
  document.addEventListener('pause', schedule, true);
  document.addEventListener('visibilitychange', schedule);
  setInterval(schedule, 1200);
  // Publish a stable null too, so a navigation never keeps a previous song eligible for follow.
  candidateKey = '__initial__'; inspect();
})();
