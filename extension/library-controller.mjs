import { HELPER, libraryRoute, cleanMessage } from './library-protocol.mjs';
export class LibraryController {
  constructor(api, { fetchImpl = globalThis.fetch, timeoutMs = 25000 } = {}) {
    this.api = api; this.fetch = fetchImpl.bind(globalThis); this.timeoutMs = timeoutMs; this.token = ''; this.openFlight = null;
    this.ready = this.initialize();
  }
  async initialize() {
    await this.api.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    const stored = await this.api.storage.local.get(['pairToken']);
    this.token = typeof stored.pairToken === 'string' ? stored.pairToken : '';
    await this.api.storage.session?.remove?.(['follow', 'handoff', 'lastPlayback', 'ownAutoJob']);
  }
  trusted(sender) {
    if (sender?.id !== this.api.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
    try { const url = new URL(sender.url); return url.href.split('?')[0].split('#')[0] === this.api.runtime.getURL('app.html'); } catch { return false; }
  }
  async openLibrary() {
    await this.ready;
    if (this.openFlight) return this.openFlight;
    this.openFlight = (async () => {
      const url = HELPER + '/', tabs = await this.api.tabs.query({ url });
      const existing = tabs.find(tab => tab.url?.split('?')[0].split('#')[0] === url);
      if (existing) { await this.api.tabs.update(existing.id, { active: true }); if (Number.isInteger(existing.windowId)) await this.api.windows?.update?.(existing.windowId, { focused: true }); }
      else await this.api.tabs.create({ url });
      return { ok: true };
    })();
    try { return await this.openFlight; } finally { this.openFlight = null; }
  }
  async request(path, { method = 'GET', body } = {}, token = this.token) {
    if (!token) throw new Error('Connect this extension to the local helper using its pairing code.');
    const route = libraryRoute(path, method);
    if (!route) throw new Error('This action is not available in Echo Companion.');
    if (method === 'GET' && body !== undefined) throw new Error('A read request cannot contain command data.');
    if (method === 'POST' && (body === null || typeof body !== 'object' || Array.isArray(body))) throw new Error('This action needs a valid request.');
    let serialized;
    if (method === 'POST') { serialized = JSON.stringify(body); if (new TextEncoder().encode(serialized).length > 524288) throw new Error('This request is too large. Import up to 500 reviewed songs.'); }
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(HELPER + '/api/library' + route.slice('/api'.length), { method, cache:'no-store', credentials:'omit', redirect:'error', signal:abort.signal, headers:{ Authorization:'Bearer ' + token, 'X-Echo-Extension':this.api.runtime.id, ...(method === 'POST' ? {'Content-Type':'application/json'} : {}) }, ...(serialized === undefined ? {} : {body:serialized}) });
      const raw = await response.text();
      if (raw.length > 6 * 1024 * 1024) throw new Error('The helper returned too much data. Try a smaller playlist.');
      let data; try { data = JSON.parse(raw); } catch { throw new Error('The local helper returned an unreadable response. Restart the updated helper.'); }
      return { ok:response.ok, status:response.status, data };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(method === 'POST' ? 'The helper did not confirm this action in time. Check the Echo before repeating a playback request.' : 'The helper took too long to respond. Try again.');
      if (error instanceof TypeError) throw new Error('The local Echo Companion helper is stopped or unavailable. Start it on this Mac, then retry.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async connection() {
    const version = this.api.runtime.getManifest().version;
    if (!this.token) return { ok:true, paired:false, helperAvailable:false, version, message:'Open the local helper, create a pairing code, and paste it here.' };
    try {
      const response = await this.request('/api/status');
      if (response.status === 401 || response.status === 403) return { ok:true, paired:false, helperAvailable:true, version, message:'The pairing code changed. Create a new code in the helper and connect again.' };
      return { ok:true, paired:true, helperAvailable:response.ok, version, message:response.ok ? 'Connected to the local helper.' : cleanMessage(response.data?.message, 'Start the updated Echo Companion helper.') };
    } catch (error) { return { ok:true, paired:true, helperAvailable:false, version, message:cleanMessage(error.message) }; }
  }
  async handle(message, sender) {
    await this.ready;
    if (!this.trusted(sender)) return { ok:false, message:'Open the Echo Companion music library to use this action.' };
    try {
      if (message?.type === 'GET_CONNECTION') return await this.connection();
      if (message?.type === 'OPEN_HELPER') { await this.api.tabs.create({url:HELPER + '/setup'}); return {ok:true}; }
      if (message?.type === 'SET_PAIR_TOKEN') {
        const token = typeof message.token === 'string' ? message.token.trim() : '';
        if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error('Paste the pairing code shown by the local helper.');
        const response = await this.request('/api/status', {}, token);
        if (!response.ok) throw new Error(cleanMessage(response.data?.message, 'This pairing code could not be verified.'));
        await this.api.storage.local.set({pairToken:token}); this.token = token;
        return {ok:true,message:'Connected. Search music or import a playlist to begin.'};
      }
      if (message?.type === 'LIBRARY_REQUEST') return {ok:true,response:await this.request(message.path,{method:message.method || 'GET',...(Object.hasOwn(message,'body') ? {body:message.body} : {})})};
      return {ok:false,message:'This action is not available. Use the music library.'};
    } catch (error) { return {ok:false,message:cleanMessage(error?.message)}; }
  }
}
