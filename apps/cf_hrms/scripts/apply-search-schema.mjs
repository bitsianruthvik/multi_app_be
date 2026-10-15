/**
 * Search by meaning (org chart "Search job content"): the one table it needs,
 * on a database that already exists.
 *
 *   node apply-search-schema.mjs                    DRY RUN on local — says what it would do
 *   node apply-search-schema.mjs --apply
 *   node apply-search-schema.mjs --apply --target=prod
 *
 * Creates hrms_search_vectors if it is not there (and adds its deleted_at to a
 * copy built before that column existed). The CREATE TABLE is read out
 * of models/init.sql (section 16), never retyped here. Idempotent: a second run
 * finds the table and changes nothing. Filling it is build-search-index.mjs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');
const TABLE = 'hrms_search_vectors';
const sql = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/init.sql'), 'utf8');

function createOf(table) {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`init.sql has no CREATE TABLE for ${table}`);
  const end = sql.indexOf(';', sql.indexOf('\n)', start));
  return sql.slice(start, end);
}

const target = resolveTarget();
announce(target);
const conn = await mysql.createConnection(target.cfg);
try {
  const [[{ n }]] = await conn.query(
    'SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [TABLE],
  );
  if (Number(n)) {
    console.log(`  ${TABLE.padEnd(40)} already there`);
    // An early local build of the table had no deleted_at (2026-10-15); every hrms_ table has one.
    const [[{ c }]] = await conn.query(
      'SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [TABLE, 'deleted_at'],
    );
    if (Number(c)) console.log(`  ${`${TABLE}.deleted_at`.padEnd(40)} already there — nothing to do`);
    else if (!APPLY) console.log(`  ${`${TABLE}.deleted_at`.padEnd(40)} WOULD ADD (dry run; add --apply)`);
    else {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN deleted_at DATETIME DEFAULT NULL AFTER vector`);
      console.log(`  ${`${TABLE}.deleted_at`.padEnd(40)} added`);
    }
  } else if (!APPLY) {
    console.log(`  ${TABLE.padEnd(40)} WOULD CREATE (dry run; add --apply)`);
  } else {
    await conn.query(createOf(TABLE));
    console.log(`  ${TABLE.padEnd(40)} created`);
  }
} finally {
  await conn.end();
}
