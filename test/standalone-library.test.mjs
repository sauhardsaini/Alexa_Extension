import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = ['server.mjs','alexa-connection.mjs','library','helper','extension','alexa','package.json','node_modules'];

async function requireInternalLinks(directory, clone) {
  for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if(entry.isSymbolicLink()) {
      const resolved=await fs.realpath(file);
      assert.ok(resolved===clone || resolved.startsWith(clone+path.sep),'Runtime symlink must resolve inside the standalone copy: '+path.relative(clone,file));
    } else if(entry.isDirectory()) await requireInternalLinks(file,clone);
  }
}

const smoke = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root=fileURLToPath(new URL('.',import.meta.url));
const inside=(file,dir)=>file===dir || file.startsWith(dir+path.sep);
assert.deepEqual(await fs.readdir(path.dirname(root.slice(0,-1))),[path.basename(root.slice(0,-1))]);
await assert.rejects(fs.stat(path.join(root,'.local')),{code:'ENOENT'});
const dependency=await fs.realpath(createRequire(import.meta.url).resolve('alexa-remote2'));
assert.ok(inside(dependency,path.join(root,'node_modules')),'Dependency must resolve from the copied runtime');
const nativeFetch=globalThis.fetch;
let localPort=null;
globalThis.fetch=async(value,options)=>{
 const url=new URL(value);
 assert.equal(url.protocol,'http:','Smoke checks may contact only their local fixture');
 assert.equal(url.hostname,'127.0.0.1','No external host may be contacted');
 assert.equal(url.port,String(localPort),'No other local service may be contacted');
 return nativeFetch(url,options);
};
const {createLibrary}=await import('./library/index.mjs');
const {createApp}=await import('./server.mjs');
const dataDir=path.join(root,'.fixture-data');
const unexpected=()=>{throw new Error('The standalone smoke test must not contact an Echo or external service.');};
const bridge={
 status:()=>({connection:{state:'disconnected',message:'Standalone fixture'},settings:{region:'IN',country:'IN',locale:'en-IN'},devices:[],player:null}),
 requireDevice:unexpected,play:unexpected,playPlaylist:unexpected,control:unexpected,setVolume:unexpected,sendTextCommand:unexpected,
 restore:unexpected,disconnect:()=>({})
};
const library=createLibrary({dataDir,bridge,fetcher:unexpected});
const amazonConnection={status:bridge.status,stop:()=>{}};
const app=await createApp({port:0,dataDir,library,amazonConnection,upstream:unexpected});
let result;
try {
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));localPort=app.address().port;
 const base='http://127.0.0.1:'+localPort;
 const html=await fetch(base+'/');assert.equal(html.status,200);
 const markup=await html.text();
 for(const id of ['search-form','music-catalogue','apple-section','spotify-section','youtube-section','playlist-import-dialog'])assert.ok(markup.includes('id="'+id+'"'),'Missing full-app section: '+id);
 for(const file of ['/app.js','/app.css']){const response=await fetch(base+file);assert.equal(response.status,200,file);assert.ok((await response.text()).length>100,file);}
 const statusResponse=await fetch(base+'/api/status');assert.equal(statusResponse.status,200);const status=await statusResponse.json();
 assert.equal(status.connection.state,'disconnected');assert.equal(status.catalogue.source,'itunes');
 for(const account of ['apple','spotify','youtube']){assert.equal(status[account].configured,false,account);assert.equal(status[account].connected,false,account);}
 assert.equal(status.spotify.redirectUri,'http://127.0.0.1:4320/api/spotify/callback');assert.equal(status.youtube.redirectUri,'http://127.0.0.1:4320/api/youtube/callback');
 const created=await fetch(base+'/api/local-playlists',{method:'POST',headers:{Origin:base,'X-Echo-App':'1','Content-Type':'application/json'},body:JSON.stringify({name:'Standalone smoke playlist',country:'IN'})});
 assert.equal(created.status,201);const playlist=(await created.json()).playlist;assert.equal(playlist.name,'Standalone smoke playlist');assert.equal(playlist.country,'IN');
 const saved=await fetch(base+'/api/local-playlists');assert.equal(saved.status,200);const playlists=(await saved.json()).playlists;assert.equal(playlists.length,1);assert.equal(playlists[0].id,playlist.id);
 assert.equal((await fetch(base+'/setup')).status,200);
 result={standalone:true,assets:3,accounts:['apple','spotify','youtube'],savedPlaylists:playlists.length,dependencyLocal:true};
} finally {
 await app.stopResources();app.closeAllConnections?.();await new Promise(resolve=>app.close(resolve));
}
console.log(JSON.stringify(result));
`;

test('the complete library runs from an isolated runtime copy with only its own installed dependencies', {timeout:30000}, async t=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'echo-standalone-proof-'));
  const requestedClone=path.join(temporary,'standalone');await fs.mkdir(requestedClone);
  // macOS exposes /var as a /private/var alias; compare canonical paths.
  const clone=await fs.realpath(requestedClone);
  t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
  const modules=await fs.lstat(path.join(root,'node_modules'));
  assert.equal(modules.isDirectory(),true);assert.equal(modules.isSymbolicLink(),false);
  for(const name of runtime) {
    await fs.cp(path.join(root,name),path.join(clone,name),{
      recursive:true,
      verbatimSymlinks:true,
      filter:source=>{
        const relative=path.relative(root,source),parts=relative.split(path.sep);
        return !parts.some(part=>['.local','.git','.npm-cache','.DS_Store'].includes(part)) && !relative.startsWith('library'+path.sep+'test'+path.sep) && relative!=='library'+path.sep+'test';
      }
    });
  }
  assert.deepEqual((await fs.readdir(clone)).sort(),runtime.slice().sort());
  await requireInternalLinks(clone,clone);
  const file=path.join(clone,'.standalone-smoke.mjs');await fs.writeFile(file,smoke,{mode:0o600});
  const {stdout,stderr}=await run(process.execPath,[file],{
    cwd:clone,env:{...process.env,NODE_PATH:'',NODE_OPTIONS:''},timeout:20000,maxBuffer:1024*1024
  });
  assert.equal(stderr,'');
  assert.deepEqual(JSON.parse(stdout.trim()),{standalone:true,assets:3,accounts:['apple','spotify','youtube'],savedPlaylists:1,dependencyLocal:true});
});
