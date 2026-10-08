/**
 * time-formulas-to-rules.mjs — operation times move onto the operation's rules (init.sql §49).
 *
 * The user (2026-10-08): "are all formulas now on the operation itself (which I feel is ideal)?
 * If so, let's clean up those formulas." Each time formula on Placebo is used by exactly one rule,
 * so nothing is lost by writing it on that rule:
 *   1. a rule's work / setup formula → the rule's own work_expression / setup_expression (formula unlinked)
 *   2. a rule's fixed work / setup minutes → the same number as its expression
 *   3. every formula now used by no rule and no specification rule, that reads item. / machine.
 *      values (a TIME formula), is retired (soft-deleted). Value formulas (weights, areas) stay.
 *
 *   node scripts/cf_kepl/time-formulas-to-rules.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/time-formulas-to-rules.mjs --company 30005 --apply    (commits)
 * Needs §49 (the two expression columns). Re-running finds nothing left to move.
 */
import { pool } from '../../db.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [[cols]] = await db.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_operation_machine_rules' AND COLUMN_NAME IN ('work_expression','setup_expression')");
  if (Number(cols.n) < 2) throw new Error('The §49 columns are not on this database yet — run s49.sql first (it prints SCHEMA-OK).');

  const [rules] = await db.query(
    `SELECT r.id, o.code AS op, COALESCE(m.code, n.name) AS subject, r.work_minutes, r.work_formula_id, r.work_expression, wf.code AS wcode, wf.expression AS wexpr,
            r.setup_minutes, r.setup_formula_id, r.setup_expression, sf.code AS scode, sf.expression AS sexpr
       FROM cf_operation_machine_rules r
       JOIN cf_operations o ON o.id = r.operation_id
       LEFT JOIN cf_machines m ON r.subject_type = 'machine' AND m.id = r.subject_id
       LEFT JOIN cf_classification_nodes n ON r.subject_type = 'classification' AND n.id = r.subject_id
       LEFT JOIN cf_formulas wf ON wf.id = r.work_formula_id
       LEFT JOIN cf_formulas sf ON sf.id = r.setup_formula_id
      WHERE r.company_id = ? AND r.deleted_at IS NULL ORDER BY o.code, r.id`, [COMPANY]);
  const was = new Set();
  let moved = 0;
  for (const r of rules) {
    const set = {};
    const say = [];
    for (const [k, minutes, fid, own, code, expr] of [['work', r.work_minutes, r.work_formula_id, r.work_expression, r.wcode, r.wexpr], ['setup', r.setup_minutes, r.setup_formula_id, r.setup_expression, r.scode, r.sexpr]]) {
      if (own != null && String(own).trim() !== '') continue;
      if (fid) { set[`${k}_expression`] = expr; set[`${k}_formula_id`] = null; was.add(fid); say.push(`${k} ← ${code}: ${expr}`); }
      else if (minutes != null) { set[`${k}_expression`] = String(Number(minutes)); set[`${k}_minutes`] = null; say.push(`${k} ← ${Number(minutes)} min (fixed)`); }
    }
    if (!say.length) continue;
    await db.query(`UPDATE cf_operation_machine_rules SET ${Object.keys(set).map((x) => `${x} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...Object.values(set), COMPANY, r.id]);
    moved++;
    console.log(`  ~ ${r.op} · ${r.subject}: ${say.join(' · ')}`);
  }
  console.log(`1–2. ${moved} rule(s) now carry their own times`);

  const [orphans] = await db.query(
    `SELECT f.id, f.code, f.expression FROM cf_formulas f
      WHERE f.company_id = ? AND f.deleted_at IS NULL
        AND (f.expression LIKE '%item.%' OR f.expression LIKE '%machine.%' OR f.id IN (?))
        AND NOT EXISTS (SELECT 1 FROM cf_operation_machine_rules r WHERE r.company_id = f.company_id AND r.deleted_at IS NULL AND (r.work_formula_id = f.id OR r.setup_formula_id = f.id))
        AND NOT EXISTS (SELECT 1 FROM cf_spec_assignments a WHERE a.company_id = f.company_id AND a.deleted_at IS NULL AND a.formula_id = f.id)`,
    [COMPANY, [0, ...was]],
  );
  if (orphans.length) await db.query('UPDATE cf_formulas SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, orphans.map((f) => f.id)]);
  for (const f of orphans) console.log(`  - retired ${f.code}: ${f.expression}`);
  const [[left]] = await db.query('SELECT COUNT(*) AS n FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  console.log(`3. ${orphans.length} time formula(s) retired; ${left.n} value formula(s) stay`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback();
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
