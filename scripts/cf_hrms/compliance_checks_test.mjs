/**
 * compliance_checks_test.mjs — checks, compliance to-dos with a proposed fix, the bonus run
 * (TM/CF_HRMS_HIRING_SPEC.md §36.2, §36.3, C2).
 *
 *   0. the schema: apply-compliance-checks-schema has nothing left to do; every table company_id + deleted_at
 *   1. the checks, pure, hand-worked:
 *        Staff standard at a CTC of ₹1,84,000 (₹15,333.33 a month): Basic 40% 6,133.33, HRA 3,066.67, conveyance
 *        1,600, medical 1,250, employer PF round(12% × 6,133.33) = 736, Special the balance 2,547.33.
 *        Remuneration 15,333.33 (employer PF counted); wages (basic) 6,133.33 = 40%; excluded 9,200 → the s.2(y)
 *        add-back 9,200 − 7,666.67 = 1,533.33 → wages 7,666.67. Telangana zone I unskilled: 16,000 → short 8,333.33:
 *        HARD with a verified rule, WARN with the seed's unverified one.
 *        Raise the CTC: wages = half of the CTC here (excluded > half) → a month of 32,000 → ₹3,84,000 a year.
 *        Basic 15,000 + HRA 7,500 + Special 9,000 vs 15,500: add-back 750 → 15,750 passes; basic alone 15,000 → WARN.
 *        Overtime 1.5× → HARD; 51.67 h in a quarter against 50 → WARN. Leave: one day per 25 days worked → HARD;
 *        12 days a year → WARN (owed 14: 312 − 8 holidays − 14 = 290 ÷ 20 = 14).
 *        Bonus: 6 months × wages 10,000, ceiling 7,000, 8.33% → 42,000 × 8.33% = 3,498.6 → 3,499; ceiling 16,000 →
 *        60,000 → 4,998; 20% → 8,400; 15 of 30 days, wages 5,000 → capped at 3,500; 25 days in the year → not
 *        eligible; full-month wages 25,000 > 21,000 → month not counted; a tiny bonus → ₹100.
 *   2. Karni, in one transaction (rolled back): a person P (₹1,84,000, role skill unskilled, location zone I):
 *        the structure editor's live check; salary save refused (HARD) or allowed with a reason (WARN, kept with the
 *        approver); the run's compliance panel blocks the lock (HARD), then a WARN needs an acknowledgement;
 *        onPublish makes a to-do; the statutory top-up after the deadline; remedy (a) keeps CTC and reaches 50%;
 *        remedy (b) shows the cost; maker-checker; applied as a dated salary row with arrears; the bonus run
 *        (eligibility, ceiling, rate, payment, register, late warning); leave and attendance policies; rights;
 *        tenant isolation
 *   3. nothing is left behind (company tables with company_id and deleted_at)
 *
 *   node scripts/cf_hrms/compliance_checks_test.mjs [--company=karni] [--verbose]
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf, ensureCatalog, setRoleTags } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import { areaTag } from '../../apps/cf_hrms/lib/access.js';
import * as LAW from '../../apps/cf_hrms/services/law/index.js';
import * as K from '../../apps/cf_hrms/services/complianceChecks/checks.js';
import * as CC from '../../apps/cf_hrms/services/complianceChecks/index.js';
import * as T from '../../apps/cf_hrms/services/complianceChecks/todos.js';
import * as BONUS from '../../apps/cf_hrms/services/complianceChecks/bonus.js';
import { breakdown } from '../../apps/cf_hrms/services/payroll/structure.js';
import { loadComponents, loadStructures } from '../../apps/cf_hrms/services/payroll/common.js';
import * as LEAVE from '../../apps/cf_hrms/services/leavePolicyService.js';
import * as ATT from '../../apps/cf_hrms/services/attendance/policy.js';
import { dateText } from '../../apps/cf_hrms/services/complianceChecks/context.js';
import { schemaSteps, CHECKS_TABLES } from '../../apps/cf_hrms/scripts/apply-compliance-checks-schema.mjs';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 700)}` : ''}`); }
  return Boolean(cond);
};
const section = (title) => console.log(`\n${title}`);
const started = Date.now();
const near = (a, b, d = 0.02) => Math.abs(Number(a) - Number(b)) <= d;
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/* ══ the snapshot: company tables with company_id and deleted_at ═══════ */
const SNAP = [...CHECKS_TABLES, 'hrms_pay_salaries', 'hrms_pay_items', 'hrms_pay_runs', 'hrms_pay_run_people', 'hrms_pay_run_lines', 'hrms_pay_structures', 'hrms_pay_structure_lines',
  'hrms_pay_components', 'hrms_role_law', 'hrms_location_law', 'hrms_leave_policies', 'hrms_attendance_policies'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of SNAP) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live, COALESCE(MAX(updated_at), 0) AS u FROM ${t}`);
      out[t] = `${r.n}/${r.live}/${r.u}`;
    }
    return out;
  } finally { await conn.end(); }
}

section('[0] The schema');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok(CHECKS_TABLES.length === 5, 'init.sql §39 declares five tables', CHECKS_TABLES.join(','));
    ok((await schemaSteps(conn)).length === 0, 'apply-compliance-checks-schema: nothing left to do (tables and the STAT_TOPUP component are there)');
    const [cols] = await conn.query("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) AND COLUMN_NAME IN ('company_id', 'deleted_at')", [CHECKS_TABLES]);
    ok(CHECKS_TABLES.every((t) => cols.filter((c) => c.TABLE_NAME === t).length === 2), 'every table has company_id and deleted_at');
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ══ 1. pure ═════════════════════════════════════════════════════════ */
section('[1] The checks, hand-worked');
{
  const VER = { id: 9001, domain: 'MIN_WAGE', jurisdiction: 'TG', ruleKey: 'ALL_EMPLOYMENTS', title: 'TG minimum wages', effectiveFrom: '2026-06-01', version: 9, verified: true };
  const UNV = { ...VER, verified: false };
  const WR = { id: 23, domain: 'WAGES', ruleKey: 'fifty_percent_rule', title: '50% rule', verified: true, value: { excludedSharePct: 50 } };
  const L = [
    { code: 'BASIC', kind: 'EARNING', amount: 6133.33 }, { code: 'HRA', kind: 'EARNING', amount: 3066.67 }, { code: 'CONVEYANCE', kind: 'EARNING', amount: 1600 },
    { code: 'MEDICAL', kind: 'EARNING', amount: 1250 }, { code: 'PF_ER', kind: 'EMPLOYER_CONTRIBUTION', statutoryKey: 'PF_ER', amount: 736 }, { code: 'SPECIAL', kind: 'EARNING', amount: 2547.33 },
    { code: 'ESI_ER', kind: 'EMPLOYER_CONTRIBUTION', statutoryKey: 'ESI_ER', amount: 499 }, { code: 'PF_EE', kind: 'DEDUCTION', statutoryKey: 'PF_EE', amount: 736 },
  ];
  const w = K.wagesOf(L);
  ok(near(w.wages, 6133.33) && near(w.excluded, 9200) && near(w.remuneration, 15333.33) && near(w.addBack, 1533.33) && near(w.codeWages, 7666.67) && near(w.ratio, 0.4, 0.0001),
    's.2(y): wages 6,133.33 of 15,333.33 (40%); add-back 1,533.33 → 7,666.67 (ESI employer and deductions not counted)', JSON.stringify(w));
  const mw = { found: true, wage: { total: 16000, basic: 16000, vda: null, vdaPending: true, zone: 'I', skill: 'UNSKILLED' }, rule: VER };
  const hard = K.checkMinimumWage({ lines: L, minWage: mw, place: { state: 'TG' }, wagesRule: WR });
  ok(hard.length === 1 && hard[0].check === 'MIN_WAGE' && hard[0].severity === 'HARD' && near(hard[0].numbers.shortBy, 8333.33) && /Short by ₹8,333.33/.test(hard[0].message) && hard[0].rule.id === 9001 && hard[0].rule.effectiveFrom === '2026-06-01',
    'minimum wage: 7,666.67 against 16,000 → HARD, short by 8,333.33, naming the rule, its date and source', JSON.stringify(hard[0]));
  const warn = K.checkMinimumWage({ lines: L, minWage: { ...mw, rule: UNV }, place: { state: 'TG' }, wagesRule: WR });
  ok(warn[0].severity === 'WARN' && warn[0].hardIfVerified === true && /not verified/.test(warn[0].unverifiedNote), 'the same against an UNVERIFIED rule: WARN only, and it says so');
  const half = K.checkMinimumWage({ lines: [{ code: 'BASIC', kind: 'EARNING', amount: 8000 }], minWage: mw, factor: 0.5, place: { state: 'TG' } });
  ok(half.length === 0, 'prorated: 15 of 30 days, the minimum is 8,000 — wages of 8,000 meet it');
  const basicOnly = K.checkMinimumWage({ lines: [{ code: 'BASIC', kind: 'EARNING', amount: 15000 }, { code: 'HRA', kind: 'EARNING', amount: 7500 }, { code: 'SPECIAL', kind: 'EARNING', amount: 9000 }], minWage: { ...mw, wage: { ...mw.wage, total: 15500 } }, place: { state: 'TG' } });
  ok(basicOnly.length === 1 && basicOnly[0].check === 'MIN_WAGE_BASIC' && basicOnly[0].severity === 'WARN' && near(basicOnly[0].numbers.codeWages, 15750), 'basic 15,000 + add-back 750 = 15,750 ≥ 15,500 passes; basic alone below → WARN', JSON.stringify(basicOnly[0]?.numbers));
  ok(K.checkMinimumWage({ lines: L, minWage: { found: false, reason: 'The location has no minimum-wage zone.' } })[0].severity === 'INFO', 'no zone: the minimum wage cannot be checked (INFO, never a block)');
  const fifty = K.checkFiftyPercent({ lines: L, rule: WR });
  ok(fifty.length === 1 && fifty[0].severity === 'WARN' && fifty[0].numbers.ratio === 40 && near(fifty[0].numbers.addBack, 1533.33) && fifty[0].numbers.counted.join() === 'BASIC' && fifty[0].numbers.excluded.includes('SPECIAL') && fifty[0].numbers.excluded.includes('PF_ER'),
    'the 50% rule: 40% → WARN, Basic counted, HRA / conveyance / medical / special / employer PF excluded', JSON.stringify(fifty[0]?.numbers));
  ok(K.checkFiftyPercent({ lines: [{ code: 'BASIC', kind: 'EARNING', amount: 10000 }, { code: 'HRA', kind: 'EARNING', amount: 10000 }], rule: WR }).length === 0, '50 / 50: no warning');
  const OT = { id: 31, domain: 'OVERTIME', ruleKey: 'rate', title: 'OSH Code', verified: true, value: { multiplier: 2, dailyHours: 8, weeklyHours: 48 } };
  ok(K.checkOvertimeRate({ multiplier: 1.5, rule: OT })[0]?.severity === 'HARD' && K.checkOvertimeRate({ multiplier: 2, rule: OT }).length === 0 && K.checkOvertimeRate({ multiplier: 1.5, rule: { ...OT, verified: false } })[0]?.severity === 'WARN',
    'overtime at 1.5× → HARD (2× is the law); 2× → nothing; against an unverified rule → WARN');
  const CAP = { id: 32, domain: 'OVERTIME', ruleKey: 'quarterly_cap', title: 'TG cap', verified: false, value: { hours: 50 } };
  const hrs = K.checkOvertimeHours({ quarterMinutes: 3100, quarterLabel: 'Q4 2026', rateRule: OT, capRule: CAP });
  ok(hrs.length === 1 && hrs[0].severity === 'WARN' && hrs[0].numbers.hours === 51.67 && K.checkOvertimeHours({ quarterMinutes: 2900, rateRule: OT, capRule: CAP }).length === 0, 'overtime hours: 51.67 h in a quarter against 50 → WARN; 48.33 h → nothing');
  const daily = K.checkOvertimeHours({ days: [{ date: '2026-10-05', workedMinutes: 660 }, { date: '2026-10-06', workedMinutes: 480 }], rateRule: { ...OT, value: { ...OT.value, maxDailyWithOvertime: 10, maxWeeklyWithOvertime: 60 } } });
  ok(daily.length === 1 && daily[0].numbers.limit === 'DAY' && daily[0].numbers.days === 1, 'a day of 11 hours against 10 → WARN (the Factories Act limits, when in force)');
  const LV = { id: 41, domain: 'LEAVE_MIN', ruleKey: 'annual_leave_factory', title: 'OSH Code s.32', verified: true, value: { daysWorkedPerLeaveDay: 20 } };
  ok(K.annualLeaveOwed(20) === 14, 'a full year earns 14 days at one per 20 days worked (312 − 8 holidays − 14 = 290 ÷ 20)');
  const lv25 = K.checkLeavePolicy({ policyRules: [{ type: { code: 'EL', name: 'Earned leave' }, accrual: 'PER_DAYS_WORKED', daysWorkedPerLeaveDay: 25 }], rule: LV });
  const lv12 = K.checkLeavePolicy({ policyRules: [{ type: { code: 'EL', name: 'Earned leave' }, basis: 'PER_YEAR', accrual: 'MONTHLY', days: 12 }], rule: LV });
  const lv15 = K.checkLeavePolicy({ policyRules: [{ type: { code: 'EL', name: 'Earned leave' }, basis: 'PER_YEAR', accrual: 'MONTHLY', days: 15 }], rule: LV });
  const none = K.checkLeavePolicy({ policyRules: [{ type: { code: 'CL', name: 'Casual leave' }, basis: 'PER_YEAR', days: 12 }], rule: LV });
  ok(lv25[0]?.severity === 'HARD' && lv12[0]?.severity === 'WARN' && lv12[0].numbers.owed === 14 && lv15.length === 0 && none[0]?.severity === 'WARN', 'leave: one per 25 days → HARD; 12 days a year → WARN (owed 14); 15 → nothing; no earned leave → WARN');
  const comps = [{ code: 'PF_EE', statutoryKey: 'PF_EE', status: 'INACTIVE' }, { code: 'PF_ER', statutoryKey: 'PF_ER', status: 'ACTIVE' }];
  const PFS = { PF: { wageCeiling: 15000, meta: { id: 3, verification: 'VERIFIED' } } };
  const st1 = K.checkStatutory({ components: comps, settings: PFS, pfMode: 'CEILING', pfWage: 12000 });
  const st2 = K.checkStatutory({ components: comps, settings: PFS, pfMode: 'NONE', pfWage: 12000 });
  ok(st1.length === 1 && st1[0].check === 'STATUTORY_MISSING' && st1[0].severity === 'HARD' && st2.length === 1 && st2[0].check === 'PF_LEFT_OUT' && st2[0].severity === 'WARN',
    'statutory: PF due but its employee component inactive → HARD; not a member with a PF wage of 12,000 under 15,000 → WARN (apprentice / excluded employee?)');
  // Bonus.
  const six = (wage, extra = {}) => ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month) => ({ month, payableDays: 30, daysInMonth: 30, wage, ceiling: 7000, ...extra }));
  const b1 = BONUS.bonusFor({ months: six(10000), eligibilityCeiling: 21000, ratePct: 8.33 });
  const b2 = BONUS.bonusFor({ months: six(10000, { ceiling: 16000 }), eligibilityCeiling: 21000, ratePct: 8.33 });
  const b3 = BONUS.bonusFor({ months: six(10000), eligibilityCeiling: 21000, ratePct: 20 });
  ok(b1.eligible && b1.calcWageTotal === 42000 && b1.amount === 3499 && b2.calcWageTotal === 60000 && b2.amount === 4998 && b3.amount === 8400,
    'bonus: 6 × min(10,000, 7,000) = 42,000 × 8.33% = 3,499; ceiling 16,000 (the minimum wage) → 60,000 → 4,998; at 20% → 8,400', JSON.stringify([b1.amount, b2.amount, b3.amount]));
  const pr = BONUS.bonusFor({ months: [{ month: '2026-04', payableDays: 15, daysInMonth: 30, wage: 5000, ceiling: 7000 }, ...six(10000).slice(1)], eligibilityCeiling: 21000, ratePct: 8.33 });
  ok(pr.months[0].calcWage === 3500 && pr.calcWageTotal === 38500 && pr.amount === 3207, 'prorated: 15 of 30 days → ceiling 3,500; 38,500 × 8.33% = 3,207');
  const few = BONUS.bonusFor({ months: [{ month: '2026-04', payableDays: 25, daysInMonth: 30, wage: 8000, ceiling: 7000 }], eligibilityCeiling: 21000, ratePct: 8.33 });
  const rich = BONUS.bonusFor({ months: [...six(10000).slice(0, 5), { month: '2026-09', payableDays: 30, daysInMonth: 30, wage: 25000, ceiling: 7000 }], eligibilityCeiling: 21000, ratePct: 8.33 });
  const tiny = BONUS.bonusFor({ months: [{ month: '2026-04', payableDays: 30, daysInMonth: 30, wage: 1000, ceiling: 7000 }], eligibilityCeiling: 21000, ratePct: 8.33 });
  ok(!few.eligible && /30 are needed/.test(few.reason) && rich.eligible && rich.months[5].counted === false && rich.calcWageTotal === 35000 && tiny.amount === 100,
    'eligibility: 25 days → not eligible; a month at 25,000 (> 21,000) not counted; a bonus under ₹100 → ₹100');
  const so1 = BONUS.setOnOff({ allocableSurplus: 25000, salaryTotal: 100000 });
  const so2 = BONUS.setOnOff({ allocableSurplus: 5000, salaryTotal: 100000 });
  ok(so1.setOn === 5000 && so1.setOff === 0 && so2.setOff === 3330 && so2.setOn === 0, 'set-on: 25,000 surplus − 20,000 maximum = 5,000; set-off: 8,330 minimum − 5,000 surplus = 3,330');
}

/* ══ 2. the database part: one transaction, rolled back ═══════════════ */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_cc_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_cc_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_cc_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZCC${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
const SCRIPT = { kind: 'SCRIPT', name: 'compliance_checks_test' };

let server;
let unsubscribe = null;
try {
  const company = await one('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company "${slug}".`);
  const COMPANY = company.id;
  console.log(`\ncompliance_checks_test — ${company.name} (${COMPANY}), tag ${TAG}`);
  const app = await hrmsAppOf(db, COMPANY);
  const owner = await one(
    `SELECT u.id, u.email, u.name FROM users u JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = ? AND aua.deleted_at IS NULL JOIN roles r ON r.id = aua.role_id
      WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [app.id, COMPANY]);
  if (!owner) throw new Error('This company has no Owner login.');
  await setupAccess(db, COMPANY, { apply: true });
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const catalog = await ensureCatalog(db, { apply: true });
  const clerkRole = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} Payroll clerk`, COMPANY]);
  await db.query("INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, 'COMPANY')", [COMPANY, clerkRole, `${TAG} Payroll clerk`]);
  await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: clerkRole, tags: [areaTag('payroll', 'view'), areaTag('payroll', 'edit')], catalog });
  const login = async (label, roleId) => {
    const email = `${TAG.toLowerCase()}.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`;
    const id = await ins('INSERT INTO users (name, email, password, role_id, team_id, company_id) VALUES (?, ?, ?, ?, NULL, ?)', [`${TAG} ${label}`, email, 'x', roleId, COMPANY]);
    await db.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [id, app.id, roleId, COMPANY]);
    const roleName = (await one('SELECT name FROM roles WHERE id = ?', [roleId])).name;
    return { id, token: signToken({ id, name: `${TAG} ${label}`, email, role: roleName, company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  };
  const HR = await login('HR manager', roleByKey.HR_MANAGER);
  const EMP = await login('Employee', roleByKey.EMPLOYEE);
  const CLERK = await login('Clerk', clerkRole);
  const O = { id: owner.id, token: signToken({ id: owner.id, name: owner.name, email: owner.email, role: 'admin', company: company.slug, companyId: COMPANY, company_id: COMPANY, uiPermissions: [] }) };
  forgetAccess();
  server = express();
  server.use(express.json());
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${listener.address().port}/api/${company.slug}/cf_hrms`;
  const call = async (who, method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await res.json(); } catch { /* none */ }
    return { status: res.status, json: j };
  };

  /* ── P: the lowest CTC on Staff standard, alone in a role; skill unskilled, location zone I ── */
  const P = await one(
    `SELECT s.id AS salary_id, s.employee_id, s.annual_ctc, s.structure_id, wa.role_id, COALESCE(wa.location_id, p.location_id) AS location_id FROM hrms_pay_salaries s
       JOIN hrms_work_assignments wa ON wa.company_id = s.company_id AND wa.employee_id = s.employee_id AND wa.deleted_at IS NULL AND wa.status <> 'ENDED' AND wa.is_primary = 1
       LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.effective_to IS NULL AND s.annual_ctc = 184000 AND s.pf_mode = 'CEILING' AND s.overrides_json IS NULL
        AND (SELECT COUNT(*) FROM hrms_work_assignments x WHERE x.company_id = wa.company_id AND x.role_id = wa.role_id AND x.deleted_at IS NULL AND x.status <> 'ENDED') = 1
      ORDER BY s.employee_id LIMIT 1`, [COMPANY]);
  if (!P) throw new Error('No person on ₹1,84,000 alone in a role (Karni demo data).');
  const RUN = await one("SELECT id FROM hrms_pay_runs WHERE company_id = ? AND period_month = '2026-10' AND deleted_at IS NULL AND status IN ('DRAFT','CALCULATED')", [COMPANY]);
  if (!RUN) throw new Error('No open October 2026 run (Karni demo data).');
  const rl = await one('SELECT id FROM hrms_role_law WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL', [COMPANY, P.role_id]);
  if (rl) await db.query("UPDATE hrms_role_law SET skill_category = 'UNSKILLED' WHERE id = ?", [rl.id]);
  else await db.query("INSERT INTO hrms_role_law (company_id, role_id, skill_category) VALUES (?, ?, 'UNSKILLED')", [COMPANY, P.role_id]);
  const ll = await one('SELECT id FROM hrms_location_law WHERE company_id = ? AND location_id = ? AND deleted_at IS NULL', [COMPANY, P.location_id]);
  if (ll) await db.query("UPDATE hrms_location_law SET state_code = 'TG', min_wage_zone = 'I' WHERE id = ?", [ll.id]);
  else await db.query("INSERT INTO hrms_location_law (company_id, location_id, state_code, min_wage_zone) VALUES (?, ?, 'TG', 'I')", [COMPANY, P.location_id]);
  const staff = (await loadStructures(db, COMPANY, [P.structure_id])).get(P.structure_id);
  const linesOf = staff.lines.map((l) => ({ componentId: l.componentId, formula: l.formula }));

  section('[2] The structure editor and salary save — the seed\'s UNVERIFIED minimum wage');
  {
    const pv = await call(HR, 'POST', '/payroll/structures/preview', { lines: linesOf, annualCtc: 184000, place: { roleId: P.role_id } });
    const mwc = pv.json?.compliance?.results?.find((r) => r.check === 'MIN_WAGE');
    ok(pv.status === 200 && pv.json.compliance.place.skill === 'UNSKILLED' && mwc?.severity === 'WARN' && mwc.hardIfVerified && pv.json.compliance.results.some((r) => r.check === 'WAGES_50'),
      'live check for a sample CTC and the role\'s skill: minimum wage WARN (unverified), the 50% rule WARN', JSON.stringify(pv.json?.compliance?.results?.map((r) => [r.check, r.severity])));
    const body = { employeeId: P.employee_id, annualCtc: 184000, structureId: P.structure_id, effectiveFrom: '2026-11-01', reason: `${TAG} test` };
    const noReason = await call(HR, 'POST', '/payroll/salaries', body);
    ok(noReason.status === 409 && noReason.json.code === 'COMPLIANCE_WARN' && noReason.json.detail?.needReason && noReason.json.detail.checks.some((r) => r.check === 'MIN_WAGE' && r.unverifiedNote),
      'salary save with a WARN and no reason: 409 COMPLIANCE_WARN, the warnings in words', JSON.stringify(noReason.json).slice(0, 300));
    const withReason = await call(HR, 'POST', '/payroll/salaries', { ...body, complianceReason: `${TAG} accepted for the test` });
    const acks = withReason.json?.salary ? await q("SELECT check_key, reason, approved_by FROM hrms_compliance_acks WHERE company_id = ? AND context = 'SALARY' AND entity_id = ?", [COMPANY, withReason.json.salary.id]) : [];
    ok(withReason.status === 200 && acks.length >= 2 && acks.every((a) => a.approved_by === HR.id && a.reason.startsWith(TAG)) && acks.some((a) => a.check_key === 'MIN_WAGE'),
      'with a reason: saved; each WARN kept with the reason and the approver', JSON.stringify(acks));
    if (withReason.json?.salary) ok((await call(O, 'DELETE', `/payroll/salaries/${withReason.json.salary.id}`)).status === 200, '(the test revision taken out again)');
  }

  section('[3] A VERIFIED minimum wage: HARD');
  const seedMw = await one("SELECT id FROM hrms_law_rules WHERE domain = 'MIN_WAGE' AND jurisdiction = 'TG' AND rule_key = 'ALL_EMPLOYMENTS' AND status = 'PUBLISHED' AND deleted_at IS NULL ORDER BY effective_from DESC LIMIT 1");
  const v1 = await LAW.publishVersion(db, { draft: { fromId: seedMw.id, verified: true, sourceNote: `${TAG} test: verified copy` } }, SCRIPT);
  {
    const pv = await call(HR, 'POST', '/payroll/structures/preview', { lines: linesOf, annualCtc: 184000, place: { roleId: P.role_id } });
    const mwc = pv.json?.compliance?.results?.find((r) => r.check === 'MIN_WAGE');
    ok(mwc?.severity === 'HARD' && mwc.rule.id === v1.id && near(mwc.numbers.codeWages, 7666.67) && near(mwc.numbers.shortBy, 8333.33), 'live check: HARD, wages 7,666.67 short by 8,333.33 of 16,000', JSON.stringify(mwc?.numbers));
    const refused = await call(HR, 'POST', '/payroll/salaries', { employeeId: P.employee_id, annualCtc: 184000, structureId: P.structure_id, effectiveFrom: '2026-11-01', reason: 'x', complianceReason: 'try anyway' });
    ok(refused.status === 422 && refused.json.code === 'COMPLIANCE_HARD' && /below the minimum wage of ₹16,000/.test(refused.json.message) && /Short by ₹8,333.33/.test(refused.json.message), 'salary save below the minimum wage: refused in plain words, even with a reason', refused.json?.message);
    const calc = await call(HR, 'POST', `/payroll/runs/${RUN.id}/calculate`);
    ok(calc.status === 200, 'October calculated', JSON.stringify(calc.json).slice(0, 200));
    const panel = await call(HR, 'GET', `/payroll/runs/${RUN.id}/compliance`);
    const pp = panel.json?.people?.find((x) => x.employee.id === P.employee_id);
    ok(panel.status === 200 && panel.json.counts.hard >= 1 && !panel.json.canLock && pp?.results.some((r) => r.check === 'MIN_WAGE' && r.severity === 'HARD'), 'the run\'s compliance panel lists P\'s breach (HARD)', JSON.stringify(panel.json?.counts));
    const lock = await call(HR, 'POST', `/payroll/runs/${RUN.id}/lock`, { complianceReason: 'try anyway' });
    ok(lock.status === 409 && lock.json.code === 'COMPLIANCE_HARD', 'a HARD breach blocks the lock (a reason does not help)', JSON.stringify(lock.json).slice(0, 200));
  }

  section('[4] onPublish makes a to-do; the top-up after its deadline; the WARN acknowledgement');
  unsubscribe = T.listenForLaw();
  const v2 = await LAW.publishVersion(db, { draft: { fromId: v1.id, sourceNote: `${TAG} test: v2` } }, SCRIPT);
  await T.settled();
  const todo = await one("SELECT * FROM hrms_compliance_todos WHERE company_id = ? AND todo_key = ? AND status = 'OPEN' AND deleted_at IS NULL", [COMPANY, `MIN_WAGE:${v2.id}`]);
  const tdPeople = (typeof todo?.affected_json === 'string' ? JSON.parse(todo.affected_json) : todo?.affected_json ?? {}).people ?? [];
  ok(todo && todo.severity === 'HARD' && todo.last_trigger === 'PUBLISH' && dateText(todo.deadline) === '2026-06-01',
    'publishing v2 made a HARD to-do (trigger PUBLISH), deadline = the law\'s effective date', JSON.stringify({ k: todo?.todo_key, s: todo?.severity, d: todo?.deadline }));
  ok(tdPeople.some((p) => p.employeeId === P.employee_id && p.monthlyMinimum === 16000), 'it names P, with the monthly minimum of 16,000');
  const sync = await call(HR, 'POST', '/payroll/compliance-todos/check-now');
  const list = sync.json?.todos ?? [];
  const w50 = list.find((t) => t.check === 'WAGES_50');
  ok(sync.status === 200 && w50 && w50.severity === 'WARN' && list.some((t) => t.check === 'MIN_WAGE_UNKNOWN' && t.severity === 'INFO') && list.some((t) => t.id === todo?.id), 'Check now: the 50% to-do (WARN) and "cannot be checked" (INFO) beside it; the MIN_WAGE to-do kept', JSON.stringify(list.map((t) => [t.check, t.severity, t.peopleCount])));
  {
    const calc = await call(HR, 'POST', `/payroll/runs/${RUN.id}/calculate`);
    const rp = calc.json?.people?.find((x) => x.employee.id === P.employee_id);
    const detail = rp ? await call(HR, 'GET', `/payroll/runs/${RUN.id}/people/${rp.id}`) : null;
    const lines = detail?.json?.lines ?? [];
    const top = lines.find((l) => l.code === 'STAT_TOPUP');
    const basicDa = lines.filter((l) => ['BASIC', 'DA'].includes(l.code)).reduce((s, l) => s + l.amount, 0);
    const need = Math.round(16000 * rp.payableDays / rp.daysInMonth * 100) / 100;
    ok(top && top.amount === Math.ceil(need - basicDa - 0.005) && /to-do #/.test(top.basis) && rp.warnings.some((w) => w.code === 'STAT_TOPUP'), `the top-up: ceil(${need} − basic ${basicDa}) = ${top?.amount}, shown on the line and as a warning`, JSON.stringify(top));
    ok((await one('SELECT topup_from FROM hrms_compliance_todos WHERE id = ?', [todo.id])).topup_from === '2026-10', 'the to-do records the first month of the top-up');
    const panel = await call(HR, 'GET', `/payroll/runs/${RUN.id}/compliance`);
    const pp = panel.json.people.find((x) => x.employee.id === P.employee_id);
    ok(panel.json.counts.hard === 0 && pp.results.some((r) => r.severity === 'INFO' && /top-up/.test(r.message)) && panel.json.counts.warnOpen > 0, 'kept at the minimum: no HARD left; the WARNs are open', JSON.stringify(panel.json.counts));
    const lock = await call(HR, 'POST', `/payroll/runs/${RUN.id}/lock`);
    ok(lock.status === 409 && lock.json.code === 'COMPLIANCE_WARN', 'a WARN without an acknowledgement: the lock is refused (COMPLIANCE_WARN)');
    const noWhy = await call(HR, 'POST', `/payroll/runs/${RUN.id}/compliance/acknowledge`, {});
    const ack = await call(HR, 'POST', `/payroll/runs/${RUN.id}/compliance/acknowledge`, { reason: `${TAG} reviewed with the CA` });
    ok(noWhy.status === 422 && ack.status === 200 && ack.json.acknowledged > 0 && ack.json.panel.canLock && ack.json.panel.people.flatMap((p) => p.results).filter((r) => r.severity === 'WARN').every((r) => r.acknowledged?.reason?.startsWith(TAG)),
      'acknowledge: a reason is needed; then every WARN shows its reason and the lock is allowed', JSON.stringify(ack.json?.panel?.counts));
  }

  section('[5] The fixes: before / after, maker-checker, applied dated with arrears');
  {
    const td = await call(HR, 'GET', `/payroll/compliance-todos/${todo.id}`);
    const re = td.json?.options?.find((o) => o.key === 'RESPLIT');
    const raise = td.json?.options?.find((o) => o.key === 'RAISE_CTC');
    const rp = raise?.perPerson?.find((p) => p.employeeId === P.employee_id);
    const rsP = re?.perPerson?.find((p) => p.employeeId === P.employee_id);
    ok(rsP && !rsP.feasible && /Not within the CTC/.test(rsP.note), 'remedy (a) for P: Basic of 16,000 does not fit a CTC of 15,333 a month — said, not offered', rsP?.note);
    ok(rp?.feasible && rp.newCtc === 384000 && near(rp.change.cost, rp.after.cost - rp.before.cost) && rp.change.cost > 0 && near(raise.totals.extraCostAnnual, raise.totals.extraCostMonthly * 12) && raise.perStructure.length >= 1,
      'remedy (b): CTC 1,84,000 → 3,84,000 (wages = half of 32,000 a month); the extra cost a month and a year, per person and per structure', JSON.stringify({ newCtc: rp?.newCtc, change: rp?.change, totals: raise?.totals }));
    const wd = await call(HR, 'GET', `/payroll/compliance-todos/${w50.id}`);
    const a = wd.json?.options?.find((o) => o.key === 'RESPLIT');
    const st = a?.structures?.[0];
    const fp = a?.perPerson?.filter((p) => p.feasible) ?? [];
    const comps = await loadComponents(db, COMPANY);
    const ratios = fp.slice(0, 10).map((p) => K.wagesOf(breakdown(st.lines.map((l, i) => ({ ...l, sortOrder: i })), comps.byId, p.salary.annualCtc, {}, { vars: { PF_CEILING: 15000, ESI_CEILING: 21000 } }).lines).ratio);
    const sameCtc = fp.every((p) => p.salary.annualCtc === (wd.json.people.find((x) => x.employeeId === p.employeeId)?.annualCtc));
    ok(st && st.basicPct >= 50 && sameCtc && ratios.length > 0 && ratios.every((r) => r >= 0.5 - 1e-9) && fp.every((p) => typeof p.losesTakeHome === 'boolean' && p.before && p.after),
      `remedy (a) for the 50% rule: a new version with Basic ${st?.basicFormula}, the CTC kept, wages ≥ 50% for everyone it fits; take-home before / after and who loses it`, JSON.stringify({ pct: st?.basicPct, ratios: ratios.slice(0, 3), losers: a?.totals?.losers }));
    // Maker-checker.
    const ch = await call(HR, 'POST', `/payroll/compliance-todos/${todo.id}/choose`, { option: 'RAISE_CTC', note: `${TAG} raise` });
    ok(ch.status === 200 && ch.json.todo.status === 'CHOSEN' && ch.json.todo.chosenOption === 'RAISE_CTC', 'HR chooses "Raise the CTC"');
    const hrApprove = await call(HR, 'POST', `/payroll/compliance-todos/${todo.id}/approve`);
    ok(hrApprove.status === 403 && hrApprove.json.code === 'OWNER_ONLY', 'HR cannot approve (the Owner approves)');
    const own = await call(O, 'POST', `/payroll/compliance-todos/${w50.id}/choose`, { option: 'RESPLIT' });
    const ownApprove = await call(O, 'POST', `/payroll/compliance-todos/${w50.id}/approve`);
    ok(own.status === 200 && ownApprove.status === 409 && ownApprove.json.code === 'OWN_CHOICE', 'the Owner who chose a fix cannot approve it too (maker-checker)', JSON.stringify(ownApprove.json));
    const approve = await call(O, 'POST', `/payroll/compliance-todos/${todo.id}/approve`, { note: 'approved' });
    const applied = approve.json?.todo?.applied;
    const sp = applied?.salaries?.find((s) => s.employeeId === P.employee_id);
    ok(approve.status === 200 && approve.json.todo.status === 'APPLIED' && sp?.effectiveFrom === '2026-06-01' && JSON.stringify(sp.arrearsFor) === JSON.stringify(['2026-06', '2026-07', '2026-08', '2026-09']),
      'the Owner approves: a salary row from the law\'s date (1 June 2026); arrears for June–September follow', JSON.stringify(sp));
    const row = await one('SELECT annual_ctc, effective_from FROM hrms_pay_salaries WHERE id = ?', [sp?.salaryId ?? 0]);
    ok(row && Number(row.annual_ctc) === 384000, 'the new salary is ₹3,84,000');
    const calc = await call(HR, 'POST', `/payroll/runs/${RUN.id}/calculate`);
    const rp2 = calc.json?.people?.find((x) => x.employee.id === P.employee_id);
    const lines = (await call(HR, 'GET', `/payroll/runs/${RUN.id}/people/${rp2.id}`)).json?.lines ?? [];
    ok(lines.filter((l) => l.code === 'ARREARS').map((l) => l.forMonth).sort().join() === '2026-06,2026-07,2026-08,2026-09' && !lines.some((l) => l.code === 'STAT_TOPUP'),
      'October pays the arrears for June–September, and no top-up any more (the to-do is applied)', JSON.stringify(lines.map((l) => [l.code, l.forMonth, l.amount])));
    const dismissHard = await call(HR, 'POST', `/payroll/compliance-todos/${todo.id}/dismiss`, { reason: 'no' });
    const info = (await call(HR, 'GET', '/payroll/compliance-todos')).json.todos.find((t) => t.check === 'MIN_WAGE_UNKNOWN');
    const dismissInfo = await call(HR, 'POST', `/payroll/compliance-todos/${info.id}/dismiss`, { reason: `${TAG} zones are set next week` });
    ok(dismissHard.status === 409 && dismissInfo.status === 200 && dismissInfo.json.todo.status === 'DISMISSED', 'a HARD to-do is not dismissed; an INFO one is, with a reason');
  }

  section('[6] The bonus run');
  {
    const prep = await call(HR, 'POST', '/payroll/bonus/prepare', { year: '2026-27' });
    const run = prep.json?.run;
    const lp = prep.json?.lines?.find((l) => l.employee.id === P.employee_id);
    const choices = await one('SELECT bonus_rate FROM hrms_law_company_choices WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
    const rate = choices?.bonus_rate == null ? 8.33 : Number(choices.bonus_rate);
    ok(prep.status === 200 && run.status === 'DRAFT' && run.ratePct === rate && run.totals.monthsPaid.join() === '2026-04,2026-05,2026-06,2026-07,2026-08,2026-09' && run.deadline === '2027-11-30',
      `prepared from the locked runs April–September at the company's rate (${rate}%); due by 30 Nov 2027 (8 months after the year)`, JSON.stringify(run).slice(0, 300));
    const apr = lp?.months?.find((m) => m.month === '2026-04');
    const jun = lp?.months?.find((m) => m.month === '2026-06');
    const sumCalc = (lp?.months ?? []).reduce((s, m) => s + m.calcWage, 0);
    ok(lp?.eligible && apr?.ceiling === 7000 && jun?.ceiling === 16000 && apr.calcWage === Math.round(Math.min(apr.wage, 7000 * apr.payableDays / apr.daysInMonth) * 100) / 100 && near(lp.calcWageTotal, sumCalc) && lp.amount === Math.max(100, Math.round(lp.calcWageTotal * rate / 100)),
      'P: ceiling ₹7,000 in April (no minimum wage then), ₹16,000 from June (the minimum wage, higher); bonus = rate × the calculation wages', JSON.stringify({ apr, jun, amount: lp?.amount }));
    const richLine = prep.json?.lines?.find((l) => !l.eligible && /above/.test(l.reason ?? ''));
    ok(Boolean(richLine), 'a person paid above ₹21,000 a month is not eligible, and the line says why', richLine?.reason);
    ok((await call(HR, 'POST', `/payroll/bonus/${run.id}/approve`)).status === 403, 'HR cannot approve the bonus');
    const appr = await call(O, 'POST', `/payroll/bonus/${run.id}/approve`);
    ok(appr.status === 200 && appr.json.run.status === 'APPROVED', 'the Owner approves (HR prepared it)');
    const sch = await call(HR, 'POST', `/payroll/bonus/${run.id}/schedule`, { runId: RUN.id });
    const items = await q("SELECT i.amount FROM hrms_pay_items i JOIN hrms_pay_components k ON k.id = i.component_id AND k.code = 'BONUS' WHERE i.company_id = ? AND i.run_id = ? AND i.deleted_at IS NULL", [COMPANY, RUN.id]);
    const eligibleAmt = prep.json.lines.filter((l) => l.eligible && l.amount > 0);
    ok(sch.status === 200 && sch.json.run.status === 'SCHEDULED' && sch.json.run.payMonth === '2026-10' && items.length === eligibleAmt.length && near(items.reduce((s, i) => s + Number(i.amount), 0), eligibleAmt.reduce((s, l) => s + l.amount, 0)) && !sch.json.run.late,
      'scheduled into October\'s run: one BONUS item per eligible person, the same total; not late', JSON.stringify({ items: items.length, eligible: eligibleAmt.length }));
    const xl = await call(HR, 'GET', `/payroll/bonus/${run.id}/register`);
    const pdf = await call(HR, 'GET', `/payroll/bonus/${run.id}/register?format=pdf`);
    ok(xl.status === 200 && xl.json.contentBase64.length > 1000 && /xlsx$/.test(xl.json.fileName) && pdf.status === 200 && Buffer.from(pdf.json.contentBase64, 'base64').subarray(0, 4).toString() === '%PDF', 'the register: Excel and PDF');
    const calc = await call(HR, 'POST', `/payroll/runs/${RUN.id}/calculate`);
    const rp = calc.json?.people?.find((x) => x.employee.id === P.employee_id);
    const lines = (await call(HR, 'GET', `/payroll/runs/${RUN.id}/people/${rp.id}`)).json?.lines ?? [];
    ok(lines.some((l) => l.code === 'BONUS' && l.amount === lp.amount), 'the October run pays P\'s bonus as a BONUS line');
    const lock = await call(HR, 'POST', `/payroll/runs/${RUN.id}/lock`, { complianceReason: `${TAG} reviewed` });
    ok(lock.status === 200 && lock.json.run.status === 'LOCKED', 'with no HARD left and the WARNs acknowledged, October locks', JSON.stringify(lock.json).slice(0, 300));
    const prev = await call(HR, 'POST', '/payroll/bonus/prepare', { year: '2025-26' });
    ok(prev.status === 200 && prev.json.run.deadline === '2026-11-30' && !prev.json.run.late, '2025-26: due by 30 Nov 2026 — not late yet');
    // The 8 months over (the deadline moved into the past inside the transaction): warned, not refused.
    await db.query("UPDATE hrms_bonus_runs SET deadline = '2026-09-30' WHERE id = ?", [prev.json.run.id]);
    const late = await call(HR, 'GET', `/payroll/bonus/${prev.json.run.id}`);
    ok(late.json.run.late && late.json.warnings.some((w) => /after the legal time/.test(w)) && late.json.can.approve === false, 'past the legal time: warned as late (not refused)');
    ok((await call(HR, 'POST', '/payroll/bonus/prepare', { year: '2024-25' })).status === 409, 'a year before the Code on Wages bonus rules: no rules in the law layer, refused (409 NO_LAW)');
    ok((await call(HR, 'POST', '/payroll/bonus/prepare', { year: '2026-27', ratePct: 25 })).status === 409, 'an approved bonus is not prepared again');
  }

  section('[7] Leave and attendance policies');
  {
    const c = { companyId: COMPANY, userId: HR.id };
    const shop = await LEAVE.createPolicy(db, c, { name: `${TAG} Shop floor`, fromTemplate: 'SHOP_FLOOR', status: 'ACTIVE', yearStartsMonth: 4 });
    ok(shop.policy?.id && !shop.compliance.some((r) => r.severity === 'HARD'), 'the shop-floor template (one day per 20 worked) is saved active');
    const el = await one("SELECT id FROM hrms_leave_types WHERE company_id = ? AND code = 'EL' AND deleted_at IS NULL", [COMPANY]);
    const bad = await caught(() => LEAVE.updatePolicy(db, c, shop.policy.id, { rules: [{ leaveTypeId: el.id, basis: 'PER_YEAR', accrual: 'PER_DAYS_WORKED', daysWorkedPerLeaveDay: 25 }] }));
    ok(bad?.code === 'COMPLIANCE_HARD' && /one for every 20/.test(bad.message), 'one day per 25 worked on an active policy: refused (OSH Code s.32, verified)', bad?.message);
    const draft = await LEAVE.createPolicy(db, c, { name: `${TAG} Draft`, status: 'DRAFT', yearStartsMonth: 4, fromTemplate: 'TRAINEE' });
    ok(draft.compliance.some((r) => r.check === 'LEAVE_MIN' && r.severity === 'WARN'), 'a policy with no earned leave: saved, with a warning');
    const ot = await caught(() => ATT.createPolicy(db, c, { code: `${TAG}OT`, name: `${TAG} Overtime`, status: 'ACTIVE', rules: { overtime: { rateMultiplier: 1.5 } } }));
    ok(ot?.code === 'COMPLIANCE_HARD' && /1.5×/.test(ot.message), 'an attendance policy paying overtime at 1.5×: refused', ot?.message);
    const ot2 = await ATT.createPolicy(db, c, { code: `${TAG}O2`, name: `${TAG} Overtime 2x`, status: 'ACTIVE', rules: { overtime: { rateMultiplier: 2 } } });
    ok(ot2.policy?.id && ot2.compliance.length === 0, 'at 2×: saved');
  }

  section('[8] Rights and tenants');
  {
    ok((await call(EMP, 'GET', '/payroll/compliance-todos')).status === 403, 'an employee does not see the to-dos');
    ok((await call(CLERK, 'GET', '/payroll/compliance-todos')).status === 403 && (await call(CLERK, 'GET', '/payroll/compliance-todos/summary')).status === 200, 'without pay access: the list (people\'s pay) refused, the Home card counts allowed');
    ok((await call(CLERK, 'GET', '/payroll/bonus')).status === 403 && (await call(EMP, 'POST', '/payroll/bonus/prepare', { year: '2025-26' })).status === 403, 'the bonus needs payroll and pay access');
    const other = await one("SELECT id FROM companies WHERE id <> ? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM hrms_pay_components k WHERE k.company_id = companies.id) LIMIT 1", [COMPANY]);
    if (other) {
      const e1 = await caught(() => T.readTodo(db, { companyId: other.id, userId: null }, todo.id));
      const e2 = await caught(() => CC.runCompliance(db, { companyId: other.id }, RUN.id));
      const bOther = await CC.findBreaches(db, other.id, {});
      const karniIds = new Set((await q('SELECT id FROM hrms_employees WHERE company_id = ?', [COMPANY])).map((r) => r.id));
      ok(e1?.status === 404 && e2?.status === 404 && bOther.every((b) => b.people.every((p) => !karniIds.has(p.employeeId))), 'another company: this company\'s to-do and run are not found; its breaches hold none of these people');
    } else ok(true, '(no second company with payroll: tenant check skipped)');
  }
} catch (e) {
  ok(false, 'the test ran to the end', e.stack);
} finally {
  if (unsubscribe) unsubscribe();
  try { await T.settled(); } catch { /* nothing pending */ }
  if (server?.close) await server.close();
  try { await db.rollback(); } catch { /* nothing to undo */ }
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
  ok(moved.length === 0, `every count is what it was (${Object.keys(before).length} company tables)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
