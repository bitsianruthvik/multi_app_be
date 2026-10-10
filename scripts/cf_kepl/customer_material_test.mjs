/**
 * customer_material_test.mjs — stock OWNERSHIP (CF_ERP_MONEY_PLAN §1, init.sql
 * §35): a customer's material is received as theirs, is used only for their
 * order (theirs first, then ours), is nested first on their order and never on
 * another customer's, leaves offcuts that are theirs, goes back to them, and
 * reconciles per order. Against the local database.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/customer_material_test.mjs
 *
 *   CF_OWNER_COMPANY (2)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table and prove each is back where it
 * started. It OWNS its fixture (tagged with a run id): two customers (A, B), a
 * supplier, an order for each, a storage area, a stud and a plate of a
 * thickness nothing else has (6.543 mm, so it is the only nesting candidate),
 * two nested lines and two released lines. All it borrows from the tenant is
 * the PLATE / CUT_PLATE classification and the size specifications, which is
 * what nesting looks things up by. The packer is a stub (one piece per plate,
 * sheets in the order given), passed through planNesting's `pack` seam.
 *
 *   1. receive: a lot owned by the customer, for the order, at no cost to us
 *   2. their stock is usable only by their order (availability, issue)
 *   3. nesting: their plates first on their order, never another customer's;
 *      offcuts inherit the plate's owner
 *   4. reserve all (batched) and reserve one respect the owner: theirs first
 *   5. issue: their material to their order; job cost keeps it apart
 *   6. return: their lots, their offcuts, scrap by weight
 *   7. reconciliation balances; valuation keeps their material apart
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const STOCK = await imp('apps/cf_erp/services/stockService.js');
const ROLL = await imp('apps/cf_erp/services/rollOutService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const NEST = await imp('apps/cf_erp/services/nestingService.js');
const OWN = await imp('apps/cf_erp/services/ownershipService.js');
const VAL = await imp('apps/cf_erp/services/valuationService.js');

const COMPANY = Number(process.env.CF_OWNER_COMPANY ?? 2);
const RUN = `CM${Date.now().toString(36).toUpperCase()}`;
const T = 6.543;                         // a thickness nothing else in the catalog has
const PLATE_L = 2500;
const PLATE_W = 1250;

let passed = 0;
let failed = 0;
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, eps = 0.005) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
const eq = (label, got, want) => ok(label, typeof want === 'number' ? near(got, want) : got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (t) => console.log(`\n${t}`);

async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
async function expectRefusal(label, fn, re) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  const text = err ? [err.message, ...(err.problems ?? err.details?.problems ?? [])].join(' | ') : '';
  ok(label, !!err && (!re || re.test(text)), err ? text : 'it was allowed');
}

/** One piece per plate, plates taken in the order given, each only as often as it is available. */
function onePerPlate({ pieces, sheets, margin: trim, kerf, gap }) {
  // As the real packer: one kerf is cut off each edge by the packer itself; `margin` is a trim on top (0 since 2026-10-10).
  const margin = (Number(trim) || 0) + (Number(kerf ?? gap) || 0);
  const left = sheets.map((s) => ({ ...s, left: s.available == null ? Infinity : s.available }));
  const nests = [];
  const unplaced = [];
  for (const p of pieces) {
    for (let k = 0; k < p.qty; k += 1) {
      const s = left.find((x) => x.left > 0 && p.length <= x.length - 2 * margin && p.width <= x.width - 2 * margin);
      if (!s) { unplaced.push({ key: p.key, qty: 1, reason: 'no plate left' }); continue; }
      s.left -= 1;
      nests.push({ sheetKey: s.key, preferred: !!s.preferred, pieces: [{ key: p.key, x: margin, y: margin, length: p.length, width: p.width, rotated: false, seqNo: 1, rowNo: 1 }] });
    }
  }
  return { nests, unplaced, deterministic: true, elapsedMs: 0, sizeAdvice: [] };
}

async function fixture(db) {
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const nodeByCode = async (code) => {
    const [[n]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (!n) throw new Error(`This company has no ${code} classification node — the cf_erp taxonomy is not set up here.`);
    return n.id;
  };
  const specByCode = async (code, dataType) => {
    const [[s]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    return s ? s.id : ins("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, code, code, dataType]);
  };
  const oneOption = async (specId) => {
    const [[o]] = await db.query('SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY, specId]);
    return o ? o.id : ins("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, 'active')", [COMPANY, specId, `${RUN}-OPT`]);
  };
  const plateNode = await nodeByCode('PLATE');
  const cutNode = await nodeByCode('CUT_PLATE');
  const spec = {
    THICKNESS: await specByCode('THICKNESS', 'number'), LENGTH: await specByCode('LENGTH', 'number'),
    WIDTH: await specByCode('WIDTH', 'number'), DENSITY: await specByCode('DENSITY', 'number'),
    GRADE: await specByCode('GRADE', 'option'), MATERIAL: await specByCode('MATERIAL', 'option'),
  };
  const grade = await oneOption(spec.GRADE);
  const material = await oneOption(spec.MATERIAL);
  const setSize = async (id, l, w) => {
    for (const [s, n, o] of [[spec.THICKNESS, T], [spec.LENGTH, l], [spec.WIDTH, w], [spec.DENSITY, 7850], [spec.GRADE, null, grade], [spec.MATERIAL, null, material]]) {
      await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, option_id, source) VALUES (?, ?, 'master', ?, ?, ?, 'entered')",
        [COMPANY, s, id, n ?? null, o ?? null]);
    }
  };
  const master = async (key, classificationId, itemType, trackedBy = 'quantity', ownerLineId = null) => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')",
      [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, classificationId]);
    await db.query('INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id) VALUES (?, ?, ?, ?, \'nos\', ?, ?)',
      [id, COMPANY, itemType, trackedBy, itemType === 'temporary' ? 'make' : 'stock', ownerLineId]);
    return id;
  };
  const party = (key, isCustomer, isSupplier) => ins('INSERT INTO cf_parties (company_id, code, name, is_customer, is_supplier, status) VALUES (?, ?, ?, ?, ?, \'active\')',
    [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, isCustomer ? 1 : 0, isSupplier ? 1 : 0]);
  const CA = await party('CUSTA', true, false);
  const CB = await party('CUSTB', true, false);
  const SUP = await party('SUP', false, true);
  const order = (key, customer) => ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, customer_id) VALUES (?, ?, 'customer', 'Customer material fixture', 'confirmed', ?)",
    [COMPANY, `${RUN}-${key}`, customer]);
  const OA = await order('SOA', CA);
  const OB = await order('SOB', CB);
  const area = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')", [COMPANY, `${RUN}-ST`, `${RUN} store`]);

  // The plate (counted by quantity, so the customer's plates are lots of a quantity item) and a stud.
  const P = await master('PL', plateNode, 'catalog');
  await setSize(P, PLATE_L, PLATE_W);
  const S = await master('STUD', plateNode, 'catalog');

  // A nested line per order: a root and a 900 x 400 cut plate, 4 of them, on the plate.
  const nestLine = async (orderId, lineNo) => {
    const root = await master(`ROOT${lineNo}${orderId}`, cutNode, 'temporary', 'individual');
    // Frozen (locked_at): nesting lays out a frozen design only (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30).
    const lineId = await ins("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at) VALUES (?, ?, ?, 'custom', ?, ?, 1, 1, NOW())",
      [COMPANY, orderId, lineNo, root, root]);
    await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [lineId, COMPANY, root]);
    const cp = await master(`CP${lineNo}${orderId}`, cutNode, 'temporary', 'individual', lineId);
    await setSize(cp, 900, 400);
    const bom = await ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, 'custom', 'active')", [COMPANY, root]);
    await db.query('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, 1, ?, ?, 1, 4)', [COMPANY, bom, cp, cp]);
    const bom2 = await ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, 'custom', 'active')", [COMPANY, cp]);
    await db.query('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, 1, ?, ?, 1, ?)', [COMPANY, bom2, P, P, (900 * 400) / (PLATE_L * PLATE_W)]);
    return lineId;
  };
  const LA = await nestLine(OA, 10);
  const LB = await nestLine(OB, 10);

  // A released line per order, its requirements written straight in (release itself is release_batch_test's).
  const releaseLine = async (orderId, lineNo, reqs) => {
    const lineId = await ins("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity) VALUES (?, ?, ?, 'standard', ?, ?, 2, 1)",
      [COMPANY, orderId, lineNo, S, S]);
    const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 1)', [COMPANY, orderId, lineId, S]);
    const ids = {};
    for (const [key, itemId, qty] of reqs) ids[key] = await ins('INSERT INTO cf_material_requirements (company_id, release_id, item_id, quantity) VALUES (?, ?, ?, ?)', [COMPANY, rel, itemId, qty]);
    return { lineId, rel, ids };
  };
  const RA = await releaseLine(OA, 20, [['plate', P, 3], ['stud', S, 4]]);
  const RB = await releaseLine(OB, 20, [['plate', P, 7]]);
  return { CA, CB, SUP, OA, OB, area, P, S, LA, LB, RA, RB };
}

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  console.log(`Company ${COMPANY} — run ${RUN}`);
  const F = await fixture(conn);
  const post = (input) => STOCK.postMovement(conn, c, input);

  section('1. Receive: a lot owned by the customer, for their order');
  const ra = await OWN.receiveCustomerMaterial(conn, c, { orderId: F.OA, toAreaId: F.area, lines: [{ itemId: F.P, quantity: 2, unitCost: 9000 }, { itemId: F.S, quantity: 6 }] });
  const lotPA = ra.lines[0].batch;
  const lotSA = ra.lines[1].batch;
  ok('a plate counted by quantity still arrives as a LOT when it is the customer\'s', !!lotPA?.id);
  eq('the lot is customer A\'s', ra.lines[0].owner?.party?.id, F.CA);
  eq('…for order A', ra.lines[0].owner?.order?.id, F.OA);
  eq('the receipt names customer A', ra.party?.id, F.CA);
  eq('…and order A', ra.order?.id, F.OA);
  eq('the reference cost is kept on the line', ra.lines[0].value, 18000);
  const rb = await OWN.receiveCustomerMaterial(conn, c, { orderId: F.OB, toAreaId: F.area, lines: [{ itemId: F.P, quantity: 3 }] });
  const lotPB = rb.lines[0].batch;
  await post({ movementType: 'receipt', partyId: F.SUP, toAreaId: F.area, lines: [{ itemId: F.P, quantity: 4, unitCost: 8000 }, { itemId: F.S, quantity: 10, unitCost: 5 }] });
  const [[lotRow]] = await conn.query('SELECT owner_party_id, owner_order_id, supplier_id FROM cf_stock_batches WHERE id = ?', [lotPA.id]);
  ok('the lot row holds the owner and the order, and no supplier', lotRow.owner_party_id === F.CA && lotRow.owner_order_id === F.OA && lotRow.supplier_id == null, JSON.stringify(lotRow));
  const [[pool0]] = await conn.query('SELECT COUNT(*) AS n FROM cf_item_costs WHERE company_id = ? AND item_id = ? AND owner_key <> 0', [COMPANY, F.P]);
  eq('customer material never joins our average', Number(pool0.n), 0);
  await expectRefusal('an order that is not the customer\'s is refused', () => post({ movementType: 'receipt', toAreaId: F.area, lines: [{ itemId: F.P, quantity: 1, ownerPartyId: F.CB, ownerOrderId: F.OA }] }), /not .*CUSTB's/);
  await expectRefusal('our stock is never received into their lot', () => post({ movementType: 'receipt', partyId: F.SUP, toAreaId: F.area, lines: [{ itemId: F.P, quantity: 1, batchId: lotPA.id }] }), /customer|CUSTA/i);
  const st = await STOCK.itemStock(conn, COMPANY, F.P);
  eq('the plate: 4 of ours free', st.totals.free, 4);
  eq('…and 5 of the customers\'', st.totals.customers.free, 5);
  eq('our value is ours only (4 × 8,000)', st.totals.value, 32000);

  section('2. Their stock is usable only by their order');
  const avNone = (await ROLL.availability(conn, COMPANY, [F.P])).get(F.P);
  eq('with no order, only ours counts', avNone.free, 4);
  const avA = (await ROLL.availability(conn, COMPANY, [F.P], { orderId: F.OA })).get(F.P);
  eq('for order A: ours + A\'s = 6', avA.free, 6);
  eq('…2 of them A\'s', avA.theirsFree, 2);
  eq('A\'s lot comes first', avA.batches[0]?.batchId, lotPA.id);
  ok('B\'s lot never shows for order A', !avA.batches.some((b) => b.batchId === lotPB.id));
  const avB = (await ROLL.availability(conn, COMPANY, [F.P], { orderId: F.OB })).get(F.P);
  eq('for order B: ours + B\'s = 7', avB.free, 7);
  ok('A\'s lot never shows for order B', !avB.batches.some((b) => b.batchId === lotPA.id));
  await expectRefusal('A\'s material is not issued to order B', () => post({ movementType: 'issue', fromAreaId: F.area, orderId: F.OB, lines: [{ itemId: F.P, quantity: 1, batchId: lotPA.id }] }), /used only for their order/);
  await expectRefusal('…nor issued with no order at all', () => post({ movementType: 'issue', fromAreaId: F.area, lines: [{ itemId: F.P, quantity: 1, batchId: lotPA.id }] }), /issued only to their order/);
  const own = await ROLL.ownFreeStock(conn, COMPANY, [F.P, F.S]);
  ok('ownFreeStock (for the buy list) is ours only', own.get(F.P) === 4 && own.get(F.S) === 10, JSON.stringify([...own]));

  section('3. Nesting: their plates first on their order, never another customer\'s');
  // §44: a line's nesting must be told which plates it may use before it runs.
  await conn.query("UPDATE cf_sales_order_lines SET nest_plates = 'any' WHERE company_id = ? AND id IN (?)", [COMPANY, [F.LA, F.LB]]);
  const planA = await NEST.planNesting(conn, COMPANY, F.LA, { pack: onePerPlate, effort: 'quick', seed: 1 });
  const nestsA = planA.groups.flatMap((g) => g.nests);
  eq('4 pieces, one per plate: 4 lots', nestsA.length, 4);
  eq('A\'s 2 plates are used first', nestsA.filter((n) => n.ownerPartyId === F.CA).length, 2);
  eq('the other 2 are ours (bought)', nestsA.filter((n) => n.ownerPartyId == null).length, 2);
  ok('no lot is ever B\'s', !nestsA.some((n) => n.ownerPartyId === F.CB));
  ok('a customer\'s plate is a catalog plate, not an offcut', nestsA.every((n) => n.source === 'catalog'));
  const planB = await NEST.planNesting(conn, COMPANY, F.LB, { pack: onePerPlate, effort: 'quick', seed: 1 });
  const nestsB = planB.groups.flatMap((g) => g.nests);
  eq('order B nests on its own 3 plates first', nestsB.filter((n) => n.ownerPartyId === F.CB).length, 3);
  ok('…and never on A\'s', !nestsB.some((n) => n.ownerPartyId === F.CA));
  const forged = JSON.parse(JSON.stringify(planA));
  forged.groups[0].nests[0].ownerPartyId = F.CB;
  await expectRefusal('accepting a lot on another customer\'s plate is refused', () => NEST.acceptNesting(conn, c, F.LA, forged), /another customer's|never used for this order/);
  const greedy = JSON.parse(JSON.stringify(planA));
  greedy.groups[0].nests.forEach((n) => { n.ownerPartyId = F.CA; });
  await expectRefusal('…and more of their plates than they sent', () => NEST.acceptNesting(conn, c, F.LA, greedy), /only 2 free/);
  await NEST.acceptNesting(conn, c, F.LA, planA);
  const [lots] = await conn.query('SELECT id, owner_party_id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, F.LA]);
  eq('the saved lots: 2 of A\'s', lots.filter((l) => l.owner_party_id === F.CA).length, 2);
  const [offcuts] = await conn.query(
    'SELECT o.id, o.owner_party_id, l.owner_party_id AS lot_owner FROM cf_offcuts o JOIN cf_plate_lots l ON l.id = o.plate_lot_id WHERE o.company_id = ? AND o.order_line_id = ? AND o.deleted_at IS NULL',
    [COMPANY, F.LA],
  );
  ok('the lots left offcuts', offcuts.length >= 4, `${offcuts.length}`);
  ok('every offcut is whoever\'s plate it was cut from', offcuts.every((o) => (o.owner_party_id ?? 0) === (o.lot_owner ?? 0)));
  const theirOffcuts = offcuts.filter((o) => o.owner_party_id === F.CA).map((o) => o.id);
  const ourOffcut = offcuts.find((o) => o.owner_party_id == null)?.id;
  ok('some offcuts are A\'s', theirOffcuts.length > 0);

  section('4. Reserve all and reserve one respect the owner');
  const outA = await REL.reserveRelease(conn, c, F.RA.rel);
  const [resA] = await conn.query("SELECT requirement_id, batch_id, quantity FROM cf_stock_reservations WHERE company_id = ? AND requirement_id IN (?) AND status = 'active' ORDER BY id", [COMPANY, Object.values(F.RA.ids)]);
  const plateA = resA.filter((r) => r.requirement_id === F.RA.ids.plate);
  ok('the plate: A\'s 2 first, then 1 of ours', plateA.length === 2 && plateA[0].batch_id === lotPA.id && near(plateA[0].quantity, 2) && plateA[1].batch_id == null && near(plateA[1].quantity, 1), JSON.stringify(plateA));
  const studA = resA.filter((r) => r.requirement_id === F.RA.ids.stud);
  ok('the stud (counted by quantity): 4 from A\'s lot, none of ours', studA.length === 1 && studA[0].batch_id === lotSA.id && near(studA[0].quantity, 4), JSON.stringify(studA));
  eq('nothing short for A', outA.short.length, 0);
  await expectRefusal('reserving A\'s lot for order B is refused', () => REL.reserveRequirement(conn, c, F.RB.ids.plate, { batchId: lotPA.id }), /nothing free/i);
  const outB = await REL.reserveRelease(conn, c, F.RB.rel);
  const [resB] = await conn.query("SELECT batch_id, quantity FROM cf_stock_reservations WHERE company_id = ? AND requirement_id = ? AND status = 'active' ORDER BY id", [COMPANY, F.RB.ids.plate]);
  ok('order B: B\'s 3 first, then the 3 of ours left', resB.length === 2 && resB[0].batch_id === lotPB.id && near(resB[0].quantity, 3) && resB[1].batch_id == null && near(resB[1].quantity, 3), JSON.stringify(resB));
  ok('never A\'s', !resB.some((r) => r.batch_id === lotPA.id));
  ok('one plate short for B', outB.short.length === 1 && near(outB.short[0].short, 1), JSON.stringify(outB.short));

  section('5. Issue: their material to their order; job cost keeps it apart');
  await REL.issueRequirement(conn, c, F.RA.ids.plate);
  const [iss] = await conn.query(
    `SELECT m.order_id, m.order_line_id, l.batch_id, l.quantity, l.value FROM cf_stock_movements m JOIN cf_stock_ledger l ON l.movement_id = m.id
      WHERE m.company_id = ? AND m.movement_type = 'issue' AND m.order_id = ? ORDER BY l.id`,
    [COMPANY, F.OA],
  );
  ok('issued: A\'s 2 and 1 of ours, to order A, on its line', iss.length === 2 && iss.every((r) => r.order_id === F.OA && r.order_line_id === F.RA.lineId), JSON.stringify(iss));
  const jc = await VAL.orderCosts(conn, COMPANY, F.OA);
  const jl = jc.lines.find((l) => l.line.id === F.RA.lineId);
  eq('our plate issued at cost: 8,000', jl.issued.value, 8000);
  eq('A\'s plates shown apart at their reference cost: 18,000', jl.customerIssued.value, 18000);
  const nl = jc.lines.find((l) => l.line.id === F.LA);
  eq('the nest: 4 lots', nl.nest.lots, 4);
  eq('…2 on A\'s plates (not our cost)', nl.nest.customerLots, 2);
  eq('…our 2 at the plate cost issued / on hand: 16,000', nl.nest.plateValue, 16000);
  ok('…with wastage and offcut value', nl.nest.wastageValue > 0 && nl.nest.offcutValue > 0, JSON.stringify(nl.nest));

  section('6. Return: their lots, their offcuts, scrap by weight');
  await expectRefusal('our offcut does not go back', () => OWN.returnToCustomer(conn, c, { orderId: F.OA, offcutIds: [ourOffcut] }), /our plate/);
  await expectRefusal('B\'s lot does not go back to A', () => OWN.returnToCustomer(conn, c, { orderId: F.OA, fromAreaId: F.area, lines: [{ itemId: F.P, batchId: lotPB.id, quantity: 1 }] }), /CUSTB|not .*CUSTA/);
  await expectRefusal('a reserved part of their lot cannot go back', () => OWN.returnToCustomer(conn, c, { orderId: F.OA, fromAreaId: F.area, lines: [{ itemId: F.S, batchId: lotSA.id, quantity: 3 }] }), /reserved/);
  const back = await OWN.returnToCustomer(conn, c, {
    orderId: F.OA, fromAreaId: F.area, offcutIds: theirOffcuts, scrapKg: 12.5,
    lines: [{ itemId: F.S, batchId: lotSA.id, quantity: 2 }],
  });
  eq('one return movement', back.movement.movementType, 'return');
  eq('to customer A', back.movement.party?.id, F.CA);
  eq('with the scrap weight on it', back.movement.returnKg, 12.5);
  eq('the offcuts are marked returned against it', back.offcutsReturned.length, theirOffcuts.length);
  await expectRefusal('an offcut goes back once', () => OWN.returnToCustomer(conn, c, { orderId: F.OA, offcutIds: [theirOffcuts[0]] }), /already returned/);
  const onlyScrap = await OWN.returnToCustomer(conn, c, { orderId: F.OA, scrapKg: 2.5 });
  eq('scrap alone goes back on a movement with no stock lines', onlyScrap.movement.lines.length, 0);

  section('7. Reconciliation balances; valuation keeps their material apart');
  const rec = await OWN.materialReconciliation(conn, COMPANY, F.OA);
  const rp = rec.items.find((r) => r.item.id === F.P);
  const rs = rec.items.find((r) => r.item.id === F.S);
  ok('plate: received 2, issued 2, with us 0', near(rp.received.qty, 2) && near(rp.issued.qty, 2) && near(rp.withUs.qty, 0), JSON.stringify(rp));
  ok('stud: received 6, returned 2, with us 4', near(rs.received.qty, 6) && near(rs.returned.qty, 2) && near(rs.withUs.qty, 4), JSON.stringify(rs));
  ok('every item balances against the shelves', rec.items.every((r) => r.balances));
  const plateKg = (PLATE_L * PLATE_W * T / 1e9) * 7850;
  eq('the plate is weighed from its size', rp.kgPerUnit, Number(plateKg.toFixed(3)));
  eq('received in kg', rp.received.kg, Number((2 * plateKg).toFixed(3)));
  eq('their offcuts: all returned', rec.offcuts.returned.count, theirOffcuts.length);
  eq('none of theirs left with us', rec.offcuts.withUs.count, 0);
  ok('only A\'s offcuts are counted, not ours', rec.offcuts.total.count === theirOffcuts.length, JSON.stringify(rec.offcuts.total));
  eq('scrap returned 12.5 + 2.5 kg', rec.scrap.returnedKg, 15);
  ok('scrap from their plates\' nests is known', rec.scrap.fromNestsKg > 0, JSON.stringify(rec.scrap));
  const recB = await OWN.materialReconciliation(conn, COMPANY, F.OB);
  ok('order B: received 3, all still with us', recB.items.length === 1 && near(recB.items[0].received.qty, 3) && near(recB.items[0].withUs.qty, 3), JSON.stringify(recB.items));
  const byOwner = await VAL.stockValuation(conn, COMPANY, { groupBy: 'owner', itemId: F.P });
  const gA = byOwner.groups.find((g) => g.key === `party:${F.CA}`);
  const gB = byOwner.groups.find((g) => g.key === `party:${F.CB}`);
  ok('valuation by owner: A holds no plate any more', !gA, JSON.stringify(gA));
  ok('B\'s 3 plates are theirs, apart from ours', !!gB && near(gB.customers.quantity, 3), JSON.stringify(gB));
  eq('ours: 3 plates at 8,000', byOwner.ours.value, 24000);
  ok('the ledger and balances agree', (await STOCK.checkLedger(conn, COMPANY)).ok);

  detachNodeCache(conn);
  await conn.rollback();
  const after = await census(conn);
  const moved = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
  ok('every cf_ table is back to its count', moved.length === 0, moved.map((t) => `${t} ${before[t]}->${after[t]}`).join(', '));
} catch (e) {
  exitCode = 1;
  console.error(e);
  try { await conn.rollback(); } catch { /* already gone */ }
} finally {
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed || exitCode ? 1 : 0);
