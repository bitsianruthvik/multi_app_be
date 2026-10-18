/**
 * rdso-standard-fix.mjs — fill the standard drawings' gaps from their own drawing data, each as a NEW VERSION.
 * DRY RUN BY DEFAULT (read-only); --commit writes.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/rdso-standard-fix.mjs --company 30005 --prod                          dry run on production
 *   node scripts/cf_kepl/rdso-standard-fix.mjs --company 30005 --prod --section-class BR --commit
 *        [--standards A,B]      only these numbers (default: every standard with something to fill)
 *        [--section-class BR]   the impact class of the bars section parts are cut from (BR | BO | A). A part's class
 *                               is the ORDER's on these standards, so the standard cannot know it; without this flag
 *                               the section parts are left for a person (listed). SO260014 used BR.
 *        [--user <id>]          written as created_by (default: none)
 *
 * What it does, per standard whose CURRENT version has gaps the drawing settles (lib/standardGaps.js):
 *   1 the current version is copied into the NEXT version (standardGapFixService.copyVersion) — the version a line
 *     was made from is never edited; its lines keep their copies
 *   2 on the new version's rows only: flows, section bars, the flows' asked values (lib/standardGaps derive)
 *   3 the new version becomes the standard's current one, with a note saying what was filled
 * ONE TRANSACTION PER STANDARD; a failure rolls that standard back and the run stops.
 *
 * IDEMPOTENT: a standard whose current version has nothing the drawing settles is skipped, so a second run does
 * nothing (it reads the new version and finds only what needs a person). Prints "local" or "PRODUCTION" first.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const COMMIT = process.argv.includes('--commit');
const SECTION_CLASS = arg('section-class') ? String(arg('section-class')).toUpperCase() : null;
if (!Number.isInteger(COMPANY) || COMPANY <= 0 || (SECTION_CLASS && !['BR', 'BO', 'A', 'C'].includes(SECTION_CLASS))) {
  console.error('Usage: node scripts/cf_kepl/rdso-standard-fix.mjs --company <id> [--prod] [--commit] [--section-class BR|BO|A] [--standards A,B] [--user <id>]');
  process.exit(2);
}
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const BE = path.join(__dir, '..', '..');
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool, isReadOnlySql } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { checkStandards } = await imp('apps/cf_erp/lib/standardGaps.js');
const { fixStandards } = await imp('apps/cf_erp/services/standardGapFixService.js');

const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
const [[co]] = await pool.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
if (!co) { console.error(`No company ${COMPANY}.`); process.exit(1); }
console.log(`${where} — company ${co.id} ${co.name} — ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (read-only)'}${SECTION_CLASS ? ` — section bars of class ${SECTION_CLASS}` : ''}`);

// The dry run cannot write: every statement is checked to be a plain read before it leaves.
const ro = {
  query: (sql, ...rest) => { if (!isReadOnlySql(sql)) throw new Error(`dry run is read-only — refused: ${String(sql?.sql ?? sql).slice(0, 80)}`); return pool.query(sql, ...rest); },
};
const only = arg('standards') ? arg('standards').split(',').map((s) => s.trim()).filter(Boolean) : null;
const bomDir = path.join(BE, '..', 'drawing_bom', 'out');
const res = await checkStandards(COMMIT ? pool : ro, COMPANY, { only, bomDir });
const out = await fixStandards({ pool, companyId: COMPANY, userId: arg('user') ? Number(arg('user')) : null, standards: res.standards, commit: COMMIT, sectionClass: SECTION_CLASS, log: console.log });
console.log(`\n${out.fixed} standard(s) ${COMMIT ? 'given a new version' : 'would get a new version'}; ${out.skipped} with nothing the drawing settles.${COMMIT ? '' : ' Nothing written — --commit writes.'}`);
await pool.end();
process.exit(out.failed ? 1 : 0);
