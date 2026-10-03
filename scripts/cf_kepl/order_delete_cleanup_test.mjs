/**
 * order_delete_cleanup_test.mjs — deleting an order line / an order leaves no
 * live nesting, plan or time rows behind.
 *
 *   cd multi_app_be && node scripts/cf_kepl/order_delete_cleanup_test.mjs
 *
 * ONE TRANSACTION, ROLLED BACK, with its own fixtures (nothing borrowed from
 * tenant data but the classification tree and the GRADE / MATERIAL specs).
 * Two throwaway draft orders, each with a small frozen template line that is
 * Quick-nested with the real packer and accepted, with a nest exclusion, a plan
 * entry, a plan rank and a time override:
 *   order 1 — the line is removed with removeOrderLine (unfrozen first, as the
 *             rule demands), then the order is deleted;
 *   order 2 — the order is deleted while its line is still frozen.
 * Then no live row may remain in any line-owned table for those lines/orders.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const S = await imp('apps/cf_erp/services/nestingService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');

const COMPANY = Number(process.env.CF_DELCLEAN_COMPANY ?? 2);
const T = 7.777;
const PLATE_L = 2500;
const PLATE_W = 900;
const PLATE_AREA = PLATE_L * PLATE_W;

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);

const COUNTED = [
  'cf_plate_lots', 'cf_nest_placements', 'cf_offcuts', 'cf_nest_exclusions', 'cf_plan_entries', 'cf_plan_ranks',
  'cf_time_overrides', 'cf_cut_settings', 'cf_master_records', 'cf_item_details', 'cf_boms', 'cf_bom_lines',
  'cf_spec_values', 'cf_spec_options', 'cf_specifications', 'cf_sales_orders', 'cf_sales_order_lines', 'cf_order_pieces',
  'cf_operations',
];
async function counts(db) {
  const out = {};
  for (const t of COUNTED) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}

async function nodeByCode(db, code) {
  const [[n]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (!n) throw new Error(`This company has no ${code} classification node.`);
  return n.id;
}
async function specByCode(db, code, dataType) {
  const [[s]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (s) return s.id;
  const [r] = await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, code, code, dataType]);
  return r.insertId;
}
async function twoOptions(db, specId, tag) {
  const [rows] = await db.query('SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 2', [COMPANY, specId]);
  const out = rows.map((r) => r.id);
  while (out.length < 2) {
    const [r] = await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, 'active')", [COMPANY, specId, `${tag}-${out.length + 1}`]);
    out.push(r.insertId);
  }
  return out;
}
async function makeMaster(db, { code, name, classificationId, itemType, ownerLineId = null }) {
  const [m] = await db.query("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, code, name, classificationId]);
  await db.query(
    "INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id) VALUES (?, ?, ?, 'quantity', 'nos', ?, ?)",
    [m.insertId, COMPANY, itemType, itemType === 'temporary' ? 'make' : 'stock', ownerLineId],
  );
  return m.insertId;
}
async function setVals(db, subjectId, vals) {
  for (const [specId, v] of vals) {
    if (v == null) continue;
    await db.query(
      "INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, option_id, value_bool, source) VALUES (?, ?, 'master', ?, ?, ?, NULL, 'entered')",
      [COMPANY, specId, subjectId, v.kind === 'number' ? v.value : null, v.kind === 'option' ? v.value : null],
    );
  }
}
async function makeBomLine(db, parentId, childId, quantity, lineNo) {
  let [[bom]] = await db.query('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, parentId]);
  if (!bom) {
    const [b] = await db.query("INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, 'custom', 'active')", [COMPANY, parentId]);
    bom = { id: b.insertId };
  }
  const [l] = await db.query('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)', [COMPANY, bom.id, lineNo, childId, childId, lineNo, quantity]);
  return l.insertId;
}

/** Shared catalog: the plate every fixture line is cut from. */
async function buildCatalog(db, tag) {
  const plateNode = await nodeByCode(db, 'PLATE');
  const spec = {
    THICKNESS: await specByCode(db, 'THICKNESS', 'number'), LENGTH: await specByCode(db, 'LENGTH', 'number'),
    WIDTH: await specByCode(db, 'WIDTH', 'number'), GRADE: await specByCode(db, 'GRADE', 'option'),
    MATERIAL: await specByCode(db, 'MATERIAL', 'option'), DENSITY: await specByCode(db, 'DENSITY', 'number'),
  };
  const [gradeA] = await twoOptions(db, spec.GRADE, tag);
  const [matA] = await twoOptions(db, spec.MATERIAL, tag);
  const num = (v) => ({ kind: 'number', value: v });
  const size = (t, l, w) => [
    [spec.THICKNESS, num(t)], [spec.LENGTH, num(l)], [spec.WIDTH, num(w)],
    [spec.GRADE, { kind: 'option', value: gradeA }], [spec.MATERIAL, { kind: 'option', value: matA }], [spec.DENSITY, num(7850)],
  ];
  const plate = await makeMaster(db, { code: `${tag}-P1`, name: 'Delete-cleanup plate 2500x900', classificationId: plateNode, itemType: 'catalog' });
  await setVals(db, plate, size(T, PLATE_L, PLATE_W));
  // Kerf settings of our own so the pack is the same whatever the tenant seeded.
  await db.query('DELETE FROM cf_cut_settings WHERE company_id = ?', [COMPANY]);
  await db.query(
    'INSERT INTO cf_cut_settings (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm, order_margin_length_mm, order_margin_width_mm, guillotine) VALUES (?, NULL, NULL, 2, 5, 8, 100, 50, 0)',
    [COMPANY],
  );
  return { plate, size, spec };
}

/** A draft order with ONE frozen template line: root > cut plates CP1, CP2, CP3 (CP3 gets excluded). */
async function buildOrder(db, cat, tag, label) {
  const cutNode = await nodeByCode(db, 'CUT_PLATE');
  const [o] = await db.query("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, 'customer', ?, 'draft')", [COMPANY, `${tag}-${label}`, `Delete cleanup ${label}`]);
  const orderId = o.insertId;
  const root = await makeMaster(db, { code: `${tag}-${label}-ROOT`, name: `Fixture assembly ${label}`, classificationId: cutNode, itemType: 'temporary' });
  const [l] = await db.query(
    "INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position) VALUES (?, ?, 1, 'custom', ?, ?, 1, 3, NOW(), 1)",
    [COMPANY, orderId, root, root],
  );
  const lineId = l.insertId;
  await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [lineId, COMPANY, root]);
  const cut = async (suffix, len, wid, perUnit, no) => {
    const id = await makeMaster(db, { code: `${tag}-${label}-${suffix}`, name: `Fixture ${label} ${suffix}`, classificationId: cutNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals(db, id, cat.size(T, len, wid));
    await makeBomLine(db, root, id, perUnit, no);
    await makeBomLine(db, id, cat.plate, (len * wid) / PLATE_AREA, 1);
    return id;
  };
  const A = await cut('CP1', 900, 400, 2, 1);
  const B = await cut('CP2', 600, 300, 1, 2);
  const X = await cut('CP3', 500, 500, 1, 3);
  return { orderId, lineId, root, A, B, X };
}

/** Quick nest + accept + exclusion + plan entry/rank + time override. */
async function loadLine(db, c, f, opId, label) {
  await S.saveNestingChoices(db, c, f.lineId, { excludedCutPlateIds: [f.X] });
  // §44: a line's nesting must be told which plates it may use before it runs.
  await db.query("UPDATE cf_sales_order_lines SET nest_plates = 'any' WHERE company_id = ? AND id IN (?)", [COMPANY, [f.lineId]]);
  const plan = await S.planNesting(db, COMPANY, f.lineId, { effort: 'quick', seed: 3 });
  const accepted = await S.acceptNesting(db, c, f.lineId, plan);
  ok(`${label}: the Quick nest was accepted and wrote lots`, Number(accepted.lots) > 0, JSON.stringify(accepted).slice(0, 200));
  await db.query("INSERT INTO cf_plan_entries (company_id, order_line_id, unit_key, ship_date, pinned) VALUES (?, ?, ?, '2030-01-07', 0)", [COMPANY, f.lineId, `l${f.lineId}`]);
  await db.query('INSERT INTO cf_plan_ranks (company_id, order_line_id, unit_key, rank_no) VALUES (?, ?, ?, 1)', [COMPANY, f.lineId, `l${f.lineId}`]);
  await db.query('INSERT INTO cf_time_overrides (company_id, order_line_id, bom_line_id, operation_id, work_minutes) VALUES (?, ?, NULL, ?, 5)', [COMPANY, f.lineId, opId]);
}

const OWNED = [
  ['cf_plate_lots', 'deleted_at'],
  ['cf_offcuts', 'deleted_at'],
  ['cf_nest_exclusions', null],
  ['cf_plan_entries', 'deleted_at'],
  ['cf_plan_ranks', null],
  ['cf_time_overrides', 'deleted_at'],
];
/** Live rows per line-owned table (placements via their lots, temporary items via owner). */
async function live(db, lineId) {
  const out = {};
  for (const [t, del] of OWNED) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE company_id = ? AND order_line_id = ?${del ? ` AND ${del} IS NULL` : ''}`, [COMPANY, lineId]);
    out[t] = Number(r.n);
  }
  const [[p]] = await db.query(
    'SELECT COUNT(*) AS n FROM cf_nest_placements p JOIN cf_plate_lots l ON l.company_id = p.company_id AND l.id = p.plate_lot_id WHERE p.company_id = ? AND l.order_line_id = ? AND p.deleted_at IS NULL',
    [COMPANY, lineId],
  );
  out.cf_nest_placements = Number(p.n);
  const [[m]] = await db.query(
    `SELECT COUNT(*) AS n FROM cf_master_records m JOIN cf_item_details i ON i.company_id = m.company_id AND i.master_id = m.id
      WHERE m.company_id = ? AND i.owner_order_line_id = ? AND m.deleted_at IS NULL`, [COMPANY, lineId]);
  out.temporary_items = Number(m.n);
  const [[b]] = await db.query(
    `SELECT COUNT(*) AS n FROM cf_bom_lines l JOIN cf_boms b ON b.company_id = l.company_id AND b.id = l.bom_id
       JOIN cf_item_details i ON i.company_id = b.company_id AND i.master_id = b.parent_id
      WHERE l.company_id = ? AND i.owner_order_line_id = ? AND l.deleted_at IS NULL`, [COMPANY, lineId]);
  out.bom_lines = Number(b.n);
  return out;
}
const total = (o) => Object.values(o).reduce((a, n) => a + n, 0);

const before = await counts(pool);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };
  const tag = `DC${Date.now().toString(36).toUpperCase()}`;

  section('Fixture');
  const cat = await buildCatalog(conn, tag);
  const [[anyOp]] = await conn.query('SELECT id FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [COMPANY]);
  let opId = anyOp?.id;
  if (!opId) {
    const [r] = await conn.query('INSERT INTO cf_operations (company_id, code, name) VALUES (?, ?, ?)', [COMPANY, `${tag}-OP`, `${tag} op`]);
    opId = r.insertId;
  }
  const o1 = await buildOrder(conn, cat, tag, 'O1');
  const o2 = await buildOrder(conn, cat, tag, 'O2');
  console.log(`  ${tag}: order ${o1.orderId} line ${o1.lineId}; order ${o2.orderId} line ${o2.lineId}`);

  section('1. Line-owned rows exist before the delete');
  await loadLine(conn, c, o1, opId, 'order 1');
  await loadLine(conn, c, o2, opId, 'order 2');
  for (const [label, o] of [['order 1', o1], ['order 2', o2]]) {
    const l = await live(conn, o.lineId);
    ok(`${label}: lots, placements, exclusion, plan entry, rank and override are live`,
      l.cf_plate_lots > 0 && l.cf_nest_placements > 0 && l.cf_nest_exclusions === 1 && l.cf_plan_entries === 1 && l.cf_plan_ranks === 1 && l.cf_time_overrides === 1,
      JSON.stringify(l));
    ok(`${label}: its cut plates are live temporary items`, l.temporary_items >= 4, JSON.stringify(l));
  }

  section('2. The existing rules still refuse');
  let refused = null;
  try { await SO.removeOrderLine(conn, c, o1.lineId); } catch (e) { refused = e; }
  eq('a frozen line cannot be removed (LOCKED)', refused?.code, 'LOCKED');
  ok('and the refusal left the nesting alone', total(await live(conn, o1.lineId)) > 0);

  section('3. removeOrderLine (order 1)');
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL, lock_position = NULL WHERE company_id = ? AND id = ?', [COMPANY, o1.lineId]);
  await SO.removeOrderLine(conn, c, o1.lineId);
  const after1 = await live(conn, o1.lineId);
  for (const [k, v] of Object.entries(after1)) eq(`no live ${k} for the removed line`, v, 0);
  const [[ln]] = await conn.query('SELECT deleted_at FROM cf_sales_order_lines WHERE id = ?', [o1.lineId]);
  ok('the line itself is soft-deleted', ln.deleted_at != null);
  ok('order 2 was not touched', total(await live(conn, o2.lineId)) > 0);

  section('4. deleteOrder (order 1, now empty; order 2, with its frozen line)');
  await SO.deleteOrder(conn, c, o1.orderId);
  await SO.deleteOrder(conn, c, o2.orderId);
  const after2 = await live(conn, o2.lineId);
  for (const [k, v] of Object.entries(after2)) eq(`no live ${k} for the deleted order's line`, v, 0);
  const [[ord]] = await conn.query('SELECT COUNT(*) AS n FROM cf_sales_orders WHERE id IN (?, ?) AND deleted_at IS NULL', [o1.orderId, o2.orderId]);
  eq('both orders are soft-deleted', Number(ord.n), 0);
  const [[lotsByOrder]] = await conn.query(
    `SELECT COUNT(*) AS n FROM cf_plate_lots p JOIN cf_sales_order_lines l ON l.company_id = p.company_id AND l.id = p.order_line_id
      WHERE p.company_id = ? AND l.order_id IN (?, ?) AND p.deleted_at IS NULL`, [COMPANY, o1.orderId, o2.orderId]);
  eq('no live plate lot on either order', Number(lotsByOrder.n), 0);

  await conn.rollback();
  console.log('\nrolled back.');
} catch (err) {
  try { await conn.rollback(); } catch { /* the original error matters */ }
  failed += 1;
  fails.push('the run itself');
  console.error('\nTHREW:', err.code ?? '', err.message);
  if (err.problems) console.error('problems:', JSON.stringify(err.problems));
  console.error(err.stack?.split('\n').slice(1, 6).join('\n'));
} finally {
  detachNodeCache(conn);
  conn.release();
}

section('5. Nothing survived the rollback');
const after = await counts(pool);
const left = COUNTED.filter((t) => before[t] !== after[t]).map((t) => `${t} ${before[t]}->${after[t]}`);
ok('every table it wrote is back to the count it started at', left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
