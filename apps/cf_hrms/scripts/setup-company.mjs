/**
 * setup-company.mjs — a new, EMPTY company with CF_HRMS and one Owner login.
 *
 *   node setup-company.mjs --slug=karni-sandbox --name="Karni Sandbox" \
 *        --email=test@karni-sandbox.com --password-like=test@karni.com          DRY RUN
 *   ... --apply                                                                 writes (local)
 *   ... --apply --target=prod                                                   writes (TiDB)
 *
 *   --password-like=<email>  the new login gets THAT login's password: its bcrypt hash is copied
 *                            row to row. The password itself is never read, known or printed,
 *                            nor is the hash. Refused when that login does not exist on the target.
 *   --password=<text>        LOCAL ONLY, instead of --password-like (refused with --target=prod).
 *   --user-name="..."        the login's name (default "<company name> Test").
 *
 * WHAT IT DOES, in order, each step "created" or "exists":
 *    1. the company row                 (slug checked against what the platform routes can carry)
 *    2. its cf_hrms app row
 *    3. the platform role `admin`       (the Owner: the platform lets that name through)
 *    4. the login                       (refused if the email belongs to another company)
 *    5. app_user_access                 (login -> this company's cf_hrms app, role admin)
 *    6. the rights model                services/accessSetup.js — what setup-access.mjs runs, for
 *                                       THIS company: the feature/capability catalogue (global,
 *                                       created once), the ready-made roles Owner (= admin, every
 *                                       right incl. cf_hrms_access_manage), HR manager, HR executive,
 *                                       Department head, Employee, with their hrms_access_roles rows
 *                                       and grants. This covers models/seed.sql §1–3b.
 *    7. reporting relationship types    seed.sql §5, for this company only
 *    8. shifts G / D / N + their days   seed.sql §6, for this company only
 *    9. the Kind label list             labelGroupService.ensureKind (otherwise made on first read)
 *   10. performance settings            setup-performance.mjs's function (no roles yet, so settings only)
 *   11. payroll                         setup-payroll.mjs's function: ready-made components, the sample
 *                                       structure, statutory rows of Telangana, payroll settings state TG
 *   Code formats are NOT written: an empty company has no codes to continue from, and each built-in
 *   default rule (services/codeService.js DEFAULT_RULES) is made on the first code it issues.
 *   Holiday calendars, tax settings, attendance settings and leave policies are likewise made on
 *   first use / from the screens. Nothing of any other company is read except the --password-like
 *   row's hash, and nothing of any other company is written.
 *
 * Dry run by default: the whole thing runs in a transaction that is rolled back, so the dry run
 * says exactly what an apply would do. Idempotent: a second run says "exists" everywhere.
 * Local by default (scripts/dbTarget.mjs).
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { setupAccess } from '../services/accessSetup.js';
import { setupPerformance } from './setup-performance.mjs';
import { seedPayroll } from '../services/payroll/seed.js';
import { ensureKind } from '../services/labelGroupService.js';
import { ALL_TAGS } from '../lib/access.js';
import { weekOf, summaryOf } from '../services/shiftRead.js';

const require = createRequire(import.meta.url);

/* ── what the platform accepts ─────────────────────────────────────────── */

/**
 * A company slug is the first path segment of every API and screen URL
 * (/api/:company/:app/..., /:company/:app/login). Nothing in core checks its shape,
 * so this is the safe set: lower-case letters and digits, words joined by one - or _
 * (existing slugs: northeast-chit, pharma_labs). companies.slug is VARCHAR(100).
 */
export const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/** First segments the backend or the frontend already routes, or appContext skips (core/middleware/appContext.js, index.js, App.tsx). */
export const RESERVED_SLUGS = new Set(['api', 'public', 'query', 'integrations', 'admin', 'iclock', 'uploads', 'debug', 'health', 'select-company', 'login', 'auth', 'apps', 'schema', 'platform']);

/** The backend login (core/auth/authController.js loginUser). */
export const BACKEND_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * The login SCREEN (multi_app_fe pages/auth/Login.tsx and CompanyLanding.tsx) checks the field with
 * yup's string().email() — the WHATWG rule, which allows no underscore in the domain. A login the
 * screen refuses can only be used over the API, so it is refused here too.
 */
export const SCREEN_EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function checkSlug(slug) {
  if (!slug) return 'a slug is required (--slug=...)';
  if (slug.length < 2 || slug.length > 100) return 'a slug is 2 to 100 characters';
  if (!SLUG_RE.test(slug)) return 'a slug is lower-case letters and digits, words joined by one "-" or "_"';
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is already a route of the platform`;
  return null;
}

export function checkEmail(email) {
  if (!email) return 'an email is required (--email=...)';
  if (email.length > 100) return 'users.email is at most 100 characters';
  if (!BACKEND_EMAIL_RE.test(email)) return 'the backend login refuses this email';
  if (!SCREEN_EMAIL_RE.test(email)) return 'the login screen refuses this email (its check allows letters, digits and "-" in the domain, no "_")';
  return null;
}

/* ── the work ──────────────────────────────────────────────────────────── */

/**
 * Does the work on `conn` (the caller owns the transaction). Returns
 * { company, app, role, user, steps: [{ step, status, detail }], checks }.
 * Throws with a plain message when something must be settled first.
 */
export async function setupCompany(conn, { slug, name, email, userName, passwordLike = null, password = null, isProd = false }) {
  const bad = checkSlug(slug) ?? checkEmail(email);
  if (bad) throw new Error(bad);
  if (!name?.trim()) throw new Error('a company name is required (--name=...)');
  if (!passwordLike === !password) throw new Error('give exactly one of --password-like=<email> and --password=<text>');
  if (password && isProd) throw new Error('--password is local only; on production use --password-like=<email>');
  if (password && password.length < 8) throw new Error('the backend login needs at least 8 characters');
  email = email.toLowerCase();
  const steps = [];
  const step = (s, status, detail = '') => steps.push({ step: s, status, detail });
  const one = async (sql, p = []) => (await conn.query(sql, p))[0][0] ?? null;

  // The password first: nothing is written when it cannot be had.
  let hash;
  if (passwordLike) {
    const src = await one('SELECT password FROM users WHERE email = ? AND deleted_at IS NULL', [passwordLike.toLowerCase()]);
    if (!src?.password) throw new Error(`no live login ${passwordLike} on this database — nothing to copy the password from`);
    hash = src.password;
  } else {
    hash = await require('bcryptjs').hash(password, 10);
  }

  // 1. company. companies.slug is unique, deleted rows included.
  let company = await one('SELECT id, name, deleted_at FROM companies WHERE slug = ?', [slug]);
  if (company?.deleted_at) throw new Error(`a DELETED company holds the slug "${slug}" (id ${company.id}); settle that first`);
  if (company) step('company', 'exists', `id ${company.id} "${company.name}"`);
  else {
    const [r] = await conn.query('INSERT INTO companies (name, slug) VALUES (?, ?)', [name.trim(), slug]);
    company = { id: r.insertId, name: name.trim() };
    step('company', 'created', `id ${company.id} "${company.name}" slug ${slug}`);
  }
  const companyId = company.id;

  // 2. the cf_hrms app row (same name / is_public as every other company's).
  let app = await one('SELECT id, deleted_at FROM apps WHERE company_id = ? AND slug = ?', [companyId, 'cf_hrms']);
  if (app?.deleted_at) throw new Error(`the company's cf_hrms app row ${app.id} is deleted; settle that first`);
  if (app) step('cf_hrms app', 'exists', `id ${app.id}`);
  else {
    const [r] = await conn.query("INSERT INTO apps (company_id, name, slug, is_public) VALUES (?, 'CF HRMS', 'cf_hrms', 1)", [companyId]);
    app = { id: r.insertId };
    step('cf_hrms app', 'created', `id ${app.id}`);
  }

  // 3. the platform role `admin` — the Owner.
  let role = await one("SELECT id FROM roles WHERE company_id = ? AND LOWER(name) = 'admin' AND deleted_at IS NULL ORDER BY id LIMIT 1", [companyId]);
  if (role) step('admin role', 'exists', `id ${role.id}`);
  else {
    const [r] = await conn.query("INSERT INTO roles (name, company_id) VALUES ('admin', ?)", [companyId]);
    role = { id: r.insertId };
    step('admin role', 'created', `id ${role.id}`);
  }

  // 4. the login. users.email is unique across the platform, deleted rows included.
  let user = await one('SELECT id, company_id, role_id, deleted_at, password FROM users WHERE email = ?', [email]);
  if (user && Number(user.company_id) !== Number(companyId)) {
    throw new Error(`${email} already belongs to another company (id ${user.company_id}); choose another email`);
  }
  if (user?.deleted_at) throw new Error(`${email} is a DELETED login of this company (id ${user.id}); settle that first`);
  if (user) {
    const notes = [];
    if (Number(user.role_id) !== Number(role.id)) notes.push(`its company role is ${user.role_id}, not admin ${role.id} — left as it is`);
    notes.push(user.password === hash ? 'password: same as the source' : 'password: DIFFERS from the source — left as it is');
    step('login', 'exists', `id ${user.id} ${email}; ${notes.join('; ')}`);
  } else {
    const [r] = await conn.query('INSERT INTO users (name, email, password, role_id, company_id) VALUES (?, ?, ?, ?, ?)',
      [userName?.trim() || `${company.name} Test`, email, hash, role.id, companyId]);
    user = { id: r.insertId, role_id: role.id };
    step('login', 'created', `id ${user.id} ${email}, role admin, password ${passwordLike ? `copied from ${passwordLike}` : 'set from --password'}`);
  }

  // 5. app_user_access — without it the role's grants open nothing.
  const aua = await one('SELECT id, role_id, deleted_at FROM app_user_access WHERE user_id = ? AND app_id = ?', [user.id, app.id]);
  if (aua?.deleted_at) {
    await conn.query('UPDATE app_user_access SET deleted_at = NULL, role_id = ? WHERE id = ?', [role.id, aua.id]);
    step('app access', 'restored', `row ${aua.id}`);
  } else if (aua) step('app access', 'exists', `row ${aua.id}${Number(aua.role_id) !== Number(role.id) ? ` (role ${aua.role_id}, left as it is)` : ''}`);
  else {
    const [r] = await conn.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [user.id, app.id, role.id, companyId]);
    step('app access', 'created', `row ${r.insertId}, role admin`);
  }

  // 6. the rights model: catalogue, ready-made roles, grants (setup-access for this company).
  const access = await setupAccess(conn, companyId, { apply: true, userId: user.id });
  if (access.problems.length) throw new Error(`access setup refused: ${access.problems.join(' | ')}`);
  const cat = access.catalog;
  step('rights catalogue', cat.features.length || cat.capabilities.length ? 'created' : 'exists',
    `${ALL_TAGS.length} rights; features created ${cat.features.length}, capabilities created ${cat.capabilities.length}${cat.repaired.length ? `, repaired ${cat.repaired.join(',')}` : ''}`);
  for (const r of access.roles) {
    step(`access role ${r.label}`, r.existed && r.accessRow === 'exists' && r.same ? 'exists' : 'created',
      `platform role "${r.platformName}" id ${r.roleId}, scope ${r.scope}, ${r.after.length} rights${r.gained.length && r.existed ? ` (+${r.gained.length})` : ''}`);
  }

  // 7. reporting relationship types (seed.sql §5), this company only.
  const [rt] = await conn.query(
    `INSERT INTO hrms_reporting_relationship_types (company_id, code, name, is_formal, allow_multiple, sort_order, status)
     SELECT ?, t.code, t.name, t.is_formal, t.allow_multiple, t.sort_order, 'ACTIVE'
       FROM (
         SELECT 'PRIMARY_MANAGER' AS code, 'Primary Manager' AS name, 1 AS is_formal, 0 AS allow_multiple, 10 AS sort_order UNION ALL
         SELECT 'FUNCTIONAL_MANAGER', 'Functional Manager', 1, 1, 20 UNION ALL
         SELECT 'ADMINISTRATIVE_MANAGER', 'Administrative Manager', 1, 1, 30 UNION ALL
         SELECT 'DOTTED_LINE', 'Dotted Line', 0, 1, 40 UNION ALL
         SELECT 'PROJECT_MANAGER', 'Project Manager', 0, 1, 50 UNION ALL
         SELECT 'SHIFT_SUPERVISOR', 'Shift Supervisor', 0, 1, 60
       ) t
      WHERE NOT EXISTS (SELECT 1 FROM hrms_reporting_relationship_types x WHERE x.company_id = ? AND x.code = t.code AND x.deleted_at IS NULL)`,
    [companyId, companyId]);
  step('reporting types', rt.affectedRows ? 'created' : 'exists', `${rt.affectedRows} of 6 added`);

  // 8. shifts G / D / N and their seven days (seed.sql §6), this company only.
  const [sh] = await conn.query(
    `INSERT INTO hrms_shifts (company_id, code, name, start_time, end_time, crosses_midnight, grace_in_minutes, grace_out_minutes, status)
     SELECT ?, s.code, s.name, s.start_time, s.end_time, s.crosses_midnight, 0, 0, 'ACTIVE'
       FROM (
         SELECT 'G' AS code, 'General' AS name, CAST(NULL AS TIME) AS start_time, CAST(NULL AS TIME) AS end_time, 0 AS crosses_midnight UNION ALL
         SELECT 'D', 'Day', CAST('08:00:00' AS TIME), CAST('20:00:00' AS TIME), 0 UNION ALL
         SELECT 'N', 'Night', CAST('20:00:00' AS TIME), CAST('08:00:00' AS TIME), 1
       ) s
      WHERE NOT EXISTS (SELECT 1 FROM hrms_shifts x WHERE x.company_id = ? AND x.code = s.code AND x.deleted_at IS NULL)`,
    [companyId, companyId]);
  const [sd] = await conn.query(
    `INSERT INTO hrms_shift_days (company_id, shift_id, weekday, is_working, start_time, end_time, crosses_midnight, break_minutes)
     SELECT s.company_id, s.id, d.weekday, IF(d.weekday <= 6, 1, 0), IF(d.weekday <= 6, s.start_time, NULL), IF(d.weekday <= 6, s.end_time, NULL),
            IF(d.weekday <= 6 AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL AND s.end_time <= s.start_time, 1, 0), 0
       FROM hrms_shifts s
       JOIN (SELECT 1 AS weekday UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7) d
      WHERE s.company_id = ? AND s.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM hrms_shift_days x WHERE x.company_id = s.company_id AND x.shift_id = s.id AND x.weekday = d.weekday)`,
    [companyId]);
  // Each shift's summary line (hrms_shifts.week_summary), as every screen and apply-shift-calendar-schema write it.
  const [shiftRows] = await conn.query('SELECT id, start_time, end_time, week_summary FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const [dayRows] = await conn.query('SELECT shift_id, weekday, is_working, start_time, end_time, break_minutes FROM hrms_shift_days WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  let summaries = 0;
  for (const r of shiftRows) {
    const line = summaryOf(weekOf(dayRows.filter((d) => d.shift_id === r.id), r));
    if (r.week_summary !== line) { await conn.query('UPDATE hrms_shifts SET week_summary = ? WHERE id = ?', [line, r.id]); summaries += 1; }
  }
  step('shifts', sh.affectedRows || sd.affectedRows || summaries ? 'created' : 'exists', `${sh.affectedRows} of 3 shifts added, ${sd.affectedRows} shift days added, ${summaries} summary lines written`);

  // 9. the Kind label list.
  const [[k0]] = await conn.query('SELECT COUNT(*) AS n FROM hrms_label_groups WHERE company_id = ? AND deleted_at IS NULL AND is_kind = 1', [companyId]);
  const kind = await ensureKind(conn, companyId, user.id);
  step('kind labels', Number(k0.n) ? 'exists' : 'created', `group "${kind.kind?.name}", labels ${kind.labels.map((l) => l.name).join(', ')}`);

  // 10. performance settings.
  const perf = await setupPerformance(conn, companyId, { apply: true, userId: user.id });
  step('performance settings', perf.settings === 'kept' ? 'exists' : 'created',
    perf.settings === 'kept' ? 'already saved' : 'year from April, default QUARTERLY, rating 1–5');

  // 11. payroll.
  const pay = await seedPayroll(conn, { companyId, userId: user.id }, 'setup-company');
  const payDid = pay.components.length || pay.structure || pay.statutory.length || pay.settings;
  step('payroll', payDid ? 'created' : 'exists',
    `components +${pay.components.length}, structure ${pay.structure ? `+${pay.structure}` : 'there'}, statutory rows +${pay.statutory.length}, settings ${pay.settings ? '+state TG' : 'there'}`);

  step('code formats', 'skipped', 'built-in defaults are made on first use (EMP0000, HR/{fy}/000, ...)');

  // What the company now holds, read back.
  const count = async (sql, p) => Number((await one(sql, p)).n);
  const checks = {
    ownerTags: await count(
      `SELECT COUNT(DISTINCT f.feature_tag) AS n FROM role_capability rc
         JOIN features_capability fc ON fc.capability_id = rc.capability_id AND fc.deleted_at IS NULL
         JOIN features f ON JSON_CONTAINS(fc.features_json, CAST(f.id AS JSON)) AND f.feature_tag LIKE 'cf\\_hrms\\_%'
        WHERE rc.role_id = ? AND rc.app_id = ? AND rc.deleted_at IS NULL`, [role.id, app.id]),
    hasAccessManage: await count(
      `SELECT COUNT(*) AS n FROM role_capability rc
         JOIN features_capability fc ON fc.capability_id = rc.capability_id AND fc.deleted_at IS NULL AND fc.name = 'cf_hrms_access_manage'
        WHERE rc.role_id = ? AND rc.app_id = ? AND rc.deleted_at IS NULL`, [role.id, app.id]) > 0,
    ownerRow: await one('SELECT label, scope, template_key FROM hrms_access_roles WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL', [companyId, role.id]),
    foreignGrants: await count(
      `SELECT COUNT(*) AS n FROM role_capability rc JOIN roles r ON r.id = rc.role_id
        WHERE r.company_id = ? AND (rc.company_id <> ? OR rc.app_id IS NULL OR rc.app_id <> ?) AND rc.deleted_at IS NULL`, [companyId, companyId, app.id]),
    logins: await count('SELECT COUNT(*) AS n FROM app_user_access WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    departments: await count('SELECT COUNT(*) AS n FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    employees: await count('SELECT COUNT(*) AS n FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    components: await count('SELECT COUNT(*) AS n FROM hrms_pay_components WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
  };
  return { company: { id: companyId, slug, name: company.name }, app, role, user: { id: user.id, email }, steps, checks };
}

/* ── the command ───────────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const arg = (n) => { const hit = args.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(hit.indexOf('=') + 1) : null; };
  const APPLY = args.includes('--apply');
  const opts = {
    slug: arg('slug'), name: arg('name'), email: arg('email'), userName: arg('user-name'),
    passwordLike: arg('password-like'), password: arg('password'),
  };
  // Refuse bad input before touching any database.
  const bad = checkSlug(opts.slug) ?? checkEmail(opts.email);
  if (bad) throw new Error(bad);
  const target = resolveTarget();
  opts.isProd = target.isProd;
  if (opts.password && target.isProd) throw new Error('--password is local only; on production use --password-like=<email>');
  announce(target);
  console.log(`  ${APPLY ? 'APPLY' : 'DRY RUN — the work runs in a transaction that is rolled back; nothing is kept without --apply'}\n`);

  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    await conn.beginTransaction();
    const out = await setupCompany(conn, opts);
    if (APPLY) await conn.commit(); else await conn.rollback();
    const w = Math.max(...out.steps.map((s) => s.step.length));
    for (const s of out.steps) console.log(`  ${s.step.padEnd(w)}  ${s.status.padEnd(8)} ${s.detail}`);
    const c = out.checks;
    console.log('\n  check');
    console.log(`    Owner (admin) holds ${c.ownerTags} of ${ALL_TAGS.length} cf_hrms rights; access_manage: ${c.hasAccessManage ? 'yes' : 'NO'}; access role: ${c.ownerRow ? `${c.ownerRow.label} / ${c.ownerRow.scope} / ${c.ownerRow.template_key}` : 'NONE'}`);
    console.log(`    grants of this company's roles pointing outside its own cf_hrms app: ${c.foreignGrants}`);
    console.log(`    logins with app access ${c.logins}; org units ${c.departments}; employees ${c.employees}; pay components ${c.components}`);
    console.log(APPLY ? `\n  done. Log in at /${out.company.slug}/cf_hrms/login as ${out.user.email}.\n` : '\n  rolled back — nothing written. Run again with --apply.\n');
  } catch (e) {
    try { await conn.rollback(); } catch { /* the first error is the one that matters */ }
    throw e;
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
}
