/**
 * cleanup-orders.mjs — SOFT-delete a company's practice sales orders and everything raised for them (user,
 * 2026-11-01: "soft delete them … and the relevant purchase orders, PR, MR, WO and everything else associated").
 * One deleted_at stamp for every row, and a manifest { table: [ids] } so --restore puts back exactly those rows.
 * Tables without deleted_at are left (their parents are gone). DRY RUN BY DEFAULT: counts only.
 *   node scripts/cf_kepl/cleanup-orders.mjs --company 30005 --keep 930006,960001 --prod [--apply]
 *   node scripts/cf_kepl/cleanup-orders.mjs --restore <manifest.json> --prod [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const { pool } = await import(pathToFileURL(path.join(__dir, '..', '..', 'db.js')).href);
const CHUNK = 3000;
// Tables keyed by something other than id (the manifest stores that key).
const KEY = { cf_item_details: 'master_id' };
const keyOf = (t) => KEY[t] ?? 'id';
const chunks = (a) => { const out = []; for (let i = 0; i < a.length; i += CHUNK) out.push(a.slice(i, i + CHUNK)); return out; };

async function restore(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`restore ${file} (stamp ${m.stamp}) — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  for (const [t, ids] of Object.entries(m.tables)) {
    let n = 0;
    for (const part of chunks(ids)) {
      if (APPLY) { const [r] = await pool.query(`UPDATE ${t} SET deleted_at = NULL WHERE company_id = ? AND ${keyOf(t)} IN (?) AND deleted_at = ?`, [m.company, part, m.stamp]); n += r.affectedRows; } else n += part.length;
    }
    console.log(`  ${t.padEnd(36)} ${n}`);
  }
}

async function cleanup(company, keep) {
  const q = async (sql, p = []) => (await pool.query(sql, p))[0];
  const ids = async (sql, p = []) => (await q(sql, p)).map((r) => Number(Object.values(r)[0]));
  const has = new Map();
  const cols = await q(`SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'cf\\_%'`);
  for (const r of cols) (has.get(r.t) ?? has.set(r.t, new Set()).get(r.t)).add(r.c);
  const plan = {};   // table → Set(ids)
  const noId = new Set();   // tables keyed without an id column: left, and listed
  const add = (t, list) => { if (!has.get(t)?.has('deleted_at')) return; const s = plan[t] ?? (plan[t] = new Set()); for (const x of list) s.add(Number(x)); };
  /** Live rows of t whose col is in vals. */
  const where = async (t, col, vals) => {
    if (!vals.length || !has.get(t)?.has(col)) return [];
    if (!has.get(t).has(keyOf(t))) { noId.add(t); return []; }
    const out = [];
    for (const part of chunks([...vals])) out.push(...await ids(`SELECT ${keyOf(t)} FROM ${t} WHERE company_id = ? AND deleted_at IS NULL AND ${col} IN (?)`, [company, part]));
    return out;
  };
  const take = async (t, col, vals) => { const r = await where(t, col, vals); add(t, r); return r; };

  const T = await ids('SELECT id FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND id NOT IN (?)', [company, keep]);
  const L = await ids('SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND order_id IN (?)', [company, T.length ? T : [0]]);
  const KL = await ids('SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND order_id IN (?)', [company, keep]);
  add('cf_sales_orders', T);
  await take('cf_sales_order_lines', 'order_id', T);

  // Rows that name the order or its line.
  const byOrder = ['cf_approvals', 'cf_buy_requests', 'cf_cut_allowances', 'cf_invoice_billing_lines', 'cf_invoices', 'cf_line_drawing_imports', 'cf_order_acceptances',
    'cf_order_events', 'cf_order_execution_plans', 'cf_order_pieces', 'cf_order_post_stages', 'cf_order_spec_default_history', 'cf_order_spec_defaults', 'cf_plate_change_requests',
    'cf_po_substitutions', 'cf_production_orders', 'cf_production_releases', 'cf_receipts', 'cf_requisitions', 'cf_stock_losses', 'cf_stock_movements', 'cf_tool_life',
    'cf_work_orders', 'cf_purchase_line_orders'];
  for (const t of byOrder) await take(t, 'order_id', T);
  await take('cf_stock_batches', 'owner_order_id', T);
  await take('cf_stock_reservations', 'held_for_order_id', T);
  const byLine = ['cf_invoice_lines', 'cf_nest_alternatives', 'cf_nest_files', 'cf_nest_runs', 'cf_nest_untracked', 'cf_offcuts', 'cf_part_drawings', 'cf_plan_entries',
    'cf_plan_splits', 'cf_plate_lots', 'cf_stock_reservations', 'cf_time_overrides', 'cf_work_order_cells', 'cf_work_order_scope', 'cf_requisition_lines', 'cf_order_pieces',
    'cf_production_orders', 'cf_production_releases', 'cf_order_execution_plans', 'cf_stock_movements', 'cf_stock_losses', 'cf_tool_life', 'cf_line_drawing_imports'];
  for (const t of byLine) await take(t, 'order_line_id', L);
  await take('cf_operation_flows', 'owner_order_line_id', L);

  // The line's own rows (temporary items), their BOMs and BOM lines.
  const M = await take('cf_item_details', 'owner_order_line_id', L);
  add('cf_master_records', await where('cf_master_records', 'id', M));
  const B = await take('cf_boms', 'parent_id', M);
  const BL = await take('cf_bom_lines', 'bom_id', B);
  await take('cf_material_requirements', 'bom_line_id', BL);

  // Requests (PR), material requisitions (MR) and their lines.
  const PR = [...(plan.cf_buy_requests ?? [])];
  const PRL = await take('cf_buy_request_lines', 'request_id', PR);
  await take('cf_buy_request_quotes', 'request_id', PR);
  const MR = [...(plan.cf_requisitions ?? [])];
  await take('cf_requisition_lines', 'requisition_id', MR);

  // Purchase orders: raised for these orders, carrying their lines, or made from their requests — never one that also serves a kept order.
  const keepPO = new Set([...await where('cf_purchase_orders', 'for_order_id', keep)]);
  if (keep.length) for (const pl of await where('cf_purchase_line_orders', 'order_id', keep)) { const [r] = await q('SELECT purchase_order_id FROM cf_purchase_order_lines WHERE id = (SELECT purchase_line_id FROM cf_purchase_line_orders WHERE id = ?)', [pl]); if (r) keepPO.add(Number(r.purchase_order_id)); }
  const poCand = new Set(await where('cf_purchase_orders', 'for_order_id', T));
  const plo = [...(plan.cf_purchase_line_orders ?? [])];
  if (plo.length) for (const r of await q('SELECT DISTINCT pol.purchase_order_id p FROM cf_purchase_line_orders x JOIN cf_purchase_order_lines pol ON pol.id = x.purchase_line_id WHERE x.company_id = ? AND x.id IN (?)', [company, plo])) poCand.add(Number(r.p));
  if (PRL.length) for (const r of await q('SELECT DISTINCT purchase_order_id p FROM cf_purchase_order_lines WHERE company_id = ? AND request_line_id IN (?)', [company, PRL])) poCand.add(Number(r.p));
  const PO = [...poCand].filter((p) => !keepPO.has(p));
  add('cf_purchase_orders', await where('cf_purchase_orders', 'id', PO));
  const POL = await take('cf_purchase_order_lines', 'purchase_order_id', PO);
  await take('cf_purchase_date_changes', 'purchase_order_id', PO);
  await take('cf_po_substitutions', 'purchase_order_id', PO);
  await take('cf_purchase_line_orders', 'purchase_line_id', POL);
  const RFQ = await take('cf_rfqs', 'purchase_order_id', PO);
  await take('cf_rfq_lines', 'rfq_id', RFQ);
  await take('cf_rfq_lines', 'purchase_line_id', POL);
  const GRN = await take('cf_grn_bills', 'purchase_order_id', PO);
  await take('cf_grn_bill_lines', 'bill_id', GRN);
  await take('cf_stock_movements', 'purchase_line_id', POL);
  await take('cf_stock_movements', 'requisition_id', MR);
  await take('cf_stock_reservations', 'purchase_line_id', POL);
  await take('cf_work_order_payments', 'purchase_order_id', PO);

  // Production and contractor work orders.
  const PRD = [...(plan.cf_production_orders ?? [])];
  const PI = await take('cf_production_items', 'production_order_id', PRD);
  await take('cf_material_requirements', 'production_item_id', PI);
  await take('cf_production_steps', 'production_order_id', PRD);
  const WO = [...(plan.cf_work_orders ?? [])];
  await take('cf_production_steps', 'work_order_id', WO);
  await take('cf_work_order_cells', 'work_order_id', WO);
  await take('cf_work_order_scope', 'work_order_id', WO);
  await take('cf_work_order_payments', 'work_order_id', WO);
  const lots = [...(plan.cf_plate_lots ?? [])];
  await take('cf_nest_placements', 'plate_lot_id', lots);
  await take('cf_offcuts', 'plate_lot_id', lots);

  // Never touch a kept order's lines.
  const unsafe = KL.filter((x) => plan.cf_sales_order_lines?.has(x));
  if (unsafe.length) throw new Error(`refusing: kept lines in the plan ${unsafe.join(',')}`);

  const unlinked = await ids(`SELECT id FROM cf_purchase_orders WHERE company_id = ? AND deleted_at IS NULL AND for_order_id IS NULL AND id NOT IN (?)`, [company, PO.length ? PO : [0]]);
  console.log(`company ${company}: ${T.length} orders (${L.length} lines) go; keep ${keep.join(', ')} — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  const tables = Object.fromEntries(Object.entries(plan).filter(([, s]) => s.size).map(([t, s]) => [t, [...s].sort((a, b) => a - b)]));
  for (const [t, list] of Object.entries(tables).sort()) console.log(`  ${t.padEnd(36)} ${list.length}`);
  console.log(`  (purchase orders with no order at all, left alone: ${unlinked.length})`);
  if (noId.size) console.log(`  (tables with no id column, left: ${[...noId].join(', ')})`);
  if (!APPLY) return;
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const dir = path.join(__dir, '..', '..', '..', 'cleanup'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `orders-${company}-${stamp.replace(/[: ]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ company, keep, stamp, orders: T, tables }));
  console.log(`manifest → ${file}`);
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    for (const [t, list] of Object.entries(tables)) for (const part of chunks(list)) await db.query(`UPDATE ${t} SET deleted_at = ? WHERE company_id = ? AND ${keyOf(t)} IN (?) AND deleted_at IS NULL`, [stamp, company, part]);
    await db.commit();
    console.log(`soft-deleted at ${stamp}`);
  } catch (e) { await db.rollback(); throw e; } finally { db.release(); }
}

try {
  if (arg('restore')) await restore(arg('restore'));
  else {
    const company = Number(arg('company')); const keep = String(arg('keep') ?? '').split(',').map(Number).filter(Boolean);
    if (!company || !keep.length) { console.error('Usage: --company <id> --keep <orderId,...> [--prod] [--apply]'); process.exit(2); }
    await cleanup(company, keep);
  }
} catch (e) { console.error('FAILED (nothing written):', e.message); process.exitCode = 1; } finally { await pool.end(); process.exit(process.exitCode ?? 0); }
