import { normalizeReleaseYear } from './track-release.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, COUNTRIES } from './catalog.mjs';
import { IMPORT_SOURCES, normalizePlaylistOrigin } from './playlist-links.mjs';
import { normalizeArtworkTemplate } from './track-artwork.mjs';

const MAX_PLAYLISTS = 100, MAX_TRACKS = 500, MAX_TOTAL = 10000, MAX_BYTES = 32 * 1024 * 1024;
const sources = new Set(['itunes', 'player', ...IMPORT_SOURCES]);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text = (value, max = 250) => typeof value === 'string' && value.trim() && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
const copy = value => structuredClone(value);
const invalidTrack = () => new AppError(400, 'INVALID_LOCAL_TRACK', 'Choose a song with a valid title, artist and catalogue country.');
const missing = () => new AppError(404, 'LOCAL_PLAYLIST_NOT_FOUND', 'This saved playlist no longer exists. Refresh your playlists.');
const missingTrack = () => new AppError(404, 'LOCAL_TRACK_NOT_FOUND', 'This song is no longer in the saved playlist. Refresh the playlist.');
const unreadable = () => new AppError(500, 'LOCAL_PLAYLISTS_UNREADABLE', 'The saved playlists could not be read. Your saved file has been preserved.');
function country(value) { if (!COUNTRIES.has(value)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose a catalogue country for this playlist.'); return value; }
function name(value) { if (!text(value, 100)) throw new AppError(400, 'INVALID_PLAYLIST_NAME', 'Use a playlist name of 1 to 100 characters.'); return value.trim(); }
function safeUrl(value, artwork = false) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(artwork ? normalizeArtworkTemplate(value) : value);
    const allowed = artwork ? ['mzstatic.com', 'scdn.co', 'spotifycdn.com', 'saavncdn.com', 'aiv-cdn.net', 'ytimg.com', 'googleusercontent.com', 'ggpht.com', 'media-amazon.com', 'ssl-images-amazon.com'] : ['music.apple.com', 'itunes.apple.com', 'open.spotify.com', 'youtube.com', 'youtu.be', 'jiosaavn.com', 'music.amazon.in', 'music.amazon.com', 'music.amazon.co.uk', 'music.amazon.de', 'music.amazon.ca', 'music.amazon.com.au', 'music.amazon.co.jp'];
    if (url.protocol !== 'https:' || url.username || url.password || !allowed.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return null;
    const songId = url.searchParams.get('i'), videoId = url.searchParams.get('v');
    url.search = ''; url.hash = '';
    if (!artwork && url.hostname.endsWith('apple.com') && /^\d{1,30}$/.test(songId || '')) url.searchParams.set('i', songId);
    if (!artwork && (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') && /^[A-Za-z0-9_-]{11}$/.test(videoId || '')) url.searchParams.set('v', videoId);
    return url.href;
  } catch { return null; }
}

export function normalizeLocalTrack(track, expectedCountry = track?.country) {
  country(expectedCountry);
  if (!track || typeof track !== 'object' || Array.isArray(track) || !text(track.title) || !text(track.artist)
    || (track.country !== undefined && track.country !== expectedCountry) || !sources.has(track.source)
    || (track.durationMs !== undefined && (!Number.isSafeInteger(track.durationMs) || track.durationMs < 0 || track.durationMs > 24 * 60 * 60_000))
    || (track.requestArtist !== undefined && !text(track.requestArtist))
    || (track.requestArtists !== undefined && (!Array.isArray(track.requestArtists) || track.requestArtists.length > 30 || track.requestArtists.some(value => !text(value))))) throw invalidTrack();
  return { title: track.title.trim(), artist: track.artist.trim(), album: text(track.album) ? track.album.trim() : '',
    ...(normalizeReleaseYear(track.releaseYear) !== null ? { releaseYear: track.releaseYear } : {}),
    durationMs: track.durationMs ?? 0, artwork: safeUrl(track.artwork, true), url: safeUrl(track.url),
    requestArtist: (track.requestArtist || track.artist).trim(), requestArtists: [...new Set((track.requestArtists || []).map(value => value.trim()))],
    country: expectedCountry, source: track.source, ...(track.imported === true ? { imported: true } : {}) };
}

export class LocalPlaylists {
  constructor({ dataDir, clock = Date.now } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('Local playlist data directory required');
    this.file = path.join(dataDir, 'playlists.json'); this.clock = clock; this.entries = new Map(); this.corrupt = false; this.lastTime = 0;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.chmodSync(dataDir, 0o700);
    try {
      if (fs.statSync(this.file).size > MAX_BYTES) throw unreadable();
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved?.version !== 1 || !Array.isArray(saved.playlists) || saved.playlists.length > MAX_PLAYLISTS) throw unreadable();
      let total = 0;
      for (const playlist of saved.playlists) {
        if (!uuid(playlist?.id) || this.entries.has(playlist.id) || !Array.isArray(playlist.tracks) || playlist.tracks.length > MAX_TRACKS
          || !Number.isSafeInteger(playlist.createdAt) || !Number.isSafeInteger(playlist.updatedAt) || playlist.createdAt < 0 || playlist.updatedAt < playlist.createdAt) throw unreadable();
        const seen = new Set(), tracks = playlist.tracks.map(track => {
          if (!uuid(track?.id) || seen.has(track.id)) throw unreadable(); seen.add(track.id);
          return { id: track.id, ...normalizeLocalTrack(track, playlist.country) };
        });
        if ((total += tracks.length) > MAX_TOTAL) throw unreadable();
        const value = { id: playlist.id, name: name(playlist.name), country: country(playlist.country), createdAt: playlist.createdAt, updatedAt: playlist.updatedAt, tracks };
        if (playlist.imported === true) value.imported = true;
        if (playlist.importSource !== undefined) { if (!IMPORT_SOURCES.has(playlist.importSource)) throw unreadable(); value.importSource = playlist.importSource; }
        if (playlist.origin !== undefined) { value.origin = normalizePlaylistOrigin(playlist.origin); value.originUnchanged = playlist.originUnchanged === true; }
        this.entries.set(value.id, value); this.lastTime = Math.max(this.lastTime, value.updatedAt);
      }
      fs.chmodSync(this.file, 0o600);
    } catch (error) { if (error.code !== 'ENOENT') { this.corrupt = true; this.entries.clear(); } }
  }
  healthy() { if (this.corrupt) throw unreadable(); }
  time() { const value = this.clock(); this.lastTime = Math.max(Number.isSafeInteger(value) && value >= 0 ? value : Date.now(), this.lastTime + 1); return this.lastTime; }
  record(id) { this.healthy(); const value = typeof id === 'string' && this.entries.get(id); if (!value) throw missing(); return value; }
  expose(value, full = true) { const { tracks, ...summary } = value; return copy({ ...summary, title: value.name, artwork: value.origin?.artwork || null, source: 'local', ...(value.importSource ? {} : tracks.length && tracks.every(track => track.source === 'youtube-music') ? { importSource: 'youtube-music' } : {}), itemCount: tracks.length, ...(full ? { tracks } : {}) }); }
  list() { this.healthy(); return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(value => this.expose(value, false)); }
  get(id) { return this.expose(this.record(id)); }
  getTrack(playlistId, entryId) { const value = this.record(playlistId).tracks.find(track => track.id === entryId); if (!value) throw missingTrack(); return copy(value); }
  commit(entries) {
    this.healthy();
    const data = JSON.stringify({ version: 1, playlists: [...entries.values()] });
    if (Buffer.byteLength(data) > MAX_BYTES) throw new AppError(409, 'LOCAL_LIBRARY_FULL', 'Your saved music library is full. Remove some songs before adding more.');
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.chmodSync(temporary, 0o600); fs.renameSync(temporary, this.file); fs.chmodSync(this.file, 0o600); }
    catch { try { fs.rmSync(temporary, { force: true }); } catch {} throw new AppError(500, 'LOCAL_PLAYLIST_SAVE_FAILED', 'The playlist could not be saved in this project folder. Try again.'); }
    this.entries = entries;
  }
  create({ name: label, country: selectedCountry } = {}) {
    this.healthy(); const title = name(label), selected = country(selectedCountry);
    if (this.entries.size >= MAX_PLAYLISTS) throw new AppError(409, 'LOCAL_PLAYLIST_LIMIT', 'You can save up to 100 playlists. Remove one before creating another.');
    const now = this.time(), value = { id: randomUUID(), name: title, country: selected, createdAt: now, updatedAt: now, tracks: [] };
    const next = new Map(this.entries); next.set(value.id, value); this.commit(next); return this.expose(value);
  }
  importTracks({ name: label, country: selectedCountry, tracks, origin, originUnchanged = false } = {}) {
    this.healthy(); const title = name(label), selected = country(selectedCountry);
    if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > MAX_TRACKS) throw new AppError(400, 'INVALID_PLAYLIST_IMPORT', 'Import between 1 and 500 songs, each with a title and artist.');
    if (this.entries.size >= MAX_PLAYLISTS) throw new AppError(409, 'LOCAL_PLAYLIST_LIMIT', 'You can save up to 100 playlists. Remove one before importing another.');
    if ([...this.entries.values()].reduce((sum, entry) => sum + entry.tracks.length, 0) + tracks.length > MAX_TOTAL) throw new AppError(409, 'LOCAL_LIBRARY_FULL', 'Your saved library has room for 10,000 songs. Remove some songs before importing this playlist.');
    // Imported metadata is reviewed input, not a verified catalogue selection. Validate the entire snapshot before one atomic save.
    const snapshots = tracks.map(track => ({ id: randomUUID(), ...normalizeLocalTrack({ ...track, imported: true }, selected) }));
    const original = origin === undefined ? null : normalizePlaylistOrigin(origin);
    const importSource = snapshots.every(track => track.source === snapshots[0].source) && IMPORT_SOURCES.has(snapshots[0].source) ? snapshots[0].source : null;
    if (original && original.source !== importSource) throw new AppError(400, 'INVALID_PLAYLIST_ORIGIN', 'The playlist source must match the imported songs.');
    const now = this.time(), value = { id: randomUUID(), name: title, country: selected, createdAt: now, updatedAt: now, tracks: snapshots, imported: true, ...(importSource ? { importSource } : {}), ...(original ? { origin: original, originUnchanged: !!originUnchanged } : {}) };
    const next = new Map(this.entries); next.set(value.id, value); this.commit(next); return this.expose(value);
  }
  sync(id, { expectedUpdatedAt, tracks, origin, originUnchanged = false } = {}) {
    const prior = this.record(id);
    if (prior.updatedAt !== expectedUpdatedAt) throw new AppError(409, 'PLAYLIST_SYNC_CHANGED', 'This playlist changed after the sync preview. Preview the latest source again.');
    if (!prior.origin?.url || !Array.isArray(tracks) || tracks.length > MAX_TRACKS) throw new AppError(400, 'INVALID_PLAYLIST_SYNC', 'Choose an imported playlist and review up to 500 source songs.');
    const source = normalizePlaylistOrigin(origin);
    if (source.source !== prior.origin.source || source.url !== prior.origin.url) throw new AppError(409, 'PLAYLIST_SYNC_CHANGED', 'The source playlist changed. Preview it again.');
    if ([...this.entries.values()].reduce((sum, entry) => sum + (entry.id === id ? 0 : entry.tracks.length), 0) + tracks.length > MAX_TOTAL) throw new AppError(409, 'LOCAL_LIBRARY_FULL', 'Your saved library has room for 10,000 songs. Remove some songs before syncing.');
    const identity = track => JSON.stringify([track.source, track.url || '', track.title, track.artist]);
    const existing = new Map();
    for (const track of prior.tracks) { const key = identity(track); if (!existing.has(key)) existing.set(key, []); existing.get(key).push(track.id); }
    const snapshots = tracks.map(track => { const snapshot = normalizeLocalTrack({ ...track, imported: true }, prior.country); return { id: existing.get(identity(snapshot))?.shift() || randomUUID(), ...snapshot }; });
    const value = { ...prior, origin: source, originUnchanged: originUnchanged === true, imported: true, importSource: source.source, tracks: snapshots, updatedAt: this.time() };
    const backupDir = path.join(path.dirname(this.file), 'sync-backups');
    try { fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 }); fs.chmodSync(backupDir, 0o700); fs.writeFileSync(path.join(backupDir, id + '-' + randomUUID() + '.json'), JSON.stringify({ version: 1, playlist: prior }), { mode: 0o600, flag: 'wx' }); }
    catch { throw new AppError(500, 'PLAYLIST_SYNC_BACKUP_FAILED', 'The previous playlist could not be backed up. Nothing was synced.'); }
    const next = new Map(this.entries); next.set(id, value); this.commit(next); return this.expose(value);
  }
  replace(id, changes) { const prior = this.record(id), value = { ...prior, ...changes, ...(Object.hasOwn(changes, 'tracks') && prior.origin ? { originUnchanged: false } : {}), updatedAt: this.time() }; const next = new Map(this.entries); next.set(id, value); this.commit(next); return this.expose(value); }
  rename(id, label) { const title = name(label); return this.replace(id, { name: title }); }
  delete(id) { this.record(id); const next = new Map(this.entries); next.delete(id); this.commit(next); return { deleted: true }; }
  add(id, track) {
    const playlist = this.record(id), snapshot = normalizeLocalTrack(track, playlist.country);
    if (playlist.tracks.length >= MAX_TRACKS) throw new AppError(409, 'LOCAL_PLAYLIST_FULL', 'This playlist has 500 songs. Choose another playlist.');
    if ([...this.entries.values()].reduce((sum, entry) => sum + entry.tracks.length, 0) >= MAX_TOTAL) throw new AppError(409, 'LOCAL_LIBRARY_FULL', 'Your saved library has 10,000 songs. Remove some songs before adding more.');
    return this.replace(id, { tracks: [...playlist.tracks, { id: randomUUID(), ...snapshot }] });
  }
  removeTrack(id, entryId) { const playlist = this.record(id); if (!playlist.tracks.some(track => track.id === entryId)) throw missingTrack(); return this.replace(id, { tracks: playlist.tracks.filter(track => track.id !== entryId) }); }
  moveTrack(id, entryId, direction) {
    if (!['up', 'down'].includes(direction)) throw new AppError(400, 'INVALID_PLAYLIST_MOVE', 'Move a saved song up or down.');
    const playlist = this.record(id), index = playlist.tracks.findIndex(track => track.id === entryId);
    if (index < 0) throw missingTrack();
    const destination = index + (direction === 'up' ? -1 : 1);
    if (destination < 0 || destination >= playlist.tracks.length) return this.expose(playlist);
    const tracks = [...playlist.tracks]; [tracks[index], tracks[destination]] = [tracks[destination], tracks[index]];
    return this.replace(id, { tracks });
  }
}
