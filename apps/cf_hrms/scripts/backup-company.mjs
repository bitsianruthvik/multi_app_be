/**
 * Snapshot one company's HR data to a JSON file, before something replaces it.
 *
 *   node backup-company.mjs --company=karni                 (local)
 *   node backup-company.mjs --company=karni --target=prod   (read-only against TiDB)
 *   node backup-company.mjs --company=karni --out=C:/path/file.json
 *
 * READ-ONLY. It issues SELECTs and nothing else, so it is safe to point at
 * production — which is the only time it really earns its keep.
 *
 * Why this exists: re-importing an org chart replaces rows that were authored
 * in the app and exist nowhere else. Karni's chart currently carries 96 open
 * points attached to specific positions that the newer source does not have.
 * A re-import deletes them. This file is the only way back.
 *
 * It takes every `hrms_*` table that has a `company_id`, plus the platform rows
 * that make the tenant work (its users, roles, teams, grants and app access),
 * because a restore that brings back the HR data but not the logins is not a
 * restore.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const TM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const arg = (n) => {
  const hit = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  return hit ? (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '') : null;
};

/** Platform tables worth keeping, and the column that ties each to a tenant. */
const PLATFORM = [
  ['companies', 'id'],
  ['users', 'company_id'],
  ['roles', 'company_id'],
  ['teams', 'company_id'],
  ['role_capability', 'company_id'],
  ['app_user_access', 'company_id'],
];

const main = async () => {
  const slug = arg('company');
  if (!slug) throw new Error('--company=<slug> is required');

  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  const q = async (sql, p = []) => (await conn.execute(sql, p))[0];

  try {
    const [company] = await q('SELECT id, slug, name FROM companies WHERE slug = ?', [slug]);
    if (!company) throw new Error(`no company with slug "${slug}" on ${target.name}`);
    console.log(`  company: ${company.name} (id ${company.id})\n`);

    // Plain, uncorrelated information_schema read. (A CORRELATED subquery against
    // information_schema returns at most one row on TiDB, nondeterministically —
    // hence listing tables first and asking about each one separately.)
    const tables = (await q(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'hrms\_%' ORDER BY TABLE_NAME`,
      [target.cfg.database],
    )).map((r) => r.t);

    const data = {};
    const counts = {};
    let total = 0;
    const skipped = [];

    for (const t of tables) {
      const cols = (await q(
        `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [target.cfg.database, t],
      )).map((r) => r.c);
      if (!cols.includes('company_id')) { skipped.push(t); continue; }
      // Blobs are excluded: a photo would balloon the file and is not what a
      // re-import touches. Named here so the gap is visible in the manifest.
      const blobs = cols.filter((c) => /_content$/.test(c));
      const select = blobs.length ? cols.filter((c) => !blobs.includes(c)).map((c) => `\`${c}\``).join(', ') : '*';
      const rows = await q(`SELECT ${select} FROM \`${t}\` WHERE company_id = ?`, [company.id]);
      data[t] = { rows, excludedColumns: blobs };
      counts[t] = rows.length;
      total += rows.length;
    }

    for (const [t, col] of PLATFORM) {
      try {
        const rows = await q(`SELECT * FROM \`${t}\` WHERE \`${col}\` = ?`, [company.id]);
        data[t] = { rows, excludedColumns: [] };
        counts[t] = rows.length;
        total += rows.length;
      } catch (e) {
        skipped.push(`${t} (${e.code || e.message})`);
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = arg('out') || path.join(TM_ROOT, `backup_${slug}_${target.isProd ? 'prod' : 'local'}_${stamp}.json`);
    fs.writeFileSync(out, JSON.stringify({
      takenAt: new Date().toISOString(),
      target: target.name,
      isProd: target.isProd,
      company,
      schema: target.cfg.database,
      counts,
      skippedTables: skipped,
      data,
    }, null, 1));

    const wide = Math.max(...Object.keys(counts).map((k) => k.length));
    for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      if (n) console.log(`  ${t.padEnd(wide)}  ${String(n).padStart(6)}`);
    }
    const empty = Object.entries(counts).filter(([, n]) => !n).map(([t]) => t);
    console.log(`\n  ${Object.keys(counts).length} tables, ${total} rows  (${empty.length} empty)`);
    if (skipped.length) console.log(`  no company_id, not backed up: ${skipped.join(', ')}`);
    console.log(`\n  written: ${out}`);
    console.log(`  size:    ${(fs.statSync(out).size / 1048576).toFixed(2)} MB\n`);
  } finally {
    await conn.end();
  }
};

main().catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
