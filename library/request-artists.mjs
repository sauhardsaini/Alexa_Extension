import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, COUNTRIES } from './catalog.mjs';

const VERSION = 1;
const LIMIT = 1000;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const cleanText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 250 && !/[\u0000-\u001f\u007f]/u.test(value);
const normalizedText = value => cleanText(value) ? value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase() : null;
const songId = value => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value);
const sourceSongId = (source, value) => source === 'spotify' ? typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value)
  : source === 'youtube-music' ? typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value) : source === undefined && songId(value);
const saveError = () => new AppError(500, 'ARTIST_PREFERENCES_UNAVAILABLE', 'The song’s artist preference could not be saved locally.');

function recordingIdentity(track, country) {
  if (!COUNTRIES.has(country) || !track || typeof track !== 'object') return null;
  const title = normalizedText(track.title);
  const artist = normalizedText(track.artist);
  const primary = normalizedText(track.requestArtist === undefined ? track.artist : track.requestArtist);
  if (!title || !artist || !primary || typeof track.url !== 'string' || track.url.length > 4096) return null;
  try {
    const url = new URL(track.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'open.spotify.com') {
      const catalogId = /^\/track\/([A-Za-z0-9]{22})\/?$/u.exec(url.pathname)?.[1];
      return catalogId ? { country, source: 'spotify', catalogId, title, artist, primary } : null;
    }
    if (['youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) {
      const catalogId = url.hostname === 'youtu.be' ? /^\/([A-Za-z0-9_-]{11})\/?$/u.exec(url.pathname)?.[1]
        : url.pathname === '/watch' && url.searchParams.getAll('v').length === 1 ? url.searchParams.get('v') : null;
      return sourceSongId('youtube-music', catalogId) ? { country, source: 'youtube-music', catalogId, title, artist, primary } : null;
    }
    if (!['music.apple.com', 'itunes.apple.com'].includes(url.hostname)) return null;
    const segments = url.pathname.split('/');
    if (segments[1] !== country.toLowerCase()) return null;
    const selectedIds = url.searchParams.getAll('i');
    if (selectedIds.length > 1) return null;
    const lastSegment = segments.at(-1);
    const catalogId = selectedIds.length ? selectedIds[0] : /^(?:id)?([1-9]\d{0,29})$/.exec(lastSegment)?.[1];
    if (!songId(catalogId)) return null;
    return { country, catalogId, title, artist, primary };
  } catch { return null; }
}
function validEntry(value) {
  if (!value || typeof value !== 'object' || !COUNTRIES.has(value.country) || !sourceSongId(value.source, value.catalogId) || !cleanText(value.requestArtist)) return null;
  const title = normalizedText(value.title), artist = normalizedText(value.artist), primary = normalizedText(value.primary);
  if (!title || !artist || !primary) return null;
  return { country: value.country, ...(value.source ? { source: value.source } : {}), catalogId: value.catalogId, title, artist, primary, requestArtist: value.requestArtist.replace(/\s+/gu, ' ').trim() };
}
const entryKey = identity => identity.country + ':' + (identity.source ? identity.source + ':' : '') + identity.catalogId;

export class RequestArtistPreferences {
  constructor({ dataDir } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('Artist preference data directory required');
    this.file = path.join(dataDir, 'request-artists.json');
    this.entries = new Map();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    try {
      if (fs.statSync(this.file).size > MAX_STORE_BYTES) return;
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved?.version !== VERSION || !Array.isArray(saved.entries)) return;
      for (const value of saved.entries.slice(-LIMIT)) {
        const entry = validEntry(value);
        if (entry) this.entries.set(entryKey(entry), entry);
      }
    } catch { /* Missing or malformed preferences never change playback behavior. */ }
  }
  apply(track, country) {
    const copy = { ...track };
    const identity = recordingIdentity(track, country);
    if (!identity) return copy;
    const saved = this.entries.get(entryKey(identity));
    if (saved && saved.title === identity.title && saved.artist === identity.artist && (identity.source || saved.primary === identity.primary)) copy.requestArtist = saved.requestArtist;
    return copy;
  }
  set(track, country, artist) {
    if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose one of the supported catalogue countries.');
    if (!cleanText(artist)) throw new AppError(400, 'INVALID_REQUEST_ARTIST', 'Use a valid artist name of up to 250 characters.');
    const identity = recordingIdentity(track, country);
    if (!identity) throw new AppError(400, 'INVALID_TRACK_IDENTITY', 'Choose a song from the selected country’s catalogue before saving an artist preference.');
    const requestArtist = artist.replace(/\s+/gu, ' ').trim();
    const next = new Map(this.entries);
    next.delete(entryKey(identity));
    next.set(entryKey(identity), { ...identity, requestArtist });
    while (next.size > LIMIT) next.delete(next.keys().next().value);
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: VERSION, entries: [...next.values()] }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw saveError();
    }
    this.entries = next;
    return { ...track, requestArtist };
  }
}
