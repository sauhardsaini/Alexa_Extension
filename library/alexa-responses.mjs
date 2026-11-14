// The normalized array returned by alexa-remote2#getCustomerHistoryRecords is
// the only accepted input shape. No history lookup, network call, or storage occurs here.
const unavailable = () => ({ response: null, status: 'unavailable' });
const ambiguous = () => ({ response: null, status: 'ambiguous' });
const commandText = value => typeof value === 'string' && value.length > 0 && value.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const deviceText = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const timestamp = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function normalizedCommand(value) {
  if (!commandText(value)) return null;
  const normalized = value.normalize('NFKC').replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').trim().toLowerCase()
    .replace(/^alexa(?:\s*[,!:]\s*|\s+)/u, '')
    .replace(/[.!?]+$/u, '').replace(/\s+/gu, ' ').trim();
  return normalized || null;
}
function responseText(value) {
  if (typeof value !== 'string' || value.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return null;
  return value.trim() || null;
}
function transcriptVariants(record) {
  const details = record?.conversionDetails;
  if (!details || typeof details !== 'object') return [];
  const variants = [];
  for (const type of ['CUSTOMER_TRANSCRIPT', 'ASR_REPLACEMENT_TEXT']) {
    const items = details[type];
    if (!Array.isArray(items)) continue;
    if (items.length > 50) return null;
    for (const item of items) {
      const value = normalizedCommand(item?.transcriptText);
      if (value) variants.push(value);
    }
  }
  return [...new Set(variants)];
}

/**
 * Best-effort correlation, not causal proof: the private history API exposes no
 * request ID linking a synthetic text command to its history entry. Window is
 * sentAt - 2 seconds through completedAt + 20 seconds, capped at sentAt + 30 seconds.
 * Missing or uncertain history must never be replaced with an inferred Alexa answer.
 */
export function findAlexaResponse(records, { text, deviceId, sentAt, completedAt } = {}) {
  const expected = normalizedCommand(text);
  if (!Array.isArray(records) || records.length > 200 || !expected || !deviceText(deviceId) || !timestamp(sentAt) || (completedAt !== undefined && (!timestamp(completedAt) || completedAt < sentAt))) return unavailable();
  const start = Math.max(0, sentAt - 2000);
  const end = Math.min(sentAt + 30_000, (completedAt ?? sentAt) + 20_000);
  const matches = new Map();
  let uncertain = false;
  // The library currently returns about ten entries. Bound work on unexpected input too.
  for (let index = 0; index < Math.min(records.length, 200); index++) {
    const record = records[index];
    if (!record || typeof record !== 'object' || record.deviceSerialNumber !== deviceId || !timestamp(record.creationTimestamp) || record.creationTimestamp < start || record.creationTimestamp > end) continue;
    if (record.data?.utteranceType === 'WAKE_WORD_ONLY') continue;
    const key = record.data?.recordKey;
    if (key !== undefined && (typeof key !== 'string' || key.length > 4096 || key.split('#')[3] !== deviceId)) continue;
    const summary = normalizedCommand(record.description?.summary);
    const variants = transcriptVariants(record);
    if (variants === null) { if (summary === expected) uncertain = true; continue; }
    const exactVariant = variants.includes(expected);
    if (summary !== expected && !exactVariant) continue;
    // Multiple unique customer transcripts can represent a chat with several turns.
    // A matching turn does not identify which response belongs to it.
    if (variants.some(value => value !== expected)) uncertain = true;
    const entryKey = key === undefined ? `index:${index}` : `record:${key}`;
    const response = responseText(record.alexaResponse);
    const prior = matches.get(entryKey);
    if (prior && (prior.timestamp !== record.creationTimestamp || prior.response !== response)) uncertain = true;
    if (!prior) matches.set(entryKey, { timestamp: record.creationTimestamp, response });
  }
  if (uncertain || matches.size > 1) return ambiguous();
  if (matches.size !== 1) return unavailable();
  const response = matches.values().next().value.response;
  return response ? { response, status: 'available' } : unavailable();
}
