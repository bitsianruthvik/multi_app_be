/**
 * rdso-standard-repair.mjs — repair the standard drawings' versions written by rdso-standard-fix.mjs on 2026-10-19,
 * before the copy carried the rows' section bars. DRY RUN BY DEFAULT (read-only, every statement checked); --commit writes.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/rdso-standard-repair.mjs --company 30005 --prod --section-class BR              dry run
 *   node scripts/cf_kepl/rdso-standard-repair.mjs --company 30005 --prod --section-class BR --commit
 *        [--standards A,B]   only these numbers
 *        [--restore-only]    only put back what a copy lost; do not fill what the drawing settles
 *        [--user <id>]       written as created_by
 *
 * WHAT HAPPENED (production, company 30005). Run 1 wrote v2 of 6 standards; run 2 wrote v3 of those 6 and v2 of
 * the other 10. treeCopyService did not copy cf_master_records.cut_stock_id, so every v3 lost the section bars its
 * v2 was given (RDSO/B-11751R3: 6 rows, ISA bars #1317 / #1339 → NULL), and kept the 1 value run 2 added. And every
 * fill left 1 value its new flows ask (the x-frame's SURFACE_AREA), so v2 of the other 10 is one value short.
 *
 * WHAT THIS DOES, per standard (ONE TRANSACTION EACH; a failure rolls that standard back and the run stops):
 *   1 compares the CURRENT version with the version it was copied from (its note "… over vN", made_from 'fix'), row
 *     by row (the same BOM path): a section bar, a row's flow or a BOM line's flow the older one has and the current
 *     one lacks is LOST. A lost TYPED value or rule, or a row missing, is not repaired here: the standard is left as it is
 *     and named (none on production 2026-10-19). A rolled-up / calculated value the engine removed when the rows were
 *     settled (RDSO/B-516: 3 assemblies' WEIGHT) is listed, not restored.
 *   2 when something is lost, or the drawing still settles something on the current version (unless --restore-only):
 *     the current version is copied into the NEXT version (the fixed copy: bars, flows, values, rules), the lost bars
 *     and flows are put back on the new rows (only where empty), the new version is filled until the drawing settles
 *     nothing more (standardGapFixService.fillUntilSettled), checked to hold everything both older versions hold, and
 *     becomes current. Nothing is ever deleted; no existing version is written (a line's version — SO260014 uses v1 of
 *     RDSO/B-11753R3 — is only ever read).
 *   3 IDEMPOTENT: a standard whose current version lost nothing and has nothing the drawing settles is skipped — after
 *     a --commit run, a second run writes nothing.
 * Why a NEW version and not "point current back to v2": v2 lacks the value v3 holds, v3 lacks the bars v2 holds — the
 * repaired version holds both.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const COMMIT = process.argv.includes('--commit');
const RESTORE_ONLY = process.argv.includes('--restore-only');
const SECTION_CLASS = arg('section-class') ? String(arg('section-class')).toUpperCase() : null;
if (!Number.isInteger(COMPANY) || COMPANY <= 0 || (SECTION_CLASS && !['BR', 'BO', 'A', 'C'].includes(SECTION_CLASS))) {
  console.error('Usage: node scripts/cf_kepl/rdso-standard-repair.mjs --company <id> [--prod] [--commit] [--section-class BR|BO|A] [--standards A,B] [--restore-only] [--user <id>]');
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
const { repairStandards } = await imp('apps/cf_erp/services/standardVersionRepairService.js');
const bomDir = path.join(BE, '..', 'drawing_bom', 'out');

const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
// Every read before a standard is written goes through this: on a dry run nothing else is sent at all.
const refuse = (sql) => { throw new Error(`read-only — refused: ${String(sql?.sql ?? sql).slice(0, 80)}`); };
const ro = { query: (sql, ...rest) => (isReadOnlySql(sql) ? pool.query(sql, ...rest) : refuse(sql)), execute: (sql, ...rest) => (isReadOnlySql(sql) ? pool.execute(sql, ...rest) : refuse(sql)), getConnection: () => refuse('getConnection') };
const [[co]] = await ro.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
if (!co) { console.error(`No company ${COMPANY}.`); process.exit(1); }
console.log(`${where} — company ${co.id} ${co.name} — ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (read-only)'}${SECTION_CLASS ? ` — section bars of class ${SECTION_CLASS}` : ''}${RESTORE_ONLY ? ' — restore only' : ''}`);

const only = arg('standards') ? arg('standards').split(',').map((s) => s.trim()).filter(Boolean) : null;
const out = await repairStandards({
  pool: COMMIT ? pool : null, read: ro, companyId: COMPANY, userId: arg('user') ? Number(arg('user')) : null,
  only, sectionClass: SECTION_CLASS, restoreOnly: RESTORE_ONLY, commit: COMMIT, bomDir, log: console.log,
});
console.log(`\n${out.repaired} standard(s) ${COMMIT ? 'repaired' : 'would be repaired'}; ${out.ok} left as they are; ${out.refused} need a person; ${out.failed} failed.${COMMIT ? '' : ' Nothing written — --commit writes.'}`);
await pool.end();
process.exit(out.failed ? 1 : 0);
