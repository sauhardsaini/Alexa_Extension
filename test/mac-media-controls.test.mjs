import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const script=await fs.readFile(new URL('../library/public/app.js',import.meta.url),'utf8');
const body=script.slice(script.indexOf('  function createMacMediaBridge('),script.indexOf('  function initMacMedia('));
function fixture({fail=false}={}) {
 const handlers={},commands=[],notices=[],positions=[];let released=0;
 const snapshot={deviceId:'echo',available:true,busy:false,player:{deviceId:'echo',state:'PLAYING',title:'Actual Echo song',artist:'Artist',album:'Album',artwork:'https://example.com/cover.jpg',durationMs:180000,positionMs:2000}};
 const session={metadata:null,playbackState:'none',setActionHandler(k,v){handlers[k]=v;},setPositionState(v){if(v&&v.playbackRate===0)throw new TypeError('zero rate');positions.push(v);}};
 const audio={paused:true,src:'',async play(){if(fail)throw Error('blocked');this.paused=false;},pause(){this.paused=true;},removeAttribute(name){if(name==='src')this.src='';},load(){released++;}};
 const sandbox=vm.createContext({Promise,JSON,Number,Object,options:{session,snapshot:()=>snapshot,audio:()=>audio,metadata:v=>v,control:a=>commands.push(a),notice:m=>notices.push(m),changed(){}}});
 vm.runInContext(body+'\nvar bridge=createMacMediaBridge(options);',sandbox);
 return {bridge:sandbox.bridge,snapshot,session,handlers,commands,notices,positions,audio,get released(){return released;}};
}
test('opt-in media registration publishes actual Echo metadata and forwards all four transport actions',async()=>{
 const f=fixture();assert.equal(f.bridge.enabled,false);await f.bridge.enable();assert.equal(f.bridge.enabled,true);assert.equal(f.audio.src,'/media-session.wav');assert.equal(f.audio.loop,true);
 assert.equal(f.session.metadata.title,'Actual Echo song');assert.equal(f.session.playbackState,'playing');
 for(const k of ['play','pause','nexttrack','previoustrack'])f.handlers[k]();
 assert.deepEqual(f.commands,['resume','pause','next','previous']);assert.equal(f.positions.at(-1).position,2);
 await f.bridge.disable();
});
test('busy, stale, disconnected and different-device sessions cannot send unintended controls',async()=>{
 const f=fixture();await f.bridge.enable();f.snapshot.busy=true;f.handlers.nexttrack();assert.equal(f.commands.length,0);
 f.snapshot.busy=false;f.snapshot.available=false;f.bridge.update();f.handlers.play();assert.equal(f.session.metadata,null);assert.equal(f.commands.length,0);
 f.snapshot.available=true;f.snapshot.player.deviceId='other';f.bridge.update();f.handlers.pause();assert.equal(f.commands.length,0);
 await f.bridge.disable();
});
test('paused Echo state is reflected and disabling releases the local session without controlling Echo',async()=>{
 const f=fixture();await f.bridge.enable();f.snapshot.player.state='PAUSED';f.snapshot.player.positionMs=3000;f.bridge.update();assert.equal(f.positions.at(-1).position,3);assert.equal(f.positions.at(-1).playbackRate,1);assert.equal(f.session.playbackState,'paused');assert.equal(f.audio.paused,true);
 f.snapshot.player.state='PLAYING';f.bridge.update();assert.equal(f.audio.paused,false);
 await f.bridge.disable();assert.equal(f.session.metadata,null);assert.equal(f.session.playbackState,'none');assert.equal(f.audio.paused,true);
 assert.equal(f.audio.src,'');assert.equal(f.released,1);assert.equal(f.handlers.nexttrack,null);assert.equal(f.commands.length,0);
});
test('browser playback rejection cleans up and reports an in-app error without an Echo command',async()=>{
 const f=fixture({fail:true});await f.bridge.enable();assert.equal(f.bridge.enabled,false);assert.equal(f.session.metadata,null);assert.equal(f.commands.length,0);assert.match(f.notices.at(-1),/could not start/);
});

test('new Echo metadata replaces the previous song and unknown duration clears its old position',async()=>{
 const f=fixture();await f.bridge.enable();f.snapshot.player.title='New Echo song';f.snapshot.player.durationMs=null;f.snapshot.player.artwork='javascript:bad';
 f.bridge.update();assert.equal(f.session.metadata.title,'New Echo song');assert.equal(f.session.metadata.artwork.length,0);assert.equal(f.positions.at(-1),undefined);
 await f.bridge.disable();
});

const startupBody = script.slice(script.indexOf('  function createMacMediaBridge('), script.indexOf('  function renderPlayer('));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function startupFixture({ saved = null, blockedOnce = false } = {}) {
 const stored = new Map(saved === null ? [] : [['echo-library-mac-media', saved]]), events = {}, lifecycle = {}, commands = [];
 let plays = 0;
 const button = { disabled:false, textContent:'Enable Mac media controls', attributes:{}, listeners:{}, setAttribute(k,v){this.attributes[k]=v;}, addEventListener(k,v){this.listeners[k]=v;} }, note = { textContent:'' };
 const session = {setActionHandler(){},setPositionState(){}};
 const state = { deviceId:'echo', player:{deviceId:'echo',title:'Echo song',artist:'Artist',state:'PLAYING'} };
 const window = { Audio:function(){return{paused:true,async play(){plays++;if(blockedOnce&&plays===1){const error=new Error('activation required');error.name='NotAllowedError';throw error;}this.paused=false;},pause(){this.paused=true;},removeAttribute(){},load(){}};}, MediaMetadata:function(value){return value;},addEventListener(k,v){lifecycle[k]=v;} };
 const context = vm.createContext({state,window,navigator:{mediaSession:session},document:{addEventListener(k,v){events[k]=v;}},localStorage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v)},$:id=>id==='mac-media-toggle'?button:note,canPlay:()=>true,control:action=>commands.push(action),JSON,Number,Object,Promise});
 vm.runInContext(startupBody+'\ninitMacMedia();',context);
 return {state,stored,events,lifecycle,button,note,commands,get plays(){return plays;}};
}
test('Mac media controls start by default without sending an Echo command', async () => {
 const f=startupFixture();await flush();
 assert.equal(f.state.macMedia.enabled,true);assert.equal(f.button.attributes['aria-pressed'],'true');assert.deepEqual(f.commands,[]);
 f.lifecycle.pagehide();assert.equal(f.state.macMedia.enabled,false);
});
test('an explicit off choice survives reload and enabling it again restores automatic startup', async () => {
 const off=startupFixture({saved:'false'});await flush();assert.equal(off.plays,0);assert.equal(off.state.macMedia.enabled,false);
 await off.button.listeners.click();assert.equal(off.state.macMedia.enabled,true);assert.equal(off.stored.get('echo-library-mac-media'),'true');
 off.lifecycle.pagehide();assert.equal(off.stored.get('echo-library-mac-media'),'true');
 const on=startupFixture({saved:off.stored.get('echo-library-mac-media')});await flush();assert.equal(on.state.macMedia.enabled,true);
 await on.button.listeners.click();assert.equal(on.stored.get('echo-library-mac-media'),'false');assert.equal(on.state.macMedia.enabled,false);
 on.events.click({});await flush();assert.equal(on.state.macMedia.enabled,false);
});
test('blocked browser autoplay waits for a normal interaction and retries without an Echo command', async () => {
 const f=startupFixture({blockedOnce:true});await flush();assert.equal(f.state.macMedia.enabled,false);assert.equal(f.state.macMedia.blocked,true);assert.match(f.note.textContent,/needs a click/);
 f.events.click({});await flush();assert.equal(f.state.macMedia.enabled,true);assert.equal(f.plays,2);assert.deepEqual(f.commands,[]);
 f.lifecycle.pagehide();f.lifecycle.pageshow({persisted:true});await flush();assert.equal(f.state.macMedia.enabled,true);
});
