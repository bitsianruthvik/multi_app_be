/**
 * Sets up sumangal_dashboard for a company: the schema, the app row, and access
 * for the company's admin-role users (app_user_access, with their own role).
 *
 *   node apps/sumangal_dashboard/scripts/setup.mjs                  dry run, local
 *   node apps/sumangal_dashboard/scripts/setup.mjs --apply          write, local
 *   --company=<slug> (default sumangal)   --name="Company name"   --target=prod
 *
 * If the company does not exist, a LOCAL run creates it with an admin login
 * (admin@<slug>.test, the standard local password from CLAUDE.md). Prod never does.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from '../../cf_hrms/scripts/dbTarget.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const arg = (k, v) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${v}`).split('=')[1];
const SLUG = arg('company', 'sumangal');
const NAME = arg('name', 'Sumangal Castings Pvt. Ltd.');
const APP = { name: 'Sumangal Dashboard', slug: 'sumangal_dashboard' };
const LOCAL_PASSWORD = 'Test@1234';

const target = resolveTarget();
announce(target);
console.log(APPLY ? '  mode: APPLY\n' : '  mode: dry run (add --apply to write)\n');

const conn = await mysql.createConnection({ ...target.cfg, multipleStatements: true });
const one = async (sql, p = []) => (await conn.query(sql, p))[0][0] ?? null;

let company = await one('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [SLUG]);
if (!company) {
  if (target.isProd) { console.error(`No company "${SLUG}" on production. Create it first.`); process.exit(1); }
  if (!APPLY) { console.log(`company   would create ${SLUG} with an admin login`); await conn.end(); process.exit(0); }
  const [c] = await conn.query('INSERT INTO companies (name, slug) VALUES (?, ?)', [NAME, SLUG]);
  company = { id: c.insertId, name: NAME };
  const [r] = await conn.query('INSERT INTO roles (name, company_id) VALUES (?, ?)', ['admin', company.id]);
  await conn.query('INSERT INTO users (name, email, password, role_id, company_id) VALUES (?, ?, ?, ?, ?)',
    ['Admin', `admin@${SLUG}.test`, await bcrypt.hash(LOCAL_PASSWORD, 10), r.insertId, company.id]);
  console.log(`company   created ${company.id}, login admin@${SLUG}.test`);
} else console.log(`company   ${company.id}  ${company.name}`);

const table = await one("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'sd_rows'");
console.log(`schema    ${table.n ? 'present' : 'missing'}`);
if (APPLY && !table.n) {
  await conn.query(fs.readFileSync(path.join(__dir, '..', 'models', 'init.sql'), 'utf8'));
  console.log('schema    applied');
}

let app = await one('SELECT id FROM apps WHERE company_id = ? AND slug = ? AND deleted_at IS NULL', [company.id, APP.slug]);
if (app) console.log(`app       exists   id=${app.id}`);
else if (APPLY) {
  const [r] = await conn.query('INSERT INTO apps (company_id, name, slug, is_public) VALUES (?, ?, ?, 1)', [company.id, APP.name, APP.slug]);
  app = { id: r.insertId };
  console.log(`app       created  id=${app.id}`);
} else console.log('app       would create');

const [users] = await conn.query(
  `SELECT u.id, u.email, u.role_id, r.name AS role FROM users u LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin'`, [company.id]);
for (const u of users) {
  const has = app && await one('SELECT id FROM app_user_access WHERE user_id = ? AND app_id = ? AND deleted_at IS NULL', [u.id, app.id]);
  if (has) { console.log(`access    exists   ${u.email}`); continue; }
  if (APPLY) {
    await conn.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [u.id, app.id, u.role_id, company.id]);
    console.log(`access    granted  ${u.email}`);
  } else console.log(`access    would grant  ${u.email}`);
}
await conn.end();
