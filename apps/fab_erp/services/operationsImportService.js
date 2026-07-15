/**
 * operationsImportService.js — bulk Operations export/import via Excel.
 *
 * exportOperationsTemplate — builds an .xlsx with a fill-in "Operations" sheet
 *   (Default Resource Type Code + Time Unit + Active are dropdown-validated),
 *   a read-only "Resource Types" reference sheet, and an "Instructions" sheet.
 *   Time formula / operation variables are UI-only and intentionally excluded.
 *
 * importOperationsExcel — parses the "Operations" sheet and inserts
 *   operations. Existing codes are skipped (never overwritten by import).
 *   "Mapped Resource Type Codes" (comma-separated) creates rows in
 *   fab_operation_resource_types for each code that resolves.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';

const TIME_UNITS = ['min', 'hr', 'sec'];
const YES_NO = ['yes', 'no'];

// ── helpers ───────────────────────────────────────────────────────────────────

function cellVal(row, col) {
  const c = row.getCell(col);
  if (c.value === null || c.value === undefined) return null;
  if (typeof c.value === 'object' && c.value.text)                 return String(c.value.text).trim();
  if (typeof c.value === 'object' && c.value.result !== undefined) return String(c.value.result).trim();
  return String(c.value).trim() || null;
}

function autoCode(name, maxLen = 20) {
  const c = (name || '').trim().toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return c || 'CODE';
}

function uniqueCode(codeSet, name, maxLen = 20) {
  const code = autoCode(name, maxLen);
  if (!codeSet.has(code)) { codeSet.add(code); return code; }
  const base = autoCode(name, maxLen - 4);
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

// ── export ────────────────────────────────────────────────────────────────────

export async function exportOperationsTemplate(companyId) {
  const wb = new ExcelJS.Workbook();

  const [resourceTypes] = await pool.query(
    'SELECT code, name FROM fab_resource_types WHERE company_id = ? AND deleted_at IS NULL ORDER BY name',
    [companyId],
  );
  const rtCodes = resourceTypes.map((rt) => rt.code);

  // ── Sheet 1: Operations ──────────────────────────────────────────────────
  const ws = wb.addWorksheet('Operations');
  const cols = [
    { header: 'Code *',                       width: 16 },
    { header: 'Name *',                       width: 28 },
    { header: 'Default Resource Type Code',   width: 22 },
    { header: 'Mapped Resource Type Codes',   width: 28 },
    { header: 'Time Unit',                    width: 12 },
    { header: 'Active',                       width: 10 },
  ];
  styledHeader(ws, cols);

  ws.addRow(['CUT', 'Cut', rtCodes[0] ?? '', rtCodes[0] ?? '', 'min', 'yes']);
  ws.getRow(2).font = { italic: true, color: { argb: 'FF999999' } };

  if (rtCodes.length > 0) dropdown(ws, 3, rtCodes, 2, 1000);
  dropdown(ws, 5, TIME_UNITS, 2, 1000);
  dropdown(ws, 6, YES_NO, 2, 1000);

  // ── Sheet 2: Resource Types (reference) ─────────────────────────────────
  const wsRef = wb.addWorksheet('Resource Types');
  styledHeader(wsRef, [
    { header: 'Code', width: 18 },
    { header: 'Name', width: 28 },
  ]);
  for (const rt of resourceTypes) wsRef.addRow([rt.code, rt.name]);

  // ── Sheet 3: Instructions ────────────────────────────────────────────────
  const wsHelp = wb.addWorksheet('Instructions');
  wsHelp.getColumn(1).width = 100;
  const lines = [
    'How to use this template',
    '',
    '1. Fill in rows on the "Operations" sheet. Delete the example row (row 2) before importing.',
    '2. Code and Name are required. If a Code already exists for this company, that row is skipped',
    '   (existing operations are never overwritten by import).',
    '3. Default Resource Type Code sets the operation\'s default resource type — pick from the',
    '   dropdown (built from the "Resource Types" sheet). Leave blank for none.',
    '4. Mapped Resource Type Codes accepts multiple codes as a comma-separated list, e.g. "LATHE,MILL"',
    '   — each maps this operation to that resource type (Operations > Resource Types tab). Unknown',
    '   codes are skipped with a warning; known ones are still applied.',
    '5. Time Unit: min, hr or sec (default: min). Active: yes or no (default: yes).',
    '6. Time formulas and operation-scoped variables are not covered by this template — set those up',
    '   in the Operations screen after import.',
  ];
  lines.forEach((l) => wsHelp.addRow([l]));
  wsHelp.getRow(1).font = { bold: true, size: 13 };

  return wb.xlsx.writeBuffer();
}

// ── import ────────────────────────────────────────────────────────────────────

export async function importOperationsExcel(file, companyId) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const ws = wb.getWorksheet('Operations');
  if (!ws) throw new Error('Sheet "Operations" not found in the uploaded file. Use the exported template.');

  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = cellVal(row, 2);
    if (!name) return;
    rows.push({
      rowNumber,
      code: cellVal(row, 1),
      name,
      defaultRtCode: cellVal(row, 3),
      mappedRtCodesRaw: cellVal(row, 4),
      timeUnitRaw: (cellVal(row, 5) || '').toLowerCase(),
      activeRaw: (cellVal(row, 6) || '').toLowerCase(),
    });
  });

  const result = { operationsCreated: 0, operationsSkipped: 0, mappingsCreated: 0, warnings: [] };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existingOps] = await conn.query(
      'SELECT code FROM fab_operations WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const opCodeSet = new Set(existingOps.map((o) => o.code.toUpperCase()));

    const [existingRt] = await conn.query(
      'SELECT id, code FROM fab_resource_types WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const rtByCode = new Map(existingRt.map((rt) => [rt.code.toLowerCase(), rt.id]));

    for (const r of rows) {
      let code = r.code ? r.code.trim().toUpperCase() : null;
      if (code && opCodeSet.has(code)) {
        result.warnings.push({ row: r.rowNumber, message: `Operation code '${code}' already exists — row skipped.` });
        result.operationsSkipped++;
        continue;
      }
      if (!code) code = uniqueCode(opCodeSet, r.name);
      else opCodeSet.add(code);

      let defaultRtId = null;
      if (r.defaultRtCode) {
        defaultRtId = rtByCode.get(r.defaultRtCode.trim().toLowerCase()) ?? null;
        if (defaultRtId == null) result.warnings.push({ row: r.rowNumber, message: `Default Resource Type Code '${r.defaultRtCode}' not found — left blank.` });
      }

      let timeUnit = 'min';
      if (r.timeUnitRaw) {
        if (TIME_UNITS.includes(r.timeUnitRaw)) timeUnit = r.timeUnitRaw;
        else result.warnings.push({ row: r.rowNumber, message: `Unrecognised Time Unit — defaulted to 'min'.` });
      }

      let active = 1;
      if (r.activeRaw) {
        if (r.activeRaw === 'no') active = 0;
        else if (r.activeRaw !== 'yes') result.warnings.push({ row: r.rowNumber, message: `Unrecognised Active value — defaulted to 'yes'.` });
      }

      const [insertRes] = await conn.query(
        `INSERT INTO fab_operations (company_id, name, code, default_resource_type_id, time_formula, time_unit, active)
         VALUES (?,?,?,?,?,?,?)`,
        [companyId, r.name.trim(), code, defaultRtId, null, timeUnit, active],
      );
      result.operationsCreated++;
      const operationId = insertRes.insertId;

      if (r.mappedRtCodesRaw) {
        const codes = r.mappedRtCodesRaw.split(',').map((c) => c.trim()).filter(Boolean);
        const seen = new Set();
        for (const mc of codes) {
          const rtId = rtByCode.get(mc.toLowerCase());
          if (rtId == null) {
            result.warnings.push({ row: r.rowNumber, message: `Mapped Resource Type Code '${mc}' not found — skipped.` });
            continue;
          }
          if (seen.has(rtId)) continue;
          seen.add(rtId);
          await conn.query(
            'INSERT INTO fab_operation_resource_types (company_id, operation_id, resource_type_id) VALUES (?,?,?)',
            [companyId, operationId, rtId],
          );
          result.mappingsCreated++;
        }
      }
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
