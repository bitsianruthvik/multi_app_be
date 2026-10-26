/**
 * unitReporting.js — reporting that follows the org unit tree (TM/CF_HRMS_HIRING_SPEC.md §40).
 * PURE: no database. services/reportingResolver.js loads the rows (a fixed number of
 * company-wide queries) and every caller asks this model.
 *
 * ── THE ORDER (§40.3) ──────────────────────────────────────────────────────
 * A position's primary manager — a CHAIR — is, in order:
 *   1. EXPLICIT      its own live PRIMARY_MANAGER line (the general one first, as the leave
 *                    approver always read it). Unchanged by anything here.
 *   2. UNIT_HEAD     else the head of its own unit: the head on the position's shift when the
 *                    unit has a head per shift, else the unit's one head (shift none). A unit
 *                    with heads for D and N only has no head for a G position: step 3.
 *   3. REPORTS_INTO  for a head of its own unit (or when the unit has no head for it): the
 *                    unit's Reports into —
 *                      CHOSEN  the stored position (a closed or removed one is ignored);
 *                      DEFAULT the parent unit's head (same shift rule), or when the parent has
 *                              none, the PARENT's Reports into, and so on up. A top unit with
 *                              DEFAULT has none: its head is the top of the organisation.
 *                    A position never reports to itself: a head that also heads the unit above
 *                    goes on up.
 *   4. WALKED_UP     the PERSON: when the chair from 1–3 is vacant (or closed), walk up the
 *                    same order from that chair until a chair with somebody in it.
 * Dotted and every other relationship type are explicit rows and never come through here.
 *
 * ── IN THE TREE ────────────────────────────────────────────────────────────
 * A manager is "in the tree" of a position when the manager's unit is the position's unit or a
 * unit above it, or the manager heads one of those. A primary line outside it is "cross-tree":
 * allowed, drawn dashed, and listed by the consistency check until it carries a reason.
 *
 * ── INPUT ──────────────────────────────────────────────────────────────────
 *   positions: [{ id, code, title, departmentId, shiftId, live, occupied, occupantName }]
 *              every position that a line can name (live = drawn on the chart today)
 *   units:     [{ id, name, type, parentId, reportsIntoPositionId, reportsIntoMode, reportsIntoReason }]
 *   heads:     [{ id, unitId, positionId, shiftId }]               live rows
 *   explicit:  [{ id, fromPositionId, toPositionId, scopeType, crossTreeReason }]
 *              live PRIMARY_MANAGER lines, in the chart's order (is_primary DESC, sort_order, id)
 */

const MAX_HOPS = 200;

export function buildReportingModel({ positions = [], units = [], heads = [], explicit = [] } = {}) {
  const pos = new Map(positions.map((p) => [Number(p.id), p]));
  const unit = new Map(units.map((u) => [Number(u.id), u]));
  const livePos = (id) => id != null && Boolean(pos.get(Number(id))?.live);

  // The explicit line of each position: the general one first, else the first in the chart's order.
  const explicitOf = new Map();
  for (const e of explicit) {
    const from = Number(e.fromPositionId);
    const have = explicitOf.get(from);
    if (!have || (have.scopeType !== 'GENERAL' && e.scopeType === 'GENERAL')) explicitOf.set(from, e);
  }
  const explicitCount = new Map();
  for (const e of explicit) explicitCount.set(Number(e.fromPositionId), (explicitCount.get(Number(e.fromPositionId)) ?? 0) + 1);

  // Heads per unit (only heads whose chair is live count).
  const headsOf = new Map();
  for (const h of heads) {
    const u = Number(h.unitId);
    if (!headsOf.has(u)) headsOf.set(u, []);
    headsOf.get(u).push({ ...h, unitId: u, positionId: Number(h.positionId), shiftId: h.shiftId == null ? null : Number(h.shiftId) });
  }
  const liveHeadsOf = (unitId) => (headsOf.get(Number(unitId)) ?? []).filter((h) => livePos(h.positionId));
  const headUnitsOf = new Map();
  for (const [u, list] of headsOf) {
    for (const h of list) {
      if (!livePos(h.positionId)) continue;
      if (!headUnitsOf.has(h.positionId)) headUnitsOf.set(h.positionId, new Set());
      headUnitsOf.get(h.positionId).add(u);
    }
  }
  const perShift = (unitId) => liveHeadsOf(unitId).some((h) => h.shiftId != null);

  /** The head of a unit for a shift: the head on that shift, else the unit's one head. Null when none. */
  function headFor(unitId, shiftId) {
    const list = liveHeadsOf(unitId);
    if (!list.length) return null;
    const s = shiftId == null ? null : Number(shiftId);
    return (s != null ? list.find((h) => h.shiftId === s) : null)?.positionId
      ?? list.find((h) => h.shiftId == null)?.positionId
      ?? null;
  }

  /** The unit and every unit above it, nearest first. Guarded against a loop in old data. */
  function ancestry(unitId) {
    const out = [];
    const seen = new Set();
    let cur = unitId == null ? null : unit.get(Number(unitId));
    while (cur && !seen.has(cur.id) && out.length < MAX_HOPS) {
      seen.add(cur.id);
      out.push(cur);
      cur = cur.parentId != null ? unit.get(Number(cur.parentId)) : null;
    }
    return out;
  }

  /**
   * A unit's Reports into for a shift, never `selfId`:
   *   { positionId, unitId (whose setting it is), fromUnitId (whose head it is, DEFAULT), chosen, reason }
   */
  function reportsIntoFor(unitId, shiftId, selfId = null) {
    const chain = ancestry(unitId);
    for (let i = 0; i < chain.length; i += 1) {
      const u = chain[i];
      if (u.reportsIntoMode === 'CHOSEN' && livePos(u.reportsIntoPositionId) && Number(u.reportsIntoPositionId) !== Number(selfId)) {
        return { positionId: Number(u.reportsIntoPositionId), unitId: chain[0].id, settingUnitId: u.id, fromUnitId: null, chosen: true, reason: u.reportsIntoReason ?? null };
      }
      const parent = chain[i + 1];
      if (!parent) return null;
      const h = headFor(parent.id, shiftId);
      if (h != null && h !== Number(selfId)) return { positionId: h, unitId: chain[0].id, settingUnitId: u.id, fromUnitId: parent.id, chosen: false, reason: null };
      // The parent has no head (for this shift): the parent's own Reports into decides.
    }
    return null;
  }

  /** The DEFAULT target of a unit (what it reports into when nothing is chosen). */
  function defaultReportsInto(unitId, shiftId = null, selfId = null) {
    const chain = ancestry(unitId);
    for (let i = 1; i < chain.length; i += 1) {
      const h = headFor(chain[i].id, shiftId);
      if (h != null && h !== Number(selfId)) return { positionId: h, fromUnitId: chain[i].id };
      const u = chain[i];
      if (u.reportsIntoMode === 'CHOSEN' && livePos(u.reportsIntoPositionId) && Number(u.reportsIntoPositionId) !== Number(selfId)) {
        return { positionId: Number(u.reportsIntoPositionId), fromUnitId: null, viaUnitId: u.id };
      }
    }
    return null;
  }

  const isHeadOf = (positionId, unitId) => liveHeadsOf(unitId).some((h) => h.positionId === Number(positionId));

  /**
   * One step up from a chair: { managerId, source, edgeId?, unitId?, chosen?, reason?, crossTreeReason? } or null.
   */
  function step(positionId) {
    const id = Number(positionId);
    const ex = explicitOf.get(id);
    if (ex) {
      return { managerId: Number(ex.toPositionId), source: 'EXPLICIT', edgeId: ex.id, crossTreeReason: ex.crossTreeReason ?? null };
    }
    const p = pos.get(id);
    if (!p || p.departmentId == null || !unit.has(Number(p.departmentId))) return null;
    const unitId = Number(p.departmentId);
    if (!isHeadOf(id, unitId)) {
      const h = headFor(unitId, p.shiftId);
      if (h != null && h !== id) return { managerId: h, source: 'UNIT_HEAD', unitId };
    }
    const ri = reportsIntoFor(unitId, p.shiftId, id);
    if (ri) return { managerId: ri.positionId, source: 'REPORTS_INTO', unitId, settingUnitId: ri.settingUnitId, fromUnitId: ri.fromUnitId, chosen: ri.chosen, reason: ri.reason };
    return null;
  }

  /** The chain of chairs above a position, nearest first; `loop` true when it comes back on itself. */
  function chain(positionId) {
    const steps = [];
    const seen = new Set([Number(positionId)]);
    let cur = Number(positionId);
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const s = step(cur);
      if (!s) return { steps, loop: false };
      steps.push({ positionId: cur, ...s });
      if (seen.has(s.managerId)) return { steps, loop: true, loopAt: s.managerId };
      seen.add(s.managerId);
      cur = s.managerId;
    }
    return { steps, loop: true, loopAt: cur };
  }

  /**
   * The manager as a PERSON's chair: the first chair up the order with somebody in it.
   * { positionId | null, source, firstPositionId, firstSource, through: [vacant chairs passed], edgeId? }
   */
  function manager(positionId) {
    const first = step(positionId);
    if (!first) return { positionId: null, source: null, firstPositionId: null, firstSource: null, through: [] };
    const through = [];
    const seen = new Set([Number(positionId)]);
    let cur = first.managerId;
    while (cur != null && !pos.get(cur)?.occupied) {
      if (seen.has(cur) || through.length > MAX_HOPS) { cur = null; break; }
      seen.add(cur);
      through.push(cur);
      cur = step(cur)?.managerId ?? null;
    }
    return {
      positionId: cur,
      source: through.length ? 'WALKED_UP' : first.source,
      firstPositionId: first.managerId,
      firstSource: first.source,
      through,
      edgeId: first.edgeId ?? null,
    };
  }

  /** Units in a position's tree: its unit and every unit above. */
  const treeUnitsOf = (positionId) => {
    const p = pos.get(Number(positionId));
    return p?.departmentId == null ? null : new Set(ancestry(p.departmentId).map((u) => u.id));
  };

  /** Is `managerId` in the tree of `positionId`? (No unit on the position: nothing to judge — true.) */
  function inTree(positionId, managerId) {
    const units = treeUnitsOf(positionId);
    if (!units) return true;
    const m = pos.get(Number(managerId));
    if (m?.departmentId != null && units.has(Number(m.departmentId))) return true;
    for (const u of headUnitsOf.get(Number(managerId)) ?? []) if (units.has(u)) return true;
    return false;
  }

  /** For a unit's CHOSEN Reports into: the parent unit and the units above it (or a head of one of them). */
  function inTreeAbove(unitId, managerId) {
    const above = new Set(ancestry(unitId).slice(1).map((u) => u.id));
    const m = pos.get(Number(managerId));
    if (m?.departmentId != null && above.has(Number(m.departmentId))) return true;
    for (const u of headUnitsOf.get(Number(managerId)) ?? []) if (above.has(u)) return true;
    return false;
  }

  /** The unit and every unit under it. */
  function subtree(unitId) {
    const kids = new Map();
    for (const u of units) if (u.parentId != null) kids.set(Number(u.parentId), [...(kids.get(Number(u.parentId)) ?? []), Number(u.id)]);
    const out = new Set();
    const stack = [Number(unitId)];
    while (stack.length) { const x = stack.pop(); if (out.has(x)) continue; out.add(x); stack.push(...(kids.get(x) ?? [])); }
    return out;
  }

  /** Every PRIMARY line as the chart draws it: explicit ones are already rows; these are the derived ones. */
  function derivedLines() {
    const out = [];
    for (const p of positions) {
      if (!p.live || explicitOf.has(Number(p.id))) continue;
      const s = step(p.id);
      if (s) out.push({ fromPositionId: Number(p.id), toPositionId: s.managerId, ...s });
    }
    return out;
  }

  return {
    positions: pos, units: unit, livePos, explicitOf, explicitCount, headsOf: liveHeadsOf, allHeadsOf: (u) => headsOf.get(Number(u)) ?? [],
    headUnitsOf: (id) => [...(headUnitsOf.get(Number(id)) ?? [])], perShift, headFor, ancestry, reportsIntoFor, defaultReportsInto,
    isHeadOf, step, chain, manager, inTree, inTreeAbove, subtree, derivedLines,
  };
}

/* ── the consistency check (§40.5), pure ─────────────────────────────────── */

/**
 * Findings over a model: [{ key, kind, … ids }]. The service names and words them.
 *   CROSS_TREE (line)  a live position's explicit primary line whose manager is outside its tree, no reason
 *   CROSS_TREE (unit)  a unit's CHOSEN Reports into outside the parent and the units above, no reason
 *   UNIT_NO_HEAD       a unit with live positions in it or under it, no head and nothing to report into
 *   NO_MANAGER         a live position whose order gives nobody — except the head of a top unit (the top)
 *   LOOP               chairs whose managers come back round to themselves
 */
export function findInconsistencies(model) {
  const out = [];
  const livePositions = [...model.positions.values()].filter((p) => p.live);

  for (const p of livePositions) {
    const ex = model.explicitOf.get(Number(p.id));
    if (ex && !ex.crossTreeReason && model.positions.has(Number(ex.toPositionId)) && !model.inTree(p.id, ex.toPositionId)) {
      out.push({ key: `CROSS_TREE:E:${ex.id}`, kind: 'CROSS_TREE', positionId: Number(p.id), managerId: Number(ex.toPositionId), edgeId: ex.id });
    }
  }
  for (const u of model.units.values()) {
    if (u.reportsIntoMode === 'CHOSEN' && u.reportsIntoPositionId != null && !u.reportsIntoReason
      && model.livePos(u.reportsIntoPositionId) && !model.inTreeAbove(u.id, u.reportsIntoPositionId)) {
      out.push({ key: `CROSS_TREE:U:${u.id}`, kind: 'CROSS_TREE', unitId: Number(u.id), managerId: Number(u.reportsIntoPositionId) });
    }
  }

  const unitHasPositions = new Map();
  for (const p of livePositions) if (p.departmentId != null) for (const a of model.ancestry(p.departmentId)) unitHasPositions.set(a.id, true);
  for (const u of model.units.values()) {
    if (!unitHasPositions.get(u.id)) continue;
    if (model.headsOf(u.id).length) continue;
    if (model.reportsIntoFor(u.id, null, null)) continue;
    out.push({ key: `UNIT_NO_HEAD:${u.id}`, kind: 'UNIT_NO_HEAD', unitId: Number(u.id) });
  }

  for (const p of livePositions) {
    if (model.step(p.id)) continue;
    const u = p.departmentId != null ? model.units.get(Number(p.departmentId)) : null;
    const isTop = u && u.parentId == null && model.isHeadOf(p.id, u.id);
    if (isTop) continue;
    out.push({ key: `NO_MANAGER:${p.id}`, kind: 'NO_MANAGER', positionId: Number(p.id) });
  }

  const loops = new Map();
  for (const p of livePositions) {
    const c = model.chain(p.id);
    if (!c.loop) continue;
    // The loop itself: from where it comes back round.
    const at = c.loopAt;
    const i = c.steps.findIndex((s) => s.positionId === at);
    const ring = (i >= 0 ? c.steps.slice(i) : c.steps).map((s) => s.positionId);
    if (!ring.length) continue;
    const key = `LOOP:${Math.min(...ring)}`;
    if (!loops.has(key)) loops.set(key, { key, kind: 'LOOP', positions: ring, steps: i >= 0 ? c.steps.slice(i) : c.steps });
  }
  out.push(...loops.values());
  return out;
}

export default { buildReportingModel, findInconsistencies };
