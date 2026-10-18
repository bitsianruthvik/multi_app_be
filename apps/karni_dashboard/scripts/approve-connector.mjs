/**
 * Approve a pending karni_dashboard connector without the Connection screen
 * (e.g. when no admin can sign in). Lists the company's connectors; with
 * --apply it approves the one named by --id, recorded under --by (an admin's email).
 *
 *   node apps/karni_dashboard/scripts/approve-connector.mjs --target=prod
 *   node apps/karni_dashboard/scripts/approve-connector.mjs --target=prod --id=1 --by=mohit@karnipackaging.com --apply
 *   --company=<slug>  (default karni)
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from '../../cf_hrms/scripts/dbTarget.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d ?? ''}`).split('=')[1];
const APPLY = process.argv.includes('--apply');
const SLUG = arg('company', 'karni');
const ID = Number(arg('id', '0'));
const BY = arg('by', '');

const target = resolveTarget();
announce(target);
const conn = await mysql.createConnection(target.cfg);
const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [SLUG]);
if (!company) { console.error(`No company "${SLUG}".`); process.exit(1); }

const list = async () => console.table((await conn.query(
  'SELECT id, machine, win_user, status, approved_by, approved_at, last_seen_at FROM kd_connectors WHERE company_id = ?',
  [company.id]))[0]);
console.log(`company ${company.id} ${company.name}`);
await list();

if (!APPLY) {
  console.log('\nDry run. To approve: --id=<connector id> --by=<admin email> --apply');
} else {
  const [[admin]] = await conn.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.email = ? AND u.company_id = ? AND LOWER(r.name) = 'admin' AND u.deleted_at IS NULL`, [BY, company.id]);
  if (!admin) { console.error(`${BY || '(no --by)'} is not an admin of ${SLUG}.`); process.exit(1); }
  const [r] = await conn.query(
    "UPDATE kd_connectors SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ? AND company_id = ? AND status <> 'approved'",
    [admin.id, ID, company.id]);
  console.log(`\napproved: ${r.affectedRows} connector(s)`);
  await list();
}
await conn.end();
