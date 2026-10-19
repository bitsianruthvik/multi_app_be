/**
 * purchase_perms_test.mjs — WHO BUYS AND WHERE GOODS COME IN (user, 2026-10-19).
 *
 *   cd multi_app_be && node scripts/cf_kepl/purchase_perms_test.mjs        CF_PERMS_COMPANY (2)
 *
 *   1  the route guards: Stores (inventory manage / cf_erp_stores) raises MRs, books GRNs and posts movements; PURCHASE
 *      (cf_erp_purchase) does the PR's vendors and quotes, raises / changes / sends / closes / cancels POs and ticks the
 *      plate-change checklist; Management approves. Each route's own middleware is run with a user of each kind.
 *   2  routes/purchase.js assertPoActor: on a PO's dates, close short and cancel, Stores passes only on the CUSTOMER's own
 *      PO; Purchase passes on every PO; the refusal names the PO and the tag; a PO not found is left to the service's 404.
 *   3  goods coming IN land in a storage or quarantine area (stockingAreaService.RECEIVING_PURPOSES): Stock / Movements ›
 *      Receive (postMovement 'receipt') and customer material (receiveCustomerMaterial) refuse a dispatch, WIP or scrap
 *      area in words naming it and its purpose; storage and quarantine receive; a transfer into dispatch still works;
 *      production's own finished work (fromProduction) is not refused for its area.
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. Everything is this run's own (TEST-PRM-<run>).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const PS = await imp('apps/cf_erp/services/purchaseService.js');
const ST = await imp('apps/cf_erp/services/stockService.js');
const SA = await imp('apps/cf_erp/services/stockingAreaService.js');
const OWN = await imp('apps/cf_erp/services/ownershipService.js');
const purchaseRoutes = await imp('apps/cf_erp/routes/purchase.js');
const routers = {
  purchase: purchaseRoutes.default,
  purchaseRequests: (await imp('apps/cf_erp/routes/purchaseRequests.js')).default,
  plateChanges: (await imp('apps/cf_erp/routes/plateChanges.js')).default,
  grn: (await imp('apps/cf_erp/routes/grn.js')).default,
  inventory: (await imp('apps/cf_erp/routes/inventory.js')).default,
  stockMoney: (await imp('apps/cf_erp/routes/stockMoney.js')).default,
};
const { harness, simple, quietCodes } = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');

const COMPANY = Number(process.env.CF_PERMS_COMPANY ?? 2);
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const tag = `TEST-PRM-${RUN}`;
const H = harness(pool);
const { ok, section, refusal, j } = H;

/* ════════════════════ 1. the route guards (no database) ════════════════════ */
const USERS = {
  stores: { role: 'operator', uiPermissions: ['cf_erp_inventory_view', 'cf_erp_inventory_manage', 'cf_erp_stores'] },
  storesTag: { role: 'operator', uiPermissions: ['cf_erp_stores'] },
  buyer: { role: 'operator', uiPermissions: ['cf_erp_purchase'] },
  md: { role: 'operator', uiPermissions: ['cf_erp_approve_purchase_order', 'cf_erp_approve_po_close_short'] },
  viewer: { role: 'operator', uiPermissions: ['cf_erp_inventory_view'] },
  admin: { role: 'admin', uiPermissions: [] },
};
/** Runs a route's permission middleware (everything between `protect` and the handler) for a user: true = it passed. */
function passes(router, method, routePath, user) {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const guards = layer.route.stack.slice(1, -1).map((s) => s.handle);
  if (!guards.length) throw new Error(`${method} ${routePath} has no permission middleware`);
  return guards.every((fn) => {
    let next = false;
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json() { return this; } };
    fn({ user, params: {}, body: {}, query: {} }, res, () => { next = true; });
    return next && res.statusCode === 200;
  });
}
const who = (router, method, routePath) => Object.keys(USERS).filter((k) => passes(router, method, routePath, USERS[k]));
const same = (a, b) => j([...a].sort()) === j([...b].sort());

section('1. The route guards — who may call what');
const TABLE = [
  // [router, method, path, who passes]
  ['purchaseRequests', 'PUT', '/material-requests/:id', ['stores', 'storesTag', 'admin']],
  ['purchaseRequests', 'POST', '/purchase-requests/:id/vendors', ['buyer', 'admin']],
  ['purchaseRequests', 'PUT', '/purchase-request-vendors/:id', ['buyer', 'admin']],
  ['purchaseRequests', 'DELETE', '/purchase-request-vendors/:id', ['buyer', 'admin']],
  ['purchaseRequests', 'PUT', '/purchase-request-vendors/:id/quotes', ['buyer', 'admin']],
  ['purchaseRequests', 'POST', '/purchase-request-vendors/:id/purchase-orders', ['buyer', 'admin']],
  ['purchaseRequests', 'GET', '/purchase-requests/:id', ['stores', 'storesTag', 'buyer', 'viewer', 'admin']],
  ['purchase', 'GET', '/purchase-orders', ['stores', 'buyer', 'md', 'viewer', 'admin']],
  ['purchase', 'GET', '/purchase-orders/:id', ['stores', 'buyer', 'md', 'viewer', 'admin']],
  ['purchase', 'POST', '/purchase-orders', ['buyer', 'admin']],
  ['purchase', 'POST', '/purchase-orders/:id/order', ['buyer', 'admin']],
  ['purchase', 'POST', '/purchase-orders/:id/lines', ['buyer', 'admin']],
  ['purchase', 'DELETE', '/purchase-lines/:id', ['buyer', 'admin']],
  ['purchase', 'PUT', '/purchase-lines/:id/orders', ['buyer', 'admin']],
  // these four pass the guard for Stores too; assertPoActor (section 2) lets Stores through only on the customer's own PO
  ['purchase', 'PUT', '/purchase-orders/:id', ['stores', 'storesTag', 'buyer', 'admin']],
  ['purchase', 'PUT', '/purchase-lines/:id', ['stores', 'storesTag', 'buyer', 'admin']],
  ['purchase', 'POST', '/purchase-orders/:id/close', ['stores', 'storesTag', 'buyer', 'admin']],
  ['purchase', 'POST', '/purchase-orders/:id/cancel', ['stores', 'storesTag', 'buyer', 'admin']],
  ['purchase', 'POST', '/purchase-orders/:id/approve', ['md', 'admin']],
  ['purchase', 'POST', '/purchase-lines/:id/receive', ['stores', 'admin']],
  ['purchase', 'POST', '/stock/holds/:id/release', ['stores', 'admin']],
  ['grn', 'POST', '/purchase-orders/:id/grn', ['stores', 'admin']],
  ['plateChanges', 'POST', '/plate-changes/:id/checklist', ['buyer', 'admin']],
  ['inventory', 'POST', '/movements', ['stores', 'admin']],
  ['stockMoney', 'POST', '/customer-material/receive', ['stores', 'admin']],
];
for (const [r, method, p, expected] of TABLE) {
  const got = who(routers[r], method, p);
  ok(`${method} ${p}: ${expected.join(', ')}`, same(got, expected), `passed: ${got.join(', ')}`);
}
ok('a pure Purchase user can read the PO list it works from (it could not before)', passes(routers.purchase, 'GET', '/purchase-orders', USERS.buyer));
ok('Stores with inventory manage can no longer type a quote', !passes(routers.purchaseRequests, 'PUT', '/purchase-request-vendors/:id/quotes', USERS.stores));
{
  const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
  const layer = routers.purchaseRequests.stack.find((l) => l.route?.path === '/purchase-request-vendors/:id/quotes');
  layer.route.stack[1].handle({ user: USERS.stores }, res, () => {});
  ok('the refusal is a 403 naming cf_erp_purchase', res.statusCode === 403 && /cf_erp_purchase/.test(res.body?.message ?? ''), j(res.body));
}

/* ════════════════════ 2 + 3. with the database, rolled back ════════════════════ */
const before = await H.counts();
const db = await pool.getConnection();
try {
  await db.beginTransaction();
  attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, canApprove: true, isAdmin: true };
  await quietCodes(db, COMPANY);
  const S = await simple(db, c, tag, { itemKeys: ['A'] });
  const { A } = S.items;

  section("2. assertPoActor — Stores only on the customer's own PO");
  const ours = await PS.createPurchaseOrder(db, c, { supplierId: S.S1 });
  const theirs = await PS.createPurchaseOrder(db, c, { supplierId: S.S2 });
  await db.query('UPDATE cf_purchase_orders SET supplied_by_customer = 1 WHERE company_id = ? AND id = ?', [COMPANY, theirs.id]);
  const oursL = (await PS.addPurchaseLine(db, c, ours.id, { itemId: A, quantity: 2 })).lines[0].id;
  const theirsL = (await PS.addPurchaseLine(db, c, theirs.id, { itemId: A, quantity: 2 })).lines[0].id;
  const actor = (u, which) => refusal(() => purchaseRoutes.assertPoActor(db, u, COMPANY, which));
  ok('Purchase: our PO passes (by PO and by line)', !(await actor(USERS.buyer, { poId: ours.id })) && !(await actor(USERS.buyer, { lineId: oursL })));
  ok("Purchase: the customer's PO passes", !(await actor(USERS.buyer, { poId: theirs.id })));
  const e1 = await actor(USERS.stores, { poId: ours.id });
  ok('Stores (inventory manage): our PO → 403 FORBIDDEN, naming the PO and cf_erp_purchase', e1?.status === 403 && e1?.code === 'FORBIDDEN' && e1.message.includes(ours.code) && /cf_erp_purchase/.test(e1.message), j([e1?.status, e1?.code, e1?.message]));
  const e2 = await actor(USERS.stores, { lineId: oursL });
  ok('Stores: a line of our PO → 403 as well', e2?.status === 403);
  ok("Stores (inventory manage): the customer's PO passes (by PO and by line)", !(await actor(USERS.stores, { poId: theirs.id })) && !(await actor(USERS.stores, { lineId: theirsL })));
  ok("Stores (cf_erp_stores alone): the customer's PO passes", !(await actor(USERS.storesTag, { poId: theirs.id })));
  const e3 = await actor(USERS.viewer, { poId: theirs.id });
  ok("a viewer: even the customer's PO → 403", e3?.status === 403);
  ok('a PO that is not there is left to the service (no 403 here)', !(await actor(USERS.stores, { poId: 999999999 })));
  ok('admin passes (as everywhere)', !(await actor(USERS.admin, { poId: ours.id })));
  // and the service then does the work for Stores on the customer's PO: its expected date
  const moved = await PS.updatePurchaseOrder(db, c, theirs.id, { expectedDate: '2099-01-31' });
  ok("…the customer's PO's date moves once the actor passed", String(moved.expectedDate).slice(0, 10) === '2099-01-31', j(moved.expectedDate));

  section('3. Goods coming IN land in storage or quarantine');
  const area = async (key, purpose) => (await SA.createArea(db, c, { code: `${tag}-${key}`, name: `${tag} ${purpose}`, purpose })).id;
  const QA = await area('QA', 'quarantine');
  const DSP = await area('DSP', 'dispatch');
  const WIP = await area('WIP', 'wip');
  const SCR = await area('SCR', 'scrap');
  ok('RECEIVING_PURPOSES = storage, quarantine', j(SA.RECEIVING_PURPOSES) === j(['storage', 'quarantine']));
  const receipt = (toAreaId, qty = 1) => ST.postMovement(db, c, { movementType: 'receipt', toAreaId, lines: [{ itemId: A, quantity: qty, unitCost: 10 }] });
  for (const [key, id, purpose] of [['DSP', DSP, 'dispatch'], ['WIP', WIP, 'wip'], ['SCR', SCR, 'scrap']]) {
    const e = await refusal(() => receipt(id));
    const words = j(e?.problems ?? e?.message);
    ok(`Receive stock into the ${purpose} area → refused, naming ${tag}-${key} and "${purpose} area"`, !!e && words.includes(`${tag}-${key} is a ${purpose} area`) && /storage area/.test(words), words);
  }
  const multi = await refusal(() => ST.postMovement(db, c, { movementType: 'receipt', toAreaId: S.store, lines: [{ itemId: A, quantity: 1 }, { itemId: A, quantity: 1, toAreaId: DSP }] }));
  ok('a line of its own into dispatch is refused too (line 2 named)', !!multi && j(multi.problems ?? multi.message).includes(`Line 2: ${tag}-DSP is a dispatch area`), j(multi?.problems));
  const inStore = await receipt(S.store, 5);
  ok('into the storage area → posted', Number.isInteger(inStore?.id), j(inStore?.id));
  const inQa = await receipt(QA, 1);
  ok('into the quarantine area → posted (to be inspected)', Number.isInteger(inQa?.id), j(inQa?.id));
  const tr = await ST.postMovement(db, c, { movementType: 'transfer', fromAreaId: S.store, toAreaId: DSP, lines: [{ itemId: A, quantity: 1 }] });
  ok('a TRANSFER from storage into dispatch is not a receipt → still posted', Number.isInteger(tr?.id), j(tr?.id));
  const prod = await refusal(() => ST.postMovement(db, c, { movementType: 'receipt', toAreaId: DSP, lines: [{ itemId: A, quantity: 1 }] }, { fromProduction: true }));
  ok("production's own work (fromProduction) is not refused for its area", !prod || !j(prod.problems ?? prod.message).includes('is a dispatch area'), j(prod?.problems ?? prod?.message));

  const so = await S.order('SO', [[[A, 1]]]);
  const cm = await refusal(() => OWN.receiveCustomerMaterial(db, c, { orderId: so.id, toAreaId: WIP, lines: [{ itemId: A, quantity: 1 }] }));
  ok("customer material into a WIP area → refused, naming it", !!cm && j(cm.problems ?? cm.message).includes(`${tag}-WIP is a wip area`), j(cm?.problems ?? cm?.message));
  const cmOk = await OWN.receiveCustomerMaterial(db, c, { orderId: so.id, toAreaId: S.store, lines: [{ itemId: A, quantity: 1 }] });
  ok('customer material into the storage area → posted, theirs', Number.isInteger(cmOk?.id), j(cmOk?.id));
} catch (err) {
  ok(`ERROR ${err?.message}`, false, err?.stack);
} finally {
  await db.rollback();
  detachNodeCache(db);
  db.release();
}

const after = await H.counts();
const changed = after.filter((a) => (before.find((b) => b.name === a.name)?.n ?? 0) !== a.n).map((a) => a.name);
ok('ROLLED BACK: every cf_ table has exactly the rows it had', changed.length === 0, changed.join(', '));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed`);
if (H.state.failed) { console.log(H.state.fails.map((f) => `  - ${f}`).join('\n')); process.exitCode = 1; }
await pool.end();
