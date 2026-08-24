/**
 * make-boq-sheet.mjs — write the KEPL BOQ as the sheet the app expects.
 *
 * Usage: node scripts/kepl/make-boq-sheet.mjs <spanCode[,spanCode…]> <out.xlsx>
 *
 * This AUTHORS AN UPLOAD; it does not touch the database. The output is the
 * ordinary BOQ workbook a person would fill in by hand — the same columns the
 * app's own export produces — and it goes in through the app's upload screen.
 * Doing it by hand would be a thousand rows of typing off a PDF, and the
 * structure is completely regular, so it is generated from the model instead.
 *
 * ONE SHEET CAN CARRY BOTH SPANS. The Span column holds the ORDER LINE's code,
 * and a level is created the first time its code appears — so rows for SPAN1 and
 * SPAN2 in the same file simply land under their own lines. One upload, not two.
 *
 * MATERIAL AND GRADE ARE LEFT BLANK on every row, deliberately. They are stated
 * once on the order line and inherited; filling them in per row would make the
 * line meaningless the moment anybody changed it, since every row would then be
 * overriding it. Thickness stays per row — it genuinely varies by part.
 */

import ExcelJS from 'exceljs';
import {
  GIRDERS_PER_SPAN, SEG_KINDS, ASSEMBLIES, STUDS, segmentParts,
} from './model.mjs';

const spanCodes = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const out = process.argv[3];
if (!spanCodes.length || !out) {
  console.error('Usage: node scripts/kepl/make-boq-sheet.mjs <spanCode[,spanCode…]> <out.xlsx>');
  process.exit(1);
}

/** The app's BOQ columns, in order. */
const HEADERS = [
  'Span', 'Girder', 'Segment', 'Part', 'Part Name',
  'Thick', 'Length', 'Width', 'Qty', 'Material', 'Grade', 'Notes',
];

const rows = [];

for (const spanCode of spanCodes) {
  const push = (girder, segment, part, name, t, l, w, qty) => rows.push([
    spanCode, girder, segment, part, name, t, l, w, qty, '', '', '',
  ]);

  // ── girders and their segments ──────────────────────────────────────────
  for (let g = 1; g <= GIRDERS_PER_SPAN; g++) {
    const girder = `G${g}`;
    SEG_KINDS.forEach((kind, i) => {
      const segment = String(i + 1);
      for (const p of segmentParts(kind)) {
        push(girder, segment, p.code, p.name, p.t, p.l, p.w, p.qty);
      }
    });
  }

  /**
   * Cross-girder assemblies hang off the SPAN, not off a girder — they connect
   * girders, so no single one owns them. A blank Girder column collapses that
   * level, which is exactly what the sheet format is for.
   */
  for (const a of ASSEMBLIES) {
    for (let n = 1; n <= a.count; n++) {
      const segment = `${a.kind}${String(n).padStart(2, '0')}`;
      for (const p of a.parts) {
        push('', segment, p.code, p.name, p.t, p.l, p.w, p.qty);
      }
    }
  }

  /**
   * Studs are BOUGHT WHOLE, not cut from plate, so they carry no thickness and
   * nesting passes over them — procurement matches them to stock or orders
   * them. They are still a BOM row: the order genuinely contains 7,212 of them.
   */
  push('', '', 'STUD', `Shear Stud ${STUDS.diaMm} dia x ${STUDS.lengthMm}`,
    '', STUDS.lengthMm, STUDS.diaMm, STUDS.perSpan);
}

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('BOQ');
ws.addRow(HEADERS);
ws.getRow(1).font = { bold: true };
for (const r of rows) ws.addRow(r);
[10, 10, 10, 12, 30, 9, 10, 10, 8, 14, 14, 26].forEach((w, i) => {
  ws.getColumn(i + 1).width = w;
});

await wb.xlsx.writeFile(out);

const pieces = rows.reduce((s, r) => s + (Number(r[8]) || 0), 0);
console.log(`${out}: ${rows.length} rows, ${pieces} pieces across ${spanCodes.join(', ')}`);
