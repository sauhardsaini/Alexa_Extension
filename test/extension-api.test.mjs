import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script=fs.readFileSync(new URL('../extension/extension-api.js',import.meta.url),'utf8');
function fixture(handler){const calls=[],chrome={runtime:{lastError:null,sendMessage(message,callback){calls.push(message);handler?.(message,callback,chrome);}}},window={};vm.runInNewContext(script,{window,chrome,DOMException});return{fetch:window.echoExtensionFetch,calls,chrome};}
test('browser API adapter forwards structured library requests and preserves helper HTTP failures',async()=>{
 const f=fixture((_,reply)=>reply({ok:true,response:{ok:false,status:409,data:{message:'The song belongs to India.'}}}));
 const result=await f.fetch('/api/play',{method:'POST',body:JSON.stringify({trackId:'opaque',country:'US'}),headers:{Authorization:'must-not-forward'}});
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{type:'LIBRARY_REQUEST',path:'/api/play',method:'POST',body:{trackId:'opaque',country:'US'}}]);
 assert.equal(result.ok,false);assert.equal(result.status,409);assert.equal((await result.json()).message,'The song belongs to India.');
});
test('pairing/runtime errors are shown as actionable failures rather than successful empty responses',async()=>{
 const unpaired=fixture((_,reply)=>reply({ok:false,message:'Connect using the helper pairing code.'}));
 await assert.rejects(unpaired.fetch('/api/status'),/pairing code/u);
 const updated=fixture((_,reply,chrome)=>{chrome.runtime.lastError={message:'invalid context'};reply();});
 await assert.rejects(updated.fetch('/api/status'),/Reload this music library/u);
});
test('cancelled reads cannot overwrite newer UI state, and malformed bodies never reach the worker',async()=>{
 let reply;const f=fixture((_,callback)=>{reply=callback;});
 const abort=new AbortController();abort.abort();await assert.rejects(f.fetch('/api/search',{signal:abort.signal}),{name:'AbortError'});assert.equal(f.calls.length,0);
 await assert.rejects(f.fetch('/api/play',{method:'POST',body:'not-json'}),/Invalid request/u);assert.equal(f.calls.length,0);
 const pending=new AbortController(),response=f.fetch('/api/search?q=old&country=IN',{signal:pending.signal});pending.abort();await assert.rejects(response,{name:'AbortError'});
 reply({ok:true,response:{ok:true,status:200,data:{tracks:[{title:'Old result'}]}}});assert.equal(f.calls.length,1);
});
