/**
 * taskVarianceService.js
 * ----------------------
 * FEAT-16: plan-vs-actual time variance, surfaced immediately (per task on the
 * DAG + at completion), not only in the nightly learned-duration aggregates.
 *
 *   plan   = fab_project_tasks.computed_hours (learned-p80 or formula estimate)
 *   actual = touch time from the event log (started→completed minus pause gaps),
 *            derived here and nowhere else.
 *   variance = actual − plan  (positive = over-ran the estimate)
 */

import { pool } from '../../../db.js';
import { taskHours } from './taskDuration.js';
/**
 * Touch time for one task from its event log: first 'started' to last
 * 'completed', minus closed pause pairs. Only the first start and last
 * completion are used, defensively against duplicate or corrected rows that
 * slipped through without being marked superseded; a pause left open at
 * completion contributes 0 rather than corrupting the result.
 *
 * Lived in operationStatsService until 2026-08-05. That module existed to learn
 * durations from history, which is gone (buffer sizing is a fixed 50%), but this
 * one function also feeds ccBufferService's buffer-CONSUMPTION maths, which
 * stays. Moved here rather than keeping a file alive for a single helper.
 */
function buildSample(events) {
  let startedAt = null, startedSource = null;
  let completedAt = null, completedSource = null;
  let pauseStart = null, pauseMinutes = 0;

  for (const ev of events) {
    const at = new Date(ev.at);
    if (ev.event_type === 'started') {
      if (!startedAt) { startedAt = at; startedSource = ev.source; }
    } else if (ev.event_type === 'completed') {
      completedAt = at; completedSource = ev.source;
    } else if (ev.event_type === 'paused') {
      if (!pauseStart) pauseStart = at;
    } else if (ev.event_type === 'resumed') {
      if (pauseStart) { pauseMinutes += (at - pauseStart) / 60000; pauseStart = null; }
    }
  }

  if (!startedAt || !completedAt || completedAt <= startedAt) return null;
  const totalMinutes = (completedAt - startedAt) / 60000;
  return {
    touchMinutes: Math.max(0, totalMinutes - pauseMinutes),
    completedAt,
    isBackfill: startedSource === 'backfill' || completedSource === 'backfill',
  };
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

/**
 * Actual touch-HOURS for a set of tasks, from their (non-superseded) event logs.
 * One query for all task ids. Returns Map<taskId, actualHours|null> (null when a
 * task has no usable started/completed pair yet).
 *
 */
export async function computeActualHoursForTasks(exec, companyId, taskIds) {
  const ids = [...new Set((taskIds || []).map(Number).filter(Number.isInteger))];
  const out = new Map();
  if (!ids.length) return out;

  const [rows] = await exec.query(
    `SELECT task_id, event_type, at, source
       FROM fab_task_events
      WHERE company_id = ? AND task_id IN (?) AND superseded_by_event_id IS NULL
      ORDER BY task_id, at ASC, id ASC`,
    [companyId, ids],
  );

  const byTask = new Map();
  for (const r of rows) {
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
    byTask.get(r.task_id).push(r);
  }
  for (const id of ids) {
    const evts = byTask.get(id);
    const sample = evts ? buildSample(evts) : null;
    out.set(id, sample ? round2(sample.touchMinutes / 60) : null);
  }
  return out;
}

/** Plan/actual/variance for a single task (plan hours passed in to avoid a re-query). */
export async function computeTaskVariance(exec, companyId, taskId, planHours) {
  const actuals = await computeActualHoursForTasks(exec, companyId, [taskId]);
  const actualHours = actuals.get(Number(taskId)) ?? null;
  const plan = planHours == null ? null : Number(planHours);
  const varianceHours = plan != null && actualHours != null ? round2(actualHours - plan) : null;
  const variancePct = plan != null && plan > 0 && actualHours != null
    ? Math.round(((actualHours - plan) / plan) * 100) : null;
  return { planHours: plan, actualHours, varianceHours, variancePct };
}

/**
 * Order-level variance rollup over DONE tasks: summed plan vs summed actual.
 * Best-effort — a task missing plan or actual just drops out of that sum.
 */
export async function orderVarianceSummary(exec, companyId, orderId) {
  const [tasks] = await exec.query(
    `SELECT id, computed_hours, task_qty FROM fab_project_tasks
      WHERE company_id = ? AND order_id = ? AND status = 'done' AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  if (!tasks.length) return { doneTasks: 0, planHours: 0, actualHours: 0, varianceHours: 0, variancePct: null };

  const actuals = await computeActualHoursForTasks(exec, companyId, tasks.map((t) => t.id));
  let planSum = 0, actualSum = 0, counted = 0;
  for (const t of tasks) {
    const a = actuals.get(t.id);
    if (t.computed_hours != null && a != null) {
      // The whole task's plan, not one piece of it — the actual it is compared
      // against is the time the machine really spent on all of them, so a
      // per-piece plan would report every multi-piece task as wildly over.
      planSum += taskHours(t);
      actualSum += a;
      counted += 1;
    }
  }
  return {
    doneTasks: counted,
    planHours: round2(planSum),
    actualHours: round2(actualSum),
    varianceHours: round2(actualSum - planSum),
    variancePct: planSum > 0 ? Math.round(((actualSum - planSum) / planSum) * 100) : null,
  };
}
