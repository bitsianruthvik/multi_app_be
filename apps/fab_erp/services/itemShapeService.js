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
  await exec.query(
    `UPDATE fab_items i SET i.is_leaf = 0
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND (i.node_kind = 'material'
             OR EXISTS (SELECT 1 FROM (SELECT parent_item_id, deleted_at, node_kind
                                         FROM fab_items) k
                         WHERE k.parent_item_id = i.id AND k.deleted_at IS NULL
                           AND k.node_kind = 'structure'))`,
    [companyId, orderId],
  );
  await exec.query(
    `UPDATE fab_items i SET i.is_leaf = 1
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.node_kind = 'structure'
        AND NOT EXISTS (SELECT 1 FROM (SELECT parent_item_id, deleted_at, node_kind
                                         FROM fab_items) k
                         WHERE k.parent_item_id = i.id AND k.deleted_at IS NULL
                           AND k.node_kind = 'structure')`,
    [companyId, orderId],
  );

  return { depthPasses: passes };
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
