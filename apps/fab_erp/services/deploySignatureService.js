/**
 * Deploy signatures — "has the BOM moved under a production order since it
 * went to the floor?"
 *
 * WHY A SIGNATURE, NOT A TIMESTAMP. `fab_items.updated_at` is bumped by weight
 * roll-ups, marks, similarity groups and the deploy itself, so "anything
 * changed after deployed_at" would call an untouched order stale the moment
 * its weights were recomputed. What the shop actually cares about is the shape
 * of the work: which rows exist, under whom, how many, with which flow, at what
 * size and steel, and how many the line sells. Hash exactly that, stamp the
 * hash on the production order when it deploys, and compare later. A match is
 * a match; a mismatch is a real change to what was deployed.
 *
 * Two production orders partition one sales order (blankService: the cutting
 * one owns the blank rows, the fabrication one everything else), so each gets
 * its own signature over its own rows — a re-nest that only moves blanks does
 * not make the fabrication order stale, and a length typed on a part does not
 * make the cutting order stale (that shows up as a part not on a sheet, on the
 * Nesting step, where it belongs).
 */

import { createHash } from 'node:crypto';
import { pool } from '../../../db.js';

const BLANK_JOIN = `LEFT JOIN fab_item_catalog bc ON bc.id = i.catalog_item_id AND bc.material_form = 'blank'`;

/**
 * @param {'cutting'|null|undefined} purpose the production order's mo_purpose
 * @returns {Promise<string>} sha1 hex
 */
export async function bomSignature(exec, companyId, salesOrderId, purpose) {
  const h = createHash('sha1');
  if (purpose === 'cutting') {
    const [blanks] = await exec.query(
      `SELECT i.id, i.qty, i.flow_id AS flowId FROM fab_items i ${BLANK_JOIN}
        WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
          AND i.node_kind = 'structure' AND bc.id IS NOT NULL
        ORDER BY i.id`,
      [companyId, salesOrderId],
    );
    for (const r of blanks) h.update(`b|${r.id}|${r.qty}|${r.flowId ?? ''}\n`);
    // A nest is a plate drawn once for several blanks; the material rows are
    // where that is written (nest_no + catalog item + qty per blank).
    const [mats] = await exec.query(
      `SELECT id, parent_item_id AS parentId, qty, nest_no AS nestNo, catalog_item_id AS catalogItemId
         FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND node_kind = 'material'
        ORDER BY id`,
      [companyId, salesOrderId],
    );
    for (const r of mats) h.update(`m|${r.id}|${r.parentId}|${r.qty}|${r.nestNo ?? ''}|${r.catalogItemId ?? ''}\n`);
    return h.digest('hex');
  }

  const [rows] = await exec.query(
    `SELECT i.id, i.parent_item_id AS parentId, i.qty, i.flow_id AS flowId,
            COALESCE(i.procurement_type, 'make') AS procurement
       FROM fab_items i ${BLANK_JOIN}
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.node_kind = 'structure' AND bc.id IS NULL
      ORDER BY i.id`,
    [companyId, salesOrderId],
  );
  for (const r of rows) h.update(`r|${r.id}|${r.parentId ?? ''}|${r.qty}|${r.flowId ?? ''}|${r.procurement}\n`);
  // Sizes and steel live on the field registry, not on the row.
  const [vals] = await exec.query(
    `SELECT v.scope_id AS scopeId, v.field_id AS fieldId, v.value_num AS num, v.value_text AS text
       FROM fab_field_values v
       JOIN fab_items i ON i.id = v.scope_id AND i.company_id = v.company_id AND i.deleted_at IS NULL
       ${BLANK_JOIN}
      WHERE v.company_id = ? AND v.scope = 'order_item' AND v.deleted_at IS NULL
        AND i.order_id = ? AND i.node_kind = 'structure' AND bc.id IS NULL
      ORDER BY v.scope_id, v.field_id`,
    [companyId, salesOrderId],
  );
  for (const v of vals) h.update(`v|${v.scopeId}|${v.fieldId}|${v.num ?? ''}|${v.text ?? ''}\n`);
  // A line's qty multiplies every task under it.
  const [lines] = await exec.query(
    `SELECT id, qty FROM fab_order_lines
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY id`,
    [companyId, salesOrderId],
  );
  for (const l of lines) h.update(`l|${l.id}|${l.qty}\n`);
  return h.digest('hex');
}

/**
 * Which of a sales order's deployed production orders no longer match the
 * BOM they were deployed with.
 *
 * An order deployed before signatures existed (deployed_signature NULL) is
 * never reported stale — there is nothing honest to compare it with.
 *
 * @returns {Promise<{cutting: boolean, fabrication: boolean, stale: string[]}>}
 *   `stale` lists the order numbers, for a message.
 */
export async function staleProductionOrders(companyId, salesOrderId, exec = pool) {
  const [mos] = await exec.query(
    `SELECT id, order_number AS orderNumber, mo_purpose AS purpose, status,
            deployed_signature AS signature
       FROM fab_orders
      WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
        AND deleted_at IS NULL AND status NOT IN ('draft', 'cancelled')`,
    [companyId, salesOrderId],
  );
  const out = { cutting: false, fabrication: false, stale: [] };
  for (const mo of mos) {
    if (!mo.signature) continue;
    const now = await bomSignature(exec, companyId, salesOrderId, mo.purpose);
    if (now !== mo.signature) {
      out[mo.purpose === 'cutting' ? 'cutting' : 'fabrication'] = true;
      out.stale.push(mo.orderNumber);
    }
  }
  return out;
}
