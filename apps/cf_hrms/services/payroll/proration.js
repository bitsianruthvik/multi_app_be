/**
 * proration.js — how much of a month a person is paid for. (TM/CF_HRMS_HIRING_SPEC.md §25.2.)
 * Pure: dates in, days out.
 *
 *   Payable days = the calendar days of the month the person was employed
 *                  (from joining, to the exit date) − LOP days in them.
 *   A month's amount of a component = its monthly amount × days ÷ calendar days of the month,
 *   where days are the payable days for a component prorated on LOP, and the employed days
 *   for one that is not (a fixed allowance kept whole through leave without pay).
 *
 * A SALARY REVISED IN THE MIDDLE OF A MONTH splits the month into segments, one per salary:
 * each segment pays its own salary for its own days, and its own LOP days (every LOP day has
 * a date, so it falls in exactly one segment).
 *
 * LOP days come from APPROVED requests of an unpaid leave type (services/leave/, spec §22):
 * each counted day of the request (`days_json`) is 1, or 0.5 for a half day. Attendance is
 * not built; when it is, its absences join the same list of dated days.
 */

const at = (iso) => new Date(`${iso}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = at(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const daysBetweenIncl = (a, b) => Math.round((at(b) - at(a)) / 86400000) + 1;
const later = (a, b) => (a > b ? a : b);
const earlier = (a, b) => (a < b ? a : b);

export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-09' -> { month, from: '2026-09-01', to: '2026-09-30', days: 30, label: 'September 2026' } */
export function monthBounds(month) {
  const m = MONTH_RE.exec(String(month ?? ''));
  if (!m) throw new Error(`A month is written as YYYY-MM, not “${month}”.`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { month: `${m[1]}-${m[2]}`, from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`, days: last, label: `${MONTH_NAMES[mo - 1]} ${y}` };
}
export const monthLabel = (month) => monthBounds(month).label;
export const monthOf = (date) => String(date).slice(0, 7);
export const prevMonth = (month) => { const b = monthBounds(month); return addDays(b.from, -1).slice(0, 7); };
export const nextMonth = (month) => { const b = monthBounds(month); return addDays(b.to, 1).slice(0, 7); };

/**
 * The person's days in a month, by salary.
 * @param month       'YYYY-MM'
 * @param joiningDate 'YYYY-MM-DD'
 * @param exitDate    'YYYY-MM-DD' | null — the last day employed
 * @param salaries    [{ id, effectiveFrom, effectiveTo|null, … }] — the person's salary rows (any order)
 * @param lopDays     [{ date, amount }] — LOP days of the person (any month)
 * @returns {{ month, daysInMonth, from, to, employedDays, lopDays, payableDays, joinedMid, leftMid,
 *             segments: [{ salary, from, to, days, lop, payable }], unsalariedDays, lopDates }}
 */
export function monthDays({ month, joiningDate, exitDate = null, salaries = [], lopDays = [] }) {
  const b = monthBounds(month);
  const from = joiningDate ? later(b.from, String(joiningDate).slice(0, 10)) : b.from;
  const to = exitDate ? earlier(b.to, String(exitDate).slice(0, 10)) : b.to;
  const out = {
    month: b.month, daysInMonth: b.days, from, to, employedDays: 0, lopDays: 0, payableDays: 0,
    joinedMid: Boolean(joiningDate && String(joiningDate).slice(0, 10) > b.from && String(joiningDate).slice(0, 10) <= b.to),
    leftMid: Boolean(exitDate && String(exitDate).slice(0, 10) < b.to && String(exitDate).slice(0, 10) >= b.from),
    segments: [], unsalariedDays: 0, lopDates: [],
  };
  if (from > to) return out;
  out.employedDays = daysBetweenIncl(from, to);
  const lop = lopDays
    .map((d) => ({ date: String(d.date).slice(0, 10), amount: Number(d.amount) || 0 }))
    .filter((d) => d.amount > 0 && d.date >= from && d.date <= to);
  // One LOP amount per date at most a whole day (two half-day requests on one date make one day).
  const byDate = new Map();
  for (const d of lop) byDate.set(d.date, Math.min(1, (byDate.get(d.date) ?? 0) + d.amount));
  out.lopDates = [...byDate.entries()].sort(([a], [b2]) => a.localeCompare(b2)).map(([date, amount]) => ({ date, amount }));
  out.lopDays = out.lopDates.reduce((s, d) => s + d.amount, 0);

  const rows = [...salaries]
    .map((s) => ({ s, f: String(s.effectiveFrom).slice(0, 10), t: s.effectiveTo ? String(s.effectiveTo).slice(0, 10) : null }))
    .filter((r) => !r.t || r.t >= r.f) // a cancelled row (to before from) never applied
    .sort((a, c) => a.f.localeCompare(c.f));
  let covered = 0;
  for (const r of rows) {
    const sf = later(from, r.f);
    const st = r.t ? earlier(to, r.t) : to;
    if (sf > st) continue;
    const days = daysBetweenIncl(sf, st);
    const segLop = out.lopDates.filter((d) => d.date >= sf && d.date <= st).reduce((s, d) => s + d.amount, 0);
    out.segments.push({ salary: r.s, from: sf, to: st, days, lop: segLop, payable: days - segLop });
    covered += days;
  }
  out.unsalariedDays = out.employedDays - covered;
  out.payableDays = out.segments.reduce((s, g) => s + g.payable, 0);
  return out;
}

/**
 * A component's amount for the month from its monthly amount in each segment.
 * @param segments   [{ days, payable, monthly }]
 * @param prorateOnLop  boolean
 * @returns {{ amount (not rounded), basis: string }}
 */
export function prorate(segments, daysInMonth, prorateOnLop) {
  let amount = 0;
  const parts = [];
  for (const g of segments) {
    const d = prorateOnLop ? g.payable : g.days;
    amount += (Number(g.monthly) || 0) * d / daysInMonth;
    parts.push({ monthly: Number(g.monthly) || 0, days: d });
  }
  const full = parts.length === 1 && parts[0].days === daysInMonth;
  const inr = (v) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const basis = full ? 'full month'
    : parts.map((p) => `${inr(p.monthly)} × ${trim(p.days)}/${daysInMonth} days`).join(' + ');
  return { amount, basis };
}
const trim = (n) => String(Math.round(n * 100) / 100);

/** LOP days from leave requests: [{ status, isPaid, daysJson|days, from, to, halfDay }] -> [{ date, amount }]. */
export function lopFromRequests(requests) {
  const out = [];
  for (const r of requests) {
    if (r.status !== 'APPROVED' || r.isPaid) continue;
    let days = r.days;
    if (typeof r.daysJson === 'string') { try { days = JSON.parse(r.daysJson); } catch { days = null; } } else if (r.daysJson) days = r.daysJson;
    if (Array.isArray(days) && days.length) {
      for (const d of days) if (d.counts !== false && Number(d.amount) > 0) out.push({ date: String(d.date).slice(0, 10), amount: Number(d.amount) });
    } else if (r.from && r.to) {
      // An old request without its counted days: every date of the range, half for a half day.
      for (let d = String(r.from).slice(0, 10); d <= String(r.to).slice(0, 10); d = addDays(d, 1)) out.push({ date: d, amount: r.halfDay ? 0.5 : 1 });
    }
  }
  return out;
}

export default { monthBounds, monthLabel, monthOf, prevMonth, nextMonth, monthDays, prorate, lopFromRequests, addDays, daysBetweenIncl, MONTH_RE };
