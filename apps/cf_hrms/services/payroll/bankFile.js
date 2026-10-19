/**
 * bankFile.js — the salary payment file for the bank. (TM/CF_HRMS_HIRING_SPEC.md §25.2.)
 *
 * GENERIC NEFT CSV first: one row per person paid, in the column order most Indian banks'
 * bulk-upload templates accept (or map from):
 *
 *   Sl No, Payment mode, Beneficiary name, Beneficiary account no, IFSC, Amount, Narration,
 *   Employee code, Debit account no
 *
 * Only people with an amount above zero and both an account and an IFSC are in it; the others
 * are listed in `skipped`, with why. Amounts are rupees with two decimals, no thousands
 * separators. A bank's own format is another function next to this one.
 *
 * `net` is what this file pays: the person's net pay — or, after a re-open, the DIFFERENCE from
 * what was paid before (runService.bankFile works it out; `difference: true` says so in the
 * narration and the file name).
 *
 * A text cell is never read as a formula when the file is opened in Excel: a value starting
 * with = + - @ (or a tab / carriage return) gets a leading apostrophe.
 */
import { monthBounds } from './proration.js';

/** A text cell Excel will not run: a leading ' before = + - @ \t \r. */
export const notFormula = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};
const cell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const clean = (s, max) => String(s ?? '').replace(/[^A-Za-z0-9 .,&()/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * @param run      { month }
 * @param people   [{ employee: { code, name }, net, bank: { account, ifsc } }]
 * @param settings { debitAccountNo, narration }
 * @param options  { difference: true } — the file pays the differences after a re-open
 * @returns {{ fileName, csv, rows, total, skipped: [{ code, name, why }] }}
 */
export function neftCsv(run, people, settings = {}, { difference = false } = {}) {
  const label = monthBounds(run.month).label;
  const narration = clean(`${settings.narration || 'Salary'} ${difference ? 'diff ' : ''}${label}`, 30);
  const header = ['Sl No', 'Payment mode', 'Beneficiary name', 'Beneficiary account no', 'IFSC', 'Amount', 'Narration', 'Employee code', 'Debit account no'];
  const lines = [header.join(',')];
  const skipped = [];
  let n = 0;
  let total = 0;
  for (const p of people) {
    const account = String(p.bank?.account ?? '').replace(/\s+/g, '');
    const ifsc = String(p.bank?.ifsc ?? '').replace(/\s+/g, '').toUpperCase();
    if (!(Number(p.net) > 0)) { skipped.push({ code: p.employee.code, name: p.employee.name, why: p.why ?? 'no net pay' }); continue; }
    if (!account || !ifsc) { skipped.push({ code: p.employee.code, name: p.employee.name, why: 'no bank account or IFSC' }); continue; }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) { skipped.push({ code: p.employee.code, name: p.employee.name, why: `IFSC ${ifsc} is not 11 characters of the right shape` }); continue; }
    n += 1;
    total += Number(p.net);
    lines.push([n, 'NEFT', notFormula(clean(p.employee.name, 35)), notFormula(account), ifsc, Number(p.net).toFixed(2), notFormula(narration), notFormula(p.employee.code ?? ''), notFormula(settings.debitAccountNo ?? '')].map(cell).join(','));
  }
  return { fileName: `Salary NEFT ${run.month}${difference ? ' difference' : ''}.csv`, csv: `${lines.join('\r\n')}\r\n`, rows: n, total: Math.round(total * 100) / 100, skipped };
}

export default { neftCsv, notFormula };
