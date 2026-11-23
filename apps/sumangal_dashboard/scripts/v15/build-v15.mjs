/**
 * Builds the dataset for the ERP dashboard (V15) screen.
 *
 *   node apps/sumangal_dashboard/scripts/v15/build-v15.mjs                base data from the ERP tables (build-d.mjs)
 *   node apps/sumangal_dashboard/scripts/v15/build-v15.mjs "<V13 html>"   base data taken from Shaurya's V13 file instead
 *
 * Inputs: the ERP tables in SQLite form, read-only (SUMANGAL_DB, default D:/SumangalData/work/casting.sqlite; the
 * nightly agent makes this file from SQL Server). Work folder: SUMANGAL_WORK (default D:/SumangalData/work).
 * Steps: build-d.mjs (the base data, same shape as V13's) → supp.mjs (WO no., heats, plan qty, manual WOs) →
 * hist.mjs (history from 2022, short customer names, part numbers). Output: <work>/v15.json = { D, S, H }.
 * The page applies H and recomputes every kg as pieces × the die's casting weight when it loads.
 * Load it with load-v15.mjs, or let the agent push it.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.SUMANGAL_WORK || 'D:/SumangalData/work';
const env = { ...process.env, SUMANGAL_WORK: WORK };
const run = (f) => { console.log('running', f); execFileSync(process.execPath, ['--no-warnings', path.join(here, f)], { stdio: 'inherit', env }); };
const src = process.argv[2];
fs.mkdirSync(WORK, { recursive: true });
if (src) {
  const line = fs.readFileSync(src, 'utf8').split('\n').find((l) => l.startsWith('const D={'));
  if (!line) { console.error('No "const D={" line in ' + src); process.exit(1); }
  fs.writeFileSync(path.join(WORK, 'v13-data.js'), line);
} else run('build-d.mjs');
run('supp.mjs');
run('hist.mjs');
const line = fs.readFileSync(path.join(WORK, 'v13-data.js'), 'utf8');
const D = line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1);
const out = `{"D":${D},"S":${fs.readFileSync(path.join(WORK, 'supp.json'), 'utf8')},"H":${fs.readFileSync(path.join(WORK, 'hist.json'), 'utf8')}}`;
JSON.parse(out);
fs.writeFileSync(path.join(WORK, 'v15.json'), out);
console.log('written', path.join(WORK, 'v15.json'), out.length, 'bytes');
