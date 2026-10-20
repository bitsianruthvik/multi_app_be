/**
 * runTax.js — a person's income tax for the year, as of a month, from the payroll: the input the
 * tax engine's projectYear needs, both regimes worked out, and the month's TDS.
 * (TM/CF_HRMS_HIRING_SPEC.md §25.4 "TDS in the run"; the engine is services/tax/.)
 *
 * THE MONTHS OF THE YEAR, for a run of month M:
 *   PAID       months before M with a LOCKED / RELEASED / PAID run: what the person was paid (the run's
 *              earning lines, PT, employee PF) and the TDS deducted;
 *   ESTIMATED  months before M, employed, when the company had no locked run (payroll started here
 *              mid-year): the salary in force, no TDS — said as a warning;
 *   THIS       month M: the run's own lines (one-time items and arrears included), or, on a tax sheet
 *              with no run for M, the salary;
 *   TO COME    the months after M to March (or to the exit month): the salary in force each month.
 * Months before the joining month are not the person's. The previous employer's salary, PT and TDS
 * come from their declaration line (Form 12B / 122).
 *
 * CLAIMS: the declaration lines (declarations.js claimsOf) — declared while the proof window is open
 * at the end of M, VERIFIED only once it has closed. Employee PF of every month counts under 80C
 * (old regime). PT of every month counts (old regime; the engine caps it).
 *
 * THE TDS: projectYear in the person's regime (default NEW): (year's tax − TDS so far − previous
 * employer's TDS) ÷ months left. No valid PAN (rule tds_no_pan: s.206AA / s.397(2)): the year's tax
 * becomes the higher of the tax and 20% of the taxable income — nothing when the tax is nil.
 * Both regimes are always worked out, so the screens show the other one and the saving.
 *
 * Reads the database only in loadTaxWorld / salary months; personTax is otherwise arithmetic.
 */
import { projectYear, inr } from '../tax/index.js';
import { yearOf, yearMonths, loadRules, pansOf, panStatus, json, n, money, dateText } from './common.js';
import { yearSettings, proofsStatusFor } from './settings.js';
import { profilesOf, citiesOf, placeOfPosting, metroOf } from './profiles.js';
import { lineRows, claimsOf } from './declarations.js';
import { loadComponents, loadStructures, shapeSalary, SALARY_COLUMNS, overrideMap, statutoryOn, companySettings } from '../payroll/common.js';
import { breakdown } from '../payroll/structure.js';
import { pfFor, ptFor } from '../payroll/statutory.js';
import { monthBounds } from '../payroll/proration.js';
import { loadExtras, personExtras } from './extras.js';

const FROZEN = ['LOCKED', 'RELEASED', 'PAID'];

/** Everything the TDS of `month` reads, for these people, in a few queries. */
export async function loadTaxWorld(db, companyId, month, employeeIds, { runId = null, paidBefore = null, extras = true } = {}) {
  const year = yearOf(month);
  const months = yearMonths(year);
  const ids = [...new Set(employeeIds)];
  const { rules, reason } = await loadRules(db, year);
  const settings = await yearSettings(db, companyId, year);
  const monthEnd = monthBounds(month).to;
  const ph = ids.map(() => '?').join(',') || 'NULL';
  const [emps] = ids.length ? await db.query(`SELECT id, date_of_birth, date_of_joining, exit_date FROM hrms_employees WHERE company_id = ? AND id IN (${ph})`, [companyId, ...ids]) : [[]];
  const [profiles, pans, cities, posting, comps, structs, paySettings] = await Promise.all([
    profilesOf(db, companyId, ids, year), pansOf(db, companyId, ids), citiesOf(db, companyId, ids), placeOfPosting(db, companyId),
    loadComponents(db, companyId), loadStructures(db, companyId), companySettings(db, companyId)]);
  const lines = new Map(ids.map((id) => [id, []]));
  for (const r of await lineRows(db, companyId, ids, year)) lines.get(r.employee_id)?.push(r);

  // Locked runs of the year before this month: the company's months, the people's pay and TDS.
  const [runs] = await db.query(`SELECT id, period_month, status FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND period_month >= ? AND period_month < ?`, [companyId, months[0], paidBefore ?? month]);
  const lockedRuns = runs.filter((r) => FROZEN.includes(r.status));
  const lockedMonths = new Set(lockedRuns.map((r) => r.period_month));
  const paid = new Map(ids.map((id) => [id, new Map()]));
  if (lockedRuns.length && ids.length) {
    const runIds = lockedRuns.map((r) => r.id);
    const monthOfRun = new Map(lockedRuns.map((r) => [r.id, r.period_month]));
    const [pp] = await db.query(`SELECT id, run_id, employee_id, tds_amount FROM hrms_pay_run_people WHERE company_id = ? AND deleted_at IS NULL AND included = 1 AND run_id IN (${runIds.map(() => '?').join(',')}) AND employee_id IN (${ph})`,
      [companyId, ...runIds, ...ids]);
    const [pl] = await db.query(`SELECT run_person_id, component_id, kind, amount, source FROM hrms_pay_run_lines WHERE company_id = ? AND deleted_at IS NULL AND run_id IN (${runIds.map(() => '?').join(',')}) AND employee_id IN (${ph})`,
      [companyId, ...runIds, ...ids]);
    const byPerson = new Map();
    for (const l of pl) { if (!byPerson.has(l.run_person_id)) byPerson.set(l.run_person_id, []); byPerson.get(l.run_person_id).push(l); }
    for (const p of pp) {
      const m = monthOfRun.get(p.run_id);
      paid.get(p.employee_id)?.set(m, { month: m, tds: n(p.tds_amount), ...monthFromLines((byPerson.get(p.id) ?? []).map((l) => ({ ...l, comp: comps.byId.get(l.component_id) }))) });
    }
  }
  // The salaries, for estimated and coming months.
  const [salRows] = ids.length ? await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE company_id = ? AND deleted_at IS NULL AND employee_id IN (${ph}) ORDER BY effective_from, id`, [companyId, ...ids]) : [[]];
  const salaries = new Map(ids.map((id) => [id, []]));
  for (const r of salRows) salaries.get(r.employee_id)?.push(shapeSalary(r));
  const [ovr] = runId ? await db.query('SELECT employee_id, amount, reason FROM hrms_tax_tds_overrides WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL', [companyId, runId]) : [[]];

  const statCache = new Map();
  const statFor = async (on, state) => {
    const k = `${on}|${state}`;
    if (!statCache.has(k)) statCache.set(k, await statutoryOn(db, companyId, on, state));
    return statCache.get(k);
  };
  // P3b: the perquisites register, Form 10E relief, the full and final's exemption facts, LTA claims,
  // the retirement-contribution facts (extras.js). Off for the register's own salary read (no loop).
  const ex = extras && rules ? await loadExtras(db, companyId, year, ids, rules) : null;
  return {
    extras: ex,
    companyId, month, monthEnd, year, months, rules, rulesMissing: reason, settings, proofsStatus: proofsStatusFor(settings, monthEnd),
    people: new Map(emps.map((e) => [e.id, { dateOfBirth: dateText(e.date_of_birth), joining: dateText(e.date_of_joining), exit: dateText(e.exit_date) }])),
    profiles, pans, cities, posting, comps, structs, paySettings, lines, paid, lockedMonths, salaries,
    overrides: new Map(ovr.map((o) => [o.employee_id, { amount: money(o.amount), reason: o.reason }])),
    statFor, bdCache: new Map(),
  };
}

/** A month's taxable earnings, PT and employee PF from run lines ({ kind, amount, comp }). */
export function monthFromLines(lines) {
  const components = [];
  let pt = 0;
  let pfEe = 0;
  let npsEr = 0;
  let pfEr = 0;
  let superannuation = 0;
  for (const l of lines) {
    const k = l.comp ?? {};
    const key = k.statutoryKey ?? l.statutoryKey ?? null;
    if (key === 'PT') pt += n(l.amount);
    if (key === 'PF_EE') pfEe += n(l.amount);
    if (key === 'PF_ER') pfEr += n(l.amount);
    const kind = l.kind ?? k.kind;
    // An employer contribution to an approved superannuation fund (exemption rule SUPERANNUATION): not salary
    // within the limit, but counted toward the year's limit on retirement contributions (s.17(2)(vii) / 17(1)(h)).
    if (kind === 'EMPLOYER_CONTRIBUTION' && String(k.exemptionRule ?? '').toUpperCase() === SUPERANNUATION_RULE) { superannuation += n(l.amount); continue; }
    // A claim paid as a reimbursement (P3b): income when its component is taxable (REIMB_TAX), or under the
    // leave-travel rule (REIMB_LTA, exemption rule LTA: exempt in the old regime within the block's journeys).
    if (kind === 'REIMBURSEMENT' && l.source === 'CLAIM' && (k.taxable ?? 'NO') !== 'NO') {
      components.push({ code: k.code ?? l.code, name: k.name ?? l.name, amount: n(l.amount), taxable: k.taxable, exemptRule: k.exemptionRule ?? null });
      continue;
    }
    // The employer's NPS contribution (exemption rule NPS_80CCD2): salary (s.17(1)(viii) / its 2025-Act
    // successor), then deducted under 80CCD(2) / s.124(1)–(2) up to the year's limit — see personTax.
    if (kind === 'EMPLOYER_CONTRIBUTION' && isNpsEr(k)) {
      npsEr += n(l.amount);
      components.push({ code: k.code ?? l.code, name: k.name ?? l.name, amount: n(l.amount), taxable: 'YES', exemptRule: NPS_RULE });
      continue;
    }
    if (kind !== 'EARNING') continue;
    components.push({ code: k.code ?? l.code, name: k.name ?? l.name, amount: n(l.amount), taxable: k.taxable ?? 'YES', exemptRule: k.exemptionRule ?? null });
  }
  return { components, pt: money(pt), pfEe: money(pfEe), npsEr: money(npsEr), pfEr: money(pfEr), superannuation: money(superannuation) };
}
export const SUPERANNUATION_RULE = 'SUPERANNUATION';

/** The exemption rule that marks the employer's NPS contribution (the ready-made component NPS_ER). */
export const NPS_RULE = 'NPS_80CCD2';
export const isNpsEr = (k) => String(k?.exemptionRule ?? k?.exemptRule ?? '').toUpperCase() === NPS_RULE;

/** The pay of a month from the salary in force at its end (full month; a joining month prorated by days). */
export async function salaryMonth(world, employeeId, month) {
  const b = monthBounds(month);
  const person = world.people.get(employeeId) ?? {};
  if (person.joining && person.joining > b.to) return null;
  if (person.exit && person.exit < b.from) return null;
  const sal = (world.salaries.get(employeeId) ?? []).filter((s) => s.effectiveFrom <= b.to && (!s.effectiveTo || s.effectiveTo >= b.from)).pop();
  if (!sal) return null;
  const s = world.structs.get(sal.structureId);
  if (!s) return null;
  const state = sal.stateCode ?? world.paySettings.stateCode;
  const st = await world.statFor(b.from, state);
  const key = `${sal.id}|${month}`;
  if (!world.bdCache.has(key)) {
    world.bdCache.set(key, breakdown(s.lines, world.comps.byId, sal.annualCtc, overrideMap(sal), { pfMode: sal.pfMode, vars: { PF_CEILING: st.PF?.wageCeiling ?? null, ESI_CEILING: st.ESI?.wageCeiling ?? null } }));
  }
  const bd = world.bdCache.get(key);
  const from = person.joining && person.joining > b.from ? person.joining : b.from;
  const to = person.exit && person.exit < b.to ? person.exit : b.to;
  const share = (Number(to.slice(8, 10)) - Number(from.slice(8, 10)) + 1) / b.days;
  const components = [];
  let pfWage = 0;
  let npsEr = 0;
  let superannuation = 0;
  for (const l of bd.lines ?? []) {
    const k = world.comps.byCode.get(l.code);
    if (!k || k.statutoryKey || (k.frequency ?? 'MONTHLY') !== 'MONTHLY') continue;
    if (k.kind === 'EMPLOYER_CONTRIBUTION' && String(k.exemptionRule ?? '').toUpperCase() === SUPERANNUATION_RULE) { superannuation += Math.round(n(l.monthly) * share); continue; }
    if (k.kind === 'EMPLOYER_CONTRIBUTION' && isNpsEr(k)) {
      const amount = Math.round(n(l.monthly) * share);
      components.push({ code: k.code, name: k.name, amount, taxable: 'YES', exemptRule: NPS_RULE });
      npsEr += amount;
      continue;
    }
    if (k.kind !== 'EARNING') continue;
    const amount = Math.round(n(l.monthly) * share);
    components.push({ code: k.code, name: k.name, amount, taxable: k.taxable, exemptRule: k.exemptionRule });
    if (k.inPfWage) pfWage += amount;
  }
  const gross = components.filter((x) => x.exemptRule !== NPS_RULE).reduce((a, x) => a + x.amount, 0);
  const pf = pfFor({ pfWage, mode: sal.pfMode ?? 'CEILING', settings: st.PF });
  const pt = st.PT ? ptFor({ gross, settings: st.PT, month }).amount : 0;
  return { components, pt: money(pt), pfEe: money(pf.employee ?? 0), npsEr: money(npsEr), pfEr: money(pf.employer ?? 0), superannuation: money(superannuation) };
}

/** The higher rate without a PAN: the year's tax at least `rate`% of the taxable income (nil stays nil). */
export function noPanProjection(proj, rule) {
  const income = proj.computation.taxableIncome;
  if (proj.projectedTax <= 0 || !rule) return { applied: false, yearTax: proj.projectedTax, thisMonthTds: proj.thisMonthTds };
  const atRate = Math.round(income * rule.rate / 100);
  const yearTax = Math.max(proj.projectedTax, atRate);
  const balance = yearTax - proj.tdsSoFar - proj.previousEmployerTds;
  const thisMonthTds = balance > 0 ? Math.round(balance / proj.monthsLeft) : 0;
  const avg = income ? (proj.projectedTax / income) * 100 : 0;
  return {
    applied: true, rate: rule.rate, section: rule.section, averageRate: Math.round(avg * 100) / 100, yearTax, balance, thisMonthTds,
    line: `No valid PAN (${rule.section}): the year's tax at the higher of the average rate ${avg.toFixed(2)}% (${inr(proj.projectedTax)}) and ${rule.rate}% of ${inr(income)} (${inr(atRate)}) = ${inr(yearTax)}; this month ${inr(Math.max(0, balance))} ÷ ${proj.monthsLeft}`,
  };
}

/**
 * One person's year as of the world's month.
 * @param current  { components, pt, pfEe } of the month (the run's lines), or null: the salary
 * @returns null when the person has no pay this year at all
 */
export async function personTax(world, employeeId, { current = null } = {}) {
  const warnings = [];
  const person = world.people.get(employeeId) ?? {};
  const profile = world.profiles.get(employeeId);
  const regime = profile?.regime ?? 'NEW';
  if (!world.rules) {
    return { available: false, year: world.year, regime, tds: 0, warnings: [`No tax rules for ${world.year}: ${world.rulesMissing} Enter the TDS by hand.`], reason: world.rulesMissing };
  }
  const joinMonth = person.joining ? person.joining.slice(0, 7) : world.months[0];
  const exitMonth = person.exit ? person.exit.slice(0, 7) : null;
  const paidMonths = [];
  const timeline = [];
  let estimated = 0;
  let pt = 0;
  let pfEe = 0;
  let npsEr = 0;
  let pfEr = 0;
  let superannuation = 0;
  const push = (m, data, kind, tds) => {
    if (!data) return;
    pt += n(data.pt); pfEe += n(data.pfEe); npsEr += n(data.npsEr); pfEr += n(data.pfEr); superannuation += n(data.superannuation);
    timeline.push({ month: m, kind, taxable: money(data.components.filter((x) => x.taxable !== 'NO').reduce((a, x) => a + n(x.amount), 0)), tds: money(tds ?? 0) });
  };
  for (const m of world.months) {
    if (m >= world.month) break;
    if (m < joinMonth || (exitMonth && m > exitMonth)) continue;
    const p = world.paid.get(employeeId)?.get(m);
    if (p) { paidMonths.push({ month: m, components: p.components, tdsDeducted: p.tds }); push(m, p, 'PAID', p.tds); continue; }
    if (world.lockedMonths.has(m)) continue; // a locked run without this person: not paid that month
    const est = await salaryMonth(world, employeeId, m);
    if (est) { paidMonths.push({ month: m, components: est.components, tdsDeducted: 0 }); push(m, est, 'ESTIMATED', 0); estimated += 1; }
  }
  if (estimated) warnings.push(`${estimated} earlier month(s) of ${world.year} have no locked payroll here: counted at the salary then, with no TDS recorded.`);
  const remainingMonths = [];
  const thisMonth = current ?? await salaryMonth(world, employeeId, world.month);
  if (thisMonth) { remainingMonths.push({ month: world.month, components: thisMonth.components }); push(world.month, thisMonth, current ? 'THIS' : 'THIS_ESTIMATED', null); }
  for (const m of world.months.filter((x) => x > world.month)) {
    if (exitMonth && m > exitMonth) break;
    const s = await salaryMonth(world, employeeId, m);
    if (!s) continue;
    remainingMonths.push({ month: m, components: s.components });
    push(m, s, 'TO_COME', null);
  }
  if (!remainingMonths.length) return null;

  const claims = claimsOf(world.lines.get(employeeId) ?? [], { closed: world.proofsStatus === 'CLOSED', year: world.year });
  const deductions = { ...claims.deductions };
  if (pfEe) deductions['80C'] = n(deductions['80C']) + money(pfEe);
  // The employer's NPS contribution: counted in salary above, deducted here; the engine caps it at the
  // year's % of Basic + DA by regime (rule ded_80ccd2), in both regimes.
  if (npsEr) deductions['80CCD2'] = n(deductions['80CCD2']) + money(npsEr);
  const metros = world.rules.OLD.get('exempt_hra').metros;
  const m = metroOf(profile ?? {}, world.cities.get(employeeId), world.posting, metros);
  const exemptions = { ...claims.exemptions };
  if (exemptions.hra) exemptions.hra = { ...exemptions.hra, ...m.engine };
  if (!person.dateOfBirth) warnings.push('No date of birth on file: the below-60 slabs are used.');

  // P3b: perquisites (the register, retirement contributions above the limit), the full and final's
  // exemption facts, approved LTA claims, Form 10E / 39 relief (extras.js).
  const allComponents = [...paidMonths, ...remainingMonths].flatMap((x) => x.components);
  const px = personExtras(world, employeeId, { contributions: { pf: pfEr, nps: npsEr, superannuation }, components: allComponents, exemptions, regime });
  warnings.push(...px.warnings);
  const input = {
    year: world.year, dateOfBirth: person.dateOfBirth ?? undefined, perquisites: px.perquisites,
    paidMonths, remainingMonths, oneTime: [],
    declarations: { deductions, exemptions }, proofs: { deductions, exemptions }, proofsStatus: world.proofsStatus,
    professionalTax: money(pt), otherIncome: claims.otherIncome,
    previousEmployer: claims.previousEmployer ? { taxableSalary: money(claims.previousEmployer.taxableSalary), tds: money(claims.previousEmployer.tds), pt: money(claims.previousEmployer.pt) } : undefined,
  };
  // The relief of a READY Form 10E / 39 worksheet is given in the person's own regime (the worksheet was worked in it).
  const proj = {
    OLD: projectYear({ ...input, regime: 'OLD', relief: regime === 'OLD' ? px.relief : null }, world.rules.OLD),
    NEW: projectYear({ ...input, regime: 'NEW', relief: regime === 'NEW' ? px.relief : null }, world.rules.NEW),
  };
  const pan = world.pans.get(employeeId);
  const panOk = panStatus(pan) === 'VALID';
  const noPan = {
    OLD: panOk ? { applied: false } : noPanProjection(proj.OLD, world.rules.OLD.has('tds_no_pan') ? world.rules.OLD.get('tds_no_pan') : null),
    NEW: panOk ? { applied: false } : noPanProjection(proj.NEW, world.rules.NEW.has('tds_no_pan') ? world.rules.NEW.get('tds_no_pan') : null),
  };
  const chosen = proj[regime];
  const other = regime === 'NEW' ? 'OLD' : 'NEW';
  const tds = noPan[regime].applied ? noPan[regime].thisMonthTds : chosen.thisMonthTds;
  if (noPan[regime].applied) warnings.push(`No valid PAN: TDS at the higher rate (${noPan[regime].section}).`);
  const saving = Math.abs(proj.OLD.projectedTax - proj.NEW.projectedTax);
  const cheaper = proj.OLD.projectedTax < proj.NEW.projectedTax ? 'OLD' : 'NEW';
  return {
    available: true, year: world.year, month: world.month, regime, tds,
    projectedTax: chosen.projectedTax, yearTax: noPan[regime].applied ? noPan[regime].yearTax : chosen.projectedTax,
    tdsSoFar: chosen.tdsSoFar, previousEmployerTds: chosen.previousEmployerTds, monthsLeft: chosen.monthsLeft, excess: chosen.excess,
    other: { regime: other, projectedTax: proj[other].projectedTax, tds: noPan[other].applied ? noPan[other].thisMonthTds : proj[other].thisMonthTds },
    cheaper, saving, proofsStatus: world.proofsStatus, panStatus: panStatus(pan), noPan: noPan[regime],
    city: m.city, metro: m.metro, metroFrom: m.metroFrom, timeline, claims: claims.used, pfIn80C: money(pfEe), professionalTax: money(pt),
    previousEmployer: claims.previousEmployer, projections: proj, noPanBoth: noPan, warnings: [...warnings, ...chosen.computation.warnings],
    perquisites: px.perquisites, retirement: px.retirement, relief: px.relief,
  };
}

/** What a run keeps of it (hrms_pay_run_people.tax_json). */
export const runSnapshot = (t, source, override = null) => (t?.available ? {
  year: t.year, month: t.month, regime: t.regime, engineTds: t.tds, projectedTax: t.projectedTax, yearTax: t.yearTax, tdsSoFar: t.tdsSoFar,
  previousEmployerTds: t.previousEmployerTds, monthsLeft: t.monthsLeft, other: t.other, cheaper: t.cheaper, saving: t.saving, proofsStatus: t.proofsStatus,
  panStatus: t.panStatus, noPan: t.noPan.applied ? { rate: t.noPan.rate, section: t.noPan.section, yearTax: t.noPan.yearTax } : null,
  lines: t.projections[t.regime].lines, warnings: t.warnings.slice(0, 12), source, override,
} : { year: t?.year ?? null, available: false, warnings: t?.warnings ?? [], source, override });

export { json };
