/**
 * local-order-fixture.mjs — ONE representative sales order for local fab_erp
 * work, code-named LOCAL-FIXTURE-01, built by calling the real wizard
 * services rather than writing SQL, so it breaks loudly if a later EU changes
 * a service's signature.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * Local sqldb had, as of 2026-09-13, zero `fab_items` rows with
 * `nest_no IS NOT NULL` — nothing local exercised the nesting contract (the
 * "qty on a link means pieces" decision) at all, and every existing local
 * order line has qty=1, so decision 3 (line qty multiplies the roll-ups) had
 * nothing to prove either. This builds one order with both: a qty-3 line, and
 * an accepted nested plan with parts genuinely sharing a plate.
 *
 * ── WHY THIS MODULE DOES NOT USE ctx.conn FOR THE ORDER ITSELF ──────────────
 * `_runner.mjs` wraps modules 01-07 in one shared transaction on `ctx.conn`.
 * This module cannot join that: `blankPlanService.blankPlan`,
 * `productionPlanService.raiseDraft/productionPlan` and
 * `orderReadinessService.refreshOrderStage` all read/write through the pool
 * directly and take no connection parameter, so if the structure this module
 * builds were still uncommitted on `ctx.conn`, those calls would see an empty
 * order. So `--apply` here commits one wizard step at a time, exactly the way
 * a person clicking through the real wizard would, and every service is
 * called the same way its route calls it (2-3 args, no shared connection).
 * `ctx.conn` is used only for the read-only company existence check `_runner`
 * already did; everything this module writes goes through the imported
 * services or a plain `pool.query`.
 *
 * ── EVERYTHING IS LOOKED UP BY CODE, PER THE RUNNER'S CONTRACT ──────────────
 * No catalog item id, flow id or field id is hardcoded — all of it is read
 * back by (company_id, code) / (company_id, field_key) so this module stays
 * correct if ids ever differ between environments.
 *
 * ── THREE LOCAL GAPS THIS MODULE WORKS AROUND ───────────────────────────────
 * Found while tracing what `blankService.acceptNestingPlan` and
 * `blankService.orderBlanks` actually need, none of which existed locally:
 *
 *   1. `fab_fields` had no `material` field at all (field_key='material').
 *      `setItemSpecHandler`/`orderBlanks` read/write it verbatim, so a part
 *      can never be judged "has material" without it. Created here, scoped to
 *      the narrowest place it is actually set (`order_item`), which is what
 *      lets it also be set at any broader rung (`order_line`, `catalog_item`,
 *      …) per `fieldLadder.mayHoldValue`.
 *   2. `fab_fields.grade` existed but with `applies_at='catalog_item'` — that
 *      makes `order_item`/`order_line` a NARROWER rung than the field allows,
 *      so `setFields` would refuse every write the BOQ's "Material + Grade
 *      columns, blank = inherit from the line" design (ARCHITECTURE §13,
 *      "The material link is now an OUTPUT of nesting") depends on. Widened
 *      to `order_item` (broadest-allowed, same as `material`) rather than
 *      left narrow — nothing reads `grade` at a narrower rung than
 *      `order_item`, so this cannot make an existing read ambiguous.
 *   3. No `fab_operation_flows` row anywhere locally has
 *      `code = blankService.CUTTING_FLOW_CODE` ('C0001').
 *      `acceptNestingPlan` hard-refuses without one ("No cutting flow…").
 *      Created here as a single-step flow on the existing `Cut` operation —
 *      the same operation `PARTPL`/`PARTDR` already use for their own first
 *      step — with `Cut`'s own default resource type, so cutting tasks get a
 *      real formula (references `input.raw_material.thickness_mm`, which a
 *      blank's own link will carry) instead of a bare stand-in.
 *
 * All three are additive, natural-keyed and idempotent: nothing that already
 * has a value is touched, and re-running finds what it wrote and does
 * nothing.
 *
 * ── THE FIXTURE ──────────────────────────────────────────────────────────────
 * Two lines under one COMPOS-SPAN (Composite Girder) template — qty 1 and
 * qty 3 — each built as ONE hand-written tree (via `bomService.buildFromTree`,
 * not `instantiate`, because the "assembly row with qty > 1" the plan asks
 * for is not something the template's own BOM lines produce: every BOM line
 * under Composite Girder explodes, so a hand-built tree is the only way to
 * get a Girder row that IS an assembly (it has a Segment child) and still
 * carries qty=3 on one row):
 *
 *   Span (qty 1, depth 0)
 *     Girder (qty 3, depth 1)             <- the assembly row with qty > 1
 *       Segment (qty 1, depth 2, flow=SEG)
 *         Top Flange              (depth 3, qty 1, 16mm, flow=PARTPL)
 *         Web Plate               (depth 3, qty 1, 12mm, flow=PARTPL)
 *         Bottom Flange           (depth 3, qty 1, 20mm, flow=PARTPL)
 *         Bearing Stiffener Plain (depth 3, qty 2, 12mm, flow=PARTPL)
 *         Bearing Stiffener Hole  (depth 3, qty 1, 12mm, flow=PARTDR, holes=4)
 *         Intermediate Stiff. Plain (depth 3, qty 4, 12mm, flow=PARTPL)
 *         Intermediate Stiff. Hole  (depth 3, qty 2, 12mm, flow=PARTDR, holes=2)
 *
 * Four depths (0-3), one qty>1 assembly, seven leaf parts (>= 6). The five
 * 12mm/E350 BO/MS parts are deliberately the same steel so
 * `blankPlanService`'s grouping-by-(thickness,grade,material) puts them in
 * one packing group, and deliberately different per-row qty (1/2/1/4/2, each
 * x3 for the Girder's own qty) so that when the packer mixes two of those
 * shapes onto one physical sheet, the two link rows the sheet produces read
 * different `qty` — the shape decision 1 is about. Bearing/Intermediate
 * "Plain" and "Hole" share an identical rectangle, so `orderBlanks` merges
 * them into ONE blank demand line (by design — same steel, same size, same
 * plate), which is a second, even more direct way the same fact shows up.
 *
 * Dimensions, material/grade and the weld/hole fields every flow's formulas
 * reference are all set through `orderParametersService.setParameters` (never
 * through `buildFromTree`'s own `dims`, which writes `fab_field_values`
 * directly and skips `fieldProjection`'s copy into the legacy
 * `fab_items.length/width/height` columns that `itemWeightService` reads) —
 * this is also why the Parameters step (not the BOM step) is where a real
 * wizard fills them in.
 *
 * The order is left `status='draft'` throughout (§13 "A draft sales order
 * means 'still in the wizard'") — a fabrication and a cutting production
 * order ARE raised (so tasks and computed hours exist to snapshot), which is
 * exactly what the real wizard's Production step does before Confirm, and
 * confirming is deliberately left for a human in EU-21.
 */

import { pool } from '../../db.js';
import { fieldRegistry, setFields } from '../../apps/fab_erp/services/fieldService.js';
import { buildFromTree } from '../../apps/fab_erp/services/bomService.js';
import { setParameters } from '../../apps/fab_erp/services/orderParametersService.js';
import { recomputeOrderWeights } from '../../apps/fab_erp/services/itemWeightService.js';
import { blankPlan } from '../../apps/fab_erp/services/blankPlanService.js';
import { acceptNestingPlan } from '../../apps/fab_erp/services/blankService.js';
import { raiseDraft } from '../../apps/fab_erp/services/productionPlanService.js';
import { refreshOrderStage } from '../../apps/fab_erp/services/orderReadinessService.js';

export const NAME = 'Local fixture order (LOCAL-FIXTURE-01)';

const ORDER_NUMBER = 'LOCAL-FIXTURE-01';
const CUTTING_FLOW_CODE = 'C0001'; // must match blankService.CUTTING_FLOW_CODE
const STEEL = { material: 'MS', grade: 'E350 BO' };

/** One leaf part spec. `qty` is the row's OWN qty (siblings under the same Segment). */
const LEAF_PARTS = [
  { code: 'COMPOS-TF', qty: 1, length: 8000, width: 400, thickness: 16, flow: 'PARTPL' },
  { code: 'COMPOS-WP', qty: 1, length: 8000, width: 1200, thickness: 12, flow: 'PARTPL' },
  { code: 'COMPOS-BF', qty: 1, length: 8000, width: 450, thickness: 20, flow: 'PARTPL' },
  { code: 'COMPOS-BS', qty: 2, length: 300, width: 250, thickness: 12, flow: 'PARTPL' },
  {
    code: 'COMPOS-BS-D', qty: 1, length: 300, width: 250, thickness: 12, flow: 'PARTDR', holes: 4,
  },
  { code: 'COMPOS-IS', qty: 4, length: 300, width: 150, thickness: 12, flow: 'PARTPL' },
  {
    code: 'COMPOS-IS-D', qty: 2, length: 300, width: 150, thickness: 12, flow: 'PARTDR', holes: 2,
  },
];

const CATALOG_CODES = ['COMPOS-SPAN', 'COMPOS-GDR', 'COMPOS-SEG', ...LEAF_PARTS.map((p) => p.code)];
const FLOW_CODES = ['PARTPL', 'PARTDR', 'SEG'];

/** Two lines: code, qty. The qty-3 line is the whole point (decision 3). */
const LINES = [
  { code: 'LF-1', qty: 1 },
  { code: 'LF-3', qty: 3 },
];

async function ensureMaterialField(apply, log) {
  const [[existing]] = await pool.query(
    "SELECT id, applies_at FROM fab_fields WHERE company_id = ? AND field_key = 'material' AND deleted_at IS NULL",
    [6],
  );
  if (existing) return { created: false };
  log("field 'material' (field_key='material', applies_at='order_item') does not exist — creating");
  if (!apply) return { created: true, dryRun: true };
  await pool.query(
    `INSERT INTO fab_fields
       (company_id, field_key, label, data_type, applies_at, formula_usable, is_standard, active)
     VALUES (?, 'material', 'Material', 'text', 'order_item', 1, 0, 1)
     ON DUPLICATE KEY UPDATE field_key = field_key`,
    [6],
  );
  return { created: true };
}

async function ensureGradeFieldScope(apply, log) {
  const [[existing]] = await pool.query(
    "SELECT id, applies_at FROM fab_fields WHERE company_id = ? AND field_key = 'grade' AND deleted_at IS NULL",
    [6],
  );
  if (!existing) {
    log("field 'grade' does not exist at all — this is a bigger local gap than this fixture "
      + 'script is willing to paper over; creating it fresh at order_item scope');
    if (!apply) return { created: true, dryRun: true };
    await pool.query(
      `INSERT INTO fab_fields
         (company_id, field_key, label, data_type, applies_at, formula_usable, is_standard, active)
       VALUES (?, 'grade', 'Grade', 'text', 'order_item', 1, 0, 1)
       ON DUPLICATE KEY UPDATE field_key = field_key`,
      [6],
    );
    return { created: true };
  }
  if (existing.applies_at === 'order_item') return { widened: false };
  log(`field 'grade' has applies_at='${existing.applies_at}' — widening to 'order_item' so `
    + 'order_line/order_item specs can hold it (fieldLadder.mayHoldValue refuses narrower-than-applies_at)');
  if (!apply) return { widened: true, dryRun: true };
  await pool.query(
    "UPDATE fab_fields SET applies_at = 'order_item' WHERE id = ?",
    [existing.id],
  );
  return { widened: true };
}

async function ensureBlankGroup(apply, log) {
  // Natural key mirrors blankService.js's own lookup: (company, category name,
  // group name) — BLANK_CATEGORY='Raw Materials' (already seeded onto every
  // company by init.sql), BLANK_GROUP='Blanks' (not seeded anywhere locally;
  // `materialiseBlanks` hard-refuses without it).
  const [[existing]] = await pool.query(
    `SELECT g.id FROM fab_item_groups g
       JOIN fab_item_categories c ON c.id = g.category_id
      WHERE g.company_id = ? AND g.deleted_at IS NULL AND g.name = 'Blanks' AND c.name = 'Raw Materials'`,
    [6],
  );
  if (existing) return { created: false };
  const [[cat]] = await pool.query(
    "SELECT id FROM fab_item_categories WHERE company_id = ? AND name = 'Raw Materials' AND deleted_at IS NULL",
    [6],
  );
  if (!cat) {
    const e = new Error('No "Raw Materials" category locally — init.sql should have seeded it onto every company.');
    e.status = 400; throw e;
  }
  log('group "Raw Materials > Blanks" does not exist — creating (materialiseBlanks files every cut blank under it)');
  if (!apply) return { created: true, dryRun: true };
  await pool.query(
    `INSERT INTO fab_item_groups (company_id, category_id, name, code, description, is_system)
     VALUES (?, ?, 'Blanks', 'BLANKS', 'Rectangles cut from plate before fabrication — one subgroup per order, minted by blankService.materialiseBlanks.', 0)
     ON DUPLICATE KEY UPDATE name = name`,
    [6, cat.id],
  );
  return { created: true };
}

async function ensureCuttingFlow(apply, log) {
  const [[existing]] = await pool.query(
    'SELECT id FROM fab_operation_flows WHERE company_id = ? AND code = ? AND deleted_at IS NULL',
    [6, CUTTING_FLOW_CODE],
  );
  if (existing) return { created: false, flowId: existing.id };

  const [[cutOp]] = await pool.query(
    "SELECT id, default_resource_type_id FROM fab_operations WHERE company_id = ? AND code = 'Cut' AND deleted_at IS NULL LIMIT 1",
    [6],
  );
  if (!cutOp) {
    const e = new Error("No 'Cut' operation exists locally — cannot mint the cutting flow. Run scripts/seed/04-shopfloor.mjs first.");
    e.status = 400; throw e;
  }
  log(`flow '${CUTTING_FLOW_CODE}' (cutting) does not exist — creating one Cut step on operation #${cutOp.id}`);
  if (!apply) return { created: true, dryRun: true };

  const [ins] = await pool.query(
    `INSERT INTO fab_operation_flows (company_id, name, code, active, description)
     VALUES (?, 'Cutting — Plate to Blank', ?, 1, 'Cuts a nested plate into its blanks. Minted locally by local-order-fixture.mjs; production has this already.')`,
    [6, CUTTING_FLOW_CODE],
  );
  await pool.query(
    `INSERT INTO fab_operation_flow_steps
       (company_id, flow_id, operation_id, seq_no, depends_on, resource_type_id, notes)
     VALUES (?, ?, ?, 1, NULL, ?, 'Marking & cutting the nest into its blanks')`,
    [6, ins.insertId, cutOp.id, cutOp.default_resource_type_id ?? null],
  );
  return { created: true, flowId: ins.insertId };
}

async function codeMap(companyId, codes) {
  const [rows] = await pool.query(
    'SELECT id, code FROM fab_item_catalog WHERE company_id = ? AND code IN (?) AND deleted_at IS NULL',
    [companyId, codes],
  );
  const map = new Map(rows.map((r) => [r.code, r.id]));
  const missing = codes.filter((c) => !map.has(c));
  if (missing.length) {
    const e = new Error(`Missing catalog item(s) locally: ${missing.join(', ')}. `
      + 'Run scripts/seed/03-structures.mjs (Composite Girder) first.');
    e.status = 400; throw e;
  }
  return map;
}

async function flowMap(companyId, codes) {
  const [rows] = await pool.query(
    'SELECT id, code FROM fab_operation_flows WHERE company_id = ? AND code IN (?) AND deleted_at IS NULL',
    [companyId, codes],
  );
  const map = new Map(rows.map((r) => [r.code, r.id]));
  const missing = codes.filter((c) => !map.has(c));
  if (missing.length) {
    const e = new Error(`Missing flow(s) locally: ${missing.join(', ')}. Run scripts/seed/04-shopfloor.mjs first.`);
    e.status = 400; throw e;
  }
  return map;
}

/** The hand-built tree — see the module header for why this is not `expand()`/`instantiate`. */
function buildTree(catalogIds, flowIds) {
  return {
    catalogItemId: catalogIds.get('COMPOS-SPAN'),
    name: 'Span',
    qty: 1,
    children: [
      {
        catalogItemId: catalogIds.get('COMPOS-GDR'),
        name: 'Girder G1',
        qty: 3, // <- the assembly row with qty > 1 (decision-1 shape)
        children: [
          {
            catalogItemId: catalogIds.get('COMPOS-SEG'),
            name: 'Segment',
            qty: 1,
            defaultFlowId: flowIds.get('SEG'),
            children: LEAF_PARTS.map((p) => ({
              catalogItemId: catalogIds.get(p.code),
              name: p.code,
              qty: p.qty,
              defaultFlowId: flowIds.get(p.flow),
            })),
          },
        ],
      },
    ],
  };
}

async function existingOrder() {
  const [[order]] = await pool.query(
    "SELECT id, status, wizard_step FROM fab_orders WHERE company_id = ? AND order_number = ? AND order_type = 'sales' AND deleted_at IS NULL",
    [6, ORDER_NUMBER],
  );
  return order ?? null;
}

async function ensureOrder(apply, log) {
  const existing = await existingOrder();
  if (existing) return { id: existing.id, created: false };
  log(`sales order '${ORDER_NUMBER}' does not exist — creating (status=draft)`);
  if (!apply) return { id: null, created: true, dryRun: true };
  const [ins] = await pool.query(
    `INSERT INTO fab_orders (company_id, order_number, order_type, status, notes, created_at)
     VALUES (?, ?, 'sales', 'draft', 'EU-2 local fixture — exercises the nesting + qty>1-line contracts. Left draft on purpose.', NOW())`,
    [6, ORDER_NUMBER],
  );
  return { id: ins.insertId, created: true };
}

async function ensureLines(orderId, spanCatalogId, apply, log) {
  const out = [];
  for (const line of LINES) {
    const [[existing]] = await pool.query(
      'SELECT id FROM fab_order_lines WHERE company_id = ? AND order_id = ? AND code = ? AND deleted_at IS NULL',
      [6, orderId, line.code],
    );
    if (existing) { out.push({ ...line, id: existing.id, created: false }); continue; }
    log(`order line '${line.code}' (qty ${line.qty}) does not exist — creating`);
    if (!apply) { out.push({ ...line, id: null, created: true, dryRun: true }); continue; }
    const [ins] = await pool.query(
      `INSERT INTO fab_order_lines
         (company_id, order_id, line_no, code, description, qty, unit, line_type, catalog_item_id)
       VALUES (?, ?, ?, ?, ?, ?, 'nos', 'Composite Girder', ?)`,
      [6, orderId, LINES.indexOf(line) + 1, line.code,
        `LOCAL-FIXTURE-01 line ${line.code} (qty ${line.qty})`, line.qty, spanCatalogId],
    );
    out.push({ ...line, id: ins.insertId, created: true });
  }
  return out;
}

async function lineHasStructure(orderId, orderLineId) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) AS n FROM fab_items WHERE company_id = ? AND order_id = ? AND order_line_id = ? AND deleted_at IS NULL AND node_kind = 'structure'",
    [6, orderId, orderLineId],
  );
  return row.n > 0;
}

/** Every leaf item on the order (any line), by its own catalog code. */
async function leafItemsByCode(orderId) {
  const [rows] = await pool.query(
    `SELECT i.id, i.order_line_id AS orderLineId, c.code AS catalogCode
       FROM fab_items i JOIN fab_item_catalog c ON c.id = i.catalog_item_id
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.node_kind = 'structure' AND i.is_leaf = 1`,
    [6, orderId],
  );
  return rows;
}

async function segmentItems(orderId) {
  const [rows] = await pool.query(
    `SELECT i.id, i.order_line_id AS orderLineId
       FROM fab_items i JOIN fab_item_catalog c ON c.id = i.catalog_item_id
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND c.code = 'COMPOS-SEG'`,
    [6, orderId],
  );
  return rows;
}

export async function seed(ctx) {
  const { companyId, apply, log } = ctx;
  if (Number(companyId) !== 6) {
    log(`local-order-fixture.mjs is written specifically for company 6 (Placebo) — skipping for company ${companyId}`);
    return { skipped: 1 };
  }

  const counts = {
    fieldsFixed: 0, flowsCreated: 0, ordersCreated: 0, linesCreated: 0,
    structuresBuilt: 0, itemsParameterised: 0, nested: 0, productionRaised: 0,
  };

  // ── stage 0: local config gaps ───────────────────────────────────────────
  const mat = await ensureMaterialField(apply, log);
  if (mat.created) counts.fieldsFixed += 1;
  const grade = await ensureGradeFieldScope(apply, log);
  if (grade.created || grade.widened) counts.fieldsFixed += 1;
  const blankGroup = await ensureBlankGroup(apply, log);
  if (blankGroup.created) counts.fieldsFixed += 1;
  const flow = await ensureCuttingFlow(apply, log);
  if (flow.created) counts.flowsCreated += 1;

  if (!apply) {
    // A dry run cannot see past this point without risking a half-applied
    // read against config that was never written — report the shape only.
    log('dry run — stopping after the config-gap check. Re-run with --apply to build the order.');
    return counts;
  }

  const catalogIds = await codeMap(companyId, CATALOG_CODES);
  const flowIds = await flowMap(companyId, FLOW_CODES);

  // ── stage 1: the order + its two lines ───────────────────────────────────
  const order = await ensureOrder(apply, log);
  if (order.created) counts.ordersCreated += 1;
  const orderId = order.id;

  const lines = await ensureLines(orderId, catalogIds.get('COMPOS-SPAN'), apply, log);
  counts.linesCreated += lines.filter((l) => l.created).length;

  // ── stage 2: structure per line (buildFromTree — see header) ────────────
  for (const line of lines) {
    if (await lineHasStructure(orderId, line.id)) {
      log(`line ${line.code}: structure already built — skipping`);
      continue;
    }
    log(`line ${line.code}: building structure`);
    const tree = buildTree(catalogIds, flowIds);
    await buildFromTree(companyId, { orderId, orderLineId: line.id, tree });
    counts.structuresBuilt += 1;
  }

  // ── stage 3: parameters — dims, material/grade, weld/hole fields ────────
  const leaves = await leafItemsByCode(orderId);
  const byCode = new Map(LEAF_PARTS.map((p) => [p.code, p]));
  const edits = [];
  for (const item of leaves) {
    const spec = byCode.get(item.catalogCode);
    if (!spec) continue; // Segment/Girder/Span are not leaves; never matched here anyway
    edits.push(
      { itemId: item.id, fieldKey: 'length_mm', value: spec.length },
      { itemId: item.id, fieldKey: 'width_mm', value: spec.width },
      { itemId: item.id, fieldKey: 'thickness_mm', value: spec.thickness },
      { itemId: item.id, fieldKey: 'material', value: STEEL.material },
      { itemId: item.id, fieldKey: 'grade', value: STEEL.grade },
    );
    if (spec.holes) edits.push({ itemId: item.id, fieldKey: 'num_holes', value: spec.holes });
  }
  const segments = await segmentItems(orderId);
  for (const seg of segments) {
    // An assembly's own weld run — a real attribute of "how this segment is
    // stitched together", not something geometry derives.
    edits.push({ itemId: seg.id, fieldKey: 'weld_length_m', value: 42 });
  }
  if (edits.length) {
    const res = await setParameters(companyId, orderId, edits);
    if (res.rejected?.length) {
      log(`setParameters rejected ${res.rejected.length} edit(s): ${JSON.stringify(res.rejected).slice(0, 500)}`);
    }
    counts.itemsParameterised = res.itemsTouched;
  }
  await refreshOrderStage(companyId, orderId);

  // ── stage 4: weights (pre-nesting — un-nested parts weigh off their spec) ─
  await recomputeOrderWeights(companyId, orderId);

  // ── stage 5: blank plan + accept (the nesting contract) ──────────────────
  const [[nestedAlready]] = await pool.query(
    "SELECT COUNT(*) AS n FROM fab_items WHERE company_id = ? AND order_id = ? AND node_kind = 'material' AND nest_no IS NOT NULL AND deleted_at IS NULL",
    [companyId, orderId],
  );
  if (nestedAlready.n > 0) {
    log('order already has a nested plan — skipping blank plan/accept');
  } else {
    const plan = await blankPlan(companyId, orderId, {});
    if (!plan.blanks?.length) {
      log(`blankPlan returned no blanks (skipped: ${JSON.stringify(plan.skipped ?? [])}) — cannot accept a nesting plan`);
    } else {
      const out = await acceptNestingPlan(companyId, orderId, plan);
      counts.nested = out?.platesLinked ?? 1;
      log(`accepted nesting plan: ${JSON.stringify(out).slice(0, 500)}`);
    }
  }
  await refreshOrderStage(companyId, orderId);

  // ── stage 6: weights again (nested parts now weigh off the real plate) ───
  await recomputeOrderWeights(companyId, orderId);

  // ── stage 7: production — raise cutting, then fabrication ───────────────
  // Separate checks, not "any task exists": `acceptNestingPlan` (stage 5)
  // already raises the CUTTING production order and its tasks itself (it has
  // to — the blanks it just created need to be cut before anything else can
  // happen), so by the time we get here `raiseDraft(..., 'cutting')` is
  // usually a no-op and a single "has tasks" check would wrongly skip
  // FABRICATION (the Girder/Segment/parts tasks) too.
  const [[fabMo]] = await pool.query(
    `SELECT id FROM fab_orders WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
       AND mo_purpose IS NULL AND deleted_at IS NULL LIMIT 1`,
    [companyId, orderId],
  );
  await raiseDraft(companyId, orderId, 'cutting'); // idempotent — ensureCuttingOrder finds it by natural key
  if (fabMo) {
    log('fabrication production order already exists — skipping raise (still re-ran cutting, harmlessly)');
  } else {
    await raiseDraft(companyId, orderId, 'fabrication');
    counts.productionRaised = 1;
  }
  await refreshOrderStage(companyId, orderId);

  // ── leave it draft, on purpose ────────────────────────────────────────────
  const [[final]] = await pool.query(
    'SELECT status FROM fab_orders WHERE id = ? AND company_id = ?',
    [orderId, companyId],
  );
  if (final?.status !== 'draft') {
    log(`WARNING: order ${orderId} is status='${final?.status}', not 'draft' — something advanced it`);
  }

  return { ...counts, orderId };
}
