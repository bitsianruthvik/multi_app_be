/**
 * form10e.js — the Form 10E (to 2025-26) / Form No. 39 (from 2026-27) worksheet: relief when salary is
 * received in arrears for earlier years. (TM/CF_HRMS_HIRING_SPEC.md §25.5 "Arrears and relief".)
 *
 * WHERE THE NUMBERS COME FROM
 *   arrears      the payroll's ARREARS lines in LOCKED runs of the year of receipt whose for_month is in
 *                an EARLIER tax year, summed by that year (a back-dated revision paid later, P1);
 *   receipt year total income INCLUDING the arrears: the year as paid (payrollTax/actuals.js — the
 *                engine on the locked runs, the person's regime), or typed when there is no payroll;
 *   earlier year with tax rules here (hrms_tax_rules): its total income from that year's locked payroll,
 *                or typed; the taxes are the ENGINE's, with that year's rules, in that year's regime;
 *   earlier year with NO rules here: flagged; the person or HR types its total income, the tax on it
 *                and the tax on it with the arrears added.
 *   The arithmetic is services/tax/relief.js; the law and the form by year are the rule `relief_arrears`.
 *
 * The worksheet is kept (hrms_tax_relief_10e: what was typed, and the result the PDF prints). The person
 * sees it in My tax › Forms and may type the earlier years' figures too; the PDF is theirs to file on
 * the e-filing portal (Form 10E / Form 39 is filed online before the return).
 */
import PDFDocument from 'pdfkit';
import { HrmsError } from '../../lib/errors.js';
import { pdfBuffer } from '../render/roleJd.js';
import { indianNumber } from '../letterRenderer.js';
import { taxOnTotalIncome, worksheet } from '../tax/relief.js';
import { audit, bad, refuse, json, stamp, yearOf, yearMonths, loadRules, employeeRow, pansOf, n } from '../payrollTax/common.js';
import { yearActuals } from '../payrollTax/actuals.js';
import { profilesOf } from '../payrollTax/profiles.js';
import { deductorOf } from '../payrollTax/settings.js';

const FROZEN = ['LOCKED', 'RELEASED', 'PAID'];
const YEAR_RE = /^\d{4}-\d{2}$/;
const rs = (v) => `${Number(v ?? 0) < 0 ? '-' : ''}${indianNumber(Math.abs(Math.round(Number(v ?? 0)))) || '0'}`;
const safe = (s) => String(s ?? '').replace(/₹/g, 'Rs. ').replace(/[→⇒]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, '');

/** The law of a receipt year in words (rule relief_arrears), or the refusal. */
export function lawOf(rules, year) {
  if (!rules) throw refuse('NO_RULES', `No tax rules for ${year}: the worksheet needs the year's rates.`);
  if (!rules.NEW.has('relief_arrears')) throw refuse('NO_RULES', `The rule "relief_arrears" is missing for ${year}. Run seed-tax-rules.mjs.`);
  const src = rules.NEW.source('relief_arrears');
  return { ...rules.NEW.get('relief_arrears'), source: src.note, sourceUrl: src.url, verified: src.verified };
}

/**
 * Arrears of earlier tax years paid in locked runs of `year`:
 * Map<employeeId, { total, byYear: { '2024-25': { amount, months: [{ forMonth, paidIn, amount }] } } }>.
 */
export async function earlierArrears(db, companyId, year, employeeIds = null) {
  const months = yearMonths(year);
  const where = employeeIds ? `AND l.employee_id IN (${employeeIds.length ? employeeIds.map(() => '?').join(',') : 'NULL'})` : '';
  const [rows] = await db.query(
    `SELECT l.employee_id, l.for_month, l.amount, r.period_month
       FROM hrms_pay_run_lines l
       JOIN hrms_pay_runs r ON r.company_id = l.company_id AND r.id = l.run_id AND r.deleted_at IS NULL
       JOIN hrms_pay_run_people p ON p.company_id = l.company_id AND p.id = l.run_person_id AND p.deleted_at IS NULL AND p.included = 1
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.source = 'ARREARS' AND l.for_month IS NOT NULL
        AND r.period_month BETWEEN ? AND ? AND r.status IN (${FROZEN.map(() => '?').join(',')}) ${where}
      ORDER BY l.employee_id, l.for_month`,
    [companyId, months[0], months[11], ...FROZEN, ...(employeeIds ?? [])]);
  const out = new Map();
  for (const r of rows) {
    const fy = yearOf(r.for_month);
    if (fy >= year) continue; // arrears of the same year are taxed in that year anyway
    if (!out.has(r.employee_id)) out.set(r.employee_id, { total: 0, byYear: {} });
    const o = out.get(r.employee_id);
    const y = (o.byYear[fy] ??= { amount: 0, months: [] });
    y.amount += n(r.amount);
    y.months.push({ forMonth: r.for_month, paidIn: r.period_month, amount: n(r.amount) });
    o.total += n(r.amount);
  }
  for (const o of out.values()) {
    o.total = Math.round(o.total);
    for (const y of Object.values(o.byYear)) y.amount = Math.round(y.amount);
  }
  return out;
}

async function rowOf(db, companyId, employeeId, year) {
  const [[r]] = await db.query('SELECT * FROM hrms_tax_relief_10e WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND deleted_at IS NULL', [companyId, employeeId, year]);
  return r ?? null;
}
const shapeRow = (r) => (r ? {
  id: r.id, year: r.tax_year, status: r.status, relief: Number(r.relief) || 0, inputs: json(r.inputs_json, {}) ?? {}, result: json(r.result_json, null),
  generatedAt: stamp(r.generated_at), updatedAt: stamp(r.updated_at),
} : null);

/** Reads what typed figures say, refusing nonsense. */
function readInputs(body = {}, current = {}) {
  const problems = [];
  const out = { earlier: { ...(current.earlier ?? {}) }, receipt: { ...(current.receipt ?? {}) } };
  const amount = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(String(v).replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(x) || x < 0 || x >= 1e12) { problems.push(`${label}: “${String(v).slice(0, 20)}” is not an amount.`); return null; }
    return Math.round(x);
  };
  for (const [y, e] of Object.entries(body.earlier ?? {})) {
    if (!YEAR_RE.test(y)) { problems.push(`“${y}” is not a tax year.`); continue; }
    if (e === null) { delete out.earlier[y]; continue; }
    const regime = e.regime == null || e.regime === '' ? null : String(e.regime).toUpperCase();
    if (regime && !['OLD', 'NEW'].includes(regime)) problems.push(`${y}: the regime is old or new.`);
    out.earlier[y] = {
      regime, totalIncome: amount(e.totalIncome, `${y} total income`), taxWithout: amount(e.taxWithout, `${y} tax on the total income`), taxWith: amount(e.taxWith, `${y} tax with the arrears`),
    };
  }
  if (body.receipt !== undefined) out.receipt = { totalIncome: amount(body.receipt?.totalIncome, 'Total income of the year of receipt') };
  if (problems.length) throw bad('Those figures cannot be saved.', problems);
  return out;
}

/**
 * The worksheet of one person and year, worked out now (nothing written).
 * @returns the snapshot the PDF prints, or null when the person has no earlier-year arrears.
 */
export async function computeFor(db, companyId, employeeId, year, inputs = {}) {
  const arrears = (await earlierArrears(db, companyId, year, [employeeId])).get(employeeId);
  if (!arrears) return null;
  const { rules, reason } = await loadRules(db, year);
  if (!rules) throw refuse('NO_RULES', reason);
  const law = lawOf(rules, year);
  const employee = await employeeRow(db, companyId, employeeId);
  const pan = (await pansOf(db, companyId, [employeeId])).get(employeeId) ?? null;
  const notes = [];

  // The year of receipt: as paid, or typed.
  const { actuals } = await yearActuals(db, companyId, year, [employeeId]);
  const act = actuals.get(employeeId);
  const regime = act?.regime ?? (await profilesOf(db, companyId, [employeeId], year)).get(employeeId)?.regime ?? 'NEW';
  let receiptIncome = null;
  let receiptHow = 'PAYROLL';
  if (inputs.receipt?.totalIncome != null) { receiptIncome = inputs.receipt.totalIncome; receiptHow = 'TYPED'; } else if (act) receiptIncome = act.computation.taxableIncome;
  if (receiptIncome == null) throw refuse('NO_INCOME', `No payroll of ${year} to take the total income from. Type the total income of ${year}.`);
  if (receiptHow === 'PAYROLL' && act?.provisional) notes.push(`${year} is not complete in payroll (the March run is not locked): its total income is as paid so far. Generate again after March.`);
  const R = rules[regime];
  const receipt = {
    year, regime, how: receiptHow, totalIncome: Math.round(receiptIncome),
    taxWith: taxOnTotalIncome(R, receiptIncome, { dateOfBirth: employee.dateOfBirth }),
    taxWithout: taxOnTotalIncome(R, Math.max(0, receiptIncome - arrears.total), { dateOfBirth: employee.dateOfBirth }),
  };

  // Each earlier year.
  const earlier = [];
  for (const [y, a] of Object.entries(arrears.byYear)) {
    const typed = inputs.earlier?.[y] ?? {};
    const ry = await loadRules(db, y);
    if (ry.rules) {
      let totalIncome = typed.totalIncome ?? null;
      let how = 'TYPED';
      let yRegime = typed.regime ?? null;
      if (totalIncome == null) {
        const ya = (await yearActuals(db, companyId, y, [employeeId])).actuals.get(employeeId);
        if (ya) { totalIncome = ya.computation.taxableIncome; how = 'PAYROLL'; yRegime = yRegime ?? ya.regime; }
      }
      yRegime = yRegime ?? (await profilesOf(db, companyId, [employeeId], y)).get(employeeId)?.regime ?? 'NEW';
      if (totalIncome == null) { earlier.push({ year: y, arrears: a.amount, months: a.months, how: 'MISSING', rules: true, regime: yRegime, need: ['totalIncome'] }); continue; }
      const Ry = ry.rules[yRegime];
      earlier.push({
        year: y, arrears: a.amount, months: a.months, how: how === 'PAYROLL' ? 'ENGINE' : 'ENGINE_TYPED_INCOME', incomeFrom: how, rules: true, regime: yRegime, totalIncome,
        taxWithout: taxOnTotalIncome(Ry, totalIncome, { dateOfBirth: employee.dateOfBirth }),
        taxWith: taxOnTotalIncome(Ry, totalIncome + a.amount, { dateOfBirth: employee.dateOfBirth }),
      });
    } else if (typed.totalIncome != null && typed.taxWithout != null && typed.taxWith != null) {
      earlier.push({ year: y, arrears: a.amount, months: a.months, how: 'TYPED', rules: false, regime: typed.regime ?? null, totalIncome: typed.totalIncome, taxWithout: typed.taxWithout, taxWith: typed.taxWith });
    } else {
      earlier.push({ year: y, arrears: a.amount, months: a.months, how: 'MISSING', rules: false, regime: typed.regime ?? null, need: ['totalIncome', 'taxWithout', 'taxWith'] });
    }
  }
  if (earlier.some((e) => !e.rules)) notes.push('A year without tax rules in this app: its total income and both taxes are as typed (from that year’s return or Form 16). Check them.');
  const w = worksheet({ receipt, earlier: earlier.map((e) => ({ ...e, how: e.how === 'MISSING' ? 'MISSING' : e.how })) });
  return {
    version: 1, year, law, employee: { id: employee.id, code: employee.code, name: employee.name, pan }, regime, receipt,
    earlier, worksheet: w, notes, generatedAt: new Date().toISOString(),
  };
}

/** HR: the people of a year with arrears for earlier years, and their worksheets. */
export async function listYear(db, c, year) {
  const arrears = await earlierArrears(db, c.companyId, year);
  const [rows] = await db.query('SELECT * FROM hrms_tax_relief_10e WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL', [c.companyId, year]);
  const kept = new Map(rows.map((r) => [r.employee_id, shapeRow(r)]));
  const ids = [...new Set([...arrears.keys(), ...kept.keys()])];
  const [emps] = ids.length ? await db.query(`SELECT id, employee_code, full_name FROM hrms_employees WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [c.companyId, ...ids]) : [[]];
  const { rules } = await loadRules(db, year);
  let law = null;
  try { law = lawOf(rules, year); } catch { /* said on screen */ }
  return {
    year, law,
    people: emps.map((e) => {
      const a = arrears.get(e.id);
      const k = kept.get(e.id);
      return {
        employee: { id: e.id, code: e.employee_code, name: e.full_name },
        arrears: a ? { total: a.total, years: Object.entries(a.byYear).map(([y, v]) => ({ year: y, amount: v.amount })) } : null,
        worksheet: k ? { status: k.status, relief: k.relief, generatedAt: k.generatedAt, missing: k.result?.worksheet?.missing ?? [] } : null,
      };
    }).sort((x, y) => x.employee.name.localeCompare(y.employee.name)),
  };
}

/** One person's worksheet: the kept row and a fresh working (not written). */
export async function readOne(db, c, employeeId, year) {
  const k = shapeRow(await rowOf(db, c.companyId, employeeId, year));
  const fresh = await computeFor(db, c.companyId, employeeId, year, k?.inputs ?? {});
  return { kept: k, fresh };
}

/** Works it out with what is typed (merged into what was typed before) and keeps it. HR or the person. */
export async function generate(db, c, employeeId, year, body = {}, { by = 'HR', requestId = null } = {}) {
  const cur = await rowOf(db, c.companyId, employeeId, year);
  if (by === 'SELF' && !cur) throw new HrmsError(404, 'NOT_FOUND', 'There is no Form 10E worksheet for you this year. HR makes it when arrears for earlier years are paid.');
  const inputs = readInputs(body, json(cur?.inputs_json, {}) ?? {});
  const snap = await computeFor(db, c.companyId, employeeId, year, inputs);
  if (!snap) throw refuse('NO_ARREARS', `No arrears for an earlier year were paid in a locked run of ${year}: there is nothing to relieve.`);
  const status = snap.worksheet.complete ? 'READY' : 'INCOMPLETE';
  if (cur) {
    await db.query('UPDATE hrms_tax_relief_10e SET inputs_json = ?, result_json = ?, relief = ?, status = ?, generated_at = NOW(), generated_by = ? WHERE id = ?',
      [JSON.stringify(inputs), JSON.stringify(snap), snap.worksheet.relief, status, c.userId, cur.id]);
  } else {
    await db.query('INSERT INTO hrms_tax_relief_10e (company_id, employee_id, tax_year, inputs_json, result_json, relief, status, generated_at, generated_by, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)',
      [c.companyId, employeeId, year, JSON.stringify(inputs), JSON.stringify(snap), snap.worksheet.relief, status, c.userId, c.userId]);
  }
  const row = await rowOf(db, c.companyId, employeeId, year);
  // The audit row says what was typed and the outcome, not the worksheet.
  await audit(db, c, 'hrms_tax_relief_10e', row.id, cur ? 'UPDATE' : 'CREATE', cur ? { relief: Number(cur.relief), status: cur.status } : null, { by, year, relief: snap.worksheet.relief, status, typedYears: Object.keys(inputs.earlier) }, requestId);
  return { worksheet: shapeRow(row) };
}

export async function removeOne(db, c, employeeId, year, requestId = null) {
  const cur = await rowOf(db, c.companyId, employeeId, year);
  if (!cur) throw new HrmsError(404, 'NOT_FOUND', 'No worksheet to remove.');
  await db.query('UPDATE hrms_tax_relief_10e SET deleted_at = NOW() WHERE id = ?', [cur.id]);
  await audit(db, c, 'hrms_tax_relief_10e', cur.id, 'DELETE', { relief: Number(cur.relief), status: cur.status }, null, requestId);
  return { ok: true };
}

/** The person's own worksheets (My tax › Forms). */
export async function myWorksheets(db, c, employeeId) {
  const [rows] = await db.query('SELECT * FROM hrms_tax_relief_10e WHERE company_id = ? AND employee_id = ? AND deleted_at IS NULL ORDER BY tax_year DESC', [c.companyId, employeeId]);
  return {
    worksheets: rows.map((r) => {
      const k = shapeRow(r);
      return { year: k.year, status: k.status, relief: k.relief, form: k.result?.law?.formLabel ?? 'Form 10E', generatedAt: k.generatedAt, sentence: k.result?.worksheet?.sentence ?? null,
        earlier: (k.result?.earlier ?? []).map((e) => ({ year: e.year, arrears: e.arrears, how: e.how, rules: e.rules, regime: e.regime, totalIncome: e.totalIncome ?? null, taxWithout: e.taxWithout ?? null, taxWith: e.taxWith ?? null })) };
    }),
  };
}

/** The PDF of a kept worksheet: { fileName, mimeType, contentBase64 }. */
export async function fileOf(db, c, employeeId, year) {
  const k = shapeRow(await rowOf(db, c.companyId, employeeId, year));
  if (!k?.result) throw new HrmsError(404, 'NOT_FOUND', 'No Form 10E worksheet for that year.');
  const deductor = await deductorOf(db, c.companyId);
  const buf = await worksheetPdf(k.result, deductor);
  const form = (k.result.law?.formNumber ?? '10E').replace(/[^A-Za-z0-9]/g, '');
  return { fileName: `Form${form}_${year}_${k.result.employee.code}.pdf`.replace(/[^A-Za-z0-9_.-]/g, ''), mimeType: 'application/pdf', contentBase64: buf.toString('base64') };
}

/** The worksheet PDF, in the layout of the year's form (Form 10E Annexure I + Table A, or Form 39 Part B item 3). */
export async function worksheetPdf(s, deductor = null) {
  const is39 = s.law?.formNumber === '39';
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 }, info: { Title: `${s.law?.formLabel ?? 'Form 10E'} ${s.year} — ${s.employee.name}` } });
  const L = 40;
  const W = doc.page.width - 80;
  const w = s.worksheet;
  doc.font('Helvetica-Bold').fontSize(13).text(safe(is39 ? 'FORM NO. 39' : 'FORM NO. 10E'), { align: 'center' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#555').text(safe(is39
    ? `[See rule 73] Form for claiming relief under section 157(1) — additional salary (arrears) — tax year ${s.year}`
    : `[See rule 21AA] Form for furnishing particulars of income under section 192(2A) for claiming relief under section 89(1) — financial year ${s.year}`), { align: 'center' });
  doc.moveDown(0.3).fillColor('#b00020').fontSize(8.5).text(safe('A WORKSHEET to help you fill the form on the e-filing portal (incometax.gov.in › e-File › Income Tax Forms). It is not the filed form. File it online before your return.'), { align: 'center' });
  if (!w.complete) doc.moveDown(0.3).font('Helvetica-Bold').text(safe(`NOT FINISHED — figures missing for ${w.missing.join(', ')}.`), { align: 'center' });
  doc.fillColor('#111').moveDown(0.6).fontSize(8.5);
  const facts = [['Name', s.employee.name], ['PAN', s.employee.pan ?? 'not on file'], ['Employer', deductor?.name ?? ''], ['TAN of the employer', deductor?.tan ?? '—'],
    [is39 ? 'Tax year of receipt' : 'Financial year of receipt', s.year], ['Regime in that year', s.regime === 'OLD' ? 'Old regime' : 'New regime'], ['Law', `${s.law?.section ?? ''}; ${s.law?.rule ?? ''}`]];
  for (const [k, v] of facts) {
    const y = doc.y;
    doc.font('Helvetica').fillColor('#555').text(safe(k), L, y, { width: 150 });
    doc.font('Helvetica-Bold').fillColor('#111').text(safe(v), L + 155, y, { width: W - 155 });
  }
  doc.moveDown(0.8);

  // The table of earlier years (Table "A" / item 3(i)).
  const cols = is39
    ? [['A', 'Tax year to which it relates', 70], ['B', 'Additional salary of that year', 66], ['C', 'Total income of that year', 66], ['D', 'Tax payable on C', 62], ['E', 'Enhanced total income (B+C)', 70], ['F', 'Tax payable on E', 62], ['G', 'Tax on the additional salary (F-D)', 0]]
    : [['1', 'Previous year', 70], ['2', 'Total income of that year', 66], ['3', 'Arrears relating to that year', 66], ['4', 'Total income as increased (2+3)', 70], ['5', 'Tax on column 2', 62], ['6', 'Tax on column 4', 62], ['7', 'Difference (6-5)', 0]];
  const used = cols.slice(0, -1).reduce((a, c) => a + c[2], 0);
  cols[cols.length - 1][2] = W - used;
  doc.font('Helvetica-Bold').fontSize(9.5).text(safe(is39 ? 'Part B, item 3(i): the additional salary by the tax year it relates to' : 'Table "A" (see item 7 of Annexure I)'), L, doc.y);
  doc.moveDown(0.3);
  const head = doc.y;
  let x = L;
  doc.rect(L, head, W, 30).fill('#eeeeee').fillColor('#111').font('Helvetica-Bold').fontSize(7);
  for (const [k, label, wd] of cols) { doc.text(safe(`${k}. ${label}`), x + 2, head + 3, { width: wd - 4 }); x += wd; }
  doc.y = head + 32;
  const cell = (v) => (v == null ? '—' : rs(v));
  for (const e of w.table) {
    const y = doc.y;
    const vals = is39
      ? [`${e.year}${e.how === 'TYPED' ? ' (typed)' : ''}`, cell(e.arrears), cell(e.totalIncome), cell(e.taxWithout), cell(e.increasedIncome), cell(e.taxWith), cell(e.difference)]
      : [`${e.year}${e.how === 'TYPED' ? ' (typed)' : ''}`, cell(e.totalIncome), cell(e.arrears), cell(e.increasedIncome), cell(e.taxWithout), cell(e.taxWith), cell(e.difference)];
    x = L;
    doc.font('Helvetica').fontSize(8);
    vals.forEach((v, i) => { doc.text(safe(v), x + 2, y + 2, { width: cols[i][2] - 6, align: i === 0 ? 'left' : 'right' }); x += cols[i][2]; });
    doc.moveTo(L, y + 14).lineTo(L + W, y + 14).strokeColor('#dddddd').lineWidth(0.5).stroke();
    doc.y = y + 16;
  }
  {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).text('TOTAL', L + 2, y + 2, { width: cols[0][2] });
    const totalCol = cols.length - 1;
    const arrearsCol = is39 ? 1 : 2;
    let xx = L;
    cols.forEach((c, i) => {
      if (i === arrearsCol) doc.text(rs(w.totals.arrears), xx + 2, y + 2, { width: c[2] - 6, align: 'right' });
      if (i === totalCol) doc.text(w.complete ? rs(w.totals.difference) : '—', xx + 2, y + 2, { width: c[2] - 6, align: 'right' });
      xx += c[2];
    });
    doc.y = y + 18;
  }
  doc.moveDown(0.8);

  // The year of receipt (Annexure I items 1–8 / item 3(ii)–(viii)).
  const r = w.rows;
  const lines = is39 ? [
    ['3(ii)', 'Total income of the relevant tax year', r.totalIncomeIncluding],
    ['3(iii)', 'Tax payable on total income', r.taxOnIncluding],
    ['3(iv)', 'Reduced total income of the relevant tax year [3(ii) - total of column B]', r.totalIncomeExcluding],
    ['3(v)', 'Tax payable on reduced total income', r.taxOnExcluding],
    ['3(vi)', 'Tax on the additional salary in the year of receipt [3(iii) - 3(v)]', r.taxOnArrears],
    ['3(vii)', 'Is 3(vi) greater than the total of column G?', null, w.complete ? (w.a > w.b ? 'Yes' : 'No') : '—'],
    ['3(viii)', 'Relief admissible [3(vi) - total of column G], only when 3(vii) is Yes', w.complete ? r.relief : null],
  ] : [
    ['1', 'Total income (excluding salary received in arrears)', r.totalIncomeExcluding],
    ['2', 'Salary received in arrears', r.arrears],
    ['3', 'Total income (as increased by salary received in arrears) [1 + 2]', r.totalIncomeIncluding],
    ['4', 'Tax on total income (as per item 3)', r.taxOnIncluding],
    ['5', 'Tax on total income (as per item 1)', r.taxOnExcluding],
    ['6', 'Tax on salary received in arrears [4 - 5]', r.taxOnArrears],
    ['7', 'Tax computed in accordance with Table "A" [column 7 of Table "A"]', w.complete ? r.taxPerTable : null],
    ['8', 'Relief under section 89(1) [6 - 7, when 6 is more]', w.complete ? r.relief : null],
  ];
  doc.font('Helvetica-Bold').fontSize(9.5).text(safe(is39 ? 'Part B, item 3: the year of receipt' : 'Annexure I — arrears or advance salary'), L, doc.y);
  doc.moveDown(0.3);
  for (const [no, label, amount, textValue] of lines) {
    const y = doc.y;
    doc.font(no === '8' || no === '3(viii)' ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    doc.text(safe(no), L + 2, y + 2, { width: 40 });
    doc.text(safe(label), L + 44, y + 2, { width: W - 150 });
    doc.text(safe(textValue ?? (amount == null ? '—' : rs(amount))), L + W - 100, y + 2, { width: 98, align: 'right' });
    const h = Math.max(doc.heightOfString(safe(label), { width: W - 150 }), 10) + 5;
    doc.moveTo(L, y + h).lineTo(L + W, y + h).strokeColor('#dddddd').lineWidth(0.5).stroke();
    doc.y = y + h + 1;
  }
  doc.moveDown(0.6).font('Helvetica').fontSize(8).fillColor('#333').text(safe(w.sentence), { width: W });
  doc.moveDown(0.4).text(safe(`Arrears in this worksheet are the arrears of earlier years paid by this employer in ${s.year} (the payroll's arrears lines): ${s.earlier.map((e) => `${e.year} Rs. ${rs(e.arrears)}`).join('; ')}. Taxes are the total tax of each year (after rebate, with surcharge and cess), worked with that year's rates${s.earlier.some((e) => e.how === 'TYPED') ? '; a year marked "typed" uses the figures you or HR entered' : ''}.`), { width: W });
  for (const note of s.notes ?? []) doc.moveDown(0.2).text(safe(note), { width: W });
  doc.moveDown(0.2).text(safe(`${s.law?.employerNote ?? ''}`), { width: W });
  doc.moveDown(0.8).fontSize(7).fillColor('#777').text(safe(`Worked out by CF HRMS on ${String(s.generatedAt).slice(0, 10)} — ${s.law?.source ?? ''}`), { width: W });
  return pdfBuffer(doc);
}

export default { earlierArrears, computeFor, listYear, readOne, generate, removeOne, myWorksheets, fileOf, worksheetPdf, lawOf };
