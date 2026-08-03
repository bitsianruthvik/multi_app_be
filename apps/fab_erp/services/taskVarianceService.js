/**
 * taskVarianceService.js
 * ----------------------
 * FEAT-16: plan-vs-actual time variance, surfaced immediately (per task on the
 * DAG + at completion), not only in the nightly learned-duration aggregates.
 *
 *   plan   = fab_project_tasks.computed_hours (learned-p80 or formula estimate)
 *   actual = touch time from the event log (started→completed minus pause gaps),
 *            same definition operationStatsService uses for learning — so the two
 *            reconcile.
 *   variance = actual − plan  (positive = over-ran the estimate)
 */

import { pool } from '../../../db.js';
import { buildSample } from './operationStatsService.js';

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

/**
 * Actual touch-HOURS for a set of tasks, from their (non-superseded) event logs.
 * One query for all task ids. Returns Map<taskId, actualHours|null> (null when a
 * task has no usable started/completed pair yet).
 *
 * Issue 4 (batching): a batched task's events are truthful but not divisible —
 * eight parts cut in one 40-minute nest each show started 09:00 / completed
 * 09:40, so the event derivation would report 40 minutes eight times. When
 * batchService has attributed a share of the run to a task, that share wins.
 */
export async function computeActualHoursForTasks(exec, companyId, taskIds) {
  const ids = [...new Set((taskIds || []).map(Number).filter(Number.isInteger))];
  const out = new Map();
  if (!ids.length) return out;

  const [attrRows] = await exec.query(
    `SELECT id, attributed_minutes FROM fab_project_tasks
      WHERE company_id = ? AND id IN (?) AND attributed_minutes IS NOT NULL`,
    [companyId, ids],
  );
  const attributed = new Map(attrRows.map((r) => [r.id, Number(r.attributed_minutes)]));

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
    if (attributed.has(id)) {
      out.set(id, round2(attributed.get(id) / 60));
      continue;
    }
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
    `SELECT id, computed_hours FROM fab_project_tasks
      WHERE company_id = ? AND order_id = ? AND status = 'done' AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  if (!tasks.length) return { doneTasks: 0, planHours: 0, actualHours: 0, varianceHours: 0, variancePct: null };

  const actuals = await computeActualHoursForTasks(exec, companyId, tasks.map((t) => t.id));
  let planSum = 0, actualSum = 0, counted = 0;
  for (const t of tasks) {
    const a = actuals.get(t.id);
    if (t.computed_hours != null && a != null) {
      planSum += Number(t.computed_hours);
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
