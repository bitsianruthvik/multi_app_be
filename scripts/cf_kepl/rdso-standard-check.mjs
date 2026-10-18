/**
 * rdso-standard-check.mjs — what the standard drawings' BOMs still lack, standard by standard. READ-ONLY.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/rdso-standard-check.mjs --company 2                      local
 *   node scripts/cf_kepl/rdso-standard-check.mjs --company 30005 --prod           production (TM/.env.tidb), SELECTs only
 *        [--json <file>]        the whole result as JSON (rdso-standard-fix.mjs and TM/rdso_check/REPORT.md read it)
 *        [--standards A,B]      only these numbers
 *        [--all-versions]       every version, not only the current one
 *
 * Production 2026-10-18: RDSO/B-11753R3 v1 made an order line with 20 required values blank, 4 section parts with
 * no section and 3 rows with no flow — each found one at a time, at freeze and at release. This asks the same
 * questions of every standard at once, with the engine's own readers:
 *   required values   processService.missingRequiredValues (what the freeze checklist counts); a specification the
 *                     ORDER gives (`order_level`) is listed apart — the order's own values fill it on the line
 *   sections          a part cut from a SECTION with no stock bar (lib/cutFrom, as the BOM grid's "Choose section")
 *   flows             a made row (a temporary item) with no flow of its own, of its BOM line or of its definition
 *                     (bomService.explode's effective flow — what release reads)
 *   quantities        a BOM line quantity that is zero, negative or not a whole number of pieces, and a part's
 *                     pieces a span against the drawing's own count (bom.json, TM/drawing_bom/out/<set>)
 * Every statement this script sends is checked to be a plain read first (db.js isReadOnlySql); anything else
 * throws before it reaches the database.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
if (!Number.isInteger(COMPANY) || COMPANY <= 0) {
  console.error('Usage: node scripts/cf_kepl/rdso-standard-check.mjs --company <id> [--prod] [--json <file>] [--standards A,B] [--all-versions]');
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
const { checkStandards } = await imp('apps/cf_erp/lib/standardGaps.js');

// READ-ONLY, enforced: a statement that is not a plain read never leaves this process.
const refuse = (sql) => { throw new Error(`rdso-standard-check is read-only — refused: ${String(sql?.sql ?? sql).slice(0, 80)}`); };
const ro = {
  query: (sql, ...rest) => (isReadOnlySql(sql) ? pool.query(sql, ...rest) : refuse(sql)),
  execute: (sql, ...rest) => (isReadOnlySql(sql) ? pool.execute(sql, ...rest) : refuse(sql)),
  getConnection: () => refuse('getConnection'),
};

const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
console.log(`${where} — company ${COMPANY} — read-only`);
const only = arg('standards') ? arg('standards').split(',').map((s) => s.trim()).filter(Boolean) : null;
const res = await checkStandards(ro, COMPANY, { only, allVersions: process.argv.includes('--all-versions'), bomDir: path.join(BE, '..', 'drawing_bom', 'out') });
for (const s of res.standards) {
  const g = s.gaps;
  console.log(`\n${s.number} v${s.versionNo} (version #${s.versionId}, ${s.rows} rows${s.set ? `, set ${s.set}` : ', no bom.json found'})${s.usedByLines.length ? ` — used by line(s) ${s.usedByLines.join(', ')}` : ''}`);
  console.log(`  required values missing: ${g.values.length}${g.orderValues.length ? ` (+ ${g.orderValues.length} the order gives)` : ''}`);
  for (const [code, list] of Object.entries(groupBy(g.values, (v) => v.specCode))) console.log(`    ${code.padEnd(24)} ${list.length} ×${list.some((v) => v.workedOut) ? ' (formula on the line)' : ''} ${[...new Set(list.map((v) => v.path))].slice(0, 4).join(' | ')}${list.length > 4 ? ' …' : ''}${list[0].derive ? `  → derivable: ${list.filter((v) => v.derive).length}/${list.length} (${list[0].derive.how})` : ''}`);
  console.log(`  section parts with no section: ${g.sections.length}`);
  for (const x of g.sections) console.log(`    ${x.path}  ${x.profile ?? ''}${x.derive ? `  → ${x.derive.code}` : ''}`);
  console.log(`  made rows with no flow: ${g.flows.length}`);
  for (const x of g.flows) console.log(`    ${x.path}${x.derive ? `  → ${x.derive.code} (${x.derive.how})` : ''}`);
  console.log(`  quantity problems: ${g.quantities.length}`);
  for (const x of g.quantities) console.log(`    ${x.path}: ${x.problem}`);
}
console.log(`\n${res.standards.length} standard version(s); gaps in ${res.standards.filter((s) => s.total).length}. Round trips: ${res.reads}.`);
if (arg('json')) { fs.writeFileSync(arg('json'), JSON.stringify(res, null, 1)); console.log(`JSON → ${arg('json')}`); }
await pool.end();

function groupBy(xs, f) { const o = {}; for (const x of xs) (o[f(x)] ??= []).push(x); return o; }
