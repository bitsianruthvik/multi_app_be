/**
 * procurementShared.js — what purchase requests and RFQs already hold, per item
 * (init.sql §39). Its own file because purchaseService (the buy list) needs it
 * and procurementService imports purchaseService: the other way round would be
 * an import cycle.
 */

const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;

/** A request still being handled: its open lines count as "in request". */
export const OPEN_REQUEST_STATUSES = ['draft', 'submitted', 'approved'];
/** An RFQ still being worked: its lines without a PO count as "in RFQ". */
export const OPEN_RFQ_STATUSES = ['draft', 'sent'];

/**
 * Map itemId -> { inRequest, inRfq, requests: [{ id, code }], rfqs: [{ id, code }] }
 * for the given items (all items when itemIds is null). "In request" = request
 * lines with status open in a draft / submitted / approved request; "in RFQ" =
 * request lines with status in_rfq. Ordered lines are on a PO and so already in
 * the buy list's on-order. ONE read whatever the number of items.
 *
 * The RFQ is reached by a nested join (no subquery inside an ON — TiDB refuses
 * that): the request line's RFQ line on an RFQ that is still open.
 */
export async function inProcurementByItem(db, companyId, itemIds = null) {
  const out = new Map();
  if (itemIds && !itemIds.length) return out;
  const [rows] = await db.query(
    `SELECT l.id, l.item_id, l.status, l.quantity, r.id AS request_id, r.code AS request_code,
            q.id AS rfq_id, q.code AS rfq_code
       FROM cf_purchase_request_lines l
       JOIN cf_purchase_requests r ON r.id = l.request_id AND r.deleted_at IS NULL
       LEFT JOIN (cf_rfq_lines rl JOIN cf_rfqs q ON q.id = rl.rfq_id AND q.deleted_at IS NULL AND q.status IN (?))
              ON rl.request_line_id = l.id AND rl.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL
        ${itemIds ? 'AND l.item_id IN (?)' : ''}
        AND ((l.status = 'open' AND r.status IN (?)) OR l.status = 'in_rfq')`,
    itemIds
      ? [OPEN_RFQ_STATUSES, companyId, itemIds, OPEN_REQUEST_STATUSES]
      : [OPEN_RFQ_STATUSES, companyId, OPEN_REQUEST_STATUSES],
  );
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) continue;                      // one RFQ line per request line, but be safe
    seen.add(r.id);
    const e = out.get(r.item_id) ?? { inRequest: 0, inRfq: 0, requests: [], rfqs: [] };
    if (r.status === 'in_rfq') e.inRfq = round6(e.inRfq + Number(r.quantity));
    else e.inRequest = round6(e.inRequest + Number(r.quantity));
    if (!e.requests.some((x) => x.id === r.request_id)) e.requests.push({ id: r.request_id, code: r.request_code });
    if (r.rfq_id && !e.rfqs.some((x) => x.id === r.rfq_id)) e.rfqs.push({ id: r.rfq_id, code: r.rfq_code });
    out.set(r.item_id, e);
  }
  return out;
}
