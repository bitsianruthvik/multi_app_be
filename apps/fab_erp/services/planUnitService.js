/**
 * planUnitService.js — which bars make up a UNIT of work.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Plan Board used to send the group transform a list of entry ids it had
 * built from the blocks on screen. That list is a WINDOW, not a unit. Exercised
 * on a real order, girder SPAN2-G4 had forty-four bars and one of them was in
 * the visible week — so dragging its handle moved 1/44 while appearing to move
 * the girder. Nothing said so, and the local test data never showed it because
 * every unit there fitted inside a week.
 *
 * So the client now names the UNIT — a level of the BOM ladder and the node it
 * landed on — and the whole set is resolved here, over the order, regardless of
 * what happened to be drawn.
 *
 * THE RULE, AND WHY IT IS DUPLICATED
 * ----------------------------------
 * A unit is not "this node and everything under it". Grouping walks UP from the
 * task's item to the first ancestor at the wanted level OR COARSER, so at girder
 * level a task sitting on the SPAN belongs to the span's own unit, not to any
 * girder — and resolving that node as "its whole subtree" would sweep in all
 * four girders, which is not what the handle drew.
 *
 * The identical walk therefore lives in the client (`boardModel.groupKeyFor`),
 * which needs it per block for drawing and cannot ask the server thousands of
 * times. Two copies of a rule is exactly the shape of the bundle-end bug (§13),
 * so this one does not rely on them agreeing: the client sends the bars it
 * BELIEVES are in the unit, and `assertContains` refuses the whole transform if
 * the server's answer does not contain them. Drift becomes a loud refusal on the
 * first drag instead of a plan quietly moving the wrong work.
 */

import { pool } from '../../../db.js';
import { cachedQuery } from './planReadCache.js';
import { PlanError } from './planService.js';

/**
 * The two rungs ABOVE the item tree. Everything below them is a DEPTH.
 *
 * This used to be a fixed six-rung ladder — order, line, span, girder, segment,
 * part — with a `KIND_RANK` table mapping each level name to its position. Four
 * of those six were structural levels the company could not change, so a job
 * with a fifth level had nowhere to sit and a job with three had a dead rung.
 *
 * A depth level is written `d0`, `d1`, `d2`… where the number is
 * `fab_items.depth`: d0 is the line's root, d1 its children, and so on for
 * however deep the BOM goes. Ranking is then arithmetic rather than a lookup,
 * and nothing here has to know what a girder is.
 *
 * Labels come from the catalog item names found at that depth — see
 * `depthLabels` — so a board still reads "Girder" without 'girder' appearing
 * anywhere in this file.
 */
export const GROUP_LEVELS = ['order', 'line'];

/** Deep enough for any real structure; guards a nonsense `d99` from a client. */
export const MAX_GROUP_DEPTH = 12;

export const isDepthLevel = (l) => /^d\d+$/.test(String(l ?? ''));
export const depthOfLevel = (l) => Number(String(l).slice(1));
export const isGroupLevel = (l) => GROUP_LEVELS.includes(l)
  || (isDepthLevel(l) && depthOfLevel(l) <= MAX_GROUP_DEPTH);

/** Guards a malformed parent chain; a cycle would otherwise loop forever. */
const MAX_WALK = 24;

/**
 * What to call each depth on this order.
 *
 * Re-exported from `depthLabelService` rather than implemented here. This file
 * had its own version, `orderReadinessService` had another and
 * `orderFlowService` a third; all three were defensible, none agreed, and the
 * order's Structure stage ended up naming a rung "Top Flange" while its Flows
 * tab called the same rung "Bottom Flange".
 */
export { depthLabels, labelFor } from './depthLabelService.js';

/**
 * Parse a unit key as the board writes it: `o:<orderId>` / `l:<lineId>` /
 * `i:<itemId>`.
 */
export function parseUnitKey(key) {
  const m = /^([oli]):(\d+)$/.exec(String(key ?? ''));
  if (!m) return null;
  return { kind: m[1], id: Number(m[2]) };
}

/**
 * The group key an item belongs to at `level`. Mirrors boardModel.groupKeyFor.
 *
 * Exported so the Actuals Board resolves its units through THIS function rather
 * than growing a third copy of the walk. The header above explains why the two
 * copies that do exist (server + client) are cross-checked rather than trusted;
 * a third would be the same bug waiting to happen.
 */
export function groupKeyFor(itemsById, itemId, level) {
  const start = itemsById.get(Number(itemId)) ?? null;
  if (!start) return null;

  if (level === 'order' || level === 'line') {
    // order / line are not BOM nodes; climb until the ids appear.
    let cur = start;
    for (let i = 0; i < MAX_WALK && cur; i += 1) {
      if (level === 'order' && cur.orderId != null) return `o:${cur.orderId}`;
      if (level === 'line' && cur.orderLineId != null) return `l:${cur.orderLineId}`;
      cur = cur.parentItemId != null ? itemsById.get(cur.parentItemId) ?? null : null;
    }
    return null;
  }
  if (!isDepthLevel(level)) return null;

  /*
   * Climb until the node is at or above the wanted depth.
   *
   * A material row sits one deeper than the part it belongs to, so it walks up
   * to that part like anything else — the old `KIND_RANK` gave 'material' rank
   * 6 to get the same effect, and had to state it as a special case.
   */
  const wanted = depthOfLevel(level);
  let node = start;
  for (let i = 0; i < MAX_WALK && node; i += 1) {
    if (Number(node.depth ?? 0) <= wanted) return `i:${node.id}`;
    node = node.parentItemId != null ? itemsById.get(node.parentItemId) ?? null : null;
  }
  return null;
}

/**
 * Which orders a unit could possibly live in.
 *
 * A unit key names one node, and every bar in that unit belongs to the same
 * order — so the candidate set is one order's bars, not the whole shop's.
 */
async function ordersForUnit(companyId, unit) {
  if (unit.kind === 'o') return [unit.id];
  if (unit.kind === 'l') {
    const [rows] = await cachedQuery(`SELECT order_id AS orderId FROM fab_order_lines
        WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
      [companyId, unit.id],
    );
    return rows.map((r) => r.orderId).filter((x) => x != null);
  }
  const [rows] = await cachedQuery(`SELECT order_id AS orderId FROM fab_items
      WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, unit.id],
  );
  return rows.map((r) => r.orderId).filter((x) => x != null);
}

/**
 * Every planned bar belonging to one unit of work, across the WHOLE plan.
 *
 * @param {number} companyId
 * @param {{level: string, key: string}} unit
 * @returns {Promise<{entryIds: number[], level: string, key: string, orderIds: number[]}>}
 */
export async function resolveUnitEntries(companyId, { level, key } = {}) {
  if (!isGroupLevel(level)) {
    throw new PlanError('BAD_UNIT', `"${level}" is not a grouping level. Use 'order', 'line', or 'd<n>'.`);
  }
  const unit = parseUnitKey(key);
  if (!unit) throw new PlanError('BAD_UNIT', `"${key}" is not a unit key.`);

  const orderIds = await ordersForUnit(companyId, unit);
  if (orderIds.length === 0) {
    throw new PlanError('UNIT_NOT_FOUND', 'That unit does not belong to any order.');
  }

  // The order's whole item tree — the walk needs ancestors, not just the leaves
  // that carry tasks.
  const [items] = await cachedQuery(`SELECT id, parent_item_id AS parentItemId, order_id AS orderId,
            order_line_id AS orderLineId, depth, node_kind AS nodeKind
       FROM fab_items
      WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL`,
    [companyId, orderIds],
  );
  const itemsById = new Map(items.map((i) => [i.id, i]));

  const [rows] = await cachedQuery(`SELECT DISTINCT e.id AS entryId, t.item_id AS itemId
       FROM fab_plan_entries e
       JOIN fab_plan_entry_tasks et ON et.plan_entry_id = e.id AND et.company_id = e.company_id
                                   AND et.deleted_at IS NULL
       JOIN fab_project_tasks t ON t.id = et.task_id AND t.deleted_at IS NULL
      WHERE e.company_id = ? AND e.order_id IN (?)
        AND e.status = 'planned' AND e.deleted_at IS NULL`,
    [companyId, orderIds],
  );

  // Memoised per ITEM, not per row: a thousand bars on one order share a few
  // hundred items between them.
  const keyByItem = new Map();
  const entryIds = new Set();
  for (const r of rows) {
    if (r.itemId == null) continue;
    let k = keyByItem.get(r.itemId);
    if (k === undefined) {
      k = groupKeyFor(itemsById, r.itemId, level);
      keyByItem.set(r.itemId, k);
    }
    // A bundle whose members span two units belongs to both, exactly as the
    // board draws it.
    if (k === key) entryIds.add(r.entryId);
  }

  return { entryIds: [...entryIds], level, key, orderIds };
}

/**
 * The cross-check described in the file header.
 *
 * The client's list is not trusted as the answer, but it IS trusted as a
 * witness: every bar it drew inside this unit must be one the server also calls
 * part of it. If not, the two copies of the walk have drifted and the transform
 * is refused rather than applied to a set nobody intended.
 */
export function assertContains(resolvedIds, claimedIds) {
  const have = new Set(resolvedIds.map(Number));
  const missing = [...new Set((claimedIds ?? []).map(Number))].filter((id) => id && !have.has(id));
  if (missing.length === 0) return;
  throw new PlanError(
    'UNIT_MISMATCH',
    'The board and the server disagree about which bars are in this unit, so nothing was moved.',
    { missingEntryIds: missing.slice(0, 20), missingCount: missing.length },
  );
}
