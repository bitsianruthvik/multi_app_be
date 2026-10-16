/**
 * inventory_v2_test.mjs — Inventory v2 (init.sql §67, 2026-10-16): the Stock
 * screen, scrap and kerf, the owner on every ledger row, one record per piece.
 *
 *   cd multi_app_be && node scripts/cf_kepl/inventory_v2_test.mjs
 *   CF_INV_COMPANY=2 (default) — local only; one transaction, rolled back.
 *
 * Hand-built releases (TEST-INV-… orders), so every number is known:
 *   Plate P 2000 × 1000 × 10 mm = 157 kg. Cut piece CP 30 kg (500 × 500). Part A 30 kg.
 *   R1  our order, our plate (₹1,570 = ₹10/kg)       L1 ← A1 (2) ← CP1 (2), nest N1: 2 × CP1 + offcut 20 kg
 *   R2  customer B's order, B's plate (ref ₹1,256 = ₹8/kg)   L2 ← A2 (2) ← CP2 (2), nest N2 (B's)
 *   R3a / R3b  our plates, cut alone — the same cut with 2 pieces / 6 pieces + 3 offcuts (round trips)
 *   Kerf: N1 stores cutLength 4,000 mm and kerf 3 mm → 12,000 mm² × 10 mm × 7,850 = 0.942 kg.
 *   Scrap = 157 − 60 − 20 − 0.942 = 76.058 kg.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createOrder, addOrderLine, setOrderStatus } from '../../apps/cf_erp/services/salesOrderService.js';
import { createItem } from '../../apps/cf_erp/services/masterRecordService.js';
import { postMovement, reverseMovement, checkLedger, listMovements } from '../../apps/cf_erp/services/stockService.js';
import { ledgerOnSteps, WIP_AREA_CODE } from '../../apps/cf_erp/services/productionLedgerService.js';
import { stockFinished } from '../../apps/cf_erp/services/releaseService.js';
import { shipLine } from '../../apps/cf_erp/services/dispatchService.js';
import { receiveCustomerMaterial, returnToCustomer, materialReconciliation } from '../../apps/cf_erp/services/ownershipService.js';
import { stockView, stockViewLots } from '../../apps/cf_erp/services/stockViewService.js';
import { listUnits, unitHistory, checkUnits, syncUnits } from '../../apps/cf_erp/services/unitService.js';
import { setScrapRate, scrapRate, listLosses, SCRAP_ITEM_CODE } from '../../apps/cf_erp/services/scrapService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_INV_COMPANY ?? 2);
const tag = `TEST-INV-${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const section = (s) => console.log(`\n${s}`);
const near = (a, b, tol = 0.02) => a != null && Math.abs(Number(a) - Number(b)) <= tol;
const J = (x) => JSON.stringify(x);

/** Counts the round trips made through it (a Proxy; the transaction rides on the connection). */
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, {
    get: (target, prop) => (prop === 'query' || prop === 'execute'
      ? (...args) => { tally.n += 1; return target[prop](...args); }
      : Reflect.get(target, prop)),
  });
  return { db: proxy, tally };
}

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();
const example = {};

try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, isAdmin: true };
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN ('sales_order', 'stock_movement', 'stock_lot', 'stock_batch')", [COMPANY]);
  // A clean slate for what this suite reads company-wide: no scrap rate yet.
  await db.query('UPDATE cf_company_settings SET scrap_rate_per_kg = NULL WHERE company_id = ?', [COMPANY]);

  // ---- fixture ---------------------------------------------------------------------
  const node = (parentId, depth, key) => ins("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key}`]);
  const family = await node(null, 0, 'F');
  const sub = await node(family, 1, 'S');
  const variant = await node(sub, 2, 'V');
  const otherVariant = await node(sub, 2, 'W');
  const [[cutNode]] = await db.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'CUT_PLATE' AND deleted_at IS NULL", [COMPANY]);
  const catalog = async (key, extra = {}) => (await createItem(db, c, { classificationId: variant, code: `${tag}-${key}`, name: `${tag} ${key}`, status: 'active', ...extra })).id;
  const P = await catalog('PLATE');
  const BOLT = await catalog('BOLT');
  const HB = await catalog('HEAT', { trackedBy: 'batch' });
  const OTHER = (await createItem(db, c, { classificationId: otherVariant, code: `${tag}-OTHER`, name: `${tag} other`, status: 'active' })).id;
  const temp = async (key, classId) => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, `${tag}-${key}`, `${tag} ${key}`, classId]);
    await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'temporary', 'individual', 'nos', 'make')", [id, COMPANY]);
    return id;
  };
  const [[wSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL", [COMPANY]);
  const weigh = (id, kg) => db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, ?, 'entered')", [COMPANY, wSpec.id, id, kg]);
  await weigh(P, 157); await weigh(BOLT, 0.5); await weigh(HB, 100); await weigh(OTHER, 1);
  const store = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')", [COMPANY, `${tag}-ST`, `${tag} store`]);
  const disp = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'dispatch', 'active')", [COMPANY, `${tag}-DS`, `${tag} dispatch`]);
  // Ours: 4 plates at ₹1,570 (₹10/kg), bolts, a lot of a batch item, something elsewhere in the tree.
  await postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId: P, quantity: 4, unitCost: 1570 }, { itemId: BOLT, quantity: 10, unitCost: 5 }, { itemId: OTHER, quantity: 3, unitCost: 1 }] });
  await postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId: HB, quantity: 2, unitCost: 900, batch: { code: `${tag}-H1` } }] });
  const party = (key) => ins("INSERT INTO cf_parties (company_id, code, name, is_customer, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${tag}-${key}`, `${tag} ${key}`]);
  const CUSA = await party('CUSA');
  const CUSB = await party('CUSB');
  const fg = await catalog('FG');
  const [[flow]] = await db.query('SELECT id FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [COMPANY]);
  const [[op]] = await db.query('SELECT id FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [COMPANY]);
  const orderFor = async (customer, key) => {
    const so = await createOrder(db, c, { orderType: 'customer', customerId: customer, code: `${tag}-${key}`, committedDate: '2099-12-31' });
    await addOrderLine(db, c, so.id, { recordId: fg, quantity: 1 });
    await setOrderStatus(db, c, so.id, 'confirmed');
    return so;
  };
  const newLine = async (so, itemId) => {
    await addOrderLine(db, c, so.id, { recordId: fg, quantity: 1 }).catch(() => null);
    const lineId = (await db.query('SELECT id FROM cf_sales_order_lines WHERE order_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [so.id]))[0][0].id;
    // The line sells the piece the release makes (so it ships as that piece).
    await db.query('UPDATE cf_sales_order_lines SET item_id = ? WHERE id = ?', [itemId, lineId]);
    return lineId;
  };
  const SOA = await orderFor(CUSA, 'SOA');
  const SOB = await orderFor(CUSB, 'SOB');
  // B supplies one plate for SOB: their lot, reference ₹1,256 (₹8/kg).
  const recB = await receiveCustomerMaterial(db, c, { orderId: SOB.id, toAreaId: store, lines: [{ itemId: P, quantity: 1, unitCost: 1256 }] });
  const lotB = recB.lines[0].batch.id;

  let sort = 0;
  const step = (item, seq, qty, name) => ins('INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, step_name, quantity) VALUES (?, ?, ?, ?, ?, ?)', [COMPANY, item, op.id, seq, name, qty]);
  const pi = (rel, parent, item, qty, code, depth) => ins('INSERT INTO cf_production_items (company_id, release_id, parent_id, item_id, quantity, code, flow_id, depth, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, rel, parent, item, qty, `${tag}-${code}`, flow.id, depth, sort++]);
  const dep = (s, target, required) => ins("INSERT INTO cf_step_dependencies (company_id, step_id, target_step_id, required, origin) VALUES (?, ?, ?, ?, 'rule')", [COMPANY, s, target, required]);
  const plateLot = (lineId, no, owner, { kerf = null, waste = null } = {}) => ins(
    "INSERT INTO cf_plate_lots (company_id, order_line_id, plate_item_id, lot_no, thickness_mm, length_mm, width_mm, density, source, kerf_mm, waste_json, owner_party_id) VALUES (?, ?, ?, ?, 10, 2000, 1000, 7850, 'catalog', ?, ?, ?)",
    [COMPANY, lineId, P, no, kerf, waste ? J(waste) : null, owner]);
  const place = (lot, cp, pos) => db.query('INSERT INTO cf_nest_placements (company_id, plate_lot_id, cut_plate_id, pos_no, x_mm, y_mm, length_mm, width_mm) VALUES (?, ?, ?, ?, 0, 0, 500, 500)', [COMPANY, lot, cp, pos]);
  const offcut = (lineId, lot, no, kg, owner) => ins("INSERT INTO cf_offcuts (company_id, order_line_id, plate_lot_id, offcut_no, thickness_mm, grade, material, area_mm2, weight_kg, status, owner_party_id) VALUES (?, ?, ?, ?, 10, 'E350', 'MS', 250000, ?, 'planned', ?)",
    [COMPANY, lineId, lot, no, kg, owner]);
  const requirement = async (rel, piId, stepId, batchId) => {
    const r = await ins('INSERT INTO cf_material_requirements (company_id, release_id, production_item_id, step_id, item_id, bom_line_id, quantity) VALUES (?, ?, ?, ?, ?, NULL, 1)', [COMPANY, rel, piId, stepId, P]);
    await db.query("INSERT INTO cf_stock_reservations (company_id, requirement_id, item_id, batch_id, quantity, status) VALUES (?, ?, ?, ?, 1, 'active')", [COMPANY, r, P, batchId]);
    return r;
  };
  const N1_WASTE = { plateArea: 2e6, partsArea: 5e5, kerf: 12000, offcut: 254777, cutLength: 4000 };

  /** A full release: L ← A (2) ← CP (2), with a dismantle and a re-join; a nest lot of one plate. */
  const fullRelease = async (so, key, owner, plateBatch) => {
    const iL = await temp(`${key}-LINE`, variant); const iA = await temp(`${key}-PART`, variant); const iCP = await temp(`${key}-CUT`, cutNode.id);
    await weigh(iCP, 30); await weigh(iA, 30); await weigh(iL, 60);
    const lineId = await newLine(so, iL);
    const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity, finished_area_id) VALUES (?, ?, ?, ?, 1, ?)', [COMPANY, so.id, lineId, iL, disp]);
    const L = await pi(rel, null, iL, 1, `${key}-L`, 0);
    const A = await pi(rel, L, iA, 2, `${key}-A`, 1);
    const CP = await pi(rel, A, iCP, 2, `${key}-CP`, 2);
    const S = {
      cut: await step(CP, 10, 2, 'Cut'), drill: await step(A, 10, 2, 'Drill'), paint: await step(A, 20, 2, 'Paint'),
      trial: await step(L, 10, 1, 'Trial'), dismantle: await step(L, 20, 1, 'Dismantle'), final: await step(L, 30, 1, 'Final'),
    };
    await dep(S.paint, S.dismantle, 'done');          // dismantling is a split
    await dep(S.final, S.paint, 'done');              // the final step re-joins
    const lot = await plateLot(lineId, `${key}-N1`, owner, { kerf: 3, waste: N1_WASTE });
    await place(lot, iCP, 1); await place(lot, iCP, 2);
    const off = await offcut(lineId, lot, `${key}-N1-A`, 20, owner);
    await requirement(rel, CP, S.cut, plateBatch);
    return { iL, iA, iCP, lineId, rel, L, A, CP, S, lot, off };
  };
  /** A cut-only release: n cut-piece nodes of 2 on one plate, `offs` offcuts. */
  const cutRelease = async (so, key, kinds, offs) => {
    const items = [];
    for (let k = 0; k < kinds; k++) { const it = await temp(`${key}-C${k}`, cutNode.id); await weigh(it, 30 / kinds); items.push(it); }
    const lineId = await newLine(so, items[0]);
    const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity, finished_area_id) VALUES (?, ?, ?, ?, 1, ?)', [COMPANY, so.id, lineId, items[0], disp]);
    const nodes = []; const steps = [];
    for (const [k, it] of items.entries()) { const n = await pi(rel, null, it, 2, `${key}-N${k}`, 0); nodes.push(n); steps.push(await step(n, 10, 2, 'Cut')); }
    const lot = await plateLot(lineId, `${key}-N1`, null, { kerf: 3, waste: N1_WASTE });
    let pos = 1;
    for (const it of items) { await place(lot, it, pos++); await place(lot, it, pos++); }
    for (let o = 0; o < offs; o++) await offcut(lineId, lot, `${key}-N1-${String.fromCharCode(65 + o)}`, 20 / offs, null);
    await requirement(rel, nodes[0], steps[0], null);
    return { items, nodes, steps, lineId, rel, lot };
  };

  const setState = (s, state, good = null, scrap = null) => db.query(
    `UPDATE cf_production_steps SET state = ?${good == null ? '' : ', qty_good = ?'}${scrap == null ? '' : ', qty_scrap = ?'} WHERE id = ?`,
    [state, ...(good == null ? [] : [good]), ...(scrap == null ? [] : [scrap]), s]);
  const go = async (s, state, good = null, scrap = null) => { await setState(s, state, good, scrap); return ledgerOnSteps(db, c, [s]); };
  const wipId = async () => (await db.query('SELECT id FROM cf_stocking_areas WHERE company_id = ? AND code = ?', [COMPANY, WIP_AREA_CODE]))[0][0]?.id;
  const scrapAreaId = async () => (await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'scrap' AND deleted_at IS NULL ORDER BY code = 'SCRAP' DESC, id LIMIT 1", [COMPANY]))[0][0]?.id;
  const scrapItemIdNow = async () => (await db.query('SELECT id FROM cf_master_records WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, SCRAP_ITEM_CODE]))[0][0]?.id;
  const lotOf = async (piId) => (await db.query('SELECT * FROM cf_stock_batches WHERE production_item_id = ? ORDER BY id LIMIT 1', [piId]))[0][0];
  const bal = async (areaId, itemId, batchId = null) => Number((await db.query('SELECT COALESCE(SUM(quantity), 0) q FROM cf_stock_balances WHERE stocking_area_id = ? AND item_id = ? AND batch_key = ?', [areaId, itemId, batchId ?? 0]))[0][0].q);
  const inWip = async (piId) => { const l = await lotOf(piId); return l ? bal(await wipId(), l.item_id, l.id) : 0; };
  const units = async (batchId) => (await db.query('SELECT * FROM cf_stock_units WHERE batch_id = ? AND deleted_at IS NULL ORDER BY serial', [batchId]))[0];
  const lastCut = async (ref) => (await db.query("SELECT id FROM cf_stock_movements WHERE company_id = ? AND movement_type = 'transform' AND reference = ? ORDER BY id DESC LIMIT 1", [COMPANY, ref]))[0][0]?.id;
  const legsOf = async (mid) => (await db.query('SELECT l.*, m.code AS item_code FROM cf_stock_ledger l JOIN cf_master_records m ON m.id = l.item_id WHERE l.movement_id = ? ORDER BY l.line_no', [mid]))[0];
  const lossesOf = async (mid) => (await db.query('SELECT * FROM cf_stock_losses WHERE movement_id = ? AND deleted_at IS NULL ORDER BY id', [mid]))[0];
  const sumValue = (rows) => rows.reduce((t, r) => t + (r.value == null ? 0 : Number(r.value)), 0);
  const unitsOk = async (batchIds) => (await checkUnits(db, COMPANY)).differences.filter((d) => batchIds.includes(d.batchId));

  const R1 = await fullRelease(SOA, 'R1', null, null);
  const R2 = await fullRelease(SOB, 'R2', CUSB, lotB);

  // ---- 1 -----------------------------------------------------------------------------
  section('1. Cutting our plate: parts + offcut + kerf + scrap = the plate, in kg and in ₹ (no scrap rate set)');
  const rate0 = await scrapRate(db, COMPANY);
  ok('no scrap rate set: it says so', rate0.ratePerKg == null && /No scrap rate set/.test(rate0.note ?? ''), J(rate0));
  await go(R1.S.cut, 'done', 2);
  const m1 = await lastCut(`${SOA.code} · cut ${tag}-R1-CP`);
  const l1 = await legsOf(m1);
  const x1 = await lossesOf(m1);
  const SCRAP = await scrapItemIdNow();
  const scrapArea = await scrapAreaId();
  const plateLeg = l1.find((l) => l.item_id === P);
  const partLeg = l1.find((l) => l.item_id === R1.iCP);
  const offLeg = l1.find((l) => /^OFC-10-E350/.test(l.item_code));
  const scrapLeg = l1.find((l) => l.item_id === SCRAP);
  const kerf1 = x1.find((x) => x.kind === 'kerf');
  const wd1 = x1.find((x) => x.kind === 'scrap_writedown');
  ok('the plate leaves storage: −1 plate, −₹1,570', !!plateLeg && Number(plateLeg.quantity) === -1 && near(plateLeg.value, -1570), J(plateLeg));
  ok('cut pieces: 2 × 30 kg = 60 kg → ₹600', !!partLeg && Number(partLeg.quantity) === 2 && near(partLeg.value, 600), J(partLeg));
  ok('offcut: 20 kg → ₹200, a stock piece', !!offLeg && Number(offLeg.quantity) === 1 && near(offLeg.value, 200), J(offLeg));
  ok('kerf: burnt, a LOSS of 0.942 kg = ₹9.42 (cut length 4,000 mm × 3 mm × 10 mm), never stock', !!kerf1 && near(kerf1.kg, 0.942, 0.001) && near(kerf1.value, 9.42) && !l1.some((l) => /kerf/i.test(l.notes ?? '')), J(kerf1));
  ok('scrap: 157 − 60 − 20 − 0.942 = 76.058 kg of "Steel scrap (kg)" into the SCRAP area, at ₹0 (no rate)', !!scrapLeg && near(scrapLeg.quantity, 76.058, 0.001) && scrapLeg.stocking_area_id === scrapArea && near(scrapLeg.value, 0), J(scrapLeg));
  ok('…the rest is written down: ₹760.58', !!wd1 && near(wd1.value, 760.58), J(wd1));
  ok('value in = value out: ledger + losses add up to zero', near(sumValue(l1) + sumValue(x1), 0, 0.011), `${sumValue(l1)} + ${sumValue(x1)}`);
  const kgOut = 60 + 20 + Number(kerf1.kg) + Number(scrapLeg.quantity);
  ok('kg in = kg out: 157 = parts + offcut + kerf + scrap', near(kgOut, 157, 0.001), String(kgOut));
  ok('the plate lot is marked cut', Number((await db.query('SELECT cut_movement_id FROM cf_plate_lots WHERE id = ?', [R1.lot]))[0][0].cut_movement_id) === m1);
  ok('our scrap is a running total (no lot): loose in SCRAP', (await bal(scrapArea, SCRAP)) >= 76.058 - 1e-6);
  ok('every ledger row of the cut is ours (owner NULL)', l1.every((l) => l.owner_party_id == null));
  Object.assign(example, { ours: { plateKg: 157, plateValue: 1570, parts: { kg: 60, value: Number(partLeg.value) }, offcut: { kg: 20, value: Number(offLeg.value) }, kerf: { kg: Number(kerf1.kg), value: Number(kerf1.value) }, scrap: { kg: Number(scrapLeg.quantity), value: Number(scrapLeg.value) }, writedown: Number(wd1.value) } });
  const cp1Units = await units((await lotOf(R1.CP)).id);
  const wipArea0 = await wipId();
  ok('the cut made one record per piece: 2 cut pieces, in process in WIP', cp1Units.length === 2 && cp1Units.every((u) => u.status === 'in_process' && u.stocking_area_id === wipArea0), J(cp1Units.map((u) => [u.unit_code, u.status])));
  ok('…coded by the piece code, numbered', cp1Units.map((u) => u.unit_code).join(',') === `${tag}-R1-CP#1,${tag}-R1-CP#2`, cp1Units.map((u) => u.unit_code).join(','));

  // ---- 2 -----------------------------------------------------------------------------
  section('2. A scrap rate: Setup sets it, our scrap is revalued at it');
  const rate6 = await setScrapRate(db, c, { ratePerKg: 6 });
  ok('the rate is ₹6/kg', rate6.ratePerKg === 6 && rate6.note == null, J(rate6));
  const bad = await setScrapRate(db, c, { ratePerKg: -1 }).catch((e) => e);
  ok('a negative rate is refused in words', /scrap rate/i.test(bad?.message ?? ''), bad?.message);
  const vScrap = await stockView(db, COMPANY, { category: 'scrap', owner: 'ours' });
  const ourScrapRow = vScrap.rows.find((r) => r.item.id === SCRAP);
  ok('the Stock screen values our scrap at the rate', !!ourScrapRow && near(ourScrapRow.value, ourScrapRow.quantity * 6, 0.05) && ourScrapRow.scrap?.ratePerKg === 6, J(ourScrapRow));

  // ---- 3 -----------------------------------------------------------------------------
  section('3. Cutting a CUSTOMER plate: everything made from it is theirs — node lots, offcut, scrap, every ledger row');
  await go(R2.S.cut, 'done', 2);
  const m2 = await lastCut(`${SOB.code} · cut ${tag}-R2-CP`);
  const l2 = await legsOf(m2);
  const x2 = await lossesOf(m2);
  const cp2Lot = await lotOf(R2.CP);
  ok('the cut pieces are B\'s, for SOB', cp2Lot.owner_party_id === CUSB && cp2Lot.owner_order_id === SOB.id, J({ o: cp2Lot.owner_party_id, ord: cp2Lot.owner_order_id }));
  const off2 = (await db.query('SELECT o.*, b.owner_party_id AS lot_owner FROM cf_offcuts o JOIN cf_stock_batches b ON b.id = o.batch_id WHERE o.id = ?', [R2.off]))[0][0];
  ok('the offcut stock piece is B\'s', off2?.status === 'available' && off2.lot_owner === CUSB, J(off2 && { s: off2.status, o: off2.lot_owner }));
  const scrap2 = l2.find((l) => l.item_id === SCRAP);
  const scrapLot2 = scrap2?.batch_id ? (await db.query('SELECT * FROM cf_stock_batches WHERE id = ?', [scrap2.batch_id]))[0][0] : null;
  ok('B\'s scrap goes into B\'s own scrap lot (never into ours)', !!scrapLot2 && scrapLot2.owner_party_id === CUSB && scrapLot2.owner_order_id === SOB.id && near(scrap2.quantity, 76.058, 0.001), J(scrap2));
  ok('every ledger row of the cut carries B as owner', l2.length > 0 && l2.every((l) => l.owner_party_id === CUSB), J(l2.map((l) => [l.item_code, l.owner_party_id])));
  ok('the losses are B\'s too', x2.length > 0 && x2.every((x) => x.owner_party_id === CUSB));
  const part2 = l2.find((l) => l.item_id === R2.iCP);
  const kerf2 = x2.find((x) => x.kind === 'kerf');
  const wd2 = x2.find((x) => x.kind === 'scrap_writedown');
  ok('at their reference ₹8/kg: parts ₹480, kerf ₹7.54, scrap at the ₹6 rate = ₹456.35', near(part2.value, 480) && near(kerf2.value, 7.54) && near(scrap2.value, 456.35), J([part2.value, kerf2.value, scrap2.value]));
  ok('value in = value out for their plate (ref ₹1,256)', near(sumValue(l2) + sumValue(x2), 0, 0.011), `${sumValue(l2)} + ${sumValue(x2)}`);
  Object.assign(example, { customer: { plateKg: 157, plateRef: 1256, parts: { kg: 60, value: Number(part2.value) }, offcut: { kg: 20, value: Number(l2.find((l) => /^OFC/.test(l.item_code)).value) }, kerf: { kg: Number(kerf2.kg), value: Number(kerf2.value) }, scrap: { kg: Number(scrap2.quantity), value: Number(scrap2.value) }, writedown: Number(wd2.value) } });

  // ---- 4 -----------------------------------------------------------------------------
  section('4. Scrap at a step: only the good move on; scrapped pieces leave WIP into scrap; made again comes back');
  await go(R1.S.drill, 'in_progress');
  const a1 = await lotOf(R1.A);
  ok('drilling started: the 2 cut pieces joined part A1 (₹600)', (await inWip(R1.CP)) === 0 && (await inWip(R1.A)) === 2 && near(a1.unit_cost, 300));
  const scrapBefore = await bal(scrapArea, SCRAP);
  await go(R1.S.drill, 'in_progress', 0, 1);
  ok('1 scrapped: A1 holds 1 in WIP', (await inWip(R1.A)) === 1);
  ok('…its 30 kg went into our scrap', near((await bal(scrapArea, SCRAP)) - scrapBefore, 30, 0.001), String((await bal(scrapArea, SCRAP)) - scrapBefore));
  let aUnits = await units(a1.id);
  ok('…its piece record ends as scrapped (the other is in process)', aUnits.filter((u) => u.status === 'scrapped').length === 1 && aUnits.filter((u) => u.status === 'in_process').length === 1, J(aUnits.map((u) => [u.serial, u.status])));
  const sref = `${SOA.code} · scrap ${tag}-R1-A · step ${R1.S.drill}`;
  const ms = await lastCut(sref);
  ok('…value conserved: ₹300 out = ₹180 scrap (30 kg × ₹6) + ₹120 written down', near(sumValue(await legsOf(ms)) + sumValue(await lossesOf(ms)), 0, 0.011)
    && near((await lossesOf(ms))[0].value, 120), J(await lossesOf(ms)));
  await go(R1.S.drill, 'in_progress', 1, 1);
  ok('1 good of 2 with 1 scrapped: nothing made again yet', (await inWip(R1.A)) === 1);
  await go(R1.S.drill, 'done', 2, 1);
  ok('2 good (one made again): A1 holds 2 again', (await inWip(R1.A)) === 2);
  aUnits = await units(a1.id);
  const remade = aUnits.find((u) => u.replaces_unit_id);
  ok('…a NEW piece record, made in place of the scrapped one', aUnits.length === 3 && remade && aUnits.find((u) => u.id === remade.replaces_unit_id)?.status === 'scrapped', J(aUnits.map((u) => [u.serial, u.status, u.replaces_unit_id])));
  const mr = await lastCut(`${sref} · made again`);
  ok('…its material is not recorded: a negative "remake" loss balances it', near(sumValue(await legsOf(mr)) + sumValue(await lossesOf(mr)), 0, 0.011) && (await lossesOf(mr))[0].kind === 'remake');
  const again = await ledgerOnSteps(db, c, [R1.S.drill]);
  ok('reconciling again posts nothing', again.movements === 0, J(again));
  await go(R1.S.drill, 'done', 2, 0);
  aUnits = await units(a1.id);
  ok('the scrap count lowered to 0: the remade piece is undone, the scrapped one is back', (await inWip(R1.A)) === 2 && aUnits.filter((u) => u.status === 'in_process').length === 2
    && aUnits.find((u) => u.replaces_unit_id)?.status === 'undone' && near((await bal(scrapArea, SCRAP)) - scrapBefore, 0, 0.001), J(aUnits.map((u) => [u.serial, u.status])));
  await go(R1.S.drill, 'done', 2, 0);

  // ---- 5 -----------------------------------------------------------------------------
  section('5. Pieces follow join, split (dismantle), re-join, completion and dispatch');
  await go(R1.S.trial, 'in_progress');
  const l1Lot = await lotOf(R1.L);
  let lu = await units(l1Lot.id);
  aUnits = (await units(a1.id)).filter((u) => u.status !== 'undone');
  ok('trial assembly: A1\'s pieces went INSIDE L1\'s piece', lu.length === 1 && lu[0].status === 'in_process' && aUnits.filter((u) => u.status === 'joined').every((u) => u.parent_unit_id === lu[0].id) && aUnits.filter((u) => u.status === 'joined').length === 2, J(aUnits.map((u) => [u.serial, u.status, u.parent_unit_id])));
  const insideIds = aUnits.filter((u) => u.status === 'joined').map((u) => u.id).sort();
  await go(R1.S.trial, 'done', 1);
  await go(R1.S.dismantle, 'in_progress'); await go(R1.S.dismantle, 'done', 1);
  lu = await units(l1Lot.id);
  aUnits = await units(a1.id);
  ok('dismantled: the SAME A1 pieces are back in process, L1\'s piece is split', lu[0].status === 'split'
    && J(aUnits.filter((u) => u.status === 'in_process').map((u) => u.id).sort()) === J(insideIds), J(aUnits.map((u) => [u.id, u.status])));
  await go(R1.S.paint, 'in_progress'); await go(R1.S.paint, 'done', 2);
  await go(R1.S.final, 'in_progress');
  lu = await units(l1Lot.id);
  ok('re-joined: L1\'s same piece is back in process, holding A1\'s pieces again', lu.length === 1 && lu[0].status === 'in_process' && (await units(a1.id)).filter((u) => u.status === 'joined').length === 2);
  ok('the check: pieces = balances for these lots', (await unitsOk([a1.id, l1Lot.id, (await lotOf(R1.CP)).id])).length === 0);
  await go(R1.S.final, 'done', 1);
  await stockFinished(db, c, R1.L);
  lu = await units(l1Lot.id);
  ok('completed: L1\'s piece is finished, on the dispatch shelf', lu[0].status === 'finished' && lu[0].stocking_area_id === disp, J(lu[0]));
  const hist = await unitHistory(db, COMPANY, lu[0].id);
  ok('its history: made, went in and out, back, finished — with movements', ['made', 'split', 'back', 'finished'].every((e) => hist.history.some((h) => h.event === e)) && hist.inside.length === 2 && hist.history.every((h) => h.movement), J(hist.history.map((h) => h.event)));
  await shipLine(db, c, R1.lineId, { invoice: false, view: 'none' });
  lu = await units(l1Lot.id);
  ok('dispatched: the piece record says dispatched, nowhere on our shelves', lu[0].status === 'dispatched' && lu[0].stocking_area_id == null, J(lu[0]));

  // B's job, through to dispatch: the finished piece is theirs and ships to their order.
  await go(R2.S.drill, 'in_progress'); await go(R2.S.drill, 'done', 2);
  await go(R2.S.trial, 'in_progress'); await go(R2.S.trial, 'done', 1);
  await go(R2.S.dismantle, 'in_progress'); await go(R2.S.dismantle, 'done', 1);
  await go(R2.S.paint, 'in_progress'); await go(R2.S.paint, 'done', 2);
  await go(R2.S.final, 'in_progress'); await go(R2.S.final, 'done', 1);
  await stockFinished(db, c, R2.L);
  const l2Lot = await lotOf(R2.L);
  ok('B\'s part and finished piece are B\'s (made from their plate)', (await lotOf(R2.A)).owner_party_id === CUSB && l2Lot.owner_party_id === CUSB);
  const shipped = await shipLine(db, c, R2.lineId, { invoice: false, view: 'none' }).catch((e) => e);
  ok('…and it ships to their order', shipped?.shipped === 1, shipped?.message ?? J(shipped?.shipped));

  // ---- 6 -----------------------------------------------------------------------------
  section('6. Offcuts: scrapped by hand → status scrapped and into scrap; reversed → available; returned → returned');
  const o1 = (await db.query('SELECT * FROM cf_offcuts WHERE id = ?', [R1.off]))[0][0];
  const wip = await wipId();
  const sb = await bal(scrapArea, SCRAP);
  const scr = await postMovement(db, c, { movementType: 'scrap', fromAreaId: wip, reason: 'Rusted through', lines: [{ itemId: (await db.query('SELECT item_id FROM cf_stock_batches WHERE id = ?', [o1.batch_id]))[0][0].item_id, batchId: o1.batch_id, quantity: 1 }] });
  ok('the offcut is scrapped', (await db.query('SELECT status FROM cf_offcuts WHERE id = ?', [R1.off]))[0][0].status === 'scrapped');
  ok('…its 20 kg went into our scrap stock, at the rate (₹120)', near((await bal(scrapArea, SCRAP)) - sb, 20, 0.001) && scr.lines.some((l) => l.item.id === SCRAP && near(l.value, 120)), J(scr.lines.map((l) => [l.item.code, l.quantity, l.value])));
  const wdScr = await lossesOf(scr.id);
  ok('…the rest of its ₹200 is written down (₹80)', wdScr.length === 1 && near(wdScr[0].value, 80), J(wdScr));
  const rev = await reverseMovement(db, c, scr.id, { reason: 'Found it was fine' });
  ok('reversed: available again, the scrap kg back out, the write-down undone', (await db.query('SELECT status FROM cf_offcuts WHERE id = ?', [R1.off]))[0][0].status === 'available'
    && near((await bal(scrapArea, SCRAP)) - sb, 0, 0.001) && near(sumValue(await lossesOf(rev.id)), -80));
  const back = await returnToCustomer(db, c, { orderId: SOB.id, offcutIds: [R2.off], scrapKg: 50 });
  ok('B\'s offcut is returned: status returned, its stock piece left our shelves on the return', (await db.query('SELECT status, returned_movement_id FROM cf_offcuts WHERE id = ?', [R2.off]))[0][0].status === 'returned'
    && back.movement.lines.some((l) => l.batch?.id === off2.batch_id) && (await bal(wip, off2.item_id ?? (await db.query('SELECT item_id FROM cf_stock_batches WHERE id = ?', [off2.batch_id]))[0][0].item_id, off2.batch_id)) === 0);
  ok('B\'s scrap by weight came out of their scrap lot (50 of 76.058 kg), no bare weight', near(back.scrapFromLotsKg, 50) && back.movement.returnKg == null && near(await bal(scrapArea, SCRAP, scrapLot2.id), 26.058, 0.001), J({ k: back.scrapFromLotsKg, r: back.movement.returnKg }));
  const rec = await materialReconciliation(db, COMPANY, SOB.id);
  ok('the reconciliation counts their scrap lot (26.058 kg with us) and not their WIP pieces', near(rec.scrap.scrapLotsKg, 26.058, 0.001) && !rec.items.some((r) => r.item.id === R2.iCP || r.item.id === R2.iL), J(rec.scrap));
  ok('…their plate: received 1, used in production 1, with us 0', (() => { const p = rec.items.find((r) => r.item.id === P); return p && p.received.qty === 1 && p.usedInProduction.qty === 1 && p.withUs.qty === 0 && p.balances; })(), J(rec.items.find((r) => r.item.id === P)));

  // ---- 7 -----------------------------------------------------------------------------
  section('7. The owner on every ledger row: filled when written, backfilled from the lot');
  const [[gap]] = await db.query(
    `SELECT COUNT(*) AS n FROM cf_stock_ledger l JOIN cf_stock_batches b ON b.id = l.batch_id
      WHERE l.company_id = ? AND l.movement_id >= ? AND NOT (l.owner_party_id <=> b.owner_party_id)`, [COMPANY, recB.id]);
  ok('every row written in this suite carries its lot\'s owner', Number(gap.n) === 0, String(gap.n));
  const [[bRow]] = await db.query('SELECT id FROM cf_stock_ledger WHERE company_id = ? AND batch_id = ? ORDER BY id LIMIT 1', [COMPANY, lotB]);
  await db.query('UPDATE cf_stock_ledger SET owner_party_id = NULL WHERE id = ?', [bRow.id]);
  await db.query(`UPDATE cf_stock_ledger l JOIN cf_stock_batches b ON b.company_id = l.company_id AND b.id = l.batch_id
      SET l.owner_party_id = b.owner_party_id
    WHERE l.batch_id IS NOT NULL AND l.owner_party_id IS NULL AND b.owner_party_id IS NOT NULL`);
  ok('the §67 backfill (set-based) fills a row written before the column', (await db.query('SELECT owner_party_id FROM cf_stock_ledger WHERE id = ?', [bRow.id]))[0][0].owner_party_id === CUSB);
  const byB = await listMovements(db, COMPANY, { owner: CUSB, paged: 1, limit: 200 });
  ok('movements by customer read off the ledger owner', byB.total >= 3 && byB.rows.some((m) => m.id === m2), String(byB.total));
  const lossB = await listLosses(db, COMPANY, { orderId: SOB.id });
  ok('losses by order: kerf and write-downs, with totals', lossB.totals.kerf && near(lossB.totals.kerf.kg, 0.942, 0.001), J(lossB.totals));

  // ---- 7b ----------------------------------------------------------------------------
  section('7b. Round trips of a cut are fixed: 1 piece row + 1 offcut costs what 3 rows + 3 offcuts cost');
  const R3a = await cutRelease(SOA, 'R3A', 1, 1);
  const R3b = await cutRelease(SOA, 'R3B', 3, 3);
  await postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId: P, quantity: 2, unitCost: 1570 }] });
  await setState(R3a.steps[0], 'done', 2); await setState(R3b.steps[0], 'done', 2);
  const ca = counting(db); await ledgerOnSteps(ca.db, c, [R3a.steps[0]]);
  const cb = counting(db); await ledgerOnSteps(cb.db, c, [R3b.steps[0]]);
  ok(`a cut: ${ca.tally.n} round trips for 1 piece row + 1 offcut, ${cb.tally.n} for 3 rows + 3 offcuts`, ca.tally.n === cb.tally.n);
  const mb = await lastCut(`${SOA.code} · cut ${tag}-R3B-N0`);
  ok('…and the bigger cut still adds up (6 pieces, 3 offcuts, kerf, scrap)', near(sumValue(await legsOf(mb)) + sumValue(await lossesOf(mb)), 0, 0.011)
    && (await legsOf(mb)).filter((l) => /^OFC/.test(l.item_code)).length === 3);

  // ---- 8 -----------------------------------------------------------------------------
  section('8. The Stock screen: grouped by tracking mode; filters; totals by owner');
  const v = await stockView(db, COMPANY, { search: tag, limit: 200 });
  const modes = v.rows.map((r) => r.item.trackedBy);
  const order = ['quantity', 'batch', 'individual'];
  ok('rows come quantity → batch → individual', modes.every((m, i) => i === 0 || order.indexOf(modes[i - 1]) <= order.indexOf(m)), J(modes));
  const boltRow = v.rows.find((r) => r.item.id === BOLT);
  const heatRow = v.rows.find((r) => r.item.id === HB);
  const pieceRow = v.rows.find((r) => r.item.trackedBy === 'individual');
  ok('a quantity item is one total per item and area, no lots to open', !!boltRow && boltRow.open === null && boltRow.lines === 1 && boltRow.quantity === 10, J(boltRow));
  ok('a batch item opens its lots', !!heatRow && heatRow.open === 'lots' && heatRow.lots === 1, J(heatRow));
  const lots = await stockViewLots(db, COMPANY, { itemId: HB, areaId: store, owner: 'ours', category: heatRow.category });
  ok('…its lot: H1, 2 at ₹900', lots.length === 1 && lots[0].batch.code === `${tag}-H1` && lots[0].quantity === 2 && near(lots[0].value, 1800), J(lots));
  ok('an individual item opens its pieces', !!pieceRow && pieceRow.open === 'pieces', J(pieceRow));
  const pcs = await listUnits(db, COMPANY, { itemId: pieceRow.item.id, areaId: pieceRow.area.id, paged: 1 });
  ok('…its pieces, one row each', pcs.rows.length === Math.floor(pieceRow.quantity) && pcs.rows.every((u) => u.item.id === pieceRow.item.id), `${pcs.rows.length} vs ${pieceRow.quantity}`);
  const std = await stockView(db, COMPANY, { search: tag, kind: 'standard', limit: 200 });
  const cus = await stockView(db, COMPANY, { search: tag, kind: 'custom', limit: 200 });
  ok('standard (catalog) and custom (made for an order) split the list', std.rows.every((r) => r.item.kind === 'standard') && cus.rows.every((r) => r.item.kind === 'custom') && cus.rows.length > 0
    && std.rows.length + cus.rows.length === v.total && v.counts.kinds.standard === std.total, J(v.counts.kinds));
  const fam = await stockView(db, COMPANY, { search: tag, classificationId: family, limit: 200 });
  const vv = await stockView(db, COMPANY, { search: tag, classificationId: variant, limit: 200 });
  const ww = await stockView(db, COMPANY, { search: tag, classificationId: otherVariant, limit: 200 });
  ok('a classification branch includes everything below it', fam.rows.some((r) => r.item.id === OTHER) && fam.rows.some((r) => r.item.id === BOLT) && vv.rows.every((r) => r.item.id !== OTHER) && ww.rows.length === 1 && ww.rows[0].item.id === OTHER, J([fam.total, vv.total, ww.total]));
  const oursOnly = await stockView(db, COMPANY, { search: tag, owner: 'ours', limit: 200 });
  const allCust = await stockView(db, COMPANY, { search: tag, owner: 'customer', limit: 200 });
  const onlyB = await stockView(db, COMPANY, { search: tag, owner: String(CUSB), limit: 200 });
  ok('owner: ours / all customers / one customer', oursOnly.rows.every((r) => !r.owner) && allCust.rows.length > 0 && allCust.rows.every((r) => r.owner) && onlyB.rows.every((r) => r.owner?.id === CUSB) && onlyB.total === allCust.total);
  const scrapCat = await stockView(db, COMPANY, { search: tag, category: 'scrap', limit: 200 });
  ok('category scrap: B\'s scrap lot (theirs, kg, reference value apart, never in our value)', scrapCat.rows.length === 1 && scrapCat.rows[0].owner?.id === CUSB && scrapCat.rows[0].value == null && scrapCat.rows[0].referenceValue != null && near(scrapCat.rows[0].kg, 26.058, 0.001), J(scrapCat.rows));
  const offCat = await stockView(db, COMPANY, { search: tag, category: 'offcut', limit: 200 });
  ok('category offcut: our offcut piece, wherever it lies', offCat.rows.length === 1 && !offCat.rows[0].owner && offCat.rows[0].area.id === wip, J(offCat.rows.map((r) => [r.item.code, r.area.code])));
  const avail = await stockView(db, COMPANY, { search: tag, category: 'available', limit: 200 });
  ok('category raw / available: plates, bolts, the heat lot in storage', [P, BOLT, HB].every((id) => avail.rows.some((r) => r.item.id === id)) && avail.rows.every((r) => r.area.purpose === 'storage'));
  const ip = await stockView(db, COMPANY, { search: tag, category: 'in_process', limit: 200 });
  ok('category in process (WIP): the R3 cut pieces standing in WIP', ip.rows.length > 0 && ip.rows.every((r) => r.area.purpose === 'wip') && ip.rows.some((r) => r.item.id === R3b.items[0]), J(ip.rows.map((r) => r.item.code)));
  const sumOurs = v.rows.filter((r) => !r.owner).reduce((t, r) => t + (r.value ?? 0), 0);
  ok('totals: ours valued (= the sum of our rows)', near(v.totals.ours.value, sumOurs, 0.05), `${v.totals.ours.value} vs ${sumOurs}`);
  const tb = v.totals.customers.find((t) => t.party.id === CUSB);
  ok('totals: B\'s kg and reference value, apart from ours', !!tb && tb.kg > 0 && tb.referenceValue >= 0 && tb.quantities.some((q) => q.uom === 'kg'), J(tb));
  ok('counts: categories, owners, kinds and tracking', v.counts.categories.all === v.total && v.counts.tracking.all === v.total && v.counts.owners.parties.some((p) => p.id === CUSB));
  const page = await stockView(db, COMPANY, { search: tag, limit: 2, offset: 2 });
  ok('paged: 2 rows from the 3rd, the same total', page.rows.length === 2 && page.total === v.total && page.rows[0].key === v.rows[2].key);

  // ---- 9 -----------------------------------------------------------------------------
  section('9. Pieces = balances (the check), and it catches a difference');
  const ck = await checkLedger(db, COMPANY);
  ok('ledger check: balances agree, and pieces agree with their lots', ck.ok && ck.units.ok, J({ d: ck.differences.length, u: ck.units.differences }));
  const somePiece = (await db.query("SELECT id FROM cf_stock_units WHERE batch_id = ? AND status = 'joined' LIMIT 1", [a1.id]))[0][0];
  await db.query("UPDATE cf_stock_units SET status = 'in_process', stocking_area_id = ? WHERE id = ?", [wip, somePiece.id]);
  const ck2 = await checkLedger(db, COMPANY);
  ok('a piece out of step is found', !ck2.ok && ck2.units.differences.some((d) => d.batchId === a1.id), J(ck2.units.differences));
  await db.query("UPDATE cf_stock_units SET status = 'joined', stocking_area_id = NULL WHERE id = ?", [somePiece.id]);

  // ---- 10 ----------------------------------------------------------------------------
  section('10. Round trips are fixed: the screen, a cut and the piece records do not grow with the rows');
  const t1 = counting(db); await stockView(t1.db, COMPANY, { limit: 2 });
  const t2 = counting(db); await stockView(t2.db, COMPANY, { limit: 200 });
  ok(`Stock screen: ${t1.tally.n} round trips for 2 rows, ${t2.tally.n} for 200`, t1.tally.n === t2.tally.n);
  const lotsA = [(await lotOf(R3a.nodes[0])).id];
  const lotsB = await Promise.all(R3b.nodes.map(async (n) => (await lotOf(n)).id));
  const sa = counting(db); await syncUnits(sa.db, c, { movementId: null, movementType: 'transform', batchIds: lotsA });
  const sbb = counting(db); await syncUnits(sbb.db, c, { movementId: null, movementType: 'transform', batchIds: lotsB });
  ok(`piece records: ${sa.tally.n} round trips for 1 lot, ${sbb.tally.n} for 3 (nothing to change)`, sa.tally.n === sbb.tally.n);
  const ck3 = await checkUnits(db, COMPANY);
  ok('…and every piece agrees with its lot', ck3.differences.filter((d) => [...lotsA, ...lotsB].includes(d.batchId)).length === 0);
} catch (err) {
  failed++;
  console.error('\nERROR', err);
} finally {
  await db.rollback();
  db.release();
}

const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
section('Rolled back');
ok('every cf_ table has the rows it had', drift.length === 0, drift.map((d) => d.name).join(', '));
if (example.ours) console.log(`\nWORKED EXAMPLE ${JSON.stringify(example)}`);
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
