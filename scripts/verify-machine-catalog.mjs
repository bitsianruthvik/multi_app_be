/**
 * verify-machine-catalog.mjs — did every machine get an identity, and is it safe?
 *
 * Read-only. Phase 8 turns a machine type into a catalog item and a machine into
 * a stock piece. Two things must hold afterwards, and the second one matters
 * more than the first:
 *
 *   1. Every machine has a piece, every type has a catalog item, and nothing was
 *      linked to the wrong one.
 *   2. NO MACHINE CAN BE CONSUMED. A machine is now an in-stock piece, which is
 *      exactly the shape FIFO consumption used to pick blindly. Phase 4 marked
 *      the Machines category `consumable = no` and Phase 6 enforces it — this
 *      proves it, per machine, rather than trusting that it was set.
 *
 * Usage:  node scripts/verify-machine-catalog.mjs [companyId]
 */

import { pool } from '../db.js';
import { isConsumable } from '../apps/fab_erp/services/itemFieldService.js';

const only = Number(process.argv[2]) || null;
let problems = 0;
const flag = (m) => { problems++; console.log(`   ⚠ ${m}`); };

const [companies] = await pool.query(
  only
    ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_resources r ON r.company_id = c.id AND r.deleted_at IS NULL`,
  only ? [only] : [],
);

for (const co of companies) {
  console.log(`\n── ${co.name} (company ${co.id})`);

  const [types] = await pool.query(
    `SELECT rt.id, rt.code, rt.name, rt.catalog_item_id AS catalogItemId,
            i.code AS itemCode, cat.code AS categoryCode
       FROM fab_resource_types rt
       LEFT JOIN fab_item_catalog i ON i.id = rt.catalog_item_id AND i.deleted_at IS NULL
       LEFT JOIN fab_item_categories cat ON cat.id = i.category_id
      WHERE rt.company_id = ? AND rt.deleted_at IS NULL`,
    [co.id],
  );
  const linkedTypes = types.filter((t) => t.catalogItemId);
  for (const t of types) {
    if (!t.catalogItemId) flag(`type "${t.name}" (${t.code}) has no catalog item`);
    else if (t.categoryCode !== 'mach') {
      flag(`type "${t.name}" points at ${t.itemCode}, which is in category "${t.categoryCode}", not Machines`);
    }
  }

  const [machines] = await pool.query(
    `SELECT r.id, r.code, r.name, r.plant_id AS plantId, r.stock_piece_id AS pieceId,
            p.qty, p.status, p.catalog_item_id AS pieceCatalogId, p.stock_location_id AS locId,
            l.code AS locCode, rt.catalog_item_id AS typeCatalogId
       FROM fab_resources r
       LEFT JOIN fab_stock_pieces p ON p.id = r.stock_piece_id AND p.deleted_at IS NULL
       LEFT JOIN fab_stock_locations l ON l.id = p.stock_location_id
       LEFT JOIN fab_resource_types rt ON rt.id = r.resource_type_id
      WHERE r.company_id = ? AND r.deleted_at IS NULL`,
    [co.id],
  );
  const linked = machines.filter((m) => m.pieceId);
  for (const m of machines) {
    if (!m.pieceId) {
      // Not a fault when the machine has no plant — a piece must have a
      // location, and inventing one would put the machine somewhere it is not.
      if (m.plantId) flag(`machine "${m.name}" (${m.code}) has a plant but no stock piece`);
      continue;
    }
    if (Number(m.qty) !== 1) flag(`machine "${m.name}" has a piece of qty ${m.qty} — a machine is one thing, not a quantity`);
    if (m.pieceCatalogId !== m.typeCatalogId) {
      flag(`machine "${m.name}" is a piece of catalog item ${m.pieceCatalogId}, but its type is ${m.typeCatalogId}`);
    }
  }

  console.log(`   ${types.length} type(s), ${linkedTypes.length} with a catalog item`);
  console.log(`   ${machines.length} machine(s), ${linked.length} with a stock piece`
    + ` · ${machines.filter((m) => !m.plantId).length} skipped for having no plant`);

  // THE SAFETY CHECK.
  let consumable = 0;
  for (const t of linkedTypes) {
    if (await isConsumable(co.id, t.catalogItemId)) {
      consumable++;
      flag(`CONSUMABLE: "${t.name}" (${t.itemCode}) could be issued as material into a product`);
    }
  }
  console.log(consumable === 0
    ? `   no machine type is consumable — none can be issued as material`
    : `   ${consumable} machine type(s) ARE consumable`);
}

console.log(problems === 0
  ? '\nCLEAN — every machine has an identity, and none of them can be consumed.'
  : `\nREVIEW — ${problems} problem(s) above.`);

await pool.end();
