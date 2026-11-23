// Builds dist/: the files the customer's machine downloads (see README.md). Run: npm install && node build.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist'); const v15 = path.join(here, '..', 'scripts', 'v15');
fs.mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [path.join(here, 'src', 'agent.mjs')], outfile: path.join(dist, 'agent.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['node:sqlite'], legalComments: 'none',
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
const builders = ['build-d.mjs', 'supp.mjs', 'hist.mjs', 'build-v15.mjs'];
for (const f of builders) fs.copyFileSync(path.join(v15, f), path.join(dist, f));
const tables = [...new Set(builders.flatMap((f) => fs.readFileSync(path.join(v15, f), 'utf8').match(/\btbl_[a-z0-9_]+/gi) || []))].sort();
fs.writeFileSync(path.join(dist, 'tables.json'), JSON.stringify(tables, null, 1));
fs.copyFileSync(path.join(here, 'setup.ps1'), path.join(dist, 'setup.ps1'));
fs.copyFileSync(path.join(here, 'README.md'), path.join(dist, 'README.md'));
console.log('dist:', fs.readdirSync(dist).map((f) => `${f} ${Math.round(fs.statSync(path.join(dist, f)).size / 1024)} KB`).join(', '), '| tables', tables.length);
