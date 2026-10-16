/**
 * balance.js — what a person has left of a leave type in a leave year.
 * (TM/CF_HRMS_HIRING_SPEC.md §22.2.) THE ONLY PLACE A BALANCE IS COMPUTED.
 *
 * Pure. The caller (requestService.js) reads the rule, the person's joining date,
 * HR's opening balances, the person's requests of this type and their calendar,
 * and hands them in. Nothing here reads the database, and nothing is stored: a
 * balance is computed on every read.
 *
 *   Available = opening + earned − taken − held
 *
 *   EARNED   PER_YEAR + UPFRONT    `days` (prorated by the whole months left from the
 *                                  joining month when `prorateOnJoining` and they joined
 *                                  inside this year)
 *            MONTHLY               days/12 for each month begun, up to the month the leave
 *                                  starts, never more than `days`
 *            PER_DAYS_WORKED       working days (by the calendar) from the later of the year
 *                                  start and joining, ÷ `daysWorkedPerLeaveDay`, down to the
 *                                  half day, never more than `days` — an ESTIMATE: there is
 *                                  no attendance yet, and the why line says so
 *            ON_REQUEST            `days` (prorated like UPFRONT), a yearly limit
 *            EARNED_BY_WORK        nothing automatic: only what HR enters as the opening
 *            PER_EVENT             `days` each occasion; `maxTimesInService` counts every
 *                                  APPROVED request of the type, ever
 *            UNLIMITED_UNPAID      no limit (available is null)
 *   OPENING  HR's number for the year if entered; else carried from the previous year by
 *            the rule (ALL / CAPPED / NONE) from that year's closing, computed the same
 *            way — stopping at a year with no HR row and no requests (= 0).
 *   TAKEN    APPROVED quantities of requests starting in the year.
 *   HELD     PENDING quantities.
 *
 * Below 0 only when `negativeBalanceAllowed` — and then not below −(the year's days):
 * `info.floor` is how far a request may take it.
 */
import { applicability } from '../leavePolicyRead.js';
import { MONTH_NAMES, addDays, dayText, workingDaysBetween } from './days.js';

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const floorHalf = (n) => Math.floor(Number(n) * 2) / 2;
/** 12 -> "12", 1.5 -> "1.5". */
export const plain = (n) => String(r2(n));
const pad = (n) => String(n).padStart(2, '0');

/* ══ the leave year ════════════════════════════════════════════════════════ */

/**
 * The leave year that starts in `startYear` on the 1st of `startsMonth`.
 * key: '2026' (a calendar year) or '2026-27'; label in words.
 */
export function yearFromStart(startYear, startsMonth = 1) {
  const m = Number(startsMonth) || 1;
  const y = Number(startYear);
  const from = `${y}-${pad(m)}-01`;
  const to = addDays(`${m === 1 ? y + 1 : y + 1}-${pad(m)}-01`, -1);
  if (m === 1) return { key: String(y), label: String(y), from, to };
  const key = `${y}-${pad((y + 1) % 100)}`;
  return { key, label: `${key} (${MONTH_NAMES[m - 1]} ${y} to ${MONTH_NAMES[(m + 10) % 12]} ${y + 1})`, from, to };
}

/** The leave year a date falls in. */
export function leaveYearOf(date, startsMonth = 1) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return yearFromStart(m >= (Number(startsMonth) || 1) ? y : y - 1, startsMonth);
}

/** The year of a key ('2026' or '2026-27'), or null when the key is not of this year's shape. */
export function yearOfKey(key, startsMonth = 1) {
  const s = String(key ?? '').trim();
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(s);
  if (!m) return null;
  const year = yearFromStart(Number(m[1]), startsMonth);
  return year.key === s ? year : null;
}

export const previousYear = (year, startsMonth) => yearFromStart(Number(year.from.slice(0, 4)) - 1, startsMonth);

/** Months from a's month to b's month, both counted. */
const monthsInclusive = (a, b) => (Number(b.slice(0, 4)) * 12 + Number(b.slice(5, 7))) - (Number(a.slice(0, 4)) * 12 + Number(a.slice(5, 7))) + 1;

/** A month as one number (year × 12 + month − 1), so months can be counted and compared. */
const monthIndex = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
const monthStart = (i) => `${Math.floor(i / 12)}-${pad((i % 12) + 1)}-01`;
const dayOfMonth = (d) => Number(d.slice(8, 10));
const s = (n) => (n === 1 ? '' : 's');

/* ══ earned ════════════════════════════════════════════════════════════════ */

/**
 * What the policy gives in a year, up to `asOf` (the day the leave starts; null = the
 * whole year, for a past year's closing).
 *
 * Counting starts at the LATEST of the leave-year start, the joining date and the
 * policy's `effectiveFrom` (§23.1) — nothing is earned before the policy takes effect.
 *   - joiningCutoffDay: someone who joins AFTER this day of a month earns nothing for
 *     that month (when the rule prorates on joining; MONTHLY always).
 *   - MONTHLY + creditInArrears: a month's credit is given on the first day of the NEXT
 *     month, and counts in the leave year that day falls in (December's comes on 1 January).
 *   - HALF_YEARLY: days/2 on the first day of the year and of its 7th month. The joining
 *     half is prorated days/12 per counted month left in it (prorateOnJoining); the half
 *     running on `effectiveFrom` is given in full — as it would have been given had the
 *     policy been in force from that half's start (a joiner of that half still gets their share).
 * With none of these set, every accrual counts exactly as before.
 * @returns { amount, limited, text, estimated }
 */
export function earnedOf(rule, { year, joinDate = null, asOf = null, calendar = null, effectiveFrom = null }) {
  const days = rule.days === null || rule.days === undefined ? null : Number(rule.days);
  if (rule.basis === 'UNLIMITED_UNPAID') return { amount: 0, limited: false, text: 'Unpaid, with no fixed limit' };
  if (rule.basis === 'PER_EVENT') return { amount: days ?? 0, limited: days !== null, text: days === null ? 'Given each time it is needed' : `${plain(days)} each time` };
  if (rule.accrual === 'EARNED_BY_WORK') return { amount: 0, limited: true, text: 'Earned by working on a holiday or a weekly off, as HR enters it' };
  if (days === null) return { amount: 0, limited: false, text: 'No fixed number of days' };
  if (joinDate && joinDate > year.to) return { amount: 0, limited: true, text: 'Joins after this year' };
  const eff = effectiveFrom || null;
  if (eff && eff > year.to) return { amount: 0, limited: true, text: `Nothing before the policy takes effect on ${dayText(eff, true)}` };
  const joinedInside = Boolean(joinDate) && joinDate > year.from;
  const startMonth = MONTH_NAMES[Number(year.from.slice(5, 7)) - 1];
  // Where counting starts: the joining date, else the policy's date, else the year's start.
  const startIsJoin = joinedInside && (!eff || joinDate >= eff);
  const startIsEff = !startIsJoin && Boolean(eff) && eff > year.from;
  const effWords = startIsEff ? ` from ${dayText(eff, true)}, when the policy takes effect` : '';
  const cutoff = Number(rule.joiningCutoffDay) || null;
  const lateJoin = (d) => Boolean(cutoff && d && dayOfMonth(d) > cutoff);
  const until = asOf === null || asOf > year.to ? year.to : asOf;

  if (rule.accrual === 'UPFRONT' || rule.accrual === 'ON_REQUEST') {
    const upTo = rule.accrual === 'ON_REQUEST' ? 'up to ' : '';
    if (rule.prorateOnJoining && startIsJoin) {
      const left = monthsInclusive(joinDate, year.to) - (lateJoin(joinDate) ? 1 : 0);
      const amount = floorHalf((days * left) / 12);
      return { amount, limited: true, text: `${upTo}${plain(amount)} for the ${left} month${s(left)} left after joining (${plain(days)} a year)` };
    }
    if (startIsEff) {
      const left = monthsInclusive(eff, year.to);
      const amount = floorHalf((days * left) / 12);
      return { amount, limited: true, text: `${upTo}${plain(amount)} for the ${left} month${s(left)}${effWords} (${plain(days)} a year)` };
    }
    return { amount: days, limited: true, text: rule.accrual === 'ON_REQUEST' ? `Up to ${plain(days)} a year` : `${plain(days)} a year, given in ${startMonth}` };
  }

  if (rule.accrual === 'MONTHLY') {
    const per = days / 12;
    // The first month that earns: the year's, the joining month (or the next, after the cut-off), the policy's.
    let first = monthIndex(year.from);
    if (joinDate) first = Math.max(first, monthIndex(joinDate) + (lateJoin(joinDate) ? 1 : 0));
    if (eff) first = Math.max(first, monthIndex(eff));
    if (rule.creditInArrears) {
      // Month M is credited on the 1st of M+1, inside this year: the year's first credit is for the month before it.
      let from = monthIndex(year.from) - 1;
      if (joinDate) from = Math.max(from, monthIndex(joinDate) + (lateJoin(joinDate) ? 1 : 0));
      if (eff) from = Math.max(from, monthIndex(eff));
      const to = monthIndex(until) - 1;
      const months = joinDate && until < joinDate ? 0 : Math.max(0, to - from + 1);
      const amount = Math.min(days, r2(per * months));
      return { amount, limited: true, text: `${plain(per)} a month, credited at the start of the next month${effWords}, ${plain(amount)} so far` };
    }
    const startDate = startIsJoin ? joinDate : (startIsEff ? eff : year.from);
    const months = until < startDate ? 0 : Math.max(0, monthIndex(until) - first + 1);
    const amount = Math.min(days, r2(per * months));
    return { amount, limited: true, text: `${plain(per)} a month${effWords}, ${plain(amount)} so far` };
  }

  if (rule.accrual === 'HALF_YEARLY') {
    const half = days / 2;
    const second = monthStart(monthIndex(year.from) + 6);
    const halves = [{ from: year.from, to: addDays(second, -1) }, { from: second, to: year.to }];
    const startDate = startIsJoin ? joinDate : (startIsEff ? eff : year.from);
    let amount = 0;
    let note = null;
    for (const h of halves) {
      if (h.to < startDate) continue;
      let give = half;
      let on = h.from;
      if (startDate > h.from) {
        on = startDate;
        const joinedInHalf = Boolean(joinDate) && joinDate > h.from && joinDate <= h.to;
        if (joinedInHalf && rule.prorateOnJoining) {
          const counted = Math.max(0, monthsInclusive(joinDate, h.to) - (lateJoin(joinDate) ? 1 : 0));
          give = Math.min(half, r2((days / 12) * counted));
          note = `${plain(give)} for the ${counted} month${s(counted)} left in the half-year after joining`;
        } else if (startIsEff) {
          note = `${plain(give)} for the half-year running on ${dayText(eff, true)}, when the policy takes effect`;
        }
      }
      if (on <= until) amount = r2(amount + give);
    }
    const second7 = MONTH_NAMES[(Number(year.from.slice(5, 7)) + 5) % 12];
    const plan = `${plain(days)} a year, half on 1 ${startMonth} and half on 1 ${second7}`;
    return { amount, limited: true, text: `${note ? `${note} (${plan})` : plan}, ${plain(amount)} so far` };
  }

  if (rule.accrual === 'PER_DAYS_WORKED') {
    const per = Number(rule.daysWorkedPerLeaveDay) || 0;
    const start = startIsJoin ? joinDate : (startIsEff ? eff : year.from);
    const dayBefore = asOf === null ? year.to : addDays(asOf, -1);
    const end = dayBefore > year.to ? year.to : dayBefore;
    const worked = calendar ? workingDaysBetween(calendar, start, end) : 0;
    const amount = per > 0 ? Math.min(days, floorHalf(worked / per)) : 0;
    return {
      amount, limited: true, estimated: true,
      text: `${plain(amount)} from ${worked} working day${worked === 1 ? '' : 's'} (estimated from the shift calendar; there is no attendance yet)`,
    };
  }
  return { amount: days, limited: true, text: `${plain(days)} a year` };
}

/* ══ the balance ═══════════════════════════════════════════════════════════ */

const yearOfRequest = (r, startsMonth) => leaveYearOf(r.from, startsMonth).key;
const sum = (rows) => r2(rows.reduce((s, r) => s + Number(r.quantity || 0), 0));

/**
 * One balance.
 * @param rule        the rule (wire shape, with leaveTypeId, leaveTypeCode, leaveTypeName, isPaid, summary)
 * @param year        { key, label, from, to }
 * @param startsMonth the policy's year_starts_month
 * @param joinDate    'YYYY-MM-DD'
 * @param asOf        the day the leave starts (or today); earned is counted up to it
 * @param openings    Map<yearKey, { opening, note }> — HR's openings for this type
 * @param requests    this person's requests of this type: [{ id, status, quantity, from }]
 * @param calendar    from days.makeCalendar
 * @param excludeRequestId leave this request out (its own hold, on approve)
 * @param effectiveFrom the policy's `effective_from` ('YYYY-MM-DD' | null): nothing is earned before it
 * @returns { balance: Balance (without canAsk), info: { floor, fullDays, perOccasion, timesUsed, timesHeld, maxTimes } }
 */
export function balanceOf({ rule, year, startsMonth = 1, joinDate = null, asOf = null, openings = new Map(), requests = [], calendar = null, excludeRequestId = null, effectiveFrom = null }) {
  const reqs = requests.filter((r) => r.id !== excludeRequestId);
  const inYear = (y) => reqs.filter((r) => yearOfRequest(r, startsMonth) === y.key);
  const taken = (y) => sum(inYear(y).filter((r) => r.status === 'APPROVED'));
  const held = (y) => sum(inYear(y).filter((r) => r.status === 'PENDING'));
  const a = applicability(rule);
  const fullDays = rule.days === null || rule.days === undefined ? null : Number(rule.days);
  const base = {
    leaveTypeId: rule.leaveTypeId, code: rule.leaveTypeCode, name: rule.leaveTypeName, isPaid: Boolean(rule.isPaid),
    rule: rule.summary ?? '', halfDayAllowed: Boolean(a.halfDayAllowed && rule.halfDayAllowed),
  };
  const tk = taken(year);
  const hd = held(year);
  const tail = [tk ? `${plain(tk)} taken` : null, hd ? `${plain(hd)} waiting for approval` : null];
  const words = (parts) => { const s = parts.filter(Boolean).join(' · '); return s.charAt(0).toUpperCase() + s.slice(1); };

  if (rule.basis === 'UNLIMITED_UNPAID') {
    return {
      balance: { ...base, limited: false, opening: 0, earned: 0, taken: tk, held: hd, available: null, why: words(['Unpaid, with no fixed limit', ...tail]) },
      info: { floor: null, fullDays: null },
    };
  }

  if (rule.basis === 'PER_EVENT') {
    const used = reqs.filter((r) => r.status === 'APPROVED').length;
    const waiting = reqs.filter((r) => r.status === 'PENDING').length;
    const max = rule.maxTimesInService ? Number(rule.maxTimesInService) : null;
    const timesLeft = max === null ? null : Math.max(0, max - used - waiting);
    const available = fullDays === null ? null : (timesLeft === 0 ? 0 : fullDays);
    const each = fullDays === null ? 'Given each time it is needed' : `${plain(fullDays)} each time`;
    const times = max === null ? null : `${used} of ${max} time${max === 1 ? '' : 's'} used`;
    return {
      balance: { ...base, limited: fullDays !== null, opening: 0, earned: fullDays ?? 0, taken: tk, held: hd, available, why: words([each, times, ...tail]) },
      info: { floor: 0, fullDays, perOccasion: fullDays, timesUsed: used, timesHeld: waiting, maxTimes: max },
    };
  }

  // ── opening: HR's number, or carried from the year before ──
  const carries = a.carryForward ? (rule.carryForward ?? 'NONE') : 'NONE';
  const cap = rule.carryForwardCapDays === null || rule.carryForwardCapDays === undefined ? 0 : Number(rule.carryForwardCapDays);
  const openingOf = (y, depth) => {
    const hr = openings.get(y.key);
    if (hr) return { value: r2(hr.opening), text: `${plain(hr.opening)} opening balance entered by HR` };
    if (carries === 'NONE' || depth >= 10) return { value: 0, text: null };
    const prev = previousYear(y, startsMonth);
    if (joinDate && prev.to < joinDate) return { value: 0, text: null };
    if (effectiveFrom && prev.to < effectiveFrom) return { value: 0, text: null };
    const active = openings.has(prev.key) || reqs.some((r) => yearOfRequest(r, startsMonth) === prev.key);
    if (!active) return { value: 0, text: null };
    const closing = r2(openingOf(prev, depth + 1).value + earnedOf(rule, { year: prev, joinDate, asOf: null, calendar, effectiveFrom }).amount - taken(prev) - held(prev));
    const carried = carries === 'ALL' ? closing : Math.min(closing, cap);
    return { value: r2(carried), text: carried ? `${plain(carried)} carried from ${prev.key}` : null };
  };
  const opening = openingOf(year, 0);
  const earned = earnedOf(rule, { year, joinDate, asOf, calendar, effectiveFrom });
  if (!earned.limited) {
    return {
      balance: { ...base, limited: false, opening: opening.value, earned: 0, taken: tk, held: hd, available: null, why: words([earned.text, opening.text, ...tail]) },
      info: { floor: null, fullDays },
    };
  }
  const available = r2(opening.value + earned.amount - tk - hd);
  const negative = a.negativeBalanceAllowed && rule.negativeBalanceAllowed;
  return {
    balance: { ...base, limited: true, opening: opening.value, earned: r2(earned.amount), taken: tk, held: hd, available, why: words([earned.text, opening.text, ...tail]) },
    info: { floor: negative ? -(fullDays ?? 0) : 0, fullDays, estimated: Boolean(earned.estimated) },
  };
}

export default { yearFromStart, leaveYearOf, yearOfKey, previousYear, earnedOf, balanceOf, plain };
