/**
 * plate-kind-setup.mjs — gives a tenant's steel plates the STANDARD / CUSTOM
 * field nesting filters on (init.sql §44, nestingService PLATE_KIND_SPEC_CODE).
 *
 *   node scripts/cf_kepl/plate-kind-setup.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/plate-kind-setup.mjs --company 30005 --apply    (commits)
 *
 * Idempotent — each step is skipped when it is already there:
 *   1. option specification PLATE_KIND "Standard or custom plate": STANDARD (Standard) / CUSTOM (Custom)
 *   2. a rule on the PLATE classification node: captured on the item, DEFAULTED, required
 *   3. the node's own value CUSTOM — so every plate, existing and new, starts
 *      CUSTOM (user, 2026-10-03: "all custom, flip standard") and a plate's own
 *      Standard overrides it. Setting it re-materialises every plate under the node.
 * Cut plates live on CUT_PLATE, a sibling of PLATE, so they never get the field.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createSpec } from '../../apps/cf_erp/services/specificationService.js';
import { createRule } from '../../apps/cf_erp/services/assignmentService.js';
import { setValues } from '../../apps/cf_erp/services/valueService.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');
const CODE = 'PLATE_KIND';

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null, canManage: true, isAdmin: true };
  const [[node]] = await db.query("SELECT id, name FROM cf_classification_nodes WHERE company_id = ? AND code = 'PLATE' AND deleted_at IS NULL", [COMPANY]);
  if (!node) throw new Error(`Company ${COMPANY} has no PLATE classification node.`);

  let [[spec]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, CODE]);
  if (spec) console.log(`1. ${CODE} exists (#${spec.id}) — kept`);
  else {
    spec = await createSpec(db, c, {
      code: CODE, name: 'Standard or custom plate', dataType: 'option',
      description: 'A mill-standard plate size, or a custom one (costs more). Nesting can be told to use standard plates only.',
      options: [{ value: 'STANDARD', label: 'Standard' }, { value: 'CUSTOM', label: 'Custom' }],
    });
    console.log(`1. ${CODE} created (#${spec.id})`);
  }

  const [[rule]] = await db.query(
    "SELECT id FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'classification' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL",
    [COMPANY, node.id, spec.id],
  );
  if (rule) console.log(`2. rule on ${node.name} exists (#${rule.id}) — kept`);
  else {
    const r = await createRule(db, c, { subjectType: 'classification', subjectId: node.id, specificationId: spec.id, captureAt: 'item', valueRule: 'defaulted', isRequired: true });
    console.log(`2. rule on ${node.name} created (#${r.id}): defaulted, required`);
  }

  const [[val]] = await db.query(
    "SELECT v.id, o.value FROM cf_spec_values v LEFT JOIN cf_spec_options o ON o.id = v.option_id WHERE v.company_id = ? AND v.subject_type = 'classification' AND v.subject_id = ? AND v.specification_id = ? AND v.deleted_at IS NULL",
    [COMPANY, node.id, spec.id],
  );
  if (val) console.log(`3. ${node.name} default is ${val.value} — kept`);
  else {
    const out = await setValues(db, c, 'classification', node.id, [{ specCode: CODE, value: 'CUSTOM' }]);
    console.log(`3. ${node.name} default set to CUSTOM — re-materialised ${JSON.stringify(out.materialized)}`);
  }

  const [counts] = await db.query(
    `SELECT COALESCE(o.value, '(none)') AS kind, COUNT(*) AS n
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
       LEFT JOIN cf_spec_values v ON v.subject_type = 'master' AND v.subject_id = m.id AND v.specification_id = ? AND v.deleted_at IS NULL
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE m.company_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL
      GROUP BY COALESCE(o.value, '(none)')`,
    [spec.id, COMPANY, node.id],
  );
  console.log('plates by kind:', counts.map((r) => `${r.kind} ${r.n}`).join(', '));
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback();
  console.error('ERROR', err.message, err.problems ? JSON.stringify(err.problems) : '');
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
