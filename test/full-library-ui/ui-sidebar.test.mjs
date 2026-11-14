import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../../library/public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../library/public/index.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function frontendFunction(name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(script);
  assert.ok(match, 'frontend function exists: ' + name);
  const rest = script.slice(match.index), next = /\n  (?:async )?function /g; next.lastIndex = 1;
  const end = next.exec(rest); return end ? rest.slice(0, end.index) : rest;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function event(key, extra = {}) { return { key, defaultPrevented: false, prevented: 0, preventDefault() { this.defaultPrevented = true; ++this.prevented; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.immediate = true; }, ...extra }; }

function harness({ mobile = false, canPlay = true, history = [{ id: 'kept-command', text: 'Original history' }] } = {}) {
  const nodes = new Map(), documentListeners = new Map(), windowListeners = new Map(), timers = new Map();
  let timerId = 0, small = mobile, fetchHook = null;
  const calls = [], effects = [], renders = [];
  const document = { hidden: false, activeElement: null, addEventListener(name, callback) { const listeners = documentListeners.get(name) || []; listeners.push(callback); documentListeners.set(name, listeners); }, hasFocus: () => true };
  class Node {
    constructor(id, tag = 'div') { this.id = id; this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = new Map(); this.dataset = {}; this.hidden = false; this.disabled = false; this.isConnected = true; this.open = false; this.tabIndex = tag === 'button' || tag === 'input' ? 0 : -1; this.textContent = ''; this.value = ''; this.focuses = 0; const names = new Set(); this.classList = { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name), toggle(name, value) { const enabled = value === undefined ? !names.has(name) : !!value; if (enabled) names.add(name); else names.delete(name); return enabled; } }; }
    appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'tabindex') this.tabIndex = Number(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute(name) { return name in this.attributes; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, callback) { const listeners = this.listeners.get(name) || []; listeners.push(callback); this.listeners.set(name, listeners); }
    focus() { if (!this.isConnected || this.disabled || !this.getClientRects().length) return; document.activeElement = this; ++this.focuses; }
    scrollIntoView() {}
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    getClientRects() { for (let node = this; node; node = node.parentNode) if (node.hidden || node.hasAttribute('inert')) return []; return this.isConnected ? [{}] : []; }
    closest(selector) { for (let node = this; node; node = node.parentNode) if (selector === '[role="tab"]' && node.getAttribute('role') === 'tab') return node; return null; }
    querySelectorAll(selector) {
      const all = []; const visit = node => { for (const child of node.children) { all.push(child); visit(child); } }; visit(this);
      if (selector.includes('[role="tab"]')) return all.filter(node => node.getAttribute('role') === 'tab');
      if (selector.includes('button') || selector.includes('input') || selector.includes('[tabindex]')) return all.filter(node => !node.disabled && (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(node.tagName) || node.hasAttribute('tabindex')));
      return [];
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    async dispatch(name, extra = {}) { const e = event(undefined, { target: this, currentTarget: this, ...extra }); for (const callback of this.listeners.get(name) || []) { await callback(e); if (e.immediate) break; } return e; }
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node(id, /(?:tab|toggle|button|close|backdrop|queue-next|queue-cancel)$/.test(id) ? 'button' : id === 'custom-command-input' ? 'input' : id === 'custom-command-submit' ? 'button' : 'div')); return nodes.get(id); };
  document.body = new Node('body', 'body'); document.activeElement = document.body;
  const app = document.body.appendChild(get('app-shell')), player = document.body.appendChild(get('player-bar'));
  app.appendChild(get('commands-toggle')); player.appendChild(get('player-queue-button'));
  const outside = app.appendChild(get('original-opener')); outside.tagName = 'BUTTON'; outside.tabIndex = 0; outside.focus();
  const sidebar = document.body.appendChild(get('right-sidebar')); sidebar.hidden = true;
  sidebar.appendChild(get('commands-close'));
  const tabs = sidebar.appendChild(get('sidebar-tabs')); tabs.setAttribute('role', 'tablist');
  for (const id of ['commands-sidebar-tab', 'queue-sidebar-tab']) { const tab = tabs.appendChild(get(id)); tab.setAttribute('role', 'tab'); tab.setAttribute('tabindex', '-1'); }
  const commands = sidebar.appendChild(get('commands-drawer')); commands.hidden = true;
  commands.appendChild(get('custom-command-input')); commands.appendChild(get('custom-command-submit'));
  const historyNode = commands.appendChild(get('commands-history')); historyNode.setAttribute('tabindex', '0');
  const queue = sidebar.appendChild(get('queue-progress')); queue.hidden = true;
  for (const id of ['queue-toggle', 'queue-next', 'queue-cancel']) queue.appendChild(get(id));
  document.body.appendChild(get('commands-backdrop')).hidden = true;
  document.body.appendChild(get('playlist-save-dialog')).open = false;
  document.querySelector = selector => ({ '.app-shell': app, '.player-bar': player, '#right-sidebar': sidebar }[selector] || null);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const state = { sidebarOpen: false, sidebarTab: 'commands', sidebarPreviousFocus: null, commandsOpen: false, queueOpen: false, sidebarModal: false, commandsModal: false, commandsPreviousFocus: null, commandsGeneration: 0, commandsTimer: null, commandsController: null, commands: structuredClone(history), commandsFingerprint: JSON.stringify(history), queue: { id: 'playing-queue', active: true, state: 'playing', items: [{ id: 'song', title: 'Song', state: 'current' }] }, playback: { id: 'playing-song', active: true, state: 'checking' }, queueItemsFingerprint: '', queueBusy: false };
  const context = vm.createContext({ state, $: get, document, window: { matchMedia: () => ({ matches: small }), addEventListener(name, callback) { const listeners = windowListeners.get(name) || []; listeners.push(callback); windowListeners.set(name, listeners); } }, console, JSON, Promise, Map, Set, Array, AbortController,
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => { const call = { url, signal: options.signal }; calls.push(call); return fetchHook ? fetchHook(call) : { ok: true, json: async () => ({ commands: structuredClone(history) }) }; },
    api: (...args) => { effects.push(args); throw new Error('Opening a sidebar must not mutate playback.'); },
    closeQueueMenus() {}, canPlay: () => canPlay, renderCustomCommand: () => renders.push('custom'), renderCommands: () => renders.push('history'), renderQueue: () => renders.push('queue'), refreshStatus: () => renders.push('status'), refreshPlayer: () => renders.push('player'), cancelPlayback: () => effects.push('cancel'), queueControl: () => effects.push('queue-control')
  });
  const names = [...script.matchAll(/^  (?:async )?function ([A-Za-z0-9_]+)\(/gm)].map(match => match[1]).filter(name => /sidebar/i.test(name) || ['toggleQueue', 'toggleCommands', 'updateCommandsModality', 'commandsKeydown', 'refreshCommands', 'stopCommandsPolling'].includes(name));
  vm.runInContext(names.map(frontendFunction).join('\n'), context);
  const bindings = script.split('\n').filter(line => line.includes('addEventListener') && (line.includes("$('commands-toggle')") || line.includes("$('player-queue-button')") || line.includes("$('commands-close')") || line.includes("$('commands-backdrop')") || line.includes("$('commands-sidebar-tab')") || line.includes("$('queue-sidebar-tab')") || line.includes('sidebarTabsKeydown') || line.includes("document.addEventListener('keydown'") || line.includes("document.addEventListener('visibilitychange'") || line.includes("window.addEventListener('resize'")));
  vm.runInContext(bindings.join('\n'), context);
  return { state, get, app, player, sidebar, outside, document, calls, effects, timers, renders, setMobile(value) { small = value; }, setFetch(callback) { fetchHook = callback; }, run: code => vm.runInContext(code, context),
    async dispatchDocument(name, extra = {}) { const e = event(undefined, { target: document.activeElement, ...extra }); for (const callback of documentListeners.get(name) || []) { await callback(e); if (e.immediate) break; } await flush(); return e; },
    async resize(value) { small = value; for (const callback of windowListeners.get('resize') || []) await callback({}); },
    async runTimer(id) { const timer = timers.get(id); assert.ok(timer); timers.delete(id); await timer.callback(); await flush(); },
  };
}

function assertTab(h, tab, open = true) {
  assert.equal(h.state.sidebarOpen, open); assert.equal(h.sidebar.hidden, !open);
  if (open) assert.equal(h.state.sidebarTab, tab);
  assert.equal(h.state.commandsOpen, open && tab === 'commands'); assert.equal(h.state.queueOpen, open && tab === 'queue');
  assert.equal(h.get('commands-drawer').hidden, !(open && tab === 'commands')); assert.equal(h.get('queue-progress').hidden, !(open && tab === 'queue'));
  if (open) {
    for (const name of ['commands', 'queue']) { const active = name === tab; assert.equal(h.get(name + '-sidebar-tab').getAttribute('aria-selected'), String(active)); assert.equal(h.get(name + '-sidebar-tab').tabIndex, active ? 0 : -1); }
  }
}

test('shared sidebar opens Commands by default and footer/top triggers select then toggle their tab', async () => {
  const h = harness(); h.run('toggleCommands(true)'); await flush(); assertTab(h, 'commands');
  await h.get('player-queue-button').dispatch('click'); assertTab(h, 'queue');
  await h.get('player-queue-button').dispatch('click'); assertTab(h, 'queue', false);
  await h.get('commands-toggle').dispatch('click'); assertTab(h, 'commands');
  await h.get('commands-toggle').dispatch('click'); assertTab(h, 'commands', false);
});

test('internal tabs switch panels while retaining the open sidebar and automatic Queue opens are idempotent', async () => {
  const h = harness(); h.run('toggleCommands(true)'); await flush();
  await h.get('queue-sidebar-tab').dispatch('click'); assertTab(h, 'queue');
  h.run('toggleQueue(true)'); h.run('toggleQueue(true)'); assertTab(h, 'queue');
  await h.get('commands-sidebar-tab').dispatch('click'); assertTab(h, 'commands');
  h.run('selectSidebarTab("queue",{focus:false})'); assertTab(h, 'queue');
});

test('close button, Escape and backdrop close the whole bar without restoring another panel', async () => {
  for (const close of ['button', 'escape', 'backdrop']) {
    const h = harness({ mobile: true }); h.run('toggleCommands(true)'); await flush(); h.run('toggleQueue(true)');
    if (close === 'button') await h.get('commands-close').dispatch('click');
    else if (close === 'backdrop') await h.get('commands-backdrop').dispatch('click');
    else { const e = await h.dispatchDocument('keydown', { key: 'Escape' }); assert.equal(e.defaultPrevented, true); }
    assertTab(h, 'queue', false); assert.equal(h.get('commands-backdrop').hidden, true);
    assert.equal(h.app.hasAttribute('inert'), false); assert.equal(h.player.hasAttribute('inert'), false);
    assert.equal(h.document.activeElement, h.outside);
  }
});

test('tab keyboard navigation supports wrapping arrows, Home and End without closing the bar', async () => {
  const h = harness(); h.run('toggleCommands(true)'); await flush();
  for (const [from, key, expected] of [['commands', 'ArrowRight', 'queue'], ['queue', 'ArrowRight', 'commands'], ['commands', 'ArrowLeft', 'queue'], ['queue', 'Home', 'commands'], ['commands', 'End', 'queue']]) {
    h.run('selectSidebarTab(' + JSON.stringify(from) + ')');
    const tab = h.get(from + '-sidebar-tab'); tab.focus(); const e = await tab.dispatch('keydown', { key });
    assert.equal(e.defaultPrevented, true); assertTab(h, expected); assert.equal(h.document.activeElement, h.get(expected + '-sidebar-tab'));
  }
});

test('mobile modality and resize apply and release inert surfaces for either tab', async () => {
  const h = harness(); h.run('toggleCommands(true)'); await flush();
  assert.equal(h.app.hasAttribute('inert'), false); assert.equal(h.sidebar.getAttribute('aria-modal'), 'false');
  await h.resize(true); assert.equal(h.app.hasAttribute('inert'), true); assert.equal(h.player.hasAttribute('inert'), true); assert.equal(h.sidebar.getAttribute('aria-modal'), 'true'); assert.equal(h.get('commands-backdrop').hidden, false);
  h.run('toggleQueue(true)'); assertTab(h, 'queue'); assert.equal(h.app.hasAttribute('inert'), true);
  await h.resize(false); assertTab(h, 'queue'); assert.equal(h.app.hasAttribute('inert'), false); assert.equal(h.get('commands-backdrop').hidden, true);
  h.run('closeSidebar()'); assert.equal(h.document.body.classList.contains('sidebar-modal'), false); assert.equal(h.sidebar.getAttribute('aria-modal'), 'false');
});

test('mobile focus trap stays inside the shared sidebar and close restores the original outside focus', async () => {
  const h = harness({ mobile: true }); h.run('toggleCommands(true)'); await flush(); h.run('toggleQueue(true)');
  const visible = h.sidebar.querySelectorAll('button,input,[tabindex]').filter(node => node.getClientRects().length && node.tabIndex !== -1);
  const first = visible[0], last = visible.at(-1); last.focus();
  const forward = await h.dispatchDocument('keydown', { key: 'Tab' }); assert.equal(forward.defaultPrevented, true); assert.equal(h.document.activeElement, first);
  first.focus(); const back = await h.dispatchDocument('keydown', { key: 'Tab', shiftKey: true }); assert.equal(back.defaultPrevented, true); assert.equal(h.document.activeElement, last);
  h.run('closeSidebar()'); assert.equal(h.document.activeElement, h.outside);
});

test('a removed previous focus target falls back to a connected outside trigger', async () => {
  const h = harness(); h.run('toggleCommands(true)'); await flush(); h.outside.isConnected = false; h.run('toggleQueue(true)'); h.run('closeSidebar()');
  assert.ok([h.get('commands-toggle'), h.get('player-queue-button')].includes(h.document.activeElement)); assert.equal(h.sidebar.contains(h.document.activeElement), false);
});

test('tab changes abort hidden Commands polling, ignore its late response and resume only when visible', async () => {
  const h = harness(), delayed = deferred(); h.setFetch(() => delayed.promise);
  h.run('toggleCommands(true)'); assert.equal(h.calls.length, 1); const oldSignal = h.calls[0].signal;
  h.run('toggleQueue(true)'); assert.equal(oldSignal.aborted, true); assert.equal(h.state.commandsController, null);
  delayed.resolve({ ok: true, json: async () => ({ commands: [{ id: 'late-hidden', text: 'Must not replace visible history' }] }) }); await flush();
  assert.equal(h.state.commands[0].id, 'kept-command'); assert.equal([...h.timers.values()].some(timer => timer.ms === 2000), false);
  h.setFetch(async () => ({ ok: true, json: async () => ({ commands: [{ id: 'fresh-command', text: 'Fresh visible history' }] }) }));
  h.run('toggleCommands(true)'); await flush(); assert.equal(h.calls.length, 2); assert.equal(h.state.commands[0].id, 'fresh-command');
  const poll = [...h.timers.entries()].find(([, timer]) => timer.ms === 2000); assert.ok(poll); await h.runTimer(poll[0]); assert.equal(h.calls.length, 3);
  h.run('closeSidebar()'); await flush(); assert.equal([...h.timers.values()].some(timer => timer.ms === 2000), false);
});

test('page visibility resumes history polling only for the visible Commands tab', async () => {
  const h = harness(); h.run('toggleCommands(true)'); await flush();
  h.document.hidden = true; await h.dispatchDocument('visibilitychange'); const count = h.calls.length;
  h.run('toggleQueue(true)'); h.document.hidden = false; await h.dispatchDocument('visibilitychange'); assert.equal(h.calls.length, count);
  h.run('toggleCommands(true)'); await flush(); assert.equal(h.calls.length, count + 1);
});

test('showing and hiding sidebar panels never mutates queue, playback, history entries or command transport', async () => {
  const h = harness(), queue = h.state.queue, playback = h.state.playback, history = JSON.stringify(h.state.commands);
  h.run('toggleCommands(true)'); await flush(); h.run('toggleQueue(true)'); h.run('toggleQueue(true)'); h.run('closeSidebar()'); h.run('toggleCommands(true)'); await flush(); h.run('closeSidebar()');
  assert.equal(h.state.queue, queue); assert.equal(h.state.playback, playback); assert.equal(JSON.stringify(h.state.commands), history); assert.deepEqual(h.effects, []);
  assert.ok(h.calls.every(call => call.url === '/api/commands'));
});

test('shared sidebar tabs and panels have linked accessible roles in the actual markup', () => {
  for (const id of ['right-sidebar', 'commands-sidebar-tab', 'queue-sidebar-tab', 'commands-drawer', 'queue-progress']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(html, /id="commands-sidebar-tab"[^>]*role="tab"|role="tab"[^>]*id="commands-sidebar-tab"/);
  assert.match(html, /id="queue-sidebar-tab"[^>]*role="tab"|role="tab"[^>]*id="queue-sidebar-tab"/);
  assert.match(html, /id="commands-drawer"[^>]*role="tabpanel"|role="tabpanel"[^>]*id="commands-drawer"/);
  assert.match(html, /id="queue-progress"[^>]*role="tabpanel"|role="tabpanel"[^>]*id="queue-progress"/);
  for (const [tab, panel] of [['commands-sidebar-tab', 'commands-drawer'], ['queue-sidebar-tab', 'queue-progress']]) {
    const tabTag = html.match(new RegExp('<button[^>]*id="' + tab + '"[^>]*>'))?.[0];
    const panelTag = html.match(new RegExp('<section[^>]*id="' + panel + '"[^>]*>'))?.[0];
    assert.match(tabTag || '', new RegExp('aria-controls="' + panel + '"')); assert.match(panelTag || '', new RegExp('aria-labelledby="' + tab + '"'));
  }
});


test('focus restoration falls back when the original opener becomes hidden through an ancestor', async () => {
  const h = harness(); h.run('toggleCommands(true)'); await flush();
  const oldView = h.app.appendChild(h.get('old-view')); oldView.appendChild(h.outside); oldView.hidden = true;
  h.run('toggleQueue(true)'); h.run('closeSidebar()');
  assert.equal(h.document.activeElement, h.get('player-queue-button')); assert.ok(h.document.activeElement.getClientRects().length);
});

test('entering mobile modality moves outside focus into the open sidebar', async () => {
  const h = harness(); h.run('toggleCommands(true)'); await flush(); h.outside.focus();
  assert.equal(h.document.activeElement, h.outside); await h.resize(true);
  assert.ok(h.sidebar.contains(h.document.activeElement), 'modal focus must not remain inside an inert outside surface');
  assert.ok(h.document.activeElement.getClientRects().length);
});

test('an open save dialog keeps Escape from closing the underlying sidebar', async () => {
  const h = harness({ mobile: true }); h.run('toggleQueue(true)'); h.get('playlist-save-dialog').open = true;
  const key = await h.dispatchDocument('keydown', { key: 'Escape' }); assertTab(h, 'queue'); assert.equal(key.defaultPrevented, false);
});


test('entering mobile modality respects focus owned by an open save dialog', async () => {
  const h = harness(); h.run('toggleCommands(true)'); await flush();
  const dialog = h.get('playlist-save-dialog'), input = dialog.appendChild(h.get('save-dialog-input')); input.tagName = 'INPUT'; input.tabIndex = 0;
  dialog.open = true; input.focus(); await h.resize(true);
  assert.equal(h.document.activeElement, input); assert.equal(h.sidebar.getAttribute('aria-modal'), 'true');
});
