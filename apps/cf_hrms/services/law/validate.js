/**
 * validate.js — is a law value well formed for its domain, and do its worked examples come out?
 * Pure. Run by store.publishVersion before anything is published.
 *
 * Worked examples live in the value itself (value.examples), so a reviewer writes them with the
 * rule and every later version is checked against them:
 *   PF   [{ pfWage, mode?, employee, employer? }]
 *   ESI  [{ esiWage, payableDays?, employee, employer? }]
 *   PT   [{ gross, month?, amount }]
 *   LWF  [{ month: 'YYYY-MM', employee, employer? }]
 *   MIN_WAGE [{ zone, skill, total }]          (total = basic + VDA a month)
 */
import { pfFor, esiFor, ptFor, lwfFor } from '../payroll/statutory.js';
import { minimumWageFrom } from './minWage.js';

const isNum = (v) => v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) >= 0;

/** The shape PF / ESI / PT / LWF `settings` need (the same checks the old statutory screen made). */
export function settingsProblems(kind, s) {
  const p = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['Settings: send the values as an object.'];
  const need = (keys) => { for (const k of keys) if (!isNum(s[k])) p.push(`${k}: a number, zero or more.`); };
  if (kind === 'PF') need(['employeeRate', 'employerRate', 'epsRate', 'wageCeiling', 'edliRate', 'adminRate']);
  if (kind === 'ESI') {
    need(['employeeRate', 'employerRate', 'wageCeiling']);
    if (s.periods && (!Array.isArray(s.periods) || s.periods.some((x) => !/^\d{2}-\d{2}$/.test(x?.from ?? '') || !/^\d{2}-\d{2}$/.test(x?.to ?? '')))) p.push('periods: a list of { from: "MM-DD", to: "MM-DD" }.');
  }
  if (kind === 'PT') {
    if (!Array.isArray(s.slabs) || !s.slabs.length) p.push('slabs: a list of { upTo, amount } — the last with upTo empty.');
    else {
      s.slabs.forEach((x, i) => {
        if (!isNum(x?.amount)) p.push(`Slab ${i + 1}: the amount is a number.`);
        if (x?.upTo != null && x.upTo !== '' && !isNum(x.upTo)) p.push(`Slab ${i + 1}: "up to" is a number, or empty for the top slab.`);
      });
      if (s.slabs.filter((x) => x?.upTo == null || x.upTo === '').length !== 1) p.push('slabs: exactly one slab has no upper limit (the top one).');
    }
  }
  if (kind === 'LWF') {
    need(['employee', 'employer']);
    if (!Array.isArray(s.months) || s.months.some((m) => !Number.isInteger(Number(m)) || m < 1 || m > 12)) p.push('months: the months it is deducted in, 1–12.');
  }
  if (s.rounding && !['NEAREST', 'UP', 'DOWN'].includes(s.rounding)) p.push('rounding: NEAREST, UP or DOWN.');
  return p;
}

export const SKILLS = ['UNSKILLED', 'SEMI_SKILLED', 'SKILLED', 'HIGHLY_SKILLED'];

export function valueProblems(domain, ruleKey, value) {
  if (value == null || typeof value !== 'object') return ['The value is an object.'];
  if (['PF', 'ESI', 'PT', 'LWF'].includes(domain) && ruleKey === 'settings') return settingsProblems(domain, value);
  if (domain === 'MIN_WAGE') {
    const p = [];
    if (!Array.isArray(value.rates) || !value.rates.length) p.push('rates: a list of { zone, skill, basic, vda }.');
    else value.rates.forEach((r, i) => {
      if (!r?.zone) p.push(`Rate ${i + 1}: the zone.`);
      if (!SKILLS.includes(r?.skill)) p.push(`Rate ${i + 1}: skill is one of ${SKILLS.join(', ')}.`);
      if (!isNum(r?.basic)) p.push(`Rate ${i + 1}: basic is a number.`);
      if (r?.vda != null && !isNum(r.vda)) p.push(`Rate ${i + 1}: VDA is a number (or empty while not notified).`);
    });
    return p;
  }
  return [];
}

const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

/** The worked examples that do not come out: ['Example 2: PT on 18,000 is 150, the rule gives 200.'] */
export function runExamples(domain, ruleKey, value) {
  const ex = Array.isArray(value?.examples) ? value.examples : [];
  const out = [];
  ex.forEach((e, i) => {
    const n = `Example ${i + 1}`;
    try {
      if (domain === 'PT') {
        const got = ptFor({ gross: Number(e.gross), settings: value, month: e.month ?? null }).amount;
        if (!eq(got, e.amount)) out.push(`${n}: professional tax on ${e.gross} should be ${e.amount}; the rule gives ${got}.`);
      } else if (domain === 'PF') {
        const got = pfFor({ pfWage: Number(e.pfWage), mode: e.mode ?? 'CEILING', settings: value });
        if (!eq(got.employee, e.employee) || (e.employer != null && !eq(got.employer, e.employer))) out.push(`${n}: PF on ${e.pfWage} should be ${e.employee}/${e.employer ?? '—'}; the rule gives ${got.employee}/${got.employer}.`);
      } else if (domain === 'ESI') {
        const got = esiFor({ esiWage: Number(e.esiWage), covered: true, payableDays: Number(e.payableDays ?? 30), settings: value });
        if (!eq(got.employee, e.employee) || (e.employer != null && !eq(got.employer, e.employer))) out.push(`${n}: ESI on ${e.esiWage} should be ${e.employee}/${e.employer ?? '—'}; the rule gives ${got.employee}/${got.employer}.`);
      } else if (domain === 'LWF') {
        const got = lwfFor({ month: e.month, paid: true, settings: value });
        if (!eq(got.employee, e.employee) || (e.employer != null && !eq(got.employer, e.employer))) out.push(`${n}: LWF in ${e.month} should be ${e.employee}/${e.employer ?? '—'}; the rule gives ${got.employee}/${got.employer}.`);
      } else if (domain === 'MIN_WAGE') {
        const got = minimumWageFrom(value, { zone: e.zone, skill: e.skill });
        if (!got || !eq(got.total, e.total)) out.push(`${n}: the minimum wage for zone ${e.zone}, ${e.skill} should be ${e.total}; the rule gives ${got?.total ?? 'nothing'}.`);
      }
    } catch (err) {
      out.push(`${n}: could not be worked out (${err.message}).`);
    }
  });
  return out;
}

export default { settingsProblems, valueProblems, runExamples, SKILLS };
