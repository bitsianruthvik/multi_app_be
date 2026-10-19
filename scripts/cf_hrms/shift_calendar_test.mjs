/**
 * shift_calendar_test.mjs — shifts by weekday, and holiday calendars (2026-10-11).
 * Contract: TM/CF_HRMS_HIRING_SPEC.md §6.
 *
 *   1. the week arithmetic on its own: hours, the night shift that ends next
 *      day, weekly hours, and the summary line for every shape of week;
 *   2. the tenant's shifts as they stand: seven days each, always;
 *   3. shifts: create / edit with days, every validation problem, the first
 *      screen's body still working, what the shift row mirrors, the summary on
 *      every position and person read, the calendar a shift selects, delete;
 *   4. holiday calendars: create, holidays, duplicate dates, by year, copy a
 *      year (29 February, dates already there), delete and its refusals;
 *   5. seven days whatever happens to the rows; the backfill is idempotent;
 *   6. another company cannot reach any of it;
 *   7. permissions, through the real middleware.
 *
 *   node scripts/cf_hrms/shift_calendar_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND. Every write is in a transaction on one connection
 * that is ROLLED BACK, on shifts, calendars and positions this file creates
 * (each carries a per-run tag). The end re-reads the tenant's shifts, their day
 * rows and every hrms_ row count.
 *
 * Local only — it refuses a non-local DB_HOST.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import * as ORG from '../../apps/cf_hrms/services/organisationService.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as HIRE from '../../apps/cf_hrms/services/hiringService.js';
import * as SHIFT from '../../apps/cf_hrms/services/shiftRead.js';
import { buildOrgChart, getPositionCard } from '../../apps/cf_hrms/services/orgChartService.js';
import { departmentStaffing } from '../../apps/cf_hrms/services/jobContentService.js';
import { myPlace } from '../../apps/cf_hrms/services/selfService.js';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const skipped = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const skip = (name, reason) => { skipped.push(`${name}: ${reason}`); };
const section = (title) => console.log(`\n${title}`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const refused = (e, status, code) => Boolean(e) && e.status === status && e.code === code;
const why = (e) => (e ? `${e.status ?? '?'} ${e.code ?? ''} ${e.message ?? ''} ${JSON.stringify(e.problems ?? '')}` : 'nothing was thrown');

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company "${slug}".`); process.exit(2); }
const COMPANY = company.id;
const IS_KARNI = slug === 'karni';
const TAG = `ZZSH${Date.now().toString(36).toUpperCase().slice(-5)}`;
const on = POS.today();
const [[adminUser]] = await pool.query(
  `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);
const c = { companyId: COMPANY, userId: adminUser?.id ?? null };
const [[other]] = await pool.query('SELECT id, name FROM companies WHERE id <> ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
const OTHER = other.id;

const hrmsTables = (await pool.query(
  /* company tables only (global ones, e.g. hrms_tax_rules, have no company_id) */ "SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'hrms\\_%' AND COLUMN_NAME IN ('company_id', 'deleted_at') GROUP BY TABLE_NAME HAVING COUNT(*) = 2 ORDER BY TABLE_NAME"))[0].map((r) => r.t);
const snapshot = async () => {
  const out = {};
  for (const t of hrmsTables) {
    const [[r]] = await pool.query(`SELECT COUNT(*) AS total, SUM(deleted_at IS NULL) AS live FROM ${t} WHERE company_id IN (?, ?)`, [COMPANY, OTHER]);
    out[t] = `${r.total}/${r.live ?? 0}`;
  }
  const [shifts] = await pool.query(
    `SELECT s.id, s.code, s.name, s.start_time, s.end_time, s.crosses_midnight, s.status, s.holiday_calendar_id, s.week_summary,
            (SELECT GROUP_CONCAT(CONCAT(d.weekday, ':', d.is_working, ':', IFNULL(d.start_time, '-'), ':', IFNULL(d.end_time, '-'), ':', d.break_minutes) ORDER BY d.weekday)
               FROM hrms_shift_days d WHERE d.shift_id = s.id AND d.deleted_at IS NULL) AS days
       FROM hrms_shifts s WHERE s.company_id = ? AND s.deleted_at IS NULL ORDER BY s.id`, [COMPANY]);
  out.shifts = JSON.stringify(shifts);
  return out;
};
const baseline = await snapshot();
console.log(`shift_calendar_test — ${company.name} (${COMPANY}), run tag ${TAG}, as of ${on}; the other company is ${other.name} (${OTHER})`);

async function rolledBack(fn) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await fn(db);
  } finally {
    try { await db.rollback(); } catch { /* nothing to undo */ }
    db.release();
  }
}

/** A week in the body's shape. `spec` is weekday -> [start, end, break?]; a weekday not named is a day off; `true` is a working day without hours. */
const week = (spec) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
  const d = spec[weekday];
  if (!d) return { weekday, isWorking: false };
  if (d === true) return { weekday, isWorking: true, startTime: null, endTime: null, breakMinutes: 0 };
  return { weekday, isWorking: true, startTime: d[0], endTime: d[1], breakMinutes: d[2] ?? 0 };
});
const everyDay = (from, to, value) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [from + i, value]));

/* ══ 1. the arithmetic ════════════════════════════════════════════════════ */
section('[1] A week on its own: hours, the night shift, weekly hours, the summary line');
{
  const shape = (spec) => week(spec).map(SHIFT.shapeDay);
  const monSat = shape(everyDay(1, 6, ['08:00', '20:00']));
  ok(SHIFT.summaryOf(monSat) === 'Mon–Sat 08:00–20:00' && SHIFT.weeklyHoursOf(monSat) === 72 && monSat.filter((d) => d.isWorking).length === 6 && monSat[6].hours === null,
    'Monday to Saturday, the same hours: "Mon–Sat 08:00–20:00", 72 hours a week', SHIFT.summaryOf(monSat));
  const shortSat = shape({ ...everyDay(1, 5, ['09:00', '18:00', 60]), 6: ['09:00', '13:00'] });
  ok(SHIFT.summaryOf(shortSat) === 'Mon–Fri 09:00–18:00, Sat 09:00–13:00' && SHIFT.weeklyHoursOf(shortSat) === 44 && shortSat[0].hours === 8 && shortSat[5].hours === 4,
    'Monday to Friday with an hour’s break, a short Saturday: "Mon–Fri 09:00–18:00, Sat 09:00–13:00", 44 hours', `${SHIFT.summaryOf(shortSat)} ${SHIFT.weeklyHoursOf(shortSat)}`);
  const flexible = shape(everyDay(1, 6, true));
  ok(SHIFT.summaryOf(flexible) === 'Mon–Sat, flexible hours' && SHIFT.weeklyHoursOf(flexible) === null && flexible.every((d) => d.hours === null),
    'working days without hours: "Mon–Sat, flexible hours", weekly hours null', SHIFT.summaryOf(flexible));
  const oneDay = shape({ 7: ['10:00', '14:00'] });
  ok(SHIFT.summaryOf(oneDay) === 'Sun 10:00–14:00' && SHIFT.weeklyHoursOf(oneDay) === 4 && oneDay.filter((d) => d.isWorking).length === 1, 'a single working day: "Sun 10:00–14:00"', SHIFT.summaryOf(oneDay));
  const night = shape(everyDay(1, 6, ['20:00', '08:00', 30]));
  ok(night[0].crossesMidnight === true && night[0].hours === 11.5 && SHIFT.summaryOf(night) === 'Mon–Sat 20:00–08:00' && SHIFT.weeklyHoursOf(night) === 69 && monSat[0].crossesMidnight === false,
    'a night shift (the end is before the start) ends next day: 20:00–08:00 less 30 minutes is 11.5 hours', `${night[0].hours}`);
  ok(SHIFT.shapeDay({ weekday: 1, isWorking: true, startTime: '22:00', endTime: '22:00' }).hours === 24 && SHIFT.spanMinutes('23:30', '00:15') === 45, 'an end equal to the start is a whole day; 23:30–00:15 is 45 minutes');
  const split = shape({ 1: ['09:00', '18:00'], 2: ['09:00', '18:00'], 4: ['09:00', '18:00'], 5: true, 6: ['10:00', '14:00'] });
  ok(SHIFT.summaryOf(split) === 'Mon–Tue 09:00–18:00, Thu 09:00–18:00, Fri flexible hours, Sat 10:00–14:00', 'days that are not next to each other are separate runs; a day without hours among timed ones says so', SHIFT.summaryOf(split));
  ok(SHIFT.summaryOf(shape({})) === 'No working days' && SHIFT.weeklyHoursOf(shape({})) === null, 'no working day at all: "No working days"');
  const padded = SHIFT.weekOf([{ weekday: 3, is_working: 0 }], { start_time: '08:00:00', end_time: '20:00:00' });
  ok(padded.length === 7 && padded.map((d) => d.weekday).join('') === '1234567' && padded[2].isWorking === false && padded[0].startTime === '08:00' && padded[6].isWorking === false,
    'weekOf always answers seven days: a weekday with no row comes from the shift’s own times (Mon–Sat working, Sunday off)');
  ok(SHIFT.summaryFromRow({ week_summary: null, start_time: '20:00:00', end_time: '08:00:00' }) === 'Mon–Sat 20:00–08:00' && SHIFT.summaryFromRow({ shift_week_summary: 'X' }, 'shift_') === 'X'
    && SHIFT.summaryFromRow({ week_summary: null, start_time: null, end_time: null }) === 'Mon–Sat, flexible hours', 'a shift row with no stored line prints the line of its default week');
  ok(SHIFT.weekdayName('2026-01-26') === 'Monday' && SHIFT.weekdayName('2028-02-29') === 'Tuesday' && SHIFT.weekdayName('2026-08-15') === 'Saturday', 'a date’s weekday: 26 Jan 2026 is a Monday, 29 Feb 2028 a Tuesday');
}

/* ══ 2. the tenant's shifts ═══════════════════════════════════════════════ */
section('[2] The shifts as they stand: seven days each');
{
  const listed = await ORG.listShifts(pool, COMPANY);
  ok(Array.isArray(listed.shifts) && listed.rows === listed.shifts && listed.shifts.length > 0, 'GET /organisation/shifts answers { shifts } (and `rows`, the first screen’s name for it)');
  ok(listed.shifts.every((s) => s.days.length === 7 && s.days.map((d) => d.weekday).join('') === '1234567'), 'every shift has seven days, Monday first');
  ok(listed.shifts.every((s) => ['id', 'code', 'name', 'status', 'days', 'weeklyHours', 'workingDays', 'summary', 'holidayCalendar', 'positionCount', 'graceInMinutes', 'graceOutMinutes',
    'startTime', 'endTime', 'isFlexible', 'crossesMidnight'].every((k) => k in s)), 'each carries the spec’s fields and the first screen’s (startTime, endTime, isFlexible, crossesMidnight)');
  ok(listed.shifts.every((s) => s.days.every((d) => JSON.stringify(Object.keys(d)) === JSON.stringify(['weekday', 'isWorking', 'startTime', 'endTime', 'breakMinutes', 'crossesMidnight', 'hours']))),
    'a day is { weekday, isWorking, startTime, endTime, breakMinutes, crossesMidnight, hours }');
  const [[stored]] = await pool.query('SELECT COUNT(*) AS n FROM hrms_shifts s WHERE s.deleted_at IS NULL AND (SELECT COUNT(*) FROM hrms_shift_days d WHERE d.shift_id = s.id AND d.deleted_at IS NULL) <> 7');
  ok(Number(stored.n) === 0, 'in the database too: no shift of ANY company has other than seven day rows');
  const [rowsNow] = await pool.query('SELECT id, week_summary FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  ok(listed.shifts.every((s) => rowsNow.find((r) => r.id === s.id).week_summary === s.summary), 'the summary stored on each shift row is the summary of its days');
  if (IS_KARNI) {
    const by = Object.fromEntries(listed.shifts.map((s) => [s.code, s]));
    ok(Boolean(by.G && by.D && by.N) && by.G.summary === 'Mon–Sat, flexible hours' && by.G.weeklyHours === null && by.G.workingDays === 6
      && by.D.summary === 'Mon–Sat 08:00–20:00' && by.D.weeklyHours === 72 && by.N.summary === 'Mon–Sat 20:00–08:00' && by.N.weeklyHours === 72 && by.N.days[0].crossesMidnight === true
      && by.N.days[6].isWorking === false, 'Karni: General flexible Mon–Sat; Day 08:00–20:00; Night 20:00–08:00 ending next day; Sunday off on all three',
    listed.shifts.map((s) => `${s.code} ${s.summary}`).join(' | '));
    ok(by.G.positionCount === 58 && by.D.positionCount === 90 && by.N.positionCount === 72 && [by.G, by.D, by.N].every((s) => s.holidayCalendar === null),
      'Karni: 58 / 90 / 72 positions on them, and no calendar selected', [by.G, by.D, by.N].map((s) => s.positionCount).join('/'));
  } else skip('Karni’s three shifts', `this is ${slug}`);
  const one = await ORG.getShiftDetail(pool, COMPANY, listed.shifts[0].id);
  ok(one.shift.id === listed.shifts[0].id && one.shift.summary === listed.shifts[0].summary && one.id === one.shift.id, 'GET /organisation/shifts/:id answers { shift }');
  ok(refused(await caught(() => ORG.getShiftDetail(pool, COMPANY, 999999999)), 404, 'NOT_FOUND'), 'a shift that does not exist: 404');
}

/* ══ 3. shifts ════════════════════════════════════════════════════════════ */
section('[3] Shifts: days, validation, the first screen’s body, the summary on every read, the calendar, delete');
await rolledBack(async (db) => {
  const body = { code: `${TAG}A`, name: `${TAG} Office`, days: week({ ...everyDay(1, 5, ['09:00', '18:00', 60]), 6: ['09:00', '13:00'] }) };
  const made = await ORG.createShift(db, c, body);
  const s = made.shift;
  ok(s.id > 0 && made.id === s.id && s.code === `${TAG}A` && s.summary === 'Mon–Fri 09:00–18:00, Sat 09:00–13:00' && s.weeklyHours === 44 && s.workingDays === 6
    && s.days[0].hours === 8 && s.days[0].breakMinutes === 60 && s.days[6].isWorking === false && s.holidayCalendar === null && s.positionCount === 0 && s.status === 'ACTIVE',
  'POST /organisation/shifts with seven days -> { shift } with its week, weekly hours and summary', JSON.stringify({ summary: s.summary, weekly: s.weeklyHours }));
  const [[row]] = await db.query('SELECT start_time, end_time, crosses_midnight, week_summary FROM hrms_shifts WHERE id = ?', [s.id]);
  ok(String(row.start_time).slice(0, 5) === '09:00' && String(row.end_time).slice(0, 5) === '18:00' && row.crosses_midnight === 0 && row.week_summary === s.summary
    && s.startTime === '09:00' && s.endTime === '18:00' && s.isFlexible === false, 'the shift row mirrors the first working day, and stores the summary line');
  const [[dayCount]] = await db.query('SELECT COUNT(*) AS n FROM hrms_shift_days WHERE shift_id = ?', [s.id]);
  ok(Number(dayCount.n) === 7, 'seven day rows were written');

  // ── every validation problem ──
  const bad = async (label, days, problems, extra = {}) => {
    const e = await caught(() => ORG.createShift(db, c, { code: `${TAG}X`, name: `${TAG} bad`, days, ...extra }));
    ok(refused(e, 422, 'INVALID') && e.problems.length === problems && e.problems.every((p) => typeof p === 'string' && !/undefined|NaN/.test(p)), `${label}: 422 INVALID, ${problems} problem${problems === 1 ? '' : 's'}`, why(e));
    return e;
  };
  await bad('six days', week(everyDay(1, 6, ['09:00', '18:00'])).slice(0, 6), 1);
  const dup = await bad('a weekday twice', [...week(everyDay(1, 6, ['09:00', '18:00'])).slice(0, 6), { weekday: 1, isWorking: false }], 1);
  ok(/Monday is there twice/.test(dup.problems[0]), 'the duplicate is named: "Monday is there twice."', dup.problems[0]);
  const half = await bad('a working day with a start and no end', week({ 1: ['09:00', null], 2: ['09:00', '18:00'] }), 1);
  ok(/^Monday: give both a start and an end time/.test(half.problems[0]), 'said by its day: "Monday: give both a start and an end time…"', half.problems[0]);
  const longBreak = await bad('a break as long as the day', week({ 3: ['09:00', '13:00', 240] }), 1);
  ok(/^Wednesday: the break \(240 minutes\)/.test(longBreak.problems[0]), 'said by its day and its minutes', longBreak.problems[0]);
  await bad('a time that is not a time, a negative break, a break on a day without hours', week({ 1: ['9am', '18:00'], 2: ['09:00', '18:00', -5], 3: [null, null, 30] }), 4);
  await bad('a weekday that does not exist', [...week({}).slice(0, 6), { weekday: 9, isWorking: false }], 1);
  await bad('days that is not a list', 'monday', 1);
  await bad('no code and no name', week({}), 2, { code: '', name: '' });
  ok(await ORG.listShifts(db, COMPANY).then((l) => l.shifts.every((x) => x.code !== `${TAG}X`)), 'and none of those created a shift');
  ok(refused(await caught(() => ORG.createShift(db, c, { ...body })), 409, 'DUPLICATE'), 'a second shift with the same code: 409 DUPLICATE');

  // ── the first screen's body: two times, no days ──
  const legacy = (await ORG.createShift(db, c, { code: `${TAG}L`, name: `${TAG} Legacy`, startTime: '06:00', endTime: '14:00' })).shift;
  ok(legacy.summary === 'Mon–Sat 06:00–14:00' && legacy.weeklyHours === 48 && legacy.days[6].isWorking === false && legacy.startTime === '06:00', 'a body with startTime / endTime and no days: those hours Monday to Saturday, Sunday off', legacy.summary);
  const flex = (await ORG.createShift(db, c, { code: `${TAG}F`, name: `${TAG} Flexible` })).shift;
  ok(flex.summary === 'Mon–Sat, flexible hours' && flex.weeklyHours === null && flex.isFlexible === true && flex.workingDays === 6, 'no times at all: Monday to Saturday working, flexible hours');
  ok(refused(await caught(() => ORG.createShift(db, c, { code: `${TAG}H`, name: 'half', startTime: '06:00' })), 422, 'INVALID'), 'one time without the other, the old way: still 422');
  const legacyEdit = (await ORG.updateShift(db, c, legacy.id, { startTime: '22:00', endTime: '06:00' })).shift;
  ok(legacyEdit.summary === 'Mon–Sat 22:00–06:00' && legacyEdit.crossesMidnight === true && legacyEdit.days[0].crossesMidnight === true && legacyEdit.days[6].isWorking === false,
    'the first screen’s edit of the two times puts them on every working day; a night shift is marked "ends next day" by itself', legacyEdit.summary);

  // ── edit ──
  const renamed = (await ORG.updateShift(db, c, s.id, { name: `${TAG} Office hours`, graceInMinutes: 10 })).shift;
  ok(renamed.name === `${TAG} Office hours` && renamed.graceInMinutes === 10 && renamed.summary === s.summary && JSON.stringify(renamed.days) === JSON.stringify(s.days), 'PUT with a name only leaves the week alone');
  const night = (await ORG.updateShift(db, c, s.id, { days: week(everyDay(1, 7, ['20:00', '08:00', 45])) })).shift;
  ok(night.summary === 'Mon–Sun 20:00–08:00' && night.workingDays === 7 && night.weeklyHours === 78.75 && night.days.every((d) => d.crossesMidnight && d.hours === 11.25) && night.crossesMidnight === true,
    'PUT with seven days replaces the week: a seven-day night shift, 11.25 hours a day', `${night.summary} ${night.weeklyHours}`);
  ok(Number((await db.query('SELECT COUNT(*) AS n FROM hrms_shift_days WHERE shift_id = ?', [s.id]))[0][0].n) === 7, 'still seven rows — a day is updated in place');
  ok(refused(await caught(() => ORG.updateShift(db, c, s.id, { days: week({ 1: ['09:00', '09:30', 30] }) })), 422, 'INVALID')
    && (await ORG.getShiftDetail(db, COMPANY, s.id)).shift.summary === 'Mon–Sun 20:00–08:00', 'a bad week on an edit is refused and changes nothing');
  const office = (await ORG.updateShift(db, c, s.id, { days: body.days })).shift;

  // ── the summary on every position and person read ──
  const [[role]] = await db.query("SELECT id FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY id LIMIT 1", [COMPANY]);
  const position = (await POS.createPosition(db, c, { roleId: role.id, positionCode: `${TAG}-1`, status: 'ACTIVE', defaultShiftId: s.id })).position;
  const line = 'Mon–Fri 09:00–18:00, Sat 09:00–13:00';
  const want = { id: s.id, code: `${TAG}A`, name: `${TAG} Office hours`, summary: line };
  const same = (x) => JSON.stringify(x) === JSON.stringify(want);
  ok(same(position.shift) && same((await POS.getPosition(db, COMPANY, position.id)).position.shift), 'GET /positions/:id: shift = { id, code, name, summary }', JSON.stringify(position.shift));
  ok(same((await POS.listPositions(db, COMPANY, { shiftId: s.id })).items[0].shift), 'the Positions list row carries it');
  const chart = await buildOrgChart(db, COMPANY, {});
  ok(same(chart.nodes.find((n) => n.id === position.id).defaultShift) && chart.nodes.every((n) => !n.defaultShift || typeof n.defaultShift.summary === 'string'),
    'the chart node’s defaultShift carries it — and every other node’s shift has a summary too');
  const card = await getPositionCard(db, COMPANY, position.id, {});
  ok(same(card.shift) && same(card.position.defaultShift), 'the position card’s shift carries it');
  const sibling = (await POS.addSiblingPosition(db, c, position.id, {})).position;
  ok((await getPositionCard(db, COMPANY, sibling.id, {})).siblings.find((x) => x.positionId === position.id)?.shift?.summary === line, 'and so does a sibling row of the card');
  const staff = (await departmentStaffing(db, COMPANY, {})).departments.flatMap((d) => d.roles).flatMap((r) => r.positions).find((x) => x.positionId === position.id);
  ok(same(staff.shift), 'the Departments staffing row carries it');
  const hiring = (await HIRE.startHiring(db, c, position.id)).hiring;
  ok(same(hiring.shift) && same((await HIRE.listHirings(db, COMPANY, { positionId: position.id })).hirings[0].shift), 'a hiring’s shift carries it, in the detail and in the list');
  await HIRE.closeHiring(db, c, hiring.id, { reason: 'STARTED_BY_MISTAKE' });
  const [[person]] = await db.query(
    `SELECT e.user_id, wa.id AS assignment_id FROM hrms_employees e JOIN hrms_work_assignments wa ON wa.employee_id = e.id AND wa.deleted_at IS NULL AND wa.status = 'ACTIVE'
      WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.user_id IS NOT NULL ORDER BY e.id LIMIT 1`, [COMPANY]);
  if (person) {
    await db.query('UPDATE hrms_work_assignments SET default_shift_id = ? WHERE id = ?', [s.id, person.assignment_id]);
    const mine = await myPlace(db, { companyId: COMPANY, userId: person.user_id }, {});
    ok(mine.seats[0].shift.summary === line && mine.seats[0].shift.code === `${TAG}A` && mine.seats[0].shift.startTime === '09:00', '/user/me/place: the person’s shift carries it, beside the times it always had', JSON.stringify(mine.seats[0].shift));
  } else skip('/user/me/place', 'no employee with a login and an assignment');
  // The line follows an edit of the week with no further write.
  await ORG.updateShift(db, c, s.id, { days: week(everyDay(1, 5, ['10:00', '19:00'])) });
  ok((await POS.getPosition(db, COMPANY, position.id)).position.shift.summary === 'Mon–Fri 10:00–19:00', 'change the week and every read shows the new line');
  ok(office.summary === line, '(the office week was put back before these reads)');

  // ── the calendar a shift selects ──
  const cal = (await ORG.createHolidayCalendar(db, c, { name: `${TAG} Plant holidays` })).calendar;
  const withCal = (await ORG.updateShift(db, c, s.id, { holidayCalendarId: cal.id })).shift;
  ok(JSON.stringify(withCal.holidayCalendar) === JSON.stringify({ id: cal.id, name: `${TAG} Plant holidays` }) && (await ORG.listShifts(db, COMPANY)).shifts.find((x) => x.id === s.id).holidayCalendar.id === cal.id,
    'a shift selects a holiday calendar: holidayCalendar = { id, name } on every shift read');
  const shared = (await ORG.updateShift(db, c, legacy.id, { holidayCalendarId: cal.id })).shift;
  ok(shared.holidayCalendar.id === cal.id && (await ORG.listHolidayCalendars(db, COMPANY)).calendars.find((x) => x.id === cal.id).shiftCount === 2, 'two shifts may share one calendar; the calendar says how many use it');
  ok(refused(await caught(() => ORG.updateShift(db, c, s.id, { holidayCalendarId: 999999999 })), 422, 'INVALID') && (await ORG.getShiftDetail(db, COMPANY, s.id)).shift.holidayCalendar.id === cal.id,
    'a calendar that does not exist: 422, and the selection stands');
  const inUse = await caught(() => ORG.deleteHolidayCalendar(db, c, cal.id));
  ok(refused(inUse, 409, 'IN_USE') && inUse.detail?.shiftCount === 2 && inUse.problems.length === 2, 'deleting a calendar a shift selects: 409 IN_USE, naming the shifts', why(inUse));
  ok((await ORG.updateShift(db, c, s.id, { holidayCalendarId: null })).shift.holidayCalendar === null, '"No holidays": holidayCalendarId null clears it');
  const made2 = (await ORG.createShift(db, c, { code: `${TAG}C`, name: `${TAG} With calendar`, holidayCalendarId: cal.id, days: week(everyDay(1, 5, true)) })).shift;
  ok(made2.holidayCalendar?.id === cal.id && made2.summary === 'Mon–Fri, flexible hours', 'a shift can be created with its calendar');

  // ── delete ──
  const used = await caught(() => ORG.deleteShift(db, c, s.id));
  ok(refused(used, 409, 'IN_USE') && used.detail?.positionCount === 2 && /2 positions are on this shift/.test(used.message), 'deleting a shift positions are on: 409 IN_USE with the count', why(used));
  ok((await ORG.getShiftDetail(db, COMPANY, s.id)).shift.positionCount === 2, 'positionCount on the shift says the same');
  const gone = await ORG.deleteShift(db, c, flex.id);
  ok(gone.ok === true && refused(await caught(() => ORG.getShiftDetail(db, COMPANY, flex.id)), 404, 'NOT_FOUND') && (await ORG.listShifts(db, COMPANY)).shifts.every((x) => x.id !== flex.id),
    'a shift nothing uses is deleted');
});

/* ══ 4. holiday calendars ═════════════════════════════════════════════════ */
section('[4] Holiday calendars: holidays, duplicate dates, by year, copy a year, delete');
await rolledBack(async (db) => {
  const before = (await ORG.listHolidayCalendars(db, COMPANY)).calendars;
  const made = await ORG.createHolidayCalendar(db, c, { name: `${TAG} Office`, description: 'Head office.' });
  const cal = made.calendar;
  ok(JSON.stringify(Object.keys(made)) === JSON.stringify(['calendar']) && JSON.stringify(Object.keys(cal)) === JSON.stringify(['id', 'name', 'description', 'status', 'holidayCount', 'nextHoliday', 'shiftCount'])
    && cal.holidayCount === 0 && cal.nextHoliday === null && cal.shiftCount === 0 && cal.status === 'ACTIVE' && cal.description === 'Head office.',
  'a new calendar starts EMPTY: { id, name, description, status, holidayCount: 0, nextHoliday: null, shiftCount: 0 }', JSON.stringify(cal));
  ok(refused(await caught(() => ORG.createHolidayCalendar(db, c, { name: `${TAG} office` })), 409, 'DUPLICATE') && refused(await caught(() => ORG.createHolidayCalendar(db, c, { name: ' ' })), 422, 'INVALID'),
    'a second calendar with the same name (any case): 409; no name: 422');

  // Dates in the future of any run, in a leap year: 2028.
  const add = (date, name, extra = {}) => ORG.createCalendarHoliday(db, c, cal.id, { date, name, ...extra });
  const republic = await add('2028-01-26', 'Republic Day');
  ok(JSON.stringify(Object.keys(republic.holiday).slice(0, 5)) === JSON.stringify(['id', 'date', 'weekday', 'name', 'isOptional']) && republic.holiday.date === '2028-01-26'
    && republic.holiday.weekday === 'Wednesday' && republic.holiday.isOptional === false && republic.holiday.calendarId === cal.id && republic.holiday.holidayDate === '2028-01-26',
  'POST …/holiday-calendars/:id/holidays -> { holiday: { id, date, weekday, name, isOptional } }', JSON.stringify(republic.holiday));
  await add('2028-08-15', 'Independence Day');
  await add('2028-10-02', 'Gandhi Jayanti');
  await add('2028-02-29', 'Leap day off', { isOptional: true });
  const again = await caught(() => add('2028-08-15', 'Again'));
  ok(refused(again, 409, 'DUPLICATE') && /Independence Day/.test(again.message) && again.existing?.name === 'Independence Day', 'the same date twice in one calendar: 409 DUPLICATE, naming the holiday already there', why(again));
  const dbDup = await caught(() => db.query('INSERT INTO hrms_holidays (company_id, calendar_id, holiday_date, name) VALUES (?, ?, ?, ?)', [COMPANY, cal.id, '2028-08-15', 'x']));
  ok(dbDup?.errno === 1062, 'and the database refuses it too (uq_hhol_calday)', dbDup?.code ?? 'accepted');
  ok(refused(await caught(() => add('15 August', 'x')), 422, 'INVALID') && refused(await caught(() => add('2028-12-25', '')), 422, 'INVALID')
    && refused(await caught(() => ORG.createCalendarHoliday(db, c, 999999999, { date: '2028-12-25', name: 'x' })), 404, 'NOT_FOUND'), 'a date that is not a date, no name: 422; a calendar that does not exist: 404');
  const second = (await ORG.createHolidayCalendar(db, c, { name: `${TAG} Plant` })).calendar;
  const sameDay = await ORG.createCalendarHoliday(db, c, second.id, { date: '2028-08-15', name: 'Independence Day' });
  ok(sameDay.holiday.calendarId === second.id, 'the same date in ANOTHER calendar is fine');

  const listed = (await ORG.listHolidayCalendars(db, COMPANY)).calendars;
  const mine = listed.find((x) => x.id === cal.id);
  ok(listed.length === before.length + 2 && mine.holidayCount === 4 && JSON.stringify(mine.nextHoliday) === JSON.stringify({ date: '2028-01-26', name: 'Republic Day' }) && mine.shiftCount === 0
    && listed.find((x) => x.id === second.id).holidayCount === 1, 'GET /organisation/holiday-calendars: each with its count, its NEXT holiday and how many shifts use it', JSON.stringify(mine));

  const y2028 = await ORG.getHolidayCalendar(db, COMPANY, cal.id, { year: '2028' });
  ok(JSON.stringify(Object.keys(y2028)) === JSON.stringify(['calendar', 'holidays', 'years']) && y2028.holidays.map((h) => h.date).join(' ') === '2028-01-26 2028-02-29 2028-08-15 2028-10-02'
    && JSON.stringify(y2028.years) === '[2028]' && y2028.calendar.holidayCount === 4 && y2028.holidays[1].isOptional === true && y2028.holidays[1].weekday === 'Tuesday',
  'GET …/holiday-calendars/:id?year=2028 -> { calendar, holidays (by date), years }');
  ok((await ORG.getHolidayCalendar(db, COMPANY, cal.id, { year: 2027 })).holidays.length === 0 && (await ORG.getHolidayCalendar(db, COMPANY, cal.id, {})).holidays.length === 4
    && refused(await caught(() => ORG.getHolidayCalendar(db, COMPANY, cal.id, { year: 'soon' })), 422, 'INVALID'), 'a year with none is empty; no year is every year; a year that is not one: 422');

  // ── edit / remove a holiday ──
  const edited = await ORG.updateHoliday(db, c, republic.holiday.id, { name: 'Republic Day (observed)', isOptional: true });
  ok(edited.holiday.name === 'Republic Day (observed)' && edited.holiday.isOptional === true && edited.holiday.date === '2028-01-26' && edited.name === edited.holiday.name, 'PUT /organisation/holidays/:id changes what was sent');
  ok(refused(await caught(() => ORG.updateHoliday(db, c, republic.holiday.id, { date: '2028-10-02' })), 409, 'DUPLICATE')
    && (await ORG.updateHoliday(db, c, republic.holiday.id, { date: '2028-01-27' })).holiday.weekday === 'Thursday', 'moving it onto another holiday’s date: 409; onto a free date: done, with its new weekday');
  await ORG.updateHoliday(db, c, republic.holiday.id, { date: '2028-01-26', name: 'Republic Day', isOptional: false });
  const extra = await add('2028-12-25', 'Christmas');
  ok((await ORG.deleteHoliday(db, c, extra.holiday.id)).ok === true && (await ORG.getHolidayCalendar(db, COMPANY, cal.id, {})).holidays.length === 4 && (await add('2028-12-25', 'Christmas')).holiday.id !== extra.holiday.id,
    'DELETE /organisation/holidays/:id removes it, and the date is free again');

  // ── copy a year ──
  await add('2029-08-15', 'Independence Day (already entered)');
  const copy = await ORG.copyHolidayYear(db, c, cal.id, { fromYear: 2028, toYear: 2029 });
  ok(JSON.stringify(Object.keys(copy)) === JSON.stringify(['copied', 'skipped', 'note']) && copy.copied === 3 && copy.skipped.length === 2,
    'copy-year 2028 -> 2029: three copied, two skipped', JSON.stringify(copy));
  const leap = copy.skipped.find((x) => x.name === 'Leap day off');
  const taken = copy.skipped.find((x) => x.name === 'Independence Day');
  ok(leap?.date === '2029-02-29' && /2029 has no 29 February/.test(leap.why) && taken?.date === '2029-08-15' && /already in this calendar/.test(taken.why)
    && copy.skipped.every((x) => JSON.stringify(Object.keys(x)) === JSON.stringify(['date', 'name', 'why'])),
  '29 February is skipped (2029 has none) and so is a date already there — each { date, name, why }', JSON.stringify(copy.skipped));
  ok(/[Ff]estival/.test(copy.note) && /check/.test(copy.note), 'the answer says festival dates move each year and must be checked', copy.note);
  const y2029 = await ORG.getHolidayCalendar(db, COMPANY, cal.id, { year: 2029 });
  ok(y2029.holidays.map((h) => `${h.date} ${h.name}`).join(' | ') === '2029-01-26 Republic Day | 2029-08-15 Independence Day (already entered) | 2029-10-02 Gandhi Jayanti | 2029-12-25 Christmas'
    && JSON.stringify(y2029.years) === '[2028,2029]' && y2029.holidays[0].weekday === 'Friday', '2029 holds the same days and months; the one already there was not overwritten', y2029.holidays.map((h) => h.date).join(' '));
  const twice = await ORG.copyHolidayYear(db, c, cal.id, { fromYear: 2028, toYear: 2029 });
  ok(twice.copied === 0 && twice.skipped.length === 5, 'copying again copies nothing: every date is already there');
  const toLeap = await ORG.copyHolidayYear(db, c, cal.id, { fromYear: 2028, toYear: 2032 });
  ok(toLeap.copied === 5 && toLeap.skipped.length === 0, 'into another leap year 29 February goes too');
  ok(refused(await caught(() => ORG.copyHolidayYear(db, c, cal.id, { fromYear: 2028, toYear: 2028 })), 422, 'INVALID')
    && refused(await caught(() => ORG.copyHolidayYear(db, c, cal.id, { fromYear: 'last', toYear: 2029 })), 422, 'INVALID')
    && refused(await caught(() => ORG.copyHolidayYear(db, c, 999999999, { fromYear: 2028, toYear: 2029 })), 404, 'NOT_FOUND'), 'the same year, a year that is not one: 422; a calendar that does not exist: 404');
  ok((await ORG.copyHolidayYear(db, c, cal.id, { fromYear: 2040, toYear: 2041 })).copied === 0, 'a year with no holidays copies nothing, without an error');

  // ── rename, delete ──
  const renamed = await ORG.updateHolidayCalendar(db, c, cal.id, { name: `${TAG} Head office`, status: 'INACTIVE' });
  ok(renamed.calendar.name === `${TAG} Head office` && renamed.calendar.status === 'INACTIVE' && renamed.calendar.holidayCount > 4 && renamed.calendar.description === 'Head office.', 'PUT …/holiday-calendars/:id renames it and keeps the rest');
  ok(refused(await caught(() => ORG.updateHolidayCalendar(db, c, cal.id, { name: `${TAG} Plant` })), 409, 'DUPLICATE'), 'renaming it to another calendar’s name: 409');
  const shift = (await ORG.createShift(db, c, { code: `${TAG}S`, name: `${TAG} Shift`, holidayCalendarId: second.id })).shift;
  ok(refused(await caught(() => ORG.deleteHolidayCalendar(db, c, second.id)), 409, 'IN_USE'), 'a calendar a shift selects cannot be deleted (409 IN_USE)');
  await ORG.updateShift(db, c, shift.id, { holidayCalendarId: null });
  const del = await ORG.deleteHolidayCalendar(db, c, second.id);
  ok(del.ok === true && del.deletedHolidays === 1 && refused(await caught(() => ORG.getHolidayCalendar(db, COMPANY, second.id, {})), 404, 'NOT_FOUND')
    && Number((await db.query('SELECT COUNT(*) AS n FROM hrms_holidays WHERE calendar_id = ? AND deleted_at IS NULL', [second.id]))[0][0].n) === 0, 'once no shift selects it, it is deleted with its holidays');
  ok((await ORG.createHolidayCalendar(db, c, { name: `${TAG} Plant` })).calendar.id !== second.id, 'and its name is free again');

  // ── the first screen's holiday routes still work ──
  const legacy = await ORG.createHoliday(db, c, { holidayDate: '2031-05-01', name: 'May Day' });
  const company = (await ORG.listHolidayCalendars(db, COMPANY)).calendars.find((x) => x.name === 'Company holidays');
  ok(legacy.holidayDate === '2031-05-01' && legacy.id === legacy.holiday.id && Boolean(company) && legacy.holiday.calendarId === company.id,
    'POST /organisation/holidays (no calendar named) still works: the holiday goes into "Company holidays"');
  const all = await ORG.listHolidays(db, COMPANY, { year: 2031 });
  ok(all.rows === all.holidays && all.rows.length === 1 && all.rows[0].calendarId === company.id && refused(await caught(() => ORG.createHoliday(db, c, { holidayDate: '2031-05-01', name: 'Again' })), 409, 'DUPLICATE'),
    'GET /organisation/holidays?year= still lists them; the same date there twice is still 409');
});

/* ══ 5. seven days, whatever happens to the rows ══════════════════════════ */
section('[5] Never fewer than seven; the backfill is idempotent');
await rolledBack(async (db) => {
  const s = (await ORG.createShift(db, c, { code: `${TAG}7`, name: `${TAG} Seven`, startTime: '08:00', endTime: '16:00' })).shift;
  await db.query('DELETE FROM hrms_shift_days WHERE shift_id = ? AND weekday IN (2, 7)', [s.id]);
  const read = (await ORG.getShiftDetail(db, COMPANY, s.id)).shift;
  ok(read.days.length === 7 && read.days[1].isWorking && read.days[1].startTime === '08:00' && read.days[6].isWorking === false && read.summary === 'Mon–Sat 08:00–16:00',
    'two day rows gone missing: the shift is still read with seven days, the gaps from its own times');
  await db.query('DELETE FROM hrms_shift_days WHERE shift_id = ?', [s.id]);
  ok((await ORG.listShifts(db, COMPANY)).shifts.find((x) => x.id === s.id).days.length === 7, 'all seven gone: still seven');
  const rewritten = (await ORG.updateShift(db, c, s.id, { startTime: '09:00', endTime: '17:00' })).shift;
  ok(rewritten.summary === 'Mon–Sat 09:00–17:00' && Number((await db.query('SELECT COUNT(*) AS n FROM hrms_shift_days WHERE shift_id = ?', [s.id]))[0][0].n) === 7, 'and the next edit writes all seven back');
  // What seed.sql runs for a company's seeded shifts: fills only what is missing.
  await db.query('DELETE FROM hrms_shift_days WHERE shift_id = ? AND weekday = 4', [s.id]);
  const seed = `INSERT INTO hrms_shift_days (company_id, shift_id, weekday, is_working, start_time, end_time, crosses_midnight, break_minutes)
    SELECT s.company_id, s.id, d.weekday, IF(d.weekday <= 6, 1, 0), IF(d.weekday <= 6, s.start_time, NULL), IF(d.weekday <= 6, s.end_time, NULL),
           IF(d.weekday <= 6 AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL AND s.end_time <= s.start_time, 1, 0), 0
      FROM hrms_shifts s
      JOIN (SELECT 1 AS weekday UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7) d
     WHERE s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM hrms_shift_days x WHERE x.company_id = s.company_id AND x.shift_id = s.id AND x.weekday = d.weekday)`;
  const [first] = await db.query(seed);
  const [secondRun] = await db.query(seed);
  ok(first.affectedRows === 1 && secondRun.affectedRows === 0, 'the seed’s day backfill adds exactly the missing row, and nothing on a second run');
});
{
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/cf_hrms/scripts/apply-shift-calendar-schema.mjs');
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  ok((output.match(/already there/g) ?? []).length === 10 && /every shift has its seven days/.test(output) && /all in step/.test(output) && /holidays without a calendar\s+none/.test(output) && !/would/.test(output.replace('would do', '')),
    'apply-shift-calendar-schema.mjs, run again (dry): ten schema steps already there, every shift has its days, nothing to write', output.split('\n').filter((l) => /would/.test(l)).join(' | '));
}

/* ══ 6. another company ═══════════════════════════════════════════════════ */
section('[6] Another company cannot reach a shift, a calendar or a holiday');
await rolledBack(async (db) => {
  const there = { ...c, companyId: OTHER };
  const s = (await ORG.createShift(db, c, { code: `${TAG}T`, name: `${TAG} Mine` })).shift;
  const cal = (await ORG.createHolidayCalendar(db, c, { name: `${TAG} Mine` })).calendar;
  const h = (await ORG.createCalendarHoliday(db, c, cal.id, { date: '2028-01-26', name: 'Republic Day' })).holiday;
  for (const [name, fn] of [
    ['read a shift', () => ORG.getShiftDetail(db, OTHER, s.id)], ['edit a shift', () => ORG.updateShift(db, there, s.id, { name: 'x' })], ['delete a shift', () => ORG.deleteShift(db, there, s.id)],
    ['read a calendar', () => ORG.getHolidayCalendar(db, OTHER, cal.id, {})], ['rename a calendar', () => ORG.updateHolidayCalendar(db, there, cal.id, { name: 'x' })],
    ['delete a calendar', () => ORG.deleteHolidayCalendar(db, there, cal.id)], ['add a holiday', () => ORG.createCalendarHoliday(db, there, cal.id, { date: '2028-03-01', name: 'x' })],
    ['copy a year', () => ORG.copyHolidayYear(db, there, cal.id, { fromYear: 2028, toYear: 2029 })], ['edit a holiday', () => ORG.updateHoliday(db, there, h.id, { name: 'x' })],
    ['delete a holiday', () => ORG.deleteHoliday(db, there, h.id)],
  ]) ok(refused(await caught(fn), 404, 'NOT_FOUND'), `${name} from another company: 404`);
  const theirs = (await ORG.createShift(db, there, { code: `${TAG}O`, name: `${TAG} Theirs` })).shift;
  ok(refused(await caught(() => ORG.updateShift(db, there, theirs.id, { holidayCalendarId: cal.id })), 422, 'INVALID'), 'their shift cannot select this company’s calendar (422)');
  ok((await ORG.listShifts(db, OTHER)).shifts.every((x) => x.id !== s.id) && (await ORG.listHolidayCalendars(db, OTHER)).calendars.every((x) => x.id !== cal.id)
    && (await ORG.listHolidays(db, OTHER, {})).rows.every((x) => x.id !== h.id) && (await ORG.getShiftDetail(db, COMPANY, s.id)).shift.name === `${TAG} Mine`, 'none of it is in their lists, and nothing here changed');
});

/* ══ 7. permissions ═══════════════════════════════════════════════════════ */
section('[7] Permissions, over HTTP');
{
  const server = express();
  server.use(express.json({ limit: '50mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const tokenFor = async (where) => {
    const [[u]] = await pool.query(
      `SELECT u.id, u.email, u.company_id, co.slug, r.name AS role FROM users u
         JOIN companies co ON co.id = u.company_id LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.deleted_at IS NULL AND ${where} ORDER BY u.id LIMIT 1`);
    return u ? { ...u, token: signToken({ id: u.id, email: u.email, role: u.role, company: u.slug, companyId: u.company_id, company_id: u.company_id, uiPermissions: [] }) } : null;
  };
  const call = async (who, method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  try {
    const hasApp = "EXISTS (SELECT 1 FROM app_user_access x JOIN apps a ON a.id = x.app_id WHERE x.user_id = u.id AND x.deleted_at IS NULL AND a.slug = 'cf_hrms')";
    const admin = await tokenFor(`u.company_id = ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp}`);
    const employee = await tokenFor(`u.company_id = ${COMPANY} AND r.name = 'Employee' AND ${hasApp}`);
    const outsider = await tokenFor(`u.company_id <> ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp}`);
    const api = `/${slug}/cf_hrms`;
    const ROUTES = [
      ['GET', '/organisation/shifts'], ['GET', '/organisation/shifts/1'], ['POST', '/organisation/shifts', { code: 'X', name: 'x' }], ['PUT', '/organisation/shifts/1', { name: 'x' }],
      ['DELETE', '/organisation/shifts/1'], ['GET', '/organisation/holiday-calendars'], ['GET', '/organisation/holiday-calendars/1?year=2028'],
      ['POST', '/organisation/holiday-calendars', { name: 'x' }], ['PUT', '/organisation/holiday-calendars/1', { name: 'x' }], ['DELETE', '/organisation/holiday-calendars/1'],
      ['POST', '/organisation/holiday-calendars/1/holidays', { date: '2028-01-26', name: 'x' }], ['POST', '/organisation/holiday-calendars/1/copy-year', { fromYear: 2028, toYear: 2029 }],
      ['GET', '/organisation/holidays'], ['PUT', '/organisation/holidays/1', { name: 'x' }], ['DELETE', '/organisation/holidays/1'],
    ];
    for (const [who, label] of [[employee, 'an Employee login'], [outsider, 'an admin of another company']]) {
      if (!who) { skip(label, 'no such login with access to the app'); continue; }
      const wrong = [];
      for (const [method, url, body] of ROUTES) { const r = await call(who, method, `${api}${url}`, body); if (r.status !== 403) wrong.push(`${method} ${url} ${r.status}`); }
      ok(wrong.length === 0, `${label} gets 403 from all ${ROUTES.length} shift and calendar routes`, wrong.join('; '));
    }
    ok((await call(null, 'GET', `${api}/organisation/shifts`)).status === 401, 'no token at all: 401');
    if (admin) {
      const shifts = await call(admin, 'GET', `${api}/organisation/shifts`);
      const first = shifts.json.shifts?.[0];
      const one = first ? await call(admin, 'GET', `${api}/organisation/shifts/${first.id}`) : null;
      const calendars = await call(admin, 'GET', `${api}/organisation/holiday-calendars`);
      ok(shifts.status === 200 && Array.isArray(shifts.json.shifts) && first?.days.length === 7 && typeof first.summary === 'string' && one?.status === 200 && one.json.shift.id === first.id
        && calendars.status === 200 && Array.isArray(calendars.json.calendars), 'an admin: the shifts (seven days, a summary), one shift, and the calendars all answer in the spec’s shapes');
      const bad = await call(admin, 'POST', `${api}/organisation/shifts`, { code: `${TAG}Z`, name: 'bad', days: [] });
      ok(bad.status === 422 && bad.json.code === 'INVALID' && Array.isArray(bad.json.problems) && bad.json.problems.length === 1, 'a bad shift over HTTP: 422 { code: INVALID, message, problems[] } — and nothing written');
      ok((await call(admin, 'GET', `${api}/organisation/holiday-calendars/999999999`)).status === 404 && (await call(admin, 'DELETE', `${api}/organisation/shifts/999999999`)).status === 404, 'a calendar or a shift that does not exist: 404');
      const chart = await call(admin, 'GET', `${api}/orgchart`);
      ok(chart.status === 200 && chart.json.nodes.filter((x) => x.defaultShift).every((x) => typeof x.defaultShift.summary === 'string' && x.defaultShift.summary.length > 0), 'the org chart: every node’s shift has its summary line');
    } else skip('an admin login', 'this company has no admin login with access to the app');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

/* ══ end ══════════════════════════════════════════════════════════════════ */
section('[end] The tenant is as it was found');
{
  const after = await snapshot();
  const moved = Object.keys(baseline).filter((k) => after[k] !== baseline[k]);
  ok(moved.length === 0, `every hrms_ table of both companies, and every shift with its seven days, is as it was (${hrmsTables.length} tables)`,
    moved.map((k) => (k === 'shifts' ? 'the shifts changed' : `${k} ${baseline[k]} -> ${after[k]}`)).join('; '));
  if (IS_KARNI) {
    const chart = (await buildOrgChart(pool, COMPANY, {})).counts;
    ok(chart.positions === 220 && chart.filled === 71 && chart.vacant === 149, 'Karni: 220 positions, 71 filled, 149 vacant', `${chart.positions}/${chart.filled}/${chart.vacant}`);
    const shifts = JSON.parse(after.shifts).filter((s) => ['G', 'D', 'N'].includes(s.code));
    ok(shifts.length === 3 && shifts.every((s) => s.days.split(',').length === 7 && s.holiday_calendar_id === null), 'Karni: its three shifts, seven days each, no calendar selected');
  }
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
