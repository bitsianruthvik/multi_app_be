/**
 * apply-payroll-tax-schema.mjs — the tables of income tax in payroll (TM/CF_HRMS_HIRING_SPEC.md §25.4;
 * models/init.sql §30 TAX IN PAYROLL).
 *
 *   node apply-payroll-tax-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-payroll-tax-schema.mjs --apply
 *   node apply-payroll-tax-schema.mjs --apply --target=prod
 *
 * Creates the nine hrms_tax_* tables of §30 that are missing, in the order §30 declares them (each
 * refers only to tables before it), and adds hrms_pay_run_people.tax_json if it is not there. The
 * CREATE statements are READ FROM init.sql §30 — one source, so this script and a fresh database
 * cannot disagree. A table that is there is left alone. No data is written: a company's tax year
 * settings are made when somebody first saves them (the defaults need no row).
 *
 * Needs §26 (payroll) and §27 (hrms_tax_rules) first: apply-payroll-schema.mjs, apply-tax-schema.mjs.
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

/** The CREATE TABLE statements of init.sql §30, in order: [{ table, sql }]. */
export function payrollTaxTables() {
  const text = fs.readFileSync(INIT, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('-- ## 30. TAX IN PAYROLL');
  if (start < 0) throw new Error('init.sql has no §30 TAX IN PAYROLL section.');
  const rest = text.slice(start + 10);
  const next = rest.search(/\n-- ## \d+\./);
  const section = next < 0 ? text.slice(start) : text.slice(start, start + 10 + next);
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS (hrms_tax_[a-z_]+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g;
  for (const m of section.matchAll(re)) out.push({ table: m[1], sql: m[0] });
  return out;
}
export const PAYROLL_TAX_TABLES = payrollTaxTables().map((t) => t.table);

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_employees', 'hrms_audit_log', 'companies', 'users', 'hrms_pay_runs', 'hrms_pay_run_people', 'hrms_tax_rules']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run models/init.sql (or apply-payroll-schema / apply-tax-schema) first.`);
  }
  const steps = [];
  for (const t of payrollTaxTables()) {
    if (!await table(conn, t.table)) steps.push({ what: `create ${t.table}`, sql: t.sql });
  }
  // Every hrms_ table carries deleted_at (the suites' 'nothing left behind' counts it); the chunks table had none at first.
  if (await table(conn, 'hrms_tax_file_chunks') && !await column(conn, 'hrms_tax_file_chunks', 'deleted_at')) {
    steps.push({ what: 'add hrms_tax_file_chunks.deleted_at', sql: 'ALTER TABLE hrms_tax_file_chunks ADD COLUMN deleted_at DATETIME DEFAULT NULL AFTER content' });
  }
  if (!await column(conn, 'hrms_pay_run_people', 'tax_json')) {
    steps.push({ what: 'add hrms_pay_run_people.tax_json', sql: 'ALTER TABLE hrms_pay_run_people ADD COLUMN tax_json JSON NULL AFTER tds_source' });
  }
  return steps;
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const tables = payrollTaxTables();
    if (tables.length !== 9) throw new Error(`init.sql §30 should declare 9 tables; it declares ${tables.length}.`);
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

// Run only when called as a script; the test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
