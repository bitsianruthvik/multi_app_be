/**
 * statutory.js — PF, ESI, professional tax and labour welfare fund for one person and one
 * month. (TM/CF_HRMS_HIRING_SPEC.md §25.2.) Pure.
 *
 * EVERY RATE, CEILING AND SLAB COMES FROM THE DATED SETTINGS (hrms_pay_statutory_settings,
 * seeded with their sources in seed.js), handed in as `settings`. Nothing here knows a rate.
 *
 *   PF   { employeeRate, employerRate, epsRate, wageCeiling, edliRate, adminRate, rounding }
 *   ESI  { employeeRate, employerRate, wageCeiling, exemptDailyWage, periods: [{ from: 'MM-DD', to: 'MM-DD' }], rounding }
 *   PT   { slabs: [{ upTo: number|null, amount }], basis: 'GROSS' }       (monthly, on the month's gross)
 *   LWF  { employee, employer, months: [1..12] }                          (in the months listed)
 *
 * Rounding: 'NEAREST' (half up), 'UP' (to the next rupee), 'DOWN'.
 */
import { money } from './formula.js';

export function roundBy(x, how = 'NEAREST') {
  const v = Number(x) || 0;
  if (how === 'UP') return Math.ceil(v - 1e-9);
  if (how === 'DOWN') return Math.floor(v + 1e-9);
  return Math.round(v + 1e-9);
}
const pct = (rate, base) => (Number(rate) || 0) * (Number(base) || 0) / 100;
const inr = (v) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/**
 * PF for the month.
 * @param pfWage      the month's PF wage (earnings that count toward PF, as paid)
 * @param mode        'CEILING' (on the wage up to the ceiling) · 'FULL' (on the whole wage, the person and
 *                    employer opted for it) · 'NONE' (not a member: an excluded employee)
 * @param extraBase   PF base of arrears for earlier months (already capped per month by the caller)
 * @param noEps       a member past 58: no pension contribution, the employer's whole share goes to EPF
 * @returns {{ base, employee, employer, eps, epf, edli, admin, basis }}
 */
export function pfFor({ pfWage, mode = 'CEILING', extraBase = 0, settings, noEps = false }) {
  const s = settings ?? {};
  const zero = { base: 0, employee: 0, employer: 0, eps: 0, epf: 0, edli: 0, admin: 0, basis: mode === 'NONE' ? 'not a PF member' : 'no PF wage this month' };
  if (mode === 'NONE' || !s.employeeRate) return zero;
  const ceiling = Number(s.wageCeiling) || Infinity;
  const own = mode === 'FULL' ? Math.max(0, pfWage) : Math.min(Math.max(0, pfWage), ceiling);
  const base = money(own + (Number(extraBase) || 0));
  if (base <= 0) return zero;
  const how = s.rounding ?? 'NEAREST';
  const employee = roundBy(pct(s.employeeRate, base), how);
  const employer = roundBy(pct(s.employerRate, base), how);
  // EPS is on the wage up to the ceiling only, whatever the PF base; the rest of the employer's share is EPF.
  const eps = noEps ? 0 : Math.min(employer, roundBy(pct(s.epsRate, Math.min(base, ceiling)), how));
  const epf = employer - eps;
  const edli = money(pct(s.edliRate, Math.min(base, ceiling)));
  const admin = money(pct(s.adminRate, base));
  const capped = mode === 'CEILING' && pfWage > ceiling;
  const basis = `${s.employeeRate}% of ${inr(base)}${capped ? ` (wage ${inr(pfWage)}, capped at ${inr(ceiling)})` : ''}${extraBase ? ` incl. ${inr(extraBase)} of arrears` : ''}`;
  return { base, employee, employer, eps, epf, edli, admin, basis };
}

/** The ESI contribution period a month falls in: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }. */
export function esiPeriodOf(month, settings) {
  const periods = settings?.periods?.length ? settings.periods : [{ from: '04-01', to: '09-30' }, { from: '10-01', to: '03-31' }];
  const [y, m] = String(month).split('-').map(Number);
  for (const p of periods) {
    const [fm] = p.from.split('-').map(Number);
    const [tm] = p.to.split('-').map(Number);
    const wraps = tm < fm;
    const inside = wraps ? (m >= fm || m <= tm) : (m >= fm && m <= tm);
    if (!inside) continue;
    const startYear = wraps && m <= tm ? y - 1 : y;
    const endYear = wraps ? startYear + 1 : startYear;
    return { from: `${startYear}-${p.from}`, to: `${endYear}-${p.to}` };
  }
  return { from: `${month}-01`, to: `${month}-28` };
}

/**
 * Is the person covered by ESI for the month? Coverage is decided at the START of a
 * contribution period (or on joining, when that is later): a wage rate at or under the
 * ceiling then means covered until the period ends, even if a raise takes it over.
 * @param rateAtStart  the monthly ESI wage rate (full month, before proration) on that day
 */
export function esiCovered({ rateAtStart, settings }) {
  const ceiling = Number(settings?.wageCeiling) || 0;
  if (!settings?.employeeRate || !ceiling) return false;
  return rateAtStart != null && rateAtStart > 0 && rateAtStart <= ceiling;
}

/**
 * ESI for the month.
 * @param esiWage      the month's ESI wage, as paid
 * @param payableDays  for the daily-wage exemption of the employee's share
 */
export function esiFor({ esiWage, covered, payableDays, settings }) {
  const s = settings ?? {};
  if (!covered || !(esiWage > 0)) return { wage: 0, employee: 0, employer: 0, exempt: false, basis: covered ? 'no ESI wage this month' : 'not covered by ESI' };
  const how = s.rounding ?? 'UP';
  const daily = payableDays > 0 ? esiWage / payableDays : 0;
  const exempt = Boolean(s.exemptDailyWage) && daily > 0 && daily <= Number(s.exemptDailyWage);
  const employee = exempt ? 0 : roundBy(pct(s.employeeRate, esiWage), how);
  const employer = roundBy(pct(s.employerRate, esiWage), how);
  return {
    wage: money(esiWage), employee, employer, exempt,
    basis: exempt ? `employee share exempt: ${inr(money(daily))} a day is at or under ${inr(s.exemptDailyWage)}` : `${s.employeeRate}% of ${inr(money(esiWage))}`,
  };
}

/** Professional tax of the month on the month's gross, by the slabs. */
export function ptFor({ gross, settings, month = null }) {
  const slabs = settings?.slabs ?? [];
  if (!(gross > 0) || !slabs.length) return { amount: 0, basis: slabs.length ? 'no pay this month' : 'no professional tax for this state' };
  const sorted = [...slabs].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  const slab = sorted.find((s) => s.upTo == null || gross <= Number(s.upTo)) ?? sorted[sorted.length - 1];
  const mm = month ? String(month).slice(5, 7) : null;
  const amount = Number(slab.monthAmounts?.[mm] ?? slab.amount) || 0;
  const i = sorted.indexOf(slab);
  const lower = i > 0 ? Number(sorted[i - 1].upTo) + 1 : 0;
  const range = slab.upTo == null ? `over ${inr(lower - 1)}` : `${inr(lower)} to ${inr(slab.upTo)}`;
  return { amount, basis: `gross ${inr(money(gross))}: slab ${range}` };
}

/** Labour welfare fund, in the months the settings name. */
export function lwfFor({ month, paid, settings }) {
  const m = Number(String(month).slice(5, 7));
  const months = settings?.months ?? [];
  if (!paid || !months.includes(m)) return { employee: 0, employer: 0, basis: months.length ? `due in ${months.map((x) => ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][x]).join(', ')}` : 'no labour welfare fund for this state' };
  return { employee: Number(settings.employee) || 0, employer: Number(settings.employer) || 0, basis: 'the year’s contribution' };
}

export default { roundBy, pfFor, esiPeriodOf, esiCovered, esiFor, ptFor, lwfFor };
