/**
 * structure.js — from a salary structure and a CTC to the amount of every component.
 * (TM/CF_HRMS_HIRING_SPEC.md §25.2.) Pure: the caller reads the structure, its lines and
 * the company's components and hands them in.
 *
 * A structure line names a component and its formula (formula.js). What a line is part
 * of comes from its component:
 *   EARNING, EMPLOYER_CONTRIBUTION, REIMBURSEMENT  — part of CTC (the balance line takes
 *                                                    what they leave);
 *   DEDUCTION                                      — not part of CTC: taken from the pay.
 * A component paid YEARLY (LTA, bonus) is part of CTC at its monthly twelfth, and is not
 * paid by a monthly run: it is paid as a one-time item when it falls due.
 */
import { evaluateLines, money } from './formula.js';

export const KINDS = ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT'];
export const KIND_WORDS = {
  EARNING: 'Earning', DEDUCTION: 'Deduction', EMPLOYER_CONTRIBUTION: 'Employer contribution', REIMBURSEMENT: 'Reimbursement',
};
export const inCtc = (kind) => kind === 'EARNING' || kind === 'EMPLOYER_CONTRIBUTION' || kind === 'REIMBURSEMENT';

/**
 * @param lines       [{ componentId, formula, sortOrder }]
 * @param components  Map<componentId, { id, code, name, kind, frequency, statutoryKey, … }>
 * @param annualCtc   number
 * @param overrides   { [componentId]: monthly amount }
 * @param vars        { PF_CEILING, ESI_CEILING } of the day (formula.js VARIABLES)
 * @param pfMode      'CEILING' | 'FULL' | 'NONE' — NONE: the employer PF line of the structure is 0
 * @returns {{ ok, problems, warnings, annualCtc, monthlyCtc, lines: [{ componentId, code, name, kind, frequency, formula,
 *             monthly, annual, overridden, inCtc, statutoryKey }], totals: { earnings, employer, reimbursements, deductions, ctcLines } }}
 */
export function breakdown(lines, components, annualCtc, overrides = {}, { pfMode = 'CEILING', vars = {} } = {}) {
  const missing = lines.filter((l) => !components.get(l.componentId));
  const rows = lines
    .filter((l) => components.get(l.componentId))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.componentId - b.componentId)
    .map((l) => ({ ...l, comp: components.get(l.componentId) }));
  const over = {};
  for (const r of rows) {
    const v = overrides?.[r.componentId] ?? overrides?.[String(r.componentId)];
    if (v != null && v !== '') over[r.comp.code] = v;
    // Not a member of PF: no employer PF in the CTC either.
    if (pfMode === 'NONE' && (r.comp.statutoryKey === 'PF_ER' || r.comp.statutoryKey === 'PF_EE')) over[r.comp.code] = 0;
  }
  const ev = evaluateLines(rows.map((r) => ({ code: r.comp.code, name: r.comp.name, formula: r.formula, inCtc: inCtc(r.comp.kind) })), annualCtc, over, vars);
  const problems = [...ev.problems, ...missing.map((l) => `A line uses component #${l.componentId}, which is not in the company’s list any more.`)];
  const out = {
    ok: ev.ok && !missing.length,
    problems,
    warnings: ev.warnings,
    annualCtc: money(annualCtc),
    monthlyCtc: ev.monthlyCtc,
    lines: [],
    totals: { earnings: 0, employer: 0, reimbursements: 0, deductions: 0, ctcLines: 0 },
  };
  if (!ev.ok) return out;
  out.lines = rows.map((r) => {
    const monthly = ev.amounts[r.comp.code] ?? 0;
    return {
      componentId: r.componentId, code: r.comp.code, name: r.comp.name, kind: r.comp.kind, frequency: r.comp.frequency ?? 'MONTHLY',
      formula: r.formula, monthly, annual: money(monthly * 12), overridden: Object.hasOwn(over, r.comp.code), inCtc: inCtc(r.comp.kind),
      statutoryKey: r.comp.statutoryKey ?? null,
    };
  });
  for (const l of out.lines) {
    if (l.kind === 'EARNING') out.totals.earnings += l.monthly;
    else if (l.kind === 'EMPLOYER_CONTRIBUTION') out.totals.employer += l.monthly;
    else if (l.kind === 'REIMBURSEMENT') out.totals.reimbursements += l.monthly;
    else out.totals.deductions += l.monthly;
    if (l.inCtc) out.totals.ctcLines += l.monthly;
  }
  for (const k of Object.keys(out.totals)) out.totals[k] = money(out.totals[k]);
  return out;
}

/** { CODE: monthly } of a breakdown — what proration and the run read. */
export const amountsOf = (b) => Object.fromEntries((b?.lines ?? []).map((l) => [l.code, l.monthly]));

export default { breakdown, amountsOf, KINDS, KIND_WORDS, inCtc };
