/**
 * progressReportService.js
 * ------------------------
 * Project Progress view (2026-07-24). Rolls task progress up by reporting
 * *stage* (a named group of operations) instead of per machine, at three zoom
 * levels: portfolio (all active projects), project, and any BOM subtree.
 *
 *   portfolioProgress(companyId)            — active orders + overall % + template
 *   computeStageBreakdown(companyId, orderId, {itemId, scope})
 *                                           — per-stage done/total for a scope
 *
 * Template resolution per order: fab_orders.progress_template_id override first,
 * else the active fab_progress_templates row whose match_item_category_id matches
 * the order's top-level finished-good category. Tasks whose operation isn't in
 * any stage fall into a synthetic "Other" bucket so progress is never dropped.
 */

import { pool } from '../../../db.js';

const OTHER_STAGE = { stageId: 'other', name: 'Other / unmapped', seqNo: 9999 };

/** Resolve an order's progress template (override → category match) + its stages. */
export async function resolveTemplateForOrder(exec, companyId, orderId) {
  const [[order]] = await exec.query(
    `SELECT progress_template_id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [orderId, companyId],
  );
  if (!order) return null;

  let templateId = order.progress_template_id ?? null;

  // Confirm the override template is still active; if not, fall through to match.
  if (templateId != null) {
    const [[t]] = await exec.query(
      `SELECT id FROM fab_progress_templates WHERE id = ? AND company_id = ? AND active = 1 AND deleted_at IS NULL LIMIT 1`,
      [templateId, companyId],
    );
    if (!t) templateId = null;
  }

  // Match by the order's top-level finished-good category.
  if (templateId == null) {
    const [[fg]] = await exec.query(
      `SELECT ic.category_id
         FROM fab_items fi
         JOIN fab_item_catalog ic ON ic.id = fi.catalog_item_id AND ic.company_id = fi.company_id AND ic.deleted_at IS NULL
        WHERE fi.company_id = ? AND fi.order_id = ? AND fi.parent_item_id IS NULL AND fi.deleted_at IS NULL
        LIMIT 1`,
      [companyId, orderId],
    );
    if (fg?.category_id != null) {
      const [[t]] = await exec.query(
        `SELECT id FROM fab_progress_templates
          WHERE company_id = ? AND active = 1 AND deleted_at IS NULL AND match_item_category_id = ?
          ORDER BY id LIMIT 1`,
        [companyId, fg.category_id],
      );
      if (t) templateId = t.id;
    }
  }

  if (templateId == null) return null;

  const [[tpl]] = await exec.query(
    `SELECT id, name FROM fab_progress_templates WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [templateId, companyId],
  );
  if (!tpl) return null;

  const [stages] = await exec.query(
    `SELECT id, name, seq_no AS seqNo FROM fab_progress_stages
      WHERE company_id = ? AND template_id = ? AND deleted_at IS NULL ORDER BY seq_no, id`,
    [companyId, templateId],
  );
  const stageIds = stages.map((s) => s.id);
  let stageOps = [];
  if (stageIds.length) {
    [stageOps] = await exec.query(
      `SELECT stage_id AS stageId, operation_id AS operationId FROM fab_progress_stage_ops
        WHERE company_id = ? AND stage_id IN (?) AND deleted_at IS NULL`,
      [companyId, stageIds],
    );
  }
  const opToStage = new Map();
  for (const so of stageOps) opToStage.set(so.operationId, so.stageId);

  return { templateId: tpl.id, templateName: tpl.name, stages, opToStage };
}

/**
 * Per-stage progress for one order, optionally scoped to a BOM item subtree.
 * @param {object} [opts] { itemId?: number, scope?: 'self'|'subtree' }
 */
export async function computeStageBreakdown(companyId, orderId, opts = {}, exec = pool) {
  const tpl = await resolveTemplateForOrder(exec, companyId, orderId);

  // Resolve the item-subtree scope (same recursive CTE as /tasks/graph).
  let itemScopeIds = null;
  if (opts.itemId != null && Number.isInteger(Number(opts.itemId)) && Number(opts.itemId) > 0) {
    const iid = Number(opts.itemId);
    if (opts.scope === 'self') {
      itemScopeIds = [iid];
    } else {
      const [treeRows] = await exec.query(
        `WITH RECURSIVE item_tree AS (
           SELECT id, parent_item_id, 0 AS depth
             FROM fab_items WHERE id = ? AND company_id = ? AND order_id = ? AND deleted_at IS NULL
           UNION ALL
           SELECT fi.id, fi.parent_item_id, item_tree.depth + 1
             FROM fab_items fi JOIN item_tree ON fi.parent_item_id = item_tree.id
            WHERE item_tree.depth < 12 AND fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
         )
         SELECT id FROM item_tree`,
        [iid, companyId, orderId, companyId, orderId],
      );
      itemScopeIds = treeRows.map((r) => r.id);
    }
  }
  if (itemScopeIds !== null && itemScopeIds.length === 0) {
    return { ok: true, orderId, templateId: tpl?.templateId ?? null, templateName: tpl?.templateName ?? null, stages: [] };
  }

  let sql = `SELECT operation_id AS operationId, status FROM fab_project_tasks
              WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND status <> 'cancelled'`;
  const params = [companyId, orderId];
  if (itemScopeIds !== null) { sql += ` AND item_id IN (?)`; params.push(itemScopeIds); }
  const [tasks] = await exec.query(sql, params);

  // Bucket tasks by stage (or Other).
  const opToStage = tpl?.opToStage ?? new Map();
  const acc = new Map(); // stageId → {total, done}
  const bump = (key, isDone) => {
    const a = acc.get(key) || { total: 0, done: 0 };
    a.total += 1; if (isDone) a.done += 1;
    acc.set(key, a);
  };
  for (const t of tasks) {
    const stageId = opToStage.has(t.operationId) ? opToStage.get(t.operationId) : 'other';
    bump(stageId, t.status === 'done');
  }

  // Emit template stages in order, then Other if it has any tasks.
  const out = [];
  const orderedStages = tpl?.stages ?? [];
  for (const s of orderedStages) {
    const a = acc.get(s.id) || { total: 0, done: 0 };
    out.push({ stageId: s.id, name: s.name, seqNo: s.seqNo, total: a.total, done: a.done, pct: a.total ? Math.round((a.done / a.total) * 100) : 0 });
  }
  const other = acc.get('other');
  if (other && other.total > 0) {
    out.push({ stageId: OTHER_STAGE.stageId, name: OTHER_STAGE.name, seqNo: OTHER_STAGE.seqNo, total: other.total, done: other.done, pct: Math.round((other.done / other.total) * 100) });
  }

  return { ok: true, orderId, templateId: tpl?.templateId ?? null, templateName: tpl?.templateName ?? null, stages: out };
}

/** Portfolio: active orders (open work remaining) + overall % + resolved template. */
export async function portfolioProgress(companyId, exec = pool) {
  const [rows] = await exec.query(
    `SELECT fo.id AS orderId, fo.order_number AS orderNumber, fo.order_type AS orderType,
            fo.status, fo.customer_name AS customerName, fo.progress_pct AS progressPct,
            COUNT(t.id) AS total, SUM(t.status = 'done') AS done
       FROM fab_orders fo
       JOIN fab_project_tasks t ON t.order_id = fo.id AND t.company_id = fo.company_id
        AND t.deleted_at IS NULL AND t.status <> 'cancelled'
      WHERE fo.company_id = ? AND fo.deleted_at IS NULL
      GROUP BY fo.id, fo.order_number, fo.order_type, fo.status, fo.customer_name, fo.progress_pct`,
    [companyId],
  );

  const orders = [];
  for (const r of rows) {
    const total = Number(r.total), done = Number(r.done);
    const tpl = await resolveTemplateForOrder(exec, companyId, r.orderId);
    orders.push({
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      orderType: r.orderType,
      status: r.status,
      customerName: r.customerName,
      progressPct: r.progressPct != null ? Number(r.progressPct) : (total ? Math.round((done / total) * 100) : 0),
      total, done,
      templateId: tpl?.templateId ?? null,
      templateName: tpl?.templateName ?? null,
    });
  }
  // Open projects first, by most open work.
  orders.sort((a, b) => (b.total - b.done) - (a.total - a.done));
  return { ok: true, orders };
}
