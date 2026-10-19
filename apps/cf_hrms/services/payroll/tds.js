/**
 * tds.js — THE MONTH'S INCOME TAX DEDUCTED AT SOURCE. (TM/CF_HRMS_HIRING_SPEC.md §25.4, P2.)
 *
 * In order, the first that applies:
 *   1. HR's override for the person in this run (hrms_tax_tds_overrides: an amount, 0 allowed, and a
 *      reason) — source MANUAL;
 *   2. a TDS one-time item of the run (P1's way, still taken from the one-time items Excel) — MANUAL;
 *   3. the tax engine (services/payrollTax/runTax.js personTax: projectYear in the person's regime,
 *      the higher rate without a PAN) — source ENGINE.
 * The engine's figure is worked out in every case and returned as `tax`, so the run keeps it beside
 * a manual amount (hrms_pay_run_people.tax_json) and the tax sheet shows both.
 *
 * @param ctx { companyId, month, employeeId, world (runTax.loadTaxWorld), current: { components, pt, pfEe } }
 * @param manualItems  this person's TDS one-time items in the run: [{ amount, note }]
 * @returns {{ amount, source: 'MANUAL'|'ENGINE', basis, tax, override }}
 */
import { personTax } from '../payrollTax/runTax.js';
import { inr } from '../tax/index.js';

export async function monthlyTds(ctx, manualItems = []) {
  let tax = null;
  if (ctx.world) {
    try {
      tax = await personTax(ctx.world, ctx.employeeId, { current: ctx.current ?? null });
    } catch (e) {
      tax = { available: false, year: ctx.world.year, warnings: [`The tax engine could not work this out: ${e.message}`] };
    }
  }
  const override = ctx.world?.overrides?.get(ctx.employeeId) ?? null;
  if (override) {
    return { amount: override.amount, source: 'MANUAL', basis: `set by HR: ${override.reason}${tax?.available ? ` (the engine: ${inr(tax.tds)})` : ''}`, tax, override };
  }
  if (manualItems.length) {
    const amount = manualItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const note = manualItems.map((i) => i.note).filter(Boolean).join('; ');
    return { amount: Math.round(amount * 100) / 100, source: 'MANUAL', basis: note ? `entered by HR: ${note}` : 'entered by HR for this month', tax, override: { amount, reason: note || 'a TDS one-time item' } };
  }
  if (tax?.available) {
    const basis = tax.noPan?.applied
      ? `no PAN — the higher rate (${tax.noPan.section}); year's tax ${inr(tax.yearTax)}, ${tax.monthsLeft} month(s) left`
      : `${tax.regime === 'OLD' ? 'old' : 'new'} regime: year's tax ${inr(tax.projectedTax)} − ${inr(tax.tdsSoFar + tax.previousEmployerTds)} deducted, ÷ ${tax.monthsLeft} month(s) left`;
    return { amount: tax.tds, source: 'ENGINE', basis, tax, override: null };
  }
  return { amount: 0, source: 'ENGINE', basis: tax?.warnings?.[0] ?? 'no TDS', tax, override: null };
}

export default { monthlyTds };
