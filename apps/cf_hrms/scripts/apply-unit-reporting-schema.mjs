/**
 * apply-unit-reporting-schema.mjs — unit heads, Reports into and the cross-tree reason
 * (TM/CF_HRMS_HIRING_SPEC.md §40; models/init.sql §41 UNIT REPORTING).
 *
 *   node apply-unit-reporting-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-unit-reporting-schema.mjs --apply
 *   node apply-unit-reporting-schema.mjs --apply --target=prod
 *
 *   1. hrms_unit_heads (table)                                    one live head per (unit, shift or none)
 *   2. hrms_departments.reports_into_position_id  INT NULL
 *      hrms_departments.reports_into_mode         ENUM('DEFAULT','CHOSEN') NOT NULL DEFAULT 'DEFAULT'
 *      hrms_departments.reports_into_reason       VARCHAR(500) NULL
 *      + KEY idx_hdep_reports_into
 *   3. hrms_position_reporting_relationships.cross_tree_reason VARCHAR(500) NULL
 *
 * Writes no data: every unit starts DEFAULT with no head, which resolves every position exactly as
 * before (its explicit line, or none). Heads and Reports into come from the screens or from
 * scripts/suggest-unit-reporting.mjs. DDL commits by itself: each step is guarded, so a second run
 * plans nothing. Run this BEFORE deploying the backend that reads them.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));
const index = async (conn, t, i) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [t, i]));

/** The same DDL as init.sql §41. */
export const HEADS_TABLE = `
CREATE TABLE IF NOT EXISTS hrms_unit_heads (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  department_id    INT          NOT NULL,
  position_id      INT          NOT NULL,
  shift_id         INT          NULL,
  deleted_at       DATETIME     DEFAULT NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT          NULL,
  head_key         VARCHAR(40)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, CONCAT(department_id, ':', IFNULL(shift_id, 0)), NULL)) VIRTUAL,
  UNIQUE KEY uq_huh_tenant (company_id, id),
  UNIQUE KEY uq_huh_live   (company_id, head_key),
  KEY idx_huh_unit     (company_id, department_id),
  KEY idx_huh_position (company_id, position_id),
  CONSTRAINT fk_huh_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_huh_unit     FOREIGN KEY (company_id, department_id) REFERENCES hrms_departments(company_id, id),
  CONSTRAINT fk_huh_position FOREIGN KEY (company_id, position_id) REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_huh_shift    FOREIGN KEY (company_id, shift_id) REFERENCES hrms_shifts(company_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

/** [table, column, definition, after] */
export const COLUMNS = [
  ['hrms_departments', 'reports_into_position_id', 'INT NULL', 'sort_order'],
  ['hrms_departments', 'reports_into_mode', "ENUM('DEFAULT','CHOSEN') NOT NULL DEFAULT 'DEFAULT'", 'reports_into_position_id'],
  ['hrms_departments', 'reports_into_reason', 'VARCHAR(500) NULL', 'reports_into_mode'],
  ['hrms_position_reporting_relationships', 'cross_tree_reason', 'VARCHAR(500) NULL', 'notes'],
];

/** What is still missing: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_departments', 'hrms_positions', 'hrms_shifts', 'hrms_position_reporting_relationships']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run models/init.sql first.`);
  }
  if (!await column(conn, 'hrms_departments', 'sort_order')) throw new Error('hrms_departments.sort_order is not there — run apply-org-unit-extras-schema.mjs first.');
  const steps = [];
  if (!await table(conn, 'hrms_unit_heads')) steps.push({ what: 'create hrms_unit_heads', sql: HEADS_TABLE });
  for (const [t, c, def, after] of COLUMNS) {
    // Columns are added in order, so "after" a column added by an earlier step of the same run is fine.
    if (!await column(conn, t, c)) steps.push({ what: `add ${t}.${c}`, sql: `ALTER TABLE ${t} ADD COLUMN ${c} ${def} AFTER ${after}` });
  }
  if (!await index(conn, 'hrms_departments', 'idx_hdep_reports_into')) {
    steps.push({ what: 'add KEY idx_hdep_reports_into', sql: 'ALTER TABLE hrms_departments ADD KEY idx_hdep_reports_into (company_id, reports_into_position_id)' });
  }
  return steps;
}

/** Is the §41 schema there? (readers that must work on a database without it — the migration's dry run). */
export async function hasUnitReportingSchema(conn) {
  return (await table(conn, 'hrms_unit_heads'))
    && (await column(conn, 'hrms_departments', 'reports_into_mode'))
    && (await column(conn, 'hrms_position_reporting_relationships', 'cross_tree_reason'));
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
      if (APPLY) {
        // eslint-disable-next-line no-await-in-loop -- DDL, one statement at a time, in order
        await conn.query(s.sql);
        console.log(`  schema: ${s.what} — done`);
      } else console.log(`  schema: would ${s.what}`);
    }
    if (APPLY) {
      const again = await schemaSteps(conn);
      if (again.length) throw new Error(`after applying, still to do: ${again.map((s) => s.what).join('; ')}`);
      console.log('  checked: a second run plans nothing');
    }
    console.log(APPLY ? '\n  done.\n' : '\n  nothing written. Run again with --apply.\n');
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
