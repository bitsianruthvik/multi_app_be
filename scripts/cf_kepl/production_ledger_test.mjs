/**
 * production_ledger_test.mjs — stock follows the steel up and down the BOM
 * (services/productionLedgerService.js, init.sql §45, CF_ERP_WIP_LEDGER_PLAN.md).
 *
 *   cd multi_app_be && node scripts/cf_kepl/production_ledger_test.mjs
 *   CF_LEDGER_COMPANY=2 (default)
 *
 * A hand-built release, so every number is known:
 *   L  girder line (top)        steps Trial(10) join · Dismantle(20) split · Dispatch(30) re-join
 *   └ S1, S2 segments           steps Fitup(10) join (+4 bolts each) · Blast(20) waits on L.Dismantle done
 *     └ A1, A2 parts (2 off)    step  Drill(10) join
 *       └ CP1, CP2 cut plates   step  Cut(10) — its own plate (1 plate P each, 100 kg, ₹1000)
 * Cut pieces weigh 30 kg each, so a cut hands 60 kg of 100 = ₹600 to the cut plate row.
 *
 * Steps are moved by writing their state and calling ledgerOnSteps — exactly
 * what the tracker and the floor screens now do after their own writes. One
 * transaction, rolled back; every cf_ table re-counted.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createOrder, addOrderLine, setOrderStatus } from '../../apps/cf_erp/services/salesOrderService.js';
import { createItem } from '../../apps/cf_erp/services/masterRecordService.js';
import { postMovement } from '../../apps/cf_erp/services/stockService.js';
import { ledgerOnSteps, WIP_AREA_CODE } from '../../apps/cf_erp/services/productionLedgerService.js';
import { stockFinished } from '../../apps/cf_erp/services/releaseService.js';
import { wipStock, listOffcuts } from '../../apps/cf_erp/services/wipStockService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_LEDGER_COMPANY ?? 2);
const tag = `PLG${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();

try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, isAdmin: true };
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN ('sales_order', 'stock_movement', 'stock_lot')", [COMPANY]);

  // ---- fixture -----------------------------------------------------------------
  const node = (parentId, depth, key) => ins("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key}`]);
  const variant = await node(await node(await node(null, 0, 'F'), 1, 'S'), 2, 'V');
  const [[cutNode]] = await db.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'CUT_PLATE' AND deleted_at IS NULL", [COMPANY]);
  const catalog = async (key) => (await createItem(db, c, { classificationId: variant, code: `${tag}-${key}`, name: `${tag} ${key}`, status: 'active' })).id;
  const P = await catalog('PLATE');
  const BOLT = await catalog('BOLT');
  const temp = async (key, classId) => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, `${tag}-${key}`, `${tag} ${key}`, classId]);
    await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'temporary', 'quantity', 'nos', 'make')", [id, COMPANY]);
    return id;
  };
  const iL = await temp('LINE', variant); const iS = await temp('SEG', variant); const iA = await temp('PART', variant); const iCP = await temp('CUTPL', cutNode.id);
  const [[wSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL", [COMPANY]);
  for (const [id, kg] of [[P, 100], [iCP, 30]]) await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, ?, 'entered')", [COMPANY, wSpec.id, id, kg]);
  const store = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')", [COMPANY, `${tag}-ST`, `${tag} store`]);
  const disp = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'dispatch', 'active')", [COMPANY, `${tag}-DS`, `${tag} dispatch`]);
  await postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId: P, quantity: 2, unitCost: 1000 }, { itemId: BOLT, quantity: 4, unitCost: 5 }] });
  const customer = await ins("INSERT INTO cf_parties (company_id, code, name, is_customer, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${tag}-CUS`, `${tag} customer`]);
  const so = await createOrder(db, c, { orderType: 'customer', customerId: customer, code: `${tag}-SO`, committedDate: '2099-12-31' });
  const fg = await catalog('FG');
  const ol = await addOrderLine(db, c, so.id, { recordId: fg, quantity: 1 });
  await setOrderStatus(db, c, so.id, 'confirmed');
  const lineId = ol.lines[0].id;
  const [[flow]] = await db.query('SELECT id FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [COMPANY]);
  const [[op]] = await db.query('SELECT id FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [COMPANY]);
  const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity, finished_area_id) VALUES (?, ?, ?, ?, 1, ?)', [COMPANY, so.id, lineId, iL, disp]);
  let sort = 0;
  const pi = (parent, item, qty, code, depth) => ins('INSERT INTO cf_production_items (company_id, release_id, parent_id, item_id, quantity, code, flow_id, depth, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, rel, parent, item, qty, `${tag}-${code}`, flow.id, depth, sort++]);
  const L = await pi(null, iL, 1, 'L', 0);
  const S1 = await pi(L, iS, 1, 'S1', 1); const A1 = await pi(S1, iA, 2, 'A1', 2); const CP1 = await pi(A1, iCP, 2, 'CP1', 3);
  const S2 = await pi(L, iS, 1, 'S2', 1); const A2 = await pi(S2, iA, 2, 'A2', 2); const CP2 = await pi(A2, iCP, 2, 'CP2', 3);
  const st = (item, seq, qty, name) => ins('INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, step_name, quantity) VALUES (?, ?, ?, ?, ?, ?)', [COMPANY, item, op.id, seq, name, qty]);
  const T = {
    cut1: await st(CP1, 10, 2, 'Cut'), cut2: await st(CP2, 10, 2, 'Cut'),
    drill1: await st(A1, 10, 2, 'Drill'), drill2: await st(A2, 10, 2, 'Drill'),
    fit1: await st(S1, 10, 1, 'Fitup'), blast1: await st(S1, 20, 1, 'Blast'),
    fit2: await st(S2, 10, 1, 'Fitup'), blast2: await st(S2, 20, 1, 'Blast'),
    trial: await st(L, 10, 1, 'Trial'), dismantle: await st(L, 20, 1, 'Dismantle'), dispatch: await st(L, 30, 1, 'Dispatch'),
  };
  const dep = (step, target, required) => ins("INSERT INTO cf_step_dependencies (company_id, step_id, target_step_id, required, origin) VALUES (?, ?, ?, ?, 'rule')", [COMPANY, step, target, required]);
  await dep(T.blast1, T.dismantle, 'done'); await dep(T.blast2, T.dismantle, 'done');      // dismantle is a split
  await dep(T.dispatch, T.blast1, 'done'); await dep(T.dispatch, T.blast2, 'done');        // dispatch re-joins
  const req = (item, step, itemId, qty) => ins('INSERT INTO cf_material_requirements (company_id, release_id, production_item_id, step_id, item_id, bom_line_id, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)', [COMPANY, rel, item, step, itemId, null, qty]);
  // bom_line_id NULL with a production item is a lot requirement; a plain own-plate requirement also counts as the cut's input.
  const rP1 = await req(CP1, T.cut1, P, 1); const rP2 = await req(CP2, T.cut2, P, 1);
  const rB1 = await req(S1, T.fit1, BOLT, 4); const rB2 = await req(S2, T.fit2, BOLT, 4);
  const reserve = (r, item, qty) => db.query("INSERT INTO cf_stock_reservations (company_id, requirement_id, item_id, quantity, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, r, item, qty]);
  await reserve(rP1, P, 1); await reserve(rP2, P, 1); await reserve(rB1, BOLT, 4);          // S2's bolts are NOT reserved yet

  const setState = (step, state, good = null) => db.query(`UPDATE cf_production_steps SET state = ?${good == null ? '' : ', qty_good = ?'} WHERE id = ?`, good == null ? [state, step] : [state, good, step]);
  const go = async (step, state, good = null) => { await setState(step, state, good); return ledgerOnSteps(db, c, [step]); };
  const [[wip]] = await db.query('SELECT id FROM cf_stocking_areas WHERE company_id = ? AND code = ?', [COMPANY, WIP_AREA_CODE]).then(([r]) => [r]).catch(() => [[null]]);
  const wipId = async () => (await db.query('SELECT id FROM cf_stocking_areas WHERE company_id = ? AND code = ?', [COMPANY, WIP_AREA_CODE]))[0][0]?.id;
  const lotOf = async (piId) => (await db.query('SELECT * FROM cf_stock_batches WHERE production_item_id = ? ORDER BY id LIMIT 1', [piId]))[0][0];
  const bal = async (areaId, itemId, batchId = null) => Number((await db.query('SELECT COALESCE(SUM(quantity), 0) q FROM cf_stock_balances WHERE stocking_area_id = ? AND item_id = ? AND batch_key = ?', [areaId, itemId, batchId ?? 0]))[0][0].q);
  const inWip = async (piId) => { const l = await lotOf(piId); return l ? bal(await wipId(), l.item_id, l.id) : 0; };
  void wip;

  section('1. Cutting is a split: at DONE the plate becomes its cut pieces');
  await go(T.cut1, 'in_progress');
  ok('cutting started: the plate is still a plate', (await bal(store, P)) === 2 && (await inWip(CP1)) === 0);
  await go(T.cut1, 'done', 2);
  ok('cutting done: one plate out of storage', (await bal(store, P)) === 1);
  ok('...and CP1 (2 pieces) in work in progress', (await inWip(CP1)) === 2);
  ok('CP1 carries 60 kg of 100 = ₹600 (₹300 each)', near((await lotOf(CP1)).unit_cost, 300), String((await lotOf(CP1)).unit_cost));
  const [[rq]] = await db.query('SELECT issued FROM cf_material_requirements WHERE id = ?', [rP1]);
  ok('the plate requirement is issued and its reservation consumed', Number(rq.issued) === 1 && (await db.query("SELECT status FROM cf_stock_reservations WHERE requirement_id = ?", [rP1]))[0][0].status === 'consumed');
  await go(T.cut2, 'done', 2);

  section('2. Joins at START: cut piece → part → segment');
  await go(T.drill1, 'in_progress');
  ok('A1 drilling started: CP1 out, A1 in (₹600)', (await inWip(CP1)) === 0 && (await inWip(A1)) === 2 && near((await lotOf(A1)).unit_cost, 300));
  await go(T.drill1, 'done', 2);
  ok('drilling done moves nothing (not a split)', (await inWip(A1)) === 2);
  await go(T.drill2, 'in_progress'); await go(T.drill2, 'done', 2);
  await go(T.fit1, 'in_progress');
  ok('S1 fit-up started: A1 + 4 bolts in, S1 = ₹600 + ₹20', (await inWip(A1)) === 0 && (await inWip(S1)) === 1 && near((await lotOf(S1)).unit_cost, 620), String((await lotOf(S1)).unit_cost));
  ok('...the bolts left storage', (await bal(store, BOLT)) === 0);

  section('3. A start needs its bought material reserved');
  await setState(T.fit2, 'in_progress');
  const noBolts = await refusal(() => ledgerOnSteps(db, c, [T.fit2]));
  ok('S2 fit-up refused: bolts not in stock and reserved', noBolts?.code === 'MATERIAL_NOT_RESERVED', noBolts?.message);
  await postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId: BOLT, quantity: 4, unitCost: 5 }] });
  await reserve(rB2, BOLT, 4);
  await ledgerOnSteps(db, c, [T.fit2]);
  ok('received and reserved, S2 fit-up goes through (₹620)', (await inWip(S2)) === 1 && near((await lotOf(S2)).unit_cost, 620));

  section('4. Undo a start: everything goes back where it came from');
  await go(T.fit2, 'pending');
  ok('S2 out, A2 back in WIP, bolts back in storage', (await inWip(S2)) === 0 && (await inWip(A2)) === 2 && (await bal(store, BOLT)) === 4);
  ok('...the bolt requirement is not issued and is reserved again', Number((await db.query('SELECT issued FROM cf_material_requirements WHERE id = ?', [rB2]))[0][0].issued) === 0
    && Number((await db.query("SELECT COALESCE(SUM(quantity),0) q FROM cf_stock_reservations WHERE requirement_id = ? AND status = 'active'", [rB2]))[0][0].q) === 4);
  await go(T.fit2, 'in_progress');
  const again = await ledgerOnSteps(db, c, [T.fit2, T.fit1, T.drill1]);
  ok('reconciling again posts nothing (idempotent)', again.movements === 0, JSON.stringify(again));

  section('5. Trial assembly joins, dismantling splits, dispatch re-joins');
  await go(T.trial, 'in_progress');
  ok('trial assembly started: S1, S2 into L (₹1,240)', (await inWip(S1)) === 0 && (await inWip(S2)) === 0 && (await inWip(L)) === 1 && near((await lotOf(L)).unit_cost, 1240));
  await go(T.trial, 'done', 1);
  await go(T.dismantle, 'in_progress');
  ok('dismantling started: still one line', (await inWip(L)) === 1);
  await go(T.dismantle, 'done', 1);
  ok('dismantling done: L out, S1 and S2 back with ₹620 each', (await inWip(L)) === 0 && (await inWip(S1)) === 1 && (await inWip(S2)) === 1 && near((await lotOf(S1)).unit_cost, 620) && near((await lotOf(S2)).unit_cost, 620));
  await go(T.blast1, 'in_progress'); await go(T.blast1, 'done', 1);
  await go(T.blast2, 'in_progress'); await go(T.blast2, 'done', 1);
  ok('blasting moves nothing', (await inWip(S1)) === 1 && (await inWip(S2)) === 1);
  await go(T.dispatch, 'in_progress');
  ok('dispatch started (waits on its segments): they join L again (₹1,240)', (await inWip(S1)) === 0 && (await inWip(L)) === 1 && near((await lotOf(L)).unit_cost, 1240));

  section('6. The top piece goes to finished stock with its value');
  await go(T.dispatch, 'done', 1);
  await stockFinished(db, c, L);
  const lotL = await lotOf(L);
  ok('L left work in progress and stands in dispatch as the same lot', (await inWip(L)) === 0 && (await bal(disp, iL, lotL.id)) === 1);
  const [[fv]] = await db.query('SELECT SUM(value) v FROM cf_stock_ledger WHERE batch_id = ? AND stocking_area_id = ?', [lotL.id, disp]);
  ok('...worth ₹1,240 (2 × 60 kg of plate + 8 bolts)', near(fv.v, 1240), String(fv.v));
  ok('...and earmarked for the sales line', Number((await db.query("SELECT COUNT(*) n FROM cf_stock_reservations WHERE order_line_id = ? AND batch_id = ? AND status = 'active'", [lineId, lotL.id]))[0][0].n) === 1);

  section('7. Undoing a cut after its pieces moved on is refused');
  await setState(T.cut1, 'in_progress');
  const late = await refusal(() => ledgerOnSteps(db, c, [T.cut1]));
  ok('the cut cannot be undone once its pieces are inside a part', late?.code === 'MOVED_ON', late?.message);

  section('8. A nest: the gate’s cut is the plates of its group → the group’s cut pieces + an offcut stock piece');
  const ol2 = await addOrderLine(db, c, so.id, { recordId: fg, quantity: 1 }).catch(() => null);
  const line2 = (await db.query('SELECT id FROM cf_sales_order_lines WHERE order_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [so.id]))[0][0].id;
  void ol2;
  const iCPn = await temp('CUTPLN', cutNode.id);
  await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, 30, 'entered')", [COMPANY, wSpec.id, iCPn]);
  const rel2 = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity, finished_area_id) VALUES (?, ?, ?, ?, 1, ?)', [COMPANY, so.id, line2, iL, disp]);
  const PN = await ins('INSERT INTO cf_production_items (company_id, release_id, parent_id, item_id, quantity, code, flow_id, depth, sort_order) VALUES (?, ?, NULL, ?, 1, ?, ?, 0, 0)', [COMPANY, rel2, iA, `${tag}-PN`, flow.id]);
  const CPN = await ins('INSERT INTO cf_production_items (company_id, release_id, parent_id, item_id, quantity, code, flow_id, depth, sort_order) VALUES (?, ?, ?, ?, 4, ?, ?, 1, 1)', [COMPANY, rel2, PN, iCPn, `${tag}-CPN`, flow.id]);
  const cutN = await ins('INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, step_name, quantity) VALUES (?, ?, ?, 10, ?, 4)', [COMPANY, CPN, op.id, 'Cut']);
  const lot = (no) => ins("INSERT INTO cf_plate_lots (company_id, order_line_id, plate_item_id, lot_no, thickness_mm, length_mm, width_mm, density, source) VALUES (?, ?, ?, ?, 10, 2000, 1000, 7850, 'catalog')", [COMPANY, line2, P, no]);
  const lot1 = await lot('N-001'); const lot2 = await lot('N-002');
  for (const [l, pos] of [[lot1, 1], [lot1, 2], [lot2, 1], [lot2, 2]]) await db.query('INSERT INTO cf_nest_placements (company_id, plate_lot_id, cut_plate_id, pos_no, x_mm, y_mm, length_mm, width_mm) VALUES (?, ?, ?, ?, 0, 0, 500, 500)', [COMPANY, l, iCPn, pos]);
  const off = await ins("INSERT INTO cf_offcuts (company_id, order_line_id, plate_lot_id, offcut_no, thickness_mm, grade, material, area_mm2, weight_kg, status) VALUES (?, ?, ?, 'N-001-A', 10, 'E350', 'MS', 250000, 20, 'planned')", [COMPANY, line2, lot1]);
  await postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId: P, quantity: 2, unitCost: 1000 }] });
  for (const l of [lot1, lot2]) {
    const r = await ins('INSERT INTO cf_material_requirements (company_id, release_id, production_item_id, step_id, item_id, bom_line_id, quantity) VALUES (?, ?, ?, ?, ?, NULL, 1)', [COMPANY, rel2, CPN, cutN, P]);
    await db.query("INSERT INTO cf_stock_reservations (company_id, requirement_id, item_id, quantity, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, r, P]);
    void l;
  }
  const plates0 = await bal(store, P);
  await go(cutN, 'done', 4);
  ok('the gate’s cut takes BOTH plates of the group', (await bal(store, P)) === plates0 - 2, `${plates0} → ${await bal(store, P)}`);
  ok('...the group’s cut pieces (4) are in work in progress', (await inWip(CPN)) === 4);
  // 2 plates × 157 kg = 314 kg, ₹2,000. Cut pieces 4 × 30 kg = 120 kg → ₹764.33; offcut 20 kg → ₹127.39.
  ok('cut pieces carry 120 kg of 314 kg = ₹764.33', near(Number((await lotOf(CPN)).unit_cost) * 4, 764.33), String((await lotOf(CPN)).unit_cost));
  const [[oc]] = await db.query('SELECT * FROM cf_offcuts WHERE id = ?', [off]);
  ok('the offcut is AVAILABLE and is a stock piece now', oc.status === 'available' && oc.batch_id != null);
  const [[ob]] = await db.query('SELECT b.*, m.code item_code, m.name item_name FROM cf_stock_batches b JOIN cf_master_records m ON m.id = b.item_id WHERE b.id = ?', [oc.batch_id]);
  ok('...of the steel’s Offcut item, named by the order and offcut, in WIP, worth 20 kg = ₹127.39', /^OFC-10-E350$/.test(ob.item_code) && ob.code === `${tag}-SO-N-001-A` && (await bal(await wipId(), ob.item_id, ob.id)) === 1 && near(ob.unit_cost, 127.39),
    JSON.stringify({ code: ob.code, item: ob.item_code, unit: ob.unit_cost }));
  await go(cutN, 'in_progress');
  ok('undoing the cut (nothing moved on yet) puts both plates back and the offcut back to planned',
    (await bal(store, P)) === plates0 && (await inWip(CPN)) === 0 && (await db.query('SELECT status FROM cf_offcuts WHERE id = ?', [off]))[0][0].status === 'planned');

  section('9. A part started before its cut piece exists: the cut piece joins it when the plate is cut');
  const drillN = await ins('INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, step_name, quantity) VALUES (?, ?, ?, 10, ?, 1)', [COMPANY, PN, op.id, 'Drill']);
  await go(drillN, 'in_progress');
  ok('the part starts with nothing inside (the floor recorded it first) — not refused', (await inWip(PN)) === 1 && (await inWip(CPN)) === 0);
  await go(cutN, 'done', 4);
  ok('the plate is cut: the 4 cut pieces join the started part at once', (await inWip(CPN)) === 0 && (await inWip(PN)) === 1);
  ok('...and the part now carries their value (₹764.33)', near((await lotOf(PN)).unit_cost, 764.33), String((await lotOf(PN)).unit_cost));
  const again2 = await ledgerOnSteps(db, c, [drillN, cutN]);
  ok('reconciling again posts nothing', again2.movements === 0, JSON.stringify(again2));

  section('10. The screens read it back');
  const w = await wipStock(db, COMPANY, { orderId: so.id });
  const lots = w.orders.flatMap((o) => o.lots);
  ok('Work in progress: the started part PN is there, holding its 4 cut pieces', lots.some((l) => l.productionItemId === PN && l.quantity === 1 && l.contains.some((x) => x.quantity === 4)), JSON.stringify(lots.map((l) => [l.code, l.quantity, l.contains.length])));
  ok('...by level, with a value', w.byLevel.length > 0 && w.totals.lots === lots.length && w.totals.value > 0, JSON.stringify(w.totals));
  ok('...and the available offcut counted (20 kg)', w.offcuts.count >= 1 && w.offcuts.kg >= 20, JSON.stringify(w.offcuts));
  const ocList = await listOffcuts(db, COMPANY, { status: 'available', search: tag, paged: 1 });
  ok('Offcuts: N-001-A is available, with its order, nest lot, value and lot', ocList.rows.some((r) => r.offcutNo === 'N-001-A' && r.origin.lotNo === 'N-001' && near(r.value, 127.39) && r.batch && r.item?.code === 'OFC-10-E350'), JSON.stringify(ocList.rows.map((r) => [r.offcutNo, r.status, r.value])));
  ok('...counted by status', (ocList.counts.status.available ?? 0) >= 1);
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
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
