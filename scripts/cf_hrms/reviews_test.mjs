/**
 * reviews_test.mjs — check-ins, reviews and action items (TM/CF_HRMS_HIRING_SPEC.md §20, 2026-10-15).
 *
 *   0. the schema (apply-reviews-schema.mjs): a second run plans nothing; grace days default 7;
 *   1. when a FINAL is due to exist (pure), the slots a check-in may be for;
 *   2. FINAL reviews: made once per ACTIVE plan when its period's last slot has
 *      opened — not for a draft, not before; idempotent; due = end + grace days;
 *   3. check-ins: for a slot that has begun, one per slot, not on a draft, due on the slot's end;
 *   4. the KPI table and plan score of a review equal scoring.js's numbers (the plan page's);
 *   5. the status flow and who writes what: the person's part (only their fields, only
 *      their own review, only while OPEN), the manager's part (a manager login over the
 *      people below them), the rating from the company's scale, close, DONE read-only
 *      and the Owner's amendment with a reason, cancelling a check-in, a cancelled plan;
 *   6. actions: owner, due, overdue, done, dropped; the person marks only their own done;
 *   7. rights and scope — HR executive, Department head, Employee, manager login;
 *   8. the number of queries of the lists and pages;
 *   9. tenant isolation; and nothing is left behind.
 *
 *   node scripts/cf_hrms/reviews_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: the whole run is ONE connection inside ONE transaction
 * (pool.query / getConnection point at it; a route's own transaction is a
 * savepoint), rolled back at the end. Local only.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as RC from '../../apps/cf_hrms/services/roleContentService.js';
import * as J from '../../apps/cf_hrms/services/jobContentService.js';
import { periodFor } from '../../apps/cf_hrms/services/performance/periods.js';
import { slotsOf } from '../../apps/cf_hrms/services/performance/slots.js';
import { kpiResult, scorePlan } from '../../apps/cf_hrms/services/performance/scoring.js';
import * as PLAN from '../../apps/cf_hrms/services/performance/planService.js';
import * as ACT from '../../apps/cf_hrms/services/performance/actualsService.js';
import * as REV from '../../apps/cf_hrms/services/performance/reviewService.js';
import { readSettings } from '../../apps/cf_hrms/services/performance/settingsService.js';
import { schemaSteps } from '../../apps/cf_hrms/scripts/apply-reviews-schema.mjs';

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
const note = (line) => console.log(`  note  ${line}`);
const section = (title) => console.log(`\n${title}`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

const TABLES = ['hrms_performance_settings', 'hrms_performance_periods', 'hrms_performance_plans', 'hrms_performance_plan_kras', 'hrms_performance_plan_kpis',
  'hrms_performance_target_changes', 'hrms_performance_actuals', 'hrms_performance_reviews', 'hrms_performance_actions',
  'hrms_roles', 'hrms_positions', 'hrms_employees', 'hrms_work_assignments', 'users', 'app_user_access'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM ${t}`);
      out[t] = `${r.n}/${r.live}`;
    }
    const [[s]] = await conn.query('SELECT GROUP_CONCAT(CONCAT(company_id, \':\', review_grace_days)) AS s FROM hrms_performance_settings');
    out.grace = s.s;
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
let tally = null;
const inside = {
  query: (...a) => { if (tally) tally.n += 1; return db.query(...a); },
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_rv_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_rv_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_rv_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const counting = () => {
  const box = { n: 0 };
  box.db = new Proxy(db, { get(t, p) { if (p === 'query') return (...a) => { box.n += 1; return t.query(...a); }; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
  return box;
};
const countPool = async (fn) => {
  tally = { n: 0 };
  try { const r = await fn(); return { n: tally.n, r }; } finally { tally = null; }
};

const TAG = `ZZRV${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

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
  const hr = { companyId: COMPANY, userId: owner.id, owner: false };
  const other = await one(
    `SELECT co.id, co.name, co.slug, a.id AS app_id FROM companies co JOIN apps a ON a.company_id = co.id AND a.slug = 'cf_hrms' AND a.deleted_at IS NULL
      WHERE co.id <> ? AND co.deleted_at IS NULL ORDER BY co.id LIMIT 1`, [COMPANY]);
  const T = POS.today();
  console.log(`reviews_test — ${company.name} (${COMPANY}), run tag ${TAG}, today ${T}`);
  const own = await one('SELECT (SELECT COUNT(*) FROM hrms_performance_periods WHERE company_id = ?) AS p, (SELECT COUNT(*) FROM hrms_performance_reviews WHERE company_id = ?) AS r', [COMPANY, COMPANY]);
  note(`${company.name} has ${own.p} performance periods and ${own.r} reviews of its own before the run (the test makes its own inside its transaction)`);

  /* ══ 0. the schema ════════════════════════════════════════════════════════ */
  section('[0] The schema');
  ok((await schemaSteps(db)).length === 0, 'apply-reviews-schema: nothing left to do on this database (idempotent)');
  const cols = await q(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND ((TABLE_NAME = 'hrms_performance_reviews' AND COLUMN_NAME IN ('kind', 'status', 'live_slot', 'rating_value', 'rating_label', 'amend_reason', 'blockers'))
      OR (TABLE_NAME = 'hrms_performance_actions' AND COLUMN_NAME IN ('status', 'owner_employee_id', 'due_date', 'done_on'))
      OR (TABLE_NAME = 'hrms_performance_settings' AND COLUMN_NAME = 'review_grace_days'))`);
  ok(cols.length === 12 && cols.filter((r) => ['kind', 'status'].includes(r.c)).every((r) => r.d === 'varchar'), 'the reviews and actions tables and the grace days are there; kinds and statuses are VARCHAR', JSON.stringify(cols.map((x) => `${x.t}.${x.c}`)));
  const settings = await readSettings(db, COMPANY);
  ok(settings.reviewGraceDays === 7, `a FINAL review is due 7 days after its period by default (${settings.reviewGraceDays})`);

  /* ══ 1. pure ══════════════════════════════════════════════════════════════ */
  section('[1] When a FINAL is made; the slots a check-in may be for');
  {
    const q3 = { name: 'Q3 2026-27', frequency: 'QUARTERLY', start: '2026-10-01', end: '2026-12-31' };
    ok(REV.finalOpensOn(q3, [null]) === '2026-12-01' && REV.finalOpensOn(q3, ['MONTHLY']) === '2026-12-01' && REV.finalOpensOn(q3, []) === '2026-12-01',
      'a quarterly plan: its FINAL is made on the first day of the last month (KPIs once per period, or monthly)');
    ok(REV.finalOpensOn(q3, ['WEEKLY']) === '2026-12-28' && REV.finalOpensOn(q3, ['DAILY']) === '2026-12-31', 'a weekly KPI: on its last week; a daily KPI: on the last day', `${REV.finalOpensOn(q3, ['WEEKLY'])} ${REV.finalOpensOn(q3, ['DAILY'])}`);
    ok(REV.finalOpensOn({ name: 'Oct 2026', frequency: 'MONTHLY', start: '2026-10-01', end: '2026-10-31' }, [null]) === '2026-10-01', 'a monthly plan: on its first day (its one slot)');
    const cs = REV.checkInSlots(q3, [null], '2026-11-10');
    ok(cs.length === 4 && cs.map((s) => s.name).join('|') === 'Oct 2026|Nov 2026|Dec 2026|Q3 2026-27' && cs.filter((s) => s.open).length === 3,
      'a check-in may be for any month of the period, or the whole period (the KPI\'s slot); open from the first day', JSON.stringify(cs.map((s) => `${s.name}:${s.open}`)));
  }

  /* ══ fixture ══════════════════════════════════════════════════════════════ */
  const Q = periodFor('QUARTERLY', settings.yearStartMonth, T);
  const PQ = periodFor('QUARTERLY', settings.yearStartMonth, shift(Q.start, -1));
  const D0 = shift(PQ.start, -60);
  const dept = async (name) => ins("INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, 'Department')", [COMPANY, `${TAG}${name}`, `${TAG} ${name}`]);
  const D = await dept('D');
  const roleOf = async (code, title) => ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status, performance_frequency) VALUES (?, ?, ?, 'For a test.', 'ACTIVE', 'QUARTERLY')", [COMPANY, `${TAG}${code}`, `${TAG} ${title}`]);
  const R = await roleOf('R', 'Supervisor');
  const RB = await roleOf('B', 'Incharge');
  const pos = async (code, roleId) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')", [COMPANY, `${TAG}-${code}`, roleId, `${TAG} ${code}`, D]);
  const P = { e: await pos('E', R), f: await pos('F', R), m: await pos('M', RB), dh: await pos('DH', RB), x: await pos('X', R) };
  const [[primary]] = await db.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
  for (const from of [P.e, P.f]) await POS.addPositionReporting(db, hr, from, { toPositionId: P.m, relationshipTypeId: primary.id, isPrimary: true, effectiveFrom: D0 });
  const emp = async (code) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, employment_type, employment_status) VALUES (?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE')",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, D0]);
  const seat = async (employeeId, positionId, roleId) => ins(
    "INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', ?)",
    [COMPANY, employeeId, roleId, positionId, D, D0]);
  const E = { e: await emp('E'), f: await emp('F'), m: await emp('M'), dh: await emp('DH'), x: await emp('X') };
  await seat(E.e, P.e, R); await seat(E.f, P.f, R); await seat(E.m, P.m, RB); await seat(E.dh, P.dh, RB); await seat(E.x, P.x, R);

  const kraQ = await J.createRoleKra(db, hr, R, { name: `${TAG} Quality` });
  await J.createRoleKra(db, hr, RB, { name: `${TAG} Running the team` });
  const kpiDef = async (text) => (await RC.createMasterItem(db, hr, 'kpis', { name: text, measurementType: 'TEXT', status: 'ACTIVE' })).id;
  const addJobKpi = async (text, target, kraRow, role = R) => RC.addContent(db, hr, role, 'kpis', { kpiDefinitionId: await kpiDef(text), roleKraAssignmentId: kraRow, targetOperator: 'EQ', targetValue: target });
  await addJobKpi(`${TAG} First pass yield`, '95%', kraQ.id);
  await addJobKpi(`${TAG} Output`, '12 count', null);
  await addJobKpi(`${TAG} Team attendance`, '98%', null, RB);
  for (const t of ['hrms_role_kra_assignments', 'hrms_role_kpi_assignments']) {
    await db.query(`UPDATE ${t} SET effective_from = ? WHERE company_id = ? AND role_id IN (?)`, [D0, COMPANY, [R, RB]]);
  }

  // 120 more people on the Supervisor role in another department, so the lists are a real size.
  const D2 = await dept('D2');
  const BULK = 120;
  await db.query(`INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status) VALUES ${Array.from({ length: BULK }, () => "(?, ?, ?, ?, ?, 'ACTIVE')").join(', ')}`,
    Array.from({ length: BULK }, (_, i) => [COMPANY, `${TAG}-B${i}`, R, `${TAG} B${i}`, D2]).flat());
  await db.query(`INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, employment_type, employment_status) VALUES ${Array.from({ length: BULK }, () => "(?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE')").join(', ')}`,
    Array.from({ length: BULK }, (_, i) => [COMPANY, `${TAG}B${i}`, `${TAG} Bulk ${i}`, D0]).flat());
  const bulkPos = await q('SELECT id, position_code FROM hrms_positions WHERE company_id = ? AND position_code LIKE ?', [COMPANY, `${TAG}-B%`]);
  const bulkEmp = new Map((await q('SELECT id, employee_code FROM hrms_employees WHERE company_id = ? AND employee_code LIKE ?', [COMPANY, `${TAG}B%`])).map((r) => [r.employee_code, r.id]));
  await db.query(`INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES ${bulkPos.map(() => "(?, ?, ?, ?, ?, 1, 'ACTIVE', ?)").join(', ')}`,
    bulkPos.flatMap((r) => [COMPANY, bulkEmp.get(r.position_code.replace(`${TAG}-B`, `${TAG}B`)), R, r.id, D2, D0]));

  // The previous quarter: plans for every quarterly person of the company, all made active.
  const prevMade = await PLAN.createPlans(db, hr, { frequency: 'QUARTERLY', start: PQ.start });
  const prevPeriodId = prevMade.period.id;
  const planIn = async (periodId, employeeId) => (await one("SELECT id FROM hrms_performance_plans WHERE company_id = ? AND employee_id = ? AND period_id = ? AND status <> 'CANCELLED'", [COMPANY, employeeId, periodId]))?.id;
  const prev = { e: await planIn(prevPeriodId, E.e), f: await planIn(prevPeriodId, E.f), m: await planIn(prevPeriodId, E.m), dh: await planIn(prevPeriodId, E.dh), x: await planIn(prevPeriodId, E.x) };
  const nearMissPrev = await PLAN.addKpi(db, hr, prev.e, { name: `${TAG} Near misses reported`, direction: 'HIGHER_BETTER', targetNumber: 6, unit: 'count', frequency: 'MONTHLY' });
  const kpiByName = (plan, name) => [...plan.kras.flatMap((k) => k.kpis), ...plan.ungroupedKpis].find((x) => x.name === `${TAG} ${name}`);

  /* ══ 2. FINAL reviews ══════════════════════════════════════════════════════ */
  section(`[2] FINAL reviews (${PQ.name} has ended; ${Q.name} holds today)`);
  let finalE;
  {
    await REV.ensureFinalReviews(db, hr, { planIds: [prev.e] });
    ok(!(await one("SELECT id FROM hrms_performance_reviews WHERE plan_id = ? AND kind = 'FINAL'", [prev.e])), 'a DRAFT plan gets no FINAL review, even when its period has ended');
    for (const id of [prev.e, prev.f, prev.m, prev.dh, prev.x]) await PLAN.activatePlan(db, hr, id);
    await db.query("UPDATE hrms_performance_plans SET status = 'ACTIVE', activated_at = NOW() WHERE company_id = ? AND period_id = ? AND status = 'DRAFT'", [COMPANY, prevPeriodId]);
    const activeCount = Number((await one("SELECT COUNT(*) AS n FROM hrms_performance_plans WHERE company_id = ? AND period_id = ? AND status = 'ACTIVE'", [COMPANY, prevPeriodId])).n);
    const box = counting();
    const made = await REV.ensureFinalReviews(box.db, hr);
    const finals = await q("SELECT r.* FROM hrms_performance_reviews r JOIN hrms_performance_plans pl ON pl.id = r.plan_id WHERE r.company_id = ? AND pl.period_id = ? AND r.kind = 'FINAL'", [COMPANY, prevPeriodId]);
    ok(made.created === activeCount && finals.length === activeCount && box.n === 5 && activeCount >= 100,
      `one FINAL per ACTIVE plan of ${PQ.name}: ${made.created} made in ${box.n} queries (one statement for all of them)`, `${made.created} ${finals.length} ${activeCount} ${box.n}`);
    finalE = finals.find((r) => r.plan_id === prev.e);
    ok(finalE && POS.dateText(finalE.due_date) === shift(PQ.end, 7) && finalE.status === 'OPEN' && finalE.opened_by === null && finalE.slot_start === null,
      `the FINAL is OPEN, made by the app, due on the period's end + 7 days (${POS.dateText(finalE?.due_date)})`);
    const audited = await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_performance_reviews' AND entity_id IN (?) AND action = 'CREATE'", [COMPANY, finals.map((r) => r.id)]);
    ok(Number(audited.n) === finals.length, 'each FINAL made is audited');
    const b2 = counting();
    const again = await REV.ensureFinalReviews(b2.db, hr);
    const twice = await one("SELECT COUNT(*) AS n FROM hrms_performance_reviews WHERE plan_id = ? AND kind = 'FINAL'", [prev.e]);
    ok(again.created === 0 && Number(twice.n) === 1 && b2.n === 1, `a second read makes nothing (idempotent) — one query (${b2.n})`);
    const dup = await caught(() => db.query("INSERT INTO hrms_performance_reviews (company_id, plan_id, kind, status, due_date) VALUES (?, ?, 'FINAL', 'OPEN', ?)", [COMPANY, prev.e, PQ.end]));
    ok(dup && /Duplicate/.test(dup.message), 'the database itself refuses a second live FINAL for a plan');
  }

  // This quarter: E and M active, F a draft.
  const curMade = await PLAN.createPlans(db, hr, { frequency: 'QUARTERLY', start: Q.start, employeeIds: [E.e, E.f, E.m, E.dh] });
  const curPeriodId = curMade.period.id;
  const cur = { e: await planIn(curPeriodId, E.e), f: await planIn(curPeriodId, E.f), m: await planIn(curPeriodId, E.m), dh: await planIn(curPeriodId, E.dh) };
  const nearMissCur = await PLAN.addKpi(db, hr, cur.e, { name: `${TAG} Near misses reported`, direction: 'HIGHER_BETTER', targetNumber: 6, unit: 'count', frequency: 'MONTHLY' });
  for (const id of [cur.e, cur.m, cur.dh]) await PLAN.activatePlan(db, hr, id);
  {
    const opens = REV.finalOpensOn(Q, ['MONTHLY', null]);
    await REV.ensureFinalReviews(db, hr);
    const curFinal = await one("SELECT id FROM hrms_performance_reviews WHERE plan_id = ? AND kind = 'FINAL'", [cur.e]);
    if (T < opens) ok(!curFinal, `not before: ${Q.name}'s last slot opens on ${opens}, so its ACTIVE plan has no FINAL yet`);
    else { ok(Boolean(curFinal), `${Q.name}'s last slot has opened (${opens}): its FINAL exists`); skip('FINAL not before', 'today is in the last month of the quarter'); }
    // The grace days: a FINAL made after the setting changes is due later; those already made keep their day.
    await db.query('UPDATE hrms_performance_settings SET review_grace_days = 10 WHERE company_id = ?', [COMPANY]);
    const extra = await emp('Y');
    const py = await pos('Y', R);
    await seat(extra, py, R);
    const yMade = await PLAN.createPlans(db, hr, { frequency: 'QUARTERLY', start: PQ.start, employeeIds: [extra] });
    await PLAN.activatePlan(db, hr, yMade.plans[0].id);
    await REV.ensureFinalReviews(db, hr);
    const yFinal = await one("SELECT due_date FROM hrms_performance_reviews WHERE plan_id = ? AND kind = 'FINAL'", [yMade.plans[0].id]);
    const eStill = await one('SELECT due_date FROM hrms_performance_reviews WHERE id = ?', [finalE.id]);
    ok(POS.dateText(yFinal?.due_date) === shift(PQ.end, 10) && POS.dateText(eStill.due_date) === shift(PQ.end, 7), 'grace days 10: a FINAL made now is due on end + 10; one already made keeps its day');
    await db.query('UPDATE hrms_performance_settings SET review_grace_days = 7 WHERE company_id = ?', [COMPANY]);
  }

  /* ══ 3. check-ins ══════════════════════════════════════════════════════════ */
  section('[3] Check-ins');
  let checkIn;
  {
    const months = slotsOf(Q, 'MONTHLY');
    const first = months[0];
    const future = months.find((s) => s.start > T);
    const opened = await REV.openCheckIn(db, hr, cur.e, { slotStart: first.start });
    checkIn = await one('SELECT * FROM hrms_performance_reviews WHERE id = ?', [opened.id]);
    ok(checkIn.kind === 'CHECK_IN' && POS.dateText(checkIn.slot_start) === first.start && POS.dateText(checkIn.due_date) === first.end && checkIn.slot_name === first.name && checkIn.opened_by === owner.id,
      `a check-in for ${first.name}: due on the slot's end (${first.end}), opened by the login`);
    const twice = await caught(() => REV.openCheckIn(db, hr, cur.e, { slotStart: first.start }));
    ok(twice?.code === 'ALREADY_OPEN', 'a second check-in for the same slot is refused', twice?.message);
    if (future) {
      const f = await caught(() => REV.openCheckIn(db, hr, cur.e, { slotStart: future.start }));
      ok(f?.code === 'FUTURE_SLOT' && /has not begun/.test(f.message), `a slot that has not begun (${future.name}) is refused`, f?.message);
    } else skip('future check-in', 'today is in the last month of the quarter');
    const notSlot = await caught(() => REV.openCheckIn(db, hr, cur.e, { slotStart: shift(Q.start, 3) }));
    ok(notSlot?.code === 'NOT_A_SLOT', 'a day that starts no slot is refused, naming the slots', notSlot?.message);
    const onDraft = await caught(() => REV.openCheckIn(db, hr, cur.f, { slotStart: first.start }));
    ok(onDraft?.code === 'NOT_ACTIVE' && /draft/.test(onDraft.message), 'no check-in on a DRAFT plan', onDraft?.message);
    const whole = await REV.openCheckIn(db, hr, cur.e, { slotStart: Q.start, slotEnd: Q.end });
    ok(whole.slot.name === Q.name, 'a check-in may also be for the whole period (the KPI\'s own slot)');
    await REV.cancelReview(db, hr, whole.id, { reason: 'opened by mistake' });
  }

  /* ══ 4. the KPI table equals scoring.js ════════════════════════════════════ */
  section('[4] A review\'s KPI table and plan score are scoring.js\'s numbers');
  {
    let p = await PLAN.readPlan(db, COMPANY, prev.e, {});
    const fpy = kpiByName(p, 'First pass yield');
    const out = kpiByName(p, 'Output');
    const pmonths = slotsOf(PQ, 'MONTHLY');
    await ACT.enterActuals(db, hr, [
      { planId: prev.e, kpiId: fpy.id, value: 90 },
      { planId: prev.e, kpiId: out.id, value: 10 },
      { planId: prev.e, kpiId: nearMissPrev.id, slotStart: pmonths[0].start, value: 1 },
      { planId: prev.e, kpiId: nearMissPrev.id, slotStart: pmonths[1].start, value: 3 },
    ]);
    p = await PLAN.readPlan(db, COMPANY, prev.e, {});
    const view = await REV.readReview(db, COMPANY, finalE.id, 'MANAGE', { edit: true });
    const planKpis = [...p.kras.flatMap((k) => k.kpis), ...p.ungroupedKpis];
    const same = view.kpis.length === planKpis.length && view.kpis.every((row) => {
      const k = planKpis.find((x) => x.id === row.kpiId);
      return k && k.actuals.achievement === row.achievement && k.actuals.band === row.band && k.actuals.combined === row.actual && k.actuals.combinedTarget === row.combinedTarget;
    });
    ok(same && view.planScore.score === p.plan.score && view.planScore.band === p.plan.band && view.planScore.basedOn.counted === p.plan.basedOn.counted,
      `FINAL: every KPI's actual, achievement and band, and the plan score (${view.planScore.score}%), are the plan page's`, JSON.stringify(view.kpis.map((r) => [r.name, r.achievement])));
    // …and the plan page's are scoring.js's own, from the rows.
    const parts = await ACT.loadPlanParts(db, COMPANY, [prev.e]);
    const period = { name: PQ.name, frequency: 'QUARTERLY', start: PQ.start, end: PQ.end };
    const direct = scorePlan({
      kras: (parts.kras.get(prev.e) ?? []).map((k) => ({ id: k.id, weightPercent: k.weight_percent == null ? null : Number(k.weight_percent) })),
      kpis: (parts.kpis.get(prev.e) ?? []).map((k) => ACT.scoringKpi(k, period)),
    }, new Map((parts.kpis.get(prev.e) ?? []).map((k) => [Number(k.id), (parts.actuals.get(Number(k.id)) ?? []).map(ACT.scoringActual)])), settings.bands);
    ok(direct.score === view.planScore.score && view.kpis.every((row) => direct.kpis.get(row.kpiId).achievement === row.achievement),
      `and scorePlan() on the stored rows gives the same (${direct.score}%)`);
    const nm = view.kpis.find((r) => r.kpiId === nearMissPrev.id);
    ok(nm.actual === 4 && nm.combinedTarget === 4 && nm.achievement === 100 && nm.scope === 'PERIOD', 'a monthly KPI on a FINAL: the period\'s slots added up (1 + 3 of a pro-rata 4) → 100%', JSON.stringify(nm));

    // A check-in: the slot's own actuals, through the same kpiResult().
    const cp = await PLAN.readPlan(db, COMPANY, cur.e, {});
    const cfpy = kpiByName(cp, 'First pass yield');
    const month = slotsOf(Q, 'MONTHLY')[0];
    await ACT.enterActuals(db, hr, [{ planId: cur.e, kpiId: nearMissCur.id, slotStart: month.start, value: 1 }, { planId: cur.e, kpiId: cfpy.id, value: 96 }]);
    const cv = await REV.readReview(db, COMPANY, checkIn.id, 'MANAGE', { edit: true });
    const cnm = cv.kpis.find((r) => r.kpiId === nearMissCur.id);
    const expected = kpiResult({ direction: 'HIGHER_BETTER', targetNumber: 6, unit: 'count', combine: 'SUM', slotCount: 3 }, [{ slotStart: month.start, valueNumber: 1 }]);
    const cfRow = cv.kpis.find((r) => r.kpiId === cfpy.id);
    const cpAfter = await PLAN.readPlan(db, COMPANY, cur.e, {});
    ok(cnm.scope === 'SLOT' && cnm.achievement === expected.achievement && cnm.actual === 1 && cfRow.scope === 'PERIOD' && cfRow.achievement === kpiByName(cpAfter, 'First pass yield').actuals.achievement
      && cv.planScore.score === cpAfter.plan.score,
    `CHECK-IN for ${month.name}: the monthly KPI is that month's (${cnm.achievement}% = kpiResult's), a KPI entered once per period shows the period so far; the plan score is the plan page's`, JSON.stringify([cnm, cfRow.achievement]));
  }

  /* ══ logins and the in-process server ════════════════════════════════════ */
  await setupAccess(db, COMPANY, { apply: true });
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
    HRX: await login('HR executive', roleByKey.HR_EXECUTIVE),
    HRM: await login('HR manager', roleByKey.HR_MANAGER),
    EMP: await login('Employee', roleByKey.EMPLOYEE, E.e),
    EMPF: await login('Employee F', roleByKey.EMPLOYEE, E.f),
    MGR: await login('Manager', roleByKey.EMPLOYEE, E.m),
    DH: await login('Department head', roleByKey.DEPARTMENT_HEAD, E.dh),
  };
  let THEM = null;
  if (other) {
    const theirAdmin = await one("SELECT u.id, u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1", [other.id]);
    if (theirAdmin) {
      await db.query('INSERT IGNORE INTO app_user_access (user_id, app_id, role_id, company_id) SELECT ?, ?, role_id, ? FROM users WHERE id = ?', [theirAdmin.id, other.app_id, other.id, theirAdmin.id]);
      THEM = { id: theirAdmin.id, token: signToken({ id: theirAdmin.id, name: theirAdmin.name, email: theirAdmin.email, role: 'admin', company: other.slug, companyId: other.id, company_id: other.id, uiPermissions: [] }) };
    }
  }
  forgetAccess();
  server = express();
  server.use(express.json({ limit: '20mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const call = async (who, method, url, body, { as = company.slug } = {}) => {
    const res = await fetch(`${base}/${as}/cf_hrms${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const must = async (who, method, url, body) => {
    const r = await call(who, method, url, body);
    if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const finalOf = async (planId) => (await one("SELECT id FROM hrms_performance_reviews WHERE plan_id = ? AND kind = 'FINAL'", [planId]))?.id;
  const finalF = await finalOf(prev.f);
  const finalM = await finalOf(prev.m);
  const finalX = await finalOf(prev.x);

  /* ══ 5. the status flow, who writes what ════════════════════════════════════ */
  section('[5] The person\'s part, the manager\'s part, the rating, DONE');
  {
    // The person.
    const mine = await must(U.EMP, 'GET', '/user/me/reviews');
    ok(mine.linked && mine.reviews.some((r) => r.id === finalE.id && r.can.writeOwn) && mine.reviews.some((r) => r.id === checkIn.id) && !mine.reviews.some((r) => r.employeeId !== E.e),
      'GET /user/me/reviews: my FINAL and my check-in — nobody else\'s');
    const page = await must(U.EMP, 'GET', `/user/me/reviews/${finalE.id}`);
    ok(page.review.can.writeOwn && !page.review.can.writeManager && !page.review.can.close && page.kpis.length > 0 && page.planScore.score != null, 'my review page: the KPI table and score, read-only; I may write my part only');
    const w1 = await call(U.EMP, 'PUT', `/user/me/reviews/${finalE.id}`, { employeeComment: 'Yield improved after the new die.', blockers: 'Need a second gauge.' });
    const row1 = await one('SELECT employee_comment, blockers, status FROM hrms_performance_reviews WHERE id = ?', [finalE.id]);
    ok(w1.status === 200 && row1.employee_comment === 'Yield improved after the new die.' && row1.blockers === 'Need a second gauge.' && row1.status === 'OPEN', 'the person writes their comment and blockers on their OPEN review');
    const bad = await Promise.all([
      call(U.EMP, 'PUT', `/user/me/reviews/${finalE.id}`, { managerComment: 'Great work' }),
      call(U.EMP, 'PUT', `/user/me/reviews/${finalE.id}`, { rating: 5 }),
      call(U.EMP, 'PUT', `/user/me/reviews/${finalE.id}`, { employeeComment: 'x', status: 'DONE' }),
      call(U.EMP, 'PUT', `/user/me/reviews/${finalE.id}`, { dueDate: '2030-01-01' }),
    ]);
    ok(bad.every((r) => r.status === 422 && r.json?.code === 'FIELD_NOT_ALLOWED') && (await one('SELECT manager_comment, rating_value FROM hrms_performance_reviews WHERE id = ?', [finalE.id])).manager_comment === null,
      'every other field is refused by name — the manager\'s comment, the rating, the status, the due date — and nothing is written', bad.map((r) => `${r.status} ${r.json?.message}`).join(' | '));
    const notMine = await call(U.EMP, 'PUT', `/user/me/reviews/${finalF}`, { employeeComment: 'not mine' });
    const notMineRead = await call(U.EMP, 'GET', `/user/me/reviews/${finalF}`);
    ok(notMine.status === 404 && notMineRead.status === 404, 'another person\'s review reads as not found, and cannot be written');
    const hrRoute = await call(U.EMP, 'PUT', `/performance/reviews/${finalE.id}`, { managerComment: 'x' });
    const teamRoute = await call(U.EMP, 'GET', '/user/me/team/reviews');
    ok(hrRoute.status === 403 && teamRoute.status === 200 && teamRoute.json.items.length === 0 && teamRoute.json.people === 0, 'the person cannot use the HR routes (403); with nobody below them, their team list is empty', `${hrRoute.status} ${teamRoute.status}`);
    const emptyDone = await call(U.EMPF, 'POST', `/user/me/reviews/${finalF}/done`);
    ok(emptyDone.status === 422 && emptyDone.json?.code === 'COMMENT_REQUIRED', '"my part is done" needs a comment first', emptyDone.json?.message);
    const done1 = await call(U.EMP, 'POST', `/user/me/reviews/${finalE.id}/done`);
    const after1 = await one('SELECT status, employee_done_by FROM hrms_performance_reviews WHERE id = ?', [finalE.id]);
    const late = await call(U.EMP, 'PUT', `/user/me/reviews/${finalE.id}`, { employeeComment: 'changed my mind' });
    ok(done1.status === 200 && after1.status === 'EMPLOYEE_DONE' && after1.employee_done_by === U.EMP.id && late.status === 409 && late.json?.code === 'NOT_OPEN',
      'OPEN → EMPLOYEE_DONE when the person is done; after that their part is locked (409)', late.json?.message);

    // A manager login.
    const team = await must(U.MGR, 'GET', '/user/me/team/reviews');
    const teamPeople = new Set(team.items.map((r) => r.employeeId));
    ok(teamPeople.has(E.e) && teamPeople.has(E.f) && !teamPeople.has(E.m) && !teamPeople.has(E.x) && team.people >= 2, 'manager login: the reviews of the people below them — not their own, not anyone else\'s', JSON.stringify([...teamPeople]));
    const mRead = await must(U.MGR, 'GET', `/user/me/team/reviews/${finalE.id}`);
    ok(mRead.review.can.writeManager && mRead.review.can.rate && mRead.review.can.close && !mRead.review.can.amend && mRead.ratingScale.length === settings.ratingScale.length,
      'manager login: may write the manager\'s part, rate and close; the company\'s rating scale comes with it');
    const mBad = await Promise.all([
      call(U.MGR, 'PUT', `/user/me/team/reviews/${finalE.id}`, { employeeComment: 'written for them' }),
      call(U.MGR, 'PUT', `/user/me/team/reviews/${finalE.id}`, { rating: 9 }),
      call(U.MGR, 'PUT', `/user/me/team/reviews/${checkIn.id}`, { rating: 3 }),
      call(U.MGR, 'PUT', `/user/me/team/reviews/${finalM}`, { managerComment: 'about myself' }),
      call(U.MGR, 'PUT', `/user/me/team/reviews/${finalX}`, { managerComment: 'not my team' }),
      call(U.MGR, 'PUT', `/performance/reviews/${finalE.id}`, { managerComment: 'HR route' }),
    ]);
    ok(mBad[0].status === 422 && mBad[0].json?.code === 'FIELD_NOT_ALLOWED' && mBad[1].status === 422 && /scale/.test(mBad[1].json?.message ?? '')
      && mBad[2].status === 422 && mBad[2].json?.code === 'NO_RATING' && mBad[3].status === 403 && mBad[3].json?.code === 'NOT_YOUR_TEAM' && mBad[4].status === 403 && mBad[5].status === 403,
    'manager login: not the person\'s fields, not a rating off the scale, no rating on a check-in, not their own review, not outside their team, not the HR route',
    mBad.map((r) => `${r.status} ${r.json?.code}`).join(' '));
    const noRating = await call(U.MGR, 'POST', `/user/me/team/reviews/${finalF}/close`, {});
    ok(noRating.status === 422 && noRating.json?.code === 'RATING_REQUIRED', 'a FINAL cannot be closed without its rating');
    const m1 = await call(U.MGR, 'PUT', `/user/me/team/reviews/${finalE.id}`, { managerComment: 'Good quarter; the gauge is ordered.', rating: 4 });
    const scale4 = settings.ratingScale.find((s) => Number(s.value) === 4);
    const r1 = await one('SELECT manager_comment, rating_value, rating_label FROM hrms_performance_reviews WHERE id = ?', [finalE.id]);
    ok(m1.status === 200 && r1.rating_value === 4 && r1.rating_label === scale4.label && r1.manager_comment === 'Good quarter; the gauge is ordered.',
      `the rating is a value of the company's scale; its label is kept beside it (4 — ${scale4.label})`);
    const closed = await call(U.MGR, 'POST', `/user/me/team/reviews/${finalE.id}/close`, {});
    const r2 = await one('SELECT status, closed_by FROM hrms_performance_reviews WHERE id = ?', [finalE.id]);
    ok(closed.status === 200 && r2.status === 'DONE' && r2.closed_by === U.MGR.id, 'EMPLOYEE_DONE → DONE when the manager closes it');
    const ciClose = await call(U.MGR, 'POST', `/user/me/team/reviews/${checkIn.id}/close`, { managerComment: 'On track for October.' });
    ok(ciClose.status === 200 && (await one('SELECT status FROM hrms_performance_reviews WHERE id = ?', [checkIn.id])).status === 'DONE', 'a check-in may be closed straight from OPEN, without a rating');

    // DONE is read-only — except the Owner, with a reason.
    const ro = await Promise.all([
      call(U.MGR, 'PUT', `/user/me/team/reviews/${finalE.id}`, { managerComment: 'later thought' }),
      call(U.HRM, 'PUT', `/performance/reviews/${finalE.id}`, { rating: 5, reason: 'HR manager' }),
      call(U.EMP, 'PUT', `/user/me/reviews/${finalE.id}`, { employeeComment: 'x' }),
      call(U.MGR, 'POST', `/user/me/team/reviews/${finalE.id}/close`, {}),
    ]);
    ok(ro[0].status === 409 && ro[0].json?.code === 'DONE' && ro[1].status === 409 && ro[2].status === 409 && ro[3].status === 409,
      'a DONE review is read-only: the manager, an HR manager, the person — each refused (409)', ro.map((r) => `${r.status} ${r.json?.code}`).join(' '));
    const noReason = await call(O, 'PUT', `/performance/reviews/${finalE.id}`, { rating: 5 });
    const amended = await call(O, 'PUT', `/performance/reviews/${finalE.id}`, { rating: 5, reason: 'Calibration meeting moved it up.' });
    const r3 = await one('SELECT status, rating_value, amended_by, amend_reason FROM hrms_performance_reviews WHERE id = ?', [finalE.id]);
    const au = await one("SELECT after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_performance_reviews' AND entity_id = ? ORDER BY id DESC LIMIT 1", [COMPANY, finalE.id]);
    ok(noReason.status === 422 && noReason.json?.code === 'REASON_REQUIRED' && amended.status === 200 && r3.status === 'DONE' && r3.rating_value === 5 && r3.amended_by === owner.id
      && r3.amend_reason === 'Calibration meeting moved it up.' && /Calibration/.test(JSON.stringify(au?.after_json)),
    'the Owner may change a DONE review — only with a reason; it stays DONE, says who and why, and is audited', `${noReason.status} ${amended.status}`);
    const ownerEmp = await call(O, 'PUT', `/performance/reviews/${finalE.id}`, { employeeComment: 'x', reason: 'y' });
    ok(ownerEmp.status === 422 && ownerEmp.json?.code === 'FIELD_NOT_ALLOWED', 'not even the Owner writes the person\'s own words');

    // Cancel a check-in; a FINAL goes only with its plan.
    const ci2 = await must(O, 'POST', `/performance/plans/${cur.m}/check-ins`, { slotStart: Q.start, slotEnd: slotsOf(Q, 'MONTHLY')[0].end });
    const hxCancel = await call(U.HRX, 'POST', `/performance/reviews/${ci2.id}/cancel`, {});
    const hmCancel = await call(U.HRM, 'POST', `/performance/reviews/${ci2.id}/cancel`, { reason: 'Not needed' });
    const finalCancel = await call(U.HRM, 'POST', `/performance/reviews/${finalF}/cancel`, {});
    ok(hxCancel.status === 403 && hmCancel.status === 200 && (await one('SELECT status, cancel_reason FROM hrms_performance_reviews WHERE id = ?', [ci2.id])).status === 'CANCELLED'
      && finalCancel.status === 409 && finalCancel.json?.code === 'FINAL_STAYS',
    'cancelling a check-in needs performance remove (HR executive 403, HR manager 200); a FINAL cannot be cancelled on its own', `${hxCancel.status} ${hmCancel.status} ${finalCancel.status}`);
    const again = await must(O, 'POST', `/performance/plans/${cur.m}/check-ins`, { slotStart: Q.start, slotEnd: slotsOf(Q, 'MONTHLY')[0].end });
    ok(again.id > 0, 'a cancelled check-in frees its slot for a new one');
    await PLAN.cancelPlan(db, hr, prev.dh, { reason: 'test' });
    const dhFinal = await one("SELECT status, cancel_reason FROM hrms_performance_reviews WHERE plan_id = ? AND kind = 'FINAL'", [prev.dh]);
    ok(dhFinal.status === 'CANCELLED' && /plan was cancelled/.test(dhFinal.cancel_reason), 'cancelling a plan cancels its reviews that are not done');
  }

  /* ══ 6. actions ════════════════════════════════════════════════════════════ */
  section('[6] Action items');
  let actE;
  let actM;
  {
    const due = shift(T, 14);
    const onDone = await call(O, 'POST', `/performance/plans/${prev.e}/actions`, { text: 'Calibrate the gauge', ownerEmployeeId: E.e, dueDate: due, reviewId: finalE.id });
    ok(onDone.status === 409 && onDone.json?.code === 'DONE', 'a DONE review takes no new action (raise it on the plan)', onDone.json?.message);
    const pr = await must(O, 'GET', `/performance/plans/${prev.f}/reviews`);
    ok(pr.owners.some((o) => o.employeeId === E.f && o.relation === 'PERSON') && pr.owners.some((o) => o.employeeId === E.m && o.relation === 'MANAGER') && pr.reviews.some((r) => r.kind === 'FINAL'),
      'the plan\'s reviews and actions: the owners on offer are the person and whoever holds their manager\'s position', JSON.stringify(pr.owners));
    const a1 = await must(O, 'POST', `/performance/plans/${prev.f}/actions`, { text: 'Finish the 5S audit', ownerEmployeeId: E.f, dueDate: due, reviewId: finalF });
    const a2 = await must(O, 'POST', `/performance/plans/${prev.f}/actions`, { text: 'Arrange the training', ownerEmployeeId: E.m, dueDate: due });
    const a3 = await must(U.MGR, 'POST', `/user/me/team/plans/${prev.e}/actions`, { text: 'Second gauge on the line', ownerEmployeeId: E.e, dueDate: due });
    actE = a3.id; actM = a2.id;
    const rows = await q('SELECT * FROM hrms_performance_actions WHERE id IN (?) ORDER BY id', [[a1.id, a2.id, a3.id]]);
    ok(rows.length === 3 && rows[0].review_id === finalF && rows[1].review_id === null && rows[1].owner_employee_id === E.m && rows[2].created_by === U.MGR.id && rows.every((r) => r.status === 'OPEN'),
      'actions raised on a review and on the plan directly; owned by the person or the manager; a manager login raises them for their team');
    const badOwner = await call(O, 'POST', `/performance/plans/${prev.f}/actions`, { text: 'x', ownerEmployeeId: E.x, dueDate: due });
    const pastDue = await call(O, 'POST', `/performance/plans/${prev.f}/actions`, { text: 'x', ownerEmployeeId: E.f, dueDate: shift(T, -1) });
    const noText = await call(O, 'POST', `/performance/plans/${prev.f}/actions`, { ownerEmployeeId: E.f, dueDate: due });
    const mOwn = await call(U.MGR, 'POST', `/user/me/team/plans/${prev.m}/actions`, { text: 'x', ownerEmployeeId: E.m, dueDate: due });
    ok(badOwner.status === 422 && badOwner.json?.code === 'NOT_AN_OWNER' && pastDue.status === 422 && noText.status === 422 && mOwn.status === 403,
      'refused: an owner who is neither the person nor their manager; a due date that has passed; no text; a manager on their own plan', `${badOwner.status} ${pastDue.status} ${noText.status} ${mOwn.status}`);

    // Overdue: OPEN and the due date passed.
    await db.query('UPDATE hrms_performance_actions SET due_date = ? WHERE id = ?', [shift(T, -3), a1.id]);
    const list = await must(O, 'GET', '/performance/actions');
    const first = list.items[0];
    ok(first.id === a1.id && first.overdue && first.daysOverdue === 3 && list.items.every((x) => x.status === 'OPEN'), 'the Actions list: open ones, overdue first (3 days overdue)', JSON.stringify(first && { id: first.id, o: first.overdue }));
    const od = await must(O, 'GET', '/performance/actions?overdue=1');
    ok(od.items.length >= 1 && od.items.every((x) => x.overdue), 'filter: only overdue');
    const byOwner = await must(O, 'GET', `/performance/actions?owner=${E.m}`);
    ok(byOwner.items.length >= 1 && byOwner.items.every((x) => x.ownerEmployeeId === E.m), 'filter: by owner');

    // The person marks their own done — and only their own.
    const eMine = await must(U.EMP, 'GET', '/user/me/reviews');
    ok(eMine.actions.some((x) => x.id === a3.id) && !eMine.actions.some((x) => x.id === a2.id), 'My actions: the actions I own');
    const notOwn = await call(U.EMPF, 'POST', `/user/me/actions/${a2.id}/done`, {});
    const extra = await call(U.EMPF, 'POST', `/user/me/actions/${a1.id}/done`, { status: 'DROPPED' });
    const viaHr = await call(U.EMPF, 'POST', `/performance/actions/${a1.id}/done`, {});
    const fDone = await call(U.EMPF, 'POST', `/user/me/actions/${a1.id}/done`, { note: 'Audit done, report filed.' });
    const fRow = await one('SELECT status, done_on, note, closed_by FROM hrms_performance_actions WHERE id = ?', [a1.id]);
    const twice = await call(U.EMPF, 'POST', `/user/me/actions/${a1.id}/done`, {});
    ok(notOwn.status === 404 && extra.status === 422 && viaHr.status === 403 && fDone.status === 200 && fRow.status === 'DONE' && POS.dateText(fRow.done_on) === T
      && fRow.note === 'Audit done, report filed.' && fRow.closed_by === U.EMPF.id && twice.status === 409,
    'the person marks their own action done (today, with a note); not somebody else\'s (404), nothing but a note, not through HR\'s route, not twice',
    `${notOwn.status} ${extra.status} ${viaHr.status} ${fDone.status} ${twice.status}`);
    const changeDone = await call(O, 'PUT', `/performance/actions/${a1.id}`, { text: 'reworded' });
    ok(changeDone.status === 409, 'a done action is kept as it was');
    const ch = await call(U.MGR, 'PUT', `/user/me/team/actions/${a3.id}`, { dueDate: shift(T, 21), text: 'Second gauge on line 2' });
    ok(ch.status === 200 && (await one('SELECT action_text FROM hrms_performance_actions WHERE id = ?', [a3.id])).action_text === 'Second gauge on line 2', 'a manager login changes an open action of their team');
    const dropNoNote = await call(U.HRX, 'POST', `/performance/actions/${a2.id}/drop`, {});
    const drop = await call(U.HRX, 'POST', `/performance/actions/${a2.id}/drop`, { note: 'Training moved to next quarter' });
    ok(dropNoNote.status === 422 && drop.status === 200 && (await one('SELECT status, done_on FROM hrms_performance_actions WHERE id = ?', [a2.id])).status === 'DROPPED',
      'dropping an action needs a word why; then it is DROPPED (kept)');
    const all = await must(O, 'GET', '/performance/actions?status=all');
    ok(all.items.some((x) => x.status === 'DONE') && all.items.some((x) => x.status === 'DROPPED'), 'status=all lists done and dropped ones too');
    const auditN = await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_performance_actions' AND entity_id IN (?)", [COMPANY, [a1.id, a2.id, a3.id]]);
    ok(Number(auditN.n) >= 6, `every action write is audited (${auditN.n} rows)`);
  }

  /* ══ 7. rights and scope ════════════════════════════════════════════════════ */
  section('[7] Rights and scope');
  {
    const hx = await call(U.HRX, 'GET', '/performance/reviews');
    const hxW = await call(U.HRX, 'PUT', `/performance/reviews/${finalF}`, { managerComment: 'HR executive wrote this' });
    ok(hx.status === 200 && hx.json.items.length > 0 && hxW.status === 200, 'HR executive (performance view + edit): reads the list, writes the manager\'s part');
    const dh = await call(U.DH, 'GET', '/performance/reviews');
    const outside = finalX ? null : null;
    const outsideReview = (await q('SELECT r.id FROM hrms_performance_reviews r JOIN hrms_performance_plans pl ON pl.id = r.plan_id WHERE r.company_id = ? AND pl.department_id <> ? LIMIT 1', [COMPANY, D]))[0];
    const dhOut = outsideReview ? await call(U.DH, 'GET', `/performance/reviews/${outsideReview.id}`) : { status: 403, json: { code: 'OUT_OF_SCOPE' } };
    const dhIn = await call(U.DH, 'PUT', `/performance/reviews/${finalF}`, { managerComment: 'Department head' });
    const dhAct = await call(U.DH, 'GET', '/performance/actions?status=all');
    ok(dh.status === 200 && dh.json.items.length > 0 && dh.json.items.every((r) => r.departmentId === D) && dhOut.status === 403 && dhOut.json?.code === 'OUT_OF_SCOPE' && dhIn.status === 200
      && dhAct.json.items.every((x) => x.departmentId === D),
    'Department head: reviews and actions of their own department only; 403 OUT_OF_SCOPE outside; writes inside', `${dh.status} ${dhOut.status} ${dhIn.status}`);
    void outside;
    const emp = await Promise.all([call(U.EMP, 'GET', '/performance/reviews'), call(U.EMP, 'GET', '/performance/actions'), call(U.EMP, 'GET', `/performance/reviews/${finalE.id}`)]);
    ok(emp.every((r) => r.status === 403), 'Employee: no Reviews or Actions screen (403)');
    const sum = await must(O, 'GET', `/performance/employees/${E.e}/review-summary`);
    ok(sum.latestRating?.value === 5 && sum.latestRating.label === settings.ratingScale.find((s) => Number(s.value) === 5).label && sum.openActions === 1,
      'the chart panel: the latest rating (5, after the Owner\'s change) and the open actions count', JSON.stringify(sum));
    const sumEmp = await call(U.EMP, 'GET', `/performance/employees/${E.e}/review-summary`);
    const sumDh = outsideReview ? await call(U.DH, 'GET', `/performance/employees/${(await one('SELECT pl.employee_id FROM hrms_performance_reviews r JOIN hrms_performance_plans pl ON pl.id = r.plan_id WHERE r.id = ?', [outsideReview.id])).employee_id}/review-summary`) : { status: 403 };
    ok(sumEmp.status === 403 && sumDh.status === 403, 'the summary needs performance view, and the scope');
    const mgrPlan = await must(U.MGR, 'GET', `/user/me/team/plans/${cur.e}/reviews`);
    ok(mgrPlan.can.openCheckIn && mgrPlan.reviews.some((r) => r.id === checkIn.id), 'manager login: a team plan\'s reviews and actions, and may open a check-in');
    const mgrCheck = await call(U.MGR, 'POST', `/user/me/team/plans/${cur.m}/check-ins`, { slotStart: Q.start });
    ok(mgrCheck.status === 403, 'manager login: no check-in on their own plan');
  }

  /* ══ 8. the number of queries ═════════════════════════════════════════════ */
  section('[8] The number of queries');
  {
    const total = Number((await one('SELECT COUNT(*) AS n FROM hrms_performance_reviews WHERE company_id = ?', [COMPANY])).n);
    // A realistic Actions list: an open action on every plan of the previous quarter.
    const plansPrev = await q("SELECT id, employee_id FROM hrms_performance_plans WHERE company_id = ? AND period_id = ? AND status = 'ACTIVE'", [COMPANY, prevPeriodId]);
    await db.query(`INSERT INTO hrms_performance_actions (company_id, plan_id, owner_employee_id, action_text, due_date, created_by) VALUES ${plansPrev.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      plansPrev.flatMap((p, i) => [COMPANY, p.id, p.employee_id, `${TAG} follow-up ${i}`, shift(T, (i % 20) - 10), owner.id]));
    const lb = counting();
    let t0 = Date.now();
    const list = await REV.listReviews(lb.db, hr, {});
    const listMs = Date.now() - t0;
    const ab = counting();
    t0 = Date.now();
    const acts = await REV.listActions(ab.db, hr, {});
    const actMs = Date.now() - t0;
    const rb = counting();
    await REV.readReview(rb.db, COMPANY, finalF, 'MANAGE', { edit: true });
    const pb = counting();
    await REV.planReviews(pb.db, hr, prev.f, 'MANAGE', { edit: true });
    const mb = counting();
    await REV.myReviews(mb.db, { companyId: COMPANY, userId: U.EMP.id });
    const sb = counting();
    await REV.reviewSummary(sb.db, COMPANY, E.e);
    note(`Reviews list: ${list.items.length} reviews (of ${total}) in ${lb.n} queries, ${listMs} ms locally ≈ ${lb.n * 49} ms of round trips on production`);
    note(`Actions list: ${acts.items.length} actions in ${ab.n} queries, ${actMs} ms locally`);
    note(`review page ${rb.n} · plan's reviews ${pb.n} · My reviews ${mb.n} · chart summary ${sb.n} queries`);
    ok(lb.n === 2 && list.items.length >= 100, `the Reviews list is a fixed handful of queries (${lb.n}) for ${list.items.length} reviews — no query per row`);
    ok(ab.n === 1 && acts.items.length >= plansPrev.length, `the Actions list is one query (${ab.n}) for ${acts.items.length} actions`);
    ok(rb.n <= 6 && pb.n <= 7 && mb.n <= 6 && sb.n === 3, `the review page (${rb.n}), a plan's reviews (${pb.n}), My reviews (${mb.n}) and the chart summary (${sb.n}) are fixed too`);
    const { n: httpN, r: httpList } = await countPool(() => must(O, 'GET', `/performance/reviews?department=${D}&state=DUE,OVERDUE`));
    ok(httpList.items.every((r) => r.departmentId === D && ['DUE', 'OVERDUE'].includes(r.state)) && httpList.total >= httpList.count, `GET /performance/reviews over HTTP, filtered: ${httpN} queries in all (the access check included)`);
    note(`GET /performance/reviews with filters: ${httpN} queries through the route (access check, the list, the department tree)`);
  }

  /* ══ 9. tenant isolation ════════════════════════════════════════════════════ */
  section('[9] Tenant isolation');
  if (!THEM) skip('tenant isolation', 'no second company with an admin login');
  else {
    const as = { as: other.slug };
    const t = await Promise.all([
      call(THEM, 'GET', `/performance/reviews/${finalF}`, undefined, as),
      call(THEM, 'PUT', `/performance/reviews/${finalF}`, { managerComment: 'from elsewhere' }, as),
      call(THEM, 'POST', `/performance/reviews/${finalF}/close`, { rating: 1 }, as),
      call(THEM, 'POST', `/performance/plans/${cur.e}/check-ins`, { slotStart: Q.start }, as),
      call(THEM, 'POST', `/performance/plans/${cur.e}/actions`, { text: 'x', ownerEmployeeId: E.e, dueDate: shift(T, 5) }, as),
      call(THEM, 'POST', `/performance/actions/${actE}/done`, {}, as),
      call(THEM, 'GET', `/performance/plans/${prev.e}/reviews`, undefined, as),
      call(THEM, 'GET', `/performance/employees/${E.e}/review-summary`, undefined, as),
    ]);
    const lists = await Promise.all([call(THEM, 'GET', '/performance/reviews', undefined, as), call(THEM, 'GET', '/performance/actions?status=all', undefined, as)]);
    ok(t.every((r) => r.status === 404) && lists.every((r) => r.status === 200 && !r.json.items.some((x) => x.employeeId === E.e || x.employeeId === E.f)),
      'another company: cannot read, write, close, open a check-in, raise or close an action on ours; our reviews and actions are not in its lists', t.map((r) => r.status).join(' '));
    const still = await one('SELECT status, manager_comment FROM hrms_performance_reviews WHERE id = ?', [finalF]);
    ok(still.status === 'OPEN' && still.manager_comment === 'Department head', 'and ours is unchanged');
    void actM;
  }
} finally {
  if (server?.close) await server.close();
  try { await db.rollback(); } catch { /* nothing to undo */ }
  db.release();
  pool.query = real.query;
  pool.execute = real.execute;
  pool.getConnection = real.getConnection;
  forgetAccess();
}

section('[end] Nothing is left behind');
{
  const after = await worldCount();
  const moved = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok(moved.length === 0, `every count is what it was (${TABLES.length} tables and the grace days)`, moved.map((k) => `${k} ${String(before[k]).slice(0, 40)} -> ${String(after[k]).slice(0, 40)}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
