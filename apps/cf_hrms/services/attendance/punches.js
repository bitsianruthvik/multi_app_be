/**
 * punches.js — punches in, raw and never edited. (TM/CF_HRMS_HIRING_SPEC.md §28.1.)
 *
 * Every way in ends in `ingestPunches`: the ADMS push, the REST API, a file, the web punch.
 *   - A punch is stored once: (company, device, device user id, punched_at) is unique, so a
 *     device that sends the same lines again, or an API batch sent twice, adds nothing.
 *   - Who it is: the device user mapping (that device's own, else the company-wide one); a
 *     punch with no device names the employee by code. No mapping -> employee_id NULL: the
 *     UNMAPPED QUEUE. Adding the mapping attaches those punches and processes their days.
 *   - Nothing from a device can do more than add punches: no edit, no delete, no command.
 *   - Each batch writes one audit row, and its days are processed (process.js) at once — or, for
 *     the device push, the API and a file (`process: false`), AFTER the punches commit
 *     (processAfterCommit): a processing error never fails the device or loses a punch; the
 *     days are then marked (a RETRY run) for the nightly pass, which processes them again.
 */
import crypto from 'crypto';
import { HrmsError, invalid, notFound, conflict } from '../../lib/errors.js';
import { pool, withTransaction } from '../../lib/db.js';
import { logger } from '../../../../core/utils/logger.js';
import { audit } from '../peopleService.js';
import { addDays } from '../leave/days.js';
import { normWall, utcNow, wall, day, nowIn } from './time.js';
import { settingsOf, ipAllowed, metresBetween } from './settings.js';

export const METHODS = ['FINGER', 'FACE', 'CARD', 'PASSWORD', 'PALM', 'WEB', 'MOBILE', 'IMPORT', 'API', 'OTHER'];
export const DIRECTIONS = ['IN', 'OUT', 'UNKNOWN'];
export const MAX_BATCH = 5000;

const maskSerialText = (s) => { const t = String(s); return t.length <= 4 ? '••••' : `${'•'.repeat(Math.min(8, t.length - 4))}${t.slice(-4)}`; };

export const newBatchId = (source) => `${source}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

/** The company's mapping: Map<'deviceId:userId' | '0:userId', employeeId>. */
export async function mappingOf(db, companyId) {
  const [rows] = await db.query('SELECT device_id, device_user_id, employee_id FROM hrms_attendance_device_users WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  return new Map(rows.map((r) => [`${r.device_id ?? 0}:${r.device_user_id}`, r.employee_id]));
}

/**
 * Store punches and process their days.
 * @param c        { companyId, userId | null }
 * @param punches  [{ deviceUserId, at, direction?, method?, raw?, employeeId?, lat?, lng?, ip? }]
 * @param opts     { deviceId, timezone, source: ADMS | API | IMPORT | WEB, batchId, process: true }
 *                 process false: the days are NOT processed here; `toProcess` (not enumerable) holds the
 *                 stored punches for processAfterCommit. At most MAX_BATCH punches a call (callers slice).
 * @returns { received, inserted, duplicates, unmapped, rejected: [{ index, why }], processed }
 */
export async function ingestPunches(conn, c, punches, { deviceId = null, timezone = 'Asia/Kolkata', source, batchId = newBatchId(source), process = true, requestId = null } = {}) {
  const report = { received: punches.length, inserted: 0, duplicates: 0, unmapped: 0, rejected: [], processed: null, batchId };
  if (!punches.length) return report;
  if (punches.length > MAX_BATCH) throw invalid('TOO_MANY', `At most ${MAX_BATCH} punches at once.`);
  const map = await mappingOf(conn, c.companyId);
  // A punch without a device names the person by their employee code.
  const codes = [...new Set(punches.filter((p) => !deviceId && p.employeeId == null).map((p) => String(p.deviceUserId ?? '').trim()).filter(Boolean))];
  const byCode = new Map();
  if (codes.length) {
    const [rows] = await conn.query('SELECT id, employee_code FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND employee_code IN (?)', [c.companyId, codes]);
    for (const r of rows) byCode.set(String(r.employee_code), r.id);
  }
  const received = utcNow();
  const values = [];
  punches.forEach((p, index) => {
    const at = normWall(p.at);
    const uid = String(p.deviceUserId ?? '').trim();
    if (!at) { report.rejected.push({ index, why: 'The time is not a date and time (YYYY-MM-DD HH:MM:SS).' }); return; }
    if (!uid || uid.length > 40) { report.rejected.push({ index, why: 'The user number or employee code is missing or longer than 40.' }); return; }
    const direction = DIRECTIONS.includes(String(p.direction ?? '').toUpperCase()) ? String(p.direction).toUpperCase() : 'UNKNOWN';
    const method = METHODS.includes(String(p.method ?? '').toUpperCase()) ? String(p.method).toUpperCase() : (source === 'WEB' ? 'WEB' : source === 'IMPORT' ? 'IMPORT' : source === 'API' ? 'API' : 'OTHER');
    let employeeId = p.employeeId ?? null;
    if (employeeId == null) employeeId = deviceId ? (map.get(`${deviceId}:${uid}`) ?? map.get(`0:${uid}`) ?? null) : (byCode.get(uid) ?? map.get(`0:${uid}`) ?? null);
    values.push([c.companyId, employeeId, deviceId, uid, at, timezone, direction, method, source, p.raw ? String(p.raw).slice(0, 500) : null, batchId,
      p.lat ?? null, p.lng ?? null, p.ip ? String(p.ip).slice(0, 64) : null, received, c.userId ?? null]);
  });
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500);
    const [res] = await conn.query(
      `INSERT IGNORE INTO hrms_attendance_punches (company_id, employee_id, device_id, device_user_id, punched_at, timezone, direction, method, source, raw_line, batch_id, latitude, longitude, ip, received_at, created_by)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`, chunk.flat());
    report.inserted += res.affectedRows;
  }
  report.duplicates = values.length - report.inserted;
  const [mine] = await conn.query('SELECT employee_id, punched_at FROM hrms_attendance_punches WHERE company_id = ? AND batch_id = ?', [c.companyId, batchId]);
  report.unmapped = mine.filter((r) => r.employee_id == null).length;
  if (deviceId && mine.length) {
    const newest = mine.map((r) => wall(r.punched_at)).sort().pop();
    await conn.query('UPDATE hrms_attendance_devices SET last_punch_at = GREATEST(COALESCE(last_punch_at, ?), ?) WHERE company_id = ? AND id = ?', [newest, newest, c.companyId, deviceId]);
  }
  await audit(conn, c, 'hrms_attendance_punches', deviceId ?? 0, 'IMPORT', null, {
    source, batchId, received: report.received, inserted: report.inserted, duplicates: report.duplicates, unmapped: report.unmapped, rejected: report.rejected.length,
  }, requestId);
  const mapped = mine.filter((r) => r.employee_id != null);
  if (process) report.processed = await processPunchDays(conn, c, mapped);
  else Object.defineProperty(report, 'toProcess', { value: mapped, enumerable: false });
  return report;
}

/** For a test only: { failProcessing: true } makes processAfterCommit's processing throw. */
export const TEST_HOOKS = { failProcessing: false };

/**
 * After the punches COMMITTED: process their days in a transaction of its own. An error is
 * logged and the dates are marked for the nightly pass (a RETRY run, retryPending); it is never
 * thrown — the punches are stored and the device / caller is told so. Re-running is safe
 * (processRange is idempotent).
 * @returns the processing report, or { failed: true, retryRunId }
 */
export async function processAfterCommit(c, rows, { what = 'punches' } = {}) {
  if (!rows?.length) return null;
  try {
    return await withTransaction(async (conn) => {
      if (TEST_HOOKS.failProcessing) throw new Error('processing failed (test hook)');
      return processPunchDays(conn, c, rows);
    });
  } catch (err) {
    const dates = rows.map((r) => wall(r.punched_at).slice(0, 10)).sort();
    const from = addDays(dates[0], -1);
    const to = dates[dates.length - 1];
    logger.error({ err: err.message, companyId: c.companyId, what, from, to, punches: rows.length }, '[cf_hrms] attendance: punches stored, processing their days failed; marked for the nightly pass');
    try {
      const ids = [...new Set(rows.map((r) => r.employee_id))];
      const retryRunId = await withTransaction(async (conn) => {
        const [ins] = await conn.query(
          "INSERT INTO hrms_attendance_runs (company_id, kind, from_date, to_date, started_at, note, created_by) VALUES (?, 'RETRY', ?, ?, ?, ?, NULL)",
          [c.companyId, from, to, utcNow(), `${what}: processing failed (${String(err.message).slice(0, 150)}); people ${JSON.stringify(ids).slice(0, 300)}`]);
        return ins.insertId;
      });
      return { failed: true, retryRunId };
    } catch (err2) {
      logger.error({ err: err2.message, companyId: c.companyId, from, to }, '[cf_hrms] attendance: could not mark the days for the nightly pass either');
      return { failed: true, retryRunId: null };
    }
  }
}

/**
 * The nightly pass (and a test): process every RETRY run of a company not yet finished, each in
 * its own transaction; a run that fails again stays for the next pass.
 */
export async function retryPending(companyId) {
  const [runs] = await pool.query(
    "SELECT id, from_date, to_date FROM hrms_attendance_runs WHERE company_id = ? AND kind = 'RETRY' AND finished_at IS NULL AND deleted_at IS NULL ORDER BY id LIMIT 20", [companyId]);
  const done = [];
  for (const r of runs) {
    try {
      const out = await withTransaction(async (conn) => {
        const { processRange } = await import('./process.js');
        const rep = await processRange(conn, { companyId, userId: null }, { from: day(r.from_date), to: day(r.to_date), kind: 'BATCH', note: `retry of run ${r.id}` });
        await conn.query('UPDATE hrms_attendance_runs SET finished_at = ?, days_written = ? WHERE company_id = ? AND id = ?', [utcNow(), rep.daysWritten, companyId, r.id]);
        return rep;
      });
      done.push({ runId: r.id, days: out.daysWritten });
    } catch (err) {
      logger.warn({ err: err.message, companyId, runId: r.id }, '[cf_hrms] attendance: a retry failed again; the next pass tries again');
    }
  }
  return done;
}

/** Process the days some punches fall on (and the day before, for a night shift that ended on them). */
export async function processPunchDays(conn, c, rows) {
  if (!rows.length) return null;
  const { reprocess } = await import('./process.js');
  const dates = rows.map((r) => wall(r.punched_at).slice(0, 10)).sort();
  return reprocess(conn, c, rows.map((r) => r.employee_id), addDays(dates[0], -1), dates[dates.length - 1], 'BATCH');
}

/* ══ the mapping ═══════════════════════════════════════════════════════════ */

/** GET /attendance/device-users?deviceId= -> { mappings, employeesWithout } */
export async function listMappings(db, c, { deviceId = null } = {}) {
  const [[rows], [without]] = await Promise.all([
    db.query(
      `SELECT m.id, m.device_id, m.device_user_id, m.employee_id, e.full_name, e.employee_code, d.name AS device_name
         FROM hrms_attendance_device_users m
         JOIN hrms_employees e ON e.company_id = m.company_id AND e.id = m.employee_id
         LEFT JOIN hrms_attendance_devices d ON d.company_id = m.company_id AND d.id = m.device_id
        WHERE m.company_id = ? AND m.deleted_at IS NULL ${deviceId ? 'AND (m.device_id = ? OR m.device_id IS NULL)' : ''}
        ORDER BY e.full_name, m.id`, [c.companyId, ...(deviceId ? [deviceId] : [])]),
    db.query(
      `SELECT e.id, e.full_name, e.employee_code FROM hrms_employees e
        WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.employment_status <> 'EXITED'
          AND NOT EXISTS (SELECT 1 FROM hrms_attendance_device_users m WHERE m.company_id = e.company_id AND m.employee_id = e.id AND m.deleted_at IS NULL)
        ORDER BY e.full_name LIMIT 2000`, [c.companyId]),
  ]);
  return {
    mappings: rows.map((r) => ({ id: r.id, deviceId: r.device_id, deviceName: r.device_name ?? 'Every device', deviceUserId: r.device_user_id, employee: { employeeId: r.employee_id, name: r.full_name, employeeCode: r.employee_code } })),
    employeesWithout: without.map((e) => ({ employeeId: e.id, name: e.full_name, employeeCode: e.employee_code, suggested: defaultUserId(e.employee_code) })),
  };
}

/** The default enrol number: the employee code without its letters ("KPPL0123" -> "0123"). */
export const defaultUserId = (code) => String(code ?? '').replace(/[^0-9]/g, '') || null;

/** Attach waiting punches to a new mapping, and process their days. */
async function attach(conn, c, { deviceId, deviceUserId, employeeId }) {
  const where = deviceId ? 'device_id = ?' : 'device_id IS NOT NULL';
  const params = deviceId ? [deviceId] : [];
  await conn.query(`UPDATE hrms_attendance_punches SET employee_id = ? WHERE company_id = ? AND employee_id IS NULL AND device_user_id = ? AND ${where}`,
    [employeeId, c.companyId, deviceUserId, ...params]);
  const [rows] = await conn.query(`SELECT employee_id, punched_at FROM hrms_attendance_punches WHERE company_id = ? AND employee_id = ? AND device_user_id = ? AND ${where}`,
    [c.companyId, employeeId, deviceUserId, ...params]);
  if (rows.length) await processPunchDays(conn, c, rows);
  return rows.length;
}

/**
 * PUT /attendance/device-users { deviceId | null, deviceUserId, employeeId | null } — one per
 * (device, user id); employeeId null takes it off. A new mapping attaches the waiting punches.
 */
export async function putMapping(conn, c, body = {}, requestId = null) {
  const deviceUserId = String(body.deviceUserId ?? '').trim();
  if (!deviceUserId || deviceUserId.length > 40 || !/^[A-Za-z0-9_.-]+$/.test(deviceUserId)) throw invalid('INVALID', 'The user number on the device is letters and digits, up to 40.');
  const deviceId = body.deviceId == null || body.deviceId === '' ? null : Number(body.deviceId);
  if (deviceId !== null) {
    const [[d]] = await conn.query('SELECT id FROM hrms_attendance_devices WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, deviceId]);
    if (!d) throw notFound('That device');
  }
  const employeeId = body.employeeId == null || body.employeeId === '' ? null : Number(body.employeeId);
  if (employeeId !== null) {
    const [[e]] = await conn.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, employeeId]);
    if (!e) throw notFound('That employee');
  }
  const [[current]] = await conn.query(
    `SELECT id, employee_id FROM hrms_attendance_device_users WHERE company_id = ? AND device_user_id = ? AND deleted_at IS NULL AND ${deviceId ? 'device_id = ?' : 'device_id IS NULL'} FOR UPDATE`,
    [c.companyId, deviceUserId, ...(deviceId ? [deviceId] : [])]);
  if (current && current.employee_id === employeeId) return { mapping: { deviceId, deviceUserId, employeeId }, attached: 0 };
  if (current) {
    await conn.query('UPDATE hrms_attendance_device_users SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, current.id]);
    await audit(conn, c, 'hrms_attendance_device_users', current.id, 'DELETE', { deviceId, deviceUserId, employeeId: current.employee_id }, null, requestId);
  }
  let attached = 0;
  if (employeeId !== null) {
    const [ins] = await conn.query('INSERT INTO hrms_attendance_device_users (company_id, device_id, device_user_id, employee_id, created_by) VALUES (?, ?, ?, ?, ?)',
      [c.companyId, deviceId, deviceUserId, employeeId, c.userId]);
    await audit(conn, c, 'hrms_attendance_device_users', ins.insertId, 'CREATE', null, { deviceId, deviceUserId, employeeId }, requestId);
    attached = await attach(conn, c, { deviceId, deviceUserId, employeeId });
  }
  return { mapping: { deviceId, deviceUserId, employeeId }, attached };
}

/**
 * POST /attendance/device-users/auto — everyone without a mapping gets the default (code without
 * letters), company-wide; a number another person already has is skipped and said.
 */
export async function autoMap(conn, c, requestId = null) {
  const { employeesWithout } = await listMappings(conn, c);
  const taken = new Set((await conn.query('SELECT device_user_id FROM hrms_attendance_device_users WHERE company_id = ? AND deleted_at IS NULL AND device_id IS NULL', [c.companyId]))[0].map((r) => r.device_user_id));
  const made = [];
  const skipped = [];
  for (const e of employeesWithout) {
    if (!e.suggested) { skipped.push({ person: e, why: 'The employee code has no digits.' }); continue; }
    if (taken.has(e.suggested)) { skipped.push({ person: e, why: `${e.suggested} is already someone else's number.` }); continue; }
    taken.add(e.suggested);
    const r = await putMapping(conn, c, { deviceId: null, deviceUserId: e.suggested, employeeId: e.employeeId }, requestId);
    made.push({ person: e, deviceUserId: e.suggested, attached: r.attached });
  }
  return { made: made.length, skipped, mappings: made };
}

/** GET /attendance/unmapped — the queue: one row per (device, user number). canEdit false: serials masked. */
export async function unmappedQueue(db, c, { canEdit = true } = {}) {
  const [rows] = await db.query(
    `SELECT p.device_id, p.device_user_id, COUNT(*) AS n, MIN(p.punched_at) AS first_at, MAX(p.punched_at) AS last_at, d.name AS device_name, d.serial_number
       FROM hrms_attendance_punches p LEFT JOIN hrms_attendance_devices d ON d.company_id = p.company_id AND d.id = p.device_id
      WHERE p.company_id = ? AND p.employee_id IS NULL
      GROUP BY p.device_id, p.device_user_id, d.name, d.serial_number ORDER BY last_at DESC LIMIT 500`, [c.companyId]);
  return {
    items: rows.map((r) => ({
      deviceId: r.device_id, deviceName: r.device_name ?? 'No device', serialNumber: r.serial_number == null ? null : (canEdit ? r.serial_number : maskSerialText(r.serial_number)), deviceUserId: r.device_user_id,
      punches: Number(r.n), firstAt: wall(r.first_at), lastAt: wall(r.last_at),
    })),
  };
}

/* ══ the web punch ═════════════════════════════════════════════════════════ */

/**
 * POST /user/me/attendance/punch { direction, lat?, lng? } — only when the company turned it on;
 * the address must be in the allow-list (if one is set) and the place inside a geofence of the
 * person's location (if any are set).
 */
export async function webPunch(conn, c, employeeId, body = {}, ip = null) {
  const s = await settingsOf(conn, c.companyId);
  if (!s.webPunch.enabled) throw new HrmsError(403, 'WEB_PUNCH_OFF', 'Punching from the web is not turned on for this company.');
  if (!s.liveFrom) throw new HrmsError(403, 'NOT_LIVE', 'Attendance is not live yet.');
  if (!ipAllowed(ip, s.webPunch.ipAllowList)) throw new HrmsError(403, 'IP_NOT_ALLOWED', 'You can punch only from the company network.');
  const direction = String(body.direction ?? '').toUpperCase();
  if (direction !== 'IN' && direction !== 'OUT') throw invalid('INVALID', 'Punch IN or OUT.');
  const [[e]] = await conn.query('SELECT id, employee_code FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, employeeId]);
  if (!e) throw notFound('That employee');
  let lat = null; let lng = null;
  if (s.webPunch.geofences.length) {
    lat = Number(body.lat); lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HrmsError(422, 'LOCATION_NEEDED', 'Allow the browser to share your location: punching needs it here.');
    const { seatsOf } = await import('./process.js');
    const seat = (await seatsOf(conn, c.companyId, [employeeId], nowIn(s.defaultTimezone).slice(0, 10))).get(employeeId);
    const fences = s.webPunch.geofences.filter((g) => g.locationId == null || g.locationId === seat?.location_id);
    const near = fences.map((g) => ({ g, m: metresBetween({ lat, lng }, g) })).sort((a, b) => a.m - b.m)[0];
    if (!near || near.m > near.g.radiusM) throw new HrmsError(403, 'OUTSIDE_GEOFENCE', near ? `You are about ${Math.round(near.m)} m from the workplace; punching works within ${near.g.radiusM} m.` : 'There is no workplace set for your location.');
  }
  const at = nowIn(s.defaultTimezone);
  const report = await ingestPunches(conn, c, [{ deviceUserId: e.employee_code ?? `E${e.id}`, employeeId, at, direction, method: 'WEB', lat, lng, ip }],
    { deviceId: null, timezone: s.defaultTimezone, source: 'WEB' });
  if (!report.inserted) throw conflict('DUPLICATE', 'That punch is already recorded.');
  return { punch: { at, direction }, report };
}

export default { ingestPunches, processAfterCommit, retryPending, putMapping, autoMap, listMappings, unmappedQueue, webPunch, defaultUserId, mappingOf, newBatchId, processPunchDays };
export { day };
