/**
 * days.js — which days of a leave count. (TM/CF_HRMS_HIRING_SPEC.md §22.1.)
 *
 * Pure. No database: requestService.js reads the person's shift and holidays and
 * hands them in as a calendar; this file only counts.
 *
 *   - A person's days off are their main position's shift (a weekday that is not
 *     working) plus the holidays of that shift's holiday calendar. An optional
 *     holiday is a working day. No shift: Monday to Saturday are working days and
 *     Sunday is the weekly off — and the calendar says so (`note`).
 *   - Days off at the start or the end of a range never count. A day off BETWEEN
 *     two leave days counts only when the rule has `countDaysOffBetween`.
 *   - A half day is one date only and counts 0.5 (whether it is allowed is a check,
 *     not a count: see requestService).
 *
 * Every date of the range comes back as a DayLine, counted or not, with the reason
 * in words: { date, weekday, counts, amount: 0 | 0.5 | 1, why }.
 */

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The longest range one request may span, in calendar days. */
export const MAX_RANGE_DAYS = 400;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const at = (iso) => new Date(`${iso}T00:00:00Z`);
export const addDays = (iso, n) => { const d = at(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Whole days from a to b (b − a). */
export const daysBetween = (a, b) => Math.round((at(b) - at(a)) / 86400000);
/** 1 = Monday … 7 = Sunday. */
export const weekdayOf = (iso) => ((at(iso).getUTCDay() + 6) % 7) + 1;

/** "12 Oct", or "12 Oct 2026" with the year. */
export const dayText = (iso, withYear = false) => {
  const d = at(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ''}`;
};

/** "12 Oct" · "12–15 Oct" · "28 Oct – 2 Nov" · "28 Dec 2026 – 2 Jan 2027". */
export function spanText(from, to) {
  if (!to || from === to) return dayText(from);
  const a = at(from);
  const b = at(to);
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${dayText(from, true)} – ${dayText(to, true)}`;
  if (a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`;
  return `${dayText(from)} – ${dayText(to)}`;
}

/** 1 -> "1 day", 3 -> "3 days", 0.5 -> "half a day", 2.5 -> "2.5 days". */
export function daysWords(n) {
  const v = Math.round(Number(n) * 100) / 100;
  if (v === 0.5) return 'half a day';
  return `${String(v)} day${v === 1 ? '' : 's'}`;
}

/**
 * A person's calendar.
 * @param shift    { name, workingWeekdays: number[] (1..7) } | null — no shift: Monday to Saturday
 * @param holidays [{ date: 'YYYY-MM-DD', name, isOptional }] — the holidays of the shift's calendar
 * @param calendarName the holiday calendar's name, when the shift has one
 */
export function makeCalendar({ shift = null, holidays = [], hasHolidayCalendar = Boolean(holidays.length) } = {}) {
  const working = new Set(shift ? (shift.workingWeekdays ?? []) : [1, 2, 3, 4, 5, 6]);
  const byDate = new Map();
  for (const h of holidays) {
    const prev = byDate.get(h.date);
    // A full holiday wins over an optional one on the same date.
    if (!prev || (prev.isOptional && !h.isOptional)) byDate.set(h.date, { name: h.name, isOptional: Boolean(h.isOptional) });
  }
  let note = null;
  if (!shift) note = 'No shift is recorded, so Monday to Saturday count as working days and Sunday is the weekly off.';
  else if (!hasHolidayCalendar) note = `The ${shift.name} shift has no holiday calendar, so no day is taken as a holiday.`;
  return {
    hasShift: Boolean(shift),
    shiftName: shift?.name ?? null,
    note,
    /** Why this date is a day off, or null when it is a working day. */
    offWhy(date) {
      const h = byDate.get(date);
      if (h && !h.isOptional) return `${h.name} — holiday`;
      const wd = weekdayOf(date);
      if (!working.has(wd)) return `${WEEKDAY_NAMES[wd - 1]} — weekly off`;
      return null;
    },
    /** The optional holiday on a working date, if any. */
    optionalOn(date) { const h = byDate.get(date); return h && h.isOptional ? h.name : null; },
    isWorking(date) { return this.offWhy(date) === null; },
  };
}

/** Working days from `from` to `to`, both included (0 when to < from). */
export function workingDaysBetween(calendar, from, to) {
  if (!from || !to || to < from) return 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (calendar.isWorking(d)) n += 1;
  return n;
}

/**
 * Count a leave. Assumes from <= to and a range no longer than MAX_RANGE_DAYS (the
 * service checks both first).
 * @returns { days: DayLine[], quantity }
 */
export function countDays({ from, to, halfDay = null, calendar, countDaysOffBetween = false }) {
  const end = to || from;
  const dates = [];
  for (let d = from; d <= end; d = addDays(d, 1)) dates.push(d);
  const workingDates = dates.filter((d) => calendar.isWorking(d));
  const first = workingDates[0] ?? null;
  const last = workingDates[workingDates.length - 1] ?? null;
  const half = halfDay && dates.length === 1;
  const days = dates.map((date) => {
    const weekday = WEEKDAY_NAMES[weekdayOf(date) - 1];
    const off = calendar.offWhy(date);
    if (!off) {
      const optional = calendar.optionalOn(date);
      const amount = half ? 0.5 : 1;
      const parts = [];
      if (optional) parts.push(`${optional} — optional holiday, a working day`);
      if (half) parts.push(halfDay === 'FIRST' ? 'first half of the day' : 'second half of the day');
      return { date, weekday, counts: true, amount, why: parts.length ? parts.join('; ') : null };
    }
    const between = first !== null && date > first && date < last;
    if (between && countDaysOffBetween) return { date, weekday, counts: true, amount: 1, why: `${off}, between two leave days — counts under this policy` };
    return { date, weekday, counts: false, amount: 0, why: off };
  });
  const quantity = Math.round(days.reduce((s, d) => s + d.amount, 0) * 100) / 100;
  return { days, quantity };
}

/** "(Sunday is a weekly off)" — the days of the range that do not count, in words, or ''. */
export function daysOffPhrase(days) {
  const off = days.filter((d) => !d.counts);
  if (!off.length) return '';
  const said = off.slice(0, 3).map((d) => {
    const [what, kind] = String(d.why).split(' — ');
    return kind === 'holiday' ? `${what} is a holiday` : `${what} is a weekly off`;
  });
  const more = off.length > 3 ? `, and ${off.length - 3} more day${off.length - 3 === 1 ? '' : 's'} off` : '';
  return ` (${said.join(', ')}${more})`;
}

export default { WEEKDAY_NAMES, MONTH_NAMES, MAX_RANGE_DAYS, isDate, addDays, daysBetween, weekdayOf, dayText, spanText, daysWords, makeCalendar, workingDaysBetween, countDays, daysOffPhrase };
