import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../server.mjs';

const EXT = 'a'.repeat(32), EXT_ORIGIN = 'chrome-extension://' + EXT;
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-full-helper-boundary-')), calls = [];
  const library = {
    async handle(req, res) {
      calls.push({ path:req.url, method:req.method });
      if (req.method === 'POST') for await (const _chunk of req) { /* consume only this mock request */ }
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ connected:true, source:'itunes', country:'IN', tracks:[] }));
    },
    cancel(reason) { calls.push({ cancel:reason }); },
    async stop() { calls.push({ stopped:'library' }); }
  };
  const amazonConnection = { status:()=>({connection:{state:'connected'},settings:{region:'IN'},devices:[]}), stop(){ calls.push({stopped:'amazon'}); } };
  const app = await createApp({ port:0, dataDir:dir, library, amazonConnection, upstream:async()=>({}) });
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const port = app.address().port, base = 'http://127.0.0.1:' + port;
  t.after(async()=>{
    await app.stopResources();
    await new Promise(resolve=>{ app.closeAllConnections?.(); app.close(resolve); });
    await fs.rm(dir,{recursive:true,force:true});
  });
  const post = (route, headers = {}, body = {}) => fetch(base + route, { method:'POST', headers:{'Content-Type':'application/json',...headers}, body:JSON.stringify(body), redirect:'manual' });
  const own = { Origin:base, 'X-Echo-App':'1', 'Sec-Fetch-Site':'same-origin' };
  const raw = (route, headers = {}) => new Promise((resolve,reject)=>{
    const req = http.request({ hostname:'127.0.0.1', port, path:route, headers }, response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text}));
    }); req.on('error',reject);req.end();
  });
  return { app, library, calls, port, base, post, own, raw, paths:()=>calls.filter(row=>row.path) };
}

test('toolbar destination serves the full web app while helper setup remains separate',async t=>{
  const f=await fixture(t);
  const page=await f.raw('/',{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'});
  assert.equal(page.status,200);assert.match(page.text,/id="music-catalogue"/u);assert.match(page.text,/id="spotify-section"/u);assert.match(page.text,/id="youtube-section"/u);
  assert.match(page.text,/id="playlist-import-dialog"/u);assert.match(page.text,/\/setup/u);
  const setup=await f.raw('/setup',{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'});
  assert.equal(setup.status,200);assert.match(setup.text,/id="pair-title"/u);assert.doesNotMatch(setup.text,/id="search-form"/u);
  for(const file of ['/app.js','/app.css']){const response=await fetch(f.base+file);assert.equal(response.status,200,file);assert.ok((await response.text()).length>100,file);}
});

test('HTTP app CSP supports Apple MusicKit without weakening the extension execution policy',async t=>{
  const f=await fixture(t), page=await fetch(f.base+'/'), csp=page.headers.get('content-security-policy');
  assert.match(csp,/script-src[^;]*https:\/\/js-cdn\.music\.apple\.com/u);
  assert.match(csp,/connect-src[^;]*https:\/\/api\.music\.apple\.com/u);
  assert.match(csp,/frame-src[^;]*music\.apple\.com/u);assert.doesNotMatch(csp,/unsafe-eval/u);
  assert.equal(page.headers.get('x-content-type-options'),'nosniff');assert.equal(page.headers.get('x-frame-options'),'DENY');
  const manifest=JSON.parse(await fs.readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  assert.doesNotMatch(manifest.content_security_policy.extension_pages,/js-cdn\.music\.apple\.com|unsafe-eval/u);
});

test('same-origin local reads and explicitly marked writes can use all web-app account and library routes',async t=>{
  const f=await fixture(t);
  for(const route of ['/api/status','/api/search?q=Mahiya&country=IN','/api/apple/config','/api/playlists?source=spotify']){
    const response=await fetch(f.base+route,{headers:{Origin:f.base,'Sec-Fetch-Site':'same-origin'}});assert.equal(response.status,200,route);
  }
  for(const route of ['/api/apple/setup','/api/apple/connect','/api/spotify/setup','/api/spotify/connect','/api/youtube/setup','/api/youtube/connect','/api/local-playlists','/api/play']){
    assert.equal((await f.post(route,f.own)).status,200,route);
  }
  assert.equal(f.paths().length,12);
});

test('foreign origins, cross-site reads and extension-origin root reads cannot use the local-page shortcut',async t=>{
  const f=await fixture(t);
  for(const headers of [{Origin:'https://evil.test'},{'Sec-Fetch-Site':'cross-site'},{Origin:EXT_ORIGIN,'Sec-Fetch-Site':'same-origin'},{Origin:'http://127.0.0.1:'+(f.port+1),'Sec-Fetch-Site':'same-site'}]){
    const response=await fetch(f.base+'/api/status',{headers});assert.equal(response.status,403,JSON.stringify(headers));
  }
  assert.equal(f.paths().length,0);
});

test('local mutations require both the exact app origin and X-Echo-App header',async t=>{
  const f=await fixture(t);
  const bad=[{}, {Origin:f.base}, {'X-Echo-App':'1'}, {Origin:'https://evil.test','X-Echo-App':'1'}, {Origin:f.base,'X-Echo-Companion':'1'}, {Origin:f.base,'X-Echo-App':'1','Sec-Fetch-Site':'cross-site'}];
  for(const headers of bad) assert.equal((await f.post('/api/spotify/setup',headers)).status,403,JSON.stringify(headers));
  assert.equal(f.paths().length,0);
});

test('only exact GET OAuth callbacks bypass local-origin guards',async t=>{
  const f=await fixture(t), external={Origin:'https://accounts.spotify.com','Sec-Fetch-Site':'cross-site'};
  for(const route of ['/api/spotify/callback?code=example&state=example','/api/youtube/callback?error=access_denied&state=example']){
    assert.equal((await fetch(f.base+route,{headers:external,redirect:'manual'})).status,200,route);
  }
  for(const route of ['/api/spotify/callback/','/api/youtube/callback/','/api/spotify/setup','/api/youtube/connect']){
    assert.ok((await fetch(f.base+route,{headers:external,redirect:'manual'})).status>=400,route);
  }
  assert.ok((await f.post('/api/spotify/callback',external)).status>=400);
  assert.ok((await f.post('/api/youtube/callback',f.own)).status>=400);
  assert.equal(f.paths().length,2);
});

test('paired API namespace stays authenticated even when a local web app is enabled',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.base+'/api/library/status',{headers:{Origin:f.base}})).status,403);
  const paired=await f.post('/api/pair',{Origin:f.base,'X-Echo-Companion':'1'}), token=(await paired.json()).token;
  const headers={Origin:EXT_ORIGIN,'X-Echo-Extension':EXT,Authorization:'Bearer '+token};
  const response=await fetch(f.base+'/api/library/status',{headers});assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),EXT_ORIGIN);
  assert.equal(f.paths().at(-1).path,'/api/status');
  assert.equal((await fetch(f.base+'/api/status',{headers})).status,403);
});

test('loopback Host validation rejects DNS-rebinding names before any handler runs',async t=>{
  const f=await fixture(t);
  const response=await f.raw('/api/status',{Host:'evil.test:'+f.port,Origin:f.base});
  assert.equal(response.status,403);assert.equal(f.paths().length,0);
});


test('the opt-in media carrier is a same-origin finite WAV containing only silence',async t=>{
  const f=await fixture(t), response=await fetch(f.base+'/media-session.wav');
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/wav');
  const wav=Buffer.from(await response.arrayBuffer());
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');
  assert.equal(wav.readUInt16LE(20),1);assert.equal(wav.readUInt16LE(22),1);
  assert.equal(wav.readUInt32LE(24),8000);assert.equal(wav.readUInt16LE(34),16);
  assert.equal(wav.readUInt32LE(40),160000);assert.ok(wav.subarray(44).every(sample=>sample===0));
  for(const headers of [{Origin:'https://evil.test'},{'Sec-Fetch-Site':'cross-site'}])
    assert.equal((await fetch(f.base+'/media-session.wav',{headers})).status,403);
});
