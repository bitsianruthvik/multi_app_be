/**
 * offcut-setup.mjs — gives a tenant the OFFCUTS variant its offcut pieces are
 * filed under (CF_ERP_WIP_LEDGER_PLAN.md §5, productionLedgerService.offcutItem).
 *
 *   node scripts/cf_kepl/offcut-setup.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/offcut-setup.mjs --company 30005 --apply    (commits)
 *
 * Makes classification node OFFCUT "Offcuts" beside Plate and Cut plate (same
 * parent as PLATE). Idempotent. The items themselves — one per steel, "Offcut
 * 12 mm E350 BO" — are made by the production ledger the first time a plate of
 * that steel is cut; without this node a cut leaves its offcuts planned.
 */
import { pool } from '../../db.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [[plate]] = await db.query("SELECT id, parent_id, depth, scope FROM cf_classification_nodes WHERE company_id = ? AND code = 'PLATE' AND deleted_at IS NULL", [COMPANY]);
  if (!plate) throw new Error(`Company ${COMPANY} has no PLATE node.`);
  const [[have]] = await db.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'OFFCUT' AND deleted_at IS NULL", [COMPANY]);
  if (have) console.log(`OFFCUT exists (#${have.id}) — kept`);
  else {
    const [r] = await db.query(
      "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status, created_in) VALUES (?, ?, ?, ?, 'OFFCUT', 'Offcuts', 'active', 'items')",
      [COMPANY, plate.parent_id, plate.depth, plate.scope],
    );
    console.log(`OFFCUT created (#${r.insertId}) beside PLATE`);
  }
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback();
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
