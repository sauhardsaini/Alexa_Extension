import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const script = await fs.readFile(new URL('../library/public/app.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../library/public/index.html', import.meta.url), 'utf8');
const start = script.indexOf('  function confirmInApp('), end = script.indexOf('\n  async function deleteLocalPlaylist', start);
function fixture() {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, { open:false, textContent:'', returnValue:'', showModal(){this.open=true;} }); return nodes.get(id); };
  const context = vm.createContext({ $:get, Promise }); vm.runInContext(script.slice(start,end),context);
  return { get, ask: () => vm.runInContext('confirmInApp("<b>Playlist?</b>", "Delete playlist")',context), close(value='') { const d=get('app-confirm-dialog'); d.returnValue=value;d.open=false;d.onclose(); } };
}
test('app confirmation uses safe text and resolves only after an explicit dialog choice',async()=>{
  const f=fixture(), pending=f.ask(); assert.equal(f.get('app-confirm-dialog').open,true);
  assert.equal(f.get('app-confirm-message').textContent,'<b>Playlist?</b>');
  assert.equal(f.get('app-confirm-accept').textContent,'Delete playlist');
  f.close('confirm'); assert.equal(await pending,true);
});
test('Cancel and Escape reject confirmation, and a previous acceptance cannot leak into the next dialog',async()=>{
  const f=fixture();let p=f.ask();f.close('confirm');assert.equal(await p,true);
  p=f.ask();f.close();assert.equal(await p,false);
  p=f.ask();assert.equal(await f.ask(),false);f.close('cancel');assert.equal(await p,false);
});
test('active app scripts contain no native alert/confirm/prompt and the confirmation dialog has a safe default',async()=>{
  for(const folder of ['library/public','helper','extension']) {
    for(const file of await fs.readdir(new URL('../'+folder+'/',import.meta.url))) {
      if(!/\.js$/.test(file))continue;
      const s=await fs.readFile(new URL('../'+folder+'/'+file,import.meta.url),'utf8');
      assert.doesNotMatch(s,/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/,folder+'/'+file);
    }
  }
  assert.match(html,/id="app-confirm-dialog"[^>]+role="alertdialog"/);
  assert.match(html,/value="cancel" autofocus/);
});
