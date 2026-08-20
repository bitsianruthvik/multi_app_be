/**
 * derive.mjs — fill in the values the flows' formulas need.
 *
 * Usage: node scripts/kepl/derive.mjs <companyId> <orderId> [--apply]
 *
 * WHY THIS IS A SEPARATE STEP. build.mjs writes what the customer told us: the
 * shape and size of every plate. This writes what follows FROM that — weight,
 * cut perimeter, painted area, weld run, hole count. Keeping the two apart
 * means the derivation can be re-run and argued with without rebuilding the
 * order, and it makes plain which numbers came from the drawing and which
 * came from a rule this repository chose. The rules themselves live in
 * model.mjs so a fabricator can find and change them.
 *
 * Without these values the production gate refuses the order, and forcing past
 * it is worse than it looks: materialisation freezes every formula onto its
 * task, so a missing value does not error, it silently produces a task that
 * takes no time — and the schedule, the critical chain and the promised date
 * are all computed from that.
 */

import { pool } from '../../db.js';
import { HOLES, partDerived, weldMetresFor } from './model.mjs';

const args = process.argv.slice(2);
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const [companyId, orderId] = nums;
const apply = args.includes('--apply');
if (!companyId || !orderId) {
  console.error('Usage: node scripts/kepl/derive.mjs <companyId> <orderId> [--apply]');
  process.exit(1);
}

const KEYS = ['unit_weight_kg', 'edge_length_m', 'surface_area_m2', 'weld_length_m', 'num_holes'];
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const [fields] = await pool.query(
  `SELECT id, field_key, default_unit FROM fab_fields
    WHERE company_id = ? AND deleted_at IS NULL AND active = 1 AND field_key IN (?)`,
  [companyId, KEYS],
);
const fid = Object.fromEntries(fields.map((f) => [f.field_key, f]));
for (const k of KEYS) if (!fid[k]) throw new Error(`field ${k} is not defined for company ${companyId}`);

// Every item of the order, with the geometry build.mjs projected onto columns.
const [items] = await pool.query(
  `SELECT id, parent_item_id, code, name, qty, level_kind, flow_id,
          length AS l, width AS w, height AS t
     FROM fab_items
    WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
    ORDER BY id`,
  [companyId, orderId],
);
const byId = new Map(items.map((i) => [i.id, i]));
const kids = new Map();
for (const i of items) {
  if (i.parent_item_id == null) continue;
  if (!kids.has(i.parent_item_id)) kids.set(i.parent_item_id, []);
  kids.get(i.parent_item_id).push(i);
}

/** `/D` for a drilled part, per the same reading flow routing uses. */
const suffixOf = (code) => {
  const last = String(code ?? '').split('-').pop() ?? '';
  return last.includes('/') ? last.slice(last.indexOf('/')) : null;
};
/** The part-type key the hole table is written against, e.g. 'IS1/D'. */
const partKey = (code) => String(code ?? '').split('-').pop() ?? '';

const values = new Map(); // itemId -> {key: number}
const put = (id, k, v) => {
  if (!values.has(id)) values.set(id, {});
  values.get(id)[k] = v;
};

/**
 * Depth-first, children before parents, so an assembly can add up what is
 * inside it. Recursion is by id rather than by walking `items` in order: the
 * tree is four deep and nothing guarantees a child's id exceeds its parent's
 * once rows have been edited.
 */
let parts = 0; let assemblies = 0; let holed = 0;
function visit(item) {
  const children = (kids.get(item.id) ?? []).filter((c) => c.level_kind !== 'material');
  for (const c of children) visit(c);

  if (item.level_kind === 'part') {
    const l = Number(item.l); const w = Number(item.w); const t = Number(item.t);
    if (!Number.isFinite(l) || !Number.isFinite(w) || !Number.isFinite(t)) return;
    const d = partDerived({ l, w, t });
    put(item.id, 'unit_weight_kg', d.unit_weight_kg);
    put(item.id, 'edge_length_m', d.edge_length_m);
    put(item.id, 'surface_area_m2', d.surface_area_m2);
    if (suffixOf(item.code) === '/D') {
      const n = HOLES[partKey(item.code)];
      if (n == null) throw new Error(`no hole count declared for ${item.code} — add it to HOLES`);
      put(item.id, 'num_holes', n);
      holed++;
    }
    parts++;
    return;
  }

  if (!children.length) return;
  // An assembly's weight and painted area are what is inside it; its weld run
  // is a rule over the same children. All three scale by each child's own qty.
  const sum = (k) => children.reduce(
    (a, c) => a + (values.get(c.id)?.[k] ?? 0) * Number(c.qty || 1), 0,
  );
  put(item.id, 'unit_weight_kg', sum('unit_weight_kg'));
  put(item.id, 'surface_area_m2', sum('surface_area_m2'));
  put(item.id, 'weld_length_m', weldMetresFor(
    children.map((c) => ({ l: Number(c.l) || 0, w: Number(c.w) || 0, qty: Number(c.qty || 1) })),
  ));
  assemblies++;
}
for (const i of items) if (i.parent_item_id == null) visit(i);

const rows = [];
for (const [itemId, vals] of values) {
  for (const [k, v] of Object.entries(vals)) {
    rows.push([companyId, fid[k].id, 'order_item', itemId, Number(v.toFixed(6)), fid[k].default_unit]);
  }
}

console.log(`\nderived for order ${orderId}`);
console.log(`  parts ${parts} (${holed} drilled), assemblies ${assemblies}`);
console.log(`  field values ${rows.length}`);
for (const sample of ['weld_length_m', 'surface_area_m2', 'unit_weight_kg']) {
  const f = fid[sample].id;
  const mine = rows.filter((r) => r[1] === f).map((r) => r[4]);
  if (mine.length) {
    console.log(`  ${sample.padEnd(16)} n=${String(mine.length).padStart(5)}  `
      + `min ${Math.min(...mine).toFixed(2)}  max ${Math.max(...mine).toFixed(2)}`);
  }
}
if (!apply) { console.log('\nNothing written. Re-run with --apply.\n'); await pool.end(); process.exit(0); }

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  // Idempotent: a re-run replaces its own previous answer rather than stacking
  // a second live value beside it, which resolveFields would then pick between.
  await conn.query(
    `UPDATE fab_field_values v
       JOIN fab_items i ON i.id = v.scope_id AND i.order_id = ?
        SET v.deleted_at = NOW()
      WHERE v.company_id = ? AND v.scope = 'order_item' AND v.deleted_at IS NULL
        AND v.field_id IN (?)`,
    [orderId, companyId, KEYS.map((k) => fid[k].id)],
  );
  for (const group of chunk(rows, 900)) {
    await conn.query(
      'INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_num, unit_code) VALUES ?',
      [group],
    );
  }
  await conn.commit();
  console.log('  committed\n');
} catch (err) {
  await conn.rollback();
  console.error(`Rolled back: ${err.message}`);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
