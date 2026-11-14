const spaces = value => value.replace(/\s+/gu, ' ').trim();
const versionHint = /\b(?:live|remix(?:ed)?|mix|acoustic|unplugged|reprise|remaster(?:ed)?|edit|version|instrumental|karaoke|sped[\s-]*up|slowed|reverb|demo|extended|original|mono|stereo|session|cover)\b/iu;
const guestClause = /\(\s*(?:feat\.?|ft\.?|featuring)\s+[^()]+\)|\[\s*(?:feat\.?|ft\.?|featuring)\s+[^\[\]]+\]/giu;
const languages = new Map([
  ['tamil', 'tamil'], ['hindi', 'hindi'], ['telugu', 'telugu'], ['malayalam', 'malayalam'], ['kannada', 'kannada'],
  ['punjabi', 'punjabi'], ['bengali', 'bengali'], ['bangla', 'bengali'], ['marathi', 'marathi'], ['gujarati', 'gujarati'],
  ['odia', 'odia'], ['oriya', 'odia'], ['assamese', 'assamese'], ['bhojpuri', 'bhojpuri'], ['urdu', 'urdu'],
  ['sanskrit', 'sanskrit'], ['konkani', 'konkani'], ['maithili', 'maithili'], ['nepali', 'nepali'],
  ['sinhala', 'sinhala'], ['sinhalese', 'sinhala'], ['english', 'english'], ['french', 'french'], ['spanish', 'spanish'],
  ['portuguese', 'portuguese'], ['brazilian portuguese', 'portuguese'], ['german', 'german'], ['italian', 'italian'],
  ['arabic', 'arabic'], ['japanese', 'japanese'], ['korean', 'korean'], ['chinese', 'chinese'], ['mandarin', 'mandarin'],
  ['mandarin chinese', 'mandarin'], ['cantonese', 'cantonese'], ['russian', 'russian'], ['turkish', 'turkish'],
]);
function languageTag(value) {
  const body = spaces(value).toLowerCase().replace(/\s+(?:language\s+)?version$/u, '').replace(/\s+language$/u, '');
  const parts = body.split(/\s*(?:[,/&+]|\band\b)\s*/u);
  if (!parts.length || parts.some(part => !languages.has(part))) return [];
  return [...new Set(parts.map(part => languages.get(part)))];
}

/** Explicit source-language tags; absence of a tag does not identify a language. */
export function songTitleLanguages(value) {
  if (typeof value !== 'string') return [];
  const result = [];
  for (const match of value.matchAll(/\(([^()]*)\)|\[([^\[\]]*)\]/gu)) result.push(...languageTag(match[1] ?? match[2]));
  return [...new Set(result)];
}

/** Request/matching title only. Callers retain the unmodified display metadata. */
export function cleanSongTitle(value) {
  if (typeof value !== 'string') return '';
  return spaces(value
    .replace(/\(\s*from\s+(?:"[^"]+"|'[^']+'|“[^”]+”|‘[^’]+’)\s*\)/giu, ' ')
    .replace(/\[\s*from\s+([^\[\]]+)\]/giu, (clause, credit) => {
      // Keep any explicit recording version outside a quoted film name.
      const remainder = credit.replace(/^(?:"[^"]+"|'[^']+'|“[^”]+”|‘[^’]+’)/u, '');
      return versionHint.test(remainder) ? clause : ' ';
    })
    .replace(/\(([^()]*)\)|\[([^\[\]]*)\]/gu, (clause, round, square) => languageTag(round ?? square).length ? ' ' : clause)
    .replace(guestClause, clause => versionHint.test(clause) ? clause : ' '));
}
