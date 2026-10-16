/**
 * actuals_test.mjs — actuals against performance plans (TM/CF_HRMS_HIRING_SPEC.md §19, 2026-10-15).
 *
 *   0. the schema (apply-actuals-schema.mjs): a second run plans nothing; the
 *      combine-rule backfill fills only what is empty;
 *   1. slots — a monthly KPI in a quarterly plan = 3 slots; once per plan = 1;
 *      a quarterly KPI in a monthly plan = 1; weeks; days;
 *   2. the formulas — achievement per direction incl. zero actuals and words
 *      (met / not met / no answer), the cap, the combine rules, KRA and plan
 *      scores with and without weights, "based on N of M", bands;
 *   3. entering — a future slot refused, enter, correct with a reason (history
 *      kept, one live row), a note alone, never cleared, the wrong kind refused;
 *   4. only ACTIVE plans; a closed period is read only;
 *   5. the plan page, the Plans list's Score column and band filter, bands from
 *      settings, the org chart's bands; the number of queries;
 *   6. rights and scope — HR executive, Employee (My plan, read only), a
 *      Department head scoped to one department, a manager login over the
 *      people below them;
 *   7. Excel round trip — download, a value, a correction without and with a
 *      reason, a row added, a stale file;
 *   8. tenant isolation; and nothing is left behind.
 *
 *   node scripts/cf_hrms/actuals_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: the whole run is ONE connection inside ONE
 * transaction (pool.query / getConnection point at it; a route's own
 * transaction is a savepoint), rolled back at the end. Local only.
 * The plans it makes, it makes inside that transaction.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
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
import {
  achievementOf, kpiResult, scorePlan, bandOf, defaultCombine,
} from '../../apps/cf_hrms/services/performance/scoring.js';
import * as PLAN from '../../apps/cf_hrms/services/performance/planService.js';
import * as ACT from '../../apps/cf_hrms/services/performance/actualsService.js';
import { readSettings } from '../../apps/cf_hrms/services/performance/settingsService.js';
import { schemaSteps, backfillPlan, backfill } from '../../apps/cf_hrms/scripts/apply-actuals-schema.mjs';

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
const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.051;

// Counted before and after. Not hrms_role_kpi_assignments or hrms_audit_log: other work may write those while this runs.
const TABLES = ['hrms_performance_settings', 'hrms_performance_periods', 'hrms_performance_plans', 'hrms_performance_plan_kras', 'hrms_performance_plan_kpis',
  'hrms_performance_target_changes', 'hrms_performance_actuals', 'hrms_roles', 'hrms_positions', 'hrms_employees', 'hrms_work_assignments', 'users', 'app_user_access'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM ${t}`);
      out[t] = `${r.n}/${r.live}`;
    }
    const [[s]] = await conn.query('SELECT GROUP_CONCAT(CONCAT(company_id, \':\', band_on_track, \'/\', band_at_risk)) AS s FROM hrms_performance_settings');
    out.bands = s.s;
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
let tally = null;   // when set, every query through the pool or a route's transaction is counted
const inside = {
  query: (...a) => { if (tally) tally.n += 1; return db.query(...a); },
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_ac_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_ac_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_ac_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

/** The same connection, counting round trips. */
const counting = () => {
  const box = { n: 0 };
  box.db = new Proxy(db, { get(t, p) { if (p === 'query') return (...a) => { box.n += 1; return t.query(...a); }; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
  return box;
};
/** Count the queries the HTTP layer makes (the pool and a route's transaction), for one call — the access check included. */
const countPool = async (fn) => {
  tally = { n: 0 };
  try { const r = await fn(); return { n: tally.n, r }; } finally { tally = null; }
};

const TAG = `ZZAC${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

/* ── editing a workbook the way a person does ─────────────────────────────── */
async function openBook(base64) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, 'base64'));
  const ws = wb.getWorksheet('Data');
  const head = new Map();
  ws.getRow(1).eachCell((cell, col) => head.set(String(cell.value).replace(/\s*★\s*$/, ''), col));
  const text = (cell) => { const v = cell.value; return v == null ? '' : String(v.richText ? v.richText.map((p) => p.text).join('') : v); };
  return {
    ws,
    col: (h) => { const col = head.get(h); if (!col) throw new Error(`no column "${h}"`); return col; },
    get(row, h) { return text(ws.getCell(row, this.col(h))); },
    set(row, h, value) { ws.getCell(row, this.col(h)).value = value; },
    find(pairs) {
      for (let r = 2; r <= ws.rowCount; r += 1) if (Object.entries(pairs).every(([h, needle]) => this.get(r, h).includes(needle))) return r;
      throw new Error(`no row with ${JSON.stringify(pairs)}`);
    },
    count() { let n = 0; for (let r = 2; r <= ws.rowCount; r += 1) if (text(ws.getCell(r, 1)) !== '') n += 1; return n; },
    async save() { return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'); },
  };
}

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
  console.log(`actuals_test — ${company.name} (${COMPANY}), run tag ${TAG}, today ${T}`);
  const karniPeriods = await one('SELECT COUNT(*) AS n FROM hrms_performance_periods WHERE company_id = ?', [COMPANY]);
  note(`${company.name} has ${karniPeriods.n} performance periods of its own before the run (the test makes its own inside its transaction)`);

  /* ══ 0. the schema ════════════════════════════════════════════════════════ */
  section('[0] The schema');
  ok((await schemaSteps(db)).length === 0, 'apply-actuals-schema: nothing left to do on this database (idempotent)');
  const cols = await q(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND ((TABLE_NAME = 'hrms_performance_actuals' AND COLUMN_NAME IN ('met', 'source', 'live_slot', 'corrects_id', 'correction_reason', 'closed_at'))
      OR (TABLE_NAME = 'hrms_performance_plan_kpis' AND COLUMN_NAME = 'combine_rule') OR (TABLE_NAME = 'hrms_performance_settings' AND COLUMN_NAME IN ('band_on_track', 'band_at_risk')))`);
  ok(cols.length === 9 && cols.filter((r) => ['met', 'source', 'combine_rule'].includes(r.c)).every((r) => r.d === 'varchar'), 'the actuals table, the combine rule and the two band thresholds are there; kinds are VARCHAR', JSON.stringify(cols));

  /* ══ 1. slots ═════════════════════════════════════════════════════════════ */
  section('[1] Slots');
  {
    const q3 = { name: 'Q3 2026-27', frequency: 'QUARTERLY', start: '2026-10-01', end: '2026-12-31' };
    const m = slotsOf(q3, 'MONTHLY');
    ok(m.length === 3 && m.map((s) => s.name).join('|') === 'Oct 2026|Nov 2026|Dec 2026' && m[1].start === '2026-11-01' && m[1].end === '2026-11-30', 'a monthly KPI in a quarterly plan has 3 slots: Oct, Nov, Dec 2026', JSON.stringify(m));
    const once = slotsOf(q3, null);
    ok(once.length === 1 && once[0].name === 'Q3 2026-27' && once[0].start === q3.start && once[0].end === q3.end && once[0].whole, 'a KPI entered once per plan has 1 slot: the period');
    ok(slotsOf(q3, 'QUARTERLY').length === 1 && slotsOf({ ...q3, frequency: 'MONTHLY', name: 'Oct 2026', end: '2026-10-31' }, 'QUARTERLY').length === 1, 'a slot is never longer than the plan: quarterly in a monthly plan = 1');
    const w = slotsOf({ name: 'Oct 2026', frequency: 'MONTHLY', start: '2026-10-01', end: '2026-10-31' }, 'WEEKLY');
    ok(w.length === 5 && w[0].start === '2026-10-01' && w[0].end === '2026-10-04' && w[1].start === '2026-10-05' && w[4].end === '2026-10-31', 'weeks run Monday to Sunday, cut to the period (Oct 2026: 5)', JSON.stringify(w.map((s) => `${s.start}..${s.end}`)));
    ok(slotsOf({ name: 'Oct 2026', frequency: 'MONTHLY', start: '2026-10-01', end: '2026-10-31' }, 'DAILY').length === 31, 'a daily KPI in October has 31 slots');
    const h = slotsOf({ name: '2026-27', frequency: 'YEARLY', start: '2026-04-01', end: '2027-03-31' }, 'QUARTERLY');
    ok(h.length === 4 && h[3].start === '2027-01-01' && h[3].end === '2027-03-31', 'quarters of an April year in a yearly plan line up with the year');
  }

  /* ══ 2. the formulas ══════════════════════════════════════════════════════ */
  section('[2] Achievement, combining, scores, bands');
  {
    const cases = [
      ['HIGHER_BETTER', 90, 95, 94.7368], ['HIGHER_BETTER', 95, 95, 100], ['HIGHER_BETTER', 0, 95, 0], ['HIGHER_BETTER', 0, 0, 100], ['HIGHER_BETTER', 200, 100, 120],
      ['LOWER_BETTER', 40, 30, 75], ['LOWER_BETTER', 20, 30, 120], ['LOWER_BETTER', 0, 30, 100], ['LOWER_BETTER', 0, 0, 100], ['LOWER_BETTER', 3, 0, 0],
      ['EXACT', 0, 0, 100], ['EXACT', 1, 0, 0], ['EXACT', 5, 5, 100], ['HIGHER_BETTER', -5, 10, 0],
    ];
    const wrong = cases.filter(([d, a, t, want]) => Math.abs(achievementOf(d, a, t) - want) > 0.001).map(([d, a, t, want]) => `${d} ${a}/${t} -> ${achievementOf(d, a, t)} (want ${want})`);
    ok(wrong.length === 0, `${cases.length} cases: higher = actual ÷ target, lower = target ÷ actual (0 actual = 100% when the target ≥ 0), exactly = 100 or 0, capped to 0–120`, wrong.join('; '));
    const text = (mets, combine = 'AVERAGE') => kpiResult({ direction: 'TEXT', combine, slotCount: mets.length }, mets.map((met, i) => ({ slotStart: `2026-1${i}-01`, met })));
    ok(text(['YES']).achievement === 100 && text(['NO']).achievement === 0 && text([null]).achievement === null && text([null]).counted === 0, 'words: met → 100, not met → 0, no answer → not counted');
    ok(near(text(['YES', 'NO', 'YES']).achievement, 66.7) && text(['YES', 'NO'], 'LAST').achievement === 0, 'words over slots: the share met (2 of 3 = 66.7%); "latest" takes the last answer');
    const k = (combine, values, target = 6, direction = 'HIGHER_BETTER', slotCount = 3) => kpiResult({ direction, targetNumber: target, combine, slotCount }, values.map((v, i) => ({ slotStart: `2026-1${i}-01`, valueNumber: v })));
    const sum1 = k('SUM', [2]);
    const sum2 = k('SUM', [2, 4]);
    ok(sum1.combined === 2 && sum1.combinedTarget === 2 && sum1.achievement === 100 && sum2.combined === 6 && sum2.combinedTarget === 4 && sum2.achievement === 120,
      'SUM adds the slots; the period target is taken pro rata to the slots entered (2 of a 6 quarter in 1 month = 100%; 6 in 2 months of a 4 = 150% → capped 120)', JSON.stringify([sum1, sum2]));
    const avg = k('AVERAGE', [90, 100], 95);
    const last = k('LAST', [80, 96], 95);
    ok(avg.combined === 95 && avg.achievement === 100 && last.combined === 96 && near(last.achievement, 101.1), 'AVERAGE takes the mean (90, 100 → 95 = 100%); LAST the latest slot (96 of 95 = 101.1%)');
    ok(k('SUM', []).achievement === null && k('SUM', []).counted === 0, 'a KPI with no actual is not counted');
    ok(defaultCombine('%', 'HIGHER_BETTER') === 'AVERAGE' && defaultCombine('minutes', 'LOWER_BETTER') === 'AVERAGE' && defaultCombine('hours') === 'AVERAGE' && defaultCombine('days') === 'AVERAGE'
      && defaultCombine('count') === 'SUM' && defaultCombine('MT') === 'SUM' && defaultCombine('m') === 'SUM' && defaultCombine('₹') === 'SUM' && defaultCombine(null, 'TEXT') === 'AVERAGE',
    'the combine rule from the unit: %, minutes, hours, days → average; counts, MT, m, ₹ → added up; words → average');

    const plan = {
      kras: [{ id: 1, weightPercent: 60 }, { id: 2, weightPercent: 40 }],
      kpis: [
        { id: 11, planKraId: 1, direction: 'HIGHER_BETTER', targetNumber: 95, combine: 'AVERAGE', slotCount: 1 },
        { id: 21, planKraId: 2, direction: 'LOWER_BETTER', targetNumber: 30, combine: 'AVERAGE', slotCount: 1 },
        { id: 22, planKraId: 2, direction: 'HIGHER_BETTER', targetNumber: 6, combine: 'SUM', slotCount: 3 },
        { id: 31, planKraId: null, direction: 'TEXT', combine: 'AVERAGE', slotCount: 1 },
        { id: 32, planKraId: null, direction: 'HIGHER_BETTER', targetNumber: 12, combine: 'SUM', slotCount: 1 },
      ],
    };
    const acts = new Map([[11, [{ slotStart: 'a', valueNumber: 90 }]], [21, [{ slotStart: 'a', valueNumber: 40 }]], [22, [{ slotStart: 'a', valueNumber: 2 }]], [31, [{ slotStart: 'a', met: 'YES' }]]]);
    const s = scorePlan(plan, acts);
    ok(s.kras.get(1).score === 94.7 && s.kras.get(2).score === 87.5 && s.ungrouped.score === 100, 'KRA score = the average of its KPIs (Quality 94.7; Safety (75 + 100) ÷ 2 = 87.5); KPIs under no KRA are one more heading', JSON.stringify([...s.kras.values()]));
    ok(s.score === 94.5 && s.basedOn.counted === 4 && s.basedOn.total === 5 && s.line === 'Based on 4 of 5 KPIs.' && s.band === 'ON_TRACK',
      'plan score = KRA weights 60/40, the loose heading as the average KRA (50): 94.5, "based on 4 of 5 KPIs", on track', `${s.score} ${s.line}`);
    const equal = scorePlan({ ...plan, kras: plan.kras.map((x) => ({ ...x, weightPercent: null })) }, acts);
    ok(near(equal.score, 94.1), 'no KRA weights: the headings count equally ((94.7 + 87.5 + 100) ÷ 3 = 94.1)', String(equal.score));
    const kpiW = scorePlan({ ...plan, kpis: plan.kpis.map((x) => (x.id === 21 ? { ...x, weightPercent: 75 } : x.id === 22 ? { ...x, weightPercent: 25 } : x)) }, acts);
    ok(kpiW.kras.get(2).score === 81.3, 'KPI weights within a KRA (75 / 25): Safety = 75 × 0.75 + 100 × 0.25 = 81.25 → 81.3', String(kpiW.kras.get(2).score));
    const none = scorePlan(plan, new Map());
    ok(none.score === null && none.band === 'NO_DATA' && none.line === 'No actuals yet.', 'nothing entered: no score, "No data"');
    ok(bandOf(90) === 'ON_TRACK' && bandOf(89.9) === 'AT_RISK' && bandOf(70) === 'AT_RISK' && bandOf(69.9) === 'BEHIND' && bandOf(null) === 'NO_DATA' && bandOf(94.5, { onTrack: 95, atRisk: 80 }) === 'AT_RISK',
      'bands: on track ≥ 90, at risk ≥ 70, behind below; other thresholds move them');
  }

  /* ══ fixture ══════════════════════════════════════════════════════════════ */
  const settings = await readSettings(db, COMPANY);
  const Q = periodFor('QUARTERLY', settings.yearStartMonth, T);
  const S = Q.start;
  const D0 = shift(S, -60);
  const JOIN = shift(S, 40) <= Q.end ? shift(S, 40) : Q.end;
  const dept = async (name) => ins("INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, 'Department')", [COMPANY, `${TAG}${name}`, `${TAG} ${name}`]);
  const D = await dept('D');
  const roleOf = async (code, title) => ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status, performance_frequency) VALUES (?, ?, ?, 'For a test.', 'ACTIVE', 'QUARTERLY')", [COMPANY, `${TAG}${code}`, `${TAG} ${title}`]);
  const R = await roleOf('R', 'Supervisor');
  const RB = await roleOf('B', 'Incharge');
  const pos = async (code, roleId) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')", [COMPANY, `${TAG}-${code}`, roleId, `${TAG} ${code}`, D]);
  const P = { p: await pos('P', R), f: await pos('F', R), j: await pos('J', R), m: await pos('M', RB), dh: await pos('DH', RB) };
  const [[primary]] = await db.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
  for (const from of [P.p, P.f, P.j]) await POS.addPositionReporting(db, hr, from, { toPositionId: P.m, relationshipTypeId: primary.id, isPrimary: true, effectiveFrom: D0 });
  const emp = async (code) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, employment_type, employment_status) VALUES (?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE')",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, D0]);
  const seat = async (employeeId, positionId, roleId, from) => ins(
    "INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', ?)",
    [COMPANY, employeeId, roleId, positionId, D, from]);
  const E = { e: await emp('E'), f: await emp('F'), j: await emp('J'), m: await emp('M'), dh: await emp('DH') };
  await seat(E.e, P.p, R, D0); await seat(E.f, P.f, R, D0); await seat(E.j, P.j, R, JOIN); await seat(E.m, P.m, RB, D0); await seat(E.dh, P.dh, RB, D0);

  const kraQ = await J.createRoleKra(db, hr, R, { name: `${TAG} Quality` });
  const kraS = await J.createRoleKra(db, hr, R, { name: `${TAG} Safety` });
  await J.createRoleKra(db, hr, RB, { name: `${TAG} Running the team` });
  const kpiDef = async (text) => (await RC.createMasterItem(db, hr, 'kpis', { name: text, measurementType: 'TEXT', status: 'ACTIVE' })).id;
  const addJobKpi = async (text, target, kraRow, role = R) => RC.addContent(db, hr, role, 'kpis', { kpiDefinitionId: await kpiDef(text), roleKraAssignmentId: kraRow, targetOperator: 'EQ', targetValue: target });
  await addJobKpi(`${TAG} First pass yield`, '95%', kraQ.id);
  await addJobKpi(`${TAG} Changeover time`, 'Max 30 minutes', kraS.id);
  await addJobKpi(`${TAG} Training plan`, 'Roll out by Nov\'26', null);
  await addJobKpi(`${TAG} Output`, '12 count', null);
  await addJobKpi(`${TAG} Team attendance`, '98%', null, RB);
  for (const t of ['hrms_role_kra_assignments', 'hrms_role_kpi_assignments']) {
    await db.query(`UPDATE ${t} SET effective_from = ? WHERE company_id = ? AND role_id IN (?)`, [D0, COMPANY, [R, RB]]);
  }

  // 80 more people on the Supervisor role, so the quarter's grid is a real size (≈ 400 cells).
  const BULK = 80;
  await db.query(`INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status) VALUES ${Array.from({ length: BULK }, () => "(?, ?, ?, ?, ?, 'ACTIVE')").join(', ')}`,
    Array.from({ length: BULK }, (_, i) => [COMPANY, `${TAG}-B${i}`, R, `${TAG} B${i}`, D]).flat());
  await db.query(`INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, employment_type, employment_status) VALUES ${Array.from({ length: BULK }, () => "(?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE')").join(', ')}`,
    Array.from({ length: BULK }, (_, i) => [COMPANY, `${TAG}B${i}`, `${TAG} Bulk ${i}`, D0]).flat());
  const bulkPos = await q('SELECT id, position_code FROM hrms_positions WHERE company_id = ? AND position_code LIKE ?', [COMPANY, `${TAG}-B%`]);
  const bulkEmp = new Map((await q('SELECT id, employee_code FROM hrms_employees WHERE company_id = ? AND employee_code LIKE ?', [COMPANY, `${TAG}B%`])).map((r) => [r.employee_code, r.id]));
  await db.query(`INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES ${bulkPos.map(() => "(?, ?, ?, ?, ?, 1, 'ACTIVE', ?)").join(', ')}`,
    bulkPos.flatMap((r) => [COMPANY, bulkEmp.get(r.position_code.replace(`${TAG}-B`, `${TAG}B`)), R, r.id, D, D0]));

  // Plans for the quarter: every quarterly person of the company gets one (inside this transaction).
  const made = await PLAN.createPlans(db, hr, { frequency: 'QUARTERLY', start: S });
  const periodId = made.period.id;
  const planOf = async (employeeId) => (await one("SELECT id FROM hrms_performance_plans WHERE company_id = ? AND employee_id = ? AND period_id = ? AND status <> 'CANCELLED'", [COMPANY, employeeId, periodId]))?.id;
  const planE = await planOf(E.e);
  const planF = await planOf(E.f);
  const planM = await planOf(E.m);
  const planDH = await planOf(E.dh);
  let p = await PLAN.readPlan(db, COMPANY, planE, { edit: true });
  const kraIdQ = p.kras[0].id;
  const kraIdS = p.kras[1].id;
  const kpiByName = (plan, name) => [...plan.kras.flatMap((k) => k.kpis), ...plan.ungroupedKpis].find((x) => x.name === `${TAG} ${name}`);
  ok(kpiByName(p, 'First pass yield').combine === 'AVERAGE' && kpiByName(p, 'Changeover time').combine === 'AVERAGE' && kpiByName(p, 'Output').combine === 'SUM' && kpiByName(p, 'Training plan').combine === 'AVERAGE',
    'a new plan sets each KPI\'s combine rule from its unit (95% average, 30 minutes average, 12 count added up, words average)');
  // E's draft: weights 60/40 and a KPI measured monthly.
  await PLAN.setKraWeight(db, hr, planE, kraIdQ, { weightPercent: 60 });
  await PLAN.setKraWeight(db, hr, planE, kraIdS, { weightPercent: 40 });
  const nearMiss = await PLAN.addKpi(db, hr, planE, { planKraId: kraIdS, name: `${TAG} Near misses reported`, direction: 'HIGHER_BETTER', targetNumber: 6, unit: 'count', frequency: 'MONTHLY' });
  const lastLevel = await PLAN.addKpi(db, hr, planF, { name: `${TAG} Stock level`, direction: 'HIGHER_BETTER', targetNumber: 50, unit: '%', combine: 'LAST' });
  const badCombine = await caught(() => PLAN.addKpi(db, hr, planF, { name: 'x', direction: 'HIGHER_BETTER', targetNumber: 1, combine: 'MEDIAN' }));
  ok(badCombine?.status === 422 && (await one('SELECT combine_rule FROM hrms_performance_plan_kpis WHERE id = ?', [lastLevel.id])).combine_rule === 'LAST',
    'a KPI added on a draft may say how its slots combine (LAST); a rule that is not one is refused');
  await PLAN.changeKpi(db, hr, planF, lastLevel.id, { combine: 'AVERAGE' });
  ok((await one('SELECT combine_rule FROM hrms_performance_plan_kpis WHERE id = ?', [lastLevel.id])).combine_rule === 'AVERAGE', 'the combine rule is editable while the plan is a draft');
  await PLAN.changeKpi(db, hr, planF, lastLevel.id, { combine: 'LAST' });

  // The backfill: an older plan KPI with no rule gets its unit's.
  await db.query('UPDATE hrms_performance_plan_kpis SET combine_rule = NULL WHERE company_id = ? AND plan_id = ?', [COMPANY, planDH]);
  const planned = await backfillPlan(db);
  const dhKpis = await q('SELECT id, unit, direction FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL', [COMPANY, planDH]);
  const filled = await backfill(db, planned);
  const after = await q('SELECT id, unit, direction, combine_rule FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id = ?', [COMPANY, planDH]);
  ok(filled >= dhKpis.length && after.every((r) => r.combine_rule === defaultCombine(r.unit, r.direction)) && (await backfillPlan(db)).size === 0,
    `the apply script's backfill gives an older plan KPI with no rule the one its unit gives (${filled}), and then has nothing to do`);

  for (const id of [planE, planF, planM, planDH]) await PLAN.activatePlan(db, hr, id);
  // Every other plan of the quarter is made active directly (their weights are the company's business, not this test's).
  await db.query("UPDATE hrms_performance_plans SET status = 'ACTIVE', activated_at = NOW() WHERE company_id = ? AND period_id = ? AND status = 'DRAFT' AND employee_id NOT IN (?)", [COMPANY, periodId, [E.j]]);
  const planJ = (await PLAN.createPlans(db, hr, { frequency: 'QUARTERLY', start: S, employeeIds: [E.j] })).plans[0]?.id;   // J's stays a draft
  p = await PLAN.readPlan(db, COMPANY, planE, { edit: true });
  const K = {
    fpy: kpiByName(p, 'First pass yield'), ct: kpiByName(p, 'Changeover time'), nm: kpiByName(p, 'Near misses reported'),
    tp: kpiByName(p, 'Training plan'), out: kpiByName(p, 'Output'),
  };
  const nmSlots = slotsOf(Q, 'MONTHLY');
  const openNm = nmSlots.filter((s) => s.start <= T);
  const futureNm = nmSlots.find((s) => s.start > T);

  /* ══ 3. entering ══════════════════════════════════════════════════════════ */
  section(`[3] Entering actuals for ${Q.name}`);
  {
    ok(K.nm.actuals.slots.length === 3 && K.fpy.actuals.slots.length === 1 && K.fpy.actuals.slots[0].name === Q.name, `the plan page: the monthly KPI has 3 slots, the others 1 (${Q.name})`);
    if (futureNm) {
      const future = await caught(() => ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.nm.id, slotStart: futureNm.start, value: 1 }]));
      ok(future?.code === 'FUTURE_SLOT' && /has not begun/.test(future.message), `a slot in the future (${futureNm.name}) is refused`, future?.message);
    } else skip('future slot', 'today is in the last month of the quarter');
    const notSlot = await caught(() => ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.nm.id, slotStart: shift(S, 3), value: 1 }]));
    ok(notSlot?.code === 'NOT_A_SLOT', 'a day that starts no slot of the KPI is refused, naming the slots', notSlot?.message);

    const box = counting();
    const first = await ACT.enterActuals(box.db, hr, [
      { planId: planE, kpiId: K.fpy.id, value: 90 },
      { planId: planE, kpiId: K.ct.id, value: 40, note: 'New die' },
      { planId: planE, kpiId: K.nm.id, slotStart: openNm[0].start, value: 2 },
      { planId: planE, kpiId: K.tp.id, met: 'Met' },
    ]);
    ok(first.entered === 4 && box.n === 6, `four actuals entered in ${box.n} queries (lock, KPIs, live, insert, read back, audit)`, JSON.stringify(first));
    const live = await q('SELECT * FROM hrms_performance_actuals WHERE company_id = ? AND plan_id = ?', [COMPANY, planE]);
    ok(live.length === 4 && live.every((a) => a.source === 'MANUAL' && a.entered_by === owner.id && a.closed_at === null) && live.find((a) => a.plan_kpi_id === K.tp.id).met === 'YES',
      'each is one live row: who, when, MANUAL; words are stored as met (YES)');
    const auditRows = await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_performance_actuals' AND entity_id IN (?)", [COMPANY, live.map((a) => a.id)]);
    ok(Number(auditRows.n) === 4, 'and each is audited');

    const noReason = await caught(() => ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.fpy.id, value: 92 }]));
    ok(noReason?.code === 'REASON_REQUIRED' && /already has the value 90/.test(noReason.message), 'correcting a value already entered without a reason is refused, saying what it has', noReason?.message);
    const corrected = await ACT.enterOne(db, hr, { planId: planE, kpiId: K.fpy.id, value: 92, reason: 'Count re-checked' });
    const rows = await q('SELECT * FROM hrms_performance_actuals WHERE company_id = ? AND plan_kpi_id = ? ORDER BY id', [COMPANY, K.fpy.id]);
    ok(corrected.action === 'CORRECTED' && rows.length === 2 && rows[0].closed_at && rows[0].closed_by === owner.id && Number(rows[0].value_number) === 90
      && rows[1].closed_at === null && Number(rows[1].value_number) === 92 && rows[1].corrects_id === rows[0].id && rows[1].correction_reason === 'Count re-checked',
    'a correction closes the old row (kept, value 90) and opens a new one that points at it, with the reason');
    ok(near(corrected.achievement, 96.8) && corrected.band === 'ON_TRACK' && corrected.plan.score != null, `the cell answers its new achievement (92 ÷ 95 = ${corrected.achievement}%) and the plan's new score (${corrected.plan.score})`);
    const dup = await caught(() => db.query('INSERT INTO hrms_performance_actuals (company_id, plan_id, plan_kpi_id, slot_start, slot_end, value_number) VALUES (?, ?, ?, ?, ?, 1)', [COMPANY, planE, K.fpy.id, S, Q.end]));
    ok(dup && /Duplicate/.test(dup.message), 'the database itself refuses a second live row for the same KPI and slot');
    const hist = await ACT.actualHistory(db, COMPANY, planE, K.fpy.id);
    ok(hist.rows.length === 2 && hist.rows[0].live && hist.rows[0].value === 92 && hist.rows[0].reason === 'Count re-checked' && !hist.rows[1].live && hist.rows[1].value === 90 && hist.rows[1].replacedBy,
      'the history: the live value first, then the one it replaced, with who replaced it');
    const same = await ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.fpy.id, value: 92 }]);
    ok(same.unchanged === 1 && (await q('SELECT id FROM hrms_performance_actuals WHERE plan_kpi_id = ?', [K.fpy.id])).length === 2, 'the same value again changes nothing (no new row)');
    const noteOnly = await ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.ct.id, note: 'New die, fitted on the 3rd' }]);
    const ctRows = await q('SELECT * FROM hrms_performance_actuals WHERE plan_kpi_id = ? ORDER BY id', [K.ct.id]);
    ok(noteOnly.corrected === 1 && ctRows.length === 2 && ctRows[1].note === 'New die, fitted on the 3rd' && Number(ctRows[1].value_number) === 40 && ctRows[1].correction_reason === null,
      'a note alone changes without a reason — still a new row; the earlier one is kept');
    const cleared = await caught(() => ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.fpy.id, value: null, reason: 'x' }]));
    ok(cleared?.code === 'NO_REMOVE', 'a value once entered is corrected, never cleared', cleared?.message);
    const wrongKind = await Promise.all([
      caught(() => ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.tp.id, value: 3 }])),
      caught(() => ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.out.id, met: 'YES' }])),
      caught(() => ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.out.id, value: 'twelve' }])),
      caught(() => ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.out.id }])),
      caught(() => ACT.enterActuals(db, hr, [{ planId: planF, kpiId: K.out.id, value: 1 }])),
    ]);
    ok(wrongKind.every((e) => e && e.status >= 400 && e.status < 500), 'a number for words, met for a number, words for a number, nothing at all, a KPI of another plan: each refused', wrongKind.map((e) => e?.code).join(' '));
    const textTwice = await caught(() => ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.tp.id, met: 'NO' }]));
    ok(textTwice?.code === 'REASON_REQUIRED' && /“met”/.test(textTwice.message), 'changing met to not met is a correction too: it needs a reason');
  }

  /* ══ 4. only active plans; a closed period ═════════════════════════════════ */
  section('[4] Only ACTIVE plans take actuals');
  {
    const draftJ = await PLAN.readPlan(db, COMPANY, planJ, { edit: true });
    const kj = draftJ.ungroupedKpis[0] ?? draftJ.kras[0]?.kpis[0];
    const onDraft = await caught(() => ACT.enterActuals(db, hr, [{ planId: planJ, kpiId: kj.id, value: 1 }]));
    ok(onDraft?.code === 'NOT_ACTIVE' && /draft/.test(onDraft.message) && !draftJ.plan.can.enterActuals && /activated/.test(draftJ.plan.actualsLine), 'a DRAFT plan takes no actuals, and its page says why', onDraft?.message);
    await PLAN.cancelPlan(db, hr, planDH, { reason: 'test' });
    const dhKpi = (await q('SELECT id FROM hrms_performance_plan_kpis WHERE plan_id = ? AND deleted_at IS NULL LIMIT 1', [planDH]))[0];
    const onCancelled = dhKpi ? await caught(() => ACT.enterActuals(db, hr, [{ planId: planDH, kpiId: dhKpi.id, value: 1 }])) : { code: 'NOT_ACTIVE' };
    ok(onCancelled?.code === 'NOT_ACTIVE', 'a CANCELLED plan takes none');
  }

  /* ══ 5. reads: plan page, list, bands, query counts ════════════════════════ */
  section('[5] The plan page, the Plans list, bands — and the number of queries');
  let gridRows = 0;
  {
    const box = counting();
    p = await PLAN.readPlan(box.db, COMPANY, planE, { edit: true });
    const k = (name) => kpiByName(p, name);
    ok(box.n === 7, `the plan page is ${box.n} queries`);
    ok(k('First pass yield').actuals.combined === 92 && near(k('First pass yield').actuals.achievement, 96.8) && k('First pass yield').actuals.slots[0].actual.corrected,
      'a KPI shows its slot (corrected), the combined actual and the achievement');
    const nm = k('Near misses reported').actuals;
    ok(nm.slots.length === 3 && nm.slots[0].actual?.value === 2 && nm.slots.filter((s) => !s.actual).length === 2 && nm.combine === 'SUM' && nm.combined === 2 && nm.combinedTarget === 2 && nm.achievement === 100,
      'the monthly KPI: its slots, one with a value; added up; the target pro rata (2 of 6) → 100%', JSON.stringify(nm));
    ok(p.kras[0].score === 96.8 && p.kras[1].score === 87.5 && p.ungroupedScore.score === 100 && p.ungroupedScore.basedOn.counted === 1 && p.ungroupedScore.basedOn.total === 2,
      'each KRA its score (Quality 96.8, Safety 87.5); the KPIs under no KRA 100, based on 1 of 2');
    ok(p.plan.score === 95.4 && p.plan.basedOn.counted === 4 && p.plan.basedOn.total === 5 && p.plan.scoreLine === 'Based on 4 of 5 KPIs.' && p.plan.band === 'ON_TRACK' && p.plan.can.enterActuals,
      `the plan: (96.8 × 60 + 87.5 × 40 + 100 × 50) ÷ 150 = ${p.plan.score}, "${p.plan.scoreLine}", on track`);

    const lb = counting();
    const list = await PLAN.listPlans(lb.db, COMPANY, { periodId });
    const row = list.items.find((r) => r.id === planE);
    ok(row?.score === 95.4 && row.band === 'ON_TRACK' && row.basedOn.counted === 4 && lb.n === 5, `the Plans list carries the score and band of each of ${list.items.length} plans in ${lb.n} queries`, JSON.stringify(row && { s: row.score, b: row.band }));

    const gb = counting();
    const t0 = Date.now();
    const grid = await ACT.actualsGrid(gb.db, COMPANY, { periodId }, { canEnter: true });
    const ms = Date.now() - t0;
    gridRows = grid.rows.length;
    note(`the Actuals grid for ${Q.name}, slot ${grid.slot}: ${grid.rows.length} rows (${grid.slots.length} slots on offer) in ${gb.n} queries, ${ms} ms locally — ≈ ${Math.round(gb.n * 49)} ms of round trips on production`);
    ok(gb.n <= 6 && grid.rows.length >= 400, `the grid is a fixed handful of queries (${gb.n}) for ${grid.rows.length} rows — no query per row`);
    const all = await ACT.actualsGrid(db, COMPANY, { periodId, slot: 'all' }, { canEnter: true });
    const eRows = all.rows.filter((r) => r.planId === planE);
    ok(eRows.length === 4 + openNm.length && eRows.every((r) => r.canEnter) && !all.rows.some((r) => r.planId === planJ || r.planId === planDH),
      `"all slots" lists each KPI's open slots (${eRows.length} for E); drafts and cancelled plans are not listed`);
    ok(/draft/.test(all.line ?? ''), 'the grid says drafts are not shown', all.line);
    const fpyRow = eRows.find((r) => r.kpiId === K.fpy.id);
    ok(fpyRow.actual.value === 92 && near(fpyRow.achievement, 96.8) && fpyRow.band === 'ON_TRACK' && fpyRow.target === 'at least 95%', 'a grid row: target, the value, the achievement chip and its band');

    // Many cells at once: what an upload of a whole slot costs.
    const toFill = all.rows.filter((r) => !r.actual && r.canEnter);
    const eb = counting();
    const t1 = Date.now();
    const many = await ACT.enterActuals(eb.db, hr, toFill.map((r) => (r.direction === 'DATE' ? { planId: r.planId, kpiId: r.kpiId, slotStart: r.slotStart, value: r.slotStart } : r.direction === 'TEXT' ? { planId: r.planId, kpiId: r.kpiId, slotStart: r.slotStart, met: 'YES' }
      : { planId: r.planId, kpiId: r.kpiId, slotStart: r.slotStart, value: r.targetNumber ?? 1 })), { source: 'EXCEL' });
    note(`${many.entered} actuals written in one call: ${eb.n} queries, ${Date.now() - t1} ms locally`);
    ok(many.entered === toFill.length && eb.n === 6, `${many.entered} cells are the same ${eb.n} queries as one`);
    const gb2 = counting();
    const full = await ACT.actualsGrid(gb2.db, COMPANY, { periodId, slot: 'all' }, { canEnter: true });
    note(`the grid with every cell entered: ${full.rows.length} rows in ${gb2.n} queries`);
    ok(gb2.n <= 6 && full.rows.every((r) => r.actual), `with ${full.rows.length} values in it, still ${gb2.n} queries`);
    const lb2 = counting();
    const list2 = await PLAN.listPlans(lb2.db, COMPANY, { periodId });
    // The monthly plans of the month (operators, helpers): the bigger grid.
    const mon = await PLAN.createPlans(db, hr, { frequency: 'MONTHLY', start: periodFor('MONTHLY', settings.yearStartMonth, T).start });
    await db.query("UPDATE hrms_performance_plans SET status = 'ACTIVE', activated_at = NOW() WHERE company_id = ? AND period_id = ? AND status = 'DRAFT'", [COMPANY, mon.period.id]);
    const mAll = await ACT.actualsGrid(db, COMPANY, { periodId: mon.period.id }, { canEnter: true });
    const mb = counting();
    const mFill = await ACT.enterActuals(mb.db, hr, mAll.rows.filter((r) => r.canEnter).map((r) => (r.direction === 'DATE' ? { planId: r.planId, kpiId: r.kpiId, slotStart: r.slotStart, value: r.slotStart } : r.direction === 'TEXT' ? { planId: r.planId, kpiId: r.kpiId, slotStart: r.slotStart, met: 'NO' }
      : { planId: r.planId, kpiId: r.kpiId, slotStart: r.slotStart, value: r.targetNumber ?? 1 })), { source: 'EXCEL' });
    const mg = counting();
    const t2 = Date.now();
    const mGrid = await ACT.actualsGrid(mg.db, COMPANY, { periodId: mon.period.id }, { canEnter: true });
    note(`${mon.period.name} (monthly, ${mon.created} plans): ${mFill.entered} actuals written in ${mb.n} queries; the grid of ${mGrid.rows.length} rows, all entered, in ${mg.n} queries, ${Date.now() - t2} ms locally`);
    const ml = counting();
    const mList = await PLAN.listPlans(ml.db, COMPANY, { periodId: mon.period.id });
    ok(mb.n === 6 && mg.n <= 6 && ml.n === 5 && mGrid.rows.length === mAll.rows.length && mList.items.length === mon.created,
      `the monthly grid: ${mGrid.rows.length} cells written in ${mb.n} queries, read in ${mg.n}; its Plans list scored in ${ml.n}`);
    ok(lb2.n === 5 && list2.items.filter((r) => r.status === 'ACTIVE').every((r) => r.basedOn.total === 0 || r.basedOn.counted === r.basedOn.total), `the Plans list, every plan scored: still ${lb2.n} queries`);
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

  section('[5b] Over HTTP: the grid, a cell, the list, bands from settings, the chart');
  {
    const { n, r: grid } = await countPool(() => must(O, 'GET', `/performance/actuals?periodId=${periodId}&slot=all&department=${D}`));
    ok(grid.rows.length > 0 && grid.rows.every((x) => x.departmentId === D) && grid.counts.rows === grid.rows.length && grid.counts.entered === grid.rows.filter((x) => x.actual).length && grid.total >= grid.rows.length,
      `GET /performance/actuals: filtered by department, with the count line (${grid.counts.entered} of ${grid.counts.rows} entered) — ${n} queries through the route`);
    const missing = await must(O, 'GET', `/performance/actuals?periodId=${periodId}&slot=all&missing=1`);
    ok(missing.rows.every((x) => !x.actual) && missing.counts.rows >= missing.rows.length, '"show only what is missing" keeps the empty rows; the count line still counts all');
    const byManager = await must(O, 'GET', `/performance/actuals?periodId=${periodId}&slot=all&manager=${P.m}`);
    ok(byManager.rows.length > 0 && byManager.rows.every((x) => x.managerPositionId === P.m) && byManager.managers.some((m) => m.id === P.m), 'the manager filter, and the managers on offer');
    const byRole = await must(O, 'GET', `/performance/actuals?periodId=${periodId}&slot=all&role=${RB}`);
    ok(byRole.rows.length > 0 && byRole.rows.every((x) => x.roleId === RB), 'the role filter');
    const cell = await must(O, 'PUT', '/performance/actuals', { planId: planE, kpiId: K.out.id, value: 6, reason: 'Recounted' });
    ok(cell.action === 'CORRECTED' && cell.actual.value === 6 && cell.actual.reason === 'Recounted' && cell.kpi.combined === 6 && cell.plan.basedOn.counted === 5,
      'PUT /performance/actuals: a cell corrected with a reason; it answers the KPI and the plan again');
    const histH = await must(O, 'GET', `/performance/plans/${planE}/kpis/${K.out.id}/actuals`);
    ok(histH.rows.length === 2 && histH.rows[0].live && histH.rows[0].reason === 'Recounted', 'GET …/kpis/:kpiId/actuals: the KPI\'s history');

    const list = await must(O, 'GET', `/performance/plans?periodId=${periodId}`);
    const eRow = list.items.find((r) => r.id === planE);
    const band = eRow.band;
    const filtered = await must(O, 'GET', `/performance/plans?periodId=${periodId}&band=${band}`);
    const others = await must(O, 'GET', `/performance/plans?periodId=${periodId}&band=${band === 'BEHIND' ? 'ON_TRACK' : 'BEHIND'}`);
    ok(eRow.score != null && filtered.items.some((r) => r.id === planE) && filtered.items.every((r) => r.band === band) && !others.items.some((r) => r.id === planE),
      `the Plans list: a Score column (E ${eRow.score}%, ${eRow.bandLabel}) and a band filter`);
    const set = await must(O, 'PUT', '/performance/settings', { bands: { onTrack: 120, atRisk: 110 } });
    const moved = await must(O, 'GET', `/performance/plans/${planE}`);
    ok(set.bands.onTrack === 120 && set.bands.atRisk === 110 && moved.plan.band === 'BEHIND' && moved.bands.onTrack === 120, 'bands come from Performance settings: raised to 120 / 110, the same score is now "behind"');
    const badBands = await call(O, 'PUT', '/performance/settings', { bands: { onTrack: 70, atRisk: 90 } });
    ok(badBands.status === 422 && /below/.test(badBands.json?.message ?? ''), '"at risk" must start below "on track"', badBands.json?.message);
    await must(O, 'PUT', '/performance/settings', { bands: { onTrack: 90, atRisk: 70 } });
    const bands = await must(O, 'GET', '/performance/bands');
    const eBand = bands.people.find((x) => x.employeeId === E.e);
    ok(eBand?.band === eRow.band && eBand.score === eRow.score && eBand.positionId === P.p && !bands.people.some((x) => x.employeeId === E.j) && bands.periods.some((x) => x.id === periodId),
      'GET /performance/bands: one band per person with a plan holding today (the org chart\'s dot); nobody without an active plan');
    const bandsQ = await must(O, 'GET', `/performance/bands?periodId=${periodId}`);
    ok(bandsQ.people.length === bands.people.length || bandsQ.people.length > 0, 'and for a chosen period');
    const s2 = await must(O, 'GET', '/performance/settings');
    ok(s2.bands.onTrack === 90 && s2.bands.atRisk === 70 && s2.bandWords.AT_RISK === 'At risk', 'the settings page carries the bands and their words');
  }

  /* ══ 6. rights and scope ════════════════════════════════════════════════════ */
  section('[6] Rights and scope');
  {
    // HR executive: performance view + edit.
    const hx1 = await call(U.HRX, 'GET', `/performance/actuals?periodId=${periodId}`);
    const hx2 = await call(U.HRX, 'PUT', '/performance/actuals', { planId: planF, kpiId: lastLevel.id, value: 40, reason: 'Stock counted' });
    const hx3 = await call(U.HRX, 'POST', '/excel/actuals/preview', { fileName: 'x.xlsx', contentBase64: 'UEsDBA==' });
    ok(hx1.status === 200 && hx1.json.rows.every((r) => r.canEnter || r.locked) && hx2.status === 200 && hx3.status === 403,
      'HR executive: reads the grid and enters a value; may not upload actuals by Excel (no performance upload)', `${hx1.status} ${hx2.status} ${hx3.status}`);
    // Employee: no performance area; their own plan, read only, with its actuals.
    const em1 = await call(U.EMP, 'GET', '/performance/actuals');
    const em2 = await call(U.EMP, 'PUT', '/performance/actuals', { planId: planE, kpiId: K.fpy.id, value: 99, reason: 'x' });
    const mine = await call(U.EMP, 'GET', '/user/me/plan');
    const myPlan = mine.json?.plans?.[0];
    const myFpy = myPlan && kpiByName(myPlan, 'First pass yield');
    const myHist = await call(U.EMP, 'GET', `/user/me/plan/${planE}/kpis/${K.fpy.id}/actuals`);
    const notMine = await call(U.EMP, 'GET', `/user/me/plan/${planF}/kpis/${lastLevel.id}/actuals`);
    const empTeam = await call(U.EMP, 'PUT', '/user/me/team/actuals', { planId: planE, kpiId: K.fpy.id, value: 99, reason: 'x' });
    ok(em1.status === 403 && em2.status === 403 && mine.status === 200 && myPlan.plan.id === planE && !myPlan.plan.can.enterActuals && myFpy?.actuals.combined === 92 && myPlan.plan.score != null,
      'Employee: no Actuals screen (403), cannot enter; My plan shows their actuals, achievement and score, read only', `${em1.status} ${em2.status} ${mine.status}`);
    ok(myHist.status === 200 && myHist.json.rows.length === 2 && notMine.status === 404 && empTeam.status === 403, 'Employee: their own KPI history; another person\'s is 404; they enter nothing for themselves (403)', `${myHist.status} ${notMine.status} ${empTeam.status}`);
    // Department head: their department only.
    const inD = new Set((await q('SELECT employee_id FROM hrms_performance_plans WHERE company_id = ? AND department_id = ?', [COMPANY, D])).map((r) => Number(r.employee_id)));
    const dh1 = await call(U.DH, 'GET', `/performance/actuals?periodId=${periodId}&slot=all`);
    const outside = (await ACT.actualsGrid(db, COMPANY, { periodId, slot: 'all' }, { canEnter: true })).rows.find((r) => r.departmentId !== D && r.canEnter);
    const dh2 = outside ? await call(U.DH, 'PUT', '/performance/actuals', { planId: outside.planId, kpiId: outside.kpiId, slotStart: outside.slotStart, value: 1, reason: 'x' }) : { status: 403, json: { code: 'OUT_OF_SCOPE' } };
    const dh3 = await call(U.DH, 'PUT', '/performance/actuals', { planId: planF, kpiId: lastLevel.id, value: 41, reason: 'Checked again' });
    const dh4 = await call(U.DH, 'GET', `/performance/bands?periodId=${periodId}`);
    ok(dh1.status === 200 && dh1.json.rows.length > 0 && dh1.json.rows.every((r) => r.departmentId === D) && dh2.status === 403 && dh2.json?.code === 'OUT_OF_SCOPE' && dh3.status === 200
      && dh4.status === 200 && dh4.json.people.length > 0 && dh4.json.people.every((x) => inD.has(x.employeeId)),
    'Department head: the grid and the chart bands of their own department only; enters there; 403 OUT_OF_SCOPE outside', `${dh1.status} ${dh2.status} ${dh3.status} ${dh4.status}`);
    // A manager login: the people below them.
    const team = await call(U.MGR, 'GET', `/user/me/team/actuals?periodId=${periodId}&slot=all`);
    const teamPeople = new Set((team.json?.rows ?? []).map((r) => r.employeeId));
    ok(team.status === 200 && teamPeople.has(E.e) && teamPeople.has(E.f) && !teamPeople.has(E.m) && team.json.rows.every((r) => r.canEnter || r.locked),
      'manager login: the grid lists the people below them, not themselves', JSON.stringify([...teamPeople]));
    const m1 = await call(U.MGR, 'PUT', '/user/me/team/actuals', { planId: planF, kpiId: lastLevel.id, value: 45, reason: 'Stock taken' });
    const mPlanM = await PLAN.readPlan(db, COMPANY, planM, {});
    const mKpi = mPlanM.ungroupedKpis[0] ?? mPlanM.kras[0]?.kpis[0];
    const m2 = await call(U.MGR, 'PUT', '/user/me/team/actuals', { planId: planM, kpiId: mKpi.id, value: 99, reason: 'mine' });
    const m3 = await call(U.MGR, 'PUT', '/performance/actuals', { planId: planF, kpiId: lastLevel.id, value: 46, reason: 'x' });
    const m4 = outside ? await call(U.MGR, 'PUT', '/user/me/team/actuals', { planId: outside.planId, kpiId: outside.kpiId, slotStart: outside.slotStart, value: 1, reason: 'x' }) : { status: 403 };
    const m5 = await call(U.MGR, 'GET', `/user/me/team/plans/${planF}/kpis/${lastLevel.id}/actuals`);
    const tp = await call(U.MGR, 'GET', `/user/me/team/plans/${planF}`);
    ok(m1.status === 200 && m1.json.actual.value === 45 && m2.status === 403 && m2.json?.code === 'NOT_YOUR_TEAM' && m3.status === 403 && m4.status === 403 && m5.status === 200 && m5.json.rows.length >= 3
      && tp.status === 200 && tp.json.plan.can.enterActuals,
    'manager login: enters / corrects for a report (same writer, history kept); not their own plan (403 NOT_YOUR_TEAM), not the HR route, not outside their team', `${m1.status} ${m2.status} ${m3.status} ${m4.status} ${m5.status}`);
    const lastRows = await q('SELECT value_number, entered_by FROM hrms_performance_actuals WHERE plan_kpi_id = ? AND closed_at IS NULL', [lastLevel.id]);
    ok(lastRows.length === 1 && Number(lastRows[0].value_number) === 45 && lastRows[0].entered_by === U.MGR.id, 'what the manager entered is the live value, entered by them');
  }

  /* ══ 7. Excel ═══════════════════════════════════════════════════════════════ */
  section('[7] Excel round trip');
  {
    const ents = await must(O, 'GET', '/excel/entities');
    const ae = ents.find((x) => x.entity === 'actuals');
    ok(ae?.area === 'performance' && ae.canDownload && ae.canUpload, 'GET /excel/entities lists Actuals (performance) for the Owner');
    const wbDl = await must(O, 'GET', `/excel/actuals/workbook?periodId=${periodId}&department=${D}`);
    ok(wbDl.rows > 0 && /Actuals/.test(wbDl.fileName), `the download: ${wbDl.rows} rows (person × KPI × open slot) for the department`, wbDl.fileName);
    let book = await openBook(wbDl.contentBase64);
    const fRow = book.find({ Person: `${TAG}F`, KPI: `${TAG} First pass yield` });
    const eOut = book.find({ Person: `${TAG}E`, KPI: `${TAG} Output` });
    const eNm = book.find({ Person: `${TAG}E`, KPI: `${TAG} Near misses reported` });
    ok(book.count() === wbDl.rows && book.get(fRow, 'Target') === 'at least 95%' && book.get(fRow, 'Which way') === 'Higher is better' && book.get(eOut, 'Value') === '6',
      'the file: info columns (person, KPI, target, which way, slot…) and the value entered');
    // F's FPY has a value from the bulk fill (95): correct it without a reason, then with one; E's Output: a note; a new row.
    book.set(fRow, 'Value', 97);
    book.set(eNm, 'Note', 'Two reported in the first week');
    const blank = book.count() + 2;
    book.set(blank, 'Value', 5);
    let file = await book.save();
    let pv = await must(O, 'POST', '/excel/actuals/preview', { fileName: wbDl.fileName, contentBase64: file });
    const pRow = pv.rows.find((r) => r.row === fRow);
    const newRow = pv.rows.find((r) => r.row === blank);
    ok(pv.fileProblems.length === 0 && pRow?.action === 'PROBLEM' && /Reason for a correction/.test(pRow.problems[0]) && newRow?.action === 'PROBLEM' && /cannot be added/.test(newRow.problems[0]),
      'preview: a corrected value without a reason is a problem; so is an added row', JSON.stringify([pRow, newRow]));
    book = await openBook(file);
    book.set(fRow, 'Reason for a correction', 'Lab report came in');
    book.set(blank, 'Value', null);
    file = await book.save();
    pv = await must(O, 'POST', '/excel/actuals/preview', { fileName: wbDl.fileName, contentBase64: file });
    ok(pv.summary.change === 2 && pv.summary.problems === 0 && pv.summary.add === 0, `preview: ${pv.summary.change} to change, no problems`, JSON.stringify(pv.summary));
    const { n, r: applied } = await countPool(() => must(O, 'POST', '/excel/actuals/apply', { fileName: wbDl.fileName, contentBase64: file, expect: { add: 0, change: 2 } }));
    const fNow = await q('SELECT * FROM hrms_performance_actuals WHERE plan_id = ? AND plan_kpi_id = (SELECT id FROM hrms_performance_plan_kpis WHERE plan_id = ? AND name = ?) ORDER BY id', [planF, planF, `${TAG} First pass yield`]);
    ok(applied.changed === 2 && fNow.length === 2 && Number(fNow[1].value_number) === 97 && fNow[1].source === 'EXCEL' && fNow[1].correction_reason === 'Lab report came in' && fNow[0].closed_at,
      `apply: the correction is a new EXCEL row with its reason, the old one kept — ${n} queries for the whole apply`);
    note(`Excel apply of ${pv.summary.change} rows: ${n} queries in total (the file is read and checked in memory; the writes are one batch)`);
    const again = await must(O, 'POST', '/excel/actuals/preview', { fileName: wbDl.fileName, contentBase64: file });
    ok(again.rows.some((r) => r.row === fRow && /changed in the app since/.test(r.problems[0] ?? '')), 'the same file again: the rows changed since its download are refused ("download again")');
    const fresh = await must(O, 'GET', `/excel/actuals/workbook?periodId=${periodId}&department=${D}`);
    book = await openBook(fresh.contentBase64);
    const fr = book.find({ Person: `${TAG}F`, KPI: `${TAG} First pass yield` });
    ok(book.get(fr, 'Value') === '97' && /Entered \(corrected\)/.test(book.get(fr, 'State')), 'a fresh download has the corrected value');
    book.set(fr, 'Value', null);
    book.set(fr, 'Reason for a correction', 'clear it');
    const cl = await must(O, 'POST', '/excel/actuals/preview', { fileName: fresh.fileName, contentBase64: await book.save() });
    ok(cl.rows.some((r) => r.row === fr && /not removed/.test(r.problems[0] ?? '')), 'clearing a value in the file is refused: corrected, never removed');
    const big = await must(O, 'GET', `/excel/actuals/workbook?periodId=${periodId}`);
    book = await openBook(big.contentBase64);
    let changes = 0;
    for (let r = 2; r <= book.ws.rowCount && changes < 200; r += 1) {
      if (book.get(r, 'Which way') === 'Written as words' || !book.get(r, 'Value') || /read only|has not begun/i.test(book.get(r, 'State'))) continue;
      book.set(r, 'Value', Number(book.get(r, 'Value')) + 1);
      book.set(r, 'Reason for a correction', 'Bulk test');
      changes += 1;
    }
    const bigFile = await book.save();
    const bigPv = await must(O, 'POST', '/excel/actuals/preview', { fileName: big.fileName, contentBase64: bigFile });
    const { n: bigN, r: bigApplied } = await countPool(() => must(O, 'POST', '/excel/actuals/apply', { fileName: big.fileName, contentBase64: bigFile, expect: { add: 0, change: bigPv.summary.change } }));
    note(`Excel: a ${big.rows}-row file changing ${bigApplied.changed} values — ${bigN} queries for the apply`);
    ok(bigApplied.changed === changes && bigN <= 25, `a ${changes}-row correction by Excel is a fixed handful of queries (${bigN})`);
    const other2 = await call(U.DH, 'POST', '/excel/actuals/preview', { fileName: big.fileName, contentBase64: bigFile });
    ok(other2.status === 403, 'a Department head (no performance upload) cannot upload actuals');
  }

  /* ══ 4b. a closed period ═══════════════════════════════════════════════════ */
  section('[4b] A closed period is read only');
  {
    await PLAN.cancelPlan(db, hr, planJ, { reason: 'test' });
    await PLAN.closePeriod(db, hr, periodId);
    const closed = await caught(() => ACT.enterActuals(db, hr, [{ planId: planE, kpiId: K.fpy.id, value: 93, reason: 'late' }]));
    const page = await PLAN.readPlan(db, COMPANY, planE, { edit: true });
    const grid = await ACT.actualsGrid(db, COMPANY, { periodId, slot: 'all' }, { canEnter: true });
    const httpPut = await call(O, 'PUT', '/performance/actuals', { planId: planE, kpiId: K.fpy.id, value: 93, reason: 'late' });
    ok(closed?.code === 'PERIOD_CLOSED' && !page.plan.can.enterActuals && /closed/.test(page.plan.actualsLine) && page.plan.score != null
      && grid.rows.length > 0 && grid.rows.every((r) => !r.canEnter && /closed/.test(r.locked)) && httpPut.status === 409,
    'after the period is closed: entering is refused (409), the page and the grid read the actuals but offer no input, the score stays');
  }

  /* ══ 8. tenant isolation ═════════════════════════════════════════════════════ */
  section('[8] Tenant isolation');
  if (!THEM) skip('tenant isolation', 'no second company with an admin login');
  else {
    const was = await one('SELECT value_number FROM hrms_performance_actuals WHERE plan_kpi_id = ? AND closed_at IS NULL', [lastLevel.id]);
    const t1 = await call(THEM, 'GET', `/performance/actuals?periodId=${periodId}`, undefined, { as: other.slug });
    const t2 = await call(THEM, 'PUT', '/performance/actuals', { planId: planF, kpiId: lastLevel.id, value: 1, reason: 'x' }, { as: other.slug });
    const t3 = await call(THEM, 'GET', `/performance/plans/${planE}/kpis/${K.fpy.id}/actuals`, undefined, { as: other.slug });
    const t4 = await call(THEM, 'GET', '/performance/bands', undefined, { as: other.slug });
    const t5 = await call(THEM, 'GET', `/excel/actuals/workbook?periodId=${periodId}`, undefined, { as: other.slug });
    ok((t1.status === 404 || (t1.status === 200 && t1.json.rows.length === 0)) && t2.status === 404 && t3.status === 404
      && t4.status === 200 && !t4.json.people.some((x) => x.employeeId === E.e) && (t5.status === 404 || (t5.status === 200 && t5.json.rows === 0)),
    'another company: cannot read our grid, enter on our plan, read a history, see our bands or download our actuals', `${t1.status} ${t2.status} ${t3.status} ${t4.status} ${t5.status}`);
    const live = await one('SELECT value_number FROM hrms_performance_actuals WHERE plan_kpi_id = ? AND closed_at IS NULL', [lastLevel.id]);
    ok(Number(live.value_number) === Number(was.value_number), 'and ours are unchanged');
  }
  note(`grid rows for the quarter: ${gridRows}`);
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
  ok(moved.length === 0, `every count is what it was (${TABLES.length} tables and the bands)`, moved.map((k) => `${k} ${String(before[k]).slice(0, 40)} -> ${String(after[k]).slice(0, 40)}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
