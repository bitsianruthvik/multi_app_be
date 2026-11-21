/**
 * Builds the dataset for the ERP dashboard (V15) screen: V13's data + supplement + history from 2022.
 *
 *   node apps/sumangal_dashboard/scripts/v15/build-v15.mjs "<path to Sumangal_ERP_Dashboard_V13.html>"
 *
 * Inputs: V13's HTML (its embedded `const D=` line; V13's own builder is not in this repo) and the ERP copy at
 * D:/SumangalData/work/casting.sqlite (read-only). Work folder: SUMANGAL_WORK (default D:/SumangalData/work).
 * Output: <work>/v15.json = { D, S, H }. The page applies H (history, short names, part numbers) and recomputes
 * every kg as pieces x the die's casting weight when it loads. Then load it with load-v15.mjs.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.SUMANGAL_WORK || 'D:/SumangalData/work';
const src = process.argv[2];
if (!src) { console.error('Usage: build-v15.mjs <V13 html>'); process.exit(1); }
const line = fs.readFileSync(src, 'utf8').split('\n').find((l) => l.startsWith('const D={'));
if (!line) { console.error('No "const D={" line in ' + src); process.exit(1); }
fs.writeFileSync(path.join(WORK, 'v13-data.js'), line);
for (const f of ['supp.mjs', 'hist.mjs']) { console.log('running', f); execFileSync(process.execPath, ['--no-warnings', path.join(here, f)], { stdio: 'inherit', env: { ...process.env, SUMANGAL_WORK: WORK } }); }
const D = line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1);
const out = `{"D":${D},"S":${fs.readFileSync(path.join(WORK, 'supp.json'), 'utf8')},"H":${fs.readFileSync(path.join(WORK, 'hist.json'), 'utf8')}}`;
JSON.parse(out);
fs.writeFileSync(path.join(WORK, 'v15.json'), out);
console.log('written', path.join(WORK, 'v15.json'), out.length, 'bytes');
