/**
 * apply-leave-requests-schema.mjs — leave requests and approvals
 * (TM/CF_HRMS_HIRING_SPEC.md §22; models/init.sql §23).
 *
 *   node apply-leave-requests-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-leave-requests-schema.mjs --apply
 *   node apply-leave-requests-schema.mjs --apply --target=prod
 *
 *   1. hrms_leave_requests: half_day, days_json, decision_note, decided_by (+ its key to users),
 *      decided_at, cancel_note, raised_by_hr;
 *   2. hrms_leave_balances: note.
 *
 * Both tables exist already (init.sql §8b/§8c) and have no rows anywhere. One change per
 * statement (TiDB). DDL commits by itself: every step is guarded, and a second run finds
 * nothing to do. No data is written. The old backend never reads the new columns, so run
 * this BEFORE deploying the backend that does.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));
const constraint = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?', [t, c]));

/** The columns, in the order they are added: [table, column, definition, after]. The same as init.sql §23. */
export const COLUMNS = [
  ['hrms_leave_requests', 'half_day', "ENUM('FIRST','SECOND') NULL", 'approved_at'],
  ['hrms_leave_requests', 'days_json', 'JSON NULL', 'half_day'],
  ['hrms_leave_requests', 'decision_note', 'TEXT NULL', 'days_json'],
  ['hrms_leave_requests', 'decided_by', 'INT NULL', 'decision_note'],
  ['hrms_leave_requests', 'decided_at', 'DATETIME NULL', 'decided_by'],
  ['hrms_leave_requests', 'cancel_note', 'TEXT NULL', 'decided_at'],
  ['hrms_leave_requests', 'raised_by_hr', 'TINYINT(1) NOT NULL DEFAULT 0', 'cancel_note'],
  ['hrms_leave_balances', 'note', 'VARCHAR(500) NULL', 'closing_balance'],
];

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_leave_requests', 'hrms_leave_balances', 'hrms_leave_policies']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run models/init.sql (and apply-leave-policy-schema.mjs) first.`);
  }
  const steps = [];
  for (const [t, c, def, after] of COLUMNS) {
    if (!await column(conn, t, c)) steps.push({ what: `add ${t}.${c}`, sql: `ALTER TABLE ${t} ADD COLUMN ${c} ${def} AFTER ${after}` });
  }
  if (!await constraint(conn, 'hrms_leave_requests', 'fk_hlvr_decider')) {
    steps.push({ what: 'add the key hrms_leave_requests.decided_by -> users', sql: 'ALTER TABLE hrms_leave_requests ADD CONSTRAINT fk_hlvr_decider FOREIGN KEY (decided_by) REFERENCES users(id)' });
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
    console.log(APPLY ? '\n  done. No requests or balances are written by this script.\n' : `\n  nothing written — ${steps.length} schema step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; a test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
