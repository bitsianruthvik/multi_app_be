/**
 * wipe-company-fab-data.mjs — empty one company's fab_erp data, deliberately.
 *
 * Written for a rebuild: Placebo had accumulated a year of migrations, half-
 * finished orders and test fixtures, and the decision was to start its data
 * again rather than keep reconciling it.
 *
 * KEEP IS AN EXPLICIT LIST, AND EVERYTHING ELSE GOES. The opposite (an explicit
 * delete list) is the tempting shape and it is wrong here: a table nobody
 * remembered would survive, and the whole point is that nothing survives except
 * what was named. A table added later is deleted by default, which for a
 * "start again" is the safe direction.
 *
 * What is kept is the physical and commercial context — where the shop is, who
 * it buys from and sells to, and who works there. None of that is "data we
 * changed"; it is the setting the data lives in, and retyping it would be a
 * pointless risk. Login (companies/users/roles/apps) is in core tables and is
 * never touched by this script at all.
 *
 * Usage:
 *   node scripts/wipe-company-fab-data.mjs <companyId>            # dry run
 *   node scripts/wipe-company-fab-data.mjs <companyId> --apply    # delete
 */

import { pool } from '../db.js';

const args = process.argv.slice(2);
const companyId = Number(args.find((a) => /^\d+$/.test(a)));
const apply = args.includes('--apply');

if (!companyId) {
  console.error('A companyId is required: node scripts/wipe-company-fab-data.mjs 30005 [--apply]');
  process.exit(1);
}

/**
 * Tables whose rows survive.
 *
 * `fab_stock_locations` is here but only PARTLY kept — see below. A plant's
 * warehouse is context; a machine's auto-provisioned WIP area belongs to a
 * machine that is about to stop existing.
 */
const KEEP_WHOLE = new Set([
  'fab_plants',          // where the shop physically is
  'fab_customers',       // who it sells to
  'fab_suppliers',       // who it buys from
  'fab_workers',         // who works there
  'fab_worker_shifts',   // and when
  'fab_shift_calendars',
  'fab_shifts',
  'fab_codegen_rules',   // how codes are minted — recreating these renumbers everything
  'fab_mark_schemes',
]);

/** Kept row-by-row rather than wholesale. */
const KEEP_PARTIAL = 'fab_stock_locations';

const [companies] = await pool.query('SELECT id, name FROM companies WHERE id = ?', [companyId]);
if (!companies.length) { console.error(`No company ${companyId}`); process.exit(1); }
console.log(`\n${apply ? 'WIPE' : 'DRY RUN'} — ${companies[0].name} (company ${companyId})\n`);

const [tableRows] = await pool.query(
  `SELECT TABLE_NAME AS t FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'company_id' AND TABLE_NAME LIKE 'fab\\_%'
    ORDER BY TABLE_NAME`,
);
const tables = tableRows.map((r) => r.t);

/**
 * Machine-owned stock areas: anything a resource points at, plus anything the
 * auto-provisioner minted (`WIP-M<id>`). The plant warehouses and the shared
 * MACH-ON / MACH-OFF areas that init.sql seeds per plant are kept.
 */
const [machineAreas] = await pool.query(
  `SELECT DISTINCT l.id, l.name, l.code
     FROM fab_stock_locations l
    WHERE l.company_id = ?
      AND (l.code LIKE 'WIP-M%'
           OR EXISTS (SELECT 1 FROM fab_resources r
                       WHERE r.company_id = l.company_id AND r.stock_location_id = l.id)
           OR EXISTS (SELECT 1 FROM fab_resource_stock_areas a
                       WHERE a.company_id = l.company_id AND a.stock_location_id = l.id))
      AND l.code NOT IN ('MACH-ON', 'MACH-OFF')`,
  [companyId],
);
const machineAreaIds = machineAreas.map((a) => a.id);

const plan = [];
for (const t of tables) {
  if (KEEP_WHOLE.has(t)) continue;
  const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id = ?`, [companyId]);
  const n = Number(c.n) || 0;
  if (t === KEEP_PARTIAL) {
    if (machineAreaIds.length) plan.push({ t, n: machineAreaIds.length, partial: true });
    continue;
  }
  if (n > 0) plan.push({ t, n, partial: false });
}

const total = plan.reduce((s, p) => s + p.n, 0);

console.log('  KEPT ENTIRELY');
for (const t of [...KEEP_WHOLE].sort()) {
  const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id = ?`, [companyId])
    .catch(() => [[{ n: 0 }]]);
  console.log(`     ${t.padEnd(34)} ${String(c.n).padStart(5)} row(s)`);
}
console.log(`\n  KEPT IN PART — ${KEEP_PARTIAL}`);
const [keptAreas] = await pool.query(
  `SELECT id, name, code FROM fab_stock_locations
    WHERE company_id = ? AND id NOT IN (?) ORDER BY id`,
  [companyId, machineAreaIds.length ? machineAreaIds : [0]],
);
for (const a of keptAreas) console.log(`     keep  #${a.id} ${a.code ?? '—'} — ${a.name}`);
for (const a of machineAreas) console.log(`     DROP  #${a.id} ${a.code ?? '—'} — ${a.name}  (a machine's own area)`);

console.log(`\n  DELETED — ${plan.length} table(s), ${total} row(s)`);
for (const p of plan.sort((a, b) => b.n - a.n)) {
  console.log(`     ${p.t.padEnd(34)} ${String(p.n).padStart(5)}${p.partial ? '  (machine areas only)' : ''}`);
}

if (!apply) {
  console.log('\nNothing was deleted. Re-run with --apply.\n');
  await pool.end();
  process.exit(0);
}

const conn = await pool.getConnection();
try {
  /**
   * FK CHECKS OFF FOR THE WIPE, AND WHY THAT IS SAFE HERE.
   *
   * The schema does carry real foreign keys — `fab_items.parent_item_id` points
   * at itself, `fab_item_drawings` at `fab_items`, `fab_item_bom` at the
   * catalog — so a plain delete fails on ordering, and a self-referencing table
   * cannot be ordered out of the problem at all.
   *
   * Turning the checks off cannot orphan anything in this particular case
   * because every one of those keys is INTRA-COMPANY: no other tenant's row
   * references company 30005's rows, and the two parents that live outside the
   * company (`companies`, `users`) are not being touched. The alternative — a
   * topological sort — would still leave the self-reference unsolved.
   *
   * It stays inside the transaction, so a failure still rolls the whole thing
   * back with nothing deleted, which is exactly what happened on the first
   * attempt.
   */
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  await conn.beginTransaction();
  let deleted = 0;
  for (const p of plan) {
    const [r] = p.partial
      ? await conn.query(`DELETE FROM ${p.t} WHERE company_id = ? AND id IN (?)`, [companyId, machineAreaIds])
      : await conn.query(`DELETE FROM ${p.t} WHERE company_id = ?`, [companyId]);
    deleted += r.affectedRows;
  }
  await conn.commit();
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  console.log(`\nDeleted ${deleted} row(s). Kept ${KEEP_WHOLE.size} table(s) plus ${keptAreas.length} stock location(s).\n`);
} catch (err) {
  await conn.rollback();
  await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
  console.error('\nRolled back — nothing deleted:', err.message, '\n');
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
