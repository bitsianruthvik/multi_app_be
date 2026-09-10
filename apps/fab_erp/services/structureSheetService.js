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
    if (String(row.getCell(1).value ?? '').trim().toLowerCase() === 'level') headerRow = n;
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

  const problems = [];
  const parsed = [];
  ws.eachRow((row, n) => {
    if (n <= headerRow) return;
    const rawLevel = row.getCell(1).value;
    const rawItem = String(row.getCell(2).value ?? '').trim();
    if (rawLevel == null && !rawItem) return;      // a blank spacer row

    const level = Number(rawLevel);
    if (!Number.isInteger(level) || level < 0) {
      problems.push(`Row ${n}: level "${rawLevel}" is not a whole number.`); return;
    }
    if (!rawItem) { problems.push(`Row ${n}: no item name.`); return; }

    const hit = byName.get(rawItem.toLowerCase()) ?? byCode.get(rawItem.toLowerCase());
    if (!hit) { problems.push(`Row ${n}: "${rawItem}" is not in the catalogue.`); return; }

    const qty = Number(row.getCell(3).value);
    const dims = {};
    for (const { col, key } of DIM_COLS) {
      const v = row.getCell(col).value;
      const num = Number(v);
      if (v !== null && v !== '' && v !== undefined && Number.isFinite(num)) dims[key] = num;
    }
    parsed.push({
      rowNo: n,
      level,
      catalogItemId: Number(hit.id),
      name: hit.name,
      unit: String(row.getCell(4).value ?? '').trim() || hit.unit || 'nos',
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      dims,
    });
  });

  if (!parsed.length && !problems.length) {
    const e = new Error('That sheet has no rows under the header.'); e.status = 400; throw e;
  }
  if (parsed.length && parsed[0].level !== 0) {
    problems.push(`Row ${parsed[0].rowNo}: the first row must be level 0 — it is the thing being built.`);
  }
  for (let i = 1; i < parsed.length; i += 1) {
    const jump = parsed[i].level - parsed[i - 1].level;
    if (jump > 1) {
      problems.push(
        `Row ${parsed[i].rowNo}: level jumps from ${parsed[i - 1].level} to ${parsed[i].level}.`
        + ' A row can only be one level deeper than the row above it.',
      );
    }
  }
  if (parsed.filter((p) => p.level === 0).length > 1) {
    problems.push('More than one level 0 row — a structure has a single top.');
  }
  if (problems.length) {
    const e = new Error(`That sheet could not be read:\n${problems.slice(0, 12).join('\n')}`
      + (problems.length > 12 ? `\n…and ${problems.length - 12} more` : ''));
    e.status = 400; e.problems = problems; throw e;
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
