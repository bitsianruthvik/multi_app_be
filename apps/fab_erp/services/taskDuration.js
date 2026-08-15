/**
 * taskDuration.js — how long a task takes. ONE definition.
 *
 * A time formula is PER PIECE — that is what a shop means by a cycle time, and
 * it is how every existing formula in the system is written ("10 + cut length /
 * speed" is one plate, not twenty). But nothing ever multiplied it by the
 * quantity the task covers, so a task for 20 flanges was planned as one flange.
 * `item.qty` was not a way out either: `item.*` resolves from field values, so a
 * formula naming it read 0.
 *
 * WHY A SHARED HELPER AND NOT A MULTIPLY AT EACH READ
 * --------------------------------------------------
 * Twelve places across seven files turn `computed_hours` into minutes — the
 * resource leveller, the suggestion engine's bundles, the critical-chain
 * baseline, the drum's load, the what-if detour, the planner's predecessor
 * projection, its backlog totals and the variance readout. Applying qty at each
 * of them means one missed site makes the scheduler and the critical chain
 * disagree about the same task, silently and permanently. There is one
 * definition here and every site calls it.
 *
 * `computed_hours` DELIBERATELY REMAINS PER PIECE. Storing the total instead
 * would have been less code, but it destroys the only number a person can sanity
 * check against a standard time, and it makes a quantity change indistinguishable
 * from a formula change in the variance history.
 *
 * Accepts both shapes because the queries feeding these paths alias differently
 * — raw `computed_hours` / `task_qty` from the service layer, camelCase from the
 * generic query API. Normalising at the call sites would mean touching the same
 * twelve places this file exists to avoid touching.
 */

/** Pieces this task covers. NULL/0/absent ⇒ 1, so an un-backfilled row behaves as before. */
export function taskQty(task) {
  if (!task) return 1;
  const raw = task.task_qty ?? task.taskQty;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Per-piece hours as stored. Null/negative ⇒ 0. */
export function unitHours(task) {
  if (!task) return 0;
  const raw = task.computed_hours ?? task.computedHours;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Setup hours for the whole task — charged ONCE, never multiplied by quantity.
 *
 * Frozen onto the task at materialization from `fab_operations.setup_minutes`,
 * the same way `computed_hours` freezes the formula result. Null/negative ⇒ 0,
 * so a task predating the column, or an operation with no setup configured,
 * behaves exactly as before.
 */
export function setupHours(task) {
  if (!task) return 0;
  const raw = task.setup_hours ?? task.setupHours;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * What the task actually occupies: setup once, plus per-piece × pieces.
 *
 * Setup sits OUTSIDE the multiplication on purpose. You set a machine up once
 * for the run, and the previous shape — setup as a constant term inside a
 * per-piece formula — made a 20-off task bill twenty setups, so the estimate
 * grew with quantity in a way the shop floor does not.
 */
export function taskHours(task) {
  return setupHours(task) + unitHours(task) * taskQty(task);
}

/** The same in minutes, rounded — what every scheduler and load figure wants. */
export function taskMinutes(task) {
  return Math.round(taskHours(task) * 60);
}

/**
 * True when a task has no usable estimate.
 *
 * Deliberately tests the PER-PIECE figure, not the total: a task with a formula
 * and a quantity of zero is a quantity problem, not a missing-formula problem,
 * and reporting it as "no time formula" would send somebody to fix the wrong
 * thing.
 */
export function hasNoEstimate(task) {
  return !(unitHours(task) > 0);
}
