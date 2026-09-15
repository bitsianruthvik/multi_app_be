/**
 * itemShapeService.js — keep `depth` and `is_leaf` true for one order's tree.
 *
 * Both are DERIVED facts about the shape of the tree: depth is distance from the
 * line's root, and a leaf is a structural node with no structural children.
 * They are stored rather than computed per query because nesting matches on
 * them on every board load, and a subquery over a few thousand rows on each
 * read is the thing they exist to avoid.
 *
 * WHY THIS IS ONE FUNCTION AND NOT A RULE EACH WRITER FOLLOWS.
 *
 * `level_kind` was written by exactly one writer — the BOQ importer — and
 * everything else that created an item left it NULL. That is the bug recorded
 * in ARCHITECTURE §13: readiness gated on a column only one writer populated,
 * so a structure built by hand read as empty. Replacing it with `depth` moves
 * the burden from one writer to EVERY writer, and the generic mutate path (the
 * order tree's Add item) promptly proved the point by inserting a row with a
 * parent and a depth of 0 — the column default. Wrong depth, and `is_leaf = 0`
 * made it invisible to nesting, silently.
 *
 * So the shape is not something a caller remembers to set. It is recomputed for
 * the affected order after the write, in a handful of statements bounded by one
 * order, and it cannot drift.
 */

import { pool } from '../../../db.js';
import { recomputeOrderWeights } from './itemWeightService.js';
import { syncOrderProcurement } from './procurementService.js';
import { recomputeDerivedForOrder } from './fieldDeriveService.js';

/** Deeper than any real structure; also stops a malformed parent chain looping. */
const MAX_DEPTH = 12;

/**
 * Recompute `depth` and `is_leaf` for every live row of one order.
 *
 * @param {object} [conn] run inside a caller's transaction
 */
export async function recomputeItemShape(companyId, orderId, conn = null) {
  const exec = conn ?? pool;
  if (!orderId) return { depthPasses: 0 };

  await exec.query(
    `UPDATE fab_items SET depth = 0
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND parent_item_id IS NULL`,
    [companyId, orderId],
  );

  /*
   * One pass per level, stopping as soon as a pass changes nothing.
   *
   * A single self-join cannot settle a tree in one statement, and re-running a
   * fixed number of times wastes round trips on a shallow order — which most
   * are. The early exit makes the common case two passes.
   */
  let passes = 0;
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    const [r] = await exec.query(
      `UPDATE fab_items c
         JOIN fab_items p ON p.id = c.parent_item_id AND p.deleted_at IS NULL
          SET c.depth = p.depth + 1
        WHERE c.company_id = ? AND c.order_id = ? AND c.deleted_at IS NULL
          AND c.parent_item_id IS NOT NULL AND c.depth <> p.depth + 1`,
      [companyId, orderId],
    );
    passes += 1;
    if (!r.affectedRows) break;
  }

  /*
   * A leaf is a STRUCTURAL node with no structural children. A material link
   * hanging off a part does not stop that part being a leaf — the plate is what
   * the part is cut FROM, not something it contains — which is why the
   * NOT EXISTS is restricted to structural children.
   */
  /**
   * A DEMAND EDGE IS A CHILD, and forgetting that made assemblies into parts.
   *
   * Consolidation moves identical parts off their assemblies, so ED1 ends up
   * with no structural children at all — and childless is what `is_leaf` used to
   * mean. Every diaphragm and segment on the order therefore became a "part",
   * which nesting then tried to find a plate for and readiness reported as
   * uncuttable: "Segment has no thickness". Two hundred and forty-seven of them.
   *
   * `fab_item_demand` is where that relationship went, so it counts here exactly
   * as a child row does. An assembly that needs parts is not a leaf, wherever
   * those parts are stored.
   */
  /*
   * SCOPED BY COMPANY AND ORDER (S5), not just by the join condition. `id` is
   * globally unique so the old subqueries were never wrong, only slow — each
   * scanned every row in the WHOLE table, on every company's every order,
   * before the join narrowed it back down. Filtering the derived table first
   * bounds the scan to the one order this call actually cares about.
   */
  await exec.query(
    `UPDATE fab_items i SET i.is_leaf = 0
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND (i.node_kind = 'material'
             OR EXISTS (SELECT 1 FROM (SELECT parent_item_id, deleted_at, node_kind
                                         FROM fab_items
                                        WHERE company_id = ? AND order_id = ?) k
                         WHERE k.parent_item_id = i.id AND k.deleted_at IS NULL
                           AND k.node_kind = 'structure')
             OR EXISTS (SELECT 1 FROM (SELECT assembly_item_id, deleted_at
                                         FROM fab_item_demand
                                        WHERE company_id = ?) d
                         WHERE d.assembly_item_id = i.id AND d.deleted_at IS NULL))`,
    [companyId, orderId, companyId, orderId, companyId],
  );
  await exec.query(
    `UPDATE fab_items i SET i.is_leaf = 1
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.node_kind = 'structure'
        AND NOT EXISTS (SELECT 1 FROM (SELECT parent_item_id, deleted_at, node_kind
                                         FROM fab_items
                                        WHERE company_id = ? AND order_id = ?) k
                         WHERE k.parent_item_id = i.id AND k.deleted_at IS NULL
                           AND k.node_kind = 'structure')
        AND NOT EXISTS (SELECT 1 FROM (SELECT assembly_item_id, deleted_at
                                         FROM fab_item_demand
                                        WHERE company_id = ?) d
                         WHERE d.assembly_item_id = i.id AND d.deleted_at IS NULL)`,
    [companyId, orderId, companyId, orderId, companyId],
  );

  return { depthPasses: passes };
}

/**
 * Run after ANY write to an order's structure — `bomService.buildFromTree`
 * and `bomService.applyTree` call this at the tail of their own transaction
 * instead of the bare `recomputeDerived` they used to end with.
 *
 * Shape, weight, procurement and derived fields are four separate roll-ups
 * over the same tree, and until now were four separate reasons for the editor
 * to come back stale: `bomService.js` had zero references to the first three,
 * so a structure saved through the live editor kept its OLD weights and
 * procurement classification until something ELSE happened to touch the order
 * (an import, a nesting accept) and recomputed them as a side effect. Chaining
 * all four here, on the caller's own connection, means the numbers a user
 * sees right after Save are the numbers for what they just saved.
 *
 * ORDER MATTERS: shape (depth/is_leaf) before weight, because the weight
 * roll-up walks the tree shape this just corrected; weight before
 * procurement, because a buy/make split reads total weight; derived fields
 * last, because nothing upstream of them reads a derived value back.
 *
 * @param {object} conn the caller's open transaction
 * @param {object} [opts] reserved — no caller passes anything here yet
 */
// eslint-disable-next-line no-unused-vars
export async function afterStructureWrite(conn, companyId, orderId, opts = {}) {
  await recomputeItemShape(companyId, orderId, conn);
  await recomputeOrderWeights(companyId, orderId, conn);
  await syncOrderProcurement(conn, companyId, orderId);
  await recomputeDerivedForOrder(companyId, orderId, conn);
}

/** The order a fab_items row belongs to, for callers that only have its id. */
export async function orderIdOfItem(companyId, itemId, conn = null) {
  const exec = conn ?? pool;
  const [[row]] = await exec.query(
    'SELECT order_id AS orderId FROM fab_items WHERE id = ? AND company_id = ? LIMIT 1',
    [itemId, companyId],
  );
  return row?.orderId ?? null;
}

/**
 * Push each node's line down to its children, until nothing is left unlabelled.
 *
 * MOVED from boqSheetService.js (PLAN.md EU-20, 2026-09-13) — that file's
 * row-by-row sheet insert stamped the line on everything it created but two
 * cases slipped past it: an intermediate level that existed from an earlier
 * upload, and the raw-material links nesting hangs under a part later on. A
 * sweep catches both, and is cheap — the tree is five levels deep, so it
 * settles in five passes at worst.
 *
 * Exported unchanged; re-grepped at move time and has no live caller (its
 * two former callers, boqSheetService.js and nestingSheetService.js, were
 * both deleted in the same EU) — kept for whatever BOQ-speaking writer
 * eventually replaces them, per PLAN.md's own note that boqSheetService was
 * "left on disk unreferenced... so the rewrite has something to read."
 */
export async function propagateLineIds(conn, companyId, orderId) {
  for (let depth = 0; depth < 8; depth++) {
    const [res] = await conn.query(
      `UPDATE fab_items c
         JOIN fab_items p ON p.id = c.parent_item_id AND p.deleted_at IS NULL
          SET c.order_line_id = p.order_line_id
        WHERE c.company_id = ? AND c.order_id = ? AND c.deleted_at IS NULL
          AND c.order_line_id IS NULL AND p.order_line_id IS NOT NULL`,
      [companyId, orderId],
    );
    if (!res.affectedRows) break;
  }
}

/**
 * Recompute `is_leaf` across one order.
 *
 * MOVED from boqSheetService.js (PLAN.md EU-20, 2026-09-13). Delegated, not
 * duplicated, to `recomputeItemShape` in this same file — kept as a
 * separately-named export only because its (now gone) callers used this
 * name; a new caller should probably reach for `recomputeItemShape` directly.
 */
export async function recomputeLeaves(conn, companyId, orderId) {
  return recomputeItemShape(companyId, orderId, conn);
}
