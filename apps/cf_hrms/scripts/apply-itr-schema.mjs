/**
 * apply-itr-schema.mjs — the ITR helper's table (TM/CF_HRMS_HIRING_SPEC.md §25.6; models/init.sql §29).
 *
 *   node apply-itr-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-itr-schema.mjs --apply
 *   node apply-itr-schema.mjs --apply --target=prod (with the backend release)
 *
 *   1. hrms_itr_returns: one draft return per person per tax year — PRIVATE to the person.
 *   2. its deleted_at column (added 2026-10-20; a table made earlier gets it by a guarded ALTER).
 *      It always stays NULL: "Start again" is a hard DELETE, for privacy. The column exists only
 *      so the suites' "nothing left behind" snapshot (deleted_at on every hrms_ table) can read it.
 *
 * DDL commits by itself: the step is guarded, and a second run finds nothing to do.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));

/** The same as init.sql §29. */
export const CREATE_ITR_RETURNS = `CREATE TABLE IF NOT EXISTS hrms_itr_returns (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  employee_id     INT           NOT NULL,
  tax_year        VARCHAR(7)    NOT NULL,
  status          ENUM('DRAFT','FINALISED') NOT NULL DEFAULT 'DRAFT',
  form            ENUM('ITR1','ITR2') NULL,
  regime          ENUM('OLD','NEW') NULL,
  filing_date     DATE          NULL,
  personal_json   JSON          NULL,
  employer_json   JSON          NULL,
  income_json     JSON          NULL,
  deductions_json JSON          NULL,
  taxes_json      JSON          NULL,
  bank_json       JSON          NULL,
  snapshot_json   JSON          NULL,
  finalised_at    DATETIME      NULL,
  created_by      INT           NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      DATETIME      DEFAULT NULL,
  UNIQUE KEY uq_hitr_person_year (company_id, employee_id, tax_year),
  KEY idx_hitr_employee (company_id, employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const COLUMNS = ['id', 'company_id', 'employee_id', 'tax_year', 'status', 'form', 'regime', 'filing_date', 'personal_json', 'employer_json', 'income_json',
  'deductions_json', 'taxes_json', 'bank_json', 'snapshot_json', 'finalised_at', 'created_by', 'created_at', 'updated_at'];

/** What is still missing, in order: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  if (!await table(conn, 'hrms_itr_returns')) return [{ what: 'create hrms_itr_returns', sql: CREATE_ITR_RETURNS }];
  const missing = [];
  for (const c of COLUMNS) if (!await column(conn, 'hrms_itr_returns', c)) missing.push(c);
  if (missing.length) throw new Error(`hrms_itr_returns is there but lacks ${missing.join(', ')} — not a table this script made; look at it by hand.`);
  const steps = [];
  if (!await column(conn, 'hrms_itr_returns', 'deleted_at')) {
    steps.push({ what: 'add hrms_itr_returns.deleted_at (stays NULL; "Start again" deletes outright)', sql: 'ALTER TABLE hrms_itr_returns ADD COLUMN deleted_at DATETIME DEFAULT NULL AFTER updated_at' });
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
    console.log(APPLY ? '\n  done.\n' : `\n  nothing written — ${steps.length} schema step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
