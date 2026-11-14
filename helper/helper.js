(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const regionNames = { IN: 'India', US: 'United States', UK: 'United Kingdom', DE: 'Germany', CA: 'Canada', AU: 'Australia', JP: 'Japan' };
  const localeNames = { 'en-IN': 'English (India)', 'hi-IN': 'Hindi', 'en-US': 'English (US)', 'en-GB': 'English (UK)', 'en-CA': 'English (Canada)', 'fr-CA': 'French (Canada)', 'en-AU': 'English (Australia)', 'de-DE': 'German', 'ja-JP': 'Japanese' };
  let busy = false, amazonBusy = false, amazonLoaded = false, amazonDirty = false, polling = false, stopped = false, amazonRevision = 0;
  let amazon = { connection: { state: 'disconnected' }, settings: { region: 'IN', locale: '' }, devices: [] };
  const clean = (value, max = 600) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

  async function api(route, method = 'GET', body = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(route, { method, cache: 'no-store', signal: controller.signal, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json', 'X-Echo-Companion': '1' }, body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(clean(data.message) || 'The local helper could not complete this request.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The connection is taking longer than expected. Check the helper and try again.');
      if (error instanceof TypeError) throw new Error('The local helper is unavailable. Keep it running and reload this page.');
      if (error instanceof SyntaxError) throw new Error('The helper returned an unreadable response. Reload this page and try again.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function message(id, text, error = false) {
    $(id).textContent = clean(text);
    $(id).classList.toggle('error', error);
  }
  function showPairStatus(data) {
    $('pair-status').textContent = data.paired ? data.extensionId ? 'Paired with browser extension ' + clean(data.extensionId, 80) + '.' : 'Pairing code created. Paste it into the extension to finish connecting.' : 'No browser extension is paired yet.';
    $('create-pair').textContent = data.paired ? 'Create a new pairing code' : 'Create pairing code';
    $('revoke-pair').hidden = !data.paired;
  }
  function localLogin(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.origin === 'http://127.0.0.1:4321' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function showAmazon(data) {
    amazon = { ...amazon, ...data, connection: data.connection || amazon.connection, settings: data.settings || amazon.settings };
    const connection = amazon.connection || {}, state = connection.state || 'disconnected';
    const pending = ['connecting', 'awaiting_login'].includes(state), connected = state === 'connected';
    $('amazon-title').textContent = connected ? 'Amazon connected' : 'Connect Amazon';
    $('amazon-state-label').textContent = ({ connected: 'CONNECTED', connecting: 'CONNECTING', awaiting_login: 'SIGN-IN NEEDED', error: 'CHECK CONNECTION', disconnected: 'NOT CONNECTED' })[state] || 'CHECK CONNECTION';
    $('amazon-dot').dataset.state = state;
    $('amazon-status').textContent = clean(connection.message) || (connected ? 'Your Amazon account is connected. Choose your Echo in the extension.' : 'Connect your Amazon account to find your Echo.');
    $('amazon-status').dataset.state = state;
    $('connect-amazon').hidden = connected || state === 'awaiting_login';
    $('connect-amazon').disabled = amazonBusy || pending;
    $('connect-amazon').textContent = state === 'connecting' ? 'Connecting…' : 'Connect Amazon ↗';
    $('disconnect-amazon').hidden = !connected && !pending && state !== 'error';
    $('disconnect-amazon').disabled = amazonBusy;
    $('disconnect-amazon').textContent = pending ? 'Cancel connection' : 'Disconnect Amazon';
    $('amazon-fields').hidden = connected;
    $('amazon-region').disabled = amazonBusy || pending;
    $('amazon-locale').disabled = amazonBusy || pending;
    const loginUrl = state === 'awaiting_login' ? localLogin(connection.loginUrl) : null;
    $('amazon-login-link').hidden = !loginUrl;
    if (loginUrl) $('amazon-login-link').href = loginUrl;
    else $('amazon-login-link').removeAttribute('href');
    if (!amazonDirty && !amazonBusy) {
      const region = amazon.settings?.region;
      if (Object.hasOwn(regionNames, region)) $('amazon-region').value = region;
      const locale = amazon.settings?.locale;
      if (!amazonLoaded) $('amazon-locale').value = Object.hasOwn(localeNames, locale) ? locale : '';
    }
    const devices = Array.isArray(amazon.devices) ? amazon.devices : [];
    const names = devices.slice(0, 20).map(device => clean(device.name, 100)).filter(Boolean);
    $('amazon-devices').hidden = !connected;
    $('amazon-devices').textContent = names.length ? 'Available Echo speakers: ' + names.join(', ') + '.' : 'No Echo speakers were reported. Check the devices linked to this Amazon account.';
    amazonLoaded = true;
  }
  async function pairAction(fn) {
    if (busy) return;
    busy = true; $('create-pair').disabled = true; $('revoke-pair').disabled = true; message('message', '');
    try { await fn(); } catch (error) { message('message', error.message, true); }
    finally { busy = false; $('create-pair').disabled = false; $('revoke-pair').disabled = false; }
  }
  async function amazonAction(fn) {
    if (amazonBusy) return;
    amazonBusy = true; amazonRevision++; message('amazon-message', ''); showAmazon(amazon);
    try {
      const data = await fn(); amazonDirty = false;
      amazonBusy = false; showAmazon(data);
      if (data.message) message('amazon-message', data.message);
    } catch (error) { message('amazon-message', error.message, true); }
    finally { amazonBusy = false; showAmazon(amazon); await refreshAmazon(); }
  }
  async function refreshAmazon() {
    const startedRevision = amazonRevision;
    try {
      const data = await api('/api/amazon/status');
      if (!stopped && !amazonBusy && startedRevision === amazonRevision) showAmazon(data);
    } catch (error) {
      if (!stopped && !amazonBusy && startedRevision === amazonRevision) {
        message('amazon-message', error.message, true);
        $('amazon-state-label').textContent = 'HELPER UNAVAILABLE';
        $('amazon-login-link').hidden = true;
        $('amazon-login-link').removeAttribute('href');
        $('connect-amazon').disabled = false;
        $('disconnect-amazon').disabled = false;
      }
    }
  }
  async function poll() {
    if (polling || stopped) return;
    polling = true;
    await Promise.allSettled([
      amazonBusy ? Promise.resolve() : refreshAmazon(),
      busy ? Promise.resolve() : api('/api/pair-status').then(data => { if (!busy && !stopped) showPairStatus(data); }).catch(error => { if (!stopped) $('pair-status').textContent = error.message; })
    ]);
    polling = false;
  }
  $('amazon-connect-form').addEventListener('submit', event => {
    event.preventDefault();
    if (['connecting', 'awaiting_login', 'connected'].includes(amazon.connection?.state)) return;
    const region = $('amazon-region').value, locale = $('amazon-locale').value;
    if (!Object.hasOwn(regionNames, region) || (locale && !Object.hasOwn(localeNames, locale))) { message('amazon-message', 'Choose an Amazon region and supported Echo language.', true); return; }
    amazonAction(() => api('/api/amazon/connect', 'POST', { region, locale }));
  });
  $('disconnect-amazon').addEventListener('click', () => amazonAction(() => api('/api/amazon/disconnect', 'POST')));
  $('amazon-region').addEventListener('change', () => { amazonDirty = true; $('amazon-locale').value = ''; });
  $('amazon-locale').addEventListener('change', () => { amazonDirty = true; });
  $('create-pair').addEventListener('click', () => pairAction(async () => {
    const data = await api('/api/pair', 'POST'); showPairStatus(data); $('pair-code').value = data.token; $('code-section').hidden = false; message('message', data.message);
  }));
  $('revoke-pair').addEventListener('click', () => pairAction(async () => {
    const data = await api('/api/revoke', 'POST'); showPairStatus(data); $('pair-code').value = ''; $('code-section').hidden = true; message('message', data.message);
  }));
  $('copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('pair-code').value); message('message', 'Pairing code copied. Paste it into Echo Companion.'); }
    catch { $('pair-code').focus(); $('pair-code').select(); message('message', 'Press Command+C to copy the selected pairing code.'); }
  });
  const interval = setInterval(() => { if (document.visibilityState !== 'hidden') poll(); }, 3000);
  window.addEventListener('unload', () => { stopped = true; clearInterval(interval); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  poll();
})();
