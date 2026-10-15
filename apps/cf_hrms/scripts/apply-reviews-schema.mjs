/**
 * apply-reviews-schema.mjs — check-ins, reviews and action items
 * (TM/CF_HRMS_HIRING_SPEC.md §20; models/init.sql §22).
 *
 *   node apply-reviews-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-reviews-schema.mjs --apply
 *   node apply-reviews-schema.mjs --apply --target=prod
 *
 *   1. hrms_performance_settings.review_grace_days (7) — days after a period's end
 *      its FINAL reviews are due;
 *   2. the table hrms_performance_reviews;
 *   3. the table hrms_performance_actions.
 *   Both CREATE TABLEs are read from models/init.sql §22, so the two cannot differ.
 *
 * Needs apply-performance-schema.mjs and apply-actuals-schema.mjs first. One
 * change per statement (TiDB). DDL commits by itself: every step is guarded, and
 * a second run finds nothing to do. No data is written: FINAL reviews are made by
 * the app itself, lazily, when a period's last slot opens. The old backend never
 * reads any of it, so run this BEFORE deploying the backend that does.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');
const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/init.sql');

export const REVIEWS_TABLE = 'hrms_performance_reviews';
export const ACTIONS_TABLE = 'hrms_performance_actions';

/** The CREATE TABLE of one §22 table, comments removed. */
export function createStatement(table) {
  const text = fs.readFileSync(INIT, 'utf8');
  const at = text.indexOf('## 22. CHECK-INS, REVIEWS AND ACTION ITEMS');
  if (at < 0) throw new Error('models/init.sql has no section 22 (reviews).');
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`).exec(text.slice(at));
  if (!m) throw new Error(`models/init.sql §22 has no CREATE TABLE for ${table}.`);
  return m[0].replace(/\s+--[^\r\n]*/g, '');
}

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_performance_settings', 'hrms_performance_plans', 'hrms_performance_actuals']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run apply-performance-schema.mjs and apply-actuals-schema.mjs first.`);
  }
  const steps = [];
  if (!await column(conn, 'hrms_performance_settings', 'review_grace_days')) {
    steps.push({ what: 'add hrms_performance_settings.review_grace_days (7)', sql: 'ALTER TABLE hrms_performance_settings ADD COLUMN review_grace_days SMALLINT NOT NULL DEFAULT 7' });
  }
  if (!await table(conn, REVIEWS_TABLE)) steps.push({ what: `create ${REVIEWS_TABLE}`, sql: createStatement(REVIEWS_TABLE) });
  if (!await table(conn, ACTIONS_TABLE)) steps.push({ what: `create ${ACTIONS_TABLE}`, sql: createStatement(ACTIONS_TABLE) });
  return steps;
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const steps = await schemaSteps(conn);
    if (!steps.length) console.log('  schema: already there — nothing to do');
    for (const s of steps) {
      if (APPLY) { await conn.query(s.sql); console.log(`  schema: ${s.what} — done`); } else console.log(`  schema: would ${s.what}`);
    }
    if (APPLY) {
      const again = await schemaSteps(conn);
      if (again.length) throw new Error(`after applying, still to do: ${again.map((s) => s.what).join('; ')}`);
      console.log('  checked: a second run plans nothing');
    }
    console.log(APPLY ? '\n  done. No reviews or actions are written by this script.\n' : `\n  nothing written — ${steps.length} schema step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; a test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
