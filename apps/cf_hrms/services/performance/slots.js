/**
 * slots.js — the SLOTS of a plan KPI: the sub-periods an actual is entered for.
 * (TM/CF_HRMS_HIRING_SPEC.md §19.1.)
 *
 * A KPI says how often its actuals are entered (`entry_frequency`; NULL = the
 * plan's own frequency). Inside the plan's period that gives its slots:
 *
 *   quarterly plan, KPI monthly          3 slots: "Oct 2026", "Nov 2026", "Dec 2026"
 *   quarterly plan, KPI once per plan    1 slot:  "Q3 2026-27" — the period itself
 *   monthly plan, KPI quarterly          1 slot:  the period (a slot is never longer than the plan)
 *   quarterly plan, KPI weekly           the weeks (Monday to Sunday) cut to the period
 *   monthly plan, KPI daily              every day of the month
 *
 * Months, quarters and halves are counted from the PERIOD's first day, so they
 * line up with the performance year (an April year's quarters are Apr–Jun …).
 *
 * A slot is OPEN from its first day: an actual for a slot that has not begun is
 * refused. A slot is identified by its first day (`start`) within its KPI.
 *
 * Pure: no database.
 */
import { FREQUENCY_LABEL } from './periods.js';

const MONTHS_IN = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 };
const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parse = (s) => String(s).slice(0, 10).split('-').map(Number);
const addDays = (s, n) => { const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (s, n) => { const [y, m] = parse(s); const t = y * 12 + (m - 1) + n; return iso(Math.floor(t / 12), (t % 12) + 1, 1); };
const minDay = (a, b) => (a < b ? a : b);
const dayName = (s) => { const [y, m, d] = parse(s); return `${d} ${SHORT_MONTH[m - 1]} ${y}`; };
const shortDay = (s) => { const [, m, d] = parse(s); return `${d} ${SHORT_MONTH[m - 1]}`; };

/** How many months a frequency spans (DAILY / WEEKLY: 0 — shorter than a month). */
const monthsOf = (f) => MONTHS_IN[f] ?? 0;

/**
 * The slots of a KPI in a period.
 * @param period { start, end, name, frequency }   the plan's period
 * @param entryFrequency  the KPI's (NULL = the period's)
 * @returns [{ index, start, end, name, whole }]   index from 0; `whole` = the slot is the whole period
 */
export function slotsOf(period, entryFrequency = null) {
  const start = String(period.start).slice(0, 10);
  const end = String(period.end).slice(0, 10);
  const f = String(entryFrequency || period.frequency || '').toUpperCase();
  const periodMonths = monthsOf(String(period.frequency ?? '').toUpperCase()) || 12;
  const whole = () => [{ index: 0, start, end, name: period.name ?? `${dayName(start)} – ${dayName(end)}`, whole: true }];

  if (MONTHS_IN[f]) {
    if (MONTHS_IN[f] >= periodMonths) return whole();
    const out = [];
    for (let s = start, i = 0; s <= end && i < 400; i += 1) {
      const next = addMonths(s, MONTHS_IN[f]);
      const e = minDay(addDays(next, -1), end);
      const [y, m] = parse(s);
      const [ey, em] = parse(e);
      const name = MONTHS_IN[f] === 1 ? `${SHORT_MONTH[m - 1]} ${y}` : `${SHORT_MONTH[m - 1]}${y !== ey ? ` ${y}` : ''} – ${SHORT_MONTH[em - 1]} ${ey}`;
      out.push({ index: i, start: s, end: e, name, whole: false });
      s = next;
    }
    return out;
  }
  if (f === 'WEEKLY') {
    const out = [];
    let s = start;
    for (let i = 0; s <= end && i < 60; i += 1) {
      const dow = new Date(`${s}T00:00:00Z`).getUTCDay(); // 0 Sunday … 6 Saturday
      const sunday = addDays(s, (7 - dow) % 7);
      const e = minDay(sunday, end);
      out.push({ index: i, start: s, end: e, name: `Week of ${shortDay(s)}`, whole: false });
      s = addDays(e, 1);
    }
    return out;
  }
  if (f === 'DAILY') {
    const out = [];
    for (let s = start, i = 0; s <= end && i < 400; i += 1, s = addDays(s, 1)) out.push({ index: i, start: s, end: s, name: dayName(s), whole: false });
    return out;
  }
  return whole();
}

/** The slot of a KPI that starts on a day, or null. */
export const slotStarting = (period, entryFrequency, day) => slotsOf(period, entryFrequency).find((s) => s.start === String(day).slice(0, 10)) ?? null;

/** Is a slot open on a day (it has begun)? */
export const slotOpen = (slot, on) => slot.start <= String(on).slice(0, 10);

/** "Monthly", "Once for the period" — how a KPI's actuals are entered, in words. */
export function entryWords(period, entryFrequency) {
  const list = slotsOf(period, entryFrequency);
  if (list.length === 1) return 'Once for the period';
  const f = String(entryFrequency ?? '').toUpperCase();
  return FREQUENCY_LABEL[f] ?? ({ WEEKLY: 'Weekly', DAILY: 'Daily' }[f] ?? f);
}

export default { slotsOf, slotStarting, slotOpen, entryWords };
