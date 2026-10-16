/**
 * targets.js — a job's KPI target, as a plan holds it. (Spec §18.1; §24 step 2.)
 *
 * A plan KPI has a direction, and a number with a unit — or a range, a date, or words:
 *   HIGHER_BETTER  95 %                 "95%", "at least 95%", "2400 MT"
 *   LOWER_BETTER   30 minutes           "Max 30 minutes", "under 2 hours", "< 3", "1.50%" of a wastage KPI
 *   EXACT          0                    "0" when nothing says which way is better
 *   TARGET_RANGE   ₹10 L – ₹12 L        target_number = the lowest, target_max = the highest
 *   DATE           30 Nov 2026          target_date; met when done on or before it
 *   TEXT           (words)              "100% adoption by end of Nov'26", and a "Done or not" KPI — met or not met
 *
 * WHERE IT COMES FROM. The job's line carries `structured` — the target as the
 * resolver reads it (kpiTarget.effectiveTarget: the library KPI's measured-in and
 * which-way over the line's number). A plan copies that. The definition's
 * direction therefore wins over every guess the parser would make. A line with
 * nothing structured (words that do not read cleanly) is copied as words.
 *
 * The text parser itself lives in ../kpiTarget.js (parseTargetText, re-exported here).
 * Pure: no database.
 */
import { amountText } from './scoring.js';
import { parseTargetText, effectiveTarget, LOWER_NAME } from '../kpiTarget.js';

export { parseTargetText };

export const DIRECTIONS = ['HIGHER_BETTER', 'LOWER_BETTER', 'EXACT', 'TARGET_RANGE', 'DATE', 'TEXT'];
export const DIRECTION_WORDS = {
  HIGHER_BETTER: 'Higher is better', LOWER_BETTER: 'Lower is better', EXACT: 'Exactly', TARGET_RANGE: 'Within a range',
  DATE: 'Done by a date', TEXT: 'Written as words',
};

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const iso = (v) => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};
const LONG_DAY = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A plan's unit for a structured target, as the job says it ("count" stays "count", as before). */
const planUnit = (s) => s.unit ?? null;

/**
 * A resolved job KPI (contentResolver item / jobContent line) -> what a plan KPI starts with.
 *   { direction, targetNumber, targetMax, targetDate, targetText, unit, jobTargetText, parsed }
 * `jobTargetText` is the job's target as a person reads it ("95%", "at least 95%").
 * An item without `structured` (an older caller) is read the same way, here.
 */
export function planTargetOf(item) {
  const op = item.targetOperator ?? null;
  const written = clean(item.targetText ?? (typeof item.targetValue === 'string' ? item.targetValue : '')).slice(0, 500) || null;
  const empty = { direction: 'TEXT', targetNumber: null, targetMax: null, targetDate: null, targetText: null, unit: item.unit ?? null, jobTargetText: null, parsed: false };
  if ((!op || op === 'INFO') && item.measurementType !== 'BOOLEAN') return empty;
  const s = item.structured !== undefined ? item.structured : effectiveTarget(
    { measurementType: item.measurementType, unit: item.unit, direction: item.direction },
    { spec: item.targetSpec, operator: op, value: item.targetValue, name: item.name ?? '' },
  );
  if (!s) {
    if (!written) return empty;
    return { ...empty, targetText: written, jobTargetText: written };
  }
  const jobTargetText = written ?? s.text;
  if (s.measure === 'BOOLEAN') return { ...empty, targetText: written ?? 'Done', jobTargetText, unit: null, parsed: true };
  if (s.measure === 'DATE') return { ...empty, direction: 'DATE', targetDate: s.date, unit: null, jobTargetText, parsed: true };
  if (s.direction === 'TARGET_RANGE') return { ...empty, direction: 'TARGET_RANGE', targetNumber: s.min, targetMax: s.max, unit: planUnit(s), jobTargetText, parsed: true };
  return { ...empty, direction: s.direction, targetNumber: s.value, unit: planUnit(s), jobTargetText, parsed: true };
}

/** A plan KPI row (snake_case) -> its target fields. `prefix` 'job_' reads what the job said. */
export function targetOfRow(r, prefix = '') {
  return {
    direction: r[`${prefix}direction`] ?? 'TEXT',
    targetNumber: num(r[`${prefix}target_number`]),
    targetMax: num(r[`${prefix}target_max`]),
    targetDate: iso(r[`${prefix}target_date`]),
    targetText: r[`${prefix}target_text`] ?? null,
    unit: r[`${prefix}unit`] ?? null,
  };
}

/** A number with its unit (scoring.js's amountText): "92%", "8 working hours", "₹12 L", "₹1.5 Cr". */
export const valueText = amountText;
const rangeText = (min, max, unit, join) => (unit === '₹' || unit === '%' || !unit
  ? `${valueText(min, unit)}${join}${valueText(max, unit)}`
  : `${valueText(min, null)}${join}${valueText(max, unit)}`);

/** "at least 95%", "at most 30 minutes", "exactly 0", "between 10% and 12%", "done by 30 Nov 2026", or the words. */
export function planTargetText({ direction, targetNumber, targetMax = null, targetDate = null, targetText, unit }) {
  if (direction === 'DATE') return targetDate ? `done by ${LONG_DAY(targetDate)}` : (targetText ?? 'No target set');
  if (direction === 'TARGET_RANGE') return targetNumber != null && targetMax != null ? `between ${rangeText(targetNumber, targetMax, unit, ' and ')}` : (targetText ?? 'No target set');
  if (direction === 'TEXT' || targetNumber == null) return targetText ?? 'No target set';
  const n = valueText(Number(targetNumber), unit);
  return `${{ HIGHER_BETTER: 'at least', LOWER_BETTER: 'at most', EXACT: 'exactly' }[direction] ?? ''} ${n}`.trim();
}

/** The target's value, short — "95%", "6 working hours", "₹10 L – ₹12 L", "30 Nov 2026" — or the words. The reader adds the mark (▲ ▼ = ↔). */
export function planTargetShort({ direction, targetNumber, targetMax = null, targetDate = null, targetText, unit }) {
  if (direction === 'DATE') return targetDate ? LONG_DAY(targetDate) : (targetText ?? 'No target set');
  if (direction === 'TARGET_RANGE') return targetNumber != null && targetMax != null ? rangeText(targetNumber, targetMax, unit, ' – ') : (targetText ?? 'No target set');
  if (direction === 'TEXT' || targetNumber == null) return targetText ?? 'No target set';
  return valueText(targetNumber, unit);
}

export { LOWER_NAME };
export default { DIRECTIONS, DIRECTION_WORDS, parseTargetText, planTargetOf, planTargetText, planTargetShort, targetOfRow, valueText };
