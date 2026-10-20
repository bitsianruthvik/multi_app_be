/**
 * apply-payroll-exit-schema.mjs — the tables of payroll P3b (TM/CF_HRMS_HIRING_SPEC.md §25.5; models/init.sql
 * §32 PAYROLL EXIT AND CLAIMS): the payroll policy, the run's "pay without attendance", full and final
 * settlements, claim types, claims and their bills — and two appended ENUM values.
 *
 *   node apply-payroll-exit-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-payroll-exit-schema.mjs --apply
 *   node apply-payroll-exit-schema.mjs --apply --target=prod
 *
 * Creates the tables of §32 that are missing, in the order §32 declares them. The CREATE statements
 * are READ FROM init.sql §32 — one source, so this script and a fresh database cannot disagree. A
 * table that is there is left alone. Then, only when the value is missing:
 *   hrms_pay_run_lines.source  gets 'ATTENDANCE', 'SETTLEMENT', 'CLAIM' (appended; nothing else changes)
 *   hrms_tax_files.purpose     gets 'CLAIM_BILL' (appended)
 * No data is written. Every table has company_id and deleted_at (checked).
 *
 * Needs §26 (payroll), §12 (exits), §28 (attendance) and §30 (tax in payroll) first. Run
 * seed-tax-rules.mjs after it: the new rules (`retirement_contributions`, `final_settlement`) are rows of
 * hrms_tax_rules. DDL commits by itself: every step is guarded, and a second run finds nothing to do.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(HERE, '..', 'models', 'init.sql');
const HEADER = '-- ## 32. PAYROLL EXIT AND CLAIMS';

function sectionText() {
  const text = fs.readFileSync(INIT, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf(HEADER);
  if (start < 0) throw new Error('init.sql has no §32 PAYROLL EXIT AND CLAIMS section.');
  const rest = text.slice(start + 10);
  const next = rest.search(/\n-- ## \d+\./);
  return next < 0 ? text.slice(start) : text.slice(start, start + 10 + next);
}

/** The CREATE TABLE statements of init.sql §32, in order: [{ table, sql }]. */
export function payrollExitTables() {
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS (hrms_[a-z0-9_]+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g;
  for (const m of sectionText().matchAll(re)) out.push({ table: m[1], sql: m[0] });
  return out;
}
export const PAYROLL_EXIT_TABLES = payrollExitTables().map((t) => t.table);

/** The appended ENUM values: the column, the value that marks it done, the statement (read from §32b). */
export function enumChanges() {
  const s = sectionText();
  const pick = (table) => {
    const m = new RegExp(`"(ALTER TABLE ${table} MODIFY COLUMN [^"]+)"`).exec(s);
    if (!m) throw new Error(`init.sql §32b has no ALTER for ${table}.`);
    return m[1];
  };
  return [
    { table: 'hrms_pay_run_lines', column: 'source', mark: 'CLAIM', values: ['ATTENDANCE', 'SETTLEMENT', 'CLAIM'], sql: pick('hrms_pay_run_lines') },
    { table: 'hrms_tax_files', column: 'purpose', mark: 'CLAIM_BILL', values: ['CLAIM_BILL'], sql: pick('hrms_tax_files') },
  ];
}

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const columnType = async (conn, t, c) => (await one(conn, 'SELECT COLUMN_TYPE AS ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]))?.ty ?? null;

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['companies', 'users', 'hrms_employees', 'hrms_employee_exits', 'hrms_pay_runs', 'hrms_pay_run_lines', 'hrms_tax_files', 'hrms_attendance_months']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run the earlier schema scripts (payroll, attendance, tax in payroll) first.`);
  }
  const steps = [];
  for (const t of payrollExitTables()) {
    if (!await table(conn, t.table)) steps.push({ what: `create ${t.table}`, sql: t.sql });
  }
  for (const e of enumChanges()) {
    const ty = await columnType(conn, e.table, e.column);
    if (ty && !ty.includes(`'${e.mark}'`)) steps.push({ what: `${e.table}.${e.column}: append ${e.values.join(', ')}`, sql: e.sql });
  }
  return steps;
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const tables = payrollExitTables();
    if (tables.length !== 7) throw new Error(`init.sql §32 should declare 7 tables; it declares ${tables.length}.`);
    for (const t of tables) if (!/\bcompany_id\b/.test(t.sql) || !/\bdeleted_at\b/.test(t.sql)) throw new Error(`${t.table} lacks company_id or deleted_at.`);
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
    console.log(APPLY ? '\n  done. No data is written by this script. Next: seed-tax-rules.mjs --apply (retirement_contributions, final_settlement).\n' : `\n  nothing written — ${steps.length} schema step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; the test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
