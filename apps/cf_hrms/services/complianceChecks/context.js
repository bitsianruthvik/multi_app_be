/**
 * context.js — what the checks need from the database: the law in force for a state and day, a
 * person's place in the law, a month's pay worked out (take-home, company cost, PF / ESI) for the
 * before / after of a fix. Reads only.
 */
import { lawInForce } from '../law/store.js';
import { statutoryFromLaw } from '../law/statutory.js';
import { minimumWageOn } from '../law/minWage.js';
import { lawPlacesOf } from '../law/personLaw.js';
import { pfFor, esiFor, ptFor } from '../payroll/statutory.js';
import * as K from './checks.js';

const money = (x) => Math.round((Number(x) || 0) * 100) / 100;
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const dateText = (v) => (v == null ? null : (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v).slice(0, 10)));

/** A per-call cache: law and minimum wages by (state, day). */
export function lawCache(db) {
  const law = new Map();
  const mw = new Map();
  const stat = new Map();
  return {
    async law(state, on) {
      const k = `${state}|${on}`;
      if (!law.has(k)) law.set(k, lawFor(db, state, on));
      return law.get(k);
    },
    async minWage(place, on) {
      const k = `${place.state}|${place.employment}|${place.zone}|${place.skill}|${on}`;
      if (!mw.has(k)) mw.set(k, minimumWageOn(db, { state: place.state, employment: place.employment, zone: place.zone, skill: place.skill, on }));
      return mw.get(k);
    },
    async statutory(state, on) {
      const k = `${state}|${on}`;
      if (!stat.has(k)) stat.set(k, statutoryFromLaw(db, on, state));
      return stat.get(k);
    },
  };
}

/** The law the checks read, for a state on a day. */
export async function lawFor(db, state, on) {
  const st = String(state || 'TG').toUpperCase();
  const rules = await lawInForce(db, { domains: ['MIN_WAGE', 'WAGES', 'OVERTIME', 'LEAVE_MIN', 'BONUS'], jurisdictions: ['IN', st], on });
  const find = (domain, key, j = null) => rules.find((r) => r.domain === domain && r.ruleKey === key && (!j || r.jurisdiction === j)) ?? null;
  return {
    state: st, on, rules,
    wages: find('WAGES', 'fifty_percent_rule'),
    otRate: find('OVERTIME', 'rate', 'IN'),
    otCap: find('OVERTIME', 'quarterly_cap', st),
    leave: find('LEAVE_MIN', 'annual_leave_factory', 'IN'),
    bonus: {
      eligibility: find('BONUS', 'eligibility'), rates: find('BONUS', 'rates'), ceiling: find('BONUS', 'calculation_ceiling'),
      setOnOff: find('BONUS', 'set_on_set_off'), paymentTime: find('BONUS', 'payment_time'),
    },
  };
}

/** Company payroll state (hrms_pay_settings), default TG. */
export async function companyState(db, companyId) {
  const [[r]] = await db.query('SELECT state_code FROM hrms_pay_settings WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return r?.state_code ?? 'TG';
}

/** Map(employeeId → place) with the salary's own state winning. */
export async function placesOf(db, companyId, employeeIds, on, salaryState = new Map()) {
  const places = await lawPlacesOf(db, companyId, employeeIds, on);
  for (const [id, p] of places) if (salaryState.get(id)) places.set(id, { ...p, state: salaryState.get(id), stateFrom: 'SALARY' });
  return places;
}

/** The pay lines (breakdown) with the component's kind / code the checks read. */
export const asLines = (lines, compsByCode = null) => (lines ?? []).map((l) => {
  const c = compsByCode?.get?.(l.code) ?? null;
  return { code: l.code, name: l.name ?? c?.name ?? l.code, kind: l.kind ?? c?.kind, statutoryKey: l.statutoryKey ?? c?.statutoryKey ?? null, amount: Number(l.amount ?? l.monthly) || 0, frequency: l.frequency ?? c?.frequency ?? 'MONTHLY' };
});

/**
 * Every check of one person's month on a salary breakdown: minimum wage, the 50% rule, statutory, usual
 * shares. `lines` are the breakdown's monthly lines (structure.js), `factor` = days paid ÷ days.
 */
export async function personResults(cache, { lines, place, on, pfMode = 'CEILING', components, factor = 1, structureChecks = true }) {
  const law = await cache.law(place.state, on);
  const mw = await cache.minWage(place, on);
  const settings = await cache.statutory(place.state, on);
  const L = asLines(lines, components?.byCode ?? null);
  const monthlyEarn = L.filter((l) => l.kind === 'EARNING' && l.frequency === 'MONTHLY');
  const comps = components?.byCode ?? new Map();
  const pfWage = monthlyEarn.filter((l) => comps.get(l.code)?.inPfWage).reduce((s, l) => s + l.amount, 0);
  const esiWage = monthlyEarn.filter((l) => comps.get(l.code)?.inEsiWage).reduce((s, l) => s + l.amount, 0);
  const gross = monthlyEarn.reduce((s, l) => s + l.amount, 0);
  const out = [
    ...K.checkMinimumWage({ lines: L.filter((l) => l.frequency === 'MONTHLY'), minWage: mw, factor, place, wagesRule: law.wages }),
    ...(structureChecks ? K.checkFiftyPercent({ lines: L, rule: law.wages }) : []),
    ...K.checkStatutory({ components: components?.list ?? [], settings, pfMode, pfWage: money(pfWage), esiWage: money(esiWage), gross: money(gross) }),
    ...(structureChecks ? K.checkAllowanceShares({ lines: L }) : []),
  ];
  return out.sort(K.bySeverity);
}

/**
 * A month's pay from a breakdown, full month: { gross, reimbursements, pfEe, pfEr, esiEe, esiEr, pt, takeHome, cost }.
 * The run works it out the same way (calc.js) — this is the preview of a fix, not a payslip.
 */
export function monthlyPay(lines, compsByCode, settings = {}, pfMode = 'CEILING') {
  const L = asLines(lines, compsByCode).filter((l) => l.frequency === 'MONTHLY');
  const earn = L.filter((l) => l.kind === 'EARNING');
  const gross = earn.reduce((s, l) => s + l.amount, 0);
  const reimb = L.filter((l) => l.kind === 'REIMBURSEMENT').reduce((s, l) => s + l.amount, 0);
  const pfWage = earn.filter((l) => compsByCode.get(l.code)?.inPfWage).reduce((s, l) => s + l.amount, 0);
  const esiWage = earn.filter((l) => compsByCode.get(l.code)?.inEsiWage).reduce((s, l) => s + l.amount, 0);
  const pf = pfFor({ pfWage, mode: pfMode, settings: settings.PF });
  const covered = Boolean(settings.ESI) && esiWage <= Number(settings.ESI?.wageCeiling ?? 0);
  const esi = esiFor({ esiWage, covered, payableDays: 30, settings: settings.ESI });
  const pt = ptFor({ gross, settings: settings.PT }).amount;
  const otherEmployer = L.filter((l) => l.kind === 'EMPLOYER_CONTRIBUTION' && !['PF_ER', 'ESI_ER', 'LWF_ER'].includes(l.statutoryKey)).reduce((s, l) => s + l.amount, 0);
  return {
    gross: money(gross), reimbursements: money(reimb), pfWage: money(pfWage), pfEe: pf.employee, pfEr: pf.employer, esiEe: esi.employee, esiEr: esi.employer, pt,
    takeHome: money(gross + reimb - pf.employee - esi.employee - pt), cost: money(gross + reimb + pf.employer + esi.employer + otherEmployer),
  };
}

export default { lawCache, lawFor, companyState, placesOf, asLines, personResults, monthlyPay, today, dateText };
