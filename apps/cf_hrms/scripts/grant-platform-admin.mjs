/**
 * grant-platform-admin.mjs — make one login a PLATFORM ADMIN (the product team's compliance console,
 * /platform/compliance; spec §36.4), or take it away. The only way a row gets into platform_admins.
 *
 *   node grant-platform-admin.mjs --email=a@b.com                        DRY RUN on local — says what it would do
 *   node grant-platform-admin.mjs --email=a@b.com --apply
 *   node grant-platform-admin.mjs --email=a@b.com --revoke --apply       take it away (soft delete)
 *   node grant-platform-admin.mjs --list                                 who has it
 *   node grant-platform-admin.mjs --email=a@b.com --apply --target=prod  production, named out loud
 *   options: --company=<slug> when the same email is a login in more than one company; --note="…"
 *
 * The row keeps the user id AND the email it had now: if the login's email changes later, or the id
 * is somebody else's, the right is gone (services/compliance/platformAdmin.js checks both on every
 * request). Being a company's Owner gives nothing here.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').slice(k.length + 3) || null;
const APPLY = process.argv.includes('--apply');
const REVOKE = process.argv.includes('--revoke');
const LIST = process.argv.includes('--list');
const email = arg('email');
const companySlug = arg('company');
const note = arg('note');

const target = resolveTarget();
announce(target);
const conn = await mysql.createConnection(target.cfg);
try {
  const [[t]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_admins'");
  if (!t.n) throw new Error('platform_admins is not there — run apply-compliance-schema.mjs --apply first.');
  if (LIST || !email) {
    const [rows] = await conn.query(
      `SELECT p.user_id, p.email, p.note, p.created_at, u.name, u.email AS now_email, u.deleted_at, c.slug
         FROM platform_admins p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN companies c ON c.id = u.company_id WHERE p.deleted_at IS NULL ORDER BY p.id`);
    console.log(rows.length ? '  platform admins:' : '  nobody is a platform admin.');
    for (const r of rows) {
      const ok = r.now_email && !r.deleted_at && r.now_email.trim().toLowerCase() === r.email.trim().toLowerCase();
      console.log(`    ${r.email}  (user ${r.user_id}, ${r.name ?? '?'}, ${r.slug ?? '?'})${ok ? '' : '  — NOT VALID: the login is gone or its email changed'}${r.note ? `  ${r.note}` : ''}`);
    }
    if (!email) { console.log('\n  Give --email=… to grant or revoke.\n'); process.exit(0); }
  }
  const [users] = await conn.query(
    `SELECT u.id, u.name, u.email, c.slug, c.name AS company FROM users u JOIN companies c ON c.id = u.company_id
      WHERE LOWER(TRIM(u.email)) = LOWER(TRIM(?)) AND u.deleted_at IS NULL ${companySlug ? 'AND c.slug = ?' : ''}`, companySlug ? [email, companySlug] : [email]);
  if (!users.length) throw new Error(`No live login with the email ${email}${companySlug ? ` in ${companySlug}` : ''}.`);
  if (users.length > 1) throw new Error(`${email} is a login in ${users.map((u) => u.slug).join(', ')}: say which with --company=<slug>.`);
  const u = users[0];
  const [[row]] = await conn.query('SELECT id FROM platform_admins WHERE user_id = ? AND deleted_at IS NULL', [u.id]);
  console.log(`\n  login      ${u.name} <${u.email}> — user ${u.id}, company ${u.company} (${u.slug})`);
  if (REVOKE) {
    if (!row) { console.log('  Not a platform admin. Nothing to do.\n'); process.exit(0); }
    if (!APPLY) { console.log('  DRY RUN: would take the platform admin right away. Add --apply.\n'); process.exit(0); }
    await conn.query('UPDATE platform_admins SET deleted_at = NOW() WHERE id = ?', [row.id]);
    console.log('  DONE: no longer a platform admin.\n');
  } else {
    if (row) { console.log('  Already a platform admin. Nothing to do.\n'); process.exit(0); }
    if (!APPLY) { console.log('  DRY RUN: would make this login a platform admin (the product team’s compliance console). Add --apply.\n'); process.exit(0); }
    await conn.query('INSERT INTO platform_admins (user_id, email, note) VALUES (?, ?, ?)', [u.id, u.email.trim(), note ? note.slice(0, 300) : null]);
    console.log('  DONE: a platform admin. They open /platform/compliance after signing in with this login.\n');
  }
} catch (e) {
  console.error(`\n  FAILED: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await conn.end();
}
