/**
 * customerMaterialService.js — CF_ERP. The customer's own material after it arrives (init.sql §66 / §68,
 * 2026-10-16; contract TM/CF_ERP_BUYING_V2.md "2026-10-16 (2)").
 *
 *   SUBSTITUTE   a receipt on a customer-supplied PO may be a DIFFERENT item than the PO line ("the customer
 *                sent 12 mm instead of 11 mm"), with a reason. The lot is the customer's and earmarked to the MR
 *                line as usual (purchaseService.receiveLine → holdOnReceipt, with the item received), but it is
 *                ON HOLD — production cannot use it — and a plate-change request (kind 'substitute') goes to the MD.
 *                  approved            the substitution is recorded, the lot is usable. Nothing else is automatic:
 *                                      re-nesting the line to the new plate is its own request.
 *                  rejected / withdrawn the lot stays the customer's, on hold, flagged RETURN TO CUSTOMER, and
 *                                      its earmark is let go.
 *                An ordinary supplier's PO keeps refusing a different item (it never comes here).
 *   TO RETURN    worked out on every read, nothing stored: per order and item, the customer's lots for that
 *                order that are FREE (not earmarked, reserved or issued) beyond what the order still needs
 *                (open on its MRs + the need of its lines with no MR yet) — EXTRA material, and every lot of a
 *                rejected substitute. When the stock leaves (the existing "return to customer" movement) the row
 *                is gone on the next read: returning it clears the flag.
 */
import { invalid } from '../lib/errors.js';
import { lineReadiness, OPEN_ORDER_STATUSES } from './materialReadyService.js';

const EPS = 1e-6;
const r6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const fmt = (n) => String(Number(Number(n).toFixed(3)));
const DENSITY = 7850;

/** Code, name, unit, tracking and plate size of some items (2 reads). kgEach null when the size is not known. */
export async function itemFacts(db, companyId, ids) {
  const out = new Map();
  const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return out;
  const [[rows], [vals]] = await Promise.all([
    db.query(
      `SELECT m.id, m.code, m.name, m.status, i.uom, i.tracked_by, i.item_type FROM cf_master_records m
         LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
        WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`, [companyId, list]),
    db.query(
      `SELECT v.subject_id, UPPER(s.code) AS code, v.value_number FROM cf_spec_values v
         JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL
          AND s.code IN ('THICKNESS','LENGTH','WIDTH','DENSITY') AND v.value_number IS NOT NULL`, [companyId, list]),
  ]);
  const spec = new Map();
  for (const v of vals) { if (!spec.has(v.subject_id)) spec.set(v.subject_id, {}); spec.get(v.subject_id)[v.code] = Number(v.value_number); }
  for (const r of rows) {
    const s = spec.get(r.id) ?? {};
    const sized = s.THICKNESS > 0 && s.LENGTH > 0 && s.WIDTH > 0;
    out.set(Number(r.id), {
      id: Number(r.id), code: r.code ?? null, name: r.name ?? null, status: r.status, uom: r.uom ?? null, trackedBy: r.tracked_by ?? null, itemType: r.item_type ?? null,
      thickness: s.THICKNESS ?? null, length: s.LENGTH ?? null, width: s.WIDTH ?? null,
      kgEach: sized ? r6((s.THICKNESS * s.LENGTH * s.WIDTH * (s.DENSITY || DENSITY)) / 1e9) : null,
    });
  }
  return out;
}

const sizeOf = (f) => (f?.thickness ? ` (${fmt(f.thickness)} mm${f.length && f.width ? ` × ${fmt(f.length)} × ${fmt(f.width)}` : ''})` : '');
export const itemWords = (f) => `${f?.code ?? f?.name ?? 'item'}${sizeOf(f)}`;

/**
 * Checks a substitute before the receipt is posted. Returns { ordered, received, share } or pushes problems.
 * `share` = the MR share the PO line serves first (the order line the request is about).
 */
export async function checkSubstitute(db, companyId, l, input, problems) {
  const subId = Number(input.substituteItemId);
  if (!Number(l.supplied_by_customer ?? 0)) {
    problems.push(`${l.po_code} is a supplier's purchase order — only the item ordered can be received on it. A different item is taken only on a customer's own purchase order.`);
    return null;
  }
  if (!Number.isInteger(subId) || subId <= 0) { problems.push('Say which item the customer sent.'); return null; }
  if (subId === Number(l.item_id)) { problems.push('That is the item ordered — receive it as it is, with no substitute.'); return null; }
  const reason = String(input.substituteReason ?? input.reason ?? '').trim();
  if (!reason) problems.push('Say why a different item came — for example "customer sent 12 mm instead of 11 mm".');
  const facts = await itemFacts(db, companyId, [l.item_id, subId]);
  const received = facts.get(subId);
  if (!received) { problems.push('The item the customer sent does not exist.'); return null; }
  if (received.itemType !== 'catalog') problems.push(`${received.code}: only a catalog item can be received.`);
  if (received.trackedBy === 'individual') problems.push(`${received.code}: it is tracked unit by unit — receive it on its own.`);
  if (received.status === 'obsolete') problems.push(`${received.code}: the item is obsolete.`);
  const [[share]] = await db.query(
    `SELECT a.order_id, a.pr_line_id, prl.order_line_id, o.code AS order_code, sl.line_no, rq.code AS mr_code
       FROM cf_purchase_line_orders a
       JOIN cf_sales_orders o ON o.id = a.order_id
       LEFT JOIN cf_requisition_lines prl ON prl.id = a.pr_line_id AND prl.deleted_at IS NULL
       LEFT JOIN cf_requisitions rq ON rq.id = prl.requisition_id AND rq.deleted_at IS NULL
       LEFT JOIN cf_sales_order_lines sl ON sl.id = prl.order_line_id
      WHERE a.company_id = ? AND a.purchase_line_id = ? AND a.deleted_at IS NULL AND a.quantity > a.qty_received
      ORDER BY a.id LIMIT 1`, [companyId, l.id]);
  if (!share?.order_line_id) problems.push(`${l.po_code}: this line is not bought for a material request still waiting for it — a substitute is taken only for an MR.`);
  else {
    const { holdingRequestOf } = await import('./plateChangeService.js');
    const held = await holdingRequestOf(db, companyId, share.order_line_id);
    if (held) problems.push(`Plate change ${held.code} is already waiting on ${share.order_code} line ${share.line_no} — it is decided first, then the substitute can be taken.`);
  }
  return { ordered: facts.get(Number(l.item_id)), received, share: share ?? null, reason };
}

/**
 * After the substitute's receipt is posted and earmarked: the lot goes ON HOLD, the substitution is recorded,
 * and the MD's request is made. Returns { substitution, plateChange }.
 */
export async function recordSubstitute(db, c, { l, check, quantity, movementId, batchId }) {
  const { ordered, received, share, reason } = check;
  const [ins] = await db.query(
    `INSERT INTO cf_po_substitutions (company_id, purchase_order_id, purchase_line_id, order_id, order_line_id, pr_line_id, ordered_item_id, received_item_id,
                                      batch_id, movement_id, quantity, reason, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [c.companyId, l.purchase_order_id, l.id, share.order_id, share.order_line_id, share.pr_line_id, ordered.id, received.id, batchId, movementId, quantity, reason.slice(0, 1000), c.userId ?? null],
  );
  const { requestSubstitute } = await import('./plateChangeService.js');
  const request = await requestSubstitute(db, c, {
    lineId: share.order_line_id, reason,
    substitute: { id: ins.insertId, purchaseOrder: { id: l.purchase_order_id, code: l.po_code }, mr: share.mr_code, ordered, received, quantity, batchId },
  });
  await db.query('UPDATE cf_po_substitutions SET request_id = ? WHERE company_id = ? AND id = ?', [request.id, c.companyId, ins.insertId]);
  if (batchId) {
    await db.query("UPDATE cf_stock_batches SET status = 'on_hold', status_note = ? WHERE company_id = ? AND id = ?",
      [`Substitute for ${ordered.code} on ${l.po_code} — waiting for the MD (${request.code}). Production cannot use it yet.`.slice(0, 255), c.companyId, batchId]);
  }
  return {
    substitution: { id: ins.insertId, status: 'pending', ordered, received, quantity, reason },
    plateChange: { id: request.id, code: request.code },
    message: `${fmt(quantity)} × ${itemWords(received)} received in place of ${itemWords(ordered)}. It is held until the MD approves ${request.code}.`,
  };
}

/**
 * The MD's decision on a substitute (plateChangeService calls this): approved → the lot is usable; rejected or
 * withdrawn → it stays on hold, flagged "return to customer", and its earmark is let go. 3–4 statements.
 */
export async function decideSubstitute(db, c, requestId, decision, code) {
  const [[s]] = await db.query('SELECT * FROM cf_po_substitutions WHERE company_id = ? AND request_id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(requestId)]);
  if (!s) throw invalid('NOT_FOUND', `${code} has no substitute receipt recorded.`);
  const approved = decision === 'approved';
  await db.query('UPDATE cf_po_substitutions SET status = ?, decided_by = ?, decided_at = NOW() WHERE company_id = ? AND id = ?',
    [approved ? 'approved' : 'rejected', c.userId ?? null, c.companyId, s.id]);
  if (!s.batch_id) return s;
  if (approved) {
    await db.query("UPDATE cf_stock_batches SET status = 'available', status_note = ? WHERE company_id = ? AND id = ?",
      [`Customer's substitute, approved (${code}).`, c.companyId, s.batch_id]);
  } else {
    await db.query("UPDATE cf_stock_batches SET status = 'on_hold', status_note = ? WHERE company_id = ? AND id = ?",
      [`Return to customer — the substitute was not accepted (${code}).`, c.companyId, s.batch_id]);
    await db.query(
      "UPDATE cf_stock_reservations SET status = 'released', closed_at = NOW() WHERE company_id = ? AND batch_id = ? AND held_for_order_id IS NOT NULL AND status = 'active'",
      [c.companyId, s.batch_id]);
  }
  return s;
}

/**
 * GET /customer-material/returns?orderId=&partyId= — what is to go back to customers, and the substitutes.
 *   toReturn:    [{ party, order, item, batch, quantity, uom, why: 'extra' | 'substitute_rejected', text }]
 *   substitutes: [{ id, status, order, line, purchaseOrder, ordered, received, quantity, batch, reason, request, text }]
 * Fixed: 4 reads + the engine (only when some customer lot is free).
 */
export async function customerReturns(db, companyId, q = {}) {
  const orderId = q.orderId == null || q.orderId === '' ? null : Number(q.orderId);
  const partyId = q.partyId == null || q.partyId === '' ? null : Number(q.partyId);
  const scope = [];
  const args = [companyId];
  if (orderId) { scope.push('so.code_active = (SELECT x.code_active FROM cf_sales_orders x WHERE x.id = ?)'); args.push(orderId); }
  if (partyId) { scope.push('b.owner_party_id = ?'); args.push(partyId); }
  const [lots] = await db.query(
    `SELECT b.id AS batch_id, b.code AS batch_code, b.item_id, b.status, b.owner_party_id, b.owner_order_id, p.name AS party_name,
            so.code AS order_code, so.status AS order_status, m.code AS item_code, m.name AS item_name, i.uom,
            SUM(k.quantity) AS on_hand,
            (SELECT COALESCE(SUM(v.quantity), 0) FROM cf_stock_reservations v
              WHERE v.company_id = b.company_id AND v.batch_id = b.id AND v.status = 'active' AND v.deleted_at IS NULL) AS claimed
       FROM cf_stock_balances k
       JOIN cf_stock_batches b ON b.id = k.batch_id AND b.owner_party_id IS NOT NULL AND b.deleted_at IS NULL
       LEFT JOIN cf_sales_orders so ON so.id = b.owner_order_id
       LEFT JOIN cf_parties p ON p.id = b.owner_party_id
       JOIN cf_master_records m ON m.id = b.item_id
       LEFT JOIN cf_item_details i ON i.master_id = b.item_id AND i.deleted_at IS NULL
      WHERE k.company_id = ? AND k.quantity > 0 ${scope.length ? `AND ${scope.join(' AND ')}` : ''}
      GROUP BY b.id, b.code, b.item_id, b.status, b.owner_party_id, b.owner_order_id, p.name, so.code, so.status, m.code, m.name, i.uom
      ORDER BY b.id`,
    args,
  );
  const [subs] = await db.query(
    `SELECT s.*, o.code AS order_code, sl.line_no, po.code AS po_code, r.code AS request_code, r.status AS request_status,
            om.code AS ordered_code, om.name AS ordered_name, rm.code AS received_code, rm.name AS received_name, b.code AS batch_code
       FROM cf_po_substitutions s
       LEFT JOIN cf_sales_orders o ON o.id = s.order_id
       LEFT JOIN cf_sales_order_lines sl ON sl.id = s.order_line_id
       LEFT JOIN cf_purchase_orders po ON po.id = s.purchase_order_id
       LEFT JOIN cf_plate_change_requests r ON r.id = s.request_id
       LEFT JOIN cf_master_records om ON om.id = s.ordered_item_id
       LEFT JOIN cf_master_records rm ON rm.id = s.received_item_id
       LEFT JOIN cf_stock_batches b ON b.id = s.batch_id
      WHERE s.company_id = ? AND s.deleted_at IS NULL ${orderId ? 'AND o.code_active = (SELECT x.code_active FROM cf_sales_orders x WHERE x.id = ?)' : ''}
      ORDER BY s.id`,
    orderId ? [companyId, orderId] : [companyId],
  );
  const subByBatch = new Map(subs.filter((s) => s.batch_id).map((s) => [Number(s.batch_id), s]));
  const toReturn = [];
  // Rejected substitutes: every piece of them still here goes back.
  for (const lot of lots) {
    const s = subByBatch.get(Number(lot.batch_id));
    if (s?.status === 'rejected') {
      toReturn.push(rowOf(lot, r6(lot.on_hand), 'substitute_rejected', `Not accepted in place of ${s.ordered_code ?? 'the item ordered'} (${s.request_code}).`));
    }
  }
  // EXTRA: free customer lots of an order beyond what the order still needs.
  const free = lots.filter((lot) => lot.status === 'available' && !subByBatch.has(Number(lot.batch_id)) && Number(lot.on_hand) - Number(lot.claimed) > EPS);
  if (free.length) {
    const R = await lineReadiness(db, companyId, { full: true });
    const orderKeys = new Set(free.map((x) => String(x.order_code ?? '').toLowerCase()));
    // What each order (by number) still needs per item: open on its MRs, or the need of a line with no MR.
    const [mrOpen] = await db.query(
      `SELECT LOWER(o.code) AS order_key, pl.order_line_id, pl.item_id FROM cf_requisition_lines pl
         JOIN cf_requisitions r ON r.id = pl.requisition_id AND r.deleted_at IS NULL
         JOIN cf_sales_orders o ON o.id = r.order_id
        WHERE pl.company_id = ? AND pl.deleted_at IS NULL AND LOWER(o.code) IN (?)`,
      [companyId, [...orderKeys]],
    );
    const stillNeeds = new Map();
    const add = (k, q) => stillNeeds.set(k, r6((stillNeeds.get(k) ?? 0) + q));
    for (const l of R.lines) {
      const key = String(l.order_code ?? '').toLowerCase();
      if (!orderKeys.has(key) || !OPEN_ORDER_STATUSES.includes(l.order_status)) continue;
      const n = R.needs.get(Number(l.id));
      if (!n?.known) continue;
      const res = R.byLine.get(Number(l.id));
      for (const [itemId, e] of n.items) {
        const onMr = mrOpen.some((x) => Number(x.order_line_id) === Number(l.id) && Number(x.item_id) === itemId);
        // On an MR: what is not covered yet (the engine's short + what its free cover leans on). Without one: the need.
        const reason = (res?.reasons ?? []).find((x) => Number(x.item.id) === itemId);
        const uncovered = reason ? reason.cover.filter((x) => x.kind === 'none' || x.kind === 'free').reduce((t, x) => t + x.qty, 0) : 0;
        add(`${key}:${itemId}`, onMr ? uncovered : Math.max(0, e.need - e.issued - e.reserved));
      }
    }
    const byKey = new Map();
    for (const lot of free) {
      const k = `${String(lot.order_code ?? '').toLowerCase()}:${lot.item_id}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(lot);
    }
    for (const [k, list] of byKey) {
      let keep = stillNeeds.get(k) ?? 0;
      // The oldest lots are kept for the need; the newest are the extra.
      for (const lot of list) {
        const f = r6(Number(lot.on_hand) - Number(lot.claimed));
        const kept = Math.min(keep, f);
        keep = r6(keep - kept);
        const extra = r6(f - kept);
        if (extra > EPS) toReturn.push(rowOf(lot, extra, 'extra', `More than ${lot.order_code ?? 'the order'} needs — not earmarked.`));
      }
    }
  }
  return {
    toReturn,
    substitutes: subs.map((s) => ({
      id: s.id, status: s.status,
      statusLabel: s.status === 'pending' ? 'Waiting for the MD — on hold' : s.status === 'approved' ? 'Approved — usable' : 'Not accepted — return to customer',
      order: s.order_id ? { id: s.order_id, code: s.order_code } : null, line: s.order_line_id ? { id: s.order_line_id, lineNo: s.line_no } : null,
      purchaseOrder: { id: s.purchase_order_id, code: s.po_code },
      ordered: { id: s.ordered_item_id, code: s.ordered_code, name: s.ordered_name },
      received: { id: s.received_item_id, code: s.received_code, name: s.received_name },
      quantity: Number(s.quantity), batch: s.batch_id ? { id: s.batch_id, code: s.batch_code } : null, reason: s.reason,
      request: s.request_id ? { id: s.request_id, code: s.request_code, status: s.request_status } : null,
      text: `${fmt(s.quantity)} × ${s.received_code} in place of ${s.ordered_code} on ${s.po_code}${s.status === 'pending' ? ` — held until the MD approves ${s.request_code}` : s.status === 'approved' ? ` — approved (${s.request_code})` : ` — not accepted (${s.request_code}): return it to the customer`}.`,
    })),
  };
}

function rowOf(lot, quantity, why, text) {
  return {
    party: { id: lot.owner_party_id, name: lot.party_name ?? null },
    order: lot.owner_order_id ? { id: lot.owner_order_id, code: lot.order_code } : null,
    item: { id: lot.item_id, code: lot.item_code, name: lot.item_name, uom: lot.uom ?? null },
    batch: { id: lot.batch_id, code: lot.batch_code, status: lot.status },
    quantity, why, text,
  };
}
