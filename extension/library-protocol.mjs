export const HELPER = 'http://127.0.0.1:4320';
const getRoutes = new Set(['/api/status', '/api/search', '/api/player', '/api/music-providers', '/api/commands', '/api/local-playlists', '/api/queue/items', '/api/echo-queue', '/api/playlists', '/api/apple/config']);
const postRoutes = new Set(['/api/connect', '/api/disconnect', '/api/play', '/api/play-selection', '/api/music-request-check', '/api/cancel-playback', '/api/volume', '/api/seek', '/api/control', '/api/command', '/api/playlist-import/preview', '/api/local-playlists/import', '/api/local-playlists', '/api/queue/items', '/api/queue/control', '/api/queue/mode', '/api/queue', '/api/play-playlist', '/api/apple/setup', '/api/apple/connect', '/api/apple/disconnect', '/api/spotify/setup', '/api/spotify/connect', '/api/spotify/disconnect', '/api/youtube/setup', '/api/youtube/connect', '/api/youtube/disconnect']);
const local = /^\/api\/local-playlists\/[A-Za-z0-9_-]{1,100}$/u;
const localSource = /^\/api\/local-playlists\/[A-Za-z0-9_-]{1,100}\/source$/u;
const localArtwork = /^\/api\/local-playlists\/[A-Za-z0-9_-]{1,100}\/tracks\/[A-Za-z0-9_-]{1,100}\/artwork$/u;
const localAction = /^\/api\/local-playlists\/[A-Za-z0-9_-]{1,100}\/(?:rename|delete|tracks|play|play-native|sync-preview|sync|tracks\/[A-Za-z0-9_-]{1,100}\/(?:remove|move))$/u;
const accountPlaylist = /^\/api\/playlists\/[A-Za-z0-9._-]{1,200}$/u;
const queueAction = /^\/api\/queue\/items\/[A-Za-z0-9_-]{1,100}\/(?:remove|move)$/u;
export function libraryRoute(path, method = 'GET') {
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/api/') || /[\\#\u0000-\u0020\u007f]/u.test(path) || !['GET','POST'].includes(method)) return null;
  let url; try { url = new URL(path, HELPER); } catch { return null; }
  if (url.origin !== HELPER || url.pathname.includes('%') || url.pathname !== path.split('?')[0]) return null;
  const allowed = method === 'GET' ? getRoutes.has(url.pathname) || local.test(url.pathname) || localSource.test(url.pathname) || localArtwork.test(url.pathname) || accountPlaylist.test(url.pathname) : postRoutes.has(url.pathname) || localAction.test(url.pathname) || queueAction.test(url.pathname);
  return allowed ? url.pathname + url.search : null;
}
export function cleanMessage(value, fallback = 'Echo Companion could not complete this request.') {
  return typeof value === 'string' && value.length <= 700 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ? value : fallback;
}
