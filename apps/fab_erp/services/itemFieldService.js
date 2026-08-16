/**
 * itemFieldService.js — what a thing's fields ARE, and what they must be.
 *
 * Two questions, one place, because they are the same question asked from
 * different ends:
 *
 *   resolveItemFields   what values does this item actually have?
 *   requiredFieldsFor   what values does its flow's formulas demand?
 *
 * The gap between them is the missing-value warning, and it is the whole reason
 * this file exists. Before it, `evaluateFormula` read `item.*` from
 * `fab_item_metric_values` alone, while the BOQ sheet and the BOM tree wrote
 * `fab_items.length/width/height` — real columns nothing mirrored. Every
 * `item.*` on a normally-built order resolved to 0, and because the engine
 * deliberately defaults unknown symbols to 0 so `IF()` fallbacks can work, a
 * part with no thickness did not error. It became free to cut.
 *
 * THE RESOLUTION CHAIN, first hit wins:
 *
 *   1. the stock piece issued   ONLY for fields marked `piece_varying`
 *   2. the order item           fab_custom_fields level='order_item'
 *   3. its catalog item         fab_custom_fields level='item'  (when bound)
 *   4. sub-group → group → category
 *   5. the field's default_value
 *
 * Step 1 is opt-in per field, not blanket. A silent piece-level override would
 * change a task's estimate the moment stock was issued — right for "this coil
 * came in at 6000 not 12000", alarming for anything else.
 *
 * Step 3 is why the chain exists at all: the items formulas run against are
 * NOT in the catalog. `boqSheetService` inserts every structure level with
 * `catalog_item_id = NULL`; only raw-material children are catalog-bound. So a
 * "Top Flange" has no catalog row and never will — every job is one-off. The
 * catalog can only ever supply defaults for the bought leaves.
 *
 * `level='order_item'` and not `'item'`: `'item'` already means a CATALOG item
 * (level_id = fab_item_catalog.id). Two id spaces in one column would mix an
 * order item's fields with a catalog item's.
 */

import { pool } from '../../../db.js';
import { authoredOnPiece } from './fieldVocabulary.js';
import { parseFormula } from './formulaEngine.js';

/** Levels, in the order the chain consults them. Later entries lose to earlier. */
const CATALOG_LEVEL = 'item';
const ORDER_ITEM_LEVEL = 'order_item';
const PIECE_LEVEL = 'stock_piece';

/** The registry for one company, keyed by field_key. */
export async function fieldRegistry(companyId, conn) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    // `level` and `allowed_values` are Phase 1 additions. `piece_varying` is
    // still selected because `authoredOnPiece` falls back to it for definitions
    // that predate the column — dropping it here would silently demote every
    // piece-varying field to item-level.
    `SELECT field_key, label, data_type, unit, allowed_values, formula_usable,
            piece_varying, level, default_value, category_id, group_id, subgroup_id
       FROM fab_field_defs
      WHERE company_id = ? AND deleted_at IS NULL AND active = 1`,
    [companyId],
  );
  return new Map(rows.map((r) => [r.field_key, r]));
}

/**
 * A raw `fab_custom_fields` value coerced to what the registry says it is.
 *
 * A text field returns null rather than NaN. Letting text reach the formula
 * engine is how a duration silently becomes null and then a zero-length bar:
 * `Number('A36')` is NaN, the engine's try/catch swallows it, and the task
 * plans as instant.
 */
function coerce(raw, def) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (def && def.data_type === 'text') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Effective numeric field values for a set of order items.
 *
 * @param {number} companyId
 * @param {number[]} itemIds            fab_items ids
 * @param {object} [opts]
 * @param {Map<number,number>} [opts.pieceByItem]  itemId → fab_stock_pieces id,
 *        supplying step 1 of the chain. Omit and piece values are simply not
 *        consulted, which is the correct behaviour before stock is issued.
 * @param {object} [opts.conn]
 * @returns {Promise<Map<number, Record<string, number>>>} itemId → { field_key: value }
 */
export async function resolveItemFields(companyId, itemIds, opts = {}) {
  const out = new Map();
  const ids = [...new Set((itemIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return out;
  const exec = opts.conn ?? pool;
  const registry = opts.registry ?? await fieldRegistry(companyId, exec);

  // The items, with the taxonomy reached through their catalog item (when
  // bound). A made part has none of this and falls through to its own values.
  const [items] = await exec.query(
    `SELECT i.id, i.catalog_item_id AS catalogItemId,
            i.length AS legacyLength, i.width AS legacyWidth, i.height AS legacyHeight,
            c.category_id AS categoryId, c.group_id AS groupId, c.subgroup_id AS subgroupId
       FROM fab_items i
       LEFT JOIN fab_item_catalog c ON c.id = i.catalog_item_id AND c.deleted_at IS NULL
      WHERE i.company_id = ? AND i.id IN (?) AND i.deleted_at IS NULL`,
    [companyId, ids],
  );
  if (!items.length) return out;

  // Every level's values in ONE query. The alternative is a query per level per
  // item, which on a thousand-row order is thousands of round trips for what is
  // a handful of rows.
  const levelIds = {
    [ORDER_ITEM_LEVEL]: items.map((i) => i.id),
    [CATALOG_LEVEL]: items.map((i) => i.catalogItemId).filter(Boolean),
    category: items.map((i) => i.categoryId).filter(Boolean),
    group: items.map((i) => i.groupId).filter(Boolean),
    subgroup: items.map((i) => i.subgroupId).filter(Boolean),
    [PIECE_LEVEL]: [...(opts.pieceByItem?.values() ?? [])].filter(Boolean),
  };
  const wanted = Object.entries(levelIds).filter(([, v]) => v.length);
  const byLevel = new Map();
  for (const [level, lids] of wanted) {
    const [rows] = await exec.query(
      `SELECT level, level_id AS levelId, field_key AS fieldKey, field_value AS fieldValue
         FROM fab_custom_fields
        WHERE company_id = ? AND level = ? AND level_id IN (?) AND deleted_at IS NULL`,
      [companyId, level, [...new Set(lids)]],
    );
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.levelId)) m.set(r.levelId, {});
      m.get(r.levelId)[r.fieldKey] = r.fieldValue;
    }
    byLevel.set(level, m);
  }

  const at = (level, id) => (id == null ? undefined : byLevel.get(level)?.get(id));

  for (const item of items) {
    const pieceId = opts.pieceByItem?.get(item.id) ?? null;
    /**
     * The legacy dimension columns, read as a source rather than migrated away.
     *
     * `fab_items.length/width/height` are still the system of record for
     * NESTING (`nestingBoardService` selects `p.height AS partThick`) and for
     * the BOQ round-trip, so they cannot simply be retired here. Treating them
     * as a low-precedence source means every existing row and every future BOQ
     * upload reaches the formulas immediately, without hunting down each writer
     * and without a dual-write that would drift the first time somebody added a
     * sixth one. Phase 4 drops both the columns and this block together.
     *
     * NOTE THE HEIGHT MAPPING. The BOQ sheet's "Thick" column is declared with
     * key 'height' (boqSheetService COLS), so `height` holds THICKNESS. Reading
     * it as height_mm would leave every formula seeing 0 for the dimension that
     * decides cutting time.
     */
    const legacyDims = {};
    if (item.legacyLength != null) legacyDims.length_mm = item.legacyLength;
    if (item.legacyWidth != null) legacyDims.width_mm = item.legacyWidth;
    if (item.legacyHeight != null) legacyDims.thickness_mm = item.legacyHeight;

    // Lowest precedence first, so each later assignment overwrites. An explicit
    // field value beats the legacy column: if somebody has stated it as a field,
    // that is the more deliberate act.
    const sources = [
      at('category', item.categoryId),
      at('group', item.groupId),
      at('subgroup', item.subgroupId),
      at(CATALOG_LEVEL, item.catalogItemId),
      legacyDims,
      at(ORDER_ITEM_LEVEL, item.id),
    ];

    const values = {};
    for (const [key, def] of registry) {
      if (def.default_value != null) {
        const d = coerce(def.default_value, def);
        if (d != null) values[key] = d;
      }
    }
    for (const src of sources) {
      if (!src) continue;
      for (const [key, raw] of Object.entries(src)) {
        const v = coerce(raw, registry.get(key));
        if (v != null) values[key] = v;
      }
    }
    // Step 1, last and narrowest: fields authored on the physical piece, and
    // only when a piece is actually known.
    //
    // Gated on the definition's LEVEL rather than the old `piece_varying`
    // boolean, via `authoredOnPiece` — which still falls back to the boolean
    // for definitions that predate the column, so this is not a behaviour
    // change until a level is set deliberately (Phase 2).
    //
    // The gate matters: without it, a stray piece-level row for an item-level
    // field (`thickness_mm` on one plate) would override the item's own value
    // for that piece alone, and the two would disagree with nothing to say
    // which was right.
    const pieceVals = at(PIECE_LEVEL, pieceId);
    if (pieceVals) {
      for (const [key, raw] of Object.entries(pieceVals)) {
        const def = registry.get(key);
        if (!def || !authoredOnPiece(def)) continue;
        const v = coerce(raw, def);
        if (v != null) values[key] = v;
      }
    }
    out.set(item.id, values);
  }
  return out;
}

/**
 * What a task CONSUMES, shaped for the formula engine's `input.*` / `inputs.*`.
 *
 * A task's inputs are its item's children: the catalog-bearing ones are the
 * material it is cut from, the flow-bearing ones are the parts it is assembled
 * from. Both are ordinary `fab_items` rows, so their values come from the same
 * resolver as everything else — passed in already resolved, because
 * materialization has resolved the whole order's items in one call and
 * re-querying per task would be a round trip per step.
 *
 * ADDRESSED BY ROLE, NEVER BY POSITION. `input[0]` would mean a formula's
 * meaning changes when somebody reorders a BOM — silently, and nobody would ever
 * connect the two.
 *
 * `byRole` takes the FIRST input of each role. With several — a web plate and
 * two stiffeners — "the" thickness is genuinely ambiguous, and picking the first
 * is at least stable and stated. A formula that means all of them should say so
 * with an aggregate: `inputs.sum(weight_kg)`, not `input.child_parts.weight_kg`.
 */
export function buildInputContext({ rmChildren = [], partChildren = [], valuesByItemId }) {
  const fieldsOf = (it) => valuesByItemId?.get(it.id) ?? {};
  // Only roles that actually have an input. An empty role reads identically at
  // evaluation time (absent field -> 0 either way), but a present-yet-empty key
  // makes every diagnostic — the readiness check, the validate preview, the
  // verification harness — claim the task consumes a material it does not.
  const byRole = {};
  if (rmChildren.length) byRole.raw_material = fieldsOf(rmChildren[0]);
  if (partChildren.length) byRole.child_parts = fieldsOf(partChildren[0]);
  return {
    byRole,
    all: [...rmChildren, ...partChildren].map(fieldsOf),
  };
}

/**
 * The same context for ONE item, fetching its children itself.
 *
 * For callers that do not already hold the order's item tree in memory — the
 * re-materialize diff works item by item. Materialization uses
 * `buildInputContext` directly against maps it already has, because a query per
 * step there would be a round trip per task.
 *
 * The two MUST agree: if the diff resolved inputs differently from the path that
 * created the tasks, every re-materialize preview would report a duration change
 * on every input-using step, and a diff nobody trusts gets ignored.
 */
export async function inputContextForItem(companyId, itemId, conn) {
  const exec = conn ?? pool;
  if (!itemId) return { byRole: {}, all: [] };
  const [children] = await exec.query(
    `SELECT id, catalog_item_id AS catalogItemId, flow_id AS flowId
       FROM fab_items
      WHERE company_id = ? AND parent_item_id = ? AND deleted_at IS NULL
      ORDER BY id`,
    [companyId, itemId],
  );
  if (!children.length) return { byRole: {}, all: [] };
  const values = await resolveItemFields(companyId, children.map((c) => c.id), { conn: exec });
  return buildInputContext({
    // Same classification materialization uses: catalog-bearing children are the
    // material, flow-bearing children are the parts.
    rmChildren: children.filter((c) => c.catalogItemId != null),
    partChildren: children.filter((c) => c.flowId != null),
    valuesByItemId: values,
  });
}

/**
 * The `item.*` fields a flow's formulas actually demand.
 *
 * This is what makes "which fields should this part have?" a derived answer
 * rather than a matter of taste. A part on Cut → Drill needs whatever those two
 * formulas reference and nothing else; defaults invented up front become de
 * facto standards, and everyone ends up filling a meaningless "height" on a
 * plate.
 *
 * @returns {Promise<string[]>} field keys, deduplicated
 */
export async function requiredFieldsForFlow(companyId, flowId, conn) {
  const exec = conn ?? pool;
  if (!flowId) return [];
  const [rows] = await exec.query(
    `SELECT DISTINCT o.time_formula AS formula
       FROM fab_operation_flow_steps s
       JOIN fab_operations o ON o.id = s.operation_id AND o.deleted_at IS NULL
      WHERE s.company_id = ? AND s.flow_id = ? AND s.deleted_at IS NULL
        AND o.time_formula IS NOT NULL AND o.time_formula <> ''`,
    [companyId, flowId],
  );
  const keys = new Set();
  for (const r of rows) {
    for (const v of parseFormula(r.formula)?.variables ?? []) {
      if (v.startsWith('item.')) keys.add(v.slice(5));
    }
  }
  return [...keys];
}

/**
 * Everything standing between this order and an honest estimate.
 *
 * TWO FAILURES THAT LOOK IDENTICAL TODAY and must not be reported the same way:
 *
 *   unknownFields  a formula names `item.foo` and no such field is registered.
 *                  An AUTHORING mistake — one wrong formula, not one wrong part.
 *                  Reported once per operation. Reporting it per item would put
 *                  the same typo against nine hundred rows and bury the real
 *                  data problems underneath it.
 *
 *   missingValues  a registered field this part's flow needs, with no value
 *                  anywhere down the resolution chain. A DATA problem, and the
 *                  one that is currently invisible: the engine defaults unknown
 *                  symbols to 0 so `IF()` fallbacks work, so a part with no
 *                  thickness does not error — it becomes free to cut.
 *
 * `noFormula` is the third, already surfaced elsewhere (Operations page, DAG
 * badge) but repeated here because from the order's point of view it is the
 * same question: can this be estimated at all?
 *
 * @returns {Promise<{
 *   itemsChecked:number, itemsShort:number,
 *   missingValues:Array<{itemId, itemName, itemCode, flowId, missing:string[]}>,
 *   unknownFields:Array<{operationId, operationName, keys:string[]}>,
 *   noFormula:Array<{operationId, operationName}>,
 * }>}
 */
export async function missingFieldsForOrder(companyId, orderId, conn) {
  const exec = conn ?? pool;
  const empty = {
    itemsChecked: 0, itemsShort: 0, missingValues: [], unknownFields: [], noFormula: [],
  };

  const [items] = await exec.query(
    `SELECT id, flow_id AS flowId, name AS itemName, code AS itemCode
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND flow_id IS NOT NULL`,
    [companyId, orderId],
  );
  if (!items.length) return empty;

  const registry = await fieldRegistry(companyId, exec);
  const flowIds = [...new Set(items.map((i) => i.flowId))];

  // Every operation reachable from this order's flows, once. The per-flow
  // required set is derived from these same rows, so a formula is parsed once
  // rather than once per item.
  const [ops] = await exec.query(
    `SELECT DISTINCT s.flow_id AS flowId, o.id AS operationId, o.name AS operationName,
            o.time_formula AS formula
       FROM fab_operation_flow_steps s
       JOIN fab_operations o ON o.id = s.operation_id AND o.deleted_at IS NULL
      WHERE s.company_id = ? AND s.flow_id IN (?) AND s.deleted_at IS NULL`,
    [companyId, flowIds],
  );

  const requiredByFlow = new Map(flowIds.map((f) => [f, new Set()]));
  const unknownByOp = new Map();
  const noFormula = [];
  for (const op of ops) {
    if (!op.formula || !String(op.formula).trim()) {
      if (!noFormula.some((n) => n.operationId === op.operationId)) {
        noFormula.push({ operationId: op.operationId, operationName: op.operationName });
      }
      continue;
    }
    for (const v of parseFormula(op.formula)?.variables ?? []) {
      if (!v.startsWith('item.')) continue;
      const key = v.slice(5);
      const def = registry.get(key);
      if (!def || !Number(def.formula_usable)) {
        // Unknown, or registered but not usable in a formula — both are the
        // author's problem and neither can ever be fixed by filling in a part.
        if (!unknownByOp.has(op.operationId)) {
          unknownByOp.set(op.operationId, { operationId: op.operationId, operationName: op.operationName, keys: new Set() });
        }
        unknownByOp.get(op.operationId).keys.add(key);
        continue;
      }
      requiredByFlow.get(op.flowId)?.add(key);
    }
  }

  const values = await resolveItemFields(companyId, items.map((i) => i.id), { conn: exec, registry });

  const missingValues = [];
  for (const item of items) {
    const need = [...(requiredByFlow.get(item.flowId) ?? [])];
    if (!need.length) continue;
    const have = values.get(item.id) ?? {};
    const missing = need.filter((k) => have[k] == null);
    if (missing.length) {
      missingValues.push({
        itemId: item.id, itemName: item.itemName, itemCode: item.itemCode,
        flowId: item.flowId, missing,
      });
    }
  }

  return {
    itemsChecked: items.length,
    itemsShort: missingValues.length,
    missingValues,
    unknownFields: [...unknownByOp.values()].map((u) => ({ ...u, keys: [...u.keys] })),
    noFormula,
  };
}
