/**
 * calc.js — one person's pay for one month. (TM/CF_HRMS_HIRING_SPEC.md §25.2.) Pure.
 *
 * runService.js reads everything (salaries, their breakdowns, LOP days, one-time items,
 * arrears, the statutory settings of the month) and hands it in; this file adds up.
 *
 *   earnings      every MONTHLY earning of the person's structure, prorated (proration.js),
 *                 + one-time earnings (bonus, incentive, overtime) + arrears
 *   reimbursements  MONTHLY reimbursements, prorated; paid, not part of gross
 *   deductions    PF (employee), ESI (employee), professional tax, LWF (employee), TDS,
 *                 fixed deductions of the structure, one-time deductions (loan recovery …)
 *   employer      PF (employer: EPS + EPF), ESI (employer), LWF (employer), other employer
 *                 contributions of the structure
 *   net pay       earnings + reimbursements − deductions, to the rupee
 *
 * A structure line of a statutory component (employer PF in "Staff standard") is how the
 * CTC is split; the month's statutory amounts are worked out here from the month's wages,
 * never copied from the structure.
 */
import { money, rupee } from './formula.js';
import { prorate } from './proration.js';
import { pfFor, esiFor, ptFor, lwfFor } from './statutory.js';

export const STATUTORY_KEYS = ['PF_EE', 'PF_ER', 'ESI_EE', 'ESI_ER', 'PT', 'LWF_EE', 'LWF_ER', 'TDS', 'ARREARS'];

/**
 * @param input {
 *   month, days: proration.monthDays(...) with segments[].amounts = { CODE: monthly },
 *   components: Map<CODE, { id, code, name, kind, frequency, inPfWage, inEsiWage, prorateOnLop, statutoryKey, sortOrder, status }>,
 *   oneTime: [{ code, amount, note }],
 *   arrears: [{ forMonth, amount, pfBase, pfWage, esiWage }],   pfWage / esiWage of the difference: kept on the line,
 *                                                               so a later revision of the same month counts them as paid
 *   tds: number, pfMode, esiCovered, noEps (a member past 58), settings: { PF, ESI, PT, LWF }
 * }
 * A statutory amount whose component is INACTIVE (or missing) is not deducted: the warnings say so,
 * and pf / esi / tds report only what was written as a line (the run's totals add those).
 * @returns {{ lines, gross, reimbursements, deductions, employer, netPay, cost, pfWage, esiWage, pf, esi, tds, warnings }}
 */
export function computePerson(input) {
  const { days, components } = input;
  const lines = [];
  const warnings = [];
  const comp = (code) => components.get(code) ?? null;
  const byKey = (key) => [...components.values()].find((c) => c.statutoryKey === key && c.status !== 'INACTIVE') ?? null;
  const push = (c, amount, basis, extra = {}) => {
    if (!c) return false;
    lines.push({
      componentId: c.id, code: c.code, name: c.name, kind: c.kind, statutoryKey: c.statutoryKey ?? null, sortOrder: c.sortOrder ?? 0,
      amount: money(amount), fullAmount: extra.fullAmount ?? null, basis, forMonth: extra.forMonth ?? null, source: extra.source ?? 'STRUCTURE',
      inPfWage: Boolean(c.inPfWage), inEsiWage: Boolean(c.inEsiWage), pfWage: extra.pfWage ?? null, esiWage: extra.esiWage ?? null,
    });
    return true;
  };
  /** A statutory line: written when its component is active; otherwise said, and not counted. */
  const pushKey = (key, amount, basis, extra = {}) => {
    if (push(byKey(key), amount, basis, extra)) return true;
    warnings.push(`${KEY_WORDS[key] ?? key} of ${money(amount).toLocaleString('en-IN')} is due, but its component is inactive or missing: it is not in this month’s pay.`);
    return false;
  };

  // ── the structure, prorated ──────────────────────────────────────────────
  const codes = new Set();
  for (const g of days.segments) for (const code of Object.keys(g.amounts ?? {})) codes.add(code);
  for (const code of codes) {
    const c = comp(code);
    if (!c || c.status === 'INACTIVE') continue;
    if (c.statutoryKey) continue;                   // worked out below from the month's wages
    if ((c.frequency ?? 'MONTHLY') !== 'MONTHLY') continue; // paid as a one-time item when due
    const segs = days.segments.map((g) => ({ days: g.days, payable: g.payable, monthly: g.amounts?.[code] ?? 0 }));
    if (segs.every((s) => !s.monthly)) continue;
    const p = prorate(segs, days.daysInMonth, Boolean(c.prorateOnLop));
    const full = segs[segs.length - 1].monthly;
    push(c, rupee(p.amount), p.basis, { fullAmount: full });
  }

  // ── one-time items and arrears ───────────────────────────────────────────
  for (const item of input.oneTime ?? []) {
    const c = comp(item.code);
    if (!c) { warnings.push(`A one-time item uses ${item.code}, which is not a component any more.`); continue; }
    // P3b: overtime and penalties (ATTENDANCE), the full and final (SETTLEMENT), claims (CLAIM) come in the same way.
    push(c, money(item.amount), item.basis ?? (item.note ? `one-time: ${item.note}` : 'one-time item'), { source: item.source ?? 'ONE_TIME' });
  }
  const arrearsComp = byKey('ARREARS');
  let arrearsPfBase = 0;
  let arrearsEsiWage = 0;
  for (const a of input.arrears ?? []) {
    if (!a.amount) continue;
    if (!arrearsComp) { warnings.push('Arrears are due but the company has no Arrears component.'); break; }
    push(arrearsComp, money(a.amount), a.basis ?? `revision for ${a.forMonth}`, { forMonth: a.forMonth, source: 'ARREARS', pfWage: money(Number(a.pfWage) || 0), esiWage: money(Number(a.esiWage) || 0) });
    arrearsPfBase += Number(a.pfBase) || 0;
    arrearsEsiWage += Number(a.esiWage) || 0;
  }

  // ── the wages ────────────────────────────────────────────────────────────
  const earnings = lines.filter((l) => l.kind === 'EARNING');
  const gross = money(earnings.reduce((s, l) => s + l.amount, 0));
  const pfWage = money(earnings.filter((l) => l.inPfWage && l.source !== 'ARREARS').reduce((s, l) => s + l.amount, 0));
  const esiWage = money(earnings.filter((l) => l.inEsiWage && l.source !== 'ARREARS').reduce((s, l) => s + l.amount, 0) + arrearsEsiWage);

  // ── statutory ────────────────────────────────────────────────────────────
  const S = input.settings ?? {};
  const pfAll = pfFor({ pfWage, mode: input.pfMode ?? 'CEILING', extraBase: arrearsPfBase, settings: S.PF, noEps: Boolean(input.noEps) });
  const pfEe = pfAll.employee ? pushKey('PF_EE', pfAll.employee, pfAll.basis, { source: 'STATUTORY' }) : false;
  const pfEr = pfAll.employer ? pushKey('PF_ER', pfAll.employer, `EPS ${pfAll.eps.toLocaleString('en-IN')} + EPF ${pfAll.epf.toLocaleString('en-IN')}${input.noEps ? ' (past 58: no EPS)' : ''}`, { source: 'STATUTORY' }) : false;
  // What the run's totals (and the PF and ESI returns) add up: only what was written as a line.
  const pf = { ...pfAll, employee: pfEe ? pfAll.employee : 0, ...(pfEr ? {} : { employer: 0, eps: 0, epf: 0, edli: 0, admin: 0 }) };
  const esiAll = esiFor({ esiWage, covered: input.esiCovered, payableDays: days.payableDays, settings: S.ESI });
  const esiEe = esiAll.employee ? pushKey('ESI_EE', esiAll.employee, esiAll.basis, { source: 'STATUTORY' }) : false;
  const esiEr = esiAll.employer ? pushKey('ESI_ER', esiAll.employer, `${S.ESI?.employerRate}% of ${esiAll.wage.toLocaleString('en-IN')}`, { source: 'STATUTORY' }) : false;
  const esi = { ...esiAll, employee: esiEe ? esiAll.employee : 0, employer: esiEr ? esiAll.employer : 0 };
  // Professional tax is on the month's salary: the full and final's own amounts (gratuity, leave encashment, notice
  // pay …) are left out of its slab, and a person paid only a settlement in a month after leaving pays none, nor LWF.
  const settlementGross = money(earnings.filter((l) => l.source === 'SETTLEMENT').reduce((s, l) => s + l.amount, 0));
  const pt = input.settlementOnly ? { amount: 0 } : ptFor({ gross: money(gross - settlementGross), settings: S.PT, month: input.month });
  if (pt.amount) pushKey('PT', pt.amount, pt.basis, { source: 'STATUTORY' });
  const lwf = input.settlementOnly ? { employee: 0, employer: 0 } : lwfFor({ month: input.month, paid: gross > 0, settings: S.LWF });
  if (lwf.employee) pushKey('LWF_EE', lwf.employee, lwf.basis, { source: 'STATUTORY' });
  if (lwf.employer) pushKey('LWF_ER', lwf.employer, lwf.basis, { source: 'STATUTORY' });
  // TDS: services/payroll/tds.js (HR's override, a TDS item, or the tax engine).
  const tdsDue = money(input.tds ?? 0);
  const tds = tdsDue > 0 && pushKey('TDS', tdsDue, input.tdsBasis ?? 'entered by HR for this month', { source: 'TDS' }) ? tdsDue : 0;

  lines.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.sortOrder - b.sortOrder || a.code.localeCompare(b.code) || String(a.forMonth ?? '').localeCompare(String(b.forMonth ?? '')));
  const sum = (kind) => money(lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.amount, 0));
  const reimbursements = sum('REIMBURSEMENT');
  const deductions = sum('DEDUCTION');
  const employer = sum('EMPLOYER_CONTRIBUTION');
  const netPay = rupee(gross + reimbursements - deductions);
  if (netPay < 0) warnings.push(`Deductions are more than the pay: net pay would be ${netPay.toLocaleString('en-IN')}.`);
  return { lines, gross, reimbursements, deductions, employer, netPay, cost: money(gross + reimbursements + employer), pfWage, esiWage, pf, esi, tds, warnings };
}

const KEY_WORDS = { PF_EE: 'PF (employee)', PF_ER: 'PF (employer)', ESI_EE: 'ESI (employee)', ESI_ER: 'ESI (employer)', PT: 'Professional tax', LWF_EE: 'LWF (employee)', LWF_ER: 'LWF (employer)', TDS: 'TDS' };
const KIND_ORDER = { EARNING: 1, REIMBURSEMENT: 2, DEDUCTION: 3, EMPLOYER_CONTRIBUTION: 4 };
const kindOrder = (k) => KIND_ORDER[k] ?? 9;

/**
 * The earnings of a month from a salary, for arrears: what the same days would pay. Pure.
 * paidCodes: the components that month paid — counted even when made INACTIVE since (the month
 * paid them, so leaving them out would show a fall in pay that never happened).
 */
export function earningsFor({ days, components, paidCodes = null }) {
  let total = 0;
  let pfWage = 0;
  let esiWage = 0;
  for (const c of components.values()) {
    if (c.kind !== 'EARNING' || c.statutoryKey || (c.frequency ?? 'MONTHLY') !== 'MONTHLY') continue;
    if (c.status === 'INACTIVE' && !paidCodes?.has(c.code)) continue;
    const segs = days.segments.map((g) => ({ days: g.days, payable: g.payable, monthly: g.amounts?.[c.code] ?? 0 }));
    if (segs.every((s) => !s.monthly)) continue;
    const a = rupee(prorate(segs, days.daysInMonth, Boolean(c.prorateOnLop)).amount);
    total += a;
    if (c.inPfWage) pfWage += a;
    if (c.inEsiWage) esiWage += a;
  }
  return { total: money(total), pfWage: money(pfWage), esiWage: money(esiWage) };
}

export default { computePerson, earningsFor, STATUTORY_KEYS };
