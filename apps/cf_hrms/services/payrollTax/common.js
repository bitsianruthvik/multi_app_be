/**
 * common.js — what the tax-in-payroll services share (TM/CF_HRMS_HIRING_SPEC.md §25.4).
 *
 *   yearOf(month) / yearOfDate(day)   '2026-10' → '2026-27'
 *   yearMonths(year)                   ['2026-04', … '2027-03']
 *   quarterOf(month)                   Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar
 *   panStatus(pan)                     VALID | INVALID | NONE
 *   readYear(param)                    a tax year from the address, or a 422
 *   loadRules(db, year)                { OLD, NEW } or null with the reason (a year not seeded)
 */
import { invalid, HrmsError } from '../../lib/errors.js';
import { loadTaxYear, yearBounds } from '../tax/index.js';
import { audit as auditRow } from '../peopleService.js';
import { dateText, today } from '../positionService.js';
import { money } from '../payroll/formula.js';

export { money, dateText, today };
export const audit = (db, c, entityType, entityId, action, before, after, requestId = null) => auditRow(db, c, entityType, entityId, action, before, after, requestId);
export const refuse = (code, message, extra) => new HrmsError(409, code, message, extra);
export const bad = (message, problems = [message]) => invalid('INVALID', message, { problems });
export const stamp = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
export const json = (v, fallback = null) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};
export const text = (v, max = 500) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
export const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

/** A financial / tax year of a month: '2026-10' → '2026-27', '2027-02' → '2026-27'. */
export function yearOf(month) {
  const [y, m] = String(month).slice(0, 7).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
export const yearOfDate = (day) => yearOf(String(day).slice(0, 7));
export function yearMonths(year) {
  const { startYear } = yearBounds(year);
  const out = [];
  for (let i = 0; i < 12; i += 1) {
    const m = ((3 + i) % 12) + 1;
    out.push(`${m >= 4 ? startYear : startYear + 1}-${String(m).padStart(2, '0')}`);
  }
  return out;
}
export function quarterOf(month) {
  const m = Number(String(month).slice(5, 7));
  return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4';
}
export const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
export const quarterMonths = (year, q) => yearMonths(year).slice((QUARTERS.indexOf(q)) * 3, QUARTERS.indexOf(q) * 3 + 3);

export function panStatus(pan) {
  const s = String(pan ?? '').trim().toUpperCase();
  if (!s) return 'NONE';
  return PAN_RE.test(s) ? 'VALID' : 'INVALID';
}

export function readYear(param) {
  const y = String(param ?? '');
  try { yearBounds(y); } catch (e) { throw invalid('INVALID', e.message); }
  return y;
}

/** Both regimes' rules of a year, or { rules: null, reason } when the year has none. */
export async function loadRules(db, year) {
  try {
    return { rules: await loadTaxYear(db, year), reason: null };
  } catch (e) {
    return { rules: null, reason: e.message };
  }
}

/** The forms of a year in words: { certificate, quarterlyReturn, declaration, perquisites, previousEmployer }. */
export function formsOf(rules) {
  if (!rules) return null;
  const f = rules.NEW.get('forms');
  return {
    act: f.act, salaryTdsSection: f.salaryTdsSection,
    certificate: f.certificate.label, quarterlyReturn: f.quarterlyReturn.label, declaration: f.declaration.label,
    perquisites: f.perquisites.label, previousEmployer: f.previousEmployer.label,
  };
}

/** The months from `from` to `to` inclusive ('YYYY-MM'). */
export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * HR never acts on their OWN tax or pay records from the HR side (P3b review): verifying their own proof, adding a
 * declaration past the window, approving their own claim or full and final. 403 OWN_RECORD, in words.
 */
export async function assertNotOwn(db, c, employeeId, what) {
  if (!c.userId || employeeId == null) return;
  const [[e]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL AND id = ?', [c.companyId, c.userId, employeeId]);
  if (e) throw new HrmsError(403, 'OWN_RECORD', `This is your own ${what}: another person in HR has to do it.`);
}

/** The employee of a login, or a 403. */
export async function myEmployeeId(db, c) {
  if (!c.userId) throw new HrmsError(403, 'NOT_LINKED', 'This login is not linked to an employee, so it has no tax of its own.');
  const [[e]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [c.companyId, c.userId]);
  if (!e) throw new HrmsError(403, 'NOT_LINKED', 'This login is not linked to an employee, so it has no tax of its own.');
  return e.id;
}

export async function employeeRow(db, companyId, employeeId) {
  const [[e]] = await db.query(
    'SELECT id, employee_code, full_name, date_of_birth, date_of_joining, exit_date, employment_status, user_id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
    [companyId, employeeId]);
  if (!e) throw new HrmsError(404, 'NOT_FOUND', 'That employee not found.');
  return { id: e.id, code: e.employee_code, name: e.full_name, dateOfBirth: dateText(e.date_of_birth), joiningDate: dateText(e.date_of_joining), exitDate: dateText(e.exit_date), status: e.employment_status, userId: e.user_id };
}

/** PANs of people today: Map<employeeId, 'ABCDE1234F' | null>. */
export async function pansOf(db, companyId, ids) {
  const out = new Map(ids.map((id) => [id, null]));
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT employee_id, identifier_value FROM hrms_employee_identifiers WHERE company_id = ? AND deleted_at IS NULL AND identifier_type = 'PAN'
        AND employee_id IN (${ids.map(() => '?').join(',')}) AND (valid_to IS NULL OR valid_to >= CURDATE()) ORDER BY valid_from DESC, id DESC`,
    [companyId, ...ids]);
  for (const r of rows) if (!out.get(r.employee_id)) out.set(r.employee_id, String(r.identifier_value).trim().toUpperCase());
  return out;
}
