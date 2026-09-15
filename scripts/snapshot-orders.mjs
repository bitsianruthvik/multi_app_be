/**
 * snapshot-orders.mjs — a deterministic, before/after picture of every order
 * in a company, for every EU from here on to diff against.
 *
 * Usage:
 *   node scripts/snapshot-orders.mjs --out <dir> [--company 6] [--order <id>]
 *
 * LOCAL ONLY. The connection comes from `../db.js`, which loads `.env`
 * (localhost:3306 sqldb) — never `.env.tidb`. This file must never be pointed
 * at TiDB; there is no flag that does that, on purpose.
 *
 * ── WHY THIS IMPORTS THE REAL SERVICES ───────────────────────────────────────
 * `weights`, `procurement`, `readiness` and `productionPlan` are computed by
 * calling `itemWeightService.orderTotalWeight`, `procurementService
 * .orderProcurementSplit`/`orderShortfall`, `orderReadinessService
 * .orderReadiness` and `productionPlanService.productionPlan` — the exact
 * functions the routes call — rather than re-deriving them from raw SQL here.
 * A snapshot tool that computed its own version of "the weight" or "the
 * shortfall" would drift from what the app actually reports the moment either
 * one changed, and would then either miss a real regression (both sides wrong
 * the same way) or manufacture a fake one (right here, changed there). Import
 * breakage is the point: if a later EU renames or reshapes one of these
 * functions, this script fails to run rather than silently snapshotting
 * nothing for that section.
 *
 * ── DECIMALS ─────────────────────────────────────────────────────────────────
 * `mysql2` returns DECIMAL/NUMERIC columns as STRINGS (ARCHITECTURE §13,
 * "MySQL returns DECIMAL as a string"). Every value this script reads via a
 * raw query (`items[]`, `lines[]`, `tasks[]`, `nests[]`) is written out
 * exactly as the driver returned it — never `Number()`-coerced — so that a
 * later EU's harmless float-formatting change reads as a real diff and a
 * genuine value change is never hidden by two different strings coercing to
 * the same number. Values that come back from an imported SERVICE are written
 * exactly as that service returned them (some of those services do their own
 * `Number()` internally, e.g. `orderTotalWeight` — that is the service's
 * choice to snapshot, not this script's).
 *
 * ── DETERMINISM ──────────────────────────────────────────────────────────────
 * Every object's keys are sorted alphabetically before being written (a
 * custom `JSON.stringify` replacer, not insertion order) and every array this
 * script builds itself is explicitly sorted per the order given below. Run
 * twice with no writes in between, the output must `diff -r` empty.
 *
 * ── PER-ORDER SHAPE (one file, <out>/order-<id>.json) ────────────────────────
 *   order          id, order_number, order_type, status, wizard_step,
 *                  confirmed_date, required_date
 *   lines[]        id, line_no, code, description, qty, unit, line_type,
 *                  catalog_item_id — sorted by (line_no, id)
 *   items[]        every non-deleted fab_items row — sorted by
 *                  (order_line_id, depth, sort_order, id)
 *   weights        null for a non-sales order; otherwise
 *                  { orderTotal, byLine[] } from itemWeightService +
 *                  a per-line SUM(total_weight) over roots (raw SQL, no
 *                  service exists for the per-line breakdown)
 *   procurement    null for a non-sales order; otherwise
 *                  { split: orderProcurementSplit(), shortfall: orderShortfall() }
 *   readiness      null for a non-sales order; otherwise orderReadiness()
 *   productionPlan null for a non-sales order; otherwise productionPlan()
 *   tasks[]        item_id, flow_step_id, task_code, production_order_id,
 *                  task_qty, computed_hours, setup_hours, status — sorted by
 *                  (item_id, flow_step_id)
 *   nests[]        one entry per (catalog_item_id, nest_no) with non-null
 *                  nest_no — { catalogItemId, nestNo, links[], issues[] },
 *                  links sorted by id, issues by id, entries sorted by
 *                  (catalogItemId, nestNo)
 *
 * `procurement`/`readiness`/`productionPlan` are sales-order concepts —
 * `productionPlan` in particular hard-filters `order_type = 'sales'` and
 * throws "Order not found" for anything else — so they are only computed
 * when `order.order_type === 'sales'`. `items`/`lines`/`tasks`/`nests` are
 * read for every order type (a manufacturing order has items and tasks too,
 * just no lines).
 */

import path from 'path';
import fs from 'fs/promises';
import { pool } from '../db.js';
import { orderTotalWeight } from '../apps/fab_erp/services/itemWeightService.js';
import { orderProcurementSplit, orderShortfall } from '../apps/fab_erp/services/procurementService.js';
import { orderReadiness } from '../apps/fab_erp/services/orderReadinessService.js';
import { productionPlan } from '../apps/fab_erp/services/productionPlanService.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--company') out.company = Number(argv[++i]);
    else if (a === '--order') out.order = Number(argv[++i]);
  }
  if (!out.out) {
    console.error('Usage: node scripts/snapshot-orders.mjs --out <dir> [--company 6] [--order <id>]');
    process.exit(1);
  }
  return out;
}

/** Sort object keys recursively; arrays keep their (already-decided) order. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

function writeJson(filePath, data) {
  return fs.writeFile(filePath, `${JSON.stringify(sortKeysDeep(data), null, 2)}\n`, 'utf8');
}

async function ordersOf(companyId, onlyOrderId) {
  const params = [companyId];
  let sql = 'SELECT id, order_number, order_type, status, wizard_step, confirmed_date, required_date '
    + 'FROM fab_orders WHERE company_id = ? AND deleted_at IS NULL';
  if (onlyOrderId) { sql += ' AND id = ?'; params.push(onlyOrderId); }
  sql += ' ORDER BY id';
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function linesOf(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT id, line_no, code, description, qty, unit, line_type, catalog_item_id
       FROM fab_order_lines
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  rows.sort((a, b) => (a.line_no - b.line_no) || (a.id - b.id));
  return rows;
}

async function itemsOf(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT id, parent_item_id, order_line_id, code, name, node_kind, depth, is_leaf, qty,
            sort_order, nest_no, catalog_item_id, length, width, height, unit_weight,
            computed_unit_weight, total_weight, procurement_type, flow_id
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  rows.sort((a, b) => (
    (orderKeyOf(a.order_line_id) - orderKeyOf(b.order_line_id))
    || (a.depth - b.depth)
    || (orderKeyOf(a.sort_order) - orderKeyOf(b.sort_order))
    || (a.id - b.id)
  ));
  return rows;
}

/** NULLs sort last (and consistently) rather than as 0/NaN. */
function orderKeyOf(v) {
  return v === null || v === undefined ? Number.POSITIVE_INFINITY : Number(v);
}

async function perLineWeights(companyId, orderId, lines) {
  const [rows] = await pool.query(
    `SELECT order_line_id AS orderLineId, SUM(total_weight) AS total
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND parent_item_id IS NULL AND deleted_at IS NULL
        AND order_line_id IS NOT NULL
      GROUP BY order_line_id`,
    [companyId, orderId],
  );
  const byLine = new Map(rows.map((r) => [Number(r.orderLineId), r.total]));
  return lines.map((l) => ({ orderLineId: l.id, total: byLine.get(l.id) ?? null }));
}

async function tasksOf(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT item_id, flow_step_id, task_code, production_order_id, task_qty,
            computed_hours, setup_hours, status
       FROM fab_project_tasks
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  rows.sort((a, b) => (a.item_id - b.item_id) || (a.flow_step_id - b.flow_step_id));
  return rows;
}

async function nestsOf(companyId, orderId) {
  const [links] = await pool.query(
    `SELECT id, parent_item_id, catalog_item_id, nest_no, qty, name, length, width, height
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND node_kind = 'material' AND nest_no IS NOT NULL
        AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  const [issues] = await pool.query(
    `SELECT ni.id, ni.catalog_item_id, ni.nest_no, ni.qty, ni.issued_at
       FROM fab_nest_issues ni
      WHERE ni.company_id = ? AND ni.order_id = ?`,
    [companyId, orderId],
  ).catch(() => [[]]); // table may legitimately be empty/absent of rows for a draft order

  const key = (catalogItemId, nestNo) => `${catalogItemId}::${nestNo}`;
  const groups = new Map();
  for (const l of links) {
    const k = key(l.catalog_item_id, l.nest_no);
    if (!groups.has(k)) {
      groups.set(k, { catalogItemId: l.catalog_item_id, nestNo: l.nest_no, links: [], issues: [] });
    }
    groups.get(k).links.push(l);
  }
  for (const i of issues) {
    const k = key(i.catalog_item_id, i.nest_no);
    if (!groups.has(k)) {
      groups.set(k, { catalogItemId: i.catalog_item_id, nestNo: i.nest_no, links: [], issues: [] });
    }
    groups.get(k).issues.push(i);
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.links.sort((a, b) => a.id - b.id);
    g.issues.sort((a, b) => a.id - b.id);
  }
  out.sort((a, b) => (a.catalogItemId - b.catalogItemId)
    || String(a.nestNo).localeCompare(String(b.nestNo)));
  return out;
}

async function snapshotOrder(companyId, order, outDir) {
  const lines = await linesOf(companyId, order.id);
  const items = await itemsOf(companyId, order.id);
  const tasks = await tasksOf(companyId, order.id);
  const nests = await nestsOf(companyId, order.id);

  let weights = null;
  let procurement = null;
  let readiness = null;
  let production = null;
  if (order.order_type === 'sales') {
    const orderTotal = await orderTotalWeight(companyId, order.id);
    weights = { orderTotal, byLine: await perLineWeights(companyId, order.id, lines) };
    procurement = {
      split: await orderProcurementSplit(companyId, order.id),
      shortfall: await orderShortfall(companyId, order.id),
    };
    readiness = await orderReadiness(companyId, order.id);
    production = await productionPlan(companyId, order.id);
  }

  const payload = {
    order: {
      id: order.id,
      order_number: order.order_number,
      order_type: order.order_type,
      status: order.status,
      wizard_step: order.wizard_step,
      confirmed_date: order.confirmed_date,
      required_date: order.required_date,
    },
    lines,
    items,
    weights,
    procurement,
    readiness,
    productionPlan: production,
    tasks,
    nests,
  };

  await writeJson(path.join(outDir, `order-${order.id}.json`), payload);
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.out, { recursive: true });

  let companyId = args.company;
  if (!companyId && args.order) {
    const [[row]] = await pool.query('SELECT company_id FROM fab_orders WHERE id = ?', [args.order]);
    if (!row) { console.error(`No order ${args.order}`); process.exit(1); }
    companyId = row.company_id;
  }
  if (!companyId) {
    console.error('Pass --company <id> (or --order <id>, and the company will be looked up).');
    process.exit(1);
  }

  const orders = await ordersOf(companyId, args.order);
  console.log(`Snapshotting ${orders.length} order(s) for company ${companyId} -> ${args.out}`);
  for (const order of orders) {
    // eslint-disable-next-line no-await-in-loop
    await snapshotOrder(companyId, order, args.out);
    console.log(`  order-${order.id}.json  (${order.order_number}, ${order.order_type}, ${order.status})`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
