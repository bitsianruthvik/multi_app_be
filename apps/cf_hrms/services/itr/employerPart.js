/**
 * employerPart.js — "From your employer": what payroll knows about the person's year, read LIVE
 * from their RELEASED payslips (services/payroll, P1). Read-only; payroll files are not touched.
 *
 * Until P2 (income tax in payroll) there is no Form 16 / 130 in the app, so the year's figures
 * are the sums of the released payslips' snapshots (hrms_pay_payslips.snapshot_json — the same
 * numbers the payslip PDF prints):
 *   gross salary     = Σ earnings (reimbursements are not salary)
 *   professional tax = Σ deduction lines of the component whose statutory key is PT
 *   TDS              = Σ "TDS of the month"
 *   PF (employee)    = Σ deduction lines of the PF_EE component — a hint for 80C / s.123
 *   HRA received     = Σ earning lines of components whose exemption rule is HRA — a hint
 *   Basic, DA        = Σ earning lines coded BASIC / DA (arrears included) — the salary of the
 *                      80CCD(2) limit and of the HRA working; the person may type over them
 * With no released payslip in the year this returns months 0, and the person types the
 * certificate's figures themselves (itr.js salaryBlock marks them "typed by you").
 */
import { yearBounds } from '../tax/rules.js';

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const money = (v) => Math.round(n(v) * 100) / 100;
const json = (v) => { if (v == null) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } };

/** The employer's part of `year` for one employee: { source, months, monthList, employerName, grossSalary, professionalTax, tds, pfEmployee, hraReceived, basic, da, complete }. */
export async function employerPart(db, companyId, employeeId, year, { today = null } = {}) {
  const { startYear, endYear } = yearBounds(year);
  const from = `${startYear}-04`;
  const to = `${endYear}-03`;
  const [slips] = await db.query(
    `SELECT period_month, snapshot_json FROM hrms_pay_payslips
      WHERE company_id = ? AND employee_id = ? AND status = 'RELEASED' AND deleted_at IS NULL AND period_month >= ? AND period_month <= ?
      ORDER BY period_month, version`,
    [companyId, employeeId, from, to],
  );
  const [comps] = await db.query(
    "SELECT code, statutory_key, exemption_rule FROM hrms_pay_components WHERE company_id = ? AND deleted_at IS NULL",
    [companyId],
  ).catch(() => [[]]);
  const ptCodes = new Set(comps.filter((c) => c.statutory_key === 'PT').map((c) => c.code));
  const pfCodes = new Set(comps.filter((c) => c.statutory_key === 'PF_EE').map((c) => c.code));
  const hraCodes = new Set(comps.filter((c) => String(c.exemption_rule ?? '').toUpperCase() === 'HRA').map((c) => c.code));
  if (!ptCodes.size) ptCodes.add('PT');
  if (!pfCodes.size) pfCodes.add('PF_EE');

  const out = { source: 'PAYROLL', months: 0, monthList: [], employerName: null, grossSalary: 0, professionalTax: 0, tds: 0, pfEmployee: 0, hraReceived: 0, basic: 0, da: 0 };
  for (const s of slips) {
    const snap = json(s.snapshot_json);
    out.months += 1;
    if (!out.monthList.includes(s.period_month)) out.monthList.push(s.period_month);
    out.employerName = snap.company?.legalName || snap.company?.name || out.employerName;
    out.grossSalary += (snap.earnings ?? []).reduce((a, l) => a + n(l.amount), 0);
    out.professionalTax += (snap.deductions ?? []).filter((l) => ptCodes.has(l.code)).reduce((a, l) => a + n(l.amount), 0);
    out.pfEmployee += (snap.deductions ?? []).filter((l) => pfCodes.has(l.code)).reduce((a, l) => a + n(l.amount), 0);
    out.hraReceived += (snap.earnings ?? []).filter((l) => hraCodes.has(l.code)).reduce((a, l) => a + n(l.amount), 0);
    out.basic += (snap.earnings ?? []).filter((l) => String(l.code ?? '').toUpperCase() === 'BASIC').reduce((a, l) => a + n(l.amount), 0);
    out.da += (snap.earnings ?? []).filter((l) => String(l.code ?? '').toUpperCase() === 'DA').reduce((a, l) => a + n(l.amount), 0);
    out.tds += n(snap.tds);
  }
  for (const k of ['grossSalary', 'professionalTax', 'tds', 'pfEmployee', 'hraReceived', 'basic', 'da']) out[k] = money(out[k]);
  const yearOver = today ? today > `${endYear}-03-31` : false;
  out.complete = yearOver && out.monthList.length > 0;
  out.provisional = out.months > 0 && !yearOver;
  out.note = !out.months
    ? 'No payslip of this year has been released to you, so type the figures from your Form 16 / 130.'
    : `${out.monthList.length} month(s) of released payslips (${out.monthList[0]} to ${out.monthList[out.monthList.length - 1]})${out.provisional ? ' — the year is not over, so these figures are provisional' : ''}.`;
  return out;
}
