/**
 * imports.js — attendance by file: a punch log, or a daily status. (TM/CF_HRMS_HIRING_SPEC.md §28.1, way in 3.)
 *
 * The Excel pattern of the app (§13.4): download a template, fill it, PREVIEW (reads, changes
 * nothing, says every problem by row), then APPLY (one transaction; the same checks again).
 * Excel (.xlsx) or CSV, first sheet, the header row names the columns (any order, any case).
 *
 *   PUNCHES  Employee code | Date | Time | Direction (IN / OUT, optional)
 *            — or Device serial + User number instead of the employee code; or one "Date time" column.
 *            Stored like any punch (source IMPORT), deduplicated, and the days processed.
 *   DAYS     Employee code | Date | Status (P · A · HD · L · WO · H, or the words) | In | Out | Note
 *            — written with source IMPORT: processing does not overwrite it (except to mark approved
 *            leave); a day HR set by hand or an approved correction is kept, and said. The same
 *            person and date twice is a problem on the second row; the login's own days are refused
 *            (c.employeeId, from the route) — nobody records their own attendance.
 *   A punch file is stored in slices of MAX_BATCH; its days are processed by the route AFTER the
 *   commit (`toProcess`, not enumerable, for punches.processAfterCommit).
 */
import ExcelJS from 'exceljs';
import { invalid } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { isDate } from '../leave/days.js';
import { ingestPunches, newBatchId, processPunchDays, MAX_BATCH } from './punches.js';
import { settingsOf, closedMonths } from './settings.js';
import { normWall, at, monthOf, utcNow, nowIn } from './time.js';

export const KINDS = ['punches', 'days'];
export const MAX_ROWS = 20000;
const STATUS_OF = {
  P: 'PRESENT', PRESENT: 'PRESENT', A: 'ABSENT', ABSENT: 'ABSENT', HD: 'HALF_DAY', 'HALF DAY': 'HALF_DAY', HALF_DAY: 'HALF_DAY', H: 'HOLIDAY', HOLIDAY: 'HOLIDAY',
  WO: 'WEEKLY_OFF', 'WEEKLY OFF': 'WEEKLY_OFF', WEEKLY_OFF: 'WEEKLY_OFF', L: 'LEAVE', LEAVE: 'LEAVE',
};
const FRACTIONS = { PRESENT: [1, 0, 0], HALF_DAY: [0.5, 0, 0.5], ABSENT: [0, 0, 1], LEAVE: [0, 1, 0], WEEKLY_OFF: [0, 0, 0], HOLIDAY: [0, 0, 0] };

const HEADERS = {
  punches: ['Employee code', 'Date', 'Time', 'Direction', 'Device serial', 'User number'],
  days: ['Employee code', 'Date', 'Status', 'In', 'Out', 'Note'],
};

/** GET /attendance/imports/template?kind= */
export async function template(kind) {
  if (!KINDS.includes(kind)) throw invalid('INVALID', 'The file is punches or days.');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(kind === 'punches' ? 'Punches' : 'Days');
  ws.addRow(HEADERS[kind]);
  ws.getRow(1).font = { bold: true };
  if (kind === 'punches') { ws.addRow(['E0001', '2026-10-05', '09:02', 'IN', '', '']); ws.addRow(['E0001', '2026-10-05', '18:07', 'OUT', '', '']); ws.addRow(['', '2026-10-05', '09:10', '', 'GATE-01', '23']); }
  else { ws.addRow(['E0001', '2026-10-05', 'P', '09:00', '18:00', '']); ws.addRow(['E0002', '2026-10-05', 'A', '', '', 'Did not come']); }
  HEADERS[kind].forEach((_, i) => { ws.getColumn(i + 1).width = 16; });
  const notes = wb.addWorksheet('How to fill');
  for (const line of kind === 'punches'
    ? ['One row a punch. Employee code, or Device serial + User number (the number on the device).', 'Date as YYYY-MM-DD (or an Excel date), Time as HH:MM. Direction IN or OUT, or leave it empty.', 'A punch already stored is skipped. The days are processed after the upload.']
    : ['One row a person and day. Status: P present · A absent · HD half day · L leave · WO weekly off · H holiday.', 'In / Out as HH:MM (optional). A day HR set by hand or corrected by an approved request is kept.', 'Days of a closed month cannot be changed.']) notes.addRow([line]);
  notes.getColumn(1).width = 110;
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { fileName: `attendance-${kind}-template.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: buffer.toString('base64') };
}

/* ══ reading a file ═════════════════════════════════════════════════════════ */

function csvRows(text) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

const pad = (n) => String(n).padStart(2, '0');
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19).replace(/ 00:00:00$/, '');
  if (typeof v === 'object' && v.text) return String(v.text);
  if (typeof v === 'object' && v.result !== undefined) return cellText(v.result);
  return String(v);
}

async function readTable(body) {
  const raw = body?.contentBase64 ?? body?.content;
  if (!raw) throw invalid('FILE_PROBLEM', 'Choose a file.');
  const buf = Buffer.from(String(raw), 'base64');
  if (buf.length > 15 * 1024 * 1024) throw invalid('FILE_PROBLEM', 'The file is larger than 15 MB.');
  const name = String(body.fileName ?? '').toLowerCase();
  let rows;
  if (name.endsWith('.csv') || name.endsWith('.txt')) rows = csvRows(buf.toString('utf8').replace(/^﻿/, ''));
  else {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch { throw invalid('FILE_PROBLEM', 'This is not an Excel file (.xlsx) or a CSV.'); }
    const ws = wb.worksheets[0];
    rows = [];
    ws.eachRow({ includeEmpty: false }, (r) => { const vals = []; for (let i = 1; i <= Math.max(r.cellCount, 8); i += 1) vals.push(cellText(r.getCell(i).value)); rows.push(vals); });
  }
  if (!rows.length) throw invalid('FILE_PROBLEM', 'The file is empty.');
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  if (rows.length - 1 > MAX_ROWS) throw invalid('FILE_PROBLEM', `At most ${MAX_ROWS} rows in one file.`);
  return { header, rows: rows.slice(1).map((r, i) => ({ row: i + 2, cells: r })) };
}

const col = (header, ...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
const get = (cells, i) => (i < 0 ? '' : String(cells[i] ?? '').trim());

function dateOf(s) {
  const t = s.slice(0, 10);
  if (isDate(t)) return t;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s.trim());
  if (m) { const d = `${m[3]}-${pad(m[2])}-${pad(m[1])}`; if (isDate(d)) return d; }
  return null;
}
function timeOf(s) {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${pad(m[1])}:${m[2]}`;
}

/* ══ preview and apply ═════════════════════════════════════════════════════ */

async function plan(db, c, kind, body) {
  const { header, rows } = await readTable(body);
  const fileProblems = [];
  const iCode = col(header, 'employee code', 'code', 'emp code', 'employee');
  const iDate = col(header, 'date');
  const iDateTime = col(header, 'date time', 'datetime', 'punch time', 'time stamp', 'timestamp');
  const iTime = col(header, 'time');
  const iDir = col(header, 'direction', 'in/out');
  const iSerial = col(header, 'device serial', 'serial', 'serial number');
  const iUser = col(header, 'user number', 'user id', 'enrol number', 'enroll number', 'pin');
  const iStatus = col(header, 'status');
  const iIn = col(header, 'in', 'in time');
  const iOut = col(header, 'out', 'out time');
  const iNote = col(header, 'note', 'remarks');
  if (kind === 'punches' && iCode < 0 && !(iSerial >= 0 && iUser >= 0)) fileProblems.push('The file needs an "Employee code" column, or "Device serial" and "User number".');
  if (kind === 'punches' && iDateTime < 0 && (iDate < 0 || iTime < 0)) fileProblems.push('The file needs "Date" and "Time" columns (or one "Date time").');
  if (kind === 'days' && (iCode < 0 || iDate < 0 || iStatus < 0)) fileProblems.push('The file needs "Employee code", "Date" and "Status" columns.');
  if (fileProblems.length) return { fileProblems, items: [] };

  const [emps] = await db.query('SELECT id, employee_code, full_name, date_of_joining, exit_date FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const byCode = new Map(emps.map((e) => [String(e.employee_code ?? '').toUpperCase(), e]));
  const [devs] = await db.query('SELECT id, serial_number, timezone FROM hrms_attendance_devices WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const bySerial = new Map(devs.map((d) => [String(d.serial_number).toUpperCase(), d]));
  const s = await settingsOf(db, c.companyId);
  const closed = await closedMonths(db, c.companyId);
  const today = nowIn(s.defaultTimezone).slice(0, 10);
  const firstRowOf = new Map(); // 'employeeId|date' -> the first row with it (a days file)
  const items = rows.map(({ row, cells }) => {
    const problems = [];
    const code = get(cells, iCode);
    const emp = code ? byCode.get(code.toUpperCase()) : null;
    if (kind === 'punches') {
      const serial = get(cells, iSerial);
      const dev = serial ? bySerial.get(serial.toUpperCase()) : null;
      if (serial && !dev) problems.push(`No device ${serial} is registered.`);
      if (code && !emp) problems.push(`No employee has the code ${code}.`);
      if (!code && !(dev && get(cells, iUser))) problems.push('Give the employee code, or the device serial and the user number.');
      let stamp = null;
      if (iDateTime >= 0 && get(cells, iDateTime)) stamp = normWall(get(cells, iDateTime).replace(/\//g, '-'));
      else { const d = dateOf(get(cells, iDate)); const t = timeOf(get(cells, iTime)); if (d && t) stamp = at(d, t); }
      if (!stamp) problems.push('The date and time cannot be read (YYYY-MM-DD and HH:MM).');
      const dir = get(cells, iDir).toUpperCase();
      if (dir && !['IN', 'OUT', 'I', 'O'].includes(dir)) problems.push('Direction is IN or OUT (or empty).');
      return {
        row, problems, label: `${emp?.full_name ?? (dev ? `${serial} #${get(cells, iUser)}` : code)} · ${stamp ?? '?'}`,
        punch: { deviceId: dev?.id ?? null, timezone: dev?.timezone ?? s.defaultTimezone, deviceUserId: dev ? get(cells, iUser) : code, employeeId: dev ? null : (emp?.id ?? null), at: stamp, direction: dir === 'I' ? 'IN' : dir === 'O' ? 'OUT' : dir || 'UNKNOWN', raw: cells.join(',').slice(0, 500) },
      };
    }
    if (!emp) problems.push(code ? `No employee has the code ${code}.` : 'Give the employee code.');
    if (emp && c.employeeId && emp.id === Number(c.employeeId)) problems.push('This is your own attendance. Someone else in HR records your days.');
    const d = dateOf(get(cells, iDate));
    if (emp && d) {
      const k = `${emp.id}|${d}`;
      if (firstRowOf.has(k)) problems.push(`Row ${firstRowOf.get(k)} already has this person and date.`);
      else firstRowOf.set(k, row);
    }
    if (!d) problems.push('The date cannot be read (YYYY-MM-DD).');
    const status = STATUS_OF[get(cells, iStatus).toUpperCase()];
    if (!status) problems.push('Status is P, A, HD, L, WO or H.');
    if (d && !s.liveFrom) problems.push('Attendance is not live yet (Attendance › Close month › Settings).');
    else if (d && d < s.liveFrom) problems.push(`Attendance is recorded from ${s.liveFrom}.`);
    if (d && d > today) problems.push('A day in the future cannot be recorded.');
    if (d && closed.has(monthOf(d))) problems.push(`${monthOf(d)} is closed.`);
    if (emp && d && emp.date_of_joining && d < String(emp.date_of_joining).slice(0, 10)) problems.push('This date is before the joining date.');
    const tin = get(cells, iIn) ? timeOf(get(cells, iIn)) : null;
    const tout = get(cells, iOut) ? timeOf(get(cells, iOut)) : null;
    if (get(cells, iIn) && !tin) problems.push('"In" is a time (HH:MM).');
    if (get(cells, iOut) && !tout) problems.push('"Out" is a time (HH:MM).');
    return { row, problems, label: `${emp?.full_name ?? code} · ${d ?? '?'} · ${status ?? '?'}`, day: { employeeId: emp?.id, date: d, status, inAt: d && tin ? at(d, tin) : null, outAt: d && tout ? at(d, tout, tin && tout <= tin ? 1 : 0) : null, note: get(cells, iNote).slice(0, 300) } };
  });
  return { fileProblems, items };
}

const summaryOf = (items) => ({ rows: items.length, ok: items.filter((i) => !i.problems.length).length, problems: items.filter((i) => i.problems.length).length });

/** POST /attendance/imports/:kind/preview */
export async function previewImport(db, c, kind, body = {}) {
  if (!KINDS.includes(kind)) throw invalid('INVALID', 'The file is punches or days.');
  const p = await plan(db, c, kind, body);
  return { kind, fileName: body.fileName ?? null, fileProblems: p.fileProblems, summary: summaryOf(p.items), rows: p.items.slice(0, 2000).map((i) => ({ row: i.row, label: i.label, problems: i.problems })) };
}

/** POST /attendance/imports/:kind/apply { fileName, contentBase64, skipProblemRows? } — one transaction. */
export async function applyImport(conn, c, kind, body = {}, requestId = null) {
  if (!KINDS.includes(kind)) throw invalid('INVALID', 'The file is punches or days.');
  const p = await plan(conn, c, kind, body);
  if (p.fileProblems.length) throw invalid('FILE_PROBLEM', p.fileProblems[0], { problems: p.fileProblems });
  const bad = p.items.filter((i) => i.problems.length);
  if (bad.length && !body.skipProblemRows) throw invalid('HAS_PROBLEMS', `${bad.length} row${bad.length === 1 ? ' has' : 's have'} a problem. Fix ${bad.length === 1 ? 'it' : 'them'}, or apply without ${bad.length === 1 ? 'it' : 'them'}.`, { problems: bad.slice(0, 50).map((b) => `Row ${b.row}: ${b.problems[0]}`) });
  const good = p.items.filter((i) => !i.problems.length);
  if (kind === 'punches') {
    const groups = new Map();
    for (const g of good) { const k = g.punch.deviceId ?? 0; const l = groups.get(k) ?? []; l.push(g.punch); groups.set(k, l); }
    const total = { rows: good.length, inserted: 0, duplicates: 0, unmapped: 0, skipped: bad.length };
    const toProcess = [];
    for (const [deviceId, list] of groups) {
      for (let i = 0; i < list.length; i += MAX_BATCH) {
        const slice = list.slice(i, i + MAX_BATCH);
        const r = await ingestPunches(conn, c, slice, { deviceId: deviceId || null, timezone: slice[0].timezone, source: 'IMPORT', batchId: newBatchId('IMPORT'), requestId, process: false });
        total.inserted += r.inserted; total.duplicates += r.duplicates; total.unmapped += r.unmapped;
        toProcess.push(...r.toProcess);
      }
    }
    Object.defineProperty(total, 'toProcess', { value: toProcess, enumerable: false });
    return total;
  }
  // DAYS
  const ids = [...new Set(good.map((g) => g.day.employeeId))];
  const [existing] = ids.length ? await conn.query('SELECT id, employee_id, attendance_date, source FROM hrms_attendance_records WHERE company_id = ? AND employee_id IN (?) AND deleted_at IS NULL', [c.companyId, ids]) : [[]];
  const have = new Map(existing.map((r) => [`${r.employee_id}|${String(r.attendance_date).slice(0, 10)}`, r]));
  const out = { rows: good.length, written: 0, kept: [], skipped: bad.length };
  const processedAt = utcNow();
  for (const g of good) {
    const d = g.day;
    const old = have.get(`${d.employeeId}|${d.date}`);
    if (old && (old.source === 'MANUAL' || old.source === 'REGULARIZATION')) { out.kept.push(`${g.label}: ${old.source === 'MANUAL' ? 'set by HR by hand' : 'corrected by an approved request'} — kept`); continue; }
    const [pv, lv, av] = FRACTIONS[d.status];
    const worked = d.inAt && d.outAt ? Math.max(0, Math.round((Date.parse(`${d.outAt.replace(' ', 'T')}Z`) - Date.parse(`${d.inAt.replace(' ', 'T')}Z`)) / 60000)) : null;
    const reason = `From a file${d.note ? `: ${d.note}` : ''}`.slice(0, 300);
    if (old) {
      await conn.query(`UPDATE hrms_attendance_records SET status = ?, in_time = ?, out_time = ?, worked_minutes = ?, late_minutes = 0, early_minutes = 0, overtime_minutes = 0, late_mark = 0, missing_punch = 0,
                          present_value = ?, leave_value = ?, absent_value = ?, status_reason = ?, source = 'IMPORT', processed_at = ? WHERE company_id = ? AND id = ?`,
      [d.status, d.inAt, d.outAt, worked, pv, lv, av, reason, processedAt, c.companyId, old.id]);
    } else {
      const [ins] = await conn.query(`INSERT INTO hrms_attendance_records (company_id, employee_id, attendance_date, status, in_time, out_time, worked_minutes, present_value, leave_value, absent_value, status_reason, source, processed_at, created_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IMPORT', ?, ?)`, [c.companyId, d.employeeId, d.date, d.status, d.inAt, d.outAt, worked, pv, lv, av, reason, processedAt, c.userId]);
      // Known from now on: a second row for the same person and day (refused by plan) would update, not insert again.
      have.set(`${d.employeeId}|${d.date}`, { id: ins.insertId, employee_id: d.employeeId, attendance_date: d.date, source: 'IMPORT' });
    }
    out.written += 1;
  }
  await audit(conn, c, 'hrms_attendance_records', 0, 'IMPORT', null, { kind: 'days', fileName: String(body.fileName ?? '').slice(0, 200), written: out.written, kept: out.kept.length, skipped: bad.length }, requestId);
  // The month's late marks and penalties are recounted for the people the file touched.
  if (good.length) {
    const dates = good.map((g) => g.day.date).sort();
    const { processRange } = await import('./process.js');
    await processRange(conn, c, { from: dates[0], to: dates[dates.length - 1], employeeIds: ids, kind: 'BATCH', note: 'days file' });
  }
  return out;
}

export default { template, previewImport, applyImport, KINDS };
export { processPunchDays };
