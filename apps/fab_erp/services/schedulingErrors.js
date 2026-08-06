/**
 * schedulingErrors.js — typed failures the scheduler can explain.
 *
 * WHY THIS EXISTS
 * ---------------
 * `resourceLevelingService.nextWorkingInstant` scans forward for a working
 * instant and, finding none, threw a generic `Error` with a sentence in it.
 * `rematerializeService` caught that, logged it as
 * `'[cc] rematerialize baseline/replan refresh failed (non-fatal)'`, and returned
 * `{ ok: true }`. So the project silently lost its critical-chain baseline while
 * the API reported success — an outage that already happened once (see the
 * fab_calendar_days allow-list note at taskWaitService.js:29).
 *
 * That was survivable while "no working time" meant "somebody misconfigured a
 * calendar", i.e. rare. It stops being survivable under the 2026-08-06 decision
 * that an unmanned machine has ZERO capacity (FAB_ERP_PEOPLE_PLAN.md §9): a
 * machine with nobody rostered on it is now a normal, expected state, and every
 * one of them will take this path. A failure mode that is both routine and
 * invisible is the worst combination available, so it gets a type, a reason code
 * and a resource id, and callers are expected to surface it rather than swallow
 * it.
 */

/** Machine has no crew rostered, so it has no capacity at all. */
export const NO_CREW_ASSIGNED = 'no_crew_assigned';
/** Crew (or calendar) exists but yields no working time in the scanned horizon. */
export const NO_WORKING_TIME = 'no_working_time';

export class NoCapacityError extends Error {
  /**
   * @param {object} d
   * @param {string} d.reason        one of the reason codes above
   * @param {Date}   d.from          instant the scan started at
   * @param {number} d.scanDays      how far forward it looked
   * @param {number} [d.resourceId]  the machine, when known
   * @param {number} [d.taskId]      the task being placed, when known
   * @param {number[]} [d.calendarIds]
   */
  constructor({ reason, from, scanDays, resourceId = null, taskId = null, calendarIds = [] }) {
    super(
      `No capacity: ${reason} — nothing schedulable within ${scanDays} days after ` +
      `${from instanceof Date ? from.toISOString() : from}` +
      `${resourceId ? ` on resource ${resourceId}` : ''}${taskId ? ` for task ${taskId}` : ''}`,
    );
    this.name = 'NoCapacityError';
    this.reason = reason;
    this.from = from;
    this.scanDays = scanDays;
    this.resourceId = resourceId;
    this.taskId = taskId;
    this.calendarIds = calendarIds;
  }

  /** Shape the API and the UI badge both read. */
  toJSON() {
    return {
      error: 'no_capacity',
      reason: this.reason,
      resourceId: this.resourceId,
      taskId: this.taskId,
      from: this.from instanceof Date ? this.from.toISOString() : this.from,
      scanDays: this.scanDays,
      message: this.message,
    };
  }
}

export const isNoCapacity = (err) => err instanceof NoCapacityError;
