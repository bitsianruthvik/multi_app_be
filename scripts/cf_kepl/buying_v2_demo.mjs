/**
 * buying_v2_demo.mjs — COMMITTED data for a manual browser pass of the Buying v2 screens. Local only.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/buying_v2_demo.mjs up     two confirmed orders on the "House process" (cf_processes 234),
 *                                                  released by hand (buyingFixture.simple), nothing raised yet
 *   node scripts/cf_kepl/buying_v2_demo.mjs down   deletes every row of the company made since `up`, UI actions
 *                                                  included (the id-watermark method of nest_v2_demo.mjs)
 *
 * CF_BUY_COMPANY=2 (pharma_labs). State file TM/_buying_demo_state.json: AUTO_INCREMENT watermarks, start
 * time and every cf_ table's count, so `down` can run in a later process.
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const mode = process.argv[2];
if (!['up', 'down'].includes(mode)) { console.error('usage: node scripts/cf_kepl/buying_v2_demo.mjs up|down'); process.exit(2); }

const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This script is local only.');
const TM = path.resolve(BE, '..');
const STATE = path.join(TM, '_buying_demo_state.json');
const COMPANY = Number(process.env.CF_BUY_COMPANY ?? 2);
const PROCESS_ID = 234;

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => Object.fromEntries((await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0].map((r) => [r.name, Number(r.n)]));

async function tableMeta() {
  const [colRows] = await pool.query("SELECT TABLE_NAME t, COLUMN_NAME c, EXTRA e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%'");
  const meta = new Map(tables.map((t) => [t.name, { name: t.name, auto: null, company: false, created: false }]));
  for (const r of colRows) {
    const m = meta.get(r.t); if (!m) continue;
    if (/auto_increment/i.test(r.e)) m.auto = r.c;
    if (r.c === 'company_id') m.company = true;
    if (r.c === 'created_at') m.created = true;
  }
  return meta;
}

/* ───────────────────────────── up ───────────────────────────── */

async function up() {
  if (fs.existsSync(STATE)) throw new Error(`${STATE} exists: run "down" first.`);
  const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
  await imp('apps/cf_erp/services/codegenProvider.js');
  const FX = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');

  const meta = await tableMeta();
  const before = await counts();
  const maxId = {};
  const autos = [...meta.values()].filter((m) => m.auto);
  const [mx] = await pool.query(autos.map((m) => `SELECT '${m.name}' AS name, COALESCE(MAX(\`${m.auto}\`),0) AS mx FROM \`${m.name}\``).join(' UNION ALL '));
  for (const r of mx) maxId[r.name] = Number(r.mx);
  const [[{ startedAt }]] = await pool.query("SELECT DATE_FORMAT(NOW() - INTERVAL 5 SECOND, '%Y-%m-%d %H:%i:%s') AS startedAt");
  const [[slugRow]] = await pool.query('SELECT slug FROM companies WHERE id = ?', [COMPANY]);
  const [[proc]] = await pool.query('SELECT id FROM cf_processes WHERE id = ? AND company_id = ?', [PROCESS_ID, COMPANY]);
  if (!proc) throw new Error(`process ${PROCESS_ID} (House process) does not exist for company ${COMPANY}`);
  const [[user]] = await pool.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const tag = `BD${Date.now().toString(36).toUpperCase()}`;

  // Written BEFORE the build so a crash half way can still be cleaned up by `down`.
  fs.writeFileSync(STATE, JSON.stringify({ company: COMPANY, startedAt, maxId, before, meta: [...meta.values()], fx: null }, null, 2));

  const conn = await pool.getConnection();
  let out;
  try {
    await conn.beginTransaction();
    attachNodeCache(conn);
    const c = { companyId: COMPANY, userId: user.id };
    const F = await FX.simple(conn, c, tag, { itemKeys: ['M1', 'M2', 'M3'] });
    // Free stock: all of M1 (enough for either order, not for both), part of M2, none of M3.
    const free = { M1: 12, M2: 3, M3: 0 };
    await F.receive(F.items.M1, free.M1);
    await F.receive(F.items.M2, free.M2);
    const A = await F.order('A', [[[F.items.M1, 10], [F.items.M2, 6], [F.items.M3, 4]]]);
    const B = await F.order('B', [[[F.items.M1, 8], [F.items.M3, 5]]], { customer: F.CUS2 });
    for (const o of [A, B]) await conn.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ? AND company_id = ?', [PROCESS_ID, o.id, COMPANY]);
    await conn.commit();
    const base = `http://cf.localhost:5180/${slugRow.slug}/cf_erp`;
    out = {
      orders: [A, B].map((o) => ({ id: o.id, code: o.code, lineId: o.line.id, unitKey: o.line.unitKey, url: `${base}/orders/${o.id}?tab=buying` })),
      items: Object.entries(free).map(([k, freeQty]) => ({ code: `${tag}-${k}`, freeQty, needed: k === 'M1' ? 'A 10, B 8' : k === 'M2' ? 'A 6' : 'A 4, B 5' })),
      supplier: [{ code: `${tag}-S1`, id: F.S1 }, { code: `${tag}-S2`, id: F.S2 }],
      supplierNote: 'a supplier has no lead-time column (only quote lines do): the receiving date is set per PO line in the UI',
      boardUrl: `${base}/purchase`,
      plannerUrl: `${base}/plan`,
      plannerNote: 'units l<lineId> are RELEASED (release row + material requirements by hand); catalog lines, so no freeze; process 234; confirmed',
      stateFile: STATE,
    };
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    state.fx = { tag, orders: out.orders.map((o) => o.id) };
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  } catch (e) { try { await conn.rollback(); } catch { /* original error matters */ } throw e; } finally { detachNodeCache(conn); conn.release(); }
  console.log(JSON.stringify(out, null, 2));
}

/* ───────────────────────────── down ───────────────────────────── */

async function down() {
  if (!fs.existsSync(STATE)) throw new Error(`No state file (${STATE}): nothing to clean up.`);
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const { maxId, startedAt, before } = st;
  const COMP = st.company;

  const removed = {};
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const guard = (m) => (m.created ? ' AND (created_at IS NULL OR created_at >= ?)' : '');
    const args = (m, base) => (m.created ? [...base, startedAt] : base);
    for (const m of st.meta) {
      if (!m.company) continue;
      let n = 0;
      if (m.auto) {
        if (m.created) {
          const [[f]] = await conn.query(`SELECT COUNT(*) n FROM \`${m.name}\` WHERE company_id = ? AND \`${m.auto}\` > ? AND created_at < ?`, [COMP, maxId[m.name], startedAt]);
          if (Number(f.n)) console.log(`  NOTE  ${m.name}: ${f.n} row(s) above the snapshot id were created before the run started — left alone (another process)`);
        }
        const [r] = await conn.query(`DELETE FROM \`${m.name}\` WHERE company_id = ? AND \`${m.auto}\` > ?${guard(m)}`, args(m, [COMP, maxId[m.name]]));
        n = r.affectedRows;
      } else if (m.name === 'cf_item_details') {
        const [r] = await conn.query(`DELETE FROM cf_item_details WHERE company_id = ? AND master_id > ?${guard(m)}`, args(m, [COMP, maxId.cf_master_records]));
        n = r.affectedRows;
      } else if (m.created) {
        const [r] = await conn.query(`DELETE FROM \`${m.name}\` WHERE company_id = ? AND created_at >= ?`, [COMP, startedAt]);
        n = r.affectedRows;
      }
      if (n) removed[m.name] = n;
    }
  } finally {
    try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch { /* released next */ }
    conn.release();
  }

  const after = await counts();
  const drift = Object.keys(before).filter((t) => after[t] !== before[t]).map((t) => `${t} ${before[t]}->${after[t]}`);
  fs.rmSync(STATE, { force: true });
  console.log(JSON.stringify({
    removedPerTable: removed,
    totalRemoved: Object.values(removed).reduce((a, b) => a + b, 0),
    countsBack: drift.length === 0,
    drift,
    stateFileRemoved: !fs.existsSync(STATE),
  }, null, 2));
}

try {
  if (mode === 'up') await up(); else await down();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
