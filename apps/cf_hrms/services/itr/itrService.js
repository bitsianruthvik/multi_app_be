/**
 * itrService.js — the person's own draft return (TM/CF_HRMS_HIRING_SPEC.md §25.6; init.sql §29).
 *
 * EVERY FUNCTION TAKES THE EMPLOYEE ID OF THE LOGIN (routes/itr.js finds it from req.user.id) —
 * none takes one from a request. There is no HR read: a return is private to the person.
 * Nothing here writes an audit row with the return's contents, and nothing is sent anywhere.
 *
 *   itrYears(db, c, employeeId, { today })            the years a return can be worked out for
 *   myReturn(db, c, employeeId, year, { today })      the draft (bank masked) + the computed return
 *   saveParts(db, c, employeeId, year, body, { today }) PUT: replaces the parts given; back to DRAFT
 *   finalise(db, c, employeeId, year, { today })      keeps a snapshot of the employer part
 *   removeReturn(db, c, employeeId, year)             "Start again": the row is deleted outright
 */
import { invalid, notFound, HrmsError } from '../../lib/errors.js';
import { loadTaxYear, yearBounds } from '../tax/rules.js';
import { computeReturn, DONATION_CATEGORIES } from '../tax/itr.js';
import { inr } from '../tax/engine.js';
import { employerPart } from './employerPart.js';
import { schemaFor } from './itrJson.js';
import { guideFor } from './guide.js';

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const json = (v, d = null) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };
const YEAR_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayIso = () => new Date().toISOString().slice(0, 10);
export const maskAccount = (v) => { const s = String(v ?? '').replace(/\s+/g, ''); return s ? `${'X'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}` : null; };

/* ── validation: every part is a whitelist; anything else is refused by name ── */
const MAX = 999999999999; // ₹ 99,999 crore — any typed amount above it is a typing slip
function reader(problems, where) {
  const amount = (v, label, { required = false } = {}) => {
    if (v === undefined || v === null || v === '') { if (required) problems.push(`${where}: ${label} is needed.`); return 0; }
    const x = Number(v);
    if (!Number.isFinite(x)) { problems.push(`${where}: ${label} must be a number.`); return 0; }
    if (x < 0) { problems.push(`${where}: ${label} cannot be negative.`); return 0; }
    if (x > MAX) { problems.push(`${where}: ${label} is too large.`); return 0; }
    return Math.round(x * 100) / 100;
  };
  const text = (v, label, max = 200) => {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim();
    if (s.length > max) { problems.push(`${where}: ${label} is longer than ${max} characters.`); return s.slice(0, max); }
    return s || null;
  };
  const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';
  const date = (v, label) => {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v);
    if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) { problems.push(`${where}: ${label} must be a date (YYYY-MM-DD).`); return null; }
    return s;
  };
  const only = (obj, keys) => {
    if (obj == null) return {};
    if (typeof obj !== 'object' || Array.isArray(obj)) { problems.push(`${where} must be an object.`); return {}; }
    for (const k of Object.keys(obj)) if (!keys.includes(k)) problems.push(`${where}: "${k}" is not something this return keeps.`);
    return obj;
  };
  const list = (v, label, max = 20) => {
    if (v == null) return [];
    if (!Array.isArray(v)) { problems.push(`${where}: ${label} must be a list.`); return []; }
    if (v.length > max) problems.push(`${where}: at most ${max} ${label}.`);
    return v.slice(0, max);
  };
  return { amount, text, bool, date, only, list };
}
/** The other exemptions of the certificate, by the ITR's own codes: gratuity, commuted pension, leave encashment, VRS. */
export const OTHER_EXEMPT = ['10(10)', '10(10A)', '10(10AA)', '10(10C)'];
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const BSR_RE = /^[0-9]{7}$/;

/** The ITR's employer categories: Central / State Govt, PSU, pensioners …, OTH = others (a private employer). */
export const EMPLOYER_CATEGORIES = ['CGOV', 'SGOV', 'PSU', 'PE', 'PESG', 'PEPS', 'PEO', 'OTH', 'NA'];
function cleanAddress(v, problems) {
  if (v == null) return null;
  const r = reader(problems, 'Your address');
  const x = r.only(v, ['flat', 'premises', 'road', 'area', 'city', 'stateCode', 'pinCode']);
  const state = x.stateCode ? String(x.stateCode).padStart(2, '0') : null;
  if (state && !/^(0[1-9]|[12][0-9]|3[0-7]|99)$/.test(state)) problems.push("Your address: the state code is the ITR's two-digit code (36 = Telangana).");
  const pin = r.text(x.pinCode, 'PIN code', 6);
  if (pin && !/^[1-9][0-9]{5}$/.test(pin)) problems.push('Your address: the PIN code is 6 digits.');
  return { flat: r.text(x.flat, 'flat / door', 50), premises: r.text(x.premises, 'building', 50), road: r.text(x.road, 'road', 50), area: r.text(x.area, 'area', 50), city: r.text(x.city, 'city', 50), stateCode: state, pinCode: pin };
}

export function cleanParts(body, year, current = {}) {
  const problems = [];
  const out = {};
  const top = reader(problems, 'The return').only(body, ['personal', 'employer', 'income', 'deductions', 'taxes', 'bank', 'choices']);
  const { start, end, endYear } = yearBounds(year);

  if (top.personal !== undefined) {
    const r = reader(problems, 'About you');
    const p = r.only(top.personal, ['residentialStatus', 'dateOfBirth', 'agriculturalIncome', 'isDirector', 'unlistedShares', 'foreignAssetsOrIncome', 'broughtForwardLosses', 'fatherName', 'mobile', 'email', 'employerCategory', 'address']);
    const status = String(p.residentialStatus ?? 'RESIDENT').toUpperCase();
    if (!['RESIDENT', 'RNOR', 'NON_RESIDENT'].includes(status)) problems.push('About you: residential status is RESIDENT, RNOR or NON_RESIDENT.');
    out.personal = {
      residentialStatus: status, dateOfBirth: r.date(p.dateOfBirth, 'date of birth'), agriculturalIncome: r.amount(p.agriculturalIncome, 'agricultural income'),
      isDirector: r.bool(p.isDirector), unlistedShares: r.bool(p.unlistedShares), foreignAssetsOrIncome: r.bool(p.foreignAssetsOrIncome), broughtForwardLosses: r.bool(p.broughtForwardLosses),
      fatherName: r.text(p.fatherName, "father's name", 125), mobile: r.text(p.mobile, 'mobile', 10), email: r.text(p.email, 'email', 125),
      employerCategory: EMPLOYER_CATEGORIES.includes(String(p.employerCategory ?? 'OTH')) ? String(p.employerCategory ?? 'OTH') : (problems.push('About you: the employer category is one of ' + EMPLOYER_CATEGORIES.join(', ') + '.'), 'OTH'),
      address: cleanAddress(p.address, problems),
    };
    if (out.personal.mobile && !/^[1-9][0-9]{9}$/.test(out.personal.mobile)) problems.push('About you: the mobile number is 10 digits.');
    if (out.personal.email && !/^[.a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+(.[a-zA-Z0-9_-]+)+$/.test(out.personal.email)) problems.push('About you: the email address does not look right.');
  }
  if (top.employer !== undefined) {
    const r = reader(problems, 'From your employer');
    const e = r.only(top.employer, ['useTyped', 'matchesCertificate', 'employerName', 'tan', 'grossSalary', 'perquisites', 'exemptHra', 'exemptLta', 'exemptOther', 'exemptOtherSection', 'professionalTax', 'tds', 'employerNps', 'basic', 'da', 'previous']);
    const optional = (v, label) => (v === undefined || v === null || v === '' ? null : r.amount(v, label));
    const tan = r.text(e.tan, 'TAN', 10)?.toUpperCase() ?? null;
    if (tan && !TAN_RE.test(tan)) problems.push('From your employer: the TAN is 4 letters, 5 digits and a letter (as on the certificate).');
    const pv = reader(problems, 'Previous employer').only(e.previous ?? {}, ['name', 'tan', 'salary', 'professionalTax', 'tds']);
    const rp = reader(problems, 'Previous employer');
    const ptan = rp.text(pv.tan, 'TAN', 10)?.toUpperCase() ?? null;
    if (ptan && !TAN_RE.test(ptan)) problems.push('Previous employer: the TAN is 4 letters, 5 digits and a letter.');
    out.employer = {
      useTyped: r.bool(e.useTyped), matchesCertificate: r.bool(e.matchesCertificate), employerName: r.text(e.employerName, 'employer name'), tan,
      grossSalary: r.amount(e.grossSalary, 'gross salary'), perquisites: r.amount(e.perquisites, 'perquisites'), exemptHra: r.amount(e.exemptHra, 'HRA exempt'), exemptLta: r.amount(e.exemptLta, 'leave travel exempt'),
      exemptOtherSection: OTHER_EXEMPT.includes(String(e.exemptOtherSection ?? '10(10)')) ? String(e.exemptOtherSection ?? '10(10)') : (problems.push('From your employer: the other exempt allowance is one of ' + OTHER_EXEMPT.join(', ') + '.'), '10(10)'),
      exemptOther: r.amount(e.exemptOther, 'other exempt allowances'), professionalTax: r.amount(e.professionalTax, 'professional tax'), tds: r.amount(e.tds, 'TDS'),
      employerNps: r.amount(e.employerNps, "employer's NPS contribution"),
      // Basic and DA for the year: empty = take them from the released payslips (itr.js salaryBlock).
      basic: optional(e.basic, 'Basic for the year'), da: optional(e.da, 'DA for the year'),
      previous: e.previous ? { name: rp.text(pv.name, 'name'), tan: ptan, salary: rp.amount(pv.salary, 'salary'), professionalTax: rp.amount(pv.professionalTax, 'professional tax'), tds: rp.amount(pv.tds, 'TDS') } : null,
    };
  }
  if (top.income !== undefined) {
    const r = reader(problems, 'Other income');
    const i = r.only(top.income, ['savingsInterest', 'depositInterest', 'dividends', 'other', 'houseProperties', 'capitalGains']);
    const hp = r.list(i.houseProperties, 'house properties', 10).map((h, k) => {
      const rh = reader(problems, `House property ${k + 1}`);
      const x = rh.only(h, ['kind', 'name', 'rentReceived', 'municipalTaxPaid', 'interest', 'lenderName']);
      const kind = String(x.kind ?? 'LET_OUT').toUpperCase();
      if (!['LET_OUT', 'SELF_OCCUPIED'].includes(kind)) problems.push(`House property ${k + 1}: it is LET_OUT or SELF_OCCUPIED.`);
      return { kind, name: rh.text(x.name, 'name or address', 200), rentReceived: kind === 'LET_OUT' ? rh.amount(x.rentReceived, 'rent received') : 0, municipalTaxPaid: kind === 'LET_OUT' ? rh.amount(x.municipalTaxPaid, 'municipal tax paid') : 0, interest: rh.amount(x.interest, 'interest on the home loan'), lenderName: rh.text(x.lenderName, 'lender', 200) };
    });
    const rc = reader(problems, 'Capital gains');
    const cgi = rc.only(i.capitalGains ?? {}, ['stcg111A', 'ltcg112A', 'ltcg112', 'stcgOther', 'ltcg112ASale', 'ltcg112ACost']);
    out.income = {
      savingsInterest: r.amount(i.savingsInterest, 'savings-account interest'), depositInterest: r.amount(i.depositInterest, 'deposit interest'), dividends: r.amount(i.dividends, 'dividends'),
      other: r.list(i.other, 'other incomes').map((o, k) => { const ro = reader(problems, `Other income ${k + 1}`); const x = ro.only(o, ['description', 'amount']); return { description: ro.text(x.description, 'description', 120), amount: ro.amount(x.amount, 'amount', { required: true }) }; }),
      houseProperties: hp,
      capitalGains: { stcg111A: rc.amount(cgi.stcg111A, 'short-term equity gains'), ltcg112A: rc.amount(cgi.ltcg112A, 'long-term equity gains'), ltcg112: rc.amount(cgi.ltcg112, 'other long-term gains'), stcgOther: rc.amount(cgi.stcgOther, 'other short-term gains'), ltcg112ASale: rc.amount(cgi.ltcg112ASale, 'sale value (112A)'), ltcg112ACost: rc.amount(cgi.ltcg112ACost, 'cost (112A)') },
    };
  }
  if (top.deductions !== undefined) {
    const r = reader(problems, 'Deductions');
    const d = r.only(top.deductions, ['80C', '80CItems', '80CCD1B', '80D', '80E', '80ELoans', '80G', '80GDonations', 'hra']);
    const r80d = reader(problems, 'Health insurance (80D)');
    const dd = r80d.only(d['80D'] ?? {}, ['selfFamily', 'parents', 'selfFamilySenior', 'parentsSenior', 'preventive', 'policies']);
    // The details the ITR's schedules ask for (CBDT ITR-1 AY 2026-27 validation rules 8, 138, 235–259,
    // 241–248, 254, 265, 325). Optional here; a list, when given, is the claim (itr.js deductionsOf),
    // and the JSON asks for what is missing.
    const c80 = r.list(d['80CItems'], '80C lines', 30).map((x, k) => {
      const rx = reader(problems, `80C line ${k + 1}`);
      const o = rx.only(x, ['description', 'documentNo', 'amount']);
      return { description: rx.text(o.description, 'what it is', 120), documentNo: rx.text(o.documentNo, 'policy / document number', 50), amount: rx.amount(o.amount, 'amount', { required: true }) };
    });
    const policies = r80d.list(dd.policies, 'health-insurance policies', 20).map((x, k) => {
      const rx = reader(problems, `Health-insurance policy ${k + 1}`);
      const o = rx.only(x, ['for', 'insurer', 'policyNo', 'amount']);
      const forWho = String(o.for ?? 'SELF_FAMILY').toUpperCase();
      if (!['SELF_FAMILY', 'PARENTS'].includes(forWho)) problems.push(`Health-insurance policy ${k + 1}: it is for SELF_FAMILY or PARENTS.`);
      return { for: forWho, insurer: rx.text(o.insurer, 'insurer', 125), policyNo: rx.text(o.policyNo, 'policy number', 75), amount: rx.amount(o.amount, 'premium paid', { required: true }) };
    });
    const loans = r.list(d['80ELoans'], 'education loans', 10).map((x, k) => {
      const rx = reader(problems, `Education loan ${k + 1}`);
      const o = rx.only(x, ['lenderType', 'lender', 'loanAccount', 'loanDate', 'loanAmount', 'outstanding', 'interest']);
      const lenderType = String(o.lenderType ?? 'B').toUpperCase();
      if (!['B', 'I'].includes(lenderType)) problems.push(`Education loan ${k + 1}: the lender is B (a bank) or I (an approved institution).`);
      const acc = rx.text(o.loanAccount, 'loan account number', 20);
      if (acc && !/^[a-zA-Z0-9][a-zA-Z0-9/-]*$/.test(acc)) problems.push(`Education loan ${k + 1}: the loan account number is letters, digits, / and - (as the ITR asks).`);
      return { lenderType, lender: rx.text(o.lender, 'bank or institution', 125), loanAccount: acc, loanDate: rx.date(o.loanDate, 'date of the loan'), loanAmount: rx.amount(o.loanAmount, 'loan amount'), outstanding: rx.amount(o.outstanding, 'amount outstanding'), interest: rx.amount(o.interest, 'interest paid in the year', { required: true }) };
    });
    const gifts = r.list(d['80GDonations'], 'donations', 20).map((x, k) => {
      const rx = reader(problems, `Donation ${k + 1}`);
      const o = rx.only(x, ['name', 'pan', 'address', 'city', 'stateCode', 'pinCode', 'category', 'cash', 'otherMode', 'transactionRef', 'ifsc', 'arn', 'eligible']);
      const category = String(o.category ?? 'LIMIT_50').toUpperCase();
      if (!Object.keys(DONATION_CATEGORIES).includes(category)) problems.push(`Donation ${k + 1}: the kind is one of ${Object.keys(DONATION_CATEGORIES).join(', ')}.`);
      const pan = rx.text(o.pan, "donee's PAN", 10)?.toUpperCase() ?? null;
      if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) problems.push(`Donation ${k + 1}: the donee's PAN is 5 letters, 4 digits and a letter.`);
      const ifsc = rx.text(o.ifsc, 'IFSC', 11)?.toUpperCase() ?? null;
      if (ifsc && !IFSC_RE.test(ifsc)) problems.push(`Donation ${k + 1}: the IFSC is 4 letters, a 0 and 6 letters or digits.`);
      const state = o.stateCode ? String(o.stateCode).padStart(2, '0') : null;
      if (state && !/^(0[1-9]|[12][0-9]|3[0-7])$/.test(state)) problems.push(`Donation ${k + 1}: the state code is the ITR's two-digit code.`);
      const pin = rx.text(o.pinCode, 'PIN code', 6);
      if (pin && !/^[1-9][0-9]{5}$/.test(pin)) problems.push(`Donation ${k + 1}: the PIN code is 6 digits.`);
      return {
        name: rx.text(o.name, "donee's name", 125), pan, address: rx.text(o.address, 'address', 200), city: rx.text(o.city, 'city', 50), stateCode: state, pinCode: pin, category,
        cash: rx.amount(o.cash, 'cash'), otherMode: rx.amount(o.otherMode, 'other than cash'), transactionRef: rx.text(o.transactionRef, 'transaction reference', 50), ifsc, arn: rx.text(o.arn, 'ARN', 25),
        eligible: o.eligible === undefined || o.eligible === null || o.eligible === '' ? null : rx.amount(o.eligible, 'eligible amount'),
      };
    });
    const rh = reader(problems, 'HRA');
    const h = rh.only(d.hra ?? {}, ['placeOfWork', 'rentPaid', 'received']);
    out.deductions = {
      '80C': r.amount(d['80C'], '80C'), '80CItems': c80, '80CCD1B': r.amount(d['80CCD1B'], '80CCD(1B)'),
      '80E': r.amount(d['80E'], '80E'), '80ELoans': loans, '80G': r.amount(d['80G'], '80G'), '80GDonations': gifts,
      '80D': {
        selfFamily: r80d.amount(dd.selfFamily, 'self and family'), parents: r80d.amount(dd.parents, 'parents'),
        selfFamilySenior: dd.selfFamilySenior === undefined || dd.selfFamilySenior === null || dd.selfFamilySenior === '' ? null : r80d.bool(dd.selfFamilySenior),
        parentsSenior: r80d.bool(dd.parentsSenior), preventive: r80d.amount(dd.preventive, 'preventive check-up'), policies,
      },
      hra: { placeOfWork: rh.text(h.placeOfWork, 'city where you work', 50), rentPaid: rh.amount(h.rentPaid, 'rent paid in the year'), received: h.received === undefined || h.received === null || h.received === '' ? null : rh.amount(h.received, 'HRA received') },
    };
  }
  if (top.taxes !== undefined) {
    const r = reader(problems, 'Taxes paid');
    const t = r.only(top.taxes, ['paid', 'otherTds']);
    out.taxes = {
      paid: r.list(t.paid, 'challans', 30).map((x, k) => {
        const rx = reader(problems, `Challan ${k + 1}`);
        const o = rx.only(x, ['kind', 'bsrCode', 'date', 'challanNo', 'amount']);
        const kind = String(o.kind ?? 'SELF_ASSESSMENT').toUpperCase();
        if (!['ADVANCE', 'SELF_ASSESSMENT'].includes(kind)) problems.push(`Challan ${k + 1}: the kind is ADVANCE or SELF_ASSESSMENT.`);
        const bsr = rx.text(o.bsrCode, 'BSR code', 7);
        if (bsr && !BSR_RE.test(bsr)) problems.push(`Challan ${k + 1}: the BSR code is 7 digits.`);
        const dt = rx.date(o.date, 'date');
        if (dt && kind === 'ADVANCE' && (dt < start || dt > end)) problems.push(`Challan ${k + 1}: advance tax for ${year} is paid between ${start} and ${end}; after that it is self-assessment tax.`);
        if (dt && kind === 'SELF_ASSESSMENT' && dt < `${endYear}-04-01`) problems.push(`Challan ${k + 1}: self-assessment tax is paid after the year ends (from ${endYear}-04-01); before that it is advance tax.`);
        const serial = rx.text(o.challanNo, 'challan number', 5);
        if (serial && !/^[0-9]{1,5}$/.test(serial)) problems.push(`Challan ${k + 1}: the challan serial number is up to 5 digits.`);
        return { kind, bsrCode: bsr, date: dt, challanNo: serial, amount: rx.amount(o.amount, 'amount', { required: true }) };
      }),
      otherTds: r.list(t.otherTds, 'TDS / TCS entries', 30).map((x, k) => {
        const rx = reader(problems, `TDS / TCS ${k + 1}`);
        const o = rx.only(x, ['kind', 'deductor', 'tan', 'section', 'income', 'amount']);
        const kind = String(o.kind ?? 'TDS').toUpperCase();
        if (!['TDS', 'TCS'].includes(kind)) problems.push(`TDS / TCS ${k + 1}: the kind is TDS or TCS.`);
        const tan = rx.text(o.tan, 'TAN', 10)?.toUpperCase() ?? null;
        if (tan && !TAN_RE.test(tan)) problems.push(`TDS / TCS ${k + 1}: the TAN is 4 letters, 5 digits and a letter.`);
        return { kind, deductor: rx.text(o.deductor, 'who deducted', 125), tan, section: rx.text(o.section, 'section', 20), income: rx.amount(o.income, 'income'), amount: rx.amount(o.amount, 'amount', { required: true }) };
      }),
    };
  }
  if (top.bank !== undefined) {
    const r = reader(problems, 'Bank account');
    const b = r.only(top.bank, ['bankName', 'ifsc', 'account', 'type']);
    const ifsc = r.text(b.ifsc, 'IFSC', 11)?.toUpperCase() ?? null;
    if (ifsc && !IFSC_RE.test(ifsc)) problems.push('Bank account: the IFSC is 4 letters, a 0 and 6 letters or digits.');
    let account = r.text(b.account, 'account number', 20);
    if (account && !/^[0-9A-Za-z]{5,20}$/.test(account)) problems.push('Bank account: the account number is 5 to 20 letters or digits.');
    if (!account) account = current.bank?.account ?? null; // the screen shows it masked; empty = keep it
    const type = String(b.type ?? 'SAVINGS').toUpperCase();
    if (!['SAVINGS', 'CURRENT'].includes(type)) problems.push('Bank account: the type is SAVINGS or CURRENT.');
    out.bank = { bankName: r.text(b.bankName, 'bank name', 125), ifsc, account, type };
  }
  if (top.choices !== undefined) {
    const r = reader(problems, 'Choices');
    const ch = r.only(top.choices, ['form', 'regime', 'filingDate']);
    const form = ch.form ? String(ch.form).toUpperCase().replace('-', '') : null;
    if (form && !['ITR1', 'ITR2'].includes(form)) problems.push('Choices: the form is ITR1 or ITR2.');
    const regime = ch.regime ? String(ch.regime).toUpperCase() : null;
    if (regime && !['OLD', 'NEW'].includes(regime)) problems.push('Choices: the regime is OLD or NEW.');
    const fd = r.date(ch.filingDate, 'filing date');
    if (fd && fd < `${endYear}-04-01`) problems.push(`Choices: a return for ${year} is filed from ${endYear}-04-01.`);
    out.choices = { form, regime, filingDate: fd };
  }
  if (problems.length) throw invalid('INVALID', problems.length === 1 ? problems[0] : 'Some figures need attention.', { problems });
  return out;
}

/* ── reading ───────────────────────────────────────────────────────────── */
async function rowOf(db, companyId, employeeId, year, { forUpdate = false } = {}) {
  const [[r]] = await db.query(`SELECT * FROM hrms_itr_returns WHERE company_id = ? AND employee_id = ? AND tax_year = ?${forUpdate ? ' FOR UPDATE' : ''}`, [companyId, employeeId, year]);
  return r ?? null;
}
const partsOf = (r) => (r ? {
  personal: json(r.personal_json, {}), employer: json(r.employer_json, {}), income: json(r.income_json, {}), deductions: json(r.deductions_json, {}),
  taxes: json(r.taxes_json, {}), bank: json(r.bank_json, {}), choices: { form: r.form ?? null, regime: r.regime ?? null, filingDate: r.filing_date ? String(r.filing_date).slice(0, 10) : null },
} : { personal: {}, employer: {}, income: {}, deductions: {}, taxes: {}, bank: {}, choices: {} });

async function personOf(db, companyId, employeeId) {
  const [[e]] = await db.query('SELECT id, employee_code, full_name, date_of_birth FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, employeeId]);
  if (!e) throw notFound('Your employee record');
  const [ids] = await db.query(
    `SELECT identifier_value FROM hrms_employee_identifiers WHERE company_id = ? AND employee_id = ? AND identifier_type = 'PAN' AND deleted_at IS NULL
        AND (valid_to IS NULL OR valid_to >= CURDATE()) ORDER BY valid_from DESC, id DESC LIMIT 1`, [companyId, employeeId]);
  const pan = ids[0]?.identifier_value ? String(ids[0].identifier_value).trim().toUpperCase() : null;
  return { name: e.full_name, code: e.employee_code, dateOfBirth: e.date_of_birth ? String(e.date_of_birth).slice(0, 10) : null, pan };
}

/** The years with rules in hrms_tax_rules that include the return's rules. */
async function seededYears(db) {
  const [rows] = await db.query("SELECT DISTINCT tax_year FROM hrms_tax_rules WHERE rule_key = 'return_filing' AND deleted_at IS NULL AND status = 'PUBLISHED' ORDER BY tax_year DESC");
  return rows.map((r) => r.tax_year);
}

export async function itrYears(db, c, employeeId, { today = todayIso() } = {}) {
  const years = await seededYears(db);
  const [drafts] = await db.query('SELECT tax_year, status, updated_at FROM hrms_itr_returns WHERE company_id = ? AND employee_id = ?', [c.companyId, employeeId]);
  const out = [];
  for (const year of years) {
    const rules = await loadTaxYear(db, year);
    const due = rules.NEW.get('return_filing');
    const forms = rules.NEW.get('itr_forms');
    const { endYear } = yearBounds(year);
    const emp = await employerPart(db, c.companyId, employeeId, year, { today });
    const d = drafts.find((x) => x.tax_year === year);
    const schema = schemaFor(year);
    out.push({
      year, assessmentYear: `${endYear}-${String((endYear + 1) % 100).padStart(2, '0')}`, act: rules.NEW.get('forms').act, filedFrom: `${endYear}-04-01`, dueDate: due.dueDate,
      yearOver: today > `${endYear}-03-31`, formsPublished: forms.published, formsNote: forms.note,
      payslipMonths: emp.monthList.length, draft: d ? { status: d.status, updatedAt: d.updated_at } : null,
      jsonAvailable: Boolean(schema), certificate: rules.NEW.get('forms').certificate.label,
    });
  }
  return { years: out, today };
}

function shapeDraft(parts) {
  const b = parts.bank ?? {};
  return { ...parts, bank: { bankName: b.bankName ?? null, ifsc: b.ifsc ?? null, type: b.type ?? 'SAVINGS', accountMasked: maskAccount(b.account), hasAccount: Boolean(b.account) } };
}

/** The draft and the worked-out return. A finalised return computes from its snapshot of the employer part. */
export async function myReturn(db, c, employeeId, year, { today = todayIso() } = {}) {
  if (!YEAR_RE.test(String(year))) throw invalid('INVALID', 'A tax year is written like 2025-26.');
  yearBounds(year);
  const years = await seededYears(db);
  if (!years.includes(year)) throw new HrmsError(404, 'NO_RULES', `There are no return rules for ${year} yet.`);
  const [rules, row, person] = await Promise.all([loadTaxYear(db, year), rowOf(db, c.companyId, employeeId, year), personOf(db, c.companyId, employeeId)]);
  const parts = partsOf(row);
  if (!parts.personal.dateOfBirth && person.dateOfBirth) parts.personal = { ...parts.personal, dateOfBirth: person.dateOfBirth };
  const finalised = row?.status === 'FINALISED';
  const live = await employerPart(db, c.companyId, employeeId, year, { today });
  const employer = finalised ? json(row.snapshot_json, live) : live;
  const result = computeReturn({ year, parts, employer, today }, rules);
  const schema = schemaFor(year);
  return {
    year, status: row?.status ?? 'NEW', saved: Boolean(row), updatedAt: row?.updated_at ?? null, finalisedAt: row?.finalised_at ?? null,
    person: { name: person.name, code: person.code, panMasked: person.pan ? maskAccount(person.pan) : null, hasPan: Boolean(person.pan) },
    draft: shapeDraft(parts), employer, result,
    json: { available: Boolean(schema), form: schema?.[result.form.form] ? result.form.form : null, version: schema?.[result.form.form]?.version ?? null, note: schema ? null : 'The e-filing JSON schema for this year is not in the app; use the guide.' },
    guide: guideFor(result, parts),
    notice: 'This app does not file your return. Upload or type this on incometax.gov.in, then e-verify within the time allowed.',
  };
}

/* ── writing ───────────────────────────────────────────────────────────── */
const COL = { personal: 'personal_json', employer: 'employer_json', income: 'income_json', deductions: 'deductions_json', taxes: 'taxes_json', bank: 'bank_json' };

export async function saveParts(db, c, employeeId, year, body, { today = todayIso() } = {}) {
  if (!YEAR_RE.test(String(year))) throw invalid('INVALID', 'A tax year is written like 2025-26.');
  const years = await seededYears(db);
  if (!years.includes(year)) throw new HrmsError(404, 'NO_RULES', `There are no return rules for ${year} yet.`);
  const row = await rowOf(db, c.companyId, employeeId, year, { forUpdate: true });
  const clean = cleanParts(body ?? {}, year, partsOf(row));
  if (!Object.keys(clean).length) throw invalid('INVALID', 'Nothing to save.');
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(COL)) if (clean[k] !== undefined) { sets.push(`${col} = ?`); vals.push(JSON.stringify(clean[k])); }
  if (clean.choices) { sets.push('form = ?', 'regime = ?', 'filing_date = ?'); vals.push(clean.choices.form, clean.choices.regime, clean.choices.filingDate); }
  if (row) {
    await db.query(`UPDATE hrms_itr_returns SET ${sets.join(', ')}, status = 'DRAFT', snapshot_json = NULL, finalised_at = NULL WHERE id = ?`, [...vals, row.id]);
  } else {
    const cols = sets.map((s) => s.split(' = ')[0]);
    await db.query(`INSERT INTO hrms_itr_returns (company_id, employee_id, tax_year, created_by, ${cols.join(', ')}) VALUES (?, ?, ?, ?, ${cols.map(() => '?').join(', ')})`,
      [c.companyId, employeeId, year, c.userId, ...vals]);
  }
  return myReturn(db, c, employeeId, year, { today });
}

export async function finalise(db, c, employeeId, year, { today = todayIso() } = {}) {
  const row = await rowOf(db, c.companyId, employeeId, year, { forUpdate: true });
  if (!row) throw invalid('NOTHING_SAVED', 'Save your return before you finalise it.');
  const live = await employerPart(db, c.companyId, employeeId, year, { today });
  await db.query("UPDATE hrms_itr_returns SET status = 'FINALISED', snapshot_json = ?, finalised_at = NOW() WHERE id = ?", [JSON.stringify(live), row.id]);
  return myReturn(db, c, employeeId, year, { today });
}

/** A hard DELETE on purpose (privacy): the row's deleted_at column exists only for the suites' snapshots and stays NULL. */
export async function removeReturn(db, c, employeeId, year) {
  const [r] = await db.query('DELETE FROM hrms_itr_returns WHERE company_id = ? AND employee_id = ? AND tax_year = ?', [c.companyId, employeeId, year]);
  return { removed: r.affectedRows };
}

/** For the PDF and the JSON: the unmasked parts (bank account, PAN) — the person's own, for their own file. */
export async function fullReturn(db, c, employeeId, year, { today = todayIso() } = {}) {
  const view = await myReturn(db, c, employeeId, year, { today });
  const row = await rowOf(db, c.companyId, employeeId, year);
  const person = await personOf(db, c.companyId, employeeId);
  return { ...view, parts: partsOf(row), personFull: person, amountWords: inr };
}

export const _test = { cleanParts, n };
