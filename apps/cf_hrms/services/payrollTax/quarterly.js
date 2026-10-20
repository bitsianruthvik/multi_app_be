/**
 * quarterly.js — the data of the quarterly TDS return on salary: Form 24Q (to 2025-26), Form 138
 * (from 2026-27). TM/CF_HRMS_HIRING_SPEC.md §25.4 "Quarterly TDS return data".
 *
 *   Challans      one row a deposit of the quarter (hrms_tax_challans)
 *   Annexure I    a row a person a month with TDS, under the challan that paid that month
 *   Annexure II   (Q4 only) a row a person: the year's salary and tax, as Form 16 / 130 Part B
 *   Validation    what the return would be refused for: no TAN, no / bad PAN, a month's TDS not
 *                 covered by its challans, a deposit after the due date …
 *
 * THE FILE. Protean's Return Preparation Utility (RPU 6.0 to FY 2025-26; RPU 1.2 from tax year
 * 2026-27) makes the return's text file, and its File Validation Utility (FVU) makes the .fvu that is
 * filed. The RPU imports only the .csi challan file, its own saved file and a TRACES consolidated
 * file — NO CSV / Excel import is documented (Protean JAVA RPU e-Tutorial v1.7,
 * https://tinpan.proteantech.in/downloads/e-tds/JAVA_RPU_e-Tutorial_Version_1.7.pdf). So the workbook
 * here is laid out in the RPU's own columns — the fields of Protean's file format, with the form's
 * column letters for Form 138 (File Format for Form 138 (24Q) Q1–Q3 v1.2, 22-07-2026; the Q4 format
 * for Form 138 is "expected to be released soon"; for 24Q Q4 the v7.5 Salary Detail record) — to be
 * typed or pasted into the RPU. The FVU file comes from the RPU, not from here; the screen says so.
 */
import ExcelJS from 'exceljs';
import { yearMonths, quarterMonths, QUARTERS, money, n, panStatus, pansOf, loadRules, formsOf, today, bad } from './common.js';
import { monthsOfYear } from './challans.js';
import { deductorOf, yearSettings, review } from './settings.js';
import { yearActuals } from './actuals.js';
import { partBRows } from './form16.js';
import { monthBounds } from '../payroll/proration.js';

const FROZEN = ['LOCKED', 'RELEASED', 'PAID'];
const ddmmyyyy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

/**
 * Rows to challans (pure): each row (an amount) goes to one challan; the largest rows first, each into the challan
 * with the least room left that still holds it; a row no challan holds goes to the one with the most room left
 * (and that challan is then over: the caller says so). -> { of: [challan index per row | null], allocated: [per challan] }
 */
export function allocateRows(amounts, rooms) {
  const of = amounts.map(() => null);
  const allocated = rooms.map(() => 0);
  if (!rooms.length) return { of, allocated };
  const order = amounts.map((a, i) => i).sort((x, y) => amounts[y] - amounts[x] || x - y);
  for (const i of order) {
    let best = null;
    for (let k = 0; k < rooms.length; k += 1) {
      const left = rooms[k] - allocated[k];
      if (amounts[i] <= left + 0.5 && (best == null || left < rooms[best] - allocated[best])) best = k;
    }
    if (best == null) best = rooms.reduce((b, r, k) => (r - allocated[k] > rooms[b] - allocated[b] ? k : b), 0);
    of[i] = best;
    allocated[best] = Math.round((allocated[best] + amounts[i]) * 100) / 100;
  }
  return { of, allocated };
}

export async function quarterData(db, c, year, quarter) {
  const q = String(quarter).toUpperCase();
  if (!QUARTERS.includes(q)) throw bad('The quarter is Q1, Q2, Q3 or Q4.');
  const { rules, reason } = await loadRules(db, year);
  const forms = formsOf(rules);
  const ret = rules?.NEW?.has('tds_return') ? rules.NEW.get('tds_return') : null;
  const months = quarterMonths(year, q);
  const all = await monthsOfYear(db, c.companyId, year);
  const qm = all.filter((m) => months.includes(m.month));
  const deductor = await deductorOf(db, c.companyId);
  const validation = [];
  const V = (level, what, who = null) => validation.push({ level, what, who });
  if (!deductor.tan) V('ERROR', 'The company’s TAN is not set (Tax › Settings › Deductor).');
  if (!deductor.pan) V('ERROR', 'The company’s PAN is not set (Tax › Settings › Deductor).');
  if (!deductor.responsible?.name) V('WARNING', 'The person responsible for deducting tax is not named (Tax › Settings › Deductor).');
  if (!deductor.address?.city || !deductor.address?.pin) V('WARNING', 'The deductor’s address has no city or PIN.');

  // Annexure I: a row a person a month with TDS.
  const runIds = qm.filter((m) => m.run && FROZEN.includes(m.run.status)).map((m) => m.run.id);
  const [people] = runIds.length ? await db.query(
    `SELECT p.run_id, r.period_month, r.paid_at, p.employee_id, p.gross, p.tds_amount, p.tax_json, e.employee_code, e.full_name
       FROM hrms_pay_run_people p JOIN hrms_pay_runs r ON r.company_id = p.company_id AND r.id = p.run_id JOIN hrms_employees e ON e.company_id = p.company_id AND e.id = p.employee_id
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.included = 1 AND p.tds_amount > 0 AND p.run_id IN (${runIds.map(() => '?').join(',')})
      ORDER BY r.period_month, e.full_name`, [c.companyId, ...runIds]) : [[]];
  const pans = await pansOf(db, c.companyId, [...new Set(people.map((p) => p.employee_id))]);
  const challans = [];
  const deductees = [];
  let challanNo = 0;
  for (const m of qm) {
    for (const r of qm.find((x) => x.month === m.month).challans) { challanNo += 1; challans.push({ ...r, no: challanNo, rows: [], allocated: 0 }); }
    const mine = challans.filter((x) => x.month === m.month);
    const rows = people.filter((p) => p.period_month === m.month);
    if (!rows.length && !mine.length) continue;
    if (m.status === 'NOT_LOCKED') V('WARNING', `${m.label}: the payroll is not locked — its TDS is not in the return yet.`);
    if (rows.length && !mine.length) V('ERROR', `${m.label}: TDS of ₹${m.deducted.toLocaleString('en-IN')} has no challan. Record the deposit (Tax › Challans).`);
    else if (m.balance > 0.5) V('ERROR', `${m.label}: the challans pay ₹${m.deposited.toLocaleString('en-IN')} of ₹${m.deducted.toLocaleString('en-IN')} deducted.`);
    else if (m.deposited - m.deducted > 0.5) V('WARNING', `${m.label}: the challans pay ₹${(m.deposited - m.deducted).toLocaleString('en-IN')} more than was deducted (the rest stays unallocated).`);
    for (const ch of mine) if (ch.depositDate > m.due) V('WARNING', `${m.label}: challan ${ch.challanSerial} was deposited on ${ch.depositDate}, after the due date ${m.due} — interest is due.`);
    // Allocate the month's rows to its challans by what each one paid (tax + surcharge + cess): the largest row first,
    // into the challan with the least room that still holds it (P3b review: the last challan took the overflow).
    const fit = allocateRows(rows.map((p) => n(p.tds_amount)), mine.map((ch) => ch.tax + ch.surcharge + ch.cess));
    for (const [k, ch] of mine.entries()) {
      const room = ch.tax + ch.surcharge + ch.cess;
      if (fit.allocated[k] > room + 0.5) V('ERROR', `${m.label}: challan ${ch.challanSerial} paid ₹${room.toLocaleString('en-IN')} (tax + surcharge + cess) but ₹${fit.allocated[k].toLocaleString('en-IN')} of deductions cannot be fitted into the month's challans without it — the RPU refuses a challan whose deductee rows are more than it paid. Record the missing deposit or correct the challans.`);
    }
    for (const [ri, p] of rows.entries()) {
      const pan = pans.get(p.employee_id);
      const ps = panStatus(pan);
      const tax = JSON.parse(typeof p.tax_json === 'string' ? p.tax_json : JSON.stringify(p.tax_json ?? {}));
      const ch = fit.of[ri] == null ? null : mine[fit.of[ri]];
      if (ch) ch.allocated += n(p.tds_amount);
      const paidOn = monthBounds(p.period_month).to;
      const row = {
        challanNo: ch?.no ?? null, month: p.period_month, employee: { id: p.employee_id, code: p.employee_code, name: p.full_name },
        pan: ps === 'VALID' ? pan : 'PANNOTAVBL', panStatus: ps, sectionCode: ret?.sectionCode ?? (year >= '2026-27' ? '1002' : '92B'),
        datePaid: paidOn, amountPaid: money(p.gross), tds: money(p.tds_amount), deposited: money(p.tds_amount), dateDeducted: paidOn, dateDeposited: ch?.depositDate ?? null,
        remark: ps !== 'VALID' && tax?.noPan ? 'C' : '',
      };
      if (ps !== 'VALID') V('WARNING', `${p.full_name} (${p.employee_code}): ${ps === 'NONE' ? 'no PAN' : 'the PAN is not valid'} — shown as PANNOTAVBL${row.remark ? ', remark C (higher rate)' : ''}.`, p.employee_id);
      deductees.push(row);
      if (ch) ch.rows.push(row);
    }
  }

  // Annexure II, Q4: the year of everybody paid in it.
  let annexureII = null;
  if (q === 'Q4') {
    const months12 = yearMonths(year);
    const [paidPeople] = await db.query(
      `SELECT DISTINCT p.employee_id FROM hrms_pay_run_people p JOIN hrms_pay_runs r ON r.company_id = p.company_id AND r.id = p.run_id AND r.deleted_at IS NULL
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.included = 1 AND r.status IN ('LOCKED','RELEASED','PAID') AND r.period_month BETWEEN ? AND ?`, [c.companyId, months12[0], months12[11]]);
    const ids = paidPeople.map((p) => p.employee_id);
    const { actuals } = await yearActuals(db, c.companyId, year, ids);
    const [emps] = ids.length ? await db.query(`SELECT id, employee_code, full_name FROM hrms_employees WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [c.companyId, ...ids]) : [[]];
    annexureII = [];
    for (const e of emps) {
      const a = actuals.get(e.id);
      if (!a) continue;
      if (a.provisional) V('WARNING', `${e.full_name}: the year is not complete (March not locked) — Annexure II is provisional.`, e.id);
      const k = a.computation;
      const rows = forms ? partBRows(a, forms) : [];
      const landlords = a.claims.filter((x) => x.kind === 'RENT' && x.counted > 0);
      annexureII.push({
        employee: { id: e.id, code: e.employee_code, name: e.full_name }, pan: a.panStatus === 'VALID' ? a.pan : 'PANNOTAVBL', panStatus: a.panStatus,
        periodFrom: a.period.from, periodTo: a.period.to, optingOut: a.regime === 'OLD' ? 'Y' : 'N',
        grossSalary: k.grossSalary, perquisites: a.perquisiteTotal, previousEmployerSalary: money(n(a.previousEmployer?.taxableSalary)),
        exemptions: k.totalExempt, hraExempt: money((k.exemptions ?? []).filter((x) => x.key === 'exempt_hra').reduce((s, x) => s + x.exempt, 0)),
        standardDeduction: k.standardDeduction, professionalTax: k.professionalTax, incomeFromSalary: k.incomeFromSalary,
        houseProperty: k.houseProperty, otherIncome: k.otherIncome, grossTotalIncome: k.grossTotalIncome,
        deductions: Object.fromEntries((k.deductions ?? []).map((d) => [d.key, d.allowed])), totalDeductions: k.totalDeductions,
        taxableIncome: k.taxableIncome, taxOnIncome: k.taxBeforeRebate, rebate: k.rebate, surcharge: k.surcharge, cess: k.cess, relief89: money(n(a.relief)), netTax: money(k.totalTax - n(a.relief)),
        tdsCurrent: a.tds, tdsPrevious: money(n(a.previousEmployer?.tds)), shortfall: money(k.totalTax - n(a.relief) - a.tds - n(a.previousEmployer?.tds)),
        rentOver1Lakh: landlords.reduce((s, x) => s + x.counted, 0) > 100000 ? 'Y' : 'N', landlords: landlords.length,
        rows,
      });
      if (a.panStatus !== 'VALID' && a.tds > 0) V('ERROR', `${e.full_name}: no valid PAN in Annexure II.`, e.id);
      if (Math.abs(k.totalTax - a.tds - n(a.previousEmployer?.tds)) >= 1) V('INFO', `${e.full_name}: tax for the year ₹${k.totalTax.toLocaleString('en-IN')}, deducted ₹${(a.tds + n(a.previousEmployer?.tds)).toLocaleString('en-IN')} — a ${k.totalTax > a.tds ? 'shortfall' : 'excess'} in Annexure II.`, e.id);
    }
  }
  const settings = await yearSettings(db, c.companyId, year);
  const due = ret?.quarterDue?.[q] ? `${q === 'Q4' ? Number(year.slice(0, 4)) + 1 : q === 'Q3' ? Number(year.slice(0, 4)) + 1 : Number(year.slice(0, 4))}-${ret.quarterDue[q]}` : null;
  return {
    year, quarter: q, months: qm.map((m) => ({ month: m.month, label: m.label, status: m.status, deducted: m.deducted, deposited: m.deposited })),
    form: forms?.quarterlyReturn ?? null, due, rulesMissing: rules ? null : reason,
    deductor, challans: challans.map((ch) => ({ ...ch, rows: undefined, deductees: ch.rows.length, allocated: money(ch.allocated) })), deductees, annexureII, validation,
    totals: { deducted: money(deductees.reduce((s, r) => s + r.tds, 0)), deposited: money(challans.reduce((s, ch) => s + ch.tax + ch.surcharge + ch.cess, 0)), people: new Set(deductees.map((d) => d.employee.id)).size },
    rpu: ret?.rpu ?? null, fileFormat: ret?.fileFormat ?? null,
    fvuNote: 'This app does not make the return file. Type or paste these rows into Protean’s Return Preparation Utility (RPU); the RPU makes the text file, and its File Validation Utility (FVU) makes the .fvu you file. The RPU documents no CSV / Excel import, so the columns here follow the RPU’s own fields.',
    review: review(settings), today: today(),
  };
}

/** The workbook of a quarter: Read me, Deductor, Challans, Annexure I, (Annexure II), Validation. */
export async function quarterWorkbook(db, c, year, quarter) {
  const d = await quarterData(db, c, year, quarter);
  const is138 = year >= '2026-27';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF HRMS';
  const sheet = (name, cols, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map(([header, key, width = 16]) => ({ header, key, width }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) ws.addRow(r);
    return ws;
  };
  const readme = wb.addWorksheet('Read me');
  readme.columns = [{ width: 120 }];
  for (const line of [
    `${d.form ?? 'Quarterly TDS return'} — ${year} ${d.quarter}${d.due ? ` (due ${d.due})` : ''}`,
    d.fvuNote,
    `RPU: ${d.rpu ?? '—'}. Layout followed: ${d.fileFormat ?? '—'}.`,
    is138 ? 'Column letters (A–N) are the columns of Form 138 as the Protean file format v1.2 prints them.' : 'Columns follow the Protean file format for Form 24Q.',
    'Amounts in rupees. Dates as DD/MM/YYYY. PANNOTAVBL where the employee has no valid PAN.',
    d.review.banner ?? `Reviewed by our CA for ${year}.`,
  ]) readme.addRow([line]);
  const dd = d.deductor;
  sheet('Deductor', [['Field', 'k', 36], ['Value', 'v', 60]], [
    { k: 'TAN', v: dd.tan ?? '' }, { k: 'PAN of the deductor', v: dd.pan ?? '' }, { k: 'Name of the deductor', v: dd.name }, { k: 'Branch / division', v: dd.branch ?? '' },
    { k: 'Address', v: [dd.address?.line1, dd.address?.line2, dd.address?.city].filter(Boolean).join(', ') }, { k: 'State', v: dd.address?.state ?? '' }, { k: 'PIN', v: dd.address?.pin ?? '' },
    { k: 'Category of deductor', v: dd.category ?? 'K' }, { k: 'Responsible person', v: dd.responsible?.name ?? '' }, { k: 'Designation', v: dd.responsible?.designation ?? '' },
    { k: is138 ? 'Tax year' : 'Financial year', v: year }, { k: 'Quarter', v: d.quarter }, { k: 'Form', v: d.form ?? '' },
  ]);
  sheet('Challans', [
    ['Sl. No. (A)', 'no', 10], ['Month', 'month', 10], [is138 ? 'Tax (B)' : 'TDS', 'tax'], ...(is138 ? [] : [['Surcharge', 'surcharge'], ['Education cess', 'cess']]),
    [is138 ? 'Interest (C)' : 'Interest', 'interest'], [is138 ? 'Fee (D)' : 'Fee', 'fee'], [is138 ? 'Penalty / others (E)' : 'Others', 'others'], [is138 ? 'Total deposited (F)' : 'Total', 'total'],
    [is138 ? 'Mode (G)' : 'Mode', 'mode', 8], [is138 ? 'BSR code (H)' : 'BSR code', 'bsr', 12], [is138 ? 'Challan serial (I)' : 'Challan serial', 'serial', 14], [is138 ? 'Date of deposit (J)' : 'Date of deposit', 'date', 14],
    [is138 ? 'Minor head (K)' : 'Minor head', 'minor', 10], ['Deductee rows', 'rows', 12], ['Tax allocated to rows', 'allocated', 16],
  ], d.challans.map((ch) => ({ no: ch.no, month: ch.month, tax: ch.tax, surcharge: ch.surcharge, cess: ch.cess, interest: ch.interest, fee: ch.fee, others: ch.others, total: ch.total, mode: 'C', bsr: ch.bsrCode, serial: ch.challanSerial, date: ddmmyyyy(ch.depositDate), minor: ch.minorHead, rows: ch.deductees, allocated: ch.allocated })));
  sheet('Annexure I', [
    ['Challan Sl. No. (B)', 'challan', 12], ['Employee code', 'code', 14], [is138 ? 'PAN of the employee (C)' : 'PAN of the employee', 'pan', 14], [is138 ? 'Name of the employee (D)' : 'Name of the employee', 'name', 30],
    [is138 ? 'Section code (F)' : 'Section code', 'section', 10], [is138 ? 'Date of payment / credit (G)' : 'Date of payment / credit', 'paid', 14], [is138 ? 'Date of deduction (H)' : 'Date of deduction', 'deducted', 14],
    [is138 ? 'Amount paid / credited (I)' : 'Amount paid / credited', 'amount'], [is138 ? 'Tax deducted (J)' : 'Tax deducted', 'tds'], [is138 ? 'Whether deposited (K)' : 'Whether deposited', 'whether', 10],
    [is138 ? 'Tax deposited (L)' : 'Tax deposited', 'deposited'], [is138 ? 'Date of deposit (M)' : 'Date of deposit', 'dateDep', 14], [is138 ? 'Reason for higher deduction (N)' : 'Reason (remark)', 'remark', 12],
  ], d.deductees.map((r) => ({ challan: r.challanNo ?? '', code: r.employee.code, pan: r.pan, name: r.employee.name, section: r.sectionCode, paid: ddmmyyyy(r.datePaid), deducted: ddmmyyyy(r.dateDeducted), amount: r.amountPaid, tds: r.tds, whether: r.challanNo ? 'Y' : 'N', deposited: r.challanNo ? r.deposited : 0, dateDep: ddmmyyyy(r.dateDeposited), remark: r.remark })));
  if (d.annexureII) {
    const keys = [['ded_80c', is138 ? 's.123 (80C)' : '80C'], ['ded_80ccd1b', is138 ? 's.124(3) (80CCD(1B))' : '80CCD(1B)'], ['ded_80ccd2', is138 ? 's.124(1) (80CCD(2))' : '80CCD(2)'], ['ded_80d', is138 ? 's.126 (80D)' : '80D'], ['ded_80e', is138 ? 's.129 (80E)' : '80E'], ['ded_80g', is138 ? 's.133 (80G)' : '80G'], ['ded_80tta', is138 ? 's.153 (80TTA)' : '80TTA']];
    sheet('Annexure II', [
      ['Employee code', 'code', 14], ['PAN', 'pan', 14], ['Name', 'name', 28], ['Period from', 'from', 12], ['Period to', 'to', 12], [is138 ? 'Opting out of s.202(1)' : 'Opting out of 115BAC(1A)', 'opt', 10],
      ['Gross salary', 'gross'], ['Perquisites', 'perq'], ['Salary from previous employer(s)', 'prev'], ['Exemptions (total)', 'ex'], ['of which HRA', 'hra'], ['Standard deduction', 'std'], ['Tax on employment (PT)', 'pt'],
      ['Income chargeable under Salaries', 'sal'], ['House property', 'hp'], ['Other sources', 'os'], ['Gross total income', 'gti'],
      ...keys.map(([k, label]) => [label, k]), ['Total deductions', 'ded'], ['Total taxable income', 'ti'], ['Tax on total income', 'tax'], [is138 ? 'Rebate s.156' : 'Rebate 87A', 'rebate'], ['Surcharge', 'sur'], ['Cess', 'cess'],
      [is138 ? 'Relief s.157' : 'Relief 89', 'relief'], ['Net tax payable', 'net'], ['TDS by this employer', 'tdsC'], ['TDS by previous employer(s)', 'tdsP'], ['Shortfall (+) / excess (−)', 'short'],
      ['Rent above ₹1 lakh', 'rent', 10], ['Count of landlords', 'landlords', 10],
    ], d.annexureII.map((a) => ({
      code: a.employee.code, pan: a.pan, name: a.employee.name, from: ddmmyyyy(a.periodFrom), to: ddmmyyyy(a.periodTo), opt: a.optingOut, gross: a.grossSalary, perq: a.perquisites, prev: a.previousEmployerSalary,
      ex: a.exemptions, hra: a.hraExempt, std: a.standardDeduction, pt: a.professionalTax, sal: a.incomeFromSalary, hp: a.houseProperty, os: a.otherIncome, gti: a.grossTotalIncome,
      ...Object.fromEntries(keys.map(([k]) => [k, a.deductions[k] ?? 0])), ded: a.totalDeductions, ti: a.taxableIncome, tax: a.taxOnIncome, rebate: a.rebate, sur: a.surcharge, cess: a.cess, relief: a.relief89, net: a.netTax,
      tdsC: a.tdsCurrent, tdsP: a.tdsPrevious, short: a.shortfall, rent: a.rentOver1Lakh, landlords: a.landlords,
    })));
  }
  sheet('Validation', [['Level', 'level', 10], ['What to fix', 'what', 110]], d.validation.length ? d.validation : [{ level: 'OK', what: 'Nothing found.' }]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return { employeeIds: [...new Set([...d.deductees.map((r) => r.employee.id), ...(d.annexureII ?? []).map((a) => a.employee.id)])], fileName: `${is138 ? 'Form138' : 'Form24Q'}_${year}_${d.quarter}_RPU-data.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: buf.toString('base64') };
}
