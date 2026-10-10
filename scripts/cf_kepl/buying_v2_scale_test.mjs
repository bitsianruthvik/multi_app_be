/**
 * buying_v2_scale_test.mjs — Buying v2 (init.sql §56): the ROUND TRIPS are fixed,
 * and the one-time MIGRATION changes no answer.
 *
 *   cd multi_app_be && node scripts/cf_kepl/buying_v2_scale_test.mjs
 *   CF_BUY_COMPANY=2 (default)   CF_BUY_SMALL=20  CF_BUY_BIG=200 (girders = plan units on the line)
 *
 * One transaction, rolled back; every cf_ table re-counted. Own fixtures (lib/buyingFixture.mjs).
 *
 *   18  the same calls on a frozen line of 20 girders and of 200 — each line built
 *       at the same savepoint, so everything else in the company is identical:
 *       the requisition read, the stock check (dry run and apply), making purchase
 *       orders (1 and 8 at once), the line-level engine, the planner snapshot (the
 *       engine over every unit), a planner save. Round trips must be EQUAL.
 *   19  the migration (scripts/cf_kepl/buying-pr-migrate.mjs) on orders left in the
 *       OLD shape — a request PO bought "for the order", an old stock check's
 *       order-level hold, a part-received PO: the dry run changes nothing; apply
 *       gives every line its requisition and hands the order-level cover to the
 *       requisition lines; the engine answers the same before and after; a second
 *       apply does nothing.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import * as MR from '../../apps/cf_erp/services/materialReadyService.js';
import * as RQ from '../../apps/cf_erp/services/requisitionService.js';
import * as PF from '../../apps/cf_erp/services/purchaseFlowService.js';
import * as PS from '../../apps/cf_erp/services/purchaseService.js';
import * as PL from '../../apps/cf_erp/services/plannerService.js';
import { migrate } from './buying-pr-migrate.mjs';
import { harness, simple, girder, quietCodes, addDays, PER_GIRDER } from './lib/buyingFixture.mjs';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_BUY_COMPANY ?? 2);
const SMALL = Number(process.env.CF_BUY_SMALL ?? 20);
const BIG = Number(process.env.CF_BUY_BIG ?? 200);
const tag = `BS${Date.now().toString(36).toUpperCase()}`;
const TODAY = '2026-10-12';
const D = (n) => addDays(TODAY, n);

const H = harness(pool);
const { ok, section, j } = H;
const before = await H.counts();
const db = await pool.getConnection();

try {
  await db.beginTransaction();
  attachNodeCache(db);
  MR.setToday(TODAY);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id };
  await quietCodes(db, COMPANY);

  /* ============================================================================================ */
  section(`18. Round trips are FIXED: a line of ${SMALL} girders against a line of ${BIG}`);
  const G = await girder(db, c, tag);
  const prLine = (pr, itemId) => pr.lines.find((l) => Number(l.item.id) === Number(itemId));
  /** Everything measured, on a frozen line of `n` girders. The line is built and measured inside a savepoint. */
  async function measureAt(n, pos) {
    await db.query('SAVEPOINT scale');
    const t0 = Date.now();
    const O = await G.girderOrder(`G${n}`, n);
    const built = Date.now() - t0;
    const out = { units: O.units.length, built };
    const m = async (name, fn) => { const t = Date.now(); const r = await H.measured(db, fn); out[name] = r.queries; out[`${name}Ms`] = Date.now() - t; return r.result; };
    await m('raise', (q) => RQ.raiseRequisitions(q, c, O.id, {}));
    const read = await m('read', (q) => RQ.orderRequisitions(q, COMPANY, O.id));
    const pr = read.requisitions[0];
    out.needA = prLine(pr, G.A).need;
    await G.receive(G.C, PER_GIRDER.C * n);
    await m('stockDry', (q) => RQ.stockCheck(q, c, pr.id, {}));
    const held = await m('stockApply', (q) => RQ.stockCheck(q, c, pr.id, { apply: true }));
    out.heldC = prLine(held.requisition, G.C).cover.held;
    // A's need split over `pos` purchase orders (each with its own date), B on one.
    const share = (PER_GIRDER.A * n) / pos;
    const made = await m('makePos', (q) => RQ.makePurchaseOrders(q, c, {
      orders: [
        ...Array.from({ length: pos }, (_, i) => ({ supplierId: G.SUP, place: true, lines: [{ prLineId: prLine(pr, G.A).id, quantity: share, expectedDate: D(7 * (i + 1)) }] })),
        { supplierId: G.SUP, place: true, lines: [{ prLineId: prLine(pr, G.B).id, expectedDate: D(10) }] },
      ],
    }));
    out.pos = made.purchaseOrders.length;
    const R = await m('engineLines', (q) => MR.lineReadiness(q, COMPANY, { full: true }));
    out.lineState = `${R.byLine.get(O.lineId).state} ${R.byLine.get(O.lineId).readyDate}`;
    const snap = await m('snapshot', (q) => PL.getPlanner(q, COMPANY, { from: '2026-10-01' }));
    const mine = O.units.map((k) => snap.units.find((u) => u.key === k));
    out.unitStates = j([...new Set(mine.map((u) => u.material.state))]);
    out.firstDate = mine[0].material.readyDate;
    out.lastDate = mine.at(-1).material.readyDate;
    out.payloadKb = Math.round(JSON.stringify(snap).length / 1024);
    out.materialKb = Math.round(JSON.stringify(snap.units.map((u) => u.material)).length / 1024);
    await m('save', (q) => PL.putEntries(q, c, { entries: [{ unitKey: O.units.at(-1), shipDate: mine.at(-1).material.earliest, pinned: true }] }));
    // A PO line's date moved: the edit answers with the planned units it made late, from the engine for THIS order's units only.
    const edit = await m('poDate', (q) => PS.updatePurchaseLine(q, c, made.purchaseOrders.at(-1).lines[0].id, { expectedDate: D(90) }));
    out.poDateLate = edit.plannedUnits.late;
    await db.query('ROLLBACK TO SAVEPOINT scale');
    return out;
  }
  // One read first: the planner keeps the company's production machines for 60 s (operationService), 3 reads the first call pays.
  await PL.getPlanner(db, COMPANY, { from: '2026-10-01' });
  const small = await measureAt(SMALL, 1);
  const big = await measureAt(BIG, 8);
  console.log(`        ${SMALL} girders: ${j(small)}`);
  console.log(`        ${BIG} girders: ${j(big)}`);
  ok(`the lines have ${SMALL} and ${BIG} plan units`, small.units === SMALL && big.units === BIG, j([small.units, big.units]));
  ok('the engine really ran over them: every unit dated, the first unit earlier than the last', small.unitStates === '["dated"]' && big.unitStates === '["dated"]' && big.firstDate < big.lastDate, j([small.unitStates, big.unitStates, big.firstDate, big.lastDate]));
  ok(`the big line's need was split over 8 purchase orders (+1), the small one's over 1 (+1)`, small.pos === 2 && big.pos === 9);
  for (const [name, what] of [
    ['read', 'the requisition read (GET /orders/:id/requisitions)'],
    ['stockDry', 'the stock check, dry run'],
    ['stockApply', 'the stock check, apply'],
    ['makePos', 'making purchase orders (2 at once against 9 at once)'],
    ['engineLines', 'the line-level engine (lineReadiness)'],
    ['snapshot', 'the planner snapshot (the engine over every unit)'],
    ['save', 'a planner save with its material check'],
    ['raise', 'raising the requisition'],
    ['poDate', 'a PO line date edit with its plannedUnits'],
  ]) {
    ok(`${what}: ${small[name]} round trips at ${SMALL} units, ${big[name]} at ${BIG} — equal`, small[name] === big[name], `${small[name]} vs ${big[name]}`);
  }
  ok(`the PO date edit reports the one planned card it made late, in fewer round trips than a planner read (${big.poDate} < ${big.snapshot})`, small.poDateLate === 1 && big.poDateLate === 1 && big.poDate < big.snapshot, `${big.poDateLate} ${big.poDate} ${big.snapshot}`);
  ok(`the engine itself is ≤ 10 reads (lines 1, needs ≤ 4, supply 5): ${big.engineLines}`, big.engineLines <= 10, String(big.engineLines));
  ok(`the requisition read is the engine + 5: ${big.read}`, big.read <= big.engineLines + 5, String(big.read));
  console.log(`        times at ${BIG} units: read ${big.readMs} ms, stock check ${big.stockDryMs} / ${big.stockApplyMs} ms, snapshot ${big.snapshotMs} ms (payload ${big.payloadKb} kB, of which material ${big.materialKb} kB), save ${big.saveMs} ms`);

  /* ============================================================================================ */
  section('19. The migration: orders left in the OLD shape get their requisitions, and no answer changes');
  const F = await simple(db, c, tag, { itemKeys: [] });
  const X = await F.item('M19X'); const Y = await F.item('M19Y'); const Z = await F.item('M19Z');
  // M1: two lines needing X (4 and 6). Old flow: request from the order → an old stock check holds 3 for the ORDER → placed with a date.
  const M1 = await F.order('M1', [[[X, 4]], [[X, 6]]]);
  await F.receive(X, 3);
  let po1 = await PF.requestFromOrder(db, c, M1.id, { lines: [{ itemId: X, quantity: 10 }] });
  const sc = await PF.stockCheck(db, c, po1.id);
  await PF.applyStockCheck(db, c, po1.id, { lines: sc.lines.map((l) => ({ lineId: l.lineId, hold: l.proposeHold })) });
  po1 = await PS.markOrdered(db, c, po1.id, { supplierId: F.S1 });
  await PS.updatePurchaseLine(db, c, po1.lines[0].id, { expectedDate: D(12) });
  // M2: one line needing Y 5: a PO placed for the order, 2 received (held for the order), 3 to come.
  const M2 = await F.order('M2', [[[Y, 5]]]);
  let po2 = await PS.createPurchaseOrder(db, c, { supplierId: F.S1, forOrderId: M2.id, expectedDate: D(20) });
  po2 = await PS.addPurchaseLine(db, c, po2.id, { itemId: Y, quantity: 5 });
  await PS.markOrdered(db, c, po2.id, {});
  await PS.receiveLine(db, c, po2.lines[0].id, { quantity: 2, stockingAreaId: F.store });
  // M3: nothing bought, nothing in stock. M4: only requested (no date).
  const M3 = await F.order('M3', [[[Z, 2]]]);
  const M4 = await F.order('M4', [[[Z, 1]]]);
  await PF.requestFromOrder(db, c, M4.id, {});
  const mine = [...M1.lines, ...M2.lines, ...M3.lines, ...M4.lines].map((l) => l.id);
  const answers = async () => { const R = await MR.lineReadiness(db, COMPANY, { full: true }); return j(mine.map((id) => [R.byLine.get(id).state, R.byLine.get(id).readyDate])); };
  const shape = async () => j([
    (await db.query('SELECT COUNT(*) AS n FROM cf_requisitions WHERE company_id = ?', [COMPANY]))[0][0].n,
    (await db.query('SELECT COUNT(*) AS n FROM cf_requisition_lines WHERE company_id = ?', [COMPANY]))[0][0].n,
    (await db.query('SELECT id, quantity, pr_line_id, status FROM cf_stock_reservations WHERE company_id = ? AND held_for_order_id IN (?) ORDER BY id', [COMPANY, [M1.id, M2.id, M3.id, M4.id]]))[0],
    (await db.query('SELECT id, quantity, qty_received, pr_line_id, deleted_at IS NULL AS live FROM cf_purchase_line_orders WHERE company_id = ? AND order_id IN (?) ORDER BY id', [COMPANY, [M1.id, M2.id, M3.id, M4.id]]))[0],
  ]);
  const old = await answers();
  ok('the old-shape fixture: order-level holds and PO shares, no requisition', Number((await db.query('SELECT COUNT(*) AS n FROM cf_requisitions WHERE company_id = ? AND order_id IN (?)', [COMPANY, [M1.id, M2.id, M3.id, M4.id]]))[0][0].n) === 0
    && Number((await db.query("SELECT COUNT(*) AS n FROM cf_stock_reservations WHERE company_id = ? AND held_for_order_id IN (?) AND status = 'active' AND pr_line_id IS NULL", [COMPANY, [M1.id, M2.id]]))[0][0].n) === 2);
  console.log(`        engine before: ${old}`);
  ok('before: M1 line 1 dated (3 held + 1 coming), line 2 dated; M2 dated; M3 waiting (short); M4 waiting (asked)', old === j([['dated', D(12)], ['dated', D(12)], ['dated', D(20)], ['waiting', null], ['waiting', null]]), old);
  const shapeBefore = await shape();
  const dry = await H.measured(db, (q) => migrate(q, c, { apply: false }));
  console.log(`        dry run: ${j(dry.result)}  (${dry.queries} round trips)`);
  ok('DRY RUN: it would create a requisition for each of my 5 lines …', dry.result.requisitionsCreated >= 5 && dry.result.written === false);
  ok('… hand over the 2 order-level holds and the 3 order-level PO shares …', dry.result.holdsHandedOver >= 2 && dry.result.allocationsHandedOver >= 3, j(dry.result));
  ok('… and change no engine answer', dry.result.changed.length === 0, j(dry.result.changed));
  ok('the dry run changed NOTHING', (await shape()) === shapeBefore);
  const did = await H.measured(db, (q) => migrate(q, c, { apply: true }));
  console.log(`        apply:   ${j(did.result)}  (${did.queries} round trips)`);
  ok('APPLY: written, with the same counts as the dry run', did.result.written === true && did.result.requisitionsCreated === dry.result.requisitionsCreated && did.result.holdsHandedOver === dry.result.holdsHandedOver && did.result.changed.length === 0);
  ok('the round trips are the same for the dry run and the apply (fixed)', did.queries === dry.queries, `${dry.queries} vs ${did.queries}`);
  const now = await answers();
  ok('the engine gives the SAME answers after as before', now === old, `${old} → ${now}`);
  const v1 = (await RQ.orderRequisitions(db, COMPANY, M1.id)).requisitions;
  const l1 = v1.find((r) => r.line.id === M1.lines[0].id).lines[0]; const l2 = v1.find((r) => r.line.id === M1.lines[1].id).lines[0];
  ok('M1 line 1 (needs 4): the 3 held are ITS hold, plus 1 of the PO; line 2 (needs 6): 6 of the PO', l1.holds.length === 1 && l1.holds[0].quantity === 3 && l1.purchase.reduce((t, p) => t + p.outstanding, 0) === 1
    && l2.purchase.reduce((t, p) => t + p.outstanding, 0) === 6 && l1.status === 'covered' && l2.status === 'covered', j([l1.holds, l1.purchase.map((p) => p.outstanding), l2.purchase.map((p) => p.outstanding)]));
  const [live1] = await db.query('SELECT quantity, pr_line_id FROM cf_purchase_line_orders WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY quantity', [COMPANY, M1.id]);
  ok('the order-level PO share of 7 became two requisition-line shares (1 + 6): nothing is counted twice', j(live1.map((r) => [Number(r.quantity), r.pr_line_id != null])) === j([[1, true], [6, true]]), j(live1));
  const v2 = (await RQ.orderRequisitions(db, COMPANY, M2.id)).requisitions[0].lines[0];
  ok('M2: the 2 received are held for its requisition line, 3 still coming on the PO', v2.cover.held === 2 && v2.cover.ordered === 3 && v2.purchase[0].received === 2 && v2.status === 'covered', j(v2.cover));
  ok('M3 has an open requisition; M4\'s is "asked"', (await RQ.orderRequisitions(db, COMPANY, M3.id)).requisitions[0].status === 'open' && (await RQ.orderRequisitions(db, COMPANY, M4.id)).requisitions[0].lines[0].status === 'asked');
  const shapeApplied = await shape();
  const again = await migrate(db, c, { apply: true });
  ok('IDEMPOTENT: a second apply creates nothing and hands nothing over', again.requisitionsCreated === 0 && again.requisitionLinesAdded === 0 && again.holdsHandedOver === 0 && again.allocationsHandedOver === 0 && again.changed.length === 0, j(again));
  ok('…and leaves every row as it was', (await shape()) === shapeApplied);
} catch (err) {
  H.state.failed += 1;
  console.error('\nERROR', err);
} finally {
  MR.setToday(null);
  await db.rollback();
  detachNodeCache(db);
  db.release();
}

const after = await H.counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
section('Rolled back');
ok('every cf_ table has the rows it had', drift.length === 0, drift.map((d) => d.name).join(', '));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed${H.state.fails.length ? `\n  failed: ${H.state.fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(H.state.failed ? 1 : 0);
