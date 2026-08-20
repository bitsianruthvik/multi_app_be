/**
 * build.mjs — write the KEPL order into the database.
 *
 * Usage:
 *   node scripts/kepl/build.mjs <companyId>            # dry run, reports only
 *   node scripts/kepl/build.mjs <companyId> --apply    # write
 *
 * WHY BULK INSERTS AND NOT THE SERVICES. setItemMaterial and setFields are the
 * right entry points for a person editing one row, and they are the wrong ones
 * for 1,082 of them: each does five or six round trips and syncOrderProcurement
 * re-classifies the WHOLE order every call, so building this order through them
 * would be about six thousand round trips to TiDB Cloud for a result identical
 * to inserting the rows directly. The order-wide services are called ONCE, at
 * the end, which is the only place their answer can be right anyway.
 *
 * The one thing that must not be skipped is the PROJECTION. fab_items.length /
 * width / height are a cache of the field values, written by setFields; nesting
 * and the weight roll-up read the COLUMNS. Writing fab_field_values alone would
 * leave the columns NULL and silently blind both. Every part row here is
 * inserted with its columns AND its field values — which is exactly the pair
 * setFields would have produced.
 */

import { pool } from '../../db.js';
import {
  SPANS, GIRDERS_PER_SPAN, SEG_KINDS, SEG_LEN, ASSEMBLIES, STUDS,
  RAW_MATERIAL, BOQ_STATED, spanPartRows, rowWeight,
} from './model.mjs';
import { nestAll, utilisation, verify } from './nest.mjs';
import { syncOrderProcurement } from '../../apps/fab_erp/services/procurementService.js';
import { applyFlowRules } from '../../apps/fab_erp/services/flowAllocationService.js';
import { recomputeOrderWeights } from '../../apps/fab_erp/services/itemWeightService.js';
import { checkOrderNesting } from '../../apps/fab_erp/services/nestingIntegrityService.js';

const args = process.argv.slice(2);
const companyId = Number(args.find((a) => /^\d+$/.test(a)));
const apply = args.includes('--apply');
if (!companyId) {
  console.error('Usage: node scripts/kepl/build.mjs <companyId> [--apply]');
  process.exit(1);
}

const ORDER_NUMBER = 'SO-KEPL-ROB60';
const CUSTOMER = 'KEPL';
const CUSTOMER_FULL = 'Kalpataru Engineering Projects Ltd';
const DRAWING = 'P103-VDB-WK-DD-MJB-200+003-401';
const STRUCTURE_TYPE = 'Composite Girder';

const log = (m) => console.log(m);
const chunk = (a, n) => {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

// ── 1. the model, nested before anything is written ─────────────────────────
const rows = [];
for (let s = 1; s <= SPANS; s++) rows.push(...spanPartRows(s));
const { plates, unplaced } = nestAll(rows, RAW_MATERIAL);
const fitProblems = verify(plates);
if (unplaced.length || fitProblems.length) {
  console.error(`Refusing to build: ${unplaced.length} unplaced rows, ${fitProblems.length} fit problems.`);
  for (const u of unplaced.slice(0, 5)) console.error(`  ${u.row.path}/${u.row.code}: ${u.why}`);
  for (const p of fitProblems.slice(0, 5)) console.error(`  ${p}`);
  process.exit(1);
}
const fabKg = rows.reduce((a, r) => a + rowWeight(r), 0);
const studKg = (STUDS.perSpan * SPANS * STUDS.gramsEach) / 1000;

log(`\nKEPL ROB 59.3 m — ${SPANS} spans`);
log(`  part rows ${rows.length}, pieces ${rows.reduce((a, r) => a + r.qty, 0)}`);
log(`  steel ${(fabKg / 1000).toFixed(2)} MT + studs ${(studKg / 1000).toFixed(2)} MT `
  + `= ${((fabKg + studKg) / 1000).toFixed(2)} MT (BOQ says ${BOQ_STATED.totalMt})`);
log(`  nesting ${plates.length} plates, mean utilisation `
  + `${((plates.reduce((a, p) => a + utilisation(p), 0) / plates.length) * 100).toFixed(1)}%`);
if (!apply) {
  log('\nNothing written. Re-run with --apply.\n');
  process.exit(0);
}

// ── 2. write ────────────────────────────────────────────────────────────────
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  const [[existing]] = await conn.query(
    'SELECT id FROM fab_orders WHERE company_id = ? AND order_number = ? AND deleted_at IS NULL',
    [companyId, ORDER_NUMBER],
  );
  if (existing) throw new Error(`${ORDER_NUMBER} already exists (id ${existing.id}). Delete it first.`);

  let [[cust]] = await conn.query(
    'SELECT id FROM fab_customers WHERE company_id = ? AND name = ? AND deleted_at IS NULL',
    [companyId, CUSTOMER_FULL],
  );
  if (!cust) {
    const [[{ n }]] = await conn.query(
      'SELECT COUNT(*) n FROM fab_customers WHERE company_id = ?', [companyId],
    );
    const [r] = await conn.query(
      'INSERT INTO fab_customers (company_id, name, code, notes) VALUES (?,?,?,?)',
      [companyId, CUSTOMER_FULL, `CUST-${String(n + 1).padStart(4, '0')}`, `Drawing ${DRAWING}`],
    );
    cust = { id: r.insertId };
    log(`  customer created (${r.insertId})`);
  }

  const [[plant]] = await conn.query(
    'SELECT id FROM fab_plants WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1',
    [companyId],
  );

  const [ord] = await conn.query(
    `INSERT INTO fab_orders (company_id, order_number, order_type, status, plant_id, customer_id,
       customer_name, customer_po_ref, currency, priority, notes, wizard_step, created_at, updated_at)
     VALUES (?,?, 'sales', 'draft', ?, ?, ?, ?, 'INR', 'high', ?, 'confirm', NOW(), NOW())`,
    [companyId, ORDER_NUMBER, plant?.id ?? null, cust.id, CUSTOMER_FULL, DRAWING,
      `ROB 59.3 m, ${SPANS} spans, 4-girder composite arrangement. Drawing ${DRAWING}.`],
  );
  const orderId = ord.insertId;
  log(`  order ${ORDER_NUMBER} (${orderId})`);

  const lineIds = [];
  for (let s = 1; s <= SPANS; s++) {
    const [r] = await conn.query(
      `INSERT INTO fab_order_lines (company_id, order_id, line_no, code, description, qty, unit,
         status, line_type, created_at, updated_at)
       VALUES (?,?,?,?,?,1,'nos','open',?,NOW(),NOW())`,
      [companyId, orderId, s, `SPAN-${s}`,
        `Span ${s} — 59.3 m composite girder deck, 4 girders x 5 segments`, STRUCTURE_TYPE],
    );
    lineIds[s] = r.insertId;
  }

  /**
   * The tree. Codes are assigned HERE rather than left to
   * generateOrderItemCodes, because flow routing reads them: pickRule takes the
   * text after the last '/' of the last '-' segment, so '…-IS1/D' routes to the
   * drilled flow and '…-IS2' to the plain one. A generated code would be
   * unique and would route everything the same way.
   */
  const prefix = `${CUSTOMER}-ROB60`;
  const pending = [];
  const add = (o) => { pending.push(o); return o.code; };

  for (let s = 1; s <= SPANS; s++) {
    const spanCode = `${prefix}-SPAN${s}`;
    add({ code: spanCode, name: `Span ${s}`, qty: 1, levelKind: 'span', parentCode: null, lineNo: s });

    for (let g = 1; g <= GIRDERS_PER_SPAN; g++) {
      const gCode = `${spanCode}/G${g}`;
      add({ code: gCode, name: `Girder G${g}`, qty: 1, levelKind: 'girder', parentCode: spanCode, lineNo: s });
      SEG_KINDS.forEach((kind, i) => {
        add({ code: `${gCode}/S${i + 1}`, name: `G${g} Segment ${i + 1} (${SEG_LEN[kind]} mm)`,
          qty: 1, levelKind: 'segment', parentCode: gCode, lineNo: s });
      });
    }
    for (const a of ASSEMBLIES) {
      for (let n = 1; n <= a.count; n++) {
        const tag = `${a.kind}${String(n).padStart(2, '0')}`;
        add({ code: `${spanCode}-${tag}`, name: `${a.name} ${n}`, qty: 1,
          levelKind: 'segment', parentCode: spanCode, lineNo: s });
      }
    }
    add({ code: `${spanCode}-STUD`, name: `Shear Stud ${STUDS.diaMm} dia x ${STUDS.lengthMm}`,
      qty: STUDS.perSpan, levelKind: 'part', parentCode: spanCode, lineNo: s,
      l: STUDS.lengthMm, w: STUDS.diaMm, t: STUDS.diaMm });
  }
  for (const r of rows) {
    const spanCode = `${prefix}-SPAN${r.span}`;
    const parent = r.parentKind === 'segment' ? `${spanCode}/${r.path}` : `${spanCode}-${r.path}`;
    r.code = `${parent}-${r.code}`;
    add({ code: r.code, name: r.name, qty: r.qty, levelKind: 'part', parentCode: parent,
      lineNo: r.span, l: r.l, w: r.w, t: r.t });
  }

  /**
   * Parents before children, ONE DEPTH AT A TIME.
   *
   * Sorting by depth and then chunking by size is not enough and failed on the
   * first run: a chunk boundary does not respect the tree, so a girder landed
   * in the same 400-row batch as its span and had nothing to point at. Ids are
   * only known after a batch is read back, so a whole depth has to be inserted
   * and read back before the next one starts.
   *
   * The code's own separator count IS the depth — every child here appends a
   * '/' or '-' to its parent's code, so a child always scores higher than its
   * parent even when siblings differ (…-TF is 5, …-IS1/D is 6, both under a
   * segment at 4).
   */
  const depth = (c) => (c.match(/[/-]/g) ?? []).length;
  const byDepth = new Map();
  for (const p of pending) {
    const d = depth(p.code);
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(p);
  }
  const waves = [...byDepth.keys()].sort((a, b) => a - b).flatMap((d) => chunk(byDepth.get(d), 400));

  const idByCode = new Map();
  for (const group of waves) {
    const vals = [];
    for (const p of group) {
      const parentId = p.parentCode ? idByCode.get(p.parentCode) : null;
      if (p.parentCode && !parentId) throw new Error(`parent ${p.parentCode} not inserted before ${p.code}`);
      vals.push([companyId, orderId, lineIds[p.lineNo], parentId, p.name, 'nos', p.qty,
        p.levelKind, p.code, p.l ?? null, p.w ?? null, p.t ?? null, 'mm', 'kg']);
    }
    await conn.query(
      `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, name, unit, qty,
         level_kind, code, length, width, height, dim_unit, weight_unit) VALUES ?`,
      [vals],
    );
    // Read the ids back BY CODE rather than trusting insertId arithmetic —
    // TiDB allocates auto-increment in per-node batches, so a bulk insert's
    // rows are not reliably contiguous.
    const [back] = await conn.query(
      'SELECT id, code FROM fab_items WHERE company_id = ? AND order_id = ? AND code IN (?)',
      [companyId, orderId, group.map((p) => p.code)],
    );
    for (const b of back) idByCode.set(b.code, b.id);
  }
  log(`  items ${idByCode.size}`);

  const [fields] = await conn.query(
    `SELECT id, field_key, default_unit FROM fab_fields
      WHERE company_id = ? AND deleted_at IS NULL AND active = 1
        AND field_key IN ('length_mm','width_mm','thickness_mm')`,
    [companyId],
  );
  const fid = Object.fromEntries(fields.map((f) => [f.field_key, f]));
  for (const k of ['length_mm', 'width_mm', 'thickness_mm']) {
    if (!fid[k]) throw new Error(`field ${k} is not defined for company ${companyId}`);
  }
  const fv = [];
  for (const p of pending) {
    if (p.l == null) continue;
    const id = idByCode.get(p.code);
    fv.push([companyId, fid.length_mm.id, 'order_item', id, p.l, fid.length_mm.default_unit]);
    fv.push([companyId, fid.width_mm.id, 'order_item', id, p.w, fid.width_mm.default_unit]);
    fv.push([companyId, fid.thickness_mm.id, 'order_item', id, p.t, fid.thickness_mm.default_unit]);
  }
  for (const group of chunk(fv, 900)) {
    await conn.query(
      'INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_num, unit_code) VALUES ?',
      [group],
    );
  }
  log(`  field values ${fv.length}`);

  const [cat] = await conn.query(
    `SELECT id, code, name, thickness_mm FROM fab_item_catalog
      WHERE company_id = ? AND deleted_at IS NULL AND name LIKE 'MS Plate%' AND thickness_mm IS NOT NULL`,
    [companyId],
  );
  const plateByT = new Map(cat.map((c) => [Number(c.thickness_mm), c]));
  for (const t of new Set(rows.map((r) => r.t))) {
    if (!plateByT.has(t)) throw new Error(`no MS Plate ${t}mm in the catalog`);
  }

  /**
   * Studs are bought whole, so their "material" is themselves — and their link
   * carries NO SIZE, which is the opposite of what it first did.
   *
   * A length and width on a material link mean "the plate this is cut from",
   * and procurement matches stock against them size for size. Putting the
   * stud's own 175 x 25 there declared a sized draw, so 14,424 studs delivered
   * as one counted lot satisfied nothing and the order read as short of the
   * very thing standing in the yard. A stud is counted, not measured; leaving
   * the size null is what says so, and the shortfall then falls back to the
   * catalog-level comparison, which is the right question for a fastener.
   */
  let [[stud]] = await conn.query(
    `SELECT id, code, name FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL
       AND name LIKE 'Shear Stud%' LIMIT 1`,
    [companyId],
  );
  if (!stud) {
    const [[likeRm]] = await conn.query(
      'SELECT category_id, group_id, subgroup_id FROM fab_item_catalog WHERE id = ?',
      [plateByT.get(28).id],
    );
    const [[{ n }]] = await conn.query(
      'SELECT COUNT(*) n FROM fab_item_catalog WHERE company_id = ?', [companyId],
    );
    const code = `RM26SS${String(n + 1).padStart(5, '0')}`;
    const name = `Shear Stud ${STUDS.diaMm} dia x ${STUDS.lengthMm} (headed)`;
    const [r] = await conn.query(
      `INSERT INTO fab_item_catalog (company_id, code, name, category_id, group_id, subgroup_id,
         procurement_type, mrp_policy) VALUES (?,?,?,?,?,?, 'buy', 'lot_for_lot')`,
      [companyId, code, name, likeRm?.category_id ?? null, likeRm?.group_id ?? null,
        likeRm?.subgroup_id ?? null],
    );
    stud = { id: r.insertId, code, name };
    log(`  catalog: created ${code}`);
  }

  const platesByNo = new Map(plates.map((p) => [p.no, p]));
  const links = [];
  for (const r of rows) {
    const plate = platesByNo.get(r.nest);
    const mat = plateByT.get(r.t);
    links.push([companyId, orderId, lineIds[r.span], idByCode.get(r.code), mat.id, mat.name, 'nos',
      1, plate.spec.l, plate.spec.w, plate.spec.t, `${r.code}-${mat.code}`, r.nest, 'material', 'mm', 'kg']);
  }
  for (let s = 1; s <= SPANS; s++) {
    const code = `${prefix}-SPAN${s}-STUD`;
    links.push([companyId, orderId, lineIds[s], idByCode.get(code), stud.id, stud.name, 'nos',
      STUDS.perSpan, null, null, null,
      `${code}-${stud.code}`, null, 'material', 'mm', 'kg']);
  }
  for (const group of chunk(links, 400)) {
    await conn.query(
      `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
         name, unit, qty, length, width, height, code, nest_no, level_kind, dim_unit, weight_unit)
       VALUES ?`,
      [group],
    );
  }
  log(`  material links ${links.length}`);

  await syncOrderProcurement(conn, companyId, orderId);
  await conn.commit();
  log('  committed');

  // ── 3. order-wide services, now that every row exists ─────────────────────
  const flow = await applyFlowRules(companyId, orderId);
  log(`  flows: ${flow.byFlow.map((f) => `${f.flow} ${f.count}`).join(', ')} (no rule: ${flow.noRule})`);
  await recomputeOrderWeights(companyId, orderId);

  const nest = await checkOrderNesting(companyId, orderId);
  log(`\n  nesting check: ${nest.ok ? 'CLEAN' : JSON.stringify(nest.summary)} (${nest.checked} links)`);
  for (const i of nest.issues.slice(0, 8)) log(`    ${i.type}: ${i.message}`);
  log(`\n  orderId ${orderId}\n`);
} catch (err) {
  await conn.rollback().catch(() => {});
  console.error(`\nRolled back — nothing written: ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
