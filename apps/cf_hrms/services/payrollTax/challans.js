/**
 * challans.js — paying the TDS: one row a deposit (challan serial, BSR code, date, amounts), for the
 * month whose TDS it pays; and a month-by-month view that warns when a month's TDS is not paid by
 * its due date (rule tds_deposit: the 7th of the next month, March by 30 April — rule 30 of the 1962
 * Rules / rule 218(2) of the 2026 Rules). TM/CF_HRMS_HIRING_SPEC.md §25.4 "Challans".
 *
 * The TDS of a month is what its LOCKED (or released / paid) run deducted. A month whose run is not
 * locked yet has nothing to pay.
 */
import { notFound } from '../../lib/errors.js';
import { audit, bad, text, money, n, today, dateText, isDate, yearOf, yearMonths, loadRules } from './common.js';
import { yearSettings, review } from './settings.js';
import { monthBounds } from '../payroll/proration.js';

const FROZEN = ['LOCKED', 'RELEASED', 'PAID'];

/** The due date of the TDS of `month` by the year's rule. */
export function dueDateOf(month, rule = { dueDay: 7, marchDue: '04-30' }) {
  const [y, m] = month.split('-').map(Number);
  if (m === 3) return `${y}-${rule.marchDue}`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(rule.dueDay).padStart(2, '0')}`;
}

export const shapeChallan = (r) => ({
  id: r.id, year: r.tax_year, month: r.period_month, challanSerial: r.challan_serial, bsrCode: r.bsr_code, depositDate: dateText(r.deposit_date),
  tax: money(r.tax), surcharge: money(r.surcharge), cess: money(r.cess), interest: money(r.interest), fee: money(r.fee), others: money(r.others), total: money(r.total),
  minorHead: r.minor_head, note: r.note ?? null,
});

/** The TDS deducted by month (locked runs), and each month's challans. */
export async function monthsOfYear(db, companyId, year, { on = today() } = {}) {
  const months = yearMonths(year);
  const { rules } = await loadRules(db, year);
  const rule = rules?.NEW?.has('tds_deposit') ? rules.NEW.get('tds_deposit') : { dueDay: 7, marchDue: '04-30' };
  const [runs] = await db.query(
    `SELECT r.id, r.period_month, r.status, COALESCE(SUM(p.tds_amount), 0) AS tds, SUM(p.tds_amount > 0) AS people
       FROM hrms_pay_runs r LEFT JOIN hrms_pay_run_people p ON p.company_id = r.company_id AND p.run_id = r.id AND p.deleted_at IS NULL AND p.included = 1
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.period_month >= ? AND r.period_month <= ? GROUP BY r.id`, [companyId, months[0], months[11]]);
  const [rows] = await db.query('SELECT * FROM hrms_tax_challans WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL ORDER BY period_month, deposit_date, id', [companyId, year]);
  return months.map((m) => {
    const run = runs.find((r) => r.period_month === m) ?? null;
    const locked = run && FROZEN.includes(run.status);
    const deducted = locked ? money(run.tds) : 0;
    const challans = rows.filter((r) => r.period_month === m).map(shapeChallan);
    const deposited = money(challans.reduce((a, x) => a + x.tax + x.surcharge + x.cess, 0));
    const due = dueDateOf(m, rule);
    const late = challans.filter((x) => x.depositDate > due);
    let status;
    if (!run) status = 'NO_RUN';
    else if (!locked) status = 'NOT_LOCKED';
    else if (!deducted && !challans.length) status = 'NO_TDS';
    else if (deposited >= deducted - 0.5) status = 'PAID';
    else if (deposited > 0) status = 'SHORT';
    else status = 'UNPAID';
    const overdue = ['UNPAID', 'SHORT'].includes(status) && on > due;
    const warning = overdue
      ? `${monthBounds(m).label}: ₹${(deducted - deposited).toLocaleString('en-IN')} of TDS not paid by ${due}. Pay it now — interest runs from the date of deduction.`
      : late.length ? `${monthBounds(m).label}: paid after the due date (${due}) — interest is due for the delay.` : null;
    return { month: m, label: monthBounds(m).label, run: run ? { id: run.id, status: run.status, people: Number(run.people) || 0 } : null, deducted, deposited, balance: money(deducted - deposited), due, status, overdue, warning, challans };
  });
}

/** GET /tax/:year/challans */
export async function listChallans(db, c, year) {
  const months = await monthsOfYear(db, c.companyId, year);
  const settings = await yearSettings(db, c.companyId, year);
  return {
    year, months, warnings: months.map((m) => m.warning).filter(Boolean),
    totals: { deducted: money(months.reduce((a, m) => a + m.deducted, 0)), deposited: money(months.reduce((a, m) => a + m.deposited, 0)) },
    review: review(settings),
  };
}

function readChallan(body, problems, before = null) {
  const pick = (k) => (body[k] === undefined && before ? before[k] : body[k]);
  const month = String(pick('month') ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) problems.push('Month: the month whose TDS this pays, as YYYY-MM.');
  const serial = String(pick('challanSerial') ?? '').trim();
  if (!/^\d{1,5}$/.test(serial)) problems.push('Challan serial number: up to five digits.');
  const bsr = String(pick('bsrCode') ?? '').trim();
  if (!/^\d{7}$/.test(bsr)) problems.push('BSR code: seven digits.');
  const date = String(pick('depositDate') ?? '');
  if (!isDate(date)) problems.push('Date of deposit: a date as YYYY-MM-DD.');
  else if (date > today()) problems.push('Date of deposit: not in the future.');
  const amt = (k, label) => {
    const v = pick(k);
    if (v === null || v === undefined || v === '') return 0;
    const x = Number(String(v).replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(x) || x < 0) { problems.push(`${label}: an amount, zero or more.`); return 0; }
    return money(x);
  };
  const a = { tax: amt('tax', 'Tax'), surcharge: amt('surcharge', 'Surcharge'), cess: amt('cess', 'Cess'), interest: amt('interest', 'Interest'), fee: amt('fee', 'Fee'), others: amt('others', 'Others') };
  const total = money(a.tax + a.surcharge + a.cess + a.interest + a.fee + a.others);
  if (!total) problems.push('Amounts: the challan pays something.');
  const minor = String(pick('minorHead') ?? '200');
  if (!['200', '400'].includes(minor)) problems.push('Minor head: 200 (TDS payable by the deductor) or 400 (regular assessment).');
  return { month, serial, bsr, date, ...a, total, minor, note: text(pick('note'), 500) };
}

export async function addChallan(db, c, year, body = {}, requestId = null) {
  const problems = [];
  const x = readChallan(body, problems);
  if (!problems.length && yearOf(x.month) !== year) problems.push(`Month: a month of ${year}.`);
  if (problems.length) throw bad('The challan cannot be saved yet.', problems);
  const [ins] = await db.query(
    `INSERT INTO hrms_tax_challans (company_id, tax_year, period_month, challan_serial, bsr_code, deposit_date, tax, surcharge, cess, interest, fee, others, total, minor_head, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, year, x.month, x.serial, x.bsr, x.date, x.tax, x.surcharge, x.cess, x.interest, x.fee, x.others, x.total, x.minor, x.note, c.userId]);
  await audit(db, c, 'hrms_tax_challans', ins.insertId, 'CREATE', null, { ...x }, requestId);
  const [[r]] = await db.query('SELECT * FROM hrms_tax_challans WHERE id = ?', [ins.insertId]);
  return { challan: shapeChallan(r) };
}

async function challanRow(db, companyId, id) {
  const [[r]] = await db.query('SELECT * FROM hrms_tax_challans WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!r) throw notFound('That challan');
  return r;
}

export async function updateChallan(db, c, id, body = {}, requestId = null) {
  const r = await challanRow(db, c.companyId, id);
  const before = shapeChallan(r);
  const problems = [];
  const x = readChallan(body, problems, before);
  if (!problems.length && yearOf(x.month) !== r.tax_year) problems.push(`Month: a month of ${r.tax_year}.`);
  if (problems.length) throw bad('The challan cannot be saved yet.', problems);
  await db.query('UPDATE hrms_tax_challans SET period_month = ?, challan_serial = ?, bsr_code = ?, deposit_date = ?, tax = ?, surcharge = ?, cess = ?, interest = ?, fee = ?, others = ?, total = ?, minor_head = ?, note = ? WHERE id = ?',
    [x.month, x.serial, x.bsr, x.date, x.tax, x.surcharge, x.cess, x.interest, x.fee, x.others, x.total, x.minor, x.note, id]);
  await audit(db, c, 'hrms_tax_challans', id, 'UPDATE', before, x, requestId);
  return { challan: shapeChallan(await challanRow(db, c.companyId, id)) };
}

export async function removeChallan(db, c, id, requestId = null) {
  const r = await challanRow(db, c.companyId, id);
  await db.query('UPDATE hrms_tax_challans SET deleted_at = NOW() WHERE id = ?', [id]);
  await audit(db, c, 'hrms_tax_challans', id, 'DELETE', shapeChallan(r), null, requestId);
  return { ok: true };
}

export { n };
