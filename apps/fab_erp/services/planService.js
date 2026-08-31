/**
 * planService.js — reading and editing the plan itself.
 *
 * Split from planSuggestionService on purpose: that one computes and freezes an
 * IDEAL and writes only to fab_plan_runs; this one owns fab_plan_entries, which
 * is what a human actually edits. Accepting is the only bridge between them.
 *
 * THE DAG GATE (manual placement)
 * -------------------------------
 * The plan does not constrain the shop floor at all — an operator starting
 * something else is not blocked and not flagged. But PLACING work is a different
 * act from doing it, and a plan that says "drill at 09:00, cut at 14:00" is not
 * an aggressive plan, it is an impossible one. So `assertDagAllows` refuses a
 * placement whose predecessor is unplanned or planned to finish later, and it
 * says which predecessor and when it frees up.
 *
 * Execution-time ordering needs nothing from here: `POST /tasks/:id/start` is
 * already legal only from `eligible`/`paused`, and taskGatingService is what
 * promotes blocked → eligible.
 *
 * COVERAGE IS FRACTIONAL
 * ----------------------
 * Lanes are resource TYPES, so "is this hour manned" has no yes/no answer — a
 * type with four machines can have three of them crewed. Coverage is therefore
 * reported as coveredUnits/totalUnits per segment, and the over-allocation
 * warning measures against MANNED capacity rather than nameplate capacity.
 * Warning against nameplate would call a day comfortable when nobody is on shift.
 */

import { pool } from '../../../db.js';
import { cachedQuery } from './planReadCache.js';
import { buildEdges } from './resourceLevelingService.js';
import { outstandingGatesFor, isMaterialBlocked } from './taskGatingService.js';
import { compareOrders, rankReason, PRIORITY_LEVELS } from './orderPriority.js';
import { taskMinutes } from './taskDuration.js';
import {
  resolveCapacityForResource, capacityIntervals, capacityMinutes, isUnbounded,
} from './capacityService.js';
import { calendarTimezones, zonedYMD, zonedWallClockToUtc, DEFAULT_TZ } from './plantTime.js';
import { apportionEntry, taskPlannedSpans, remapMemberTimes } from './planTaskSpan.js';
import { assignMachines } from './planMachineService.js';

/**
 * The zone the planner's grid, hour labels and plan_date are expressed in.
 *
 * NOT `calendarTimezones().__default` — that is the COMPANY setting, and the
 * zone actually lives on the PLANT (ARCHITECTURE §13, "the factory's clock is
 * not the server's"). A company with an unset default but an Indian plant would
 * otherwise draw its 08:00 shift at 02:30 and stamp a 20:00 bar with the wrong
 * plan_date, which is the exact class of bug fab_plants.timezone was added for.
 *
 * A company CAN run plants in different zones, but a single grid has one axis.
 * When the plants in play disagree there is no honest single answer, so it falls
 * back to the company default rather than silently picking one site's clock.
 */
export async function plannerTimezone(companyId) {
  const tzMap = await calendarTimezones(companyId);
  const companyDefault = tzMap.get('__default') ?? DEFAULT_TZ;
  const [rows] = await cachedQuery(`SELECT DISTINCT p.timezone AS tz
       FROM fab_plants p
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.timezone IS NOT NULL`,
    [companyId],
  );
  const zones = rows.map((r) => r.tz).filter(Boolean);
  return zones.length === 1 ? zones[0] : companyDefault;
}

/** MySQL DATETIME, UTC. */
function toDateTimeStr(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 19).replace('T', ' ');
}

export class PlanError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    this.detail = detail;
  }
}

// ─── reading ──────────────────────────────────────────────────────────────────

async function loadLanes(companyId, resourceTypeIds = []) {
  const params = [companyId];
  let filter = '';
  if (resourceTypeIds.length > 0) { filter = ' AND rt.id IN (?)'; params.push(resourceTypeIds); }

  const [types] = await cachedQuery(`SELECT rt.id, rt.name, rt.code, rt.num_units AS numUnits
       FROM fab_resource_types rt
      WHERE rt.company_id = ? AND rt.deleted_at IS NULL${filter}
      ORDER BY rt.name ASC`,
    params,
  );
  if (types.length === 0) return [];

  const [resources] = await cachedQuery(`SELECT r.id, r.name, r.resource_type_id AS resourceTypeId, r.plant_id AS plantId,
            ev.state AS machineState
       FROM fab_resources r
       LEFT JOIN (
         SELECT resource_id, state,
                ROW_NUMBER() OVER (PARTITION BY resource_id ORDER BY at DESC, id DESC) AS rn
           FROM fab_resource_events
          WHERE company_id = ? AND deleted_at IS NULL AND superseded_by_event_id IS NULL
       ) ev ON ev.resource_id = r.id AND ev.rn = 1
      WHERE r.company_id = ? AND r.deleted_at IS NULL
      ORDER BY r.name ASC`,
    [companyId, companyId],
  );

  const byType = new Map(types.map((t) => [t.id, { ...t, resources: [] }]));
  for (const r of resources) {
    const lane = byType.get(r.resourceTypeId);
    if (lane) lane.resources.push(r);
  }
  return [...byType.values()];
}

/**
 * Fractional coverage for one lane: a sweep over every machine's working
 * intervals, emitting a segment whenever the manned count changes.
 *
 * A machine marked `down` contributes nothing — it has a calendar and possibly a
 * crew, but it cannot run, and shading it as available is how a lane looks
 * healthy while the shop stands still.
 */
async function laneCoverage(companyId, lane, from, to) {
  const boundaries = [];
  let usable = 0;
  let unbounded = false;

  for (const r of lane.resources) {
    if (r.machineState === 'down') continue;
    usable += 1;
    const cap = await resolveCapacityForResource(companyId, r.id, r.plantId);
    // No shift calendar configured at all. The LEVELLER treats this as 24/7
    // (capacityService.isUnbounded), so reporting it here as zero coverage would
    // have the grid and the engine asserting opposite things about the same
    // machine — the grid would shade the lane dead while the engine cheerfully
    // planned work onto it. Flagged instead, so the UI can say "no calendar"
    // rather than draw a lie in either direction.
    if (isUnbounded(cap)) { unbounded = true; continue; }
    const ivs = await capacityIntervals(companyId, cap, from, to);
    for (const iv of ivs) {
      boundaries.push([iv.start.getTime(), 1]);
      boundaries.push([iv.end.getTime(), -1]);
    }
  }

  // A type can declare num_units independently of how many machine rows exist.
  // The larger is the honest ceiling: capacity the shop believes it has.
  const total = Math.max(usable, Number(lane.numUnits) || 0);
  if (boundaries.length === 0) {
    return { totalUnits: total, segments: [], unbounded };
  }

  boundaries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const segments = [];
  let count = 0;
  let cursor = boundaries[0][0];
  for (const [at, delta] of boundaries) {
    if (at > cursor && count > 0) {
      const last = segments[segments.length - 1];
      if (last && last.coveredUnits === count && last.end.getTime() === cursor) {
        last.end = new Date(at);
      } else {
        segments.push({ start: new Date(cursor), end: new Date(at), coveredUnits: count });
      }
    }
    count += delta;
    cursor = at;
  }
  return { totalUnits: total, segments, unbounded };
}

async function loadEntries(companyId, from, to, resourceTypeIds = []) {
  const params = [companyId, toDateTimeStr(to), toDateTimeStr(from)];
  let filter = '';
  if (resourceTypeIds.length > 0) { filter = ' AND e.resource_type_id IN (?)'; params.push(resourceTypeIds); }

  const [entries] = await cachedQuery(`SELECT e.id, e.plan_date AS planDate, e.resource_type_id AS resourceTypeId,
            e.resource_id AS resourceId, e.planned_start AS plannedStart,
            e.planned_end AS plannedEnd, e.planned_minutes AS plannedMinutes,
            e.kind, e.bundle_key AS bundleKey, e.ancestor_item_id AS ancestorItemId,
            e.order_id AS orderId, e.operation_id AS operationId, e.source,
            e.accepted_from_run_id AS acceptedFromRunId, e.is_pinned AS isPinned,
            e.status, e.label, e.notes,
            o.order_number AS orderNumber, o.must_finish_by AS mustFinishBy,
            o.required_date AS requiredDate,
            op.name AS operationName, r.name AS resourceName
       FROM fab_plan_entries e
       LEFT JOIN fab_orders o     ON o.id = e.order_id
       LEFT JOIN fab_operations op ON op.id = e.operation_id
       LEFT JOIN fab_resources r  ON r.id = e.resource_id
      WHERE e.company_id = ? AND e.status = 'planned' AND e.deleted_at IS NULL
        AND e.planned_start < ? AND e.planned_end > ?${filter}
      ORDER BY e.planned_start ASC, e.id ASC`,
    params,
  );
  if (entries.length === 0) return [];

  const [members] = await cachedQuery(`SELECT et.plan_entry_id AS planEntryId, et.task_id AS taskId,
            et.resource_id AS machineId,
            et.planned_minutes AS plannedMinutes,
            et.planned_start AS plannedStart, et.planned_end AS plannedEnd,
            t.status, t.seq_no AS seqNo, t.item_id AS itemId,
            i.name AS itemName
       FROM fab_plan_entry_tasks et
       JOIN fab_project_tasks t ON t.id = et.task_id AND t.deleted_at IS NULL
       LEFT JOIN fab_items i    ON i.id = t.item_id AND i.deleted_at IS NULL
      WHERE et.company_id = ? AND et.plan_entry_id IN (?) AND et.deleted_at IS NULL
      ORDER BY et.sort_order ASC, et.id ASC`,
    [companyId, entries.map((e) => e.id)],
  );

  const byEntry = new Map(entries.map((e) => [e.id, { ...e, isPinned: !!e.isPinned, tasks: [] }]));
  for (const m of members) byEntry.get(m.planEntryId)?.tasks.push(m);
  return [...byEntry.values()];
}

/**
 * The grid: lanes, their fractional coverage, their entries, and a per-day load
 * vs capacity figure for the over-allocation warning.
 */
export async function getPlan(companyId, { from, to, resourceTypeIds = [] } = {}) {
  const lanes = await loadLanes(companyId, resourceTypeIds);
  const entries = await loadEntries(companyId, from, to, resourceTypeIds);
  const tz = await plannerTimezone(companyId);

  // Local plan dates spanned by the window, walked through the plant's zone
  // rather than by adding 24h — the latter drifts across a DST change.
  const days = [];
  for (let t = from.getTime(); t <= to.getTime(); t += 12 * 3600 * 1000) {
    const ymd = zonedYMD(new Date(t), tz);
    if (!days.includes(ymd)) days.push(ymd);
  }

  const entriesByLane = new Map();
  for (const e of entries) {
    if (!entriesByLane.has(e.resourceTypeId)) entriesByLane.set(e.resourceTypeId, []);
    entriesByLane.get(e.resourceTypeId).push(e);
  }

  const out = [];
  for (const lane of lanes) {
    const coverage = await laneCoverage(companyId, lane, from, to);
    const laneEntries = entriesByLane.get(lane.id) ?? [];

    const dayRows = [];
    for (const ymd of days) {
      const dayStart = zonedWallClockToUtc(ymd, '00:00:00', tz);
      const dayEnd = zonedWallClockToUtc(ymd, '00:00:00', tz);
      if (!dayStart || !dayEnd) continue;
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

      // Manned capacity, summed across the lane's machines. This is what the
      // planner is allowed to exceed with a warning.
      let capMin = 0;
      for (const r of lane.resources) {
        if (r.machineState === 'down') continue;
        const cap = await resolveCapacityForResource(companyId, r.id, r.plantId);
        if (isUnbounded(cap)) continue;
        capMin += await capacityMinutes(companyId, cap, dayStart, dayEnd);
      }

      const plannedMin = laneEntries.reduce((n, e) => n + (e.planDate === ymd ? Number(e.plannedMinutes) || 0 : 0), 0);
      dayRows.push({
        date: ymd,
        // null, not 0, when no calendar bounds this lane: the ceiling is unknown,
        // which is a different statement from "there is no time available".
        capacityMinutes: coverage.unbounded ? null : Math.round(capMin),
        plannedMinutes: Math.round(plannedMin),
        // An unknown ceiling cannot be exceeded. Warning here would put a red
        // badge on every lane of a shop that has simply never set up a calendar.
        overAllocated: !coverage.unbounded && plannedMin > capMin,
        overBy: coverage.unbounded ? 0 : Math.max(0, Math.round(plannedMin - capMin)),
      });
    }

    out.push({
      resourceTypeId: lane.id,
      name: lane.name,
      code: lane.code,
      totalUnits: coverage.totalUnits,
      // True = this lane has no shift calendar, so the engine plans it 24/7 and
      // the grid must say so rather than shading it unmanned.
      unbounded: coverage.unbounded,
      resources: lane.resources.map((r) => ({ id: r.id, name: r.name, machineState: r.machineState ?? null })),
      coverage: coverage.segments,
      days: dayRows,
      entries: laneEntries,
    });
  }

  return { from, to, timezone: tz, days, lanes: out };
}

// ─── the DAG gate ─────────────────────────────────────────────────────────────

/**
 * Refuse work that is waiting on STOCK, however it is placed.
 *
 * The distinction this draws is the whole reason `blocked` is plannable at all:
 *
 *   blocked on another TASK    plannable. Plan the predecessor, and this goes
 *                              after it — that is what assertDagAllows checks,
 *                              and it is the normal way a chain gets laid out.
 *   blocked on MATERIAL        NOT plannable. There is no activity to schedule
 *                              it after; the steel is either on the shelf or it
 *                              is not, and no arrangement of the plan changes
 *                              that. Committing a date to it would be inventing
 *                              a promise out of a shortage.
 *
 * Deliberately checked SEPARATELY from the DAG gate rather than folded into it:
 * a material gate is not an edge, `buildEdges` cannot see it, and a task waiting
 * only on steel has no predecessor at all — so it sails straight through the DAG
 * gate and would otherwise be freely plannable, which is precisely the hole this
 * closes.
 *
 * The escape hatch is real work, not a flag: receive the material. Stock-in
 * clears the gate and the task becomes plannable on its own.
 */
export async function assertMaterialAvailable(companyId, taskIds) {
  const [rows] = await cachedQuery(`SELECT id, status FROM fab_project_tasks
      WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL AND status = 'blocked'`,
    [companyId, taskIds],
  );
  if (!rows.length) return;

  const gates = await outstandingGatesFor(companyId, rows.map((r) => r.id));
  for (const [taskId, gate] of gates) {
    if (!isMaterialBlocked(gate)) continue;
    throw new PlanError(
      'AWAITING_MATERIAL',
      'This task is waiting for raw material, so it cannot be given a date yet. '
      + 'Receive the material and it becomes plannable.',
      { taskId: Number(taskId) },
    );
  }
}

/**
 * Refuse a placement that cannot physically happen.
 *
 * For every task going onto the bar, each unfinished predecessor must be either
 * already planned to finish by `start`, or running and projected to finish by
 * then. A predecessor nobody has planned at all is refused outright: "after
 * another planned activity is done" is the rule, and a placement whose
 * predecessor floats free is exactly the case it exists to prevent.
 */
export async function assertDagAllows(companyId, taskIds, start, { excludeEntryId = null } = {}) {
  if (!taskIds.length) throw new PlanError('NO_TASKS', 'A plan entry needs at least one task.');

  const [orderRows] = await cachedQuery(`SELECT DISTINCT order_id AS orderId FROM fab_project_tasks
      WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
    [companyId, taskIds],
  );
  const orderIds = orderRows.map((r) => r.orderId).filter((x) => x != null);
  if (orderIds.length === 0) return;

  // Edges are resolved over the whole order, not the selected tasks — a
  // predecessor outside the selection is precisely what has to be found.
  const [siblings] = await cachedQuery(`SELECT id, order_id, item_id, flow_id, seq_no, depends_on, status,
            started_at, computed_hours, setup_hours, task_qty
       FROM fab_project_tasks
      WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL
        AND status <> 'cancelled'`,
    [companyId, orderIds],
  );
  const edges = await buildEdges({ companyId, tasks: siblings });
  const byId = new Map(siblings.map((t) => [t.id, t]));

  const preds = new Map();
  for (const e of edges) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to).push(e.from);
  }

  /**
   * Where each predecessor is currently planned to finish — the TASK's own
   * finish, not its bar's.
   *
   * This used to be MAX(e.planned_end) over the predecessor's entry, which is
   * the bundle's end. A task second of seven in a batch therefore looked as
   * though it finished when the seventh did, and every successor of a bundled
   * task read as illegally early. Since accepting a suggestion with bundling on
   * produces exactly that shape, moving almost any bar was refused for a
   * violation the plan did not have. See planTaskSpan.
   */
  const predIds = [...new Set(taskIds.flatMap((id) => preds.get(id) ?? []))];
  const predSpans = await taskPlannedSpans(companyId, predIds, { excludeEntryId });
  const plannedEnd = new Map([...predSpans].map(([taskId, span]) => [taskId, span.end]));

  const selected = new Set(taskIds.map(Number));
  for (const taskId of taskIds) {
    for (const predId of preds.get(Number(taskId)) ?? []) {
      // A predecessor on the SAME bar is a batch running together, not a
      // violation — bundleSchedule already refuses to co-locate linked tasks.
      if (selected.has(Number(predId))) continue;
      const pred = byId.get(predId);
      if (!pred || pred.status === 'done') continue;

      const end = plannedEnd.get(Number(predId))
        ?? (pred.status === 'in_progress' && pred.started_at
          ? new Date(new Date(pred.started_at).getTime() + taskMinutes(pred) * 60000)
          : null);

      if (!end) {
        throw new PlanError(
          'PREDECESSOR_UNPLANNED',
          `Task ${predId} (seq ${pred.seq_no}) has to be planned before this can be.`,
          { taskId: Number(taskId), predecessorTaskId: Number(predId), predecessorSeqNo: pred.seq_no },
        );
      }
      if (end.getTime() > start.getTime()) {
        throw new PlanError(
          'PREDECESSOR_LATER',
          `Task ${predId} (seq ${pred.seq_no}) is not planned to finish until ${end.toISOString()}.`,
          {
            taskId: Number(taskId),
            predecessorTaskId: Number(predId),
            predecessorSeqNo: pred.seq_no,
            predecessorEnd: end.toISOString(),
          },
        );
      }
    }
  }
}

/** A task may sit on at most one active entry. No partial unique index exists. */
async function assertNotAlreadyPlanned(conn, companyId, taskIds, excludeEntryId = null) {
  const params = [companyId, taskIds];
  let excl = '';
  if (excludeEntryId != null) { excl = ' AND e.id <> ?'; params.push(excludeEntryId); }
  const [rows] = await conn.query(
    `SELECT et.task_id AS taskId, e.id AS entryId
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id
                             AND e.company_id = et.company_id
                             AND e.status = 'planned' AND e.deleted_at IS NULL
      WHERE et.company_id = ? AND et.task_id IN (?) AND et.deleted_at IS NULL${excl}
      LIMIT 1`,
    params,
  );
  if (rows.length > 0) {
    throw new PlanError(
      'ALREADY_PLANNED',
      `Task ${rows[0].taskId} is already on plan entry ${rows[0].entryId}.`,
      { taskId: rows[0].taskId, entryId: rows[0].entryId },
    );
  }
}

// ─── writing ──────────────────────────────────────────────────────────────────

async function planDateFor(companyId, start) {
  return zonedYMD(start, await plannerTimezone(companyId));
}

/**
 * Insert one entry plus its member rows. Caller owns the transaction so accepting
 * a whole run is atomic — half an accepted plan is worse than none.
 */
async function insertEntry(conn, companyId, entry, planDate) {
  const [res] = await conn.query(
    `INSERT INTO fab_plan_entries
       (company_id, plan_date, resource_type_id, resource_id, planned_start,
        planned_end, planned_minutes, kind, bundle_key, ancestor_item_id,
        order_id, operation_id, source, accepted_from_run_id, run_item_id,
        is_pinned, status, label, notes, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)`,
    [companyId, planDate, entry.resourceTypeId, entry.resourceId ?? null,
     toDateTimeStr(entry.plannedStart), toDateTimeStr(entry.plannedEnd),
     Math.round(entry.plannedMinutes || 0),
     entry.taskIds.length > 1 ? 'bundle' : 'task',
     entry.bundleKey ? String(entry.bundleKey).slice(0, 190) : null,
     entry.ancestorItemId ?? null, entry.orderId ?? null, entry.operationId ?? null,
     entry.source ?? 'manual', entry.acceptedFromRunId ?? null, entry.runItemId ?? null,
     entry.isPinned ? 1 : 0, entry.label ? String(entry.label).slice(0, 255) : null,
     entry.notes ?? null, entry.userId ?? null, entry.userId ?? null],
  );
  const entryId = res.insertId;

  const [minutes] = await conn.query(
    `SELECT id, computed_hours AS computedHours, setup_hours AS setupHours, task_qty AS taskQty FROM fab_project_tasks
      WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
    [companyId, entry.taskIds],
  );
  const minuteOf = new Map(minutes.map((m) => [m.id, taskMinutes(m)]));

  /**
   * `taskTimes` is each member's own levelled span, keyed by task id. Present
   * when the bar came from a run (or from splitting one that did); absent for a
   * bar a human placed by hand, which never had a per-task levelling. NULL then,
   * and planTaskSpan falls back to apportioning for exactly those.
   */
  const at = entry.taskTimes instanceof Map ? entry.taskTimes : new Map();
  const rows = entry.taskIds.map((taskId, i) => {
    const span = at.get(Number(taskId));
    return [
      companyId, entryId, taskId, minuteOf.get(taskId) ?? 0, i,
      span ? toDateTimeStr(span.start) : null,
      span ? toDateTimeStr(span.end) : null,
    ];
  });
  await conn.query(
    `INSERT INTO fab_plan_entry_tasks
       (company_id, plan_entry_id, task_id, planned_minutes, sort_order,
        planned_start, planned_end)
     VALUES ?`,
    [rows],
  );
  return entryId;
}

/**
 * Manual placement. Pinned on creation: a human put it there, so a later
 * re-suggestion treats it as committed capacity rather than a proposal.
 */
export async function createEntry(companyId, input, userId = null) {
  const taskIds = [...new Set((input.taskIds ?? []).map(Number))].filter(Boolean);
  const start = new Date(input.plannedStart);
  if (Number.isNaN(start.getTime())) throw new PlanError('BAD_START', 'plannedStart is not a valid date.');

  const [tasks] = await cachedQuery(`SELECT t.id, t.order_id AS orderId, t.operation_id AS operationId,
            t.resource_type_id AS resourceTypeId, t.assigned_resource_id AS resourceId,
            t.computed_hours AS computedHours, t.setup_hours AS setupHours, t.task_qty AS taskQty, t.seq_no AS seqNo,
            i.parent_item_id AS parentItemId, i.name AS itemName,
            op.name AS operationName
       FROM fab_project_tasks t
       LEFT JOIN fab_items i     ON i.id = t.item_id AND i.deleted_at IS NULL
       LEFT JOIN fab_operations op ON op.id = t.operation_id
      WHERE t.company_id = ? AND t.id IN (?) AND t.deleted_at IS NULL
        AND t.status NOT IN ('cancelled','done')`,
    [companyId, taskIds],
  );
  if (tasks.length !== taskIds.length) {
    throw new PlanError('TASK_NOT_FOUND', 'One or more tasks are missing, done or cancelled.');
  }

  // Material first: "you cannot schedule this at all" is a more useful answer
  // than "not before 14:00 Tuesday" on a task that has no steel behind it.
  await assertMaterialAvailable(companyId, taskIds);
  await assertDagAllows(companyId, taskIds, start);

  const totalMinutes = tasks.reduce((n, t) => n + taskMinutes(t), 0);
  const end = input.plannedEnd
    ? new Date(input.plannedEnd)
    : new Date(start.getTime() + totalMinutes * 60000);

  const first = tasks[0];
  const resourceTypeId = input.resourceTypeId ?? first.resourceTypeId;
  if (!resourceTypeId) throw new PlanError('NO_RESOURCE_TYPE', 'The tasks have no resource type to plan against.');

  const planDate = await planDateFor(companyId, start);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await assertNotAlreadyPlanned(conn, companyId, taskIds);
    const entryId = await insertEntry(conn, companyId, {
      resourceTypeId,
      resourceId: input.resourceId ?? null,
      plannedStart: start,
      plannedEnd: end,
      plannedMinutes: totalMinutes,
      taskIds,
      bundleKey: taskIds.length > 1
        ? `${first.orderId ?? 0}:${first.operationId ?? 0}:${resourceTypeId}:${first.parentItemId ?? `self${first.id}`}`
        : null,
      ancestorItemId: first.parentItemId ?? null,
      orderId: first.orderId ?? null,
      operationId: first.operationId ?? null,
      source: 'manual',
      isPinned: true,
      label: taskIds.length > 1
        ? `${first.operationName ?? 'Operation'} · ${taskIds.length} items`
        : `${first.operationName ?? 'Operation'} · ${first.itemName ?? `item ${first.id}`}`,
      notes: input.notes ?? null,
      userId,
    }, planDate);
    await conn.commit();
    return { entryId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Accept a whole suggestion run, or named items from it, into the real plan. */
/**
 * Rows per statement when accepting a run.
 *
 * Accepting used to be about seven sequential round trips per bar, which on a
 * 1,551-bar plan against a managed database was 130 seconds — past most proxy
 * timeouts, and it only ever completed because Render does not impose one. The
 * work is now batched; these are the chunk sizes, kept well inside max_allowed_packet
 * rather than at it, since a bar's label and bundle key are free text.
 */
const ACCEPT_ENTRY_CHUNK = 200;
const ACCEPT_MEMBER_CHUNK = 500;

function chunked(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Move a run's bars onto the plan.
 *
 * WHY THIS IS BATCHED AND `insertEntry` IS NOT
 * -------------------------------------------
 * Everything a bar needs to be checked against — is the task still live, is it
 * already on another bar, how many minutes is it — is the same question asked of
 * a few thousand task ids, so it is asked ONCE for all of them and answered from
 * memory. `planDateFor` was the worst of it: two queries per bar for the plant's
 * timezone, which does not change between bars.
 *
 * The entry ids come back by SELECTing on `run_item_id` rather than by trusting
 * a multi-row INSERT's first insertId and counting up. MySQL only makes ids
 * contiguous under some autoinc lock modes and TiDB does not promise it at all,
 * so counting up would silently attach members to the wrong bars.
 *
 * ONE BEHAVIOUR TO PRESERVE: the sequential version caught a task claimed twice
 * WITHIN one run, because each insert was visible to the next item's check. With
 * the inserts deferred to the end, that is what `claimed` is for.
 */
export async function acceptRun(companyId, runId, { runItemIds = null, pin = false } = {}, userId = null) {
  const [[run]] = await cachedQuery(`SELECT id, status FROM fab_plan_runs
      WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, runId],
  );
  if (!run) throw new PlanError('RUN_NOT_FOUND', `Plan run ${runId} does not exist.`);

  const params = [companyId, runId];
  let filter = '';
  if (Array.isArray(runItemIds) && runItemIds.length > 0) { filter = ' AND id IN (?)'; params.push(runItemIds); }
  const [items] = await cachedQuery(`SELECT * FROM fab_plan_run_items
      WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL${filter}
      ORDER BY planned_start ASC, id ASC`,
    params,
  );
  if (items.length === 0) return { accepted: 0, skipped: [] };

  // ── parse every item once ──────────────────────────────────────────────────
  const parsed = [];
  const skipped = [];
  const allTaskIds = new Set();
  for (const item of items) {
    let taskIds = [];
    try { taskIds = JSON.parse(item.task_ids ?? '[]'); } catch { taskIds = []; }
    taskIds = taskIds.map(Number).filter(Boolean);
    if (taskIds.length === 0) { skipped.push({ runItemId: item.id, reason: 'no tasks' }); continue; }

    // The levelled per-task spans the run froze, positionally parallel to
    // task_ids. Runs written before that column exists simply have none.
    const taskTimes = new Map();
    try {
      const raw = JSON.parse(item.task_times ?? 'null');
      if (Array.isArray(raw)) {
        raw.forEach((pair, i) => {
          const id = taskIds[i];
          if (id && Array.isArray(pair) && pair.length === 2) {
            taskTimes.set(id, { start: new Date(pair[0]), end: new Date(pair[1]) });
          }
        });
      }
    } catch { /* a malformed run item falls back to apportioning */ }

    parsed.push({ item, taskIds, taskTimes });
    for (const id of taskIds) allTaskIds.add(id);
  }
  if (parsed.length === 0) return { accepted: 0, skipped };

  // ── three questions, asked once for every task instead of once per bar ─────
  const ids = [...allTaskIds];
  const [liveRows] = await cachedQuery(`SELECT id, computed_hours AS computedHours, setup_hours AS setupHours, task_qty AS taskQty
       FROM fab_project_tasks
      WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL
        AND status NOT IN ('cancelled','done')`,
    [companyId, ids],
  );
  const live = new Map(liveRows.map((r) => [Number(r.id), taskMinutes(r)]));

  const [plannedRows] = await cachedQuery(`SELECT et.task_id AS taskId, e.id AS entryId
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id
                             AND e.company_id = et.company_id
                             AND e.status = 'planned' AND e.deleted_at IS NULL
      WHERE et.company_id = ? AND et.task_id IN (?) AND et.deleted_at IS NULL`,
    [companyId, ids],
  );
  const alreadyOn = new Map(plannedRows.map((r) => [Number(r.taskId), r.entryId]));

  const tz = await plannerTimezone(companyId);

  // ── decide every bar in memory ─────────────────────────────────────────────
  const entryRows = [];
  const membersByRunItem = new Map();
  const claimed = new Map();
  for (const { item, taskIds, taskTimes } of parsed) {
    // The world moved between suggesting and accepting: tasks get started,
    // finished, cancelled and re-materialized. Skipping the item with a reason
    // beats writing a plan entry for work that no longer exists.
    const liveIds = taskIds.filter((id) => live.has(id));
    if (liveIds.length === 0) { skipped.push({ runItemId: item.id, reason: 'tasks no longer plannable' }); continue; }

    const clash = liveIds.find((id) => alreadyOn.has(id) || claimed.has(id));
    if (clash != null) {
      const reason = alreadyOn.has(clash)
        ? `Task ${clash} is already on plan entry ${alreadyOn.get(clash)}.`
        : `Task ${clash} is already on another bar in this run (item ${claimed.get(clash)}).`;
      skipped.push({ runItemId: item.id, reason });
      continue;
    }
    for (const id of liveIds) claimed.set(id, item.id);

    const start = new Date(item.planned_start);
    const end = new Date(item.planned_end);
    entryRows.push([
      companyId, zonedYMD(start, tz), item.resource_type_id, item.resource_id ?? null,
      toDateTimeStr(start), toDateTimeStr(end), Math.round(item.planned_minutes || 0),
      liveIds.length > 1 ? 'bundle' : 'task',
      item.bundle_key ? String(item.bundle_key).slice(0, 190) : null,
      item.ancestor_item_id ?? null, item.order_id ?? null, item.operation_id ?? null,
      'suggested', runId, item.id, pin ? 1 : 0, 'planned',
      item.label ? String(item.label).slice(0, 255) : null, null, userId, userId,
    ]);
    membersByRunItem.set(item.id, liveIds.map((taskId, i) => {
      const span = taskTimes.get(taskId);
      return [taskId, live.get(taskId) ?? 0, i,
        span ? toDateTimeStr(span.start) : null,
        span ? toDateTimeStr(span.end) : null];
    }));
  }
  if (entryRows.length === 0) return { accepted: 0, skipped };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const batch of chunked(entryRows, ACCEPT_ENTRY_CHUNK)) {
      await conn.query(
        `INSERT INTO fab_plan_entries
           (company_id, plan_date, resource_type_id, resource_id, planned_start,
            planned_end, planned_minutes, kind, bundle_key, ancestor_item_id,
            order_id, operation_id, source, accepted_from_run_id, run_item_id,
            is_pinned, status, label, notes, created_by, updated_by)
         VALUES ?`,
        [batch],
      );
    }

    // By run_item_id, never by counting up from the first insertId — see above.
    const [made] = await conn.query(
      `SELECT id, run_item_id AS runItemId FROM fab_plan_entries
        WHERE company_id = ? AND accepted_from_run_id = ? AND run_item_id IN (?)
          AND deleted_at IS NULL`,
      [companyId, runId, [...membersByRunItem.keys()]],
    );
    const entryIdOf = new Map(made.map((r) => [r.runItemId, r.id]));

    const memberRows = [];
    for (const [runItemId, members] of membersByRunItem) {
      const entryId = entryIdOf.get(runItemId);
      if (entryId == null) {
        throw new PlanError('ACCEPT_FAILED', `Bar for run item ${runItemId} did not come back after insert.`);
      }
      for (const [taskId, minutes, sortOrder, ts, te] of members) {
        memberRows.push([companyId, entryId, taskId, minutes, sortOrder, ts, te]);
      }
    }
    for (const batch of chunked(memberRows, ACCEPT_MEMBER_CHUNK)) {
      await conn.query(
        `INSERT INTO fab_plan_entry_tasks
           (company_id, plan_entry_id, task_id, planned_minutes, sort_order,
            planned_start, planned_end)
         VALUES ?`,
        [batch],
      );
    }

    await conn.query(
      `UPDATE fab_plan_runs SET status = 'accepted', accepted_at = UTC_TIMESTAMP(), accepted_by = ?
        WHERE company_id = ? AND id = ?`,
      [userId, companyId, runId],
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  /**
   * Now give every task a machine.
   *
   * After the transaction, not inside it. The assignment is derived from what
   * was just written and reads it back, so it cannot see the rows until they
   * are committed — and a failure here leaves a plan that is correct but not
   * yet split across machines, which is recoverable, where a rollback would
   * throw away a good plan over a presentational detail.
   *
   * The leveller has already held concurrency at or below the machine count, so
   * this is a colouring pass with nothing to decide. See planMachineService.
   */
  let machines = null;
  try {
    machines = await assignMachines(companyId);
  } catch (err) {
    logger.warn({ err, companyId, runId }, 'plan accepted but machine assignment failed');
  }
  return { accepted: entryRows.length, skipped, machines };
}

/** Move, resize or pin an entry. A move re-checks the DAG gate. */
export async function updateEntry(companyId, entryId, patch, userId = null) {
  const [[entry]] = await cachedQuery(`SELECT * FROM fab_plan_entries
      WHERE company_id = ? AND id = ? AND status = 'planned' AND deleted_at IS NULL`,
    [companyId, entryId],
  );
  if (!entry) throw new PlanError('ENTRY_NOT_FOUND', `Plan entry ${entryId} does not exist.`);

  const [members] = await cachedQuery(`SELECT task_id AS taskId FROM fab_plan_entry_tasks
      WHERE company_id = ? AND plan_entry_id = ? AND deleted_at IS NULL`,
    [companyId, entryId],
  );
  const taskIds = members.map((m) => Number(m.taskId));

  const start = patch.plannedStart ? new Date(patch.plannedStart) : new Date(entry.planned_start);
  const duration = new Date(entry.planned_end).getTime() - new Date(entry.planned_start).getTime();
  const end = patch.plannedEnd
    ? new Date(patch.plannedEnd)
    : new Date(start.getTime() + duration);

  if (patch.plannedStart || patch.plannedEnd) {
    // No assertMaterialAvailable here, deliberately. That gate stops work being
    // GIVEN a date it cannot hold; a bar that already has one and has since gone
    // short needs to be moved LATER, and refusing the move would leave the only
    // sensible response to a shortage unavailable — the planner would have to
    // delete the bar and lose its history to say "this slipped".
    await assertDagAllows(companyId, taskIds, start, { excludeEntryId: entryId });
  }

  const planDate = await planDateFor(companyId, start);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE fab_plan_entries
          SET planned_start = ?, planned_end = ?, plan_date = ?,
              resource_id = ?, is_pinned = ?, notes = ?, updated_by = ?
        WHERE company_id = ? AND id = ?`,
      [toDateTimeStr(start), toDateTimeStr(end), planDate,
       patch.resourceId !== undefined ? patch.resourceId : entry.resource_id,
       patch.isPinned !== undefined ? (patch.isPinned ? 1 : 0) : entry.is_pinned,
       patch.notes !== undefined ? patch.notes : entry.notes,
       userId, companyId, entryId],
    );
    // The members move with the bar, or their stored times start describing
    // where it used to be. Same transaction, or a crash between the two leaves
    // exactly that.
    await remapMemberTimes(
      conn, companyId, entryId,
      entry.planned_start, entry.planned_end, start, end,
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { entryId };
}

/**
 * Split a bundle. With no `taskIds` given it explodes into one entry per task;
 * with them, the named tasks move to a new entry and the rest stay.
 *
 * Both halves keep the original span rather than being re-levelled: splitting is
 * an act of saying "these are separate", not of asking for a new schedule. The
 * planner moves them next, and the engine is there for when they want the
 * computer's opinion instead.
 */
export async function splitEntry(companyId, entryId, { taskIds = null } = {}, userId = null) {
  const [[entry]] = await cachedQuery(`SELECT * FROM fab_plan_entries
      WHERE company_id = ? AND id = ? AND status = 'planned' AND deleted_at IS NULL`,
    [companyId, entryId],
  );
  if (!entry) throw new PlanError('ENTRY_NOT_FOUND', `Plan entry ${entryId} does not exist.`);

  const [members] = await cachedQuery(`SELECT et.task_id AS taskId, et.planned_minutes AS plannedMinutes,
            et.planned_start AS taskStart, et.planned_end AS taskEnd,
            i.name AS itemName, op.name AS operationName
       FROM fab_plan_entry_tasks et
       JOIN fab_project_tasks t ON t.id = et.task_id
       LEFT JOIN fab_items i    ON i.id = t.item_id AND i.deleted_at IS NULL
       LEFT JOIN fab_operations op ON op.id = t.operation_id
      WHERE et.company_id = ? AND et.plan_entry_id = ? AND et.deleted_at IS NULL
      ORDER BY et.sort_order ASC`,
    [companyId, entryId],
  );
  if (members.length < 2) throw new PlanError('NOT_SPLITTABLE', 'This entry has only one task.');

  const moving = Array.isArray(taskIds) && taskIds.length > 0
    ? new Set(taskIds.map(Number))
    : null;

  const groups = moving
    ? [members.filter((m) => moving.has(Number(m.taskId))), members.filter((m) => !moving.has(Number(m.taskId)))]
    : members.map((m) => [m]);
  const usable = groups.filter((g) => g.length > 0);
  if (usable.length < 2) throw new PlanError('NOT_SPLITTABLE', 'That split would leave one group.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE fab_plan_entries SET status = 'superseded', updated_by = ?
        WHERE company_id = ? AND id = ?`,
      [userId, companyId, entryId],
    );
    await conn.query(
      `UPDATE fab_plan_entry_tasks SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND plan_entry_id = ?`,
      [companyId, entryId],
    );

    const created = [];
    for (const group of usable) {
      const minutes = group.reduce((n, m) => n + (Number(m.plannedMinutes) || 0), 0);
      const label = group.length > 1
        ? `${group[0].operationName ?? 'Operation'} · ${group.length} items`
        : `${group[0].operationName ?? 'Operation'} · ${group[0].itemName ?? `task ${group[0].taskId}`}`;
      created.push(await insertEntry(conn, companyId, {
        resourceTypeId: entry.resource_type_id,
        resourceId: entry.resource_id,
        plannedStart: new Date(entry.planned_start),
        plannedEnd: new Date(entry.planned_end),
        plannedMinutes: minutes,
        taskIds: group.map((m) => Number(m.taskId)),
        // Both halves keep the original span, so each member keeps its own
        // levelled time inside it — splitting says "these are separate", not
        // "reschedule these".
        taskTimes: new Map(group
          .filter((m) => m.taskStart != null && m.taskEnd != null)
          .map((m) => [Number(m.taskId), { start: new Date(m.taskStart), end: new Date(m.taskEnd) }])),
        bundleKey: group.length > 1 ? entry.bundle_key : null,
        ancestorItemId: entry.ancestor_item_id,
        orderId: entry.order_id,
        operationId: entry.operation_id,
        source: entry.source,
        acceptedFromRunId: entry.accepted_from_run_id,
        isPinned: true,
        label,
        userId,
      }, entry.plan_date));
    }

    await conn.commit();
    return { entryIds: created };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Remove an entry from the plan. Soft — the run that suggested it stays intact. */
export async function deleteEntry(companyId, entryId, userId = null) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [res] = await conn.query(
      `UPDATE fab_plan_entries SET status = 'cancelled', deleted_at = UTC_TIMESTAMP(), updated_by = ?
        WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
      [userId, companyId, entryId],
    );
    await conn.query(
      `UPDATE fab_plan_entry_tasks SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND plan_entry_id = ? AND deleted_at IS NULL`,
      [companyId, entryId],
    );
    await conn.commit();
    return { removed: res.affectedRows > 0 };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}


/**
 * A suggestion, read back — including which of it is already on the plan.
 *
 * A suggestion used to exist only in the response that created it. Close the
 * page and it was gone, and the only way to see it again was to compute a new
 * one, which is a minute of levelling and a different answer. That is fine when
 * the only choice is "accept all of it or none", and useless when somebody is
 * working through it a few bars at a time.
 *
 * `accepted` comes from fab_plan_entries.run_item_id rather than a flag on the
 * run item, because the plan is the truth: a bar that was accepted and later
 * deleted should read as not accepted, and a flag would have to be maintained
 * in two places to say so.
 *
 * @returns {Promise<{run:object, items:object[]}>}
 */
export async function readRun(companyId, runId) {
  const [[run]] = await pool.query(
    `SELECT id, status, window_from AS windowFrom, window_to AS windowTo,
            anchor_at AS anchorAt, created_at AS createdAt,
            accepted_at AS acceptedAt
       FROM fab_plan_runs
      WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, runId],
  );
  if (!run) throw new PlanError('RUN_NOT_FOUND', `Plan run ${runId} does not exist.`);

  const [items] = await pool.query(
    `SELECT ri.id AS runItemId, ri.resource_type_id AS resourceTypeId,
            ri.resource_id AS resourceId, ri.ancestor_item_id AS ancestorItemId,
            ri.order_id AS orderId, ri.planned_start AS plannedStart,
            ri.planned_end AS plannedEnd, ri.planned_minutes AS plannedMinutes,
            ri.task_count AS taskCount, ri.task_ids AS taskIds,
            ri.is_critical_chain AS isCriticalChain, ri.reason, ri.label,
            rt.name AS resourceTypeName, r.name AS resourceName,
            o.order_number AS orderNumber,
            i.code AS ancestorCode, i.name AS ancestorName,
            (SELECT COUNT(*) FROM fab_plan_entries e
              WHERE e.company_id = ri.company_id AND e.run_item_id = ri.id
                AND e.status = 'planned' AND e.deleted_at IS NULL) AS onPlan
       FROM fab_plan_run_items ri
       LEFT JOIN fab_resource_types rt ON rt.id = ri.resource_type_id
       LEFT JOIN fab_resources r ON r.id = ri.resource_id
       LEFT JOIN fab_orders o ON o.id = ri.order_id AND o.deleted_at IS NULL
       LEFT JOIN fab_items i ON i.id = ri.ancestor_item_id AND i.deleted_at IS NULL
      WHERE ri.company_id = ? AND ri.run_id = ? AND ri.deleted_at IS NULL
      ORDER BY ri.planned_start ASC, ri.id ASC`,
    [companyId, runId],
  );

  return {
    run,
    items: items.map((r) => {
      let taskIds = [];
      try { taskIds = JSON.parse(r.taskIds ?? '[]'); } catch { taskIds = []; }
      return {
        runItemId: r.runItemId,
        resourceTypeId: r.resourceTypeId,
        resourceTypeName: r.resourceTypeName,
        resourceId: r.resourceId,
        resourceName: r.resourceName,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        ancestorItemId: r.ancestorItemId,
        ancestorCode: r.ancestorCode,
        ancestorName: r.ancestorName,
        plannedStart: r.plannedStart,
        plannedEnd: r.plannedEnd,
        plannedMinutes: r.plannedMinutes,
        taskCount: r.taskCount,
        taskIds,
        isCriticalChain: !!r.isCriticalChain,
        reason: r.reason,
        label: r.label,
        /** Already on the plan — ticking it again would do nothing. */
        accepted: Number(r.onPlan) > 0,
      };
    }),
  };
}

/**
 * The most recent suggestions, newest first.
 *
 * So a board can offer "the one you were working through" without the client
 * having to remember a run id across a reload.
 */
export async function listRuns(companyId, { limit = 10 } = {}) {
  const [rows] = await pool.query(
    `SELECT r.id, r.status, r.created_at AS createdAt, r.accepted_at AS acceptedAt,
            r.window_from AS windowFrom, r.window_to AS windowTo,
            (SELECT COUNT(*) FROM fab_plan_run_items ri
              WHERE ri.company_id = r.company_id AND ri.run_id = r.id AND ri.deleted_at IS NULL) AS itemCount,
            (SELECT COUNT(*) FROM fab_plan_run_items ri
               JOIN fab_plan_entries e ON e.company_id = ri.company_id AND e.run_item_id = ri.id
                AND e.status = 'planned' AND e.deleted_at IS NULL
              WHERE ri.company_id = r.company_id AND ri.run_id = r.id AND ri.deleted_at IS NULL) AS acceptedCount
       FROM fab_plan_runs r
      WHERE r.company_id = ? AND r.deleted_at IS NULL
      ORDER BY r.id DESC
      LIMIT ?`,
    [companyId, Math.min(50, Math.max(1, Number(limit) || 10))],
  );
  return rows;
}

/**
 * Take a whole plan off the board.
 *
 * Re-planning means clearing what is there first — `acceptRun` skips any task
 * already on a bar, so a fresh suggestion lands on nothing until the old plan is
 * gone. Until this existed the only way to do that was `deleteEntry` in a loop:
 * sixteen hundred transactions, several minutes, and a mass delete dressed up as
 * ordinary traffic.
 *
 * WHAT IT WILL NOT REMOVE
 * Bars whose work has started, and bars a human pinned. Started work is the
 * record of what the shop actually did — retiring it would drop the link between
 * the plan and the hours booked against it — and a pin is somebody saying "not
 * this one". Both are counted and returned rather than skipped quietly, so a
 * re-plan that does not come back empty explains itself.
 *
 * DECIDED IN A SELECT, NOT IN THE UPDATE
 * The obvious form — UPDATE ... WHERE NOT EXISTS (subquery on the same table) —
 * needs a derived table to satisfy MySQL, which materialises the whole member
 * table. On TiDB that is how you hit the instance memory limit. Reading the ids
 * first and writing them in chunks is both cheaper and easier to reason about.
 *
 * Scope to `orderIds` for one job's plan; omit it for the whole board. There is
 * deliberately no implicit "everything" — this is destructive, and the caller
 * should have to name the blast radius.
 *
 * @returns {Promise<{retired:number, keptStarted:number, keptPinned:number}>}
 */
export async function retirePlan(companyId, { orderIds = null } = {}, userId = null) {
  const scoped = Array.isArray(orderIds) && orderIds.length > 0;
  const params = [companyId];
  let filter = '';
  if (scoped) { filter = ' AND e.order_id IN (?)'; params.push(orderIds); }

  const [rows] = await cachedQuery(`SELECT e.id,
            e.is_pinned AS isPinned,
            EXISTS (
              SELECT 1 FROM fab_plan_entry_tasks et
               JOIN fab_project_tasks t ON t.id = et.task_id AND t.deleted_at IS NULL
               WHERE et.company_id = e.company_id AND et.plan_entry_id = e.id
                 AND et.deleted_at IS NULL AND t.status IN ('in_progress','done')
            ) AS started
       FROM fab_plan_entries e
      WHERE e.company_id = ? AND e.status = 'planned' AND e.deleted_at IS NULL${filter}`,
    params,
  );

  let keptStarted = 0;
  let keptPinned = 0;
  const doomed = [];
  for (const r of rows) {
    if (r.isPinned) { keptPinned += 1; continue; }
    if (r.started) { keptStarted += 1; continue; }
    doomed.push(r.id);
  }
  if (doomed.length === 0) return { retired: 0, keptStarted, keptPinned };

  const CHUNK = 500;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let retired = 0;
    for (let i = 0; i < doomed.length; i += CHUNK) {
      const ids = doomed.slice(i, i + CHUNK);
      await conn.query(
        `UPDATE fab_plan_entry_tasks SET deleted_at = UTC_TIMESTAMP()
          WHERE company_id = ? AND plan_entry_id IN (?) AND deleted_at IS NULL`,
        [companyId, ids],
      );
      const [res] = await conn.query(
        `UPDATE fab_plan_entries
            SET status = 'cancelled', deleted_at = UTC_TIMESTAMP(), updated_by = ?
          WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
        [userId, companyId, ids],
      );
      retired += res.affectedRows ?? 0;
    }
    await conn.commit();
    return { retired, keptStarted, keptPinned };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Unplanned work, for the backlog rail beside the grid.
 *
 * Ordered the same way the engine ranks, so hand-planning down the list and
 * accepting a suggestion produce broadly the same shop — the manual path should
 * not quietly disagree with the computed one.
 */
export async function getBacklog(companyId, { resourceTypeIds = [], limit = 200 } = {}) {
  const params = [companyId];
  let filter = '';
  if (resourceTypeIds.length > 0) { filter = ' AND t.resource_type_id IN (?)'; params.push(resourceTypeIds); }
  params.push(limit);

  const [rows] = await cachedQuery(`SELECT t.id, t.order_id AS orderId, t.item_id AS itemId, t.seq_no AS seqNo,
            t.status, t.resource_type_id AS resourceTypeId,
            t.assigned_resource_id AS resourceId, t.computed_hours AS computedHours, t.setup_hours AS setupHours, t.task_qty AS taskQty,
            i.name AS itemName, i.parent_item_id AS parentItemId,
            op.name AS operationName, op.id AS operationId,
            o.order_number AS orderNumber, o.priority_rank AS priorityRank,
            o.required_date AS requiredDate, o.must_finish_by AS mustFinishBy
       FROM fab_project_tasks t
       LEFT JOIN fab_items i      ON i.id = t.item_id AND i.deleted_at IS NULL
       LEFT JOIN fab_operations op ON op.id = t.operation_id
       LEFT JOIN fab_orders o     ON o.id = t.order_id AND o.deleted_at IS NULL
      WHERE t.company_id = ? AND t.deleted_at IS NULL
        AND t.status IN ('blocked','eligible')
        AND NOT EXISTS (
          SELECT 1 FROM fab_plan_entry_tasks et
           JOIN fab_plan_entries e ON e.id = et.plan_entry_id
                                 AND e.company_id = et.company_id
                                 AND e.status = 'planned' AND e.deleted_at IS NULL
           WHERE et.company_id = t.company_id AND et.task_id = t.id
             AND et.deleted_at IS NULL
        )${filter}
      ORDER BY o.priority_rank IS NULL, o.priority_rank ASC,
               o.required_date IS NULL, o.required_date ASC,
               t.seq_no ASC, t.id ASC
      LIMIT ?`,
    params,
  );

  return decorateBlocked(companyId, rows);
}

/**
 * The orders a suggestion over this window would actually be sequencing.
 *
 * The ground rules a planner sets before pressing Suggest — which order matters,
 * and which dates are not up for negotiation — are per-ORDER, so the step needs
 * a list of orders rather than of tasks. Scoped to orders with unplanned,
 * non-material-blocked work in the window: everything on the list is something
 * this run could place, and an order with nothing to schedule is noise on a
 * screen whose job is to be read in ten seconds.
 *
 * Returns the current values plus how much work is at stake, so the sequence can
 * be judged against the size of what it is sequencing.
 */
export async function getPlanOrders(companyId, { from, to, resourceTypeIds = [] } = {}) {
  const params = [companyId];
  let typeFilter = '';
  if (resourceTypeIds.length > 0) { typeFilter = ' AND t.resource_type_id IN (?)'; params.push(resourceTypeIds); }

  const [rows] = await cachedQuery(`SELECT o.id AS orderId, o.order_number AS orderNumber, o.customer_name AS customerName,
            o.priority, o.priority_rank AS priorityRank,
            o.must_finish_by AS mustFinishBy, o.required_date AS requiredDate,
            COUNT(t.id) AS taskCount,
            -- Mirrors taskDuration.taskHours() exactly: setup once, run per piece.
            -- Kept as SQL because this is a GROUP BY rollup over every backlog
            -- task; pulling the rows into JS to add them up would be the one
            -- place the two definitions could drift.
            COALESCE(SUM(COALESCE(t.setup_hours, 0)
                       + COALESCE(t.computed_hours, 0) * COALESCE(t.task_qty, 1)), 0) AS totalHours
       FROM fab_project_tasks t
       JOIN fab_orders o ON o.id = t.order_id AND o.deleted_at IS NULL
      WHERE t.company_id = ? AND t.deleted_at IS NULL
        AND t.status IN ('blocked','eligible')
        AND NOT EXISTS (
          SELECT 1 FROM fab_plan_entry_tasks et
           JOIN fab_plan_entries e ON e.id = et.plan_entry_id
                                 AND e.company_id = et.company_id
                                 AND e.status = 'planned' AND e.deleted_at IS NULL
           WHERE et.company_id = t.company_id AND et.task_id = t.id AND et.deleted_at IS NULL
        )${typeFilter}
      GROUP BY o.id, o.order_number, o.customer_name, o.priority, o.priority_rank,
               o.must_finish_by, o.required_date`,
    params,
  );

  // Material-blocked work is not schedulable (see assertMaterialAvailable), so
  // an order whose only remaining work is waiting on steel has nothing at stake
  // in this run and does not belong on the list.
  const slackOf = () => Number.POSITIVE_INFINITY;
  const ordered = rows
    .map((r) => ({ ...r, taskCount: Number(r.taskCount), totalHours: Number(r.totalHours) }))
    .sort((a, b) => compareOrders(a, b, slackOf));

  return ordered.map((o) => ({ ...o, rankReason: rankReason(o) }));
}

/**
 * Save the ground rules, as one act.
 *
 * `must_finish_by` is written here rather than through the generic /mutate path
 * on purpose: it is a commitment ("this date does not move"), and the generic
 * writer would let it be set as casually as a note. `priority_rank` is rewritten
 * from the submitted ORDER of the list, so the sequence a planner arranged is
 * what gets stored — asking somebody to type rank numbers is asking them to
 * maintain a sorted list by hand.
 *
 * @param {Array<{orderId:number, priority?:string|null, mustFinishBy?:string|null}>} orders
 *        in the sequence they should run.
 */
export async function savePlanOrderRules(companyId, orders) {
  const rows = (Array.isArray(orders) ? orders : [])
    .map((o) => ({ ...o, orderId: Number(o.orderId) }))
    .filter((o) => Number.isFinite(o.orderId));
  if (!rows.length) return { updated: 0 };

  for (const o of rows) {
    if (o.priority != null && o.priority !== ''
        && !PRIORITY_LEVELS.includes(String(o.priority).toLowerCase())) {
      throw new PlanError('BAD_PRIORITY', `"${o.priority}" is not a priority level.`, { orderId: o.orderId });
    }
    if (o.mustFinishBy != null && o.mustFinishBy !== ''
        && !/^\d{4}-\d{2}-\d{2}$/.test(String(o.mustFinishBy))) {
      throw new PlanError('BAD_DATE', 'A finish-by date must be YYYY-MM-DD.', { orderId: o.orderId });
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let updated = 0;
    for (const [i, o] of rows.entries()) {
      const [res] = await conn.query(
        `UPDATE fab_orders
            SET priority = ?, priority_rank = ?, must_finish_by = ?
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
        [
          o.priority ? String(o.priority).toLowerCase() : null,
          // 1-based: "#1" reads as first. Every order in the list gets one, so a
          // partially-ranked shop cannot arise from this screen.
          i + 1,
          o.mustFinishBy || null,
          o.orderId, companyId,
        ],
      );
      updated += res.affectedRows > 0 ? 1 : 0;
    }
    await conn.commit();
    return { updated };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Say WHY each blocked row is blocked, and where it could go.
 *
 * The rail used to render the bare word "blocked", which is true and useless:
 * it does not distinguish the task that becomes plannable the moment you place
 * its predecessor from the one that cannot be planned at all until steel turns
 * up, and those need opposite actions. Worse, it read as "you cannot plan this",
 * so the case the planner is FOR — laying a chain out in order — looked
 * forbidden.
 *
 * Each blocked row comes back with:
 *   blockedBy      'material' | 'predecessor' | 'both' | null
 *   plannable      false only for material, which no arrangement of the plan fixes
 *   waitingFor[]   the predecessors, each with whether it is planned and when it ends
 *   earliestStart  the latest predecessor end — the first instant this may be
 *                  placed, so the UI can offer it instead of making somebody
 *                  discover it by being refused
 */
async function decorateBlocked(companyId, rows) {
  const blocked = rows.filter((r) => r.status === 'blocked');
  if (!blocked.length) return rows.map((r) => ({ ...r, blockedBy: null, plannable: true }));

  const gates = await outstandingGatesFor(companyId, blocked.map((r) => r.id));

  // Predecessors, resolved per order so an edge to a task outside the backlog is
  // still found — the blocking task is usually NOT itself in this list.
  const orderIds = [...new Set(blocked.map((r) => r.orderId).filter((x) => x != null))];
  const predsByTask = new Map();
  const byId = new Map();
  if (orderIds.length) {
    const [siblings] = await cachedQuery(`SELECT t.id, t.order_id, t.item_id, t.flow_id, t.seq_no, t.depends_on, t.status,
              op.name AS operationName, i.name AS itemName
         FROM fab_project_tasks t
         LEFT JOIN fab_operations op ON op.id = t.operation_id
         LEFT JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
        WHERE t.company_id = ? AND t.order_id IN (?) AND t.deleted_at IS NULL
          AND t.status <> 'cancelled'`,
      [companyId, orderIds],
    );
    for (const s of siblings) byId.set(s.id, s);
    const edges = await buildEdges({ companyId, tasks: siblings });
    for (const e of edges) {
      if (!predsByTask.has(e.to)) predsByTask.set(e.to, []);
      predsByTask.get(e.to).push(e.from);
    }
  }

  // Where those predecessors currently sit on the plan.
  const predIds = [...new Set([...predsByTask.values()].flat())];
  const plannedEnd = new Map();
  if (predIds.length) {
    const [pe] = await cachedQuery(`SELECT et.task_id AS taskId, MAX(e.planned_end) AS plannedEnd
         FROM fab_plan_entry_tasks et
         JOIN fab_plan_entries e ON e.id = et.plan_entry_id
                               AND e.company_id = et.company_id
                               AND e.status = 'planned' AND e.deleted_at IS NULL
        WHERE et.company_id = ? AND et.task_id IN (?) AND et.deleted_at IS NULL
        GROUP BY et.task_id`,
      [companyId, predIds],
    );
    for (const r of pe) plannedEnd.set(Number(r.taskId), new Date(r.plannedEnd));
  }

  return rows.map((r) => {
    if (r.status !== 'blocked') return { ...r, blockedBy: null, plannable: true, waitingFor: [] };

    const gate = gates.get(r.id);
    const material = isMaterialBlocked(gate);

    const waitingFor = (predsByTask.get(r.id) ?? [])
      .map((pid) => byId.get(pid))
      .filter((p) => p && p.status !== 'done')
      .map((p) => {
        const end = plannedEnd.get(Number(p.id)) ?? null;
        return {
          taskId: p.id,
          seqNo: p.seq_no,
          operationName: p.operationName ?? null,
          itemName: p.itemName ?? null,
          planned: !!end,
          plannedEnd: end ? end.toISOString() : null,
        };
      });

    const unplanned = waitingFor.filter((w) => !w.planned);
    const ends = waitingFor.map((w) => w.plannedEnd).filter(Boolean);

    return {
      ...r,
      blockedBy: material && waitingFor.length ? 'both' : material ? 'material'
        : waitingFor.length ? 'predecessor' : null,
      // Only material makes a task unplannable. A predecessor is a thing you
      // schedule, which is the point.
      plannable: !material,
      waitingFor,
      // Null while any predecessor is still unplanned — there is no earliest
      // legal instant yet, and inventing one would be a guess.
      earliestStart: material || unplanned.length || !ends.length
        ? null
        : new Date(Math.max(...ends.map((e) => +new Date(e)))).toISOString(),
    };
  });
}

// ─── the board ────────────────────────────────────────────────────────────────

/**
 * Every ancestor of `itemIds`, walked up parent_item_id one generation at a time.
 *
 * The BOM is a tree of unbounded depth, so a fixed join count cannot express
 * this, and a recursive CTE is not portable to every MySQL/TiDB version this
 * runs on. The walk is bounded by MAX_BOM_DEPTH rather than by trust: a cycle in
 * parent_item_id would otherwise loop forever, and a cycle is exactly the kind
 * of thing a bad import produces.
 */
const MAX_BOM_DEPTH = 24;
async function itemAncestry(companyId, itemIds) {
  const known = new Map();
  let frontier = [...new Set(itemIds.filter((x) => x != null))];
  for (let depth = 0; depth < MAX_BOM_DEPTH && frontier.length > 0; depth += 1) {
    const [rows] = await cachedQuery(`SELECT id, parent_item_id AS parentItemId, order_id AS orderId,
              order_line_id AS orderLineId, level_kind AS levelKind,
              name, code, mark
         FROM fab_items
        WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
      [companyId, frontier],
    );
    const next = [];
    for (const r of rows) {
      if (known.has(r.id)) continue;
      known.set(r.id, r);
      if (r.parentItemId != null && !known.has(r.parentItemId)) next.push(r.parentItemId);
    }
    frontier = [...new Set(next)];
  }
  return [...known.values()];
}

/**
 * The board: the same plan the grid draws, in the shape a canvas can paint.
 *
 * WHY THIS IS NOT `getPlan`
 * -------------------------
 * The grid draws one absolutely-positioned element per BAR over one to seven
 * days. The board draws one block per OPERATION over as much as five weeks, and
 * a real bridge order is several thousand operations — enough that the DOM is
 * the wrong tool and the per-bar JSON (order number, operation name, resource
 * name, notes, repeated on every row) is most of the payload.
 *
 * So this returns the geometry as flat number tuples and the words ONCE, in
 * lookup tables the client joins against. Two consequences worth knowing:
 *
 *   - Times are milliseconds RELATIVE to `from`. Absolute epoch ms would be
 *     ~13 digits on every one of ~40,000 numbers; relative ones are 5–8.
 *   - A bundle is expanded into its member tasks, laid end to end inside the
 *     bundle's span in proportion to each task's minutes. The bundle is one bar
 *     on the grid and one machine setup in reality, but the planner is looking
 *     for GAPS here, and a bundle drawn as a single solid block hides how much
 *     of it is actually work.
 *
 * No per-day capacity roll-up: that costs a calendar query per resource per day,
 * which is affordable across seven days and not across thirty-five. The client
 * derives load from the blocks it already has; the coverage segments below are
 * what it needs from the calendar, and they cost one sweep per lane.
 */
export async function getPlanBoard(companyId, { from, to, resourceTypeIds = [], lanesBy = 'type' } = {}) {
  const typeLanes = await loadLanes(companyId, resourceTypeIds);
  /**
   * One lane per MACHINE rather than per type.
   *
   * A type lane with four welders draws four bars side by side and cannot say
   * which welder has what — fine at month zoom, useless on the day a supervisor
   * is standing in front of the machines. Each machine becomes its own lane of
   * capacity one, and blocks are filtered to the tasks assigned to it (see
   * planMachineService for how that assignment is made).
   *
   * A type with no machines on record still gets one lane, so its work does not
   * silently vanish from the board.
   */
  const lanes = lanesBy !== 'machine' ? typeLanes : typeLanes.flatMap((t) => (
    t.resources.length === 0
      ? [{ ...t, machineId: null, machineName: t.name }]
      : t.resources.map((r) => ({
        ...t, machineId: r.id, machineName: r.name, resources: [r],
      }))
  ));
  const entries = await loadEntries(companyId, from, to, resourceTypeIds);
  const tz = await plannerTimezone(companyId);
  const t0 = from.getTime();
  const rel = (d) => Math.round((d instanceof Date ? d : new Date(d)).getTime() - t0);

  const entriesByLane = new Map();
  for (const e of entries) {
    if (!entriesByLane.has(e.resourceTypeId)) entriesByLane.set(e.resourceTypeId, []);
    entriesByLane.get(e.resourceTypeId).push(e);
  }

  const itemIds = [];
  const outLanes = [];
  for (const lane of lanes) {
    const coverage = await laneCoverage(companyId, lane, from, to);
    const laneEntries = entriesByLane.get(lane.id) ?? [];

    const blocks = [];
    for (const e of laneEntries) {
      const s = new Date(e.plannedStart).getTime();
      const span = Math.max(0, new Date(e.plannedEnd).getTime() - s);
      let tasks = e.tasks ?? [];
      // On a machine lane, only the members that run on THIS machine. A bundle
      // can straddle several — 645 of the production plan's bars hold more work
      // than their own span — so a bar is drawn in pieces, one per machine.
      if (lane.machineId != null) tasks = tasks.filter((t) => t.machineId === lane.machineId);
      if (lane.machineId != null && tasks.length === 0) continue;
      if (tasks.length === 0) {
        blocks.push(Math.round(s - t0), Math.round(span), 0, 0, e.id);
        continue;
      }
      // The same apportionment the DAG gate uses, so what the board draws and
      // what the planner is allowed to do agree about when a task finishes.
      const spans = apportionEntry(e.plannedStart, e.plannedEnd, tasks);
      for (const t of tasks) {
        const at = spans.get(Number(t.taskId));
        if (!at) continue;
        blocks.push(
          Math.round(at.start.getTime() - t0),
          Math.max(0, at.end.getTime() - at.start.getTime()),
          t.itemId ?? 0, t.taskId, e.id,
        );
        if (t.itemId != null) itemIds.push(t.itemId);
      }
    }

    outLanes.push({
      resourceTypeId: lane.id,
      /** Set only on a machine lane. Null means this row IS the whole type. */
      machineId: lane.machineId ?? null,
      typeName: lane.name,
      name: lane.machineName ?? lane.name,
      code: lane.code,
      totalUnits: coverage.totalUnits,
      unbounded: coverage.unbounded,
      resourceCount: lane.resources.length,
      // [startRel, endRel, coveredUnits] per segment.
      coverage: coverage.segments.flatMap((c) => [rel(c.start), rel(c.end), c.coveredUnits]),
      // [startRel, durationMs, itemId, taskId, entryId] per block.
      blocks,
      blockCount: blocks.length / 5,
    });
  }

  const items = await itemAncestry(companyId, itemIds);
  const orderIds = [...new Set(entries.map((e) => e.orderId).filter((x) => x != null))];
  const lineIds = [...new Set(items.map((i) => i.orderLineId).filter((x) => x != null))];

  const [orders] = orderIds.length === 0 ? [[]] : await cachedQuery(`SELECT id, order_number AS orderNumber, customer_name AS customerName,
            priority, priority_rank AS priorityRank, required_date AS requiredDate,
            must_finish_by AS mustFinishBy
       FROM fab_orders WHERE company_id = ? AND id IN (?)`,
    [companyId, orderIds],
  );
  const [lines] = lineIds.length === 0 ? [[]] : await cachedQuery(`SELECT id, order_id AS orderId, line_no AS lineNo, code, description
       FROM fab_order_lines WHERE company_id = ? AND id IN (?)`,
    [companyId, lineIds],
  );

  return {
    from,
    to,
    timezone: tz,
    lanes: outLanes,
    items,
    orders,
    lines,
    // The words, once. Every block names an entry; most entries carry many, and
    // an order of any size has thousands of entries but a dozen operation names
    // between them. Repeating the name on every row was most of the payload, so
    // the names live in their own tables and the entry carries the id.
    //
    // `label` survives only where there is no operation to name the bar — it is
    // otherwise "<operation> · <item>", both of which the client already has.
    operations: [...new Map(entries
      .filter((e) => e.operationId != null)
      .map((e) => [e.operationId, { id: e.operationId, name: e.operationName }])).values()],
    resources: [...new Map(entries
      .filter((e) => e.resourceId != null)
      .map((e) => [e.resourceId, { id: e.resourceId, name: e.resourceName }])).values()],
    entries: entries.map((e) => ({
      id: e.id,
      orderId: e.orderId,
      operationId: e.operationId,
      resourceId: e.resourceId,
      isPinned: !!e.isPinned,
      source: e.source,
      ...(e.operationId == null && e.label ? { label: e.label } : {}),
    })),
  };
}
