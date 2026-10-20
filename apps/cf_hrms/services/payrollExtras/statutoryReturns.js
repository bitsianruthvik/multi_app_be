/**
 * statutoryReturns.js — the month's statutory return files, made from the LOCKED payroll run of the
 * month. (TM/CF_HRMS_HIRING_SPEC.md §25.5 "Statutory files"; §28.6 NCP / ESI days.) Reads only.
 *
 *   PF   the EPFO ECR 2.0 text file (one line a member, fields joined by #~#, no header) — layout in
 *        ecrLine() below, with its source;
 *   ESI  the ESIC portal's monthly contribution upload (IP number, IP name, days, total wages, reason
 *        code for zero days, last working day) — esiWorkbook();
 *   PT   Telangana professional tax: the month's figures per slab (employees, rate, tax deducted) for
 *        the employer's monthly return — ptWorkbook().
 *
 * WHERE EACH NUMBER COMES FROM
 *   wages and contributions   the run's own lines and totals (hrms_pay_run_people / _lines): gross,
 *                             PF wage, ESI wage, PF (employee), PF (employer) = EPS + EPF difference (its
 *                             basis text "EPS x + EPF y", as calc.js writes it), ESI, PT;
 *   EPF / EPS / EDLI wages    the PF wage capped at the PF ceiling in force on the 1st of the month (the
 *                             whole wage for pf_mode FULL); EPS and EDLI wages always capped; EPS wages 0
 *                             when the run gave no EPS (past 58, or not an EPS member);
 *   NCP days / ESI days       the attendance month (attendance/month.js) when attendance is live and the
 *                             month is CLOSED by HR; otherwise the run's LOP days / payable days;
 *   UAN / IP number           the person's identifiers UAN and ESI (People › identifiers), as P1 does
 *                             for BANK_ACCOUNT / IFSC / PAN.
 * Nothing here recalculates pay; a person without a UAN or IP number is listed, not guessed.
 */
import ExcelJS from 'exceljs';
import { HrmsError } from '../../lib/errors.js';
import { attendanceMonth } from '../attendance/month.js';
import { companySettings, statutoryOn, identifiersOf, json } from '../payroll/common.js';
import { roundBy } from '../payroll/statutory.js';

const FROZEN = ['LOCKED', 'RELEASED', 'PAID'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r0 = (v) => Math.round(n(v));
const MONTH_WORDS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthWords = (m) => `${MONTH_WORDS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const lastDay = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
const ddmmyyyy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const dateText = (v) => (v ? (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10)) : null);

/* ── the layouts, with their sources ──────────────────────────────────── */

export const FORMATS = {
  ECR: {
    name: 'EPFO ECR 2.0 (Electronic Challan cum Return) text file',
    fields: ['UAN', 'Member name', 'Gross wages', 'EPF wages', 'EPS wages', 'EDLI wages', 'EPF contribution (EE share) remitted', 'EPS contribution remitted', 'EPF-EPS difference (ER share) remitted', 'NCP days', 'Refund of advances'],
    separator: '#~#',
    rules: 'One line a member, no header or trailer, plain text (.txt), every number a whole number, the 11 fields in this order joined by #~#. EPF wages not more than gross; EPS and EDLI wages capped at the ceiling, EPS wages 0 for a member outside EPS (past 58); NCP days whole days (all the days of the month when nothing was earned). Upload at the EPFO Unified Portal (employer) › ECR upload; the EDLI and admin charges and the counts are typed there at "Prepare challan". Arrears of earlier months go in a separate arrear ECR (8 fields), not this file.',
    source: 'EPFO "Introduction to ECR 2.0" (the ECR II table: UAN, Name, Gross, EPF, EPS, EDLI wages, EE share, EPS contribution, ER share, NCP days, Refunds, with its validations) — https://www.epfindia.gov.in/site_docs/PDFs/EPFOUnifiedPortal/Introduction_ECR2.0.pdf (read on the Wayback Machine copy of Dec 2024; the live site now moves to epfo.gov.in); the #~# separator and the .txt file from EPFO "ECR for employers — file structure" — https://epfindia.gov.in/site_docs/PDFs/OnlineECR_PDFs/ECR_ForEmployers_FileStructure.pdf',
    verified: true,
  },
  ESI: {
    name: 'ESIC monthly contribution upload (Excel)',
    columns: ['IP Number(10Digits)', 'IP Name( Only alphabets and space )', 'No of Days for which wages paid/payable during the month', 'Total Monthly Wages', 'Reason Code for Zero workings days(numeric only; provide 0 for all other reasons- Click on the link for reference)', 'Last Working Day( Format DD/MM/YYYY  or DD-MM-YYYY)'],
    reasons: { 0: 'Without reason', 1: 'On leave', 2: 'Left service', 3: 'Retired', 4: 'Out of coverage', 5: 'Expired', 6: 'Non implemented area', 7: 'Compliance by immediate employer', 8: 'Suspension of work', 9: 'Strike / lockout', 10: 'Retrenchment', 11: 'No work', 12: 'Does not belong to this employer', 13: 'Duplicate IP' },
    lastDayFor: [2, 3, 4, 5, 6, 10],
    rules: 'One row an insured person under the header row; EVERY IP mapped to the employer must be in the sheet; days in whole days (a part day rounds UP); wages in whole rupees (the portal works out the contributions); a reason code only when days are 0 (0 otherwise); the last working day only when days are 0 and the reason is left service, retired, out of coverage, expired, non-implemented area or retrenchment; all cells as text. The portal asks for an .xls (Excel 97-2003): this file is .xlsx with the same columns — open it in Excel and Save As "Excel 97-2003 Workbook" before uploading at the ESIC portal › Monthly Contribution › Upload.',
    source: 'ESIC portal monthly contribution template (columns and its instruction sheet) — not reachable without an employer login; read on secondary copies that agree: Odoo l10n_in_hr_payroll report_hr_esic.py, github shrutilenka/compliance-reports esi/uploadFormat.html, docs.pockethrms.com/report-generation/esi-return-file. Due by the 15th of the next month.',
    verified: false,
  },
  PT: {
    name: 'Telangana professional tax — monthly return figures (Form V)',
    rules: 'Per slab of monthly salary: the number of employees, the rate, the tax deducted; the total paid by the 10th of the next month, the return (Form V) filed with it. Enter these on the Telangana commercial taxes portal (tgct.gov.in); no upload file format is published, so this is a worksheet, not an import file.',
    source: 'Telangana Tax on Professions, Trades, Callings and Employments Act 1987: First Schedule entry 1 (up to ₹15,000 nil, ₹15,001–20,000 ₹150, above ₹20,000 ₹200 a month) https://tgct.gov.in/tgportal/AllActs/APPT/APPTSchedule.aspx; s.7(1) and rule 12, Form V (month ending, employer, address, RC No., employees; per slab: number of employees, rate of tax a month, amount deducted; total, interest 2% a month u/s 11, challan) https://tgct.gov.in/tgportal/AllActs/APPT/forms/form5.html — the printed form still shows the old six slab rows, so the three of the schedule are used. Due by the 10th of the next month: secondary sources only.',
    verified: true,
  },
};

/**
 * The ESI reason code and last working day of a row: a reason only for 0 days — left service (2) when the
 * person left by the month's end, on leave (1) when the month was loss of pay, else without reason (0); the
 * last working day only with 0 days and a reason that asks for it.
 */
export function esiReasonFor({ days, exit, monthEnd, lopDays }) {
  const left = Boolean(exit && exit <= monthEnd);
  const reason = days === 0 ? (left ? 2 : Number(lopDays) > 0 ? 1 : 0) : 0;
  return { reason, lastWorkingDay: days === 0 && left && FORMATS.ESI.lastDayFor.includes(reason) ? exit : null };
}

/** One ECR line (whole rupees, #~# between fields). */
export function ecrLine(r) {
  return [r.uan, r.name, r0(r.grossWages), r0(r.epfWages), r0(r.epsWages), r0(r.edliWages), r0(r.epfEe), r0(r.eps), r0(r.epfDiff), r0(r.ncpDays), r0(r.refund ?? 0)].join(FORMATS.ECR.separator);
}
/** The name as EPFO and ESIC take it: letters, spaces and dots, upper case, single spaces. */
export const cleanName = (s, { dots = true } = {}) => String(s ?? '').replace(dots ? /[^A-Za-z. ]/g : /[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 85);

/* ── the month ────────────────────────────────────────────────────────── */

async function runOf(db, companyId, month) {
  const [[r]] = await db.query('SELECT id, period_month, status, locked_at FROM hrms_pay_runs WHERE company_id = ? AND period_month = ? AND deleted_at IS NULL', [companyId, month]);
  return r ?? null;
}

/**
 * Everything the three files need for a month: { month, run, attendance, pf, esi, pt, validation }.
 * Refuses nothing: a month without a locked run says so (files refuse to download, see fileOf).
 */
export async function monthReturns(db, c, month) {
  if (!MONTH_RE.test(String(month ?? ''))) throw new HrmsError(422, 'INVALID', 'The month is written like 2026-10.');
  const run = await runOf(db, c.companyId, month);
  const base = { month, monthLabel: monthWords(month), formats: FORMATS };
  if (!run) return { ...base, run: null, ready: false, reason: `There is no payroll run for ${monthWords(month)}.`, pf: null, esi: null, pt: null, validation: [] };
  if (!FROZEN.includes(run.status)) return { ...base, run: { id: run.id, status: run.status }, ready: false, reason: `The ${monthWords(month)} run is ${run.status.toLowerCase()}: the files are made from a LOCKED run. Lock it first.`, pf: null, esi: null, pt: null, validation: [] };

  const [people] = await db.query(
    `SELECT p.id, p.employee_id, p.gross, p.pf_wage, p.esi_wage, p.esi_covered, p.lop_days, p.payable_days, p.days_in_month, p.employed_days,
            e.employee_code, e.full_name, e.date_of_birth, e.date_of_joining, e.exit_date, s.pf_mode, s.state_code
       FROM hrms_pay_run_people p
       JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
       LEFT JOIN hrms_pay_salaries s ON s.company_id = p.company_id AND s.id = p.salary_id
      WHERE p.company_id = ? AND p.run_id = ? AND p.deleted_at IS NULL AND p.included = 1
      ORDER BY e.employee_code`, [c.companyId, run.id]);
  const [lines] = await db.query(
    `SELECT l.run_person_id, l.amount, l.basis, l.source, k.statutory_key
       FROM hrms_pay_run_lines l JOIN hrms_pay_components k ON k.company_id = l.company_id AND k.id = l.component_id
      WHERE l.company_id = ? AND l.run_id = ? AND l.deleted_at IS NULL`, [c.companyId, run.id]);
  const byPerson = new Map();
  for (const l of lines) {
    if (!byPerson.has(l.run_person_id)) byPerson.set(l.run_person_id, { PF_EE: 0, PF_ER: 0, ESI_EE: 0, ESI_ER: 0, PT: 0, erBasis: null, arrears: 0 });
    const o = byPerson.get(l.run_person_id);
    if (l.statutory_key && Object.hasOwn(o, l.statutory_key)) o[l.statutory_key] += n(l.amount);
    if (l.statutory_key === 'PF_ER') o.erBasis = l.basis ?? null;
    if (l.source === 'ARREARS') o.arrears += n(l.amount);
  }
  const ids = people.map((p) => p.employee_id);
  const idents = await identifiersOf(db, c.companyId, ids);
  const pay = await companySettings(db, c.companyId);
  const stat = await statutoryOn(db, c.companyId, `${month}-01`, pay.stateCode);
  const ceiling = n(stat.PF?.wageCeiling) || Infinity;
  const pfRate = n(stat.PF?.employeeRate) || 12;
  const validation = [];
  const V = (level, kind, what, employee = null) => validation.push({ level, kind, what, employee });

  // Attendance: NCP / ESI days from a CLOSED month once attendance is live.
  let att = { live: false, final: false, used: false, status: null };
  let attPeople = new Map();
  try {
    const m = await attendanceMonth(c.companyId, month, { db, employeeIds: ids });
    att = { live: Boolean(m.live), final: Boolean(m.final), used: Boolean(m.live && m.final), status: m.status ?? null };
    if (att.used) attPeople = new Map(m.people.map((p) => [p.employeeId, p]));
    else if (m.live) V('WARNING', 'PF', `Attendance is live but ${monthWords(month)} is not closed (Attendance › Close month): NCP and ESI days are taken from the run's LOP and payable days.`);
  } catch (e) {
    att = { live: false, final: false, used: false, status: null, error: e.message };
  }
  const monthEnd = lastDay(month);

  /* PF — ECR */
  const pfRows = [];
  for (const p of people) {
    const L = byPerson.get(p.id) ?? { PF_EE: 0, PF_ER: 0 };
    if (!(L.PF_EE > 0 || L.PF_ER > 0)) continue;
    const emp = { id: p.employee_id, code: p.employee_code, name: p.full_name };
    const id8 = idents.get(p.employee_id) ?? {};
    const uan = String(id8.uan ?? '').replace(/\s+/g, '');
    const pfWage = n(p.pf_wage);
    const epfWages = r0(p.pf_mode === 'FULL' ? pfWage : Math.min(pfWage, ceiling));
    const m = /EPS\s+([\d,]+)/.exec(L.erBasis ?? '');
    const eps = m ? r0(m[1].replace(/,/g, '')) : Math.min(r0(L.PF_ER), roundBy(n(stat.PF?.epsRate ?? 8.33) * Math.min(epfWages, ceiling) / 100, stat.PF?.rounding ?? 'NEAREST'));
    const a = attPeople.get(p.employee_id);
    // NCP days are what the RUN paid (its LOP; P3b: the run reads the closed attendance month). A closed month that
    // says otherwise (the run was paid without attendance, or calculated before the month was closed) is flagged.
    const ncp = n(p.lop_days);
    if (att.used && a && Math.abs(n(a.ncpDays) - ncp) >= 0.01) V('WARNING', 'PF', `${p.full_name} (${p.employee_code}): the closed attendance has ${n(a.ncpDays)} NCP days, the run paid ${ncp} LOP days — the ECR uses the run's. Calculate the run again if the attendance is right.`, { id: p.employee_id, code: p.employee_code, name: p.full_name });
    const row = {
      employee: emp, uan: uan || null, name: cleanName(p.full_name), grossWages: r0(p.gross), epfWages,
      epsWages: eps > 0 ? r0(Math.min(epfWages, ceiling)) : 0, edliWages: r0(Math.min(epfWages, ceiling)),
      epfEe: r0(L.PF_EE), eps, epfDiff: r0(L.PF_ER) - eps, ncpDays: Math.round(ncp), refund: 0, ncpFrom: 'RUN',
    };
    if (ncp !== row.ncpDays) V('INFO', 'PF', `${emp.name} (${emp.code}): ${ncp} NCP days; the ECR takes whole days (no half days) — ${row.ncpDays}.`, emp);
    if (row.grossWages === 0 && row.ncpDays !== n(p.days_in_month)) V('WARNING', 'PF', `${emp.name} (${emp.code}): no wages, so EPFO expects NCP days = ${n(p.days_in_month)}.`, emp);
    if (!uan) V('ERROR', 'PF', `${emp.name} (${emp.code}): no UAN — add the identifier UAN. Left out of the ECR file.`, emp);
    else if (!/^\d{12}$/.test(uan)) V('ERROR', 'PF', `${emp.name} (${emp.code}): the UAN “${uan}” is not 12 digits. Left out of the ECR file.`, emp);
    const expected = roundBy(pfRate * epfWages / 100, stat.PF?.rounding ?? 'NEAREST');
    if (Math.abs(expected - row.epfEe) > 1) V('WARNING', 'PF', `${emp.name} (${emp.code}): wages mismatch — the employee share ₹${row.epfEe.toLocaleString('en-IN')} is not ${pfRate}% of the EPF wages ₹${epfWages.toLocaleString('en-IN')} (₹${expected.toLocaleString('en-IN')})${L.arrears ? '; the run paid arrears this month — EPFO takes arrears in a separate arrear ECR' : ''}.`, emp);
    if (row.epfWages > row.grossWages && row.grossWages > 0) V('WARNING', 'PF', `${emp.name} (${emp.code}): wages mismatch — EPF wages are more than the gross wages.`, emp);
    if (row.ncpDays > n(p.days_in_month)) V('ERROR', 'PF', `${emp.name} (${emp.code}): ${row.ncpDays} NCP days is more than the days of the month.`, emp);
    if (eps > 0 && p.date_of_birth) {
      const dob = dateText(p.date_of_birth);
      const at58 = `${Number(dob.slice(0, 4)) + 58}${dob.slice(4)}`;
      if (at58 < `${month}-01`) V('WARNING', 'PF', `${emp.name} (${emp.code}): past 58 but the run has an EPS share — EPFO expects EPS 0 and EPS wages 0.`, emp);
    }
    pfRows.push(row);
  }
  const pfIn = pfRows.filter((r) => r.uan && /^\d{12}$/.test(r.uan));
  const sum = (rows, k) => rows.reduce((s, r) => s + n(r[k]), 0);
  const pf = {
    rows: pfRows, members: pfRows.length, inFile: pfIn.length, ceiling: Number.isFinite(ceiling) ? ceiling : null,
    totals: { grossWages: sum(pfIn, 'grossWages'), epfWages: sum(pfIn, 'epfWages'), epsWages: sum(pfIn, 'epsWages'), edliWages: sum(pfIn, 'edliWages'), epfEe: sum(pfIn, 'epfEe'), eps: sum(pfIn, 'eps'), epfDiff: sum(pfIn, 'epfDiff'), ncpDays: sum(pfIn, 'ncpDays') },
  };

  /* ESI */
  const esiRows = [];
  for (const p of people) {
    const L = byPerson.get(p.id) ?? { ESI_EE: 0, ESI_ER: 0 };
    if (!Number(p.esi_covered) && !(L.ESI_EE > 0 || L.ESI_ER > 0)) continue;
    const emp = { id: p.employee_id, code: p.employee_code, name: p.full_name };
    const ip = String((idents.get(p.employee_id) ?? {}).esi ?? '').replace(/\s+/g, '');
    const a = attPeople.get(p.employee_id);
    // ESI days are the days the RUN paid (payable days), flagged when the closed attendance says otherwise.
    const daysRaw = n(p.payable_days);
    if (att.used && a && Math.abs(n(a.esiDays) - daysRaw) >= 0.01) V('WARNING', 'ESI', `${p.full_name} (${p.employee_code}): the closed attendance has ${n(a.esiDays)} paid days, the run paid ${daysRaw} — the file uses the run's.`, { id: p.employee_id, code: p.employee_code, name: p.full_name });
    const days = Math.max(0, Math.min(31, Math.ceil(daysRaw - 1e-9)));
    const exit = dateText(p.exit_date);
    const left = Boolean(exit && exit <= monthEnd);
    // A reason only for 0 days: left service (2) when the person has left, on leave (1) for a month of LOP, else without reason (0).
    const { reason, lastWorkingDay } = esiReasonFor({ days, exit, monthEnd, lopDays: p.lop_days });
    const row = {
      employee: emp, ip: ip || null, name: cleanName(p.full_name, { dots: false }), days, daysExact: daysRaw, wages: r0(p.esi_wage),
      reason, reasonWords: FORMATS.ESI.reasons[reason], lastWorkingDay, employeeShare: r0(L.ESI_EE), employerShare: r0(L.ESI_ER), daysFrom: 'RUN',
    };
    if (!ip) V('ERROR', 'ESI', `${emp.name} (${emp.code}): no ESI IP number — add the identifier ESI. Left out of the file.`, emp);
    else if (!/^\d{10}$/.test(ip)) V('ERROR', 'ESI', `${emp.name} (${emp.code}): the IP number “${ip}” is not 10 digits. Left out of the file.`, emp);
    if (daysRaw !== days) V('INFO', 'ESI', `${emp.name} (${emp.code}): ${daysRaw} days in the run; the ESIC file takes whole days, a part day rounded up — ${days}.`, emp);
    if (days === 0 && row.wages > 0) V('WARNING', 'ESI', `${emp.name} (${emp.code}): wages with 0 days — check the days.`, emp);
    if (left) V('INFO', 'ESI', `${emp.name} (${emp.code}) left on ${exit}: ${days ? 'days were paid, so no reason code or last working day this month; next month 0 days, reason 2 (left service) and the last working day' : `reason 2 (left service), last working day ${ddmmyyyy(exit)}`}.`, emp);
    esiRows.push(row);
  }
  const esiIn = esiRows.filter((r) => r.ip && /^\d{10}$/.test(r.ip));
  const esi = { rows: esiRows, members: esiRows.length, inFile: esiIn.length, totals: { wages: sum(esiIn, 'wages'), employeeShare: sum(esiIn, 'employeeShare'), employerShare: sum(esiIn, 'employerShare'), days: sum(esiIn, 'days') } };

  /* PT — Telangana, per slab */
  const slabs = [...(stat.PT?.slabs ?? [])].sort((x, y) => (x.upTo ?? Infinity) - (y.upTo ?? Infinity));
  const ptSlabs = slabs.map((s, i) => {
    const from = i > 0 ? n(slabs[i - 1].upTo) + 1 : 0;
    return { from, upTo: s.upTo ?? null, rate: n(s.monthAmounts?.[month.slice(5, 7)] ?? s.amount), words: s.upTo == null ? `Above ₹${(from - 1).toLocaleString('en-IN')}` : `₹${from.toLocaleString('en-IN')} to ₹${n(s.upTo).toLocaleString('en-IN')}`, employees: 0, deducted: 0, people: [] };
  });
  let ptOther = 0;
  for (const p of people) {
    if ((p.state_code ?? pay.stateCode) !== pay.stateCode) { ptOther += 1; continue; }
    const gross = n(p.gross);
    if (!(gross > 0)) continue;
    const L = byPerson.get(p.id) ?? { PT: 0 };
    const slab = ptSlabs.find((s) => s.upTo == null || gross <= n(s.upTo)) ?? ptSlabs[ptSlabs.length - 1];
    if (!slab) continue;
    slab.employees += 1;
    slab.deducted += r0(L.PT);
    slab.people.push(p.employee_id);
    if (r0(L.PT) !== slab.rate) V('WARNING', 'PT', `${p.full_name} (${p.employee_code}): professional tax ₹${r0(L.PT)} deducted, the slab of a gross of ₹${r0(gross).toLocaleString('en-IN')} is ₹${slab.rate}.`, { id: p.employee_id, code: p.employee_code, name: p.full_name });
  }
  if (ptOther) V('INFO', 'PT', `${ptOther} person(s) are paid under another state's professional tax: not in this return.`);
  if (!slabs.length) V('INFO', 'PT', `No professional tax slabs for ${pay.stateCode} in Statutory settings.`);
  const pt = {
    state: pay.stateCode, slabs: ptSlabs.map(({ people: _p, ...s }) => ({ ...s, amount: s.employees * s.rate })),
    totals: { employees: ptSlabs.reduce((s, x) => s + x.employees, 0), deducted: ptSlabs.reduce((s, x) => s + x.deducted, 0), amount: ptSlabs.reduce((s, x) => s + x.employees * x.rate, 0) },
    dueDate: `${nextMonth(month)}-10`,
  };

  const levelOrder = { ERROR: 0, WARNING: 1, INFO: 2 };
  validation.sort((x, y) => levelOrder[x.level] - levelOrder[y.level]);
  return { ...base, run: { id: run.id, status: run.status, lockedAt: run.locked_at ? new Date(run.locked_at).toISOString() : null }, ready: true, attendance: att, pf, esi, pt, validation, employeeIds: ids };
}

function nextMonth(m) { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; }

/** Hides the amounts (payroll view without the named pay view): counts and the validation stay. */
export function withoutAmounts(d) {
  if (!d.ready) return { ...d, amountsHidden: true };
  return {
    ...d, amountsHidden: true,
    pf: { members: d.pf.members, inFile: d.pf.inFile, rows: [], totals: null },
    esi: { members: d.esi.members, inFile: d.esi.inFile, rows: [], totals: null },
    pt: { state: d.pt.state, slabs: d.pt.slabs.map((s) => ({ ...s, deducted: null, amount: null })), totals: { employees: d.pt.totals.employees }, dueDate: d.pt.dueDate },
    validation: d.validation.map((v) => ({ ...v, what: v.what.replace(/₹[\d,]+/g, '₹…') })),
  };
}

/* ── the files ────────────────────────────────────────────────────────── */

export function ecrText(d) {
  return d.pf.rows.filter((r) => r.uan && /^\d{12}$/.test(r.uan)).map(ecrLine).join('\n');
}

export async function esiWorkbook(d) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF HRMS';
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(FORMATS.ESI.columns);
  ws.getRow(1).font = { bold: true };
  ws.columns = [{ width: 16 }, { width: 34 }, { width: 18 }, { width: 18 }, { width: 22 }, { width: 22 }];
  for (const r of d.esi.rows.filter((x) => x.ip && /^\d{10}$/.test(x.ip))) {
    const row = ws.addRow([r.ip, r.name, r.days, r.wages, r.reason, r.lastWorkingDay ? ddmmyyyy(r.lastWorkingDay) : '']);
    row.getCell(1).numFmt = '@';
    row.getCell(6).numFmt = '@';
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function ptWorkbook(d, companyName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF HRMS';
  const ws = wb.addWorksheet('PT return');
  ws.columns = [{ width: 34 }, { width: 18 }, { width: 18 }, { width: 22 }];
  ws.addRow([`Professional tax — monthly return figures (${d.pt.state === 'TG' ? 'Telangana' : d.pt.state}), ${d.monthLabel}`]).font = { bold: true, size: 12 };
  ws.addRow([`Employer: ${companyName ?? ''}`]);
  ws.addRow([`Pay and return due by ${ddmmyyyy(d.pt.dueDate)}. ${FORMATS.PT.rules}`]);
  ws.addRow([]);
  const h = ws.addRow(['Monthly salary or wage', 'Number of employees', 'Rate of tax a month (₹)', 'Tax deducted (₹)']);
  h.font = { bold: true };
  for (const s of d.pt.slabs) ws.addRow([s.words, s.employees, s.rate, s.deducted]);
  const t = ws.addRow(['Total', d.pt.totals.employees, '', d.pt.totals.deducted]);
  t.font = { bold: true };
  ws.addRow([]);
  ws.addRow([`Source: ${FORMATS.PT.source}`]);
  const v = wb.addWorksheet('Check before filing');
  v.columns = [{ header: 'Level', width: 10 }, { header: 'What', width: 110 }];
  v.getRow(1).font = { bold: true };
  const ptChecks = d.validation.filter((x) => x.kind === 'PT');
  for (const x of ptChecks.length ? ptChecks : [{ level: 'OK', what: 'Nothing found.' }]) v.addRow([x.level, x.what]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A file of a month: kind ECR | ESI | PT → { fileName, mimeType, contentBase64, employeeIds }. */
export async function fileOf(db, c, month, kind) {
  const d = await monthReturns(db, c, month);
  if (!d.ready) throw new HrmsError(409, 'NOT_LOCKED', d.reason);
  const K = String(kind ?? '').toUpperCase();
  const tag = month.replace('-', '');
  if (K === 'ECR') {
    if (!d.pf.inFile) throw new HrmsError(409, 'NOTHING', `No PF member with a UAN in the ${d.monthLabel} run.`);
    return { fileName: `ECR_${tag}.txt`, mimeType: 'text/plain', contentBase64: Buffer.from(ecrText(d), 'utf8').toString('base64'), employeeIds: d.pf.rows.map((r) => r.employee.id) };
  }
  if (K === 'ESI') {
    if (!d.esi.inFile) throw new HrmsError(409, 'NOTHING', `No ESI-covered person with an IP number in the ${d.monthLabel} run.`);
    return { fileName: `ESI_MC_${tag}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: (await esiWorkbook(d)).toString('base64'), employeeIds: d.esi.rows.map((r) => r.employee.id) };
  }
  if (K === 'PT') {
    const [[co]] = await db.query('SELECT name FROM companies WHERE id = ?', [c.companyId]);
    return { fileName: `PT_${d.pt.state}_${tag}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: (await ptWorkbook(d, co?.name)).toString('base64'), employeeIds: d.employeeIds };
  }
  throw new HrmsError(422, 'INVALID', 'The file is ECR, ESI or PT.');
}

export { json };
export default { esiReasonFor, FORMATS, monthReturns, withoutAmounts, ecrText, ecrLine, esiWorkbook, ptWorkbook, fileOf, cleanName };
