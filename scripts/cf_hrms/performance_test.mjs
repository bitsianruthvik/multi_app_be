/**
 * performance_test.mjs — performance plans (TM/CF_HRMS_HIRING_SPEC.md §18, 2026-10-15).
 *
 *   0. the schema (apply-performance-schema.mjs): a second run plans nothing;
 *   1. periods — monthly / quarterly / half-yearly / yearly names and dates
 *      from an April year (and a January one); contiguous, never overlapping;
 *   2. target parsing — the cases, and Karni's own KPI targets (how many parse,
 *      and which do not);
 *   3. the batched resolver gives exactly what resolveContent gives, for every
 *      Karni person, on the period start and today;
 *   4. settings and role frequencies (incl. the year start that cannot move once
 *      periods exist);
 *   5. preview and create — who gets a plan, who is skipped and why, a role
 *      with no KPIs, idempotent, a mid-period joiner given one later; the
 *      number of queries;
 *   6. copying AS ON the period start: a role change and a person change dated
 *      after the start do not reach the plan; the person layer is included;
 *   7. draft editing, the weights rule, activate locks the list, a dated target
 *      change with a reason, cancel (kept; frees the slot), close the period;
 *   8. rights and scope — HR executive, Employee, a Department head scoped to
 *      one department, a manager login over a report below them (and not over
 *      their own plan);
 *   9. tenant isolation; and nothing is left behind.
 *
 *   node scripts/cf_hrms/performance_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: the whole run is ONE connection inside ONE
 * transaction (pool.query / getConnection point at it; a route's own
 * transaction is a savepoint), rolled back at the end. Local only.
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
import { resolveContent, resolveJobsForAssignments } from '../../apps/cf_hrms/services/contentResolver.js';
import { periodAt, periodsOfYear, periodFor, periodStartingOn } from '../../apps/cf_hrms/services/performance/periods.js';
import { parseTargetText, planTargetOf } from '../../apps/cf_hrms/services/performance/targets.js';
import * as PLAN from '../../apps/cf_hrms/services/performance/planService.js';
import { readSettings } from '../../apps/cf_hrms/services/performance/settingsService.js';
import { schemaSteps, PERFORMANCE_TABLES } from '../../apps/cf_hrms/scripts/apply-performance-schema.mjs';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const skipped = [];
const notes = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const skip = (name, reason) => { skipped.push(`${name}: ${reason}`); };
const note = (line) => { notes.push(line); console.log(`  note  ${line}`); };
const section = (title) => console.log(`\n${title}`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

const TABLES = [...PERFORMANCE_TABLES, 'hrms_roles', 'hrms_positions', 'hrms_employees', 'hrms_work_assignments', 'hrms_work_assignment_content_overrides',
  'hrms_role_kpi_assignments', 'hrms_role_kra_assignments', 'hrms_kpi_definitions', 'hrms_audit_log', 'users', 'app_user_access', 'role_capability'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM ${t}`);
      out[t] = `${r.n}/${r.live}`;
    }
    const [[f]] = await conn.query("SELECT GROUP_CONCAT(CONCAT(id, ':', COALESCE(performance_frequency, '-')) ORDER BY id) AS s FROM hrms_roles");
    out.frequencies = f.s;
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_pf_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_pf_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_pf_${depth}`); depth -= 1; } },
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

const TAG = `ZZPF${Date.now().toString(36).toUpperCase().slice(-5)}`;
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
  const OWNERC = { companyId: COMPANY, userId: owner.id, owner: true };
  const other = await one(
    `SELECT co.id, co.name, co.slug, a.id AS app_id FROM companies co JOIN apps a ON a.company_id = co.id AND a.slug = 'cf_hrms' AND a.deleted_at IS NULL
      WHERE co.id <> ? AND co.deleted_at IS NULL ORDER BY co.id LIMIT 1`, [COMPANY]);
  const T = POS.today();
  console.log(`performance_test — ${company.name} (${COMPANY}), run tag ${TAG}, today ${T}`);

  /* ══ 0. the schema ════════════════════════════════════════════════════════ */
  section('[0] The schema');
  ok((await schemaSteps(db)).length === 0, 'apply-performance-schema: nothing left to do on this database (idempotent)');
  const types = await q(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME LIKE 'hrms\\_performance\\_%' AND COLUMN_NAME IN ('status', 'frequency', 'direction', 'default_frequency', 'entry_frequency'))
      OR (TABLE_NAME = 'hrms_roles' AND COLUMN_NAME = 'performance_frequency'))`);
  ok(types.length >= 7 && types.every((r) => r.d === 'varchar'), 'status, frequency and direction columns are VARCHAR, not ENUM', JSON.stringify(types.filter((r) => r.d !== 'varchar')));

  /* ══ 1. periods ═══════════════════════════════════════════════════════════ */
  section('[1] Periods from an April year');
  {
    const q3 = periodAt('QUARTERLY', 4, 2026, 3);
    const q4 = periodAt('QUARTERLY', 4, 2026, 4);
    const oct = periodFor('MONTHLY', 4, '2026-10-15');
    const mar = periodAt('MONTHLY', 4, 2026, 12);
    const h2 = periodAt('HALF_YEARLY', 4, 2026, 2);
    const y = periodAt('YEARLY', 4, 2026, 1);
    ok(q3.name === 'Q3 2026-27' && q3.start === '2026-10-01' && q3.end === '2026-12-31', 'quarterly: Q3 2026-27 is 1 Oct – 31 Dec 2026', JSON.stringify(q3));
    ok(q4.name === 'Q4 2026-27' && q4.start === '2027-01-01' && q4.end === '2027-03-31', 'quarterly: Q4 2026-27 is 1 Jan – 31 Mar 2027 (the year crosses into 2027)', JSON.stringify(q4));
    ok(oct.name === 'Oct 2026' && oct.start === '2026-10-01' && oct.end === '2026-10-31' && mar.name === 'Mar 2027' && mar.end === '2027-03-31', 'monthly: "Oct 2026"; the twelfth month of 2026-27 is "Mar 2027"');
    ok(h2.name === 'H2 2026-27' && h2.start === '2026-10-01' && h2.end === '2027-03-31', 'half-yearly: H2 2026-27 is Oct – Mar');
    ok(y.name === '2026-27' && y.start === '2026-04-01' && y.end === '2027-03-31', 'yearly: "2026-27" is 1 Apr 2026 – 31 Mar 2027');
    const feb = periodAt('MONTHLY', 4, 2027, 11);
    ok(feb.name === 'Feb 2028' && feb.end === '2028-02-29', 'a leap February ends on the 29th');
    ok(periodAt('QUARTERLY', 1, 2026, 3).name === 'Q3 2026' && periodAt('YEARLY', 1, 2026, 1).name === '2026', 'a January year has no "-27"');
    let contiguous = true;
    for (const f of ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY']) {
      const list = [...periodsOfYear(f, 4, 2025), ...periodsOfYear(f, 4, 2026), ...periodsOfYear(f, 4, 2027)];
      for (let i = 1; i < list.length; i += 1) if (shift(list[i - 1].end, 1) !== list[i].start) contiguous = false;
    }
    ok(contiguous, 'for every frequency, three years of periods follow on day by day: no gaps, no overlaps');
    ok(periodsOfYear('MONTHLY', 4, 2026).length === 12 && periodsOfYear('QUARTERLY', 4, 2026).length === 4 && periodsOfYear('HALF_YEARLY', 4, 2026).length === 2,
      'twelve months, four quarters, two halves');
    ok(periodStartingOn('QUARTERLY', 4, '2026-11-01') === null && periodStartingOn('MONTHLY', 4, '2026-11-01')?.name === 'Nov 2026', 'a quarter does not start on 1 Nov; a month does');
    const bad = await caught(() => PLAN.periodOf(db, COMPANY, { frequency: 'QUARTERLY', start: '2026-11-01' }));
    ok(bad?.code === 'NOT_A_PERIOD', 'asking for a period that does not start there is refused in words', bad?.message);
  }

  /* ══ 2. target parsing ════════════════════════════════════════════════════ */
  section('[2] Targets written as text');
  {
    const cases = [
      ['95%', '', ['HIGHER_BETTER', 95, '%']],
      ['98%', 'Plan vs achievement', ['HIGHER_BETTER', 98, '%']],
      ['1.50%', 'Trim Wastage %', ['LOWER_BETTER', 1.5, '%']],
      ['under 2 hours', '', ['LOWER_BETTER', 2, 'hours']],
      ['< 3', '', ['LOWER_BETTER', 3, null]],
      ['Max 30 minutes', '', ['LOWER_BETTER', 30, 'minutes']],
      ['at least 20', '', ['HIGHER_BETTER', 20, null]],
      ['15 minutes', 'Job Changeover Time', ['LOWER_BETTER', 15, 'minutes']],
      ['6 working hours', '', ['LOWER_BETTER', 6, 'hours']],
      ['2400 MT', 'Quarterly Dispatch', ['HIGHER_BETTER', 2400, 'MT']],
      ['1,50,000 m', 'Total Production', ['HIGHER_BETTER', 150000, 'm']],
      ['200m', 'Job Changeover Wastage', ['LOWER_BETTER', 200, 'm']],
      ['95% Compliance', 'Cylinder Receipt Time', ['HIGHER_BETTER', 95, '%']],
      ['0', 'Customer complaints', ['LOWER_BETTER', 0, null]],
      ['0', 'Something', ['EXACT', 0, null]],
      ['₹50,000', 'Savings', ['HIGHER_BETTER', 50000, '₹']],
    ];
    const wrong = [];
    for (const [text, name, [dir, n, unit]] of cases) {
      const p = parseTargetText(text, { kpiName: name });
      if (!p.parsed || p.direction !== dir || p.number !== n || (p.unit ?? null) !== unit) wrong.push(`${text} -> ${JSON.stringify(p)}`);
    }
    ok(wrong.length === 0, `${cases.length} targets that are clearly a number with a unit parse into direction + number + unit`, wrong.join('; '));
    const words = ['100% adoption by end of Nov\'26', 'Achieve by Nov\'26', '20 leads in Q3', 'Max 3 instances allowed in a month', 'Once in a month', '1) 100% compliance by Dec\'26 2) audit', '90% compliance against all the sales order', ''];
    ok(words.every((w) => !parseTargetText(w).parsed), `${words.length} targets that are words stay words (a date, a second number, a condition)`, words.filter((w) => parseTargetText(w).parsed).join(' | '));
    const structured = planTargetOf({ targetOperator: 'GTE', targetValue: { value: 95 }, measurementType: 'PERCENTAGE', unit: null, name: 'OTIF', targetText: 'at least 95%' });
    const lte = planTargetOf({ targetOperator: 'LTE', targetValue: { value: 2 }, measurementType: 'NUMBER', unit: 'hours', name: 'Response', targetText: 'at most 2 hours' });
    const info = planTargetOf({ targetOperator: 'INFO', targetValue: null, measurementType: 'NUMBER', name: 'x' });
    ok(structured.direction === 'HIGHER_BETTER' && structured.targetNumber === 95 && structured.unit === '%' && lte.direction === 'LOWER_BETTER' && lte.targetNumber === 2 && lte.unit === 'hours'
      && info.direction === 'TEXT' && info.targetText === null, 'a target stored as a number takes its direction from the operator; "no target" stays empty');

    // Karni's own KPI targets, as the role says them today.
    const rows = await q(
      `SELECT d.name, a.target_operator, a.target_value, d.measurement_type, d.unit, d.direction
         FROM hrms_role_kpi_assignments a JOIN hrms_kpi_definitions d ON d.company_id = a.company_id AND d.id = a.kpi_definition_id
        WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.role_id IN (SELECT id FROM hrms_roles WHERE company_id = ? AND title NOT LIKE 'ZZ%')`, [COMPANY, COMPANY]);
    const read = (v) => { if (v == null || typeof v === 'object') return v; try { return JSON.parse(v); } catch { return v; } };
    const results = rows.map((r) => ({ name: r.name, raw: read(r.target_value), t: planTargetOf({ name: r.name, targetOperator: r.target_operator, targetValue: read(r.target_value), measurementType: r.measurement_type, unit: r.unit, direction: r.direction }) }));
    const asText = (raw) => (raw && typeof raw === 'object' ? raw.value : raw);
    const parsedRows = results.filter((r) => r.t.parsed);
    const unparsed = results.filter((r) => !r.t.parsed && r.t.jobTargetText != null);
    note(`Karni KPI targets (role KPI lines in force): ${results.length}; parse to a number: ${parsedRows.length}; kept as words: ${unparsed.length}; no target: ${results.length - parsedRows.length - unparsed.length}`);
    note(`  parsed: ${[...new Set(parsedRows.map((r) => `${asText(r.raw)} [${r.name}] -> ${r.t.direction} ${r.t.targetNumber}${r.t.unit ? ` ${r.t.unit}` : ''}`))].join(' · ')}`);
    note(`  as words: ${[...new Set(unparsed.map((r) => asText(r.raw)))].join(' · ')}`);
    ok(results.length > 0 && parsedRows.length > 0, 'Karni\'s KPI targets were read and some parse', `${results.length}`);
  }

  /* ══ 3. the batched resolver = resolveContent ═════════════════════════════ */
  section('[3] The batched read gives what the one resolver gives');
  {
    const settings = await readSettings(db, COMPANY);
    const start = periodFor('QUARTERLY', settings.yearStartMonth, T).start;
    const sig = (r) => JSON.stringify({
      k: r.kras.map((k) => [k.name, k.lineKey, k.weightPercent, k.layer, k.origin, k.kpis.map((p) => [p.name, p.lineKey, p.targetText, p.weightPercent, p.layer, p.text])]),
      a: r.additional.kpis.map((p) => [p.name, p.lineKey, p.targetText, p.parentKraDefinitionId, p.text]),
    });
    for (const on of [start, T]) {
      const as = await q(`SELECT wa.id, wa.position_id, COALESCE(wa.role_id, p.role_id) AS role_id FROM hrms_work_assignments wa LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
        WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED' AND wa.position_id IS NOT NULL
          AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)`, [COMPANY, on, on]);
      const box = counting();
      const batch = await resolveJobsForAssignments(box.db, COMPANY, as.map((a) => ({ workAssignmentId: a.id, positionId: a.position_id, roleId: a.role_id })), { on });
      let differ = 0;
      for (const a of as) if (sig(await resolveContent(db, COMPANY, { workAssignmentId: a.id, on })) !== sig(batch.get(a.id))) differ += 1;
      ok(as.length > 0 && differ === 0 && box.n <= 8, `on ${on}: ${as.length} people — the batch read (${box.n} queries) and resolveContent per person agree on every KRA and KPI`, `${differ} differ`);
    }
  }

  /* ══ fixture ══════════════════════════════════════════════════════════════ */
  const settings = await readSettings(db, COMPANY);
  const Q = periodFor('QUARTERLY', settings.yearStartMonth, T);
  const S = Q.start;
  const AFTER = T > S ? T : shift(S, 1);        // a change dated after the period start
  const D0 = shift(S, -60);
  const JOIN = shift(S, 40) <= Q.end ? shift(S, 40) : Q.end;
  const dept = async (name) => ins("INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, 'Department')", [COMPANY, `${TAG}${name}`, `${TAG} ${name}`]);
  const D = await dept('D');
  const roleOf = async (code, title, freq) => ins("INSERT INTO hrms_roles (company_id, role_code, title, role_purpose, status, performance_frequency) VALUES (?, ?, ?, 'For a test.', 'ACTIVE', ?)", [COMPANY, `${TAG}${code}`, `${TAG} ${title}`, freq]);
  const R = await roleOf('R', 'Supervisor', 'QUARTERLY');
  const RB = await roleOf('B', 'Incharge', 'QUARTERLY');
  const R0 = await roleOf('Z', 'Cleaner', 'QUARTERLY');      // KRAs only, no KPIs
  const pos = async (code, roleId) => ins("INSERT INTO hrms_positions (company_id, position_code, role_id, position_title, department_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')", [COMPANY, `${TAG}-${code}`, roleId, `${TAG} ${code}`, D]);
  const P = { p: await pos('P', R), p2: await pos('P2', R), m: await pos('M', RB), z: await pos('Z', R0), dh: await pos('DH', RB) };
  const [[primary]] = await db.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [COMPANY]);
  for (const from of [P.p, P.p2, P.z]) await POS.addPositionReporting(db, hr, from, { toPositionId: P.m, relationshipTypeId: primary.id, isPrimary: true, effectiveFrom: D0 });
  const emp = async (code) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, employment_type, employment_status) VALUES (?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE')",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, D0]);
  const seat = async (employeeId, positionId, roleId, from) => ins(
    "INSERT INTO hrms_work_assignments (company_id, employee_id, role_id, position_id, department_id, is_primary, status, effective_from) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', ?)",
    [COMPANY, employeeId, roleId, positionId, D, from]);
  const E = { e: await emp('E'), j: await emp('J'), m: await emp('M'), z: await emp('Z'), dh: await emp('DH'), none: await emp('NONE') };
  await seat(E.e, P.p, R, D0); await seat(E.j, P.p2, R, JOIN); await seat(E.m, P.m, RB, D0); await seat(E.z, P.z, R0, D0); await seat(E.dh, P.dh, RB, D0);

  // The role's job: two KRAs, three KPIs (one under no KRA), dated from D0.
  const kraQ = await J.createRoleKra(db, hr, R, { name: `${TAG} Quality` });
  const kraS = await J.createRoleKra(db, hr, R, { name: `${TAG} Safety` });
  await J.createRoleKra(db, hr, RB, { name: `${TAG} Running the team` });
  await J.createRoleKra(db, hr, R0, { name: `${TAG} Clean floor` });
  const kpiDef = async (text) => (await RC.createMasterItem(db, hr, 'kpis', { name: text, measurementType: 'TEXT', status: 'ACTIVE' })).id;
  const addKpi = async (text, target, kraRow, role = R) => RC.addContent(db, hr, role, 'kpis', { kpiDefinitionId: await kpiDef(text), roleKraAssignmentId: kraRow, targetOperator: 'EQ', targetValue: target });
  const k1 = await addKpi(`${TAG} First pass yield`, '95%', kraQ.id);
  await addKpi(`${TAG} Changeover time`, 'Max 30 minutes', kraS.id);
  await addKpi(`${TAG} Training plan`, 'Roll out by Nov\'26', null);
  await addKpi(`${TAG} Team attendance`, '98%', null, RB);
  for (const t of ['hrms_role_kra_assignments', 'hrms_role_kpi_assignments']) {
    await db.query(`UPDATE ${t} SET effective_from = ? WHERE company_id = ? AND role_id IN (?)`, [D0, COMPANY, [R, RB, R0]]);
  }
  // The person layer, in force on the start: E has a KPI of their own.
  await J.personAddLine(db, OWNERC, E.e, { kind: 'KPI', text: `${TAG} Own target`, target: { operator: 'EQ', value: '12 count' }, takesEffect: shift(S, -10), reason: 'for the test' });
  // …and two changes dated AFTER the start, made before the plans are: neither may reach the plan.
  await RC.updateContent(db, hr, 'kpis', k1.id, { targetOperator: 'EQ', targetValue: '99%', takesEffect: AFTER });
  const ownDef = (await J.employeeJobContent(db, COMPANY, E.e, { on: AFTER })).ungrouped.kpis.find((l) => l.name === `${TAG} Own target`)?.definitionId;
  if (ownDef) await J.personChangeLine(db, hr, E.e, { kind: 'KPI', definitionId: ownDef, target: { operator: 'EQ', value: '20 count' }, takesEffect: AFTER });
  const jobNow = await resolveContent(db, COMPANY, { workAssignmentId: (await one('SELECT id FROM hrms_work_assignments WHERE employee_id = ?', [E.e])).id, on: AFTER });
  const nowK1 = jobNow.kras.flatMap((k) => k.kpis).find((k) => k.name === `${TAG} First pass yield`);
  ok(nowK1?.targetText === '99%', `the fixture: from ${AFTER} the role says 99% (it said 95% on the start, ${S})`, nowK1?.targetText);

  /* ══ 4. settings ═════════════════════════════════════════════════════════ */
  section('[4] Settings and role frequencies');
  {
    ok(settings.yearStartMonth === 4 && settings.defaultFrequency === 'QUARTERLY' && settings.ratingScale.length === 5 && settings.ratingScale[0].label === 'Needs improvement' && settings.ratingScale[4].label === 'Outstanding',
      `${company.name}: April, quarterly, 1 Needs improvement … 5 Outstanding`, JSON.stringify(settings));
    const karniRoles = await q("SELECT title, performance_frequency AS f FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL AND title NOT LIKE 'ZZ%'", [COMPANY]);
    ok(karniRoles.every((r) => r.f === (/\b(?:assistant\s+operator|operator|helper|asst\.?\s+op)s?\b/i.test(r.title) ? 'MONTHLY' : 'QUARTERLY')),
      `every one of ${karniRoles.length} roles has the frequency setup-performance gives it`);
  }

  /* ══ logins and the in-process server ════════════════════════════════════ */
  // The ready-made roles get the new area (the same step setup-access.mjs runs on an existing company).
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
  server.use(express.json({ limit: '10mb' }));
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

  section('[4b] Settings over HTTP');
  {
    const page = await must(O, 'GET', '/performance/settings');
    const fx = page.roles.find((r) => r.id === R0);
    ok(page.yearStartMonth === 4 && page.yearStartMonthName === 'April' && page.frequencies.length === 4 && fx?.frequency === 'QUARTERLY' && fx.effectiveFrequency === 'QUARTERLY',
      'GET /performance/settings: the settings, the four frequencies, every role with its frequency');
    const set = await must(O, 'PUT', '/performance/role-frequencies', { roleIds: [R0], frequency: null });
    ok(set.changed === 1 && set.roles.find((r) => r.id === R0).frequency === null && set.roles.find((r) => r.id === R0).effectiveFrequency === 'QUARTERLY', 'a role set back to the company default reads the default');
    await must(O, 'PUT', '/performance/role-frequencies', { roleIds: [R0], frequency: 'QUARTERLY' });
    const badF = await call(O, 'PUT', '/performance/role-frequencies', { roleIds: [R0], frequency: 'WEEKLY' });
    const badScale = await call(O, 'PUT', '/performance/settings', { ratingScale: ['Only one'] });
    ok(badF.status === 422 && badScale.status === 422 && /two steps/.test(badScale.json?.message ?? ''), 'a frequency that is not one, and a one-step scale, are refused in words');
    const scale = await must(O, 'PUT', '/performance/settings', { ratingScale: ['Low', 'Middle', 'High'] });
    ok(scale.ratingScale.length === 3 && scale.ratingScale[2].value === 3 && scale.ratingScale[2].label === 'High', 'the rating scale is saved in order, valued 1..n');
    await must(O, 'PUT', '/performance/settings', { ratingScale: settings.ratingScale.map((s) => s.label) });
  }

  /* ══ 5. preview and create ════════════════════════════════════════════════ */
  section(`[5] Making plans for ${Q.name} (${Q.start} – ${Q.end})`);
  let created;
  let preview;
  {
    const box = counting();
    const t0 = Date.now();
    preview = await PLAN.previewPlans(box.db, COMPANY, { frequency: 'QUARTERLY', start: S });
    note(`preview ${Q.name}: ${preview.counts.willGet} get a plan (${preview.counts.noKpis} with no KPIs), ${preview.counts.joiners} joined during the period, skipped: ${preview.counts.otherFrequency} on another frequency, ${preview.counts.noPosition} in no position, ${preview.counts.hasPlan} already have one — ${box.n} queries, ${Date.now() - t0} ms locally`);
    const who = (id) => preview.willGet.find((p) => p.employeeId === id);
    ok(who(E.e) && who(E.m) && who(E.z) && who(E.dh), 'the fixture people in a position on the start day, on quarterly roles, get a plan');
    ok(who(E.e).kraCount === 2 && who(E.e).kpiCount === 4, 'E: 2 KRAs and 4 KPIs (3 of the role + 1 of their own)', JSON.stringify(who(E.e)));
    ok(who(E.z).noKpis === true && who(E.z).kraCount === 1, 'a role with KRAs and no KPIs still gets a plan, flagged');
    ok(preview.joiners.some((p) => p.employeeId === E.j && p.joinedOn === JOIN) && !who(E.j), `J joined on ${JOIN}: listed as joined during the period, not given one`);
    ok(preview.skipped.some((p) => p.employeeId === E.none && p.reason === 'NO_POSITION' && p.line), 'a person in no position is skipped, with the reason');
    const monthly = preview.skipped.filter((p) => p.reason === 'OTHER_FREQUENCY');
    ok(monthly.length > 0 && monthly.every((p) => /monthly/.test(p.line)), `${monthly.length} people on monthly roles are skipped: "Their role is on monthly plans."`);
    // 4 reads + the resolver's 6 for each distinct day a job is copied as on (the start, and each joiner's first day).
    const days = new Set([S, ...preview.joiners.map((p) => p.joinedOn)]).size;
    ok(box.n <= 4 + 6 * days, `the preview is a fixed handful of queries (${box.n} for ${days} copy days), whatever the number of people`);

    const box2 = counting();
    const t1 = Date.now();
    created = await PLAN.createPlans(box2.db, hr, { frequency: 'QUARTERLY', start: S });
    const ms = Date.now() - t1;
    note(`create ${Q.name}: ${created.created} plans, ${created.kpis.total} KPIs (${created.kpis.targetsAsNumbers} targets as numbers, ${created.kpis.targetsAsWords} as words) — ${box2.n} queries, ${ms} ms locally; at ~49 ms a round trip ≈ ${Math.round(box2.n * 49 / 100) / 10} s on production`);
    ok(created.created === preview.counts.willGet && box2.n <= 19 + 6 * days, /* +5 fixed reads since §40: unit heads and Reports into, once per create — not per person */ `create: ${created.created} plans in ${box2.n} queries (no query per person)`);
    const again = await PLAN.createPlans(db, hr, { frequency: 'QUARTERLY', start: S });
    ok(again.created === 0, 'create again: nobody gets a second plan (idempotent)');
    const pv2 = await PLAN.previewPlans(db, COMPANY, { frequency: 'QUARTERLY', start: S });
    ok(pv2.counts.willGet === 0 && pv2.counts.hasPlan === created.created, 'the preview now lists all of them as "already has a plan"');
    const joinerOnly = await PLAN.createPlans(db, hr, { frequency: 'QUARTERLY', start: S, employeeIds: [E.j] });
    const jp = joinerOnly.plans[0];
    ok(joinerOnly.created === 1 && jp.employeeId === E.j && jp.copiedOn === JOIN && jp.kpiCount === 3, `the joiner is given a plan from the same screen, copied as on their first day (${JOIN})`, JSON.stringify(jp));
    const notOurs = await caught(() => PLAN.createPlans(db, hr, { frequency: 'QUARTERLY', start: S, employeeIds: [999999999] }));
    ok(notOurs?.status === 422, 'creating for somebody who is not in the company is refused');
    const periodRow = await one('SELECT * FROM hrms_performance_periods WHERE company_id = ? AND frequency = ? AND start_date = ?', [COMPANY, 'QUARTERLY', S]);
    ok(periodRow?.name === Q.name && periodRow.status === 'OPEN', `the period ${Q.name} was made on demand`);
    const moved = await caught(() => import('../../apps/cf_hrms/services/performance/settingsService.js').then((m) => m.saveSettings(db, hr, { yearStartMonth: 1 })));
    ok(moved?.code === 'PERIODS_EXIST', 'the year start cannot move once periods exist', moved?.message);
    const mon = await PLAN.previewPlans(db, COMPANY, { frequency: 'MONTHLY', start: periodFor('MONTHLY', 4, T).start });
    note(`preview ${mon.period.name} (monthly): ${mon.counts.willGet} get a plan, ${mon.counts.otherFrequency} on another frequency`);
    ok(mon.counts.willGet === monthly.length, 'the monthly preview gets exactly the people the quarterly one skipped as monthly');
  }

  const planOf = async (employeeId) => (await one("SELECT id FROM hrms_performance_plans WHERE company_id = ? AND employee_id = ? AND status <> 'CANCELLED' ORDER BY id DESC LIMIT 1", [COMPANY, employeeId])).id;
  const planE = await planOf(E.e);

  /* ══ 6. copied as on the period start ═════════════════════════════════════ */
  section('[6] Copied as the job stood on the period start');
  {
    const p = await PLAN.readPlan(db, COMPANY, planE, { edit: true, cancel: true });
    const all = [...p.kras.flatMap((k) => k.kpis), ...p.ungroupedKpis];
    const first = all.find((k) => k.name === `${TAG} First pass yield`);
    const own = all.find((k) => k.name === `${TAG} Own target`);
    const words = all.find((k) => k.name === `${TAG} Training plan`);
    const ct = all.find((k) => k.name === `${TAG} Changeover time`);
    ok(p.kras.map((k) => k.name).join('|') === `${TAG} Quality|${TAG} Safety` && p.kras[0].kpis.length === 1 && p.kras[1].kpis.length === 1 && p.ungroupedKpis.length === 2,
      'the KRA headings and their KPIs, in the job\'s order; KPIs under no KRA are kept apart');
    ok(first?.targetNumber === 95 && first.unit === '%' && first.direction === 'HIGHER_BETTER' && first.mark === 'FROM_JOB' && first.job.target === '95%',
      `the role's change to 99% from ${AFTER} did not reach the plan: it says 95% (the job on ${S})`, JSON.stringify(first));
    ok(own?.targetNumber === 12 && own.unit === 'count', 'the person layer is in the plan, as it stood on the start (12, not the 20 from later)', JSON.stringify(own));
    ok(ct?.direction === 'LOWER_BETTER' && ct.targetNumber === 30 && ct.unit === 'minutes' && ct.target === 'at most 30 minutes', '"Max 30 minutes" became lower-is-better, 30 minutes');
    ok(words?.direction === 'TEXT' && words.targetText === 'Roll out by Nov\'26' && words.target === 'Roll out by Nov\'26', 'a target written as words stays words');
    ok(p.plan.copiedOn === S && p.plan.positionCode === `${TAG}-P` && p.plan.departmentName === `${TAG} D` && p.plan.manager?.positionId === P.m && p.plan.manager.name === `${TAG} Person M`,
      'the plan keeps the position held on the start, its department and the manager', JSON.stringify(p.plan.manager));
  }

  /* ══ 7. editing ═══════════════════════════════════════════════════════════ */
  section('[7] Draft, weights, activate, a dated target change, cancel, close');
  {
    let p = await PLAN.readPlan(db, COMPANY, planE, { edit: true, cancel: true });
    const [kq, ks] = p.kras;
    const first = kq.kpis[0];
    ok(p.plan.status === 'DRAFT' && p.plan.can.edit && p.plan.can.activate && !p.plan.can.changeTarget && p.plan.weights.ok, 'a new plan is a draft; no weights set is fine');
    await PLAN.setKraWeight(db, hr, planE, kq.id, { weightPercent: 60 });
    p = await PLAN.readPlan(db, COMPANY, planE, { edit: true });
    ok(!p.plan.weights.ok && p.plan.weights.total === 60 && p.plan.weights.problems.length === 2, 'one weight set: the total (60%) and the KRA without a weight are both listed', JSON.stringify(p.plan.weights));
    const notReady = await caught(() => PLAN.activatePlan(db, hr, planE));
    ok(notReady?.code === 'NOT_READY' && notReady.problems?.some((x) => /add up to 60%/.test(x)), 'activate is refused until the weights add up to 100', notReady?.message);
    await PLAN.setKraWeight(db, hr, planE, ks.id, { weightPercent: 40 });
    p = await PLAN.readPlan(db, COMPANY, planE, { edit: true });
    ok(p.plan.weights.ok && p.plan.weights.total === 100 && p.kras[0].mark === 'CHANGED', 'weights 60 + 40: OK; a KRA weight that differs from the job is marked changed');
    const badW = await caught(() => PLAN.setKraWeight(db, hr, planE, kq.id, { weightPercent: 140 }));
    ok(badW?.status === 422, 'a weight over 100 is refused');

    await PLAN.changeKpi(db, hr, planE, first.id, { targetNumber: 97 });
    p = await PLAN.readPlan(db, COMPANY, planE, { edit: true });
    let k = p.kras[0].kpis[0];
    ok(k.mark === 'CHANGED' && k.target === 'at least 97%' && k.job.target === '95%', 'a target changed on a draft: "changed for this period", showing what the job says', JSON.stringify(k));
    await PLAN.changeKpi(db, hr, planE, first.id, { targetNumber: 95 });
    k = (await PLAN.readPlan(db, COMPANY, planE, {})).kras[0].kpis[0];
    ok(k.mark === 'FROM_JOB', 'set back to what the job says: "from the job" again');
    const rename = await caught(() => PLAN.changeKpi(db, hr, planE, first.id, { name: 'Something else' }));
    ok(rename?.status === 422, 'a KPI from the job keeps its wording');
    const added = await PLAN.addKpi(db, hr, planE, { planKraId: ks.id, name: `${TAG} Near misses reported`, direction: 'HIGHER_BETTER', targetNumber: 4, unit: 'count', frequency: 'MONTHLY' });
    p = await PLAN.readPlan(db, COMPANY, planE, {});
    const ak = p.kras[1].kpis.find((x) => x.id === added.id);
    ok(ak?.mark === 'ADDED' && ak.job === null && ak.frequency === 'MONTHLY' && ak.target === 'at least 4 count', 'a KPI added for this period: "added", under its KRA, measured monthly');
    const badAdd = await caught(() => PLAN.addKpi(db, hr, planE, { name: 'x', direction: 'HIGHER_BETTER' }));
    ok(badAdd?.status === 422 && /number/.test(badAdd.message), 'a KPI with a direction but no number is refused in words');
    const extra = await PLAN.addKpi(db, hr, planE, { name: `${TAG} To remove`, direction: 'TEXT', targetText: 'Keep it tidy' });
    await PLAN.removeKpi(db, hr, planE, extra.id);
    const removedRow = await one('SELECT deleted_at FROM hrms_performance_plan_kpis WHERE id = ?', [extra.id]);
    p = await PLAN.readPlan(db, COMPANY, planE, {});
    ok(removedRow?.deleted_at && !p.ungroupedKpis.some((x) => x.id === extra.id), 'remove a KPI from a draft: gone from the plan, the row kept');

    await PLAN.activatePlan(db, hr, planE);
    p = await PLAN.readPlan(db, COMPANY, planE, { edit: true, cancel: true });
    ok(p.plan.status === 'ACTIVE' && !p.plan.can.edit && p.plan.can.changeTarget && p.plan.can.cancel, 'activated: no longer editable; a target can change; it can be cancelled');
    const locked = await Promise.all([
      caught(() => PLAN.addKpi(db, hr, planE, { name: 'x', direction: 'TEXT', targetText: 'y' })),
      caught(() => PLAN.removeKpi(db, hr, planE, first.id)),
      caught(() => PLAN.setKraWeight(db, hr, planE, kq.id, { weightPercent: 50 })),
      caught(() => PLAN.changeKpi(db, hr, planE, first.id, { targetNumber: 90 })),
    ]);
    ok(locked.every((e) => e?.code === 'NOT_DRAFT'), 'activate locks the list: add, remove, weight and a plain change are each refused (409 NOT_DRAFT)', locked.map((e) => e?.code).join(' '));
    const noReason = await caught(() => PLAN.changeTarget(db, hr, planE, first.id, { targetNumber: 96 }));
    const past = await caught(() => PLAN.changeTarget(db, hr, planE, first.id, { targetNumber: 96, reason: 'r', effectiveFrom: shift(T, -1) }));
    const outside = await caught(() => PLAN.changeTarget(db, hr, planE, first.id, { targetNumber: 96, reason: 'r', effectiveFrom: shift(Q.end, 1) }));
    ok(noReason?.status === 422 && /why/.test(noReason.message) && past?.status === 422 && outside?.status === 422,
      'a target change after activation needs a reason, a day not passed, a day inside the period', [noReason?.message, past?.message, outside?.message].join(' | '));
    const auditBefore = (await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_performance_plan_kpis' AND entity_id = ?", [COMPANY, first.id])).n;
    const changed = await PLAN.changeTarget(db, hr, planE, first.id, { targetNumber: 96, reason: 'New machine from next week', effectiveFrom: T });
    p = await PLAN.readPlan(db, COMPANY, planE, {});
    k = p.kras[0].kpis[0];
    const auditAfter = (await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_performance_plan_kpis' AND entity_id = ?", [COMPANY, first.id])).n;
    ok(changed.effectiveFrom === T && k.target === 'at least 96%' && k.mark === 'CHANGED' && k.targetChanges.length === 1
      && k.targetChanges[0].from === 'at least 95%' && k.targetChanges[0].to === 'at least 96%' && k.targetChanges[0].reason === 'New machine from next week' && Number(auditAfter) === Number(auditBefore) + 1,
    'the target changes from a date, with a reason; the change is kept as its own row and audited', JSON.stringify(k.targetChanges));
    const earlier = await caught(() => PLAN.changeTarget(db, OWNERC, planE, first.id, { targetNumber: 97, reason: 'r', effectiveFrom: shift(T, -1) }));
    ok(earlier?.status === 422 && /last changed/.test(earlier.message), 'not before the last change, even for the Owner', earlier?.message);

    const periodIdE = (await one('SELECT period_id FROM hrms_performance_plans WHERE id = ?', [planE])).period_id;
    const closeRefused = await caught(() => PLAN.closePeriod(db, hr, periodIdE));
    ok(closeRefused?.code === 'DRAFTS_OPEN', 'the period cannot be closed while plans are still drafts', closeRefused?.message);

    // Cancel instead of delete: kept, and the person may be given a new one.
    const planZ = await planOf(E.z);
    await PLAN.cancelPlan(db, hr, planZ, { reason: 'made by mistake' });
    const zRow = await one('SELECT status, cancel_reason, deleted_at FROM hrms_performance_plans WHERE id = ?', [planZ]);
    ok(zRow.status === 'CANCELLED' && zRow.cancel_reason === 'made by mistake' && zRow.deleted_at === null, 'cancel: the plan is CANCELLED with its reason, never deleted');
    const again = await PLAN.createPlans(db, hr, { frequency: 'QUARTERLY', start: S, employeeIds: [E.z] });
    ok(again.created === 1 && again.plans[0].id !== planZ, 'a cancelled plan frees the slot: the person can be given a new one');
    const cancelTwice = await caught(() => PLAN.cancelPlan(db, hr, planZ, {}));
    ok(cancelTwice?.code === 'NOT_CANCELLABLE', 'a cancelled plan cannot be cancelled again');
  }

  /* ══ 8. rights and scope, over HTTP ═══════════════════════════════════════ */
  section('[8] Rights and scope');
  {
    const periodId = (await one('SELECT period_id FROM hrms_performance_plans WHERE id = ?', [planE])).period_id;
    const list = await must(O, 'GET', `/performance/plans?periodId=${periodId}`);
    ok(list.items.length === list.total && list.items.some((r) => r.id === planE) && !list.items.some((r) => r.status === 'CANCELLED'), `the Owner lists ${list.total} plans of the period; cancelled ones only when asked`);
    const cancelled = await must(O, 'GET', `/performance/plans?periodId=${periodId}&status=CANCELLED`);
    ok(cancelled.items.length === 1 && cancelled.items[0].status === 'CANCELLED', '?status=CANCELLED lists the cancelled plan');
    const draft = await must(O, 'GET', `/performance/plans?periodId=${periodId}&status=DRAFT&department=${D}`);
    ok(draft.items.length > 0 && draft.items.every((r) => r.status === 'DRAFT' && r.departmentId === D), 'filters: status and department');
    const periods = await must(O, 'GET', '/performance/periods?frequency=QUARTERLY');
    const cur = periods.periods.find((x) => x.start === S);
    ok(periods.periods.length === 4 && cur?.made && cur.current && cur.planCount === list.total, 'GET /performance/periods: four quarters, the current one made, with its plan count');

    // HR executive: view + edit, no remove.
    const hx1 = await call(U.HRX, 'GET', `/performance/plans/${planE}`);
    const hx2 = await call(U.HRX, 'POST', `/performance/plans/${planE}/cancel`, {});
    const hx3 = await call(U.HRX, 'PUT', '/performance/settings', { defaultFrequency: 'MONTHLY' });
    ok(hx1.status === 200 && hx1.json.plan.can.changeTarget && !hx1.json.plan.can.cancel && hx2.status === 403 && hx3.status === 403,
      'HR executive: reads a plan and may change a target; may not cancel (remove) nor change the settings', `${hx1.status} ${hx2.status} ${hx3.status}`);
    // Employee: no performance area at all; their own plan through My place.
    const em1 = await call(U.EMP, 'GET', '/performance/plans');
    const em2 = await call(U.EMP, 'GET', `/performance/plans/${planE}`);
    const mine = await call(U.EMP, 'GET', '/user/me/plan');
    ok(em1.status === 403 && em2.status === 403 && mine.status === 200 && mine.json.plans.length === 1 && mine.json.plans[0].plan.id === planE && !mine.json.plans[0].plan.can.edit,
      'Employee: no plans screen (403); "My plan" shows their own current plan, read-only', `${em1.status} ${em2.status} ${mine.status}`);
    // Department head: their department only.
    const karniPlan = list.items.find((r) => r.departmentId !== D);
    const dh1 = await call(U.DH, 'GET', `/performance/plans?periodId=${periodId}`);
    const dh2 = karniPlan ? await call(U.DH, 'GET', `/performance/plans/${karniPlan.id}`) : { status: 403, json: { code: 'OUT_OF_SCOPE' } };
    const dh3 = await call(U.DH, 'GET', `/performance/plans/${planE}`);
    const dhPreview = await call(U.DH, 'POST', '/performance/plans/preview', { frequency: 'QUARTERLY', start: S });
    const dhClose = await call(U.DH, 'POST', `/performance/periods/${periodId}/close`, {});
    ok(dh1.status === 200 && dh1.json.items.length > 0 && dh1.json.items.every((r) => r.departmentId === D) && dh2.status === 403 && dh2.json?.code === 'OUT_OF_SCOPE' && dh3.status === 200
      && dhPreview.status === 200 && [...dhPreview.json.skipped, ...dhPreview.json.willGet, ...dhPreview.json.joiners].every((x) => x.departmentId === D || x.departmentId == null) && dhClose.status === 403,
    'Department head: lists and opens plans of their own department only (403 OUT_OF_SCOPE outside), previews only their people, cannot close a period', `${dh1.status} ${dh2.status} ${dh3.status} ${dhPreview.status} ${dhClose.status}`);

    // A manager login (self view only): the drafts of people below them.
    const planJ = await planOf(E.j);
    const planZ2 = await planOf(E.z);   // the new draft made after the cancel
    const planM = await planOf(E.m);
    const team = await call(U.MGR, 'GET', '/user/me/team/plans');
    ok(team.status === 200 && team.json.items.some((r) => r.id === planZ2) && team.json.items.some((r) => r.id === planE) && !team.json.items.some((r) => r.id === planM) && !team.json.items.some((r) => r.id === planJ),
      `manager login: lists the plans of the people below them TODAY, not their own (J joins on ${JOIN}, so is not below them yet)`, JSON.stringify(team.json?.items?.map((r) => r.employeeName)));
    const mj = await call(U.MGR, 'GET', `/user/me/team/plans/${planZ2}`);
    ok(mj.status === 200 && mj.json.plan.can.edit && !mj.json.plan.can.activate && !mj.json.plan.can.cancel, 'manager login: opens a report\'s draft, may edit, may not activate or cancel');
    const addJ = await call(U.MGR, 'POST', `/user/me/team/plans/${planZ2}/kpis`, { name: `${TAG} Manager's KPI`, direction: 'TEXT', targetText: 'Lead the 5S audit' });
    const ed = await call(U.MGR, 'PUT', `/user/me/team/plans/${planZ2}/kpis/${addJ.json?.id}`, { direction: 'HIGHER_BETTER', targetNumber: 90, unit: '%' });
    const wJ = await call(U.MGR, 'PUT', `/user/me/team/plans/${planZ2}/kras/${mj.json.kras[0].id}`, { weightPercent: 100 });
    ok(ed.status === 200 && addJ.status === 200 && wJ.status === 200, 'manager login: changes a target, adds a KPI and sets a weight on a report\'s draft', `${ed.status} ${addJ.status} ${wJ.status}`);
    const ownM = await call(U.MGR, 'GET', `/user/me/team/plans/${planM}`);
    const ownEdit = await call(U.MGR, 'POST', `/user/me/team/plans/${planM}/kpis`, { name: 'x', direction: 'TEXT', targetText: 'y' });
    ok(ownM.status === 403 && ownM.json?.code === 'NOT_YOUR_TEAM' && ownEdit.status === 403, 'manager login: not over their own plan (403 NOT_YOUR_TEAM)', `${ownM.status} ${ownM.json?.message}`);
    const hrRoute = await call(U.MGR, 'POST', `/performance/plans/${planJ}/activate`, {});
    ok(hrRoute.status === 403, 'manager login: the HR activate route is closed to them');
    const activeE = await call(U.MGR, 'PUT', `/user/me/team/plans/${planE}/kpis/${(await PLAN.readPlan(db, COMPANY, planE, {})).kras[0].kpis[0].id}`, { targetNumber: 80 });
    ok(activeE.status === 409 && activeE.json?.code === 'NOT_DRAFT', 'manager login: an ACTIVE plan of a report is not theirs to change (409 NOT_DRAFT)');
    const outsider = list.items.find((r) => r.departmentId !== D);
    const mo = outsider ? await call(U.MGR, 'GET', `/user/me/team/plans/${outsider.id}`) : { status: 403 };
    ok(mo.status === 403, 'manager login: a plan of somebody not below them is refused');
    const empTeam = await call(U.EMP, 'GET', '/user/me/team/plans');
    ok(empTeam.status === 403 || (empTeam.status === 200 && empTeam.json.items.length === 0), 'an employee with nobody below them has no team plans');

    // Bulk: activate many, each on its own terms.
    const bulk = await must(O, 'POST', '/performance/plans/activate', { ids: [planJ, planM, planE] });
    ok(bulk.done === 2 && bulk.refused.length === 1 && bulk.refused[0].id === planE && bulk.refused[0].code === 'NOT_DRAFT', 'activate selected: the drafts are activated, the active one is listed as refused with its reason', JSON.stringify(bulk.refused));
    const dhBulk = karniPlan ? await call(U.DH, 'POST', '/performance/plans/activate', { ids: [karniPlan.id] }) : null;
    ok(!dhBulk || (dhBulk.status === 200 && dhBulk.json.done === 0 && dhBulk.json.refused[0]?.code === 'OUT_OF_SCOPE'), 'a Department head cannot activate a plan outside their department in bulk either');
    const hxBulk = await call(U.HRX, 'POST', '/performance/plans/cancel', { ids: [planJ] });
    ok(hxBulk.status === 403, 'bulk cancel needs the remove right');
    const empPlans = await must(O, 'GET', `/performance/employees/${E.e}/plans`);
    ok(empPlans.current.length === 1 && empPlans.current[0].id === planE, 'the employee page: the current plan');
  }

  /* ══ 9. tenant isolation ══════════════════════════════════════════════════ */
  section('[9] Tenant isolation');
  if (!THEM) skip('tenant isolation', 'no second company with an admin login');
  else {
    const t1 = await call(THEM, 'GET', `/performance/plans/${planE}`, undefined, { as: other.slug });
    const kraId = (await PLAN.readPlan(db, COMPANY, planE, {})).kras[0].id;
    const t2 = await call(THEM, 'PUT', `/performance/plans/${planE}/kras/${kraId}`, { weightPercent: 1 }, { as: other.slug });
    const t3 = await call(THEM, 'GET', '/performance/plans', undefined, { as: other.slug });
    const t4 = await call(THEM, 'POST', `/performance/plans/${planE}/cancel`, {}, { as: other.slug });
    const t5 = await call(THEM, 'GET', `/performance/employees/${E.e}/plans`, undefined, { as: other.slug });
    const t6 = await call(THEM, 'PUT', '/performance/role-frequencies', { roleIds: [R], frequency: 'MONTHLY' }, { as: other.slug });
    ok(t1.status === 404 && t2.status === 404 && t3.status === 200 && !(t3.json.items ?? []).some((r) => r.id === planE) && t4.status === 404 && t6.status === 404
      && (t5.status === 404 || (t5.status === 200 && t5.json.current.length === 0)),
    'another company: cannot open, change, cancel or list our plans, nor set our role\'s frequency', `${t1.status} ${t2.status} ${t3.status} ${t4.status} ${t5.status} ${t6.status}`);
    const p = await PLAN.readPlan(db, COMPANY, planE, {});
    ok(p.plan.status === 'ACTIVE' && (await one('SELECT performance_frequency AS f FROM hrms_roles WHERE id = ?', [R])).f === 'QUARTERLY', 'and ours are unchanged');
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
  ok(moved.length === 0, `every count is what it was (${TABLES.length} tables and every role's frequency)`, moved.map((k) => `${k} ${String(before[k]).slice(0, 40)} -> ${String(after[k]).slice(0, 40)}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
