/**
 * Delete one company's HR data so a fresh import can be run into an empty tenant.
 *
 *   node clear-company-hrms.mjs --company=karni --backup=<file.json>                   DRY RUN
 *   node clear-company-hrms.mjs --company=karni --backup=<file.json> --apply
 *   node clear-company-hrms.mjs --company=karni --backup=<file.json> --apply --target=prod
 *
 * This exists for one job: the org-chart importer deliberately refuses to touch
 * a tenant that already holds data, and refuses `--wipe` against production
 * outright. Those guards are right and are not being weakened. Instead the
 * tenant is emptied here, deliberately and separately, after which the importer
 * runs its ordinary path with nothing overridden.
 *
 * --backup IS REQUIRED and is verified, not taken on trust. The script reads the
 * file, checks it is a snapshot of THIS company from the SAME target, checks it
 * actually contains the rows about to be deleted, and refuses if the database
 * holds rows the snapshot does not. "I took a backup" is the sentence people say
 * before discovering the backup was of something else.
 *
 * Only `hrms_*` tables are touched. The tenant's company, users, roles, teams
 * and app access are left alone — clearing the HR data must not lock anyone out.
 */
import fs from 'fs';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const args = process.argv.slice(2);
const arg = (n) => {
  const hit = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  return hit ? (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '') : null;
};
const has = (n) => args.includes(`--${n}`);

/** How fresh a backup has to be. A week-old snapshot is not a backup of today. */
const MAX_BACKUP_AGE_MIN = 120;

/**
 * Per-company CONFIGURATION, owned by `models/seed.sql` — not chart data, and
 * never cleared.
 *
 * The org-chart importer reads both and refuses to run without them ("No shifts
 * for this company — run models/seed.sql first"). Clearing them therefore breaks
 * the very import this script exists to make way for, and the obvious fix is the
 * wrong one: `seed.sql` is deliberately NOT tenant-scoped — it joins `apps` on
 * slug across *every* company and grants the app's tags to every admin role it
 * finds — so it must never be re-run against production to repair one tenant.
 *
 * Found the hard way, mid-operation, after clearing Karni's production: 3 shifts
 * and 6 relationship types went with the chart data and had to be put back from
 * the backup.
 */
const KEEP = new Set(['hrms_shifts', 'hrms_reporting_relationship_types']);

const main = async () => {
  const slug = arg('company');
  const backupPath = arg('backup');
  const apply = has('apply');
  if (!slug) throw new Error('--company=<slug> is required');
  if (!backupPath) {
    throw new Error('--backup=<file.json> is required — run backup-company.mjs first, then pass its file here');
  }
  if (!fs.existsSync(backupPath)) throw new Error(`no such backup file: ${backupPath}`);

  const snap = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const target = resolveTarget();

  console.log(`\n  company: ${slug}`);
  console.log(`  backup:  ${backupPath}`);
  console.log(`  taken:   ${snap.takenAt}  from ${snap.target}`);
  announce(target);
  console.log(`  mode:    ${apply ? 'APPLY - rows will be deleted' : 'DRY RUN - nothing will be deleted'}\n`);

  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  const q = async (sql, p = []) => (await conn.execute(sql, p))[0];

  try {
    const [company] = await q('SELECT id, slug, name FROM companies WHERE slug = ?', [slug]);
    if (!company) throw new Error(`no company with slug "${slug}" on ${target.name}`);

    // ---- the backup has to be a backup OF THIS, not merely a file ----
    if (snap.company?.slug !== slug) {
      throw new Error(`the backup is of "${snap.company?.slug}", not "${slug}"`);
    }
    if (snap.company?.id !== company.id) {
      throw new Error(`the backup is of company id ${snap.company?.id}, this target's "${slug}" is id ${company.id}`);
    }
    if (Boolean(snap.isProd) !== Boolean(target.isProd)) {
      throw new Error(
        `the backup came from ${snap.isProd ? 'PRODUCTION' : 'local'} and you are pointing at ` +
        `${target.isProd ? 'PRODUCTION' : 'local'} — those are different databases with different rows`,
      );
    }
    const ageMin = (Date.now() - Date.parse(snap.takenAt)) / 60000;
    if (!(ageMin >= 0) || ageMin > MAX_BACKUP_AGE_MIN) {
      throw new Error(
        `the backup is ${Math.round(ageMin)} minutes old (limit ${MAX_BACKUP_AGE_MIN}) — take a fresh one, ` +
        'because anything written since is not in it',
      );
    }

    const tables = (await q(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'hrms\\_%' ORDER BY TABLE_NAME`,
      [target.cfg.database],
    )).map((r) => r.t);

    const live = {};
    const notInBackup = [];
    let total = 0;
    for (const t of tables) {
      const cols = (await q(
        'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [target.cfg.database, t],
      )).map((r) => r.c);
      if (!cols.includes('company_id') || KEEP.has(t)) continue;
      const [{ n }] = await q(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE company_id = ?`, [company.id]);
      live[t] = n;
      total += n;
      // The real risk is not a missing backup but a STALE one: rows written
      // after the snapshot are invisible to it and gone forever here.
      const held = snap.data?.[t]?.rows?.length ?? 0;
      if (n > held) notInBackup.push(`${t}: ${n} rows here, only ${held} in the backup`);
    }

    const wide = Math.max(...Object.keys(live).map((k) => k.length), 5);
    for (const [t, n] of Object.entries(live).sort((a, b) => b[1] - a[1])) {
      if (n) console.log(`  ${t.padEnd(wide)} ${String(n).padStart(6)}`);
    }
    console.log(`\n  ${total} rows would be deleted from ${Object.values(live).filter(Boolean).length} tables`);
    console.log(`  backup is ${Math.round(ageMin)} minute(s) old and holds this company's rows`);
    console.log('  NOT touched: companies, users, roles, teams, role_capability, app_user_access');
    console.log(`  NOT touched (seed.sql owns these, and the importer needs them): ${[...KEEP].join(', ')}`);

    if (notInBackup.length) {
      console.log('\n  THE BACKUP IS BEHIND THE DATABASE:');
      for (const line of notInBackup) console.log(`    ${line}`);
      throw new Error('rows exist here that the backup does not hold — take a fresh backup and run again');
    }

    if (!apply) {
      console.log('\n  dry run - pass --apply to delete\n');
      return;
    }

    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    await conn.beginTransaction();
    try {
      // Order does not matter with the checks off, but reverse-alphabetical at
      // least makes two runs comparable.
      for (const t of Object.keys(live).sort().reverse()) {
        await conn.execute(`DELETE FROM \`${t}\` WHERE company_id = ?`, [company.id]);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    }

    let left = 0;
    for (const t of Object.keys(live)) {
      const [{ n }] = await q(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE company_id = ?`, [company.id]);
      if (n) { console.log(`  STILL THERE ${t}: ${n}`); left += n; }
    }
    console.log(left ? `\n  ${left} rows remain — look at the above\n` : `\n  cleared. ${total} rows deleted, tenant is empty of HR data\n`);
    console.log(`  to undo: node restore-company.mjs --file=${backupPath} --apply${target.isProd ? ' --target=prod' : ''} --repair-enums\n`);
    if (left) process.exitCode = 1;
  } finally {
    await conn.end();
  }
};

main().catch((e) => { console.error(`\n  REFUSED: ${e.message}\n`); process.exit(1); });
