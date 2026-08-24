/**
 * make-plate-import.mjs — the plate sizes the KEPL job needs but the catalogue
 * does not carry, as the app's own Item Catalog import sheet.
 *
 * Usage: node scripts/kepl/make-plate-import.mjs <out.xlsx>
 *
 * WHY THIS EXISTS. The customer's raw-material document names nine plate sizes
 * for this bridge. Six of them are not in the item catalogue, and one of those —
 * 28 x 3100 x 12050 — is a hard blocker: a girder web is 2,995 wide and the
 * widest 28 mm E350 BO plate on file is 2,050, so forty webs cannot be nested
 * onto anything. The suggestor is right to refuse rather than invent a size.
 *
 * The sheet's first ten columns are POSITIONAL and the `CF: <key>` columns are
 * matched by header text anywhere after them — see itemsImportService.
 *
 * Written from the model's RAW_MATERIAL table, which is the customer's list, so
 * nothing here is a size somebody made up.
 */

import ExcelJS from 'exceljs';
import { RAW_MATERIAL } from './model.mjs';

const out = process.argv[2];
if (!out) {
  console.error('Usage: node scripts/kepl/make-plate-import.mjs <out.xlsx>');
  process.exit(1);
}

/** Already in the catalogue at exactly this size — nothing to add. */
const ALREADY = new Set(['25x2050x12050', '32x2000x11000', '40x2500x10500']);

const HEADERS = [
  'Item Name *', 'Item Code', 'Unit', 'Category', 'Group', 'Sub-group',
  'Procurement Type', 'Description', 'HSN Code', 'Lead Time (Days)',
  'CF: thickness_mm', 'CF: length_mm', 'CF: width_mm',
  'CF: grade', 'CF: material', 'CF: density_kg_m3', 'CF: material_form',
];

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Items');
ws.addRow(HEADERS);
ws.getRow(1).font = { bold: true };

let n = 0;
for (const p of RAW_MATERIAL) {
  const key = `${p.t}x${p.w}x${p.l}`;
  if (ALREADY.has(key)) continue;
  const name = `MS Plate ${p.t} x ${p.w} x ${p.l} E350 BO`;
  ws.addRow([
    name,
    '',            // code — left blank so the app assigns one
    'nos',
    'Raw Materials',
    'Plates',
    'MS E350 BO',
    'buy',
    `MS PLATE X ${p.t} X ${p.w} X ${p.l} X E350 BO`,
    '',
    '',
    p.t, p.l, p.w,
    'E350 BO', 'MS', 7850, 'plate',
  ]);
  n += 1;
}

[28, 14, 8, 16, 12, 14, 14, 34, 10, 12, 14, 12, 12, 12, 10, 14, 12]
  .forEach((w, i) => { ws.getColumn(i + 1).width = w; });

await wb.xlsx.writeFile(out);
console.log(`${out}: ${n} plate size(s) to add`);
