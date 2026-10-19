/**
 * sheet.js — the tax sheet: a person's year as of a month, worked out exactly as the run works it
 * out (runTax.js), both regimes side by side, and what the cheaper one saves.
 * (TM/CF_HRMS_HIRING_SPEC.md §25.4 "Tax sheet".) The same answer for the person (My tax) and HR.
 *
 * As of month M: when there is a run for M with the person in it, its lines are the month (so the
 * sheet of a locked run is the run's working); else M is worked from the salary.
 */
import { inr } from '../tax/index.js';
import { yearMonths, employeeRow, json, money, today, formsOf } from './common.js';
import { loadTaxWorld, personTax, monthFromLines } from './runTax.js';
import { review } from './settings.js';
import { monthBounds } from '../payroll/proration.js';

/** The month a sheet opens on: the latest run month of the year up to today, else this month in the year. */
async function defaultMonth(db, companyId, year) {
  const months = yearMonths(year);
  const t = today().slice(0, 7);
  const [[r]] = await db.query('SELECT MAX(period_month) AS m FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND period_month >= ? AND period_month <= ? AND period_month <= ?', [companyId, months[0], months[11], t]);
  if (r?.m) return r.m;
  if (t >= months[0] && t <= months[11]) return t;
  return t < months[0] ? months[0] : months[11];
}

const shapeComputation = (k) => ({
  regime: k.regime, grossSalary: k.grossSalary, totalExempt: k.totalExempt, previousEmployerSalary: k.previousEmployerSalary, standardDeduction: k.standardDeduction,
  professionalTax: k.professionalTax, incomeFromSalary: k.incomeFromSalary, otherIncome: k.otherIncome, houseProperty: k.houseProperty, grossTotalIncome: k.grossTotalIncome,
  totalDeductions: k.totalDeductions, taxableIncome: k.taxableIncome, slabTax: k.slabTax, rebate: k.rebate, surcharge: k.surcharge, cess: k.cess, totalTax: k.totalTax,
  exemptions: k.exemptions, deductions: k.deductions, refused: k.refused, lines: k.lines, warnings: k.warnings,
});

export async function taxSheet(db, c, employeeId, year, { month = null } = {}) {
  const employee = await employeeRow(db, c.companyId, employeeId);
  const months = yearMonths(year);
  const M = month && months.includes(month) ? month : await defaultMonth(db, c.companyId, year);
  const [[run]] = await db.query('SELECT id, status FROM hrms_pay_runs WHERE company_id = ? AND period_month = ? AND deleted_at IS NULL', [c.companyId, M]);
  let current = null;
  let runPerson = null;
  if (run) {
    const [[p]] = await db.query('SELECT id, tds_amount, tds_source, tax_json, included FROM hrms_pay_run_people WHERE company_id = ? AND run_id = ? AND employee_id = ? AND deleted_at IS NULL', [c.companyId, run.id, employeeId]);
    if (p?.included) {
      runPerson = p;
      const [lines] = await db.query('SELECT component_id, kind, amount FROM hrms_pay_run_lines WHERE company_id = ? AND run_person_id = ? AND deleted_at IS NULL', [c.companyId, p.id]);
      current = { lines };
    }
  }
  const world = await loadTaxWorld(db, c.companyId, M, [employeeId], { runId: run?.id ?? null });
  if (current) current = monthFromLines(current.lines.map((l) => ({ ...l, comp: world.comps.byId.get(l.component_id) })));
  const t = await personTax(world, employeeId, { current });
  const base = {
    employee: { id: employee.id, code: employee.code, name: employee.name }, year, month: M, monthLabel: monthBounds(M).label, months,
    forms: formsOf(world.rules), review: review(world.settings),
    run: run ? { id: run.id, status: run.status, tds: runPerson ? money(runPerson.tds_amount) : null, source: runPerson?.tds_source ?? null, saved: json(runPerson?.tax_json, null) } : null,
  };
  if (!t) return { ...base, available: false, reason: `No pay in ${year} up to ${base.monthLabel} and after it.` };
  if (!t.available) return { ...base, available: false, reason: t.warnings[0] };
  const regimeWord = (r) => (r === 'OLD' ? 'the old regime' : 'the new regime');
  const sentence = t.saving === 0
    ? `Both regimes come to ${inr(t.projections.NEW.projectedTax)} for the year; the new regime is the default.`
    : `You save ${inr(t.saving)} in ${regimeWord(t.cheaper)} (${inr(t.projections[t.cheaper].projectedTax)} against ${inr(t.projections[t.cheaper === 'OLD' ? 'NEW' : 'OLD'].projectedTax)}).`;
  return {
    ...base, available: true,
    regime: t.regime, cheaper: t.cheaper, saving: t.saving, sentence, chosenIsCheaper: t.regime === t.cheaper || t.saving === 0,
    tds: { thisMonth: t.tds, yearTax: t.yearTax, projectedTax: t.projectedTax, soFar: t.tdsSoFar, previousEmployer: t.previousEmployerTds, monthsLeft: t.monthsLeft, excess: t.excess },
    noPan: t.noPan, panStatus: t.panStatus, proofsStatus: t.proofsStatus, city: t.city, metro: t.metro, metroFrom: t.metroFrom,
    regimes: Object.fromEntries(['OLD', 'NEW'].map((r) => [r, {
      projectedTax: t.projections[r].projectedTax, thisMonthTds: t.noPanBoth[r].applied ? t.noPanBoth[r].thisMonthTds : t.projections[r].thisMonthTds,
      projection: t.projections[r].lines, computation: shapeComputation(t.projections[r].computation), noPan: t.noPanBoth[r].applied ? t.noPanBoth[r] : null,
    }])),
    timeline: t.timeline, claims: t.claims, pfIn80C: t.pfIn80C, professionalTax: t.professionalTax, previousEmployer: t.previousEmployer,
    warnings: t.warnings,
  };
}
