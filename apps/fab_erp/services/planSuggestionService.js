/**
 * planSuggestionService.js — "what should the shop do this day / this week?"
 *
 * The one genuinely new idea here is that the pass is CROSS-ORDER. Every other
 * scheduling path in fab_erp levels one order at a time
 * (`criticalChainService.buildBaseline({ orderId })`), which means two orders can
 * each be told they have CNC-2 at 09:00 and neither is wrong on its own terms.
 * A day plan built that way is fiction. So this loads every live order's tasks
 * into a single levelSchedule pass and lets them contend for real.
 *
 * Nothing here decides priority from scratch — `dispatchService.computeOrderSlack`
 * already does that, and its file header explains at length why slack is the one
 * formulation that survives re-baselining and re-materialization. This service
 * turns that ordering into a `priority` map and hands it to the leveller.
 *
 * WHAT IS FROZEN AND WHY
 * ----------------------
 * Every run persists, accepted or not (`fab_plan_runs`). The retrospective
 * compares the suggestion against what actually happened, and an "ideal"
 * recomputed later from current data would always look perfect in hindsight —
 * the comparison has to be against what was actually on the table that morning,
 * including the mornings the suggestion was wrong.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It writes nothing to `fab_plan_entries`. Suggesting and accepting are separate
 * acts (planService.acceptRun). A suggestion that took effect on computation
 * would leave the planner nowhere to stand.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { buildEdges, levelSchedule, loadResourceCapacity } from './resourceLevelingService.js';
import { computeOrderSlack } from './dispatchService.js';
import { isNoCapacity } from './schedulingErrors.js';
import { zonedYMD } from './plantTime.js';
import { plannerTimezone } from './planService.js';
import { outstandingGatesFor, isMaterialBlocked } from './taskGatingService.js';
import { compareOrders } from './orderPriority.js';

/** Statuses worth planning. `done`/`cancelled` are history; `in_progress` is already happening. */
const PLANNABLE = new Set(['blocked', 'eligible']);

/**
 * Give up re-levelling after this many unschedulable tasks. Each retry is a full
 * pass, so an uncapped loop on a badly configured shop (no calendars, no crew)
 * would walk the whole task list one DB-heavy pass at a time.
 */
const MAX_DROP_RETRIES = 25;

// ─── loading ──────────────────────────────────────────────────────────────────

/**
 * Every non-cancelled, non-done task on a live order.
 *
 * The FULL set is loaded, not just the plannable slice, because `buildEdges`
 * resolves predecessors by looking them up in the set it is given: pass only the
 * candidates and a task whose predecessor is already `done` looks like a chain
 * head, so it gets scheduled at the anchor instead of after the work it depends
 * on.
 */
async function loadPlanningTasks(companyId) {
  const [rows] = await pool.query(
    `SELECT t.id, t.order_id, t.item_id, t.flow_id, t.seq_no, t.depends_on,
            t.resource_type_id, t.assigned_resource_id, t.status,
            t.computed_hours, t.started_at, t.operation_id,
            i.parent_item_id, i.name AS item_name,
            op.name AS operation_name,
            o.order_number, o.priority_rank, o.priority, o.required_date, o.must_finish_by
       FROM fab_project_tasks t
       LEFT JOIN fab_items i     ON i.id = t.item_id AND i.deleted_at IS NULL
       LEFT JOIN fab_operations op ON op.id = t.operation_id
       LEFT JOIN fab_orders o    ON o.id = t.order_id AND o.deleted_at IS NULL
      WHERE t.company_id = ?
        AND t.deleted_at IS NULL
        AND t.status NOT IN ('cancelled', 'done')`,
    [companyId],
  );
  return rows;
}

/**
 * Capacity already spoken for: work that is running, and bars already on the plan.
 *
 * In-progress tasks are given their REMAINING estimate from now, not their full
 * duration — the hours already burned are not still ahead of the machine.
 */
async function loadPreOccupied(companyId, now) {
  const out = [];

  const [running] = await pool.query(
    `SELECT id, resource_type_id, assigned_resource_id, computed_hours, started_at
       FROM fab_project_tasks
      WHERE company_id = ? AND status = 'in_progress' AND deleted_at IS NULL`,
    [companyId],
  );
  for (const t of running) {
    const totalMin = (Number(t.computed_hours) || 0) * 60;
    const elapsedMin = t.started_at
      ? Math.max(0, (now.getTime() - new Date(t.started_at).getTime()) / 60000)
      : 0;
    // A task already over its estimate still occupies the machine right now.
    // Zero would free it instantly, which is the opposite of what is true.
    const remainingMin = Math.max(totalMin - elapsedMin, 15);
    out.push({
      resource_type_id: t.resource_type_id,
      assigned_resource_id: t.assigned_resource_id,
      start: new Date(now.getTime()),
      end: new Date(now.getTime() + remainingMin * 60000),
    });
  }

  const [planned] = await pool.query(
    `SELECT resource_type_id, resource_id, planned_start, planned_end
       FROM fab_plan_entries
      WHERE company_id = ? AND status = 'planned' AND deleted_at IS NULL
        AND planned_end > ?`,
    [companyId, now],
  );
  for (const e of planned) {
    out.push({
      resource_type_id: e.resource_type_id,
      assigned_resource_id: e.resource_id,
      start: new Date(e.planned_start),
      end: new Date(e.planned_end),
    });
  }

  return out;
}

/** Task ids that already sit on an active plan entry — never suggested twice. */
async function loadPlannedTaskIds(companyId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT et.task_id AS taskId
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id
                             AND e.company_id = et.company_id
                             AND e.status = 'planned' AND e.deleted_at IS NULL
      WHERE et.company_id = ? AND et.deleted_at IS NULL`,
    [companyId],
  );
  return new Set(rows.map((r) => Number(r.taskId)));
}

// ─── priority ─────────────────────────────────────────────────────────────────

/**
 * Rank every order, then stamp each of its tasks with that rank.
 *
 * Ordering mirrors `dispatchService.compare` so the Planner and the ranking that
 * preceded it cannot disagree about which order is in more trouble:
 *
 *   1. a hard `must_finish_by` pin, earliest first — a planning instruction
 *      outranks a computed signal, which is the entire point of having one
 *   2. manual `priority_rank`
 *   3. computed order slack, least first
 *
 * The returned map is taskId → rank, with critical-chain tasks half a step ahead
 * of their own order's feeding work.
 */
function buildPriorityMap(tasks, slackByOrder, criticalTaskIds) {
  const orders = new Map();
  for (const t of tasks) {
    if (t.order_id == null || orders.has(t.order_id)) continue;
    orders.set(t.order_id, {
      orderId: t.order_id,
      priorityRank: t.priority_rank,
      priority: t.priority,
      mustFinishBy: t.must_finish_by,
    });
  }

  const INF = Number.POSITIVE_INFINITY;
  const slackOf = (orderId) => slackByOrder.get(orderId)?.slack ?? INF;
  // The ordering itself lives in orderPriority.js, shared with dispatchService —
  // these two used to hold separate compare functions that already disagreed,
  // and both ignored `fab_orders.priority` entirely. See that file for why the
  // signals rank the way they do.
  const ranked = [...orders.values()].sort((a, b) => compareOrders(a, b, slackOf));

  const orderRank = new Map(ranked.map((o, i) => [o.orderId, i]));
  const priority = new Map();
  for (const t of tasks) {
    const base = (orderRank.get(t.order_id) ?? ranked.length) * 2;
    priority.set(t.id, base + (criticalTaskIds.has(t.id) ? 0 : 1));
  }
  return { priority, orderRank };
}

// ─── levelling with tolerance ─────────────────────────────────────────────────

/**
 * `levelSchedule` throws on the first task it cannot place — correct for a
 * baseline, where a partial answer is a lie. A day plan wants the opposite: one
 * machine with nobody on it must not blank the whole shop. So an unschedulable
 * task is dropped and the pass retried, and the drops are REPORTED rather than
 * quietly missing.
 */
async function levelTolerantly({ companyId, tasks, resourceCapacity, anchor, priority, preOccupied }) {
  let working = tasks;
  const dropped = [];

  for (let attempt = 0; attempt <= MAX_DROP_RETRIES; attempt += 1) {
    const edges = await buildEdges({ companyId, tasks: working });
    try {
      const schedule = await levelSchedule({
        companyId, tasks: working, edges, resourceCapacity, anchor, priority, preOccupied,
      });
      return { schedule, tasks: working, dropped };
    } catch (err) {
      if (!isNoCapacity(err) || err.taskId == null) throw err;
      const bad = working.find((t) => t.id === err.taskId);
      dropped.push({
        taskId: err.taskId,
        resourceId: err.resourceId ?? null,
        reason: err.reason ?? 'no capacity',
        orderNumber: bad?.order_number ?? null,
        operationName: bad?.operation_name ?? null,
      });
      working = working.filter((t) => t.id !== err.taskId);
      if (working.length === 0) return { schedule: new Map(), tasks: [], dropped };
    }
  }

  logger.warn({ companyId, dropped: dropped.length }, 'planSuggestion: drop-retry cap reached');
  return { schedule: new Map(), tasks: working, dropped };
}

// ─── bundling ─────────────────────────────────────────────────────────────────

/**
 * Group scheduled tasks into bars.
 *
 * A bundle is tasks sharing (order, operation, resource type, ancestor item),
 * where the ancestor is one level above the task's own item — i.e. a task bundles
 * with its DIRECT SIBLINGS. Siblings are safe to batch without any edge check in
 * principle (cross-BOM edges run child-terminal → parent-consumer, never
 * sibling → sibling) but the check is done anyway, because "in principle" is how
 * a scheduler ends up promising to cut a plate after welding it.
 *
 * Auto-split falls out of the scheduling rather than being bolted on: members are
 * sorted by start and a new bar begins wherever the next member does not touch or
 * overlap the bar so far. Two parts whose predecessors finished a day apart were
 * scheduled a day apart, so they land in two bars without anything having to
 * notice that they were "not ready together".
 */
function bundleSchedule(tasks, schedule, edgeSet, { bundling = true } = {}) {
  const groups = new Map();

  for (const t of tasks) {
    const span = schedule.get(t.id);
    if (!span) continue;
    // Ungrouped tasks still get a key so the shapes downstream stay identical;
    // a unique key simply means a bar of one.
    const key = bundling
      ? `${t.order_id ?? 0}:${t.operation_id ?? 0}:${t.resource_type_id ?? 0}:${t.parent_item_id ?? `self${t.item_id}`}`
      : `task:${t.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ task: t, span });
  }

  const bars = [];
  for (const [key, membersRaw] of groups) {
    const members = membersRaw.sort((a, b) => a.span.start - b.span.start || a.task.id - b.task.id);

    let current = null;
    const flush = () => { if (current) bars.push(current); current = null; };

    for (const m of members) {
      const startsAfterBar = current && m.span.start.getTime() > current.end.getTime();
      // An edge between two members would make the bar claim to run them at once.
      // Should be impossible among siblings; if it ever happens, split rather
      // than emit a bar that lies.
      const dependsOnBar = current && current.members.some(
        (x) => edgeSet.has(`${x.task.id}->${m.task.id}`) || edgeSet.has(`${m.task.id}->${x.task.id}`),
      );
      if (!current || startsAfterBar || dependsOnBar) {
        flush();
        current = {
          bundleKey: key,
          members: [m],
          start: new Date(m.span.start.getTime()),
          end: new Date(m.span.end.getTime()),
        };
        continue;
      }
      current.members.push(m);
      if (m.span.end > current.end) current.end = new Date(m.span.end.getTime());
    }
    flush();
  }

  return bars.sort((a, b) => a.start - b.start || a.bundleKey.localeCompare(b.bundleKey));
}

// ─── entry point ──────────────────────────────────────────────────────────────

/**
 * Compute a suggested plan for a window and persist it as a run.
 *
 * @param {number} companyId
 * @param {object} opts
 * @param {Date}   opts.from            window start (also the levelling anchor)
 * @param {Date}   opts.to              window end — bars starting after this are dropped
 * @param {number[]} [opts.resourceTypeIds]  scope; empty/omitted = whole shop
 * @param {boolean}  [opts.bundling=true]
 * @param {number}   [opts.userId]
 * @param {Date}     [opts.now]
 */
export async function suggestPlan(companyId, {
  from, to, resourceTypeIds = [], bundling = true, userId = null, now = new Date(),
} = {}) {
  if (!(from instanceof Date) || !(to instanceof Date) || !(to > from)) {
    throw new Error('suggestPlan: from/to must be Dates with to > from');
  }

  // The anchor is the later of the window start and now: a plan cannot begin in
  // the past, and a planner opening last Tuesday should not be handed a
  // suggestion that was already impossible when they asked for it.
  const anchor = from.getTime() > now.getTime() ? from : now;

  const allTasks = await loadPlanningTasks(companyId);
  if (allTasks.length === 0) {
    return persistRun(companyId, {
      from, to, resourceTypeIds, anchor, userId, bars: [], dropped: [], missingDuration: 0,
    });
  }

  const plannedIds = await loadPlannedTaskIds(companyId);
  const { slackByOrder, criticalTaskIds } = await computeOrderSlack(companyId, now);
  const { priority } = buildPriorityMap(allTasks, slackByOrder, criticalTaskIds);
  const resourceCapacity = await loadResourceCapacity(companyId);
  const preOccupied = await loadPreOccupied(companyId, now);

  const { schedule, tasks: levelled, dropped } = await levelTolerantly({
    companyId, tasks: allTasks, resourceCapacity, anchor, priority, preOccupied,
  });

  // Only now narrow to what may actually be SUGGESTED. Everything above had to
  // see the whole graph; only this step is about what the planner is offered.
  //
  // Material-blocked work is excluded here for the same reason the manual gate
  // refuses it (see planService.assertMaterialAvailable): there is no activity
  // to schedule it after, so a suggested date for it is a promise made out of a
  // shortage. It must be filtered at the SAME point as the other candidate
  // rules, not earlier — `levelled` still has to contain it, or a successor
  // would look like a chain head and get anchored at the start of the window
  // instead of after the work it depends on.
  const blockedIds = levelled.filter((t) => t.status === 'blocked').map((t) => t.id);
  const gates = await outstandingGatesFor(companyId, blockedIds);
  const materialBlocked = new Set(
    [...gates.entries()].filter(([, g]) => isMaterialBlocked(g)).map(([id]) => Number(id)),
  );

  const typeFilter = new Set((resourceTypeIds ?? []).map(Number));
  const candidates = levelled.filter((t) => {
    if (!PLANNABLE.has(t.status)) return false;
    if (materialBlocked.has(Number(t.id))) return false;
    if (plannedIds.has(Number(t.id))) return false;
    if (typeFilter.size > 0 && !typeFilter.has(Number(t.resource_type_id))) return false;
    const span = schedule.get(t.id);
    if (!span) return false;
    // A bar that has not started by the end of the window belongs to a later
    // plan, not a truncated version of this one.
    return span.start.getTime() < to.getTime();
  });

  const missingDuration = candidates.filter((t) => !(Number(t.computed_hours) > 0)).length;

  const edges = await buildEdges({ companyId, tasks: levelled });
  const edgeSet = new Set(edges.map((e) => `${e.from}->${e.to}`));
  const bars = bundleSchedule(candidates, schedule, edgeSet, { bundling });

  return persistRun(companyId, {
    from, to, resourceTypeIds, anchor, userId, bars, dropped, missingDuration,
    slackByOrder, criticalTaskIds,
  });
}

// ─── persistence ──────────────────────────────────────────────────────────────

/** MySQL DATETIME, UTC. Never round-trip a DATETIME through JS date parsing. */
function toDateTimeStr(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 19).replace('T', ' ');
}

function humanSlack(minutes) {
  const abs = Math.abs(minutes);
  if (abs < 60) return `${abs} min`;
  if (abs < 480) return `${(abs / 60).toFixed(1)} h`;
  return `${(abs / 480).toFixed(1)} days`;
}

function barLabel(bar) {
  const first = bar.members[0].task;
  const op = first.operation_name ?? 'Operation';
  const n = bar.members.length;
  if (n === 1) return `${op} · ${first.item_name ?? `item ${first.item_id}`}`;
  return `${op} · ${n} items`;
}

function barReason(bar, slackByOrder, criticalTaskIds) {
  const first = bar.members[0].task;
  const bits = [];
  if (first.must_finish_by) bits.push('date pinned');
  if (first.priority_rank != null) bits.push(`priority #${first.priority_rank}`);
  const s = slackByOrder?.get(first.order_id);
  if (s && Number.isFinite(s.slack)) {
    bits.push(s.slack < 0 ? `${humanSlack(s.slack)} behind` : `${humanSlack(s.slack)} spare`);
  } else {
    bits.push('no baseline');
  }
  if (bar.members.some((m) => criticalTaskIds?.has(m.task.id))) bits.push('critical chain');
  return bits.join(' · ').slice(0, 255);
}

async function persistRun(companyId, {
  from, to, resourceTypeIds, anchor, userId, bars, dropped, missingDuration,
  slackByOrder, criticalTaskIds,
}) {
  // Same resolver the grid uses — the plant's clock, not the company default and
  // not the server's. A bar's planDate has to agree with the column it lands in.
  const tz = await plannerTimezone(companyId);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const taskCount = bars.reduce((n, b) => n + b.members.length, 0);
    const plannedMinutes = Math.round(
      bars.reduce((n, b) => n + b.members.reduce(
        (m, x) => m + (Number(x.task.computed_hours) || 0) * 60, 0,
      ), 0),
    );

    const [runRes] = await conn.query(
      `INSERT INTO fab_plan_runs
         (company_id, status, window_from, window_to, resource_type_ids, anchor_at,
          computed_at, computed_by, entry_count, task_count, planned_minutes,
          unschedulable_count)
       VALUES (?, 'suggested', ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?)`,
      [companyId, toDateTimeStr(from), toDateTimeStr(to),
       (resourceTypeIds ?? []).length ? resourceTypeIds.join(',') : null,
       toDateTimeStr(anchor), userId, bars.length, taskCount, plannedMinutes, dropped.length],
    );
    const runId = runRes.insertId;

    for (const bar of bars) {
      const first = bar.members[0].task;
      const minutes = Math.round(bar.members.reduce(
        (m, x) => m + (Number(x.task.computed_hours) || 0) * 60, 0,
      ));
      const slack = slackByOrder?.get(first.order_id)?.slack;
      await conn.query(
        `INSERT INTO fab_plan_run_items
           (company_id, run_id, resource_type_id, resource_id, bundle_key,
            ancestor_item_id, order_id, operation_id, planned_start, planned_end,
            planned_minutes, task_count, task_ids, priority_rank,
            order_slack_minutes, is_critical_chain, seq_no, reason, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [companyId, runId, first.resource_type_id, first.assigned_resource_id ?? null,
         bar.bundleKey.slice(0, 190), first.parent_item_id ?? null,
         first.order_id ?? null, first.operation_id ?? null,
         toDateTimeStr(bar.start), toDateTimeStr(bar.end), minutes, bar.members.length,
         JSON.stringify(bar.members.map((m) => m.task.id)),
         first.priority_rank ?? null,
         Number.isFinite(slack) ? slack : null,
         bar.members.some((m) => criticalTaskIds?.has(m.task.id)) ? 1 : 0,
         first.seq_no ?? null,
         barReason(bar, slackByOrder, criticalTaskIds),
         barLabel(bar).slice(0, 255)],
      );
    }

    await conn.commit();

    return {
      runId,
      windowFrom: from,
      windowTo: to,
      anchorAt: anchor,
      entryCount: bars.length,
      taskCount,
      plannedMinutes,
      missingDuration,
      unschedulable: dropped,
      // Shaped like a plan entry so the grid renders a suggestion and an accepted
      // bar with one component.
      items: bars.map((bar) => {
        const first = bar.members[0].task;
        return {
          bundleKey: bar.bundleKey,
          resourceTypeId: first.resource_type_id,
          resourceId: first.assigned_resource_id ?? null,
          ancestorItemId: first.parent_item_id ?? null,
          orderId: first.order_id ?? null,
          orderNumber: first.order_number ?? null,
          operationId: first.operation_id ?? null,
          plannedStart: bar.start,
          plannedEnd: bar.end,
          planDate: zonedYMD(bar.start, tz),
          plannedMinutes: Math.round(bar.members.reduce(
            (m, x) => m + (Number(x.task.computed_hours) || 0) * 60, 0,
          )),
          taskCount: bar.members.length,
          taskIds: bar.members.map((m) => m.task.id),
          label: barLabel(bar),
          reason: barReason(bar, slackByOrder, criticalTaskIds),
          isCriticalChain: bar.members.some((m) => criticalTaskIds?.has(m.task.id)),
          mustFinishBy: first.must_finish_by ?? null,
          // The pin is a forward-scheduling input, not a constraint the pass can
          // enforce, so a breach is REPORTED rather than silently absorbed.
          breachesPin: !!(first.must_finish_by
            && bar.end.getTime() > new Date(`${first.must_finish_by}T23:59:59Z`).getTime()),
        };
      }),
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
