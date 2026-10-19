/**
 * payslip.js — a released payslip as a PDF. (TM/CF_HRMS_HIRING_SPEC.md §25.2.)
 *
 * DRAWN FROM THE SNAPSHOT ONLY (hrms_pay_payslips.snapshot_json, written on release). Like
 * the JD (render/roleJd.js), the function that draws takes the snapshot and the letterhead
 * and nothing else: a payslip downloaded in a year is the payslip released, not today's pay.
 *
 * THE LETTERHEAD IS THE LETTERS' OWN. The company's letter templates (Setup › Letters —
 * the appointment letter, else the offer letter) carry the letterhead in their page header;
 * `letterheadOf` opens that .docx (services/hiringService.js templateFor's row, unpacked by
 * documentStorage.unpack) and takes the header's images — the logo — and its words. With no
 * template of its own, the payslip prints the company's legal name.
 *
 * pdfkit's Helvetica is WinAnsi: no rupee sign. Amounts print as "Rs. 12,345.00".
 */
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { pdfBuffer } from '../render/roleJd.js';
import { unpack } from '../documentStorage.js';
import { indianNumber } from '../letterRenderer.js';

const INK = '#111111';
const GREY = '#666666';
const RULE = '#cccccc';
const SHADE = '#f2f2f2';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : (iso ?? ''); };

const rs = (v) => `Rs. ${indianNumber(Number(v ?? 0).toFixed(2)) || '0'}${Number.isInteger(Number(v ?? 0)) ? '.00' : ''}`;
// The font has no glyph outside CP1252: an arrow or a rupee sign would print as the wrong letter.
const safe = (s) => String(s ?? '').replace(/₹/g, 'Rs. ').replace(/[→⇒]/g, '-').replace(/[^\x20-\x7E -ÿ–—‘’“”•…]/g, '');

/** "Twelve thousand three hundred and forty-five rupees only". */
export function rupeesInWords(amount) {
  const n = Math.round(Number(amount) || 0);
  if (n === 0) return 'Zero rupees only';
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const two = (x) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? `-${ones[x % 10]}` : ''}`);
  const three = (x) => {
    const h = Math.floor(x / 100);
    const r = x % 100;
    return [h ? `${ones[h]} hundred` : '', r ? `${h ? 'and ' : ''}${two(r)}` : ''].filter(Boolean).join(' ');
  };
  const parts = [];
  let rest = Math.abs(n);
  const crore = Math.floor(rest / 1e7); rest %= 1e7;
  const lakh = Math.floor(rest / 1e5); rest %= 1e5;
  const thousand = Math.floor(rest / 1000); rest %= 1000;
  if (crore) parts.push(`${three(crore)} crore`);
  if (lakh) parts.push(`${two(lakh)} lakh`);
  if (thousand) parts.push(`${two(thousand)} thousand`);
  if (rest) parts.push(three(rest));
  const words = parts.join(' ');
  return `${n < 0 ? 'Minus ' : ''}${words[0].toUpperCase()}${words.slice(1)} rupees only`;
}

/** The letterhead of the company's letters: { images: [Buffer], words: string[] } — or null. */
export async function letterheadOf(db, companyId) {
  const [rows] = await db.query(
    `SELECT kind, storage, compression, content FROM hrms_letter_templates WHERE company_id = ? AND is_current = 1 AND deleted_at IS NULL
      ORDER BY FIELD(kind, 'APPOINTMENT', 'OFFER')`, [companyId]);
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop -- at most two templates, the first that has a header wins
      const zip = await JSZip.loadAsync(await unpack(row, 'letter template'));
      const headers = Object.keys(zip.files).filter((n) => /^word\/header\d*\.xml$/.test(n)).sort();
      for (const h of headers) {
        const xml = await zip.file(h).async('string');
        const relsFile = zip.file(h.replace('word/', 'word/_rels/').replace('.xml', '.xml.rels'));
        const rels = relsFile ? await relsFile.async('string') : '';
        const target = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
        const images = [];
        // The images in the order the header draws them, with the size it draws them at (EMU).
        for (const m of xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>[\s\S]*?r:embed="([^"]+)"/g)) {
          const t = target.get(m[3]);
          if (!t || !/\.(png|jpe?g)$/i.test(t)) continue;
          const file = zip.file(`word/${t.replace(/^\.\.\//, '')}`) ?? zip.file(t.replace(/^\//, ''));
          if (!file) continue;
          images.push({ buffer: await file.async('nodebuffer'), cx: Number(m[1]), cy: Number(m[2]) });
        }
        const words = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
          .map((p) => [...p[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('').trim())
          .filter((w) => w && !/\{[a-z_]+\}/.test(w));
        if (images.length || words.length) return { images, words };
      }
    } catch { /* a template that does not open has no letterhead to give */ }
  }
  return null;
}

/**
 * The PDF of a payslip.
 * @param snapshot  hrms_pay_payslips.snapshot_json
 * @param letterhead letterheadOf(...) or null
 */
export async function payslipPdf(snapshot, letterhead = null) {
  const s = snapshot ?? {};
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 46, right: 46 }, info: { Title: safe(`Payslip ${s.period?.label ?? ''} — ${s.employee?.name ?? ''}`), Author: safe(s.company?.legalName ?? '') } });
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const T = (str, x, y, o = {}) => doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size ?? 9).fillColor(o.color ?? INK).text(safe(str), x, y, { width: o.width, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });

  // ── the letterhead ─────────────────────────────────────────────────────
  let y = doc.page.margins.top;
  const logo = (letterhead?.images ?? []).slice().sort((a, b) => b.cx * b.cy - a.cx * a.cy)[0] ?? null;
  let headH = 0;
  if (logo) {
    try {
      const h = 54;
      const w = Math.min(160, (logo.cx / logo.cy) * h);
      doc.image(logo.buffer, L, y, { fit: [w, h] });
      headH = h;
    } catch { headH = 0; }
  }
  const nameX = logo ? L + 175 : L;
  T(s.company?.legalName ?? s.company?.name ?? '', nameX, y + (logo ? 8 : 0), { bold: true, size: 13, width: W - (nameX - L), align: logo ? 'right' : 'left' });
  const sub = [...(letterhead?.words ?? []).slice(0, 2), s.company?.place].filter(Boolean).join(' · ');
  if (sub) T(sub, nameX, doc.y + 2, { size: 8.5, color: GREY, width: W - (nameX - L), align: logo ? 'right' : 'left' });
  y = Math.max(y + headH, doc.y) + 10;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 10;
  T(`Payslip for ${s.period?.label ?? ''}`, L, y, { bold: true, size: 14 });
  T(`Financial year ${s.period?.financialYear ?? ''}`, L, y + 2, { size: 9, color: GREY, width: W, align: 'right' });
  y = doc.y + 10;

  // ── the person ─────────────────────────────────────────────────────────
  const e = s.employee ?? {};
  const facts = [
    ['Name', e.name], ['Employee code', e.code],
    ['Designation', e.positionTitle], ['Department', e.departmentName],
    ['Date of joining', day(e.joiningDate)], ['PAN', e.pan ?? 'Not on file'],
    ['Bank account', e.bankAccount ? `${e.bankAccount}${e.ifsc ? ` (${e.ifsc})` : ''}` : 'Not on file'], ['UAN', e.uan ?? '—'],
    ['Days in month', s.days?.inMonth], ['Payable days', s.days?.payable],
    ['Leave without pay', s.days?.lop ? `${s.days.lop} day${Number(s.days.lop) === 1 ? '' : 's'}` : 'None'], ['ESI number', e.esiNumber ?? '—'],
  ];
  const colW = W / 2;
  for (let i = 0; i < facts.length; i += 2) {
    const rowY = y;
    for (let j = 0; j < 2; j += 1) {
      const f = facts[i + j];
      if (!f) continue;
      T(f[0], L + j * colW, rowY, { size: 8.5, color: GREY, width: 95 });
      T(f[1] ?? '—', L + j * colW + 98, rowY, { size: 9, width: colW - 104 });
    }
    y = rowY + 14;
  }
  y += 6;

  // ── earnings | deductions ──────────────────────────────────────────────
  const earnings = [...(s.earnings ?? []), ...(s.reimbursements ?? []).map((r) => ({ ...r, name: `${r.name} (reimbursement)` }))];
  const deductions = s.deductions ?? [];
  const half = (W - 12) / 2;
  const table = (x, title, rows, total, totalLabel) => {
    let ty = y;
    doc.rect(x, ty, half, 18).fill(SHADE);
    T(title, x + 6, ty + 5, { bold: true, size: 9.5, width: half - 90 });
    T('Amount', x + half - 96, ty + 5, { bold: true, size: 9.5, width: 90, align: 'right' });
    ty += 22;
    for (const r of rows) {
      T(r.name, x + 6, ty, { size: 9, width: half - 104 });
      T(rs(r.amount), x + half - 96, ty, { size: 9, width: 90, align: 'right' });
      ty = Math.max(doc.y, ty + 12) + 2;
    }
    return { ty, total, totalLabel };
  };
  const a = table(L, 'Earnings', earnings, Number(s.totals?.gross ?? 0) + Number(s.totals?.reimbursements ?? 0), 'Total earnings');
  const b = table(L + half + 12, 'Deductions', deductions, s.totals?.deductions, 'Total deductions');
  y = Math.max(a.ty, b.ty) + 4;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.6).strokeColor(RULE).stroke();
  y += 5;
  for (const [x, t] of [[L, a], [L + half + 12, b]]) {
    T(t.totalLabel, x + 6, y, { bold: true, size: 9.5, width: half - 104 });
    T(rs(t.total), x + half - 96, y, { bold: true, size: 9.5, width: 90, align: 'right' });
  }
  y += 22;

  // ── net pay ────────────────────────────────────────────────────────────
  doc.rect(L, y, W, 34).fill(SHADE);
  T('Net pay', L + 8, y + 6, { bold: true, size: 12 });
  T(rs(s.totals?.net), L + W - 208, y + 6, { bold: true, size: 12, width: 200, align: 'right' });
  T(rupeesInWords(s.totals?.net), L + 8, y + 21, { size: 8.5, color: GREY, width: W - 16 });
  y += 46;

  // ── employer contributions, TDS, year to date ──────────────────────────
  if ((s.employer ?? []).length) {
    T('Paid by the company on top of your pay (part of your CTC)', L, y, { bold: true, size: 9.5 });
    y = doc.y + 4;
    for (const r of s.employer) {
      T(r.name, L + 6, y, { size: 9, width: W - 110 });
      T(rs(r.amount), L + W - 100, y, { size: 9, width: 94, align: 'right' });
      y = doc.y + 3;
    }
    y += 8;
  }
  T(`Income tax deducted (TDS) this month: ${rs(s.tds)}${s.tdsSource === 'MANUAL' && Number(s.tds) > 0 ? ' (entered by HR)' : ''}`, L, y, { size: 9 });
  y = doc.y + 8;
  const ytd = s.ytd ?? {};
  T(`Year to date (${s.period?.financialYear ?? ''}, ${ytd.months ?? 0} month${ytd.months === 1 ? '' : 's'})`, L, y, { bold: true, size: 9.5 });
  y = doc.y + 4;
  const cols = [['Gross earnings', ytd.gross], ['Deductions', ytd.deductions], ['Net pay', ytd.net], ['TDS', ytd.tds]];
  cols.forEach(([k, v], i) => {
    T(k, L + i * (W / 4), y, { size: 8.5, color: GREY, width: W / 4 - 6 });
    T(rs(v), L + i * (W / 4), y + 11, { size: 9.5, width: W / 4 - 6 });
  });
  y += 34;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor(RULE).stroke();
  T('This is a computer-generated payslip and needs no signature.', L, y + 6, { size: 8, color: GREY, width: W });
  T(`Released ${day(String(s.releasedAt ?? '').slice(0, 10))}`, L, y + 6, { size: 8, color: GREY, width: W, align: 'right' });
  return pdfBuffer(doc);
}

export const payslipFileName = (s) => `Payslip ${s.period?.month ?? ''} ${String(s.employee?.code ?? s.employee?.name ?? '').replace(/[\\/:*?"<>|]/g, '-')}.pdf`;

export default { payslipPdf, letterheadOf, rupeesInWords, payslipFileName };
