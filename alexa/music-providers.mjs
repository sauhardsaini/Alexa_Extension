import { AppError } from './errors.mjs';

const registry = new Map();
const nativeIds = new Map();
const normalized = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') : '';
const cleanName = value => typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} .&’'+()\-]{1,63}$/u.test(value);
function add(id, name, { commandName = name, kind = 'music', native = [], aliases = [] } = {}) {
  const provider = Object.freeze({ id, name, commandName, kind, aliases: Object.freeze([name, commandName, ...aliases]) });
  registry.set(id, provider);
  for (const nativeId of native) nativeIds.set(nativeId, id);
  return provider;
}
add('alexa-default', 'Alexa default', { commandName: '', kind: 'default', native: ['DEFAULT'] });
add('apple-music', 'Apple Music', { native: ['APPLE_MUSIC'] });
add('amazon-music', 'Amazon Music', { native: ['AMAZON_MUSIC'], aliases: ['Amazon Prime Music', 'Prime Music', 'Amazon Music Unlimited'] });
add('spotify', 'Spotify', { native: ['SPOTIFY'] });
add('jiosaavn', 'JioSaavn', { native: ['SAAVN', 'JIOSAAVN', 'JIO_SAAVN'], aliases: ['Saavn', 'Jio Saavn'] });
add('tunein', 'TuneIn', { native: ['TUNEIN', 'TUNE_IN'], kind: 'radio', aliases: ['TuneIn Radio'] });
add('deezer', 'Deezer', { native: ['DEEZER'] });
add('pandora', 'Pandora', { native: ['PANDORA'], kind: 'radio' });
add('iheartradio', 'iHeartRadio', { native: ['IHEARTRADIO', 'I_HEART_RADIO'], kind: 'radio', aliases: ['iHeart Radio'] });
add('siriusxm', 'SiriusXM', { native: ['SIRIUSXM', 'SIRIUS_XM'], kind: 'radio', aliases: ['Sirius XM'] });
add('tidal', 'TIDAL', { native: ['TIDAL'] });
add('gaana', 'Gaana', { native: ['GAANA'] });
add('hungama', 'Hungama Music', { native: ['HUNGAMA', 'HUNGAMA_MUSIC'], aliases: ['Hungama'] });

export function resolveMusicProvider(id = 'alexa-default') {
  if (typeof id !== 'string' || !registry.has(id)) throw new AppError(400, 'INVALID_MUSIC_PROVIDER', 'Choose a streaming service from the app.');
  return registry.get(id);
}
export function compareMusicProvider(id, reportedName) {
  const provider = resolveMusicProvider(id);
  if (provider.id === 'alexa-default') return { verdict: 'match', reason: 'No specific streaming service was requested.' };
  if (typeof reportedName !== 'string' || !reportedName.trim() || reportedName.length > 100 || /[\u0000-\u001f\u007f]/u.test(reportedName)) return { verdict: 'unknown', reason: 'The Echo has not reported its streaming service.' };
  return provider.aliases.some(alias => normalized(alias) === normalized(reportedName))
    ? { verdict: 'match', reason: 'The reported streaming service matches.' }
    : { verdict: 'mismatch', reason: `The Echo reported a different streaming service from ${provider.name}.` };
}
const publicProvider = (provider, reportedByAlexa = false) => ({ id: provider.id, name: provider.name, kind: provider.kind, reportedByAlexa });
function baseline(country) {
  const ids = ['alexa-default', 'apple-music', 'amazon-music', 'spotify'];
  if (country === 'IN') ids.push('jiosaavn');
  return new Map(ids.map(id => [id, publicProvider(resolveMusicProvider(id))]));
}
export function fallbackMusicProviders(country = 'IN') {
  return { providers: [...baseline(country).values()], defaultProviderId: null, discovery: 'unavailable', message: 'Choose a service linked in the Alexa app. Service availability and subscriptions depend on your Alexa account and country.' };
}
export function parseMusicProviders(payload, country = 'IN') {
  if (!Array.isArray(payload)) return fallbackMusicProviders(country);
  const providers = baseline(country), defaults = new Set();
  for (const row of payload.slice(0, 100)) {
    if (!row || typeof row !== 'object' || row.availability !== 'AVAILABLE' || !Array.isArray(row.supportedOperations) || !row.supportedOperations.includes('Alexa.Music.PlaySearchPhrase')) continue;
    if (row.id === 'DEFAULT' || row.id === 'CLOUDPLAYER') continue;
    let id = nativeIds.get(row.id);
    if (!id && typeof row.id === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(row.id) && cleanName(row.displayName) && registry.size < 100) {
      // Only services identified by Alexa's music-provider endpoint can extend the choices.
      id = 'alexa-' + row.id.toLowerCase().replaceAll('_', '-');
      const existing = registry.get(id);
      if (existing && existing.name !== row.displayName) continue;
      if (!existing) add(id, row.displayName.trim(), { native: [row.id] });
    }
    if (!id || id === 'alexa-default') continue;
    const provider = resolveMusicProvider(id);
    providers.set(id, publicProvider(provider, true));
    if (row.providerData?.isDefaultMusicProvider === true) defaults.add(id);
  }
  return { providers: [...providers.values()], defaultProviderId: defaults.size === 1 ? [...defaults][0] : null, discovery: 'ready', message: 'Services reported by Alexa are included. Link your selected service in the Alexa app if needed; listing a service does not confirm subscription access.' };
}
