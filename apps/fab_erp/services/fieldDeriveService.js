/**
 * fieldDeriveService.js — the numbers nobody should be typing.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The Parameters step asked for about 150 numbers on a composite girder span,
 * and roughly 60 of them were arithmetic on the others. Checked against 1,062
 * real parts from the KEPL BOQ, every single row agreed with the formula:
 *
 *   edge_length_m    = 2 * (L + W) / 1000                    1062/1062
 *   surface_area_m2  = (2LW + 2T(L+W)) / 1e6                 1062/1062
 *   unit_weight_kg   = L * W * T * density / 1e9             1062/1062
 *
 * Not "mostly". Every one. Somebody was typing the perimeter of a rectangle
 * whose sides they had typed on the same screen — and every one of those is a
 * chance for the two to disagree, with nothing to say which is right.
 *
 * ── WHY THESE FIELDS STILL EXIST AT ALL ──────────────────────────────────────
 *
 * `edge_length_m` did not need to: the two formulas that read it are part
 * formulas, so the expression was inlined and the field retired.
 *
 * `unit_weight_kg` and `surface_area_m2` cannot be, because ASSEMBLIES roll
 * them up — a Segment's weight is the sum of its parts, written
 * `inputs.sum(unit_weight_kg)`. The engine's aggregate takes a FIELD NAME, not
 * an expression, so `inputs.sum(length_mm * width_mm)` will not parse. The
 * fields therefore stay in the data so the roll-up has something to sum, and
 * leave the screen so nobody is asked for them.
 *
 * ── DENSITY, AND WHY IT IS A CONSTANT HERE ───────────────────────────────────
 *
 * Weight is volume times density, and density lives on RAW MATERIAL — which is
 * not assigned until nesting, a step AFTER this one. So a weight computed here
 * has to assume steel. 7850 kg/m3 is the default rather than a guess dressed up
 * as data: a part that later lands on a plate of stated density is recomputed
 * from it, and `density_kg_m3` on the row overrides in the meantime.
 */

import { Parser } from 'expr-eval';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { setFieldsBulk } from './fieldService.js';

const parser = new Parser({ operators: { logical: true, comparison: true } });

/** Mild steel, in kg/m3. See the header — this is a stated default, not data. */
export const DEFAULT_DENSITY = 7850;

/**
 * `item.length_mm` -> `item_length_mm`, matching what the time-formula engine
 * does, so a derived formula and a time formula are written the same way.
 */
const normalise = (src) => String(src).replace(/\b(item)\.(\w+)\b/g, '$1_$2');

/**
 * Fields that are computed rather than asked for.
 *
 * Held here rather than in a column because they are arithmetic identities, not
 * configuration: a company cannot have a different opinion about the perimeter
 * of a rectangle. A field somebody genuinely wants to vary belongs in the
 * registry, typed, like `num_holes` and `weld_length_m` still are.
 */
export const DERIVED = {
  unit_weight_kg: 'item.length_mm * item.width_mm * item.thickness_mm * item.density_kg_m3 / 1000000000',
  surface_area_m2:
    '(2 * item.length_mm * item.width_mm + 2 * item.thickness_mm * (item.length_mm + item.width_mm)) / 1000000',
};

export const isDerived = (fieldKey) => Object.prototype.hasOwnProperty.call(DERIVED, fieldKey);

/**
 * The rectangle. Asked for on its own step, BEFORE nesting.
 *
 * Nesting needs the size and the steel and nothing else — it never reads a
 * flow — so making it wait behind hole counts and weld runs delayed the one
 * step with a lead time on it. Everything else a flow asks for comes after.
 */
export const DIMENSIONS = ['length_mm', 'width_mm', 'thickness_mm'];
export const isDimension = (fieldKey) => DIMENSIONS.includes(fieldKey);

/**
 * Recompute the derived fields for some order items.
 *
 * ONLY WHERE THE INPUTS ARE ALL PRESENT. A part with no width has no area, and
 * writing 0 would be a lie that reads as a measurement — the crane formula
 * would take it and quietly plan a weightless lift. Absent stays absent, and
 * the Parameters step goes on reporting the part as short of values.
 *
 * ONLY FOR ROWS THAT HAVE A RECTANGLE. An assembly has none; its weight and
 * area come from summing its parts at formula time, not from here.
 */
export async function recomputeDerived(companyId, itemIds, existingConn = null) {
  const ids = [...new Set((itemIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return { items: 0, values: 0 };

  const conn = existingConn ?? pool;

  const [fields] = await conn.query(
    `SELECT id, field_key, default_unit FROM fab_fields
      WHERE company_id = ? AND deleted_at IS NULL AND field_key IN (?)`,
    [companyId, [...Object.keys(DERIVED), 'length_mm', 'width_mm', 'thickness_mm', 'density_kg_m3']],
  );
  const idOf = new Map(fields.map((f) => [f.field_key, f]));
  for (const k of Object.keys(DERIVED)) {
    if (!idOf.has(k)) {
      logger.warn({ field: k }, '[derive] field is missing from the registry — skipping');
      return { items: 0, values: 0 };
    }
  }

  const [vals] = await conn.query(
    `SELECT v.scope_id AS itemId, f.field_key AS k, v.value_num AS n
       FROM fab_field_values v
       JOIN fab_fields f ON f.id = v.field_id
      WHERE v.company_id = ? AND v.scope = 'order_item' AND v.scope_id IN (?)
        AND v.deleted_at IS NULL
        AND f.field_key IN ('length_mm','width_mm','thickness_mm','density_kg_m3')`,
    [companyId, ids],
  );
  const byItem = new Map();
  for (const v of vals) {
    const e = byItem.get(Number(v.itemId)) ?? {};
    e[v.k] = v.n == null ? null : Number(v.n);
    byItem.set(Number(v.itemId), e);
  }

  // Item shape, for the ASSEMBLY path below — a row with no rectangle of its
  // own (a Segment, say) never reaches the leaf branch, but a non-leaf row
  // still owes `unit_weight_kg`/`surface_area_m2` to any assembly-level flow
  // that asks for them (fieldDeriveService header — assemblies roll these up
  // rather than computing from a rectangle they don't have).
  const [itemRows] = await conn.query(
    `SELECT id, is_leaf AS isLeaf, computed_unit_weight AS computedUnitWeight
       FROM fab_items WHERE company_id = ? AND id IN (?)`,
    [companyId, ids],
  );
  const itemById = new Map(itemRows.map((r) => [Number(r.id), r]));

  const compiled = Object.fromEntries(
    Object.entries(DERIVED).map(([k, expr]) => [k, parser.parse(normalise(expr))]),
  );

  let touched = 0;
  const rows = [];
  const assemblyIds = [];
  for (const itemId of ids) {
    const own = byItem.get(itemId) ?? {};
    const L = own.length_mm;
    const W = own.width_mm;
    const T = own.thickness_mm;
    if (Number.isFinite(L) && Number.isFinite(W) && Number.isFinite(T)) {
      const scope = {
        item_length_mm: L,
        item_width_mm: W,
        item_thickness_mm: T,
        item_density_kg_m3: Number.isFinite(own.density_kg_m3) ? own.density_kg_m3 : DEFAULT_DENSITY,
      };
      touched += 1;

      for (const [key, expr] of Object.entries(compiled)) {
        let out;
        try { out = expr.evaluate(scope); } catch { out = null; }
        if (!Number.isFinite(Number(out))) continue;
        rows.push({ scopeId: itemId, key, value: Number(out) });
      }
      continue;
    }

    // No rectangle — only a non-leaf STRUCTURE row is an assembly; a leaf
    // that is simply missing a dimension stays absent, exactly as before.
    const item = itemById.get(itemId);
    if (item && Number(item.isLeaf) !== 1) assemblyIds.push(itemId);
  }

  if (assemblyIds.length) {
    const assemblyValues = new Map(); // itemId -> {unit_weight_kg?, surface_area_m2?}
    const put = (itemId, key, value) => {
      const e = assemblyValues.get(itemId) ?? {};
      e[key] = value;
      assemblyValues.set(itemId, e);
    };

    // unit_weight_kg: `itemWeightService.recomputeOrderWeights` already rolls
    // this up onto `fab_items.computed_unit_weight` — it runs BEFORE this
    // (`itemShapeService.afterStructureWrite`), so it's read, not
    // recomputed. NULL-or-known: an unweighed assembly gets no value, never
    // a silent 0 (§13).
    for (const itemId of assemblyIds) {
      const w = itemById.get(itemId)?.computedUnitWeight;
      if (w != null) put(itemId, 'unit_weight_kg', Number(w));
    }

    // surface_area_m2: Σ(child.qty × child.surface_area_m2) over this row's
    // own STRUCTURE children — ALL-OR-NOTHING, unlike the weight roll-up's
    // partial sum, because a part sum here would look like a real total
    // while silently missing whatever child had no area yet.
    const [children] = await conn.query(
      `SELECT id, parent_item_id AS parentItemId, qty
         FROM fab_items
        WHERE company_id = ? AND parent_item_id IN (?) AND deleted_at IS NULL AND node_kind = 'structure'`,
      [companyId, assemblyIds],
    );
    if (children.length) {
      const [areaVals] = await conn.query(
        `SELECT v.scope_id AS itemId, v.value_num AS n
           FROM fab_field_values v
           JOIN fab_fields f ON f.id = v.field_id
          WHERE v.company_id = ? AND v.scope = 'order_item' AND v.scope_id IN (?)
            AND v.deleted_at IS NULL AND f.field_key = 'surface_area_m2'`,
        [companyId, children.map((c) => c.id)],
      );
      const areaByChild = new Map(areaVals.map((v) => [Number(v.itemId), v.n == null ? null : Number(v.n)]));
      const kidsByParent = new Map();
      for (const c of children) {
        const list = kidsByParent.get(Number(c.parentItemId)) ?? [];
        list.push(c);
        kidsByParent.set(Number(c.parentItemId), list);
      }
      for (const itemId of assemblyIds) {
        const kids = kidsByParent.get(itemId) ?? [];
        if (!kids.length) continue; // nothing under it to sum — stays absent
        let sum = 0;
        let complete = true;
        for (const c of kids) {
          const a = areaByChild.get(Number(c.id));
          if (a == null) { complete = false; break; }
          sum += a * (Number(c.qty) || 0);
        }
        if (complete) put(itemId, 'surface_area_m2', sum);
      }
    }

    for (const [itemId, vals2] of assemblyValues) {
      touched += 1;
      for (const [key, value] of Object.entries(vals2)) rows.push({ scopeId: itemId, key, value });
    }
  }
  /*
   * ON DUPLICATE KEY UPDATE, never delete-then-insert: `uq_ffv_target` is
   * unique over (company, field, scope, scope_id) and counts soft-deleted
   * rows, so clearing and re-writing in one transaction collides with the
   * row just "removed". Batched through setFieldsBulk rather than one INSERT
   * per (item, derived field) — see PLAN.md EU-3.
   */
  const result = rows.length ? await setFieldsBulk(companyId, 'order_item', rows, conn) : { written: 0 };
  return { items: touched, values: result.written };
}

/** Every part row on an order that has a rectangle — the recompute's usual set. */
export async function recomputeDerivedForOrder(companyId, orderId, existingConn = null) {
  const conn = existingConn ?? pool;
  const [rows] = await conn.query(
    `SELECT id FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
        AND node_kind = 'structure'`,
    [companyId, orderId],
  );
  return recomputeDerived(companyId, rows.map((r) => r.id), existingConn);
}

/**
 * `unit_weight_kg` for a CATALOG item that names an actual size — a "MS Plate
 * 20 x 1250 x 2500" catalogued at a fixed size, not the generic "MS Plate
 * 20mm" a part is cut from. Everything above this point derives weight for an
 * ORDER item only; a specifically-sized catalog row got no weight at all
 * before this, which is why the catalog list (S5) could not show one.
 *
 * SAME PHYSICS, DIFFERENT SOURCES. `thickness_mm`/`density_kg_m3`/
 * `section_area_mm2` are real columns on `fab_item_catalog`; `width_mm` and
 * `length_mm` — a specific size is not every dimension a catalog row has —
 * live in `fab_field_values` at scope `catalog_item`, the same place
 * `catalogPickerService.catalogSizes` already reads them from.
 *
 * A PROFILE IS NOT THICKNESS x WIDTH (see ARCHITECTURE.md). `section_area_mm2`
 * wins when the item has one; only a flat item falls back to thickness x
 * width, and even that needs both.
 *
 * NULL-OR-KNOWN. Unlike an order item — always assumed mild steel before
 * nesting assigns real material — a catalog row missing its density gets no
 * weight rather than a silent 7850 guess for something that might not be
 * steel at all, or might never be filled in.
 */
export async function recomputeCatalogWeight(companyId, catalogItemIds, existingConn = null) {
  const ids = [...new Set((catalogItemIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return { items: 0, values: 0 };
  const conn = existingConn ?? pool;

  const [[field]] = await conn.query(
    `SELECT id FROM fab_fields
      WHERE company_id = ? AND deleted_at IS NULL AND field_key = 'unit_weight_kg' LIMIT 1`,
    [companyId],
  );
  if (!field) {
    logger.warn('[derive] unit_weight_kg is missing from the registry — skipping catalog weight');
    return { items: 0, values: 0 };
  }

  const [cats] = await conn.query(
    `SELECT id, thickness_mm AS thicknessMm, density_kg_m3 AS densityKgM3,
            section_area_mm2 AS sectionAreaMm2
       FROM fab_item_catalog WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
    [companyId, ids],
  );
  if (!cats.length) return { items: 0, values: 0 };

  const [vals] = await conn.query(
    `SELECT v.scope_id AS itemId, f.field_key AS k, v.value_num AS n
       FROM fab_field_values v
       JOIN fab_fields f ON f.id = v.field_id
      WHERE v.company_id = ? AND v.scope = 'catalog_item' AND v.scope_id IN (?)
        AND v.deleted_at IS NULL
        AND f.field_key IN ('width_mm','length_mm','thickness_mm')`,
    [companyId, ids],
  );
  const byItem = new Map();
  for (const v of vals) {
    const e = byItem.get(Number(v.itemId)) ?? {};
    e[v.k] = v.n == null ? null : Number(v.n);
    byItem.set(Number(v.itemId), e);
  }

  /**
   * `Number(null) === 0` — a NULL column read straight into `Number()` looks
   * exactly like a real, stated zero. That is precisely the "NULL-or-known,
   * never zero" bug this function exists to avoid, so every optional input is
   * routed through this instead of a bare `Number(...)`.
   */
  const numOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  let touched = 0;
  const rows = [];
  for (const c of cats) {
    const extra = byItem.get(Number(c.id)) ?? {};
    const density = numOrNull(c.densityKgM3);
    if (density == null) continue;

    const length = numOrNull(extra.length_mm);
    if (length == null) continue;

    let volumeMm3;
    const sectionArea = numOrNull(c.sectionAreaMm2);
    if (sectionArea != null && sectionArea > 0) {
      volumeMm3 = sectionArea * length;
    } else {
      const thickness = numOrNull(c.thicknessMm) ?? numOrNull(extra.thickness_mm);
      const width = numOrNull(extra.width_mm);
      if (thickness == null || width == null) continue;
      volumeMm3 = thickness * width * length;
    }

    touched += 1;
    rows.push({ scopeId: Number(c.id), key: 'unit_weight_kg', value: (volumeMm3 * density) / 1e9 });
  }

  const result = rows.length ? await setFieldsBulk(companyId, 'catalog_item', rows, conn) : { written: 0 };
  return { items: touched, values: result.written };
}
