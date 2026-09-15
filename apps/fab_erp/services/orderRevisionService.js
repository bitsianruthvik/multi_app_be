/**
 * orderRevisionService.js — the paper trail for editing structure after
 * Confirm.
 *
 * `applyTree` refuses (per §13 "A draft sales order means 'still in the
 * wizard'", and User Clarifications 4) to let a quantity/dims/position/flow
 * change on a shop-floor-started row through silently once an order is out of
 * draft, and refuses the whole apply outright when the ORDER ITSELF is out of
 * draft with no reason given. When a reason is given, this is where it lands:
 * one row per apply, holding the reason, the tree as it stood before the
 * change, and what the apply actually did.
 *
 * ONE `rev` SEQUENCE PER ORDER (User Clarifications 6) — not per line. A
 * three-line order that gets revised on line B is "rev 4 of this order,
 * touching line B", not "line B's rev 1"; `orderLineId` is recorded only as
 * an informational "which line" column, and the UNIQUE key is
 * `(order_id, rev)`.
 */

import { pool } from '../../../db.js';

/**
 * Insert the next revision row for an order.
 *
 * MUST run inside the caller's transaction, on the caller's connection, with
 * the order row already locked `FOR UPDATE` — that lock is what makes
 * `MAX(rev)+1` safe against two revisions on the same order landing at once;
 * this function does no locking of its own.
 *
 * @param {object} conn - the caller's transaction connection
 * @param {number} companyId
 * @param {number} orderId
 * @param {object} opts
 * @param {number|null} [opts.orderLineId] - informational only, does not scope `rev`
 * @param {string} opts.reason
 * @param {object|null} [opts.snapshot] - the pre-apply tree (currentTree's shape)
 * @param {object|null} [opts.summary] - applyTree's `{created, updated, removed, sized}`
 * @param {number|null} [opts.userId]
 * @returns {Promise<{id: number, rev: number}>}
 */
export async function recordRevision(conn, companyId, orderId, opts = {}) {
  const { orderLineId = null, reason, snapshot = null, summary = null, userId = null } = opts;
  if (!reason || String(reason).trim().length < 10) {
    const e = new Error('A revision reason of at least 10 characters is required.');
    e.status = 400;
    e.code = 'REVISION_REASON_REQUIRED';
    throw e;
  }

  const [[row]] = await conn.query(
    `SELECT COALESCE(MAX(rev), 0) AS maxRev FROM fab_order_structure_revisions
      WHERE company_id = ? AND order_id = ?`,
    [companyId, orderId],
  );
  const rev = Number(row.maxRev) + 1;

  const [ins] = await conn.query(
    `INSERT INTO fab_order_structure_revisions
       (company_id, order_id, order_line_id, rev, reason, snapshot_json, summary_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [
      companyId, orderId, orderLineId, rev, String(reason).trim(),
      snapshot == null ? null : JSON.stringify(snapshot),
      summary == null ? null : JSON.stringify(summary),
      userId,
    ],
  );
  return { id: ins.insertId, rev };
}

/**
 * The revisions list for the order detail page, newest first. Read directly
 * rather than through the generic query API — the caller wants `summary`
 * parsed, not the raw JSON column.
 *
 * @returns {Promise<Array<{id, rev, orderLineId, reason, summary, createdBy, createdAt}>>}
 */
export async function listRevisions(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT id, order_line_id AS orderLineId, rev, reason, summary_json AS summary,
            created_by AS createdBy, created_at AS createdAt
       FROM fab_order_structure_revisions
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
      ORDER BY rev DESC`,
    [companyId, orderId],
  );
  return rows.map((r) => {
    let summary = r.summary;
    if (typeof summary === 'string') {
      try { summary = JSON.parse(summary); } catch { summary = null; }
    }
    return {
      ...r,
      orderLineId: r.orderLineId == null ? null : Number(r.orderLineId),
      summary,
    };
  });
}
