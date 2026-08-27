/**
 * planReplanService.js — making the plan true again, and pricing a new order.
 *
 * Its own module rather than part of planService because it composes the two:
 * planSuggestionService already imports plannerTimezone FROM planService, so
 * planService cannot import the suggestor back without a cycle. Everything here
 * needs both.
 */

import { pool } from '../../../db.js';
import { plannerTimezone, PlanError, retirePlan, acceptRun } from './planService.js';
import { suggestPlan } from './planSuggestionService.js';
import { planningFloor } from './plantTime.js';
import { levelSchedule, loadResourceCapacity } from './resourceLevelingService.js';
import { taskMinutes } from './taskDuration.js';

/** MySQL DATETIME, UTC. */
function toDateTimeStr(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}
/**
 * Re-plan what has not happened yet, against what actually did.
 *
 * The plan is a forecast, and forecasts go stale in ways nobody types into the
 * system: a shift pattern changes, a welder is off sick, and the three jobs that
 * were supposed to run this morning did not. From then on every date on the
 * board is wrong, and the planner's only recourse was to drag work by hand or
 * to clear and rebuild the whole plan, losing the pins and the record of what
 * ran.
 *
 * This is one action for "the world moved; make the plan true again":
 *
 *   1. Retire everything not yet started and not pinned. Started work is what
 *      the shop actually did and pinned work is somebody saying "not this one";
 *      both stay exactly where they are.
 *   2. Re-level the rest from the planning floor — tomorrow, or today in the day
 *      view. Anything that was scheduled for a morning that has passed lands
 *      ahead of the floor rather than in the past.
 *   3. Accept it.
 *
 * Nothing here re-reads the calendar specially. It does not need to: capacity is
 * resolved at levelling time, so a changed shift pattern, a new holiday and a
 * worker on leave are all simply true by the time step 2 runs. That is also why
 * this is the answer to "the calendar changed" as well as to "it did not happen".
 *
 * @returns {Promise<{retired:number, keptStarted:number, keptPinned:number,
 *                    runId:number, planned:number, skipped:object[], from:string}>}
 */
export async function replanFromNow(companyId, { granularity = 'week', horizonDays = 92 } = {}, userId = null) {
  const tz = await plannerTimezone(companyId);
  const from = planningFloor(new Date(), tz, granularity);
  const to = new Date(from.getTime() + horizonDays * 86400000);

  // Step 1. What the shop did stays; the forecast goes.
  const cleared = await retirePlan(companyId, {}, userId);

  // Step 2 and 3. Started work is already excluded from the candidates and
  // still occupies its machine, because suggestPlan loads it as pre-occupied.
  const run = await suggestPlan(companyId, { from, to, bundling: true, userId });
  const accepted = await acceptRun(companyId, run.runId, {}, userId);

  return {
    retired: cleared.retired,
    keptStarted: cleared.keptStarted,
    keptPinned: cleared.keptPinned,
    runId: run.runId,
    planned: accepted.accepted,
    skipped: accepted.skipped ?? [],
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

/**
 * When would this order finish, if we took it?
 *
 * Writes nothing. The order's tasks are levelled against the committed plan held
 * fixed, so the answer is "given everything already promised, here is the date"
 * rather than "here is the date if the shop were empty" — which is the only
 * version worth quoting to a customer.
 *
 * The order has to have been entered far enough to have tasks: lines, BOM and
 * flows, which is where the wizard leaves a draft. Before that there is no
 * routing and no durations, and any date would be a guess dressed as an answer.
 *
 * `bottleneck` names the resource type carrying the most work in this order,
 * because when the date is disappointing that is the thing to argue with.
 */
export async function simulateOrder(companyId, orderId, { granularity = 'week' } = {}) {
  const tz = await plannerTimezone(companyId);
  const anchor = planningFloor(new Date(), tz, granularity);

  const [tasks] = await pool.query(
    `SELECT t.id, t.order_id, t.item_id, t.flow_id, t.seq_no, t.depends_on,
            t.resource_type_id, t.assigned_resource_id, t.status,
            t.computed_hours, t.setup_hours, t.task_qty, t.operation_id,
            op.is_interruptible, rt.name AS resource_type_name
       FROM fab_project_tasks t
       LEFT JOIN fab_operations op ON op.id = t.operation_id
       LEFT JOIN fab_resource_types rt ON rt.id = t.resource_type_id
      WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
        AND t.status NOT IN ('cancelled', 'done')`,
    [companyId, orderId],
  );
  if (tasks.length === 0) {
    throw new PlanError(
      'NOTHING_TO_SIMULATE',
      'This order has no plannable work yet. Finish its BOM and flows first.',
      { orderId },
    );
  }

  // Everything already promised, held fixed. Without this the answer would be
  // the date on an empty shop, which is not a date anybody can commit to.
  const [committed] = await pool.query(
    `SELECT resource_type_id, resource_id AS assigned_resource_id,
            planned_start AS start, planned_end AS end
       FROM fab_plan_entries
      WHERE company_id = ? AND status = 'planned' AND deleted_at IS NULL
        AND planned_end > ? AND (order_id IS NULL OR order_id <> ?)`,
    [companyId, toDateTimeStr(anchor), orderId],
  );

  const schedule = await levelSchedule({
    companyId,
    tasks,
    resourceCapacity: await loadResourceCapacity(companyId),
    anchor,
    preOccupied: committed.map((c) => ({
      resource_type_id: c.resource_type_id,
      assigned_resource_id: c.assigned_resource_id,
      start: new Date(c.start),
      end: new Date(c.end),
    })),
  });

  let first = Infinity;
  let last = 0;
  for (const s of schedule.values()) {
    if (s.start.getTime() < first) first = s.start.getTime();
    if (s.end.getTime() > last) last = s.end.getTime();
  }

  // Where the work sits, so a disappointing date has something to argue with.
  const byType = new Map();
  for (const t of tasks) {
    const key = t.resource_type_name ?? `type ${t.resource_type_id}`;
    byType.set(key, (byType.get(key) ?? 0) + (taskMinutes(t) || 0));
  }
  const load = [...byType.entries()]
    .map(([name, minutes]) => ({ name, hours: Math.round(minutes / 60) }))
    .sort((a, b) => b.hours - a.hours);

  return {
    orderId,
    taskCount: tasks.length,
    earliestStart: new Date(first).toISOString(),
    finishesAt: new Date(last).toISOString(),
    calendarDays: Math.ceil((last - anchor.getTime()) / 86400000),
    workHours: Math.round(load.reduce((a, b) => a + b.hours, 0)),
    load: load.slice(0, 6),
    bottleneck: load[0] ?? null,
    againstCommitted: committed.length,
  };
}
