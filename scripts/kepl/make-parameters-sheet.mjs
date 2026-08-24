/**
 * make-parameters-sheet.mjs — fill the order's Parameters sheet from the rules
 * the customer gave, ready to upload.
 *
 * Usage: node scripts/kepl/make-parameters-sheet.mjs <companyId> <orderId> <out.xlsx>
 *
 * The Parameters stage asks each item for the values ITS flow's operations need.
 * The BOQ does not contain them — a drawing gives geometry, not weld runs — so
 * they are derived from the geometry by the rules the product owner stated:
 *
 *   weld_length_m     the item's LENGTH
 *   surface_area_m2   LENGTH × WIDTH
 *   edge_length_m     the edge around the part: 2 × (length + width)
 *   num_holes         an arbitrary placeholder — see below
 *   unit_weight_kg    the weight already rolled up for the item
 *
 * EDGE LENGTH IS THE PERIMETER, and that is a reading of "basically the part
 * dimension" rather than a restatement of it. What an edge-preparation
 * operation does is run around the outside of a cut plate, so the length of
 * edge is the distance around it — bevelling one side would be `length` alone.
 * Easy to change here if the shop means the single cut edge.
 *
 * NUM_HOLES IS A PLACEHOLDER and is the one value here that is not derived from
 * anything. It was asked for as an arbitrary number, so it is a flat constant
 * rather than something that looks calculated: a formula would imply the count
 * came from the drawing, and the next person would believe it. Only parts whose
 * flow actually drills are asked for it — the `/D` suffix ones.
 *
 * WHAT THIS IS NOT. These are costing inputs good enough to plan and price
 * with, not a fabrication specification. The real weld runs and painted areas
 * come off the drawings, and every one of them can be corrected in this same
 * sheet without touching anything else.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../db.js';
import { parameterGrid } from '../../apps/fab_erp/services/orderParametersService.js';

const companyId = Number(process.argv[2]);
const orderId = Number(process.argv[3]);
const out = process.argv[4];
if (!companyId || !orderId || !out) {
  console.error('Usage: node scripts/kepl/make-parameters-sheet.mjs <companyId> <orderId> <out.xlsx>');
  process.exit(1);
}

/** The arbitrary hole count, named so nobody mistakes it for a measurement. */
const PLACEHOLDER_HOLES = 4;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

try {
  const { columns, rows } = await parameterGrid(companyId, orderId);

  // The item's own geometry and rolled-up weight, which the grid does not carry.
  const [items] = await pool.query(
    `SELECT id, length, width, height, computed_unit_weight AS w, unit_weight AS entered
       FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  const geom = new Map(items.map((i) => [Number(i.id), i]));

  const filled = {};
  const value = (row, fieldKey) => {
    const g = geom.get(Number(row.itemId));
    const L = num(g?.length);
    const W = num(g?.width);
    switch (fieldKey) {
      case 'weld_length_m':
        return L == null ? null : L / 1000;
      case 'surface_area_m2':
        return L == null || W == null ? null : (L * W) / 1e6;
      case 'edge_length_m':
        return L == null || W == null ? null : (2 * (L + W)) / 1000;
      case 'num_holes':
        return PLACEHOLDER_HOLES;
      case 'unit_weight_kg':
        return num(g?.entered) ?? num(g?.w);
      default:
        // Anything else the flow asks for is left as it is. A blank cell is not
        // read back, so this cannot wipe a value somebody has already set.
        return null;
    }
  };

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Parameters');
  ws.addRow(['Item ID', 'Code', 'Name', 'Represents',
    ...columns.map((c) => (c.unit ? `${c.label} (${c.unit})` : c.label))]);
  ws.getRow(1).font = { bold: true };

  let short = 0;
  for (const r of rows) {
    const cells = columns.map((c) => {
      // An em dash means "this row's flow does not ask for it" — the importer
      // skips those, and writing a number into one would be answering a
      // question nobody asked.
      if (!r.required.includes(c.fieldKey)) return '—';
      const existing = r.values[c.fieldKey];
      if (existing !== undefined && existing !== null && existing !== '') return existing;
      const v = value(r, c.fieldKey);
      if (v === null) { short += 1; return ''; }
      return Math.round(v * 1e6) / 1e6;
    });
    ws.addRow([r.itemId, r.code, r.name, r.represents, ...cells]);
  }

  [10, 44, 26, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  columns.forEach((_, i) => { ws.getColumn(5 + i).width = 16; });

  await wb.xlsx.writeFile(out);
  console.log(`${out}: ${rows.length} row(s), ${columns.length} field column(s)`);
  console.log(`  columns: ${columns.map((c) => c.fieldKey).join(', ')}`);
  if (short) console.log(`  ${short} cell(s) left blank — no geometry to derive them from`);
  console.log(`  num_holes is a flat ${PLACEHOLDER_HOLES}, a placeholder, not a count off the drawing`);
} finally {
  await pool.end();
}
