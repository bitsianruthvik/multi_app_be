/**
 * reserved_use_test.mjs — using stock that is reserved for a sales order (init.sql §115): Stores asks, planning AND
 * production approve (two people), the reservation is let go, Purchase is told.
 *
 *   cd multi_app_be && node scripts/cf_kepl/reserved_use_test.mjs        CF_COMPANY=2 (the default)
 *
 * One transaction, ROLLED BACK at the end: nothing is kept.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const R = await imp('apps/cf_erp/services/reservedUseService.js');
const A = await imp('apps/cf_erp/services/approvalService.js');
const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const COMPANY = Number(process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
const refusal = (p) => p.then(() => null, (e) => e);
const all = { can: () => true, isAdmin: false };

const db = await pool.getConnection();
try {
  await db.beginTransaction(); attachNodeCache(db);
  const [users] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 3', [COMPANY]);
  const [stores, planner, floor] = users.map((u) => ({ companyId: COMPANY, userId: u.id }));
  await db.query('UPDATE cf_company_settings SET approve_own_requests = 0 WHERE company_id = ?', [COMPANY]).catch(() => {});
  const [[area]] = await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const [[item]] = await db.query(
    `SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND i.item_type = 'catalog' AND i.tracked_by = 'quantity'
        AND NOT EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.item_id = m.id AND k.quantity <> 0)
        AND NOT EXISTS (SELECT 1 FROM cf_stock_reservations v WHERE v.item_id = m.id AND v.status = 'active') ORDER BY m.id DESC LIMIT 1`, [COMPANY]);
  const [[order]] = await db.query('SELECT id, code FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [COMPANY]);
  await postMovement(db, stores, { movementType: 'receipt', lines: [{ itemId: item.id, quantity: 10, toAreaId: area.id, unitCost: 50 }] });

  console.log('1. asking');
  ok('nothing reserved: the ask is refused', (await refusal(R.ask(db, stores, { itemId: item.id, quantity: 4, reason: 'x' })))?.code === 'NOT_RESERVED');
  await db.query('INSERT INTO cf_stock_reservations (company_id, held_for_order_id, item_id, quantity, created_by) VALUES (?, ?, ?, 8, ?)', [COMPANY, order.id, item.id, stores.userId]);
  const held = await R.reservedFor(db, COMPANY, item.id);
  ok('the reservation names its order', held.length === 1 && held[0].order?.code === order.code && held[0].quantity === 8);
  const stock = await refusal(postMovement(db, stores, { movementType: 'issue', usedFor: 'general', lines: [{ itemId: item.id, quantity: 5, fromAreaId: area.id }] }));
  ok('giving out reserved stock is refused, naming the order', stock?.code === 'RESERVED' && stock.message.includes(order.code), stock?.message);
  ok('what is free is not asked for', (await refusal(R.ask(db, stores, { itemId: item.id, quantity: 2, reason: 'x' })))?.code === 'FREE');
  ok('more than the store holds is refused', (await refusal(R.ask(db, stores, { itemId: item.id, quantity: 11, reason: 'x' })))?.code === 'TOO_MANY');
  ok('an ask needs a reason', (await refusal(R.ask(db, stores, { itemId: item.id, quantity: 5 })))?.code === 'REASON');
  const q = await R.ask(db, stores, { itemId: item.id, quantity: 5, reason: 'Breakdown on SAW-01, needed today', wantedFor: 'Maintenance' });
  ok('the ask is waiting, with a code and what was reserved', q.status === 'pending' && /^RU-/.test(q.code) && q.reserved.need === 3 && q.reserved.free === 2);
  ok('a second ask for the item waits for the first', (await refusal(R.ask(db, stores, { itemId: item.id, quantity: 5, reason: 'again' })))?.code === 'WAITING');
  const { rows: appr } = await A.listApprovals(db, COMPANY, () => true, { status: 'pending' });
  const mine = appr.filter((a) => a.subject?.type === 'reserved_use' && a.subject.id === q.id);
  ok('two approvals wait: planning and production', mine.length === 2 && mine.map((a) => a.type).sort().join() === 'reserved_use_planning,reserved_use_production', JSON.stringify(mine.map((a) => a.type)));
  const pl = mine.find((a) => a.type === 'reserved_use_planning');
  const pr = mine.find((a) => a.type === 'reserved_use_production');

  console.log('2. two people approve');
  ok('a person without the planning permission cannot approve it', (await refusal(A.decide(db, planner, pl.id, { decision: 'approve' }, { can: (t) => t !== 'cf_erp_approve_reserved_planning', isAdmin: false })))?.code === 'FORBIDDEN');
  const first = await A.decide(db, planner, pl.id, { decision: 'approve' }, all);
  ok('the first yes waits for the other side; nothing is let go', first.result?.waitingFor === 'production' && (await R.reservedFor(db, COMPANY, item.id))[0].quantity === 8);
  ok('the same person cannot be the second yes', (await refusal(A.decide(db, planner, pr.id, { decision: 'approve' }, all)))?.code === 'SAME_PERSON');
  const second = await A.decide(db, floor, pr.id, { decision: 'approve' }, all);
  ok('the second yes lets go what was needed, from that order', second.result?.approved === true && second.result.released.length === 1 && second.result.released[0].quantity === 3 && second.result.released[0].order.code === order.code);
  ok('the reservation is smaller by that much', (await R.reservedFor(db, COMPANY, item.id))[0].quantity === 5);
  const done = await R.getRequest(db, COMPANY, q.id);
  ok('the ask is approved, with both names', done.status === 'approved' && !!done.planning && !!done.production && done.released[0].quantity === 3);
  const [[al]] = await db.query("SELECT kind, departments, title, order_code FROM cf_alerts WHERE company_id = ? AND kind = 'reserved_taken' AND subject_id = ?", [COMPANY, q.id]);
  ok('Purchase and Planning get an alert naming the order and the shortfall', al?.departments === 'purchase,planning' && al.order_code === order.code && /short of 3/.test(al.title), al?.title);
  const out = await postMovement(db, stores, { movementType: 'issue', usedFor: 'general', lines: [{ itemId: item.id, quantity: 5, fromAreaId: area.id }] });
  ok('Stores can now give out the 5', !!out.id);
  ok('and not one more', (await refusal(postMovement(db, stores, { movementType: 'issue', usedFor: 'general', lines: [{ itemId: item.id, quantity: 1, fromAreaId: area.id }] })))?.code === 'RESERVED');

  console.log('3. one no sends it back');
  const q2 = await R.ask(db, stores, { itemId: item.id, quantity: 2, reason: 'Second ask' });
  const two = (await A.listApprovals(db, COMPANY, () => true, { status: 'pending' })).rows.filter((a) => a.subject?.type === 'reserved_use' && a.subject.id === q2.id);
  ok('a no needs a reason', (await refusal(A.decide(db, planner, two[0].id, { decision: 'reject' }, all)))?.code === 'REASON');
  await A.decide(db, planner, two[0].id, { decision: 'reject', note: 'SO needs it this week' }, all);
  const back = await R.getRequest(db, COMPANY, q2.id);
  const left = (await A.listApprovals(db, COMPANY, () => true, { status: 'pending' })).rows.filter((a) => a.subject?.type === 'reserved_use' && a.subject.id === q2.id);
  ok('the ask is rejected with the reason, the other approval is gone, nothing let go', back.status === 'rejected' && /needs it this week/.test(back.decisionNote) && left.length === 0 && (await R.reservedFor(db, COMPANY, item.id))[0].quantity === 5);
  const q3 = await R.ask(db, stores, { itemId: item.id, quantity: 2, reason: 'Third ask' });
  const w = await R.withdrawRequest(db, stores, q3.id);
  ok('Stores can take an ask back', w.status === 'withdrawn' && (await R.listRequests(db, COMPANY, { status: 'pending', itemId: item.id })).rows.length === 0);

  console.log(`\n${pass} passed, ${fail} failed — rolled back`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('ERROR', e.message, e.problems ?? '', e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
} finally {
  try { await db.rollback(); } catch { /* going back anyway */ }
  detachNodeCache(db); db.release(); await pool.end();
}
