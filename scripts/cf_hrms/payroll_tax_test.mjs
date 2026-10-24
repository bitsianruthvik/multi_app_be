/**
 * payroll_tax_test.mjs — income tax in payroll, P2 (TM/CF_HRMS_HIRING_SPEC.md §25.4, 2026-10-20).
 *
 *   0. the schema (apply-payroll-tax-schema.mjs reads init.sql §30): a second run plans nothing; the
 *      new rules (tds_no_pan, declarations, tds_deposit, tds_return) are seeded, with sources;
 *   1. regime choice and the cut-off: the person until the cut-off; after it HR once, with a reason;
 *   2. declarations and the windows: closed → refused; re-opened by HR → the person declares; the
 *      landlord PAN above ₹1,00,000; HR any time;
 *   3. the proofs lifecycle with REAL files (a PDF and a PNG): the window, 10 MB, the type from the
 *      bytes, SUBMITTED → VERIFIED (a lower amount) / REJECTED (reason) → SUBMITTED again, bulk accept;
 *   4. TDS in runs against HAND-WORKED numbers (2025-26 rules, below): new regime; a bonus; a previous
 *      employer; the old regime with 80C and HRA declared, then with the proof window closed (only
 *      the verified amounts); no PAN (the higher rate); HR's override with a reason; a revision the
 *      next month on top of the locked month's TDS;
 *   5. challans: unpaid after the due date, short, paid late;
 *   6. the quarterly return's data (Form 24Q for 2025-26): challans, Annexure I, Annexure II in Q4,
 *      validation; the workbook;
 *   7. Form 16 Part B generated (a PDF, Form 12BA annexed for a perquisite); Part A from a ZIP matched
 *      by PAN in the file name and in the text, one assigned by hand; the merged download; release;
 *   8. privacy and rights;
 *   9. nothing is left behind.
 *
 * HAND-WORKED (the 2025-26 rules of services/tax/ruleData.js; a structure of Basic 50% of CTC, HRA 50%
 * of Basic, Special the balance; no PF; Telangana PT ₹200 a month). The October 2025 run, the first
 * locked run of the year: April–September are ESTIMATED at the salary (no TDS), October and the five
 * months to March at the salary → months left 6.
 *   N  ₹18,00,000, new regime: 18,00,000 − 75,000 = 17,25,000. Slabs 0 / 20,000 / 40,000 / 60,000 /
 *      1,25,000 × 20% = 25,000 → 1,45,000; cess 5,800 → 1,50,800. October: 1,50,800 ÷ 6 = 25,133.
 *      November, a raise to ₹24,00,000 from 1 Nov: Apr–Oct 7 × 1,50,000 + Nov–Mar 5 × 2,00,000 =
 *      20,50,000 − 75,000 = 19,75,000 → 1,20,000 + 3,75,000 × 20% = 1,95,000; cess 7,800 → 2,02,800;
 *      − 25,133 deducted in October = 1,77,667 ÷ 5 = 35,533.
 *   B  ₹15,00,000 + a bonus of ₹1,00,000 in October: 16,00,000 − 75,000 = 15,25,000 → 60,000 +
 *      3,25,000 × 15% = 48,750 → 1,08,750; cess 4,350 → 1,13,100 ÷ 6 = 18,850 (16,250 without it).
 *   P  joined 1 July 2025 at ₹18,00,000, a previous employer this year: salary 3,00,000, TDS 10,000:
 *      Jul–Mar 9 × 1,50,000 = 13,50,000 + 3,00,000 − 75,000 = 15,75,000 → 60,000 + 56,250 = 1,16,250;
 *      cess 4,650 → 1,20,900 − 10,000 = 1,10,900 ÷ 6 = 18,483.
 *   O  ₹12,00,000, OLD regime (HR, after the cut-off, with a reason), city Mumbai: rent 30,000 a month
 *      all year, PPF 1,00,000, LIC 30,000. HRA a month: least of 25,000 / 30,000 − 5,000 / 50% of
 *      50,000 = 25,000 → 3,00,000 exempt. 12,00,000 − 3,00,000 − 50,000 − PT 2,400 = 8,47,600 − 80C
 *      1,30,000 = 7,17,600 → 12,500 + 2,17,600 × 20% = 56,020; cess 2,241 → 58,261 → 58,260 ÷ 6 = 9,710.
 *      Proofs closed, PPF verified at 80,000, LIC rejected, rent verified: 80C 80,000 → 7,67,600 →
 *      12,500 + 53,520 = 66,020; cess 2,641 → 68,661 → 68,660 ÷ 6 = 11,443.
 *      (The new regime on the same pay: 11,25,000 → the rebate → 0; the sheet says so.)
 *   X  ₹18,00,000, NO PAN: tax as N 1,50,800; 20% of 17,25,000 = 3,45,000 is higher → 3,45,000 ÷ 6 = 57,500.
 *   M  ₹18,00,000, HR sets ₹10,000 with a reason: 10,000, MANUAL; the engine's 25,133 kept beside it.
 *
 *   node scripts/cf_hrms/payroll_tax_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND: one connection, one transaction (pool.query / getConnection point at it),
 * rolled back. Its runs are 2025-26 months; the company's own runs of that year are set aside inside
 * the transaction. Local only.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { PDFDocument as PdfLib } from 'pdf-lib';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { forgetAccess } from '../../apps/cf_hrms/lib/accessContext.js';
import { hrmsAppOf, ensureCatalog, setRoleTags } from '../../apps/cf_hrms/services/accessGrants.js';
import { setupAccess } from '../../apps/cf_hrms/services/accessSetup.js';
import { areaTag } from '../../apps/cf_hrms/lib/access.js';
import { schemaSteps, PAYROLL_TAX_TABLES } from '../../apps/cf_hrms/scripts/apply-payroll-tax-schema.mjs';
import { TAX_RULE_ROWS } from '../../apps/cf_hrms/services/tax/index.js';
import { pdfBuffer } from '../../apps/cf_hrms/services/render/roleJd.js';
import { dueDateOf } from '../../apps/cf_hrms/services/payrollTax/challans.js';

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
const started = Date.now();
const iso = (d) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date(Date.now() - new Date().getTimezoneOffset() * 60000));
const plusDays = (n) => iso(new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000));

const TABLES = [...PAYROLL_TAX_TABLES, 'hrms_pay_runs', 'hrms_pay_run_people', 'hrms_pay_run_lines', 'hrms_pay_items', 'hrms_pay_salaries', 'hrms_pay_structures', 'hrms_pay_components',
  'hrms_audit_log', 'hrms_employees', 'hrms_employee_identifiers', 'users', 'app_user_access', 'roles', 'hrms_access_roles', 'hrms_tax_rules'];
const dbCfg = { host: process.env.DB_HOST ?? 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306 };
async function worldCount() {
  const conn = await mysql.createConnection(dbCfg);
  try {
    const out = {};
    for (const t of TABLES) {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(deleted_at IS NULL), 0) AS live FROM ${t}`);
      out[t] = `${r.n}/${r.live}`;
    }
    return out;
  } finally { await conn.end(); }
}
const before = await worldCount();

/* ══ 0. the schema and the rules ═══════════════════════════════════════ */
section('[0] The schema and the new rules');
{
  const conn = await mysql.createConnection(dbCfg);
  try {
    ok(PAYROLL_TAX_TABLES.length === 9, 'init.sql §30 declares nine hrms_tax_* tables', PAYROLL_TAX_TABLES.join(','));
    ok((await schemaSteps(conn)).length === 0, 'apply-payroll-tax-schema: nothing left to do on this database (idempotent)');
    const [del] = await conn.query(`SELECT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${PAYROLL_TAX_TABLES.map(() => '?').join(',')}) AND COLUMN_NAME = 'deleted_at'`, PAYROLL_TAX_TABLES);
    ok(del.length === 9, 'every new table has deleted_at');
    const [dec] = await conn.query("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'hrms_tax_%' AND DATA_TYPE = 'decimal' AND (NUMERIC_PRECISION <> 14 OR NUMERIC_SCALE <> 2)");
    ok(dec.length === 0, 'every amount is DECIMAL(14,2)');
    const [[tj]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_pay_run_people' AND COLUMN_NAME = 'tax_json'");
    ok(Number(tj.n) === 1, 'hrms_pay_run_people.tax_json is there');
    const [rules] = await conn.query("SELECT tax_year, regime, rule_key, value_json, source_url, verified FROM hrms_tax_rules WHERE rule_key IN ('tds_no_pan','declarations','tds_deposit','tds_return') AND deleted_at IS NULL");
    const r = (y, k) => rules.find((x) => x.tax_year === y && x.rule_key === k && x.regime === 'NEW');
    const v = (row) => (typeof row?.value_json === 'string' ? JSON.parse(row.value_json) : row?.value_json);
    ok(rules.length === 16 && rules.every((x) => x.source_url && Number(x.verified) === 1), 'the four payroll rules, both years, both regimes: seeded, each with its source, verified', String(rules.length));
    ok(v(r('2025-26', 'tds_no_pan')).section === 'section 206AA' && /397\(2\)/.test(v(r('2026-27', 'tds_no_pan')).section) && v(r('2026-27', 'tds_no_pan')).rate === 20, 'no PAN: s.206AA (2025-26), s.397(2) (2026-27), 20%');
    ok(v(r('2026-27', 'declarations')).landlordPanAbove === 100000 && /124/.test(v(r('2026-27', 'declarations')).form), 'Form 124: the landlord PAN above ₹1,00,000');
    ok(v(r('2026-27', 'tds_return')).sectionCode === '1002' && v(r('2025-26', 'tds_return')).sectionCode === '92B', 'section codes 92B (24Q) / 1002 (Form 138)');
    ok(TAX_RULE_ROWS.filter((x) => ['tds_no_pan', 'declarations', 'tds_deposit', 'tds_return'].includes(x.rule_key)).length === 16, 'the seed (ruleData.js) has them');
    ok(dueDateOf('2025-10') === '2025-11-07' && dueDateOf('2026-03', { dueDay: 7, marchDue: '04-30' }) === '2026-04-30' && dueDateOf('2025-12') === '2026-01-07', 'due dates: the 7th of the next month; March by 30 April');
  } finally { await conn.end(); }
}

/* ══ the database part: one transaction, rolled back ═══════════════════ */
const real = { query: pool.query.bind(pool), execute: pool.execute.bind(pool), getConnection: pool.getConnection.bind(pool) };
const db = await real.getConnection();
await db.beginTransaction();
let depth = 0;
const inside = {
  query: (...a) => db.query(...a),
  execute: (...a) => db.execute(...a),
  beginTransaction: async () => { depth += 1; await db.query(`SAVEPOINT zz_ptax_${depth}`); },
  commit: async () => { if (depth > 0) { await db.query(`RELEASE SAVEPOINT zz_ptax_${depth}`); depth -= 1; } },
  rollback: async () => { if (depth > 0) { await db.query(`ROLLBACK TO SAVEPOINT zz_ptax_${depth}`); depth -= 1; } },
  release: () => {},
};
pool.query = inside.query;
pool.execute = inside.execute;
pool.getConnection = async () => inside;

const TAG = `ZZTX${Date.now().toString(36).toUpperCase().slice(-5)}`;
const q = async (sql, params) => (await db.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
const b64 = (buf) => Buffer.from(buf).toString('base64');
async function makePdf(lines) {
  const doc = new PDFDocument({ size: 'A4' });
  for (const l of lines) doc.text(l);
  return pdfBuffer(doc);
}
// The smallest real PNG (1×1, a white pixel).
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082', 'hex');

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
  console.log(`\npayroll_tax_test — ${company.name} (${COMPANY}), run tag ${TAG}`);
  // The company's own runs and tax setup of 2025-26 (somebody's demo): out of the way, inside the transaction.
  await db.query("UPDATE hrms_pay_runs SET deleted_at = NOW() WHERE company_id = ? AND period_month BETWEEN '2025-04' AND '2026-03' AND deleted_at IS NULL", [COMPANY]);
  await db.query("UPDATE hrms_tax_settings SET deleted_at = NOW() WHERE company_id = ? AND tax_year IN ('2025-26', '2026-27') AND deleted_at IS NULL", [COMPANY]);
  await db.query('UPDATE hrms_tax_company SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  await db.query("UPDATE hrms_tax_challans SET deleted_at = NOW() WHERE company_id = ? AND tax_year = '2025-26' AND deleted_at IS NULL", [COMPANY]);

  await setupAccess(db, COMPANY, { apply: true });
  const roleByKey = Object.fromEntries((await q('SELECT role_id, template_key FROM hrms_access_roles WHERE company_id = ? AND deleted_at IS NULL AND template_key IS NOT NULL', [COMPANY])).map((r) => [r.template_key, r.role_id]));
  const catalog = await ensureCatalog(db, { apply: true });
  const noPayRole = await ins('INSERT INTO roles (name, company_id) VALUES (?, ?)', [`${TAG} Payroll clerk`, COMPANY]);
  await db.query("INSERT INTO hrms_access_roles (company_id, role_id, label, scope) VALUES (?, ?, ?, 'COMPANY')", [COMPANY, noPayRole, `${TAG} Payroll clerk`]);
  await setRoleTags(db, { companyId: COMPANY, appId: app.id, roleId: noPayRole, tags: [areaTag('payroll', 'view'), areaTag('payroll', 'edit')], catalog });

  const emp = async (code, joining, dob = null) => ins(
    "INSERT INTO hrms_employees (company_id, employee_code, full_name, date_of_joining, date_of_birth, employment_type, employment_status) VALUES (?, ?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE')",
    [COMPANY, `${TAG}${code}`, `${TAG} Person ${code}`, joining, dob]);
  const E = {};
  for (const [k, j] of [['N', '2024-04-01'], ['B', '2024-04-01'], ['P', '2025-07-01'], ['O', '2024-04-01'], ['X', '2024-04-01'], ['M', '2024-04-01'], ['S', '2024-04-01'], ['T', '2024-04-01']]) E[k] = await emp(k, j, '1990-05-05');
  const PANS = { N: 'AAAPN1234N', B: 'AAAPB1234B', P: 'AAAPP1234P', O: 'AAAPO1234O', M: 'AAAPM1234M', S: 'AAAPS1234S', T: 'AAAPT1234T' };
  for (const [k, pan] of Object.entries(PANS)) await db.query("INSERT INTO hrms_employee_identifiers (company_id, employee_id, identifier_type, identifier_value) VALUES (?, ?, 'PAN', ?)", [COMPANY, E[k], pan]);

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
    HR: await login('HR manager', roleByKey.HR_MANAGER), HRX: await login('HR executive', roleByKey.HR_EXECUTIVE), DH: await login('Department head', roleByKey.DEPARTMENT_HEAD),
    CLERK: await login('Clerk', noPayRole), S: await login('Employee S', roleByKey.EMPLOYEE, E.S), T: await login('Employee T', roleByKey.EMPLOYEE, E.T),
  };
  forgetAccess();
  server = express();
  server.use(express.json({ limit: '40mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  server.close = () => new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const call = async (who, method, url, body) => {
    const res = await fetch(`${base}/${company.slug}/cf_hrms${url}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const must = async (who, method, url, body) => {
    const r = await call(who, method, url, body);
    if (r.status !== 200) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };

  /* ── payroll set up, a simple structure, the salaries ───────────────── */
  await must(U.HR, 'POST', '/payroll/setup');
  const C = Object.fromEntries((await must(U.HR, 'GET', '/payroll/components')).components.map((k) => [k.code, k]));
  const st = (await must(U.HR, 'POST', '/payroll/structures', { code: `${TAG}S`, name: `${TAG} Basic half`, lines: [
    { componentId: C.BASIC.id, formula: '50% of CTC' }, { componentId: C.HRA.id, formula: '50% of BASIC' }, { componentId: C.SPECIAL.id, formula: 'balance' }] })).structure;
  const salary = (e, ctc, from) => must(U.HR, 'POST', '/payroll/salaries', { employeeId: e, annualCtc: ctc, structureId: st.id, effectiveFrom: from, pfMode: 'NONE', reason: 'Test', complianceReason: 'Test' });
  for (const [k, ctc, from] of [['N', 1800000, '2025-04-01'], ['B', 1500000, '2025-04-01'], ['P', 1800000, '2025-07-01'], ['O', 1200000, '2025-04-01'], ['X', 1800000, '2025-04-01'], ['M', 1800000, '2025-04-01'], ['S', 600000, '2025-04-01'], ['T', 600000, '2025-04-01']]) await salary(E[k], ctc, from);

  /* ══ 1. regime and the cut-off ═══════════════════════════════════════ */
  section('[1] Regime choice and the cut-off');
  const y25 = await must(U.HR, 'GET', '/tax/years/2025-26');
  ok(y25.settings.regimeCutoff === '2025-07-31' && y25.settings.declarationFrom === '2025-04-01' && y25.settings.proofTo === '2026-01-31' && !y25.settings.saved && y25.review.banner && y25.forms.certificate === 'Form 16',
    'a year with no settings: the defaults (declarations April, proofs January, cut-off 31 July); the CA banner; Form 16 for 2025-26', JSON.stringify(y25.settings));
  const y26 = await must(U.HR, 'GET', '/tax/years/2026-27');
  ok(y26.forms.certificate === 'Form 130 (was Form 16)' && y26.forms.declaration === 'Form 124 (was Form 12BB)' && y26.forms.quarterlyReturn === 'Form 138 (was Form 24Q)', 'forms named by year: Form 130, 124, 138 for 2026-27');
  const selfLate = await call(U.S, 'PUT', '/user/me/tax/2025-26/regime', { regime: 'OLD' });
  ok(selfLate.status === 409 && selfLate.json.code === 'PAST_CUTOFF', 'the person after the cut-off: refused, “HR can change it once more”', JSON.stringify(selfLate.json));
  const hrNoReason = await call(U.HR, 'PUT', `/tax/2025-26/profiles/${E.O}/regime`, { regime: 'OLD' });
  ok(hrNoReason.status === 422, 'HR after the cut-off without a reason: refused');
  const hrOnce = await must(U.HR, 'PUT', `/tax/2025-26/profiles/${E.O}/regime`, { regime: 'OLD', reason: 'Asked in writing on 12 Oct; rent and PPF' });
  ok(hrOnce.profile.regime === 'OLD' && hrOnce.profile.changesAfterCutoff === 1 && hrOnce.profile.regimeSetHow === 'HR', 'HR after the cut-off, with a reason: OLD (one change used)');
  const hrTwice = await call(U.HR, 'PUT', `/tax/2025-26/profiles/${E.O}/regime`, { regime: 'NEW', reason: 'Changed mind again' });
  ok(hrTwice.status === 409 && hrTwice.json.code === 'NO_MORE_CHANGES', 'a second change after the cut-off: refused');
  const audits = await q("SELECT after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_tax_profiles' AND after_json LIKE ?", [COMPANY, `%${E.O}%`]);
  ok(audits.length >= 1, 'the regime change is audited, with the reason');
  await must(U.HR, 'PUT', '/tax/years/2026-27', { regimeCutoff: plusDays(30) > '2027-03-31' ? '2027-03-31' : plusDays(30) });
  const selfIn = await must(U.S, 'PUT', '/user/me/tax/2026-27/regime', { regime: 'OLD' });
  const selfBack = await must(U.S, 'PUT', '/user/me/tax/2026-27/regime', { regime: 'NEW' });
  ok(selfIn.profile.regime === 'OLD' && selfIn.profile.regimeSetHow === 'SELF' && selfBack.profile.regime === 'NEW' && selfBack.profile.changesAfterCutoff === 0, 'before the cut-off the person chooses, and changes back');
  const notOwner = await call(U.HR, 'POST', '/tax/years/2025-26/ca-review', { reviewed: true });
  ok(notOwner.status === 409 && notOwner.json.code === 'OWNER_ONLY', '“Reviewed by our CA”: not HR');

  /* ══ 2. declarations and the windows ═════════════════════════════════ */
  section('[2] Declarations and the windows');
  const closed = await call(U.S, 'POST', '/user/me/tax/2026-27/declarations', { kind: 'PPF', amount: 50000 });
  ok(closed.status === 409 && closed.json.code === 'WINDOW_CLOSED', 'the declaration window (April) is closed: the person is refused', JSON.stringify(closed.json));
  await must(U.HR, 'PUT', `/tax/2026-27/profiles/${E.S}`, { declarationOpenUntil: plusDays(10) });
  const ppf = await must(U.S, 'POST', '/user/me/tax/2026-27/declarations', { kind: 'PPF', amount: 50000 });
  ok(ppf.line.status === 'DECLARED' && ppf.line.declaredAmount === 50000, 're-opened by HR for the person: they declare (PPF 50,000)');
  const noPan = await call(U.S, 'POST', '/user/me/tax/2026-27/declarations', { kind: 'RENT', details: { monthlyRent: 15000, landlordName: 'R. Rao' } });
  ok(noPan.status === 422 && /Landlord’s PAN/.test(JSON.stringify(noPan.json)), 'rent 1,80,000 a year without the landlord’s PAN: refused (above ₹1,00,000)');
  const rentS = await must(U.S, 'POST', '/user/me/tax/2026-27/declarations', { kind: 'RENT', details: { monthlyRent: 15000, landlordName: 'R. Rao', landlordPan: 'BBBPR1234R' } });
  const small = await must(U.S, 'POST', '/user/me/tax/2026-27/declarations', { kind: 'RENT', details: { monthlyRent: 8000, fromMonth: '2026-04', toMonth: '2026-12', landlordName: 'K. Das' } });
  ok(rentS.line.declaredAmount === 180000 && small.line.declaredAmount === 72000, 'with the PAN: 15,000 × 12 = 1,80,000; 8,000 × 9 = 72,000 needs none');
  const mine = await must(U.S, 'GET', '/user/me/tax/2026-27/declarations');
  ok(mine.lines.length === 3 && mine.declare.open && mine.form === 'Form 124 (was Form 12BB)' && mine.kinds.some((k) => k.kind === 'RENT' && /279|Schedule III/.test(k.section ?? '')), 'the person sees their lines, the window, the kinds with the year’s sections', JSON.stringify(mine.kinds.find((k) => k.kind === 'RENT')));
  const otherWin = await call(U.T, 'POST', '/user/me/tax/2026-27/declarations', { kind: 'PPF', amount: 1 });
  ok(otherWin.status === 409, 're-opening is per person: T is still refused');
  const tLine = await call(U.T, 'PUT', `/user/me/tax/declarations/${ppf.line.id}`, { amount: 1 });
  ok(tLine.status === 404, 'T cannot change S’s line (not found for them)', String(tLine.status));
  const hrAny = await must(U.HR, 'POST', `/tax/2026-27/declarations/${E.T}`, { kind: 'LIC', amount: 12000 });
  ok(hrAny.line.declaredAmount === 12000, 'HR declares for a person any time');
  await must(U.HR, 'PUT', '/tax/years/2026-27', { declarationFrom: '2026-04-01', declarationTo: plusDays(5) > '2027-03-31' ? '2027-03-31' : plusDays(5) });
  const tNow = await call(U.T, 'POST', '/user/me/tax/2026-27/declarations', { kind: 'PPF', amount: 1000 });
  ok(tNow.status === 200, 'HR moves the company window to include today: everybody declares');

  /* ══ 3. proofs ═══════════════════════════════════════════════════════ */
  section('[3] Proofs, with real files');
  const pdf = await makePdf(['PPF passbook', 'Deposit 50,000']);
  const early = await call(U.T, 'POST', `/user/me/tax/declarations/${tNow.json.line.id}/proofs`, { fileName: 'ppf.pdf', contentBase64: b64(pdf) });
  ok(early.status === 409 && early.json.code === 'WINDOW_CLOSED', 'the proof window (January) is not open: refused');
  const up = await must(U.S, 'POST', `/user/me/tax/declarations/${ppf.line.id}/proofs`, { fileName: 'ppf.pdf', contentBase64: b64(pdf) });
  ok(up.line.status === 'SUBMITTED' && up.line.files.length === 1 && up.line.files[0].mimeType === 'application/pdf' && up.line.files[0].sizeBytes === pdf.length, 'S (re-opened) uploads a real PDF: SUBMITTED');
  const png = await must(U.S, 'POST', `/user/me/tax/declarations/${rentS.line.id}/proofs`, { fileName: 'receipt.png', contentBase64: b64(PNG) });
  ok(png.line.files[0].mimeType === 'image/png', 'a PNG: its type read from the bytes');
  const txt = await call(U.S, 'POST', `/user/me/tax/declarations/${rentS.line.id}/proofs`, { fileName: 'fake.pdf', contentBase64: b64(Buffer.from('not a pdf at all')) });
  ok(txt.status === 422, 'a text file named .pdf: refused (the bytes decide)');
  const big = Buffer.concat([pdf, Buffer.alloc(10 * 1024 * 1024)]);
  const tooBig = await call(U.S, 'POST', `/user/me/tax/declarations/${rentS.line.id}/proofs`, { fileName: 'big.pdf', contentBase64: b64(big) });
  ok(tooBig.status === 422 && /10\.0 MB/.test(JSON.stringify(tooBig.json)), 'over 10 MB: refused, said with the limit');
  const nine = Buffer.concat([pdf, crypto.randomBytes(9 * 1024 * 1024)]);
  const nineUp = await must(U.S, 'POST', `/user/me/tax/declarations/${small.line.id}/proofs`, { fileName: 'scan.pdf', contentBase64: b64(nine) });
  const chunks = await one('SELECT chunk_count FROM hrms_tax_files WHERE id = ?', [nineUp.fileId]);
  const back = await must(U.S, 'GET', `/user/me/tax/proofs/${nineUp.fileId}`);
  ok(Number(chunks.chunk_count) >= 2 && Buffer.from(back.contentBase64, 'base64').equals(nine), 'a 9 MB file: stored in pieces, read back byte for byte', String(chunks.chunk_count));
  const queue = await must(U.HR, 'GET', '/tax/2026-27/proofs?status=SUBMITTED');
  const ours = queue.lines.filter((l) => l.employee.id === E.S);
  ok(ours.length === 3 && ours.every((l) => l.files.length && l.proofHint), 'HR’s queue: the three submitted lines with their files');
  const view = await must(U.HR, 'GET', `/tax/proof-files/${up.line.files[0].id}`);
  ok(Buffer.from(view.contentBase64, 'base64').equals(pdf), 'HR opens the file (the viewer)');
  const tooMuch = await call(U.HR, 'POST', `/tax/declaration-lines/${ppf.line.id}/verify`, { acceptedAmount: 60000 });
  ok(tooMuch.status === 422, 'accepting more than declared: refused');
  const v1 = await must(U.HR, 'POST', `/tax/declaration-lines/${ppf.line.id}/verify`, { acceptedAmount: 40000 });
  ok(v1.line.status === 'VERIFIED' && v1.line.acceptedAmount === 40000, 'VERIFIED at a lower amount (40,000 of 50,000)');
  const noReason = await call(U.HR, 'POST', `/tax/declaration-lines/${rentS.line.id}/reject`, {});
  const rej = await must(U.HR, 'POST', `/tax/declaration-lines/${rentS.line.id}/reject`, { reason: 'The receipt has no landlord signature' });
  ok(noReason.status === 422 && rej.line.status === 'REJECTED' && rej.line.rejectReason, 'REJECTED needs a reason; the person sees it');
  const again = await must(U.S, 'POST', `/user/me/tax/declarations/${rentS.line.id}/proofs`, { fileName: 'signed.pdf', contentBase64: b64(pdf) });
  ok(again.line.status === 'SUBMITTED' && !again.line.rejectReason, 'a new proof submits it again');
  const bulk = await must(U.HR, 'POST', '/tax/2026-27/proofs/bulk-accept', { lineIds: [rentS.line.id, small.line.id, ppf.line.id] });
  ok(bulk.accepted.length === 2 && bulk.skipped.length === 1 && /verified/.test(bulk.skipped[0].why), 'bulk accept: the two submitted ones; the verified one skipped, said why', JSON.stringify(bulk));
  const lockedOut = await call(U.S, 'DELETE', `/user/me/tax/declarations/${ppf.line.id}`);
  ok(lockedOut.status === 409, 'a verified line cannot be removed by the person');

  /* ══ 4. TDS in the runs ══════════════════════════════════════════════ */
  section('[4] TDS in the runs, by hand');
  // B's bonus, P's previous employer, O's claims; O lives in Mumbai.
  const oct = (await must(U.HR, 'POST', '/payroll/runs', { month: '2025-10' })).run;
  await must(U.HR, 'POST', `/payroll/runs/${oct.id}/items`, { employeeId: E.B, componentId: C.BONUS.id, amount: 100000, note: 'Diwali' });
  await must(U.HR, 'POST', `/tax/2025-26/declarations/${E.P}`, { kind: 'PREVIOUS_EMPLOYER', details: { employerName: 'Old Co', tan: 'HYDO12345A', salary: 300000, exemptions: 0, pt: 600, tds: 10000 } });
  await must(U.HR, 'PUT', `/tax/2025-26/profiles/${E.O}`, { city: 'Mumbai' });
  const oRent = await must(U.HR, 'POST', `/tax/2025-26/declarations/${E.O}`, { kind: 'RENT', details: { monthlyRent: 30000, landlordName: 'S. Shah', landlordPan: 'CCCPS1234S' } });
  const oPpf = await must(U.HR, 'POST', `/tax/2025-26/declarations/${E.O}`, { kind: 'PPF', amount: 100000 });
  const oLic = await must(U.HR, 'POST', `/tax/2025-26/declarations/${E.O}`, { kind: 'LIC', amount: 30000 });
  const noReasonTds = await call(U.HR, 'PUT', `/payroll/runs/${oct.id}/people/${E.M}/tds`, { amount: 10000 });
  ok(noReasonTds.status === 422, 'an override without a reason: refused');
  await must(U.HR, 'PUT', `/payroll/runs/${oct.id}/people/${E.M}/tds`, { amount: 10000, reason: 'Agreed with the employee: investments coming' });
  let calc = await must(U.HR, 'POST', `/payroll/runs/${oct.id}/calculate`);
  const P = (r) => Object.fromEntries(r.people.map((p) => [p.employee.id, p]));
  let p = P(calc);
  ok(p[E.N].tds === 25133 && p[E.N].tdsSource === 'ENGINE' && p[E.N].tax.regime === 'NEW', 'N, ₹18,00,000, new regime: 1,50,800 ÷ 6 = 25,133 (ENGINE)', JSON.stringify(p[E.N].tax));
  ok(p[E.B].tds === 18850, 'B with a bonus of 1,00,000: 1,13,100 ÷ 6 = 18,850', String(p[E.B].tds));
  ok(p[E.P].tds === 18483, 'P, joined in July, a previous employer (3,00,000; TDS 10,000): (1,20,900 − 10,000) ÷ 6 = 18,483', String(p[E.P].tds));
  ok(p[E.O].tds === 9710 && p[E.O].tax.regime === 'OLD', 'O, old regime, HRA (Mumbai) and 80C as declared: 58,260 ÷ 6 = 9,710', String(p[E.O].tds));
  ok(p[E.X].tds === 57500 && p[E.X].tax.noPan && p[E.X].warnings.some((w) => w.code === 'TDS_NO_PAN') && p[E.X].warnings.some((w) => w.code === 'NO_PAN'), 'X, no PAN: 20% of 17,25,000 = 3,45,000 ÷ 6 = 57,500, flagged on the run', String(p[E.X].tds));
  ok(p[E.M].tds === 10000 && p[E.M].tdsSource === 'MANUAL' && p[E.M].tax.engineTds === 25133 && p[E.M].warnings.some((w) => w.code === 'TDS_MANUAL'), 'M: HR’s 10,000 with the reason wins; the engine’s 25,133 kept beside it', JSON.stringify(p[E.M].tax));
  ok(p[E.S].tds === 0 && p[E.S].tdsSource === 'ENGINE', 'S, ₹6,00,000: nothing (the rebate)');
  const personO = await must(U.HR, 'GET', `/payroll/runs/${oct.id}/people/${p[E.O].id}`);
  ok(personO.lines.some((l) => l.code === 'TDS' && l.amount === 9710 && /old regime/.test(l.basis)) && personO.person.tax.lines.length >= 4, 'the run line: TDS with its basis; the working kept (tax_json)', JSON.stringify(personO.lines.find((l) => l.code === 'TDS')));
  const sheetO = await must(U.HR, 'GET', `/tax/2025-26/sheet/${E.O}?month=2025-10`);
  ok(sheetO.available && sheetO.tds.thisMonth === 9710 && sheetO.regimes.OLD.projectedTax === 58260 && sheetO.regimes.NEW.projectedTax === 0 && sheetO.cheaper === 'NEW' && sheetO.saving === 58260 && /You save ₹58,260 in the new regime/.test(sheetO.sentence),
    'the tax sheet: both regimes side by side (58,260 old, 0 new) — “you save ₹58,260 in the new regime”', sheetO.sentence);
  ok(sheetO.regimes.OLD.computation.exemptions.some((e) => e.key === 'exempt_hra' && e.exempt === 300000) && sheetO.regimes.NEW.computation.refused.some((r) => r.key === 'ded_80c') && sheetO.timeline.filter((t) => t.kind === 'ESTIMATED').length === 6,
    'HRA exempt 3,00,000 (old); the new regime refuses 80C, said; six months estimated before the first locked run');
  ok(sheetO.claims.every((cl) => cl.how === 'as declared') && sheetO.warnings.some((w) => /no locked payroll/.test(w)), 'the window is open: the claims count as declared; the estimate is said');

  // Proofs closed: only what HR verified counts. (A second later than the calculation: updated_at is to the second.)
  await new Promise((r) => { setTimeout(r, 1100); });
  for (const l of [oRent, oPpf, oLic]) await must(U.HR, 'POST', `/tax/declaration-lines/${l.line.id}/proofs`, { fileName: 'proof.pdf', contentBase64: b64(pdf) });
  await must(U.HR, 'POST', `/tax/declaration-lines/${oRent.line.id}/verify`, {});
  await must(U.HR, 'POST', `/tax/declaration-lines/${oPpf.line.id}/verify`, { acceptedAmount: 80000 });
  await must(U.HR, 'POST', `/tax/declaration-lines/${oLic.line.id}/reject`, { reason: 'Policy of the spouse' });
  await must(U.HR, 'PUT', '/tax/years/2025-26', { proofFrom: '2025-10-01', proofTo: '2025-10-15' });
  const stale = await call(U.HR, 'POST', `/payroll/runs/${oct.id}/lock`);
  ok(stale.status === 409 && stale.json.code === 'STALE' && /tax/.test(stale.json.message), 'lock refused: a tax input changed since the calculation', stale.json?.message);
  calc = await must(U.HR, 'POST', `/payroll/runs/${oct.id}/calculate`);
  p = P(calc);
  ok(p[E.O].tds === 11443, 'O after the proof window closed: PPF 80,000 verified, LIC rejected, rent verified → 68,660 ÷ 6 = 11,443', String(p[E.O].tds));
  ok(p[E.N].tds === 25133 && p[E.P].tds === 18483, 'the others unchanged (the previous employer still counts)');
  const sheetO2 = await must(U.HR, 'GET', `/tax/2025-26/sheet/${E.O}?month=2025-10`);
  ok(sheetO2.proofsStatus === 'CLOSED' && sheetO2.claims.find((x) => x.kind === 'LIC').counted === 0 && sheetO2.claims.find((x) => x.kind === 'PPF').counted === 80000, 'the sheet: proofs closed — LIC 0 (rejected), PPF 80,000 (verified)');
  const clearM = await must(U.HR, 'DELETE', `/payroll/runs/${oct.id}/people/${E.M}/tds`);
  calc = await must(U.HR, 'POST', `/payroll/runs/${oct.id}/calculate`);
  ok(clearM.cleared === 1 && P(calc)[E.M].tds === 25133 && P(calc)[E.M].tdsSource === 'ENGINE', 'the override cleared: back to the engine (25,133)');
  await must(U.HR, 'PUT', `/payroll/runs/${oct.id}/people/${E.M}/tds`, { amount: 10000, reason: 'Agreed with the employee: investments coming' });
  calc = await must(U.HR, 'POST', `/payroll/runs/${oct.id}/calculate`);
  const octTds = calc.people.reduce((s, x) => s + x.tds, 0);
  await must(U.HR, 'POST', `/payroll/runs/${oct.id}/lock`);
  await must(U.HR, 'POST', `/payroll/runs/${oct.id}/release`);
  const slipTds = await one("SELECT JSON_EXTRACT(snapshot_json, '$.tds') AS t FROM hrms_pay_payslips WHERE company_id = ? AND run_id = ? AND employee_id = ? AND status = 'RELEASED'", [COMPANY, oct.id, E.N]);
  ok(Number(slipTds.t) === 25133, 'the payslip prints the month’s TDS');

  // November: N's raise from 1 Nov; M a perquisite (for Form 12BA).
  await salary(E.N, 2400000, '2025-11-01');
  const pq = (await must(U.HR, 'POST', '/payroll/components', { code: `${TAG}PQ`, name: 'Perquisite — company car', kind: 'EARNING', taxable: 'YES', exemptionRule: 'PERQUISITE', frequency: 'YEARLY', prorateOnLop: false })).component;
  const nov = (await must(U.HR, 'POST', '/payroll/runs', { month: '2025-11' })).run;
  await must(U.HR, 'POST', `/payroll/runs/${nov.id}/items`, { employeeId: E.M, componentId: pq.id, amount: 12000, note: 'Car, Nov' });
  const novCalc = await must(U.HR, 'POST', `/payroll/runs/${nov.id}/calculate`);
  const pn = P(novCalc);
  ok(pn[E.N].tds === 35533 && pn[E.N].tax.projectedTax === 202800, 'N in November after a raise to ₹24,00,000: (2,02,800 − 25,133 deducted) ÷ 5 = 35,533', JSON.stringify(pn[E.N].tax));
  const sheetN = await must(U.HR, 'GET', `/tax/2025-26/sheet/${E.N}?month=2025-11`);
  ok(sheetN.tds.soFar === 25133 && sheetN.timeline.find((t) => t.month === '2025-10').kind === 'PAID' && sheetN.timeline.find((t) => t.month === '2025-10').tds === 25133 && sheetN.run.status === 'CALCULATED',
    'the November sheet: October PAID with its TDS; the run’s figure');
  await must(U.HR, 'POST', `/payroll/runs/${nov.id}/lock`);
  const novTds = novCalc.people.reduce((s, x) => s + x.tds, 0);

  /* ══ 5. challans ═════════════════════════════════════════════════════ */
  section('[5] Challans');
  let ch = await must(U.HR, 'GET', '/tax/2025-26/challans');
  const octM = ch.months.find((m) => m.month === '2025-10');
  ok(octM.status === 'UNPAID' && octM.deducted === octTds && octM.overdue && octM.due === '2025-11-07' && ch.warnings.some((w) => /October 2025.*not paid by 2025-11-07/.test(w)),
    'October’s TDS unpaid after the 7th of November: warned', JSON.stringify({ s: octM.status, d: octM.deducted, w: ch.warnings[0] }));
  const badCh = await call(U.HR, 'POST', '/tax/2025-26/challans', { month: '2025-10', challanSerial: '12', bsrCode: '12', depositDate: '2025-11-05', tax: 100 });
  ok(badCh.status === 422 && /BSR code: seven digits/.test(JSON.stringify(badCh.json)), 'a BSR code must be seven digits');
  const c1 = await must(U.HR, 'POST', '/tax/2025-26/challans', { month: '2025-10', challanSerial: '00123', bsrCode: '0510308', depositDate: '2025-11-06', tax: 100000 });
  ch = await must(U.HR, 'GET', '/tax/2025-26/challans');
  ok(ch.months.find((m) => m.month === '2025-10').status === 'SHORT' && c1.challan.total === 100000, 'a part paid: SHORT, still warned');
  await must(U.HR, 'POST', '/tax/2025-26/challans', { month: '2025-10', challanSerial: '00456', bsrCode: '0510308', depositDate: '2025-11-20', tax: octTds - 100000, interest: 500 });
  await must(U.HR, 'POST', '/tax/2025-26/challans', { month: '2025-11', challanSerial: '00789', bsrCode: '0510308', depositDate: '2025-12-05', tax: novTds });
  ch = await must(U.HR, 'GET', '/tax/2025-26/challans');
  const octPaid = ch.months.find((m) => m.month === '2025-10');
  ok(octPaid.status === 'PAID' && !octPaid.overdue && /after the due date/.test(octPaid.warning ?? '') && ch.months.find((m) => m.month === '2025-11').status === 'PAID', 'paid in full, the second challan late: PAID, with the interest note');

  /* ══ 6. the quarterly return ═════════════════════════════════════════ */
  section('[6] Quarterly return data (Form 24Q for 2025-26)');
  let q3 = await must(U.HR, 'GET', '/tax/2025-26/quarters/Q3');
  ok(q3.form === 'Form 24Q' && q3.due === '2026-01-31' && q3.challans.length === 3 && q3.validation.some((v) => v.level === 'ERROR' && /TAN/.test(v.what)), 'Q3: Form 24Q, due 31 January, three challans; no TAN → an error', JSON.stringify(q3.validation.slice(0, 2)));
  const rowsX = q3.deductees.filter((r) => r.employee.id === E.X);
  ok(rowsX.length === 2 && rowsX.every((r) => r.pan === 'PANNOTAVBL' && r.remark === 'C' && r.sectionCode === '92B'), 'X without a PAN: PANNOTAVBL, remark C (the higher rate), section 92B');
  const rowN = q3.deductees.find((r) => r.employee.id === E.N && r.month === '2025-10');
  ok(rowN.tds === 25133 && rowN.amountPaid === 150000 && rowN.challanNo && rowN.dateDeposited, 'N in October: paid 1,50,000, TDS 25,133, under its challan');
  ok(q3.challans.reduce((s, x) => s + x.allocated, 0) === q3.totals.deducted, 'every row allocated to a challan of its month');
  await must(U.HR, 'PUT', '/tax/deductor', { tan: 'HYDK12345A', pan: 'AAACK1234K', name: 'Karni Packaging Private Limited', address: { line1: 'Unit-2, Bibi Nagar', city: 'Hyderabad', state: 'Telangana', pin: '508126' }, responsible: { name: 'A. Owner', designation: 'Director' } });
  const badTan = await call(U.HR, 'PUT', '/tax/deductor', { tan: 'HYD123' });
  q3 = await must(U.HR, 'GET', '/tax/2025-26/quarters/Q3');
  ok(badTan.status === 422 && !q3.validation.some((v) => /TAN/.test(v.what)), 'the deductor set: the TAN error gone; a bad TAN refused');
  const wbk = await must(U.HR, 'GET', '/tax/2025-26/quarters/Q3/workbook');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(wbk.contentBase64, 'base64'));
  ok(['Read me', 'Deductor', 'Challans', 'Annexure I', 'Validation'].every((s) => wb.getWorksheet(s)) && /RPU/.test(wb.getWorksheet('Read me').getCell('A2').value) && wb.getWorksheet('Annexure I').rowCount === q3.deductees.length + 1,
    'the workbook: Read me (the RPU makes the FVU file), Deductor, Challans, Annexure I, Validation', wbk.fileName);
  const q4 = await must(U.HR, 'GET', '/tax/2025-26/quarters/Q4');
  const a2 = q4.annexureII.find((a) => a.employee.id === E.O);
  ok(q4.annexureII.length >= 7 && a2.optingOut === 'Y' && a2.tdsCurrent > 11443 && a2.rentOver1Lakh === 'Y' && q4.validation.some((v) => /provisional/.test(v.what)),
    'Q4: Annexure II for everybody paid; O opted out, rent above ₹1 lakh; the year not complete → provisional', JSON.stringify({ n: q4.annexureII.length, o: a2?.optingOut, r: a2?.rentOver1Lakh }));

  /* ══ 7. Form 16 ══════════════════════════════════════════════════════ */
  section('[7] Form 16 Part B and Part A');
  const gen = await must(U.HR, 'POST', '/tax/2025-26/forms/generate', {});
  ok(gen.form === 'Form 16' && gen.made.length >= 7 && gen.made.every((m) => m.provisional), 'Part B generated for everybody paid in 2025-26 (provisional: March not locked)', JSON.stringify(gen.made.length));
  const fN = await must(U.HR, 'GET', `/tax/2025-26/forms/${E.N}/file?part=B`);
  const bN = Buffer.from(fN.contentBase64, 'base64');
  const docN = await PdfLib.load(bN);
  ok(bN.subarray(0, 5).toString() === '%PDF-' && docN.getPageCount() >= 1 && /Form16_2025-26_/.test(fN.fileName), 'Part B is a PDF', fN.fileName);
  const snap = await one('SELECT snapshot_json FROM hrms_tax_forms WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND deleted_at IS NULL', [COMPANY, E.N, '2025-26']);
  const S = typeof snap.snapshot_json === 'string' ? JSON.parse(snap.snapshot_json) : snap.snapshot_json;
  const row = (no, label) => S.rows.find((r) => r.no === no && (!label || r.label.includes(label)));
  ok(row('A').text === 'No' && row('(d)', 'Total').amount === 350000 && row('12').amount === 275000 && row('19').amount === S.totalTax && S.tds.total === 25133 + 35533,
    'N’s Part B: opting out No; gross 3,50,000 (Oct + Nov paid); taxable 2,75,000; net tax = row 17; TDS 60,666', JSON.stringify({ d: row('(d)', 'Total')?.amount, t: row('12')?.amount, tds: S.tds }));
  const fM = await must(U.HR, 'GET', `/tax/2025-26/forms/${E.M}/file?part=B`);
  const mDoc = await PdfLib.load(Buffer.from(fM.contentBase64, 'base64'));
  const mSnap = await one('SELECT snapshot_json FROM hrms_tax_forms WHERE company_id = ? AND employee_id = ? AND tax_year = ? AND deleted_at IS NULL', [COMPANY, E.M, '2025-26']);
  const MS = typeof mSnap.snapshot_json === 'string' ? JSON.parse(mSnap.snapshot_json) : mSnap.snapshot_json;
  ok(MS.perquisiteTotal === 12000 && mDoc.getPageCount() >= 2 && MS.rows.find((r) => r.no === '(b)' && /17\(2\)/.test(r.label)).amount === 12000, 'M with a perquisite: 17(2) 12,000 and Form 12BA annexed (a second page)');
  // Part A: a ZIP of TRACES-like PDFs — PAN in the file name, PAN only in the text, and one of nobody.
  const zip = new JSZip();
  zip.file(`${PANS.B}_2026-27.pdf`, await makePdf(['FORM NO. 16 PART A', 'Certificate']));
  zip.file('certificate_0002.pdf', await makePdf(['FORM NO. 16 PART A', `PAN of the Employee ${PANS.N}`]));
  zip.file('certificate_0003.pdf', await makePdf(['FORM NO. 16 PART A', 'PAN of the Employee ZZZZZ9999Z']));
  const zbuf = await zip.generateAsync({ type: 'nodebuffer' });
  const pa = await must(U.HR, 'POST', '/tax/2025-26/forms/part-a', { fileName: 'partA.zip', contentBase64: b64(zbuf) });
  ok(pa.files === 3 && pa.matched.length === 2 && pa.matched.find((m) => m.employeeId === E.B).by === 'FILE_NAME' && pa.matched.find((m) => m.employeeId === E.N).by === 'CONTENT' && pa.unmatched.length === 1,
    'Part A ZIP: B matched by the PAN in the file name, N by the PAN in the text, one unmatched', JSON.stringify(pa));
  await must(U.HR, 'PUT', `/tax/2025-26/forms/part-a/${pa.unmatched[0].fileId}`, { employeeId: E.O });
  const list = await must(U.HR, 'GET', '/tax/2025-26/forms');
  ok(list.people.find((x) => x.employee.id === E.O).partA && list.unmatched.length === 0, 'the unmatched file assigned by hand to O');
  const lockedZip = await call(U.HR, 'POST', '/tax/2025-26/forms/part-a', { fileName: 'x.zip', contentBase64: b64(Buffer.from('PK\u0003\u0004 locked rubbish')) });
  ok(lockedZip.status === 422 && /TRACES PDF Converter/.test(JSON.stringify(lockedZip.json)), 'a ZIP that cannot be opened (TRACES’s own, locked with the TAN): said what to do');
  const merged = await must(U.HR, 'GET', `/tax/2025-26/forms/${E.N}/file?part=merged`);
  const mergedDoc = await PdfLib.load(Buffer.from(merged.contentBase64, 'base64'));
  ok(merged.merged && mergedDoc.getPageCount() === docN.getPageCount() + 1 && merged.fileName === `Form16_2025-26_${TAG}N.pdf`, 'the download: Part A + Part B in one PDF', `${mergedDoc.getPageCount()} ${merged.fileName}`);

  /* ══ 8. privacy and rights ═══════════════════════════════════════════ */
  section('[8] Privacy and rights');
  {
    const st2 = async (who, method, url, body) => (await call(who, method, url, body)).status;
    const notYet = await call(U.S, 'GET', '/user/me/tax/2025-26/forms/file');
    ok(notYet.status === 409 && notYet.json.code === 'NOT_RELEASED' && (await must(U.S, 'GET', '/user/me/tax/forms')).forms.length === 0, 'before HR releases: the person has no form');
    await must(U.HR, 'POST', '/tax/2025-26/forms/release', { release: true });
    const myF = await must(U.S, 'GET', '/user/me/tax/forms');
    const myFile = await must(U.S, 'GET', '/user/me/tax/2025-26/forms/file');
    ok(myF.forms.length === 1 && myF.forms[0].form === 'Form 16' && Buffer.from(myFile.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-', 'released: the person downloads their own Form 16');
    const mySheet = await must(U.S, 'GET', '/user/me/tax/2025-26/sheet?month=2025-10');
    ok(mySheet.employee.id === E.S && mySheet.available, 'the person’s own tax sheet');
    const year = await must(U.S, 'GET', '/user/me/tax/2026-27');
    ok(year.compare && year.regime.chosen === 'NEW' && year.review.banner && year.forms.certificate.startsWith('Form 130'), 'My tax: the regime compare, the choice, the CA banner, the year’s form');
    ok(await st2(U.T, 'GET', `/user/me/tax/proofs/${up.line.files[0].id}`) === 422 && await st2(U.T, 'DELETE', `/user/me/tax/proofs/${up.line.files[0].id}`) === 422, 'T cannot open or remove S’s proof');
    ok(await st2(U.S, 'GET', `/tax/2025-26/sheet/${E.N}`) === 403 && await st2(U.S, 'GET', '/tax/2025-26/profiles') === 403 && await st2(U.S, 'GET', `/tax/proof-files/${up.line.files[0].id}`) === 403, 'an employee login: no HR tax route');
    const clerk = await call(U.CLERK, 'GET', `/tax/2025-26/sheet/${E.N}`);
    ok(await st2(U.CLERK, 'GET', '/tax/2025-26/profiles') === 200 && clerk.status === 403 && clerk.json.code === 'PAY_HIDDEN' && await st2(U.CLERK, 'GET', '/tax/2025-26/proofs') === 403 && await st2(U.CLERK, 'GET', '/tax/2025-26/quarters/Q3') === 403,
      'payroll view without pay view: profiles yes; sheets, proofs, the return’s rows no (PAY_HIDDEN)');
    ok(await st2(U.DH, 'GET', '/tax/2025-26/profiles') === 403 && await st2(U.HRX, 'GET', `/tax/2025-26/sheet/${E.N}`) === 200 && await st2(U.HRX, 'DELETE', `/tax/challans/${c1.challan.id}`) === 403, 'department head: nothing; HR executive: reads, cannot remove');
    const before2 = Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read' AND entity_id = ?", [COMPANY, E.N])).n);
    await must(U.HR, 'GET', `/tax/2025-26/sheet/${E.N}`);
    const after2 = Number((await one("SELECT COUNT(*) AS n FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_pay_salary_read' AND entity_id = ?", [COMPANY, E.N])).n);
    ok(after2 === before2 + 1, 'HR reading a person’s tax sheet is audited');
    const tick = await must(O, 'POST', '/tax/years/2025-26/ca-review', { reviewed: true, note: 'Reviewed by the CA' });
    ok(tick.settings.caReviewed && tick.review.banner === null, 'the Owner ticks “Reviewed by our CA for 2025-26”: the banner goes');
  }
} catch (err) {
  ok(false, 'the run finished', `${err.message} ${(err.stack ?? '').split('\n').slice(1, 3).join(' ')}`);
} finally {
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
  ok(moved.length === 0, `every count is what it was (${TABLES.length} tables)`, moved.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; '));
}

console.log(`\n${passed} passed, ${failed.length} failed  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
