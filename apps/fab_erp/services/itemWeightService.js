/**
 * itemWeightService.js — weight roll-up for one sales order's item tree.
 *
 * In fabrication nobody weighs an assembly. They weigh (or calculate from the
 * plate) the pieces it is cut from, and the assembly's weight is the sum. So
 * weight is entered only on the rows at the bottom of the tree and every level
 * above is derived:
 *
 *   effective(node) = node.unit_weight ?? computed_unit_weight(node)
 *   computed_unit_weight(node) = Σ over children of (child.qty × effective(child))
 *   total_weight(node) = effective(node) × node.qty
 *
 * `unit_weight` is only ever written by a human; `computed_unit_weight` and
 * `total_weight` are only ever written here. Keeping them apart is the whole
 * point — a fabricated assembly genuinely weighs more than its parts once you
 * add welds, bolts and paint, so an entered value must win, but the difference
 * has to stay visible rather than being silently absorbed. The UI reads both
 * and flags the gap.
 *
 * A node with no children and no entered weight stays NULL, not 0. Zero would
 * claim "this piece is weightless"; NULL correctly says "nobody has told us".
 * That distinction propagates: an assembly whose children are all unweighed
 * gets NULL, so a half-filled tree reports "unknown", never a false total.
 *
 * The effective unit weight is also mirrored into fab_item_metric_values under
 * the company's weight metric key (default 'unit_weight_kg'), because that is
 * what bufferService and the analytics page already join against to weigh WIP
 * sitting in a machine buffer. Without the mirror, entering weights here would
 * leave every buffer still falling back to counting pieces.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { weightFactorsForParts } from './materialMatchService.js';
import { isMaterialLink } from './itemMaterialService.js';
import { NOT_A_BLANK } from './blankPredicate.js';

/** The catalog ids among `rows` whose item is a BLANK (material_form='blank'). */
async function blankCatalogIds(exec, companyId, rows) {
  const ids = [...new Set(rows.map((r) => r.catalog_item_id).filter((v) => v != null).map(Number))];
  if (!ids.length) return new Set();
  const [cats] = await exec.query(
    `SELECT id FROM fab_item_catalog WHERE company_id = ? AND id IN (?) AND material_form = 'blank'`,
    [companyId, ids],
  );
  return new Set(cats.map((c) => Number(c.id)));
}
import { lineQtyMap, LINE_QTY_SQL } from './orderLineQty.js';

/** The metric key buffers/analytics default to (fab_buffers.weight_metric_key). */
const DEFAULT_WEIGHT_METRIC_KEY = 'unit_weight_kg';

/**
 * Weight of ONE piece: volume x density.
 *
 *   weight(kg) = volume(m3) x density_kg_m3
 *
 * and the volume comes from the dimensions, in one of two ways:
 *
 *   flat plate   thickness x width x length
 *                40 x 500 x 7500 mm x 7850 = 1177.5 kg   (matches their BOQ)
 *   profile      section_area_mm2 x length
 *                1898.09 mm2 x 1850 mm x 7850 = 27.565 kg (matches their BOQ)
 *
 * WHY A PROFILE CANNOT USE THICKNESS x WIDTH. An ISA 100x100x10 is an L: two
 * legs sharing a corner, ~1898 mm2 of steel. Treating it as a 10 x 100
 * rectangle counts one leg and loses the other — 14.52 kg instead of 27.57 on a
 * 1850 mm piece. The error is 47% and completely silent, because the number
 * that comes out still looks like a plausible weight. So anything that is not
 * flat carries its own cross-section and needs only a length.
 *
 * Both numbers live on the MATERIAL, never as constants here: a shop cutting
 * aluminium, stainless or a different profile has different figures and should
 * not need a code change to say so.
 *
 * Returns null rather than 0 when anything needed is missing — "nobody has told
 * us" and "this weighs nothing" have to stay distinguishable, or a half-filled
 * tree reports a confident zero.
 *
 * @returns {number|null} kg for one piece
 */
export function computeUnitWeight({ length, width, height }, material) {
  const density = material?.density_kg_m3 != null ? Number(material.density_kg_m3) : null;
  if (density === null || !Number.isFinite(density) || density <= 0) return null;

  const L = Number(length);
  if (!Number.isFinite(L) || L <= 0) return null;

  const area = material.section_area_mm2 != null ? Number(material.section_area_mm2) : null;
  let volumeMm3;

  if (area !== null && Number.isFinite(area) && area > 0) {
    volumeMm3 = area * L;
  } else {
    // Flat stock: needs all three. `height` carries thickness — the dimension
    // the BOQ column calls "Thick".
    const W = Number(width);
    const T = Number(height);
    if (!Number.isFinite(W) || W <= 0 || !Number.isFinite(T) || T <= 0) return null;
    volumeMm3 = T * W * L;
  }

  return (volumeMm3 / 1e9) * density; // mm3 -> m3, then x kg/m3
}

/** Decimal(18,6) — compare at that precision so float noise never causes a write. */
function sameNumber(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(Number(a) - Number(b)) < 1e-6;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recompute computed_unit_weight + total_weight for every item in one order.
 *
 * @param {number} companyId
 * @param {number} orderId
 * @param {import('mysql2/promise').Connection} [conn] join an open transaction
 * @returns {Promise<{updated:number, totalWeight:number|null, weighedItems:number, unweighedLeaves:number}>}
 */
export async function recomputeOrderWeights(companyId, orderId, conn) {
  const exec = conn ?? pool;

  const [rows] = await exec.query(
    `SELECT id, parent_item_id, qty, unit_weight, computed_unit_weight, total_weight,
            catalog_item_id, flow_id, node_kind, is_leaf, length, width, height, order_line_id
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );

  if (!rows.length) {
    return { updated: 0, totalWeight: null, weighedItems: 0, unweighedLeaves: 0 };
  }

  /**
   * A part's dimensions come from the FIELD REGISTRY, with the three legacy
   * columns as the fallback — not the other way round.
   *
   * Since fields v2 (2026-08-20) a part's thickness/width/length live in
   * fab_field_values and reach `fab_items.length/width/height` only through
   * the projection, which not every writer ran. The KEPL order is the proof:
   * 138 rows sized entirely through the registry, all three columns NULL, and
   * this roll-up read the columns — so 112 parts weighed nothing and the order
   * total was NULL while the registry could resolve every one of them.
   * Material links keep their column values: nesting writes the PLATE's size
   * there and no field describes it.
   */
  const structIds = rows.filter((r) => !isMaterialLink(r)).map((r) => r.id);
  let resolved = new Map();
  if (structIds.length) {
    const { resolveItemFields } = await import('./itemFieldService.js');
    const out = await resolveItemFields(companyId, structIds, { conn: exec });
    resolved = out instanceof Map ? out : new Map(Object.entries(out ?? {}).map(([k, v]) => [Number(k), v]));
  }
  // Weights DECLARED on the type (a bought part's catalog item), with their
  // provenance — `resolveItemFields` flattens to plain values, and the
  // provenance is what keeps this from reading back its own mirrored output.
  const declaredWeight = new Map(); // item id -> kg per piece, from a TYPE rung only
  if (structIds.length) {
    const { resolveFields } = await import('./fieldService.js');
    const rf = await resolveFields(companyId, structIds.map((id) => ({ scope: 'order_item', scopeId: id })), { conn: exec });
    for (const id of structIds) {
      const r = rf.get(`order_item:${id}`)?.unit_weight_kg;
      if (!r || r.value == null) continue;
      if (r.from?.scope === 'order_item' || r.from?.scope === 'order_line') continue;
      const n = Number(r.value);
      if (Number.isFinite(n) && n > 0) declaredWeight.set(id, n);
    }
  }
  const fieldNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const dimsOf = (r) => {
    const f = resolved.get(r.id) ?? {};
    return {
      length: fieldNum(f.length_mm) ?? r.length,
      width: fieldNum(f.width_mm) ?? r.width,
      height: fieldNum(f.thickness_mm) ?? r.height, // `height` carries thickness
    };
  };
  const hasAnyDim = (r) => { const d = dimsOf(r); return d.length != null || d.width != null || d.height != null; };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map();
  const roots = [];
  for (const r of rows) {
    // A parent that is soft-deleted (or belongs to another order) is not in this
    // set — treat such a row as a root so its subtree is still weighed rather
    // than silently dropped from the order total.
    if (r.parent_item_id != null && byId.has(r.parent_item_id)) {
      if (!childrenOf.has(r.parent_item_id)) childrenOf.set(r.parent_item_id, []);
      childrenOf.get(r.parent_item_id).push(r);
    } else {
      roots.push(r);
    }
  }

  // A part's weight comes from its OWN dimensions and the material it is cut
  // from — that is how the shop's BOQ has always worked it out. The material is
  // reached through the part's raw-material child, which is the same link the
  // task gate reads.
  const materialOf = new Map(); // part id -> catalog row with the weight factor
  const rmChildIds = rows.filter(isMaterialLink);
  if (rmChildIds.length) {
    const catIds = [...new Set(rmChildIds.map((r) => r.catalog_item_id))];
    const [cats] = await exec.query(
      `SELECT id, density_kg_m3, section_area_mm2 FROM fab_item_catalog
        WHERE company_id = ? AND id IN (?)`,
      [companyId, catIds],
    );
    const catById = new Map(cats.map((c) => [c.id, c]));
    for (const rm of rmChildIds) {
      const cat = catById.get(rm.catalog_item_id);
      if (!cat) continue;
      // The link row IS a piece of that material, so it weighs itself — its
      // dimensions are the plate's, set by the nesting sheet.
      materialOf.set(rm.id, cat);
      // …and it also tells the part above it what that part is cut from.
      if (rm.parent_item_id != null && !materialOf.has(rm.parent_item_id)) {
        materialOf.set(rm.parent_item_id, cat);
      }
    }
  }

  /**
   * PARTS NOT YET NESTED get their density from their SPECIFICATION.
   *
   * The link above only exists once somebody has chosen a plate, and choosing a
   * plate is nesting's job — so between BOM import and nesting there is no link
   * to read a density from. Without this, every part in that window weighs
   * nothing: a 668 MT order reports as zero until it is nested, and procurement
   * quantities and progress percentages are computed off that number.
   *
   * The lookup is not a second source of truth. Density is a property of the
   * MATERIAL — every MS plate is 7850 kg/m³ whatever size it is cut to — so this
   * reads the same catalogue nesting will pick from, keyed on the three axes the
   * part states. Where a link DOES exist it wins, because then the material is
   * settled rather than inferred.
   *
   * ONLY CHILDLESS ROWS, and that restriction is load-bearing rather than
   * tidiness. Below, a row's own dimensions BEAT the sum of its children — the
   * BOQ way of working out a part. Hand an assembly a density and a girder with
   * an overall length would be weighed as a solid block of steel instead of as
   * the sum of the plates it is welded from, which is both wrong and plausible
   * enough to go unnoticed. A leaf is the only row whose dimensions describe
   * steel rather than an envelope. (A part that HAS been nested already has a
   * child — the material link — so this targets exactly the un-nested ones.)
   *
   * NOT `catalog_item_id == null` — a part row carries a catalog item too, now
   * that every order row names its type. Testing for the absence of one would
   * exclude every real part and this fallback would never fire at all.
   */
  const unlinked = rows.filter((r) => !isMaterialLink(r) && !materialOf.has(r.id)
    && !childrenOf.has(r.id)
    && hasAnyDim(r));
  if (unlinked.length) {
    const factors = await weightFactorsForParts(companyId, unlinked.map((r) => r.id), { conn: exec });
    for (const r of unlinked) {
      const f = factors.get(r.id);
      if (!f || f.density == null) continue;
      materialOf.set(r.id, { density_kg_m3: f.density, section_area_mm2: f.sectionArea });
    }
  }

  const effective = new Map(); // id -> number|null
  const computed  = new Map(); // id -> number|null
  let unweighedLeaves = 0;

  // Iterative post-order. The tree is user-built and can be deep (the UI caps
  // display at 12 levels but nothing caps the data), so recursion is avoided.
  // `seen` also makes a cycle — which parent_item_id allows structurally —
  // terminate instead of hanging the request.
  const seen = new Set();
  for (const root of roots) {
    const stack = [{ node: root, visited: false }];
    while (stack.length) {
      const frame = stack.pop();
      const { node } = frame;

      if (!frame.visited) {
        if (seen.has(node.id)) {
          logger.warn({ companyId, orderId, itemId: node.id }, 'fab_erp: cycle in fab_items parent chain — subtree skipped in weight roll-up');
          continue;
        }
        seen.add(node.id);
        stack.push({ node, visited: true });
        for (const child of childrenOf.get(node.id) ?? []) {
          stack.push({ node: child, visited: false });
        }
        continue;
      }

      // children are resolved by now
      const kids = childrenOf.get(node.id) ?? [];
      let childSum = null;
      for (const child of kids) {
        // A raw-material child is the STOCK this part is cut from, not a
        // component of it — and since nesting gave those rows the plate's own
        // dimensions, they now carry a real weight. Summing it would say a
        // 1.2 t flange weighs the 4.7 t plate it came off.
        if (isMaterialLink(child)) continue;
        const childEff = effective.get(child.id);
        if (childEff === null || childEff === undefined) continue;
        const childQty = toNum(child.qty) ?? 0;
        childSum = (childSum ?? 0) + childEff * childQty;
      }

      // Three sources, in this order:
      //   1. a figure a human typed — always wins, it is someone's judgement
      //   2. this row's own dimensions x its material's factor — the BOQ way
      //   3. the sum of what is underneath — for assemblies, which have no
      //      dimensions of their own
      // Dimensions beat the child sum because a part's raw-material child is
      // the stock it is cut FROM, not a component of it: a 1177 kg flange cut
      // from a plate does not weigh the plate.
      const fromDims = computeUnitWeight(isMaterialLink(node) ? node : dimsOf(node), materialOf.get(node.id));
      // 2b. a weight declared on the TYPE — a bought part (a shear stud) has no
      //     dimensions to compute from and no children; its weight lives on the
      //     catalog item. Only TYPE rungs count here: a value at order_item scope
      //     is this roll-up's own earlier output mirrored into the registry, and
      //     reading it back would freeze a stale figure.
      const typeDeclared = declaredWeight.get(node.id) ?? null;
      const derived = fromDims !== null ? fromDims : (typeDeclared !== null ? typeDeclared : childSum);
      computed.set(node.id, derived);

      const entered = toNum(node.unit_weight);
      const eff = entered !== null ? entered : derived;
      effective.set(node.id, eff);

      // A raw-material link (catalog item, no flow) is not something anyone
      // types a weight on — the plate is bought by the tonne and the weight
      // that matters is the cut part's, which sits on the row above. Counting
      // these would report every properly-filled order as incomplete.
      const isRmLink = isMaterialLink(node);
      /**
       * `is_leaf` DECIDES, not "has no tree children".
       *
       * The two agreed while every part hung under its assembly. Consolidation
       * moved identical parts onto the order line, so a diaphragm has no
       * children and was counted here as a bottom-level row with no weight —
       * 174 of them on the KEPL order, under a banner reading "this total is
       * incomplete" when the total was exactly right.
       *
       * An assembly weighs what its parts weigh, and its parts are now reached
       * through fab_item_demand. `is_leaf` already knows that.
       */
      const isLeaf = Number(node.is_leaf) === 1;
      // A part whose only children are its material links is still a leaf —
      // the plate under it is what it is cut from, not something it is made of.
      const hasStructureKids = kids.some((k) => !isMaterialLink(k));
      if (isLeaf && !hasStructureKids && eff === null && !isRmLink) unweighedLeaves++;
    }
  }

  // ── persist only what actually changed ─────────────────────────────────────
  let updated = 0;
  let weighedItems = 0;
  const metricPairs = [];

  for (const r of rows) {
    const newComputed = computed.has(r.id) ? computed.get(r.id) : null;
    const eff = effective.has(r.id) ? effective.get(r.id) : null;
    const qty = toNum(r.qty) ?? 0;
    const newTotal = eff === null ? null : eff * qty;

    if (eff !== null) {
      weighedItems++;
      metricPairs.push([r.id, eff]);
    }

    if (sameNumber(toNum(r.computed_unit_weight), newComputed)
      && sameNumber(toNum(r.total_weight), newTotal)) {
      continue;
    }
    await exec.query(
      `UPDATE fab_items SET computed_unit_weight = ?, total_weight = ?
        WHERE id = ? AND company_id = ?`,
      [newComputed, newTotal, r.id, companyId],
    );
    updated++;
  }

  await syncWeightMetrics(exec, companyId, rows.map((r) => r.id), metricPairs);
  await purgeMetricsForDeletedItems(exec, companyId, orderId);

  // Order total = the roots only, each multiplied by the qty of the LINE it
  // hangs under (User Clarifications 3) — `root.qty` itself never carries this,
  // it stays 1. Summing every row (rather than just roots) would count each
  // piece once per level it appears under; this is the one place that also
  // brings the line's own multiplier into the total.
  //
  // BLANK rows are roots too (a blank hangs off the order, not off a part) and
  // since blanks carry a density they weigh themselves. They are the SAME steel
  // as the parts cut from them, so counting them here doubled the KEPL order
  // (1,317 t against 669 t) the moment its blanks got a density. Skip them.
  const lineQty = await lineQtyMap(exec, companyId, orderId);
  const blankCatIds = await blankCatalogIds(exec, companyId, rows);
  let totalWeight = null;
  for (const root of roots) {
    if (blankCatIds.has(Number(root.catalog_item_id))) continue;
    const eff = effective.get(root.id);
    if (eff === null || eff === undefined) continue;
    const mult = lineQty.get(root.order_line_id == null ? null : Number(root.order_line_id)) ?? 1;
    totalWeight = (totalWeight ?? 0) + eff * (toNum(root.qty) ?? 0) * mult;
  }

  return { updated, totalWeight, weighedItems, unweighedLeaves };
}

/**
 * Mirror effective unit weights into fab_item_metric_values so machine buffers
 * and the analytics page can weigh WIP. Rows whose weight became unknown have
 * their metric row soft-deleted rather than set to 0 — see the module note on
 * why NULL and 0 are not the same thing here.
 *
 * NOT multiplied by line qty (EU-5). `metricPairs` carries `effective` — the
 * weight of ONE physical piece of this design row — because a buffer holds
 * discrete physical pieces and weighs whichever ones are actually sitting in
 * it; the order line's qty says how many such pieces exist across the whole
 * order, not how heavy any one of them is. Multiplying here would report every
 * piece of a qty-3 line as three times its real weight.
 */
async function syncWeightMetrics(exec, companyId, allItemIds, metricPairs) {
  if (!allItemIds.length) return;

  const [existing] = await exec.query(
    `SELECT id, item_id, metric_value FROM fab_item_metric_values
      WHERE company_id = ? AND metric_key = ? AND deleted_at IS NULL AND item_id IN (?)`,
    [companyId, DEFAULT_WEIGHT_METRIC_KEY, allItemIds],
  );
  const existingByItem = new Map(existing.map((e) => [e.item_id, e]));
  const wanted = new Map(metricPairs);

  for (const [itemId, value] of wanted) {
    const row = existingByItem.get(itemId);
    if (!row) {
      await exec.query(
        `INSERT INTO fab_item_metric_values (company_id, item_id, metric_key, metric_value)
         VALUES (?, ?, ?, ?)`,
        [companyId, itemId, DEFAULT_WEIGHT_METRIC_KEY, value],
      );
    } else if (!sameNumber(toNum(row.metric_value), value)) {
      await exec.query(
        'UPDATE fab_item_metric_values SET metric_value = ? WHERE id = ? AND company_id = ?',
        [value, row.id, companyId],
      );
    }
  }

  const stale = existing.filter((e) => !wanted.has(e.item_id)).map((e) => e.id);
  if (stale.length) {
    await exec.query(
      'UPDATE fab_item_metric_values SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)',
      [companyId, stale],
    );
  }
}

/**
 * Drop weight metrics belonging to items that have since been soft-deleted.
 *
 * syncWeightMetrics only ever sees the order's *live* rows, so without this a
 * replace-mode import would leave the old tree's metric rows behind and they
 * would accumulate on every re-upload. Written as a sweep over the order rather
 * than a list passed in by the caller, so it self-heals regardless of how the
 * items were deleted — the tree can also be pruned a row at a time from the UI.
 * Scoped to this service's own metric key; nothing else here owns metrics.
 */
async function purgeMetricsForDeletedItems(exec, companyId, orderId) {
  await exec.query(
    `UPDATE fab_item_metric_values v
       JOIN fab_items i ON i.id = v.item_id AND i.company_id = v.company_id
        SET v.deleted_at = NOW()
      WHERE v.company_id = ? AND v.metric_key = ? AND v.deleted_at IS NULL
        AND i.order_id = ? AND i.deleted_at IS NOT NULL`,
    [companyId, DEFAULT_WEIGHT_METRIC_KEY, orderId],
  );
}

/**
 * Order total without recomputing — a plain SUM over the roots, for list views.
 *
 * Each root's `total_weight` is multiplied by the qty of the line it hangs
 * under (User Clarifications 3), the same as `recomputeOrderWeights`'s own
 * total — a list view and the detail page must never disagree about tonnage.
 * (No caller currently reaches this export; fixed anyway so the next one does
 * not inherit a total that is quietly missing the line multiplier.)
 *
 * @returns {Promise<number|null>} null when nothing in the order has a weight yet
 */
export async function orderTotalWeight(companyId, orderId, conn) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT fi.total_weight AS totalWeight, ${LINE_QTY_SQL} AS lineQty
       FROM fab_items fi
       LEFT JOIN fab_order_lines fol ON fol.id = fi.order_line_id AND fol.deleted_at IS NULL
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.parent_item_id IS NULL AND fi.deleted_at IS NULL
        AND ${NOT_A_BLANK('fi')}`,
    [companyId, orderId],
  );
  let total = null;
  let weighed = 0;
  for (const r of rows) {
    if (r.totalWeight == null) continue;
    weighed += 1;
    total = (total ?? 0) + Number(r.totalWeight) * Number(r.lineQty);
  }
  return weighed > 0 ? total : null;
}
