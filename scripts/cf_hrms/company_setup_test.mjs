/**
 * company_setup_test.mjs — a new, empty company with CF_HRMS (apps/cf_hrms/scripts/setup-company.mjs).
 *
 *   1. the slug and email checks: what the platform routes and the login screen accept;
 *   2. the refusals: no source login, --password on production, an email of another company;
 *   3. a throwaway company: every step "created", the password hash copied (compared in SQL,
 *      never printed), the Owner holds every right incl. access_manage, the five ready-made
 *      roles, reporting types, shifts, the Kind list, performance and payroll defaults;
 *   4. a second run: every step "exists", nothing added;
 *   5. isolation: the new company's grants point only at its own app; the source company's
 *      rows are the same before and after;
 *   6. nothing is left: the whole run is one transaction, rolled back, and checked afterwards.
 *
 *   node scripts/cf_hrms/company_setup_test.mjs [--company=karni] [--verbose]
 * Local only. Needs the source company's login (default test@<company>.com).
 */
import mysql from 'mysql2/promise';
import { setupCompany, checkSlug, checkEmail } from '../../apps/cf_hrms/scripts/setup-company.mjs';
import { ALL_TAGS } from '../../apps/cf_hrms/lib/access.js';

const args = process.argv.slice(2);
const arg = (n) => { const hit = args.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(hit.indexOf('=') + 1) : null; };
const VERBOSE = args.includes('--verbose');
const SOURCE_SLUG = arg('company') ?? 'karni';
const SOURCE_EMAIL = `test@${SOURCE_SLUG}.com`;

let pass = 0; let fail = 0;
const check = (what, ok, detail = '') => {
  if (ok) { pass += 1; if (VERBOSE) console.log(`  ok    ${what}`); } else { fail += 1; console.log(`  FAIL  ${what}${detail ? `  — ${detail}` : ''}`); }
};
const throwsWith = async (what, fn, re) => {
  try { await fn(); check(what, false, 'did not refuse'); } catch (e) { check(what, re.test(e.message), e.message); }
};

const conn = await mysql.createConnection({ host: 'localhost', user: 'root', password: '1234', database: 'sqldb', port: 3306, dateStrings: true });
const one = async (sql, p = []) => (await conn.query(sql, p))[0][0] ?? null;
const n = async (sql, p = []) => Number((await one(sql, p)).n);

const stamp = Date.now().toString(36);
const SLUG = `zz-setup-test-${stamp}`;
const EMAIL = `owner@zz-setup-test-${stamp}.com`;
const base = { slug: SLUG, name: 'Zz Setup Test', email: EMAIL, passwordLike: SOURCE_EMAIL };

try {
  // 1. checks
  check('slug karni-sandbox accepted', checkSlug('karni-sandbox') === null);
  check('slug with underscore accepted (pharma_labs exists)', checkSlug('karni_sandbox') === null);
  for (const s of ['Karni', 'karni sandbox', '-karni', 'karni--x', 'k', 'public', 'query', 'api', 'a/b']) check(`slug "${s}" refused`, checkSlug(s) !== null);
  check('email test@karni-sandbox.com accepted', checkEmail('test@karni-sandbox.com') === null);
  check('email test@karni_sandbox.com refused (login screen)', /login screen/.test(checkEmail('test@karni_sandbox.com') ?? ''));
  check('email without a dot refused', checkEmail('a@b') !== null);

  const source = await one('SELECT u.id, u.company_id FROM users u WHERE u.email = ? AND u.deleted_at IS NULL', [SOURCE_EMAIL]);
  check(`source login ${SOURCE_EMAIL} exists`, Boolean(source));
  if (!source) throw new Error('no source login');
  const srcCo = source.company_id;
  const snapshot = async () => ({
    roles: await n('SELECT COUNT(*) n FROM roles WHERE company_id = ?', [srcCo]),
    grants: await n('SELECT COUNT(*) n FROM role_capability WHERE company_id = ?', [srcCo]),
    accessRoles: await n('SELECT COUNT(*) n FROM hrms_access_roles WHERE company_id = ?', [srcCo]),
    aua: await n('SELECT COUNT(*) n FROM app_user_access WHERE company_id = ?', [srcCo]),
    comps: await n('SELECT COUNT(*) n FROM hrms_pay_components WHERE company_id = ?', [srcCo]),
    shifts: await n('SELECT COUNT(*) n FROM hrms_shifts WHERE company_id = ?', [srcCo]),
    users: await n('SELECT COUNT(*) n FROM users WHERE company_id = ?', [srcCo]),
    srcHash: (await one('SELECT MD5(password) h FROM users WHERE id = ?', [source.id])).h,
  });
  const before = await snapshot();

  await conn.beginTransaction();

  // 2. refusals (each throws before writing anything)
  await throwsWith('no source login refused', () => setupCompany(conn, { ...base, passwordLike: `nobody-${stamp}@nowhere.com` }), /no live login/);
  await throwsWith('--password refused on production', () => setupCompany(conn, { ...base, passwordLike: null, password: 'Whatever@123', isProd: true }), /local only/);
  await throwsWith('both password options refused', () => setupCompany(conn, { ...base, password: 'Whatever@123' }), /exactly one/);
  await throwsWith('bad email refused', () => setupCompany(conn, { ...base, email: 'x@under_score.com' }), /login screen/);
  check('nothing written by the refusals', (await n('SELECT COUNT(*) n FROM companies WHERE slug = ?', [SLUG])) === 0);

  // 3. first run
  const r1 = await setupCompany(conn, base);
  const s1 = Object.fromEntries(r1.steps.map((s) => [s.step, s.status]));
  for (const k of ['company', 'cf_hrms app', 'admin role', 'login', 'app access', 'reporting types', 'shifts', 'kind labels', 'performance settings', 'payroll']) {
    check(`run 1: ${k} created`, s1[k] === 'created', s1[k]);
  }
  for (const label of ['Owner', 'HR manager', 'HR executive', 'Department head', 'Employee']) check(`run 1: access role ${label} created`, s1[`access role ${label}`] === 'created');
  const cid = r1.company.id;
  check('hash copied from the source login', (await n('SELECT COUNT(*) n FROM users a JOIN users b ON b.id = ? WHERE a.id = ? AND a.password = b.password', [source.id, r1.user.id])) === 1);
  check('login row: this company, role admin', (await n("SELECT COUNT(*) n FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.company_id = ? AND r.name = 'admin'", [r1.user.id, cid])) === 1);
  check('app_user_access: one row, own app, admin', (await n('SELECT COUNT(*) n FROM app_user_access WHERE company_id = ? AND user_id = ? AND app_id = ? AND role_id = ?', [cid, r1.user.id, r1.app.id, r1.role.id])) === 1);
  check(`Owner holds all ${ALL_TAGS.length} rights`, r1.checks.ownerTags === ALL_TAGS.length, String(r1.checks.ownerTags));
  check('Owner holds cf_hrms_access_manage', r1.checks.hasAccessManage);
  check('Owner access row', r1.checks.ownerRow?.template_key === 'OWNER' && r1.checks.ownerRow?.scope === 'COMPANY');
  check('five platform roles', (await n('SELECT COUNT(*) n FROM roles WHERE company_id = ? AND deleted_at IS NULL', [cid])) === 5);
  check('six reporting types', (await n('SELECT COUNT(*) n FROM hrms_reporting_relationship_types WHERE company_id = ?', [cid])) === 6);
  check('three shifts, 21 days', (await n('SELECT COUNT(*) n FROM hrms_shifts WHERE company_id = ?', [cid])) === 3
    && (await n('SELECT COUNT(*) n FROM hrms_shift_days WHERE company_id = ?', [cid])) === 21);
  check('Kind group with labels', (await n('SELECT COUNT(*) n FROM hrms_label_groups WHERE company_id = ? AND is_kind = 1', [cid])) === 1
    && (await n('SELECT COUNT(*) n FROM hrms_department_labels WHERE company_id = ?', [cid])) >= 3);
  check('performance settings', (await n('SELECT COUNT(*) n FROM hrms_performance_settings WHERE company_id = ?', [cid])) === 1);
  check('payroll: components, structure, statutory, settings TG', r1.checks.components > 0
    && (await n("SELECT COUNT(*) n FROM hrms_pay_structures WHERE company_id = ? AND code = 'STAFF_STD'", [cid])) === 1
    && (await n('SELECT COUNT(*) n FROM hrms_pay_statutory_settings WHERE company_id = ?', [cid])) > 0
    && (await n("SELECT COUNT(*) n FROM hrms_pay_settings WHERE company_id = ? AND state_code = 'TG'", [cid])) === 1);
  check('empty: no org units, employees or positions', r1.checks.departments === 0 && r1.checks.employees === 0
    && (await n('SELECT COUNT(*) n FROM hrms_positions WHERE company_id = ?', [cid])) === 0);

  // 4. second run
  const grants1 = await n('SELECT COUNT(*) n FROM role_capability WHERE company_id = ?', [cid]);
  const audit1 = await n('SELECT COUNT(*) n FROM hrms_audit_log WHERE company_id = ?', [cid]);
  const r2 = await setupCompany(conn, base);
  const notExists = r2.steps.filter((s) => !['exists', 'skipped'].includes(s.status));
  check('run 2: every step exists', notExists.length === 0, notExists.map((s) => `${s.step}=${s.status}`).join(', '));
  check('run 2: same company, login and role', r2.company.id === cid && r2.user.id === r1.user.id && r2.role.id === r1.role.id);
  check('run 2: login says the password is the same', /password: same/.test(r2.steps.find((s) => s.step === 'login')?.detail ?? ''));
  check('run 2: no extra grants', (await n('SELECT COUNT(*) n FROM role_capability WHERE company_id = ?', [cid])) === grants1);
  check('run 2: nothing audited', (await n('SELECT COUNT(*) n FROM hrms_audit_log WHERE company_id = ?', [cid])) === audit1);
  await throwsWith('an email of another company refused', () => setupCompany(conn, { ...base, email: SOURCE_EMAIL }), /another company/);

  // 5. isolation
  check('new grants point only at the new app', r1.checks.foreignGrants === 0);
  check('no grant of the new company sits on another company\'s role', (await n('SELECT COUNT(*) n FROM role_capability rc JOIN roles r ON r.id = rc.role_id WHERE rc.company_id = ? AND r.company_id <> ?', [cid, cid])) === 0);
  check('no row of another company points at the new app', (await n('SELECT COUNT(*) n FROM role_capability WHERE app_id = ? AND company_id <> ?', [r1.app.id, cid])) === 0
    && (await n('SELECT COUNT(*) n FROM app_user_access WHERE app_id = ? AND company_id <> ?', [r1.app.id, cid])) === 0);
  const during = await snapshot();
  for (const k of Object.keys(before)) check(`source company unchanged: ${k}`, before[k] === during[k], `${before[k]} -> ${during[k]}`);
} catch (e) {
  fail += 1;
  console.log(`  FAIL  ${e.message}`);
} finally {
  try { await conn.rollback(); } catch { /* nothing open */ }
  // 6. nothing left
  check('rolled back: no company', (await n('SELECT COUNT(*) n FROM companies WHERE slug = ?', [SLUG])) === 0);
  check('rolled back: no login', (await n('SELECT COUNT(*) n FROM users WHERE email = ?', [EMAIL])) === 0);
  await conn.end();
  console.log(`\ncompany_setup_test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
