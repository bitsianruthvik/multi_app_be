/**
 * positionCards.js — which positions are drawn together as one CARD.
 *
 * A position is one chair (services/seatCount.js). Seven helpers under one
 * in-charge are seven positions, and nobody wants seven boxes: the chart draws
 * them as one card with seven rows. This file is the ONE definition of what a
 * card is, so the chart, the employee's slice, "add another position like this
 * one" and "close this position" all mean the same thing by it.
 *
 * THE RULE. Two positions are in the same card when they have
 *   - the same role,
 *   - the same department, and
 *   - PRIMARY_MANAGER positions that are themselves in one card
 *     (or neither has a primary manager — the tops of the chart).
 * `cardId` is the lowest position id in the card.
 *
 * Why the manager is part of it: "Helper 1" in Stores exists three times under
 * three different supervisors — three teams, three cards. `P124-1 … P124-7`
 * report to `P024-1` (day) and `P024-2` (night), which are one card — so the
 * seven are one card, and their team reports to the card, not to a shift.
 *
 * It is computed TOP-DOWN from the roots, a level at a time, so a manager's
 * card is known before its reports are grouped. All members of a card are at
 * the same depth by construction. A position caught in a reporting loop is
 * never reached from a root; it becomes a card of its own rather than hanging
 * the walk or disappearing.
 *
 * Pure. No database, no dates: the caller decides which positions and which
 * edges are live and hands them in.
 */
import { LIVE_ON, dateText, today } from './positionService.js';

const PRIMARY_MANAGER = 'PRIMARY_MANAGER';

/**
 * @param {Array<{id:number, roleId:number|null, departmentId:number|null}>} positions the positions being drawn
 * @param {Map<number, number>} primaryParentOf position id -> its primary manager's position id.
 *        A parent that is not in `positions` (closed, deleted) counts as no parent.
 * @returns {Map<number, number>} position id -> cardId
 */
export function computeCards(positions, primaryParentOf) {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const parentOf = (id) => {
    const parent = primaryParentOf.get(id);
    return parent != null && parent !== id && byId.has(parent) ? parent : null;
  };
  const childrenOf = new Map();
  const roots = [];
  for (const p of positions) {
    const parent = parentOf(p.id);
    if (parent == null) { roots.push(p); continue; }
    const list = childrenOf.get(parent) ?? [];
    list.push(p);
    childrenOf.set(parent, list);
  }

  const cardOf = new Map();
  const place = (level, managerCardOf) => {
    const groups = new Map();
    for (const p of level) {
      const key = `${managerCardOf(p)}|${p.roleId ?? 0}|${p.departmentId ?? 0}`;
      const list = groups.get(key) ?? [];
      list.push(p);
      groups.set(key, list);
    }
    for (const members of groups.values()) {
      const cardId = Math.min(...members.map((m) => m.id));
      for (const m of members) cardOf.set(m.id, cardId);
    }
  };

  let level = roots;
  place(level, () => 0);
  // Each pass handles one depth; the bound is a guard against bad data, not a limit anyone reaches.
  for (let depth = 0; level.length && depth < 1000; depth += 1) {
    const next = [];
    for (const p of level) for (const child of childrenOf.get(p.id) ?? []) if (!cardOf.has(child.id)) next.push(child);
    place(next, (p) => cardOf.get(parentOf(p.id)));
    level = next;
  }
  // In a loop: never reached from a root.
  for (const p of positions) if (!cardOf.has(p.id)) cardOf.set(p.id, p.id);
  return cardOf;
}

/** cardId -> its position ids, lowest first. */
export function cardMembers(cardOf) {
  const members = new Map();
  for (const [id, cardId] of cardOf) {
    const list = members.get(cardId) ?? [];
    list.push(id);
    members.set(cardId, list);
  }
  for (const list of members.values()) list.sort((a, b) => a - b);
  return members;
}

/**
 * The cards of a company on a date, for a caller that does not already hold
 * the chart: two company-wide reads, whatever the size. Positions the chart
 * does not draw (CLOSED, not in date) are in no card.
 *
 * @returns {{ cardOf: Map<number, number>, members: Map<number, number[]>,
 *             positions: Map<number, {id, roleId, departmentId, shiftId, code}>, primaryParentOf: Map<number, number> }}
 */
export async function loadCards(db, companyId, on) {
  const asOf = dateText(on) || today();
  const [[positionRows], [edgeRows]] = await Promise.all([
    db.query(
      `SELECT p.id, p.role_id, p.department_id, p.default_shift_id, p.position_code
         FROM hrms_positions p
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED' AND ${LIVE_ON('p')}`,
      [companyId, asOf, asOf],
    ),
    db.query(
      `SELECT rr.from_position_id, rr.to_position_id
         FROM hrms_position_reporting_relationships rr
         JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
        WHERE rr.company_id = ? AND rr.deleted_at IS NULL AND t.code = '${PRIMARY_MANAGER}' AND ${LIVE_ON('rr')}
        ORDER BY rr.is_primary DESC, rr.id`,
      [companyId, asOf, asOf],
    ),
  ]);
  const positions = new Map(positionRows.map((p) => [p.id, {
    id: p.id, roleId: p.role_id, departmentId: p.department_id, shiftId: p.default_shift_id, code: p.position_code ?? null,
  }]));
  const primaryParentOf = new Map();
  for (const e of edgeRows) if (!primaryParentOf.has(e.from_position_id)) primaryParentOf.set(e.from_position_id, e.to_position_id);
  const cardOf = computeCards([...positions.values()], primaryParentOf);
  return { cardOf, members: cardMembers(cardOf), positions, primaryParentOf };
}

/**
 * The chair of a card a line should point at, by the migration's rule
 * (scripts/one-chair-positions.mjs): the chair on the SAME SHIFT when the card
 * has one, else `fallback`. Lowest id wins among several on that shift.
 */
export function chairOnShift(memberIds, shiftOf, shiftId, fallback) {
  const hit = shiftId == null ? null : memberIds.find((id) => shiftOf(id) === shiftId);
  return hit ?? fallback;
}
