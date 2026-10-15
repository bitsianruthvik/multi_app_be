#!/usr/bin/env node
/**
 * Sets up cf_crm and the Northeast customer. Safe to run again: everything is
 * found by slug / email first and only made when missing; branding is set
 * only on a new customer unless --brand is given.
 *
 *   cd multi_app_be
 *   node apps/cf_crm/scripts/seed_northeast.mjs --password '<admin password>' \
 *     [--chit-email <email>|none] [--re-email <email>|none] [--brand] [--schema-only]
 *
 * What it makes:
 *   - the cf_crm schema (models/init.sql)
 *   - customer `northeast`, with NorthEast Network's colours and logo
 *   - two companies on it, sharing one network:
 *       NorthEast Chit Fund    slug northeast-chit        business `chit`
 *       NorthEast Real Estate  slug northeast-realestate  business `re`
 *   - the app row `cf_crm` ("NorthEast Network") for each
 *   - an `admin` role per company and, where an email is given, an admin login
 *     with access to the app and the Owner role inside it. Defaults (for local
 *     use): admin@northeast-chit.test, admin@northeast-realestate.test. An email
 *     belongs to one company only; `none` makes no login for that company (its
 *     staff are added later in Setup → Owners & team).
 *   - the network's starting setup: the two businesses and their lead stages
 *     come from the app's defaults
 * Uses the DB_* settings of multi_app_be/.env (or the environment).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import bcrypt from 'bcryptjs';
import { pool } from '../../../db.js';
import { NORTHEAST_BRAND } from '../lib/brand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(name);

const CUSTOMER = { slug: 'northeast', name: 'NorthEast' };
const COMPANIES = [
  { slug: 'northeast-chit', name: 'NorthEast Chit Fund', business: 'chit', admin: { name: arg('--chit-name') || 'NorthEast Chit Fund Admin', email: arg('--chit-email') || 'admin@northeast-chit.test' } },
  { slug: 'northeast-realestate', name: 'NorthEast Real Estate', business: 're', admin: { name: arg('--re-name') || 'NorthEast Real Estate Admin', email: arg('--re-email') || 'admin@northeast-realestate.test' } },
];
const APP_NAME = 'NorthEast Network';

export async function applySchema(conn) {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'models', 'init.sql'), 'utf8');
  const body = raw.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n');
  const stmts = body.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
  let result = '';
  for (const s of stmts) {
    const [rows] = await conn.query(s);
    if (Array.isArray(rows) && rows[0] && rows[0].result) result = rows[0].result;
  }
  return result;
}

async function one(conn, sql, params) { const [rows] = await conn.query(sql, params); return rows[0]; }

async function main() {
  const conn = await pool.getConnection();
  try {
    const schema = await applySchema(conn);
    console.log('schema:', schema);
    if (schema !== 'SCHEMA-OK') throw new Error('The cf_crm schema did not apply.');
    if (flag('--schema-only')) return;

    const password = arg('--password') || process.env.CF_CRM_SEED_PASSWORD;
    if (!password || password.length < 8) throw new Error('Give the admin logins a password: --password <at least 8 characters> (or CF_CRM_SEED_PASSWORD).');

    await conn.beginTransaction();
    let customer = await one(conn, 'SELECT id FROM cf_crm_customers WHERE slug = ?', [CUSTOMER.slug]);
    if (!customer) {
      const [ins] = await conn.query('INSERT INTO cf_crm_customers (slug, name, brand) VALUES (?,?,?)', [CUSTOMER.slug, CUSTOMER.name, JSON.stringify(NORTHEAST_BRAND)]);
      customer = { id: ins.insertId };
      console.log('customer made:', CUSTOMER.slug, customer.id);
    } else if (flag('--brand')) {
      await conn.query('UPDATE cf_crm_customers SET brand = ? WHERE id = ?', [JSON.stringify(NORTHEAST_BRAND), customer.id]);
      console.log('customer branding reset:', CUSTOMER.slug);
    }

    const hash = await bcrypt.hash(password, 10);
    for (const co of COMPANIES) {
      let company = await one(conn, 'SELECT id, deleted_at FROM companies WHERE slug = ?', [co.slug]);
      if (!company) {
        const [ins] = await conn.query('INSERT INTO companies (name, slug) VALUES (?,?)', [co.name, co.slug]);
        company = { id: ins.insertId };
        console.log('company made:', co.slug, company.id);
      } else if (company.deleted_at) {
        throw new Error(`Company ${co.slug} exists but is deleted; restore or rename it first.`);
      }
      let app = await one(conn, "SELECT id FROM apps WHERE company_id = ? AND slug = 'cf_crm'", [company.id]);
      if (!app) {
        const [ins] = await conn.query("INSERT INTO apps (company_id, name, slug, is_public) VALUES (?, ?, 'cf_crm', 1)", [company.id, APP_NAME]);
        app = { id: ins.insertId };
      } else {
        await conn.query('UPDATE apps SET deleted_at = NULL WHERE id = ?', [app.id]);
      }
      let role = await one(conn, "SELECT id FROM roles WHERE company_id = ? AND name = 'admin' AND deleted_at IS NULL", [company.id]);
      if (!role) {
        const [ins] = await conn.query("INSERT INTO roles (name, company_id) VALUES ('admin', ?)", [company.id]);
        role = { id: ins.insertId };
      }
      await conn.query(
        `INSERT INTO cf_crm_customer_companies (company_id, customer_id, business_id) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE customer_id = VALUES(customer_id), business_id = VALUES(business_id)`, [company.id, customer.id, co.business]);
      if (String(co.admin.email).toLowerCase() === 'none') { console.log('no admin login for', co.slug); continue; }
      co.admin.email = String(co.admin.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(co.admin.email)) throw new Error('Not an email address: ' + co.admin.email);
      let user = await one(conn, 'SELECT id, company_id FROM users WHERE email = ?', [co.admin.email]);
      if (!user) {
        const [ins] = await conn.query('INSERT INTO users (name, email, password, role_id, company_id) VALUES (?,?,?,?,?)', [co.admin.name, co.admin.email, hash, role.id, company.id]);
        user = { id: ins.insertId, company_id: company.id };
        console.log('admin login made:', co.admin.email);
      } else if (Number(user.company_id) !== Number(company.id)) {
        throw new Error(`${co.admin.email} belongs to another company.`);
      }
      await conn.query(
        `INSERT INTO app_user_access (user_id, app_id, role_id, company_id) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE deleted_at = NULL`, [user.id, app.id, role.id, company.id]);
      await conn.query(
        `INSERT INTO cf_crm_members (customer_id, user_id, role, owner, businesses, perms, active)
         VALUES (?, ?, 'admin', '', '[]', '{}', 1) ON DUPLICATE KEY UPDATE role = 'admin', active = 1`, [customer.id, user.id]);
    }

    const cfg = await one(conn, "SELECT 1 AS x FROM cf_crm_settings WHERE customer_id = ? AND k = 'config'", [customer.id]);
    if (!cfg) {
      await conn.query("INSERT INTO cf_crm_settings (customer_id, k, value) VALUES (?, 'config', ?)", [customer.id, JSON.stringify({
        businesses: COMPANIES.map((c) => ({ id: c.business, name: c.name })),
        // the original app's own defaults, which were NorthEast's
        senders: { whatsapp: ['NorthEast official (WhatsApp Business number)'], email: ['NorthEast <info@chitfundnortheastworld.com>'] },
      })]);
    }
    await conn.commit();
    console.log('done. Sign in at /northeast-chit/cf_crm/login or /northeast-realestate/cf_crm/login');
  } catch (err) {
    try { await conn.rollback(); } catch { /* nothing open */ }
    throw err;
  } finally {
    conn.release();
  }
}

// run only when called directly (api_test.mjs imports applySchema)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(() => pool.end()).catch(async (err) => { console.error(err.message || err); await pool.end(); process.exit(1); });
