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
 */

import { pool } from '../../../db.js';
import { NOT_A_BLANK } from './blankPredicate.js';
import { missingFieldsForOrder } from './itemFieldService.js';
import { isDimension } from './fieldDeriveService.js';
import { orderShortfall } from './procurementService.js';
import { procurementForOrder, onOrderByItem } from './procurementOrderService.js';
import { orderStageApplicability } from './stageApplicabilityService.js';
import { flowSummary } from './orderFlowService.js';
import { depthLabels, labelFor } from './depthLabelService.js';
import { checkOrderNesting, blockingIssues } from './nestingIntegrityService.js';
import { rollUpOrderStatus } from './taskEngineService.js';
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

/** "1 row", "82 rows" — no "row(s)". */
const n = (count, word, plural = `${word}s`) => `${Number(count).toLocaleString('en-IN')} ${Number(count) === 1 ? word : plural}`;

/** Everything that must be done before an order can be confirmed. */
const PREPARATION_STAGES = STAGE_KEYS;

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

async function summariseProcurement(companyId, orderId) {
  const [short, pos, onOrder, bomRows] = await Promise.all([
    orderShortfall(companyId, orderId),
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
  return {
    state: !needCut && !needFab ? 'done' : missing.length === 0 ? 'done' : mos.length ? 'partial' : 'todo',
    missing,
    count: mos.length,
    total: Number(needCut) + Number(needFab),
    deployed,
  };
}

/**
 * Full readiness for one order.
 *
 * @returns {Promise<{
 *   orderId: number, status: string, preparationComplete: boolean,
 *   nextStage: string|null,
 *   stages: Array<{key,label,state,count,total,detail}>,
 *   blockers: Array<{stage,count,message}>,
 * }>}
 */
export async function orderReadiness(companyId, orderId) {
  const [[order]] = await pool.query(
    'SELECT id, status, wizard_step FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

  const [lines, tree, nest, flows, nestIntegrity] = await Promise.all([
    countLines(companyId, orderId),
    countTree(companyId, orderId),
    countNesting(companyId, orderId),
    // Reusing flowSummary rather than re-deriving it: the Flows tab and the
    // strip must never disagree about how many items still need a flow.
    flowSummary(companyId, orderId),
    // Phase 5: a nesting that is physically impossible must not read as done.
    // Counting links was never enough — every part could have material and the
    // order still be uncuttable.
    checkOrderNesting(companyId, orderId).catch(() => ({ ok: true, issues: [] })),
  ]);
  const nestBlocking = blockingIssues(nestIntegrity);

  const flowState = summariseFlows(flows);
  /** Acceptance, as a fact on the database rather than a state on a screen. */
  const [[cutRow]] = await pool.query(
    `SELECT id FROM fab_orders
      WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
        AND mo_purpose = 'cutting' AND deleted_at IS NULL LIMIT 1`,
    [companyId, orderId],
  );
  const cuttingOrder = cutRow?.id ?? null;
  /** What nesting produced, in the two numbers the Nesting tab leads with. */
  const [[cut]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM fab_items i
               JOIN fab_item_catalog bc ON bc.id = i.catalog_item_id AND bc.material_form = 'blank'
              WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL AND i.node_kind = 'structure') AS blanks,
            (SELECT COUNT(DISTINCT nest_no) FROM fab_items
              WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
                AND node_kind = 'material' AND nest_no IS NOT NULL) AS sheets`,
    [companyId, orderId, companyId, orderId],
  );
  const [proc, production, fields] = await Promise.all([
    summariseProcurement(companyId, orderId),
    summariseProduction(companyId, orderId),
    // Never let a field-analysis failure take the whole strip down: the other
    // stages are still true and the order still has to be workable.
    missingFieldsForOrder(companyId, orderId).catch(() => ({
      itemsChecked: 0, itemsShort: 0, missingValues: [], unknownFields: [], unusableFields: [], noFormula: [],
    })),
  ]);

  /*
   * ONE ANALYSIS, TWO STAGES. `missingValues` lists what each part is short of;
   * splitting it by whether the field is a dimension is what lets the rectangle
   * be asked for before nesting and everything else after, without running the
   * whole field walk twice.
   *
   * A part short of BOTH counts against both, which is right: it is genuinely
   * not finished on either step.
   */
  const shortOnDims = fields.missingValues
    .filter((m) => m.missing.some(isDimension)).length;
  const shortOnRest = fields.missingValues
    .filter((m) => m.missing.some((k) => !isDimension(k))).length;

  const stages = [
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
      state: lines.total === 0 ? 'todo'
        : (lines.withoutType > 0 || tree.total === 0
           || tree.parts === 0 || shortOnDims > 0 || flowState.missing > 0) ? 'partial'
        : 'done',
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
            : shortOnDims > 0
              ? `${n(shortOnDims, 'part')} without a size`
              : flowState.missing > 0
                ? `${n(flowState.missing, 'row')} without a flow`
                : `${n(lines.total, 'line')} · ${n(tree.total, 'row')}`,
    },
    {
      key: 'nesting',
      label: 'Nesting',
      /**
       * Every part having material was never enough to call this done.
       * `nested >= parts` only counts links; it says nothing about whether the
       * nesting is physically possible. An order where a 3000 mm part is
       * declared as cut from a 2000 mm plate, or where a 16 mm part hangs off
       * 40 mm plate, would read "All 12 part(s) have material" and go green —
       * and the first person to find out was a cutter.
       */
      /*
       * AND THE PLAN MUST BE ACCEPTED. Links alone are not acceptance: a plan
       * can be looked at, re-nested and looked at again without anyone ever
       * committing to one, and the step said "done" throughout because the
       * PREVIOUS plan's links were still sitting there. Accepting is what
       * raises the cutting order, so the cutting order is what proves it.
       */
      state: nest.parts === 0 ? 'todo'
        : nest.nested === 0 ? 'todo'
          : nest.nested < nest.parts ? 'partial'
            : !cuttingOrder ? 'partial'
              : nestBlocking.length > 0 ? 'partial' : 'done',
      count: nest.nested,
      total: nest.parts,
      summary: cuttingOrder && Number(cut?.blanks) ? `${n(cut.blanks, 'blank')} · ${n(cut.sheets, 'sheet')}` : null,
      detail: nest.parts === 0
        ? 'Nothing to nest yet'
        : nest.nested < nest.parts
          ? `${n(nest.parts - nest.nested, 'part')} not on a sheet yet`
          : !cuttingOrder
            ? 'Plan not accepted yet'
          : nestBlocking.length > 0
            ? `${n(nestBlocking.length, 'problem')} to fix — ${nestBlocking[0].message}`
            : `Plan accepted — ${n(cut?.blanks ?? 0, 'blank')} on ${n(cut?.sheets ?? 0, 'sheet')}`,
      /** The full list, so the screen can show every one rather than the first. */
      issues: nestBlocking,
    },
    {
      /**
       * Everything a flow asks for that is NOT the rectangle — hole counts,
       * weld runs. Weight and area are absent on purpose: they are arithmetic
       * on the rectangle and are computed, never asked for.
       */
      key: 'params',
      label: 'Other params',
      state: fields.itemsChecked === 0 ? 'todo'
        : (shortOnRest > 0
          || fields.unknownFields.length > 0
          || (fields.unusableFields?.length ?? 0) > 0) ? 'partial' : 'done',
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
    },
    {
      /**
       * Buy, cut and make — one step. Done once everything bought is in stock
       * or requested, and a production order is drafted for the cutting and
       * for the fabrication.
       */
      key: 'production',
      label: 'Production',
      state: proc.state === 'done' && production.state === 'done' ? 'done'
        : proc.state === 'todo' && production.state === 'todo' ? 'todo' : 'partial',
      count: production.count,
      total: production.total,
      summary: production.total ? `${production.deployed}/${production.total} deployed` : null,
      detail: [
        proc.stillShort > 0 ? `Buy ${n(proc.stillShort, 'item')}` : null,
        production.missing.length
          ? `no ${production.missing.join(' or ')} order yet`
          : production.total
            ? (production.deployed === production.total
              ? 'all deployed'
              : `${n(production.total - production.deployed, 'draft')} to deploy`)
            : null,
      ].filter(Boolean).join(' · ') || proc.detail,
    },
  ];

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
  const applicability = await orderStageApplicability(companyId, orderId, STAGE_KEYS);
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

  for (const s of stages) {
    if (typeof s.detail === 'string' && s.detail) s.detail = s.detail[0].toUpperCase() + s.detail.slice(1);
  }
  const byKey = Object.fromEntries(stages.map((s) => [s.key, s]));
  /**
   * A stage that does not apply cannot hold the order up, and an OPTIONAL one
   * must not either — that is the whole of what "optional" buys. Both still
   * report their true state; they simply stop being gates.
   */
  const satisfied = (k) => {
    const s = byKey[k];
    return s.state === 'done' || s.state === 'not_applicable'
      || s.applicability === 'optional';
  };
  const preparationComplete = PREPARATION_STAGES.every(satisfied);
  const nextStage = stages.find((s) => !satisfied(s.key))?.key ?? null;

  return {
    orderId,
    status: order.status,
    wizardStep: order.wizard_step ?? null,
    preparationComplete,
    // Only a draft can be confirmed, and only once every step is done. An order
    // already past draft reports false because there is nothing left to confirm
    // — not because something is wrong with it.
    canConfirm: order.status === 'draft' && preparationComplete,
    nextStage,
    stages,
    blockers: buildBlockers({ lines, tree, nest, flowState, production }),
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
 */
export async function confirmOrder(companyId, orderId) {
  const readiness = await orderReadiness(companyId, orderId);
  if (readiness.status !== 'draft') {
    const e = new Error(`This order is already ${readiness.status.replace(/_/g, ' ')}.`);
    e.status = 409; throw e;
  }
  if (!readiness.preparationComplete) {
    const unfinished = readiness.stages.filter((s) => s.state !== 'done').map((s) => s.label);
    const e = new Error(`Not ready to confirm — ${unfinished.join(', ')} still to finish.`);
    e.status = 422; e.readiness = readiness; throw e;
  }

  // status re-tested in the WHERE so two people pressing Confirm at once cannot
  // both believe they were the one who did it.
  const today = new Date().toISOString().slice(0, 10);
  const [res] = await pool.query(
    `UPDATE fab_orders
        SET status = 'confirmed',
            confirmed_date = COALESCE(confirmed_date, ?),
            wizard_step = NULL
      WHERE id = ? AND company_id = ? AND status = 'draft' AND deleted_at IS NULL`,
    [today, orderId, companyId],
  );
  if (!res.affectedRows) {
    const e = new Error('This order was confirmed by someone else a moment ago.');
    e.status = 409; throw e;
  }

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
 * Best-effort — this is called from the tail of other people's writes and must
 * never be the reason one of them fails.
 */
export async function refreshOrderStage(companyId, orderId) {
  if (!orderId) return null;
  try {
    const readiness = await orderReadiness(companyId, orderId);
    if (readiness.status !== 'draft') return readiness;

    // nextStage is null once everything is done — park on the last step, which
    // is where the Confirm button lives.
    const step = readiness.nextStage ?? STAGE_KEYS[STAGE_KEYS.length - 1];
    if (step !== readiness.wizardStep) {
      await pool.query(
        `UPDATE fab_orders SET wizard_step = ?
          WHERE id = ? AND company_id = ? AND status = 'draft' AND deleted_at IS NULL`,
        [step, orderId, companyId],
      );
      readiness.wizardStep = step;
    }
    return readiness;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('refreshOrderStage failed', { companyId, orderId, err: err?.message });
    return null;
  }
}

// ── counts ───────────────────────────────────────────────────────────────────

async function countLines(companyId, orderId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(line_type IS NULL OR line_type = '') AS withoutType
       FROM fab_order_lines
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
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
 * treats as material to consume, and nestingSheetService writes.
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
        -- Made parts only, the same rule nesting itself applies. A shear stud is
        -- BOUGHT WHOLE: it is never cut from a plate, so counting it as
        -- un-nested holds the stage at partial over work nobody can ever do.
        -- Procurement is where a bought part is answered for.
        AND COALESCE(p.procurement_type, 'make') = 'make'`,
    [companyId, orderId],
  );
  return { parts: Number(row?.parts) || 0, nested: Number(row?.nested) || 0 };
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

// ── blockers ─────────────────────────────────────────────────────────────────

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
