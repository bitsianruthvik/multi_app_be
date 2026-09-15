/**
 * plateSourceService.js — where a candidate plate comes from: bought fresh
 * from the catalogue, or already on the floor as a drop.
 *
 * Split out of `nestingSuggestService.js` (PLAN.md EU-10) because
 * `blankPlanService` needs both functions and `nestingSuggestService.js`
 * itself is deleted by EU-20 — everything except these two moved here first.
 */

import { pool } from '../../../db.js';
import { resolveFields } from './fieldService.js';

const PLATE_GROUP = 'Plates';
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Every buyable plate in the catalog, with the numbers that decide nesting.
 *
 * Read through the field resolver rather than off columns, because width and
 * length have no column at catalog scope — only thickness does — so the columns
 * alone would give a set of plates with no size.
 */
export async function plateCatalog(companyId, conn = null) {
  const exec = conn ?? pool;
  const [items] = await exec.query(
    `SELECT ic.id, ic.code, ic.name, ic.thickness_mm AS thicknessMm
       FROM fab_item_catalog ic
       JOIN fab_item_groups g ON g.id = ic.group_id AND g.name = ? AND g.deleted_at IS NULL
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL`,
    [PLATE_GROUP, companyId],
  );
  if (!items.length) return [];

  const resolved = await resolveFields(
    companyId,
    items.map((i) => ({ scope: 'catalog_item', scopeId: i.id })),
    { conn: exec },
  );
  const out = [];
  for (const i of items) {
    const f = resolved.get(`catalog_item:${i.id}`) ?? {};
    const length = num(f.length_mm?.value);
    const width = num(f.width_mm?.value);
    const thickness = num(f.thickness_mm?.value) ?? num(i.thicknessMm);
    const grade = f.grade?.value ?? null;
    const material = f.material?.value ?? null;
    // A plate with no size cannot be nested onto and is silently useless here;
    // it is left out rather than offered as a candidate that fits everything.
    if (length == null || width == null || thickness == null) continue;
    out.push({ id: i.id, code: i.code, name: i.name, length, width, thickness, grade, material });
  }
  return out;
}

/**
 * Offcuts on the shelf, as candidate plates.
 *
 * WHY THESE ARE DIFFERENT FROM CATALOGUE SIZES, in two ways that both matter:
 *
 *   available: 1   a catalogue size can be bought again; a drop is ONE piece of
 *                  steel and can be nested onto once.
 *   preferred      it is already paid for. The objective is the least steel
 *                  BOUGHT, not the tidiest plate, so a drop that fits is worth
 *                  more than a fresh sheet that fits better.
 *
 * Only drops of the materials this order actually uses are fetched — the yard
 * may hold hundreds and there is no sense packing against 16 mm offcuts for an
 * order made entirely of 12 mm.
 */
export async function offcutSpecs(companyId, catalogItemIds, conn = null) {
  const exec = conn ?? pool;
  if (!catalogItemIds.length) return [];
  const [rows] = await exec.query(
    `SELECT p.id, p.code, p.catalog_item_id AS catalogItemId, p.length_mm AS length,
            p.width_mm AS width, p.dims_estimated AS estimated, ic.name AS materialName,
            ic.thickness_mm AS thickness
       FROM fab_stock_pieces p
       JOIN fab_item_catalog ic ON ic.id = p.catalog_item_id AND ic.deleted_at IS NULL
       LEFT JOIN fab_stock_reservations r
              ON r.stock_piece_id = p.id AND r.status = 'active' AND r.deleted_at IS NULL
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status = 'in_stock'
        AND p.origin_piece_id IS NOT NULL AND p.qty > 0
        AND p.length_mm IS NOT NULL AND p.width_mm IS NOT NULL
        AND p.catalog_item_id IN (?)
        -- A drop somebody else has claimed is not available to offer twice.
        AND r.id IS NULL
      ORDER BY p.length_mm * p.width_mm ASC`,
    [companyId, catalogItemIds],
  );
  return rows.map((r) => ({
    // Negative so it can never collide with a catalog item id in the same list.
    id: -Number(r.id),
    pieceId: Number(r.id),
    catalogItemId: Number(r.catalogItemId),
    code: r.code,
    name: `${r.materialName} — offcut ${r.code}`,
    length: Number(r.length),
    width: Number(r.width),
    thickness: r.thickness == null ? null : Number(r.thickness),
    grade: null, // filled from the material below
    estimated: Number(r.estimated) === 1,
    available: 1,
    preferred: true,
  }));
}
