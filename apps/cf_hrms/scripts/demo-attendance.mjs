/**
 * demo-attendance.mjs — a LOCAL demo of attendance for Karni (TM/CF_HRMS_HIRING_SPEC.md §28).
 *
 *   node apps/cf_hrms/scripts/demo-attendance.mjs            make it (removes an earlier demo first)
 *   node apps/cf_hrms/scripts/demo-attendance.mjs --clean    take it all away
 *
 * LOCAL ONLY: refuses --target=prod and any DB_HOST that is not this machine.
 *
 * What it makes:
 *   - attendance is live from 1 October 2026;
 *   - a device "Main gate (demo)", serial DEMO-ATT-01 (ZKTeco, ADMS), with every Karni employee mapped
 *     on it by the default number (employee code without letters);
 *   - one attendance policy, "Attendance — Executives (demo)", given to the roles of Karni's executive
 *     leave policy (KPPL/HR/POL/004): grace 10 minutes, every 3 late marks -> half a day of CL (else
 *     half a day without pay), under 4.5 h worked is a half day, one punch must be corrected within
 *     3 days, short permission up to 2 h once a month (Karni POL/007);
 *   - 1–19 October 2026 of punches for everyone, as a device would send them: mostly on time, some late
 *     (four executives late often enough for a penalty), short days, missing punches, absences, the night
 *     shift across midnight (19 October's night shift is still running: only its IN), and three
 *     punches from enrol numbers nobody is mapped to (the unmapped queue);
 *   - one approved day of CL for an executive (through the leave service);
 *   - then every day processed, and the penalties applied.
 * --clean takes away exactly that (and any attendance requests, web punches and rows of October 2026
 * at Karni made while trying it).
 */
import { resolveTarget } from './dbTarget.mjs';

if (process.argv.some((a) => a.startsWith('--target')) || resolveTarget().isProd) { console.error('Local only: this demo never runs against production.'); process.exit(2); }
if (!['localhost', '127.0.0.1', '::1', undefined, ''].includes(process.env.DB_HOST)) { console.error(`Local only: DB_HOST is ${process.env.DB_HOST}.`); process.exit(2); }

const { pool, withTransaction } = await import('../lib/db.js');
const { ingestPunches, defaultUserId } = await import('../services/attendance/punches.js');
const { processRange, seatsOf } = await import('../services/attendance/process.js');
const POL = await import('../services/attendance/policy.js');
const REQ = await import('../services/leave/requestService.js');
const { attendanceMonth } = await import('../services/attendance/month.js');

const CLEAN = process.argv.includes('--clean');
const SERIAL = 'DEMO-ATT-01';
const POLICY_NAME = 'Attendance — Executives (demo)';
const FROM = '2026-10-01';
const TO = '2026-10-19';
const DEMO_REASON = 'Demo attendance';

const one = async (db, sql, p) => (await db.query(sql, p))[0][0] ?? null;
const pad = (n) => String(n).padStart(2, '0');
const addMin = (wall, m) => new Date(Date.parse(`${wall.replace(' ', 'T')}Z`) + m * 60000).toISOString().slice(0, 19).replace('T', ' ');
/** A number from 0 to 1, the same every run for the same inputs. */
const rand = (...k) => { let h = 2166136261; for (const ch of k.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };

async function clean(db, companyId) {
  const said = [];
  const run = async (label, sql, p) => { const [r] = await db.query(sql, p); if (r.affectedRows) said.push(`${label}: ${r.affectedRows}`); };
  const [pen] = await db.query("SELECT leave_request_id FROM hrms_attendance_penalties WHERE company_id = ? AND period_month >= '2026-10' AND leave_request_id IS NOT NULL", [companyId]);
  await run('penalties', "DELETE FROM hrms_attendance_penalties WHERE company_id = ? AND period_month >= '2026-10'", [companyId]);
  if (pen.length) await run('their system leave requests', 'DELETE FROM hrms_leave_requests WHERE company_id = ? AND id IN (?) AND raised_by_system = 1', [companyId, pen.map((p) => p.leave_request_id)]);
  await run('system leave requests left', "DELETE FROM hrms_leave_requests WHERE company_id = ? AND raised_by_system = 1 AND from_date >= '2026-10-01'", [companyId]);
  await run('demo leave', 'DELETE FROM hrms_leave_requests WHERE company_id = ? AND reason LIKE ?', [companyId, `${DEMO_REASON}%`]);
  await run('attendance requests', "DELETE FROM hrms_attendance_regularizations WHERE company_id = ? AND attendance_date >= '2026-10-01'", [companyId]);
  await run('days', "DELETE FROM hrms_attendance_records WHERE company_id = ? AND attendance_date >= '2026-10-01'", [companyId]);
  const dev = await one(db, 'SELECT id FROM hrms_attendance_devices WHERE company_id = ? AND serial_number = ?', [companyId, SERIAL]);
  if (dev) {
    await run('punches', 'DELETE FROM hrms_attendance_punches WHERE company_id = ? AND device_id = ?', [companyId, dev.id]);
    await run('mappings', 'DELETE FROM hrms_attendance_device_users WHERE company_id = ? AND device_id = ?', [companyId, dev.id]);
    await run('device', 'DELETE FROM hrms_attendance_devices WHERE company_id = ? AND id = ?', [companyId, dev.id]);
  }
  await run('web punches', "DELETE FROM hrms_attendance_punches WHERE company_id = ? AND source = 'WEB' AND punched_at >= '2026-10-01'", [companyId]);
  const pol = await one(db, 'SELECT id FROM hrms_attendance_policies WHERE company_id = ? AND name = ?', [companyId, POLICY_NAME]);
  if (pol) {
    await run('policy assignments', 'DELETE FROM hrms_attendance_policy_assignments WHERE company_id = ? AND policy_id = ?', [companyId, pol.id]);
    await run('policy', 'DELETE FROM hrms_attendance_policies WHERE company_id = ? AND id = ?', [companyId, pol.id]);
  }
  await run('months', "DELETE FROM hrms_attendance_months WHERE company_id = ? AND period_month >= '2026-10'", [companyId]);
  await run('runs', 'DELETE FROM hrms_attendance_runs WHERE company_id = ?', [companyId]);
  await run('settings', 'DELETE FROM hrms_attendance_settings WHERE company_id = ?', [companyId]);
  return said;
}

async function make(db, c) {
  const companyId = c.companyId;
  await db.query(`INSERT INTO hrms_attendance_settings (company_id, live_from, web_punch_enabled, created_by) VALUES (?, ?, 0, ?)
                  ON DUPLICATE KEY UPDATE live_from = VALUES(live_from)`, [companyId, FROM, c.userId]);
  const [ins] = await db.query("INSERT INTO hrms_attendance_devices (company_id, name, serial_number, make, model, timezone, protocol, notes, created_by) VALUES (?, 'Main gate (demo)', ?, 'ZKTeco', 'K40 Pro', 'Asia/Kolkata', 'ADMS', 'Made by demo-attendance.mjs', ?)",
    [companyId, SERIAL, c.userId]);
  const deviceId = ins.insertId;

  // The policy, for the executive roles.
  const [[cl]] = await db.query("SELECT id FROM hrms_leave_types WHERE company_id = ? AND code = 'CL' AND deleted_at IS NULL", [companyId]);
  const { policy } = await POL.createPolicy(db, c, {
    name: POLICY_NAME, code: 'DEMO-ATT', description: 'The demo’s attendance rules for the executives (the roles of KPPL/HR/POL/004).',
    rules: {
      graceInMinutes: 10, graceOutMinutes: 10,
      lateMarks: { count: 3, includeEarlyOut: false, action: { type: 'LEAVE', days: 0.5, leaveTypeIds: cl ? [cl.id] : [], elseLop: true } },
      shortDay: { halfDayBelowHours: 4.5, absentBelowHours: null },
      missingPunch: { treatAs: 'ASK', askWithinDays: 3 },
      absentIsLop: true, sandwich: false,
      shortPermission: { perMonth: 1, maxMinutes: 120 },
    },
  });
  const [roles] = await db.query(
    `SELECT a.role_id FROM hrms_leave_policy_assignments a JOIN hrms_leave_policies p ON p.company_id = a.company_id AND p.id = a.policy_id
      WHERE a.company_id = ? AND a.scope = 'ROLE' AND a.deleted_at IS NULL AND p.code = 'KPPL/HR/POL/004'`, [companyId]);
  for (const r of roles) await POL.putAssignment(db, c, { scope: 'ROLE', targetId: r.role_id, policyId: policy.id });

  // People, their shifts, and the mapping on the device.
  const [emps] = await db.query("SELECT id, employee_code, full_name FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND employment_status <> 'EXITED' ORDER BY id", [companyId]);
  const seats = await seatsOf(db, companyId, emps.map((e) => e.id), '2026-10-19');
  const execRoles = new Set(roles.map((r) => r.role_id));
  const people = emps.filter((e) => seats.has(e.id)).map((e) => ({ ...e, shift_id: seats.get(e.id).shift_id, role_id: seats.get(e.id).role_id, exec: execRoles.has(seats.get(e.id).role_id) }));
  const [shifts] = await db.query('SELECT s.id, s.code, d.weekday, d.is_working, d.start_time, d.end_time FROM hrms_shifts s LEFT JOIN hrms_shift_days d ON d.company_id = s.company_id AND d.shift_id = s.id AND d.deleted_at IS NULL WHERE s.company_id = ?', [companyId]);
  const dayOf = new Map(shifts.map((s) => [`${s.id}|${s.weekday}`, s]));
  const used = new Set();
  const userOf = new Map();
  for (const p of people) {
    let uid = defaultUserId(p.employee_code) ?? String(p.id);
    if (used.has(uid)) uid = `${uid}${p.id}`;
    used.add(uid);
    userOf.set(p.id, uid);
    await db.query('INSERT INTO hrms_attendance_device_users (company_id, device_id, device_user_id, employee_id, created_by) VALUES (?, ?, ?, ?, ?)', [companyId, deviceId, uid, p.id, c.userId]);
  }

  // Punches, 1–19 October. Four executives on fixed hours are late often (a penalty each).
  const lateOften = new Set(people.filter((p) => p.exec && dayOf.get(`${p.shift_id}|1`)?.start_time).slice(0, 4).map((p) => p.id));
  const punches = [];
  const now = '2026-10-20 00:30:00';
  const add = (p, at, status) => { if (at <= now) punches.push({ deviceUserId: userOf.get(p.id), at, direction: status === 0 ? 'IN' : 'OUT', method: rand(p.id, at) < 0.5 ? 'FINGER' : 'FACE', raw: `${userOf.get(p.id)}\t${at}\t${status}\t1\t0\t0\t0` }); };
  const tally = { onTime: 0, late: 0, short: 0, missing: 0, absent: 0, off: 0 };
  for (let d = 1; d <= 19; d += 1) {
    const date = `2026-10-${pad(d)}`;
    const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    for (const p of people) {
      const sd = dayOf.get(`${p.shift_id}|${weekday}`);
      if (sd && !sd.is_working) { tally.off += 1; continue; }
      if (!sd && weekday === 7) { tally.off += 1; continue; }
      const start = sd?.start_time ? String(sd.start_time).slice(0, 5) : '09:30';
      const end = sd?.end_time ? String(sd.end_time).slice(0, 5) : '18:30';
      const startAt = `${date} ${start}:00`;
      const endAt = end <= start ? addMin(`${date} ${end}:00`, 24 * 60) : `${date} ${end}:00`;
      const r = rand(p.id, date);
      const jitter = Math.floor(rand(date, p.id, 'j') * 14);
      if (lateOften.has(p.id) && [2, 5, 7, 9, 13].includes(d)) { add(p, addMin(startAt, 14 + jitter * 2), 0); add(p, addMin(endAt, jitter), 1); tally.late += 1; continue; }
      if (r < 0.05) { tally.absent += 1; continue; }
      if (r < 0.09) { add(p, addMin(startAt, -jitter), 0); tally.missing += 1; continue; }
      if (r < 0.13) { add(p, addMin(startAt, -jitter), 0); add(p, addMin(startAt, 200 + jitter), 1); tally.short += 1; continue; }
      if (r < 0.25) { add(p, addMin(startAt, 12 + jitter * 2), 0); add(p, addMin(endAt, jitter), 1); tally.late += 1; continue; }
      add(p, addMin(startAt, -5 - jitter), 0); add(p, addMin(endAt, jitter), 1); tally.onTime += 1;
    }
  }
  // Three enrol numbers nobody is mapped to: contract workers not on the system yet.
  for (const [uid, at] of [['9001', '2026-10-15 07:55:10'], ['9001', '2026-10-15 20:02:40'], ['9002', '2026-10-16 08:01:00']]) punches.push({ deviceUserId: uid, at, direction: 'UNKNOWN', method: 'CARD', raw: `${uid}\t${at}\t0\t2\t0\t0\t0` });
  const report = await ingestPunches(db, { ...c }, punches, { deviceId, timezone: 'Asia/Kolkata', source: 'ADMS', process: false, batchId: `DEMO-${Date.now().toString(36)}` });
  await db.query("UPDATE hrms_attendance_devices SET last_seen_at = UTC_TIMESTAMP(), last_ip = '192.168.1.201', attlog_stamp = '1' WHERE id = ?", [deviceId]);

  // One approved day of CL for an executive (through the leave service), on a day they did not punch.
  let leaveNote = 'no executive could take CL (waiting period)';
  if (cl) {
    for (const p of people.filter((x) => x.exec && !lateOften.has(x.id))) {
      try {
        const viewer = { userId: c.userId, employeeId: null, hr: { all: true } };
        const r = await REQ.submitForPerson(db, c, { employeeId: p.id, leaveTypeId: cl.id, from: '2026-10-12', to: '2026-10-12', reason: `${DEMO_REASON}: family function.` }, viewer);
        await REQ.decide(db, c, viewer, r.request.id, 'APPROVE', { note: 'Demo' });
        await db.query("DELETE FROM hrms_attendance_punches WHERE company_id = ? AND device_id = ? AND employee_id = ? AND punched_at BETWEEN '2026-10-12 00:00:00' AND '2026-10-12 23:59:59'", [companyId, deviceId, p.id]);
        leaveNote = `${p.full_name}: CL on 12 Oct, approved`;
        break;
      } catch { /* the next one */ }
    }
  }

  const processed = await processRange(db, c, { from: FROM, to: TO, kind: 'MANUAL', note: 'demo-attendance', now: '2026-10-20 00:30:00' });
  return { deviceId, policy, roles: roles.length, people: people.length, report, tally, lateOften: [...lateOften], leaveNote, processed };
}

try {
  const [[company]] = await pool.query("SELECT id, name FROM companies WHERE slug = 'karni' AND deleted_at IS NULL");
  if (!company) throw new Error('No company "karni" here.');
  const [[owner]] = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [company.id]);
  const c = { companyId: company.id, userId: owner?.id ?? null, owner: true };
  console.log(`\n  ${company.name} (${company.id}) — LOCAL\n`);
  const removed = await withTransaction((db) => clean(db, company.id));
  console.log(removed.length ? `  removed an earlier demo — ${removed.join(', ')}` : '  no earlier demo');
  if (!CLEAN) {
    const r = await withTransaction((db) => make(db, c));
    const m = await attendanceMonth(company.id, '2026-10');
    const [[pen]] = await pool.query("SELECT COUNT(*) AS n, SUM(action = 'LEAVE') AS leave_n, SUM(action = 'LOP') AS lop_n FROM hrms_attendance_penalties WHERE company_id = ? AND period_month = '2026-10' AND status = 'APPLIED'", [company.id]);
    console.log(`  live from ${FROM}; device ${SERIAL} (id ${r.deviceId}), ${r.people} people mapped on it`);
    console.log(`  policy "${POLICY_NAME}" (id ${r.policy.id}) given to ${r.roles} executive roles`);
    console.log(`  punches: ${r.report.inserted} stored (${r.report.unmapped} unmapped); days: on time ${r.tally.onTime}, late ${r.tally.late}, short ${r.tally.short}, one punch ${r.tally.missing}, absent ${r.tally.absent}`);
    console.log(`  leave: ${r.leaveNote}`);
    console.log(`  processed ${r.processed.daysWritten} days; penalties ${pen.n} (CL ${pen.leave_n ?? 0}, without pay ${pen.lop_n ?? 0})`);
    console.log(`  October so far: present ${m.totals.present} person-days, absent (LOP) ${m.totals.absentLop}, LOP days ${m.totals.lopDays}\n`);
    console.log('  Try: Attendance › Today (date 2026-10-19), Month, Penalties, Devices. Simulate the device: node scripts/cf_hrms/sim-iclock.mjs --sn=DEMO-ATT-01\n');
  } else console.log('  clean: done\n');
  await pool.end();
  process.exit(0);
} catch (err) {
  console.error(`\n  FAILED: ${err.message}\n${err.stack}`);
  await pool.end();
  process.exit(1);
}
