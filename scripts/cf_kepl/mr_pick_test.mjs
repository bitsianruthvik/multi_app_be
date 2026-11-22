/**
 * mr_pick_test.mjs — an MR raised by hand, worked line by line on its own screen (init.sql §118, user 2026-11-23):
 * Give out (from its earmark, then free stock) and Raise PR (chosen lines, at most what is left; any number of PRs).
 *
 *   cd multi_app_be && node scripts/cf_kepl/mr_pick_test.mjs        CF_COMPANY=2 (the default)
 *
 * One transaction, ROLLED BACK at the end: nothing is kept.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const R = await imp('apps/cf_erp/services/requisitionService.js');
const P = await imp('apps/cf_erp/services/purchaseRequestService.js');
const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const COMPANY = Number(process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
const refusal = (p) => p.then(() => null, (e) => e);
const said = (e) => [e?.code, e?.message, ...(e?.problems ?? [])].join(' ');
const counts = async () => Object.fromEntries(await Promise.all(['cf_requisitions', 'cf_buy_requests', 'cf_buy_request_lines', 'cf_stock_movements', 'cf_stock_reservations', 'cf_purchase_orders'].map(async (t) => [t, (await pool.query(`SELECT COUNT(*) n FROM ${t}`))[0][0].n])));

const before = await counts();
const db = await pool.getConnection();
try {
  await db.beginTransaction(); attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id };
  const [[order]] = await db.query("SELECT id, code FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status IN ('inquiry', 'confirmed') ORDER BY id DESC LIMIT 1", [COMPANY]);
  const [[area]] = await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const [[vendor]] = await db.query('SELECT id, name FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  await db.query('UPDATE cf_parties SET is_supplier = 1 WHERE id = ?', [vendor.id]);
  const [items] = await db.query(
    `SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND i.item_type = 'catalog' AND i.tracked_by = 'quantity' AND m.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.item_id = m.id AND k.quantity <> 0)
        AND NOT EXISTS (SELECT 1 FROM cf_stock_reservations v WHERE v.item_id = m.id AND v.status = 'active') ORDER BY m.id DESC LIMIT 2`, [COMPANY]);
  const [A, B] = items;
  for (const it of items) await db.query('UPDATE cf_item_details SET stores_kind = NULL, issue_conditions = NULL WHERE master_id = ?', [it.id]);
  await postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: A.id, quantity: 5, toAreaId: area.id, unitCost: 10 }] });

  console.log('1. the screen');
  const mr = await R.createRequisition(db, c, { forType: 'sales_order', orderId: order.id, lines: [{ itemId: A.id, qty: 8 }, { itemId: B.id, qty: 3 }] });
  let s = await P.mrScreen(db, COMPANY, mr.id);
  const la = () => s.lines.find((l) => Number(l.item.id) === A.id); const lb = () => s.lines.find((l) => Number(l.item.id) === B.id);
  ok('an MR raised by hand is worked line by line', s.pickMode === true && s.purchaseRequests.length === 0);
  ok('each line: left = required (8, 3), A has 5 in stock', la().left === 8 && lb().left === 3 && la().inStock === 5 && la().onPr === 0, JSON.stringify(s.lines.map((l) => [l.left, l.inStock])));

  console.log('2. give out');
  const g1 = await P.giveOutMr(db, c, mr.id, { lines: [{ lineId: la().id, quantity: 5 }] });
  ok('5 of A given out against the MR, one issue named for it', /^[A-Z]/.test(g1.movement?.code ?? ''), JSON.stringify(g1.movement?.code));
  s = await P.mrScreen(db, COMPANY, mr.id);
  ok('A: 5 issued, 3 left, nothing earmarked', la().issued === 5 && la().left === 3 && la().toIssue === 0, JSON.stringify([la().issued, la().left, la().toIssue]));
  ok('the stock-out is listed on the MR', s.giveOuts.length === 1 && s.giveOuts[0].code === g1.movement.code);
  const none = await refusal(P.giveOutMr(db, c, mr.id, { lines: [{ lineId: la().id, quantity: 1 }] }));
  ok('more than is in the store is refused, saying raise a PR', /only 0 .*free/.test(said(none)) && /raise a PR/.test(said(none)), said(none));
  const over = await refusal(P.giveOutMr(db, c, mr.id, { lines: [{ lineId: lb().id, quantity: 4 }] }));
  ok('more than is left on the line is refused', /left to cover/.test(said(over)), said(over));

  console.log('3. raise PRs');
  const p1 = await P.raisePrFromMr(db, c, mr.id, { lines: [{ lineId: la().id, quantity: 3 }, { lineId: lb().id, quantity: 2 }], notes: 'first lot' });
  s = p1;
  ok('a PR for A 3 and B 2', /^PR-/.test(p1.raised?.code ?? '') && p1.purchaseRequests.length === 1 && p1.raised.lines.length === 2, JSON.stringify(p1.raised));
  ok('left: A 0, B 1; on PRs A 3, B 2', la().left === 0 && lb().left === 1 && la().onPr === 3 && lb().onPr === 2, JSON.stringify(s.lines.map((l) => [l.onPr, l.left])));
  const too = await refusal(P.raisePrFromMr(db, c, mr.id, { lines: [{ lineId: lb().id, quantity: 2 }] }));
  ok('a PR for more than is left is refused', /only 1 .*left/.test(said(too)), said(too));
  const p2 = await P.raisePrFromMr(db, c, mr.id, { lines: [{ lineId: lb().id, quantity: 1 }] });
  s = p2;
  ok('a second PR for the last 1 of B; the MR lists both, newest first', s.purchaseRequests.length === 2 && s.purchaseRequests[0].code === p2.raised.code && lb().left === 0);
  const saved = await P.saveMr(db, c, mr.id, { lines: s.lines.map((l) => ({ lineId: l.id, takeFromStock: l.takeFromStock })) });
  const [[n1]] = await db.query('SELECT SUM(quantity) q FROM cf_buy_request_lines WHERE company_id = ? AND request_id IN (?) AND deleted_at IS NULL', [COMPANY, [p1.raised.id, p2.raised.id]]);
  ok('an old-style Save no longer rewrites the hand-raised PRs', Number(n1.q) === 6 && saved.purchaseRequests.length === 2, JSON.stringify(n1));

  console.log('4. a PO shared out oldest PR first');
  const pr1 = await P.getPr(db, COMPANY, p1.raised.id);
  const col = await P.addVendor(db, c, pr1.id, { supplierId: vendor.id });
  const colId = (col.vendors ?? (await P.getPr(db, COMPANY, pr1.id)).vendors).find((v) => Number(v.supplier.id) === vendor.id).id;
  const bLine1 = pr1.lines.find((l) => Number(l.item.id) === B.id);
  await P.setQuotes(db, c, colId, { quotes: [{ lineId: bLine1.id, rate: 100, deliveryDays: 5 }] });
  await P.raisePo(db, c, colId, { lines: [{ lineId: bLine1.id, quantity: 2 }] });
  const pr1b = await P.getPr(db, COMPANY, p1.raised.id); const pr2b = await P.getPr(db, COMPANY, p2.raised.id);
  const b1 = pr1b.lines.find((l) => Number(l.item.id) === B.id); const b2 = pr2b.lines[0];
  ok('the PO for 2 of B counts on the first PR (ordered), not on the second (still 1 open)', b1.poRaised === 2 && b1.open === 0 && b2.poRaised === 0 && b2.open === 1, JSON.stringify([b1.poRaised, b1.open, b2.poRaised, b2.open]));

  console.log("5. an order's own MR is not worked here");
  const [[engine]] = await db.query('SELECT id FROM cf_requisitions WHERE company_id = ? AND order_line_id IS NOT NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [COMPANY]);
  if (engine) ok('Give out on a line MR of an order is refused, in words', (await refusal(P.giveOutMr(db, c, engine.id, { lines: [] })))?.code === 'NOT_PICKED');
  else console.log('  (no line MR in this company: skipped)');
} catch (e) {
  fail += 1; console.log('  FAIL (threw)', e?.message, JSON.stringify(e?.problems ?? ''), e?.stack?.split('\n').slice(1, 3).join(' '));
} finally {
  try { await db.rollback(); } catch { /* */ }
  detachNodeCache(db); db.release();
  ok('rolled back: every table count as before', JSON.stringify(await counts()) === JSON.stringify(before));
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
