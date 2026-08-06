/**
 * flowStepsImportService.js — per-flow Operation Flow Steps export/import via Excel.
 *
 * exportFlowStepsTemplate — builds an .xlsx pre-filled with the flow's current
 *   steps (Seq No / Operation Code / Depends On / Resource Type Code / Notes),
 *   plus read-only "Operations" and "Resource Types" reference sheets and an
 *   "Instructions" sheet. Operation Code and Resource Type Code are Excel
 *   dropdown-validated against the company's current operations/resource types.
 *
 * importFlowStepsExcel — parses the "Steps" sheet and REPLACES all steps for
 *   that flow (the sheet is the single source of truth, matching the "fill it
 *   here directly or via import/export" model — both paths converge on the
 *   same state). Operation Code is required and resolved by code; unmatched
 *   rows are skipped with a warning. Resource Type Code is optional.
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

function dropdown(ws, col, list, fromRow, toRow) {
  if (list.length === 0) return;
  for (let r = fromRow; r <= toRow; r++) {
    ws.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${list.join(',')}"`] };
  }
}

// ── export ────────────────────────────────────────────────────────────────────

export async function exportFlowStepsTemplate(flowId, companyId) {
  const wb = new ExcelJS.Workbook();

  const [operations] = await pool.query(
    'SELECT id, code, name FROM fab_operations WHERE company_id = ? AND deleted_at IS NULL ORDER BY name',
    [companyId],
  );
  const [resourceTypes] = await pool.query(
    'SELECT id, code, name FROM fab_resource_types WHERE company_id = ? AND deleted_at IS NULL ORDER BY name',
    [companyId],
  );
  const opById = new Map(operations.map((o) => [o.id, o]));
  const rtById = new Map(resourceTypes.map((rt) => [rt.id, rt]));

  const [steps] = await pool.query(
    `SELECT seq_no, operation_id, depends_on, resource_type_id, notes
       FROM fab_operation_flow_steps
      WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL
      ORDER BY seq_no ASC`,
    [companyId, flowId],
  );

  // ── Sheet 1: Steps ───────────────────────────────────────────────────────
  const ws = wb.addWorksheet('Steps');
  const cols = [
    { header: 'Seq No *',              width: 10 },
    { header: 'Operation Code *',      width: 20 },
    { header: 'Depends On',            width: 16 },
    { header: 'Resource Type Code',    width: 20 },
    { header: 'Notes',                 width: 32 },
  ];
  styledHeader(ws, cols);

  if (steps.length > 0) {
    for (const s of steps) {
      ws.addRow([
        s.seq_no,
        opById.get(s.operation_id)?.code ?? '',
        s.depends_on ?? '',
        s.resource_type_id != null ? (rtById.get(s.resource_type_id)?.code ?? '') : '',
        s.notes ?? '',
      ]);
    }
  } else {
    ws.addRow([1, operations[0]?.code ?? '', '', '', 'Example row — delete before importing']);
    ws.getRow(2).font = { italic: true, color: { argb: 'FF999999' } };
  }

  dropdown(ws, 2, operations.map((o) => o.code), 2, 1000);
  dropdown(ws, 4, resourceTypes.map((rt) => rt.code), 2, 1000);

  // ── Sheet 2: Operations (reference) ─────────────────────────────────────
  const wsOps = wb.addWorksheet('Operations');
  styledHeader(wsOps, [{ header: 'Code', width: 18 }, { header: 'Name', width: 28 }]);
  for (const o of operations) wsOps.addRow([o.code, o.name]);

  // ── Sheet 3: Resource Types (reference) ─────────────────────────────────
  const wsRt = wb.addWorksheet('Resource Types');
  styledHeader(wsRt, [{ header: 'Code', width: 18 }, { header: 'Name', width: 28 }]);
  for (const rt of resourceTypes) wsRt.addRow([rt.code, rt.name]);

  // ── Sheet 4: Instructions ────────────────────────────────────────────────
  const wsHelp = wb.addWorksheet('Instructions');
  wsHelp.getColumn(1).width = 100;
  const lines = [
    'How to use this template',
    '',
    '1. This file is pre-filled with the flow\'s current steps (if any). Edit, add, or remove rows',
    '   on the "Steps" sheet, then re-upload — importing REPLACES this flow\'s entire step list with',
    '   what\'s in the file.',
    '2. Seq No and Operation Code are required. Operation Code must match a code on the "Operations"',
    '   sheet — rows with an unmatched code are skipped.',
    '3. Depends On is a comma-separated list of earlier Seq No values this step waits on, e.g. "1,2".',
    '   Leave blank to run after the immediately preceding step (or first, if this is Seq No 1).',
    '4. Resource Type Code overrides the operation\'s default resource type for this step only —',
    '   leave blank to inherit the default. Must match a code on the "Resource Types" sheet.',
    '5. Notes is free text.',
  ];
  lines.forEach((l) => wsHelp.addRow([l]));
  wsHelp.getRow(1).font = { bold: true, size: 13 };

  return wb.xlsx.writeBuffer();
}

// ── import ────────────────────────────────────────────────────────────────────

export async function importFlowStepsExcel(file, flowId, companyId) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const ws = wb.getWorksheet('Steps');
  if (!ws) throw new Error('Sheet "Steps" not found in the uploaded file. Use the exported template.');

  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const opCode = cellVal(row, 2);
    const seqNo = numVal(row, 1);
    if (!opCode && seqNo == null) return; // blank row
    rows.push({
      rowNumber,
      seqNo,
      opCode,
      dependsOn: cellVal(row, 3),
      rtCode: cellVal(row, 4),
      notes: cellVal(row, 5),
    });
  });

  const result = { stepsCreated: 0, warnings: [] };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [operations] = await conn.query(
      'SELECT id, code FROM fab_operations WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const opByCode = new Map(operations.map((o) => [o.code.toLowerCase(), o.id]));

    const [resourceTypes] = await conn.query(
      'SELECT id, code FROM fab_resource_types WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const rtByCode = new Map(resourceTypes.map((rt) => [rt.code.toLowerCase(), rt.id]));

    await conn.query(
      'UPDATE fab_operation_flow_steps SET deleted_at = UTC_TIMESTAMP() WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL',
      [companyId, flowId],
    );

    for (const r of rows) {
      if (r.seqNo == null || r.seqNo < 1) {
        result.warnings.push({ row: r.rowNumber, message: 'Seq No is required and must be a positive number — row skipped.' });
        continue;
      }
      if (!r.opCode) {
        result.warnings.push({ row: r.rowNumber, message: 'Operation Code is required — row skipped.' });
        continue;
      }
      const operationId = opByCode.get(r.opCode.trim().toLowerCase());
      if (!operationId) {
        result.warnings.push({ row: r.rowNumber, message: `Operation Code '${r.opCode}' not found — row skipped.` });
        continue;
      }

      let resourceTypeId = null;
      if (r.rtCode) {
        resourceTypeId = rtByCode.get(r.rtCode.trim().toLowerCase()) ?? null;
        if (resourceTypeId == null) result.warnings.push({ row: r.rowNumber, message: `Resource Type Code '${r.rtCode}' not found — left blank.` });
      }

      await conn.query(
        `INSERT INTO fab_operation_flow_steps (company_id, flow_id, operation_id, seq_no, depends_on, resource_type_id, notes)
         VALUES (?,?,?,?,?,?,?)`,
        [companyId, flowId, operationId, r.seqNo, r.dependsOn || null, resourceTypeId, r.notes || null],
      );
      result.stepsCreated++;
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
