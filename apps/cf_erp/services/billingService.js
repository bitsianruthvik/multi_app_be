/**
 * billingService.js — ACCOUNTS › BILLING (init.sql §74, TM/s74.sql; contract TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — Step 3B").
 *
 * User, 2026-10-18: a Billing board with swim lanes Upcoming → Due to bill → Billed → Paid. One card per PAYMENT
 * MILESTONE of an accepted order — or, for a pro-rata one, per dispatch / per week. A milestone becomes DUE by itself
 * from what the app tracks; nobody drags a card. From due cards, "Raise invoice" makes a simple GST TAX INVOICE.
 *
 * WHAT A MILESTONE IS WORTH. M = its % of the order value (the APPROVED acceptance's estimate: the charges × their basis
 * + material + lump sums), or its fixed amount. A pro-rata milestone is billed in parts: part = M × the share of the
 * work the part stands for. Parts are rounded on the running total, so the parts of a milestone add up to M exactly.
 *
 * WHEN IT IS DUE (each trigger, read off the tables — fixed reads for any number of orders, billingFacts):
 *   order_accepted              the day the acceptance was approved (cf_order_events order_accepted).
 *   design_frozen               the day the LAST line was frozen (every line has locked_at).
 *   material_in_place           the MR materials locked for the order ("n of m materials locked", as on the Orders
 *                               board). Observed when the Billing board is read and recorded as an event
 *                               (material_progress, quantity = the share) — pro-rata: the share added each week.
 *   customer_material_received  the customer's lots received for the order, in tonnes, over what the customer's MRs
 *                               ask — pro-rata by week.
 *   production_started          the first step of a released line started (production orders come later).
 *   operation_completed         the tonnage through that operation: per line, the done steps of the operation by
 *                               weight over all its steps, times the line's share of the order — pro-rata GROUPED
 *                               WEEKLY (a week is Monday–Sunday; its card is due on the Sunday).
 *   dispatched each             every dispatch (shipment movement) separately, by its share of the order's weight.
 *   dispatched all / fully_dispatched   the day the last line was fully shipped.
 *   post_stage                  the day that post-production stage was ticked done.
 *   days_after                  N days after the trigger it follows was complete.
 *   fixed_date                  on that date.
 *   retention                   N months after the milestone it follows was complete.
 * A card whose date has come is DUE; one with a date ahead (this week so far, a fixed date) or none yet is UPCOMING.
 * A card on an issued invoice is BILLED until the invoice is fully paid, then PAID. Billed past the invoice's due date
 * (invoice date + credit days) and not paid = OVERDUE (red).
 *
 * A card is billed at most once (cf_invoice_billing_lines.claim, uq_cibl_claim). A late entry into a week already
 * billed shows as a top-up card ("<key>+"). Cancelling the invoice frees its cards.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { measuresOf, round2, CURRENCY } from './priceService.js';
import { companyTax, itemTaxOf, partyTaxOf, supplyOf, taxLines, amountInWords, stateName, financialYear, invoiceNumber, FOREIGN_STATE, INVOICE_NO_MAX } from './taxService.js';
import { unitKgOf } from './valuationService.js';
import { generate } from '../modules/codegen/engine.js';

export const LANES = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'due', label: 'Due to bill' },
  { key: 'billed', label: 'Billed' },
  { key: 'paid', label: 'Paid' },
];
const EPS = 1e-6;
const PAID_TOLERANCE = 0.5;   // rupees: a rounding difference is not an amount owed
const blank = (v) => v == null || String(v).trim() === '';
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const money = (n) => `₹${Number(round2(n)).toLocaleString('en-IN')}`;
const pct = (f) => `${round2(f * 100)} %`;

/** A DATE / DATETIME from the driver as 'YYYY-MM-DD' (local, as every cf_erp service reads it). */
export const dateText = (d) => (d == null ? null : d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
export const todayText = () => dateText(new Date());
const utc = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + Number(n)); return iso(d); };
export function addMonths(s, n) {
  const d = utc(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(n));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}
/** The Monday of the week a date is in. */
export const weekOf = (s) => { const d = utc(s); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); };
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);

// ── the facts (fixed reads for any number of orders) ───────────────────────────────────────────

/**
 * Everything billing reads, for the customer orders with an APPROVED acceptance: the terms and their estimate, the
 * lines (weight, frozen, shipped), the production steps, the shipments, the post-production stages, the events, the
 * customer's material, and what is billed and paid. q: { orderIds?, search?, includeClosed = true }.
 * About 16 reads whatever the number of orders.
 */
export async function billingFacts(db, companyId, q = {}) {
  const where = ['o.company_id = ?', 'o.deleted_at IS NULL', "o.order_type = 'customer'"];
  const args = [companyId];
  if (q.orderIds) {
    if (!q.orderIds.length) return [];
    where.push('o.id IN (?)'); args.push(q.orderIds.map(Number));
  } else {
    where.push("(o.status = 'confirmed' OR (o.status = 'closed' AND o.updated_at >= NOW() - INTERVAL 180 DAY))");
  }
  if (!blank(q.search)) { where.push('(o.code LIKE ? OR o.title LIKE ? OR p.name LIKE ?)'); const like = `%${String(q.search).trim()}%`; args.push(like, like, like); }
  const [orders] = await db.query(
    `SELECT o.id, o.code, o.code_active, o.title, o.status, o.customer_id, o.committed_date, p.name AS customer_name,
            a.id AS acceptance_id, a.version, a.terms_json, a.estimate_json, a.decided_at
       FROM cf_sales_orders o
       JOIN cf_order_acceptances a ON a.company_id = o.company_id AND a.order_id = o.id AND a.status = 'approved' AND a.deleted_at IS NULL
       LEFT JOIN cf_parties p ON p.id = o.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.code LIMIT 1000`,
    args,
  );
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  // A revision is another row with the same number: what was billed / paid on an earlier revision counts for it.
  const codes = [...new Set(orders.map((o) => o.code_active).filter(Boolean))];
  const [[family], [lines], [steps], [ships], [stages], [events], [ops]] = await Promise.all([
    codes.length ? db.query('SELECT id, code_active FROM cf_sales_orders WHERE company_id = ? AND code_active IN (?) AND deleted_at IS NULL', [companyId, codes]) : [[]],
    db.query(
      `SELECT l.id, l.order_id, l.line_no, l.item_id, l.quantity, l.delivered_qty, l.locked_at
         FROM cf_sales_order_lines l WHERE l.company_id = ? AND l.order_id IN (?) AND l.deleted_at IS NULL ORDER BY l.order_id, l.line_no, l.id`,
      [companyId, ids]),
    db.query(
      `SELECT r.order_id, r.order_line_id, s.operation_id, pi.item_id, (s.state = 'done') AS done, DATE(s.finished_at) AS finished_on,
              SUM(s.quantity) AS quantity, MIN(s.started_at) AS first_start
         FROM cf_production_steps s
         JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
        WHERE s.company_id = ? AND r.order_id IN (?) AND s.deleted_at IS NULL
        GROUP BY r.order_id, r.order_line_id, s.operation_id, pi.item_id, (s.state = 'done'), DATE(s.finished_at)`,
      [companyId, ids]),
    db.query(
      `SELECT v.id, v.code, v.order_id, v.movement_date, v.order_line_id, -SUM(k.quantity) AS quantity
         FROM cf_stock_movements v
         JOIN cf_sales_order_lines l ON l.id = v.order_line_id AND l.company_id = v.company_id
         JOIN cf_stock_ledger k ON k.company_id = v.company_id AND k.movement_id = v.id AND k.item_id = l.item_id AND k.deleted_at IS NULL
         JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose = 'dispatch'
        WHERE v.company_id = ? AND v.order_id IN (?) AND v.movement_type = 'issue' AND v.deleted_at IS NULL
          AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL
        GROUP BY v.id, v.code, v.order_id, v.movement_date, v.order_line_id
        HAVING quantity > 0
        ORDER BY v.movement_date, v.id`,
      [companyId, ids]),
    db.query('SELECT order_id, stage_key, name, done_on FROM cf_order_post_stages WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL', [companyId, ids]),
    db.query(
      `SELECT id, order_id, event_type, event_date, quantity FROM cf_order_events
        WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL AND event_type IN ('order_accepted', 'material_progress')
        ORDER BY event_date, id`,
      [companyId, ids]),
    db.query('SELECT id, name FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
  ]);
  const familyOf = new Map();
  for (const f of family) { if (!familyOf.has(f.code_active)) familyOf.set(f.code_active, []); familyOf.get(f.code_active).push(Number(f.id)); }
  const allIds = [...new Set([...ids, ...family.map((f) => Number(f.id))])];
  const termsOf = new Map(orders.map((o) => [o.id, parseJson(o.terms_json) ?? {}]));
  const wantsCustomer = [...termsOf.values()].some((t) => (t.milestones ?? []).some((m) => m.trigger?.type === 'customer_material_received'
    || (m.trigger?.type === 'days_after' && m.trigger.after?.type === 'customer_material_received')));
  const [measures, [claims], [allocs], [receipts], [allocated], cust] = await Promise.all([
    measuresOf(db, companyId, [...lines.map((l) => l.item_id), ...steps.map((s) => s.item_id)]),
    db.query(
      `SELECT bl.id, bl.order_id, bl.milestone_key, bl.part_key, bl.tax_key, bl.label, bl.part_note, bl.taxable, bl.cgst, bl.sgst, bl.igst, bl.due_on,
              inv.id AS invoice_id, inv.invoice_no, inv.invoice_date, inv.due_date, inv.credit_days, inv.grand_total, inv.status AS invoice_status
         FROM cf_invoice_billing_lines bl JOIN cf_invoices inv ON inv.id = bl.invoice_id
        WHERE bl.company_id = ? AND bl.order_id IN (?) AND bl.claim = 1 AND bl.deleted_at IS NULL AND inv.status = 'issued'`,
      [companyId, allIds]),
    db.query(
      `SELECT al.invoice_id, SUM(al.amount) AS amount FROM cf_receipt_allocations al JOIN cf_invoices inv ON inv.id = al.invoice_id
        WHERE al.company_id = ? AND inv.order_id IN (?) AND al.deleted_at IS NULL GROUP BY al.invoice_id`,
      [companyId, allIds]),
    db.query('SELECT order_id, SUM(amount) AS amount FROM cf_receipts WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL GROUP BY order_id', [companyId, allIds]),
    db.query(
      `SELECT r.order_id, SUM(al.amount) AS amount FROM cf_receipt_allocations al JOIN cf_receipts r ON r.id = al.receipt_id AND r.deleted_at IS NULL
        WHERE al.company_id = ? AND r.order_id IN (?) AND al.deleted_at IS NULL GROUP BY r.order_id`,
      [companyId, allIds]),
    wantsCustomer ? customerMaterial(db, companyId, ids) : new Map(),
  ]);
  const opName = new Map(ops.map((o) => [Number(o.id), o.name]));
  const paidOf = new Map(allocs.map((a) => [Number(a.invoice_id), Number(a.amount)]));

  return orders.map((o) => {
    const fam = familyOf.get(o.code_active) ?? [o.id];
    const famSet = new Set(fam.map(Number));
    const myLines = lines.filter((l) => Number(l.order_id) === o.id).map((l) => {
      const kg = measures.get(Number(l.item_id))?.weightKg ?? null;
      return {
        id: Number(l.id), lineNo: l.line_no, itemId: Number(l.item_id), quantity: Number(l.quantity), delivered: Number(l.delivered_qty ?? 0),
        kgEach: kg, tonnes: kg == null ? null : round6((kg * Number(l.quantity)) / 1000), lockedOn: dateText(l.locked_at),
      };
    });
    const myReceipts = receipts.filter((r) => famSet.has(Number(r.order_id)));
    const myAllocated = allocated.filter((r) => famSet.has(Number(r.order_id)));
    return {
      order: { id: o.id, code: o.code, title: o.title ?? null, status: o.status, customerId: o.customer_id, customer: o.customer_name ?? null, committedDate: dateText(o.committed_date) },
      family: fam,
      acceptance: { id: o.acceptance_id, version: Number(o.version), decidedOn: dateText(o.decided_at) },
      terms: termsOf.get(o.id),
      estimate: parseJson(o.estimate_json) ?? {},
      lines: myLines,
      steps: steps.filter((s) => Number(s.order_id) === o.id).map((s) => ({
        lineId: Number(s.order_line_id), opId: Number(s.operation_id), itemId: Number(s.item_id), done: !!Number(s.done), finishedOn: dateText(s.finished_on),
        quantity: Number(s.quantity), kgEach: measures.get(Number(s.item_id))?.weightKg ?? null, firstStart: dateText(s.first_start),
      })),
      shipments: ships.filter((s) => Number(s.order_id) === o.id).map((s) => ({ id: Number(s.id), code: s.code, date: dateText(s.movement_date), lineId: Number(s.order_line_id), quantity: Number(s.quantity) })),
      stages: stages.filter((s) => Number(s.order_id) === o.id).map((s) => ({ key: s.stage_key, name: s.name, doneOn: dateText(s.done_on) })),
      events: events.filter((e) => Number(e.order_id) === o.id).map((e) => ({ id: e.id, type: e.event_type, date: dateText(e.event_date), quantity: e.quantity == null ? null : Number(e.quantity) })),
      customerMaterial: cust.get(o.id) ?? null,
      claims: claims.filter((c) => famSet.has(Number(c.order_id))).map((c) => ({
        milestoneKey: c.milestone_key, partKey: c.part_key, taxKey: c.tax_key, label: c.label, note: c.part_note, taxable: Number(c.taxable),
        tax: round2(Number(c.cgst ?? 0) + Number(c.sgst ?? 0) + Number(c.igst ?? 0)), dueOn: dateText(c.due_on),
        invoice: { id: c.invoice_id, invoiceNo: c.invoice_no, invoiceDate: dateText(c.invoice_date), dueDate: dateText(c.due_date), creditDays: c.credit_days == null ? null : Number(c.credit_days), grandTotal: Number(c.grand_total), received: paidOf.get(Number(c.invoice_id)) ?? 0 },
      })),
      receipts: { total: round2(myReceipts.reduce((t, r) => t + Number(r.amount), 0)), allocated: round2(myAllocated.reduce((t, r) => t + Number(r.amount), 0)) },
      opName,
    };
  });
}

/** The customer's material for each order: receipts of their lots (tonnes, by date) against what the customer's MRs ask. */
async function customerMaterial(db, companyId, orderIds) {
  const [[got], [want]] = await Promise.all([
    db.query(
      `SELECT v.order_id, v.movement_date, k.item_id, SUM(k.quantity) AS quantity
         FROM cf_stock_movements v
         JOIN cf_stock_ledger k ON k.company_id = v.company_id AND k.movement_id = v.id AND k.deleted_at IS NULL
         JOIN cf_stock_batches b ON b.id = k.batch_id AND b.owner_party_id IS NOT NULL
        WHERE v.company_id = ? AND v.order_id IN (?) AND v.movement_type = 'receipt' AND v.deleted_at IS NULL AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL
        GROUP BY v.order_id, v.movement_date, k.item_id ORDER BY v.movement_date`,
      [companyId, orderIds]),
    db.query(
      `SELECT r.order_id, rl.item_id, SUM(rl.quantity) AS quantity
         FROM cf_requisition_lines rl JOIN cf_requisitions r ON r.id = rl.requisition_id AND r.deleted_at IS NULL
        WHERE rl.company_id = ? AND r.order_id IN (?) AND rl.deleted_at IS NULL AND r.supply = 'customer' GROUP BY r.order_id, rl.item_id`,
      [companyId, orderIds]),
  ]);
  const kg = await unitKgOf(db, companyId, [...got.map((r) => r.item_id), ...want.map((r) => r.item_id)]);
  const t = (itemId, q) => (kg.get(Number(itemId)) == null ? null : (Number(q) * kg.get(Number(itemId))) / 1000);
  const out = new Map();
  for (const id of orderIds) {
    const asked = want.filter((r) => Number(r.order_id) === Number(id));
    if (!asked.length) continue;
    const expected = asked.reduce((s, r) => s + (t(r.item_id, r.quantity) ?? 0), 0);
    if (expected <= EPS) continue;
    out.set(Number(id), {
      expectedT: round6(expected),
      receipts: got.filter((r) => Number(r.order_id) === Number(id)).map((r) => ({ date: dateText(r.movement_date), tonnes: t(r.item_id, r.quantity) ?? 0 })).filter((r) => r.tonnes > EPS),
    });
  }
  return out;
}

// ── the engine (pure) ──────────────────────────────────────────────────────────────────────────

/** Each line's share of the order: by weight when every line is weighed, else by quantity. */
function lineShares(lines) {
  const weighed = lines.length && lines.every((l) => l.tonnes != null && l.tonnes > 0);
  const total = lines.reduce((t, l) => t + (weighed ? l.tonnes : l.quantity), 0);
  const out = new Map();
  for (const l of lines) out.set(l.id, total > EPS ? (weighed ? l.tonnes : l.quantity) / total : 0);
  return { shares: out, totalT: weighed ? round6(total) : null, byWeight: weighed };
}

/** A running share made of dated increments: [{ date, frac }] sorted, plus the day it reached the whole. */
function progressFrom(increments) {
  const byDate = new Map();
  for (const i of increments) if (i.date && i.frac > EPS) byDate.set(i.date, (byDate.get(i.date) ?? 0) + i.frac);
  const steps = [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, frac]) => ({ date, frac }));
  let run = 0; let completeOn = null;
  const capped = [];
  for (const s of steps) {
    const f = Math.min(s.frac, 1 - run);
    if (f <= EPS) continue;
    run += f;
    capped.push({ date: s.date, frac: f });
    if (!completeOn && run >= 1 - EPS) completeOn = s.date;
  }
  return { steps: capped, done: Math.min(1, run), completeOn };
}

/**
 * The derived facts of one order (pure over billingFacts' row): shares, the day each event happened, and the running
 * shares of the progress triggers.
 */
export function orderProgress(F) {
  const { shares, totalT, byWeight } = lineShares(F.lines);
  const lineById = new Map(F.lines.map((l) => [l.id, l]));
  const accepted = F.events.find((e) => e.type === 'order_accepted')?.date ?? F.acceptance.decidedOn ?? null;
  const frozenOn = F.lines.length && F.lines.every((l) => l.lockedOn) ? F.lines.map((l) => l.lockedOn).sort().at(-1) : null;
  const starts = F.steps.map((s) => s.firstStart).filter(Boolean).sort();
  const startedOn = starts[0] ?? null;
  // Fully shipped: every line's delivered quantity reaches its quantity — on the day of the last shipment.
  const allShipped = F.lines.length > 0 && F.lines.every((l) => l.delivered + EPS >= l.quantity);
  const lastShip = F.shipments.map((s) => s.date).sort().at(-1) ?? null;
  const fullyOn = allShipped ? lastShip : null;
  const shipments = F.shipments.map((s) => {
    const l = lineById.get(s.lineId);
    const frac = l && l.quantity > EPS ? (shares.get(l.id) ?? 0) * (s.quantity / l.quantity) : 0;
    return { ...s, frac, tonnes: l?.kgEach == null ? null : round3((l.kgEach * s.quantity) / 1000) };
  });
  // Operations: per line, the done weight of the operation's steps over all of them, times the line's share.
  const ops = new Map();
  const opIds = [...new Set(F.steps.map((s) => s.opId))];
  for (const opId of opIds) {
    const mine = F.steps.filter((s) => s.opId === opId);
    const inc = [];
    for (const lineId of new Set(mine.map((s) => s.lineId))) {
      const rows = mine.filter((s) => s.lineId === lineId);
      const useKg = rows.every((s) => s.kgEach != null && s.kgEach > 0);
      const w = (s) => s.quantity * (useKg ? s.kgEach : 1);
      const total = rows.reduce((t, s) => t + w(s), 0);
      if (total <= EPS) continue;
      for (const s of rows.filter((x) => x.done && x.finishedOn)) inc.push({ date: s.finishedOn, frac: (shares.get(lineId) ?? 0) * (w(s) / total) });
    }
    ops.set(opId, progressFrom(inc));
  }
  // Material in place: the observed shares (material_progress events), as a running maximum.
  const mat = [];
  let best = 0;
  for (const e of F.events.filter((x) => x.type === 'material_progress')) {
    const f = Math.min(1, Number(e.quantity ?? 0));
    if (f > best + EPS) { mat.push({ date: e.date, frac: f - best }); best = f; }
  }
  const cm = F.customerMaterial;
  const customer = cm ? progressFrom(cm.receipts.map((r) => ({ date: r.date, frac: r.tonnes / cm.expectedT }))) : progressFrom([]);
  return {
    shares, totalT, byWeight, accepted, frozenOn, startedOn, fullyOn, shipments, ops,
    material: progressFrom(mat), materialShare: best, customer,
    stageDone: new Map(F.stages.map((s) => [s.key, s.doneOn])), stageName: new Map(F.stages.map((s) => [s.key, s.name])),
  };
}

/** A trigger in words (the card says when it is due). */
export function triggerWords(t, names = {}) {
  if (!t?.type) return 'Not chosen';
  switch (t.type) {
    case 'order_accepted': return 'When the order is accepted';
    case 'design_frozen': return 'When the design is frozen';
    case 'material_in_place': return 'When the material is in place';
    case 'customer_material_received': return 'When the customer\'s material is received';
    case 'production_started': return 'When production starts';
    case 'operation_completed': return `When ${names.operation?.(t.operationId) ?? 'the operation'} is completed`;
    case 'dispatched': return t.mode === 'each' ? 'On each dispatch' : 'When everything is dispatched';
    case 'fully_dispatched': return 'When everything is dispatched';
    case 'post_stage': return `When "${names.stage?.(t.stageKey) ?? t.stageKey}" is done`;
    case 'days_after': return `${t.days} days after ${triggerWords(t.after, names).replace(/^When /, '').replace(/^On /, 'on ')}`;
    case 'fixed_date': return `On ${t.date}`;
    case 'retention': return `${t.months} months after "${names.milestone?.(t.milestoneKey) ?? t.milestoneKey}"`;
    default: return t.type;
  }
}

/** When a trigger happened / happens: { kind: event | progress | each, parts: [{ key, date, frac, note }], completeOn }. Pure. */
function timelineOf(trigger, P, F, depth = 0) {
  const event = (date, note) => ({ kind: 'event', parts: date ? [{ key: 'all', date, frac: 1, note }] : [], completeOn: date ?? null });
  const progress = (p, what) => ({ kind: 'progress', steps: p.steps, done: p.done, completeOn: p.completeOn, what });
  const t = trigger ?? {};
  switch (t.type) {
    case 'order_accepted': return event(P.accepted, P.accepted ? `Accepted on ${P.accepted}` : null);
    case 'design_frozen': return event(P.frozenOn, P.frozenOn ? `Design frozen on ${P.frozenOn}` : null);
    case 'production_started': return event(P.startedOn, P.startedOn ? `Production started on ${P.startedOn}` : null);
    case 'fully_dispatched': return event(P.fullyOn, P.fullyOn ? `Everything dispatched by ${P.fullyOn}` : null);
    case 'post_stage': { const d = P.stageDone.get(t.stageKey) ?? null; return event(d, d ? `"${P.stageName.get(t.stageKey) ?? t.stageKey}" done on ${d}` : null); }
    case 'fixed_date': return event(t.date ?? null, t.date ? `Fixed date ${t.date}` : null);
    case 'material_in_place': return progress(P.material, 'material in place');
    case 'customer_material_received': return progress(P.customer, 'customer material received');
    case 'operation_completed': return progress(P.ops.get(Number(t.operationId)) ?? progressFrom([]), `through ${F.opName.get(Number(t.operationId)) ?? 'the operation'}`);
    case 'dispatched':
      if (t.mode === 'each') {
        return {
          kind: 'each', completeOn: P.fullyOn,
          parts: P.shipments.filter((s) => s.frac > EPS).map((s) => ({ key: `mv${s.id}`, date: s.date, frac: s.frac, note: `Dispatch ${s.code}${s.tonnes != null ? ` (${s.tonnes} t)` : ''} on ${s.date}` })),
        };
      }
      return event(P.fullyOn, P.fullyOn ? `Everything dispatched by ${P.fullyOn}` : null);
    case 'days_after': {
      const base = depth < 3 ? timelineOf(t.after, P, F, depth + 1).completeOn : null;
      const d = base ? addDays(base, t.days) : null;
      return event(d, d ? `${t.days} days after ${base}` : null);
    }
    case 'retention': {
      const target = (F.terms.milestones ?? []).find((m) => m.key === t.milestoneKey);
      const base = target && depth < 3 ? timelineOf(target.trigger, P, F, depth + 1).completeOn : null;
      const d = base ? addMonths(base, t.months) : null;
      return event(d, d ? `Retention: ${t.months} months after ${base}` : null);
    }
    default: return event(null);
  }
}

/** The parts a milestone is billed in. Pure. */
function partsOf(m, tl, P) {
  if (tl.kind === 'each') return tl.parts;
  if (tl.kind === 'progress') {
    if (!m.proRata) return tl.completeOn ? [{ key: 'all', date: tl.completeOn, frac: 1, note: `All ${tl.what} on ${tl.completeOn}` }] : [];
    // Pro-rata: GROUPED WEEKLY — the share added in each week, due on its Sunday.
    const weeks = new Map();
    for (const s of tl.steps) { const w = weekOf(s.date); weeks.set(w, (weeks.get(w) ?? 0) + s.frac); }
    return [...weeks].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([w, frac]) => ({
      key: `w${w}`, date: addDays(w, 6), frac,
      note: `Week of ${w}: ${P.totalT != null && /through/.test(tl.what) ? `${round3(frac * P.totalT)} t ${tl.what}` : `${pct(frac)} ${tl.what}`}`,
    }));
  }
  return tl.parts;
}

/** What a milestone is worth: its % of the order value, or its fixed amount. */
export const milestoneAmount = (m, value) => round2(m.kind === 'percent' ? (Number(value ?? 0) * Number(m.value ?? 0)) / 100 : Number(m.value ?? 0));

/**
 * The cards of one order (pure over billingFacts' row): every milestone's parts — due, upcoming, billed or paid — and the
 * order's money in short. today: 'YYYY-MM-DD'.
 */
export function cardsOf(F, today) {
  const P = orderProgress(F);
  const value = Number(F.estimate?.value ?? 0);
  const milestones = F.terms.milestones ?? [];
  const names = {
    operation: (id) => F.opName.get(Number(id)) ?? null,
    stage: (k) => P.stageName.get(k) ?? (F.terms.stages ?? []).find((s) => s.key === k)?.name ?? null,
    milestone: (k) => milestones.find((x) => x.key === k)?.label ?? null,
  };
  const claimsBy = new Map();
  for (const c of F.claims) {
    const k = `${c.milestoneKey}|${c.partKey}`;
    if (!claimsBy.has(k)) claimsBy.set(k, []);
    claimsBy.get(k).push(c);
  }
  const base = (m) => ({
    orderId: F.order.id, orderCode: F.order.code, customer: F.order.customer, title: F.order.title,
    milestone: { key: m.key, label: m.label, trigger: triggerWords(m.trigger, names), kind: m.kind, value: m.value, creditDays: m.creditDays ?? 0, proRata: !!m.proRata, amount: milestoneAmount(m, value) },
  });
  const cards = [];
  const seen = new Set();
  const claimedCard = (m, partKey, list, extra = {}) => {
    const inv = list[0].invoice;
    const taxable = round2(list.reduce((t, c) => t + c.taxable, 0));
    const tax = round2(list.reduce((t, c) => t + c.tax, 0));
    const outstanding = round2(inv.grandTotal - inv.received);
    const paid = outstanding <= PAID_TOLERANCE;
    const overdue = !paid && !!inv.dueDate && inv.dueDate < today;
    seen.add(`${m.key}|${partKey}`);
    return {
      ...base(m), id: `${F.order.id}|${m.key}|${partKey}`, partKey, note: list[0].note ?? null, amount: taxable, tax, dueOn: list[0].dueOn ?? null,
      status: paid ? 'paid' : 'billed', overdue, daysOverdue: overdue ? daysBetween(inv.dueDate, today) : 0,
      invoice: { ...inv, outstanding: Math.max(0, outstanding) }, ...extra,
    };
  };
  for (const m of milestones) {
    const M = milestoneAmount(m, value);
    const tl = timelineOf(m.trigger, P, F);
    const parts = partsOf(m, tl, P).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let run = 0; let billedSoFar = 0;
    for (const p of parts) {
      run = Math.min(1, run + p.frac);
      const upTo = run >= 1 - EPS ? M : round2(M * run);
      const amount = round2(upTo - billedSoFar);
      billedSoFar = upTo;
      const key = `${m.key}|${p.key}`;
      const claimed = claimsBy.get(key);
      if (claimed) {
        const card = claimedCard(m, p.key, claimed);
        cards.push(card);
        // A late entry into a part already billed: the difference is a top-up card.
        const topKey = `${p.key}+`;
        const topClaimed = claimsBy.get(`${m.key}|${topKey}`);
        if (topClaimed) cards.push(claimedCard(m, topKey, topClaimed));
        const diff = round2(amount - card.amount - (topClaimed ? round2(topClaimed.reduce((t, c) => t + c.taxable, 0)) : 0));
        if (!topClaimed && diff > 1 && p.date <= today) {
          cards.push({ ...base(m), id: `${F.order.id}|${m.key}|${topKey}`, partKey: topKey, note: `${p.note ?? ''} — recorded after it was billed`.trim(), amount: diff, fraction: null, dueOn: today, status: 'due', overdue: false, daysOverdue: 0, invoice: null });
        }
        continue;
      }
      if (amount <= 0.004) continue;
      const due = p.date <= today;
      cards.push({
        ...base(m), id: `${F.order.id}|${m.key}|${p.key}`, partKey: p.key, note: p.note ?? null, amount, fraction: round6(p.frac),
        dueOn: p.date, status: due ? 'due' : 'upcoming', daysDue: due ? daysBetween(p.date, today) : 0, overdue: false, daysOverdue: 0, invoice: null,
      });
    }
    const rest = round2(M - billedSoFar);
    if (rest > 0.004 && run < 1 - EPS) {
      const doneShare = run;
      cards.push({
        ...base(m), id: `${F.order.id}|${m.key}|rest`, partKey: 'rest', amount: rest, fraction: round6(1 - doneShare), dueOn: null, status: 'upcoming', overdue: false, daysOverdue: 0, invoice: null,
        note: doneShare > EPS ? `${pct(1 - doneShare)} still to come — ${triggerWords(m.trigger, names).toLowerCase()}` : triggerWords(m.trigger, names),
      });
    }
  }
  // Billed cards whose milestone or part the terms no longer make (a rate change since): still shown, as billed.
  for (const [k, list] of claimsBy) {
    if (seen.has(k)) continue;
    const [mKey, partKey] = k.split('|');
    const m = milestones.find((x) => x.key === mKey) ?? { key: mKey, label: list[0].label ?? mKey, trigger: null, kind: 'amount', value: 0, creditDays: 0 };
    cards.push(claimedCard(m, partKey, list));
  }
  // The order's money in short.
  const invoices = new Map();
  for (const c of F.claims) invoices.set(c.invoice.id, c.invoice);
  const invoiced = round2([...invoices.values()].reduce((t, i) => t + i.grandTotal, 0));
  const received = round2(F.receipts.total);
  const outstanding = round2([...invoices.values()].reduce((t, i) => t + Math.max(0, i.grandTotal - i.received), 0));
  const open = cards.filter((c) => c.status === 'due' || c.status === 'upcoming');
  const summary = {
    value: round2(value), milestonesTotal: round2(milestones.reduce((t, m) => t + milestoneAmount(m, value), 0)),
    billed: round2(cards.filter((c) => c.invoice).reduce((t, c) => t + c.amount, 0)), invoiced, received, outstanding,
    onAccount: round2(Math.max(0, F.receipts.total - F.receipts.allocated)),
    due: round2(cards.filter((c) => c.status === 'due').reduce((t, c) => t + c.amount, 0)), dueCount: cards.filter((c) => c.status === 'due').length,
    upcoming: round2(cards.filter((c) => c.status === 'upcoming').reduce((t, c) => t + c.amount, 0)),
    overdue: cards.some((c) => c.overdue),
    fullyBilled: open.length === 0,
    fullyPaid: open.length === 0 && outstanding <= PAID_TOLERANCE,
  };
  return { cards, summary, progress: P };
}

// ── observed facts: material in place ──────────────────────────────────────────────────────────

/**
 * Material in place is a STATE (the MR materials locked), not a dated record. Billing needs when it happened, so the
 * share is observed — on every read of the Billing board — and recorded as an event (material_progress, quantity =
 * the share) when it changed. Only orders whose terms have a material_in_place milestone. Fixed reads + ≤ 1 write.
 */
export async function observeMaterial(db, c, facts) {
  const watch = facts.filter((F) => F.order.status === 'confirmed' && (F.terms.milestones ?? []).some((m) => m.trigger?.type === 'material_in_place'
    || (m.trigger?.type === 'days_after' && m.trigger.after?.type === 'material_in_place')));
  if (!watch.length) return 0;
  const { readRequisitions } = await import('./requisitionService.js');
  const ids = new Set(watch.map((F) => F.order.id));
  const views = (await readRequisitions(db, c.companyId, { open: true, lineBound: true })).filter((v) => ids.has(Number(v.order.id)));
  const by = new Map();
  for (const v of views) {
    const e = by.get(Number(v.order.id)) ?? { materials: 0, locked: 0, held: false };
    const live = v.lines.filter((l) => l.status !== 'not_needed');
    e.materials += live.length;
    e.locked += live.filter((l) => (l.cover?.earmarked ?? 0) + EPS >= l.need).length;
    if (v.heldForAcceptance) e.held = true;
    by.set(Number(v.order.id), e);
  }
  const rows = [];
  for (const F of watch) {
    const e = by.get(F.order.id);
    if (!e || e.held) continue;
    const share = e.materials ? round6(e.locked / e.materials) : 1;     // nothing to buy = in place
    const last = F.events.filter((x) => x.type === 'material_progress').at(-1)?.quantity ?? 0;
    if (Math.abs(share - last) <= EPS) continue;
    rows.push([c.companyId, F.order.id, 'material_progress', 'billing', null, `Material in place: ${e.locked} of ${e.materials}`, todayText(), share, 'share', null, c.userId ?? null]);
    F.events.push({ id: null, type: 'material_progress', date: todayText(), quantity: share });
  }
  if (rows.length) {
    await insertRows(db, 'cf_order_events', ['company_id', 'order_id', 'event_type', 'ref_type', 'ref_id', 'label', 'event_date', 'quantity', 'uom', 'note', 'recorded_by'], rows);
  }
  return rows.length;
}

// ── the board ──────────────────────────────────────────────────────────────────────────────────

const LANE_ORDER = { overdue: 0, due: 1 };
/**
 * GET /accounts/billing?search=&orderId= — every card of every accepted order, in its lane. opts.today (tests) moves
 * "today"; opts.observe (the route, inside a transaction) records the material share first.
 */
export async function billingBoard(db, c, q = {}, { today = todayText(), observe = false } = {}) {
  const facts = await billingFacts(db, c.companyId, { search: q.search, orderIds: blank(q.orderId) ? null : [Number(q.orderId)] });
  if (observe) await observeMaterial(db, c, facts);
  const lanes = LANES.map((l) => ({ ...l, cards: [], total: 0 }));
  const orders = [];
  for (const F of facts) {
    const { cards, summary } = cardsOf(F, today);
    orders.push({ id: F.order.id, code: F.order.code, customer: F.order.customer, title: F.order.title, status: F.order.status, ...summary });
    for (const card of cards) lanes.find((l) => l.key === card.status).cards.push(card);
  }
  for (const l of lanes) {
    l.cards.sort((a, b) => (LANE_ORDER[a.overdue ? 'overdue' : 'due'] - LANE_ORDER[b.overdue ? 'overdue' : 'due'])
      || String(a.dueOn ?? '9999').localeCompare(String(b.dueOn ?? '9999')) || a.orderCode.localeCompare(b.orderCode));
    l.total = round2(l.cards.reduce((t, x) => t + x.amount, 0));
  }
  const due = lanes.find((l) => l.key === 'due').cards;
  const billed = lanes.find((l) => l.key === 'billed').cards;
  return {
    lanes, orders, today,
    counts: { due: due.length, overdue: billed.filter((x) => x.overdue).length, dueAmount: round2(due.reduce((t, x) => t + x.amount, 0)) },
  };
}

/** The nav badge: how many cards are due to bill. Fixed reads (no observation — a badge never writes). */
export async function billingDueCount(db, companyId) {
  const facts = await billingFacts(db, companyId, {});
  const t = todayText();
  return facts.reduce((n, F) => n + cardsOf(F, t).cards.filter((x) => x.status === 'due').length, 0);
}

/** One order's billing in short (orders board, receipts, the close rule). */
export async function orderBilling(db, companyId, orderIds, { today = todayText() } = {}) {
  const facts = await billingFacts(db, companyId, { orderIds });
  return new Map(facts.map((F) => [F.order.id, cardsOf(F, today)]));
}

/**
 * The close rule (user, 2026-10-18): an order with accepted terms closes only when its post-production stages are done
 * AND it is FULLY PAID — every milestone billed and every invoice paid. An order without terms: stages only (as before).
 */
export async function paidUp(db, companyId, orderId) {
  const m = await orderBilling(db, companyId, [orderId]);
  const b = m.get(Number(orderId));
  if (!b) return { hasTerms: false, fullyPaid: true, outstanding: 0 };
  return { hasTerms: true, fullyPaid: b.summary.fullyPaid, fullyBilled: b.summary.fullyBilled, outstanding: b.summary.outstanding, upcoming: b.summary.upcoming, due: b.summary.due };
}

// ── raising an invoice from due cards ──────────────────────────────────────────────────────────

/** Splits an amount over weights to the paisa (largest remainder), so the pieces add up exactly. */
export function splitAmount(amount, weights) {
  const total = weights.reduce((t, w) => t + w, 0);
  const paise = Math.round(amount * 100);
  if (total <= EPS) return weights.map((_, i) => (i === 0 ? amount : 0));
  const raw = weights.map((w) => (paise * w) / total);
  const floor = raw.map(Math.floor);
  let left = paise - floor.reduce((t, x) => t + x, 0);
  const order = raw.map((r, i) => [r - floor[i], i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; floor[i] += 1; left -= 1; }
  return floor.map((p) => p / 100);
}

const FIX = {
  company: { label: 'Setup › Company tax details', to: 'company-tax' },
  customer: (id) => ({ label: 'Open the customer', to: `customers/${id}` }),
  item: (id) => ({ label: 'Open the item', to: `items/${id}` }),
  definition: (id) => ({ label: 'Open the template', to: `definitions/${id}` }),
};

/**
 * What an invoice of these cards would be: lines (each card split over the order lines' tax groups — HSN and GST rate,
 * by each line's share of the order), the parties, the tax (CGST + SGST inside the state, IGST across), the totals and
 * every reason it cannot be raised yet. Fixed reads.
 */
async function invoicePlan(db, c, input, today) {
  const orderId = Number(input.orderId);
  if (!orderId) throw invalid('INVALID', 'Choose the order.', { problems: ['Choose the order.'] });
  const keys = (Array.isArray(input.cards) ? input.cards : []).map(String);
  const facts = await billingFacts(db, c.companyId, { orderIds: [orderId] });
  const F = facts[0];
  if (!F) throw invalid('NO_TERMS', 'This order has no approved acceptance — it has no milestones to bill.');
  const { cards, progress } = cardsOf(F, today);
  const problems = [];
  const P = (message, fix = null) => problems.push({ message, fix });
  const picked = [];
  if (!keys.length) P('Choose at least one due card.');
  for (const k of keys) {
    const id = k.includes('|') && k.split('|').length === 3 ? k : `${orderId}|${k}`;
    const card = cards.find((x) => x.id === id);
    if (!card) P(`${k} is not a card of ${F.order.code}.`);
    else if (card.status === 'upcoming') P(`${card.milestone.label}: not due yet.`);
    else if (card.status !== 'due') P(`${card.milestone.label}${card.note ? ` (${card.note})` : ''}: already on invoice ${card.invoice?.invoiceNo}.`);
    else picked.push(card);
  }
  const date = blank(input.invoiceDate) ? todayText() : String(input.invoiceDate).slice(0, 10);
  if (!DATE_RE.test(date)) P('The invoice date needs YYYY-MM-DD.');
  else if (date > todayText()) P('An invoice cannot be dated in the future.');
  const creditDefault = picked.length ? Math.min(...picked.map((x) => Number(x.milestone.creditDays ?? 0))) : 0;
  const creditDays = blank(input.creditDays) ? creditDefault : Number(input.creditDays);
  if (!Number.isInteger(creditDays) || creditDays < 0 || creditDays > 365) P('Credit days are a whole number from 0 to 365.');

  // The order lines' tax: each card is split over them by their share of the order, then grouped by HSN + rate.
  const [company, items, parties] = await Promise.all([
    companyTax(db, c.companyId),
    itemTaxOf(db, c.companyId, F.lines.map((l) => l.itemId)),
    partyTaxOf(db, c.companyId, [F.order.customerId]),
  ]);
  const [defs] = F.lines.length ? await db.query('SELECT master_id, item_type, source_definition_id FROM cf_item_details WHERE company_id = ? AND master_id IN (?)', [c.companyId, F.lines.map((l) => l.itemId)]) : [[]];
  const defOf = new Map(defs.map((d) => [Number(d.master_id), d.item_type === 'temporary' ? d.source_definition_id : null]));
  const groups = new Map();
  for (const l of F.lines) {
    const tax = items.get(l.itemId) ?? {};
    const key = `${tax.hsnCode ?? ''}|${tax.gstRate ?? ''}|${tax.isService ? 1 : 0}`;
    if (!groups.has(key)) groups.set(key, { key, hsnCode: tax.hsnCode ?? null, gstRate: tax.gstRate ?? null, isService: !!tax.isService, share: 0, lines: [] });
    const g = groups.get(key);
    g.share += progress.shares.get(l.id) ?? 0;
    g.lines.push(l);
  }
  const groupList = [...groups.values()].filter((g) => g.share > EPS);
  for (const g of groupList) {
    const l = g.lines[0];
    const fix = defOf.get(l.itemId) ? FIX.definition(defOf.get(l.itemId)) : FIX.item(l.itemId);
    if (!g.hsnCode) P(`Line ${g.lines.map((x) => x.lineNo).join(', ')} has no HSN code.`, fix);
    if (g.gstRate == null) P(`Line ${g.lines.map((x) => x.lineNo).join(', ')} has no GST rate.`, fix);
  }
  const lines = [];
  let n = 0;
  for (const card of picked) {
    const pieces = splitAmount(card.amount, groupList.map((g) => g.share));
    groupList.forEach((g, i) => {
      if (pieces[i] <= 0) return;
      lines.push({
        slNo: ++n, card: card.id, milestoneKey: card.milestone.key, partKey: card.partKey, taxKey: g.key,
        label: card.milestone.label, note: card.note, fraction: card.fraction ?? null, dueOn: card.dueOn,
        description: `${card.milestone.label}${card.note ? ` — ${card.note}` : ''} (${F.order.code})`.slice(0, 500),
        hsnCode: g.hsnCode, gstRate: g.gstRate, isService: g.isService, taxable: pieces[i],
      });
    });
  }
  const cust = F.order.customerId ? parties.get(Number(F.order.customerId)) : null;
  const ship = cust?.defaultShip ?? null;
  const pos = cust?.registration === 'overseas' ? FOREIGN_STATE : (ship?.stateCode ?? cust?.stateCode ?? null);
  const supply = cust ? supplyOf({ supplierState: company.stateCode, placeOfSupply: pos, registration: cust.registration, lutNumber: company.lutNumber }) : null;
  const res = taxLines(lines, supply);
  if (!company.gstin) P('Company GSTIN not set.', FIX.company);
  if (!company.stateCode) P('Company state not set.', FIX.company);
  if (!company.legalName) P('Company legal name not set.', FIX.company);
  if (!company.address1 || !company.city || !company.pincode) P('Company address (line 1, city, PIN code) not complete.', FIX.company);
  if (!cust) P('The order has no customer.');
  else {
    if (['regular', 'composition', 'sez'].includes(cust.registration) && !cust.gstin) P(`${cust.name} has no GSTIN — enter it, or mark the customer unregistered.`, FIX.customer(cust.id));
    if (!pos) P(`${cust.name}'s state is not known — set it on the customer or the ship-to address.`, FIX.customer(cust.id));
  }
  const seen = new Set();
  const unique = problems.filter((p) => (seen.has(p.message) ? false : seen.add(p.message)));
  const supplier = {
    legalName: company.legalName, tradeName: company.tradeName, gstin: company.gstin, stateCode: company.stateCode,
    stateName: company.stateName, address1: company.address1, address2: company.address2, city: company.city, pincode: company.pincode,
  };
  const buyer = cust ? { partyId: cust.id, code: cust.code, name: cust.name, gstin: cust.gstin, registration: cust.registration, stateCode: cust.stateCode, stateName: stateName(cust.stateCode), address: cust.address, city: cust.city, pincode: cust.pincode } : null;
  const shipTo = ship ? { addressId: ship.id, label: ship.label, name: cust?.name ?? null, address: ship.address, city: ship.city, pincode: ship.pincode, stateCode: ship.stateCode, stateName: stateName(ship.stateCode), gstin: ship.gstin ?? null }
    : buyer ? { addressId: null, label: null, name: buyer.name, address: buyer.address, city: buyer.city, pincode: buyer.pincode, stateCode: buyer.stateCode, stateName: buyer.stateName, gstin: buyer.gstin, sameAsBuyer: true } : null;
  return {
    F, picked, date, creditDays: Number.isInteger(creditDays) ? creditDays : creditDefault,
    dueDate: DATE_RE.test(date) && Number.isInteger(creditDays) ? addDays(date, creditDays) : null,
    company, supplier, buyer, shipTo, pos, supply, lines: res.lines, totals: res.totals, problems: unique,
  };
}

/** The number: the company's coding rule for tax invoices when it has one, else the GST series of the year (gap-free). */
async function nextInvoiceNumber(db, c, date, company) {
  let ruled = null;
  try { ruled = (await generate(db, c.companyId, 'tax_invoice', 'code', { draft: {} }, { consume: true }))?.text ?? null; } catch { ruled = null; }
  if (ruled) {
    if (ruled.length > INVOICE_NO_MAX) throw invalid('NUMBER_TOO_LONG', `The coding rule for tax invoices makes ${ruled} — longer than ${INVOICE_NO_MAX} characters. Shorten the rule.`);
    const [[taken]] = await db.query('SELECT id FROM cf_invoices WHERE company_id = ? AND invoice_no = ?', [c.companyId, ruled]);
    if (taken) throw invalid('NUMBER_TAKEN', `The coding rule for tax invoices made ${ruled}, which is already used. Check the rule.`);
    return { invoiceNo: ruled, fy: financialYear(date) };
  }
  const fy = financialYear(date);
  await db.query('INSERT INTO cf_invoice_series (company_id, fy, prefix, next_no) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE next_no = next_no', [c.companyId, fy, company.invoicePrefix]);
  const [[series]] = await db.query('SELECT prefix, next_no FROM cf_invoice_series WHERE company_id = ? AND fy = ? FOR UPDATE', [c.companyId, fy]);
  const invoiceNo = invoiceNumber(series.prefix, fy, series.next_no);
  await db.query('UPDATE cf_invoice_series SET next_no = next_no + 1 WHERE company_id = ? AND fy = ?', [c.companyId, fy]);
  return { invoiceNo, fy };
}

const shapePlan = (p) => ({
  order: { id: p.F.order.id, code: p.F.order.code, customer: p.F.order.customer },
  invoiceDate: p.date, creditDays: p.creditDays, dueDate: p.dueDate,
  cards: p.picked.map((x) => ({ id: x.id, label: x.milestone.label, note: x.note, amount: x.amount })),
  supplier: p.supplier, buyer: p.buyer, shipTo: p.shipTo,
  placeOfSupply: p.pos ? { code: p.pos, name: stateName(p.pos) } : null, isIgst: p.supply?.isIgst ?? null, supplyType: p.supply?.supplyType ?? null,
  lines: p.lines.map(({ card, ...l }) => ({ ...l, card })),
  totals: { ...p.totals, inWords: amountInWords(p.totals.grandTotal ?? 0) },
  problems: p.problems.map((x) => ({ text: x.message, fix: x.fix })),
});

/**
 * POST /accounts/invoices { orderId, cards: [card ids], invoiceDate?, creditDays?, notes?, dryRun? } — RAISE a GST tax
 * invoice from DUE cards of ONE order (several may go on one invoice). dryRun: the preview, nothing written. Raised =
 * numbered (the coding rule, else the year's GST series) and issued at once: parties, lines and tax frozen; due date =
 * invoice date + credit days (default: the smallest of the cards' milestones). Money the customer paid on account goes
 * onto it first. Refused with every problem at once.
 */
export async function raiseInvoice(db, c, input = {}, { today = todayText() } = {}) {
  const plan = await invoicePlan(db, c, input, today);
  if (input.dryRun) return { dryRun: true, ...shapePlan(plan) };
  if (plan.problems.length) {
    throw invalid('CANNOT_RAISE', `The invoice cannot be raised yet — ${plan.problems.length === 1 ? 'one thing' : `${plan.problems.length} things`} to fix.`,
      { problems: plan.problems.map((p) => p.message), detail: plan.problems.map((p) => ({ text: p.message, fix: p.fix })) });
  }
  const o = plan.F.order;
  await db.query('SELECT id FROM cf_sales_orders WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, o.id]);
  const { invoiceNo, fy } = await nextInvoiceNumber(db, c, plan.date, plan.company);
  const t = plan.totals;
  const [ins] = await db.query(
    `INSERT INTO cf_invoices (company_id, order_id, customer_id, status, invoice_kind, invoice_no, invoice_date, fy, supplier, buyer, ship_to, ship_to_address_id,
            place_of_supply, is_igst, supply_type, lut_number, taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, currency,
            credit_days, due_date, notes, issued_at, issued_by, created_by)
     VALUES (?, ?, ?, 'issued', 'billing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
    [c.companyId, o.id, o.customerId ?? null, invoiceNo, plan.date, fy, JSON.stringify(plan.supplier), JSON.stringify(plan.buyer), plan.shipTo ? JSON.stringify(plan.shipTo) : null,
      plan.shipTo?.addressId ?? null, plan.pos, plan.supply.isIgst ? 1 : 0, plan.supply.supplyType, plan.supply.zeroRated ? plan.company.lutNumber : null,
      t.taxable, t.cgst, t.sgst, t.igst, t.roundOff, t.grandTotal, CURRENCY, plan.creditDays, plan.dueDate,
      blank(input.notes) ? null : String(input.notes).slice(0, 2000), c.userId ?? null, c.userId ?? null],
  );
  const invoiceId = ins.insertId;
  try {
    await insertRows(db, 'cf_invoice_billing_lines',
      ['company_id', 'invoice_id', 'line_no', 'order_id', 'milestone_key', 'part_key', 'tax_key', 'claim', 'label', 'description', 'part_note', 'fraction', 'due_on',
        'hsn_code', 'is_service', 'gst_rate', 'taxable', 'cgst', 'sgst', 'igst'],
      plan.lines.map((l) => [c.companyId, invoiceId, l.slNo, o.id, l.milestoneKey, l.partKey, l.taxKey, 1, String(l.label ?? '').slice(0, 255), l.description,
        l.note == null ? null : String(l.note).slice(0, 255), l.fraction, l.dueOn, l.hsnCode, l.isService ? 1 : 0, l.gstRate, l.taxable, l.cgst, l.sgst, l.igst]));
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') throw invalid('ALREADY_BILLED', 'One of these cards was billed a moment ago — reload the board.');
    throw e;
  }
  const { applyOnAccount } = await import('./receiptService.js');
  await applyOnAccount(db, c, o.id);
  const { getInvoice } = await import('./invoiceService.js');
  return getInvoice(db, c.companyId, invoiceId);
}

/** The frozen lines of billing invoices, shaped as invoiceService's frozenView reads an invoice line. 1 read. */
export async function billingInvoiceLines(db, companyId, invoiceIds) {
  const out = new Map(invoiceIds.map((id) => [Number(id), []]));
  if (!invoiceIds.length) return out;
  const [rows] = await db.query(
    'SELECT * FROM cf_invoice_billing_lines WHERE company_id = ? AND invoice_id IN (?) AND deleted_at IS NULL ORDER BY invoice_id, line_no, id',
    [companyId, invoiceIds.map(Number)],
  );
  for (const r of rows) {
    out.get(Number(r.invoice_id))?.push({
      ...r, order_line_id: null, order_line_no: null, movement_id: null, movement_code: null,
      quantity: 1, uom: 'nos', billed_qty: null, billed_uom: null, rate: r.taxable, rate_basis: null,
      milestone: { key: r.milestone_key, part: r.part_key, label: r.label, note: r.part_note, dueOn: dateText(r.due_on) },
    });
  }
  return out;
}

// ── the PDF ────────────────────────────────────────────────────────────────────────────────────

/** GET /accounts/invoices/:id/pdf — the issued tax invoice as a PDF (any issued invoice, from its frozen columns). */
export async function invoicePdf(db, companyId, id) {
  const { getInvoice } = await import('./invoiceService.js');
  const inv = await getInvoice(db, companyId, id);
  if (inv.status === 'draft') throw invalid('DRAFT', 'A draft has no number yet — issue it first.');
  const { default: PDFDocument } = await import('pdfkit');
  const { pdfText } = await import('./mrDocumentService.js');
  const T = (v) => pdfText(v ?? '');
  const rs = (n) => (n == null ? '' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const buffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];
    doc.on('data', (x) => chunks.push(x));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font('Helvetica-Bold').fontSize(15).text(T(inv.status === 'cancelled' ? 'TAX INVOICE (CANCELLED)' : 'TAX INVOICE'), { align: 'center' });
    doc.moveDown(0.4);
    const s = inv.supplier ?? {};
    const b = inv.buyer ?? {};
    const top = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).text(T(s.legalName ?? ''), left, top, { width: width / 2 - 8 });
    doc.font('Helvetica').fontSize(9).text(T([s.address1, s.address2, [s.city, s.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ')), { width: width / 2 - 8 });
    doc.text(T(`GSTIN: ${s.gstin ?? '-'}   State: ${s.stateName ?? ''} (${s.stateCode ?? ''})`), { width: width / 2 - 8 });
    const leftEnd = doc.y;
    doc.font('Helvetica').fontSize(9);
    const meta = [
      `Invoice no: ${inv.invoiceNo ?? '-'}`, `Invoice date: ${inv.invoiceDate ?? '-'}`,
      ...(inv.dueDate ? [`Due date: ${inv.dueDate}${inv.creditDays != null ? ` (${inv.creditDays} days)` : ''}`] : []),
      `Order: ${inv.order?.code ?? ''}`,
      `Place of supply: ${inv.placeOfSupply ? `${inv.placeOfSupply.name} (${inv.placeOfSupply.code})` : '-'}`,
      `Tax: ${inv.isIgst ? 'IGST (inter-state)' : 'CGST + SGST (within the state)'}`,
    ];
    doc.text(T(meta.join('\n')), left + width / 2 + 8, top, { width: width / 2 - 8 });
    doc.y = Math.max(leftEnd, doc.y) + 8;
    doc.x = left;
    doc.font('Helvetica-Bold').fontSize(9.5).text('Bill to', left);
    doc.font('Helvetica').fontSize(9).text(T(`${b.name ?? '-'}\n${[b.address, [b.city, b.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ')}\nGSTIN: ${b.gstin ?? 'Unregistered'}   State: ${b.stateName ?? ''} (${b.stateCode ?? ''})`), { width });
    doc.moveDown(0.6);
    const igst = !!inv.isIgst;
    const cols = [
      { k: 'sl', t: 'Sl', w: 22 }, { k: 'd', t: 'Description', w: igst ? 225 : 175 }, { k: 'h', t: 'HSN/SAC', w: 50 },
      { k: 'tx', t: 'Taxable (Rs)', w: 70, r: true }, { k: 'g', t: 'GST %', w: 34, r: true },
      ...(igst ? [{ k: 'i', t: 'IGST (Rs)', w: 60, r: true }] : [{ k: 'c', t: 'CGST (Rs)', w: 55, r: true }, { k: 's', t: 'SGST (Rs)', w: 55, r: true }]),
      { k: 'to', t: 'Total (Rs)', w: 62, r: true },
    ];
    const row = (vals, { bold = false } = {}) => {
      const y = doc.y; let x = left; let h = 0;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      for (const col of cols) {
        const str = T(vals[col.k]);
        doc.text(str, x, y, { width: col.w - 4, align: col.r ? 'right' : 'left' });
        h = Math.max(h, doc.heightOfString(str, { width: col.w - 4 }));
        x += col.w;
      }
      doc.y = y + h + 4; doc.x = left;
      if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
    };
    row(Object.fromEntries(cols.map((x) => [x.k, x.t])), { bold: true });
    doc.moveTo(left, doc.y - 2).lineTo(left + cols.reduce((t, x) => t + x.w, 0), doc.y - 2).strokeColor('#999999').stroke();
    for (const l of inv.lines) {
      row({ sl: String(l.slNo), d: l.description, h: l.hsnCode ?? '', tx: rs(l.taxable), g: l.gstRate == null ? '' : String(l.gstRate), c: rs(l.cgst), s: rs(l.sgst), i: rs(l.igst), to: rs(l.total) });
    }
    doc.moveTo(left, doc.y).lineTo(left + cols.reduce((t, x) => t + x.w, 0), doc.y).strokeColor('#999999').stroke();
    doc.moveDown(0.4);
    const tt = inv.totals;
    const sums = [['Taxable value', tt.taxable], ...(igst ? [['IGST', tt.igst]] : [['CGST', tt.cgst], ['SGST', tt.sgst]]), ['Round off', tt.roundOff], ['Invoice total', tt.grandTotal]];
    for (const [k, v] of sums) {
      const y = doc.y;
      doc.font(k === 'Invoice total' ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
      doc.text(T(k), left + width - 220, y, { width: 120 });
      doc.text(T(`Rs ${rs(v)}`), left + width - 100, y, { width: 100, align: 'right' });
      doc.x = left;
    }
    doc.moveDown(0.6).font('Helvetica').fontSize(9).text(T(`Amount in words: ${tt.inWords ?? ''}`), left, doc.y, { width });
    if (inv.notes) doc.moveDown(0.4).text(T(`Notes: ${inv.notes}`), { width });
    if (inv.cancelledReason) doc.moveDown(0.4).fillColor('#b00020').text(T(`Cancelled: ${inv.cancelledReason}`), { width }).fillColor('#000000');
    doc.moveDown(1.5).font('Helvetica').fontSize(9).text(T(`For ${s.legalName ?? ''}`), { width, align: 'right' });
    doc.moveDown(2).text('Authorised signatory', { width, align: 'right' });
    doc.end();
  });
  return { buffer, contentType: 'application/pdf', filename: `${String(inv.invoiceNo ?? `invoice-${inv.id}`).replace(/[^A-Za-z0-9_-]+/g, '-')}.pdf` };
}

export { money as moneyText };
