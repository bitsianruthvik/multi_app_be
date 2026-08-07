/**
 * orderItemsImportService.js — the order's BOM, entered as a workbook.
 *
 * Every job here is a one-off. The same bridge does not come back for years, so
 * there is nothing to reuse from a catalog BOM — the tree is built per order,
 * and the way it actually gets built in a fab shop is a spreadsheet passed
 * around: one sheet takes the top level down to the next, the following sheet
 * rolls that level out further, and a last sheet says which raw material each
 * bottom part is cut from. This file mirrors that layout instead of fighting it.
 *
 * SHEETS
 *   Level 1, Level 2, Level 3, …   any number, read in numeric order. Level 1
 *                                  rows with a blank parent are the top of the
 *                                  order. Every deeper sheet names its parent.
 *   Raw Material                   read last; parents the bought-in material
 *                                  under the parts that consume it.
 *   Flows                          reference — each flow and the operations
 *                                  inside it. Backs the Operation Flow dropdown.
 *   Instructions                   how to fill it in.
 *
 * The sheet count is deliberately not fixed. Project depth changes job to job,
 * and one branch of a single job routinely bottoms out three levels above
 * another, so anything that assumed "five levels" would be wrong on the first
 * real order.
 *
 * PARENTS ARE MATCHED BY NAME, and a name is looked up against every item
 * created so far in the upload — not just the sheet immediately before. That is
 * what makes ragged depth work: a part that finishes at Level 2 can still take
 * raw material from the last sheet. Fabrication reuses names freely ("Top
 * Flange" under three different girders), so when a name matches more than one
 * item the row is rejected rather than guessed at, and the fix is to write the
 * parent as a path — `Girder G1 > Top Flange`. Guessing here would silently
 * weld the wrong sub-assembly onto the wrong girder.
 *
 * An unrecognised Operation Flow is a rejected row, not a warning. The old
 * behaviour created the item with no flow, which produces no tasks — the part
 * simply never got made, and nothing said so until someone noticed the gap on
 * the shop floor.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { recomputeOrderWeights } from './itemWeightService.js';
import { generateOrderItemCodes } from './itemCodeService.js';

// Validation dropdowns and blank fill-in rows are written this far down each
// sheet. Beyond it a user can still type — the dropdown just stops assisting.
const TEMPLATE_ROWS = 500;
/** Blank level sheets emitted for a fresh order. More can be added by hand. */
const DEFAULT_LEVEL_SHEETS = 4;

// ── column layouts ───────────────────────────────────────────────────────────

const LEVEL_COLS = [
  { header: 'Parent Item',        width: 28, key: 'parentRef' },
  { header: 'Item Name *',        width: 30, key: 'name' },
  { header: 'Qty',                width: 8,  key: 'qty' },
  { header: 'Unit',               width: 9,  key: 'unit' },
  { header: 'Operation Flow',     width: 24, key: 'flowRef' },
  { header: 'Length',             width: 10, key: 'length' },
  { header: 'Width',              width: 10, key: 'width' },
  { header: 'Height',             width: 10, key: 'height' },
  { header: 'Unit Weight (kg)',   width: 16, key: 'unitWeight' },
  { header: 'Catalog Item Code',  width: 20, key: 'catalogCode' },
  { header: 'Notes',              width: 30, key: 'notes' },
];

const RM_COLS = [
  { header: 'Parent Item *',       width: 28, key: 'parentRef' },
  { header: 'Raw Material Code *', width: 22, key: 'catalogCode' },
  { header: 'Item Name',           width: 28, key: 'name' },
  { header: 'Qty',                 width: 8,  key: 'qty' },
  { header: 'Unit',                width: 9,  key: 'unit' },
  { header: 'Length',              width: 10, key: 'length' },
  { header: 'Width',               width: 10, key: 'width' },
  { header: 'Height',              width: 10, key: 'height' },
  { header: 'Unit Weight (kg)',    width: 16, key: 'unitWeight' },
  { header: 'Notes',               width: 30, key: 'notes' },
];

const FLOW_COL_INDEX = LEVEL_COLS.findIndex((c) => c.key === 'flowRef') + 1;

// ── cell helpers ─────────────────────────────────────────────────────────────

function cellVal(row, col) {
  const c = row.getCell(col);
  if (c.value === null || c.value === undefined) return null;
  if (typeof c.value === 'object' && c.value.text)                 return String(c.value.text).trim() || null;
  if (typeof c.value === 'object' && c.value.result !== undefined) return String(c.value.result).trim() || null;
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

/** Case/space-insensitive key for name matching. */
function norm(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── export ───────────────────────────────────────────────────────────────────

export async function exportOrderItemsTemplate(companyId, orderId) {
  const [orders] = await pool.query(
    'SELECT id, order_number FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');
  const orderNumber = orders[0].order_number;

  // Flows plus their operation sequence — a name alone does not tell anyone
  // whether they picked the right one.
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

  // Existing tree, so the template round-trips: export, edit, re-upload as a
  // replace. Depth is derived here rather than stored.
  const [items] = await pool.query(
    `SELECT fi.id, fi.parent_item_id, fi.name, fi.qty, fi.unit, fi.length, fi.width, fi.height,
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

  // An item's parent is written as a path only when its plain name is ambiguous
  // within the order — short refs stay readable, and long ones appear only where
  // they are actually needed.
  const nameCount = new Map();
  for (const i of items) nameCount.set(norm(i.name), (nameCount.get(norm(i.name)) ?? 0) + 1);
  function parentRefFor(item) {
    if (item.parent_item_id == null) return '';
    const segs = [];
    let cur = byId.get(item.parent_item_id);
    while (cur) {
      segs.unshift(cur.name);
      if ((nameCount.get(norm(cur.name)) ?? 0) <= 1) break;
      cur = cur.parent_item_id != null ? byId.get(cur.parent_item_id) : null;
    }
    return segs.join(' > ');
  }

  // Raw material = a leaf carrying a catalog item and no flow. That is what the
  // task gate already treats as material to consume, so the sheet it lands on
  // must agree with the gate rather than inventing a second definition.
  const hasChild = new Set(items.filter((i) => i.parent_item_id != null).map((i) => i.parent_item_id));
  const isRawMaterial = (i) => !hasChild.has(i.id) && i.catalog_item_id != null && !i.flow_name;

  const levelItems = new Map();
  const rmItems = [];
  for (const i of items) {
    if (isRawMaterial(i)) { rmItems.push(i); continue; }
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
  wsHelp.getColumn(1).width = 108;
  [
    `Order ${orderNumber} — item tree upload`,
    '',
    'THE SHEETS',
    '  Level 1   the top of this order. Leave "Parent Item" blank on these rows.',
    '  Level 2   what those items are made of. "Parent Item" names a row from Level 1.',
    '  Level 3+  keep going down. Add more sheets named "Level 5", "Level 6" … if you need them —',
    '            there is no fixed number of levels, and unused sheets are ignored.',
    '  Raw Material   the bought-in material each bottom part is cut from. Read last.',
    '',
    'PARENT ITEM',
    '  Type the name of the item this row sits under, exactly as you typed it on an earlier sheet.',
    '  You can name a parent from ANY earlier sheet, not just the one before — branches are allowed',
    '  to finish at different depths.',
    '  If two items share a name, write the path instead:   Girder G1 > Top Flange',
    '  A name matching more than one item is rejected, never guessed.',
    '',
    'WEIGHT — fill it in at the bottom only',
    '  Put "Unit Weight (kg)" on the rows that have nothing underneath them — the cut pieces.',
    '  Everything above adds up on its own: an assembly weighs the sum of its parts x their quantity.',
    '  You may still type a weight on an assembly if you know the real figure (welds, bolts and paint',
    '  make it heavier than the sum). Your figure is kept and the calculated one is shown beside it,',
    '  so the difference stays visible.',
    '  Unit Weight is the weight of ONE, not of the quantity on the row.',
    '',
    'LENGTH / WIDTH / HEIGHT',
    '  Fill these in on the bottom rows too — they describe a cut piece. Leave them blank once parts',
    '  are joined together; only the weight carries upward.',
    '',
    'OPERATION FLOW',
    '  Pick from the dropdown. The "Flows" sheet lists each flow and the operations inside it.',
    '  A flow name that is not recognised REJECTS the row — an item with no flow produces no work,',
    '  and it is better to fix the spelling now than to find the part was never made.',
    '  Raw material has no flow, which is why that sheet has no such column.',
    '',
    'CATALOG ITEM CODE',
    '  Optional on the Level sheets, required on Raw Material. It must match an Item Catalog code',
    '  exactly. Parts you fabricate do not need one.',
    '',
    'QTY',
    '  How many of this item go into ONE of its parent. Defaults to 1.',
    '',
    'UPLOADING',
    '  Append  adds these rows to whatever is already on the order.',
    '  Replace clears the order\'s existing items first. Replace is refused if any task on the order',
    '          has already been started or finished, so shop-floor history cannot be thrown away.',
    '  Every upload returns a report listing each row: created, or skipped with the reason.',
    '',
    'The sheets below are already filled in with this order\'s current items — edit them and re-upload',
    'with Replace, or clear them and start fresh.',
  ].forEach((l) => wsHelp.addRow([l]));
  wsHelp.getRow(1).font = { bold: true, size: 13 };
  // Section headings are the unindented ALL-CAPS lines — matched by content so
  // editing the copy above can never bold the wrong row.
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
      ws.addRow([
        parentRefFor(i),
        i.name,
        i.qty != null ? Number(i.qty) : 1,
        i.unit ?? '',
        i.flow_name ?? '',
        i.length != null ? Number(i.length) : '',
        i.width != null ? Number(i.width) : '',
        i.height != null ? Number(i.height) : '',
        i.unit_weight != null ? Number(i.unit_weight) : '',
        i.catalog_code ?? '',
        '',
      ]);
    }
    applyFlowDropdown(ws, flowRows.length, FLOW_COL_INDEX);
  }

  // ── Raw Material sheet ───────────────────────────────────────────────────
  const wsRm = wb.addWorksheet('Raw Material');
  styledHeader(wsRm, RM_COLS);
  for (const i of rmItems) {
    wsRm.addRow([
      parentRefFor(i),
      i.catalog_code ?? '',
      i.name,
      i.qty != null ? Number(i.qty) : 1,
      i.unit ?? '',
      i.length != null ? Number(i.length) : '',
      i.width != null ? Number(i.width) : '',
      i.height != null ? Number(i.height) : '',
      i.unit_weight != null ? Number(i.unit_weight) : '',
      '',
    ]);
  }

  // ── Flows reference ──────────────────────────────────────────────────────
  const wsFlows = wb.addWorksheet('Flows');
  styledHeader(wsFlows, [
    { header: 'Flow Name',  width: 30 },
    { header: 'Flow Code',  width: 18 },
    { header: 'Operations', width: 80 },
  ]);
  for (const f of flowRows) {
    wsFlows.addRow([f.name, f.code, f.operations || '(no steps defined)']);
  }
  if (!flowRows.length) {
    wsFlows.addRow(['(no active operation flows — set them up under Operations › Flows first)', '', '']);
  }

  return wb.xlsx.writeBuffer();
}

/**
 * List validation on the Operation Flow column, sourced from the Flows sheet.
 * Applied cell by cell because the range has to cover empty rows the user has
 * not typed in yet.
 */
function applyFlowDropdown(ws, flowCount, colIndex) {
  if (flowCount < 1) return;
  const source = `Flows!$A$2:$A$${flowCount + 1}`;
  for (let r = 2; r <= TEMPLATE_ROWS; r++) {
    ws.getCell(r, colIndex).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [source],
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: 'Unknown flow',
      error: 'Pick a flow from the list on the "Flows" sheet. An unrecognised flow will reject the row on upload.',
    };
  }
}

// ── import report ────────────────────────────────────────────────────────────

async function buildImportReport(rowLog) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import Log');
  styledHeader(ws, [
    { header: 'Sheet',       width: 16 },
    { header: 'Row',         width: 7 },
    { header: 'Parent Item', width: 26 },
    { header: 'Item Name',   width: 28 },
    { header: 'Status',      width: 11 },
    { header: 'Item Id',     width: 10 },
    { header: 'Reason',      width: 62 },
  ]);
  for (const r of rowLog) {
    ws.addRow([r.sheet, r.row, r.parentRef, r.name, r.status, r.itemId ?? '', r.reason]);
    const fill = r.status === 'Created'
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
    ws.lastRow.eachCell((cell) => { cell.fill = fill; });
  }
  return wb.xlsx.writeBuffer();
}

// ── sheet discovery + parsing ────────────────────────────────────────────────

/**
 * Returns the sheets to read, in the order they must be read.
 * Level sheets sort numerically ("Level 10" after "Level 9", which a plain
 * string sort would get wrong); Raw Material always goes last.
 */
function orderedSheets(wb) {
  const levels = [];
  let rawMaterial = null;
  wb.eachSheet((ws) => {
    const m = /^level\s*(\d+)$/i.exec(ws.name.trim());
    if (m) { levels.push({ ws, level: Number(m[1]) }); return; }
    if (/^raw\s*materials?$/i.test(ws.name.trim())) rawMaterial = ws;
  });
  levels.sort((a, b) => a.level - b.level);
  const out = levels.map((l) => ({ ws: l.ws, kind: 'level', label: l.ws.name }));
  if (rawMaterial) out.push({ ws: rawMaterial, kind: 'rawMaterial', label: rawMaterial.name });
  return out;
}

function parseSheet(ws, kind) {
  const cols = kind === 'rawMaterial' ? RM_COLS : LEVEL_COLS;
  const idx = {};
  cols.forEach((c, i) => { idx[c.key] = i + 1; });

  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name        = cellVal(row, idx.name);
    const parentRef   = cellVal(row, idx.parentRef);
    const catalogCode = idx.catalogCode ? cellVal(row, idx.catalogCode) : null;
    if (!name && !parentRef && !catalogCode) return; // genuinely blank row
    rows.push({
      sheet:       ws.name,
      kind,
      row:         rowNumber,
      parentRef:   parentRef ?? '',
      name:        name ?? '',
      qty:         numVal(row, idx.qty),
      unit:        cellVal(row, idx.unit),
      flowRef:     idx.flowRef ? cellVal(row, idx.flowRef) : null,
      length:      numVal(row, idx.length),
      width:       numVal(row, idx.width),
      height:      numVal(row, idx.height),
      unitWeight:  numVal(row, idx.unitWeight),
      catalogCode,
    });
  });
  return rows;
}

// ── parent resolution ────────────────────────────────────────────────────────

/**
 * Name → item registry over everything created so far (plus, in append mode,
 * what the order already had). Supports `A > B > C` paths, where the segments
 * before the last must appear as ancestors in that order — gaps allowed, so a
 * user does not have to spell out every intermediate level to disambiguate.
 */
class ItemRegistry {
  constructor() {
    this.byId = new Map();        // id -> { id, name, parentId }
    this.idsByName = new Map();   // normalised name -> [id]
  }

  add(id, name, parentId) {
    this.byId.set(id, { id, name, parentId });
    const key = norm(name);
    if (!this.idsByName.has(key)) this.idsByName.set(key, []);
    this.idsByName.get(key).push(id);
  }

  ancestorNames(id) {
    const out = [];
    let cur = this.byId.get(id);
    const guard = new Set();
    while (cur && cur.parentId != null && !guard.has(cur.parentId)) {
      guard.add(cur.parentId);
      const parent = this.byId.get(cur.parentId);
      if (!parent) break;
      out.push(norm(parent.name));
      cur = parent;
    }
    return out; // nearest ancestor first
  }

  /** @returns {{id:number}|{error:string}} */
  resolve(ref) {
    const segments = String(ref).split('>').map((s) => s.trim()).filter(Boolean);
    if (!segments.length) return { error: 'Parent Item is blank.' };

    const leaf = segments[segments.length - 1];
    let candidates = this.idsByName.get(norm(leaf)) ?? [];

    if (!candidates.length) {
      return { error: `Parent Item '${leaf}' does not match any item created earlier in this upload${this.byId.size ? '' : ' (nothing has been created yet — check the sheet order)'}.` };
    }

    if (segments.length > 1) {
      const wanted = segments.slice(0, -1).map(norm).reverse(); // nearest first
      candidates = candidates.filter((id) => {
        const chain = this.ancestorNames(id);
        let ci = 0;
        for (const w of wanted) {
          const found = chain.indexOf(w, ci);
          if (found === -1) return false;
          ci = found + 1;
        }
        return true;
      });
      if (!candidates.length) {
        return { error: `Parent path '${ref}' does not match any item — '${leaf}' exists but not under that chain.` };
      }
    }

    if (candidates.length > 1) {
      const paths = candidates.slice(0, 3).map((id) => {
        const chain = this.ancestorNames(id).reverse();
        return chain.length ? `${chain.join(' > ')} > ${leaf}` : leaf;
      });
      return {
        error: `Parent Item '${ref}' matches ${candidates.length} items. Write the full path instead, e.g. ${paths.map((p) => `'${p}'`).join(' or ')}.`,
      };
    }

    return { id: candidates[0] };
  }
}

// ── import ───────────────────────────────────────────────────────────────────

/**
 * @param {{path:string}} file        uploaded .xlsx (deleted once read)
 * @param {number} companyId
 * @param {number} orderId
 * @param {'append'|'replace'} mode
 */
export async function importOrderItemsExcel(file, companyId, orderId, mode = 'append') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const sheets = orderedSheets(wb);
  if (!sheets.length) {
    throw new Error('No "Level 1" sheet found in the uploaded file. Download the template from this order and fill that in.');
  }

  const [orders] = await pool.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');

  // Replacing the tree orphans anything already built on it. Untouched tasks
  // are safe to drop and rebuild; work that has actually happened on the floor
  // is not, so the import is refused rather than quietly discarding it.
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

  const parsed = sheets.flatMap((s) => parseSheet(s.ws, s.kind));

  const result = {
    mode,
    itemsCreated: 0,
    itemsSkipped: 0,
    itemsDeleted: 0,
    itemsCoded: 0,
    totalWeight: null,
    unweighedLeaves: 0,
    warnings: [],
  };

  if (!parsed.length) {
    result.warnings.push({ message: 'The uploaded workbook had no filled-in rows on any Level or Raw Material sheet.' });
    return result;
  }

  const conn = await pool.getConnection();
  const registry = new ItemRegistry();
  const rowLog = [];

  try {
    await conn.beginTransaction();

    if (mode === 'replace') {
      const [[before]] = await conn.query(
        'SELECT COUNT(*) AS cnt FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL',
        [companyId, orderId],
      );
      await conn.query(
        `UPDATE fab_project_tasks SET deleted_at = NOW()
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
        [companyId, orderId],
      );
      await conn.query(
        `UPDATE fab_task_inputs SET deleted_at = NOW()
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
        [companyId, orderId],
      );
      await conn.query(
        'UPDATE fab_items SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL',
        [companyId, orderId],
      );
      result.itemsDeleted = before.cnt;
    } else {
      // Append: existing items are valid parents, so a new level can be hung
      // off a tree that is already there.
      const [existing] = await conn.query(
        `SELECT id, name, parent_item_id FROM fab_items
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY id`,
        [companyId, orderId],
      );
      for (const e of existing) registry.add(e.id, e.name, e.parent_item_id);
    }

    const [catalogItems] = await conn.query(
      'SELECT id, code, name, unit FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const catalogByCode = new Map(catalogItems.map((c) => [String(c.code).toUpperCase(), c]));

    const [flows] = await conn.query(
      `SELECT id, name, code FROM fab_operation_flows
        WHERE company_id = ? AND active = 1 AND deleted_at IS NULL`,
      [companyId],
    );
    const flowByNameOrCode = new Map();
    for (const f of flows) {
      flowByNameOrCode.set(norm(f.name), f.id);
      if (f.code) flowByNameOrCode.set(norm(f.code), f.id);
    }

    for (const r of parsed) {
      const base = { sheet: r.sheet, row: r.row, parentRef: r.parentRef, name: r.name };
      const skip = (reason) => {
        rowLog.push({ ...base, status: 'Skipped', itemId: null, reason });
        result.itemsSkipped++;
      };

      // ── catalog item ─────────────────────────────────────────────────────
      let catalogItem = null;
      if (r.catalogCode) {
        catalogItem = catalogByCode.get(String(r.catalogCode).toUpperCase()) ?? null;
        if (!catalogItem) {
          skip(`Catalog Item Code '${r.catalogCode}' not found in the Item Catalog.`);
          continue;
        }
      } else if (r.kind === 'rawMaterial') {
        skip('Raw Material Code is required on the Raw Material sheet — it says which material this part is cut from.');
        continue;
      }

      const name = (r.name || catalogItem?.name || '').trim();
      if (!name) { skip('Item Name is required.'); continue; }
      base.name = name;

      // ── parent ───────────────────────────────────────────────────────────
      let parentItemId = null;
      const isFirstLevel = r.kind === 'level' && /^level\s*0*1$/i.test(r.sheet.trim());
      if (r.parentRef) {
        const res = registry.resolve(r.parentRef);
        if (res.error) { skip(res.error); continue; }
        parentItemId = res.id;
      } else if (!isFirstLevel) {
        skip(r.kind === 'rawMaterial'
          ? 'Parent Item is required — name the part this material is cut for.'
          : 'Parent Item is required on every sheet below Level 1. Only Level 1 rows may have a blank parent.');
        continue;
      }

      // ── flow ─────────────────────────────────────────────────────────────
      let flowId = null;
      if (r.flowRef) {
        flowId = flowByNameOrCode.get(norm(r.flowRef)) ?? null;
        if (!flowId) {
          skip(`Operation Flow '${r.flowRef}' is not an active flow. Pick one from the "Flows" sheet — an item with no flow produces no tasks at all.`);
          continue;
        }
      }

      const unit = r.unit || catalogItem?.unit || 'pcs';
      const qty  = r.qty !== null && r.qty !== undefined ? r.qty : 1;

      const [ins] = await conn.query(
        `INSERT INTO fab_items
           (company_id, order_id, parent_item_id, catalog_item_id, name, unit, qty, flow_id,
            length, width, height, unit_weight)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          companyId, orderId, parentItemId, catalogItem?.id ?? null, name, unit, qty, flowId,
          r.length, r.width, r.height, r.unitWeight,
        ],
      );

      registry.add(ins.insertId, name, parentItemId);
      rowLog.push({ ...base, status: 'Created', itemId: ins.insertId, reason: '' });
      result.itemsCreated++;
    }

    const weights = await recomputeOrderWeights(companyId, orderId, conn);
    result.totalWeight = weights.totalWeight;
    result.unweighedLeaves = weights.unweighedLeaves;

    // Codes are issued here rather than left to a button, because an imported
    // tree is exactly the moment every row's place in the assembly is known.
    // Existing codes are untouched — an append never renumbers what was there.
    const codes = await generateOrderItemCodes(companyId, orderId, conn);
    result.itemsCoded = codes.coded;

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

  // The per-row detail ships as the downloadable report, not as JSON — a 2000
  // row tree would otherwise put a megabyte of log into the browser's memory
  // for a banner that only quotes two numbers from it.
  rowLog.sort((a, b) => (a.sheet === b.sheet ? a.row - b.row : a.sheet.localeCompare(b.sheet, undefined, { numeric: true })));
  result.reportBase64 = (await buildImportReport(rowLog)).toString('base64');
  return result;
}
