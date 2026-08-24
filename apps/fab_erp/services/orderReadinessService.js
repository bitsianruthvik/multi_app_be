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
import { missingFieldsForOrder } from './itemFieldService.js';
import { orderShortfall } from './procurementService.js';
import { procurementForOrder } from './procurementOrderService.js';
import { orderStageApplicability } from './stageApplicabilityService.js';
import { flowSummary } from './flowAllocationService.js';
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
 * Now: structure → flows → parameters → nesting. Flows need only the codes, and
 * `fab_flow_rules` maps (structure type, level, code suffix) → flow, so that
 * step is normally a button press. Parameters then asks for exactly the fields
 * those flows demand. Nesting last, because it needs the dimensions.
 */
export const STAGE_KEYS = ['lines', 'boq', 'flows', 'params', 'nesting', 'tasks', 'procurement', 'production'];

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
  const [short, pos, bomRows] = await Promise.all([
    orderShortfall(companyId, orderId),
    procurementForOrder(companyId, orderId),
    bomRowCount(companyId, orderId),
  ]);

  const needed = short.lines.length;
  const stillShort = short.lines.filter((l) => l.short > 0).length;
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
    detail = `All ${needed} bought-in item(s) covered by stock or on order`;
  }

  if (stillShort > 0) {
    state = pos.length > 0 ? 'partial' : 'todo';
    detail = `${stillShort} item(s) short — ${pos.length > 0
      ? `${pos.length} purchase order(s) raised so far`
      : 'nothing ordered yet'}`;
  }
  if (short.unmatched.length > 0) {
    // A bought-in row with no catalog item cannot be checked against stock or
    // purchased. Saying so is the only useful thing to do about it.
    detail += `; ${short.unmatched.length} bought-in row(s) have no catalog item`;
    if (state === 'done') state = 'partial';
  }
  return { state, covered, needed, detail };
}

/** Production readiness: does a production order exist, and does it own the make tasks? */
async function summariseProduction(companyId, orderId) {
  const [[agg]] = await pool.query(
    `SELECT COUNT(*) AS make_tasks,
            SUM(t.production_order_id IS NOT NULL) AS claimed
       FROM fab_project_tasks t
       JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
      WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
        AND COALESCE(i.procurement_type, 'make') = 'make'`,
    [companyId, orderId],
  );
  const makeTasks = Number(agg?.make_tasks) || 0;
  const claimed = Number(agg?.claimed) || 0;

  /**
   * "Nothing to make" and "tasks are not built yet" are different answers.
   *
   * The aggregate above counts TASKS, and tasks do not exist until the
   * production order is raised — that is what builds them. So `makeTasks === 0`
   * was true of every order that had not reached this step yet, and the step
   * reported itself DONE and green with "this order is entirely bought in" on
   * an order carrying hundreds of make items. Green on unfinished work is the
   * worst direction for this to be wrong in: it says there is nothing to do.
   *
   * The order's ITEMS are what say whether there is anything to make, and they
   * exist from the structure step onwards. Only when there are none of those is
   * the order genuinely bought in.
   */
  const [[items]] = await pool.query(
    `SELECT COUNT(*) AS make_items
       FROM fab_items i
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.flow_id IS NOT NULL
        AND COALESCE(i.procurement_type, 'make') = 'make'`,
    [companyId, orderId],
  );
  const makeItems = Number(items?.make_items) || 0;
  const bomRows = await bomRowCount(companyId, orderId);

  if (makeItems === 0 && makeTasks === 0) {
    return {
      state: 'done', claimed: 0, makeTasks: 0, makeItems: 0,
      detail: bomRows === 0
        ? 'Nothing in this order yet'
        : 'Nothing to make — every row is bought in',
    };
  }
  if (makeTasks === 0) {
    return {
      state: 'todo', claimed: 0, makeTasks: 0, makeItems,
      detail: `No production order raised yet — ${makeItems} item(s) are waiting to become tasks`,
    };
  }
  if (claimed === 0) {
    return { state: 'todo', claimed, makeTasks, detail: 'No production order raised yet' };
  }
  if (claimed < makeTasks) {
    return {
      state: 'partial', claimed, makeTasks,
      detail: `${makeTasks - claimed} make task(s) built since the production order was raised`,
    };
  }
  return {
    state: 'done', claimed, makeTasks,
    detail: `All ${makeTasks} make task(s) on the production order`,
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

  const [lines, tree, nest, tasks, flows, nestIntegrity] = await Promise.all([
    countLines(companyId, orderId),
    countTree(companyId, orderId),
    countNesting(companyId, orderId),
    countTasks(companyId, orderId),
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
  const [proc, production, fields] = await Promise.all([
    summariseProcurement(companyId, orderId),
    summariseProduction(companyId, orderId),
    // Never let a field-analysis failure take the whole strip down: the other
    // stages are still true and the order still has to be workable.
    missingFieldsForOrder(companyId, orderId).catch(() => ({
      itemsChecked: 0, itemsShort: 0, missingValues: [], unknownFields: [], noFormula: [],
    })),
  ]);
  const stages = [
    {
      key: 'lines',
      label: 'Line items',
      state: lines.total === 0 ? 'todo' : 'done',
      count: lines.total,
      total: lines.total,
      detail: lines.total === 0
        ? 'No line items yet'
        : lines.withoutType > 0
          ? `${lines.withoutType} line(s) have no structure type`
          : `${lines.total} line(s)`,
    },
    {
      key: 'boq',
      // "Structure", not "BOM": this step is the codes and quantities, and the
      // codes ARE the structure. Dimensions moved to `params`, which cannot be
      // asked until the flows are known.
      label: 'Structure',
      // Spans and girders with no parts under them is a half-entered BOQ, not
      // an empty one — the difference matters to someone deciding what to do next.
      state: tree.parts > 0 ? 'done' : tree.total > 0 ? 'partial' : 'todo',
      count: tree.total,
      total: tree.total,
      detail: tree.total === 0
        ? 'No structure entered'
        : `${tree.spans} span · ${tree.girders} girder · ${tree.segments} segment · ${tree.parts} part`,
    },
    {
      key: 'flows',
      label: 'Flows',
      state: flowState.state,
      count: flowState.withFlow,
      total: flowState.flowable,
      detail: flowState.detail,
    },
    {
      /**
       * The values the flows' formulas actually need.
       *
       * `todo` while any part is short, because a missing value does not error —
       * the engine reads it as 0, so the part is estimated as free to make and
       * every date computed from it is fiction. This is the stage that makes
       * that visible before the production order freezes it.
       */
      key: 'params',
      label: 'Parameters',
      state: fields.itemsChecked === 0 ? 'todo'
        : (fields.itemsShort > 0 || fields.unknownFields.length > 0) ? 'partial' : 'done',
      count: fields.itemsChecked - fields.itemsShort,
      total: fields.itemsChecked,
      detail: fields.itemsChecked === 0
        ? 'Assign flows first — they decide which values are needed'
        : fields.unknownFields.length > 0
          ? `${fields.unknownFields.length} operation(s) name a field that does not exist`
          : fields.itemsShort > 0
            ? `${fields.itemsShort} of ${fields.itemsChecked} part(s) missing values`
            : `All ${fields.itemsChecked} part(s) have what their operations need`,
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
      state: nest.parts === 0 ? 'todo'
        : nest.nested === 0 ? 'todo'
          : nest.nested < nest.parts ? 'partial'
            : nestBlocking.length > 0 ? 'partial' : 'done',
      count: nest.nested,
      total: nest.parts,
      detail: nest.parts === 0
        ? 'No parts to nest yet'
        : nest.nested < nest.parts
          ? `${nest.parts - nest.nested} of ${nest.parts} part(s) have no material`
          : nestBlocking.length > 0
            ? `All ${nest.parts} part(s) have material, but ${nestBlocking.length} `
              + `${nestBlocking.length === 1 ? 'problem' : 'problems'} would make it uncuttable — `
              + nestBlocking[0].message
            : `All ${nest.parts} part(s) have material`,
      /** The full list, so the screen can show every one rather than the first. */
      issues: nestBlocking,
    },
    {
      key: 'tasks',
      label: 'Project tree',
      state: tasks > 0 ? 'done' : 'todo',
      count: tasks,
      total: tasks,
      detail: tasks > 0 ? `${tasks} task(s) built` : 'Built when the production order is raised',
    },
    /**
     * The two steps that follow a finished tree: buy what we do not have, and
     * commit to making the rest.
     *
     * Both can legitimately be DONE with nothing raised. An order whose BOM is
     * entirely made in-house has nothing to purchase, and saying "todo" about a
     * step with no possible work would block Confirm on an action that does not
     * exist. Emptiness and completeness are the same state here.
     */
    {
      key: 'procurement',
      label: 'Procurement',
      state: proc.state,
      count: proc.covered,
      total: proc.needed,
      detail: proc.detail,
    },
    {
      key: 'production',
      label: 'Production',
      state: production.state,
      count: production.claimed,
      total: production.makeTasks,
      detail: production.detail,
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
    blockers: buildBlockers({ lines, tree, nest, flowState, tasks }),
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
 * What the order's structure contains.
 *
 * `level_kind` is only stamped by the Excel importer. A structure built by hand
 * in the tree left it NULL on every row, and this used to filter on
 * `level_kind IS NOT NULL` — so the stage reported "No structure entered" no
 * matter how much had been typed, the step never went green, and because
 * `preparationComplete` requires every stage done, Confirm stayed disabled too.
 * The only way through was to download the sheet and upload it back, which is
 * why the Excel round-trip felt mandatory rather than optional.
 *
 * So rows with no `level_kind` are now classified by SHAPE instead: a row with
 * no children is a part (it is the thing that gets made), a row with children
 * is structure above it. That is the same distinction the importer's labels
 * encode, derived from the tree rather than from who created the row, so it is
 * right for hand-built, imported, and half-and-half orders alike — including
 * the ones already sitting in the database with NULL on every row.
 *
 * Raw-material links are excluded throughout. They are children of a part, not
 * a level of the structure, and counting them would report every part twice.
 */
async function countTree(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT fi.id, fi.level_kind,
            EXISTS (SELECT 1 FROM fab_items c
                     WHERE c.parent_item_id = fi.id AND c.deleted_at IS NULL
                       AND c.catalog_item_id IS NULL) AS has_children
       FROM fab_items fi
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
        -- not a raw-material link: those hang under a part
        AND NOT ((fi.level_kind = 'material' OR (fi.level_kind IS NULL AND fi.catalog_item_id IS NOT NULL AND fi.flow_id IS NULL)))`,
    [companyId, orderId],
  );

  let spans = 0, girders = 0, segments = 0, parts = 0;
  for (const r of rows) {
    if (r.level_kind === 'material') continue;
    if (r.level_kind) {
      if (r.level_kind === 'span') spans++;
      else if (r.level_kind === 'girder') girders++;
      else if (r.level_kind === 'segment') segments++;
      else if (r.level_kind === 'part') parts++;
      continue;
    }
    // Unlabelled: a leaf is the thing that gets made.
    if (Number(r.has_children) === 0) parts++;
    else segments++;
  }
  return { spans, girders, segments, parts, total: spans + girders + segments + parts };
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
             AND (rm.level_kind = 'material' OR (rm.level_kind IS NULL AND rm.catalog_item_id IS NOT NULL AND rm.flow_id IS NULL))
      WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL
        AND p.level_kind = 'part'
        -- Made parts only, the same rule nesting itself applies. A shear stud is
        -- BOUGHT WHOLE: it is never cut from a plate, so counting it as
        -- un-nested holds the stage at partial over work nobody can ever do.
        -- Procurement is where a bought part is answered for.
        AND COALESCE(p.procurement_type, 'make') = 'make'`,
    [companyId, orderId],
  );
  return { parts: Number(row?.parts) || 0, nested: Number(row?.nested) || 0 };
}

async function countTasks(companyId, orderId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_project_tasks
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  return Number(row?.n) || 0;
}

// ── flows ────────────────────────────────────────────────────────────────────

/**
 * Turn a flowSummary into a stage.
 *
 * The hard part is that a flow-less item is usually CORRECT — spans and girders
 * are groupings and carry no flow at all. So "missing" cannot mean "has no
 * flow". It means: this level has a rule, so the company has said work happens
 * here, and yet this item has none. The company's own configuration defines the
 * intent, which is the only definition that stays right as their setup changes.
 */
function summariseFlows(summary) {
  const ruledLevels = new Set(summary.rules.map((r) => r.level));
  let withFlow = 0, flowable = 0, missing = 0;
  for (const lv of summary.levels) {
    withFlow += lv.withFlow;
    if (!ruledLevels.has(lv.level)) continue;
    flowable += lv.items;
    missing += lv.items - lv.withFlow;
  }
  const wouldAssign = summary.wouldAssign;   // fixable by pressing Apply
  const manual = Math.max(0, missing - wouldAssign); // need a choice

  let state, detail;
  if (wouldAssign > 0) {
    state = 'partial';
    detail = `${wouldAssign} item(s) match a rule but have no flow — press Apply`;
  } else if (missing > 0) {
    state = 'partial';
    detail = `${missing} item(s) have no flow and no rule matches`;
  } else if (withFlow > 0) {
    state = 'done';
    detail = `${withFlow} item(s) have a flow`;
  } else if (!summary.rules.length) {
    state = 'todo';
    detail = 'No flow rules are set up yet';
  } else {
    state = 'todo';
    detail = 'No item has a flow yet';
  }
  return { state, detail, withFlow, flowable, wouldAssign, manual, missing };
}

// ── blockers ─────────────────────────────────────────────────────────────────

/**
 * What someone should know before building tasks. Each one is a real
 * consequence, stated with its count — "38 items have no flow" is actionable in
 * a way that "some items may be skipped" never was.
 */
function buildBlockers({ lines, tree, nest, flowState, tasks }) {
  const out = [];

  if (tasks === 0) {
    out.push({
      stage: 'tasks', count: 0,
      message: 'The project tree has not been built, so this order has no schedule and no work on the floor.',
    });
  }

  if (lines.total === 0) {
    out.push({ stage: 'lines', count: 0, message: 'This order has no line items.' });
  }
  if (tree.parts === 0) {
    out.push({
      stage: 'boq', count: 0,
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
      stage: 'flows', count: flowState.wouldAssign,
      message: `${flowState.wouldAssign} item(s) match a flow rule but have no flow yet. Press Apply on the Flows tab and they will be included.`,
    });
  }
  if (flowState.manual > 0) {
    out.push({
      stage: 'flows', count: flowState.manual,
      message: `${flowState.manual} item(s) have no flow and no rule matches them. They will be skipped entirely — no tasks at all.`,
    });
  }
  if (flowState.withFlow === 0) {
    out.push({
      stage: 'flows', count: 0,
      message: 'No item on this order has a flow, so building tasks would produce nothing.',
    });
  }
  return out;
}
