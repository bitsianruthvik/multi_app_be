import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function cellVal(row, col) {
  const c = row.getCell(col);
  if (c.value === null || c.value === undefined) return null;
  if (typeof c.value === 'object' && c.value.text)              return String(c.value.text).trim();
  if (typeof c.value === 'object' && c.value.result !== undefined) return c.value.result;
  return String(c.value).trim() || null;
}

function numVal(row, col) {
  const v = cellVal(row, col);
  if (v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function boolVal(row, col, defaultVal = true) {
  const v = (cellVal(row, col) ?? '').toLowerCase();
  if (v === 'yes' || v === '1' || v === 'true') return 1;
  if (v === 'no'  || v === '0' || v === 'false') return 0;
  return defaultVal ? 1 : 0;
}

function issue(list, sheet, rowNum, severity, field, message) {
  list.push({ sheet_name: sheet, row_number: rowNum, severity, field_name: field, message });
}

// ── parse ─────────────────────────────────────────────────────────────────────

export async function parseCapacityExcel(file, userId, companyId) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const issues = [];

  // ── Work_Calendars ────────────────────────────────────────────────────────
  const calendars   = [];
  const calCodeSet  = new Set();
  const sWC = wb.getWorksheet('Work_Calendars');
  if (sWC) {
    sWC.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const code = cellVal(row, 1);
      if (!code) return;
      if (calCodeSet.has(code)) {
        issue(issues, 'Work_Calendars', rowNum, 'Warning', 'calendar_code', `Duplicate calendar_code: ${code}`);
      }
      calCodeSet.add(code);
      calendars.push({
        calendar_code: code,
        calendar_name: cellVal(row, 2) ?? code,
        description:   cellVal(row, 3),
        active:        boolVal(row, 4),
        _row:          rowNum,
      });
      if (!cellVal(row, 2)) issue(issues, 'Work_Calendars', rowNum, 'Warning', 'calendar_name', `calendar_name missing for ${code}`);
    });
  }

  // ── Work_Calendar_Days ────────────────────────────────────────────────────
  const calDays    = [];
  const VALID_DAYS = new Set(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']);
  const sCD = wb.getWorksheet('Work_Calendar_Days');
  if (sCD) {
    sCD.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const code = cellVal(row, 1);
      const day  = cellVal(row, 2);
      if (!code && !day) return;
      if (code && !calCodeSet.has(code)) {
        issue(issues, 'Work_Calendar_Days', rowNum, 'Error', 'calendar_code', `calendar_code '${code}' not found in Work_Calendars sheet`);
      }
      if (day && !VALID_DAYS.has(day)) {
        issue(issues, 'Work_Calendar_Days', rowNum, 'Error', 'day_of_week', `day_of_week '${day}' is invalid`);
      }
      calDays.push({
        calendar_code:  code,
        day_of_week:    day,
        is_working_day: boolVal(row, 3),
        start_time:     cellVal(row, 4),
        end_time:       cellVal(row, 5),
        working_hours:  numVal(row, 6) ?? 0,
        _row:           rowNum,
      });
    });
  }

  // ── Work_Calendar_Exceptions ──────────────────────────────────────────────
  const calExceptions = [];
  const sCE = wb.getWorksheet('Work_Calendar_Exceptions');
  if (sCE) {
    sCE.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const code      = cellVal(row, 1);
      const dateRaw   = cellVal(row, 2);
      if (!code && !dateRaw) return;
      if (code && !calCodeSet.has(code)) {
        issue(issues, 'Work_Calendar_Exceptions', rowNum, 'Error', 'calendar_code', `calendar_code '${code}' not found`);
      }
      if (!dateRaw) {
        issue(issues, 'Work_Calendar_Exceptions', rowNum, 'Error', 'exception_date', 'exception_date is required');
      }
      // Normalise date: ExcelJS may give a Date object or string
      let dateStr = null;
      if (dateRaw) {
        if (dateRaw instanceof Date) {
          dateStr = dateRaw.toISOString().slice(0, 10);
        } else {
          dateStr = String(dateRaw).slice(0, 10);
        }
      }
      calExceptions.push({
        calendar_code:  code,
        exception_date: dateStr,
        exception_name: cellVal(row, 3),
        is_working_day: boolVal(row, 4, false),
        start_time:     cellVal(row, 5),
        end_time:       cellVal(row, 6),
        working_hours:  numVal(row, 7) ?? 0,
        notes:          cellVal(row, 8),
        _row:           rowNum,
      });
    });
  }

  // ── Work_Areas ────────────────────────────────────────────────────────────
  const workAreas   = [];
  const waCodeSet   = new Set();
  const sWA = wb.getWorksheet('Work_Areas');
  if (sWA) {
    sWA.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const code = cellVal(row, 1);
      if (!code) return;
      if (waCodeSet.has(code)) {
        issue(issues, 'Work_Areas', rowNum, 'Warning', 'work_area_code', `Duplicate work_area_code: ${code}`);
      }
      waCodeSet.add(code);
      const calCode = cellVal(row, 5);
      if (calCode && !calCodeSet.has(calCode)) {
        issue(issues, 'Work_Areas', rowNum, 'Error', 'calendar_code', `calendar_code '${calCode}' not found in Work_Calendars sheet`);
      }
      const maxParallel = numVal(row, 4);
      if (maxParallel !== null && maxParallel <= 0) {
        issue(issues, 'Work_Areas', rowNum, 'Error', 'max_parallel_jobs', 'max_parallel_jobs must be positive');
      }
      if (!cellVal(row, 2)) issue(issues, 'Work_Areas', rowNum, 'Error', 'work_area_name', `work_area_name required for ${code}`);
      workAreas.push({
        work_area_code:    code,
        work_area_name:    cellVal(row, 2) ?? code,
        area_type:         cellVal(row, 3),
        max_parallel_jobs: maxParallel ?? 1,
        calendar_code:     calCode,
        active:            boolVal(row, 6),
        notes:             cellVal(row, 7),
        _row:              rowNum,
      });
    });
  }

  // ── Work_Area_Capabilities ────────────────────────────────────────────────
  const waCaps = [];
  const sWAC = wb.getWorksheet('Work_Area_Capabilities');
  if (sWAC) {
    sWAC.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const waCode   = cellVal(row, 1);
      const procType = cellVal(row, 2);
      if (!waCode && !procType) return;
      if (waCode && !waCodeSet.has(waCode)) {
        issue(issues, 'Work_Area_Capabilities', rowNum, 'Error', 'work_area_code', `work_area_code '${waCode}' not found`);
      }
      if (!procType) {
        issue(issues, 'Work_Area_Capabilities', rowNum, 'Error', 'process_type', 'process_type is required');
      }
      waCaps.push({
        work_area_code: waCode,
        process_type:   procType,
        allowed:        boolVal(row, 3),
        priority:       numVal(row, 4) ?? 1,
        notes:          cellVal(row, 5),
        _row:           rowNum,
      });
    });
  }

  // ── Machines ──────────────────────────────────────────────────────────────
  const machines    = [];
  const machCodeSet = new Set();
  const sMach = wb.getWorksheet('Machines');
  if (sMach) {
    sMach.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const code = cellVal(row, 1);
      if (!code) return;
      if (machCodeSet.has(code)) {
        issue(issues, 'Machines', rowNum, 'Warning', 'machine_code', `Duplicate machine_code: ${code}`);
      }
      machCodeSet.add(code);
      const waCode  = cellVal(row, 4);
      const calCode = cellVal(row, 5);
      if (waCode && !waCodeSet.has(waCode)) {
        issue(issues, 'Machines', rowNum, 'Error', 'work_area_code', `work_area_code '${waCode}' not found`);
      }
      if (calCode && !calCodeSet.has(calCode)) {
        issue(issues, 'Machines', rowNum, 'Error', 'calendar_code', `calendar_code '${calCode}' not found`);
      }
      if (!cellVal(row, 2)) issue(issues, 'Machines', rowNum, 'Error', 'machine_name', `machine_name required for ${code}`);
      machines.push({
        machine_code:   code,
        machine_name:   cellVal(row, 2) ?? code,
        machine_type:   cellVal(row, 3),
        work_area_code: waCode,
        calendar_code:  calCode,
        active:         boolVal(row, 6),
        notes:          cellVal(row, 7),
        _row:           rowNum,
      });
    });
  }

  // ── Machine_Capabilities ──────────────────────────────────────────────────
  const machineCaps = [];
  const sMC = wb.getWorksheet('Machine_Capabilities');
  if (sMC) {
    sMC.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const machCode = cellVal(row, 1);
      const procType = cellVal(row, 2);
      if (!machCode && !procType) return;
      if (machCode && !machCodeSet.has(machCode)) {
        issue(issues, 'Machine_Capabilities', rowNum, 'Error', 'machine_code', `machine_code '${machCode}' not found`);
      }
      if (!procType) {
        issue(issues, 'Machine_Capabilities', rowNum, 'Error', 'process_type', 'process_type is required');
      }
      const capacity = numVal(row, 3);
      if (capacity !== null && capacity < 0) {
        issue(issues, 'Machine_Capabilities', rowNum, 'Error', 'capacity_hours_per_day', 'capacity_hours_per_day must be non-negative');
      }
      machineCaps.push({
        machine_code:           machCode,
        process_type:           procType,
        capacity_hours_per_day: capacity ?? 10,
        priority:               numVal(row, 4) ?? 1,
        notes:                  cellVal(row, 5),
        _row:                   rowNum,
      });
    });
  }

  const errorCount   = issues.filter((i) => i.severity === 'Error').length;
  const warningCount = issues.filter((i) => i.severity === 'Warning').length;

  const [batchRes] = await pool.query(
    `INSERT INTO fab_capacity_import_batches
       (company_id, file_name, uploaded_by, status, error_count, warning_count, parsed_data)
     VALUES (?,?,?,?,?,?,?)`,
    [companyId, file.originalname, userId,
     errorCount > 0 ? 'Failed' : 'Parsed',
     errorCount, warningCount,
     JSON.stringify({ calendars, calDays, calExceptions, workAreas, waCaps, machines, machineCaps })],
  );
  const batchId = batchRes.insertId;

  if (issues.length) {
    // Reuse fab_excel_import_issues to keep the table generic
    await pool.query(
      `INSERT INTO fab_excel_import_issues (import_batch_id, sheet_name, \`row_number\`, severity, field_name, message) VALUES ?`,
      [issues.map((i) => [batchId, i.sheet_name, i.row_number, i.severity, i.field_name, i.message])],
    );
  }

  return {
    batchId,
    status:       errorCount > 0 ? 'Failed' : 'Parsed',
    errorCount,
    warningCount,
    preview:      { calendars, calDays, calExceptions, workAreas, waCaps, machines, machineCaps },
    issues,
  };
}

// ── import ────────────────────────────────────────────────────────────────────

export async function importCapacityBatch(batchId, userId, companyId) {
  const [[batch]] = await pool.query(
    'SELECT * FROM fab_capacity_import_batches WHERE id = ? AND company_id = ?',
    [batchId, companyId],
  );
  if (!batch)                    throw new Error('Batch not found');
  if (batch.status !== 'Parsed') throw new Error(`Batch status is '${batch.status}' — only Parsed batches can be imported`);

  const { calendars, calDays, calExceptions, workAreas, waCaps, machines, machineCaps } =
    JSON.parse(batch.parsed_data);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ── Calendars (UPSERT by code) ─────────────────────────────────────────
    const calCodeToId = {};
    for (const c of calendars) {
      await conn.query(
        `INSERT INTO fab_work_calendars (company_id, calendar_code, calendar_name, description, active)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE calendar_name=VALUES(calendar_name), description=VALUES(description), active=VALUES(active), deleted_at=NULL`,
        [companyId, c.calendar_code, c.calendar_name, c.description, c.active],
      );
      const [[row]] = await conn.query(
        'SELECT id FROM fab_work_calendars WHERE company_id = ? AND calendar_code = ?',
        [companyId, c.calendar_code],
      );
      calCodeToId[c.calendar_code] = row.id;
    }

    // ── Calendar days: replace all days for each touched calendar ─────────
    const touchedCalIds = new Set(Object.values(calCodeToId));
    for (const calId of touchedCalIds) {
      await conn.query('DELETE FROM fab_work_calendar_days WHERE calendar_id = ? AND company_id = ?', [calId, companyId]);
    }
    for (const d of calDays) {
      const calId = calCodeToId[d.calendar_code];
      if (!calId || !d.day_of_week) continue;
      await conn.query(
        `INSERT INTO fab_work_calendar_days
           (calendar_id, company_id, day_of_week, is_working_day, start_time, end_time, working_hours)
         VALUES (?,?,?,?,?,?,?)`,
        [calId, companyId, d.day_of_week, d.is_working_day, d.start_time, d.end_time, d.working_hours],
      );
    }

    // ── Calendar exceptions: replace per calendar ─────────────────────────
    for (const calId of touchedCalIds) {
      await conn.query('DELETE FROM fab_work_calendar_exceptions WHERE calendar_id = ? AND company_id = ?', [calId, companyId]);
    }
    for (const e of calExceptions) {
      const calId = calCodeToId[e.calendar_code];
      if (!calId || !e.exception_date) continue;
      await conn.query(
        `INSERT INTO fab_work_calendar_exceptions
           (calendar_id, company_id, exception_date, exception_name, is_working_day, start_time, end_time, working_hours, notes)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [calId, companyId, e.exception_date, e.exception_name, e.is_working_day,
         e.start_time, e.end_time, e.working_hours, e.notes],
      );
    }

    // ── Work Areas (UPSERT by code) ────────────────────────────────────────
    const waCodeToId = {};
    for (const wa of workAreas) {
      const calId = wa.calendar_code ? (calCodeToId[wa.calendar_code] ?? null) : null;
      await conn.query(
        `INSERT INTO fab_work_areas
           (company_id, work_area_code, work_area_name, area_type, max_parallel_jobs, calendar_id, active, notes)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           work_area_name=VALUES(work_area_name), area_type=VALUES(area_type),
           max_parallel_jobs=VALUES(max_parallel_jobs), calendar_id=VALUES(calendar_id),
           active=VALUES(active), notes=VALUES(notes), deleted_at=NULL`,
        [companyId, wa.work_area_code, wa.work_area_name, wa.area_type,
         wa.max_parallel_jobs, calId, wa.active, wa.notes],
      );
      const [[row]] = await conn.query(
        'SELECT id FROM fab_work_areas WHERE company_id = ? AND work_area_code = ?',
        [companyId, wa.work_area_code],
      );
      waCodeToId[wa.work_area_code] = row.id;
    }

    // ── Work Area Capabilities: replace per touched area ──────────────────
    const touchedWaIds = new Set(Object.values(waCodeToId));
    for (const waId of touchedWaIds) {
      await conn.query('DELETE FROM fab_work_area_capabilities WHERE work_area_id = ? AND company_id = ?', [waId, companyId]);
    }
    for (const cap of waCaps) {
      const waId = waCodeToId[cap.work_area_code];
      if (!waId || !cap.process_type) continue;
      await conn.query(
        `INSERT INTO fab_work_area_capabilities
           (work_area_id, company_id, process_type, allowed, priority, notes)
         VALUES (?,?,?,?,?,?)`,
        [waId, companyId, cap.process_type, cap.allowed, cap.priority, cap.notes],
      );
    }

    // ── Machines (UPSERT by code) ──────────────────────────────────────────
    const machCodeToId = {};
    for (const m of machines) {
      const waId  = m.work_area_code ? (waCodeToId[m.work_area_code] ?? null) : null;
      const calId = m.calendar_code  ? (calCodeToId[m.calendar_code] ?? null) : null;
      await conn.query(
        `INSERT INTO fab_machines
           (company_id, machine_code, machine_name, machine_type, work_area_id, calendar_id, active, notes)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           machine_name=VALUES(machine_name), machine_type=VALUES(machine_type),
           work_area_id=VALUES(work_area_id), calendar_id=VALUES(calendar_id),
           active=VALUES(active), notes=VALUES(notes), deleted_at=NULL`,
        [companyId, m.machine_code, m.machine_name, m.machine_type, waId, calId, m.active, m.notes],
      );
      const [[row]] = await conn.query(
        'SELECT id FROM fab_machines WHERE company_id = ? AND machine_code = ?',
        [companyId, m.machine_code],
      );
      machCodeToId[m.machine_code] = row.id;
    }

    // ── Machine Capabilities: replace per touched machine ─────────────────
    const touchedMachIds = new Set(Object.values(machCodeToId));
    for (const machId of touchedMachIds) {
      await conn.query('DELETE FROM fab_machine_capabilities WHERE machine_id = ? AND company_id = ?', [machId, companyId]);
    }
    for (const mc of machineCaps) {
      const machId = machCodeToId[mc.machine_code];
      if (!machId || !mc.process_type) continue;
      await conn.query(
        `INSERT INTO fab_machine_capabilities
           (machine_id, company_id, process_type, capacity_hours_per_day, priority, notes)
         VALUES (?,?,?,?,?,?)`,
        [machId, companyId, mc.process_type, mc.capacity_hours_per_day, mc.priority, mc.notes],
      );
    }

    await conn.query(
      `UPDATE fab_capacity_import_batches SET status = 'Imported' WHERE id = ?`,
      [batchId],
    );

    await conn.commit();
    return {
      calendarsImported:   calendars.length,
      calDaysImported:     calDays.length,
      exceptionsImported:  calExceptions.length,
      workAreasImported:   workAreas.length,
      waCapsImported:      waCaps.length,
      machinesImported:    machines.length,
      machineCapsImported: machineCaps.length,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
