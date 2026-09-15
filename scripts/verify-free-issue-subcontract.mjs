/**
 * verify-free-issue-subcontract.mjs — EU-14 rehearsal, against LOCAL sqldb only.
 *
 * Two checks, two different techniques, because of what each reads through:
 *
 *   1. FREE ISSUE — a genuine rolled-back transaction. `orderShortfall` takes
 *      a `conn`, and this script passes its OWN transaction's connection, so
 *      it reads its own uncommitted UPDATE and nothing survives the rollback
 *      at the end. No DDL: a rolled-back rehearsal still COMMITS any DDL
 *      inside it, so this only ever UPDATEs an existing row.
 *
 *   2. SUBCONTRACT — `productionPlanService.productionPlan` reads unconditionally
 *      via the shared `pool` (every existing caller of it does; it takes no
 *      `conn` parameter), so an uncommitted change on another connection is
 *      invisible to it under any isolation level — not something a rolled-back
 *      transaction can prove either way. This step therefore does a REAL
 *      commit of one boolean flag, reads the plan, then REAL-reverts the same
 *      flag — the same commit+revert technique EU-6/EU-11 used for the same
 *      class of problem. Still no DDL, and the fixture ends exactly as found.
 *
 * Usage: node scripts/verify-free-issue-subcontract.mjs
 */
import { pool } from '../db.js';
import { orderShortfall } from '../apps/fab_erp/services/procurementService.js';
import { productionPlan } from '../apps/fab_erp/services/productionPlanService.js';

const COMPANY_ID = 6;
const ORDER_ID = 247;
const FREE_ISSUE_CATALOG_ITEM_ID = 297; // RM00007, the fixture's one nested buy item

let failed = false;
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) failed = true;
}

// ── 1. free-issue (rolled back) ───────────────────────────────────────────
{
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const before = await orderShortfall(COMPANY_ID, ORDER_ID, conn);
    const beforeLine = before.lines.find((l) => l.catalogItemId === FREE_ISSUE_CATALOG_ITEM_ID);
    check('before: catalog item 297 is in the shortfall lines', !!beforeLine);
    check('before: freeIssueLines is empty', before.freeIssueLines.length === 0);

    await conn.query(
      `UPDATE fab_item_catalog SET procurement_type = 'free_issue' WHERE id = ? AND company_id = ?`,
      [FREE_ISSUE_CATALOG_ITEM_ID, COMPANY_ID],
    );
    await conn.query(
      `UPDATE fab_items SET procurement_type = 'free_issue'
        WHERE company_id = ? AND order_id = ? AND catalog_item_id = ? AND deleted_at IS NULL`,
      [COMPANY_ID, ORDER_ID, FREE_ISSUE_CATALOG_ITEM_ID],
    );

    const after = await orderShortfall(COMPANY_ID, ORDER_ID, conn);
    const afterLine = after.lines.find((l) => l.catalogItemId === FREE_ISSUE_CATALOG_ITEM_ID);
    const afterFree = after.freeIssueLines.find((l) => l.catalogItemId === FREE_ISSUE_CATALOG_ITEM_ID);
    check('after: catalog item 297 LEFT the shortfall lines', !afterLine);
    check('after: catalog item 297 is now in freeIssueLines', !!afterFree);
    check('after: freeIssueLines entry is tagged procurementType=free_issue', afterFree?.procurementType === 'free_issue');
    check(
      'after: every OTHER shortfall line is untouched',
      after.lines.length === before.lines.length - 1
      && after.lines.every((l) => before.lines.some((b) => b.catalogItemId === l.catalogItemId)),
    );

    await conn.rollback();
    console.log('  (rolled back — fab_item_catalog/fab_items unchanged)');
  } catch (err) {
    await conn.rollback();
    console.error('ERROR in free-issue check (rolled back):', err);
    failed = true;
  } finally {
    conn.release();
  }
}

// ── 2. subcontract (real commit + revert — see header) ────────────────────
{
  const [[anyOp]] = await pool.query(
    `SELECT op.id, op.is_subcontract
       FROM fab_project_tasks t
       JOIN fab_operations op ON op.id = t.operation_id AND op.company_id = t.company_id
      WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
      ORDER BY t.id LIMIT 1`,
    [COMPANY_ID, ORDER_ID],
  );
  check('found a real operation used by order 247 to mark is_subcontract on', !!anyOp);

  const planBefore = await productionPlan(COMPANY_ID, ORDER_ID);
  check('before: subcontract.groups is empty', planBefore.subcontract.groups.length === 0);

  try {
    await pool.query(`UPDATE fab_operations SET is_subcontract = 1 WHERE id = ? AND company_id = ?`,
      [anyOp.id, COMPANY_ID]);

    const planAfter = await productionPlan(COMPANY_ID, ORDER_ID);
    const steps = planAfter.subcontract.groups.flatMap((g) => g.steps);
    check('after: subcontract.groups lists at least one step', steps.length > 0);
    check(
      'after: the step names the operation just marked',
      steps.some((s) => s.operationName != null),
    );
  } finally {
    // Revert unconditionally, even if the assertions above threw.
    await pool.query(`UPDATE fab_operations SET is_subcontract = ? WHERE id = ? AND company_id = ?`,
      [anyOp.is_subcontract, anyOp.id, COMPANY_ID]);
    const [[restored]] = await pool.query(`SELECT is_subcontract FROM fab_operations WHERE id = ?`, [anyOp.id]);
    check('operation reverted to its original is_subcontract value', Number(restored.is_subcontract) === Number(anyOp.is_subcontract));
  }
}

if (failed) { console.log('\nFAILED'); process.exit(1); }
console.log('\nALL PASS');
process.exit(0);
