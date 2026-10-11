/**
 * exit_test.mjs — leaving: notice, and closing an employee (2026-10-11).
 * Contract: TM/CF_HRMS_HIRING_SPEC.md §4.
 *
 *   1. the reasons list;
 *   2. start -> NOTICE with the defaults, every validation, the refusals
 *      (EXIT_OPEN), what every read gains (employee `exit`; `notice` on the
 *      occupant in the chart, the card, the Positions list and the staffing
 *      rows; counts.onNotice; canHireReplacement; the employee's own page);
 *      edit; withdraw -> ACTIVE;
 *   3. close -> EXITED: assignments ended on the day, the position vacant, the
 *      EXIT event, the login's access removed and NOBODY ELSE'S touched, how to
 *      undo it; ending a notice early; ALREADY_LEFT; an employee who has left
 *      cannot be given work, is not offered in the pickers, and is still readable;
 *   4. a replacement: a hiring on the position of somebody on notice, the
 *      joining-date rule, and a notice withdrawn in the meantime;
 *   5. another company cannot reach any of it;
 *   6. through the real middleware: an Employee login gets 403 from every route.
 *
 *   node scripts/cf_hrms/exit_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND. Every write is in a transaction on one connection
 * that is ROLLED BACK — including the ones that remove a real login's access;
 * section 6 only makes requests that must be refused. The end re-reads the
 * tenant: positions / filled / vacant, every employee's status, every login's
 * access rows, every hrms_ row count.
 *
 * Local only — it refuses a non-local DB_HOST.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as PEOPLE from '../../apps/cf_hrms/services/peopleService.js';
import * as ASG from '../../apps/cf_hrms/services/assignmentService.js';
import * as HIRE from '../../apps/cf_hrms/services/hiringService.js';
import * as EXIT from '../../apps/cf_hrms/services/exitService.js';
import * as CODES from '../../apps/cf_hrms/services/codeService.js';
import { listExitReasons, shortDay } from '../../apps/cf_hrms/services/exitRead.js';
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
const why = (e) => (e ? `${e.status ?? '?'} ${e.code ?? ''} ${e.message ?? ''}` : 'nothing was thrown');
const n = async (db, sql, params = []) => Number((await db.query(sql, params))[0][0].n);

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company "${slug}".`); process.exit(2); }
const COMPANY = company.id;
const IS_KARNI = slug === 'karni';
const TAG = `ZZEX${Date.now().toString(36).toUpperCase().slice(-5)}`;
const on = POS.today();
const addDays = (iso, d) => { const x = new Date(`${iso}T00:00:00`); x.setDate(x.getDate() + d); return POS.dateText(x); };
const [[adminUser]] = await pool.query(
  `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);
const c = { companyId: COMPANY, userId: adminUser?.id ?? null };
const [[other]] = await pool.query('SELECT id, name FROM companies WHERE id <> ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
const OTHER = other.id;

/* ── what "as it was found" means ─────────────────────────────────────────── */
const hrmsTables = (await pool.query(
  "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'hrms\\_%' ORDER BY TABLE_NAME"))[0].map((r) => r.t);
const snapshot = async () => {
  const out = {};
  for (const t of hrmsTables) {
    const [[r]] = await pool.query(`SELECT COUNT(*) AS total, SUM(deleted_at IS NULL) AS live FROM ${t} WHERE company_id = ?`, [COMPANY]);
    out[t] = `${r.total}/${r.live ?? 0}`;
  }
  const [statuses] = await pool.query('SELECT employment_status AS s, COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL GROUP BY employment_status ORDER BY 1', [COMPANY]);
  out.statuses = statuses.map((r) => `${r.s}:${r.n}`).join(' ');
  // Every access row of the company, and every user row: id and whether it is live.
  const [access] = await pool.query('SELECT id, user_id, deleted_at IS NULL AS live FROM app_user_access WHERE company_id = ? ORDER BY id', [COMPANY]);
  out.access = access.map((r) => `${r.id}:${r.user_id}:${r.live}`).join(',');
  const [users] = await pool.query('SELECT id, MD5(CONCAT(email, password, IFNULL(role_id, 0))) AS h, deleted_at IS NULL AS live FROM users WHERE company_id = ? ORDER BY id', [COMPANY]);
  out.users = users.map((r) => `${r.id}:${r.h}:${r.live}`).join(',');
  return out;
};
const baseline = await snapshot();
const baselineChart = (await buildOrgChart(pool, COMPANY, {})).counts;

console.log(`exit_test — ${company.name} (${COMPANY}), run tag ${TAG}, as of ${on}; the other company is ${other.name} (${OTHER})`);

async function rolledBack(fn) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    // Inside the transaction only: the people used here joined long ago, so a notice given three weeks back is possible.
    if (fixtureIds.length) await db.query('UPDATE hrms_employees SET date_of_joining = ? WHERE company_id = ? AND id IN (?)', [addDays(on, -400), COMPANY, fixtureIds]);
    await fn(db);
  } finally {
    try { await db.rollback(); } catch { /* nothing to undo */ }
    db.release();
  }
}

/** What the platform's middleware asks before it lets a user into the app (core/middleware/authmiddleware.js). */
const hasAppAccess = async (db, userId) => (await db.query(
  `SELECT x.id FROM app_user_access x JOIN apps a ON a.id = x.app_id
    WHERE x.user_id = ? AND x.company_id = ? AND a.slug = 'cf_hrms' AND x.deleted_at IS NULL LIMIT 1`, [userId, COMPANY]))[0].length > 0;

/** People in a position, with a login that can open the app today. */
const [people] = await pool.query(
  `SELECT e.id, e.full_name, e.employee_code, e.user_id, wa.id AS assignment_id, wa.position_id, p.position_code, p.role_id
     FROM hrms_employees e
     JOIN hrms_work_assignments wa ON wa.company_id = e.company_id AND wa.employee_id = e.id AND wa.deleted_at IS NULL AND wa.status = 'ACTIVE'
          AND wa.position_id IS NOT NULL AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND wa.effective_to IS NULL
     JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id AND p.deleted_at IS NULL AND p.status <> 'CLOSED'
    WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.employment_status = 'ACTIVE' AND e.user_id IS NOT NULL
      AND (SELECT COUNT(*) FROM hrms_work_assignments o WHERE o.company_id = e.company_id AND o.employee_id = e.id AND o.deleted_at IS NULL AND o.status <> 'ENDED') = 1
      AND EXISTS (SELECT 1 FROM app_user_access x WHERE x.user_id = e.user_id AND x.company_id = e.company_id AND x.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM hrms_hirings h WHERE h.company_id = p.company_id AND h.open_position = p.id)
    ORDER BY e.id LIMIT 4`,
  [on, COMPANY],
);

const fixtureIds = people.slice(0, 3).map((p) => p.id);

/* ══ 1. the reasons ═══════════════════════════════════════════════════════ */
section('[1] Reasons');
{
  const { types } = listExitReasons();
  ok(types.length === 2 && types[0].type === 'RESIGNED' && types[0].label === 'The employee resigned' && types[1].type === 'REMOVED' && types[1].label === 'We ended the employment',
    'GET /people/exit-reasons: two types, resigned first');
  ok(types[0].reasons.map((r) => r.code).join(' ') === 'BETTER_JOB PERSONAL RELOCATION PAY WORK_CONDITIONS HEALTH STUDIES RETIRED OTHER'
    && types[1].reasons.map((r) => r.code).join(' ') === 'ABSENT PERFORMANCE PROBATION MISCONDUCT CONTRACT_END ROLE_REMOVED DECEASED OTHER', 'the reasons of each, in the spec’s order');
  ok(types.flatMap((t) => t.reasons).every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(['code', 'label', 'noteRequired']) && r.label && r.noteRequired === (r.code === 'OTHER')),
    'each is { code, label, noteRequired }; a note is required for "Something else" only');
}

if (people.length < 3) {
  skip('everything else', 'this company has fewer than three employees in a position with a working login');
} else {
  const [A, B, C] = people;

  /* ══ 2. start, read, edit, withdraw ═════════════════════════════════════ */
  section('[2] Start -> NOTICE; what every read gains; edit; withdraw -> ACTIVE');
  await rolledBack(async (db) => {
    const settingsDays = Number((await db.query('SELECT notice_days_confirmed AS d FROM hrms_hiring_settings WHERE company_id = ?', [COMPANY]))[0][0]?.d ?? 30);
    const chartBefore = await buildOrgChart(db, COMPANY, {});
    ok(chartBefore.counts.onNotice === baselineChart.onNotice && chartBefore.nodes.every((x) => x.occupants.every((o) => o.notice === null)) === (baselineChart.onNotice === 0),
      'before anything: counts.onNotice is what it was, and every occupant has `notice` (null)');

    // ── validation ──
    // Relative to what the tenant already holds: a real company has leaving history.
    const exitsBefore = await n(db, 'SELECT COUNT(*) AS n FROM hrms_employee_exits WHERE company_id = ?', [COMPANY]);
    const auditFloor = await n(db, "SELECT COALESCE(MAX(id), 0) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_employee_exits'", [COMPANY]);
    const bad = async (body, problems, label) => {
      const e = await caught(() => EXIT.startExit(db, c, A.id, body));
      ok(refused(e, 422, 'INVALID') && e.problems.length === problems, `${label}: 422 INVALID`, `${why(e)} ${JSON.stringify(e?.problems)}`);
    };
    await bad({}, 1, 'nothing said about who decided');
    await bad({ exitType: 'RESIGNED' }, 1, 'no reason');
    await bad({ exitType: 'RESIGNED', reasonCode: 'PERFORMANCE' }, 1, 'a reason of the other type');
    await bad({ exitType: 'REMOVED', reasonCode: 'OTHER', note: '  ' }, 1, '"Something else" without a note');
    await bad({ exitType: 'RESIGNED', reasonCode: 'PAY', noticeDate: on, lastWorkingDay: addDays(on, -1) }, 1, 'a last working day before the notice date');
    await bad({ exitType: 'RESIGNED', reasonCode: 'PAY', noticeDate: addDays(on, 2) }, 1, 'a notice date in the future');
    await bad({ exitType: 'FIRED', reasonCode: 'OTHER', noticeDate: 'soon', lastWorkingDay: 'later' }, 3, 'three things wrong at once: three problems');
    ok(await n(db, 'SELECT COUNT(*) AS n FROM hrms_employee_exits WHERE company_id = ?', [COMPANY]) === exitsBefore
      && (await PEOPLE.getEmployee(db, COMPANY, A.id)).employee.employmentStatus === 'ACTIVE', 'and none of those wrote anything');

    // ── start ──
    const started = await EXIT.startExit(db, c, A.id, { exitType: 'RESIGNED', reasonCode: 'BETTER_JOB', noticeDate: on });
    const x = started.exit;
    ok(JSON.stringify(Object.keys(started)) === JSON.stringify(['employee', 'exit']) && started.employee.id === A.id && started.employee.employmentStatus === 'NOTICE',
      'start returns { employee, exit } and the employee is on NOTICE');
    ok(x.exitType === 'RESIGNED' && x.typeLabel === 'The employee resigned' && x.reasonCode === 'BETTER_JOB' && x.reasonLabel === 'Better job elsewhere' && x.note === null
      && x.noticeDate === on && x.status === 'OPEN' && x.closedOn === null,
    'the record: type, reason and their labels, the notice date, OPEN', JSON.stringify(x));
    ok(x.lastWorkingDay === addDays(on, settingsDays) && x.daysLeft === settingsDays && x.statusLine === `On notice · last day ${shortDay(x.lastWorkingDay)}`,
      `no last working day sent: the notice date + the company’s ${settingsDays} days; daysLeft and the status line follow`, `${x.lastWorkingDay} ${x.daysLeft} ${x.statusLine}`);
    for (const key of ['id', 'exitType', 'typeLabel', 'reasonCode', 'reasonLabel', 'note', 'noticeDate', 'lastWorkingDay', 'status', 'closedOn', 'daysLeft', 'statusLine']) {
      if (!(key in x)) ok(false, `the Exit shape has ${key}`);
    }
    ok(JSON.stringify(started.employee.exit) === JSON.stringify(x), 'the employee in the answer carries the same record as `exit`');

    const again = await caught(() => EXIT.startExit(db, c, A.id, { exitType: 'REMOVED', reasonCode: 'ABSENT', noticeDate: on }));
    ok(refused(again, 409, 'EXIT_OPEN') && again.existing?.id === x.id, 'a second start: 409 EXIT_OPEN, naming the open record', why(again));
    const dbAgain = await caught(() => db.query(
      "INSERT INTO hrms_employee_exits (company_id, employee_id, exit_type, reason_code, notice_date, last_working_day, status) VALUES (?, ?, 'REMOVED', 'ABSENT', ?, ?, 'OPEN')", [COMPANY, A.id, on, on]));
    ok(dbAgain?.errno === 1062, 'and the database itself refuses a second open record (uq_hexi_open)', dbAgain?.code ?? 'accepted');

    // ── employee reads ──
    const detail = await PEOPLE.getEmployee(db, COMPANY, A.id);
    ok(detail.employee.exit?.id === x.id && detail.employee.employmentStatus === 'NOTICE' && detail.counts.activeAssignments === 1, 'GET /people/employees/:id: `exit` on the employee; they still hold their assignment');
    const list = await PEOPLE.listEmployees(db, COMPANY, {});
    const row = list.items.find((e) => e.id === A.id);
    ok(row?.exit?.id === x.id && row.employmentStatus === 'NOTICE' && list.items.filter((e) => e.exit).length === 1 && list.items.every((e) => 'exit' in e),
      'GET /people/employees: the row carries `exit`; everybody else has null');
    ok(list.items.every((e) => ['ACTIVE', 'NOTICE'].includes(e.employmentStatus)), 'the default list is working + on notice');
    const onlyNotice = await PEOPLE.listEmployees(db, COMPANY, { status: 'NOTICE' });
    ok(onlyNotice.items.length === 1 && onlyNotice.items[0].id === A.id && (await PEOPLE.listEmployees(db, COMPANY, { status: 'ACTIVE' })).items.every((e) => e.id !== A.id)
      && (await PEOPLE.listEmployees(db, COMPANY, { status: 'ACTIVE,NOTICE' })).items.length === list.items.length, '?status=NOTICE is just them; ACTIVE is everybody else; ACTIVE,NOTICE is the default');
    const mine = await myPlace(db, { companyId: COMPANY, userId: A.user_id }, {});
    ok(mine.linked === true && mine.exit?.id === x.id && mine.me.employmentStatus === 'NOTICE' && mine.seats.length === 1, 'the employee’s own page (/user/me/place) still answers, with their `exit`');
    ok((await myPlace(db, { companyId: COMPANY, userId: B.user_id }, {})).exit === null, 'and somebody not on notice has `exit: null` there');

    // ── position reads ──
    const mark = { exitId: x.id, exitType: 'RESIGNED', lastWorkingDay: x.lastWorkingDay, daysLeft: settingsDays };
    const isMark = (v) => JSON.stringify(v) === JSON.stringify(mark);
    const chart = await buildOrgChart(db, COMPANY, {});
    const node = chart.nodes.find((q) => q.id === A.position_id);
    ok(isMark(node.occupants[0].notice) && node.vacancies === 0 && chart.counts.onNotice === baselineChart.onNotice + 1
      && chart.counts.filled === chartBefore.counts.filled && chart.counts.vacant === chartBefore.counts.vacant,
    'the chart: the occupant carries notice = { exitId, exitType, lastWorkingDay, daysLeft }; counts.onNotice is up by one; still FILLED', JSON.stringify(node.occupants[0].notice));
    ok(chart.nodes.flatMap((q) => q.occupants).filter((o) => o.notice).length === baselineChart.onNotice + 1, 'nobody else is marked');
    const card = await getPositionCard(db, COMPANY, A.position_id, {});
    ok(isMark(card.occupants[0].notice) && card.canHireReplacement === true && card.vacancies === 0, 'the position card: occupant.notice, and canHireReplacement is true');
    if (card.siblings.length) {
      const seen = (await getPositionCard(db, COMPANY, card.siblings[0].positionId, {})).siblings.find((s) => s.positionId === A.position_id);
      ok(isMark(seen.occupant.notice), 'seen from another position of the card, the sibling’s occupant carries it');
    }
    const position = (await POS.getPosition(db, COMPANY, A.position_id)).position;
    const listed = await POS.listPositions(db, COMPANY, { status: 'DRAFT,ACTIVE,FROZEN' });
    ok(isMark(position.occupant.notice) && position.canHireReplacement === true && position.filledCount === 1
      && isMark(listed.items.find((q) => q.id === A.position_id).occupant.notice) && listed.items.filter((q) => q.canHireReplacement).length === 1
      && listed.items.filter((q) => q.occupant).every((q) => 'notice' in q.occupant) && listed.totals.filled === chartBefore.counts.filled,
    'GET /positions and /positions/:id: occupant.notice and canHireReplacement, on that row only');
    const staff = (await departmentStaffing(db, COMPANY, {})).departments.flatMap((d) => d.roles).flatMap((r) => r.positions).find((q) => q.positionId === A.position_id);
    ok(isMark(staff.occupant.notice) && isMark(staff.occupants[0].notice) && staff.filled === 1, 'the Departments staffing row: occupant.notice');
    const otherPosition = (await POS.getPosition(db, COMPANY, B.position_id)).position;
    ok(otherPosition.occupant.notice === null && otherPosition.canHireReplacement === false, 'a position whose occupant is staying: notice null, canHireReplacement false');

    // ── edit ──
    const edited = await EXIT.updateExit(db, c, A.id, { lastWorkingDay: addDays(on, 12), reasonCode: 'WORK_CONDITIONS' });
    ok(edited.exit.id === x.id && edited.exit.lastWorkingDay === addDays(on, 12) && edited.exit.daysLeft === 12 && edited.exit.reasonCode === 'WORK_CONDITIONS'
      && edited.exit.reasonLabel === 'Work, shift or conditions' && edited.exit.exitType === 'RESIGNED' && edited.exit.noticeDate === on,
    'PUT changes only what was sent: the last working day and the reason', JSON.stringify(edited.exit));
    ok((await buildOrgChart(db, COMPANY, {})).nodes.find((q) => q.id === A.position_id).occupants[0].notice.daysLeft === 12, 'the chart follows');
    const switched = await EXIT.updateExit(db, c, A.id, { exitType: 'REMOVED', reasonCode: 'OTHER', note: 'Agreed between both sides.' });
    ok(switched.exit.exitType === 'REMOVED' && switched.exit.reasonLabel === 'Something else' && switched.exit.note === 'Agreed between both sides.', 'who decided can be corrected too');
    ok((await EXIT.updateExit(db, c, A.id, { exitType: 'RESIGNED' })).exit.typeLabel === 'The employee resigned', '…and back ("Something else" is a reason of both)');
    ok(refused(await caught(() => EXIT.updateExit(db, c, A.id, { reasonCode: 'ABSENT' })), 422, 'INVALID')
      && refused(await caught(() => EXIT.updateExit(db, c, A.id, { lastWorkingDay: addDays(on, -3) })), 422, 'INVALID')
      && refused(await caught(() => EXIT.updateExit(db, c, A.id, { note: '' })), 422, 'INVALID'), 'a mismatched reason, a last day before the notice, a cleared required note: each 422');
    ok(refused(await caught(() => EXIT.updateExit(db, c, B.id, { note: 'x' })), 409, 'NO_EXIT_OPEN'), 'editing the notice of somebody who is not on one: 409');

    // ── close refused while the day has not come ──
    const early = await caught(() => EXIT.closeExit(db, c, A.id, {}));
    ok(refused(early, 422, 'NOT_READY') && early.detail?.lastWorkingDay === addDays(on, 12), 'closing before the last working day, without bringing it forward: 422 NOT_READY', why(early));
    ok(refused(await caught(() => EXIT.closeExit(db, c, A.id, { lastWorkingDay: addDays(on, 3) })), 422, 'NOT_READY'), 'a date sent that is still in the future: 422 NOT_READY');

    // ── withdraw ──
    const withdrawn = await EXIT.withdrawExit(db, c, A.id, { note: 'Stayed after a talk.' });
    ok(withdrawn.employee.employmentStatus === 'ACTIVE' && withdrawn.employee.exit === null && withdrawn.exit.status === 'WITHDRAWN' && withdrawn.exit.daysLeft === null
      && withdrawn.exit.withdrawnOn === on && withdrawn.exit.statusLine === `Notice withdrawn on ${shortDay(on)}`,
    'withdraw: the employee is ACTIVE again with no `exit`; the record is kept as WITHDRAWN', JSON.stringify(withdrawn.exit));
    const chartAfter = await buildOrgChart(db, COMPANY, {});
    ok(chartAfter.counts.onNotice === baselineChart.onNotice && chartAfter.nodes.find((q) => q.id === A.position_id).occupants[0].notice === null
      && (await POS.getPosition(db, COMPANY, A.position_id)).position.canHireReplacement === false, 'the chart mark and "hire a replacement" are gone');
    ok(refused(await caught(() => EXIT.withdrawExit(db, c, A.id, {})), 409, 'NO_EXIT_OPEN') && refused(await caught(() => EXIT.closeExit(db, c, A.id, { lastWorkingDay: on })), 409, 'NO_EXIT_OPEN'),
      'withdrawing or closing with no notice open: 409');
    const history = (await EXIT.listExits(db, COMPANY, A.id)).exits;
    ok(history.length === 1 && history[0].status === 'WITHDRAWN' && history[0].withdrawNote === 'Stayed after a talk.', 'GET /people/employees/:id/exits keeps it');
    const [events] = await db.query("SELECT event_type, summary FROM hrms_employment_events WHERE company_id = ? AND employee_id = ? AND summary LIKE '%otice%' ORDER BY id", [COMPANY, A.id]);
    ok(events.length === 2 && events.every((e) => e.event_type === 'OTHER'), 'their file records the notice and its cancellation', JSON.stringify(events.map((e) => e.summary)));
    const second = await EXIT.startExit(db, c, A.id, { exitType: 'REMOVED', reasonCode: 'CONTRACT_END', noticeDate: addDays(on, -5), lastWorkingDay: on });
    ok(second.exit.id !== x.id && second.exit.daysLeft === 0 && (await EXIT.listExits(db, COMPANY, A.id)).exits.map((e) => e.status).join(' ') === 'OPEN WITHDRAWN',
      'a new notice can be started afterwards; the history lists both, newest first');
    const [audits] = await db.query("SELECT action FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_employee_exits' AND id > ? ORDER BY id", [COMPANY, auditFloor]);
    ok(audits.map((a) => a.action).join(' ') === 'CREATE UPDATE UPDATE UPDATE UPDATE CREATE', 'every step is in the audit log', audits.map((a) => a.action).join(' '));
  });

  /* ══ 3. close ═══════════════════════════════════════════════════════════ */
  section('[3] Close -> EXITED: assignments ended, position vacant, event, login; then what an exited employee is');
  await rolledBack(async (db) => {
    const chartBefore = (await buildOrgChart(db, COMPANY, {})).counts;
    const liveAccessBefore = await n(db, 'SELECT COUNT(*) AS n FROM app_user_access WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
    const [[userBefore]] = await db.query('SELECT email, password, role_id, team_id, company_id, deleted_at FROM users WHERE id = ?', [A.user_id]);
    ok(await hasAppAccess(db, A.user_id) && await hasAppAccess(db, B.user_id), 'before: both logins can open the app');

    const lastDay = addDays(on, 9);
    await EXIT.startExit(db, c, A.id, { exitType: 'RESIGNED', reasonCode: 'RELOCATION', noticeDate: addDays(on, -21), lastWorkingDay: lastDay });
    // "End the notice early": the body brings the last working day to today.
    const closed = await EXIT.closeExit(db, c, A.id, { lastWorkingDay: on, note: 'Released early at their request.' });
    ok(JSON.stringify(Object.keys(closed)) === JSON.stringify(['employee', 'exit', 'endedAssignments', 'vacatedPositions', 'loginDisabled']),
      'close returns { employee, exit, endedAssignments, vacatedPositions, loginDisabled }', Object.keys(closed).join(','));
    ok(closed.employee.employmentStatus === 'EXITED' && closed.employee.exitDate === on && closed.exit.status === 'CLOSED' && closed.exit.lastWorkingDay === on
      && closed.exit.closedOn === on && closed.exit.daysLeft === null && closed.exit.closeNote === 'Released early at their request.'
      && closed.exit.statusLine === `Left on ${shortDay(on)} · resigned` && closed.employee.exit?.id === closed.exit.id,
    'EXITED, exit_date = the last working day (brought forward to today); the record is CLOSED and reads "Left on … · resigned"', closed.exit.statusLine);
    ok(closed.endedAssignments === 1 && JSON.stringify(closed.vacatedPositions.map((v) => Object.keys(v))) === JSON.stringify([['positionId', 'positionCode', 'roleTitle']])
      && closed.vacatedPositions[0].positionId === A.position_id && closed.vacatedPositions[0].positionCode === A.position_code && Boolean(closed.vacatedPositions[0].roleTitle),
    'one assignment ended; vacatedPositions names the position', JSON.stringify(closed.vacatedPositions));
    const [[asg]] = await db.query('SELECT status, effective_to FROM hrms_work_assignments WHERE id = ?', [A.assignment_id]);
    ok(asg.status === 'ENDED' && POS.dateText(asg.effective_to) === on, 'their assignment is ENDED with effective_to = that day');
    const position = (await POS.getPosition(db, COMPANY, A.position_id)).position;
    const chartAfter = (await buildOrgChart(db, COMPANY, {})).counts;
    ok(position.vacancyCount === 1 && position.occupant === null && position.canHireReplacement === false
      && chartAfter.filled === chartBefore.filled - 1 && chartAfter.vacant === chartBefore.vacant + 1 && chartAfter.onNotice === baselineChart.onNotice,
    'the position is vacant; the chart has one fewer filled, one more vacant, nobody on notice');
    const [events] = await db.query("SELECT event_type, event_date, summary FROM hrms_employment_events WHERE company_id = ? AND employee_id = ? AND event_type = 'EXIT'", [COMPANY, A.id]);
    ok(events.length === 1 && POS.dateText(events[0].event_date) === on && /left: resigned \(moving to another place\)/.test(events[0].summary), 'an EXIT event is in their file, dated the last working day', events[0]?.summary);

    // ── the login ──
    ok(closed.loginDisabled === true && !(await hasAppAccess(db, A.user_id)), 'loginDisabled is true: the linked login has no access to the app any more');
    const [[userAfter]] = await db.query('SELECT email, password, role_id, team_id, company_id, deleted_at FROM users WHERE id = ?', [A.user_id]);
    ok(JSON.stringify(userAfter) === JSON.stringify(userBefore) && userAfter.deleted_at === null, 'their user row is untouched — not deleted, password not changed');
    // Access rows that were live when the run began and are not now.
    const [removed] = await db.query(
      `SELECT x.id, x.user_id FROM app_user_access x WHERE x.company_id = ? AND x.deleted_at IS NOT NULL
          AND x.id IN (${baseline.access.split(',').filter((r) => r.endsWith(':1')).map((r) => Number(r.split(':')[0])).join(',') || 0})`, [COMPANY]);
    ok(removed.length >= 1 && removed.every((r) => r.user_id === A.user_id)
      && await n(db, 'SELECT COUNT(*) AS n FROM app_user_access WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]) === liveAccessBefore - removed.length,
    `only that user’s access rows changed (${removed.length}); every other login’s rows are as they were`);
    ok(await hasAppAccess(db, B.user_id) && await hasAppAccess(db, C.user_id) && await hasAppAccess(db, c.userId), 'other employees and the admin can still open the app');
    const [[auditRow]] = await db.query("SELECT after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_employee_exits' AND entity_id = ? ORDER BY id DESC LIMIT 1", [COMPANY, closed.exit.id]);
    const after = typeof auditRow.after_json === 'string' ? JSON.parse(auditRow.after_json) : auditRow.after_json;
    ok(after.status === 'CLOSED' && after.login.userId === A.user_id && JSON.stringify([...after.login.accessRowIds].sort()) === JSON.stringify(removed.map((r) => r.id).sort()),
      'the audit row of the close names the user and the access rows — what is needed to undo it');
    await db.query('SAVEPOINT undo_login');
    await db.query('UPDATE app_user_access SET deleted_at = NULL WHERE id IN (?) AND user_id = ?', [after.login.accessRowIds, A.user_id]);
    ok(await hasAppAccess(db, A.user_id), 'clearing deleted_at on those rows gives the access back: it is reversible');
    await db.query('ROLLBACK TO SAVEPOINT undo_login');

    // ── afterwards ──
    ok(refused(await caught(() => EXIT.startExit(db, c, A.id, { exitType: 'RESIGNED', reasonCode: 'PAY', noticeDate: on })), 409, 'ALREADY_LEFT')
      && refused(await caught(() => EXIT.closeExit(db, c, A.id, {})), 409, 'ALREADY_LEFT'), 'starting or closing again: 409 ALREADY_LEFT');
    ok(refused(await caught(() => EXIT.updateExit(db, c, A.id, { note: 'x' })), 409, 'NO_EXIT_OPEN') && refused(await caught(() => EXIT.withdrawExit(db, c, A.id, {})), 409, 'NO_EXIT_OPEN'),
      'the closed record can be neither edited nor withdrawn');
    const read = await PEOPLE.getEmployee(db, COMPANY, A.id);
    ok(read.employee.employeeCode === A.employee_code && read.employee.exit?.status === 'CLOSED' && read.employee.fullName === A.full_name && read.assignments.length === 1 && read.assignments[0].status === 'ENDED',
      'the employee is still readable: their code, their record of leaving, their ended assignment');
    const dflt = await PEOPLE.listEmployees(db, COMPANY, {});
    const left = await PEOPLE.listEmployees(db, COMPANY, { status: 'EXITED' });
    const all = await PEOPLE.listEmployees(db, COMPANY, { status: 'ALL' });
    ok(dflt.items.every((e) => e.id !== A.id) && left.items.some((e) => e.id === A.id && e.exit?.status === 'CLOSED') && all.items.length === dflt.items.length + left.items.length,
      'the default Employees list no longer shows them; ?status=EXITED does, with `exit`; ?status=ALL is everybody');
    const assign = await caught(() => ASG.createAssignment(db, c, { employeeId: A.id, roleId: A.role_id, positionId: A.position_id, effectiveFrom: on }));
    ok(refused(assign, 409, 'EMPLOYEE_LEFT') && assign.message === `${A.full_name} has left the company and cannot be given new work.`, 'they cannot be given a new assignment: 409, in a plain sentence', why(assign));
    const options = await ASG.assignmentOptions(db, COMPANY, {});
    ok(options.employees.some((e) => e.id === B.id) && options.employees.every((e) => e.id !== A.id),
      'and they are not offered in the "move an existing employee here" picker');
    await rolledBackInner(db, async () => {
      const code = await CODES.issueEmployeeCode(db, COMPANY, {});
      ok(code !== A.employee_code, `the next employee code issued is not theirs (${code})`);
    });
    const mine = await myPlace(db, { companyId: COMPANY, userId: A.user_id }, {});
    ok(mine.linked === true && mine.exit?.status === 'CLOSED' && mine.seats.length === 0, 'their own page, asked for directly, says they have left and shows no position');
    const hire = (await HIRE.startHiring(db, c, A.position_id)).hiring;
    ok(hire.stage === 'JD', '"Hire for the position they left": a hiring starts on it');
  });

  await rolledBack(async (db) => {
    // On the recorded day itself, with no date sent — and an employee who has no login.
    await db.query('UPDATE hrms_employees SET user_id = NULL WHERE id = ?', [B.id]);
    await EXIT.startExit(db, c, B.id, { exitType: 'REMOVED', reasonCode: 'ABSENT', noticeDate: addDays(on, -10), lastWorkingDay: addDays(on, -2) });
    const closed = await EXIT.closeExit(db, c, B.id, {});
    ok(closed.employee.employmentStatus === 'EXITED' && closed.employee.exitDate === addDays(on, -2) && closed.exit.closedOn === on && closed.exit.lastWorkingDay === addDays(on, -2)
      && closed.exit.statusLine === `Left on ${shortDay(addDays(on, -2))} · employment ended`,
    'a last working day that has passed: closed with no date sent; exit_date is that day, closedOn is today', closed.exit.statusLine);
    ok(closed.loginDisabled === false && await n(db, 'SELECT COUNT(*) AS n FROM app_user_access WHERE company_id = ? AND deleted_at IS NOT NULL', [COMPANY])
      === baseline.access.split(',').filter((r) => r.endsWith(':0')).length, 'an employee with no login: loginDisabled is false and no access row was touched');
    const [[asg]] = await db.query('SELECT status, effective_to FROM hrms_work_assignments WHERE id = ?', [B.assignment_id]);
    ok(asg.status === 'ENDED' && POS.dateText(asg.effective_to) === addDays(on, -2), 'their assignment ended on the last working day, not today');
    ok(refused(await caught(() => EXIT.closeExit(db, c, C.id, {})), 409, 'NO_EXIT_OPEN'), 'closing somebody who is not on notice: 409 — start the leaving first');
  });

  /* ══ 4. a replacement ═══════════════════════════════════════════════════ */
  section('[4] A replacement: hiring on the position of somebody on notice');
  const CANDIDATE = {
    candidateSalutation: 'Mr.', candidateName: `Test Replacement ${TAG}`, candidatePhone: '9000000001', candidateAddress: 'Flat 2, Example Towers,\nHyderabad.',
    proposedJoiningDate: addDays(on, 30), annualCtc: 240000,
  };
  const toAppointment = async (db, positionId) => {
    const H = (await HIRE.startHiring(db, c, positionId)).hiring.id;
    await HIRE.confirmJd(db, c, H);
    await HIRE.updateHiring(db, c, H, CANDIDATE);
    await HIRE.generateOfferLetter(db, c, H);
    await HIRE.acceptOffer(db, c, H, {});
    return H;
  };
  await rolledBack(async (db) => {
    const lastDay = addDays(on, 20);
    const staying = await caught(() => HIRE.startHiring(db, c, A.position_id));
    ok(refused(staying, 409, 'POSITION_FILLED'), 'a hiring on a position filled by somebody who is staying: still 409 POSITION_FILLED', why(staying));
    await EXIT.startExit(db, c, A.id, { exitType: 'RESIGNED', reasonCode: 'STUDIES', noticeDate: on, lastWorkingDay: lastDay });
    const H = await toAppointment(db, A.position_id);
    const hiring = (await HIRE.getHiring(db, COMPANY, H)).hiring;
    ok(hiring.stage === 'APPOINTMENT' && hiring.replacing?.employeeId === A.id && hiring.replacing.name === A.full_name && hiring.replacing.lastWorkingDay === lastDay && hiring.replacing.daysLeft === 20,
      'with the occupant on notice the hiring starts and runs; it says whom it replaces and their last working day', JSON.stringify(hiring.replacing));
    const position = (await POS.getPosition(db, COMPANY, A.position_id)).position;
    ok(position.filledCount === 1 && position.occupant.notice?.lastWorkingDay === lastDay && position.hiring?.id === H && position.canHireReplacement === false,
      'the position: still filled, occupant on notice, the open hiring on it — so "hire a replacement" is no longer offered');

    for (const date of [on, lastDay]) {
      const tooEarly = await caught(() => HIRE.appoint(db, c, H, { joiningDate: date }));
      ok(refused(tooEarly, 422, 'NOT_READY') && tooEarly.problems.length === 1 && tooEarly.message.includes(A.full_name) && tooEarly.detail?.replacing?.lastWorkingDay === lastDay,
        `appointing from ${date === on ? 'today' : 'the last working day itself'}: 422 NOT_READY — the joining date must be after it`, why(tooEarly));
    }
    ok((await HIRE.getHiring(db, COMPANY, H)).hiring.stage === 'APPOINTMENT' && await n(db, 'SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND full_name = ?', [COMPANY, CANDIDATE.candidateName]) === 0,
      'and nothing was written by those');
    const joining = addDays(lastDay, 1);
    const done = await HIRE.appoint(db, c, H, { joiningDate: joining });
    const [[asg]] = await db.query('SELECT status, effective_from, position_id FROM hrms_work_assignments WHERE id = ?', [done.assignmentId]);
    ok(done.hiring.stage === 'DONE' && asg.position_id === A.position_id && POS.dateText(asg.effective_from) === joining && done.hiring.replacing === null,
      'from the day after: appointed, with the new assignment starting on the joining date');
    const now = (await POS.getPosition(db, COMPANY, A.position_id)).position;
    ok(now.occupant.employeeId === A.id && now.occupant.notice?.lastWorkingDay === lastDay && now.joining?.employeeId === done.employee.id && now.joining.date === joining
      && now.hiring === null && now.canHireReplacement === false && now.filledCount === 1,
    'until then the position shows the person on notice AND who joins after them');

    // From here the notice cannot be taken back, nor stretched into the new person's first day.
    const noWithdraw = await caught(() => EXIT.withdrawExit(db, c, A.id, {}));
    ok(refused(noWithdraw, 409, 'POSITION_FILLED') && noWithdraw.message.includes(CANDIDATE.candidateName) && noWithdraw.detail?.successor?.from === joining, 'cancelling the notice now: 409 POSITION_FILLED, naming the replacement', why(noWithdraw));
    ok(refused(await caught(() => EXIT.updateExit(db, c, A.id, { lastWorkingDay: joining })), 409, 'POSITION_FILLED')
      && (await EXIT.updateExit(db, c, A.id, { lastWorkingDay: addDays(on, 5) })).exit.lastWorkingDay === addDays(on, 5),
    'the last working day cannot move to the replacement’s first day or past it; an earlier one is fine');
    const closed = await EXIT.closeExit(db, c, A.id, { lastWorkingDay: on });
    const after = (await POS.getPosition(db, COMPANY, A.position_id)).position;
    const onTheDay = (await POS.getPosition(db, COMPANY, A.position_id, { on: joining })).position;
    ok(closed.endedAssignments === 1 && after.vacancyCount === 1 && after.joining?.employeeId === done.employee.id && onTheDay.occupant?.employeeId === done.employee.id && onTheDay.occupant.notice === null,
      'closing the leaver ends THEIR assignment only: vacant with the joiner due, then filled by the new person');
  });

  await rolledBack(async (db) => {
    // The notice is withdrawn while the hiring is waiting.
    await EXIT.startExit(db, c, A.id, { exitType: 'RESIGNED', reasonCode: 'PERSONAL', noticeDate: on, lastWorkingDay: addDays(on, 15) });
    const H = await toAppointment(db, A.position_id);
    const back = await EXIT.withdrawExit(db, c, A.id, {});
    ok(back.employee.employmentStatus === 'ACTIVE', 'with no replacement appointed yet, the notice can be cancelled');
    const lost = await caught(() => HIRE.appoint(db, c, H, { joiningDate: addDays(on, 16) }));
    ok(refused(lost, 409, 'POSITION_FILLED') && lost.detail?.occupant?.employeeId === A.id, 'appointing after the notice was withdrawn: 409 POSITION_FILLED — the person is staying', why(lost));
    ok((await HIRE.getHiring(db, COMPANY, H)).hiring.replacing === null && (await HIRE.getHiring(db, COMPANY, H)).hiring.stage === 'APPOINTMENT', 'the hiring is still there, to be closed; it no longer replaces anybody');
  });

  /* ══ 5. another company ═════════════════════════════════════════════════ */
  section('[5] Another company cannot reach any of it');
  await rolledBack(async (db) => {
    const there = { ...c, companyId: OTHER };
    await EXIT.startExit(db, c, A.id, { exitType: 'RESIGNED', reasonCode: 'HEALTH', noticeDate: on, lastWorkingDay: on });
    for (const [name, fn] of [
      ['start', () => EXIT.startExit(db, there, B.id, { exitType: 'RESIGNED', reasonCode: 'PAY', noticeDate: on })],
      ['edit', () => EXIT.updateExit(db, there, A.id, { note: 'x' })],
      ['withdraw', () => EXIT.withdrawExit(db, there, A.id, {})],
      ['close', () => EXIT.closeExit(db, there, A.id, {})],
      ['history', () => EXIT.listExits(db, OTHER, A.id)],
    ]) ok(refused(await caught(fn), 404, 'NOT_FOUND'), `${name} from another company: 404`);
    ok((await PEOPLE.getEmployee(db, COMPANY, A.id)).employee.exit?.status === 'OPEN' && (await PEOPLE.getEmployee(db, COMPANY, B.id)).employee.employmentStatus === 'ACTIVE'
      && (await PEOPLE.listEmployees(db, OTHER, { status: 'ALL' })).items.every((e) => e.id !== A.id), 'and nothing here changed');
  });
}

/** A savepoint inside the caller's transaction, always rolled back. */
async function rolledBackInner(db, fn) {
  await db.query('SAVEPOINT inner_try');
  try { await fn(); } finally { await db.query('ROLLBACK TO SAVEPOINT inner_try'); }
}

/* ══ 6. through the real middleware ═══════════════════════════════════════ */
section('[6] Permissions, over HTTP');
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
    const someId = people[0]?.id ?? 1;
    const ROUTES = [
      ['GET', '/people/exit-reasons'], ['GET', `/people/employees/${someId}/exits`],
      ['POST', `/people/employees/${someId}/exit`, { exitType: 'RESIGNED', reasonCode: 'PAY', noticeDate: on, lastWorkingDay: on }],
      ['PUT', `/people/employees/${someId}/exit`, { note: 'x' }], ['POST', `/people/employees/${someId}/exit/withdraw`, {}],
      ['POST', `/people/employees/${someId}/exit/close`, { lastWorkingDay: on }],
    ];
    if (!employee) skip('an Employee login', 'this company has no Employee-role login with access to the app');
    else {
      const wrong = [];
      for (const [method, url, body] of ROUTES) { const r = await call(employee, method, `${api}${url}`, body); if (r.status !== 403) wrong.push(`${method} ${url} ${r.status}`); }
      ok(wrong.length === 0, `an Employee login gets 403 from all ${ROUTES.length} leaving routes`, wrong.join('; '));
      const mine = await call(employee, 'GET', `${api}/user/me/place`);
      ok(mine.status === 200 && 'exit' in mine.json, 'their own page answers, and carries `exit`', `${mine.status}`);
    }
    if (outsider) {
      const wrong = [];
      for (const [method, url, body] of ROUTES) { const r = await call(outsider, method, `${api}${url}`, body); if (r.status !== 403) wrong.push(`${method} ${url} ${r.status}`); }
      ok(wrong.length === 0, 'an admin of another company gets 403 from all of them on this company’s URL', wrong.join('; '));
    } else skip('another company’s admin', 'no other company has an admin with access to cf_hrms');
    ok((await call(null, 'POST', `${api}/people/employees/${someId}/exit/close`, {})).status === 401, 'no token at all: 401');
    if (admin) {
      const reasons = await call(admin, 'GET', `${api}/people/exit-reasons`);
      const list = await call(admin, 'GET', `${api}/people/employees`);
      const exits = await call(admin, 'GET', `${api}/people/employees/${someId}/exits`);
      ok(reasons.status === 200 && reasons.json.types.length === 2 && list.status === 200 && list.json.items.every((e) => 'exit' in e && ['ACTIVE', 'NOTICE'].includes(e.employmentStatus))
        && exits.status === 200 && Array.isArray(exits.json.exits), 'an admin: the reasons, the employees list (working + on notice, each with `exit`) and a history all answer');
      const missing = await call(admin, 'POST', `${api}/people/employees/999999999/exit`, { exitType: 'RESIGNED', reasonCode: 'PAY' });
      ok(missing.status === 404 && missing.json.code === 'NOT_FOUND', 'starting the leaving of somebody who does not exist: 404 { code, message }');
      const chart = await call(admin, 'GET', `${api}/orgchart`);
      if (chart.status === 200) ok(typeof chart.json.counts.onNotice === 'number', 'the org chart answers with counts.onNotice');
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
  ok(moved.length === 0, `every hrms_ table, every employee’s status, every login and every access row is as it was (${hrmsTables.length} tables)`,
    moved.map((k) => (k.startsWith('hrms_') ? `${k} ${baseline[k]} -> ${after[k]}` : k)).join('; '));
  const chart = (await buildOrgChart(pool, COMPANY, {})).counts;
  ok(chart.positions === baselineChart.positions && chart.filled === baselineChart.filled && chart.vacant === baselineChart.vacant && chart.onNotice === baselineChart.onNotice,
    `positions / filled / vacant unchanged (${chart.positions} / ${chart.filled} / ${chart.vacant}), ${chart.onNotice} on notice`);
  if (IS_KARNI) {
    ok(chart.positions === 220 && chart.filled === 71 && chart.vacant === 149 && after.statuses === 'ACTIVE:71', 'Karni: 220 / 71 / 149, and all 71 employees ACTIVE', `${after.statuses}`);
    const canOpen = await n(pool,
      `SELECT COUNT(*) AS n FROM hrms_employees e
        WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.user_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id AND u.deleted_at IS NULL)
          AND EXISTS (SELECT 1 FROM app_user_access x JOIN apps a ON a.id = x.app_id WHERE x.user_id = e.user_id AND x.company_id = e.company_id AND a.slug = 'cf_hrms' AND x.deleted_at IS NULL)`, [COMPANY]);
    ok(canOpen === 71, 'all 71 employee logins still have their user row and their access to the app', `${canOpen}`);
    await rolledBack(async (db) => ok(await CODES.issueEmployeeCode(db, COMPANY, {}) === 'KP0072', 'the next employee code is still KP0072'));
    ok(await n(pool, 'SELECT COUNT(*) AS n FROM hrms_employee_exits WHERE company_id = ?', [COMPANY]) === Number(baseline.hrms_employee_exits.split('/')[0]), 'no leaving record was left behind');
  }
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
