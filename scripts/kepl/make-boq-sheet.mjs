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
import { PART_TYPE } from '../rm-master/composite-girder-types.mjs';

/**
 * The catalogue type each row names, from the DECLARED mapping.
 *
 * Imported rather than restated: `composite-girder-types.mjs` already holds the
 * one copy, and a second would drift silently — a part typed one way here and
 * another by the repair script reports no error, it just inherits different
 * defaults.
 *
 * The stud is the exception and is named directly. It is BOUGHT WHOLE, so its
 * type is the fastener catalogue item itself, which is what makes
 * `syncOrderProcurement` mark the row `buy` and nesting pass over it. Left
 * untyped it defaults to `make`, and nesting blocks the order hunting for a
 * plate to cut a stud from.
 */
const STUD_TYPE = 'RM26SS00093';

const spanCodes = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const out = process.argv[3];
if (!spanCodes.length || !out) {
  console.error('Usage: node scripts/kepl/make-boq-sheet.mjs <spanCode[,spanCode…]> <out.xlsx>');
  process.exit(1);
}

/** The app's BOQ columns, in order. */
const HEADERS = [
  'Span', 'Girder', 'Segment', 'Part', 'Part Name', 'Type',
  'Thick', 'Length', 'Width', 'Qty', 'Material', 'Grade', 'Notes',
];

const rows = [];

for (const spanCode of spanCodes) {
  const push = (girder, segment, part, name, t, l, w, qty, type = '') => rows.push([
    spanCode, girder, segment, part, name, type, t, l, w, qty, '', '', '',
  ]);

  /**
   * A DECLARING ROW for every level that is not a part.
   *
   * A row with a blank Part declares the level above it — that is how a girder
   * segment, which is a real thing somebody welds, gets to exist as more than a
   * heading. Until the Type column existed there was no reason to write one for
   * a level the part rows already imply; now there is, because a span and a
   * girder each have a catalogue type and nothing else can state it.
   *
   * Written FIRST so the level exists before the parts hang off it — though the
   * importer creates missing levels either way, so this is only tidiness.
   */
  const declare = (girder, segment, type) =>
    push(girder, segment, '', '', '', '', '', 1, type);

  declare('', '', 'COMPOS-SPAN');

  // ── girders and their segments ──────────────────────────────────────────
  for (let g = 1; g <= GIRDERS_PER_SPAN; g++) {
    const girder = `G${g}`;
    declare(girder, '', 'COMPOS-GDR');
    SEG_KINDS.forEach((kind, i) => {
      const segment = String(i + 1);
      declare(girder, segment, 'COMPOS-SEG');
      for (const p of segmentParts(kind)) {
        push(girder, segment, p.code, p.name, p.t, p.l, p.w, p.qty, PART_TYPE[p.code] ?? '');
      }
    });
  }

  /**
   * Cross-girder assemblies hang off the SPAN, not off a girder — they connect
   * girders, so no single one owns them. A blank Girder column collapses that
   * level, which is exactly what the sheet format is for.
   */
  /** Which catalogue type each assembly family is. Declared, not inferred. */
  const ASSEMBLY_TYPE = { ED: 'COMPOS-EDIA', ID: 'COMPOS-IDIA', SPL: 'COMPOS-SPL' };

  for (const a of ASSEMBLIES) {
    for (let n = 1; n <= a.count; n++) {
      const segment = `${a.kind}${String(n).padStart(2, '0')}`;
      declare('', segment, ASSEMBLY_TYPE[a.kind] ?? '');
      for (const p of a.parts) {
        push('', segment, p.code, p.name, p.t, p.l, p.w, p.qty, PART_TYPE[p.code] ?? '');
      }
    }
  }

  /**
   * Studs are BOUGHT WHOLE, not cut from plate, so they carry no thickness and
   * nesting passes over them — procurement matches them to stock or orders
   * them. They are still a BOM row: the order genuinely contains 7,212 of them.
   */
  push('', '', 'STUD', `Shear Stud ${STUDS.diaMm} dia x ${STUDS.lengthMm}`,
    '', STUDS.lengthMm, STUDS.diaMm, STUDS.perSpan, STUD_TYPE);
}

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('BOQ');
ws.addRow(HEADERS);
ws.getRow(1).font = { bold: true };
for (const r of rows) ws.addRow(r);
[10, 10, 10, 12, 30, 18, 9, 10, 10, 8, 14, 14, 26].forEach((w, i) => {
  ws.getColumn(i + 1).width = w;
});

await wb.xlsx.writeFile(out);

const pieces = rows.reduce((s, r) => s + (Number(r[9]) || 0), 0);
console.log(`${out}: ${rows.length} rows, ${pieces} pieces across ${spanCodes.join(', ')}`);
