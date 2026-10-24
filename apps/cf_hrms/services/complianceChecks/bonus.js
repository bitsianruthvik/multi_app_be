/**
 * bonus.js — THE STATUTORY BONUS RUN of an accounting year (Code on Wages, 2019, Chapter IV ss.26–41,
 * in force 21-11-2025; the rules from C1's law layer, domain BONUS).
 *
 *   eligibility    wages not above the eligibility ceiling (BONUS eligibility.wageCeilingMonthly, ₹21,000 —
 *                  UNVERIFIED) and at least 30 days worked in the year (eligibility.minDaysWorked). A month
 *                  whose full-month wages are above the ceiling is not counted (the person is not an
 *                  "employee" for bonus in it).
 *   days worked    the payable days of the year's LOCKED runs — and when attendance is live, a run's payable
 *                  days are the closed attendance month's (present + paid leave; spec §28.6), so this is
 *                  attendance-based then.
 *   wages          Code on Wages s.2(y) wages of each month (basic + DA + retaining + the 50% add-back),
 *                  from the run's structure lines (checks.js wagesOf).
 *   calculation    on min(wages, ceiling × days paid ÷ days) a month, where the ceiling is the higher of
 *                  ₹7,000 and the minimum wage of the person's place (BONUS calculation_ceiling, S.O. 4710(E)).
 *   rate           the company's choice (law choices bonusRate), within BONUS rates (8.33 % … 20 %);
 *                  at least ₹100 (s.26(1)) for an eligible person.
 *   set-on/off     with the allocable surplus entered: above the 20 % maximum → set on (capped at 20 % of the
 *                  year's salary), below the 8.33 % minimum → set off; carried up to the 4th year (s.36).
 *   paid           through a chosen month's OPEN run as BONUS one-time items; within 8 months of the year's
 *                  end (BONUS payment_time; s.39) — later is warned, not refused.
 *
 * HR prepares (DRAFT), the Owner approves (not the preparer), then it is scheduled into a run.
 */
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { HrmsError } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { pdfBuffer } from '../render/roleJd.js';
import { getChoices } from '../law/company.js';
import * as K from './checks.js';
import { lawCache, companyState, placesOf, today, dateText } from './context.js';

const json = (v, d = null) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const money = (x) => Math.round((Number(x) || 0) * 100) / 100;
const stamp = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
const YEAR_RE = /^(\d{4})-(\d{2})$/;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function yearBounds(year) {
  const m = YEAR_RE.exec(String(year ?? ''));
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new HrmsError(422, 'INVALID', 'The bonus year is an accounting year like 2026-27.', { problems: ['Year: like 2026-27.'] });
  const y = Number(m[1]);
  return { year: String(year), from: `${y}-04-01`, to: `${y + 1}-03-31`, fromMonth: `${y}-04`, toMonth: `${y + 1}-03` };
}
const addMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10); };

/**
 * PURE: one person's bonus.
 * months: [{ month, payableDays, daysInMonth, wage, ceiling }] (ceiling: that month's calculation ceiling)
 * @returns { eligible, reason, daysWorked, wagesTotal, calcWageTotal, amount, months: [... + fullWage, counted, calcWage] }
 */
export function bonusFor({ months = [], eligibilityCeiling = null, minDays = 30, ratePct, minAmount = 100 }) {
  const out = months.map((m) => {
    const days = Number(m.daysInMonth) || 30;
    const paid = Number(m.payableDays) || 0;
    const wage = money(m.wage);
    const fullWage = paid > 0 ? money(wage * days / paid) : wage;
    const counted = paid > 0 && (eligibilityCeiling == null || fullWage <= eligibilityCeiling + 0.005);
    const cap = money(Number(m.ceiling) * paid / days);
    return { ...m, wage, fullWage, counted, calcWage: counted ? money(Math.min(wage, cap)) : 0 };
  });
  const daysWorked = money(out.reduce((s, m) => s + (Number(m.payableDays) || 0), 0));
  const counted = out.filter((m) => m.counted);
  const calcWageTotal = money(counted.reduce((s, m) => s + m.calcWage, 0));
  const wagesTotal = money(out.reduce((s, m) => s + m.wage, 0));
  let reason = null;
  if (daysWorked < minDays) reason = `Worked ${daysWorked} days in the year; at least ${minDays} are needed.`;
  else if (!counted.length) reason = `Wages above ₹${Number(eligibilityCeiling).toLocaleString('en-IN')} a month in every month: not covered by the bonus law.`;
  const eligible = !reason;
  const left = out.filter((m) => !m.counted && Number(m.payableDays) > 0).map((m) => m.month);
  if (eligible && left.length) reason = `Not counted (wages above ₹${Number(eligibilityCeiling).toLocaleString('en-IN')} a month): ${left.join(', ')}.`;
  const amount = eligible ? Math.max(minAmount, Math.round(calcWageTotal * Number(ratePct) / 100)) : 0;
  return { eligible, reason, daysWorked, wagesTotal, calcWageTotal, amount, months: out };
}

/** PURE: set-on / set-off from the allocable surplus. */
export function setOnOff({ allocableSurplus, salaryTotal, minPct = 8.33, maxPct = 20, capPct = 20 }) {
  if (allocableSurplus == null || allocableSurplus === '') return null;
  const s = Number(allocableSurplus);
  const min = money(salaryTotal * minPct / 100);
  const max = money(salaryTotal * maxPct / 100);
  return { allocableSurplus: money(s), minBonus: min, maxBonus: max, setOn: s > max ? money(Math.min(s - max, salaryTotal * capPct / 100)) : 0, setOff: s < min ? money(min - s) : 0 };
}

/* ── reads ───────────────────────────────────────────────────────────── */

async function runRow(db, companyId, id, { lock = false } = {}) {
  const [[r]] = await db.query(`SELECT * FROM hrms_bonus_runs WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, id]);
  if (!r) throw new HrmsError(404, 'NOT_FOUND', 'That bonus run was not found.');
  return r;
}

const shapeRun = (r, names = new Map(), payRun = null) => {
  const deadline = dateText(r.deadline);
  const late = Boolean(deadline && ((r.pay_month && `${r.pay_month}-28` > deadline) || (!r.pay_month && today() > deadline)));
  return {
    id: r.id, year: r.bonus_year, from: dateText(r.year_from), to: dateText(r.year_to), ratePct: Number(r.rate_pct), status: r.status,
    allocableSurplus: r.allocable_surplus == null ? null : money(r.allocable_surplus), deadline, late,
    totals: json(r.totals_json, {}), law: json(r.law_json, {}), note: r.note ?? null,
    preparedBy: r.prepared_by ? { id: r.prepared_by, name: names.get(r.prepared_by) ?? null } : null, preparedAt: stamp(r.prepared_at),
    approvedBy: r.approved_by ? { id: r.approved_by, name: names.get(r.approved_by) ?? null } : null, approvedAt: stamp(r.approved_at),
    payRunId: r.pay_run_id ?? null, payMonth: r.pay_month ?? null, scheduledAt: stamp(r.scheduled_at),
    paid: Boolean(payRun && ['LOCKED', 'RELEASED', 'PAID'].includes(payRun.status)), payRunStatus: payRun?.status ?? null,
  };
};

async function names(db, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const [u] = await db.query('SELECT id, name FROM users WHERE id IN (?)', [list]);
  return new Map(u.map((x) => [x.id, x.name]));
}

export async function listBonusRuns(db, companyId) {
  const [rows] = await db.query('SELECT * FROM hrms_bonus_runs WHERE company_id = ? AND deleted_at IS NULL ORDER BY bonus_year DESC', [companyId]);
  const n = await names(db, rows.flatMap((r) => [r.prepared_by, r.approved_by]));
  const [runs] = rows.some((r) => r.pay_run_id) ? await db.query('SELECT id, status FROM hrms_pay_runs WHERE company_id = ? AND id IN (?)', [companyId, rows.map((r) => r.pay_run_id).filter(Boolean)]) : [[]];
  const st = new Map(runs.map((r) => [r.id, r]));
  const choices = await getChoices(db, companyId);
  return { runs: rows.map((r) => shapeRun(r, n, st.get(r.pay_run_id))), ratePct: choices.bonusRate };
}

export async function readBonusRun(db, c, id) {
  const r = await runRow(db, c.companyId, id);
  const [lines] = await db.query(
    `SELECT l.*, e.employee_code, e.full_name FROM hrms_bonus_lines l JOIN hrms_employees e ON e.company_id = l.company_id AND e.id = l.employee_id
      WHERE l.company_id = ? AND l.bonus_run_id = ? AND l.deleted_at IS NULL ORDER BY l.eligible DESC, e.full_name`, [c.companyId, id]);
  const n = await names(db, [r.prepared_by, r.approved_by]);
  const [[payRun]] = r.pay_run_id ? await db.query('SELECT id, status, period_month FROM hrms_pay_runs WHERE company_id = ? AND id = ?', [c.companyId, r.pay_run_id]) : [[null]];
  const [setOn] = await db.query('SELECT bonus_year, kind, amount, carry_until_year FROM hrms_bonus_set_on_off WHERE company_id = ? AND deleted_at IS NULL ORDER BY bonus_year', [c.companyId]);
  const run = shapeRun(r, n, payRun);
  const warnings = [];
  if (run.late) warnings.push(`Paid after the legal time: the bonus of ${r.bonus_year} is due by ${run.deadline} (within 8 months of the year's end, Code on Wages s.39; extendable only by an order).`);
  if (run.law?.unverified?.length) warnings.push(`Not verified yet: ${run.law.unverified.join(', ')}. Check with your CA.`);
  return {
    run, warnings, setOnOff: setOn.map((s) => ({ year: s.bonus_year, kind: s.kind, amount: money(s.amount), carryUntil: s.carry_until_year })),
    lines: lines.map((l) => ({
      id: l.id, employee: { id: l.employee_id, code: l.employee_code, name: l.full_name }, eligible: Boolean(l.eligible), reason: l.reason, daysWorked: Number(l.days_worked),
      wagesTotal: money(l.wages_total), calcWageTotal: money(l.calc_wage_total), ceiling: l.ceiling == null ? null : money(l.ceiling), amount: money(l.amount), months: json(l.months_json, []), itemId: l.item_id ?? null,
    })),
    can: { prepare: r.status === 'DRAFT', approve: r.status === 'DRAFT' && Boolean(c.owner) && Number(r.prepared_by) !== Number(c.userId), schedule: r.status === 'APPROVED', unschedule: r.status === 'SCHEDULED' && !run.paid },
  };
}

/* ── prepare ─────────────────────────────────────────────────────────── */

export async function prepareBonus(db, c, body = {}, requestId = null) {
  const y = yearBounds(body.year);
  const [[existing]] = await db.query('SELECT * FROM hrms_bonus_runs WHERE company_id = ? AND bonus_year = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, y.year]);
  if (existing && existing.status !== 'DRAFT') throw new HrmsError(409, 'WRONG_STATUS', `The bonus of ${y.year} is ${existing.status.toLowerCase()}: it is not prepared again.`);
  const on = y.to < today() ? y.to : today();
  const state = await companyState(db, c.companyId);
  const cache = lawCache(db);
  const law = await cache.law(state, on);
  const B = law.bonus;
  if (!B.rates || !B.eligibility || !B.ceiling) throw new HrmsError(409, 'NO_LAW', 'The bonus rules are not in the law layer for that year.');
  const choices = await getChoices(db, c.companyId);
  const minPct = Number(B.rates.value.minRatePct) || 8.33;
  const maxPct = Number(B.rates.value.maxRatePct) || 20;
  const ratePct = body.ratePct != null && body.ratePct !== '' ? Number(body.ratePct) : (choices.bonusRate ?? minPct);
  if (!Number.isFinite(ratePct) || ratePct < minPct || ratePct > maxPct) throw new HrmsError(422, 'INVALID', `The bonus rate is between ${minPct}% and ${maxPct}% (the law, version ${B.rates.version}).`, { problems: [`Rate: ${minPct}–${maxPct}%.`] });
  const surplus = body.allocableSurplus == null || body.allocableSurplus === '' ? null : Number(body.allocableSurplus);
  if (surplus != null && !(surplus >= 0)) throw new HrmsError(422, 'INVALID', 'The allocable surplus is an amount, zero or more.', { problems: ['Allocable surplus: zero or more.'] });

  const [people] = await db.query(
    `SELECT p.id, p.employee_id, p.payable_days, p.days_in_month, r.period_month FROM hrms_pay_run_people p
       JOIN hrms_pay_runs r ON r.company_id = p.company_id AND r.id = p.run_id AND r.deleted_at IS NULL AND r.status IN ('LOCKED','RELEASED','PAID')
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.included = 1 AND r.period_month BETWEEN ? AND ? ORDER BY r.period_month`, [c.companyId, y.fromMonth, y.toMonth]);
  const [lines] = people.length ? await db.query(
    `SELECT l.run_person_id, l.amount, l.source, k.code, k.name, k.kind, k.statutory_key FROM hrms_pay_run_lines l JOIN hrms_pay_components k ON k.company_id = l.company_id AND k.id = l.component_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.run_person_id IN (?) AND (l.source IN ('STRUCTURE','STATUTORY') OR k.code = 'STAT_TOPUP')`, [c.companyId, people.map((p) => p.id)]) : [[]];
  const byRp = new Map();
  for (const l of lines) { if (!byRp.has(l.run_person_id)) byRp.set(l.run_person_id, []); byRp.get(l.run_person_id).push({ code: l.code, name: l.name, kind: l.kind, statutoryKey: l.statutory_key, amount: Number(l.amount) }); }
  const ids = [...new Set(people.map((p) => p.employee_id))];
  const places = await placesOf(db, c.companyId, ids, on);
  const fixed = Number(B.ceiling.value.fixedMonthly) || 7000;
  const results = [];
  for (const id of ids) {
    const place = places.get(id);
    const months = [];
    let ceilingShown = fixed;
    for (const p of people.filter((x) => x.employee_id === id)) {
      const monthEnd = `${p.period_month}-${String(new Date(Date.UTC(Number(p.period_month.slice(0, 4)), Number(p.period_month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
      const mw = B.ceiling.value.orMinimumWage === false ? null : await cache.minWage(place, monthEnd);
      const ceiling = Math.max(fixed, mw?.found ? mw.wage.total : 0);
      ceilingShown = ceiling;
      months.push({ month: p.period_month, payableDays: Number(p.payable_days), daysInMonth: Number(p.days_in_month), wage: K.wagesOf(byRp.get(p.id) ?? []).codeWages, ceiling, minimumWage: mw?.found ? mw.wage.total : null });
    }
    const r = bonusFor({ months, eligibilityCeiling: Number(B.eligibility.value.wageCeilingMonthly) || null, minDays: Number(B.eligibility.value.minDaysWorked) || 30, ratePct, minAmount: Number(B.rates.value.minAmount) || 100 });
    results.push({ employeeId: id, ceiling: ceilingShown, ...r });
  }
  const eligible = results.filter((r) => r.eligible);
  const salaryTotal = money(eligible.reduce((s, r) => s + r.calcWageTotal, 0));
  const totals = {
    people: results.length, eligible: eligible.length, amount: money(eligible.reduce((s, r) => s + r.amount, 0)), calcWageTotal: salaryTotal,
    monthsPaid: [...new Set(people.map((p) => p.period_month))].sort(),
    setOnOff: setOnOff({ allocableSurplus: surplus, salaryTotal, minPct, maxPct, capPct: Number(B.setOnOff?.value?.capPctOfSalary) || 20 }),
  };
  const lawUsed = Object.fromEntries(Object.entries(B).filter(([, v]) => v).map(([k, v]) => [k, { id: v.id, version: v.version, effectiveFrom: v.effectiveFrom, verified: v.verified, value: v.value, title: v.title }]));
  const lawJson = { rules: lawUsed, unverified: Object.values(lawUsed).filter((v) => !v.verified).map((v) => v.title) };
  const deadline = addMonths(y.to, Number(B.paymentTime?.value?.withinMonthsOfYearEnd) || 8);
  let id = existing?.id;
  if (existing) {
    await db.query('UPDATE hrms_bonus_lines SET deleted_at = NOW() WHERE company_id = ? AND bonus_run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
    await db.query('UPDATE hrms_bonus_runs SET rate_pct = ?, allocable_surplus = ?, deadline = ?, totals_json = ?, law_json = ?, note = ?, prepared_by = ?, prepared_at = NOW() WHERE id = ?',
      [ratePct, surplus, deadline, JSON.stringify(totals), JSON.stringify(lawJson), body.note ? String(body.note).slice(0, 500) : existing.note, c.userId, id]);
  } else {
    const [ins] = await db.query(`INSERT INTO hrms_bonus_runs (company_id, bonus_year, year_from, year_to, rate_pct, status, allocable_surplus, deadline, totals_json, law_json, note, prepared_by, prepared_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, NOW(), ?)`, [c.companyId, y.year, y.from, y.to, ratePct, surplus, deadline, JSON.stringify(totals), JSON.stringify(lawJson), body.note ? String(body.note).slice(0, 500) : null, c.userId, c.userId]);
    id = ins.insertId;
  }
  for (const r of results) {
    await db.query(`INSERT INTO hrms_bonus_lines (company_id, bonus_run_id, employee_id, eligible, reason, days_worked, months_json, wages_total, calc_wage_total, ceiling, amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [c.companyId, id, r.employeeId, r.eligible ? 1 : 0, r.reason ? r.reason.slice(0, 300) : null, r.daysWorked, JSON.stringify(r.months), r.wagesTotal, r.calcWageTotal, r.ceiling, r.amount, c.userId]);
  }
  await audit(db, c, 'hrms_bonus_runs', id, existing ? 'UPDATE' : 'CREATE', null, { year: y.year, ratePct, eligible: totals.eligible, amount: totals.amount }, requestId);
  return readBonusRun(db, c, id);
}

/* ── approve, schedule ───────────────────────────────────────────────── */

export async function approveBonus(db, c, id, requestId = null) {
  const r = await runRow(db, c.companyId, id, { lock: true });
  if (r.status !== 'DRAFT') throw new HrmsError(409, 'WRONG_STATUS', `The bonus of ${r.bonus_year} is ${r.status.toLowerCase()} already.`);
  if (!c.owner) throw new HrmsError(403, 'OWNER_ONLY', 'Only the Owner approves the bonus.');
  if (Number(r.prepared_by) === Number(c.userId)) throw new HrmsError(409, 'OWN_RECORD', 'You prepared this bonus, so someone else must approve it (maker-checker).');
  await db.query("UPDATE hrms_bonus_runs SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?", [c.userId, r.id]);
  const so = json(r.totals_json, {})?.setOnOff;
  const until = (() => { const y = Number(r.bonus_year.slice(0, 4)) + 4; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; })();
  if (so?.setOn > 0) await db.query("INSERT INTO hrms_bonus_set_on_off (company_id, bonus_year, kind, amount, carry_until_year, bonus_run_id, note, created_by) VALUES (?, ?, 'SET_ON', ?, ?, ?, ?, ?)", [c.companyId, r.bonus_year, so.setOn, until, r.id, 'Allocable surplus above the maximum bonus (s.36)', c.userId]);
  if (so?.setOff > 0) await db.query("INSERT INTO hrms_bonus_set_on_off (company_id, bonus_year, kind, amount, carry_until_year, bonus_run_id, note, created_by) VALUES (?, ?, 'SET_OFF', ?, ?, ?, ?, ?)", [c.companyId, r.bonus_year, so.setOff, until, r.id, 'Minimum bonus above the allocable surplus (s.36)', c.userId]);
  await audit(db, c, 'hrms_bonus_runs', r.id, 'APPROVE', { status: 'DRAFT' }, { status: 'APPROVED' }, requestId);
  return readBonusRun(db, c, id);
}

/** Puts the approved bonus into a month's open run as BONUS one-time items. */
export async function scheduleBonus(db, c, id, body = {}, requestId = null) {
  const r = await runRow(db, c.companyId, id, { lock: true });
  if (r.status !== 'APPROVED') throw new HrmsError(409, 'WRONG_STATUS', r.status === 'DRAFT' ? 'The Owner approves the bonus first.' : 'The bonus is already in a run.');
  const runId = Number(body.runId);
  const [[run]] = await db.query('SELECT id, period_month, status FROM hrms_pay_runs WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, runId]);
  if (!run) throw new HrmsError(422, 'INVALID', 'Choose the month’s payroll run that pays it.', { problems: ['Choose a run.'] });
  if (!['DRAFT', 'CALCULATED'].includes(run.status)) throw new HrmsError(409, 'WRONG_STATUS', 'That run is locked: choose a month whose run is still open.');
  const [[k]] = await db.query("SELECT id FROM hrms_pay_components WHERE company_id = ? AND code = 'BONUS' AND status = 'ACTIVE' AND deleted_at IS NULL AND statutory_key IS NULL", [c.companyId]);
  if (!k) throw new HrmsError(409, 'NO_COMPONENT', 'The company has no active Bonus component (Payroll › Components).');
  const { addItem } = await import('../payroll/runService.js');
  const [lines] = await db.query('SELECT id, employee_id, amount FROM hrms_bonus_lines WHERE company_id = ? AND bonus_run_id = ? AND deleted_at IS NULL AND eligible = 1 AND amount > 0', [c.companyId, id]);
  for (const l of lines) {
    const res = await addItem(db, c, runId, { employeeId: l.employee_id, componentId: k.id, amount: Number(l.amount), note: `Statutory bonus ${r.bonus_year} at ${Number(r.rate_pct)}% (Code on Wages s.26)` }, requestId);
    await db.query('UPDATE hrms_bonus_lines SET item_id = ? WHERE id = ?', [res.item.id, l.id]);
  }
  await db.query("UPDATE hrms_bonus_runs SET status = 'SCHEDULED', pay_run_id = ?, pay_month = ?, scheduled_by = ?, scheduled_at = NOW() WHERE id = ?", [runId, run.period_month, c.userId, r.id]);
  await audit(db, c, 'hrms_bonus_runs', r.id, 'UPDATE', { status: 'APPROVED' }, { status: 'SCHEDULED', runId, month: run.period_month, items: lines.length }, requestId);
  return readBonusRun(db, c, id);
}

/** Takes the bonus out of a run that is still open (back to APPROVED). */
export async function unscheduleBonus(db, c, id, requestId = null) {
  const r = await runRow(db, c.companyId, id, { lock: true });
  if (r.status !== 'SCHEDULED') throw new HrmsError(409, 'WRONG_STATUS', 'The bonus is not in a run.');
  const { deleteItem } = await import('../payroll/runService.js');
  const [lines] = await db.query('SELECT id, item_id FROM hrms_bonus_lines WHERE company_id = ? AND bonus_run_id = ? AND deleted_at IS NULL AND item_id IS NOT NULL', [c.companyId, id]);
  for (const l of lines) { await deleteItem(db, c, l.item_id, requestId); await db.query('UPDATE hrms_bonus_lines SET item_id = NULL WHERE id = ?', [l.id]); }
  await db.query("UPDATE hrms_bonus_runs SET status = 'APPROVED', pay_run_id = NULL, pay_month = NULL, scheduled_by = NULL, scheduled_at = NULL WHERE id = ?", [r.id]);
  await audit(db, c, 'hrms_bonus_runs', r.id, 'UPDATE', { status: 'SCHEDULED' }, { status: 'APPROVED', unscheduled: lines.length }, requestId);
  return readBonusRun(db, c, id);
}

/** Throws a DRAFT bonus away. */
export async function removeBonus(db, c, id, requestId = null) {
  const r = await runRow(db, c.companyId, id, { lock: true });
  if (r.status !== 'DRAFT') throw new HrmsError(409, 'WRONG_STATUS', 'Only a draft bonus can be removed.');
  await db.query('UPDATE hrms_bonus_lines SET deleted_at = NOW() WHERE company_id = ? AND bonus_run_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE hrms_bonus_runs SET deleted_at = NOW() WHERE id = ?', [r.id]);
  await audit(db, c, 'hrms_bonus_runs', r.id, 'DELETE', { year: r.bonus_year }, null, requestId);
  return { ok: true };
}

/* ── the register ────────────────────────────────────────────────────── */

const safe = (s) => String(s ?? '').replace(/₹/g, 'Rs. ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/×/g, 'x').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');

/** The bonus register (the year's lines: wages, calculation wage, days, bonus, paid in). xlsx or pdf, as base64. */
export async function bonusRegister(db, c, id, format = 'xlsx') {
  const d = await readBonusRun(db, c, id);
  const [[co]] = await db.query('SELECT name FROM companies WHERE id = ?', [c.companyId]);
  const name = `Bonus register ${d.run.year}`;
  const rows = d.lines.map((l, i) => [i + 1, l.employee.code, l.employee.name, l.daysWorked, l.wagesTotal, l.ceiling ?? '', l.calcWageTotal, l.eligible ? 'Yes' : 'No', l.amount, l.reason ?? '']);
  const head = ['#', 'Code', 'Name', 'Days worked', 'Wages in the year', 'Monthly ceiling', 'Wages for bonus', 'Eligible', 'Bonus', 'Note'];
  const meta = [`${co?.name ?? ''}`, `Statutory bonus, accounting year ${d.run.year} (${d.run.from} to ${d.run.to})`, `Rate ${d.run.ratePct}% · status ${d.run.status}${d.run.payMonth ? ` · paid with the ${d.run.payMonth} payroll` : ''} · due by ${d.run.deadline}`, 'Code on Wages, 2019, ss.26-41; rules from the law layer.'];
  if (String(format).toLowerCase() === 'pdf') {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 36, bottom: 36, left: 36, right: 36 }, info: { Title: name } });
    doc.font('Helvetica-Bold').fontSize(13).text(safe(meta[0]));
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    for (const m of meta.slice(1)) doc.text(safe(m));
    doc.moveDown(0.6).fillColor('#111');
    const widths = [24, 60, 150, 60, 80, 70, 80, 46, 60, 140];
    const L = doc.page.margins.left;
    const row = (cells, bold = false) => {
      if (doc.y > doc.page.height - 60) doc.addPage();
      const y = doc.y; let x = L;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      let h = 0;
      cells.forEach((cell, i) => { const t = safe(typeof cell === 'number' ? cell.toLocaleString('en-IN') : cell); doc.text(t, x, y, { width: widths[i] - 4 }); h = Math.max(h, doc.y - y); x += widths[i]; });
      doc.y = y + h + 3; doc.x = L;
    };
    row(head, true);
    for (const r of rows) row(r);
    row(['', '', 'Total', '', '', '', d.run.totals.calcWageTotal ?? '', `${d.run.totals.eligible ?? 0}`, d.run.totals.amount ?? 0, ''], true);
    return { fileName: `${name}.pdf`, mimeType: 'application/pdf', contentBase64: (await pdfBuffer(doc)).toString('base64') };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Bonus register');
  for (const m of meta) ws.addRow([m]);
  ws.addRow([]);
  const hr = ws.addRow(head); hr.font = { bold: true };
  for (const r of rows) ws.addRow(r);
  const tr = ws.addRow(['', '', 'Total', '', '', '', d.run.totals.calcWageTotal ?? 0, d.run.totals.eligible ?? 0, d.run.totals.amount ?? 0, '']); tr.font = { bold: true };
  ws.columns.forEach((col, i) => { col.width = [5, 12, 28, 12, 16, 14, 16, 9, 12, 50][i] ?? 12; });
  const mws = wb.addWorksheet('Months');
  mws.addRow(['Code', 'Name', 'Month', 'Days paid', 'Days', 'Wages', 'Full-month wages', 'Counted', 'Ceiling', 'Wages for bonus']).font = { bold: true };
  for (const l of d.lines) for (const m of l.months) mws.addRow([l.employee.code, l.employee.name, m.month, m.payableDays, m.daysInMonth, m.wage, m.fullWage, m.counted ? 'Yes' : 'No', m.ceiling, m.calcWage]);
  return { fileName: `${name}.xlsx`, mimeType: XLSX_MIME, contentBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') };
}

export default { yearBounds, bonusFor, setOnOff, listBonusRuns, readBonusRun, prepareBonus, approveBonus, scheduleBonus, unscheduleBonus, removeBonus, bonusRegister };
