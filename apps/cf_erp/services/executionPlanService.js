/**
 * executionPlanService.js — a sales order's EXECUTION PLAN (init.sql §72, TM/s72.sql): how the order is made
 * (its production orders) and how it is shipped (its dispatch units), captured before the design is frozen.
 * The rules are in executionPlanModel.js (pure); this file reads and writes cf_order_execution_plans.
 *
 *   GET /orders/:id/execution-plan
 *   PUT /orders/:id/execution-plan  { production?: { level, levelId? }, dispatch?: { level, levelId? },
 *                                     lines?: [{ lineId, own: null | { production, dispatch } }], dryRun? }
 *       own: null = the line follows the order's choice; a plan = the line's own. Lines not listed keep theirs.
 *       dryRun: nothing is written, and problems come back in the answer instead of a refusal — the screen's
 *       live preview.
 *
 * A FROZEN line's plan is fixed (user: "after freeze read-only, a change then needs a revision"). Changing the
 * order's choice while a frozen line follows it PINS that line to what it had, so a frozen line never moves. An
 * order that has stopped (closed, lost, cancelled, revised) does not change at all.
 *
 * ROUND TRIPS: the order, its lines and the plan rows side by side (3); each line's tree exploded side by side
 * (explode's own reads, per line — as processService does); one read of the rows' definitions. A save adds one
 * UPDATE (rows replaced, soft-deleted) and one multi-row INSERT, whatever the number of lines.
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import { explode } from './bomService.js';
import { LOCKED_ORDER_STATUSES } from './records.js';
import {
  DEFAULT_PLAN, DISPATCH_LEVELS, PRODUCTION_LEVELS, PREVIEW_LIMIT,
  checkLinePlan, effectivePlan, levelsOf, planWords, previewOrder, samePlan, sharedLevels, templatesFor,
} from './executionPlanModel.js';

/** The table is §72: a database without it answers "no plan saved" rather than failing the order page. */
export const planTableMissing = (e) => e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146;

/** The live plan rows of some orders (saver named). One read. */
export async function planRowsOf(db, companyId, orderIds) {
  if (!orderIds.length) return [];
  try {
    const [rows] = await db.query(
      `SELECT p.id, p.order_id, p.order_line_id, p.production_level, p.production_level_id, p.dispatch_level, p.dispatch_level_id,
              p.saved_at, p.saved_by, u.name AS saved_by_name
         FROM cf_order_execution_plans p
         LEFT JOIN users u ON u.id = p.saved_by
        WHERE p.company_id = ? AND p.order_id IN (?) AND p.deleted_at IS NULL`,
      [companyId, orderIds],
    );
    return rows;
  } catch (e) {
    if (planTableMissing(e)) return [];
    throw e;
  }
}

/** The sentence Freeze design refuses with while the order has no saved plan (lockService). */
export const SAVE_PLAN_FIRST = 'Save the execution plan first — it is filled in already (one production order per line, dispatched the same way): open the Execution plan step and press Save the plan.';

/**
 * Whether Freeze design must wait for the plan (coordinator, 2026-10-18: "Freeze design REFUSES while the order has
 * no saved execution plan"): the order's process has the Execution plan stage and no plan row is saved. A process
 * without the stage, or a database without §72, does not hold the freeze. One read.
 * → { required, saved }
 */
export async function planGate(db, companyId, orderId) {
  try {
    const [[r]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM cf_process_stages s JOIN cf_sales_orders o ON o.company_id = s.company_id AND o.process_id = s.process_id
                WHERE o.company_id = ? AND o.id = ? AND s.stage_key = 'execution_plan' AND s.deleted_at IS NULL) AS has_stage,
              (SELECT COUNT(*) FROM cf_order_execution_plans p WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL) AS saved_rows`,
      [companyId, orderId, companyId, orderId],
    );
    return { required: Number(r.has_stage) > 0, saved: Number(r.saved_rows) > 0 };
  } catch (e) {
    if (planTableMissing(e)) return { required: false, saved: false };
    throw e;
  }
}

/** Every node id in some trees. */
function nodeIds(trees) {
  const ids = new Set();
  const walk = (x) => { ids.add(x.id); x.children.forEach(walk); };
  for (const t of trees) if (t?.root) walk(t.root);
  return [...ids];
}

/** The definition each row was made from, by item id → { id, name }. One read. */
export async function definitionsOf(db, companyId, trees) {
  const ids = nodeIds(trees);
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT i.master_id, i.source_definition_id AS def_id, sd.name AS def_name
       FROM cf_item_details i
       JOIN cf_master_records sd ON sd.id = i.source_definition_id
      WHERE i.company_id = ? AND i.master_id IN (?) AND i.deleted_at IS NULL AND i.source_definition_id IS NOT NULL`,
    [companyId, ids],
  );
  for (const r of rows) out.set(Number(r.master_id), { id: Number(r.def_id), name: r.def_name });
  return out;
}

/**
 * Each line's plan, as the process stage reads it (processService 'execution_plan'): pure, off rows and trees
 * the caller already has. lines: rows with id, line_no, quantity, locked_at.
 * → Map(lineId → { saved, source, plan, problems, words, frozen })
 */
export function linePlanStates(rows, lines, trees, defOf) {
  const shapes = new Map(lines.map((l) => [l.id, trees.get(l.id) ? levelsOf(trees.get(l.id), defOf) : null]));
  const names = new Map();
  for (const s of shapes.values()) for (const lv of s?.levels ?? []) names.set(lv.id, lv.name);
  const out = new Map();
  for (const l of lines) {
    const { plan, source } = effectivePlan(rows, l.id);
    const shape = shapes.get(l.id);
    out.set(l.id, {
      saved: source !== 'default',
      source,
      plan,
      problems: checkLinePlan({ lineNo: l.line_no, quantity: Number(l.quantity) }, plan, shape, names),
      words: planWords(plan, { levels: [...names].map(([id, name]) => ({ id, name })) }),
      frozen: !!l.locked_at,
    });
  }
  return out;
}

/** The order, its lines, the plan rows, each line's tree and the definitions — productionOrderService (§76) reads it too. */
export async function loadAll(db, companyId, orderId, { lock = false } = {}) {
  const [[[order]], [lines], rows] = await Promise.all([
    db.query(`SELECT id, code, status, order_type FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, orderId]),
    db.query(
      `SELECT l.id, l.line_no, l.line_type, l.item_id, l.quantity, l.locked_at, m.code AS item_code, m.name AS item_name, i.sourcing,
              (SELECT COUNT(*) FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS releases
         FROM cf_sales_order_lines l
         LEFT JOIN cf_master_records m ON m.id = l.item_id
         LEFT JOIN cf_item_details i ON i.master_id = l.item_id AND i.deleted_at IS NULL
        WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL
        ORDER BY l.line_no, l.id`,
      [companyId, orderId],
    ),
    planRowsOf(db, companyId, [orderId]),
  ]);
  if (!order) throw notFound('Sales order');
  const trees = new Map(await Promise.all(lines.map(async (l) => [
    l.id, l.item_id ? await explode(db, companyId, l.item_id, { rootQuantity: Number(l.quantity), maxDepth: 15 }) : null,
  ])));
  const defs = await definitionsOf(db, companyId, [...trees.values()]);
  return { order, lines, rows, trees, defOf: (id) => defs.get(Number(id)) ?? null };
}

const frozenOf = (l) => !!l.locked_at || Number(l.releases) > 0;
/**
 * Whether a line makes anything: a line built from a template, a catalog item made or made-when-short, or any line
 * of a stock order (that order is what puts it in stock — rollOutService.madeRule). A line taken from stock as it
 * is has no production order.
 */
export const madeOf = (order, l) => order.order_type === 'stock' || l.line_type === 'custom' || (!!l.item_id && l.sourcing !== 'stock');

/** The answer GET and PUT both give. `rows` may be the rows a dry run WOULD write. */
function buildView({ order, lines, rows, trees, defOf }, { problems: extra = [], dryRun = false } = {}) {
  const shapes = new Map(lines.map((l) => [l.id, trees.get(l.id) ? levelsOf(trees.get(l.id), defOf) : null]));
  const names = new Map();
  for (const s of shapes.values()) for (const lv of s?.levels ?? []) names.set(lv.id, lv.name);
  const allLevels = { levels: [...names].map(([id, name]) => ({ id, name })) };
  const orderRow = rows.find((r) => r.order_line_id == null) ?? null;
  const orderPlan = orderRow ? effectivePlan([orderRow], -1).plan : { production: { ...DEFAULT_PLAN.production }, dispatch: { ...DEFAULT_PLAN.dispatch } };
  const stopped = LOCKED_ORDER_STATUSES.has(order.status);
  const shaped = lines.map((l) => {
    const { plan, source } = effectivePlan(rows, l.id);
    const shape = shapes.get(l.id);
    return {
      lineId: l.id, lineNo: l.line_no, lineType: l.line_type, quantity: Number(l.quantity),
      itemName: l.item_name ?? l.item_code ?? null, item: l.item_id ? { id: l.item_id, code: l.item_code ?? null, name: l.item_name ?? null } : null,
      plan, source, shape, tree: trees.get(l.id) ?? null, frozen: frozenOf(l), released: Number(l.releases) > 0, made: madeOf(order, l),
      problems: madeOf(order, l) ? checkLinePlan({ lineNo: l.line_no, quantity: Number(l.quantity) }, plan, shape, names) : [],
    };
  });
  const preview = previewOrder(order.code, shaped.filter((l) => l.made), defOf);
  const problems = [...extra, ...shaped.flatMap((l) => l.problems)];
  const savedRow = rows.reduce((best, r) => (!best || new Date(r.saved_at) > new Date(best.saved_at) ? r : best), null);
  // Only a line built from a template is frozen; a catalog line never is, so it does not keep the plan open.
  const freezable = lines.filter((l) => l.line_type === 'custom');
  const allFrozen = freezable.length > 0 && freezable.every(frozenOf);
  const readOnlyReason = stopped ? `${order.code} is ${order.status} — its plan does not change.`
    : allFrozen ? 'Every line is frozen, so the plan is fixed. A change needs a revision of the order.'
      : null;
  return {
    order: { id: order.id, code: order.code, status: order.status },
    dryRun,
    editable: !readOnlyReason,
    readOnlyReason,
    saved: orderRow || rows.length ? { at: savedRow?.saved_at ?? null, by: savedRow?.saved_by ? { id: savedRow.saved_by, name: savedRow.saved_by_name ?? null } : null } : null,
    plan: orderPlan,
    planWords: planWords(orderPlan, allLevels),
    defaults: DEFAULT_PLAN,
    choices: { production: PRODUCTION_LEVELS, dispatch: DISPATCH_LEVELS },
    lines: shaped.map((l) => ({
      lineId: l.lineId, lineNo: l.lineNo, lineType: l.lineType, quantity: l.quantity, item: l.item,
      frozen: l.frozen, released: l.released, made: l.made,
      own: l.source === 'line' ? l.plan : null,
      plan: l.plan,
      source: l.source,
      words: planWords(l.plan, allLevels),
      levels: l.shape?.levels ?? [],
      rows: l.shape?.rows ?? 0,
      productionCount: preview.perLine.get(l.lineId)?.production ?? 0,
      dispatchCount: preview.perLine.get(l.lineId)?.dispatch ?? null,
      problems: l.problems,
    })),
    levels: sharedLevels(shaped.filter((l) => l.made)).map(({ id, name, depth, lineNos, onEveryLine }) => ({ id, name, depth, lineNos, onEveryLine })),
    templates: templatesFor(shaped.filter((l) => l.made)),
    preview: { production: preview.production, dispatch: preview.dispatch, limit: PREVIEW_LIMIT },
    problems,
    note: 'The Production step makes the production orders from this plan (Create production orders). A line is nested until it has one; then its nesting is frozen.',
  };
}

export async function getExecutionPlan(db, companyId, orderId) {
  return buildView(await loadAll(db, companyId, orderId));
}

/** { level, levelId } from the body; problems said once each. */
function readChoice(raw, levels, what, problems) {
  if (raw === undefined) return undefined;
  const level = String(raw?.level ?? '').trim();
  if (!levels.includes(level)) {
    problems.push(`${what}: choose one of ${levels.join(', ')}.`);
    return undefined;
  }
  let levelId = null;
  if (level === 'assembly') {
    const id = Number(raw?.levelId);
    if (!Number.isInteger(id) || id <= 0) { problems.push(`${what}: choose the BOM level.`); return undefined; }
    levelId = id;
  }
  return { level, levelId };
}

/** A virtual stored row (the shape effectivePlan reads). */
const rowOf = (lineId, plan) => ({
  order_line_id: lineId, production_level: plan.production.level, production_level_id: plan.production.levelId,
  dispatch_level: plan.dispatch.level, dispatch_level_id: plan.dispatch.levelId,
});

export async function saveExecutionPlan(db, c, orderId, input = {}) {
  const dryRun = !!input.dryRun;
  const loaded = await loadAll(db, c.companyId, orderId, { lock: !dryRun });
  const { order, lines, rows } = loaded;
  const problems = [];

  if (LOCKED_ORDER_STATUSES.has(order.status)) {
    if (dryRun) return buildView(loaded, { dryRun, problems: [`${order.code} is ${order.status} — its plan does not change.`] });
    throw conflict('ORDER_STOPPED', `${order.code} is ${order.status} — its plan does not change.`);
  }

  // The order's own choice: what was sent, over what is stored, over the house default.
  const cur = rows.find((r) => r.order_line_id == null);
  const curOrder = cur ? effectivePlan([cur], -1).plan : { production: { ...DEFAULT_PLAN.production }, dispatch: { ...DEFAULT_PLAN.dispatch } };
  const prod = readChoice(input.production, PRODUCTION_LEVELS, 'Production orders', problems);
  const disp = readChoice(input.dispatch, DISPATCH_LEVELS, 'Dispatch', problems);
  const nextOrder = { production: prod ?? curOrder.production, dispatch: disp ?? curOrder.dispatch };

  // The lines' own plans: the stored ones, with what was sent on top.
  const byId = new Map(lines.map((l) => [Number(l.id), l]));
  const own = new Map(rows.filter((r) => r.order_line_id != null).map((r) => [Number(r.order_line_id), effectivePlan([r], r.order_line_id).plan]));
  const asked = new Set();
  for (const x of Array.isArray(input.lines) ? input.lines : []) {
    const lineId = Number(x?.lineId);
    const line = byId.get(lineId);
    if (!line) { problems.push(`Line ${x?.lineId ?? '?'} is not a line of ${order.code}.`); continue; }
    asked.add(lineId);
    if (x.own == null) { own.delete(lineId); continue; }
    const at = `Line ${line.line_no}`;
    const p = readChoice(x.own.production ?? DEFAULT_PLAN.production, PRODUCTION_LEVELS, `${at}, production orders`, problems);
    const d = readChoice(x.own.dispatch ?? DEFAULT_PLAN.dispatch, DISPATCH_LEVELS, `${at}, dispatch`, problems);
    if (p && d) own.set(lineId, { production: p, dispatch: d });
  }

  // Frozen lines never move: one the person changed is refused; one that only followed the order is pinned.
  const nextRowsOf = () => [rowOf(null, nextOrder), ...[...own].map(([id, plan]) => rowOf(id, plan))];
  for (const l of lines.filter(frozenOf)) {
    const before = effectivePlan(rows, l.id).plan;
    const after = effectivePlan(nextRowsOf(), l.id).plan;
    if (samePlan(before, after)) continue;
    if (asked.has(Number(l.id))) {
      problems.push(`Line ${l.line_no}'s design is frozen, so its plan is fixed. A change needs a revision of the order.`);
      own.set(Number(l.id), before);
    } else {
      own.set(Number(l.id), before);    // pinned: it keeps what it had
    }
  }
  // A line's own plan that equals the order's is not worth a row of its own (unless it is frozen and pinned).
  for (const [id, plan] of own) {
    const l = byId.get(id);
    if (samePlan(plan, nextOrder) && !frozenOf(l)) own.delete(id);
  }

  const nextRows = nextRowsOf();
  const view = buildView({ ...loaded, rows: nextRows.map((r) => ({ ...r, saved_at: new Date(), saved_by: c.userId ?? null })) }, { dryRun, problems });
  if (dryRun) return view;
  if (view.problems.length) throw invalid('INVALID', 'The execution plan needs attention.', { problems: view.problems });

  // Replace only what changed: soft-delete the old rows, insert the new — two statements for the whole order.
  const key = (r) => (r.order_line_id == null ? 'order' : `l${Number(r.order_line_id)}`);
  const stored = new Map(rows.map((r) => [key(r), r]));
  const wanted = new Map(nextRows.map((r) => [key(r), r]));
  const gone = [];
  const write = [];
  for (const [k, r] of stored) {
    const w = wanted.get(k);
    if (!w || !samePlan(effectivePlan([r], r.order_line_id ?? -1).plan, effectivePlan([w], w.order_line_id ?? -1).plan)) gone.push(r.id);
  }
  for (const [k, w] of wanted) {
    const r = stored.get(k);
    if (!r || gone.includes(r.id)) write.push(w);
  }
  if (gone.length) {
    await db.query('UPDATE cf_order_execution_plans SET deleted_at = NOW() WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, gone]);
  }
  if (write.length) {
    await db.query(
      `INSERT INTO cf_order_execution_plans
         (company_id, order_id, order_line_id, production_level, production_level_id, dispatch_level, dispatch_level_id, saved_by, saved_at)
       VALUES ${write.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, NOW())').join(', ')}`,
      write.flatMap((w) => [c.companyId, order.id, w.order_line_id, w.production_level, w.production_level_id, w.dispatch_level, w.dispatch_level_id, c.userId ?? null]),
    );
  }
  return getExecutionPlan(db, c.companyId, order.id);
}

/**
 * A revision takes the plan with it (revisionService.reviseOrder): the order's row, and each line's row onto the
 * line that revises it. Two set-based statements; nothing when the table is missing.
 */
export async function copyExecutionPlan(db, c, fromOrderId, toOrderId) {
  try {
    await db.query(
      `INSERT INTO cf_order_execution_plans
         (company_id, order_id, order_line_id, production_level, production_level_id, dispatch_level, dispatch_level_id, saved_by, saved_at)
       SELECT p.company_id, ?, NULL, p.production_level, p.production_level_id, p.dispatch_level, p.dispatch_level_id, p.saved_by, p.saved_at
         FROM cf_order_execution_plans p
        WHERE p.company_id = ? AND p.order_id = ? AND p.order_line_id IS NULL AND p.deleted_at IS NULL`,
      [toOrderId, c.companyId, fromOrderId],
    );
    await db.query(
      `INSERT INTO cf_order_execution_plans
         (company_id, order_id, order_line_id, production_level, production_level_id, dispatch_level, dispatch_level_id, saved_by, saved_at)
       SELECT p.company_id, ?, nl.id, p.production_level, p.production_level_id, p.dispatch_level, p.dispatch_level_id, p.saved_by, p.saved_at
         FROM cf_order_execution_plans p
         JOIN cf_sales_order_lines nl ON nl.company_id = p.company_id AND nl.revises_line_id = p.order_line_id AND nl.order_id = ? AND nl.deleted_at IS NULL
        WHERE p.company_id = ? AND p.order_id = ? AND p.order_line_id IS NOT NULL AND p.deleted_at IS NULL`,
      [toOrderId, toOrderId, c.companyId, fromOrderId],
    );
  } catch (e) {
    if (!planTableMissing(e)) throw e;
  }
}

/** Lines that go take their own rows with them (salesOrderService.retireLineOwnedRows). One statement. */
export async function retirePlanRowsOfLines(db, companyId, lineIds) {
  if (!lineIds.length) return;
  try {
    await db.query('UPDATE cf_order_execution_plans SET deleted_at = NOW() WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [companyId, lineIds]);
  } catch (e) {
    if (!planTableMissing(e)) throw e;
  }
}

/** An order that goes takes its whole plan. One statement. */
export async function retirePlanRowsOfOrder(db, companyId, orderId) {
  try {
    await db.query('UPDATE cf_order_execution_plans SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, orderId]);
  } catch (e) {
    if (!planTableMissing(e)) throw e;
  }
}
