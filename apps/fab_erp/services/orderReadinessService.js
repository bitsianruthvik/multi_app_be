/**
 * orderReadinessService.js — where has this order's wizard got to?
 *
 * A sales order is built in five steps, in this order:
 *
 *   lines → BOM → nesting → flows → project tree
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
import { orderShortfall } from './procurementService.js';
import { procurementForOrder } from './procurementOrderService.js';
import { flowSummary } from './flowAllocationService.js';

/**
 * The wizard's steps, in the order they happen.
 *
 * `procurement` and `production` were added 2026-08-13: once the tree is built,
 * the BOM has said what to buy and what to make, and each becomes a document.
 * They sit last because neither can be answered before the tree exists.
 */
export const STAGE_KEYS = ['lines', 'boq', 'nesting', 'flows', 'tasks', 'procurement', 'production'];

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
async function summariseProcurement(companyId, orderId) {
  const [short, pos] = await Promise.all([
    orderShortfall(companyId, orderId),
    procurementForOrder(companyId, orderId),
  ]);

  const needed = short.lines.length;
  const stillShort = short.lines.filter((l) => l.short > 0).length;
  const covered = needed - stillShort;

  let state = 'done';
  let detail = needed === 0
    ? 'Nothing to buy — this order is made entirely in-house'
    : `All ${needed} bought-in item(s) covered by stock or on order`;

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

  if (makeTasks === 0) {
    return {
      state: 'done', claimed: 0, makeTasks: 0,
      detail: 'Nothing to make — this order is entirely bought in',
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

  const [lines, tree, nest, tasks, flows] = await Promise.all([
    countLines(companyId, orderId),
    countTree(companyId, orderId),
    countNesting(companyId, orderId),
    countTasks(companyId, orderId),
    // Reusing flowSummary rather than re-deriving it: the Flows tab and the
    // strip must never disagree about how many items still need a flow.
    flowSummary(companyId, orderId),
  ]);

  const flowState = summariseFlows(flows);
  const [proc, production] = await Promise.all([
    summariseProcurement(companyId, orderId),
    summariseProduction(companyId, orderId),
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
      label: 'BOM',
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
      key: 'nesting',
      label: 'Nesting',
      state: nest.parts === 0 ? 'todo'
        : nest.nested === 0 ? 'todo'
          : nest.nested < nest.parts ? 'partial' : 'done',
      count: nest.nested,
      total: nest.parts,
      detail: nest.parts === 0
        ? 'No parts to nest yet'
        : nest.nested >= nest.parts
          ? `All ${nest.parts} part(s) have material`
          : `${nest.parts - nest.nested} of ${nest.parts} part(s) have no material`,
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
      key: 'tasks',
      label: 'Project tree',
      state: tasks > 0 ? 'done' : 'todo',
      count: tasks,
      total: tasks,
      detail: tasks > 0 ? `${tasks} task(s) built` : 'Not built yet',
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

  const byKey = Object.fromEntries(stages.map((s) => [s.key, s]));
  const preparationComplete = PREPARATION_STAGES.every((k) => byKey[k].state === 'done');
  const nextStage = stages.find((s) => s.state !== 'done')?.key ?? null;

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
  return { ok: true, status: 'confirmed', confirmedDate: today };
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

async function countTree(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT level_kind, COUNT(*) AS n
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND level_kind IS NOT NULL
      GROUP BY level_kind`,
    [companyId, orderId],
  );
  const by = Object.fromEntries(rows.map((r) => [r.level_kind, Number(r.n) || 0]));
  const spans = by.span ?? 0, girders = by.girder ?? 0, segments = by.segment ?? 0, parts = by.part ?? 0;
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
             AND rm.catalog_item_id IS NOT NULL AND rm.flow_id IS NULL
      WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL
        AND p.level_kind = 'part'`,
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
