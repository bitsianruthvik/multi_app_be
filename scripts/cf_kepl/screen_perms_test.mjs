/**
 * screen_perms_test.mjs — THE PERMISSION ODDITIES OF "FIX THE OTHER CONFUSING SCREEN ISSUES" (user, 2026-10-24).
 *
 *   cd multi_app_be && node scripts/cf_kepl/screen_perms_test.mjs
 *
 *   1  a machine's Tools & spares list (routes/toolsResources.js): read with production view OR maintenance, kept with
 *      production manage OR maintenance — what maintenance MRs start from; the machine itself, its shifts and values stay
 *      on production manage (routes/production.js, unchanged);
 *   2  Company tax details (routes/gst.js): read with orders view OR accounts view, saved with accounts manage only (since
 *      2026-10-27, role_perms_test.mjs); HSN & GST by family: catalog manage OR accounts manage; invoices accounts manage;
 *   3  the scrap rate on Setup › Cutting (routes/inventory.js): catalog OR inventory, read and write; the rest of stock
 *      unchanged (inventory);
 *   4  the older work order page's reply says its kind ('cells' / 'po'), so the page can point to the contractor page.
 * Each route's own middleware is run with a user of each kind (no database, except 4, which only reads).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const routers = {
  tools: (await imp('apps/cf_erp/routes/toolsResources.js')).default,
  gst: (await imp('apps/cf_erp/routes/gst.js')).default,
  inventory: (await imp('apps/cf_erp/routes/inventory.js')).default,
  machines: (await imp('apps/cf_erp/routes/production.js')).default,
};
const WO = await imp('apps/cf_erp/services/workOrderService.js');

let passed = 0, failed = 0;
const ok = (label, cond, extra) => { if (cond) { passed++; console.log(`  PASS  ${label}`); } else { failed++; console.log(`  FAIL  ${label}${extra === undefined ? '' : ` — ${extra}`}`); } };
const section = (t) => console.log(`\n${t}`);

const USERS = {
  prodView: { role: 'operator', uiPermissions: ['cf_erp_production_view'] },
  prodManage: { role: 'operator', uiPermissions: ['cf_erp_production_view', 'cf_erp_production_manage'] },
  maintenance: { role: 'operator', uiPermissions: ['cf_erp_maintenance'] },
  ordersView: { role: 'operator', uiPermissions: ['cf_erp_orders_view'] },
  ordersManage: { role: 'operator', uiPermissions: ['cf_erp_orders_view', 'cf_erp_orders_manage'] },
  accountsView: { role: 'operator', uiPermissions: ['cf_erp_accounts_view'] },
  accountsManage: { role: 'operator', uiPermissions: ['cf_erp_accounts_view', 'cf_erp_accounts_manage'] },
  catalogView: { role: 'operator', uiPermissions: ['cf_erp_catalog_view'] },
  catalogManage: { role: 'operator', uiPermissions: ['cf_erp_catalog_view', 'cf_erp_catalog_manage'] },
  inventoryView: { role: 'operator', uiPermissions: ['cf_erp_inventory_view'] },
  inventoryManage: { role: 'operator', uiPermissions: ['cf_erp_inventory_view', 'cf_erp_inventory_manage'] },
  nobody: { role: 'operator', uiPermissions: [] },
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
const who = (router, method, routePath) => Object.keys(USERS).filter((k) => passes(router, method, routePath, USERS[k])).sort();
const TABLE = [
  // 1. Tools & spares
  ['1', 'tools', 'GET', '/machines/:id/resources', ['prodView', 'prodManage', 'maintenance', 'admin']],
  ['1', 'tools', 'PUT', '/machines/:id/resources', ['prodManage', 'maintenance', 'admin']],
  ['1', 'tools', 'POST', '/machines/:id/resources', ['prodManage', 'maintenance', 'admin']],
  ['1', 'tools', 'PUT', '/machine-resources/:id', ['prodManage', 'maintenance', 'admin']],
  ['1', 'tools', 'DELETE', '/machine-resources/:id', ['prodManage', 'maintenance', 'admin']],
  ['1', 'tools', 'GET', '/resource-items', ['prodView', 'prodManage', 'maintenance', 'admin']],
  // ... the machine itself and its shifts stay on production manage.
  ['1', 'machines', 'PUT', '/machines/:id', ['prodManage', 'admin']],
  ['1', 'machines', 'DELETE', '/machines/:id', ['prodManage', 'admin']],
  // 2. Company tax details and the family card
  ['2', 'gst', 'GET', '/settings/tax', ['ordersView', 'ordersManage', 'accountsView', 'accountsManage', 'admin']],
  ['2', 'gst', 'PUT', '/settings/tax', ['accountsManage', 'admin']],
  ['2', 'gst', 'GET', '/tax/states', ['ordersView', 'ordersManage', 'accountsView', 'accountsManage', 'admin']],
  ['2', 'gst', 'GET', '/tax/validate-gstin', ['ordersView', 'ordersManage', 'accountsView', 'accountsManage', 'admin']],
  ['2', 'gst', 'GET', '/tax/families', ['catalogView', 'catalogManage', 'accountsView', 'accountsManage', 'admin']],
  ['2', 'gst', 'PUT', '/tax/families/:id', ['catalogManage', 'accountsManage', 'admin']],
  // ... invoices: accounts manage only (2026-10-27).
  ['2', 'gst', 'POST', '/invoices/:id/issue', ['accountsManage', 'admin']],
  // 3. Scrap rate
  ['3', 'inventory', 'GET', '/stock/scrap-rate', ['catalogView', 'catalogManage', 'inventoryView', 'inventoryManage', 'admin']],
  ['3', 'inventory', 'PUT', '/stock/scrap-rate', ['catalogManage', 'inventoryManage', 'admin']],
  // ... the rest of stock is as it was.
  ['3', 'inventory', 'GET', '/stock', ['inventoryView', 'inventoryManage', 'admin']],
];
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
let shown = '';
for (const [n, r, method, p, want] of TABLE) {
  if (n !== shown) { section(`${n}. ${{ 1: "A machine's Tools & spares list", 2: 'Company tax details and HSN & GST by family', 3: 'The scrap rate on Setup › Cutting' }[n]}`); shown = n; }
  const got = who(routers[r], method, p);
  ok(`${method} ${p}: ${want.join(', ')}`, sameSet(got, want), `got ${got.join(', ')}`);
}
// The machines router: does it name the shifts with production manage? (Whatever the path, every write on it stays production.)
const machineWrites = routers.machines.stack.filter((l) => l.route && /^\/(machines|shifts|machine-)/.test(l.route.path) && Object.keys(l.route.methods).some((m) => m !== 'get'));
ok('every write on the machines router (the machine, its shifts, values) still refuses the maintenance tag alone',
  machineWrites.length > 0 && machineWrites.every((l) => !passes(routers.machines, Object.keys(l.route.methods)[0], l.route.path, USERS.maintenance)),
  machineWrites.filter((l) => passes(routers.machines, Object.keys(l.route.methods)[0], l.route.path, USERS.maintenance)).map((l) => l.route.path).join(', '));

section('4. The older work order page says its kind');
const [rows] = await pool.query("SELECT company_id, id, kind FROM cf_work_orders WHERE deleted_at IS NULL ORDER BY (kind = 'po') DESC, id DESC LIMIT 2");
if (!rows.length) ok('no work order in this database — nothing to read (skipped)', true);
for (const w of rows) {
  const got = await WO.getWorkOrder(pool, w.company_id, w.id);
  ok(`work order ${w.id}: kind ${got.kind} (the row's ${w.kind ?? 'null → cells'})`, got.kind === (w.kind ?? 'cells'));
}
const other = rows[0] ? await WO.getWorkOrder(pool, rows[0].company_id + 1_000_000, rows[0].id).then(() => 'read', (e) => e?.status ?? e?.code ?? 'refused') : 404;
ok('another company never reads it (the company filter stays)', other !== 'read', String(other));

await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
