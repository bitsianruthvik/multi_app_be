/**
 * markService.js — piece marks for fab_items (Issue 2).
 *
 * A piece mark is the identity of a physical piece of steel: short enough to
 * write on it with a paint pen, printed on the drawing, and what the shop, the
 * erector and this system all use to mean the same object.
 *
 * Four rules drive everything below, and each exists because breaking it breaks
 * something real on the floor:
 *
 *  1. **Unique per order, not globally.** 'B1' on this bridge and 'B1' on the
 *     next are different pieces and nobody is confused. Global uniqueness would
 *     force synthetic marks nobody would actually write down.
 *
 *  2. **Frozen once assigned.** Someone has already painted it on a plate.
 *     Regenerating marks for an order must never renumber an existing one —
 *     only fill in the blanks. This is the single most important rule here.
 *
 *  3. **Gaps are correct.** Deleting item B3 leaves a hole. Closing the gap
 *     would silently move B4's identity onto different steel. Sequences only
 *     ever move forward.
 *
 *  4. **Identical pieces share one mark.** Twelve identical stiffeners are all
 *     'S3' with qty 12 — a mark names a *design*, and the row's qty says how
 *     many exist. We never mint twelve marks.
 *
 * Children are suffixed from their parent ('B1' → 'B1-a', 'B1-b') so the
 * assembly relationship is legible on the steel itself, which is the whole
 * point of marking sub-parts.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

/** Fallback when a company has configured no scheme at all. */
const DEFAULT_PREFIX = 'P';

/** a, b, … z, aa, ab … — child suffixes. Spreadsheet-column style. */
export function childSuffix(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Resolve item-category → prefix for a company.
 * Returns { byCategoryId: Map, fallback: string }.
 */
async function loadScheme(companyId) {
  const [rows] = await pool.query(
    `SELECT item_category_id, prefix FROM fab_mark_schemes
      WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const byCategoryId = new Map();
  let fallback = DEFAULT_PREFIX;
  for (const r of rows) {
    if (r.item_category_id === null) fallback = r.prefix;
    else byCategoryId.set(r.item_category_id, r.prefix);
  }
  return { byCategoryId, fallback };
}

/**
 * Assign marks to every unmarked item in an order.
 *
 * Returns { assigned, skipped, total }. `skipped` counts rows that already had
 * a mark — they are left exactly as they were (rule 2).
 *
 * Runs in one transaction so a partial pass can't leave an order half-marked
 * with a sequence that later restarts.
 */
export async function generateMarksForOrder(companyId, orderId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the order's items so two concurrent generate calls can't both claim
    // the same next sequence number and collide on the unique index.
    const [items] = await conn.query(
      `SELECT i.id, i.parent_item_id, i.mark, i.mark_prefix, i.mark_seq,
              ic.category_id AS categoryId
         FROM fab_items i
         LEFT JOIN fab_item_catalog ic ON ic.id = i.catalog_item_id AND ic.deleted_at IS NULL
        WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        ORDER BY i.parent_item_id IS NOT NULL, i.id
        FOR UPDATE`,
      [companyId, orderId],
    );

    if (items.length === 0) {
      await conn.commit();
      return { assigned: 0, skipped: 0, total: 0 };
    }

    const { byCategoryId, fallback } = await loadScheme(companyId);

    // Highest sequence already used per prefix *in this order*. Seeded from
    // existing rows so regeneration continues rather than restarting — the
    // heart of rules 2 and 3.
    const seqByPrefix = new Map();
    for (const it of items) {
      if (it.mark_prefix && it.mark_seq != null) {
        const cur = seqByPrefix.get(it.mark_prefix) ?? 0;
        if (it.mark_seq > cur) seqByPrefix.set(it.mark_prefix, it.mark_seq);
      }
    }

    // Children need their parent's mark, and a parent may be marked in this
    // same pass — so resolve top-level first (the ORDER BY above guarantees it)
    // and keep a live map as we go.
    const markById = new Map();
    const childCountByParent = new Map();
    for (const it of items) {
      if (it.mark) markById.set(it.id, it.mark);
      if (it.parent_item_id && it.mark) {
        // Seed the child counter past any existing suffix so regeneration
        // appends rather than colliding.
        const n = (childCountByParent.get(it.parent_item_id) ?? 0) + 1;
        childCountByParent.set(it.parent_item_id, n);
      }
    }

    let assigned = 0;
    let skipped = 0;

    for (const it of items) {
      if (it.mark) { skipped += 1; continue; }

      let mark;
      let prefix = null;
      let seq = null;

      const parentMark = it.parent_item_id ? markById.get(it.parent_item_id) : null;

      if (parentMark) {
        // Child: suffix from the parent so the hierarchy is readable on steel.
        const idx = childCountByParent.get(it.parent_item_id) ?? 0;
        childCountByParent.set(it.parent_item_id, idx + 1);
        mark = `${parentMark}-${childSuffix(idx)}`;
      } else {
        // Top-level (or an orphan whose parent has no mark): PREFIX + seq.
        prefix = byCategoryId.get(it.categoryId) ?? fallback;
        seq = (seqByPrefix.get(prefix) ?? 0) + 1;
        seqByPrefix.set(prefix, seq);
        mark = `${prefix}${seq}`;
      }

      await conn.query(
        `UPDATE fab_items SET mark = ?, mark_prefix = ?, mark_seq = ? WHERE id = ?`,
        [mark, prefix, seq, it.id],
      );
      markById.set(it.id, mark);
      assigned += 1;
    }

    await conn.commit();
    logger?.info?.(`marks: order ${orderId} — assigned ${assigned}, kept ${skipped}`);
    return { assigned, skipped, total: items.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Set one item's mark by hand. Fabricators inherit marks from the client's
 * drawings more often than they invent them, so manual override must always be
 * possible — and must win over anything generated.
 *
 * Throws a tagged error on collision so the route can return 409 rather than a
 * raw duplicate-key message.
 */
export async function setItemMark(companyId, itemId, mark, { cascadeChildren = false } = {}) {
  const trimmed = (mark ?? '').trim();

  const [rows] = await pool.query(
    `SELECT order_id, mark AS oldMark FROM fab_items
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [itemId, companyId],
  );
  if (rows.length === 0) {
    const e = new Error('Item not found.');
    e.code = 'NOT_FOUND';
    throw e;
  }

  if (trimmed === '') {
    // Clearing is allowed — a mark entered in error shouldn't be permanent.
    await pool.query(
      `UPDATE fab_items SET mark = NULL, mark_prefix = NULL, mark_seq = NULL WHERE id = ?`,
      [itemId],
    );
    return { mark: null };
  }

  const [clash] = await pool.query(
    `SELECT id FROM fab_items
      WHERE order_id = ? AND mark = ? AND id <> ? LIMIT 1`,
    [rows[0].order_id, trimmed, itemId],
  );
  if (clash.length > 0) {
    const e = new Error(`Mark "${trimmed}" is already used by another item on this order.`);
    e.code = 'MARK_TAKEN';
    throw e;
  }

  // Manual marks deliberately clear prefix/seq: they are outside the generated
  // sequence, and leaving a stale seq would let a later pass reuse the number.
  await pool.query(
    `UPDATE fab_items SET mark = ?, mark_prefix = NULL, mark_seq = NULL WHERE id = ?`,
    [trimmed, itemId],
  );

  // Renaming a parent leaves its children on the old stem ('B12' with a child
  // still called 'P1-a'), which reads as a mistake. But cascading would rename
  // steel that may already be painted — a direct violation of rule 2.
  //
  // The system genuinely cannot know which case applies, so it does NOT cascade
  // by default and instead reports how many children *would* change. The caller
  // surfaces that as an explicit choice and calls back with cascadeChildren.
  const oldMark = rows[0].oldMark;
  let childrenRenamed = 0;
  let childrenOnOldStem = 0;

  if (oldMark && oldMark !== trimmed) {
    const [kids] = await pool.query(
      `SELECT id, mark FROM fab_items
        WHERE parent_item_id = ? AND deleted_at IS NULL AND mark LIKE ?`,
      [itemId, `${oldMark}-%`],
    );
    childrenOnOldStem = kids.length;

    if (cascadeChildren) {
      for (const kid of kids) {
        // Swap only the stem, keep the suffix: 'P1-a' → 'B12-a'.
        const next = `${trimmed}${kid.mark.slice(oldMark.length)}`;
        await pool.query(
          `UPDATE fab_items SET mark = ?, mark_prefix = NULL, mark_seq = NULL WHERE id = ?`,
          [next, kid.id],
        );
        childrenRenamed += 1;
      }
      childrenOnOldStem = 0;
    }
  }

  return { mark: trimmed, childrenRenamed, childrenOnOldStem };
}
