/**
 * productionOrderService.js — PRODUCTION ORDERS (init.sql §76; contract TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 —
 * Step 4"). The production order is the unit production is released, tracked and dispatched by.
 *
 *   createProductionOrders   every production order the order's saved execution plan asks for that does not exist yet
 *                            (one INSERT). Needs a confirmed order whose made custom lines are frozen. A line released
 *                            the old way joins its production orders at once (they start Planned).
 *   releaseProductionOrders  Yet to plan → Planned, in bulk. A line not released yet is released WHOLE by the existing
 *                            engine (releaseService.releaseLine + takeMrEarmarks: the MR's earmarks become reservations),
 *                            then every piece and step of the line is stamped with its production order
 *                            (productionOrderModel.assignPieces). A step whose production order is still Yet to plan
 *                            cannot start (releaseService.evaluate / floorService.stepProblem).
 *   takeBackProductionOrder  Planned → Yet to plan while none of its steps has started; the line's release is taken
 *                            back too when no other production order of it is released.
 *   dispatchProductionOrder  ships its finished units through dispatchService.shipLine (stock issue → invoice / billing
 *                            "dispatched"); Closed when every unit it makes has shipped. Per the plan's dispatch level:
 *                            'unit' ships each finished unit as it comes; otherwise the whole order is done first.
 *   listProductionOrdersOf / readProductionOrder   what the planner (step 5) and work orders (step 6) read.
 *
 * ROUND TRIPS: reads are set-based — the orders, then ONE aggregate of their steps and ONE of their units, whatever
 * the count. Release runs the release engine once per line not yet released (its own fixed reads) and stamps a line's
 * pieces with ≤ 1 UPDATE per 1,000 pieces + 1 for the steps.
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import { likeOf } from '../lib/listing.js';
import { LOCKED_ORDER_STATUSES } from './records.js';
import { loadAll, madeOf } from './executionPlanService.js';
import { effectivePlan, levelsOf, checkLinePlan } from './executionPlanModel.js';
import { PO_STATES, PO_STATE_LABEL, assignPieces, plannedProductionOrders, stateOf } from './productionOrderModel.js';
import { releaseLine, takeMrEarmarks, unrelease, evaluatedTracker, shapeStep } from './releaseService.js';
import { shipLine } from './dispatchService.js';
import { estimatorForLine, estimateOnMachine } from './timeEstimateService.js';

export { PO_STATES, PO_STATE_LABEL };

const EPS = 1e-6;
const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Number(Number(n).toFixed(3));
const blank = (v) => v == null || String(v).trim() === '';
const parseJson = (v, d) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };
const pad2 = (n) => String(n).padStart(2, '0');

const PO_SQL = `SELECT po.*, o.code AS order_code, o.status AS order_status, o.order_type, o.title AS order_title, o.customer_id,
                       p.name AS customer_name, l.line_no, ru.name AS released_by_name
                  FROM cf_production_orders po
                  JOIN cf_sales_orders o ON o.id = po.order_id
                  LEFT JOIN cf_parties p ON p.id = o.customer_id
                  LEFT JOIN cf_sales_order_lines l ON l.id = po.order_line_id
                  LEFT JOIN users ru ON ru.id = po.released_by`;

/** Steps and units of some production orders, side by side: two set-based reads. */
async function figuresOf(db, companyId, ids) {
  if (!ids.length) return { steps: new Map(), units: new Map() };
  const [[stepRows], [unitRows]] = await Promise.all([
    db.query(
      `SELECT s.production_order_id AS id, COUNT(*) AS steps, SUM(s.state = 'done') AS done, SUM(s.state = 'on_hold') AS on_hold,
              SUM(s.state <> 'pending' OR s.started_at IS NOT NULL OR s.qty_good > 0) AS started,
              SUM(s.eff_minutes IS NOT NULL) AS with_min, SUM(COALESCE(s.eff_minutes, 0)) AS minutes,
              SUM(COALESCE(s.eff_minutes, 0) * IF(s.state = 'done', 1, LEAST(1, COALESCE(s.qty_good / NULLIF(s.quantity, 0), 0)))) AS minutes_done
         FROM cf_production_steps s
        WHERE s.company_id = ? AND s.production_order_id IN (?) AND s.deleted_at IS NULL
        GROUP BY s.production_order_id`,
      [companyId, ids],
    ),
    db.query(
      `SELECT pi.production_order_id AS id, r.order_line_id AS line_id, SUM(pi.quantity) AS units, SUM(LEAST(pi.stocked_qty, pi.quantity)) AS finished
         FROM cf_production_items pi
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
        WHERE pi.company_id = ? AND pi.production_order_id IN (?) AND pi.depth = 0 AND pi.deleted_at IS NULL
        GROUP BY pi.production_order_id, r.order_line_id`,
      [companyId, ids],
    ),
  ]);
  const steps = new Map(stepRows.map((r) => [Number(r.id), r]));
  const units = new Map();
  for (const u of unitRows) {
    if (!units.has(Number(u.id))) units.set(Number(u.id), []);
    units.get(Number(u.id)).push({ lineId: Number(u.line_id), units: Number(u.units), finished: Number(u.finished) });
  }
  return { steps, units };
}

/** One production order as every screen shows it. */
function shape(po, figures) {
  const agg = figures.steps.get(Number(po.id)) ?? null;
  const state = stateOf(po.status, agg);
  const steps = Number(agg?.steps ?? 0);
  const done = Number(agg?.done ?? 0);
  const minutes = Number(agg?.minutes ?? 0);
  const byMinutes = steps > 0 && Number(agg?.with_min ?? 0) === steps && minutes > 0;
  const pct = steps === 0 ? (state === 'closed' || state === 'dispatch' ? 100 : 0)
    : byMinutes ? (Number(agg.minutes_done) / minutes) * 100 : (done / steps) * 100;
  const shipped = parseJson(po.shipped_json, {}) ?? {};
  const units = (figures.units.get(Number(po.id)) ?? []).map((u) => ({ ...u, shipped: Number(shipped[u.lineId] ?? 0) }));
  return {
    id: po.id,
    code: po.code,
    label: po.label,
    seq: po.seq,
    order: { id: po.order_id, code: po.order_code, status: po.order_status, type: po.order_type, title: po.order_title ?? null,
      customer: po.customer_id ? { id: po.customer_id, name: po.customer_name ?? null } : null },
    level: po.level,
    levelId: po.level_id ?? null,
    line: po.order_line_id ? { id: po.order_line_id, lineNo: po.line_no } : null,
    lineIds: parseJson(po.lines_json, []),
    unitNo: po.unit_no ?? null,
    scopeKey: po.scope_key,
    dispatch: { level: po.dispatch_level, levelId: po.dispatch_level_id ?? null },
    status: po.status,
    state,
    stateLabel: PO_STATE_LABEL[state],
    progress: { pct: r1(Math.min(100, pct)), basis: byMinutes ? 'minutes' : 'steps', steps, done, onHold: Number(agg?.on_hold ?? 0), started: Number(agg?.started ?? 0),
      minutes: r3(minutes), minutesDone: r3(Number(agg?.minutes_done ?? 0)) },
    units,
    releasedAt: po.released_at ?? null,
    releasedBy: po.released_by_name ?? null,
    dispatchedAt: po.dispatched_at ?? null,
    actions: {
      release: po.status === 'yet_to_plan',
      takeBack: po.status === 'planned' && Number(agg?.started ?? 0) === 0,
      dispatch: po.status === 'planned' && (state === 'dispatch' || (['unit'].includes(po.dispatch_level) && units.some((u) => u.finished - u.shipped > EPS))),
    },
  };
}

/**
 * Production orders, shaped — what the planner (step 5) and contractor work orders (step 6) read.
 * q: { orderIds?, ids?, states? } → [shaped]. Three reads.
 */
export async function listProductionOrdersOf(db, companyId, q = {}) {
  const where = ['po.company_id = ?', 'po.deleted_at IS NULL'];
  const params = [companyId];
  if (q.orderIds?.length) { where.push('po.order_id IN (?)'); params.push(q.orderIds.map(Number)); }
  if (q.ids?.length) { where.push('po.id IN (?)'); params.push(q.ids.map(Number)); }
  const [rows] = await db.query(`${PO_SQL} WHERE ${where.join(' AND ')} ORDER BY o.code, po.seq`, params);
  const figures = await figuresOf(db, companyId, rows.map((r) => r.id));
  const out = rows.map((r) => shape(r, figures));
  return q.states?.length ? out.filter((x) => q.states.includes(x.state)) : out;
}

/** One production order with its pieces' steps (from the tracker), capped at 400 pieces. */
export async function readProductionOrder(db, companyId, id) {
  const [po] = await listProductionOrdersOf(db, companyId, { ids: [Number(id)] });
  if (!po) throw notFound('Production order');
  const [rels] = await db.query(
    'SELECT id, order_line_id FROM cf_production_releases WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL',
    [companyId, po.lineIds.length ? po.lineIds : [0]],
  );
  const pieces = [];
  let piecesTotal = 0;
  if (rels.length && po.status !== 'yet_to_plan') {
    const data = await evaluatedTracker(db, companyId, rels.map((r) => r.id));
    for (const it of data?.items ?? []) {
      if (Number(it.production_order_id) !== Number(po.id)) continue;
      const steps = data.stepsOf.get(it.id) ?? [];
      if (!steps.length) continue;
      piecesTotal += 1;
      if (pieces.length >= 400) continue;
      pieces.push({ id: it.id, label: it._label, code: it.code, depth: it.depth, status: it._status, steps: steps.map((s) => shapeStep(s, it._label)) });
    }
  }
  return { ...po, releases: rels.map((r) => ({ id: r.id, lineId: r.order_line_id })), pieces, piecesTotal };
}

/* ===========================================================================
 * Stamping a released line's pieces with their production orders
 * ======================================================================== */

/** Every piece and step of these lines' live releases gets its production order. A fixed handful of statements a line. */
export async function stampLines(db, c, lineIds) {
  const ids = [...new Set(lineIds.map(Number))];
  if (!ids.length) return 0;
  const [[rels], [orders]] = await Promise.all([
    db.query('SELECT id, order_id, order_line_id FROM cf_production_releases WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [c.companyId, ids]),
    db.query(
      `SELECT po.id, po.scope_key, po.level, po.level_id, po.lines_json FROM cf_production_orders po
        WHERE po.company_id = ? AND po.deleted_at IS NULL
          AND po.order_id IN (SELECT order_id FROM cf_sales_order_lines WHERE company_id = ? AND id IN (?))`,
      [c.companyId, c.companyId, ids],
    ),
  ]);
  if (!rels.length || !orders.length) return 0;
  const [items] = await db.query(
    `SELECT pi.id, pi.release_id, pi.parent_id, pi.depth, pi.sort_order, pi.bom_line_id, pi.item_id, pi.piece_no, pi.quantity
       FROM cf_production_items pi WHERE pi.company_id = ? AND pi.release_id IN (?) AND pi.deleted_at IS NULL`,
    [c.companyId, rels.map((r) => r.id)],
  );
  const itemIds = [...new Set(items.map((i) => i.item_id))];
  const [defs] = itemIds.length ? await db.query(
    'SELECT master_id, source_definition_id FROM cf_item_details WHERE company_id = ? AND master_id IN (?) AND deleted_at IS NULL AND source_definition_id IS NOT NULL',
    [c.companyId, itemIds],
  ) : [[]];
  const defMap = new Map(defs.map((d) => [Number(d.master_id), { id: Number(d.source_definition_id) }]));
  const byRelease = new Map();
  for (const it of items) { if (!byRelease.has(it.release_id)) byRelease.set(it.release_id, []); byRelease.get(it.release_id).push(it); }
  const pairs = [];
  for (const r of rels) {
    const mine = orders.filter((o) => parseJson(o.lines_json, []).map(Number).includes(Number(r.order_line_id)));
    const map = assignPieces(Number(r.order_line_id), byRelease.get(r.id) ?? [], mine, (itemId) => defMap.get(Number(itemId)) ?? null);
    for (const [itemId, poId] of map) pairs.push([itemId, poId]);
  }
  for (let i = 0; i < pairs.length; i += 1000) {
    const part = pairs.slice(i, i + 1000);
    await db.query(
      `UPDATE cf_production_items SET production_order_id = CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
      [...part.flat(), c.companyId, part.map((p) => p[0])],
    );
  }
  await db.query(
    `UPDATE cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
        SET s.production_order_id = pi.production_order_id
      WHERE s.company_id = ? AND pi.company_id = ? AND pi.release_id IN (?) AND s.deleted_at IS NULL`,
    [c.companyId, c.companyId, rels.map((r) => r.id)],
  );
  // Step 6 (§85): the steps of cells given to a contractor carry their work order. Loaded late (it imports this file).
  await (await import('./contractorWorkOrderService.js')).stampContractorSteps(db, c, { lineIds: ids });
  return pairs.length;
}

/* ===========================================================================
 * Creating them from the execution plan
 * ======================================================================== */

/** The plan's production orders for an order, what exists, and why it cannot make them (or null). */
async function planOf(db, companyId, orderId, { lock = false } = {}) {
  const loaded = await loadAll(db, companyId, orderId, { lock });
  const { order, lines, rows, trees, defOf } = loaded;
  const made = lines.filter((l) => madeOf(order, l));
  const shapes = new Map(made.map((l) => [l.id, trees.get(l.id) ? levelsOf(trees.get(l.id), defOf) : null]));
  const names = new Map();
  for (const s of shapes.values()) for (const lv of s?.levels ?? []) names.set(lv.id, lv.name);
  const problems = [];
  const shaped = made.map((l) => {
    const { plan } = effectivePlan(rows, l.id);
    problems.push(...checkLinePlan({ lineNo: l.line_no, quantity: Number(l.quantity) }, plan, shapes.get(l.id), names));
    return { lineId: l.id, lineNo: l.line_no, quantity: Number(l.quantity), itemName: l.item_name ?? l.item_code ?? null, plan, shape: shapes.get(l.id), tree: trees.get(l.id) ?? null };
  });
  const planned = plannedProductionOrders(order.code, shaped, defOf);
  let why = null;
  if (LOCKED_ORDER_STATUSES.has(order.status)) why = `${order.code} is ${order.status} — nothing more is made for it.`;
  else if (order.status !== 'confirmed') why = order.order_type === 'customer'
    ? "Production orders are made once the customer's acceptance is approved (the order is confirmed)."
    : 'Confirm the order first — production orders are made for a confirmed order.';
  else if (!made.length) why = 'Nothing on this order is made — every line comes from stock.';
  else {
    const open = made.filter((l) => l.line_type === 'custom' && !l.locked_at);
    if (open.length) why = `Freeze the design of ${open.length === 1 ? `line ${open[0].line_no}` : `lines ${open.map((l) => l.line_no).join(', ')}`} first.`;
    else if (problems.length) why = problems[0];
  }
  return { order, lines, made, planned, why, problems };
}

/**
 * POST /orders/:id/production-orders { dryRun? } — every production order the plan asks for that does not exist yet.
 * → the order's production view (getOrderProductionOrders), with `created`.
 */
export async function createProductionOrders(db, c, orderId, input = {}) {
  const dryRun = !!input.dryRun;
  const p = await planOf(db, c.companyId, orderId, { lock: !dryRun });
  const [existing] = await db.query(
    `SELECT id, seq, scope_key FROM cf_production_orders WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL${dryRun ? '' : ' FOR UPDATE'}`,
    [c.companyId, p.order.id],
  );
  const have = new Set(existing.map((e) => e.scope_key));
  const toMake = p.planned.filter((x) => !have.has(x.scopeKey));
  if (dryRun) return { toCreate: toMake.length, labels: toMake.slice(0, 60).map((x) => x.label), why: toMake.length ? p.why : null };
  if (!toMake.length) throw invalid('NOTHING_TO_CREATE', existing.length ? 'Every production order of the plan exists already.' : p.why ?? 'The plan asks for no production order.');
  if (p.why) throw invalid('NOT_READY', p.why, { problems: p.problems });
  // A line released the old way joins its production orders at once: they start Planned.
  const releasedLines = new Set(p.lines.filter((l) => Number(l.releases) > 0).map((l) => Number(l.id)));
  let seq = existing.reduce((m, e) => Math.max(m, Number(e.seq)), 0);
  const rows = toMake.map((x) => {
    seq += 1;
    const legacy = x.lineIds.some((id) => releasedLines.has(id));
    return [c.companyId, p.order.id, seq, `${p.order.code}-P${pad2(seq)}`, x.label.slice(0, 400), x.level, x.levelId, x.lineId, x.unitNo, x.scopeKey.slice(0, 400),
      JSON.stringify(x.lineIds), x.dispatchLevel, x.dispatchLevelId, legacy ? 'planned' : 'yet_to_plan', legacy ? new Date() : null, legacy ? c.userId ?? null : null, c.userId ?? null];
  });
  await db.query(
    `INSERT INTO cf_production_orders (company_id, order_id, seq, code, label, level, level_id, order_line_id, unit_no, scope_key,
       lines_json, dispatch_level, dispatch_level_id, status, released_at, released_by, created_by) VALUES ?`,
    [rows],
  );
  const touched = [...new Set(toMake.flatMap((x) => x.lineIds))].filter((id) => releasedLines.has(id));
  if (touched.length) await stampLines(db, c, touched);
  return { ...(await getOrderProductionOrders(db, c.companyId, p.order.id)), created: toMake.length };
}

/* ===========================================================================
 * Release, take back, dispatch
 * ======================================================================== */

async function lockOrders(db, companyId, ids) {
  const want = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!want.length) throw invalid('INVALID', 'Say which production orders: { ids: [...] }.');
  const [rows] = await db.query(`${PO_SQL} WHERE po.company_id = ? AND po.id IN (?) AND po.deleted_at IS NULL FOR UPDATE`, [companyId, want]);
  if (rows.length !== want.length) throw notFound(want.length === 1 ? 'Production order' : 'Some of those production orders');
  return rows;
}

/**
 * POST /production-orders/release { ids, finishedAreaId?, notes? } — Yet to plan → Planned, all or none.
 * → { released: [codes], fromMr: [{ lineId, reserved }], productionOrders: [shaped] }
 */
export async function releaseProductionOrders(db, c, input = {}) {
  const pos = await lockOrders(db, c.companyId, input.ids);
  const problems = [];
  for (const po of pos) {
    if (po.status !== 'yet_to_plan') problems.push(`${po.code} is ${PO_STATE_LABEL[po.status === 'closed' ? 'closed' : 'planned'].toLowerCase()} already.`);
    else if (po.order_status !== 'confirmed') problems.push(`${po.code}: order ${po.order_code} is ${po.order_status} — production orders are released for a confirmed order.`);
  }
  if (problems.length) throw invalid('NOT_RELEASABLE', problems.length === 1 ? problems[0] : 'Some of these production orders cannot be released.', { problems });
  const lineIds = [...new Set(pos.flatMap((po) => parseJson(po.lines_json, []).map(Number)))];
  const [rels] = await db.query('SELECT order_line_id FROM cf_production_releases WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [c.companyId, lineIds]);
  const released = new Set(rels.map((r) => Number(r.order_line_id)));
  const fromMr = [];
  for (const lineId of lineIds) {
    if (released.has(lineId)) continue;
    // The existing release engine, whole line (the tracker, steps, waits, material) — then the MR's earmarks.
    const out = await releaseLine(db, c, lineId, { finishedAreaId: input.finishedAreaId, notes: input.notes, view: 'none' });
    const mr = await takeMrEarmarks(db, c, out.id);
    fromMr.push({ lineId, requisition: mr.requisition, reserved: mr.reserved, left: mr.left });
  }
  await db.query(
    "UPDATE cf_production_orders SET status = 'planned', released_at = NOW(), released_by = ? WHERE company_id = ? AND id IN (?)",
    [c.userId ?? null, c.companyId, pos.map((p) => p.id)],
  );
  await stampLines(db, c, lineIds);
  return {
    released: pos.map((p) => p.code),
    fromMr,
    productionOrders: await listProductionOrdersOf(db, c.companyId, { ids: pos.map((p) => p.id) }),
  };
}

/** POST /production-orders/:id/take-back — Planned → Yet to plan while nothing of it started. */
export async function takeBackProductionOrder(db, c, id) {
  const [po] = await lockOrders(db, c.companyId, [id]);
  if (po.status !== 'planned') throw conflict('NOT_PLANNED', `${po.code} is not released — there is nothing to take back.`);
  const [[agg]] = await db.query(
    `SELECT COUNT(*) AS started FROM cf_production_steps WHERE company_id = ? AND production_order_id = ? AND deleted_at IS NULL
        AND (state <> 'pending' OR started_at IS NOT NULL OR qty_good > 0 OR qty_scrap > 0)`,
    [c.companyId, po.id],
  );
  if (Number(agg.started)) throw conflict('STARTED', `Work has started on ${po.code} — a started production order is not taken back.`);
  await db.query("UPDATE cf_production_orders SET status = 'yet_to_plan', released_at = NULL, released_by = NULL WHERE company_id = ? AND id = ?", [c.companyId, po.id]);
  // A line no other released production order needs goes back too (nothing started, nothing issued — unrelease checks).
  const lines = parseJson(po.lines_json, []).map(Number);
  const [others] = await db.query(
    "SELECT lines_json FROM cf_production_orders WHERE company_id = ? AND order_id = ? AND id <> ? AND deleted_at IS NULL AND status <> 'yet_to_plan'",
    [c.companyId, po.order_id, po.id],
  );
  const stillNeeded = new Set(others.flatMap((o) => parseJson(o.lines_json, []).map(Number)));
  const free = lines.filter((l) => !stillNeeded.has(l));
  let takenBack = 0;
  if (free.length) {
    const [rels] = await db.query('SELECT id FROM cf_production_releases WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [c.companyId, free]);
    for (const r of rels) { await unrelease(db, c, r.id); takenBack += 1; }
  }
  const [shaped] = await listProductionOrdersOf(db, c.companyId, { ids: [po.id] });
  return { productionOrder: shaped, releasesTakenBack: takenBack };
}

/**
 * POST /production-orders/:id/dispatch { reference?, movementDate? } — ships what it has finished of each line
 * (dispatchService.shipLine: the stock issue, the invoice / billing "dispatched"); Closed when it has all gone.
 */
export async function dispatchProductionOrder(db, c, id, input = {}) {
  const [po] = await lockOrders(db, c.companyId, [id]);
  const [shaped] = await listProductionOrdersOf(db, c.companyId, { ids: [po.id] });
  if (po.status === 'yet_to_plan') throw conflict('NOT_RELEASED', `${po.code} is not released yet.`);
  if (po.status === 'closed') throw conflict('CLOSED', `${po.code} is closed — it has been dispatched.`);
  const perUnit = po.dispatch_level === 'unit';
  if (shaped.state !== 'dispatch' && !perUnit) {
    throw invalid('NOT_FINISHED', `${po.code} is not finished — ${shaped.progress.steps - shaped.progress.done} of ${shaped.progress.steps} steps still to do.`);
  }
  const shipped = parseJson(po.shipped_json, {}) ?? {};
  const shipments = [];
  if (po.order_type !== 'stock') {
    for (const u of shaped.units) {
      const want = r3(u.finished - Number(shipped[u.lineId] ?? 0));
      if (want <= EPS) continue;
      const out = await shipLine(db, c, u.lineId, {
        quantity: want, view: 'none', movementDate: input.movementDate,
        reference: blank(input.reference) ? `${po.code}` : String(input.reference).slice(0, 100),
        notes: `Dispatched with production order ${po.code} (${po.label})`.slice(0, 500),
      });
      shipped[u.lineId] = r3(Number(shipped[u.lineId] ?? 0) + Number(out.shipped));
      shipments.push({ lineId: u.lineId, shipped: Number(out.shipped), movementId: out.movement?.id ?? null, invoice: out.invoice ?? null });
    }
  }
  // A sub-assembly makes none of the line's item: it is recorded and closed (it leaves with its unit).
  const allGone = shaped.units.every((u) => Number(shipped[u.lineId] ?? 0) + EPS >= u.units) || po.order_type === 'stock';
  const close = shaped.state === 'dispatch' && allGone;
  if (!shipments.length && !close) throw invalid('NOTHING_READY', `Nothing of ${po.code} is finished and waiting to go.`);
  await db.query(
    `UPDATE cf_production_orders SET shipped_json = ?, status = ?, dispatched_at = ${close ? 'NOW()' : 'dispatched_at'}, dispatched_by = ${close ? '?' : 'dispatched_by'}
      WHERE company_id = ? AND id = ?`,
    [JSON.stringify(shipped), close ? 'closed' : po.status, ...(close ? [c.userId ?? null] : []), c.companyId, po.id],
  );
  const [after] = await listProductionOrdersOf(db, c.companyId, { ids: [po.id] });
  return { productionOrder: after, shipments, closed: close };
}

/* ===========================================================================
 * The order's view, the company list, the time override
 * ======================================================================== */

/** GET /orders/:id/production-orders — its production orders, what Create would make, older releases, the override. */
export async function getOrderProductionOrders(db, companyId, orderId) {
  const [[order]] = await db.query('SELECT id, code, status, order_type, time_override_seconds FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, orderId]);
  if (!order) throw notFound('Sales order');
  const [productionOrders, plan, [legacy]] = await Promise.all([
    listProductionOrdersOf(db, companyId, { orderIds: [order.id] }),
    planOf(db, companyId, order.id),
    db.query(
      `SELECT r.id, r.order_line_id, l.line_no, r.created_at FROM cf_production_releases r JOIN cf_sales_order_lines l ON l.id = r.order_line_id
        WHERE r.company_id = ? AND r.order_id = ? AND r.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM cf_production_items pi WHERE pi.company_id = r.company_id AND pi.release_id = r.id AND pi.production_order_id IS NOT NULL)`,
      [companyId, order.id],
    ),
  ]);
  const have = new Set(productionOrders.map((p) => p.scopeKey));
  const toMake = plan.planned.filter((x) => !have.has(x.scopeKey));
  const counts = Object.fromEntries(PO_STATES.map((s) => [s, productionOrders.filter((p) => p.state === s).length]));
  return {
    order: { id: order.id, code: order.code, status: order.status, type: order.order_type, timeOverrideSeconds: order.time_override_seconds == null ? null : Number(order.time_override_seconds) },
    productionOrders,
    counts,
    toCreate: { count: toMake.length, labels: toMake.slice(0, 60).map((x) => x.label), why: toMake.length ? plan.why : null },
    legacy: legacy.map((r) => ({ releaseId: r.id, lineId: r.order_line_id, lineNo: r.line_no, releasedAt: r.created_at })),
  };
}

/**
 * GET /production-orders?state=&search=&orderId=&limit=&offset= — every production order, grouped by sales order
 * (paged by order), with state counts. Older releases (no production order) come as `legacy`.
 */
export async function listProductionOrders(db, companyId, q = {}) {
  const state = blank(q.state) ? 'open' : String(q.state);
  if (![...PO_STATES, 'open', 'all'].includes(state)) throw invalid('INVALID', `state is one of ${[...PO_STATES, 'open', 'all'].join(', ')}.`);
  const where = ['po.company_id = ?', 'po.deleted_at IS NULL', 'o.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.orderId)) { where.push('po.order_id = ?'); params.push(Number(q.orderId)); }
  const like = likeOf(q.search);
  if (like) { where.push('(o.code LIKE ? OR po.code LIKE ? OR po.label LIKE ? OR p.name LIKE ?)'); params.push(like, like, like, like); }
  const [rows] = await db.query(`${PO_SQL} WHERE ${where.join(' AND ')} ORDER BY o.code, po.seq`, params);
  const figures = await figuresOf(db, companyId, rows.map((r) => r.id));
  const all = rows.map((r) => shape(r, figures));
  const counts = { all: all.length, open: all.filter((x) => x.state !== 'closed').length };
  for (const s of PO_STATES) counts[s] = all.filter((x) => x.state === s).length;
  const keep = all.filter((x) => state === 'all' || (state === 'open' ? x.state !== 'closed' : x.state === state));
  const groups = new Map();
  for (const x of keep) { if (!groups.has(x.order.id)) groups.set(x.order.id, { order: x.order, productionOrders: [] }); groups.get(x.order.id).productionOrders.push(x); }
  const list = [...groups.values()];
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const lParams = [companyId];
  const lWhere = ['r.company_id = ?', 'r.deleted_at IS NULL', 'o.deleted_at IS NULL'];
  if (!blank(q.orderId)) { lWhere.push('r.order_id = ?'); lParams.push(Number(q.orderId)); }
  if (like) { lWhere.push('(o.code LIKE ? OR m.name LIKE ?)'); lParams.push(like, like); }
  const [legacy] = await db.query(
    `SELECT r.id, r.order_id, o.code AS order_code, r.order_line_id, l.line_no, m.name AS item_name, r.created_at,
            (SELECT COUNT(*) FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
              WHERE pi.release_id = r.id AND s.deleted_at IS NULL) AS steps,
            (SELECT COUNT(*) FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
              WHERE pi.release_id = r.id AND s.deleted_at IS NULL AND s.state = 'done') AS done
       FROM cf_production_releases r
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       LEFT JOIN cf_master_records m ON m.id = r.item_id
      WHERE ${lWhere.join(' AND ')}
        AND NOT EXISTS (SELECT 1 FROM cf_production_items pi WHERE pi.company_id = r.company_id AND pi.release_id = r.id AND pi.production_order_id IS NOT NULL)
      ORDER BY o.code, l.line_no LIMIT 200`,
    lParams,
  );
  return {
    rows: list.slice(offset, offset + limit),
    total: list.length, limit, offset, hasMore: offset + limit < list.length,
    counts, state,
    states: PO_STATES.map((key) => ({ key, label: PO_STATE_LABEL[key] })),
    legacy: legacy.map((r) => ({
      releaseId: r.id, order: { id: r.order_id, code: r.order_code }, line: { id: r.order_line_id, lineNo: r.line_no }, itemName: r.item_name ?? null,
      releasedAt: r.created_at, steps: Number(r.steps), done: Number(r.done),
    })),
  };
}

/** The most an override may be: one day a piece. */
const MAX_OVERRIDE_SECONDS = 86400;

/**
 * PUT /orders/:id/time-override { seconds: number | null } — "Override all times to N seconds" (testing). Stores it
 * and re-times the order's steps that are not done: with N, setup = work = N s (one UPDATE); cleared, each released
 * line's formula / typed times come back (the estimator, per line) and steps on a machine take its time again.
 */
export async function setTimeOverride(db, c, orderId, input = {}) {
  const raw = input.seconds;
  let seconds = null;
  if (!blank(raw)) {
    seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) throw invalid('INVALID', 'The override is a number of seconds above zero — leave it blank to use the formulas.');
    if (seconds > MAX_OVERRIDE_SECONDS) throw invalid('INVALID', `At most ${MAX_OVERRIDE_SECONDS} seconds.`);
    seconds = Number(seconds.toFixed(4));
  }
  const [[order]] = await db.query('SELECT id, code, status FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, orderId]);
  if (!order) throw notFound('Sales order');
  if (LOCKED_ORDER_STATUSES.has(order.status)) throw invalid('ORDER_LOCKED', `${order.code} is ${order.status} — its times do not change.`);
  await db.query('UPDATE cf_sales_orders SET time_override_seconds = ? WHERE company_id = ? AND id = ?', [seconds, c.companyId, order.id]);
  let retimed = 0;
  if (seconds != null) {
    const m = seconds / 60;
    const [r] = await db.query(
      `UPDATE cf_production_steps s
         JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
          SET s.est_setup_minutes = ?, s.est_work_minutes = ?, s.est_minutes = ROUND(? * s.quantity, 3),
              s.mach_setup_minutes = IF(s.mach_minutes IS NULL, s.mach_setup_minutes, ?),
              s.mach_work_minutes = IF(s.mach_minutes IS NULL, s.mach_work_minutes, ?),
              s.mach_minutes = IF(s.mach_minutes IS NULL, NULL, ROUND(? * s.quantity, 3))
        WHERE s.company_id = ? AND r.order_id = ? AND s.deleted_at IS NULL AND s.state <> 'done'`,
      [m, m, 2 * m, m, m, 2 * m, c.companyId, order.id],
    );
    retimed = r.affectedRows;
  } else {
    // The formulas (and typed times) again, line by line — the estimator release itself uses.
    const [steps] = await db.query(
      `SELECT s.id, s.operation_id, s.quantity, s.machine_id, s.state, s.started_at, pi.item_id, pi.bom_line_id, r.order_line_id
         FROM cf_production_steps s
         JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
        WHERE s.company_id = ? AND r.order_id = ? AND s.deleted_at IS NULL AND s.state <> 'done'`,
      [c.companyId, order.id],
    );
    const byLine = new Map();
    for (const s of steps) { if (!byLine.has(s.order_line_id)) byLine.set(s.order_line_id, []); byLine.get(s.order_line_id).push(s); }
    const writes = [];
    for (const [lineId, list] of byLine) {
      const est = await estimatorForLine(db, c.companyId, lineId, list.map((s) => ({ bomLineId: s.bom_line_id, itemId: s.item_id, operationId: s.operation_id })));
      for (const s of list) {
        const t = est(s.bom_line_id, s.item_id, s.operation_id);
        const work = t?.work ?? null;
        const setup = work != null ? t.setup ?? 0 : t?.setup ?? null;
        writes.push([s.id, setup, work, work == null ? null : r3(((setup ?? 0) + work) * Number(s.quantity))]);
      }
    }
    for (let i = 0; i < writes.length; i += 500) {
      const part = writes.slice(i, i + 500);
      const cs = () => `CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} END`;
      const col = (k) => part.flatMap((w) => [w[0], w[k]]);
      await db.query(
        `UPDATE cf_production_steps SET est_setup_minutes = ${cs()}, est_work_minutes = ${cs()}, est_minutes = ${cs()},
                mach_machine_id = NULL, mach_setup_minutes = NULL, mach_work_minutes = NULL, mach_minutes = NULL
          WHERE company_id = ? AND id IN (?)`,
        [...col(1), ...col(2), ...col(3), c.companyId, part.map((w) => w[0])],
      );
    }
    retimed = writes.length;
    // A step on a machine takes that machine's own time again (§58: the one writer of machine times).
    const onMachine = steps.filter((s) => s.machine_id != null).map((s) => s.id);
    if (onMachine.length) await estimateOnMachine(db, c, onMachine, undefined, { refuse: false, dropCannot: false });
  }
  return { orderId: order.id, timeOverrideSeconds: seconds, retimed };
}
