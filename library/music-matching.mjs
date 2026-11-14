import { cleanSongTitle, songTitleLanguages } from './song-title.mjs';
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 250 && !/[\u0000-\u001f\u007f]/u.test(value);
const spaces = value => value.replace(/\s+/gu, ' ').trim();
const versionHint = /\b(?:live|remix(?:ed)?|mix|acoustic|unplugged|reprise|remaster(?:ed)?|edit|version|instrumental|karaoke|sped[\s-]*up|slowed|reverb|demo|extended|original|mono|stereo|session|cover)\b/iu;
const taylorVersion = /\btaylor(?:['\u2019\u02bc]s|s)\s+version\b/giu;
const isTaylorVersion = value => text(value) && new RegExp(taylorVersion.source, 'iu').test(value);
export const hasTaylorsVersion = recording => isTaylorVersion(recording?.title) || isTaylorVersion(recording?.album);
const recordingTitle = value => text(value) ? normalizedTitle(value.replace(taylorVersion, ' ')) : null;

function normalized(value) {
  if (!text(value)) return null;
  // Strip Latin accents only: marks in scripts such as Devanagari distinguish different names.
  return spaces(value.normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').toLowerCase().replace(/&/gu, ' and ').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' '));
}
function normalizedTitle(value) {
  if (!text(value)) return null;
  return normalized(cleanSongTitle(value));
}
function featuredArtists(track) {
  if (!text(track?.title)) return [];
  const artists = [];
  for (const match of track.title.matchAll(/\(([^()]*)\)|\[([^\[\]]*)\]/gu)) {
    const clause = spaces(match[1] ?? match[2]);
    if (versionHint.test(clause)) continue;
    const credit = /^(?:feat\.?|ft\.?|featuring)\s+(.+)$/iu.exec(clause)?.[1];
    if (text(credit)) artists.push(spaces(credit));
  }
  return artists;
}
function structuredArtists(track) {
  return Array.isArray(track?.requestArtists) ? track.requestArtists.slice(0, 30).filter(text).map(spaces) : [];
}
function uniqueArtists(values) {
  const seen = new Set(), result = [];
  for (const value of values) {
    const key = normalized(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(spaces(value));
  }
  return result;
}
function canonicalArtist(track) {
  return text(track?.requestArtist) ? track.requestArtist : track?.artist;
}
function joinedArtistDisplay(display, credits) {
  const key = value => spaces(value.normalize('NFKC').toLowerCase());
  const full = key(display);
  if (credits.some(artist => normalized(artist) === normalized(display))) return false;
  const before = /(?:,|&|\b(?:and|feat\.?|ft\.?|featuring))\s*$/iu;
  const after = /^\s*(?:,|&|(?:and|feat\.?|ft\.?|featuring)\b)/iu;
  return credits.some(artist => {
    const name = key(artist);
    let at = full.indexOf(name);
    while (at !== -1) {
      const left = full.slice(0, at), right = full.slice(at + name.length);
      if ((left || right) && (!left || before.test(left)) && (!right || after.test(right))) return true;
      at = full.indexOf(name, at + 1);
    }
    return false;
  });
}

export function getMusicRequestCandidates(track, { preferredArtist = null, max = 3 } = {}) {
  if (!text(track?.title) || !text(track?.artist)) return [];
  const limit = Number.isFinite(max) ? Math.min(3, Math.max(0, Math.floor(max))) : 3;
  const credits = uniqueArtists(structuredArtists(track));
  const displayKey = normalized(track.artist);
  // Separately identified artist resources are the request names. A saved
  // display-credit string is not an additional artist, even if it was learned
  // by an older version or copied into requestArtist by a playlist import.
  const joinedDisplay = joinedArtistDisplay(track.artist, credits);
  const canonical = canonicalArtist(track);
  const primary = (joinedDisplay && normalized(canonical) === displayKey) || (text(canonical) && knownArtistCredits(canonical, credits)) ? credits[0] : canonical;
  const artists = uniqueArtists([preferredArtist, primary, ...featuredArtists(track), ...credits, ...(credits.length ? [] : [track.artist])])
    .filter(artist => (!joinedDisplay || normalized(artist) !== displayKey) && !knownArtistCredits(artist, credits));
  return artists.slice(0, limit).map(requestArtist => ({ ...track, requestArtist }));
}

function artistMatches(reported, expected) {
  const name = normalized(expected);
  if (!name) return false;
  if (normalized(reported) === name) return true;
  // Commas, ampersands, and 'and' may belong to one band name. Only explicit
  // guest-credit markers provide evidence that the display contains separate names.
  const credits = reported.split(/\b(?:feat\.?|ft\.?|featuring)\s+/iu);
  return credits.some(credit => normalized(credit) === name);
}
function knownArtistCredits(reported, names) {
  const key = value => spaces(value.normalize('NFKC').toLowerCase());
  const known = uniqueArtists(names).map(key).sort((left, right) => right.length - left.length);
  const separator = /^(?:\s*,\s*(?:(?:&|\band\b)\s*)?|\s*&\s*|\s+(?:and|featuring|feat\.?|ft\.?)\s+)/u;
  let remaining = key(reported);
  const used = new Set();
  while (remaining && used.size < known.length) {
    const name = known.find(value => !used.has(value) && remaining.startsWith(value) && (!remaining.slice(value.length) || separator.test(remaining.slice(value.length))));
    if (!name) return false;
    used.add(name); remaining = remaining.slice(name.length);
    if (!remaining) return used.size >= 2;
    const delimiter = separator.exec(remaining);
    if (!delimiter) return false;
    remaining = remaining.slice(delimiter[0].length);
    if (!remaining) return false;
  }
  return false;
}
const duration = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

export function comparePlayback(track, player, { candidateArtists = [] } = {}) {
  const state = typeof player?.state === 'string' ? player.state.trim().toUpperCase() : '';
  if (['STOPPED', 'IDLE', 'FINISHED'].includes(state)) return { verdict: 'mismatch', reason: 'Playback is stopped.' };
  if (state === 'PAUSED') return { verdict: 'unknown', reason: 'Playback is paused.' };
  if (state !== 'PLAYING') return { verdict: 'unknown', reason: 'Playback state is not confirmed.' };
  const expectedTitle = recordingTitle(track?.title), reportedTitle = recordingTitle(player?.title);
  const artists = uniqueArtists([canonicalArtist(track), track?.artist, ...featuredArtists(track), ...structuredArtists(track), ...(Array.isArray(candidateArtists) ? candidateArtists.slice(0, 30) : [])]);
  if (!expectedTitle || !reportedTitle || !text(player?.artist) || !artists.length) return { verdict: 'unknown', reason: 'Song or artist metadata is missing.' };
  if (expectedTitle !== reportedTitle) return { verdict: 'mismatch', reason: 'The reported song title or recording version differs.' };
  const selectedLanguages = songTitleLanguages(track?.title), reportedLanguages = songTitleLanguages(player?.title);
  if (selectedLanguages.length && reportedLanguages.length && !selectedLanguages.some(language => reportedLanguages.includes(language))) return { verdict: 'mismatch', reason: 'The reported song language differs.' };
  const expectedEdition = hasTaylorsVersion(track), reportedEdition = hasTaylorsVersion(player);
  if (expectedEdition !== reportedEdition) {
    // Some services omit the edition from the song title but retain it on the
    // album. Missing album evidence must not identify a selected rerecording.
    if (expectedEdition && !text(player?.album) && !isTaylorVersion(player?.title)) return { verdict: 'unknown', reason: 'The reported recording edition is not available.' };
    return { verdict: 'mismatch', reason: 'The reported recording edition differs.' };
  }
  const separatelyIdentified = [...structuredArtists(track), ...(Array.isArray(candidateArtists) ? candidateArtists.slice(0, 30).filter(text) : [])];
  if (!artists.some(artist => artistMatches(player.artist, artist)) && !knownArtistCredits(player.artist, separatelyIdentified)) return { verdict: 'mismatch', reason: 'The reported artist differs.' };
  const expectedDuration = duration(track?.durationMs), reportedDuration = duration(player?.durationMs);
  if (expectedDuration !== null && reportedDuration !== null && Math.abs(expectedDuration - reportedDuration) > Math.max(5000, expectedDuration * 0.03)) return { verdict: 'mismatch', reason: 'The reported recording duration differs.' };
  return { verdict: 'match', reason: 'The reported playing song and artist match.' };
}

/** Evidence of a title-track request being interpreted as its same-named album. */
export function isTitleTrackAlbumPlayback(track, player, { candidateArtists = [] } = {}) {
  const title = normalizedTitle(track?.title);
  if (!title || normalizedTitle(track?.album) !== title || normalizedTitle(player?.album) !== title
    || !normalizedTitle(player?.title) || normalizedTitle(player.title) === title) return false;
  // Reuse the song matcher for playing state and known artist credits, while
  // ignoring the different album song's duration. Keep version hints intact.
  return comparePlayback({ ...track, title: player.title, durationMs: 0,
    requestArtists: uniqueArtists([...structuredArtists(track), ...featuredArtists(track)]) }, player, { candidateArtists }).verdict === 'match';
}
