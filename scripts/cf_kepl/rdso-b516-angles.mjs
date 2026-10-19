/**
 * rdso-b516-angles.mjs — the user's decision of 2026-10-19 on RDSO/B-516: the X-frame angles drawn as
 * "L 100x75 (thickness not shown)" (diagonal D, horizontals HA) are ISA 100 x 75 x 8 ("thickness 8 mm assumed by the
 * user 2026-10-19: drawing B-516 gives none; sister RDSO drawings use 8"). DRY RUN BY DEFAULT (read-only, every
 * statement checked); --commit writes, ONE TRANSACTION.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/rdso-b516-angles.mjs --company 30005 --prod              dry run on production
 *   node scripts/cf_kepl/rdso-b516-angles.mjs --company 30005 --prod --commit
 *        [--user <id>]   written as created_by
 *
 *   1 the catalog: a bar ISA 100 x 75 x 8 for every stock length and grade / impact class of the ISA 100 x 100 x 10
 *     family (E250/E350 × BO/BR × length), made like it the way the section picker's "Add this size to the catalog"
 *     does; one already there is reused (standardSectionDecisionService.ensureSizeBars)
 *   2 RDSO/B-516's CURRENT version copied into the NEXT one (made_from 'decision'); its rows drawn "L 100x75 (thickness
 *     not shown)" take the ISA 100 x 75 x 8 E250 BR bar (the fix's pick: the row's grade, the longest stock length,
 *     class BR as the fix used), THICKNESS 8 and SECTION_AREA 1336 mm² (the angles' and their assemblies' WEIGHT
 *     follow), the BOM lines' words say 100 x 75 x 8 and the decision; filled until settled; made current. The
 *     standard's notes get the decision. No existing version is written (SO260014's RDSO/B-11753R3 v1 is not touched).
 *   IDEMPOTENT: a second --commit writes nothing; a dry run after it plans nothing.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const COMMIT = process.argv.includes('--commit');
if (!Number.isInteger(COMPANY) || COMPANY <= 0) {
  console.error('Usage: node scripts/cf_kepl/rdso-b516-angles.mjs --company <id> [--prod] [--commit] [--user <id>]');
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
const { applyDecision } = await imp('apps/cf_erp/services/standardSectionDecisionService.js');

const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
const refuse = (sql) => { throw new Error(`read-only — refused: ${String(sql?.sql ?? sql).slice(0, 80)}`); };
const ro = { query: (sql, ...rest) => (isReadOnlySql(sql) ? pool.query(sql, ...rest) : refuse(sql)), execute: (sql, ...rest) => (isReadOnlySql(sql) ? pool.execute(sql, ...rest) : refuse(sql)), getConnection: () => refuse('getConnection') };
const [[co]] = await ro.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
if (!co) { console.error(`No company ${COMPANY}.`); process.exit(1); }
console.log(`${where} — company ${co.id} ${co.name} — ${COMMIT ? 'COMMIT (writes, one transaction)' : 'DRY RUN (read-only)'}\n`);

let code = 0;
try {
  const out = await applyDecision({
    pool: COMMIT ? pool : null, read: ro, companyId: COMPANY, userId: arg('user') ? Number(arg('user')) : null,
    commit: COMMIT, bomDir: path.join(BE, '..', 'drawing_bom', 'out'), log: console.log,
  });
  console.log(`\n${COMMIT ? (out.written ? 'Written.' : 'Nothing written — it is all there.') : (out.planned ? 'Nothing written — --commit writes.' : 'Nothing to write.')}`);
} catch (err) {
  console.error(`\nFAILED${COMMIT ? ', rolled back' : ''}: ${err.message}${err.problems ? ` — ${err.problems.join('; ')}` : ''}`);
  code = 1;
}
await pool.end();
process.exit(code);
