"use strict";
(function () {
  const $ = function (id) { return document.getElementById(id); };
  const defaults = { IN: 'en-IN', US: 'en-US', UK: 'en-GB', DE: 'de-DE', CA: 'en-CA', AU: 'en-AU', JP: 'ja-JP' };
  const countries = ['IN', 'US', 'GB', 'DE', 'CA', 'AU', 'JP'];
  const fallbackProviders = [{ id: 'alexa-default', name: 'Alexa default', kind: 'default', reportedByAlexa: false }, { id: 'apple-music', name: 'Apple Music', kind: 'music', reportedByAlexa: false }, { id: 'amazon-music', name: 'Amazon Music', kind: 'music', reportedByAlexa: false }, { id: 'spotify', name: 'Spotify', kind: 'music', reportedByAlexa: false }, { id: 'jiosaavn', name: 'JioSaavn', kind: 'music', reportedByAlexa: false }];
  const providerExploreUrls = Object.freeze({ 'amazon-music': 'https://music.amazon.in/', spotify: 'https://open.spotify.com/', jiosaavn: 'https://www.jiosaavn.com/', tunein: 'https://tunein.com/', deezer: 'https://www.deezer.com/', pandora: 'https://www.pandora.com/', iheartradio: 'https://www.iheart.com/', siriusxm: 'https://www.siriusxm.com/', tidal: 'https://tidal.com/', gaana: 'https://gaana.com/', hungama: 'https://www.hungama.com/' });
  function normalizeCountry(value) { const country = String(value || '').toUpperCase(); return country === 'UK' ? 'GB' : country; }
  function countryName(code) { const option = Array.from($('country-select').options).find(function (item) { return item.value === normalizeCountry(code); }); return option ? option.textContent : String(code || '').toUpperCase(); }
  const state = { seekSongKey: '', seekSnapshot: null, seekObservedAt: null, seekEditing: false, seekEditKey: '', seekEditStart: null, seekDraft: null, seekRequested: null, seekBusy: false, seekChecking: false, seekUnverified: false, seekStale: false, seekError: '', seekRevision: 0, seekWriteId: 0, volume: null, volumeDeviceId: '', volumeDraft: null, volumeRequested: null, volumeEditing: false, volumeEditStart: null, volumeBusy: false, volumeStale: false, volumeError: '', volumeRevision: 0, volumeWriteId: 0, catalogueSource: 'itunes', view: 'search', playlists: [], playlistsSource: 'local', playlistSourceSaved: false, localPlaylist: null, localPlaylistGeneration: 0, localMutationBusy: false, playlistDialog: null, playlistDialogGeneration: 0, playlistDialogBusy: false, playlistImport: null, playlistImportGeneration: 0, playlistImportSavePending: null, sidebarOpen: false, sidebarTab: 'commands', sidebarModal: false, sidebarPreviousFocus: null, queueOpen: false, queueItemsFingerprint: '', playerActionsKey: '', playlistsLoading: false, playlistGeneration: 0, playlistAccountsFingerprint: null, playlistBusy: false, playlistPreview: null, playlistPreviewGeneration: 0, queue: null, queueBusy: false, queueSubmissionPromise: null, queueEpoch: 0, queueObserved: new Set(), queueDismissed: new Set(), queueDismissTimers: new Map(), commandsOpen: false, commandsModal: false, commands: [], commandsFingerprint: '', commandsTimer: null, commandsController: null, commandsGeneration: 0, commandsPreviousFocus: null, customCommandBusy: false, providers: fallbackProviders.slice(), providerId: 'apple-music', requestMode: 'standard', providerSaved: false, providersLoading: false, providersPromise: null, providersDiscovery: 'unavailable', providersMessage: '', providerChanging: false, providerChangeGeneration: 0,  country: 'IN', resultsCountry: null, resultsSource: null,  connection: { state: 'disconnected' }, settings: {}, devices: [], tracks: [], deviceId: '', player: null, playerStale: false, pendingTrack: null, pendingSelection: null, playSubmissionPromise: null, playback: null, playbackEpoch: 0, playbackNotified: new Set(), playbackObserved: new Set(), playbackDismissed: new Set(), playbackDismissTimers: new Map(), cancelBusy: false, cancelPromise: null, controlBusy: false, deviceChanging: false, deviceChangeGeneration: 0, initialized: false, statusBusy: false, playerBusy: false, searching: false, searchController: null, searchGeneration: 0, statusTimer: null, toastTimer: null };
  try { state.deviceId = localStorage.getItem('echo-library-device') || ''; const savedCountry = normalizeCountry(localStorage.getItem('echo-library-country')); if (countries.includes(savedCountry)) state.country = savedCountry; } catch (_) {}
  try { const savedProvider = localStorage.getItem('echo-library-provider'); if (typeof savedProvider === 'string' && savedProvider.length > 0 && savedProvider.length <= 150 && !/[\u0000-\u001f\u007f]/u.test(savedProvider)) { state.providerId = savedProvider; state.providerSaved = true; } } catch (_) {}
  $('country-select').value = state.country;
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function safeUrl(value, localOnly) {
    try { const url = new URL(value); if (localOnly) return (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ? url.href : ''; return url.protocol === 'https:' ? url.href : ''; } catch (_) { return ''; }
  }
  async function api(path, options) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 30000);
    const requestOptions = Object.assign({ signal: controller.signal }, options || {});
    if (options && options.method) requestOptions.headers = Object.assign({ 'Content-Type': 'application/json', 'X-Echo-App': '1' }, options.headers || {});
    try {
      const response = await window.echoExtensionFetch(path, requestOptions);
      let data; try { data = await response.json(); } catch (_) { throw new Error('The app returned an unexpected response. Try again.'); }
      if (!response.ok) throw new Error(data.message || 'That request could not be completed. Try again.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('That took longer than expected. Please try again.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function toast(message, isError) {
    clearTimeout(state.toastTimer); const node = $('toast'); node.textContent = message; node.classList.toggle('error', !!isError); node.hidden = false;
    state.toastTimer = setTimeout(function () { node.hidden = true; }, isError ? 8000 : 5000);
  }
  function notice(message) { $('global-notice').textContent = message || ''; $('global-notice').hidden = !message; }
  function selectedDevice() { return state.devices.find(function (device) { return device.id === state.deviceId; }); }
  function canPlay() { const device = selectedDevice(); return state.connection.state === 'connected' && device && device.online !== false; }
  function canPlayResult() { return canRequestSong() && !state.searching && !state.deviceChanging && !state.providerChanging && !state.customCommandBusy && !state.playlistBusy && !state.queueBusy && !state.providersLoading && !state.cancelBusy && !state.controlBusy && ['apple-music', 'spotify', 'itunes'].includes(state.resultsSource) && state.resultsCountry === $('country-select').value; }
  function saveDevice() { try { localStorage.setItem('echo-library-device', state.deviceId); } catch (_) {} }
  function applyStatus(data, options) {
    const previousCatalogue = state.catalogueSource || state.resultsSource || 'itunes';
    const oldDevice = state.deviceId; const oldConnectionState = state.connection.state;
    state.connection = data.connection || { state: 'error', message: 'Connection status is unavailable.' };
    state.settings = data.settings || state.settings;
    state.devices = Array.isArray(data.devices) ? data.devices : [];
    if (!state.initialized) {
      if (defaults[state.settings.region]) $('region-select').value = state.settings.region;
      if (state.settings.locale) $('locale-select').value = state.settings.locale;
      state.initialized = true;
    }
    if (!state.devices.some(function (device) { return device.id === state.deviceId; })) {
      const fallback = state.devices.find(function (device) { return device.online !== false; }) || state.devices[0];
      state.deviceId = fallback ? fallback.id : ''; saveDevice();
    }
    const playerRevisionCurrent = options?.seekRevision === state.seekRevision && !state.seekEditing && !state.seekBusy;
    if (playerRevisionCurrent && data.player && (!data.player.deviceId || data.player.deviceId === state.deviceId)) { state.player = data.player; state.playerStale = false; }
    if (oldDevice !== state.deviceId || state.connection.state !== 'connected') { state.player = null; state.playerStale = false; }
    if (data.catalogue && ['apple-music', 'spotify', 'itunes'].includes(data.catalogue.source)) {
      state.catalogueSource = data.catalogue.source;
      if (previousCatalogue !== state.catalogueSource) { invalidateSearch(''); const query = $('search-input').value.trim(); if (query) search(query); }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'queue')) applyQueue(data.queue, options || {});
    renderPlaylistSources();
    if (Object.prototype.hasOwnProperty.call(data, 'playback')) applyPlayback(data.playback, options || {});
    renderConnection(); renderDevices(); renderProviders(); renderCustomCommand(); updatePlayButtons(); renderPlayer();
    if (oldConnectionState !== state.connection.state) refreshProviders();
    if ((oldDevice !== state.deviceId || oldConnectionState !== 'connected') && canPlay()) refreshPlayer();
  }
  function renderConnection() {
    const mode = state.connection.state;
    const connected = mode === 'connected'; const waiting = mode === 'connecting' || mode === 'awaiting_login';
    $('connection-title').textContent = connected ? 'Amazon connected' : mode === 'awaiting_login' ? 'Finish signing in' : mode === 'connecting' ? 'Connecting…' : mode === 'error' ? 'Connection needs attention' : 'Connect your Echo';
    $('connection-message').textContent = state.connection.message || (connected ? 'Choose your Echo below, then find a song.' : 'Link your Amazon account to send music to your Echo.');
    $('connection-dot').className = 'status-dot' + (connected ? ' connected' : waiting ? ' waiting' : mode === 'error' ? ' error' : '');
    $('connection-fields').hidden = connected || waiting;
    $('connect-button').hidden = connected || waiting;
    $('connect-button').disabled = waiting;
    $('connect-button').textContent = mode === 'error' ? 'Try connecting again ↗' : 'Connect Amazon ↗';
    const loginUrl = safeUrl(state.connection.loginUrl, true);
    $('login-link').hidden = mode !== 'awaiting_login' || !loginUrl;
    if (loginUrl) $('login-link').href = loginUrl; else $('login-link').removeAttribute('href');
    $('disconnect-button').hidden = !connected && !waiting && mode !== 'error';
    $('disconnect-button').textContent = waiting ? 'Cancel connection' : mode === 'error' ? 'Reset connection' : 'Disconnect account';
    $('privacy-note').hidden = connected;
    $('region-select').disabled = connected || waiting; $('locale-select').disabled = connected || waiting;
  }
  function renderDevices() {
    const select = $('device-select'); select.replaceChildren();
    if (!state.devices.length) { const placeholder = element('option', '', state.connection.state === 'connected' ? 'No Echo found' : 'Connect to find your Echo'); placeholder.value = ''; select.appendChild(placeholder); }
    state.devices.forEach(function (device) { const option = element('option', '', device.name + (device.online === false ? ' · offline' : '')); option.value = device.id; select.appendChild(option); });
    select.value = state.deviceId; select.disabled = state.connection.state !== 'connected' || !state.devices.length;
    const device = selectedDevice();
    $('speaker-note').textContent = device && device.online === false ? 'This Echo appears offline. Check its Wi-Fi connection.' : state.connection.state === 'connected' && !state.devices.length ? 'Check that your Echo uses this Amazon account, then reconnect.' : 'Your Echo streams the music directly.';
    $('player-device').textContent = device ? device.name.toUpperCase() : 'NO ECHO CONNECTED';
    $('player-dot').className = 'status-dot' + (canPlay() ? ' connected' : '');
  }
  function providerName(id) { const provider = state.providers.find(function (item) { return item.id === id; }) || fallbackProviders.find(function (item) { return item.id === id; }); return provider ? provider.name : 'Selected service'; }
  function selectedProvider() { return state.providers.find(function (item) { return item.id === state.providerId; }) || { id: state.providerId, name: providerName(state.providerId), kind: 'music' }; }
  function requestModeProblem() { return ''; }
  function canRequestSong() { state.requestMode = 'standard'; return canPlay(); }
  function requestModeName(mode) { return mode === 'music-request-test' ? 'Music request test' : 'Current method'; }
  function renderRequestMode() { state.requestMode = 'standard'; }
  function renderProviders() {
    const select = $('provider-select'); select.replaceChildren();
    state.providers.forEach(function (provider) { const option = element('option', '', provider.name + (provider.kind === 'radio' ? ' · radio' : '')); option.value = provider.id; select.appendChild(option); });
    if (!state.providers.some(function (provider) { return provider.id === state.providerId; })) { const saved = element('option', '', 'Previously selected service'); saved.value = state.providerId; select.appendChild(saved); }
    select.value = state.providerId; select.disabled = state.providerChanging;
    $('provider-discovery').textContent = state.providerChanging ? 'Stopping previous retries…' : state.providersLoading ? 'Checking Alexa’s service list…' : state.providersMessage;
    $('provider-note').textContent = state.providerId === 'alexa-default' ? 'Alexa chooses the service. Select one here to request it explicitly.' : 'Link the selected service in Alexa. A subscription may be required.';
    renderCatalogueSource(); renderRequestMode();
  }
  function applyProviders(data) {
    const providers = [], seen = new Set();
    const incoming = Array.isArray(data.providers) ? data.providers : [];
    incoming.concat(fallbackProviders).forEach(function (provider) {
      if (!provider || typeof provider.id !== 'string' || !provider.id || provider.id.length > 150 || /[\u0000-\u001f\u007f]/u.test(provider.id) || typeof provider.name !== 'string' || !provider.name.trim() || seen.has(provider.id)) return;
      seen.add(provider.id); providers.push({ id: provider.id, name: provider.name.slice(0, 150), kind: ['music', 'radio', 'default'].includes(provider.kind) ? provider.kind : 'music', reportedByAlexa: provider.reportedByAlexa === true });
    });
    state.providers = providers;
    state.providersDiscovery = data.discovery === 'ready' ? 'ready' : 'unavailable';
    state.providersMessage = state.providersDiscovery === 'ready' ? 'Services vary by your Alexa account and country.' : 'Alexa’s service list is unavailable. Choose a linked service.';
    if (!state.providerSaved) state.providerId = typeof data.defaultProviderId === 'string' && providers.some(function (provider) { return provider.id === data.defaultProviderId; }) ? data.defaultProviderId : 'apple-music';
    renderProviders(); updatePlayButtons();
  }
  function refreshProviders() {
    if (state.providersPromise) return state.providersPromise;
    state.providersLoading = true; renderProviders(); updatePlayButtons();
    state.providersPromise = (async function () {
      try { applyProviders(await api('/api/music-providers')); }
      catch (_) { state.providersDiscovery = 'unavailable'; state.providersMessage = 'Alexa’s service list is unavailable. Choose a linked service.'; }
      finally { state.providersLoading = false; state.providersPromise = null; renderProviders(); updatePlayButtons(); }
    }());
    return state.providersPromise;
  }
  async function changeProvider() {
    const providerId = $('provider-select').value; const generation = ++state.providerChangeGeneration;
    const requestId = activeQueue() ? state.queue.id : state.playback && state.playback.id;
    state.providerChanging = true; state.providerId = providerId; state.providerSaved = true;
    try { localStorage.setItem('echo-library-provider', providerId); } catch (_) {}
    renderProviders(); updatePlayButtons(); renderPlayback();
    try { if (!queueReady() || activePlayback()) await cancelPlayback({ silent: true, requestId: requestId }); }
    catch (_) { if (generation === state.providerChangeGeneration) toast('Could not confirm cancellation of the previous retries. Check the connection before choosing another song.', true); }
    finally { if (generation === state.providerChangeGeneration) { state.providerChanging = false; renderProviders(); updatePlayButtons(); renderPlayback(); scheduleStatus(500); } }
  }
  function renderSearchReadiness() {
    $('country-select').disabled = state.pendingTrack !== null || !!(state.playback && state.playback.active) || (activeQueue() && state.queue.state !== 'ready') || state.queueBusy;
    $('search-button').disabled = state.searching;
    document.querySelectorAll('[data-query]').forEach(function (button) { button.disabled = false; });
  }
  function jobTime(value) { if (typeof value === 'number' && Number.isFinite(value)) return value; const time = Date.parse(value || ''); return Number.isFinite(time) ? time : 0; }
  function activePlayback() { return !!(state.playback && state.playback.active); }
  function statusDelay() { return activePlayback() || activeQueue() ? 2000 : ['connecting', 'awaiting_login'].includes(state.connection.state) ? 4000 : 12000; }
  function scheduleStatus(delay) { clearTimeout(state.statusTimer); state.statusTimer = setTimeout(refreshStatus, delay === undefined ? statusDelay() : delay); }
  function setProgressText(id, text) { if ($(id).textContent !== text) $(id).textContent = text; }
  function renderPlayback() {
    const panel = $('playback-progress'); const job = state.playback;
    const pending = state.pendingTrack !== null && state.pendingSelection;
    if (!pending && (!job || job.deviceId !== state.deviceId || (!job.active && state.playbackDismissed.has(job.id)))) { panel.hidden = true; renderSearchReadiness(); return; }
    panel.hidden = false;
    const labels = { preparing: 'Preparing your song request', sending: 'Sending the song request', checking: 'Checking the selected song', retrying: 'Trying another credited artist', matched: 'Song confirmed on your Echo', unmatched: 'Could not confirm the selected song', unverified: 'Unable to verify playback', cancelled: 'Automatic retries cancelled', error: 'Song request needs attention' };
    const active = !pending && !!job.active;
    const phase = pending ? 'sending' : job.state;
    panel.dataset.state = phase; panel.dataset.active = String(active || !!pending);
    const selection = pending ? state.pendingSelection : job;
    const requestedName = selection.providerName || providerName(selection.providerId || 'alexa-default');
    const reportedName = !pending && typeof job.reportedProviderName === 'string' ? job.reportedProviderName.trim() : '';
    let heading = pending ? 'Sending your song request…' : labels[phase] || 'Checking your song request';
    if (!pending && phase === 'matched' && !reportedName) heading = 'Song matched; service not reported';
    setProgressText('playback-progress-title', heading);
    setProgressText('playback-provider', requestModeName(selection.requestMode) + ' · Requested: ' + requestedName + ' · ' + (reportedName ? 'Echo reports: ' + reportedName : pending ? 'Waiting for Echo’s service report.' : 'Streaming service not reported by Echo.'));
    const song = selection.title + (selection.artist ? ' · ' + selection.artist : '');
    const detail = !pending && job.message ? song + ' — ' + job.message : song;
    setProgressText('playback-progress-detail', detail);
    const count = !pending && job.maxAttempts ? 'Attempt ' + Math.max(1, Number(job.attempt) || 1) + ' of ' + job.maxAttempts : '';
    setProgressText('playback-attempt', count);
    $('playback-attempt').hidden = !count;
    $('cancel-retries-button').hidden = !active;
    $('cancel-retries-button').disabled = state.cancelBusy || state.controlBusy;
    $('cancel-retries-button').textContent = state.cancelBusy ? 'Cancelling…' : 'Cancel retries';
    $('playback-cancel-note').hidden = !active;
    renderSearchReadiness();
  }
  function schedulePlaybackDismiss(job) {
    if (state.playbackDismissed.has(job.id) || state.playbackDismissTimers.has(job.id)) return;
    const delay = ['unmatched', 'unverified', 'error'].includes(job.state) ? 9000 : 6000;
    const timer = setTimeout(function () { state.playbackDismissTimers.delete(job.id); state.playbackDismissed.add(job.id); renderPlayback(); }, delay);
    state.playbackDismissTimers.set(job.id, timer);
  }
  function applyPlayback(job, options) {
    const opts = options || {};
    if (opts.statusEpoch !== undefined && opts.statusEpoch !== state.playbackEpoch) return false;
    if (state.pendingTrack !== null && !opts.fromSubmission) return false;
    const current = state.playback;
    if (job && typeof job.id !== 'string') return false;
    if (job && current && !opts.fromSubmission) {
      if (job.id !== current.id && jobTime(job.createdAt) <= jobTime(current.createdAt)) return false;
      if (job.id === current.id && (jobTime(job.updatedAt) < jobTime(current.updatedAt) || (!current.active && job.active))) return false;
    }
    state.playback = job || null;
    if (job && (job.active || opts.fromSubmission)) state.playbackObserved.add(job.id);
    if (job && !job.active) {
      if (!state.playbackObserved.has(job.id)) state.playbackDismissed.add(job.id);
      else schedulePlaybackDismiss(job);
      const key = job.id + ':' + job.state;
      if (!state.playbackNotified.has(key)) {
        state.playbackNotified.add(key);
        if (opts.notify !== false && !state.playbackDismissed.has(job.id) && job.deviceId === state.deviceId) toast(job.message || ({ matched: 'The selected song was confirmed on your Echo.', unmatched: 'The selected song could not be confirmed.', unverified: 'Playback could not be verified.', cancelled: 'Automatic retries cancelled. Current music keeps playing.', error: 'The song request could not be completed.' }[job.state] || 'Song request finished.'), ['unmatched', 'unverified', 'error'].includes(job.state));
      }
    }
    renderPlayback(); updatePlayButtons(); return true;
  }
  function cancelPlayback(options) {
    const opts = options || {};
    if (state.cancelPromise) return state.cancelPromise;
    const capturedRequestId = opts.requestId || (activeQueue() ? state.queue.id : state.playback && state.playback.id);
    const capturedSubmission = state.playSubmissionPromise || state.queueSubmissionPromise;
    if (opts.silent && queueReady() && !activePlayback() && !capturedSubmission) return Promise.resolve({ playback: state.playback, queue: state.queue });
    if (!capturedRequestId && !capturedSubmission && !activeQueue() && opts.silent) return Promise.resolve({ playback: state.playback });
    state.cancelBusy = true; ++state.playbackEpoch;
    if (state.playback) state.playbackNotified.add(state.playback.id + ':cancelled');
    renderPlayback(); updatePlayButtons();
    state.cancelPromise = (async function () {
      try {
        let requestId = capturedRequestId;
        if (capturedSubmission) { try { const accepted = await capturedSubmission; requestId = (accepted.queue && accepted.queue.id) || (accepted.playback && accepted.playback.id) || accepted.requestId || requestId; } catch (_) {} }
        if (requestId) state.playbackNotified.add(requestId + ':cancelled');
        const result = await api('/api/cancel-playback', { method: 'POST', body: JSON.stringify(requestId ? { requestId: requestId } : {}) });
        ++state.playbackEpoch;
        if (Object.prototype.hasOwnProperty.call(result, 'playback')) applyPlayback(result.playback, { notify: false });
        if (Object.prototype.hasOwnProperty.call(result, 'queue')) applyQueue(result.queue, { fromMutation: true });
        if (!opts.silent) toast(result.playback && result.playback.active ? 'That request was replaced. The newer song request is still active.' : 'Automatic retries stopped. Current music keeps playing.');
        return result;
      } catch (error) { if (!opts.silent) toast(error.message, true); throw error; }
      finally { state.cancelBusy = false; state.cancelPromise = null; renderPlayback(); updatePlayButtons(); scheduleStatus(500); }
    }());
    return state.cancelPromise;
  }
  async function refreshStatus() {
    if (state.statusBusy) return;
    state.statusBusy = true;
    const statusEpoch = state.playbackEpoch; const queueEpoch = state.queueEpoch; const seekRevision = state.seekRevision;
    try { applyStatus(await api('/api/status'), { statusEpoch: statusEpoch, queueEpoch: queueEpoch, seekRevision: seekRevision }); notice(''); }
    catch (error) { notice(error.message || 'The local helper is not responding. Keep Echo Companion running on this computer.'); refreshExtensionConnection(); }
    finally { state.statusBusy = false; scheduleStatus(); }
  }
  function setArtwork(container, url, alt) {
    container.replaceChildren(document.createTextNode('♫'));
    const safe = safeUrl(url); if (!safe) return;
    const image = document.createElement('img'); image.src = safe; image.alt = alt || ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.addEventListener('error', function () { image.remove(); }, { once: true }); container.appendChild(image);
  }
  function duration(ms) { if (!Number.isFinite(ms) || ms <= 0) return '—'; const seconds = Math.floor(ms / 1000); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
  function playIcon() { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M7 4 21 12 7 20z'); svg.appendChild(path); return svg; }
  function activeCatalogueSource() { return state.resultsSource || state.catalogueSource || 'itunes'; }
  function catalogueHeading() { return ({ 'apple-music': 'Apple Music', spotify: 'Spotify', itunes: 'Public catalogue' }[activeCatalogueSource()] || 'Public catalogue') + ' · ' + countryName(state.resultsCountry || $('country-select').value); }
  function renderCatalogueSource() {
    const country = countryName(state.resultsCountry || $('country-select').value);
    const service = state.providerId === 'alexa-default' ? 'your Alexa default service' : selectedProvider().name;
    const source = activeCatalogueSource();
    const countryCode = normalizeCountry(state.resultsCountry || $('country-select').value);
    const destination = state.providerId === 'apple-music' ? 'https://music.apple.com/' + (countries.includes(countryCode) ? countryCode.toLowerCase() : 'in') + '/' : state.providerId === 'amazon-music' && countryCode !== 'IN' ? 'https://music.amazon.com/' : providerExploreUrls[state.providerId];
    const explore = $('catalogue-explore-link'); explore.hidden = !destination;
    if (destination) { explore.href = destination; explore.textContent = 'Explore ' + selectedProvider().name + ' ↗'; }
    else { explore.removeAttribute('href'); explore.textContent = ''; }
    $('catalogue-source-note').textContent = source === 'apple-music' ? 'Results are checked against Apple Music for ' + country + '. Availability on ' + service + ' and Alexa’s recording match can differ.' : source === 'spotify' ? 'Spotify catalogue for ' + country + '. Availability on ' + service + ' and Alexa matching can differ.' : 'Public catalogue for ' + country + '. Availability on ' + service + ' and Alexa matching can differ.';
  }
  function renderTracks(query) {
    const list = $('results-list'); list.replaceChildren();
    $('results-title').textContent = state.tracks.length ? catalogueHeading() : 'No songs found in ' + countryName($('country-select').value) + '.';
    renderCatalogueSource();
    $('results-count').textContent = state.tracks.length ? state.tracks.length + (state.tracks.length === 1 ? ' SONG' : ' SONGS') : '';
    $('empty-state').hidden = !!state.tracks.length;
    if (!state.tracks.length) { $('empty-state').querySelector('h3').textContent = 'Try another song or artist.'; $('empty-state').querySelector('p').textContent = 'You can also try a different catalogue country.'; }
    $('results-status').textContent = state.tracks.length && !canPlay() ? 'Connect your Echo to play a song from these results.' : '';
    state.tracks.forEach(function (track, index) {
      const row = element('div', 'track-row');
      row.appendChild(element('span', 'track-number', String(index + 1).padStart(2, '0')));
      const art = element('div', 'track-art'); art.setAttribute('aria-hidden', 'true'); setArtwork(art, track.artwork); row.appendChild(art);
      const copy = element('div', 'track-copy'); const title = element('span', 'track-title', track.title); title.title = track.title;
      if (track.explicit) { const explicit = element('span', 'explicit-mark', 'E'); explicit.setAttribute('aria-label', 'Explicit'); title.appendChild(explicit); }
      const titleButton = element('button', 'track-title-button'); titleButton.type = 'button'; titleButton.setAttribute('aria-label', 'Play ' + track.title + ' by ' + track.artist + ' on your Echo'); titleButton.appendChild(title); titleButton.addEventListener('click', function () { sendTrack(track); }); copy.appendChild(titleButton);
      const artistLine = element('div', 'artist-line'); artistLine.appendChild(element('span', 'track-artist', track.artist));
      if (safeUrl(track.url)) { const source = element('a', 'track-store', '↗'); const destination = state.resultsSource === 'apple-music' ? 'Apple Music' : state.resultsSource === 'spotify' ? 'Spotify' : 'iTunes Store'; source.href = safeUrl(track.url); source.target = '_blank'; source.rel = 'noopener noreferrer'; source.title = 'View in ' + destination; source.setAttribute('aria-label', 'View ' + track.title + ' in ' + destination); artistLine.appendChild(source); }
      copy.appendChild(artistLine); row.appendChild(copy);
      const album = element('span', 'track-album', track.album || ''); album.title = track.album || ''; row.appendChild(album);
      row.appendChild(element('span', 'track-duration', duration(track.durationMs)));
      const actions = element('div', 'track-actions'); const play = element('button', 'track-play'); play.type = 'button'; play.dataset.trackId = String(track.id); play.setAttribute('aria-label', 'Play ' + track.title + ' by ' + track.artist + ' on your Echo'); play.title = canPlayResult() ? 'Play on ' + selectedDevice().name : 'Connect your Echo to play'; play.disabled = !canPlayResult(); play.appendChild(playIcon()); play.addEventListener('click', function () { sendTrack(track); }); actions.appendChild(play); const generation = state.searchGeneration, country = state.resultsCountry; actions.appendChild(songMenu(track, function () { return { source: 'catalogue', trackId: track.id, country: country }; }, function () { return generation === state.searchGeneration && country === $('country-select').value && state.resultsCountry === country && state.tracks.includes(track) && !state.searching; })); row.appendChild(actions); list.appendChild(row);
      row.addEventListener('click', function (event) { if (!event.target.closest('button, a, details, summary')) sendTrack(track); });
    });
    if (query) list.setAttribute('aria-label', 'Results for ' + query);
    updatePlayButtons();
  }
  function updatePlayButtons() {
    renderSearchReadiness(); renderRequestMode();
    document.querySelectorAll('.track-play').forEach(function (button) {
      const busy = state.pendingTrack === button.dataset.trackId;
      button.disabled = !canPlayResult() || state.pendingTrack !== null;
      button.setAttribute('aria-busy', String(busy));
      button.title = canPlayResult() ? 'Play on ' + selectedDevice().name : 'Connect your Echo to play';
      const titleButton = button.closest('.track-row').querySelector('.track-title-button');
      if (titleButton) titleButton.disabled = !canPlayResult() || state.pendingTrack !== null;
    });
    if (state.tracks.length && !state.searching) $('results-status').textContent = !canPlay() ? 'Connect your Echo to play a song from these results.' : '';
    renderPlaylistActions(); renderQueue(); renderSongActionReadiness(); renderLocalReadiness();
  }
  function clearSearchResults(message) {
    state.tracks = []; state.resultsCountry = null; state.resultsSource = null;
    $('results-list').replaceChildren(); $('results-list').removeAttribute('aria-label'); $('results-count').textContent = '';
    $('results-title').textContent = catalogueHeading(); renderCatalogueSource();
    $('results-status').textContent = message || ''; $('empty-state').hidden = false;
    $('empty-state').querySelector('h3').textContent = 'Find music for ' + countryName($('country-select').value) + '.';
    $('empty-state').querySelector('p').textContent = activeCatalogueSource() === 'apple-music' ? 'Songs are checked in the selected Apple Music catalogue.' : 'Browse the selected country’s public catalogue. Alexa checks playback availability.';
  }
  function invalidateSearch(message) {
    ++state.searchGeneration;
    if (state.searchController) state.searchController.abort();
    state.searchController = null; state.searching = false;
    $('results-section').setAttribute('aria-busy', 'false'); clearSearchResults(message); renderSearchReadiness(); updatePlayButtons();
  }
  async function search(query) {
    const text = String(query || '').trim(); if (!text) { $('search-input').focus(); return; }
    if (state.searchController) state.searchController.abort();
    const controller = new AbortController(); state.searchController = controller;
    const generation = ++state.searchGeneration; const country = $('country-select').value;
    state.searching = true; clearSearchResults('Searching the catalogue for ' + countryName(country) + '…');
    $('empty-state').hidden = true; $('results-section').setAttribute('aria-busy', 'true'); renderSearchReadiness(); updatePlayButtons();
    const timeout = setTimeout(function () { controller.abort(); }, 20000);
    try {
      const response = await window.echoExtensionFetch('/api/search?q=' + encodeURIComponent(text) + '&country=' + encodeURIComponent(country), { signal: controller.signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.message || 'The catalogue could not be searched. Try again.');
      if (generation !== state.searchGeneration || $('country-select').value !== country) return;
      if (normalizeCountry(data.country) !== country || !['apple-music', 'spotify', 'itunes'].includes(data.source)) throw new Error('The catalogue could not return results for the selected country. Please search again.');
      state.tracks = Array.isArray(data.tracks) ? data.tracks : []; state.resultsCountry = country; state.resultsSource = data.source; state.searching = false; renderTracks(text);
    } catch (error) {
      if (generation !== state.searchGeneration || $('country-select').value !== country) return;
      clearSearchResults(error.name === 'AbortError' ? 'The catalogue took too long to respond. Please try again.' : error.message || 'Catalogue search is unavailable. Please try again.');
    } finally {
      clearTimeout(timeout);
      if (generation === state.searchGeneration) { state.searching = false; state.searchController = null; $('results-section').setAttribute('aria-busy', 'false'); renderSearchReadiness(); updatePlayButtons(); }
    }
  }
  async function sendTrack(track) {
    if (!canPlayResult() || state.pendingTrack !== null || !state.tracks.some(function (item) { return String(item.id) === String(track.id); })) return;
    const country = state.resultsCountry; const deviceId = state.deviceId; const deviceName = selectedDevice().name; const providerId = state.providerId; const provider = selectedProvider(); const requestMode = 'standard';
    state.pendingTrack = String(track.id); state.pendingSelection = { title: track.title, artist: track.artist, deviceId: deviceId, providerId: providerId, providerName: provider.name, requestMode: requestMode }; ++state.playbackEpoch;
    updatePlayButtons(); renderPlayback();
    const request = api('/api/play', { method: 'POST', body: JSON.stringify({ trackId: track.id, deviceId: deviceId, country: country, providerId: providerId, requestMode: requestMode }) });
    state.playSubmissionPromise = request;
    try {
      const data = await request; ++state.playbackEpoch;
      if (Object.prototype.hasOwnProperty.call(data, 'playback')) applyPlayback(data.playback, { fromSubmission: true, notify: false });
      if (deviceId === state.deviceId && !state.deviceChanging) toast(data.message || 'Request sent to ' + deviceName + '.');
      scheduleStatus(500);
    } catch (error) { toast(error.message, true); }
    finally {
      if (state.playSubmissionPromise === request) state.playSubmissionPromise = null;
      state.pendingTrack = null; state.pendingSelection = null; updatePlayButtons(); renderPlayback(); scheduleStatus(500);
    }
  }
  function validVolume(value) { return Number.isInteger(value) && value >= 0 && value <= 100; }
  function syncVolumeDevice() {
    const deviceId = canPlay() ? state.deviceId : '';
    if (state.volumeDeviceId === deviceId) return;
    state.volumeDeviceId = deviceId; state.volume = null; state.volumeDraft = null; state.volumeRequested = null;
    state.volumeEditing = false; state.volumeEditStart = null; state.volumeBusy = false; state.volumeStale = false; state.volumeError = '';
    ++state.volumeRevision; ++state.volumeWriteId;
  }
  function volumeAvailable() { return canPlay() && !state.deviceChanging && !state.volumeBusy; }
  function renderVolume() {
    syncVolumeDevice();
    const slider = $('volume-slider'); const value = state.volumeEditing && validVolume(state.volumeDraft) ? state.volumeDraft : validVolume(state.volumeRequested) ? state.volumeRequested : state.volume;
    slider.disabled = !volumeAvailable(); slider.value = validVolume(value) ? String(value) : '50';
    const phase = state.volumeBusy ? 'sending' : state.volumeEditing ? 'editing' : validVolume(state.volumeRequested) ? 'requested' : state.volumeStale ? 'stale' : validVolume(state.volume) ? 'reported' : 'unknown';
    $('player-volume').dataset.state = phase; slider.setAttribute('aria-busy', String(state.volumeBusy));
    $('volume-value').textContent = validVolume(value) ? value + '%' : '—';
    let description = !canPlay() ? 'Connect an Echo to adjust its volume.' : state.deviceChanging ? 'Waiting for the selected Echo.' : phase === 'sending' ? 'Setting Echo volume to ' + value + ' percent.' : phase === 'editing' ? 'Preview: ' + value + ' percent. Finish adjusting to send.' : phase === 'requested' ? 'Volume request accepted at ' + value + ' percent; waiting for Echo to report its volume.' : phase === 'stale' && validVolume(value) ? 'Last reported Echo volume: ' + value + ' percent. Current volume could not be refreshed.' : validVolume(value) ? 'Echo volume: ' + value + ' percent.' : 'Current Echo volume unknown. Choose a volume to set it.';
    if (state.volumeError) description = state.volumeError + (validVolume(state.volume) ? ' Last reported volume: ' + state.volume + ' percent.' : ' Current volume is unknown.');
    slider.setAttribute('aria-valuetext', description); slider.title = description; $('volume-value').title = description;
  }
  function beginVolumeEdit() {
    syncVolumeDevice(); if (!volumeAvailable()) return;
    state.volumeEditStart = Number($('volume-slider').value); state.volumeEditing = true; state.volumeDraft = state.volumeEditStart; state.volumeError = ''; ++state.volumeRevision; renderVolume();
  }
  function previewVolume() {
    syncVolumeDevice(); if (!volumeAvailable()) return;
    const value = Number($('volume-slider').value); if (!validVolume(value)) return;
    if (!state.volumeEditing) state.volumeEditStart = validVolume(state.volumeRequested) ? state.volumeRequested : validVolume(state.volume) ? state.volume : 50;
    state.volumeEditing = true; state.volumeDraft = value; state.volumeError = ''; ++state.volumeRevision; renderVolume();
  }
  function cancelVolumeEdit() {
    if (!state.volumeEditing || state.volumeBusy) return;
    state.volumeEditing = false; state.volumeDraft = null; state.volumeEditStart = null; ++state.volumeRevision; renderVolume();
  }
  function acceptVolumePoll(value, deviceId, revision) {
    if (deviceId !== state.deviceId || deviceId !== state.volumeDeviceId || revision !== state.volumeRevision || state.volumeEditing || state.volumeBusy || !canPlay()) return false;
    state.volume = validVolume(value) ? value : null; state.volumeRequested = null; state.volumeStale = false; state.volumeError = ''; renderVolume(); return true;
  }
  async function commitVolume() {
    syncVolumeDevice();
    if (!volumeAvailable()) { cancelVolumeEdit(); return; }
    const raw = $('volume-slider').value; const value = Number(raw);
    if (!String(raw).trim() || !validVolume(value)) { cancelVolumeEdit(); toast('Choose a volume from 0 to 100.', true); return; }
    if (value === state.volume && !state.volumeStale && state.volumeRequested === null) { cancelVolumeEdit(); return; }
    const deviceId = state.deviceId; const writeId = ++state.volumeWriteId; const slider = $('volume-slider');
    const restoreSliderFocus = document.activeElement === slider;
    state.volumeBusy = true; state.volumeEditing = false; state.volumeDraft = null; state.volumeEditStart = null; state.volumeRequested = value; state.volumeError = ''; ++state.volumeRevision; renderVolume();
    try {
      const result = await api('/api/volume', { method: 'POST', body: JSON.stringify({ deviceId: deviceId, volume: value }) });
      if (writeId !== state.volumeWriteId || deviceId !== state.deviceId || deviceId !== state.volumeDeviceId || !canPlay()) return;
      if (!validVolume(result.volume) || result.volume !== value) throw new Error('The Echo did not accept the requested volume.');
      state.volumeRequested = value; state.volumeStale = false;
    } catch (error) {
      if (writeId !== state.volumeWriteId || deviceId !== state.deviceId || deviceId !== state.volumeDeviceId) return;
      state.volumeRequested = null; state.volumeError = error.message; toast(error.message, true);
    } finally {
      if (writeId === state.volumeWriteId && deviceId === state.deviceId && deviceId === state.volumeDeviceId) {
        state.volumeBusy = false; ++state.volumeRevision; renderVolume();
        const focusStayedHere = document.activeElement === document.body || document.activeElement === slider;
        if (restoreSliderFocus && focusStayedHere && !document.hidden && !state.deviceChanging && !slider.disabled && (typeof document.hasFocus !== 'function' || document.hasFocus())) slider.focus({ preventScroll: true });
        setTimeout(refreshPlayer, 750);
      }
    }
  }
  function seekNow() { return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(); }
  function seekIdentity(player) {
    if (!player || typeof player.title !== 'string' || !player.title.trim() || typeof player.artist !== 'string' || !player.artist.trim() || !Number.isFinite(player.durationMs) || player.durationMs <= 0) return '';
    return JSON.stringify([player.mediaId || '', player.title, player.artist, player.durationMs, player.providerName || '']);
  }
  function seekContextKey(player, deviceId) { const identity = seekIdentity(player); return identity ? deviceId + '|' + identity : ''; }
  function syncSeekContext() {
    const key = canPlay() && (!state.player?.deviceId || state.player.deviceId === state.deviceId) ? seekContextKey(state.player, state.deviceId) : '';
    if (key === state.seekSongKey) return;
    state.seekSongKey = key; state.seekSnapshot = null; state.seekObservedAt = null; state.seekEditing = false; state.seekEditKey = ''; state.seekEditStart = null; state.seekDraft = null; state.seekRequested = null; state.seekBusy = false; state.seekChecking = false; state.seekUnverified = false; state.seekStale = false; state.seekError = ''; ++state.seekRevision; ++state.seekWriteId;
  }
  function validSeekPosition(value, duration) { return Number.isInteger(value) && value >= 0 && Number.isFinite(duration) && duration > 0 && value <= duration; }
  function seekMaximum(duration) { return Number.isFinite(duration) && duration > 0 ? Math.max(0, (Math.ceil(duration / 1000) - 1) * 1000) : 0; }
  function seekMetadataFresh() { return Number.isFinite(state.seekObservedAt) && seekNow() >= state.seekObservedAt && seekNow() - state.seekObservedAt <= 15000; }
  function seekPlaybackChanging() { return activePlayback() || state.pendingTrack !== null || !!state.playSubmissionPromise || !!state.queueSubmissionPromise || state.queueBusy || state.controlBusy || state.customCommandBusy || state.playlistBusy || state.providerChanging || (activeQueue() && state.queue.state === 'preparing'); }
  function seekAvailable() {
    const snapshot = state.seekSnapshot;
    return canPlay() && !state.deviceChanging && !seekPlaybackChanging() && !state.seekBusy && !state.seekStale && !state.playerStale && !!state.seekSongKey && !!snapshot && seekContextKey(snapshot, state.deviceId) === state.seekSongKey && ['PLAYING', 'PAUSED'].includes(state.player?.state) && ['PLAYING', 'PAUSED'].includes(snapshot.state) && validSeekPosition(snapshot.positionMs, snapshot.durationMs) && seekMetadataFresh();
  }
  function seekTime(value) { if (!Number.isFinite(value) || value < 0) return '—:—'; const seconds = Math.floor(value / 1000), minutes = Math.floor(seconds / 60); return minutes >= 60 ? Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') : minutes + ':' + String(seconds % 60).padStart(2, '0'); }
  function renderSeek() {
    syncSeekContext(); const slider = $('seek-slider'), snapshot = state.seekSnapshot;
    const duration = snapshot?.durationMs || state.player?.durationMs;
    const reported = snapshot && validSeekPosition(snapshot.positionMs, duration) ? snapshot.positionMs : null;
    const position = state.seekEditing && validSeekPosition(state.seekDraft, duration) ? state.seekDraft : validSeekPosition(state.seekRequested, duration) ? state.seekRequested : reported;
    slider.max = Number.isFinite(duration) && duration > 0 ? String(seekMaximum(duration)) : '1'; slider.value = validSeekPosition(position, duration) ? String(position) : '0'; slider.disabled = !seekAvailable(); slider.setAttribute('aria-busy', String(state.seekBusy));
    const available = seekAvailable(); const unknown = !Number.isFinite(duration) || duration <= 0 || reported === null;
    const phase = state.seekChecking ? 'verifying' : state.seekBusy ? 'sending' : state.seekEditing ? 'editing' : validSeekPosition(state.seekRequested, duration) ? 'requested' : state.seekUnverified ? 'unverified' : seekPlaybackChanging() ? 'checking' : unknown ? 'unknown' : !available ? 'stale' : 'reported';
    $('player-seek').dataset.state = phase; $('seek-elapsed').textContent = validSeekPosition(position, duration) ? seekTime(position) : '—:—'; $('seek-duration').textContent = Number.isFinite(duration) && duration > 0 ? seekTime(duration) : '—:—';
    $('seek-status').textContent = ({ sending: 'Seeking…', verifying: 'Checking', unverified: 'Unverified', editing: 'Preview', requested: 'Requested', checking: 'Updating song', unknown: 'Live / unknown', stale: 'Unavailable', reported: '' })[phase];
    let description = !canPlay() ? 'Connect an Echo to seek within a song.' : state.deviceChanging ? 'Waiting for the selected Echo.' : seekPlaybackChanging() ? 'Wait for the current playback request to finish before seeking.' : unknown ? 'Song position unavailable for live or unknown-length audio.' : phase === 'verifying' ? 'Seek request accepted. Checking two fresh position reports from Echo.' : phase === 'sending' ? 'Requesting ' + seekTime(position) + ' of ' + seekTime(duration) + '.' : phase === 'editing' ? 'Preview: ' + seekTime(position) + ' of ' + seekTime(duration) + '. Finish adjusting to send.' : phase === 'requested' ? 'Seek request accepted for ' + seekTime(position) + '. Waiting for Echo’s reported position.' : !['PLAYING', 'PAUSED'].includes(state.player?.state) ? 'Start playback to seek within the song.' : !available ? 'The current song position could not be refreshed.' : 'Reported song position: ' + seekTime(position) + ' of ' + seekTime(duration) + '.';
    if (state.seekError) description = state.seekError;
    slider.setAttribute('aria-valuetext', description); slider.title = description; $('seek-status').title = description;
  }
  function beginSeekEdit() {
    syncSeekContext(); if (!seekAvailable()) return;
    state.seekEditing = true; state.seekEditKey = state.seekSongKey; state.seekEditStart = Number($('seek-slider').value); state.seekDraft = state.seekEditStart; state.seekUnverified = false; state.seekError = ''; ++state.seekRevision; renderSeek();
  }
  function previewSeek() {
    syncSeekContext(); if (!seekAvailable()) return; const value = Number($('seek-slider').value);
    if (!validSeekPosition(value, state.seekSnapshot.durationMs)) return;
    if (!state.seekEditing) { state.seekEditKey = state.seekSongKey; state.seekEditStart = state.seekSnapshot.positionMs; }
    state.seekEditing = true; state.seekDraft = value; state.seekUnverified = false; state.seekError = ''; ++state.seekRevision; renderSeek();
  }
  function cancelSeekEdit() { if (!state.seekEditing || state.seekBusy) return; state.seekEditing = false; state.seekEditKey = ''; state.seekEditStart = null; state.seekDraft = null; ++state.seekRevision; renderSeek(); }
  function acceptSeekPoll(player, deviceId, revision) {
    if (deviceId !== state.deviceId || revision !== state.seekRevision || state.seekEditing || state.seekBusy || seekPlaybackChanging() || !canPlay()) return false;
    syncSeekContext();
    if (!player || seekContextKey(player, deviceId) !== state.seekSongKey) return false;
    state.seekSnapshot = { ...player }; state.seekObservedAt = seekNow(); state.seekRequested = null; state.seekStale = false; if (!state.seekUnverified) state.seekError = ''; renderSeek(); return true;
  }
  function seekRequestCurrent(writeId, deviceId, songKey) { return writeId === state.seekWriteId && deviceId === state.deviceId && songKey === state.seekSongKey && canPlay() && !state.deviceChanging && !seekPlaybackChanging(); }
  async function verifySeekReadback(result, deviceId, songKey, writeId) {
    const target = result.targetPositionMs ?? result.positionMs; const referenceAt = Number.isFinite(result.referenceAt) ? result.referenceAt : Date.now(); let matches = 0, lastReport = null;
    for (let index = 0; index < 6; index++) {
      await new Promise(function (resolve) { setTimeout(resolve, index ? 1200 : 1000); });
      if (!seekRequestCurrent(writeId, deviceId, songKey)) return false;
      let data; try { data = await api('/api/player?deviceId=' + encodeURIComponent(deviceId) + '&fresh=1'); } catch (_) { data = null; }
      if (!seekRequestCurrent(writeId, deviceId, songKey)) return false;
      const player = data?.player;
      if (player && (!player.deviceId || player.deviceId === deviceId) && seekIdentity(player) && seekContextKey(player, deviceId) !== songKey) {
        state.player = { ...player }; state.playerStale = false; syncSeekContext();
        state.seekSnapshot = { ...player }; state.seekObservedAt = seekNow(); state.seekUnverified = true;
        state.seekError = 'Playback changed before the requested position could be confirmed.';
        renderPlayer(); toast(state.seekError, true); return false;
      }
      if (!player || (player.deviceId && player.deviceId !== deviceId) || seekContextKey(player, deviceId) !== songKey || !['PLAYING', 'PAUSED'].includes(player.state) || !validSeekPosition(player.positionMs, player.durationMs)) { matches = 0; continue; }
      lastReport = { ...player };
      const elapsed = player.state === 'PLAYING' ? Math.max(0, Date.now() - referenceAt) : 0;
      const expectedPosition = Math.min(player.durationMs, target + elapsed);
      matches = Math.abs(player.positionMs - expectedPosition) <= 5000 ? matches + 1 : 0;
      if (matches >= 2) break;
    }
    if (!seekRequestCurrent(writeId, deviceId, songKey)) return false;
    state.seekRequested = null; state.seekChecking = false;
    if (lastReport) { state.seekSnapshot = lastReport; state.seekObservedAt = seekNow(); state.player = { ...lastReport }; state.playerStale = false; }
    if (matches === 2) { state.seekUnverified = false; state.seekStale = false; state.seekError = ''; renderPlayer(); return true; }
    state.seekUnverified = true; state.seekStale = !lastReport; state.seekError = 'Echo has not confirmed the requested position. No additional seek command was sent.'; toast(state.seekError, true); renderPlayer(); return false;
  }
  async function commitSeek() {
    syncSeekContext(); const slider = $('seek-slider');
    if (!seekAvailable() || !state.seekEditing || state.seekEditKey !== state.seekSongKey) { cancelSeekEdit(); return; }
    const snapshot = state.seekSnapshot, positionMs = Number(slider.value);
    if (!String(slider.value).trim() || (!validSeekPosition(positionMs, snapshot.durationMs) || positionMs > seekMaximum(snapshot.durationMs) || positionMs % 1000 !== 0)) { cancelSeekEdit(); toast('Choose a position within the current song.', true); return; }
    const expected = { title: snapshot.title, artist: snapshot.artist, durationMs: snapshot.durationMs };
    if (typeof snapshot.mediaId === 'string' && snapshot.mediaId) expected.mediaId = snapshot.mediaId;
    if (typeof snapshot.providerName === 'string' && snapshot.providerName) expected.providerName = snapshot.providerName;
    const deviceId = state.deviceId, songKey = state.seekSongKey, writeId = ++state.seekWriteId, restoreFocus = document.activeElement === slider;
    state.seekBusy = true; state.seekChecking = false; state.seekUnverified = false; state.seekEditing = false; state.seekEditKey = ''; state.seekDraft = null; state.seekRequested = positionMs; state.seekError = ''; ++state.seekRevision; renderSeek();
    try {
      const result = await api('/api/seek', { method: 'POST', body: JSON.stringify({ deviceId: deviceId, positionMs: positionMs, expected: expected }) });
      if (writeId !== state.seekWriteId || deviceId !== state.deviceId || songKey !== state.seekSongKey) return;
      const target = result.targetPositionMs ?? result.positionMs;
      if (!['sent', 'unchanged'].includes(result.status) || !validSeekPosition(target, snapshot.durationMs) || Math.abs(target - positionMs) > 1000) throw new Error('The Echo did not accept the requested song position.');
      state.seekRequested = target; state.seekChecking = true; renderSeek();
      await verifySeekReadback(result, deviceId, songKey, writeId);
    } catch (error) {
      if (writeId !== state.seekWriteId || deviceId !== state.deviceId || songKey !== state.seekSongKey) return;
      state.seekRequested = null; state.seekChecking = false; state.seekStale = true; state.seekError = error.message; toast(error.message, true);
    } finally {
      if (writeId === state.seekWriteId && deviceId === state.deviceId && songKey === state.seekSongKey) {
        state.seekBusy = false; state.seekChecking = false;
        if (state.seekRequested !== null && seekPlaybackChanging()) { state.seekRequested = null; state.seekUnverified = true; state.seekError = 'Playback changed before the requested position could be verified.'; }
        ++state.seekRevision; renderSeek();
        const focusStayedHere = document.activeElement === document.body || document.activeElement === slider;
        if (restoreFocus && focusStayedHere && !document.hidden && !slider.disabled && (typeof document.hasFocus !== 'function' || document.hasFocus())) slider.focus({ preventScroll: true });
        setTimeout(refreshPlayer, 750);
      }
    }
  }
  function renderPlayer() {
    const player = state.player; const available = canPlay();
    ['previous-button', 'toggle-button', 'next-button'].forEach(function (id) { $(id).disabled = !available || state.controlBusy || state.customCommandBusy || state.deviceChanging; });
    const playing = player && player.state === 'PLAYING';
    if (playing) { $('toggle-play-icon').setAttribute('hidden', ''); $('toggle-pause-icon').removeAttribute('hidden'); }
    else { $('toggle-play-icon').removeAttribute('hidden'); $('toggle-pause-icon').setAttribute('hidden', ''); }
    $('toggle-button').setAttribute('aria-label', playing ? 'Pause playback' : 'Resume playback');
    if (player && player.title) {
      $('player-state').textContent = state.playerStale ? 'LAST REPORTED · REFRESH UNAVAILABLE' : playing ? 'PLAYING ON YOUR ECHO' : player.state === 'PAUSED' ? 'PAUSED ON YOUR ECHO' : 'LAST REPORTED BY YOUR ECHO';
      $('player-title').textContent = player.title; $('player-artist').textContent = player.artist || player.album || ''; setArtwork($('player-art'), player.artwork);
      const actualProvider = typeof player.providerName === 'string' ? player.providerName.trim() : '';
      $('player-provider').hidden = false; $('player-provider').textContent = actualProvider ? 'Service: ' + actualProvider : 'Streaming service not reported'; $('player-provider').title = $('player-provider').textContent;
    } else {
      $('player-state').textContent = available ? 'READY WHEN YOU ARE' : 'YOUR MUSIC STARTS HERE';
      $('player-title').textContent = available ? 'Choose something you love' : 'Your Echo, your soundtrack';
      $('player-artist').textContent = available ? 'Select a song to send it to your Echo.' : 'Connect your Echo and choose a song.';
      setArtwork($('player-art'), ''); $('player-provider').hidden = true; $('player-provider').textContent = '';
    }
    renderVolume(); renderSeek(); renderPlayerSongActions();
  }
  async function refreshPlayer() {
    if (!canPlay() || state.playerBusy || state.deviceChanging || document.hidden) return;
    syncVolumeDevice(); syncSeekContext();
    const deviceId = state.deviceId; const seekRevision = state.seekRevision; const volumeRevision = state.volumeRevision; const coordinatorWasActive = activePlayback(); state.playerBusy = true;
    try {
      const data = await api('/api/player?deviceId=' + encodeURIComponent(deviceId));
      if (deviceId === state.deviceId && canPlay()) {
        if (!coordinatorWasActive && !seekPlaybackChanging() && seekRevision === state.seekRevision && !state.seekEditing && !state.seekBusy) { state.player = data.player || null; state.playerStale = false; }
        acceptVolumePoll(data.volume, deviceId, volumeRevision); acceptSeekPoll(data.player, deviceId, seekRevision); renderPlayer();
      }
    } catch (_) {
      if (deviceId === state.deviceId && canPlay()) {
        if (!coordinatorWasActive && !seekPlaybackChanging() && seekRevision === state.seekRevision && !state.seekEditing && !state.seekBusy) state.playerStale = true;
        if (volumeRevision === state.volumeRevision && !state.volumeEditing && !state.volumeBusy) state.volumeStale = true;
        if (seekRevision === state.seekRevision && !state.seekEditing && !state.seekBusy) state.seekStale = true;
        renderPlayer();
      }
    } finally {
      state.playerBusy = false;
      if (canPlay() && !state.deviceChanging && !state.volumeEditing && !state.volumeBusy && !state.seekEditing && !state.seekBusy && (deviceId !== state.deviceId || volumeRevision !== state.volumeRevision || seekRevision !== state.seekRevision)) setTimeout(refreshPlayer, 0);
    }
  }
  async function control(action) {
    if (!canPlay() || state.controlBusy || state.customCommandBusy || state.deviceChanging) return;
    const deviceId = state.deviceId; state.controlBusy = true; ++state.playbackEpoch;
    renderPlayer(); renderPlayback(); updatePlayButtons();
    try {
      if (state.playSubmissionPromise) { try { await state.playSubmissionPromise; } catch (_) {} }
      if (state.queueSubmissionPromise) { try { await state.queueSubmissionPromise; } catch (_) {} }
      const data = await api('/api/control', { method: 'POST', body: JSON.stringify({ deviceId: deviceId, action: action }) }); ++state.playbackEpoch;
      if (Object.prototype.hasOwnProperty.call(data, 'playback')) applyPlayback(data.playback, { notify: false });
      if (Object.prototype.hasOwnProperty.call(data, 'queue')) applyQueue(data.queue, { fromMutation: true });
      toast(data.message || 'Playback request sent.'); scheduleStatus(500); setTimeout(refreshPlayer, 1000);
    } catch (error) { toast(error.message, true); }
    finally { state.controlBusy = false; renderPlayer(); renderPlayback(); updatePlayButtons(); }
  }
  function setBrowseView(view) {
    state.view = view === 'playlists' ? 'playlists' : 'search'; const playlists = state.view === 'playlists';
    $('search-tab').setAttribute('aria-pressed', String(!playlists)); $('playlists-tab').setAttribute('aria-pressed', String(playlists));
    $('search-view-header').hidden = playlists; $('results-section').hidden = playlists; $('catalogue-footer').hidden = playlists; $('playlists-section').hidden = !playlists;
    renderPlaylistSources(); if (playlists && state.playlistsSource && !state.playlists.length && !state.playlistsLoading) loadPlaylists();
  }
  function selectionIsCurrent(current) { try { return !current || !!current(); } catch (_) { return false; } }
  function songMenu(track, selection, current) {
    const menu = element('details', 'song-menu'); const summary = element('summary', '', '•••'); summary.setAttribute('aria-label', 'Song actions for ' + (track.title || 'this song')); summary.title = 'Song actions'; menu.appendChild(summary);
    const choices = element('div', 'song-menu-choices');
    [['play', 'Play now'], ['last', 'Add to queue'], ['next', 'Play next'], ['save', 'Add to playlist']].forEach(function (action) {
      const button = element('button', '', action[1]); button.type = 'button'; button.dataset.songAction = action[0]; button.songSelection = selection; button.songCurrent = current;
      button.addEventListener('click', function () { if (!selectionIsCurrent(current)) { toast('This song changed. Choose it again.', true); return; } const value = selection(); menu.open = false; if (action[0] === 'save') openPlaylistDialog({ selection: value, title: track.title, artist: track.artist }); else if (action[0] === 'play') playSelection(value, track, current); else enqueueSelection(value, action[0], current); }); choices.appendChild(button);
    }); menu.appendChild(choices); menu.addEventListener('click', function (event) { event.stopPropagation(); }); menu.addEventListener('toggle', function () { if (menu.open) document.querySelectorAll('.song-menu[open]').forEach(function (other) { if (other !== menu) other.open = false; }); if (menu.open) positionQueueMenu(menu, choices); }); return menu;
  }
  function positionQueueMenu(menu, choices) {
    if (!menu.closest('#queue-items')) return;
    const anchor = menu.querySelector('summary').getBoundingClientRect(); const width = choices.offsetWidth || 180, height = choices.offsetHeight || 170;
    choices.style.left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)) + 'px';
    const below = anchor.bottom + 6; choices.style.top = Math.max(12, Math.min(below + height <= window.innerHeight - 12 ? below : anchor.top - height - 6, window.innerHeight - height - 12)) + 'px';
  }
  function closeQueueMenus() { $('queue-items').querySelectorAll('.song-menu[open]').forEach(function (menu) { menu.open = false; }); }
  function selectionInCountry(selection) { return !selection.country || normalizeCountry(selection.country) === $('country-select').value; }
  function renderSongActionReadiness() {
    document.querySelectorAll('[data-song-action]').forEach(function (button) {
      const current = selectionIsCurrent(button.songCurrent); let value = null; try { value = button.songSelection(); } catch (_) {}
      const inCountry = value && selectionInCountry(value); const action = button.dataset.songAction;
      button.disabled = !current || !value || (action === 'save' ? state.playlistDialogBusy : action === 'play' ? !canRequestSong() || songHandoffBusy() || !inCountry : !canQueueSong() || !inCountry);
      button.title = action !== 'save' && !inCountry ? 'Choose ' + countryName(value && value.country) + ' as the catalogue country first.' : '';
    });
  }
  async function playSelection(selection, track, current) {
    if (!canRequestSong() || songHandoffBusy() || !selectionInCountry(selection) || !selectionIsCurrent(current)) return;
    const deviceId = state.deviceId, deviceName = selectedDevice().name; const payload = { selection: selection, deviceId: deviceId, providerId: state.providerId, country: $('country-select').value, requestMode: 'standard' };
    state.pendingTrack = '__selection__'; state.pendingSelection = { title: track.title, artist: track.artist, deviceId: deviceId, providerId: state.providerId, providerName: selectedProvider().name, requestMode: payload.requestMode }; ++state.playbackEpoch; ++state.queueEpoch; updatePlayButtons(); renderPlayback();
    const request = api('/api/play-selection', { method: 'POST', body: JSON.stringify(payload) }); state.playSubmissionPromise = request;
    try { const result = await request; ++state.playbackEpoch; if (Object.prototype.hasOwnProperty.call(result, 'playback')) applyPlayback(result.playback, { fromSubmission: true, notify: false }); if (deviceId === state.deviceId) toast(result.message || 'Request sent to ' + deviceName + '.'); scheduleStatus(500); }
    catch (error) { toast(error.message, true); }
    finally { if (state.playSubmissionPromise === request) state.playSubmissionPromise = null; state.pendingTrack = null; state.pendingSelection = null; updatePlayButtons(); renderPlayback(); }
  }
  async function enqueueSelection(selection, placement, current) {
    if (!canQueueSong() || !selectionInCountry(selection) || !selectionIsCurrent(current)) return;
    const payload = { selection: selection, placement: placement, deviceId: canPlay() ? state.deviceId : null, providerId: state.providerId, country: $('country-select').value };
    if (activeQueue()) payload.queueId = state.queue.id;
    state.queueBusy = true; ++state.queueEpoch; updatePlayButtons();
    const request = api('/api/queue/items', { method: 'POST', body: JSON.stringify(payload) }); state.queueSubmissionPromise = request;
    try { const result = await request; ++state.queueEpoch; if (result.queue) applyQueue(result.queue, { fromMutation: true }); toggleQueue(true); toast(placement === 'next' ? 'Added to play next.' : 'Added to your queue.'); scheduleStatus(500); }
    catch (error) { toast(error.message, true); }
    finally { if (state.queueSubmissionPromise === request) state.queueSubmissionPromise = null; state.queueBusy = false; updatePlayButtons(); }
  }
  function renderPlayerSongActions() {
    const player = state.player; const key = player && ['PLAYING', 'PAUSED'].includes(player.state) && !state.playerStale && canPlay() && player.title && player.artist ? JSON.stringify([state.deviceId, player.title, player.artist, player.mediaId || '', $('country-select').value]) : '';
    if (key !== state.playerActionsKey) {
      state.playerActionsKey = key; const node = $('player-song-actions'); node.replaceChildren();
      if (key) { const deviceId = state.deviceId, country = $('country-select').value, expected = { title: player.title, artist: player.artist }; if (player.mediaId) expected.mediaId = player.mediaId;
        node.appendChild(songMenu(player, function () { return { source: 'player', deviceId: deviceId, country: country, expected: expected }; }, function () { const now = state.player; return canPlay() && !state.playerStale && state.deviceId === deviceId && now && ['PLAYING', 'PAUSED'].includes(now.state) && now.title === expected.title && now.artist === expected.artist && (!expected.mediaId || now.mediaId === expected.mediaId) && country === $('country-select').value; }));
      }
    }
    renderSongActionReadiness();
  }
  async function openLocalPlaylist(id) {
    const generation = ++state.localPlaylistGeneration; $('local-playlist-status').textContent = ''; state.playlistBusy = true; renderPlaylistActions();
    try { const result = await api('/api/local-playlists/' + encodeURIComponent(id)); if (generation !== state.localPlaylistGeneration) return; state.localPlaylist = result.playlist; state.playlistPreview = null; ++state.playlistPreviewGeneration; renderLocalPlaylist(); $('local-playlist-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    catch (error) { if (generation === state.localPlaylistGeneration) toast(error.message, true); }
    finally { state.playlistBusy = false; renderPlaylistActions(); }
  }
  function renderLocalImportNotice(playlist) {
    const imported = !!(playlist && (playlist.imported === true || Array.isArray(playlist.tracks) && playlist.tracks.some(function (track) { return track.imported === true || track.source === 'youtube-music'; })));
    $('local-playlist-import-note').hidden = !imported; $('local-playlist-import-note').textContent = imported ? 'Imported song details. Availability on your selected Echo service in ' + countryName(playlist.country) + ' is unverified.' : '';
  }
  function renderLocalPlaylist() {
    const playlist = state.localPlaylist, list = $('local-playlist-tracks'); renderLocalImportNotice(playlist); $('local-playlist-detail').hidden = !playlist; list.replaceChildren(); if (!playlist) return;
    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : []; $('local-playlist-title').textContent = playlist.name || playlist.title; $('local-playlist-meta').textContent = tracks.length + (tracks.length === 1 ? ' song' : ' songs') + ' · ' + (playlist.importedSource || playlist.importSource || playlist.origin && playlist.origin.source ? 'Imported from ' + playlistSourceName(playlist.importedSource || playlist.importSource || playlist.origin.source) : tracks.length && tracks.every(function (track) { return track.source === 'youtube-music'; }) ? 'Imported from YouTube Music' : 'Created here') + ' · ' + countryName(playlist.country);
    tracks.forEach(function (track, index) {
      const row = element('li', 'local-song-row'), art = element('div', 'track-art'); art.setAttribute('aria-hidden', 'true'); setArtwork(art, track.artwork); row.appendChild(art);
      const copy = element('div', 'song-list-copy'); copy.appendChild(element('strong', '', track.title)); copy.appendChild(element('span', '', track.artist)); if (track.album) copy.appendChild(element('span', 'song-list-album', track.album)); row.appendChild(copy);
      const selection = function () { return { source: 'local', playlistId: playlist.id, entryId: track.id, country: playlist.country }; }; const current = function () { return state.localPlaylist && state.localPlaylist.id === playlist.id && state.localPlaylist.tracks.some(function (entry) { return entry.id === track.id; }); };
      const actions = element('div', 'song-row-actions'); actions.appendChild(songMenu(track, selection, current));
      [['↑', 'Move song up', 'up'], ['↓', 'Move song down', 'down'], ['×', 'Remove from playlist', 'remove']].forEach(function (action) { const button = element('button', 'song-small-button', action[0]); button.type = 'button'; button.setAttribute('aria-label', action[1] + ': ' + track.title); button.dataset.localAction = '1'; button.dataset.edgeDisabled = String((action[2] === 'up' && index === 0) || (action[2] === 'down' && index === tracks.length - 1)); button.addEventListener('click', function () { mutateLocalTrack(playlist.id, track.id, action[2]); }); actions.appendChild(button); }); row.appendChild(actions); list.appendChild(row);
    }); if (!tracks.length) list.appendChild(element('li', 'queue-empty', 'This playlist is empty. Search for a song and choose Add to playlist.')); renderLocalReadiness(); renderSongActionReadiness();
  }
  function nativeLocalPlaylist(playlist) { return !!(playlist && playlist.origin && playlist.origin.source !== 'youtube-music' && playlist.origin.source === state.providerId && selectedProvider().kind === 'music'); }
  function renderLocalReadiness() {
    const playlist = state.localPlaylist, native = nativeLocalPlaylist(playlist); $('local-playlist-native-play').hidden = !native; $('local-playlist-native-play').disabled = !native || !canPlay() || songHandoffBusy() || normalizeCountry(playlist.country) !== $('country-select').value; $('local-playlist-play-note').hidden = !native; $('local-playlist-play-note').textContent = native ? 'Requests the original ' + playlistSourceName(playlist.origin.source) + ' playlist on your Echo. Your saved copy stays here.' : ''; $('local-playlist-play').disabled = !playlist || !playlist.tracks || !playlist.tracks.length || !canPlay() || songHandoffBusy() || normalizeCountry(playlist.country) !== $('country-select').value || selectedProvider().kind === 'radio';
    $('local-playlist-play').title = playlist && normalizeCountry(playlist.country) !== $('country-select').value ? 'Choose ' + countryName(playlist.country) + ' as the catalogue country first.' : '';
    $('local-playlist-rename').disabled = !playlist || state.localMutationBusy; $('local-playlist-delete').disabled = !playlist || state.localMutationBusy;
    document.querySelectorAll('[data-local-action]').forEach(function (button) { button.disabled = state.localMutationBusy || button.dataset.edgeDisabled === 'true'; });
  }
  async function mutateLocalTrack(playlistId, entryId, action) {
    if (state.localMutationBusy || !state.localPlaylist || state.localPlaylist.id !== playlistId || !state.localPlaylist.tracks.some(function (track) { return track.id === entryId; })) return;
    state.localMutationBusy = true; renderLocalReadiness();
    try { const result = await api('/api/local-playlists/' + encodeURIComponent(playlistId) + '/tracks/' + encodeURIComponent(entryId) + '/' + (action === 'remove' ? 'remove' : 'move'), { method: 'POST', body: JSON.stringify(action === 'remove' ? {} : { direction: action }) }); if (state.localPlaylist && state.localPlaylist.id === playlistId) { state.localPlaylist = result.playlist; renderLocalPlaylist(); } await refreshCreatedPlaylists(); }
    catch (error) { toast(error.message, true); }
    finally { state.localMutationBusy = false; renderLocalReadiness(); }
  }
  async function playLocalPlaylist() {
    const playlist = state.localPlaylist; if (!playlist || $('local-playlist-play').disabled || songHandoffBusy()) return;
    const payload = { deviceId: state.deviceId, providerId: state.providerId, country: $('country-select').value }; state.queueBusy = true; ++state.queueEpoch; ++state.playbackEpoch; updatePlayButtons();
    const request = api('/api/local-playlists/' + encodeURIComponent(playlist.id) + '/play', { method: 'POST', body: JSON.stringify(payload) }); state.queueSubmissionPromise = request;
    try { const result = await request; ++state.queueEpoch; if (result.queue) { applyQueue(result.queue, { fromMutation: true }); toggleQueue(true); } toast(result.message || 'Playlist request sent to your Echo.'); scheduleStatus(500); }
    catch (error) { toast(error.message, true); }
    finally { if (state.queueSubmissionPromise === request) state.queueSubmissionPromise = null; state.queueBusy = false; updatePlayButtons(); }
  }
  async function playLocalPlaylistNative() {
    const playlist = state.localPlaylist; if (!nativeLocalPlaylist(playlist) || !canPlay() || songHandoffBusy() || normalizeCountry(playlist.country) !== $('country-select').value) return;
    const payload = { deviceId: state.deviceId, providerId: state.providerId, country: $('country-select').value }; state.playlistBusy = true; ++state.playbackEpoch; ++state.queueEpoch; updatePlayButtons();
    try { const result = await api('/api/local-playlists/' + encodeURIComponent(playlist.id) + '/play-native', { method: 'POST', body: JSON.stringify(payload) }); toast(result.message || 'Original playlist request sent to your Echo.'); scheduleStatus(500); }
    catch (error) { toast(error.message, true); }
    finally { state.playlistBusy = false; updatePlayButtons(); }
  }
  async function deleteLocalPlaylist() {
    const playlist = state.localPlaylist; if (!playlist || state.localMutationBusy || !window.confirm('Delete “' + (playlist.name || playlist.title) + '” from this computer?')) return;
    state.localMutationBusy = true; renderLocalReadiness();
    try { await api('/api/local-playlists/' + encodeURIComponent(playlist.id) + '/delete', { method: 'POST', body: '{}' }); if (state.localPlaylist && state.localPlaylist.id === playlist.id) { ++state.localPlaylistGeneration; state.localPlaylist = null; renderLocalPlaylist(); } await refreshCreatedPlaylists(); toast('Playlist deleted.'); }
    catch (error) { toast(error.message, true); }
    finally { state.localMutationBusy = false; renderLocalReadiness(); }
  }
  async function refreshCreatedPlaylists() {
    if (['all', 'local'].includes(state.playlistsSource)) await loadPlaylists();
  }
  async function openPlaylistDialog(song, rename) {
    if (state.playlistDialogBusy) return; const generation = ++state.playlistDialogGeneration;
    state.playlistDialog = { song: song, rename: rename || null, playlists: [], created: null, loading: !!song }; $('playlist-save-target').replaceChildren(); const fresh = element('option', '', 'Create a new playlist'); fresh.value = ''; $('playlist-save-target').appendChild(fresh);
    $('playlist-save-name').value = rename ? rename.name || rename.title : ''; $('playlist-save-country').value = normalizeCountry(rename ? rename.country : song && song.selection.country || $('country-select').value);
    $('playlist-dialog-status').textContent = song ? 'Loading your created playlists…' : ''; renderPlaylistDialog(); if (!$('playlist-save-dialog').open) $('playlist-save-dialog').showModal();
    if (!song) { $('playlist-save-name').focus(); return; }
    try {
      const result = await api('/api/local-playlists'); if (generation !== state.playlistDialogGeneration || !state.playlistDialog) return;
      const country = $('playlist-save-country').value; const matches = (Array.isArray(result.playlists) ? result.playlists : []).filter(function (playlist) { return normalizeCountry(playlist.country) === country; }); state.playlistDialog.playlists = matches;
      matches.forEach(function (playlist) { const option = element('option', '', playlist.name || playlist.title); option.value = playlist.id; $('playlist-save-target').appendChild(option); }); if (matches.length) $('playlist-save-target').value = matches[0].id;
      state.playlistDialog.loading = false; $('playlist-dialog-status').textContent = matches.length ? '' : 'Create a playlist for ' + countryName(country) + ' to save this song.'; renderPlaylistDialog();
    } catch (error) { if (generation === state.playlistDialogGeneration && state.playlistDialog) { state.playlistDialog.loading = false; $('playlist-dialog-status').textContent = error.message; renderPlaylistDialog(); } }
  }
  function renderPlaylistDialog() {
    const dialog = state.playlistDialog; if (!dialog) return; const existing = !dialog.rename && !!$('playlist-save-target').value;
    $('playlist-dialog-title').textContent = dialog.rename ? 'Rename playlist' : dialog.song ? 'Add to playlist' : 'New playlist'; $('playlist-dialog-song').textContent = dialog.song ? dialog.song.title + (dialog.song.artist ? ' · ' + dialog.song.artist : '') : 'Created in Echo Library. No music account required.';
    $('playlist-existing-group').hidden = !dialog.song || !!dialog.rename; $('playlist-name-group').hidden = existing; $('playlist-country-group').hidden = !!dialog.rename || existing;
    $('playlist-save-country').disabled = !!dialog.song || state.playlistDialogBusy; $('playlist-save-name').disabled = state.playlistDialogBusy; $('playlist-save-target').disabled = state.playlistDialogBusy;
    $('playlist-save-name').required = !existing; $('playlist-save-submit').disabled = state.playlistDialogBusy || dialog.loading; $('playlist-dialog-close').disabled = state.playlistDialogBusy; $('playlist-save-submit').textContent = state.playlistDialogBusy ? 'Saving…' : dialog.song ? 'Add song' : 'Save playlist';
  }
  function closePlaylistDialog() { if (state.playlistDialogBusy) return; ++state.playlistDialogGeneration; state.playlistDialog = null; $('playlist-save-dialog').close(); }
  async function savePlaylistDialog(event) {
    event.preventDefault(); const dialog = state.playlistDialog; if (!dialog || state.playlistDialogBusy || dialog.loading) return;
    const target = $('playlist-save-target').value; const name = $('playlist-save-name').value.trim(); const country = $('playlist-save-country').value;
    if ((!target || dialog.rename) && (!name || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name))) { $('playlist-dialog-status').textContent = 'Enter a playlist name of 1–100 characters.'; return; }
    if (!countries.includes(country)) return; state.playlistDialogBusy = true; renderPlaylistDialog(); $('playlist-dialog-status').textContent = 'Saving…';
    try {
      let playlist;
      if (dialog.rename) { playlist = (await api('/api/local-playlists/' + encodeURIComponent(dialog.rename.id) + '/rename', { method: 'POST', body: JSON.stringify({ name: name }) })).playlist; }
      else {
        let id = target || dialog.created && dialog.created.id;
        if (!id) { dialog.created = (await api('/api/local-playlists', { method: 'POST', body: JSON.stringify({ name: name, country: country }) })).playlist; id = dialog.created.id; }
        if (dialog.song) playlist = (await api('/api/local-playlists/' + encodeURIComponent(id) + '/tracks', { method: 'POST', body: JSON.stringify({ selection: dialog.song.selection }) })).playlist;
        else playlist = dialog.created;
      }
      if (state.localPlaylist && playlist && state.localPlaylist.id === playlist.id) { state.localPlaylist = playlist; renderLocalPlaylist(); }
      const message = dialog.rename ? 'Playlist renamed.' : dialog.song ? 'Song added to your playlist.' : 'Playlist created.'; state.playlistDialogBusy = false; closePlaylistDialog(); await refreshCreatedPlaylists(); toast(message);
    } catch (error) { $('playlist-dialog-status').textContent = error.message; }
    finally { state.playlistDialogBusy = false; renderPlaylistDialog(); renderSongActionReadiness(); }
  }
  function importLineText(value) { return typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').trim() : ''; }
  function playlistImportSource(value) { return ['youtube-music', 'apple-music', 'spotify', 'amazon-music', 'jiosaavn', 'deezer', 'tidal', 'gaana', 'hungama'].includes(value) ? value : ''; }
  function playlistImportLinkSupported(source) { return ['youtube-music', 'spotify', 'apple-music', 'amazon-music', 'jiosaavn'].includes(source); }
  function renderPlaylistImportPlatforms(dialog) {
    const sources = ['youtube-music', 'spotify', 'apple-music', 'amazon-music', 'jiosaavn']; state.providers.forEach(function (provider) { if (provider.kind === 'music' && playlistImportSource(provider.id) && !sources.includes(provider.id)) sources.push(provider.id); });
    const fingerprint = sources.join('|'); if (dialog.platformOptionsFingerprint !== fingerprint) { dialog.platformOptionsFingerprint = fingerprint; const select = $('playlist-import-platform'); select.replaceChildren(); sources.forEach(function (source) { const option = element('option', '', playlistSourceName(source)); option.value = source; select.appendChild(option); }); } $('playlist-import-platform').value = dialog.platform;
  }
  function playlistImportPlatformFromUrl(value) {
    try {
      const url = new URL(String(value || '').trim()); if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
      if (['music.youtube.com', 'youtube.com', 'www.youtube.com'].includes(url.hostname) && /^\/playlist\/?$/.test(url.pathname) && /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('list') || '')) return 'youtube-music';
      if (url.hostname === 'open.spotify.com' && /^\/(?:intl-[a-z]{2}\/)?playlist\/[A-Za-z0-9]+\/?$/.test(url.pathname)) return 'spotify';
      if (url.hostname === 'music.apple.com' && /^\/[a-z]{2}\/playlist\/(?:[^/]+\/)?pl\.[A-Za-z0-9_-]{1,128}\/?$/i.test(url.pathname)) return 'apple-music';
      if (['jiosaavn.com', 'www.jiosaavn.com'].includes(url.hostname) && (/^\/featured\/[^/]+\/[^/]+\/?$/.test(url.pathname) || /^\/s\/playlist\/[^/]+\/[^/]+\/[^/]+\/?$/.test(url.pathname))) return 'jiosaavn';
      if (['music.amazon.in', 'music.amazon.com', 'music.amazon.co.uk', 'music.amazon.de', 'music.amazon.ca', 'music.amazon.com.au', 'music.amazon.co.jp'].includes(url.hostname) && /^\/(?:playlists|user-playlists)\/[A-Za-z0-9_-]{8,160}\/?$/.test(url.pathname)) return 'amazon-music';
    } catch (_) {} return '';
  }
  function setPlaylistImportPlatform(source, options) {
    const dialog = state.playlistImport; if (!dialog || dialog.saving || !playlistImportSource(source)) return;
    $('playlist-import-platform').value = source; if (dialog.platform === source) { renderPlaylistImport(); return; }
    const previous = dialog.platform; dialog.platform = source; dialog.previewTracks = []; dialog.preview = null; dialog.previewError = false; dialog.nativeNameEdited = false; $('playlist-import-native-name').value = ''; ++dialog.revision;
    $('playlist-import-status').textContent = (options && options.automatic ? 'Link detected: ' : 'Source changed to ') + playlistSourceName(source) + '. ' + ($('playlist-import-text').value.trim() ? 'Song text was kept; previous ' + playlistSourceName(previous) + ' preview metadata was cleared. These rows will be saved as ' + playlistSourceName(source) + ' details unless you load a new link.' : 'Load a link or paste song details.'); renderPlaylistImport();
  }
  function playlistImportPreviewId(dialog, country) {
    const preview = dialog && dialog.preview;
    if (!preview || dialog.platform !== preview.source || country !== preview.country || $('playlist-import-url').value.trim() !== preview.inputUrl || typeof preview.previewId !== 'string' || !preview.previewId || preview.previewId.length > 200 || /[\u0000-\u001f\u007f]/u.test(preview.previewId)) return null;
    return preview.previewId;
  }
  function parsePlaylistImport(text, previewTracks, country, source) {
    const selectedSource = source === undefined ? 'youtube-music' : playlistImportSource(source); if (!selectedSource) throw new Error('Choose a supported playlist platform.');
    const lines = String(text || '').split(/\r?\n/); const rows = [];
    lines.forEach(function (raw, index) { if (raw.trim()) rows.push({ raw: raw, number: index + 1 }); });
    if (!rows.length) throw new Error('Paste at least one song as Title — Artist.');
    if (rows.length > 500) throw new Error('A playlist can contain up to 500 songs. No songs were saved.');
    return rows.map(function (row, index) {
      const candidate = Array.isArray(previewTracks) ? previewTracks[index] : null; const original = candidate && (!candidate.source || candidate.source === selectedSource) ? candidate : null;
      let title, artist;
      if (original && row.raw.trim() === (original.title + ' — ' + original.artist).trim()) { title = original.title; artist = original.artist; }
      else { const split = row.raw.lastIndexOf(' — '); if (split < 0) throw new Error('Line ' + row.number + ': use Title — Artist with a spaced em dash.'); title = row.raw.slice(0, split).trim(); artist = row.raw.slice(split + 3).trim(); }
      if (!validQueueText(title) || !validQueueText(artist)) throw new Error('Line ' + row.number + ': add a title and artist of 1–250 characters each.');
      const track = original && title === original.title && artist === original.artist ? Object.assign({}, original) : { durationMs: 0 };
      delete track.needsReview; return Object.assign(track, { title: title, artist: artist, source: selectedSource, country: country });
    });
  }
  function openPlaylistImport() {
    ++state.playlistImportGeneration; state.playlistImport = { generation: state.playlistImportGeneration, revision: 0, previewTracks: [], preview: null, platform: 'youtube-music', nativeNameEdited: false, loading: false, saving: false, previewError: false };
    $('playlist-import-platform').value = 'youtube-music'; $('playlist-import-native-name').value = ''; $('playlist-import-name').value = ''; $('playlist-import-country').value = countries.includes($('country-select').value) ? $('country-select').value : 'IN'; $('playlist-import-url').value = ''; $('playlist-import-text').value = ''; $('playlist-import-status').textContent = '';
    renderPlaylistImport(); if (!$('playlist-import-dialog').open) $('playlist-import-dialog').showModal(); $('playlist-import-name').focus();
  }
  function closePlaylistImport() { ++state.playlistImportGeneration; state.playlistImport = null; $('playlist-import-dialog').close(); }
  function renderPlaylistImport() {
    const dialog = state.playlistImport; if (!dialog) return;
    renderPlaylistImportPlatforms(dialog); const sourceName = playlistSourceName(dialog.platform); $('playlist-import-source-note').textContent = 'Pasted songs will be saved as ' + sourceName + ' details. Availability on your selected Echo service is unverified.';
    $('playlist-import-link-note').textContent = 'Public ' + sourceName + ' links can be loaded when the service exposes their song details. Private or incomplete playlists may need pasted song details instead. No catalogue account connection is required.';
    $('playlist-import-native-group').hidden = dialog.platform === 'youtube-music'; $('playlist-import-native-label').textContent = 'Playlist name on ' + sourceName + ' (optional)';
    $('playlist-import-url').placeholder = dialog.platform === 'apple-music' ? 'https://music.apple.com/in/playlist/…/pl.…' : dialog.platform === 'spotify' ? 'https://open.spotify.com/playlist/…' : dialog.platform === 'amazon-music' ? 'https://music.amazon.in/playlists/…' : dialog.platform === 'jiosaavn' ? 'https://www.jiosaavn.com/featured/…/…' : 'https://music.youtube.com/playlist?list=…';
    const busy = dialog.saving; ['playlist-import-name', 'playlist-import-country', 'playlist-import-platform', 'playlist-import-url', 'playlist-import-text', 'playlist-import-native-name'].forEach(function (id) { $(id).disabled = busy; });
    $('playlist-import-load').disabled = busy || dialog.loading || !playlistImportLinkSupported(dialog.platform) || !$('playlist-import-url').value.trim(); $('playlist-import-load').textContent = dialog.loading ? 'Loading…' : 'Load songs';
    $('playlist-import-save').disabled = busy || dialog.loading || !!state.playlistImportSavePending; $('playlist-import-save').textContent = busy ? 'Saving…' : 'Save to Created';
    let review = 'Paste songs, or load a playlist link, then review the details.';
    if ($('playlist-import-text').value.trim()) { try { const tracks = parsePlaylistImport($('playlist-import-text').value, dialog.previewTracks, $('playlist-import-country').value, dialog.platform); review = tracks.length + (tracks.length === 1 ? ' song ready to import.' : ' songs ready to import.'); } catch (error) { review = error.message; } }
    if (state.playlistImportSavePending && !busy) review = 'A previous import is still finishing. You can review this list while it completes.';
    $('playlist-import-review').textContent = review;
  }
  function editPlaylistImport(event) { if (!state.playlistImport) return; ++state.playlistImport.revision; if (state.playlistImport.previewError) { state.playlistImport.previewError = false; $('playlist-import-status').textContent = ''; } if (event && event.target && ['playlist-import-url', 'playlist-import-country'].includes(event.target.id) && state.playlistImport.preview) state.playlistImport.preview.previewId = null; if (event && event.target && event.target.id === 'playlist-import-url') { const source = playlistImportPlatformFromUrl($('playlist-import-url').value); if (source && source !== state.playlistImport.platform) setPlaylistImportPlatform(source, { automatic: true }); } renderPlaylistImport(); }
  async function loadPlaylistImport() {
    const dialog = state.playlistImport; if (!dialog || dialog.loading || dialog.saving) return;
    const url = $('playlist-import-url').value.trim(), country = $('playlist-import-country').value; if (!url || !countries.includes(country)) return;
    const detectedSource = playlistImportPlatformFromUrl(url); if (detectedSource && detectedSource !== dialog.platform) setPlaylistImportPlatform(detectedSource, { automatic: true });
    if (!playlistImportLinkSupported(dialog.platform)) { $('playlist-import-status').textContent = 'Paste song details for this service; its playlist links are not supported yet.'; renderPlaylistImport(); return; }
    const source = dialog.platform, generation = dialog.generation, revision = dialog.revision; dialog.loading = true; dialog.previewError = false; $('playlist-import-status').textContent = 'Loading song details…'; renderPlaylistImport();
    try {
      const result = await api('/api/playlist-import/preview', { method: 'POST', body: JSON.stringify({ url: url, country: country }) });
      if (state.playlistImport !== dialog || generation !== state.playlistImportGeneration) return;
      if (source !== dialog.platform || revision !== dialog.revision || url !== $('playlist-import-url').value.trim() || country !== $('playlist-import-country').value) { $('playlist-import-status').textContent = 'Your edits were kept because the list changed while the link was loading. Load again to replace them.'; return; }
      const tracks = Array.isArray(result.tracks) ? result.tracks : []; if (tracks.length > 500) throw new Error('This preview contains more than 500 songs. Paste a list of up to 500 songs instead.');
      const actualSource = result.source === undefined ? source : playlistImportSource(result.source); if (!actualSource) throw new Error('The preview returned an unsupported music platform.'); dialog.platform = actualSource; $('playlist-import-platform').value = actualSource;
      if (!dialog.nativeNameEdited && actualSource !== 'youtube-music') $('playlist-import-native-name').value = importLineText(result.name).slice(0, 250);
      dialog.previewTracks = tracks.map(function (track) { return Object.assign({}, track, { title: importLineText(track.title), artist: importLineText(track.artist), source: actualSource }); });
      $('playlist-import-text').value = dialog.previewTracks.map(function (track) { return track.title + ' — ' + track.artist; }).join('\n');
      if (!$('playlist-import-name').value.trim()) $('playlist-import-name').value = importLineText(result.name).slice(0, 100);
      const skipped = Number.isInteger(result.skipped) && result.skipped >= 0 ? result.skipped : 0; const total = Number.isInteger(result.total) && result.total >= tracks.length + skipped ? result.total : null; const partial = result.truncated === true || result.fullCountUnverified === true || total === null || total > tracks.length + skipped;
      dialog.preview = { previewId: typeof result.previewId === 'string' ? result.previewId : null, source: actualSource, name: importLineText(result.name), url: typeof result.url === 'string' ? result.url : url, inputUrl: url, country: country, total: total, truncated: partial, fullCountUnverified: result.fullCountUnverified === true || total === null, skipped: skipped, text: $('playlist-import-text').value };
      const missing = dialog.previewTracks.filter(function (track) { return !validQueueText(track.title) || !validQueueText(track.artist); }).length, review = dialog.previewTracks.filter(function (track) { return track.needsReview; }).length;
      const notes = Array.isArray(result.notes) ? result.notes.filter(function (note) { return typeof note === 'string'; }).join(' ') : typeof result.notes === 'string' ? result.notes : '';
      const loaded = total === null ? 'Loaded ' + tracks.length + ' visible entries. Full playlist count could not be verified; this may be a partial list.' : 'Loaded ' + tracks.length + ' of ' + total + ' entries.' + (partial ? ' This preview may be partial.' : '');
      $('playlist-import-status').textContent = loaded + ' ' + skipped + ' skipped by the source. ' + missing + ' need a title or artist.' + (review ? ' ' + review + ' marked for review.' : '') + (notes ? ' ' + notes : '') + ' Loaded from ' + playlistSourceName(actualSource) + '. Review the list before saving; paste any missing songs.';
    } catch (error) { if (state.playlistImport === dialog && generation === state.playlistImportGeneration) { dialog.previewError = true; $('playlist-import-status').textContent = error.message + ' You can still paste song details below.'; } }
    finally { if (state.playlistImport === dialog && generation === state.playlistImportGeneration) { dialog.loading = false; renderPlaylistImport(); } }
  }
  async function savePlaylistImport(event) {
    event.preventDefault(); const dialog = state.playlistImport; if (!dialog || dialog.saving || dialog.loading || state.playlistImportSavePending) return;
    const name = $('playlist-import-name').value.trim(), country = $('playlist-import-country').value;
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) { $('playlist-import-status').textContent = 'Enter a playlist name of 1–100 characters.'; return; }
    if (!countries.includes(country)) return; let tracks;
    try { tracks = parsePlaylistImport($('playlist-import-text').value, dialog.previewTracks, country, dialog.platform); } catch (error) { $('playlist-import-status').textContent = error.message; return; }
    const generation = dialog.generation, payload = { name: name, country: country, tracks: tracks }; const previewId = playlistImportPreviewId(dialog, country); if (previewId) payload.previewId = previewId; const nativeName = $('playlist-import-native-name').value.trim(); if (dialog.nativeNameEdited && dialog.platform !== 'youtube-music' && nativeName) { if (!validQueueText(nativeName)) { $('playlist-import-status').textContent = 'Enter an original playlist name of 1–250 characters.'; return; } payload.nativeName = nativeName; } dialog.saving = true; const pending = api('/api/local-playlists/import', { method: 'POST', body: JSON.stringify(payload) }); state.playlistImportSavePending = pending;
    $('playlist-import-status').textContent = 'Saving all ' + tracks.length + ' songs…'; renderPlaylistImport();
    try {
      const result = await pending; if (state.playlistImport !== dialog || generation !== state.playlistImportGeneration) return;
      const playlist = result.playlist; if (!playlist || !playlist.id) throw new Error('The app did not return the saved playlist. Check Created before importing again.');
      closePlaylistImport(); const completedGeneration = state.playlistImportGeneration; state.playlistsSource = 'local'; state.playlistSourceSaved = true; try { localStorage.setItem('echo-library-playlist-source', 'local'); } catch (_) {} $('playlist-source').value = 'local'; setBrowseView('playlists'); await loadPlaylists();
      if (state.playlistImportGeneration !== completedGeneration || state.playlistImport) return;
      await openLocalPlaylist(playlist.id); if (state.playlistImportGeneration !== completedGeneration || state.playlistImport) return; toast('Imported ' + tracks.length + ' songs into ' + (playlist.name || name) + '. Nothing was played.');
    } catch (error) { if (state.playlistImport === dialog && generation === state.playlistImportGeneration) $('playlist-import-status').textContent = error.message; }
    finally { if (state.playlistImportSavePending === pending) state.playlistImportSavePending = null; if (state.playlistImport === dialog) dialog.saving = false; renderPlaylistImport(); }
  }
  function playlistSourceName(source) { return ({ local: 'Created', 'apple-music': 'Apple Music', spotify: 'Spotify', 'youtube-music': 'YouTube Music', all: 'All' })[source] || providerName(source); }
  function renderPlaylistSources() {
    state.playlistsSource = 'local';
    const select = $('playlist-source');
    if (select.options.length !== 1 || select.options[0].value !== 'local') { select.replaceChildren(); const option = element('option', '', 'Created & imported'); option.value = 'local'; select.appendChild(option); }
    select.value = 'local'; select.disabled = true;
    $('playlist-connect-note').hidden = false;
    $('playlists-refresh').disabled = state.playlistsLoading || state.playlistBusy;
    $('new-playlist-button').disabled = state.localMutationBusy;
    $('playlist-service-note').textContent = 'Created here or imported from a link, saved on this computer. Songs play through the streaming service selected for your Echo.';
    renderPlaylistActions();
  }
  async function loadPlaylists() {
    const generation = ++state.playlistGeneration;
    state.playlistsLoading = true; renderPlaylistSources(); $('playlist-status').textContent = 'Loading your playlists…';
    try {
      const data = await api('/api/local-playlists'); if (generation !== state.playlistGeneration) return;
      state.playlists = (Array.isArray(data.playlists) ? data.playlists : []).map(function (playlist) { return Object.assign({}, playlist, { source: 'local' }); });
      renderPlaylistCards(); $('playlist-status').textContent = state.playlists.length ? '' : 'No playlists yet. Create one or import a playlist link.';
    } catch (error) { if (generation === state.playlistGeneration) $('playlist-status').textContent = error.message || 'Playlists could not be loaded.'; }
    finally { if (generation === state.playlistGeneration) { state.playlistsLoading = false; renderPlaylistSources(); } }
  }
  function playlistStillListed(playlist) { return state.playlists.some(function (item) { return item.source === playlist.source && item.id === playlist.id; }); }
  function renderPlaylistCards() {
    const grid = $('playlist-grid'); grid.replaceChildren();
    state.playlists.forEach(function (playlist) {
      const card = element('article', 'playlist-card'); const artwork = element('div', 'playlist-art'); setArtwork(artwork, playlist.artwork); card.appendChild(artwork);
      const source = playlist.importedSource || playlist.importSource || playlist.origin && playlist.origin.source;
      card.appendChild(element('span', 'playlist-source-badge', (source ? 'Imported · ' + playlistSourceName(source) : 'Created here') + ' · ' + countryName(playlist.country)));
      card.appendChild(element('h2', '', playlist.title || playlist.name || 'Untitled playlist'));
      card.appendChild(element('p', '', Number.isFinite(playlist.itemCount) ? playlist.itemCount + (playlist.itemCount === 1 ? ' song' : ' songs') : 'Playlist'));
      const button = element('button', '', 'Open playlist ↗'); button.type = 'button'; button.dataset.playlistAction = 'preview';
      button.addEventListener('click', function () { if (playlistStillListed(playlist)) openLocalPlaylist(playlist.id); }); card.appendChild(button);
      if (safeUrl(playlist.url)) { const link = element('a', '', 'Open original playlist ↗'); link.href = safeUrl(playlist.url); link.target = '_blank'; link.rel = 'noopener noreferrer'; card.appendChild(link); }
      grid.appendChild(card);
    }); renderPlaylistActions();
  }
  function songHandoffBusy() { return activePlayback() || state.pendingTrack !== null || !!state.playSubmissionPromise || state.queueBusy || state.playlistBusy || state.customCommandBusy || state.controlBusy || state.cancelBusy || state.deviceChanging || state.providerChanging; }
  function canQueueSong() { return !songHandoffBusy() && !state.providersLoading && selectedProvider().kind !== 'radio'; }
  function renderPlaylistActions() {
    document.querySelectorAll('[data-playlist-action]').forEach(function (button) { button.disabled = state.playlistBusy || state.localMutationBusy || (button.dataset.playlistAction === 'play' && (!canPlay() || songHandoffBusy())); });
    renderLocalReadiness(); renderSongActionReadiness();
  }
  function validQueueText(value) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 250 && !/[\u0000-\u001f\u007f]/u.test(value); }
  function queueReady() { return !!(state.queue && state.queue.active && state.queue.state === 'ready'); }
  function activeQueue() { return !!(state.queue && state.queue.active); }
  function applyQueue(queue, options) {
    const opts = options || {}; if (!opts.fromMutation && ((opts.queueEpoch !== undefined && opts.queueEpoch !== state.queueEpoch) || state.queueBusy)) return;
    if (queue && state.queue && queue.id === state.queue.id && !state.queue.active && queue.active && !opts.fromMutation) return;
    state.queue = queue || null;
    if (queue && (queue.active || opts.fromMutation)) state.queueObserved.add(queue.id);
    if (queue && !queue.active) {
      if (!state.queueObserved.has(queue.id)) state.queueDismissed.add(queue.id);
      else if (!state.queueDismissed.has(queue.id) && !state.queueDismissTimers.has(queue.id)) state.queueDismissTimers.set(queue.id, setTimeout(function () { state.queueDismissed.add(queue.id); state.queueDismissTimers.delete(queue.id); renderQueue(); }, queue.state === 'error' ? 9000 : 6000));
    }
    renderQueue(); renderSearchReadiness();
  }
  function toggleQueue(open) { toggleSidebar('queue', open); }
  function renderQueue() {
    const queue = state.queue, items = queue && Array.isArray(queue.items) ? queue.items : [];
    $('player-queue-button').setAttribute('aria-expanded', String(state.queueOpen)); $('player-queue-button').textContent = 'Queue' + (items.filter(function (item) { return item.state === 'pending'; }).length ? ' · ' + items.filter(function (item) { return item.state === 'pending'; }).length : '');
    $('queue-progress').hidden = !state.queueOpen;
    $('queue-title').textContent = queue ? queue.title || 'Your song queue' : 'Your song queue';
    const mismatch = queueReady() && (normalizeCountry(queue.country) !== $('country-select').value || queue.providerId !== state.providerId);
    const track = queue && queue.currentTrack; $('queue-track').textContent = track ? 'Current · ' + track.title + (track.artist ? ' · ' + track.artist : '') : '';
    $('queue-message').textContent = queue ? queue.message || ({ ready: 'Ready when you are. Select an Echo, then choose Start.', preparing: 'Preparing your playlist…', playing: 'Playing songs on your Echo.', paused: 'Queue paused.', needs_attention: 'The queue needs your attention.', completed: 'Queue completed.', cancelled: 'Automatic queue playback stopped.', error: 'The queue could not continue.' }[queue.state] || '') : 'Add a song from search or a playlist. Music already playing stays on your Echo.';
    if (mismatch) $('queue-message').textContent = 'Select ' + countryName(queue.country) + ' and ' + (queue.providerName || providerName(queue.providerId)) + ' to start this saved queue.';
    $('queue-provider').textContent = queue ? (queue.providerName ? 'Next songs: ' + queue.providerName + '. ' : '') + (queue.country ? 'Catalogue: ' + countryName(queue.country) + '. ' : '') + (queue.currentProviderName ? 'Current song service: ' + queue.currentProviderName + '.' : 'Reported playback appears in the player.') : '';
    const paused = queue && ['paused', 'needs_attention'].includes(queue.state), ready = queueReady(); $('queue-toggle').textContent = ready ? 'Start' : paused ? 'Resume' : 'Pause'; $('queue-toggle').dataset.action = ready ? 'start' : paused ? 'resume' : 'pause';
    ['queue-toggle', 'queue-next', 'queue-cancel'].forEach(function (id) { $(id).hidden = !queue || !queue.active; $(id).disabled = state.queueBusy || state.pendingTrack !== null || state.deviceChanging || state.providerChanging; });
    $('queue-toggle').disabled = $('queue-toggle').disabled || (ready && (!canPlay() || selectedProvider().kind === 'radio' || mismatch)); $('queue-next').hidden = !queue || !queue.active || ready;
    const fingerprint = JSON.stringify([queue && queue.id, items]);
    if (fingerprint !== state.queueItemsFingerprint) {
      state.queueItemsFingerprint = fingerprint; const list = $('queue-items'); list.replaceChildren();
      items.filter(function (item) { return item.state !== 'played'; }).forEach(function (item) {
        const row = element('li', 'queue-item'); const copy = element('div', 'song-list-copy'); copy.appendChild(element('span', 'song-list-state', item.state === 'current' ? 'CURRENT' : 'UP NEXT')); copy.appendChild(element('strong', '', item.title)); copy.appendChild(element('span', '', item.artist || 'Artist not supplied')); row.appendChild(copy);
        const queueId = queue.id; const current = function () { return state.queue && state.queue.id === queueId && (state.queue.items || []).some(function (entry) { return entry.id === item.id; }); };
        const actions = element('div', 'song-row-actions'); actions.appendChild(songMenu(item, function () { return { source: 'queue', queueId: queueId, itemId: item.id, country: queue.country }; }, current));
        if (item.state === 'pending') {
          [['↑', 'Move song up', -1], ['↓', 'Move song down', 1], ['×', 'Remove from queue', 0]].forEach(function (action) { const button = element('button', 'song-small-button', action[0]); button.type = 'button'; button.setAttribute('aria-label', action[1] + ': ' + item.title); button.dataset.queueItemAction = '1'; button.addEventListener('click', function () { editQueueItem(queueId, item.id, action[2]); }); actions.appendChild(button); });
        }
        row.appendChild(actions); list.appendChild(row);
      });
      if (!items.some(function (item) { return item.state !== 'played'; })) list.appendChild(element('li', 'queue-empty', 'Your queue is empty.'));
    }
    document.querySelectorAll('[data-queue-item-action]').forEach(function (button) { button.disabled = state.queueBusy || songHandoffBusy(); }); renderSongActionReadiness();
  }
  async function queueControl(action) {
    if (!activeQueue() || state.queueBusy || state.pendingTrack !== null || state.deviceChanging || state.providerChanging) return;
    if (action === 'start' && (!canPlay() || selectedProvider().kind === 'radio' || !queueReady() || normalizeCountry(state.queue.country) !== $('country-select').value || state.queue.providerId !== state.providerId)) return;
    const requestId = state.queue.id; const payload = { action: action, requestId: requestId };
    if (action === 'start') Object.assign(payload, { deviceId: state.deviceId, providerId: state.providerId, country: $('country-select').value });
    state.queueBusy = true; ++state.queueEpoch; ++state.playbackEpoch; renderQueue(); updatePlayButtons();
    try { const result = await api('/api/queue/control', { method: 'POST', body: JSON.stringify(payload) }); ++state.queueEpoch; if (Object.prototype.hasOwnProperty.call(result, 'queue')) applyQueue(result.queue, { fromMutation: true }); if (action === 'clear') toast('Queue cleared. Current music is left playing.'); scheduleStatus(500); }
    catch (error) { toast(error.message, true); }
    finally { state.queueBusy = false; renderQueue(); updatePlayButtons(); }
  }
  async function editQueueItem(queueId, itemId, direction) {
    if (!canQueueSong() || !state.queue || state.queue.id !== queueId) return;
    const pending = (state.queue.items || []).filter(function (item) { return item.state === 'pending'; }); const index = pending.findIndex(function (item) { return item.id === itemId; }); if (index < 0) return;
    let route = 'remove', payload = { queueId: queueId };
    if (direction) { const target = index + direction; if (target < 0 || target >= pending.length) return; route = 'move'; payload.beforeItemId = direction < 0 ? pending[target].id : pending[target + 1] ? pending[target + 1].id : null; }
    state.queueBusy = true; ++state.queueEpoch; updatePlayButtons();
    try { const result = await api('/api/queue/items/' + encodeURIComponent(itemId) + '/' + route, { method: 'POST', body: JSON.stringify(payload) }); ++state.queueEpoch; if (result.queue) applyQueue(result.queue, { fromMutation: true }); scheduleStatus(500); }
    catch (error) { toast(error.message, true); }
    finally { state.queueBusy = false; updatePlayButtons(); }
  }
  function renderCustomCommand() {
    const device = selectedDevice(); const available = canPlay() && !state.deviceChanging;
    $('custom-command-input').disabled = !available;
    $('custom-command-submit').disabled = !available || state.customCommandBusy || !$('custom-command-input').value.trim();
    $('custom-command-submit').textContent = state.customCommandBusy ? 'Sending…' : 'Send ↗';
    $('custom-command-device').textContent = available ? 'To ' + device.name : 'Connect an Echo to send a command.';
  }
  function commandTime(value) {
    const time = jobTime(value); if (!time) return { text: 'Time unavailable', iso: '' };
    const date = new Date(time); return { text: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), iso: date.toISOString() };
  }
  function commandSection(title, text, className) {
    const section = element('section', 'command-entry-section' + (className ? ' ' + className : ''));
    section.appendChild(element('h4', '', title)); section.appendChild(element('p', '', text)); return section;
  }
  function renderCommands() {
    const list = $('commands-list'); const scroller = $('commands-history');
    const previousTop = scroller.scrollTop || 0; const previousHeight = scroller.scrollHeight || 0;
    list.replaceChildren(); $('commands-empty').hidden = state.commands.length > 0;
    state.commands.forEach(function (command) {
      const row = element('article', 'command-entry');
      const kind = ['music', 'control', 'custom'].includes(command.kind) ? command.kind : 'custom';
      const status = ['sending', 'sent', 'failed'].includes(command.status) ? command.status : 'sending'; row.dataset.status = status;
      const header = element('div', 'command-entry-header'); header.appendChild(element('span', 'command-entry-kind', kind.toUpperCase()));
      const time = commandTime(command.createdAt); const timestamp = element('time', 'command-entry-time', time.text); if (time.iso) timestamp.setAttribute('datetime', time.iso); header.appendChild(timestamp); row.appendChild(header);
      row.appendChild(element('p', 'command-entry-text', typeof command.text === 'string' ? command.text : 'Command text unavailable.'));
      row.appendChild(element('p', 'command-entry-device', (typeof command.deviceName === 'string' && command.deviceName ? command.deviceName : 'Echo') + ' · ' + ({ sending: 'Sending request', sent: 'Request sent', failed: 'Request failed' }[status])));
      const acknowledgment = typeof command.message === 'string' && command.message ? command.message : status === 'sent' ? 'The request was submitted. This does not establish Alexa’s spoken response.' : status === 'failed' ? 'The request could not be submitted.' : 'The request is being submitted.';
      row.appendChild(commandSection('Request status', acknowledgment));
      let responseText;
      if (command.responseStatus === 'available' && typeof command.response === 'string' && command.response.trim()) responseText = command.response;
      else if (command.responseStatus === 'pending') responseText = 'No response text yet.';
      else if (command.responseStatus === 'ambiguous') responseText = 'A response could not be reliably linked to this command.';
      else responseText = 'Alexa did not provide a readable response for this command.';
      row.appendChild(commandSection('Alexa response', responseText, 'command-response'));
      if (command.observation && typeof command.observation === 'object') {
        const observed = command.observation;
        const details = [typeof observed.state === 'string' ? observed.state : '', typeof observed.title === 'string' ? observed.title : '', typeof observed.artist === 'string' ? observed.artist : '', typeof observed.providerName === 'string' ? observed.providerName : ''].filter(Boolean).join(' · ');
        row.appendChild(commandSection('Echo playback observation', details || 'Playback metadata was unavailable.'));
      }
      list.appendChild(row);
    });
    if (previousTop > 20) scroller.scrollTop = Math.max(0, previousTop + (scroller.scrollHeight || 0) - previousHeight);
  }
  async function refreshCommands() {
    if (!state.commandsOpen || document.hidden || state.commandsController) return;
    const generation = state.commandsGeneration; const controller = new AbortController(); state.commandsController = controller;
    if (!state.commands.length) $('commands-status').textContent = 'Loading commands…';
    const timeout = setTimeout(function () { controller.abort(); }, 20000);
    try {
      const response = await window.echoExtensionFetch('/api/commands', { signal: controller.signal });
      const data = await response.json(); if (!response.ok) throw new Error('Command history is unavailable.');
      if (!state.commandsOpen || generation !== state.commandsGeneration) return;
      const commands = Array.isArray(data.commands) ? data.commands.filter(function (command) { return command && typeof command === 'object'; }).slice(0, 100) : [];
      const fingerprint = JSON.stringify(commands);
      if (fingerprint !== state.commandsFingerprint) { state.commands = commands; state.commandsFingerprint = fingerprint; renderCommands(); }
      $('commands-status').textContent = '';
    } catch (_) { if (state.commandsOpen && generation === state.commandsGeneration && !controller.signal.aborted) $('commands-status').textContent = state.commands.length ? 'History could not refresh. Showing the last loaded requests.' : 'Command history is unavailable. Close and reopen the panel to try again.'; }
    finally {
      clearTimeout(timeout); if (state.commandsController === controller) state.commandsController = null;
      if (state.commandsOpen && !document.hidden && generation === state.commandsGeneration) { clearTimeout(state.commandsTimer); state.commandsTimer = setTimeout(refreshCommands, 2000); }
    }
  }
  function updateCommandsModality() {
    const wasModal = state.sidebarModal; const modal = state.sidebarOpen && window.matchMedia('(max-width: 1180px)').matches;
    state.sidebarModal = modal; state.commandsModal = modal && state.commandsOpen;
    $('right-sidebar').setAttribute('aria-modal', String(modal)); $('commands-backdrop').hidden = !modal;
    document.body.classList.toggle('sidebar-open', state.sidebarOpen); document.body.classList.toggle('commands-open', state.commandsOpen); document.body.classList.toggle('sidebar-modal', modal);
    [document.querySelector('.app-shell'), document.querySelector('.player-bar')].forEach(function (surface) { if (!surface) return; if (modal) surface.setAttribute('inert', ''); else surface.removeAttribute('inert'); });
    if (modal && !wasModal && !$('playlist-save-dialog').open && !$('playlist-import-dialog').open && !$('right-sidebar').contains(document.activeElement)) $(state.sidebarTab + '-sidebar-tab').focus({ preventScroll: true });
  }
  function stopCommandsPolling() {
    ++state.commandsGeneration; clearTimeout(state.commandsTimer); state.commandsTimer = null;
    if (state.commandsController) { state.commandsController.abort(); state.commandsController = null; }
  }
  function renderSidebar() {
    const wasCommandsOpen = state.commandsOpen;
    state.commandsOpen = state.sidebarOpen && state.sidebarTab === 'commands'; state.queueOpen = state.sidebarOpen && state.sidebarTab === 'queue';
    $('right-sidebar').hidden = !state.sidebarOpen; $('commands-drawer').hidden = !state.commandsOpen; $('queue-progress').hidden = !state.queueOpen;
    $('commands-toggle').setAttribute('aria-expanded', String(state.commandsOpen)); $('player-queue-button').setAttribute('aria-expanded', String(state.queueOpen));
    $('commands-title').textContent = state.sidebarTab === 'queue' ? 'Queue' : 'Commands';
    ['commands', 'queue'].forEach(function (tab) { const selected = state.sidebarTab === tab; const button = $(tab + '-sidebar-tab'); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
    if (!state.queueOpen) closeQueueMenus(); updateCommandsModality(); renderQueue();
    if (wasCommandsOpen !== state.commandsOpen) { stopCommandsPolling(); if (state.commandsOpen) { renderCustomCommand(); refreshCommands(); } }
  }
  function selectSidebarTab(tab, options) {
    if (!['commands', 'queue'].includes(tab)) return;
    const unchanged = state.sidebarOpen && state.sidebarTab === tab;
    if (!state.sidebarOpen) state.sidebarPreviousFocus = document.activeElement;
    state.sidebarOpen = true; state.sidebarTab = tab; renderSidebar();
    if (!unchanged && (!options || options.focus !== false)) $(tab + '-sidebar-tab').focus();
  }
  function closeSidebar() {
    if (!state.sidebarOpen) return; const previous = state.sidebarPreviousFocus;
    state.sidebarOpen = false; renderSidebar();
    const fallback = state.sidebarTab === 'queue' ? $('player-queue-button') : $('commands-toggle');
    const target = previous && previous !== document.body && previous !== document.documentElement && previous.isConnected !== false && !previous.disabled && !previous.hidden && (!previous.getClientRects || previous.getClientRects().length > 0) && typeof previous.focus === 'function' ? previous : fallback;
    target.focus({ preventScroll: true });
  }
  function toggleSidebar(tab, open) {
    const shouldOpen = open === undefined ? !(state.sidebarOpen && state.sidebarTab === tab) : !!open;
    if (shouldOpen) selectSidebarTab(tab); else closeSidebar();
  }
  function toggleCommands(open) { toggleSidebar('commands', open); }
  function sidebarTabsKeydown(event) {
    const tabs = ['commands', 'queue']; let index = tabs.indexOf(state.sidebarTab);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault(); selectSidebarTab(tabs[index], { focus: false }); $(tabs[index] + '-sidebar-tab').focus();
  }
  function commandsKeydown(event) {
    if (event.defaultPrevented || $('playlist-save-dialog').open || $('playlist-import-dialog').open) return;
    if (event.key === 'Escape') {
      if (state.sidebarOpen) { event.preventDefault(); closeSidebar(); return; }
      const menu = document.querySelector('.song-menu[open]');
      if (menu) { event.preventDefault(); menu.open = false; menu.querySelector('summary').focus(); } return;
    }
    if (!state.sidebarOpen || event.key !== 'Tab' || !state.sidebarModal) return;
    const controls = Array.from($('right-sidebar').querySelectorAll('button:not([disabled]),input:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])')).filter(function (control) { return !control.hidden && control.getClientRects().length > 0 && control.tabIndex !== -1; });
    if (!controls.length) { event.preventDefault(); $('right-sidebar').focus(); return; }
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  async function sendCustomCommand(event) {
    event.preventDefault();
    const text = $('custom-command-input').value.trim();
    if (!text || text.length > 500 || /[\u0000-\u001f\u007f]/u.test(text)) { toast('Enter one line of 1 to 500 characters.', true); return; }
    if (!canPlay() || state.customCommandBusy || state.deviceChanging) return;
    const deviceId = state.deviceId; const deviceName = selectedDevice().name; state.customCommandBusy = true; ++state.playbackEpoch;
    renderCustomCommand(); updatePlayButtons(); renderPlayer();
    try {
      if (state.playSubmissionPromise) { try { await state.playSubmissionPromise; } catch (_) {} }
      if (state.queueSubmissionPromise) { try { await state.queueSubmissionPromise; } catch (_) {} }
      const result = await api('/api/command', { method: 'POST', body: JSON.stringify({ deviceId: deviceId, text: text }) }); ++state.playbackEpoch;
      if ($('custom-command-input').value.trim() === text) $('custom-command-input').value = '';
      toast(result.message || 'Command sent to ' + deviceName + '.'); scheduleStatus(500); setTimeout(refreshPlayer, 1000);
      if (state.commandsOpen) { clearTimeout(state.commandsTimer); refreshCommands(); }
    } catch (error) { toast(error.message, true); }
    finally { state.customCommandBusy = false; renderCustomCommand(); updatePlayButtons(); renderPlayer(); }
  }
  async function changeDevice() {
    const deviceId = $('device-select').value; const generation = ++state.deviceChangeGeneration;
    state.deviceChanging = true; state.deviceId = deviceId; state.player = null; state.playerStale = false; saveDevice();
    renderDevices(); renderCustomCommand(); updatePlayButtons(); renderPlayer(); renderPlayback();
    const requestId = activeQueue() ? state.queue.id : state.playback && state.playback.id;
    try { if (!queueReady() || activePlayback()) await cancelPlayback({ silent: true, requestId: requestId }); }
    catch (_) { if (generation === state.deviceChangeGeneration) toast('Could not confirm cancellation of the previous retries. Check the connection before choosing another song.', true); }
    finally {
      if (generation === state.deviceChangeGeneration) { state.deviceChanging = false; renderDevices(); renderCustomCommand(); updatePlayButtons(); renderPlayer(); renderPlayback(); refreshPlayer(); scheduleStatus(500); }
    }
  }
  $('search-tab').addEventListener('click', function () { setBrowseView('search'); }); $('playlists-tab').addEventListener('click', function () { setBrowseView('playlists'); });
  $('playlist-source').addEventListener('change', function () { state.playlistsSource = $('playlist-source').value; state.playlistSourceSaved = true; try { localStorage.setItem('echo-library-playlist-source', state.playlistsSource); } catch (_) {} ++state.playlistPreviewGeneration; state.playlistPreview = null; if (!['all', 'local'].includes(state.playlistsSource)) { ++state.localPlaylistGeneration; state.localPlaylist = null; renderLocalPlaylist(); } loadPlaylists(); }); $('playlists-refresh').addEventListener('click', loadPlaylists);
  $('queue-toggle').addEventListener('click', function () { queueControl($('queue-toggle').dataset.action); }); $('queue-next').addEventListener('click', function () { queueControl('next'); }); $('queue-cancel').addEventListener('click', function () { queueControl('clear'); });
  $('player-queue-button').addEventListener('click', function () { toggleQueue(); });
  $('new-playlist-button').addEventListener('click', function () { openPlaylistDialog(null); });
  $('import-playlist-button').addEventListener('click', openPlaylistImport); $('playlist-import-close').addEventListener('click', closePlaylistImport);
  $('playlist-import-platform').addEventListener('change', function () { setPlaylistImportPlatform($('playlist-import-platform').value); });
  $('playlist-import-native-name').addEventListener('input', function () { if (state.playlistImport) state.playlistImport.nativeNameEdited = true; });
  $('playlist-import-load').addEventListener('click', loadPlaylistImport); $('playlist-import-form').addEventListener('submit', savePlaylistImport);
  ['playlist-import-text', 'playlist-import-country', 'playlist-import-url'].forEach(function (id) { $(id).addEventListener('input', editPlaylistImport); });
  $('playlist-import-dialog').addEventListener('cancel', function (event) { event.preventDefault(); closePlaylistImport(); });
  $('local-playlist-close').addEventListener('click', function () { ++state.localPlaylistGeneration; state.localPlaylist = null; renderLocalPlaylist(); });
  $('local-playlist-play').addEventListener('click', function () { playLocalPlaylist(); });
  $('local-playlist-native-play').addEventListener('click', playLocalPlaylistNative);
  $('local-playlist-rename').addEventListener('click', function () { if (state.localPlaylist) openPlaylistDialog(null, state.localPlaylist); });
  $('local-playlist-delete').addEventListener('click', deleteLocalPlaylist);
  $('playlist-save-form').addEventListener('submit', savePlaylistDialog); $('playlist-save-target').addEventListener('change', renderPlaylistDialog);
  $('playlist-dialog-close').addEventListener('click', closePlaylistDialog); $('playlist-save-dialog').addEventListener('cancel', function (event) { if (state.playlistDialogBusy) event.preventDefault(); else { ++state.playlistDialogGeneration; state.playlistDialog = null; } });
  $('commands-toggle').addEventListener('click', function () { toggleCommands(); });
  $('commands-close').addEventListener('click', closeSidebar);
  $('commands-backdrop').addEventListener('click', closeSidebar);
  ['commands', 'queue'].forEach(function (tab) { $(tab + '-sidebar-tab').addEventListener('click', function () { selectSidebarTab(tab); }); $(tab + '-sidebar-tab').addEventListener('keydown', sidebarTabsKeydown); });
  $('custom-command-form').addEventListener('submit', sendCustomCommand);
  $('custom-command-input').addEventListener('input', renderCustomCommand);
  document.addEventListener('keydown', commandsKeydown);
  $('queue-items').addEventListener('scroll', closeQueueMenus);
  window.addEventListener('resize', function () { closeQueueMenus(); if (state.sidebarOpen) updateCommandsModality(); });
  $('cancel-retries-button').addEventListener('click', function () { cancelPlayback().catch(function () {}); });
  $('country-select').addEventListener('change', function () { state.country = $('country-select').value; try { localStorage.setItem('echo-library-country', state.country); } catch (_) {} invalidateSearch(''); const query = $('search-input').value.trim(); if (query) search(query); });
  $('connect-form').addEventListener('submit', async function (event) {
    event.preventDefault(); $('connect-button').disabled = true;
    try { applyStatus(await api('/api/connect', { method: 'POST', body: JSON.stringify({ region: $('region-select').value, locale: $('locale-select').value }) })); }
    catch (error) { toast(error.message, true); }
    finally { renderConnection(); scheduleStatus(2500); }
  });
  $('disconnect-button').addEventListener('click', async function () {
    $('disconnect-button').disabled = true;
    try { await cancelPlayback({ silent: true }); applyStatus(await api('/api/disconnect', { method: 'POST', body: '{}' })); toast('Amazon connection removed from this app.'); }
    catch (error) { toast(error.message, true); }
    finally { $('disconnect-button').disabled = false; }
  });
  $('region-select').addEventListener('change', function () { $('locale-select').value = defaults[$('region-select').value] || 'en-US'; });
  $('device-select').addEventListener('change', changeDevice);
  $('provider-select').addEventListener('change', changeProvider);
  $('search-form').addEventListener('submit', function (event) { event.preventDefault(); search($('search-input').value); });
  document.querySelectorAll('[data-query]').forEach(function (button) { button.addEventListener('click', function () { $('search-input').value = button.dataset.query; search(button.dataset.query); }); });
  $('seek-slider').addEventListener('pointerdown', beginSeekEdit);
  $('seek-slider').addEventListener('input', previewSeek);
  $('seek-slider').addEventListener('change', commitSeek);
  $('seek-slider').addEventListener('pointerup', function () { if (state.seekEditing && Number($('seek-slider').value) === state.seekEditStart) cancelSeekEdit(); });
  $('seek-slider').addEventListener('pointercancel', cancelSeekEdit);
  $('seek-slider').addEventListener('blur', cancelSeekEdit);
  $('volume-slider').addEventListener('pointerdown', beginVolumeEdit);
  $('volume-slider').addEventListener('input', previewVolume);
  $('volume-slider').addEventListener('change', commitVolume);
  $('volume-slider').addEventListener('pointerup', function () { if (state.volumeEditing && Number($('volume-slider').value) === state.volumeEditStart) cancelVolumeEdit(); });
  $('volume-slider').addEventListener('pointercancel', cancelVolumeEdit);
  $('volume-slider').addEventListener('blur', cancelVolumeEdit);
  $('previous-button').addEventListener('click', function () { control('previous'); });
  $('next-button').addEventListener('click', function () { control('next'); });
  $('toggle-button').addEventListener('click', function () { control(state.player && state.player.state === 'PLAYING' ? 'pause' : 'resume'); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { refreshStatus(); refreshPlayer(); if (state.commandsOpen) refreshCommands(); } else { clearTimeout(state.commandsTimer); if (state.commandsController) state.commandsController.abort(); } });
  let extensionConnectionBusy = false;
  async function extensionMessage(message) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Open Echo Companion from the browser extension toolbar.');
    const result = await chrome.runtime.sendMessage(message);
    if (!result || result.ok === false) throw new Error(result?.message || 'The extension could not complete that request.');
    return result;
  }
  async function refreshExtensionConnection() {
    if (extensionConnectionBusy) return;
    extensionConnectionBusy = true;
    try {
      const connection = await extensionMessage({ type: 'GET_CONNECTION' });
      const ready = connection.paired && connection.helperAvailable;
      $('extension-pairing-status').textContent = connection.message || (ready ? 'Local helper connected.' : connection.paired ? 'Start the local helper to use Echo Companion.' : 'Pair this extension with the local helper.');
      $('extension-pairing-form').hidden = !!ready;
      $('extension-pairing').open = !ready;
    } catch (error) { $('extension-pairing-status').textContent = error.message; $('extension-pairing').open = true; }
    finally { extensionConnectionBusy = false; }
  }
  async function saveExtensionPairing(event) {
    event.preventDefault(); const button = $('extension-pairing-save'), input = $('extension-pairing-code');
    const token = input.value.trim();
    if (!/^[A-Za-z0-9_-]{32,150}$/.test(token)) { $('extension-pairing-status').textContent = 'Paste the pairing code shown by the local helper.'; return; }
    button.disabled = true;
    try { await extensionMessage({ type: 'SET_PAIR_TOKEN', token: token }); input.value = ''; await refreshExtensionConnection(); await refreshStatus(); refreshProviders(); toast('Connected to the local helper.'); }
    catch (error) { $('extension-pairing-status').textContent = error.message; }
    finally { button.disabled = false; }
  }
  $('extension-pairing-form').addEventListener('submit', saveExtensionPairing);
  $('extension-open-helper').addEventListener('click', async function () { try { await extensionMessage({ type: 'OPEN_HELPER' }); } catch (error) { $('extension-pairing-status').textContent = error.message; } });
  $('extension-helper-retry').addEventListener('click', async function () { await refreshExtensionConnection(); await refreshStatus(); refreshProviders(); });
  try { $('extension-version').textContent = 'Echo Companion ' + chrome.runtime.getManifest().version; } catch (_) {}
  refreshExtensionConnection();
  renderProviders(); renderCatalogueSource(); renderSearchReadiness(); renderPlayback(); renderVolume(); renderSeek(); renderCustomCommand(); renderPlaylistSources(); renderQueue(); toggleCommands(true); refreshStatus(); refreshProviders(); setInterval(refreshPlayer, 5000); setInterval(renderSeek, 1000);
}());
