/**
 * structureSheetService.js — the structure as a spreadsheet, and back.
 *
 * ── WHY THIS IS NOT THE OLD BOQ SHEET ────────────────────────────────────────
 *
 * That one had four code columns — Span / Girder / Segment / Part — and the
 * codes WERE the structure: you repeated the span and girder down the rows and
 * the levels were inferred. It was retired because both halves of that are gone.
 * Codes are no longer minted at BOM time, and a row is a DESIGN with a quantity
 * rather than one piece, so a sheet that wanted one line per piece would have
 * asked for 1,276 rows to say what 32 now say.
 *
 * ── THE SHEET ────────────────────────────────────────────────────────────────
 *
 *   Level | Item | Qty | Unit | Thickness | Width | Length
 *
 * LEVEL IS THE STRUCTURE. 0 is the top, and a row's parent is the nearest row
 * above it one level shallower — which is how a bill of materials is written on
 * paper, and it survives a person inserting a row in the middle without them
 * having to renumber anything. The alternative, a parent-id column, is exact
 * and unreadable, and nobody would edit it by hand without breaking it.
 *
 * A LEVEL THAT JUMPS IS REFUSED, not guessed. Going 1 -> 3 means a row was
 * deleted or mis-indented, and either way the tree somebody gets back is not
 * the one they meant. Silently reparenting it to the nearest ancestor is how
 * you end up with a top flange inside a splice.
 *
 * ITEMS ARE MATCHED BY NAME, then code. The name is what a person reading the
 * sheet sees and edits; the code is the fallback for anything renamed since the
 * export. A name that matches nothing is refused with the row number — inventing
 * a catalog item from a typo is how the catalog fills with "Top Flnage".
 *
 * DIMENSIONS RIDE ALONG because this is the one place somebody can fill in three
 * hundred of them without three hundred clicks — the same reason the parameters
 * grid has a sheet. They are optional; a blank leaves whatever is already there.
 */

import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { NOT_A_BLANK } from './blankPredicate.js';
import { cellVal, numVal } from './excelHelpers.js';
import { currentTree, applyTree } from './bomService.js';

const SHEET = 'Structure';
const HEADERS = ['Level', 'Item', 'Qty', 'Unit', 'Thickness (mm)', 'Width (mm)', 'Length (mm)'];

/** The dimension columns, in sheet order, paired with their field key. */
const DIM_COLS = [
  { col: 5, key: 'thickness_mm' },
  { col: 6, key: 'width_mm' },
  { col: 7, key: 'length_mm' },
];

/**
 * Depth-first, parents before children — the order somebody reads a BOM in, and
 * the order the importer needs to resolve a parent before its child.
 */
function flatten(rows) {
  const kids = new Map();
  for (const r of rows) {
    const k = r.parentItemId == null ? 'root' : String(r.parentItemId);
    kids.set(k, [...(kids.get(k) ?? []), r]);
  }
  const out = [];
  const walk = (key, depth) => {
    for (const r of kids.get(key) ?? []) {
      out.push({ ...r, level: depth });
      walk(String(r.id), depth + 1);
    }
  };
  walk('root', 0);
  return out;
}

export async function exportStructure(companyId, orderId) {
  const [[order]] = await pool.query(
    'SELECT order_number AS orderNumber FROM fab_orders WHERE id = ? AND company_id = ?',
    [orderId, companyId],
  );

  const [rows] = await pool.query(
    `SELECT i.id, i.parent_item_id AS parentItemId, i.name, i.unit, i.qty,
            c.name AS catalogName, c.code AS catalogCode
       FROM fab_items i
       LEFT JOIN fab_item_catalog c ON c.id = i.catalog_item_id AND c.deleted_at IS NULL
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND NOT i.node_kind = 'material'
        AND ${NOT_A_BLANK('i')}
      ORDER BY i.id`,
    [companyId, orderId],
  );

  // Dimensions as they stand, so an export is a starting point rather than a
  // blank form somebody has to fill in from another window.
  const [vals] = rows.length ? await pool.query(
    `SELECT v.scope_id AS itemId, f.field_key AS k, v.value_num AS n
       FROM fab_field_values v
       JOIN fab_fields f ON f.id = v.field_id
      WHERE v.company_id = ? AND v.scope = 'order_item' AND v.scope_id IN (?)
        AND v.deleted_at IS NULL
        AND f.field_key IN ('thickness_mm','width_mm','length_mm')`,
    [companyId, rows.map((r) => r.id)],
  ) : [[]];
  const dims = new Map();
  for (const v of vals) {
    const e = dims.get(Number(v.itemId)) ?? {};
    e[v.k] = v.n == null ? null : Number(v.n);
    dims.set(Number(v.itemId), e);
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET);

  ws.addRow([`Structure — ${order?.orderNumber ?? orderId}`]);
  ws.addRow(['Level is the structure: 0 is the top, and a row belongs to the nearest row above it one level shallower.']);
  ws.addRow(['Change quantities, add rows, delete rows. Item names must match the catalogue. Dimensions are optional.']);
  ws.addRow([]);
  ws.getRow(1).font = { bold: true, size: 13 };
  ws.getRow(2).font = { size: 10, italic: true };
  ws.getRow(3).font = { size: 10, italic: true };

  const head = ws.addRow(HEADERS);
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }; });

  for (const r of flatten(rows)) {
    const d = dims.get(Number(r.id)) ?? {};
    const row = ws.addRow([
      r.level,
      r.catalogName ?? r.name,
      Number(r.qty),
      r.unit ?? '',
      d.thickness_mm ?? '',
      d.width_mm ?? '',
      d.length_mm ?? '',
    ]);
    // Indented so the shape is visible at a glance; the LEVEL column is what is
    // actually read back, so an indent somebody loses costs nothing.
    row.getCell(2).alignment = { indent: r.level * 2 };
  }

  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 42;
  ws.getColumn(3).width = 10;
  ws.getColumn(4).width = 8;
  for (const { col } of DIM_COLS) ws.getColumn(col).width = 15;

  return { buffer: await wb.xlsx.writeBuffer(), filename: `Structure_${order?.orderNumber ?? orderId}.xlsx` };
}

/**
 * Read a filled sheet back into a tree, then hand it to the same writer the
 * editor uses.
 *
 * NOTHING IS WRITTEN UNTIL THE WHOLE SHEET PARSES. A structure half-imported
 * because row 180 named an item that does not exist is worse than one not
 * imported at all: the order looks built, and the missing branch is only found
 * by someone counting.
 */
export async function importStructure(companyId, orderId, buffer, opts = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(SHEET) ?? wb.worksheets[0];
  if (!ws) { const e = new Error('That file has no sheets.'); e.status = 400; throw e; }

  // The header row is found rather than assumed: people add notes above it.
  let headerRow = 0;
  ws.eachRow((row, n) => {
    if (headerRow) return;
    if ((cellVal(row, 1) ?? '').toLowerCase() === 'level') headerRow = n;
  });
  if (!headerRow) {
    const e = new Error('No header row found — the first column of the header must read "Level".');
    e.status = 400; throw e;
  }

  const [catalog] = await pool.query(
    `SELECT id, name, code, unit FROM fab_item_catalog
      WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const byName = new Map(catalog.map((c) => [String(c.name).trim().toLowerCase(), c]));
  const byCode = new Map(catalog.filter((c) => c.code).map((c) => [String(c.code).trim().toLowerCase(), c]));

  // Columns are matched by header TEXT, not position: a reordered or
  // inserted column must be caught as a problem rather than silently reading
  // Qty into Level (mirrors orderParametersService.importParameters).
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const HEADER_KEYS = [
    ['level', 'Level'], ['item', 'Item'], ['qty', 'Qty'], ['unit', 'Unit'],
    ['thickness_mm', 'Thickness (mm)'], ['width_mm', 'Width (mm)'], ['length_mm', 'Length (mm)'],
  ];
  const keyByLabel = new Map(HEADER_KEYS.map(([key, label]) => [norm(label), key]));
  const colOf = {};
  const problems = [];
  const headerRowCells = ws.getRow(headerRow);
  for (let i = 1; i <= headerRowCells.cellCount; i += 1) {
    const label = cellVal(headerRowCells, i);
    if (label == null || label === '') continue;
    const key = keyByLabel.get(norm(label));
    if (!key) {
      problems.push({ row: headerRow, code: 'UNKNOWN_HEADER', message: `Column ${i} ("${label}") is not a column this sheet expects — skipped.` });
      continue;
    }
    colOf[key] = i;
  }
  if (!colOf.level || !colOf.item) {
    const e = new Error('The header row must have both a "Level" and an "Item" column.');
    e.status = 400; e.code = 'STRUCTURE_SHEET_INVALID';
    e.problems = [{ row: headerRow, code: 'MISSING_HEADER', message: e.message }];
    throw e;
  }

  const parsed = [];
  ws.eachRow((row, n) => {
    if (n <= headerRow) return;
    const rawLevel = cellVal(row, colOf.level);
    const rawItem = cellVal(row, colOf.item) ?? '';
    if (rawLevel == null && !rawItem) return;      // a blank spacer row

    const level = Number(rawLevel);
    if (!Number.isInteger(level) || level < 0) {
      problems.push({ row: n, code: 'BAD_LEVEL', message: `Row ${n}: level "${rawLevel}" is not a whole number.` }); return;
    }
    if (!rawItem) { problems.push({ row: n, code: 'MISSING_ITEM', message: `Row ${n}: no item name.` }); return; }

    const hit = byName.get(rawItem.toLowerCase()) ?? byCode.get(rawItem.toLowerCase());
    if (!hit) { problems.push({ row: n, code: 'UNKNOWN_ITEM', message: `Row ${n}: "${rawItem}" is not in the catalogue.` }); return; }

    const qty = colOf.qty ? numVal(row, colOf.qty) : NaN;
    const dims = {};
    for (const [key] of HEADER_KEYS.slice(4)) {
      const col = colOf[key];
      if (!col) continue;
      const num = numVal(row, col);
      if (num !== null) dims[key] = num;
    }
    parsed.push({
      rowNo: n,
      level,
      catalogItemId: Number(hit.id),
      name: hit.name,
      unit: (colOf.unit ? cellVal(row, colOf.unit) : null) || hit.unit || 'nos',
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      dims,
    });
  });

  if (!parsed.length && !problems.length) {
    const e = new Error('That sheet has no rows under the header.'); e.status = 400; throw e;
  }
  if (parsed.length && parsed[0].level !== 0) {
    problems.push({ row: parsed[0].rowNo, code: 'LEVEL_NOT_ZERO', message: `Row ${parsed[0].rowNo}: the first row must be level 0 — it is the thing being built.` });
  }
  for (let i = 1; i < parsed.length; i += 1) {
    const jump = parsed[i].level - parsed[i - 1].level;
    if (jump > 1) {
      problems.push({
        row: parsed[i].rowNo,
        code: 'LEVEL_JUMP',
        message: `Row ${parsed[i].rowNo}: level jumps from ${parsed[i - 1].level} to ${parsed[i].level}.`
          + ' A row can only be one level deeper than the row above it.',
      });
    }
  }
  const roots = parsed.filter((p) => p.level === 0);
  for (const r of roots.slice(1)) {
    problems.push({ row: r.rowNo, code: 'MULTIPLE_ROOTS', message: `Row ${r.rowNo}: more than one level 0 row — a structure has a single top.` });
  }
  if (problems.length) {
    const e = new Error(`${problems.length} problem${problems.length === 1 ? '' : 's'} in the sheet`);
    e.status = 400; e.code = 'STRUCTURE_SHEET_INVALID'; e.problems = problems; throw e;
  }

  // Level column -> nested tree. The stack holds the current ancestor per level.
  let seq = 0;
  const stack = [];
  let root = null;
  for (const p of parsed) {
    const node = {
      key: `x${++seq}`,
      catalogItemId: p.catalogItemId,
      name: p.name,
      unit: p.unit,
      qty: p.qty,
      codeSegment: null,
      codeJoin: 'dash',
      defaultFlowId: null,
      bomLineId: null,
      qtyParam: null,
      dims: p.dims,
      children: [],
    };
    if (p.level === 0) { root = node; stack.length = 0; stack[0] = node; continue; }
    const parent = stack[p.level - 1];
    if (!parent) { const e = new Error(`Row ${p.rowNo}: nothing above it to belong to.`); e.status = 400; throw e; }
    parent.children.push(node);
    stack[p.level] = node;
    stack.length = p.level + 1;
  }

  return { tree: root, rows: parsed.length, dimsGiven: parsed.filter((p) => Object.keys(p.dims).length).length, opts };
}


/* ───────────────────────── one LINE's structure, as a diff ─────────────────────────
 *
 * The export/import pair above is the whole-order, LEVEL-indented sheet that
 * REPLACES the structure (`buildFromTree`). This pair is the wizard's
 * per-line round trip: download one line's tree, edit it in Excel, upload it
 * back, and the server applies it as a DIFF through `applyTree` — the same
 * writer the structure editor's Save changes uses. A row keeps its id, so it
 * keeps its sizes, its nested plate and its tasks.
 *
 *   Row id | Parent row id | Level | Item code | Name | Qty | Thickness (mm) |
 *   Width (mm) | Length (mm) | Material | Grade | Flow | Make/Buy
 *
 * ROW ID IS THE IDENTITY. Keep it to edit a row; blank it (or write a
 * temporary handle like "new1") to add one; delete the row from the sheet to
 * remove it and everything under it. Parent row id names the parent — an
 * existing Row id, a temporary handle, or ROOT (blank also means ROOT).
 * Level is written for reading and ignored on the way back in.
 */

const LINE_SHEET = 'Structure';
const LINE_HEADERS = [
  'Row id', 'Parent row id', 'Level', 'Item code', 'Name', 'Qty',
  'Thickness (mm)', 'Width (mm)', 'Length (mm)', 'Material', 'Grade', 'Flow', 'Make/Buy',
];
const LINE_WIDTHS = [10, 14, 7, 20, 40, 8, 14, 12, 12, 12, 10, 34, 11];

const normKey = (s) => String(s ?? '').trim().toLowerCase();

/** Header label (lower-cased) → key. Aliases are accepted so "Thickness" alone still reads. */
const LINE_HEADER_KEYS = new Map([
  ['row id', 'rowId'], ['id', 'rowId'],
  ['parent row id', 'parentId'], ['parent', 'parentId'], ['parent id', 'parentId'],
  ['level', 'level'],
  ['item code', 'itemCode'], ['code', 'itemCode'], ['catalog code', 'itemCode'],
  ['name', 'name'], ['item', 'name'],
  ['qty', 'qty'], ['quantity', 'qty'],
  ['thickness (mm)', 'thickness_mm'], ['thickness', 'thickness_mm'],
  ['width (mm)', 'width_mm'], ['width', 'width_mm'],
  ['length (mm)', 'length_mm'], ['length', 'length_mm'],
  ['material', 'material'], ['grade', 'grade'],
  ['flow', 'flow'], ['flow name', 'flow'],
  ['make/buy', 'procurement'], ['make / buy', 'procurement'], ['procurement', 'procurement'],
]);

const PROCUREMENT = new Map([
  ['make', 'make'], ['made', 'make'], ['m', 'make'],
  ['buy', 'buy'], ['bought', 'buy'], ['b', 'buy'],
  ['free issue', 'free_issue'], ['free_issue', 'free_issue'], ['free-issue', 'free_issue'], ['freeissue', 'free_issue'],
]);

async function lineHeader(companyId, orderId, orderLineId, exec = pool) {
  const [[order]] = await exec.query(
    'SELECT order_number AS orderNumber, status FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!order) { const e = new Error('Order not found.'); e.status = 404; throw e; }
  const [[line]] = await exec.query(
    `SELECT id, line_no AS lineNo, description FROM fab_order_lines
      WHERE id = ? AND order_id = ? AND company_id = ? AND deleted_at IS NULL`,
    [orderLineId, orderId, companyId],
  );
  if (!line) { const e = new Error('Order line not found on this order.'); e.status = 404; throw e; }
  return { order, line };
}

async function flowsFor(companyId, exec = pool) {
  const [flows] = await exec.query(
    'SELECT id, name FROM fab_operation_flows WHERE company_id = ? AND deleted_at IS NULL',
    [companyId],
  );
  return flows;
}

/** Depth-first rows under the line root — the root itself is the line, not a row. */
function flattenLine(tree) {
  const out = [];
  const walk = (node, parentItemId, depth) => {
    for (const child of node.children ?? []) {
      out.push({ node: child, parentItemId, depth });
      walk(child, child.itemId, depth + 1);
    }
  };
  walk(tree, null, 1);
  return out;
}

/**
 * exportLineStructure — one line's rows as a sheet somebody can edit.
 *
 * @returns {Promise<{buffer: Buffer, filename: string}>}
 */
export async function exportLineStructure(companyId, orderId, orderLineId) {
  if (!orderLineId) { const e = new Error('orderLineId is required.'); e.status = 400; throw e; }
  const { order, line } = await lineHeader(companyId, orderId, orderLineId);
  const tree = await currentTree(companyId, orderId, orderLineId);
  if (!tree) { const e = new Error('Nothing is built under this line yet.'); e.status = 404; throw e; }
  const flowName = new Map((await flowsFor(companyId)).map((f) => [Number(f.id), f.name]));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(LINE_SHEET);

  ws.addRow([`Structure — ${order.orderNumber} / line ${line.lineNo} ${line.description ?? ''}`.trim()]);
  ws.addRow(['Keep Row id to edit a row. Leave Row id blank (or write a handle like new1) to add a row: set Parent row id to an existing Row id, a handle, or ROOT, and Item code to a catalog code.']);
  ws.addRow(['Delete a row from the sheet to remove it and everything under it. Level is for reading only.']);
  ws.addRow(['Qty is required. Sizes, Material, Grade and Flow are optional per row — blank leaves the row as it is. Make/Buy comes from the catalog item.']);
  ws.addRow([]);
  ws.getRow(1).font = { bold: true, size: 13 };
  for (const n of [2, 3, 4]) ws.getRow(n).font = { size: 10, italic: true };

  const head = ws.addRow(LINE_HEADERS);
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }; });
  ws.views = [{ state: 'frozen', ySplit: head.number }];

  const rootId = Number(tree.itemId);
  for (const { node, parentItemId, depth } of flattenLine(tree)) {
    const d = node.dims ?? {};
    const row = ws.addRow([
      Number(node.itemId),
      parentItemId == null || Number(parentItemId) === rootId ? '' : Number(parentItemId),
      depth,
      node.catalogCode ?? '',
      node.name ?? '',
      Number(node.qty),
      d.thickness_mm ?? '',
      d.width_mm ?? '',
      d.length_mm ?? '',
      d.material ?? '',
      d.grade ?? '',
      node.defaultFlowId == null ? '' : (flowName.get(Number(node.defaultFlowId)) ?? String(node.defaultFlowId)),
      node.procurementType ?? 'make',
    ]);
    row.getCell(5).alignment = { indent: (depth - 1) * 2 };
  }
  LINE_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '_');
  return {
    buffer: await wb.xlsx.writeBuffer(),
    filename: `Structure_${safe(order.orderNumber)}_line${line.lineNo}.xlsx`,
  };
}

/**
 * importLineStructure — read an edited sheet back and apply it as a diff.
 *
 * EVERYTHING IS VALIDATED BEFORE ANYTHING IS WRITTEN. A bad row anywhere
 * refuses the whole sheet with a 422 that names every problem, so a person
 * fixes them all at once rather than one upload at a time.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.revisionReason]  required by applyTree on a non-draft order
 * @param {number|null} [opts.userId]
 * @param {import('mysql2/promise').PoolConnection|null} [opts.conn]  caller-owned transaction
 * @returns {Promise<{created:number, updated:number, removed:number, sized:number, rows:number}>}
 */
export async function importLineStructure(companyId, orderId, orderLineId, buffer, opts = {}) {
  const { revisionReason = null, userId = null, conn = null } = opts;
  const exec = conn ?? pool;
  if (!orderLineId) { const e = new Error('orderLineId is required.'); e.status = 400; throw e; }
  await lineHeader(companyId, orderId, orderLineId, exec);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(LINE_SHEET) ?? wb.worksheets[0];
  if (!ws) { const e = new Error('That file has no sheets.'); e.status = 422; throw e; }

  // The header row is found, not assumed: people add notes above it.
  let headerRow = 0;
  ws.eachRow((row, n) => {
    if (headerRow) return;
    if (LINE_HEADER_KEYS.get(normKey(cellVal(row, 1))) === 'rowId') headerRow = n;
  });
  if (!headerRow) {
    const e = new Error('No header row found — the first column of the header must read "Row id".');
    e.status = 422; e.detail = { problems: [e.message] }; throw e;
  }
  const colOf = {};
  ws.getRow(headerRow).eachCell((cell, c) => {
    const key = LINE_HEADER_KEYS.get(normKey(cell.value));
    if (key && colOf[key] == null) colOf[key] = c;
  });
  const missing = ['rowId', 'parentId', 'qty'].filter((k) => !colOf[k]);
  if (!colOf.itemCode && !colOf.name) missing.push('itemCode');
  if (missing.length) {
    const e = new Error('The header must have Row id, Parent row id, Qty and Item code (or Name) columns.');
    e.status = 422; e.detail = { problems: [e.message] }; throw e;
  }

  // What the line holds now — the ids a Row id may name, and what an
  // unchanged column keeps.
  const tree = await currentTree(companyId, orderId, orderLineId, conn);
  if (!tree) { const e = new Error('Nothing is built under this line yet — build it before uploading a sheet.'); e.status = 422; throw e; }
  const rootId = Number(tree.itemId);
  const existingById = new Map();
  for (const { node } of flattenLine(tree)) existingById.set(Number(node.itemId), node);

  const [catalog] = await exec.query(
    `SELECT id, name, code, unit, COALESCE(procurement_type, 'make') AS procurement
       FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const catByCode = new Map(catalog.filter((c) => c.code).map((c) => [normKey(c.code), c]));
  const catByName = new Map(catalog.map((c) => [normKey(c.name), c]));
  const flows = await flowsFor(companyId, exec);
  const flowByName = new Map(flows.map((f) => [normKey(f.name), Number(f.id)]));
  const flowIds = new Set(flows.map((f) => Number(f.id)));

  const problems = [];
  const bad = (n, msg) => problems.push(`Row ${n}: ${msg}`);
  const isNumeric = (s) => /^\d+$/.test(String(s));

  /** Parsed sheet rows in order; `handle` is the key other rows' Parent may name. */
  const parsed = [];
  const handles = new Map();      // handle (lower-cased) → parsed row
  ws.eachRow((row, n) => {
    if (n <= headerRow) return;
    const text = (k) => (colOf[k] ? cellVal(row, colOf[k]) : null);
    const rawId = text('rowId');
    const rawParent = text('parentId');
    const rawCode = text('itemCode');
    const rawName = text('name');
    const rawQty = colOf.qty ? numVal(row, colOf.qty) : null;
    if (rawId == null && rawParent == null && rawCode == null && rawName == null && rawQty == null) return; // spacer

    const p = {
      n, existing: null, handle: null, catalog: null, name: null, qty: rawQty,
      parentRaw: rawParent, parent: null, dims: {}, flowId: undefined, procurement: null,
    };

    if (rawId != null && isNumeric(rawId)) {
      const id = Number(rawId);
      if (id === rootId) { bad(n, `Row id ${id} is the line itself — it cannot be a row of the sheet.`); return; }
      const ex = existingById.get(id);
      if (!ex) { bad(n, `Row id ${id} is not a row on this order line.`); return; }
      p.existing = ex;
      p.handle = String(id);
      if (rawCode && ex.catalogCode && normKey(rawCode) !== normKey(ex.catalogCode)) {
        bad(n, `Item code changed on existing row ${id} (${ex.catalogCode} → ${rawCode}). Delete the row and add a new one instead.`);
        return;
      }
      p.name = rawName ?? ex.name;
    } else {
      if (rawId != null) p.handle = String(rawId);
      const lookup = rawCode ?? rawName;
      const hit = lookup ? (catByCode.get(normKey(lookup)) ?? catByName.get(normKey(lookup))) : null;
      if (!hit) {
        bad(n, lookup ? `"${lookup}" is not a catalog item code or name.` : 'a new row needs an Item code.');
        return;
      }
      p.catalog = hit;
      p.name = rawName ?? hit.name;
    }
    if (p.handle != null) {
      const hk = normKey(p.handle);
      if (handles.has(hk)) { bad(n, `Row id "${p.handle}" appears more than once.`); return; }
      handles.set(hk, p);
    }

    if (!(Number.isFinite(p.qty) && p.qty > 0)) { bad(n, `Qty must be a positive number (got "${text('qty') ?? ''}").`); return; }

    for (const k of ['thickness_mm', 'width_mm', 'length_mm']) {
      if (!colOf[k]) continue;
      const raw = text(k);
      if (raw == null) continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) { bad(n, `${k.replace('_mm', '')} "${raw}" is not a number.`); return; }
      p.dims[k] = num;
    }
    for (const k of ['material', 'grade']) {
      const raw = text(k);
      if (raw != null) p.dims[k] = raw;
    }

    const rawFlow = text('flow');
    if (rawFlow != null) {
      const id = isNumeric(rawFlow) ? Number(rawFlow) : flowByName.get(normKey(rawFlow));
      if (id == null || !flowIds.has(id)) { bad(n, `Flow "${rawFlow}" is not a flow of this company.`); return; }
      p.flowId = id;
    }

    const rawProc = text('procurement');
    if (rawProc != null) {
      const v = PROCUREMENT.get(normKey(rawProc));
      if (!v) { bad(n, `Make/Buy "${rawProc}" must be make, buy or free issue.`); return; }
      p.procurement = v;
    }
    parsed.push(p);
  });

  // Parents: an existing Row id IN THE SHEET, a handle, ROOT, or blank.
  for (const p of parsed) {
    const raw = p.parentRaw;
    if (raw == null || normKey(raw) === 'root' || (isNumeric(raw) && Number(raw) === rootId)) { p.parent = null; continue; }
    const target = handles.get(normKey(raw));
    if (!target) {
      bad(p.n, isNumeric(raw) && existingById.has(Number(raw))
        ? `Parent row id ${raw} is not in the sheet — a row that is not in the sheet is removed, so nothing can sit under it.`
        : `Parent row id "${raw}" does not match any Row id in the sheet.`);
      continue;
    }
    if (target === p) { bad(p.n, 'a row cannot be its own parent.'); continue; }
    p.parent = target;
  }
  // Every row must reach ROOT: a loop (A under B under A) would never be written.
  for (const p of parsed) {
    const seen = new Set();
    let cur = p;
    while (cur && cur.parent) {
      if (seen.has(cur)) { bad(p.n, 'its parents loop back on themselves.'); break; }
      seen.add(cur);
      cur = cur.parent;
    }
  }

  if (problems.length) {
    const e = new Error(`${problems.length} problem${problems.length === 1 ? '' : 's'} in the sheet — nothing was changed.`);
    e.status = 422; e.code = 'STRUCTURE_SHEET_INVALID'; e.detail = { problems }; throw e;
  }
  if (!parsed.length) {
    const e = new Error('That sheet has no rows under the header — to remove every row, delete them in the editor instead.');
    e.status = 422; e.detail = { problems: [e.message] }; throw e;
  }

  // Sheet rows → the tree applyTree takes. Existing rows carry what the sheet
  // does not say (unit, BOM line, flow when the Flow cell is blank).
  let seq = 0;
  const toNode = (p) => {
    const ex = p.existing;
    return {
      key: ex ? `i${ex.itemId}` : `x${++seq}`,
      itemId: ex ? Number(ex.itemId) : null,
      catalogItemId: ex ? ex.catalogItemId : Number(p.catalog.id),
      name: p.name,
      unit: ex ? ex.unit : (p.catalog.unit ?? 'nos'),
      qty: p.qty,
      procurementType: p.procurement ?? (ex ? ex.procurementType : p.catalog.procurement),
      codeSegment: ex ? ex.codeSegment : null,
      codeJoin: ex ? ex.codeJoin : 'dash',
      defaultFlowId: p.flowId !== undefined ? p.flowId : (ex ? ex.defaultFlowId : null),
      bomLineId: ex ? ex.bomLineId : null,
      qtyParam: null,
      dims: p.dims,
      children: [],
    };
  };
  const nodeOf = new Map(parsed.map((p) => [p, toNode(p)]));
  const root = {
    key: `i${rootId}`, itemId: rootId, catalogItemId: tree.catalogItemId, name: tree.name, unit: tree.unit,
    qty: Number(tree.qty), procurementType: tree.procurementType, codeSegment: tree.codeSegment,
    codeJoin: tree.codeJoin, defaultFlowId: tree.defaultFlowId, bomLineId: tree.bomLineId,
    qtyParam: null, children: [],
  };
  for (const p of parsed) (p.parent ? nodeOf.get(p.parent) : root).children.push(nodeOf.get(p));

  const result = await applyTree(companyId, { orderId, orderLineId, tree: root }, conn, { revisionReason, userId });
  return { ...result, rows: parsed.length };
}
