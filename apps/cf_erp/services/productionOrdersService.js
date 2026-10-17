/**
 * productionOrdersService.js — Production › Production orders (2026-10-17).
 *
 * User: "a production order list — every released line, with its order, line, item, when it was
 * released, the planned ship week, how far it is, a forecast, its status and what is blocked,
 * grouped by sales order". A production order = a RELEASE (cf_production_releases, one per
 * released line). "Work order" stays the contractor's (workOrderService).
 *
 *   progress   the dashboard's own rule (dashboardService.lineProgress): weighed by planned
 *              minutes when at least 80 % of the steps carry a time, else by steps counted.
 *   forecast   the later of the pace date (the last 14 days' progress carried forward) and the
 *              plan's latest ship week — the dashboard's order forecast, per line. An estimate.
 *   status     dispatched (all delivered) · done (every step done, or made in full) ·
 *              in_progress (anything started or made) · not_started.
 *   blocked    steps on hold + steps waiting for material not reserved (the dashboard's counts).
 *
 * GET /production-orders?status=&customerId=&search=&limit=&offset=
 *   status: not_started | in_progress | done | dispatched | open (= not dispatched) | all (default)
 *   Pages by SALES ORDER (limit orders a page, default 20), so an order's lines never split.
 *   { rows: [{ order, totals, lines[] }], total, limit, offset, hasMore, counts, customers, today }
 *
 * ROUND TRIPS (fixed, whatever the size): the plant zone, then ONE read of the releases in scope,
 * then ONE parallel stage of four set-based reads over those releases (steps, recent progress,
 * plan entries, material short) — 3 stages, 6 queries. Nothing per line or per order.
 */
import { invalid } from '../lib/errors.js';
import { likeOf, pageArgs, pageOf } from '../lib/listing.js';
import { plantZone, wallOf } from './floorService.js';
import { lineProgress, PACE_DAYS } from './dashboardService.js';

export const PO_STATUSES = ['not_started', 'in_progress', 'done', 'dispatched'];
const FILTERS = new Set([...PO_STATUSES, 'open', 'all']);
const EPS = 1e-6;
const DAY_MS = 86400000;
const r1 = (n) => Math.round(n * 10) / 10;
const blank = (v) => v == null || String(v).trim() === '';
const dayText = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const addDays = (ds, n) => new Date(Date.parse(`${ds}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** A line's status from its figures. Pure — the test drives it. */
export function statusOf({ quantity, made, delivered, steps, stepsDone, started }) {
  if (quantity > EPS && delivered + EPS >= quantity) return 'dispatched';
  if (steps > 0 ? stepsDone >= steps : quantity > EPS && made + EPS >= quantity) return 'done';
  if (started || made > EPS || stepsDone > 0) return 'in_progress';
  return 'not_started';
}

/** Monday of the week a date falls in (the planner's ship weeks are weeks). */
export function weekOf(ds) {
  if (!ds) return null;
  const d = new Date(`${ds}T00:00:00Z`);
  return addDays(ds, -((d.getUTCDay() + 6) % 7));
}

export async function listProductionOrders(db, companyId, q = {}) {
  const status = blank(q.status) ? 'all' : String(q.status);
  if (!FILTERS.has(status)) throw invalid('INVALID', `status is one of ${[...FILTERS].join(', ')}.`);
  const customerId = blank(q.customerId) ? null : Number(q.customerId);
  if (customerId != null && !Number.isInteger(customerId)) throw invalid('INVALID', 'customerId is a number.');
  const page = pageArgs(q, { def: 20, max: 200 });
  const tz = await plantZone(db, companyId);
  const todayS = wallOf(Date.now(), tz).slice(0, 10);

  const where = ['r.company_id = ?', 'r.deleted_at IS NULL'];
  const params = [companyId];
  if (customerId != null) { where.push('o.customer_id = ?'); params.push(customerId); }
  const like = likeOf(q.search);
  if (like) { where.push('(o.code LIKE ? OR o.title LIKE ? OR cu.name LIKE ? OR mr.code LIKE ? OR mr.name LIKE ?)'); params.push(like, like, like, like, like); }
  const [rels] = await db.query(
    `SELECT r.id AS release_id, r.created_at AS released_at, r.quantity AS released_qty,
            o.id AS order_id, o.code AS order_code, o.revision, o.title, o.status AS order_status, o.committed_date AS order_committed,
            o.customer_id, cu.name AS customer_name,
            l.id AS line_id, l.line_no, l.quantity, l.made_qty, l.delivered_qty, l.committed_date,
            mr.id AS item_id, mr.code AS item_code, mr.name AS item_name
       FROM cf_production_releases r
       JOIN cf_sales_orders o ON o.id = r.order_id AND o.deleted_at IS NULL
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       LEFT JOIN cf_parties cu ON cu.id = o.customer_id
       LEFT JOIN cf_master_records mr ON mr.id = r.item_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.code, l.line_no, r.id`,
    params,
  );
  const releaseIds = rels.map((r) => r.release_id);
  const lineIds = [...new Set(rels.map((r) => r.line_id))];
  const paceSec = Math.floor(Date.now() / 1000) - PACE_DAYS * 86400;
  const [[stepAgg], [paceAgg], [planAgg], [shortAgg]] = releaseIds.length ? await Promise.all([
    db.query(
      `SELECT pi.release_id, COUNT(*) AS steps, SUM(s.state = 'done') AS done, SUM(s.state = 'in_progress') AS in_progress,
              SUM(s.state = 'on_hold') AS on_hold, SUM(s.qty_good > 0) AS touched,
              SUM(s.eff_minutes IS NOT NULL) AS with_est, SUM(COALESCE(s.eff_minutes, 0)) AS est_total,
              SUM(COALESCE(s.eff_minutes, 0) * IF(s.state = 'done', 1, LEAST(1, s.qty_good / NULLIF(s.quantity, 0)))) AS est_done,
              SUM(IF(s.state = 'done', 1, LEAST(1, COALESCE(s.qty_good / NULLIF(s.quantity, 0), 0)))) AS count_done
         FROM cf_production_items pi
         JOIN cf_production_steps s ON s.company_id = pi.company_id AND s.production_item_id = pi.id AND s.deleted_at IS NULL
        WHERE pi.company_id = ? AND pi.release_id IN (?) AND pi.deleted_at IS NULL
        GROUP BY pi.release_id`,
      [companyId, releaseIds],
    ),
    // Progress recorded in the pace window, in minutes and in step shares (the dashboard's).
    db.query(
      `SELECT pi.release_id,
              SUM(e.qty_good * COALESCE(s.eff_minutes, 0) / NULLIF(s.quantity, 0)) AS est_pace,
              SUM(e.qty_good / NULLIF(s.quantity, 0)) AS cnt_pace
         FROM cf_step_events e
         JOIN cf_production_steps s ON s.id = e.step_id
         JOIN cf_production_items pi ON pi.id = s.production_item_id
        WHERE e.company_id = ? AND e.event = 'progress' AND COALESCE(e.at, e.created_at) >= FROM_UNIXTIME(?) AND pi.release_id IN (?)
        GROUP BY pi.release_id`,
      [companyId, paceSec, releaseIds],
    ),
    db.query(
      `SELECT order_line_id AS line_id, MIN(ship_date) AS first_ship, MAX(ship_date) AS last_ship, COUNT(*) AS entries
         FROM cf_plan_entries WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL GROUP BY order_line_id`,
      [companyId, lineIds],
    ),
    // Steps not done whose material is short (quantity − issued − usable reservation), per release.
    db.query(
      `SELECT q.release_id, COUNT(DISTINCT q.step_id) AS short_steps
         FROM cf_material_requirements q
         LEFT JOIN cf_production_steps s ON s.id = q.step_id
         LEFT JOIN (SELECT v.requirement_id, SUM(v.quantity) AS usable
                      FROM cf_stock_reservations v LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
                     WHERE v.company_id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND v.requirement_id IS NOT NULL
                       AND (v.batch_id IS NULL OR b.status = 'available')
                     GROUP BY v.requirement_id) v ON v.requirement_id = q.id
        WHERE q.company_id = ? AND q.release_id IN (?) AND q.deleted_at IS NULL AND q.step_id IS NOT NULL
          AND (s.id IS NULL OR s.state <> 'done') AND q.quantity - q.issued - COALESCE(v.usable, 0) > 0.000001
        GROUP BY q.release_id`,
      [companyId, companyId, releaseIds],
    ),
  ]) : [[[]], [[]], [[]], [[]]];

  const stepsOf = new Map(stepAgg.map((s) => [s.release_id, s]));
  const paceOf = new Map(paceAgg.map((s) => [s.release_id, s]));
  const planOf = new Map(planAgg.map((s) => [s.line_id, s]));
  const shortOf = new Map(shortAgg.map((s) => [s.release_id, Number(s.short_steps)]));

  const lines = rels.map((r) => {
    const s = stepsOf.get(r.release_id);
    const agg = s ? {
      steps: Number(s.steps), withEst: Number(s.with_est), estTotal: Number(s.est_total), estDone: Number(s.est_done), countDone: Number(s.count_done),
    } : null;
    const prog = agg ? lineProgress([agg]) : null;
    const quantity = Number(r.quantity);
    const made = Number(r.made_qty);
    const delivered = Number(r.delivered_qty);
    const stepsDone = Number(s?.done ?? 0);
    const st = statusOf({
      quantity, made, delivered, steps: agg?.steps ?? 0, stepsDone,
      started: Number(s?.in_progress ?? 0) > 0 || Number(s?.touched ?? 0) > 0,
    });
    const pct = prog ? prog.pct : quantity > EPS ? Math.min(100, (made / quantity) * 100) : 0;
    const pace = paceOf.get(r.release_id);
    const gained = prog && pace ? (prog.byWork ? (Number(pace.est_pace ?? 0) / prog.estTotal) * 100 : (Number(pace.cnt_pace ?? 0) / prog.steps) * 100) : 0;
    const perDay = gained / PACE_DAYS;
    const finished = st === 'done' || st === 'dispatched';
    const paceDate = !finished && perDay > 0.01 ? addDays(todayS, Math.ceil((100 - pct) / perDay)) : null;
    const plan = planOf.get(r.line_id);
    const lastShip = plan ? dayText(plan.last_ship) : null;
    const forecast = finished ? null : [paceDate, lastShip].filter(Boolean).sort().at(-1) ?? null;
    const onHold = Number(s?.on_hold ?? 0);
    const material = shortOf.get(r.release_id) ?? 0;
    return {
      releaseId: r.release_id,
      orderId: r.order_id,
      line: { id: r.line_id, lineNo: r.line_no },
      item: { id: r.item_id, code: r.item_code ?? null, name: r.item_name ?? null },
      quantity, made, delivered,
      releasedAt: dayText(r.released_at),
      committedDate: dayText(r.committed_date) ?? dayText(r.order_committed),
      plan: plan ? { shipWeek: weekOf(lastShip), firstShip: dayText(plan.first_ship), lastShip, entries: Number(plan.entries) } : null,
      progress: { pct: r1(pct), basis: prog ? prog.basis : made > EPS ? 'made' : null, steps: agg?.steps ?? 0, stepsDone },
      forecast: { date: forecast, pace: paceDate, plan: lastShip, estimate: true },
      status: st,
      blocked: { onHold, material, total: onHold + material },
      _agg: agg,
      _order: r,
    };
  });

  // Chip counts: every status over the same customer / search filters.
  const counts = { all: lines.length, open: 0, not_started: 0, in_progress: 0, done: 0, dispatched: 0 };
  for (const l of lines) { counts[l.status] += 1; if (l.status !== 'dispatched') counts.open += 1; }
  const keep = (l) => status === 'all' || (status === 'open' ? l.status !== 'dispatched' : l.status === status);
  const customers = new Map();
  for (const r of rels) if (r.customer_id && !customers.has(r.customer_id)) customers.set(r.customer_id, { id: r.customer_id, name: r.customer_name });

  // Group by sales order: lines in order; orders with something still open first, then by code.
  const groups = new Map();
  for (const l of lines.filter(keep)) {
    if (!groups.has(l.orderId)) groups.set(l.orderId, []);
    groups.get(l.orderId).push(l);
  }
  const orders = [...groups.values()].map((ls) => {
    const o = ls[0]._order;
    const aggs = ls.map((l) => l._agg).filter(Boolean);
    const prog = aggs.length ? lineProgress(aggs) : null;
    const pct = prog ? prog.pct : ls.reduce((t, l) => t + l.progress.pct, 0) / ls.length;
    const byStatus = Object.fromEntries(PO_STATUSES.map((k) => [k, ls.filter((l) => l.status === k).length]));
    const forecasts = ls.map((l) => l.forecast.date).filter(Boolean).sort();
    const weeks = ls.map((l) => l.plan?.shipWeek).filter(Boolean).sort();
    return {
      order: {
        id: o.order_id, code: o.order_code, revision: o.revision ?? 1, title: o.title ?? null, status: o.order_status,
        customer: o.customer_id ? { id: o.customer_id, name: o.customer_name } : null, committedDate: dayText(o.order_committed),
      },
      totals: {
        lines: ls.length, ...byStatus,
        progressPct: r1(pct), basis: prog ? prog.basis : null,
        steps: ls.reduce((t, l) => t + l.progress.steps, 0), stepsDone: ls.reduce((t, l) => t + l.progress.stepsDone, 0),
        blocked: ls.reduce((t, l) => t + l.blocked.total, 0),
        lastShipWeek: weeks.at(-1) ?? null,
        planned: ls.filter((l) => l.plan).length,
        forecast: ls.every((l) => l.status === 'done' || l.status === 'dispatched') ? null : forecasts.at(-1) ?? null,
      },
      lines: ls.map(({ _agg, _order, ...l }) => l),
    };
  }).sort((a, z) => Number(a.totals.dispatched === a.totals.lines) - Number(z.totals.dispatched === z.totals.lines)
    || String(a.order.code).localeCompare(String(z.order.code)));

  const slice = page.all ? orders : orders.slice(page.offset, page.offset + page.limit);
  return {
    ...pageOf(slice, orders.length, page),
    lineTotal: orders.reduce((t, o) => t + o.totals.lines, 0),
    counts,
    customers: [...customers.values()].sort((a, z) => String(a.name).localeCompare(String(z.name))),
    status,
    today: todayS,
  };
}
