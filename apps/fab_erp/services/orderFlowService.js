/**
 * orderFlowService.js — which flow each item on an order is made by.
 *
 * REPLACES flowAllocationService, and the difference is where the default comes
 * from rather than how it is applied.
 *
 * The old service resolved a flow by matching `fab_flow_rules` on
 * (line_type, level_kind, code SUFFIX) — three free-text keys plus a naming
 * convention code had to parse, where '/D' on the end of a code meant "the
 * drilled variant". Assigning flows was therefore a separate ACTION somebody
 * had to remember to press, on a table nothing else validated.
 *
 * Now the default lives on the BOM line (`fab_item_bom.default_flow_id`), so it
 * arrives with the structure at instantiate time and there is nothing to apply.
 * That is also strictly more expressive: the line is the item IN CONTEXT of its
 * parent, so a Top Flange inside a Girder Segment can be made differently from
 * a Top Flange inside a PEB member. A rule keyed on the type alone never could
 * say that, which is why the '/D' convention existed in the first place.
 *
 * WHAT IS LEFT is a review surface: see what each item got, override any of
 * them, and re-pull the BOM's answer for items that still have none.
 *
 * NO FLOW MEANS NOTHING TO DO, and that stays a valid end state — an assembly
 * that only groups its children carries no flow at all. Nothing here treats a
 * flow-less item as an error.
 */

import { pool } from '../../../db.js';
import { depthLabels, labelFor } from './depthLabelService.js';

/**
 * What the order looks like right now, per DEPTH: how many structural items,
 * how many have a flow, and how many the BOM could still answer for.
 *
 * Keyed by depth rather than by a level name, and labelled from the items
 * themselves — see orderReadinessService.countTree for the same idea.
 */
export async function flowSummary(companyId, orderId, conn = null) {
  const exec = conn ?? pool;
  const [[order]] = await exec.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

  const [rows] = await exec.query(
    `SELECT i.depth, i.id, i.flow_id AS flowId, f.name AS flowName,
            i.name, i.procurement_type AS procurementType,
            b.default_flow_id AS bomFlowId
       FROM fab_items i
       LEFT JOIN fab_operation_flows f ON f.id = i.flow_id AND f.deleted_at IS NULL
       LEFT JOIN fab_items p ON p.id = i.parent_item_id AND p.deleted_at IS NULL
       LEFT JOIN fab_item_bom b ON b.company_id = i.company_id
                               AND b.parent_item_id = p.catalog_item_id
                               AND b.child_item_id = i.catalog_item_id
                               AND b.deleted_at IS NULL AND b.active = 1
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.node_kind = 'structure'
      ORDER BY i.depth, i.code`,
    [companyId, orderId],
  );

  // Through the shared service. Naming a rung "the first row I happened to see"
  // is why this tab and the Structure stage disagreed about the same depth.
  const labels = await depthLabels(companyId, orderId, conn);

  const byDepth = new Map();
  let wouldAssign = 0;
  for (const r of rows) {
    /*
     * A BOUGHT item is not counted at all, not counted as unassigned.
     *
     * A stud is not fabricated, so it will never be given a flow — reporting it
     * as outstanding describes work that can never be cleared, and the stage
     * would sit one step short of confirmable forever. The old service learnt
     * this the hard way; the rule and the count that reports on it have to
     * agree.
     */
    if ((r.procurementType || 'make') !== 'make') continue;

    const d = Number(r.depth);
    if (!byDepth.has(d)) {
      byDepth.set(d, { depth: d, label: labelFor(labels, d), items: 0, withFlow: 0, wouldAssign: 0, flows: new Map() });
    }
    const bucket = byDepth.get(d);
    bucket.items++;
    if (r.flowId) {
      bucket.withFlow++;
      const n = r.flowName ?? `#${r.flowId}`;
      bucket.flows.set(n, (bucket.flows.get(n) ?? 0) + 1);
    } else if (r.bomFlowId) {
      // The BOM has an answer this item never received — usually because the
      // line's default was set after the order was built.
      bucket.wouldAssign++;
      wouldAssign++;
    }
  }

  return {
    wouldAssign,
    levels: [...byDepth.values()].sort((a, b) => a.depth - b.depth).map((b) => ({
      ...b,
      flows: [...b.flows.entries()].map(([name, count]) => ({ name, count })),
    })),
  };
}

/**
 * Re-pull the BOM's default for every item that still has no flow.
 *
 * Replaces "apply the rules". It exists for one case: somebody set or corrected
 * a BOM line's default flow AFTER an order was instantiated from it.
 *
 * NEVER OVERWRITES A CHOICE SOMEONE MADE unless asked. Only items with no flow
 * are touched, because re-running otherwise would silently undo every exception
 * on the order — the same guarantee the service this replaced gave.
 */
export async function syncFlowsFromBom(companyId, orderId, { reassign = false } = {}) {
  const [res] = await pool.query(
    `UPDATE fab_items i
       JOIN fab_items p ON p.id = i.parent_item_id AND p.deleted_at IS NULL
       JOIN fab_item_bom b ON b.company_id = i.company_id
                          AND b.parent_item_id = p.catalog_item_id
                          AND b.child_item_id = i.catalog_item_id
                          AND b.deleted_at IS NULL AND b.active = 1
        SET i.flow_id = b.default_flow_id
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.node_kind = 'structure'
        AND (i.procurement_type IS NULL OR i.procurement_type = 'make')
        AND b.default_flow_id IS NOT NULL
        ${reassign ? '' : 'AND i.flow_id IS NULL'}`,
    [companyId, orderId],
  );
  return { assigned: res.affectedRows };
}

/** Override one item's flow. Null clears it, which is a valid answer. */
export async function setItemFlow(companyId, orderId, itemId, flowId) {
  if (flowId != null) {
    const [[flow]] = await pool.query(
      'SELECT id FROM fab_operation_flows WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
      [flowId, companyId],
    );
    if (!flow) { const e = new Error('That flow does not exist.'); e.status = 404; throw e; }
  }
  const [res] = await pool.query(
    `UPDATE fab_items SET flow_id = ?
      WHERE id = ? AND company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [flowId ?? null, itemId, companyId, orderId],
  );
  if (!res.affectedRows) { const e = new Error('That item is not on this order.'); e.status = 404; throw e; }
  return { itemId, flowId: flowId ?? null };
}

/** Every structural item with its flow — the review grid behind the Flows step. */
export async function itemFlows(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT i.id, i.code, i.name, i.depth, i.is_leaf AS isLeaf,
            i.flow_id AS flowId, f.name AS flowName, i.procurement_type AS procurementType
       FROM fab_items i
       LEFT JOIN fab_operation_flows f ON f.id = i.flow_id AND f.deleted_at IS NULL
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.node_kind = 'structure'
      ORDER BY i.depth, i.code`,
    [companyId, orderId],
  );
  return rows;
}
