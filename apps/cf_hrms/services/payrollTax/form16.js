/**
 * form16.js — Form 16 (to 2025-26) / Form 130 (from 2026-27): the salary certificate.
 * (TM/CF_HRMS_HIRING_SPEC.md §25.4 "Form 16 / 130".)
 *
 *   Part B (Form 16) / Part C Annexure-I (Form 130) — the computation of the salary and the tax —
 *   is GENERATED here per person per year from the year as paid (actuals.js), in the rows and the
 *   numbering of the year's form:
 *     Form 16 Part B (Annexure-I), rule 31, as amended in 2021 — reproduced as Annexure XI of CBDT
 *       Circular 24/2022 (https://traces61contents.tdscpc.gov.in/docs/circular-24-2022.pdf): A. opting
 *       for 115BAC; 1 gross salary (a)–(e); 2 section 10 exemptions; 3; 4 section 16; 5; 6; 7 other
 *       income; 8; 9 GTI; 10 Chapter VI-A; 11; 12 taxable; 13 tax; 14 rebate 87A; 15 surcharge;
 *       16 cess; 17 payable; 18 relief 89; 19 net.
 *     Form 130 Part C (Annexure-I), rule 215 of the Income-tax Rules 2026 (G.S.R. 198(E)): A. opting
 *       out of section 202(1); 1 salary s.16 / perquisites s.17 (Form 123) / s.18; 2 s.11 exemptions
 *       (Schedule III); 3; 4 s.19(1) deductions; 5; 6; 7 other income (392(4)); 8; 9; 10 Chapter VIII;
 *       11; 12; 13; 14 rebate s.156; 15; 16; 17; 18 relief s.157; 19 TDS per Form 122; 20 TCS; 21 net.
 *   The perquisites statement (Form 12BA / Form 123) is annexed when the year has perquisites
 *   (components with the exemption rule PERQUISITE).
 *   Part A is TRACES's: HR uploads the PDFs made by the TRACES PDF Converter (one per PAN), alone or
 *   in a ZIP; each is matched to a person by the PAN in its file name, else in its text, else HR
 *   assigns it. The download is Part A + Part B in one PDF (pdf-lib), released to the person in
 *   My tax › Forms when HR releases the year.
 */
import JSZip from 'jszip';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLib } from 'pdf-lib';
import { notFound } from '../../lib/errors.js';
import { pdfBuffer } from '../render/roleJd.js';
import { indianNumber } from '../letterRenderer.js';
import { audit, bad, refuse, money, n, yearMonths, employeeRow, pansOf, PAN_RE, stamp, json, formsOf, loadRules } from './common.js';
import { yearActuals } from './actuals.js';
import { deductorOf, yearSettings, review } from './settings.js';
import { storeFile, fileBytes, fileRow, readUpload } from './files.js';

const rs = (v) => `${Number(v ?? 0) < 0 ? '-' : ''}${indianNumber(Math.abs(Math.round(Number(v ?? 0)))) || '0'}`;
const safe = (s) => String(s ?? '').replace(/₹/g, 'Rs. ').replace(/[→⇒]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, '');

/** The rows of the year's Part B / Part C Annexure-I from an actual (actuals.js). */
export function partBRows(a, forms) {
  const k = a.computation;
  const is130 = forms.certificate.startsWith('Form 130');
  const ex = (key) => money((k.exemptions ?? []).filter((e) => e.key === key).reduce((s, e) => s + e.exempt, 0));
  const ded = (key) => (k.deductions ?? []).find((d) => d.key === key) ?? { claimed: 0, allowed: 0 };
  const salary = money(k.grossSalary - a.perquisiteTotal);
  const prevGross = money(n(a.previousEmployer?.taxableSalary));
  const exTotal = money(k.totalExempt);
  const exOther = money(exTotal - ex('exempt_lta') - ex('exempt_gratuity') - ex('exempt_leave_encashment') - ex('exempt_hra'));
  const s16 = money(k.standardDeduction + k.professionalTax);
  const other = ['ded_80c', 'ded_80ccd1b', 'ded_80ccd2', 'ded_80d', 'ded_80e', 'ded_80g', 'ded_80tta', 'ded_80ttb', 'ded_24b'];
  const othersAllowed = money((k.deductions ?? []).filter((d) => !other.includes(d.key)).reduce((s, d) => s + d.allowed, 0));
  const rows = [];
  const R = (no, label, amount, extra = {}) => rows.push({ no, label, amount: amount == null ? null : money(amount), ...extra });
  const optOut = a.regime === 'OLD' ? 'Yes' : 'No';
  if (!is130) {
    R('A', 'Whether opting out of taxation u/s 115BAC(1A)?', null, { text: optOut });
    R('1', 'Gross Salary', null, { head: true });
    R('(a)', 'Salary as per provisions contained in section 17(1)', salary);
    R('(b)', 'Value of perquisites under section 17(2) (as per Form No. 12BA, wherever applicable)', a.perquisiteTotal);
    R('(c)', 'Profits in lieu of salary under section 17(3)', 0);
    R('(d)', 'Total', k.grossSalary);
    R('(e)', 'Reported total amount of salary received from other employer(s)', prevGross);
    R('2', 'Less: Allowances to the extent exempt under section 10', null, { head: true });
    R('(a)', 'Travel concession or assistance under section 10(5)', ex('exempt_lta'));
    R('(b)', 'Death-cum-retirement gratuity under section 10(10)', ex('exempt_gratuity'));
    R('(c)', 'Commuted value of pension under section 10(10A)', 0);
    R('(d)', 'Cash equivalent of leave salary encashment under section 10(10AA)', ex('exempt_leave_encashment'));
    R('(e)', 'House rent allowance under section 10(13A)', ex('exempt_hra'));
    R('(g)', 'Amount of any other exemption under section 10', exOther);
    R('(h)', 'Total amount of exemption claimed under section 10', exTotal);
    R('3', 'Total amount of salary received from current employer [1(d)-2(h)]', k.grossSalary - exTotal);
    R('4', 'Less: Deductions under section 16', null, { head: true });
    R('(a)', 'Standard deduction under section 16(ia)', k.standardDeduction);
    R('(b)', 'Entertainment allowance under section 16(ii)', 0);
    R('(c)', 'Tax on employment under section 16(iii)', k.professionalTax);
    R('5', 'Total amount of deductions under section 16 [4(a)+4(b)+4(c)]', s16);
    R('6', 'Income chargeable under the head "Salaries" [(3+1(e)-5)]', k.incomeFromSalary);
    R('7', 'Add: Any other income reported by the employee under section 192(2B)', null, { head: true });
    R('(a)', 'Income (or admissible loss) from house property reported by employee offered for TDS', k.houseProperty);
    R('(b)', 'Income under the head Other Sources offered for TDS', k.otherIncome);
    R('8', 'Total amount of other income reported by the employee [7(a)+7(b)]', k.houseProperty + k.otherIncome);
    R('9', 'Gross total income (6+8)', k.grossTotalIncome);
    R('10', 'Deductions under Chapter VI-A (gross / deductible)', null, { head: true });
    R('(a)', 'Deduction in respect of life insurance premia, PF etc. under section 80C (with 80CCC, 80CCD(1))', ded('ded_80c').allowed, { gross: ded('ded_80c').claimed });
    R('(e)', 'Deduction in respect of contribution by taxpayer to pension scheme under section 80CCD(1B)', ded('ded_80ccd1b').allowed, { gross: ded('ded_80ccd1b').claimed });
    R('(f)', 'Deduction in respect of contribution by employer to pension scheme under section 80CCD(2)', ded('ded_80ccd2').allowed, { gross: ded('ded_80ccd2').claimed });
    R('(g)', 'Deduction in respect of health insurance premia under section 80D', ded('ded_80d').allowed, { gross: ded('ded_80d').claimed });
    R('(h)', 'Deduction in respect of interest on loan taken for higher education under section 80E', ded('ded_80e').allowed, { gross: ded('ded_80e').claimed });
    R('(i)', 'Total deduction in respect of donations under section 80G', ded('ded_80g').allowed, { gross: ded('ded_80g').claimed });
    R('(j)', 'Deduction in respect of interest on deposits in savings account under section 80TTA', ded('ded_80tta').allowed + ded('ded_80ttb').allowed, { gross: ded('ded_80tta').claimed + ded('ded_80ttb').claimed });
    R('(k)', 'Amount deductible under any other provision(s) of Chapter VI-A', othersAllowed);
    R('11', 'Aggregate of deductible amount under Chapter VI-A', k.totalDeductions);
    R('12', 'Total taxable income (9-11)', k.taxableIncome);
    R('13', 'Tax on total income', k.taxBeforeRebate);
    R('14', 'Rebate under section 87A, if applicable', k.rebate);
    R('15', 'Surcharge, wherever applicable', k.surcharge);
    R('16', 'Health and education cess', k.cess);
    R('17', 'Tax payable (13+15+16-14)', k.totalTax);
    R('18', 'Less: Relief under section 89 (attach details)', n(a.relief));
    R('19', 'Net tax payable (17-18)', k.totalTax - n(a.relief));
  } else {
    R('A', 'Whether opting out of taxation under section 202(1)?', null, { text: optOut });
    R('1', 'Salary', null, { head: true });
    R('(a)', 'Salary as per section 16', salary);
    R('(b)', 'Value of perquisites under section 17 (as per Form No. 123, wherever applicable)', a.perquisiteTotal);
    R('(c)', 'Profits in lieu of salary under section 18', 0);
    R('(d)', 'Total', k.grossSalary);
    R('(e)', 'Reported total amount of salary received from other employer(s)', prevGross);
    R('2', 'Less: Allowances to the extent exempt under section 11', null, { head: true });
    R('(a)', 'Travel concession or assistance (Schedule III, Sl. No. 8)', ex('exempt_lta'));
    R('(b)', 'House rent allowance (Schedule III, Sl. No. 11)', ex('exempt_hra'));
    R('(c)', 'Special allowances (Schedule III, Sl. No. 12–13)', 0);
    R('(e)', 'Any other exemption', exOther + ex('exempt_gratuity') + ex('exempt_leave_encashment'));
    R('(f)', 'Total amount of exemption claimed', exTotal);
    R('3', 'Total amount of salary received from current employer [1(d)-2(f)]', k.grossSalary - exTotal);
    R('4', 'Less: Deductions under section 19(1)', null, { head: true });
    R('(a)', 'Tax on employment', k.professionalTax);
    R('(b)', 'Standard deduction', k.standardDeduction);
    R('(c)', 'Gratuity', 0);
    R('(g)', 'Leave encashment', 0);
    R('5', 'Total amount of deductions under section 19(1)', s16);
    R('6', 'Income chargeable under the head "Salaries" [3+1(e)-5]', k.incomeFromSalary);
    R('7', 'Add: Any other income reported by the employee under section 392(4)', null, { head: true });
    R('(a)', 'Income under any other head', k.otherIncome);
    R('(b)', 'Loss under the head "Income from house property"', -Math.min(0, k.houseProperty));
    R('8', 'Total amount of other income reported by the employee [7(a)-7(b)]', k.otherIncome + Math.min(0, k.houseProperty));
    R('9', 'Gross total income (6+8)', k.grossTotalIncome);
    R('10', 'Deductions under Chapter VIII (gross / deductible)', null, { head: true });
    R('(a)', 'Section 123 (life insurance, PF, PPF … — was 80C)', ded('ded_80c').allowed, { gross: ded('ded_80c').claimed });
    R('(b)', 'Section 124(3) (own pension contribution — was 80CCD(1B))', ded('ded_80ccd1b').allowed, { gross: ded('ded_80ccd1b').claimed });
    R('(c)', 'Section 124(1)(a) (employer pension contribution — was 80CCD(2))', ded('ded_80ccd2').allowed, { gross: ded('ded_80ccd2').claimed });
    R('(d)', 'Section 126 (health insurance — was 80D)', ded('ded_80d').allowed, { gross: ded('ded_80d').claimed });
    R('(e)', 'Section 129 (education-loan interest — was 80E)', ded('ded_80e').allowed, { gross: ded('ded_80e').claimed });
    R('(h)', 'Section 133 (donations — was 80G)', ded('ded_80g').allowed, { gross: ded('ded_80g').claimed });
    R('(i)', 'Section 153 (interest on deposits — was 80TTA / 80TTB)', ded('ded_80tta').allowed + ded('ded_80ttb').allowed, { gross: ded('ded_80tta').claimed + ded('ded_80ttb').claimed });
    R('(k)', 'Any other deduction under Chapter VIII', othersAllowed);
    R('11', 'Aggregate of deductible amount under Chapter VIII', k.totalDeductions);
    R('12', 'Total taxable income (9-11)', k.taxableIncome);
    R('13', 'Tax on total income', k.taxBeforeRebate);
    R('14', 'Rebate under section 156, if applicable', k.rebate);
    R('15', 'Surcharge, wherever applicable', k.surcharge);
    R('16', 'Health and education cess', k.cess);
    R('17', 'Tax payable (13+15+16-14)', k.totalTax);
    R('18', 'Less: Relief under section 157', n(a.relief));
    R('19', 'Less: Tax deducted at source as per Form No. 122', n(a.previousEmployer?.tds));
    R('20', 'Less: Tax collected at source as per Form No. 122', 0);
    R('21', 'Net tax payable (17-18-19-20)', k.totalTax - n(a.relief) - n(a.previousEmployer?.tds));
  }
  return rows;
}

/** The PDF of Part B (+ the perquisite statement). From the snapshot only. */
export async function partBPdf(s) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 42, right: 42 }, info: { Title: `${s.forms.certificate} ${s.year} — ${s.employee.name}` } });
  const W = doc.page.width - 84;
  const L = 42;
  doc.font('Helvetica-Bold').fontSize(13).text(safe(s.is130 ? 'FORM NO. 130 — PART C (Annexure-I)' : 'FORM NO. 16 — PART B (Annexure-I)'), { align: 'center' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#555').text(safe(s.is130
    ? `[See rule 215 of the Income-tax Rules, 2026] Certificate under section 395 for tax deducted at source on salary under section 392 — tax year ${s.year}`
    : `[See rule 31(1)(a) of the Income-tax Rules, 1962] Details of salary paid and any other income and tax deducted — financial year ${s.year} (assessment year ${s.assessmentYear})`), { align: 'center' });
  if (s.provisional) doc.moveDown(0.3).font('Helvetica-Bold').fillColor('#b00020').fontSize(9).text('PROVISIONAL — the year is not complete in payroll (the March run is not locked). Not the final certificate.', { align: 'center' });
  doc.fillColor('#111').moveDown(0.6);
  const facts = [
    ['Employer (deductor)', s.deductor.name], ['TAN of the deductor', s.deductor.tan ?? '— not set (Tax › Settings)'], ['PAN of the deductor', s.deductor.pan ?? '—'],
    ['Employee', `${s.employee.name} (${s.employee.code})`], ['PAN of the employee', s.employee.pan ?? 'PANNOTAVBL'],
    ['Period with the employer', `${s.period.from} to ${s.period.to}`], ['Regime', s.regime === 'OLD' ? 'Old regime (opted out)' : 'New regime (the default)'],
  ];
  doc.fontSize(8.5);
  for (const [k, v] of facts) {
    const y = doc.y;
    doc.font('Helvetica').fillColor('#555').text(safe(k), L, y, { width: 150 });
    doc.font('Helvetica-Bold').fillColor('#111').text(safe(v), L + 155, y, { width: W - 155 });
  }
  doc.moveDown(0.6);
  const colNo = 30;
  const colGross = 80;
  const colAmt = 90;
  const colLabel = W - colNo - colGross - colAmt;
  const head = () => {
    const y = doc.y;
    doc.rect(L, y, W, 16).fill('#eeeeee').fillColor('#111').font('Helvetica-Bold').fontSize(8);
    doc.text('No.', L + 3, y + 4, { width: colNo }); doc.text('Particulars', L + colNo, y + 4, { width: colLabel });
    doc.text('Gross (Rs.)', L + colNo + colLabel, y + 4, { width: colGross - 6, align: 'right' }); doc.text('Amount (Rs.)', L + colNo + colLabel + colGross, y + 4, { width: colAmt - 6, align: 'right' });
    doc.y = y + 18;
  };
  head();
  for (const r of s.rows) {
    doc.font(r.head || /^\d+$|^A$/.test(r.no) ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    const h = Math.max(doc.heightOfString(safe(r.label), { width: colLabel - 4 }), 10) + 4;
    if (doc.y + h > doc.page.height - 60) { doc.addPage(); head(); }
    const y = doc.y;
    doc.fillColor('#111').text(safe(r.no), L + 3, y + 2, { width: colNo });
    doc.text(safe(r.label), L + colNo, y + 2, { width: colLabel - 4 });
    if (r.gross != null && r.gross !== r.amount) doc.text(rs(r.gross), L + colNo + colLabel, y + 2, { width: colGross - 6, align: 'right' });
    if (r.text) doc.text(safe(r.text), L + colNo + colLabel + colGross, y + 2, { width: colAmt - 6, align: 'right' });
    else if (r.amount != null) doc.text(rs(r.amount), L + colNo + colLabel + colGross, y + 2, { width: colAmt - 6, align: 'right' });
    doc.moveTo(L, y + h).lineTo(L + W, y + h).strokeColor('#dddddd').lineWidth(0.5).stroke();
    doc.y = y + h + 1;
  }
  doc.moveDown(0.6).font('Helvetica').fontSize(8).fillColor('#333');
  doc.text(safe(`Tax deducted by this employer in the year: Rs. ${rs(s.tds.total)} (Q1 ${rs(s.tds.Q1)}, Q2 ${rs(s.tds.Q2)}, Q3 ${rs(s.tds.Q3)}, Q4 ${rs(s.tds.Q4)}). The deposits and their challans are in Part ${s.is130 ? 'B' : 'A'}, issued from TRACES.`), L, doc.y, { width: W });
  doc.moveDown(0.3).text(safe(`Both regimes, for information: the ${s.regime === 'OLD' ? 'new' : 'old'} regime would come to Rs. ${rs(s.otherTax)} on the same facts.`), { width: W });
  if (s.notes?.length) for (const note of s.notes) doc.moveDown(0.2).text(safe(note), { width: W });
  doc.moveDown(1).font('Helvetica-Bold').fontSize(9).fillColor('#111').text('Verification');
  doc.font('Helvetica').fontSize(8).text(safe(`I, ${s.deductor.responsible?.name ?? '____________________'}, ${s.deductor.responsible?.designation ? `working in the capacity of ${s.deductor.responsible.designation}, ` : ''}do hereby certify that the information given above is true, complete and correct and is based on the books of account, documents, TDS statements, and other available records.`), { width: W });
  doc.moveDown(1.5).text('Place: ____________________          Date: ____________________          Signature of the person responsible for deduction of tax', { width: W });
  doc.moveDown(0.8).fontSize(7).fillColor('#777').text(safe(`Generated by CF HRMS from the locked payroll runs of ${s.year} on ${s.generatedAt.slice(0, 10)}. ${s.caReviewed ? '' : `Not yet reviewed by the company's CA for ${s.year}.`}`), { width: W });

  if (s.perquisites?.length) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text(safe(s.is130 ? 'FORM NO. 123' : 'FORM NO. 12BA'), { align: 'center' });
    doc.font('Helvetica').fontSize(8.5).fillColor('#555').text(safe(s.is130 ? '[See rule 204(2)(b)] Statement showing particulars of perquisites, other fringe benefits or amenities and profits in lieu of salary' : '[See rule 26A(2)(b)] Statement showing particulars of perquisites, other fringe benefits or amenities and profits in lieu of salary with value thereof'), { align: 'center' });
    doc.moveDown(0.6).fillColor('#111').fontSize(8.5);
    for (const [k, v] of [['Name and address of employer', `${s.deductor.name}${s.deductor.address?.line1 ? `, ${s.deductor.address.line1}` : ''}`], ['TAN', s.deductor.tan ?? '—'], ['Name and designation of employee', `${s.employee.name}${s.employee.designation ? `, ${s.employee.designation}` : ''}`], ['PAN of employee', s.employee.pan ?? 'PANNOTAVBL'], ['Salary excluding perquisites', `Rs. ${rs(s.salaryExcludingPerquisites)}`], [s.is130 ? 'Tax year' : 'Financial year', s.year]]) {
      const y = doc.y;
      doc.font('Helvetica').text(safe(k), L, y, { width: 200 }); doc.font('Helvetica-Bold').text(safe(v), L + 205, y, { width: W - 205 });
    }
    doc.moveDown(0.6);
    const y0 = doc.y;
    doc.rect(L, y0, W, 16).fill('#eeeeee').fillColor('#111').font('Helvetica-Bold').fontSize(8);
    doc.text('Nature of perquisite', L + 3, y0 + 4, { width: 230 }); doc.text('Value as per rules', L + 240, y0 + 4, { width: 90, align: 'right' }); doc.text('Recovered', L + 335, y0 + 4, { width: 70, align: 'right' }); doc.text('Taxable', L + 410, y0 + 4, { width: W - 416, align: 'right' });
    doc.y = y0 + 18;
    for (const p of s.perquisites) {
      const y = doc.y;
      // P3b: the nature (with its row of the form), the value as per the rules, what the employee paid back, the taxable value.
      const nature = p.nature ? `${p.row ? `${p.row}. ` : ''}${p.nature}` : `Other benefit or amenity — ${p.name}`;
      doc.font('Helvetica').text(safe(nature), L + 3, y, { width: 230 });
      const h = doc.heightOfString(safe(nature), { width: 230 });
      doc.text(rs(p.valueAsPerRules ?? p.value), L + 240, y, { width: 90, align: 'right' }); doc.text(rs(p.recovered ?? 0), L + 335, y, { width: 70, align: 'right' }); doc.text(rs(p.value), L + 410, y, { width: W - 416, align: 'right' });
      doc.y = y + Math.max(14, h + 3);
    }
    doc.font('Helvetica-Bold').text(safe(`Total value of perquisites: Rs. ${rs(s.perquisiteTotal)}`), L, doc.y + 4);
  }
  return pdfBuffer(doc);
}

/** The snapshot Part B prints, for one person (from yearActuals). */
function snapshotOf({ a, employee, deductor, forms, year, settings }) {
  const is130 = forms.certificate.startsWith('Form 130');
  const startYear = Number(year.slice(0, 4));
  const notes = [];
  if (a.panStatus !== 'VALID') notes.push('The employee has no valid PAN on file: TDS was at the higher rate (section 206AA / 397(2)). TRACES issues Form 16 / 130 Part A only for a valid PAN.');
  if (a.relief) notes.push(`Relief for arrears of Rs. ${rs(a.relief)} (${a.reliefRule?.section ?? 'section 89 / 157'}) from the employee's ${a.reliefRule?.form ?? 'Form 10E / 39'}.`);
  if (a.retirement?.excess) notes.push(`Employer's contributions to PF, NPS and superannuation this year: Rs. ${rs(a.retirement.total)}; Rs. ${rs(a.retirement.excess)} above the limit is a perquisite (Form ${is130 ? '123' : '12BA'}).`);
  if (a.previousEmployer) notes.push(`Includes salary from a previous employer this year (${forms.previousEmployer}): Rs. ${rs(a.previousEmployer.taxableSalary)}, its TDS Rs. ${rs(a.previousEmployer.tds)}.`);
  return {
    version: 1, year, assessmentYear: `${startYear + 1}-${String((startYear + 2) % 100).padStart(2, '0')}`, is130, forms,
    deductor: { name: deductor.name, tan: deductor.tan, pan: deductor.pan, address: deductor.address, responsible: deductor.responsible },
    employee: { id: employee.id, code: employee.code, name: employee.name, pan: a.pan, designation: employee.designation ?? null },
    period: a.period, regime: a.regime, rows: partBRows(a, forms), otherTax: a.otherComputation.totalTax, totalTax: a.computation.totalTax,
    tds: { total: a.tds, ...a.tdsByQuarter }, perquisites: a.perquisites, perquisiteTotal: a.perquisiteTotal, salaryExcludingPerquisites: money(a.computation.grossSalary - a.perquisiteTotal),
    relief: n(a.relief), provisional: a.provisional, notes, caReviewed: settings.caReviewed, generatedAt: new Date().toISOString(),
  };
}

const fileNameOf = (s, part) => `${s.is130 ? 'Form130' : 'Form16'}_${s.year}_${s.employee.code}_${part}.pdf`.replace(/[^A-Za-z0-9_.-]/g, '');

/** POST /tax/:year/forms/generate { employeeIds? } — Part B for everyone paid in the year (or those). */
export async function generateForms(db, c, year, body = {}, requestId = null) {
  const { rules, reason } = await loadRules(db, year);
  if (!rules) throw refuse('NO_RULES', reason);
  const forms = formsOf(rules);
  const months = yearMonths(year);
  let ids = Array.isArray(body.employeeIds) ? body.employeeIds.map(Number).filter((x) => Number.isInteger(x) && x > 0) : null;
  if (!ids) {
    const [rows] = await db.query(
      `SELECT DISTINCT p.employee_id FROM hrms_pay_run_people p JOIN hrms_pay_runs r ON r.company_id = p.company_id AND r.id = p.run_id AND r.deleted_at IS NULL
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.included = 1 AND r.status IN ('LOCKED','RELEASED','PAID') AND r.period_month BETWEEN ? AND ?`, [c.companyId, months[0], months[11]]);
    ids = rows.map((r) => r.employee_id);
  }
  if (!ids.length) throw refuse('NOTHING_PAID', `No locked payroll in ${year} yet: nothing to certify.`);
  if (ids.length > 2000) throw bad('At most 2,000 people at a time.');
  const { actuals } = await yearActuals(db, c.companyId, year, ids);
  const deductor = await deductorOf(db, c.companyId);
  const settings = await yearSettings(db, c.companyId, year);
  const [seat] = await db.query(
    `SELECT wa.employee_id, p.position_title FROM hrms_work_assignments wa LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
      WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY wa.is_primary DESC, wa.id`, [c.companyId, ...ids]);
  const titles = new Map();
  for (const s of seat) if (!titles.has(s.employee_id)) titles.set(s.employee_id, s.position_title);
  const made = [];
  const skipped = [];
  for (const id of ids) {
    const a = actuals.get(id);
    if (!a) { skipped.push({ employeeId: id, why: `no locked pay in ${year}` }); continue; }
    const employee = { ...(await employeeRow(db, c.companyId, id)), designation: titles.get(id) ?? null };
    const snap = snapshotOf({ a, employee, deductor, forms, year, settings });
    const pdf = await partBPdf(snap);
    const fileId = await storeFile(db, c, { purpose: 'PART_B', year, employeeId: id, fileName: fileNameOf(snap, 'PartB'), mimeType: 'application/pdf' }, pdf);
    const [[f]] = await db.query('SELECT id, part_b_file_id FROM hrms_tax_forms WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, id, year]);
    if (f) {
      if (f.part_b_file_id) await db.query('UPDATE hrms_tax_files SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, f.part_b_file_id]);
      await db.query('UPDATE hrms_tax_forms SET part_b_file_id = ?, snapshot_json = ?, generated_at = NOW(), generated_by = ?, provisional = ? WHERE id = ?', [fileId, JSON.stringify(snap), c.userId, snap.provisional ? 1 : 0, f.id]);
    } else {
      await db.query('INSERT INTO hrms_tax_forms (company_id, employee_id, tax_year, part_b_file_id, snapshot_json, generated_at, generated_by, provisional, created_by) VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?)',
        [c.companyId, id, year, fileId, JSON.stringify(snap), c.userId, snap.provisional ? 1 : 0, c.userId]);
    }
    made.push({ employeeId: id, totalTax: snap.totalTax, tds: snap.tds.total, provisional: snap.provisional });
  }
  await audit(db, c, 'hrms_tax_forms', 0, 'GENERATE', null, { year, made: made.length, skipped: skipped.length, employeeIds: made.map((m) => m.employeeId).slice(0, 2000) }, requestId);
  return { year, made, skipped, form: forms.certificate };
}

/** GET /tax/:year/forms — per person: Part B generated?, Part A matched? and the unmatched Part A files. */
export async function listForms(db, c, year) {
  const [rows] = await db.query(
    `SELECT f.*, e.employee_code, e.full_name FROM hrms_tax_forms f JOIN hrms_employees e ON e.company_id = f.company_id AND e.id = f.employee_id
      WHERE f.company_id = ? AND f.tax_year = ? AND f.deleted_at IS NULL ORDER BY e.full_name`, [c.companyId, year]);
  const [loose] = await db.query("SELECT id, file_name, pan_found, created_at FROM hrms_tax_files WHERE company_id = ? AND tax_year = ? AND purpose = 'PART_A' AND employee_id IS NULL AND deleted_at IS NULL ORDER BY id", [c.companyId, year]);
  const settings = await yearSettings(db, c.companyId, year);
  const { rules } = await loadRules(db, year);
  return {
    year, form: rules ? formsOf(rules).certificate : null, released: settings.formsReleased, releasedAt: settings.formsReleasedAt, review: review(settings),
    people: rows.map((f) => {
      const s = json(f.snapshot_json, {}) ?? {};
      return { employee: { id: f.employee_id, code: f.employee_code, name: f.full_name }, partB: Boolean(f.part_b_file_id), partA: Boolean(f.part_a_file_id), generatedAt: stamp(f.generated_at), provisional: Boolean(f.provisional), totalTax: s.totalTax ?? null, tds: s.tds?.total ?? null, regime: s.regime ?? null };
    }),
    unmatched: loose.map((l) => ({ id: l.id, fileName: l.file_name, panFound: l.pan_found, uploadedAt: stamp(l.created_at) })),
  };
}

/* ── Part A ──────────────────────────────────────────────────────────── */

/** PANs in a PDF's text: literal strings and FlateDecode streams, searched for the PAN shape. */
export function pansInPdf(buffer) {
  const found = new Set();
  const scan = (s) => {
    for (const m of s.matchAll(/[A-Z]{5}[0-9]{4}[A-Z]/g)) found.add(m[0]);
    // Text written as hex strings (<41424344…>), as many PDF makers do: decoded and scanned too.
    const hex = [...s.matchAll(/<([0-9A-Fa-f\s]{8,})>/g)].map((h) => Buffer.from(h[1].replace(/\s/g, ''), 'hex').toString('latin1')).join('');
    for (const m of hex.matchAll(/[A-Z]{5}[0-9]{4}[A-Z]/g)) found.add(m[0]);
  };
  const latin = buffer.toString('latin1');
  scan(latin);
  const re = /stream\r?\n/g;
  let m;
  let inflated = 0;
  while ((m = re.exec(latin))) {
    if (inflated > PART_A_LIMITS.scanTotal) break; // enough read: a Part A is small; a bomb is not read to the end
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    try {
      // P3b review: at most PART_A_LIMITS.stream bytes out of one stream (zlib stops and throws past it).
      const out = zlib.inflateSync(buffer.subarray(start, end), { maxOutputLength: PART_A_LIMITS.stream });
      inflated += out.length;
      const s = out.toString('latin1');
      scan(s);
      scan(s.replace(/[()\\]/g, ''));
    } catch { /* not deflated */ }
    re.lastIndex = end;
  }
  return [...found];
}

/** Limits on unpacking a Part A upload (bytes, files). */
export const PART_A_LIMITS = Object.freeze({ entry: 20 * 1024 * 1024, total: 200 * 1024 * 1024, entries: 3000, stream: 20 * 1024 * 1024, scanTotal: 60 * 1024 * 1024 });

/** A ZIP entry's bytes, refused in words once it passes `max`. */
export function readCapped(entry, max, name) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let done = false;
    const stream = entry.internalStream('nodebuffer');
    stream.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > max) { done = true; stream.pause(); reject(bad(`${name} unpacks to more than the ${Math.round(max / 1024 / 1024)} MB allowed: not a Part A. Nothing was saved.`)); return; }
      parts.push(Buffer.from(chunk));
    });
    stream.on('error', (e) => { if (!done) { done = true; reject(bad(`${name} cannot be unpacked (${e.message}).`)); } });
    stream.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts)); } });
    stream.resume();
  });
}

/** POST /tax/:year/forms/part-a { fileName, contentBase64 } — a PDF, or a ZIP of PDFs. */
export async function uploadPartA(db, c, year, body = {}, requestId = null) {
  const { buffer, fileName, mimeType } = readUpload(body, { max: 60 * 1024 * 1024, allow: ['application/pdf', 'application/zip'], what: 'Part A' });
  const pdfs = [];
  if (mimeType === 'application/zip') {
    let zip;
    try { zip = await JSZip.loadAsync(buffer); } catch (e) {
      throw bad(`That ZIP cannot be opened (${e.message}). The ZIP downloaded from TRACES is locked with your TAN: open it with the TRACES PDF Converter, then upload the PDFs it makes (or a ZIP of them).`);
    }
    // P3b review: each entry at most PART_A_LIMITS.entry bytes unpacked, all together at most PART_A_LIMITS.total,
    // at most PART_A_LIMITS.entries files — read as a stream and stopped past the limit (a ZIP bomb is refused, not unpacked).
    const entries = Object.values(zip.files).filter((e) => !e.dir && /\.pdf$/i.test(e.name));
    if (entries.length > PART_A_LIMITS.entries) throw bad(`That ZIP has ${entries.length} PDFs; at most ${PART_A_LIMITS.entries} at a time.`);
    let total = 0;
    for (const entry of entries) {
      const declared = Number(entry._data?.uncompressedSize);
      if (Number.isFinite(declared) && declared > PART_A_LIMITS.entry) throw bad(`${entry.name} unpacks to more than ${PART_A_LIMITS.entry / 1024 / 1024} MB: not a Part A. Nothing was saved.`);
      const buf = await readCapped(entry, Math.min(PART_A_LIMITS.entry, PART_A_LIMITS.total - total), entry.name);
      total += buf.length;
      pdfs.push({ name: entry.name.split('/').pop(), buffer: buf });
    }
    if (!pdfs.length) throw bad('There is no PDF in that ZIP. Upload the PDFs the TRACES PDF Converter makes.');
  } else pdfs.push({ name: fileName, buffer });
  const [emps] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const pans = await pansOf(db, c.companyId, emps.map((e) => e.id));
  const byPan = new Map([...pans.entries()].filter(([, p]) => p && PAN_RE.test(p)).map(([id, p]) => [p, id]));
  const matched = [];
  const unmatched = [];
  for (const p of pdfs) {
    let employeeId = null;
    let how = null;
    let panFound = null;
    const inName = [...String(p.name).toUpperCase().matchAll(/[A-Z]{5}[0-9]{4}[A-Z]/g)].map((x) => x[0]);
    const hitName = inName.find((x) => byPan.has(x));
    if (hitName) { employeeId = byPan.get(hitName); how = 'FILE_NAME'; panFound = hitName; } else {
      const inText = pansInPdf(p.buffer).filter((x) => byPan.has(x));
      if (inText.length === 1) { employeeId = byPan.get(inText[0]); how = 'CONTENT'; panFound = inText[0]; } else panFound = inName[0] ?? null;
    }
    const fileId = await storeFile(db, c, { purpose: 'PART_A', year, employeeId, fileName: p.name.slice(0, 255), mimeType: 'application/pdf', matchedBy: how, panFound }, p.buffer);
    if (employeeId) { await linkPartA(db, c, year, employeeId, fileId); matched.push({ fileId, fileName: p.name, employeeId, by: how }); } else unmatched.push({ fileId, fileName: p.name, panFound });
  }
  await audit(db, c, 'hrms_tax_forms', 0, 'IMPORT', null, { year, partA: fileName, files: pdfs.length, matched: matched.length, unmatched: unmatched.length }, requestId);
  return { year, files: pdfs.length, matched, unmatched };
}

async function linkPartA(db, c, year, employeeId, fileId) {
  const [[f]] = await db.query('SELECT id, part_a_file_id FROM hrms_tax_forms WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, employeeId, year]);
  if (f) {
    if (f.part_a_file_id && f.part_a_file_id !== fileId) await db.query('UPDATE hrms_tax_files SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, f.part_a_file_id]);
    await db.query('UPDATE hrms_tax_forms SET part_a_file_id = ? WHERE id = ?', [fileId, f.id]);
  } else {
    await db.query('INSERT INTO hrms_tax_forms (company_id, employee_id, tax_year, part_a_file_id, created_by) VALUES (?, ?, ?, ?, ?)', [c.companyId, employeeId, year, fileId, c.userId]);
  }
}

/** PUT /tax/:year/forms/part-a/:fileId { employeeId } — HR matches a file by hand. */
export async function assignPartA(db, c, year, fileId, body = {}, requestId = null) {
  const row = await fileRow(db, c.companyId, fileId);
  if (row.purpose !== 'PART_A' || row.tax_year !== year) throw bad('That is not a Part A of this year.');
  const employeeId = Number(body.employeeId);
  await employeeRow(db, c.companyId, employeeId);
  await db.query("UPDATE hrms_tax_files SET employee_id = ?, matched_by = 'HR' WHERE id = ?", [employeeId, fileId]);
  await linkPartA(db, c, year, employeeId, fileId);
  await audit(db, c, 'hrms_tax_files', fileId, 'UPDATE', { employeeId: row.employee_id }, { employeeId, matchedBy: 'HR' }, requestId);
  return { ok: true };
}

/** The download: part 'A', 'B' or 'merged' (A then B in one PDF). */
export async function formFile(db, c, year, employeeId, part = 'merged') {
  const [[f]] = await db.query('SELECT * FROM hrms_tax_forms WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND deleted_at IS NULL', [c.companyId, employeeId, year]);
  if (!f) throw notFound(`Form 16 / 130 for ${year}`);
  const s = json(f.snapshot_json, {}) ?? {};
  const label = s.is130 ? 'Form130' : 'Form16';
  const A = f.part_a_file_id ? await fileBytes(db, c.companyId, f.part_a_file_id) : null;
  const B = f.part_b_file_id ? await fileBytes(db, c.companyId, f.part_b_file_id) : null;
  const code = s.employee?.code ?? employeeId;
  if (part === 'A') { if (!A) throw notFound('Part A'); return { fileName: A.row.file_name, mimeType: 'application/pdf', contentBase64: A.buffer.toString('base64') }; }
  if (part === 'B' || !A) { if (!B) throw notFound('Part B (generate it first)'); return { fileName: B.row.file_name, mimeType: 'application/pdf', contentBase64: B.buffer.toString('base64'), partAMissing: !A }; }
  if (!B) return { fileName: A.row.file_name, mimeType: 'application/pdf', contentBase64: A.buffer.toString('base64'), partBMissing: true };
  try {
    const out = await PdfLib.create();
    for (const part2 of [A, B]) {
      const src = await PdfLib.load(part2.buffer, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    }
    const bytes = Buffer.from(await out.save());
    return { fileName: `${label}_${year}_${code}.pdf`.replace(/[^A-Za-z0-9_.-]/g, ''), mimeType: 'application/pdf', contentBase64: bytes.toString('base64'), merged: true };
  } catch {
    // A Part A that cannot be opened (locked): both files in a ZIP, said so.
    const zip = new JSZip();
    zip.file(A.row.file_name, A.buffer);
    zip.file(B.row.file_name, B.buffer);
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    return { fileName: `${label}_${year}_${code}.zip`, mimeType: 'application/zip', contentBase64: bytes.toString('base64'), merged: false, note: 'Part A could not be joined to Part B (the PDF is locked): both are in this ZIP.' };
  }
}

/** My tax › Forms: my forms of the released years. */
export async function myForms(db, c, employeeId) {
  const [rows] = await db.query(
    `SELECT f.tax_year, f.part_a_file_id, f.part_b_file_id, f.provisional, f.generated_at, f.snapshot_json, s.forms_released_at
       FROM hrms_tax_forms f JOIN hrms_tax_settings s ON s.company_id = f.company_id AND s.tax_year = f.tax_year AND s.deleted_at IS NULL AND s.forms_released_at IS NOT NULL
      WHERE f.company_id = ? AND f.employee_id = ? AND f.deleted_at IS NULL ORDER BY f.tax_year DESC`, [c.companyId, employeeId]);
  return {
    forms: rows.map((r) => {
      const s = json(r.snapshot_json, {}) ?? {};
      return { year: r.tax_year, form: s.forms?.certificate ?? (r.tax_year >= '2026-27' ? 'Form 130 (was Form 16)' : 'Form 16'), partA: Boolean(r.part_a_file_id), partB: Boolean(r.part_b_file_id), provisional: Boolean(r.provisional), releasedAt: stamp(r.forms_released_at), totalTax: s.totalTax ?? null, tds: s.tds?.total ?? null };
    }),
  };
}

export async function myFormFile(db, c, employeeId, year, part) {
  const [[s]] = await db.query('SELECT forms_released_at FROM hrms_tax_settings WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL', [c.companyId, year]);
  if (!s?.forms_released_at) throw refuse('NOT_RELEASED', `HR has not released the forms for ${year} yet.`);
  return formFile(db, c, year, employeeId, part);
}
