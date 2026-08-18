/**
 * similarityService.js — "these girders are the same as each other".
 *
 * A six-girder span produces 210 parts, and typing a Top Flange's thickness
 * thirty times is not thirty decisions. It is one decision, typed thirty times,
 * with thirty chances to fat-finger it.
 *
 * WHAT A GROUP IS. A `similar_group` key stamped on the GIRDER or SEGMENT rows
 * that are copies of each other. Never on the parts — the parts follow from it.
 *
 * HOW A PART FINDS ITS OPPOSITE NUMBER. By its code, which already encodes its
 * position. Strip the group root's code from the part's code and what is left
 * is its PEER KEY:
 *
 *   VSHW-…-SPANA-G1-1-TF   under group root G1   ->   peer key "1-TF"
 *   VSHW-…-SPANA-G2-1-TF   under group root G2   ->   peer key "1-TF"
 *
 * Same peer key, same group -> the same part in a different copy. This reuses
 * the "codes ARE the structure" rule the whole BOQ format is built on, so there
 * is no second notion of identity to keep in sync with the first.
 *
 * IT SAVES TYPING; IT DOES NOT FREEZE THE PARTS TOGETHER. Writing a value
 * against one member writes it to all of them, once. It does not stop someone
 * later giving one girder a thicker web — that is a real answer to a real
 * question, and nothing here overwrites it afterwards.
 */

import { pool } from '../../../db.js';

/** Levels that may be marked similar. A part is not a copy of anything. */
export const GROUPABLE_LEVELS = ['girder', 'segment'];

/**
 * Mark a set of girders (or segments) as copies of each other.
 *
 * @param {number[]} itemIds two or more items, all the same level_kind and all
 *   on this order. One id is accepted only to UNMARK (pass groupKey null).
 * @param {string|null} groupKey null clears the grouping
 */
export async function markSimilar(companyId, orderId, itemIds, groupKey, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();
    const ids = [...new Set((itemIds ?? []).map(Number).filter(Boolean))];
    if (!ids.length) { const e = new Error('Nothing selected.'); e.status = 400; throw e; }

    const [rows] = await conn.query(
      `SELECT id, level_kind AS levelKind, code, parent_item_id AS parentId
         FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
          AND id IN (${ids.map(() => '?').join(',')})`,
      [companyId, orderId, ...ids],
    );
    if (rows.length !== ids.length) {
      const e = new Error('Some of those items are not on this order.');
      e.status = 404;
      throw e;
    }

    // All one level. Marking a girder similar to a segment is not a thing that
    // could mean anything, and silently allowing it would produce peer keys
    // that never match.
    const levels = [...new Set(rows.map((r) => r.levelKind))];
    if (groupKey && (levels.length > 1 || !GROUPABLE_LEVELS.includes(levels[0]))) {
      const e = new Error(
        `Only ${GROUPABLE_LEVELS.join(' or ')} rows can be marked similar, and they must all be the same kind.`,
      );
      e.status = 400;
      throw e;
    }
    if (groupKey && ids.length < 2) {
      const e = new Error('Pick at least two to mark them as similar.');
      e.status = 400;
      throw e;
    }

    await conn.query(
      `UPDATE fab_items SET similar_group = ?
        WHERE company_id = ? AND order_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      [groupKey || null, companyId, orderId, ...ids],
    );

    if (owned) await conn.commit();
    return { groupKey: groupKey || null, members: ids.length, level: levels[0] ?? null };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/**
 * The rows that COULD be marked similar, grouped by level and by parent.
 *
 * Only siblings are offered. Two girders under different spans are not copies
 * of each other in any useful sense — their parts would have different peer
 * keys and nothing would fan out — and offering them would let someone build a
 * group that silently does nothing.
 */
export async function groupableItems(companyId, orderId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT i.id, i.code, i.name, i.level_kind AS levelKind,
            i.parent_item_id AS parentId, i.similar_group AS similarGroup,
            p.code AS parentCode,
            (SELECT COUNT(*) FROM fab_items c
              WHERE c.parent_item_id = i.id AND c.deleted_at IS NULL) AS childCount
       FROM fab_items i
       LEFT JOIN fab_items p ON p.id = i.parent_item_id
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.level_kind IN (?)
      ORDER BY i.level_kind, p.code, i.code`,
    [companyId, orderId, GROUPABLE_LEVELS],
  );
  const out = new Map();
  for (const r of rows) {
    // Siblings of one level, under one parent — the only set where "these are
    // the same as each other" is a meaningful claim.
    const key = `${r.levelKind}:${r.parentId ?? 'root'}`;
    if (!out.has(key)) {
      out.set(key, { key, levelKind: r.levelKind, parentId: r.parentId, parentCode: r.parentCode, items: [] });
    }
    out.get(key).items.push({
      id: r.id, code: r.code, name: r.name,
      similarGroup: r.similarGroup, childCount: Number(r.childCount) || 0,
    });
  }
  // A set of one has nothing to be similar to.
  return [...out.values()].filter((g) => g.items.length > 1);
}

/** Every similarity group on this order, with its members. */
export async function groupsForOrder(companyId, orderId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT similar_group AS groupKey, level_kind AS levelKind,
            id, code, name
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
        AND similar_group IS NOT NULL
      ORDER BY similar_group, code`,
    [companyId, orderId],
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.groupKey)) out.set(r.groupKey, { groupKey: r.groupKey, levelKind: r.levelKind, members: [] });
    out.get(r.groupKey).members.push({ id: r.id, code: r.code, name: r.name });
  }
  return [...out.values()];
}

/**
 * Peer sets for every grouped part on this order.
 *
 * Returns `{ peerOf, leaders }`:
 *   peerOf   itemId -> array of every item id that is the same part in another
 *            copy, INCLUDING itself
 *   leaders  the one member of each peer set that stands for it — the lowest
 *            id, chosen only because it must be deterministic
 *
 * An ungrouped part is absent from both, and callers treat absence as "this
 * part is only itself", which keeps the ungrouped path exactly as it was.
 */
export async function peerSets(companyId, orderId, conn = null) {
  const exec = conn ?? pool;

  // The group roots, then everything beneath them. Two queries rather than a
  // recursive CTE because the depth is fixed and small (girder > segment >
  // part) and the descendant test is a code prefix, which an index can use.
  const [roots] = await exec.query(
    `SELECT id, code, similar_group AS groupKey FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
        AND similar_group IS NOT NULL`,
    [companyId, orderId],
  );
  if (!roots.length) return { peerOf: new Map(), leaders: new Set() };

  const [all] = await exec.query(
    `SELECT id, code, flow_id AS flowId FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND code IS NOT NULL`,
    [companyId, orderId],
  );

  // group key -> peer key -> [itemId]
  const buckets = new Map();
  for (const root of roots) {
    const prefix = `${root.code}-`;
    for (const it of all) {
      if (!it.code || !it.code.startsWith(prefix)) continue;
      const peerKey = it.code.slice(prefix.length);
      if (!buckets.has(root.groupKey)) buckets.set(root.groupKey, new Map());
      const byPeer = buckets.get(root.groupKey);
      if (!byPeer.has(peerKey)) byPeer.set(peerKey, []);
      byPeer.get(peerKey).push(Number(it.id));
    }
  }

  const peerOf = new Map();
  const leaders = new Set();
  for (const byPeer of buckets.values()) {
    for (const members of byPeer.values()) {
      if (members.length < 2) continue; // alone is not a peer set
      const sorted = [...members].sort((a, b) => a - b);
      leaders.add(sorted[0]);
      for (const id of sorted) peerOf.set(id, sorted);
    }
  }
  return { peerOf, leaders };
}

/**
 * Expand a set of item ids to include every peer.
 *
 * What makes "fill it in once" actually work: a write aimed at one part is
 * aimed at all of its copies. Ungrouped ids come back untouched.
 */
export async function withPeers(companyId, orderId, itemIds, conn = null) {
  const { peerOf } = await peerSets(companyId, orderId, conn);
  const out = new Set();
  for (const id of itemIds ?? []) {
    const peers = peerOf.get(Number(id));
    if (peers) peers.forEach((p) => out.add(p));
    else out.add(Number(id));
  }
  return [...out];
}
