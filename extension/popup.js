(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const fallbackProviders = [
    { id: 'apple-music', name: 'Apple Music' }, { id: 'amazon-music', name: 'Amazon Music' },
    { id: 'spotify', name: 'Spotify' }, { id: 'jiosaavn', name: 'JioSaavn' }, { id: 'alexa-default', name: 'Alexa default' }
  ];
  const sourceNames = { 'apple-music': 'Apple Music', spotify: 'Spotify', 'youtube-music': 'YouTube Music' };
  let state = { supported: false, paired: false, track: null, helper: {}, settings: { providerId: 'apple-music', country: 'IN' }, follow: {} };
  let busy = '', closed = false, pollBusy = false, initialized = false, dirtyTrack = false, cancelFollowBusy = false, lastCustomSubmission = null;
  let shownTrackKey = '', lastResultKey = '', lastStateError = '', messageTimer, pollTimer, revision = 0;
  const optionFingerprints = new Map();
  const rangeEdits = { seek: { active: false, dirty: false, keyboard: false, identity: '' }, volume: { active: false, dirty: false, keyboard: false, identity: '' } };
  const rangeKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  const clean = (value, max = 250) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  function featuredNames(track) {
    const seen = new Set();
    return (Array.isArray(track?.featuredArtists) ? track.featuredArtists.slice(0, 12) : []).map(name => clean(name)).filter(name => {
      if (!name) return false;
      const key = name.normalize('NFKC').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function displayArtist(track) {
    const artist = clean(track?.artist), guests = featuredNames(track);
    return artist && guests.length ? artist + ' (feat. ' + guests.join(', ') + ')' : artist;
  }
  function renderFeaturedCredit() {
    const guests = featuredNames(state.track);
    const originalIdentity = $('song-title').value.trim() === clean(state.track?.title) && $('song-artist').value.trim() === clean(state.track?.artist);
    $('song-featured-credit').hidden = !guests.length || state.track?.isAd === true || !originalIdentity;
    $('song-featured-credit').textContent = guests.length ? 'Featuring ' + guests.join(', ') : '';
  }
  const trackKey = track => track ? [track.source, track.trackId || '', track.title || '', track.artist || ''].join('\u001f') : '';
  const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 250 && !/[\u0000-\u001f\u007f]/.test(value);
  const helperReady = () => state.paired && state.helper?.connected === true;
  const currentFollow = () => state.follow?.enabled === true && state.follow.tabId === state.tabId;
  const hasTrack = () => state.supported && !!state.track && state.track.isAd !== true;
  const canPlay = () => !busy && helperReady() && hasTrack() && !!$('device-select').value && validText($('song-title').value) && validText($('song-artist').value);
  const canFollow = () => !busy && helperReady() && state.supported === true && !!$('device-select').value;
  const sourceUnavailable = () => state.supported === true && state.sourceStatus?.state === 'unavailable';
  const sourceControlsReady = () => state.sourceControlsAvailable === true && !(sourceUnavailable() && (!Number.isInteger(state.controlTabId) || state.controlTabId === state.tabId));

  const handoffPhases = new Set(['holding', 'requesting', 'waiting', 'resuming']);
  const handoffActive = () => !!state.handoff && handoffPhases.has(state.handoff.phase) && state.handoff.active !== false;
  const commandValid = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 500 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
  const canSendCommand = () => !busy && !cancelFollowBusy && helperReady() && !!$('device-select').value && commandValid($('custom-command-input').value);
  const timestamp = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

  function renderHandoff() {
    const handoff = state.handoff, known = handoff && (handoffPhases.has(handoff.phase) || handoff.phase === 'failed');
    $('handoff-status').hidden = !known;
    $('cancel-handoff-button').hidden = !handoffActive();
    if (!known) return;
    const headings = { holding: 'Preparing this song', requesting: 'Requesting on your Echo', waiting: 'Waiting for your Echo', resuming: 'Starting the browser player', failed: 'Song handoff needs attention' };
    const messages = { holding: 'The browser is paused while this song is prepared.', requesting: 'Requesting this song on your Echo before browser playback continues.', waiting: 'The browser stays paused until your Echo confirms the selected song.', resuming: 'Your Echo confirmed the song. Resuming the muted browser tab.', failed: 'Review the song request before continuing browser playback.' };
    $('handoff-heading').textContent = headings[handoff.phase];
    $('handoff-message').textContent = clean(handoff.message, 600) || messages[handoff.phase];
    $('handoff-song').textContent = clean(handoff.trackTitle || handoff.track?.title);
    $('handoff-song').hidden = !$('handoff-song').textContent;
    $('handoff-status').dataset.phase = handoff.phase;
  }

  function displayedCommand() {
    const helper = state.helper || {}, deviceId = $('device-select').value;
    const commands = Array.isArray(helper.commands) ? helper.commands : Array.isArray(helper.commands?.commands) ? helper.commands.commands : [];
    const entries = commands.filter(entry => entry && entry.kind === 'custom' && entry.deviceId === deviceId && typeof entry.text === 'string');
    if (helper.command && helper.command.kind === 'custom' && helper.command.deviceId === deviceId && typeof helper.command.text === 'string') entries.push(helper.command);
    entries.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
    const latest = entries[0] || null, local = lastCustomSubmission?.deviceId === deviceId ? lastCustomSubmission : null;
    if (!local) return latest;
    const exact = local.id ? entries.find(entry => entry.id === local.id) : entries.find(entry => entry.text === local.text && timestamp(entry.createdAt) >= timestamp(local.createdAt));
    if (exact) return exact;
    return !latest || timestamp(local.createdAt) >= timestamp(latest.createdAt) ? local : latest;
  }

  function renderCustomCommands() {
    const device = Array.isArray(state.helper?.devices) ? state.helper.devices.find(item => item.id === $('device-select').value) : null;
    $('custom-command-target').textContent = device ? 'To ' + clean(device.name, 100) : 'Choose your Echo above.';
    const entry = displayedCommand();
    $('custom-command-result').hidden = !entry;
    if (!entry) return;
    $('custom-command-text').textContent = clean(entry.text, 500);
    const labels = { sending: 'Sending your request…', sent: 'Request sent to Alexa.', failed: 'Alexa did not confirm this request.' };
    $('custom-command-status').textContent = clean(entry.message, 600) || labels[entry.status] || 'Request status unavailable.';
    $('custom-command-status').dataset.state = ['sending', 'sent', 'failed'].includes(entry.status) ? entry.status : 'unknown';
    const response = entry.responseStatus === 'available' && typeof entry.response === 'string' ? clean(entry.response, 1000) : '';
    $('custom-command-response').textContent = response || (entry.responseStatus === 'pending' ? 'Waiting for Alexa response…' : entry.responseStatus === 'ambiguous' ? 'Alexa response unavailable: it could not be matched to this command.' : 'Alexa response unavailable.');
  }

  function reportedPlayer() {
    const player = state.helper?.player;
    const deviceId = $('device-select').value;
    return player && typeof player === 'object' && !Array.isArray(player) && deviceId && (!player.deviceId || player.deviceId === deviceId) ? player : null;
  }
  const isNumber = (value, min = 0, max = Infinity) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  function seekAvailable() {
    const player = reportedPlayer();
    return helperReady() && !!player && validText(player.title) && validText(player.artist) && isNumber(player.durationMs, 1000) && isNumber(player.positionMs, 0, player.durationMs);
  }
  function quietSearch() {
    const deviceId = $('device-select').value, lease = state.helper?.quietSearch;
    if (lease?.deviceId === deviceId && lease.active === true) return lease;
    const job = state.helper?.job, quiet = job?.quietSearch;
    return job?.deviceId === deviceId && quiet?.active === true ? quiet : null;
  }
  function volumeTarget() {
    const quiet = quietSearch();
    return quiet ? quiet.restoreVolume : reportedPlayer()?.volume;
  }
  function volumeAvailable() {
    return helperReady() && isNumber(volumeTarget(), 0, 100);
  }
  const quietLevel = quiet => isNumber(quiet?.checkVolume, 1, 100) ? Math.round(quiet.checkVolume) + '%' : 'a low volume';
  function renderQuietSearch() {
    const quiet = quietSearch();
    $('echo-quiet-status').hidden = !quiet;
    $('echo-volume-label').textContent = quiet ? 'Volume after song confirmation' : 'Echo volume';
    if (!quiet) return;
    const level = quietLevel(quiet);
    const headings = { preparing: 'Preparing a low-volume song check', muted: 'Echo checking very quietly at ' + level, restoring: 'Restoring Echo volume', failed: 'Quiet song check needs attention' };
    $('echo-quiet-heading').textContent = headings[quiet.phase] || 'Echo checking very quietly at ' + level;
    $('echo-quiet-message').textContent = clean(quiet.message, 600) || (quiet.phase === 'restoring' ? 'Restoring the saved volume after checking playback.' : quiet.phase === 'failed' ? 'Review the local helper status. Echo volume restoration has not been confirmed.' : 'Song candidates play very quietly at ' + level + ' and may still be audible. The saved volume returns after the selected song is confirmed; an unconfirmed song is stopped before restoration.');
    $('echo-quiet-status').dataset.phase = clean(quiet.phase, 30);
  }
  function playerIdentity() {
    const player = reportedPlayer();
    return [$('device-select').value, player?.title || '', player?.artist || '', player?.durationMs ?? ''].join('\u001f');
  }
  function timeText(value) {
    if (!isNumber(value)) return '—';
    const seconds = Math.floor(value / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
    return hours ? hours + ':' + String(minutes % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') : minutes + ':' + String(seconds % 60).padStart(2, '0');
  }
  function renderEchoPlayer() {
    const player = reportedPlayer(), seek = $('echo-seek'), volume = $('echo-volume'), quiet = quietSearch();
    renderQuietSearch();
    $('echo-player-title').textContent = clean(player?.title) || (helperReady() ? 'Playback details unavailable.' : 'Waiting for your Echo.');
    $('echo-player-artist').textContent = clean(player?.artist) || 'The selected Echo has not reported an artist.';
    $('echo-player-state').textContent = ['PLAYING', 'PAUSED', 'STOPPED', 'IDLE'].includes(String(player?.state).toUpperCase()) ? String(player.state).toUpperCase() : '';
    if (!rangeEdits.seek.active && !rangeEdits.seek.dirty) {
      if (seekAvailable()) {
        seek.max = String(Math.max(0, (Math.ceil(player.durationMs / 1000) - 1) * 1000));
        seek.value = String(Math.min(Number(seek.max), Math.floor(player.positionMs / 1000) * 1000));
        seek.setAttribute('aria-valuetext', timeText(player.positionMs) + ' of ' + timeText(player.durationMs));
      } else {
        seek.max = '1000'; seek.value = '0'; seek.setAttribute('aria-valuetext', 'Playback position unavailable');
      }
      $('echo-position').textContent = timeText(player?.positionMs);
      $('echo-duration').textContent = timeText(player?.durationMs);
      $('echo-seek-note').textContent = !helperReady() ? 'Connect your Echo to see playback.' : !player ? 'Waiting for Echo playback details.' : !validText(player.title) || !validText(player.artist) ? 'Seeking is unavailable because Echo has not reported the song and artist.' : !isNumber(player.durationMs, 1000) ? 'Seeking is unavailable because Echo has not reported the song duration.' : !isNumber(player.positionMs, 0, player.durationMs) ? 'Seeking is unavailable because Echo has not reported a valid position.' : 'Drag to choose a position in this song.';
    }
    if (quiet) $('echo-seek-note').textContent = 'Wait for the quiet song check to finish before seeking.';
    else if (handoffActive()) $('echo-seek-note').textContent = 'Wait for this song to be confirmed on Echo before seeking.';
    if (!rangeEdits.volume.active && !rangeEdits.volume.dirty) {
      if (volumeAvailable()) {
        volume.value = String(Math.round(volumeTarget()));
        volume.setAttribute('aria-valuetext', Math.round(volumeTarget()) + (quiet ? ' percent after song confirmation' : ' percent'));
        $('echo-volume-value').textContent = Math.round(volumeTarget()) + '%';
      } else {
        volume.value = '0'; volume.setAttribute('aria-valuetext', 'Volume unavailable');
        $('echo-volume-value').textContent = '—';
      }
      $('echo-volume-note').textContent = quiet ? !volumeAvailable() ? 'The saved playback volume is unavailable. Check the quiet song status above.' : quiet.phase === 'failed' ? 'This is the saved playback volume. The helper has not confirmed safe volume restoration.' : quiet.phase === 'restoring' ? 'This is the saved playback volume. Waiting for Echo to confirm restoration.' : 'This is the saved playback volume. Adjusting it keeps checking at ' + quietLevel(quiet) + '.' : volumeAvailable() ? 'Adjust the selected Echo’s volume.' : 'The selected Echo has not reported its volume.';
    }
  }

  function request(type, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!globalThis.chrome?.runtime?.sendMessage) {
        reject(new Error('Load this folder as a browser extension to use Echo Companion.'));
        return;
      }
      const timeout = setTimeout(() => reject(new Error('The extension did not respond. Reopen it and try again.')), 45000);
      try {
        chrome.runtime.sendMessage({ type, ...payload }, result => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) return reject(new Error('The extension could not complete this action. Reopen it and try again.'));
          if (!result || typeof result !== 'object') return reject(new Error('The extension did not return a response.'));
          if (result.ok === false) return reject(new Error(clean(result.message || result.error, 500) || 'This action could not be completed.'));
          resolve(result);
        });
      } catch (_) {
        clearTimeout(timeout);
        reject(new Error('The extension could not complete this action. Reopen it and try again.'));
      }
    });
  }

  function showMessage(message, tone = 'info', temporary = false) {
    clearTimeout(messageTimer);
    $('result-message').textContent = clean(message, 600);
    $('result-message').dataset.tone = tone;
    $('result-message').hidden = !message;
    if (temporary) messageTimer = setTimeout(() => { $('result-message').hidden = true; }, 9000);
  }

  function setOptions(id, values, selected, placeholder) {
    const select = $(id);
    const safeValues = values.filter(value => value && typeof value.id === 'string' && typeof value.name === 'string')
      .map(value => ({ id: clean(value.id, 150), name: clean(value.name, 100) }));
    const fingerprint = JSON.stringify(safeValues);
    if (optionFingerprints.get(id) !== fingerprint) {
      const options = [];
      if (placeholder) options.push(new Option(placeholder, ''));
      for (const item of safeValues) options.push(new Option(item.name, item.id));
      select.replaceChildren(...options);
      optionFingerprints.set(id, fingerprint);
    }
    if (typeof selected === 'string' && [...select.options].some(option => option.value === selected)) select.value = selected;
    else if (id === 'device-select' && safeValues.length === 1 && !selected) select.value = safeValues[0].id;
  }

  function updateReadiness() {
    $('play-button').disabled = !canPlay();
    $('play-button').querySelector('span').textContent = busy === 'play' ? 'Sending to Echo…' : 'Play on Echo';
    $('refresh-button').disabled = !!busy;
    $('pause-button').disabled = !!busy || !helperReady() || !$('device-select').value;
    $('resume-button').disabled = $('pause-button').disabled;
    $('next-button').disabled = $('pause-button').disabled || !sourceControlsReady();
    $('reload-source-button').disabled = !!busy;
    $('echo-seek').disabled = !!busy || handoffActive() || !!quietSearch() || !seekAvailable();
    $('echo-volume').disabled = !!busy || !volumeAvailable();
    $('follow-toggle').disabled = currentFollow() ? cancelFollowBusy : !canFollow();
    $('cancel-handoff-button').disabled = cancelFollowBusy;
    $('custom-command-send').disabled = !canSendCommand();
    $('custom-command-send').textContent = busy === 'custom-command' ? 'Sending…' : 'Send ↗';
    $('custom-command-input').disabled = busy === 'custom-command';
    $('pair-button').disabled = !!busy;
    $('connect-amazon-button').disabled = !!busy;
    $('manage-amazon-button').disabled = !!busy;
    for (const id of ['device-select', 'provider-select', 'country-select']) $(id).disabled = !!busy;
    $('song-title').disabled = !!busy || !hasTrack();
    $('song-artist').disabled = !!busy || !hasTrack();
  }

  function render() {
    const helper = state.helper || {}, track = state.track;
    let label = 'Local helper not connected', connectionState = 'error';
    if (!state.paired) { label = 'Pair with the local helper'; connectionState = 'waiting'; }
    else if (helper.connected) { label = 'Connected to your Echo'; connectionState = 'ready'; }
    else if (helper.connection?.state || helper.connectionState) {
      const amazonState = helper.connection?.state || helper.connectionState;
      label = amazonState === 'awaiting_login' ? 'Complete Amazon sign-in' : amazonState === 'connecting' ? 'Connecting Amazon…' : 'Connect your Amazon account'; connectionState = 'waiting';
    }
    $('amazon-setup-card').hidden = state.paired && helper.connected === true;
    $('amazon-setup-title').textContent = state.paired ? 'CONNECT YOUR ECHO' : 'Finish extension setup';
    $('connect-amazon-button').textContent = state.paired ? 'Connect Amazon ↗' : 'Open setup ↗';
    $('amazon-setup-note').textContent = !state.paired ? 'Amazon sign-in and browser pairing are separate. Pair this extension below to use your Echo.' : helper.connection?.state === 'awaiting_login' ? 'Open the helper to finish Amazon sign-in.' : 'Open the local helper to connect your Amazon account.';
    $('connection-label').textContent = label;
    $('connection-badge').dataset.state = connectionState;
    $('source-reader-warning').hidden = !sourceUnavailable();
    $('source-reader-message').textContent = clean(state.sourceStatus?.message, 400) || 'The extension cannot read this music page yet.';
    $('source-label').textContent = sourceNames[track?.source] || (sourceUnavailable() ? 'MUSIC PAGE NEEDS RELOAD' : 'Open a music player');
    $('track-title').textContent = track?.isAd ? 'Advertisement' : clean(track?.title) || (sourceUnavailable() ? 'Reconnect this music page.' : state.supported ? 'Choose a song to begin.' : 'Find your next listen.');
    $('track-artist').textContent = track?.isAd ? 'Automatic requests are held during ads.' : displayArtist(track) || (state.supported ? 'Waiting for song details' : 'Apple Music, Spotify or YouTube Music');
    let note = 'Open music.apple.com, open.spotify.com or music.youtube.com, then choose a song.';
    let warning = false;
    if (sourceUnavailable()) { note = 'Following can stay enabled while this music page reconnects.'; warning = true; }
    else if (handoffActive()) note = 'Browser playback is intentionally held while your Echo starts this song.';
    else if (state.supported && !track) note = 'Choose a song in this tab. You can enable following now; requests begin when its details are ready.';
    else if (track?.isAd) { note = 'Ads are never sent to your Echo. Following resumes when a song is detected.'; warning = true; }
    else if (track && track.confidence !== 'high') { note = 'Review the song title and artist before sending. Automatic following waits for complete, reliable details.'; warning = true; }
    else if (track && dirtyTrack) note = 'Edited details apply to this request. Following uses the details detected on the website.';
    else if (track) note = track.state === 'paused' ? 'The browser is paused. You can still send this song to your Echo.' : 'Review these details, then play this song on your Echo.';
    $('track-note').textContent = note;
    $('track-note').dataset.tone = warning ? 'warning' : 'normal';
    const key = trackKey(track);
    if (key !== shownTrackKey || !initialized) {
      shownTrackKey = key; dirtyTrack = false;
      $('song-title').value = clean(track?.title);
      $('song-artist').value = clean(track?.artist);
    }
    renderFeaturedCredit();
    const providers = Array.isArray(helper.providers) && helper.providers.length ? helper.providers.filter(provider => !provider.kind || ['music', 'default'].includes(provider.kind)) : fallbackProviders;
    setOptions('device-select', Array.isArray(helper.devices) ? helper.devices : [], state.settings?.deviceId, 'Choose your Echo');
    setOptions('provider-select', providers, state.settings?.providerId || 'apple-music');
    const country = state.settings?.country || 'IN';
    if ([...$('country-select').options].some(option => option.value === country)) $('country-select').value = country;
    $('source-control-note').textContent = sourceControlsReady() ? 'Play, Pause and Next control the browser tab and your Echo.' : sourceUnavailable() ? 'Reload the music tab to reconnect its playback controls.' : 'Play and Pause control your Echo. Open a supported music tab to use Next.';
    $('resume-button').setAttribute('aria-label', sourceControlsReady() ? 'Play browser music and Echo' : 'Play on Echo');
    $('pause-button').setAttribute('aria-label', sourceControlsReady() ? 'Pause browser music and Echo' : 'Pause Echo');
    $('follow-toggle').checked = currentFollow();
    if (currentFollow()) {
      if (sourceUnavailable()) $('follow-note').textContent = 'Following is enabled. Reload this music webpage to reconnect its song reader.';
      else if (handoffActive()) $('follow-note').textContent = state.handoff.phase === 'resuming' ? 'Echo confirmed this song. The muted browser is resuming.' : 'Following is enabled. The browser is intentionally held until Echo confirms this song.';
      else if (state.handoff?.phase === 'failed') $('follow-note').textContent = 'Following is enabled. This handoff needs attention; see its status above.';
      else if (track?.isAd) $('follow-note').textContent = 'Following is enabled. Waiting for this advertisement to finish.';
      else if (!track || track.confidence !== 'high' || !validText(track.title) || !validText(track.artist)) $('follow-note').textContent = 'Following is enabled. Waiting for reliable song details before sending a request.';
      else if (track.state === 'paused') $('follow-note').textContent = 'Following is enabled. Play the browser to continue on your Echo.';
      else if (track.state !== 'playing') $('follow-note').textContent = 'Following is enabled. Waiting for the browser to report music playing.';
      else $('follow-note').textContent = 'Following this tab. Browser Play and Pause also control Echo. Turning this off stops future requests.';
    } else if (state.follow?.enabled) $('follow-note').textContent = 'Another tab is being followed. Turn this on to follow this tab instead.';
    else if (state.supported && (!track || track.confidence !== 'high' || track.isAd)) $('follow-note').textContent = 'You can enable following now. It waits for reliable song details before sending requests.';
    else $('follow-note').textContent = 'Only one tab is followed. Turning this off stops future requests and safely ends pending song checks.';
    $('pairing-description').textContent = state.paired
      ? 'This extension is paired. To reconnect, create a new pairing code in the local helper and save it here.'
      : 'Open the helper on this Mac, create a pairing code, then paste it here.';
    if (!state.paired) $('pairing-section').open = true;
    else if (!initialized) $('pairing-section').open = false;
    renderEchoPlayer();
    renderHandoff();
    renderCustomCommands();
    updateReadiness();
    initialized = true;
    const job = helper.job, result = state.lastResult, seek = helper.seek || result?.seek;
    const stamp = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
    const jobTime = stamp(job?.updatedAt || job?.createdAt), resultTime = stamp(result?.updatedAt), seekTime = stamp(seek?.updatedAt || seek?.createdAt);
    const resultKey = JSON.stringify([job?.id, job?.state, job?.message, jobTime, result?.ok, result?.message, resultTime, seek?.id, seek?.state, seek?.message, seekTime, state.handoff?.phase, state.handoff?.message, state.error]);
    if (resultKey !== lastResultKey) {
      lastResultKey = resultKey;
      let notice = job?.message ? { kind: 'job', value: job, time: jobTime } : null;
      if (result?.message && (!notice || resultTime > notice.time || (job?.state === 'cancelled' && resultTime >= notice.time))) notice = { kind: 'result', value: result, time: resultTime };
      const seekActive = seek?.active === true || ['preparing', 'sending', 'checking', 'pending'].includes(seek?.state);
      if (seek?.message && (!notice || seekTime > notice.time || (notice.kind === 'job' && (seekActive || (job?.state === 'cancelled' && seekTime >= notice.time))))) notice = { kind: 'seek', value: seek, time: seekTime };
      if (state.error) showMessage(state.error, 'error');
      else if (handoffActive()) showMessage('');
      else if (notice) {
        const error = notice.value.ok === false || ['error', 'unmatched', 'unverified'].includes(notice.value.state);
        const matched = ['matched', 'confirmed'].includes(notice.value.state);
        showMessage(notice.value.message, error ? 'error' : matched ? 'success' : 'info', notice.kind === 'result' && !seekActive);
      } else if (lastStateError) showMessage('');
    }
    lastStateError = clean(state.error, 600);
  }

  async function refresh() {
    if (pollBusy || busy || closed) return;
    pollBusy = true;
    const startedRevision = revision;
    try {
      const result = await request('GET_POPUP_STATE');
      if (closed || busy || startedRevision !== revision) return;
      state = { ...state, ...result, helper: result.helper || {}, settings: result.settings || state.settings, follow: result.follow || {}, error: result.error || '' };
      render();
    } catch (error) {
      if (!closed && !busy && startedRevision === revision) { state.helper = {}; state.error = error.message; render(); }
    } finally { pollBusy = false; }
  }

  async function perform(kind, task) {
    if (busy) return;
    busy = kind; const actionRevision = ++revision; updateReadiness();
    try {
      const result = await task();
      if (result?.message && actionRevision === revision) showMessage(result.message, 'info', true);
      return result;
    } catch (error) {
      if (actionRevision === revision) showMessage(error.message, 'error');
      return null;
    } finally {
      busy = ''; updateReadiness();
      await refresh();
    }
  }

  const settings = () => ({ deviceId: $('device-select').value, providerId: $('provider-select').value, country: $('country-select').value });
  async function saveSettings() {
    const next = settings();
    state.settings = next;
    await request('SAVE_SETTINGS', { settings: next });
  }

  function beginRangeEdit(kind, keyboard = false) {
    const range = $('echo-' + kind), edit = rangeEdits[kind];
    if (range.disabled || busy) return;
    if (!edit.active) edit.identity = kind === 'seek' ? playerIdentity() : $('device-select').value;
    edit.active = true;
    if (keyboard) edit.keyboard = true;
  }
  function previewRange(kind) {
    const range = $('echo-' + kind), edit = rangeEdits[kind];
    if (range.disabled || busy) return;
    if (!edit.active) beginRangeEdit(kind);
    edit.dirty = true;
    if (kind === 'seek') {
      const value = Number(range.value);
      $('echo-position').textContent = timeText(value);
      $('echo-seek-note').textContent = 'Release to seek to ' + timeText(value) + '.';
      range.setAttribute('aria-valuetext', 'Seek to ' + timeText(value));
    } else {
      $('echo-volume-value').textContent = range.value + '%';
      $('echo-volume-note').textContent = quietSearch() ? 'Release to save ' + range.value + '% as the playback volume.' : 'Release to set Echo volume to ' + range.value + '%.';
      range.setAttribute('aria-valuetext', range.value + (quietSearch() ? ' percent after song confirmation' : ' percent'));
    }
  }
  async function commitRange(kind) {
    const range = $('echo-' + kind), edit = rangeEdits[kind];
    if (!edit.dirty || edit.keyboard) return;
    const identity = edit.identity, value = Number(range.value);
    edit.active = false; edit.dirty = false; edit.keyboard = false;
    if (busy) { renderEchoPlayer(); return; }
    const valid = kind === 'seek' ? !handoffActive() && !quietSearch() && seekAvailable() && identity === playerIdentity() && Number.isInteger(value) && value >= 0 && value < reportedPlayer().durationMs : volumeAvailable() && identity === $('device-select').value && Number.isInteger(value) && value >= 0 && value <= 100;
    if (!valid) {
      showMessage(kind === 'seek' ? quietSearch() ? 'Wait for the quiet song check to finish before seeking.' : handoffActive() ? 'Wait for this song to be confirmed on Echo before seeking.' : 'Echo playback changed or its position is unavailable. Review the current song and try again.' : 'The Echo changed or its volume is unavailable. Review the selected speaker and try again.', 'error');
      renderEchoPlayer(); updateReadiness(); return;
    }
    const control = kind === 'seek' ? { action: 'seek', positionMs: value, expectedTrack: { title: reportedPlayer().title, artist: reportedPlayer().artist } } : { action: 'volume', volume: value };
    await perform(kind, () => request('CONTROL', control));
  }
  for (const kind of ['seek', 'volume']) {
    const range = $('echo-' + kind), edit = rangeEdits[kind];
    range.addEventListener('pointerdown', () => beginRangeEdit(kind));
    range.addEventListener('input', () => previewRange(kind));
    range.addEventListener('change', () => commitRange(kind));
    range.addEventListener('pointerup', () => { if (!edit.dirty) edit.active = false; });
    range.addEventListener('pointercancel', () => {
      edit.active = false; edit.dirty = false; edit.keyboard = false;
      renderEchoPlayer(); updateReadiness();
    });
    range.addEventListener('keydown', event => { if (rangeKeys.has(event.key)) beginRangeEdit(kind, true); });
    range.addEventListener('keyup', event => {
      if (rangeKeys.has(event.key)) { edit.active = false; edit.keyboard = false; commitRange(kind); }
    });
    range.addEventListener('blur', () => { edit.active = false; edit.keyboard = false; commitRange(kind); });
  }

  $('reload-source-button').addEventListener('click', () => {
    if (!sourceUnavailable() || $('reload-source-button').disabled) return;
    perform('reload-source', () => request('RELOAD_SOURCE'));
  });
  $('refresh-button').addEventListener('click', () => perform('refresh', async () => {
    dirtyTrack = false;
    const result = await request('REFRESH_TRACK');
    if (Object.hasOwn(result, 'track')) { state.track = result.track; shownTrackKey = ''; }
    return result;
  }));
  $('play-button').addEventListener('click', () => {
    if (!canPlay()) return;
    const track = { ...state.track, title: $('song-title').value.trim(), artist: $('song-artist').value.trim() };
    perform('play', async () => { await saveSettings(); return request('PLAY_TRACK', { track }); });
  });
  for (const [id, action] of [['pause-button', 'pause'], ['resume-button', 'play'], ['next-button', 'next']]) $(id).addEventListener('click', () => {
    if ($(id).disabled) return;
    perform(action, async () => {
      await saveSettings();
      return request('CONTROL', { action });
    });
  });
  for (const id of ['device-select', 'provider-select', 'country-select']) $(id).addEventListener('change', () => perform('settings', saveSettings));
  for (const id of ['song-title', 'song-artist']) $(id).addEventListener('input', () => {
    dirtyTrack = true;
    renderFeaturedCredit();
    $('track-note').textContent = 'Edited details apply to this request. Following uses the details detected on the website.';
    updateReadiness();
  });
  async function cancelFollowing() {
    if (cancelFollowBusy) return;
    cancelFollowBusy = true; const cancellationRevision = ++revision; updateReadiness();
    try {
      const result = await request('SET_FOLLOW', { enabled: false });
      if (cancellationRevision === revision) {
        state.follow = result.follow || { enabled: false };
        state.handoff = result.handoff || null;
        render();
        showMessage(result.message || 'Following and the pending handoff stopped. Pending song checks are ending safely.', 'info', true);
      }
    } catch (error) { if (cancellationRevision === revision) showMessage(error.message, 'error'); }
    finally { cancelFollowBusy = false; updateReadiness(); await refresh(); }
  }
  $('follow-toggle').addEventListener('change', () => {
    const enabled = $('follow-toggle').checked;
    if (!enabled) { cancelFollowing(); return; }
    perform('follow', async () => {
      await saveSettings();
      const result = await request('SET_FOLLOW', { enabled });
      if (result.follow) state.follow = result.follow;
      return result;
    });
  });
  $('cancel-handoff-button').addEventListener('click', () => { if (handoffActive()) cancelFollowing(); });
  $('custom-command-input').addEventListener('input', updateReadiness);
  $('custom-command-form').addEventListener('submit', event => {
    event.preventDefault();
    const text = $('custom-command-input').value.trim();
    if (!commandValid(text)) { showMessage('Enter a single-line Alexa command of 1 to 500 characters.', 'error'); return; }
    if (!canSendCommand()) return;
    const deviceId = $('device-select').value;
    lastCustomSubmission = { text, kind: 'custom', deviceId, status: 'sending', message: 'Sending your command…', response: null, responseStatus: 'pending', createdAt: Date.now() };
    renderCustomCommands();
    perform('custom-command', async () => {
      try {
        await saveSettings();
        const result = await request('CUSTOM_COMMAND', { text });
        lastCustomSubmission = { ...lastCustomSubmission, id: typeof result.commandId === 'string' ? result.commandId : result.command?.id, status: 'sent', message: clean(result.message, 600) || 'Request sent to Alexa.' };
        $('custom-command-input').value = '';
        renderCustomCommands();
        return result;
      } catch (error) {
        lastCustomSubmission = { ...lastCustomSubmission, status: 'failed', message: error.message, responseStatus: 'unavailable' };
        renderCustomCommands(); throw error;
      }
    });
  });
  $('pair-form').addEventListener('submit', event => {
    event.preventDefault();
    const token = $('pair-token').value.trim();
    if (token.length < 16 || token.length > 200 || /[\u0000-\u0020\u007f]/.test(token)) {
      showMessage('Paste the complete pairing code shown by the local helper.', 'error');
      return;
    }
    perform('pair', async () => {
      const result = await request('SET_PAIR_TOKEN', { token });
      $('pair-token').value = '';
      $('pairing-section').open = false;
      return result;
    });
  });
  $('open-helper-button').addEventListener('click', () => perform('open', () => request('OPEN_HELPER')));
  for (const id of ['connect-amazon-button', 'manage-amazon-button']) $(id).addEventListener('click', () => perform('open', () => request(id === 'connect-amazon-button' && !state.paired ? 'OPEN_HELPER' : 'OPEN_AMAZON_SETUP')));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('unload', () => {
    closed = true; clearInterval(pollTimer); clearTimeout(messageTimer);
  });
  refresh();
  pollTimer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh(); }, 3000);
})();
