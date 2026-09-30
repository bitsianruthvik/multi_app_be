/**
 * ownershipService.js — the customer's material (CF_ERP_MONEY_PLAN §1, init.sql
 * §35, decided 2026-09-30). The user: "customers sometimes supply raw material,
 * and the wastage has to be tracked and given back."
 *
 *   receiveCustomerMaterial   a receipt owned by the order's customer, for that
 *                             order, at no cost to us (a reference cost may be
 *                             typed; it is never counted as ours)
 *   materialReconciliation    per sales order: received − issued − scrapped −
 *                             returned = still on our shelves, per item in qty
 *                             and kg; plus their offcuts and their scrap by weight
 *   returnToCustomer          a 'return' movement: their stock pieces, their
 *                             offcut pieces (cf_offcuts), and scrap by weight
 *
 * WHICH OF THEIR LOTS BELONG TO AN ORDER: lots supplied for it (any revision —
 * they share the number), and lots supplied with no order named that moved
 * against it. A lot supplied with no order that moved against two orders shows
 * on both.
 *
 * The rules that choose stock (only their order uses their material; theirs
 * first, then ours) live where stock is chosen: rollOutService.availability,
 * releaseService.takeFrom, stockService.usableFor, nestingService.customerPlates.
 */
import { invalid, assertNoProblems } from '../lib/errors.js';
import { postMovement, getMovement } from './stockService.js';
import { orderFamily, unitKgOf, lotShares, lotPlateKg, CURRENCY } from './valuationService.js';

const round3 = (n) => Number(Number(n).toFixed(3));
const round6 = (n) => Number(Number(n).toFixed(6));
const blank = (v) => v == null || String(v).trim() === '';

async function customerOrder(db, companyId, orderId) {
  if (blank(orderId)) throw invalid('INVALID', 'Say which sales order the material is for.');
  const fam = await orderFamily(db, companyId, orderId);
  if (!fam.order.customer_id) throw invalid('NO_CUSTOMER', `Order ${fam.order.code} has no customer — only a customer supplies material for an order.`);
  return fam;
}

/**
 * input: { orderId, toAreaId, movementDate?, reference?, notes?,
 *          lines: [{ itemId, quantity, batchId? | batch?: { code?, supplierRef?, values? }, unitCost? (reference only), toAreaId?, notes? }] }
 * Every line becomes a lot owned by the order's customer, for this order.
 */
export async function receiveCustomerMaterial(db, c, input = {}) {
  const { order } = await customerOrder(db, c.companyId, input.orderId);
  return postMovement(db, c, {
    movementType: 'receipt',
    partyId: order.customer_id,
    orderId: order.id,
    ownerPartyId: order.customer_id,
    ownerOrderId: order.id,
    toAreaId: input.toAreaId,
    movementDate: input.movementDate,
    reference: input.reference,
    notes: input.notes ?? `Material supplied by ${order.customer_name ?? 'the customer'} for ${order.code}`,
    lines: (Array.isArray(input.lines) ? input.lines : []).map((l) => ({
      itemId: l?.itemId, quantity: l?.quantity, batchId: l?.batchId, batch: l?.batch, unitCost: l?.unitCost,
      toAreaId: l?.toAreaId, notes: l?.notes,
    })),
  });
}

/** The customer's lots that belong to this order (see the header). */
const LOT_SCOPE = `b.company_id = ? AND b.owner_party_id = ? AND b.deleted_at IS NULL
  AND (b.owner_order_id IN (?)
       OR (b.owner_order_id IS NULL AND EXISTS (
             SELECT 1 FROM cf_stock_ledger l2 JOIN cf_stock_movements m2 ON m2.id = l2.movement_id
              WHERE l2.company_id = b.company_id AND l2.batch_id = b.id AND m2.order_id IN (?))))`;

/**
 * Per sales order, what the customer gave us and where it is now.
 * Returns {
 *   order, customer, currency,
 *   items: [{ item, uom, kgPerUnit, received, issued, scrapped, returned, adjusted, withUs, balanceOnHand, balances }]
 *          each { qty, kg } (kg null when the item says no weight); withUs = received − issued − scrapped
 *          − returned + adjusted (the ledger), balanceOnHand = their lots on our shelves (the balances);
 *          balances = the two agree,
 *   offcuts: { total, returned, used, scrapped, withUs } each { count, kg }, list: [...not returned],
 *   scrap:   { fromNestsKg (kerf, gaps, rim, wastage of their plates' nests), scrappedStockKg,
 *              returnedKg, withUsKg },
 *   totals:  { receivedKg, issuedKg, scrappedKg, returnedKg, withUsKg, owedBackKg }
 * }
 * owedBackKg = offcuts still with us + scrap still with us — what goes back to them.
 */
export async function materialReconciliation(db, companyId, orderId) {
  const { order, ids } = await customerOrder(db, companyId, orderId);
  const cust = order.customer_id;
  const [moves] = await db.query(
    `SELECT l.item_id, m.movement_type, SUM(l.quantity) AS qty
       FROM cf_stock_ledger l
       JOIN cf_stock_movements m ON m.id = l.movement_id
       JOIN cf_stock_batches b ON b.id = l.batch_id
      WHERE ${LOT_SCOPE}
      GROUP BY l.item_id, m.movement_type`,
    [companyId, cust, ids, ids],
  );
  const [bals] = await db.query(
    `SELECT k.item_id, SUM(k.quantity) AS qty
       FROM cf_stock_balances k JOIN cf_stock_batches b ON b.id = k.batch_id
      WHERE ${LOT_SCOPE}
      GROUP BY k.item_id`,
    [companyId, cust, ids, ids],
  );
  const itemIds = [...new Set([...moves.map((m) => m.item_id), ...bals.map((b) => b.item_id)])];
  const [items] = itemIds.length ? await db.query(
    `SELECT m.id, m.code, m.name, i.uom FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.id IN (?) ORDER BY m.code, m.id`,
    [companyId, itemIds],
  ) : [[]];
  const kgOf = await unitKgOf(db, companyId, itemIds);
  const pair = (qty, per) => ({ qty: round6(qty), kg: per == null ? null : round3(qty * per) });
  const out = items.map((it) => {
    const per = kgOf.get(it.id);
    const sum = (type) => moves.filter((m) => m.item_id === it.id && m.movement_type === type).reduce((t, m) => t + Number(m.qty), 0);
    const received = sum('receipt');
    const issued = -sum('issue');
    const scrapped = -sum('scrap');
    const returned = -sum('return');
    const adjusted = sum('adjustment');
    const withUs = round6(received - issued - scrapped - returned + adjusted);
    const onHand = Number(bals.find((b) => b.item_id === it.id)?.qty ?? 0);
    return {
      item: { id: it.id, code: it.code, name: it.name }, uom: it.uom, kgPerUnit: per,
      received: pair(received, per), issued: pair(issued, per), scrapped: pair(scrapped, per),
      returned: pair(returned, per), adjusted: pair(adjusted, per), withUs: pair(withUs, per),
      balanceOnHand: pair(onHand, per), balances: Math.abs(onHand - withUs) <= 1e-6,
    };
  });

  // Their offcuts and the scrap from their plates' nests, on this order's lines.
  const [offcuts] = await db.query(
    `SELECT o.id, o.offcut_no, o.status, o.weight_kg, o.area_mm2, o.thickness_mm, o.grade, o.returned_movement_id, o.order_line_id, ol.line_no
       FROM cf_offcuts o JOIN cf_sales_order_lines ol ON ol.id = o.order_line_id
      WHERE o.company_id = ? AND o.owner_party_id = ? AND ol.order_id IN (?) AND o.deleted_at IS NULL
      ORDER BY ol.line_no, o.offcut_no`,
    [companyId, cust, ids],
  );
  const tally = (list) => ({ count: list.length, kg: round3(list.reduce((t, o) => t + Number(o.weight_kg ?? 0), 0)) });
  const withUsOffcuts = offcuts.filter((o) => !['returned', 'used', 'scrapped'].includes(o.status));
  const [lots] = await db.query(
    `SELECT pl.id, pl.length_mm, pl.width_mm, pl.thickness_mm, pl.density, pl.waste_json
       FROM cf_plate_lots pl JOIN cf_sales_order_lines ol ON ol.id = pl.order_line_id
      WHERE pl.company_id = ? AND pl.owner_party_id = ? AND ol.order_id IN (?) AND pl.deleted_at IS NULL`,
    [companyId, cust, ids],
  );
  const fromNestsKg = round3(lots.reduce((t, l) => { const s = lotShares(l); return t + (s ? lotPlateKg(l) * s.scrap : 0); }, 0));
  const [[{ kg: returnedKg }]] = await db.query(
    `SELECT COALESCE(SUM(return_kg), 0) AS kg FROM cf_stock_movements
      WHERE company_id = ? AND movement_type = 'return' AND order_id IN (?) AND party_id = ? AND reversal_of_id IS NULL AND reversed_by_id IS NULL`,
    [companyId, ids, cust],
  );
  const kgSum = (key) => round3(out.reduce((t, r) => t + (r[key].kg ?? 0), 0));
  const scrappedStockKg = kgSum('scrapped');
  const scrapWithUs = round3(fromNestsKg + scrappedStockKg - Number(returnedKg));
  const offcutsWithUs = tally(withUsOffcuts);
  return {
    order: { id: order.id, code: order.code, revision: order.revision },
    customer: { id: cust, code: order.customer_code, name: order.customer_name },
    currency: CURRENCY,
    items: out,
    offcuts: {
      total: tally(offcuts),
      returned: tally(offcuts.filter((o) => o.status === 'returned')),
      used: tally(offcuts.filter((o) => o.status === 'used')),
      scrapped: tally(offcuts.filter((o) => o.status === 'scrapped')),
      withUs: offcutsWithUs,
      list: withUsOffcuts.map((o) => ({
        id: o.id, offcutNo: o.offcut_no, status: o.status, lineNo: o.line_no,
        weightKg: o.weight_kg == null ? null : Number(o.weight_kg), areaMm2: Number(o.area_mm2),
        thicknessMm: o.thickness_mm == null ? null : Number(o.thickness_mm), grade: o.grade,
      })),
    },
    scrap: { fromNestsKg, scrappedStockKg, returnedKg: round3(Number(returnedKg)), withUsKg: scrapWithUs },
    totals: {
      receivedKg: kgSum('received'), issuedKg: kgSum('issued'), scrappedKg: scrappedStockKg,
      returnedKg: round3(kgSum('returned') + offcuts.filter((o) => o.status === 'returned').reduce((t, o) => t + Number(o.weight_kg ?? 0), 0) + Number(returnedKg)),
      withUsKg: kgSum('withUs'),
      owedBackKg: round3(offcutsWithUs.kg + Math.max(0, scrapWithUs)),
      unweighedItems: out.filter((r) => r.kgPerUnit == null).length,
    },
  };
}

/**
 * Gives the customer's material back. input: {
 *   orderId, reason?, movementDate?, reference?, notes?, fromAreaId?,
 *   lines?:     [{ itemId, batchId, quantity, fromAreaId? }] — their stock pieces (lots)
 *   offcutIds?: [id]  — their offcut pieces (cf_offcuts of this order's lines)
 *   scrapKg?:   number — scrap handed back by weight
 * }
 * One 'return' movement: the lots leave our shelves through the ledger, the
 * offcuts are marked returned against it, the scrap weight sits on it.
 */
export async function returnToCustomer(db, c, input = {}) {
  const { order, ids } = await customerOrder(db, c.companyId, input.orderId);
  const lines = Array.isArray(input.lines) ? input.lines.filter(Boolean) : [];
  const offcutIds = [...new Set((Array.isArray(input.offcutIds) ? input.offcutIds : []).map(Number).filter(Number.isInteger))];
  const scrapKg = blank(input.scrapKg) ? null : Number(input.scrapKg);
  const problems = [];
  if (scrapKg != null && (!Number.isFinite(scrapKg) || scrapKg <= 0)) problems.push('The scrap weight is a number of kilograms above zero.');
  if (!lines.length && !offcutIds.length && scrapKg == null) problems.push('Say what goes back — their stock, their offcuts, or scrap by weight.');
  let offcuts = [];
  if (offcutIds.length) {
    const [rows] = await db.query(
      `SELECT o.id, o.offcut_no, o.status, o.owner_party_id, ol.order_id
         FROM cf_offcuts o JOIN cf_sales_order_lines ol ON ol.id = o.order_line_id
        WHERE o.company_id = ? AND o.id IN (?) AND o.deleted_at IS NULL FOR UPDATE`,
      [c.companyId, offcutIds],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of offcutIds) {
      const o = byId.get(id);
      if (!o) problems.push(`Offcut ${id} does not exist.`);
      else if (!ids.includes(o.order_id)) problems.push(`Offcut ${o.offcut_no} is not from order ${order.code}.`);
      else if (Number(o.owner_party_id) !== Number(order.customer_id)) problems.push(`Offcut ${o.offcut_no} was cut from our plate, not the customer's — it stays ours.`);
      else if (['returned', 'used', 'scrapped'].includes(o.status)) problems.push(`Offcut ${o.offcut_no} is already ${o.status}.`);
    }
    offcuts = rows;
  }
  assertNoProblems(problems, 'Nothing can go back yet.');
  const what = [
    lines.length ? `${lines.length} lot line${lines.length === 1 ? '' : 's'}` : null,
    offcuts.length ? `${offcuts.length} offcut${offcuts.length === 1 ? '' : 's'}` : null,
    scrapKg != null ? `${round3(scrapKg)} kg scrap` : null,
  ].filter(Boolean).join(', ');
  const movement = await postMovement(db, c, {
    movementType: 'return',
    partyId: order.customer_id,
    orderId: order.id,
    fromAreaId: input.fromAreaId,
    movementDate: input.movementDate,
    reference: input.reference,
    reason: blank(input.reason) ? `Returned to ${order.customer_name ?? 'the customer'}: ${what}` : input.reason,
    notes: input.notes,
    returnKg: scrapKg ?? undefined,
    lines: lines.map((l) => ({ itemId: l.itemId, batchId: l.batchId, quantity: l.quantity, fromAreaId: l.fromAreaId, notes: l.notes })),
  }, { allowEmpty: true });
  if (offcuts.length) {
    await db.query(
      "UPDATE cf_offcuts SET status = 'returned', returned_movement_id = ? WHERE company_id = ? AND id IN (?)",
      [movement.id, c.companyId, offcuts.map((o) => o.id)],
    );
  }
  return {
    movement: offcuts.length ? await getMovement(db, c.companyId, movement.id) : movement,
    offcutsReturned: offcuts.map((o) => ({ id: o.id, offcutNo: o.offcut_no })),
    scrapKg: scrapKg == null ? null : round3(scrapKg),
    reconciliation: await materialReconciliation(db, c.companyId, order.id),
  };
}

