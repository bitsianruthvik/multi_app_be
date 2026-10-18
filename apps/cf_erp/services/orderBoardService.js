/**
 * orderBoardService.js — Sales › Orders board, and the post-production checklist (init.sql §73).
 *
 * User, 2026-10-18: swim lanes Inquiry → Pending approval → Material → In production → Dispatched → Post-production →
 * Closed. NOTHING IS DRAGGED: a card's lane is worked out from tracked facts on every read —
 *   inquiry           a customer's order not confirmed, its acceptance not waiting for approval
 *   pending_approval  its acceptance waits for Management
 *   material          confirmed (accepted); nothing released yet — the card says how much MR material is locked
 *   in_production     a line released to production (production orders come later; for now a release)
 *   dispatched        something shipped, not everything
 *   post_production   everything shipped; the card is the order's own post-production stages as a checklist
 *   closed            closed: every stage done and — for an order with accepted terms (step 3B, §74) — FULLY PAID
 * Ticking a stage "Done" (a date and a note) is recorded (cf_order_post_stages + an event in cf_order_events, which
 * billing reads in 3B). When the last stage is done and everything is shipped, the order closes by itself.
 */
import { invalid, notFound } from '../lib/errors.js';
import { readRequisitions } from './requisitionService.js';
import { acceptanceStates, postStagesOf, recordOrderEvent } from './acceptanceService.js';

export const LANES = [
  { key: 'inquiry', label: 'Inquiry / draft' },
  { key: 'pending_approval', label: 'Pending approval' },
  { key: 'material', label: 'Material' },
  { key: 'in_production', label: 'In production' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'post_production', label: 'Post-production' },
  { key: 'closed', label: 'Closed' },
];
const EPS = 1e-6;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v) => v == null || String(v).trim() === '';
const dateText = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
const today = () => dateText(new Date());

/** The lane an order is in, from its facts. Pure. */
export function laneOf(f) {
  if (f.status === 'closed') return 'closed';
  if (f.status !== 'confirmed') return f.acceptancePending ? 'pending_approval' : 'inquiry';
  if (f.lines > 0 && f.fullyDispatched) return 'post_production';
  if (f.anyDispatched) return 'dispatched';
  if (f.released > 0) return 'in_production';
  return 'material';
}

/**
 * GET /orders/board?search= — every open customer order (and those closed in the last 90 days) as a card in its lane.
 * Fixed reads: orders, line facts, acceptances, post stages, the MRs (one read of them all).
 */
export async function orderBoard(db, companyId, q = {}) {
  const where = ["o.company_id = ?", 'o.deleted_at IS NULL', "o.order_type = 'customer'",
    "(o.status IN ('inquiry','quoted','confirmed') OR (o.status = 'closed' AND o.updated_at >= NOW() - INTERVAL 90 DAY))"];
  const args = [companyId];
  if (!blank(q.search)) { where.push('(o.code LIKE ? OR o.title LIKE ? OR p.name LIKE ?)'); const like = `%${String(q.search).trim()}%`; args.push(like, like, like); }
  const [orders] = await db.query(
    `SELECT o.id, o.code, o.title, o.status, o.committed_date, o.confirmed_at, p.name AS customer_name
       FROM cf_sales_orders o LEFT JOIN cf_parties p ON p.id = o.customer_id
      WHERE ${where.join(' AND ')} ORDER BY o.committed_date IS NULL, o.committed_date, o.code LIMIT 500`,
    args,
  );
  const lanes = LANES.map((l) => ({ ...l, cards: [] }));
  if (!orders.length) return { lanes, today: today() };
  const ids = orders.map((o) => o.id);
  const { orderBilling } = await import('./billingService.js');
  const { orderValuesFor } = await import('./orderValueService.js');
  const [[lines], acc, stagesBy, mrs, billing, values] = await Promise.all([
    db.query(
      `SELECT l.order_id, COUNT(*) AS n, SUM(LEAST(COALESCE(l.delivered_qty, 0), l.quantity)) AS delivered, SUM(l.quantity) AS quantity,
              SUM(COALESCE(l.delivered_qty, 0) > 0) AS any_delivered, SUM(COALESCE(l.delivered_qty, 0) + 0.000001 >= l.quantity) AS lines_delivered,
              SUM(EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL)) AS released
         FROM cf_sales_order_lines l WHERE l.company_id = ? AND l.order_id IN (?) AND l.deleted_at IS NULL GROUP BY l.order_id`,
      [companyId, ids]),
    acceptanceStates(db, companyId, ids),
    postStagesOf(db, companyId, ids),
    readRequisitions(db, companyId, { open: true, lineBound: true }),
    orderBilling(db, companyId, ids),
    orderValuesFor(db, companyId, ids),
  ]);
  const lineOf = new Map(lines.map((l) => [Number(l.order_id), l]));
  const mrOf = new Map();
  for (const v of mrs) {
    const id = Number(v.order.id);
    if (!mrOf.has(id)) mrOf.set(id, { mrs: 0, materials: 0, locked: 0, held: 0 });
    const e = mrOf.get(id);
    const live = v.lines.filter((l) => l.status !== 'not_needed');
    e.mrs += 1;
    e.materials += live.length;
    e.locked += live.filter((l) => (l.cover?.earmarked ?? 0) + EPS >= l.need).length;
    if (v.heldForAcceptance) e.held += 1;
  }
  const t = today();
  for (const o of orders) {
    const l = lineOf.get(Number(o.id)) ?? { n: 0, delivered: 0, quantity: 0, any_delivered: 0, lines_delivered: 0, released: 0 };
    const a = acc.get(Number(o.id)) ?? {};
    const stages = stagesBy.get(Number(o.id)) ?? [];
    const m = mrOf.get(Number(o.id)) ?? null;
    const f = {
      status: o.status, lines: Number(l.n) || 0, released: Number(l.released) || 0,
      anyDispatched: Number(l.any_delivered) > 0, fullyDispatched: Number(l.n) > 0 && Number(l.lines_delivered) >= Number(l.n),
      acceptancePending: !!a.pending,
    };
    const lane = laneOf(f);
    const committed = dateText(o.committed_date);
    const stagesDone = stages.filter((s) => s.done).length;
    const bill = billing.get(Number(o.id))?.summary ?? null;
    lanes.find((x) => x.key === lane).cards.push({
      id: o.id, code: o.code, title: o.title ?? null, customer: o.customer_name ?? null, status: o.status, lane,
      committedDate: committed, overdue: !!committed && committed < t && o.status !== 'closed',
      // ONE order value (orderValueService): accepted terms, else the estimate from the line rates.
      value: values.get(Number(o.id)) ?? null,
      facts: {
        lines: f.lines, released: f.released,
        dispatched: `${Number(l.lines_delivered) || 0} of ${f.lines} line${f.lines === 1 ? '' : 's'} shipped`,
        material: !m ? 'No MR yet' : m.held ? 'MR shared, waiting for acceptance' : m.materials ? `${m.locked} of ${m.materials} material${m.materials === 1 ? '' : 's'} locked` : 'Nothing to buy',
        materialInPlace: !!m && !m.held && m.materials > 0 && m.locked >= m.materials,
        acceptance: a.approved ? { status: 'approved', version: a.approved.version } : a.pending ? { status: 'pending', version: a.pending.version } : a.sentBack ? { status: a.sentBack.status, note: a.sentBack.decisionNote ?? null } : null,
        rateChangePending: !!(a.approved && a.pending),
        // §74: the money — an order with accepted terms closes only when it is fully paid.
        payment: bill ? {
          fullyPaid: bill.fullyPaid, outstanding: bill.outstanding, due: bill.due, upcoming: bill.upcoming, received: bill.received,
          text: bill.fullyPaid ? 'Fully paid' : bill.outstanding > 0.5 ? `₹${Number(bill.outstanding).toLocaleString('en-IN')} to be received` : bill.due > 0 ? `₹${Number(bill.due).toLocaleString('en-IN')} due to bill` : 'Milestones still to come',
        } : null,
      },
      stages,
      stagesDone,
      // Every stage done and everything shipped: the order can be closed (it closes by itself on the last tick).
      canClose: lane === 'post_production' && stagesDone >= stages.length && (!bill || bill.fullyPaid),
    });
  }
  return { lanes, today: t };
}

async function requireStage(db, companyId, id) {
  const [[s]] = await db.query(
    `SELECT s.*, o.code AS order_code, o.status AS order_status FROM cf_order_post_stages s JOIN cf_sales_orders o ON o.id = s.order_id
      WHERE s.company_id = ? AND s.id = ? AND s.deleted_at IS NULL FOR UPDATE`,
    [companyId, Number(id)],
  );
  if (!s) throw notFound('Post-production stage');
  return s;
}

/**
 * Everything shipped, every stage done → the order closes by itself (salesOrderService records order_closed).
 * §74 (user, 2026-10-18): an order with accepted terms must also be FULLY PAID (every milestone billed, every invoice paid).
 */
export async function closeIfDone(db, c, orderId) {
  const [[r]] = await db.query(
    `SELECT o.status,
            (SELECT COUNT(*) FROM cf_order_post_stages s WHERE s.company_id = o.company_id AND s.order_id = o.id AND s.deleted_at IS NULL AND s.done_on IS NULL) AS open_stages,
            (SELECT COUNT(*) FROM cf_sales_order_lines l WHERE l.company_id = o.company_id AND l.order_id = o.id AND l.deleted_at IS NULL) AS line_count,
            (SELECT COUNT(*) FROM cf_sales_order_lines l WHERE l.company_id = o.company_id AND l.order_id = o.id AND l.deleted_at IS NULL AND COALESCE(l.delivered_qty, 0) + 0.000001 < l.quantity) AS unshipped
       FROM cf_sales_orders o WHERE o.company_id = ? AND o.id = ?`,
    [c.companyId, Number(orderId)],
  );
  if (r?.status !== 'confirmed' || Number(r.open_stages) > 0 || !Number(r.line_count) || Number(r.unshipped) > 0) return false;
  const { paidUp } = await import('./billingService.js');
  if (!(await paidUp(db, c.companyId, orderId)).fullyPaid) return false;
  const { setOrderStatus } = await import('./salesOrderService.js');
  await setOrderStatus(db, c, orderId, 'closed');
  return true;
}

/**
 * POST /order-post-stages/:id/done { date?, note? } — a post-production stage is done (date: today when left out).
 * Recorded: who, when, the note — and an event billing reads (post_stage_done). The order must be accepted.
 */
export async function markStageDone(db, c, id, input = {}) {
  const s = await requireStage(db, c.companyId, id);
  if (s.order_status !== 'confirmed') throw invalid('NOT_OPEN', `${s.order_code} is ${s.order_status} — its stages are ticked while it is confirmed.`);
  if (s.done_on) throw invalid('DONE', `"${s.name}" is done already (${dateText(s.done_on)}).`);
  const date = blank(input.date) ? today() : String(input.date);
  if (!DATE_RE.test(date)) throw invalid('INVALID', 'The date needs YYYY-MM-DD.');
  if (date > today()) throw invalid('INVALID', 'A stage is done on a day that has come — not in the future.');
  const note = blank(input.note) ? null : String(input.note).trim().slice(0, 500);
  await db.query('UPDATE cf_order_post_stages SET done_on = ?, done_note = ?, done_by = ?, done_at = NOW() WHERE company_id = ? AND id = ?', [date, note, c.userId ?? null, c.companyId, s.id]);
  await recordOrderEvent(db, c, { orderId: s.order_id, type: 'post_stage_done', refType: 'post_stage', refId: s.id, label: s.name, date, note });
  const closed = await closeIfDone(db, c, s.order_id);
  return { stage: (await postStagesOf(db, c.companyId, [s.order_id])).get(Number(s.order_id)).find((x) => x.id === s.id), orderClosed: closed };
}

/** POST /order-post-stages/:id/undo { note? } — ticked by mistake: open again, recorded (post_stage_undone). */
export async function undoStageDone(db, c, id, input = {}) {
  const s = await requireStage(db, c.companyId, id);
  if (s.order_status !== 'confirmed') throw invalid('NOT_OPEN', `${s.order_code} is ${s.order_status} — its stages no longer change.`);
  if (!s.done_on) throw invalid('NOT_DONE', `"${s.name}" is not done.`);
  await db.query('UPDATE cf_order_post_stages SET done_on = NULL, done_note = NULL, done_by = NULL, done_at = NULL WHERE company_id = ? AND id = ?', [c.companyId, s.id]);
  await recordOrderEvent(db, c, { orderId: s.order_id, type: 'post_stage_undone', refType: 'post_stage', refId: s.id, label: s.name, note: blank(input.note) ? null : String(input.note) });
  return { stage: (await postStagesOf(db, c.companyId, [s.order_id])).get(Number(s.order_id)).find((x) => x.id === s.id) };
}
