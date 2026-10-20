/**
 * claims.js — reimbursements and flexible benefits with bills. (TM/CF_HRMS_HIRING_SPEC.md §25.5.)
 *
 * CLAIM TYPES (the company's list, HR): code, name, a yearly limit (a person, a tax year), the tax treatment
 *   EXEMPT   paid as REIMB (not income) — the rule in words on the type (e.g. "rule 3(7)(ix): telephone")
 *   TAXABLE  paid as REIMB_TAX (income, taxed like salary)
 *   LTA      the leave-travel rule (rule `exempt_lta` of the year: two journeys in a block of four calendar
 *            years — 2022–2025, 2026–2029 …): a claim within the block's journeys is paid as REIMB_LTA (exemption
 *            rule LTA: exempt in the old regime, taxable in the new — the engine refuses it there); a claim past
 *            them as REIMB_TAX. Decided when HR approves, and kept on the claim (lta_exempt, lta_note).
 *   bills needed, and FLEXIBLE (part of pay: an unclaimed balance at the year end is paid, taxed, in the March
 *   run — or lapses — by the company's policy; policy.js).
 *
 * A CLAIM: the person files it from My pay › Claims with the bills (PDF / JPG / PNG, ≤ 10 MB, stored as P2's
 * proofs: payrollTax/files.js, purpose CLAIM_BILL), within the type's limit for the tax year (claims waiting
 * and approved count).
 *   SUBMITTED   with the person's manager (the first approver of their chain — the Approvals screen, kind
 *               CLAIM) when the policy says a manager looks first and there is one; else straight to HR
 *   RECOMMENDED the manager agreed; with HR
 *   APPROVED    HR approved, the amount may be lower; pays in the next run (pay_month) as a REIMBURSEMENT line
 *   PAID        the run that took it was marked paid
 *   REJECTED    by the manager or HR, with a note;   WITHDRAWN by the person before a decision
 * HR never decides their own claim (the login's own employee): refused in words.
 */
import { HrmsError } from '../../lib/errors.js';
import { audit, bad, refuse, text, money, stamp, json, readAmount, longDate } from '../payroll/common.js';
import { storeFile, readUpload, fileBytes, transport, shapeFile } from '../payrollTax/files.js';
import { yearOfDate, loadRules, isDate, assertNotOwn } from '../payrollTax/common.js';

export { assertNotOwn };
import { monthBounds, nextMonth } from '../payroll/proration.js';
import { loadWorlds, approverChain, loadPersons } from '../leave/requestService.js';
import { policyOf } from './policy.js';
import { auditSalaryRead } from '../payroll/payrollService.js';

export const TREATMENTS = ['EXEMPT', 'TAXABLE', 'LTA'];
const STATUS_WORDS = { SUBMITTED: 'With the manager', RECOMMENDED: 'With HR', APPROVED: 'Approved — pays in the next payroll', PAID: 'Paid', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn' };
const OPEN = ['SUBMITTED', 'RECOMMENDED'];
const COUNTS = ['SUBMITTED', 'RECOMMENDED', 'APPROVED', 'PAID'];
const todayText = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const day = (v) => (v ? (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10)) : null);

/** Ready-made claim types (Payroll › Claim types › "Add the usual ones"). The rule words are for HR and the CA to check. */
export const READY_MADE_TYPES = [
  { code: 'FUEL', name: 'Fuel and conveyance', yearlyLimit: 36000, taxTreatment: 'EXEMPT', billsNeeded: true, flexible: true,
    taxRule: 'Running costs of a car or two-wheeler used for the employer\'s work, with the journey record the rules ask for (rule 3(2) of the 1962 Rules; rule 15(3) of the 2026 Rules). Personal use is taxable: mark the type TAXABLE if the use is mixed and not recorded.' },
  { code: 'PHONE', name: 'Phone and internet', yearlyLimit: 24000, taxTreatment: 'EXEMPT', billsNeeded: true, flexible: true,
    taxRule: 'Telephone and internet provided or paid for by the employer are not a perquisite (rule 3(7)(ix) of the 1962 Rules; the same in rule 15 of the 2026 Rules).' },
  { code: 'LTA', name: 'Leave travel', yearlyLimit: 40000, taxTreatment: 'LTA', billsNeeded: true, flexible: true,
    taxRule: 'Fare of journeys in India: two journeys in a block of four calendar years (s.10(5), rule 2B; Schedule III Sl. 8, rule 278 of the 2026 Rules). Old regime only.' },
  { code: 'MEALS', name: 'Meals', yearlyLimit: 26400, taxTreatment: 'TAXABLE', billsNeeded: true, flexible: true,
    taxRule: 'Cash paid back for meals is salary. (Meal vouchers or cards — not cash — are valued under the perquisite rules: up to ₹50 a meal in 2025-26, ₹200 in 2026-27.)' },
  { code: 'BOOKS', name: 'Books and periodicals', yearlyLimit: 12000, taxTreatment: 'EXEMPT', billsNeeded: true, flexible: true,
    taxRule: 'Books and periodicals for the work, against bills: not income of the employee (an expense of the employer). CHECK with your CA for the new regime.' },
];

const shapeType = (r) => ({
  id: r.id, code: r.code, name: r.name, yearlyLimit: r.yearly_limit == null ? null : money(r.yearly_limit), taxTreatment: r.tax_treatment, taxRule: r.tax_rule ?? null,
  billsNeeded: Boolean(r.bills_needed), flexible: Boolean(r.flexible), status: r.status, sortOrder: Number(r.sort_order) || 0, description: r.description ?? null, updatedAt: stamp(r.updated_at),
});

export async function loadTypes(db, companyId) {
  const [rows] = await db.query('SELECT * FROM hrms_pay_claim_types WHERE company_id = ? AND deleted_at IS NULL ORDER BY sort_order, name', [companyId]);
  return rows.map(shapeType);
}

/* ══ claim types (HR) ═══════════════════════════════════════════════════ */

export async function listTypes(db, c) {
  return { types: await loadTypes(db, c.companyId), treatments: TREATMENTS, readyMade: READY_MADE_TYPES.map((t) => t.code) };
}

function readType(body, { creating, current = null }) {
  const problems = [];
  const out = {};
  if (creating) {
    out.code = String(body.code ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(out.code)) problems.push('Code: letters, digits and _ (FUEL, PHONE …), starting with a letter.');
  }
  if (creating || body.name !== undefined) { out.name = text(body.name, 120); if (!out.name) problems.push('Name: give the claim type a name.'); }
  if (creating || body.yearlyLimit !== undefined) out.yearlyLimit = body.yearlyLimit === null || body.yearlyLimit === '' ? null : readAmount(body.yearlyLimit, 'Yearly limit', problems);
  if (creating || body.taxTreatment !== undefined) {
    out.taxTreatment = String(body.taxTreatment ?? 'EXEMPT').toUpperCase();
    if (!TREATMENTS.includes(out.taxTreatment)) problems.push('Tax: EXEMPT, TAXABLE or LTA (the leave-travel rule).');
  }
  if (creating || body.taxRule !== undefined) out.taxRule = text(body.taxRule, 500);
  const treatment = out.taxTreatment ?? current?.taxTreatment;
  if (treatment === 'EXEMPT' && !(out.taxRule ?? current?.taxRule)) problems.push('Tax rule: an exempt claim says which rule makes it exempt, in words.');
  if (creating || body.billsNeeded !== undefined) out.billsNeeded = body.billsNeeded === undefined ? true : Boolean(body.billsNeeded);
  if (creating || body.flexible !== undefined) out.flexible = Boolean(body.flexible);
  if (body.status !== undefined) { out.status = String(body.status).toUpperCase(); if (!['ACTIVE', 'INACTIVE'].includes(out.status)) problems.push('Status: ACTIVE or INACTIVE.'); }
  if (creating || body.sortOrder !== undefined) out.sortOrder = Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0;
  if (creating || body.description !== undefined) out.description = text(body.description, 500);
  if (problems.length) throw bad('The claim type cannot be saved yet.', problems);
  return out;
}

async function typeRow(db, companyId, id) {
  const [[r]] = await db.query('SELECT * FROM hrms_pay_claim_types WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!r) throw new HrmsError(404, 'NOT_FOUND', 'That claim type not found.');
  return shapeType(r);
}

export async function createType(db, c, body = {}, requestId = null) {
  const t = readType(body, { creating: true });
  const [ins] = await db.query(
    'INSERT INTO hrms_pay_claim_types (company_id, code, name, yearly_limit, tax_treatment, tax_rule, bills_needed, flexible, sort_order, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, t.code, t.name, t.yearlyLimit, t.taxTreatment, t.taxRule, t.billsNeeded ? 1 : 0, t.flexible ? 1 : 0, t.sortOrder, t.description, c.userId])
    .catch((e) => { if (e.errno === 1062) throw refuse('DUPLICATE', `There is a claim type ${t.code} already.`); throw e; });
  await audit(db, c, 'hrms_pay_claim_types', ins.insertId, 'CREATE', null, t, requestId);
  return { type: await typeRow(db, c.companyId, ins.insertId) };
}

export async function updateType(db, c, id, body = {}, requestId = null) {
  const cur = await typeRow(db, c.companyId, id);
  const t = readType(body, { creating: false, current: cur });
  const next = { ...cur, ...t };
  await db.query('UPDATE hrms_pay_claim_types SET name = ?, yearly_limit = ?, tax_treatment = ?, tax_rule = ?, bills_needed = ?, flexible = ?, status = ?, sort_order = ?, description = ? WHERE id = ?',
    [next.name, next.yearlyLimit, next.taxTreatment, next.taxRule, next.billsNeeded ? 1 : 0, next.flexible ? 1 : 0, next.status, next.sortOrder, next.description, id]);
  await audit(db, c, 'hrms_pay_claim_types', id, 'UPDATE', cur, next, requestId);
  return { type: await typeRow(db, c.companyId, id) };
}

export async function deleteType(db, c, id, requestId = null) {
  const cur = await typeRow(db, c.companyId, id);
  const [[u]] = await db.query('SELECT COUNT(*) AS n FROM hrms_pay_claims WHERE company_id = ? AND claim_type_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (Number(u.n)) throw refuse('IN_USE', `${cur.name} has ${u.n} claim(s). Make it inactive instead: the claims keep it.`);
  await db.query('UPDATE hrms_pay_claim_types SET deleted_at = NOW() WHERE id = ?', [id]);
  await audit(db, c, 'hrms_pay_claim_types', id, 'DELETE', cur, null, requestId);
  return { ok: true };
}

/** POST /payroll/claim-types/setup — the ready-made types that are missing. */
export async function setupTypes(db, c, requestId = null) {
  const have = new Set((await loadTypes(db, c.companyId)).map((t) => t.code));
  const made = [];
  let i = 0;
  for (const t of READY_MADE_TYPES) {
    i += 10;
    if (have.has(t.code)) continue;
    await createType(db, c, { ...t, sortOrder: i }, requestId);
    made.push(t.code);
  }
  return { made, ...(await listTypes(db, c)) };
}

/* ══ claims ═════════════════════════════════════════════════════════════ */

const CLAIM_SELECT = `SELECT cl.*, t.code AS type_code, t.name AS type_name, t.tax_treatment, t.tax_rule, t.bills_needed, t.flexible, t.yearly_limit,
         e.employee_code, e.full_name, du.name AS decided_by_name, mu.name AS manager_by_name
    FROM hrms_pay_claims cl
    JOIN hrms_pay_claim_types t ON t.company_id = cl.company_id AND t.id = cl.claim_type_id
    JOIN hrms_employees e ON e.company_id = cl.company_id AND e.id = cl.employee_id
    LEFT JOIN users du ON du.id = cl.decided_by LEFT JOIN users mu ON mu.id = cl.manager_by
   WHERE cl.company_id = ? AND cl.deleted_at IS NULL`;

async function billsOf(db, companyId, claimIds) {
  const out = new Map(claimIds.map((id) => [id, []]));
  if (!claimIds.length) return out;
  const [rows] = await db.query(
    `SELECT b.claim_id, f.id, f.file_name, f.mime_type, f.size_bytes, f.created_at FROM hrms_pay_claim_bills b JOIN hrms_tax_files f ON f.company_id = b.company_id AND f.id = b.file_id AND f.deleted_at IS NULL
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.claim_id IN (?) ORDER BY b.id`, [companyId, claimIds]);
  for (const r of rows) out.get(r.claim_id)?.push(shapeFile(r));
  return out;
}

const shapeClaim = (r, bills = []) => ({
  id: r.id, employee: { id: r.employee_id, code: r.employee_code, name: r.full_name },
  type: { id: r.claim_type_id, code: r.type_code, name: r.type_name, taxTreatment: r.tax_treatment, taxRule: r.tax_rule ?? null, flexible: Boolean(r.flexible) },
  year: r.tax_year, billDate: day(r.bill_date), amount: money(r.amount), approvedAmount: r.approved_amount == null ? null : money(r.approved_amount),
  description: r.description ?? null, journeys: json(r.journeys_json, null), ltaExempt: r.lta_exempt == null ? null : Boolean(r.lta_exempt), ltaNote: r.lta_note ?? null,
  status: r.status, statusWords: STATUS_WORDS[r.status] ?? r.status,
  managerNote: r.manager_note ?? null, managerAt: stamp(r.manager_at), managerBy: r.manager_by_name ?? null, withManager: r.approver_employee_id != null,
  decisionNote: r.decision_note ?? null, decidedAt: stamp(r.decided_at), decidedBy: r.decided_by_name ?? null,
  payMonth: r.pay_month ?? null, payMonthLabel: r.pay_month ? monthBounds(r.pay_month).label : null, paidAt: stamp(r.paid_at), submittedAt: stamp(r.created_at),
  bills,
});

async function claimRow(db, companyId, id) {
  const [[r]] = await db.query(`${CLAIM_SELECT} AND cl.id = ?`, [companyId, id]);
  if (!r) throw new HrmsError(404, 'NOT_FOUND', 'That claim not found.');
  return r;
}
async function fullClaim(db, companyId, id) {
  const r = await claimRow(db, companyId, id);
  return shapeClaim(r, (await billsOf(db, companyId, [id])).get(id));
}

/** A person's use of each type in a tax year: Map<typeId, { pending, approved }> (approved = approved + paid). */
async function usageOf(db, companyId, employeeId, year, { exceptId = null } = {}) {
  const [rows] = await db.query(
    `SELECT claim_type_id, status, SUM(COALESCE(approved_amount, amount)) AS total FROM hrms_pay_claims
      WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND deleted_at IS NULL AND status IN (?) ${exceptId ? 'AND id <> ?' : ''} GROUP BY claim_type_id, status`,
    [companyId, employeeId, year, COUNTS, ...(exceptId ? [exceptId] : [])]);
  const out = new Map();
  for (const r of rows) {
    const u = out.get(r.claim_type_id) ?? { pending: 0, approved: 0 };
    if (OPEN.includes(r.status)) u.pending += Number(r.total); else u.approved += Number(r.total);
    out.set(r.claim_type_id, u);
  }
  return out;
}

/**
 * The month of the NEXT run, which pays what is approved now: the earliest run still open (draft or calculated);
 * else the month after the latest locked run; else this month. With `atLeast` (a full and final: its exit month),
 * never earlier than that.
 */
export async function nextPayMonth(db, companyId, atLeast = null) {
  const [[open]] = await db.query("SELECT MIN(period_month) AS m FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status IN ('DRAFT','CALCULATED')", [companyId]);
  const [[locked]] = await db.query("SELECT MAX(period_month) AS m FROM hrms_pay_runs WHERE company_id = ? AND deleted_at IS NULL AND status IN ('LOCKED','RELEASED','PAID')", [companyId]);
  let next = open?.m ?? (locked?.m ? nextMonth(locked.m) : todayText().slice(0, 7));
  if (locked?.m && next <= locked.m) next = nextMonth(locked.m);
  return atLeast && atLeast > next ? atLeast : next;
}

/** GET /user/me/claims — my claim types with this year's use, my claims. */
export async function myClaims(db, c, employeeId, { year = null } = {}) {
  const y = year ?? yearOfDate(todayText());
  const types = (await loadTypes(db, c.companyId)).filter((t) => t.status === 'ACTIVE');
  const usage = await usageOf(db, c.companyId, employeeId, y);
  const [rows] = await db.query(`${CLAIM_SELECT} AND cl.employee_id = ? ORDER BY cl.created_at DESC, cl.id DESC LIMIT 300`, [c.companyId, employeeId]);
  const bills = await billsOf(db, c.companyId, rows.map((r) => r.id));
  return {
    year: y,
    types: types.map((t) => {
      const u = usage.get(t.id) ?? { pending: 0, approved: 0 };
      return { ...t, used: { pending: money(u.pending), approved: money(u.approved), left: t.yearlyLimit == null ? null : money(Math.max(0, t.yearlyLimit - u.pending - u.approved)) } };
    }),
    claims: rows.map((r) => shapeClaim(r, bills.get(r.id))),
  };
}

function readJourneys(v, problems) {
  if (!Array.isArray(v) || !v.length) { problems.push('Journeys: a leave-travel claim lists each journey (from, to, the date it started).'); return null; }
  return v.slice(0, 10).map((j, i) => {
    const out = { from: text(j?.from, 80), to: text(j?.to, 80), startDate: j?.startDate ?? null, endDate: j?.endDate ?? null, mode: text(j?.mode, 30) };
    if (!out.from || !out.to) problems.push(`Journey ${i + 1}: from where to where.`);
    if (!isDate(out.startDate)) problems.push(`Journey ${i + 1}: the date it started (YYYY-MM-DD).`);
    return out;
  });
}

/** POST /user/me/claims { claimTypeId, billDate, amount, description?, journeys?, bills: [{ fileName, contentBase64 }] } */
export async function submitClaim(db, c, employeeId, body = {}, requestId = null) {
  const problems = [];
  const types = await loadTypes(db, c.companyId);
  const t = types.find((x) => x.id === Number(body.claimTypeId) && x.status === 'ACTIVE');
  if (!t) problems.push('Claim type: choose one from the list.');
  const billDate = String(body.billDate ?? '');
  if (!isDate(billDate)) problems.push('Bill date: the date on the bill (YYYY-MM-DD).');
  else if (billDate > todayText()) problems.push('Bill date: not a day in the future.');
  const amount = readAmount(body.amount, 'Amount', problems);
  if (amount === 0) problems.push('Amount: more than zero.');
  const description = text(body.description, 500);
  const journeys = t?.taxTreatment === 'LTA' ? readJourneys(body.journeys, problems) : null;
  const files = Array.isArray(body.bills) ? body.bills : [];
  if (t?.billsNeeded && !files.length) problems.push(`Bills: ${t.name} needs the bills — add a PDF or a photo.`);
  if (files.length > 10) problems.push('Bills: at most 10 files on one claim.');
  if (problems.length) throw bad('The claim cannot be filed yet.', problems);
  const uploads = files.map((f) => readUpload(f, { what: 'A bill' }));
  const year = yearOfDate(billDate);
  const [[emp]] = await db.query('SELECT id, date_of_joining, exit_date, employment_status FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, employeeId]);
  if (!emp) throw new HrmsError(404, 'NOT_FOUND', 'That employee not found.');
  if (t.yearlyLimit != null) {
    const u = (await usageOf(db, c.companyId, employeeId, year)).get(t.id) ?? { pending: 0, approved: 0 };
    const left = money(t.yearlyLimit - u.pending - u.approved);
    if (amount > left) throw refuse('OVER_LIMIT', `${t.name}: ₹${Math.max(0, left).toLocaleString('en-IN')} is left of the ₹${t.yearlyLimit.toLocaleString('en-IN')} limit for ${year} (claims waiting and approved count). Claim at most that.`, { left: Math.max(0, left) });
  }
  // Who looks first: the person's manager (their first approver), when the policy says so and there is one.
  const policy = await policyOf(db, c.companyId);
  let approverId = null;
  if (policy.claimsManagerFirst) {
    const w = (await loadWorlds(db, c.companyId, [employeeId])).get(employeeId);
    if (w) approverId = (await approverChain(db, c.companyId, w)).approverId ?? null;
  }
  const status = approverId ? 'SUBMITTED' : 'RECOMMENDED';
  const [ins] = await db.query(
    `INSERT INTO hrms_pay_claims (company_id, employee_id, claim_type_id, tax_year, bill_date, amount, description, journeys_json, status, approver_employee_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, employeeId, t.id, year, billDate, amount, description, journeys ? JSON.stringify(journeys) : null, status, approverId, c.userId]);
  for (const u of uploads) await attachBill(db, c, ins.insertId, employeeId, year, u);
  await audit(db, c, 'hrms_pay_claims', ins.insertId, 'CREATE', null, { employeeId, type: t.code, year, billDate, amount, bills: uploads.length, status }, requestId);
  return { claim: await fullClaim(db, c.companyId, ins.insertId) };
}

async function attachBill(db, c, claimId, employeeId, year, u) {
  const fileId = await storeFile(db, c, { purpose: 'CLAIM_BILL', year, employeeId, fileName: u.fileName, mimeType: u.mimeType }, u.buffer);
  await db.query('INSERT INTO hrms_pay_claim_bills (company_id, claim_id, file_id, created_by) VALUES (?, ?, ?, ?)', [c.companyId, claimId, fileId, c.userId]);
  return fileId;
}

async function myClaimRow(db, c, employeeId, id) {
  const r = await claimRow(db, c.companyId, id);
  if (r.employee_id !== employeeId) throw new HrmsError(404, 'NOT_FOUND', 'That claim not found.');
  return r;
}

/** POST /user/me/claims/:id/bills { fileName, contentBase64 } — another bill on my claim while it waits. */
export async function addMyBill(db, c, employeeId, id, body = {}, requestId = null) {
  const r = await myClaimRow(db, c, employeeId, id);
  if (!OPEN.includes(r.status)) throw refuse('WRONG_STATUS', 'A bill can be added only while the claim waits for a decision.');
  const u = readUpload(body, { what: 'A bill' });
  const fileId = await attachBill(db, c, id, employeeId, r.tax_year, u);
  await audit(db, c, 'hrms_pay_claims', id, 'UPDATE', null, { billAdded: fileId, fileName: u.fileName }, requestId);
  return { claim: await fullClaim(db, c.companyId, id) };
}

/** POST /user/me/claims/:id/withdraw */
export async function withdrawMine(db, c, employeeId, id, requestId = null) {
  const r = await myClaimRow(db, c, employeeId, id);
  if (!OPEN.includes(r.status)) throw refuse('WRONG_STATUS', `This claim is ${STATUS_WORDS[r.status].toLowerCase()}: it can no longer be withdrawn.`);
  await db.query("UPDATE hrms_pay_claims SET status = 'WITHDRAWN' WHERE id = ?", [id]);
  await audit(db, c, 'hrms_pay_claims', id, 'UPDATE', { status: r.status }, { status: 'WITHDRAWN' }, requestId);
  return { claim: await fullClaim(db, c.companyId, id) };
}

/** A bill's bytes, when it belongs to the claim. */
export async function billFile(db, c, claimId, fileId) {
  const [[b]] = await db.query('SELECT id FROM hrms_pay_claim_bills WHERE company_id = ? AND claim_id = ? AND file_id = ? AND deleted_at IS NULL', [c.companyId, claimId, fileId]);
  if (!b) throw new HrmsError(404, 'NOT_FOUND', 'That bill not found.');
  return transport(await fileBytes(db, c.companyId, fileId));
}
export async function myBillFile(db, c, employeeId, claimId, fileId) {
  await myClaimRow(db, c, employeeId, claimId);
  return billFile(db, c, claimId, fileId);
}

/* ── the manager's first look (Approvals, kind CLAIM) ── */

export async function managerFeed(db, c, viewer, { status = 'PENDING' } = {}) {
  const me = viewer.employeeId ?? -1;
  const decided = String(status).toUpperCase() === 'DECIDED';
  const [rows] = decided
    ? await db.query(`${CLAIM_SELECT} AND cl.approver_employee_id = ? AND cl.manager_at IS NOT NULL ORDER BY cl.manager_at DESC LIMIT 200`, [c.companyId, me])
    : await db.query(`${CLAIM_SELECT} AND cl.status = 'SUBMITTED' AND cl.approver_employee_id = ? AND cl.employee_id <> ? ORDER BY cl.created_at, cl.id LIMIT 500`, [c.companyId, me, me]);
  const persons = await loadPersons(db, c.companyId, rows.map((r) => r.employee_id));
  const now = Date.now();
  const pending = decided ? (await db.query("SELECT COUNT(*) AS n FROM hrms_pay_claims WHERE company_id = ? AND deleted_at IS NULL AND status = 'SUBMITTED' AND approver_employee_id = ? AND employee_id <> ?", [c.companyId, me, me]))[0][0].n : rows.length;
  return {
    items: rows.map((r) => ({
      kind: 'CLAIM', id: r.id, person: persons.get(r.employee_id), title: `${r.type_name} — ₹${money(r.amount).toLocaleString('en-IN')}`, when: `Bill of ${longDate(day(r.bill_date))}`,
      submittedAt: stamp(r.created_at), waitingDays: Math.max(0, Math.floor((now - new Date(r.created_at).getTime()) / 86400000)), flags: [], status: r.status === 'SUBMITTED' ? 'PENDING' : r.status,
    })),
    counts: { pending: Number(pending) || 0 },
  };
}

async function managerReach(db, c, viewer, r) {
  if (viewer.employeeId != null && r.approver_employee_id === viewer.employeeId && r.employee_id !== viewer.employeeId) return true;
  throw new HrmsError(404, 'NOT_FOUND', 'That claim not found.');
}

export async function managerDetail(db, c, viewer, id) {
  const r = await claimRow(db, c.companyId, id);
  await managerReach(db, c, viewer, r);
  const claim = shapeClaim(r, (await billsOf(db, c.companyId, [id])).get(id));
  const usage = (await usageOf(db, c.companyId, r.employee_id, r.tax_year, { exceptId: id })).get(r.claim_type_id) ?? { pending: 0, approved: 0 };
  return { request: { ...claim, status: r.status === 'SUBMITTED' ? 'PENDING' : r.status }, context: { limit: r.yearly_limit == null ? null : money(r.yearly_limit), usedThisYear: money(usage.pending + usage.approved), note: 'Your look comes first; HR approves the amount and pays it with the payroll.' } };
}

export async function managerDecide(db, c, viewer, id, verdict, body = {}, requestId = null) {
  const r = await claimRow(db, c.companyId, id);
  await managerReach(db, c, viewer, r);
  if (r.status !== 'SUBMITTED') throw refuse('WRONG_STATUS', `This claim is ${STATUS_WORDS[r.status].toLowerCase()} already.`);
  const note = text(body.note, 500);
  if (verdict === 'REJECT' && !note) throw bad('Say why the claim is rejected.', ['Note: say why.']);
  const status = verdict === 'APPROVE' ? 'RECOMMENDED' : 'REJECTED';
  await db.query('UPDATE hrms_pay_claims SET status = ?, manager_note = ?, manager_at = NOW(), manager_by = ? WHERE id = ?', [status, note, c.userId, id]);
  await audit(db, c, 'hrms_pay_claims', id, 'UPDATE', { status: r.status }, { status, managerNote: note }, requestId);
  return { request: await fullClaim(db, c.companyId, id) };
}

/* ── HR ── */

/** GET /payroll/claims?status=&q=&year= — amounts: pay view; audited. */
export async function listClaims(db, c, query = {}, requestId = null) {
  const where = [];
  const params = [c.companyId];
  const st = String(query.status ?? 'WAITING').toUpperCase();
  if (st === 'WAITING') where.push("cl.status IN ('SUBMITTED','RECOMMENDED')");
  else if (['SUBMITTED', 'RECOMMENDED', 'APPROVED', 'PAID', 'REJECTED', 'WITHDRAWN'].includes(st)) { where.push('cl.status = ?'); params.push(st); }
  if (query.year && /^\d{4}-\d{2}$/.test(String(query.year))) { where.push('cl.tax_year = ?'); params.push(String(query.year)); }
  const q = String(query.q ?? '').trim();
  if (q) { where.push('(e.full_name LIKE ? OR e.employee_code LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const [rows] = await db.query(`${CLAIM_SELECT}${where.length ? ` AND ${where.join(' AND ')}` : ''} ORDER BY cl.created_at DESC, cl.id DESC LIMIT 500`, params);
  const bills = await billsOf(db, c.companyId, rows.map((r) => r.id));
  if (rows.length) await auditSalaryRead(db, c, [...new Set(rows.map((r) => r.employee_id))], 'claims', requestId);
  const [counts] = await db.query("SELECT status, COUNT(*) AS n FROM hrms_pay_claims WHERE company_id = ? AND deleted_at IS NULL GROUP BY status", [c.companyId]);
  return { claims: rows.map((r) => shapeClaim(r, bills.get(r.id))), counts: Object.fromEntries(counts.map((x) => [x.status, Number(x.n)])) };
}

export async function readClaim(db, c, id, requestId = null) {
  const r = await claimRow(db, c.companyId, id);
  await auditSalaryRead(db, c, [r.employee_id], `claim ${id}`, requestId);
  const usage = (await usageOf(db, c.companyId, r.employee_id, r.tax_year, { exceptId: id })).get(r.claim_type_id) ?? { pending: 0, approved: 0 };
  return { claim: shapeClaim(r, (await billsOf(db, c.companyId, [id])).get(id)), context: { limit: r.yearly_limit == null ? null : money(r.yearly_limit), usedThisYear: money(usage.pending + usage.approved) } };
}

/** The block of four calendar years a date falls in (rule exempt_lta: firstBlockStart, blockYears). */
export function ltaBlock(date, rule) {
  const y = Number(String(date).slice(0, 4));
  const start = rule.firstBlockStart + Math.floor((y - rule.firstBlockStart) / rule.blockYears) * rule.blockYears;
  return { from: start, to: start + rule.blockYears - 1, label: `${start}–${start + rule.blockYears - 1}` };
}

/** POST /payroll/claims/:id/approve { amount?, note? } */
export async function approveClaim(db, c, id, body = {}, requestId = null) {
  const r = await claimRow(db, c.companyId, id);
  await assertNotOwn(db, c, r.employee_id, 'claim');
  if (!OPEN.includes(r.status)) throw refuse('WRONG_STATUS', `This claim is ${STATUS_WORDS[r.status].toLowerCase()}: it cannot be approved now.`);
  const problems = [];
  const amount = body.amount === undefined || body.amount === null || body.amount === '' ? money(r.amount) : readAmount(body.amount, 'Amount approved', problems);
  if (amount === 0) problems.push('Amount approved: more than zero — or reject the claim.');
  if (amount != null && amount > money(r.amount)) problems.push(`Amount approved: at most what was claimed (₹${money(r.amount).toLocaleString('en-IN')}).`);
  const note = text(body.note, 500);
  if (amount != null && amount < money(r.amount) && !note) problems.push('Note: say why less is approved than was claimed.');
  if (problems.length) throw bad('The claim cannot be approved yet.', problems);
  if (r.yearly_limit != null) {
    const u = (await usageOf(db, c.companyId, r.employee_id, r.tax_year, { exceptId: id })).get(r.claim_type_id) ?? { pending: 0, approved: 0 };
    const left = money(Number(r.yearly_limit) - u.approved);
    if (amount > left) throw refuse('OVER_LIMIT', `${r.type_name}: only ₹${Math.max(0, left).toLocaleString('en-IN')} of the ₹${money(r.yearly_limit).toLocaleString('en-IN')} limit for ${r.tax_year} is left after the approved claims.`, { left: Math.max(0, left) });
  }
  // Leave travel: within the block's journeys (rule exempt_lta of the year) → exempt in the old regime.
  let ltaExempt = null;
  let ltaNote = null;
  if (r.tax_treatment === 'LTA') {
    const { rules } = await loadRules(db, r.tax_year);
    const rule = rules?.OLD.has('exempt_lta') ? rules.OLD.get('exempt_lta') : null;
    const journeys = (json(r.journeys_json, []) ?? []).length || 1;
    if (!rule) { ltaExempt = 0; ltaNote = `No leave-travel rule for ${r.tax_year}: paid as taxable.`; } else {
      const firstDate = (json(r.journeys_json, []) ?? [])[0]?.startDate ?? day(r.bill_date);
      const block = ltaBlock(firstDate, rule);
      const [others] = await db.query(
        `SELECT journeys_json FROM hrms_pay_claims WHERE company_id = ? AND employee_id = ? AND id <> ? AND deleted_at IS NULL AND status IN ('APPROVED','PAID') AND lta_exempt = 1`,
        [c.companyId, r.employee_id, id]);
      const used = others.reduce((s, o) => s + (json(o.journeys_json, []) ?? []).filter((j) => ltaBlock(j.startDate, rule).from === block.from).length, 0);
      ltaExempt = used + journeys <= rule.journeysPerBlock ? 1 : 0;
      ltaNote = ltaExempt
        ? `Journey${journeys === 1 ? '' : 's'} ${used + 1}${journeys > 1 ? `–${used + journeys}` : ''} of ${rule.journeysPerBlock} in the block ${block.label} (${rule.section}): exempt in the old regime, taxable in the new.`
        : `${used} of the ${rule.journeysPerBlock} journeys of the block ${block.label} are used (${rule.section}): this claim is paid as taxable. (A journey carried over from the last block, in the first year of a new one, is not worked out here — ask your CA.)`;
    }
  }
  const payMonth = await nextPayMonth(db, c.companyId);
  await db.query(
    "UPDATE hrms_pay_claims SET status = 'APPROVED', approved_amount = ?, decision_note = ?, decided_at = NOW(), decided_by = ?, pay_month = ?, lta_exempt = ?, lta_note = ?, run_id = NULL WHERE id = ?",
    [amount, note, c.userId, payMonth, ltaExempt, ltaNote, id]);
  await audit(db, c, 'hrms_pay_claims', id, 'APPROVE', { status: r.status, amount: money(r.amount) }, { status: 'APPROVED', approvedAmount: amount, payMonth, ltaExempt, note }, requestId);
  return { claim: await fullClaim(db, c.companyId, id) };
}

export async function rejectClaim(db, c, id, body = {}, requestId = null) {
  const r = await claimRow(db, c.companyId, id);
  await assertNotOwn(db, c, r.employee_id, 'claim');
  if (!OPEN.includes(r.status)) throw refuse('WRONG_STATUS', `This claim is ${STATUS_WORDS[r.status].toLowerCase()}: it cannot be rejected now.`);
  const note = text(body.note, 500);
  if (!note) throw bad('Say why the claim is rejected.', ['Note: say why.']);
  await db.query("UPDATE hrms_pay_claims SET status = 'REJECTED', decision_note = ?, decided_at = NOW(), decided_by = ? WHERE id = ?", [note, c.userId, id]);
  await audit(db, c, 'hrms_pay_claims', id, 'UPDATE', { status: r.status }, { status: 'REJECTED', note }, requestId);
  return { claim: await fullClaim(db, c.companyId, id) };
}

/** An approved claim not paid yet goes back to waiting for HR (its run must still be open). */
export async function reopenClaim(db, c, id, body = {}, requestId = null) {
  const r = await claimRow(db, c.companyId, id);
  await assertNotOwn(db, c, r.employee_id, 'claim');
  if (r.status !== 'APPROVED') throw refuse('WRONG_STATUS', 'Only an approved claim that is not paid yet can be taken back.');
  if (r.run_id) {
    const [[run]] = await db.query('SELECT status, period_month FROM hrms_pay_runs WHERE company_id = ? AND id = ?', [c.companyId, r.run_id]);
    if (run && ['LOCKED', 'RELEASED', 'PAID'].includes(run.status)) throw refuse('IN_LOCKED_RUN', `The ${monthBounds(run.period_month).label} payroll pays it and is locked.`);
  }
  await db.query("UPDATE hrms_pay_claims SET status = 'RECOMMENDED', approved_amount = NULL, pay_month = NULL, run_id = NULL, lta_exempt = NULL, lta_note = NULL WHERE id = ?", [id]);
  await audit(db, c, 'hrms_pay_claims', id, 'UPDATE', { status: 'APPROVED', approvedAmount: money(r.approved_amount) }, { status: 'RECOMMENDED', why: text(body.note, 300) }, requestId);
  return { claim: await fullClaim(db, c.companyId, id) };
}

/* ── the run ── */

/** The component code a claim pays as. */
export const claimCode = (r) => (r.tax_treatment === 'EXEMPT' ? 'REIMB' : r.tax_treatment === 'LTA' && Number(r.lta_exempt) === 1 ? 'REIMB_LTA' : 'REIMB_TAX');

/** Approved claims a run of `month` pays: Map<employeeId, [{ id, code, amount, basis }]>. */
export async function claimsForRun(db, companyId, month, runId) {
  const [rows] = await db.query(
    `SELECT cl.id, cl.employee_id, cl.approved_amount, cl.bill_date, cl.lta_exempt, t.name AS type_name, t.tax_treatment FROM hrms_pay_claims cl
       JOIN hrms_pay_claim_types t ON t.company_id = cl.company_id AND t.id = cl.claim_type_id
      WHERE cl.company_id = ? AND cl.deleted_at IS NULL AND cl.status = 'APPROVED' AND cl.pay_month <= ? AND (cl.run_id IS NULL OR cl.run_id = ?)`, [companyId, month, runId]);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.employee_id)) out.set(r.employee_id, []);
    out.get(r.employee_id).push({ id: r.id, code: claimCode(r), amount: money(r.approved_amount), basis: `claim #${r.id}: ${r.type_name}, bill of ${longDate(day(r.bill_date))}` });
  }
  return out;
}

/**
 * The year-end flexible balance (March run, policy PAY_TAXABLE): for each flexible type with a limit, the limit
 * for the months employed in the tax year (a month employed for any day counts) less what was approved;
 * a FLEXI_PAY earning, taxed. Map<employeeId, [{ code, amount, basis }]>.
 */
export async function flexiForRun(db, companyId, month, employees) {
  if (!month.endsWith('-03') || !employees.length) return new Map();
  const policy = await policyOf(db, companyId);
  if (policy.flexiYearEnd !== 'PAY_TAXABLE') return new Map();
  const types = (await loadTypes(db, companyId)).filter((t) => t.flexible && t.yearlyLimit != null && t.status === 'ACTIVE');
  if (!types.length) return new Map();
  const y1 = Number(month.slice(0, 4)) - 1;
  const year = `${y1}-${String((y1 + 1) % 100).padStart(2, '0')}`;
  const ids = employees.map((e) => e.id);
  const [rows] = await db.query(
    `SELECT employee_id, claim_type_id, SUM(approved_amount) AS total FROM hrms_pay_claims WHERE company_id = ? AND deleted_at IS NULL AND tax_year = ? AND status IN ('APPROVED','PAID')
        AND employee_id IN (?) GROUP BY employee_id, claim_type_id`, [companyId, year, ids]);
  const used = new Map(rows.map((r) => [`${r.employee_id}|${r.claim_type_id}`, Number(r.total)]));
  const out = new Map();
  for (const e of employees) {
    const first = `${y1}-04-01`;
    const last = `${y1 + 1}-03-31`;
    const from = e.joining && e.joining > first ? e.joining : first;
    const to = e.exit && e.exit < last ? e.exit : last;
    if (from > to) continue;
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    for (const t of types) {
      const entitled = money(t.yearlyLimit * months / 12);
      const balance = money(entitled - (used.get(`${e.id}|${t.id}`) ?? 0));
      if (balance <= 0) continue;
      if (!out.has(e.id)) out.set(e.id, []);
      out.get(e.id).push({ code: 'FLEXI_PAY', amount: balance, basis: `${t.name}: ₹${entitled.toLocaleString('en-IN')} for ${months} month(s) of ${year}, ₹${(used.get(`${e.id}|${t.id}`) ?? 0).toLocaleString('en-IN')} claimed — the rest paid, taxed (company policy)` });
    }
  }
  return out;
}

export default {
  listTypes, createType, updateType, deleteType, setupTypes, myClaims, submitClaim, addMyBill, withdrawMine, billFile, myBillFile,
  managerFeed, managerDetail, managerDecide, listClaims, readClaim, approveClaim, rejectClaim, reopenClaim, claimsForRun, flexiForRun, nextPayMonth, assertNotOwn, ltaBlock,
};
