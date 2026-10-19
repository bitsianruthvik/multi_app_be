/**
 * declarations.js — what a person declares to the employer for a tax year (Form 12BB before
 * 2026-27, Form 124 from it — named by the year's rules), line by line, and how the lines become
 * the tax engine's claims. TM/CF_HRMS_HIRING_SPEC.md §25.4.
 *
 *   KINDS                       every kind of line, its group (the engine's claim) and its fields
 *   listLines / addLine / updateLine / removeLine   (the person in the window; HR any time)
 *   claimsOf(lines, opts)       → the engine's { deductions, exemptions, otherIncome, previousEmployer }
 *                                 and `used` (each line: counted as declared / as verified / not, and why)
 *
 * WHICH AMOUNT COUNTS. While the proof window is open: the declared amount — except a line HR has
 * VERIFIED (its accepted amount) or REJECTED (nothing). Once it has CLOSED: only VERIFIED lines, at
 * the accepted amount. The previous employer's statement (Form 12B / 122) counts unless rejected.
 * The NEW regime refuses most of these: the engine says so, line by line (refused[]).
 */
import { notFound } from '../../lib/errors.js';
import { audit, bad, refuse, text, n, money, today, json, stamp, dateText, PAN_RE, TAN_RE, yearMonths, monthsBetween, employeeRow } from './common.js';
import { yearSettings } from './settings.js';
import { profileOf } from './profiles.js';
import { shapeFile } from './files.js';

const G80C = '80C';
export const KINDS = {
  RENT: { group: 'HRA', label: 'Rent paid (for the HRA exemption)', proof: 'Rent receipts or the rent agreement' },
  LTA: { group: 'LTA', label: 'Leave travel — fare of the journeys', proof: 'Tickets and boarding passes' },
  HOME_LOAN_INTEREST: { group: '24B', label: 'Interest on a home loan (the house you live in)', proof: 'The lender’s interest certificate' },
  PPF: { group: G80C, label: 'Public Provident Fund (PPF)', proof: 'Passbook or deposit receipt' },
  ELSS: { group: G80C, label: 'Tax-saving mutual funds (ELSS)', proof: 'Statement of the investment' },
  LIC: { group: G80C, label: 'Life insurance premium', proof: 'Premium receipt' },
  TUITION: { group: G80C, label: 'Tuition fees (up to two children)', proof: 'Fee receipt from the school or college' },
  HOME_LOAN_PRINCIPAL: { group: G80C, label: 'Home-loan principal repaid', proof: 'The lender’s certificate' },
  NSC: { group: G80C, label: 'National Savings Certificate (NSC)', proof: 'Certificate copy' },
  SSY: { group: G80C, label: 'Sukanya Samriddhi account', proof: 'Passbook' },
  TAX_SAVER_FD: { group: G80C, label: 'Five-year tax-saving bank deposit', proof: 'Deposit receipt' },
  NPS_80CCD1: { group: G80C, label: 'Own NPS contribution (within the 80C limit)', proof: 'NPS statement' },
  OTHER_80C: { group: G80C, label: 'Other 80C investment', proof: 'Receipt or statement' },
  NPS_80CCD1B: { group: '80CCD1B', label: 'Own NPS contribution, over and above 80C (up to ₹50,000)', proof: 'NPS statement' },
  MEDICAL_SELF: { group: '80D', label: 'Health insurance — self, spouse, children', proof: 'Premium receipt' },
  MEDICAL_PARENTS: { group: '80D', label: 'Health insurance — parents', proof: 'Premium receipt' },
  PREVENTIVE: { group: '80D', label: 'Preventive health check-up', proof: 'Bill' },
  EDUCATION_LOAN: { group: '80E', label: 'Interest on an education loan', proof: 'The lender’s interest certificate' },
  DONATION: { group: '80G', label: 'Donations (the deductible amount)', proof: 'Donation receipt with the 80G registration' },
  SAVINGS_INTEREST: { group: 'OTHER_INCOME', label: 'Savings bank interest (other income)', proof: 'Bank statement' },
  DEPOSIT_INTEREST: { group: 'OTHER_INCOME', label: 'Fixed-deposit interest (other income)', proof: 'Interest certificate' },
  OTHER_INCOME: { group: 'OTHER_INCOME', label: 'Other income you want the employer to count', proof: 'Any statement' },
  PREVIOUS_EMPLOYER: { group: 'PREVIOUS', label: 'Previous employer this year', proof: 'Form 16 / 130 or the previous employer’s statement (Form 12B / 122)' },
};
const GROUP_RULE = { HRA: 'exempt_hra', LTA: 'exempt_lta', '24B': 'ded_24b', [G80C]: 'ded_80c', '80CCD1B': 'ded_80ccd1b', '80D': 'ded_80d', '80E': 'ded_80e', '80G': 'ded_80g' };

/** The kinds with their section names in the year's law (from the rules), for the screens. */
export function kindsFor(rules) {
  return Object.entries(KINDS).map(([kind, k]) => {
    const rk = GROUP_RULE[k.group];
    const section = rk && rules?.OLD?.has(rk) ? rules.OLD.get(rk).section : null;
    return { kind, ...k, section, newRegime: rk ? Boolean(rules?.NEW?.has(rk) && rules.NEW.get(rk).allowed) : k.group !== 'OTHER_INCOME' ? null : true };
  });
}

export const shapeLine = (r, files = []) => ({
  id: r.id, employeeId: r.employee_id, year: r.tax_year, kind: r.kind, label: KINDS[r.kind]?.label ?? r.kind, group: KINDS[r.kind]?.group ?? null,
  declaredAmount: money(r.declared_amount), details: json(r.details_json, {}) ?? {},
  status: r.status, acceptedAmount: r.accepted_amount == null ? null : money(r.accepted_amount), rejectReason: r.reject_reason ?? null,
  submittedAt: stamp(r.submitted_at), reviewedAt: stamp(r.reviewed_at), updatedAt: stamp(r.updated_at),
  files: files.map(shapeFile),
});

export async function lineRows(db, companyId, employeeIds, year) {
  if (!employeeIds.length) return [];
  const [rows] = await db.query(
    `SELECT * FROM hrms_tax_declaration_lines WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL AND employee_id IN (${employeeIds.map(() => '?').join(',')}) ORDER BY employee_id, id`,
    [companyId, year, ...employeeIds]);
  return rows;
}

export async function filesOfLines(db, companyId, lineIds) {
  const out = new Map(lineIds.map((id) => [id, []]));
  if (!lineIds.length) return out;
  const [rows] = await db.query(
    `SELECT id, line_id, file_name, mime_type, size_bytes, created_at FROM hrms_tax_files WHERE company_id = ? AND purpose = 'PROOF' AND deleted_at IS NULL AND line_id IN (${lineIds.map(() => '?').join(',')}) ORDER BY id`,
    [companyId, ...lineIds]);
  for (const r of rows) out.get(r.line_id)?.push(r);
  return out;
}

/* ── reading and checking a line ─────────────────────────────────────── */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** The details of a kind, cleaned, and the declared amount. Problems in words. */
export function readLine(kind, body, { year, rules }) {
  const problems = [];
  const k = KINDS[kind];
  if (!k) throw bad(`“${kind}” is not a kind of declaration.`);
  const d = body.details ?? {};
  const months = yearMonths(year);
  const amount = (v, label, { required = true } = {}) => {
    if (v === null || v === undefined || v === '') { if (required) problems.push(`${label}: give an amount.`); return 0; }
    const x = Number(String(v).replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(x) || x < 0) { problems.push(`${label}: “${String(v).slice(0, 20)}” is not an amount.`); return 0; }
    if (x >= 1e11) { problems.push(`${label}: that amount is too large.`); return 0; }
    return money(x);
  };
  const pan = (v, label) => {
    const s = text(v, 10)?.toUpperCase() ?? null;
    if (s && !PAN_RE.test(s)) problems.push(`${label}: a PAN is ten characters, like ABCDE1234F.`);
    return s;
  };
  let details = {};
  let declared = 0;
  if (kind === 'RENT') {
    const monthlyRent = amount(d.monthlyRent, 'Rent a month');
    const fromMonth = MONTH_RE.test(String(d.fromMonth ?? '')) ? d.fromMonth : months[0];
    const toMonth = MONTH_RE.test(String(d.toMonth ?? '')) ? d.toMonth : months[11];
    if (!months.includes(fromMonth) || !months.includes(toMonth) || fromMonth > toMonth) problems.push(`Rent paid from / to: months of ${year}, the first not after the second.`);
    const count = months.includes(fromMonth) && months.includes(toMonth) && fromMonth <= toMonth ? monthsBetween(fromMonth, toMonth).length : 0;
    declared = money(monthlyRent * count);
    const landlordName = text(d.landlordName, 150);
    if (!landlordName) problems.push('Landlord’s name: needed for rent.');
    const landlordPan = pan(d.landlordPan, 'Landlord’s PAN');
    const limit = rules?.NEW?.has('declarations') ? Number(rules.NEW.get('declarations').landlordPanAbove) : 100000;
    if (declared > limit && !landlordPan) problems.push(`Landlord’s PAN: needed when the rent for the year is more than ₹${limit.toLocaleString('en-IN')} (this is ₹${declared.toLocaleString('en-IN')}).`);
    details = { monthlyRent, fromMonth, toMonth, landlordName, landlordPan, landlordAddress: text(d.landlordAddress, 300), relationship: text(d.relationship, 100) };
  } else if (kind === 'LTA') {
    declared = amount(body.amount, 'Fare');
    details = { journeys: text(d.journeys, 500), journeysUsedInBlock: Math.max(0, Math.min(9, Math.trunc(n(d.journeysUsedInBlock)))) };
    if (!details.journeys) problems.push('Journeys: say where and when (from, to, dates).');
  } else if (kind === 'HOME_LOAN_INTEREST') {
    declared = amount(body.amount, 'Interest');
    const lenderType = ['BANK', 'EMPLOYER', 'OTHER'].includes(String(d.lenderType ?? '').toUpperCase()) ? String(d.lenderType).toUpperCase() : 'BANK';
    details = { lenderName: text(d.lenderName, 150), lenderPan: pan(d.lenderPan, 'Lender’s PAN'), lenderAddress: text(d.lenderAddress, 300), lenderType };
    if (!details.lenderName) problems.push('Lender’s name: needed for home-loan interest.');
    if (lenderType === 'OTHER' && !details.lenderPan) problems.push('Lender’s PAN: needed when the lender is not a bank or the employer.');
  } else if (kind === 'PREVIOUS_EMPLOYER') {
    const salary = amount(d.salary, 'Salary paid by the previous employer');
    const exemptions = amount(d.exemptions, 'Exemptions given by them', { required: false });
    const pt = amount(d.pt, 'Professional tax deducted by them', { required: false });
    const tds = amount(d.tds, 'TDS deducted by them', { required: false });
    const tan = text(d.tan, 10)?.toUpperCase() ?? null;
    if (tan && !TAN_RE.test(tan)) problems.push('Previous employer’s TAN: ten characters, like ABCD12345E.');
    if (exemptions > salary) problems.push('Exemptions cannot be more than the salary.');
    details = { employerName: text(d.employerName, 200), tan, salary, exemptions, pt, tds, fromDate: text(d.fromDate, 10), toDate: text(d.toDate, 10) };
    if (!details.employerName) problems.push('Previous employer’s name: needed.');
    declared = money(salary - exemptions);
  } else {
    declared = amount(body.amount, 'Amount');
    if (kind === 'MEDICAL_SELF') details = { insured: text(d.insured, 200), senior: Boolean(d.senior) };
    else if (kind === 'MEDICAL_PARENTS') details = { insured: text(d.insured, 200), parentsSenior: Boolean(d.parentsSenior) };
    else details = { note: text(d.note, 300) };
  }
  if (problems.length) throw bad('The declaration cannot be saved yet.', problems);
  return { declared, details };
}

/** May this person change their declarations today? HR may always. */
export async function canDeclare(db, companyId, employeeId, year, settings = null) {
  const s = settings ?? await yearSettings(db, companyId, year);
  const p = await profileOf(db, companyId, employeeId, year);
  const reopened = p.declarationOpenUntil && p.declarationOpenUntil >= today();
  return { open: s.declarationWindow === 'OPEN' || Boolean(reopened), window: { from: s.declarationFrom, to: s.declarationTo, state: s.declarationWindow }, reopenedUntil: p.declarationOpenUntil };
}
export async function canProve(db, companyId, employeeId, year, settings = null) {
  const s = settings ?? await yearSettings(db, companyId, year);
  const p = await profileOf(db, companyId, employeeId, year);
  const reopened = p.declarationOpenUntil && p.declarationOpenUntil >= today();
  return { open: s.proofWindow === 'OPEN' || Boolean(reopened), window: { from: s.proofFrom, to: s.proofTo, state: s.proofWindow } };
}

async function lineRow(db, companyId, id, { employeeId = null } = {}) {
  const [[r]] = await db.query(`SELECT * FROM hrms_tax_declaration_lines WHERE company_id = ? AND id = ? AND deleted_at IS NULL${employeeId ? ' AND employee_id = ?' : ''} FOR UPDATE`,
    [companyId, id, ...(employeeId ? [employeeId] : [])]);
  if (!r) throw notFound('That declaration');
  return r;
}
export { lineRow };

/** The person's lines for a year, with files, the window, the kinds. */
export async function listLines(db, c, employeeId, year, { rules }) {
  const rows = await lineRows(db, c.companyId, [employeeId], year);
  const files = await filesOfLines(db, c.companyId, rows.map((r) => r.id));
  const settings = await yearSettings(db, c.companyId, year);
  return {
    employee: await employeeRow(db, c.companyId, employeeId).then((e) => ({ id: e.id, code: e.code, name: e.name })),
    year, lines: rows.map((r) => shapeLine(r, files.get(r.id))),
    declare: await canDeclare(db, c.companyId, employeeId, year, settings),
    prove: await canProve(db, c.companyId, employeeId, year, settings),
    kinds: kindsFor(rules),
    landlordPanAbove: rules?.NEW?.has('declarations') ? rules.NEW.get('declarations').landlordPanAbove : 100000,
    form: rules ? rules.NEW.get('forms').declaration.label : null,
    previousEmployerForm: rules ? rules.NEW.get('forms').previousEmployer.label : null,
  };
}

const mustDeclare = async (db, c, employeeId, year, by) => {
  if (by === 'HR') return;
  const can = await canDeclare(db, c.companyId, employeeId, year);
  if (!can.open) {
    throw refuse('WINDOW_CLOSED', can.window.state === 'NOT_YET'
      ? `Declarations for ${year} open on ${can.window.from}.`
      : `The declaration window for ${year} closed on ${can.window.to}. Ask HR to re-open it for you.`);
  }
};

export async function addLine(db, c, employeeId, year, body = {}, { rules, by = 'SELF', requestId = null }) {
  await mustDeclare(db, c, employeeId, year, by);
  const kind = String(body.kind ?? '').toUpperCase();
  const { declared, details } = readLine(kind, body, { year, rules });
  if (kind === 'PREVIOUS_EMPLOYER') {
    const [[dup]] = await db.query("SELECT COUNT(*) AS k FROM hrms_tax_declaration_lines WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND kind = 'PREVIOUS_EMPLOYER' AND deleted_at IS NULL", [c.companyId, employeeId, year]);
    if (Number(dup.k) >= 3) throw refuse('TOO_MANY', 'At most three previous employers in a year.');
  }
  const [ins] = await db.query(
    'INSERT INTO hrms_tax_declaration_lines (company_id, employee_id, tax_year, kind, declared_amount, details_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?, \'DECLARED\', ?)',
    [c.companyId, employeeId, year, kind, declared, JSON.stringify(details), c.userId]);
  await audit(db, c, 'hrms_tax_declaration_lines', ins.insertId, 'CREATE', null, { employeeId, year, kind, declared, by }, requestId);
  const [[r]] = await db.query('SELECT * FROM hrms_tax_declaration_lines WHERE id = ?', [ins.insertId]);
  return { line: shapeLine(r) };
}

export async function updateLine(db, c, lineId, body = {}, { rules, by = 'SELF', employeeId = null, requestId = null }) {
  const r = await lineRow(db, c.companyId, lineId, { employeeId });
  await mustDeclare(db, c, r.employee_id, r.tax_year, by);
  const merged = { amount: body.amount ?? r.declared_amount, details: { ...(json(r.details_json, {}) ?? {}), ...(body.details ?? {}) } };
  const { declared, details } = readLine(r.kind, merged, { year: r.tax_year, rules });
  const [[files]] = await db.query("SELECT COUNT(*) AS k FROM hrms_tax_files WHERE company_id = ? AND line_id = ? AND purpose = 'PROOF' AND deleted_at IS NULL", [c.companyId, lineId]);
  const changed = declared !== money(r.declared_amount) || JSON.stringify(details) !== JSON.stringify(json(r.details_json, {}));
  // A changed claim is looked at again: back to SUBMITTED (a proof is there) or DECLARED.
  const status = changed && ['VERIFIED', 'REJECTED'].includes(r.status) ? (Number(files.k) ? 'SUBMITTED' : 'DECLARED') : r.status;
  await db.query('UPDATE hrms_tax_declaration_lines SET declared_amount = ?, details_json = ?, status = ?, accepted_amount = IF(? = status, accepted_amount, NULL) WHERE company_id = ? AND id = ?',
    [declared, JSON.stringify(details), status, r.status, c.companyId, lineId]);
  await audit(db, c, 'hrms_tax_declaration_lines', lineId, 'UPDATE', { declared: money(r.declared_amount), status: r.status }, { declared, status, by }, requestId);
  const [[after]] = await db.query('SELECT * FROM hrms_tax_declaration_lines WHERE id = ?', [lineId]);
  return { line: shapeLine(after) };
}

export async function removeLine(db, c, lineId, { by = 'SELF', employeeId = null, requestId = null } = {}) {
  const r = await lineRow(db, c.companyId, lineId, { employeeId });
  await mustDeclare(db, c, r.employee_id, r.tax_year, by);
  if (by !== 'HR' && r.status === 'VERIFIED') throw refuse('VERIFIED', 'HR has verified this declaration. Ask HR to remove it.');
  await db.query("UPDATE hrms_tax_files SET deleted_at = NOW() WHERE company_id = ? AND line_id = ? AND purpose = 'PROOF' AND deleted_at IS NULL", [c.companyId, lineId]);
  await db.query('UPDATE hrms_tax_declaration_lines SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, lineId]);
  await audit(db, c, 'hrms_tax_declaration_lines', lineId, 'DELETE', { kind: r.kind, declared: money(r.declared_amount), status: r.status }, { by }, requestId);
  return { ok: true };
}

/* ── lines → the engine's claims ─────────────────────────────────────── */

/**
 * @param rows   the person's declaration rows of the year
 * @param closed the proof window closed before the month ended: VERIFIED only
 * @returns { deductions, exemptions, otherIncome, previousEmployer, used[] }
 */
export function claimsOf(rows, { closed = false, year } = {}) {
  const months = yearMonths(year);
  const deductions = {};
  const exemptions = {};
  const otherIncome = { savingsInterest: 0, depositInterest: 0, other: 0 };
  let previousEmployer = null;
  const used = [];
  const d80 = { selfFamily: 0, parents: 0, preventive: 0, selfFamilySenior: false, parentsSenior: false };
  for (const r of rows) {
    const k = KINDS[r.kind];
    if (!k) continue;
    const declared = n(r.declared_amount);
    const details = json(r.details_json, {}) ?? {};
    let amount;
    let how;
    if (r.kind === 'PREVIOUS_EMPLOYER') {
      amount = r.status === 'REJECTED' ? 0 : r.status === 'VERIFIED' && r.accepted_amount != null ? n(r.accepted_amount) : declared;
      how = r.status === 'REJECTED' ? 'rejected by HR' : r.status === 'VERIFIED' ? 'verified' : 'as stated (Form 12B / 122)';
    } else if (r.status === 'VERIFIED') { amount = n(r.accepted_amount ?? declared); how = 'verified'; } else if (r.status === 'REJECTED') { amount = 0; how = 'rejected by HR'; } else if (closed) { amount = 0; how = 'not proved — the proof window has closed'; } else { amount = declared; how = 'as declared'; }
    used.push({ lineId: r.id, kind: r.kind, label: k.label, group: k.group, declared, counted: money(amount), how });
    if (!amount) continue;
    switch (k.group) {
      case 'HRA': {
        const ratio = declared ? amount / declared : 0;
        const inRange = months.filter((m) => m >= (details.fromMonth ?? months[0]) && m <= (details.toMonth ?? months[11]));
        const prev = exemptions.hra?.rentPaid ?? [];
        const add = inRange.map((m) => ({ month: m, amount: money(n(details.monthlyRent) * ratio) }));
        const byMonth = new Map(prev.map((p) => [p.month, p.amount]));
        for (const a of add) byMonth.set(a.month, money((byMonth.get(a.month) ?? 0) + a.amount));
        exemptions.hra = { rentPaid: [...byMonth.entries()].map(([month, amt]) => ({ month, amount: amt })) };
        break;
      }
      case 'LTA': exemptions.lta = { claimed: n(exemptions.lta?.claimed) + amount, journeysUsedInBlock: details.journeysUsedInBlock ?? 0 }; break;
      case '24B': deductions['24B'] = n(deductions['24B']) + amount; break;
      case G80C: deductions['80C'] = n(deductions['80C']) + amount; break;
      case '80CCD1B': deductions['80CCD1B'] = n(deductions['80CCD1B']) + amount; break;
      case '80D':
        if (r.kind === 'MEDICAL_SELF') { d80.selfFamily += amount; if (details.senior) d80.selfFamilySenior = true; }
        if (r.kind === 'MEDICAL_PARENTS') { d80.parents += amount; if (details.parentsSenior) d80.parentsSenior = true; }
        if (r.kind === 'PREVENTIVE') d80.preventive += amount;
        break;
      case '80E': deductions['80E'] = n(deductions['80E']) + amount; break;
      case '80G': deductions['80G'] = n(deductions['80G']) + amount; break;
      case 'OTHER_INCOME':
        if (r.kind === 'SAVINGS_INTEREST') otherIncome.savingsInterest += amount;
        else if (r.kind === 'DEPOSIT_INTEREST') otherIncome.depositInterest += amount;
        else otherIncome.other += amount;
        break;
      case 'PREVIOUS': {
        const p = previousEmployer ?? { taxableSalary: 0, tds: 0, pt: 0, salary: 0, exemptions: 0, employers: [] };
        const ratio = declared ? amount / declared : 0;
        p.taxableSalary += amount;
        p.salary += n(details.salary) * ratio; p.exemptions += n(details.exemptions) * ratio;
        p.tds += r.status === 'REJECTED' ? 0 : n(details.tds);
        p.pt += r.status === 'REJECTED' ? 0 : n(details.pt);
        p.employers.push({ name: details.employerName, tan: details.tan });
        previousEmployer = p;
        break;
      }
      default: break;
    }
  }
  if (d80.selfFamily || d80.parents || d80.preventive) {
    deductions['80D'] = { selfFamily: d80.selfFamily, parents: d80.parents, preventive: d80.preventive, ...(d80.selfFamilySenior ? { selfFamilySenior: true } : {}), parentsSenior: d80.parentsSenior };
  }
  return { deductions, exemptions, otherIncome, previousEmployer, used };
}

export { dateText };
