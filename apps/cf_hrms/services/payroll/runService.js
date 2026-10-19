/**
 * runService.js — a month's payroll, from draft to paid. (TM/CF_HRMS_HIRING_SPEC.md §25.2.)
 *
 *   DRAFT ──calculate──▶ CALCULATED ──lock──▶ LOCKED ──release──▶ RELEASED ──paid──▶ PAID
 *                ▲  (calculate again, any number of times)          │
 *                └──────── re-open: the Owner only, with a reason ◀──┘ (from LOCKED, RELEASED or PAID)
 *
 * CALCULATE reads everything afresh — the people employed in the month, their salaries, LOP
 * days from approved unpaid leave, one-time items, TDS, arrears of back-dated revisions, the
 * statutory settings in force on the 1st of the month — and REPLACES the run's people and
 * lines (the old rows soft-deleted). Nothing is calculated on read.
 *
 * LOCK freezes what was reviewed: refused when anything the calculation read has changed
 * since (calculate again first). A LOCKED, RELEASED or PAID run is never written again —
 * not its people, not its lines, not its one-time items — except by the Owner's re-open,
 * which is audited with the reason and withdraws its payslips.
 *
 * RELEASE writes one payslip per person paid, a snapshot of everything it prints (payslip.js
 * draws the PDF from that snapshot only). PAID records that the bank file was paid — and WHAT
 * was paid, per person (hrms_pay_payments; the run is marked ever_paid).
 *
 * MONTHS IN ORDER (so nothing is paid twice). A month is created only after the month before it
 * has a run (when the company has any run before it); a month is calculated or locked only while
 * no earlier month is a draft or calculated ("Lock August 2026 first."). Re-opening a month is
 * refused while a later locked run paid arrears for it (re-open from the latest month backwards).
 * A run that was ever paid, or re-opened, is removed by the Owner only.
 *
 * AFTER A RE-OPEN the bank file pays only the DIFFERENCE per person from what was paid for the
 * month (positive amounts only). A person now due less than was paid gets a RECOVERY: a one-time
 * deduction in the next open run, made by the payroll itself when the month is marked paid
 * again (attachRecoveries; shown on both runs).
 *
 * ARREARS. A salary revision dated back over a month a locked run paid is found by comparing
 * the salary rows covering that month now with the ones the run used (calc_json.salaryIds).
 * The month is recomputed on the same days (the LOP dates the run used) with today's rows, and
 * the difference from what was paid (that run's structure earnings + arrears already paid for
 * that month by later runs) is paid in this run, one ARREARS line per month. An ARREARS line
 * keeps the PF and ESI wage of its difference (pf_wage, esi_wage), so a second revision of the
 * same month charges PF and ESI only on what is new.
 */
import { notFound } from '../../lib/errors.js';
import {
  audit, money, json, stamp, refuse, bad, readAmount, text, dateText, today, longDate,
  loadComponents, loadStructures, shapeSalary, SALARY_COLUMNS, overrideMap, companySettings, statutoryOn, identifiersOf, seatsOn, mask,
} from './common.js';
import { breakdown } from './structure.js';
import { monthBounds, monthDays, lopFromRequests, prevMonth, nextMonth, MONTH_RE } from './proration.js';
import { computePerson, earningsFor } from './calc.js';
import { esiPeriodOf, esiCovered } from './statutory.js';
import { monthlyTds } from './tds.js';
import { neftCsv } from './bankFile.js';
import { auditSalaryRead } from './payrollService.js';
import { loadTaxWorld, monthFromLines, runSnapshot } from '../payrollTax/runTax.js';

export const RUN_STATUSES = ['DRAFT', 'CALCULATED', 'LOCKED', 'RELEASED', 'PAID'];
const OPEN = ['DRAFT', 'CALCULATED'];
const FROZEN = ['LOCKED', 'RELEASED', 'PAID'];
const ARREARS_LOOKBACK = 12;

const shapeRun = (r) => ({
  id: r.id, month: r.period_month, label: monthBounds(r.period_month).label, status: r.status, note: r.note ?? null,
  peopleCount: Number(r.people_count) || 0, gross: money(r.gross_total), deductions: money(r.deductions_total), employer: money(r.employer_total), net: money(r.net_total),
  totals: json(r.totals_json, null),
  calculatedAt: stamp(r.calculated_at), lockedAt: stamp(r.locked_at), releasedAt: stamp(r.released_at), paidAt: stamp(r.paid_at), paidNote: r.paid_note ?? null,
  reopenCount: Number(r.reopen_count) || 0, reopenNote: r.reopen_note ?? null, everPaid: Boolean(Number(r.ever_paid)), createdAt: stamp(r.created_at),
});
const labelOf = (m) => monthBounds(m).label;

/** The earliest month before `month` whose run is a draft or calculated, or null. */
async function earlierOpenMonth(db, companyId, month) {
  const [[r]] = await db.query(
    "SELECT period_month FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status IN ('DRAFT','CALCULATED') AND period_month < ? ORDER BY period_month LIMIT 1",
    [companyId, month]);
  return r?.period_month ?? null;
}
/** Months are calculated and locked in order: refused while an earlier month is still open. */
async function assertEarlierLocked(db, companyId, run, doing) {
  const open = await earlierOpenMonth(db, companyId, run.period_month);
  if (open) {
    throw refuse('EARLIER_OPEN', `The ${labelOf(open)} payroll is not locked yet, so ${labelOf(run.period_month)} cannot be ${doing}: months are paid in order. Lock ${labelOf(open)} first.`, { month: open });
  }
}

async function runRow(db, companyId, id, { forUpdate = false } = {}) {
  const [[r]] = await db.query(`SELECT * FROM hrms_pay_runs WHERE company_id = ? AND id = ? AND deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`, [companyId, id]);
  if (!r) throw notFound('That payroll run');
  return r;
}
const statusWords = { DRAFT: 'a draft', CALCULATED: 'calculated', LOCKED: 'locked', RELEASED: 'released', PAID: 'paid' };
const mustBe = (r, allowed, doing) => {
  if (!allowed.includes(r.status)) {
    throw refuse('WRONG_STATUS', `The ${monthBounds(r.period_month).label} payroll is ${statusWords[r.status]}: it cannot be ${doing} now.${FROZEN.includes(r.status) ? ' A locked run is changed only by the Owner re-opening it, with a reason.' : ''}`);
  }
};

/* ══ list, create, delete ════════════════════════════════════════════════ */

export async function listRuns(db, c) {
  const [rows] = await db.query('SELECT * FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL ORDER BY period_month DESC', [c.companyId]);
  const [w] = await db.query(
    `SELECT run_id, SUM(included = 1 AND JSON_LENGTH(COALESCE(warnings_json, JSON_ARRAY())) > 0) AS n FROM hrms_pay_run_people WHERE company_id = ? AND deleted_at IS NULL GROUP BY run_id`, [c.companyId]);
  const warn = new Map(w.map((x) => [x.run_id, Number(x.n) || 0]));
  const latest = rows[0]?.period_month ?? null;
  const t = today().slice(0, 7);
  const suggest = latest ? nextOf(latest) : prevMonth(t);
  return { runs: rows.map((r) => ({ ...shapeRun(r), peopleWithWarnings: warn.get(r.id) ?? 0 })), suggestedMonth: suggest };
}
const nextOf = (m) => { const b = monthBounds(m); const d = new Date(`${b.to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 7); };

export async function createRun(db, c, body = {}, requestId = null) {
  const month = String(body.month ?? '').trim();
  if (!MONTH_RE.test(month)) throw bad('Choose the month, as YYYY-MM.');
  const t = today();
  if (`${month}-01` > t) throw bad(`${monthBounds(month).label} has not started yet.`);
  const [[comp]] = await db.query('SELECT COUNT(*) AS n FROM hrms_pay_components WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  if (!Number(comp.n)) throw refuse('NOT_SET_UP', 'Payroll is not set up for this company yet: add the ready-made components and statutory settings first (Payroll › Components).');
  // Months in order: once the company has a run before this month, the month just before must have one.
  const [[before]] = await db.query('SELECT MAX(period_month) AS m FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND period_month < ?', [c.companyId, month]);
  if (before?.m && before.m !== prevMonth(month)) {
    const missing = nextMonth(before.m);
    throw refuse('MONTH_MISSING', `There is no ${labelOf(missing)} payroll yet: months are paid in order. Create ${labelOf(missing)} first.`, { month: missing });
  }
  const [ins] = await db.query("INSERT INTO hrms_pay_runs (company_id, period_month, status, note, created_by) VALUES (?, ?, 'DRAFT', ?, ?)", [c.companyId, month, text(body.note, 500), c.userId])
    .catch((e) => { if (e.errno === 1062) throw refuse('DUPLICATE', `There is a ${monthBounds(month).label} payroll already. Open it.`); throw e; });
  await audit(db, c, 'hrms_pay_runs', ins.insertId, 'CREATE', null, { month, status: 'DRAFT' }, requestId);
  const created = await runRow(db, c.companyId, ins.insertId);
  await attachRecoveries(db, c, created, requestId);
  return { run: shapeRun(created) };
}

export async function deleteRun(db, c, id, requestId = null) {
  const r = await runRow(db, c.companyId, id, { forUpdate: true });
  mustBe(r, OPEN, 'removed');
  // A month that was paid (or re-opened) is not removed and made again by anybody but the Owner.
  if ((Number(r.reopen_count) > 0 || Number(r.ever_paid)) && !c.owner) {
    throw refuse('OWNER_ONLY', `The ${labelOf(r.period_month)} payroll was ${Number(r.ever_paid) ? 'paid' : 'locked'} once and re-opened: only the Owner can remove it.`);
  }
  // Recoveries this run was to make go back to waiting for the next run.
  await db.query('UPDATE hrms_pay_payments SET recovery_run_id = NULL, recovery_item_id = NULL WHERE company_id = ? AND recovery_run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE hrms_pay_run_lines SET deleted_at = NOW() WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE hrms_pay_run_people SET deleted_at = NOW() WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE hrms_pay_items SET deleted_at = NOW() WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE hrms_tax_tds_overrides SET deleted_at = NOW() WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE hrms_pay_runs SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(db, c, 'hrms_pay_runs', id, 'DELETE', shapeRun(r), null, requestId);
  return { ok: true };
}

/* ══ calculate ═══════════════════════════════════════════════════════════ */

/** LOP days of people from approved requests of unpaid leave types, overlapping [from, to]. */
async function lopOf(db, companyId, employeeIds, from, to) {
  const out = new Map(employeeIds.map((id) => [id, []]));
  if (!employeeIds.length) return out;
  const [rows] = await db.query(
    `SELECT r.employee_id, r.status, r.from_date, r.to_date, r.half_day, r.days_json, t.is_paid
       FROM hrms_leave_requests r JOIN hrms_leave_types t ON t.company_id = r.company_id AND t.id = r.leave_type_id
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.status = 'APPROVED' AND t.is_paid = 0
        AND r.employee_id IN (${employeeIds.map(() => '?').join(',')}) AND r.from_date <= ? AND r.to_date >= ?`,
    [companyId, ...employeeIds, to, from]);
  for (const r of rows) {
    out.get(r.employee_id)?.push(...lopFromRequests([{
      status: r.status, isPaid: Boolean(r.is_paid), daysJson: r.days_json, from: dateText(r.from_date), to: dateText(r.to_date), halfDay: r.half_day,
    }]));
  }
  return out;
}

/** ESI-wage rate (full month) of a salary row: its MONTHLY earnings that count toward the ESI wage. */
function esiRateOf(b, comps) {
  return money((b?.lines ?? []).filter((l) => l.kind === 'EARNING' && l.frequency === 'MONTHLY' && !l.statutoryKey && comps.byCode.get(l.code)?.inEsiWage).reduce((s, l) => s + l.monthly, 0));
}

/**
 * Everything a calculation reads, for a month and a set of people. Exported for the tests
 * and for arrears (which recompute an earlier month with today's salary rows).
 */
async function loadWorld(db, companyId, month) {
  const b = monthBounds(month);
  const [emps] = await db.query(
    `SELECT id, employee_code, full_name, date_of_birth, date_of_joining, exit_date, employment_status FROM hrms_employees
      WHERE company_id = ? AND deleted_at IS NULL AND date_of_joining <= ? AND (exit_date IS NULL OR exit_date >= ?)
      ORDER BY full_name, id`, [companyId, b.to, b.from]);
  const ids = emps.map((e) => e.id);
  const [salRows] = ids.length ? await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE company_id = ? AND deleted_at IS NULL AND employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY effective_from, id`, [companyId, ...ids]) : [[]];
  const salaries = new Map(ids.map((id) => [id, []]));
  for (const r of salRows) salaries.get(r.employee_id)?.push(shapeSalary(r));
  const [comps, structs, settings] = await Promise.all([loadComponents(db, companyId), loadStructures(db, companyId), companySettings(db, companyId)]);
  return { b, emps, ids, salaries, comps, structs, settings };
}

/** The breakdown of a salary row with the variables of a day; cached per (salary, day). */
function breakdownCache(world, statFor) {
  const cache = new Map();
  return async (salary, on) => {
    const key = `${salary.id}|${on.slice(0, 7)}`;
    if (!cache.has(key)) {
      const st = await statFor(on, salary.stateCode ?? world.settings.stateCode);
      const s = world.structs.get(salary.structureId);
      const vars = { PF_CEILING: st.PF?.wageCeiling ?? null, ESI_CEILING: st.ESI?.wageCeiling ?? null };
      cache.set(key, s ? breakdown(s.lines, world.comps.byId, salary.annualCtc, overrideMap(salary), { pfMode: salary.pfMode, vars }) : { ok: false, problems: ['The salary’s structure is not there.'], lines: [] });
    }
    return cache.get(key);
  };
}

const W = (code, textValue) => ({ code, text: textValue });

/** POST /payroll/runs/:id/calculate */
export async function calculateRun(db, c, id, requestId = null) {
  const run = await runRow(db, c.companyId, id, { forUpdate: true });
  mustBe(run, OPEN, 'calculated');
  await assertEarlierLocked(db, c.companyId, run, 'calculated');
  const month = run.period_month;
  await attachRecoveries(db, c, run, requestId);
  const calculatedAt = await watermark(db, c.companyId, run);
  const world = await loadWorld(db, c.companyId, month);
  const { b, emps, ids, salaries, comps } = world;

  const statCache = new Map();
  const statFor = async (on, state) => {
    const k = `${on}|${state}`;
    if (!statCache.has(k)) statCache.set(k, await statutoryOn(db, c.companyId, on, state));
    return statCache.get(k);
  };
  const bd = breakdownCache(world, statFor);
  const lop = await lopOf(db, c.companyId, ids, b.from, b.to);
  const [items] = await db.query('SELECT id, employee_id, component_id, amount, note FROM hrms_pay_items WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  const idents = await identifiersOf(db, c.companyId, ids);
  const tdsComp = comps.list.find((k) => k.statutoryKey === 'TDS') ?? null;

  // Earlier locked runs of the arrears window: their people (salaries used, days) and what they paid.
  const fromMonth = (() => { let m = month; for (let i = 0; i < ARREARS_LOOKBACK; i += 1) m = prevMonth(m); return m; })();
  const [pastRuns] = await db.query(
    `SELECT id, period_month FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status IN ('LOCKED','RELEASED','PAID') AND period_month >= ? AND period_month < ? ORDER BY period_month`,
    [c.companyId, fromMonth, month]);
  const pastPeople = new Map(); // employeeId -> [{ month, runId, calc, earnings, pfWage, esiWage, paidCodes }]
  if (pastRuns.length && ids.length) {
    const runIds = pastRuns.map((r) => r.id);
    const monthOfRun = new Map(pastRuns.map((r) => [r.id, r.period_month]));
    const [pp] = await db.query(
      `SELECT id, run_id, employee_id, calc_json, days_in_month FROM hrms_pay_run_people WHERE company_id = ? AND deleted_at IS NULL AND included = 1
          AND run_id IN (${runIds.map(() => '?').join(',')}) AND employee_id IN (${ids.map(() => '?').join(',')})`, [c.companyId, ...runIds, ...ids]);
    // The window's runs only: arrears for a month of the window are paid by a later run, also in it.
    const [pl] = await db.query(
      `SELECT l.run_person_id, l.employee_id, l.run_id, l.amount, l.source, l.for_month, l.component_id, l.pf_wage, l.esi_wage FROM hrms_pay_run_lines l
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.kind = 'EARNING' AND l.source IN ('STRUCTURE','ARREARS')
          AND l.run_id IN (${runIds.map(() => '?').join(',')}) AND l.employee_id IN (${ids.map(() => '?').join(',')})`,
      [c.companyId, ...runIds, ...ids]);
    // Grouped once: a person's own structure lines by run person; arrears by (person, month paid for).
    const ownOf = new Map();
    const arrearsOf = new Map();
    for (const l of pl) {
      const [map, key] = l.source === 'STRUCTURE' ? [ownOf, l.run_person_id] : [arrearsOf, `${l.employee_id}|${l.for_month}`];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(l);
    }
    const sumOf = (ls, f) => money(ls.reduce((s, l) => s + f(l), 0));
    for (const p of pp) {
      const m = monthOfRun.get(p.run_id);
      const own = ownOf.get(p.id) ?? [];
      const later = (arrearsOf.get(`${p.employee_id}|${m}`) ?? []).filter((l) => l.run_id !== id);
      const comp = (l) => comps.byId.get(l.component_id);
      // What the month paid: its own lines + arrears already paid for it, wages included (an arrears line keeps the PF / ESI wage of its difference).
      const rec = {
        month: m, runId: p.run_id, calc: json(p.calc_json, {}) ?? {},
        earnings: sumOf([...own, ...later], (l) => Number(l.amount)),
        pfWage: money(sumOf(own.filter((l) => comp(l)?.inPfWage), (l) => Number(l.amount)) + sumOf(later, (l) => Number(l.pf_wage) || 0)),
        esiWage: money(sumOf(own.filter((l) => comp(l)?.inEsiWage), (l) => Number(l.amount)) + sumOf(later, (l) => Number(l.esi_wage) || 0)),
        paidCodes: new Set(own.map((l) => comp(l)?.code).filter(Boolean)),
      };
      if (!pastPeople.has(p.employee_id)) pastPeople.set(p.employee_id, []);
      pastPeople.get(p.employee_id).push(rec);
    }
  }

  // Income tax (P2): the year's paid months, declarations, profiles and overrides of everybody, read once.
  const taxWorld = await loadTaxWorld(db, c.companyId, month, ids, { runId: id });

  const st1 = await statFor(b.from, world.settings.stateCode);
  const missingSettings = ['PF', 'ESI', 'PT', 'LWF'].filter((k) => !st1[k]);
  const results = [];
  for (const e of emps) {
    const warnings = [];
    const sal = salaries.get(e.id) ?? [];
    const joining = dateText(e.date_of_joining);
    const exit = dateText(e.exit_date);
    const days = monthDays({ month, joiningDate: joining, exitDate: exit, salaries: sal, lopDays: lop.get(e.id) ?? [] });
    const myItems = items.filter((i) => i.employee_id === e.id);
    const tdsItems = myItems.filter((i) => tdsComp && i.component_id === tdsComp.id);
    const otherItems = myItems.filter((i) => !(tdsComp && i.component_id === tdsComp.id));
    const id8 = idents.get(e.id) ?? {};
    if (!days.segments.length) {
      warnings.push(W('NO_SALARY', sal.length ? `No salary for ${b.label}: the salary starts ${longDate(sal[0].effectiveFrom)}.` : 'No salary: add one on Payroll › Salaries.'));
      results.push({ e, days, included: false, warnings, calc: null, tds: { amount: 0, source: 'MANUAL' }, idents: id8, otherItems });
      continue;
    }
    // Marked inactive with no exit date: when did the pay stop? Not guessed — not paid, and said.
    if (e.employment_status === 'INACTIVE' && !exit) {
      warnings.push(W('INACTIVE', 'Marked inactive with no exit date: not paid. Give the last working day as the exit date (paid up to it), or make the person active again.'));
      results.push({ e, days, included: false, warnings, calc: null, tds: { amount: 0, source: 'MANUAL' }, idents: id8, otherItems });
      continue;
    }
    const lastSeg = days.segments[days.segments.length - 1];
    const stateCode = lastSeg.salary.stateCode ?? world.settings.stateCode;
    const S = await statFor(b.from, stateCode);
    for (const g of days.segments) {
      const bdx = await bd(g.salary, b.from);
      if (!bdx.ok) warnings.push(W('BAD_STRUCTURE', `The salary from ${longDate(g.salary.effectiveFrom)} cannot be worked out: ${bdx.problems[0]}`));
      g.amounts = Object.fromEntries((bdx.lines ?? []).map((l) => [l.code, l.monthly]));
    }
    if (days.unsalariedDays > 0) warnings.push(W('UNSALARIED_DAYS', `${days.unsalariedDays} day${days.unsalariedDays === 1 ? '' : 's'} of ${b.label} have no salary (it starts ${longDate(sal[0]?.effectiveFrom)}): not paid.`));
    if (days.joinedMid) warnings.push(W('JOINED_MID', `Joined on ${longDate(joining)}: paid for ${days.employedDays} of ${days.daysInMonth} days.`));
    if (days.leftMid) warnings.push(W('LEFT_MID', `Left on ${longDate(exit)}: paid for ${days.employedDays} of ${days.daysInMonth} days.`));
    if (days.lopDays > 0) warnings.push(W('LOP', `${days.lopDays} day${days.lopDays === 1 ? '' : 's'} of leave without pay (approved requests).`));
    if (!id8.account || !id8.ifsc) warnings.push(W('NO_BANK', 'No bank account or IFSC: add them as identifiers (BANK_ACCOUNT, IFSC). Left out of the bank file.'));
    if (!id8.pan) warnings.push(W('NO_PAN', 'No PAN on file.'));

    // ESI: covered for the whole contribution period by the wage rate on its first day (or on joining).
    const period = esiPeriodOf(month, S.ESI);
    const startDay = joining > period.from ? joining : period.from;
    const atStart = sal.filter((s) => s.effectiveFrom <= startDay && (!s.effectiveTo || s.effectiveTo >= startDay)).pop()
      ?? sal.find((s) => s.effectiveFrom >= startDay && s.effectiveFrom <= b.to) ?? null;
    const rate = atStart ? esiRateOf(await bd(atStart, b.from), comps) : null;
    const covered = esiCovered({ rateAtStart: rate, settings: S.ESI });

    // Arrears: earlier paid months whose salary rows have changed since.
    const arrears = [];
    for (const past of pastPeople.get(e.id) ?? []) {
      const pb = monthBounds(past.month);
      const used = new Set((past.calc.salaryIds ?? []).map(Number));
      const now = sal.filter((s) => s.effectiveFrom <= pb.to && (!s.effectiveTo || s.effectiveTo >= pb.from) && (!s.effectiveTo || s.effectiveTo >= s.effectiveFrom));
      const changed = now.length !== used.size || now.some((s) => !used.has(s.id));
      if (!changed) continue;
      const pd = monthDays({ month: past.month, joiningDate: joining, exitDate: exit, salaries: sal, lopDays: past.calc.lopDates ?? [] });
      for (const g of pd.segments) g.amounts = Object.fromEntries(((await bd(g.salary, pb.from)).lines ?? []).map((l) => [l.code, l.monthly]));
      const exp = earningsFor({ days: pd, components: comps.byCode, paidCodes: past.paidCodes });
      const diff = money(exp.total - past.earnings);
      if (Math.abs(diff) < 1) continue;
      const Sp = await statFor(pb.from, stateCode);
      const ceiling = Number(Sp.PF?.wageCeiling) || Infinity;
      const pfMode = lastSeg.salary.pfMode;
      const pfBase = pfMode === 'NONE' ? 0 : pfMode === 'FULL' ? money(exp.pfWage - past.pfWage) : money(Math.min(exp.pfWage, ceiling) - Math.min(past.pfWage, ceiling));
      arrears.push({ forMonth: past.month, amount: diff, pfBase, pfWage: money(exp.pfWage - past.pfWage), esiWage: money(exp.esiWage - past.esiWage), basis: `revision back-dated over ${pb.label}: ${exp.total.toLocaleString('en-IN')} due, ${past.earnings.toLocaleString('en-IN')} paid` });
    }
    if (arrears.length) warnings.push(W('ARREARS', `Arrears of a back-dated revision for ${arrears.map((a) => monthBounds(a.forMonth).label).join(', ')}.`));

    // EPS stops at 58: for a month that starts on or after the 58th birthday, the employer's PF is all EPF.
    const dob = dateText(e.date_of_birth);
    const at58 = dob ? `${Number(dob.slice(0, 4)) + 58}${dob.slice(4)}` : null;
    const noEps = Boolean(at58 && at58 <= b.from);
    if (at58 && at58 > b.from && at58 <= b.to && lastSeg.salary.pfMode !== 'NONE') {
      warnings.push(W('EPS_58', `Turns 58 on ${longDate(at58)}: EPS stops from then. This month still pays EPS on the whole month — check the split with your CA.`));
    }

    const personInput = {
      month, days, components: comps.byCode,
      oneTime: otherItems.map((i) => ({ code: comps.byId.get(i.component_id)?.code, amount: Number(i.amount), note: i.note })).filter((i) => i.code),
      arrears, pfMode: lastSeg.salary.pfMode, esiCovered: covered, noEps, settings: S,
    };
    // The month without TDS first: its earnings, PT and PF are what the tax engine counts for this month.
    const before = computePerson({ ...personInput, tds: 0 });
    const current = monthFromLines(before.lines.map((l) => ({ ...l, comp: comps.byCode.get(l.code) })));
    const tds = await monthlyTds({ companyId: c.companyId, month, employeeId: e.id, world: taxWorld, current }, tdsItems.map((i) => ({ amount: Number(i.amount), note: i.note })));
    const calc = computePerson({ ...personInput, tds: tds.amount, tdsBasis: tds.basis });
    if (tds.tax?.noPan?.applied && tds.source === 'ENGINE') warnings.push(W('TDS_NO_PAN', `TDS at the higher rate without a PAN (${tds.tax.noPan.section}).`));
    if (tds.source === 'MANUAL') warnings.push(W('TDS_MANUAL', `TDS set by hand: ${tds.override?.reason ?? 'one-time item'}${tds.tax?.available ? ` (the engine says ₹${Number(tds.tax.tds).toLocaleString('en-IN')})` : ''}.`));
    if (tds.tax && !tds.tax.available) warnings.push(W('TDS_NO_RULES', tds.tax.warnings?.[0] ?? 'The TDS could not be worked out.'));
    for (const w of calc.warnings) warnings.push(W('CHECK', w));
    if (calc.netPay < 0) warnings.push(W('NEGATIVE_NET', 'Net pay is below zero: lower a deduction, or move it to a later month.'));
    results.push({ e, days, included: true, warnings, calc, tds, covered, idents: id8, salary: lastSeg.salary, otherItems, taxJson: runSnapshot(tds.tax, tds.source, tds.override) });
  }

  // Items for somebody not in this month's payroll: said, not lost.
  const inRun = new Set(results.map((r) => r.e.id));
  const strayItems = items.filter((i) => !inRun.has(i.employee_id));

  // ── write: the old calculation out, the new one in ─────────────────────
  await db.query('UPDATE hrms_pay_run_lines SET deleted_at = NOW() WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE hrms_pay_run_people SET deleted_at = NOW() WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  const totals = { gross: 0, deductions: 0, employer: 0, net: 0, reimbursements: 0, people: 0, pfAdmin: 0, edli: 0, pfEmployee: 0, pfEmployer: 0, eps: 0, esiEmployee: 0, esiEmployer: 0, pt: 0, lwfEmployee: 0, lwfEmployer: 0, tds: 0, warnings: {} };
  const lineRows = [];
  for (const r of results) {
    const k = r.calc;
    const seg = r.days.segments;
    const [ins] = await db.query(
      `INSERT INTO hrms_pay_run_people (company_id, run_id, employee_id, salary_id, structure_id, annual_ctc, days_in_month, employed_days, lop_days, payable_days, calc_json,
         gross, reimbursements, deductions, employer_total, net_pay, pf_wage, esi_wage, esi_covered, tds_amount, tds_source, tax_json, included, warnings_json, bank_json, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, id, r.e.id, r.salary?.id ?? null, r.salary?.structureId ?? null, r.salary?.annualCtc ?? null, r.days.daysInMonth, r.days.employedDays, r.days.lopDays, r.days.payableDays,
        JSON.stringify({ lopDates: r.days.lopDates, salaryIds: seg.map((g) => g.salary.id), segments: seg.map((g) => ({ salaryId: g.salary.id, from: g.from, to: g.to, days: g.days, lop: g.lop })), esiCovered: Boolean(r.covered) }),
        k?.gross ?? 0, k?.reimbursements ?? 0, k?.deductions ?? 0, k?.employer ?? 0, k?.netPay ?? 0, k?.pfWage ?? 0, k?.esiWage ?? 0, r.covered ? 1 : 0,
        k ? k.tds : 0, r.tds.source, r.taxJson ? JSON.stringify(r.taxJson) : null, r.included ? 1 : 0, JSON.stringify(r.warnings),
        JSON.stringify({ account: r.idents.account ?? null, ifsc: r.idents.ifsc ?? null }), c.userId]);
    for (const w of r.warnings) totals.warnings[w.code] = (totals.warnings[w.code] ?? 0) + 1;
    if (!r.included) continue;
    totals.people += 1;
    totals.gross += k.gross; totals.deductions += k.deductions; totals.employer += k.employer; totals.net += k.netPay; totals.reimbursements += k.reimbursements;
    totals.pfAdmin += k.pf.admin; totals.edli += k.pf.edli; totals.pfEmployee += k.pf.employee; totals.pfEmployer += k.pf.employer; totals.eps += k.pf.eps;
    totals.esiEmployee += k.esi.employee; totals.esiEmployer += k.esi.employer; totals.tds += k.tds;
    for (const l of k.lines) {
      if (l.statutoryKey === 'PT') totals.pt += l.amount;
      if (l.statutoryKey === 'LWF_EE') totals.lwfEmployee += l.amount;
      if (l.statutoryKey === 'LWF_ER') totals.lwfEmployer += l.amount;
      lineRows.push([c.companyId, id, ins.insertId, r.e.id, l.componentId, l.kind, l.amount, l.fullAmount, String(l.basis ?? '').slice(0, 300), l.source, l.forMonth, l.pfWage ?? null, l.esiWage ?? null, l.sortOrder, c.userId]);
    }
  }
  for (let i = 0; i < lineRows.length; i += 400) {
    const chunk = lineRows.slice(i, i + 400);
    await db.query(`INSERT INTO hrms_pay_run_lines (company_id, run_id, run_person_id, employee_id, component_id, kind, amount, full_amount, basis, source, for_month, pf_wage, esi_wage, sort_order, created_by) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`, chunk.flat());
  }
  for (const k of Object.keys(totals)) if (typeof totals[k] === 'number') totals[k] = money(totals[k]);
  // PF admin charges have a monthly minimum for the establishment.
  if (st1.PF?.adminMinimum && totals.pfEmployee > 0 && totals.pfAdmin < Number(st1.PF.adminMinimum)) totals.pfAdmin = money(st1.PF.adminMinimum);
  totals.missingSettings = missingSettings;
  totals.unverifiedSettings = Object.entries(st1).filter(([, v]) => v?.meta?.verification === 'UNVERIFIED').map(([k]) => k);
  totals.statutoryFrom = Object.fromEntries(Object.entries(st1).map(([k, v]) => [k, v?.meta?.effectiveFrom ?? null]));
  totals.strayItems = strayItems.length;
  await db.query(
    `UPDATE hrms_pay_runs SET status = 'CALCULATED', people_count = ?, gross_total = ?, deductions_total = ?, employer_total = ?, net_total = ?, totals_json = ?, calculated_at = ?, calculated_by = ?
      WHERE company_id = ? AND id = ?`,
    [totals.people, totals.gross, totals.deductions, totals.employer, totals.net, JSON.stringify(totals), calculatedAt, c.userId, c.companyId, id]);
  await audit(db, c, 'hrms_pay_runs', id, 'UPDATE', { status: run.status }, { status: 'CALCULATED', calculated: { people: totals.people, net: totals.net, warnings: totals.warnings } }, requestId);
  return readRun(db, c, id, { audited: false });
}

/* ══ read ════════════════════════════════════════════════════════════════ */

/** GET /payroll/runs/:id — the run and its people (amounts; the route asks for pay view). */
export async function readRun(db, c, id, { audited = true, requestId = null } = {}) {
  const r = await runRow(db, c.companyId, id);
  const [people] = await db.query(
    `SELECT p.*, e.employee_code, e.full_name FROM hrms_pay_run_people p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
      WHERE p.company_id = ? AND p.run_id = ? AND p.deleted_at IS NULL ORDER BY p.included DESC, e.full_name, e.id`, [c.companyId, id]);
  const seats = await seatsOn(db, c.companyId, people.map((p) => p.employee_id), monthBounds(r.period_month).to);
  const [[items]] = await db.query('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM hrms_pay_items WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  const [[slips]] = await db.query("SELECT COUNT(*) AS n FROM hrms_pay_payslips WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL AND status = 'RELEASED'", [c.companyId, id]);
  if (audited) await auditSalaryRead(db, c, people.filter((p) => p.included).map((p) => p.employee_id), `payroll run ${r.period_month}`, requestId);
  const stale = OPEN.includes(r.status) && r.calculated_at ? await changedSince(db, c.companyId, r) : [];
  const ownerOnlyRemove = Number(r.reopen_count) > 0 || Boolean(Number(r.ever_paid));
  return {
    run: shapeRun(r),
    people: people.map((p) => ({
      id: p.id, employee: { id: p.employee_id, code: p.employee_code, name: p.full_name, ...(seats.get(p.employee_id) ?? {}) },
      included: Boolean(p.included), daysInMonth: Number(p.days_in_month), employedDays: Number(p.employed_days), lopDays: Number(p.lop_days), payableDays: Number(p.payable_days),
      annualCtc: p.annual_ctc == null ? null : money(p.annual_ctc), gross: money(p.gross), reimbursements: money(p.reimbursements), deductions: money(p.deductions),
      employer: money(p.employer_total), net: money(p.net_pay), tds: money(p.tds_amount), tdsSource: p.tds_source, esiCovered: Boolean(p.esi_covered),
      tax: taxSummary(json(p.tax_json, null)),
      warnings: json(p.warnings_json, []) ?? [],
    })),
    items: { count: Number(items.n), total: money(items.total) },
    payslips: Number(slips.n),
    payments: await paymentsOf(db, c.companyId, r),
    stale,
    can: {
      calculate: OPEN.includes(r.status), lock: r.status === 'CALCULATED' && !stale.length, release: r.status === 'LOCKED', paid: r.status === 'RELEASED',
      reopen: FROZEN.includes(r.status) && Boolean(c.owner), remove: OPEN.includes(r.status) && (!ownerOnlyRemove || Boolean(c.owner)), bankFile: FROZEN.includes(r.status), items: OPEN.includes(r.status),
    },
  };
}

/**
 * What was paid for the run's month, and the recoveries: { paid, paidPeople, lastPaidOn, recoveries: [{ employee, amount, inMonth }],
 * recoveriesIn: [{ employee, amount, forMonth }] } — the second list: recoveries of earlier months this run makes.
 */
async function paymentsOf(db, companyId, r) {
  const [rows] = await db.query(
    `SELECT p.kind, p.employee_id, p.amount, p.paid_on, p.recovery_run_id, rr.period_month AS in_month, e.employee_code, e.full_name
       FROM hrms_pay_payments p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
       LEFT JOIN hrms_pay_runs rr ON rr.company_id = p.company_id AND rr.id = p.recovery_run_id
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.period_month = ? ORDER BY p.id`, [companyId, r.period_month]);
  const [mine] = await db.query(
    `SELECT p.employee_id, p.amount, p.period_month, e.employee_code, e.full_name FROM hrms_pay_payments p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.kind = 'RECOVERY' AND p.recovery_run_id = ? ORDER BY p.id`, [companyId, r.id]);
  const who = (x) => ({ id: x.employee_id, code: x.employee_code, name: x.full_name });
  const paid = rows.filter((x) => x.kind === 'PAID');
  return {
    paid: money(paid.reduce((s, x) => s + Number(x.amount), 0)),
    paidPeople: new Set(paid.map((x) => x.employee_id)).size,
    lastPaidOn: paid.length ? dateText(paid[paid.length - 1].paid_on) : null,
    recoveries: rows.filter((x) => x.kind === 'RECOVERY').map((x) => ({ employee: who(x), amount: money(x.amount), inMonth: x.in_month ?? null })),
    recoveriesIn: mine.map((x) => ({ employee: who(x), amount: money(x.amount), forMonth: x.period_month })),
  };
}

/** Paid so far for a month, per person: SUM(PAID) − SUM(RECOVERY). { byEmployee: Map, any } */
async function paidSoFar(db, companyId, month) {
  const [rows] = await db.query(
    `SELECT employee_id, SUM(CASE WHEN kind = 'PAID' THEN amount ELSE -amount END) AS paid, COUNT(*) AS n FROM hrms_pay_payments
      WHERE company_id = ? AND period_month = ? AND deleted_at IS NULL GROUP BY employee_id`, [companyId, month]);
  return { byEmployee: new Map(rows.map((x) => [x.employee_id, money(x.paid)])), any: rows.length > 0 };
}

/**
 * What the bank file of a run pays, per person: the net — or, when something was paid for the month
 * before (a re-open), the difference. [{ employeeId, code, name, net, paid, due, bank }]
 */
async function duesOf(db, companyId, r) {
  const [people] = await db.query(
    `SELECT p.employee_id, p.net_pay, p.bank_json, p.included, e.employee_code, e.full_name FROM hrms_pay_run_people p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
      WHERE p.company_id = ? AND p.run_id = ? AND p.deleted_at IS NULL ORDER BY e.full_name, e.id`, [companyId, r.id]);
  const before = await paidSoFar(db, companyId, r.period_month);
  const out = [];
  const seen = new Set();
  for (const p of people) {
    seen.add(p.employee_id);
    const net = p.included ? money(p.net_pay) : 0;
    const paid = before.byEmployee.get(p.employee_id) ?? 0;
    if (!p.included && !paid) continue;
    out.push({ employeeId: p.employee_id, code: p.employee_code, name: p.full_name, net, paid, due: money(net - paid), bank: json(p.bank_json, {}) ?? {} });
  }
  // Paid for the month before, and not in the run now: all of it is to recover.
  const gone = [...before.byEmployee.entries()].filter(([e, paid]) => !seen.has(e) && paid);
  if (gone.length) {
    const [emps] = await db.query(`SELECT id, employee_code, full_name FROM hrms_employees WHERE company_id = ? AND id IN (${gone.map(() => '?').join(',')})`, [companyId, ...gone.map(([e]) => e)]);
    for (const [e, paid] of gone) {
      const x = emps.find((m) => m.id === e);
      out.push({ employeeId: e, code: x?.employee_code ?? null, name: x?.full_name ?? '', net: 0, paid, due: money(-paid), bank: {} });
    }
  }
  return { people: out, difference: before.any };
}

/** GET /payroll/runs/:id/bank-file — the NEFT file; after a re-open, the differences only. Audited. */
export async function bankFile(db, c, id, requestId = null) {
  const r = await runRow(db, c.companyId, id);
  if (!FROZEN.includes(r.status)) throw refuse('WRONG_STATUS', 'The bank file is made from a locked payroll. Lock it first.');
  const { people: pay, difference } = await duesOf(db, c.companyId, r);
  const out = neftCsv({ month: r.period_month }, pay.map((p) => ({
    employee: { code: p.code, name: p.name }, net: difference ? Math.max(0, p.due) : p.net, bank: p.bank,
    why: difference ? (p.due < 0 ? `paid ${p.paid.toLocaleString('en-IN')} already, ${(-p.due).toLocaleString('en-IN')} more than due now: recovered in the next run` : 'already paid in full') : undefined,
  })), await companySettings(db, c.companyId), { difference });
  const recover = difference ? pay.filter((p) => p.due < 0).map((p) => ({ code: p.code, name: p.name, amount: money(-p.due) })) : [];
  await auditSalaryRead(db, c, pay.map((p) => p.employeeId), `bank file ${r.period_month}`, requestId);
  await audit(db, c, 'hrms_pay_runs', r.id, 'GENERATE', null, { bankFile: out.fileName, rows: out.rows, total: out.total, skipped: out.skipped.length, difference, recover: recover.length }, requestId);
  return { fileName: out.fileName, mimeType: 'text/csv', contentBase64: Buffer.from(out.csv, 'utf8').toString('base64'), rows: out.rows, total: out.total, skipped: out.skipped, difference, recover };
}

/** GET /payroll/runs/:id/people/:personId — one person's lines and one-time items. Audited. */
export async function readRunPerson(db, c, runId, personId, requestId = null) {
  const r = await runRow(db, c.companyId, runId);
  const [[p]] = await db.query(
    `SELECT p.*, e.employee_code, e.full_name FROM hrms_pay_run_people p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
      WHERE p.company_id = ? AND p.run_id = ? AND p.id = ? AND p.deleted_at IS NULL`, [c.companyId, runId, personId]);
  if (!p) throw notFound('That person in this run');
  const [lines] = await db.query(
    `SELECT l.*, k.code, k.name FROM hrms_pay_run_lines l JOIN hrms_pay_components k ON k.company_id = l.company_id AND k.id = l.component_id
      WHERE l.company_id = ? AND l.run_person_id = ? AND l.deleted_at IS NULL ORDER BY FIELD(l.kind, 'EARNING','REIMBURSEMENT','DEDUCTION','EMPLOYER_CONTRIBUTION'), l.sort_order, l.for_month, l.id`, [c.companyId, personId]);
  const [items] = await db.query(
    `SELECT i.id, i.component_id, i.amount, i.note, k.code, k.name, k.kind, k.statutory_key FROM hrms_pay_items i JOIN hrms_pay_components k ON k.company_id = i.company_id AND k.id = i.component_id
      WHERE i.company_id = ? AND i.run_id = ? AND i.employee_id = ? AND i.deleted_at IS NULL ORDER BY i.id`, [c.companyId, runId, p.employee_id]);
  await auditSalaryRead(db, c, [p.employee_id], `payroll run ${r.period_month}, one person`, requestId);
  const calc = json(p.calc_json, {}) ?? {};
  return {
    run: shapeRun(r),
    person: {
      id: p.id, employee: { id: p.employee_id, code: p.employee_code, name: p.full_name }, included: Boolean(p.included),
      daysInMonth: Number(p.days_in_month), employedDays: Number(p.employed_days), lopDays: Number(p.lop_days), payableDays: Number(p.payable_days), lopDates: calc.lopDates ?? [], segments: calc.segments ?? [],
      annualCtc: p.annual_ctc == null ? null : money(p.annual_ctc), gross: money(p.gross), reimbursements: money(p.reimbursements), deductions: money(p.deductions), employer: money(p.employer_total), net: money(p.net_pay),
      pfWage: money(p.pf_wage), esiWage: money(p.esi_wage), esiCovered: Boolean(p.esi_covered), tds: money(p.tds_amount), tdsSource: p.tds_source, tax: json(p.tax_json, null), warnings: json(p.warnings_json, []) ?? [],
      bank: { account: mask(json(p.bank_json, {})?.account), ifsc: json(p.bank_json, {})?.ifsc ?? null },
    },
    lines: lines.map((l) => ({ id: l.id, componentId: l.component_id, code: l.code, name: l.name, kind: l.kind, amount: money(l.amount), fullAmount: l.full_amount == null ? null : money(l.full_amount), basis: l.basis, source: l.source, forMonth: l.for_month })),
    items: items.map((i) => ({ id: i.id, componentId: i.component_id, code: i.code, name: i.name, kind: i.kind, statutoryKey: i.statutory_key ?? null, amount: money(i.amount), note: i.note })),
  };
}

/** The run line's tax in a few words (the tax sheet has the rest). */
const taxSummary = (t) => (t ? { year: t.year ?? null, regime: t.regime ?? null, engineTds: t.engineTds ?? null, projectedTax: t.projectedTax ?? null, noPan: Boolean(t.noPan), override: t.override ?? null, available: t.available !== false } : null);

/**
 * What the calculation read that has changed since `at` (the run's calculated_at): salaries, items,
 * statutory rows and the payroll settings (the state), components, structures, approved leave,
 * people, bank accounts and IFSCs, the tax inputs, and an earlier month locked again (its
 * arrears are what this month compares with).
 *
 * `>=`: updated_at is to the second, so a write in the very second of the calculation counts as
 * a change. calculateRun starts in a second nothing was written in (watermark), so a write
 * before the calculation is never mistaken for one after it.
 */
async function changedSince(db, companyId, r, at = r.calculated_at) {
  const b = monthBounds(r.period_month);
  const q = async (sql, params) => Number((await db.query(sql, params))[0][0].n) > 0;
  const out = [];
  if (await q('SELECT COUNT(*) AS n FROM hrms_pay_salaries WHERE company_id = ? AND updated_at >= ?', [companyId, at])) out.push('a salary');
  if (await q('SELECT COUNT(*) AS n FROM hrms_pay_items WHERE company_id = ? AND run_id = ? AND updated_at >= ?', [companyId, r.id, at])) out.push('a one-time item');
  if (await q('SELECT COUNT(*) AS n FROM hrms_pay_statutory_settings WHERE company_id = ? AND updated_at >= ?', [companyId, at])) out.push('the statutory settings');
  if (await q('SELECT COUNT(*) AS n FROM hrms_pay_settings WHERE company_id = ? AND updated_at >= ?', [companyId, at])) out.push('the payroll settings (the state)');
  if (await q('SELECT COUNT(*) AS n FROM hrms_pay_components WHERE company_id = ? AND updated_at >= ?', [companyId, at])) out.push('a component');
  if (await q('SELECT COUNT(*) AS n FROM hrms_pay_structures WHERE company_id = ? AND updated_at >= ?', [companyId, at])) out.push('a structure');
  if (await q('SELECT COUNT(*) AS n FROM hrms_leave_requests WHERE company_id = ? AND updated_at >= ? AND from_date <= ? AND to_date >= ?', [companyId, at, b.to, b.from])) out.push('a leave request of the month');
  if (await q('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND updated_at >= ?', [companyId, at])) out.push('an employee’s joining or leaving');
  if (await q("SELECT COUNT(*) AS n FROM hrms_employee_identifiers WHERE company_id = ? AND identifier_type IN ('BANK_ACCOUNT','IFSC') AND updated_at >= ?", [companyId, at])) out.push('a bank account or IFSC');
  if (await q('SELECT COUNT(*) AS n FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND period_month < ? AND locked_at >= ?', [companyId, r.period_month, at])) out.push('an earlier month’s payroll, locked again');
  if (await q('SELECT COUNT(*) AS n FROM hrms_tax_tds_overrides WHERE company_id = ? AND run_id = ? AND updated_at >= ?', [companyId, r.id, at])) out.push('a TDS set by hand');
  if (await q("SELECT (SELECT COUNT(*) FROM hrms_tax_declaration_lines WHERE company_id = ? AND updated_at >= ?) + (SELECT COUNT(*) FROM hrms_tax_profiles WHERE company_id = ? AND updated_at >= ?) + (SELECT COUNT(*) FROM hrms_tax_settings WHERE company_id = ? AND updated_at >= ?) + (SELECT COUNT(*) FROM hrms_employee_identifiers WHERE company_id = ? AND identifier_type = 'PAN' AND updated_at >= ?) AS n", [companyId, at, companyId, at, companyId, at, companyId, at])) out.push('a tax declaration, regime, PAN or tax setting');
  return out;
}

/**
 * The second a calculation is stamped with (calculated_at). When something it reads was written in
 * the current second, it waits for the next one (at most a second): then every write before the
 * calculation is in an earlier second, and every write after it is in this one or later.
 */
async function watermark(db, companyId, run) {
  const now = async () => (await db.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS w"))[0][0].w;
  const w = await now();
  if (!(await changedSince(db, companyId, run, w)).length) return w;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    const next = await now();
    if (next !== w) return next;
  }
  return now();
}

/* ══ one-time items ══════════════════════════════════════════════════════ */

/** GET /payroll/runs/:id/items — others' amounts: audited like any read of pay. */
export async function listItems(db, c, runId, requestId = null) {
  const r = await runRow(db, c.companyId, runId);
  const [rows] = await db.query(
    `SELECT i.id, i.employee_id, i.component_id, i.amount, i.note, i.updated_at, e.employee_code, e.full_name, k.code, k.name, k.kind,
            (SELECT p.period_month FROM hrms_pay_payments p WHERE p.company_id = i.company_id AND p.recovery_item_id = i.id AND p.deleted_at IS NULL LIMIT 1) AS recovers
       FROM hrms_pay_items i JOIN hrms_employees e ON e.company_id = i.company_id AND e.id = i.employee_id
       JOIN hrms_pay_components k ON k.company_id = i.company_id AND k.id = i.component_id
      WHERE i.company_id = ? AND i.run_id = ? AND i.deleted_at IS NULL ORDER BY e.full_name, i.id`, [c.companyId, runId]);
  if (rows.length) await auditSalaryRead(db, c, rows.map((i) => i.employee_id), `one-time items of payroll ${r.period_month}`, requestId);
  return {
    items: rows.map((i) => ({
      id: i.id, employee: { id: i.employee_id, code: i.employee_code, name: i.full_name }, componentId: i.component_id, code: i.code, name: i.name, kind: i.kind, amount: money(i.amount), note: i.note, updatedAt: stamp(i.updated_at),
      recovers: i.recovers ?? null,
    })),
  };
}

/** The month an automatic recovery item recovers (it is made by the payroll, not typed), or null. */
async function recoveryOf(db, companyId, itemId) {
  const [[p]] = await db.query('SELECT period_month FROM hrms_pay_payments WHERE company_id = ? AND recovery_item_id = ? AND deleted_at IS NULL LIMIT 1', [companyId, itemId]);
  return p?.period_month ?? null;
}

/**
 * Recoveries waiting for a run (a re-opened month paid a person more than the corrected net):
 * each becomes a one-time deduction of `run` — the next open run after the month — once.
 * The deduction is "Other deduction" (OTHER_DED), or the first active non-statutory deduction.
 */
async function attachRecoveries(db, c, run, requestId = null) {
  if (!OPEN.includes(run.status)) return 0;
  const [waiting] = await db.query(
    `SELECT id, period_month, employee_id, amount FROM hrms_pay_payments WHERE company_id = ? AND deleted_at IS NULL AND kind = 'RECOVERY' AND recovery_item_id IS NULL AND period_month < ? ORDER BY id`,
    [c.companyId, run.period_month]);
  if (!waiting.length) return 0;
  const comps = await loadComponents(db, c.companyId);
  const k = [comps.byCode.get('OTHER_DED'), ...comps.list.filter((x) => x.kind === 'DEDUCTION' && !x.statutoryKey)].find((x) => x && x.status === 'ACTIVE' && x.kind === 'DEDUCTION' && !x.statutoryKey);
  if (!k) return 0;
  for (const p of waiting) {
    const note = `Recovery: ${labelOf(p.period_month)} was re-opened and paid ${money(p.amount).toLocaleString('en-IN')} more than its corrected pay`;
    const [ins] = await db.query('INSERT INTO hrms_pay_items (company_id, run_id, employee_id, component_id, amount, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [c.companyId, run.id, p.employee_id, k.id, money(p.amount), note.slice(0, 300), c.userId]);
    await db.query('UPDATE hrms_pay_payments SET recovery_run_id = ?, recovery_item_id = ? WHERE company_id = ? AND id = ?', [run.id, ins.insertId, c.companyId, p.id]);
    await audit(db, c, 'hrms_pay_items', ins.insertId, 'CREATE', null, { runId: run.id, month: run.period_month, employeeId: p.employee_id, component: k.code, amount: money(p.amount), note, recovers: p.period_month }, requestId);
  }
  return waiting.length;
}

/** Components a one-time item may use: non-statutory earnings, deductions, reimbursements, and TDS. */
export const itemComponentOk = (k) => k && k.status === 'ACTIVE' && (k.statutoryKey === 'TDS' || (!k.statutoryKey && k.kind !== 'EMPLOYER_CONTRIBUTION'));

export async function addItem(db, c, runId, body = {}, requestId = null) {
  const r = await runRow(db, c.companyId, runId, { forUpdate: true });
  mustBe(r, OPEN, 'changed');
  const problems = [];
  const employeeId = Number(body.employeeId);
  const [[e]] = Number.isInteger(employeeId) && employeeId > 0 ? await db.query('SELECT id, date_of_joining, exit_date FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, employeeId]) : [[null]];
  if (!e) problems.push('Choose the person.');
  const comps = await loadComponents(db, c.companyId);
  const k = comps.byId.get(Number(body.componentId)) ?? comps.byCode.get(String(body.code ?? '').toUpperCase());
  if (!itemComponentOk(k)) problems.push('Component: an earning, a deduction, a reimbursement or TDS that is active (not one the run works out by law).');
  const amount = readAmount(body.amount, 'Amount', problems);
  if (amount === 0) problems.push('Amount: more than zero.');
  if (problems.length) throw bad('The item cannot be added yet.', problems);
  const [ins] = await db.query('INSERT INTO hrms_pay_items (company_id, run_id, employee_id, component_id, amount, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, runId, employeeId, k.id, amount, text(body.note, 300), c.userId]);
  await audit(db, c, 'hrms_pay_items', ins.insertId, 'CREATE', null, { runId, month: r.period_month, employeeId, component: k.code, amount, note: text(body.note, 300) }, requestId);
  return { item: { id: ins.insertId, employeeId, componentId: k.id, code: k.code, amount, note: text(body.note, 300) }, recalculate: r.status === 'CALCULATED' };
}

async function itemRow(db, c, itemId) {
  const [[i]] = await db.query('SELECT * FROM hrms_pay_items WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, itemId]);
  if (!i) throw notFound('That one-time item');
  return i;
}

export async function updateItem(db, c, itemId, body = {}, requestId = null) {
  const i = await itemRow(db, c, itemId);
  const r = await runRow(db, c.companyId, i.run_id, { forUpdate: true });
  mustBe(r, OPEN, 'changed');
  const problems = [];
  const amount = body.amount === undefined ? Number(i.amount) : readAmount(body.amount, 'Amount', problems);
  if (amount === 0) problems.push('Amount: more than zero — or remove the item.');
  const recovers = await recoveryOf(db, c.companyId, itemId);
  if (recovers && amount !== money(i.amount)) problems.push(`Amount: this item recovers what ${labelOf(recovers)} paid over the corrected pay. It is made by the payroll; its amount stays (the note can change).`);
  if (problems.length) throw bad('The item cannot be saved yet.', problems);
  const note = body.note === undefined ? i.note : text(body.note, 300);
  await db.query('UPDATE hrms_pay_items SET amount = ?, note = ? WHERE company_id = ? AND id = ?', [amount, note, c.companyId, itemId]);
  await audit(db, c, 'hrms_pay_items', itemId, 'UPDATE', { amount: money(i.amount), note: i.note }, { amount, note }, requestId);
  return { item: { id: itemId, amount, note }, recalculate: r.status === 'CALCULATED' };
}

export async function deleteItem(db, c, itemId, requestId = null) {
  const i = await itemRow(db, c, itemId);
  const r = await runRow(db, c.companyId, i.run_id, { forUpdate: true });
  mustBe(r, OPEN, 'changed');
  const recovers = await recoveryOf(db, c.companyId, itemId);
  if (recovers) throw refuse('RECOVERY', `This item recovers what ${labelOf(recovers)} paid over the corrected pay (the month was re-opened). It is made by the payroll and cannot be removed.`);
  await db.query('UPDATE hrms_pay_items SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, itemId]);
  await audit(db, c, 'hrms_pay_items', itemId, 'DELETE', { runId: i.run_id, employeeId: i.employee_id, componentId: i.component_id, amount: money(i.amount), note: i.note }, null, requestId);
  return { ok: true, recalculate: r.status === 'CALCULATED' };
}

/**
 * PUT /payroll/runs/:id/people/:employeeId/tds { amount, reason } — HR's TDS for the person this
 * month (0 allowed), with the reason; it wins over the engine (tds.js). Audited.
 * DELETE the same — back to the engine.
 */
export async function setTds(db, c, runId, employeeId, body = {}, requestId = null) {
  const r = await runRow(db, c.companyId, runId, { forUpdate: true });
  mustBe(r, OPEN, 'changed');
  const [[e]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, employeeId]);
  if (!e) throw notFound('That person');
  const problems = [];
  const amount = readAmount(body.amount, 'TDS', problems);
  const reason = text(body.reason ?? body.note, 500);
  if (!reason || reason.length < 3) problems.push('Reason: say why the TDS is set by hand (it is kept with the run).');
  if (problems.length) throw bad('The TDS cannot be saved yet.', problems);
  const [old] = await db.query('SELECT id, amount, reason FROM hrms_tax_tds_overrides WHERE company_id = ? AND run_id = ? AND employee_id = ? AND deleted_at IS NULL', [c.companyId, runId, employeeId]);
  for (const o of old) await db.query('UPDATE hrms_tax_tds_overrides SET deleted_at = NOW() WHERE id = ?', [o.id]);
  const [ins] = await db.query('INSERT INTO hrms_tax_tds_overrides (company_id, run_id, employee_id, amount, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)', [c.companyId, runId, employeeId, amount, reason, c.userId]);
  await audit(db, c, 'hrms_tax_tds_overrides', ins.insertId, old.length ? 'UPDATE' : 'CREATE', old[0] ? { amount: money(old[0].amount), reason: old[0].reason } : null, { runId, month: r.period_month, employeeId, amount, reason }, requestId);
  return { override: { employeeId, amount, reason }, recalculate: r.status === 'CALCULATED' };
}

export async function clearTds(db, c, runId, employeeId, requestId = null) {
  const r = await runRow(db, c.companyId, runId, { forUpdate: true });
  mustBe(r, OPEN, 'changed');
  const [old] = await db.query('SELECT id, amount, reason FROM hrms_tax_tds_overrides WHERE company_id = ? AND run_id = ? AND employee_id = ? AND deleted_at IS NULL', [c.companyId, runId, employeeId]);
  for (const o of old) {
    await db.query('UPDATE hrms_tax_tds_overrides SET deleted_at = NOW() WHERE id = ?', [o.id]);
    await audit(db, c, 'hrms_tax_tds_overrides', o.id, 'DELETE', { amount: money(o.amount), reason: o.reason }, { backTo: 'the engine' }, requestId);
  }
  return { cleared: old.length, recalculate: r.status === 'CALCULATED' };
}


/* ══ lock, release, paid, re-open ════════════════════════════════════════ */

export async function lockRun(db, c, id, requestId = null) {
  const r = await runRow(db, c.companyId, id, { forUpdate: true });
  mustBe(r, ['CALCULATED'], 'locked');
  await assertEarlierLocked(db, c.companyId, r, 'locked');
  const stale = await changedSince(db, c.companyId, r);
  if (stale.length) throw refuse('STALE', `Something the calculation read has changed since (${stale.join(', ')}). Calculate again, review, then lock.`, { problems: stale });
  const [neg] = await db.query(
    `SELECT e.employee_code, e.full_name, p.net_pay FROM hrms_pay_run_people p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
      WHERE p.company_id = ? AND p.run_id = ? AND p.deleted_at IS NULL AND p.included = 1 AND p.net_pay < 0 ORDER BY e.full_name`, [c.companyId, id]);
  if (neg.length) {
    const names = neg.slice(0, 5).map((p) => `${p.full_name} (${money(p.net_pay).toLocaleString('en-IN')})`).join(', ');
    throw refuse('NEGATIVE_NET', `Net pay is below zero for ${neg.length === 1 ? 'one person' : `${neg.length} people`}: ${names}${neg.length > 5 ? ' …' : ''}. Lower a deduction or move it to a later month, calculate again, then lock.`,
      { problems: neg.map((p) => `${p.employee_code} ${p.full_name}: ${money(p.net_pay)}`) });
  }
  await db.query("UPDATE hrms_pay_runs SET status = 'LOCKED', locked_at = NOW(), locked_by = ? WHERE company_id = ? AND id = ?", [c.userId, c.companyId, id]);
  await audit(db, c, 'hrms_pay_runs', id, 'APPROVE', { status: r.status }, { status: 'LOCKED' }, requestId);
  return readRun(db, c, id, { audited: false });
}

/** Financial year (April to March) of a month: { from: 'YYYY-04', label: '2026-27' }. */
export function fyOf(month) {
  const [y, m] = month.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}-04`, to: `${start + 1}-03`, label: `${start}-${String((start + 1) % 100).padStart(2, '0')}` };
}

export async function releaseRun(db, c, id, requestId = null) {
  const r = await runRow(db, c.companyId, id, { forUpdate: true });
  mustBe(r, ['LOCKED'], 'released');
  const month = r.period_month;
  const b = monthBounds(month);
  const [people] = await db.query(
    `SELECT p.*, e.employee_code, e.full_name, e.date_of_joining FROM hrms_pay_run_people p JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
      WHERE p.company_id = ? AND p.run_id = ? AND p.deleted_at IS NULL AND p.included = 1`, [c.companyId, id]);
  const ids = people.map((p) => p.employee_id);
  const [lines] = await db.query(
    `SELECT l.*, k.code, k.name FROM hrms_pay_run_lines l JOIN hrms_pay_components k ON k.company_id = l.company_id AND k.id = l.component_id
      WHERE l.company_id = ? AND l.run_id = ? AND l.deleted_at IS NULL ORDER BY l.sort_order, l.for_month, l.id`, [c.companyId, id]);
  const [idents, seats] = await Promise.all([identifiersOf(db, c.companyId, ids), seatsOn(db, c.companyId, ids, b.to)]);
  const fy = fyOf(month);
  const [ytdRows] = ids.length ? await db.query(
    `SELECT employee_id, snapshot_json FROM hrms_pay_payslips WHERE company_id = ? AND deleted_at IS NULL AND status = 'RELEASED' AND period_month >= ? AND period_month < ?
        AND employee_id IN (${ids.map(() => '?').join(',')})`, [c.companyId, fy.from, month, ...ids]) : [[]];
  const [[company]] = await db.query('SELECT name FROM companies WHERE id = ?', [c.companyId]);
  const [[hs]] = await db.query('SELECT company_legal_name, place_of_posting FROM hrms_hiring_settings WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const [[prev]] = await db.query('SELECT MAX(version) AS v FROM hrms_pay_payslips WHERE company_id = ? AND run_id = ?', [c.companyId, id]);
  const version = (Number(prev?.v) || 0) + 1;
  let n = 0;
  for (const p of people) {
    const mine = lines.filter((l) => l.run_person_id === p.id);
    const pick = (kind) => mine.filter((l) => l.kind === kind).map((l) => ({ code: l.code, name: l.forMonth || l.for_month ? `${l.name} (${monthBounds(l.for_month).label})` : l.name, amount: money(l.amount), basis: l.basis ?? null }));
    const ytd = { gross: 0, deductions: 0, net: 0, tds: 0, months: 0 };
    for (const y of ytdRows.filter((x) => x.employee_id === p.employee_id)) {
      const s = json(y.snapshot_json, {});
      ytd.gross += Number(s.totals?.gross) || 0; ytd.deductions += Number(s.totals?.deductions) || 0; ytd.net += Number(s.totals?.net) || 0; ytd.tds += Number(s.tds) || 0; ytd.months += 1;
    }
    ytd.gross = money(ytd.gross + Number(p.gross)); ytd.deductions = money(ytd.deductions + Number(p.deductions)); ytd.net = money(ytd.net + Number(p.net_pay)); ytd.tds = money(ytd.tds + Number(p.tds_amount)); ytd.months += 1;
    const id8 = idents.get(p.employee_id) ?? {};
    const snapshot = {
      version: 1,
      company: { name: company?.name ?? '', legalName: hs?.company_legal_name ?? company?.name ?? '', place: hs?.place_of_posting ?? null },
      period: { month, label: b.label, from: b.from, to: b.to, financialYear: fy.label },
      employee: {
        id: p.employee_id, code: p.employee_code, name: p.full_name, joiningDate: dateText(p.date_of_joining), ...(seats.get(p.employee_id) ?? {}),
        pan: mask(id8.pan), uan: id8.uan ?? null, esiNumber: id8.esi ? mask(id8.esi) : null, bankAccount: mask(json(p.bank_json, {})?.account), ifsc: json(p.bank_json, {})?.ifsc ?? null,
      },
      days: { inMonth: Number(p.days_in_month), employed: Number(p.employed_days), lop: Number(p.lop_days), payable: Number(p.payable_days) },
      annualCtc: p.annual_ctc == null ? null : money(p.annual_ctc),
      earnings: pick('EARNING'), reimbursements: pick('REIMBURSEMENT'), deductions: pick('DEDUCTION'), employer: pick('EMPLOYER_CONTRIBUTION'),
      totals: { gross: money(p.gross), reimbursements: money(p.reimbursements), deductions: money(p.deductions), employer: money(p.employer_total), net: money(p.net_pay) },
      tds: money(p.tds_amount), tdsSource: p.tds_source,
      ytd,
      releasedAt: new Date().toISOString(),
    };
    await db.query(
      `INSERT INTO hrms_pay_payslips (company_id, run_id, run_person_id, employee_id, period_month, version, status, net_pay, snapshot_json, released_at, released_by, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'RELEASED', ?, ?, NOW(), ?, ?)`,
      [c.companyId, id, p.id, p.employee_id, month, version, p.net_pay, JSON.stringify(snapshot), c.userId, c.userId]);
    n += 1;
  }
  await db.query("UPDATE hrms_pay_runs SET status = 'RELEASED', released_at = NOW(), released_by = ? WHERE company_id = ? AND id = ?", [c.userId, c.companyId, id]);
  await audit(db, c, 'hrms_pay_runs', id, 'GENERATE', { status: r.status }, { status: 'RELEASED', payslips: n, version }, requestId);
  return { ...(await readRun(db, c, id, { audited: false })), released: n };
}

export async function markPaid(db, c, id, body = {}, requestId = null) {
  const r = await runRow(db, c.companyId, id, { forUpdate: true });
  mustBe(r, ['RELEASED'], 'marked paid');
  const note = text(body.note, 500);
  // What was paid, per person: the bank file's amounts (the net; after a re-open, the difference).
  const { people, difference } = await duesOf(db, c.companyId, r);
  const paidOn = today();
  let paid = 0;
  let recovered = 0;
  for (const p of people) {
    if (!p.due) continue;
    const kind = p.due > 0 ? 'PAID' : 'RECOVERY';
    const why = kind === 'PAID' ? (difference ? 'the difference after a re-open' : null) : `paid ${p.paid} before, net now ${p.net}`;
    await db.query(
      'INSERT INTO hrms_pay_payments (company_id, run_id, period_month, employee_id, kind, amount, net_pay, paid_on, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [c.companyId, id, r.period_month, p.employeeId, kind, money(Math.abs(p.due)), p.net, paidOn, why, c.userId]);
    if (kind === 'PAID') paid += 1; else recovered += 1;
  }
  await db.query("UPDATE hrms_pay_runs SET status = 'PAID', paid_at = NOW(), paid_by = ?, paid_note = ?, ever_paid = 1 WHERE company_id = ? AND id = ?", [c.userId, note, c.companyId, id]);
  // A recovery goes to the next open run straight away (or waits for the next run made).
  let recoveryIn = null;
  if (recovered) {
    const [[next]] = await db.query("SELECT * FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status IN ('DRAFT','CALCULATED') AND period_month > ? ORDER BY period_month LIMIT 1", [c.companyId, r.period_month]);
    if (next && await attachRecoveries(db, c, next, requestId)) recoveryIn = next.period_month;
  }
  await audit(db, c, 'hrms_pay_runs', id, 'UPDATE', { status: r.status }, { status: 'PAID', note, paid, recovered, difference, recoveryIn }, requestId);
  return readRun(db, c, id, { audited: false });
}

/** The Owner only (the route checks c.owner), with a reason. Back to CALCULATED; its payslips are withdrawn. */
export async function reopenRun(db, c, id, body = {}, requestId = null) {
  if (!c.owner) throw refuse('OWNER_ONLY', 'Only the Owner can re-open a locked payroll.');
  const r = await runRow(db, c.companyId, id, { forUpdate: true });
  mustBe(r, FROZEN, 're-opened');
  const reason = text(body.reason, 500);
  if (!reason || reason.length < 5) throw bad('Say why the payroll is re-opened. The reason is kept with it.');
  // A later locked month paid arrears for this one: re-calculating this month would pay them again.
  const [[later]] = await db.query(
    `SELECT r.period_month FROM hrms_pay_run_lines l JOIN hrms_pay_runs r ON r.company_id = l.company_id AND r.id = l.run_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.source = 'ARREARS' AND l.for_month = ? AND r.deleted_at IS NULL AND r.status IN ('LOCKED','RELEASED','PAID') AND r.period_month > ?
      ORDER BY r.period_month DESC LIMIT 1`, [c.companyId, r.period_month, r.period_month]);
  if (later) {
    throw refuse('LATER_PAID_ARREARS', `The ${labelOf(later.period_month)} payroll paid arrears for ${labelOf(r.period_month)}. Re-open ${labelOf(later.period_month)} first: re-open from the latest month backwards.`, { month: later.period_month });
  }
  const [[w]] = await db.query("SELECT COUNT(*) AS n FROM hrms_pay_payslips WHERE company_id = ? AND run_id = ? AND status = 'RELEASED' AND deleted_at IS NULL", [c.companyId, id]);
  await db.query("UPDATE hrms_pay_payslips SET status = 'WITHDRAWN' WHERE company_id = ? AND run_id = ? AND status = 'RELEASED' AND deleted_at IS NULL", [c.companyId, id]);
  await db.query(
    "UPDATE hrms_pay_runs SET status = 'CALCULATED', reopen_count = reopen_count + 1, reopen_note = ?, locked_at = NULL, locked_by = NULL, released_at = NULL, released_by = NULL, paid_at = NULL, paid_by = NULL WHERE company_id = ? AND id = ?",
    [reason, c.companyId, id]);
  await audit(db, c, 'hrms_pay_runs', id, 'UPDATE', { status: r.status }, { status: 'CALCULATED', reopened: true, reason, payslipsWithdrawn: Number(w.n) }, requestId);
  return readRun(db, c, id, { audited: false });
}

/* ══ payslips ════════════════════════════════════════════════════════════ */

export async function payslipRow(db, c, id, { employeeId = null } = {}) {
  const [[p]] = await db.query(
    `SELECT * FROM hrms_pay_payslips WHERE company_id = ? AND id = ? AND deleted_at IS NULL${employeeId ? ' AND employee_id = ? AND status = \'RELEASED\'' : ''}`,
    [c.companyId, id, ...(employeeId ? [employeeId] : [])]);
  if (!p) throw notFound('That payslip');
  return { ...p, snapshot: json(p.snapshot_json, {}) };
}

/** GET /user/me/payslips — my released payslips, newest first. */
export async function myPayslips(db, c, employeeId) {
  const [rows] = await db.query(
    `SELECT id, period_month, net_pay, released_at, version FROM hrms_pay_payslips WHERE company_id = ? AND employee_id = ? AND status = 'RELEASED' AND deleted_at IS NULL ORDER BY period_month DESC, version DESC`,
    [c.companyId, employeeId]);
  return { payslips: rows.map((p) => ({ id: p.id, month: p.period_month, label: monthBounds(p.period_month).label, net: money(p.net_pay), releasedAt: stamp(p.released_at) })) };
}

/** HR: the payslips of a run (their net pay: audited like any read of pay). */
export async function runPayslips(db, c, runId, requestId = null) {
  const r = await runRow(db, c.companyId, runId);
  const [rows] = await db.query(
    `SELECT s.id, s.employee_id, s.status, s.version, s.net_pay, s.released_at, e.employee_code, e.full_name FROM hrms_pay_payslips s JOIN hrms_employees e ON e.company_id = s.company_id AND e.id = s.employee_id
      WHERE s.company_id = ? AND s.run_id = ? AND s.deleted_at IS NULL ORDER BY s.status, e.full_name`, [c.companyId, runId]);
  if (rows.length) await auditSalaryRead(db, c, rows.map((s) => s.employee_id), `payslips of payroll ${r.period_month}`, requestId);
  return { payslips: rows.map((s) => ({ id: s.id, employee: { id: s.employee_id, code: s.employee_code, name: s.full_name }, status: s.status, version: s.version, net: money(s.net_pay), releasedAt: stamp(s.released_at) })) };
}

export { FROZEN, OPEN, shapeRun, runRow };
