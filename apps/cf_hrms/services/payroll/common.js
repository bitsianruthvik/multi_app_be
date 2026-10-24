/**
 * common.js — what the payroll services share: reading rows, the audit row, words.
 */
import { invalid, HrmsError } from '../../lib/errors.js';
import { audit as auditRow } from '../peopleService.js';
import { dateText, today } from '../positionService.js';
import { money } from './formula.js';
import { statutoryFromLaw } from '../law/statutory.js';
import { currentLaw } from '../law/pin.js';

export { money, dateText, today };

/** Every payroll write is audited in the same transaction (TiDB has no triggers). */
export const audit = (db, c, entityType, entityId, action, before, after, requestId = null) => auditRow(db, c, entityType, entityId, action, before, after, requestId);

export const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
export const flag = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'Yes' || v === 'yes';
export const text = (v, max = 500) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const json = (v, fallback = null) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};
export const stamp = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);

/** "₹12,34,567" (screen and Excel). The PDF says "Rs." — its font has no rupee sign. */
export const inr = (v) => `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export const refuse = (code, message, extra) => new HrmsError(409, code, message, extra);
export const bad = (message, problems = [message]) => invalid('INVALID', message, { problems });

/** A whole number of rupees and paise, zero or more, at most 12 digits before the point. */
export function readAmount(v, label, problems, { allowNegative = false, required = true } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) problems.push(`${label}: give an amount.`);
    return null;
  }
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n)) { problems.push(`${label}: “${String(v).slice(0, 30)}” is not an amount.`); return null; }
  if (!allowNegative && n < 0) { problems.push(`${label}: an amount cannot be negative.`); return null; }
  if (Math.abs(n) >= 1e12) { problems.push(`${label}: that amount is too large.`); return null; }
  return money(n);
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const longDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
};
export const dayBefore = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

export const STATUTORY_KEYS = ['PF_EE', 'PF_ER', 'ESI_EE', 'ESI_ER', 'PT', 'LWF_EE', 'LWF_ER', 'TDS', 'ARREARS'];
export const STATUTORY_WORDS = {
  PF_EE: 'PF, employee’s share', PF_ER: 'PF, employer’s share', ESI_EE: 'ESI, employee’s share', ESI_ER: 'ESI, employer’s share',
  PT: 'Professional tax', LWF_EE: 'Labour welfare fund, employee', LWF_ER: 'Labour welfare fund, employer', TDS: 'Income tax deducted (TDS)', ARREARS: 'Arrears of a back-dated revision',
};

/** Components of a company: { byId: Map, byCode: Map, list }. */
export async function loadComponents(db, companyId, { withInactive = true } = {}) {
  const [rows] = await db.query(
    `SELECT id, code, name, kind, taxable, exemption_rule, in_pf_wage, in_esi_wage, in_gratuity_wage, frequency, prorate_on_lop,
            statutory_key, sort_order, status, is_ready_made, description, updated_at
       FROM hrms_pay_components WHERE company_id = ? AND deleted_at IS NULL ${withInactive ? '' : "AND status = 'ACTIVE'"}
      ORDER BY FIELD(kind, 'EARNING', 'REIMBURSEMENT', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION'), sort_order, code`,
    [companyId],
  );
  const list = rows.map(shapeComponent);
  return { list, byId: new Map(list.map((c) => [c.id, c])), byCode: new Map(list.map((c) => [c.code, c])) };
}

export const shapeComponent = (r) => ({
  id: r.id, code: r.code, name: r.name, kind: r.kind, taxable: r.taxable, exemptionRule: r.exemption_rule ?? null,
  inPfWage: Boolean(r.in_pf_wage), inEsiWage: Boolean(r.in_esi_wage), inGratuityWage: Boolean(r.in_gratuity_wage),
  frequency: r.frequency, prorateOnLop: Boolean(r.prorate_on_lop), statutoryKey: r.statutory_key ?? null, sortOrder: Number(r.sort_order) || 0,
  status: r.status, readyMade: Boolean(r.is_ready_made), description: r.description ?? null, updatedAt: stamp(r.updated_at),
});

/** Structures with their lines: Map<structureId, { id, code, name, status, lines: [{ componentId, formula, sortOrder }] }>. */
export async function loadStructures(db, companyId, ids = null) {
  const where = ids ? `AND id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'})` : '';
  const [structs] = await db.query(`SELECT id, code, name, description, status, updated_at FROM hrms_pay_structures WHERE company_id = ? AND deleted_at IS NULL ${where} ORDER BY name, id`, [companyId, ...(ids ?? [])]);
  const out = new Map(structs.map((s) => [s.id, { id: s.id, code: s.code, name: s.name, description: s.description ?? null, status: s.status, updatedAt: stamp(s.updated_at), lines: [] }]));
  if (!out.size) return out;
  const [lines] = await db.query(
    `SELECT id, structure_id, component_id, formula, sort_order FROM hrms_pay_structure_lines
      WHERE company_id = ? AND deleted_at IS NULL AND structure_id IN (${[...out.keys()].map(() => '?').join(',')}) ORDER BY sort_order, id`,
    [companyId, ...out.keys()],
  );
  for (const l of lines) out.get(l.structure_id)?.lines.push({ id: l.id, componentId: l.component_id, formula: l.formula, sortOrder: Number(l.sort_order) || 0 });
  return out;
}

export const shapeSalary = (r) => ({
  id: r.id, employeeId: r.employee_id, effectiveFrom: dateText(r.effective_from), effectiveTo: dateText(r.effective_to),
  annualCtc: money(r.annual_ctc), monthlyCtc: money(Number(r.annual_ctc) / 12), structureId: r.structure_id,
  overrides: (json(r.overrides_json, []) ?? []).map((o) => ({ componentId: Number(o.componentId), amount: money(o.amount) })),
  pfMode: r.pf_mode, stateCode: r.state_code ?? null, reason: r.reason ?? null, updatedAt: stamp(r.updated_at), createdAt: stamp(r.created_at),
});
export const SALARY_COLUMNS = 'id, employee_id, effective_from, effective_to, annual_ctc, structure_id, overrides_json, pf_mode, state_code, reason, updated_at, created_at';

/** { [componentId]: amount } from a salary's overrides list. */
export const overrideMap = (salary) => Object.fromEntries((salary?.overrides ?? []).map((o) => [o.componentId, o.amount]));

/** The company's payroll settings, with the defaults. */
export async function companySettings(db, companyId) {
  const [[r]] = await db.query('SELECT state_code, debit_account_no, debit_ifsc, narration, updated_at FROM hrms_pay_settings WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return {
    stateCode: r?.state_code ?? 'TG', debitAccountNo: r?.debit_account_no ?? null, debitIfsc: r?.debit_ifsc ?? null, narration: r?.narration ?? 'Salary',
    updatedAt: stamp(r?.updated_at),
  };
}

/**
 * The statutory settings in force on a day, by kind, for a state:
 * { PF, ESI, PT, LWF } (each the settings object, with `meta`), PF and ESI national ('IN').
 * FROM THE LAW LAYER since §37 (services/law/statutory.js; the old per-company table
 * hrms_pay_statutory_settings is read by nothing). `companyId` is kept for the callers: the law is the
 * same for every company. Inside a reproduction, the run's own versions (services/law/pin.js).
 */
export async function statutoryOn(db, companyId, on, stateCode) {
  if (currentLaw()?.legacy) return (await import('../law/migrate.js')).legacyStatutoryOn(db, companyId, on, stateCode);
  return statutoryFromLaw(db, on, stateCode);
}

/** The person's bank and PAN, from their identifiers (BANK_ACCOUNT, IFSC, PAN), live today. */
export async function identifiersOf(db, companyId, employeeIds) {
  const out = new Map(employeeIds.map((id) => [id, { account: null, ifsc: null, pan: null, uan: null, esi: null }]));
  if (!employeeIds.length) return out;
  const [rows] = await db.query(
    `SELECT employee_id, identifier_type, identifier_value FROM hrms_employee_identifiers
      WHERE company_id = ? AND deleted_at IS NULL AND employee_id IN (${employeeIds.map(() => '?').join(',')})
        AND identifier_type IN ('BANK_ACCOUNT', 'IFSC', 'PAN', 'UAN', 'ESI')
        AND (valid_to IS NULL OR valid_to >= CURDATE())
      ORDER BY valid_from DESC, id DESC`,
    [companyId, ...employeeIds],
  );
  const key = { BANK_ACCOUNT: 'account', IFSC: 'ifsc', PAN: 'pan', UAN: 'uan', ESI: 'esi' };
  for (const r of rows) {
    const o = out.get(r.employee_id);
    const k = key[r.identifier_type];
    if (o && k && !o[k]) o[k] = String(r.identifier_value).trim();
  }
  return out;
}

/** The person's position title and department on a day (their main seat). */
export async function seatsOn(db, companyId, employeeIds, on) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const [rows] = await db.query(
    `SELECT wa.employee_id, p.position_title, d.name AS department_name
       FROM hrms_work_assignments wa
       LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
       LEFT JOIN hrms_departments d ON d.company_id = wa.company_id AND d.id = COALESCE(wa.department_id, p.department_id)
      WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED' AND wa.employee_id IN (${employeeIds.map(() => '?').join(',')})
        AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
      ORDER BY wa.is_primary DESC, wa.effective_from DESC, wa.id`,
    [companyId, ...employeeIds, on, on],
  );
  for (const r of rows) if (!out.has(r.employee_id)) out.set(r.employee_id, { positionTitle: r.position_title ?? null, departmentName: r.department_name ?? null });
  return out;
}

/** Masks all but the last four characters: "XXXXXXXX1234". */
export const mask = (v) => {
  const s = String(v ?? '').replace(/\s+/g, '');
  if (!s) return null;
  return s.length <= 4 ? s : `${'X'.repeat(s.length - 4)}${s.slice(-4)}`;
};
