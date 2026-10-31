/**
 * movementLinks.js — init.sql §95 (2026-10-31): cf_stock_movements.requisition_id (the MR an issue was made from —
 * "Issue now" on the MR screen) and cf_stock_movements.maintenance_order_id (the maintenance order spares were issued to).
 *
 * A backend ahead of its schema keeps working: readers ask hasMovementLinks(db) and leave the columns out while they
 * are missing; writers refuse only a movement that NEEDS them. One information_schema read per process (asked again a
 * minute after it was found missing).
 */
let known = { has: null, at: 0 };

export async function hasMovementLinks(db) {
  if (known.has === true) return true;
  if (known.has === false && Date.now() - known.at < 60_000) return false;
  const [[r]] = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_movements' AND COLUMN_NAME IN ('requisition_id', 'maintenance_order_id')`,
  );
  known = { has: Number(r?.n) === 2, at: Date.now() };
  return known.has;
}

export const MOVEMENT_LINKS_MISSING = 'This needs the stores update (init.sql §95: an issue remembers its MR and maintenance order) — it is not installed on this database yet.';
