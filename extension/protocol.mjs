export const HELPER = 'http://127.0.0.1:4320';
export const COUNTRIES = new Set(['IN', 'US', 'GB', 'DE', 'CA', 'AU', 'JP']);
const SITES = new Map([['music.youtube.com', 'youtube-music'], ['open.spotify.com', 'spotify'], ['music.apple.com', 'apple-music']]);
export function sourceForUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.port && !url.username && !url.password ? SITES.get(url.hostname) || null : null; } catch { return null; }
}
export function cleanText(value, max = 250) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return '';
  return value.replace(/\s+/gu, ' ').trim();
}
function boundedArtistNames(values) {
  const names = [], seen = new Set();
  if (Array.isArray(values)) for (const value of values.slice(0, 12)) {
    const name = cleanText(value), identity = name.normalize('NFKC').toLocaleLowerCase();
    if (!name || seen.has(identity)) continue;
    seen.add(identity); names.push(name);
  }
  return names;
}
export function normalizeTrack(raw, pageUrl) {
  const source = sourceForUrl(pageUrl);
  if (!source || !raw || typeof raw !== 'object' || raw.source !== source) return null;
  const title = cleanText(raw.title), artist = cleanText(raw.artist);
  if (!title && !raw.isAd) return null;
  const artistNames = artist ? boundedArtistNames(raw.artistNames) : [];
  const featuredArtists = artist ? boundedArtistNames(raw.featuredArtists) : [];
  const track = { source, title, artist, artistNames, featuredArtists, album: cleanText(raw.album), trackId: cleanText(raw.trackId, 180), url: pageUrl, state: ['playing', 'paused'].includes(raw.state) ? raw.state : 'unknown', isAd: raw.isAd === true, confidence: raw.confidence === 'high' && title && artist ? 'high' : 'review' };
  if (typeof raw.url === 'string' && raw.url.length <= 2048 && sourceForUrl(raw.url) === source) track.url = raw.url;
  for (const key of ['durationMs', 'positionMs']) if (typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0 && raw[key] <= 86_400_000) track[key] = Math.round(raw[key]);
  return track;
}
const norm = value => cleanText(value).normalize('NFKC').toLocaleLowerCase();
export function trackKey(track) { return track ? [track.source, track.trackId, norm(track.title), norm(track.artist)].join('\u001f') : ''; }
export function canFollow(track) { return !!track && !track.isAd && track.confidence === 'high' && !!track.title && !!track.artist; }
export function followDecision(follow, track) {
  if (!follow?.enabled || !canFollow(track) || track.state !== 'playing') return { send: false };
  const key = trackKey(track);
  const restarted = key === follow.lastKey && Number.isFinite(track.positionMs) && track.positionMs < 4000 && Number.isFinite(follow.lastPositionMs) && follow.lastPositionMs > 20_000;
  return { send: key !== follow.lastKey || restarted, key };
}
export function safeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  return { deviceId: cleanText(value.deviceId, 250), providerId: /^[a-z][a-z0-9-]{0,99}$/.test(value.providerId || '') ? value.providerId : 'apple-music', country: COUNTRIES.has(value.country) ? value.country : 'IN' };
}
