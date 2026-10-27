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
 *   the main path     raise → the MR screen (take from stock) → the PR (vendor columns, quotes) → raise PO →
 *                     MD approval → a PO line's date moved → the reads → the planner (snapshot, a refused save, a save)
 *                     (§71, 2026-10-18: the MR stock check, skip, the boards and release-excess are gone — 404)
 *   permissions       MR / GRN writes need cf_erp_inventory_manage (Stores); the PR's vendors, quotes, raising and changing a PO
 *                     and close short need cf_erp_purchase — Stores is refused them (2026-10-19); approve needs cf_erp_approve_purchase_order
 *                     (§73: the Management inbox; requester ≠ approver); close short is asked, then approved; the planner its own grant
 *   tenant isolation  404 for another company's MR, PR, vendor column, PO, order and line
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
// §73: Management decides — a different person from the one who asked (requester ≠ approver).
const [[userMd]] = await pool.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1 OFFSET 1', [COMPANY]);
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
// Purchase (2026-10-19): the PR's vendors and quotes, raising / changing / closing POs — cf_erp_purchase, not inventory manage.
const T_BUYER = mint(COMPANY, userA?.id, [...SEE, 'cf_erp_purchase']);
const T_BUYER_ONLY = mint(COMPANY, userA?.id, ['cf_erp_purchase']);
const T_NONE = mint(COMPANY, userA?.id, ['cf_erp_orders_view']);
// User 2026-10-27: Sales (orders manage, no inventory grant) raises the sales order's MR — a request to Stores.
const T_SALES = mint(COMPANY, userA?.id, ['cf_erp_orders_view', 'cf_erp_orders_manage']);
const APPROVE_PO = ['cf_erp_approve_purchase_order', 'cf_erp_approve_po_close_short'];
const T_B = mint(COMPANY_B, userB?.id ?? userA?.id, [...SEE, 'cf_erp_inventory_manage', 'cf_erp_purchase', 'cf_erp_production_manage', ...APPROVE_PO]);
// Management (§73): sees purchasing and approves POs and closing them short — through the approvals inbox.
const T_MD = mint(COMPANY, userMd?.id ?? userA?.id, [...SEE, ...APPROVE_PO]);
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
  ok('raising with neither orders manage nor inventory manage (views only) → 403', r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
  r = await call('POST', `/orders/${fx.O1.id}/requisitions`, { token: T_BUYER, body: {} });
  ok('raising as Purchase (cf_erp_purchase + views) → 403', r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
  r = await call('GET', `/orders/${fx.O1.id}/requisitions`, { token: T_SALES });
  ok("Sales (orders view) reads the order's MR stage → 200", r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  r = await call('POST', `/orders/${fx.O1.id}/requisitions`, { body: {}, as: 'raise' });
  ok('POST raise → 200, one requisition, three lines, nothing earmarked', r.status === 200 && r.json.raised === 1 && r.json.requisitions[0].lines.length === 3 && r.json.requisitions[0].status === 'open', J([r.status, r.json?.raised]));
  const prId = r.json.requisitions[0].id;
  const lineA = byItem(r.json.requisitions[0], fx.A).id; const lineB = byItem(r.json.requisitions[0], fx.B).id; const lineC = byItem(r.json.requisitions[0], fx.C).id;
  // Customer acceptance › Material: the per-line supply select — orders manage OR inventory manage, as the order-level one.
  r = await call('PUT', `/order-lines/${fx.O2.line.id}/material-supply`, { token: T_SALES, body: { supply: 'we_buy' } });
  // (The fixture's order is confirmed, so the service then says the supply is fixed — the point is it is no 403.)
  ok("Sales (orders manage alone) passes the line-supply permission: the service answers (fixed once accepted), not 403",
    r.status !== 403 && r.json?.code === 'INVALID' && /cannot be changed/.test(r.json?.message ?? ''), `${r.status} ${r.text.slice(0, 160)}`);
  r = await call('PUT', `/order-lines/${fx.O2.line.id}/material-supply`, { token: T_BUYER, body: { supply: null } });
  ok("a line's material supply as Purchase (neither manage grant) → 403", r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
  r = await call('POST', `/orders/${fx.O2.id}/requisitions`, { token: T_SALES, body: {} });
  ok("Sales (orders manage alone) raises O2's MR → 200", r.status === 200 && r.json.raised === 1, `${r.status} ${r.text.slice(0, 160)}`);
  const pr2 = r.json.requisitions[0].id;
  // MR vs PR (user 2026-10-27): Stores' own "New PR" goes straight to a PR; its MR is not in the MR inbox.
  r = await call('POST', '/stores/purchase-requests', { token: T_SALES, body: { forType: 'stock', lines: [{ itemId: fx.C, qty: 1 }] } });
  ok('New PR as Sales (no Stores grant) → 403', r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
  r = await call('POST', '/stores/purchase-requests', { body: { forType: 'stock', note: `${tag} New PR`, lines: [{ itemId: fx.C, qty: 4 }] }, as: 'newPr' });
  ok('New PR as Stores → 200: the PR made at once, the MR underneath internal', r.status === 200 && /^PR-/.test(r.json?.purchaseRequest?.code ?? '') && r.json?.materialRequest?.internal === true, `${r.status} ${r.text.slice(0, 200)}`);
  const newPrMr = r.json?.requisition?.id;
  r = await call('GET', `/material-requests?search=${encodeURIComponent(tag)}`);
  ok('…the MR inbox does not list its MR', r.status === 200 && !r.json.rows.some((x) => x.id === newPrMr), J(r.json?.rows?.map((x) => x.code)));
  r = await call('POST', `/orders/${fx.O1.id}/requisitions`, { body: {} });
  ok('raising again only refreshes (raised 0, refreshed 1)', r.status === 200 && r.json.raised === 0 && r.json.refreshed === 1);

  /* ───────────── 2 ───────────── */
  section('2. The MR screen (Purchase): take from stock');
  r = await call('GET', `/material-requests/${prId}`, { token: T_VIEWER, as: 'mrScreen' });
  const sl = (scr, itemId) => scr.lines.find((l) => l.item.id === itemId);
  ok('GET the MR screen with the view grant: A required 10, 10 free in stock, to buy 10', r.status === 200 && sl(r.json, fx.A).required === 10 && sl(r.json, fx.A).inStock === 10 && sl(r.json, fx.A).toBuy === 10 && r.json.purchaseRequest === null, J(r.json?.lines));
  r = await call('PUT', `/material-requests/${prId}`, { token: T_VIEWER, body: { lines: [{ lineId: lineA, takeFromStock: 10 }] } });
  ok('saving it without the manage grant → 403', r.status === 403);
  r = await call('PUT', `/material-requests/${prId}`, { body: { lines: [{ lineId: lineA, takeFromStock: 99 }] }, as: 'mrSaveRefused' });
  ok('taking more than the line needs → 422, naming the item', r.status === 422 && r.json.problems[0].includes(`${tag}-A`), J(r.json));
  r = await call('PUT', `/material-requests/${prId}`, { body: { lines: [{ lineId: lineA, takeFromStock: 10 }, { lineId: lineB, takeFromStock: 0 }, { lineId: lineC, takeFromStock: 0 }] }, as: 'mrSave' });
  ok('save → 200: A taken from stock (locked 10), B and C to buy, ONE PR made', r.status === 200 && sl(r.json, fx.A).locked === 10 && sl(r.json, fx.B).toBuy === 4 && sl(r.json, fx.C).toBuy === 2 && !!r.json.purchaseRequest?.id, J(r.json));
  const prqId = r.json.purchaseRequest.id;
  r = await call('GET', `/material-requests/${pr2}`, { token: T_VIEWER });
  ok('EARMARK INVISIBILITY over HTTP: the other order\'s MR screen sees 0 in stock', r.status === 200 && r.json.lines[0].inStock === 0, J(r.json?.lines));

  /* ───────────── 3 ───────────── */
  section('3. The PR: vendor columns and quotes');
  r = await call('GET', `/purchase-requests/${prqId}`, { token: T_VIEWER, as: 'purchaseRequest' });
  const gl = (p, itemId) => p.lines.find((l) => l.item.id === itemId);
  ok('GET the PR: B 4 and C 2 to buy, nothing raised, open', r.status === 200 && gl(r.json, fx.B).needed === 4 && gl(r.json, fx.C).needed === 2 && r.json.status === 'open' && r.json.vendors.length === 0, J(r.json));
  const plB = gl(r.json, fx.B).id;
  r = await call('POST', `/purchase-requests/${prqId}/vendors`, { token: T_VIEWER, body: { supplierId: fx.S1 } });
  ok('adding a vendor without the manage grant → 403', r.status === 403);
  r = await call('POST', `/purchase-requests/${prqId}/vendors`, { body: { supplierId: fx.S1 } });
  ok('Stores (inventory manage, no cf_erp_purchase) adding a vendor → 403 naming cf_erp_purchase', r.status === 403 && /cf_erp_purchase/.test(r.json?.message ?? ''), `${r.status} ${r.text.slice(0, 120)}`);
  await call('POST', `/purchase-requests/${prqId}/vendors`, { token: T_BUYER, body: { supplierId: fx.S1 } });
  r = await call('POST', `/purchase-requests/${prqId}/vendors`, { token: T_BUYER, body: { supplierId: fx.S2 }, as: 'addVendor' });
  ok('two vendor columns', r.status === 200 && r.json.vendors.length === 2, J(r.json?.vendors));
  const v1 = r.json.vendors.find((v) => v.supplier.id === fx.S1).id; const v2 = r.json.vendors.find((v) => v.supplier.id === fx.S2).id;
  r = await call('PUT', `/purchase-request-vendors/${v1}/quotes`, { body: { quotes: [{ lineId: plB, rate: 99 }] } });
  ok('Stores typing a quote → 403', r.status === 403);
  r = await call('PUT', `/purchase-request-vendors/${v1}/quotes`, { token: T_BUYER_ONLY, body: { quotes: [{ lineId: plB, rate: 100, deliveryDays: 9 }] }, as: 'quotes' });
  ok('vendor 1 quotes B: ₹100, 9 days — typed by a user holding ONLY cf_erp_purchase', r.status === 200 && r.json.vendors.find((v) => v.id === v1).quotes[plB].rate === 100, J(r.json?.vendors));
  r = await call('PUT', `/purchase-request-vendors/${v2}/quotes`, { token: T_BUYER, body: { quotes: [{ lineId: plB, rate: 110, deliveryDays: 23, remark: 'ex-works' }] } });
  ok('vendor 2 quotes B: ₹110, 23 days, a remark', r.status === 200 && r.json.vendors.find((v) => v.id === v2).quotes[plB].remark === 'ex-works');

  /* ───────────── 4 ───────────── */
  section('4. Raise PO per vendor column, then MD approval');
  r = await call('POST', `/purchase-request-vendors/${v1}/purchase-orders`, { token: T_VIEWER, body: { lines: [{ lineId: plB, quantity: 3 }] } });
  ok('raising a PO without the manage grant → 403', r.status === 403);
  r = await call('POST', `/purchase-request-vendors/${v1}/purchase-orders`, { body: { lines: [{ lineId: plB, quantity: 3 }] } });
  ok('Stores raising a PO → 403', r.status === 403);
  r = await call('POST', `/purchase-request-vendors/${v1}/purchase-orders`, { token: T_BUYER, body: { lines: [{ lineId: plB, quantity: 99 }, { lineId: gl((await call('GET', `/purchase-requests/${prqId}`)).json, fx.C).id, quantity: 1 }] }, as: 'raisePoRefused' });
  ok('every problem at once (too much, a line the vendor did not quote) → 422', r.status === 422 && r.json.problems.length === 2, J(r.json));
  r = await call('POST', `/purchase-request-vendors/${v1}/purchase-orders`, { token: T_BUYER, body: { lines: [{ lineId: plB, quantity: 3 }] }, as: 'raisePo' });
  ok('vendor 1: a PO for 3 of B at ₹100, due today + 9 days, PENDING MD APPROVAL', r.status === 200 && r.json.purchaseOrder.stage === 'pending_approval' && r.json.purchaseOrder.lines[0].quantity === 3
    && r.json.purchaseOrder.lines[0].unitPrice === 100 && String(r.json.purchaseOrder.lines[0].expectedDate).slice(0, 10) === D(9), J(r.json?.purchaseOrder));
  const po1 = r.json.purchaseOrder.id;
  r = await call('POST', `/purchase-request-vendors/${v2}/purchase-orders`, { token: T_BUYER, body: { lines: [{ lineId: plB, quantity: 1 }] } });
  const po2 = r.json.purchaseOrder.id;
  const poLine2 = r.json.purchaseOrder.lines[0].id;
  ok('vendor 2: the last 1 of B → the PR line is fully ordered', r.status === 200 && gl(r.json.purchaseRequest, fx.B).poRaised === 4 && gl(r.json.purchaseRequest, fx.B).open === 0, J(r.json?.purchaseRequest?.lines));
  r = await call('POST', `/purchase-lines/${poLine2}/receive`, { body: { quantity: 1, stockingAreaId: fx.store } });
  ok('a GRN while it waits for the MD → 422', r.status === 422 && /waiting for Management approval/.test(r.json.message), J(r.json));
  r = await call('POST', `/purchase-orders/${po1}/approve`, { body: {} });
  ok('approving without an approval tag (cf_erp_approve_purchase_order) → 403', r.status === 403);
  r = await call('POST', `/purchase-orders/${po1}/approve`, { token: T_MD, body: {}, as: 'approve' });
  ok('the MD approves → 200, waiting for goods', r.status === 200 && r.json.stage === 'waiting' && r.json.status === 'ordered' && r.json.approval.status === 'approved', J(r.json?.stage));
  r = await call('POST', `/purchase-orders/${po2}/approve`, { token: T_MD, body: {} });
  r = await call('GET', `/requisitions/${prId}`, { token: T_VIEWER });
  ok('…the MR line B is covered, last delivery on the later PO', byItem(r.json, fx.B).status === 'covered' && byItem(r.json, fx.B).cover.lastDate === D(23), J(byItem(r.json, fx.B)?.cover));
  r = await call('PUT', `/purchase-lines/${poLine2}`, { body: { expectedDate: D(30) } });
  ok('Stores moving a line date on a supplier PO → 403 naming cf_erp_purchase', r.status === 403 && /cf_erp_purchase/.test(r.json?.message ?? ''), `${r.status} ${r.text.slice(0, 160)}`);
  r = await call('GET', `/purchase-orders/${po2}`, { token: T_BUYER_ONLY });
  ok('a user holding ONLY cf_erp_purchase reads the PO → 200', r.status === 200 && r.json.id === po2, `${r.status}`);
  r = await call('PUT', `/purchase-lines/${poLine2}`, { token: T_BUYER, body: { expectedDate: D(30) }, as: 'purchaseLineDate' });
  ok('PUT a PO line\'s date (the existing route) → 200', r.status === 200 && r.json.lines[0].orders[0].prLineId === lineB, J(r.json?.lines?.[0]?.orders));

  /* ───────────── 5 ───────────── */
  section('5. The reads');
  r = await call('GET', `/requisitions/${prId}`, { token: T_VIEWER, as: 'requisition' });
  ok('GET /requisitions/:id → A from stock, B on order, C open — waiting', r.status === 200 && r.json.status === 'partly_covered' && r.json.materialReady.state === 'waiting'
    && byItem(r.json, fx.B).cover.lastDate === D(30) && byItem(r.json, fx.C).status === 'open', J([r.json?.status, r.json?.materialReady]));
  r = await call('GET', `/order-lines/${fx.O1.line.id}/requisition`, { token: T_VIEWER });
  ok('GET /order-lines/:id/requisition → the same requisition', r.status === 200 && r.json.requisition.id === prId);
  r = await call('GET', `/order-lines/${fx.O1.line.id}/material-ready`, { token: T_VIEWER, as: 'materialReady' });
  ok('GET /order-lines/:id/material-ready → waiting, three materials each with its cover', r.status === 200 && r.json.state === 'waiting' && r.json.materials.length === 3 && r.json.requisition.id === prId, J(r.json?.state));
  r = await call('GET', `/orders/${fx.O1.id}/requisitions`, { token: T_VIEWER, as: 'orderRequisitions' });
  ok('GET /orders/:id/requisitions → one requisition, no line left without', r.status === 200 && r.json.requisitions.length === 1 && r.json.linesWithout.length === 0);
  r = await call('GET', `/material-requests?search=${tag}`, { token: T_VIEWER, as: 'materialRequests' });
  ok('GET /material-requests → both MRs, the first with its PR', r.status === 200 && r.json.rows.length === 2 && r.json.rows.find((x) => x.id === prId)?.purchaseRequest?.id === prqId, J(r.json?.rows));
  r = await call('GET', `/purchase-requests?status=all&search=${tag}`, { token: T_VIEWER, as: 'purchaseRequests' });
  ok('GET /purchase-requests → the PR, partly ordered (C still to order)', r.status === 200 && r.json.rows.length === 1 && r.json.rows[0].status === 'partly_ordered', J(r.json));
  r = await call('GET', `/purchase-orders?stage=waiting&search=${tag}&paged=1`, { token: T_VIEWER });
  ok('GET /purchase-orders?stage=waiting → both POs, type Material', r.status === 200 && r.json.rows.length === 2 && r.json.rows.every((p) => p.type === 'material' && p.stage === 'waiting'), J(r.json?.rows?.map((p) => p.stage)));
  r = await call('GET', `/purchase-orders/pending-lines?search=${tag}`, { token: T_VIEWER, as: 'pendingLines' });
  ok('GET /purchase-orders/pending-lines (Receive against PO) → their two lines', r.status === 200 && r.json.rows.filter((x) => [po1, po2].includes(x.purchaseOrder.id)).length === 2, J(r.json?.rows));
  for (const [method, url] of [['GET', `/buying/board?orderId=${fx.O1.id}`], ['GET', '/purchase/board'], ['GET', `/orders/${fx.O1.id}/purchase`], ['GET', '/buy-list'],
    ['POST', `/requisitions/${prId}/stock-check`], ['POST', `/requisitions/${prId}/skip`], ['POST', `/requisition-lines/${lineA}/release-excess`], ['POST', '/requisitions/purchase-orders'],
    ['GET', '/rfqs/1'], ['POST', `/orders/${fx.O1.id}/purchase-request`]]) {
    const x = await call(method, url, { token: T_MANAGER, body: method === 'POST' ? {} : undefined });
    ok(`§71: ${method} ${url.replace(/\d+/g, ':id')} is gone → 404`, x.status === 404, `${x.status} ${x.text.slice(0, 120)}`);
  }
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
  // The open material (C) arrives: plannable from the week the PO material allows.
  {
    const conn = await pool.getConnection();
    try { await conn.beginTransaction(); attachNodeCache(conn); await FX.receiveInto(conn, { companyId: COMPANY, userId: userA.id }, fx.store, fx.C, 2); await conn.commit(); } catch (e) { try { await conn.rollback(); } catch { /* */ } throw e; } finally { detachNodeCache(conn); conn.release(); }
  }
  r = await call('GET', '/planner?from=2026-10-01', { token: T_VIEWER });
  const unit2 = r.json.units.find((u) => u.key === fx.O1.line.unitKey);
  ok(`stock for the open material is received: the very next GET says dated ${D(30)}`, unit2.material.state === 'dated' && unit2.material.readyDate === D(30) && unit2.material.earliest === PL.periodFloor(D(30)), J(unit2.material));
  r = await call('PUT', '/planner/entries', { body: { entries: [{ unitKey: fx.O1.line.unitKey, shipDate: PL.periodFloor(D(9)), pinned: true }] } });
  ok('too early → 422, with the earliest week', r.status === 422 && r.json.detail.units[0].kind === 'material_late' && r.json.detail.units[0].earliest === PL.periodFloor(D(30)), J(r.json?.detail));
  r = await call('PUT', '/planner/entries', { token: T_VIEWER, body: { entries: [{ unitKey: fx.O1.line.unitKey, shipDate: PL.periodFloor(D(30)), pinned: true }] } });
  ok('planning without cf_erp_production_manage → 403', r.status === 403);
  r = await call('PUT', '/planner/entries', { body: { entries: [{ unitKey: fx.O1.line.unitKey, shipDate: PL.periodFloor(D(30)), pinned: true }] }, as: 'plannerSave' });
  ok('in its week → 200', r.status === 200 && r.json.entries[fx.O1.line.unitKey].shipDate === PL.periodFloor(D(30)), J(r.json));
  r = await call('PUT', `/purchase-lines/${poLine2}`, { token: T_BUYER, body: { expectedDate: D(45) }, as: 'purchaseLineDateMoved' });
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
    ['GET the MR screen', 'GET', `/material-requests/${prId}`],
    ['PUT the MR', 'PUT', `/material-requests/${prId}`, { lines: [{ lineId: lineA, takeFromStock: 0 }] }],
    ['GET the PR', 'GET', `/purchase-requests/${prqId}`],
    ['POST a vendor column', 'POST', `/purchase-requests/${prqId}/vendors`, { supplierId: fx.S1 }],
    ['PUT quotes', 'PUT', `/purchase-request-vendors/${v1}/quotes`, { quotes: [{ lineId: plB, rate: 1 }] }],
    ['POST raise PO', 'POST', `/purchase-request-vendors/${v1}/purchase-orders`, { lines: [{ lineId: plB, quantity: 1 }] }],
    ['POST approve', 'POST', `/purchase-orders/${po1}/approve`, {}],
    ['POST close short', 'POST', `/purchase-orders/${po1}/close`, { reason: 'x' }],
  ]) {
    const x = await call(method, url, { token: T_B, body });
    ok(`company B · ${label} → 404`, x.status === 404, `${x.status} ${x.text.slice(0, 160)}`);
  }
  r = await call('PUT', '/planner/entries', { token: T_B, body: { entries: [{ unitKey: fx.O1.line.unitKey, shipDate: PL.periodFloor(D(60)), pinned: true }] } });
  ok('company B · planning company A\'s unit → 422 (not a line there)', r.status === 422, `${r.status}`);
  r = await call('GET', '/purchase-requests?status=all', { token: T_B });
  ok('company B · its PR list holds none of company A\'s', r.status === 200 && !J(r.json).includes(tag));
  r = await call('GET', `/requisitions/${prId}`);
  ok('company A\'s requisition is untouched by all that', r.status === 200 && r.json.status === 'partly_covered');

  /* ───────────── 8 ───────────── */
  section('8. Close short');
  r = await call('POST', `/purchase-orders/${po1}/close`, { token: T_VIEWER, body: { reason: 'mill short' } });
  ok('closing without the manage grant → 403', r.status === 403);
  r = await call('POST', `/purchase-orders/${po1}/close`, { body: { reason: 'mill short' } });
  ok('Stores asking to close a supplier PO short → 403', r.status === 403);
  r = await call('POST', `/purchase-orders/${po1}/close`, { token: T_BUYER, body: { reason: 'mill short' }, as: 'closeShort' });
  ok('asking to close short → 200: nothing changes yet, it waits for Management (§73)', r.status === 200 && r.json.stage !== 'closed_short' && r.json.pendingApprovals.some((a) => a.type === 'po_close_short'), J(r.json?.pendingApprovals));
  r = await call('GET', '/approvals?type=po_close_short', { token: T_MD });
  const ask = r.json.rows.find((a) => a.subject.id === po1);
  ok('Management sees it in the inbox, with the reason', r.status === 200 && ask?.context?.reason === 'mill short', J(r.json?.rows?.map((a) => a.subject)));
  r = await call('POST', `/approvals/${ask.id}/decide`, { token: T_MD, body: { decision: 'approve' }, as: 'approveCloseShort' });
  ok('approved → closed short, nothing pending, 3 released', r.status === 200 && r.json.result.stage === 'closed_short' && r.json.result.lines[0].pending === 0 && r.json.result.lines[0].closedQty === 3, J(r.json?.result?.lines));
  r = await call('GET', `/purchase-requests/${prqId}`, { token: T_VIEWER });
  ok('…the PR line\'s "PO raised" went down by 3 (4 → 1)', r.status === 200 && gl(r.json, fx.B).poRaised === 1 && gl(r.json, fx.B).open === 3, J(gl(r.json, fx.B)));
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
