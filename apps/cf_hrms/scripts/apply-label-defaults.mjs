/**
 * apply-label-defaults.mjs — leave policy and default shift by label
 * (TM/CF_HRMS_HIRING_SPEC.md §17; models/init.sql §19).
 *
 *   node apply-label-defaults.mjs                       DRY RUN on local — says what it would do
 *   node apply-label-defaults.mjs --apply
 *   node apply-label-defaults.mjs --apply --target=prod
 *
 * THE SCHEMA ONLY — no data is assigned:
 *   1. hrms_leave_policy_assignments.label_id (+ key, + tenant foreign key to
 *      hrms_department_labels). `scope` is checked: it must be a VARCHAR (it
 *      is, since §8); were it an ENUM, LABEL would be added to it keeping every
 *      existing value.
 *   2. target_key rebuilt with label_id in it ('LABEL:<id>' = one live row per
 *      label): TiDB cannot change a generated column's expression, so the
 *      unique key and the column are dropped and added again. COMPANY,
 *      LOCATION and ROLE rows get exactly the key they had — checked after.
 *   3. hrms_department_labels.default_shift_id (+ key, + tenant foreign key to
 *      hrms_shifts).
 *
 * One change per statement (TiDB). DDL commits by itself, so there is no
 * transaction to roll back: every step is guarded and the script is safe to run
 * again — a second run finds nothing to do. The old backend keeps working on
 * the new schema (it never reads label_id or default_shift_id, and its
 * target_key lookups return what they did), so run this BEFORE deploying the
 * backend that reads them.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');

const TARGET_KEY_SQL = "ALTER TABLE hrms_leave_policy_assignments ADD COLUMN target_key VARCHAR(40) GENERATED ALWAYS AS (IF(deleted_at IS NULL, CONCAT(scope, ':', IFNULL(location_id, IFNULL(role_id, IFNULL(label_id, 0)))), NULL)) VIRTUAL";

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const column = (conn, t, c) => one(conn, 'SELECT COLUMN_TYPE, DATA_TYPE, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]);
const index = async (conn, t, i) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [t, i]));
const constraint = async (conn, t, k) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1', [t, k]));

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  const A = 'hrms_leave_policy_assignments';
  const L = 'hrms_department_labels';
  const steps = [];
  for (const t of [A, L, 'hrms_shifts']) {
    if (!await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t])) {
      throw new Error(`${t} is not there — apply models/init.sql (or the earlier scripts: apply-leave-policy-schema, apply-label-groups) first.`);
    }
  }
  // `scope`: a VARCHAR takes LABEL as it is. An ENUM would need LABEL added, keeping every value it has.
  const scope = await column(conn, A, 'scope');
  if (String(scope?.DATA_TYPE).toLowerCase() === 'enum' && !/'LABEL'/i.test(scope.COLUMN_TYPE)) {
    const values = scope.COLUMN_TYPE.replace(/^enum\(/i, '').replace(/\)$/, '');
    steps.push({ what: `add LABEL to the ENUM scope (keeps ${values})`, sql: `ALTER TABLE ${A} MODIFY COLUMN scope ENUM(${values}, 'LABEL') NOT NULL` });
  }
  if (!await column(conn, A, 'label_id')) steps.push({ what: `add ${A}.label_id`, sql: `ALTER TABLE ${A} ADD COLUMN label_id INT NULL AFTER role_id` });
  if (!await index(conn, A, 'idx_hlpa_label')) steps.push({ what: 'add key idx_hlpa_label', sql: `ALTER TABLE ${A} ADD KEY idx_hlpa_label (company_id, label_id)` });
  if (!await constraint(conn, A, 'fk_hlpa_label')) {
    steps.push({ what: 'add foreign key fk_hlpa_label (a label of the same company)', sql: `ALTER TABLE ${A} ADD CONSTRAINT fk_hlpa_label FOREIGN KEY (company_id, label_id) REFERENCES ${L}(company_id, id)` });
  }
  const key = await column(conn, A, 'target_key');
  const oldKey = key && !/label_id/i.test(String(key.GENERATION_EXPRESSION ?? ''));
  if (oldKey && await index(conn, A, 'uq_hlpa_target')) steps.push({ what: 'drop unique key uq_hlpa_target (to rebuild target_key)', sql: `ALTER TABLE ${A} DROP INDEX uq_hlpa_target` });
  if (oldKey) steps.push({ what: 'drop target_key (its expression lacks label_id)', sql: `ALTER TABLE ${A} DROP COLUMN target_key` });
  if (!key || oldKey) steps.push({ what: 'add target_key with label_id in it', sql: TARGET_KEY_SQL });
  if (oldKey || !await index(conn, A, 'uq_hlpa_target')) steps.push({ what: 'add unique key uq_hlpa_target (one live row per target)', sql: `ALTER TABLE ${A} ADD UNIQUE KEY uq_hlpa_target (company_id, target_key)` });

  if (!await column(conn, L, 'default_shift_id')) steps.push({ what: `add ${L}.default_shift_id`, sql: `ALTER TABLE ${L} ADD COLUMN default_shift_id INT NULL AFTER sort_order` });
  if (!await index(conn, L, 'idx_hdlb_default_shift')) steps.push({ what: 'add key idx_hdlb_default_shift', sql: `ALTER TABLE ${L} ADD KEY idx_hdlb_default_shift (company_id, default_shift_id)` });
  if (!await constraint(conn, L, 'fk_hdlb_default_shift')) {
    steps.push({ what: 'add foreign key fk_hdlb_default_shift (a shift of the same company)', sql: `ALTER TABLE ${L} ADD CONSTRAINT fk_hdlb_default_shift FOREIGN KEY (company_id, default_shift_id) REFERENCES hrms_shifts(company_id, id)` });
  }
  return steps;
}

/** Every live assignment's key, as the database computes it — to prove the rebuild changed none. */
async function liveKeys(conn) {
  const hasKey = await column(conn, 'hrms_leave_policy_assignments', 'target_key');
  if (!hasKey) return null;
  const [rows] = await conn.query('SELECT id, target_key FROM hrms_leave_policy_assignments WHERE deleted_at IS NULL ORDER BY id');
  return rows.map((r) => `${r.id}=${r.target_key}`).join(',');
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const [[live]] = await conn.query('SELECT COUNT(*) AS n, COALESCE(SUM(scope = \'LABEL\'), 0) AS labels FROM hrms_leave_policy_assignments WHERE deleted_at IS NULL');
    console.log(`  leave policy assignments: ${live.n} live (${live.labels} by label)`);
    const keysBefore = await liveKeys(conn);
    const steps = await schemaSteps(conn);
    if (!steps.length) console.log('  schema: already there — nothing to do');
    for (const s of steps) {
      if (APPLY) { await conn.query(s.sql); console.log(`  schema: ${s.what} — done`); } else console.log(`  schema: would ${s.what}`);
    }
    if (APPLY && steps.length) {
      const again = await schemaSteps(conn);
      if (again.length) throw new Error(`after applying, still missing: ${again.map((s) => s.what).join('; ')}`);
      const keysAfter = await liveKeys(conn);
      if (keysBefore !== null && keysAfter !== keysBefore) throw new Error('the live assignments read a different target_key after the rebuild — check the table by hand.');
      console.log(`  checked: a second run plans nothing; the ${live.n} live assignment(s) keep their keys`);
    }
    const withDefault = await column(conn, 'hrms_department_labels', 'default_shift_id')
      ? (await one(conn, 'SELECT COUNT(*) AS n FROM hrms_department_labels WHERE deleted_at IS NULL AND default_shift_id IS NOT NULL')).n : 0;
    console.log(`  labels with a default shift: ${withDefault}. No policy and no shift is assigned by this script.`);
    console.log(APPLY ? '\n  done.\n' : `\n  nothing written — ${steps.length} step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; a test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
