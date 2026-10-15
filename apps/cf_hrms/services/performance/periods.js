/**
 * periods.js — what a performance period IS, from a frequency and the month
 * the performance year starts in. (TM/CF_HRMS_HIRING_SPEC.md §18.1.)
 *
 * Pure: no database. A period is never typed in by hand — it is computed, so
 * two periods of one frequency can never overlap as long as the year start does
 * not move (and settingsService refuses to move it once periods exist).
 *
 *   April year (India), QUARTERLY: Q1 Apr–Jun · Q2 Jul–Sep · Q3 Oct–Dec · Q4 Jan–Mar
 *   names: "Q3 2026-27", "Oct 2026", "H2 2026-27", "2026-27"
 *   a January year has no "-27": "Q3 2026", "2026".
 */

export const FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'];
export const FREQUENCY_LABEL = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', HALF_YEARLY: 'Half-yearly', YEARLY: 'Yearly' };
const MONTHS_IN = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 };
const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const isFrequency = (f) => FREQUENCIES.includes(String(f ?? '').toUpperCase());
export const periodsPerYear = (frequency) => 12 / MONTHS_IN[frequency];

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Month arithmetic on (year, month 1..12). */
const addMonths = (y, m, n) => { const t = y * 12 + (m - 1) + n; return [Math.floor(t / 12), (t % 12) + 1]; };

/** "2026-27" for a year starting April 2026; "2026" for a January year. */
export function yearLabel(startYear, startMonth) {
  return Number(startMonth) === 1 ? String(startYear) : `${startYear}-${pad((Number(startYear) + 1) % 100)}`;
}

/** The performance year (its start year) a date falls in. */
export function yearOf(date, startMonth) {
  const [y, m] = String(date).slice(0, 10).split('-').map(Number);
  return m >= Number(startMonth) ? y : y - 1;
}

/**
 * The period number `index` (1-based) of the performance year starting in
 * (startYear, startMonth), for a frequency.
 * @returns {{ frequency, index, year: startYear, yearLabel, name, start, end }}
 */
export function periodAt(frequency, startMonth, startYear, index) {
  const f = String(frequency).toUpperCase();
  if (!MONTHS_IN[f]) throw new Error(`Not a frequency: ${frequency}`);
  const months = MONTHS_IN[f];
  const [sy, sm] = addMonths(Number(startYear), Number(startMonth), (index - 1) * months);
  const [ey, em] = addMonths(sy, sm, months - 1);
  const label = yearLabel(startYear, startMonth);
  const name = {
    MONTHLY: `${SHORT_MONTH[sm - 1]} ${sy}`,
    QUARTERLY: `Q${index} ${label}`,
    HALF_YEARLY: `H${index} ${label}`,
    YEARLY: label,
  }[f];
  return { frequency: f, index, year: Number(startYear), yearLabel: label, name, start: iso(sy, sm, 1), end: iso(ey, em, daysIn(ey, em)) };
}

/** Every period of one performance year, in order. */
export function periodsOfYear(frequency, startMonth, startYear) {
  const f = String(frequency).toUpperCase();
  return Array.from({ length: periodsPerYear(f) }, (_, i) => periodAt(f, startMonth, startYear, i + 1));
}

/** The period of a frequency that contains a date. */
export function periodFor(frequency, startMonth, date) {
  const f = String(frequency).toUpperCase();
  const startYear = yearOf(date, startMonth);
  const [y, m] = String(date).slice(0, 10).split('-').map(Number);
  const monthsIn = (y * 12 + m) - (startYear * 12 + Number(startMonth));
  return periodAt(f, startMonth, startYear, Math.floor(monthsIn / MONTHS_IN[f]) + 1);
}

/** The period that STARTS on a date, or null when no period of that frequency starts there. */
export function periodStartingOn(frequency, startMonth, date) {
  const p = periodFor(frequency, startMonth, date);
  return p.start === String(date).slice(0, 10) ? p : null;
}

export default { FREQUENCIES, FREQUENCY_LABEL, isFrequency, yearLabel, yearOf, periodAt, periodsOfYear, periodFor, periodStartingOn, periodsPerYear };
