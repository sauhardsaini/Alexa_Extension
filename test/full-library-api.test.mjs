import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLibrary } from '../library/index.mjs';
import { AppError } from '../library/errors.mjs';
import '../library/test/spotify.test.mjs';
import '../library/test/youtube-music.test.mjs';
import '../library/test/apple-music.test.mjs';

const TRACK={id:'public-opaque',title:'Lover',artist:'Taylor Swift',country:'IN',source:'itunes',durationMs:221000,album:'Lover'};
const SPOTIFY_ID='1234567890123456789012';
async function fixture(t,{paired=false}={}){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'echo-full-library-')),events=[],network=[];
 let queueState=null,playbackState=null;
 function account(source){
  let configured=false,connected=false,pending=null;
  const service={
   status(){return{source,configured,connected,needsSetup:!configured,...(source==='spotify'?{catalogReady:connected}:{}),redirectUri:'http://127.0.0.1:4320/api/'+(source==='youtube-music'?'youtube':source)+'/callback'};},
   configure(){configured=true;connected=false;return this.status();},
   authorize(){configured=true;connected=true;return this.status();},
   disconnect(){connected=false;return this.status();},
   publicConfig(){if(!configured)throw new AppError(503,'APPLE_SETUP_REQUIRED','Configure Apple Music first.');return{developerToken:'public-signed-developer-token',expiresAt:999999};},
   beginAuthorization(){if(!configured)throw new AppError(503,'SETUP_REQUIRED','Configure this account first.');pending='expected-state-'+source;return{authorizationUrl:'https://accounts.example/authorize?state='+pending,expiresAt:100000};},
   async completeAuthorization({state,code,error}){if(!pending||state!==pending)throw new AppError(400,'INVALID_OAUTH_STATE','The sign-in request is invalid or expired.');pending=null;if(error)throw new AppError(400,'OAUTH_CANCELLED','Sign-in was cancelled.');if(!code)throw new Error('private-upstream-token');connected=true;events.push({type:'callback',source});return this.status();},
   async playlists(){if(!connected)throw new AppError(401,'SIGNIN_REQUIRED','Connect this account first.');return{playlists:[{id:source+'-playlist',title:source+' mix',source}],truncated:false};},
   async playlist(id){if(!connected)throw new AppError(401,'SIGNIN_REQUIRED','Connect this account first.');if(id!==source+'-playlist')throw new AppError(400,'EXPIRED_PLAYLIST','Refresh the playlist.');return{id,title:source+' mix',source,tracks:[{...TRACK,id:'account-track',source}]};},
   async importPlaylist(url,country){events.push({type:'official-import',source});return{name:source+' account list',source,tracks:[{...TRACK,source,country}],total:1,skipped:0,notes:[],url};},
   async search(_q,country){return{source,country,availability:'catalogue-playable',tracks:[{...TRACK,id:source+'-opaque',source,country}]};},
   getTrack(id){if(id!==source+'-opaque')throw new AppError(400,'EXPIRED_RESULT','Search again.');return{...TRACK,id,source};},
   async prepareTrack(id,country){return{...this.getTrack(id),country};}
  };return service;
 }
 const appleMusic=account('apple-music'),spotify=account('spotify'),youtube=account('youtube-music');
 const bridge={status:()=>({connection:{state:'connected'},settings:{country:'IN',region:'IN',locale:'en-IN'},devices:[{id:'echo',name:'Test Echo',online:true}],player:null}),requireDevice(id){if(id!=='echo')throw new AppError(400,'INVALID_DEVICE','Choose your Echo.');},restore:async()=>{},commands:()=>({commands:[],retention:'session'})};
 const playback={intent:0,queue:Promise.resolve(),status:()=>playbackState,cancel(reason){this.intent++;playbackState=null;events.push({type:'cancel',reason});},reserve(context){this.intent++;playbackState={...context,id:'request',active:true};return playbackState;},start(context,track){events.push({type:'play',track});return{requestId:context.id,status:'sent'};},failReservation(){},async nativePlaylist(device,playlist){events.push({type:'native-playlist',device,playlist});return{status:'sent'};}};
 const queue={status:()=>queueState,clear(_id,options){queueState=null;events.push({type:'queue-clear',options});return{queue:null};},cancel(reason){queueState=null;events.push({type:'queue-cancel',reason});},start(context){queueState={active:true,id:'yt-queue',...context};events.push({type:'youtube-queue',context});return{queue:queueState};},startLocal(context){events.push({type:'local-queue',context});return{queue:context};},async enqueue(context){events.push({type:'enqueue',context});return{queue:context};}};
 const fetcher=async(url,options)=>{
  network.push({url,options});
  if(String(url).includes('open.spotify.com/embed/')){const entity={type:'playlist',id:SPOTIFY_ID,uri:'spotify:playlist:'+SPOTIFY_ID,name:'Public Spotify list',totalCount:1,trackList:[{uri:'spotify:track:'+'1'.repeat(22),title:'Public song',subtitle:'Public artist',duration:180000,entityType:'track'}]};return{ok:true,status:200,url,headers:{get:key=>key==='content-type'?'text/html':null},text:async()=>'<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{state:{data:{entity}}}}})+'</script>'};}
  return{ok:true,json:async()=>({results:[{country:'IND',kind:'song',trackId:1,trackName:TRACK.title,artistName:TRACK.artist,collectionName:TRACK.album,trackViewUrl:'https://music.apple.com/in/album/lover/1?i=1',trackTimeMillis:221000}]})};
 };
 const library=createLibrary({dataDir,bridge,appleMusic,spotify,youtube,playback,queue,fetcher});
 const server=http.createServer(paired?library.handleAuthenticated:library.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const request=async(route,{body,method=body===undefined?'GET':'POST',headers={}}={})=>{
  const response=await fetch(base+route,{method,redirect:'manual',headers:{...(body===undefined?{}:{'Content-Type':'application/json','X-Echo-App':'1'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const raw=await response.text();return{status:response.status,headers:response.headers,raw,body:raw?JSON.parse(raw):null};
 };
 t.after(async()=>{await library.stop();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));await fs.rm(dataDir,{recursive:true,force:true});});
 return{library,appleMusic,spotify,youtube,request,base,dataDir,events,network};
}

test('full helper status and optional account setup retain the web-app contract',async t=>{
 const f=await fixture(t);let status=(await f.request('/api/status')).body;
 for(const key of['apple','spotify','youtube'])assert.equal(status[key].connected,false);
 assert.equal(status.catalogue.source,'itunes');
 assert.equal((await f.request('/api/spotify/setup',{body:{clientId:'synthetic'}})).status,200);
 assert.equal((await f.request('/api/youtube/setup',{body:{clientId:'synthetic',clientSecret:'private-setup-secret'}})).status,200);
 assert.equal((await f.request('/api/apple/setup',{body:{privateKey:'private-setup-secret'}})).status,200);
 const config=await f.request('/api/apple/config');assert.equal(config.body.developerToken,'public-signed-developer-token');
 status=(await f.request('/api/status')).body;assert.equal(status.spotify.configured,true);assert.equal(status.youtube.configured,true);assert.equal(JSON.stringify(status).includes('private-setup-secret'),false);
});

test('ordinary local API keeps origin, cross-site and POST app-header safeguards',async t=>{
 const f=await fixture(t);
 for(const headers of[{Origin:'https://evil.test'},{'Sec-Fetch-Site':'cross-site'},{'X-Echo-App':''}]){
  const r=await f.request('/api/spotify/setup',{body:{clientId:'synthetic'},headers});assert.equal(r.status,403);
 }
 assert.equal(f.spotify.status().configured,false);
 assert.equal((await f.request('/api/status',{headers:{Origin:'https://evil.test','X-Echo-Authenticated':'1'}})).status,403);
});

test('private paired-handler capability supports authorized extension context without trusting forged headers',async t=>{
 const f=await fixture(t,{paired:true});
 const result=await f.request('/api/spotify/setup',{body:{clientId:'synthetic'},headers:{Origin:'chrome-extension://'+'a'.repeat(32),'Sec-Fetch-Site':'cross-site','X-Echo-App':''}});
 assert.equal(result.status,200);assert.equal(result.body.spotify.configured,true);
});

for(const [name,key]of[['spotify','spotify'],['youtube','youtube']])test(name+' callbacks validate state and redirect without returning codes, state or account tokens',async t=>{
 const f=await fixture(t);await f.request('/api/'+name+'/setup',{body:{clientId:'synthetic'}});await f.request('/api/'+name+'/connect',{body:{}});
 const state='expected-state-'+(name==='youtube'?'youtube-music':'spotify');
 const bad=await f.request('/api/'+name+'/callback?code=private-code&state=wrong',{headers:{Origin:'https://accounts.example','Sec-Fetch-Site':'cross-site'}});assert.equal(bad.status,302);assert.equal(new URL(bad.headers.get('location')).searchParams.get('result'),'error');assert.equal(f[key].status().connected,false);
 const good=await f.request('/api/'+name+'/callback?code=private-code&state='+encodeURIComponent(state),{headers:{Origin:'https://accounts.example','Sec-Fetch-Site':'cross-site'}});
 assert.equal(good.status,302);const url=new URL(good.headers.get('location'));assert.equal(url.origin,'http://127.0.0.1:4320');assert.equal(url.searchParams.get('result'),'connected');assert.equal(good.headers.get('location').includes('private-code'),false);assert.equal(good.headers.get('location').includes(state),false);assert.equal(f[key].status().connected,true);
 assert.equal((await f.request('/api/'+name+'/callback',{body:{}})).status,404);
});

test('connected-account playlists and YouTube queue paths match the web application',async t=>{
 const f=await fixture(t);for(const account of[f.appleMusic,f.spotify,f.youtube])account.authorize();
 for(const source of['apple-music','spotify','youtube-music']){
  const playlists=await f.request('/api/playlists?source='+source);assert.equal(playlists.status,200);assert.equal(playlists.body.playlists[0].source,source);
  const playlist=await f.request('/api/playlists/'+source+'-playlist?source='+source);assert.equal(playlist.status,200);assert.equal(playlist.body.source,source);
 }
 const native=await f.request('/api/play-playlist',{body:{source:'spotify',playlistId:'spotify-playlist',deviceId:'echo'}});assert.equal(native.status,202);assert.equal(native.body.queue,null);assert.equal(f.events.find(event=>event.type==='queue-clear').options.keepCurrent,false);
 assert.equal((await f.request('/api/queue',{body:{source:'youtube-music',playlistId:'youtube-music-playlist',deviceId:'echo',providerId:'apple-music',country:'IN'}})).status,202);
 assert.equal(f.events.find(event=>event.type==='youtube-queue').context.playlist.tracks[0].title,'Lover');
 const count=f.events.length;assert.equal((await f.request('/api/queue',{body:{source:'youtube-music',playlistId:'youtube-music-playlist',deviceId:'echo',providerId:'apple-music',country:'XX'}})).status,400);assert.equal(f.events.length,count);
});

test('YouTube queue additions preserve individual credits until the artist is edited',async t=>{
 const f=await fixture(t),selected={...TRACK,id:'account-track',source:'youtube-music',artist:'First Artist & Second Artist',requestArtist:'First Artist',requestArtists:['First Artist','Second Artist']};
 f.youtube.authorize();
 f.youtube.playlist=async()=>({id:'youtube-music-playlist',title:'Account mix',source:'youtube-music',tracks:[selected]});
 for(const route of['/api/queue/items']){
  for(const artist of[undefined,selected.artist,'Edited Artist']){
   const selection={source:'youtube-music',playlistId:'youtube-music-playlist',trackId:selected.id,country:'IN',...(artist===undefined?{}:{artist})};
   const result=await f.request(route,{body:{selection,deviceId:'echo',providerId:'apple-music',country:'IN',...(route==='/api/queue/items'?{placement:'last'}:{})}});
   assert.equal(result.status,202);
   const event=f.events.findLast(item=>item.type===(route==='/api/play-selection'?'play':'enqueue'));
   const actual=event.type==='play'?event.track:event.context.track;
   assert.equal(actual.artist,artist??selected.artist);
   assert.equal(actual.requestArtist,artist==='Edited Artist'?'Edited Artist':'First Artist');
   assert.deepEqual(actual.requestArtists,artist==='Edited Artist'?['Edited Artist']:['First Artist','Second Artist']);
  }
 }
 assert.equal(selected.requestArtist,'First Artist');
 assert.deepEqual(selected.requestArtists,['First Artist','Second Artist']);
});

test('catalogue account switches invalidate old public selections before playback mutations',async t=>{
 const f=await fixture(t),publicResult=await f.request('/api/search?q=Lover&country=IN');const oldId=publicResult.body.tracks[0].id;
 await f.request('/api/apple/connect',{body:{musicUserToken:'synthetic'}});
 const count=f.events.length;
 assert.equal((await f.request('/api/play-selection',{body:{selection:{source:'catalogue',trackId:oldId,country:'IN'},deviceId:'echo',providerId:'apple-music',country:'IN'}})).status,409);assert.equal(f.events.length,count);
 const official=await f.request('/api/search?q=Lover&country=IN');assert.equal(official.body.source,'apple-music');assert.equal(official.body.availability,'catalogue-playable');
 assert.equal((await f.request('/api/play-selection',{body:{selection:{source:'catalogue',trackId:official.body.tracks[0].id,country:'IN'},deviceId:'echo',providerId:'apple-music',country:'US'}})).status,409);assert.equal(f.events.length,count);
 assert.equal((await f.request('/api/play-selection',{body:{selection:{source:'catalogue',trackId:official.body.tracks[0].id,country:'IN'},deviceId:'echo',providerId:'apple-music',country:'IN'}})).status,202);
});

test('public Spotify links remain available without account connection, while connected imports prefer official data',async t=>{
 const f=await fixture(t),url='https://open.spotify.com/playlist/'+SPOTIFY_ID;
 let result=await f.request('/api/playlist-import/preview',{body:{url,country:'IN'}});assert.equal(result.status,200);assert.equal(result.body.name,'Public Spotify list');assert.equal(f.events.some(event=>event.type==='official-import'),false);
 f.spotify.authorize();result=await f.request('/api/playlist-import/preview',{body:{url,country:'IN'}});assert.equal(result.status,200);assert.equal(result.body.name,'spotify account list');assert.equal(f.events.find(event=>event.type==='official-import').source,'spotify');
 assert.equal(f.events.some(event=>['play','native-playlist','youtube-queue'].includes(event.type)),false);
});

test('real account service paths are isolated within the extension library data directory',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'echo-full-account-paths-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const library=createLibrary({dataDir,bridge:{status:()=>({}),restore:async()=>{}}});
 for(const service of[library.appleMusic,library.spotify,library.youtube])assert.equal(path.dirname(service.configFile),path.join(dataDir,'library'));
 assert.equal(library.spotify.redirectUri,'http://127.0.0.1:4320/api/spotify/callback');assert.equal(library.youtube.redirectUri,'http://127.0.0.1:4320/api/youtube/callback');await library.stop();
});
