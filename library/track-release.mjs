/** Optional release metadata describes the selected release, not a guessed recording age. */
export const normalizeReleaseYear = value => Number.isInteger(value) && value >= 1000 && value <= 9999 ? value : null;

export function releaseYearFromDate(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = /^([1-9]\d{3})(?:-(\d{2})(?:-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?)?)?$/u.exec(value);
  if (!match) return null;
  const year = normalizeReleaseYear(Number(match[1]));
  if (year === null) return null;
  if (match[2]) {
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    if (match[3]) {
      const day = Number(match[3]);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (day < 1 || day > days[month - 1]) return null;
      if (value.includes('T') && !Number.isFinite(Date.parse(value))) return null;
    }
  }
  return year;
}

export function releaseYearMetadata(value) {
  const releaseYear = typeof value === 'number' ? normalizeReleaseYear(value) : releaseYearFromDate(value);
  return releaseYear === null ? {} : { releaseYear };
}
