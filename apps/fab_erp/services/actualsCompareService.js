/**
 * actualsCompareService.js — the plan, laid against what actually happened.
 *
 * Phase 4 of the Actuals Board. Two things, both OPT-IN behind `?plan=1`,
 * because the board's ordinary job is to show what happened and asking the plan
 * about it costs three more reads:
 *
 *   GHOSTS  where each drawn task was SUPPOSED to be. The board draws the
 *           planned span behind the actual one, so the drift is a distance on
 *           screen rather than a number to be worked out.
 *
 *   CURVE   the S-curve: cumulative planned work against cumulative EARNED
 *           work, day by day. The gap between the lines is the schedule
 *           variance, which is the one question a monthly review always asks.
 *
 * WHY EARNED VALUE AND NOT "HOURS WORKED"
 * ---------------------------------------
 * The obvious actual line — hours the shop actually spent — is not comparable
 * to the planned line, because a task that took twice as long as planned would
 * push the "actual" curve ABOVE the plan while the job fell further behind. The
 * curve would say ahead of schedule at the exact moment the shop was losing.
 *
 * So the actual line credits each completed task with its PLANNED minutes. Both
 * series are then in the same currency and measure the same thing — how much of
 * the plan is finished — and the vertical gap is time, in the direction a reader
 * expects. Efficiency is a different question and the board answers it elsewhere
 * (hours worked against tonnes progressed).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not reconstruct where a task sits inside its bar. `planTaskSpan` owns
 * that, for reasons its header sets out at length — three places already do it
 * and a fourth would be the same bug in a new hat. Ghosts come from
 * `taskPlannedSpans`; everything here only ever SUMS `planned_minutes`, which is
 * not the same act.
 */

import { pool } from '../../../db.js';
import { zonedYMD, addDaysYMD } from './plantTime.js';
import { taskPlannedSpans } from './planTaskSpan.js';

/**
 * Cumulative planned vs earned minutes, per day of the window.
 *
 * Both series are cumulative from the START OF THE PLAN, not from the start of
 * the window, and then sliced to it. A curve that resets to zero every month
 * cannot answer "are we behind"; it can only answer "did we do things", which
 * the header already says.
 */
async function buildCurve(companyId, { from, to, timeZone, orderIds }) {
  const [entries, links, completions] = await Promise.all([
    // Every planned bar of the touched orders. `idx_fple_order` covers this.
    orderIds.length === 0 ? Promise.resolve([[]]) : pool.query(
      `SELECT id, planned_end AS plannedEnd, planned_minutes AS plannedMinutes
         FROM fab_plan_entries
        WHERE company_id = ? AND order_id IN (?)
          AND status = 'planned' AND deleted_at IS NULL`,
      [companyId, orderIds],
    ),
    /**
     * The whole tenant's plan membership, deliberately unfiltered by entry id.
     *
     * Filtering by the entry ids from the query above would make this wait for
     * it; the tenant's plan is bounded (one real order is ~8,800 rows) and the
     * two reads then overlap instead of queueing. Rows for other orders are
     * dropped in the join below.
     */
    pool.query(
      `SELECT plan_entry_id AS entryId, task_id AS taskId, planned_minutes AS plannedMinutes
         FROM fab_plan_entry_tasks
        WHERE company_id = ? AND deleted_at IS NULL`,
      [companyId],
    ),
    // When each task actually finished. Small: only completed work qualifies.
    pool.query(
      `SELECT id, completed_at AS completedAt
         FROM fab_project_tasks
        WHERE company_id = ? AND deleted_at IS NULL
          AND status = 'done' AND completed_at IS NOT NULL`,
      [companyId],
    ),
  ]);

  const entryRows = entries[0];
  const linkRows = links[0];
  const doneRows = completions[0];

  const entryById = new Map(entryRows.map((e) => [Number(e.id), e]));

  /** Planned minutes per task, and the day the plan says it finishes. */
  const plannedMinByTask = new Map();
  const plannedDayByTask = new Map();
  for (const l of linkRows) {
    const e = entryById.get(Number(l.entryId));
    if (!e) continue; // a bar belonging to another order
    const id = Number(l.taskId);
    plannedMinByTask.set(id, Number(l.plannedMinutes) || 0);
    plannedDayByTask.set(id, zonedYMD(new Date(e.plannedEnd), timeZone));
  }

  /**
   * A bar with no membership rows still represents planned work.
   *
   * Hand-built bars predate `fab_plan_entry_tasks` in some tenants. Their
   * minutes are attributed to the bar's own day so the planned total stays
   * honest; they simply cannot be earned, having no task to complete.
   */
  const bareEntryMin = new Map();
  const entriesWithMembers = new Set(linkRows.map((l) => Number(l.entryId)));
  for (const e of entryRows) {
    if (entriesWithMembers.has(Number(e.id))) continue;
    const day = zonedYMD(new Date(e.plannedEnd), timeZone);
    bareEntryMin.set(day, (bareEntryMin.get(day) ?? 0) + (Number(e.plannedMinutes) || 0));
  }

  // ── daily increments ──────────────────────────────────────────────────────
  const plannedByDay = new Map(bareEntryMin);
  for (const [taskId, day] of plannedDayByTask) {
    plannedByDay.set(day, (plannedByDay.get(day) ?? 0) + (plannedMinByTask.get(taskId) ?? 0));
  }

  const earnedByDay = new Map();
  for (const d of doneRows) {
    const min = plannedMinByTask.get(Number(d.id));
    if (min == null) continue; // completed work that was never on the plan
    const day = zonedYMD(new Date(d.completedAt), timeZone);
    earnedByDay.set(day, (earnedByDay.get(day) ?? 0) + min);
  }

  // ── cumulate from the plan's own beginning, then slice to the window ──────
  const allDays = [...new Set([...plannedByDay.keys(), ...earnedByDay.keys()])].sort();
  const fromYMD = zonedYMD(from, timeZone);
  // `to` is exclusive, so the last drawn day is the one before it.
  const toYMD = zonedYMD(new Date(to.getTime() - 1), timeZone);

  const days = [];
  for (let d = fromYMD; d <= toYMD; d = addDaysYMD(d, 1)) days.push(d);

  let plannedCum = 0;
  let earnedCum = 0;
  const cursor = new Map();
  for (const d of allDays) {
    plannedCum += plannedByDay.get(d) ?? 0;
    earnedCum += earnedByDay.get(d) ?? 0;
    cursor.set(d, { plannedCum, earnedCum });
  }
  const totalPlanned = plannedCum;

  /** The running totals as they stood at the end of each drawn day. */
  const plannedSeries = [];
  const earnedSeries = [];
  let lastP = 0;
  let lastE = 0;
  for (const d of allDays) {
    if (d >= fromYMD) break;
    lastP = cursor.get(d).plannedCum;
    lastE = cursor.get(d).earnedCum;
  }
  for (const d of days) {
    const at = cursor.get(d);
    if (at) { lastP = at.plannedCum; lastE = at.earnedCum; }
    plannedSeries.push(Math.round(lastP));
    earnedSeries.push(Math.round(lastE));
  }

  return {
    days,
    plannedCumMin: plannedSeries,
    earnedCumMin: earnedSeries,
    totalPlannedMin: Math.round(totalPlanned),
    /** True when the plan says work should have finished before this window. */
    openingPlannedMin: plannedSeries.length ? plannedSeries[0] : 0,
  };
}

/**
 * Everything the board needs to draw the plan behind the actuals.
 *
 * @param {number} companyId
 * @param {object} opts
 * @param {Date} opts.from  window start — ghosts are relative to it
 * @param {Date} opts.to
 * @param {string} opts.timeZone
 * @param {number[]} opts.taskIds   the tasks actually drawn
 * @param {number[]} opts.orderIds  the orders they belong to
 */
export async function loadPlanCompare(companyId, { from, to, timeZone, taskIds, orderIds }) {
  const t0 = from.getTime();
  const [spans, curve] = await Promise.all([
    taskIds.length ? taskPlannedSpans(companyId, taskIds) : Promise.resolve(new Map()),
    buildCurve(companyId, { from, to, timeZone, orderIds }),
  ]);

  /** [taskId, startRel, durMs] per task that has a plan. Flat, like the blocks. */
  const ghosts = [];
  for (const [taskId, s] of spans) {
    const st = s.start instanceof Date ? s.start.getTime() : new Date(s.start).getTime();
    const en = s.end instanceof Date ? s.end.getTime() : new Date(s.end).getTime();
    if (!Number.isFinite(st) || !Number.isFinite(en)) continue;
    ghosts.push(Number(taskId), Math.round(st - t0), Math.max(0, en - st));
  }

  return { ghosts, curve };
}
