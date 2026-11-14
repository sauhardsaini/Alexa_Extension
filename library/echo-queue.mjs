const clean = (value, max = 250) => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim().slice(0, max) : '';
const label = value => clean(typeof value === 'string' ? value : value?.name || value?.text);
const unavailable = () => ({ state: 'unavailable', items: [], providerName: '', message: 'Alexa did not provide an upcoming-song list for this playback. It may still continue playing songs automatically.' });

// Whitelist display metadata only. Provider queue entries can contain opaque
// playback tokens and URLs that must not be returned to the browser.
export function normalizeEchoQueue(payload) {
  const rows = Array.isArray(payload?.queue) ? payload.queue : Array.isArray(payload?.queue?.items) ? payload.queue.items : Array.isArray(payload?.items) ? payload.items : null;
  if (!rows) return unavailable();
  const at = payload.currentIndex ?? payload.queue?.currentIndex;
  const currentIndex = Number.isInteger(at) && at >= 0 && at < rows.length ? at : null;
  const items = rows.slice(0, 50).flatMap((entry, index) => {
    const title = label(entry?.title) || clean(entry?.trackName);
    if (!title) return [];
    const artist = label(entry?.artist) || clean(entry?.artistName) || label(entry?.subtitle);
    const state = currentIndex === null ? 'reported' : index < currentIndex ? 'played' : index === currentIndex ? 'current' : 'pending';
    return [{ id: String(index), title, artist, state }];
  }).filter(item => item.state !== 'played');
  return items.length ? { state: 'available', items, providerName: label(payload.provider), message: 'Songs reported by Alexa. This may be a partial list; autoplay can add songs later.' } : unavailable();
}
