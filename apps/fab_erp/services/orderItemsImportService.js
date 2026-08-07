/**
 * orderItemsImportService.js — the order's BOM, entered as a workbook.
 *
 * Every fab job is a one-off. The same bridge does not come back for years, so
 * there is nothing to reuse from a catalog BOM — the tree is built per order,
 * the way it actually gets built on a shop floor: a spreadsheet, one sheet per
 * level, and a last sheet saying which parts get nested out of which plate.
 *
 * SHEETS
 *   Level 1, Level 2, Level 3, …   any number, read in numeric order. Project
 *                                  depth changes job to job and one branch
 *                                  routinely bottoms out three levels above
 *                                  another, so no level count is assumed.
 *   Nesting                        one raw material, and every part cut from it.
 *   Flows                          each flow and the operations inside it.
 *   Instructions
 *
 * HOW A SHEET IS FILLED, and why the columns are what they are:
 *
 *   You write a row's Item Name and its Abbr. The Code column is an Excel
 *   FORMULA — `parent code & "-" & abbr` — so the finished code appears the
 *   instant you type, with no upload in between. You then copy that cell into
 *   the next sheet's Parent Code column and write its children under it.
 *
 * That workflow is the reason codes are plain concatenation with no cleverness:
 * a code you cannot predict by eye is a code you cannot copy-paste. It is also
 * why parents are matched by CODE rather than by name. Name matching could not
 * survive real fabrication drawings, where "Top Flange" legitimately appears
 * under six different girders and twice under the same one.
 *
 * A duplicate code inside one upload is a REJECTED ROW, never silently
 * suffixed: the sheet's formula would still be showing the un-suffixed value,
 * so every child pasted underneath it would attach to the wrong parent or to
 * nothing. Better to stop and have one Abbr changed.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { recomputeOrderWeights } from './itemWeightService.js';
import {
  orderCodePrefix, composeCode, abbreviate, normaliseAbbr, materialSegment, loadUsedCodes,
} from './itemCodeService.js';

// Validation dropdowns, Code formulas and blank fill-in rows run this far down
// each sheet. Past it a user can still type; the sheet just stops assisting.
const TEMPLATE_ROWS = 500;
/** Blank level sheets emitted for a fresh order. More can be added by hand. */
const DEFAULT_LEVEL_SHEETS = 4;

// ── column layouts ───────────────────────────────────────────────────────────

const LEVEL_COLS = [
  { header: 'Parent Code',      width: 34, key: 'parentCode' },
  { header: 'Item Name *',      width: 28, key: 'name' },
  { header: 'Abbr',             width: 10, key: 'abbr' },
  { header: 'Code (auto)',      width: 38, key: 'code' },
  { header: 'Qty',              width: 8,  key: 'qty' },
  { header: 'Unit',             width: 9,  key: 'unit' },
  { header: 'Operation Flow',   width: 22, key: 'flowRef' },
  { header: 'Length',           width: 10, key: 'length' },
  { header: 'Width',            width: 10, key: 'width' },
  { header: 'Height',           width: 10, key: 'height' },
  { header: 'Unit Weight (kg)', width: 16, key: 'unitWeight' },
  { header: 'Notes',            width: 26, key: 'notes' },
];

const NEST_COLS = [
  { header: 'Raw Material Code *',  width: 24, key: 'rmCode' },
  { header: 'Parts Cut From It *',  width: 60, key: 'partCodes' },
  { header: 'Qty per Part',         width: 12, key: 'qty' },
  { header: 'Unit',                 width: 9,  key: 'unit' },
  { header: 'Notes',                width: 26, key: 'notes' },
];

const COL = Object.fromEntries(LEVEL_COLS.map((c, i) => [c.key, i + 1]));
const NCOL = Object.fromEntries(NEST_COLS.map((c, i) => [c.key, i + 1]));

/** Column letter for a 1-based index — used to build the Code formula. */
function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ── cell helpers ─────────────────────────────────────────────────────────────

function cellVal(row, col) {
  if (!col) return null;
  const c = row.getCell(col);
  if (c.value === null || c.value === undefined) return null;
  if (typeof c.value === 'object' && c.value.text !== undefined)   return String(c.value.text).trim() || null;
  if (typeof c.value === 'object' && c.value.result !== undefined) return String(c.value.result).trim() || null;
  if (typeof c.value === 'object' && c.value.formula !== undefined) return null; // formula with no cached result
  return String(c.value).trim() || null;
}

function numVal(row, col) {
  const v = cellVal(row, col);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function styledHeader(ws, cols) {
  ws.addRow(cols.map((c) => c.header));
  const row = ws.getRow(1);
  row.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height    = 20;
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 20; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/** Codes are compared exactly bar case and surrounding space. */
const codeKey = (s) => String(s ?? '').trim().toUpperCase();

/** "A, B; C" or a multi-line cell -> ['A','B','C']. */
function splitCodeList(raw) {
  return String(raw ?? '').split(/[,;\r\n]+/).map((s) => s.trim()).filter(Boolean);
}

// ── export ───────────────────────────────────────────────────────────────────

export async function exportOrderItemsTemplate(companyId, orderId) {
  const [orders] = await pool.query(
    'SELECT id, order_number FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');
  const orderNumber = orders[0].order_number;
  const prefix = await orderCodePrefix(companyId, orderId);

  const [flowRows] = await pool.query(
    `SELECT f.id, f.name, f.code,
            GROUP_CONCAT(o.name ORDER BY fs.seq_no SEPARATOR ' -> ') AS operations
       FROM fab_operation_flows f
       LEFT JOIN fab_operation_flow_steps fs
              ON fs.flow_id = f.id AND fs.company_id = f.company_id AND fs.deleted_at IS NULL
       LEFT JOIN fab_operations o
              ON o.id = fs.operation_id AND o.company_id = f.company_id AND o.deleted_at IS NULL
      WHERE f.company_id = ? AND f.active = 1 AND f.deleted_at IS NULL
      GROUP BY f.id, f.name, f.code
      ORDER BY f.name`,
    [companyId],
  );

  const [items] = await pool.query(
    `SELECT fi.id, fi.parent_item_id, fi.name, fi.code, fi.qty, fi.unit, fi.length, fi.width, fi.height,
            fi.unit_weight, fi.catalog_item_id, fic.code AS catalog_code, fof.name AS flow_name
       FROM fab_items fi
       LEFT JOIN fab_item_catalog fic ON fic.id = fi.catalog_item_id
       LEFT JOIN fab_operation_flows fof ON fof.id = fi.flow_id AND fof.deleted_at IS NULL
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
      ORDER BY fi.id`,
    [companyId, orderId],
  );

  const byId = new Map(items.map((i) => [i.id, i]));
  const depthOf = new Map();
  function depth(item) {
    if (depthOf.has(item.id)) return depthOf.get(item.id);
    depthOf.set(item.id, 0); // pre-seed: breaks a cycle instead of recursing forever
    const parent = item.parent_item_id != null ? byId.get(item.parent_item_id) : null;
    const d = parent ? depth(parent) + 1 : 0;
    depthOf.set(item.id, d);
    return d;
  }
  items.forEach(depth);

  // A raw-material link is a childless row carrying a catalog item and no flow —
  // the same shape the task gate already reads as "material to consume". It
  // belongs on the Nesting sheet, not on a Level sheet.
  const hasChild = new Set(items.filter((i) => i.parent_item_id != null).map((i) => i.parent_item_id));
  const isRmLink = (i) => !hasChild.has(i.id) && i.catalog_item_id != null && !i.flow_name;

  const levelItems = new Map();
  const rmLinks = [];
  for (const i of items) {
    if (isRmLink(i)) { rmLinks.push(i); continue; }
    const d = depthOf.get(i.id) ?? 0;
    if (!levelItems.has(d)) levelItems.set(d, []);
    levelItems.get(d).push(i);
  }

  const maxLevel = Math.max(
    DEFAULT_LEVEL_SHEETS,
    levelItems.size ? Math.max(...levelItems.keys()) + 1 : 0,
  );

  const wb = new ExcelJS.Workbook();

  // ── Instructions ─────────────────────────────────────────────────────────
  const wsHelp = wb.addWorksheet('Instructions');
  wsHelp.getColumn(1).width = 112;
  [
    `Order ${orderNumber} — item tree upload`,
    '',
    'HOW TO FILL THIS IN',
    '  1. On "Level 1", write the Item Name and a short Abbr for each top-level item.',
    '     Leave Parent Code blank — these sit at the top of the order.',
    '  2. The "Code (auto)" column fills in by itself as you type. That is this row\'s code.',
    '  3. Go to "Level 2". COPY the code of the item you want to work under, PASTE it into',
    '     Parent Code, then write the child\'s Item Name and Abbr. Its code appears the same way.',
    '  4. Keep going down. Add sheets named "Level 5", "Level 6" … if this job goes deeper —',
    '     there is no fixed number of levels, and empty sheets are ignored.',
    '',
    'ABBR',
    '  This is the part of the code that names THIS item, e.g. GRDA, TF1, WEB.',
    '  It is yours to choose — make two similar parts different here and their codes differ.',
    '  Leave it blank and one is worked out from the name, but then the Code column shows "?"',
    '  and you will not be able to copy this row as a parent. Fill it in for anything with children.',
    '',
    'PARENT CODE',
    '  Always a code copied from an earlier sheet — never a name. That is why two parts can',
    `  share a name without any confusion. Every code on this order starts with ${prefix}-`,
    '',
    'NESTING SHEET',
    '  This is where raw material comes in. One row per raw material:',
    '    Raw Material Code   the Item Catalog code of the plate/section/bar being cut',
    '    Parts Cut From It   the codes of the parts nested out of it — several per row, separated',
    '                        by commas, or one part per row repeating the material code. Either way.',
    '  This is what links material to work: when that material is received into stock, every task',
    '  waiting on it is released automatically.',
    '',
    'WEIGHT — fill it in at the bottom only',
    '  Put "Unit Weight (kg)" on the Level rows that have nothing underneath them — the cut pieces.',
    '  Everything above adds up on its own: an assembly weighs the sum of its parts x their quantity.',
    '  You may still type a weight on an assembly if you know the real figure (welds, bolts and paint',
    '  make it heavier than the sum). Yours is kept and the calculated one is shown beside it.',
    '  Unit Weight is the weight of ONE, not of the quantity on the row.',
    '',
    'LENGTH / WIDTH / HEIGHT',
    '  Fill these in on the bottom rows too — they describe a cut piece. Leave them blank once',
    '  parts are joined together; only the weight carries upward.',
    '',
    'OPERATION FLOW',
    '  Pick from the dropdown. The "Flows" sheet lists each flow and the operations inside it.',
    '  A flow name that is not recognised REJECTS the row — an item with no flow produces no work,',
    '  and it is better to fix the spelling now than to find the part was never made.',
    '',
    'QTY',
    '  How many of this item go into ONE of its parent. Defaults to 1.',
    '',
    'UPLOADING',
    '  Append  adds these rows to whatever is already on the order.',
    '  Replace clears the order\'s existing items first. Replace is refused if any task on the order',
    '          has already been started or finished, so shop-floor history cannot be thrown away.',
    '  Every upload returns a report listing each row: created, or skipped with the reason.',
    '  Two rows that produce the SAME code are both rejected — change one Abbr and re-upload.',
  ].forEach((l) => wsHelp.addRow([l]));
  wsHelp.getRow(1).font = { bold: true, size: 13 };
  wsHelp.eachRow((row, n) => {
    if (n === 1) return;
    const text = String(row.getCell(1).value ?? '');
    if (text && text === text.toUpperCase() && /[A-Z]/.test(text) && !text.startsWith(' ')) {
      row.font = { bold: true };
    }
  });

  // ── Level sheets ─────────────────────────────────────────────────────────
  for (let lvl = 0; lvl < maxLevel; lvl++) {
    const ws = wb.addWorksheet(`Level ${lvl + 1}`);
    styledHeader(ws, LEVEL_COLS);
    for (const i of levelItems.get(lvl) ?? []) {
      const parentCode = i.parent_item_id != null ? (byId.get(i.parent_item_id)?.code ?? '') : '';
      ws.addRow([
        parentCode,
        i.name,
        // Round-trip the abbreviation by reading back the code's last segment,
        // so an exported sheet shows what was actually used rather than a fresh
        // guess that might not match the frozen code.
        i.code ? String(i.code).slice(parentCode ? parentCode.length + 1 : (prefix.length + 1)) : '',
        i.code ?? '',
        i.qty != null ? Number(i.qty) : 1,
        i.unit ?? '',
        i.flow_name ?? '',
        i.length != null ? Number(i.length) : '',
        i.width != null ? Number(i.width) : '',
        i.height != null ? Number(i.height) : '',
        i.unit_weight != null ? Number(i.unit_weight) : '',
        '',
      ]);
    }
    applyCodeFormula(ws, prefix, (levelItems.get(lvl) ?? []).length);
    applyFlowDropdown(ws, flowRows.length);
  }

  // ── Nesting sheet ────────────────────────────────────────────────────────
  const wsNest = wb.addWorksheet('Nesting');
  styledHeader(wsNest, NEST_COLS);
  // Existing links read back grouped: one row per material, listing the parts.
  const byMaterial = new Map();
  for (const link of rmLinks) {
    const parentCode = link.parent_item_id != null ? byId.get(link.parent_item_id)?.code : null;
    if (!parentCode || !link.catalog_code) continue;
    if (!byMaterial.has(link.catalog_code)) byMaterial.set(link.catalog_code, { parts: [], qty: link.qty, unit: link.unit });
    byMaterial.get(link.catalog_code).parts.push(parentCode);
  }
  for (const [rmCode, g] of byMaterial) {
    wsNest.addRow([rmCode, g.parts.join(', '), g.qty != null ? Number(g.qty) : 1, g.unit ?? '', '']);
  }

  // ── Flows reference ──────────────────────────────────────────────────────
  const wsFlows = wb.addWorksheet('Flows');
  styledHeader(wsFlows, [
    { header: 'Flow Name',  width: 30 },
    { header: 'Flow Code',  width: 18 },
    { header: 'Operations', width: 80 },
  ]);
  for (const f of flowRows) wsFlows.addRow([f.name, f.code, f.operations || '(no steps defined)']);
  if (!flowRows.length) {
    wsFlows.addRow(['(no active operation flows — set them up under Operations › Flows first)', '', '']);
  }

  return wb.xlsx.writeBuffer();
}

/**
 * The Code column is a live formula, not a value. It is what makes the whole
 * top-down fill work: you see a row's code the moment you type its Abbr, and
 * paste that cell straight into the next sheet's Parent Code.
 *
 * Blank Item Name ⇒ blank code, so unused rows stay empty. Blank Abbr ⇒ a
 * visible "?" segment rather than a silently wrong code.
 */
function applyCodeFormula(ws, prefix, filledRows) {
  const P = colLetter(COL.parentCode);
  const N = colLetter(COL.name);
  const A = colLetter(COL.abbr);
  const safePrefix = prefix.replace(/"/g, '""');
  for (let r = 2; r <= TEMPLATE_ROWS; r++) {
    // Rows already carrying an exported (frozen) code keep it as a literal —
    // recomputing could disagree with what is stored and on the drawing.
    if (r - 1 <= filledRows) continue;
    ws.getCell(r, COL.code).value = {
      formula: `IF(TRIM(${N}${r})="","",IF(TRIM(${P}${r})="","${safePrefix}",TRIM(${P}${r}))&"-"&IF(TRIM(${A}${r})="","?",UPPER(TRIM(${A}${r}))))`,
    };
    ws.getCell(r, COL.code).font = { color: { argb: 'FF666666' } };
  }
}

/** List validation on the Operation Flow column, sourced from the Flows sheet. */
function applyFlowDropdown(ws, flowCount) {
  if (flowCount < 1) return;
  const source = `Flows!$A$2:$A$${flowCount + 1}`;
  for (let r = 2; r <= TEMPLATE_ROWS; r++) {
    ws.getCell(r, COL.flowRef).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [source],
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: 'Unknown flow',
      error: 'Pick a flow from the "Flows" sheet. An unrecognised flow will reject the row on upload.',
    };
  }
}

// ── import report ────────────────────────────────────────────────────────────

async function buildImportReport(rowLog) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import Log');
  styledHeader(ws, [
    { header: 'Sheet',       width: 14 },
    { header: 'Row',         width: 7 },
    { header: 'Parent Code', width: 32 },
    { header: 'Item Name',   width: 24 },
    { header: 'Code',        width: 34 },
    { header: 'Status',      width: 11 },
    { header: 'Reason',      width: 60 },
  ]);
  for (const r of rowLog) {
    ws.addRow([r.sheet, r.row, r.parentCode, r.name, r.code ?? '', r.status, r.reason]);
    const fill = r.status === 'Created'
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
    ws.lastRow.eachCell((cell) => { cell.fill = fill; });
  }
  return wb.xlsx.writeBuffer();
}

// ── sheet discovery + parsing ────────────────────────────────────────────────

function orderedSheets(wb) {
  const levels = [];
  let nesting = null;
  wb.eachSheet((ws) => {
    const m = /^level\s*(\d+)$/i.exec(ws.name.trim());
    if (m) { levels.push({ ws, level: Number(m[1]) }); return; }
    // "Raw Material" still accepted — it is what the previous template called it.
    if (/^(nesting|raw\s*materials?)$/i.test(ws.name.trim())) nesting = ws;
  });
  levels.sort((a, b) => a.level - b.level); // numeric: "Level 10" after "Level 9"
  const out = levels.map((l) => ({ ws: l.ws, kind: 'level' }));
  if (nesting) out.push({ ws: nesting, kind: 'nesting' });
  return out;
}

function parseLevelSheet(ws) {
  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = cellVal(row, COL.name);
    const parentCode = cellVal(row, COL.parentCode);
    if (!name && !parentCode) return;
    rows.push({
      sheet: ws.name, kind: 'level', row: rowNumber,
      parentCode: parentCode ?? '',
      name: name ?? '',
      abbr:       cellVal(row, COL.abbr),
      qty:        numVal(row, COL.qty),
      unit:       cellVal(row, COL.unit),
      flowRef:    cellVal(row, COL.flowRef),
      length:     numVal(row, COL.length),
      width:      numVal(row, COL.width),
      height:     numVal(row, COL.height),
      unitWeight: numVal(row, COL.unitWeight),
    });
  });
  return rows;
}

function parseNestingSheet(ws) {
  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const rmCode = cellVal(row, NCOL.rmCode);
    const parts  = cellVal(row, NCOL.partCodes);
    if (!rmCode && !parts) return;
    rows.push({
      sheet: ws.name, kind: 'nesting', row: rowNumber,
      rmCode: rmCode ?? '',
      partCodes: splitCodeList(parts),
      qty:  numVal(row, NCOL.qty),
      unit: cellVal(row, NCOL.unit),
    });
  });
  return rows;
}

// ── import ───────────────────────────────────────────────────────────────────

/**
 * @param {{path:string}} file        uploaded .xlsx (deleted once read)
 * @param {'append'|'replace'} mode
 */
export async function importOrderItemsExcel(file, companyId, orderId, mode = 'append') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const sheets = orderedSheets(wb);
  if (!sheets.some((s) => s.kind === 'level')) {
    throw new Error('No "Level 1" sheet found in the uploaded file. Download the template from this order and fill that in.');
  }

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
        + 'Replacing the item tree would throw that shop-floor history away. Import with Append, or '
        + 'correct the affected items directly on the Items / BOM tab.',
      );
    }
  }

  const levelRows = sheets.filter((s) => s.kind === 'level').flatMap((s) => parseLevelSheet(s.ws));
  const nestRows  = sheets.filter((s) => s.kind === 'nesting').flatMap((s) => parseNestingSheet(s.ws));

  const result = {
    mode,
    itemsCreated: 0, itemsSkipped: 0, itemsDeleted: 0,
    nestingLinks: 0,
    totalWeight: null, unweighedLeaves: 0,
    warnings: [],
  };

  if (!levelRows.length && !nestRows.length) {
    result.warnings.push({ message: 'The uploaded workbook had no filled-in rows on any Level or Nesting sheet.' });
    return result;
  }

  const conn = await pool.getConnection();
  const rowLog = [];
  const byCode = new Map(); // code key -> fab_items.id

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
      for (const e of existing) byCode.set(codeKey(e.code), e.id);
    }

    const usedCodes = await loadUsedCodes(companyId, conn);

    const [catalogItems] = await conn.query(
      'SELECT id, code, name, unit FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const catalogByCode = new Map(catalogItems.map((c) => [codeKey(c.code), c]));

    const [flows] = await conn.query(
      `SELECT id, name, code FROM fab_operation_flows
        WHERE company_id = ? AND active = 1 AND deleted_at IS NULL`,
      [companyId],
    );
    const flowByNameOrCode = new Map();
    for (const f of flows) {
      flowByNameOrCode.set(codeKey(f.name), f.id);
      if (f.code) flowByNameOrCode.set(codeKey(f.code), f.id);
    }

    // ── Level sheets: the tree itself ──────────────────────────────────────
    for (const r of levelRows) {
      const base = { sheet: r.sheet, row: r.row, parentCode: r.parentCode, name: r.name, code: null };
      const skip = (reason) => { rowLog.push({ ...base, status: 'Skipped', reason }); result.itemsSkipped++; };

      if (!r.name) { skip('Item Name is required.'); continue; }

      // parent — by CODE, never by name
      let parentItemId = null;
      let parentCode = prefix;
      if (r.parentCode) {
        const hit = byCode.get(codeKey(r.parentCode));
        if (!hit) {
          skip(`Parent Code '${r.parentCode}' does not match any item — copy the code from the "Code (auto)" column of the sheet above. If that row was itself rejected, fix it first.`);
          continue;
        }
        parentItemId = hit;
        parentCode = r.parentCode.trim();
      }

      const abbr = normaliseAbbr(r.abbr) ?? abbreviate(r.name);
      const code = composeCode(parentCode, abbr);
      base.code = code;

      // A duplicate is rejected, not suffixed: the sheet's Code formula would
      // still be showing the un-suffixed value, so anything pasted underneath
      // it would attach to the wrong parent.
      if (byCode.has(codeKey(code)) || usedCodes.has(code)) {
        skip(`Code '${code}' is already in use. Give this row a different Abbr — two rows cannot share a code, and children are attached by pasting it.`);
        continue;
      }

      let flowId = null;
      if (r.flowRef) {
        flowId = flowByNameOrCode.get(codeKey(r.flowRef)) ?? null;
        if (!flowId) {
          skip(`Operation Flow '${r.flowRef}' is not an active flow. Pick one from the "Flows" sheet — an item with no flow produces no tasks at all.`);
          continue;
        }
      }

      const [ins] = await conn.query(
        `INSERT INTO fab_items
           (company_id, order_id, parent_item_id, catalog_item_id, name, unit, qty, flow_id,
            length, width, height, unit_weight, code)
         VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
        [companyId, orderId, parentItemId, r.name.trim(), r.unit || 'pcs',
          r.qty ?? 1, flowId, r.length, r.width, r.height, r.unitWeight, code],
      );
      byCode.set(codeKey(code), ins.insertId);
      usedCodes.add(code);
      rowLog.push({ ...base, status: 'Created', reason: '' });
      result.itemsCreated++;
    }

    // ── Nesting sheet: one material, the parts cut from it ─────────────────
    // Each (material, part) pair becomes a child row under that part carrying
    // the catalog item and no flow — exactly the shape taskGatingService reads
    // as "material to consume", which is what makes stock receipt release the
    // waiting tasks automatically.
    for (const r of nestRows) {
      const base = { sheet: r.sheet, row: r.row, parentCode: '', name: r.rmCode, code: null };
      const skip = (reason) => { rowLog.push({ ...base, status: 'Skipped', reason }); result.itemsSkipped++; };

      if (!r.rmCode) { skip('Raw Material Code is required.'); continue; }
      const material = catalogByCode.get(codeKey(r.rmCode));
      if (!material) { skip(`Raw Material Code '${r.rmCode}' is not in the Item Catalog.`); continue; }
      if (!r.partCodes.length) { skip('List at least one part code under "Parts Cut From It".'); continue; }

      const rmAbbr = materialSegment(material.code, material.name);

      for (const partCode of r.partCodes) {
        const partBase = { ...base, parentCode: partCode };
        const partId = byCode.get(codeKey(partCode));
        if (!partId) {
          rowLog.push({ ...partBase, status: 'Skipped', reason: `Part code '${partCode}' does not match any item on this order.` });
          result.itemsSkipped++;
          continue;
        }
        const code = composeCode(partCode.trim(), rmAbbr);
        if (byCode.has(codeKey(code)) || usedCodes.has(code)) {
          rowLog.push({ ...partBase, status: 'Skipped', code, reason: `'${material.code}' is already nested onto part '${partCode}'.` });
          result.itemsSkipped++;
          continue;
        }
        const [ins] = await conn.query(
          `INSERT INTO fab_items
             (company_id, order_id, parent_item_id, catalog_item_id, name, unit, qty, flow_id, code)
           VALUES (?,?,?,?,?,?,?,NULL,?)`,
          [companyId, orderId, partId, material.id, material.name,
            r.unit || material.unit || 'pcs', r.qty ?? 1, code],
        );
        byCode.set(codeKey(code), ins.insertId);
        usedCodes.add(code);
        rowLog.push({ ...partBase, status: 'Created', code, reason: `Nested from ${material.code}` });
        result.nestingLinks++;
      }
    }

    const weights = await recomputeOrderWeights(companyId, orderId, conn);
    result.totalWeight = weights.totalWeight;
    result.unweighedLeaves = weights.unweighedLeaves;

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  if (result.unweighedLeaves > 0) {
    result.warnings.push({
      message: `${result.unweighedLeaves} bottom-level item(s) have no weight, so the order total is incomplete. `
        + 'Fill in "Unit Weight (kg)" on those rows and re-upload, or type it on the Items / BOM tab.',
    });
  }

  // Per-row detail ships as the downloadable report, not as JSON — a 2000-row
  // tree would otherwise put a megabyte of log into the browser for a banner
  // that quotes two numbers from it.
  rowLog.sort((a, b) => (a.sheet === b.sheet ? a.row - b.row : a.sheet.localeCompare(b.sheet, undefined, { numeric: true })));
  result.reportBase64 = (await buildImportReport(rowLog)).toString('base64');
  return result;
}
