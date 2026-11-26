// Builds dist/: the files the customer's machine downloads (see README.md). Run: npm install && node build.mjs
import fs from 'fs';
import crypto from 'crypto';
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
const tables = [...new Set(builders.flatMap((f) => fs.readFileSync(path.join(v15, f), 'utf8').match(/\btbl_[a-z0-9_]+/gi) || []))].filter((t) => !t.endsWith('_')).sort();
fs.writeFileSync(path.join(dist, 'tables.json'), JSON.stringify(tables, null, 1));
fs.copyFileSync(path.join(here, 'setup.ps1'), path.join(dist, 'setup.ps1'));
fs.copyFileSync(path.join(here, 'update.ps1'), path.join(dist, 'update.ps1'));
fs.copyFileSync(path.join(here, 'README.md'), path.join(dist, 'README.md'));
// wscript wants CRLF line ends
fs.writeFileSync(path.join(dist, 'run-hidden.vbs'), fs.readFileSync(path.join(here, 'run-hidden.vbs'), 'utf8').replace(/\r?\n/g, '\r\n'));

// The release: every file with the SHA-256 of the form the dashboard serves it in (routes/agent.js servedForm: LF, CRLF
// for .vbs), signed with the platform team's Ed25519 key. Installed agents take a new version only with this signature.
// The private key stays on the platform team's PC (TM\.sumangal-agent-release.pem, never committed); without it the
// build stops rather than ship an unsigned list.
const servedForm = (name, text) => (name.endsWith('.vbs') ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n'));
const keyFile = process.env.SUMANGAL_RELEASE_KEY || path.join(here, '..', '..', '..', '..', '.sumangal-agent-release.pem');
if (!fs.existsSync(keyFile)) throw new Error(`release key not found (${keyFile}); set SUMANGAL_RELEASE_KEY`);
const version = fs.readFileSync(path.join(here, 'src', 'agent.mjs'), 'utf8').match(/const VERSION = '([^']+)'/)[1];
const shipped = ['agent.mjs', 'build-d.mjs', 'supp.mjs', 'hist.mjs', 'build-v15.mjs', 'tables.json', 'run-hidden.vbs', 'setup.ps1', 'update.ps1', 'README.md'];
const files = Object.fromEntries(shipped.map((f) => [f, crypto.createHash('sha256').update(Buffer.from(servedForm(f, fs.readFileSync(path.join(dist, f), 'utf8')), 'utf8')).digest('hex')]));
// settings.json: what the platform team sets on the installed agent from here (agent.mjs applySettings; no secrets)
const settings = JSON.parse(fs.readFileSync(path.join(here, 'settings.json'), 'utf8'));
const release = Buffer.from(JSON.stringify({ version, settings, files }, null, 1) + '\n', 'utf8');
fs.writeFileSync(path.join(dist, 'release.json'), release);
fs.writeFileSync(path.join(dist, 'release.sig'), crypto.sign(null, release, crypto.createPrivateKey(fs.readFileSync(keyFile))).toString('base64') + '\n');
console.log('dist:', fs.readdirSync(dist).map((f) => `${f} ${Math.round(fs.statSync(path.join(dist, f)).size / 1024)} KB`).join(', '), '| tables', tables.length);
