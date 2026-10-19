/**
 * apply-attendance-schema.mjs — the attendance module (TM/CF_HRMS_HIRING_SPEC.md §28;
 * models/init.sql §28).
 *
 *   node apply-attendance-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-attendance-schema.mjs --apply
 *   node apply-attendance-schema.mjs --apply --target=prod
 *
 *   1. the ten new tables (devices, device users, punches, API keys, settings, policies,
 *      policy assignments, penalties, months, runs) — their CREATE statements are READ FROM
 *      init.sql §28, so there is one definition;
 *   2. hrms_attendance_records: source gains REGULARIZATION; the computed columns;
 *   3. hrms_attendance_regularizations: kind, person, date, permission minutes, approver, decision;
 *   4. hrms_leave_requests.raised_by_system; hrms_leave_policy_rules.min_present_days_for_credit.
 *
 * Every new column is NULL or defaults to "off", so the old backend keeps working. One change
 * per statement (TiDB). DDL commits by itself: every step is guarded, and a second run finds
 * nothing to do. No data is written. Run it BEFORE deploying the backend that reads them.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));
const columnType = async (conn, t, c) => (await one(conn, 'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]))?.t ?? null;
const index = async (conn, t, i) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [t, i]));

/** The CREATE TABLE statements of init.sql §28, in file order: [{ name, sql }]. */
export function createStatements() {
  const text = fs.readFileSync(path.join(HERE, '..', 'models', 'init.sql'), 'utf8');
  const start = text.indexOf('## 28. ATTENDANCE');
  if (start < 0) throw new Error('init.sql has no section "28. ATTENDANCE".');
  const rest = text.slice(start);
  // The section ends where the next numbered section starts (other sections may follow it in the file).
  const end = rest.search(/\n-- ## \d+\./);
  const section = end < 0 ? rest : rest.slice(0, end);
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g;
  let m;
  while ((m = re.exec(section))) out.push({ name: m[1], sql: m[0] });
  return out;
}

/** The columns, in the order they are added: [table, column, definition, after]. The same as init.sql §28a–d. */
export const COLUMNS = [
  ['hrms_attendance_records', 'worked_minutes', 'INT NULL', 'out_time'],
  ['hrms_attendance_records', 'late_minutes', 'INT NOT NULL DEFAULT 0', 'worked_minutes'],
  ['hrms_attendance_records', 'early_minutes', 'INT NOT NULL DEFAULT 0', 'late_minutes'],
  ['hrms_attendance_records', 'overtime_minutes', 'INT NOT NULL DEFAULT 0', 'early_minutes'],
  ['hrms_attendance_records', 'late_mark', 'TINYINT(1) NOT NULL DEFAULT 0', 'overtime_minutes'],
  ['hrms_attendance_records', 'missing_punch', 'TINYINT(1) NOT NULL DEFAULT 0', 'late_mark'],
  ['hrms_attendance_records', 'present_value', 'DECIMAL(3,2) NOT NULL DEFAULT 0', 'missing_punch'],
  ['hrms_attendance_records', 'leave_value', 'DECIMAL(3,2) NOT NULL DEFAULT 0', 'present_value'],
  ['hrms_attendance_records', 'absent_value', 'DECIMAL(3,2) NOT NULL DEFAULT 0', 'leave_value'],
  ['hrms_attendance_records', 'leave_request_id', 'INT NULL', 'absent_value'],
  ['hrms_attendance_records', 'regularization_id', 'INT NULL', 'leave_request_id'],
  ['hrms_attendance_records', 'policy_id', 'INT NULL', 'regularization_id'],
  ['hrms_attendance_records', 'status_reason', 'VARCHAR(300) NULL', 'policy_id'],
  ['hrms_attendance_records', 'processed_at', 'DATETIME NULL', 'status_reason'],
  ['hrms_attendance_regularizations', 'kind', "VARCHAR(20) NOT NULL DEFAULT 'CORRECTION'", 'attendance_record_id'],
  ['hrms_attendance_regularizations', 'employee_id', 'INT NULL', 'kind'],
  ['hrms_attendance_regularizations', 'attendance_date', 'DATE NULL', 'employee_id'],
  ['hrms_attendance_regularizations', 'permission_minutes', 'INT NULL', 'requested_out_time'],
  ['hrms_attendance_regularizations', 'approver_employee_id', 'INT NULL', 'status'],
  ['hrms_attendance_regularizations', 'decided_by', 'INT NULL', 'reviewed_at'],
  ['hrms_attendance_regularizations', 'decision_note', 'TEXT NULL', 'decided_by'],
  ['hrms_attendance_regularizations', 'raised_by_hr', 'TINYINT(1) NOT NULL DEFAULT 0', 'decision_note'],
  ['hrms_leave_requests', 'raised_by_system', 'TINYINT(1) NOT NULL DEFAULT 0', 'raised_by_hr'],
  ['hrms_leave_policy_rules', 'min_present_days_for_credit', 'TINYINT NULL', 'credit_in_arrears'],
  ['hrms_attendance_punches', 'deleted_at', 'DATETIME DEFAULT NULL', null],
  ['hrms_attendance_settings', 'deleted_at', 'DATETIME DEFAULT NULL', null],
  ['hrms_attendance_penalties', 'deleted_at', 'DATETIME DEFAULT NULL', null],
  ['hrms_attendance_months', 'deleted_at', 'DATETIME DEFAULT NULL', null],
  ['hrms_attendance_runs', 'deleted_at', 'DATETIME DEFAULT NULL', null],
];

const SOURCE_ENUM = "ENUM('BIOMETRIC','MANUAL','IMPORT','SYSTEM','REGULARIZATION') NOT NULL DEFAULT 'MANUAL'";

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_attendance_records', 'hrms_attendance_regularizations', 'hrms_leave_requests', 'hrms_leave_policy_rules']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run models/init.sql (and the leave scripts) first.`);
  }
  if (!await column(conn, 'hrms_leave_requests', 'raised_by_hr') || !await column(conn, 'hrms_leave_policy_rules', 'credit_in_arrears')) {
    throw new Error('Run apply-leave-requests-schema.mjs and apply-leave-rules-schema.mjs first.');
  }
  const steps = [];
  for (const c of createStatements()) {
    if (!await table(conn, c.name)) steps.push({ what: `create ${c.name}`, sql: c.sql });
  }
  const type = await columnType(conn, 'hrms_attendance_records', 'source');
  if (!/'REGULARIZATION'/.test(type ?? '')) {
    steps.push({ what: 'hrms_attendance_records.source gains REGULARIZATION', sql: `ALTER TABLE hrms_attendance_records MODIFY COLUMN source ${SOURCE_ENUM}` });
  }
  // A column added in this run has not been added yet when the next one names it as AFTER: the order of COLUMNS keeps that right.
  for (const [t, c, def, after] of COLUMNS) {
    if (!await table(conn, t)) continue; // made just now by its CREATE, which has the column
    if (!await column(conn, t, c)) steps.push({ what: `add ${t}.${c}`, sql: `ALTER TABLE ${t} ADD COLUMN ${c} ${def}${after ? ` AFTER ${after}` : ''}` });
  }
  if (!await index(conn, 'hrms_attendance_regularizations', 'idx_hreg_person_date')) {
    steps.push({ what: 'index hrms_attendance_regularizations (person, date)', sql: 'ALTER TABLE hrms_attendance_regularizations ADD KEY idx_hreg_person_date (company_id, employee_id, attendance_date)' });
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
    console.log(APPLY ? '\n  done. No data is written by this script.\n' : `\n  nothing written — ${steps.length} schema step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
