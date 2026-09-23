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
import { loadMaster, LOCKED_ORDER_STATUSES } from './records.js';
import { requireArea, shapeArea } from './stockingAreaService.js';
import { requireBatch, checkBatchValues, createBatch } from './batchService.js';
import { generate } from '../modules/codegen/index.js';

export const MOVEMENT_TYPES = ['receipt', 'issue', 'transfer', 'adjustment', 'scrap'];
const PREFIX = { receipt: 'GRN', issue: 'ISS', transfer: 'TRF', adjustment: 'ADJ', scrap: 'SCR' };
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EPS = 1e-9;
const round6 = (n) => Number(Number(n).toFixed(6));
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
  material: { purposes: ['storage', 'wip'], where: 'v.requirement_id IS NOT NULL' },
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
         JOIN cf_sales_orders o ON o.id = COALESCE(r.order_id, dl.order_id)
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
async function planLine(db, c, type, l, n, header, getArea, problems, { fromProduction = false } = {}) {
  const P = (msg) => problems.push(`Line ${n}: ${msg}`);
  const item = await stockItem(db, c.companyId, l.itemId, P, { receipt: type === 'receipt', fromProduction });
  if (!item) return null;
  const plan = { lineNo: n, item, batch: null, newBatch: null, legs: [], quantity: null, counted: null, notes: blank(l.notes) ? null : String(l.notes).slice(0, 255) };

  if (type === 'adjustment' && !blank(l.countedQuantity)) {
    const q = Number(l.countedQuantity);
    if (!Number.isFinite(q) || q < 0) P('the counted quantity is a number, zero or more.');
    else plan.counted = round6(q);
  } else plan.quantity = readQty(l.quantity, P, { signed: type === 'adjustment' });

  const pick = (k) => (blank(l[k]) ? header[k] : l[k]);
  if (type === 'receipt') {
    const to = await getArea(pick('toAreaId'), P, 'goes into', { inbound: true });
    if (to) plan.legs.push({ area: to, sign: 1 });
  } else if (type === 'issue' || type === 'scrap') {
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
  const keepsLots = item.tracked_by === 'batch' || (fromProduction && !!l.batch);
  if (keepsLots) {
    if (type === 'receipt' && blank(l.batchId)) {
      const nb = l.batch ?? {};
      const vp = item.tracked_by === 'batch'
        ? await checkBatchValues(db, c.companyId, item, Array.isArray(nb.values) ? nb.values : [])
        : [];
      vp.forEach((p) => P(p));
      plan.newBatch = nb;
    } else if (blank(l.batchId)) {
      P(`${item.code} is kept by batch — say which batch.`);
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
    // The only batches such an item has are the lots production made of it;
    // anything else named here is simply not one of its batches.
    if (b && (b.item_id !== item.id || !b.production_item_id)) P(`${item.code} is counted by quantity — it has no batches.`);
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
  return plan;
}

const OUTBOUND = new Set(['issue', 'transfer', 'scrap']);

/** The oldest production lot in an area that covers what is being taken, if loose stock cannot. */
async function oldestLotFor(db, companyId, item, areaId, quantity) {
  const loose = await balanceOf(db, companyId, areaId, item.id, null);
  if (Number(loose) + EPS >= quantity) return null;
  const [lots] = await db.query(
    `SELECT b.* FROM cf_stock_balances k
       JOIN cf_stock_batches b ON b.id = k.batch_id AND b.deleted_at IS NULL
      WHERE k.company_id = ? AND k.item_id = ? AND k.stocking_area_id = ? AND k.quantity >= ?
        AND b.production_item_id IS NOT NULL
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
 *   movementType: receipt | issue | transfer | adjustment | scrap,
 *   movementDate?, code?, partyId? (receipt: the supplier), orderId? (issue: the sales order),
 *   reference?, reason? (required for adjustment and scrap), notes?,
 *   fromAreaId?, toAreaId?, areaId?  — defaults for every line,
 *   lines: [{ itemId, quantity | countedQuantity (adjustment), batchId? | batch: { code?, supplierRef?, values? } (new, receipt),
 *             fromAreaId?, toAreaId?, areaId?, notes? }]
 * }
 */
export async function postMovement(db, c, input = {}, opts = {}) {
  // Production putting its own finished work on the shelf — never settable from
  // a request body, so a hand-typed receipt still refuses what only production
  // may stock.
  const fromProduction = opts.fromProduction === true;
  const type = input.movementType;
  if (!MOVEMENT_TYPES.includes(type)) throw invalid('INVALID', 'A movement is a receipt, issue, transfer, adjustment or scrap.');
  const problems = [];
  let date = todayText();
  if (!blank(input.movementDate)) {
    const s = String(input.movementDate).trim();
    if (!DATE_RE.test(s)) problems.push('Date needs YYYY-MM-DD.');
    else if (s > todayText()) problems.push('A movement cannot be dated in the future.');
    else date = s;
  }
  let party = null;
  if (!blank(input.partyId)) {
    const [[p]] = await db.query('SELECT id, code, name, is_supplier FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.partyId)]);
    if (type !== 'receipt') problems.push('Only a receipt names a supplier.');
    else if (!p) problems.push('That supplier does not exist.');
    else if (!Number(p.is_supplier)) problems.push(`${p.name} is not marked as a supplier.`);
    else party = p;
  }
  let order = null;
  if (!blank(input.orderId)) {
    const [[o]] = await db.query('SELECT id, code, status FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.orderId)]);
    if (type !== 'issue') problems.push('Only an issue is made for a sales order.');
    else if (!o) problems.push('That sales order does not exist.');
    else if (LOCKED_ORDER_STATUSES.has(o.status)) problems.push(`Order ${o.code} is ${o.status} — nothing more is issued to it.`);
    else order = o;
  }
  const reason = blank(input.reason) ? null : String(input.reason).trim().slice(0, 255);
  if (type === 'adjustment' && !reason) problems.push('Say why the stock changes — a count, damage found, a correction.');
  if (type === 'scrap' && !reason) problems.push('Say why it is scrapped.');
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) problems.push('Add at least one line.');
  if (lines.length > 200) problems.push('Up to 200 lines per movement.');
  const header = { fromAreaId: input.fromAreaId, toAreaId: input.toAreaId, areaId: input.areaId };
  const getArea = areaReader(db, c.companyId, problems);
  const plans = [];
  for (const [i, l] of lines.slice(0, 200).entries()) {
    const p = await planLine(db, c, type, l ?? {}, i + 1, header, getArea, problems, { fromProduction });
    if (p) plans.push(p);
  }
  assertNoProblems(problems, 'The movement cannot be posted.');

  // A count becomes the change it needs; lines that already match record nothing.
  for (const p of plans) {
    if (p.counted == null) continue;
    const have = await balanceOf(db, c.companyId, p.legs[0].area.id, p.item.id, p.batch?.id, true);
    p.quantity = round6(p.counted - have);
  }
  const moving = plans.filter((p) => Math.abs(p.quantity) > EPS);
  if (!moving.length) throw invalid('NOTHING_CHANGES', 'The counted quantities match what is recorded — nothing to adjust.');

  const legs = moving.flatMap((p) => p.legs.map((leg) => ({
    area: leg.area, item: p.item, batch: p.batch, newBatch: p.newBatch, delta: round6(leg.sign * p.quantity),
  })));
  await assertEnough(db, c.companyId, legs);
  if (type !== 'adjustment') await assertReservationsKept(db, c.companyId, legs);
  const code = await movementCode(db, c, type, input, moving[0].legs[0]?.area?.id ?? null);
  const [r] = await db.query(
    `INSERT INTO cf_stock_movements (company_id, code, movement_type, movement_date, party_id, order_id, reference, reason, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, code, type, date, party?.id ?? null, order?.id ?? null,
      blank(input.reference) ? null : String(input.reference).trim().slice(0, 100), reason, blank(input.notes) ? null : String(input.notes), c.userId],
  );
  const movementId = r.insertId;
  if (!code) await db.query('UPDATE cf_stock_movements SET code = ? WHERE id = ?', [`${PREFIX[type]}-${String(movementId).padStart(6, '0')}`, movementId]);

  for (const p of moving) {
    if (p.newBatch) {
      const batchId = await createBatch(db, c, p.item, { ...p.newBatch, supplierId: party?.id ?? null, receivedOn: date });
      p.batch = await requireBatch(db, c.companyId, batchId);
    }
    for (const leg of p.legs) await writeLeg(db, c, { movementId, lineNo: p.lineNo, area: leg.area, item: p.item, batch: p.batch, delta: round6(leg.sign * p.quantity), notes: p.notes });
  }
  return getMovement(db, c.companyId, movementId);
}

async function writeLeg(db, c, { movementId, lineNo, area, item, batch, delta, notes }) {
  await db.query(
    `INSERT INTO cf_stock_ledger (company_id, movement_id, line_no, stocking_area_id, item_id, batch_id, quantity, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, movementId, lineNo, area.id, item.id, batch?.id ?? null, delta, notes ?? null, c.userId],
  );
  await applyDelta(db, c, { area, item, batch, delta, movementId });
}

async function requireMovement(db, companyId, id) {
  const [[m]] = await db.query('SELECT * FROM cf_stock_movements WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!m) throw notFound('Movement');
  return m;
}

/** Undoes a movement with its exact opposite, dated today. Refused if the stock it put somewhere has since moved on. */
export async function reverseMovement(db, c, id, { reason } = {}) {
  const m = await requireMovement(db, c.companyId, id);
  if (m.reversal_of_id) throw invalid('IS_REVERSAL', `${m.code} is itself a reversal — post the movement again instead.`);
  if (m.reversed_by_id) {
    const [[rev]] = await db.query('SELECT code FROM cf_stock_movements WHERE id = ?', [m.reversed_by_id]);
    throw invalid('ALREADY_REVERSED', `${m.code} was already reversed by ${rev?.code ?? 'another movement'}.`);
  }
  if (blank(reason)) throw invalid('INVALID', 'Say why it is reversed.');
  const [rows] = await db.query('SELECT * FROM cf_stock_ledger WHERE company_id = ? AND movement_id = ? AND deleted_at IS NULL ORDER BY line_no, id', [c.companyId, m.id]);
  const areas = new Map();
  const legs = [];
  for (const row of rows) {
    if (!areas.has(row.stocking_area_id)) areas.set(row.stocking_area_id, await requireArea(db, c.companyId, row.stocking_area_id));
    legs.push({
      row, area: areas.get(row.stocking_area_id), item: await loadMaster(db, c.companyId, row.item_id),
      batch: row.batch_id ? await requireBatch(db, c.companyId, row.batch_id) : null, delta: round6(-Number(row.quantity)),
    });
  }
  // The stock it put somewhere must still be there to take back — and not be reserved.
  await assertEnough(db, c.companyId, legs);
  if (m.movement_type !== 'adjustment') await assertReservationsKept(db, c.companyId, legs);
  const [r] = await db.query(
    `INSERT INTO cf_stock_movements (company_id, code, movement_type, movement_date, party_id, order_id, reference, reason, reversal_of_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, `REV-${m.code}`.slice(0, 60), m.movement_type, todayText(), m.party_id, m.order_id, m.reference,
      String(reason).trim().slice(0, 255), m.id, c.userId],
  );
  const revId = r.insertId;
  for (const l of legs) {
    await writeLeg(db, c, { movementId: revId, lineNo: l.row.line_no, area: l.area, item: l.item, batch: l.batch, delta: l.delta, notes: l.row.notes });
  }
  await db.query('UPDATE cf_stock_movements SET reversed_by_id = ? WHERE company_id = ? AND id = ?', [revId, c.companyId, m.id]);
  return getMovement(db, c.companyId, revId);
}

// --- reading ------------------------------------------------------------------------

const MOVEMENT_SELECT = `SELECT m.*, p.code AS party_code, p.name AS party_name, o.code AS order_code,
       ro.code AS reversal_of_code, rb.code AS reversed_by_code,
       (SELECT COUNT(DISTINCT l.line_no) FROM cf_stock_ledger l WHERE l.company_id = m.company_id AND l.movement_id = m.id) AS line_count,
       (SELECT GROUP_CONCAT(DISTINCT a.code ORDER BY a.code SEPARATOR ', ') FROM cf_stock_ledger l JOIN cf_stocking_areas a ON a.id = l.stocking_area_id
         WHERE l.company_id = m.company_id AND l.movement_id = m.id) AS area_codes,
       (SELECT GROUP_CONCAT(DISTINCT r.code ORDER BY r.code SEPARATOR ', ') FROM cf_stock_ledger l JOIN cf_master_records r ON r.id = l.item_id
         WHERE l.company_id = m.company_id AND l.movement_id = m.id) AS item_codes
  FROM cf_stock_movements m
  LEFT JOIN cf_parties p ON p.id = m.party_id
  LEFT JOIN cf_sales_orders o ON o.id = m.order_id
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

export async function listMovements(db, companyId, q = {}) {
  const where = ['m.company_id = ?', 'm.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.type)) { where.push('m.movement_type = ?'); params.push(q.type); }
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
  const limit = Math.min(Number(q.limit) || 200, 500);
  const [rows] = await db.query(`${MOVEMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.movement_date DESC, m.id DESC LIMIT ${limit}`, params);
  return rows.map(shapeMovement);
}

/** A movement with its lines: each line's item, batch, the area it left and the area it reached. */
export async function getMovement(db, companyId, id) {
  const [[m]] = await db.query(`${MOVEMENT_SELECT} WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL`, [companyId, Number(id)]);
  if (!m) throw notFound('Movement');
  const out = shapeMovement(m);
  const [rows] = await db.query(
    `SELECT l.*, r.code AS item_code, r.name AS item_name, i.uom, b.code AS batch_code, b.status AS batch_status,
            a.code AS area_code, a.name AS area_name, a.purpose
       FROM cf_stock_ledger l
       JOIN cf_master_records r ON r.id = l.item_id
       JOIN cf_item_details i ON i.master_id = l.item_id
       JOIN cf_stocking_areas a ON a.id = l.stocking_area_id
       LEFT JOIN cf_stock_batches b ON b.id = l.batch_id
      WHERE l.company_id = ? AND l.movement_id = ? ORDER BY l.line_no, l.quantity, l.id`,
    [companyId, m.id],
  );
  const lines = new Map();
  for (const r of rows) {
    const line = lines.get(r.line_no) ?? {
      lineNo: r.line_no,
      item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom },
      batch: r.batch_id ? { id: r.batch_id, code: r.batch_code, status: r.batch_status } : null,
      from: null, to: null, quantity: 0, change: 0, notes: r.notes,
    };
    const area = { id: r.stocking_area_id, code: r.area_code, name: r.area_name, purpose: r.purpose };
    const q = Number(r.quantity);
    if (q < 0) line.from = area; else line.to = area;
    line.quantity = Math.max(line.quantity, Math.abs(q));
    line.change += q;
    lines.set(r.line_no, line);
  }
  out.lines = [...lines.values()].map((l) => ({ ...l, change: round6(l.change) }));
  return out;
}

const STOCK_SELECT = `SELECT k.*, a.code AS area_code, a.name AS area_name, a.purpose, a.status AS area_status,
       r.code AS item_code, r.name AS item_name, i.uom, i.tracked_by, b.code AS batch_code, b.status AS batch_status
  FROM cf_stock_balances k
  JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
  JOIN cf_master_records r ON r.id = k.item_id
  JOIN cf_item_details i ON i.master_id = k.item_id
  LEFT JOIN cf_stock_batches b ON b.id = k.batch_id`;

function shapeStock(k) {
  return {
    area: { id: k.stocking_area_id, code: k.area_code, name: k.area_name, purpose: k.purpose },
    item: { id: k.item_id, code: k.item_code, name: k.item_name, uom: k.uom, trackedBy: k.tracked_by },
    batch: k.batch_id ? { id: k.batch_id, code: k.batch_code, status: k.batch_status } : null,
    quantity: Number(k.quantity),
    category: categoryOf(k.purpose, k.batch_status),
    updatedAt: k.updated_at,
  };
}

/** What sits where. q: { areaId?, itemId?, batchId?, purpose?, search?, includeZero? } */
export async function listStock(db, companyId, q = {}) {
  const where = ['k.company_id = ?'];
  const params = [companyId];
  if (String(q.includeZero) !== '1') where.push('k.quantity <> 0');
  if (!blank(q.areaId)) { where.push('k.stocking_area_id = ?'); params.push(Number(q.areaId)); }
  if (!blank(q.itemId)) { where.push('k.item_id = ?'); params.push(Number(q.itemId)); }
  if (!blank(q.batchId)) { where.push('k.batch_id = ?'); params.push(Number(q.batchId)); }
  if (!blank(q.purpose)) { where.push('a.purpose = ?'); params.push(q.purpose); }
  if (!blank(q.search)) {
    where.push('(r.code LIKE ? OR r.name LIKE ? OR b.code LIKE ?)');
    const s = like(q.search);
    params.push(s, s, s);
  }
  const [rows] = await db.query(`${STOCK_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.code, a.code, b.code LIMIT 2000`, params);
  return rows.map(shapeStock);
}

const CATEGORIES = ['available', 'in_process', 'held', 'rejected', 'dispatch'];
const summarise = (rows) => {
  const totals = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
  for (const r of rows) totals[r.category] = round6(totals[r.category] + r.quantity);
  return { onHand: round6(rows.reduce((t, r) => t + r.quantity, 0)), ...totals };
};

/** One item's stock: totals by what it counts as, every area and batch holding it, and its latest movements. */
export async function itemStock(db, companyId, itemId) {
  const item = await loadMaster(db, companyId, Number(itemId));
  if (!item || item.record_kind !== 'item') throw notFound('Item');
  const rows = await listStock(db, companyId, { itemId: item.id });
  const [res] = await db.query(
    `SELECT v.id, v.quantity, v.batch_id, b.code AS batch_code, b.status AS batch_status,
            IF(v.order_line_id IS NULL, 'material', 'finished') AS kind,
            o.id AS order_id, o.code AS order_code, COALESCE(l.line_no, dl.line_no) AS line_no
       FROM cf_stock_reservations v
       LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
       LEFT JOIN cf_material_requirements q ON q.id = v.requirement_id
       LEFT JOIN cf_production_releases r ON r.id = q.release_id
       LEFT JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       LEFT JOIN cf_sales_order_lines dl ON dl.id = v.order_line_id
       JOIN cf_sales_orders o ON o.id = COALESCE(r.order_id, dl.order_id)
      WHERE v.company_id = ? AND v.item_id = ? AND v.status = 'active' AND v.deleted_at IS NULL ORDER BY o.code, line_no, v.id`,
    [companyId, item.id],
  );
  const totals = summarise(rows);
  totals.reserved = round6(res.reduce((t, v) => t + Number(v.quantity), 0));
  totals.free = Math.max(0, round6(totals.available + totals.in_process - totals.reserved));
  return {
    item: { id: item.id, code: item.code, name: item.name, uom: item.uom, trackedBy: item.tracked_by, stockable: item.tracked_by !== 'individual' },
    totals,
    rows,
    reservations: res.map((v) => ({
      id: v.id, quantity: Number(v.quantity), batch: v.batch_id ? { id: v.batch_id, code: v.batch_code, status: v.batch_status } : null,
      order: { id: v.order_id, code: v.order_code }, lineNo: v.line_no, kind: v.kind,
    })),
    movements: await listMovements(db, companyId, { itemId: item.id, limit: 20 }),
  };
}

/** A stocking area and its inventory. */
export async function areaInventory(db, companyId, areaId) {
  const area = shapeArea(await requireArea(db, companyId, areaId));
  const rows = await listStock(db, companyId, { areaId: area.id });
  return { area, totals: summarise(rows), rows, movements: await listMovements(db, companyId, { areaId: area.id, limit: 20 }) };
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
