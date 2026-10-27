/**
 * role_perms_test.mjs — WHO MAY DO WHAT AFTER "ORDERS MANAGE IS TOO BROAD" (user decisions, 2026-10-27; init.sql §94).
 *
 *   cd multi_app_be && node scripts/cf_kepl/role_perms_test.mjs
 *
 *   A  Tax invoices (raise — from dispatches too — edit, issue, cancel, delete a draft, IRN, e-way bills), Company tax
 *      details and Setup › Templates are written with ACCOUNTS MANAGE ONLY; reading them stays open to orders view (and
 *      accounts view). HSN & GST by family stays catalog manage OR accounts manage. Deleting an order needs the new
 *      cf_erp_orders_delete (the MD) or admin; status changes, revisions and the order's own acceptance stay on orders
 *      manage. A shipment drafts its tax invoice only for accounts manage (routes/tracker.js shipInput).
 *   B  PPC (production manage) dispatches a production order, ships a line, reserves / issues / lets go of stock for
 *      production — with inventory manage as before; receipts, movements, areas, batches and GRNs stay Stores'. Plan
 *      health and the maintenance schedule (board, orders, planned downtime) are READ with production view; their writes
 *      stay on cf_erp_maintenance, re-baselining approval on the approval tags.
 * Each route's own middleware is run with a user of each kind (no database). The users are the real tag lists of
 * Placebo's roles (access_check/ACCESS_ASIMA_PRANAY.md) plus an Accounts user, an MD-like user holding every tag, and
 * an admin with no tags (admins pass every backend guard).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { PERM } = await imp('apps/cf_erp/lib/http.js');
const { APPROVAL_PERMS } = await imp('apps/cf_erp/services/approvalService.js');
const R = async (f) => (await imp(`apps/cf_erp/routes/${f}.js`)).default;
const routers = {
  gst: await R('gst'), acceptance: await R('acceptance'), accounts: await R('accounts'), orders: await R('orders'),
  tracker: await R('tracker'), productionOrders: await R('productionOrders'), inventory: await R('inventory'), grn: await R('grn'),
  planner3: await R('planner3'), maintenance: await R('maintenance'), approvals: await R('approvals'), purchaseFlow: await R('purchaseFlow'),
};
const { shipInput } = await imp('apps/cf_erp/routes/tracker.js');

let passed = 0, failed = 0;
const ok = (label, cond, extra) => { if (cond) { passed++; console.log(`  PASS  ${label}`); } else { failed++; console.log(`  FAIL  ${label}${extra === undefined ? '' : ` — ${extra}`}`); } };
const section = (t) => console.log(`\n${t}`);

const tags = (...t) => t.map((x) => `cf_erp_${x}`);
const ALL = [...new Set([...Object.values(PERM), ...APPROVAL_PERMS])];
const USERS = {
  // Placebo "Design & materials" (Chilpoori Pranayreddy): orders manage without accounts.
  ordersOnly: { role: 'Design & materials', uiPermissions: tags('catalog_manage', 'catalog_view', 'inventory_view', 'orders_manage', 'orders_view', 'parties_manage', 'production_view', 'purchase') },
  // Placebo "PPC" (Asima Nanda).
  ppc: { role: 'PPC', uiPermissions: tags('catalog_view', 'floor', 'inventory_view', 'orders_manage', 'orders_view', 'production_manage', 'production_view') },
  accounts: { role: 'Accounts', uiPermissions: tags('accounts_view', 'accounts_manage') },
  // The MD / Test login: every cf_erp tag (they hold accounts manage, so they keep invoices, tax and templates).
  md: { role: 'MD', uiPermissions: ALL },
  admin: { role: 'admin', uiPermissions: [] },
  // Two more, to show what stays where it was: Stores alone, and production view alone.
  stores: { role: 'Stores', uiPermissions: tags('inventory_view', 'inventory_manage', 'stores') },
  prodView: { role: 'Viewer', uiPermissions: tags('production_view') },
};
ok('the MD-like user holds cf_erp_orders_delete and cf_erp_accounts_manage', ALL.includes('cf_erp_orders_delete') && ALL.includes('cf_erp_accounts_manage'));

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
const who = (router, method, routePath) => Object.keys(USERS).filter((k) => passes(router, method, routePath, USERS[k])).sort();

const ACCOUNTS_ONLY = ['accounts', 'md', 'admin'];
const READERS = ['ordersOnly', 'ppc', 'accounts', 'md', 'admin'];
const ORDERS_MANAGE = ['ordersOnly', 'ppc', 'md', 'admin'];
const MOVE_FOR_PRODUCTION = ['ppc', 'stores', 'md', 'admin'];
const STORES_ONLY = ['stores', 'md', 'admin'];
const PROD_VIEW = ['ordersOnly', 'ppc', 'prodView', 'md', 'admin'];
const MAINT_WRITE = ['md', 'admin'];
const TABLE = [
  ['A1', 'Tax invoices — writes are Accounts\' only, reads unchanged (+ accounts view)'],
  ['gst', 'POST', '/orders/:id/invoices', ACCOUNTS_ONLY],
  ['gst', 'PUT', '/invoices/:id', ACCOUNTS_ONLY],
  ['gst', 'DELETE', '/invoices/:id', ACCOUNTS_ONLY],
  ['gst', 'DELETE', '/invoices/:id/lines/:lineId', ACCOUNTS_ONLY],
  ['gst', 'POST', '/invoices/:id/issue', ACCOUNTS_ONLY],
  ['gst', 'POST', '/invoices/:id/cancel', ACCOUNTS_ONLY],
  ['gst', 'PUT', '/invoices/:id/irn', ACCOUNTS_ONLY],
  ['gst', 'POST', '/invoices/:id/eway-bills', ACCOUNTS_ONLY],
  ['gst', 'DELETE', '/invoices/:id/eway-bills/:ewbId', ACCOUNTS_ONLY],
  ['accounts', 'POST', '/accounts/invoices', ACCOUNTS_ONLY],
  ['gst', 'GET', '/invoices', READERS],
  ['gst', 'GET', '/invoices/:id', READERS],
  ['gst', 'GET', '/invoices/:id/print', READERS],
  ['gst', 'GET', '/invoices/:id/einvoice.json', READERS],
  ['gst', 'GET', '/invoices/:id/ewaybill.json', READERS],
  ['gst', 'GET', '/orders/:id/invoices', READERS],
  // Shipped, not invoiced across orders (Accounts › Invoices) — so Accounts raise them without the sales order open.
  ['gst', 'GET', '/invoices/uninvoiced', READERS],
  ['A2', 'Company tax details — accounts manage only; HSN & GST by family unchanged'],
  ['gst', 'PUT', '/settings/tax', ACCOUNTS_ONLY],
  ['gst', 'GET', '/settings/tax', READERS],
  ['gst', 'GET', '/tax/states', READERS],
  ['gst', 'GET', '/tax/validate-gstin', READERS],
  ['gst', 'PUT', '/tax/families/:id', ['ordersOnly', 'accounts', 'md', 'admin']],
  ['A3', 'Setup › Templates — accounts manage only; the order\'s own acceptance stays on orders manage'],
  ['acceptance', 'POST', '/term-templates', ACCOUNTS_ONLY],
  ['acceptance', 'PUT', '/term-templates/:id', ACCOUNTS_ONLY],
  ['acceptance', 'DELETE', '/term-templates/:id', ACCOUNTS_ONLY],
  ['acceptance', 'GET', '/term-templates', READERS],
  ['acceptance', 'PUT', '/orders/:id/acceptance', ORDERS_MANAGE],
  ['acceptance', 'POST', '/orders/:id/acceptance/withdraw', ORDERS_MANAGE],
  ['A4', 'Deleting an order — cf_erp_orders_delete (MD) or admin; status changes and revisions stay on orders manage'],
  ['orders', 'DELETE', '/orders/:id', ['md', 'admin']],
  ['orders', 'POST', '/orders/:id/status', ORDERS_MANAGE],
  ['orders', 'PUT', '/orders/:id', ORDERS_MANAGE],
  ['orders', 'POST', '/orders/:id/revise', ORDERS_MANAGE],
  ['orders', 'DELETE', '/orders/:id/revision', ORDERS_MANAGE],
  ['B1', 'Dispatch, ship and stock to production — production manage OR inventory manage; the rest of stock stays Stores\''],
  ['productionOrders', 'POST', '/production-orders/:id/dispatch', MOVE_FOR_PRODUCTION],
  ['tracker', 'POST', '/order-lines/:id/ship', MOVE_FOR_PRODUCTION],
  ['tracker', 'POST', '/requirements/:id/reserve', MOVE_FOR_PRODUCTION],
  ['tracker', 'POST', '/releases/:id/reserve', MOVE_FOR_PRODUCTION],
  ['tracker', 'POST', '/requirements/:id/issue', MOVE_FOR_PRODUCTION],
  ['tracker', 'DELETE', '/reservations/:id', MOVE_FOR_PRODUCTION],
  ['inventory', 'POST', '/movements', STORES_ONLY],
  ['inventory', 'POST', '/movements/:id/reverse', STORES_ONLY],
  ['inventory', 'POST', '/stocking-areas', STORES_ONLY],
  ['inventory', 'PUT', '/batches/:id', STORES_ONLY],
  ['grn', 'POST', '/purchase-orders/:id/grn', STORES_ONLY],
  ['C1', 'Who supplies the material — the order default and each line: orders manage OR inventory manage (Stores alone too)'],
  ['purchaseFlow', 'PUT', '/orders/:id/material-supply', ['ordersOnly', 'ppc', 'stores', 'md', 'admin']],
  ['purchaseFlow', 'PUT', '/order-lines/:id/material-supply', ['ordersOnly', 'ppc', 'stores', 'md', 'admin']],
  ['B2', 'Plan health — read with production view or an approval tag; the plan\'s writes and approvals unchanged'],
  ['planner3', 'GET', '/planner3/health', PROD_VIEW],
  ['planner3', 'POST', '/planner3/rebaseline', ['ppc', 'md', 'admin']],
  ['approvals', 'POST', '/approvals/:id/decide', ['md', 'admin']],
  ['B3', 'Maintenance schedule — read with production view; every write stays on cf_erp_maintenance'],
  ['maintenance', 'GET', '/maintenance/board', PROD_VIEW],
  ['maintenance', 'GET', '/maintenance/orders', PROD_VIEW],
  ['maintenance', 'GET', '/maintenance/orders/:id', PROD_VIEW],
  ['maintenance', 'GET', '/maintenance/downtime', PROD_VIEW],
  ['maintenance', 'POST', '/maintenance/orders', MAINT_WRITE],
  ['maintenance', 'POST', '/maintenance/orders/:id/status', MAINT_WRITE],
  ['maintenance', 'POST', '/maintenance/orders/:id/close', MAINT_WRITE],
  ['maintenance', 'GET', '/maintenance/orders/:id/mr-lines', MAINT_WRITE],
  ['maintenance', 'POST', '/maintenance/downtime', MAINT_WRITE],
  ['maintenance', 'PUT', '/maintenance/downtime/:id', MAINT_WRITE],
  ['maintenance', 'DELETE', '/maintenance/downtime/:id', MAINT_WRITE],
  ['maintenance', 'POST', '/maintenance/plans', MAINT_WRITE],
  ['maintenance', 'POST', '/maintenance/faults', ['ppc', 'md', 'admin']],
];
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
for (const row of TABLE) {
  if (row.length === 2) { section(`${row[0]}. ${row[1]}`); continue; }
  const [r, method, p, want] = row;
  const got = who(routers[r], method, p);
  ok(`${method} ${p}: ${want.join(', ')}`, sameSet(got, want), `got ${got.join(', ')}`);
}

section('A5. A shipment drafts its tax invoice only for accounts manage (shipInput: ship a line, dispatch a production order)');
const body = { quantity: 2, reference: 'T', invoice: true };
const forUser = (u) => shipInput({ user: USERS[u], body: { ...body } });
for (const u of ['ppc', 'stores', 'ordersOnly']) ok(`${u}: invoice false, the rest of the body kept`, forUser(u).invoice === false && forUser(u).quantity === 2 && forUser(u).reference === 'T');
for (const u of ['accounts', 'md', 'admin']) ok(`${u}: the body as sent (invoice true)`, forUser(u).invoice === true);
ok('accounts manage, no invoice field: none added (the service drafts by default)', !('invoice' in shipInput({ user: USERS.md, body: { quantity: 1 } })));
ok('accounts manage may still say invoice: false', shipInput({ user: USERS.md, body: { invoice: false } }).invoice === false);
ok('no body: { invoice: false } for PPC', JSON.stringify(shipInput({ user: USERS.ppc })) === '{"invoice":false}');

await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
