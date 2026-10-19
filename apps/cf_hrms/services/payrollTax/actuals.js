/**
 * actuals.js — a person's tax year AS PAID: every locked run of the year, the claims as they stand
 * (VERIFIED only once the proof window has closed), the tax in the chosen regime and the other one.
 * What Form 16 / 130 Part B and the quarterly return's Annexure II print. Nothing is projected:
 * a year whose March run is not locked is PROVISIONAL, and says so.
 */
import { computeTax } from '../tax/index.js';
import { n, money, today, yearMonths, quarterOf, panStatus } from './common.js';
import { loadTaxWorld } from './runTax.js';
import { claimsOf } from './declarations.js';
import { metroOf } from './profiles.js';

const HRA_SALARY_CODES = ['BASIC', 'DA'];

/** The year of these people as paid. Map<employeeId, actual | null>. */
export async function yearActuals(db, companyId, year, employeeIds) {
  const months = yearMonths(year);
  const world = await loadTaxWorld(db, companyId, months[11], employeeIds, { paidBefore: '9999-12' });
  const out = new Map();
  if (!world.rules) { for (const id of employeeIds) out.set(id, null); return { world, actuals: out }; }
  const closed = today() > world.settings.proofTo;
  for (const id of employeeIds) out.set(id, personActual(world, id, { closed }));
  return { world, actuals: out };
}

export function personActual(world, employeeId, { closed }) {
  const paid = [...(world.paid.get(employeeId)?.values() ?? [])].sort((a, b) => a.month.localeCompare(b.month));
  const claims = claimsOf(world.lines.get(employeeId) ?? [], { closed, year: world.year });
  if (!paid.length && !claims.previousEmployer) return null;
  const person = world.people.get(employeeId) ?? {};
  const profile = world.profiles.get(employeeId);
  const regime = profile?.regime ?? 'NEW';
  const byCode = new Map();
  let pt = 0;
  let pfEe = 0;
  let npsEr = 0;
  let tds = 0;
  const tdsByQuarter = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
  const tdsByMonth = [];
  for (const m of paid) {
    for (const c of m.components) {
      const cur = byCode.get(c.code);
      if (cur) cur.amount += n(c.amount); else byCode.set(c.code, { ...c, amount: n(c.amount) });
    }
    pt += n(m.pt); pfEe += n(m.pfEe); npsEr += n(m.npsEr); tds += n(m.tds);
    tdsByQuarter[quarterOf(m.month)] += n(m.tds);
    tdsByMonth.push({ month: m.month, gross: money(m.components.reduce((a, c) => a + n(c.amount), 0)), tds: money(m.tds) });
  }
  const components = [...byCode.values()];
  const deductions = { ...claims.deductions };
  if (pfEe) deductions['80C'] = n(deductions['80C']) + money(pfEe);
  if (npsEr) deductions['80CCD2'] = n(deductions['80CCD2']) + money(npsEr); // the employer's NPS (runTax.js)
  const exemptions = { ...claims.exemptions };
  const metros = world.rules.OLD.get('exempt_hra').metros;
  const where = metroOf(profile ?? {}, world.cities.get(employeeId), world.posting, metros);
  if (exemptions.hra) {
    const rent = new Map((exemptions.hra.rentPaid ?? []).map((r) => [r.month, r.amount]));
    exemptions.hra = {
      ...where.engine,
      months: paid.map((m) => ({
        month: m.month, rentPaid: n(rent.get(m.month)),
        basic: m.components.filter((c) => HRA_SALARY_CODES.includes(String(c.code).toUpperCase())).reduce((a, c) => a + n(c.amount), 0),
        hraReceived: m.components.filter((c) => String(c.exemptRule ?? '').toUpperCase() === 'HRA').reduce((a, c) => a + n(c.amount), 0),
      })),
    };
  }
  const perquisites = components.filter((c) => String(c.exemptRule ?? '').toUpperCase() === 'PERQUISITE').map((c) => ({ name: c.name, value: money(c.amount) }));
  const salaryComponents = components.filter((c) => String(c.exemptRule ?? '').toUpperCase() !== 'PERQUISITE');
  const input = {
    year: world.year, dateOfBirth: person.dateOfBirth ?? undefined, salary: { components: salaryComponents }, perquisites,
    exemptions, deductions, professionalTax: money(pt), otherIncome: claims.otherIncome,
    previousEmployer: claims.previousEmployer ? { taxableSalary: money(claims.previousEmployer.taxableSalary), tds: money(claims.previousEmployer.tds), pt: money(claims.previousEmployer.pt) } : undefined,
  };
  const comp = { OLD: computeTax({ ...input, regime: 'OLD' }, world.rules.OLD), NEW: computeTax({ ...input, regime: 'NEW' }, world.rules.NEW) };
  const months = yearMonths(world.year);
  const exit = person.exit && person.exit <= `${months[11]}-31`;
  return {
    employeeId, year: world.year, regime, other: regime === 'NEW' ? 'OLD' : 'NEW', computation: comp[regime], otherComputation: comp[regime === 'NEW' ? 'OLD' : 'NEW'],
    components: salaryComponents.map((c) => ({ code: c.code, name: c.name, amount: money(c.amount), taxable: c.taxable, exemptRule: c.exemptRule })),
    perquisites, perquisiteTotal: money(perquisites.reduce((a, p) => a + p.value, 0)),
    pt: money(pt), pfEe: money(pfEe), tds: money(tds), tdsByQuarter: Object.fromEntries(Object.entries(tdsByQuarter).map(([k, v]) => [k, money(v)])), tdsByMonth,
    previousEmployer: claims.previousEmployer, claims: claims.used, proofsClosed: closed,
    period: { from: person.joining && person.joining > `${months[0]}-01` ? person.joining : `${months[0]}-01`, to: exit ? person.exit : `${months[11]}-31` },
    provisional: !paid.some((m) => m.month === months[11]) && !(exit && paid.some((m) => m.month === person.exit.slice(0, 7))),
    monthsPaid: paid.length, panStatus: panStatus(world.pans.get(employeeId)), pan: world.pans.get(employeeId) ?? null,
    city: where.city, metro: where.metro,
  };
}
