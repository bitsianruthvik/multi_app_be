// Demo seed for the Project Progress view (2026-07-24). Idempotent.
//  1. Clones the Girder order (SO-20260722-0001) into a new sales order
//     SO-DEMO-PROGRESS-01 (line + fab_items tree + flow), materializes its DAG
//     (which auto-advances it to 'scheduled'), then marks part of it done so it
//     shows partial per-stage progress and an 'in_production' status.
//  2. Creates a 'Structural Fabrication' progress template (Cutting / Welding /
//     Assembly & QC → OP-CUT / OP-WELD / OP-ASM), matched to the girder category.
//  3. Assigns the template to BOTH the new order and the original order 79.
// Run: node apps/fab_erp/models/seed_progress_demo.mjs
import mysql from 'mysql2/promise';
import { materializeTasks } from '../services/taskInstanceService.js';
import { rollUpOrderStatus } from '../services/taskEngineService.js';
import { pool } from '../../../db.js';

const CO = 6, SRC_ORDER = 79, GIRDER_CAT = 78, GIRDER_CATEGORY = 72;
const OP_CUT = 6, OP_WELD = 7, OP_ASM = 8;
const DEMO_NO = 'SO-DEMO-PROGRESS-01';
const c = await mysql.createConnection({ host: 'localhost', port: 3306, user: 'root', password: '1234', database: 'sqldb' });
const q = async (s, p) => { const [r] = await c.query(s, p); return r; };

try {
  // ---- 1. Clone the order (skip if already seeded) ----
  let [[demo]] = await c.query('SELECT id FROM fab_orders WHERE company_id=? AND order_number=? AND deleted_at IS NULL', [CO, DEMO_NO]);
  let newOrderId;
  if (demo) {
    newOrderId = demo.id;
    console.log('demo order already exists:', newOrderId, '(reusing)');
  } else {
    const [[src]] = await c.query('SELECT order_type, type, customer_id, customer_name, plant_id FROM fab_orders WHERE id=?', [SRC_ORDER]);
    const [ins] = await c.query(
      `INSERT INTO fab_orders (company_id, order_number, order_type, type, status, customer_id, customer_name, plant_id)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [CO, DEMO_NO, src.order_type, src.type, src.customer_id, src.customer_name, src.plant_id]);
    newOrderId = ins.insertId;

    // line items
    const lines = await q('SELECT line_no, catalog_item_id, qty, unit FROM fab_order_lines WHERE order_id=? AND deleted_at IS NULL', [SRC_ORDER]);
    for (const l of lines) {
      await c.query('INSERT INTO fab_order_lines (company_id, order_id, line_no, catalog_item_id, qty, unit) VALUES (?,?,?,?,?,?)',
        [CO, newOrderId, l.line_no, l.catalog_item_id, l.qty, l.unit]);
    }

    // fab_items tree (remap parent ids old→new)
    const items = await q('SELECT id, parent_item_id, catalog_item_id, name, unit, qty, flow_id FROM fab_items WHERE order_id=? AND deleted_at IS NULL ORDER BY (parent_item_id IS NOT NULL), id', [SRC_ORDER]);
    const idMap = new Map();
    for (const it of items) {
      const newParent = it.parent_item_id != null ? idMap.get(it.parent_item_id) ?? null : null;
      const [r] = await c.query(
        `INSERT INTO fab_items (company_id, order_id, parent_item_id, catalog_item_id, name, unit, qty, flow_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [CO, newOrderId, newParent, it.catalog_item_id, it.name, it.unit, it.qty, it.flow_id]);
      idMap.set(it.id, r.insertId);
    }
    console.log('cloned order', newOrderId, 'with', items.length, 'BOM nodes');
  }

  // materialize (idempotent per step; also auto-sets 'scheduled' via lifecycle hook)
  await c.end(); // close plain conn; materializeTasks uses the pool
  const matResult = await materializeTasks(CO, newOrderId);
  await pool.query('SELECT 1'); // ensure pool alive
  console.log('materialized:', JSON.stringify(matResult));

  // reopen a plain conn for the rest
  const c2 = await mysql.createConnection({ host: 'localhost', port: 3306, user: 'root', password: '1234', database: 'sqldb' });
  const q2 = async (s, p) => { const [r] = await c2.query(s, p); return r; };

  // ---- mark partial progress (Cut done, Weld in_progress) for a lively demo ----
  const tasks = await q2("SELECT id, seq_no FROM fab_project_tasks WHERE company_id=? AND order_id=? AND deleted_at IS NULL ORDER BY seq_no", [CO, newOrderId]);
  if (tasks.length >= 2) {
    const [t1, t2] = tasks;
    await c2.query("UPDATE fab_project_tasks SET status='done', started_at=NOW(), completed_at=NOW() WHERE id=? AND status NOT IN ('done')", [t1.id]);
    await c2.query("UPDATE fab_project_tasks SET status='in_progress', started_at=NOW() WHERE id=? AND status NOT IN ('done','in_progress')", [t2.id]);
  }
  await rollUpOrderStatus(pool, CO, newOrderId);

  // ---- 2. Progress template ----
  let [[tpl]] = await c2.query("SELECT id FROM fab_progress_templates WHERE company_id=? AND code='STRUCT-FAB' AND deleted_at IS NULL", [CO]);
  let templateId;
  if (tpl) { templateId = tpl.id; console.log('template exists:', templateId, '(reusing)'); }
  else {
    const [r] = await c2.query(
      "INSERT INTO fab_progress_templates (company_id, name, code, match_item_category_id, active) VALUES (?, 'Structural Fabrication', 'STRUCT-FAB', ?, 1)",
      [CO, GIRDER_CATEGORY]);
    templateId = r.insertId;
    const stages = [['Cutting', 10, OP_CUT], ['Welding', 20, OP_WELD], ['Assembly & QC', 30, OP_ASM]];
    for (const [name, seq, opId] of stages) {
      const [sr] = await c2.query('INSERT INTO fab_progress_stages (company_id, template_id, name, seq_no) VALUES (?,?,?,?)', [CO, templateId, name, seq]);
      await c2.query('INSERT INTO fab_progress_stage_ops (company_id, stage_id, operation_id) VALUES (?,?,?)', [CO, sr.insertId, opId]);
    }
    console.log('created template', templateId, 'with 3 stages');
  }

  // ---- 3. Assign template to both orders ----
  await c2.query('UPDATE fab_orders SET progress_template_id=? WHERE company_id=? AND id IN (?, ?)', [templateId, CO, newOrderId, SRC_ORDER]);
  console.log('assigned template', templateId, 'to orders', newOrderId, '+', SRC_ORDER);

  const [[chk]] = await c2.query('SELECT status, progress_pct FROM fab_orders WHERE id=?', [newOrderId]);
  console.log('demo order now:', JSON.stringify(chk));

  await c2.end();
  await pool.end();
  console.log('\nSEED OK — orders:', newOrderId, '(demo) +', SRC_ORDER, '(original), template:', templateId);
  process.exit(0);
} catch (e) {
  console.error('SEED ERROR:', e.stack || e.message);
  try { await c.end(); } catch {}
  try { await pool.end(); } catch {}
  process.exit(1);
}
