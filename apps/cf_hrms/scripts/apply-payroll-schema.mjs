/**
 * apply-payroll-schema.mjs — the payroll tables (TM/CF_HRMS_HIRING_SPEC.md §25.2; models/init.sql §26).
 *
 *   node apply-payroll-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-payroll-schema.mjs --apply
 *   node apply-payroll-schema.mjs --apply --target=prod
 *
 * Creates the twelve hrms_pay_* tables that are missing, in the order init.sql §26 declares
 * them (each refers only to tables before it). The CREATE statements are READ FROM init.sql
 * §26 — one source, so this script and a fresh database cannot disagree. A table that is
 * there already is left alone, except for the three columns of 2026-10-20 (26h), added when
 * missing: hrms_pay_runs.ever_paid (set to 1 for a run already PAID), hrms_pay_run_lines.pf_wage
 * and esi_wage. Nothing else is created or changed,
 * and no data is written: the ready-made components, the sample structure and the statutory
 * settings are a company's, seeded by scripts/setup-payroll.mjs.
 *
 * DDL commits by itself: every step is guarded, and a second run finds nothing to do.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(HERE, '..', 'models', 'init.sql');

/** The CREATE TABLE statements of init.sql §26, in order: [{ table, sql }]. */
export function payrollTables() {
  const text = fs.readFileSync(INIT, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('-- ## 26. PAYROLL');
  if (start < 0) throw new Error('init.sql has no §26 PAYROLL section.');
  // To the next numbered section, or the end of the file.
  const rest = text.slice(start + 10);
  const next = rest.search(/\n-- ## \d+\./);
  const section = next < 0 ? text.slice(start) : text.slice(start, start + 10 + next);
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS (hrms_pay_[a-z_]+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g;
  for (const m of section.matchAll(re)) out.push({ table: m[1], sql: m[0] });
  return out;
}
export const PAYROLL_TABLES = payrollTables().map((t) => t.table);

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_employees', 'hrms_audit_log', 'companies', 'users']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run models/init.sql first.`);
  }
  const steps = [];
  for (const t of payrollTables()) {
    if (!await table(conn, t.table)) steps.push({ what: `create ${t.table}`, sql: t.sql });
  }
  // 26h (2026-10-20): columns on tables made before them. A table created above has them already.
  const made = new Set(steps.map((s) => s.what));
  if (!made.has('create hrms_pay_runs') && await table(conn, 'hrms_pay_runs') && !await column(conn, 'hrms_pay_runs', 'ever_paid')) {
    steps.push({ what: 'add hrms_pay_runs.ever_paid', sql: 'ALTER TABLE hrms_pay_runs ADD COLUMN ever_paid TINYINT(1) NOT NULL DEFAULT 0 AFTER reopen_note' });
    steps.push({ what: 'mark the runs already PAID as ever paid', sql: "UPDATE hrms_pay_runs SET ever_paid = 1 WHERE status = 'PAID'" });
  }
  if (!made.has('create hrms_pay_run_lines') && await table(conn, 'hrms_pay_run_lines') && !await column(conn, 'hrms_pay_run_lines', 'pf_wage')) {
    steps.push({ what: 'add hrms_pay_run_lines.pf_wage and esi_wage', sql: 'ALTER TABLE hrms_pay_run_lines ADD COLUMN pf_wage DECIMAL(14,2) NULL AFTER for_month, ADD COLUMN esi_wage DECIMAL(14,2) NULL AFTER pf_wage' });
  }
  return steps;
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const tables = payrollTables();
    if (tables.length !== 12) throw new Error(`init.sql §26 should declare 12 tables; it declares ${tables.length}.`);
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
    console.log(APPLY ? '\n  done. No data is written by this script (scripts/setup-payroll.mjs seeds a company).\n' : `\n  nothing written — ${steps.length} schema step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; a test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
