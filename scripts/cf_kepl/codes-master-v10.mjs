/**
 * codes-master-v10.mjs — Codes_Master_v10.xlsx › All_codes_master into the
 * template definitions (user, 2026-10-07).
 *
 * Decided with the user:
 * - ONE definition per sheet row; its code and short name = "Indicative code".
 * - An existing definition that IS a row (one-to-one, by name) only takes the
 *   row's code as its short name. The broad ones the sheet splits (Cover plate,
 *   Intermediate stiffener …) stay as they are.
 * - "Diaphragm web" (broad, short DWB) becomes the nearest narrow row, Inter.
 *   Diaph. Web / IDW, so DWB is left to "Deduct Web".
 * - Girder segment and Girder line stay as they are; the sheet's "Girder" (GDR)
 *   is not added.
 * - New ones sit in the same tree by kind: plates under Parts › Plate part,
 *   angles / beams under Parts › Profile part, shipping marks under Assemblies
 *   in a node per group (splice assemblies in the existing Splice set).
 *
 *   node scripts/cf_kepl/codes-master-v10.mjs --company 30005 --file <xlsx>            (dry run: rolled back)
 *   node scripts/cf_kepl/codes-master-v10.mjs --company 30005 --file <xlsx> --apply    (commits)
 * Re-running is safe: a row whose code already exists as a definition is skipped.
 */
import ExcelJS from 'exceljs';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createDefinition, updateRecord, setStatus } from '../../apps/cf_erp/services/masterRecordService.js';
import { createNode } from '../../apps/cf_erp/services/classificationService.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const FILE = arg('file');
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY) || !FILE) throw new Error('Usage: --company <id> --file <Codes_Master xlsx> [--apply]');

/** Existing definitions that ARE a sheet row: their name (lower case) → the row's code. */
const SAME = {
  'top flange': 'TFL', 'bottom flange': 'BFL', 'web plate': 'WPL', 'top flange outer cover plate': 'TOC',
  'jacking stiffener': 'JST', 'pad plate': 'PAD', 'gusset plate': 'GSP', 'inner flange plate': 'IFP',
  'blb-bracings': 'BBL', 'bottom lateral bracing': 'BLB', 'end diaphragm': 'EDP', 'intermediate diaphragm': 'IDP',
};
/** The broad one renamed to its nearest narrow row. */
const RENAME = { 'diaphragm web': 'IDW' };
const SKIP = new Set(['GDR']);
/** Flows by code, as the existing definitions of the same kind use them. */
const FLOW_OF = (r) => {
  if (r.category !== 'Item Master') return /SPLICE ASSEMBLIES/.test(r.group) ? 'CG-DISPATCHONLY' : null;
  if (isProfile(r)) return null;
  if (/cover plate/i.test(r.name) && r.structure === 'Composite Girder') return 'CG-OUTERSPLICE';
  if (/stiffener hole$/i.test(r.name)) return 'CG-HOLEDPART';
  if (/splice/i.test(r.name) && r.structure === 'Composite Girder') return 'PARTFAB-PLAIN';
  return 'CG-PLATEPART';
};
const isProfile = (r) => /angle|bracing|ismb/i.test(r.name) || r.structure === 'MISC.';
/** "DIAPHRAGM FRAMES (DFR)" → { name: 'Diaphragm frames', abbr: 'DFR' } */
const groupNode = (g) => {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(g.trim());
  const words = (m ? m[1] : g).trim().toLowerCase();
  return { name: words.charAt(0).toUpperCase() + words.slice(1), abbr: (m ? m[2] : words).replace(/[^A-Za-z0-9]/g, '').toUpperCase() };
};

// ---- the sheet ---------------------------------------------------------------
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);
const ws = wb.worksheets.find((w) => w.name.toLowerCase() === 'all_codes_master');
if (!ws) throw new Error('No All_codes_master sheet');
const cell = (v) => (v == null ? '' : v.result !== undefined ? v.result : v.richText ? v.richText.map((t) => t.text).join('') : v.text ?? v);
const rows = [];
ws.eachRow((row, i) => {
  if (i === 1) return;
  const [category, , structure, group, name, code] = row.values.slice(1).map((v) => String(cell(v)).trim());
  if (code) rows.push({ category, structure, group, name, code: code.toUpperCase() });
});
const dup = rows.map((r) => r.code).filter((c, i, a) => a.indexOf(c) !== i);
if (dup.length) throw new Error(`The sheet repeats codes: ${[...new Set(dup)].join(', ')}`);
console.log(`sheet: ${rows.length} rows (${rows.filter((r) => r.category === 'Item Master').length} parts, ${rows.filter((r) => r.category !== 'Item Master').length} shipping marks)`);

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };

  const [defs] = await db.query("SELECT id, code, name, short_name FROM cf_master_records WHERE company_id = ? AND record_kind = 'definition' AND deleted_at IS NULL", [COMPANY]);
  const byName = new Map(defs.map((d) => [d.name.trim().toLowerCase(), d]));
  const byCode = new Map(defs.filter((d) => d.code).map((d) => [d.code.toUpperCase(), d]));
  const [nodes] = await db.query('SELECT id, code, name, parent_id FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  const nodeByCode = (code) => nodes.find((n) => n.code.toUpperCase() === code);
  const plate = nodeByCode('PLATE_PART'), profile = nodeByCode('PROFILE_PART'), assy = nodeByCode('FAB_ASSY'), spliceSet = nodeByCode('SPLICE_SET');
  if (!plate || !profile || !assy) throw new Error('Plate part / Profile part / Assemblies nodes not found');
  const [flows] = await db.query('SELECT id, code FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  const flowId = (code) => (code ? flows.find((f) => f.code === code)?.id ?? null : null);

  // 1. existing definitions that are a row: short name (and the one rename)
  const done = new Set();
  for (const [name, code] of [...Object.entries(SAME), ...Object.entries(RENAME)]) {
    const d = byName.get(name);
    if (!d) { console.log(`  · no definition named "${name}" here — ${code} is added as new`); continue; }
    const row = rows.find((r) => r.code === code);
    const input = { shortName: code };
    if (RENAME[name]) input.name = row.name;
    if ((d.short_name ?? '').toUpperCase() === code && !RENAME[name]) console.log(`  = ${d.code} ${d.name}: short name already ${code}`);
    else {
      await updateRecord(db, c, d.id, input);
      console.log(`  ~ ${d.code} ${d.name}: short name ${d.short_name ?? '—'} → ${code}${input.name ? `, renamed "${input.name}"` : ''}`);
    }
    done.add(code);
  }

  // 2. a node per shipping-mark group under Assemblies
  const nodeFor = async (r) => {
    if (r.category === 'Item Master') return isProfile(r) ? profile.id : plate.id;
    if (/SPLICE ASSEMBLIES/.test(r.group) && spliceSet) return spliceSet.id;
    const g = groupNode(r.group);
    let n = nodes.find((x) => x.parent_id === assy.id && x.name.toLowerCase() === g.name.toLowerCase());
    if (!n) {
      const code = nodes.some((x) => x.code.toUpperCase() === g.abbr) ? `SM_${g.abbr}` : g.abbr;
      const made = await createNode(db, c, { parentId: assy.id, code, name: g.name, scope: 'both' });
      n = { id: made.id, code, name: g.name, parent_id: assy.id };
      nodes.push(n);
      console.log(`  + node Assemblies › ${g.name} (${code})`);
    }
    return n.id;
  };

  // 3. the rest: one definition each
  let added = 0, skipped = 0;
  for (const r of rows) {
    if (done.has(r.code) || SKIP.has(r.code)) continue;
    if (byCode.has(r.code)) { skipped++; console.log(`  = ${r.code} already a definition ("${byCode.get(r.code).name}")`); continue; }
    const classificationId = await nodeFor(r);
    const created = await createDefinition(db, c, {
      definitionType: 'template', classificationId, code: r.code, name: r.name, shortName: r.code,
      description: `${r.structure} · ${r.group}`, status: 'active',
    });
    const id = created?.id ?? created?.record?.id;
    const fl = flowId(FLOW_OF(r));
    if (id && fl) await updateRecord(db, c, id, { defaultFlowId: fl });
    const [[st]] = await db.query('SELECT status FROM cf_master_records WHERE id = ?', [id]);
    if (st?.status !== 'active') await setStatus(db, c, id, 'active');
    added++;
    console.log(`  + ${r.code} ${r.name}${fl ? ` · flow ${FLOW_OF(r)}` : ''}`);
  }
  console.log(`\nshort names set: ${done.size} · added: ${added} · already there: ${skipped} · not added: ${[...SKIP].join(', ')}`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback();
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
