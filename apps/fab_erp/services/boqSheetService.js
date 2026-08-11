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
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { recomputeOrderWeights } from './itemWeightService.js';
import {
  orderCodePrefix, appendLevel, levelLabel, composeCode, materialSegment,
} from './itemCodeService.js';

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
  // WHAT the part is cut from — not WHICH piece, which is nesting's job.
  // Removed from this sheet in the three-document split because it was
  // conflated with nesting; back because the two are different questions. The
  // material is a property of the part (a web plate is 20mm plate whatever
  // happens next); the plate it comes off is a decision made later, on the
  // nesting board. Capturing it here is what lets that board show only the
  // parts that could go on a given plate.
  { header: 'Raw Material', width: 22, key: 'rmCode' },
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

  const [materials] = await pool.query(
    `SELECT code, name, density_kg_m3, section_area_mm2, thickness_mm, material_form
       FROM fab_item_catalog
      WHERE company_id = ? AND deleted_at IS NULL AND procurement_type = 'buy'
      ORDER BY material_form, thickness_mm, code`,
    [companyId],
  );

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
    'WEIGHT IS NOT IN THIS SHEET. It is worked out as volume x density once nesting says which',
    '  material the part is cut from. The "Materials" sheet lists what is available and what each',
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
      r.rmCode ?? '',
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

  addMaterialDropdown(wb, ws, materials, Math.max(rows.length + 1, 400));

  return wb.xlsx.writeBuffer();
}

/**
 * Make Raw Material a dropdown that only offers what the part could be cut from.
 *
 * The list is filtered PER ROW by that row's Thick value, because offering all
 * forty stocked materials for a 20mm web plate is barely better than free text
 * — the whole point of capturing the material is that the wrong one cannot be
 * chosen by accident.
 *
 * Excel has no native "filter this list by that cell", so it is done the way
 * spreadsheets have always done it: one contiguous named range per thickness on
 * a hidden sheet, and a validation formula that resolves the name from the
 * Thick cell. `INDIRECT("T" & 20)` → the T20 range.
 *
 * SECTIONS APPEAR IN EVERY LIST. An angle is one item — a 100×100×10 is not "a
 * 10mm thing" — so it cannot be reached by filtering on thickness, and leaving
 * it out would make it unpickable. Each list is therefore that thickness's
 * plates followed by every section.
 *
 * A row whose Thick is blank or has no matching range simply gets no list. That
 * is deliberate: `showErrorMessage` is off, so the cell stays typeable and the
 * importer remains the thing that has the final say. A dropdown that blocked
 * entry would make an unusual material impossible to record at all.
 */
function addMaterialDropdown(wb, ws, materials, lastRow) {
  const plates = materials.filter((m) => m.material_form !== 'section' && m.thickness_mm != null);
  const sections = materials.filter((m) => m.material_form === 'section');
  if (!plates.length && !sections.length) return;

  // Excel defined names allow letters, digits and underscore — so 12.5 becomes
  // T12_5, and the formula substitutes the same way.
  const nameFor = (t) => `T${String(Number(t)).replace('.', '_')}`;

  const byThickness = new Map();
  for (const p of plates) {
    const k = Number(p.thickness_mm);
    if (!byThickness.has(k)) byThickness.set(k, []);
    byThickness.get(k).push(p);
  }

  const lists = wb.addWorksheet('Lists');
  lists.state = 'veryHidden'; // not a sheet anyone should be editing
  let col = 0;

  const writeColumn = (name, items) => {
    col += 1;
    items.forEach((m, i) => { lists.getCell(i + 1, col).value = m.code; });
    if (!items.length) return;
    const letter = lists.getColumn(col).letter;
    wb.definedNames.add(`Lists!$${letter}$1:$${letter}$${items.length}`, name);
  };

  for (const [t, items] of [...byThickness.entries()].sort((a, b) => a[0] - b[0])) {
    writeColumn(nameFor(t), [...items, ...sections]);
  }
  // Everything, for rows with no usable thickness.
  writeColumn('RM_ALL', [...plates, ...sections]);

  const thickCol = ws.getColumn(C.height).letter;
  for (let r = 2; r <= lastRow; r++) {
    ws.getCell(r, C.rmCode).dataValidation = {
      type: 'list',
      allowBlank: true,
      // IFERROR so a blank or unknown thickness falls back to the full list
      // rather than showing Excel's reference error in the dropdown.
      formulae: [`=IFERROR(INDIRECT("T"&SUBSTITUTE(TEXT($${thickCol}$${r},"0.###"),".","_")),RM_ALL)`],
      showErrorMessage: false,
    };
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

  // An RM link is not a ROW of this sheet — but the material it names is a
  // COLUMN of its parent's row, so a re-export round-trips what was entered.
  const rmByParent = new Map();
  for (const i of items) {
    if (isRmLink(i) && i.parent_item_id != null && !rmByParent.has(i.parent_item_id)) {
      rmByParent.set(i.parent_item_id, i.catalog_code ?? null);
    }
  }

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
      rmCode: rmByParent.get(i.id) ?? '',
      notes: '',
    });
  }
  return rows;
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
      name:    cellVal(row, C.name),
      height:  numVal(row, C.height),
      length:  numVal(row, C.length),
      width:   numVal(row, C.width),
      qty:     numVal(row, C.qty),
      rmCode:  cellVal(row, C.rmCode),
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

    // Raw materials, for the "Raw Material" column. Only 'buy' items — a part
    // is cut from stock, never from another thing this shop makes.
    const [catalog] = await conn.query(
      `SELECT id, code, name, unit FROM fab_item_catalog
        WHERE company_id = ? AND deleted_at IS NULL AND procurement_type = 'buy'`,
      [companyId],
    );
    const materialByCode = new Map(catalog.map((m) => [key(m.code), m]));

    for (const r of parsed) {
      const path = r.levels.map((v, i) => ({ label: v, kind: LEVELS[i].key })).filter((p) => p.label);
      const base = { row: r.row, path: path.map((p) => p.label).join(' / '), name: r.name ?? '' };
      const skip = (reason) => { rowLog.push({ ...base, status: 'Skipped', reason }); result.itemsSkipped++; };

      if (!path.length) { skip('No level code on this row — at least a Span is needed.'); continue; }

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
            `INSERT INTO fab_items
               (company_id, order_id, order_line_id, parent_item_id, catalog_item_id, name, unit, qty, flow_id,
                length, width, height, code, level_kind)
             VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
            [
              companyId, orderId, lineId, parentId,
              // An intermediate level has no name of its own in the BOQ — the
              // code is what everyone calls it.
              isLast ? (r.name ?? path[i].label) : path[i].label,
              'pcs',
              isLast ? (r.qty ?? 1) : 1,
              null, // flow allocation is its own pass — never set from the BOQ
              isLast ? r.length : null,
              isLast ? r.width : null,
              isLast ? r.height : null,
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
          await conn.query(
            `UPDATE fab_items SET
               name = COALESCE(?, name), qty = COALESCE(?, qty),
               length = COALESCE(?, length), width = COALESCE(?, width), height = COALESCE(?, height),
               order_line_id = COALESCE(order_line_id, ?)
             WHERE id = ? AND company_id = ?`,
            [r.name, r.qty, r.length, r.width, r.height, lineId, hit.id, companyId],
          );
          createdHere = true;
        }

        parentId = hit.id;
        parentCode = code;
        parentLabel = path[i].label;
        node = hit;
      }

      /**
       * The material this part is cut FROM — deliberately not which plate.
       *
       * The link is created with `nest_no` NULL, which already means "this part
       * needs this material, on its own" everywhere downstream. Nesting later
       * fills the nest number in, grouping several such links onto one physical
       * plate. Capturing it here is what lets the nesting board offer only the
       * parts that could go on a given plate, instead of the whole order.
       *
       * An unrecognised code is reported and the part still imports: the
       * structure is worth having even when the material is not decided yet.
       */
      if (node && r.rmCode) {
        const material = materialByCode.get(key(r.rmCode));
        if (!material) {
          result.warnings.push({ row: r.row, message: `Raw Material '${r.rmCode}' is not in the Item Catalog — the part was created without it.` });
        } else {
          const [[existing]] = await conn.query(
            `SELECT id, catalog_item_id FROM fab_items
              WHERE company_id = ? AND parent_item_id = ? AND catalog_item_id IS NOT NULL
                AND flow_id IS NULL AND deleted_at IS NULL LIMIT 1`,
            [companyId, node.id],
          );
          if (!existing) {
            await conn.query(
              `INSERT INTO fab_items
                 (company_id, order_id, order_line_id, parent_item_id, catalog_item_id, name, unit,
                  qty, flow_id, code, nest_no, level_kind)
               VALUES (?,?,?,?,?,?,?,1,NULL,?,NULL,'material')`,
              [
                companyId, orderId, lineId, node.id, material.id, material.name,
                material.unit || 'pcs',
                composeCode(parentCode, materialSegment(material.code, material.name)),
              ],
            );
            result.rmLinks = (result.rmLinks ?? 0) + 1;
          } else if (existing.catalog_item_id !== material.id) {
            // Changing the material is a legitimate correction. The nest is
            // cleared with it — a nest is a group of parts sharing ONE plate,
            // so a part that is now a different material cannot stay on it.
            await conn.query(
              `UPDATE fab_items SET catalog_item_id = ?, name = ?, unit = ?, nest_no = NULL
                WHERE id = ? AND company_id = ?`,
              [material.id, material.name, material.unit || 'pcs', existing.id, companyId],
            );
            result.rmLinks = (result.rmLinks ?? 0) + 1;
          }
        }
      }

      rowLog.push({ ...base, status: createdHere ? 'Created' : 'Skipped',
        reason: createdHere ? '' : 'Nothing to create on this row.' });
      if (!createdHere) result.itemsSkipped++;
    }

    await propagateLineIds(conn, companyId, orderId);

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

/** The kinds of thing a sales-order line can be. */
export const LINE_TYPES = [
  'Composite Girder', 'BowString', 'Tub Girder', 'Openweb Girder', 'PEB',
];

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
    height: '', length: '', width: '', qty, notes, rmCode: '',
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
      rmCode: o.rmCode ?? p.rmCode ?? '',
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
