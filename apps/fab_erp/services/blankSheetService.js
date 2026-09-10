/**
 * blankSheetService.js — the cutting plan as a spreadsheet, and back.
 *
 * ── WHY THE SUGGESTION MUST NOT BE THE ONLY WAY IN ───────────────────────────
 *
 * The packer is good and it is not the person who knows this yard. It does not
 * know that the 40 mm is stacked behind the 25 mm, that a particular sheet is
 * spoken for, or that the cutter would rather do all the diaphragm plates in one
 * setup. A planner who cannot express any of that ends up keeping the real plan
 * in a spreadsheet beside the software, and then the software is describing a
 * job nobody is doing.
 *
 * So the plan goes out as a sheet, gets edited, and comes back — the same
 * suggest-or-do-it-yourself pairing the old nesting board had, which is the part
 * of it worth keeping.
 *
 * ── THE SHEET ────────────────────────────────────────────────────────────────
 *
 *   Nest | Plate code | Plate size | Blank code | Blank size | Qty on this sheet
 *
 * ONE ROW PER (SHEET, BLANK). A sheet holding four rectangles is four rows
 * sharing a Nest number, which is what says "these are cut from one plate". Get
 * that grouping wrong on the way back in and the shop draws one physical sheet
 * per rectangle on it.
 *
 * MATCHED BY CODE, not by name or size. A code is exact; a size is three numbers
 * somebody may have retyped, and 2995 vs 2295 is a plausible slip that would
 * silently nest onto the wrong steel. Sizes are written out for the reader and
 * ignored on the way back.
 *
 * NOTHING IS WRITTEN UNTIL THE WHOLE SHEET PARSES. A plan half-imported because
 * row 180 named a plate that does not exist is worse than one not imported at
 * all: the order looks planned, and the missing sheets are found by someone
 * counting.
 */

import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { blankPlan } from './blankPlanService.js';

const SHEET = 'Cutting plan';
const HEADERS = [
  'Nest', 'Plate code', 'Plate (T x W x L)',
  'Blank code', 'Blank (T x W x L)', 'Qty on this sheet',
];

export async function exportPlan(companyId, orderId, opts = {}) {
  const plan = await blankPlan(companyId, orderId, opts);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET);

  ws.addRow([`Cutting plan — ${plan.orderNumber}`]);
  ws.addRow(['One row per (sheet, blank). Rows sharing a Nest number are cut from ONE plate.']);
  ws.addRow(['Edit freely: change the plate, move a blank to another nest, add or remove rows.']);
  ws.addRow(['Plate code and Blank code are what get matched. The sizes beside them are for reading.']);
  ws.addRow([]);
  ws.getRow(1).font = { bold: true, size: 13 };
  for (const n of [2, 3, 4]) ws.getRow(n).font = { size: 10, italic: true };

  const head = ws.addRow(HEADERS);
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }; });

  const blankByKey = new Map(plan.blanks.map((b) => [b.key, b]));
  for (const n of plan.nests) {
    for (const it of n.items) {
      const b = blankByKey.get(it.key);
      ws.addRow([
        n.nestNo,
        n.plateCode ?? '',
        `${n.thickness} x ${n.width} x ${n.length}`,
        b?.code ?? '',
        b ? `${b.thickness} x ${b.width} x ${b.length}` : '',
        it.qty,
      ]);
    }
  }

  ws.getColumn(1).width = 10;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 24;
  ws.getColumn(4).width = 42;
  ws.getColumn(5).width = 24;
  ws.getColumn(6).width = 18;

  /*
   * A second sheet listing what has to be cut, so somebody planning by hand can
   * see the demand without going back to the screen — and so the file is a
   * complete statement of the job rather than half of one.
   */
  const ds = wb.addWorksheet('What has to be cut');
  ds.addRow(['Blank code', 'Blank (T x W x L)', 'Material', 'Grade', 'Needed', 'Weight each (kg)', 'Serves parts'])
    .font = { bold: true };
  for (const b of plan.blanks) {
    ds.addRow([
      b.code, `${b.thickness} x ${b.width} x ${b.length}`,
      b.material ?? '', b.grade ?? '', b.qty,
      Number(b.unitWeightKg.toFixed(2)), b.partCount,
    ]);
  }
  ds.getColumn(1).width = 42;
  ds.getColumn(2).width = 24;
  for (const c of [3, 4, 5, 6, 7]) ds.getColumn(c).width = 15;

  return {
    buffer: await wb.xlsx.writeBuffer(),
    filename: `Cutting_plan_${plan.orderNumber}.xlsx`,
  };
}

/**
 * Read a filled sheet back into the shape `acceptNestingPlan` takes.
 *
 * @returns {Promise<{plan:{nests:object[]}, rows:number, sheets:number, problems:string[]}>}
 */
export async function importPlan(companyId, orderId, buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(SHEET) ?? wb.worksheets[0];
  if (!ws) { const e = new Error('That file has no sheets.'); e.status = 400; throw e; }

  // The header row is found rather than assumed: people add notes above it.
  let headerRow = 0;
  ws.eachRow((row, n) => {
    if (headerRow) return;
    if (String(row.getCell(1).value ?? '').trim().toLowerCase() === 'nest') headerRow = n;
  });
  if (!headerRow) {
    const e = new Error('No header row found — the first column of the header must read "Nest".');
    e.status = 400; throw e;
  }

  const [plateRows] = await pool.query(
    `SELECT ci.id, ci.code FROM fab_item_catalog ci
       JOIN fab_item_groups g ON g.id = ci.group_id AND g.name = 'Plates'
      WHERE ci.company_id = ? AND ci.deleted_at IS NULL AND ci.code IS NOT NULL`,
    [companyId],
  );
  const plateByCode = new Map(plateRows.map((r) => [String(r.code).trim().toUpperCase(), Number(r.id)]));

  // The blanks as this order currently computes them — the codes are derived, so
  // they exist whether or not anything has been written yet.
  const plan = await blankPlan(companyId, orderId, { effort: 'quick' });
  const keyByCode = new Map(plan.blanks.map((b) => [String(b.code).trim().toUpperCase(), b.key]));

  const problems = [];
  const byNest = new Map();
  let rows = 0;

  ws.eachRow((row, n) => {
    if (n <= headerRow) return;
    const nestNo = String(row.getCell(1).value ?? '').trim();
    const plateCode = String(row.getCell(2).value ?? '').trim().toUpperCase();
    const blankCode = String(row.getCell(4).value ?? '').trim().toUpperCase();
    const qty = Number(row.getCell(6).value);
    if (!nestNo && !plateCode && !blankCode) return;   // a blank spacer row

    if (!nestNo) { problems.push(`Row ${n}: no nest number.`); return; }
    const plateId = plateByCode.get(plateCode);
    if (!plateId) { problems.push(`Row ${n}: "${plateCode || '(blank)'}" is not a plate code in the catalogue.`); return; }
    const key = keyByCode.get(blankCode);
    if (!key) { problems.push(`Row ${n}: "${blankCode || '(blank)'}" is not a blank this order needs.`); return; }
    if (!Number.isFinite(qty) || qty <= 0) { problems.push(`Row ${n}: quantity "${row.getCell(6).value}" is not a positive number.`); return; }

    rows += 1;
    const hit = byNest.get(nestNo) ?? { nestNo, plateCatalogItemId: plateId, plateCode, items: [] };
    /*
     * ONE PLATE PER NEST. Two rows sharing a nest number but naming different
     * plates is not a thing the shop can do — it is one sheet — and guessing
     * which they meant would put the other rectangle on steel nobody chose.
     */
    if (hit.plateCatalogItemId !== plateId) {
      problems.push(`Row ${n}: nest ${nestNo} already uses plate ${hit.plateCode}; a nest is ONE sheet.`);
      return;
    }
    hit.items.push({ key, qty });
    byNest.set(nestNo, hit);
  });

  if (!rows && !problems.length) {
    const e = new Error('That sheet has no rows under the header.'); e.status = 400; throw e;
  }
  if (problems.length) {
    const e = new Error(`That plan could not be read:\n${problems.slice(0, 12).join('\n')}`
      + (problems.length > 12 ? `\n…and ${problems.length - 12} more` : ''));
    e.status = 400; e.problems = problems; throw e;
  }

  /*
   * WHAT THE SHEET DOES NOT COVER IS REPORTED, NOT FILLED IN. A hand-made plan
   * that leaves 200 stiffeners unaccounted for is a decision if it was meant and
   * a mistake if it was not, and only the person who wrote it knows which.
   */
  const planned = new Map();
  for (const n of byNest.values()) {
    for (const it of n.items) planned.set(it.key, (planned.get(it.key) ?? 0) + it.qty);
  }
  const short = plan.blanks
    .filter((b) => (planned.get(b.key) ?? 0) < b.qty)
    .map((b) => ({
      code: b.code,
      rect: `${b.thickness} x ${b.width} x ${b.length}`,
      needed: b.qty,
      planned: planned.get(b.key) ?? 0,
    }));

  return {
    plan: { nests: [...byNest.values()] },
    rows,
    sheets: byNest.size,
    short,
    problems,
  };
}
