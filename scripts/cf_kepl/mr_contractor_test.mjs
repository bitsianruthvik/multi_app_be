/**
 * mr_contractor_test.mjs — a material request FOR A CONTRACTOR (init.sql §116) and the stock-outs of a request.
 *
 *   cd multi_app_be && node scripts/cf_kepl/mr_contractor_test.mjs        CF_COMPANY=2 (the default)
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
const D = await imp('apps/cf_erp/services/storesDeskService.js');
const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const COMPANY = Number(process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
const refusal = (p) => p.then(() => null, (e) => e);
const said = (e) => [e?.message, ...(e?.problems ?? [])].join(' ');

const db = await pool.getConnection();
try {
  await db.beginTransaction(); attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id };
  const [[order]] = await db.query("SELECT id, code FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status IN ('inquiry', 'confirmed') ORDER BY id DESC LIMIT 1", [COMPANY]);
  const [[area]] = await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const [parties] = await db.query('SELECT id, name FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 2', [COMPANY]);
  const [contractor, other] = parties;
  await db.query('UPDATE cf_parties SET is_subcontractor = 1 WHERE id = ?', [contractor.id]);
  await db.query('UPDATE cf_parties SET is_subcontractor = 0 WHERE id = ?', [other.id]);
  const [items] = await db.query(
    `SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND i.item_type = 'catalog' AND i.tracked_by = 'quantity' AND m.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.item_id = m.id AND k.quantity <> 0)
        AND NOT EXISTS (SELECT 1 FROM cf_stock_reservations v WHERE v.item_id = m.id AND v.status = 'active') ORDER BY m.id DESC LIMIT 2`, [COMPANY]);
  const [tool, cons] = items;
  await db.query("UPDATE cf_item_details SET stores_kind = 'returnable', issue_conditions = NULL, due_days = 5 WHERE master_id = ?", [tool.id]);
  await db.query('UPDATE cf_item_details SET stores_kind = NULL, issue_conditions = NULL WHERE master_id = ?', [cons.id]);
  await postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: tool.id, quantity: 3, toAreaId: area.id, unitCost: 500 }, { itemId: cons.id, quantity: 20, toAreaId: area.id, unitCost: 10 }] });

  console.log('1. raising');
  const lines = [{ itemId: tool.id, qty: 1 }, { itemId: cons.id, qty: 6 }];
  const none = await refusal(R.createRequisition(db, c, { forType: 'sales_order', orderId: order.id, lines }));
  ok('a tool on a sales order with no contractor is refused, in words', /name the contractor/.test(said(none)), said(none));
  ok('a party that is not a contractor is refused', /not marked as a contractor/.test(said(await refusal(R.createRequisition(db, c, { forType: 'sales_order', orderId: order.id, contractorId: other.id, lines })))));
  ok('consumables alone need no contractor', !!(await R.createRequisition(db, c, { forType: 'sales_order', orderId: order.id, lines: [{ itemId: cons.id, qty: 1 }] })).id);
  const mr = await R.createRequisition(db, c, { forType: 'sales_order', orderId: order.id, contractorId: contractor.id, note: 'Grinder for the contractor', lines });
  ok('with the contractor named it is raised', /^MR-/.test(mr.code));
  let screen = await P.mrScreen(db, COMPANY, mr.id);
  ok('the request shows its contractor and no give-out yet', screen.contractor?.id === contractor.id && screen.giveOuts.length === 0);
  const listed = (await P.listMrs(db, COMPANY, {})).rows.find((r) => r.id === mr.id);
  ok('the list shows the contractor', listed?.contractor?.name === contractor.name);

  console.log('2. giving out against it');
  await P.saveMr(db, c, mr.id, { lines: screen.lines.map((l) => ({ lineId: l.id, takeFromStock: l.required ?? l.need ?? l.quantity })) });
  const out = await P.issueMr(db, c, mr.id, {});
  const [[mv]] = await db.query('SELECT given_type, given_party_id, requisition_id, order_id FROM cf_stock_movements WHERE id = ?', [out.movement.id]);
  ok('the give-out is tied to the request, the order and the contractor', Number(mv.requisition_id) === mr.id && Number(mv.order_id) === order.id && mv.given_type === 'vendor' && Number(mv.given_party_id) === contractor.id, JSON.stringify(mv));
  const ow = await D.outWith(db, COMPANY, { holder: 'vendor', search: tool.name });
  ok('the tool is out with the contractor; the consumable is not on Out with', ow.rows.length === 1 && ow.rows[0].holder === contractor.name && ow.rows[0].left === 1 && ow.rows[0].order === order.code
    && (await D.outWith(db, COMPANY, { search: cons.name })).rows.length === 0, JSON.stringify(ow.rows[0] ?? null));
  screen = await P.mrScreen(db, COMPANY, mr.id);
  ok('the request lists that stock-out with both items', screen.giveOuts.length === 1 && screen.giveOuts[0].code === out.movement.code && screen.giveOuts[0].lines.length === 2 && !screen.giveOuts[0].undone, JSON.stringify(screen.giveOuts));
  ok('each line says how much was issued', screen.lines.every((l) => (l.issued ?? 0) > 0));
  const tot = (await P.orderItemTotals(db, COMPANY, order.id)).rows.find((r) => Number(r.itemId) === cons.id);
  ok("the order's totals count it: asked and given", tot?.requested >= 6 && tot.given === 6, JSON.stringify(tot));
  const back = await D.custodyBack(db, c, ow.rows[0].id, { kind: 'returned' });
  ok('the tool comes back from the contractor', back.left === 0);

  console.log(`\n${pass} passed, ${fail} failed — rolled back`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('ERROR', e.message, e.problems ?? '', e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
} finally {
  try { await db.rollback(); } catch { /* going back anyway */ }
  detachNodeCache(db); db.release(); await pool.end();
}
