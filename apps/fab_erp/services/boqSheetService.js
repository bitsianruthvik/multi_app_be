/**
 * boqSheetService.js — the order's BOQ as ONE sheet, the way the shop writes it.
 *
 * Their real Bill of Quantity is a single flat list. The hierarchy is not tabs
 * or pasted parent codes — it is columns:
 *
 *   Span | Girder | Segment | Part | Part Name  | Thick | Length | Width | Qty
 *   S1   | G1     | 1       | TF1  | Top Flange |  40   | 7500   | 500   |  1
 *
 * which is exactly their existing "Shipping Mark G1 - 1 / Part List TF1", with
 * the mark split into the two levels it always meant. The codes ARE the
 * structure: a level is created the first time its code appears, so nothing has
 * to be copy-pasted between sheets and nothing has to be filled in twice.
 *
 * The resulting item code reads the same way — `<order prefix>-S1-G1-1-TF1`.
 *
 * A row with a blank Part declares the level above it — a girder segment is a
 * real thing that gets welded, not just a heading.
 *
 * Blank intermediate levels collapse: a PEB with no girders or segments is just
 * Span + Part, and nothing about the format has to change to say so.
 *
 * THIS SHEET IS STRUCTURE AND GEOMETRY ONLY (2026-08-07). An order is built in
 * three passes and they are deliberately three documents:
 *
 *   1. BOQ       what the thing is, and the size of each piece   (here)
 *   2. Nesting   which plate each part is cut from    (nestingSheetService)
 *   3. Flow      how each piece gets made             (flow allocation)
 *
 * They arrive at different times from different people — the BOQ off the
 * drawing, nesting off the nesting software, flows from planning — so keeping
 * them in one file meant nobody could finish their part without holding up the
 * others, and a re-upload of one silently overwrote the rest.
 *
 * WEIGHT IS NOT IN THIS SHEET EITHER. It is volume x density, from the
 * material's `density_kg_m3` and, for anything not flat, its `section_area_mm2`
 * — see itemWeightService. The material comes from the Nesting document, so a
 * part's weight can only be worked out once nesting is done.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { recomputeOrderWeights } from './itemWeightService.js';
import {
  orderCodePrefix, appendLevel, levelLabel, composeCode, materialSegment,
} from './itemCodeService.js';
import { rawMaterialsFor } from './rawMaterialService.js';
import { syncOrderProcurement } from './procurementService.js';
import { setFields } from './fieldService.js';

const SHEET = 'BOQ';
const TEMPLATE_ROWS = 600;

/** Ordered, and the order is the hierarchy. */
export const LEVELS = [
  { key: 'span',    header: 'Span',    width: 10 },
  { key: 'girder',  header: 'Girder',  width: 10 },
  { key: 'segment', header: 'Segment', width: 10 },
  { key: 'part',    header: 'Part',    width: 12 },
];

// Structure and geometry only. Material belongs to the Nesting document and
// the operation flow to flow allocation — one document, one question, so two
// people can work on an order at once and neither overwrites the other.
const COLS = [
  ...LEVELS.map((l) => ({ header: l.header, width: l.width, key: l.key })),
  { header: 'Part Name', width: 30, key: 'name' },
  { header: 'Thick',     width: 9,  key: 'height' },
  { header: 'Length',    width: 10, key: 'length' },
  { header: 'Width',     width: 10, key: 'width' },
  { header: 'Qty',       width: 8,  key: 'qty' },
  /**
   * WHAT THE STEEL IS — not which piece of it, which is nesting's job.
   *
   * This replaced a `Raw Material` column that named a specific catalogue item,
   * and the reason is that the column stopped being answerable. It was written
   * when a raw material meant a THICKNESS ("MS Plate 20mm"), so naming one on a
   * BOM row was a statement about the part. Since the catalogue took on every
   * SIZE, naming an item also picks a 2000-wide plate over a 2500-wide one —
   * and which size to buy cannot be known until you know what else is being cut
   * from the same sheet. That is the nesting decision, made later.
   *
   * So the sheet now states the SPECIFICATION and nesting resolves it to a
   * plate. These two plus `Thick` are the three axes a part is matched on.
   *
   * BOTH ARE OPTIONAL HERE. The usual case is that a whole order is one steel,
   * so material and grade are set once on the ORDER LINE and inherited by every
   * part; a value in these columns is an OVERRIDE for the row that needs
   * different steel. Leaving them blank is the normal, expected thing.
   */
  { header: 'Material', width: 14, key: 'material' },
  { header: 'Grade',    width: 14, key: 'grade' },
  { header: 'Notes',     width: 26, key: 'notes' },
];
const C = Object.fromEntries(COLS.map((c, i) => [c.key, i + 1]));

// ── cell helpers ─────────────────────────────────────────────────────────────

function cellVal(row, col) {
  if (!col) return null;
  const c = row.getCell(col);
  const x = c.value;
  if (x === null || x === undefined) return null;
  if (typeof x === 'object') {
    if (Array.isArray(x.richText)) return x.richText.map((r) => r.text).join('').trim() || null;
    if (x.text !== undefined)   return String(x.text).trim() || null;
    if (x.result !== undefined) return String(x.result).trim() || null;
    return null;
  }
  return String(x).trim() || null;
}
function numVal(row, col) {
  const v = cellVal(row, col);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const key = (s) => String(s ?? '').trim().toUpperCase();

function styledHeader(ws) {
  ws.addRow(COLS.map((c) => c.header));
  const r = ws.getRow(1);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  r.alignment = { vertical: 'middle', horizontal: 'center' };
  r.height = 20;
  COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
  // The four level columns are the structure — tint them so it reads as one block.
  for (let i = 1; i <= LEVELS.length; i++) {
    ws.getColumn(i).font = { bold: true };
  }
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: LEVELS.length }];
}

// ── export ───────────────────────────────────────────────────────────────────

/**
 * @param {object[]} [seedRows] rows to pre-fill (the wizard's output). Each is
 *        `{ span, girder, segment, part, name, height, length, width, qty, notes }`.
 */
export async function exportBoqSheet(companyId, orderId, seedRows = null) {
  const [orders] = await pool.query(
    'SELECT id, order_number FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');
  const prefix = await orderCodePrefix(companyId, orderId);

  const materials = await rawMaterialsFor(companyId);

  const wb = new ExcelJS.Workbook();

  // ── Instructions ─────────────────────────────────────────────────────────
  const help = wb.addWorksheet('Instructions');
  help.getColumn(1).width = 108;
  [
    `Order ${orders[0].order_number} — BOQ`,
    '',
    'ONE SHEET. THE COLUMNS ARE THE STRUCTURE.',
    '  Span / Girder / Segment / Part hold CODES, and a level is created the first time its',
    '  code appears. Repeat the same Span and Girder down the rows — that is what says these',
    '  parts belong to it. Nothing is copy-pasted between sheets.',
    '',
    `  Every item's full code is built from them: ${prefix}-S1-G1-1-TF1`,
    '',
    'A ROW WITH A BLANK PART declares the level above it — a girder or a segment is a real',
    '  thing that gets welded, not just a heading, so it needs a row of its own.',
    '',
    'LEAVE A LEVEL BLANK IF THE JOB HAS NO SUCH THING. A PEB with no girders is just Span and',
    '  Part; the levels in between collapse and nothing else changes.',
    '',
    'THIS SHEET IS STRUCTURE AND SIZES ONLY.',
    '  An order is built in three passes, and they are three separate documents on purpose:',
    '     1. BOQ       what the thing is, and how big each piece is   (this one)',
    '     2. Nesting   which plate each part is cut from',
    '     3. Flow      how each piece gets made',
    '  They come from different people at different times — the BOQ off the drawing, nesting off',
    '  the nesting software, flows from planning. Keeping them apart means nobody waits, and',
    '  re-uploading one does not wipe out the others.',
    '',
    'THICK / LENGTH / WIDTH are this PART\'s size — the finished piece, not the plate it comes',
    '  from. The plate belongs on the Nesting sheet.',
    '',
    'QTY is how many of this part go into ONE of its parent. Defaults to 1.',
    '',
    'MATERIAL / GRADE say WHAT THE STEEL IS, not which plate it comes off. Leave them BLANK',
    '  unless this row is different: material and grade are set once on the order line and every',
    '  part inherits them. Fill a cell only for the part that needs something else — a stainless',
    '  insert in a mild-steel span, or one plate in a lower grade.',
    '',
    '  Together with Thick these are the three things a part is matched on. WHICH PLATE it is',
    '  actually cut from is decided later, at nesting, because that depends on what else is being',
    '  cut from the same sheet — and the nesting step will refuse any plate that disagrees with',
    '  these values.',
    '',
    'WEIGHT IS NOT IN THIS SHEET. It is worked out as volume x density, and the density comes',
    '  from the material named above. The "Materials" sheet lists what is available and what each',
    '  one weighs; note that an angle, channel or beam is NOT thickness x width, so those carry a',
    '  cross-section and need only a length.',
  ].forEach((l) => help.addRow([l]));
  help.getRow(1).font = { bold: true, size: 13 };
  help.eachRow((row, n) => {
    if (n === 1) return;
    const t = String(row.getCell(1).value ?? '');
    if (t && t === t.toUpperCase() && /[A-Z]/.test(t) && !t.startsWith(' ')) row.font = { bold: true };
  });

  // ── BOQ ──────────────────────────────────────────────────────────────────
  const ws = wb.addWorksheet(SHEET);
  styledHeader(ws);

  const rows = seedRows ?? await readExistingAsRows(companyId, orderId);
  for (const r of rows) {
    ws.addRow([
      r.span ?? '', r.girder ?? '', r.segment ?? '', r.part ?? '',
      r.name ?? '',
      r.height ?? '', r.length ?? '', r.width ?? '', r.qty ?? '',
      r.material ?? '', r.grade ?? '',
      r.notes ?? '',
    ]);
  }

  // ── Flows ────────────────────────────────────────────────────────────────
  // No Flows sheet — flow allocation is its own pass and its own document.

  // ── Materials ────────────────────────────────────────────────────────────
  // Carries the weight factor, because "why is this part 12 kg" is answered here.
  const wsM = wb.addWorksheet('Materials');
  wsM.addRow(['Code', 'Name', 'Density (kg/m³)', 'Section area (mm²)', 'Dimensions needed', 'How the weight is worked out']);
  wsM.getRow(1).font = { bold: true };
  [22, 34, 16, 18, 24, 52].forEach((w, i) => { wsM.getColumn(i + 1).width = w; });
  for (const m of materials) {
    // DECIMAL comes back from mysql2 as a string; written raw it lands in the
    // sheet as text, which reads as a number but will not add up.
    const d = m.density_kg_m3 == null ? null : Number(m.density_kg_m3);
    const a = m.section_area_mm2 == null ? null : Number(m.section_area_mm2);
    wsM.addRow([
      m.code, m.name, d ?? '', a ?? '',
      d == null ? '—' : a != null ? 'Length only' : 'Thick + Width + Length',
      d == null ? 'no density set — weight cannot be worked out'
        : a != null ? `${a} mm² × length × ${d} kg/m³  (a profile is not thickness × width)`
          : `thickness × width × length × ${d} kg/m³`,
    ]);
  }

  addSpecDropdowns(wb, ws, await specVocabulary(companyId), Math.max(rows.length + 1, 400));

  return wb.xlsx.writeBuffer();
}

/**
 * The material and grade values this company actually uses, for the dropdowns.
 *
 * Read from the catalogue rather than hard-coded, because "MS / SS304 / E350 BO"
 * is this shop's vocabulary and the next one has a different one. A field def
 * with `allowed_values` wins where somebody has set it — that is a deliberate
 * statement about what is permitted — and otherwise the list is whatever the
 * catalogue is actually labelled with.
 *
 * WHAT REPLACED WHAT. There used to be a thickness-filtered dropdown here: one
 * hidden named range per stocked thickness, and an `INDIRECT` formula resolving
 * the range from the row's Thick cell, so a 20 mm part offered only 20 mm
 * materials. All of that existed to stop somebody picking the wrong CATALOGUE
 * ITEM, and the column no longer names one — thickness is its own column and
 * nesting does the matching. Two plain lists are the whole job now.
 *
 * @returns {Promise<{materials:string[], grades:string[]}>}
 */
async function specVocabulary(companyId) {
  const [defs] = await pool.query(
    `SELECT field_key AS k, allowed_values AS allowed FROM fab_field_defs
      WHERE company_id = ? AND deleted_at IS NULL AND field_key IN ('material','grade')`,
    [companyId],
  );
  const [used] = await pool.query(
    `SELECT DISTINCT d.field_key AS k, v.value_text AS v
       FROM fab_field_values v
       JOIN fab_field_defs d ON d.id = v.field_id AND d.deleted_at IS NULL
      WHERE v.company_id = ? AND v.deleted_at IS NULL
        AND d.field_key IN ('material','grade')
        AND v.value_text IS NOT NULL AND v.value_text <> ''`,
    [companyId],
  );

  const pick = (k) => {
    const def = defs.find((d) => d.k === k);
    let allowed = null;
    try {
      const parsed = def?.allowed ? JSON.parse(def.allowed) : null;
      if (Array.isArray(parsed) && parsed.length) allowed = parsed.map(String);
    } catch { /* a malformed list is not a reason to have no dropdown */ }
    return (allowed ?? used.filter((u) => u.k === k).map((u) => u.v))
      .filter(Boolean).sort((a, b) => a.localeCompare(b));
  };
  return { materials: pick('material'), grades: pick('grade') };
}

/**
 * Offer those values as dropdowns, without forbidding anything else.
 *
 * `showErrorMessage` stays off, as it was on the column this replaced: the cell
 * remains typeable and the importer has the final say. A shop that has just
 * taken its first stainless job must be able to write SS304 before anybody has
 * added it to the catalogue, or the sheet becomes the thing blocking the work.
 */
function addSpecDropdowns(wb, ws, vocab, lastRow) {
  const lists = wb.addWorksheet('Lists');
  lists.state = 'veryHidden'; // not a sheet anyone should be editing
  let col = 0;

  const writeColumn = (name, values) => {
    col += 1;
    values.forEach((v, i) => { lists.getCell(i + 1, col).value = v; });
    if (!values.length) return null;
    const letter = lists.getColumn(col).letter;
    wb.definedNames.add(`Lists!$${letter}$1:$${letter}$${values.length}`, name);
    return name;
  };

  const matName = writeColumn('SPEC_MATERIAL', vocab.materials);
  const gradeName = writeColumn('SPEC_GRADE', vocab.grades);

  for (let r = 2; r <= lastRow; r++) {
    if (matName) {
      ws.getCell(r, C.material).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`=${matName}`], showErrorMessage: false,
      };
    }
    if (gradeName) {
      ws.getCell(r, C.grade).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`=${gradeName}`], showErrorMessage: false,
      };
    }
  }
}

/** Read the order's current tree back into sheet rows, so it round-trips. */
async function readExistingAsRows(companyId, orderId) {
  const [items] = await pool.query(
    `SELECT fi.id, fi.parent_item_id, fi.name, fi.code, fi.level_kind, fi.qty, fi.unit,
            fi.length, fi.width, fi.height, fi.catalog_item_id, fi.flow_id,
            fic.code AS catalog_code, fof.name AS flow_name
       FROM fab_items fi
       LEFT JOIN fab_item_catalog fic ON fic.id = fi.catalog_item_id
       LEFT JOIN fab_operation_flows fof ON fof.id = fi.flow_id AND fof.deleted_at IS NULL
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
      ORDER BY fi.id`,
    [companyId, orderId],
  );
  if (!items.length) return [];

  const byId = new Map(items.map((i) => [i.id, i]));
  const hasChild = new Set(items.filter((i) => i.parent_item_id != null).map((i) => i.parent_item_id));
  const isRmLink = (i) => !hasChild.has(i.id) && i.catalog_item_id != null && !i.flow_name;

  /**
   * What was typed in this level's column. The inverse of appendLevel, so a
   * segment that absorbed its girder's label (`…-GDR01/01` under `…-GDR01`)
   * comes back out as `GDR01/01`, not `/01`.
   */
  const labelOf = (i) => {
    if (!i.code) return i.name;
    const parent = i.parent_item_id != null ? byId.get(i.parent_item_id) : null;
    if (!parent?.code) return String(i.code).split('-').pop() ?? i.code;
    return levelLabel(i.code, parent.code, labelOf(parent));
  };

  const chainOf = (i) => {
    const out = [];
    let cur = i;
    const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      out.unshift(cur);
      cur = cur.parent_item_id != null ? byId.get(cur.parent_item_id) : null;
    }
    return out;
  };

  /**
   * The material and grade each row STATES ITSELF, for the round trip.
   *
   * Deliberately the row's own value and not the resolved one. Almost every part
   * inherits from the order line, and writing the inherited answer into every
   * row would turn one statement into six hundred copies — after which changing
   * the line would change nothing, because each row now overrides it. The blank
   * cell is the meaningful thing: it means "whatever the line says".
   */
  const ownSpec = await ownFieldValues(companyId, items.map((i) => i.id));

  const rows = [];
  for (const i of items) {
    if (isRmLink(i)) continue;
    const chain = chainOf(i).filter((c) => !isRmLink(c));
    const levels = ['', '', '', ''];
    chain.slice(0, LEVELS.length).forEach((c, idx) => { levels[idx] = labelOf(c); });

    // Only the deepest node of a branch carries part detail; an assembly row
    // exists to hold its own flow.
    const isLeafish = !hasChild.has(i.id) || (items.filter((c) => c.parent_item_id === i.id).every(isRmLink));
    rows.push({
      span: levels[0], girder: levels[1], segment: levels[2], part: levels[3],
      name: isLeafish ? i.name : '',
      height: i.height != null ? Number(i.height) : '',
      length: i.length != null ? Number(i.length) : '',
      width:  i.width  != null ? Number(i.width)  : '',
      qty:    i.qty    != null ? Number(i.qty)    : '',
      material: ownSpec.get(i.id)?.material ?? '',
      grade:    ownSpec.get(i.id)?.grade ?? '',
      notes: '',
    });
  }
  return rows;
}

/**
 * `material` and `grade` as STORED ON THESE ROWS — no ladder walk.
 *
 * `resolveFields` would answer what each part effectively is, which is the right
 * question nearly everywhere else and the wrong one here. A sheet is round
 * tripped: whatever it shows comes back on the next upload and is written. Show
 * the inherited value and the next upload stamps it onto every row as an
 * explicit override, and the order line quietly stops meaning anything.
 *
 * @returns {Promise<Map<number, {material?:string, grade?:string}>>}
 */
async function ownFieldValues(companyId, itemIds) {
  const out = new Map();
  const ids = [...new Set((itemIds ?? []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return out;

  const [rows] = await pool.query(
    `SELECT v.scope_id AS itemId, d.field_key AS k, v.value_text AS v
       FROM fab_field_values v
       JOIN fab_field_defs d ON d.id = v.field_id AND d.deleted_at IS NULL
      WHERE v.company_id = ? AND v.scope = 'order_item' AND v.scope_id IN (?)
        AND v.deleted_at IS NULL AND d.field_key IN ('material','grade')`,
    [companyId, ids],
  );
  for (const r of rows) {
    if (r.v == null || r.v === '') continue;
    if (!out.has(Number(r.itemId))) out.set(Number(r.itemId), {});
    out.get(Number(r.itemId))[r.k] = r.v;
  }
  return out;
}

// ── import ───────────────────────────────────────────────────────────────────

function parseRows(ws) {
  const out = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const levels = LEVELS.map((l) => cellVal(row, C[l.key]));
    if (levels.every((v) => !v) && !cellVal(row, C.name)) return;
    out.push({
      row: n,
      levels,
      name:     cellVal(row, C.name),
      height:   numVal(row, C.height),
      length:   numVal(row, C.length),
      width:    numVal(row, C.width),
      qty:      numVal(row, C.qty),
      material: cellVal(row, C.material),
      grade:    cellVal(row, C.grade),
    });
  });
  return out;
}

/**
 * @param {'append'|'replace'} mode
 */
export async function importBoqSheet(file, companyId, orderId, mode = 'append') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const ws = wb.getWorksheet(SHEET)
    ?? wb.worksheets.find((s) => /^boq$/i.test(s.name.trim()));
  if (!ws) throw new Error(`No "${SHEET}" sheet found in the uploaded file. Download the template from this order and fill that in.`);

  const [orders] = await pool.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');

  if (mode === 'replace') {
    const [[worked]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM fab_project_tasks
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
          AND (started_at IS NOT NULL OR status IN ('in_progress','paused','done'))`,
      [companyId, orderId],
    );
    if (worked.cnt > 0) {
      throw new Error(
        `Replace refused: ${worked.cnt} task(s) on this order have already been started or finished. `
        + 'Replacing the item tree would throw that shop-floor history away. Import with Append instead.',
      );
    }
  }

  const parsed = parseRows(ws);
  const result = {
    mode, itemsCreated: 0, levelsCreated: 0, itemsSkipped: 0, itemsDeleted: 0,
    rmLinks: 0, totalWeight: null, unweighedLeaves: 0, warnings: [],
  };
  if (!parsed.length) {
    result.warnings.push({ message: 'The uploaded BOQ sheet had no filled-in rows.' });
    return result;
  }

  const conn = await pool.getConnection();
  const rowLog = [];
  const nodeByCode = new Map(); // full code -> { id }

  try {
    await conn.beginTransaction();
    const prefix = await orderCodePrefix(companyId, orderId, conn);

    if (mode === 'replace') {
      const [[before]] = await conn.query(
        'SELECT COUNT(*) AS cnt FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL',
        [companyId, orderId],
      );
      await conn.query('UPDATE fab_project_tasks SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, orderId]);
      await conn.query('UPDATE fab_task_inputs SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, orderId]);
      await conn.query('UPDATE fab_items SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, orderId]);
      result.itemsDeleted = before.cnt;
    } else {
      const [existing] = await conn.query(
        `SELECT id, code FROM fab_items
          WHERE company_id = ? AND order_id = ? AND code IS NOT NULL AND deleted_at IS NULL`,
        [companyId, orderId],
      );
      for (const e of existing) nodeByCode.set(key(e.code), { id: e.id });
    }

    // No catalog or flow lookups here — this sheet no longer carries either.

    // Which line each row belongs to, by its top-level (Span) code. A line is
    // free text now, so this is a plain string match on the code the user typed
    // in the wizard — the same code they then put in the sheet's first column.
    // A row whose top level matches no line still imports; it simply has no
    // line, and the BOM step will report it rather than refusing the upload.
    const [orderLines] = await conn.query(
      `SELECT id, code FROM fab_order_lines
        WHERE company_id = ? AND order_id = ? AND code IS NOT NULL AND deleted_at IS NULL`,
      [companyId, orderId],
    );
    const lineByCode = new Map(orderLines.map((l) => [key(l.code), l.id]));


    for (const r of parsed) {
      const path = r.levels.map((v, i) => ({ label: v, kind: LEVELS[i].key })).filter((p) => p.label);
      const base = { row: r.row, path: path.map((p) => p.label).join(' / '), name: r.name ?? '' };
      const skip = (reason) => { rowLog.push({ ...base, status: 'Skipped', reason }); result.itemsSkipped++; };
      const rowNotes = [];

      if (!path.length) { skip('No level code on this row — at least a Span is needed.'); continue; }

      /**
       * The three geometry cells, keyed the way the field registry names them.
       *
       * `fab_items.length/width/height` are no longer somewhere to write: they
       * are a projection of these values, written by setFields (see
       * fieldProjection.js). Setting the column directly would set the copy
       * without the thing it is copied from — the same drift the projection
       * exists to remove, only pointing the other way, and the field system
       * would not see the dimension at all.
       *
       * Thick -> thickness_mm. The sheet declares that column with key
       * `height` and it projects back to `fab_items.height`; that column has
       * always held thickness, not any height.
       *
       * Only cells that were actually filled in are listed. A blank cell means
       * "not stated on this row", which is why the old UPDATE used COALESCE —
       * and setFields reads a null as "clear this value", so a blank listed
       * here would delete a dimension somebody set elsewhere.
       */
      const dims = {};
      if (r.length != null) dims.length_mm = r.length;
      if (r.width  != null) dims.width_mm = r.width;
      if (r.height != null) dims.thickness_mm = r.height;

      // Walk the path, creating any level that has not been seen yet. This is
      // what lets the same Span/Girder be repeated down hundreds of rows
      // without creating hundreds of girders.
      let parentId = null;
      let parentCode = prefix;
      let parentLabel = null;
      let node = null;
      let createdHere = false;
      // Every node on this row belongs to the line named by its top level, all
      // the way down — that is what makes a line's progress answerable.
      const lineId = lineByCode.get(key(path[0].label)) ?? null;

      for (let i = 0; i < path.length; i++) {
        // appendLevel, not plain concatenation: a segment is numbered by naming
        // its girder (GDR01 -> GDR01/01), and joining blindly would say GDR01
        // twice. See itemCodeService.
        const code = appendLevel(parentCode, parentLabel, path[i].label);
        const isLast = i === path.length - 1;
        let hit = nodeByCode.get(key(code));

        if (!hit) {
          const [ins] = await conn.query(
            // No dimension columns: the row has to exist before setFields can
            // be given its id, so the item is inserted without them and the
            // projection fills them in from the values a moment later. All
            // three are NULLable, so nothing is owed at insert time.
            `INSERT INTO fab_items
               (company_id, order_id, order_line_id, parent_item_id, catalog_item_id, name, unit, qty, flow_id,
                code, level_kind)
             VALUES (?,?,?,?,NULL,?,?,?,?,?,?)`,
            [
              companyId, orderId, lineId, parentId,
              // An intermediate level has no name of its own in the BOQ — the
              // code is what everyone calls it.
              isLast ? (r.name ?? path[i].label) : path[i].label,
              'pcs',
              isLast ? (r.qty ?? 1) : 1,
              null, // flow allocation is its own pass — never set from the BOQ
              code, path[i].kind,
            ],
          );
          hit = { id: ins.insertId };
          nodeByCode.set(key(code), hit);
          if (isLast) { result.itemsCreated++; createdHere = true; } else result.levelsCreated++;
        } else if (isLast) {
          // The level already exists — this row is filling in its detail.
          // flow_id is deliberately absent: it belongs to flow allocation, and
          // a BOQ re-upload must not clear a flow someone has since assigned.
          // The dimensions are absent for the same reason they are absent from
          // the INSERT: those columns are a projection now, and `dims` below is
          // where the value is written.
          await conn.query(
            `UPDATE fab_items SET
               name = COALESCE(?, name), qty = COALESCE(?, qty),
               order_line_id = COALESCE(order_line_id, ?)
             WHERE id = ? AND company_id = ?`,
            [r.name, r.qty, lineId, hit.id, companyId],
          );
          createdHere = true;
        }

        parentId = hit.id;
        parentCode = code;
        parentLabel = path[i].label;
        node = hit;
      }

      /**
       * The geometry, onto the leaf the row describes.
       *
       * One call per row rather than three writes, and none at all for a row
       * with no dimensions — which is most of them, since span, girder and
       * segment rows declare a level and carry no size. setFields is a round
       * trip whether or not it has anything to do.
       *
       * `conn` is the import's transaction, so a value that lands here rolls
       * back with the item it belongs to; without it the values would survive a
       * failed import and describe rows that no longer exist.
       */
      if (node && Object.keys(dims).length) {
        // setFields reports a bad value instead of throwing, so a rejection has
        // to be surfaced or the dimension is dropped in silence — reported like
        // any other per-row problem here: a warning plus a note on the row's log
        // entry, with the item itself still created.
        const { rejected } = await setFields(companyId, 'order_item', node.id, dims, conn);
        for (const rej of rejected) {
          const message = `Dimension '${rej.fieldKey}' not set — ${rej.why}.`;
          result.warnings.push({ row: r.row, message });
          rowNotes.push(message);
        }
      }

      /**
       * WHAT THE STEEL IS — written as an override on this row, nothing more.
       *
       * This used to create a MATERIAL LINK to a named catalogue item, and that
       * was the pre-nesting material assignment: by the time the BOM finished
       * importing, every part had already been committed to a specific plate.
       * It worked while a material meant only a thickness. It stopped being
       * answerable once the catalogue held every size, because choosing between
       * a 2000 and a 2500 wide sheet depends on what else is cut from it — a
       * question this sheet cannot answer and nesting exists to.
       *
       * So the sheet states the spec and the link is made at NESTING, by the
       * suggestor or by a drop on the board, both of which refuse a plate that
       * disagrees with these values.
       *
       * ONLY WHAT THE ROW ACTUALLY SAYS is written. A blank cell writes nothing
       * rather than clearing, so a part keeps inheriting from its order line —
       * which is how nearly every part gets its answer.
       */
      const spec = {};
      if (node && r.material) spec.material = r.material;
      if (node && r.grade) spec.grade = r.grade;
      if (Object.keys(spec).length) {
        const { rejected } = await setFields(companyId, 'order_item', node.id, spec, conn);
        for (const rej of rejected) {
          const message = `'${rej.fieldKey}' not set — ${rej.why}.`;
          result.warnings.push({ row: r.row, message });
          rowNotes.push(message);
        }
        if (!rejected.length) result.specSet = (result.specSet ?? 0) + 1;
      }

      rowLog.push({ ...base, status: createdHere ? 'Created' : 'Skipped',
        reason: createdHere ? rowNotes.join(' ') : 'Nothing to create on this row.' });
      if (!createdHere) result.itemsSkipped++;
    }

    await propagateLineIds(conn, companyId, orderId);
    // Classify what was just created before the transaction closes: a row that
    // reaches the tree with no answer to make-or-buy is a row the purchasing
    // and production steps will silently skip.
    await syncOrderProcurement(conn, companyId, orderId);

    const w = await recomputeOrderWeights(companyId, orderId, conn);
    result.totalWeight = w.totalWeight;
    result.unweighedLeaves = w.unweighedLeaves;

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  result.reportBase64 = (await buildReport(rowLog)).toString('base64');
  return result;
}

/**
 * Push each node's line down to its children, until nothing is left unlabelled.
 *
 * The row-by-row insert already stamps the line on everything it creates, but
 * two cases slip past it: an intermediate level that existed from an earlier
 * upload, and the raw-material links nesting hangs under a part later on. A
 * sweep catches both, and is cheap — the tree is five levels deep, so it
 * settles in five passes at worst.
 *
 * Exported because nesting needs it for exactly the same reason.
 */
export async function propagateLineIds(conn, companyId, orderId) {
  for (let depth = 0; depth < 8; depth++) {
    const [res] = await conn.query(
      `UPDATE fab_items c
         JOIN fab_items p ON p.id = c.parent_item_id AND p.deleted_at IS NULL
          SET c.order_line_id = p.order_line_id
        WHERE c.company_id = ? AND c.order_id = ? AND c.deleted_at IS NULL
          AND c.order_line_id IS NULL AND p.order_line_id IS NOT NULL`,
      [companyId, orderId],
    );
    if (!res.affectedRows) break;
  }
}

/**
 * Turn "6 girders, 5 segments each, these parts in every segment" into the rows
 * of a starting sheet.
 *
 * This only ever produces a spreadsheet. It is scaffolding to save typing the
 * same Span/Girder/Segment codes four hundred times — the real structure is
 * whatever comes back on upload, so anything here can be edited, deleted or
 * added to first. That is also why nothing is written to the database: a
 * half-thought-through wizard run must not leave a half-built tree behind.
 *
 * A count of zero collapses that level, which is how a PEB (no girders, no
 * segments) uses the same wizard as a six-girder span.
 *
 * @param {object} spec
 * @param {string} [spec.spanCode]
 * @param {number} [spec.girders]
 * @param {number} [spec.segmentsPerGirder]
 * @param {{code:string,name?:string,qty?:number}[]} [spec.parts]
 */
export function buildWizardRows(spec = {}) {
  const spanCode = String(spec.spanCode ?? 'S1').trim() || 'S1';
  const girders = Math.max(0, Number(spec.girders) || 0);
  const segs    = Math.max(0, Number(spec.segmentsPerGirder) || 0);
  const parts   = Array.isArray(spec.parts) ? spec.parts.filter((p) => p && p.code) : [];

  /**
   * Segments for girder `g` (1-based).
   *
   * `segmentCounts` lets each girder differ, because on a real span they do —
   * an end girder is not always cut into the same number of pieces as a middle
   * one, and forcing one number meant deleting rows out of the sheet afterwards.
   * Absent or short, it falls back to the single `segmentsPerGirder` figure, so
   * the simple case stays one number.
   */
  const counts = Array.isArray(spec.segmentCounts) ? spec.segmentCounts : null;
  const segsFor = (g) => {
    const n = counts && counts[g - 1] != null ? Number(counts[g - 1]) : segs;
    return Math.max(0, Number.isFinite(n) ? n : 0);
  };

  const rows = [];

  const level = (girder, segment, part, name, qty, notes, extra = {}) => ({
    span: spanCode, girder, segment, part, name,
    height: '', length: '', width: '', qty, notes, material: '', grade: '',
    ...extra,
  });

  /**
   * Per-part material and thickness, with a per-instance override.
   *
   * Most parts are the same everywhere: every web plate on the span is 20mm
   * plate, so it is set once on the common part. But the end girder's flange is
   * routinely a different thickness from the middle ones, and until now that
   * meant editing the sheet afterwards. `overrides` is keyed by the exact
   * instance — "G2/1/TF" — so the wizard can expand every generated part and
   * set the handful that differ, without turning the common case into a
   * hundred-row form.
   */
  const overrides = spec.overrides && typeof spec.overrides === 'object' ? spec.overrides : {};
  const detailFor = (girder, segment, p) => {
    const o = overrides[`${girder}/${segment}/${p.code}`] ?? {};
    return {
      material: o.material ?? p.material ?? '',
      grade: o.grade ?? p.grade ?? '',
      height: o.thick ?? p.thick ?? '',
    };
  };
  const partRows = (girder, segment) =>
    parts.map((p) => level(girder, segment, p.code, p.name ?? '', p.qty ?? 1, '',
      detailFor(girder, segment, p)));

  // The span itself, so it exists even before anything hangs off it.
  rows.push(level('', '', '', '', 1, 'span'));

  if (!girders) {
    // No girders: parts sit straight under the span. A PEB looks like this.
    rows.push(...partRows('', ''));
    return rows;
  }

  for (let g = 1; g <= girders; g++) {
    const girder = `G${g}`;
    const n = segsFor(g);
    if (!n) {
      // Girders but no segments — the girder is the assembly.
      rows.push(level(girder, '', '', '', 1, 'assembly'));
      rows.push(...partRows(girder, ''));
      continue;
    }
    rows.push(level(girder, '', '', '', 1, 'girder'));
    for (let s = 1; s <= n; s++) {
      rows.push(level(girder, String(s), '', '', 1, 'assembly'));
      rows.push(...partRows(girder, String(s)));
    }
  }
  return rows;
}

async function buildReport(rowLog) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import Log');
  ws.addRow(['Row', 'Path', 'Part Name', 'Status', 'Reason']);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  [7, 34, 28, 11, 62].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (const r of rowLog) {
    ws.addRow([r.row, r.path, r.name, r.status, r.reason]);
    const fill = r.status === 'Created'
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
    ws.lastRow.eachCell((c) => { c.fill = fill; });
  }
  return wb.xlsx.writeBuffer();
}

/**
 * Accept a wizard-generated structure straight onto the order.
 *
 * The Structure wizard used to be download-only: it built the rows, handed back
 * a spreadsheet, and its own dialog said "nothing is saved to the order". The
 * only way to actually get that structure onto the order was to save the file
 * and upload it again — so a round-trip through Excel was mandatory even when
 * the generated structure was exactly what was wanted and nothing needed
 * editing.
 *
 * WHY THIS GOES THROUGH THE SHEET RATHER THAN STRAIGHT TO SQL. The obvious
 * implementation is to persist `buildWizardRows` output directly. That would
 * mean a SECOND path into fab_items with its own idea of code composition,
 * parent resolution, level_kind, material links, weight roll-up and the
 * replace-safety check — and the moment the two disagreed, "accept" and
 * "download then upload" would produce different trees from identical input.
 * That is the bug this feature would be most likely to cause, so instead the
 * rows are rendered with the same exporter and read back with the same
 * importer. Accept IS download-and-upload, with the human round-trip removed,
 * and it cannot drift from it because it is the same code.
 *
 * The temporary file is what `importBoqSheet` takes (it is fed by multer
 * normally) and it unlinks the file itself; the finally block only covers the
 * case where parsing threw before it got that far.
 */
let wizardTmpSeq = 0;

export async function applyWizardRows(companyId, orderId, specs, mode = 'append') {
  const list = Array.isArray(specs) && specs.length ? specs : [{}];
  const rows = list.flatMap((s) => buildWizardRows(s ?? {}));
  if (!rows.length) {
    return {
      mode, itemsCreated: 0, levelsCreated: 0, itemsSkipped: 0, itemsDeleted: 0,
      rmLinks: 0, totalWeight: null, unweighedLeaves: 0,
      warnings: [{ message: 'The wizard produced no rows — nothing was saved.' }],
    };
  }

  const buffer = await exportBoqSheet(companyId, orderId, rows);
  wizardTmpSeq += 1;
  const tmp = path.join(
    os.tmpdir(),
    `fab-boq-wizard-${companyId}-${orderId}-${process.pid}-${wizardTmpSeq}.xlsx`,
  );
  await fs.promises.writeFile(tmp, Buffer.from(buffer));
  try {
    return await importBoqSheet({ path: tmp }, companyId, orderId, mode);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}
