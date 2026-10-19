/**
 * apply-payroll-extras-schema.mjs — the tables of payroll extras P3a (TM/CF_HRMS_HIRING_SPEC.md §25.5;
 * models/init.sql §31 PAYROLL EXTRAS): the perquisites register and the Form 10E worksheet.
 *
 *   node apply-payroll-extras-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-payroll-extras-schema.mjs --apply
 *   node apply-payroll-extras-schema.mjs --apply --target=prod
 *
 * Creates the tables of §31 that are missing, in the order §31 declares them. The CREATE statements
 * are READ FROM init.sql §31 — one source, so this script and a fresh database cannot disagree. A
 * table that is there is left alone. No data is written.
 *
 * Needs §26 (payroll), §27 (hrms_tax_rules) and §30 (tax in payroll) first. Run seed-tax-rules.mjs
 * after it: the perquisite and relief rules (rule keys `perquisites`, `relief_arrears`) are rows of
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
const HEADER = '-- ## 31. PAYROLL EXTRAS';

/** The CREATE TABLE statements of init.sql §31, in order: [{ table, sql }]. */
export function payrollExtrasTables() {
  const text = fs.readFileSync(INIT, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf(HEADER);
  if (start < 0) throw new Error('init.sql has no §31 PAYROLL EXTRAS section.');
  const rest = text.slice(start + 10);
  const next = rest.search(/\n-- ## \d+\./);
  const section = next < 0 ? text.slice(start) : text.slice(start, start + 10 + next);
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS (hrms_[a-z0-9_]+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g;
  for (const m of section.matchAll(re)) out.push({ table: m[1], sql: m[0] });
  return out;
}
export const PAYROLL_EXTRAS_TABLES = payrollExtrasTables().map((t) => t.table);

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['companies', 'users', 'hrms_employees', 'hrms_pay_runs', 'hrms_tax_rules', 'hrms_tax_settings']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run apply-payroll-schema, apply-tax-schema and apply-payroll-tax-schema first.`);
  }
  const steps = [];
  for (const t of payrollExtrasTables()) {
    if (!await table(conn, t.table)) steps.push({ what: `create ${t.table}`, sql: t.sql });
  }
  return steps;
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const tables = payrollExtrasTables();
    if (tables.length !== 2) throw new Error(`init.sql §31 should declare 2 tables; it declares ${tables.length}.`);
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
    console.log(APPLY ? '\n  done. No data is written by this script. Next: seed-tax-rules.mjs --apply (the perquisite and relief rules).\n' : `\n  nothing written — ${steps.length} schema step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; the test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
