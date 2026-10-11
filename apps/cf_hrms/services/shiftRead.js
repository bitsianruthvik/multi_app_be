/**
 * shiftRead.js — a shift's week: seven days, their hours, and the one line
 * that says it. (TM/CF_HRMS_HIRING_SPEC.md §6.)
 *
 * A SHIFT HAS HOURS PER DAY OF THE WEEK. `hrms_shift_days` holds seven rows per
 * shift — weekday 1 = Monday … 7 = Sunday — each working or not, with a start,
 * an end and a break. A working day with no times is the flexible shift
 * ("General": expected during the working day, no clock).
 *
 * Pure. No database here: organisationService writes and reads the rows, and
 * every other read (chart, position, hiring, My place) prints a shift's
 * `summary` from the copy kept on the shift row (`hrms_shifts.week_summary`,
 * written whenever the days are) — so the line costs no query anywhere.
 *
 * SEVEN, ALWAYS. `weekOf()` returns seven days whatever it is given: a weekday
 * with no row is filled from the shift's own times by the migration's rule
 * (Monday–Saturday working, Sunday off), so a shift can never be shown with
 * fewer than seven even if a row has gone missing.
 */

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** '08:00:00' | '08:00' | null -> 'HH:MM' | null */
export const hhmm = (v) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, 5));
const minutesOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** An end at or before the start is the next day's: 20:00–08:00 is a night shift. */
export const crossesMidnight = (start, end) => Boolean(start && end && end <= start);

/** Minutes between start and end, over midnight when the end is not after the start. null without both. */
export function spanMinutes(start, end) {
  if (!start || !end) return null;
  const span = minutesOf(end) - minutesOf(start);
  return span > 0 ? span : span + 1440;
}

/** Worked hours of a day, the break taken off; null for a day off or a day without hours. */
export function dayHours(day) {
  if (!day.isWorking) return null;
  const span = spanMinutes(day.startTime, day.endTime);
  if (span === null) return null;
  return Math.round(((span - (day.breakMinutes || 0)) / 60) * 100) / 100;
}

/** One day in the wire shape (spec `ShiftDay`). */
export function shapeDay(d) {
  const day = {
    weekday: Number(d.weekday),
    isWorking: Boolean(d.isWorking ?? d.is_working),
    startTime: hhmm(d.startTime ?? d.start_time),
    endTime: hhmm(d.endTime ?? d.end_time),
    breakMinutes: Number(d.breakMinutes ?? d.break_minutes ?? 0) || 0,
  };
  if (!day.isWorking) { day.startTime = null; day.endTime = null; day.breakMinutes = 0; }
  return { ...day, crossesMidnight: crossesMidnight(day.startTime, day.endTime), hours: dayHours(day) };
}

/**
 * The week a shift gets when nobody has set its days: its own times on Monday
 * to Saturday, Sunday off; with no times, Monday–Saturday working without hours.
 */
export function defaultWeek(startTime = null, endTime = null) {
  const start = hhmm(startTime);
  const end = hhmm(endTime);
  return WEEKDAYS.map((weekday) => shapeDay({
    weekday, isWorking: weekday <= 6, startTime: weekday <= 6 ? start : null, endTime: weekday <= 6 ? end : null, breakMinutes: 0,
  }));
}

/**
 * Seven days, Monday first, from whatever rows exist. A weekday with no row
 * comes from defaultWeek() of the shift's own times.
 */
export function weekOf(rows = [], shift = {}) {
  const fallback = defaultWeek(shift.start_time ?? shift.startTime, shift.end_time ?? shift.endTime);
  const by = new Map((rows ?? []).map((r) => [Number(r.weekday), r]));
  return WEEKDAYS.map((weekday) => (by.has(weekday) ? shapeDay(by.get(weekday)) : fallback[weekday - 1]));
}

/**
 * The one line: "Mon–Sat 08:00–20:00" · "Mon–Fri 09:00–18:00, Sat 09:00–13:00"
 * · "Mon–Sat, flexible hours" · "Sun 10:00–14:00" · "No working days".
 * Consecutive working days with the same hours are one run.
 */
export function summaryOf(days) {
  const runs = [];
  for (const d of days) {
    if (!d.isWorking) continue;
    const hours = d.startTime && d.endTime ? `${d.startTime}–${d.endTime}` : null;
    const last = runs[runs.length - 1];
    if (last && last.to === d.weekday - 1 && last.hours === hours) last.to = d.weekday;
    else runs.push({ from: d.weekday, to: d.weekday, hours });
  }
  if (!runs.length) return 'No working days';
  const span = (r) => (r.from === r.to ? SHORT[r.from - 1] : `${SHORT[r.from - 1]}–${SHORT[r.to - 1]}`);
  if (runs.every((r) => r.hours === null)) return `${runs.map(span).join(', ')}, flexible hours`;
  return runs.map((r) => (r.hours ? `${span(r)} ${r.hours}` : `${span(r)} flexible hours`)).join(', ');
}

/** Hours worked in a week; null when no day has hours (a flexible shift). */
export function weeklyHoursOf(days) {
  const timed = days.map((d) => d.hours).filter((h) => h !== null);
  return timed.length ? Math.round(timed.reduce((t, h) => t + h, 0) * 100) / 100 : null;
}

/** What hrms_shifts mirrors for older readers: the first working day that has hours. */
export function mirrorOf(days) {
  const first = days.find((d) => d.isWorking && d.startTime && d.endTime) ?? null;
  return { start_time: first?.startTime ?? null, end_time: first?.endTime ?? null, crosses_midnight: first?.crossesMidnight ? 1 : 0 };
}

/**
 * A shift's summary from the columns a read already has: the stored line, or —
 * for a row nobody has written one for yet — the line of its default week.
 * Reads `week_summary`, `start_time`, `end_time` under an optional prefix
 * (`shift_` when the read aliased them so).
 */
export function summaryFromRow(row, prefix = '') {
  if (!row) return null;
  const stored = row[`${prefix}week_summary`];
  if (stored) return stored;
  return summaryOf(defaultWeek(row[`${prefix}start_time`], row[`${prefix}end_time`]));
}

/** The three columns summaryFromRow() reads, for a SELECT that joins hrms_shifts as `alias`. */
export const SHIFT_SUMMARY_COLUMNS_SQL = (alias = 's', prefix = 'shift_') =>
  `${alias}.week_summary AS ${prefix}week_summary, ${alias}.start_time AS ${prefix}start_time, ${alias}.end_time AS ${prefix}end_time`;

/** Monday … Sunday for a YYYY-MM-DD date. */
export function weekdayName(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAY_NAMES[(d.getUTCDay() + 6) % 7];
}

export default {
  WEEKDAYS, WEEKDAY_NAMES, hhmm, crossesMidnight, spanMinutes, dayHours, shapeDay, defaultWeek, weekOf,
  summaryOf, weeklyHoursOf, mirrorOf, summaryFromRow, SHIFT_SUMMARY_COLUMNS_SQL, weekdayName,
};
