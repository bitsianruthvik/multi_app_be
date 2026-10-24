/**
 * reviewPack.js — the CA's one-click review pack (spec §36.5): every rule in force for the company,
 * with its value, source, verified flag, version and worked examples where present; the review state
 * of each rule set and its comments; the sign-offs. Excel (ExcelJS, like the statutory returns) or
 * PDF (the letters' PDF kit, services/render/roleJd.js).
 *
 * Read-only. The file says what it is NOT: the law layer's own record is the source of truth.
 */
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { XLSX_MIME } from '../excel/workbook.js';
import { pdfKit, pdfBuffer } from '../render/roleJd.js';
import { ruleSets, ruleSetDetail, signoffs, valueWords } from './review.js';
import { today } from './calendar.js';

/** Everything the pack prints, in one object (also what a test reads). */
export async function packData(db, companyId, { on = today() } = {}) {
  const [[co]] = await db.query('SELECT name, slug FROM companies WHERE id = ?', [companyId]);
  const { sets, lawLayer } = await ruleSets(db, companyId, { on });
  const details = [];
  for (const s of sets) details.push(await ruleSetDetail(db, companyId, s.set, { on }));
  return { company: co?.name ?? '', slug: co?.slug ?? '', on, generatedAt: new Date().toISOString(), lawLayer, sets: details, signoffs: await signoffs(db, companyId) };
}

const examplesOf = (r) => (Array.isArray(r.examples) ? r.examples : r.examples ? [r.examples] : []);
const exampleWords = (x) => (typeof x === 'string' ? x : [x.name ?? x.label, x.input ? `given ${JSON.stringify(x.input)}` : null, x.expect != null || x.expected != null ? `expect ${JSON.stringify(x.expect ?? x.expected)}` : null].filter(Boolean).join(' — ') || JSON.stringify(x));

export async function packXlsx(d) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF HRMS';
  const about = wb.addWorksheet('About');
  about.columns = [{ width: 28 }, { width: 100 }];
  const head = about.addRow([`Review pack — ${d.company}`]); head.font = { bold: true, size: 13 };
  for (const [k, v] of [
    ['Rules in force on', d.on], ['Made', d.generatedAt.slice(0, 16).replace('T', ' ')],
    ['Where the rules come from', d.lawLayer?.connected ? 'The law layer (hrms_law_rules / hrms_tax_rules, published versions).' : 'The tax rules (hrms_tax_rules) and the company’s statutory settings — the law layer is not wired in yet.'],
    ['Rule sets', String(d.sets.length)], ['Not verified', String(d.sets.reduce((n, s) => n + s.unverified, 0))],
    ['Note', 'A copy for review. The rules as published in the app are the record; compliance stays with the employer and its CA.'],
  ]) about.addRow([k, v]);
  about.addRow([]);
  const st = about.addRow(['Rule set', 'State']); st.font = { bold: true };
  for (const s of d.sets) about.addRow([s.label, `${s.status}${s.changedSinceDecision ? ' (changed since the decision)' : ''}${s.decidedBy ? ` — ${s.decidedBy} ${String(s.decidedAt ?? '').slice(0, 10)}` : ''}`]);
  about.addRow([]);
  const so = about.addRow(['Sign-offs', '']); so.font = { bold: true };
  for (const s of d.signoffs) about.addRow([s.year, `${s.by} on ${String(s.at).slice(0, 10)}${s.note ? ` — ${s.note}` : ''}`]);
  if (!d.signoffs.length) about.addRow(['', 'None yet.']);

  const ws = wb.addWorksheet('Rules in force');
  ws.columns = [
    { header: 'Rule set', width: 24 }, { header: 'Rule', width: 30 }, { header: 'Value (in words)', width: 60 }, { header: 'In force from', width: 14 },
    { header: 'Version', width: 9 }, { header: 'Verified', width: 10 }, { header: 'Source', width: 60 }, { header: 'Source link', width: 50 }, { header: 'Worked examples', width: 60 }, { header: 'Value (exact)', width: 80 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const s of d.sets) {
    for (const r of s.ruleList) {
      ws.addRow([s.label, r.ruleKey, r.valueWords || valueWords(r.value), r.effectiveFrom ?? '', r.version ?? '', r.verified ? 'Yes' : 'No', r.sourceNote ?? '', r.sourceUrl ?? '',
        examplesOf(r).map(exampleWords).join('\n'), JSON.stringify(r.value).slice(0, 32000)]);
    }
  }
  const cm = wb.addWorksheet('Comments');
  cm.columns = [{ header: 'Rule set', width: 24 }, { header: 'Rule', width: 24 }, { header: 'What', width: 12 }, { header: 'Words', width: 80 }, { header: 'By', width: 24 }, { header: 'When', width: 18 }];
  cm.getRow(1).font = { bold: true };
  for (const s of d.sets) for (const c of s.commentList) cm.addRow([s.label, c.ruleKey ?? '', c.action, c.body ?? '', c.by, String(c.at).slice(0, 16).replace('T', ' ')]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Helvetica has no ₹ and few symbols: the PDF says them in letters. */
const safe = (s) => String(s ?? '').replace(/₹/g, 'Rs. ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/×/g, 'x').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');

export async function packPdf(d) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 48, left: 48, right: 48 }, info: { Title: `Review pack - ${safe(d.company)}`, Author: safe(d.company), Creator: 'CF HRMS' } });
  const k = pdfKit(doc);
  k.text(safe(`Review pack — ${d.company}`), { size: 16, font: 'Helvetica-Bold', after: 2 });
  k.note(safe(`Rules in force on ${d.on}; made ${d.generatedAt.slice(0, 16).replace('T', ' ')}. ${d.lawLayer?.connected ? 'From the law layer (published versions).' : 'From the tax rules and the company’s statutory settings (the law layer is not wired in yet).'} A copy for review: the rules as published in the app are the record.`));
  k.heading('Rule sets and their review');
  k.facts(d.sets.map((s) => [safe(s.label), safe(`${s.status}${s.changedSinceDecision ? ' (changed since the decision)' : ''} - ${s.rules} rules, ${s.unverified} not verified${s.decidedBy ? `; ${s.decidedBy} ${String(s.decidedAt ?? '').slice(0, 10)}` : ''}`)]));
  k.heading('Sign-offs');
  if (d.signoffs.length) k.facts(d.signoffs.map((s) => [s.year, safe(`${s.by} on ${String(s.at).slice(0, 10)}${s.note ? ` - ${s.note}` : ''}`)]));
  else k.note('None yet.');
  for (const s of d.sets) {
    k.heading(safe(s.label));
    for (const r of s.ruleList) {
      k.heading(safe(`${r.ruleKey}${r.version ? `  (v${r.version})` : ''}${r.verified ? '' : '  - NOT VERIFIED'}`), 3);
      k.facts([
        ['Value', safe(r.valueWords || valueWords(r.value) || '-')], ['In force from', r.effectiveFrom ?? '-'],
        ['Source', safe(r.sourceNote ?? '-').slice(0, 900)], r.sourceUrl ? ['Link', safe(r.sourceUrl)] : null,
        ...examplesOf(r).slice(0, 6).map((x, i) => [`Example ${i + 1}`, safe(exampleWords(x)).slice(0, 600)]),
      ]);
    }
    if (s.commentList.length) {
      k.text('Comments', { size: 10, font: 'Helvetica-Bold', after: 2 });
      for (const c of s.commentList) k.bullet(safe(`${c.action} - ${c.by}, ${String(c.at).slice(0, 10)}${c.ruleKey ? ` (${c.ruleKey})` : ''}: ${c.body ?? ''}`), { size: 9 });
    }
  }
  return pdfBuffer(doc);
}

/** GET /compliance/review/pack?format=xlsx|pdf → { fileName, mimeType, contentBase64 }. */
export async function reviewPack(db, companyId, format = 'xlsx') {
  const d = await packData(db, companyId);
  const name = `Review pack ${d.slug || 'company'} ${d.on}`;
  if (String(format).toLowerCase() === 'pdf') return { fileName: `${name}.pdf`, mimeType: 'application/pdf', contentBase64: (await packPdf(d)).toString('base64'), rules: d.sets.reduce((n, s) => n + s.rules, 0) };
  return { fileName: `${name}.xlsx`, mimeType: XLSX_MIME, contentBase64: (await packXlsx(d)).toString('base64'), rules: d.sets.reduce((n, s) => n + s.rules, 0) };
}

export default { reviewPack, packData, packXlsx, packPdf };
