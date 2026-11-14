"use strict";
(function () {
  const $ = function (id) { return document.getElementById(id); };
  const defaults = { IN: 'en-IN', US: 'en-US', UK: 'en-GB', DE: 'de-DE', CA: 'en-CA', AU: 'en-AU', JP: 'ja-JP' };
  const countries = ['IN', 'US', 'GB', 'DE', 'CA', 'AU', 'JP'];
  const fallbackProviders = [{ id: 'alexa-default', name: 'Alexa default', kind: 'default', reportedByAlexa: false }, { id: 'apple-music', name: 'Apple Music', kind: 'music', reportedByAlexa: false }, { id: 'amazon-music', name: 'Amazon Music', kind: 'music', reportedByAlexa: false }, { id: 'spotify', name: 'Spotify', kind: 'music', reportedByAlexa: false }, { id: 'jiosaavn', name: 'JioSaavn', kind: 'music', reportedByAlexa: false }];
  const providerExploreUrls = Object.freeze({ 'amazon-music': 'https://music.amazon.in/', spotify: 'https://open.spotify.com/', jiosaavn: 'https://www.jiosaavn.com/', tunein: 'https://tunein.com/', deezer: 'https://www.deezer.com/', pandora: 'https://www.pandora.com/', iheartradio: 'https://www.iheart.com/', siriusxm: 'https://www.siriusxm.com/', tidal: 'https://tidal.com/', gaana: 'https://gaana.com/', hungama: 'https://www.hungama.com/' });
  function normalizeCountry(value) { const country = String(value || '').toUpperCase(); return country === 'UK' ? 'GB' : country; }
  function countryName(code) { const option = Array.from($('country-select').options).find(function (item) { return item.value === normalizeCountry(code); }); return option ? option.textContent : String(code || '').toUpperCase(); }
  const state = { seekSongKey: '', seekSnapshot: null, seekObservedAt: null, seekEditing: false, seekEditKey: '', seekEditStart: null, seekDraft: null, seekRequested: null, seekBusy: false, seekChecking: false, seekUnverified: false, seekStale: false, seekError: '', seekRevision: 0, seekWriteId: 0, volume: null, volumeDeviceId: '', volumeDraft: null, volumeRequested: null, volumeEditing: false, volumeEditStart: null, volumeBusy: false, volumeStale: false, volumeError: '', volumeRevision: 0, volumeWriteId: 0, cataloguePlatform: 'apple-music', cataloguePlatformSaved: false, spotify: { configured: false, connected: false, needsSetup: true }, youtube: { configured: false, connected: false, needsSetup: true }, catalogueSource: null, oauthPopups: { spotify: null, youtube: null }, oauthBusy: { spotify: false, youtube: false }, oauthSetupBusy: { spotify: false, youtube: false }, view: 'search', playlists: [], playlistsSource: 'local', playlistSourceSaved: false, localPlaylist: null, localPlaylistGeneration: 0, localMutationBusy: false, playlistDialog: null, playlistDialogGeneration: 0, playlistDialogBusy: false, playlistImport: null, playlistImportGeneration: 0, playlistImportSavePending: null, sidebarOpen: false, sidebarTab: 'commands', sidebarModal: false, sidebarPreviousFocus: null, queueOpen: false, queueItemsFingerprint: '', playerActionsKey: '', playlistsLoading: false, playlistGeneration: 0, playlistAccountsFingerprint: null, playlistBusy: false, playlistPreview: null, playlistPreviewGeneration: 0, queue: null, queueBusy: false, queueModeBusy: false, queueModeWriteId: 0, shuffle: false, repeatAll: false, queueSubmissionPromise: null, queueEpoch: 0, queueObserved: new Set(), queueDismissed: new Set(), queueDismissTimers: new Map(), commandsOpen: false, commandsModal: false, commands: [], commandsFingerprint: '', commandsTimer: null, commandsController: null, commandsGeneration: 0, commandsPreviousFocus: null, customCommandBusy: false, providers: fallbackProviders.slice(), providerId: 'apple-music', requestMode: 'standard', providerSaved: false, providersLoading: false, providersPromise: null, providersDiscovery: 'unavailable', providersMessage: '', providerChanging: false, providerChangeGeneration: 0, apple: { configured: false, connected: false, needsSetup: true, message: 'MusicKit app setup is needed before searching Apple Music.' }, appleKit: null, appleTokenExpiresAt: 0, applePreparing: false, applePreparePromise: null, applePrepareError: '', appleBusy: false, appleSetupBusy: false, country: 'IN', resultsCountry: null, resultsSource: null, musicKitScriptPromise: null, connection: { state: 'disconnected' }, settings: {}, devices: [], tracks: [], deviceId: '', player: null, playerStale: false, pendingTrack: null, pendingSelection: null, playSubmissionPromise: null, playback: null, playbackEpoch: 0, playbackNotified: new Set(), playbackObserved: new Set(), playbackDismissed: new Set(), playbackDismissTimers: new Map(), cancelBusy: false, cancelPromise: null, controlBusy: false, deviceChanging: false, deviceChangeGeneration: 0, initialized: false, statusBusy: false, playerBusy: false, searching: false, searchController: null, searchGeneration: 0, searchTimer: null, searchComposing: false, searchRequestKey: '', searchCompletedKey: '', playlistSourceCache: new Map(), playlistSync: null, playlistSyncGeneration: 0, playlistArtworkCache: new Map(), playlistArtworkRevision: 0, playlistArtworkActive: 0, playlistArtworkWaiters: [], statusTimer: null, toastTimer: null };
  try { state.deviceId = localStorage.getItem('echo-library-device') || ''; const savedCountry = normalizeCountry(localStorage.getItem('echo-library-country')); if (countries.includes(savedCountry)) state.country = savedCountry; } catch (_) {}
  try { const savedProvider = localStorage.getItem('echo-library-provider'); if (typeof savedProvider === 'string' && savedProvider.length > 0 && savedProvider.length <= 150 && !/[\u0000-\u001f\u007f]/u.test(savedProvider)) { state.providerId = savedProvider; state.providerSaved = true; } } catch (_) {}
  try { const platform = localStorage.getItem('echo-library-catalogue-platform'); if (['apple-music', 'spotify', 'youtube-music'].includes(platform)) { state.cataloguePlatform = platform; state.cataloguePlatformSaved = true; } } catch (_) {}
  try { const source = localStorage.getItem('echo-library-playlist-source'); if (['all', 'local', 'apple-music', 'spotify', 'youtube-music'].includes(source)) { state.playlistsSource = source; state.playlistSourceSaved = true; } } catch (_) {}
  try { state.shuffle = localStorage.getItem('echo-library-shuffle') === 'true'; state.repeatAll = localStorage.getItem('echo-library-repeat-all') === 'true'; } catch (_) {}
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
      const response = await fetch(path, requestOptions);
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
    if (data.apple) applyAppleStatus(data.apple);
    if (data.spotify) applyOAuthStatus('spotify', data.spotify);
    if (data.youtube) applyOAuthStatus('youtube', data.youtube);
    if (data.catalogue && ['apple-music', 'spotify', 'itunes'].includes(data.catalogue.source)) {
      state.catalogueSource = data.catalogue.source;
      if (previousCatalogue !== state.catalogueSource) { invalidateSearch(''); const query = $('search-input').value.trim(); if (query) search(query); }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'queue')) applyQueue(data.queue, options || {});
    syncCataloguePlatformDefault(); renderPlaylistSources(); renderAccountBadge();
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
  function canRequestSong() { state.requestMode = 'standard'; return canPlay() && !state.queueModeBusy; }
  function requestModeName(mode) { return mode === 'music-request-test' ? 'Music request test' : 'Current method'; }
  function renderRequestMode() { state.requestMode = 'standard'; }
  function renderProviders() {
    const select = $('provider-select'); select.replaceChildren();
    state.providers.forEach(function (provider) { const option = element('option', '', provider.name + (provider.kind === 'radio' ? ' · radio' : '')); option.value = provider.id; select.appendChild(option); });
    if (!state.providers.some(function (provider) { return provider.id === state.providerId; })) { const saved = element('option', '', 'Previously selected service'); saved.value = state.providerId; select.appendChild(saved); }
    select.value = state.providerId; select.disabled = state.providerChanging;
    renderAccountBadge();
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
    $('catalogue-setup-guidance').hidden = connectedAccounts().length > 0;
  }
  function renderApple() {
    const apple = state.apple;
    $('apple-title').textContent = 'Apple Music';
    $('apple-dot').className = 'status-dot' + (apple.connected ? ' connected' : state.appleBusy || state.applePreparing ? ' waiting' : '');
    $('apple-message').textContent = state.appleBusy ? 'Complete sign-in in Apple’s window.' : state.applePreparing ? 'Preparing Apple’s secure sign-in…' : state.applePrepareError || (!apple.configured ? 'Optional account access and stronger availability checks. You can search and play on your Echo without connecting Apple Music here.' : apple.message || 'Sign in with your Apple Music account, or continue browsing without signing in.');
    $('apple-storefront').hidden = !apple.connected || !apple.storefront;
    $('apple-storefront').textContent = apple.storefront ? 'Account country: ' + countryName(apple.storefront) : '';
    $('apple-connect-button').hidden = !!apple.connected;
    $('apple-connect-button').disabled = state.appleBusy || state.applePreparing || state.appleSetupBusy;
    $('apple-connect-button').textContent = state.appleBusy ? 'Signing in…' : state.applePreparing ? 'Preparing sign-in…' : state.applePrepareError ? 'Prepare Apple sign-in ↗' : 'Connect Apple Music ↗';
    $('apple-disconnect-button').hidden = !apple.connected;
    $('apple-disconnect-button').disabled = state.appleBusy || state.appleSetupBusy;
    $('apple-signin-note').hidden = !apple.configured;
    $('apple-setup-button').disabled = state.appleSetupBusy || state.appleBusy || state.applePreparing;
    $('apple-setup-button').textContent = state.appleSetupBusy ? 'Saving app setup…' : 'Save app setup';
    renderSearchReadiness();
  }
  function applyAppleStatus(apple) {
    state.apple = Object.assign({ configured: false, connected: false, needsSetup: true, storefront: null, source: 'apple-music' }, apple || {});
    if (!state.apple.configured) {
      state.appleKit = null; state.appleTokenExpiresAt = 0; state.applePrepareError = '';
    }
    renderCatalogueSource(); renderApple();
    if (state.apple.configured && !state.appleKit && !state.applePreparing && !state.appleBusy && !state.applePrepareError) prepareMusicKit().catch(function () {});
  }
  function loadMusicKit() {
    if (window.MusicKit) return Promise.resolve(window.MusicKit);
    if (state.musicKitScriptPromise) return state.musicKitScriptPromise;
    state.musicKitScriptPromise = new Promise(function (resolve, reject) {
      const script = document.createElement('script'); script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js'; script.async = true;
      let settled = false;
      const cleanup = function () { clearTimeout(timer); document.removeEventListener('musickitloaded', ready); script.removeEventListener('load', ready); };
      const ready = function () { if (!settled && window.MusicKit) { settled = true; cleanup(); resolve(window.MusicKit); } };
      const failed = function () { if (settled) return; settled = true; cleanup(); script.remove(); reject(new Error('Apple’s sign-in service could not load. Check your connection, then prepare sign-in again.')); };
      const timer = setTimeout(failed, 20000);
      document.addEventListener('musickitloaded', ready); script.addEventListener('load', ready); script.addEventListener('error', failed, { once: true }); document.head.appendChild(script);
    }).catch(function (error) { state.musicKitScriptPromise = null; throw error; });
    return state.musicKitScriptPromise;
  }
  function appleTokenFresh() {
    return Number.isFinite(state.appleTokenExpiresAt) && state.appleTokenExpiresAt > Date.now() + 60000;
  }
  function developerTokenExpiry(config) {
    const explicit = Number(config.expiresAt);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    try {
      const part = String(config.developerToken || '').split('.')[1];
      if (!part) return 0;
      const encoded = part.replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
      const expiry = Number(payload.exp) * 1000;
      return Number.isFinite(expiry) && expiry > 0 ? expiry : 0;
    } catch (_) { return 0; }
  }
  function prepareMusicKit() {
    if (state.appleKit && appleTokenFresh()) return Promise.resolve(state.appleKit);
    state.appleKit = null; state.appleTokenExpiresAt = 0;
    if (state.applePreparePromise) return state.applePreparePromise;
    state.applePreparing = true; state.applePrepareError = ''; renderApple();
    state.applePreparePromise = (async function () {
      try {
        const responses = await Promise.all([api('/api/apple/config'), loadMusicKit()]);
        const config = responses[0];
        if (!config.developerToken || !window.MusicKit) throw new Error('Apple Music app setup is incomplete. Check the MusicKit credentials.');
        const expiresAt = developerTokenExpiry(config);
        if (expiresAt <= Date.now() + 60000) throw new Error('Apple Music app authorization needs a fresh developer token.');
        await window.MusicKit.configure({ developerToken: config.developerToken, app: config.app || { name: 'Echo Library', build: '0.2.0' } });
        state.appleKit = window.MusicKit.getInstance();
        if (!state.appleKit || typeof state.appleKit.authorize !== 'function') throw new Error('Apple’s sign-in service is unavailable. Please try preparing sign-in again.');
        if (expiresAt <= Date.now() + 60000) throw new Error('Apple Music app authorization expired while sign-in was being prepared.');
        state.appleTokenExpiresAt = expiresAt;
        return state.appleKit;
      } catch (_) {
        state.appleKit = null; state.appleTokenExpiresAt = 0;
        state.applePrepareError = 'Apple sign-in could not be prepared. Check your MusicKit app setup and network connection, then try again.';
        throw new Error(state.applePrepareError);
      } finally { state.applePreparing = false; state.applePreparePromise = null; renderApple(); }
    }());
    return state.applePreparePromise;
  }
  async function connectApple() {
    if (state.appleBusy || state.applePreparing) return;
    if (!state.apple.configured) { $('apple-setup').open = true; $('apple-setup').scrollIntoView({ block: 'nearest' }); return; }
    if (!state.appleKit || !appleTokenFresh()) {
      state.appleKit = null; state.appleTokenExpiresAt = 0; state.applePrepareError = '';
      try { await prepareMusicKit(); toast('Apple sign-in is ready. Click Connect Apple Music to continue.'); } catch (error) { toast(error.message, true); }
      return;
    }
    state.appleBusy = true; renderApple();
    let authorizationFinished = false;
    try {
      // Keep authorize() in the original click gesture so Apple can open its sign-in window.
      const authorization = state.appleKit.authorize();
      const musicUserToken = await authorization;
      if (typeof musicUserToken !== 'string' || !musicUserToken) throw new Error('Apple sign-in did not return authorization.');
      authorizationFinished = true;
      await cancelPlayback({ silent: true });
      const result = await api('/api/apple/connect', { method: 'POST', body: JSON.stringify({ musicUserToken: musicUserToken }) });
      applyAppleStatus(result.apple); scheduleStatus(0); toast('Apple Music account connected.');
    } catch (error) { toast(authorizationFinished ? error.message : 'Apple sign-in was cancelled or could not be completed. Try again and allow Apple’s sign-in window.', true); }
    finally { state.appleBusy = false; renderApple(); }
  }
  async function disconnectApple() {
    if (state.appleBusy) return; state.appleBusy = true; renderApple();
    try {
      await cancelPlayback({ silent: true });
      if (state.appleKit && typeof state.appleKit.unauthorize === 'function') { try { await state.appleKit.unauthorize(); } catch (_) {} }
      state.appleKit = null; state.appleTokenExpiresAt = 0;
      const result = await api('/api/apple/disconnect', { method: 'POST', body: '{}' });
      applyAppleStatus(result.apple); scheduleStatus(0); toast('Apple Music account disconnected from this app.');
    } catch (error) { toast(error.message, true); }
    finally { state.appleBusy = false; renderApple(); }
  }
  async function saveAppleSetup(event) {
    event.preventDefault(); if (state.appleSetupBusy) return;
    const token = $('apple-developer-token').value.trim();
    const teamId = $('apple-team-id').value.trim().toUpperCase(); const keyId = $('apple-key-id').value.trim().toUpperCase();
    const file = $('apple-private-key').files[0]; let payload;
    if (token) {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) { toast('Enter a valid MusicKit developer token, or use your Team ID, Key ID and .p8 key.', true); return; }
      payload = { developerToken: token };
    } else {
      if (!/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId) || !file) { toast('Add your 10-character Team ID, 10-character Key ID and MusicKit .p8 private key.', true); return; }
      if (file.size > 32768) { toast('That file is too large to be a MusicKit private key. Choose the .p8 file from Apple.', true); return; }
      let key; try { key = await file.text(); } catch (_) { toast('The private key file could not be read. Choose it again.', true); return; }
      if (!key.includes('-----BEGIN PRIVATE KEY-----')) { toast('Choose the MusicKit .p8 private key file provided by Apple.', true); return; }
      payload = { teamId: teamId, keyId: keyId, privateKey: key };
    }
    state.appleSetupBusy = true; renderApple();
    try {
      await cancelPlayback({ silent: true });
      const result = await api('/api/apple/setup', { method: 'POST', body: JSON.stringify(payload) });
      $('apple-setup-form').reset(); state.appleKit = null; state.appleTokenExpiresAt = 0; state.applePrepareError = '';
      applyAppleStatus(result.apple); $('apple-setup').open = false; toast('MusicKit app setup saved. Apple Music sign-in is being prepared.');
    } catch (error) { toast(error.message, true); }
    finally { state.appleSetupBusy = false; renderApple(); }
  }
  function jobTime(value) { if (typeof value === 'number' && Number.isFinite(value)) return value; const time = Date.parse(value || ''); return Number.isFinite(time) ? time : 0; }
  function activePlayback() { return !!(state.playback && state.playback.active); }
  function statusDelay() { return activePlayback() || activeQueue() ? 2000 : oauthOpen() || ['connecting', 'awaiting_login'].includes(state.connection.state) ? 4000 : 12000; }
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
    state.cancelBusy = true; ++state.playbackEpoch; ++state.queueEpoch;
    if (state.playback) state.playbackNotified.add(state.playback.id + ':cancelled');
    renderPlayback(); updatePlayButtons();
    state.cancelPromise = (async function () {
      try {
        let requestId = capturedRequestId;
        if (capturedSubmission) { try { const accepted = await capturedSubmission; requestId = (accepted.queue && accepted.queue.id) || (accepted.playback && accepted.playback.id) || accepted.requestId || requestId; } catch (_) {} }
        if (requestId) state.playbackNotified.add(requestId + ':cancelled');
        const result = await api('/api/cancel-playback', { method: 'POST', body: JSON.stringify(requestId ? { requestId: requestId } : {}) });
        ++state.playbackEpoch; ++state.queueEpoch;
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
    catch (_) { notice('The local app is not responding. Keep the app running on this computer, then refresh this page.'); }
    finally { state.statusBusy = false; scheduleStatus(); }
  }
  function setArtwork(container, url, alt) {
    container.replaceChildren(document.createTextNode('♫'));
    const safe = safeUrl(url); if (!safe) return;
    const image = document.createElement('img'); image.src = safe; image.alt = alt || ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.addEventListener('error', function () { image.remove(); }, { once: true }); container.appendChild(image);
  }
  function duration(ms) { if (!Number.isFinite(ms) || ms <= 0) return '—'; const seconds = Math.floor(ms / 1000); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
  function playIcon() { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M7 4 21 12 7 20z'); svg.appendChild(path); return svg; }
  function connectedAccounts() {
    return [{ source: 'apple-music', name: 'Apple Music', connected: !!state.apple.connected, target: 'apple-section' }, { source: 'spotify', name: 'Spotify', connected: !!state.spotify.connected, target: 'spotify-section' }, { source: 'youtube-music', name: 'YouTube Music', connected: !!state.youtube.connected, target: 'youtube-section' }].filter(function (account) { return account.connected; });
  }
  function catalogueSectionId(platform) { return platform === 'spotify' ? 'spotify-section' : platform === 'youtube-music' ? 'youtube-section' : 'apple-section'; }
  function renderCataloguePlatform() {
    $('catalogue-platform-select').value = state.cataloguePlatform;
    ['apple-music', 'spotify', 'youtube-music'].forEach(function (platform) { const section = $(catalogueSectionId(platform)); if (platform === state.cataloguePlatform) section.removeAttribute('hidden'); else section.setAttribute('hidden', ''); });
  }
  function chooseCataloguePlatform(platform, persist) {
    if (!['apple-music', 'spotify', 'youtube-music'].includes(platform)) return;
    state.cataloguePlatform = platform;
    if (persist) { state.cataloguePlatformSaved = true; try { localStorage.setItem('echo-library-catalogue-platform', platform); } catch (_) {} }
    renderCataloguePlatform();
  }
  function syncCataloguePlatformDefault() {
    if (!state.cataloguePlatformSaved) {
      const accounts = connectedAccounts(); const active = accounts.find(function (account) { return account.source === state.catalogueSource; });
      state.cataloguePlatform = active ? active.source : accounts.length === 1 ? accounts[0].source : 'apple-music';
    }
    renderCataloguePlatform();
  }
  function openCatalogueFromBadge(event) {
    event.preventDefault(); const accounts = connectedAccounts();
    const active = accounts.find(function (account) { return account.source === (state.catalogueSource || state.resultsSource); }) || (accounts.length === 1 ? accounts[0] : null);
    if (active) chooseCataloguePlatform(active.source, true); else renderCataloguePlatform();
    $('catalogue-platform-select').focus(); (active ? $(catalogueSectionId(active.source)) : $('music-catalogue')).scrollIntoView({ block: 'nearest' });
  }
  function openSelectedCatalogueSetup(event) {
    event.preventDefault(); chooseCataloguePlatform(state.cataloguePlatform, true);
    const details = $(state.cataloguePlatform === 'spotify' ? 'spotify-setup' : state.cataloguePlatform === 'youtube-music' ? 'youtube-setup' : 'apple-setup');
    details.open = true; details.scrollIntoView({ block: 'nearest' });
  }
  function renderAccountBadge() {
    const accounts = connectedAccounts(); const source = state.catalogueSource || state.resultsSource;
    const active = accounts.find(function (account) { return account.source === source; });
    let name = 'Connect a music service', target = 'apple-section';
    if (active) { name = active.name; target = active.target; }
    else if (accounts.length === 1) { name = accounts[0].name; target = accounts[0].target; }
    else if (accounts.length > 1) name = 'Music accounts · public catalogue';
    const accountIcon = active ? active.source : accounts.length === 1 ? accounts[0].source : null;
    const icon = accountIcon === 'apple-music' ? 'apple' : accountIcon === 'spotify' ? 'spotify' : accountIcon === 'youtube-music' ? 'youtube' : 'disc';
    ['disc', 'apple', 'spotify', 'youtube'].forEach(function (kind) { const svg = $('catalogue-' + kind + '-icon'); if (kind === icon) svg.removeAttribute('hidden'); else svg.setAttribute('hidden', ''); });
    $('catalogue-account-name').textContent = name;
    $('catalogue-account-badge').href = '#music-catalogue';
    $('catalogue-account-badge').title = accounts.length ? 'Connected browsing accounts: ' + accounts.map(function (account) { return account.name; }).join(', ') + '. Active song catalogue: ' + (source || 'public') : 'Connect an optional music browsing account';
    $('catalogue-account-badge').setAttribute('aria-label', name + (accounts.length ? ' — browsing account connections' : ''));
  }
  function activeCatalogueSource() { return state.resultsSource || state.catalogueSource || (state.apple.connected ? 'apple-music' : 'itunes'); }
  function catalogueHeading() { return ({ 'apple-music': 'Apple Music', spotify: 'Spotify', itunes: 'Public catalogue' }[activeCatalogueSource()] || 'Public catalogue') + ' · ' + countryName(state.resultsCountry || $('country-select').value); }
  function renderCatalogueSource() {
    renderAccountBadge(); const country = countryName(state.resultsCountry || $('country-select').value);
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
  function clearSearchTimer() { clearTimeout(state.searchTimer); state.searchTimer = null; }
  function searchSource() { return state.catalogueSource || (state.apple.connected ? 'apple-music' : 'itunes'); }
  function searchKey(query, country, source) { return JSON.stringify([String(query || '').trim().replace(/\s+/gu, ' ').toLowerCase(), country, source]); }
  function invalidateSearch(message) {
    clearSearchTimer(); ++state.searchGeneration;
    if (state.searchController) state.searchController.abort();
    state.searchController = null; state.searching = false; state.searchRequestKey = ''; state.searchCompletedKey = '';
    $('results-section').setAttribute('aria-busy', 'false'); clearSearchResults(message); renderSearchReadiness(); updatePlayButtons();
  }
  function scheduleLiveSearch() {
    clearSearchTimer();
    const query = $('search-input').value.trim(), country = $('country-select').value, source = searchSource();
    const key = searchKey(query, country, source);
    if (!state.searchComposing && query.length >= 2 && key === state.searchRequestKey && (state.searching || state.searchCompletedKey === key)) return;
    invalidateSearch('');
    if (state.searchComposing || query.length < 2 || state.view !== 'search') return;
    state.searchTimer = setTimeout(function () { state.searchTimer = null; if (state.view === 'search' && !state.searchComposing && searchKey($('search-input').value, $('country-select').value, searchSource()) === key) search(query); }, 600);
  }
  async function search(query, options) {
    clearSearchTimer();
    const text = String(query || '').trim();
    if (state.searchComposing) return;
    if (text.length < 2) { invalidateSearch(text ? 'Enter at least two characters to search.' : ''); return; }
    const country = $('country-select').value, source = searchSource(), key = searchKey(text, country, source);
    if (key === state.searchRequestKey && (state.searching || (!(options && options.force) && state.searchCompletedKey === key))) return;
    $('search-input').value = text;
    if (state.searchController) state.searchController.abort();
    const controller = new AbortController(); state.searchController = controller;
    const generation = ++state.searchGeneration; state.searchRequestKey = key; state.searchCompletedKey = '';
    const current = function () { return generation === state.searchGeneration && $('country-select').value === country && searchSource() === source && searchKey($('search-input').value, country, source) === key; };
    state.searching = true; clearSearchResults('Searching the catalogue for ' + countryName(country) + '…');
    $('empty-state').hidden = true; $('results-section').setAttribute('aria-busy', 'true'); renderSearchReadiness(); updatePlayButtons();
    const timeout = setTimeout(function () { controller.abort(); }, 20000);
    try {
      const response = await fetch('/api/search?q=' + encodeURIComponent(text) + '&country=' + encodeURIComponent(country), { signal: controller.signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.message || 'The catalogue could not be searched. Try again.');
      if (!current()) return;
      if (normalizeCountry(data.country) !== country || !['apple-music', 'spotify', 'itunes'].includes(data.source)) throw new Error('The catalogue could not return results for the selected country. Please search again.');
      state.tracks = Array.isArray(data.tracks) ? data.tracks : []; state.resultsCountry = country; state.resultsSource = data.source; state.searching = false; state.searchCompletedKey = key; renderTracks(text);
    } catch (error) {
      if (!current()) return;
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
  function seekPlaybackChanging() { return state.queueModeBusy || activePlayback() || state.pendingTrack !== null || !!state.playSubmissionPromise || !!state.queueSubmissionPromise || state.queueBusy || state.controlBusy || state.customCommandBusy || state.playlistBusy || state.providerChanging || (activeQueue() && state.queue.state === 'preparing'); }
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
  function createMacMediaBridge(options) {
    const session = options.session;
    let enabled = false, audio = null, metadataKey = '', generation = 0;
    const actions = { play: 'resume', pause: 'pause', nexttrack: 'next', previoustrack: 'previous' };
    function current() {
      const snapshot = options.snapshot(), player = snapshot.player;
      return snapshot.available && player && (!player.deviceId || player.deviceId === snapshot.deviceId)
        && ['PLAYING', 'PAUSED'].includes(player.state) && player.title ? snapshot : null;
    }
    function clear() {
      metadataKey = ''; session.metadata = null; session.playbackState = 'none';
      try { session.setPositionState && session.setPositionState(); } catch (_) {}
    }
    function update() {
      if (!enabled) return;
      const snapshot = current();
      if (!snapshot) { clear(); if (audio) audio.pause(); return; }
      const player = snapshot.player;
      const key = JSON.stringify([snapshot.deviceId, player.title, player.artist, player.album, player.artwork]);
      if (key !== metadataKey) {
        const artwork = typeof player.artwork === 'string' && /^https:\/\//.test(player.artwork) ? [{ src: player.artwork }] : [];
        session.metadata = options.metadata({ title: player.title, artist: player.artist || '', album: player.album || 'Playing on Echo', artwork: artwork });
        metadataKey = key;
      }
      session.playbackState = player.state === 'PLAYING' ? 'playing' : 'paused';
      try {
        if (session.setPositionState && Number.isFinite(player.durationMs) && player.durationMs > 0 && Number.isFinite(player.positionMs))
          session.setPositionState({ duration: player.durationMs / 1000, position: Math.max(0, Math.min(player.positionMs, player.durationMs)) / 1000, playbackRate: 1 });
        else if (session.setPositionState) session.setPositionState();
      } catch (_) {}
      if (audio && player.state === 'PAUSED') audio.pause();
      else if (audio && audio.paused) audio.play().catch(function () { options.notice('Disable and re-enable Mac media controls to reconnect Now Playing.'); });
    }
    async function disable() {
      ++generation; enabled = false;
      Object.keys(actions).forEach(function (action) { try { session.setActionHandler(action, null); } catch (_) {} });
      clear();
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      audio = null;
      options.changed(false);
    }
    async function enable() {
      if (enabled) { update(); return; }
      const revision = ++generation;
      try {
        // A finite PCM file requests persistent media focus; MediaStreams
        // are treated as transient playback by Chromium. All samples are zero.
        audio = options.audio(); audio.src = '/media-session.wav'; audio.loop = true; audio.volume = 1;
        await audio.play();
        if (revision !== generation) return;
        Object.keys(actions).forEach(function (action) {
          try { session.setActionHandler(action, function () {
            const snapshot = current();
            if (!enabled || !snapshot || snapshot.busy) return;
            Promise.resolve(options.control(actions[action])).catch(function () { options.notice('The Echo control was not confirmed. Check the app.'); });
          }); } catch (_) {}
        });
        enabled = true; options.changed(true); update();
      } catch (_) { await disable(); options.notice('Mac media controls could not start. Check browser playback permissions and try again.'); }
    }
    return { enable: enable, disable: disable, update: update, get enabled() { return enabled; } };
  }
  function initMacMedia() {
    const button = $('mac-media-toggle'), note = $('mac-media-note');
    if (!window.Audio || !window.MediaMetadata || !navigator.mediaSession) { button.hidden = true; note.textContent = 'System media controls are not available in this browser.'; return; }
    state.macMedia = createMacMediaBridge({ session: navigator.mediaSession,
      audio: function () { return new window.Audio(); }, metadata: function (value) { return new window.MediaMetadata(value); },
      snapshot: function () { return { deviceId: state.deviceId, available: canPlay() && !state.playerStale && !state.deviceChanging, player: state.player,
        busy: state.controlBusy || state.customCommandBusy || state.queueBusy || state.queueModeBusy || state.deviceChanging || state.providerChanging }; },
      control: control,
      notice: function (message) { note.textContent = message; },
      changed: function (enabled) { button.textContent = enabled ? 'Disable Mac media controls' : 'Enable Mac media controls'; button.setAttribute('aria-pressed', String(enabled)); note.textContent = enabled ? 'Keep this tab open. Now Playing uses a silent local session; keys control your Echo. Other media apps can take priority.' : 'Optional: show Echo playback in Mac Now Playing using a silent local session.'; }
    });
    button.addEventListener('click', async function () { button.disabled = true; try { if (state.macMedia.enabled) await state.macMedia.disable(); else await state.macMedia.enable(); } finally { button.disabled = false; } });
    window.addEventListener('pagehide', function () { state.macMedia.disable(); });
  }
  function renderPlayer() {
    const player = state.player; const available = canPlay();
    ['previous-button', 'toggle-button', 'next-button'].forEach(function (id) { $(id).disabled = !available || state.controlBusy || state.customCommandBusy || state.deviceChanging || state.queueModeBusy; });
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
    renderVolume(); renderSeek(); renderPlayerSongActions(); renderQueueModes();
    if (state.macMedia) state.macMedia.update();
  }
  async function refreshPlayer() {
    if (!canPlay() || state.playerBusy || state.deviceChanging || (document.hidden && !(state.macMedia && state.macMedia.enabled))) return;
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
    if (!canPlay() || state.controlBusy || state.customCommandBusy || state.deviceChanging || state.queueModeBusy) return;
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
  function accountName(service) { return service === 'spotify' ? 'Spotify' : 'YouTube Music / YouTube'; }
  function oauthOpen() {
    return ['spotify', 'youtube'].some(function (service) { const popup = state.oauthPopups[service]; if (popup && popup.closed) state.oauthPopups[service] = null; return !!(popup && !popup.closed); });
  }
  function safeOAuthReason(url) {
    const reason = url.searchParams.get('reason');
    return typeof reason === 'string' && reason.trim() && reason.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(reason) ? reason.trim() : '';
  }
  function checkOAuthPopupResult(service) {
    const popup = state.oauthPopups[service]; if (!popup || popup.closed) return;
    try {
      const url = new URL(popup.location.href);
      if (url.origin === window.location.origin && url.searchParams.get('musicAuth') === service && url.searchParams.get('result') === 'error') { popup.close(); state.oauthPopups[service] = null; toast(safeOAuthReason(url) || accountName(service) + ' sign-in could not be completed. You can try connecting again.', true); }
    } catch (_) { /* OAuth pages stay cross-origin until the local callback. */ }
  }
  function showOAuthCallbackNotice() {
    const url = new URL(window.location.href); const service = url.searchParams.get('musicAuth'); const result = url.searchParams.get('result');
    if (!['spotify', 'youtube'].includes(service) || !['connected', 'error'].includes(result)) return;
    toast(result === 'connected' ? accountName(service) + ' account connected. You can return to the original app window.' : safeOAuthReason(url) || accountName(service) + ' sign-in could not be completed. Return to the app and try again.', result === 'error');
    url.searchParams.delete('musicAuth'); url.searchParams.delete('result'); url.searchParams.delete('reason'); window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  function renderOAuth(service) {
    const account = state[service]; const popup = state.oauthPopups[service]; const open = !!(popup && !popup.closed);
    $(service + '-dot').className = 'status-dot' + (account.connected ? ' connected' : open || state.oauthBusy[service] ? ' waiting' : '');
    $(service + '-message').textContent = account.message || (account.connected ? accountName(service) + ' browsing account connected.' : 'Optional: connect your account for browsing and playlists.');
    $(service + '-connect-button').hidden = !!account.connected;
    $(service + '-connect-button').disabled = state.oauthBusy[service] || open || state.oauthSetupBusy[service];
    $(service + '-connect-button').textContent = open ? 'Sign-in window open…' : state.oauthBusy[service] ? 'Opening sign-in…' : 'Connect ' + accountName(service) + ' ↗';
    $(service + '-disconnect-button').hidden = !account.connected;
    $(service + '-disconnect-button').disabled = state.oauthBusy[service];
    $(service + '-setup-button').disabled = state.oauthSetupBusy[service] || state.oauthBusy[service] || open;
    $(service + '-setup-button').textContent = state.oauthSetupBusy[service] ? 'Saving app setup…' : 'Save app setup';
    $(service + '-redirect').textContent = account.redirectUri ? 'Redirect address: ' + account.redirectUri : '';
  }
  function applyOAuthStatus(service, value) {
    state[service] = Object.assign({ configured: false, connected: false, needsSetup: true }, value || {});
    checkOAuthPopupResult(service);
    const popup = state.oauthPopups[service];
    if (popup && (state[service].connected || popup.closed)) { if (!popup.closed) popup.close(); state.oauthPopups[service] = null; }
    renderOAuth(service);
  }
  async function saveOAuthSetup(service, event) {
    event.preventDefault(); if (state.oauthSetupBusy[service]) return;
    const clientId = $(service + '-client-id').value.trim();
    const clientSecret = service === 'youtube' ? $('youtube-client-secret').value.trim() : null;
    if (!clientId || clientId.length > 500 || /[\u0000-\u001f\u007f]/u.test(clientId) || (service === 'youtube' && !clientSecret)) { toast('Add the developer credentials for this app before saving.', true); return; }
    state.oauthSetupBusy[service] = true; renderOAuth(service);
    try {
      await cancelPlayback({ silent: true });
      const result = await api('/api/' + service + '/setup', { method: 'POST', body: JSON.stringify(service === 'youtube' ? { clientId: clientId, clientSecret: clientSecret } : { clientId: clientId }) });
      if (result[service]) applyOAuthStatus(service, result[service]);
      $(service + '-setup-form').reset(); $(service + '-setup').open = false; scheduleStatus(0); toast(accountName(service) + ' app setup saved.');
    } catch (error) { toast(error.message, true); }
    finally { state.oauthSetupBusy[service] = false; renderOAuth(service); }
  }
  async function connectOAuth(service) {
    if (state.oauthBusy[service] || state.oauthSetupBusy[service]) return;
    if (!state[service].configured) { $(service + '-setup').open = true; $(service + '-client-id').focus(); return; }
    const existing = state.oauthPopups[service]; if (existing && !existing.closed) { existing.focus(); return; }
    // Open synchronously; navigation waits for the local server's OAuth state and URL.
    const popup = window.open('about:blank', 'echo-library-' + service, 'popup,width=540,height=720');
    if (!popup) { toast('Allow this app to open a sign-in window, then try connecting again.', true); return; }
    try { popup.opener = null; } catch (_) {}
    state.oauthPopups[service] = popup; state.oauthBusy[service] = true; renderOAuth(service);
    try {
      const result = await api('/api/' + service + '/connect', { method: 'POST', body: '{}' });
      const url = new URL(result.authorizationUrl);
      const expected = service === 'spotify' ? ['https://accounts.spotify.com', '/authorize'] : ['https://accounts.google.com', '/o/oauth2/v2/auth'];
      if (url.origin !== expected[0] || url.pathname !== expected[1] || url.username || url.password) throw new Error('The sign-in address was not recognized. Check the local app setup.');
      if (!popup.closed) popup.location.replace(url.href); scheduleStatus(1000);
    } catch (error) { if (!popup.closed) popup.close(); state.oauthPopups[service] = null; toast(error.message, true); }
    finally { state.oauthBusy[service] = false; renderOAuth(service); }
  }
  async function disconnectOAuth(service) {
    if (state.oauthBusy[service]) return; state.oauthBusy[service] = true; renderOAuth(service);
    try { await cancelPlayback({ silent: true }); const result = await api('/api/' + service + '/disconnect', { method: 'POST', body: '{}' }); applyOAuthStatus(service, result[service]); renderPlaylistSources(); scheduleStatus(0); toast(accountName(service) + ' account disconnected.'); }
    catch (error) { toast(error.message, true); }
    finally { state.oauthBusy[service] = false; renderOAuth(service); }
  }
  function setBrowseView(view) {
    state.view = view === 'playlists' ? 'playlists' : 'search'; const playlists = state.view === 'playlists'; if (playlists) clearSearchTimer(); else ++state.playlistArtworkRevision;
    $('search-tab').setAttribute('aria-pressed', String(!playlists)); $('playlists-tab').setAttribute('aria-pressed', String(playlists));
    $('search-view-header').hidden = playlists; $('results-section').hidden = playlists; $('catalogue-footer').hidden = playlists; $('playlists-section').hidden = !playlists;
    renderPlaylistSources(); if (playlists && state.localPlaylist) renderLocalPlaylist(); if (playlists && state.playlistsSource && !state.playlists.length && !state.playlistsLoading) loadPlaylists();
  }
  function selectionIsCurrent(current) { try { return !current || !!current(); } catch (_) { return false; } }
  function playlistSongArtwork(track, selection, current) {
    const button = element('button', 'playlist-song-play'); button.type = 'button'; button.disabled = true;
    button.dataset.songAction = 'play'; button.songSelection = selection; button.songCurrent = current;
    button.setAttribute('aria-label', 'Play ' + (track.title || 'this song') + ' by ' + (track.artist || 'this artist') + ' on your Echo');
    const art = element('div', 'track-art'); art.setAttribute('aria-hidden', 'true'); setArtwork(art, track.artwork); button.appendChild(art); button.artworkContainer = art;
    const overlay = element('span', 'playlist-song-play-overlay'); overlay.setAttribute('aria-hidden', 'true'); overlay.appendChild(playIcon()); button.appendChild(overlay);
    button.addEventListener('click', function (event) { event.stopPropagation(); if (button.disabled || !selectionIsCurrent(current)) return; return playSelection(selection(), track, current); });
    return button;
  }
  function artworkSlot() {
    if (!Number.isInteger(state.playlistArtworkActive)) state.playlistArtworkActive = 0;
    if (!Array.isArray(state.playlistArtworkWaiters)) state.playlistArtworkWaiters = [];
    return new Promise(function (resolve) {
      const start = function () { ++state.playlistArtworkActive; resolve(function () { --state.playlistArtworkActive; const next = state.playlistArtworkWaiters.shift(); if (next) next(); }); };
      if (state.playlistArtworkActive < 4) start(); else state.playlistArtworkWaiters.push(start);
    });
  }
  async function localArtwork(playlistId, entryId) {
    const key = playlistId + ':' + entryId, saved = state.playlistArtworkCache.get(key);
    if (saved && (saved.promise || saved.expires > Date.now())) return saved.promise || saved.artwork;
    const entry = {};
    entry.promise = (async function () {
      const release = await artworkSlot(); let artwork = '';
      try { const result = await api('/api/local-playlists/' + encodeURIComponent(playlistId) + '/tracks/' + encodeURIComponent(entryId) + '/artwork'); artwork = result.entryId === entryId ? safeUrl(result.artwork) : ''; }
      catch (_) { /* Missing artwork keeps the music-note fallback. */ }
      finally { release(); }
      delete entry.promise; entry.artwork = artwork; entry.expires = Date.now() + (artwork ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000);
      return artwork;
    }());
    state.playlistArtworkCache.set(key, entry);
    while (state.playlistArtworkCache.size > 1000) state.playlistArtworkCache.delete(state.playlistArtworkCache.keys().next().value);
    return entry.promise;
  }
  async function loadLocalArtwork(playlist, generation, revision, entries) {
    const current = function () { return state.view === 'playlists' && revision === state.playlistArtworkRevision && generation === state.localPlaylistGeneration && state.localPlaylist === playlist; };
    let next = 0;
    async function worker() {
      while (next < entries.length && current()) {
        const entry = entries[next++], artwork = await localArtwork(playlist.id, entry.track.id);
        if (!current()) return;
        if (artwork) { entry.track.artwork = artwork; setArtwork(entry.art, artwork); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
  }
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
    if (selection.source === 'youtube-music') {
      const preview = state.playlistPreview, index = preview && preview.id === selection.playlistId ? preview.tracks.findIndex(function (item) { return item.id === selection.trackId; }) : -1;
      if (index < 0) { toast('This playlist changed. Open it again before playing a song.', true); return; }
      const tail = preview.tracks;
      if (tail.some(function (item) { return !validQueueText(item.title) || !validQueueText(item.artist); })) { toast('Review the title and artist of every song before playing this playlist.', true); return; }
      selection = Object.assign({}, selection, { edits: tail.map(function (item) { return { id: item.id, title: item.title.trim(), artist: item.artist.trim() }; }) });
    }
    const deviceId = state.deviceId, deviceName = selectedDevice().name; const payload = { selection: selection, deviceId: deviceId, providerId: state.providerId, country: $('country-select').value, requestMode: 'standard' };
    if (['local', 'youtube-music'].includes(selection.source)) Object.assign(payload, queuePlaybackModes());
    state.pendingTrack = '__selection__'; state.pendingSelection = { title: track.title, artist: track.artist, deviceId: deviceId, providerId: state.providerId, providerName: selectedProvider().name, requestMode: payload.requestMode }; ++state.playbackEpoch; ++state.queueEpoch; updatePlayButtons(); renderPlayback();
    const request = api('/api/play-selection', { method: 'POST', body: JSON.stringify(payload) }); state.playSubmissionPromise = request;
    try { const result = await request; ++state.playbackEpoch; if (result.queue) { ++state.queueEpoch; applyQueue(result.queue, { fromMutation: true }); toggleQueue(true); } if (Object.prototype.hasOwnProperty.call(result, 'playback')) applyPlayback(result.playback, { fromSubmission: true, notify: false }); if (deviceId === state.deviceId) toast(result.message || 'Request sent to ' + deviceName + '.'); scheduleStatus(500); }
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
    try { const result = await api('/api/local-playlists/' + encodeURIComponent(id)); if (generation !== state.localPlaylistGeneration) return; state.localPlaylist = result.playlist; state.playlistPreview = null; ++state.playlistPreviewGeneration; renderPlaylistPreview(); renderLocalPlaylist(); $('local-playlist-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    catch (error) { if (generation === state.localPlaylistGeneration) toast(error.message, true); }
    finally { state.playlistBusy = false; renderPlaylistActions(); }
  }
  function renderLocalImportNotice(playlist) {
    const imported = !!(playlist && (playlist.imported === true || Array.isArray(playlist.tracks) && playlist.tracks.some(function (track) { return track.imported === true || track.source === 'youtube-music'; })));
    $('local-playlist-import-note').hidden = !imported; $('local-playlist-import-note').textContent = imported ? 'Imported song details. Availability on your selected Echo service in ' + countryName(playlist.country) + ' is unverified.' : '';
  }
  function renderLocalPlaylist() {
    const revision = ++state.playlistArtworkRevision; const playlist = state.localPlaylist, list = $('local-playlist-tracks'); renderLocalImportNotice(playlist); $('local-playlist-detail').hidden = !playlist; list.replaceChildren(); if (!playlist) return;
    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : []; renderLocalPlaylistIdentity(playlist);
    if (playlist.origin && playlist.origin.url) { const identityGeneration = state.localPlaylistGeneration; loadPlaylistSourceMetadata(playlist, function () { return state.localPlaylist === playlist && identityGeneration === state.localPlaylistGeneration; }, function () { renderLocalPlaylistIdentity(playlist); }); }
    const missingArtwork = [], generation = state.localPlaylistGeneration;
    tracks.forEach(function (track, index) {
      const selection = function () { return { source: 'local', playlistId: playlist.id, entryId: track.id, country: playlist.country }; }; const current = function () { return generation === state.localPlaylistGeneration && state.localPlaylist && state.localPlaylist.id === playlist.id && state.localPlaylist.tracks.some(function (entry) { return entry.id === track.id; }); };
      const row = element('li', 'local-song-row'), play = playlistSongArtwork(track, selection, current); row.appendChild(play);
      if (!safeUrl(track.artwork)) missingArtwork.push({ track: track, art: play.artworkContainer });
      const copy = element('div', 'song-list-copy'); copy.appendChild(element('strong', '', track.title)); copy.appendChild(element('span', '', track.artist)); if (track.album) copy.appendChild(element('span', 'song-list-album', track.album)); row.appendChild(copy);
      const actions = element('div', 'song-row-actions'); actions.appendChild(songMenu(track, selection, current));
      [['↑', 'Move song up', 'up'], ['↓', 'Move song down', 'down'], ['×', 'Remove from playlist', 'remove']].forEach(function (action) { const button = element('button', 'song-small-button', action[0]); button.type = 'button'; button.setAttribute('aria-label', action[1] + ': ' + track.title); button.dataset.localAction = '1'; button.dataset.edgeDisabled = String((action[2] === 'up' && index === 0) || (action[2] === 'down' && index === tracks.length - 1)); button.addEventListener('click', function () { mutateLocalTrack(playlist.id, track.id, action[2]); }); actions.appendChild(button); }); row.appendChild(actions); list.appendChild(row);
    }); if (!tracks.length) list.appendChild(element('li', 'queue-empty', 'This playlist is empty. Search for a song and choose Add to playlist.')); renderLocalReadiness(); renderSongActionReadiness(); if (missingArtwork.length) loadLocalArtwork(playlist, generation, revision, missingArtwork);
  }
  function nativeLocalPlaylist(playlist) { return !!(playlist && playlist.origin && playlist.origin.source !== 'youtube-music' && playlist.origin.source === state.providerId && selectedProvider().kind === 'music'); }
  function renderLocalReadiness() {
    const playlist = state.localPlaylist, native = nativeLocalPlaylist(playlist); $('local-playlist-native-play').hidden = !native; $('local-playlist-native-play').disabled = !native || !canPlay() || songHandoffBusy() || normalizeCountry(playlist.country) !== $('country-select').value; $('local-playlist-play-note').hidden = !native; $('local-playlist-play-note').textContent = native ? 'Requests the original ' + playlistSourceName(playlist.origin.source) + ' playlist on your Echo. Your saved copy stays here.' : ''; $('local-playlist-play').disabled = !playlist || !playlist.tracks || !playlist.tracks.length || !canPlay() || songHandoffBusy() || normalizeCountry(playlist.country) !== $('country-select').value || selectedProvider().kind === 'radio';
    $('local-playlist-play').title = playlist && normalizeCountry(playlist.country) !== $('country-select').value ? 'Choose ' + countryName(playlist.country) + ' as the catalogue country first.' : '';
    $('local-playlist-rename').disabled = !playlist || state.localMutationBusy; $('local-playlist-delete').disabled = !playlist || state.localMutationBusy;
    $('local-playlist-sync').hidden = !playlist || !playlist.origin || !safeUrl(playlist.origin.url); $('local-playlist-sync').disabled = !playlist || state.localMutationBusy || state.playlistBusy || !!state.playlistSync;
    document.querySelectorAll('[data-local-action]').forEach(function (button) { button.disabled = state.localMutationBusy || button.dataset.edgeDisabled === 'true'; });
  }
  function renderPlaylistSync() {
    const dialog = state.playlistSync, preview = dialog && dialog.preview;
    $('playlist-sync-close').disabled = !!(dialog && dialog.saving);
    $('playlist-sync-accept-partial').disabled = !preview || !!(dialog && dialog.saving);
    $('playlist-sync-partial-group').hidden = !preview || !preview.requiresPartialConfirmation;
    $('playlist-sync-apply').disabled = !preview || !!(dialog && (dialog.loading || dialog.saving)) || (preview.requiresPartialConfirmation && !$('playlist-sync-accept-partial').checked);
    if (!dialog) return;
    $('playlist-sync-summary').textContent = preview
      ? playlistSourceName(preview.source) + ' · ' + preview.sourceName + '. ' + preview.oldCount + ' songs → ' + preview.newCount + ' songs; ' + preview.added + ' added, ' + preview.removed + ' removed. Your name “' + dialog.localName + '” stays the same.'
      : 'Loading the latest source playlist. Your saved songs have not changed.';
    const warnings = preview && Array.isArray(preview.warnings) ? preview.warnings.filter(function (message) { return typeof message === 'string'; }) : [];
    $('playlist-sync-warning').hidden = !preview || (!preview.requiresPartialConfirmation && !warnings.length);
    $('playlist-sync-warning').textContent = warnings.join(' ') || (preview && preview.requiresPartialConfirmation ? 'The source list may be incomplete. Only continue if you want to replace your saved songs with the available entries.' : '');
    $('playlist-sync-status').textContent = dialog.message || (dialog.loading ? 'Checking the source playlist…' : dialog.saving ? 'Updating this saved playlist…' : 'Review the changes, then choose Update playlist.');
  }
  async function openPlaylistSync() {
    const playlist = state.localPlaylist;
    if (!playlist || !playlist.origin || !safeUrl(playlist.origin.url) || state.localMutationBusy || state.playlistBusy || state.playlistSync) return;
    const dialog = { generation: ++state.playlistSyncGeneration, playlistId: playlist.id, localName: playlist.name || playlist.title, previousFocus: document.activeElement, loading: true, saving: false, preview: null, message: '' };
    state.playlistSync = dialog; $('playlist-sync-accept-partial').checked = false; renderPlaylistSync(); renderLocalReadiness();
    if (!$('playlist-sync-dialog').open) $('playlist-sync-dialog').showModal(); $('playlist-sync-close').focus();
    try {
      const preview = await api('/api/local-playlists/' + encodeURIComponent(playlist.id) + '/sync-preview', { method: 'POST', body: '{}' });
      if (state.playlistSync !== dialog || dialog.generation !== state.playlistSyncGeneration) return;
      if (preview.playlistId !== playlist.id || typeof preview.previewId !== 'string') throw new Error('The source preview could not be verified. Close this window and try Sync again.');
      dialog.preview = preview;
    } catch (error) { if (state.playlistSync === dialog) dialog.message = error.message || 'The source playlist could not be loaded. Your saved playlist is unchanged.'; }
    finally { if (state.playlistSync === dialog) { dialog.loading = false; renderPlaylistSync(); } }
  }
  function closePlaylistSync() {
    const dialog = state.playlistSync; if (dialog && dialog.saving) return;
    ++state.playlistSyncGeneration; state.playlistSync = null; if ($('playlist-sync-dialog').open) $('playlist-sync-dialog').close();
    renderLocalReadiness();
    if (dialog && dialog.previousFocus && dialog.previousFocus.isConnected !== false && typeof dialog.previousFocus.focus === 'function') dialog.previousFocus.focus();
  }
  async function applyPlaylistSync(event) {
    event.preventDefault(); const dialog = state.playlistSync, preview = dialog && dialog.preview;
    if (!dialog || !preview || dialog.loading || dialog.saving || (preview.requiresPartialConfirmation && !$('playlist-sync-accept-partial').checked)) return;
    dialog.saving = true; dialog.message = ''; state.localMutationBusy = true; renderPlaylistSync(); renderLocalReadiness();
    try {
      const result = await api('/api/local-playlists/' + encodeURIComponent(dialog.playlistId) + '/sync', { method: 'POST', body: JSON.stringify({ previewId: preview.previewId, acceptPartial: !!$('playlist-sync-accept-partial').checked }) });
      if (state.playlistSync !== dialog || dialog.generation !== state.playlistSyncGeneration) return;
      if (!result.playlist || result.playlist.id !== dialog.playlistId) throw new Error('The saved playlist could not be refreshed. Close this window and reload your playlists.');
      if (state.playlistSourceCache instanceof Map) for (const key of state.playlistSourceCache.keys()) if (key.startsWith(dialog.playlistId + ':')) state.playlistSourceCache.delete(key);
      if (state.localPlaylist && state.localPlaylist.id === dialog.playlistId) { ++state.localPlaylistGeneration; state.localPlaylist = result.playlist; renderLocalPlaylist(); }
      await refreshCreatedPlaylists();
      dialog.saving = false; closePlaylistSync(); toast(result.message || 'Playlist updated from its source.');
    } catch (error) { if (state.playlistSync === dialog) dialog.message = error.message || 'The update could not be confirmed. Refresh your playlists before trying again.'; }
    finally { state.localMutationBusy = false; if (state.playlistSync === dialog) { dialog.saving = false; renderPlaylistSync(); } renderLocalReadiness(); }
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
    const payload = Object.assign({ deviceId: state.deviceId, providerId: state.providerId, country: $('country-select').value }, queuePlaybackModes()); state.queueBusy = true; ++state.queueEpoch; ++state.playbackEpoch; updatePlayButtons();
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
  function confirmInApp(message, confirmLabel) {
    const dialog = $('app-confirm-dialog');
    if (dialog.open) return Promise.resolve(false);
    $('app-confirm-message').textContent = message;
    $('app-confirm-accept').textContent = confirmLabel || 'Confirm';
    dialog.returnValue = '';
    return new Promise(function (resolve) {
      dialog.onclose = function () { dialog.onclose = null; resolve(dialog.returnValue === 'confirm'); };
      dialog.showModal();
    });
  }
  async function deleteLocalPlaylist() {
    const playlist = state.localPlaylist; if (!playlist || state.localMutationBusy) return;
    state.localMutationBusy = true; renderLocalReadiness();
    try {
      if (!await confirmInApp('Delete “' + (playlist.name || playlist.title) + '” from this computer?', 'Delete playlist') || state.localPlaylist !== playlist) return;
      await api('/api/local-playlists/' + encodeURIComponent(playlist.id) + '/delete', { method: 'POST', body: '{}' });
      if (state.localPlaylist && state.localPlaylist.id === playlist.id) { ++state.localPlaylistGeneration; state.localPlaylist = null; renderLocalPlaylist(); }
      await refreshCreatedPlaylists(); toast('Playlist deleted.');
    } catch (error) { toast(error.message, true); }
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
      const raw = String(value || '').trim(); if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f]/u.test(raw)) return '';
      const url = new URL(raw); if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
      if (['music.youtube.com', 'youtube.com', 'www.youtube.com'].includes(url.hostname) && url.pathname === '/playlist' && url.searchParams.getAll('list').length === 1 && /^PL[A-Za-z0-9_-]{1,126}$/.test(url.searchParams.get('list') || '')) return 'youtube-music';
      if (url.hostname === 'open.spotify.com' && /^\/(?:intl-[a-z]{2}\/)?playlist\/[A-Za-z0-9]{22}\/?$/.test(url.pathname)) return 'spotify';
      if (url.hostname === 'music.apple.com' && /^\/[a-z]{2}\/playlist\/(?:[^/]+\/)?pl\.[A-Za-z0-9_-]{1,128}\/?$/i.test(url.pathname)) return 'apple-music';
      if (['jiosaavn.com', 'www.jiosaavn.com'].includes(url.hostname) && /^\/(?:featured|s\/playlist)\/(?:[A-Za-z0-9_~.,!()-]+\/){1,3}[A-Za-z0-9_,+\-=]{4,160}\/?$/.test(url.pathname)) return 'jiosaavn';
      if (['music.amazon.in', 'music.amazon.com', 'music.amazon.co.uk', 'music.amazon.de', 'music.amazon.ca', 'music.amazon.com.au', 'music.amazon.co.jp'].includes(url.hostname) && /^\/(?:playlists|user-playlists)\/[A-Za-z0-9_-]{8,160}\/?$/.test(url.pathname)) return 'amazon-music';
    } catch (_) {} return '';
  }
  function playlistImportCountryFromUrl(value) {
    const source = playlistImportPlatformFromUrl(value); if (!source) return '';
    try {
      const url = new URL(String(value).trim()); let country = '';
      if (source === 'apple-music') country = url.pathname.split('/')[1].toUpperCase();
      else if (source === 'amazon-music') country = ({ 'music.amazon.in': 'IN', 'music.amazon.com': 'US', 'music.amazon.co.uk': 'GB', 'music.amazon.de': 'DE', 'music.amazon.ca': 'CA', 'music.amazon.com.au': 'AU', 'music.amazon.co.jp': 'JP' })[url.hostname] || '';
      else {
        const field = source === 'youtube-music' ? 'gl' : source === 'spotify' ? 'market' : '';
        const values = field ? url.searchParams.getAll(field) : [];
        if (values.length === 1) country = values[0].toUpperCase();
      }
      return countries.includes(country) ? country : '';
    } catch (_) { return ''; }
  }
  function clearPlaylistImportAutoload(dialog) {
    if (!dialog) return; clearTimeout(dialog.autoTimer); dialog.autoTimer = null; dialog.pendingAutoKey = '';
  }
  function playlistImportLoadKey(dialog) {
    if (!dialog) return '';
    const url = $('playlist-import-url').value.trim(), source = playlistImportPlatformFromUrl(url), country = $('playlist-import-country').value;
    return source && source === dialog.platform && playlistImportLinkSupported(source) && countries.includes(country) ? JSON.stringify([url, country, source]) : '';
  }
  function playlistImportHasSongEdits(dialog) {
    const text = $('playlist-import-text').value;
    return !!text.trim() && (dialog.songTextEdited || text !== dialog.autoText);
  }
  function playlistImportHasCurrentPreview(dialog, key) {
    return !!(key && dialog.loadedKey === key && dialog.preview && !dialog.previewContextStale);
  }
  function playlistImportNeedsLinkReview(dialog) {
    return !!(dialog.loadedKey && dialog.previewContextStale && $('playlist-import-url').value.trim() && $('playlist-import-text').value.trim() && !playlistImportHasSongEdits(dialog));
  }
  function detectPlaylistImportLink(dialog, forcePlatform) {
    const value = $('playlist-import-url').value.trim(), source = playlistImportPlatformFromUrl(value), changed = value !== dialog.detectedInputUrl;
    if (changed) {
      dialog.detectedInputUrl = value;
      const detectedCountry = playlistImportCountryFromUrl(value);
      if (detectedCountry) $('playlist-import-country').value = detectedCountry;
      dialog.lastInputCountry = $('playlist-import-country').value;
    }
    if (source && (changed || forcePlatform) && source !== dialog.platform) setPlaylistImportPlatform(source, { automatic: true });
    const country = $('playlist-import-country').value, inferred = playlistImportCountryFromUrl(value);
    $('playlist-import-detect-note').textContent = source ? 'Detected ' + playlistSourceName(source) + '. ' + (inferred && inferred === country ? 'Country: ' + countryName(country) + '.' : 'Keeping ' + countryName(country) + ' as the playlist country.') : 'Paste a playlist link to detect its platform and name. The selected country is kept when the link has no country code.';
    return playlistImportLoadKey(dialog);
  }
  function schedulePlaylistImportLoad() {
    const dialog = state.playlistImport; if (!dialog || dialog.saving) return;
    clearPlaylistImportAutoload(dialog);
    const key = playlistImportLoadKey(dialog); if (!key || playlistImportHasCurrentPreview(dialog, key) || (dialog.loading && key === dialog.requestKey && dialog.requestRevision === dialog.revision)) return;
    if (playlistImportHasSongEdits(dialog)) { $('playlist-import-status').textContent = 'Your song edits were kept. Choose Load songs if you want to replace them with this link’s song list.'; return; }
    dialog.autoTimer = setTimeout(function () {
      dialog.autoTimer = null;
      if (state.playlistImport !== dialog) return;
      if (dialog.saving || playlistImportLoadKey(dialog) !== key || playlistImportHasSongEdits(dialog)) { renderPlaylistImport(); return; }
      if (dialog.loading) { dialog.pendingAutoKey = key; return; }
      return loadPlaylistImport({ automatic: true });
    }, 400);
  }
  function setPlaylistImportPlatform(source, options) {
    const dialog = state.playlistImport; if (!dialog || dialog.saving || !playlistImportSource(source)) return;
    if (!(options && options.automatic)) clearPlaylistImportAutoload(dialog);
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
    clearPlaylistImportAutoload(state.playlistImport);
    ++state.playlistImportGeneration; state.playlistImport = { autoTimer: null, pendingAutoKey: '', requestKey: '', requestRevision: -1, loadedKey: '', previewContextStale: false, detectedInputUrl: '', autoText: '', songTextEdited: false, lastInputCountry: '', generation: state.playlistImportGeneration, revision: 0, previewTracks: [], preview: null, platform: 'youtube-music', nativeNameEdited: false, nameEdited: false, autoName: '', loading: false, saving: false, previewError: false };
    $('playlist-import-platform').value = 'youtube-music'; $('playlist-import-native-name').value = ''; $('playlist-import-name').value = ''; $('playlist-import-country').value = countries.includes($('country-select').value) ? $('country-select').value : 'IN'; $('playlist-import-url').value = ''; $('playlist-import-text').value = ''; $('playlist-import-status').textContent = '';
    state.playlistImport.lastInputCountry = $('playlist-import-country').value;
    renderPlaylistImport(); detectPlaylistImportLink(state.playlistImport, false); if (!$('playlist-import-dialog').open) $('playlist-import-dialog').showModal(); $('playlist-import-url').focus();
  }
  function closePlaylistImport() { clearPlaylistImportAutoload(state.playlistImport); ++state.playlistImportGeneration; state.playlistImport = null; $('playlist-import-dialog').close(); }
  function renderPlaylistImport() {
    const dialog = state.playlistImport; if (!dialog) return;
    renderPlaylistImportPlatforms(dialog); const sourceName = playlistSourceName(dialog.platform); $('playlist-import-source-note').textContent = 'Pasted songs will be saved as ' + sourceName + ' details. Availability on your selected Echo service is unverified.';
    $('playlist-import-link-note').textContent = dialog.platform === 'apple-music' ? 'Public Apple Music links can be loaded without sign-in. Configured app credentials use the official catalogue. Pasted songs need no connected account.' : dialog.platform === 'spotify' ? 'Public Spotify links can be loaded without connecting an account. Private playlists need a connected Spotify account with playlist-read permissions.' : dialog.platform === 'youtube-music' ? 'Public YouTube links can be loaded without connecting an account. Private playlists use your Google connection.' : playlistImportLinkSupported(dialog.platform) ? 'Public ' + sourceName + ' links can be loaded. Private or incomplete playlists may need pasted song details instead. Pasted songs need no connected account.' : 'Link loading is not available for ' + sourceName + ' yet. Paste song details below without connecting an account.';
    $('playlist-import-native-group').hidden = dialog.platform === 'youtube-music'; $('playlist-import-native-label').textContent = 'Playlist name on ' + sourceName + ' (optional)';
    $('playlist-import-url').placeholder = 'Paste a playlist link…';
    const busy = dialog.saving; ['playlist-import-name', 'playlist-import-country', 'playlist-import-platform', 'playlist-import-url', 'playlist-import-text', 'playlist-import-native-name'].forEach(function (id) { $(id).disabled = busy; });
    $('playlist-import-load').disabled = busy || dialog.loading || !playlistImportLinkSupported(dialog.platform) || !$('playlist-import-url').value.trim(); $('playlist-import-load').textContent = dialog.loading ? 'Loading…' : 'Load songs';
    $('playlist-import-save').disabled = busy || dialog.loading || !!dialog.autoTimer || !!dialog.pendingAutoKey || playlistImportNeedsLinkReview(dialog) || !!state.playlistImportSavePending; $('playlist-import-save').textContent = busy ? 'Saving…' : 'Save to Created';
    let review = 'Paste songs, or load a playlist link, then review the details.';
    if ($('playlist-import-text').value.trim()) { try { const tracks = parsePlaylistImport($('playlist-import-text').value, dialog.previewTracks, $('playlist-import-country').value, dialog.platform); review = tracks.length + (tracks.length === 1 ? ' song ready to import.' : ' songs ready to import.'); } catch (error) { review = error.message; } }
    if (dialog.loading || dialog.autoTimer || dialog.pendingAutoKey) review = 'Loading the latest link before this list can be saved.';
    else if (playlistImportNeedsLinkReview(dialog)) review = 'The visible songs belong to the previous link. Load this link successfully, or edit the song list to keep it as a manual import.';
    if (state.playlistImportSavePending && !busy) review = 'A previous import is still finishing. You can review this list while it completes.';
    $('playlist-import-review').textContent = review;
  }
  function editPlaylistImport(event) {
    const dialog = state.playlistImport; if (!dialog || dialog.saving) return;
    const id = event && event.target && event.target.id;
    const changed = id === 'playlist-import-url' ? $('playlist-import-url').value.trim() !== dialog.detectedInputUrl : true;
    if (changed) ++dialog.revision;
    if (dialog.previewError) { dialog.previewError = false; $('playlist-import-status').textContent = ''; }
    if (changed && ['playlist-import-url', 'playlist-import-country'].includes(id)) { dialog.previewContextStale = true; if (dialog.preview) dialog.preview.previewId = null; }
    if (!id || id === 'playlist-import-text') dialog.songTextEdited = true;
    if (id === 'playlist-import-url') { detectPlaylistImportLink(dialog, true); schedulePlaylistImportLoad(); }
    else if (id === 'playlist-import-country') {
      dialog.detectedInputUrl = $('playlist-import-url').value.trim(); dialog.lastInputCountry = $('playlist-import-country').value;
      detectPlaylistImportLink(dialog, false); schedulePlaylistImportLoad();
    } else clearPlaylistImportAutoload(dialog);
    renderPlaylistImport();
  }
  async function loadPlaylistImport(options) {
    const dialog = state.playlistImport; if (!dialog || dialog.saving) return;
    const automatic = !!(options && options.automatic);
    if (dialog.loading) { const key = playlistImportLoadKey(dialog); if (automatic && key && (key !== dialog.requestKey || dialog.requestRevision !== dialog.revision)) dialog.pendingAutoKey = key; return; }
    clearPlaylistImportAutoload(dialog);
    const url = $('playlist-import-url').value.trim(); if (!url) return;
    detectPlaylistImportLink(dialog, true);
    const country = $('playlist-import-country').value; if (!countries.includes(country)) return;
    const key = playlistImportLoadKey(dialog);
    if (automatic && (!key || playlistImportHasSongEdits(dialog) || playlistImportHasCurrentPreview(dialog, key))) { renderPlaylistImport(); return; }
    if (!playlistImportLinkSupported(dialog.platform)) { $('playlist-import-status').textContent = 'Paste song details for this service; its playlist links are not supported yet.'; renderPlaylistImport(); return; }
    dialog.requestKey = key; dialog.requestRevision = dialog.revision;
    const source = dialog.platform, generation = dialog.generation, revision = dialog.revision; dialog.loading = true; dialog.previewError = false; $('playlist-import-status').textContent = 'Loading song details…'; renderPlaylistImport();
    try {
      const result = await api('/api/playlist-import/preview', { method: 'POST', body: JSON.stringify({ url: url, country: country }) });
      if (state.playlistImport !== dialog || generation !== state.playlistImportGeneration) return;
      if (source !== dialog.platform || revision !== dialog.revision || url !== $('playlist-import-url').value.trim() || country !== $('playlist-import-country').value) { $('playlist-import-status').textContent = 'Your edits were kept because the list changed while the link was loading. Load again to replace them.'; return; }
      const tracks = Array.isArray(result.tracks) ? result.tracks : []; if (tracks.length > 500) throw new Error('This preview contains more than 500 songs. Paste a list of up to 500 songs instead.');
      const actualSource = result.source === undefined ? source : playlistImportSource(result.source); if (!actualSource) throw new Error('The preview returned an unsupported music platform.'); dialog.platform = actualSource; $('playlist-import-platform').value = actualSource;
      if (!dialog.nativeNameEdited && actualSource !== 'youtube-music') $('playlist-import-native-name').value = importLineText(result.name).slice(0, 250);
      dialog.previewTracks = tracks.map(function (track) { return Object.assign({}, track, { title: importLineText(track.title), artist: importLineText(track.artist), source: actualSource }); });
      $('playlist-import-text').value = dialog.previewTracks.map(function (track) { return track.title + ' — ' + track.artist; }).join('\n'); dialog.autoText = $('playlist-import-text').value; dialog.songTextEdited = false; dialog.loadedKey = key; dialog.previewContextStale = false;
      const originalName = importLineText(result.name), currentName = $('playlist-import-name').value;
      if (originalName && !dialog.nameEdited && (!currentName.trim() || currentName === dialog.autoName)) {
        let defaultName = (playlistSourceName(actualSource) + ': ' + originalName).slice(0, 100);
        if (/[\uD800-\uDBFF]$/u.test(defaultName)) defaultName = defaultName.slice(0, -1);
        $('playlist-import-name').value = defaultName; dialog.autoName = defaultName;
      }
      const skipped = Number.isInteger(result.skipped) && result.skipped >= 0 ? result.skipped : 0; const total = Number.isInteger(result.total) && result.total >= tracks.length + skipped ? result.total : null; const partial = result.truncated === true || result.fullCountUnverified === true || total === null || total > tracks.length + skipped;
      dialog.preview = { previewId: typeof result.previewId === 'string' ? result.previewId : null, source: actualSource, name: importLineText(result.name), url: typeof result.url === 'string' ? result.url : url, inputUrl: url, country: country, total: total, truncated: partial, fullCountUnverified: result.fullCountUnverified === true || total === null, skipped: skipped, text: $('playlist-import-text').value };
      const missing = dialog.previewTracks.filter(function (track) { return !validQueueText(track.title) || !validQueueText(track.artist); }).length, review = dialog.previewTracks.filter(function (track) { return track.needsReview; }).length;
      const notes = Array.isArray(result.notes) ? result.notes.filter(function (note) { return typeof note === 'string'; }).join(' ') : typeof result.notes === 'string' ? result.notes : '';
      const loaded = total === null ? 'Loaded ' + tracks.length + ' visible entries. Full playlist count could not be verified; this may be a partial list.' : 'Loaded ' + tracks.length + ' of ' + total + ' entries.' + (partial ? ' This preview may be partial.' : '');
      $('playlist-import-status').textContent = loaded + ' ' + skipped + ' skipped by the source. ' + missing + ' need a title or artist.' + (review ? ' ' + review + ' marked for review.' : '') + (notes ? ' ' + notes : '') + ' Loaded from ' + playlistSourceName(actualSource) + '. Review the list before saving; paste any missing songs.';
    } catch (error) { if (state.playlistImport === dialog && generation === state.playlistImportGeneration) { dialog.previewError = true; $('playlist-import-status').textContent = error.message + (playlistImportNeedsLinkReview(dialog) ? ' The previous link’s songs were kept. Load this link again, or edit the song list to keep it as a manual import.' : ' You can still paste song details below.'); } }
    finally { if (state.playlistImport === dialog && generation === state.playlistImportGeneration) {
      dialog.loading = false; dialog.requestKey = ''; dialog.requestRevision = -1;
      const pending = dialog.pendingAutoKey; dialog.pendingAutoKey = ''; renderPlaylistImport();
      if (pending && pending === playlistImportLoadKey(dialog) && !playlistImportHasCurrentPreview(dialog, pending) && !playlistImportHasSongEdits(dialog)) Promise.resolve().then(function () { if (state.playlistImport === dialog) loadPlaylistImport({ automatic: true }); });
    } }
  }
  async function savePlaylistImport(event) {
    event.preventDefault(); const dialog = state.playlistImport; if (!dialog || dialog.saving || dialog.loading || dialog.autoTimer || dialog.pendingAutoKey || state.playlistImportSavePending) return;
    if (playlistImportNeedsLinkReview(dialog)) { $('playlist-import-status').textContent = 'The visible songs belong to the previous link. Load this link successfully, or edit the song list to keep it as a manual import.'; renderPlaylistImport(); return; }
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
    const accounts = connectedAccounts(), sources = ['all', 'local'].concat(accounts.map(function (account) { return account.source; }));
    const fingerprint = sources.join('|');
    if (fingerprint !== state.playlistAccountsFingerprint) {
      const old = state.playlistsSource; state.playlistAccountsFingerprint = fingerprint;
      if (!state.playlistSourceSaved) state.playlistsSource = accounts.length ? 'all' : 'local';
      const select = $('playlist-source'); select.replaceChildren();
      sources.forEach(function (source) { const option = element('option', '', playlistSourceName(source)); option.value = source; select.appendChild(option); });
      if (!sources.includes(state.playlistsSource)) { const option = element('option', '', playlistSourceName(state.playlistsSource) + ' · disconnected'); option.value = state.playlistsSource; option.disabled = true; select.appendChild(option); }
      select.value = state.playlistsSource;
      if (old !== state.playlistsSource || state.playlistsSource === 'all' || !sources.includes(state.playlistsSource)) {
        ++state.playlistGeneration; state.playlistsLoading = false; state.playlists = []; renderPlaylistCards();
        if (state.view === 'playlists') loadPlaylists();
      }
    }
    $('playlist-source').disabled = state.playlistBusy || state.queueBusy;
    $('playlist-connect-note').hidden = accounts.length > 0;
    $('playlists-refresh').disabled = state.playlistsLoading || state.playlistBusy;
    $('new-playlist-button').disabled = state.localMutationBusy;
    $('playlist-service-note').textContent = state.playlistsSource === 'local' ? 'Created here, saved on this computer. No music account is needed. Songs play through the streaming service selected for your Echo.' : state.playlistsSource === 'all' ? 'Created playlists and playlists from your connected accounts. Each card shows where it comes from.' : state.playlistsSource === 'youtube-music' ? 'YouTube shows accessible Google-account playlists, rather than your full YouTube Music library. Songs play through the streaming service selected for your Echo.' : 'Play a playlist through its own music service on your Echo. Keep that service linked in Alexa.';
    renderPlaylistActions();
  }
  async function loadPlaylists() {
    const source = state.playlistsSource; const generation = ++state.playlistGeneration;
    const sources = source === 'all' ? ['local'].concat(connectedAccounts().map(function (account) { return account.source; })) : [source];
    state.playlistsLoading = true; state.playlists = []; renderPlaylistCards(); renderPlaylistSources(); $('playlist-status').textContent = 'Loading your playlists…';
    const results = await Promise.allSettled(sources.map(function (item) { return item === 'local' ? api('/api/local-playlists') : api('/api/playlists?source=' + encodeURIComponent(item)); }));
    if (generation !== state.playlistGeneration || source !== state.playlistsSource) return;
    const failures = [], limited = []; state.playlists = [];
    results.forEach(function (result, index) {
      const itemSource = sources[index];
      if (result.status === 'fulfilled') { const value = result.value || {}; (Array.isArray(value.playlists) ? value.playlists : []).forEach(function (playlist) { state.playlists.push(Object.assign({}, playlist, { source: itemSource })); }); if (value.truncated) limited.push(playlistSourceName(itemSource)); }
      else failures.push(playlistSourceName(itemSource) + ': ' + (result.reason.message || 'Could not load playlists.'));
    });
    state.playlistsLoading = false; renderPlaylistCards(); renderPlaylistSources();
    $('playlist-status').textContent = failures.concat(limited.length ? ['More playlists may exist in ' + limited.join(', ') + '.'] : []).join(' ') || (state.playlists.length ? '' : source === 'local' ? 'No created playlists yet. Choose New playlist, or add a song from search.' : 'No playlists found. You can create one here.');
  }
  function playlistStillListed(playlist) { return state.playlists.some(function (item) { return item.source === playlist.source && item.id === playlist.id; }); }
  function renderPlaylistCards() {
    const grid = $('playlist-grid'); grid.replaceChildren();
    state.playlists.forEach(function (playlist) {
      const card = element('article', 'playlist-card'), source = playlist.source;
      const artwork = element('div', 'playlist-art'); setArtwork(artwork, playlistCover(playlist)); card.appendChild(artwork);
      const sourceBadge = element('span', 'playlist-source-badge', playlistSourceLabel(playlist)); card.appendChild(sourceBadge);
      card.appendChild(element('h2', '', playlist.name || playlist.title || 'Untitled playlist'));
      card.appendChild(element('p', '', (Number.isFinite(playlist.itemCount) ? playlist.itemCount + (playlist.itemCount === 1 ? ' song' : ' songs') : 'Playlist') + (source === 'local' && playlist.country ? ' · ' + countryName(playlist.country) : '')));
      const attribution = element('p', 'playlist-source-attribution'); renderPlaylistAttribution(playlist, attribution); card.appendChild(attribution);
      if (source === 'local' && playlist.origin && playlist.origin.url) { const generation = state.playlistGeneration; loadPlaylistSourceMetadata(playlist, function () { return generation === state.playlistGeneration && state.playlists.includes(playlist); }, function () { setArtwork(artwork, playlistCover(playlist)); sourceBadge.textContent = playlistSourceLabel(playlist); renderPlaylistAttribution(playlist, attribution); }); }
      const button = element('button', '', source === 'local' ? 'Open playlist ↗' : source === 'youtube-music' ? 'Preview songs ↗' : 'Play on ' + playlistSourceName(source) + ' ↗'); button.type = 'button'; button.dataset.playlistAction = ['local', 'youtube-music'].includes(source) ? 'preview' : 'play';
      button.addEventListener('click', function () { if (!playlistStillListed(playlist)) return; if (source === 'local') openLocalPlaylist(playlist.id); else if (source === 'youtube-music') previewPlaylist(playlist); else playNativePlaylist(playlist); }); card.appendChild(button);
      grid.appendChild(card);
    }); renderPlaylistActions();
  }
  function playlistOriginInfo(playlist) {
    if (!playlist) return null;
    if (playlist.source === 'local' || playlist.source === undefined) {
      const origin = playlist.origin;
      const source = origin && origin.source || playlist.importSource || playlist.importedSource;
      return source ? { source: source, name: origin && origin.name || '', url: playlistOriginalUrl(origin && origin.url), author: playlistSourceAuthor(origin && origin.author), artwork: safeUrl(origin && origin.artwork) || safeUrl(playlist.artwork) } : null;
    }
    return { source: playlist.source, name: playlist.title || playlist.name || '', url: playlistOriginalUrl(playlist.url), author: playlistSourceAuthor(playlist.author), artwork: safeUrl(playlist.artwork) };
  }
  function playlistOriginalUrl(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return '';
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; }
  }
  function playlistSourceAuthor(value) { return typeof value === 'string' && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim().slice(0, 250) : ''; }
  function renderPlaylistAttribution(playlist, container) {
    const origin = playlistOriginInfo(playlist); container.replaceChildren();
    if (origin && origin.author) container.appendChild(element('span', 'playlist-source-author', 'By ' + origin.author));
    if (origin && origin.url) { const link = element('a', 'playlist-source-link', 'Open original playlist ↗'); link.href = origin.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; container.appendChild(link); }
    container.hidden = !container.children.length;
  }
  function playlistSourceLabel(playlist) {
    const origin = playlistOriginInfo(playlist);
    return origin ? playlistSourceName(origin.source) + ' · ' + (origin.name || 'Original name unavailable') : 'Created here' + (playlist.country ? ' · ' + countryName(playlist.country) : '');
  }
  function playlistCover(playlist) { const origin = playlistOriginInfo(playlist); return origin && origin.artwork || safeUrl(playlist && playlist.artwork); }
  async function playlistSourceMetadata(playlist) {
    if (!playlist.origin || !safeUrl(playlist.origin.url)) return null;
    if (!(state.playlistSourceCache instanceof Map)) state.playlistSourceCache = new Map();
    const key = playlist.id + ':' + playlist.origin.url + ':' + (playlist.updatedAt || 0), saved = state.playlistSourceCache.get(key);
    if (saved && (saved.promise || saved.expires > Date.now())) return saved.promise || saved.value;
    const cached = {};
    cached.promise = (async function () {
      const release = await artworkSlot(); let value = null;
      try {
        const result = await api('/api/local-playlists/' + encodeURIComponent(playlist.id) + '/source');
        if (result.playlistId === playlist.id && result.origin && result.origin.source === playlist.origin.source && typeof result.origin.name === 'string' && result.origin.name.trim()) value = { origin: result.origin, artwork: safeUrl(result.artwork) || safeUrl(result.origin.artwork) };
      } catch (_) { /* The stored source name and music-note fallback stay available. */ }
      finally { release(); }
      delete cached.promise; cached.value = value; cached.expires = Date.now() + (value ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000); return value;
    }());
    state.playlistSourceCache.set(key, cached);
    while (state.playlistSourceCache.size > 200) state.playlistSourceCache.delete(state.playlistSourceCache.keys().next().value);
    return cached.promise;
  }
  async function loadPlaylistSourceMetadata(playlist, current, render) {
    const source = playlist.origin && playlist.origin.source, url = playlist.origin && playlist.origin.url, updatedAt = playlist.updatedAt;
    const value = await playlistSourceMetadata(playlist);
    if (!value || !selectionIsCurrent(current) || !playlist.origin || playlist.origin.source !== source || playlist.origin.url !== url || playlist.updatedAt !== updatedAt) return;
    playlist.origin = Object.assign({}, playlist.origin, value.origin);
    if (value.artwork) playlist.artwork = value.artwork;
    render();
  }
  function renderLocalPlaylistIdentity(playlist) {
    $('local-playlist-title').textContent = playlist.name || playlist.title;
    $('local-playlist-source').textContent = playlistSourceLabel(playlist);
    renderPlaylistAttribution(playlist, $('local-playlist-attribution'));
    setArtwork($('local-playlist-art'), playlistCover(playlist));
    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    $('local-playlist-meta').textContent = tracks.length + (tracks.length === 1 ? ' song' : ' songs') + ' · ' + countryName(playlist.country);
  }
  function songHandoffBusy() { return state.queueModeBusy || activePlayback() || state.pendingTrack !== null || !!state.playSubmissionPromise || state.queueBusy || state.playlistBusy || state.customCommandBusy || state.controlBusy || state.cancelBusy || state.deviceChanging || state.providerChanging; }
  function canQueueSong() { return !songHandoffBusy() && !state.providersLoading && selectedProvider().kind !== 'radio'; }
  function renderPlaylistActions() {
    document.querySelectorAll('[data-playlist-action]').forEach(function (button) { button.disabled = state.playlistBusy || state.localMutationBusy || (button.dataset.playlistAction === 'play' && (!canPlay() || songHandoffBusy())); });
    renderPreviewReadiness(); renderLocalReadiness(); renderSongActionReadiness();
  }
  async function playNativePlaylist(playlist) {
    if (!canPlay() || songHandoffBusy() || !['apple-music', 'spotify'].includes(playlist.source) || !playlistStillListed(playlist)) return;
    const source = playlist.source, deviceId = state.deviceId; state.playlistBusy = true; ++state.playbackEpoch; ++state.queueEpoch; updatePlayButtons();
    try { const result = await api('/api/play-playlist', { method: 'POST', body: JSON.stringify({ source: source, playlistId: playlist.id, deviceId: deviceId }) }); toast(result.message || 'Playlist request sent to your Echo.'); scheduleStatus(500); setTimeout(refreshPlayer, 1000); }
    catch (error) { toast(error.message, true); }
    finally { state.playlistBusy = false; updatePlayButtons(); }
  }
  async function previewPlaylist(playlist) {
    if (playlist.source !== 'youtube-music' || state.playlistBusy || !playlistStillListed(playlist)) return;
    const generation = ++state.playlistPreviewGeneration; state.playlistBusy = true; $('playlist-status').textContent = 'Loading playlist songs…'; renderPlaylistActions();
    try {
      const result = await api('/api/playlists/' + encodeURIComponent(playlist.id) + '?source=youtube-music');
      if (generation !== state.playlistPreviewGeneration) return;
      const value = result.playlist || result || {}; state.playlistPreview = { id: value.id || playlist.id, source: 'youtube-music', title: value.title || playlist.title, author: playlistSourceAuthor(value.author) || playlistSourceAuthor(playlist.author), artwork: safeUrl(value.artwork) || safeUrl(playlist.artwork), url: safeUrl(value.url) || safeUrl(playlist.url), tracks: (Array.isArray(value.tracks) ? value.tracks : []).slice(0, 500).map(function (track) { return { id: track.id, title: typeof track.title === 'string' ? track.title : '', artist: typeof track.artist === 'string' ? track.artist : '', artwork: safeUrl(track.artwork), needsReview: !!track.needsReview }; }), truncated: !!(result.truncated || value.truncated) };
      $('playlist-status').textContent = ''; renderPlaylistPreview();
    } catch (error) { if (generation === state.playlistPreviewGeneration) $('playlist-status').textContent = error.message; }
    finally { state.playlistBusy = false; renderPlaylistActions(); }
  }
  function renderPlaylistPreview() {
    const preview = state.playlistPreview; $('playlist-preview').hidden = !preview; const container = $('playlist-preview-tracks'); container.replaceChildren(); if (!preview) return;
    $('playlist-preview-title').textContent = preview.title; $('playlist-preview-source').textContent = playlistSourceLabel(preview); renderPlaylistAttribution(preview, $('playlist-preview-attribution')); setArtwork($('playlist-preview-art'), playlistCover(preview));
    preview.tracks.forEach(function (track, index) {
      const selection = function () { return { source: 'youtube-music', playlistId: preview.id, trackId: track.id, title: track.title.trim(), artist: track.artist.trim(), country: $('country-select').value }; }; const current = function () { return state.playlistPreview === preview && validQueueText(track.title) && validQueueText(track.artist); };
      const row = element('div', 'playlist-preview-row'); row.dataset.review = String(track.needsReview); const play = playlistSongArtwork(track, selection, current); row.appendChild(play);
      ['title', 'artist'].forEach(function (field) { const group = element('div', ''); const id = 'playlist-edit-' + field + '-' + index; const label = element('label', '', field === 'title' ? 'Song title' : 'Artist'); label.htmlFor = id; const input = element('input', ''); input.id = id; input.type = 'text'; input.maxLength = 250; input.value = track[field]; input.autocomplete = 'off'; if (field === 'artist') input.placeholder = 'Add the song’s artist'; input.addEventListener('input', function () { track[field] = input.value; play.setAttribute('aria-label', 'Play ' + (track.title || 'this song') + ' by ' + (track.artist || 'this artist') + ' on your Echo'); renderPreviewReadiness(); renderSongActionReadiness(); }); group.appendChild(label); group.appendChild(input); row.appendChild(group); });
      if (track.needsReview) row.appendChild(element('p', 'playlist-preview-review', 'Review this song’s title and artist.')); const actions = element('div', 'preview-song-actions'); actions.appendChild(songMenu(track, selection, current)); row.appendChild(actions); container.appendChild(row);
    }); renderPreviewReadiness(); renderSongActionReadiness();
  }
  function validQueueText(value) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 250 && !/[\u0000-\u001f\u007f]/u.test(value); }
  function renderPreviewReadiness() {
    const preview = state.playlistPreview; const radio = selectedProvider().kind === 'radio'; const missing = preview ? preview.tracks.filter(function (track) { return !validQueueText(track.title) || !validQueueText(track.artist); }).length : 0;
    $('start-playlist-queue').disabled = !preview || !preview.tracks.length || missing > 0 || !canPlay() || state.queueBusy || state.queueModeBusy || state.playlistBusy || state.customCommandBusy || state.deviceChanging || state.providerChanging || radio || activePlayback() || state.pendingTrack !== null;
    if (preview) $('playlist-preview-status').textContent = radio ? 'Choose Apple Music, Spotify, Amazon Music, or JioSaavn for an on-demand song queue.' : missing ? 'Add a valid title and artist for ' + missing + (missing === 1 ? ' song' : ' songs') + ' before starting.' : preview.truncated ? 'Showing up to 500 accessible songs from this playlist.' : preview.tracks.length + ' songs ready to request on your Echo.';
  }
  async function startPlaylistQueue(event) {
    event.preventDefault(); const preview = state.playlistPreview;
    if (!preview || !preview.tracks.length || !canPlay() || state.queueBusy || state.queueModeBusy || state.playlistBusy || state.customCommandBusy || state.deviceChanging || state.providerChanging || state.controlBusy || selectedProvider().kind === 'radio' || activePlayback() || state.pendingTrack !== null || preview.tracks.some(function (track) { return !validQueueText(track.title) || !validQueueText(track.artist); })) { renderPreviewReadiness(); return; }
    const payload = { source: 'youtube-music', playlistId: preview.id, deviceId: state.deviceId, providerId: state.providerId, country: $('country-select').value, edits: preview.tracks.map(function (track) { return { id: track.id, title: track.title.trim(), artist: track.artist.trim() }; }) };
    Object.assign(payload, queuePlaybackModes());
    state.queueBusy = true; ++state.queueEpoch; ++state.playbackEpoch; updatePlayButtons();
    const pending = (async function () { if (state.playSubmissionPromise) { try { await state.playSubmissionPromise; } catch (_) {} } return api('/api/queue', { method: 'POST', body: JSON.stringify(payload) }); }()); state.queueSubmissionPromise = pending;
    try { const result = await pending; ++state.queueEpoch; if (result.queue) applyQueue(result.queue, { fromMutation: true }); toggleQueue(true); toast(result.message || 'Playlist queue started.'); scheduleStatus(500); }
    catch (error) { toast(error.message, true); }
    finally { if (state.queueSubmissionPromise === pending) state.queueSubmissionPromise = null; state.queueBusy = false; updatePlayButtons(); renderQueue(); }
  }
  function queuePlaybackModes() {
    const queue = state.queue && state.queue.active ? state.queue : null;
    return { shuffle: queue && typeof queue.shuffle === 'boolean' ? queue.shuffle : !!state.shuffle, repeatAll: queue && typeof queue.repeatAll === 'boolean' ? queue.repeatAll : !!state.repeatAll };
  }
  function saveQueuePlaybackModes(modes) {
    const changed = state.shuffle !== modes.shuffle || state.repeatAll !== modes.repeatAll;
    state.shuffle = !!modes.shuffle; state.repeatAll = !!modes.repeatAll;
    if (changed) try { localStorage.setItem('echo-library-shuffle', String(state.shuffle)); localStorage.setItem('echo-library-repeat-all', String(state.repeatAll)); } catch (_) {}
  }
  function renderQueueModes() {
    const modes = queuePlaybackModes(), queue = state.queue && state.queue.active ? state.queue : null;
    const busy = !!(state.queueModeBusy || state.queueBusy || state.pendingTrack !== null || state.playSubmissionPromise || state.deviceChanging || state.providerChanging || state.controlBusy || state.customCommandBusy || state.playlistBusy || state.cancelBusy);
    [['shuffle-button', 'shuffle', 'Shuffle playlist'], ['repeat-all-button', 'repeatAll', 'Repeat all songs']].forEach(function (entry) {
      const button = $(entry[0]), active = modes[entry[1]];
      button.disabled = busy; button.setAttribute('aria-pressed', String(active)); button.setAttribute('aria-busy', String(!!state.queueModeBusy)); button.setAttribute('aria-label', entry[2]);
      button.classList.toggle('is-active', active);
      button.title = (entry[1] === 'shuffle' ? 'Shuffle' : 'Repeat all') + ': ' + (active ? 'on' : 'off') + '. ' + (queue ? 'Applies to this playlist queue.' : 'Applies to the next playlist queue.');
    });
  }
  async function toggleQueueMode(mode) {
    if (!['shuffle', 'repeatAll'].includes(mode)) return;
    const button = $(mode === 'shuffle' ? 'shuffle-button' : 'repeat-all-button'); renderQueueModes(); if (button.disabled) return;
    const modes = queuePlaybackModes(), value = !modes[mode], queue = state.queue && state.queue.active ? state.queue : null;
    if (!queue) { saveQueuePlaybackModes(Object.assign({}, modes, { [mode]: value })); renderQueueModes(); return; }
    const requestId = queue.id, writeId = ++state.queueModeWriteId;
    state.queueModeBusy = true; ++state.queueEpoch; renderQueueModes(); updatePlayButtons();
    try {
      const result = await api('/api/queue/mode', { method: 'POST', body: JSON.stringify(Object.assign({ requestId: requestId }, { [mode]: value })) });
      if (writeId !== state.queueModeWriteId || !state.queue || state.queue.id !== requestId) return;
      if (!result.queue || result.queue.id !== requestId) throw new Error('The queue changed. Refresh it before changing playback modes.');
      ++state.queueEpoch; applyQueue(result.queue, { fromMutation: true }); saveQueuePlaybackModes(queuePlaybackModes()); scheduleStatus(500);
    } catch (error) { if (writeId === state.queueModeWriteId) { toast(error.message || 'The playlist mode could not be changed.', true); scheduleStatus(0); } }
    finally { if (writeId === state.queueModeWriteId) { state.queueModeBusy = false; renderQueueModes(); updatePlayButtons(); } }
  }
  function queueReady() { return !!(state.queue && state.queue.active && state.queue.state === 'ready'); }
  function activeQueue() { return !!(state.queue && state.queue.active); }
  function applyQueue(queue, options) {
    const opts = options || {}; if (!opts.fromMutation && ((opts.queueEpoch !== undefined && opts.queueEpoch !== state.queueEpoch) || state.queueBusy || state.queueModeBusy || state.customCommandBusy)) return;
    if (queue && state.queue && queue.id === state.queue.id && !state.queue.active && queue.active && !opts.fromMutation) return;
    state.queue = queue || null;
    if (queue && queue.active && typeof queue.shuffle === 'boolean' && typeof queue.repeatAll === 'boolean') saveQueuePlaybackModes({ shuffle: queue.shuffle, repeatAll: queue.repeatAll });
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
    $('player-queue-warning').hidden = !(queue && queue.active && queue.warning); $('player-queue-warning').textContent = queue && queue.active ? queue.warning || '' : '';
    $('player-queue-button').setAttribute('aria-expanded', String(state.queueOpen)); $('player-queue-button').textContent = 'Queue' + (items.filter(function (item) { return item.state === 'pending'; }).length ? ' · ' + items.filter(function (item) { return item.state === 'pending'; }).length : '');
    $('queue-progress').hidden = !state.queueOpen;
    $('queue-title').textContent = queue ? queue.title || 'Your song queue' : 'Your song queue';
    const mismatch = queueReady() && (normalizeCountry(queue.country) !== $('country-select').value || queue.providerId !== state.providerId);
    const track = queue && queue.currentTrack; $('queue-track').textContent = track ? 'Current · ' + track.title + (track.artist ? ' · ' + track.artist : '') : '';
    $('queue-message').textContent = queue ? queue.message || ({ ready: 'Ready when you are. Select an Echo, then choose Start.', preparing: 'Preparing your playlist…', playing: 'Playing songs on your Echo.', paused: 'Queue paused.', needs_attention: 'The queue needs your attention.', completed: 'Queue completed.', cancelled: 'Automatic queue playback stopped.', error: 'The queue could not continue.' }[queue.state] || '') : 'Add a song from search or a playlist. Music already playing stays on your Echo.';
    if (queue && queue.warning && $('queue-message').textContent.indexOf(queue.warning) === -1) $('queue-message').textContent = queue.warning + ' ' + $('queue-message').textContent;
    if (mismatch) $('queue-message').textContent = 'Select ' + countryName(queue.country) + ' and ' + (queue.providerName || providerName(queue.providerId)) + ' to start this saved queue.';
    $('queue-provider').textContent = queue ? (queue.providerName ? 'Next songs: ' + queue.providerName + '. ' : '') + (queue.country ? 'Catalogue: ' + countryName(queue.country) + '. ' : '') + (queue.currentProviderName ? 'Current song service: ' + queue.currentProviderName + '.' : 'Reported playback appears in the player.') : '';
    const paused = queue && ['paused', 'needs_attention'].includes(queue.state), ready = queueReady(); $('queue-toggle').textContent = ready ? 'Start' : paused ? 'Resume' : 'Pause'; $('queue-toggle').dataset.action = ready ? 'start' : paused ? 'resume' : 'pause';
    ['queue-toggle', 'queue-next', 'queue-cancel'].forEach(function (id) { $(id).hidden = !queue || !queue.active; $(id).disabled = state.queueBusy || state.queueModeBusy || (state.customCommandBusy && id !== 'queue-cancel') || state.pendingTrack !== null || state.deviceChanging || state.providerChanging; });
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
    document.querySelectorAll('[data-queue-item-action]').forEach(function (button) { button.disabled = state.queueBusy || songHandoffBusy(); }); renderSongActionReadiness(); renderQueueModes();
  }
  async function queueControl(action) {
    if (!activeQueue() || state.queueBusy || state.queueModeBusy || (state.customCommandBusy && action !== 'clear') || state.pendingTrack !== null || state.deviceChanging || state.providerChanging) return;
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
    $('custom-command-submit').disabled = !available || state.customCommandBusy || state.queueBusy || state.queueModeBusy || state.controlBusy || state.cancelBusy || !$('custom-command-input').value.trim();
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
      const response = await fetch('/api/commands', { signal: controller.signal });
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
    if (modal && !wasModal && !$('playlist-save-dialog').open && !$('playlist-import-dialog').open && !$('playlist-sync-dialog').open && !$('right-sidebar').contains(document.activeElement)) $(state.sidebarTab + '-sidebar-tab').focus({ preventScroll: true });
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
    if (event.defaultPrevented || $('playlist-save-dialog').open || $('playlist-import-dialog').open || $('playlist-sync-dialog').open) return;
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
    if (!canPlay() || state.customCommandBusy || state.queueBusy || state.queueModeBusy || state.controlBusy || state.cancelBusy || state.deviceChanging) return;
    const deviceId = state.deviceId; const deviceName = selectedDevice().name; state.customCommandBusy = true; ++state.playbackEpoch; ++state.queueEpoch;
    renderCustomCommand(); updatePlayButtons(); renderPlayer(); renderQueue();
    try {
      if (state.playSubmissionPromise) { try { await state.playSubmissionPromise; } catch (_) {} }
      if (state.queueSubmissionPromise) { try { await state.queueSubmissionPromise; } catch (_) {} }
      const queueEpoch = state.queueEpoch, queueId = state.queue && state.queue.id;
      const result = await api('/api/command', { method: 'POST', body: JSON.stringify({ deviceId: deviceId, text: text }) }); ++state.playbackEpoch;
      if (deviceId === state.deviceId && queueEpoch === state.queueEpoch && (state.queue && state.queue.id) === queueId) {
        ++state.queueEpoch;
        if (Object.prototype.hasOwnProperty.call(result, 'queue') && (!result.queue || !queueId || result.queue.id === queueId)) applyQueue(result.queue, { fromMutation: true });
        if (Object.prototype.hasOwnProperty.call(result, 'playback')) applyPlayback(result.playback, { notify: false });
      }
      if ($('custom-command-input').value.trim() === text) $('custom-command-input').value = '';
      toast(result.message || 'Command sent to ' + deviceName + '.'); scheduleStatus(500); setTimeout(refreshPlayer, 1000);
      if (state.commandsOpen) { clearTimeout(state.commandsTimer); refreshCommands(); }
    } catch (error) { toast(error.message, true); }
    finally { state.customCommandBusy = false; renderCustomCommand(); updatePlayButtons(); renderPlayer(); renderQueue(); }
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
  ['spotify', 'youtube'].forEach(function (service) { $(service + '-setup-form').addEventListener('submit', function (event) { saveOAuthSetup(service, event); }); $(service + '-connect-button').addEventListener('click', function () { connectOAuth(service); }); $(service + '-disconnect-button').addEventListener('click', function () { disconnectOAuth(service); }); });
  $('search-tab').addEventListener('click', function () { setBrowseView('search'); }); $('playlists-tab').addEventListener('click', function () { setBrowseView('playlists'); });
  $('playlist-source').addEventListener('change', function () { state.playlistsSource = $('playlist-source').value; state.playlistSourceSaved = true; try { localStorage.setItem('echo-library-playlist-source', state.playlistsSource); } catch (_) {} ++state.playlistPreviewGeneration; state.playlistPreview = null; renderPlaylistPreview(); if (!['all', 'local'].includes(state.playlistsSource)) { ++state.localPlaylistGeneration; state.localPlaylist = null; renderLocalPlaylist(); } loadPlaylists(); }); $('playlists-refresh').addEventListener('click', loadPlaylists);
  $('playlist-preview-close').addEventListener('click', function () { ++state.playlistPreviewGeneration; state.playlistPreview = null; renderPlaylistPreview(); }); $('playlist-queue-form').addEventListener('submit', startPlaylistQueue);
  $('queue-toggle').addEventListener('click', function () { queueControl($('queue-toggle').dataset.action); }); $('queue-next').addEventListener('click', function () { queueControl('next'); }); $('queue-cancel').addEventListener('click', function () { queueControl('clear'); });
  $('player-queue-button').addEventListener('click', function () { toggleQueue(); });
  $('new-playlist-button').addEventListener('click', function () { openPlaylistDialog(null); });
  $('import-playlist-button').addEventListener('click', openPlaylistImport); $('playlist-import-close').addEventListener('click', closePlaylistImport);
  $('playlist-import-platform').addEventListener('change', function () { setPlaylistImportPlatform($('playlist-import-platform').value); });
  $('playlist-import-native-name').addEventListener('input', function () { if (state.playlistImport) state.playlistImport.nativeNameEdited = true; });
  $('playlist-import-name').addEventListener('input', function () { if (state.playlistImport) state.playlistImport.nameEdited = true; });
  $('playlist-import-load').addEventListener('click', loadPlaylistImport); $('playlist-import-form').addEventListener('submit', savePlaylistImport);
  ['playlist-import-text', 'playlist-import-country', 'playlist-import-url'].forEach(function (id) { $(id).addEventListener('input', editPlaylistImport); });
  $('playlist-import-dialog').addEventListener('cancel', function (event) { event.preventDefault(); closePlaylistImport(); });
  $('local-playlist-close').addEventListener('click', function () { ++state.localPlaylistGeneration; state.localPlaylist = null; renderLocalPlaylist(); });
  $('local-playlist-play').addEventListener('click', function () { playLocalPlaylist(); });
  $('local-playlist-native-play').addEventListener('click', playLocalPlaylistNative);
  $('local-playlist-rename').addEventListener('click', function () { if (state.localPlaylist) openPlaylistDialog(null, state.localPlaylist); });
  $('local-playlist-delete').addEventListener('click', deleteLocalPlaylist);
  $('local-playlist-sync').addEventListener('click', openPlaylistSync); $('playlist-sync-close').addEventListener('click', closePlaylistSync);
  $('playlist-sync-form').addEventListener('submit', applyPlaylistSync); $('playlist-sync-accept-partial').addEventListener('change', renderPlaylistSync);
  $('playlist-sync-dialog').addEventListener('cancel', function (event) { event.preventDefault(); closePlaylistSync(); });
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
  $('apple-connect-button').addEventListener('click', connectApple);
  $('apple-disconnect-button').addEventListener('click', disconnectApple);
  $('apple-setup-form').addEventListener('submit', saveAppleSetup);
  $('account-setup-shortcut').addEventListener('click', openSelectedCatalogueSetup);
  $('catalogue-account-badge').addEventListener('click', openCatalogueFromBadge);
  $('catalogue-platform-select').addEventListener('change', function () { chooseCataloguePlatform($('catalogue-platform-select').value, true); });
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
  $('search-form').addEventListener('submit', function (event) { event.preventDefault(); search($('search-input').value, { force: true }); });
  $('search-input').addEventListener('input', scheduleLiveSearch);
  $('search-input').addEventListener('compositionstart', function () { state.searchComposing = true; invalidateSearch(''); });
  $('search-input').addEventListener('compositionend', function () { state.searchComposing = false; scheduleLiveSearch(); });
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
  $('shuffle-button').addEventListener('click', function () { toggleQueueMode('shuffle'); });
  $('repeat-all-button').addEventListener('click', function () { toggleQueueMode('repeatAll'); });
  $('previous-button').addEventListener('click', function () { control('previous'); });
  $('next-button').addEventListener('click', function () { control('next'); });
  $('toggle-button').addEventListener('click', function () { control(state.player && state.player.state === 'PLAYING' ? 'pause' : 'resume'); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { refreshStatus(); refreshPlayer(); if (state.commandsOpen) refreshCommands(); } else { clearTimeout(state.commandsTimer); if (state.commandsController) state.commandsController.abort(); } });
  initMacMedia();
  renderCataloguePlatform(); renderProviders(); renderCatalogueSource(); renderApple(); renderSearchReadiness(); renderPlayback(); renderVolume(); renderSeek(); renderCustomCommand(); renderOAuth('spotify'); renderOAuth('youtube'); renderPlaylistSources(); renderQueue(); showOAuthCallbackNotice(); toggleCommands(true); refreshStatus(); refreshProviders(); setInterval(refreshPlayer, 5000); setInterval(renderSeek, 1000);
}());
