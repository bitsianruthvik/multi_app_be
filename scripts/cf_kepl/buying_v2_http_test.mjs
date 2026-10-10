/**
 * buying_v2_http_test.mjs — the Buying v2 routes (TM/CF_ERP_BUYING_V2.md, init.sql §56) through REAL
 * HTTP: express in this process on a random port, a JWT per user, the routes' own pool and transactions.
 * Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/buying_v2_http_test.mjs
 *   CF_BUY_COMPANY=2 (the tenant that owns the fixture)   CF_BUY_OTHER_COMPANY=<id> (company B)
 *   CF_BUY_HTTP_EXAMPLES=<file.json>  writes one real request / response per route (what the contract quotes)
 *
 * WHY THIS ONE COMMITS. The service suites run in one rolled-back transaction. Real HTTP uses the POOL
 * and each write route opens its own transaction, so the fixture is COMMITTED and then DELETED here.
 *
 * CLEANUP RULE (as nest_v2_http_test.mjs — the only rows ever deleted), in a `finally` and on
 * SIGINT/SIGTERM: before the fixture is built, MAX(id) of every cf_ table with an AUTO_INCREMENT id and
 * every cf_ table's COUNT(*) are recorded. Afterwards, with FOREIGN_KEY_CHECKS = 0 (restored), rows with
 *      company_id = <the tenant>  AND  id > <the recorded max>  AND  created_at >= the run's start - 5 s
 * are hard-deleted (cf_item_details by master_id). Rows above the max that are OLDER than the run are
 * another process's: reported, never deleted. Then every cf_ table's count is compared with the snapshot.
 * TODAY IS SET for the process (2026-10-12, a Monday) — the routes run in it, so they see the same day.
 *
 *   the main path     raise → stock check (dry, apply) → skip / unskip → purchase orders with dates →
 *                     a PO line's date moved → the reads → the planner (snapshot, a refused save, a save)
 *   permissions       403 for every write without cf_erp_inventory_manage (and the planner's own grant)
 *   tenant isolation  404 for another company's requisition, order and line; its ids are refused in bodies
 *   errors            every problem at once, naming order, item and purchase order
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const MR = await imp('apps/cf_erp/services/materialReadyService.js');
const PL = await imp('apps/cf_erp/services/plannerService.js');
const FX = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');
const { signToken } = await imp('core/utils/jwt.js');
const { default: cfApp } = await imp('apps/cf_erp/app.js');

const COMPANY = Number(process.env.CF_BUY_COMPANY ?? 2);
const KEPL_LINE = 923;
const TODAY = '2026-10-12';
const D = (n) => FX.addDays(TODAY, n);
const tag = `BH${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean — got ${typeof name}, ${typeof cond}`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);

/* ───────────────────────────── snapshot ───────────────────────────── */
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const [colRows] = await pool.query("SELECT TABLE_NAME t, COLUMN_NAME c, EXTRA e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%'");
const meta = new Map(tables.map((t) => [t.name, { name: t.name, auto: null, company: false, created: false }]));
for (const r of colRows) {
  const m = meta.get(r.t); if (!m) continue;
  if (/auto_increment/i.test(r.e)) m.auto = r.c;
  if (r.c === 'company_id') m.company = true;
  if (r.c === 'created_at') m.created = true;
}
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const maxId = {};
{
  const autos = [...meta.values()].filter((m) => m.auto);
  const [rows] = await pool.query(autos.map((m) => `SELECT '${m.name}' AS name, COALESCE(MAX(\`${m.auto}\`),0) AS mx FROM \`${m.name}\``).join(' UNION ALL '));
  for (const r of rows) maxId[r.name] = Number(r.mx);
}
const [[{ startedAt }]] = await pool.query("SELECT DATE_FORMAT(NOW() - INTERVAL 5 SECOND, '%Y-%m-%d %H:%i:%s') AS startedAt");
const kepl = async () => {
  const [[l]] = await pool.query('SELECT id, order_id, locked_at FROM cf_sales_order_lines WHERE id = ?', [KEPL_LINE]).then((x) => (x[0].length ? x : [[null]]));
  const [[r]] = await pool.query('SELECT COUNT(*) n FROM cf_production_releases WHERE order_line_id = ? AND deleted_at IS NULL', [KEPL_LINE]);
  return J([l ?? null, Number(r.n)]);
};
const keplBefore = await kepl();
const [[userA]] = await pool.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
const [companiesB] = await pool.query('SELECT id FROM companies WHERE id <> ? AND deleted_at IS NULL ORDER BY id', [COMPANY]);
const COMPANY_B = Number(process.env.CF_BUY_OTHER_COMPANY ?? companiesB[0]?.id);
if (!COMPANY_B) throw new Error('There is no second company to test tenant isolation with.');
const [[userB]] = await pool.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY_B]);
const [[slugRow]] = await pool.query('SELECT slug FROM companies WHERE id = ?', [COMPANY]);

/* ───────────────────────────── cleanup ───────────────────────────── */
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const guard = (m) => (m.created ? ' AND (created_at IS NULL OR created_at >= ?)' : '');
    const args = (m, base) => (m.created ? [...base, startedAt] : base);
    let deleted = 0;
    for (const m of meta.values()) {
      if (!m.company) continue;
      if (m.auto) {
        if (m.created) {
          const [[f]] = await conn.query(`SELECT COUNT(*) n FROM \`${m.name}\` WHERE company_id = ? AND \`${m.auto}\` > ? AND created_at < ?`, [COMPANY, maxId[m.name], startedAt]);
          if (Number(f.n)) console.log(`  NOTE  ${m.name}: ${f.n} row(s) above the snapshot id were created before this run started — left alone (another process)`);
        }
        const [r] = await conn.query(`DELETE FROM \`${m.name}\` WHERE company_id = ? AND \`${m.auto}\` > ?${guard(m)}`, args(m, [COMPANY, maxId[m.name]]));
        deleted += r.affectedRows;
      } else if (m.name === 'cf_item_details') {
        const [r] = await conn.query(`DELETE FROM cf_item_details WHERE company_id = ? AND master_id > ?${guard(m)}`, args(m, [COMPANY, maxId.cf_master_records]));
        deleted += r.affectedRows;
      } else if (m.created) {
        const [r] = await conn.query(`DELETE FROM \`${m.name}\` WHERE company_id = ? AND created_at >= ?`, [COMPANY, startedAt]);
        deleted += r.affectedRows;
      }
    }
    console.log(`  cleanup: ${deleted} rows deleted`);
  } finally {
    try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch { /* released next */ }
    conn.release();
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log(`\n${sig}: cleaning up…`); cleanup().catch((e) => console.error(e)).finally(() => process.exit(130)); });

/* ───────────────────────────── http ───────────────────────────── */
const app = express();
app.use(express.json({ limit: '50mb' }));
cfApp.register(app);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const PORT = server.address().port;
const mint = (companyId, userId, perms, role = 'operator') => signToken({ id: userId ?? 1, email: 'buying-http-test@example.com', role, companyId, uiPermissions: perms });
const SEE = ['cf_erp_inventory_view', 'cf_erp_orders_view', 'cf_erp_production_view'];
const T_MANAGER = mint(COMPANY, userA?.id, [...SEE, 'cf_erp_inventory_manage', 'cf_erp_production_manage']);
const T_VIEWER = mint(COMPANY, userA?.id, SEE);
const T_NONE = mint(COMPANY, userA?.id, ['cf_erp_orders_view']);
const T_B = mint(COMPANY_B, userB?.id ?? userA?.id, [...SEE, 'cf_erp_inventory_manage', 'cf_erp_production_manage']);
const examples = {};
/** One call: { status, json }. token undefined = manager, null = none. `as` records it as the example of that name. */
async function call(method, url, { token = T_MANAGER, body, as = null } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${slugRow?.slug ?? 'x'}/cf_erp${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (as) examples[as] = { request: `${method} ${url}`, ...(body !== undefined ? { body } : {}), status: r.status, response: json };
  return { status: r.status, json, text };
}

let exitCode = 0;
let fx = null;
try {
  MR.setToday(TODAY);
  section('Setup: a committed fixture, express on a random port');
  {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      attachNodeCache(conn);
      const c = { companyId: COMPANY, userId: userA.id };
      const F = await FX.simple(conn, c, tag, { itemKeys: ['A', 'B', 'C'] });
      await F.receive(F.items.A, 10);
      const O1 = await F.order('O1', [[[F.items.A, 10], [F.items.B, 4], [F.items.C, 2]]]);
      const O2 = await F.order('O2', [[[F.items.A, 3]]]);
      fx = { ...F.items, S1: F.S1, S2: F.S2, store: F.store, O1, O2 };
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch { /* the original error matters */ } throw e; } finally { detachNodeCache(conn); conn.release(); }
  }
  console.log(`  ${tag}: orders ${fx.O1.id} / ${fx.O2.id}; server :${PORT}; company B = ${COMPANY_B}`);
  const byItem = (pr, itemId) => pr.lines.find((l) => l.item.id === itemId);

  /* ───────────── 1 ───────────── */
  section('1. Raise');
  let r = await call('GET', `/orders/${fx.O1.id}/requisitions`);
  ok('GET the order\'s requisitions before any is raised: none, and the line says it can be', r.status === 200 && r.json.requisitions.length === 0 && r.json.linesWithout.length === 1 && r.json.linesWithout[0].canRaise === true && r.json.linesWithout[0].materials.length === 3, J(r.json));
  r = await call('POST', `/orders/${fx.O1.id}/requisitions`, { token: T_VIEWER, body: {} });
  ok('raising without cf_erp_inventory_manage → 403', r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
  r = await call('POST', `/orders/${fx.O1.id}/requisitions`, { body: {}, as: 'raise' });
  ok('POST raise → 200, one requisition, three lines, nothing earmarked', r.status === 200 && r.json.raised === 1 && r.json.requisitions[0].lines.length === 3 && r.json.requisitions[0].status === 'open', J([r.status, r.json?.raised]));
  const prId = r.json.requisitions[0].id;
  const lineA = byItem(r.json.requisitions[0], fx.A).id; const lineB = byItem(r.json.requisitions[0], fx.B).id; const lineC = byItem(r.json.requisitions[0], fx.C).id;
  r = await call('POST', `/orders/${fx.O2.id}/requisitions`, { body: {} });
  const pr2 = r.json.requisitions[0].id;
  r = await call('POST', `/orders/${fx.O1.id}/requisitions`, { body: {} });
  ok('raising again only refreshes (raised 0, refreshed 1)', r.status === 200 && r.json.raised === 0 && r.json.refreshed === 1);

  /* ───────────── 2 ───────────── */
  section('2. Stock check');
  r = await call('POST', `/requisitions/${prId}/stock-check`, { token: T_VIEWER, body: {}, as: 'stockCheckDryRun' });
  ok('the dry run needs only the view grant: proposes A 10', r.status === 200 && r.json.applied === false && r.json.lines.find((l) => l.lineId === lineA).proposeHold === 10, J(r.json));
  r = await call('POST', `/requisitions/${prId}/stock-check`, { token: T_VIEWER, body: { lineIds: [lineB] }, as: 'stockCheckOneLine' });
  ok('the dry run for ONE requisition line (lineIds) answers that row only', r.status === 200 && r.json.lines.length === 1 && r.json.lines[0].lineId === lineB, J(r.json?.lines));
  r = await call('POST', `/requisitions/${prId}/stock-check`, { token: T_VIEWER, body: { apply: true } });
  ok('applying it without the manage grant → 403', r.status === 403);
  r = await call('POST', `/requisitions/${prId}/stock-check`, { body: { apply: true, lines: [{ lineId: lineA, hold: 99 }] } });
  ok('holding more than is free → 422, naming the order and the item', r.status === 422 && r.json.problems[0].includes(fx.O1.code) && r.json.problems[0].includes(`${tag}-A`), J(r.json));
  r = await call('POST', `/requisitions/${prId}/stock-check`, { body: { apply: true }, as: 'stockCheckApply' });
  ok('apply → 200, A held for the requisition line', r.status === 200 && r.json.applied === true && r.json.held[0].quantity === 10 && byItem(r.json.requisition, fx.A).status === 'from_stock', J(r.json?.held));
  r = await call('POST', `/requisitions/${pr2}/stock-check`, { body: {} });
  ok('EARMARK INVISIBILITY over HTTP: the other order\'s stock check sees 0 free', r.status === 200 && r.json.lines[0].freeInStock === 0 && r.json.canApply === false, J(r.json?.lines));

  /* ───────────── 3 ───────────── */
  section('3. Skip / unskip');
  r = await call('POST', `/requisitions/${prId}/skip`, { token: T_VIEWER, body: { lineIds: [lineC] } });
  ok('skip without the manage grant → 403', r.status === 403);
  r = await call('POST', `/requisitions/${prId}/skip`, { body: { lineIds: [lineC], note: 'free-issue by the client' }, as: 'skip' });
  ok('skip one material → 200, recorded', r.status === 200 && r.json.changed === 1 && byItem(r.json.requisition, fx.C).status === 'skipped' && byItem(r.json.requisition, fx.C).skipped.note === 'free-issue by the client');
  r = await call('POST', `/requisitions/${prId}/unskip`, { body: { all: true }, as: 'unskip' });
  ok('unskip all → 200', r.status === 200 && r.json.changed === 1 && byItem(r.json.requisition, fx.C).skipped === null);
  r = await call('POST', `/requisitions/${prId}/skip`, { body: { all: true } });
  ok('skip all → the two open materials (A is held: left alone)', r.status === 200 && r.json.changed === 2 && byItem(r.json.requisition, fx.A).skipped === null, J(r.json?.lineIds));
  r = await call('POST', `/requisitions/${prId}/unskip`, { body: { lineIds: [lineB] } });
  ok('unskip B (it will be bought)', r.status === 200 && r.json.changed === 1);

  /* ───────────── 4 ───────────── */
  section('4. Purchase orders from requisition lines, each line with a date');
  r = await call('POST', '/requisitions/purchase-orders', { token: T_VIEWER, body: { orders: [{ supplierId: fx.S1, place: true, lines: [{ prLineId: lineB, expectedDate: D(9) }] }] } });
  ok('without the manage grant → 403', r.status === 403);
  r = await call('POST', '/requisitions/purchase-orders', { body: { orders: [{ place: true, lines: [{ prLineId: lineB, quantity: 99 }, { prLineId: 999999999 }] }, { supplierId: fx.S1, lines: [] }] }, as: 'purchaseOrdersRefused' });
  ok('every problem at once (no supplier to place with, too much, an unknown line, an empty PO) → 422', r.status === 422 && r.json.problems.length >= 4 && r.json.problems.some((p) => p.includes(fx.O1.code) && p.includes(`${tag}-B`)), J(r.json));
  r = await call('POST', '/requisitions/purchase-orders', { body: { orders: [
    { supplierId: fx.S1, place: true, lines: [{ prLineId: lineB, quantity: 3, expectedDate: D(9) }] },
    { supplierId: fx.S2, place: true, lines: [{ prLineId: lineB, quantity: 1, expectedDate: D(23) }] },
  ] }, as: 'purchaseOrders' });
  ok('B split over TWO purchase orders, each with its own date → 200', r.status === 200 && r.json.purchaseOrders.length === 2 && r.json.purchaseOrders.every((p) => p.status === 'ordered')
    && J(r.json.purchaseOrders.map((p) => [p.lines[0].quantity, p.lines[0].expectedDate])) === J([[3, D(9)], [1, D(23)]]), J(r.json?.purchaseOrders));
  const poLine2 = r.json.purchaseOrders[1].lines[0].id;
  ok('…the requisition line is covered, last delivery on the later one', byItem(r.json.requisitions[0], fx.B).status === 'covered' && byItem(r.json.requisitions[0], fx.B).cover.lastDate === D(23));
  r = await call('PUT', `/purchase-lines/${poLine2}`, { body: { expectedDate: D(30) }, as: 'purchaseLineDate' });
  ok('PUT a PO line\'s date (the existing route) → 200', r.status === 200 && r.json.lines[0].orders[0].prLineId === lineB, J(r.json?.lines?.[0]?.orders));

  /* ───────────── 5 ───────────── */
  section('5. The reads');
  r = await call('GET', `/requisitions/${prId}`, { token: T_VIEWER, as: 'requisition' });
  ok('GET /requisitions/:id → the requisition, "mixed": A from stock, B on order, C skipped', r.status === 200 && r.json.status === 'mixed' && r.json.done === true && r.json.materialReady.state === 'waiting'
    && byItem(r.json, fx.B).cover.lastDate === D(30), J([r.json?.status, r.json?.materialReady]));
  r = await call('GET', `/order-lines/${fx.O1.line.id}/requisition`, { token: T_VIEWER });
  ok('GET /order-lines/:id/requisition → the same requisition', r.status === 200 && r.json.requisition.id === prId);
  r = await call('GET', `/order-lines/${fx.O1.line.id}/material-ready`, { token: T_VIEWER, as: 'materialReady' });
  ok('GET /order-lines/:id/material-ready → waiting, three materials each with its cover', r.status === 200 && r.json.state === 'waiting' && r.json.materials.length === 3 && r.json.requisition.id === prId, J(r.json?.state));
  r = await call('GET', `/orders/${fx.O1.id}/requisitions`, { token: T_VIEWER, as: 'orderRequisitions' });
  ok('GET /orders/:id/requisitions → one requisition, no line left without', r.status === 200 && r.json.requisitions.length === 1 && r.json.linesWithout.length === 0);
  r = await call('GET', `/buying/board?orderId=${fx.O1.id}`, { token: T_VIEWER, as: 'buyingBoard' });
  ok('GET /buying/board → the "Waiting for stock" group comes from the server, same card shape + waitingLines', r.status === 200 && r.json.waitingForStock.key === 'waiting_for_stock' && r.json.waitingForStock.count === 1
    && r.json.waitingForStock.cards[0].id === prId && r.json.waitingForStock.cards[0].waitingLines[0].item.id === fx.C && r.json.waitingForStock.cards[0].waitingLines[0].short === 2, J(r.json?.waitingForStock));
  examples.waitingForStock = { request: `GET /buying/board?orderId=${fx.O1.id}`, status: 200, response: { waitingForStock: r.json.waitingForStock } };
  ok('GET /buying/board → the card in the "mixed" column, with its two POs', r.status === 200 && r.json.columns.find((x) => x.key === 'mixed').cards[0]?.id === prId && r.json.columns.find((x) => x.key === 'mixed').cards[0].purchaseOrders.length === 2, J(r.json?.columns?.map((x) => [x.key, x.count])));
  r = await call('GET', `/orders/${fx.O1.id}/purchase`, { token: T_VIEWER });
  ok('the OLD GET /orders/:id/purchase still answers (shortfall, lanes, held) — and now carries the requisitions', r.status === 200 && Array.isArray(r.json.shortfall) && Array.isArray(r.json.lanes) && r.json.held.total >= 1 && r.json.requisitions[0].id === prId);
  r = await call('GET', `/purchase/board?orderId=${fx.O1.id}`, { token: T_VIEWER });
  ok('the OLD GET /purchase/board still answers: both POs in Ordered', r.status === 200 && r.json.lanes.find((l) => l.key === 'ordered').count === 2);
  r = await call('GET', `/requisitions/${prId}`, { token: T_NONE });
  ok('reading without cf_erp_inventory_view → 403', r.status === 403);
  r = await call('GET', `/requisitions/${prId}`, { token: null });
  ok('no token → 401', r.status === 401);

  /* ───────────── 6 ───────────── */
  section('6. The planner over HTTP');
  r = await call('GET', '/planner?from=2026-10-01', { token: T_VIEWER });
  const unit = r.json?.units.find((u) => u.key === fx.O1.line.unitKey);
  ok('GET /planner: the unit carries the engine\'s answer; the old fields are still there', r.status === 200 && unit?.material.state === 'waiting' && Array.isArray(unit.materials) && typeof r.json.supply === 'object' && r.json.materialReady.engine === 2, J(unit?.material));
  examples.plannerUnit = { request: 'GET /planner?from=2026-10-01', status: 200, response: { 'units[n]': { key: unit.key, materials: unit.materials, material: unit.material }, materialReady: r.json.materialReady } };
  r = await call('PUT', '/planner/entries', { body: { entries: [{ unitKey: fx.O1.line.unitKey, shipDate: PL.periodFloor(D(40)), pinned: true }] }, as: 'plannerSaveRefused' });
  ok('PUT /planner/entries for a waiting unit → 422 MATERIAL_NOT_READY, naming it', r.status === 422 && (r.json.error === 'MATERIAL_NOT_READY' || r.json.code === 'MATERIAL_NOT_READY') && r.json.problems[0].includes(fx.O1.code) && r.json.detail.units[0].kind === 'waiting', J(r.json));
  // The skipped material arrives: plannable from the week the PO material allows.
  {
    const conn = await pool.getConnection();
    try { await conn.beginTransaction(); attachNodeCache(conn); await FX.receiveInto(conn, { companyId: COMPANY, userId: userA.id }, fx.store, fx.C, 2); await conn.commit(); } catch (e) { try { await conn.rollback(); } catch { /* */ } throw e; } finally { detachNodeCache(conn); conn.release(); }
  }
  r = await call('GET', '/planner?from=2026-10-01', { token: T_VIEWER });
  const unit2 = r.json.units.find((u) => u.key === fx.O1.line.unitKey);
  ok(`stock for the skipped material is received: the very next GET says dated ${D(30)}`, unit2.material.state === 'dated' && unit2.material.readyDate === D(30) && unit2.material.earliest === PL.periodFloor(D(30)), J(unit2.material));
  r = await call('PUT', '/planner/entries', { body: { entries: [{ unitKey: fx.O1.line.unitKey, shipDate: PL.periodFloor(D(9)), pinned: true }] } });
  ok('too early → 422, with the earliest week', r.status === 422 && r.json.detail.units[0].kind === 'material_late' && r.json.detail.units[0].earliest === PL.periodFloor(D(30)), J(r.json?.detail));
  r = await call('PUT', '/planner/entries', { token: T_VIEWER, body: { entries: [{ unitKey: fx.O1.line.unitKey, shipDate: PL.periodFloor(D(30)), pinned: true }] } });
  ok('planning without cf_erp_production_manage → 403', r.status === 403);
  r = await call('PUT', '/planner/entries', { body: { entries: [{ unitKey: fx.O1.line.unitKey, shipDate: PL.periodFloor(D(30)), pinned: true }] }, as: 'plannerSave' });
  ok('in its week → 200', r.status === 200 && r.json.entries[fx.O1.line.unitKey].shipDate === PL.periodFloor(D(30)), J(r.json));
  r = await call('PUT', `/purchase-lines/${poLine2}`, { body: { expectedDate: D(45) }, as: 'purchaseLineDateMoved' });
  ok('the PUT itself answers with the planned unit it made late (no planner read needed)', r.status === 200 && r.json.plannedUnits.late === 1 && r.json.plannedUnits.units[0].unitKey === fx.O1.line.unitKey
    && r.json.plannedUnits.units[0].wasDate === D(30) && r.json.plannedUnits.units[0].readyDate === D(45) && r.json.plannedUnits.units[0].order.id === fx.O1.id, J(r.json?.plannedUnits));
  if (examples.purchaseLineDateMoved) examples.purchaseLineDateMoved.response = { '…': 'the purchase order, as before', plannedUnits: r.json.plannedUnits };
  r = await call('GET', '/planner?from=2026-10-01', { token: T_VIEWER });
  const blocked = r.json.entries[fx.O1.line.unitKey]?.blocked;
  ok('the PO date moves later: the next GET reports the placement material_late with the old and new date', blocked?.kind === 'material_late' && blocked.readyDate === D(45) && blocked.was.date === D(30), J(r.json.entries[fx.O1.line.unitKey]));
  examples.plannerEntryBlocked = { request: 'GET /planner?from=2026-10-01', status: 200, response: { [`entries["${fx.O1.line.unitKey}"]`]: r.json.entries[fx.O1.line.unitKey], materialReady: r.json.materialReady } };

  /* ───────────── 7 ───────────── */
  section('7. Tenant isolation');
  for (const [label, method, url, body] of [
    ['GET the requisition', 'GET', `/requisitions/${prId}`],
    ['GET the order\'s requisitions', 'GET', `/orders/${fx.O1.id}/requisitions`],
    ['GET the line\'s requisition', 'GET', `/order-lines/${fx.O1.line.id}/requisition`],
    ['GET the line\'s material-ready', 'GET', `/order-lines/${fx.O1.line.id}/material-ready`],
    ['POST raise', 'POST', `/orders/${fx.O1.id}/requisitions`, {}],
    ['POST stock check', 'POST', `/requisitions/${prId}/stock-check`, { apply: true }],
    ['POST skip', 'POST', `/requisitions/${prId}/skip`, { all: true }],
    ['POST unskip', 'POST', `/requisitions/${prId}/unskip`, { all: true }],
    ['POST release-excess', 'POST', `/requisition-lines/${lineA}/release-excess`, {}],
  ]) {
    const x = await call(method, url, { token: T_B, body });
    ok(`company B · ${label} → 404`, x.status === 404, `${x.status} ${x.text.slice(0, 160)}`);
  }
  r = await call('POST', '/requisitions/purchase-orders', { token: T_B, body: { orders: [{ lines: [{ prLineId: lineB, quantity: 1 }] }] } });
  ok('company B · a purchase order from company A\'s requisition line → 422 "does not exist", nothing written', r.status === 422 && /does not exist/.test(J(r.json.problems)), J(r.json));
  r = await call('PUT', '/planner/entries', { token: T_B, body: { entries: [{ unitKey: fx.O1.line.unitKey, shipDate: PL.periodFloor(D(60)), pinned: true }] } });
  ok('company B · planning company A\'s unit → 422 (not a line there)', r.status === 422, `${r.status}`);
  r = await call('GET', '/buying/board', { token: T_B });
  ok('company B · its Buying board holds none of company A\'s requisitions', r.status === 200 && !J(r.json).includes(tag));
  r = await call('GET', `/requisitions/${prId}`);
  ok('company A\'s requisition is untouched by all that', r.status === 200 && r.json.status === 'mixed');

  /* ───────────── 8 ───────────── */
  section('8. Letting an excess go (dry run)');
  r = await call('POST', `/requisition-lines/${lineA}/release-excess`, { token: T_VIEWER, body: {}, as: 'releaseExcessDryRun' });
  ok('POST release-excess (dry run, view grant) → 200, nothing in excess', r.status === 200 && r.json.applied === false && r.json.excess === 0 && r.json.plan.length === 0, J(r.json));
  r = await call('POST', `/requisition-lines/${lineA}/release-excess`, { token: T_VIEWER, body: { apply: true } });
  ok('…applying it needs the manage grant → 403', r.status === 403);
} catch (err) {
  failed += 1;
  fails.push(`ERROR ${err?.message}`);
  console.error('\nERROR', err);
} finally {
  section('Cleanup');
  MR.setToday(null);
  try { await cleanup(); } catch (e) { failed += 1; fails.push(`CLEANUP ${e.message}`); console.error('cleanup failed', e); }
  await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); setTimeout(resolve, 2000); });
  const after = await counts();
  const drift = after.filter((x) => Number(x.n) !== Number(before.find((b) => b.name === x.name)?.n));
  ok('table counts are back: every cf_ table has the count it started with', drift.length === 0, drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));
  ok('order line 923 is untouched (and not released)', (await kepl()) === keplBefore);
  const [[left]] = await pool.query('SELECT COUNT(*) n FROM cf_master_records WHERE code LIKE ?', [`${tag}%`]);
  ok(`no cf_master_records with the prefix ${tag} remain`, Number(left.n) === 0, String(left.n));
  if (process.env.CF_BUY_HTTP_EXAMPLES) { fs.writeFileSync(process.env.CF_BUY_HTTP_EXAMPLES, JSON.stringify(examples, null, 1)); console.log(`  examples written to ${process.env.CF_BUY_HTTP_EXAMPLES}`); }
  console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
  exitCode = failed ? 1 : 0;
  await pool.end();
  process.exit(exitCode);
}
