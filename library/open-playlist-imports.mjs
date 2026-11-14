import { releaseYearMetadata } from './track-release.mjs';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { COUNTRIES } from './catalog.mjs';
import { parsePlaylistLink, safePlaylistAuthor } from './playlist-links.mjs';
import { safeTrackArtwork } from './track-artwork.mjs';

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_TRACKS = 500;
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'music.youtube.com']);
const missing = () => new AppError(409, 'PUBLIC_PLAYLIST_UNAVAILABLE', 'This public playlist page did not expose a readable song list. Private, sign-in-only and unsupported pages cannot be loaded here. Paste song titles and artists instead.');
const invalid = () => new AppError(400, 'INVALID_OPEN_PLAYLIST_LINK', 'Use a full public Spotify, YouTube or YouTube Music playlist link.');
const tooLarge = () => new AppError(413, 'PUBLIC_PLAYLIST_TOO_LARGE', 'Import at most 500 songs. Paste a smaller song list instead.');
const text = (value, max = 250) => typeof value === 'string' && value.trim() && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ? value.trim().replace(/\s+/gu, ' ') : '';
const rendered = value => text(typeof value === 'string' ? value : value?.simpleText || value?.content || (Array.isArray(value?.runs) ? value.runs.map(run => run?.text || '').join('') : ''), 2000);
function count(value) {
  if (typeof value === 'string' && /^\d{1,6}$/u.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function nodes(root, key) {
  const result = [], pending = [root];
  for (let at = 0; at < pending.length; at++) {
    if (at > 150000) throw missing();
    const value = pending[at];
    if (!value || typeof value !== 'object') continue;
    for (const [name, child] of Object.entries(value)) {
      if (name === key && child && typeof child === 'object') result.push(child);
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return result;
}
function identity(url, expected) {
  let parsed;
  try {
    const candidate = new URL(url);
    if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.port) throw invalid();
    if (expected.source === 'spotify') {
      if (candidate.hostname !== 'open.spotify.com') throw invalid();
      const match = /^\/(?:embed\/)?playlist\/([A-Za-z0-9]{22})\/?$/u.exec(candidate.pathname);
      if (!match || match[1] !== expected.id) throw invalid();
      parsed = { source: 'spotify', id: match[1] };
    } else {
      if (!YOUTUBE_HOSTS.has(candidate.hostname)) throw invalid();
      parsed = parsePlaylistLink(candidate.href);
    }
  } catch { throw missing(); }
  if (parsed.source !== expected.source || parsed.id !== expected.id) throw missing();
  return new URL(url);
}
async function body(response, json = false) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/u.test(length) && Number(length) > MAX_BYTES) throw tooLarge();
  const type = response.headers?.get?.('content-type');
  if (type && !(json ? /^application\/json(?:;|$)/iu : /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu).test(type)) throw missing();
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, result = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw tooLarge(); }
        result += decoder.decode(part.value, { stream: true });
      }
      return result + decoder.decode();
    } finally { reader.releaseLock?.(); }
  }
  const result = await response.text();
  if (typeof result !== 'string') throw missing();
  if (Buffer.byteLength(result, 'utf8') > MAX_BYTES) throw tooLarge();
  return result;
}
async function page(link, country, fetcher) {
  let destination = link.source === 'spotify'
    ? new URL('https://open.spotify.com/embed/playlist/' + link.id)
    : new URL('https://www.youtube.com/playlist?list=' + encodeURIComponent(link.id) + '&hl=en&gl=' + country);
  const signal = AbortSignal.timeout(15000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try {
      response = await fetcher(destination.href, { redirect: 'manual', credentials: 'omit', cache: 'no-store', signal, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 EchoCompanion/1.0 public-playlist-import' } });
    } catch { throw new AppError(502, 'PUBLIC_PLAYLIST_UNREACHABLE', 'The public playlist page could not be reached. Try again, or paste song titles and artists.'); }
    if (!response || typeof response.status !== 'number') throw missing();
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers?.get?.('location');
      if (!next || redirects === 3) throw missing();
      try { destination = identity(new URL(next, destination).href, link); } catch { throw missing(); }
      continue;
    }
    if (response.status === 429) throw new AppError(429, 'PUBLIC_PLAYLIST_RATE_LIMIT', 'This music service is limiting public playlist requests. Wait before trying again, or paste the song list.');
    if (!response.ok) throw missing();
    if (response.url) identity(response.url, link);
    try { return await body(response); } catch (error) { if (error instanceof AppError) throw error; throw missing(); }
  }
  throw missing();
}
function duration(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 86400000) return value;
  const time = text(value, 20);
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/u.test(time)) return 0;
  const parts = time.split(':').map(Number);
  if (parts.at(-1) >= 60 || parts.length === 3 && parts[1] >= 60) return 0;
  return parts.reduce((sum, item) => sum * 60 + item, 0) * 1000;
}
function track({ title, artist, artists, artwork = null, url, durationMs = 0, releaseDate }, source, country) {
  title = text(title); artist = text(artist);
  if (!title) throw missing();
  const credits = Array.isArray(artists) ? artists.map(name => text(name)).filter(Boolean) : artist ? [artist] : [];
  return { id: randomUUID(), title, artist, requestArtist: credits[0] || '', requestArtists: credits, album: '', ...releaseYearMetadata(releaseDate), artwork: safeTrackArtwork(artwork), url, durationMs: duration(durationMs), source, country, needsReview: !artist };
}
function spotify(html, link, country) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)].filter(match => /\bid\s*=\s*(?:"__NEXT_DATA__"|'__NEXT_DATA__')/u.test(match[1]));
  if (scripts.length !== 1) throw missing();
  let data; try { data = JSON.parse(scripts[0][2]); } catch { throw missing(); }
  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (entity?.type !== 'playlist' || entity.uri !== 'spotify:playlist:' + link.id || entity.id !== undefined && entity.id !== link.id || entity.isPrivate === true || entity.public === false || !Array.isArray(entity.trackList)) throw missing();
  const name = text(entity.name || entity.title);
  if (!name || !entity.trackList.length) throw missing();
  if (entity.trackList.length > MAX_TRACKS) throw tooLarge();
  const totals = [...new Set([entity.totalCount, entity.trackCount, entity.totalTracks, entity.tracks?.totalCount].map(count).filter(value => value !== null))];
  if (totals.length > 1 || totals[0] !== undefined && totals[0] < entity.trackList.length) throw missing();
  const total = totals[0] ?? null;
  if (total > MAX_TRACKS) throw tooLarge();
  const tracks = entity.trackList.map(row => {
    if (!row || !/^spotify:track:[A-Za-z0-9]{22}$/u.test(row.uri || '') || row.entityType && row.entityType !== 'track') throw missing();
    const artists = Array.isArray(row.artists) ? row.artists.map(item => text(typeof item === 'string' ? item : item?.name)).filter(Boolean) : null;
    const images = row.visualIdentity?.image || row.images || row.coverArt?.sources || [];
    const artwork = (Array.isArray(images) ? images.map(image => safeTrackArtwork(image?.url)).find(Boolean) : null) || safeTrackArtwork(row.imageUrl);
    return track({ title: row.title, artist: artists?.length ? artists.join(', ') : row.subtitle, artists, artwork, releaseDate: row.releaseDate || row.album?.release_date, durationMs: row.duration, url: 'https://open.spotify.com/track/' + row.uri.slice('spotify:track:'.length) }, link.source, country);
  });
  const images = entity.visualIdentity?.image || entity.images || [];
  const artwork = Array.isArray(images) ? images.map(image => safeTrackArtwork(image?.url)).find(Boolean) || null : null;
  const author = safePlaylistAuthor(entity.owner?.display_name || entity.ownerV2?.data?.name || entity.subtitle);
  return { name, artwork, ...(author ? { author } : {}), tracks, total, skipped: 0, truncated: total === null || total > tracks.length, fullCountUnverified: total === null };
}
function initialYouTubeData(html) {
  const marker = /(?:(?:var|let|const)\s+)?(?:window(?:\["ytInitialData"\]|\.ytInitialData)|ytInitialData)\s*=\s*/u.exec(html);
  if (!marker) throw missing();
  let at = marker.index + marker[0].length, depth = 0, inString = false, escaped = false;
  const start = at;
  if (html[at] !== '{') throw missing();
  for (; at < html.length; at++) {
    const char = html[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') { if (++depth > 256) throw missing(); }
    else if (char === '}' || char === ']') {
      if (--depth === 0) { try { return JSON.parse(html.slice(start, at + 1)); } catch { throw missing(); } }
    }
  }
  throw missing();
}
function youtubeTrack(title, owner, videoId, length, country) {
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId || '') || /^(?:deleted|private|unavailable) video$/iu.test(title.trim())) return null;
  title = text(title).replace(/\s*[([]\s*(?:official\s+(?:music\s+video|video|audio|lyric\s+video)|music\s+video|audio|lyrics?|lyric\s+video)\s*[)\]]/giu, ' ').replace(/\s+/gu, ' ').trim();
  let artist = '';
  if (/ - Topic$/u.test(owner)) {
    artist = owner.slice(0, -8).trim();
    if (title.toLocaleLowerCase().startsWith((artist + ' - ').toLocaleLowerCase())) title = title.slice(artist.length + 3).trim();
  } else {
    const pieces = title.split(' - ');
    if (pieces.length === 2 && pieces.every(value => text(value))) [artist, title] = pieces.map(value => value.trim());
  }
  return track({ title, artist, artwork: 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=' + videoId, durationMs: duration(length) }, 'youtube-music', country);
}
function watchEndpoint(view) {
  return view?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint || view?.navigationEndpoint?.watchEndpoint || null;
}
const youtubeContinuation = new WeakMap();
function continuationToken(items) {
  const tokens = [...new Set(nodes(items, 'continuationCommand').map(command => command.token).filter(value => text(value, 65536)))];
  return tokens.length === 1 ? tokens[0] : null;
}
function youtubeRows(items, link, country) {
  const tracks = []; let skipped = 0;
  if (!Array.isArray(items)) throw missing();
  for (const item of items) {
    if (item?.continuationItemRenderer || item?.continuationItemViewModel) continue;
    const video = item?.playlistVideoRenderer;
    const view = item?.lockupViewModel || item?.richItemRenderer?.content?.lockupViewModel;
    if (video) {
      const endpoint = watchEndpoint(video);
      if (endpoint?.playlistId && endpoint.playlistId !== link.id) throw missing();
      const record = youtubeTrack(rendered(video.title), rendered(video.shortBylineText || video.longBylineText), video.videoId, rendered(video.lengthText), country);
      if (record) tracks.push(record); else skipped++;
    } else if (view?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && watchEndpoint(view)?.playlistId === link.id) {
      const metadata = view.metadata?.lockupMetadataViewModel;
      const owner = metadata?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text;
      const badge = nodes(view.contentImage, 'thumbnailBadgeViewModel').map(value => rendered(value.text)).find(value => /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(value));
      const record = youtubeTrack(rendered(metadata?.title), rendered(owner), view.contentId, badge, country);
      if (record) tracks.push(record); else skipped++;
    } else skipped++;
  }
  return { tracks, skipped, token: continuationToken(items), hasMore: nodes(items, 'continuationItemViewModel').length > 0 || nodes(items, 'continuationItemRenderer').length > 0 };
}
function youtube(html, link, country) {
  const data = initialYouTubeData(html);
  if (nodes(data.alerts, 'alertRenderer').some(alert => alert.type === 'ERROR')) throw missing();
  const old = nodes(data.contents, 'playlistVideoListRenderer');
  if (old.length > 1) throw missing();
  const sidebar = nodes(data.sidebar, 'playlistSidebarPrimaryInfoRenderer')[0];
  const header = data.header?.playlistHeaderRenderer;
  const canonical = data.microformat?.microformatDataRenderer?.urlCanonical;
  const playlistId = old[0]?.playlistId || sidebar?.navigationEndpoint?.watchEndpoint?.playlistId;
  if (playlistId && playlistId !== link.id) throw missing();
  if (canonical) {
    // The site's canonical identity metadata can say http; network access never does.
    let canonicalUrl; try { canonicalUrl = new URL(canonical); } catch { throw missing(); }
    if (canonicalUrl.protocol === 'http:' && YOUTUBE_HOSTS.has(canonicalUrl.hostname)) canonicalUrl.protocol = 'https:';
    identity(canonicalUrl.href, link);
  }
  if (!canonical && playlistId !== link.id) throw missing();
  const name = text(data.metadata?.playlistMetadataRenderer?.title || rendered(sidebar?.title) || rendered(header?.title));
  if (!name) throw missing();
  const totals = [];
  for (const value of [header?.numVideosText, ...(Array.isArray(sidebar?.stats) ? sidebar.stats : [])]) {
    const match = /^([\d,]+)(?:\s+(?:videos?|songs?|tracks?))?$/iu.exec(rendered(value));
    if (match) { const number = count(match[1].replaceAll(',', '')); if (number !== null) totals.push(number); }
  }
  const known = [...new Set(totals)];
  if (known.length > 1) throw missing();
  const total = known[0] ?? null;
  if (total > MAX_TRACKS) throw tooLarge();
  const sections = nodes(data.contents, 'itemSectionRenderer').filter(section => section.contents?.some(item => item?.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && watchEndpoint(item.lockupViewModel)?.playlistId === link.id));
  if (!old.length && sections.length !== 1) throw missing();
  const page = youtubeRows(old[0]?.contents || sections[0]?.contents, link, country);
  if (!page.tracks.length || total !== null && page.tracks.length + page.skipped > total) throw missing();
  if (page.tracks.length > MAX_TRACKS) throw tooLarge();
  const image = [...html.matchAll(/<meta\b([^>]*)>/giu)].map(match => { const attr = name => new RegExp('\\b' + name + '=([\"\'])(.*?)\\1', 'iu').exec(match[1])?.[2]; return /^(?:og:image|og:image:secure_url)$/u.test(attr('property') || '') ? safeTrackArtwork((attr('content') || '').replaceAll('&amp;', '&')) : null; }).find(Boolean) || null;
  const owner = nodes(data.sidebar, 'playlistSidebarSecondaryInfoRenderer')[0]?.videoOwner?.videoOwnerRenderer;
  const author = safePlaylistAuthor(rendered(owner?.title) || rendered(header?.ownerText));
  const result = { name, artwork: image, ...(author ? { author } : {}), tracks: page.tracks, total, skipped: page.skipped, truncated: page.hasMore || page.skipped > 0 || total === null || total > page.tracks.length, fullCountUnverified: total === null };
  youtubeContinuation.set(result, { token: page.token, hasMore: page.hasMore });
  return result;
}
function websiteSetting(html, name) {
  const expression = new RegExp('"' + name + '"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")', 'u');
  const match = expression.exec(html);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
async function youtubeNext(token, config, link, country, fetcher, timeoutMs) {
  const url = new URL('https://www.youtube.com/youtubei/v1/browse');
  url.searchParams.set('prettyPrint', 'false');
  if (config.apiKey) url.searchParams.set('key', config.apiKey);
  const response = await fetcher(url.href, { method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', 'content-type': 'application/json', 'x-youtube-client-name': '1', 'x-youtube-client-version': config.version },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: config.version, hl: 'en', gl: country } }, continuation: token }) });
  if (!response?.ok || response.status !== 200) throw missing();
  if (response.url) {
    let actual; try { actual = new URL(response.url); } catch { throw missing(); }
    if (actual.origin !== 'https://www.youtube.com' || actual.pathname !== '/youtubei/v1/browse' || actual.username || actual.password || actual.port) throw missing();
  }
  let data; try { data = JSON.parse(await body(response, true)); } catch (error) { if (error instanceof AppError) throw error; throw missing(); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw missing();
  const roots = [data.onResponseReceivedActions, data.onResponseReceivedEndpoints];
  const actions = roots.flatMap(root => nodes(root, 'appendContinuationItemsAction')).filter(action => [link.id, 'VL' + link.id, 'playlist-video-list'].includes(action.targetId));
  if (actions.length !== 1 || !Array.isArray(actions[0].continuationItems)) throw missing();
  const result = youtubeRows(actions[0].continuationItems, link, country);
  if (!result.tracks.length) throw missing();
  return result;
}
async function completeYouTube(result, html, link, country, fetcher) {
  let page = youtubeContinuation.get(result);
  if (!page?.hasMore || !page.token) return result;
  const version = websiteSetting(html, 'INNERTUBE_CLIENT_VERSION');
  const publicKey = websiteSetting(html, 'INNERTUBE_API_KEY');
  if (!text(version, 80) || !/^[A-Za-z0-9_.-]+$/u.test(version)) return result;
  const config = { version, apiKey: text(publicKey, 256) && /^[A-Za-z0-9_-]+$/u.test(publicKey) ? publicKey : null };
  const seen = new Set(), deadline = Date.now() + 20000;
  let complete = false;
  for (let number = 0; number < 8 && page.token && Date.now() < deadline; number++) {
    if (seen.has(page.token)) break;
    seen.add(page.token);
    let next;
    try { next = await youtubeNext(page.token, config, link, country, fetcher, Math.max(1, Math.min(8000, deadline - Date.now()))); }
    catch (error) { if (error?.code === 'PUBLIC_PLAYLIST_TOO_LARGE') throw error; break; }
    if (next.token && seen.has(next.token)) break;
    if (result.tracks.length + next.tracks.length > MAX_TRACKS) throw tooLarge();
    if (result.total !== null && result.tracks.length + result.skipped + next.tracks.length + next.skipped > result.total) break;
    result.tracks.push(...next.tracks); result.skipped += next.skipped;
    page = next;
    if (!next.hasMore) { complete = true; break; }
    if (!next.token) break;
  }
  if (complete && result.total !== null && result.tracks.length + result.skipped < result.total) result.skipped = result.total - result.tracks.length;
  result.truncated = !complete || result.skipped > 0 || result.total === null || result.total > result.tracks.length;
  return result;
}
export async function importOpenPlaylist(value, country, { fetcher = fetch, metadataOnly = false } = {}) {
  if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose a catalogue country before importing a playlist.');
  const link = parsePlaylistLink(value, country);
  if (!['spotify', 'youtube-music'].includes(link.source)) throw invalid();
  if (typeof fetcher !== 'function') throw missing();
  const html = await page(link, country, fetcher);
  const result = link.source === 'spotify' ? spotify(html, link, country) : metadataOnly ? youtube(html, link, country) : await completeYouTube(youtube(html, link, country), html, link, country, fetcher);
  const notes = [];
  if (result.fullCountUnverified) notes.push('The public page does not publish a reliable full playlist count. These are visible entries only; this may be a partial list. Review it and paste missing songs before saving.');
  else if (result.truncated) notes.push('Only ' + result.tracks.length + ' visible songs from the public page were loaded. The playlist is incomplete; review it and paste missing songs before saving.');
  const review = result.tracks.filter(item => item.needsReview).length;
  if (review) notes.push(review + (review === 1 ? ' song needs' : ' songs need') + ' an artist before saving or playing.');
  return { ...result, notes, source: link.source, country, url: link.url, method: 'public-page', availability: 'unverified' };
}

