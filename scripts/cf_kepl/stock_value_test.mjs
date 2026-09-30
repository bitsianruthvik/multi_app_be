/**
 * stock_value_test.mjs — the COST of stock (CF_ERP_MONEY_PLAN §2, init.sql §35):
 * a receipt sets it, issue / scrap / a count move value out at the stock's
 * cost, a transfer keeps it, a reversal moves the exact opposite, and NULL is
 * "not costed" — never 0. Against the local database.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/stock_value_test.mjs
 *
 *   CF_VALUE_COMPANY (2)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table and prove each is back where it
 * started. It OWNS its fixture (tagged with a run id): a classification branch,
 * a supplier, two storage areas, four items — Q counted by quantity (weighted
 * average), B kept by batch (cost per lot), I tracked unit by unit (a unit is
 * production's lot of one), N counted by quantity with stock that came in
 * before costs were kept — and an order with a line for job cost.
 *
 *   1. quantity: receipts make a weighted average; an issue leaves at it
 *   2. transfer keeps cost; scrap and a count move value at the average
 *   3. a reversal moves the exact opposite value
 *   4. batch: each lot keeps its cost; a top-up blends it
 *   5. individual: each unit (lot) keeps its own cost
 *   6. not costed: NULL, never 0 — and costed stock leaves first
 *   7. valuation sums (by item, area, owner) and the item cost summary
 *   8. job cost: issued to an order line at cost, scrap value
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const STOCK = await imp('apps/cf_erp/services/stockService.js');
const VAL = await imp('apps/cf_erp/services/valuationService.js');

const COMPANY = Number(process.env.CF_VALUE_COMPANY ?? 2);
const RUN = `SV${Date.now().toString(36).toUpperCase()}`;

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

async function fixture(db, c) {
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const node = (parent, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parent, depth, `${RUN}-${key}`, `${RUN} ${key}`],
  );
  const fam = await node(null, 0, 'FAM');
  const sub = await node(fam, 1, 'SUB');
  const variant = await node(sub, 2, 'VAR');
  const item = async (key, trackedBy) => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')",
      [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, variant]);
    await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', ?, 'nos', 'stock')",
      [id, COMPANY, trackedBy]);
    return id;
  };
  const area = (key) => ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')",
    [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`]);
  const supplier = await ins("INSERT INTO cf_parties (company_id, code, name, is_supplier, status) VALUES (?, ?, ?, 1, 'active')",
    [COMPANY, `${RUN}-SUP`, `${RUN} Supplier`]);
  const customer = await ins("INSERT INTO cf_parties (company_id, code, name, is_customer, status) VALUES (?, ?, ?, 1, 'active')",
    [COMPANY, `${RUN}-CUS`, `${RUN} Customer`]);
  const Q = await item('Q', 'quantity');
  const B = await item('B', 'batch');
  const I = await item('I', 'individual');
  const N = await item('N', 'quantity');
  const A1 = await area('A1');
  const A2 = await area('A2');
  const order = await ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, customer_id) VALUES (?, ?, 'customer', 'Stock value fixture', 'confirmed', ?)",
    [COMPANY, `${RUN}-SO`, customer]);
  const line = await ins("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity) VALUES (?, ?, 10, 'standard', ?, ?, 1, 1)",
    [COMPANY, order, Q, Q]);
  return { supplier, customer, Q, B, I, N, A1, A2, order, line };
}

const pool1 = async (db, itemId) => {
  const [[r]] = await db.query('SELECT avg_unit_cost, costed_qty FROM cf_item_costs WHERE company_id = ? AND item_id = ? AND owner_key = 0', [COMPANY, itemId]);
  return r ? { avg: r.avg_unit_cost == null ? null : Number(r.avg_unit_cost), qty: Number(r.costed_qty) } : null;
};
const ledgerOf = async (db, movementId) => {
  const [rows] = await db.query('SELECT stocking_area_id, quantity, unit_cost, value FROM cf_stock_ledger WHERE company_id = ? AND movement_id = ? ORDER BY id', [COMPANY, movementId]);
  return rows.map((r) => ({ area: r.stocking_area_id, qty: Number(r.quantity), unit: r.unit_cost == null ? null : Number(r.unit_cost), value: r.value == null ? null : Number(r.value) }));
};

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  console.log(`Company ${COMPANY} — run ${RUN}`);
  const F = await fixture(conn, c);
  const post = (input, opts) => STOCK.postMovement(conn, c, input, opts);

  section('1. Quantity item: receipts make a weighted average, an issue leaves at it');
  const r1 = await post({ movementType: 'receipt', partyId: F.supplier, toAreaId: F.A1, lines: [{ itemId: F.Q, quantity: 10, unitCost: 100 }] });
  eq('the receipt line carries its unit cost', r1.lines[0].unitCost, 100);
  eq('…and its value', r1.lines[0].value, 1000);
  eq('the movement is worth 1,000', r1.value, 1000);
  let p = await pool1(conn, F.Q);
  eq('the average is 100', p.avg, 100);
  eq('over 10', p.qty, 10);
  const r2 = await post({ movementType: 'receipt', partyId: F.supplier, toAreaId: F.A1, lines: [{ itemId: F.Q, quantity: 10, unitCost: 130 }] });
  p = await pool1(conn, F.Q);
  eq('a second receipt at 130 makes the average 115', p.avg, 115);
  eq('over 20', p.qty, 20);
  const is1 = await post({ movementType: 'issue', fromAreaId: F.A1, lines: [{ itemId: F.Q, quantity: 5 }] });
  eq('an issue leaves at the average', is1.lines[0].unitCost, 115);
  eq('value 575', is1.lines[0].value, 575);
  eq('signed: the stock lost 575', is1.lines[0].valueChange, -575);
  const l1 = await ledgerOf(conn, is1.id);
  eq('the ledger row holds -575', l1[0].value, -575);
  p = await pool1(conn, F.Q);
  eq('the average stays 115', p.avg, 115);
  eq('the costed quantity falls to 15', p.qty, 15);

  section('2. Transfer keeps cost; scrap and a count move value at the average');
  const tr = await post({ movementType: 'transfer', fromAreaId: F.A1, toAreaId: F.A2, lines: [{ itemId: F.Q, quantity: 5 }] });
  const lt = await ledgerOf(conn, tr.id);
  ok('both legs at 115', lt.every((l) => near(l.unit, 115)), JSON.stringify(lt));
  ok('-575 out of A1, +575 into A2', lt.some((l) => l.area === F.A1 && near(l.value, -575)) && lt.some((l) => l.area === F.A2 && near(l.value, 575)), JSON.stringify(lt));
  eq('the movement is worth 575 (the two legs once)', tr.value, 575);
  p = await pool1(conn, F.Q);
  ok('the average and its quantity are untouched', near(p.avg, 115) && near(p.qty, 15), JSON.stringify(p));
  const sc = await post({ movementType: 'scrap', fromAreaId: F.A2, reason: 'damaged', lines: [{ itemId: F.Q, quantity: 1 }] });
  eq('scrap is valued at the average', sc.lines[0].value, 115);
  const cnt = await post({ movementType: 'adjustment', areaId: F.A2, reason: 'count', lines: [{ itemId: F.Q, countedQuantity: 5 }] });
  eq('a count that finds one more values it at the average', cnt.lines[0].valueChange, 115);
  p = await pool1(conn, F.Q);
  eq('…and it joins the average (15 again)', p.qty, 15);
  await expectRefusal('only a receipt carries a cost', () => post({ movementType: 'issue', fromAreaId: F.A1, lines: [{ itemId: F.Q, quantity: 1, unitCost: 5 }] }), /only a receipt carries a cost/);

  section('3. A reversal moves the exact opposite value');
  const rv = await STOCK.reverseMovement(conn, c, sc.id, { reason: 'found it' });
  const lr = await ledgerOf(conn, rv.id);
  ok('the reversal puts +115 back at 115', near(lr[0].value, 115) && near(lr[0].unit, 115), JSON.stringify(lr));
  p = await pool1(conn, F.Q);
  ok('the average is still 115 over 16', near(p.avg, 115) && near(p.qty, 16), JSON.stringify(p));

  section('4. Batch: each lot keeps its cost, a top-up blends it');
  const b1 = await post({ movementType: 'receipt', partyId: F.supplier, toAreaId: F.A1, lines: [{ itemId: F.B, quantity: 5, unitCost: 2000, batch: {} }] });
  const b2 = await post({ movementType: 'receipt', partyId: F.supplier, toAreaId: F.A1, lines: [{ itemId: F.B, quantity: 5, unitCost: 2500, batch: {} }] });
  const lot1 = b1.lines[0].batch.id;
  const lot2 = b2.lines[0].batch.id;
  const [[lot1Row]] = await conn.query('SELECT unit_cost FROM cf_stock_batches WHERE id = ?', [lot1]);
  eq('the lot holds its receipt cost', Number(lot1Row.unit_cost), 2000);
  const bi = await post({ movementType: 'issue', fromAreaId: F.A1, lines: [{ itemId: F.B, quantity: 2, batchId: lot2 }] });
  eq('an issue from a lot leaves at THAT lot\'s cost', bi.lines[0].value, 5000);
  const top = await post({ movementType: 'receipt', partyId: F.supplier, toAreaId: F.A1, lines: [{ itemId: F.B, quantity: 5, unitCost: 2600, batchId: lot1 }] });
  eq('a top-up line carries the price it came at', top.lines[0].unitCost, 2600);
  const [[lot1After]] = await conn.query('SELECT unit_cost FROM cf_stock_batches WHERE id = ?', [lot1]);
  eq('the lot\'s cost blends: (5×2000 + 5×2600)/10 = 2300', Number(lot1After.unit_cost), 2300);
  ok('a batch item never touches the average', (await pool1(conn, F.B)) === null);

  section('5. Individual: a unit is production\'s lot of one and keeps its own cost');
  const u1 = await post({ movementType: 'receipt', toAreaId: F.A1, lines: [{ itemId: F.I, quantity: 1, unitCost: 50000, batch: { code: `${RUN}-U1` } }] }, { fromProduction: true });
  const u2 = await post({ movementType: 'receipt', toAreaId: F.A1, lines: [{ itemId: F.I, quantity: 1, unitCost: 60000, batch: { code: `${RUN}-U2` } }] }, { fromProduction: true });
  ok('each unit is its own lot', u1.lines[0].batch.id !== u2.lines[0].batch.id);
  // Production takes a unit back off the shelf (dispatch does the same), so the issue is production's too.
  const ui = await post({ movementType: 'issue', fromAreaId: F.A1, lines: [{ itemId: F.I, quantity: 1, batchId: u2.lines[0].batch.id }] }, { fromProduction: true });
  eq('issuing unit 2 moves unit 2\'s cost', ui.lines[0].value, 60000);

  section('6. Not costed: NULL, never 0 — and costed stock leaves first');
  const n1 = await post({ movementType: 'receipt', partyId: F.supplier, toAreaId: F.A1, lines: [{ itemId: F.N, quantity: 10 }] });
  eq('a receipt with no cost has no unit cost', n1.lines[0].unitCost, null);
  eq('…and no value (not 0)', n1.lines[0].value, null);
  eq('the movement says one row is not costed', n1.uncostedRows, 1);
  let stN = await STOCK.itemStock(conn, COMPANY, F.N);
  eq('its stock row has no value', stN.rows[0].value, null);
  eq('…and 10 not costed', stN.rows[0].uncostedQty, 10);
  const nIss = await post({ movementType: 'issue', fromAreaId: F.A1, lines: [{ itemId: F.N, quantity: 2 }] });
  eq('an issue of not-costed stock is not costed', nIss.lines[0].value, null);
  await post({ movementType: 'receipt', partyId: F.supplier, toAreaId: F.A1, lines: [{ itemId: F.N, quantity: 5, unitCost: 10 }] });
  stN = await STOCK.itemStock(conn, COMPANY, F.N);
  eq('13 on hand, 5 of them costed at 10: value 50', stN.totals.value, 50);
  eq('…and 8 not costed', stN.totals.uncostedQty, 8);
  const nIss2 = await post({ movementType: 'issue', fromAreaId: F.A1, lines: [{ itemId: F.N, quantity: 3 }] });
  eq('costed stock leaves first, at the average', nIss2.lines[0].value, 30);
  p = await pool1(conn, F.N);
  eq('2 costed left', p.qty, 2);

  section('7. Valuation sums and the item cost summary');
  const byItem = await VAL.stockValuation(conn, COMPANY, { groupBy: 'item' });
  const g = (id) => byItem.groups.find((x) => x.item?.id === id);
  // Q: 16 loose at 115. B: lot1 10 @2300, lot2 3 @2500. I: unit 1 @50000. N: 10 on hand, 2 costed @10.
  eq('Q is worth 16 × 115 = 1,840', g(F.Q).ours.value, 1840);
  eq('B is worth 10×2300 + 3×2500 = 30,500', g(F.B).ours.value, 30500);
  eq('I is worth the unit still here, 50,000', g(F.I).ours.value, 50000);
  eq('N is worth 2 × 10 = 20', g(F.N).ours.value, 20);
  eq('…with 8 of it not costed', g(F.N).ours.uncostedQty, 8);
  const rows = await STOCK.listStock(conn, COMPANY, {}, { limit: null });
  const sumRows = rows.filter((r) => !r.owner).reduce((t, r) => t + (r.value ?? 0), 0);
  ok('the groups add up to every row valued', near(byItem.ours.value, sumRows, 0.02), `${byItem.ours.value} vs ${sumRows}`);
  const byArea = await VAL.stockValuation(conn, COMPANY, { groupBy: 'area' });
  ok('by area adds up to the same total', near(byArea.ours.value, byItem.ours.value, 0.02), `${byArea.ours.value} vs ${byItem.ours.value}`);
  const a2 = byArea.groups.find((x) => x.area?.id === F.A2);
  eq('A2 holds 6 of Q at 115 = 690 (the transfer kept its cost)', a2.ours.value, 690);
  const byOwner = await VAL.stockValuation(conn, COMPANY, { groupBy: 'owner' });
  ok('by owner: ours adds up to the same total', near(byOwner.groups.find((x) => x.key === 'ours').ours.value, byItem.ours.value, 0.02));
  const qc = await VAL.itemCost(conn, COMPANY, F.Q);
  eq('Q: last receipt cost 130', qc.lastReceipt.unitCost, 130);
  eq('Q: average cost 115', qc.averageCost, 115);
  eq('Q: stock value 1,840', qc.stock.ours.value, 1840);
  const bc = await VAL.itemCost(conn, COMPANY, F.B);
  eq('B: last receipt cost 2,600', bc.lastReceipt.unitCost, 2600);
  eq('B: average cost of the lots on hand (30,500 / 13)', bc.averageCost, Number((30500 / 13).toFixed(4)));
  const nc = await VAL.itemCost(conn, COMPANY, F.N);
  eq('N: 8 of its stock not costed', nc.stock.ours.uncostedQty, 8);
  ok('the ledger and balances agree', (await STOCK.checkLedger(conn, COMPANY)).ok);

  section('8. Job cost: issued to an order line at cost, scrap booked against the order');
  const ji = await post({ movementType: 'issue', fromAreaId: F.A1, orderId: F.order, orderLineId: F.line, lines: [{ itemId: F.Q, quantity: 2 }] });
  eq('the issue names its line', ji.orderLine?.id, F.line);
  await post({ movementType: 'issue', fromAreaId: F.A1, orderId: F.order, orderLineId: F.line, lines: [{ itemId: F.B, quantity: 1, batchId: lot1 }] });
  await post({ movementType: 'scrap', fromAreaId: F.A2, orderId: F.order, orderLineId: F.line, reason: 'cut wrong', lines: [{ itemId: F.Q, quantity: 1 }] });
  await post({ movementType: 'issue', fromAreaId: F.A1, orderId: F.order, lines: [{ itemId: F.N, quantity: 1 }] });
  const jc = await VAL.orderCosts(conn, COMPANY, F.order);
  const jl = jc.lines.find((l) => l.line.id === F.line);
  eq('material issued to the line: 2×115 + 2300 = 2,530', jl.issued.value, 2530);
  eq('scrap on the line: 115', jl.scrap.value, 115);
  eq('an issue with no line lands on the order, not a line', jc.notOnALine.issued.quantity, 1);
  eq('…and it was costed stock (costed leaves first): 10', jc.notOnALine.issued.value, 10);
  eq('the order total issued is 2,540', jc.totals.issuedValue, 2540);
  await expectRefusal('a line of another order is refused', () => post({ movementType: 'issue', fromAreaId: F.A1, orderId: F.order, orderLineId: -1, lines: [{ itemId: F.Q, quantity: 1 }] }), /not on order/);
  ok('the ledger and balances agree at the end', (await STOCK.checkLedger(conn, COMPANY)).ok);

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
