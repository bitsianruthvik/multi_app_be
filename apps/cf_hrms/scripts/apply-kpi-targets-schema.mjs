/**
 * apply-kpi-targets-schema.mjs — structured KPI targets (TM/CF_HRMS_HIRING_SPEC.md §24 step 2;
 * models/init.sql §25).
 *
 *   node apply-kpi-targets-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-kpi-targets-schema.mjs --apply
 *   node apply-kpi-targets-schema.mjs --apply --target=prod
 *
 *   1. hrms_kpi_definitions: measurement_type gains WEIGHT, LENGTH, DATE; direction gains EXACT
 *      (values appended to the ENUM — every stored value stays);
 *   2. hrms_role_kpi_assignments.target_json (the structured target of a role line);
 *   3. hrms_performance_plan_kpis: target_max, target_date, job_target_max, job_target_date;
 *   4. hrms_performance_target_changes: from_max, from_date, to_max, to_date.
 *
 * Every new column is NULL, so an old row reads and behaves exactly as before. One change per
 * statement (TiDB). DDL commits by itself: every step is guarded, and a second run finds nothing
 * to do. No data is written (structure-kpi-targets.mjs moves the existing targets). The old
 * backend never reads the new columns, so run this BEFORE deploying the backend that does.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));
const columnType = async (conn, t, c) => (await one(conn, 'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]))?.t ?? null;

/** ENUMs that gain values: [table, column, the value that says it is done, the full new definition]. The same as init.sql §25a. */
export const ENUMS = [
  ['hrms_kpi_definitions', 'measurement_type', 'DATE',
    "ENUM('NUMBER','PERCENTAGE','CURRENCY','DURATION','BOOLEAN','RATING','TEXT','WEIGHT','LENGTH','DATE') NOT NULL DEFAULT 'NUMBER'"],
  ['hrms_kpi_definitions', 'direction', 'EXACT',
    "ENUM('HIGHER_BETTER','LOWER_BETTER','TARGET_RANGE','NEUTRAL','EXACT') NULL"],
];
/** The columns, in the order they are added: [table, column, definition, after]. The same as init.sql §25b-d. */
export const COLUMNS = [
  ['hrms_role_kpi_assignments', 'target_json', 'JSON NULL', 'target_value'],
  ['hrms_performance_plan_kpis', 'target_max', 'DECIMAL(18,4) NULL', 'target_number'],
  ['hrms_performance_plan_kpis', 'target_date', 'DATE NULL', 'target_max'],
  ['hrms_performance_plan_kpis', 'job_target_max', 'DECIMAL(18,4) NULL', 'job_target_number'],
  ['hrms_performance_plan_kpis', 'job_target_date', 'DATE NULL', 'job_target_max'],
  ['hrms_performance_target_changes', 'from_max', 'DECIMAL(18,4) NULL', 'from_number'],
  ['hrms_performance_target_changes', 'from_date', 'DATE NULL', 'from_max'],
  ['hrms_performance_target_changes', 'to_max', 'DECIMAL(18,4) NULL', 'to_number'],
  ['hrms_performance_target_changes', 'to_date', 'DATE NULL', 'to_max'],
];

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_kpi_definitions', 'hrms_role_kpi_assignments', 'hrms_performance_plan_kpis', 'hrms_performance_target_changes']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run models/init.sql (and apply-performance-schema.mjs) first.`);
  }
  const steps = [];
  for (const [t, c, marker, def] of ENUMS) {
    const type = await columnType(conn, t, c);
    if (!type) throw new Error(`${t}.${c} is not there — run models/init.sql first.`);
    if (!type.includes(`'${marker}'`)) steps.push({ what: `let ${t}.${c} take ${marker}`, sql: `ALTER TABLE ${t} MODIFY COLUMN ${c} ${def}` });
  }
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
    console.log(APPLY ? '\n  done. No targets are written by this script (structure-kpi-targets.mjs does that).\n' : `\n  nothing written — ${steps.length} schema step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; a test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
