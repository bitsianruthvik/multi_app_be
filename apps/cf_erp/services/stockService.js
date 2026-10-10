/**
 * stockService.js — the inventory (decided 2026-09-22): every stocking area
 * holds an inventory; stock is kept at item level (items tracked by quantity)
 * or batch level (items tracked by batch). Items tracked unit by unit get
 * their stock with production, not here.
 *
 * One path writes stock: postMovement. It checks everything first, then writes
 * the movement, its ledger rows (signed, per area) and the balances in the same
 * transaction. Balances never go below zero — the balance row is locked while
 * it is checked, so two issues cannot both take the last plate. Movements are
 * never edited; reverseMovement posts the opposite rows.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { loadMaster, LOCKED_ORDER_STATUSES, revisedOrderMessage, latestRevisionSql } from './records.js';
import { requireArea, shapeArea } from './stockingAreaService.js';
import { requireBatch, checkBatchValues, createBatch, ownerOf } from './batchService.js';
import { generate } from '../modules/codegen/index.js';
import { wantsPage, pageArgs, orderBy, pageOf, countsBy } from '../lib/listing.js';
import { unreceive } from './purchaseLinkService.js';

export const MOVEMENT_TYPES = ['receipt', 'issue', 'transfer', 'adjustment', 'scrap', 'return'];
const PREFIX = { receipt: 'GRN', issue: 'ISS', transfer: 'TRF', adjustment: 'ADJ', scrap: 'SCR', return: 'RET' };
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EPS = 1e-9;
const round6 = (n) => Number(Number(n).toFixed(6));
const round4 = (n) => Number(Number(n).toFixed(4));
const round2 = (n) => Number(Number(n).toFixed(2));
const numOrNull = (v) => (v == null ? null : Number(v));

/*
 * MONEY AND OWNERSHIP (init.sql §35, CF_ERP_MONEY_PLAN §1–2, decided 2026-09-30).
 *
 * OWNER: a lot (cf_stock_batches) is ours (owner_party_id NULL) or a customer's.
 * Loose stock is always ours — customer material always arrives as a lot, even
 * for an item counted by quantity. A customer's lot is used only for THAT
 * customer's order: the order it was supplied for (by order number, so every
 * revision), or, when it names none, any order of that customer (usableFor).
 *
 * COST follows the tracking level. A lot keeps its own unit cost (batch items,
 * and a unit is production's lot of one). Loose stock of a quantity item is
 * valued at one weighted average per item (cf_item_costs), over `costed_qty` —
 * stock that was on the shelf before costs were kept is NOT COSTED (NULL, shown
 * as unknown, never 0). Costed stock is taken first: an issue is valued at the
 * average while any costed quantity is left, and is not costed after that.
 * A receipt sets the cost; issue, scrap, return and a count move value out at
 * the stock's cost; a transfer keeps it (both legs at the same cost, the
 * average untouched). Every ledger row records unit_cost and value (signed like
 * quantity). A reversal moves the exact opposite value.
 */

/** Whether a lot may be used for an order: ours always; a customer's only for that customer's order. */
export function usableFor(batch, order) {
  if (!batch?.owner_party_id) return true;
  if (!order) return false;
  if (batch.owner_order_id) {
    const mine = order.code_active ?? (order.code == null ? null : String(order.code).toLowerCase());
    return batch.owner_order_code_active != null && mine != null && String(batch.owner_order_code_active) === String(mine);
  }
  return order.customer_id != null && Number(batch.owner_party_id) === Number(order.customer_id);
}

const ownerName = (b) => b.owner_party_name ?? b.owner_party_code ?? `party ${b.owner_party_id}`;
const fmt = (n) => String(round6(n));
const blank = (v) => v == null || String(v).trim() === '';
const dateOnly = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d ?? null);
const todayText = () => dateOnly(new Date());
const like = (s) => `%${String(s).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** What a balance row counts as: its batch's quality state first, then its area's purpose. */
export function categoryOf(purpose, batchStatus) {
  if (batchStatus === 'rejected') return 'rejected';
  if (batchStatus === 'on_hold' || purpose === 'quarantine') return 'held';
  return { storage: 'available', wip: 'in_process', dispatch: 'dispatch' }[purpose] ?? 'available';
}

const label = (item, batch) => `${item.code ?? item.name}${batch ? ` batch ${batch.code}` : ''}`;

/** Locks a balance row, checks the change keeps it at zero or above, and writes it. */
async function applyDelta(db, c, { area, item, batch, delta, movementId }) {
  const [[row]] = await db.query(
    'SELECT id, quantity FROM cf_stock_balances WHERE company_id = ? AND stocking_area_id = ? AND item_id = ? AND batch_key = ? FOR UPDATE',
    [c.companyId, area.id, item.id, batch?.id ?? 0],
  );
  const have = row ? Number(row.quantity) : 0;
  const next = round6(have + delta);
  if (next < -EPS) {
    throw invalid('NOT_ENOUGH', `Only ${fmt(have)} ${item.uom ?? ''} of ${label(item, batch)} in ${area.code} — ${fmt(-delta)} cannot be taken.`.replace('  ', ' '));
  }
  if (row) await db.query('UPDATE cf_stock_balances SET quantity = ?, last_movement_id = ? WHERE id = ?', [next, movementId, row.id]);
  else {
    await db.query(
      'INSERT INTO cf_stock_balances (company_id, stocking_area_id, item_id, batch_id, quantity, last_movement_id) VALUES (?, ?, ?, ?, ?, ?)',
      [c.companyId, area.id, item.id, batch?.id ?? null, next, movementId],
    );
  }
}

/**
 * Checks, before anything is written, that every area has enough for what the
 * movement takes out of it (legs of one item and batch taken together), and
 * locks those balance rows until the transaction ends.
 */
async function assertEnough(db, companyId, legs) {
  const byKey = new Map();
  for (const l of legs) {
    if (!l.batch && l.newBatch) continue;
    const key = `${l.area.id}:${l.item.id}:${l.batch?.id ?? 0}`;
    const prev = byKey.get(key);
    byKey.set(key, { ...l, delta: round6((prev?.delta ?? 0) + l.delta) });
  }
  for (const l of byKey.values()) {
    if (l.delta >= 0) continue;
    const have = await balanceOf(db, companyId, l.area.id, l.item.id, l.batch?.id, true);
    if (have + l.delta < -EPS) {
      throw invalid('NOT_ENOUGH', `Only ${fmt(have)} ${l.item.uom ?? ''} of ${label(l.item, l.batch)} in ${l.area.code} — ${fmt(-l.delta)} cannot be taken.`.replace('  ', ' '));
    }
  }
}

/**
 * Reserved stock stays reserved (models/init.sql §13f): a movement may not take
 * stock below what active reservations claim for that item and batch. Counts
 * are exempt (they record what is really there).
 *
 * Two claims, two shelves. MATERIAL a step needs is claimed off usable stock —
 * storage and WIP, batch not held. FINISHED work owed to a sales line is
 * claimed off the dispatch shelf it was received onto (Idea A). Keeping them
 * apart matters: an item can be raw material in the yard and finished goods on
 * the dispatch bay at the same time, and one claim must not eat the other.
 */
const RESERVATION_SCOPES = {
  // A hold (§43) guards stock like a material claim: it sits in storage until the order's release takes it.
  material: { purposes: ['storage', 'wip'], where: '(v.requirement_id IS NOT NULL OR v.held_for_order_id IS NOT NULL)' },
  finished: { purposes: ['dispatch'], where: 'v.order_line_id IS NOT NULL' },
};

async function assertReservationsKept(db, companyId, legs) {
  const byKey = new Map();
  for (const l of legs) {
    if (l.newBatch && !l.batch) continue;
    const scope = ['storage', 'wip'].includes(l.area.purpose) ? 'material' : l.area.purpose === 'dispatch' ? 'finished' : null;
    if (!scope || (l.batch && l.batch.status !== 'available')) continue;
    const key = `${scope}:${l.item.id}:${l.batch?.id ?? 0}`;
    const prev = byKey.get(key);
    byKey.set(key, { scope, item: l.item, batch: l.batch, delta: round6((prev?.delta ?? 0) + l.delta) });
  }
  for (const k of byKey.values()) {
    if (k.delta >= -EPS) continue;
    const { purposes, where } = RESERVATION_SCOPES[k.scope];
    await db.query('SELECT master_id FROM cf_item_details WHERE company_id = ? AND master_id = ? FOR UPDATE', [companyId, k.item.id]);
    const [[{ reserved }]] = await db.query(
      `SELECT COALESCE(SUM(v.quantity), 0) AS reserved FROM cf_stock_reservations v
        WHERE v.company_id = ? AND v.item_id = ? AND IFNULL(v.batch_id, 0) = ? AND v.status = 'active' AND v.deleted_at IS NULL AND ${where}`,
      [companyId, k.item.id, k.batch?.id ?? 0],
    );
    if (Number(reserved) <= EPS) continue;
    const [[{ usable }]] = await db.query(
      `SELECT COALESCE(SUM(k.quantity), 0) AS usable FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
        WHERE k.company_id = ? AND k.item_id = ? AND k.batch_key = ? AND a.purpose IN (?)`,
      [companyId, k.item.id, k.batch?.id ?? 0, purposes],
    );
    if (Number(usable) + k.delta >= Number(reserved) - EPS) continue;
    const [who] = await db.query(
      `SELECT DISTINCT o.code FROM cf_stock_reservations v
         LEFT JOIN cf_material_requirements q ON q.id = v.requirement_id
         LEFT JOIN cf_production_releases r ON r.id = q.release_id
         LEFT JOIN cf_sales_order_lines dl ON dl.id = v.order_line_id
         JOIN cf_sales_orders o ON o.id = COALESCE(r.order_id, dl.order_id, v.held_for_order_id)
        WHERE v.company_id = ? AND v.item_id = ? AND IFNULL(v.batch_id, 0) = ? AND v.status = 'active' AND v.deleted_at IS NULL AND ${where}
        ORDER BY o.code`,
      [companyId, k.item.id, k.batch?.id ?? 0],
    );
    const free = Math.max(0, round6(Number(usable) - Number(reserved)));
    const what = k.scope === 'finished' ? 'made for' : 'reserved for';
    throw invalid('RESERVED', `${fmt(reserved)} ${k.item.uom ?? ''} of ${label(k.item, k.batch)} ${Number(reserved) === 1 ? 'is' : 'are'} ${what} ${who.map((w) => w.code).join(', ')} — only ${fmt(free)} can be taken. Let the reservation go first if it is no longer needed.`.replace('  ', ' '));
  }
}

async function balanceOf(db, companyId, areaId, itemId, batchId, lock = false) {
  const [[row]] = await db.query(
    `SELECT quantity FROM cf_stock_balances WHERE company_id = ? AND stocking_area_id = ? AND item_id = ? AND batch_key = ?${lock ? ' FOR UPDATE' : ''}`,
    [companyId, areaId, itemId, batchId ?? 0],
  );
  return row ? Number(row.quantity) : 0;
}

/**
 * An item that can hold stock: a real item, counted by quantity or by batch.
 *
 * Two of these refusals say "not here" rather than "never": a temporary item is
 * made for its order, and a unit-tracked item's stock arrives with production.
 * `fromProduction` is production saying exactly that — the finished piece going
 * onto the shelf and, when it ships, back off it (Idea A). Until units carry
 * their own numbers it is counted as a quantity like everything else.
 */
async function stockItem(db, companyId, id, P, { receipt, fromProduction = false }) {
  if (blank(id)) { P('choose an item.'); return null; }
  const item = await loadMaster(db, companyId, Number(id));
  if (!item) { P('that item does not exist.'); return null; }
  if (item.record_kind !== 'item') { P(`${item.code ?? item.name} is a definition — a blueprint is never stocked.`); return null; }
  if (receipt && !fromProduction && item.item_type !== 'catalog') { P(`${item.code ?? item.name} is made for its order — only catalog items are received.`); return null; }
  if (item.tracked_by === 'individual' && !fromProduction) { P(`${item.code ?? item.name} is tracked unit by unit — its stock arrives with production, not here.`); return null; }
  if (receipt && item.status !== 'active') { P(`${item.code ?? item.name} is ${item.status} — activate it before receiving it.`); return null; }
  return item;
}

function readQty(raw, P, { signed = false } = {}) {
  if (blank(raw)) { P('quantity is required.'); return null; }
  const q = Number(raw);
  if (!Number.isFinite(q) || (signed ? q === 0 : q <= 0)) { P(signed ? 'the change is a number other than zero.' : 'quantity must be more than zero.'); return null; }
  if (Math.abs(q) >= 1e12) { P('quantity is too large.'); return null; }
  return round6(q);
}

/** A stocking area for a line, cached per movement; `inbound` areas must be active. */
function areaReader(db, companyId, problems) {
  const cache = new Map();
  return async (id, P, what, { inbound }) => {
    if (blank(id)) { P(`choose the area it ${what}.`); return null; }
    let a = cache.get(Number(id));
    if (!a) {
      try { a = await requireArea(db, companyId, id); } catch { P('that stocking area does not exist.'); return null; }
      cache.set(a.id, a);
    }
    if (inbound && a.status !== 'active') { P(`${a.code} is inactive — nothing goes into it.`); return null; }
    return a;
  };
}

/**
 * Reads one line into { lineNo, item, batch | newBatch, legs: [{ area, sign }], quantity | counted }.
 * Problems are collected with the line number in front.
 */
async function planLine(db, c, type, l, n, header, getArea, problems, { fromProduction = false, owners = null } = {}) {
  const P = (msg) => problems.push(`Line ${n}: ${msg}`);
  const item = await stockItem(db, c.companyId, l.itemId, P, { receipt: type === 'receipt', fromProduction });
  if (!item) return null;
  const plan = {
    lineNo: n, item, batch: null, newBatch: null, legs: [], quantity: null, counted: null, notes: blank(l.notes) ? null : String(l.notes).slice(0, 255),
    unitCost: null, owner: null,
  };

  // The cost a receipt brings (the PO line's price, or typed). Everything else
  // moves at the cost the stock already has, so nothing else may carry one.
  if (!blank(l.unitCost)) {
    const u = Number(l.unitCost);
    if (type !== 'receipt') P('only a receipt carries a cost — everything else moves at the cost the stock already has.');
    else if (!Number.isFinite(u) || u < 0) P('unit cost is a number, zero or more.');
    else if (u >= 1e14) P('unit cost is too large.');
    else plan.unitCost = round4(u);
  }

  // Whose it is. Only a receipt says: customer material comes in as a lot owned
  // by that customer, for the order named (init.sql §35).
  if (type === 'receipt' && owners) {
    const partyId = blank(l.ownerPartyId) ? owners.defaultPartyId : l.ownerPartyId;
    const orderId = blank(l.ownerOrderId) ? owners.defaultOrderId : l.ownerOrderId;
    if (!blank(partyId) || !blank(orderId)) plan.owner = await owners.resolve(partyId, orderId, P);
    if (plan.owner === undefined) return null;
  } else if (!blank(l.ownerPartyId) || !blank(l.ownerOrderId)) {
    P('only a receipt says whose stock it is — a lot keeps its owner after that.');
  }

  if (type === 'adjustment' && !blank(l.countedQuantity)) {
    const q = Number(l.countedQuantity);
    if (!Number.isFinite(q) || q < 0) P('the counted quantity is a number, zero or more.');
    else plan.counted = round6(q);
  } else plan.quantity = readQty(l.quantity, P, { signed: type === 'adjustment' });

  const pick = (k) => (blank(l[k]) ? header[k] : l[k]);
  if (type === 'receipt') {
    const to = await getArea(pick('toAreaId'), P, 'goes into', { inbound: true });
    if (to) plan.legs.push({ area: to, sign: 1 });
  } else if (type === 'issue' || type === 'scrap' || type === 'return') {
    const from = await getArea(pick('fromAreaId'), P, 'comes from', { inbound: false });
    if (from && type === 'issue' && from.purpose === 'quarantine') P(`${from.code} holds stock in quarantine — move it to storage before issuing it.`);
    else if (from) plan.legs.push({ area: from, sign: -1 });
  } else if (type === 'transfer') {
    const from = await getArea(pick('fromAreaId'), P, 'comes from', { inbound: false });
    const to = await getArea(pick('toAreaId'), P, 'goes into', { inbound: true });
    if (from && to && from.id === to.id) P('it moves from and to the same area.');
    else if (from && to) plan.legs.push({ area: from, sign: -1 }, { area: to, sign: 1 });
  } else {
    const area = await getArea(pick('areaId'), P, 'is counted in', { inbound: false });
    if (area) plan.legs.push({ area, sign: 1 });
  }

  // Lots. An item kept by batch always has one. Anything else has one only when
  // production made it: that lot is how a finished piece keeps its identity on
  // the shelf (user, 2026-09-23), and it is what a shipment then takes back off.
  // Customer material is always a lot (loose stock is always ours), and what
  // goes back to a customer is always one of their lots.
  const keepsLots = item.tracked_by === 'batch' || (fromProduction && !!l.batch) || !!plan.owner || type === 'return';
  if (keepsLots) {
    if (type === 'receipt' && blank(l.batchId)) {
      const nb = l.batch ?? {};
      const vp = item.tracked_by === 'batch'
        ? await checkBatchValues(db, c.companyId, item, Array.isArray(nb.values) ? nb.values : [])
        : [];
      vp.forEach((p) => P(p));
      plan.newBatch = nb;
    } else if (blank(l.batchId)) {
      P(type === 'return' ? `say which of the customer's lots of ${item.code} goes back.` : `${item.code} is kept by batch — say which batch.`);
    } else {
      let b = null;
      try { b = await requireBatch(db, c.companyId, l.batchId); } catch { P('that batch does not exist.'); }
      if (b && b.item_id !== item.id) P(`batch ${b.code} is of ${b.item_code}, not ${item.code}.`);
      else if (b && type === 'receipt' && b.status === 'rejected') P(`batch ${b.code} is rejected — receive into a new batch.`);
      else if (b && type === 'issue' && b.status !== 'available') {
        P(`batch ${b.code} is ${b.status === 'on_hold' ? 'on hold' : 'rejected'}${b.status_note ? ` (${b.status_note})` : ''} — it is not issued.`);
      } else if (b) plan.batch = b;
    }
  } else if (!blank(l.batchId)) {
    // A lot from production is still a batch row, so a movement may name one
    // even for an item that is otherwise counted by quantity.
    let b = null;
    try { b = await requireBatch(db, c.companyId, l.batchId); } catch { P('that batch does not exist.'); }
    // The only batches such an item has are the lots production made of it and
    // the lots a customer supplied (and a unit-tracked item's lots ARE its units);
    // anything else named here is not one of its batches.
    if (b && (b.item_id !== item.id || (!b.production_item_id && !b.owner_party_id && item.tracked_by !== 'individual'))) P(`${item.code} is counted by quantity — it has no batches.`);
    else if (b) plan.batch = b;
  } else if (l.batch) {
    P(`${item.code} is counted by quantity — it has no batches.`);
  } else if (OUTBOUND.has(type) && plan.quantity != null && plan.legs.length) {
    // Nothing named a lot, and a quantity-counted item may still have some:
    // what production made carries one. Loose stock goes first, then the oldest
    // lot that can cover it — so nobody has to know about lots to issue bolts,
    // and a made piece still leaves the yard as the piece it is.
    plan.batch = await oldestLotFor(db, c.companyId, item, plan.legs[0].area.id, plan.quantity);
  }

  // Ownership, once the lot is known.
  const b = plan.batch;
  if (type === 'receipt' && b) {
    const same = Number(b.owner_party_id ?? 0) === Number(plan.owner?.partyId ?? 0)
      && Number(b.owner_order_id ?? 0) === Number(plan.owner?.orderId ?? 0);
    if (!same) P(`batch ${b.code} is ${b.owner_party_id ? `${ownerName(b)}'s material` : 'ours'} — receive ${plan.owner ? "the customer's material" : 'our stock'} into a new batch.`);
  }
  if (type === 'issue' && b?.owner_party_id && !usableFor(b, owners?.order)) {
    P(owners?.order
      ? `batch ${b.code} is ${ownerName(b)}'s material${b.owner_order_code ? ` for ${b.owner_order_code}` : ''} — it is used only for their order, not ${owners.order.code}.`
      : `batch ${b.code} is ${ownerName(b)}'s material — it is issued only to their order; name the order.`);
  }
  if (type === 'return' && b) {
    if (!b.owner_party_id) P(`batch ${b.code} is our stock — only a customer's material goes back to them.`);
    else if (owners?.party && Number(owners.party.id) !== Number(b.owner_party_id)) P(`batch ${b.code} is ${ownerName(b)}'s material, not ${owners.party.name}'s.`);
  }
  return plan;
}

const OUTBOUND = new Set(['issue', 'transfer', 'scrap', 'return']);

/** The oldest production lot in an area that covers what is being taken, if loose stock cannot. */
async function oldestLotFor(db, companyId, item, areaId, quantity) {
  const loose = await balanceOf(db, companyId, areaId, item.id, null);
  if (Number(loose) + EPS >= quantity) return null;
  const [lots] = await db.query(
    `SELECT b.* FROM cf_stock_balances k
       JOIN cf_stock_batches b ON b.id = k.batch_id AND b.deleted_at IS NULL
      WHERE k.company_id = ? AND k.item_id = ? AND k.stocking_area_id = ? AND k.quantity >= ?
        AND b.production_item_id IS NOT NULL AND b.owner_party_id IS NULL
      ORDER BY b.id LIMIT 1`,
    [companyId, item.id, areaId, quantity],
  );
  return lots[0] ?? null;
}

async function movementCode(db, c, type, input, areaId) {
  if (!blank(input.code)) {
    const code = String(input.code).trim();
    if (!CODE_RE.test(code) || code.length > 60) throw invalid('INVALID', 'Document number: up to 60 letters, digits and - _ . /, no spaces.');
    return code;
  }
  const g = await generate(db, c.companyId, 'stock_movement', 'code', { draft: { movementType: type, areaId } }, { consume: true });
  return g?.text ?? null;
}

/**
 * Posts a movement. input: {
 *   movementType: receipt | issue | transfer | adjustment | scrap | return,
 *   movementDate?, code?,
 *   partyId?   receipt: the supplier — or a customer, whose material it then is;
 *              return: the customer it goes back to (defaults to the lots' owner)
 *   orderId?   issue / scrap: the sales order it is for; receipt: the order the
 *              customer supplied it for; return: the order it is returned against
 *   orderLineId?  issue / scrap: the line of that order (job cost is per line)
 *   ownerPartyId?, ownerOrderId?  receipt: whose it is — default for every line
 *   reference?, reason? (required for adjustment, scrap and return), notes?,
 *   returnKg?  return: scrap handed back by weight (ownershipService)
 *   fromAreaId?, toAreaId?, areaId?  — defaults for every line,
 *   lines: [{ itemId, quantity | countedQuantity (adjustment), batchId? | batch: { code?, supplierRef?, values? } (new, receipt),
 *             unitCost? (receipt), ownerPartyId?, ownerOrderId? (receipt),
 *             fromAreaId?, toAreaId?, areaId?, notes? }]
 * }
 * Returns the movement (getMovement): every line with its unitCost and value
 * (null = not costed), and the movement's value.
 *
 * opts.allowEmpty — a return with no stock lines (only offcuts or scrap by
 * weight go back): the header is written alone. Only ownershipService sets it.
 */
export async function postMovement(db, c, input = {}, opts = {}) {
  // Production putting its own finished work on the shelf — never settable from
  // a request body, so a hand-typed receipt still refuses what only production
  // may stock.
  const fromProduction = opts.fromProduction === true;
  const type = input.movementType;
  if (!MOVEMENT_TYPES.includes(type)) throw invalid('INVALID', 'A movement is a receipt, issue, transfer, adjustment, scrap or return.');
  const problems = [];
  let date = todayText();
  if (!blank(input.movementDate)) {
    const s = String(input.movementDate).trim();
    if (!DATE_RE.test(s)) problems.push('Date needs YYYY-MM-DD.');
    else if (s > todayText()) problems.push('A movement cannot be dated in the future.');
    else date = s;
  }
  const partyCache = new Map();
  const loadParty = async (id) => {
    if (!partyCache.has(Number(id))) {
      const [[p]] = await db.query('SELECT id, code, name, is_supplier, is_customer FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(id)]);
      partyCache.set(Number(id), p ?? null);
    }
    return partyCache.get(Number(id));
  };
  const orderCache = new Map();
  const loadOrder = async (id) => {
    if (!orderCache.has(Number(id))) {
      const [[o]] = await db.query(
        `SELECT o.id, o.code, o.code_active, o.status, o.revision, o.customer_id, ${latestRevisionSql('o')} AS latest_revision
           FROM cf_sales_orders o WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL`,
        [c.companyId, Number(id)],
      );
      orderCache.set(Number(id), o ?? null);
    }
    return orderCache.get(Number(id));
  };

  let party = null;
  if (!blank(input.partyId)) {
    const p = await loadParty(input.partyId);
    if (type === 'receipt') {
      if (!p) problems.push('That supplier does not exist.');
      else if (!Number(p.is_supplier) && !Number(p.is_customer)) problems.push(`${p.name} is not marked as a supplier.`);
      else party = p;
    } else if (type === 'return') {
      if (!p) problems.push('That customer does not exist.');
      else if (!Number(p.is_customer)) problems.push(`${p.name} is not marked as a customer — only a customer's material goes back.`);
      else party = p;
    } else problems.push('Only a receipt names a supplier.');
  }
  let order = null;
  if (!blank(input.orderId)) {
    const o = await loadOrder(input.orderId);
    if (!['issue', 'scrap', 'receipt', 'return'].includes(type)) problems.push('Only an issue is made for a sales order.');
    else if (!o) problems.push('That sales order does not exist.');
    // Scrap and a return settle what an order left behind, so they are allowed on a finished order.
    else if (['issue', 'receipt'].includes(type) && o.status === 'revised') problems.push(revisedOrderMessage(o.code, o.revision, o.latest_revision));
    else if (['issue', 'receipt'].includes(type) && LOCKED_ORDER_STATUSES.has(o.status)) problems.push(`Order ${o.code} is ${o.status} — nothing more is ${type === 'issue' ? 'issued to' : 'received for'} it.`);
    else order = o;
  }
  let orderLine = null;
  if (!blank(input.orderLineId)) {
    if (!['issue', 'scrap'].includes(type)) problems.push('Only an issue or a scrap names an order line.');
    else if (!order) problems.push('Name the sales order the line belongs to.');
    else {
      const [[ln]] = await db.query('SELECT id, line_no FROM cf_sales_order_lines WHERE company_id = ? AND id = ? AND order_id = ? AND deleted_at IS NULL', [c.companyId, Number(input.orderLineId), order.id]);
      if (!ln) problems.push(`That line is not on order ${order.code}.`);
      else orderLine = ln;
    }
  }
  const reason = blank(input.reason) ? null : String(input.reason).trim().slice(0, 255);
  if (type === 'adjustment' && !reason) problems.push('Say why the stock changes — a count, damage found, a correction.');
  if (type === 'scrap' && !reason) problems.push('Say why it is scrapped.');
  let returnKg = null;
  if (!blank(input.returnKg)) {
    const k = Number(input.returnKg);
    if (type !== 'return') problems.push('Only a return hands scrap back by weight.');
    else if (!Number.isFinite(k) || k <= 0 || k >= 1e11) problems.push('The scrap weight is a number of kilograms above zero.');
    else returnKg = Number(k.toFixed(3));
  }
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const headerOnly = type === 'return' && opts.allowEmpty === true && !lines.length;
  if (!lines.length && !headerOnly) problems.push('Add at least one line.');
  if (lines.length > 200) problems.push('Up to 200 lines per movement.');

  // Whose a receipt is: a customer party (not also a supplier) or an order named
  // on the receipt makes every line that customer's material.
  const owners = {
    order,
    party,
    defaultPartyId: type === 'receipt'
      ? (blank(input.ownerPartyId) ? (party && Number(party.is_customer) && !Number(party.is_supplier) ? party.id : null) : input.ownerPartyId)
      : null,
    defaultOrderId: type === 'receipt' ? (blank(input.ownerOrderId) ? (order?.id ?? null) : input.ownerOrderId) : null,
    /** { partyId, orderId, party, order } — or undefined after saying why not. */
    async resolve(partyId, orderId, P) {
      let o = null;
      if (!blank(orderId)) {
        o = await loadOrder(orderId);
        if (!o) { P('that sales order does not exist.'); return undefined; }
        if (o.status === 'revised') { P(revisedOrderMessage(o.code, o.revision, o.latest_revision)); return undefined; }
        if (LOCKED_ORDER_STATUSES.has(o.status)) { P(`order ${o.code} is ${o.status} — no more material is received for it.`); return undefined; }
        if (!o.customer_id) { P(`order ${o.code} has no customer — only a customer supplies material for an order.`); return undefined; }
      }
      const pid = blank(partyId) ? o?.customer_id : Number(partyId);
      const p = await loadParty(pid);
      if (!p) { P('that customer does not exist.'); return undefined; }
      if (!Number(p.is_customer)) { P(`${p.name} is not marked as a customer — only a customer's material is kept as theirs.`); return undefined; }
      if (o && Number(o.customer_id) !== Number(p.id)) { P(`order ${o.code} is not ${p.name}'s.`); return undefined; }
      return { partyId: p.id, orderId: o?.id ?? null, party: p, order: o };
    },
  };

  const header = { fromAreaId: input.fromAreaId, toAreaId: input.toAreaId, areaId: input.areaId };
  const getArea = areaReader(db, c.companyId, problems);
  const plans = [];
  for (const [i, l] of lines.slice(0, 200).entries()) {
    const p = await planLine(db, c, type, l ?? {}, i + 1, header, getArea, problems, { fromProduction, owners });
    if (p) plans.push(p);
  }
  // The party a return goes to, and a customer receipt's party, default to the lots' one owner.
  const ownersSeen = new Set(plans.map((p) => (type === 'return' ? p.batch?.owner_party_id : p.owner?.partyId)).filter((x) => x != null).map(Number));
  if (type === 'return' && !party) {
    if (ownersSeen.size > 1) problems.push('A return goes to one customer — these lots belong to more than one.');
    else if (ownersSeen.size === 1) party = await loadParty([...ownersSeen][0]);
    else if (headerOnly) problems.push('Say which customer it goes back to.');
  }
  if (type === 'receipt' && !party && ownersSeen.size === 1) party = await loadParty([...ownersSeen][0]);
  if (type === 'return' && !reason) problems.push('Say why it goes back — offcuts, unused plate, scrap.');
  assertNoProblems(problems, 'The movement cannot be posted.');

  // A count becomes the change it needs; lines that already match record nothing.
  for (const p of plans) {
    if (p.counted == null) continue;
    const have = await balanceOf(db, c.companyId, p.legs[0].area.id, p.item.id, p.batch?.id, true);
    p.quantity = round6(p.counted - have);
  }
  const moving = plans.filter((p) => Math.abs(p.quantity) > EPS);
  if (!moving.length && !headerOnly) throw invalid('NOTHING_CHANGES', 'The counted quantities match what is recorded — nothing to adjust.');

  const legs = moving.flatMap((p) => p.legs.map((leg) => ({
    area: leg.area, item: p.item, batch: p.batch, newBatch: p.newBatch, delta: round6(leg.sign * p.quantity),
  })));
  await assertEnough(db, c.companyId, legs);
  if (type !== 'adjustment') await assertReservationsKept(db, c.companyId, legs);
  const pools = await loadPools(db, c.companyId, moving.filter(isLoose).map((p) => p.item.id));
  costPlans(type, moving, pools);

  // A customer receipt names the order it came for, when every line says the same one.
  const receiptOrders = new Set(moving.map((p) => p.owner?.orderId).filter((x) => x != null));
  const movementOrder = order ?? (type === 'receipt' && receiptOrders.size === 1 ? { id: [...receiptOrders][0] } : null);
  const code = await movementCode(db, c, type, input, moving[0]?.legs[0]?.area?.id ?? null);
  const [r] = await db.query(
    `INSERT INTO cf_stock_movements (company_id, code, movement_type, movement_date, party_id, order_id, order_line_id, reference, reason, notes, return_kg, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, code, type, date, party?.id ?? null, movementOrder?.id ?? null, orderLine?.id ?? null,
      blank(input.reference) ? null : String(input.reference).trim().slice(0, 100), reason, blank(input.notes) ? null : String(input.notes), returnKg, c.userId],
  );
  const movementId = r.insertId;
  if (!code) await db.query('UPDATE cf_stock_movements SET code = ? WHERE id = ?', [`${PREFIX[type]}-${String(movementId).padStart(6, '0')}`, movementId]);

  for (const p of moving) {
    if (p.newBatch) {
      const batchId = await createBatch(db, c, p.item, {
        ...p.newBatch,
        supplierId: party && Number(party.is_supplier) && !p.owner ? party.id : null,
        receivedOn: date,
        ownerPartyId: p.owner?.partyId ?? null,
        ownerOrderId: p.owner?.orderId ?? null,
        unitCost: p.unitCost,
      });
      p.batch = await requireBatch(db, c.companyId, batchId);
    } else if (p.batchCost !== undefined) {
      await db.query('UPDATE cf_stock_batches SET unit_cost = ? WHERE company_id = ? AND id = ?', [p.batchCost, c.companyId, p.batch.id]);
    }
    for (const leg of p.legs) {
      await writeLeg(db, c, { movementId, lineNo: p.lineNo, area: leg.area, item: p.item, batch: p.batch, delta: round6(leg.sign * p.quantity), notes: p.notes, unitCost: leg.unitCost, value: leg.value });
    }
  }
  await savePools(db, c.companyId, pools, movementId);
  return getMovement(db, c.companyId, movementId);
}

/* ---- cost ------------------------------------------------------------------------- */

/** Loose stock (no lot) is the weighted-average pool's; a lot keeps its own cost. */
const isLoose = (p) => !p.batch && !p.newBatch;

/** The average of every item's loose stock, locked until the transaction ends. One read. */
async function loadPools(db, companyId, itemIds) {
  const ids = [...new Set(itemIds)];
  const pools = new Map(ids.map((id) => [id, { id: null, avg: null, qty: 0, changed: false }]));
  if (!ids.length) return pools;
  const [rows] = await db.query(
    'SELECT id, item_id, avg_unit_cost, costed_qty FROM cf_item_costs WHERE company_id = ? AND owner_key = 0 AND item_id IN (?) FOR UPDATE',
    [companyId, ids],
  );
  for (const r of rows) pools.set(r.item_id, { id: r.id, avg: numOrNull(r.avg_unit_cost), qty: Number(r.costed_qty), changed: false });
  return pools;
}

/** Costed stock in: the average takes it in by value. Not-costed stock in changes nothing. */
function poolIn(pool, qty, value) {
  if (value == null || qty <= EPS) return;
  const total = pool.qty * (pool.avg ?? 0) + value;
  pool.qty = round6(pool.qty + qty);
  if (pool.qty > EPS) pool.avg = round4(Math.max(0, total) / pool.qty);
  pool.changed = true;
}

/** Costed stock out (value negative): the average keeps what is left; the costed quantity falls. */
function poolOut(pool, qty, value) {
  if (value == null || qty <= EPS) return;
  const total = pool.qty * (pool.avg ?? 0) + value;
  pool.qty = round6(Math.max(0, pool.qty - qty));
  if (pool.qty > EPS) pool.avg = round4(Math.max(0, total) / pool.qty);
  pool.changed = true;
}

/** What loose stock leaves at: the average while any costed stock is left, else not costed. */
const poolCost = (pool) => (pool.avg != null && pool.qty > EPS ? pool.avg : null);

/**
 * Works out every leg's unit cost and value (signed like its quantity), and
 * what the movement does to lot costs and averages. Pure but for `pools`.
 *   receipt   the typed cost (or, into an existing lot, the lot's); a lot's
 *             cost becomes the weighted average of what it held and what came
 *   transfer  both legs at the stock's cost — the average is untouched
 *   issue, scrap, return, a count down   out at the lot's cost / the average
 *   a count up   loose stock at the average (it joins the average's quantity)
 */
function costPlans(type, moving, pools) {
  for (const p of moving) {
    const q = p.quantity;
    let unit;
    if (type === 'receipt') {
      unit = p.unitCost ?? (p.batch ? numOrNull(p.batch.unit_cost) : null);
      if (p.batch && p.unitCost != null) {
        const held = Math.max(0, Number(p.batch.on_hand ?? 0));
        const was = numOrNull(p.batch.unit_cost);
        const next = was == null || held <= EPS ? p.unitCost : round4((held * was + q * p.unitCost) / (held + q));
        if (next !== was) p.batchCost = next;
      }
    } else if (isLoose(p)) {
      const pool = pools.get(p.item.id);
      unit = type === 'adjustment' && q > 0 ? pool.avg : poolCost(pool);
    } else unit = numOrNull(p.batch.unit_cost);
    for (const leg of p.legs) {
      leg.unitCost = unit;
      leg.value = unit == null ? null : round2(leg.sign * q * unit);
    }
    if (isLoose(p) && type !== 'transfer') {
      // Which way the stock went: + into our shelves (receipt, a count up), - out.
      const pool = pools.get(p.item.id);
      const net = round6(p.legs.reduce((t, l) => t + l.sign, 0) * q);
      const value = unit == null ? null : round2(net * unit);
      if (net > 0) poolIn(pool, net, value);
      else poolOut(pool, -net, value);
    }
  }
}

/** Writes the averages a movement changed. One statement. */
async function savePools(db, companyId, pools, movementId) {
  const rows = [...pools.entries()].filter(([, p]) => p.changed);
  if (!rows.length) return;
  await db.query(
    `INSERT INTO cf_item_costs (company_id, item_id, owner_party_id, avg_unit_cost, costed_qty, last_movement_id) VALUES ?
     ON DUPLICATE KEY UPDATE avg_unit_cost = VALUES(avg_unit_cost), costed_qty = VALUES(costed_qty), last_movement_id = VALUES(last_movement_id)`,
    [rows.map(([itemId, p]) => [companyId, itemId, null, p.avg, p.qty, movementId])],
  );
}

async function writeLeg(db, c, { movementId, lineNo, area, item, batch, delta, notes, unitCost = null, value = null }) {
  await db.query(
    `INSERT INTO cf_stock_ledger (company_id, movement_id, line_no, stocking_area_id, item_id, batch_id, quantity, unit_cost, value, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, movementId, lineNo, area.id, item.id, batch?.id ?? null, delta, unitCost, value, notes ?? null, c.userId],
  );
  await applyDelta(db, c, { area, item, batch, delta, movementId });
}

async function requireMovement(db, companyId, id) {
  const [[m]] = await db.query('SELECT * FROM cf_stock_movements WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!m) throw notFound('Movement');
  return m;
}

/**
 * Undoes a movement with its exact opposite, dated today — the same cost, the
 * opposite value, and the average moved back by that value. Refused if the
 * stock it put somewhere has since moved on.
 */
export async function reverseMovement(db, c, id, { reason } = {}) {
  const m = await requireMovement(db, c.companyId, id);
  if (m.reversal_of_id) throw invalid('IS_REVERSAL', `${m.code} is itself a reversal — post the movement again instead.`);
  if (m.reversed_by_id) {
    const [[rev]] = await db.query('SELECT code FROM cf_stock_movements WHERE id = ?', [m.reversed_by_id]);
    throw invalid('ALREADY_REVERSED', `${m.code} was already reversed by ${rev?.code ?? 'another movement'}.`);
  }
  if (blank(reason)) throw invalid('INVALID', 'Say why it is reversed.');
  const [[{ back }]] = await db.query('SELECT COUNT(*) AS back FROM cf_offcuts WHERE company_id = ? AND returned_movement_id = ? AND deleted_at IS NULL', [c.companyId, m.id]);
  if (Number(back)) throw invalid('HAS_OFFCUTS', `${m.code} handed offcuts back to the customer — a return with offcuts is not reversed.`);
  const [rows] = await db.query('SELECT * FROM cf_stock_ledger WHERE company_id = ? AND movement_id = ? AND deleted_at IS NULL ORDER BY line_no, id', [c.companyId, m.id]);
  const areas = new Map();
  const legs = [];
  for (const row of rows) {
    if (!areas.has(row.stocking_area_id)) areas.set(row.stocking_area_id, await requireArea(db, c.companyId, row.stocking_area_id));
    legs.push({
      row, area: areas.get(row.stocking_area_id), item: await loadMaster(db, c.companyId, row.item_id),
      batch: row.batch_id ? await requireBatch(db, c.companyId, row.batch_id) : null, delta: round6(-Number(row.quantity)),
      unitCost: numOrNull(row.unit_cost), value: row.value == null ? null : round2(-Number(row.value)),
    });
  }
  /*
   * A RECEIPT ON A PURCHASE LINE (§56): what it did on arrival is undone first — the share of it still
   * held for the sales order is let go, the purchase line and its shares get their received quantity
   * back down (so the requisition shows it as still coming and production waits for the PO date again).
   * Refused there, naming the order, only when the stock is reserved for production or already issued.
   */
  let unreceived = null;
  if (m.movement_type === 'receipt' && m.purchase_line_id) {
    const byLot = new Map();
    for (const l of legs) {
      if (l.delta >= 0) continue;
      const k = `${l.item.id}:${l.batch?.id ?? 0}`;
      const e = byLot.get(k) ?? { itemId: l.item.id, batchId: l.batch?.id ?? null, quantity: 0, label: label(l.item, l.batch) };
      e.quantity = round6(e.quantity - l.delta);
      byLot.set(k, e);
    }
    unreceived = await unreceive(db, c, m, [...byLot.values()]);
  }
  // The stock it put somewhere must still be there to take back — and not be reserved.
  await assertEnough(db, c.companyId, legs);
  if (m.movement_type !== 'adjustment') await assertReservationsKept(db, c.companyId, legs);
  const pools = await loadPools(db, c.companyId, legs.filter((l) => !l.batch).map((l) => l.item.id));
  if (m.movement_type !== 'transfer') {
    for (const l of legs) {
      if (l.batch) continue;
      if (l.delta > 0) poolIn(pools.get(l.item.id), l.delta, l.value);
      else poolOut(pools.get(l.item.id), -l.delta, l.value);
    }
  }
  const [r] = await db.query(
    `INSERT INTO cf_stock_movements (company_id, code, movement_type, movement_date, party_id, order_id, order_line_id, reference, reason, reversal_of_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, `REV-${m.code}`.slice(0, 60), m.movement_type, todayText(), m.party_id, m.order_id, m.order_line_id ?? null, m.reference,
      String(reason).trim().slice(0, 255), m.id, c.userId],
  );
  const revId = r.insertId;
  for (const l of legs) {
    await writeLeg(db, c, { movementId: revId, lineNo: l.row.line_no, area: l.area, item: l.item, batch: l.batch, delta: l.delta, notes: l.row.notes, unitCost: l.unitCost, value: l.value });
  }
  await savePools(db, c.companyId, pools, revId);
  await db.query('UPDATE cf_stock_movements SET reversed_by_id = ? WHERE company_id = ? AND id = ?', [revId, c.companyId, m.id]);
  const out = await getMovement(db, c.companyId, revId);
  if (!unreceived) return out;
  // What the reversal did to buying and to the plan (TM/CF_ERP_BUYING_V2.md §3): holds let go, and the planned cards now late / waiting.
  const { plannedUnitsOfOrders } = await import('./plannerService.js');
  const orderIds = [...new Set(unreceived.released.map((r) => r.orderId))];
  return { ...out, purchase: { ...unreceived, plannedUnits: { orderIds, ...(await plannedUnitsOfOrders(db, c.companyId, orderIds)) } } };
}


// --- reading ------------------------------------------------------------------------

const MOVEMENT_SELECT = `SELECT m.*, p.code AS party_code, p.name AS party_name, o.code AS order_code,
       ro.code AS reversal_of_code, rb.code AS reversed_by_code,
       (SELECT COUNT(DISTINCT l.line_no) FROM cf_stock_ledger l WHERE l.company_id = m.company_id AND l.movement_id = m.id) AS line_count,
       (SELECT GROUP_CONCAT(DISTINCT a.code ORDER BY a.code SEPARATOR ', ') FROM cf_stock_ledger l JOIN cf_stocking_areas a ON a.id = l.stocking_area_id
         WHERE l.company_id = m.company_id AND l.movement_id = m.id) AS area_codes,
       (SELECT GROUP_CONCAT(DISTINCT r.code ORDER BY r.code SEPARATOR ', ') FROM cf_stock_ledger l JOIN cf_master_records r ON r.id = l.item_id
         WHERE l.company_id = m.company_id AND l.movement_id = m.id) AS item_codes,
       (SELECT SUM(ABS(l.value)) FROM cf_stock_ledger l WHERE l.company_id = m.company_id AND l.movement_id = m.id) AS abs_value,
       (SELECT SUM(l.value IS NULL) FROM cf_stock_ledger l WHERE l.company_id = m.company_id AND l.movement_id = m.id) AS uncosted_rows,
       ol.line_no AS order_line_no
  FROM cf_stock_movements m
  LEFT JOIN cf_parties p ON p.id = m.party_id
  LEFT JOIN cf_sales_orders o ON o.id = m.order_id
  LEFT JOIN cf_sales_order_lines ol ON ol.id = m.order_line_id
  LEFT JOIN cf_stock_movements ro ON ro.id = m.reversal_of_id
  LEFT JOIN cf_stock_movements rb ON rb.id = m.reversed_by_id`;

function shapeMovement(m) {
  return {
    id: m.id,
    code: m.code,
    movementType: m.movement_type,
    movementDate: dateOnly(m.movement_date),
    party: m.party_id ? { id: m.party_id, code: m.party_code, name: m.party_name } : null,
    order: m.order_id ? { id: m.order_id, code: m.order_code } : null,
    orderLine: m.order_line_id ? { id: m.order_line_id, lineNo: m.order_line_no ?? null } : null,
    // What it moved, at cost (a transfer's two legs counted once). null = nothing
    // in it is costed; `uncostedRows` says how many ledger rows have no cost.
    value: m.abs_value == null ? null : round2(Number(m.abs_value) / (m.movement_type === 'transfer' ? 2 : 1)),
    uncostedRows: Number(m.uncosted_rows ?? 0),
    currency: 'INR',
    returnKg: m.return_kg == null ? null : Number(m.return_kg),
    reference: m.reference,
    reason: m.reason,
    notes: m.notes,
    reversalOf: m.reversal_of_id ? { id: m.reversal_of_id, code: m.reversal_of_code } : null,
    reversedBy: m.reversed_by_id ? { id: m.reversed_by_id, code: m.reversed_by_code } : null,
    lineCount: Number(m.line_count ?? 0),
    areaCodes: m.area_codes ?? '',
    itemCodes: m.item_codes ?? '',
    createdAt: m.created_at,
  };
}

const MOVEMENT_SORT = { code: 'm.code', type: 'm.movement_type', date: 'm.movement_date', reference: 'm.reference' };

/** Movement filters; `skip` leaves one facet out so its chip counts the others. */
function movementWhere(companyId, q, skip = []) {
  const where = ['m.company_id = ?', 'm.deleted_at IS NULL'];
  const params = [companyId];
  if (!skip.includes('type') && !blank(q.type)) { where.push('m.movement_type = ?'); params.push(q.type); }
  if (!blank(q.from)) { where.push('m.movement_date >= ?'); params.push(q.from); }
  if (!blank(q.to)) { where.push('m.movement_date <= ?'); params.push(q.to); }
  if (!blank(q.orderId)) { where.push('m.order_id = ?'); params.push(Number(q.orderId)); }
  for (const [key, col] of [['areaId', 'stocking_area_id'], ['itemId', 'item_id'], ['batchId', 'batch_id']]) {
    if (!blank(q[key])) {
      where.push(`EXISTS (SELECT 1 FROM cf_stock_ledger l WHERE l.company_id = m.company_id AND l.movement_id = m.id AND l.${col} = ?)`);
      params.push(Number(q[key]));
    }
  }
  if (!blank(q.search)) {
    where.push('(m.code LIKE ? OR m.reference LIKE ? OR p.name LIKE ? OR o.code LIKE ?)');
    const s = like(q.search);
    params.push(s, s, s, s);
  }
  return { where: where.join(' AND '), params };
}
const MOVEMENT_FROM = 'FROM cf_stock_movements m LEFT JOIN cf_parties p ON p.id = m.party_id LEFT JOIN cf_sales_orders o ON o.id = m.order_id';

/**
 * Movements, newest first. Without paged=1 / all=1: the old bare array (default
 * 200, at most 500). With paged=1: { rows, total, counts: { types, month,
 * receipts, reversed } } — the type chips count every filter but the type; the
 * stats count every filter.
 */
export async function listMovements(db, companyId, q = {}) {
  if (!wantsPage(q)) {
    const { where, params } = movementWhere(companyId, q);
    const limit = Math.min(Number(q.limit) || 200, 500);
    const [rows] = await db.query(`${MOVEMENT_SELECT} WHERE ${where} ORDER BY m.movement_date DESC, m.id DESC LIMIT ${limit}`, params);
    return rows.map(shapeMovement);
  }
  const page = pageArgs(q, { def: 100 });
  const all = movementWhere(companyId, q);
  const noType = movementWhere(companyId, q, ['type']);
  const month = /^\d{4}-\d{2}$/.test(String(q.month ?? '')) ? String(q.month) : todayText().slice(0, 7);
  const order = orderBy(q, MOVEMENT_SORT, 'm.movement_date DESC, m.id DESC', 'm.id DESC');
  const [[rows], [[stat]], [typeRows]] = await Promise.all([
    db.query(`${MOVEMENT_SELECT} WHERE ${all.where} ORDER BY ${order} LIMIT ${page.limit} OFFSET ${page.offset}`, all.params),
    db.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(DATE_FORMAT(m.movement_date, '%Y-%m') = ?), 0) AS month,
              COALESCE(SUM(m.movement_type = 'receipt' AND m.reversal_of_id IS NULL), 0) AS receipts,
              COALESCE(SUM(m.reversed_by_id IS NOT NULL), 0) AS reversed
         ${MOVEMENT_FROM} WHERE ${all.where}`, [month, ...all.params]),
    db.query(`SELECT m.movement_type AS k, COUNT(*) AS n ${MOVEMENT_FROM} WHERE ${noType.where} GROUP BY m.movement_type`, noType.params),
  ]);
  const types = countsBy(typeRows, MOVEMENT_TYPES);
  const counts = { types: { ...types, all: Object.values(types).reduce((t, n) => t + n, 0) }, month: Number(stat.month), receipts: Number(stat.receipts), reversed: Number(stat.reversed) };
  return pageOf(rows.map(shapeMovement), stat.total, page, { counts });
}

/** A movement with its lines: each line's item, batch, the area it left and the area it reached. */
export async function getMovement(db, companyId, id) {
  const [[m]] = await db.query(`${MOVEMENT_SELECT} WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL`, [companyId, Number(id)]);
  if (!m) throw notFound('Movement');
  const out = shapeMovement(m);
  const [rows] = await db.query(
    `SELECT l.*, r.code AS item_code, r.name AS item_name, i.uom, b.code AS batch_code, b.status AS batch_status,
            b.owner_party_id, b.owner_order_id, op.code AS owner_party_code, op.name AS owner_party_name, oo.code AS owner_order_code,
            a.code AS area_code, a.name AS area_name, a.purpose
       FROM cf_stock_ledger l
       JOIN cf_master_records r ON r.id = l.item_id
       JOIN cf_item_details i ON i.master_id = l.item_id
       JOIN cf_stocking_areas a ON a.id = l.stocking_area_id
       LEFT JOIN cf_stock_batches b ON b.id = l.batch_id
       LEFT JOIN cf_parties op ON op.id = b.owner_party_id
       LEFT JOIN cf_sales_orders oo ON oo.id = b.owner_order_id
      WHERE l.company_id = ? AND l.movement_id = ? ORDER BY l.line_no, l.quantity, l.id`,
    [companyId, m.id],
  );
  const lines = new Map();
  for (const r of rows) {
    const line = lines.get(r.line_no) ?? {
      lineNo: r.line_no,
      item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom },
      batch: r.batch_id ? { id: r.batch_id, code: r.batch_code, status: r.batch_status } : null,
      owner: r.batch_id ? ownerOf(r) : null,
      from: null, to: null, quantity: 0, change: 0, notes: r.notes,
      // The cost it moved at and the value (magnitude, like quantity); null = not costed.
      unitCost: numOrNull(r.unit_cost), value: null, valueChange: 0,
    };
    const area = { id: r.stocking_area_id, code: r.area_code, name: r.area_name, purpose: r.purpose };
    const q = Number(r.quantity);
    if (q < 0) line.from = area; else line.to = area;
    line.quantity = Math.max(line.quantity, Math.abs(q));
    line.change += q;
    if (r.value != null) {
      line.value = Math.max(line.value ?? 0, Math.abs(Number(r.value)));
      line.valueChange += Number(r.value);
    }
    lines.set(r.line_no, line);
  }
  out.lines = [...lines.values()].map((l) => ({ ...l, change: round6(l.change), valueChange: l.value == null ? null : round2(l.valueChange) }));
  return out;
}

const STOCK_SELECT = `SELECT k.*, a.code AS area_code, a.name AS area_name, a.purpose, a.status AS area_status,
       r.code AS item_code, r.name AS item_name, i.uom, i.tracked_by, b.code AS batch_code, b.status AS batch_status,
       b.unit_cost AS batch_unit_cost, b.owner_party_id, b.owner_order_id,
       op.code AS owner_party_code, op.name AS owner_party_name, oo.code AS owner_order_code
  FROM cf_stock_balances k
  JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
  JOIN cf_master_records r ON r.id = k.item_id
  JOIN cf_item_details i ON i.master_id = k.item_id
  LEFT JOIN cf_stock_batches b ON b.id = k.batch_id
  LEFT JOIN cf_parties op ON op.id = b.owner_party_id
  LEFT JOIN cf_sales_orders oo ON oo.id = b.owner_order_id`;
const STOCK_FROM = STOCK_SELECT.slice(STOCK_SELECT.indexOf('FROM cf_stock_balances k'));

function shapeStock(k) {
  return {
    area: { id: k.stocking_area_id, code: k.area_code, name: k.area_name, purpose: k.purpose },
    item: { id: k.item_id, code: k.item_code, name: k.item_name, uom: k.uom, trackedBy: k.tracked_by },
    batch: k.batch_id ? { id: k.batch_id, code: k.batch_code, status: k.batch_status } : null,
    owner: k.batch_id ? ownerOf(k) : null,               // null = ours
    quantity: Number(k.quantity),
    category: categoryOf(k.purpose, k.batch_status),
    ...(k._money ?? { unitCost: null, value: null, uncostedQty: Number(k.quantity) }),
    updatedAt: k.updated_at,
  };
}

/**
 * The value of balance rows, at cost — in place on each row as `_money`
 * ({ unitCost, value, uncostedQty }). A lot at its own cost; loose stock at
 * the item's average, over the share of it the average covers (costed_qty
 * divided by all loose stock of the item, every area), the rest `uncostedQty`
 * — not costed, never 0. Customer lots are valued at the reference cost they
 * came with (callers keep them apart). One read, only when there is loose stock.
 * Rows need item_id, batch_id, quantity and batch_unit_cost.
 */
export async function valueRows(db, companyId, rows) {
  const looseItems = [...new Set(rows.filter((k) => !k.batch_id).map((k) => k.item_id))];
  const pools = new Map();
  if (looseItems.length) {
    const [p] = await db.query(
      `SELECT c.item_id, c.avg_unit_cost, c.costed_qty,
              (SELECT COALESCE(SUM(k.quantity), 0) FROM cf_stock_balances k
                WHERE k.company_id = c.company_id AND k.item_id = c.item_id AND k.batch_id IS NULL) AS loose
         FROM cf_item_costs c WHERE c.company_id = ? AND c.owner_key = 0 AND c.item_id IN (?)`,
      [companyId, looseItems],
    );
    for (const r of p) pools.set(r.item_id, { avg: numOrNull(r.avg_unit_cost), costed: Number(r.costed_qty), loose: Number(r.loose) });
  }
  for (const k of rows) {
    const q = Number(k.quantity);
    if (k.batch_id) {
      const u = numOrNull(k.batch_unit_cost);
      k._money = { unitCost: u, value: u == null ? null : round2(q * u), uncostedQty: u == null ? round6(q) : 0 };
      continue;
    }
    const pool = pools.get(k.item_id);
    if (!pool || pool.avg == null || pool.costed <= EPS) { k._money = { unitCost: null, value: null, uncostedQty: round6(q) }; continue; }
    const share = pool.loose > EPS ? Math.min(1, pool.costed / pool.loose) : 1;
    k._money = { unitCost: pool.avg, value: round2(q * share * pool.avg), uncostedQty: round6(q * (1 - share)) };
  }
  return rows;
}

/** What sits where. q: { areaId?, itemId?, batchId?, purpose?, owner? (ours | customer | party id), search?, includeZero? } */
/** What a balance row counts as, in SQL — the same rule as categoryOf. */
const CATEGORY_SQL = `(CASE WHEN b.status = 'rejected' THEN 'rejected' WHEN b.status = 'on_hold' OR a.purpose = 'quarantine' THEN 'held'
  WHEN a.purpose = 'wip' THEN 'in_process' WHEN a.purpose = 'dispatch' THEN 'dispatch' ELSE 'available' END)`;
const STOCK_SORT = { item: 'r.code', area: 'a.code', batch: 'b.code', owner: 'op.name', qty: 'k.quantity', category: CATEGORY_SQL, updated: 'k.updated_at' };

/** Stock filters; `skip` leaves facets out ('category', 'owner') so a chip counts the others. */
function stockWhere(companyId, q, skip = []) {
  const where = ['k.company_id = ?'];
  const params = [companyId];
  if (String(q.includeZero) !== '1') where.push('k.quantity <> 0');
  if (!blank(q.areaId)) { where.push('k.stocking_area_id = ?'); params.push(Number(q.areaId)); }
  if (!blank(q.itemId)) { where.push('k.item_id = ?'); params.push(Number(q.itemId)); }
  if (!blank(q.batchId)) { where.push('k.batch_id = ?'); params.push(Number(q.batchId)); }
  if (!blank(q.purpose)) { where.push('a.purpose = ?'); params.push(q.purpose); }
  if (!skip.includes('category') && !blank(q.category)) { where.push(`${CATEGORY_SQL} = ?`); params.push(q.category); }
  if (!skip.includes('owner')) {
    if (q.owner === 'ours') where.push('b.owner_party_id IS NULL');
    else if (q.owner === 'customer') where.push('b.owner_party_id IS NOT NULL');
    else if (!blank(q.owner) && Number.isInteger(Number(q.owner))) { where.push('b.owner_party_id = ?'); params.push(Number(q.owner)); }
  }
  if (!blank(q.search)) {
    where.push('(r.code LIKE ? OR r.name LIKE ? OR b.code LIKE ?)');
    const s = like(q.search);
    params.push(s, s, s);
  }
  return { where: where.join(' AND '), params };
}

/**
 * What sits where. q: { areaId?, itemId?, batchId?, purpose?, category?, owner? (ours | customer | party id), search?, includeZero? }.
 * Without paged=1 / all=1: the old bare array (at most `limit` rows; null = every row).
 * With paged=1: { rows, total, counts } — `counts` holds what the screen's chips
 * and stats show, all over every matching row, not the page:
 *   categories  per "counts as" (every filter but the category) + all
 *   owners      { ours, parties: [{ id, name, code, n }] } (every filter but the owner)
 *   stats       { lines, items, areas, cannotUse } over every filter
 *   held        customer material per party and unit, over the search + area only
 */
export async function listStock(db, companyId, q = {}, { limit = 2000 } = {}) {
  if (!wantsPage(q)) {
    const { where, params } = stockWhere(companyId, q);
    const [rows] = await db.query(`${STOCK_SELECT} WHERE ${where} ORDER BY r.code, a.code, b.code${limit ? ` LIMIT ${Number(limit)}` : ''}`, params);
    await valueRows(db, companyId, rows);
    return rows.map(shapeStock);
  }
  const page = pageArgs(q, { def: 100 });
  const all = stockWhere(companyId, q);
  const noCat = stockWhere(companyId, q, ['category']);
  const noOwner = stockWhere(companyId, q, ['owner']);
  const base = stockWhere(companyId, q, ['category', 'owner']);
  const order = orderBy(q, STOCK_SORT, 'r.code, a.code, b.code, k.id', 'r.code, a.code, b.code, k.id');
  const [[rows], [[stat]], [catRows], [ownerRows], [heldRows]] = await Promise.all([
    db.query(`${STOCK_SELECT} WHERE ${all.where} ORDER BY ${order} LIMIT ${page.limit} OFFSET ${page.offset}`, all.params),
    db.query(
      `SELECT COUNT(*) AS n_lines, COUNT(DISTINCT k.item_id) AS items, COUNT(DISTINCT k.stocking_area_id) AS areas,
              COALESCE(SUM(${CATEGORY_SQL} IN ('held', 'rejected')), 0) AS cannot_use ${STOCK_FROM} WHERE ${all.where}`, all.params),
    db.query(`SELECT ${CATEGORY_SQL} AS cat, COUNT(*) AS n ${STOCK_FROM} WHERE ${noCat.where} GROUP BY cat`, noCat.params),
    db.query(
      `SELECT b.owner_party_id AS pid, MAX(op.name) AS name, MAX(op.code) AS code, COUNT(*) AS n ${STOCK_FROM} WHERE ${noOwner.where} GROUP BY b.owner_party_id`, noOwner.params),
    db.query(
      `SELECT b.owner_party_id AS pid, MAX(op.name) AS name, MAX(op.code) AS code, i.uom AS uom, COUNT(*) AS n, SUM(k.quantity) AS qty
         ${STOCK_FROM} WHERE ${base.where} AND b.owner_party_id IS NOT NULL GROUP BY b.owner_party_id, i.uom`, base.params),
  ]);
  const categories = countsBy(catRows, CATEGORIES, 'cat');
  const ours = ownerRows.filter((r) => r.pid == null).reduce((t, r) => t + Number(r.n), 0);
  const parties = ownerRows.filter((r) => r.pid != null).map((r) => ({ id: r.pid, name: r.name ?? null, code: r.code ?? null, n: Number(r.n) }))
    .sort((x, y) => String(x.name ?? x.code ?? '').localeCompare(String(y.name ?? y.code ?? '')));
  const counts = {
    categories: { ...categories, all: Object.values(categories).reduce((t, n) => t + n, 0) },
    owners: { ours, parties },
    stats: { lines: Number(stat.n_lines), items: Number(stat.items), areas: Number(stat.areas), cannotUse: Number(stat.cannot_use) },
    held: heldRows.map((r) => ({ partyId: r.pid, name: r.name ?? r.code ?? 'Customer', uom: r.uom, lines: Number(r.n), quantity: Number(r.qty) })),
  };
  await valueRows(db, companyId, rows);
  return pageOf(rows.map(shapeStock), stat.n_lines, page, { counts });
}

const CATEGORIES = ['available', 'in_process', 'held', 'rejected', 'dispatch'];
const summarise = (rows) => {
  const totals = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
  for (const r of rows) totals[r.category] = round6(totals[r.category] + r.quantity);
  return { onHand: round6(rows.reduce((t, r) => t + r.quantity, 0)), ...totals };
};
/** Value of rows: what is costed, and how much has no cost (quantity). */
const moneyOf = (rows) => ({
  value: round2(rows.reduce((t, r) => t + (r.value ?? 0), 0)),
  uncostedQty: round6(rows.reduce((t, r) => t + (r.uncostedQty ?? 0), 0)),
  currency: 'INR',
});

/**
 * One item's stock: totals by what it counts as, every area and batch holding
 * it, and its latest movements. The category totals count everything on our
 * shelves; `free`, `value` and `uncostedQty` are OURS only — a customer's
 * material never counts as ours (`customers` holds theirs, valued at the
 * reference cost it came with).
 */
export async function itemStock(db, companyId, itemId) {
  const item = await loadMaster(db, companyId, Number(itemId));
  if (!item || item.record_kind !== 'item') throw notFound('Item');
  const rows = await listStock(db, companyId, { itemId: item.id }, { limit: null });
  const [res] = await db.query(
    `SELECT v.id, v.quantity, v.batch_id, b.code AS batch_code, b.status AS batch_status, b.owner_party_id,
            IF(v.held_for_order_id IS NOT NULL, 'held', IF(v.order_line_id IS NULL, 'material', 'finished')) AS kind,
            o.id AS order_id, o.code AS order_code, COALESCE(l.line_no, dl.line_no) AS line_no,
            hp.id AS po_id, hp.code AS po_code
       FROM cf_stock_reservations v
       LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
       LEFT JOIN cf_material_requirements q ON q.id = v.requirement_id
       LEFT JOIN cf_production_releases r ON r.id = q.release_id
       LEFT JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       LEFT JOIN cf_sales_order_lines dl ON dl.id = v.order_line_id
       LEFT JOIN cf_purchase_order_lines hl ON hl.id = v.purchase_line_id
       LEFT JOIN cf_purchase_orders hp ON hp.id = hl.purchase_order_id
       JOIN cf_sales_orders o ON o.id = COALESCE(r.order_id, dl.order_id, v.held_for_order_id)
      WHERE v.company_id = ? AND v.item_id = ? AND v.status = 'active' AND v.deleted_at IS NULL ORDER BY o.code, line_no, v.id`,
    [companyId, item.id],
  );
  const ours = rows.filter((r) => !r.owner);
  const theirs = rows.filter((r) => r.owner);
  const reservedOf = (list) => round6(list.reduce((t, v) => t + Number(v.quantity), 0));
  const totals = summarise(rows);
  totals.reserved = reservedOf(res);
  const o = summarise(ours);
  totals.free = Math.max(0, round6(o.available + o.in_process - reservedOf(res.filter((v) => !v.owner_party_id))));
  Object.assign(totals, moneyOf(ours));
  const t = summarise(theirs);
  const theirsReserved = reservedOf(res.filter((v) => v.owner_party_id));
  totals.customers = { ...t, reserved: theirsReserved, free: Math.max(0, round6(t.available + t.in_process - theirsReserved)), ...moneyOf(theirs) };
  return {
    item: { id: item.id, code: item.code, name: item.name, uom: item.uom, trackedBy: item.tracked_by, stockable: item.tracked_by !== 'individual' },
    totals,
    rows,
    reservations: res.map((v) => ({
      id: v.id, quantity: Number(v.quantity), batch: v.batch_id ? { id: v.batch_id, code: v.batch_code, status: v.batch_status } : null,
      order: { id: v.order_id, code: v.order_code }, lineNo: v.line_no ?? null, kind: v.kind,
      // A hold (§43): arrived on a PO bought for the order.
      ...(v.kind === 'held' ? { purchaseOrder: v.po_id ? { id: v.po_id, code: v.po_code } : null } : {}),
    })),
    movements: await listMovements(db, companyId, { itemId: item.id, limit: 20 }),
  };
}

/** A stocking area and its inventory. `value` is ours at cost. */
export async function areaInventory(db, companyId, areaId) {
  const area = shapeArea(await requireArea(db, companyId, areaId));
  const rows = await listStock(db, companyId, { areaId: area.id }, { limit: null });
  return { area, totals: { ...summarise(rows), ...moneyOf(rows.filter((r) => !r.owner)) }, rows, movements: await listMovements(db, companyId, { areaId: area.id, limit: 20 }) };
}

/**
 * Checks the balances against the ledger — the ledger is the truth. Returns
 * every (area, item, batch) where they disagree; none is the normal answer.
 */
export async function checkLedger(db, companyId) {
  const [rows] = await db.query(
    `SELECT x.stocking_area_id, x.item_id, x.batch_key, SUM(x.ledger) AS ledger, SUM(x.balance) AS balance
       FROM (SELECT stocking_area_id, item_id, IFNULL(batch_id, 0) AS batch_key, quantity AS ledger, 0 AS balance
               FROM cf_stock_ledger WHERE company_id = ? AND deleted_at IS NULL
             UNION ALL
             SELECT stocking_area_id, item_id, batch_key, 0, quantity FROM cf_stock_balances WHERE company_id = ?) x
      GROUP BY x.stocking_area_id, x.item_id, x.batch_key
     HAVING ABS(SUM(x.ledger) - SUM(x.balance)) > 0.000001`,
    [companyId, companyId],
  );
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_stock_balances WHERE company_id = ?', [companyId]);
  return {
    ok: rows.length === 0,
    checked: Number(n),
    differences: rows.map((r) => ({ areaId: r.stocking_area_id, itemId: r.item_id, batchId: r.batch_key || null, ledger: Number(r.ledger), balance: Number(r.balance) })),
  };
}

/** For the parties module: movements and batches that name a party. */
export async function inventoryPartyReferences(db, companyId, partyId) {
  const [[{ moves }]] = await db.query('SELECT COUNT(*) AS moves FROM cf_stock_movements WHERE company_id = ? AND party_id = ? AND deleted_at IS NULL', [companyId, partyId]);
  const [[{ lots }]] = await db.query('SELECT COUNT(*) AS lots FROM cf_stock_batches WHERE company_id = ? AND supplier_id = ? AND deleted_at IS NULL', [companyId, partyId]);
  const out = [];
  if (Number(moves)) out.push(`it supplied ${moves} receipt${Number(moves) === 1 ? '' : 's'}`);
  if (Number(lots)) out.push(`${lots} batch${Number(lots) === 1 ? '' : 'es'} name it as supplier`);
  return out;
}

/** Whether an item has ever held stock — its unit and tracking are then fixed, and it is never deleted. */
export async function hasStockHistory(db, companyId, itemId) {
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_stock_ledger WHERE company_id = ? AND item_id = ?', [companyId, itemId]);
  return Number(n) > 0;
}
