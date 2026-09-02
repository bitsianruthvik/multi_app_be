/**
 * kepl-parameters.mjs — reconcile the KEPL order to its BOQ, then fill in the
 * geometry.
 *
 * The order was built from the Span template, which gives every segment the
 * same seven parts. The BOQ does not: an END segment (x-1, x-5) carries bearing
 * stiffeners and an End Stiffener, a MIDDLE segment (x-2/3/4) has five parts and
 * no stiffener pair at all. So this does three things, in order:
 *
 *   1. add the parts the BOQ has and the order lacks
 *   2. remove the parts the order has and the BOQ does not
 *   3. write thickness / length / width / qty onto what remains
 *
 * Geometry goes through `setFields`, never the columns. `fab_items.length/width/
 * height` are a PROJECTION of the field values (fieldProjection.js); writing the
 * column directly sets the copy without the thing it is copied from, and the
 * field system never sees the dimension. `height` is thickness — it has always
 * held thickness, whatever its name suggests.
 *
 * TWO PLACES THE SOURCE DOCUMENT CONTRADICTS ITSELF, both reported rather than
 * silently patched:
 *
 *   G2-2  labels two rows "Intermediate Stiffener Hole". Their widths (178, 170)
 *         match the Hole/Plain split used in the other 19 segments, so width
 *         decides and the 170 is read as Plain.
 *   G4-1  and G4-5 carry two "End Stiffener" rows, 210 and 200 wide, where every
 *         other end segment has Bearing Stiffener Plain at 200 wide. The 210 is
 *         read as the bearing stiffener it sits in the place of.
 *
 * Both spans get the same figures: the BOQ details one span and doubles the
 * weight at the bottom.
 *
 *   node scripts/kepl-parameters.mjs <parsed.json>            # report
 *   node scripts/kepl-parameters.mjs <parsed.json> --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const SRC = process.argv[2];
if (!SRC || SRC.startsWith('--')) { console.error('usage: kepl-parameters.mjs <parsed.json> [--apply]'); process.exit(1); }

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

const COMPANY = 30005;
const boq = JSON.parse(fs.readFileSync(SRC, 'utf8'));

/** BOQ part name -> catalog item name. */
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

/**
 * Resolve one BOQ row to a catalog part name, disambiguating the two places the
 * sheet repeats a name inside one segment. Width decides, because it is the
 * thing that stays consistent across the other nineteen segments.
 */
function resolveName(mark, row, seenInSegment) {
  const base = NAME_MAP.get(row.name.toLowerCase().trim());
  if (!base) return null;

  if (base === 'Intermediate Stiffener Hole' && seenInSegment.has(base)) {
    notes.push(`${mark}: second "Intermediate Stiffener Hole" at ${row.width} wide read as Plain (the sheet repeats the name; width matches Plain in all 19 other segments)`);
    return 'Intermediate Stiffener Plain';
  }
  if (base === 'End Stiffener' && seenInSegment.has(base)) {
    notes.push(`${mark}: second "End Stiffener" at ${row.width} wide — kept as End Stiffener`);
    return 'End Stiffener';
  }
  // G4's 210-wide End Stiffener sits where every other end segment has a
  // Bearing Stiffener Plain, and G4 has no Plain row of its own.
  if (base === 'End Stiffener' && Number(row.width) === 210 && Number(row.qty) === 1) {
    notes.push(`${mark}: "End Stiffener" 210 wide x1 read as Bearing Stiffener Plain (the slot it occupies in every other end segment)`);
    return 'Bearing Stiffener Plain';
  }
  return base;
}

/** mark -> [{name, thickness, length, width, qty}] */
const wanted = new Map();
for (const s of boq.segments) {
  const seen = new Set();
  const list = [];
  for (const row of s.parts) {
    const name = resolveName(s.mark, row, seen);
    if (!name) { notes.push(`${s.mark}: unmapped BOQ part "${row.name}" — skipped`); continue; }
    seen.add(NAME_MAP.get(row.name.toLowerCase().trim()));
    list.push({ name, thickness: row.thickness, length: row.length, width: row.width, qty: row.qty });
  }
  wanted.set(s.mark, list);
}

// ── the order ───────────────────────────────────────────────────────────────
const [[order]] = await pool.query(
  `SELECT id, order_number FROM fab_orders
    WHERE company_id = ? AND deleted_at IS NULL AND order_type = 'sales'
    ORDER BY id DESC LIMIT 1`, [COMPANY]);
console.log(`order ${order.order_number} (#${order.id})\n`);

const [segments] = await pool.query(
  `SELECT id, code, name, depth FROM fab_items
    WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
      AND node_kind = 'structure' AND depth = 2 ORDER BY code`, [COMPANY, order.id]);
const [parts] = await pool.query(
  `SELECT id, code, name, parent_item_id AS parentId, qty FROM fab_items
    WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
      AND node_kind = 'structure' AND depth = 3 ORDER BY code`, [COMPANY, order.id]);

const partsBySegment = new Map();
for (const p of parts) {
  if (!partsBySegment.has(p.parentId)) partsBySegment.set(p.parentId, []);
  partsBySegment.get(p.parentId).push(p);
}

/** `…-SPAN1-G1-1` -> `G1-1` */
const markOf = (code) => (code.match(/(G\d)-(\d)$/) ? `${RegExp.$1}-${RegExp.$2}` : null);

const [catalog] = await pool.query(
  `SELECT id, name, unit FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL`, [COMPANY]);
const catByName = new Map(catalog.map((c) => [c.name, c]));

const plan = { add: [], remove: [], update: [], missingType: new Set() };

for (const seg of segments) {
  const mark = markOf(seg.code);
  const want = wanted.get(mark);
  if (!want) { notes.push(`order segment ${seg.code} has no BOQ mark — left alone`); continue; }

  const have = partsBySegment.get(seg.id) ?? [];
  const haveByName = new Map(have.map((p) => [p.name, p]));
  const wantNames = new Set(want.map((w) => w.name));

  for (const w of want) {
    const existing = haveByName.get(w.name);
    if (existing) plan.update.push({ item: existing, seg, spec: w });
    else {
      if (!catByName.has(w.name)) plan.missingType.add(w.name);
      plan.add.push({ seg, spec: w });
    }
  }
  for (const p of have) if (!wantNames.has(p.name)) plan.remove.push({ item: p, seg });
}

console.log(`plan: +${plan.add.length} parts, -${plan.remove.length} parts, ${plan.update.length} updated`);
if (plan.missingType.size) console.log(`catalog types to create: ${[...plan.missingType].join(', ')}`);
const removedNames = {};
for (const r of plan.remove) removedNames[r.item.name] = (removedNames[r.item.name] ?? 0) + 1;
console.log('removed:', JSON.stringify(removedNames));
const addedNames = {};
for (const a of plan.add) addedNames[a.spec.name] = (addedNames[a.spec.name] ?? 0) + 1;
console.log('added:  ', JSON.stringify(addedNames));

console.log(`\nnotes from the source document (${notes.length}):`);
for (const n of [...new Set(notes)]) console.log('  -', n);

if (!APPLY) { console.log('\nDRY RUN — pass --apply to write.'); await pool.end(); process.exit(0); }

// ── apply ───────────────────────────────────────────────────────────────────
const conn = await pool.getConnection();
await conn.beginTransaction();
try {
  // 1. any catalog type the BOQ needs and the catalog lacks
  const [[girderCat]] = await conn.query(
    `SELECT id FROM fab_item_categories WHERE company_id = ? AND name = 'Composite Girder' AND deleted_at IS NULL`,
    [COMPANY]);
  for (const name of plan.missingType) {
    const [r] = await conn.query(
      `INSERT INTO fab_item_catalog (company_id, code, name, unit, category_id, procurement_type, created_at)
       VALUES (?,?,?,'nos',?,'make',NOW())`,
      [COMPANY, `COMPOS-${name.split(' ').map((w) => w[0]).join('').toUpperCase()}`, name, girderCat?.id ?? null]);
    catByName.set(name, { id: r.insertId, name, unit: 'nos' });
    console.log(`  created catalog item ${name} (#${r.insertId})`);
  }

  // 2. remove parts the BOQ does not have
  if (plan.remove.length) {
    const ids = plan.remove.map((r) => r.item.id);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await conn.query(
        `UPDATE fab_items SET deleted_at = NOW() WHERE company_id = ? AND id IN (${chunk.map(() => '?').join(',')})`,
        [COMPANY, ...chunk]);
    }
    console.log(`  removed ${ids.length} parts not in the BOQ`);
  }

  // 3. add parts the BOQ has and the order lacks
  for (const a of plan.add) {
    const cat = catByName.get(a.spec.name);
    const abbr = a.spec.name.split(' ').map((w) => w[0]).join('').toUpperCase();
    const [r] = await conn.query(
      `INSERT INTO fab_items
         (company_id, order_id, order_line_id, parent_item_id, catalog_item_id, name, unit, qty,
          code, node_kind, depth, is_leaf, procurement_type, flow_id, created_at)
       SELECT ?,?, p.order_line_id, p.id, ?, ?, 'nos', ?, CONCAT(p.code, '-', ?), 'structure', 3, 1, 'make',
              (SELECT b.default_flow_id FROM fab_item_bom b
                WHERE b.company_id = ? AND b.parent_item_id = p.catalog_item_id
                  AND b.child_item_id = ? AND b.deleted_at IS NULL AND b.active = 1 LIMIT 1),
              NOW()
         FROM fab_items p WHERE p.id = ? AND p.company_id = ?`,
      [COMPANY, order.id, cat?.id ?? null, a.spec.name, a.spec.qty, abbr, COMPANY, cat?.id ?? null, a.seg.id, COMPANY]);
    a.newId = r.insertId;
  }
  if (plan.add.length) console.log(`  added ${plan.add.length} parts`);

  // 4. geometry + qty onto every part the BOQ describes
  let dimsWritten = 0; const rejects = [];
  const all = [
    ...plan.update.map((u) => ({ id: u.item.id, spec: u.spec })),
    ...plan.add.map((a) => ({ id: a.newId, spec: a.spec })),
  ];
  for (const { id, spec } of all) {
    if (!id) continue;
    await conn.query('UPDATE fab_items SET qty = ? WHERE id = ? AND company_id = ?', [spec.qty, id, COMPANY]);
    const { rejected } = await setFields(COMPANY, 'order_item', id, {
      thickness_mm: spec.thickness, length_mm: spec.length, width_mm: spec.width,
    }, conn);
    for (const rej of rejected) rejects.push(`${id}: ${rej.fieldKey} — ${rej.why}`);
    dimsWritten++;
  }
  console.log(`  wrote geometry to ${dimsWritten} parts`);
  if (rejects.length) { console.log('  REJECTED:'); for (const r of [...new Set(rejects)].slice(0, 10)) console.log('   ', r); }

  await conn.commit();
} catch (err) {
  await conn.rollback();
  console.error('\nFAILED, rolled back:', err.message);
  await pool.end();
  process.exit(1);
} finally {
  conn.release();
}

// 5. weights roll up from the leaves once the geometry is in
const w = await recomputeOrderWeights(COMPANY, order.id);
console.log(`\nweights recomputed: ${JSON.stringify(w)}`);

const [[tot]] = await pool.query(
  `SELECT COUNT(*) parts, ROUND(SUM(total_weight)/1000, 2) tonnes
     FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
      AND node_kind = 'structure' AND depth = 3`, [COMPANY, order.id]);
console.log(`order now: ${tot.parts} parts, ${tot.tonnes} t`);
await pool.end();
