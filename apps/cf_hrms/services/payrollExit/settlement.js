/**
 * settlement.js — the full and final settlement of a person who leaves. (TM/CF_HRMS_HIRING_SPEC.md §25.5, §4.)
 *
 * WHAT IT HOLDS (worked out from the leaving record, the salary on the last day, the leave policy and the
 * year's rules `final_settlement`, `exempt_gratuity`, `exempt_leave_encashment`; HR types what the system
 * cannot know):
 *   last month's salary   the exit month prorated to the last working day — the RUN pays it (exit_date is set
 *                         when the leaving is closed); the statement shows the run's figures once it is
 *                         calculated, before that an estimate (structure, unpaid leave; no attendance, no TDS)
 *   notice pay            the notice period from the appointment terms (hrms_hirings: probation / confirmed
 *                         days), else the days HR types; days short = period − days from the notice date to the
 *                         last day; RESIGNED → recovered (NOTICE_REC), REMOVED → paid (NOTICE_PAY); HR may waive.
 *                         A day = the policy's notice formula (default GROSS ÷ 30)
 *   leave encashment      the encashable leave types of the person's policy (§22: `encashable`, at most
 *                         `encashCapDays`), the balance on the last day × the policy's day rate (default BASIC ÷
 *                         26) — LEAVE_ENC; the exemption formula (10 months' average salary; the leave at most
 *                         30 days a completed year) goes to the tax engine, which takes the least with the cap
 *   gratuity              at `eligibleYears` (5) completed years; 15/26 × the last month's Basic + DA × years,
 *                         a part year of more than six months a year; at most the Act's ceiling. HR may pay a
 *                         different amount (with a note); the exemption still uses the formula — GRATUITY
 *   bonus                 typed (BONUS);   flexible balance  the unclaimed flexible benefits for the months
 *                         worked (FLEXI_PAY, taxed), when the policy pays them
 *   recoveries            typed: a loan (LOAN), an asset, anything else (OTHER_DED)
 *   claims                approved claims not paid yet pay in the same run; claims still waiting are listed
 *   TDS                   the tax engine on the month it pays in (the exit month's lines + these), months left
 *                         = 1, with the gratuity and leave exemptions — an estimate here, the run deducts it
 *
 * STATUS  DRAFT (worked out again on every read and save) → APPROVED (frozen: result_json; needs the leaving
 * CLOSED, no problems; pays in `pay_month` = the exit month, or the first month after the last locked run) →
 * PAID (the run that took it was marked paid). Back from APPROVED to DRAFT while its run is not locked.
 * HR never approves their own. The person sees an APPROVED / PAID statement in My pay.
 *
 * THE RUN: calculateRun reads APPROVED settlements of its month (runHooks.js) and adds their items as lines of
 * source SETTLEMENT — the exit month's run already pays the last salary. A settlement paid in a month after the
 * person left makes them a "settlement only" person in that run: no salary, no PT, no LWF. A separate run kind
 * was not made: one run per month keeps the months-in-order rule, the bank file, the payment record, the TDS
 * months and Form 16 / 24Q as they are.
 */
import { HrmsError } from '../../lib/errors.js';
import { audit, bad, refuse, text, money, stamp, json, readAmount, dateText, today, longDate, loadComponents, loadStructures, shapeSalary, SALARY_COLUMNS, statutoryOn, companySettings, identifiersOf, mask } from '../payroll/common.js';
import { statesOf } from '../law/personLaw.js';
import { salaryBreakdown, auditSalaryRead } from '../payroll/payrollService.js';
import { monthBounds, monthDays, lopFromRequests, addDays } from '../payroll/proration.js';
import { computePerson } from '../payroll/calc.js';
import { loadRules, yearOfDate } from '../payrollTax/common.js';
import { loadTaxWorld, personTax, monthFromLines } from '../payrollTax/runTax.js';
import { loadWorlds, balancesOf } from '../leave/requestService.js';
import { leaveYearOf } from '../leave/balance.js';
import { exitsForEmployees } from '../exitRead.js';
import { policyOf, formulaValues, rateOf } from './policy.js';
import { serviceLength, gratuity as gratuityOf, encashmentExemptFormula, notice as noticeOf, servedDays } from './fnfMath.js';
import { assertNotOwn, nextPayMonth, loadTypes } from './claims.js';

const r0 = (v) => Math.round(Number(v) || 0);
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const FROZEN = ['LOCKED', 'RELEASED', 'PAID'];
const STATUS_WORDS = { DRAFT: 'Draft', APPROVED: 'Approved — pays with the payroll', PAID: 'Paid' };

/** The leaving record a settlement is for: the OPEN one, or the latest CLOSED one. */
async function exitOf(db, companyId, employeeId) {
  const [[x]] = await db.query(
    `SELECT * FROM hrms_employee_exits WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL AND status IN ('OPEN','CLOSED')
      ORDER BY (status = 'OPEN') DESC, closed_on DESC, id DESC LIMIT 1`, [companyId, employeeId]);
  return x ?? null;
}

async function settlementRow(db, companyId, { id = null, employeeId = null } = {}) {
  const [[r]] = await db.query(`SELECT * FROM hrms_pay_settlements WHERE company_id = ? AND deleted_at IS NULL AND ${id ? 'id = ?' : 'employee_id = ?'}`, [companyId, id ?? employeeId]);
  return r ?? null;
}

/** HR's typed inputs, cleaned. Throws 422 with every problem. */
export function readInputs(body = {}) {
  const problems = [];
  const out = {};
  const days = (k, label, max = 365) => {
    if (body[k] === undefined || body[k] === null || body[k] === '') return null;
    const v = Number(body[k]);
    if (!Number.isFinite(v) || v < 0 || v > max) { problems.push(`${label}: a number of days from 0 to ${max}.`); return null; }
    return Math.round(v * 100) / 100;
  };
  out.noticeDays = days('noticeDays', 'Notice period');
  out.waiveNotice = Boolean(body.waiveNotice);
  out.waiveNote = text(body.waiveNote, 300);
  if (out.waiveNotice && !out.waiveNote) problems.push('Waived notice: say why (it is kept with the settlement).');
  out.encashDays = days('encashDays', 'Leave days to encash', 1000);
  out.gratuityAmount = body.gratuityAmount === undefined || body.gratuityAmount === null || body.gratuityAmount === '' ? null : readAmount(body.gratuityAmount, 'Gratuity paid', problems);
  out.gratuityNote = text(body.gratuityNote, 300);
  if (out.gratuityAmount != null && !out.gratuityNote) problems.push('Gratuity paid: say why it differs from the worked-out amount.');
  out.gratuityExemptedBefore = body.gratuityExemptedBefore ? readAmount(body.gratuityExemptedBefore, 'Gratuity exempted before', problems) : 0;
  out.leaveExemptedBefore = body.leaveExemptedBefore ? readAmount(body.leaveExemptedBefore, 'Leave encashment exempted before', problems) : 0;
  const list = (k, label, kinds) => (Array.isArray(body[k]) ? body[k] : []).slice(0, 20).map((x, i) => {
    const amount = readAmount(x?.amount, `${label} ${i + 1}`, problems);
    const kind = kinds ? String(x?.kind ?? 'OTHER').toUpperCase() : null;
    if (kinds && !kinds.includes(kind)) problems.push(`${label} ${i + 1}: ${kinds.join(', ')}.`);
    const lbl = text(x?.label, 120);
    if (!lbl) problems.push(`${label} ${i + 1}: say what it is.`);
    return { ...(kinds ? { kind } : {}), label: lbl, amount };
  }).filter((x) => x.amount);
  out.bonus = list('bonus', 'Bonus', null);
  out.recoveries = list('recoveries', 'Recovery', ['LOAN', 'ASSET', 'OTHER']);
  out.note = text(body.note, 1000);
  if (problems.length) throw bad('The settlement cannot be worked out yet.', problems);
  return out;
}

/** The average of Basic + DA a month over the `months` months before the last day (the salary in force at each month end). */
function averageSalary(salaries, structs, comps, lastDay, months, vars) {
  const ends = [];
  let m = lastDay.slice(0, 7);
  for (let i = 0; i < months; i += 1) { ends.push(m); const b = monthBounds(m); m = addDays(b.from, -1).slice(0, 7); }
  const values = [];
  for (const mm of ends) {
    const end = mm === lastDay.slice(0, 7) ? lastDay : monthBounds(mm).to;
    const s = salaries.filter((x) => x.effectiveFrom <= end && (!x.effectiveTo || x.effectiveTo >= end)).pop();
    if (!s) continue;
    const st = structs.get(s.structureId);
    if (!st) continue;
    values.push({ s, st });
  }
  return { values, months: ends.length, vars };
}

/**
 * The statement, worked out now. Pure of writes.
 * @returns {{ ok, problems[], statement }}
 */
export async function workOut(db, c, employeeId, inputs = {}) {
  const problems = [];
  const notes = [];
  const [[e]] = await db.query('SELECT id, employee_code, full_name, date_of_joining, exit_date, employment_status FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, employeeId]);
  if (!e) throw new HrmsError(404, 'NOT_FOUND', 'That employee not found.');
  const x = await exitOf(db, c.companyId, employeeId);
  if (!x) throw refuse('NOT_LEAVING', `${e.full_name} is not leaving: start the leaving on their page first (People › Employees).`);
  const joining = dateText(e.date_of_joining);
  const lastDay = dateText(e.exit_date) ?? dateText(x.last_working_day);
  const exitMonth = lastDay.slice(0, 7);
  if (x.status !== 'CLOSED') notes.push(`On notice: the leaving is not closed yet. The settlement can be drafted; it is approved once the leaving is closed on ${longDate(dateText(x.last_working_day))} (or earlier).`);
  const year = yearOfDate(lastDay);
  const { rules, reason } = await loadRules(db, year);
  if (!rules || !rules.NEW.has('final_settlement')) throw refuse('NO_RULES', reason ?? `The rule "final_settlement" is missing for ${year}: run seed-tax-rules.mjs.`);
  const FS = rules.NEW.get('final_settlement');
  const fsSource = rules.NEW.source('final_settlement');
  const [comps, policy] = await Promise.all([loadComponents(db, c.companyId), policyOf(db, c.companyId)]);
  const [salRows] = await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL ORDER BY effective_from, id`, [c.companyId, employeeId]);
  const salaries = salRows.map(shapeSalary).filter((s) => !s.effectiveTo || s.effectiveTo >= s.effectiveFrom);
  const salary = salaries.filter((s) => s.effectiveFrom <= lastDay && (!s.effectiveTo || s.effectiveTo >= lastDay)).pop() ?? null;
  const structs = await loadStructures(db, c.companyId);
  let bd = null;
  if (!salary) problems.push(`No salary on ${longDate(lastDay)}: add it on Payroll › Salaries.`);
  else {
    bd = await salaryBreakdown(db, c, salary, { comps, structs, on: lastDay });
    if (!bd.ok) problems.push(`The salary on ${longDate(lastDay)} cannot be worked out: ${bd.problems?.[0]}`);
  }
  const lines = bd?.ok ? bd.lines : [];
  const values = formulaValues(lines, comps.byCode.keys(), { annualCtc: salary?.annualCtc ?? 0 });
  const comp = (code) => { const k = comps.byCode.get(code); if (!k || k.status === 'INACTIVE') { problems.push(`The component ${code} is missing or inactive: Payroll › Components › add the ready-made ones.`); return null; } return k; };
  const items = [];
  const item = (code, amount, label, basis) => { if (!amount) return; const k = comp(code); if (k) items.push({ code, name: k.name, kind: k.kind, amount: money(amount), label, basis }); };

  // ── service, gratuity ──
  const service = serviceLength(joining, lastDay);
  const wage = money(lines.filter((l) => l.kind === 'EARNING' && comps.byCode.get(l.code)?.inGratuityWage && (l.frequency ?? 'MONTHLY') === 'MONTHLY').reduce((s, l) => s + l.monthly, 0));
  const g = gratuityOf({ service, wage, rule: FS.gratuity });
  const gPaid = inputs.gratuityAmount != null ? inputs.gratuityAmount : g.amount;
  if (inputs.gratuityAmount != null) g.lines.push(`Paid ₹${inputs.gratuityAmount.toLocaleString('en-IN')} by HR's decision (${inputs.gratuityNote}); the tax exemption still uses the worked-out ₹${g.formulaAmount.toLocaleString('en-IN')}.`);
  item('GRATUITY', gPaid, 'Gratuity', g.lines.join(' '));

  // ── leave encashment ──
  const encash = { types: [], days: 0, rate: 0, amount: 0, formula: policy.encashRateFormula, exempt: null };
  const worlds = await loadWorlds(db, c.companyId, [employeeId], { on: lastDay });
  const w = worlds.get(employeeId);
  if (w) {
    const ly = leaveYearOf(lastDay, w.startsMonth);
    const balances = balancesOf(w, ly, lastDay);
    for (const rule of w.rules.filter((r) => r.encashable)) {
      const b = balances.find((x) => x.leaveTypeId === rule.leaveTypeId);
      const avail = Math.max(0, n(b?.available));
      const capDays = rule.encashCapDays != null ? Number(rule.encashCapDays) : null;
      const days = capDays != null ? Math.min(avail, capDays) : avail;
      encash.types.push({ leaveTypeId: rule.leaveTypeId, code: rule.leaveTypeCode, name: rule.leaveTypeName, available: avail, capDays, days });
      encash.days += days;
    }
  }
  encash.days = Math.round(encash.days * 100) / 100;
  if (inputs.encashDays != null) { encash.typed = inputs.encashDays; notes.push(`Leave days to encash typed by HR: ${inputs.encashDays} (the policy gives ${encash.days}).`); encash.days = inputs.encashDays; }
  const er = rateOf(policy.encashRateFormula, values);
  if (!er.ok && encash.days) problems.push(`Leave encashment day rate (${policy.encashRateFormula}): ${er.problem}`);
  encash.rate = er.value;
  encash.amount = r0(encash.days * encash.rate);
  if (encash.amount) {
    const avg = averageSalary(salaries, structs, comps, lastDay, FS.leaveEncashment.averageMonths);
    let sum = 0;
    for (const v of avg.values) {
      const b2 = await salaryBreakdown(db, c, v.s, { comps, structs, on: lastDay });
      sum += (b2.lines ?? []).filter((l) => ['BASIC', 'DA'].includes(l.code)).reduce((s, l) => s + l.monthly, 0);
    }
    const averageSal = avg.values.length ? money(sum / avg.values.length) : 0;
    encash.exempt = encashmentExemptFormula({ days: encash.days, completedYears: service.years, averageSalary: averageSal, rule: FS.leaveEncashment });
    encash.exempt.averageSalary = averageSal;
    if (avg.values.length < avg.months) encash.exempt.lines.push(`Average of the ${avg.values.length} month(s) with a salary here (of ${avg.months}).`);
    encash.exempt.lines.push('The leave the person earned at most 30 days a year less what they took is not kept here: the days paid out are used — ask your CA.');
  }
  item('LEAVE_ENC', encash.amount, 'Leave encashment', `${encash.days} day(s) × ₹${encash.rate.toLocaleString('en-IN')} a day (${policy.encashRateFormula})`);

  // ── notice ──
  const [[hiring]] = await db.query(
    `SELECT notice_days_probation, notice_days_confirmed, probation_months, joining_date FROM hrms_hirings WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [c.companyId, employeeId]).catch(() => [[null]]);
  let required = null;
  let source = null;
  if (inputs.noticeDays != null) { required = inputs.noticeDays; source = 'TYPED'; } else if (hiring) {
    const inProbation = service.totalMonths < Number(hiring.probation_months ?? 0);
    required = Number(inProbation ? hiring.notice_days_probation : hiring.notice_days_confirmed);
    source = inProbation ? 'APPOINTMENT_PROBATION' : 'APPOINTMENT';
  }
  const served = servedDays(dateText(x.notice_date), lastDay);
  const nr = rateOf(policy.noticeRateFormula, values);
  let notice = { requiredDays: required, servedDays: served, source, shortDays: 0, action: 'NONE', amount: 0, line: null, dayRate: nr.value, formula: policy.noticeRateFormula };
  if (required == null) problems.push('Notice period: the appointment terms do not record it — type the notice days.');
  else {
    if (!nr.ok) problems.push(`Notice pay day rate (${policy.noticeRateFormula}): ${nr.problem}`);
    const nt = noticeOf({ requiredDays: required, servedDays: served, exitType: x.exit_type, waived: inputs.waiveNotice, dayRate: nr.value });
    notice = { ...notice, ...nt, waiveNote: inputs.waiveNotice ? inputs.waiveNote : null };
    if (nt.action === 'PAY') item('NOTICE_PAY', nt.amount, 'Notice pay', nt.line);
    if (nt.action === 'RECOVER') item('NOTICE_REC', nt.amount, 'Notice pay recovery', nt.line);
  }

  // ── bonus, flexible balance, recoveries ──
  for (const b of inputs.bonus ?? []) item('BONUS', b.amount, b.label, 'typed by HR');
  if (policy.flexiYearEnd === 'PAY_TAXABLE') {
    const types = (await loadTypes(db, c.companyId)).filter((t) => t.flexible && t.yearlyLimit != null && t.status === 'ACTIVE');
    if (types.length) {
      const y1 = Number(year.slice(0, 4));
      const first = `${y1}-04-01`;
      const from = joining > first ? joining : first;
      const months = (Number(lastDay.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(lastDay.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
      const [used] = await db.query("SELECT claim_type_id, SUM(COALESCE(approved_amount, amount)) AS t FROM hrms_pay_claims WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND deleted_at IS NULL AND status IN ('SUBMITTED','RECOMMENDED','APPROVED','PAID') GROUP BY claim_type_id", [c.companyId, employeeId, year]);
      const u = new Map(used.map((r) => [r.claim_type_id, Number(r.t)]));
      for (const t of types) {
        const entitled = money(t.yearlyLimit * Math.max(0, months) / 12);
        const bal = money(entitled - (u.get(t.id) ?? 0));
        if (bal > 0) item('FLEXI_PAY', bal, `${t.name} not claimed`, `₹${entitled.toLocaleString('en-IN')} for ${months} month(s) of ${year} less ₹${(u.get(t.id) ?? 0).toLocaleString('en-IN')} claimed — paid, taxed (company policy)`);
      }
    }
  }
  for (const r of inputs.recoveries ?? []) item(r.kind === 'LOAN' ? 'LOAN' : 'OTHER_DED', r.amount, r.label, `recovery (${r.kind.toLowerCase()}) typed by HR`);

  // ── claims ──
  const [claimRows] = await db.query(
    `SELECT cl.id, cl.status, cl.amount, cl.approved_amount, t.name FROM hrms_pay_claims cl JOIN hrms_pay_claim_types t ON t.company_id = cl.company_id AND t.id = cl.claim_type_id
      WHERE cl.company_id = ? AND cl.employee_id = ? AND cl.deleted_at IS NULL AND cl.status IN ('SUBMITTED','RECOMMENDED','APPROVED') ORDER BY cl.id`, [c.companyId, employeeId]);
  const claims = {
    approved: claimRows.filter((r) => r.status === 'APPROVED').map((r) => ({ id: r.id, name: r.name, amount: money(r.approved_amount) })),
    waiting: claimRows.filter((r) => r.status !== 'APPROVED').map((r) => ({ id: r.id, name: r.name, amount: money(r.amount) })),
  };
  if (claims.waiting.length) notes.push(`${claims.waiting.length} claim(s) still wait for a decision (Payroll › Claims): decide them before approving, or they are left out.`);

  // ── the month it pays in, the last month's salary ──
  const payMonth = await nextPayMonth(db, c.companyId, exitMonth);
  const [[run]] = await db.query('SELECT id, status, period_month FROM hrms_pay_runs WHERE company_id = ? AND period_month = ? AND deleted_at IS NULL', [c.companyId, exitMonth]);
  let lastMonth = null;
  if (run) {
    const [[p]] = await db.query('SELECT id, gross, deductions, net_pay, payable_days, days_in_month, lop_days, tds_amount, included FROM hrms_pay_run_people WHERE company_id = ? AND run_id = ? AND employee_id = ? AND deleted_at IS NULL', [c.companyId, run.id, employeeId]);
    if (p && p.included) {
      const [ls] = await db.query(`SELECT l.amount, l.kind, l.source, k.code, k.name FROM hrms_pay_run_lines l JOIN hrms_pay_components k ON k.company_id = l.company_id AND k.id = l.component_id
         WHERE l.company_id = ? AND l.run_person_id = ? AND l.deleted_at IS NULL`, [c.companyId, p.id]);
      const own = ls.filter((l) => l.source !== 'SETTLEMENT');
      const sum = (kind) => money(own.filter((l) => l.kind === kind).reduce((s, l) => s + Number(l.amount), 0));
      lastMonth = {
        how: FROZEN.includes(run.status) ? 'RUN_LOCKED' : 'RUN', runStatus: run.status, month: exitMonth, label: monthBounds(exitMonth).label,
        payableDays: Number(p.payable_days), daysInMonth: Number(p.days_in_month), lopDays: Number(p.lop_days),
        gross: sum('EARNING'), reimbursements: sum('REIMBURSEMENT'), deductions: money(sum('DEDUCTION') - money(own.filter((l) => l.code === 'TDS' || l.source === 'TDS').reduce((s, l) => s + Number(l.amount), 0))),
        lines: own.filter((l) => l.source !== 'TDS').map((l) => ({ code: l.code, name: l.name, kind: l.kind, amount: money(l.amount) })),
      };
      lastMonth.net = money(lastMonth.gross + lastMonth.reimbursements - lastMonth.deductions);
    }
  }
  if (!lastMonth && salary && bd?.ok && joining <= lastDay) {
    const b = monthBounds(exitMonth);
    const [lv] = await db.query(
      `SELECT r.status, r.from_date, r.to_date, r.half_day, r.days_json, t.is_paid FROM hrms_leave_requests r JOIN hrms_leave_types t ON t.company_id = r.company_id AND t.id = r.leave_type_id
        WHERE r.company_id = ? AND r.employee_id = ? AND r.deleted_at IS NULL AND r.status = 'APPROVED' AND t.is_paid = 0 AND r.from_date <= ? AND r.to_date >= ?`, [c.companyId, employeeId, b.to, b.from]);
    const lop = lopFromRequests(lv.map((r) => ({ status: r.status, isPaid: Boolean(r.is_paid), daysJson: r.days_json, from: dateText(r.from_date), to: dateText(r.to_date), halfDay: r.half_day })));
    const days = monthDays({ month: exitMonth, joiningDate: joining, exitDate: lastDay, salaries, lopDays: lop });
    for (const seg of days.segments) seg.amounts = Object.fromEntries(((await salaryBreakdown(db, c, seg.salary, { comps, structs, on: b.from })).lines ?? []).map((l) => [l.code, l.monthly]));
    const settings = await companySettings(db, c.companyId);
    const S = await statutoryOn(db, c.companyId, b.from, salary.stateCode ?? (await statesOf(db, c.companyId, [employeeId], lastDay)).get(Number(employeeId)) ?? settings.stateCode);
    const calc = computePerson({ month: exitMonth, days, components: comps.byCode, oneTime: [], arrears: [], pfMode: salary.pfMode, esiCovered: false, settings: S, tds: 0 });
    lastMonth = {
      how: 'ESTIMATE', month: exitMonth, label: b.label, payableDays: days.payableDays, daysInMonth: days.daysInMonth, lopDays: days.lopDays,
      gross: calc.gross, reimbursements: calc.reimbursements, deductions: calc.deductions, net: calc.netPay,
      lines: calc.lines.map((l) => ({ code: l.code, name: l.name, kind: l.kind, amount: l.amount })),
      note: 'An estimate from the salary and approved unpaid leave (no attendance, ESI not counted, no TDS); the payroll of the month works out the exact pay.',
    };
  }
  if (payMonth !== exitMonth) notes.push(`${monthBounds(exitMonth).label} is locked: the settlement pays in the ${monthBounds(payMonth).label} payroll, on its own (no salary, no professional tax).`);

  // ── totals, TDS ──
  const earn = money(items.filter((i) => i.kind === 'EARNING' || i.kind === 'REIMBURSEMENT').reduce((s, i) => s + i.amount, 0));
  const ded = money(items.filter((i) => i.kind === 'DEDUCTION').reduce((s, i) => s + i.amount, 0));
  const claimsTotal = money(claims.approved.reduce((s, x) => s + x.amount, 0));
  const tax = { gratuityFormula: g.formulaAmount, gratuityExemptedBefore: n(inputs.gratuityExemptedBefore), leaveFormula: encash.exempt?.formulaAmount ?? 0, leaveExemptedBefore: n(inputs.leaveExemptedBefore) };
  let tds = null;
  try {
    const world = await loadTaxWorld(db, c.companyId, payMonth, [employeeId]);
    if (world.rules) {
      if (world.extras) world.extras.settlements.set(employeeId, tax);
      const sameMonth = payMonth === exitMonth && lastMonth;
      const base = sameMonth ? lastMonth.lines.map((l) => ({ ...l, comp: comps.byCode.get(l.code), source: 'STRUCTURE' })) : [];
      const extra = items.map((i) => ({ ...i, comp: comps.byCode.get(i.code), source: 'SETTLEMENT' }));
      const current = monthFromLines([...base, ...extra]);
      const t = await personTax(world, employeeId, { current });
      if (t?.available) {
        const k = t.projections[t.regime].computation;
        tds = {
          amount: t.tds, regime: t.regime, yearTax: t.yearTax, tdsSoFar: t.tdsSoFar, monthsLeft: t.monthsLeft, month: payMonth,
          exemptions: (k.exemptions ?? []).filter((x) => ['exempt_gratuity', 'exempt_leave_encashment'].includes(x.key)).map((x) => ({ label: x.label, section: x.section, received: x.received, exempt: x.exempt })),
          note: `The tax engine on ${monthBounds(payMonth).label}: the year's tax ₹${Number(t.yearTax).toLocaleString('en-IN')} less ₹${Number(t.tdsSoFar).toLocaleString('en-IN')} deducted, ${t.monthsLeft === 1 ? 'all of it this month (the last month)' : `÷ ${t.monthsLeft}`}. The payroll deducts it.`,
        };
      }
    }
  } catch (err) {
    notes.push(`The TDS could not be worked out here: ${err.message}`);
  }
  const lastNet = lastMonth ? (payMonth === exitMonth ? lastMonth.net : 0) : 0;
  const statement = {
    version: 1, workedOutAt: new Date().toISOString(),
    employee: { id: e.id, code: e.employee_code, name: e.full_name, joiningDate: joining, status: e.employment_status },
    exit: { id: x.id, type: x.exit_type, reasonCode: x.reason_code, status: x.status, noticeDate: dateText(x.notice_date), lastWorkingDay: lastDay },
    year, service, payMonth, payMonthLabel: monthBounds(payMonth).label, exitMonth,
    salary: salary ? { id: salary.id, annualCtc: salary.annualCtc, monthlyCtc: salary.monthlyCtc, effectiveFrom: salary.effectiveFrom } : null,
    lastMonth, gratuity: { ...g, wage, paid: gPaid, typed: inputs.gratuityAmount != null },
    encashment: encash, notice, claims, items,
    totals: { earnings: earn, deductions: ded, settlement: money(earn - ded), claims: claimsTotal, lastMonthNet: lastNet, tds: tds?.amount ?? 0, net: money(lastNet + earn - ded + claimsTotal - (tds?.amount ?? 0)) },
    tds, tax, policy: { encashRateFormula: policy.encashRateFormula, noticeRateFormula: policy.noticeRateFormula },
    rule: { year, key: 'final_settlement', verified: fsSource.verified, source: fsSource.note, url: fsSource.url, notApplied: FS.gratuity.notApplied },
    notes, problems, inputs,
  };
  statement.problems = [...new Set(problems)];
  return { ok: !problems.length, problems: statement.problems, statement };
}

const shape = (r, statement = null) => ({
  id: r.id, employeeId: r.employee_id, exitId: r.exit_id, lastDay: dateText(r.last_day), status: r.status, statusWords: STATUS_WORDS[r.status] ?? r.status,
  payMonth: r.pay_month ?? null, payMonthLabel: r.pay_month ? monthBounds(r.pay_month).label : null, runId: r.run_id ?? null,
  netAmount: money(r.net_amount), approvedAt: stamp(r.approved_at), paidAt: stamp(r.paid_at), note: r.note ?? null, inputs: json(r.inputs_json, {}) ?? {},
  statement: statement ?? json(r.result_json, null), updatedAt: stamp(r.updated_at),
});

/** GET /payroll/settlements — people leaving or left (this tax year and the last), with their settlement. Audited. */
export async function listSettlements(db, c, query = {}, requestId = null) {
  const since = `${Number(today().slice(0, 4)) - 1}-04-01`;
  const [rows] = await db.query(
    `SELECT e.id, e.employee_code, e.full_name, e.employment_status, e.exit_date, s.id AS sid, s.status AS s_status, s.pay_month, s.net_amount, s.updated_at AS s_updated
       FROM hrms_employees e LEFT JOIN hrms_pay_settlements s ON s.company_id = e.company_id AND s.employee_id = e.id AND s.deleted_at IS NULL
      WHERE e.company_id = ? AND e.deleted_at IS NULL AND (e.employment_status = 'NOTICE' OR (e.employment_status = 'EXITED' AND e.exit_date >= ?) OR s.id IS NOT NULL)
      ORDER BY (s.status = 'DRAFT') DESC, e.exit_date IS NULL DESC, e.exit_date DESC, e.full_name`, [c.companyId, since]);
  const exits = await exitsForEmployees(db, c.companyId, rows.map((r) => r.id));
  const q = String(query.q ?? '').trim().toLowerCase();
  const people = rows.filter((r) => !q || `${r.full_name} ${r.employee_code}`.toLowerCase().includes(q)).map((r) => ({
    employee: { id: r.id, code: r.employee_code, name: r.full_name, status: r.employment_status }, exit: exits.get(r.id) ?? null,
    settlement: r.sid ? { id: r.sid, status: r.s_status, statusWords: STATUS_WORDS[r.s_status], payMonth: r.pay_month, payMonthLabel: r.pay_month ? monthBounds(r.pay_month).label : null, netAmount: money(r.net_amount), updatedAt: stamp(r.s_updated) } : null,
  }));
  const withAmount = people.filter((p) => p.settlement).map((p) => p.employee.id);
  if (withAmount.length) await auditSalaryRead(db, c, withAmount, 'full and final settlements', requestId);
  return { people, counts: { leaving: people.filter((p) => p.employee.status === 'NOTICE').length, drafts: people.filter((p) => p.settlement?.status === 'DRAFT').length, approved: people.filter((p) => p.settlement?.status === 'APPROVED').length } };
}

/** GET /payroll/settlements/employees/:employeeId — the saved settlement (a DRAFT worked out again), or a fresh working. Audited. */
export async function readSettlement(db, c, employeeId, requestId = null) {
  const r = await settlementRow(db, c.companyId, { employeeId });
  await auditSalaryRead(db, c, [employeeId], 'full and final settlement', requestId);
  if (r && r.status !== 'DRAFT') return { settlement: shape(r), fresh: null };
  const w = await workOut(db, c, employeeId, json(r?.inputs_json, {}) ?? {});
  return { settlement: r ? shape(r, w.statement) : null, fresh: w };
}

/** POST /payroll/settlements/employees/:employeeId/preview { inputs } — writes nothing. */
export async function previewSettlement(db, c, employeeId, body = {}) {
  return workOut(db, c, employeeId, readInputs(body));
}

/** PUT /payroll/settlements/employees/:employeeId { inputs } — save the DRAFT (made when there is none). */
export async function saveDraft(db, c, employeeId, body = {}, requestId = null) {
  const inputs = readInputs(body);
  const w = await workOut(db, c, employeeId, inputs);
  const r = await settlementRow(db, c.companyId, { employeeId });
  if (r && r.status !== 'DRAFT') throw refuse('WRONG_STATUS', `The settlement is ${STATUS_WORDS[r.status].toLowerCase()}: take the approval back first.`);
  const s = w.statement;
  if (r) {
    await db.query('UPDATE hrms_pay_settlements SET inputs_json = ?, result_json = ?, net_amount = ?, last_day = ?, exit_id = ?, note = ? WHERE id = ?',
      [JSON.stringify(inputs), JSON.stringify(s), s.totals.settlement, s.exit.lastWorkingDay, s.exit.id, inputs.note, r.id]);
    await audit(db, c, 'hrms_pay_settlements', r.id, 'UPDATE', { inputs: json(r.inputs_json, {}) }, { inputs, net: s.totals.settlement }, requestId);
  } else {
    const [ins] = await db.query('INSERT INTO hrms_pay_settlements (company_id, employee_id, exit_id, last_day, status, inputs_json, result_json, net_amount, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [c.companyId, employeeId, s.exit.id, s.exit.lastWorkingDay, 'DRAFT', JSON.stringify(inputs), JSON.stringify(s), s.totals.settlement, inputs.note, c.userId]);
    await audit(db, c, 'hrms_pay_settlements', ins.insertId, 'CREATE', null, { employeeId, inputs, net: s.totals.settlement }, requestId);
  }
  return readSettlement(db, c, employeeId, requestId);
}

/** POST /payroll/settlements/:id/approve — frozen; pays in the next open month. */
export async function approveSettlement(db, c, id, requestId = null) {
  const r = await settlementRow(db, c.companyId, { id });
  if (!r) throw new HrmsError(404, 'NOT_FOUND', 'That settlement not found.');
  await assertNotOwn(db, c, r.employee_id, 'full and final settlement');
  if (r.status !== 'DRAFT') throw refuse('WRONG_STATUS', `The settlement is ${STATUS_WORDS[r.status].toLowerCase()} already.`);
  const w = await workOut(db, c, r.employee_id, json(r.inputs_json, {}) ?? {});
  if (w.statement.exit.status !== 'CLOSED') throw refuse('NOT_CLOSED', `Close the leaving first (the person's page: "End notice and close employee") — until then the payroll pays them a full month.`);
  if (!w.ok) throw refuse('PROBLEMS', `The settlement cannot be approved yet: ${w.problems[0]}`, { problems: w.problems });
  const s = w.statement;
  await db.query("UPDATE hrms_pay_settlements SET status = 'APPROVED', result_json = ?, net_amount = ?, pay_month = ?, run_id = NULL, approved_at = NOW(), approved_by = ? WHERE id = ?",
    [JSON.stringify(s), s.totals.settlement, s.payMonth, c.userId, id]);
  // Approved claims not paid yet pay with it, in the same run.
  if (s.claims.approved.length) await db.query("UPDATE hrms_pay_claims SET pay_month = ? WHERE company_id = ? AND id IN (?) AND status = 'APPROVED' AND (pay_month IS NULL OR pay_month > ?)", [s.payMonth, c.companyId, s.claims.approved.map((x) => x.id), s.payMonth]);
  await audit(db, c, 'hrms_pay_settlements', id, 'APPROVE', { status: 'DRAFT' }, { status: 'APPROVED', payMonth: s.payMonth, net: s.totals.settlement, items: s.items.map((i) => `${i.code} ${i.amount}`) }, requestId);
  return readSettlement(db, c, r.employee_id, requestId);
}

/** POST /payroll/settlements/:id/unapprove — back to DRAFT while its run is not locked. */
export async function unapproveSettlement(db, c, id, body = {}, requestId = null) {
  const r = await settlementRow(db, c.companyId, { id });
  if (!r) throw new HrmsError(404, 'NOT_FOUND', 'That settlement not found.');
  await assertNotOwn(db, c, r.employee_id, 'full and final settlement');
  if (r.status !== 'APPROVED') throw refuse('WRONG_STATUS', 'Only an approved settlement that is not paid can be taken back.');
  if (r.run_id) {
    const [[run]] = await db.query('SELECT status, period_month FROM hrms_pay_runs WHERE company_id = ? AND id = ?', [c.companyId, r.run_id]);
    if (run && FROZEN.includes(run.status)) throw refuse('IN_LOCKED_RUN', `The ${monthBounds(run.period_month).label} payroll pays it and is locked. The Owner re-opens the payroll first.`);
  }
  await db.query("UPDATE hrms_pay_settlements SET status = 'DRAFT', pay_month = NULL, run_id = NULL, approved_at = NULL, approved_by = NULL WHERE id = ?", [id]);
  await audit(db, c, 'hrms_pay_settlements', id, 'UPDATE', { status: 'APPROVED' }, { status: 'DRAFT', why: text(body.note, 300) }, requestId);
  return readSettlement(db, c, r.employee_id, requestId);
}

export async function deleteSettlement(db, c, id, requestId = null) {
  const r = await settlementRow(db, c.companyId, { id });
  if (!r) throw new HrmsError(404, 'NOT_FOUND', 'That settlement not found.');
  if (r.status !== 'DRAFT') throw refuse('WRONG_STATUS', 'Only a draft settlement is removed.');
  await db.query('UPDATE hrms_pay_settlements SET deleted_at = NOW() WHERE id = ?', [id]);
  await audit(db, c, 'hrms_pay_settlements', id, 'DELETE', { employeeId: r.employee_id }, null, requestId);
  return { ok: true };
}

/** GET /user/me/settlement — my APPROVED or PAID statement (null otherwise). */
export async function mySettlement(db, c, employeeId) {
  const r = await settlementRow(db, c.companyId, { employeeId });
  if (!r || r.status === 'DRAFT') return { settlement: null };
  const s = shape(r);
  return { settlement: { id: s.id, status: s.status, statusWords: s.statusWords, payMonth: s.payMonth, payMonthLabel: s.payMonthLabel, approvedAt: s.approvedAt, paidAt: s.paidAt, statement: s.statement } };
}

/** The statement a PDF prints: { statement, company, employee extras }. */
export async function pdfData(db, c, { id = null, employeeId = null, mine = false }) {
  const r = await settlementRow(db, c.companyId, { id, employeeId });
  if (!r || (mine && r.status === 'DRAFT')) throw new HrmsError(404, 'NOT_FOUND', 'That settlement not found.');
  let statement = json(r.result_json, null);
  if (r.status === 'DRAFT') statement = (await workOut(db, c, r.employee_id, json(r.inputs_json, {}) ?? {})).statement;
  const [[company]] = await db.query('SELECT name FROM companies WHERE id = ?', [c.companyId]);
  const [[hs]] = await db.query('SELECT company_legal_name, place_of_posting FROM hrms_hiring_settings WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const ids = await identifiersOf(db, c.companyId, [r.employee_id]);
  const id8 = ids.get(r.employee_id) ?? {};
  return {
    status: r.status, statement,
    company: { name: company?.name ?? '', legalName: hs?.company_legal_name ?? company?.name ?? '', place: hs?.place_of_posting ?? null },
    pan: mask(id8.pan), bankAccount: mask(id8.account), employeeId: r.employee_id,
  };
}

/* ── the run ── */

/** Approved settlements a run of `month` pays: Map<employeeId, { id, items: [{ code, amount, basis, source }] }>. */
export async function settlementsForRun(db, companyId, month, runId) {
  const [rows] = await db.query(
    "SELECT id, employee_id, result_json FROM hrms_pay_settlements WHERE company_id = ? AND deleted_at IS NULL AND status = 'APPROVED' AND pay_month <= ? AND (run_id IS NULL OR run_id = ?)",
    [companyId, month, runId]);
  const out = new Map();
  for (const r of rows) {
    const s = json(r.result_json, {}) ?? {};
    out.set(r.employee_id, { id: r.id, exitMonth: s.exitMonth, items: (s.items ?? []).map((i) => ({ code: i.code, amount: i.amount, basis: `full and final: ${i.label}${i.basis ? ` — ${String(i.basis).slice(0, 200)}` : ''}`, source: 'SETTLEMENT' })) });
  }
  return out;
}

export default { workOut, readInputs, listSettlements, readSettlement, previewSettlement, saveDraft, approveSettlement, unapproveSettlement, deleteSettlement, mySettlement, pdfData, settlementsForRun };
