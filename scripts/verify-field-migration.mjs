/**
 * verify-field-migration.mjs — read-only. Re-derives every task's estimate
 * through the NEW field-resolution chain and reports any that moved.
 *
 * Run this BEFORE applying the field registry to a database that matters, and
 * again after. Phase 1 is a rename-and-move where every live formula references
 * its fields by name (`item.length_mm`, `item.weld_length_m`,
 * `item.thickness_mm`) — if a key fails to survive the move, every formula in
 * the company silently starts estimating from zero, which is the exact failure
 * this whole change exists to end. A diff of one task is worth knowing about.
 *
 * A task whose stored value came from somewhere other than a formula — seeded
 * demo rows, hand-set hours — will legitimately differ. Those are reported
 * separately from tasks that HAVE a formula and changed anyway, which are the
 * only ones that should worry anybody.
 *
 *   node scripts/verify-field-migration.mjs [companyId]
 *
 * Writes nothing. Safe against production.
 */

import { pool } from '../db.js';
import { resolveItemFields, inputContextForItem } from '../apps/fab_erp/services/itemFieldService.js';
import { evaluateFormula, formulaResultToHours } from '../apps/fab_erp/services/formulaEngine.js';

const TOLERANCE_HOURS = 0.02;

async function main() {
  const only = Number(process.argv[2]) || null;
  const [companies] = await pool.query(
    only
      ? 'SELECT id, name FROM companies WHERE id = ?'
      : `SELECT DISTINCT c.id, c.name FROM companies c
           JOIN fab_project_tasks t ON t.company_id = c.id AND t.deleted_at IS NULL`,
    only ? [only] : [],
  );

  let totalChanged = 0;
  for (const co of companies) {
    const [tasks] = await pool.query(
      `SELECT t.id, t.item_id AS itemId, t.computed_hours AS storedHours,
              t.resource_type_id AS resourceTypeId, t.operation_id AS operationId,
              o.name AS opName, o.time_formula AS formula, o.time_unit AS timeUnit
         FROM fab_project_tasks t
         JOIN fab_operations o ON o.id = t.operation_id
        WHERE t.company_id = ? AND t.deleted_at IS NULL
        ORDER BY t.id`,
      [co.id],
    );
    if (!tasks.length) continue;

    const values = await resolveItemFields(co.id, tasks.map((t) => t.itemId));

    // op.* is loaded per operation the same way materialization does it, or a
    // formula using op.<var> would re-derive differently for the wrong reason.
    const [opVars] = await pool.query(
      `SELECT operation_id AS opId, var_key AS k, default_value AS v
         FROM fab_operation_variables WHERE company_id = ? AND deleted_at IS NULL`,
      [co.id],
    );
    const opValsByOp = new Map();
    for (const r of opVars) {
      if (!opValsByOp.has(r.opId)) opValsByOp.set(r.opId, {});
      opValsByOp.get(r.opId)[r.k] = r.v;
    }

    const changed = [];
    const noFormula = [];
    for (const t of tasks) {
      if (!t.formula || !String(t.formula).trim()) { noFormula.push(t); continue; }
      const derived = formulaResultToHours(
        await evaluateFormula(
          t.formula, values.get(t.itemId) ?? {}, {}, t.resourceTypeId,
          opValsByOp.get(t.operationId) ?? {},
          // Same input resolution the materialize path uses. Without it, this
          // harness would report a change on every input.*/inputs.* formula the
          // moment one is written — and a verifier that cries wolf gets ignored.
          await inputContextForItem(co.id, t.itemId),
        ),
        t.timeUnit,
      );
      const stored = t.storedHours == null ? null : Number(t.storedHours);
      if (stored == null && derived == null) continue;
      if (stored == null || derived == null || Math.abs(stored - derived) > TOLERANCE_HOURS) {
        changed.push({ ...t, stored, derived });
      }
    }

    console.log(`\n── ${co.name} (company ${co.id}) — ${tasks.length} tasks`);
    console.log(`   ${tasks.length - noFormula.length} with a formula · ${noFormula.length} without`);
    if (!changed.length) {
      console.log('   ✓ every formula-derived estimate re-derives unchanged');
    } else {
      console.log(`   ⚠ ${changed.length} would CHANGE:`);
      for (const c of changed.slice(0, 40)) {
        console.log(`     task ${String(c.id).padEnd(7)} ${String(c.opName ?? '').padEnd(22)} ${String(c.stored).padEnd(9)} → ${c.derived}`);
      }
      if (changed.length > 40) console.log(`     … and ${changed.length - 40} more`);
    }
    totalChanged += changed.length;
  }

  console.log(`\n${totalChanged === 0 ? 'PASS' : 'REVIEW'} — ${totalChanged} estimate(s) would change.`);
  await pool.end();
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
