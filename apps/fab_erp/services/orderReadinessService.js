/**
 * orderReadinessService.js — where has this order's wizard got to?
 *
 * A sales order is built in these steps, in this order (resequenced 2026-08-15):
 *
 *   lines → structure → flows → parameters → nesting → project tree
 *
 * The old order was `lines → BOM → nesting → flows`, which committed material to
 * a part before anything said what would be made of it, and asked for every
 * dimension before anything knew which dimensions mattered. See STAGE_KEYS.
 *
 * …and then somebody confirms it. Everything up to that point happens while the
 * order is a DRAFT: a draft is simply an order still in the wizard. Confirm is
 * the single act that takes it out, which is why task automation is forbidden
 * from advancing a draft (see taskEngineService.rollUpOrderStatus) — the tree
 * step would otherwise walk the order past the confirmation nobody made.
 *
 * This is the ONE place that computes where things stand. The wizard's step
 * rail renders it, the order page's strip renders it, and the Build tasks
 * warning is assembled from the same `blockers` array — which is why they
 * cannot contradict each other.
 *
 * NOTHING HERE BLOCKS ANYTHING except confirmation. Blockers are things worth
 * knowing before you press a button, not permission to press it: a planner has
 * good reason to build tasks for a half-nested order, to get the shop cutting
 * while the rest of the BOM is still being drawn. It states what is missing,
 * with counts, and gets out of the way.
 *
 * (The BOM step keeps the internal key `boq` — the endpoints, the service and
 * the spreadsheet are all named for the bill of quantities it is built from.
 * Only the label people read says BOM.)
 *
 * ── STAGES, AS DATA (EU-7 / R5) ──────────────────────────────────────────────
 *
 * This used to be one 244-line function building four inline stage objects by
 * hand, with `satisfied()` a closure only `orderReadiness` itself could call.
 * `STAGES` below is the same four stages as `{key, label, compute(ctx)}`, `ctx`
 * is every query this file needs, loaded ONCE up front (previously ~20 awaits
 * spread across three separate phases — one big `Promise.all` now), and
 * `satisfied(stage)` is a bare function so `preparationComplete`, `nextStage`
 * and `confirmOrder`'s refusal message all agree on what "done" means, which
 * they did not before: the refusal message used to test `state !== 'done'`
 * directly and would have called a `not_applicable` stage "still to finish".
 */

import { pool } from '../../../db.js';
import { NOT_A_BLANK, isMadeChildlessLeaf } from './blankPredicate.js';
import { missingFieldsForOrder, resolveItemFields } from './itemFieldService.js';
import { isDimension } from './fieldDeriveService.js';
import { staleProductionOrders } from './deploySignatureService.js';
import { orderShortfall } from './procurementService.js';
import { procurementForOrder, onOrderByItem } from './procurementOrderService.js';
import { orderStageApplicability } from './stageApplicabilityService.js';
import { flowSummary } from './orderFlowService.js';
import { depthLabels, labelFor } from './depthLabelService.js';
import { checkOrderNesting, blockingIssues, ISSUE } from './nestingIntegrityService.js';
import { rollUpOrderStatus } from './taskEngineService.js';
import { plannerTimezone } from './planService.js';
import { zonedYMD } from './plantTime.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * The wizard's steps, in the order they happen.
 *
 * `procurement` and `production` were added 2026-08-13: once the tree is built,
 * the BOM has said what to buy and what to make, and each becomes a document.
 * They sit last because neither can be answered before the tree exists.
 */
/**
 * The order the work is actually done in — RESEQUENCED 2026-08-15.
 *
 * It was `lines, boq, nesting, flows, tasks`, which asked two things in the
 * wrong order:
 *
 *   Nesting came BEFORE flows, so material was committed to a part before
 *   anybody had said what would be made of it.
 *
 *   The BOQ asked for every dimension before anything knew which dimensions
 *   mattered. Which fields a part needs is derived from its flow's formulas
 *   (`itemFieldService.requiredFieldsForFlow`) — so the flow has to be known
 *   first, or the sheet is guessing at columns.
 *
 * Now: structure → flows → DIMENSIONS → nesting → other params.
 *
 * Parameters used to be one step and sat before nesting whole, which made the
 * step with the longest lead time — you cannot order steel until it is nested —
 * wait behind hole counts and weld runs. Nesting reads neither. It reads the
 * rectangle and the steel, and nothing else: it never touches a flow.
 *
 * So the rectangle is asked for on its own, nesting follows it immediately, and
 * everything else a flow demands comes after. Flows stay where they are: they
 * need nothing, and the BOM has usually answered them already.
 */
/*
 * FLOWS IS NOT A STEP ANY MORE — it is a column on the structure.
 *
 * It was a review screen: a per-depth summary you could not edit, and an
 * "exceptions" list of rows whose flow was missing. Both were answering "did the
 * BOM already tell us how this is made", one screen after the screen where you
 * could actually say so.
 *
 * The CHECK it performed has not gone anywhere — removing a step must not remove
 * a gate. It is folded into 'boq' below, UNCHANGED IN STRENGTH: the structure
 * reports partial when `flowState.missing` is non-zero, which is exactly what
 * the flows stage reported partial on.
 *
 * Worth knowing what that gate is and is not, because it is weaker than its name
 * suggests and moving it is not the moment to quietly change it: `missing` counts
 * rows whose BOM LINE states a flow the row never received. A row with no flow
 * and no BOM default is a decision somebody still has to make, and neither the
 * old stage nor this one blocks on it — `summariseFlows` returns 'done' as soon
 * as ANY item has a flow. Tightening that is a separate decision with its own
 * consequence: orders that confirm today would stop confirming.
 */
/*
 * 'boq' IS GONE TOO — a line and its BOM are one screen now.
 *
 * They were two steps, and the second one was quietly wrong: it rendered the
 * structure for the FIRST line and nothing else. An order with two lines showed
 * two line items and one structure, and the second line's BOM was unreachable
 * once built. Nobody noticed because the screen never claimed to be showing only
 * one of them.
 *
 * A line and what it is made of are one thought. Asking on one screen and
 * answering on another is what let the answer go missing.
 *
 * Both CHECKS survive, folded into 'lines' below: no lines, or a structure short
 * of sizes, still holds the step open and Confirm shut.
 */
/*
 * 'tasks' AND 'procurement' ARE FOLDED INTO 'production'. What to buy, what to
 * cut and what to make are one screen: the buying half and both production
 * orders sit together, because they are three answers to one question — how
 * does this order get built.
 */
export const STAGE_KEYS = ['lines', 'nesting', 'params', 'production'];

/**
 * A quote's Production step is a read-only estimate (EU-13 item 2, User
 * Clarifications P3): no manufacturing order, no purchase request, no task
 * materialisation is ever raised from one. This is the canonical definition —
 * exported here for the readiness stage's own use above and for callers that
 * already depend on this module. `procurementOrderService`,
 * `productionOrderService` and `taskEngineService.rollUpOrderStatus` check the
 * SAME condition (`order_type === 'quote'`) inline rather than importing it:
 * this file already imports from all three (directly or via taskEngineService
 * → productionOrderService), so an import back in would be circular.
 */
export const isEstimateOnly = (order) => order?.order_type === 'quote';

/** "1 row", "82 rows" — no "row(s)". */
const n = (count, word, plural = `${word}s`) => `${Number(count).toLocaleString('en-IN')} ${Number(count) === 1 ? word : plural}`;

/** Everything that must be done before an order can be confirmed. */
const PREPARATION_STAGES = STAGE_KEYS;

/**
 * A stage that does not apply cannot hold the order up, and an OPTIONAL one
 * must not either — that is the whole of what "optional" buys. Both still
 * report their true state; they simply stop being gates.
 *
 * Shared by `preparationComplete`, `nextStage` and `confirmOrder`'s refusal
 * message, which is the point: those three used to each carry their own idea
 * of "done" (one of them, literally `state !== 'done'`), and a `not_applicable`
 * or `optional` stage disagreeing with itself is exactly the A5-adjacent bug
 * class this file exists to stop.
 */
function satisfied(stage) {
  return stage.state === 'done' || stage.state === 'not_applicable'
    || stage.applicability === 'optional';
}

/**
 * Procurement readiness: is everything this order has to buy either on the
 * shelf or on order?
 *
 * DONE when nothing is short. That covers two cases which look different and
 * are not: an order with nothing to buy at all, and an order whose every
 * shortage has a purchase order against it. In both, there is no outstanding
 * decision — and treating "nothing to do" as unfinished would gate Confirm on
 * an action that cannot be taken.
 *
 * PARTIAL rather than todo once some purchase orders exist, so a half-finished
 * step reads as half-finished.
 */
/**
 * How many BOM rows this order has at all.
 *
 * The distinction both summarisers below need: an order with NO rows has had
 * no decision made about it, while an order whose every row is make (or every
 * row is buy) has. Collapsing the two is what let the two step rails assert
 * opposite things — "made entirely in-house" and "entirely bought in" — about
 * the same empty order at the same time.
 */
async function bomRowCount(companyId, orderId) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  return Number(r?.n) || 0;
}

/**
 * @param {{cache: Map}} [procCtx] EU-14 item E3 — a per-request memo shared
 *   with `productionPlanService.buyView` and
 *   `procurementOrderService.requestProcurement` when a caller further up (a
 *   route doing more than one of these in one request) builds one ctx and
 *   passes it to all three, so `orderShortfall` computes once rather than
 *   once per caller. No current call site passes one — `loadReadinessCtx`'s
 *   own call below doesn't either — so this is a no-op today; named `procCtx`
 *   rather than `ctx` to not collide with `orderReadiness`'s own `ctx` (the
 *   readiness stage context, a different object entirely).
 */
async function summariseProcurement(companyId, orderId, procCtx) {
  const [short, pos, onOrder, bomRows] = await Promise.all([
    orderShortfall(companyId, orderId, null, { ctx: procCtx }),
    procurementForOrder(companyId, orderId),
    onOrderByItem(companyId, orderId),
    bomRowCount(companyId, orderId),
  ]);

  const needed = short.lines.length;
  /**
   * SHORT MEANS "not covered by stock"; this stage asks "still to be dealt
   * with", and those stop being the same question the moment a purchase order
   * exists. The detail below has always said "covered by stock OR ON ORDER" —
   * the arithmetic simply never looked at the second half, so an order whose
   * every shortage had a PO against it stayed partial and could not be
   * confirmed until the steel physically arrived.
   *
   * That is backwards. Confirming is what tells the shop the job is real;
   * "waiting for material" is a stage that comes AFTER it, and the board has a
   * column for exactly that.
   */
  const stillShort = short.lines.filter((l) => l.short > (onOrder.get(l.catalogItemId) ?? 0)).length;
  const covered = needed - stillShort;

  let state = 'done';
  // An empty order and an all-make order both yield needed === 0, and they are
  // not the same thing. Saying 'made entirely in-house' about an order with no
  // BOM at all states something nobody has decided yet, and it used to sit
  // directly opposite the production rail claiming the order was entirely
  // bought in — two contradictory sentences about the same empty order.
  let detail;
  if (needed === 0) {
    detail = bomRows === 0
      ? 'Nothing in this order yet'
      : 'Nothing to buy — every row is made here';
  } else {
    detail = `All ${n(needed, 'bought item')} covered`;
  }

  if (stillShort > 0) {
    state = pos.length > 0 ? 'partial' : 'todo';
    detail = `Buy ${n(stillShort, 'item')}${pos.length > 0 ? ` · ${n(pos.length, 'purchase order')} so far` : ''}`;
  }
  if (short.unmatched.length > 0) {
    // A bought-in row with no catalog item cannot be checked against stock or
    // purchased. Saying so is the only useful thing to do about it.
    detail += `; ${short.unmatched.length} bought-in row(s) have no catalog item`;
    if (state === 'done') state = 'partial';
  }
  return { state, covered, needed, detail, stillShort };
}

/**
 * Production readiness: is there a production order for everything that has to
 * be made — one for cutting if anything is cut, one for fabrication if anything
 * is fabricated?
 *
 * A DRAFT COUNTS. Raising the drafts is the decision this step asks for;
 * deploying them to the shop is done on the production order itself, and can
 * come after the sales order is confirmed.
 */
async function summariseProduction(companyId, orderId) {
  const [[need]] = await pool.query(
    `SELECT SUM(bc.id IS NOT NULL) AS blanks, SUM(bc.id IS NULL) AS made
       FROM fab_items i
       LEFT JOIN fab_item_catalog bc ON bc.id = i.catalog_item_id AND bc.material_form = 'blank'
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.flow_id IS NOT NULL AND i.node_kind = 'structure'
        AND COALESCE(i.procurement_type, 'make') = 'make'`,
    [companyId, orderId],
  );
  const [mos] = await pool.query(
    `SELECT mo_purpose AS purpose, status FROM fab_orders
      WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
        AND deleted_at IS NULL AND status <> 'cancelled'`,
    [companyId, orderId],
  );
  const cutting = mos.find((m) => m.purpose === 'cutting');
  const fabrication = mos.find((m) => m.purpose == null);
  const needCut = Number(need?.blanks) > 0;
  const needFab = Number(need?.made) > 0;
  const missing = [needCut && !cutting ? 'cutting' : null, needFab && !fabrication ? 'fabrication' : null]
    .filter(Boolean);
  const deployed = mos.filter((m) => m.status !== 'draft').length;
  // A deployed order whose BOM moved since is not "done": the shop is working
  // to a plan that no longer matches what was sold.
  const stale = deployed ? (await staleProductionOrders(companyId, orderId)).stale : [];
  return {
    state: stale.length ? 'partial'
      : !needCut && !needFab ? 'done' : missing.length === 0 ? 'done' : mos.length ? 'partial' : 'todo',
    missing,
    count: mos.length,
    total: Number(needCut) + Number(needFab),
    deployed,
    stale,
  };
}

// ── counts ───────────────────────────────────────────────────────────────────

async function countLines(companyId, orderId) {
  // A line counts as typed when EITHER `line_type` is stamped (the normal
  // case — see `mutateController.deriveOrderLineType`) OR its catalog item
  // resolves to a category — a structure root with no GROUP (this company's
  // COMPOS-SPAN, say) only got `line_type` filled once the derivation itself
  // learned to fall back to category; a line built before that fix, or by
  // any other writer, still HAS a typed catalog item and must not read as
  // untyped.
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(
              (fol.line_type IS NULL OR fol.line_type = '')
              AND NOT EXISTS (
                SELECT 1 FROM fab_item_catalog c
                  JOIN fab_item_categories cat ON cat.id = c.category_id AND cat.deleted_at IS NULL
                 WHERE c.id = fol.catalog_item_id AND c.company_id = fol.company_id AND c.deleted_at IS NULL
              )
            ) AS withoutType
       FROM fab_order_lines fol
      WHERE fol.company_id = ? AND fol.order_id = ? AND fol.deleted_at IS NULL`,
    [companyId, orderId],
  );
  return { total: Number(row?.total) || 0, withoutType: Number(row?.withoutType) || 0 };
}

/**
 * What the order's structure contains, one entry per DEPTH.
 *
 * This used to count four fixed buckets — spans, girders, segments, parts —
 * which meant an order five levels deep had nowhere to report its fifth, and a
 * flat one reported two empty rungs. It also had to guess a level for every row
 * built by hand rather than imported, because only the Excel importer ever
 * stamped `level_kind`.
 *
 * Depth is stamped by every writer, so there is nothing left to guess. The
 * caller gets `[{depth, label, count, leaves}]` and names each rung from the
 * items actually on it — a signpost taken from the data rather than a vocabulary
 * this function has to hold.
 *
 * Raw-material links are excluded throughout. They are children of a part, not
 * a rung of the structure, and counting them would report every part twice.
 */
async function countTree(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT fi.depth, COUNT(*) AS n, SUM(fi.is_leaf = 1) AS leaves
       FROM fab_items fi
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
        AND fi.node_kind = 'structure'
        /*
         * BLANKS ARE NOT PART OF THE STRUCTURE somebody drew.
         *
         * They sit on the order as depth-0 structure rows carrying the cutting
         * flow, so this counted them: an 82-row structure reported 106, and the
         * extra 24 appeared as a second thing at the top level beside the Span.
         * The number on a stage chip is the one people check their own work
         * against, so being quietly 29% high is worse than being absent.
         */
        AND ${NOT_A_BLANK('fi')}
      GROUP BY fi.depth
      ORDER BY fi.depth`,
    [companyId, orderId],
  );

  // Through the shared service, never a local rule — this stage and the Flows
  // tab used to name the same rung differently on the same screen.
  const labels = await depthLabels(companyId, orderId);

  const levels = rows.map((r) => ({
    depth: Number(r.depth),
    label: labelFor(labels, r.depth),
    count: Number(r.n) || 0,
    leaves: Number(r.leaves) || 0,
  }));
  const total = levels.reduce((a, l) => a + l.count, 0);
  // The things that actually get made, at whatever depth they turned out to be.
  const parts = levels.reduce((a, l) => a + l.leaves, 0);
  return { levels, parts, total };
}

/**
 * How many parts know what they are cut from. A raw-material link is a childless
 * row carrying a catalog item and no flow — the same shape taskGatingService
 * treats as material to consume.
 *
 * FIXED (EU-7, following EU-6): this used to test `is_leaf = 1` with no
 * exclusion for BLANK rows. `recomputeItemShape` (EU-6) now correctly marks a
 * blank row itself as a childless leaf — its only child is its own material
 * link, which does not count as a structural child — so every blank on the
 * order started being counted here as a part still needing to be nested, on
 * top of the real part it was cut FOR. `isMadeChildlessLeaf` is the one
 * definition of "a part nesting is allowed to act on" (blankPredicate.js,
 * EU-3): made, childless of anything but a material link, and not a blank
 * itself. Order 247 went from 19 to 14 parts under this fix — the 5 blank rows
 * EU-6 newly flagged as leaves are exactly the difference.
 */
async function countNesting(companyId, orderId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(DISTINCT p.id)                                        AS parts,
            COUNT(DISTINCT CASE WHEN rm.id IS NOT NULL THEN p.id END)   AS nested
       FROM fab_items p
       LEFT JOIN fab_items rm
              ON rm.parent_item_id = p.id AND rm.deleted_at IS NULL
             AND rm.node_kind = 'material'
      WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL
        AND p.is_leaf = 1 AND p.node_kind = 'structure'
        AND ${isMadeChildlessLeaf('p')}`,
    [companyId, orderId],
  );
  return { parts: Number(row?.parts) || 0, nested: Number(row?.nested) || 0 };
}

/**
 * Made leaf parts with no rectangle yet — thickness, width or length missing.
 *
 * Such a part cannot become a blank (blankService skips it with "no size on it
 * yet"), so it can never be nested, so the order can never be confirmed. That
 * used to surface only on the NESTING step, as "1 part not on a sheet yet",
 * which is true and useless: nothing on that step can fix it. It belongs to
 * Line items, named, where the size is typed. The same resolver blankService
 * uses, so the two never disagree about which parts have a size.
 */
async function countSizeless(companyId, orderId) {
  const [parts] = await pool.query(
    `SELECT p.id, p.name FROM fab_items p
      WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL
        AND p.is_leaf = 1 AND p.node_kind = 'structure'
        AND ${isMadeChildlessLeaf('p')}
      ORDER BY p.id`,
    [companyId, orderId],
  );
  if (!parts.length) return { count: 0, names: [] };
  const nums = await resolveItemFields(companyId, parts.map((p) => Number(p.id)));
  const names = [];
  for (const p of parts) {
    const f = nums.get(Number(p.id)) ?? {};
    const ok = ['thickness_mm', 'width_mm', 'length_mm'].every((k) => Number.isFinite(Number(f[k])) && Number(f[k]) > 0);
    if (!ok) names.push(p.name);
  }
  return { count: names.length, names };
}

/** "Stiffener Plate 16 × 150", "A, B and 3 more" — for a one-line detail. */
function nameList(names, max = 2) {
  const shown = names.slice(0, max).join(', ');
  const rest = names.length - max;
  return rest > 0 ? `${shown} and ${n(rest, 'more', 'more')}` : shown;
}

// ── flows ────────────────────────────────────────────────────────────────────

/**
 * Turn a flowSummary into a stage.
 *
 * The hard part is that a flow-less item is usually CORRECT — an assembly that
 * only groups its children carries no flow at all, and on a normal order that
 * describes every rung above the leaves. So "missing" cannot mean "has no
 * flow".
 *
 * It used to mean "this level has a rule, so the company has said work happens
 * here, and yet this item has none". With the default on the BOM line there is
 * no rule table to consult, and the equivalent question is simpler and more
 * direct: does the BOM have an answer this item never received? That happens
 * only when a line's default was set after the order was built, and
 * `syncFlowsFromBom` is what clears it.
 *
 * Everything else — a leaf with no flow and no BOM default — is a genuine
 * choice someone still has to make, so it is reported without pretending a
 * button will fix it.
 */
function summariseFlows(summary) {
  let withFlow = 0, flowable = 0;
  for (const lv of summary.levels) {
    withFlow += lv.withFlow;
    flowable += lv.items;
  }
  const wouldAssign = summary.wouldAssign;   // fixable by re-pulling the BOM

  let state, detail;
  if (wouldAssign > 0) {
    state = 'partial';
    detail = `${wouldAssign} item(s) have a flow on the BOM that has not been pulled in yet`;
  } else if (withFlow > 0) {
    state = 'done';
    detail = `${withFlow} item(s) have a flow`;
  } else if (flowable === 0) {
    state = 'todo';
    detail = 'No structure to give a flow to yet';
  } else {
    state = 'todo';
    detail = 'No item has a flow yet — set a default flow on the BOM lines';
  }
  return { state, detail, withFlow, flowable, wouldAssign, manual: 0, missing: wouldAssign };
}

// ── context: every query the four stages need, loaded ONCE ─────────────────

/**
 * `keys` scopes which stages are about to be computed, so a caller that only
 * needs one (`orderReadiness(..., {only: ['nesting']})`) is not also paying for
 * procurement/production/field queries that stage never reads. The default —
 * every current call site — asks for all four, and gets exactly the same nine
 * queries the old function made, just issued together instead of in three
 * separate `await` phases.
 *
 * `fields` (`missingFieldsForOrder`) is the one query TWO stages share
 * (`lines` reads its dimension gaps, `params` reads everything else it found),
 * so it loads whenever either is wanted rather than once per stage.
 */
async function loadReadinessCtx(companyId, orderId, keys, procCtx) {
  const needLines = keys.includes('lines');
  const needNesting = keys.includes('nesting');
  const needParams = keys.includes('params');
  const needProduction = keys.includes('production');
  const needFields = needLines || needParams;

  const [
    lines, tree, flows,
    nest, nestIntegrity, cuttingOrderId, cut,
    proc, production,
    fields,
    sizeless,
  ] = await Promise.all([
    needLines ? countLines(companyId, orderId) : null,
    needLines ? countTree(companyId, orderId) : null,
    // Reusing flowSummary rather than re-deriving it: the Flows tab and the
    // strip must never disagree about how many items still need a flow.
    needLines ? flowSummary(companyId, orderId) : null,
    needNesting ? countNesting(companyId, orderId) : null,
    // Phase 5: a nesting that is physically impossible must not read as done.
    // Counting links was never enough — every part could have material and the
    // order still be uncuttable.
    needNesting ? checkOrderNesting(companyId, orderId).catch(() => ({ ok: true, issues: [] })) : null,
    /** Acceptance, as a fact on the database rather than a state on a screen. */
    needNesting ? pool.query(
      `SELECT id FROM fab_orders
        WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
          AND mo_purpose = 'cutting' AND deleted_at IS NULL LIMIT 1`,
      [companyId, orderId],
    ).then(([[r]]) => r?.id ?? null) : null,
    /** What nesting produced, in the two numbers the Nesting tab leads with. */
    needNesting ? pool.query(
      `SELECT (SELECT COUNT(*) FROM fab_items i
                 JOIN fab_item_catalog bc ON bc.id = i.catalog_item_id AND bc.material_form = 'blank'
                WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL AND i.node_kind = 'structure') AS blanks,
              (SELECT COUNT(DISTINCT nest_no) FROM fab_items
                WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
                  AND node_kind = 'material' AND nest_no IS NOT NULL) AS sheets`,
      [companyId, orderId, companyId, orderId],
    ).then(([[r]]) => r) : null,
    needProduction ? summariseProcurement(companyId, orderId, procCtx) : null,
    needProduction ? summariseProduction(companyId, orderId) : null,
    // Never let a field-analysis failure take the whole strip down: the other
    // stages are still true and the order still has to be workable.
    needFields ? missingFieldsForOrder(companyId, orderId).catch(() => ({
      itemsChecked: 0, itemsShort: 0, missingValues: [], unknownFields: [], unusableFields: [], noFormula: [],
    })) : null,
    // Both the Line items stage (where it is fixed) and Nesting (where it
    // shows) read it; a resolver failure must not take the strip down.
    (needLines || needNesting) ? countSizeless(companyId, orderId).catch(() => ({ count: 0, names: [] })) : null,
  ]);

  const flowState = flows ? summariseFlows(flows) : null;
  const nestBlocking = nestIntegrity ? blockingIssues(nestIntegrity) : [];
  /**
   * PIECES_SHORT (User Clarifications 5, EU-5/EU-7): a part has links, but their
   * qty no longer covers required×lineQty — a line's qty rose after the part
   * was nested. Advisory, not blocking (checkOrderNesting already says so via
   * ADVISORY), but the nesting STAGE must report it as `partial` rather than
   * silently reading done.
   */
  const piecesShort = nestIntegrity
    ? nestIntegrity.issues.filter((i) => i.type === ISSUE.PIECES_SHORT)
    : [];

  /*
   * ONE ANALYSIS, TWO STAGES. `missingValues` lists what each part is short of;
   * splitting it by whether the field is a dimension is what lets the rectangle
   * be asked for before nesting and everything else after, without running the
   * whole field walk twice. A part short of BOTH counts against both, which is
   * right: it is genuinely not finished on either step.
   */
  const shortOnDims = fields ? fields.missingValues.filter((m) => m.missing.some(isDimension)).length : 0;
  const shortOnRest = fields ? fields.missingValues.filter((m) => m.missing.some((k) => !isDimension(k))).length : 0;

  return {
    lines, tree, flowState,
    nest, nestBlocking, piecesShort, cuttingOrder: cuttingOrderId, cut,
    proc, production,
    fields, shortOnDims, shortOnRest,
    sizeless: sizeless ?? { count: 0, names: [] },
  };
}

// ── stages, as data ──────────────────────────────────────────────────────────

const STAGES = [
  {
    key: 'lines',
    /**
     * "Line items", and it owns the STRUCTURE as well.
     *
     * What the order sells, and what each of those is made of, on one screen —
     * so the state has to answer for both. A line with no structure is not
     * finished, and neither is a structure whose parts have no size.
     */
    label: 'Line items',
    compute(ctx) {
      const { lines, tree, flowState, shortOnDims, sizeless } = ctx;
      const state = lines.total === 0 ? 'todo'
        : (lines.withoutType > 0 || tree.total === 0
           || tree.parts === 0 || sizeless.count > 0 || shortOnDims > 0 || flowState.missing > 0) ? 'partial'
        : 'done';
      return {
        state,
        count: lines.total,
        total: lines.total,
        // The one number the strip shows, and it is the same one the wizard and
        // the line cards show: rows.
        summary: tree.total ? n(tree.total, 'row') : null,
        detail: lines.total === 0
          ? 'Nothing sold yet'
          : lines.withoutType > 0
            ? `${n(lines.withoutType, 'line')} without a structure type`
            : tree.total === 0
              ? `${n(lines.total, 'line')} · nothing built yet`
              // Named: "1 part without a size — Stiffener Plate 16 × 150" is a
              // row to go and find; "1 part without a size" is a search.
              : sizeless.count > 0
                ? `${n(sizeless.count, 'part')} without a size — ${nameList(sizeless.names)}`
              : shortOnDims > 0
                ? `${n(shortOnDims, 'part')} without a size`
                : flowState.missing > 0
                  ? `${n(flowState.missing, 'row')} without a flow`
                  : `${n(lines.total, 'line')} · ${n(tree.total, 'row')}`,
      };
    },
  },
  {
    key: 'nesting',
    label: 'Nesting',
    compute(ctx) {
      const { nest, cuttingOrder, nestBlocking, piecesShort, cut, sizeless } = ctx;
      /**
       * Every part having material was never enough to call this done.
       * `nested >= parts` only counts links; it says nothing about whether the
       * nesting is physically possible, or whether it is still enough pieces
       * now that a line's qty has moved (PIECES_SHORT, User Clarifications 5).
       * An order where a 3000 mm part is declared as cut from a 2000 mm plate,
       * or where 12 of the 36 pieces a line now needs were never re-nested,
       * would read "All part(s) have material" and go green — and the first
       * person to find out was a cutter.
       */
      /*
       * AND THE PLAN MUST BE ACCEPTED. Links alone are not acceptance: a plan
       * can be looked at, re-nested and looked at again without anyone ever
       * committing to one, and the step said "done" throughout because the
       * PREVIOUS plan's links were still sitting there. Accepting is what
       * raises the cutting order, so the cutting order is what proves it.
       */
      const state = nest.parts === 0 ? 'todo'
        : nest.nested === 0 ? 'todo'
          : nest.nested < nest.parts ? 'partial'
            : piecesShort.length > 0 ? 'partial'
              : !cuttingOrder ? 'partial'
                : nestBlocking.length > 0 ? 'partial' : 'done';

      // "12 pieces of 36 not on any sheet" for the one part short; summed
      // across parts when more than one line's qty moved after nesting.
      const piecesShortDetail = () => {
        if (piecesShort.length === 1) {
          const i = piecesShort[0];
          return `${n(i.short, 'piece')} of ${i.required} not on any sheet`;
        }
        const totalShort = piecesShort.reduce((a, i) => a + i.short, 0);
        return `${n(totalShort, 'piece')} short across ${n(piecesShort.length, 'part')}`;
      };

      return {
        state,
        count: nest.nested,
        total: nest.parts,
        summary: cuttingOrder && Number(cut?.blanks) ? `${n(cut.blanks, 'blank')} · ${n(cut.sheets, 'sheet')}` : null,
        detail: nest.parts === 0
          ? 'Nothing to nest yet'
          // A part with no rectangle cannot be nested from HERE — say where.
          : nest.nested < nest.parts && sizeless.count > 0 && nest.parts - nest.nested <= sizeless.count
            ? `${n(sizeless.count, 'part')} cannot be nested — no size yet (Line items)`
          : nest.nested < nest.parts
            ? `${n(nest.parts - nest.nested, 'part')} not on a sheet yet`
            : piecesShort.length > 0
              ? piecesShortDetail()
              : !cuttingOrder
                ? 'Plan not accepted yet'
              : nestBlocking.length > 0
                ? `${n(nestBlocking.length, 'problem')} to fix — ${nestBlocking[0].message}`
                : `Plan accepted — ${n(cut?.blanks ?? 0, 'blank')} on ${n(cut?.sheets ?? 0, 'sheet')}`,
        /** The full list, so the screen can show every one rather than the first. */
        issues: nestBlocking,
      };
    },
  },
  {
    /**
     * Everything a flow asks for that is NOT the rectangle — hole counts,
     * weld runs. Weight and area are absent on purpose: they are arithmetic
     * on the rectangle and are computed, never asked for.
     */
    key: 'params',
    label: 'Other params',
    compute(ctx) {
      const { fields, shortOnRest } = ctx;
      const state = fields.itemsChecked === 0 ? 'todo'
        : (shortOnRest > 0
          || fields.unknownFields.length > 0
          || (fields.unusableFields?.length ?? 0) > 0) ? 'partial' : 'done';
      return {
        state,
        count: fields.itemsChecked - shortOnRest,
        total: fields.itemsChecked,
        summary: fields.itemsChecked === 0 ? null : shortOnRest > 0 ? `${shortOnRest} to fill` : 'all filled',
        detail: fields.itemsChecked === 0
          ? 'Pick flows first — they decide which values are needed'
          : fields.unknownFields.length > 0
            ? `${n(fields.unknownFields.length, 'operation')} name a field that does not exist`
            : (fields.unusableFields?.length ?? 0) > 0
              ? `${n(fields.unusableFields.length, 'operation')} use a field not set up for formulas`
              : shortOnRest > 0
                ? `${n(shortOnRest, 'row')} missing values`
                : 'All values filled',
      };
    },
  },
  {
    /**
     * Buy, cut and make — one step. Done once everything bought is in stock
     * or requested, and a production order is drafted for the cutting and
     * for the fabrication.
     */
    key: 'production',
    label: 'Production',
    compute(ctx) {
      const { proc, production } = ctx;
      const state = proc.state === 'done' && production.state === 'done' ? 'done'
        : proc.state === 'todo' && production.state === 'todo' ? 'todo' : 'partial';
      return {
        state,
        count: production.count,
        total: production.total,
        /** How many production orders are on the floor — the structure editor warns before editing under them. */
        deployed: production.deployed,
        /** Deployed orders whose BOM changed since (order numbers) — the plan screen offers Re-deploy. */
        stale: production.stale ?? [],
        summary: production.total ? `${production.deployed}/${production.total} deployed` : null,
        detail: [
          // Says what to press: "Buy 6 items" left people looking for a Buy button (UAT 24).
          proc.stillShort > 0 ? `${n(proc.stillShort, 'item')} to buy — press "Hold stock and request the rest"` : null,
          production.stale?.length
            ? `${production.stale.join(', ')} changed since deploy — re-deploy`
            : null,
          production.missing.length
            ? `no ${production.missing.join(' or ')} order yet`
            : production.total
              ? (production.deployed === production.total
                ? 'all deployed'
                : `${n(production.total - production.deployed, 'draft')} to deploy`)
              : null,
        ].filter(Boolean).join(' · ') || proc.detail,
      };
    },
  },
];

/**
 * What someone should know before building tasks. Each one is a real
 * consequence, stated with its count — "38 items have no flow" is actionable in
 * a way that "some items may be skipped" never was.
 */
function buildBlockers({ lines, tree, nest, flowState, production }) {
  const out = [];

  if (production.missing.length) {
    out.push({
      stage: 'production', count: 0,
      message: `No ${production.missing.join(' or ')} production order yet, so this order has no work on the floor.`,
    });
  }

  if (lines.total === 0) {
    out.push({ stage: 'lines', count: 0, message: 'This order has no line items.' });
  }
  if (tree.parts === 0) {
    out.push({
      stage: 'lines', count: 0,
      message: 'The BOQ has no parts, so there is nothing at the bottom of the tree to make.',
    });
  }
  const unnested = nest.parts - nest.nested;
  if (unnested > 0) {
    out.push({
      stage: 'nesting', count: unnested,
      message: `${unnested} of ${nest.parts} part(s) have no raw material. Their tasks will be built, but nothing holds them back for stock — work can be started before the steel is there.`,
    });
  }
  if (flowState.wouldAssign > 0) {
    out.push({
      stage: 'lines', count: flowState.wouldAssign,
      message: `${flowState.wouldAssign} item(s) have a flow on the BOM that this order never received. Set it on the row, on the Structure step.`,
    });
  }
  if (flowState.manual > 0) {
    out.push({
      stage: 'lines', count: flowState.manual,
      message: `${flowState.manual} item(s) have no flow and no rule matches them. They will be skipped entirely — no tasks at all.`,
    });
  }
  if (flowState.withFlow === 0) {
    out.push({
      stage: 'lines', count: 0,
      message: 'No row on this order has a flow, so building tasks would produce nothing. Set one on the Structure step.',
    });
  }
  return out;
}

/**
 * Full readiness for one order — or, with `only`, one slice of it.
 *
 * `only` (EU-7) lets a caller that knows only ONE stage could have moved
 * (`refreshOrderStage`, chiefly) skip the queries the other three need. A
 * partial call answers that one stage honestly and nothing about the order as
 * a whole: `preparationComplete`/`canConfirm` need every stage's satisfaction,
 * so they come back `false` rather than a guess built on stages this call
 * never looked at, and `blockers` — which draws from all four — comes back
 * empty. Every existing caller (routes, `confirmOrder`) omits `only` and gets
 * exactly the same four stages as before, which is what keeps the snapshot
 * byte-identical.
 *
 * @returns {Promise<{
 *   orderId: number, status: string, wizardStep: string|null,
 *   preparationComplete: boolean, canConfirm: boolean, nextStage: string|null,
 *   stages: Array<{key,label,state,satisfied,count,total,summary,detail}>,
 *   blockers: Array<{stage,count,message}>,
 * }>}
 * @param {{cache: Map}} [opts.procCtx] EU-14 item E3 — forwarded to
 *   `summariseProcurement`; see that function's own doc.
 */
export async function orderReadiness(companyId, orderId, { only, procCtx } = {}) {
  const [[order]] = await pool.query(
    'SELECT id, status, wizard_step, order_type FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!order) { const e = new Error('Order not found'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }

  const keys = (only && only.length) ? only.filter((k) => STAGE_KEYS.includes(k)) : STAGE_KEYS;
  const full = keys.length === STAGE_KEYS.length;

  const ctx = await loadReadinessCtx(companyId, orderId, keys, procCtx);
  const stages = STAGES.filter((s) => keys.includes(s.key))
    .map((s) => ({ key: s.key, label: s.label, ...s.compute(ctx) }));

  /**
   * TYPE-SCOPED APPLICABILITY, applied last.
   *
   * Every stage above computes its real state from the real data, and only then
   * is it asked whether it applies to this order's line types at all. That
   * order matters: a stage that does not apply still knows what it WOULD have
   * said, so the strip can show "not relevant" without having quietly skipped
   * the work of finding out.
   *
   * `not_applicable` is reported, never hidden. A stage that vanishes leaves
   * somebody wondering whether they forgot it; one that says "not relevant for
   * a PEB line" answers the question before it is asked.
   */
  const applicability = await orderStageApplicability(companyId, orderId, keys);
  for (const s of stages) {
    const a = applicability.get(s.key);
    if (!a) continue;
    s.applicability = a.applicability;
    s.applicabilityNotes = a.notes;
    s.appliesToSomeLines = a.mixed === true;
    if (a.applicability === 'not_applicable') {
      s.state = 'not_applicable';
      s.detail = a.notes
        ? `Not relevant for ${(a.lineTypes ?? []).filter(Boolean).join(', ') || 'this order'} — ${a.notes}`
        : `Not relevant for ${(a.lineTypes ?? []).filter(Boolean).join(', ') || 'this order'}`;
    }
  }

  /**
   * A QUOTE NEVER RAISES PRODUCTION (User Clarifications P3 / EU-13 item 4).
   * `orderStageApplicability` above keys off line types, not order type, and a
   * quote's lines look exactly like a sales order's — so this is forced last,
   * overriding whatever that service said, rather than teaching it about a
   * concept (order_type) it otherwise has no reason to know.
   */
  if (order.order_type === 'quote') {
    const production = stages.find((s) => s.key === 'production');
    if (production) {
      production.applicability = 'not_applicable';
      production.state = 'not_applicable';
      production.detail = 'This is a quote — no production is raised until it is converted to a sales order.';
    }
  }

  /**
   * THE STEPS HAPPEN IN ORDER, and a step nobody has reached has no status.
   *
   * Production used to report `done` on a brand-new order — nothing to buy,
   * nothing to deploy, so "done" — and the rail showed a green tick on step 4
   * before step 1 had a single row. It was truthful about the arithmetic and
   * wrong about the work: an order is not "ready for production" because it is
   * empty. So once a stage is unfinished, every later one (short of one that
   * genuinely does not apply) is `pending` — unreached, unsatisfied, and the
   * wizard refuses to open it. `optional` stages never block the ones after.
   *
   * ONLY A STAGE NOBODY HAS TOUCHED IS PENDING. The order's tabs let someone
   * nest, draft and deploy without walking the wizard in order, and they do:
   * a prod UAT (2026-09-15) had both production orders deployed while one
   * part still had no size, and the strip read "Production 2/2 deployed" in
   * one line and "Production — After Nesting" in the next, with the wizard
   * refusing to open a step that plainly had work on it. A stage with real
   * progress keeps its own state and detail; `pending` is reserved for a
   * `todo` stage (or a `done` that is only "nothing to do" on an untouched
   * order — count 0), which is the case the rule was written for.
   */
  let blockedBy = null;
  for (const s of stages) {
    if (typeof s.detail === 'string' && s.detail) s.detail = s.detail[0].toUpperCase() + s.detail.slice(1);
    const untouched = s.state === 'todo' || (s.state === 'done' && !(Number(s.count) > 0));
    if (blockedBy && untouched && s.state !== 'not_applicable' && s.applicability !== 'optional') {
      s.state = 'pending';
      s.detail = `After ${blockedBy.label}`;
    }
    // Emitted alongside `state` (EU-7 / R5): Next and Confirm used to each
    // re-derive "is this stage done" their own way and could disagree.
    s.satisfied = satisfied(s);
    if (!s.satisfied && !blockedBy) blockedBy = s;
  }

  const byKey = Object.fromEntries(stages.map((s) => [s.key, s]));
  const preparationComplete = full && PREPARATION_STAGES.every((k) => byKey[k] && satisfied(byKey[k]));
  const nextStage = full
    ? (stages.find((s) => !satisfied(s))?.key ?? null)
    : (byKey[keys[0]] && !satisfied(byKey[keys[0]]) ? keys[0] : null);

  return {
    orderId,
    status: order.status,
    wizardStep: order.wizard_step ?? null,
    preparationComplete,
    // Only a draft can be confirmed, and only once every step is done. An order
    // already past draft reports false because there is nothing left to confirm
    // — not because something is wrong with it.
    canConfirm: full && order.status === 'draft' && preparationComplete,
    nextStage,
    stages,
    blockers: full ? buildBlockers(ctx) : [],
  };
}

/**
 * Confirm the order: the wizard's last act, and the only thing that moves a
 * sales order out of draft.
 *
 * Refuses if any step is unfinished, and says which — this is the ONE place in
 * the flow that is a genuine gate rather than a warning, because confirming is
 * a commitment to a customer and everything downstream (purchasing the steel,
 * scheduling the shop) reads it as one.
 *
 * ONE TRANSACTION (EU-7 / FIX-BE): readiness is computed BEFORE `BEGIN`, not
 * under the row lock — `orderReadiness` fans out ~10 pool queries on its own,
 * and holding a connection across `BEGIN…FOR UPDATE` for all of that starved
 * the pool at ~10 concurrent confirms. The lock is taken only around the
 * actual write, and the `UPDATE … WHERE status = 'draft'` was ALREADY the
 * real guard against two confirms racing — the SELECT…FOR UPDATE under it
 * just re-tests `status` first so a stale "ready" answer computed before the
 * lock gets a clean 409 instead of a silent no-op UPDATE.
 */
export async function confirmOrder(companyId, orderId) {
  const [[preRow]] = await pool.query(
    'SELECT status, order_type FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!preRow) { const e = new Error('Order not found'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }
  if (preRow.order_type === 'quote') {
    const e = new Error('This is a quote — convert it to a sales order before confirming.');
    e.status = 409; e.code = 'QUOTE_CANNOT_CONFIRM'; throw e;
  }
  if (preRow.status !== 'draft') {
    const e = new Error(`This order is already ${preRow.status.replace(/_/g, ' ')}.`);
    e.status = 409; throw e;
  }

  const readiness = await orderReadiness(companyId, orderId);
  if (!readiness.preparationComplete) {
    const unfinished = readiness.stages.filter((s) => !satisfied(s)).map((s) => s.label);
    const e = new Error(`Not ready to confirm — ${unfinished.join(', ')} still to finish.`);
    e.status = 422; e.code = 'NOT_READY'; e.readiness = readiness; throw e;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query(
      'SELECT status, order_type FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL FOR UPDATE',
      [orderId, companyId],
    );
    if (!row) { const e = new Error('Order not found'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }
    if (row.order_type === 'quote') {
      const e = new Error('This is a quote — convert it to a sales order before confirming.');
      e.status = 409; e.code = 'QUOTE_CANNOT_CONFIRM'; throw e;
    }
    if (row.status !== 'draft') {
      const e = new Error(`This order is already ${row.status.replace(/_/g, ' ')}.`);
      e.status = 409; throw e;
    }

    /**
     * `confirmed_date` is the PLANT's date, not the server's (§13 "DATETIME is
     * UTC, and you must never round-trip one through JS" / "The factory's clock
     * is not the server's"). `new Date().toISOString().slice(0,10)` was UTC —
     * wrong by a day for any plant west of it in the evening, or east of it
     * after 18:30 IST. `planService.plannerTimezone` is the existing resolver
     * (plant timezone, falling back to the company default when a company runs
     * more than one zone) — reused rather than re-derived, so the planner grid
     * and the sales order agree on what day it is.
     *
     * Still stamped by the server only (§13 "`confirmed_date` is stamped by the
     * server, never typed") — the COALESCE below still protects an existing
     * date from being overwritten.
     */
    const tz = await plannerTimezone(companyId);
    const today = zonedYMD(new Date(), tz);

    // status re-tested in the WHERE (on top of the row lock above) so the
    // UPDATE itself still refuses if something changed status between the
    // SELECT and here.
    await conn.query(
      `UPDATE fab_orders
          SET status = 'confirmed',
              confirmed_date = COALESCE(confirmed_date, ?),
              wizard_step = NULL
        WHERE id = ? AND company_id = ? AND status = 'draft' AND deleted_at IS NULL`,
      [today, orderId, companyId],
    );
    await conn.commit();

    /**
     * Catch up with where the work actually is.
     *
     * Everything that happens in the wizard happens to a DRAFT, and the status
     * automation refuses to advance a draft — deliberately, so the tree step
     * cannot walk an order past the confirmation nobody made. The cost of that
     * guard is that a production order raised and approved during the wizard
     * moved nothing, and confirming used to leave the order sitting at
     * `confirmed` while its production order was already in production, with
     * nothing scheduled to correct it.
     *
     * Confirming is the moment the guard stops applying, so it is the moment to
     * re-read. Best-effort: the order IS confirmed either way, and failing the
     * confirmation over a status refresh would be worse than a stale status.
     */
    try {
      await rollUpOrderStatus(pool, companyId, orderId);
    } catch (err) {
      logger.warn({ err, orderId }, '[readiness] status not re-read after confirm');
    }

    const [[fresh]] = await pool.query(
      'SELECT status FROM fab_orders WHERE id = ? AND company_id = ? LIMIT 1', [orderId, companyId],
    );
    return { ok: true, status: fresh?.status ?? 'confirmed', confirmedDate: today };
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection may already be gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * The explicit "go here" (A5) — the wizard rail today, an EU-19 Next/Back
 * button once the FE catches up. This, and ONLY this, may move `wizard_step`
 * backward or park it on a stage that is not yet satisfied: see the comment on
 * `refreshOrderStage` for why that split exists.
 */
export async function setWizardStep(companyId, orderId, step) {
  if (!STAGE_KEYS.includes(step)) {
    const e = new Error(`"${step}" is not a wizard step.`);
    e.status = 400; e.code = 'BAD_STEP'; throw e;
  }
  // A step nobody has reached cannot be opened — the rail hides it, and this
  // is the same rule for anything that bypasses the rail.
  const before = await orderReadiness(companyId, orderId);
  const target = before.stages.find((s) => s.key === step);
  if (target && target.state === 'pending') {
    const e = new Error(`${target.label} is not open yet — ${target.detail.toLowerCase()}.`);
    e.status = 409; e.code = 'STAGE_LOCKED'; e.readiness = before; throw e;
  }
  const [res] = await pool.query(
    `UPDATE fab_orders SET wizard_step = ?
      WHERE id = ? AND company_id = ? AND status = 'draft' AND deleted_at IS NULL`,
    [step, orderId, companyId],
  );
  if (!res.affectedRows) {
    const [[order]] = await pool.query(
      'SELECT status FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
      [orderId, companyId],
    );
    if (!order) { const e = new Error('Order not found'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }
    const e = new Error(`This order is ${order.status.replace(/_/g, ' ')} — its wizard step is fixed.`);
    e.status = 409; e.code = 'NOT_DRAFT'; throw e;
  }
  return orderReadiness(companyId, orderId);
}

/**
 * Recompute readiness and remember where the wizard has got to.
 *
 * The step is stored on the ORDER rather than kept in the browser, because the
 * whole point of the wizard being closable is that you can shut it on a Friday
 * and have someone else open it on Monday, on a different machine. A step held
 * in local state would make "close and come back" mean "close and start again".
 *
 * The status is deliberately untouched. Every step here happens inside a draft,
 * and only confirmOrder takes an order out of draft.
 *
 * ── ONE OWNER, FORWARD ONLY (A5) ─────────────────────────────────────────────
 *
 * `wizard_step` used to be overwritten by EVERY call here with `nextStage` —
 * the first stage anywhere in STAGE_KEYS that was not yet satisfied. That is
 * right the first time an order is built, and wrong forever after: park on
 * "Lines" to review a finished step, save an unrelated structure edit on a
 * different line, and the next `refreshOrderStage` call silently walked you
 * back to "Nesting" because THAT was still open — you never asked to leave.
 *
 * The fix is not "know when the user parked on purpose" (there is no column
 * for that, and the plan does not want one). It is narrower: this function now
 * only writes `wizard_step` in the two cases where there is nowhere honest to
 * leave it alone —
 *
 *   - `stored` is NULL. A brand-new order has no position yet; seed it.
 *   - EVERYTHING is now satisfied (`nextStage` is null). Park on the LAST
 *     stage, because that is where Confirm lives — and it is always a forward
 *     move, since being fully prepared means every earlier stage is satisfied
 *     too.
 *
 * Any other write leaves `wizard_step` exactly where the user (or a previous
 * call to this function) put it. Moving it BACKWARD, or to a stage that still
 * has work outstanding, is `setWizardStep`'s job alone — that is the "explicit
 * endpoint is the only writer of a backward move" the plan asks for, done
 * without a `wizard_step_pinned` column: nothing here ever writes anything but
 * NULL→something or "the end", so nothing here can ever undo an explicit
 * choice.
 *
 * `hint` (EU-7's `only`, threaded through): when a caller knows just ONE stage
 * could have moved, pass its key. If the order is currently parked EXACTLY on
 * that stage, this checks only that stage (skipping the other three stages'
 * queries) and nudges the step ONE position forward if it is now satisfied —
 * the same "you finished what you were looking at" logic as the full path,
 * scoped to what the caller actually knows changed. It never jumps past a
 * stage it did not check, and never fires if the user is parked somewhere
 * else. No current call site passes a hint; the mechanism exists for callers
 * that know their write is narrow (a single nesting accept, say) and would
 * rather not pay for procurement/production queries on every save.
 *
 * Best-effort — this is called from the tail of other people's writes and must
 * never be the reason one of them fails.
 */
export async function refreshOrderStage(companyId, orderId, { hint } = {}) {
  if (!orderId) return null;
  try {
    if (hint && STAGE_KEYS.includes(hint)) {
      // 'production' is the LAST of STAGE_KEYS — `idx + 1` never resolves, so
      // the nudge below could never fire for it. Every real caller today
      // hints 'production' (deploy/procurement routes), so running the
      // partial pass first was pure waste: more work than the plain full
      // path it always fell through to anyway. Skip straight there.
      if (STAGE_KEYS[STAGE_KEYS.length - 1] === hint) {
        return orderReadiness(companyId, orderId);
      }

      const partial = await orderReadiness(companyId, orderId, { only: [hint] });
      const [[stored]] = await pool.query(
        'SELECT status, wizard_step AS step FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
        [orderId, companyId],
      );
      if (!stored) return null;
      if (stored.status === 'draft' && stored.step === hint && partial.nextStage == null) {
        // the hinted stage is satisfied now — nudge the stored step forward.
        const idx = STAGE_KEYS.indexOf(hint);
        const step = STAGE_KEYS[idx + 1] ?? hint;
        if (step !== hint) {
          await pool.query(
            `UPDATE fab_orders SET wizard_step = ?
              WHERE id = ? AND company_id = ? AND status = 'draft' AND deleted_at IS NULL`,
            [step, orderId, companyId],
          );
          // The stored step actually moved, so the caller needs the real,
          // full picture — a partial readiness only ever answers for the one
          // stage it checked.
          return orderReadiness(companyId, orderId);
        }
      }
      // Nothing advanced: the partial readiness this already computed is all
      // that's needed, so don't pay for a second, full recompute.
      return partial;
    }

    const readiness = await orderReadiness(companyId, orderId);
    if (readiness.status !== 'draft') return readiness;

    const stored = readiness.wizardStep;
    let step = stored;
    if (stored == null) {
      step = readiness.nextStage ?? STAGE_KEYS[STAGE_KEYS.length - 1];
    } else if (readiness.nextStage == null) {
      step = STAGE_KEYS[STAGE_KEYS.length - 1];
    }
    if (step !== stored) {
      await pool.query(
        `UPDATE fab_orders SET wizard_step = ?
          WHERE id = ? AND company_id = ? AND status = 'draft' AND deleted_at IS NULL`,
        [step, orderId, companyId],
      );
      readiness.wizardStep = step;
    }
    return readiness;
  } catch (err) {
    logger.warn({ err, companyId, orderId }, '[readiness] refreshOrderStage failed');
    return null;
  }
}
