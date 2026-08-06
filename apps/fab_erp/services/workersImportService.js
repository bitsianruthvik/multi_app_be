/**
 * workersImportService.js — bulk roster load from Excel.
 *
 * exportWorkersTemplate — a "People" sheet, plus read-only "Reference" sheets
 *   listing the shifts and machines that can be referenced BY NAME, and an
 *   "Instructions" sheet.
 *
 * importWorkersExcel — parses the People sheet, resolves shift and machine by
 *   name or code (case-insensitive), and creates workers with their opening
 *   shift and machine intervals in one pass.
 *
 * WHY THE WHOLE FILE IS VALIDATED BEFORE ANYTHING IS WRITTEN
 * ---------------------------------------------------------
 * A partial import is worse than a rejected one. If row 37 of 40 has an unknown
 * shift name and rows 1–36 are already committed, the operator's next action is
 * to fix row 37 and re-upload the same file — which duplicates the first 36
 * people. Duplicate workers then both appear in `crewForWindow`, and
 * `coveredIntervals` unions their assignments, so the machine reads as crewed
 * twice over and `no_operator` under-reports. The roster is an input to delay
 * attribution, so "mostly imported" is not a usable state.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { assignWorker, assignShift } from './workerService.js';

const WORKER_TYPES = ['employee', 'contractor', 'vendor'];

const COLUMNS = [
  { header: 'Name',            key: 'name',       width: 26 },
  { header: 'Badge / ID',      key: 'code',       width: 16 },
  { header: 'Type',            key: 'workerType', width: 14 },
  { header: 'Agency / Supplier', key: 'vendorName', width: 24 },
  { header: 'Phone',           key: 'phone',      width: 16 },
  { header: 'Shift',           key: 'shift',      width: 20 },
  { header: 'Machine',         key: 'machine',    width: 24 },
];

function cellVal(row, col) {
  const c = row.getCell(col);
  const v = c.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v.text) return String(v.text).trim() || null;
  if (typeof v === 'object' && v.result !== undefined) return String(v.result).trim() || null;
  return String(v).trim() || null;
}

const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());

// ── template ────────────────────────────────────────────────────────────────

export async function exportWorkersTemplate(companyId) {
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet('People');
  ws.columns = COLUMNS;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } };
  // One filled example row so the expected shape is obvious without reading the
  // instructions — the vendor case is used because it is the one people get
  // wrong (they try to invent an email for somebody who has no login).
  ws.addRow({
    name: 'Ramesh Kumar', code: 'W-104', workerType: 'contractor',
    vendorName: 'Sri Balaji Fabricators', phone: '9876543210',
    shift: 'Night', machine: 'CNC Drill #1',
  });

  const [shifts] = await pool.query(
    `SELECT s.name, s.start_time AS startTime, s.end_time AS endTime,
            s.working_minutes AS workingMinutes, c.name AS calendarName
       FROM fab_shifts s
       LEFT JOIN fab_shift_calendars c ON c.id = s.calendar_id
      WHERE s.company_id = ? AND s.deleted_at IS NULL
      ORDER BY c.name, s.name`,
    [companyId],
  );
  const sref = wb.addWorksheet('Reference — Shifts');
  sref.columns = [
    { header: 'Shift', width: 20 }, { header: 'Starts', width: 12 },
    { header: 'Ends', width: 12 }, { header: 'Working minutes', width: 16 },
    { header: 'Calendar', width: 22 },
  ].map((c, i) => ({ ...c, key: `c${i}` }));
  sref.getRow(1).font = { bold: true };
  for (const s of shifts) {
    sref.addRow([s.name, String(s.startTime), String(s.endTime), s.workingMinutes, s.calendarName]);
  }

  const [machines] = await pool.query(
    `SELECT name, code FROM fab_resources
      WHERE company_id = ? AND deleted_at IS NULL ORDER BY name`,
    [companyId],
  );
  const mref = wb.addWorksheet('Reference — Machines');
  mref.columns = [{ header: 'Machine', key: 'n', width: 28 }, { header: 'Code', key: 'c', width: 18 }];
  mref.getRow(1).font = { bold: true };
  for (const m of machines) mref.addRow([m.name, m.code]);

  const ins = wb.addWorksheet('Instructions');
  ins.columns = [{ header: 'How to fill this in', key: 'i', width: 110 }];
  ins.getRow(1).font = { bold: true };
  [
    'Name is the only required column. Everything else can be left blank.',
    '',
    'Type — employee, contractor or vendor. Blank means employee.',
    'Contract and vendor staff do NOT need a login, an email or an account.',
    'A name is genuinely enough; put the agency in "Agency / Supplier".',
    '',
    'Shift — must match a name on the "Reference — Shifts" sheet.',
    'A shift that runs past midnight (e.g. 22:00 to 06:00) is handled correctly;',
    'enter it as it is written on the board.',
    '',
    'Machine — must match a name or code on the "Reference — Machines" sheet.',
    'This puts the person on that machine from the moment the file is imported.',
    '',
    'The whole file is checked before anything is saved. If any row has a problem,',
    'nothing is imported and you get a list of the rows to fix — so it is safe to',
    'correct the file and upload it again.',
  ].forEach((t) => ins.addRow([t]));

  return wb.xlsx.writeBuffer();
}

// ── import ──────────────────────────────────────────────────────────────────

export async function importWorkersExcel(file, companyId, enteredBy = null) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  try { fs.unlinkSync(file.path); } catch { /* temp file cleanup is best-effort */ }

  const ws = wb.getWorksheet('People') ?? wb.worksheets[0];
  if (!ws) throw new Error('No "People" sheet found in the uploaded file.');

  const [shifts] = await pool.query(
    `SELECT id, name FROM fab_shifts WHERE company_id = ? AND deleted_at IS NULL`, [companyId],
  );
  const [machines] = await pool.query(
    `SELECT id, name, code FROM fab_resources WHERE company_id = ? AND deleted_at IS NULL`, [companyId],
  );
  const [existing] = await pool.query(
    `SELECT name, code FROM fab_workers WHERE company_id = ? AND deleted_at IS NULL`, [companyId],
  );

  const shiftBy = new Map(shifts.map((s) => [norm(s.name), s.id]));
  const machineBy = new Map();
  for (const m of machines) {
    machineBy.set(norm(m.name), m.id);
    if (m.code) machineBy.set(norm(m.code), m.id);
  }
  const existingNames = new Set(existing.map((w) => norm(w.name)));
  const existingCodes = new Set(existing.filter((w) => w.code).map((w) => norm(w.code)));

  const parsed = [];
  const errors = [];
  const seenNames = new Set();
  const seenCodes = new Set();

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const name = cellVal(row, 1);
    const code = cellVal(row, 2);
    const typeRaw = cellVal(row, 3);
    const vendorName = cellVal(row, 4);
    const phone = cellVal(row, 5);
    const shiftName = cellVal(row, 6);
    const machineName = cellVal(row, 7);

    // A row with nothing in it is trailing whitespace in the sheet, not an error.
    if (!name && !code && !typeRaw && !vendorName && !phone && !shiftName && !machineName) return;

    const at = (msg) => errors.push({ row: rowNumber, message: msg });

    if (!name) { at('Name is required.'); return; }

    const workerType = typeRaw ? norm(typeRaw) : 'employee';
    if (!WORKER_TYPES.includes(workerType)) {
      at(`Type "${typeRaw}" is not one of: ${WORKER_TYPES.join(', ')}.`);
      return;
    }

    // Duplicates are rejected rather than merged. Two rows for one person would
    // create two fab_workers, and coveredIntervals() unions their assignments —
    // the machine would read as crewed twice and no_operator would under-report.
    if (seenNames.has(norm(name))) { at(`"${name}" appears more than once in this file.`); return; }
    if (existingNames.has(norm(name))) { at(`"${name}" is already on the roster.`); return; }
    seenNames.add(norm(name));

    if (code) {
      if (seenCodes.has(norm(code))) { at(`Badge "${code}" appears more than once in this file.`); return; }
      if (existingCodes.has(norm(code))) { at(`Badge "${code}" is already in use.`); return; }
      seenCodes.add(norm(code));
    }

    let shiftId = null;
    if (shiftName) {
      shiftId = shiftBy.get(norm(shiftName)) ?? null;
      if (!shiftId) { at(`Shift "${shiftName}" does not exist. See the Reference — Shifts sheet.`); return; }
    }

    let resourceId = null;
    if (machineName) {
      resourceId = machineBy.get(norm(machineName)) ?? null;
      if (!resourceId) { at(`Machine "${machineName}" does not exist. See the Reference — Machines sheet.`); return; }
    }

    parsed.push({ row: rowNumber, name, code, workerType, vendorName, phone, shiftId, resourceId });
  });

  // Nothing is written unless the whole file is clean — see the header note.
  if (errors.length) {
    return { ok: false, imported: 0, errors, rowsRead: parsed.length + errors.length };
  }
  if (!parsed.length) {
    return { ok: false, imported: 0, errors: [{ row: 0, message: 'The People sheet has no rows.' }], rowsRead: 0 };
  }

  const created = [];
  for (const p of parsed) {
    const [ins] = await pool.query(
      `INSERT INTO fab_workers (company_id, name, code, worker_type, vendor_name, phone, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [companyId, p.name, p.code, p.workerType, p.vendorName, p.phone],
    );
    const id = ins.insertId;
    if (p.shiftId) await assignShift(companyId, { workerId: id, shiftId: p.shiftId, enteredBy });
    if (p.resourceId) await assignWorker(companyId, { workerId: id, resourceId: p.resourceId, enteredBy });
    created.push({ id, name: p.name, row: p.row });
  }

  return {
    ok: true,
    imported: created.length,
    withShift: parsed.filter((p) => p.shiftId).length,
    withMachine: parsed.filter((p) => p.resourceId).length,
    errors: [],
    people: created,
  };
}
