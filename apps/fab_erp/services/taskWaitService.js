// taskWaitService.js — EU-7: working-hours wait-time + blocked-vs-idle computation.
//
// This module owns the calendar date-walk. A second, drifted implementation
// lived in capacityService.js — it bucketed whole shifts, never carved the
// unpaid break, resolved calendars by plant alone, and read fab_calendar_days
// with the opposite polarity. It was deleted 2026-08-05: nothing imported it,
// and its own two queries named tables (fab_resource_assignments,
// fab_planned_operations) that have never existed in any environment.
//
//   RESOURCE ↔ CALENDAR RESOLUTION (see resolveTaskCalendarIds)
//   ───────────────────────────────────────────────────────────────────────────
//   1. fab_resources.shift_calendar_id — the machine's OWN calendar, when set.
//   2. else every calendar sharing the task's plant, resolved via
//      fab_resources.plant_id (if assigned_resource_id is set) else
//      fab_resource_types.plant_id.
//   3. else every calendar in the company.
//
//   Step 1 was added 2026-08-05. shift_calendar_id is writable from
//   ResourceTypes.tsx and the resource import and MachineTimeline.tsx already read
//   it, but this service resolved by plant alone — so a machine explicitly put on
//   its own calendar was still attributed against every calendar its plant had,
//   and the frontend and backend disagreed.
//
//   fab_calendar_days IS AN EXCEPTION LIST (changed 2026-08-05)
//   ───────────────────────────────────────────────────────────────────────────
//   A day is working unless a row explicitly says is_working = 0. Missing row =
//   working. There is no per-calendar "has any rows" test.
//
//   It used to be an allow-list: if a calendar had ANY row in the queried window,
//   a date with no row counted as non-working. That made marking one holiday
//   catastrophic — a single "25 Dec, not working" row turned every other unlisted
//   day non-working, resourceLevelingService.nextWorkingInstant then scanned a
//   year in 7-day chunks and threw, and rematerializeService swallowed the throw,
//   so the project silently lost its critical-chain baseline. The old rule was
//   also window-dependent: the same calendar behaved as an allow-list or as a
//   fallback depending on the date range asked for.
//
//   ShiftCalendars.tsx writes one day row at a time with an is_working toggle —
//   it was always an exception editor; the read path now matches it.
//
//   A day that IS working but has only zero-`working_minutes` shifts naturally
//   contributes 0 minutes, so a zero-minute shift still reads as non-working
//   without special-casing.
//
// GRANULARITY: rather than bucketing whole-day or whole-shift minutes,
// this service needs partial-day precision (e.g. "Friday 4pm" or "Monday 10am"), so
// for each working day we intersect each shift's wall-clock interval with the
// requested window and sum the overlap in minutes, rather than crediting the
// shift's full working_minutes for boundary days.
//
//   BREAKS (fixed 2026-08-04): the shift's wall-clock interval is its span MINUS
//   its unpaid break — `working_minutes` short of `end_time - start_time` carves
//   that difference out of the middle (see workedIntervalsForShift). Before this,
//   `working_minutes` was read by nothing in this file: intervals came from the
//   raw span and the minute sums came from those same intervals, so a lunch break
//   configured in the UI had no effect on anything, and idle time over lunch was
//   attributed as `unexplained_idle` instead of falling outside the working day.

import { pool } from '../../../db.js';
import { cachedQuery } from './planReadCache.js';
import { shiftWorld } from './shiftCache.js';
import {
  DEFAULT_TZ, zonedWallClockToUtc, zonedYMD, calendarTimezones, tzForCalendar,
} from './plantTime.js';

// ─── date/time helpers ───────────────────────────────────────────────────────

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

/** Shift a 'YYYY-MM-DD' string by whole days. */
function addDaysYMD(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toTimeString(t) {
  // mysql2 returns TIME columns as 'HH:MM:SS' strings by default.
  if (t == null) return '00:00:00';
  return String(t);
}

/**
 * Overlap interval between a shift's wall-clock interval on `dateStr` and the
 * arbitrary [windowStart, windowEnd] Date window, or null when they don't
 * overlap. Handles shifts that cross midnight (end_time <= start_time).
 */
function shiftOverlapInterval(dateStr, startTime, endTime, windowStart, windowEnd, timeZone = DEFAULT_TZ) {
  // `dateStr` is a LOCAL calendar date at the plant and start/end are what is
  // written on the board there, so both are converted from plant-local wall
  // clock to a real instant. This used to be `new Date(\`${d}T${t}Z\`)` — the
  // floor's clock read as UTC — which put every Indian shift 5½ hours late on a
  // UTC server. See plantTime.js.
  const shiftStart = zonedWallClockToUtc(dateStr, toTimeString(startTime), timeZone);
  let shiftEnd = zonedWallClockToUtc(dateStr, toTimeString(endTime), timeZone);
  if (!shiftStart || !shiftEnd) return null;
  if (shiftEnd <= shiftStart) {
    // Crosses midnight: the end belongs to the NEXT local day. Re-resolved
    // through the zone rather than by adding 24h, so a shift spanning a DST
    // change is still the length the clock on the wall says it is.
    shiftEnd = zonedWallClockToUtc(addDaysYMD(dateStr, 1), toTimeString(endTime), timeZone);
    if (!shiftEnd) return null;
  }
  const overlapStart = shiftStart > windowStart ? shiftStart : windowStart;
  const overlapEnd = shiftEnd < windowEnd ? shiftEnd : windowEnd;
  return overlapEnd > overlapStart ? { start: overlapStart, end: overlapEnd } : null;
}

/**
 * Overlap (in minutes) between a shift's wall-clock interval on `dateStr` and the
 * arbitrary [windowStart, windowEnd] Date window. Handles shifts that cross
 * midnight (end_time <= start_time).
 */
function shiftOverlapMinutes(dateStr, startTime, endTime, windowStart, windowEnd) {
  const iv = shiftOverlapInterval(dateStr, startTime, endTime, windowStart, windowEnd);
  return iv ? (iv.end.getTime() - iv.start.getTime()) / 60000 : 0;
}

/**
 * One shift on one date, as the wall-clock interval(s) that are actually WORKED —
 * i.e. the shift's span with its unpaid break carved out.
 *
 * `fab_shifts.working_minutes` was, until 2026-08-04, read by nothing: this
 * service built intervals from raw `[start_time, end_time)` and summed those for
 * its minutes too, so a shift configured as 08:00–17:00 with 510 working minutes
 * contributed the full 540. The field was editable in the UI, displayed in the
 * shifts table, and decorative everywhere it mattered — which meant a factory's
 * lunch break had no effect on the coverage meter, and idle time over lunch was
 * classified as `unexplained_idle` rather than as time outside the working day.
 *
 * WHERE THE BREAK SITS: the schema records how long it is, not when. Carving it
 * from the CENTRE is the assumption that costs least when wrong — lunch is
 * mid-shift in practice, and a centred carve keeps both shift boundaries honest
 * (a 16:45 event still falls inside a shift that really runs to 17:00, which
 * shrinking the end time would have broken). If a site ever needs the exact
 * break window, that wants explicit columns rather than a cleverer guess here.
 */
function workedIntervalsForShift(dateStr, shift, timeZone = DEFAULT_TZ) {
  const full = shiftOverlapInterval(
    dateStr, shift.start_time, shift.end_time,
    new Date(-8640000000000000), new Date(8640000000000000), timeZone,
  );
  if (!full) return [];

  const spanMinutes = (full.end.getTime() - full.start.getTime()) / 60000;
  const worked = Number(shift.working_minutes);
  // Not configured, or configured to at least the whole span: nothing to carve.
  if (!Number.isFinite(worked) || worked >= spanMinutes) return [full];
  // A zero-minute shift is a holiday/placeholder — it contributes nothing, which
  // is the behaviour the file header already promised.
  if (worked <= 0) return [];

  const breakMs = (spanMinutes - worked) * 60000;
  const midpoint = full.start.getTime() + (full.end.getTime() - full.start.getTime()) / 2;
  const breakStart = midpoint - breakMs / 2;
  const breakEnd = breakStart + breakMs;
  return [
    { start: full.start, end: new Date(breakStart) },
    { start: new Date(breakEnd), end: full.end },
  ].filter((iv) => iv.end > iv.start);
}

/** Clip an interval to [windowStart, windowEnd], or null when it falls outside. */
function clipToWindow(iv, windowStart, windowEnd) {
  const start = iv.start > windowStart ? iv.start : windowStart;
  const end = iv.end < windowEnd ? iv.end : windowEnd;
  return end > start ? { start, end } : null;
}

// ─── resource/calendar resolution ──────────────────────────────────────────────

/**
 * Resolve the plant a task's resource operates under: prefer the specifically
 * assigned resource's plant, fall back to the resource type's plant.
 */
async function resolveTaskPlantId(companyId, task) {
  if (task.assigned_resource_id) {
    const [[row]] = await cachedQuery(`SELECT plant_id FROM fab_resources
       WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [task.assigned_resource_id, companyId],
    );
    if (row) return row.plant_id;
  }
  if (task.resource_type_id) {
    const [[row]] = await cachedQuery(`SELECT plant_id FROM fab_resource_types
       WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [task.resource_type_id, companyId],
    );
    if (row) return row.plant_id;
  }
  return null;
}

/**
 * Resolve the shift calendars in scope for a task.
 *
 * Order of preference:
 *   1. the assigned machine's own fab_resources.shift_calendar_id
 *   2. every calendar sharing the task's plant
 *   3. every calendar in the company
 *
 * Step 1 is the reason this exists. shift_calendar_id is writable from
 * ResourceTypes.tsx and the resource import, and MachineTimeline.tsx already
 * reads it — but the backend resolved calendars by plant alone, so a machine
 * explicitly put on its own calendar was still attributed against every calendar
 * its plant had. Frontend and backend disagreed.
 *
 * One query for both fields; falls through to the plant path when the machine
 * has no explicit calendar, which is the common case.
 */
export async function resolveTaskCalendarIds(companyId, task) {
  let explicitCalendarId = null;
  let plantId = null;

  // Both lookups come out of the company's snapshot — see shiftCache. Asked
  // per resource and per resource type, they were four of the ten queries a warm
  // validity check still cost, for two tables that change when a machine is
  // commissioned.
  const world = await shiftWorld(companyId);
  if (task?.assigned_resource_id) {
    const row = world.plantByResource.get(Number(task.assigned_resource_id));
    if (row) {
      plantId = row.plantId;
      explicitCalendarId = row.calendarId;
    }
  }
  if (plantId == null && task?.resource_type_id) {
    const p = world.plantByResourceType.get(Number(task.resource_type_id));
    if (p != null) plantId = p;
  }
  return resolveCalendarIds(companyId, plantId, explicitCalendarId);
}

/**
 * Resolve the in-scope shift calendars, widening from the machine's own to its
 * model with a broad company-wide fallback when the plant can't pin down a
 * calendar. `explicitCalendarId` — a machine's own calendar — wins when supplied
 * and still live; callers holding a task should prefer resolveTaskCalendarIds().
 */
export async function resolveCalendarIds(companyId, plantId, explicitCalendarId = null) {
  // Reads the in-memory snapshot. The widening order below is unchanged; what
  // changed is that it costs nothing. The scheduler asks this once per resource
  // per capacity window, which on one drag was eighteen round trips for a table
  // holding a single row. See shiftCache.js.
  const world = await shiftWorld(companyId);

  if (explicitCalendarId && world.liveIds.has(Number(explicitCalendarId))) {
    return [Number(explicitCalendarId)];
  }
  if (plantId) {
    const forPlant = world.byPlant.get(Number(plantId));
    if (forPlant && forPlant.length > 0) return [...forPlant];
  }
  return [...world.allIds];
}

// ─── calendar date-walk ──────────────────────────────────────────────────────

/**
 * Load shifts + calendar-day rows for the given calendars/date range as
 * shiftRows plus per-calendar working-day sets, keeping shift start/end times
 * for the partial-day overlap math above.
 */
async function loadCalendarSchedule(companyId, calendarIds, dateFrom, dateTo) {
  if (calendarIds.length === 0) {
    return { shiftsByCalendar: {}, calendarDayMap: {} };
  }

  /**
   * Sliced out of the in-memory snapshot rather than queried — this was two of
   * the three hottest queries in a drag (see shiftCache.js).
   *
   * Fresh containers per call, sharing the row objects: the returned maps are
   * keyed by the caller's own calendar subset, so they cannot be handed out
   * wholesale, but every consumer only reads the rows themselves.
   */
  const world = await shiftWorld(companyId);

  const shiftsByCalendar = {};
  const calendarDayMap = {};
  for (const raw of calendarIds) {
    const calId = Number(raw);
    const shifts = world.shiftsByCalendar[calId];
    if (shifts) shiftsByCalendar[calId] = shifts;

    const days = world.daysByCalendar[calId];
    if (!days) continue;
    // Kept range-filtered so the contract is exactly what it was, even though
    // the day-walk only ever looks up dates it actually visits.
    const inRange = {};
    for (const ymd of Object.keys(days)) {
      if (ymd >= dateFrom && ymd <= dateTo) inRange[ymd] = days[ymd];
    }
    if (Object.keys(inRange).length > 0) calendarDayMap[calId] = inRange;
  }

  return { shiftsByCalendar, calendarDayMap };
}

/**
 * Shared day-walk: collect the raw per-shift wall-clock overlap intervals that
 * fall inside [windowStart, windowEnd]. Walks every date the window touches and
 * applies the working-day fallback described at the top of this file. Intervals are returned un-merged (one per shift/day
 * overlap) — callers either sum their durations (working-minutes) or merge them
 * into a union of in-shift time (working-intervals). Factored out so both public
 * consumers below share exactly one copy of the calendar logic.
 */
async function collectWorkingIntervals(companyId, calendarIds, windowStart, windowEnd) {
  if (!(windowEnd > windowStart) || calendarIds.length === 0) return [];

  const tzMap = await calendarTimezones(companyId);

  // Widest local-date span across the calendars in play. Each calendar can sit
  // in a different zone (a company can run sites in more than one), and the
  // local date an instant falls on differs between them — so the walk covers the
  // union and each calendar's own zone decides what actually lands in the window.
  let dateFrom = null;
  let dateTo = null;
  for (const calId of calendarIds) {
    const tz = tzForCalendar(tzMap, calId);
    const from = zonedYMD(windowStart, tz);
    const to = zonedYMD(windowEnd, tz);
    if (dateFrom === null || from < dateFrom) dateFrom = from;
    if (dateTo === null || to > dateTo) dateTo = to;
  }
  if (dateFrom === null) return [];

  // Start the walk a day EARLY. A shift that crosses midnight belongs to the
  // date it STARTS on (shiftOverlapInterval rolls its end forward 24h), so a
  // 22:00–06:00 night shift beginning on dateFrom-1 spills its 00:00–06:00 tail
  // into the window — and walking only dateFrom..dateTo never generated that
  // shift at all, so the tail was invisible.
  //
  // That silently broke night shifts everywhere the window starts mid-shift:
  // because taskAttributionService carves `no_shift` out FIRST with
  // first-match-wins, the missing hours were misfiled as outside-the-working-day
  // rather than competing for machine_down / no_operator / machine_busy. A night
  // shift's opening hours could therefore never be blamed on anything real.
  //
  // Cost of the extra day is one iteration: clipToWindow discards every interval
  // that doesn't actually reach into [windowStart, windowEnd], so a normal
  // daytime shift on dateFrom-1 contributes nothing and falls straight out.
  const walkFrom = addDaysYMD(dateFrom, -1);

  const { shiftsByCalendar, calendarDayMap } =
    await loadCalendarSchedule(companyId, calendarIds, walkFrom, dateTo);

  return walkShifts(shiftsByCalendar, calendarDayMap, walkFrom, dateTo, windowStart, windowEnd, tzMap);
}

/**
 * The day-walk itself, over shifts already grouped by calendar.
 *
 * Extracted so crew-derived capacity can reuse it verbatim. Capacity computed
 * from a PERSON's shift has to honour exactly the same rules as capacity
 * computed from a machine's calendar — the midnight rollover, the unpaid break
 * carved from the middle, the non-working-day exception list. Re-deriving them
 * in a second place is how two answers to "was this a working hour?" start
 * disagreeing, and every delay figure downstream depends on there being one.
 */
function walkShifts(shiftsByCalendar, calendarDayMap, walkFrom, dateTo, windowStart, windowEnd, tzMap) {
  const calendarIds = Object.keys(shiftsByCalendar);
  const intervals = [];
  for (const date of allDatesInRange(walkFrom, dateTo)) {
    for (const calId of calendarIds) {
      const shifts = shiftsByCalendar[calId];
      if (!shifts || shifts.length === 0) continue;

      // fab_calendar_days is an EXCEPTION list: a day is working unless a row
      // explicitly says otherwise. Only is_working = 0 blocks.
      //
      // This used to be an allow-list — if a calendar had any row in the queried
      // window, a date with no row counted as non-working. That made marking a
      // single holiday catastrophic: one "25 Dec, not working" row turned every
      // other unlisted day non-working, resourceLevelingService.nextWorkingInstant
      // then scanned a year in 7-day chunks and threw, and rematerializeService
      // swallowed the throw — so the project silently lost its CC baseline.
      // It was also window-dependent: the same calendar behaved as an allow-list
      // or a fallback depending on the date range asked for.
      //
      // ShiftCalendars.tsx writes one day row at a time with an is_working
      // toggle, i.e. it is already an exception editor. This matches it.
      // `date` is a LOCAL calendar date at this calendar's plant, which is the
      // right key: a holiday is "the 26th is off at this site", not a UTC span.
      if (calendarDayMap[calId]?.[date] === false) continue;

      // Each calendar resolves its own zone — a company with sites in two
      // countries must not evaluate both against one clock.
      const tz = tzForCalendar(tzMap, calId);

      for (const shift of shifts) {
        // Worked intervals, not the raw span — the shift's unpaid break is
        // carved out here so every caller (coverage meter, no_shift attribution,
        // working-minute sums) sees the same working day.
        for (const worked of workedIntervalsForShift(date, shift, tz)) {
          const iv = clipToWindow(worked, windowStart, windowEnd);
          if (iv) intervals.push(iv);
        }
      }
    }
  }
  return intervals;
}

/**
 * Working minutes across `calendarIds` that fall inside [windowStart, windowEnd].
 * Sums per-shift wall-clock overlap with the window (behaviorally identical to the
 * pre-refactor implementation — overlapping calendars/shifts are summed, not
 * de-duplicated, so callers relying on the historical number are unaffected).
 */
export async function workingMinutesInWindow(companyId, calendarIds, windowStart, windowEnd) {
  const intervals = await collectWorkingIntervals(companyId, calendarIds, windowStart, windowEnd);
  let totalMinutes = 0;
  for (const iv of intervals) {
    totalMinutes += (iv.end.getTime() - iv.start.getTime()) / 60000;
  }
  return totalMinutes;
}

/**
 * Merged union of in-shift [start, end] Date intervals inside [windowStart,
 * windowEnd] — the same per-day shift-overlap logic as workingMinutesInWindow,
 * but overlapping shifts/calendars are merged into non-overlapping wall-clock
 * coverage (so slicing a window by cause never double-counts a minute).
 */
export async function workingIntervalsInWindow(companyId, calendarIds, windowStart, windowEnd) {
  const intervals = await collectWorkingIntervals(companyId, calendarIds, windowStart, windowEnd);
  return mergeIntervals(intervals);
}

/**
 * Worked intervals for a SPECIFIC SET OF SHIFTS (by id) inside a window.
 *
 * The people-owned-calendar counterpart of `workingIntervalsInWindow`: a person
 * is on a shift, so their availability is that shift's worked intervals. Goes
 * through the same `walkShifts` as the calendar path, so a night shift's
 * midnight rollover, its unpaid break and its plant's holidays behave
 * identically whichever way capacity was derived.
 *
 * Returns un-merged intervals; the caller merges after intersecting each shift
 * with the person's assignment and subtracting their time away.
 */
/**
 * Working intervals TAGGED with the shift instance that produced them.
 *
 * `workingIntervalsInWindow` merges everything into anonymous spans, which is
 * right for "was this a working minute?" and useless for "which shift was this?".
 * The Shift Log needs the second question: a 22:00–06:00 night shift is ONE
 * thing a crew worked, and grouping the day by calendar date splits it across
 * two sheets — the 00:00–06:00 tail on one and the 22:00–24:00 head on the next.
 * Nobody can write that up, because nobody worked it that way.
 *
 * The instance key is (shiftId, the LOCAL DATE THE SHIFT STARTED ON). That is
 * what makes the night shift whole: both halves carry the starting date, so they
 * group together even though they fall on either side of midnight.
 *
 * Returns one row per contiguous worked span — a shift with an unpaid break
 * yields two rows sharing an instance key, which is correct: the break is not
 * time anybody has to account for.
 */
export async function shiftInstancesInWindow(companyId, calendarIds, windowStart, windowEnd) {
  if (!(windowEnd > windowStart) || calendarIds.length === 0) return [];

  const tzMap = await calendarTimezones(companyId);

  let dateFrom = null;
  let dateTo = null;
  for (const calId of calendarIds) {
    const tz = tzForCalendar(tzMap, calId);
    const from = zonedYMD(windowStart, tz);
    const to = zonedYMD(windowEnd, tz);
    if (dateFrom === null || from < dateFrom) dateFrom = from;
    if (dateTo === null || to > dateTo) dateTo = to;
  }
  if (dateFrom === null) return [];
  const walkFrom = addDaysYMD(dateFrom, -1);   // see collectWorkingIntervals

  const { shiftsByCalendar, calendarDayMap } =
    await loadCalendarSchedule(companyId, calendarIds, walkFrom, dateTo);

  const out = [];
  for (const date of allDatesInRange(walkFrom, dateTo)) {
    for (const calId of Object.keys(shiftsByCalendar)) {
      const shifts = shiftsByCalendar[calId];
      if (!shifts?.length) continue;
      if (calendarDayMap[calId]?.[date] === false) continue;
      const tz = tzForCalendar(tzMap, calId);
      for (const shift of shifts) {
        for (const worked of workedIntervalsForShift(date, shift, tz)) {
          const iv = clipToWindow(worked, windowStart, windowEnd);
          if (!iv) continue;
          out.push({
            ...iv,
            shiftId: shift.id,
            shiftName: shift.name,
            startTime: String(shift.start_time),
            endTime: String(shift.end_time),
            // The date the SHIFT began, not the date this span falls on.
            localDate: date,
            timezone: tz,
            // True when the shift runs past midnight — the UI needs to render
            // "Tue 22:00 → Wed 06:00" rather than pretending it is one date.
            crossesMidnight: String(shift.end_time) <= String(shift.start_time),
          });
        }
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export async function intervalsForShifts(companyId, shiftIds, windowStart, windowEnd) {
  if (!shiftIds?.length || !(windowEnd > windowStart)) return [];

  const tzMap = await calendarTimezones(companyId);

  const [shiftRows] = await cachedQuery(`SELECT id, calendar_id, name, start_time, end_time, working_minutes
       FROM fab_shifts
      WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
    [companyId, shiftIds],
  );
  if (!shiftRows.length) return [];

  const shiftsByCalendar = {};
  for (const s of shiftRows) {
    (shiftsByCalendar[s.calendar_id] ??= []).push(s);
  }

  const calendarIds = [...new Set(shiftRows.map((s) => s.calendar_id))];

  // Local-date span, per this shift's own calendar zone — same reasoning as
  // collectWorkingIntervals, including the day of padding for a shift that
  // starts the previous evening and runs past midnight.
  let dateFrom = null;
  let dateTo = null;
  for (const calId of calendarIds) {
    const tz = tzForCalendar(tzMap, calId);
    const from = zonedYMD(windowStart, tz);
    const to = zonedYMD(windowEnd, tz);
    if (dateFrom === null || from < dateFrom) dateFrom = from;
    if (dateTo === null || to > dateTo) dateTo = to;
  }
  const walkFrom = addDaysYMD(dateFrom, -1);

  const [dayRows] = await cachedQuery(`SELECT calendar_id, day_date, is_working
       FROM fab_calendar_days
      WHERE company_id = ? AND calendar_id IN (?)
        AND day_date BETWEEN ? AND ? AND deleted_at IS NULL`,
    [companyId, calendarIds, walkFrom, dateTo],
  );
  const calendarDayMap = {};
  for (const row of dayRows) {
    const ymd = row.day_date instanceof Date ? toYMD(row.day_date) : String(row.day_date).slice(0, 10);
    (calendarDayMap[row.calendar_id] ??= {})[ymd] = !!row.is_working;
  }

  return walkShifts(shiftsByCalendar, calendarDayMap, walkFrom, dateTo, windowStart, windowEnd, tzMap);
}

// ─── other-tasks overlap (blocked_by_other_tasks_minutes) ─────────────────────

/**
 * Fetch other fab_project_tasks rows on the same resource (or same resource_type
 * when no specific resource is assigned yet) whose [started_at, completed_at||now]
 * span overlaps [windowStart, windowEnd].
 */
export async function fetchOverlappingOtherTasks(companyId, task, windowStart, windowEnd, now) {
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

  const [rows] = await cachedQuery(`SELECT ot.id, ot.started_at, ot.completed_at, ot.status
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
export function mergeIntervals(intervals) {
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

  const calendarIds = await resolveTaskCalendarIds(task.company_id, task);

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

  const calendarIds = await resolveTaskCalendarIds(task.company_id, task);

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
