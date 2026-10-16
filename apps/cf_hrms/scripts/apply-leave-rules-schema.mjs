/**
 * apply-leave-rules-schema.mjs — the leave rule additions of Karni's executive policy
 * (TM/CF_HRMS_HIRING_SPEC.md §23.1; models/init.sql §24).
 *
 *   node apply-leave-rules-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-leave-rules-schema.mjs --apply
 *   node apply-leave-rules-schema.mjs --apply --target=prod
 *
 *   1. hrms_leave_policies: effective_from (nothing is earned before it);
 *   2. hrms_leave_policy_rules: joining_cutoff_day, credit_in_arrears, notice_tiers_json,
 *      not_with_json.
 *
 * Every new column is NULL or defaults to "off", so an old policy reads and behaves exactly
 * as before. One change per statement (TiDB). DDL commits by itself: every step is guarded,
 * and a second run finds nothing to do. No data is written. The old backend never reads
 * the new columns, so run this BEFORE deploying the backend that does.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));

/** The columns, in the order they are added: [table, column, definition, after]. The same as init.sql §24. */
export const COLUMNS = [
  ['hrms_leave_policies', 'effective_from', 'DATE NULL', 'year_starts_month'],
  ['hrms_leave_policy_rules', 'joining_cutoff_day', 'TINYINT NULL', 'prorate_on_joining'],
  ['hrms_leave_policy_rules', 'credit_in_arrears', 'TINYINT(1) NOT NULL DEFAULT 0', 'joining_cutoff_day'],
  ['hrms_leave_policy_rules', 'notice_tiers_json', 'JSON NULL', 'min_notice_days'],
  ['hrms_leave_policy_rules', 'not_with_json', 'JSON NULL', 'notice_tiers_json'],
];

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_leave_policies', 'hrms_leave_policy_rules']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run models/init.sql (and apply-leave-policy-schema.mjs) first.`);
  }
  const steps = [];
  for (const [t, c, def, after] of COLUMNS) {
    if (!await column(conn, t, c)) steps.push({ what: `add ${t}.${c}`, sql: `ALTER TABLE ${t} ADD COLUMN ${c} ${def} AFTER ${after}` });
  }
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
    console.log(APPLY ? '\n  done. No policies or rules are written by this script.\n' : `\n  nothing written — ${steps.length} schema step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; a test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
