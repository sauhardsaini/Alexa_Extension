import path from 'node:path';
import { AlexaBridge } from './bridge.mjs';
import { Catalog } from './catalog.mjs';
import { CatalogRouter } from './catalog-router.mjs';
import { AppleMusicService } from './apple-music.mjs';
import { SpotifyService } from './spotify.mjs';
import { YouTubeMusicService } from './youtube-music.mjs';
import { PlaybackCoordinator } from './playback.mjs';
import { TrackArtistResolver } from './track-artists.mjs';
import { TrackReleaseYearResolver } from './track-release-resolver.mjs';
import { TrackArtworkResolver } from './track-artwork.mjs';
import { PlaylistSourceResolver } from './playlist-source.mjs';
import { PlaylistQueue } from './playlist-queue.mjs';
import { LocalPlaylists } from './local-playlists.mjs';
import { RequestArtistPreferences } from './request-artists.mjs';
import { parsePlaylistLink } from './playlist-links.mjs';
import { importPublicPlaylist } from './public-playlist-imports.mjs';
import { createLibraryHandler } from './api.mjs';

/**
 * The current web application's music engine, hosted by the paired helper.
 * This module never listens on a port and never reads another project's data.
 */
export function createLibrary({ dataDir, bridge = null, catalog = null, appleMusic = null, spotify = null, youtube = null, playback = null, queue = null,
  localPlaylists = null, artistPreferences = null, artworkResolver = null, playlistSourceResolver = null, publicPlaylistImporter = null,
  fetcher = globalThis.fetch, port = 4320, proxyPort = port + 1,
  bridgeOptions = {}, playbackOptions = {}, queueOptions = {} } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('Extension library data directory required');
  const libraryData = path.join(path.resolve(dataDir), 'library');
  bridge ||= new AlexaBridge({ ...bridgeOptions, dataDir: path.join(path.resolve(dataDir), 'amazon'), proxyPort });
  appleMusic ||= new AppleMusicService({ dataDir: libraryData, fetcher });
  spotify ||= new SpotifyService({ dataDir: libraryData, port, fetcher });
  youtube ||= new YouTubeMusicService({ dataDir: libraryData, port, fetcher });
  catalog ||= new CatalogRouter({ publicCatalog: new Catalog({ fetcher }), appleMusic, spotify });
  artistPreferences ||= new RequestArtistPreferences({ dataDir: libraryData });
  playback ||= new PlaybackCoordinator({ artistResolver: new TrackArtistResolver({ fetcher }), releaseYearResolver: new TrackReleaseYearResolver({ fetcher }), ...playbackOptions, bridge, artistPreferences });
  queue ||= new PlaylistQueue({ ...queueOptions, bridge, playback });
  localPlaylists ||= new LocalPlaylists({ dataDir: libraryData });
  artworkResolver ||= new TrackArtworkResolver({ fetcher });
  // Connected accounts use the same official import path as the web app.
  // Anonymous public-link imports remain available when no account is connected.
  const importPlaylist = publicPlaylistImporter || (async (url, country) => {
    const { source } = parsePlaylistLink(url, country);
    if (source === 'apple-music') return appleMusic.importPlaylist(url, country);
    const service = source === 'spotify' ? spotify : source === 'youtube-music' ? youtube : null;
    if (service?.status().connected) return service.importPlaylist(url, country);
    return service
      ? (await import('./open-playlist-imports.mjs')).importOpenPlaylist(url, country, { fetcher })
      : importPublicPlaylist(url, country, { fetcher });
  });
  playlistSourceResolver ||= new PlaylistSourceResolver({ importer: async (url, country) => {
    const link = parsePlaylistLink(url, country);
    if (['spotify', 'youtube-music'].includes(link.source)) {
      const service = link.source === 'spotify' ? spotify : youtube;
      if (service?.status().connected) {
        try { return await service.importPlaylist(link.url, country, { metadataOnly: true }); } catch { /* Public metadata remains available independently of account access. */ }
      }
      return (await import('./open-playlist-imports.mjs')).importOpenPlaylist(link.url, country, { fetcher, metadataOnly: true });
    }
    return importPlaylist(link.url, country);
  } });
  // Network headers cannot grant this capability. Only the outer paired helper
  // invokes handleAuthenticated after validating its token, origin and route.
  const authenticatedRequests = new WeakSet();
  const handle = createLibraryHandler({ bridge, catalog, appleMusic, spotify, youtube, artistPreferences,
    playback, queue, localPlaylists, artworkResolver, playlistSourceResolver, playlistImporter: importPlaylist, port,
    authorizeRequest: req => authenticatedRequests.has(req) });
  const handleAuthenticated = async (req, res) => {
    authenticatedRequests.add(req);
    try { await handle(req, res); } finally { authenticatedRequests.delete(req); }
  };
  const cancel = (reason = 'The extension helper stopped.') => {
    queue.cancel(reason); playback.cancel(reason);
  };
  const stop = async () => {
    const queueTask = queue.current?.task;
    cancel();
    // Wait for an already-dispatched native action before the owner disconnects
    // its shared Amazon bridge. Cancellation suppresses every later candidate.
    await Promise.allSettled([Promise.resolve(playback.queue), Promise.resolve(queueTask)]);
    return true;
  };
  return { handle, handleAuthenticated, handleCallback: handle, bridge, catalog, appleMusic, spotify, youtube, playback, queue, localPlaylists, artistPreferences,
    importPlaylist, restore: () => bridge.restore(), cancel, stop };
}
export { AlexaBridge } from './bridge.mjs';
export { AppError } from './errors.mjs';
