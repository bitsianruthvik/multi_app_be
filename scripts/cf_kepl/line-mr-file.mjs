/**
 * line-mr-file.mjs — A MATERIAL REQUEST FOR ONE ORDER LINE, AS PDF + EXCEL, before the line is frozen (user,
 * 2026-11-01: "give me the MR for the same … use the software … give a pdf and excel"). The software raises an MR only
 * for a frozen line (requisitionService → materialReadyService.lineNeeds: "the design is not frozen"); this file is
 * the same material read off what the line holds today, so it can be shared before the freeze:
 *
 *   1  PLATES (nested)       the line's saved nesting: every plate lot, by catalog plate — how many, kg
 *   2  PLATES TO SIZE        cut plates laid out by hand (NEST_MANUAL — no catalog plate fits): one plate per piece
 *   3  SECTIONS              parts cut from a section: their total length per size (bars not chosen yet), kg
 *   4  BOUGHT ITEMS          everything under the BOUGHT family in the BOM (bolt sets, studs …), multiplied out
 * plus the tonnage: the structure's own weight (WEIGHT roll-up × the line quantity) against the steel bought.
 * Read-only. Nothing is written to the database.
 *
 *   node scripts/cf_kepl/line-mr-file.mjs --company 30005 --order SO260018 --line 1 --out <folder> [--prod]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

const argv = process.argv;
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const ORDER = arg('order'); const LINE_NO = Number(arg('line') ?? 1); const OUT = arg('out');
if (!COMPANY || !ORDER || !OUT) { console.error('Usage: --company <id> --order <code> [--line <no>] --out <folder> [--prod]'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
if (argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(here, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(here, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { getNesting } = await imp('apps/cf_erp/services/nestingService.js');
const { pdfText } = await imp('apps/cf_erp/services/mrDocumentService.js');

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const kgOf = (t, l, w, rho = 7850) => (Number(t) * Number(l) * Number(w) * rho) / 1e9;
const db = pool;

const [[line]] = await db.query(
  `SELECT l.id, l.line_no, l.quantity, l.item_id, l.description, o.id AS order_id, o.code, o.title, o.customer_reference, p.name AS customer
     FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL LEFT JOIN cf_parties p ON p.id = o.customer_id
    WHERE l.company_id = ? AND o.code = ? AND l.line_no = ? AND l.deleted_at IS NULL`, [COMPANY, ORDER, LINE_NO]);
if (!line) throw new Error(`No line ${LINE_NO} on ${ORDER}.`);
const [[co]] = await db.query('SELECT name FROM companies WHERE id = ?', [COMPANY]);
const lineQty = Number(line.quantity) || 1;

// ---- 1 + 2: the saved nesting and the cut plates laid out by hand ----------------
const nest = await getNesting(db, COMPANY, line.id);
const plates = new Map();
for (const g of nest.groups ?? []) {
  for (const n of g.nests ?? []) {
    const code = n.plateCode ?? n.plate?.code ?? '';
    const L = Number(n.length ?? n.plate?.length); const W = Number(n.width ?? n.plate?.width);
    const key = `${code || n.plateItemId}|${g.thickness}|${L}|${W}`;
    if (!plates.has(key)) plates.set(key, { code, name: n.plateName ?? '', thickness: Number(g.thickness), length: L, width: W, grade: n.grade ?? g.grade ?? '', qty: 0, kg: 0 });
    const e = plates.get(key); e.qty += 1; e.kg += Number(n.weightKg) || kgOf(g.thickness, L, W, n.density ?? g.density ?? 7850);
  }
}
const plateRows = [...plates.values()].sort((a, b) => a.thickness - b.thickness || b.length - a.length || b.width - a.width);
const manualRows = (nest.manual ?? []).map((m) => {
  const t = Number(m.steel?.thickness ?? m.thickness); const L = Number(m.steel?.length ?? m.length); const W = Number(m.steel?.width ?? m.width);
  return { code: m.code ?? '', thickness: t, length: L, width: W, grade: m.steel?.grade ?? m.grade ?? '', qty: Number(m.pieces ?? 0), kg: kgOf(t, L, W) * Number(m.pieces ?? 0) };
}).sort((a, b) => a.thickness - b.thickness || b.length - a.length);

// ---- 3 + 4: the BOM multiplied out ----------------------------------------------
const [tree] = await db.query(
  `WITH RECURSIVE t (id, qty, depth) AS (
     SELECT ?, CAST(? AS DECIMAL(24,6)), 0
     UNION ALL
     SELECT bl.child_id, t.qty * bl.quantity, t.depth + 1
       FROM t JOIN cf_boms b ON b.parent_id = t.id AND b.company_id = ? AND b.deleted_at IS NULL
       JOIN cf_bom_lines bl ON bl.bom_id = b.id AND bl.company_id = b.company_id AND bl.deleted_at IS NULL
      WHERE t.depth < 12)
   SELECT t.id, SUM(t.qty) AS qty FROM t GROUP BY t.id`, [line.item_id, lineQty, COMPANY]);
const ids = tree.map((r) => Number(r.id));
const qtyOf = new Map(tree.map((r) => [Number(r.id), Number(r.qty)]));
const [recs] = await db.query(
  `SELECT m.id, m.code, m.name, n.code AS node, n.name AS node_name, top.code AS family, i.uom, i.source_definition_id, d.code AS def_code, d.name AS def_name
     FROM cf_master_records m JOIN cf_classification_nodes n ON n.id = m.classification_id
     LEFT JOIN cf_classification_nodes p1 ON p1.id = n.parent_id LEFT JOIN cf_classification_nodes p2 ON p2.id = p1.parent_id
     LEFT JOIN cf_classification_nodes top ON top.id = COALESCE(p2.id, p1.id, n.id)
     LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
     LEFT JOIN cf_master_records d ON d.id = i.source_definition_id
    WHERE m.company_id = ? AND m.id IN (?)`, [COMPANY, ids]);
const vals = new Map();
const [vrows] = await db.query(
  `SELECT v.subject_id, s.code, v.value_number, v.value_text FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
    WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?) AND s.code IN ('LENGTH','WIDTH','DEPTH','THICKNESS','SECTION_AREA','WEIGHT','DENSITY')`, [COMPANY, ids]);
for (const v of vrows) { if (!vals.has(Number(v.subject_id))) vals.set(Number(v.subject_id), {}); vals.get(Number(v.subject_id))[v.code] = v.value_number != null ? Number(v.value_number) : v.value_text; }

const sections = new Map();
const bought = new Map();
for (const m of recs) {
  const q = qtyOf.get(Number(m.id)) ?? 0;
  const v = vals.get(Number(m.id)) ?? {};
  if (String(m.node).toUpperCase() === 'PROFILE_PART') {
    const size = `${v.DEPTH ?? '?'} x ${v.WIDTH ?? '?'} x ${v.THICKNESS ?? '?'}`;
    if (!sections.has(size)) sections.set(size, { size, section: m.name, pieces: 0, metres: 0, kg: 0, areaMm2: v.SECTION_AREA ?? null });
    const e = sections.get(size); e.pieces += q; e.metres += (q * Number(v.LENGTH ?? 0)) / 1000;
    e.kg += v.SECTION_AREA ? (q * Number(v.SECTION_AREA) * Number(v.LENGTH ?? 0) * 7850) / 1e9 : 0;
  } else if (String(m.family).toUpperCase() === 'BOUGHT') {
    const key = m.def_code ?? m.code ?? m.name;
    if (!bought.has(key)) bought.set(key, { code: m.def_code ?? m.code ?? '', name: m.def_name ?? m.name, uom: m.uom ?? 'nos', qty: 0, kg: 0 });
    const e = bought.get(key); e.qty += q; e.kg += q * Number(v.WEIGHT ?? 0);
  }
}
const sectionRows = [...sections.values()].sort((a, b) => b.kg - a.kg);
const boughtRows = [...bought.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));

// ---- tonnage ---------------------------------------------------------------------
const unitKg = Number((vals.get(Number(line.item_id)) ?? {}).WEIGHT ?? 0);
const t = {
  structurePerUnit: unitKg / 1000, structure: (unitKg * lineQty) / 1000,
  nestedPlates: plateRows.reduce((a, r) => a + r.kg, 0) / 1000, partsNested: Number(nest.totals?.partsKg ?? nest.totals?.weightKg ?? 0) / 1000,
  toSize: manualRows.reduce((a, r) => a + r.kg, 0) / 1000, sections: sectionRows.reduce((a, r) => a + r.kg, 0) / 1000, bought: boughtRows.reduce((a, r) => a + r.kg, 0) / 1000,
};
t.steelBought = t.nestedPlates + t.toSize + t.sections;
const head = { company: co?.name ?? '', order: line.code, title: line.title ?? '', customer: line.customer ?? '', ref: line.customer_reference ?? '', line: `${line.line_no} — ${line.description ?? ''}`, qty: lineQty, date: new Date().toISOString().slice(0, 10) };

// ---- Excel -------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const base = path.join(OUT, `${line.code}-L${line.line_no}-MR`);
const wb = new ExcelJS.Workbook(); wb.creator = head.company;
const sum = wb.addWorksheet('Summary');
sum.addRows([[`Material request — ${head.order} line ${line.line_no}`], [], ['Company', head.company], ['Customer', head.customer], ['Order', `${head.order} ${head.title}`], ['Customer reference', head.ref], ['Line', head.line], ['Units (spans)', head.qty], ['Date', head.date], [],
  ['TONNAGE', 't'], ['Structure, per span (BOM weight)', r3(t.structurePerUnit)], [`Structure, ${head.qty} span(s)`, r3(t.structure)], ['Plates bought — nested', r3(t.nestedPlates)], ['Plates bought — to size (laid out by hand)', r3(t.toSize)], ['Sections (angles)', r3(t.sections)], ['STEEL TO BUY', r3(t.steelBought)], ['Bought items (bolts etc.)', r3(t.bought)],
  ['Nesting', `${nest.totals?.plates ?? plateRows.reduce((a, r) => a + r.qty, 0)} plates · waste ${nest.totals?.wastePct ?? '?'} %`]]);
sum.getRow(1).font = { bold: true, size: 14 }; sum.getRow(11).font = { bold: true }; sum.getColumn(1).width = 46; sum.getColumn(2).width = 40;
const sheet = (name, cols, rows) => {
  const ws = wb.addWorksheet(name);
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  return ws;
};
sheet('Plates (nested)', [['Plate code', 'code', 22], ['Thickness mm', 'thickness', 13], ['Length mm', 'length', 11], ['Width mm', 'width', 11], ['Grade', 'grade', 10], ['Qty (plates)', 'qty', 12], ['Weight kg', 'kg', 14]], plateRows.map((r) => ({ ...r, kg: r3(r.kg) })));
sheet('Plates to size', [['Cut piece', 'code', 34], ['Thickness mm', 'thickness', 13], ['Length mm', 'length', 11], ['Width mm', 'width', 11], ['Grade', 'grade', 10], ['Qty (pieces)', 'qty', 12], ['Weight kg', 'kg', 14]], manualRows.map((r) => ({ ...r, kg: r3(r.kg) })));
sheet('Sections', [['Size (D x W x t) mm', 'size', 22], ['Part', 'section', 16], ['Pieces', 'pieces', 9], ['Total length m', 'metres', 15], ['Weight kg', 'kg', 13]], sectionRows.map((r) => ({ ...r, metres: r3(r.metres), kg: r3(r.kg) })));
sheet('Bought items', [['Code', 'code', 24], ['Item', 'name', 40], ['Qty', 'qty', 10], ['Unit', 'uom', 8], ['Weight kg', 'kg', 13]], boughtRows.map((r) => ({ ...r, kg: r3(r.kg) })));
await wb.xlsx.writeFile(`${base}.xlsx`);

// ---- PDF ---------------------------------------------------------------------------
await new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const stream = fs.createWriteStream(`${base}.pdf`); doc.pipe(stream); stream.on('finish', resolve); stream.on('error', reject);
  const T = (s) => pdfText(s);
  doc.fontSize(15).font('Helvetica-Bold').text(T(`Material request — ${head.order} line ${line.line_no}`));
  doc.moveDown(0.3).fontSize(9).font('Helvetica');
  for (const [k, v] of [['Company', head.company], ['Customer', head.customer], ['Order', `${head.order} ${head.title}`], ['Customer reference', head.ref], ['Line', head.line], ['Units (spans)', head.qty], ['Date', head.date]]) doc.text(T(`${k}: ${v}`));
  doc.moveDown(0.5).font('Helvetica-Bold').fontSize(11).text('Tonnage');
  doc.font('Helvetica').fontSize(9);
  for (const [k, v] of [['Structure, per span (BOM weight)', t.structurePerUnit], [`Structure, ${head.qty} span(s)`, t.structure], ['Plates bought — nested', t.nestedPlates], ['Plates bought — to size', t.toSize], ['Sections (angles)', t.sections], ['STEEL TO BUY', t.steelBought], ['Bought items (bolts etc.)', t.bought]]) doc.text(T(`${k}: ${r3(v).toLocaleString('en-IN')} t`));
  const table = (title, cols, rows) => {
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11).text(T(title)); doc.fontSize(8);
    const x0 = 36; const widths = cols.map((c) => c[2]);
    const row = (cells, bold = false) => {
      if (doc.y > 780) doc.addPage();
      const y = doc.y; let x = x0;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
      cells.forEach((c, i) => { doc.text(T(c), x, y, { width: widths[i] - 4, lineBreak: false, ellipsis: true }); x += widths[i]; });
      doc.x = x0; doc.y = y + 11;
    };
    row(cols.map((c) => c[0]), true);
    rows.forEach((r) => row(cols.map((c) => (typeof r[c[1]] === 'number' ? (Number.isInteger(r[c[1]]) ? String(r[c[1]]) : r3(r[c[1]]).toLocaleString('en-IN')) : r[c[1]] ?? ''))));
  };
  table('1. Plates — from the nesting', [['Plate', 'code', 120], ['t mm', 'thickness', 40], ['L mm', 'length', 55], ['W mm', 'width', 55], ['Grade', 'grade', 50], ['Plates', 'qty', 50], ['kg', 'kg', 80]], plateRows);
  table('2. Plates to size — no catalog plate fits (laid out by hand)', [['Cut piece', 'code', 170], ['t mm', 'thickness', 40], ['L mm', 'length', 55], ['W mm', 'width', 55], ['Grade', 'grade', 50], ['Pieces', 'qty', 50], ['kg', 'kg', 80]], manualRows);
  table('3. Sections — bar not chosen yet', [['Size D x W x t', 'size', 120], ['Part', 'section', 110], ['Pieces', 'pieces', 50], ['Metres', 'metres', 70], ['kg', 'kg', 80]], sectionRows);
  table('4. Bought items', [['Code', 'code', 120], ['Item', 'name', 210], ['Qty', 'qty', 60], ['Unit', 'uom', 40], ['kg', 'kg', 80]], boughtRows);
  doc.moveDown(0.8).font('Helvetica-Oblique').fontSize(7.5).text(T('Read off the line as it stands (BOM, saved nesting). The line is not frozen yet, so this is not a raised MR in the software: it becomes one when the line is locked (coat counts and the angle bars still to be given). Plates to size: one plate per piece, ordered to the piece size plus the mill\'s ordering margins.'));
  doc.end();
});
console.log(JSON.stringify({ files: [`${base}.xlsx`, `${base}.pdf`], tonnage: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, r3(v)])), rows: { plates: plateRows.length, toSize: manualRows.length, sections: sectionRows.length, bought: boughtRows.length } }, null, 1));
await pool.end();
process.exit(0);
