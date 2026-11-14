import { AppError } from './errors.mjs';

const MAX_DURATION_MS = 24 * 60 * 60_000;
const safeText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
const key = value => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
const invalidPosition = () => new AppError(400, 'INVALID_POSITION', 'Choose a position before the end of the current song.');
const invalidTrack = () => new AppError(400, 'INVALID_TRACK', 'Refresh the Echo song before seeking.');
const songChanged = () => new AppError(409, 'SONG_CHANGED', 'The Echo song changed. Refresh its position before seeking.');

// The expected identity comes from the last Echo observation, never catalogue metadata.
export function validateSeekRequest(positionMs, expected) {
  if (!Number.isSafeInteger(positionMs) || positionMs < 0 || positionMs > MAX_DURATION_MS) throw invalidPosition();
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
    || !safeText(expected.title, 500) || !safeText(expected.artist, 500)
    || !Number.isSafeInteger(expected.durationMs) || expected.durationMs <= 0 || expected.durationMs > MAX_DURATION_MS
    || (expected.mediaId !== undefined && !safeText(expected.mediaId, 2048))
    || (expected.providerName !== undefined && !safeText(expected.providerName, 100))) throw invalidTrack();
  if (positionMs >= expected.durationMs) throw invalidPosition();
  return { title: expected.title.trim(), artist: expected.artist.trim(), durationMs: expected.durationMs,
    ...(expected.mediaId !== undefined ? { mediaId: expected.mediaId } : {}),
    ...(expected.providerName !== undefined ? { providerName: expected.providerName.trim() } : {}) };
}

export function validateSeekTarget(player, positionMs, expected) {
  const target = validateSeekRequest(positionMs, expected);
  if (!player || !['PLAYING', 'PAUSED'].includes(player.state)
    || !safeText(player.title, 500) || !safeText(player.artist, 500)
    || !Number.isFinite(player.durationMs) || player.durationMs <= 0 || player.durationMs > MAX_DURATION_MS
    || !Number.isFinite(player.positionMs) || player.positionMs < 0 || player.positionMs > player.durationMs + 5000) {
    throw new AppError(409, 'SEEK_UNAVAILABLE', 'Your Echo is not reporting a song position and duration. Try again while a song is playing.');
  }
  if (key(target.title) !== key(player.title) || key(target.artist) !== key(player.artist)
    || Math.abs(target.durationMs - player.durationMs) > 1000
    || (target.mediaId !== undefined && target.mediaId !== player.mediaId)
    || (target.providerName !== undefined && (!safeText(player.providerName, 100) || key(target.providerName) !== key(player.providerName)))) throw songChanged();
  if (positionMs >= player.durationMs) throw invalidPosition();
  return player;
}
