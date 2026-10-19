/**
 * attendance_test.mjs — the attendance module (TM/CF_HRMS_HIRING_SPEC.md §28, 2026-10-19).
 *
 *   0. the schema (apply-attendance-schema.mjs): a second run plans nothing;
 *   1. pure: the ADMS protocol (ATTLOG / OPERLOG / handshake), the policy sentences and their refusals,
 *      the resolution (role > label > location > company), a day (computeDay: on time, late, grace,
 *      short day, missing punch ×3, absent, future, leave, half-day leave both ways, holiday, weekly
 *      off worked + overtime, short permission), a night shift across midnight, the sandwich, the
 *      late-mark blocks, the EL present-days gate;
 *   2. processing a month of punches for real people: day and night shift, holiday, weekly off,
 *      leave and half-day leave (through §22), source precedence (manual, import), re-running;
 *   3. every penalty action — LEAVE (a SYSTEM request through §22), LEAVE falling back to LOP, LOP,
 *      AMOUNT, WARNING — waive (HR, and a manager through the team route) and reverse;
 *   4. the month summary against hand-worked numbers;
 *   5. requests through Approvals: correct a day (reverses the late-mark penalty), short permission,
 *      on duty; who may decide;
 *   6. the leave link: EL needs present days, the ML 80-days note, leave preview shows attendance,
 *      cancelling leave re-processes;
 *   7. the ways in over HTTP: ADMS iclock (an unknown serial refused, mapped and unmapped punches, the
 *      mapping attaches), the API key (Owner only, shown once, idempotent, revoked), imports (punches
 *      CSV, days xlsx), the web punch (off, IP, geofence);
 *   8. close and re-open a month; rights and team scope; tenant isolation;
 *   9. nothing is left behind.
 *
 *   node scripts/cf_hrms/attendance_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: one connection, one transaction (pool.query / getConnection point at it),
 * rolled back at the end. Local only. Uses September 2026 (a past month) and "live from" 2026-09-01
 * inside the transaction, so a local demo in October does not get in the way.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import iclockRoutes from '../../apps/cf_hrms/routes/iclock.js';
import integrationRoutes from '../../apps/cf_hrms/routes/integrations.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as LEAVE from '../../apps/cf_hrms/services/leavePolicyService.js';
import * as BAL from '../../apps/cf_hrms/services/leave/balance.js';
import * as REQ from '../../apps/cf_hrms/services/leave/requestService.js';
import { RULE_DEFAULTS as LEAVE_DEFAULTS } from '../../apps/cf_hrms/services/leavePolicyRead.js';
import * as ADMS from '../../apps/cf_hrms/services/attendance/adms.js';
import * as POL from '../../apps/cf_hrms/services/attendance/policy.js';
import * as PROC from '../../apps/cf_hrms/services/attendance/process.js';
import * as PEN from '../../apps/cf_hrms/services/attendance/penalties.js';
import * as PUN from '../../apps/cf_hrms/services/attendance/punches.js';
import { attendanceMonth } from '../../apps/cf_hrms/services/attendance/month.js';
import { schemaSteps, createStatements } from '../../apps/cf_hrms/scripts/apply-attendance-schema.mjs';
import { simulate } from './sim-iclock.mjs';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const section = (title) => console.log(`\n${title}`);
const J = (x) => JSON.stringify(x);
const t0 = Date.now();

const TABLES = ['hrms_attendance_records', 'hrms_attendance_regularizations', 'hrms_attendance_punches', 'hrms_attendance_devices', 'hrms_attendance_device_users',
  'hrms_attendance_api_keys', 'hrms_attendance_settings', 'hrms_attendance_policies', 'hrms_attendance_policy_assignments', 'hrms_attendance_penalties',
  'hrms_attendance_months', 'hrms_attendance_runs', 'hrms_leave_requests', 'hrms_leave_types', 'hrms_leave_policies', 'hrms_audit_log', 'hrms_employees',
  'hrms_positions', 'hrms_work_assignments', 'hrms_shifts', 'hrms_shift_days', 'hrms_holidays', 'users', 'app_user_access'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) { const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM ${t}`); out[t] = Number(r.n); }
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ══ 0. the schema ═════════════════════════════════════════════════════════ */
section('[0] The schema');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok((await schemaSteps(conn)).length === 0, 'apply-attendance-schema: nothing left to do here (idempotent)');
    ok(createStatements().length === 10, 'init.sql §28 holds the ten new tables, read by the script', `${createStatements().length}`);
    const [[src]] = await conn.query("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'source'");
    ok(/REGULARIZATION/.test(src.t), 'attendance rows know the source REGULARIZATION');
  } finally { await conn.end(); }
}

/* ══ 1. pure ═══════════════════════════════════════════════════════════════ */
section('[1] The ADMS protocol');
{
  const { punches, bad } = ADMS.parseAttlog('101\t2026-09-01 08:58:12\t0\t1\t0\t0\t0\n102\t2026-09-01 18:02:00\t1\t15\t0\n103 2026-09-01 09:10:00 0 2\n\nxx\tnot a time\t0\t1\n');
  ok(punches.length === 3 && punches[0].deviceUserId === '101' && punches[0].at === '2026-09-01 08:58:12' && punches[0].direction === 'IN' && punches[0].method === 'FINGER'
    && punches[1].direction === 'OUT' && punches[1].method === 'FACE' && punches[2].deviceUserId === '103' && punches[2].method === 'CARD', 'ATTLOG lines: PIN, time, status (0 in / 1 out), verify (1 finger, 15 face, 2 card); spaces as well as tabs', J(punches));
  ok(bad.length === 1 && bad[0].why === 'no readable time', 'a line that cannot be read is set aside with why', J(bad));
  const op = ADMS.parseOperlog('USER PIN=1\tName=A\nOPLOG 4\t0\t2026-09-01 10:00:00\nFP PIN=1\tFID=0');
  ok(op.lines.length === 3 && op.kinds.USER === 1 && op.kinds.OPLOG === 1 && op.kinds.FP === 1, 'OPERLOG lines are counted by kind (stored, never acted on)');
  const hs = ADMS.handshakeText('ABC123', { attlogStamp: '55' });
  ok(/^GET OPTION FROM: ABC123\n/.test(hs) && /\nATTLOGStamp=55\n/.test(hs) && /\nStamp=55\n/.test(hs) && /\nRealtime=1\n/.test(hs) && /TransFlag=TransData AttLog/.test(hs), 'the handshake answers with the options, both cursor spellings');
  ok(ADMS.validSerial('BJ2C1234567') && !ADMS.validSerial('a b') && !ADMS.validSerial('x'), 'a serial is 3–64 letters, digits, - and _');
}

section('[1b] Attendance policies: the rules and their sentences');
const RULES_FULL = {
  graceInMinutes: 10, graceOutMinutes: 10,
  lateMarks: { count: 3, includeEarlyOut: false, action: { type: 'LEAVE', days: 0.5, leaveTypeIds: [901], elseLop: true } },
  shortDay: { halfDayBelowHours: 4.5, absentBelowHours: 2 },
  missingPunch: { treatAs: 'ASK', askWithinDays: 3 },
  absentIsLop: true, sandwich: true,
  shortPermission: { perMonth: 1, maxMinutes: 120 },
  overtime: { afterMinutes: 30, rateMultiplier: 2, minMinutes: 30, maxMinutesPerDay: 240 },
};
{
  const problems = [];
  const r = POL.readRules(RULES_FULL, problems, { typeIds: new Set([901]) });
  ok(problems.length === 0 && r.lateMarks.count === 3 && r.lateMarks.action.days === 0.5 && r.overtime.maxMinutesPerDay === 240, 'a full rule set reads clean', J(problems));
  const s = POL.sentencesOf(r, { typeNames: new Map([[901, 'Casual leave']]) });
  const want = [
    'Arriving more than 10 minutes after the shift starts is a late mark.',
    'Leaving more than 10 minutes before the shift ends is an early exit.',
    'Every 3 late marks in a month: half a day is taken from Casual leave, or, when none is left, half a day without pay.',
    'Under 4.5 hours worked is a half day; under 2 hours is absent.',
    'A day with only one punch must be corrected within 3 days, or it counts as absent.',
    'An absent day without approved leave is unpaid (loss of pay).',
    'Weekly offs and holidays between two absent days count as absent too.',
    'Short permission: up to 2 h, once a month; within it a late arrival or an early exit is excused.',
    'Overtime counts once someone works 30 min or more beyond the shift, at 2 times the hourly rate; at least 30 min; at most 4 h a day. Work on a weekly off or holiday is all overtime.',
  ];
  ok(J(s) === J(want), 'one sentence per rule, in words', J(s));
  const actions = [[{ type: 'LOP', days: 1 }, 'a whole day without pay'], [{ type: 'AMOUNT', amount: 250 }, '₹250 is deducted from pay'], [{ type: 'WARNING' }, 'a warning is recorded; nothing is deducted'],
    [{ type: 'LEAVE', days: 1, leaveTypeIds: [901], elseLop: false }, 'a whole day is taken from Casual leave; when none is left, a warning is recorded']];
  ok(actions.every(([a, w]) => POL.actionWords(a, new Map([[901, 'Casual leave']])) === w), 'every penalty action in words');
  ok(J(POL.sentencesOf({})) === J(['Late marks use the grace of each shift.', 'A day with only one punch counts as present, marked for a correction.', 'An absent day without approved leave is unpaid (loss of pay).', 'No overtime is counted.']),
    'an empty policy says what applies anyway', J(POL.sentencesOf({})));
  const p2 = [];
  POL.readRules({ graceInMinutes: -1, lateMarks: { count: 0, action: { type: 'LEAVE', days: 2, leaveTypeIds: [7] } }, shortDay: { halfDayBelowHours: 2, absentBelowHours: 4 }, missingPunch: { treatAs: 'X' } }, p2, { typeIds: new Set([901]) });
  ok(p2.length >= 6 && p2.some((x) => /half a day or a whole day/.test(x)) && p2.some((x) => /not one of this company/.test(x)) && p2.some((x) => /must be fewer than/.test(x)), 'refusals come in words, all at once', J(p2));
  // The resolution: role > label > location > company.
  const P = (id) => ({ id, name: `P${id}`, rules: {} });
  const index = { company: P(1), byLocation: new Map([[5, P(2)]]), byLabel: new Map([[7, P(3)]]), labelOfDepartment: new Map([[70, 7]]), byRole: new Map([[9, P(4)]]), names: new Map([['L5', 'Unit 2'], ['B7', 'Machine']]) };
  ok(POL.resolveAttendance(index, { roleId: 9, locationId: 5, departmentId: 70 }).policy.id === 4 && POL.resolveAttendance(index, { roleId: 1, locationId: 5, departmentId: 70 }).policy.id === 3
    && POL.resolveAttendance(index, { locationId: 5, departmentId: 1 }).policy.id === 2 && POL.resolveAttendance(index, {}).from === 'COMPANY'
    && POL.resolveAttendance({ ...index, company: null }, {}).policy === null, 'which policy: role, else label, else location, else company, else none — like leave');
}

section('[1c] One day, by hand');
const shiftDay = { id: 1, graceIn: 5, graceOut: 5, days: new Map([1, 2, 3, 4, 5, 6].map((w) => [w, { isWorking: true, start: '09:00', end: '18:00', crosses: false, breakMinutes: 60 }]).concat([[7, { isWorking: false }]])) };
const shiftNight = { id: 2, graceIn: 0, graceOut: 0, days: new Map([1, 2, 3, 4, 5, 6].map((w) => [w, { isWorking: true, start: '22:00', end: '06:00', crosses: true, breakMinutes: 60 }]).concat([[7, { isWorking: false }]])) };
const HOL = new Map([['2026-09-17', 'Ganesh Chaturthi']]);
const NOW = '2026-10-20 12:00:00';
const P1 = { ...POL.RULE_DEFAULTS, ...RULES_FULL };
const day = (date, ats, o = {}) => PROC.computeDay({ plan: PROC.planDay(date, o.shift ?? shiftDay, HOL), punches: ats.map((a, i) => ({ id: i + 1, at: a, direction: o.dirs?.[i] ?? 'UNKNOWN' })), rules: o.rules ?? P1, now: o.now ?? NOW, leave: o.leave ?? null, permissionMinutes: o.permit ?? 0, onDuty: o.onDuty ?? false });
{
  const plan = PROC.planDay('2026-09-01', shiftDay, HOL);
  ok(plan.kind === 'WORKING' && plan.startAt === '2026-09-01 09:00:00' && plan.endAt === '2026-09-01 18:00:00' && plan.scheduled === 480 && plan.windowFrom === '2026-09-01 05:00:00',
    'a day shift: 09:00–18:00, 8 h after the break, punches from 05:00 count', J(plan));
  const night = PROC.planDay('2026-09-01', shiftNight, HOL);
  ok(night.crosses && night.endAt === '2026-09-02 06:00:00' && night.windowTo === '2026-09-02 14:00:00', 'a night shift ends the next day; its window runs to 14:00 next day', J(night));
  const a = day('2026-09-01', ['2026-09-01 08:58:00', '2026-09-01 18:05:00']);
  ok(a.status === 'PRESENT' && a.present === 1 && a.worked === 487 && a.late === 0 && !a.lateMark && a.source === 'BIOMETRIC' && a.overtime === 0, 'on time: present, 9 h 7 min less the 1 h break', J(a));
  const b = day('2026-09-02', ['2026-09-02 09:10:00', '2026-09-02 18:00:00']);
  const b2 = day('2026-09-02', ['2026-09-02 09:11:00', '2026-09-02 18:00:00']);
  ok(b.late === 10 && !b.lateMark && b2.lateMark && b2.status === 'PRESENT', 'the grace: 10 minutes late is not a late mark, 11 is');
  const shortHalf = day('2026-09-05', ['2026-09-05 09:00:00', '2026-09-05 12:30:00']);
  const shortAbs = day('2026-09-09', ['2026-09-09 09:00:00', '2026-09-09 09:50:00']);
  ok(shortHalf.status === 'HALF_DAY' && shortHalf.present === 0.5 && shortHalf.absent === 0.5 && shortHalf.worked === 210 && shortAbs.status === 'ABSENT' && shortAbs.absent === 1,
    'a short day: under 4.5 h is a half day, under 2 h absent', J([shortHalf, shortAbs]));
  const askLate = day('2026-09-07', ['2026-09-07 09:00:00'], { dirs: ['IN'] });
  const askIn = day('2026-10-19', ['2026-10-19 09:00:00'], { dirs: ['IN'] });
  const half = day('2026-09-07', ['2026-09-07 09:00:00'], { rules: { ...P1, missingPunch: { treatAs: 'HALF_DAY' } } });
  const abs = day('2026-09-07', ['2026-09-07 18:00:00'], { rules: { ...P1, missingPunch: { treatAs: 'ABSENT' } }, dirs: ['OUT'] });
  ok(askLate.status === 'ABSENT' && askLate.missing && /not corrected by 2026-09-10/.test(askLate.reason) && askIn.status === 'PRESENT' && askIn.missing && /ask for a correction by 2026-10-22/.test(askIn.reason)
    && half.status === 'HALF_DAY' && half.present === 0.5 && abs.status === 'ABSENT' && /Only an OUT punch/.test(abs.reason),
  'a missing punch: ask for a correction within 3 days (then absent), or a half day, or absent', J([askLate.reason, askIn.reason, half.status, abs.reason]));
  const none = day('2026-09-08', []);
  const future = day('2026-10-21', []);
  const todayRunning = day('2026-10-20', ['2026-10-20 09:20:00'], { now: '2026-10-20 12:00:00' });
  ok(none.status === 'ABSENT' && none.absent === 1 && none.source === 'SYSTEM' && future.status === 'UNKNOWN' && future.absent === 0
    && todayRunning.status === 'PRESENT' && !todayRunning.missing && todayRunning.lateMark && /At work since 09:20/.test(todayRunning.reason),
  'no punch: absent once the day is over, unknown before it; today with one punch is "at work", late counted', J([none.reason, future.reason, todayRunning.reason]));
  const leave = day('2026-09-16', [], { leave: { requestId: 1, half: null } });
  const halfWorked = day('2026-09-18', ['2026-09-18 13:30:00', '2026-09-18 18:00:00'], { leave: { requestId: 2, half: 'FIRST' } });
  const halfNot = day('2026-09-19', [], { leave: { requestId: 3, half: 'SECOND' } });
  ok(leave.status === 'LEAVE' && leave.leave === 1 && halfWorked.status === 'PRESENT' && halfWorked.present === 0.5 && halfWorked.leave === 0.5 && halfWorked.late === 0
    && halfNot.status === 'HALF_DAY' && halfNot.leave === 0.5 && halfNot.absent === 0.5, 'leave: a whole day LEAVE; half-day leave + half a day worked = PRESENT; half-day leave and no punch = half absent', J([halfWorked, halfNot]));
  const hol = day('2026-09-17', []);
  const off = day('2026-09-20', ['2026-09-20 10:00:00', '2026-09-20 15:30:00']);
  const ot = day('2026-09-15', ['2026-09-15 09:00:00', '2026-09-15 20:00:00']);
  const otSmall = day('2026-09-15', ['2026-09-15 09:00:00', '2026-09-15 18:20:00']);
  ok(hol.status === 'HOLIDAY' && /Ganesh Chaturthi — holiday/.test(hol.reason) && off.status === 'WEEKLY_OFF' && off.overtime === 240 && off.worked === 330
    && ot.overtime === 120 && ot.status === 'PRESENT' && otSmall.overtime === 0, 'a holiday; a weekly off worked is all overtime (at most 4 h); overtime from 30 minutes beyond the shift', J([off, ot.overtime, otSmall.overtime]));
  const permit = day('2026-09-04', ['2026-09-04 09:40:00', '2026-09-04 18:00:00'], { permit: 60 });
  const permitShort = day('2026-09-04', ['2026-09-04 10:30:00', '2026-09-04 18:00:00'], { permit: 60 });
  ok(!permit.lateMark && /excused by a short permission/.test(permit.reason) && permitShort.lateMark, 'a short permission excuses a late arrival within its minutes, not beyond');
  const duty = day('2026-09-08', [], { onDuty: true });
  ok(duty.status === 'PRESENT' && duty.present === 1 && /On duty/.test(duty.reason), 'on duty: present without a punch');
  // The night shift across midnight, and a punch used by one day only.
  const person = { shift: shiftNight, holidays: new Map(), rules: P1, leaves: [], regs: [],
    punches: [['2026-09-05 21:58:00', 'IN'], ['2026-09-06 06:02:00', 'OUT'], ['2026-09-07 22:20:00', 'IN'], ['2026-09-08 06:00:00', 'OUT']].map(([at, direction], i) => ({ id: i + 1, at, direction })) };
  const days = PROC.computePerson(person, ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'], NOW);
  ok(days[0].result.status === 'PRESENT' && days[0].result.worked === 424 && days[1].result.status === 'WEEKLY_OFF' && !days[1].result.worked
    && days[2].result.lateMark && days[2].result.late === 20 && days[3].result.status === 'ABSENT',
  'a night shift: 21:58 to 06:02 next morning is one day; the Sunday after it is not "worked"; 22:20 is 20 minutes late', J(days.map((d) => [d.date, d.result.status, d.result.worked, d.result.late])));
  // The sandwich.
  const sw = (s, absent = 0, leave = 0) => ({ result: { status: s, absent, leave, reason: s }, rules: { sandwich: true } });
  const seq = [sw('ABSENT', 1), sw('WEEKLY_OFF'), sw('HOLIDAY'), sw('ABSENT', 1), sw('WEEKLY_OFF'), sw('LEAVE', 0, 1)].map((d, i) => ({ ...d, date: `d${i}` }));
  ok(J(PROC.applySandwich(seq)) === J(['d1', 'd2']) && seq[1].result.status === 'ABSENT' && seq[4].result.status === 'WEEKLY_OFF', 'sandwich: days off between two absent days become absent; next to leave they do not');
  ok(J(PEN.lateMarkBlocks(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3, '2026-09').map((b) => [b.key, b.date])) === J([['LATE_MARKS:2026-09:1', 'c'], ['LATE_MARKS:2026-09:2', 'f']]), 'late marks: every 3rd mark is a penalty, charged on its date');
  // EL needs present days (§28.4), pure.
  const el = { ...LEAVE_DEFAULTS, basis: 'PER_YEAR', accrual: 'MONTHLY', days: 12, creditInArrears: true, minPresentDaysForCredit: 20 };
  const year = BAL.yearFromStart(2026, 4);
  const att = { liveFrom: '2026-09-01', presentByMonth: new Map([['2026-09', 16], ['2026-10', 22]]) };
  const e1 = BAL.earnedOf(el, { year, joinDate: '2020-01-01', asOf: '2026-11-15', attendance: att });
  const e0 = BAL.earnedOf(el, { year, joinDate: '2020-01-01', asOf: '2026-11-15' });
  ok(e0.amount === 8 && e1.amount === 7 && /not credited for September 2026 \(16 present days\): 20 present days are needed/.test(e1.text), 'EL: a month under 20 present days is not credited once attendance is live; months before it are', J([e0, e1]));
}

/* ══ the database part: one transaction, rolled back ═════════════════════ */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_at_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_at_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_at_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZAT${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
const recOf = async (employeeId, date) => one('SELECT * FROM hrms_attendance_records WHERE employee_id = ? AND attendance_date = ? AND deleted_at IS NULL', [employeeId, date]);

let server;
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  const app = await hrmsAppOf(db, COMPANY);
  const owner = await one(
    `SELECT u.id, u.email, u.name FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL JOIN roles r ON r.id = aua.role_id
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [app.id, COMPANY]);
  if (!owner) throw new Error('This company has no Owner login.');
  const hr = { companyId: COMPANY, userId: owner.id, owner: true };
  const other = await one(
    `SELECT co.id, co.name, co.slug, a.id AS app_id FROM companies co JOIN apps a ON a.company_id = co.id AND a.slug = 'cf_hrms' AND a.deleted_at IS NULL
      WHERE co.id <> ? AND co.deleted_at IS NULL ORDER BY co.id LIMIT 1`, [COMPANY]);
  console.log(`\nattendance_test — ${company.name} (${COMPANY}), run tag ${TAG}`);

  /* ══ fixture ═══════════════════════════════════════════════════════════ */
  const D0 = '2024-01-01';
  const dept = async (name) => ins("INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, 'Department')", [COMPANY, `${TAG}${name}`, `${TAG} ${name}`]);
  const D = await dept('D');
  const D2 = await dept('D2');
  const roleOf = async (code) => ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status) VALUES (?, ?, ?, 'For a test.', 'ACTIVE')", [COMPANY, `${TAG}${code}`, `${TAG} ${code}`]);
  const R = {};
  for (const k of ['R1', 'R3', 'R4', 'R5', 'R6', 'R7', 'RM', 'RN']) R[k] = await roleOf(k);
  const calId = await ins('INSERT INTO hrms_holiday_calendars (company_id, name) VALUES (?, ?)', [COMPANY, `${TAG} Calendar`]);
  await db.query('INSERT INTO hrms_holidays (company_id, calendar_id, holiday_date, name, is_optional) VALUES (?, ?, ?, ?, 0)', [COMPANY, calId, '2026-09-17', `${TAG} Ganesh Chaturthi`]);
  const shiftOf = async (code, start, end, cross) => {
    const id = await ins("INSERT INTO hrms_shifts (company_id, code, name, status, holiday_calendar_id, grace_in_minutes, grace_out_minutes, start_time, end_time, crosses_midnight) VALUES (?, ?, ?, 'ACTIVE', ?, 5, 5, ?, ?, ?)",
      [COMPANY, `${TAG}${code}`, `${TAG} ${code}`, calId, start, end, cross ? 1 : 0]);
    await db.query(`INSERT INTO hrms_shift_days (company_id, shift_id, weekday, is_working, start_time, end_time, crosses_midnight, break_minutes) VALUES ${[1, 2, 3, 4, 5, 6, 7].map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      [1, 2, 3, 4, 5, 6, 7].flatMap((wd) => [COMPANY, id, wd, wd === 7 ? 0 : 1, wd === 7 ? null : start, wd === 7 ? null : end, cross && wd !== 7 ? 1 : 0, wd === 7 ? 0 : 60]));
    return id;
  };
  const SD = await shiftOf('DAY', '09:00', '18:00', false);
  const SN = await shiftOf('NIGHT', '22:00', '06:00', true);
  const pos = async (code, roleId, deptId, shiftId = SD) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status, default_shift_id) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)",
    [COMPANY, `${TAG}-${code}`, roleId, `${TAG} ${code}`, deptId, shiftId]);
  const P = {
    m: await pos('M', R.RM, D), e1: await pos('E1', R.R1, D), e2: await pos('E2', R.R1, D, SN), e3: await pos('E3', R.R3, D), e4: await pos('E4', R.R4, D),
    e5: await pos('E5', R.R5, D), e6: await pos('E6', R.R6, D), e7: await pos('E7', R.R7, D), dh: await pos('DH', R.RM, D2), e9: await pos('E9', R.RN, D2),
  };
  const primary = await one("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
  for (const k of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']) await POS.addPositionReporting(db, hr, P[k], { toPositionId: P.m, relationshipTypeId: primary.id, isPrimary: true, effectiveFrom: D0 });
  await POS.addPositionReporting(db, hr, P.e9, { toPositionId: P.dh, relationshipTypeId: primary.id, isPrimary: true, effectiveFrom: D0 });
  const emp = async (code, gender) => ins("INSERT INTO hrms_employees (company_id, employee_code, full_name, gender, date_of_joining, employment_type, employment_status) VALUES (?, ?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE')",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, gender, D0]);
  const E = {};
  for (const [k, g] of [['m', 'Male'], ['e1', 'Male'], ['e2', 'Male'], ['e3', 'Female'], ['e4', 'Male'], ['e5', 'Male'], ['e6', 'Male'], ['e7', 'Male'], ['dh', 'Male'], ['e9', 'Female']]) E[k] = await emp(k.toUpperCase(), g);
  const seat = async (k, roleId, deptId = D) => ins("INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', ?)",
    [COMPANY, E[k], roleId, P[k], deptId, D0]);
  await seat('m', R.RM); await seat('e1', R.R1); await seat('e2', R.R1); await seat('e3', R.R3); await seat('e4', R.R4); await seat('e5', R.R5); await seat('e6', R.R6); await seat('e7', R.R7);
  await seat('dh', R.RM, D2); await seat('e9', R.RN, D2);

  // Leave: CL, EL (needs 20 present days), ML (80 days worked), LWP; given to every role but R4.
  const type = async (code, name, isPaid = true) => (await LEAVE.createLeaveType(db, hr, { code: `${TAG}${code}`, name: `${TAG} ${name}`, isPaid })).type.id;
  const LT = { cl: await type('CL', 'Casual leave'), el: await type('EL', 'Earned leave'), ml: await type('ML', 'Maternity leave'), lwp: await type('LWP', 'Leave without pay', false) };
  const lpol = (await LEAVE.createPolicy(db, hr, { name: `${TAG} Leave policy`, yearStartsMonth: 4, status: 'ACTIVE' })).policy;
  await LEAVE.updatePolicy(db, hr, lpol.id, {
    rules: [
      { leaveTypeId: LT.cl, basis: 'PER_YEAR', days: 12, accrual: 'UPFRONT', halfDayAllowed: true },
      { leaveTypeId: LT.el, basis: 'PER_YEAR', days: 12, accrual: 'MONTHLY', creditInArrears: true, minPresentDaysForCredit: 20, notes: 'Credited only for a month with 20 or more present days.' },
      { leaveTypeId: LT.ml, basis: 'PER_EVENT', days: 182, appliesTo: 'WOMEN', maxTimesInService: 2, notes: 'Only for a woman who has worked at least 80 days in the 12 months before the expected delivery date.' },
      { leaveTypeId: LT.lwp, basis: 'UNLIMITED_UNPAID', halfDayAllowed: true },
    ],
  });
  for (const k of ['R1', 'R3', 'R5', 'R6', 'R7', 'RM', 'RN']) await LEAVE.putAssignment(db, hr, { scope: 'ROLE', roleId: R[k], policyId: lpol.id });

  // Attendance: live from 1 September 2026 inside this transaction; one policy per penalty action.
  await db.query(`INSERT INTO hrms_attendance_settings (company_id, live_from, web_punch_enabled) VALUES (?, '2026-09-01', 0)
                  ON DUPLICATE KEY UPDATE live_from = '2026-09-01', web_punch_enabled = 0, ip_allow_json = NULL, geofences_json = NULL`, [COMPANY]);
  await db.query("DELETE FROM hrms_attendance_months WHERE company_id = ? AND period_month = '2026-09'", [COMPANY]);
  const apol = async (name, action) => (await POL.createPolicy(db, hr, { name: `${TAG} ${name}`, rules: { ...RULES_FULL, lateMarks: { count: 3, action } } })).policy;
  const AP = {
    leave: await apol('Leave', { type: 'LEAVE', days: 0.5, leaveTypeIds: [LT.cl], elseLop: true }),
    lop: await apol('LOP', { type: 'LOP', days: 1 }),
    amount: await apol('Amount', { type: 'AMOUNT', amount: 200 }),
    warning: await apol('Warning', { type: 'WARNING' }),
  };
  for (const [k, p] of [['R1', AP.leave], ['R3', AP.leave], ['R4', AP.leave], ['R5', AP.lop], ['R6', AP.amount], ['R7', AP.warning], ['RN', AP.leave]]) await POL.putAssignment(db, hr, { scope: 'ROLE', targetId: R[k], policyId: p.id });
  ok(AP.leave.sentences.length === 9 && AP.leave.sentences[2] === `Every 3 late marks in a month: half a day is taken from ${TAG} Casual leave, or, when none is left, half a day without pay.`,
    'a saved policy carries its sentences, naming the leave type', AP.leave.sentences[2]);

  /* ══ 2. processing ══════════════════════════════════════════════════════ */
  section('[2] Processing September for real people');
  const at = (d, t) => `2026-09-${String(d).padStart(2, '0')} ${t}:00`;
  const code = async (id) => (await one('SELECT employee_code FROM hrms_employees WHERE id = ?', [id])).employee_code;
  const punchApi = async (employeeId, list) => { const c0 = await code(employeeId); return PUN.ingestPunches(db, hr, list.map(([a, direction = 'UNKNOWN']) => ({ deviceUserId: c0, employeeId, at: a, direction })), { source: 'API', process: false }); };
  // E1 — the hand-worked month (see [4]).
  const e1 = [];
  const normal = (d) => { e1.push([at(d, '09:00'), 'IN'], [at(d, '18:00'), 'OUT']); };
  e1.push([at(1, '08:58'), 'IN'], [at(1, '18:05'), 'OUT']);
  e1.push([at(2, '09:25')], [at(2, '18:00')]);
  e1.push([at(3, '09:12')], [at(3, '18:00')]);
  e1.push([at(4, '09:40')], [at(4, '18:00')]);
  e1.push([at(5, '09:00')], [at(5, '12:30')]);
  e1.push([at(7, '09:00'), 'IN']);
  e1.push([at(9, '09:00')], [at(9, '09:50')]);
  normal(10);
  e1.push([at(15, '09:00')], [at(15, '20:00')]);
  e1.push([at(18, '13:30')], [at(18, '18:00')]);
  e1.push([at(20, '10:00')], [at(20, '14:00')]);
  for (const d of [21, 22, 23, 24, 25, 26, 28, 29, 30]) normal(d);
  await punchApi(E.e1, e1);
  // E2 — night shift.
  await punchApi(E.e2, [['2026-09-01 21:55:00', 'IN'], ['2026-09-02 06:10:00', 'OUT'], ['2026-09-02 22:20:00', 'IN'], ['2026-09-03 06:00:00', 'OUT'], ['2026-09-05 21:58:00', 'IN'], ['2026-09-06 06:02:00', 'OUT']]);
  // E3..E7 — three late days each (1, 2, 3 Sep); E3 a fourth on the 4th.
  for (const k of ['e3', 'e4', 'e5', 'e6', 'e7']) await punchApi(E[k], [[at(1, '09:30')], [at(1, '18:00')], [at(2, '09:30')], [at(2, '18:00')], [at(3, '09:30')], [at(3, '18:00')], ...(k === 'e3' ? [[at(4, '09:40')], [at(4, '18:00')]] : [])]);

  // Leave through §22: E1 a whole day on the 16th, half days on the 18th (first half) and 19th (second half).
  const W = (await REQ.loadWorlds(db, COMPANY, [E.e1])).get(E.e1);
  ok(W.attendance?.liveFrom === '2026-09-01', 'a leave world knows attendance is live (§28.4)');
  const leaveReq = async (from, halfDay = null) => {
    const r = await REQ.submitForPerson(db, hr, { employeeId: E.e1, leaveTypeId: LT.cl, from, to: from, halfDay, reason: 'Family.' }, { userId: owner.id, employeeId: null, hr: { all: true } });
    await REQ.decide(db, hr, { userId: owner.id, employeeId: null, hr: { all: true } }, r.request.id, 'APPROVE', {});
    return r.request.id;
  };
  const LR16 = await leaveReq('2026-09-16');
  await leaveReq('2026-09-18', 'FIRST');
  await leaveReq('2026-09-19', 'SECOND');
  ok((await recOf(E.e1, '2026-09-16'))?.status === 'LEAVE', 'approving leave marks the day LEAVE at once (the leave decision processes it)');

  const run1 = await PROC.processRange(db, hr, { from: '2026-09-01', to: '2026-09-30', employeeIds: Object.values(E), kind: 'MANUAL' });
  ok(run1.daysWritten === 300 && !run1.skipped.notLive, 'a month for ten people: 300 days written', J(run1));
  const s = async (d) => recOf(E.e1, `2026-09-${String(d).padStart(2, '0')}`);
  const st = async (id, date) => (await recOf(id, date))?.status;
  ok((await s(1)).status === 'PRESENT' && (await s(1)).worked_minutes === 487 && (await s(1)).source === 'BIOMETRIC', 'E1 1 Sep: present, from the punches');
  ok((await s(2)).late_mark === 1 && (await s(3)).late_mark === 1 && (await s(4)).late_mark === 1, 'E1 2–4 Sep: three late marks');
  ok((await s(5)).status === 'HALF_DAY' && (await s(7)).status === 'ABSENT' && (await s(7)).missing_punch === 1 && (await s(8)).status === 'ABSENT' && (await s(9)).status === 'ABSENT',
    'E1: a short day is a half day; one punch not corrected in time, no punch, under 2 h — absent');
  ok((await s(13)).status === 'ABSENT' && /sandwich/.test((await s(13)).status_reason) && (await s(6)).status === 'WEEKLY_OFF' && (await s(27)).status === 'WEEKLY_OFF', 'E1 13 Sep: a Sunday between absent days is absent (sandwich); other Sundays are weekly offs');
  ok((await s(16)).status === 'LEAVE' && Number((await s(16)).leave_value) === 1 && (await s(17)).status === 'HOLIDAY' && (await s(18)).status === 'PRESENT' && Number((await s(18)).leave_value) === 0.5
    && (await s(19)).status === 'HALF_DAY' && Number((await s(19)).absent_value) === 0.5, 'E1: leave, holiday (the shift’s calendar), half-day leave + work = present, half-day leave alone = half absent');
  ok((await s(15)).overtime_minutes === 120 && (await s(20)).status === 'WEEKLY_OFF' && (await s(20)).overtime_minutes === 240, 'E1: 2 h overtime on the 15th, the Sunday worked is overtime');
  ok(await st(E.e2, '2026-09-01') === 'PRESENT' && (await recOf(E.e2, '2026-09-01')).worked_minutes === 435 && (await recOf(E.e2, '2026-09-02')).late_mark === 1
    && await st(E.e2, '2026-09-03') === 'ABSENT' && await st(E.e2, '2026-09-05') === 'PRESENT' && await st(E.e2, '2026-09-06') === 'WEEKLY_OFF' && !(await recOf(E.e2, '2026-09-06')).worked_minutes,
  'E2, night shift: each night is the day it started; the Sunday-morning punch belongs to Saturday’s night');
  // Re-runnable: the same again changes nothing.
  const snap = J(await q("SELECT employee_id, attendance_date, status, present_value, absent_value, late_mark, overtime_minutes FROM hrms_attendance_records WHERE employee_id IN (?) AND attendance_date BETWEEN '2026-09-01' AND '2026-09-30' ORDER BY employee_id, attendance_date", [Object.values(E)]));
  const penBefore = (await q('SELECT COUNT(*) AS n FROM hrms_attendance_penalties WHERE employee_id IN (?)', [Object.values(E)]))[0].n;
  const run2 = await PROC.processRange(db, hr, { from: '2026-09-01', to: '2026-09-30', employeeIds: Object.values(E) });
  const snap2 = J(await q("SELECT employee_id, attendance_date, status, present_value, absent_value, late_mark, overtime_minutes FROM hrms_attendance_records WHERE employee_id IN (?) AND attendance_date BETWEEN '2026-09-01' AND '2026-09-30' ORDER BY employee_id, attendance_date", [Object.values(E)]));
  ok(snap === snap2 && run2.penalties.applied === 0 && (await q('SELECT COUNT(*) AS n FROM hrms_attendance_penalties WHERE employee_id IN (?)', [Object.values(E)]))[0].n === penBefore,
    're-processing the month changes nothing and adds no penalty', J(run2.penalties));
  // Precedence: a day HR set by hand, and a day from a file, are kept.
  await db.query("UPDATE hrms_attendance_records SET status = 'PRESENT', source = 'MANUAL', present_value = 1, absent_value = 0, status_reason = 'by hand' WHERE employee_id = ? AND attendance_date = '2026-09-03'", [E.e2]);
  await db.query("UPDATE hrms_attendance_records SET status = 'HALF_DAY', source = 'IMPORT', present_value = 0.5, absent_value = 0.5 WHERE employee_id = ? AND attendance_date = '2026-09-01'", [E.e2]);
  const run3 = await PROC.processRange(db, hr, { from: '2026-09-01', to: '2026-09-03', employeeIds: [E.e2] });
  ok(await st(E.e2, '2026-09-03') === 'PRESENT' && (await recOf(E.e2, '2026-09-03')).source === 'MANUAL' && await st(E.e2, '2026-09-01') === 'HALF_DAY' && run3.kept === 2,
    'source precedence: processing keeps a MANUAL and an IMPORT day', J(run3));
  // Before "live from" and after today nothing is written.
  const run4 = await PROC.processRange(db, hr, { from: '2026-08-25', to: '2026-08-31', employeeIds: [E.e1] });
  ok(run4.daysWritten === 0 && !(await recOf(E.e1, '2026-08-31')), 'nothing before "attendance is live from"');

  /* ══ 3. penalties ══════════════════════════════════════════════════════ */
  section('[3] Penalties: every action');
  const pens = async (id) => q("SELECT * FROM hrms_attendance_penalties WHERE employee_id = ? AND period_month = '2026-09' ORDER BY id", [id]);
  const p1 = (await pens(E.e1))[0];
  const sysReq = p1?.leave_request_id ? await one('SELECT * FROM hrms_leave_requests WHERE id = ?', [p1.leave_request_id]) : null;
  ok(p1 && p1.action === 'LEAVE' && Number(p1.quantity) === 0.5 && p1.leave_type_id === LT.cl && p1.status === 'APPLIED' && String(p1.penalty_date).slice(0, 10) === '2026-09-04'
    && sysReq?.status === 'APPROVED' && sysReq.raised_by_system === 1 && Number(sysReq.quantity) === 0.5 && sysReq.half_day === 'FIRST',
  'E1: 3 late marks -> half a day of CL, as an APPROVED SYSTEM leave request through §22', J(p1));
  ok((await s(4)).status === 'PRESENT', 'the penalty’s leave does not turn the worked day into LEAVE');
  const clBal = (await REQ.loadWorlds(db, COMPANY, [E.e1])).get(E.e1);
  const cl = REQ.balancesOf(clBal, BAL.yearFromStart(2026, 4)).find((b) => b.leaveTypeId === LT.cl);
  ok(cl.taken === 2.5 && cl.available === 9.5, 'the balance counts it: 12 − (1 + 0.5 + 0.5 leave + 0.5 penalty) = 9.5', J(cl));
  const p4 = (await pens(E.e4))[0];
  ok(p4?.action === 'LOP' && Number(p4.quantity) === 0.5 && /no leave could be taken/.test(p4.reason) && !p4.leave_request_id, 'E4 has no leave policy: the LEAVE action falls back to half a day without pay, and says why', p4?.reason);
  const p5 = (await pens(E.e5))[0]; const p6 = (await pens(E.e6))[0]; const p7 = (await pens(E.e7))[0];
  ok(p5?.action === 'LOP' && Number(p5.quantity) === 1 && p6?.action === 'AMOUNT' && Number(p6.amount) === 200 && p7?.action === 'WARNING', 'LOP, AMOUNT and WARNING actions', J([p5?.action, p6?.amount, p7?.action]));
  ok((await pens(E.e3)).length === 1, 'E3: four late marks are still one penalty (the next needs six)');
  // Waive (HR): the leave comes back.
  const w3 = await PEN.waivePenalty(db, { ...hr, employeeId: null }, (await pens(E.e3))[0].id, { note: 'Bus breakdown, confirmed.' });
  const r3 = await one('SELECT status FROM hrms_leave_requests WHERE id = ?', [(await pens(E.e3))[0].leave_request_id]);
  ok(w3.penalty.status === 'WAIVED' && r3.status === 'CANCELLED', 'waiving a LEAVE penalty cancels its system request: the half day goes back to the balance');
  let refused = null;
  try { await PEN.waivePenalty(db, hr, p5.id, {}); } catch (e) { refused = e; }
  ok(refused?.code === 'NOTE_NEEDED', 'a waive needs a reason');
  await PROC.processRange(db, hr, { from: '2026-09-01', to: '2026-09-30', employeeIds: [E.e3] });
  ok((await pens(E.e3))[0].status === 'WAIVED', 'a waived penalty stays waived when the month is processed again');

  /* ══ 4. the month, by hand ═════════════════════════════════════════════ */
  section('[4] The month summary against hand-worked numbers');
  {
    const m = await attendanceMonth(COMPANY, '2026-09', { db, employeeIds: [E.e1] });
    const p = m.people[0];
    // Present: 1,2,3,4 + ½(5) + 10 + 15 + ½(18) + 21–26 + 28–30 = 16. Absent: ½(5) + 7,8,9 + 11,12,13,14 + ½(19) = 8.
    // Leave: 16 + ½(18) + ½(19) = 2 (paid CL). Weekly offs 6, 20, 27 = 3. Holiday 17. Half days 5, 19. OT 120 + 240.
    const want = { daysInEmployment: 30, present: 16, absent: 8, absentLop: 8, halfDays: 2, weeklyOffs: 3, holidays: 1, unknownDays: 0, lateMarks: 3, lopDays: 8, payableDays: 22, ncpDays: 8, esiDays: 22 };
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, p[k]]));
    ok(J(got) === J(want), 'E1, September: the numbers worked by hand', J(got));
    ok(p.leave.paid === 2 && p.leave.unpaid === 0 && p.leave.byType.length === 1 && p.leave.byType[0].days === 2 && p.overtime.minutes === 360 && p.overtime.hours === 6 && p.overtime.multiplier === 2
      && p.penalties.leaveDays === 0.5 && p.penalties.lopDays === 0 && m.live && !m.final && m.status === 'OPEN', 'leave by type, overtime 6 h at 2×, the penalty half day', J(p));
    const m5 = (await attendanceMonth(COMPANY, '2026-09', { db, employeeIds: [E.e5] })).people[0];
    ok(m5.penalties.lopDays === 1 && m5.lopDays === m5.absentLop + 1, 'a LOP penalty adds to the LOP days payroll deducts', J([m5.absentLop, m5.lopDays]));
    const m6 = (await attendanceMonth(COMPANY, '2026-09', { db, employeeIds: [E.e6] })).people[0];
    ok(m6.penalties.amount === 200, 'an AMOUNT penalty is an amount for payroll');
  }

  /* ══ logins and the in-process server ═══════════════════════════════════ */
  const acc = await setupAccess(db, COMPANY, { apply: true });
  if (acc.problems.length) console.log('  setupAccess problems:', acc.problems);
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const login = async (label, roleId, employeeId = null) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
    if (employeeId) await db.query('UPDATE hrms_employees SET user_id = ? WHERE id = ?', [id, employeeId]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  };
  const O = { id: owner.id, token: signToken({ id: owner.id, name: owner.name, email: owner.email, role: 'admin', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  const U = {
    E1: await login('E1', roleByKey.EMPLOYEE, E.e1), E2: await login('E2', roleByKey.EMPLOYEE, E.e2), E3: await login('E3', roleByKey.EMPLOYEE, E.e3),
    M: await login('M', roleByKey.EMPLOYEE, E.m), HR: await login('HR', roleByKey.HR_MANAGER), HRX: await login('HRX', roleByKey.HR_EXECUTIVE), DH: await login('DH', roleByKey.DEPARTMENT_HEAD, E.dh),
  };
  let THEM = null;
  if (other) {
    const theirAdmin = await one("SELECT u.id, u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1", [other.id]);
    if (theirAdmin) {
      await db.query('INSERT IGNORE INTO app_user_access (user_id, app_id, role_id, company_id) SELECT ?, ?, role_id, ? FROM users WHERE id = ?', [theirAdmin.id, other.app_id, other.id, theirAdmin.id]);
      THEM = { id: theirAdmin.id, token: signToken({ id: theirAdmin.id, name: theirAdmin.name, email: theirAdmin.email, role: 'admin', company: other.slug, companyId: other.id, company_id: other.id, uiPermissions: [] }), slug: other.slug };
    }
  }
  forgetAccess();
  server = express();
  server.use('/iclock', iclockRoutes);
  server.use(express.json({ limit: '20mb' }));
  server.use(cookieParser());
  server.use('/api/integrations', integrationRoutes);
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const root = `http://127.0.0.1:${listener.address().port}`;
  const call = async (who, method, url, body, { as = company.slug } = {}) => {
    const res = await fetch(`${root}/api/${as}/cf_hrms${url}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json };
  };

  /* ══ 5. requests through Approvals ═════════════════════════════════════ */
  section('[5] Requests: correct a day, short permission, on duty — through Approvals');
  {
    const ask = await call(U.E1, 'POST', '/user/me/attendance/requests', { kind: 'CORRECTION', date: '2026-09-03', inTime: '09:05', reason: 'The device did not read my finger at 09:05.' });
    ok(ask.status === 200 && ask.json.request.status === 'PENDING' && ask.json.request.approver?.employeeId === E.m && ask.json.request.inTime === '2026-09-03 09:05:00', 'E1 asks to correct 3 Sep: it goes to the manager', J(ask.json));
    const RID = ask.json.request.id;
    const dup = await call(U.E1, 'POST', '/user/me/attendance/requests', { kind: 'CORRECTION', date: '2026-09-03', status: 'PRESENT', reason: 'again' });
    const fut = await call(U.E1, 'POST', '/user/me/attendance/requests', { kind: 'CORRECTION', date: '2026-12-01', status: 'PRESENT', reason: 'x' });
    ok(dup.status === 422 && /already a correct a day request/.test(dup.json.problems.join(' ')) && fut.status === 422, 'a second request for the same day, or a day still to come, is refused in words', J([dup.json?.problems, fut.json?.problems]));
    const feed = await call(U.M, 'GET', '/user/me/approvals');
    const item = feed.json?.items?.find((i) => i.kind === 'ATTENDANCE' && i.id === RID);
    ok(feed.status === 200 && item && /^Correct a day · in 09:05/.test(item.title) && item.when === '3 Sep 2026', 'the manager’s Approvals list it, kind ATTENDANCE', J(item));
    const ctxR = await call(U.M, 'GET', `/user/me/approvals/attendance/${RID}`);
    const cx = ctxR.json?.context;
    ok(ctxR.status === 200 && cx.punches.length === 2 && cx.punches[0].at === '2026-09-03 09:12:00' && cx.day.status === 'PRESENT' && cx.lateMarksThisMonth.length === 3
      && cx.policySentences.length === 9 && cx.shift?.plan === '09:00–18:00' && ctxR.json.request.can.approve, 'the context: the day’s punches and row, the shift, the policy, this month’s late marks', J(cx).slice(0, 400));
    ok((await call(U.E1, 'POST', `/user/me/approvals/attendance/${RID}/approve`, {})).status === 403 && (await call(U.E2, 'POST', `/user/me/approvals/attendance/${RID}/approve`, {})).status === 403,
      'nobody approves their own request; a colleague cannot');
    ok((await call(U.M, 'POST', `/user/me/approvals/attendance/${RID}/reject`, {})).json?.code === 'NOTE_NEEDED', 'a rejection needs a note');
    const ap = await call(U.M, 'POST', `/user/me/approvals/attendance/${RID}/approve`, { note: 'OK' });
    const d3 = await s(3);
    ok(ap.status === 200 && ap.json.request.status === 'APPROVED' && d3.source === 'REGULARIZATION' && d3.late_mark === 0 && d3.late_minutes === 5 && d3.regularization_id === RID,
      'approving writes the day (source REGULARIZATION): in at 09:05, within the grace', J(d3));
    const p = (await pens(E.e1))[0];
    const sr = await one('SELECT status FROM hrms_leave_requests WHERE id = ?', [p.leave_request_id]);
    ok(p.status === 'REVERSED' && /2 late marks/.test(p.status_note) && sr.status === 'CANCELLED', 'and the late-mark penalty it caused is REVERSED, its half day of CL given back', J(p));
    await PROC.processRange(db, hr, { from: '2026-09-01', to: '2026-09-30', employeeIds: [E.e1] });
    ok((await s(3)).source === 'REGULARIZATION' && (await pens(E.e1))[0].status === 'REVERSED', 'processing again keeps the corrected day and the reversal');

    // Short permission: excuses E3's late 4 Sep (40 min) — once a month.
    const sp = await call(U.E3, 'POST', '/user/me/attendance/requests', { kind: 'SHORT_PERMISSION', date: '2026-09-04', minutes: 60, reason: 'Bank work.' });
    const sp2 = await call(U.E3, 'POST', '/user/me/attendance/requests', { kind: 'SHORT_PERMISSION', date: '2026-09-11', minutes: 30, reason: 'x' });
    const spBig = await call(U.E3, 'POST', '/user/me/attendance/requests', { kind: 'SHORT_PERMISSION', date: '2026-09-12', minutes: 180, reason: 'x' });
    ok(sp.status === 200 && sp2.status === 422 && /once a month/.test(sp2.json.problems.join(' ')) && spBig.status === 422 && /at most 2 h/.test(spBig.json.problems.join(' ')),
      'short permission: within the policy’s minutes, once a month', J([sp2.json?.problems, spBig.json?.problems]));
    ok((await recOf(E.e3, '2026-09-04')).late_mark === 1, 'before the decision, 4 Sep is a late mark');
    const hrOk = await call(U.HR, 'POST', `/attendance/requests/${sp.json.request.id}/approve`, {});
    ok(hrOk.status === 200 && (await recOf(E.e3, '2026-09-04')).late_mark === 0 && /excused by a short permission/.test((await recOf(E.e3, '2026-09-04')).status_reason), 'HR approves it: the late arrival is excused');
    // On duty.
    const od = await call(U.E3, 'POST', '/user/me/attendance/requests', { kind: 'ON_DUTY', date: '2026-09-08', reason: 'Customer site visit.' });
    ok((await recOf(E.e3, '2026-09-08'))?.status === 'ABSENT' || !(await recOf(E.e3, '2026-09-08')), 'before: absent');
    await call(U.M, 'POST', `/user/me/approvals/attendance/${od.json.request.id}/approve`, {});
    ok((await recOf(E.e3, '2026-09-08')).status === 'PRESENT' && /On duty/.test((await recOf(E.e3, '2026-09-08')).status_reason), 'an approved on-duty day is present');
    const mine = await call(U.E3, 'GET', '/user/me/attendance?month=2026-09');
    ok(mine.status === 200 && mine.json.days.length === 30 && mine.json.requests.length === 2 && mine.json.penalties.length === 1 && mine.json.policy.sentences.length === 9
      && mine.json.days.find((d) => d.date === '2026-09-01').punches.length === 2 && mine.json.approver?.employeeId === E.m && mine.json.summary.present > 0,
    'My attendance: the month, punches by day, requests, penalties, the policy, who approves', J(Object.keys(mine.json ?? {})));
  }

  /* ══ 6. the leave link ═════════════════════════════════════════════════ */
  section('[6] Leave and attendance together');
  {
    const myLeave = await call(U.E1, 'GET', '/user/me/leave?year=2026-27');
    const el = myLeave.json?.balances?.find((b) => b.leaveTypeId === LT.el);
    // In arrears: March (credited 1 April) to September (credited 1 October) = 7 months; September withheld (16 present days).
    ok(el && el.earned === 6 && /not credited for September 2026 \(16 present days\)/.test(el.why), 'EL: September is not credited — 16 present days, 20 needed', J(el));
    const ml = await call(U.E3, 'POST', '/user/me/leave/preview', { leaveTypeId: LT.ml, from: '2026-11-02', to: '2026-11-02' });
    const note = ml.json?.checks?.find((c) => c.code === 'ATTENDANCE')?.text ?? '';
    ok(/^Attendance shows \d+(\.\d+)? days worked from 1 Sep 2026 to 1 Nov 2026 \(attendance is recorded from 1 Sep 2026; earlier months must be checked by HR\); the policy asks for 80\.$/.test(note), 'ML: the 80 days worked read from attendance', note);
    const pv = await call(U.E1, 'POST', '/user/me/leave/preview', { leaveTypeId: LT.lwp, from: '2026-09-08', to: '2026-09-09' });
    ok(pv.json?.attendance?.length === 2 && pv.json.attendance[0].status === 'ABSENT', 'a leave preview shows the attendance already recorded on those days', J(pv.json?.attendance));
    const cancel = await call(U.HR, 'POST', `/leave/requests/${LR16}/cancel`, { note: 'Came to work after all? No: recorded by mistake.' });
    ok(cancel.status === 200 && (await s(16)).status === 'ABSENT', 'cancelling approved leave processes its day again (no punch: absent)', J(cancel.json?.request?.status));
    const sysCancel = await call(U.HR, 'POST', `/leave/requests/${(await pens(E.e5))[0].leave_request_id ?? (await one('SELECT id FROM hrms_leave_requests WHERE employee_id = ? AND raised_by_system = 1', [E.e1])).id}/cancel`, { note: 'x' });
    ok(sysCancel.status === 409 || sysCancel.status === 404, 'a system leave request is not cancelled on the leave screen (waive the penalty)', J(sysCancel.json));
  }

  /* ══ 7. the ways in ═════════════════════════════════════════════════════ */
  section('[7] Devices (ADMS), the API key, imports, the web punch');
  {
    const SERIAL = `${TAG}SN1`;
    const dev = await call(U.HR, 'POST', '/attendance/devices', { name: 'Gate 1', serialNumber: SERIAL, make: 'ZKTeco', model: 'K40' });
    ok(dev.status === 200 && dev.json.device.state === 'Never connected', 'HR registers a device by its serial', J(dev.json));
    const DEV = dev.json.device.id;
    ok((await call(U.HR, 'POST', '/attendance/devices', { name: 'Gate again', serialNumber: SERIAL.toLowerCase() })).json?.code === 'SERIAL_TAKEN', 'a serial is registered once (any case)');
    await call(U.HR, 'PUT', '/attendance/device-users', { deviceId: null, deviceUserId: '7001', employeeId: E.e9 });
    const unknown = await simulate({ url: root, sn: `${TAG}NOPE`, users: ['7001'], date: '2026-09-21', quiet: true });
    ok(unknown.handshake.status === 403 && !unknown.attlog, 'an unknown serial is refused at the handshake');
    const sim = await simulate({ url: root, sn: SERIAL, users: ['7001'], unmapped: ['7999'], date: '2026-09-21', quiet: true });
    ok(sim.handshake.status === 200 && sim.handshake.text.startsWith(`GET OPTION FROM: ${SERIAL}`) && sim.attlog.text === 'OK: 3' && sim.operlog.text === 'OK: 1' && sim.poll.text === 'OK' && sim.cmd.text === 'OK',
      'the simulator speaks ADMS: handshake, ATTLOG "OK: 3", OPERLOG, getrequest, devicecmd', J(sim));
    const p9 = await q('SELECT * FROM hrms_attendance_punches WHERE device_id = ? ORDER BY punched_at', [DEV]);
    ok(p9.length === 3 && p9.filter((x) => x.employee_id === E.e9).length === 2 && p9.find((x) => x.device_user_id === '7999').employee_id === null && p9[0].source === 'ADMS' && p9[0].method === 'FINGER',
      'mapped punches belong to E9 at once; 7999 waits unmapped', J(p9.map((x) => [x.device_user_id, x.employee_id])));
    ok((await recOf(E.e9, '2026-09-21'))?.status === 'PRESENT', 'the batch’s days are processed as it arrives');
    const again = await simulate({ url: root, sn: SERIAL, users: ['7001'], unmapped: ['7999'], date: '2026-09-21', quiet: true });
    ok(again.attlog.text === 'OK: 3' && (await q('SELECT COUNT(*) AS n FROM hrms_attendance_punches WHERE device_id = ?', [DEV]))[0].n === 3, 'the same lines again add nothing');
    const queue = await call(U.HR, 'GET', '/attendance/unmapped');
    ok(queue.json?.items?.some((i) => i.deviceUserId === '7999' && i.punches === 1 && i.serialNumber === SERIAL), 'the unmapped queue shows 7999 on Gate 1');
    const map = await call(U.HR, 'PUT', '/attendance/device-users', { deviceId: DEV, deviceUserId: '7999', employeeId: E.e7 });
    ok(map.status === 200 && map.json.attached === 1 && (await one('SELECT employee_id FROM hrms_attendance_punches WHERE device_id = ? AND device_user_id = ?', [DEV, '7999'])).employee_id === E.e7,
      'adding the mapping attaches the waiting punch (and processes its day)', J(map.json));
    const devs = await call(U.HR, 'GET', '/attendance/devices');
    ok(devs.json?.devices?.find((d) => d.id === DEV)?.state === 'Online', 'the device shows online once it has talked');
    const auto = await call(U.HR, 'POST', '/attendance/device-users/auto', {});
    ok(auto.status === 200 && auto.json.made >= 1, 'mapping everyone by "employee code without letters" in one go', J(auto.json?.made));

    // The API key.
    ok((await call(U.HR, 'POST', '/attendance/api-keys', { name: 'COSEC' })).json?.code === 'OWNER_ONLY', 'only the Owner makes an API key');
    const key = await call(O, 'POST', '/attendance/api-keys', { name: `${TAG} COSEC` });
    ok(key.status === 200 && /^hrk_[0-9a-f]{8}_/.test(key.json.secret) && /not shown again/.test(key.json.note), 'the Owner makes a key; it is shown once');
    const stored = await one('SELECT key_hash, key_prefix FROM hrms_attendance_api_keys WHERE id = ?', [key.json.key.id]);
    ok(stored.key_hash.length === 64 && !JSON.stringify(stored).includes(key.json.secret.slice(14)), 'only a SHA-256 of it is kept');
    const list = await call(U.HR, 'GET', '/attendance/api-keys');
    ok(list.json?.keys?.some((k) => k.id === key.json.key.id && k.prefix.endsWith('_…')) && !J(list.json).includes(key.json.secret), 'the list never shows a key again');
    const api = (k, body) => fetch(`${root}/api/integrations/attendance/punches`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
    const batch = { punches: [{ employeeCode: await code(E.e9), time: '2026-09-22 09:01:00', direction: 'IN' }, { employeeCode: await code(E.e9), time: '2026-09-22 18:02:00', direction: 'OUT' }, { employeeCode: 'NOBODY', time: '2026-09-22 09:00:00' }, { employeeCode: await code(E.e9), time: 'soon' }] };
    const a1 = await api(key.json.secret, batch);
    const a2 = await api(key.json.secret, batch);
    ok(a1.status === 200 && a1.json.inserted === 3 && a1.json.unmapped === 1 && a1.json.rejected.length === 1 && a1.json.rejected[0].index === 3 && a2.json.inserted === 0 && a2.json.duplicates === 3,
      'POST /api/integrations/attendance/punches: by employee code; a code nobody has waits unmapped; a bad time is rejected by index; the same batch again is all duplicates', J([a1.json, a2.json]));
    ok((await recOf(E.e9, '2026-09-22'))?.status === 'PRESENT', 'and the day is processed');
    ok((await api('hrk_00000000_wrongwrongwrongwrongwrong', batch)).status === 401, 'a wrong key: 401');
    if (THEM) {
      const theirDevice = await call(THEM, 'POST', '/attendance/devices', { name: 'Theirs', serialNumber: SERIAL }, { as: THEM.slug });
      ok(theirDevice.json?.code === 'SERIAL_TAKEN' && !/Karni|karni/.test(theirDevice.json.message), 'another company cannot register the same serial, and is not told whose it is', J(theirDevice.json));
      const cross = await api(key.json.secret, { punches: [{ deviceSerial: 'SOMEONE-ELSES', deviceUserId: '1', time: '2026-09-22 09:00:00' }] });
      ok(cross.json.rejected.length === 1 && /No device/.test(cross.json.rejected[0].why), 'a key reaches only its own company’s devices');
    }
    await call(O, 'POST', `/attendance/api-keys/${key.json.key.id}/revoke`, {});
    ok((await api(key.json.secret, batch)).status === 401, 'a revoked key: 401');

    // Imports: a punch CSV and a days workbook.
    const csv = `Employee code,Date,Time,Direction\n${await code(E.e9)},2026-09-23,09:00,IN\n${await code(E.e9)},2026-09-23,18:00,OUT\nNOBODY,2026-09-23,09:00,IN\n`;
    const body = { fileName: 'punches.csv', contentBase64: Buffer.from(csv).toString('base64') };
    const pre = await call(U.HR, 'POST', '/attendance/imports/punches/preview', body);
    ok(pre.status === 200 && pre.json.summary.rows === 3 && pre.json.summary.problems === 1 && /No employee has the code NOBODY/.test(pre.json.rows[2].problems[0]), 'punch file preview: every problem by row', J(pre.json?.summary));
    ok((await call(U.HR, 'POST', '/attendance/imports/punches/apply', body)).json?.code === 'HAS_PROBLEMS', 'apply refuses a file with problems unless told to skip them');
    const appl = await call(U.HR, 'POST', '/attendance/imports/punches/apply', { ...body, skipProblemRows: true });
    ok(appl.status === 200 && appl.json.inserted === 2 && (await recOf(E.e9, '2026-09-23'))?.status === 'PRESENT', 'punch file applied: 2 punches, the day processed', J(appl.json));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Days');
    ws.addRow(['Employee code', 'Date', 'Status', 'In', 'Out', 'Note']);
    ws.addRow([await code(E.e9), '2026-09-24', 'P', '09:00', '18:00', 'Register']);
    ws.addRow([await code(E.e2), '2026-09-03', 'A', '', '', 'Register says absent']);
    const days = { fileName: 'days.xlsx', contentBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') };
    const dPre = await call(U.HR, 'POST', '/attendance/imports/days/preview', days);
    const dApp = await call(U.HR, 'POST', '/attendance/imports/days/apply', days);
    ok(dPre.json?.summary?.ok === 2 && dApp.status === 200 && dApp.json.written === 1 && dApp.json.kept.length === 1 && /set by HR by hand — kept/.test(dApp.json.kept[0])
      && (await recOf(E.e9, '2026-09-24')).source === 'IMPORT' && (await recOf(E.e2, '2026-09-03')).source === 'MANUAL', 'days file: written with source IMPORT; a day HR set by hand is kept and said', J(dApp.json));
    ok((await call(U.HR, 'GET', '/attendance/imports/template?kind=days')).json?.fileName === 'attendance-days-template.xlsx', 'the templates download');

    // The web punch.
    ok((await call(U.E1, 'POST', '/user/me/attendance/punch', { direction: 'IN' })).json?.code === 'WEB_PUNCH_OFF', 'the web punch is off until the company turns it on');
    const set = await call(U.HR, 'PUT', '/attendance/settings', { webPunch: { enabled: true, ipAllowList: ['10.9.8.0/24'], geofences: [{ locationId: null, lat: 17.385, lng: 78.4867, radiusM: 200 }] } });
    ok(set.status === 200 && set.json.settings.webPunch.enabled, 'HR turns it on, with an address range and a geofence');
    ok((await call(U.E1, 'POST', '/user/me/attendance/punch', { direction: 'IN' })).json?.code === 'IP_NOT_ALLOWED', 'outside the address range: refused');
    await call(U.HR, 'PUT', '/attendance/settings', { webPunch: { ipAllowList: ['127.0.0.1', '::1'] } });
    ok((await call(U.E1, 'POST', '/user/me/attendance/punch', { direction: 'IN' })).json?.code === 'LOCATION_NEEDED', 'with a geofence, the location is needed');
    const far = await call(U.E1, 'POST', '/user/me/attendance/punch', { direction: 'IN', lat: 17.40, lng: 78.50 });
    ok(far.json?.code === 'OUTSIDE_GEOFENCE' && /m from the workplace/.test(far.json.message), 'too far: refused, saying how far', far.json?.message);
    const near = await call(U.E1, 'POST', '/user/me/attendance/punch', { direction: 'IN', lat: 17.3851, lng: 78.4868 });
    ok(near.status === 200 && near.json.punch.direction === 'IN' && (await one("SELECT method, source FROM hrms_attendance_punches WHERE employee_id = ? AND source = 'WEB'", [E.e1]))?.method === 'WEB', 'inside: the punch is stored as a WEB punch', J(near.json));
    ok((await call(U.HR, 'PUT', '/attendance/settings', { webPunch: { ipAllowList: ['not an ip'] } })).status === 422, 'a bad address rule is refused');
  }

  /* ══ 8. close, rights, scope, isolation ═════════════════════════════════ */
  section('[8] Close and re-open; rights; team scope; another company');
  {
    const close = await call(U.HR, 'POST', '/attendance/months/2026-09/close', {});
    ok(close.status === 200 && close.json.month.status === 'CLOSED' && close.json.month.totals?.people > 0, 'HR closes September: processed once more, the summary kept', J(close.json?.month));
    const sum = await attendanceMonth(COMPANY, '2026-09', { db, employeeIds: [E.e1] });
    ok(sum.final && sum.status === 'CLOSED' && sum.people[0].employeeId === E.e1, 'payroll reads the closed month (final: true)');
    ok((await call(U.HR, 'POST', '/attendance/months/2026-09/close', {})).json?.code === 'ALREADY_CLOSED', 'closing twice is refused');
    const runClosed = await PROC.processRange(db, hr, { from: '2026-09-01', to: '2026-09-30', employeeIds: [E.e1] });
    ok(runClosed.daysWritten === 0 && runClosed.skipped.closedMonths.includes('2026-09'), 'a closed month is never processed again');
    ok((await call(U.E1, 'POST', '/user/me/attendance/requests', { kind: 'CORRECTION', date: '2026-09-29', status: 'PRESENT', reason: 'x' })).json?.problems?.some((p) => /closed for payroll/.test(p)), 'nor corrected');
    ok((await call(U.HR, 'PUT', '/attendance/days', { employeeId: E.e1, date: '2026-09-29', status: 'ABSENT', note: 'x' })).json?.code === 'MONTH_CLOSED', 'nor set by hand');
    ok((await call(U.HR, 'POST', '/attendance/months/2026-09/reopen', { reason: 'x' })).json?.code === 'OWNER_ONLY', 'HR cannot re-open; only the Owner');
    ok((await call(O, 'POST', '/attendance/months/2026-09/reopen', {})).json?.code === 'REASON_NEEDED', 'the Owner needs a reason');
    const re = await call(O, 'POST', '/attendance/months/2026-09/reopen', { reason: 'A late correction from the plant.' });
    ok(re.status === 200 && re.json.month.status === 'OPEN' && re.json.month.reopenReason === 'A late correction from the plant.', 'the Owner re-opens it with a reason');
    const audits = await q("SELECT action FROM hrms_audit_log WHERE entity_type = 'hrms_attendance_months' AND company_id = ? ORDER BY id DESC LIMIT 2", [COMPANY]);
    ok(audits.length === 2 && audits[1].action === 'APPROVE' && audits[0].action === 'UPDATE', 'both are audited');
    ok((await call(U.HR, 'POST', '/attendance/months/2026-11/close', {})).json?.code === 'NOT_OVER', 'a month not yet over cannot be closed');

    // Rights.
    ok((await call(U.E1, 'GET', '/attendance/today')).status === 403 && (await call(U.E1, 'GET', '/attendance/month')).status === 403, 'an employee login has no HR attendance screens');
    const hrx = await call(U.HRX, 'GET', '/attendance/month?month=2026-09');
    ok(hrx.status === 200 && (await call(U.HRX, 'DELETE', `/attendance/policies/${AP.warning.id}`)).status === 403, 'an HR executive sees and changes attendance, but cannot remove');
    const today = await call(U.HR, 'GET', '/attendance/today?date=2026-09-21');
    ok(today.status === 200 && today.json.counts.people > 0 && today.json.departments.some((d) => d.department === `${TAG} D2`), 'the Today board, by department', J(today.json?.counts));
    const muster = await call(U.HR, 'GET', '/attendance/month?month=2026-09');
    const row1 = muster.json?.rows?.find((r) => r.person.employeeId === E.e1);
    ok(row1 && row1.cells.length === 30 && row1.cells[0].letter === 'P' && row1.cells[12].letter === 'A' && row1.cells[16].letter === 'H' && row1.totals.present >= 15, 'the muster: a letter a day and the month’s totals', J(row1?.cells?.slice(0, 7)));
    const xl = await call(U.HR, 'GET', '/attendance/month/workbook?month=2026-09');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(xl.json.contentBase64, 'base64'));
    ok(book.getWorksheet('Muster roll').getRow(3).getCell(4).value === '1 Tue' && xl.json.fileName === 'muster-roll-2026-09.xlsx', 'the muster roll as Excel');
    // Department scope: the department head sees D2 only.
    const dhm = await call(U.DH, 'GET', '/attendance/month?month=2026-09');
    ok(dhm.status === 200 && dhm.json.rows.length >= 1 && dhm.json.rows.every((r) => [E.dh, E.e9].includes(r.person.employeeId)), 'a department head sees their own department only', J(dhm.json?.rows?.map((r) => r.person.name)));
    ok((await call(U.DH, 'GET', `/attendance/people/${E.e1}`)).json?.code === 'OUT_OF_SCOPE', 'and not a person outside it');
    // Team scope: a manager's team calendar.
    const team = await call(U.M, 'GET', '/user/me/team/attendance?month=2026-09');
    const ids = (team.json?.rows ?? []).map((r) => r.person.employeeId);
    ok(team.status === 200 && ids.includes(E.e1) && ids.includes(E.e3) && !ids.includes(E.m) && !ids.includes(E.e9), 'the manager’s team calendar: the people below them, not themselves', J(ids));
    ok((await call(U.M, 'GET', `/user/me/team/attendance/${E.e1}?month=2026-09`)).status === 200 && (await call(U.E1, 'GET', `/user/me/team/attendance/${E.m}`)).json?.code === 'NOT_YOUR_TEAM', 'one of them opens; a manager is not "my team"');
    const waive = await call(U.M, 'POST', `/user/me/team/attendance/penalties/${(await pens(E.e6))[0].id}/waive`, { note: 'First time; spoken to.' });
    ok(waive.status === 200 && waive.json.penalty.status === 'WAIVED', 'the manager waives a team member’s penalty, with a reason');
    ok((await call(U.E1, 'POST', `/user/me/team/attendance/penalties/${(await pens(E.e7))[0].id}/waive`, { note: 'x' })).json?.code === 'NOT_YOUR_TEAM', 'a colleague cannot');
    // Another company sees nothing of this one.
    if (THEM) {
      const theirs = await call(THEM, 'GET', '/attendance/devices', undefined, { as: THEM.slug });
      ok(theirs.status === 200 && !J(theirs.json).includes(TAG), 'another company’s Owner sees none of these devices');
      ok([403, 404].includes((await call(THEM, 'GET', `/attendance/people/${E.e1}`, undefined, { as: THEM.slug })).status) || !J((await call(THEM, 'GET', `/attendance/people/${E.e1}`, undefined, { as: THEM.slug })).json).includes(TAG),
        'nor a person of this one');
      ok((await call(THEM, 'GET', '/attendance/penalties?month=2026-09', undefined, { as: THEM.slug })).json?.items?.every((p) => !String(p.person?.name ?? '').includes(TAG)), 'nor its penalties');
    }
  }
} catch (err) {
  ok(false, 'the run finished', `${err.message} ${(err.stack ?? '').split('\n').slice(1, 4).join(' ')}`);
} finally {
  if (server?.close) await server.close();
  try { await db.rollback(); } catch { /* nothing */ }
  db.release();
  pool.query = real.query;
  pool.execute = real.execute;
  pool.getConnection = real.getConnection;
  forgetAccess();
}

section('[9] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${TABLES.length} tables)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
