/**
 * planRepairService.js — when a unit moves, what has to move with it.
 *
 * THE GAP THIS FILLS
 * ------------------
 * Moving a unit used to be local: the bars you grabbed went where you put them
 * and the rest of the plan was TOLD about it. "4 bars downstream would start
 * before this finishes" was the whole of the response. A planner pushing a
 * girder back a week then had to find and push every dependent bar by hand,
 * which is not a plan being edited, it is a plan being retyped.
 *
 * MINIMAL-PERTURBATION REPAIR, NOT RE-OPTIMISATION
 * ------------------------------------------------
 * The obvious alternative — re-run the leveller over everything after each move
 * — is both slower and wrong. It rearranges work nobody touched and throws away
 * decisions already made, so the plan a planner spent an hour shaping would
 * dissolve on the next nudge. The rule here is the opposite: NOTHING MOVES
 * UNLESS IT HAS TO.
 *
 * Concretely, a bar downstream of the move is left exactly where it is if it
 * still starts after its predecessors finish. Only bars whose constraint is
 * actually violated are re-placed, and only as far as the first feasible slot.
 * That preserves existing slack instead of collapsing everything leftward.
 *
 * WHAT IT DOES AND DOES NOT DO
 * ----------------------------
 * Does: shift the transitive downstream closure of the moved unit, in
 * topological order, into the earliest slot that respects both the shift
 * calendar and the lane's concurrency.
 *
 * Also does (with `yieldFree`): make independent work step aside where the move
 * put the machine over capacity. Three rules keep that bounded:
 *
 *   ONLY CONGESTION THE MOVE CAUSED. A target has to be an instant where the
 *   lane is over capacity AND a bar the planner moved is sitting in it. The
 *   KEPL plan runs at 170–290% of crewed time everywhere, so a yield that
 *   chased over-capacity in general would try to re-level the whole shop on
 *   every nudge, for congestion nobody just created.
 *
 *   FORWARD ONLY. A displaced bar is re-placed at or after where it already
 *   was, never earlier. That makes the process monotone — every bump strictly
 *   increases a start — so it cannot oscillate, and it never quietly pulls
 *   untouched work earlier.
 *
 *   THE LEAST IMPORTANT ONE YIELDS. Ordered by the order's priority_rank
 *   (unranked last), then its due date, then the later start. Without that,
 *   "something moves" is a coin flip and a rush job gives way to routine work.
 *
 * It cannot invent capacity. On a lane that is already saturated a bump only
 * moves the congestion along, so the loop stops after MAX_YIELD_HOPS and says
 * what it could not clear rather than churning.
 *
 * Also does NOT pull dependents EARLIER when a unit moves left. Moving left
 * cannot create room downstream, and quietly compacting work the planner did not
 * touch is the surprise this whole file exists to avoid. Slack that opens up is
 * theirs to use, via push-left, when they ask for it.
 */

import { pool } from '../../../db.js';
import { createPlacer, loadResourceCapacity } from './resourceLevelingService.js';
import { resolveCapacity } from './capacityService.js';
import { apportionEntry } from './planTaskSpan.js';

/**
 * How many bars one move may shift before the answer stops being useful.
 *
 * A day's slip on the first girder of a bridge legitimately moves a lot of work,
 * so this is generous. It is a guard against a runaway cascade, not a policy on
 * how much a planner is allowed to disturb — past it the transform is refused
 * with the count, rather than half-applied.
 */
export const MAX_CASCADE = 4000;

/**
 * How many bars may be shoved aside for one move.
 *
 * Not a fairness policy — a termination bound. Each bump moves a bar strictly
 * later, so the loop always makes progress, but on a saturated lane "progress"
 * can mean pushing the same congestion down the week for ever. Past this, what
 * is left unresolved is reported instead.
 */
export const MAX_YIELD_HOPS = 200;

/**
 * Overlap below this is rounding, not a precedence problem — see the matching
 * note in planGroupService. Repairing on it would shove bars around to fix
 * something the database cannot represent.
 */
const DAG_TOLERANCE_MS = 1000;

/** Bars whose work has started, or that a human pinned, do not move. Ever. */
function isImmovable(bar) {
  return bar.isPinned || bar.started;
}

// ─── loading the neighbourhood ────────────────────────────────────────────────

/**
 * Every planned bar of the orders involved, with what it needs to be re-placed.
 *
 * Scoped to those orders rather than the whole shop because that is where the
 * DAG can reach: flow edges are per (item, flow) and component edges are
 * resolved within one order, so nothing outside can be downstream of the move.
 * Bars of OTHER orders still matter as occupancy, and are loaded separately.
 */
async function loadOrderBars(companyId, orderIds) {
  if (orderIds.length === 0) return [];
  const [rows] = await pool.query(
    `SELECT e.id, e.resource_type_id AS resourceTypeId, e.resource_id AS resourceId,
            e.planned_start AS plannedStart, e.planned_end AS plannedEnd,
            e.planned_minutes AS plannedMinutes, e.is_pinned AS isPinned,
            e.order_id AS orderId
       FROM fab_plan_entries e
      WHERE e.company_id = ? AND e.order_id IN (?)
        AND e.status = 'planned' AND e.deleted_at IS NULL`,
    [companyId, orderIds],
  );
  if (rows.length === 0) return [];

  const [members] = await pool.query(
    `SELECT et.plan_entry_id AS entryId, et.task_id AS taskId,
            et.planned_minutes AS plannedMinutes,
            et.planned_start AS taskStart, et.planned_end AS taskEnd,
            t.status
       FROM fab_plan_entry_tasks et
       JOIN fab_project_tasks t ON t.id = et.task_id AND t.deleted_at IS NULL
      WHERE et.company_id = ? AND et.plan_entry_id IN (?) AND et.deleted_at IS NULL
      ORDER BY et.plan_entry_id ASC, et.sort_order ASC, et.id ASC`,
    [companyId, rows.map((r) => r.id)],
  );

  const byId = new Map(rows.map((r) => [r.id, {
    ...r,
    isPinned: !!r.isPinned,
    start: new Date(r.plannedStart),
    end: new Date(r.plannedEnd),
    members: [],
    taskIds: [],
    started: false,
  }]));
  for (const m of members) {
    const b = byId.get(m.entryId);
    if (!b) continue;
    b.taskIds.push(Number(m.taskId));
    b.members.push({
      taskId: Number(m.taskId),
      plannedMinutes: m.plannedMinutes,
      plannedStart: m.taskStart,
      plannedEnd: m.taskEnd,
    });
    if (m.status === 'in_progress' || m.status === 'done') b.started = true;
  }
  return [...byId.values()];
}

/** Bars of every OTHER order — occupancy the repair must fit around. */
async function loadForeignBars(companyId, orderIds, from) {
  const params = [companyId, from];
  let excl = '';
  if (orderIds.length > 0) { excl = ' AND (e.order_id IS NULL OR e.order_id NOT IN (?))'; params.push(orderIds); }
  const [rows] = await pool.query(
    `SELECT e.id, e.resource_type_id AS resourceTypeId, e.resource_id AS resourceId,
            e.planned_start AS plannedStart, e.planned_end AS plannedEnd,
            e.planned_minutes AS plannedMinutes
       FROM fab_plan_entries e
      WHERE e.company_id = ? AND e.status = 'planned' AND e.deleted_at IS NULL
        AND e.planned_end > ?${excl}`,
    params,
  );
  return rows.map((r) => ({
    ...r,
    isPinned: true,
    started: true,
    start: new Date(r.plannedStart),
    end: new Date(r.plannedEnd),
    members: [],
    taskIds: [],
  }));
}

// ─── the partition ────────────────────────────────────────────────────────────

/**
 * Collapse the task graph onto bars.
 *
 * Two bars are joined when any task of one precedes any task of the other. A
 * bundle spanning two branches therefore inherits both, which is right: it is
 * one machine setup and cannot start until everything it batches is ready.
 */
function barEdges(bars, preds) {
  const barOfTask = new Map();
  for (const b of bars) for (const t of b.taskIds) barOfTask.set(t, b.id);

  const out = new Map();
  const into = new Map();
  const seen = new Set();
  for (const b of bars) {
    for (const t of b.taskIds) {
      for (const p of preds.get(t) ?? []) {
        const from = barOfTask.get(p);
        if (from == null || from === b.id) continue;
        const k = `${from}->${b.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!out.has(from)) out.set(from, []);
        out.get(from).push(b.id);
        if (!into.has(b.id)) into.set(b.id, []);
        into.get(b.id).push(from);
      }
    }
  }
  return { out, into, barOfTask };
}

/** Everything reachable downstream of the moved bars. Breadth-first, once. */
function downstreamOf(seedIds, out) {
  const seen = new Set(seedIds);
  const queue = [...seedIds];
  const result = [];
  while (queue.length > 0) {
    for (const next of out.get(queue.shift()) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      result.push(next);
      queue.push(next);
    }
  }
  return result;
}

/**
 * Topological order over just the affected bars — Kahn, successors derived by
 * reversing `into`.
 *
 * Edges from OUTSIDE the affected set are ignored here: those bars are already
 * final, so they impose a FLOOR on when a bar may start, not an ordering among
 * the ones being repaired. Ties break on current start then id, so the same move
 * always repairs the same way.
 */
function kahn(ids, into, byId) {
  const inSet = new Set(ids);
  const succ = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const id of ids) {
    for (const p of into.get(id) ?? []) {
      if (!inSet.has(p)) continue;
      succ.get(p).push(id);
      indeg.set(id, indeg.get(id) + 1);
    }
  }
  const cmp = (a, b) => (byId.get(a).start - byId.get(b).start) || (a - b);
  const ready = ids.filter((id) => indeg.get(id) === 0);
  const order = [];
  while (ready.length > 0) {
    ready.sort(cmp);
    const id = ready.shift();
    order.push(id);
    for (const s of succ.get(id)) {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) ready.push(s);
    }
  }
  // A cycle would leave bars unvisited. Append them in a stable order rather
  // than dropping them — they still need a floor applied.
  if (order.length < ids.length) {
    const done = new Set(order);
    for (const id of [...ids].sort(cmp)) if (!done.has(id)) order.push(id);
  }
  return order;
}

// ─── the repair ───────────────────────────────────────────────────────────────

/**
 * Which bar gives way.
 *
 * Lower is yielded first. `priority_rank` is a sequence somebody arranged, so a
 * missing one means nobody said this order matters — it goes first. Due date
 * breaks ties among the unranked, and a later start breaks the rest, because
 * moving something that is already late is less disruptive than moving the work
 * about to start.
 */
function yieldOrder(bar, orderMeta) {
  const meta = orderMeta.get(bar.orderId) ?? {};
  const rank = Number.isFinite(meta.priorityRank) ? meta.priorityRank : Number.POSITIVE_INFINITY;
  const due = meta.due ? new Date(meta.due).getTime() : Number.POSITIVE_INFINITY;
  return [-rank, -due, bar.start.getTime(), bar.id];
}

function worseThan(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * The first instant on this lane where the plan is over capacity AND one of the
 * bars the planner moved is in it.
 *
 * The second half is what stops a yield from becoming a re-level: congestion
 * that was already there and that the move did not touch is somebody else's
 * problem, and not one a drag should silently rearrange the shop to solve.
 */
function firstCausedOverload(entriesOnLane, capacity, ours) {
  const events = [];
  for (const b of entriesOnLane) {
    events.push([b.start, 1, b], [b.end, -1, b]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const live = new Set();
  for (const [at, delta, bar] of events) {
    if (delta === 1) live.add(bar); else live.delete(bar);
    if (live.size <= capacity) continue;
    let mine = false;
    for (const b of live) if (ours.has(b.id)) { mine = true; break; }
    if (mine) return { at, live: [...live] };
  }
  return null;
}

/** Where each of a bar's tasks runs, given where the bar is. */
function taskSpansOf(bar, start, end) {
  const os = bar.start.getTime();
  const oe = bar.end.getTime();
  const ns = start.getTime();
  const scale = oe > os ? (end.getTime() - ns) / (oe - os) : 1;
  const moved = bar.members.map((m) => {
    if (m.plannedStart == null || m.plannedEnd == null) return m;
    const map = (t) => new Date(Math.round(ns + (new Date(t).getTime() - os) * scale));
    return { ...m, plannedStart: map(m.plannedStart), plannedEnd: map(m.plannedEnd) };
  });
  return apportionEntry(start, end, moved);
}

/**
 * Shift everything downstream of a move, as little as possible.
 *
 * @param {number} companyId
 * @param {object} args
 * @param {Map<number,{start:Date,end:Date,held?:boolean}>} args.proposed where the
 *        moved unit is going. These are authoritative and are never re-placed —
 *        the planner said so.
 * @param {Map<number,number[]>} args.preds task id → predecessor task ids
 * @param {number[]} args.orderIds orders the move touches
 * @param {boolean} [args.yieldFree] also step independent work aside where the
 *        move put a machine over capacity. See the file header for the three
 *        rules that keep it bounded.
 * @returns {Promise<{placements:Map<number,{start:Date,end:Date}>, cascaded:number,
 *                    yielded:number, unresolved:number, examined:number, capped:boolean}>}
 */
export async function cascadeRepair(companyId, { proposed, preds, orderIds, yieldFree = false }) {
  const movedIds = [...proposed.keys()];
  const orderBars = await loadOrderBars(companyId, orderIds);
  const byId = new Map(orderBars.map((b) => [b.id, b]));

  const { out, into } = barEdges(orderBars, preds);
  const affected = downstreamOf(movedIds, out).filter((id) => {
    const b = byId.get(id);
    return b && !isImmovable(b);
  });

  // No early exit when nothing is downstream: a move can congest a machine
  // without having a single dependant, and that is exactly what yielding is for.
  if (affected.length === 0 && !yieldFree) {
    return { placements: new Map(), cascaded: 0, yielded: 0, unresolved: 0, examined: 0, capped: false };
  }
  if (affected.length > MAX_CASCADE) {
    return {
      placements: new Map(), cascaded: 0, yielded: 0, unresolved: 0,
      examined: affected.length, capped: true,
    };
  }

  // ── seed the shop ──────────────────────────────────────────────────────────
  const earliestMoved = new Date(Math.min(...[...proposed.values()].map((p) => p.start.getTime())));
  const foreign = await loadForeignBars(companyId, orderIds, earliestMoved);
  const capacity = await loadResourceCapacity(companyId);
  const placer = createPlacer(companyId, capacity);

  const capCache = new Map();
  const capFor = async (bar) => {
    const k = `${bar.resourceId ?? ''}|${bar.resourceTypeId ?? ''}`;
    if (!capCache.has(k)) {
      capCache.set(k, await resolveCapacity(companyId, {
        assigned_resource_id: bar.resourceId ?? null,
        resource_type_id: bar.resourceTypeId ?? null,
      }));
    }
    return capCache.get(k);
  };

  /**
   * Occupancy is booked as the bar's WALL-CLOCK span, not its working intervals.
   *
   * The two differ across a night: a four-hour bar spanning a shift break holds
   * the machine from when it starts to when it ends, and nobody else can use it
   * in the gap. Booking only the working slices would offer that gap to another
   * bar and produce a plan the floor cannot run.
   */
  const bookedAt = new Map();
  const book = (bar, start, end) => {
    const { key } = placer.contextFor({
      assigned_resource_id: bar.resourceId ?? null,
      resource_type_id: bar.resourceTypeId ?? null,
    });
    if (key == null) return;
    const iv = { start: new Date(start), end: new Date(end) };
    placer.book(key, [iv]);
    bookedAt.set(bar.id, { key, iv });
  };
  const unbook = (barId) => {
    const at = bookedAt.get(barId);
    if (!at) return;
    placer.unbook(at.key, [at.iv]);
    bookedAt.delete(barId);
  };

  for (const b of foreign) book(b, b.start, b.end);
  for (const b of orderBars) {
    const place = proposed.get(b.id);
    if (place) { book(b, place.start, place.end); continue; }
    book(b, b.start, b.end);
  }

  // ── where every task finishes, as things now stand ─────────────────────────
  const taskEnd = new Map();
  const recordTaskEnds = (bar, start, end) => {
    for (const [taskId, span] of taskSpansOf(bar, start, end)) taskEnd.set(taskId, span.end);
  };
  for (const b of orderBars) {
    const place = proposed.get(b.id);
    recordTaskEnds(b, place ? place.start : b.start, place ? place.end : b.end);
  }

  // ── where everything currently sits, as this run has it ────────────────────
  const placements = new Map();
  const posOf = (bar) => placements.get(bar.id) ?? proposed.get(bar.id) ?? { start: bar.start, end: bar.end };

  /** Re-place one bar at or after `notBefore`, keeping the books straight. */
  const replaceBar = async (bar, notBefore) => {
    unbook(bar.id);
    const capSrc = await capFor(bar);
    const { key, capacity: units } = placer.contextFor({
      assigned_resource_id: bar.resourceId ?? null,
      resource_type_id: bar.resourceTypeId ?? null,
    });
    const span = await placer.place(capSrc, key, units, notBefore, Number(bar.plannedMinutes) || 0);
    book(bar, span.start, span.end);
    placements.set(bar.id, { start: span.start, end: span.end });
    recordTaskEnds(bar, span.start, span.end);
    return span;
  };

  /**
   * Push a set of bars back behind their predecessors, in topological order.
   *
   * Returns the ones that actually had to move. Reusable because a yield can
   * break precedence too: the bar that stepped aside may now finish after
   * something that was waiting on it.
   */
  const repairPrecedence = async (ids) => {
    const movedNow = [];
    for (const id of kahn(ids, into, byId)) {
      const bar = byId.get(id);
      if (!bar || isImmovable(bar)) continue;

      let floor = null;
      for (const t of bar.taskIds) {
        for (const pred of preds.get(t) ?? []) {
          if (bar.taskIds.includes(pred)) continue;
          const end = taskEnd.get(pred);
          if (end && (floor === null || end > floor)) floor = end;
        }
      }
      const at = posOf(bar);
      if (!floor || at.start.getTime() + DAG_TOLERANCE_MS >= floor.getTime()) {
        // Still legal where it is. Leaving it is the whole point.
        recordTaskEnds(bar, at.start, at.end);
        continue;
      }
      await replaceBar(bar, floor);
      movedNow.push(id);
    }
    return movedNow;
  };

  let cascaded = (await repairPrecedence(affected)).length;

  // ── make room, where the move is what filled it ────────────────────────────
  let yielded = 0;
  let unresolved = 0;
  if (yieldFree) {
    const orderMeta = await loadOrderMeta(companyId, orderIds);
    const ours = new Set([...proposed.keys(), ...placements.keys()]);
    const movable = new Map(orderBars.filter((b) => !isImmovable(b)).map((b) => [b.id, b]));
    const bumped = new Set();

    for (let hop = 0; hop < MAX_YIELD_HOPS; hop += 1) {
      // Group what is booked, by lane, at its current position.
      const lanes = new Map();
      for (const [barId, at] of bookedAt) {
        if (!lanes.has(at.key)) lanes.set(at.key, []);
        lanes.get(at.key).push({ id: barId, start: at.iv.start, end: at.iv.end });
      }

      let acted = false;
      for (const [key, onLane] of lanes) {
        const sample = movable.get(onLane[0].id) ?? byId.get(onLane[0].id)
          ?? foreign.find((f) => f.id === onLane[0].id);
        if (!sample) continue;
        const { capacity: units } = placer.contextFor({
          assigned_resource_id: sample.resourceId ?? null,
          resource_type_id: sample.resourceTypeId ?? null,
        });
        if (!(units < Infinity)) continue;

        const hit = firstCausedOverload(onLane, units, ours);
        if (!hit) continue;

        // The least important bar in the jam that is not the planner's own, has
        // not already stepped aside once, and is allowed to move at all.
        let victim = null;
        let victimKey = null;
        for (const entry of hit.live) {
          if (ours.has(entry.id) || bumped.has(entry.id)) continue;
          const bar = movable.get(entry.id);
          if (!bar) continue;
          const k = yieldOrder({ ...bar, start: entry.start }, orderMeta);
          if (victim === null || worseThan(k, victimKey)) { victim = bar; victimKey = k; }
        }
        if (!victim) { unresolved += 1; continue; }

        // Forward only: at or after where it already was, never earlier.
        await replaceBar(victim, new Date(Math.max(hit.at.getTime(), posOf(victim).start.getTime())));
        bumped.add(victim.id);
        yielded += 1;
        acted = true;

        // Stepping aside can strand what was waiting on it.
        const after = downstreamOf([victim.id], out).filter((id) => {
          const b = byId.get(id);
          return b && !isImmovable(b);
        });
        if (after.length > 0) cascaded += (await repairPrecedence(after)).length;
        void key;
        break;
      }
      if (!acted) break;
    }
  }

  return {
    placements, cascaded, yielded, unresolved, examined: affected.length, capped: false,
  };
}

/** priority_rank and due date per order — who yields to whom. */
async function loadOrderMeta(companyId, orderIds) {
  const out = new Map();
  if (orderIds.length === 0) return out;
  const [rows] = await pool.query(
    `SELECT id, priority_rank AS priorityRank,
            COALESCE(must_finish_by, required_date) AS due
       FROM fab_orders WHERE company_id = ? AND id IN (?)`,
    [companyId, orderIds],
  );
  for (const r of rows) {
    out.set(r.id, {
      priorityRank: r.priorityRank == null ? null : Number(r.priorityRank),
      due: r.due,
    });
  }
  return out;
}
