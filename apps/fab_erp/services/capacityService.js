/**
 * capacityService.js — when can a machine actually run?
 *
 * Two answers, chosen per company:
 *
 *   'calendar' (default)  the machine's / plant's shift calendar, as it always was
 *   'crew'                the union of its crew's shifts, minus their time away
 *
 * WHY BOTH EXIST
 * --------------
 * FAB_ERP_PEOPLE_PLAN.md §6 decided people own the calendar and an unmanned
 * machine has zero capacity. That is the right model and it cannot be switched on
 * globally: the roster measured on 2026-08-06 covered 0 of 29 machines locally
 * and 14 of 43 in prod, so an unconditional flip would zero out most machines,
 * the leveller would find no working instant, and every project would lose its
 * finish date. The mode is therefore per-company, defaults to 'calendar', and
 * `POST /capacity-mode` refuses to move a company to 'crew' while machines with
 * queued work still have nobody on them.
 *
 * SHAPE OF THE API
 * ----------------
 * Two phases, matching how all six consumers already work: resolve the capacity
 * source ONCE per task/resource, then ask it about many windows.
 *
 *     const cap = await resolveCapacity(companyId, task);
 *     const ivs = await capacityIntervals(companyId, cap, from, to);
 *
 * Crew mode needs a specific machine to know whose shifts to use. A task that is
 * not yet pinned to one (`assigned_resource_id` null — it only has a resource
 * TYPE) has no crew to ask about, so it falls back to the calendar path rather
 * than reporting zero capacity. Reporting zero there would make every unassigned
 * task unschedulable, which is the opposite of what the planner needs.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import {
  resolveTaskCalendarIds,
  resolveCalendarIds,
  workingIntervalsInWindow,
  workingMinutesInWindow,
  intervalsForShifts,
  shiftInstancesInWindow,
  mergeIntervals,
} from './taskWaitService.js';

export const CAPACITY_CALENDAR = 'calendar';
export const CAPACITY_CREW = 'crew';
const SETTING_KEY = 'capacity_mode';

// Short TTL cache, same idiom as appContext's company/app lookup. Capacity mode
// is read on nearly every scheduling window; re-querying per window would turn
// one setting into thousands of round trips.
const modeCache = new Map();   // companyId -> { mode, at }
const MODE_TTL_MS = 60_000;

export function clearCapacityModeCache(companyId) {
  if (companyId == null) modeCache.clear();
  else modeCache.delete(Number(companyId));
}

export async function capacityMode(companyId) {
  const key = Number(companyId);
  const hit = modeCache.get(key);
  if (hit && Date.now() - hit.at < MODE_TTL_MS) return hit.mode;

  let mode = CAPACITY_CALENDAR;
  try {
    const [[row]] = await pool.query(
      `SELECT setting_value AS v FROM fab_company_settings
        WHERE company_id = ? AND setting_key = ? AND deleted_at IS NULL`,
      [key, SETTING_KEY],
    );
    if (row?.v === CAPACITY_CREW) mode = CAPACITY_CREW;
  } catch (err) {
    // A missing settings table (migration not yet applied) must not break
    // scheduling — it means "nobody has opted in", which is the default anyway.
    logger.warn({ err, companyId }, 'capacityService: mode lookup failed, defaulting to calendar');
  }
  modeCache.set(key, { mode, at: Date.now() });
  return mode;
}

export async function setCapacityMode(companyId, mode, updatedBy = null) {
  const value = mode === CAPACITY_CREW ? CAPACITY_CREW : CAPACITY_CALENDAR;
  await pool.query(
    `INSERT INTO fab_company_settings (company_id, setting_key, setting_value, updated_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_by = VALUES(updated_by), deleted_at = NULL`,
    [companyId, SETTING_KEY, value, updatedBy],
  );
  clearCapacityModeCache(companyId);
  return value;
}

/**
 * "Treat time as continuous (24/7)" — the long-standing fallback for a company
 * with no shift calendars configured at all, so the engine still runs on a fresh
 * install.
 *
 * ONLY the calendar path keeps it. Crew mode deliberately does NOT fall back:
 * an unmanned machine has zero capacity (§6), and a 24/7 fallback there would
 * turn "nobody is on this machine" into "this machine runs around the clock" —
 * the most dangerous possible wrong answer, and the exact opposite of the
 * decision. Crew mode's empty answer is surfaced by §9's NoCapacityError and the
 * /crew-coverage precheck instead.
 */
export function isUnbounded(cap) {
  return cap?.mode !== CAPACITY_CREW && (cap?.calendarIds?.length ?? 0) === 0;
}

/**
 * Pick the capacity source for a task. Resolve once, query many windows.
 */
export async function resolveCapacity(companyId, task) {
  const mode = await capacityMode(companyId);
  const resourceId = task?.assigned_resource_id ?? null;

  if (mode === CAPACITY_CREW && resourceId) {
    return { mode: CAPACITY_CREW, resourceId, calendarIds: [] };
  }
  // Calendar mode, or crew mode on a task with no machine pinned yet.
  return {
    mode: CAPACITY_CALENDAR,
    resourceId,
    calendarIds: await resolveTaskCalendarIds(companyId, task),
  };
}

/** Same, for callers holding a resource rather than a task. */
export async function resolveCapacityForResource(companyId, resourceId, plantId = null) {
  const mode = await capacityMode(companyId);
  if (mode === CAPACITY_CREW && resourceId) {
    return { mode: CAPACITY_CREW, resourceId, calendarIds: [] };
  }
  return {
    mode: CAPACITY_CALENDAR,
    resourceId,
    calendarIds: await resolveCalendarIds(companyId, plantId, null),
  };
}

/**
 * Crew-derived working intervals for one machine.
 *
 * For each person assigned to the machine during the window:
 *   their shift's worked intervals
 *     ∩ the span they were actually assigned to this machine
 *     − the time they were away
 * then the union across everybody.
 *
 * The intersection with the assignment span is what makes an intraday move
 * honest: somebody who left at 13:00 stops contributing capacity at 13:00, not
 * at the end of their shift.
 *
 * A machine with no crew, or crew with no shift set, yields NOTHING — zero
 * capacity, per §6. That is a real answer, not a failure, and §9 is what makes
 * it visible rather than silent.
 */
export async function crewIntervals(companyId, resourceId, windowStart, windowEnd) {
  if (!(windowEnd > windowStart)) return [];

  const [rows] = await pool.query(
    `SELECT a.worker_id AS workerId, a.from_ts AS aFrom, a.to_ts AS aTo,
            ws.shift_id AS shiftId, ws.from_ts AS sFrom, ws.to_ts AS sTo
       FROM fab_worker_assignments a
       -- No active-flag filter: exit closes the assignment, so a leaver has no
       -- open interval to contribute. Filtering on the flag as well would erase
       -- them from HISTORICAL windows too, where they really were on the machine
       -- — and this same query answers "what capacity did we have last Tuesday".
       JOIN fab_workers w ON w.id = a.worker_id AND w.deleted_at IS NULL
       JOIN fab_worker_shifts ws
              ON ws.worker_id = a.worker_id AND ws.company_id = a.company_id
             AND ws.deleted_at IS NULL AND ws.superseded_by_id IS NULL
             AND ws.from_ts < ? AND (ws.to_ts IS NULL OR ws.to_ts > ?)
      WHERE a.company_id = ? AND a.resource_id = ? AND a.kind = 'assigned'
        AND a.deleted_at IS NULL AND a.superseded_by_id IS NULL
        AND a.from_ts < ? AND (a.to_ts IS NULL OR a.to_ts > ?)`,
    [windowEnd, windowStart, companyId, resourceId, windowEnd, windowStart],
  );
  if (!rows.length) return [];

  // Per shift, because each person's contribution has to be clipped to THEIR
  // shift before anything is unioned. Asking for all shifts at once would blend
  // the day shift's hours into the night worker's availability. A company has a
  // handful of shifts, so this is a handful of queries, not thousands.
  const shiftIds = [...new Set(rows.map((r) => r.shiftId))];
  const byShift = new Map();
  for (const id of shiftIds) {
    byShift.set(id, await intervalsForShifts(companyId, [id], windowStart, windowEnd));
  }

  const workerIds = [...new Set(rows.map((r) => r.workerId))];
  const [aways] = await pool.query(
    `SELECT worker_id AS workerId, from_ts AS fromTs, to_ts AS toTs
       FROM fab_worker_assignments
      WHERE company_id = ? AND worker_id IN (?) AND kind = 'away'
        AND deleted_at IS NULL AND superseded_by_id IS NULL
        AND from_ts < ? AND (to_ts IS NULL OR to_ts > ?)`,
    [companyId, workerIds, windowEnd, windowStart],
  );
  const awayByWorker = new Map();
  for (const a of aways) {
    if (!awayByWorker.has(a.workerId)) awayByWorker.set(a.workerId, []);
    awayByWorker.get(a.workerId).push(a);
  }

  const wStart = new Date(windowStart).getTime();
  const wEnd = new Date(windowEnd).getTime();
  const clamp = (v, fallback) => {
    const t = v == null ? fallback : new Date(v).getTime();
    return Math.min(Math.max(t, wStart), wEnd);
  };

  const spans = [];
  for (const r of rows) {
    // The person is only on this machine for part of the window, and only on
    // this shift for part of it. Both bound their contribution.
    const availFrom = Math.max(clamp(r.aFrom, wStart), clamp(r.sFrom, wStart));
    const availTo = Math.min(clamp(r.aTo, wEnd), clamp(r.sTo, wEnd));
    if (!(availTo > availFrom)) continue;

    let pieces = (byShift.get(r.shiftId) ?? [])
      .map((iv) => [
        Math.max(iv.start.getTime(), availFrom),
        Math.min(iv.end.getTime(), availTo),
      ])
      .filter(([s, e]) => e > s);

    for (const a of awayByWorker.get(r.workerId) ?? []) {
      const aS = clamp(a.fromTs, wStart);
      const aE = clamp(a.toTs, wEnd);
      const next = [];
      for (const [s, e] of pieces) {
        if (aE <= s || aS >= e) { next.push([s, e]); continue; }
        if (aS > s) next.push([s, aS]);
        if (aE < e) next.push([aE, e]);
      }
      pieces = next;
    }
    for (const [s, e] of pieces) if (e > s) spans.push({ start: new Date(s), end: new Date(e) });
  }

  return mergeIntervals(spans);
}

/**
 * Working time as SHIFT INSTANCES rather than anonymous spans.
 *
 * The Shift Log groups by "Night shift, Tuesday" because that is the unit a crew
 * actually worked; the calendar day splits a 22:00–06:00 shift across two sheets
 * and nobody can write that up.
 *
 * Calendar mode reads the machine's calendar directly. Crew mode uses the shifts
 * its CREW are on as the frame, then clips each span to the crew's real
 * availability — so somebody who left at 13:00 shortens that instance rather
 * than deleting it. The frame has to come from the shift either way: crew
 * intervals alone are a merged blob with no identity to group by.
 */
export async function shiftInstancesForCapacity(companyId, cap, windowStart, windowEnd) {
  if (cap?.mode !== CAPACITY_CREW) {
    return shiftInstancesInWindow(companyId, cap?.calendarIds ?? [], windowStart, windowEnd);
  }

  const [rows] = await pool.query(
    `SELECT DISTINCT sh.calendar_id AS calendarId
       FROM fab_worker_assignments a
       JOIN fab_workers w ON w.id = a.worker_id AND w.deleted_at IS NULL
       JOIN fab_worker_shifts ws
              ON ws.worker_id = a.worker_id AND ws.deleted_at IS NULL
             AND ws.superseded_by_id IS NULL
             AND ws.from_ts < ? AND (ws.to_ts IS NULL OR ws.to_ts > ?)
       JOIN fab_shifts sh ON sh.id = ws.shift_id AND sh.deleted_at IS NULL
      WHERE a.company_id = ? AND a.resource_id = ? AND a.kind = 'assigned'
        AND a.deleted_at IS NULL AND a.superseded_by_id IS NULL
        AND a.from_ts < ? AND (a.to_ts IS NULL OR a.to_ts > ?)`,
    [windowEnd, windowStart, companyId, cap.resourceId, windowEnd, windowStart],
  );
  const calendarIds = rows.map((r) => r.calendarId).filter(Boolean);
  if (!calendarIds.length) return [];

  const frame = await shiftInstancesInWindow(companyId, calendarIds, windowStart, windowEnd);
  const actual = await crewIntervals(companyId, cap.resourceId, windowStart, windowEnd);

  // Keep only the parts of each instance the crew were genuinely there for.
  const out = [];
  for (const f of frame) {
    for (const a of actual) {
      const s = f.start > a.start ? f.start : a.start;
      const e = f.end < a.end ? f.end : a.end;
      if (e > s) out.push({ ...f, start: s, end: e });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Merged working intervals from whichever source `cap` names. */
export async function capacityIntervals(companyId, cap, windowStart, windowEnd) {
  if (cap?.mode === CAPACITY_CREW) {
    return crewIntervals(companyId, cap.resourceId, windowStart, windowEnd);
  }
  return workingIntervalsInWindow(companyId, cap?.calendarIds ?? [], windowStart, windowEnd);
}

/**
 * Working MINUTES from whichever source `cap` names.
 *
 * Calendar mode goes through `workingMinutesInWindow`, which SUMS per-shift
 * overlaps without de-duplicating overlapping calendars. That is long-standing
 * behaviour dispatchService's numbers are calibrated against, so it is preserved
 * exactly rather than quietly switched to the merged figure — a company that has
 * not opted in must not see its dispatch minutes move.
 *
 * Crew mode merges first: two people on the same shift are one machine-hour, not
 * two. Different question, different arithmetic.
 */
export async function capacityMinutes(companyId, cap, windowStart, windowEnd) {
  if (cap?.mode === CAPACITY_CREW) {
    const ivs = await crewIntervals(companyId, cap.resourceId, windowStart, windowEnd);
    return ivs.reduce((a, iv) => a + (iv.end.getTime() - iv.start.getTime()) / 60000, 0);
  }
  return workingMinutesInWindow(companyId, cap?.calendarIds ?? [], windowStart, windowEnd);
}
