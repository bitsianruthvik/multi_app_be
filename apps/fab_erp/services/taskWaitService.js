// taskWaitService.js — EU-7: working-hours wait-time + blocked-vs-idle computation.
//
// Mirrors the calendar date-walk approach from capacityService.js::getCapacity()
// (read that file first — this module reuses the same resolution strategy rather
// than reinventing it):
//
//   RESOURCE ↔ CALENDAR RESOLUTION (mirrors capacityService's documented model)
//   ───────────────────────────────────────────────────────────────────────────
//   The schema has no direct fab_resource → fab_shift_calendar link. capacityService
//   resolves this via the "plant-wide calendar" model: a fab_shift_calendar has a
//   plant_id, fab_resources/fab_resource_types have a plant_id, and resources are
//   treated as operating under every shift of the calendar(s) sharing their plant.
//   We mirror that here: resolve the task's plant via fab_resources.plant_id (if
//   assigned_resource_id is set) else fab_resource_types.plant_id (if only
//   resource_type_id is known). Calendars are then matched on that plant_id. If no
//   plant can be resolved, or no calendar matches that plant, we broaden to ALL of
//   the company's shift calendars — the same broad fallback capacityService uses
//   when no plantId/calendarId filter is supplied.
//
//   WORKING-DAY FALLBACK FOR EMPTY fab_calendar_days (mirrors capacityService)
//   ───────────────────────────────────────────────────────────────────────────
//   Per calendar: if that calendar has ZERO fab_calendar_days rows anywhere in the
//   queried window, the whole window is treated as working days for it (optimistic
//   fallback, exactly like capacityService's `workingDaysFallback`). If the calendar
//   DOES have rows in the window, any date with no row (or a row with is_working=0)
//   is non-working and excluded — per the EU-7 spec ("a missing day-row ... = non-
//   working, excluded from the count"). A day that IS working but only has
//   zero-`working_minutes` shifts naturally contributes 0 minutes, satisfying the
//   "zero-minute/holiday shift = non-working" requirement without special-casing.
//
// GRANULARITY: unlike capacityService (which buckets whole-day/whole-shift minutes),
// this service needs partial-day precision (e.g. "Friday 4pm" or "Monday 10am"), so
// for each working day we intersect each shift's [start_time, end_time) wall-clock
// interval with the requested window and sum the overlap in minutes, rather than
// crediting the shift's full working_minutes for boundary days.

import { pool } from '../../../db.js';

// ─── date/time helpers (same conventions as capacityService.js) ───────────────

function toYMD(d) {
  return d.toISOString().slice(0, 10);
}

function allDatesInRange(from, to) {
  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function toTimeString(t) {
  // mysql2 returns TIME columns as 'HH:MM:SS' strings by default.
  if (t == null) return '00:00:00';
  return String(t);
}

/**
 * Overlap (in minutes) between a shift's wall-clock interval on `dateStr` and the
 * arbitrary [windowStart, windowEnd] Date window. Handles shifts that cross
 * midnight (end_time <= start_time).
 */
function shiftOverlapMinutes(dateStr, startTime, endTime, windowStart, windowEnd) {
  const shiftStart = new Date(`${dateStr}T${toTimeString(startTime)}Z`);
  let shiftEnd = new Date(`${dateStr}T${toTimeString(endTime)}Z`);
  if (shiftEnd <= shiftStart) {
    shiftEnd = new Date(shiftEnd.getTime() + 24 * 60 * 60 * 1000);
  }
  const overlapStart = shiftStart > windowStart ? shiftStart : windowStart;
  const overlapEnd = shiftEnd < windowEnd ? shiftEnd : windowEnd;
  const ms = overlapEnd.getTime() - overlapStart.getTime();
  return ms > 0 ? ms / 60000 : 0;
}

// ─── resource/calendar resolution ──────────────────────────────────────────────

/**
 * Resolve the plant a task's resource operates under: prefer the specifically
 * assigned resource's plant, fall back to the resource type's plant.
 */
async function resolveTaskPlantId(companyId, task) {
  if (task.assigned_resource_id) {
    const [[row]] = await pool.query(
      `SELECT plant_id FROM fab_resources
       WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [task.assigned_resource_id, companyId],
    );
    if (row) return row.plant_id;
  }
  if (task.resource_type_id) {
    const [[row]] = await pool.query(
      `SELECT plant_id FROM fab_resource_types
       WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [task.resource_type_id, companyId],
    );
    if (row) return row.plant_id;
  }
  return null;
}

/**
 * Resolve the in-scope shift calendars for a task, mirroring capacityService's
 * plant-wide model with a broad company-wide fallback when the plant can't pin
 * down a calendar.
 */
async function resolveCalendarIds(companyId, plantId) {
  if (plantId) {
    const [rows] = await pool.query(
      `SELECT id FROM fab_shift_calendars
       WHERE company_id = ? AND deleted_at IS NULL AND plant_id = ?`,
      [companyId, plantId],
    );
    if (rows.length > 0) return rows.map(r => r.id);
  }
  const [rows] = await pool.query(
    `SELECT id FROM fab_shift_calendars WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  return rows.map(r => r.id);
}

// ─── calendar date-walk (mirrors capacityService's steps 3-4) ─────────────────

/**
 * Load shifts + calendar-day rows for the given calendars/date range, in the same
 * shape capacityService builds them in (shiftRows + per-calendar working-day sets),
 * but keeping shift start/end times for the partial-day overlap math above.
 */
async function loadCalendarSchedule(companyId, calendarIds, dateFrom, dateTo) {
  if (calendarIds.length === 0) {
    return { shiftsByCalendar: {}, calendarDayMap: {}, calendarsWithRows: new Set() };
  }

  const [shiftRows] = await pool.query(
    `SELECT id, calendar_id, start_time, end_time, working_minutes
     FROM   fab_shifts
     WHERE  company_id = ? AND calendar_id IN (?) AND deleted_at IS NULL`,
    [companyId, calendarIds],
  );

  const shiftsByCalendar = {};
  for (const s of shiftRows) {
    if (!shiftsByCalendar[s.calendar_id]) shiftsByCalendar[s.calendar_id] = [];
    shiftsByCalendar[s.calendar_id].push(s);
  }

  const [dayRows] = await pool.query(
    `SELECT calendar_id, day_date, is_working
     FROM   fab_calendar_days
     WHERE  company_id = ?
       AND  calendar_id IN (?)
       AND  day_date BETWEEN ? AND ?
       AND  deleted_at IS NULL`,
    [companyId, calendarIds, dateFrom, dateTo],
  );

  const calendarDayMap = {};   // calendarDayMap[calId][ymd] = boolean(is_working)
  const calendarsWithRows = new Set();
  for (const row of dayRows) {
    const ymd = row.day_date instanceof Date
      ? toYMD(row.day_date)
      : String(row.day_date).slice(0, 10);
    if (!calendarDayMap[row.calendar_id]) calendarDayMap[row.calendar_id] = {};
    calendarDayMap[row.calendar_id][ymd] = !!row.is_working;
    calendarsWithRows.add(row.calendar_id);
  }

  return { shiftsByCalendar, calendarDayMap, calendarsWithRows };
}

/**
 * Working minutes across `calendarIds` that fall inside [windowStart, windowEnd].
 * Walks every date the window touches (like capacityService's date-walk), applies
 * the working-day fallback described at the top of this file, then sums per-shift
 * wall-clock overlap with the window.
 */
async function workingMinutesInWindow(companyId, calendarIds, windowStart, windowEnd) {
  if (!(windowEnd > windowStart) || calendarIds.length === 0) return 0;

  const dateFrom = toYMD(windowStart);
  const dateTo = toYMD(windowEnd);
  const { shiftsByCalendar, calendarDayMap, calendarsWithRows } =
    await loadCalendarSchedule(companyId, calendarIds, dateFrom, dateTo);

  let totalMinutes = 0;
  for (const date of allDatesInRange(dateFrom, dateTo)) {
    for (const calId of calendarIds) {
      const shifts = shiftsByCalendar[calId];
      if (!shifts || shifts.length === 0) continue;

      let isWorking;
      if (calendarsWithRows.has(calId)) {
        // Calendar has explicit rows somewhere in the window: missing day = non-working.
        isWorking = calendarDayMap[calId]?.[date] === true;
      } else {
        // Calendar has zero day rows in the whole window: optimistic fallback.
        isWorking = true;
      }
      if (!isWorking) continue;

      for (const shift of shifts) {
        totalMinutes += shiftOverlapMinutes(
          date, shift.start_time, shift.end_time, windowStart, windowEnd,
        );
      }
    }
  }
  return totalMinutes;
}

// ─── other-tasks overlap (blocked_by_other_tasks_minutes) ─────────────────────

/**
 * Fetch other fab_project_tasks rows on the same resource (or same resource_type
 * when no specific resource is assigned yet) whose [started_at, completed_at||now]
 * span overlaps [windowStart, windowEnd].
 */
async function fetchOverlappingOtherTasks(companyId, task, windowStart, windowEnd, now) {
  const params = [companyId, task.id];
  let matchSql;
  if (task.assigned_resource_id) {
    matchSql = 'ot.assigned_resource_id = ?';
    params.push(task.assigned_resource_id);
  } else if (task.resource_type_id) {
    matchSql = 'ot.resource_type_id = ?';
    params.push(task.resource_type_id);
  } else {
    return [];
  }

  params.push(windowEnd, windowStart);

  const [rows] = await pool.query(
    `SELECT ot.id, ot.started_at, ot.completed_at, ot.status
     FROM   fab_project_tasks ot
     WHERE  ot.company_id = ?
       AND  ot.id <> ?
       AND  ${matchSql}
       AND  ot.deleted_at IS NULL
       AND  ot.started_at IS NOT NULL
       AND  ot.started_at < ?
       AND  (ot.completed_at IS NULL OR ot.completed_at > ?)`,
    params,
  );

  return rows.map(r => ({
    start: new Date(r.started_at),
    end: r.completed_at ? new Date(r.completed_at) : now,
  }));
}

/** Merge overlapping/adjacent [start, end] intervals to avoid double-counting. */
function mergeIntervals(intervals) {
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Pure wait-time calc: working minutes elapsed from task.deps_cleared_at to `now`.
 *
 * @param {object} task    fab_project_tasks row (needs company_id, resource_type_id,
 *                         assigned_resource_id, deps_cleared_at)
 * @param {Date}   [now]
 * @returns {Promise<number>} wait_working_minutes (rounded, >= 0)
 */
export async function computeWaitWorkingMinutes(task, now = new Date()) {
  if (!task?.deps_cleared_at) return 0;
  const depsClearedAt = new Date(task.deps_cleared_at);
  if (isNaN(depsClearedAt.getTime()) || depsClearedAt >= now) return 0;

  const plantId = await resolveTaskPlantId(task.company_id, task);
  const calendarIds = await resolveCalendarIds(task.company_id, plantId);

  const minutes = await workingMinutesInWindow(task.company_id, calendarIds, depsClearedAt, now);
  return Math.round(minutes);
}

/**
 * Combined calc for task Start: wait_working_minutes, blocked_by_other_tasks_minutes,
 * and idle_wait_minutes (the remainder). EU-8's start route calls this (or the pure
 * calc above, if it only needs the one number).
 *
 * @param {object} task
 * @param {Date}   [now]
 * @returns {Promise<{wait_working_minutes:number, blocked_by_other_tasks_minutes:number, idle_wait_minutes:number}>}
 */
export async function computeTaskWaitMetrics(task, now = new Date()) {
  if (!task?.deps_cleared_at) {
    return { wait_working_minutes: 0, blocked_by_other_tasks_minutes: 0, idle_wait_minutes: 0 };
  }
  const depsClearedAt = new Date(task.deps_cleared_at);
  if (isNaN(depsClearedAt.getTime()) || depsClearedAt >= now) {
    return { wait_working_minutes: 0, blocked_by_other_tasks_minutes: 0, idle_wait_minutes: 0 };
  }

  const plantId = await resolveTaskPlantId(task.company_id, task);
  const calendarIds = await resolveCalendarIds(task.company_id, plantId);

  const waitMinutesRaw = await workingMinutesInWindow(task.company_id, calendarIds, depsClearedAt, now);
  const waitWorkingMinutes = Math.round(waitMinutesRaw);

  const otherIntervals = await fetchOverlappingOtherTasks(
    task.company_id, task, depsClearedAt, now, now,
  );

  let blockedMinutes = 0;
  if (otherIntervals.length > 0) {
    // Clip each interval to the wait window before merging.
    const clipped = otherIntervals
      .map(iv => ({
        start: iv.start > depsClearedAt ? iv.start : depsClearedAt,
        end: iv.end < now ? iv.end : now,
      }))
      .filter(iv => iv.end > iv.start);

    const merged = mergeIntervals(clipped);
    for (const iv of merged) {
      blockedMinutes += await workingMinutesInWindow(task.company_id, calendarIds, iv.start, iv.end);
    }
  }
  const blockedByOtherTasksMinutes = Math.round(blockedMinutes);

  // idle_wait_minutes is the remainder — never let it go negative due to rounding.
  const idleWaitMinutes = Math.max(0, waitWorkingMinutes - blockedByOtherTasksMinutes);

  return {
    wait_working_minutes: waitWorkingMinutes,
    blocked_by_other_tasks_minutes: blockedByOtherTasksMinutes,
    idle_wait_minutes: idleWaitMinutes,
  };
}
