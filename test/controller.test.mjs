import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { CompanionController } from '../extension/controller.mjs';
import { sourceForUrl, normalizeTrack, followDecision, safeSettings } from '../extension/protocol.mjs';
globalThis.crypto ||= webcrypto;
const id = 'a'.repeat(32), url = 'https://music.youtube.com/watch?v=abcdefghijk';
const track = { source: 'youtube-music', title: 'Lover', artist: 'Taylor Swift', album: 'Lover', trackId: 'abcdefghijk', url, confidence: 'high', state: 'playing', positionMs: 0 };
function fixture({ saved = {}, session = {}, detected = track, fetchImpl } = {}) {
  let jobCounter = 0; const jobs = new Map();
  const values = { local: { ...saved }, session: { ...session } }, calls = [], tabs = [{ id: 7, url }];
  const storage = name => ({ async get() { return { ...values[name] }; }, async set(data) { Object.assign(values[name], structuredClone(data)); }, async setAccessLevel() {} });
  const api = { storage: { local: storage('local'), session: storage('session') }, runtime: { id, getURL: path => 'chrome-extension://' + id + '/' + path }, tabs: { async query() { return tabs; }, async get(tabId) { const tab = tabs.find(row => row.id === tabId); if (!tab) throw new Error('Missing tab'); return tab; }, async sendMessage(tabId, message) { if (message.type === 'CONTROL_SOURCE') { calls.push({ sourceTabId: tabId, sourceAction: message.action }); return { ok: true, track: { ...(message.expectedTrack || detected), state: message.action === 'pause' || message.hold ? 'paused' : 'playing' } }; } return { track: detected }; }, async update(tabId, properties) { const tab = tabs.find(row => row.id === tabId); if (!tab) throw new Error('Missing tab'); tab.mutedInfo = { muted: properties.muted }; calls.push({mutedTab:tabId,muted:properties.muted}); return tab; }, async create(input) { calls.push({ opened: input.url }); } } };
  const popup = { id, url: api.runtime.getURL('popup.html') };
  const sender = { id, url, frameId: 0, tab: tabs[0] };
  const fetchMock = fetchImpl || (async (address, options) => {
    const body = options.body && JSON.parse(options.body); calls.push({ address, options, body });
    if (address.endsWith('/api/play')) { const job = { id: 'job' + ++jobCounter, deviceId: body.deviceId, requestId: body.requestId, track: body.track, state: 'preparing' }; jobs.set(job.id,job); return { ok:true, async json(){return {ok:true,job,message:'Sent'};} }; }
    if (address.includes('/api/jobs/')) return {ok:true,async json(){const job=jobs.get(address.split('/').at(-1));return {ok:true,job:{...job,state:'matched'},isCurrent:true};}};
    return { ok: true, async json() { return { ok:true, connected: true, devices: [{ id: 'echo', name: 'Echo' }], providers: [],commands:[] }; } };
  });
  return { controller: new CompanionController(api, { fetchImpl: fetchMock, handoffPollMs:0 }), api, popup, sender, calls, values, tabs, sourceReply: message => ({ ok:true, track:{ ...(message.expectedTrack || detected),state:message.action === 'pause' || message.hold ? 'paused':'playing' } }) };
}
async function completed(f,message,sender){const result=await f.controller.handle(message,sender); if(result.handoff) await f.controller.handoffTask; return result;}
const configured = { pairToken: 't'.repeat(43), settings: { deviceId: 'echo', providerId: 'apple-music', country: 'IN' } };
test('only the three exact HTTPS sites are supported', () => {
  assert.equal(sourceForUrl(url), 'youtube-music');
  for (const value of ['http://music.youtube.com/', 'https://evil.test/', 'https://open.spotify.com.evil.test/', 'https://u:p@music.apple.com/', 'https://music.apple.com:9443/']) assert.equal(sourceForUrl(value), null);
});
test('metadata preserves recording versions and rejects control characters', () => {
  assert.equal(normalizeTrack({ ...track, title: 'Lover (Live From Paris)' }, url).title, 'Lover (Live From Paris)');
  assert.equal(normalizeTrack({ ...track, title: 'Lover\nPause' }, url), null);
  assert.equal(normalizeTrack({ ...track, artist: '' }, url).confidence, 'review');
  assert.equal(normalizeTrack({ ...track, source: 'spotify' }, url), null);
});
test('following ignores paused, ad, uncertain and duplicate tracks but supports repeats', () => {
  const follow = { enabled: true };
  const first = followDecision(follow, track); assert.equal(first.send, true);
  for (const change of [{ state: 'paused' }, { isAd: true }, { confidence: 'review' }, { artist: '' }]) assert.equal(followDecision(follow, { ...track, ...change }).send, false);
  assert.equal(followDecision({ ...follow, lastKey: first.key }, track).send, false);
  assert.equal(followDecision({ ...follow, lastKey: first.key, lastPositionMs: 170000 }, track).send, true);
  assert.equal(followDecision({ ...follow, lastKey: first.key, lastPositionMs: 1000 }, track).send, false);
});
test('content pages cannot access pairing controls or popup state', async () => {
  const f = fixture({ saved: configured });
  for (const type of ['GET_POPUP_STATE', 'SET_PAIR_TOKEN', 'PLAY_TRACK', 'SET_FOLLOW', 'CONTROL']) assert.equal((await completed(f,{ type, token: 'x'.repeat(43) }, f.sender)).ok, false);
  assert.equal(f.calls.length, 0);
});
test('popup state never exposes pairing token', async () => {
  const f = fixture({ saved: configured }); const state = await completed(f,{ type: 'GET_POPUP_STATE' }, f.popup);
  assert.equal(state.paired, true); assert.equal(state.settings.country, 'IN'); assert.equal(state.track.title, 'Lover');
  assert.equal(JSON.stringify(state).includes(configured.pairToken), false);
  assert.equal(f.calls[0].options.headers['X-Echo-Extension'], id);
});
test('manual Play forwards edits and validated preferences via helper only', async () => {
  const f = fixture({ saved: configured });
  const result = await completed(f,{ type: 'PLAY_TRACK', track: { title: 'OBVIOUS', artist: 'Hasan Raheem' } }, f.popup);
  assert.equal(result.ok, true); const play = f.calls.find(call => call.address?.endsWith('/api/play')); assert.equal(play.address, 'http://127.0.0.1:4320/api/play');
  assert.equal(play.body.track.title, 'OBVIOUS'); assert.equal(play.body.track.artist, 'Hasan Raheem');
  assert.equal(play.body.providerId, 'apple-music'); assert.equal(play.body.country, 'IN');
});
test('only the selected top-level tab can follow; duplicate updates do not resend', async () => {
  const f = fixture({ saved: configured });
  assert.equal((await completed(f,{ type: 'SET_FOLLOW', enabled: true }, f.popup)).ok, true);
  await completed(f,{ type: 'TRACK_UPDATE', track }, f.sender);
  await completed(f,{ type: 'TRACK_UPDATE', track: { ...track, title: 'Other' } }, { ...f.sender, frameId: 1 });
  await completed(f,{ type: 'TRACK_UPDATE', track: { ...track, title: 'Other' } }, { ...f.sender, tab: { id: 8, url } });
  assert.equal(f.calls.filter(call => call.address?.endsWith('/api/play')).length, 1);
  await completed(f,{ type: 'TRACK_UPDATE', track: { ...track, title: 'Other' } }, f.sender);
  assert.equal(f.calls.filter(call => call.address?.endsWith('/api/play')).length, 2);
});
test('Follow mirrors browser pause and resume once without restarting the song', async () => {
  const f = fixture({ saved: configured }); await completed(f,{ type: 'SET_FOLLOW', enabled: true }, f.popup);
  await completed(f,{ type: 'TRACK_UPDATE', track: { ...track, positionMs: 12000, state: 'paused' } }, f.sender);
  await completed(f,{ type: 'TRACK_UPDATE', track: { ...track, positionMs: 12000, state: 'paused' } }, f.sender);
  assert.deepEqual(f.calls.filter(call => call.address?.endsWith('/api/control')).map(call => call.body.action), ['pause']);
  assert.equal(f.controller.follow.enabled, true);
  await completed(f,{ type: 'TRACK_UPDATE', track: { ...track, positionMs: 12000, state: 'playing' } }, f.sender);
  assert.deepEqual(f.calls.filter(call => call.address?.endsWith('/api/control')).map(call => call.body.action), ['pause','resume']);
  assert.equal(f.calls.filter(call => call.address?.endsWith('/api/play')).length, 1);
});
test('popup Pause and Play control the source and Echo while retaining Follow', async () => {
  const f = fixture({ saved: configured }); await completed(f,{ type: 'SET_FOLLOW', enabled: true }, f.popup);
  assert.equal((await completed(f,{ type: 'CONTROL', action: 'pause' }, f.popup)).ok, true);
  assert.equal(f.controller.follow.enabled, true);
  assert.equal((await completed(f,{ type: 'CONTROL', action: 'play' }, f.popup)).ok, true);
  assert.deepEqual(f.calls.filter(call => call.sourceAction).map(call => call.sourceAction).slice(-2), ['pause','play']);
  assert.deepEqual(f.calls.filter(call => call.address?.endsWith('/api/control')).map(call => call.body.action), ['pause','resume']);
  assert.equal(f.calls.filter(call => call.address?.endsWith('/api/play')).length, 1);
});
test('settings changes and browser restart turn following off, worker restart preserves it', async () => {
  const f = fixture({ saved: configured, session: { follow: { enabled: true, tabId: 7, source: 'youtube-music', lastKey: 'previous' } } });
  await f.controller.ready; assert.equal(f.controller.follow.enabled, true);
  await completed(f,{ type: 'SAVE_SETTINGS', settings: { ...configured.settings, country: 'US' } }, f.popup);
  assert.equal(f.controller.follow.enabled, false);
  f.controller.follow.enabled = true; await f.controller.startup(); assert.equal(f.controller.follow.enabled, false);
  assert.equal(safeSettings({ country: 'xx' }).country, 'IN');
});
test('invalid pair token is not stored and a failed handoff leaves the tab held with Follow available', async () => {
  const f = fixture(); const result = await completed(f,{ type: 'SET_PAIR_TOKEN', token: 'short' }, f.popup);
  assert.equal(result.ok, false); assert.equal(f.values.local.pairToken, undefined);
  let count = 0;
  const fail = fixture({ saved: configured, fetchImpl: async () => { if (++count === 1) return { ok: true, async json() { return { connected: true, devices: [{ id: 'echo' }] }; } }; throw new TypeError('secret upstream endpoint'); } });
  assert.equal((await completed(fail, { type: 'SET_FOLLOW', enabled: true }, fail.popup)).ok, true);
  assert.equal(fail.controller.follow.enabled, true); assert.equal(fail.controller.handoff.phase, 'failed');
  assert.equal(fail.controller.lastResult.message.includes('secret'), false);
});

test('an older pending Play cannot send to a newly selected Echo', async () => {
  const f = fixture({ saved: configured });
  let release, started;
  const reached = new Promise(resolve => { started = resolve; });
  f.api.tabs.sendMessage = async () => { started(); return new Promise(resolve => { release = () => resolve({ track }); }); };
  const pending = f.controller.handle({ type: 'PLAY_TRACK', track }, f.popup);
  await reached;
  await completed(f,{ type: 'SAVE_SETTINGS', settings: { ...configured.settings, deviceId: 'other-echo' } }, f.popup);
  release(); const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(f.calls.filter(call => call.address?.endsWith('/api/play')).length, 0);
  assert.equal(f.controller.settings.deviceId, 'other-echo');
});
test('disabling Follow while its source capture waits prevents late activation', async () => {
  const f = fixture({ saved: configured }); let release, started;
  const reached = new Promise(resolve => { started = resolve; });
  f.api.tabs.sendMessage = async () => { started(); return new Promise(resolve => { release = () => resolve({ track }); }); };
  const pending = f.controller.handle({ type: 'SET_FOLLOW', enabled: true }, f.popup); await reached;
  await completed(f,{ type: 'SET_FOLLOW', enabled: false }, f.popup); release();
  assert.equal((await pending).ok, false); assert.equal(f.controller.follow.enabled, false);
  assert.equal(f.calls.filter(call => call.address?.endsWith('/api/play')).length, 0);
});

test('worker reload retains the exact helper job id for Stop following', async () => {
  const f = fixture({ saved: configured, session: { follow: { enabled: true, tabId: 7, source: 'youtube-music' }, ownAutoJob: 'owned-job' } });
  await completed(f,{ type: 'SET_FOLLOW', enabled: false }, f.popup);
  assert.equal(f.calls.find(call => call.address?.endsWith('/api/cancel')).body.requestId, 'owned-job');
  assert.equal(f.values.session.ownAutoJob, null);
});
test('a stale network failure cannot overwrite a newer popup result', async () => {
  let rejectPlay, began;
  const started = new Promise(resolve => { began = resolve; });
  const f = fixture({ saved: configured, fetchImpl: async address => {
    if (address.endsWith('/api/play')) { began(); return new Promise((_resolve, reject) => { rejectPlay = reject; }); }
    return { ok: true, async json() { return { connected: true, devices: [{ id: 'echo' }] }; } };
  } });
  const old = f.controller.handle({ type: 'PLAY_TRACK', track }, f.popup); await started;
  await completed(f,{ type: 'SAVE_SETTINGS', settings: { ...configured.settings, country: 'US' } }, f.popup);
  f.controller.lastResult = { ok: true, message: 'Newer result' };
  rejectPlay(new TypeError('failed old request')); await old;
  assert.equal(f.controller.lastResult.message, 'Newer result');
});

test('browser-native fetch receives the browser global rather than the controller as its receiver', async () => {
  const f = fixture({ saved: configured });
  f.controller = new CompanionController(f.api, { fetchImpl: async function (address) {
    assert.equal(this, globalThis, 'WebIDL fetch requires a browser-global receiver');
    assert.ok(['http://127.0.0.1:4320/api/status?deviceId=echo','http://127.0.0.1:4320/api/commands'].includes(address));
    return { ok: true, async json() { return { connected: true, devices: [{ id: 'echo' }], providers: [] }; } };
  } });
  const state = await completed(f,{ type: 'GET_POPUP_STATE' }, f.popup);
  assert.equal(state.helper.connected, true); assert.equal(state.error, '');
});
test('a null or invalid saved preference does not break worker startup', async () => {
  for (const settings of [null, [], '', 123]) {
    const f = fixture({ saved: { ...configured, settings } });
    const state = await completed(f,{ type: 'GET_POPUP_STATE' }, f.popup);
    assert.equal(state.ok, true); assert.equal(state.settings.country, 'IN');
  }
});


test('manual song edits discard old structured credits and recording measurements', async () => {
  const detected = { ...track, artistNames: ['Taylor Swift'], featuredArtists: ['Guest'], durationMs: 221000 };
  const f = fixture({ saved: configured, detected });
  await completed(f,{ type: 'PLAY_TRACK', track: { title: 'OBVIOUS', artist: 'Hasan Raheem' } }, f.popup);
  const sent = f.calls.find(call => call.address?.endsWith('/api/play')).body.track;
  assert.equal(sent.title, 'OBVIOUS'); assert.equal(sent.artist, 'Hasan Raheem');
  assert.ok(!sent.artistNames?.length); assert.ok(!sent.featuredArtists?.length); assert.ok(!sent.trackId); assert.equal(sent.durationMs, undefined);
});
test('manual Play retains structured credits for the unchanged detected song', async () => {
  const f = fixture({ saved: configured, detected: { ...track, artistNames: ['Taylor Swift'], durationMs: 221000 } });
  await completed(f,{ type: 'PLAY_TRACK', track }, f.popup);
  const sent = f.calls.find(call => call.address?.endsWith('/api/play')).body.track;
  assert.deepEqual(sent.artistNames, ['Taylor Swift']); assert.equal(sent.durationMs, 221000);
});


test('seek and volume validate values and preserve Follow without controlling the source', async () => {
  const f = fixture({ saved: configured }); await completed(f,{ type: 'SET_FOLLOW', enabled: true }, f.popup);
  const sourceCount = f.calls.filter(call => call.sourceAction).length;
  for (const volume of [-1,101,NaN,'50',2.5]) assert.equal((await completed(f,{ type: 'CONTROL', action: 'volume', volume }, f.popup)).ok, false);
  for (const positionMs of [-1,Infinity,'1000',2.5,86400001]) assert.equal((await completed(f,{ type: 'CONTROL', action: 'seek', positionMs }, f.popup)).ok, false);
  assert.equal(f.calls.filter(call => call.address?.endsWith('/api/control')).length, 0);
  assert.equal((await completed(f,{ type: 'CONTROL', action: 'volume', volume: 0 }, f.popup)).ok, true);
  assert.equal((await completed(f,{ type: 'CONTROL', action: 'seek', positionMs: 32000, expectedTrack: { title:'Lover', artist:'Taylor Swift' } }, f.popup)).ok, true);
  const controls = f.calls.filter(call => call.address?.endsWith('/api/control'));
  assert.equal(controls[0].body.volume, 0); assert.equal(controls[1].body.positionMs, 32000);
  assert.deepEqual(controls[1].body.expectedTrack, { title:'Lover', artist:'Taylor Swift' });
  assert.equal(f.controller.follow.enabled, true); assert.equal(f.calls.filter(call => call.sourceAction).length, sourceCount);
});
test('Next advances the source queue, holds transitional updates, and requests the new song once', async () => {
  const f = fixture({ saved: configured }); await completed(f,{ type: 'SET_FOLLOW', enabled: true }, f.popup);
  const next = { ...track, title: 'Cruel Summer', trackId: 'newrecord01' };
  let release, began; const started = new Promise(resolve => { began = resolve; });
  f.api.tabs.sendMessage = async (_id, message) => {
    if (message.type === 'CONTROL_SOURCE' && message.action !== 'next') return f.sourceReply(message);
    if (message.type === 'CONTROL_SOURCE') { assert.equal(message.action,'next'); began(); return new Promise(resolve => { release = () => resolve({ ok:true, track:next }); }); }
    return { track };
  };
  const pending = f.controller.handle({ type: 'CONTROL', action: 'next' }, f.popup); await started;
  await completed(f,{ type: 'TRACK_UPDATE', track: next }, f.sender);
  assert.equal(f.calls.filter(call => call.address?.endsWith('/api/play')).length, 1, 'transition must not forward ahead of the source control');
  release(); assert.equal((await pending).ok, true); await f.controller.handoffTask;
  await completed(f,{ type: 'TRACK_UPDATE', track: next }, f.sender);
  const plays = f.calls.filter(call => call.address?.endsWith('/api/play'));
  assert.equal(plays.length, 2); assert.equal(plays[1].body.track.title, 'Cruel Summer');
  assert.equal(f.controller.follow.enabled, true);
  assert.ok(!f.calls.some(call => call.body?.action === 'next'), 'the Echo queue must not be advanced independently');
});
test('Next works without Follow and reports a source failure without sending the old song', async () => {
  const f = fixture({ saved: configured });
  f.api.tabs.sendMessage = async (_id, message) => message.type === 'CONTROL_SOURCE' ? (message.action === 'next' ? { ok:true,track:{...track,title:'Next song',trackId:'newrecord01',state:'paused'} } : f.sourceReply(message)) : {track};
  assert.equal((await completed(f,{ type:'CONTROL',action:'next' },f.popup)).ok,true);
  assert.equal(f.calls.find(call => call.address?.endsWith('/api/play')).body.track.title,'Next song');
  assert.equal(f.controller.follow.enabled,false);
  f.api.tabs.sendMessage = async (_id,message) => message.type==='CONTROL_SOURCE'?({ ok:false,message:'No next song in this browser queue.' }):({track});
  const failed = await completed(f,{ type:'CONTROL',action:'next' },f.popup);
  assert.equal(failed.ok,false); assert.equal(failed.message,'No next song in this browser queue.');
  assert.equal(f.calls.filter(call => call.address?.endsWith('/api/play')).length,1);
});
test('Next targets the followed music tab while another tab is active', async () => {
  const f=fixture({saved:configured}); await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  f.api.tabs.query=async()=>[{id:20,url:'https://example.com/'}];
  f.api.tabs.sendMessage=async(tabId,message)=>{ assert.equal(tabId,7); return message.type==='CONTROL_SOURCE'?(message.action==='next'?{ok:true,track:{...track,title:'Next song',state:'paused'}}:f.sourceReply(message)):{track}; };
  const state=await completed(f,{type:'GET_POPUP_STATE'},f.popup);
  assert.equal(state.sourceControlsAvailable,true); assert.equal(state.controlTabId,7); assert.equal(state.supported,false);
  assert.equal((await completed(f,{type:'CONTROL',action:'next'},f.popup)).ok,true);
});
test('keyboard-style track changes at the same page URL reach Echo and dedupe repeated metadata', async()=>{
  const f=fixture({saved:configured}); await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  const next={...track,title:'Pashmina',artist:'Amit Trivedi',positionMs:0};
  await completed(f,{type:'TRACK_UPDATE',track:{...next,confidence:'review'}},f.sender);
  await completed(f,{type:'TRACK_UPDATE',track:next},f.sender);
  await completed(f,{type:'TRACK_UPDATE',track:{...next,positionMs:1000}},f.sender);
  const plays=f.calls.filter(call=>call.address?.endsWith('/api/play'));
  assert.equal(plays.length,2); assert.equal(plays[1].body.track.title,'Pashmina');
  assert.equal(f.controller.follow.enabled,true);
});


test('Play on Echo keeps the current followed tab linked for later keyboard song changes', async()=>{
  const f=fixture({saved:configured}); await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  assert.equal((await completed(f,{type:'PLAY_TRACK',track},f.popup)).ok,true);
  assert.equal(f.controller.follow.enabled,true);
  await completed(f,{type:'TRACK_UPDATE',track},f.sender);
  await completed(f,{type:'TRACK_UPDATE',track:{...track,title:'Keyboard next song'}},f.sender);
  const plays=f.calls.filter(call=>call.address?.endsWith('/api/play'));
  assert.equal(plays.length,3); assert.equal(plays[2].body.track.title,'Keyboard next song');
});
test('a pending Next cannot send a late song after the selected Echo changes', async()=>{
  const f=fixture({saved:configured}); await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  let release,began; const started=new Promise(resolve=>{began=resolve;});
  f.api.tabs.sendMessage=async(_id,message)=>message.type==='CONTROL_SOURCE' && message.action!=='next'?f.sourceReply(message):message.type==='CONTROL_SOURCE'?(began(),new Promise(resolve=>{release=()=>resolve({ok:true,track:{...track,title:'Late next'}});})):({track});
  const next=f.controller.handle({type:'CONTROL',action:'next'},f.popup); await started;
  await completed(f,{type:'SAVE_SETTINGS',settings:{...configured.settings,deviceId:'other-echo'}},f.popup);
  release(); assert.equal((await next).ok,false);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).length,1);
});


test('a delayed Next reply cannot replace a later keyboard-selected song', async()=>{
  const f=fixture({saved:configured}); await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  const first={...track,title:'First next'}, second={...track,title:'Second next'};
  let release,began; const started=new Promise(resolve=>{began=resolve;});
  f.api.tabs.sendMessage=async(_id,message)=>message.type==='CONTROL_SOURCE' && message.action!=='next'?f.sourceReply(message):message.type==='CONTROL_SOURCE'?(began(),new Promise(resolve=>{release=()=>resolve({ok:true,track:first,revision:2});})):({track,revision:1});
  const pending=f.controller.handle({type:'CONTROL',action:'next'},f.popup); await started;
  await completed(f,{type:'TRACK_UPDATE',track:second,revision:3},f.sender);
  release(); assert.equal((await pending).ok,true); await f.controller.handoffTask;
  const plays=f.calls.filter(call=>call.address?.endsWith('/api/play'));
  assert.equal(plays.length,2); assert.equal(plays[1].body.track.title,'Second next');
  assert.equal(f.controller.snapshots.get(7).track.title,'Second next');
});
test('a newer incomplete observation holds an old Next reply until metadata settles', async()=>{
  const f=fixture({saved:configured}); await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  let release,began; const started=new Promise(resolve=>{began=resolve;});
  f.api.tabs.sendMessage=async(_id,message)=>message.type==='CONTROL_SOURCE' && message.action!=='next'?f.sourceReply(message):message.type==='CONTROL_SOURCE'?(began(),new Promise(resolve=>{release=()=>resolve({ok:true,track:{...track,title:'First next'},revision:2});})):({track,revision:1});
  const pending=f.controller.handle({type:'CONTROL',action:'next'},f.popup); await started;
  await completed(f,{type:'TRACK_UPDATE',track:{...track,title:'Second next',artist:'',confidence:'review'},revision:3},f.sender);
  release(); assert.equal((await pending).ok,false);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).length,1);
  await completed(f,{type:'TRACK_UPDATE',track:{...track,title:'Second next'},revision:4},f.sender);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).at(-1).body.track.title,'Second next');
});


test('a followed-tab pause still pauses Echo while song credits are awaiting review', async()=>{
  const f=fixture({saved:configured}); await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  await completed(f,{type:'TRACK_UPDATE',track:{...track,state:'paused',artist:'',confidence:'review'}},f.sender);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/control')).at(-1).body.action,'pause');
  assert.equal(f.controller.follow.enabled,true);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).length,1);
});


test('Follow can be enabled before a song is selected and starts only after reliable playback arrives', async()=>{
  const f=fixture({saved:configured,detected:null});
  const result=await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  assert.equal(result.ok,true); assert.match(result.message,/Waiting for reliable song details/);
  assert.equal(f.controller.follow.enabled,true); assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).length,0);
  await completed(f,{type:'TRACK_UPDATE',track:{...track,confidence:'review'}},f.sender);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).length,0);
  await completed(f,{type:'TRACK_UPDATE',track},f.sender);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).length,1);
});
test('Follow starts in waiting mode for incomplete collaboration credits or an advertisement', async()=>{
  for(const detected of [{...track,artist:'Garvit Soni & Priyansh Srivastava',confidence:'review'},{...track,isAd:true}]){
    const f=fixture({saved:configured,detected});
    assert.equal((await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup)).ok,true);
    assert.equal(f.controller.follow.enabled,true); assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).length,0);
  }
});
test('an unreachable tab reader is diagnosed separately from an empty player and cannot enable Next', async()=>{
  const f=fixture({saved:configured}); await completed(f,{type:'GET_POPUP_STATE'},f.popup);
  assert.equal(f.controller.snapshots.get(7).track.title,'Lover');
  f.api.tabs.sendMessage=async()=>{throw new Error('Could not establish connection. Receiving end does not exist.');};
  const state=await completed(f,{type:'GET_POPUP_STATE'},f.popup);
  assert.equal(state.supported,true); assert.equal(state.track,null); assert.equal(state.sourceStatus.state,'unavailable');
  assert.match(state.sourceStatus.message,/Reload this music webpage/); assert.equal(state.sourceControlsAvailable,false);
  assert.equal(f.controller.snapshots.has(7),false); assert.equal(state.helper.connected,true);
  assert.ok(!JSON.stringify(state).includes('Receiving end'));
});
test('waiting Follow survives an explicit music-page reload and resumes detection afterward', async()=>{
  const f=fixture({saved:configured}); const reloaded=[];
  f.api.tabs.reload=async id=>reloaded.push(id);
  f.api.tabs.sendMessage=async()=>{throw new Error('reader missing');};
  const enabled=await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  assert.equal(enabled.ok,true); assert.match(enabled.message,/Reload this music webpage/);
  assert.equal((await completed(f,{type:'RELOAD_SOURCE'},f.popup)).ok,true);
  assert.deepEqual(reloaded,[7]); assert.equal(f.controller.follow.enabled,true);
  f.api.tabs.sendMessage=async(_id,message)=>message.type==='CONTROL_SOURCE'?f.sourceReply(message):({track,revision:1});
  const state=await completed(f,{type:'GET_POPUP_STATE'},f.popup);
  assert.equal(state.sourceStatus.state,'ready'); assert.equal(state.sourceControlsAvailable,true); assert.equal(state.track.title,'Lover');
  await completed(f,{type:'TRACK_UPDATE',track,revision:2},f.sender);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).length,1);
});
test('Follow and music-page reload reject unsupported active pages', async()=>{
  const f=fixture({saved:configured}); f.tabs[0].url='https://example.com/'; let reloaded=false;
  f.api.tabs.reload=async()=>{reloaded=true;};
  assert.equal((await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup)).ok,false);
  assert.equal((await completed(f,{type:'RELOAD_SOURCE'},f.popup)).ok,false);
  assert.equal(f.controller.follow.enabled,false); assert.equal(reloaded,false);
});


test('a newly selected song cancels old artist retries while its metadata is awaiting review', async()=>{
  const f=fixture({saved:configured}); await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  const waiting={...track,title:'BANNI (feat. Gargei Lavekar)',artist:'',confidence:'review'};
  await completed(f,{type:'TRACK_UPDATE',track:waiting},f.sender);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/cancel')).length,1);
  assert.equal(f.calls.find(call=>call.address?.endsWith('/api/cancel')).body.requestId,'job1');
  assert.equal(f.controller.follow.enabled,true);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).length,1);
  await completed(f,{type:'TRACK_UPDATE',track:waiting},f.sender);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/cancel')).length,1);
  await completed(f,{type:'TRACK_UPDATE',track:{...waiting,artist:'Aneesh',confidence:'high'}},f.sender);
  assert.equal(f.calls.filter(call=>call.address?.endsWith('/api/play')).at(-1).body.track.artist,'Aneesh');
});


const jsonResponse = data => ({ok:true,async json(){return data;}});
function deferredJob(f, jobId='job1') {
  const original=f.controller.fetch; let release,reject,began;
  const started=new Promise(resolve=>{began=resolve;});
  f.controller.fetch=async(address,options)=>{
    if(address.endsWith('/api/jobs/'+jobId)){began();return new Promise((resolve,fail)=>{release=data=>resolve(jsonResponse(data));reject=fail;});}
    return original(address,options);
  };
  return {started,match(){release({ok:true,job:{id:jobId,deviceId:'echo',state:'matched'},isCurrent:true});},fail: error=>reject(error)};
}
test('Echo-first handoff pauses and mutes the source, then waits for actual matched playback before source Play',async()=>{
  const f=fixture({saved:configured}), job=deferredJob(f);
  const result=await f.controller.handle({type:'SET_FOLLOW',enabled:true},f.popup); await job.started;
  assert.equal(result.ok,true); assert.equal(f.controller.handoff.phase,'waiting');
  assert.equal(f.tabs[0].mutedInfo.muted,true);
  assert.deepEqual(f.calls.filter(c=>c.sourceAction).map(c=>c.sourceAction),['pause']);
  const pauseIndex=f.calls.findIndex(c=>c.sourceAction==='pause'), sendIndex=f.calls.findIndex(c=>c.address?.endsWith('/api/play'));
  assert.ok(pauseIndex<sendIndex);
  await f.controller.handle({type:'TRACK_UPDATE',track:{...track,state:'paused'}},f.sender);
  assert.equal(f.calls.filter(c=>c.address?.endsWith('/api/control')).length,0,'own hold must not pause Echo');
  job.match(); await f.controller.handoffTask;
  assert.deepEqual(f.calls.filter(c=>c.sourceAction).map(c=>c.sourceAction),['pause','play']);
  assert.equal(f.controller.handoff.phase,'completed'); assert.equal(f.controller.follow.enabled,true);
});
test('cancelled handoff cannot resume the browser after a late matched Echo result',async()=>{
  const f=fixture({saved:configured}),job=deferredJob(f);
  await f.controller.handle({type:'SET_FOLLOW',enabled:true},f.popup); await job.started;
  const oldTask=f.controller.handoffTask;
  await f.controller.handle({type:'SET_FOLLOW',enabled:false},f.popup);
  job.match(); await oldTask;
  assert.equal(f.controller.follow.enabled,false); assert.equal(f.controller.handoff.phase,'cancelled');
  assert.deepEqual(f.calls.filter(c=>c.sourceAction).map(c=>c.sourceAction),['pause']);
});
test('manual commands cancel automatic handoff and never turn an Alexa acceptance into a response transcript',async()=>{
  const f=fixture({saved:configured}),job=deferredJob(f);
  await f.controller.handle({type:'SET_FOLLOW',enabled:true},f.popup); await job.started;
  const oldTask=f.controller.handoffTask,original=f.controller.fetch;
  f.controller.fetch=async(address,options)=>{
    if(address.endsWith('/api/command')){f.calls.push({address,body:JSON.parse(options.body)});return jsonResponse({ok:true,status:'sent',commandId:'custom1',confirmed:false,message:'Command sent to Alexa.'});}
    return original(address,options);
  };
  const result=await f.controller.handle({type:'CUSTOM_COMMAND',text:'what time is it'},f.popup);
  assert.equal(result.ok,true); assert.equal(result.confirmed,false); assert.equal(f.controller.follow.enabled,false);
  assert.equal(f.calls.find(c=>c.address?.endsWith('/api/command')).body.deviceId,'echo');
  job.match(); await oldTask;
  assert.deepEqual(f.calls.filter(c=>c.sourceAction).map(c=>c.sourceAction),['pause']);
});
test('an unconfirmed or historical Echo song never releases the held browser player',async()=>{
  for(const reply of [{job:{id:'job1',deviceId:'echo',state:'unmatched',message:'Different song'},isCurrent:true},{job:{id:'job1',deviceId:'echo',state:'matched'},isCurrent:false}]){
    const f=fixture({saved:configured}),original=f.controller.fetch;
    f.controller.fetch=async(address,options)=>address.endsWith('/api/jobs/job1')?jsonResponse({ok:true,...reply}):original(address,options);
    await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
    assert.equal(f.controller.handoff.phase,'failed');
    assert.deepEqual(f.calls.filter(c=>c.sourceAction).map(c=>c.sourceAction),['pause']);
  }
});
test('a new source selection cancels a manual handoff even with Follow disabled',async()=>{
  const f=fixture({saved:configured}),job=deferredJob(f);
  await f.controller.handle({type:'PLAY_TRACK',track},f.popup); await job.started;
  const oldTask=f.controller.handoffTask;
  await f.controller.handle({type:'TRACK_UPDATE',track:{...track,title:'New selection'}},f.sender);
  job.match(); await oldTask;
  assert.equal(f.controller.handoff.phase,'cancelled');
  assert.deepEqual(f.calls.filter(c=>c.sourceAction).map(c=>c.sourceAction),['pause']);
});
test('closing a manual handoff tab prevents a later browser resume',async()=>{
  const f=fixture({saved:configured}),job=deferredJob(f);
  await f.controller.handle({type:'PLAY_TRACK',track},f.popup); await job.started;
  const oldTask=f.controller.handoffTask; await f.controller.tabRemoved(7);
  job.match(); await oldTask;
  assert.equal(f.controller.handoff.phase,'cancelled'); assert.ok(!f.calls.some(c=>c.sourceAction==='play'));
});
test('Stop Follow while the final tab lookup waits prevents an old source Play dispatch',async()=>{
  const f=fixture({saved:configured}); const original=f.api.tabs.get; let reads=0,release,began;
  const started=new Promise(resolve=>{began=resolve;});
  f.api.tabs.get=async tabId=>{
    if(f.controller.handoff?.phase==='resuming'&&++reads===2){began();return new Promise(resolve=>{release=()=>resolve(f.tabs[0]);});}
    return original(tabId);
  };
  await f.controller.handle({type:'SET_FOLLOW',enabled:true},f.popup); await started;
  const oldTask=f.controller.handoffTask; await f.controller.handle({type:'SET_FOLLOW',enabled:false},f.popup); release(); await oldTask;
  assert.ok(!f.calls.some(c=>c.sourceAction==='play'));
});
test('a restored watcher failure cannot overwrite a newer completed handoff',async()=>{
  const restored={id:'old',requestId:'old-request',active:true,phase:'waiting',jobId:'restored-job',tabId:7,tabUrl:url,sourceTrack:track,track,settings:configured.settings,auto:false,createdAt:Date.now()};
  let rejectOld,began; const started=new Promise(resolve=>{began=resolve;});
  const f=fixture({saved:configured,session:{handoff:restored}}),original=f.controller.fetch;
  f.controller.fetch=async(address,options)=>{
    if(address.endsWith('/api/jobs/restored-job')){began();return new Promise((_resolve,reject)=>{rejectOld=reject;});}
    return original(address,options);
  };
  await f.controller.ready; await started; const oldTask=f.controller.handoffTask;
  await completed(f,{type:'PLAY_TRACK',track:{...track,title:'New request'}},f.popup);
  const completedId=f.controller.handoff.id;
  rejectOld(new TypeError('old network error')); await oldTask;
  assert.equal(f.controller.handoff.id,completedId); assert.equal(f.controller.handoff.phase,'completed'); assert.equal(f.controller.lastResult.ok,true);
});
test('a slow cancellation for an earlier selection cannot replace a newer handoff',async()=>{
  const f=fixture({saved:configured}),job=deferredJob(f);
  await f.controller.handle({type:'SET_FOLLOW',enabled:true},f.popup); await job.started; const firstTask=f.controller.handoffTask;
  const original=f.controller.fetch; let releaseCancel,began,cancels=0;const cancelStarted=new Promise(resolve=>{began=resolve;});
  f.controller.fetch=async(address,options)=>{
    if(address.endsWith('/api/cancel')&&++cancels===1){began();return new Promise(resolve=>{releaseCancel=()=>resolve(jsonResponse({ok:true}));});}
    return original(address,options);
  };
  const second=f.controller.handle({type:'TRACK_UPDATE',track:{...track,title:'Second'}},f.sender);await cancelStarted;
  await completed(f,{type:'TRACK_UPDATE',track:{...track,title:'Third'}},f.sender);
  releaseCancel(); await second; job.match(); await firstTask;
  assert.equal(f.controller.handoff.trackTitle,'Third');assert.equal(f.controller.handoff.phase,'completed');
  assert.deepEqual(f.calls.filter(c=>c.address?.endsWith('/api/play')).map(c=>c.body.track.title),['Lover','Third']);
});
test('custom commands validate before cancelling music and source pages cannot send them',async()=>{
  const f=fixture({saved:configured});await completed(f,{type:'SET_FOLLOW',enabled:true},f.popup);
  for(const text of ['', 'x'.repeat(501),'pause\nresume'])assert.equal((await f.controller.handle({type:'CUSTOM_COMMAND',text},f.popup)).ok,false);
  assert.equal(f.controller.follow.enabled,true);
  assert.equal((await f.controller.handle({type:'CUSTOM_COMMAND',text:'pause'},f.sender)).ok,false);
  assert.ok(!f.calls.some(c=>c.address?.endsWith('/api/command')));
});


test('a new reliable paused selection replaces a pending handoff without sending an obsolete Echo pause',async()=>{
  const f=fixture({saved:configured}),job=deferredJob(f);
  await f.controller.handle({type:'SET_FOLLOW',enabled:true},f.popup); await job.started;
  const oldTask=f.controller.handoffTask;
  await completed(f,{type:'TRACK_UPDATE',track:{...track,title:'New held song',trackId:'newtrack123',state:'paused'}},f.sender);
  job.match(); await oldTask;
  assert.equal(f.controller.handoff.trackTitle,'New held song');
  assert.equal(f.controller.handoff.phase,'completed');
  assert.ok(!f.calls.some(c=>c.address?.endsWith('/api/control')));
});


test('manual artist corrections can hold a known recording while source artist metadata fills in',async()=>{
  const f=fixture({saved:configured,detected:{...track,artist:'',confidence:'review'}}),original=f.api.tabs.sendMessage;
  f.api.tabs.sendMessage=async(tabId,message)=>{
    if(message.type==='CONTROL_SOURCE'){f.calls.push({sourceAction:message.action});return {ok:true,track:{...track,state:message.action==='pause'?'paused':'playing'}};}
    return original(tabId,message);
  };
  await completed(f,{type:'PLAY_TRACK',track},f.popup);
  assert.equal(f.controller.handoff.phase,'completed');
  assert.equal(f.calls.find(c=>c.address?.endsWith('/api/play')).body.track.artist,'Taylor Swift');
});


test('a transient missing artist on the same known recording does not cancel or pause its Echo handoff',async()=>{
  const f=fixture({saved:configured}),job=deferredJob(f);
  await f.controller.handle({type:'SET_FOLLOW',enabled:true},f.popup);await job.started;
  const handoff=f.controller.handoff;
  await f.controller.handle({type:'TRACK_UPDATE',track:{...track,artist:'',confidence:'review',state:'paused'}},f.sender);
  assert.equal(f.controller.handoff,handoff);assert.equal(handoff.active,true);
  assert.ok(!f.calls.some(c=>c.address?.endsWith('/api/cancel')||c.address?.endsWith('/api/control')));
  job.match();await f.controller.handoffTask;
  assert.equal(handoff.phase,'completed');
});
