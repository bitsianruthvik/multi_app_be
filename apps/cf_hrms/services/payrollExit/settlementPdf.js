/**
 * settlementPdf.js — the full and final statement as a PDF (TM/CF_HRMS_HIRING_SPEC.md §25.5). Drawn from the
 * statement (settlement.js workOut; the frozen result_json once approved) and the letterhead the payslip uses.
 * pdfkit's Helvetica has no rupee sign: amounts print as "Rs. 12,345".
 */
import PDFDocument from 'pdfkit';
import { pdfBuffer } from '../render/roleJd.js';
import { indianNumber } from '../letterRenderer.js';
import { rupeesInWords } from '../payroll/payslip.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : (iso ?? ''); };
const rs = (v) => `Rs. ${Number(v ?? 0) < 0 ? '-' : ''}${indianNumber(Math.abs(Math.round(Number(v ?? 0)))) || '0'}`;
const safe = (s) => String(s ?? '').replace(/₹/g, 'Rs. ').replace(/[→⇒]/g, '-').replace(/[×]/g, 'x').replace(/[÷]/g, '/').replace(/[−]/g, '-')
  .replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, '');

export async function settlementPdf(data, letterhead = null) {
  const s = data.statement ?? {};
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 46, right: 46 }, info: { Title: safe(`Full and final settlement — ${s.employee?.name ?? ''}`) } });
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const T = (str, o = {}) => doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size ?? 9).fillColor(o.color ?? '#111').text(safe(str), o.x ?? L, o.y, { width: o.width ?? W, align: o.align ?? 'left' });
  const logo = (letterhead?.images ?? []).slice().sort((a, b) => b.cx * b.cy - a.cx * a.cy)[0] ?? null;
  let y = doc.page.margins.top;
  if (logo) { try { doc.image(logo.buffer, L, y, { fit: [Math.min(160, (logo.cx / logo.cy) * 50), 50] }); } catch { /* no logo */ } }
  T(data.company?.legalName ?? '', { bold: true, size: 13, y: y + (logo ? 8 : 0), align: logo ? 'right' : 'left' });
  if (data.company?.place) T(data.company.place, { size: 8.5, color: '#666', align: logo ? 'right' : 'left' });
  y = Math.max(y + (logo ? 54 : 0), doc.y) + 8;
  doc.moveTo(L, y).lineTo(L + W, y).strokeColor('#ccc').stroke();
  T('Full and final settlement', { bold: true, size: 14, y: y + 8 });
  T(data.status === 'DRAFT' ? 'DRAFT — not approved' : data.status === 'PAID' ? 'Paid' : `Approved — paid with the ${s.payMonthLabel ?? ''} payroll`, { size: 9, color: '#666', y: y + 10, align: 'right' });
  doc.moveDown(0.8);
  const e = s.employee ?? {};
  const x = s.exit ?? {};
  for (const [k, v] of [
    ['Name', e.name], ['Employee code', e.code], ['Joined', day(e.joiningDate)], ['Notice given', day(x.noticeDate)], ['Last working day', day(x.lastWorkingDay)],
    ['Leaving', x.type === 'REMOVED' ? 'The company ended the employment' : 'Resigned'], ['Service', s.service?.text], ['PAN', data.pan ?? '—'], ['Bank account', data.bankAccount ?? '—'],
  ]) {
    const yy = doc.y;
    T(k, { size: 8.5, color: '#666', width: 130, y: yy });
    T(v ?? '—', { size: 9, x: L + 135, width: W - 135, y: yy });
  }
  const table = (title, rows, total) => {
    doc.moveDown(0.6);
    T(title, { bold: true, size: 10.5 });
    doc.moveDown(0.2);
    for (const r of rows) {
      const yy = doc.y;
      T(r[0], { size: 9, width: W - 110, y: yy });
      const h = doc.y - yy;
      T(r[1], { size: 9, x: L + W - 100, width: 100, y: yy, align: 'right' });
      if (r[2]) T(r[2], { size: 7.5, color: '#777', width: W - 110 }); else doc.y = yy + Math.max(h, 12);
    }
    if (total) { const yy = doc.y + 2; doc.moveTo(L, yy).lineTo(L + W, yy).strokeColor('#ddd').stroke(); T(total[0], { bold: true, size: 9.5, y: yy + 4, width: W - 110 }); T(total[1], { bold: true, size: 9.5, x: L + W - 100, width: 100, y: yy + 4, align: 'right' }); }
  };
  const lm = s.lastMonth;
  if (lm) {
    table(`Last month's salary — ${lm.label} (${lm.payableDays} of ${lm.daysInMonth} days paid${lm.how === 'ESTIMATE' ? ', an estimate' : ''})`,
      lm.lines.filter((l) => l.kind !== 'EMPLOYER_CONTRIBUTION').map((l) => [l.name, `${l.kind === 'DEDUCTION' ? '- ' : ''}${rs(l.amount)}`]), ['Net of the month (before TDS)', rs(lm.net)]);
    if (lm.note) T(lm.note, { size: 7.5, color: '#777' });
  }
  table('Settlement', (s.items ?? []).map((i) => [i.label, `${i.kind === 'DEDUCTION' ? '- ' : ''}${rs(i.amount)}`, i.basis]), ['Settlement total', rs(s.totals?.settlement)]);
  if (s.claims?.approved?.length) table('Approved claims paid with it', s.claims.approved.map((cl) => [cl.name, rs(cl.amount)]), null);
  if (s.tds) {
    table('Income tax (TDS)', [
      ...(s.tds.exemptions ?? []).map((ex) => [`${ex.label} exempt (${ex.section})`, rs(ex.exempt), `received ${rs(ex.received)}`]),
      ['TDS of the month', `- ${rs(s.tds.amount)}`, s.tds.note],
    ], null);
  }
  doc.moveDown(0.6);
  T(`Net payable: ${rs(s.totals?.net)}`, { bold: true, size: 12 });
  T(rupeesInWords(s.totals?.net ?? 0), { size: 9, color: '#444' });
  if (s.notes?.length) { doc.moveDown(0.5); for (const nn of s.notes) T(`• ${nn}`, { size: 8, color: '#555' }); }
  doc.moveDown(0.6);
  T(`Worked out by CF HRMS on ${day(String(s.workedOutAt ?? '').slice(0, 10))} from the rules of ${s.year} (${s.rule?.verified ? 'checked against official texts' : 'not yet confirmed from official texts — check with your CA'}).`, { size: 7.5, color: '#888' });
  doc.moveDown(1.5);
  T('Received the above in full and final settlement of all dues.            Signature of the employee: ____________________', { size: 8.5 });
  doc.moveDown(1);
  T('For the company: ____________________          Date: ____________________', { size: 8.5 });
  return pdfBuffer(doc);
}

export const settlementFileName = (s) => `Full and final ${String(s?.employee?.code ?? s?.employee?.name ?? '').replace(/[\\/:*?"<>|]/g, '-')}.pdf`;

export default { settlementPdf, settlementFileName };
