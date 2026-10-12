/**
 * Give one existing Karni login full (admin) access and a new sign-in email.
 *
 *   node make-owner-admin.mjs --target=prod            DRY RUN — shows what would change
 *   node make-owner-admin.mjs --target=prod --apply
 *
 * It changes exactly two rows, both belonging to ONE user: the user's email and
 * role, and the role on that user's app access row. The password is not touched,
 * and the user stays linked to their employee record. Refuses if anything is not
 * exactly as expected.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const COMPANY_SLUG = 'karni';
const FROM_EMAIL = 'mohit.kakani@karni.com';
const TO_EMAIL = 'mohit@karnipackaging.com';
const LIKE_EMAIL = 'test@karni.com';        // copy this login's role
const APPLY = process.argv.includes('--apply');

const target = resolveTarget();
announce(target);
const conn = await mysql.createConnection(target.cfg);
try {
  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [COMPANY_SLUG]);
  if (!company) throw new Error(`No company '${COMPANY_SLUG}'.`);
  const [[model]] = await conn.query(
    'SELECT u.id, u.role_id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.email = ? AND u.deleted_at IS NULL',
    [company.id, LIKE_EMAIL]);
  if (!model) throw new Error(`${LIKE_EMAIL} was not found, so there is no role to copy.`);
  const [[user]] = await conn.query(
    `SELECT u.id, u.name, u.email, u.role_id, r.name AS role, e.employee_code
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN hrms_employees e ON e.user_id = u.id
      WHERE u.company_id = ? AND u.email IN (?, ?) AND u.deleted_at IS NULL`, [company.id, FROM_EMAIL, TO_EMAIL]);
  if (!user) throw new Error(`No login ${FROM_EMAIL} in ${company.name}.`);
  const [clash] = await conn.query('SELECT id FROM users WHERE email = ? AND id <> ?', [TO_EMAIL, user.id]);
  if (clash.length) throw new Error(`${TO_EMAIL} already belongs to another login.`);
  const [access] = await conn.query('SELECT id, role_id FROM app_user_access WHERE user_id = ? AND company_id = ? AND deleted_at IS NULL', [user.id, company.id]);

  console.log(`\n  ${company.name}`);
  console.log(`  login      ${user.name} (${user.employee_code ?? 'no employee record'})`);
  console.log(`  email      ${user.email}  ->  ${TO_EMAIL}`);
  console.log(`  role       ${user.role}  ->  ${model.role}  (the role ${LIKE_EMAIL} holds)`);
  console.log(`  app access ${access.length} row(s) move to the same role`);
  console.log('  password   unchanged');

  if (user.email === TO_EMAIL && user.role_id === model.role_id && access.every((a) => a.role_id === model.role_id)) {
    console.log('\n  Already done. Nothing to change.\n');
  } else if (!APPLY) {
    console.log('\n  DRY RUN. Nothing written. Add --apply to write.\n');
  } else {
    await conn.beginTransaction();
    try {
      const [u] = await conn.query('UPDATE users SET email = ?, role_id = ? WHERE id = ? AND company_id = ?', [TO_EMAIL, model.role_id, user.id, company.id]);
      const [a] = await conn.query('UPDATE app_user_access SET role_id = ? WHERE user_id = ? AND company_id = ? AND deleted_at IS NULL', [model.role_id, user.id, company.id]);
      if (u.affectedRows > 1 || a.affectedRows > access.length) throw new Error('More rows than expected would change. Rolled back.');
      await conn.commit();
      console.log(`\n  WRITTEN. ${TO_EMAIL} now has the ${model.role} role. They sign in with the new email and their existing password.\n`);
    } catch (e) { await conn.rollback(); throw e; }
  }
} catch (e) {
  console.error(`\n  STOPPED: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await conn.end();
}
