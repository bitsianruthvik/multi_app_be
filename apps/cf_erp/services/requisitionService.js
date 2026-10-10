/**
 * requisitionService.js — the REQUISITION (init.sql §56; contract TM/CF_ERP_BUYING_V2.md).
 *
 * One requisition (PR) per sales-order LINE, one line per MATERIAL that line
 * needs. The need is never typed: it is the line's own material — a released
 * line's requirements, a frozen line's planned material (materialReadyService
 * .lineNeeds, the source the buy list and release use, nest plates included).
 *
 * A requisition line is COVERED by any mix of
 *   stock     holds made by the STOCK CHECK — and only by it: raising a
 *             requisition earmarks nothing (user decision, 2026-10-10)
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
function shapeLine(pl, { n, reason, holds, allocs, todayText }) {
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
      purchaseOrder: { id: a.po_id, code: a.po_code, status: a.po_status },
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
  const held = reason ? take((x) => x.kind === 'held') : ownHeld;
  const ordered = reason ? take((x) => x.kind === 'po' && !x.pooled && x.status === 'dated') : sumOf('dated');
  const undated = reason ? take((x) => x.kind === 'po' && x.status === 'undated') : sumOf('undated');
  const asked = reason ? take((x) => x.kind === 'po' && x.status === 'asked') : sumOf('asked');
  const stock = round6((reason ? take((x) => x.kind === 'issued') : issued) + (reason ? take((x) => x.kind === 'reserved') : reserved) + held);
  const total = round6(stock + ordered + undated + asked);
  const open = round6(Math.max(0, need - total));
  const ownTotal = round6(issued + reserved + ownHeld + purchase.reduce((t, p) => t + p.outstanding, 0));
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
    ordered_undated: `Ordered, but ${fmt(undated)}${u} has no receiving date — production waits until a date is set.`,
    asked: `${fmt(asked)}${u} is asked for and not ordered yet — production waits until the order is placed with a date.`,
    skipped: freeNow + EPS >= open
      ? `Buying skipped — it waits for stock. ${fmt(open)}${u} is in stock now (not earmarked), so the work can be planned.`
      : `Buying skipped — it waits for stock. ${fmt(round6(open - freeNow))}${u} is not in stock yet.`,
    part: `${fmt(open)}${u} of ${fmt(need)} still to decide — hold stock, order it, or skip it.`,
    open: 'Nothing decided yet — hold stock, order it, or skip it.',
  }[status];
  return {
    id: pl.id, item, need, needRaised: Number(pl.quantity), needKnown: known,
    status, statusLabel: LINE_STATUS_LABEL[status], resolved: RESOLVED.has(status), sentence,
    skipped: skipped ? { by: pl.skipped_by ? { id: pl.skipped_by, name: pl.skipped_by_name ?? null } : null, at: pl.skipped_at ?? null, note: pl.skip_note ?? null } : null,
    cover: {
      issued: reason ? take((x) => x.kind === 'issued') : issued, reserved: reason ? take((x) => x.kind === 'reserved') : reserved,
      held, stock, ordered, undated, asked, total, open, over,
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
  if (filter.open) { where.push('o.status IN (?)'); args.push(OPEN_ORDER_STATUSES); }
  if (!blank(filter.search)) { where.push('(r.code LIKE ? OR o.code LIKE ? OR cu.name LIKE ?)'); args.push(...Array(3).fill(`%${String(filter.search).trim()}%`)); }
  const [heads] = await db.query(
    `SELECT r.id, r.code, r.order_id, r.order_line_id, r.notes, r.synced_at, r.created_at, r.created_by, u.name AS raised_by_name,
            o.code AS order_code, o.status AS order_status, o.customer_id, cu.name AS customer_name,
            l.line_no, l.quantity AS line_quantity, l.locked_at, l.description, m.code AS item_code, m.name AS item_name,
            (SELECT pr.id FROM cf_production_releases pr WHERE pr.company_id = l.company_id AND pr.order_line_id = l.id AND pr.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_requisitions r
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       LEFT JOIN cf_master_records m ON m.id = l.item_id
       LEFT JOIN cf_parties cu ON cu.id = o.customer_id
       LEFT JOIN users u ON u.id = r.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY o.code, l.line_no, r.id`,
    args,
  );
  if (!heads.length) return [];
  const R = given ?? await lineReadiness(db, companyId, { full: true });
  const ids = heads.map((h) => h.id);
  const [[lines], [holds], [allocs]] = await Promise.all([
    db.query(
      `SELECT pl.id, pl.requisition_id, pl.order_line_id, pl.item_id, pl.quantity, COALESCE(pl.uom, i.uom) AS uom, i.tracked_by,
              pl.skipped, pl.skipped_by, pl.skipped_at, pl.skip_note, su.name AS skipped_by_name, m.code AS item_code, m.name AS item_name
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
        WHERE v.company_id = ? AND pl.requisition_id IN (?) AND v.status = 'active' AND v.deleted_at IS NULL
        ORDER BY v.id`,
      [companyId, ids],
    ),
    db.query(
      `SELECT a.id, a.pr_line_id, a.quantity, a.qty_received, l2.id AS po_line_id, COALESCE(l2.expected_date, p.expected_date) AS due,
              p.id AS po_id, p.code AS po_code, p.status AS po_status, s.id AS supplier_id, s.name AS supplier_name
         FROM cf_purchase_line_orders a
         JOIN cf_requisition_lines pl ON pl.id = a.pr_line_id
         JOIN cf_purchase_order_lines l2 ON l2.id = a.purchase_line_id AND l2.deleted_at IS NULL
         JOIN cf_purchase_orders p ON p.id = l2.purchase_order_id AND p.deleted_at IS NULL
         LEFT JOIN cf_parties s ON s.id = p.supplier_id
        WHERE a.company_id = ? AND pl.requisition_id IN (?) AND a.deleted_at IS NULL
        ORDER BY a.id`,
      [companyId, ids],
    ),
  ]);
  const group = (rows, key) => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };
  const linesOf = group(lines, 'requisition_id');
  const holdsOf = group(holds, 'pr_line_id');
  const allocsOf = group(allocs, 'pr_line_id');
  return heads.map((h) => {
    const lineId = Number(h.order_line_id);
    const needs = R.needs.get(lineId);
    const res = R.byLine.get(lineId);
    const known = !!needs?.known;
    const reasonOf = new Map((res?.reasons ?? []).map((x) => [Number(x.item.id), x]));
    const own = (linesOf.get(h.id) ?? []).map((pl) => shapeLine(pl, {
      n: known ? needs.items.get(Number(pl.item_id)) ?? { need: 0, issued: 0, reserved: 0 } : null,
      reason: known ? reasonOf.get(Number(pl.item_id)) ?? null : null,
      holds: holdsOf.get(pl.id) ?? [], allocs: allocsOf.get(pl.id) ?? [], todayText: R.today,
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
    return {
      id: h.id, code: h.code,
      order: { id: h.order_id, code: h.order_code, status: h.order_status, customer: h.customer_id ? { id: h.customer_id, name: h.customer_name } : null },
      line: { id: lineId, lineNo: h.line_no, name: h.item_name ?? h.description ?? `Line ${h.line_no}`, quantity: Number(h.line_quantity), frozen: !!h.locked_at, released: !!h.release_id },
      status, statusLabel: REQUISITION_STATUS_LABEL[status], done: live.length > 0 ? live.every((l) => l.resolved) : true,
      sentence: !known ? `${needs?.why ?? 'This line is not on an open order.'} The requisition shows the need as it was last raised.` : requisitionSentence(status, own, ready),
      raisedAt: h.created_at, raisedBy: h.created_by ? { id: h.created_by, name: h.raised_by_name ?? null } : null, syncedAt: h.synced_at ?? null,
      needKnown: known, needComplete: !!needs?.ready, stale, missing, counts,
      materialReady: ready,
      lines: own,
    };
  });
}

async function requireOrderRow(db, companyId, orderId, { lock = false } = {}) {
  const [[o]] = await db.query(`SELECT id, code, status, customer_id FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(orderId)]);
  if (!o) throw notFound('Sales order');
  return o;
}

/**
 * GET /orders/:id/requisitions — every requisition of the order, and its lines
 * that have none yet (with what they need, so the screen can offer "Raise").
 */
export async function orderRequisitions(db, companyId, orderId, { R: given = null } = {}) {
  const o = await requireOrderRow(db, companyId, orderId);
  const R = given ?? await lineReadiness(db, companyId, { full: true });
  const requisitions = await readRequisitions(db, companyId, { orderId: o.id }, { R });
  const have = new Set(requisitions.map((r) => r.line.id));
  const open = OPEN_ORDER_STATUSES.includes(o.status);
  const linesWithout = R.lines.filter((l) => Number(l.order_id) === Number(o.id) && !have.has(Number(l.id))).map((l) => {
    const n = R.needs.get(Number(l.id));
    const res = R.byLine.get(Number(l.id));
    const materials = n?.known ? [...n.items.values()].map((e) => ({ item: e.item, need: e.need })) : [];
    return {
      line: { id: Number(l.id), lineNo: l.line_no, name: l.item_name ?? l.description ?? `Line ${l.line_no}`, quantity: Number(l.quantity), frozen: !!l.locked_at, released: !!l.release_id },
      canRaise: !!n?.known && materials.length > 0,
      reason: !n?.known ? n?.why ?? null : materials.length ? (n.ready ? null : n.why) : 'Everything under this line is made — it buys nothing.',
      materials,
      materialReady: n?.known && res ? { state: res.state, readyDate: res.readyDate, soft: !!res.soft, text: res.text } : null,
    };
  });
  return {
    order: { id: o.id, code: o.code, status: o.status, open },
    today: R.today,
    reason: open ? null : `${o.code} is ${o.status} — requisitions are raised for an inquiry, a quoted or a confirmed order.`,
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
    throw invalid('NOT_OPEN', `${o.code} is ${o.status} — a requisition is raised for an inquiry, a quoted or a confirmed order.`);
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
    throw invalid('NOTHING_TO_RAISE', `Nothing can be requisitioned for ${o.code} yet.`, { problems: notRaised.map((x) => `Line ${x.lineNo}: ${x.reason}`) });
  }
  const lineIds = can.map((l) => Number(l.id));
  const [had] = await db.query('SELECT id, order_line_id FROM cf_requisitions WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [c.companyId, lineIds]);
  const hadLine = new Set(had.map((r) => Number(r.order_line_id)));
  const fresh = can.filter((l) => !hadLine.has(Number(l.id)));
  await insertRows(db, 'cf_requisitions', ['company_id', 'code', 'order_id', 'order_line_id', 'notes', 'created_by'],
    fresh.map((l) => [c.companyId, `PR-${o.code}-${l.line_no}`.slice(0, 140), o.id, l.id, blank(input.notes) ? null : String(input.notes).slice(0, 500), c.userId ?? null]));
  const [prs] = await db.query('SELECT id, order_line_id FROM cf_requisitions WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [c.companyId, lineIds]);
  await syncLines(db, c, prs, needs);
  await adoptOrderCover(db, c, [o.id], { needs });
  return { raised: fresh.length, refreshed: had.length, notRaised, ...(await orderRequisitions(db, c.companyId, o.id)) };
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

async function requireRequisitionRow(db, companyId, id, { lock = false } = {}) {
  const [[r]] = await db.query(
    `SELECT r.id, r.code, r.order_id, r.order_line_id, o.code AS order_code, o.status AS order_status, l.line_no
       FROM cf_requisitions r JOIN cf_sales_orders o ON o.id = r.order_id JOIN cf_sales_order_lines l ON l.id = r.order_line_id
      WHERE r.company_id = ? AND r.id = ? AND r.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, Number(id)],
  );
  if (!r) throw notFound('Requisition');
  return r;
}
function assertOrderOpen(r, what) {
  if (!OPEN_ORDER_STATUSES.includes(r.order_status)) throw invalid('NOT_OPEN', `${r.order_code} is ${r.order_status} — ${what}.`);
}

/** What to claim of `qty` from an availability() entry: the customer's own lots first, then ours (lots for an item kept by batch, else loose). */
function claimRows(av, trackedBy, qty) {
  const rows = [];
  let left = round6(qty);
  const lots = (av?.batches ?? []).filter((b) => b.status === 'available' && b.free > EPS);
  const takeLot = (b) => {
    if (left <= EPS) return;
    const t = round6(Math.min(left, b.free));
    rows.push({ batchId: b.batchId, quantity: t });
    left = round6(left - t);
  };
  if (trackedBy === 'batch') lots.forEach(takeLot);
  else {
    lots.filter((b) => b.owner === 'theirs').forEach(takeLot);
    const ours = round6((av?.free ?? 0) - (av?.theirsFree ?? 0));
    if (left > EPS && ours > EPS) { const t = round6(Math.min(left, ours)); rows.push({ batchId: null, quantity: t }); left = round6(left - t); }
  }
  return { rows, left };
}

/**
 * POST /requisitions/:id/stock-check { apply?, lineIds?, lines?: [{ lineId, hold }] }
 *
 * DRY RUN (default): per requisition line, what is FREE in stock for this
 * order right now — never stock held or reserved for anybody (this order's own
 * holds included: they are cover already) — and how much the check proposes to
 * hold: the uncovered part, up to what is free.
 * APPLY: holds that (or the quantities sent) for the requisition LINE. This is
 * the only thing that earmarks free stock for an order.
 */
export async function stockCheck(db, c, id, input = {}) {
  const apply = input.apply === true || input.apply === 'true';
  const pr = await requireRequisitionRow(db, c.companyId, id, { lock: apply });
  if (apply) assertOrderOpen(pr, 'stock is held only for an open order');
  let R = await lineReadiness(db, c.companyId, { full: true });
  if (apply) {
    const s = await syncLines(db, c, [pr], R.needs);
    if (s.added || s.changed || s.retired) R = await lineReadiness(db, c.companyId, { full: true });
  }
  const view = await getRequisition(db, c.companyId, pr.id, { R });
  // One row's "Check stock": lineIds (alias prLineIds) = requisition LINE ids; the dry run and the apply both keep to them.
  const only = Array.isArray(input.lineIds) ? input.lineIds : Array.isArray(input.prLineIds) ? input.prLineIds : null;
  const named = only ? new Set(only.map(Number)) : null;
  const problems = [];
  if (named) for (const lid of named) if (!view.lines.some((l) => l.id === lid)) problems.push(`Requisition line ${lid} is not a line of ${view.code}.`);
  const lines = view.lines.filter((l) => l.status !== 'not_needed' && (!named || named.has(l.id)));
  const itemIds = [...new Set(lines.map((l) => Number(l.item.id)))].sort((a, b) => a - b);
  if (apply && itemIds.length) await db.query('SELECT master_id FROM cf_item_details WHERE company_id = ? AND master_id IN (?) ORDER BY master_id FOR UPDATE', [c.companyId, itemIds]);
  const av = itemIds.length ? await availability(db, c.companyId, itemIds, { orderId: pr.order_id, holds: 'none' }) : new Map();
  const rows = lines.map((l) => {
    const free = round6(av.get(Number(l.item.id))?.free ?? 0);
    // Room: what stock could still cover — the need less what is already here for it.
    const room = round6(Math.max(0, l.need - l.cover.stock));
    return {
      lineId: l.id, item: l.item, need: l.need, covered: l.cover.total, open: l.cover.open, status: l.status,
      freeInStock: free, room, proposeHold: round6(Math.min(free, l.cover.open)),
    };
  });
  if (!apply) {
    assertNoProblems(problems, 'The stock check cannot be run.');
    const k = rows.filter((r) => r.proposeHold > EPS).length;
    return {
      applied: false, requisition: { id: view.id, code: view.code, status: view.status }, order: view.order, line: view.line,
      canApply: k > 0, lines: rows,
      sentence: k ? `${plural(k, 'material')} can be held from stock for ${view.order.code} line ${view.line.lineNo}.` : 'Nothing that is still open is free in stock.',
    };
  }
  const want = Array.isArray(input.lines)
    ? new Map(input.lines.map((x) => [Number(x?.lineId), Number(x?.hold)]))
    : new Map(rows.map((r) => [r.lineId, r.proposeHold]));
  if (Array.isArray(input.lines)) {
    for (const [lid, q] of want) {
      if (!rows.some((r) => r.lineId === lid)) problems.push(`Requisition line ${lid} is not a line of ${view.code}.`);
      else if (!Number.isFinite(q) || q < 0) problems.push(`${nameOfItem(rows.find((r) => r.lineId === lid).item)}: the quantity to hold is a number, zero or more.`);
    }
  }
  const claims = [];
  for (const r of rows) {
    const q = round6(want.get(r.lineId) ?? 0);
    if (!(q > EPS)) continue;
    const u = r.item.uom ? ` ${r.item.uom}` : '';
    if (q > r.freeInStock + EPS) { problems.push(`${view.order.code} · ${nameOfItem(r.item)}: only ${fmt(r.freeInStock)}${u} is free in stock — ${fmt(q)} cannot be held.`); continue; }
    if (q > r.room + EPS) { problems.push(`${view.order.code} · ${nameOfItem(r.item)}: line ${view.line.lineNo} needs ${fmt(r.need)}${u} and ${fmt(round6(r.need - r.room))} is already here for it — hold at most ${fmt(r.room)}.`); continue; }
    const took = claimRows(av.get(Number(r.item.id)), r.item.trackedBy, q);
    if (took.left > EPS) { problems.push(`${view.order.code} · ${nameOfItem(r.item)}: ${fmt(took.left)}${u} of it sits in lots that cannot be held (on hold, or not in a storage area).`); continue; }
    claims.push({ r, q, rows: took.rows });
  }
  assertNoProblems(problems, 'The stock cannot be held.');
  await insertRows(db, 'cf_stock_reservations', ['company_id', 'held_for_order_id', 'pr_line_id', 'item_id', 'batch_id', 'quantity', 'created_by'],
    claims.flatMap(({ r, rows: got }) => got.map((x) => [c.companyId, pr.order_id, r.lineId, r.item.id, x.batchId, x.quantity, c.userId ?? null])));
  return {
    applied: true,
    held: claims.map(({ r, q }) => ({ lineId: r.lineId, item: r.item, quantity: q })),
    requisition: await getRequisition(db, c.companyId, pr.id),
  };
}

// --- skip -------------------------------------------------------------------------------------

/**
 * POST /requisitions/:id/skip { lineIds? | all: true, note? } and …/unskip.
 * Skip: "do not buy this material for this line — it waits for stock". `all`
 * skips every line that still has something uncovered. Recorded with who, when
 * and the note; unskip clears it (who and when of the undo stay on the line).
 */
export async function setSkip(db, c, id, input = {}, skip = true) {
  const pr = await requireRequisitionRow(db, c.companyId, id, { lock: true });
  assertOrderOpen(pr, skip ? 'nothing is skipped on an order that is not open' : 'its requisition no longer changes');
  let R = await lineReadiness(db, c.companyId, { full: true });
  const s = await syncLines(db, c, [pr], R.needs);
  if (s.added || s.changed || s.retired) R = await lineReadiness(db, c.companyId, { full: true });
  const view = await getRequisition(db, c.companyId, pr.id, { R });
  const all = input.all === true || input.all === 'true';
  const problems = [];
  let targets;
  if (all) targets = skip ? view.lines.filter((l) => !l.skipped && l.cover.open > EPS && l.status !== 'not_needed') : view.lines.filter((l) => l.skipped);
  else {
    const ids = Array.isArray(input.lineIds) ? input.lineIds.map(Number) : [];
    if (!ids.length) throw invalid('INVALID', 'Say which materials: { lineIds: [...] }, or { all: true }.');
    targets = [];
    for (const lid of ids) {
      const l = view.lines.find((x) => x.id === lid);
      if (!l) { problems.push(`Requisition line ${lid} is not a line of ${view.code}.`); continue; }
      if (skip && l.skipped) continue;               // already skipped: nothing to do, not a problem
      if (!skip && !l.skipped) continue;
      if (skip && !(l.cover.open > EPS)) { problems.push(`${view.order.code} · ${nameOfItem(l.item)}: it is already covered (${l.statusLabel.toLowerCase()}) — there is nothing to skip.`); continue; }
      targets.push(l);
    }
  }
  assertNoProblems(problems, skip ? 'Buying cannot be skipped for those.' : 'The skip cannot be undone for those.');
  if (targets.length) {
    await db.query(
      `UPDATE cf_requisition_lines SET skipped = ?, skipped_by = ?, skipped_at = NOW(), skip_note = ? WHERE company_id = ? AND id IN (?)`,
      [skip ? 1 : 0, c.userId ?? null, skip && !blank(input.note) ? String(input.note).slice(0, 500) : null, c.companyId, targets.map((l) => l.id)],
    );
  }
  return { changed: targets.length, lineIds: targets.map((l) => l.id), requisition: await getRequisition(db, c.companyId, pr.id) };
}

// --- purchase orders from requisition lines ----------------------------------------------------

/**
 * POST /requisitions/purchase-orders
 *   { orders: [{ supplierId?, expectedDate?, place?, notes?, lines: [{ prLineId, quantity?, expectedDate?, unitPrice? }] }] }
 * One purchase order per entry — so one requisition line can be split over
 * several POs (each with its own quantity and date), and one PO can serve
 * several requisition lines and orders. quantity left out = what is still
 * open on the requisition line. A PO holds one line per item: two requisition
 * lines of one item on one PO share the PO line (and must share its date).
 * place: true places it with the supplier at once (status ordered); otherwise
 * it is a REQUESTED PO that goes through RFQ → quotes → place as before, its
 * requisition links travelling with its lines.
 * Every problem is collected and said at once, naming order, item and PO.
 * Round trips: fixed — 3 statements make any number of POs.
 */
export async function makePurchaseOrders(db, c, input = {}) {
  const list = Array.isArray(input.orders) ? input.orders : null;
  if (!list?.length) throw invalid('INVALID', 'Send the purchase orders to make: { orders: [{ supplierId?, expectedDate?, place?, lines: [{ prLineId, quantity?, expectedDate? }] }] }.');
  if (list.length > 50) throw invalid('TOO_MANY', 'At most 50 purchase orders in one go.');
  const prLineIds = [...new Set(list.flatMap((o) => (Array.isArray(o?.lines) ? o.lines : []).map((l) => Number(l?.prLineId))).filter((n) => Number.isInteger(n) && n > 0))];
  const supplierIds = [...new Set(list.map((o) => (blank(o?.supplierId) ? null : Number(o.supplierId))).filter((x) => x != null))];
  const [[prl], [sups]] = await Promise.all([
    prLineIds.length ? db.query(
      `SELECT pl.id, pl.item_id, pl.requisition_id, pl.order_line_id, r.order_id, r.code AS pr_code, o.code AS order_code, o.status AS order_status,
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
    supplierIds.length ? db.query('SELECT id, code, name, is_supplier, status FROM cf_parties WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, supplierIds]) : [[]],
  ]);
  const prOf = new Map(prl.map((p) => [p.id, p]));
  const supOf = new Map(sups.map((s) => [s.id, s]));
  const views = await readRequisitions(db, c.companyId, { ids: [...new Set(prl.map((p) => p.requisition_id))] });
  const openOf = new Map(views.flatMap((v) => v.lines.map((l) => [l.id, l.cover.open])));
  const problems = [];
  const plans = [];
  list.forEach((o, k) => {
    const at = `Purchase order ${k + 1}`;
    const supplier = blank(o?.supplierId) ? null : supOf.get(Number(o.supplierId)) ?? null;
    if (!blank(o?.supplierId)) {
      if (!supplier) problems.push(`${at}: that supplier does not exist.`);
      else if (!Number(supplier.is_supplier)) problems.push(`${at}: ${supplier.name} is not marked as a supplier.`);
      else if (supplier.status !== 'active') problems.push(`${at}: ${supplier.name} is inactive.`);
    }
    const place = o?.place === true || o?.place === 'true';
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
      let price = null;
      if (!blank(l?.unitPrice)) { price = Number(l.unitPrice); if (!Number.isFinite(price) || price < 0) { problems.push(`${who}: the unit price is a number, zero or more.`); continue; } }
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
    plans.push({ k, supplier, place, poDate, notes: blank(o?.notes) ? null : String(o.notes), items: [...byItem.values()], forOrderId: orders.size === 1 ? [...orders][0] : null });
  });
  assertNoProblems(problems, 'The purchase orders cannot be made.');

  // The orders: one INSERT, read back by a temporary number, then numbered PO-000123 like every PO raised without a coding rule.
  const stamp = `TMP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await insertRows(db, 'cf_purchase_orders', ['company_id', 'code', 'supplier_id', 'status', 'suggested', 'expected_date', 'notes', 'for_order_id', 'created_by'],
    plans.map((p) => [c.companyId, `${stamp}-${p.k}`, p.supplier?.id ?? null, p.place ? 'ordered' : 'requested', 0, p.poDate, p.notes ?? 'Made from requisitions.', p.forOrderId, c.userId ?? null]));
  const [made] = await db.query('SELECT id, code FROM cf_purchase_orders WHERE company_id = ? AND code LIKE ?', [c.companyId, `${stamp}-%`]);
  const idOf = new Map(made.map((r) => [Number(String(r.code).slice(stamp.length + 1)), r.id]));
  // ordered_at is stamped by the database (a DATETIME never passes through JavaScript on the way in — ARCHITECTURE.md §13).
  await db.query("UPDATE cf_purchase_orders SET code = CONCAT('PO-', LPAD(id, 6, '0')), ordered_at = IF(status = 'ordered', NOW(), NULL) WHERE company_id = ? AND id IN (?)", [c.companyId, made.map((r) => r.id)]);
  const prices = await lastPricesPaid(db, c.companyId, [...new Set(plans.flatMap((p) => p.items.map((e) => e.itemId)))]);
  await insertRows(db, 'cf_purchase_order_lines', ['company_id', 'purchase_order_id', 'line_no', 'item_id', 'quantity', 'uom', 'expected_date', 'unit_price', 'currency'],
    plans.flatMap((p) => p.items.map((e, i) => [c.companyId, idOf.get(p.k), i + 1, e.itemId, round6(e.shares.reduce((t, s) => t + s.quantity, 0)), e.uom,
      [...e.dates][0] || null, e.price ?? prices.get(e.itemId)?.unitPrice ?? null, CURRENCY])));
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
      `SELECT p.id, p.code, p.status, p.expected_date, p.for_order_id, fo.code AS for_order_code, s.id AS supplier_id, s.name AS supplier_name
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
      id: p.id, code: p.code, status: p.status, expectedDate: dateOnly(p.expected_date),
      supplier: p.supplier_id ? { id: p.supplier_id, name: p.supplier_name } : null,
      forOrder: p.for_order_id ? { id: p.for_order_id, code: p.for_order_code } : null,
      lines: [...mine.values()],
    };
  });
}

// --- letting an excess go -----------------------------------------------------------------------

/**
 * POST /requisition-lines/:id/release-excess { apply? } — a requisition line
 * that has MORE held or coming than its line needs (the design was frozen
 * again with less, or a material went away). Nothing is ever dropped by
 * itself: this says what would be let go (dry run, default) and does it on
 * apply. What is still coming goes first, newest first, a request before an
 * order (its share of the PO line becomes bought for nobody — the PO line
 * itself is not cut); then holds, newest first (the stock is free again).
 */
export async function releaseExcess(db, c, prLineId, input = {}) {
  const apply = input.apply === true || input.apply === 'true';
  const [[row]] = await db.query(
    `SELECT pl.id, pl.requisition_id FROM cf_requisition_lines pl JOIN cf_requisitions r ON r.id = pl.requisition_id AND r.deleted_at IS NULL
      WHERE pl.company_id = ? AND pl.id = ? AND pl.deleted_at IS NULL${apply ? ' FOR UPDATE' : ''}`,
    [c.companyId, Number(prLineId)],
  );
  if (!row) throw notFound('Requisition line');
  const view = await getRequisition(db, c.companyId, row.requisition_id);
  const line = view.lines.find((l) => l.id === row.id);
  let over = line.cover.over;
  const plan = [];
  const rank = { asked: 0, undated: 1, dated: 2 };
  for (const p of [...line.purchase].filter((x) => x.outstanding > EPS).sort((a, b) => rank[a.state] - rank[b.state] || b.allocationId - a.allocationId)) {
    if (over <= EPS) break;
    const t = round6(Math.min(over, p.outstanding));
    plan.push({ kind: 'allocation', id: p.allocationId, quantity: t, purchaseOrder: p.purchaseOrder, leaves: round6(p.quantity - t), text: `${fmt(t)} of ${p.purchaseOrder.code} stops being for this line (the purchase order line keeps its quantity — it is then bought for stock).` });
    over = round6(over - t);
  }
  for (const h of [...line.holds].sort((a, b) => b.id - a.id)) {
    if (over <= EPS) break;
    const t = round6(Math.min(over, h.quantity));
    plan.push({ kind: 'hold', id: h.id, quantity: t, leaves: round6(h.quantity - t), text: `${fmt(t)} held in stock${h.batch ? ` (lot ${h.batch.code})` : ''} is free again.` });
    over = round6(over - t);
  }
  const head = { requisitionLineId: line.id, item: line.item, need: line.need, excess: line.cover.over };
  if (!apply) return { applied: false, ...head, plan };
  for (const p of plan) {
    if (p.kind === 'hold') {
      if (p.leaves <= EPS) await db.query("UPDATE cf_stock_reservations SET status = 'released', closed_at = NOW() WHERE company_id = ? AND id = ? AND status = 'active'", [c.companyId, p.id]);
      else await db.query('UPDATE cf_stock_reservations SET quantity = ? WHERE company_id = ? AND id = ?', [p.leaves, c.companyId, p.id]);
    } else if (p.leaves <= EPS) await db.query('UPDATE cf_purchase_line_orders SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, p.id]);
    else await db.query('UPDATE cf_purchase_line_orders SET quantity = ? WHERE company_id = ? AND id = ?', [p.leaves, c.companyId, p.id]);
  }
  return { applied: true, ...head, plan, requisition: await getRequisition(db, c.companyId, row.requisition_id) };
}

// --- the Buying board ----------------------------------------------------------------------------

export const BOARD_COLUMNS = [
  { key: 'open', label: 'Open', hint: 'Nothing decided: check stock, order, or skip.' },
  { key: 'partly_covered', label: 'Partly covered', hint: 'Some materials decided; some asked for with no date yet.' },
  { key: 'covered', label: 'Covered', hint: 'Every material is held or on order with a date.' },
  { key: 'mixed', label: 'Covered, some skipped', hint: 'Every material decided; the skipped ones wait for stock.' },
  { key: 'skipped', label: 'Skipped', hint: 'Buying skipped: production waits for stock.' },
  { key: 'fulfilled_from_stock', label: 'From stock', hint: 'Met wholly from stock held for the line.' },
];

/**
 * GET /buying/board?orderId=&search= — every requisition of an open order in
 * the column of its status, with its material-ready state, and the lines that
 * could have a requisition and do not (`notRaised`).
 */
export async function buyingBoard(db, companyId, q = {}) {
  const R = await lineReadiness(db, companyId, { full: true });
  const prs = await readRequisitions(db, companyId, { open: true, orderId: blank(q.orderId) ? null : Number(q.orderId), search: q.search }, { R });
  const cards = prs.map((r) => {
    const pos = new Map();
    for (const l of r.lines) for (const p of l.purchase) if (p.state !== 'closed') pos.set(p.purchaseOrder.id, p.purchaseOrder);
    const dates = r.lines.map((l) => l.cover.lastDate).filter(Boolean).sort();
    return {
      id: r.id, code: r.code, order: r.order, line: r.line, status: r.status, statusLabel: r.statusLabel, done: r.done, sentence: r.sentence,
      counts: r.counts, stale: r.stale, materialReady: r.materialReady, lastDate: dates.at(-1) ?? null,
      late: r.lines.some((l) => l.cover.late), purchaseOrders: [...pos.values()],
    };
  });
  const have = new Set(prs.map((r) => r.line.id));
  const term = blank(q.search) ? null : String(q.search).trim().toLowerCase();
  const notRaised = R.lines.filter((l) => !have.has(Number(l.id)) && (blank(q.orderId) || Number(l.order_id) === Number(q.orderId))
    && (R.needs.get(Number(l.id))?.items.size ?? 0) > 0 && (!term || String(l.order_code).toLowerCase().includes(term)))
    .map((l) => {
      const res = R.byLine.get(Number(l.id));
      return {
        order: { id: l.order_id, code: l.order_code, status: l.order_status },
        line: { id: Number(l.id), lineNo: l.line_no, name: l.item_name ?? l.description ?? `Line ${l.line_no}` },
        materials: R.needs.get(Number(l.id)).items.size,
        materialReady: res ? { state: res.state, readyDate: res.readyDate, soft: !!res.soft, text: res.text } : null,
      };
    });
  return {
    today: R.today,
    columns: [...BOARD_COLUMNS, { key: 'empty', label: 'Nothing to buy', hint: 'The line no longer buys anything.' }]
      .map((col) => { const mine = cards.filter((x) => x.status === col.key); return { ...col, count: mine.length, cards: mine }; })
      .filter((col) => col.key !== 'empty' || col.count > 0),
    /*
     * WAITING FOR STOCK (skipped): requisitions with a skipped material that is not in stock right now — the
     * work behind them cannot be planned. Same card shape as the columns; a card here is ALSO in its status
     * column (skipped / mixed / partly_covered), so this group is beside the columns, never added to their counts.
     * Each card also says which materials: waitingLines [{ id, item, short, need }].
     */
    waitingForStock: (() => {
      const mine = cards.map((x, i) => ({ x, r: prs[i] })).filter(({ r }) => r.lines.some((l) => l.status === 'skipped' && l.ready?.state === 'waiting'))
        .map(({ x, r }) => ({ ...x, waitingLines: r.lines.filter((l) => l.status === 'skipped' && l.ready?.state === 'waiting').map((l) => ({ id: l.id, item: l.item, need: l.need, short: round6(l.cover.open - l.cover.freeNow) })) }));
      return { key: 'waiting_for_stock', label: 'Waiting for stock', hint: 'Buying was skipped and the material is not in stock yet — the work cannot be planned.', count: mine.length, cards: mine };
    })(),
    notRaised,
  };
}

export { clockToday as today };
