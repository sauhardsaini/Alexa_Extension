import { releaseYearMetadata } from './track-release.mjs';
import { safePlaylistAuthor } from './playlist-links.mjs';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { COUNTRIES } from './catalog.mjs';
import { safeTrackArtwork } from './track-artwork.mjs';

const MAX_BYTES = 6 * 1024 * 1024;
const AMAZON_HOSTS = new Set(['music.amazon.in', 'music.amazon.com', 'music.amazon.co.uk', 'music.amazon.de', 'music.amazon.ca', 'music.amazon.com.au', 'music.amazon.co.jp']);
const JIO_HOSTS = new Set(['jiosaavn.com', 'www.jiosaavn.com']);
const safeText = (value, max = 250) => typeof value === 'string' && value.trim() && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
const unavailable = () => new AppError(409, 'PUBLIC_PLAYLIST_INCOMPLETE', 'A complete public song list could not be read from this page. Private, sign-in-only, or partially loaded playlists are not imported. Paste the song list instead.');
const invalid = () => new AppError(400, 'INVALID_PUBLIC_PLAYLIST_LINK', 'Use a public JioSaavn playlist link or an Amazon Music /playlists/ link. Short links and sign-in pages are not supported.');
const tooLarge = () => new AppError(413, 'PUBLIC_PLAYLIST_TOO_LARGE', 'Import at most 500 songs. No partial playlist was imported.');
function link(value) {
  if (!safeText(value, 2048)) throw invalid();
  let url; try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw invalid();
  let source, identity;
  if (AMAZON_HOSTS.has(url.hostname)) {
    const match = url.pathname.match(/^\/(?:playlists|user-playlists)\/([A-Za-z0-9_-]{8,160})$/);
    if (!match) throw invalid(); source = 'amazon-music'; identity = match[1];
  } else if (JIO_HOSTS.has(url.hostname)) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (!((parts.length === 3 && parts[0] === 'featured') || (parts.length === 5 && parts[0] === 's' && parts[1] === 'playlist'))) throw invalid();
    try { identity = decodeURIComponent(parts.at(-1)); } catch { throw invalid(); }
    if (!/^[A-Za-z0-9_,+\-=]{6,128}$/.test(identity) || parts.slice(1, -1).some(part => !/^[A-Za-z0-9_-]{1,200}$/.test(part))) throw invalid();
    source = 'jiosaavn';
  } else throw invalid();
  url.search = ''; url.hash = '';
  return { source, identity, url };
}
function samePlaylist(a, b) { return a.source === b.source && a.identity === b.identity && (a.source !== 'amazon-music' || a.url.hostname === b.url.hostname); }
async function bodyText(response) {
  const length = response.headers?.get?.('content-length');
  if (length && Number(length) > MAX_BYTES) throw tooLarge();
  const contentType = response.headers?.get?.('content-type');
  if (contentType && !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) throw unavailable();
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0, result = '';
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > MAX_BYTES) { await reader.cancel(); throw tooLarge(); } result += decoder.decode(chunk.value, { stream: true }); }
      return result + decoder.decode();
    } finally { reader.releaseLock?.(); }
  }
  const value = await response.text();
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw tooLarge();
  return value;
}
async function publicPage(initial, fetcher) {
  let current = initial;
  for (let hop = 0; hop < 4; hop++) {
    let response;
    try { response = await fetcher(current.url, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(12000), headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-IN,en;q=0.9', 'user-agent': 'Mozilla/5.0 (compatible; AlexaPlaylistImportBot/1.0)' } }); }
    catch { throw unavailable(); }
    if ([301, 302, 303, 307, 308].includes(response?.status)) {
      const location = response.headers?.get?.('location');
      if (!safeText(location, 2048) || hop === 3) throw unavailable();
      let next; try { next = link(new URL(location, current.url).href); } catch { throw unavailable(); }
      if (!samePlaylist(initial, next)) throw unavailable(); current = next; continue;
    }
    if (!response?.ok) throw unavailable();
    if (response.url) { let actual; try { actual = link(response.url); } catch { throw unavailable(); } if (!samePlaylist(initial, actual)) throw unavailable(); }
    let html;
    try { html = await bodyText(response); } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
    return { html, context: current };
  }
  throw unavailable();
}
function entities(value) {
  return String(value).replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/giu, entity => {
    const names = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
    if (names[entity.toLowerCase()] !== undefined) return names[entity.toLowerCase()];
    const hex = /^&#x/iu.test(entity); const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}
const text = value => { const result = entities(typeof value === 'string' ? value : value?.text || '').replace(/\s+/gu, ' ').trim(); return safeText(result) ? result : ''; };
const visible = html => { const value = entities(html.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, ' ').replace(/<!--[\s\S]*?-->/gu, ' ').replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim(); return value.length <= 4096 ? value : ''; };
function attributes(value) {
  const result = {};
  for (const match of value.matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu)) result[match[1].toLowerCase()] = entities(match[2] ?? match[3] ?? match[4]);
  return result;
}
function safeUrl(value, base, artwork = false) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url; try { url = new URL(entities(value), base); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (artwork) { if (!['saavncdn.com', 'media-amazon.com', 'ssl-images-amazon.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return null; url.search = ''; }
  else {
    const sameService = JIO_HOSTS.has(base.hostname) ? JIO_HOSTS.has(url.hostname) : url.hostname === base.hostname;
    if (!sameService) return null;
    const trackAsin = url.searchParams.get('trackAsin'); url.search = '';
    if (trackAsin && /^[A-Z0-9]{10}$/.test(trackAsin)) url.searchParams.set('trackAsin', trackAsin);
  }
  url.hash = ''; return url.href;
}
function count(value) { if (typeof value === 'string' && /^\d{1,5}$/.test(value)) value = Number(value); if (!Number.isSafeInteger(value) || value < 0) throw unavailable(); if (value > 500) throw tooLarge(); return value; }
function trackRecord({ title, artists = [], album = '', artwork = null, url = null, durationMs = 0, releaseDate }, context, country) {
  title = text(title); if (!title) throw unavailable();
  artists = [...new Set(artists.map(text).filter(Boolean))]; const artist = artists.join(', ');
  if (artist && !safeText(artist)) throw unavailable();
  return { id: randomUUID(), title, artist, album: text(album), ...releaseYearMetadata(releaseDate), artwork: safeUrl(artwork, context.url, true), url: safeUrl(url, context.url) || context.url.href,
    durationMs: Number.isSafeInteger(durationMs) && durationMs >= 0 && durationMs <= 86400000 ? durationMs : 0,
    requestArtist: artists[0] || '', requestArtists: artists, needsReview: !artist, source: context.source, country };
}
// Parse only JSON-shaped bootstrap data plus serializer Date/undefined literals. Never execute page scripts.
function serializedState(html) {
  const marker = /(?:window\.)?__INITIAL_DATA__\s*=\s*/u.exec(html);
  if (!marker) throw unavailable();
  let at = marker.index + marker[0].length; const result = [], stack = [];
  if (html[at] !== '{') throw unavailable();
  while (at < html.length) {
    const char = html[at];
    if (char === '"') {
      const start = at++;
      while (at < html.length) { if (html[at] === '\\') { at += 2; continue; } if (html[at++] === '"') break; }
      result.push(html.slice(start, at)); continue;
    }
    if (html.startsWith('new Date(', at)) {
      const match = /^new Date\("(?:\\.|[^"\\])*"\)/u.exec(html.slice(at));
      if (!match) throw unavailable(); result.push('null'); at += match[0].length; continue;
    }
    if (html.startsWith('undefined', at) && !/[A-Za-z0-9_$]/u.test(html[at + 9] || '')) { result.push('null'); at += 9; continue; }
    if (char === '{' || char === '[') { stack.push(char); if (stack.length > 64) throw unavailable(); }
    if (char === '}' || char === ']') { if (stack.pop() !== (char === '}' ? '{' : '[')) throw unavailable(); }
    result.push(char); ++at;
    if (!stack.length) { try { return JSON.parse(result.join('')); } catch { throw unavailable(); } }
  }
  throw unavailable();
}
function jioPage(html, context, country) {
  const playlist = serializedState(html)?.playlist?.playlist;
  if (playlist?.type !== 'playlist' || !Array.isArray(playlist.list)) throw unavailable();
  let canonical; try { canonical = link(playlist.perma_url); } catch { throw unavailable(); }
  if (!samePlaylist(context, canonical)) throw unavailable();
  const total = count(playlist.list_count), name = text(playlist.title);
  if (!name || playlist.list.length !== total) throw unavailable();
  const tracks = playlist.list.map(row => {
    if (row?.type !== 'song') throw unavailable();
    const primary = Array.isArray(row.subtitle) ? row.subtitle.filter(artist => artist?.role === 'primary_artists').map(artist => artist.text) : [];
    const artists = primary.length ? primary : Array.isArray(row.artists) ? row.artists.filter(artist => ['singer', 'primary_artists'].includes(artist?.role)).map(artist => artist.name) : [];
    const duration = typeof row.duration === 'string' && /^\d{1,6}$/.test(row.duration) ? Number(row.duration) : row.duration;
    return trackRecord({ title: row.title, artists, album: row.album, releaseDate: row.release_date || row.year, artwork: row.image, url: row.perma_url || row.title?.action, durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : 0 }, context, country);
  });
  const author = safePlaylistAuthor(text(playlist.owner_name || playlist.owner?.name || playlist.author?.name || playlist.author));
  return { name, ...(author ? { author } : {}), artwork: safeTrackArtwork(playlist.image), tracks, total };
}
function amazonPage(html, context, country) {
  const totals = [...new Set([...html.matchAll(/\b(\d[\d,]*)\s+SONGS\b/giu)].map(match => Number(match[1].replaceAll(',', ''))))];
  if (totals.length !== 1) throw unavailable(); const total = count(totals[0]);
  const names = [...new Set([...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/giu)].map(match => visible(match[1])).filter(Boolean))];
  let name = names.length === 1 ? names[0] : '';
  if (!name) for (const match of html.matchAll(/<meta\b([^>]*)>/giu)) { const attr = attributes(match[1]); if (attr.property === 'og:title') { name = text(attr.content); break; } }
  if (!name) throw unavailable();
  const rows = [...html.matchAll(/<music-image-row\b[^>]*>([\s\S]*?)<\/music-image-row>/giu)].map(match => match[1]).filter(row => /<music-playback-button\b/iu.test(row));
  if (rows.length !== total) throw unavailable();
  const tracks = rows.map((row, index) => {
    const display = visible(row); if (Number(/^\s*(\d{1,4})\b/u.exec(display)?.[1]) !== index + 1) throw unavailable();
    const anchors = [...row.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)].map(match => ({ href: attributes(match[1]).href, label: visible(match[2]) }));
    const songs = anchors.filter(anchor => { try { const url = new URL(anchor.href, context.url); return url.hostname === context.url.hostname && /^\/albums\/[A-Z0-9]{10}$/u.test(url.pathname) && /^[A-Z0-9]{10}$/u.test(url.searchParams.get('trackAsin') || ''); } catch { return false; } });
    if (songs.length !== 1) throw unavailable();
    const artists = anchors.filter(anchor => { try { const url = new URL(anchor.href, context.url); return url.protocol === 'https:' && url.hostname === context.url.hostname && url.pathname.startsWith('/artists/'); } catch { return false; } }).map(anchor => anchor.label);
    const album = anchors.find(anchor => { try { const url = new URL(anchor.href, context.url); return url.protocol === 'https:' && url.hostname === context.url.hostname && url.pathname.startsWith('/albums/') && !url.searchParams.has('trackAsin'); } catch { return false; } })?.label || '';
    const durations = [...display.matchAll(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/gu)], duration = durations.at(-1);
    const durationMs = duration ? ((Number(duration[1] || 0) * 60 + Number(duration[2])) * 60 + Number(duration[3])) * 1000 : 0;
    const image = /<img\b([^>]*)>/iu.exec(row);
    return trackRecord({ title: songs[0].label, artists, album, artwork: image ? attributes(image[1]).src : null, url: songs[0].href, durationMs }, context, country);
  });
  const artwork = [...html.matchAll(/<meta\b([^>]*)>/giu)].map(match => attributes(match[1])).filter(attr => attr.property === 'og:image').map(attr => safeTrackArtwork(attr.content)).find(Boolean) || null;
  let author = null;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    if (attributes(match[1]).type?.toLowerCase() !== 'application/ld+json') continue;
    let data; try { data = JSON.parse(match[2]); } catch { continue; }
    const entries = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
    for (const entry of entries) {
      if (entry?.['@type'] !== 'MusicPlaylist') continue;
      let identity; try { identity = link(entry.url || entry['@id']); } catch { continue; }
      if (samePlaylist(context, identity)) {
        author = safePlaylistAuthor(text(typeof entry.author === 'string' ? entry.author : entry.author?.name));
        // Only a recording identified inside this exact playlist can contribute
        // a release date. The playlist's own publication date is unrelated.
        const identified = new Map(tracks.map(track => [track.url, track]));
        for (const recording of (Array.isArray(entry.track) ? entry.track : []).slice(0, 500)) {
          if (recording?.['@type'] !== 'MusicRecording') continue;
          const target = identified.get(safeUrl(recording.url || recording['@id'], context.url));
          if (target && text(recording.name) === target.title) Object.assign(target, releaseYearMetadata(recording.datePublished));
        }
      }
    }
  }
  return { name, ...(author ? { author } : {}), artwork, tracks, total };
}
export async function importPublicPlaylist(value, country, { fetcher = fetch } = {}) {
  const initial = link(value);
  if (!COUNTRIES.has(country)) throw new AppError(400, 'INVALID_COUNTRY', 'Choose a catalogue country before importing a playlist.');
  if (typeof fetcher !== 'function') throw unavailable();
  const { html, context } = await publicPage(initial, fetcher);
  const result = context.source === 'jiosaavn' ? jioPage(html, context, country) : amazonPage(html, context, country);
  const review = result.tracks.filter(track => track.needsReview).length;
  const notes = review ? [`${review} ${review === 1 ? 'song needs' : 'songs need'} an artist before saving or playing.`] : [];
  return { name: result.name, ...(result.author ? { author: result.author } : {}), artwork: result.artwork || null, source: context.source, tracks: result.tracks, total: result.total, skipped: 0, notes,
    url: context.url.href, method: 'public-page', availability: 'unverified' };
}
