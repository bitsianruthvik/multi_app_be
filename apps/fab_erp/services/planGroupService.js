/**
 * planGroupService.js — moving a unit of work, not a bar.
 *
 * A planner does not move an operation. They move a girder: fifty bars across
 * three machines that have to keep their shape relative to each other. Doing
 * that through `updateEntry` one bar at a time does not work and cannot be made
 * to work — every intermediate state is illegal, so the first call is refused
 * for a violation the finished move would not have had.
 *
 * So this validates the FINAL state and writes it in one transaction. Nothing is
 * applied unless the whole move is legal.
 *
 * THE FOUR THINGS A PLANNER DOES
 * ------------------------------
 *   move       shift the unit by a delta. Its internal shape is untouched.
 *   stretch    scale the OFFSETS from an anchored end; each bar keeps its own
 *              duration. This is how gaps are made — the work does not get
 *              slower, it gets spread out, and the holes it opens are what the
 *              next unit is pushed into.
 *   pushLeft   the opposite, and not a delta at all: re-level this unit against
 *              the rest of the plan held fixed, so each bar slides left into
 *              whatever gap it can actually reach. A rigid shift cannot do this
 *              — the first bar that hits something would stop the other forty
 *              nine, which is exactly the case the planner is trying to solve.
 *   restore    put a named set of placements back. This is undo, and it is an
 *              explicit op rather than an inverse-delta because a stretch has no
 *              exact inverse in integer milliseconds.
 *
 * WHAT REFUSES AND WHAT ONLY WARNS
 * --------------------------------
 * REFUSES: a bar in the moving set that would start before a predecessor
 * OUTSIDE the set finishes, or whose predecessor is not planned at all. That is
 * the existing manual-placement contract (planService.assertDagAllows) applied
 * to a set, and it is the one thing that makes a plan impossible rather than
 * merely bad.
 *
 * WARNS: over-allocated lanes (a locked decision of this planner — over-
 * allocation warns, never blocks), work landing outside crewed hours, and
 * successors left outside the set that now start too early. That last one is a
 * warning rather than a refusal on purpose: pushing a girder later would
 * otherwise be impossible until everything downstream had been moved first,
 * which makes the single most common response to bad news unavailable.
 *
 * NOTHING IS AUTO-PINNED. `createEntry` pins on creation because a human put the
 * bar somewhere; a move does not, because the workflow is move → push → stretch
 * → push again, and pinning at step one makes step two a no-op.
 */

import { pool } from '../../../db.js';
import { levelSchedule, buildEdges, loadResourceCapacity } from './resourceLevelingService.js';
import { taskMinutes } from './taskDuration.js';
import { resolveCapacityForResource, capacityIntervals, isUnbounded } from './capacityService.js';
import { zonedYMD } from './plantTime.js';
import { PlanError, plannerTimezone } from './planService.js';
import { apportionEntry, taskPlannedSpans } from './planTaskSpan.js';

export const GROUP_OPS = ['move', 'stretch', 'pushLeft', 'restore'];

/** MySQL DATETIME, UTC. */
function toDateTimeStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * How far ahead the calendar is consulted when checking whether a placement
 * lands on crewed time. A move that throws work a year out is a mistake worth
 * reporting, but not one worth a year of calendar queries to describe.
 */
const CALENDAR_CHECK_DAYS = 120;

// ─── loading ──────────────────────────────────────────────────────────────────

async function loadEntries(companyId, entryIds) {
  const [rows] = await pool.query(
    `SELECT e.id, e.resource_type_id AS resourceTypeId, e.resource_id AS resourceId,
            e.planned_start AS plannedStart, e.planned_end AS plannedEnd,
            e.planned_minutes AS plannedMinutes, e.is_pinned AS isPinned,
            e.order_id AS orderId, e.label
       FROM fab_plan_entries e
      WHERE e.company_id = ? AND e.id IN (?) AND e.status = 'planned' AND e.deleted_at IS NULL`,
    [companyId, entryIds],
  );
  if (rows.length === 0) {
    throw new PlanError('ENTRY_NOT_FOUND', 'None of those bars are on the plan any more.');
  }

  const [members] = await pool.query(
    `SELECT et.plan_entry_id AS entryId, et.task_id AS taskId,
            et.planned_minutes AS plannedMinutes, t.status
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
    taskIds: [],
    /** In run order, with minutes — enough to place each task inside the bar. */
    members: [],
    // A bar whose work has started is not a bar any more, it is a fact. It stays
    // where it is and everything else moves around it.
    started: false,
  }]));
  for (const m of members) {
    const e = byId.get(m.entryId);
    if (!e) continue;
    e.taskIds.push(Number(m.taskId));
    e.members.push({ taskId: Number(m.taskId), plannedMinutes: m.plannedMinutes });
    if (m.status === 'in_progress' || m.status === 'done') e.started = true;
  }
  return [...byId.values()].sort((a, b) => a.start - b.start || a.id - b.id);
}

/**
 * Predecessors and successors for a set of tasks, resolved over their WHOLE
 * orders — a predecessor outside the selection is precisely what has to be
 * found, so narrowing the edge build to the selection would answer the wrong
 * question. Mirrors planService.assertDagAllows.
 */
async function loadDag(companyId, taskIds) {
  const [orderRows] = await pool.query(
    `SELECT DISTINCT order_id AS orderId FROM fab_project_tasks
      WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
    [companyId, taskIds],
  );
  const orderIds = orderRows.map((r) => r.orderId).filter((x) => x != null);
  if (orderIds.length === 0) return { byId: new Map(), preds: new Map(), succs: new Map() };

  const [siblings] = await pool.query(
    `SELECT id, order_id, item_id, flow_id, seq_no, depends_on, status,
            started_at, computed_hours, setup_hours, task_qty
       FROM fab_project_tasks
      WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL
        AND status <> 'cancelled'`,
    [companyId, orderIds],
  );
  const edges = await buildEdges({ companyId, tasks: siblings });
  const preds = new Map();
  const succs = new Map();
  for (const e of edges) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to).push(e.from);
    if (!succs.has(e.from)) succs.set(e.from, []);
    succs.get(e.from).push(e.to);
  }
  return { byId: new Map(siblings.map((t) => [t.id, t])), preds, succs };
}

/**
 * Where each task in a PROPOSED set would sit, inside its proposed bar.
 *
 * The bar's end is not the task's end when the bar is a bundle, and a group
 * move is exactly where that difference decides whether the move is legal. See
 * planTaskSpan for the whole story.
 */
function proposedTaskSpans(entries, proposed) {
  const out = new Map();
  for (const e of entries) {
    const place = proposed.get(e.id);
    if (!place) continue;
    for (const [taskId, span] of apportionEntry(place.start, place.end, e.members)) {
      out.set(taskId, { entryId: e.id, ...span });
    }
  }
  return out;
}

// ─── proposing ────────────────────────────────────────────────────────────────

function proposeMove(entries, deltaMs) {
  const out = new Map();
  for (const e of entries) {
    if (e.started) { out.set(e.id, { start: e.start, end: e.end, held: true }); continue; }
    out.set(e.id, {
      start: new Date(e.start.getTime() + deltaMs),
      end: new Date(e.end.getTime() + deltaMs),
    });
  }
  return out;
}

/**
 * Scale the offsets from `anchorMs`, keeping every bar's own duration.
 *
 * Stretching does not make a weld take longer. It spreads the welds out, and the
 * space that opens between them is the whole point — it is where the next unit
 * gets pushed. So the offset scales and the duration does not.
 */
function proposeStretch(entries, anchorMs, scale) {
  const out = new Map();
  for (const e of entries) {
    if (e.started) { out.set(e.id, { start: e.start, end: e.end, held: true }); continue; }
    const dur = e.end.getTime() - e.start.getTime();
    const start = anchorMs + (e.start.getTime() - anchorMs) * scale;
    out.set(e.id, { start: new Date(Math.round(start)), end: new Date(Math.round(start) + dur) });
  }
  return out;
}

/**
 * Re-level this unit against the rest of the plan, held fixed.
 *
 * Levelled as ENTRIES, not as their tasks: a bundle is one machine setup, and
 * levelling its members individually would scatter a setup across the week to
 * save minutes that do not exist. Each entry becomes a pseudo-task whose
 * duration is the bar's planned minutes, and the task-level edges are collapsed
 * onto the bars that carry them.
 */
async function proposePushLeft(companyId, entries, dag, now) {
  const movable = entries.filter((e) => !e.isPinned && !e.started);
  const held = entries.filter((e) => e.isPinned || e.started);
  if (movable.length === 0) {
    throw new PlanError(
      'NOTHING_MOVABLE',
      'Every bar in this unit is pinned or already started, so there is nothing to push.',
    );
  }

  const movingEntryOfTask = new Map();
  for (const e of movable) for (const t of e.taskIds) movingEntryOfTask.set(t, e.id);

  // Entry-level edges, collapsed from the task graph.
  const seen = new Set();
  const edges = [];
  for (const e of movable) {
    for (const t of e.taskIds) {
      for (const p of dag.preds.get(t) ?? []) {
        const from = movingEntryOfTask.get(p);
        if (from == null || from === e.id) continue;
        const k = `${from}->${e.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ from, to: e.id, kind: 'flow' });
      }
    }
  }

  // Predecessors OUTSIDE the moving set become a floor on the bar that needs
  // them, since no edge in this run can carry them.
  const outsidePredIds = [];
  for (const e of movable) {
    for (const t of e.taskIds) {
      for (const p of dag.preds.get(t) ?? []) {
        if (!movingEntryOfTask.has(p)) outsidePredIds.push(p);
      }
    }
  }
  const outsideSpans = await taskPlannedSpans(companyId, [...new Set(outsidePredIds)]);
  const earliestByTask = new Map();
  for (const e of movable) {
    let floor = null;
    for (const t of e.taskIds) {
      for (const p of dag.preds.get(t) ?? []) {
        if (movingEntryOfTask.has(p)) continue;
        const pred = dag.byId.get(p);
        if (!pred || pred.status === 'done') continue;
        const span = outsideSpans.get(Number(p));
        const end = span?.end
          ?? (pred.status === 'in_progress' && pred.started_at
            ? new Date(new Date(pred.started_at).getTime() + taskMinutes(pred) * 60000)
            : null);
        if (end && (floor === null || end > floor)) floor = end;
      }
    }
    if (floor) earliestByTask.set(e.id, floor);
  }

  // Everything else on the plan is fixed occupancy — including the bars of this
  // unit that are pinned or already running.
  // The moving bars are not occupancy — they are what is being placed — so they
  // are excluded BY ID. An earlier version matched on (lane, start, end), which
  // silently freed any other bar that happened to share a span: two bundles
  // placed on the same lane at the same instant are not rare, and the leveller
  // would then double-book the one it was told nothing about.
  const movingIds = new Set(movable.map((e) => e.id));
  const [others] = await pool.query(
    `SELECT id, resource_type_id, resource_id AS assigned_resource_id,
            planned_start, planned_end
       FROM fab_plan_entries
      WHERE company_id = ? AND status = 'planned' AND deleted_at IS NULL
        AND planned_end > ?`,
    [companyId, toDateTimeStr(now)],
  );
  const fixed = [];
  for (const r of others) {
    if (movingIds.has(r.id)) continue;
    fixed.push({
      resource_type_id: r.resource_type_id,
      assigned_resource_id: r.assigned_resource_id,
      start: new Date(r.planned_start),
      end: new Date(r.planned_end),
    });
  }

  const pseudo = movable.map((e, i) => ({
    id: e.id,
    seq_no: i,
    item_id: null,
    flow_id: null,
    depends_on: null,
    // The bar's own minutes, as planned. taskMinutes reads computed_hours ×
    // task_qty + setup, so one hour per hour and nothing multiplied.
    computed_hours: (Number(e.plannedMinutes) || 0) / 60,
    setup_hours: 0,
    task_qty: 1,
    resource_type_id: e.resourceTypeId,
    assigned_resource_id: e.resourceId,
  }));

  const schedule = await levelSchedule({
    companyId,
    tasks: pseudo,
    edges,
    resourceCapacity: await loadResourceCapacity(companyId),
    anchor: now,
    preOccupied: fixed,
    earliestByTask,
  });

  const out = new Map();
  for (const e of held) out.set(e.id, { start: e.start, end: e.end, held: true });
  for (const e of movable) {
    const s = schedule.get(e.id);
    // A bar the leveller could not place stays where it is rather than
    // disappearing; the caller sees it did not move.
    out.set(e.id, s ? { start: s.start, end: s.end } : { start: e.start, end: e.end, held: true });
  }
  return out;
}

// ─── validating ───────────────────────────────────────────────────────────────

function refusal(code, message, detail) {
  return { code, message, detail };
}

/**
 * The DAG, over the finished state.
 *
 * A predecessor inside the moving set is read from the PROPOSAL, not the
 * database — that is the whole reason a group move exists as its own operation.
 */
async function checkDag(companyId, entries, proposed, dag) {
  const entryOfTask = new Map();
  for (const e of entries) for (const t of e.taskIds) entryOfTask.set(t, e.id);

  const allPredIds = [];
  for (const e of entries) {
    for (const t of e.taskIds) {
      for (const p of dag.preds.get(t) ?? []) if (!entryOfTask.has(p)) allPredIds.push(p);
    }
  }
  const outside = await taskPlannedSpans(companyId, [...new Set(allPredIds)]);
  // Task-level, not bar-level, on both sides of every comparison.
  const inside = proposedTaskSpans(entries, proposed);

  const refusals = [];
  for (const e of entries) {
    const place = proposed.get(e.id);
    if (!place) continue;
    for (const t of e.taskIds) {
      const at = inside.get(Number(t)) ?? place;
      for (const p of dag.preds.get(t) ?? []) {
        const predEntry = entryOfTask.get(p);
        // Same bar: a batch running together, not a violation.
        if (predEntry === e.id) continue;
        const pred = dag.byId.get(p);
        if (!pred || pred.status === 'done') continue;

        let end = null;
        if (predEntry != null) end = inside.get(Number(p))?.end ?? proposed.get(predEntry)?.end ?? null;
        if (!end) {
          end = outside.get(Number(p))?.end
            ?? (pred.status === 'in_progress' && pred.started_at
              ? new Date(new Date(pred.started_at).getTime() + taskMinutes(pred) * 60000)
              : null);
        }
        if (!end) {
          refusals.push(refusal(
            'PREDECESSOR_UNPLANNED',
            `Task ${p} (seq ${pred.seq_no}) has to be planned before this unit can move.`,
            { entryId: e.id, taskId: Number(t), predecessorTaskId: Number(p), predecessorSeqNo: pred.seq_no },
          ));
          continue;
        }
        if (end.getTime() > at.start.getTime()) {
          refusals.push(refusal(
            'PREDECESSOR_LATER',
            `Task ${p} (seq ${pred.seq_no}) is not planned to finish until ${end.toISOString()}.`,
            {
              entryId: e.id,
              taskId: Number(t),
              predecessorTaskId: Number(p),
              predecessorSeqNo: pred.seq_no,
              predecessorEnd: end.toISOString(),
            },
          ));
        }
      }
    }
  }
  // One refusal per bar is enough to explain the problem; fifty is a wall.
  const byEntry = new Map();
  for (const r of refusals) if (!byEntry.has(r.detail.entryId)) byEntry.set(r.detail.entryId, r);
  return [...byEntry.values()];
}

/**
 * Nothing may be dragged further into the past.
 *
 * A refusal rather than a warning, and the only one here that is not about the
 * DAG. Over-allocation is a preference — a shop CAN be asked to do too much and
 * the planner's rule is to warn about it. Yesterday is not a preference.
 *
 * The test is comparative, not absolute: a bar that already starts before now
 * (the plan was made last week and the shift has begun) may still be moved
 * later, and may be left alone. What is refused is making it earlier than it
 * already was, when that lands before now.
 */
function checkPast(entries, proposed, now) {
  const out = [];
  for (const e of entries) {
    const place = proposed.get(e.id);
    if (!place || place.held) continue;
    if (place.start.getTime() < now.getTime() && place.start.getTime() < e.start.getTime()) {
      out.push(refusal(
        'PAST_PLACEMENT',
        `That would put work at ${place.start.toISOString()}, which has already happened.`,
        { entryId: e.id, proposedStart: place.start.toISOString(), now: now.toISOString() },
      ));
    }
  }
  // One is enough to explain it; the drag is refused whole either way.
  return out.slice(0, 1);
}

/** Successors left behind — a warning, never a refusal. See the file header. */
async function checkSuccessors(companyId, entries, proposed, dag) {
  const entryOfTask = new Map();
  for (const e of entries) for (const t of e.taskIds) entryOfTask.set(t, e.id);

  const succIds = [];
  for (const e of entries) {
    for (const t of e.taskIds) {
      for (const sc of dag.succs.get(t) ?? []) if (!entryOfTask.has(sc)) succIds.push(sc);
    }
  }
  if (succIds.length === 0) return [];
  const spans = await taskPlannedSpans(companyId, [...new Set(succIds)]);
  const inside = proposedTaskSpans(entries, proposed);

  const stranded = new Set();
  for (const e of entries) {
    const place = proposed.get(e.id);
    if (!place) continue;
    for (const t of e.taskIds) {
      const at = inside.get(Number(t)) ?? place;
      for (const sc of dag.succs.get(t) ?? []) {
        if (entryOfTask.has(sc)) continue;
        const span = spans.get(Number(sc));
        if (span && span.start.getTime() < at.end.getTime()) stranded.add(span.entryId);
      }
    }
  }
  if (stranded.size === 0) return [];
  return [{
    code: 'SUCCESSORS_STRANDED',
    message: `${stranded.size} bar${stranded.size === 1 ? '' : 's'} downstream of this unit would start before it finishes. They are not moved; push them next.`,
    detail: { entryIds: [...stranded] },
  }];
}

/**
 * Lane concurrency over the finished state. A warning by decision, not by
 * omission: this planner's rule is that over-allocation warns and never blocks.
 */
async function checkCapacity(companyId, entries, proposed) {
  const moving = new Set(entries.map((e) => e.id));
  const times = [...proposed.values()];
  if (times.length === 0) return [];
  const from = new Date(Math.min(...times.map((p) => p.start.getTime())));
  const to = new Date(Math.max(...times.map((p) => p.end.getTime())));

  const [rows] = await pool.query(
    `SELECT id, resource_type_id AS resourceTypeId, resource_id AS resourceId,
            planned_start AS plannedStart, planned_end AS plannedEnd
       FROM fab_plan_entries
      WHERE company_id = ? AND status = 'planned' AND deleted_at IS NULL
        AND planned_start < ? AND planned_end > ?`,
    [companyId, toDateTimeStr(to), toDateTimeStr(from)],
  );
  const cap = await loadResourceCapacity(companyId);
  const byKey = new Map();
  const push = (key, capacity, start, end) => {
    if (!byKey.has(key)) byKey.set(key, { capacity, spans: [] });
    byKey.get(key).spans.push([start, end]);
  };
  const keyFor = (resourceId, resourceTypeId) => {
    if (resourceId != null) {
      const c = cap.resourceUnits.get(Number(resourceId));
      return { key: `r:${resourceId}`, capacity: c != null && c > 0 ? c : 1 };
    }
    if (resourceTypeId != null) {
      const c = cap.typeUnits.get(Number(resourceTypeId));
      if (c != null && c > 0) return { key: `t:${resourceTypeId}`, capacity: c };
    }
    return null;
  };

  for (const r of rows) {
    if (moving.has(r.id)) continue;
    const k = keyFor(r.resourceId, r.resourceTypeId);
    if (!k) continue;
    push(k.key, k.capacity, new Date(r.plannedStart).getTime(), new Date(r.plannedEnd).getTime());
  }
  for (const e of entries) {
    const place = proposed.get(e.id);
    if (!place) continue;
    const k = keyFor(e.resourceId, e.resourceTypeId);
    if (!k) continue;
    push(k.key, k.capacity, place.start.getTime(), place.end.getTime());
  }

  const over = [];
  for (const [key, { capacity, spans }] of byKey) {
    const events = [];
    for (const [s, e] of spans) { events.push([s, 1]); events.push([e, -1]); }
    // Close before open at an equal instant: bars that merely touch are not
    // concurrent, and counting them as such would warn on every tidy plan.
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let peak = 0;
    for (const [, d] of events) { cur += d; if (cur > peak) peak = cur; }
    if (peak > capacity) over.push({ key, peak, capacity });
  }
  if (over.length === 0) return [];
  return [{
    code: 'OVER_CAPACITY',
    message: `${over.length} lane${over.length === 1 ? '' : 's'} would be booked past capacity — the busiest to ${Math.max(...over.map((o) => o.peak))} at once.`,
    detail: { lanes: over },
  }];
}

/** Bars that would sit where nobody is on shift. */
async function checkCalendar(companyId, entries, proposed) {
  const times = [...proposed.values()];
  if (times.length === 0) return [];
  const from = new Date(Math.min(...times.map((p) => p.start.getTime())));
  const to = new Date(Math.max(...times.map((p) => p.end.getTime())));
  if (to.getTime() - from.getTime() > CALENDAR_CHECK_DAYS * 86400000) {
    return [{
      code: 'CALENDAR_NOT_CHECKED',
      message: `This unit would span more than ${CALENDAR_CHECK_DAYS} days, so shift coverage was not checked.`,
      detail: {},
    }];
  }

  const typeIds = [...new Set(entries.map((e) => e.resourceTypeId).filter((x) => x != null))];
  if (typeIds.length === 0) return [];
  const [resources] = await pool.query(
    `SELECT id, plant_id AS plantId, resource_type_id AS resourceTypeId
       FROM fab_resources
      WHERE company_id = ? AND resource_type_id IN (?) AND deleted_at IS NULL`,
    [companyId, typeIds],
  );

  // Merged working intervals per lane, computed once and reused for every bar
  // on it — a query per bar would make a fifty-bar move a fifty-query move.
  const byType = new Map();
  for (const r of resources) {
    const capSrc = await resolveCapacityForResource(companyId, r.id, r.plantId);
    // No calendar at all: the leveller plans this machine 24/7, so reporting it
    // as unmanned here would have the two disagree about the same lane.
    if (isUnbounded(capSrc)) { byType.set(r.resourceTypeId, null); continue; }
    if (byType.get(r.resourceTypeId) === null) continue;
    const ivs = await capacityIntervals(companyId, capSrc, from, to);
    const list = byType.get(r.resourceTypeId) ?? [];
    for (const iv of ivs) list.push([iv.start.getTime(), iv.end.getTime()]);
    byType.set(r.resourceTypeId, list);
  }
  for (const [k, v] of byType) {
    if (!v) continue;
    v.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const iv of v) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    byType.set(k, merged);
  }

  let offShift = 0;
  for (const e of entries) {
    const place = proposed.get(e.id);
    if (!place || place.held) continue;
    const merged = byType.get(e.resourceTypeId);
    if (!merged) continue;
    const s = place.start.getTime();
    const en = place.end.getTime();
    const touches = merged.some(([a, b]) => b > s && a < en);
    if (!touches) offShift += 1;
  }
  if (offShift === 0) return [];
  return [{
    code: 'OFF_SHIFT',
    message: `${offShift} bar${offShift === 1 ? '' : 's'} would sit entirely outside crewed hours.`,
    detail: { count: offShift },
  }];
}

// ─── the operation ────────────────────────────────────────────────────────────

/**
 * Move, stretch, push left, or restore a set of bars as one unit.
 *
 * @param {number} companyId
 * @param {object} input
 * @param {number[]} input.entryIds     the unit
 * @param {'move'|'stretch'|'pushLeft'|'restore'} input.op
 * @param {number} [input.deltaMs]      move
 * @param {number} [input.anchorMs]     stretch — the end held still
 * @param {number} [input.scale]        stretch — > 0
 * @param {Array}  [input.placements]   restore — [{entryId, plannedStart, plannedEnd}]
 * @param {boolean} [input.dryRun]      validate and return, write nothing
 * @returns {Promise<{applied:boolean, placements:object[], previous:object[], warnings:object[]}>}
 */
export async function transformGroup(companyId, input, userId = null) {
  const entryIds = [...new Set((input.entryIds ?? []).map(Number))].filter(Boolean);
  if (entryIds.length === 0) throw new PlanError('NO_ENTRIES', 'No bars were named.');
  if (!GROUP_OPS.includes(input.op)) {
    throw new PlanError('BAD_OP', `Unknown operation "${input.op}".`);
  }

  const entries = await loadEntries(companyId, entryIds);
  const allTaskIds = [...new Set(entries.flatMap((e) => e.taskIds))];
  if (allTaskIds.length === 0) throw new PlanError('NO_TASKS', 'Those bars carry no tasks.');
  const dag = await loadDag(companyId, allTaskIds);
  const now = new Date();

  let proposed;
  if (input.op === 'move') {
    const delta = Number(input.deltaMs);
    if (!Number.isFinite(delta)) throw new PlanError('BAD_DELTA', 'deltaMs must be a number.');
    if (delta === 0) throw new PlanError('NO_CHANGE', 'That is where the unit already is.');
    proposed = proposeMove(entries, Math.round(delta));
  } else if (input.op === 'stretch') {
    const scale = Number(input.scale);
    const anchor = Number(input.anchorMs);
    if (!Number.isFinite(scale) || scale <= 0) throw new PlanError('BAD_SCALE', 'scale must be greater than zero.');
    if (!Number.isFinite(anchor)) throw new PlanError('BAD_ANCHOR', 'anchorMs must be a number.');
    proposed = proposeStretch(entries, anchor, scale);
  } else if (input.op === 'pushLeft') {
    proposed = await proposePushLeft(companyId, entries, dag, now);
    /**
     * A push that does not finish the unit sooner is not applied.
     *
     * This can happen, and it is not a bug. The suggestor levels TASKS and then
     * bundles them, so a bar can be a batch that was woven through gaps its own
     * width could never fit into. Re-levelling BARS cannot take a bar apart, so
     * it may need bigger holes than the plan it is looking at. Applying that
     * would answer "make this sooner" by making it later.
     */
    const before = Math.max(...entries.map((e) => e.end.getTime()));
    const beforeStart = Math.min(...entries.map((e) => e.start.getTime()));
    const after = Math.max(...[...proposed.values()].map((pl) => pl.end.getTime()));
    const afterStart = Math.min(...[...proposed.values()].map((pl) => pl.start.getTime()));
    if (after > before || (after === before && afterStart >= beforeStart)) {
      return {
        applied: false,
        movedCount: 0,
        placements: entries.map((e) => ({
          entryId: e.id,
          plannedStart: e.start.toISOString(),
          plannedEnd: e.end.toISOString(),
          held: true,
        })),
        previous: entries.map((e) => ({
          entryId: e.id,
          plannedStart: e.start.toISOString(),
          plannedEnd: e.end.toISOString(),
        })),
        warnings: [{
          code: 'NO_ROOM',
          message: 'This unit is already as far left as its bars will fit. Nothing was moved.',
          detail: {},
        }],
      };
    }
  } else {
    const given = new Map((input.placements ?? []).map((p) => [Number(p.entryId), p]));
    proposed = new Map();
    for (const e of entries) {
      const p = given.get(e.id);
      if (!p) { proposed.set(e.id, { start: e.start, end: e.end, held: true }); continue; }
      const s = new Date(p.plannedStart);
      const en = new Date(p.plannedEnd);
      if (Number.isNaN(s.getTime()) || Number.isNaN(en.getTime()) || !(en >= s)) {
        throw new PlanError('BAD_PLACEMENT', `Bar ${e.id} was given an unusable start or end.`);
      }
      proposed.set(e.id, { start: s, end: en });
    }
  }

  const moved = entries.filter((e) => {
    const p = proposed.get(e.id);
    return p && !p.held
      && (p.start.getTime() !== e.start.getTime() || p.end.getTime() !== e.end.getTime());
  });

  const refusals = [
    // Undo is exempt from the past guard, and has to be.
    //
    // The guard exists to stop somebody scheduling work into a day that has
    // already happened. Restoring is not that: it puts the plan back where it
    // already was, and that state was legal when it was written. Without the
    // exemption, undo quietly stops working as soon as the clock passes the
    // start of what was moved — which is minutes, on the bar you are most
    // likely to have just dragged by mistake.
    ...(input.op === 'restore' ? [] : checkPast(entries, proposed, now)),
    ...await checkDag(companyId, entries, proposed, dag),
  ];
  if (refusals.length > 0) {
    const err = new PlanError(refusals[0].code, refusals[0].message, refusals[0].detail);
    err.refusals = refusals;
    throw err;
  }

  const warnings = [
    ...await checkSuccessors(companyId, entries, proposed, dag),
    ...await checkCapacity(companyId, entries, proposed),
    ...await checkCalendar(companyId, entries, proposed),
  ];

  const previous = entries.map((e) => ({
    entryId: e.id,
    plannedStart: e.start.toISOString(),
    plannedEnd: e.end.toISOString(),
  }));
  const placements = entries.map((e) => {
    const p = proposed.get(e.id);
    return {
      entryId: e.id,
      plannedStart: p.start.toISOString(),
      plannedEnd: p.end.toISOString(),
      held: !!p.held,
    };
  });

  if (input.dryRun) {
    return { applied: false, movedCount: moved.length, placements, previous, warnings };
  }
  if (moved.length === 0) {
    return { applied: false, movedCount: 0, placements, previous, warnings };
  }

  const tz = await plannerTimezone(companyId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const e of moved) {
      const p = proposed.get(e.id);
      await conn.query(
        `UPDATE fab_plan_entries
            SET planned_start = ?, planned_end = ?, plan_date = ?, updated_by = ?
          WHERE company_id = ? AND id = ? AND status = 'planned' AND deleted_at IS NULL`,
        [toDateTimeStr(p.start), toDateTimeStr(p.end), zonedYMD(p.start, tz), userId, companyId, e.id],
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return { applied: true, movedCount: moved.length, placements, previous, warnings };
}
