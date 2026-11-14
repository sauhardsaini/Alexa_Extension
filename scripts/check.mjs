import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(new URL('..', import.meta.url).pathname);
async function walk(dir) {
  let files = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const entry = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...await walk(entry)); else if (/\.(?:m?js)$/.test(item.name)) files.push(entry);
  }
  return files;
}
const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Manifest V3 is required.');
for (const entry of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...(manifest.content_scripts || []).flatMap(group => group.js)].filter(Boolean)) await fs.access(path.join(root, 'extension', entry));
for (const file of await walk(root)) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
console.log('Manifest files and JavaScript syntax checked.');
