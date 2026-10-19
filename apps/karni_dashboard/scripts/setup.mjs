/**
 * Sets up karni_dashboard for a company: the schema, the app row, and access
 * for the company's admin-role users (app_user_access, with their own role).
 *
 *   node apps/karni_dashboard/scripts/setup.mjs                      dry run, local
 *   node apps/karni_dashboard/scripts/setup.mjs --apply              write, local
 *   node apps/karni_dashboard/scripts/setup.mjs --apply --target=prod   write, TiDB
 *   --company=<slug>  (default karni)   --all-users  (everyone in the company, not only admins)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from '../../cf_hrms/scripts/dbTarget.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const ALL_USERS = process.argv.includes('--all-users');
const SLUG = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const APP = { name: 'Karni Dashboard', slug: 'karni_dashboard' };

const target = resolveTarget();
announce(target);
console.log(APPLY ? '  mode: APPLY\n' : '  mode: dry run (add --apply to write)\n');

const conn = await mysql.createConnection({ ...target.cfg, multipleStatements: true });
const one = async (sql, p = []) => (await conn.query(sql, p))[0][0] ?? null;

const company = await one('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [SLUG]);
if (!company) { console.error(`No company "${SLUG}".`); process.exit(1); }
console.log(`company   ${company.id}  ${company.name}`);

// 1. Schema (CREATE TABLE IF NOT EXISTS — safe to re-run)
const [[tbl]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'kd\\_%'");
console.log(`schema    ${tbl.n}/9 kd_ tables present`);
// init.sql is all CREATE TABLE IF NOT EXISTS: safe to run every time, adds only what is missing.
if (APPLY && tbl.n < 9) {
  await conn.query(fs.readFileSync(path.join(__dir, '..', 'models', 'init.sql'), 'utf8'));
  console.log('schema    applied');
}

// 2. App row
let app = await one('SELECT id FROM apps WHERE company_id = ? AND slug = ? AND deleted_at IS NULL', [company.id, APP.slug]);
if (app) console.log(`app       exists   id=${app.id}`);
else if (APPLY) {
  const [r] = await conn.query('INSERT INTO apps (company_id, name, slug, is_public) VALUES (?, ?, ?, 1)', [company.id, APP.name, APP.slug]);
  app = { id: r.insertId };
  console.log(`app       created  id=${app.id}`);
} else console.log('app       would create');

// 3. Access: each user keeps their own company role in this app
const [users] = await conn.query(
  `SELECT u.id, u.email, u.role_id, r.name AS role FROM users u LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.company_id = ? AND u.deleted_at IS NULL ${ALL_USERS ? '' : "AND LOWER(r.name) = 'admin'"}`,
  [company.id]);
for (const u of users) {
  const has = app && await one('SELECT id FROM app_user_access WHERE user_id = ? AND app_id = ? AND deleted_at IS NULL', [u.id, app.id]);
  if (has) { console.log(`access    exists   ${u.email} (${u.role})`); continue; }
  if (APPLY) {
    await conn.query('INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?, ?, ?, ?)', [u.id, app.id, u.role_id, company.id]);
    console.log(`access    granted  ${u.email} (${u.role})`);
  } else console.log(`access    would grant  ${u.email} (${u.role})`);
}
if (!users.length) console.log('access    no matching users');

await conn.end();
