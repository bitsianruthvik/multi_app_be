import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';

// ── shared helpers ────────────────────────────────────────────────────────────

const AREA_TYPES    = ['Assembly','Drilling','Cutting','Welding','Blasting','Painting','Inspection','Fabrication','Other'];
const PROCESS_TYPES = ['Cutting','Drilling','Fit-up','MIG Welding','SAW Welding','Stud Welding','Grinding','Blasting','Primer Painting','Final Painting','Inspection','Assembly','Tack Welding'];
const DAYS_OF_WEEK  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const YES_NO        = ['Yes','No'];

function header(ws, cols) {
  ws.addRow(cols.map((c) => c.header));
  const row = ws.getRow(1);
  row.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height    = 20;
  cols.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width ?? 20;
    ws.getColumn(i + 1).key  = c.key;
  });
}

function dropdown(ws, col, list, fromRow, toRow) {
  for (let r = fromRow; r <= toRow; r++) {
    ws.getCell(r, col).dataValidation = {
      type: 'list', allowBlank: true,
      formulae: [`"${list.join(',')}"`],
    };
  }
}

// ── main export ───────────────────────────────────────────────────────────────

export async function exportCapacity(companyId) {
  // Load all data
  const [calendars] = await pool.query(
    'SELECT * FROM fab_work_calendars WHERE company_id = ? AND deleted_at IS NULL ORDER BY calendar_code',
    [companyId],
  );
  const [calDays] = await pool.query(
    `SELECT cd.*, wc.calendar_code
       FROM fab_work_calendar_days cd
       JOIN fab_work_calendars wc ON wc.id = cd.calendar_id
      WHERE cd.company_id = ? ORDER BY wc.calendar_code, FIELD(cd.day_of_week,'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')`,
    [companyId],
  );
  const [calExceptions] = await pool.query(
    `SELECT ce.*, wc.calendar_code
       FROM fab_work_calendar_exceptions ce
       JOIN fab_work_calendars wc ON wc.id = ce.calendar_id
      WHERE ce.company_id = ? ORDER BY wc.calendar_code, ce.exception_date`,
    [companyId],
  );
  const [workAreas] = await pool.query(
    `SELECT wa.*, wc.calendar_code
       FROM fab_work_areas wa
       LEFT JOIN fab_work_calendars wc ON wc.id = wa.calendar_id
      WHERE wa.company_id = ? AND wa.deleted_at IS NULL ORDER BY wa.work_area_code`,
    [companyId],
  );
  const [waCaps] = await pool.query(
    `SELECT cap.*, wa.work_area_code
       FROM fab_work_area_capabilities cap
       JOIN fab_work_areas wa ON wa.id = cap.work_area_id
      WHERE cap.company_id = ? ORDER BY wa.work_area_code, cap.priority`,
    [companyId],
  );
  const [machines] = await pool.query(
    `SELECT m.*, wa.work_area_code, wc.calendar_code
       FROM fab_machines m
       LEFT JOIN fab_work_areas wa ON wa.id = m.work_area_id
       LEFT JOIN fab_work_calendars wc ON wc.id = m.calendar_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL ORDER BY m.machine_code`,
    [companyId],
  );
  const [machineCaps] = await pool.query(
    `SELECT mc.*, m.machine_code
       FROM fab_machine_capabilities mc
       JOIN fab_machines m ON m.id = mc.machine_id
      WHERE mc.company_id = ? ORDER BY m.machine_code, mc.priority`,
    [companyId],
  );

  const wb   = new ExcelJS.Workbook();
  wb.creator = 'FabFlow';
  wb.created = new Date();

  // ── Sheet 1: Work_Calendars ───────────────────────────────────────────────
  const s1 = wb.addWorksheet('Work_Calendars');
  header(s1, [
    { header: 'calendar_code', key: 'calendar_code', width: 22 },
    { header: 'calendar_name', key: 'calendar_name', width: 35 },
    { header: 'description',   key: 'description',   width: 40 },
    { header: 'active',        key: 'active',        width: 10 },
  ]);
  for (const c of calendars) {
    s1.addRow([c.calendar_code, c.calendar_name, c.description, c.active ? 'Yes' : 'No']);
  }
  dropdown(s1, 4, YES_NO, 2, Math.max(calendars.length, 200) + 1);

  // ── Sheet 2: Work_Calendar_Days ────────────────────────────────────────────
  const s2 = wb.addWorksheet('Work_Calendar_Days');
  header(s2, [
    { header: 'calendar_code',  key: 'calendar_code',  width: 22 },
    { header: 'day_of_week',    key: 'day_of_week',    width: 16 },
    { header: 'is_working_day', key: 'is_working_day', width: 15 },
    { header: 'start_time',     key: 'start_time',     width: 12 },
    { header: 'end_time',       key: 'end_time',       width: 12 },
    { header: 'working_hours',  key: 'working_hours',  width: 15 },
  ]);
  for (const d of calDays) {
    s2.addRow([d.calendar_code, d.day_of_week, d.is_working_day ? 'Yes' : 'No',
      d.start_time, d.end_time, d.working_hours]);
  }
  const daysValidRows = Math.max(calDays.length, 500) + 1;
  dropdown(s2, 2, DAYS_OF_WEEK, 2, daysValidRows);
  dropdown(s2, 3, YES_NO,       2, daysValidRows);

  // ── Sheet 3: Work_Calendar_Exceptions ─────────────────────────────────────
  const s3 = wb.addWorksheet('Work_Calendar_Exceptions');
  header(s3, [
    { header: 'calendar_code',  key: 'calendar_code',  width: 22 },
    { header: 'exception_date', key: 'exception_date', width: 16 },
    { header: 'exception_name', key: 'exception_name', width: 30 },
    { header: 'is_working_day', key: 'is_working_day', width: 15 },
    { header: 'start_time',     key: 'start_time',     width: 12 },
    { header: 'end_time',       key: 'end_time',       width: 12 },
    { header: 'working_hours',  key: 'working_hours',  width: 15 },
    { header: 'notes',          key: 'notes',          width: 35 },
  ]);
  for (const e of calExceptions) {
    const dateStr = e.exception_date instanceof Date
      ? e.exception_date.toISOString().slice(0, 10)
      : String(e.exception_date ?? '');
    s3.addRow([e.calendar_code, dateStr, e.exception_name,
      e.is_working_day ? 'Yes' : 'No',
      e.start_time, e.end_time, e.working_hours, e.notes]);
  }
  dropdown(s3, 4, YES_NO, 2, Math.max(calExceptions.length, 500) + 1);

  // ── Sheet 4: Work_Areas ────────────────────────────────────────────────────
  const s4 = wb.addWorksheet('Work_Areas');
  header(s4, [
    { header: 'work_area_code',    key: 'work_area_code',    width: 22 },
    { header: 'work_area_name',    key: 'work_area_name',    width: 35 },
    { header: 'area_type',         key: 'area_type',         width: 18 },
    { header: 'max_parallel_jobs', key: 'max_parallel_jobs', width: 18 },
    { header: 'calendar_code',     key: 'calendar_code',     width: 22 },
    { header: 'active',            key: 'active',            width: 10 },
    { header: 'notes',             key: 'notes',             width: 40 },
  ]);
  for (const wa of workAreas) {
    s4.addRow([wa.work_area_code, wa.work_area_name, wa.area_type,
      wa.max_parallel_jobs, wa.calendar_code, wa.active ? 'Yes' : 'No', wa.notes]);
  }
  const waValidRows = Math.max(workAreas.length, 500) + 1;
  dropdown(s4, 3, AREA_TYPES, 2, waValidRows);
  dropdown(s4, 6, YES_NO,     2, waValidRows);

  // ── Sheet 5: Work_Area_Capabilities ───────────────────────────────────────
  const s5 = wb.addWorksheet('Work_Area_Capabilities');
  header(s5, [
    { header: 'work_area_code', key: 'work_area_code', width: 22 },
    { header: 'process_type',   key: 'process_type',   width: 22 },
    { header: 'allowed',        key: 'allowed',        width: 12 },
    { header: 'priority',       key: 'priority',       width: 12 },
    { header: 'notes',          key: 'notes',          width: 35 },
  ]);
  for (const c of waCaps) {
    s5.addRow([c.work_area_code, c.process_type, c.allowed ? 'Yes' : 'No', c.priority, c.notes]);
  }
  const wacValidRows = Math.max(waCaps.length, 500) + 1;
  dropdown(s5, 2, PROCESS_TYPES, 2, wacValidRows);
  dropdown(s5, 3, YES_NO,        2, wacValidRows);

  // ── Sheet 6: Machines ─────────────────────────────────────────────────────
  const s6 = wb.addWorksheet('Machines');
  header(s6, [
    { header: 'machine_code',  key: 'machine_code',  width: 22 },
    { header: 'machine_name',  key: 'machine_name',  width: 35 },
    { header: 'machine_type',  key: 'machine_type',  width: 22 },
    { header: 'work_area_code',key: 'work_area_code',width: 22 },
    { header: 'calendar_code', key: 'calendar_code', width: 22 },
    { header: 'active',        key: 'active',        width: 10 },
    { header: 'notes',         key: 'notes',         width: 40 },
  ]);
  for (const m of machines) {
    s6.addRow([m.machine_code, m.machine_name, m.machine_type,
      m.work_area_code, m.calendar_code, m.active ? 'Yes' : 'No', m.notes]);
  }
  dropdown(s6, 6, YES_NO, 2, Math.max(machines.length, 500) + 1);

  // ── Sheet 7: Machine_Capabilities ─────────────────────────────────────────
  const s7 = wb.addWorksheet('Machine_Capabilities');
  header(s7, [
    { header: 'machine_code',           key: 'machine_code',           width: 22 },
    { header: 'process_type',           key: 'process_type',           width: 22 },
    { header: 'capacity_hours_per_day', key: 'capacity_hours_per_day', width: 22 },
    { header: 'priority',               key: 'priority',               width: 12 },
    { header: 'notes',                  key: 'notes',                  width: 35 },
  ]);
  for (const mc of machineCaps) {
    s7.addRow([mc.machine_code, mc.process_type, mc.capacity_hours_per_day, mc.priority, mc.notes]);
  }
  dropdown(s7, 2, PROCESS_TYPES, 2, Math.max(machineCaps.length, 500) + 1);

  // ── Sheet 8: Masters_Reference ────────────────────────────────────────────
  const s8 = wb.addWorksheet('Masters_Reference');
  s8.getColumn(1).width = 30;
  s8.getColumn(2).width = 30;
  s8.getColumn(3).width = 30;
  s8.getColumn(4).width = 20;
  s8.addRow(['area_type examples', 'process_type examples', 'day_of_week values', 'active values']);
  s8.getRow(1).font = { bold: true };
  const maxR = Math.max(AREA_TYPES.length, PROCESS_TYPES.length, DAYS_OF_WEEK.length);
  for (let i = 0; i < maxR; i++) {
    s8.getCell(i + 2, 1).value = AREA_TYPES[i]    ?? '';
    s8.getCell(i + 2, 2).value = PROCESS_TYPES[i] ?? '';
    s8.getCell(i + 2, 3).value = DAYS_OF_WEEK[i]  ?? '';
    s8.getCell(i + 2, 4).value = YES_NO[i]         ?? '';
  }

  return wb.xlsx.writeBuffer();
}
