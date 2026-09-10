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

  const compiled = Object.fromEntries(
    Object.entries(DERIVED).map(([k, expr]) => [k, parser.parse(normalise(expr))]),
  );

  let touched = 0;
  let written = 0;
  for (const itemId of ids) {
    const own = byItem.get(itemId) ?? {};
    const L = own.length_mm;
    const W = own.width_mm;
    const T = own.thickness_mm;
    if (!Number.isFinite(L) || !Number.isFinite(W) || !Number.isFinite(T)) continue;

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
      const f = idOf.get(key);
      /*
       * ON DUPLICATE KEY UPDATE, never delete-then-insert: `uq_ffv_target` is
       * unique over (company, field, scope, scope_id) and counts soft-deleted
       * rows, so clearing and re-writing in one transaction collides with the
       * row just "removed".
       */
      await conn.query(
        `INSERT INTO fab_field_values
           (company_id, field_id, scope, scope_id, value_num, unit_code, created_at)
         VALUES (?,?,'order_item',?,?,?,NOW())
         ON DUPLICATE KEY UPDATE value_num = VALUES(value_num), deleted_at = NULL`,
        [companyId, f.id, itemId, Number(out), f.default_unit ?? null],
      );
      written += 1;
    }
  }
  return { items: touched, values: written };
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
