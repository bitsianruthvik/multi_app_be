/**
 * datedChange.js — the one rule for WHEN a change to job content takes effect.
 * (TM/CF_HRMS_HIRING_SPEC.md §16.1.)
 *
 *   - by default, today;
 *   - a person with the edit right may pick a future day ("from 1 Nov");
 *   - a past day is refused — history is not rewritten — except for the Owner,
 *     who must say why.
 *
 * Every writer of job content (role lines, a position's changes, a person's
 * changes) reads its date through `readTakesEffect`, so the three layers cannot
 * disagree about what "today" or "the past" means.
 */
import { randomUUID } from 'crypto';
import { invalid } from '../lib/errors.js';
import { dateText, today } from './positionService.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const shift = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const dayBefore = (iso) => shift(iso, -1);
export const dayAfter = (iso) => shift(iso, 1);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "3 Nov 2026". */
export const longDay = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

/** A new line's identity. 36 characters; the column is 40. */
export const newLineKey = () => randomUUID();

/**
 * The day a change takes effect, and why when it is in the past.
 *   body.takesEffect  'YYYY-MM-DD' (also read: body.effectiveOn)
 *   body.reason       required for a past day
 *   c.owner           the Owner (lib/http.js ctx) — the only one allowed a past day
 * -> { on, past, reason }
 */
export function readTakesEffect(body = {}, c = {}, { fallback = null } = {}) {
  const raw = body.takesEffect ?? body.effectiveOn ?? fallback ?? null;
  const now = today();
  let on = now;
  if (raw != null && String(raw).trim() !== '') {
    const s = String(raw).trim().slice(0, 10);
    if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
      throw invalid('INVALID', 'The day it takes effect is a date as YYYY-MM-DD.', { problems: ['The day it takes effect is a date as YYYY-MM-DD.'] });
    }
    on = s;
  }
  const reason = body.reason == null ? null : String(body.reason).trim().slice(0, 500) || null;
  const past = on < now;
  if (past && !c.owner) {
    throw invalid('PAST_DATE', `A change cannot take effect on ${longDay(on)}: that day has passed, and what was expected then is not rewritten. Choose today or a later day.`,
      { problems: ['Choose today or a later day.'] });
  }
  if (past && !reason) {
    throw invalid('REASON_NEEDED', `Say why this change is dated ${longDay(on)}, a day that has passed. The reason is kept with the change.`,
      { problems: ['Give a reason for dating this in the past.'] });
  }
  return { on, past, reason };
}

/** Is a row's window [from, to] around `on`? NULL from = always was; NULL to = still is. */
export const inWindow = (row, on) => {
  const from = dateText(row.effective_from ?? row.effectiveFrom ?? null);
  const to = dateText(row.effective_to ?? row.effectiveTo ?? null);
  return (!from || from <= on) && (!to || to >= on);
};

/** A row whose window is empty never applied (a change cancelled before its day). */
export const isVoid = (row) => {
  const from = dateText(row.effective_from ?? row.effectiveFrom ?? null);
  const to = dateText(row.effective_to ?? row.effectiveTo ?? null);
  return Boolean(from && to && to < from);
};

export default { readTakesEffect, dayBefore, dayAfter, longDay, newLineKey, inWindow, isVoid };
