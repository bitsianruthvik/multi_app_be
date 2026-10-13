/**
 * Create hrms_access_roles on a target, straight from models/init.sql
 * (CF_HRMS_HIRING_SPEC.md §12.2).
 *
 *   node apply-access-schema.mjs                    DRY RUN on local
 *   node apply-access-schema.mjs --apply
 *   node apply-access-schema.mjs --apply --target=prod
 *
 * Only `CREATE TABLE IF NOT EXISTS hrms_access_roles` is run — never the whole
 * file, so nothing else in the schema is touched. No existing table is altered
 * and NO ROWS are written: the rows are setup-access.mjs's job. Safe to run
 * twice.
 *
 * ORDER: this, then setup-access.mjs for each company, then the backend deploy.
 * The new backend reads this table on every request.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const TABLES = ['hrms_access_roles'];
const APPLY = process.argv.includes('--apply');
const sqlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/init.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

const statements = TABLES.map((t) => {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
  if (start < 0) throw new Error(`init.sql has no CREATE TABLE for ${t}`);
  const end = sql.indexOf(';', sql.indexOf('\n)', start));
  if (end < 0) throw new Error(`Could not find the end of ${t}`);
  return { table: t, text: sql.slice(start, end) };
});

const target = resolveTarget();
announce(target);
const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
try {
  for (const s of statements) {
    const [[there]] = await conn.query(
      'SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [s.table]);
    const exists = Number(there.n) > 0;
    if (!APPLY) { console.log(`  ${s.table}: ${exists ? 'already there' : 'would be created'} (${s.text.split('\n').length} lines)`); continue; }
    await conn.query(s.text);
    const [cols] = await conn.query(`SHOW COLUMNS FROM ${s.table}`);
    console.log(`  ${s.table}: ${exists ? 'already there' : 'created'}, ${cols.length} columns`);
  }
  if (!APPLY) console.log('\n  DRY RUN. Nothing written. Add --apply to write.\n');
} finally {
  await conn.end();
}
