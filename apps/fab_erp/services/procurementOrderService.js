/**
 * procurementOrderService.js — raising and receiving purchase orders.
 *
 * A procurement order is a `fab_orders` row with `order_type='purchase'`,
 * pointed back at the sales order that caused it via `source_order_id`, with
 * one `fab_order_lines` row per catalog item being bought.
 *
 * Purchase orders and goods receipt were REMOVED from this system on
 * 2026-08-05, and `/stock/receive` replaced them with "no purchase order, no
 * supplier, no receipt document". They are back deliberately and in a narrower
 * shape: this is not MRP. Nothing here plans, nets across orders, or explodes
 * requirements — it answers one question for one sales order, "what does this
 * order need that we do not have", and records the answer as a document.
 *
 * ONE PO PER SUPPLIER. Ten shortfall lines from one supplier are one order to
 * that supplier, not ten; a supplier receives an order, not a list of items.
 * Lines with no supplier chosen are not guessed at — they are refused, because
 * a purchase order addressed to nobody cannot be sent.
 */

import { pool } from '../../../db.js';
import { orderShortfall } from './procurementService.js';
import { reserveForOrder, reservePiecesForOrder } from './availabilityService.js';
import { receiveStock } from './stockInService.js';
import { generateCode } from './codegenService.js';

/** Statuses a purchase order moves through, in order. */
export const PO_STATUS = {
  /** Asked for, to nobody yet. The buyer picks a supplier and sends it. */
  REQUESTED: 'requested',
  DRAFT: 'draft',
  ORDERED: 'ordered',
  PARTIAL: 'partially_received',
  RECEIVED: 'received',
  CANCELLED: 'cancelled',
};

/**
 * TAKE FROM STOCK, AND ASK FOR THE REST — the buying half of the production step.
 *
 * For each bought item the person says how much to take off the shelf for this
 * order: all that is free, or less (another job may need it sooner). That much
 * is reserved. Whatever is still needed after what is held and what is already
 * on order goes on ONE purchase request for the order, in the 'requested'
 * state, addressed to nobody — choosing the supplier is the buyer's call, made
 * when the request is sent.
 *
 * RE-RUNNABLE. There is at most one open request per sales order: running this
 * again rewrites that request's lines rather than raising a second, so pressing
 * the button twice does not buy the steel twice. Requests already sent to a
 * supplier are counted as on order and left alone.
 *
 * @param {Array<{catalogItemId:number, take:number}>} lines
 */
export async function requestProcurement(companyId, orderId, lines, { createdBy = null } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[sales]] = await conn.query(
      `SELECT id, order_number, required_date, plant_id FROM fab_orders
        WHERE id = ? AND company_id = ? AND order_type = 'sales' AND deleted_at IS NULL LIMIT 1`,
      [orderId, companyId],
    );
    if (!sales) { const e = new Error('Sales order not found'); e.status = 404; throw e; }

    const takeOf = new Map((lines ?? []).map((l) => [Number(l.catalogItemId), Math.max(0, Number(l.take) || 0)]));
    const shortfall = await orderShortfall(companyId, orderId, conn);

    // 1. what to hold — never more than is needed; reserveForOrder also never
    //    takes more than is free.
    const reserved = await reserveForOrder(conn, companyId, orderId, shortfall.lines
      .filter((l) => takeOf.has(l.catalogItemId))
      .map((l) => ({ catalogItemId: l.catalogItemId, qty: Math.min(takeOf.get(l.catalogItemId), l.required) })));
    // A line taken down to zero has to give back what it held — reserveForOrder
    // skips zero quantities, so it is released here.
    const zeroed = [...takeOf].filter(([, t]) => t === 0).map(([id]) => id);
    if (zeroed.length) {
      await conn.query(
        `UPDATE fab_stock_reservations SET status = 'released', released_at = UTC_TIMESTAMP()
          WHERE company_id = ? AND order_id = ? AND kind = 'order' AND status = 'active'
            AND deleted_at IS NULL AND catalog_item_id IN (?)`,
        [companyId, orderId, zeroed],
      );
    }
    /*
     * …and name the actual PLATES where nesting said which size. Two orders can
     * both hold three of a thickness while only one of the plates is the size
     * either can use; naming the piece is the only way to hold the right one.
     * What is taken is shared out across the sizes in turn, so naming pieces
     * never holds more than was asked for.
     */
    const pieceWants = [];
    for (const l of shortfall.lines) {
      let left = Math.min(takeOf.get(l.catalogItemId) ?? 0, l.required);
      for (const sz of (l.sizes ?? []).filter((x) => x.sized)) {
        const plates = Math.min(left, sz.required);
        if (plates > 0) pieceWants.push({ catalogItemId: l.catalogItemId, lengthMm: sz.length, widthMm: sz.width, plates });
        left -= plates;
      }
    }
    if (pieceWants.length) await reservePiecesForOrder(conn, companyId, orderId, pieceWants);
    const heldOf = new Map(await heldByOrder(conn, companyId, orderId));

    // 2. the open request, if there is one — its own lines are about to be
    //    rewritten, so they do not count as on order.
    const [[open]] = await conn.query(
      `SELECT id, order_number FROM fab_orders
        WHERE company_id = ? AND source_order_id = ? AND order_type = 'purchase'
          AND status = ? AND deleted_at IS NULL
        ORDER BY id LIMIT 1 FOR UPDATE`,
      [companyId, orderId, PO_STATUS.REQUESTED],
    );
    const onOrder = await onOrderByItem(companyId, orderId, conn, { excludeOrderId: open?.id ?? null });

    const toBuy = shortfall.lines
      .map((l) => ({
        ...l,
        qty: Math.max(0, l.required - (heldOf.get(l.catalogItemId) ?? 0) - (onOrder.get(l.catalogItemId) ?? 0)),
      }))
      .filter((l) => l.qty > 0);

    // 3. one request, rewritten in place
    let request = open ? { id: open.id, orderNumber: open.order_number } : null;
    if (request) {
      await conn.query(
        `UPDATE fab_order_lines SET deleted_at = UTC_TIMESTAMP()
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
        [companyId, request.id],
      );
      if (!toBuy.length) {
        await conn.query(`UPDATE fab_orders SET status = ? WHERE id = ? AND company_id = ?`,
          [PO_STATUS.CANCELLED, request.id, companyId]);
        request = null;
      }
    } else if (toBuy.length) {
      const orderNumber = await generateCode(companyId, 'purchase_order', {}, conn);
      const [ins] = await conn.query(
        `INSERT INTO fab_orders
           (company_id, order_number, order_type, status, supplier_id, source_order_id,
            plant_id, required_date, created_by, notes)
         VALUES (?, ?, 'purchase', ?, NULL, ?, ?, ?, ?, ?)`,
        [companyId, orderNumber, PO_STATUS.REQUESTED, orderId, sales.plant_id ?? null,
          sales.required_date ?? null, createdBy, `Requested for ${sales.order_number}`],
      );
      request = { id: ins.insertId, orderNumber };
    }
    if (request) {
      let lineNo = 1;
      await conn.query(
        `INSERT INTO fab_order_lines
           (company_id, order_id, line_no, code, description, catalog_item_id, qty, unit, status, qty_received)
         VALUES ?`,
        [toBuy.map((l) => [companyId, request.id, lineNo++, l.code ?? null, l.name ?? null,
          l.catalogItemId, l.qty, l.unit ?? null, 'open', 0])],
      );
    }

    await conn.commit();
    return { reserved, request, lines: toBuy.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Send a purchase request to a supplier: requested → ordered.
 *
 * The request was raised addressed to nobody; this is where the buyer names
 * who it goes to. After this it is an ordinary purchase order and is received
 * against on the Stock In page like any other.
 */
export async function sendPurchaseRequest(companyId, poId, supplierId) {
  const [[sup]] = await pool.query(
    `SELECT id, payment_terms, currency FROM fab_suppliers WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [supplierId, companyId],
  );
  if (!sup) { const e = new Error('Choose a supplier first.'); e.status = 422; throw e; }
  const [r] = await pool.query(
    `UPDATE fab_orders SET supplier_id = ?, payment_terms = ?, currency = ?, status = ?
      WHERE id = ? AND company_id = ? AND order_type = 'purchase' AND status = ? AND deleted_at IS NULL`,
    [sup.id, sup.payment_terms ?? null, sup.currency ?? null, PO_STATUS.ORDERED, poId, companyId, PO_STATUS.REQUESTED],
  );
  if (!r.affectedRows) { const e = new Error('That request has already been sent.'); e.status = 409; throw e; }
  return { ok: true };
}

/** What each item this order holds off the shelf, right now. */
export async function heldByOrder(conn, companyId, orderId) {
  const [rows] = await (conn ?? pool).query(
    `SELECT catalog_item_id AS id, SUM(qty) AS qty FROM fab_stock_reservations
      WHERE company_id = ? AND order_id = ? AND kind = 'order' AND status = 'active' AND deleted_at IS NULL
      GROUP BY catalog_item_id`,
    [companyId, orderId],
  );
  return rows.map((r) => [Number(r.id), Number(r.qty) || 0]);
}

/**
 * Book one line's delivery, INSIDE a transaction the caller owns.
 *
 * Split out from receiveAgainstLine so that receiving several lines of one
 * delivery note is a single transaction rather than N independent ones. A
 * delivery that booked three of its five lines and then failed would leave a
 * purchase order nobody can reason about — and, worse, stock on the shelf with
 * no record of which lines it closed.
 *
 * Over-receipt is allowed and NOT clamped: suppliers really do send 10.2 tonnes
 * against a 10 tonne order, and a system that refuses the extra plate makes
 * somebody lie to it. The line closes once qty_received ≥ qty.
 */
async function receiveLineWithin(conn, companyId, poLineId, payload) {
  // FOR UPDATE because the new quantity is computed in JS from what is read
  // here. Two people receiving the same line at once would otherwise both read
  // the old figure and the second write would erase the first delivery.
  const [[line]] = await conn.query(
    `SELECT ol.id, ol.order_id, ol.catalog_item_id, ol.qty, ol.qty_received, o.status AS po_status
       FROM fab_order_lines ol
       JOIN fab_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
      WHERE ol.id = ? AND ol.company_id = ? AND ol.deleted_at IS NULL
        AND o.order_type = 'purchase'
      LIMIT 1
      FOR UPDATE`,
    [poLineId, companyId],
  );
  if (!line) throw new Error('Purchase order line not found');
  if (line.po_status === PO_STATUS.CANCELLED) throw new Error('That purchase order is cancelled');
  if (line.catalog_item_id == null) {
    // Without a catalog item there is nothing to put on the shelf. Refused
    // rather than guessed: booking it against some other item would put the
    // wrong steel in stock and close the wrong line.
    throw new Error('That purchase order line names no catalog item, so it cannot be received');
  }

  const pieces = Array.isArray(payload.pieces) ? payload.pieces : [];
  const qtyIn = pieces.reduce((a, p) => a + (Number(p.qty) || 0), 0);
  if (!(qtyIn > 0)) throw new Error('Nothing to receive — every piece has zero quantity');

  // receiveStock joins this transaction rather than opening its own, so the
  // pieces, the ledger and the line's outstanding quantity all land together
  // or not at all.
  const stockResult = await receiveStock(companyId, {
    ...payload,
    catalog_item_id: line.catalog_item_id,
  }, conn);

  /**
   * Both new values computed here rather than in SQL.
   *
   * This was one statement, `SET qty_received = qty_received + ?, status =
   * IF(qty_received + ? >= qty, 'received', 'partial')`, and it was wrong:
   * MySQL evaluates SET assignments left to right and later expressions see the
   * NEW value of earlier-assigned columns, so the `+ ?` landed TWICE in the
   * status test. Receiving 6 against a line of 10 stored qty_received = 6 and
   * then closed the line, because it compared 6 + 6 with 10. The 4 still owed
   * silently disappeared from every outstanding figure in the app.
   */
  const newReceived = Number(line.qty_received ?? 0) + qtyIn;
  const closed = newReceived >= Number(line.qty ?? 0);
  await conn.query(
    `UPDATE fab_order_lines SET qty_received = ?, status = ? WHERE id = ? AND company_id = ?`,
    [newReceived, closed ? 'received' : 'partial', poLineId, companyId],
  );

  return { orderId: line.order_id, lineId: poLineId, qtyReceived: qtyIn, stock: stockResult };
}

/**
 * The order's own status follows its lines: all closed → received, some
 * movement → partially_received.
 */
async function syncPoStatus(conn, companyId, poId) {
  const [[agg]] = await conn.query(
    `SELECT COUNT(*) AS total,
            SUM(qty_received >= qty) AS closed,
            SUM(qty_received > 0)    AS started
       FROM fab_order_lines
      WHERE order_id = ? AND company_id = ? AND deleted_at IS NULL`,
    [poId, companyId],
  );
  const total = Number(agg?.total) || 0;
  const closed = Number(agg?.closed) || 0;
  const started = Number(agg?.started) || 0;
  const poStatus = total > 0 && closed === total
    ? PO_STATUS.RECEIVED
    : (started > 0 ? PO_STATUS.PARTIAL : PO_STATUS.ORDERED);
  await conn.query(
    `UPDATE fab_orders SET status = ? WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [poStatus, poId, companyId],
  );
  return poStatus;
}

/**
 * Receive against a purchase-order line.
 *
 * This is the linkage the old goods-receipt path lost: stock arriving is booked
 * against the line that ordered it, so "what is still outstanding" is a fact
 * rather than a memory. It delegates the physical side — pieces, ledger, piece
 * codes, re-checking material-gated tasks — to the existing stock-in path
 * rather than writing a second one.
 */
export async function receiveAgainstLine(companyId, poLineId, payload) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const res = await receiveLineWithin(conn, companyId, poLineId, payload);
    const poStatus = await syncPoStatus(conn, companyId, res.orderId);
    await conn.commit();
    return { poId: res.orderId, poStatus, lineId: poLineId, qtyReceived: res.qtyReceived, stock: res.stock };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Receive a whole delivery against ONE purchase order, several lines at a time.
 *
 * This is what a goods-receipt note actually is: a lorry turns up against a
 * purchase order carrying some of several lines, and somebody writes down how
 * much of each arrived. Doing that as N separate calls to receiveAgainstLine
 * made the delivery N documents that can each half-fail, and made the person
 * entering it pick the same plant, stock area and date N times.
 *
 * Lines with no quantity are simply not received — a delivery note routinely
 * covers only part of an order, and leaving those rows blank is how somebody
 * says so. If NOTHING has a quantity that is an error, not a silent no-op.
 *
 * @param {number} companyId
 * @param {number} poId
 * @param {object} payload
 * @param {number} payload.plant_id
 * @param {number} payload.stock_location_id
 * @param {string} payload.received_date  YYYY-MM-DD
 * @param {string} [payload.notes]
 * @param {Array<{line_id:number, qty:number, heat_no?:string, batch_no?:string}>} payload.lines
 */
export async function receiveAgainstOrder(companyId, poId, payload = {}) {
  const rows = (Array.isArray(payload.lines) ? payload.lines : [])
    .map((l) => ({ ...l, line_id: Number(l.line_id), qty: Number(l.qty) }))
    .filter((l) => Number.isFinite(l.line_id) && l.qty > 0);
  if (!rows.length) throw new Error('Enter a quantity against at least one line');

  const [[po]] = await pool.query(
    `SELECT id, order_number, status FROM fab_orders
      WHERE id = ? AND company_id = ? AND order_type = 'purchase' AND deleted_at IS NULL
      LIMIT 1`,
    [poId, companyId],
  );
  if (!po) throw new Error('Purchase order not found');
  if (po.status === PO_STATUS.CANCELLED) throw new Error('That purchase order is cancelled');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const received = [];
    // Accumulated across lines because each receiveStock call reports the tasks
    // IT unblocked; the person receiving cares how many the DELIVERY unblocked.
    const tasksCleared = new Set();

    for (const l of rows) {
      const res = await receiveLineWithin(conn, companyId, l.line_id, {
        plant_id: payload.plant_id,
        stock_location_id: payload.stock_location_id,
        received_date: payload.received_date,
        notes: payload.notes ?? null,
        pieces: Array.isArray(l.pieces) && l.pieces.length
          ? l.pieces
          : [{ qty: l.qty, heat_no: l.heat_no ?? null, batch_no: l.batch_no ?? null }],
      });
      // Every line must belong to the order named in the URL — otherwise a
      // hand-made request could close a line on somebody else's order and
      // report success under this one's number.
      if (Number(res.orderId) !== Number(poId)) {
        throw new Error(`Line ${l.line_id} does not belong to ${po.order_number}`);
      }
      (res.stock?.tasksCleared ?? []).forEach((t) => tasksCleared.add(t));
      received.push({ lineId: l.line_id, qty: res.qtyReceived });
    }

    const poStatus = await syncPoStatus(conn, companyId, poId);
    await conn.commit();
    return {
      poId, poStatus, orderNumber: po.order_number,
      lines: received,
      qtyTotal: received.reduce((a, r) => a + r.qty, 0),
      tasksCleared: [...tasksCleared],
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Purchase orders that can still be received against, newest first.
 *
 * Not scoped to a sales order, unlike procurementForOrder: the person at the
 * gate receiving a delivery knows the PO number on the note and nothing about
 * which sales order caused it.
 */
export async function openPurchaseOrders(companyId, { includeClosed = false } = {}) {
  const [rows] = await pool.query(
    `SELECT o.id, o.order_number, o.status, o.supplier_id, s.name AS supplier_name,
            o.required_date, o.created_at, o.source_order_id, so.order_number AS source_order_number,
            COUNT(ol.id)                      AS line_count,
            COALESCE(SUM(ol.qty), 0)          AS qty_ordered,
            COALESCE(SUM(ol.qty_received), 0) AS qty_received
       FROM fab_orders o
       LEFT JOIN fab_suppliers s  ON s.id = o.supplier_id
       LEFT JOIN fab_orders so    ON so.id = o.source_order_id AND so.deleted_at IS NULL
       LEFT JOIN fab_order_lines ol ON ol.order_id = o.id AND ol.deleted_at IS NULL
      WHERE o.company_id = ? AND o.order_type = 'purchase' AND o.deleted_at IS NULL
        -- A request has no supplier yet, so nothing can arrive against it.
        AND o.status <> 'requested'
        ${includeClosed ? '' : `AND o.status NOT IN ('received', 'cancelled')`}
      GROUP BY o.id, o.order_number, o.status, o.supplier_id, s.name,
               o.required_date, o.created_at, o.source_order_id, so.order_number
      ORDER BY o.id DESC`,
    [companyId],
  );
  return rows;
}

/** One purchase order's lines, with what is still outstanding on each. */
export async function purchaseOrderLines(companyId, poId) {
  const [rows] = await pool.query(
    `SELECT ol.id, ol.line_no, ol.code, ol.description, ol.catalog_item_id,
            ol.qty, ol.qty_received, ol.unit, ol.status, ol.expected_date,
            fic.code AS catalog_code, fic.name AS catalog_name, fic.unit AS catalog_unit
       FROM fab_order_lines ol
       JOIN fab_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
                        AND o.order_type = 'purchase' AND o.company_id = ol.company_id
       LEFT JOIN fab_item_catalog fic ON fic.id = ol.catalog_item_id AND fic.deleted_at IS NULL
      WHERE ol.order_id = ? AND ol.company_id = ? AND ol.deleted_at IS NULL
      ORDER BY ol.line_no, ol.id`,
    [poId, companyId],
  );
  return rows.map((r) => ({
    ...r,
    // Floored at zero: an over-received line has nothing outstanding, and a
    // negative "still to come" reads as the supplier owing us steel back.
    outstanding: Math.max(0, Number(r.qty ?? 0) - Number(r.qty_received ?? 0)),
  }));
}

/** Every purchase order raised for a sales order, with its receipt progress. */
/**
 * How much of each item this order has ON ORDER but not yet received.
 *
 * Needed because "short" and "still to buy" are different questions, and the
 * readiness strip was answering the first while claiming to answer the second:
 * its own text reads "covered by stock or on order", and the arithmetic only
 * ever looked at stock. So an order whose every shortage had a purchase order
 * against it stayed PARTIAL, and could not be confirmed until the steel
 * physically arrived — which is the wrong way round. Confirming is what tells
 * the shop the job is real; waiting for material is a stage that comes after it.
 *
 * RECEIVED QUANTITIES ARE SUBTRACTED, because those already became stock and are
 * counted there. Adding them again would cover a shortage twice.
 *
 * CANCELLED ORDERS ARE EXCLUDED. A cancelled purchase order covers nothing, and
 * one has already been cancelled on this data once.
 *
 * @returns {Promise<Map<number, number>>} catalog item id -> quantity outstanding
 */
export async function onOrderByItem(companyId, orderId, conn, { excludeOrderId = null } = {}) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT ol.catalog_item_id AS id,
            COALESCE(SUM(GREATEST(ol.qty - COALESCE(ol.qty_received, 0), 0)), 0) AS outstanding
       FROM fab_orders o
       JOIN fab_order_lines ol ON ol.order_id = o.id AND ol.deleted_at IS NULL
      WHERE o.company_id = ? AND o.source_order_id = ?
        AND o.order_type = 'purchase' AND o.deleted_at IS NULL
        AND o.status <> ? AND ol.catalog_item_id IS NOT NULL
        AND o.id <> ?
      GROUP BY ol.catalog_item_id`,
    [companyId, orderId, PO_STATUS.CANCELLED, excludeOrderId ?? 0],
  );
  return new Map(rows.map((r) => [Number(r.id), Number(r.outstanding) || 0]));
}

export async function procurementForOrder(companyId, orderId, conn) {
  const exec = conn ?? pool;
  const [orders] = await exec.query(
    `SELECT o.id, o.order_number, o.status, o.supplier_id, s.name AS supplier_name,
            o.required_date, o.created_at,
            COUNT(ol.id)                                   AS line_count,
            COALESCE(SUM(ol.qty), 0)                       AS qty_ordered,
            COALESCE(SUM(ol.qty_received), 0)              AS qty_received
       FROM fab_orders o
       LEFT JOIN fab_suppliers s ON s.id = o.supplier_id
       LEFT JOIN fab_order_lines ol ON ol.order_id = o.id AND ol.deleted_at IS NULL
      WHERE o.company_id = ? AND o.source_order_id = ?
        AND o.order_type = 'purchase' AND o.deleted_at IS NULL
      GROUP BY o.id, o.order_number, o.status, o.supplier_id, s.name, o.required_date, o.created_at
      ORDER BY o.id`,
    [companyId, orderId],
  );
  return orders;
}
