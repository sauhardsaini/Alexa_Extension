import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
const ext='a'.repeat(32);
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'echo-library-facade-')),calls=[];
 const library={async handle(req,res){calls.push({path:req.url,method:req.method});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({source:'itunes',country:'IN',tracks:[]}));},cancel(reason){calls.push({cancel:reason});},async stop(){calls.push({stop:'library'});}};
 const amazonConnection={status:()=>({connection:{state:'connected'},settings:{region:'IN'},devices:[]}),stop(){calls.push({stop:'amazon'});}};
 const app=await createApp({port:0,dataDir:dir,library,amazonConnection,upstream:async()=>({})});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await app.stopResources();await new Promise(resolve=>{app.closeAllConnections?.();app.close(resolve);});await fs.rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.address().port;
 const pair=await fetch(base+'/api/pair',{method:'POST',headers:{Origin:base,'X-Echo-Companion':'1','Content-Type':'application/json'},body:'{}'});const token=(await pair.json()).token;
 const headers={Origin:'chrome-extension://'+ext,'X-Echo-Extension':ext,Authorization:'Bearer '+token};
 return{app,calls,library,base,headers};
}
test('only paired requests enter the library handler and preserve extension CORS while rewriting the internal route',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.base+'/api/library/search?q=Lover&country=IN')).status,403);
 const response=await fetch(f.base+'/api/library/search?q=Lover&country=IN',{headers:f.headers});
 assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),f.headers.Origin);assert.equal((await response.json()).source,'itunes');
 assert.deepEqual(f.calls.find(c=>c.path),{path:'/api/search?q=Lover&country=IN',method:'GET'});
});
test('removed tab commands and malformed routes cannot pass the library boundary',async t=>{
 const f=await fixture(t);
 for(const route of ['/api/library/cancel','/api/library/../../status']){
  const r=await fetch(f.base+route,{method:'POST',headers:{...f.headers,'Content-Type':'application/json'},body:'{}'});assert.ok(r.status>=400,route);
 }
 const legacy=await fetch(f.base+'/api/play',{method:'POST',headers:{...f.headers,'Content-Type':'application/json'},body:'{}'});
 assert.equal(legacy.status,403);assert.equal(f.calls.filter(c=>c.path).length,0);
});
test('websites with a pairing token still cannot cross the extension-origin guard',async t=>{
 const f=await fixture(t);
 const r=await fetch(f.base+'/api/library/status',{headers:{...f.headers,Origin:'https://evil.test'}});
 assert.equal(r.status,403);assert.equal(f.calls.filter(c=>c.path).length,0);
});
test('helper shutdown stops library tasks before disconnecting the shared Amazon bridge',async t=>{
 const f=await fixture(t);await f.app.stopResources();
 const stopCalls=f.calls.filter(c=>c.stop).map(c=>c.stop);assert.deepEqual(stopCalls,['library','amazon']);
});
