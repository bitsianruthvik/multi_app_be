/**
 * kepl-geometry.mjs — put the BOQ's sizes onto a freshly built KEPL order.
 *
 * The BOM gives every segment the same eight parts, because a BOM line cannot
 * say that a middle segment has no bearing or end stiffeners. The BOQ can, and
 * does. So this reconciles the two: quantities and sizes where the BOQ has the
 * part, deletion where it does not.
 *
 * THE MARK CHANGED. The BOQ writes "G1 - 1"; the order now writes L11, because
 * the customer marks a girder L1 and its first segment L11. Mapping G{g}-{s} to
 * L{g}{s} is the whole translation, and it is done here rather than by renaming
 * anything — the sheet is theirs and stays as they sent it.
 *
 * Geometry goes through `setFields`, never the columns: length/width/height on
 * fab_items are a PROJECTION of the field values, so writing the column sets the
 * copy without the thing it is copied from.
 *
 *   node scripts/kepl-geometry.mjs <orderId> <boq.json> <extras.json> [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const [orderIdArg, boqPath, extrasPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const orderId = Number(orderIdArg);

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});
const { pool } = await import('../db.js');
const { setFields } = await import('../apps/fab_erp/services/fieldService.js');
const { recomputeOrderWeights } = await import('../apps/fab_erp/services/itemWeightService.js');
const { recomputeItemShape } = await import('../apps/fab_erp/services/itemShapeService.js');

const COMPANY = 30005;
const boq = JSON.parse(fs.readFileSync(boqPath, 'utf8'));
const extras = JSON.parse(fs.readFileSync(extrasPath, 'utf8'));

/** BOQ part name -> catalogue name, with the sheet's two ambiguities resolved. */
const NAME_MAP = new Map(Object.entries({
  'top flange': 'Top Flange',
  web: 'Web Plate',
  'bottom flange': 'Bottom Flange',
  'bearing stiffener plain': 'Bearing Stiffener Plain',
  'bearing stiffener hole': 'Bearing Stiffener Hole',
  'end stiffener': 'End Stiffener',
  'intermediate stiffener plain': 'Intermediate Stiffener Plain',
  'intermediate stiffener hole': 'Intermediate Stiffener Hole',
}));
const notes = [];
function resolveName(mark, row, seen) {
  const base = NAME_MAP.get(row.name.toLowerCase().trim());
  if (!base) return null;
  if (base === 'Intermediate Stiffener Hole' && seen.has(base)) {
    notes.push(`${mark}: second "Intermediate Stiffener Hole" at ${row.width} wide read as Plain`);
    return 'Intermediate Stiffener Plain';
  }
  if (base === 'End Stiffener' && !seen.has(base) && Number(row.width) === 210 && Number(row.qty) === 1) {
    notes.push(`${mark}: "End Stiffener" 210 wide x1 read as Bearing Stiffener Plain`);
    return 'Bearing Stiffener Plain';
  }
  return base;
}

/** mark ("G1-1") -> the parts the BOQ actually puts on it. */
const wanted = new Map();
for (const s of boq.segments) {
  const seen = new Set();
  const list = [];
  for (const row of s.parts) {
    const name = resolveName(s.mark, row, seen);
    if (!name) continue;
    seen.add(NAME_MAP.get(row.name.toLowerCase().trim()));
    list.push({ name, thickness: row.thickness, length: row.length, width: row.width, qty: row.qty });
  }
  wanted.set(s.mark, list);
}

/** BOQ code -> the catalogue item, for the diaphragm and splice parts. */
const EXTRA_MAP = {
  EDTF: 'End Diaphragm Top Flange', EDW: 'End Diaphragm Web', EDBF: 'End Diaphragm Bottom Flange',
  JS: 'End Diaphragm Joint Stiffener', PP: 'End Diaphragm Packing Plate',
  IDTF: 'Interm Diaphragm Top Flange', IDW: 'Interm Diaphragm Web', IDDW: 'Interm Diaphragm Diagonal Web',
  IDBF: 'Interm Diaphragm Bottom Flange', ISP: 'Interm Diaphragm Side Plate',
  IFP: 'Interm Diaphragm Fill Plate', ICP: 'Interm Diaphragm Corner Plate',
  WCP: 'Web Cover Plate', TFICP: 'Top Flange Inner Cover Plate', TFOCP: 'Top Flange Outer Cover Plate',
  BFOCP: 'Bottom Flange Outer Cover Plate', BFICP: 'Bottom Flange Inner Cover Plate',
};
const extraByName = new Map();
for (const p of extras.parts) {
  const n = EXTRA_MAP[p.code];
  if (n) extraByName.set(n, p);
}

// ── the order as built ─────────────────────────────────────────────────────
const [segments] = await pool.query(
  `SELECT id, code FROM fab_items WHERE company_id=? AND order_id=? AND deleted_at IS NULL
     AND depth=2 AND node_kind='structure' AND code REGEXP 'L[0-9]+$' ORDER BY code`, [COMPANY, orderId]);
const [parts] = await pool.query(
  `SELECT id, code, name, parent_item_id AS parentId, qty FROM fab_items
    WHERE company_id=? AND order_id=? AND deleted_at IS NULL AND depth=3 AND node_kind='structure'`,
  [COMPANY, orderId]);
const [extraRows] = await pool.query(
  `SELECT id, code, name FROM fab_items WHERE company_id=? AND order_id=? AND deleted_at IS NULL
     AND depth=2 AND node_kind='structure' AND code NOT REGEXP 'L[0-9]+$'`, [COMPANY, orderId]);

const byParent = new Map();
for (const p of parts) {
  if (!byParent.has(p.parentId)) byParent.set(p.parentId, []);
  byParent.get(p.parentId).push(p);
}
/** `…-SPAN1-L11` -> `G1-1` */
const markOf = (code) => {
  const m = code.match(/L(\d)(\d)$/);
  return m ? `G${m[1]}-${m[2]}` : null;
};

const plan = { update: [], remove: [], missing: [] };
for (const seg of segments) {
  const mark = markOf(seg.code);
  const want = wanted.get(mark);
  if (!want) { notes.push(`segment ${seg.code} has no BOQ mark ${mark}`); continue; }
  const have = byParent.get(seg.id) ?? [];
  const wantByName = new Map(want.map((w) => [w.name, w]));
  for (const p of have) {
    const w = wantByName.get(p.name);
    if (w) plan.update.push({ id: p.id, spec: w });
    else plan.remove.push({ id: p.id, name: p.name, seg: seg.code });
  }
  for (const w of want) if (!have.some((p) => p.name === w.name)) plan.missing.push(`${mark}: ${w.name}`);
}
for (const e of extraRows) {
  const spec = extraByName.get(e.name);
  if (spec) plan.update.push({ id: e.id, spec: { thickness: spec.thickness, length: spec.dimA, width: spec.dimB, qty: spec.qty } });
  else plan.missing.push(`extra part with no BOQ row: ${e.name}`);
}

console.log(`segments ${segments.length} · girder parts ${parts.length} · diaphragm/splice parts ${extraRows.length}`);
console.log(`plan: ${plan.update.length} sized, ${plan.remove.length} removed (not on that mark), ${plan.missing.length} missing`);
const rm = {}; for (const r of plan.remove) rm[r.name] = (rm[r.name] ?? 0) + 1;
console.log('removed:', JSON.stringify(rm));
if (plan.missing.length) console.log('missing:', [...new Set(plan.missing)].slice(0, 8).join(' · '));
console.log(`\nnotes (${new Set(notes).size}):`);
for (const n of [...new Set(notes)].slice(0, 6)) console.log('  -', n);

if (!APPLY) { console.log('\nDRY RUN — pass --apply to write.'); await pool.end(); process.exit(0); }

if (plan.remove.length) {
  const ids = plan.remove.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const c = ids.slice(i, i + 500);
    await pool.query(`UPDATE fab_items SET deleted_at=NOW() WHERE company_id=? AND id IN (${c.map(() => '?').join(',')})`, [COMPANY, ...c]);
  }
  console.log(`removed ${ids.length} parts the BOQ does not put on those marks`);
}

let n = 0;
for (const u of plan.update) {
  await pool.query('UPDATE fab_items SET qty=? WHERE id=? AND company_id=?', [u.spec.qty, u.id, COMPANY]);
  await setFields(COMPANY, 'order_item', u.id, {
    thickness_mm: u.spec.thickness, length_mm: u.spec.length, width_mm: u.spec.width,
  });
  if ((++n % 100) === 0) console.log(`  ${n}/${plan.update.length}`);
}
console.log(`sized ${n} parts`);

await recomputeItemShape(COMPANY, orderId);
const w = await recomputeOrderWeights(COMPANY, orderId);
console.log(`weights: ${JSON.stringify(w)}`);
const [[t]] = await pool.query(
  `SELECT ROUND(SUM(total_weight)/1000,2) t FROM fab_items
    WHERE company_id=? AND order_id=? AND deleted_at IS NULL AND depth=0`, [COMPANY, orderId]);
console.log(`order total: ${t.t} t   (BOQ says 669.29 t for 2 spans)`);
await pool.end();
