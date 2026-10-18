/**
 * mrDocumentService.js — the order's material request, as a file to SHARE WITH THE CUSTOMER (init.sql §73).
 *
 * User, 2026-10-18: "MR raised → MR SHARED with the customer (PDF + Excel download of the MR; no customer login)".
 * One file for the whole order: every MR, line by line — the material, the quantity, its unit, and who supplies it.
 *   GET /orders/:id/mr-document?format=pdf | xlsx
 * Built from readRequisitions, the same read the MR screens use, so the file cannot disagree with them.
 *
 * pdfkit's built-in Helvetica draws CP1252 only: every string is passed through pdfText (× → x, ₹ → Rs, anything else
 * outside CP1252 → ?), or the PDF prints boxes.
 */
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { invalid, notFound } from '../lib/errors.js';
import { readRequisitions } from './requisitionService.js';

const SUPPLY = { we_buy: 'We buy', customer: 'Customer supplies' };
const qty = (n) => Number(Number(n ?? 0).toFixed(3));
const dateText = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));

/** A string pdfkit's standard fonts can draw (CP1252). */
export function pdfText(v) {
  return String(v ?? '')
    .replace(/×/g, 'x').replace(/₹/g, 'Rs ').replace(/[≤]/g, '<=').replace(/[≥]/g, '>=').replace(/[‐‑‒–—]/g, '-')
    .replace(/[^\x20-\x7E -ÿ‘’“”•…€]/g, '?');
}

/** What goes in the file. 2 reads + the MR read. */
async function documentData(db, companyId, orderId) {
  const [[o]] = await db.query(
    `SELECT o.id, o.code, o.title, o.customer_reference, o.committed_date, p.name AS customer_name
       FROM cf_sales_orders o LEFT JOIN cf_parties p ON p.id = o.customer_id WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL`,
    [companyId, Number(orderId)],
  );
  if (!o) throw notFound('Sales order');
  const [[co]] = await db.query('SELECT name FROM companies WHERE id = ?', [companyId]);
  const views = await readRequisitions(db, companyId, { orderId: o.id });
  if (!views.length) throw invalid('NO_MR', `${o.code} has no material request yet — raise it first.`);
  const rows = [];
  for (const v of views) {
    for (const l of v.lines.filter((x) => x.status !== 'not_needed' && x.need > 0)) {
      rows.push({ mr: v.code, line: v.line.lineNo, lineName: v.line.name, code: l.item.code ?? '', name: l.item.name ?? '', quantity: qty(l.need), uom: l.item.uom ?? '', supply: SUPPLY[v.supply] ?? v.supply });
    }
  }
  return { o, company: co?.name ?? '', views, rows, date: dateText(new Date()) };
}

async function xlsx(d) {
  const wb = new ExcelJS.Workbook();
  wb.creator = d.company;
  const ws = wb.addWorksheet('Material request');
  ws.addRow([`Material request — ${d.o.code}`]).font = { bold: true, size: 14 };
  ws.addRow([`Customer: ${d.o.customer_name ?? '—'}`]);
  if (d.o.customer_reference) ws.addRow([`Your reference: ${d.o.customer_reference}`]);
  if (d.o.title) ws.addRow([`Project: ${d.o.title}`]);
  ws.addRow([`Date: ${d.date}`]);
  ws.addRow([]);
  const head = ws.addRow(['MR', 'Line', 'What the line is', 'Material code', 'Material', 'Quantity', 'Unit', 'Supplied by']);
  head.font = { bold: true };
  head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } }; });
  for (const r of d.rows) ws.addRow([r.mr, r.line, r.lineName, r.code, r.name, r.quantity, r.uom, r.supply]);
  [16, 6, 34, 18, 40, 12, 8, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getColumn(6).numFmt = '#,##0.###';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function pdf(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(15).text(pdfText(`Material request - ${d.o.code}`));
    doc.moveDown(0.3).font('Helvetica').fontSize(10);
    if (d.company) doc.text(pdfText(`From: ${d.company}`));
    doc.text(pdfText(`Customer: ${d.o.customer_name ?? '-'}`));
    if (d.o.customer_reference) doc.text(pdfText(`Your reference: ${d.o.customer_reference}`));
    if (d.o.title) doc.text(pdfText(`Project: ${d.o.title}`));
    doc.text(pdfText(`Date: ${d.date}`));
    doc.moveDown(0.8);
    const cols = [{ w: 78, k: 'mr', t: 'MR' }, { w: 30, k: 'line', t: 'Line' }, { w: 210, k: 'material', t: 'Material' }, { w: 62, k: 'quantity', t: 'Quantity', right: true }, { w: 40, k: 'uom', t: 'Unit' }, { w: 95, k: 'supply', t: 'Supplied by' }];
    const left = doc.page.margins.left;
    const row = (vals, { bold = false } = {}) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      let x = left;
      let h = 0;
      for (const c of cols) {
        const s = pdfText(vals[c.k]);
        doc.text(s, x, y, { width: c.w - 4, align: c.right ? 'right' : 'left' });
        h = Math.max(h, doc.heightOfString(s, { width: c.w - 4 }));
        x += c.w;
      }
      doc.y = y + h + 4;
      doc.x = left;
      if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
    };
    row(Object.fromEntries(cols.map((c) => [c.k, c.t])), { bold: true });
    doc.moveTo(left, doc.y - 2).lineTo(left + cols.reduce((t, c) => t + c.w, 0), doc.y - 2).strokeColor('#999999').stroke();
    for (const r of d.rows) row({ mr: r.mr, line: String(r.line), material: `${r.code ? `${r.code} ` : ''}${r.name}`, quantity: String(r.quantity), uom: r.uom, supply: r.supply });
    doc.moveDown(1).font('Helvetica').fontSize(8.5).fillColor('#555555')
      .text(pdfText('Quantities are what the frozen design and its nesting need. Material marked "Customer supplies" is to be sent by you.'), left);
    doc.end();
  });
}

/** → { buffer, contentType, filename } */
export async function mrDocument(db, companyId, orderId, format = 'pdf') {
  const fmt = String(format ?? 'pdf').toLowerCase();
  if (!['pdf', 'xlsx'].includes(fmt)) throw invalid('INVALID', 'The file is pdf or xlsx.');
  const d = await documentData(db, companyId, orderId);
  const stem = `MR-${String(d.o.code).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
  return fmt === 'xlsx'
    ? { buffer: await xlsx(d), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${stem}.xlsx`, rows: d.rows.length }
    : { buffer: await pdf(d), contentType: 'application/pdf', filename: `${stem}.pdf`, rows: d.rows.length };
}
