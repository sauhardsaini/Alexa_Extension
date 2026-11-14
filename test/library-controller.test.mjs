import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LibraryController } from '../extension/library-controller.mjs';
import { libraryRoute } from '../extension/library-protocol.mjs';
const id='a'.repeat(32), token='t'.repeat(43), app='chrome-extension://'+id+'/app.html';
function fixture({paired=true,response={ok:true,status:200,data:{connection:{state:'connected'}}},fetchImpl}={}) {
 const calls=[],saved={...(paired?{pairToken:token}:{})},tabs=[];
 const api={runtime:{id,getURL:path=>'chrome-extension://'+id+'/'+path,getManifest:()=>({version:'0.4.0'})},storage:{local:{async setAccessLevel(value){calls.push({access:value});},async get(){return {...saved};},async set(value){Object.assign(saved,value);}},session:{async remove(keys){calls.push({removed:keys});}}},tabs:{async query(value){calls.push({query:value});return tabs;},async create(value){calls.push({create:value});return{id:7,...value};},async update(tabId,value){calls.push({update:tabId,...value});}},windows:{async update(windowId,value){calls.push({windowId,...value});}}};
 const fetchMock=fetchImpl||(async(url,options)=>{calls.push({url,options});return{ok:response.ok,status:response.status,text:async()=>JSON.stringify(response.data)};});
 return{controller:new LibraryController(api,{fetchImpl:fetchMock}),api,calls,saved,tabs,sender:{id,url:app,tab:{id:7,url:app},frameId:0}};
}
test('full-page app is trusted while websites, old popup, other extensions and child frames cannot issue actions',async()=>{
 const f=fixture();
 for(const sender of [{...f.sender,url:'https://music.youtube.com/'},{...f.sender,url:app.replace('app.html','popup.html')},{...f.sender,id:'b'.repeat(32)},{...f.sender,frameId:1},{}]){
  assert.equal((await f.controller.handle({type:'LIBRARY_REQUEST',path:'/api/command',method:'POST',body:{text:'play'}},sender)).ok,false);
 }
 assert.equal(f.calls.filter(c=>c.url||c.create).length,0);
 assert.equal((await f.controller.handle({type:'GET_CONNECTION'},f.sender)).paired,true);
});
test('route boundary permits supported library and account operations while rejecting invalid routes and network targets',()=>{
 for(const [path,method]of[['/api/search?q=Mahiya&country=IN','GET'],['/api/local-playlists/abc-123','GET'],['/api/local-playlists/abc/tracks/def/move','POST'],['/api/playlist-import/preview','POST'],['/api/queue/items/one/remove','POST'],['/api/play','POST'],['/api/apple/connect','POST'],['/api/playlists/p.abc?source=apple-music','GET']])assert.equal(libraryRoute(path,method),path);
 for(const path of ['https://evil.test/api/status','//evil.test/api/status','/api/apple/unknown','/api/spotify/delete-account','/api/youtube/delete-account','/api/../api/status','/api/%2e%2e/status','/api/local-playlists/a%2fb','/api/status#x','/api/status\\evil','/api/library/status'])assert.equal(libraryRoute(path,'POST')||libraryRoute(path,'GET'),null,path);
 assert.equal(libraryRoute('/api/command','GET'),null);assert.equal(libraryRoute('/api/status','DELETE'),null);
});
test('existing pairing is reused but never returned in status or API messages',async()=>{
 const f=fixture();const state=await f.controller.handle({type:'GET_CONNECTION'},f.sender);
 assert.equal(state.helperAvailable,true);assert.equal(JSON.stringify(state).includes(token),false);
 assert.deepEqual(f.calls.find(c=>c.removed).removed,['follow','handoff','lastPlayback','ownAutoJob']);
 const result=await f.controller.handle({type:'LIBRARY_REQUEST',path:'/api/search?q=lover&country=IN'},f.sender);
 assert.equal(result.ok,true);const call=f.calls.findLast(c=>c.url);
 assert.equal(call.url,'http://127.0.0.1:4320/api/library/search?q=lover&country=IN');assert.equal(call.options.headers.Authorization,'Bearer '+token);assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');
 assert.equal(JSON.stringify(result).includes(token),false);
});
test('pairing requires a verified code and a rejected code cannot overwrite a working connection',async()=>{
 const f=fixture({paired:false});
 assert.equal((await f.controller.handle({type:'GET_CONNECTION'},f.sender)).paired,false);
 assert.equal((await f.controller.handle({type:'SET_PAIR_TOKEN',token:'bad'},f.sender)).ok,false);assert.equal(f.saved.pairToken,undefined);
 assert.equal((await f.controller.handle({type:'SET_PAIR_TOKEN',token},f.sender)).ok,true);assert.equal(f.saved.pairToken,token);
 const bad=fixture({response:{ok:false,status:401,data:{message:'Pairing changed.'}}});
 assert.equal((await bad.controller.handle({type:'SET_PAIR_TOKEN',token:'x'.repeat(43)},bad.sender)).ok,false);assert.equal(bad.saved.pairToken,token);
 assert.equal((await bad.controller.handle({type:'GET_CONNECTION'},bad.sender)).paired,false);
});
test('search works without a music account and helper HTTP errors retain their status for the app',async()=>{
 const f=fixture({response:{ok:true,status:200,data:{source:'itunes',country:'IN',tracks:[{id:'1',title:'Lover',artist:'Taylor Swift'}]}}});
 const reply=await f.controller.handle({type:'LIBRARY_REQUEST',path:'/api/search?q=Lover&country=IN'},f.sender);
 assert.equal(reply.response.data.tracks[0].title,'Lover');
 const bad=fixture({response:{ok:false,status:409,data:{error:'COUNTRY_MISMATCH',message:'Choose India.'}}});
 const error=await bad.controller.handle({type:'LIBRARY_REQUEST',path:'/api/play',method:'POST',body:{country:'US'}},bad.sender);
 assert.equal(error.ok,true);assert.equal(error.response.ok,false);assert.equal(error.response.status,409);assert.equal(error.response.data.message,'Choose India.');
});
test('invalid or oversized action bodies and unsupported old workflow messages never dispatch',async()=>{
 const f=fixture();
 for(const message of [{type:'SET_FOLLOW',enabled:true},{type:'PLAY_TRACK',track:{title:'old'}},{type:'LIBRARY_REQUEST',path:'/api/command',method:'POST',body:[]},{type:'LIBRARY_REQUEST',path:'/api/search',body:{}},{type:'LIBRARY_REQUEST',path:'/api/local-playlists/import',method:'POST',body:{text:'x'.repeat(524289)}}])assert.equal((await f.controller.handle(message,f.sender)).ok,false);
 assert.equal(f.calls.filter(c=>c.url).length,0);
});
test('toolbar opens or focuses one own library tab without querying music website state',async()=>{
 const f=fixture();await Promise.all([f.controller.openLibrary(),f.controller.openLibrary()]);
 assert.equal(f.calls.filter(c=>c.create).length,1);assert.equal(f.calls.find(c=>c.create).create.url,'http://127.0.0.1:4320/');
 f.tabs.push({id:9,url:'http://127.0.0.1:4320/',windowId:3});await f.controller.openLibrary();
 assert.equal(f.calls.filter(c=>c.create).length,1);assert.equal(f.calls.find(c=>c.update).update,9);assert.deepEqual(f.calls.find(c=>c.query).query,{url:'http://127.0.0.1:4320/'});
});
test('native fetch is bound to the browser global and offline helpers produce useful connection state',async()=>{
 let receiver;
 const f=fixture({fetchImpl:async function(){receiver=this;throw new TypeError('offline');}});
 const result=await f.controller.handle({type:'GET_CONNECTION'},f.sender);
 assert.equal(receiver,globalThis);assert.equal(result.paired,true);assert.equal(result.helperAvailable,false);assert.match(result.message,/stopped|unavailable/u);
});
test('manifest removes music-site access and exposes the full-page library instead of the old popup',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('../extension/manifest.json',import.meta.url)));
 assert.deepEqual(manifest.permissions,['storage']);assert.equal(manifest.content_scripts,undefined);assert.equal(manifest.action.default_popup,undefined);assert.equal(manifest.options_page,'app.html');assert.deepEqual(manifest.host_permissions,['http://127.0.0.1/*']);assert.match(manifest.content_security_policy.extension_pages,/connect-src 'self' http:\/\/127\.0\.0\.1:4320;/u);
});


test('the options and legacy library entry redirect to the same helper-hosted full app',()=>{
 const html=fs.readFileSync(new URL('../extension/app.html',import.meta.url),'utf8');
 const launch=fs.readFileSync(new URL('../extension/launch.js',import.meta.url),'utf8');
 assert.match(html,/src="launch.js"/u);assert.doesNotMatch(html,/extension-api.js|id="follow-toggle"/u);
 assert.match(launch,/window.location.replace\('http:\/\/127\.0\.0\.1:4320\/'\)/u);
 const manifest=JSON.parse(fs.readFileSync(new URL('../extension/manifest.json',import.meta.url)));
 const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url)));
 const lock=JSON.parse(fs.readFileSync(new URL('../package-lock.json',import.meta.url)));
 assert.equal(manifest.version,pkg.version);assert.equal(lock.packages[''].version,pkg.version);
});
