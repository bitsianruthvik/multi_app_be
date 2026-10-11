/**
 * Create the four hiring tables on a target, straight from models/init.sql.
 *
 *   node apply-hiring-tables.mjs                    DRY RUN on local
 *   node apply-hiring-tables.mjs --apply
 *   node apply-hiring-tables.mjs --apply --target=prod
 *
 * Only `CREATE TABLE IF NOT EXISTS` for hrms_hirings, hrms_hiring_letters,
 * hrms_letter_templates and hrms_hiring_settings is run — never the whole file,
 * so nothing else in the schema is touched. Safe to run twice.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

// hrms_employee_exits (leaving, spec §4) was added on 2026-10-11; it references only hrms_employees.
const TABLES = ['hrms_hirings', 'hrms_hiring_letters', 'hrms_letter_templates', 'hrms_hiring_settings', 'hrms_employee_exits'];
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
