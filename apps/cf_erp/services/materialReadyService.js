/**
 * materialReadyService.js — THE material-ready engine (init.sql §56, contract
 * TM/CF_ERP_BUYING_V2.md §4). One answer, on the server, to "can this work be
 * planned, and from when?" — used by the planner snapshot and its saves, the
 * order's Buying stage, the release dialog, a step's refusal at the machine and
 * the requisition screens. The browser does not work this out any more.
 *
 * WHAT A UNIT OF WORK NEEDS. A line's material is known once it is released
 * (its requirements) or frozen and nested (releaseService.plannedMaterialOfLines
 * — the requirements release WILL write, nest plates included): lineNeeds().
 * The planner shares a line's need out over its units (plannerService).
 *
 * WHAT COVERS IT, in this order, for every material of every unit:
 *   1 issued      already issued to this line's requirements            today
 *   2 reserved    reserved for this line's requirements                 today
 *   3 held        held for this line's requisition line (the stock check, or a
 *                 receipt on a PO bought for it), then held for the order as
 *                 a whole (rows older than §56)                         today
 *   4 po          a PO line ALLOCATED to this line's requisition line, then to
 *                 the order as a whole — outstanding quantity only (what
 *                 arrived is a hold). Dated ones first, earliest first: the
 *                 date is the PO line's, else the PO's. A date in the past
 *                 with steel still outstanding is LATE (the date is kept).
 *                 Ordered with no date, or only requested / quoting, is cover
 *                 with NO DATE: "asked for, no date yet" — the unit waits.
 *   — what is still uncovered —
 *   5 free        FREE stock: storage / WIP, usable lots, less EVERY active
 *                 reservation and hold of anybody; the order's customer's own
 *                 lots first, never another customer's. It is NOT earmarked
 *                 (soft): it is worked out again on every read, so the moment
 *                 another order holds or reserves it, this unit waits again.
 *   6 po (pooled) a PO line's quantity allocated to NO order — anybody's, by
 *                 date. NOT for a material whose buying was SKIPPED: a skip
 *                 waits for stock, and for nothing else.
 *   7 none        short. The unit is WAITING, with no date.
 * An allocation of ANOTHER order is never supply for this one.
 *
 * WHO GOES FIRST. Consumers are served strictly in the order they are given
 * (the CLAIM ORDER) and every quantity is used once — the same kilogram of
 * plate cannot make two units ready. The order is the caller's, and there are
 * two, both documented where they are built:
 *   lines   (Buying stage, requisitions, release dialog)  claimOrderOfLines
 *   units   (the planner)                                 plannerService.claimOrderOfUnits
 *
 * state: ready (everything is here, counting unearmarked free stock — `soft`)
 *        dated (covered, the latest receiving date is readyDate)
 *        late  (covered, but a delivery is overdue — readyDate is still the latest date)
 *        waiting (something has no date: short, skipped with no stock, or only asked for)
 *
 * ROUND TRIPS (~49 ms each on production). lineNeeds: 1 + 3 (0 when nothing is
 * released / frozen). loadSupply: 5, side by side, whatever the number of
 * items, orders, purchase orders or units. evaluate: none — it is pure.
 */
import { notFound } from '../lib/errors.js';
import { plannedMaterialOfLines } from './releaseService.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Orders whose lines can still need material: the planner's set (not draft, lost, cancelled, closed or revised). */
export const OPEN_ORDER_STATUSES = ['inquiry', 'quoted', 'confirmed'];
/** A purchase order that can still deliver. The first two give a DATE; the rest are only asked for. */
export const DATED_PO_STATUSES = ['ordered', 'partially_received'];
export const ASKED_PO_STATUSES = ['requested', 'quoting', 'draft'];
export const LIVE_PO_STATUSES = [...DATED_PO_STATUSES, ...ASKED_PO_STATUSES];
export const READY_STATES = ['ready', 'dated', 'late', 'waiting'];

// --- the clock: one place says what today is, so a test can set it ---------------------

let fixedToday = null;
/** Tests only: pin today (YYYY-MM-DD), or null to follow the real calendar again. */
export function setToday(text) { fixedToday = text ?? null; }
export function today() {
  if (fixedToday) return fixedToday;
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const dateOnly = (d) => {
  if (!d) return null;
  if (d instanceof Date) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return String(d).slice(0, 10);
};
/** "14 Nov 2026" */
export const dayWords = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : 'no date');
const fmt = (n) => String(Number(Number(n).toFixed(3)));

// --- the lines, and what each needs ----------------------------------------------------

/**
 * Every line that can still need material: on an open order, not fully
 * delivered — the planner's own set, with what the engine needs to know. One read.
 */
export async function openLines(db, companyId, { orderIds = null } = {}) {
  const [rows] = await db.query(
    `SELECT ol.id, ol.order_id, ol.line_no, ol.line_type, ol.item_id, ol.quantity, ol.locked_at, ol.committed_date,
            o.code AS order_code, o.status AS order_status, o.order_type, o.customer_id, o.plan_priority, o.committed_date AS order_committed,
            m.code AS item_code, m.name AS item_name, ol.description,
            (SELECT r.id FROM cf_production_releases r
              WHERE r.company_id = ol.company_id AND r.order_line_id = ol.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_sales_orders o
       JOIN cf_sales_order_lines ol ON ol.company_id = o.company_id AND ol.order_id = o.id AND ol.deleted_at IS NULL
       LEFT JOIN cf_master_records m ON m.company_id = ol.company_id AND m.id = ol.item_id
      WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.status IN (?)
        AND COALESCE(ol.delivered_qty, 0) < ol.quantity ${orderIds ? 'AND o.id IN (?)' : ''}
      ORDER BY o.id, ol.line_no, ol.id`,
    orderIds ? [companyId, OPEN_ORDER_STATUSES, orderIds] : [companyId, OPEN_ORDER_STATUSES],
  );
  return rows;
}

/** The order number a hold or an allocation is matched by: every revision of an order shares it. */
export const orderKeyOf = (code) => String(code ?? '').toLowerCase();

/**
 * Orders in the planner's ranking: ranked ones first (1 = first), then by the
 * order's committed date, then by id. Map(orderId -> position). Pure.
 */
export function orderRanks(lines) {
  const orders = new Map();
  for (const l of lines) {
    if (!orders.has(l.order_id)) orders.set(l.order_id, { id: l.order_id, priority: l.plan_priority == null ? null : Number(l.plan_priority), committed: dateOnly(l.order_committed) ?? '9999' });
  }
  const sorted = [...orders.values()].sort((a, b) => {
    if ((a.priority == null) !== (b.priority == null)) return a.priority == null ? 1 : -1;
    if (a.priority != null && a.priority !== b.priority) return a.priority - b.priority;
    return String(a.committed).localeCompare(String(b.committed)) || a.id - b.id;
  });
  return new Map(sorted.map((o, i) => [o.id, i]));
}

/**
 * THE CLAIM ORDER OF LINES — the order's place in the planner's ranking, then
 * the line number, then the line id. (The planner's own order also puts cards
 * pinned by hand first: plannerService.claimOrderOfUnits.)
 */
export function claimOrderOfLines(lines) {
  const rank = orderRanks(lines);
  return [...lines].sort((a, b) => rank.get(a.order_id) - rank.get(b.order_id) || Number(a.line_no) - Number(b.line_no) || a.id - b.id);
}

/**
 * What each line needs, from the one source the buy list, release and the
 * requisition all use. Map(lineId -> {
 *   known     the material is known: released, or frozen
 *   source    'released' | 'planned' | null
 *   ready     false while a cut plate still has no plate (nest the line) — what IS known is still listed
 *   openPlates, why (a sentence when not known)
 *   items     Map(itemId -> { need, issued, reserved, item: { id, code, name, uom, trackedBy } })
 * }). need is the whole quantity (issued and reserved are part of it).
 * Round trips: 1 for the released lines + 3 for the frozen ones, whatever their number.
 */
export async function lineNeeds(db, companyId, lines) {
  const out = new Map();
  const released = lines.filter((l) => l.release_id);
  const frozen = lines.filter((l) => !l.release_id && l.locked_at && l.item_id);
  const [reqRows, planned] = await Promise.all([
    released.length ? db.query(
      `SELECT r.order_line_id, q.item_id, m.code, m.name, i.uom, i.tracked_by,
              SUM(q.quantity) AS need, SUM(LEAST(q.issued, q.quantity)) AS issued, SUM(COALESCE(v.reserved, 0)) AS reserved
         FROM cf_material_requirements q
         JOIN cf_production_releases r ON r.id = q.release_id AND r.deleted_at IS NULL
         JOIN cf_master_records m ON m.id = q.item_id
         LEFT JOIN cf_item_details i ON i.master_id = q.item_id AND i.deleted_at IS NULL
         LEFT JOIN (SELECT v.requirement_id, SUM(v.quantity) AS reserved
                      FROM cf_stock_reservations v
                     WHERE v.company_id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND v.requirement_id IS NOT NULL
                     GROUP BY v.requirement_id) v ON v.requirement_id = q.id
        WHERE q.company_id = ? AND q.release_id IN (?) AND q.deleted_at IS NULL
        GROUP BY r.order_line_id, q.item_id, m.code, m.name, i.uom, i.tracked_by
        ORDER BY r.order_line_id, m.code, q.item_id`,
      [companyId, companyId, released.map((l) => l.release_id)],
    ).then(([r]) => r) : [],
    plannedMaterialOfLines(db, companyId, frozen),
  ]);
  for (const l of lines) {
    const base = { known: false, source: null, ready: false, openPlates: 0, why: null, items: new Map() };
    if (l.release_id) Object.assign(base, { known: true, source: 'released', ready: true });
    else if (!l.item_id) base.why = 'The line has no item yet.';
    else if (!l.locked_at) {
      base.why = l.line_type === 'custom'
        ? 'The design is not frozen — its material is read off the frozen pieces.'
        : 'The line is not released — a catalog line\'s material is known once it is released.';
    }
    out.set(Number(l.id), base);
  }
  for (const r of reqRows) {
    const e = out.get(Number(r.order_line_id));
    if (!e) continue;
    const need = round6(r.need);
    const issued = round6(Math.min(Number(r.issued), need));
    e.items.set(Number(r.item_id), {
      need, issued, reserved: round6(Math.min(Number(r.reserved), need - issued)),
      item: { id: Number(r.item_id), code: r.code, name: r.name, uom: r.uom ?? null, trackedBy: r.tracked_by ?? null },
    });
  }
  for (const [lineId, p] of planned) {
    const e = out.get(Number(lineId));
    if (!e) continue;
    Object.assign(e, { known: true, source: 'planned', ready: !!p.ready, openPlates: Number(p.openPlates ?? 0) });
    if (!p.ready) e.why = `${p.openPlates} cut plate${p.openPlates === 1 ? ' has' : 's have'} no plate yet — nest the line, so their plates are known.`;
    for (const r of p.reqs) {
      const cur = e.items.get(Number(r.itemId)) ?? {
        need: 0, issued: 0, reserved: 0,
        item: { id: Number(r.itemId), code: r.design?.code ?? null, name: r.design?.name ?? null, uom: r.design?.uom ?? null, trackedBy: r.design?.trackedBy ?? null },
      };
      cur.need = round6(cur.need + Number(r.quantity));
      e.items.set(Number(r.itemId), cur);
    }
  }
  return out;
}

// --- supply ----------------------------------------------------------------------------

const bucket = (q = 0) => ({ q: round6(q) });
const addTo = (map, key, q) => { const b = map.get(key) ?? bucket(); b.q = round6(b.q + Number(q)); map.set(key, b); return b; };

/**
 * Everything that can cover a need of the given items, read ONCE: free stock
 * (ours, and each customer's own lots), holds per requisition line and per
 * order, live purchase lines with their allocations, and the requisition lines
 * themselves (the skip decisions). Five reads, side by side.
 *
 * `needs` (lineNeeds) gives the issued / reserved part of each released line.
 * The result is MUTABLE: evaluate() takes from it.
 */
export async function loadSupply(db, companyId, itemIds, { needs = new Map(), todayText = today() } = {}) {
  const supply = {
    today: todayText,
    issued: new Map(), reserved: new Map(), heldLine: new Map(), heldOrder: new Map(),
    allocLine: new Map(), allocOrder: new Map(), free: new Map(), pooled: new Map(),
    pr: new Map(), items: new Map(), tiers: new Map(),
    // As read, before anything is taken: our free stock per item, and the live purchase lines (the planner's old `supply`).
    freeOurs: new Map(), poLines: [],
  };
  for (const [lineId, n] of needs) {
    for (const [itemId, e] of n.items) {
      supply.items.set(itemId, e.item);
      if (e.issued > EPS) supply.issued.set(`${lineId}:${itemId}`, bucket(e.issued));
      if (e.reserved > EPS) supply.reserved.set(`${lineId}:${itemId}`, bucket(e.reserved));
    }
  }
  const ids = [...new Set(itemIds.map(Number))];
  if (!ids.length) return supply;
  const [[bal], [res], [poRows], [prLines], [names]] = await Promise.all([
    db.query(
      `SELECT k.item_id, k.batch_id, SUM(k.quantity) AS qty, b.status AS batch_status, b.owner_party_id, oo.code AS owner_order
         FROM cf_stock_balances k
         JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose IN ('storage','wip')
         LEFT JOIN cf_stock_batches b ON b.id = k.batch_id
         LEFT JOIN cf_sales_orders oo ON oo.id = b.owner_order_id
        WHERE k.company_id = ? AND k.item_id IN (?) AND k.quantity > 0
        GROUP BY k.item_id, k.batch_id, b.status, b.owner_party_id, oo.code`,
      [companyId, ids],
    ),
    // Every active reservation per lot (what is not free), and — the same rows — whose HOLD each is.
    db.query(
      `SELECT v.item_id, v.batch_id, (v.held_for_order_id IS NOT NULL) AS is_hold, ho.code AS order_code, prl.order_line_id, SUM(v.quantity) AS qty
         FROM cf_stock_reservations v
         LEFT JOIN cf_sales_orders ho ON ho.id = v.held_for_order_id AND ho.deleted_at IS NULL
         LEFT JOIN cf_requisition_lines prl ON prl.id = v.pr_line_id AND prl.deleted_at IS NULL
        WHERE v.company_id = ? AND v.item_id IN (?) AND v.status = 'active' AND v.deleted_at IS NULL
        GROUP BY v.item_id, v.batch_id, (v.held_for_order_id IS NOT NULL), ho.code, prl.order_line_id`,
      [companyId, ids],
    ),
    // Live purchase lines with something still to come, each with its allocations (one row per allocation, or one with none).
    db.query(
      `SELECT l.id, l.item_id, l.quantity, l.qty_received, COALESCE(l.expected_date, p.expected_date) AS due, p.status, p.code, p.id AS po_id,
              a.id AS a_id, a.quantity AS a_quantity, a.qty_received AS a_received, o.code AS order_code, prl.order_line_id
         FROM cf_purchase_order_lines l
         JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
         LEFT JOIN cf_purchase_line_orders a ON a.company_id = l.company_id AND a.purchase_line_id = l.id AND a.deleted_at IS NULL
         LEFT JOIN cf_sales_orders o ON o.id = a.order_id AND o.deleted_at IS NULL
         LEFT JOIN cf_requisition_lines prl ON prl.id = a.pr_line_id AND prl.deleted_at IS NULL
        WHERE l.company_id = ? AND l.item_id IN (?) AND l.deleted_at IS NULL AND p.status IN (?) AND l.quantity > l.qty_received
        ORDER BY l.id, a.id`,
      [companyId, ids, LIVE_PO_STATUSES],
    ),
    db.query(
      `SELECT pl.id, pl.requisition_id, pl.order_line_id, pl.item_id, pl.quantity, pl.skipped, pl.skipped_at, pl.skip_note, r.code
         FROM cf_requisition_lines pl
         JOIN cf_requisitions r ON r.id = pl.requisition_id AND r.deleted_at IS NULL
        WHERE pl.company_id = ? AND pl.deleted_at IS NULL AND pl.item_id IN (?)`,
      [companyId, ids],
    ),
    db.query(
      `SELECT m.id, m.code, m.name, i.uom, i.tracked_by FROM cf_master_records m
         LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
        WHERE m.company_id = ? AND m.id IN (?)`,
      [companyId, ids],
    ),
  ]);
  for (const r of names) if (!supply.items.has(r.id)) supply.items.set(r.id, { id: r.id, code: r.code, name: r.name, uom: r.uom ?? null, trackedBy: r.tracked_by ?? null });

  // Free stock: per lot, on hand less every active reservation on it (availability's own rule).
  const reservedOf = new Map();
  for (const r of res) {
    const k = `${r.item_id}:${r.batch_id ?? 0}`;
    reservedOf.set(k, (reservedOf.get(k) ?? 0) + Number(r.qty));
    if (!Number(r.is_hold) || r.order_code == null) continue;
    if (r.order_line_id != null) addTo(supply.heldLine, `${r.order_line_id}:${r.item_id}`, r.qty);
    else addTo(supply.heldOrder, `${orderKeyOf(r.order_code)}:${r.item_id}`, r.qty);
  }
  for (const b of bal) {
    const usable = !b.batch_id || b.batch_status === 'available';
    if (!usable) continue;
    const free = round6(Math.max(0, Number(b.qty) - (reservedOf.get(`${b.item_id}:${b.batch_id ?? 0}`) ?? 0)));
    if (free <= EPS) continue;
    const e = supply.free.get(b.item_id) ?? { ours: bucket(), theirs: [] };
    if (b.owner_party_id == null) e.ours.q = round6(e.ours.q + free);
    else {
      const key = b.owner_order ? orderKeyOf(b.owner_order) : null;
      let lot = e.theirs.find((t) => t.partyId === b.owner_party_id && t.orderKey === key);
      if (!lot) { lot = { partyId: b.owner_party_id, orderKey: key, b: bucket() }; e.theirs.push(lot); }
      lot.b.q = round6(lot.b.q + free);
    }
    supply.free.set(b.item_id, e);
  }
  for (const [itemId, e] of supply.free) supply.freeOurs.set(itemId, e.ours.q);

  const describe = (l) => {
    const due = dateOnly(l.due);
    const dated = DATED_PO_STATUSES.includes(l.status);
    return {
      status: !dated ? 'asked' : due ? 'dated' : 'undated', date: dated ? due : null,
      late: dated && !!due && due < todayText, poId: l.po_id, poCode: l.code ?? `PO-${l.po_id}`, poLineId: l.id, poStatus: l.status,
    };
  };
  const lines = new Map();                           // po line -> { row, allocated, received }
  for (const r of poRows) {
    if (!lines.has(r.id)) lines.set(r.id, { row: r, allocated: 0, received: 0 });
    if (r.a_id == null) continue;
    const t = lines.get(r.id);
    t.allocated += Number(r.a_quantity);
    t.received += Number(r.a_received);
    const out = round6(Math.max(0, Number(r.a_quantity) - Number(r.a_received)));
    // A share of an order that is gone is nobody's: it is still not free for anyone else (it must be let go first).
    if (out <= EPS || r.order_code == null) continue;
    const entry = { ...describe(r), b: bucket(out), allocationId: r.a_id };
    const [map, key] = r.order_line_id != null
      ? [supply.allocLine, `${r.order_line_id}:${r.item_id}`]
      : [supply.allocOrder, `${orderKeyOf(r.order_code)}:${r.item_id}`];
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }
  for (const { row: l, allocated, received } of lines.values()) {
    supply.poLines.push({ id: l.id, itemId: l.item_id, quantity: Number(l.quantity), received: Number(l.qty_received), due: dateOnly(l.due), status: l.status, code: l.code, poId: l.po_id });
    // Allocated to no order: anybody's. Only a DATED line is supply — a request with no date is not.
    const out = round6(Math.max(0, (Number(l.quantity) - allocated) - Math.max(0, Number(l.qty_received) - received)));
    const d = describe(l);
    if (out <= EPS || d.status !== 'dated') continue;
    if (!supply.pooled.has(l.item_id)) supply.pooled.set(l.item_id, []);
    supply.pooled.get(l.item_id).push({ ...d, b: bucket(out), pooled: true });
  }
  for (const list of supply.pooled.values()) list.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.poLineId - b.poLineId);
  for (const p of prLines) {
    supply.pr.set(`${p.order_line_id}:${p.item_id}`, {
      id: p.id, requisitionId: p.requisition_id, code: p.code, skipped: !!Number(p.skipped), quantity: Number(p.quantity),
      skippedAt: p.skipped_at ?? null, note: p.skip_note ?? null,
    });
  }
  return supply;
}

const ALLOC_RANK = { dated: 0, undated: 1, asked: 2 };
const byAlloc = (a, b) => ALLOC_RANK[a.status] - ALLOC_RANK[b.status]
  || String(a.date ?? '9999').localeCompare(String(b.date ?? '9999')) || a.poLineId - b.poLineId;

/** The dedicated cover of one (line, material), in the order it is used. Shared bucket objects, built once. */
function tiersOf(supply, lineId, orderKey, itemId) {
  const k = `${lineId}:${itemId}`;
  let t = supply.tiers.get(k);
  if (t) return t;
  const ok = `${orderKey}:${itemId}`;
  const hard = [];
  const push = (b, kind) => { if (b) hard.push({ b, kind }); };
  push(supply.issued.get(k), 'issued');
  push(supply.reserved.get(k), 'reserved');
  push(supply.heldLine.get(k), 'held');
  push(supply.heldOrder.get(ok), 'held');
  const allocs = [...(supply.allocLine.get(k) ?? []), ...(supply.allocOrder.get(ok) ?? [])].sort(byAlloc);
  t = { hard, allocs };
  supply.tiers.set(k, t);
  return t;
}

// --- the sentences -----------------------------------------------------------------------

const nameOfItem = (it, id) => it?.code ?? it?.name ?? `item ${id}`;
const uomOf = (it) => (it?.uom ? ` ${it.uom}` : '');

/** One material's state, in a sentence a planner can act on. */
export function reasonWords(r) {
  const name = nameOfItem(r.item, r.item?.id);
  const u = uomOf(r.item);
  if (r.short > EPS) {
    const part = r.short + EPS < r.need ? `${fmt(r.short)} of ${fmt(r.need)}${u}` : `${fmt(r.need)}${u}`;
    return r.skipped
      ? `${name}: buying was skipped — waiting for stock (${part} not in stock yet).`
      : `${name}: ${part} is not covered — nothing is held, ordered or free in stock.`;
  }
  const asked = r.cover.find((c) => c.kind === 'po' && c.status === 'asked');
  if (asked) return `${name}: asked for on ${asked.poCode}, not ordered yet — no date.`;
  const undated = r.cover.find((c) => c.kind === 'po' && c.status === 'undated');
  if (undated) return `${name}: ordered on ${undated.poCode} with no receiving date yet.`;
  const pos = r.cover.filter((c) => c.kind === 'po');
  if (pos.length) {
    const last = pos.reduce((a, b) => (String(b.date) > String(a.date) ? b : a));
    const overdue = pos.filter((c) => c.late);
    if (overdue.length && r.state === 'late') {
      const worst = overdue.reduce((a, b) => (String(b.date) < String(a.date) ? b : a));
      return `${name}: was due ${dayWords(worst.date)} on ${worst.poCode} and has not arrived — overdue.`;
    }
    return `${name}: due ${dayWords(last.date)} on ${last.poCode}${last.pooled ? ' (bought for stock, not for this order)' : ''}.`;
  }
  if (r.cover.some((c) => c.kind === 'free')) return `${name}: in stock, not earmarked for this order.`;
  return `${name}: here.`;
}

// --- the engine ----------------------------------------------------------------------------

/**
 * Serve the consumers IN THE ORDER GIVEN from `supply` (which it uses up).
 *
 * consumers  [{ key, lineId, orderKey, customerId, needs: [{ itemId, qty }] }]
 * opts.full  list every material in `reasons` (default: only those that are not
 *            simply here — dated, late, waiting, or met from unearmarked stock)
 * Returns { results: Map(key -> result), takes: Map(key -> [[bucket, qty] …]) }.
 *   result = { state, readyDate, soft, materials, reasons: [{ item, need, short, state, date, skipped,
 *              requisitionLineId, cover: [{ kind, qty, date, poCode, poLineId, poId, status?, late?, pooled?, owner? }], text }], text }
 * Pure: no reads. giveBack(takes) undoes a consumer's takes (the planner's other levels).
 */
export function evaluate(supply, consumers, { full = false } = {}) {
  const results = new Map();
  const takes = new Map();
  const now = supply.today;
  for (const c of consumers) {
    const mine = [];
    const reasons = [];
    let state = 'ready';
    let readyDate = now;
    let soft = false;
    let materials = 0;
    for (const n of c.needs) {
      // A unit's share of a line's need is a fraction (a plate shared by area): the arithmetic stays exact here,
      // and "covered" allows the last decimal of a stored quantity — or 185 shares of 40 plates come up 0.000004 short.
      const need = Number(n.qty);
      if (!(need > 1e-9)) continue;
      materials += 1;
      const tol = Math.max(EPS, 1e-7 * need);
      const pr = supply.pr.get(`${c.lineId}:${n.itemId}`) ?? null;
      const skipped = !!pr?.skipped;
      let left = need;
      const cover = [];
      const add = (b, entry) => {
        if (left <= tol || !(b.q > 1e-9)) return;
        const t = Math.min(left, b.q);
        b.q -= t;
        left -= t;
        mine.push([b, t]);
        const same = cover.find((x) => x.kind === entry.kind && (x.poLineId ?? 0) === (entry.poLineId ?? 0) && (x.owner ?? '') === (entry.owner ?? ''));
        if (same) same.qty += t; else cover.push({ ...entry, qty: t });
      };
      const t = tiersOf(supply, c.lineId, c.orderKey, n.itemId);
      for (const h of t.hard) add(h.b, { kind: h.kind, date: now });
      for (const a of t.allocs) {
        add(a.b, { kind: 'po', date: a.date, poCode: a.poCode, poLineId: a.poLineId, poId: a.poId, status: a.status, ...(a.late ? { late: true } : {}) });
      }
      if (left > tol) {
        const f = supply.free.get(n.itemId);
        if (f) {
          for (const lot of f.theirs) {
            if (lot.partyId !== c.customerId || (lot.orderKey != null && lot.orderKey !== c.orderKey)) continue;
            add(lot.b, { kind: 'free', date: now, owner: 'customer' });
          }
          add(f.ours, { kind: 'free', date: now });
        }
      }
      // A skipped material waits for stock, and for nothing else.
      if (left > tol && !skipped) {
        for (const p of supply.pooled.get(n.itemId) ?? []) {
          add(p.b, { kind: 'po', date: p.date, poCode: p.poCode, poLineId: p.poLineId, poId: p.poId, status: 'dated', pooled: true, ...(p.late ? { late: true } : {}) });
        }
      }
      const short = left > tol ? round6(left) : 0;
      for (const x of cover) x.qty = round6(x.qty);
      if (short > 0) cover.push({ kind: 'none', qty: short, date: null });
      let st = 'ready';
      let date = now;
      if (short > 0 || cover.some((x) => x.kind === 'po' && x.status !== 'dated')) { st = 'waiting'; date = null; } else {
        for (const x of cover) if (x.date && x.date > date) date = x.date;
        if (cover.some((x) => x.late)) st = 'late';
        else if (date > now) st = 'dated';
      }
      const isSoft = cover.some((x) => x.kind === 'free');
      if (isSoft) soft = true;
      if (st === 'waiting') state = 'waiting';
      else if (st === 'late' && state !== 'waiting') state = 'late';
      else if (st === 'dated' && state === 'ready') state = 'dated';
      if (date && readyDate && date > readyDate) readyDate = date;
      if (st === 'waiting') readyDate = null;
      if (full || st !== 'ready' || isSoft) {
        const r = { item: supply.items.get(n.itemId) ?? { id: n.itemId, code: null, name: null, uom: null }, need: round6(need), short, state: st, date, skipped, requisitionLineId: pr?.id ?? null, cover };
        r.text = reasonWords(r);
        reasons.push(r);
      }
    }
    if (state === 'waiting') readyDate = null;
    // The sentence of the unit: what governs it — a wait first, then the overdue, then the latest date.
    const rank = { waiting: 0, late: 1, dated: 2, ready: 3 };
    const governing = reasons.filter((r) => r.state === state).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))[0]
      ?? [...reasons].sort((a, b) => rank[a.state] - rank[b.state])[0] ?? null;
    const others = reasons.filter((r) => r.state === state).length - 1;
    const text = state === 'ready'
      ? (soft ? 'Its material is in stock, not earmarked — plannable now.' : materials ? 'Its material is here.' : 'It needs no material.')
      : `${governing?.text ?? ''}${others > 0 ? ` (+${others} more)` : ''}`;
    results.set(c.key, { state, readyDate, soft, materials, reasons, text });
    takes.set(c.key, mine);
  }
  return { results, takes };
}

/** Undo takes (a consumer's list, or several) — the quantity goes back where it came from. */
export function giveBack(list) { for (const [b, q] of list) b.q += q; }
/** Take them again. */
export function takeAgain(list) { for (const [b, q] of list) b.q -= q; }

// --- lines, ready or not: everything in one call -------------------------------------------

/**
 * The material-ready state of every open line, each line ONE consumer, in
 * claimOrderOfLines. For the Buying stage, the requisition screens, the
 * release dialog and a step's refusal. `given.lines` saves the lines read.
 * Returns { today, lines, needs, supply, byLine: Map(lineId -> result & { known, why, source }) }
 * Round trips: 1 (lines) + ≤ 4 (needs) + 5 (supply) — fixed.
 */
export async function lineReadiness(db, companyId, { lines: given = null, full = true, todayText = today() } = {}) {
  const lines = given ?? await openLines(db, companyId);
  const needs = await lineNeeds(db, companyId, lines);
  const itemIds = new Set();
  for (const n of needs.values()) for (const id of n.items.keys()) itemIds.add(id);
  const supply = await loadSupply(db, companyId, [...itemIds], { needs, todayText });
  const consumers = claimOrderOfLines(lines).map((l) => ({
    key: Number(l.id), lineId: Number(l.id), orderKey: orderKeyOf(l.order_code), customerId: l.customer_id ?? null,
    needs: [...(needs.get(Number(l.id))?.items ?? [])].map(([itemId, e]) => ({ itemId, qty: e.need })),
  }));
  const { results } = evaluate(supply, consumers, { full });
  const byLine = new Map();
  for (const l of lines) {
    const n = needs.get(Number(l.id));
    byLine.set(Number(l.id), { ...results.get(Number(l.id)), known: !!n?.known, complete: !!n?.ready, why: n?.why ?? null, source: n?.source ?? null });
  }
  return { today: todayText, lines, needs, supply, byLine };
}

/** A line's state as the screens show it: { state, readyDate, soft, known, complete, why, text, materials: [reason…] }. */
export function shapeLineReady(r) {
  if (!r) return { state: null, readyDate: null, soft: false, known: false, complete: false, why: 'This line is not on an open order.', text: 'This line is not on an open order.', materials: [] };
  if (!r.known) return { state: null, readyDate: null, soft: false, known: false, complete: false, why: r.why, text: r.why ?? 'Its material is not known yet.', materials: [] };
  return { state: r.state, readyDate: r.readyDate, soft: !!r.soft, known: true, complete: !!r.complete, why: r.why, text: r.text, materials: r.reasons };
}

/**
 * Why a material of a line is not here, for the sentence a step is refused
 * with: names the requisition, the purchase order and the date it waits on.
 * itemIds null = every material of the line that is not simply here.
 */
export async function materialWaitWords(db, companyId, lineId, itemIds = null) {
  const all = await lineReadiness(db, companyId, { full: true });
  const r = all.byLine.get(Number(lineId));
  if (!r?.known) return [];
  const want = itemIds ? new Set(itemIds.map(Number)) : null;
  const out = [];
  for (const m of r.reasons) {
    if (want ? !want.has(Number(m.item.id)) : (m.state === 'ready' && !m.cover.some((c) => c.kind === 'free'))) continue;
    const pr = all.supply.pr.get(`${Number(lineId)}:${m.item.id}`);
    const where = pr ? ` (requisition ${pr.code})` : ' (no requisition raised)';
    const name = nameOfItem(m.item, m.item.id);
    const waitsOn = m.cover.filter((c) => c.kind !== 'issued' && c.kind !== 'reserved');
    if (!waitsOn.length) continue;
    const parts = waitsOn.map((c) => {
      if (c.kind === 'held') return `${fmt(c.qty)} is held for the order — reserve it for this step`;
      if (c.kind === 'free') return `${fmt(c.qty)} is free in stock — reserve it`;
      if (c.kind === 'none') return m.skipped ? `${fmt(c.qty)} waits for stock: buying was skipped` : `${fmt(c.qty)} is not ordered`;
      if (c.status === 'asked') return `${fmt(c.qty)} is asked for on ${c.poCode}, not ordered yet`;
      if (c.status === 'undated') return `${fmt(c.qty)} is ordered on ${c.poCode} with no receiving date`;
      return `${fmt(c.qty)} is ${c.late ? 'overdue' : 'due'} ${dayWords(c.date)} on ${c.poCode}`;
    });
    out.push(`${name}${where}: ${parts.join('; ')}.`);
  }
  return out;
}

/**
 * GET /order-lines/:id/material-ready — one line's state, material by material,
 * with the requisition it belongs to: what the release dialog and the order
 * page show. { line, order, today, requisition, state, readyDate, soft, known,
 * complete, why, text, materials: [reason…] }.
 */
export async function lineMaterialReady(db, companyId, lineId, { R: given = null } = {}) {
  const [[l]] = await db.query(
    `SELECT ol.id, ol.line_no, o.id AS order_id, o.code AS order_code, o.status AS order_status,
            (SELECT r.id FROM cf_requisitions r WHERE r.company_id = ol.company_id AND r.order_line_id = ol.id AND r.deleted_at IS NULL LIMIT 1) AS requisition_id,
            (SELECT r.code FROM cf_requisitions r WHERE r.company_id = ol.company_id AND r.order_line_id = ol.id AND r.deleted_at IS NULL LIMIT 1) AS requisition_code
       FROM cf_sales_order_lines ol JOIN cf_sales_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
      WHERE ol.company_id = ? AND ol.id = ? AND ol.deleted_at IS NULL`,
    [companyId, Number(lineId)],
  );
  if (!l) throw notFound('Order line');
  const R = given ?? await lineReadiness(db, companyId, { full: true });
  return {
    line: { id: l.id, lineNo: l.line_no }, order: { id: l.order_id, code: l.order_code, status: l.order_status }, today: R.today,
    requisition: l.requisition_id ? { id: l.requisition_id, code: l.requisition_code } : null,
    ...shapeLineReady(R.byLine.get(Number(l.id))),
  };
}
