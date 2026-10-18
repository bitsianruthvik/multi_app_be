/**
 * requisitionService.js — the REQUISITION (init.sql §56; contract TM/CF_ERP_BUYING_V2.md).
 *
 * One requisition (PR) per sales-order LINE, one line per MATERIAL that line
 * needs. The need is never typed: it is the line's own material — a released
 * line's requirements, a frozen line's planned material (materialReadyService
 * .lineNeeds, the source the buy list and release use, nest plates included).
 *
 * A requisition line is COVERED by any mix of
 *   stock     holds on the MR line: taken from stock on the MR screen (§71,
 *             purchaseRequestService.saveMr), or received on its POs
 *   purchase  allocations of purchase-order lines, each with its own quantity
 *             and receiving date; one requisition line may be split over
 *             several POs, one PO may serve several requisition lines / orders
 *   skip      a recorded decision (who, when, why) that this material will not
 *             be bought for this line: it WAITS FOR STOCK. Per material, or for
 *             every open material of the requisition in one call; undoable.
 * A requisition met wholly from stock is FULFILLED — there is no cancelled PO.
 *
 * NOTHING ABOUT ITS STATE IS STORED. Every read works the cover out again from
 * the holds, the allocations and the engine (materialReadyService), so a PO
 * cancelled, a date moved, a quantity cut, a receipt or a re-frozen design
 * shows at once. cf_requisition_lines.quantity is only the need as it stood
 * when the lines were last brought up to date (`needRaised`).
 *
 * LINE STATUS            covered by                                   resolved
 *   from_stock           issued + reserved + held ≥ need               yes
 *   covered              … + PO lines with a receiving date ≥ need     yes
 *   ordered_undated      … + ordered PO lines with NO date ≥ need      no — set the date
 *   asked                … + requested / quoting PO lines ≥ need       no — place the order
 *   skipped              skip decided, some of it still uncovered      yes (it waits for stock)
 *   part                 something, not all, nothing decided           no
 *   open                 nothing                                        no
 *   not_needed           the line no longer needs it (kept: it has cover to let go)
 * REQUISITION STATUS (from its lines): empty · fulfilled_from_stock (all
 * from_stock) · skipped (all skipped) · covered (all resolved, none skipped) ·
 * mixed (all resolved, some skipped) · partly_covered · open.
 *
 * ROUND TRIPS. A read is the engine (≤ 11, fixed) + 4 (heads, lines, holds,
 * allocations), whatever the number of requisitions, materials or POs. Writes
 * are bulk: insertRows and one UPDATE … CASE; nothing is written per row.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { availability } from './rollOutService.js';
import {
  lineReadiness, openLines, lineNeeds, today as clockToday, dateOnly, dayWords,
  OPEN_ORDER_STATUSES, DATED_PO_STATUSES, LIVE_PO_STATUSES,
} from './materialReadyService.js';
import { lastPricesPaid, CURRENCY } from './priceService.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const fmt = (n) => String(Number(Number(n).toFixed(3)));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Orders a purchase can still be made for (purchaseLinkService.LINKABLE). */
const BUYABLE_ORDER_STATUSES = ['draft', 'inquiry', 'quoted', 'confirmed'];

/*
 * CUSTOMER ACCEPTANCE GATES THE MR (§73, user 2026-10-18). A customer's order raises its MR before the customer has
 * accepted: the MR is SHARED with the customer (PDF / Excel) but HELD — nothing downstream happens: no stock earmarked,
 * no purchase request, no ₹0 PO to the customer. Management's approval of the acceptance confirms the order and
 * RELEASES its held MRs to Purchase (releaseHeldRequisitions). A stock order, or a customer order already confirmed,
 * raises its MR released, as before.
 */
export const HELD_SENTENCE = 'Shared with the customer. Purchase starts once the customer\'s acceptance is approved.';
export const heldForAcceptance = (o) => o.order_type === 'customer' && !['confirmed', 'closed'].includes(o.status);
export const heldMessage = (code) => `${code} waits for the customer's acceptance — Purchase starts once Management approves it.`;

/*
 * THE "FOR" OF AN MR (init.sql §79, user 2026-10-18). Every MR says what it is for — and the cost follows it:
 *   sales_order        a sales order's own MR (one per order line, raised from the order — as before), or one raised by
 *                      hand for the order (no line). Cost: the order's cost sheet.
 *   maintenance_order  for a maintenance order (maintenance_order_id; §82). May ALSO name a sales order (orderId) —
 *                      its cost then belongs to that order; else the machine's maintenance cost.
 *   stock              to refill stock (Stores' "To reorder" list). No order. What arrives is free stock.
 *   general            anything else (consumables, the office …). May name a sales order; else overhead.
 * MRs go to STORES: Stores takes what is in stock and raises the PR for the rest; Purchase sees PRs only.
 * An MR raised by hand (createRequisition) has NO order line: its lines are typed (item, quantity), never synced to a
 * line's need, and its holds / PO shares are its own (held for nobody else, not for the order as a whole — so the
 * order's own MRs never count them twice).
 */
export const FOR_TYPES = ['sales_order', 'maintenance_order', 'stock', 'general'];
export const FOR_LABEL = { sales_order: 'Sales order', maintenance_order: 'Maintenance order', stock: 'Stock', general: 'General' };
export const forTypeOf = (v) => (FOR_TYPES.includes(v) ? v : 'sales_order');

/*
 * MATERIAL REQUEST (init.sql §66, 2026-10-16). The requisition is called a MATERIAL REQUEST (MR) on every
 * screen; a new one is numbered MR-<order>-<line> (one raised before keeps its PR- number). Who supplies
 * the material is asked when the order is made — the order's `material_supply`, a line may say otherwise —
 * and fixed on the MR when it is raised (`cf_requisitions.supply`):
 *   we_buy    as before: stock is earmarked (the stock check), the rest is bought on POs.
 *   customer  the customer sends it. Raising the MR earmarks only the customer's own lots for this order and
 *             puts what is still open on a purchase order to the CUSTOMER as vendor (₹0, placed, no date until
 *             one is set). Its receipt is the customer's lot, earmarked to the MR line. Our own stock and
 *             another customer's never cover such a line: not the stock check, not the engine, not reserving.
 */
export const SUPPLY = ['we_buy', 'customer'];
export const SUPPLY_LABEL = { we_buy: 'We buy', customer: 'Customer supplies' };
export const supplyOf = (v) => (v === 'customer' ? 'customer' : 'we_buy');
export const MR_PREFIX = 'MR';

export const LINE_STATUS_LABEL = {
  from_stock: 'From stock', covered: 'On order', ordered_undated: 'Ordered, no date', asked: 'Asked for',
  skipped: 'Skipped', part: 'Partly covered', open: 'Open', not_needed: 'Not needed',
};
export const REQUISITION_STATUS_LABEL = {
  empty: 'Nothing to buy', open: 'Open', partly_covered: 'Partly covered', covered: 'Covered',
  fulfilled_from_stock: 'Fulfilled from stock', skipped: 'Skipped', mixed: 'Covered, some skipped',
};
const RESOLVED = new Set(['from_stock', 'covered', 'skipped', 'not_needed']);

// --- reading ---------------------------------------------------------------------------

const nameOfItem = (it) => it.code ?? it.name ?? `item ${it.id}`;

/** One requisition line, from its stored row, its own holds and allocations, and the engine's answer for it. */
function shapeLine(pl, { n, reason, holds, allocs, todayText, customer = false, forStock = false }) {
  const item = { id: pl.item_id, code: pl.item_code, name: pl.item_name, uom: pl.uom ?? null, trackedBy: pl.tracked_by ?? null };
  const known = !!n;
  const need = known ? round6(n.need) : round6(pl.quantity);
  const issued = known ? n.issued : 0;
  const reserved = known ? n.reserved : 0;
  const ownHeld = round6(holds.reduce((t, h) => t + Number(h.quantity), 0));
  const purchase = allocs.map((a) => {
    const live = LIVE_PO_STATUSES.includes(a.po_status);
    const due = dateOnly(a.due);
    const outstanding = live ? round6(Math.max(0, Number(a.quantity) - Number(a.qty_received))) : 0;
    const dated = DATED_PO_STATUSES.includes(a.po_status);
    return {
      allocationId: a.id,
      purchaseOrder: { id: a.po_id, code: a.po_code, status: a.po_status, suppliedByCustomer: !!Number(a.supplied_by_customer ?? 0) },
      purchaseLineId: a.po_line_id,
      supplier: a.supplier_id ? { id: a.supplier_id, name: a.supplier_name } : null,
      quantity: Number(a.quantity), received: Number(a.qty_received), outstanding,
      date: dated ? due : null,
      // dated = it gives production a date · undated = ordered, no date · asked = not ordered yet · closed = nothing more is coming on it
      state: !live ? 'closed' : outstanding <= EPS ? 'received' : !dated ? 'asked' : due ? 'dated' : 'undated',
      late: live && dated && !!due && due < todayText && outstanding > EPS,
    };
  });
  const sumOf = (state) => round6(purchase.filter((p) => p.state === state).reduce((t, p) => t + p.outstanding, 0));
  // The engine's answer is the authority (it also hands out what is held or bought for the ORDER as a whole);
  // without it (the need is not known just now) the line's own rows are all there is.
  const take = (pred) => round6((reason?.cover ?? []).filter(pred).reduce((t, x) => t + x.qty, 0));
  // §79: a STOCK MR holds nothing on receipt (what arrives is free stock), so what arrived on its POs is its cover.
  const held = reason ? take((x) => x.kind === 'held') : round6(ownHeld + (forStock ? purchase.reduce((t, p) => t + p.received, 0) : 0));
  const ordered = reason ? take((x) => x.kind === 'po' && !x.pooled && x.status === 'dated') : sumOf('dated');
  const undated = reason ? take((x) => x.kind === 'po' && x.status === 'undated') : sumOf('undated');
  const asked = reason ? take((x) => x.kind === 'po' && x.status === 'asked') : sumOf('asked');
  const stock = round6((reason ? take((x) => x.kind === 'issued') : issued) + (reason ? take((x) => x.kind === 'reserved') : reserved) + held);
  const total = round6(stock + ordered + undated + asked);
  const open = round6(Math.max(0, need - total));
  // The MR's own figures (§66): what is on a live PO still to come, and what has arrived on its POs.
  const onPo = round6(purchase.reduce((t, p) => t + p.outstanding, 0));
  const received = round6(purchase.reduce((t, p) => t + p.received, 0));
  const ownTotal = round6(issued + reserved + ownHeld + onPo);
  const over = round6(Math.max(0, ownTotal - need));
  const skipped = !!Number(pl.skipped);
  let status;
  if (need <= EPS) status = 'not_needed';
  else if (stock + EPS >= need) status = 'from_stock';
  else if (stock + ordered + EPS >= need) status = 'covered';
  else if (stock + ordered + undated + EPS >= need) status = 'ordered_undated';
  else if (total + EPS >= need) status = 'asked';
  else if (skipped) status = 'skipped';
  else status = total > EPS ? 'part' : 'open';
  const dates = (reason?.cover ?? []).filter((x) => x.kind === 'po' && x.date).map((x) => x.date).sort();
  const freeNow = reason ? take((x) => x.kind === 'free') : 0;
  const pooled = reason ? take((x) => x.kind === 'po' && x.pooled) : 0;
  const u = item.uom ? ` ${item.uom}` : '';
  const late = purchase.some((p) => p.late);
  const sentence = {
    not_needed: over > EPS ? `The line no longer needs this — ${fmt(over)}${u} is still held or on order for it and can be let go.` : 'The line no longer needs this.',
    from_stock: 'Covered from stock held for this line.',
    covered: `Covered — ${stock > EPS ? `${fmt(stock)}${u} from stock, ` : ''}${fmt(ordered)}${u} on order, last delivery ${dayWords(dates.at(-1))}${late ? ' (a delivery is overdue)' : ''}.`,
    ordered_undated: customer
      ? `Asked of the customer — ${fmt(undated)}${u} on their purchase order, no date yet. Production waits until it arrives or a date is set.`
      : `Ordered, but ${fmt(undated)}${u} has no receiving date — production waits until a date is set.`,
    asked: `${fmt(asked)}${u} is asked for and not ordered yet — production waits until the order is placed with a date.`,
    skipped: freeNow + EPS >= open
      ? `Buying skipped — it waits for stock. ${fmt(open)}${u} is in stock now (not earmarked), so the work can be planned.`
      : `Buying skipped — it waits for stock. ${fmt(round6(open - freeNow))}${u} is not in stock yet.`,
    part: customer ? `${fmt(open)}${u} of ${fmt(need)} is not asked of the customer yet — bring the MR up to date to put it on their purchase order.` : `${fmt(open)}${u} of ${fmt(need)} still to decide — hold stock, order it, or skip it.`,
    open: customer ? 'Not asked of the customer yet — bring the MR up to date to put it on their purchase order.' : 'Nothing decided yet — hold stock, order it, or skip it.',
  }[status];
  return {
    id: pl.id, item, need, needRaised: Number(pl.quantity), needKnown: known,
    // §71: what the person chose to take from stock on the MR screen (null = not chosen yet).
    stockTake: pl.stock_take == null ? null : Number(pl.stock_take),
    status, statusLabel: LINE_STATUS_LABEL[status], resolved: RESOLVED.has(status), sentence,
    skipped: skipped ? { by: pl.skipped_by ? { id: pl.skipped_by, name: pl.skipped_by_name ?? null } : null, at: pl.skipped_at ?? null, note: pl.skip_note ?? null } : null,
    cover: {
      issued: reason ? take((x) => x.kind === 'issued') : issued, reserved: reason ? take((x) => x.kind === 'reserved') : reserved,
      held, stock, ordered, undated, asked, total, open, over,
      // MR figures: earmarked = stock (held + reserved + issued) · onPo = still to come on live POs · received on its POs.
      earmarked: stock, onPo, received,
      // Not cover: what the engine found for the uncovered part right now, unearmarked.
      freeNow, pooledOnOrder: pooled,
      firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null, late,
    },
    holds: holds.map((h) => ({
      id: h.id, quantity: Number(h.quantity), batch: h.batch_id ? { id: h.batch_id, code: h.batch_code } : null,
      purchaseOrder: h.po_id ? { id: h.po_id, code: h.po_code } : null,
    })),
    purchase,
    ready: reason ? { state: reason.state, date: reason.date, text: reason.text, cover: reason.cover } : null,
  };
}

function requisitionStatus(lines) {
  const live = lines.filter((l) => l.status !== 'not_needed');
  if (!live.length) return 'empty';
  if (live.every((l) => l.status === 'from_stock')) return 'fulfilled_from_stock';
  if (live.every((l) => l.status === 'skipped')) return 'skipped';
  if (live.every((l) => l.resolved)) return live.some((l) => l.status === 'skipped') ? 'mixed' : 'covered';
  return live.some((l) => l.status !== 'open') ? 'partly_covered' : 'open';
}

function requisitionSentence(status, lines, ready) {
  const live = lines.filter((l) => l.status !== 'not_needed');
  const count = (s) => live.filter((l) => l.status === s).length;
  const undecided = live.filter((l) => !l.resolved).length;
  const waiting = live.filter((l) => l.status === 'skipped' && l.ready?.state === 'waiting').length;
  const skippedWords = count('skipped') ? `${plural(count('skipped'), 'material')} skipped${waiting ? ` (${waiting} waiting for stock now)` : ' (in stock now)'}` : '';
  switch (status) {
    case 'empty': return 'This line buys nothing.';
    case 'fulfilled_from_stock': return `All ${plural(live.length, 'material')} held from stock — nothing to buy.`;
    case 'skipped': return `Buying skipped for all ${plural(live.length, 'material')} — production waits for stock${waiting ? `: ${waiting} not in stock yet` : ': all in stock now'}.`;
    case 'covered': return `All ${plural(live.length, 'material')} covered — ${count('from_stock')} from stock, ${count('covered')} on order${ready?.readyDate && ready.state !== 'ready' ? `, ready ${dayWords(ready.readyDate)}` : ''}.`;
    case 'mixed': return `All ${plural(live.length, 'material')} decided — ${count('from_stock')} from stock, ${count('covered')} on order, ${skippedWords}.`;
    case 'partly_covered': return `${plural(undecided, 'material')} of ${live.length} still to decide${skippedWords ? ` — ${skippedWords}` : ''}.`;
    default: return `${plural(live.length, 'material')} to decide — hold stock, order, or skip.`;
  }
}

/** §79: the one sentence of an MR raised by hand (no order line, no engine). */
function manualSentence(status, lines, forType) {
  const live = lines.filter((l) => l.status !== 'not_needed');
  if (!live.length) return 'Nothing on this MR.';
  const open = live.filter((l) => !l.resolved).length;
  const what = forType === 'stock' ? 'for stock' : `for ${FOR_LABEL[forType].toLowerCase()}`;
  if (!open) return `All ${plural(live.length, 'material')} ${what} covered — from stock or on order.`;
  return `${plural(open, 'material')} of ${live.length} ${what} still to cover — take from stock, the rest goes on the purchase request.`;
}

/**
 * Requisitions with their lines, cover and material-ready state.
 * filter: { id?, ids?, orderId?, lineId?, open? (only those of open orders), search? }
 * `R` is lineReadiness() when the caller already has it.
 */
export async function readRequisitions(db, companyId, filter = {}, { R: given = null } = {}) {
  const where = ['r.company_id = ?', 'r.deleted_at IS NULL'];
  const args = [companyId];
  if (filter.id != null) { where.push('r.id = ?'); args.push(Number(filter.id)); }
  if (filter.ids) { if (!filter.ids.length) return []; where.push('r.id IN (?)'); args.push(filter.ids); }
  if (filter.orderId != null) { where.push('r.order_id = ?'); args.push(Number(filter.orderId)); }
  if (filter.lineId != null) { where.push('r.order_line_id = ?'); args.push(Number(filter.lineId)); }
  // §79: an order's own MRs (one per line) — the sales order's MR stage reads only these.
  if (filter.lineBound) where.push('r.order_line_id IS NOT NULL');
  if (filter.forType && FOR_TYPES.includes(filter.forType)) { where.push('r.for_type = ?'); args.push(filter.forType); }
  if (filter.maintenanceOrderId != null) { where.push('r.maintenance_order_id = ?'); args.push(Number(filter.maintenanceOrderId)); }
  // An MR raised by hand (no order line) stays in the open list whatever its order (if any) is doing.
  if (filter.open) { where.push('(r.order_line_id IS NULL OR o.status IN (?))'); args.push(OPEN_ORDER_STATUSES); }
  if (!blank(filter.search)) { where.push('(r.code LIKE ? OR o.code LIKE ? OR cu.name LIKE ? OR r.notes LIKE ?)'); args.push(...Array(4).fill(`%${String(filter.search).trim()}%`)); }
  const [heads] = await db.query(
    `SELECT r.id, r.code, r.order_id, r.order_line_id, r.notes, r.synced_at, r.created_at, r.created_by, r.supply, r.held_for_acceptance, r.customer_date, u.name AS raised_by_name,
            r.for_type, r.maintenance_order_id,
            o.code AS order_code, o.status AS order_status, o.customer_id, cu.name AS customer_name,
            l.line_no, l.quantity AS line_quantity, l.locked_at, l.description, m.code AS item_code, m.name AS item_name,
            (SELECT pr.id FROM cf_production_releases pr WHERE pr.company_id = l.company_id AND pr.order_line_id = l.id AND pr.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_requisitions r
       LEFT JOIN cf_sales_orders o ON o.id = r.order_id
       LEFT JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       LEFT JOIN cf_master_records m ON m.id = l.item_id
       LEFT JOIN cf_parties cu ON cu.id = o.customer_id
       LEFT JOIN users u ON u.id = r.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY r.order_line_id IS NULL, o.code, l.line_no, r.id`,
    args,
  );
  if (!heads.length) return [];
  // The engine only answers for MRs of an order line; MRs raised by hand alone skip it (its reads are the costly part).
  const R = given ?? (heads.some((h) => h.order_line_id != null) ? await lineReadiness(db, companyId, { full: true }) : { needs: new Map(), byLine: new Map(), today: clockToday() });
  const ids = heads.map((h) => h.id);
  const [[lines], [holds], [allocs]] = await Promise.all([
    db.query(
      `SELECT pl.id, pl.requisition_id, pl.order_line_id, pl.item_id, pl.quantity, COALESCE(pl.uom, i.uom) AS uom, i.tracked_by,
              pl.skipped, pl.skipped_by, pl.skipped_at, pl.skip_note, pl.stock_take, su.name AS skipped_by_name, m.code AS item_code, m.name AS item_name
         FROM cf_requisition_lines pl
         JOIN cf_master_records m ON m.id = pl.item_id
         LEFT JOIN cf_item_details i ON i.master_id = pl.item_id AND i.deleted_at IS NULL
         LEFT JOIN users su ON su.id = pl.skipped_by
        WHERE pl.company_id = ? AND pl.requisition_id IN (?) AND pl.deleted_at IS NULL
        ORDER BY pl.requisition_id, m.code, pl.id`,
      [companyId, ids],
    ),
    db.query(
      `SELECT v.id, v.pr_line_id, v.quantity, v.batch_id, b.code AS batch_code, p.id AS po_id, p.code AS po_code
         FROM cf_stock_reservations v
         JOIN cf_requisition_lines pl ON pl.id = v.pr_line_id
         LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
         LEFT JOIN cf_purchase_order_lines l2 ON l2.id = v.purchase_line_id
         LEFT JOIN cf_purchase_orders p ON p.id = l2.purchase_order_id
        WHERE v.company_id = ? AND pl.requisition_id IN (?) AND v.status = 'active' AND v.deleted_at IS NULL AND v.item_id = pl.item_id
        ORDER BY v.id`,
      [companyId, ids],
    ),
    db.query(
      `SELECT a.id, a.pr_line_id, a.quantity, a.qty_received, l2.id AS po_line_id, COALESCE(l2.expected_date, p.expected_date) AS due,
              p.id AS po_id, p.code AS po_code, p.status AS po_status, p.supplied_by_customer, s.id AS supplier_id, s.name AS supplier_name
         FROM cf_purchase_line_orders a
         JOIN cf_requisition_lines pl ON pl.id = a.pr_line_id
         JOIN cf_purchase_order_lines l2 ON l2.id = a.purchase_line_id AND l2.deleted_at IS NULL
         JOIN cf_purchase_orders p ON p.id = l2.purchase_order_id AND p.deleted_at IS NULL
         LEFT JOIN cf_parties s ON s.id = p.supplier_id
        WHERE a.company_id = ? AND pl.requisition_id IN (?) AND (a.deleted_at IS NULL OR p.status = 'cancelled')
        ORDER BY a.id`,
      [companyId, ids],
    ),
  ]);
  const group = (rows, key) => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };
  const linesOf = group(lines, 'requisition_id');
  const holdsOf = group(holds, 'pr_line_id');
  const allocsOf = group(allocs, 'pr_line_id');
  return heads.map((h) => {
    const manual = h.order_line_id == null;           // §79: raised by hand — no order line, its lines are typed
    const lineId = manual ? null : Number(h.order_line_id);
    const needs = manual ? null : R.needs.get(lineId);
    const res = manual ? null : R.byLine.get(lineId);
    const known = !!needs?.known;
    const forType = forTypeOf(h.for_type);
    const reasonOf = new Map((res?.reasons ?? []).map((x) => [Number(x.item.id), x]));
    const own = (linesOf.get(h.id) ?? []).map((pl) => shapeLine(pl, {
      n: known ? needs.items.get(Number(pl.item_id)) ?? { need: 0, issued: 0, reserved: 0 } : null,
      reason: known ? reasonOf.get(Number(pl.item_id)) ?? null : null,
      holds: holdsOf.get(pl.id) ?? [], allocs: allocsOf.get(pl.id) ?? [], todayText: R.today, customer: supplyOf(h.supply) === 'customer',
      forStock: manual && forType === 'stock',
    }));
    // A material the line needs now that the requisition does not list yet (the design was frozen again).
    const listed = new Set(own.map((l) => Number(l.item.id)));
    const missing = known ? [...needs.items].filter(([id]) => !listed.has(id)).map(([, e]) => ({ item: e.item, need: e.need })) : [];
    const stale = missing.length > 0 || own.some((l) => l.needKnown && Math.abs(l.need - l.needRaised) > EPS);
    const status = requisitionStatus(own);
    const ready = known && res ? { state: res.state, readyDate: res.readyDate, soft: !!res.soft, text: res.text } : null;
    const live = own.filter((l) => l.status !== 'not_needed');
    const counts = { lines: live.length, over: own.filter((l) => l.cover.over > EPS).length };
    for (const k of Object.keys(LINE_STATUS_LABEL)) counts[k] = own.filter((l) => l.status === k).length;
    counts.waiting = live.filter((l) => l.ready?.state === 'waiting').length;
    const supply = supplyOf(h.supply);
    return {
      id: h.id, code: h.code, supply, supplyLabel: SUPPLY_LABEL[supply],
      // §79: what it is for (the cost follows it); an MR raised by hand has no line, and may have no order.
      forType, forLabel: FOR_LABEL[forType], manual, maintenanceOrderId: h.maintenance_order_id ?? null, notes: h.notes ?? null,
      order: h.order_id == null ? null : { id: h.order_id, code: h.order_code, status: h.order_status, customer: h.customer_id ? { id: h.customer_id, name: h.customer_name } : null },
      line: manual ? null : { id: lineId, lineNo: h.line_no, name: h.item_name ?? h.description ?? `Line ${h.line_no}`, quantity: Number(h.line_quantity), frozen: !!h.locked_at, released: !!h.release_id },
      status, statusLabel: REQUISITION_STATUS_LABEL[status], done: live.length > 0 ? live.every((l) => l.resolved) : true,
      // §73: raised before the customer accepted — shared with the customer, not released to Purchase yet.
      heldForAcceptance: !!Number(h.held_for_acceptance ?? 0),
      customerDate: dateOnly(h.customer_date),
      sentence: Number(h.held_for_acceptance ?? 0) ? HELD_SENTENCE
        : manual ? manualSentence(status, own, forType)
        : !known ?`${needs?.why ?? 'This line is not on an open order.'} The requisition shows the need as it was last raised.` : requisitionSentence(status, own, ready),
      raisedAt: h.created_at, raisedBy: h.created_by ? { id: h.created_by, name: h.raised_by_name ?? null } : null, syncedAt: h.synced_at ?? null,
      needKnown: known, needComplete: !!needs?.ready, stale, missing, counts,
      materialReady: ready,
      lines: own,
    };
  });
}

export async function requireOrderRow(db, companyId, orderId, { lock = false } = {}) {
  const [[o]] = await db.query(`SELECT id, code, status, order_type, customer_id, material_supply FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(orderId)]);
  if (!o) throw notFound('Sales order');
  return o;
}

/**
 * Who supplies each live line's material (§66): Map lineId -> { own: 'we_buy'|'customer'|null, supply }
 * — `own` is the line's own answer (null = as the order), `supply` the one that counts. 1 read.
 */
export async function lineSupplies(db, companyId, orderId) {
  const [rows] = await db.query(
    `SELECT l.id, l.material_supply AS own, o.material_supply AS order_supply
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id
      WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL`,
    [companyId, Number(orderId)],
  );
  return new Map(rows.map((r) => [Number(r.id), { own: r.own == null ? null : supplyOf(r.own), supply: supplyOf(r.own ?? r.order_supply) }]));
}

/**
 * GET /orders/:id/requisitions — every material request (MR) of the order, and its lines
 * that have none yet (with what they need and who supplies it, so the screen can offer "Raise").
 */
export async function orderRequisitions(db, companyId, orderId, { R: given = null } = {}) {
  const o = await requireOrderRow(db, companyId, orderId);
  const R = given ?? await lineReadiness(db, companyId, { full: true });
  // The order's own MRs (one per line); one raised by hand for the order (§79) lives in Stores' inbox.
  const requisitions = await readRequisitions(db, companyId, { orderId: o.id, lineBound: true }, { R });
  const have = new Set(requisitions.map((r) => r.line.id));
  const open = OPEN_ORDER_STATUSES.includes(o.status);
  const linesWithout = R.lines.filter((l) => Number(l.order_id) === Number(o.id) && !have.has(Number(l.id))).map((l) => {
    const n = R.needs.get(Number(l.id));
    const res = R.byLine.get(Number(l.id));
    const materials = n?.known ? [...n.items.values()].map((e) => ({ item: e.item, need: e.need })) : [];
    // Who supplies it (§66) rides on the open-lines read the engine already made — no read of its own.
    const sup = { own: l.own_supply == null ? null : supplyOf(l.own_supply), supply: supplyOf(l.own_supply ?? l.order_supply ?? o.material_supply) };
    return {
      line: { id: Number(l.id), lineNo: l.line_no, name: l.item_name ?? l.description ?? `Line ${l.line_no}`, quantity: Number(l.quantity), frozen: !!l.locked_at, released: !!l.release_id },
      supply: sup.supply, supplyLabel: SUPPLY_LABEL[sup.supply], ownSupply: sup.own,
      // §68: the customer's promised date the raise proposes for this line (its committed date, else the order's).
      customerDateDefault: dateOnly(l.committed_date) ?? dateOnly(l.order_committed) ?? null,
      canRaise: !!n?.known && materials.length > 0,
      reason: !n?.known ? n?.why ?? null : materials.length ? (n.ready ? null : n.why) : 'Everything under this line is made — it buys nothing.',
      materials,
      materialReady: n?.known && res ? { state: res.state, readyDate: res.readyDate, soft: !!res.soft, text: res.text } : null,
    };
  });
  return {
    order: { id: o.id, code: o.code, status: o.status, open, materialSupply: supplyOf(o.material_supply), materialSupplyLabel: SUPPLY_LABEL[supplyOf(o.material_supply)] },
    today: R.today,
    reason: open ? null : `${o.code} is ${o.status} — a material request is raised for an inquiry, a quoted or a confirmed order.`,
    requisitions,
    linesWithout,
  };
}

/** GET /requisitions/:id */
export async function getRequisition(db, companyId, id, opts = {}) {
  const [r] = await readRequisitions(db, companyId, { id }, opts);
  if (!r) throw notFound('Requisition');
  return r;
}

/** GET /order-lines/:id/requisition — the line's requisition, or { requisition: null, canRaise, reason, materials }. */
export async function lineRequisition(db, companyId, lineId) {
  const [[l]] = await db.query('SELECT id, order_id FROM cf_sales_order_lines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(lineId)]);
  if (!l) throw notFound('Order line');
  const all = await orderRequisitions(db, companyId, l.order_id);
  const requisition = all.requisitions.find((r) => r.line.id === Number(l.id)) ?? null;
  const without = all.linesWithout.find((x) => x.line.id === Number(l.id)) ?? null;
  return { order: all.order, today: all.today, requisition, ...(without ? { canRaise: without.canRaise, reason: without.reason, materials: without.materials, materialReady: without.materialReady } : {}) };
}

// --- an MR raised by hand (§79) ----------------------------------------------------------------

/**
 * THE GENERAL MR — the stable contract for Stores, the reorder list and maintenance (§82):
 *   createRequisition(db, c, { forType, orderId?, maintenanceOrderId?, note?, lines: [{ itemId, qty, uom? }] }) → { id, code }
 * (HTTP: POST /requisitions with the same body.)
 *   forType  'sales_order' (orderId required) | 'maintenance_order' (maintenanceOrderId required; orderId optional — its
 *            cost then goes to that order) | 'stock' (no order) | 'general' (orderId optional).
 *   lines    catalog items, quantity > 0; the same item twice is added up; uom defaults to the item's.
 * The MR has no order line: it goes to STORES (Stores' MR inbox), who take from stock and raise the PR for the rest
 * (purchaseRequestService.saveMr). Numbered MR-000123. Every problem at once. Fixed round trips: ≤ 2 reads + 3 writes.
 */
export async function createRequisition(db, c, input = {}) {
  const problems = [];
  const forType = String(input.forType ?? '');
  if (!FOR_TYPES.includes(forType)) problems.push(`"For" is one of: ${FOR_TYPES.join(', ')}.`);
  const orderId = blank(input.orderId) ? null : Number(input.orderId);
  const maintId = blank(input.maintenanceOrderId) ? null : Number(input.maintenanceOrderId);
  if (orderId != null && !(Number.isInteger(orderId) && orderId > 0)) problems.push('That sales order is not a valid id.');
  if (maintId != null && !(Number.isInteger(maintId) && maintId > 0)) problems.push('That maintenance order is not a valid id.');
  if (forType === 'sales_order' && orderId == null) problems.push('An MR for a sales order names the order.');
  if (forType === 'maintenance_order' && maintId == null) problems.push('An MR for a maintenance order names the maintenance order.');
  if (forType === 'stock' && orderId != null) problems.push('An MR for stock is for no order — leave the sales order out.');
  if (forType !== 'maintenance_order' && maintId != null) problems.push('Only an MR for a maintenance order names one.');
  const rows = Array.isArray(input.lines) ? input.lines : [];
  if (!rows.length) problems.push('Add at least one item.');
  if (rows.length > 500) problems.push('At most 500 lines on one MR.');
  const want = new Map();                            // itemId -> { qty, uom }
  rows.forEach((r, k) => {
    const itemId = Number(r?.itemId);
    const qty = Number(r?.qty ?? r?.quantity);
    if (!Number.isInteger(itemId) || itemId <= 0) { problems.push(`Row ${k + 1}: pick the item.`); return; }
    if (!Number.isFinite(qty) || qty <= 0) { problems.push(`Row ${k + 1}: the quantity is a number above zero.`); return; }
    const e = want.get(itemId) ?? { qty: 0, uom: blank(r?.uom) ? null : String(r.uom).slice(0, 20) };
    e.qty = round6(e.qty + qty);
    want.set(itemId, e);
  });
  const ids = [...want.keys()];
  const [[orders], [items]] = await Promise.all([
    orderId != null && Number.isInteger(orderId) ? db.query('SELECT id, code, status FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, orderId]) : [[]],
    ids.length ? db.query(
      `SELECT m.id, m.code, m.name, m.status, i.item_type, i.uom FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
        WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`,
      [c.companyId, ids],
    ) : [[]],
  ]);
  const order = orders[0] ?? null;
  if (orderId != null && Number.isInteger(orderId) && !order) problems.push('That sales order does not exist.');
  else if (order && !OPEN_ORDER_STATUSES.includes(order.status)) problems.push(`${order.code} is ${order.status} — an MR is raised for an open order.`);
  const itemOf = new Map(items.map((i) => [Number(i.id), i]));
  for (const id of ids) {
    const it = itemOf.get(id);
    if (!it) problems.push(`Item ${id} does not exist.`);
    else if (it.item_type !== 'catalog') problems.push(`${it.code ?? it.name}: it is made on its order — an MR asks for catalog items.`);
    else if (it.status === 'obsolete') problems.push(`${it.code ?? it.name}: the item is obsolete.`);
  }
  assertNoProblems(problems, 'The material request cannot be raised.');
  const note = blank(input.note ?? input.notes) ? null : String(input.note ?? input.notes).trim().slice(0, 500);
  const [ins] = await db.query(
    `INSERT INTO cf_requisitions (company_id, code, order_id, order_line_id, for_type, maintenance_order_id, supply, notes, created_by, held_for_acceptance)
     VALUES (?, ?, ?, NULL, ?, ?, 'we_buy', ?, ?, 0)`,
    [c.companyId, `TMP-MR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, order?.id ?? null, forType, maintId, note, c.userId ?? null],
  );
  const id = ins.insertId;
  const code = `MR-${String(id).padStart(6, '0')}`;
  await db.query('UPDATE cf_requisitions SET code = ? WHERE company_id = ? AND id = ?', [code, c.companyId, id]);
  await insertRows(db, 'cf_requisition_lines', ['company_id', 'requisition_id', 'order_line_id', 'item_id', 'quantity', 'uom', 'created_by'],
    ids.map((itemId) => [c.companyId, id, null, itemId, want.get(itemId).qty, want.get(itemId).uom ?? itemOf.get(itemId)?.uom ?? null, c.userId ?? null]));
  return { id, code };
}

// --- raising, and keeping the lines up to date --------------------------------------------

/**
 * Brings the lines of some requisitions up to the need of their order lines:
 * a new material gets a line, a changed need its quantity; a material the line
 * no longer needs keeps its line at 0 while anything is held or coming for it
 * (so the excess is seen and let go by a person), else the line is retired.
 * prs: [{ id, order_line_id }]. A line whose need is not known is left alone.
 * 1 read (+1 when a material went away), ≤ 4 writes.
 */
export async function syncLines(db, c, prs, needs) {
  if (!prs.length) return { added: 0, changed: 0, retired: 0 };
  const [have] = await db.query(
    'SELECT id, requisition_id, item_id, quantity FROM cf_requisition_lines WHERE company_id = ? AND requisition_id IN (?) AND deleted_at IS NULL',
    [c.companyId, prs.map((p) => p.id)],
  );
  const inserts = [];
  const updates = [];
  const stale = [];
  const touched = [];
  for (const pr of prs) {
    const n = needs.get(Number(pr.order_line_id));
    if (!n?.known) continue;
    touched.push(pr.id);
    const mine = have.filter((r) => r.requisition_id === pr.id);
    const byItem = new Map(mine.map((r) => [Number(r.item_id), r]));
    for (const [itemId, e] of n.items) {
      const row = byItem.get(itemId);
      if (!row) inserts.push([c.companyId, pr.id, pr.order_line_id, itemId, e.need, e.item.uom ?? null, c.userId ?? null]);
      else if (Math.abs(Number(row.quantity) - e.need) > EPS) updates.push([row.id, e.need]);
    }
    for (const row of mine) if (!n.items.has(Number(row.item_id))) stale.push(row);
  }
  let retired = 0;
  if (stale.length) {
    const ids = stale.map((r) => r.id);
    const [covered] = await db.query(
      `SELECT pr_line_id FROM cf_stock_reservations WHERE company_id = ? AND pr_line_id IN (?) AND status = 'active' AND deleted_at IS NULL
        UNION SELECT pr_line_id FROM cf_purchase_line_orders WHERE company_id = ? AND pr_line_id IN (?) AND deleted_at IS NULL AND quantity > qty_received`,
      [c.companyId, ids, c.companyId, ids],
    );
    const keep = new Set(covered.map((r) => r.pr_line_id));
    const gone = stale.filter((r) => !keep.has(r.id)).map((r) => r.id);
    for (const r of stale) if (keep.has(r.id) && Number(r.quantity) > EPS) updates.push([r.id, 0]);
    if (gone.length) await db.query('UPDATE cf_requisition_lines SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, gone]);
    retired = gone.length;
  }
  await insertRows(db, 'cf_requisition_lines', ['company_id', 'requisition_id', 'order_line_id', 'item_id', 'quantity', 'uom', 'created_by'], inserts);
  if (updates.length) {
    await db.query(
      `UPDATE cf_requisition_lines SET quantity = CASE id ${updates.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
      [...updates.flat(), c.companyId, updates.map((u) => u[0])],
    );
  }
  if (touched.length) await db.query('UPDATE cf_requisitions SET synced_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, touched]);
  return { added: inserts.length, changed: updates.length, retired };
}

/**
 * POST /orders/:id/requisitions { lineIds? } — raises the requisition of every
 * line of the order whose material is known (or of the lines named), and brings
 * the lines of those it already has up to date. Earmarks NOTHING. What the
 * order already had held or on order "for the order as a whole" is handed to
 * the new requisition lines (adoptOrderCover). Returns orderRequisitions +
 * { raised, refreshed, notRaised: [{ lineNo, reason }] }.
 */
export async function raiseRequisitions(db, c, orderId, input = {}) {
  const o = await requireOrderRow(db, c.companyId, orderId, { lock: true });
  if (!OPEN_ORDER_STATUSES.includes(o.status)) {
    throw invalid('NOT_OPEN', `${o.code} is ${o.status} — a material request is raised for an inquiry, a quoted or a confirmed order.`);
  }
  let lines = await openLines(db, c.companyId, { orderIds: [o.id] });
  if (Array.isArray(input.lineIds)) {
    const want = new Set(input.lineIds.map(Number));
    const found = new Set(lines.map((l) => Number(l.id)));
    const unknown = [...want].filter((id) => !found.has(id));
    if (unknown.length) throw invalid('INVALID', `${plural(unknown.length, 'line')} named ${unknown.length === 1 ? 'is' : 'are'} not an open line of ${o.code}.`);
    lines = lines.filter((l) => want.has(Number(l.id)));
  }
  const needs = await lineNeeds(db, c.companyId, lines);
  const notRaised = [];
  const can = [];
  for (const l of lines) {
    const n = needs.get(Number(l.id));
    if (!n?.known) notRaised.push({ lineId: Number(l.id), lineNo: l.line_no, reason: n?.why ?? 'Its material is not known yet.' });
    else if (!n.items.size) notRaised.push({ lineId: Number(l.id), lineNo: l.line_no, reason: 'Everything under this line is made — it buys nothing.' });
    else can.push(l);
  }
  if (!can.length) {
    throw invalid('NOTHING_TO_RAISE', `Nothing can be put on a material request for ${o.code} yet.`, { problems: notRaised.map((x) => `Line ${x.lineNo}: ${x.reason}`) });
  }
  const lineIds = can.map((l) => Number(l.id));
  const [[had], supplies] = await Promise.all([
    db.query('SELECT id, order_line_id FROM cf_requisitions WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [c.companyId, lineIds]),
    lineSupplies(db, c.companyId, o.id),
  ]);
  const hadLine = new Set(had.map((r) => Number(r.order_line_id)));
  const fresh = can.filter((l) => !hadLine.has(Number(l.id)));
  // §73: before the customer's acceptance is approved the MR is raised HELD (shared, not released to Purchase).
  const held = heldForAcceptance(o);
  let customerDate = null;
  if (held && !blank(input.customerDate)) {
    if (!DATE_RE.test(String(input.customerDate))) throw invalid('INVALID', "The customer's promised date needs YYYY-MM-DD.");
    customerDate = String(input.customerDate);
  }
  // A new one is an MR (§66); who supplies its material is set on it (and follows the order until it is released, §73).
  await insertRows(db, 'cf_requisitions', ['company_id', 'code', 'order_id', 'order_line_id', 'supply', 'notes', 'created_by', 'held_for_acceptance', 'customer_date'],
    fresh.map((l) => [c.companyId, `${MR_PREFIX}-${o.code}-${l.line_no}`.slice(0, 140), o.id, l.id, supplies.get(Number(l.id))?.supply ?? supplyOf(o.material_supply),
      blank(input.notes) ? null : String(input.notes).slice(0, 500), c.userId ?? null, held ? 1 : 0, customerDate]));
  if (held && customerDate && had.length) {
    await db.query('UPDATE cf_requisitions SET customer_date = ? WHERE company_id = ? AND id IN (?) AND held_for_acceptance = 1', [customerDate, c.companyId, had.map((r) => r.id)]);
  }
  const [prs] = await db.query('SELECT id, order_line_id, supply, held_for_acceptance FROM cf_requisitions WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [c.companyId, lineIds]);
  await syncLines(db, c, prs, needs);
  if (held) {
    // Shared with the customer, nothing downstream: no earmark, no customer PO, no adopted cover.
    return { raised: fresh.length, refreshed: had.length, notRaised, earmarked: [], customerPurchaseOrders: [], heldForAcceptance: true, ...(await orderRequisitions(db, c.companyId, o.id)) };
  }
  await adoptOrderCover(db, c, [o.id], { needs });
  /*
   * MR (§66): raising it EARMARKS. A line the customer supplies always takes the customer's own lots that are
   * here for this order; with { earmark: true } (the screen's "Raise the MR") a line we buy takes free stock —
   * the stock check's own proposal, applied. Then what a customer line still lacks goes on a purchase order to
   * the customer as vendor. Without either the raise earmarks nothing, as it always did.
   */
  const ours = input.earmark === true || input.earmark === 'true';
  const theirs = prs.filter((p) => supplyOf(p.supply) === 'customer').map((p) => p.id);
  const earmarked = ours || theirs.length ? await earmarkOnRaise(db, c, o, ours ? prs.map((p) => p.id) : theirs, { ours }) : [];
  const customerPurchaseOrders = theirs.length ? await askCustomer(db, c, o, theirs, { date: input.customerDate, lines: can }) : [];
  return { raised: fresh.length, refreshed: had.length, notRaised, earmarked, customerPurchaseOrders, heldForAcceptance: false, ...(await orderRequisitions(db, c.companyId, o.id)) };
}

/**
 * THE ACCEPTANCE IS APPROVED (§73): the order's HELD MRs are released to Purchase — exactly what raising them on a
 * confirmed order does: what the order already had held / on order is handed to them (adoptOrderCover), a line the
 * customer supplies takes the customer's own lots here for the order, and what it still lacks goes on the customer's
 * ₹0 PO (dated by the promised date typed when it was raised, else the committed dates). A line we buy goes to the MR
 * screen in Purchase (take from stock, then the PR). Called by setOrderStatus when the order becomes confirmed.
 * Nothing held → nothing done (1 read).
 */
export async function releaseHeldRequisitions(db, c, orderId) {
  const [held] = await db.query('SELECT id, order_line_id, supply, customer_date FROM cf_requisitions WHERE company_id = ? AND order_id = ? AND held_for_acceptance = 1 AND deleted_at IS NULL', [c.companyId, Number(orderId)]);
  if (!held.length) return { released: [], earmarked: [], customerPurchaseOrders: [] };
  const o = await requireOrderRow(db, c.companyId, orderId);
  await db.query('UPDATE cf_requisitions SET held_for_acceptance = 0 WHERE company_id = ? AND id IN (?)', [c.companyId, held.map((r) => r.id)]);
  const lines = await openLines(db, c.companyId, { orderIds: [o.id] });
  const needs = await lineNeeds(db, c.companyId, lines);
  await syncLines(db, c, held, needs);
  await adoptOrderCover(db, c, [o.id], { needs });
  const theirs = held.filter((p) => supplyOf(p.supply) === 'customer');
  const ids = theirs.map((p) => p.id);
  const earmarked = ids.length ? await earmarkOnRaise(db, c, o, ids, { ours: false }) : [];
  const date = theirs.map((p) => dateOnly(p.customer_date)).filter(Boolean).sort()[0] ?? null;
  const customerPurchaseOrders = ids.length ? await askCustomer(db, c, o, ids, { date, lines }) : [];
  return { released: held.map((r) => r.id), earmarked, customerPurchaseOrders };
}

/** The supply of an order's HELD MRs follows the order / its lines while they wait (§73: editable until accepted). 1 write. */
export async function followSupplyOfHeld(db, c, orderId) {
  await db.query(
    `UPDATE cf_requisitions r JOIN cf_sales_order_lines l ON l.id = r.order_line_id JOIN cf_sales_orders o ON o.id = r.order_id
        SET r.supply = IF(COALESCE(l.material_supply, o.material_supply) = 'customer', 'customer', 'we_buy')
      WHERE r.company_id = ? AND r.order_id = ? AND r.held_for_acceptance = 1 AND r.deleted_at IS NULL`,
    [c.companyId, Number(orderId)],
  );
}

/**
 * Earmarks free stock for MR lines when the MR is raised — the stock check's proposal (min(free, open)), for
 * many MRs of ONE order in one go: a line the customer supplies takes only the customer's own lots for this
 * order; a line we buy (only when `ours`) takes what the stock check would (their lots for this order first,
 * then ours). In claim order (line number), each claim taken off what is free for the next. Fixed: the engine
 * + 4 reads (MRs, item locks, availability) + 1 insert, whatever the number of lines.
 * Returns [{ requisition: { id, code }, lineId, item, quantity, owner: 'ours' | 'customer' }].
 */
async function earmarkOnRaise(db, c, o, prIds, { ours = false } = {}) {
  if (!prIds.length) return [];
  const views = await readRequisitions(db, c.companyId, { ids: prIds });
  const lines = views.filter((v) => ours || v.supply === 'customer')
    .flatMap((v) => v.lines.filter((l) => l.status !== 'not_needed' && l.cover.open > EPS && l.item.trackedBy !== 'individual').map((l) => ({ v, l })));
  if (!lines.length) return [];
  const itemIds = [...new Set(lines.map((x) => Number(x.l.item.id)))].sort((a, b) => a - b);
  await db.query('SELECT master_id FROM cf_item_details WHERE company_id = ? AND master_id IN (?) ORDER BY master_id FOR UPDATE', [c.companyId, itemIds]);
  const av = await availability(db, c.companyId, itemIds, { orderId: o.id, holds: 'none' });
  const out = [];
  const rows = [];
  for (const { v, l } of lines) {
    const theirsOnly = v.supply === 'customer';
    const a = av.get(Number(l.item.id));
    if (!a) continue;
    const free = round6(theirsOnly ? a.theirsFree : a.free);
    const q = round6(Math.min(free, l.cover.open));
    if (q <= EPS) continue;
    const took = claimRows(a, l.item.trackedBy, q, { theirsOnly });
    const got = round6(q - took.left);
    if (got <= EPS) continue;
    for (const r of took.rows) {
      // What is claimed is no longer free for the next line (availability's numbers, kept current in memory).
      const lot = r.batchId != null ? a.batches.find((b) => b.batchId === r.batchId) : null;
      if (lot) lot.free = round6(lot.free - r.quantity);
      if (lot?.owner === 'theirs') a.theirsFree = round6(a.theirsFree - r.quantity);
      a.free = round6(a.free - r.quantity);
      rows.push([c.companyId, o.id, l.id, l.item.id, r.batchId, r.quantity, c.userId ?? null]);
    }
    out.push({ requisition: { id: v.id, code: v.code }, lineId: l.id, item: l.item, quantity: got, owner: theirsOnly ? 'customer' : 'ours' });
  }
  await insertRows(db, 'cf_stock_reservations', ['company_id', 'held_for_order_id', 'pr_line_id', 'item_id', 'batch_id', 'quantity', 'created_by'], rows);
  return out;
}

/**
 * The CUSTOMER'S PURCHASE ORDER (§66): what the customer-supplied MR lines still lack is put on one purchase
 * order to the order's customer as vendor — placed (they are told to send it), no date until one is set,
 * ₹0. Its receipt is the customer's own lot, earmarked to the MR line (purchaseService.receiveLine).
 * Nothing open → nothing made. Returns the purchase orders made (purchaseOrdersBrief).
 */
export async function askCustomer(db, c, o, prIds, { date = null, lines = [] } = {}) {
  if (!o.customer_id) return [];
  const views = await readRequisitions(db, c.companyId, { ids: prIds });
  const asked = views.map((v) => ({ v, lines: v.lines.filter((l) => l.status !== 'not_needed' && l.cover.open > EPS && l.item.trackedBy !== 'individual') }))
    .filter((x) => x.lines.length);
  if (!asked.length) return [];
  /*
   * THE PROMISED DATE (§68): the date the customer is to send it by — typed on the raise (`customerDate`), else
   * the earliest committed date of the lines asked about, else the order's. With none, the raise is refused so
   * the screen can ask for it.
   */
  let promised = blank(date) ? null : String(date);
  if (promised && !DATE_RE.test(promised)) throw invalid('INVALID', "The customer's promised date needs YYYY-MM-DD.");
  if (!promised) {
    const asking = new Set(asked.map((x) => Number(x.v.line.id)));
    promised = lines.filter((l) => asking.has(Number(l.id))).map((l) => dateOnly(l.committed_date) ?? dateOnly(l.order_committed)).filter(Boolean).sort()[0] ?? null;
  }
  if (!promised) throw invalid('CUSTOMER_DATE', `Give the date ${o.code}'s customer promised to send the material — the line and the order have no committed date to take it from.`);
  const made = await makePurchaseOrders(db, c, {
    orders: [{
      supplierId: o.customer_id, place: true, expectedDate: promised,
      notes: `Material the customer supplies for ${o.code} (${asked.map((x) => x.v.code).join(', ')}).`,
      lines: asked.flatMap((x) => x.lines.map((l) => ({ prLineId: l.id, quantity: l.cover.open }))),
    }],
  });
  return made.purchaseOrders;
}

/** After a line is frozen again or released: its requisition's lines follow its need. A line with no requisition: nothing. */
export async function syncRequisitionOfLine(db, c, lineId) {
  const [prs] = await db.query('SELECT id, order_id, order_line_id FROM cf_requisitions WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [c.companyId, Number(lineId)]);
  if (!prs.length) return null;
  const lines = (await openLines(db, c.companyId, { orderIds: [prs[0].order_id] })).filter((l) => Number(l.id) === Number(lineId));
  if (!lines.length) return null;
  return syncLines(db, c, prs, await lineNeeds(db, c.companyId, lines));
}

/**
 * ORDER-LEVEL COVER BECOMES REQUISITION-LINE COVER. Holds and purchase
 * allocations written before §56 (or by a screen that only knows orders) are
 * "for the order as a whole". Where the order's lines have requisition lines
 * for that item, each such hold / outstanding allocation is handed to them in
 * LINE-NUMBER order, each up to what it still lacks — exactly the order the
 * engine would have used them in, so no answer changes. A hold or allocation
 * that spans two lines is split; what no requisition line needs stays the
 * order's. Used when a requisition is raised, by the old "request from the
 * order" route and by the migration (scripts/cf_kepl/buying-pr-migrate.mjs).
 * 4 reads, ≤ 4 writes, whatever the number of orders.
 */
export async function adoptOrderCover(db, c, orderIds, { needs = null } = {}) {
  const out = { holds: 0, holdQty: 0, allocations: 0, allocationQty: 0 };
  if (!orderIds.length) return out;
  const [prl] = await db.query(
    `SELECT pl.id, pl.item_id, pl.quantity, pl.order_line_id, LOWER(o.code) AS order_key, l.line_no
       FROM cf_requisition_lines pl
       JOIN cf_requisitions r ON r.id = pl.requisition_id AND r.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
      WHERE pl.company_id = ? AND r.order_id IN (?) AND pl.deleted_at IS NULL
      ORDER BY o.code, l.line_no, pl.order_line_id, pl.id`,
    [c.companyId, orderIds],
  );
  if (!prl.length) return out;
  const keys = [...new Set(prl.map((p) => p.order_key))];
  const items = [...new Set(prl.map((p) => Number(p.item_id)))];
  const [[holds], [allocs], [own]] = await Promise.all([
    db.query(
      `SELECT v.id, v.item_id, v.batch_id, v.quantity, v.purchase_line_id, v.held_for_order_id, v.created_by, LOWER(ho.code) AS order_key
         FROM cf_stock_reservations v JOIN cf_sales_orders ho ON ho.id = v.held_for_order_id
        WHERE v.company_id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND v.pr_line_id IS NULL AND v.held_for_order_id IS NOT NULL
          AND LOWER(ho.code) IN (?) AND v.item_id IN (?)
        ORDER BY v.id FOR UPDATE`,
      [c.companyId, keys, items],
    ),
    db.query(
      `SELECT a.id, a.purchase_line_id, a.order_id, a.quantity, a.qty_received, a.created_by, l.item_id, LOWER(o.code) AS order_key
         FROM cf_purchase_line_orders a
         JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id AND l.deleted_at IS NULL
         JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL AND p.status IN (?)
         JOIN cf_sales_orders o ON o.id = a.order_id
        WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.pr_line_id IS NULL AND LOWER(o.code) IN (?) AND l.item_id IN (?)
          AND a.quantity > a.qty_received
        ORDER BY a.id FOR UPDATE`,
      [LIVE_PO_STATUSES, c.companyId, keys, items],
    ),
    // What each requisition line already has of its own, so only what it still lacks is handed over.
    db.query(
      `SELECT x.pr_line_id, SUM(x.q) AS q FROM (
          SELECT v.pr_line_id, v.quantity AS q FROM cf_stock_reservations v
           WHERE v.company_id = ? AND v.pr_line_id IN (?) AND v.status = 'active' AND v.deleted_at IS NULL
          UNION ALL
          SELECT a.pr_line_id, GREATEST(a.quantity - a.qty_received, 0) AS q FROM cf_purchase_line_orders a
            JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id AND l.deleted_at IS NULL
            JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL AND p.status IN (?)
           WHERE a.company_id = ? AND a.pr_line_id IN (?) AND a.deleted_at IS NULL) x
        GROUP BY x.pr_line_id`,
      [c.companyId, prl.map((p) => p.id), LIVE_PO_STATUSES, c.companyId, prl.map((p) => p.id)],
    ),
  ]);
  if (!holds.length && !allocs.length) return out;
  const ownOf = new Map(own.map((r) => [r.pr_line_id, Number(r.q)]));
  const room = new Map();                            // pr line -> what it still lacks
  const linesOf = new Map();                         // `${orderKey}:${itemId}` -> [pr line], line order
  for (const p of prl) {
    const n = needs?.get(Number(p.order_line_id))?.items.get(Number(p.item_id));
    const need = n ? n.need - n.issued - n.reserved : Number(p.quantity);
    room.set(p.id, round6(Math.max(0, need - (ownOf.get(p.id) ?? 0))));
    const k = `${p.order_key}:${p.item_id}`;
    if (!linesOf.has(k)) linesOf.set(k, []);
    linesOf.get(k).push(p);
  }
  // Holds.
  const holdSet = [];                                // [id, quantity, prLineId|null]
  const holdNew = [];
  for (const h of holds) {
    let left = Number(h.quantity);
    let first = true;
    for (const p of linesOf.get(`${h.order_key}:${h.item_id}`) ?? []) {
      if (left <= EPS) break;
      const t = round6(Math.min(left, room.get(p.id)));
      if (t <= EPS) continue;
      room.set(p.id, round6(room.get(p.id) - t));
      left = round6(left - t);
      out.holdQty = round6(out.holdQty + t);
      // The row itself goes to the first line it serves; any further share is a new row beside it.
      if (first) { holdSet.push([h.id, t, p.id]); first = false; } else holdNew.push([c.companyId, h.held_for_order_id, p.id, h.purchase_line_id, h.item_id, h.batch_id, t, h.created_by]);
    }
    if (!first && left > EPS) holdNew.push([c.companyId, h.held_for_order_id, null, h.purchase_line_id, h.item_id, h.batch_id, left, h.created_by]);
    if (!first) out.holds += 1;
  }
  if (holdSet.length) {
    const ids = holdSet.map((x) => x[0]);
    await db.query(
      `UPDATE cf_stock_reservations SET quantity = CASE id ${holdSet.map(() => 'WHEN ? THEN ?').join(' ')} END,
              pr_line_id = CASE id ${holdSet.map(() => 'WHEN ? THEN ?').join(' ')} END
        WHERE company_id = ? AND id IN (?)`,
      [...holdSet.flatMap((x) => [x[0], x[1]]), ...holdSet.flatMap((x) => [x[0], x[2]]), c.companyId, ids],
    );
  }
  await insertRows(db, 'cf_stock_reservations', ['company_id', 'held_for_order_id', 'pr_line_id', 'purchase_line_id', 'item_id', 'batch_id', 'quantity', 'created_by'], holdNew);

  // Allocations: only what is still to come moves; what arrived stays where it was counted.
  const allocSet = [];                               // [id, quantity, prLineId|null]
  const allocNew = [];
  for (const a of allocs) {
    const received = Number(a.qty_received);
    let left = round6(Number(a.quantity) - received);
    const shares = [];
    for (const p of linesOf.get(`${a.order_key}:${a.item_id}`) ?? []) {
      if (left <= EPS) break;
      const t = round6(Math.min(left, room.get(p.id)));
      if (t <= EPS) continue;
      room.set(p.id, round6(room.get(p.id) - t));
      left = round6(left - t);
      shares.push([p.id, t]);
      out.allocationQty = round6(out.allocationQty + t);
    }
    if (!shares.length) continue;
    out.allocations += 1;
    if (left <= EPS && shares.length === 1) { allocSet.push([a.id, Number(a.quantity), shares[0][0]]); continue; }   // whole: the row moves
    // Split: the row keeps what arrived and what nobody claimed (the order's); each share is a new row.
    allocSet.push([a.id, round6(received + left), null]);
    for (const [prLineId, t] of shares) allocNew.push([c.companyId, a.purchase_line_id, a.order_id, prLineId, t, a.created_by]);
  }
  if (allocSet.length) {
    const ids = allocSet.map((x) => x[0]);
    const gone = allocSet.filter((x) => x[1] <= EPS).map((x) => x[0]);
    await db.query(
      `UPDATE cf_purchase_line_orders SET quantity = CASE id ${allocSet.map(() => 'WHEN ? THEN ?').join(' ')} END,
              pr_line_id = CASE id ${allocSet.map(() => 'WHEN ? THEN ?').join(' ')} END
        WHERE company_id = ? AND id IN (?)`,
      [...allocSet.flatMap((x) => [x[0], x[1]]), ...allocSet.flatMap((x) => [x[0], x[2]]), c.companyId, ids],
    );
    if (gone.length) await db.query('UPDATE cf_purchase_line_orders SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, gone]);
  }
  await insertRows(db, 'cf_purchase_line_orders', ['company_id', 'purchase_line_id', 'order_id', 'pr_line_id', 'quantity', 'created_by'], allocNew);
  return out;
}

// --- the stock check ------------------------------------------------------------------------

/**
 * What to claim of `qty` from an availability() entry: the customer's own lots first, then ours (lots for an
 * item kept by batch, else loose). `theirsOnly` (§66, a line the customer supplies): their lots and nothing else.
 */
export function claimRows(av, trackedBy, qty, { theirsOnly = false } = {}) {
  const rows = [];
  let left = round6(qty);
  const lots = (av?.batches ?? []).filter((b) => b.status === 'available' && b.free > EPS && (!theirsOnly || b.owner === 'theirs'));
  const takeLot = (b) => {
    if (left <= EPS) return;
    const t = round6(Math.min(left, b.free));
    rows.push({ batchId: b.batchId, quantity: t });
    left = round6(left - t);
  };
  if (trackedBy === 'batch') lots.forEach(takeLot);
  else {
    lots.filter((b) => b.owner === 'theirs').forEach(takeLot);
    const ours = theirsOnly ? 0 : round6((av?.free ?? 0) - (av?.theirsFree ?? 0));
    if (left > EPS && ours > EPS) { const t = round6(Math.min(left, ours)); rows.push({ batchId: null, quantity: t }); left = round6(left - t); }
  }
  return { rows, left };
}

// --- purchase orders from requisition lines ----------------------------------------------------

/**
 * THE CUSTOMER'S ₹0 PURCHASE ORDER from MR lines the customer supplies — askCustomer's only writer. §71 (2026-10-18): not
 * exported and refuses anything else (a vendor's PO is raised from the PR, purchaseRequestService.raisePo, and waits for
 * the MD). { orders: [{ supplierId?, expectedDate?, place?, notes?, lines: [{ prLineId, quantity?, expectedDate? }] }] };
 * quantity left out = what is still open on the MR line. Every problem is said at once. Fixed round trips.
 */
async function makePurchaseOrders(db, c, input = {}) {
  const list = Array.isArray(input.orders) ? input.orders : null;
  if (!list?.length) throw invalid('INVALID', 'Send the purchase orders to make: { orders: [{ supplierId?, expectedDate?, place?, lines: [{ prLineId, quantity?, expectedDate? }] }] }.');
  if (list.length > 50) throw invalid('TOO_MANY', 'At most 50 purchase orders in one go.');
  const prLineIds = [...new Set(list.flatMap((o) => (Array.isArray(o?.lines) ? o.lines : []).map((l) => Number(l?.prLineId))).filter((n) => Number.isInteger(n) && n > 0))];
  const supplierIds = [...new Set(list.map((o) => (blank(o?.supplierId) ? null : Number(o.supplierId))).filter((x) => x != null))];
  const [[prl], [sups]] = await Promise.all([
    prLineIds.length ? db.query(
      `SELECT pl.id, pl.item_id, pl.requisition_id, pl.order_line_id, r.order_id, r.code AS pr_code, r.supply, o.customer_id, o.code AS order_code, o.status AS order_status,
              sl.line_no, m.code AS item_code, m.name AS item_name, m.status AS item_status, COALESCE(pl.uom, i.uom) AS uom, i.item_type, i.tracked_by
         FROM cf_requisition_lines pl
         JOIN cf_requisitions r ON r.id = pl.requisition_id AND r.deleted_at IS NULL
         JOIN cf_sales_orders o ON o.id = r.order_id
         JOIN cf_sales_order_lines sl ON sl.id = r.order_line_id
         JOIN cf_master_records m ON m.id = pl.item_id
         LEFT JOIN cf_item_details i ON i.master_id = pl.item_id AND i.deleted_at IS NULL
        WHERE pl.company_id = ? AND pl.id IN (?) AND pl.deleted_at IS NULL FOR UPDATE`,
      [c.companyId, prLineIds],
    ) : [[]],
    supplierIds.length ? db.query('SELECT id, code, name, is_supplier, is_customer, status FROM cf_parties WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, supplierIds]) : [[]],
  ]);
  const prOf = new Map(prl.map((p) => [p.id, p]));
  const supOf = new Map(sups.map((s) => [s.id, s]));
  const views = await readRequisitions(db, c.companyId, { ids: [...new Set(prl.map((p) => p.requisition_id))] });
  const openOf = new Map(views.flatMap((v) => v.lines.map((l) => [l.id, l.cover.open])));
  const problems = [];
  const plans = [];
  list.forEach((o, k) => {
    const at = `Purchase order ${k + 1}`;
    let supplier = blank(o?.supplierId) ? null : supOf.get(Number(o.supplierId)) ?? null;
    /*
     * CUSTOMER-SUPPLIED (§66): the lines of an MR the customer supplies go on a purchase order to THAT
     * customer as vendor (₹0) — never to a supplier, never beside lines we buy. The customer need not be
     * marked as a supplier. Named or not, the vendor is the order's customer.
     */
    const named = (Array.isArray(o?.lines) ? o.lines : []).map((l) => prOf.get(Number(l?.prLineId))).filter(Boolean);
    const theirs = named.filter((p) => supplyOf(p.supply) === 'customer');
    let customerSupplied = false;
    if (theirs.length) {
      const customers = [...new Set(theirs.map((p) => p.customer_id))];
      if (theirs.length < named.length) problems.push(`${at}: it mixes material the customer supplies (${[...new Set(theirs.map((p) => p.pr_code))].join(', ')}) with material we buy — put them on separate purchase orders.`);
      else if (customers.length > 1 || !customers[0]) problems.push(`${at}: material the customer supplies goes on a purchase order to that one customer.`);
      else if (!blank(o?.supplierId) && Number(o.supplierId) !== Number(customers[0])) problems.push(`${at}: ${[...new Set(theirs.map((p) => p.pr_code))].join(', ')} is supplied by the customer — its purchase order is made out to the customer, not to a supplier.`);
      else {
        customerSupplied = true;
        supplier = supOf.get(Number(customers[0])) ?? { id: customers[0], name: 'the customer', status: 'active', is_customer: 1 };
      }
    }
    // §71 (2026-10-18): this makes the CUSTOMER's ₹0 PO only (askCustomer). A PO to a vendor is raised from the PR
    // (purchaseRequestService.raisePo) and waits for the MD — any other use is refused here.
    if (!customerSupplied) { problems.push(`${at}: only the customer's own purchase order is made here — a vendor's PO is raised from the purchase request.`); return; }
    if (!blank(o?.supplierId) && !customerSupplied) {
      if (!supplier) problems.push(`${at}: that supplier does not exist.`);
      else if (!Number(supplier.is_supplier)) problems.push(`${at}: ${supplier.name} is not marked as a supplier.`);
      else if (supplier.status !== 'active') problems.push(`${at}: ${supplier.name} is inactive.`);
    }
    const place = customerSupplied ? o?.place !== false && o?.place !== 'false' : o?.place === true || o?.place === 'true';
    if (place && !supplier) problems.push(`${at}: name the supplier — a purchase order addressed to nobody cannot be placed.`);
    let poDate = null;
    if (!blank(o?.expectedDate)) { if (DATE_RE.test(String(o.expectedDate))) poDate = String(o.expectedDate); else problems.push(`${at}: the expected date needs YYYY-MM-DD.`); }
    const lines = Array.isArray(o?.lines) ? o.lines : [];
    if (!lines.length) { problems.push(`${at}: it has no lines.`); return; }
    const byItem = new Map();                        // itemId -> { date, dates:Set, price, shares: [{ pr, quantity }] }
    const seen = new Set();
    for (const [i, l] of lines.entries()) {
      const pr = prOf.get(Number(l?.prLineId));
      if (!pr) { problems.push(`${at}, row ${i + 1}: that requisition line does not exist.`); continue; }
      const who = `${at} · ${pr.order_code} line ${pr.line_no} · ${pr.item_code ?? pr.item_name}`;
      if (seen.has(pr.id)) { problems.push(`${who}: named twice on this purchase order.`); continue; }
      seen.add(pr.id);
      if (!BUYABLE_ORDER_STATUSES.includes(pr.order_status)) { problems.push(`${who}: ${pr.order_code} is ${pr.order_status} — nothing is bought for it.`); continue; }
      if (pr.item_type !== 'catalog') { problems.push(`${who}: it is made on its order — only catalog items are bought.`); continue; }
      if (pr.tracked_by === 'individual') { problems.push(`${who}: it is tracked unit by unit — no stock is kept of it yet.`); continue; }
      if (pr.item_status === 'obsolete') { problems.push(`${who}: the item is obsolete.`); continue; }
      const open = round6(openOf.get(pr.id) ?? 0);
      const q = blank(l?.quantity) ? open : Number(l.quantity);
      if (!Number.isFinite(q) || q <= 0) { problems.push(blank(l?.quantity) ? `${who}: nothing is still open on it — there is nothing to order.` : `${who}: the quantity is a number above zero.`); continue; }
      if (q > open + EPS) { problems.push(`${who}: only ${fmt(open)}${pr.uom ? ` ${pr.uom}` : ''} is still open — ${fmt(q)} would buy more than the line needs.`); continue; }
      openOf.set(pr.id, round6(open - q));           // a line split over two POs of this call
      let date = poDate;
      if (!blank(l?.expectedDate)) { if (DATE_RE.test(String(l.expectedDate))) date = String(l.expectedDate); else { problems.push(`${who}: the receiving date needs YYYY-MM-DD.`); continue; } }
      let price = customerSupplied ? 0 : null;
      if (!blank(l?.unitPrice) && !customerSupplied) { price = Number(l.unitPrice); if (!Number.isFinite(price) || price < 0) { problems.push(`${who}: the unit price is a number, zero or more.`); continue; } }
      const e = byItem.get(pr.item_id) ?? { itemId: pr.item_id, uom: pr.uom ?? 'nos', name: pr.item_code ?? pr.item_name, dates: new Set(), price: null, shares: [] };
      e.dates.add(date ?? '');
      if (price != null) e.price = price;
      e.shares.push({ pr, quantity: round6(q) });
      byItem.set(pr.item_id, e);
    }
    for (const e of byItem.values()) {
      if (e.dates.size > 1) problems.push(`${at} · ${e.name}: it is asked for with ${e.dates.size} receiving dates (${[...e.dates].map((d) => d || 'none').join(', ')}) — a purchase order has one line per item. Give them one date, or put them on separate purchase orders.`);
    }
    const orders = new Set([...byItem.values()].flatMap((e) => e.shares.map((s) => s.pr.order_id)));
    plans.push({ k, supplier, place, poDate, customerSupplied, notes: blank(o?.notes) ? null : String(o.notes), items: [...byItem.values()], forOrderId: orders.size === 1 ? [...orders][0] : null });
  });
  assertNoProblems(problems, 'The purchase orders cannot be made.');

  // The orders: one INSERT, read back by a temporary number, then numbered PO-000123 like every PO raised without a coding rule.
  const stamp = `TMP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await insertRows(db, 'cf_purchase_orders', ['company_id', 'code', 'supplier_id', 'status', 'suggested', 'expected_date', 'notes', 'for_order_id', 'supplied_by_customer', 'created_by'],
    plans.map((p) => [c.companyId, `${stamp}-${p.k}`, p.supplier?.id ?? null, p.place ? 'ordered' : 'requested', 0, p.poDate,
      p.notes ?? (p.customerSupplied ? 'Material the customer supplies.' : 'Made from material requests.'), p.forOrderId, p.customerSupplied ? 1 : 0, c.userId ?? null]));
  const [made] = await db.query('SELECT id, code FROM cf_purchase_orders WHERE company_id = ? AND code LIKE ?', [c.companyId, `${stamp}-%`]);
  const idOf = new Map(made.map((r) => [Number(String(r.code).slice(stamp.length + 1)), r.id]));
  // ordered_at is stamped by the database (a DATETIME never passes through JavaScript on the way in — ARCHITECTURE.md §13).
  await db.query("UPDATE cf_purchase_orders SET code = CONCAT('PO-', LPAD(id, 6, '0')), ordered_at = IF(status = 'ordered', NOW(), NULL) WHERE company_id = ? AND id IN (?)", [c.companyId, made.map((r) => r.id)]);
  const prices = await lastPricesPaid(db, c.companyId, [...new Set(plans.flatMap((p) => p.items.map((e) => e.itemId)))]);
  await insertRows(db, 'cf_purchase_order_lines', ['company_id', 'purchase_order_id', 'line_no', 'item_id', 'quantity', 'uom', 'expected_date', 'unit_price', 'currency'],
    plans.flatMap((p) => p.items.map((e, i) => [c.companyId, idOf.get(p.k), i + 1, e.itemId, round6(e.shares.reduce((t, s) => t + s.quantity, 0)), e.uom,
      [...e.dates][0] || null, p.customerSupplied ? 0 : e.price ?? prices.get(e.itemId)?.unitPrice ?? null, CURRENCY])));
  const poIds = [...idOf.values()];
  const [poLines] = await db.query('SELECT id, purchase_order_id, item_id FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id IN (?) AND deleted_at IS NULL', [c.companyId, poIds]);
  const lineOf = new Map(poLines.map((l) => [`${l.purchase_order_id}:${l.item_id}`, l.id]));
  await insertRows(db, 'cf_purchase_line_orders', ['company_id', 'purchase_line_id', 'order_id', 'pr_line_id', 'quantity', 'created_by'],
    plans.flatMap((p) => p.items.flatMap((e) => e.shares.map((s) => [c.companyId, lineOf.get(`${idOf.get(p.k)}:${e.itemId}`), s.pr.order_id, s.pr.id, s.quantity, c.userId ?? null]))));
  return {
    purchaseOrders: await purchaseOrdersBrief(db, c.companyId, poIds),
    requisitions: await readRequisitions(db, c.companyId, { ids: [...new Set(prl.map((p) => p.requisition_id))] }),
  };
}

/** Purchase orders in short, each line with the requisition lines it is bought for. 2 reads for any number. */
export async function purchaseOrdersBrief(db, companyId, poIds) {
  if (!poIds.length) return [];
  const [[pos], [lines]] = await Promise.all([
    db.query(
      `SELECT p.id, p.code, p.status, p.expected_date, p.for_order_id, p.supplied_by_customer, fo.code AS for_order_code, s.id AS supplier_id, s.name AS supplier_name
         FROM cf_purchase_orders p LEFT JOIN cf_parties s ON s.id = p.supplier_id LEFT JOIN cf_sales_orders fo ON fo.id = p.for_order_id
        WHERE p.company_id = ? AND p.id IN (?) AND p.deleted_at IS NULL ORDER BY p.id`,
      [companyId, poIds],
    ),
    db.query(
      `SELECT l.id, l.purchase_order_id, l.line_no, l.item_id, m.code AS item_code, m.name AS item_name, l.uom, l.quantity, l.qty_received, l.expected_date, l.unit_price,
              a.id AS allocation_id, a.pr_line_id, a.quantity AS a_quantity, a.qty_received AS a_received, o.id AS order_id, o.code AS order_code, r.id AS requisition_id, r.code AS requisition_code
         FROM cf_purchase_order_lines l
         JOIN cf_master_records m ON m.id = l.item_id
         LEFT JOIN cf_purchase_line_orders a ON a.purchase_line_id = l.id AND a.deleted_at IS NULL
         LEFT JOIN cf_sales_orders o ON o.id = a.order_id
         LEFT JOIN cf_requisition_lines pl ON pl.id = a.pr_line_id
         LEFT JOIN cf_requisitions r ON r.id = pl.requisition_id
        WHERE l.company_id = ? AND l.purchase_order_id IN (?) AND l.deleted_at IS NULL
        ORDER BY l.purchase_order_id, l.line_no, l.id, a.id`,
      [companyId, poIds],
    ),
  ]);
  return pos.map((p) => {
    const mine = new Map();
    for (const l of lines.filter((x) => x.purchase_order_id === p.id)) {
      if (!mine.has(l.id)) {
        mine.set(l.id, {
          id: l.id, lineNo: l.line_no, item: { id: l.item_id, code: l.item_code, name: l.item_name, uom: l.uom },
          quantity: Number(l.quantity), received: Number(l.qty_received), expectedDate: dateOnly(l.expected_date) ?? dateOnly(p.expected_date),
          unitPrice: l.unit_price == null ? null : Number(l.unit_price), for: [],
        });
      }
      if (l.allocation_id) {
        mine.get(l.id).for.push({
          allocationId: l.allocation_id, order: { id: l.order_id, code: l.order_code }, quantity: Number(l.a_quantity), received: Number(l.a_received),
          prLineId: l.pr_line_id ?? null, requisition: l.requisition_id ? { id: l.requisition_id, code: l.requisition_code } : null,
        });
      }
    }
    return {
      id: p.id, code: p.code, status: p.status, expectedDate: dateOnly(p.expected_date), suppliedByCustomer: !!Number(p.supplied_by_customer),
      supplier: p.supplier_id ? { id: p.supplier_id, name: p.supplier_name } : null,
      forOrder: p.for_order_id ? { id: p.for_order_id, code: p.for_order_code } : null,
      lines: [...mine.values()],
    };
  });
}

export { clockToday as today };
