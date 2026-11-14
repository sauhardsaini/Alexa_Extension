import { randomUUID } from 'node:crypto';
import { AppError, COUNTRIES } from './catalog.mjs';
import { normalizeRequestMode } from './playback.mjs';
import { fallbackMusicProviders, resolveMusicProvider } from './music-providers.mjs';
import { normalizeCustomCommand } from './command-journal.mjs';
import { normalizeLocalTrack } from './local-playlists.mjs';
import { IMPORT_SOURCES, directPlaylistSource, parsePlaylistLink, normalizePlaylistOrigin } from './playlist-links.mjs';
import { importPublicPlaylist } from './public-playlist-imports.mjs';

/** Keeps local-origin/CSRF checks; an owner-issued capability authorizes paired extension requests. */
export function createLibraryHandler({ bridge, catalog, appleMusic = null, artistPreferences = null,
  playback = null, spotify = null, youtube = null, queue = null, localPlaylists = null, artworkResolver = null, playlistSourceResolver = null,
  publicPlaylistImporter = importPublicPlaylist, playlistImporter = null, port = 4320,
  authorizeRequest = () => false } = {}) {
  if (!bridge || !catalog) throw new Error('bridge and guarded catalogue required');
  const importPreviews = new Map(), syncPreviews = new Map();
  const safeSelectionText = (value, max = 250) => typeof value === 'string' && value.trim() && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
  const requireLocal = () => { if (!localPlaylists) throw new AppError(503, 'LOCAL_PLAYLISTS_UNAVAILABLE', 'Saved playlists are unavailable in this app session.'); return localPlaylists; };
  const requireQueue = () => { if (!queue) throw new AppError(503, 'QUEUE_UNAVAILABLE', 'The song queue is unavailable.'); return queue; };
  const requireCountry = value => { if (!COUNTRIES.has(value)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose a catalogue country before saving or queueing this song.'); return value; };
  const selectionId = value => { if (!safeSelectionText(value, 100)) throw new AppError(400, 'INVALID_SELECTION', 'Choose a song from the app before continuing.'); return value; };
  const queueModes = body => {
    for (const field of ['shuffle', 'repeatAll']) if (body[field] !== undefined && typeof body[field] !== 'boolean') throw new AppError(400, 'INVALID_QUEUE_MODE', 'Shuffle and Repeat All must be on or off.');
    return { ...(body.shuffle === undefined ? {} : { shuffle: body.shuffle }), ...(body.repeatAll === undefined ? {} : { repeatAll: body.repeatAll }) };
  };
  const queueContext = (body, { requireExistingId = false } = {}) => {
    const provider = resolveMusicProvider(body.providerId);
    if (!['music', 'default'].includes(provider.kind)) throw new AppError(400, 'INVALID_QUEUE_PROVIDER', 'Choose an on-demand music service for queued songs.');
    requireCountry(body.country);
    if (body.deviceId !== undefined && body.deviceId !== null) bridge.requireDevice(body.deviceId);
    if (body.queueId !== undefined) selectionId(body.queueId);
    const current = queue?.status();
    if (requireExistingId && current?.active && body.queueId === undefined) throw new AppError(409, 'QUEUE_CHANGED', 'Refresh the current queue before adding another song.');
    if (body.queueId !== undefined && current?.id !== body.queueId) throw new AppError(409, 'QUEUE_CHANGED', 'A newer queue replaced this selection.');
    return { deviceId: body.deviceId, providerId: provider.id, country: body.country, ...queueModes(body), ...(body.queueId !== undefined ? { queueId: body.queueId } : {}) };
  };
  const cancelBoundQueue = message => { const current = queue?.status(); if (current?.state !== 'ready' || current.deviceId) queue?.cancel(message); };
  const intentSnapshot = () => { const current = queue?.status(); return { intent: playback?.intent, queueId: current?.id, queueUpdatedAt: current?.updatedAt }; };
  const intentIsCurrent = before => { const current = queue?.status(); return (!playback || playback.intent === before.intent) && current?.id === before.queueId && current?.updatedAt === before.queueUpdatedAt; };
  const guardIntent = before => { if (!intentIsCurrent(before)) throw new AppError(409, 'PLAYBACK_CHANGED', 'A newer playback choice replaced this song selection.'); };
  async function preflightMusicRequest(providerId, before) {
    if (typeof bridge.requireMusicRequestProvider !== 'function') throw new AppError(503, 'MUSIC_REQUEST_UNAVAILABLE', 'The music request test is unavailable in this app session.');
    await bridge.requireMusicRequestProvider(providerId, { valid: () => intentIsCurrent(before) });
    guardIntent(before);
  }
  async function loadSourcePlaylist(link, country) {
    if (playlistImporter) return playlistImporter(link.url, country);
    const service = link.source === 'apple-music' ? appleMusic : link.source === 'spotify' ? spotify : link.source === 'youtube-music' ? youtube : null;
    if (['amazon-music', 'jiosaavn'].includes(link.source)) return publicPlaylistImporter(link.url, country);
    if (!service?.importPlaylist) throw new AppError(503, 'PLAYLIST_IMPORT_UNAVAILABLE', 'Link loading for this service is unavailable.');
    return service.importPlaylist(link.url, country);
  }
  function sourceOrigin(result, link, previous = null) {
    return normalizePlaylistOrigin({ source: link.source, name: result.name, url: link.url, artwork: result.artwork || previous?.artwork || null, author: (typeof result.author === 'string' && result.author.trim() && result.author.length <= 250 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(result.author) ? result.author : previous?.author), ...(previous?.playbackName ? { playbackName: previous.playbackName } : {}) });
  }
  const trackIdentity = track => JSON.stringify([track.source, track.url || '', track.title, track.artist]);
  function changesBetween(before, after) {
    const counts = new Map(); for (const track of before) { const id = trackIdentity(track); counts.set(id, (counts.get(id) || 0) + 1); }
    let added = 0;
    for (const track of after) { const id = trackIdentity(track), count = counts.get(id) || 0; if (count) counts.set(id, count - 1); else ++added; }
    return { added, removed: [...counts.values()].reduce((sum, count) => sum + count, 0) };
  }
  async function resolveSelection(selection, requestedCountry) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new AppError(400, 'INVALID_SELECTION', 'Choose a song from the app before continuing.');
    const country = requireCountry(requestedCountry ?? selection.country);
    if (selection.country !== undefined && selection.country !== country) throw new AppError(409, 'COUNTRY_MISMATCH', 'Choose a song saved for the selected catalogue country.');
    let track;
    if (selection.source === 'catalogue') {
      track = await catalog.prepareTrack(selectionId(selection.trackId), country);
      track = { ...track, source: catalog.selection?.().source || 'itunes' };
    } else if (selection.source === 'local') {
      track = requireLocal().getTrack(selectionId(selection.playlistId), selectionId(selection.entryId));
    } else if (selection.source === 'queue') {
      track = await requireQueue().getTrack(selectionId(selection.itemId), selectionId(selection.queueId));
    } else if (selection.source === 'youtube-music') {
      if (!youtube) throw new AppError(503, 'YOUTUBE_SETUP_REQUIRED', 'Connect YouTube to choose one of its playlist songs.');
      const playlist = await youtube.playlist(selectionId(selection.playlistId));
      const selected = playlist.tracks?.find(item => item.id === selectionId(selection.trackId));
      if (!selected) throw new AppError(400, 'EXPIRED_RESULT', 'Refresh the playlist and choose one of its songs.');
      if ((selection.title !== undefined && !safeSelectionText(selection.title)) || (selection.artist !== undefined && !safeSelectionText(selection.artist)) || (selected.needsReview && !safeSelectionText(selection.artist))) throw new AppError(400, 'QUEUE_REVIEW_REQUIRED', 'Review this song title and artist before saving or queueing it.');
      const title = selection.title ?? selected.title, artist = selection.artist ?? selected.artist;
      // Keep individual account credits unless the user replaces the artist.
      const artistChanged = selection.artist !== undefined && selection.artist !== selected.artist;
      track = { ...selected, title, artist, ...(artistChanged ? { requestArtist: artist, requestArtists: [artist] } : {}), source: 'youtube-music' };
    } else if (selection.source === 'player') {
      const expected = selection.expected;
      if (!expected || !safeSelectionText(expected.title, 500) || !safeSelectionText(expected.artist, 500) || (expected.mediaId !== undefined && !safeSelectionText(expected.mediaId, 2048))) throw new AppError(400, 'INVALID_TRACK', 'Refresh the current Echo song before choosing it.');
      bridge.requireDevice(selection.deviceId);
      const player = (await bridge.freshPlayer(selection.deviceId))?.player;
      const key = value => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
      if (!player || !['PLAYING', 'PAUSED'].includes(player.state) || !safeSelectionText(player.title, 500) || !safeSelectionText(player.artist, 500)
        || key(player.title) !== key(expected.title) || key(player.artist) !== key(expected.artist) || (expected.mediaId !== undefined && expected.mediaId !== player.mediaId)) throw new AppError(409, 'SONG_CHANGED', 'The Echo song changed. Refresh playback before choosing it.');
      track = { title: player.title, artist: player.artist, album: '', artwork: player.artwork, durationMs: Number.isSafeInteger(player.durationMs) && player.durationMs >= 0 ? player.durationMs : 0, source: 'player' };
    } else throw new AppError(400, 'INVALID_SELECTION_SOURCE', 'Choose a catalogue, saved playlist, queue or current Echo song.');
    if (track.country !== undefined && track.country !== country) throw new AppError(409, 'COUNTRY_MISMATCH', 'This saved song belongs to another catalogue country.');
    return { ...(track.id ? { id: track.id } : {}), ...normalizeLocalTrack({ ...track, country }, country) };
  }
  function safeMusicRequestDiagnostics(result) {
    if (!result || typeof result !== 'object' || !result.diagnostics || typeof result.diagnostics !== 'object') throw new AppError(502, 'MUSIC_REQUEST_CHECK_UNAVAILABLE', 'The music request validation could not be inspected.');
    const raw = result.diagnostics, types = new Set(['object', 'string', 'array', 'null', 'missing', 'number', 'boolean']);
    const type = value => types.has(value) ? value : 'missing';
    const fields = Array.isArray(raw.fields) ? raw.fields.slice(0, 32).filter(field => field && typeof field.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.name)).map(field => ({ name: field.name, type: type(field.type) })) : [];
    const checks = Object.fromEntries(['validationValid', 'payloadUsable', 'deviceMatches', 'deviceTypeMatches', 'customerMatches', 'localeMatches', 'providerMatches', 'searchPhraseMatches'].map(name => [name, raw.checks?.[name] === true]));
    return { requestMode: 'music-request-test', status: checks.validationValid && checks.payloadUsable ? 'validated' : 'not-valid', audioSent: false,
      message: 'Music request validation inspected. No audio was sent.',
      diagnostics: { responseType: type(raw.responseType), payloadType: type(raw.payloadType), previewPayloadType: type(raw.previewPayloadType),
        payloadBytes: Number.isSafeInteger(raw.payloadBytes) && raw.payloadBytes >= 0 && raw.payloadBytes <= 1000000 ? raw.payloadBytes : null,
        fields, fieldsTruncated: raw.fieldsTruncated === true || (Array.isArray(raw.fields) && raw.fields.length > 32), checks } };
  }
  return async function handleLibraryRequest(req, res) {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://js-cdn.music.apple.com; style-src 'self'; connect-src 'self' https://api.music.apple.com https://*.music.apple.com https://*.itunes.apple.com; frame-src https://*.music.apple.com https://*.itunes.apple.com; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const localPort = Number.isInteger(req.socket?.localPort) ? req.socket.localPort : port;
      const hosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
      const origins = new Set([...hosts].map(host => `http://${host}`));
      if (!hosts.has(req.headers.host)) throw new AppError(403, 'LOCAL_ONLY', 'Open this app through its localhost address.');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const authenticated = authorizeRequest(req) === true;
      const oauthCallback = req.method === 'GET' && ['/api/spotify/callback', '/api/youtube/callback'].includes(url.pathname);
      if (!oauthCallback && !authenticated && req.headers.origin && !origins.has(req.headers.origin)) throw new AppError(403, 'CROSS_ORIGIN', 'This request must come from the local app.');
      if (!oauthCallback && !authenticated && req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'CROSS_SITE', 'This request must come from the local app.');
      if (oauthCallback) {
        const source = url.pathname.includes('/spotify/') ? 'spotify' : 'youtube';
        const service = source === 'spotify' ? spotify : youtube;
        let result = 'connected', reason = '';
        try {
          if (!service) throw new AppError(503, 'ACCOUNT_SETUP_REQUIRED', 'This music account connection is unavailable.');
          await service.completeAuthorization({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error') });
          playback?.cancel('Music account connection changed.'); cancelBoundQueue('Music account connection changed.');
        } catch (error) { result = 'error'; reason = error instanceof AppError ? error.message : 'The music account could not be connected. Try again.'; }
        const params = new URLSearchParams({ musicAuth: source, result }); if (reason) params.set('reason', reason);
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/?${params}`, 'Cache-Control': 'no-store' }); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(200, { ...bridge.status(), playback: playback?.status() || null, queue: queue?.status() || null, spotify: spotify?.status() || { configured: false, connected: false, needsSetup: true, source: 'spotify' }, youtube: youtube?.status() || { configured: false, connected: false, needsSetup: true, source: 'youtube-music' }, catalogue: { source: catalog.selection?.().source || 'itunes' }, apple: appleMusic?.status() || { configured: false, connected: false, needsSetup: true, source: 'apple-music', storefront: null, message: 'Set up the Apple Music catalogue connection to verify country availability.' } });
      if (req.method === 'GET' && (url.pathname === '/api/playlists' || url.pathname.startsWith('/api/playlists/'))) {
        const source = url.searchParams.get('source');
        const service = source === 'apple-music' ? appleMusic : source === 'spotify' ? spotify : source === 'youtube-music' ? youtube : null;
        if (!service) throw new AppError(400, 'INVALID_PLAYLIST_SOURCE', 'Choose a connected music account.');
        return json(200, url.pathname === '/api/playlists' ? await service.playlists() : await service.playlist(decodeURIComponent(url.pathname.slice('/api/playlists/'.length))));
      }
      if (req.method === 'GET' && url.pathname === '/api/local-playlists') return json(200, { playlists: requireLocal().list() });
      const localPath = url.pathname.match(/^\/api\/local-playlists\/([A-Za-z0-9_-]{1,100})(?:\/(.*))?$/);
      if (req.method === 'GET' && localPath && !localPath[2]) return json(200, { playlist: requireLocal().get(localPath[1]) });
      if (req.method === 'GET' && localPath?.[2] === 'source') {
        const playlist = requireLocal().get(localPath[1]);
        const origin = playlistSourceResolver ? await playlistSourceResolver.resolve(playlist) : playlist.origin || null;
        return json(200, { playlistId: playlist.id, origin, artwork: origin?.artwork || null });
      }
      const artworkPath = localPath?.[2]?.match(/^tracks\/([A-Za-z0-9_-]{1,100})\/artwork$/);
      if (req.method === 'GET' && localPath && artworkPath) {
        const playlist = requireLocal().get(localPath[1]), track = requireLocal().getTrack(localPath[1], artworkPath[1]);
        return json(200, { entryId: artworkPath[1], artwork: artworkResolver ? await artworkResolver.resolve(track, playlist.country) : track.artwork || null });
      }
      if (req.method === 'GET' && url.pathname === '/api/queue/items') return json(200, { queue: requireQueue().status() });
      if (req.method === 'GET' && url.pathname === '/api/commands') return json(200, bridge.commands ? bridge.commands() : { commands: [], retention: 'session' });
      if (req.method === 'GET' && url.pathname === '/api/music-providers') {
        try { return json(200, bridge.musicProviders ? await bridge.musicProviders() : fallbackMusicProviders(bridge.status().settings.country)); }
        catch { return json(200, fallbackMusicProviders(bridge.status().settings.country)); }
      }
      if (req.method === 'GET' && url.pathname === '/api/apple/config') {
        if (!appleMusic) throw new AppError(503, 'APPLE_SETUP_REQUIRED', 'Set up the Apple Music catalogue connection first.');
        return json(200, appleMusic.publicConfig());
      }
      if (req.method === 'GET' && url.pathname === '/api/search') return json(200, await catalog.search(url.searchParams.get('q'), url.searchParams.get('country') || bridge.status().settings.country));
      if (req.method === 'GET' && url.pathname === '/api/player') {
        const deviceId = url.searchParams.get('deviceId'), before = intentSnapshot();
        const result = await bridge.player(deviceId, { fresh: url.searchParams.get('fresh') === '1' });
        // Player polls can confirm a manually started song after a queue failure.
        // This observes existing audio; it never sends a playback command.
        if (intentIsCurrent(before)) queue?.observePlayer?.(deviceId, result?.player);
        return json(200, result);
      }
      if (req.method === 'POST') {
        if ((!authenticated && req.headers['x-echo-app'] !== '1') || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(403, 'APP_REQUEST_REQUIRED', 'Please use the controls in the local app.');
        let raw = '';
        for await (const chunk of req) {
          raw += chunk.toString('utf8');
          if (Buffer.byteLength(raw) > (['/api/queue', '/api/play-selection', '/api/local-playlists/import'].includes(url.pathname) ? 524288 : url.pathname.startsWith('/api/apple/') ? 32768 : 8192)) throw new AppError(413, 'BODY_TOO_LARGE', 'This request is too large.');
        }
        let body;
        try { body = JSON.parse(raw); } catch { throw new AppError(400, 'INVALID_JSON', 'This request could not be read.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'INVALID_BODY', 'This request could not be read.');
        if (url.pathname === '/api/playlist-import/preview') {
          const selectedCountry = requireCountry(body.country), link = parsePlaylistLink(body.url, selectedCountry);
          const result = await loadSourcePlaylist(link, selectedCountry);
          const previewId = randomUUID(), tracks = result.tracks.map(track => ({ ...track, source: link.source, country: selectedCountry, imported: true }));
          for (const [id, preview] of importPreviews) if (preview.expires <= Date.now()) importPreviews.delete(id);
          while (importPreviews.size >= 20) importPreviews.delete(importPreviews.keys().next().value);
          importPreviews.set(previewId, { country: selectedCountry, origin: sourceOrigin(result, link), tracks: tracks.map(({ title, artist }) => ({ title, artist })), total: result.total, skipped: result.skipped, truncated: result.truncated === true, expires: Date.now() + 10 * 60_000 });
          return json(200, { ...result, source: link.source, url: link.url, previewId, country: selectedCountry, tracks, availability: 'unverified' });
        }
        if (url.pathname === '/api/local-playlists/import') {
          requireCountry(body.country);
          if (!Array.isArray(body.tracks) || body.tracks.some(track => !track || typeof track !== 'object' || Array.isArray(track) || !IMPORT_SOURCES.has(track.source))) throw new AppError(400, 'INVALID_PLAYLIST_IMPORT', 'Review the imported song titles and artists before saving.');
          let origin, originUnchanged = false;
          if (body.previewId !== undefined) {
            const preview = typeof body.previewId === 'string' && importPreviews.get(body.previewId);
            if (!preview || preview.expires <= Date.now()) throw new AppError(409, 'PLAYLIST_PREVIEW_EXPIRED', 'Load the playlist link again before saving its original service details. Your song list is still here.');
            if (preview.country !== body.country || body.tracks.some(track => track.source !== preview.origin.source)) throw new AppError(409, 'PLAYLIST_PREVIEW_CHANGED', 'The playlist source or country changed. Load the link again, or save a pasted song list.');
            origin = preview.origin;
            originUnchanged = !preview.truncated && preview.skipped === 0 && preview.total === body.tracks.length && preview.tracks.length === body.tracks.length && body.tracks.every((track, index) => track.title === preview.tracks[index].title && track.artist === preview.tracks[index].artist);
          }
          if (body.nativeName !== undefined) {
            const source = body.tracks[0]?.source;
            if (!directPlaylistSource(source) || body.tracks.some(track => track.source !== source) || !safeSelectionText(body.nativeName)) throw new AppError(400, 'INVALID_PLAYLIST_ORIGIN', 'Enter the playlist name as it exists on the selected music service.');
            origin = origin ? { ...origin, playbackName: body.nativeName.trim() } : { source, name: body.nativeName.trim(), playbackName: body.nativeName.trim(), url: null };
          }
          return json(201, { playlist: requireLocal().importTracks({ name: body.name, country: body.country, tracks: body.tracks, ...(origin ? { origin, originUnchanged } : {}) }), availability: 'unverified' });
        }
        if (url.pathname === '/api/local-playlists') return json(201, { playlist: requireLocal().create(body) });
        if (localPath) {
          const store = requireLocal(), id = localPath[1], action = localPath[2] || '';
          if (action === 'sync-preview') {
            const playlist = store.get(id);
            if (!playlist.origin?.url) throw new AppError(409, 'PLAYLIST_SOURCE_REQUIRED', 'This playlist has no source link to sync. Import a playlist link first.');
            const link = parsePlaylistLink(playlist.origin.url, playlist.country), result = await loadSourcePlaylist(link, playlist.country);
            const current = store.get(id);
            if (current.updatedAt !== playlist.updatedAt || current.origin?.url !== playlist.origin.url) throw new AppError(409, 'PLAYLIST_SYNC_CHANGED', 'This playlist changed while its source was loading. Preview it again.');
            if (!Array.isArray(result.tracks) || result.tracks.length > 500) throw new AppError(400, 'INVALID_PLAYLIST_SYNC', 'The source must contain at most 500 songs.');
            const tracks = result.tracks.map(track => normalizeLocalTrack({ ...track, source: link.source, country: playlist.country, imported: true }, playlist.country));
            const total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : null, skipped = Number.isSafeInteger(result.skipped) && result.skipped >= 0 ? result.skipped : 0;
            const requiresPartialConfirmation = result.truncated === true || total === null || skipped > 0 || total !== tracks.length;
            const previewId = randomUUID(), expiresAt = Date.now() + 10 * 60_000, origin = sourceOrigin(result, link, playlist.origin);
            const warnings = Array.isArray(result.notes) ? result.notes.filter(note => safeSelectionText(note, 1000)).slice(0, 12) : [];
            if (requiresPartialConfirmation) warnings.unshift('The source did not provide a complete verified song count. Applying this preview replaces the saved playlist with only the returned songs.');
            for (const [key, preview] of syncPreviews) if (preview.expiresAt <= Date.now()) syncPreviews.delete(key);
            while (syncPreviews.size >= 20) syncPreviews.delete(syncPreviews.keys().next().value);
            syncPreviews.set(previewId, { playlistId: id, expectedUpdatedAt: playlist.updatedAt, country: playlist.country, sourceUrl: playlist.origin.url, tracks, origin, requiresPartialConfirmation, expiresAt });
            return json(200, { previewId, playlistId: id, sourceName: origin.name, source: origin.source, artwork: origin.artwork || null, oldCount: playlist.tracks.length, newCount: tracks.length, ...changesBetween(playlist.tracks, tracks), total, skipped, truncated: requiresPartialConfirmation, requiresPartialConfirmation, warnings, expiresAt });
          }
          if (action === 'sync') {
            const preview = typeof body.previewId === 'string' && syncPreviews.get(body.previewId);
            if (!preview || preview.playlistId !== id || preview.expiresAt <= Date.now()) throw new AppError(409, 'PLAYLIST_SYNC_EXPIRED', 'This sync preview is invalid or expired. Load the latest source again.');
            const playlist = store.get(id);
            if (playlist.updatedAt !== preview.expectedUpdatedAt || playlist.country !== preview.country || playlist.origin?.url !== preview.sourceUrl) throw new AppError(409, 'PLAYLIST_SYNC_CHANGED', 'This playlist changed after the preview. Load its source again.');
            if (preview.requiresPartialConfirmation && body.acceptPartial !== true) throw new AppError(409, 'PLAYLIST_SYNC_PARTIAL_CONFIRMATION', 'Confirm that you want to replace the saved playlist with this partial source preview.');
            const synced = store.sync(id, { expectedUpdatedAt: preview.expectedUpdatedAt, tracks: preview.tracks, origin: preview.origin, originUnchanged: !preview.requiresPartialConfirmation });
            syncPreviews.delete(body.previewId);
            return json(200, { playlist: synced, availability: 'unverified', message: 'Playlist synced from ' + preview.origin.name + '. A backup of the previous copy was saved locally.' });
          }
          if (action === 'rename') return json(200, { playlist: store.rename(id, body.name) });
          if (action === 'delete') return json(200, store.delete(id));
          if (action === 'tracks') {
            const playlist = store.get(id), track = await resolveSelection(body.selection, playlist.country);
            return json(200, { playlist: store.add(id, track) });
          }
          const entryAction = action.match(/^tracks\/([A-Za-z0-9_-]{1,100})\/(remove|move)$/);
          if (entryAction) return json(200, { playlist: entryAction[2] === 'remove' ? store.removeTrack(id, entryAction[1]) : store.moveTrack(id, entryAction[1], body.direction) });
          if (action === 'play-native') {
            const playlist = store.get(id), provider = resolveMusicProvider(body.providerId); requireCountry(body.country); bridge.requireDevice(body.deviceId);
            if (playlist.country !== body.country) throw new AppError(409, 'COUNTRY_MISMATCH', 'Select the country saved with this playlist before playing it.');
            if (!playlist.origin || !directPlaylistSource(playlist.origin.source) || provider.kind !== 'music' || playlist.origin.source !== provider.id) throw new AppError(409, 'PLAYLIST_SERVICE_MISMATCH', 'Choose this playlist’s original streaming service to play it directly, or play the saved songs through the app queue.');
            const original = { source: playlist.origin.source, title: playlist.origin.playbackName || playlist.origin.name, personal: false };
            queue?.cancel('Replaced by your direct playlist request.');
            const result = await (playback ? playback.nativePlaylist(body.deviceId, original) : bridge.playPlaylist(original, body.deviceId));
            return json(202, { ...result, mode: 'native-playlist' });
          }
          if (action === 'play') {
            const playlist = store.get(id), context = queueContext(body); bridge.requireDevice(body.deviceId);
            if (playlist.country !== context.country) throw new AppError(409, 'COUNTRY_MISMATCH', 'Select the country saved with this playlist before playing it.');
            if (body.startEntryId !== undefined) selectionId(body.startEntryId);
            return json(202, requireQueue().startLocal({ playlist, ...context, ...(body.startEntryId !== undefined ? { startEntryId: body.startEntryId } : {}) }));
          }
        }
        if (url.pathname === '/api/music-request-check') {
          const provider = resolveMusicProvider(body.providerId); normalizeRequestMode('music-request-test', provider.id); requireCountry(body.country); bridge.requireDevice(body.deviceId);
          if (typeof bridge.inspectMusicRequestTest !== 'function') throw new AppError(503, 'MUSIC_REQUEST_CHECK_UNAVAILABLE', 'Music request diagnostics are unavailable in this app session.');
          if (body.selection !== undefined && body.trackId !== undefined) throw new AppError(400, 'INVALID_SELECTION', 'Choose one song selection to inspect.');
          const before = intentSnapshot(), selection = body.selection ?? { source: 'catalogue', trackId: selectionId(body.trackId), country: body.country };
          const track = await resolveSelection(selection, body.country); guardIntent(before);
          const result = await bridge.inspectMusicRequestTest(track, body.deviceId, provider.id, { valid: () => intentIsCurrent(before) }); guardIntent(before);
          return json(200, safeMusicRequestDiagnostics(result));
        }
        if (url.pathname === '/api/play-selection') {
          const provider = resolveMusicProvider(body.providerId), requestMode = normalizeRequestMode(body.requestMode, provider.id); requireCountry(body.country); bridge.requireDevice(body.deviceId);
          const before = intentSnapshot();
          if (requestMode === 'music-request-test') await preflightMusicRequest(provider.id, before);
          const selection = body.selection;
          if (selection?.source === 'local') {
            const context = queueContext(body);
            await resolveSelection(selection, body.country); guardIntent(before);
            const playlist = requireLocal().get(selectionId(selection.playlistId));
            if (playlist.country !== body.country) throw new AppError(409, 'COUNTRY_MISMATCH', 'Select the country saved with this playlist before playing it.');
            return json(202, { ...requireQueue().startLocal({ playlist, ...context, startEntryId: selectionId(selection.entryId), requestMode }), status: 'sent', mode: 'playlist-queue' });
          }
          if (selection?.source === 'youtube-music') {
            const context = queueContext(body), selectedQueue = requireQueue();
            if (selection.country !== undefined && selection.country !== body.country) throw new AppError(409, 'COUNTRY_MISMATCH', 'Choose a song saved for the selected catalogue country.');
            if (!youtube) throw new AppError(503, 'YOUTUBE_SETUP_REQUIRED', 'Connect YouTube to choose one of its playlist songs.');
            const playlist = await youtube.playlist(selectionId(selection.playlistId)); guardIntent(before);
            const trackId = selectionId(selection.trackId), edits = selection.edits ?? [];
            if (!Array.isArray(edits) || edits.length > 500) throw new AppError(400, 'INVALID_QUEUE_EDITS', 'Review at most 500 playlist songs at a time.');
            const selectedEdit = { id: trackId };
            for (const field of ['title', 'artist']) if (selection[field] !== undefined) {
              if (!safeSelectionText(selection[field])) throw new AppError(400, 'QUEUE_REVIEW_REQUIRED', 'Review this song title and artist before starting the queue.');
              selectedEdit[field] = selection[field];
            }
            const reviewed = edits.map(edit => edit?.id === trackId ? { ...edit, ...selectedEdit } : edit);
            if (Object.keys(selectedEdit).length > 1 && !reviewed.some(edit => edit?.id === trackId)) reviewed.push(selectedEdit);
            return json(202, { ...selectedQueue.start({ playlist, ...context, startTrackId: trackId, edits: reviewed, requestMode }), status: 'sent', mode: 'playlist-queue' });
          }
          const track = await resolveSelection(selection, body.country); guardIntent(before);
          queue?.cancel('Replaced by your song selection.');
          if (playback) { const reservation = playback.reserve({ deviceId: body.deviceId, providerId: provider.id, country: body.country, trackHint: track, requestMode }); return json(202, playback.start(reservation, track)); }
          const pendingIntent = intentSnapshot();
          return json(202, { ...await bridge.play(track, body.deviceId, provider.id, { requestMode, valid: () => intentIsCurrent(pendingIntent) }), requestId: randomUUID() });
        }
        if (url.pathname === '/api/queue/items') {
          requireQueue();
          if (!['next', 'last'].includes(body.placement)) throw new AppError(400, 'INVALID_QUEUE_PLACEMENT', 'Choose Play next or Add to queue.');
          const context = queueContext(body, { requireExistingId: true }), before = intentSnapshot(), track = await resolveSelection(body.selection, context.country); guardIntent(before);
          return json(202, await queue.enqueue({ track, placement: body.placement, ...context }));
        }
        const queueItemPath = url.pathname.match(/^\/api\/queue\/items\/([A-Za-z0-9_-]{1,100})\/(remove|move)$/);
        if (queueItemPath) {
          const activeQueue = requireQueue(), queueId = selectionId(body.queueId);
          return json(200, queueItemPath[2] === 'remove' ? activeQueue.remove({ itemId: queueItemPath[1], queueId }) : activeQueue.move({ itemId: queueItemPath[1], beforeItemId: body.beforeItemId, queueId }));
        }
        if (url.pathname.startsWith('/api/spotify/') || url.pathname.startsWith('/api/youtube/')) {
          const source = url.pathname.startsWith('/api/spotify/') ? 'spotify' : 'youtube';
          const service = source === 'spotify' ? spotify : youtube;
          if (!service) throw new AppError(503, 'ACCOUNT_SETUP_REQUIRED', 'This music account connection is unavailable.');
          const action = url.pathname.split('/')[3];
          if (['setup', 'connect', 'disconnect'].includes(action)) {
            const result = action === 'setup' ? { [source]: await service.configure(body) } : action === 'connect' ? await service.beginAuthorization() : { [source]: service.disconnect() };
            cancelBoundQueue('Music account connection changed.'); playback?.cancel('Music account connection changed.');
            return json(200, result);
          }
        }
        if (url.pathname === '/api/cancel-playback') {
          if (body.requestId !== undefined && (typeof body.requestId !== 'string' || body.requestId.length > 100 || !body.requestId)) throw new AppError(400, 'INVALID_REQUEST_ID', 'Choose the current song request.');
          const q = queue?.status(), music = playback?.status();
          const ownsQueue = !!q && (body.requestId === q.id || body.requestId === q.playbackRequestId);
          if (!body.requestId || ownsQueue) queue?.cancel('Automatic playlist requests cancelled.');
          let cancelled = playback?.status() || null;
          if (!body.requestId) cancelled = playback?.cancel('Song checking and further attempts cancelled.') || null;
          else if (ownsQueue) {
            if (q.playbackRequestId && music?.id === q.playbackRequestId) cancelled = playback?.cancel('Song checking and further attempts cancelled.', q.playbackRequestId) || null;
          } else if (!q?.active || (music?.active && music.id === body.requestId)) cancelled = playback?.cancel('Song checking and further attempts cancelled.', body.requestId) || null;
          return json(200, { playback: cancelled, queue: queue?.status() || null });
        }
        if (url.pathname === '/api/connect') { const ready = queue?.status(); playback?.cancel('Echo connection changed.'); if (ready?.state !== 'ready' || ready.deviceId) queue?.cancel('Echo connection changed.'); return json(202, await bridge.connect({ region: body.region, locale: body.locale })); }
        if (url.pathname === '/api/disconnect') { const ready = queue?.status(); playback?.cancel('Echo disconnected.'); if (ready?.state !== 'ready' || ready.deviceId) queue?.cancel('Echo disconnected.'); return json(200, bridge.disconnect()); }
        if (url.pathname.startsWith('/api/apple/')) {
          if (!appleMusic) throw new AppError(503, 'APPLE_SETUP_REQUIRED', 'Set up the Apple Music catalogue connection first.');
          if (['/api/apple/setup', '/api/apple/connect', '/api/apple/disconnect'].includes(url.pathname)) {
            const apple = url.pathname === '/api/apple/setup' ? await appleMusic.configure(body) : url.pathname === '/api/apple/connect' ? await appleMusic.authorize(body.musicUserToken) : appleMusic.disconnect();
            cancelBoundQueue('Catalogue connection changed.'); playback?.cancel('Catalogue connection changed.');
            return json(200, { apple });
          }
        }
        if (url.pathname === '/api/queue') {
          if (!queue || !youtube) throw new AppError(503, 'QUEUE_UNAVAILABLE', 'The imported playlist queue is unavailable.');
          if (body.source !== 'youtube-music') throw new AppError(400, 'INVALID_QUEUE_SOURCE', 'Choose an imported YouTube playlist.');
          resolveMusicProvider(body.providerId);
          if (!COUNTRIES.has(body.country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose the catalogue country before starting a queue.');
          bridge.requireDevice(body.deviceId);
          const edits = body.edits ?? [];
          if (!Array.isArray(edits) || edits.length > 500) throw new AppError(400, 'INVALID_QUEUE_EDITS', 'Review at most 500 playlist songs at a time.');
          for (const edit of edits) {
            if (!edit || typeof edit !== 'object' || typeof edit.id !== 'string' || !edit.id || edit.id.length > 100 || normalizeCustomCommand(edit.title).length > 250 || normalizeCustomCommand(edit.artist).length > 250) throw new AppError(400, 'INVALID_QUEUE_EDITS', 'Review each song title and artist before starting.');
          }
          const before = intentSnapshot();
          const playlist = await youtube.playlist(body.playlistId);
          guardIntent(before);
          return json(202, queue.start({ playlist, deviceId: body.deviceId, providerId: body.providerId, country: body.country, edits, ...queueModes(body) }));
        }
        if (url.pathname === '/api/queue/mode') {
          return json(200, requireQueue().mode({ requestId: selectionId(body.requestId), shuffle: body.shuffle, repeatAll: body.repeatAll }));
        }
        if (url.pathname === '/api/queue/control') {
          if (!queue) throw new AppError(503, 'QUEUE_UNAVAILABLE', 'The imported playlist queue is unavailable.');
          if (body.requestId !== undefined && (typeof body.requestId !== 'string' || body.requestId !== queue.status()?.id)) throw new AppError(409, 'QUEUE_CHANGED', 'A newer queue replaced this control.');
          return json(202, await queue.control(body.action, { queueId: body.queueId, requestId: body.requestId, deviceId: body.deviceId, providerId: body.providerId, country: body.country }));
        }
        if (url.pathname === '/api/play-playlist') {
          const service = body.source === 'apple-music' ? appleMusic : body.source === 'spotify' ? spotify : null;
          if (!service) throw new AppError(400, 'INVALID_PLAYLIST_SOURCE', 'Choose an Apple Music or Spotify playlist.');
          bridge.requireDevice(body.deviceId);
          const before = intentSnapshot();
          const playlist = await service.playlist(body.playlistId);
          guardIntent(before);
          queue?.cancel('Replaced by your native playlist selection.');
          return json(202, await (playback ? playback.nativePlaylist(body.deviceId, playlist) : bridge.playPlaylist(playlist, body.deviceId)));
        }
        if (url.pathname === '/api/command') {
          const text = normalizeCustomCommand(body.text);
          bridge.requireDevice(body.deviceId);
          if (typeof queue?.customCommand === 'function') return json(202, await queue.customCommand(body.deviceId, text));
          queue?.cancel('Replaced by your custom command.');
          return json(202, await (playback ? playback.customCommand(body.deviceId, text) : bridge.sendTextCommand(text, body.deviceId)));
        }
        if (url.pathname === '/api/play') {
          const provider = resolveMusicProvider(body.providerId), requestMode = normalizeRequestMode(body.requestMode, provider.id);
          if (!COUNTRIES.has(body.country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose the catalogue country, then search again before playing a song.');
          if (playback) {
            const hint = catalog.getTrack(body.trackId, body.country);
            bridge.requireDevice(body.deviceId);
            if (requestMode === 'music-request-test') await preflightMusicRequest(provider.id, intentSnapshot());
            queue?.cancel('Replaced by your song selection.');
            const reservation = playback.reserve({ deviceId: body.deviceId, country: body.country, trackHint: hint, providerId: provider.id, requestMode });
            try {
              const track = await catalog.prepareTrack(body.trackId, body.country);
              return json(202, playback.start(reservation, track));
            } catch (error) { playback.failReservation(reservation); throw error; }
          }
          const preparationIntent = requestMode === 'music-request-test' ? intentSnapshot() : null;
          if (preparationIntent) { bridge.requireDevice(body.deviceId); await preflightMusicRequest(provider.id, preparationIntent); }
          const track = await catalog.prepareTrack(body.trackId, body.country);
          if (preparationIntent) guardIntent(preparationIntent);
          const requestTrack = artistPreferences ? artistPreferences.apply(track, body.country) : track;
          const pendingIntent = preparationIntent || intentSnapshot();
          return json(202, { ...await bridge.play(requestTrack, body.deviceId, provider.id, { requestMode, valid: () => intentIsCurrent(pendingIntent) }), requestId: randomUUID() });
        }
        if (url.pathname === '/api/seek') {
          const q = queue?.status();
          return json(202, await (q?.active && q.deviceId === body.deviceId
            ? queue.seek(body.deviceId, body.positionMs, body.expected)
            : playback ? playback.seek(body.deviceId, body.positionMs, body.expected)
              : bridge.seek(body.deviceId, body.positionMs, body.expected)));
        }
        if (url.pathname === '/api/volume') return json(202, await (playback ? playback.setVolume(body.deviceId, body.volume) : bridge.setVolume(body.deviceId, body.volume)));
        if (url.pathname === '/api/control') {
          bridge.requireDevice(body.deviceId);
          if (!['pause', 'resume', 'next', 'previous'].includes(body.action)) throw new AppError(400, 'INVALID_ACTION', 'Choose a supported playback control.');
          const q = queue?.status();
          if (q?.active && q.deviceId === body.deviceId) return json(202, await queue.control(body.action));
          if (q?.active && q.state !== 'ready') queue.cancel('Playback moved to another Echo.');
          return json(202, await (playback ? playback.control(body.deviceId, body.action) : bridge.control(body.deviceId, body.action)));
        }
      }
      json(404, { error: 'NOT_FOUND', message: 'This page was not found.' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      // Only explicitly authored messages reach the client; raw upstream errors may contain secrets.
      if (error instanceof AppError) return json(error.status, { error: error.code, message: error.message });
      json(500, { error: 'INTERNAL_ERROR', message: 'Something went wrong locally. Please try again.' });
    }
  };
}
