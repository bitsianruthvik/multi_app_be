/**
 * rdso-sheets-attach.mjs — put the RDSO series' sheets on the structure levels they draw, for standards imported before
 * the importer did it (services/standardSheetService.js). DRY RUN BY DEFAULT (read-only, every statement checked);
 * --commit writes.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/rdso-sheets-attach.mjs --company 30005 --prod              dry run on production
 *   node scripts/cf_kepl/rdso-sheets-attach.mjs --company 30005 --prod --commit     writes
 *        [--standards RDSO/B-11753R3,RDSO/B-516]   only these numbers
 *        [--user <id>]                             written as created_by
 * Under each standard it prints its current version's assembly rows and the sheet(s) each is linked to.
 *
 * WHAT HAPPENED (user, 2026-10-27: "some of the RDSO diagrams are not at structure levels"). The importer registered
 * each RDSO series once and linked it to the span only, and each part's DXF to its part row; the series' other sheets
 * (splice joint, X-frame and end diaphragm, bearings, assembly drawing & part list, camber) were never registered, so
 * every assembly row — girder line, segment, end diaphragm, X-frame, bracing, splice set, seismic stopper — had no
 * drawing on the standard, and none on the order lines copied from it (SO260014 line 1).
 *
 * WHAT THIS DOES, per standard imported from TM/drawing_bom/out/<SET> (its version 1 says "Imported from <SET>"),
 * ONE TRANSACTION EACH (a failure rolls that standard back and the run stops):
 *   1 registers each sheet of bom.json `drawing.sheets` (the customer's number and revision as printed, the series link
 *     opened at its page) — or finds it again;
 *   2 links every live version's assembly rows to the sheets that draw them (the same rule as the importer);
 *   3 gives each order line made from the standard the links its version's rows have, by BOM path.
 * Only cf_drawings rows (the sheets) and cf_drawing_links rows are written; nothing is changed or removed. IDEMPOTENT:
 * a second --commit run writes nothing. Only the company given is read or written.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const COMMIT = process.argv.includes('--commit');
if (!Number.isInteger(COMPANY) || COMPANY <= 0) {
  console.error('Usage: node scripts/cf_kepl/rdso-sheets-attach.mjs --company <id> [--prod] [--commit] [--standards A,B] [--user <id>]');
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
const { repairStandardSheets } = await imp('apps/cf_erp/services/standardSheetService.js');
const bomDir = path.join(BE, '..', 'drawing_bom', 'out');

const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
const refuse = (sql) => { throw new Error(`read-only — refused: ${String(sql?.sql ?? sql).slice(0, 80)}`); };
const ro = { query: (sql, ...rest) => (isReadOnlySql(sql) ? pool.query(sql, ...rest) : refuse(sql)), execute: (sql, ...rest) => (isReadOnlySql(sql) ? pool.execute(sql, ...rest) : refuse(sql)), getConnection: () => refuse('getConnection') };
const [[co]] = await ro.query('SELECT id, name FROM companies WHERE id = ?', [COMPANY]);
if (!co) { console.error(`No company ${COMPANY}.`); process.exit(1); }
console.log(`${where} — company ${co.id} ${co.name} — ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (read-only)'}`);

const only = arg('standards') ? new Set(arg('standards').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
const [standards] = await ro.query(
  `SELECT s.*, (SELECT v.note FROM cf_standard_drawing_versions v WHERE v.company_id = s.company_id AND v.standard_id = s.id AND v.version_no = 1 LIMIT 1) AS first_note
     FROM cf_standard_drawings s WHERE s.company_id = ? AND s.deleted_at IS NULL ORDER BY s.id`, [COMPANY]);
const c = { companyId: COMPANY, userId: arg('user') ? Number(arg('user')) : null };
let total = { sheets: 0, versionLinks: 0, lineLinks: 0, unmatched: 0, failed: 0, skipped: 0 };
for (const s of standards) {
  if (only && !only.has(String(s.number).toLowerCase())) continue;
  const set = /^Imported from (\S+)/.exec(s.first_note ?? '')?.[1] ?? null;
  const file = set ? path.join(bomDir, set, 'bom.json') : null;
  if (!file || !fs.existsSync(file)) { console.log(`\n${s.number}: not imported from a drawing_bom set (${s.first_note ?? 'no version 1'}) — skipped.`); total.skipped++; continue; }
  const bom = JSON.parse(fs.readFileSync(file, 'utf8'));
  let out;
  if (!COMMIT) out = await repairStandardSheets(ro, c, { standard: s, bom, commit: false });
  else {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      out = await repairStandardSheets(conn, c, { standard: s, bom, commit: true });
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      console.error(`\n${s.number}: FAILED, rolled back — ${e.message}`);
      total.failed++;
      conn.release();
      break;
    }
    conn.release();
  }
  if (out.skipped) { console.log(`\n${s.number}: ${out.skipped} — skipped.`); total.skipped++; continue; }
  const newSheets = out.sheets.filter((x) => !x.registered).length;
  console.log(`\n${s.number} (${set}): ${out.sheets.length} sheet(s) drawn on its assembly rows besides the general arrangement${COMMIT ? '' : `, ${newSheets} to register`}`);
  for (const x of out.sheets) console.log(`   ${x.registered ? 'have' : COMMIT ? 'made' : 'NEW '}  ${x.number} rev ${x.revision}  ${x.title ?? ''}`);
  for (const v of out.versions) console.log(`   version ${v.versionNo}: ${v.assemblies} assembly rows — ${v.add} link(s) ${COMMIT ? 'added' : 'to add'}`);
  const last = out.versions[out.versions.length - 1];
  if (last) for (const m of last.map) console.log(`      ${m}`);
  for (const l of out.lines) console.log(`   line ${l.id} (${l.order}): ${l.add} link(s) ${COMMIT ? 'added' : 'to add'}${l.unmatched ? `, ${l.unmatched} row(s) of its version not found on the line at the same place (left as they are)` : ''}${l.note ? ` — ${l.note}` : ''}`);
  total.sheets += COMMIT ? out.sheets.length : newSheets;
  total.versionLinks += out.versions.reduce((a, v) => a + v.add, 0);
  total.lineLinks += out.lines.reduce((a, l) => a + l.add, 0);
  total.unmatched += out.lines.reduce((a, l) => a + l.unmatched, 0);
}
console.log(`\n${COMMIT ? 'Written' : 'Would write'}: ${total.sheets} sheet register drawing(s)${COMMIT ? ' (made or found)' : ''}, ${total.versionLinks} link(s) on standard versions, ${total.lineLinks} link(s) on order lines; ${total.unmatched} line row(s) not matched; ${total.skipped} standard(s) skipped; ${total.failed} failed.${COMMIT ? '' : ' Nothing written — --commit writes.'}`);
await pool.end();
process.exit(total.failed ? 1 : 0);
