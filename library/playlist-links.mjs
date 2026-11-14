import { AppError } from './errors.mjs';
import { safeTrackArtwork } from './track-artwork.mjs';
import { resolveMusicProvider } from './music-providers.mjs';

export const IMPORT_SOURCES = new Set(['youtube-music', 'apple-music', 'spotify', 'amazon-music', 'jiosaavn', 'deezer', 'tidal', 'gaana', 'hungama']);
export function directPlaylistSource(source) {
  if (!IMPORT_SOURCES.has(source) || source === 'youtube-music') return false;
  try { return resolveMusicProvider(source).kind === 'music'; } catch { return false; }
}
const invalid = () => new AppError(400, 'INVALID_PLAYLIST_LINK', 'Paste a full Apple Music, YouTube Music, Spotify, JioSaavn or Amazon Music playlist link.');
export function parsePlaylistLink(value, country) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw invalid();
  let url; try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw invalid();
  let source, id;
  if (['youtube.com', 'www.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
    source = 'youtube-music'; id = url.searchParams.get('list');
    if (url.pathname !== '/playlist' || url.searchParams.getAll('list').length !== 1) throw invalid();
    if (/^RD/i.test(id || '')) throw new AppError(400, 'YOUTUBE_DYNAMIC_MIX', 'This link opens a generated mix or radio station. Save the songs to a normal YouTube playlist, then import that playlist link.');
    if (!/^PL[A-Za-z0-9_-]{1,126}$/.test(id || '')) throw invalid();
    url = new URL('https://music.youtube.com/playlist'); url.searchParams.set('list', id);
  } else if (url.hostname === 'open.spotify.com') {
    source = 'spotify'; const match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{22})\/?$/); if (!match) throw invalid(); id = match[1]; url.pathname = '/playlist/' + id;
  } else if (url.hostname === 'music.apple.com') {
    source = 'apple-music'; const match = url.pathname.match(/^\/([a-z]{2})\/playlist\/(?:[^/]+\/)?(pl\.[A-Za-z0-9_-]{1,128})\/?$/i); if (!match) throw invalid(); id = match[2];
    if (country) url.pathname = url.pathname.replace(/^\/[a-z]{2}\//i, '/' + country.toLowerCase() + '/');
  } else if (['www.jiosaavn.com', 'jiosaavn.com'].includes(url.hostname)) {
    source = 'jiosaavn'; const match = url.pathname.match(/^\/(?:featured|s\/playlist)\/(?:[A-Za-z0-9_~.,!()-]+\/){1,3}([A-Za-z0-9_,+\-=]{4,160})\/?$/); if (!match) throw invalid(); id = match[1]; url.hostname = 'www.jiosaavn.com';
  } else if (['music.amazon.in', 'music.amazon.com', 'music.amazon.co.uk', 'music.amazon.de', 'music.amazon.ca', 'music.amazon.com.au', 'music.amazon.co.jp'].includes(url.hostname)) {
    source = 'amazon-music'; const match = url.pathname.match(/^\/(?:playlists|user-playlists)\/([A-Za-z0-9_-]{8,160})\/?$/); if (!match) throw invalid(); id = match[1];
  } else throw invalid();
  if (source !== 'youtube-music') url.search = '';
  url.hash = '';
  return { source, id, url: url.href };
}
export const safePlaylistAuthor = value => typeof value === 'string' && value.trim() && value.length <= 250 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ? value.trim().replace(/\s+/gu, ' ') : null;
export function normalizePlaylistOrigin(origin) {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin) || !IMPORT_SOURCES.has(origin.source)
    || typeof origin.name !== 'string' || !origin.name.trim() || origin.name.length > 250 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(origin.name)) throw new AppError(400, 'INVALID_PLAYLIST_ORIGIN', 'Review the original service and playlist name.');
  let url = null;
  if (origin.url !== null && origin.url !== undefined) { const parsed = parsePlaylistLink(origin.url); if (parsed.source !== origin.source) throw invalid(); url = parsed.url; }
  const playbackName = typeof origin.playbackName === 'string' && origin.playbackName.trim() && origin.playbackName.length <= 250 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(origin.playbackName) ? origin.playbackName.trim() : null;
  return { source: origin.source, name: origin.name.trim(), url, ...(origin.artwork !== undefined ? { artwork: safeTrackArtwork(origin.artwork) } : {}), ...(playbackName ? { playbackName } : {}), ...(safePlaylistAuthor(origin.author) ? { author: safePlaylistAuthor(origin.author) } : {}) };
}
