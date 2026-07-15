/**
 * resourcesImportService.js — bulk Resource Type / Resource export/import via Excel.
 *
 * exportResourcesTemplate — builds an .xlsx with a "Resource Types" sheet, a
 *   "Resources" sheet (referencing resource types by code), a read-only
 *   "Reference" sheet (existing plants/resource types/stock locations/shift
 *   calendars), and an "Instructions" sheet.
 *
 * importResourcesExcel — parses both sheets. Resource Types are processed
 *   first (existing codes are skipped); Resources are processed second and
 *   resolve their Resource Type / Plant / Stock Location / Shift Calendar by
 *   code (case-insensitive), including resource types created earlier in the
 *   same import.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';

const CF_PREFIX = 'CF: ';
const SCHEDULING_BASES = ['machine', 'labor'];

const STD_COLS = [
  { header: 'Available Hours/Day', key: 'capacity_hrs_per_day', width: 16 },
  { header: 'Number of Units',     key: 'num_units',            width: 14 },
  { header: 'Utilization %',       key: 'utilization_pct',      width: 12 },
  { header: 'Efficiency %',        key: 'efficiency_pct',       width: 12 },
  { header: 'Overload Allowed %',  key: 'overload_pct',         width: 14 },
  { header: 'Setup Time Hrs',      key: 'setup_time_hrs',       width: 12 },
  { header: 'Teardown Time Hrs',   key: 'teardown_time_hrs',    width: 14 },
  { header: 'Queue Time Hrs',      key: 'queue_time_hrs',       width: 12 },
  { header: 'Move Time Hrs',       key: 'move_time_hrs',        width: 12 },
  { header: 'Scheduling Basis',    key: 'scheduling_basis',     width: 14 },
  { header: 'Cost per Hour',       key: 'cost_per_hour',        width: 12 },
  { header: 'Currency',            key: 'currency',             width: 10 },
];

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

function autoCode(name, maxLen = 20) {
  const c = (name || '').trim().toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return c || 'CODE';
}

/** Returns a code guaranteed not to be in codeSet, adding it to the set. */
function uniqueCode(codeSet, name, maxLen = 20) {
  const code = autoCode(name, maxLen);
  if (!codeSet.has(code)) { codeSet.add(code); return code; }
  const base = autoCode(name, maxLen - 4); // leave room for "_NN" suffix
  let n = 2;
  let candidate = `${base}_${n}`;
  while (codeSet.has(candidate)) { n++; candidate = `${base}_${n}`; }
  codeSet.add(candidate);
  return candidate;
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

function dropdown(ws, col, list, fromRow, toRow) {
  for (let r = fromRow; r <= toRow; r++) {
    ws.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${list.join(',')}"`] };
  }
}

function stdPayloadFromRow(row, startCol) {
  const out = {};
  STD_COLS.forEach((c, i) => {
    const col = startCol + i;
    if (c.key === 'scheduling_basis' || c.key === 'currency') {
      out[c.key] = cellVal(row, col) || null;
    } else {
      out[c.key] = numVal(row, col);
    }
  });
  return out;
}

function readCfColumns(headerRow, afterCol) {
  const cfColumns = [];
  headerRow.eachCell((cell, colNumber) => {
    if (colNumber <= afterCol) return;
    const text = cell.value && (cell.value.text || cell.value.result || cell.value);
    const header = text === null || text === undefined ? '' : String(text).trim();
    if (header.startsWith(CF_PREFIX)) {
      cfColumns.push({ col: colNumber, fieldKey: header.slice(CF_PREFIX.length).trim() });
    }
  });
  return cfColumns;
}

async function insertCustomFields(conn, companyId, level, levelId, customFields, cfTypeByKey) {
  let sortOrder = 0;
  for (const cf of customFields) {
    if (cf.value === null || cf.value === undefined || cf.value === '') continue;
    const fieldType = cfTypeByKey.get(cf.fieldKey) || 'text';
    await conn.query(
      `INSERT INTO fab_resource_custom_fields
         (company_id, level, level_id, field_key, field_label, field_type, field_value, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`,
      [companyId, level, levelId, cf.fieldKey, cf.fieldKey, fieldType, cf.value, sortOrder],
    );
    if (!cfTypeByKey.has(cf.fieldKey)) cfTypeByKey.set(cf.fieldKey, fieldType);
    sortOrder++;
  }
}

// ── export ────────────────────────────────────────────────────────────────────

export async function exportResourcesTemplate(companyId) {
  const wb = new ExcelJS.Workbook();

  const [rtCfKeys] = await pool.query(
    `SELECT DISTINCT field_key, field_type FROM fab_resource_custom_fields
      WHERE company_id = ? AND level = 'resource_type' AND deleted_at IS NULL ORDER BY field_key`,
    [companyId],
  );
  const [resCfKeys] = await pool.query(
    `SELECT DISTINCT field_key, field_type FROM fab_resource_custom_fields
      WHERE company_id = ? AND level = 'resource' AND deleted_at IS NULL ORDER BY field_key`,
    [companyId],
  );

  // ── Sheet 1: Resource Types ──────────────────────────────────────────────
  const wsRt = wb.addWorksheet('Resource Types');
  const rtCols = [
    { header: 'Code *',     width: 16 },
    { header: 'Name *',     width: 28 },
    { header: 'Category',   width: 18 },
    { header: 'Plant Code', width: 14 },
    ...STD_COLS,
  ];
  for (const cf of rtCfKeys) rtCols.push({ header: `${CF_PREFIX}${cf.field_key}`, width: 18 });
  styledHeader(wsRt, rtCols);

  const rtExampleRow = ['LATHE', 'Lathe', 'Machine', '', 8, 1, 85, 100, 100, 0.25, 0.1, 0, 0, 'machine', 500, 'INR'];
  for (let i = 0; i < rtCfKeys.length; i++) rtExampleRow.push('');
  wsRt.addRow(rtExampleRow);
  wsRt.getRow(2).font = { italic: true, color: { argb: 'FF999999' } };
  dropdown(wsRt, 4 + STD_COLS.findIndex((c) => c.key === 'scheduling_basis') + 1, SCHEDULING_BASES, 2, 1000);

  // ── Sheet 2: Resources ───────────────────────────────────────────────────
  const wsRes = wb.addWorksheet('Resources');
  const resCols = [
    { header: 'Code *',              width: 16 },
    { header: 'Name *',              width: 28 },
    { header: 'Resource Type Code *', width: 18 },
    { header: 'Plant Code',          width: 14 },
    { header: 'Stock Location Code', width: 16 },
    { header: 'Shift Calendar Code', width: 16 },
    ...STD_COLS,
  ];
  for (const cf of resCfKeys) resCols.push({ header: `${CF_PREFIX}${cf.field_key}`, width: 18 });
  styledHeader(wsRes, resCols);

  const resExampleRow = ['LATHE-01', 'Lathe Machine 1', 'LATHE', '', '', '', '', '', '', '', '', '', '', '', '', ''];
  for (let i = 0; i < resCfKeys.length; i++) resExampleRow.push('');
  wsRes.addRow(resExampleRow);
  wsRes.getRow(2).font = { italic: true, color: { argb: 'FF999999' } };
  dropdown(wsRes, 6 + STD_COLS.findIndex((c) => c.key === 'scheduling_basis') + 1, SCHEDULING_BASES, 2, 1000);

  // ── Sheet 3: Reference (existing data) ───────────────────────────────────
  const wsRef = wb.addWorksheet('Reference');
  styledHeader(wsRef, [
    { header: 'Type',  width: 16 },
    { header: 'Code',  width: 18 },
    { header: 'Name',  width: 28 },
    { header: 'Plant', width: 18 },
  ]);
  const [plants] = await pool.query(
    'SELECT code, name FROM fab_plants WHERE company_id = ? AND deleted_at IS NULL ORDER BY name',
    [companyId],
  );
  const [resourceTypes] = await pool.query(
    `SELECT rt.code, rt.name, p.code AS plant_code FROM fab_resource_types rt
       LEFT JOIN fab_plants p ON p.id = rt.plant_id
      WHERE rt.company_id = ? AND rt.deleted_at IS NULL ORDER BY rt.name`,
    [companyId],
  );
  const [stockLocations] = await pool.query(
    `SELECT sl.code, sl.name, p.code AS plant_code FROM fab_stock_locations sl
       JOIN fab_plants p ON p.id = sl.plant_id
      WHERE sl.company_id = ? AND sl.deleted_at IS NULL ORDER BY sl.name`,
    [companyId],
  );
  const [shiftCalendars] = await pool.query(
    `SELECT sc.code, sc.name, p.code AS plant_code FROM fab_shift_calendars sc
       LEFT JOIN fab_plants p ON p.id = sc.plant_id
      WHERE sc.company_id = ? AND sc.deleted_at IS NULL ORDER BY sc.name`,
    [companyId],
  );
  for (const p of plants)          wsRef.addRow(['Plant',          p.code, p.name, '']);
  for (const rt of resourceTypes)  wsRef.addRow(['Resource Type',  rt.code, rt.name, rt.plant_code ?? '']);
  for (const sl of stockLocations) wsRef.addRow(['Stock Location', sl.code, sl.name, sl.plant_code ?? '']);
  for (const sc of shiftCalendars) wsRef.addRow(['Shift Calendar', sc.code, sc.name, sc.plant_code ?? '']);

  // ── Sheet 4: Instructions ────────────────────────────────────────────────
  const wsHelp = wb.addWorksheet('Instructions');
  wsHelp.getColumn(1).width = 100;
  const lines = [
    'How to use this template',
    '',
    '1. Fill in rows on the "Resource Types" sheet and/or the "Resources" sheet. Delete the example',
    '   row (row 2) on each sheet before importing.',
    '2. Resource Types: Code and Name are required. If a Code already exists for this company,',
    '   that row is skipped (existing resource types are never overwritten by import).',
    '3. Resources: Code, Name and Resource Type Code are required. Resource Type Code must match a',
    '   code on the "Resource Types" sheet (new or existing) or the "Reference" sheet — unmatched',
    '   rows are skipped.',
    '4. Plant Code / Stock Location Code / Shift Calendar Code are optional — leave blank for',
    '   company-wide / no location / no calendar. See the "Reference" sheet for existing codes.',
    '5. Stock Location Code is only resolved within the row\'s Plant — set Plant Code first.',
    '6. Capacity/Scheduling/Costing columns are optional. On the Resources sheet, leave them blank',
    '   to inherit the resource type\'s defaults.',
    '7. Scheduling Basis: machine or labor.',
    '8. Columns titled "CF: <name>" are existing custom fields at that level for this company — fill',
    '   in a value per row to set that custom field on the imported row. Leave blank to skip it.',
  ];
  lines.forEach((l) => wsHelp.addRow([l]));
  wsHelp.getRow(1).font = { bold: true, size: 13 };

  return wb.xlsx.writeBuffer();
}

// ── import ────────────────────────────────────────────────────────────────────

export async function importResourcesExcel(file, companyId) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const wsRt = wb.getWorksheet('Resource Types');
  const wsRes = wb.getWorksheet('Resources');
  if (!wsRt && !wsRes) {
    throw new Error('Neither "Resource Types" nor "Resources" sheet found in the uploaded file. Use the exported template.');
  }

  const rtRows = [];
  if (wsRt) {
    const cfColumns = readCfColumns(wsRt.getRow(1), 4 + STD_COLS.length);
    wsRt.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const name = cellVal(row, 2);
      if (!name) return;
      rtRows.push({
        rowNumber,
        code: cellVal(row, 1),
        name,
        category: cellVal(row, 3),
        plantCode: cellVal(row, 4),
        std: stdPayloadFromRow(row, 5),
        customFields: cfColumns.map((cf) => ({ fieldKey: cf.fieldKey, value: cellVal(row, cf.col) })),
      });
    });
  }

  const resRows = [];
  if (wsRes) {
    const cfColumns = readCfColumns(wsRes.getRow(1), 6 + STD_COLS.length);
    wsRes.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const name = cellVal(row, 2);
      if (!name) return;
      resRows.push({
        rowNumber,
        code: cellVal(row, 1),
        name,
        resourceTypeCode: cellVal(row, 3),
        plantCode: cellVal(row, 4),
        stockLocationCode: cellVal(row, 5),
        shiftCalendarCode: cellVal(row, 6),
        std: stdPayloadFromRow(row, 7),
        customFields: cfColumns.map((cf) => ({ fieldKey: cf.fieldKey, value: cellVal(row, cf.col) })),
      });
    });
  }

  const result = {
    resourceTypesCreated: 0, resourceTypesSkipped: 0,
    resourcesCreated: 0, resourcesSkipped: 0,
    warnings: [],
  };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existingPlants] = await conn.query(
      'SELECT id, code FROM fab_plants WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const plantByCode = new Map(existingPlants.map((p) => [p.code.toLowerCase(), p.id]));

    const [existingRt] = await conn.query(
      'SELECT id, code FROM fab_resource_types WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const rtByCode = new Map(existingRt.map((r) => [r.code.toLowerCase(), r.id]));
    const rtCodeSet = new Set(existingRt.map((r) => r.code.toUpperCase()));

    const [existingRes] = await conn.query(
      'SELECT code FROM fab_resources WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const resCodeSet = new Set(existingRes.map((r) => r.code.toUpperCase()));

    const [existingSl] = await conn.query(
      'SELECT id, code, plant_id FROM fab_stock_locations WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const slByPlantAndCode = new Map(existingSl.map((s) => [`${s.plant_id}::${s.code.toLowerCase()}`, s.id]));

    const [existingSc] = await conn.query(
      'SELECT id, code FROM fab_shift_calendars WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const scByCode = new Map(existingSc.map((s) => [s.code.toLowerCase(), s.id]));

    const [rtCf] = await conn.query(
      `SELECT DISTINCT field_key, field_type FROM fab_resource_custom_fields
        WHERE company_id = ? AND level = 'resource_type' AND deleted_at IS NULL`,
      [companyId],
    );
    const rtCfTypeByKey = new Map(rtCf.map((cf) => [cf.field_key, cf.field_type]));
    const [resCf] = await conn.query(
      `SELECT DISTINCT field_key, field_type FROM fab_resource_custom_fields
        WHERE company_id = ? AND level = 'resource' AND deleted_at IS NULL`,
      [companyId],
    );
    const resCfTypeByKey = new Map(resCf.map((cf) => [cf.field_key, cf.field_type]));

    function resolvePlant(plantCode, rowNumber) {
      if (!plantCode) return null;
      const id = plantByCode.get(plantCode.toLowerCase());
      if (!id) result.warnings.push({ row: rowNumber, message: `Plant code '${plantCode}' not found — treated as company-wide.` });
      return id ?? null;
    }

    // ── Resource Types ──────────────────────────────────────────────────────
    for (const r of rtRows) {
      let code = r.code ? r.code.trim().toUpperCase() : null;
      if (code && rtCodeSet.has(code)) {
        result.warnings.push({ row: r.rowNumber, message: `Resource type code '${code}' already exists — row skipped.` });
        result.resourceTypesSkipped++;
        continue;
      }
      if (!code) code = uniqueCode(rtCodeSet, r.name);
      else rtCodeSet.add(code);

      const plantId = resolvePlant(r.plantCode, r.rowNumber);

      const [insertRes] = await conn.query(
        `INSERT INTO fab_resource_types
           (company_id, plant_id, name, code, category,
            capacity_hrs_per_day, num_units, utilization_pct, efficiency_pct, overload_pct,
            setup_time_hrs, teardown_time_hrs, queue_time_hrs, move_time_hrs, scheduling_basis,
            cost_per_hour, currency)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [companyId, plantId, r.name.trim(), code, r.category || null,
         r.std.capacity_hrs_per_day, r.std.num_units, r.std.utilization_pct, r.std.efficiency_pct, r.std.overload_pct,
         r.std.setup_time_hrs, r.std.teardown_time_hrs, r.std.queue_time_hrs, r.std.move_time_hrs, r.std.scheduling_basis,
         r.std.cost_per_hour, r.std.currency],
      );
      result.resourceTypesCreated++;
      rtByCode.set(code.toLowerCase(), insertRes.insertId);
      await insertCustomFields(conn, companyId, 'resource_type', insertRes.insertId, r.customFields, rtCfTypeByKey);
    }

    // ── Resources ────────────────────────────────────────────────────────────
    for (const r of resRows) {
      let code = r.code ? r.code.trim().toUpperCase() : null;
      if (code && resCodeSet.has(code)) {
        result.warnings.push({ row: r.rowNumber, message: `Resource code '${code}' already exists — row skipped.` });
        result.resourcesSkipped++;
        continue;
      }

      if (!r.resourceTypeCode) {
        result.warnings.push({ row: r.rowNumber, message: `Resource Type Code is required — row skipped.` });
        result.resourcesSkipped++;
        continue;
      }
      const resourceTypeId = rtByCode.get(r.resourceTypeCode.trim().toLowerCase());
      if (!resourceTypeId) {
        result.warnings.push({ row: r.rowNumber, message: `Resource Type Code '${r.resourceTypeCode}' not found — row skipped.` });
        result.resourcesSkipped++;
        continue;
      }

      if (!code) code = uniqueCode(resCodeSet, r.name);
      else resCodeSet.add(code);

      const plantId = resolvePlant(r.plantCode, r.rowNumber);

      let stockLocationId = null;
      if (r.stockLocationCode) {
        if (plantId == null) {
          result.warnings.push({ row: r.rowNumber, message: `Stock Location Code '${r.stockLocationCode}' ignored — set Plant Code first.` });
        } else {
          stockLocationId = slByPlantAndCode.get(`${plantId}::${r.stockLocationCode.toLowerCase()}`) ?? null;
          if (stockLocationId == null) result.warnings.push({ row: r.rowNumber, message: `Stock Location Code '${r.stockLocationCode}' not found in that plant — ignored.` });
        }
      }

      let shiftCalendarId = null;
      if (r.shiftCalendarCode) {
        shiftCalendarId = scByCode.get(r.shiftCalendarCode.toLowerCase()) ?? null;
        if (shiftCalendarId == null) result.warnings.push({ row: r.rowNumber, message: `Shift Calendar Code '${r.shiftCalendarCode}' not found — ignored.` });
      }

      const [insertRes] = await conn.query(
        `INSERT INTO fab_resources
           (company_id, plant_id, stock_location_id, resource_type_id, name, code,
            capacity_hrs_per_day, num_units, utilization_pct, efficiency_pct, overload_pct,
            setup_time_hrs, teardown_time_hrs, queue_time_hrs, move_time_hrs, scheduling_basis,
            cost_per_hour, currency, shift_calendar_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [companyId, plantId, stockLocationId, resourceTypeId, r.name.trim(), code,
         r.std.capacity_hrs_per_day, r.std.num_units, r.std.utilization_pct, r.std.efficiency_pct, r.std.overload_pct,
         r.std.setup_time_hrs, r.std.teardown_time_hrs, r.std.queue_time_hrs, r.std.move_time_hrs, r.std.scheduling_basis,
         r.std.cost_per_hour, r.std.currency, shiftCalendarId],
      );
      result.resourcesCreated++;
      await insertCustomFields(conn, companyId, 'resource', insertRes.insertId, r.customFields, resCfTypeByKey);
    }

    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
