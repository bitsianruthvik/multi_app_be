/**
 * grant-capability.mjs — give a role a capability, idempotently.
 *
 * Permissions resolve role_capability -> features_capability -> features, so a
 * grant is one row naming (company, app, role, capability). Written as a script
 * rather than typed as SQL because the join is easy to get subtly wrong — the
 * app_id in particular, which is per-company and not the slug.
 *
 * Re-running is a no-op: the row is only inserted if an identical live one does
 * not already exist.
 *
 *   node scripts/grant-capability.mjs <companyId> <roleName> <capabilityId>
 *   node scripts/grant-capability.mjs 30005 pm 10 --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const [companyArg, roleName, capArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
const COMPANY = Number(companyArg);
const CAP = Number(capArg);
if (!Number.isFinite(COMPANY) || !roleName || !Number.isFinite(CAP)) {
  console.error('usage: grant-capability.mjs <companyId> <roleName> <capabilityId> [--apply]');
  process.exit(1);
}

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});
const { pool } = await import('../db.js');

const [[role]] = await pool.query(
  'SELECT id, name FROM roles WHERE company_id = ? AND name = ? AND deleted_at IS NULL',
  [COMPANY, roleName]);
if (!role) { console.error(`no role "${roleName}" in company ${COMPANY}`); process.exit(1); }

const [[app]] = await pool.query(
  "SELECT id, slug FROM apps WHERE company_id = ? AND slug = 'fab_erp' AND deleted_at IS NULL", [COMPANY]);
if (!app) { console.error('no fab_erp app for that company'); process.exit(1); }

const [[cap]] = await pool.query(
  'SELECT capability_id, name, features_json FROM features_capability WHERE capability_id = ? AND deleted_at IS NULL',
  [CAP]);
if (!cap) { console.error(`no capability #${CAP}`); process.exit(1); }

const ids = typeof cap.features_json === 'string' ? JSON.parse(cap.features_json) : cap.features_json;
const [feats] = await pool.query('SELECT feature_tag FROM features WHERE id IN (?) AND deleted_at IS NULL', [ids]);

console.log(`grant  role "${role.name}" (#${role.id})  <-  capability #${cap.capability_id} "${cap.name}"`);
console.log(`       company ${COMPANY}, app ${app.slug} (#${app.id})`);
console.log(`       tags: ${feats.map((f) => f.feature_tag).join(', ')}`);

const [[existing]] = await pool.query(
  `SELECT id FROM role_capability
    WHERE company_id = ? AND role_id = ? AND app_id = ? AND capability_id = ? AND deleted_at IS NULL`,
  [COMPANY, role.id, app.id, CAP]);
if (existing) { console.log(`\nalready granted (role_capability #${existing.id}) — nothing to do.`); await pool.end(); process.exit(0); }

if (!APPLY) { console.log('\nDRY RUN — pass --apply to grant.'); await pool.end(); process.exit(0); }

const [r] = await pool.query(
  'INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id) VALUES (?, NULL, ?, ?, ?)',
  [role.id, COMPANY, app.id, CAP]);
console.log(`\ngranted — role_capability #${r.insertId}`);
console.log('Users must sign in again: uiPermissions are baked into the JWT at login.');
await pool.end();
