/**
 * summaryPdf.js — the person's return as a PDF laid out like the ITR's schedules: Part A
 * (about the person), Schedule S, HP, CG, OS, VI-A, Part B-TI, B-TTI, the taxes paid
 * (TDS / TCS / IT), both regimes, the interest estimate and the refund account.
 * The person's own file: PAN and bank account in full (their own data, their own download).
 *
 * pdfkit's Helvetica is WinAnsi: no rupee sign — amounts print as "Rs. 12,345".
 */
import PDFDocument from 'pdfkit';
import { pdfBuffer } from '../render/roleJd.js';

const INK = '#111111';
const GREY = '#666666';
const RULE = '#cccccc';
const SHADE = '#f2f2f2';
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const group = (v) => { const s = String(Math.abs(Math.round(n(v)))); const last3 = s.slice(-3); const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ','); return `${rest ? `${rest},` : ''}${last3}`; };
const rs = (v) => (v == null ? '' : `${n(v) < 0 ? '- ' : ''}Rs. ${group(v)}`);
const safe = (s) => String(s ?? '').replace(/₹/g, 'Rs. ').replace(/[→⇒]/g, '-').replace(/[−]/g, '-').replace(/[^\x20-\x7E -ÿ–—‘’“”•…]/g, '');
const SOURCE = { EMPLOYER: 'from your employer', TYPED: 'typed by you' };

export const summaryFileName = (full) => `Income tax return ${full.year} (AY ${full.result.assessmentYear}) ${String(full.person?.code ?? full.person?.name ?? '').replace(/[\\/:*?"<>|]/g, '-')} - summary.pdf`;

export async function summaryPdf(full) {
  const r = full.result;
  const c = r.computation;
  const sch = r.schedules;
  const parts = full.parts ?? {};
  const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: 40, bottom: 44, left: 46, right: 46 }, info: { Title: safe(`Income tax return ${full.year} — summary`), Author: safe(full.personFull?.name ?? '') } });
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 16;
  const T = (str, x, y, o = {}) => doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size ?? 9).fillColor(o.color ?? INK).text(safe(str), x, y, { width: o.width, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  let y = doc.page.margins.top;
  const room = (h) => { if (y + h > bottom()) { doc.addPage(); y = doc.page.margins.top; } };

  const heading = (title, sub = null) => {
    room(40);
    y += 6;
    doc.rect(L, y, W, 18).fill(SHADE);
    T(title, L + 6, y + 5, { bold: true, size: 10, width: W - 12 });
    y += 22;
    if (sub) { T(sub, L + 6, y, { size: 8, color: GREY, width: W - 12 }); y = doc.y + 4; }
  };
  const rowLine = (label, amount, { bold = false, note = null } = {}) => {
    room(14);
    const startY = y;
    T(label, L + 6, y, { size: 9, bold, width: W - 190 });
    const after = doc.y;
    if (note) T(note, L + W - 182, startY, { size: 7.5, color: GREY, width: 80, align: 'right' });
    if (amount !== undefined) T(rs(amount), L + W - 100, startY, { size: 9, bold, width: 94, align: 'right' });
    y = Math.max(after, startY + 11) + 2;
  };
  const rows = (list) => { for (const x of list) rowLine(x.label, x.amount, { bold: /^(Net salary|Income chargeable|Income from other|Gross total|Total income|Total deductions|Tax on total|Total tax|Tax payable|Refund)/.test(x.label), note: x.source ? SOURCE[x.source] : (x.rate != null ? `at ${x.rate}%` : null) }); };

  // ── title ──────────────────────────────────────────────────────────────
  T(`Income-tax return — summary for ${full.year}`, L, y, { bold: true, size: 15 });
  y = doc.y + 2;
  T(`Assessment year ${r.assessmentYear} · ${r.act} · ${r.form.form === 'ITR1' ? 'ITR-1 (Sahaj)' : 'ITR-2'} · ${r.regime === 'OLD' ? 'Old regime' : 'New regime'}`, L, y, { size: 9.5, color: GREY, width: W });
  y = doc.y + 6;
  doc.rect(L, y, W, 30).lineWidth(0.8).strokeColor('#b45309').stroke();
  T(full.notice, L + 8, y + 5, { bold: true, size: 9, width: W - 16 });
  y += 36;
  if (full.status !== 'FINALISED') { T('Draft — not finalised. Figures from payroll are read today and may still change.', L, y, { size: 8.5, color: '#b45309', width: W }); y = doc.y + 4; }

  // ── Part A ─────────────────────────────────────────────────────────────
  const p = full.personFull ?? {};
  const personal = full.draft?.personal ?? {};
  const bank = parts.bank ?? {};
  heading('Part A — General information');
  const facts = [
    ['Name', p.name], ['PAN', p.pan ?? 'Not on file — add it to your record with HR'],
    ['Date of birth', personal.dateOfBirth ?? '—'], ['Residential status', ({ RESIDENT: 'Resident', RNOR: 'Resident but not ordinarily resident', NON_RESIDENT: 'Non-resident' })[personal.residentialStatus ?? 'RESIDENT']],
    ['Form', `${r.form.form === 'ITR1' ? 'ITR-1' : 'ITR-2'}${r.form.form !== r.form.suggested ? ` (suggested ${r.form.suggested === 'ITR1' ? 'ITR-1' : 'ITR-2'})` : ''}`], ['Regime', r.regime === 'OLD' ? 'Old (opting out of the new regime)' : 'New (the default)'],
    ['Due date', r.interest.dueDate], ['Filing on', r.filingDate],
    ['Refund account', bank.account ? `${bank.account}${bank.ifsc ? ` · IFSC ${bank.ifsc}` : ''}${bank.bankName ? ` · ${bank.bankName}` : ''}` : 'Not given'],
  ];
  for (let i = 0; i < facts.length; i += 2) {
    room(14);
    const rowY = y;
    for (let j = 0; j < 2; j += 1) {
      const f = facts[i + j];
      if (!f) continue;
      T(f[0], L + 6 + j * (W / 2), rowY, { size: 8.5, color: GREY, width: 90 });
      T(f[1] ?? '—', L + 96 + j * (W / 2), rowY, { size: 9, width: W / 2 - 100 });
    }
    y = Math.max(doc.y, rowY + 12) + 2;
  }
  T(r.form.reason, L + 6, y + 2, { size: 8, color: GREY, width: W - 12 });
  y = doc.y + 4;

  heading('Schedule S — Income from salary', `${r.salary.fromPayroll ? 'Gross salary, professional tax and TDS are from your released payslips' : `Typed by you from your ${r.forms.certificate.label}`}.`);
  rows(sch.S);
  if (sch.HP.length) {
    heading('Schedule HP — Income from house property');
    for (const h of sch.HP) { rowLine(h.label, undefined, { bold: true }); rows(h.rows); }
    rowLine('Income under the head "House property" (after set-off)', c.houseProperty, { bold: true });
    if (c.hpLossCarriedForward) rowLine('Loss carried forward to later years', c.hpLossCarriedForward);
  }
  if (sch.CG.length) { heading('Schedule CG — Capital gains (summary)', 'Net gain of each kind as you entered it.'); rows(sch.CG); }
  heading('Schedule OS — Income from other sources');
  rows(sch.OS);
  heading('Schedule VI-A — Deductions', r.regime === 'NEW' ? 'New regime: most deductions are not allowed (only the employer\'s NPS contribution and a few others).' : null);
  rows(sch.VIA);
  heading('Part B-TI — Computation of total income');
  rows(sch.BTI);
  heading('Part B-TTI — Computation of tax');
  rows(sch.BTTI);

  heading('Schedules TDS / TCS / IT — taxes paid');
  for (const t of sch.TDS) rowLine(`TDS — ${t.who}${t.tan ? ` (TAN ${t.tan})` : ''}, ${t.kind}`, t.amount, { note: t.source ? SOURCE[t.source] : null });
  for (const t of sch.TCS) rowLine(`TCS — ${t.who ?? ''}${t.tan ? ` (TAN ${t.tan})` : ''}`, t.amount);
  for (const t of sch.IT) rowLine(`${t.kind} — BSR ${t.bsrCode ?? '…'}, ${t.date ?? '…'}, challan ${t.challanNo ?? '…'}`, t.amount);
  rowLine('Total taxes paid', r.prepaid.total, { bold: true });

  heading('Both regimes on the same figures');
  rowLine('Old regime — tax on total income', r.old.totalTax);
  rowLine('New regime — tax on total income', r.new.totalTax);
  T(r.compare.sentence, L + 6, y, { size: 8.5, color: GREY, width: W - 12 });
  y = doc.y + 4;

  if (r.interest.total || r.interest.fee || r.interest.notes.length) {
    heading('Interest and fee (an estimate — the portal works out the exact figure)');
    for (const d of r.interest.details.c) rowLine(`234C — by ${d.by}: ${d.cumPct}% due ${rs(d.required)}, paid ${rs(d.paid)}, ${d.months} month(s)`, d.interest);
    if (r.interest.b) rowLine(`234B — advance tax below 90% of ${rs(r.interest.assessed)}: ${r.interest.details.b.length} month(s) from 1 April`, r.interest.b);
    if (r.interest.a) rowLine(`234A — filed after ${r.interest.dueDate}: ${r.interest.details.a.length} month(s)`, r.interest.a);
    if (r.interest.fee) rowLine('234F — late fee', r.interest.fee);
    for (const note of r.interest.notes) { room(12); T(note, L + 6, y, { size: 8, color: GREY, width: W - 12 }); y = doc.y + 3; }
  }
  if (r.warnings.length) {
    heading('Please check');
    for (const w of r.warnings) { room(12); T(`• ${w}`, L + 6, y, { size: 8.5, width: W - 12 }); y = doc.y + 3; }
  }
  room(60);
  y += 8;
  doc.rect(L, y, W, 30).fill(SHADE);
  T(r.payable ? `Tax still to pay: ${rs(r.payable)}` : r.refund ? `Refund due: ${rs(r.refund)}` : 'Nothing to pay, no refund', L + 8, y + 9, { bold: true, size: 12, width: W - 16 });
  y += 38;
  T(`${r.sentence} Worked out on ${new Date().toISOString().slice(0, 10)} by the rules of ${full.year} as kept in the app${r.unverifiedRules.length ? `; rules not yet confirmed from an official source: ${r.unverifiedRules.join(', ')}` : ''}. Not reviewed by a chartered accountant.`, L, y, { size: 8, color: GREY, width: W });
  // Page numbers.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing in the margin must not open a new page
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY).text(safe(`${p.name ?? ''} · ${full.year} · page ${i + 1} of ${range.count}`), L, doc.page.height - keep + 8, { width: W, align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.strokeColor(RULE);
  return pdfBuffer(doc);
}
