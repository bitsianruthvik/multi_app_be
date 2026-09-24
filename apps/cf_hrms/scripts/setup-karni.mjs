/**
 * Creates the Karni Packaging tenant locally: company, the cf_hrms app row, an
 * admin role, a test login, and the permission grants the platform needs.
 *
 * A grant needs BOTH `role_capability` (what the role may do) AND
 * `app_user_access` (that this user may open this app) — one without the other
 * looks like a working setup and is not. models/seed.sql writes both, but only
 * for companies that already have the app row, so the order here matters:
 * company -> app -> role -> user -> seed.
 *
 * LOCAL DEVELOPMENT ONLY. It writes a known test password.
 *
 *   node setup-karni.mjs
 */
import path from 'path';
import { createRequire } from 'module';
import mysql from 'mysql2/promise';

const require = createRequire(import.meta.url);
const bcrypt = require(path.join(process.cwd(), 'node_modules', 'bcryptjs'));

const DB = { host: 'localhost', user: 'root', password: '1234', database: 'sqldb', port: 3306 };
const COMPANY = { name: 'Karni Packaging Pvt. Ltd.', slug: 'karni' };
const USER = { name: 'Karni Test', email: 'test@karni.com', password: 'Test@1234' };

async function main() {
  const conn = await mysql.createConnection(DB);
  const one = async (sql, p = []) => (await conn.execute(sql, p))[0][0] ?? null;

  // 1. Company
  let company = await one('SELECT id FROM companies WHERE slug = ? AND deleted_at IS NULL', [COMPANY.slug]);
  if (!company) {
    const [r] = await conn.execute('INSERT INTO companies (name, slug) VALUES (?, ?)', [COMPANY.name, COMPANY.slug]);
    company = { id: r.insertId };
    console.log(`company    created  id=${company.id}`);
  } else console.log(`company    exists   id=${company.id}`);

  // 2. The app row. seed.sql keys every per-company default off this, so
  //    nothing else works until it exists.
  let app = await one('SELECT id FROM apps WHERE company_id = ? AND slug = ? AND deleted_at IS NULL', [company.id, 'cf_hrms']);
  if (!app) {
    const [r] = await conn.execute('INSERT INTO apps (company_id, name, slug) VALUES (?, ?, ?)', [company.id, 'CF HRMS', 'cf_hrms']);
    app = { id: r.insertId };
    console.log(`app        created  id=${app.id}`);
  } else console.log(`app        exists   id=${app.id}`);

  // 3. Role. seed.sql grants every cf_hrms capability to the role named 'admin'.
  let role = await one('SELECT id FROM roles WHERE company_id = ? AND LOWER(name) = ? AND deleted_at IS NULL', [company.id, 'admin']);
  if (!role) {
    const [r] = await conn.execute('INSERT INTO roles (name, company_id) VALUES (?, ?)', ['admin', company.id]);
    role = { id: r.insertId };
    console.log(`role       created  id=${role.id}`);
  } else console.log(`role       exists   id=${role.id}`);

  // 4. User
  const hash = await bcrypt.hash(USER.password, 10);
  let user = await one('SELECT id FROM users WHERE email = ?', [USER.email]);
  if (!user) {
    const [r] = await conn.execute(
      'INSERT INTO users (name, email, password, role_id, company_id) VALUES (?, ?, ?, ?, ?)',
      [USER.name, USER.email, hash, role.id, company.id]);
    user = { id: r.insertId };
    console.log(`user       created  id=${user.id}  ${USER.email}`);
  } else {
    await conn.execute('UPDATE users SET password = ?, role_id = ?, company_id = ?, deleted_at = NULL WHERE id = ?',
      [hash, role.id, company.id, user.id]);
    console.log(`user       updated  id=${user.id}  ${USER.email}`);
  }

  await conn.end();
  console.log('\nNow run models/seed.sql to grant the permissions, then import-org-chart.mjs.');
}

main().catch((e) => { console.error(e); process.exit(1); });
