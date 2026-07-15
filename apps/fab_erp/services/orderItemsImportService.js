/**
 * orderItemsImportService.js — bulk Items/BOM tree import (per sales order) via Excel.
 *
 * exportOrderItemsTemplate — builds an .xlsx with an Instructions sheet, a
 *   Flows reference sheet (this company's fab_operation_flows names/codes),
 *   and a Data sheet pre-filled with one example branch demonstrating the
 *   Row Ref / Parent Row Ref pattern.
 *
 * importOrderItemsExcel — parses the Data sheet, validates Row Ref
 *   uniqueness + Parent Row Ref resolution, detects cycles, topologically
 *   sorts so parents insert before children, then inserts the fab_items
 *   tree (+ optional fab_custom_fields length/width) for one order in a
 *   single transaction. Mirrors itemsImportService.js's conventions
 *   (ExcelJS wb.xlsx.readFile/writeBuffer, buildImportReport shape) and
 *   grnService.postGrn's single-connection transaction pattern.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function cellVal(row, col) {
  const c = row.getCell(col);
  if (c.value === null || c.value === undefined) return null;
  if (typeof c.value === 'object' && c.value.text)                 return String(c.value.text).trim();
  if (typeof c.value === 'object' && c.value.result !== undefined) return String(c.value.result).trim();
  return String(c.value).trim() || null;
}

function numVal(row, col) {
  const v = cellVal(row, col);
  if (v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function styledHeader(ws, cols) {
  ws.addRow(cols.map((c) => c.header));
  const row = ws.getRow(1);
  row.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height    = 20;
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 20; });
}

// ── export ────────────────────────────────────────────────────────────────────

export async function exportOrderItemsTemplate(companyId, orderId) {
  const [orders] = await pool.query(
    'SELECT id, order_number FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');

  const [flows] = await pool.query(
    `SELECT name, code FROM fab_operation_flows
      WHERE company_id = ? AND active = 1 AND deleted_at IS NULL ORDER BY name`,
    [companyId],
  );

  const wb = new ExcelJS.Workbook();

  // ── Sheet 1: Data (fill-in template) ────────────────────────────────────
  const ws = wb.addWorksheet('Data');
  const cols = [
    { header: 'Row Ref *',           width: 14 },
    { header: 'Parent Row Ref',      width: 16 },
    { header: 'Item Name *',         width: 30 },
    { header: 'Catalog Item Code',   width: 20 },
    { header: 'Qty',                 width: 10 },
    { header: 'Unit',                width: 10 },
    { header: 'Length',              width: 12 },
    { header: 'Width',               width: 12 },
    { header: 'Operation Flow',      width: 24 },
  ];
  styledHeader(ws, cols);

  const exampleRows = [
    ['G11',       '',          'G11', '', 1, 'pcs', '', '', ''],
    ['G11.1',     'G11',       'Top Flange', '', 1, 'pcs', '', '', ''],
    ['G11.1.1',   'G11.1',     'RM 20mm(45x50)', '', 1, 'pcs', 45, 50, ''],
    ['G11.1.1.1', 'G11.1.1',   'RM 20mm(100x100)', '', 1, 'pcs', 100, 100, ''],
  ];
  for (const r of exampleRows) ws.addRow(r);
  for (let i = 2; i <= exampleRows.length + 1; i++) {
    ws.getRow(i).font = { italic: true, color: { argb: 'FF999999' } };
  }

  // ── Sheet 2: Flows (reference) ──────────────────────────────────────────
  const wsFlows = wb.addWorksheet('Flows');
  styledHeader(wsFlows, [
    { header: 'Flow Name', width: 30 },
    { header: 'Flow Code', width: 20 },
  ]);
  for (const f of flows) wsFlows.addRow([f.name, f.code]);

  // ── Sheet 3: Instructions ────────────────────────────────────────────────
  const wsHelp = wb.addWorksheet('Instructions');
  wsHelp.getColumn(1).width = 100;
  const lines = [
    `How to use this template — Order ${orders[0].order_number}`,
    '',
    '1. Fill in rows on the "Data" sheet. Delete the example rows (G11...G11.1.1.1) before importing.',
    '2. "Row Ref" is a stable id you make up, unique within this file (e.g. G11, G11.1, G11.1.1).',
    '   It is used only to wire up parent/child relationships in this one import — it is not saved.',
    '3. "Parent Row Ref" — leave blank to start a new top-level branch (e.g. G11, G12, G13 can all',
    '   be blank-parent rows in the same upload). Otherwise it must match another row\'s Row Ref.',
    '4. "Item Name" is required — free text (e.g. a hand-typed RM-cut label) or a name matching a',
    '   catalog item.',
    '5. "Catalog Item Code" is optional. If filled in, it must match an existing Item Catalog code',
    '   exactly — an unknown code causes that row to be skipped (logged in the import report).',
    '6. "Qty" defaults to 1. "Unit" defaults to the resolved catalog item\'s unit, else "pcs".',
    '7. "Length" / "Width" are optional numeric dimensions, stored as custom fields on the item.',
    '8. "Operation Flow" is optional — type the exact flow Name or Code from the "Flows" reference',
    '   sheet. An unrecognised value does not fail the row; the item is still created with no flow.',
    '9. A cycle (a row that is its own ancestor via Parent Row Ref chains) rejects the ENTIRE import —',
    '   fix the sheet and re-upload.',
  ];
  lines.forEach((l) => wsHelp.addRow([l]));
  wsHelp.getRow(1).font = { bold: true, size: 13 };

  return wb.xlsx.writeBuffer();
}

// ── import report ────────────────────────────────────────────────────────────

/** Builds a per-row status log as an .xlsx buffer — what got imported, what was skipped, and why. */
async function buildImportReport(rowLog) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import Log');
  styledHeader(ws, [
    { header: 'Row',            width: 8 },
    { header: 'Row Ref',        width: 14 },
    { header: 'Parent Row Ref', width: 16 },
    { header: 'Item Name',      width: 28 },
    { header: 'Status',         width: 12 },
    { header: 'Item Id',        width: 10 },
    { header: 'Reason',         width: 44 },
  ]);
  for (const r of rowLog) {
    ws.addRow([r.row, r.rowRef, r.parentRowRef, r.name, r.status, r.itemId ?? '', r.reason]);
    const excelRow = ws.lastRow;
    const fill = r.status === 'Created'
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
    excelRow.eachCell((cell) => { cell.fill = fill; });
  }
  return wb.xlsx.writeBuffer();
}

// ── cycle detection + topo sort ─────────────────────────────────────────────

/**
 * Returns { order: string[] of rowRefs in parent-before-child order, cycleRef: string|null }.
 * `childrenByParent` maps rowRef (or '' for top-level) -> [rowRef, ...].
 * Only rows that passed uniqueness/parent-resolution validation are included.
 */
function topoSortWithCycleCheck(rowRefs, parentOf) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const state = new Map(rowRefs.map((r) => [r, WHITE]));
  const order = [];
  let cycleRef = null;

  function visit(ref, path) {
    if (cycleRef) return;
    const st = state.get(ref);
    if (st === BLACK) return;
    if (st === GRAY) { cycleRef = ref; return; }
    state.set(ref, GRAY);
    const parent = parentOf.get(ref);
    if (parent) {
      if (!state.has(parent)) {
        // Parent doesn't exist among validated rows — shouldn't happen here
        // since parent-resolution is checked before calling this, but guard anyway.
      } else {
        visit(parent, [...path, ref]);
        if (cycleRef) return;
      }
    }
    state.set(ref, BLACK);
    order.push(ref);
  }

  for (const ref of rowRefs) {
    if (cycleRef) break;
    visit(ref, []);
  }

  return { order, cycleRef };
}

// ── import ────────────────────────────────────────────────────────────────────

export async function importOrderItemsExcel(file, companyId, orderId) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const ws = wb.getWorksheet('Data');
  if (!ws) throw new Error('Sheet "Data" not found in the uploaded file. Use the exported template.');

  // Collect rows synchronously first (ExcelJS eachRow callback is sync).
  const rawRows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const rowRef = cellVal(row, 1);
    const name   = cellVal(row, 3);
    if (!rowRef && !name) return; // blank row
    rawRows.push({
      rowNumber,
      rowRef:          rowRef || '',
      parentRowRef:    cellVal(row, 2) || '',
      name:            name || '',
      catalogCode:     cellVal(row, 4),
      qty:             numVal(row, 5),
      unit:            cellVal(row, 6),
      length:          numVal(row, 7),
      width:           numVal(row, 8),
      flowRef:         cellVal(row, 9),
    });
  });

  const result = {
    itemsCreated: 0, itemsSkipped: 0,
    warnings: [],
    rowLog: [], // one entry per data row — backs the downloadable import report
  };

  // ── verify the order belongs to this company before touching anything ────
  const [orders] = await pool.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');

  // ── validation pass: Row Ref required + unique, Item Name required,
  //    Parent Row Ref (if present) must resolve to a Row Ref in this file ──
  const seenRefs = new Set();
  const validRows = [];   // rows that pass structural validation
  const skippedRows = []; // rows rejected before insert, logged immediately

  for (const r of rawRows) {
    const rowBase = { row: r.rowNumber, rowRef: r.rowRef, parentRowRef: r.parentRowRef, name: r.name };

    if (!r.rowRef) {
      skippedRows.push({ ...rowBase, status: 'Skipped', reason: 'Row Ref is required.' });
      continue;
    }
    if (!r.name) {
      skippedRows.push({ ...rowBase, status: 'Skipped', reason: 'Item Name is required.' });
      continue;
    }
    if (seenRefs.has(r.rowRef)) {
      skippedRows.push({ ...rowBase, status: 'Skipped', reason: `Duplicate Row Ref '${r.rowRef}' — already used earlier in this file.` });
      continue;
    }
    seenRefs.add(r.rowRef);
    validRows.push(r);
  }

  for (const r of validRows) {
    if (r.parentRowRef && !seenRefs.has(r.parentRowRef)) {
      skippedRows.push({
        row: r.rowNumber, rowRef: r.rowRef, parentRowRef: r.parentRowRef, name: r.name,
        status: 'Skipped',
        reason: `Parent Row Ref '${r.parentRowRef}' does not match any Row Ref in this file.`,
      });
    }
  }
  const unresolvedParentRefs = new Set(skippedRows.filter((s) => s.reason.startsWith('Parent Row Ref')).map((s) => s.rowRef));
  const resolvableRows = validRows.filter((r) => !unresolvedParentRefs.has(r.rowRef));

  // ── cycle detection + topological sort (parent-before-child) ─────────────
  const rowByRef = new Map(resolvableRows.map((r) => [r.rowRef, r]));
  const parentOf = new Map(resolvableRows.map((r) => [r.rowRef, r.parentRowRef || null]));
  const { order: sortedRefs, cycleRef } = topoSortWithCycleCheck([...rowByRef.keys()], parentOf);

  if (cycleRef) {
    const message = `Cycle detected in Parent Row Ref chain involving Row Ref '${cycleRef}'. The whole import was rejected — no rows were created. Fix the parent/child chain and re-upload.`;
    const rowLog = [
      ...rawRows.map((r) => ({
        row: r.rowNumber, rowRef: r.rowRef, parentRowRef: r.parentRowRef, name: r.name,
        status: 'Skipped', itemId: null,
        reason: r.rowRef === cycleRef || (unresolvedParentRefs.has(r.rowRef))
          ? message
          : 'Import rejected — a cycle was detected elsewhere in the file.',
      })),
    ];
    result.itemsSkipped = rowLog.length;
    result.warnings.push({ message });
    result.reportBase64 = (await buildImportReport(rowLog)).toString('base64');
    return result;
  }

  // ── insert pass — single transaction, parent-before-child order ──────────
  const conn = await pool.getConnection();
  const insertedIdByRef = new Map(); // Row Ref -> fab_items.id
  const insertLog = [];

  try {
    await conn.beginTransaction();

    // preload company-scoped catalog items (by code) and operation flows
    const [catalogItems] = await conn.query(
      'SELECT id, code, unit FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL',
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
      flowByNameOrCode.set(String(f.name).toLowerCase(), f.id);
      flowByNameOrCode.set(String(f.code).toLowerCase(), f.id);
    }

    for (const rowRef of sortedRefs) {
      const r = rowByRef.get(rowRef);
      const rowBase = { row: r.rowNumber, rowRef: r.rowRef, parentRowRef: r.parentRowRef, name: r.name };
      const rowNotes = [];

      // resolve catalog item code (unknown code -> skip + log, per spec)
      let catalogItemId = null;
      let resolvedUnit = null;
      if (r.catalogCode) {
        const catalogItem = catalogByCode.get(String(r.catalogCode).toUpperCase());
        if (!catalogItem) {
          insertLog.push({ ...rowBase, status: 'Skipped', itemId: null, reason: `Catalog Item Code '${r.catalogCode}' not found for this company.` });
          result.itemsSkipped++;
          continue;
        }
        catalogItemId = catalogItem.id;
        resolvedUnit = catalogItem.unit;
      }

      // resolve operation flow (unknown value -> warn + continue with flow_id=null)
      let flowId = null;
      if (r.flowRef) {
        flowId = flowByNameOrCode.get(String(r.flowRef).toLowerCase()) || null;
        if (!flowId) {
          const message = `Operation Flow '${r.flowRef}' not recognised — item created with no flow.`;
          result.warnings.push({ row: r.rowNumber, message });
          rowNotes.push(message);
        }
      }

      const parentItemId = r.parentRowRef ? (insertedIdByRef.get(r.parentRowRef) ?? null) : null;
      const unit = r.unit || resolvedUnit || 'pcs';
      const qty = r.qty !== null && r.qty !== undefined ? r.qty : 1;

      const [insertRes] = await conn.query(
        `INSERT INTO fab_items (company_id, order_id, parent_item_id, catalog_item_id, name, unit, qty, flow_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [companyId, orderId, parentItemId, catalogItemId, r.name.trim(), unit, qty, flowId],
      );
      const itemId = insertRes.insertId;
      insertedIdByRef.set(r.rowRef, itemId);
      result.itemsCreated++;

      if (r.length !== null && r.length !== undefined) {
        await conn.query(
          `INSERT INTO fab_custom_fields (company_id, level, level_id, field_key, field_type, field_value)
           VALUES (?, 'item', ?, 'length', 'number', ?)`,
          [companyId, itemId, String(r.length)],
        );
      }
      if (r.width !== null && r.width !== undefined) {
        await conn.query(
          `INSERT INTO fab_custom_fields (company_id, level, level_id, field_key, field_type, field_value)
           VALUES (?, 'item', ?, 'width', 'number', ?)`,
          [companyId, itemId, String(r.width)],
        );
      }

      insertLog.push({ ...rowBase, status: 'Created', itemId, reason: rowNotes.join(' ') || '' });
    }

    await conn.commit();

    const fullRowLog = [
      ...insertLog,
      ...skippedRows.map((s) => ({ ...s, itemId: null })),
    ].sort((a, b) => a.row - b.row);

    result.itemsSkipped += skippedRows.length;
    result.reportBase64 = (await buildImportReport(fullRowLog)).toString('base64');
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
