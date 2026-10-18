/**
 * procurementService.js — what is left of the §39 purchase request → RFQ → quotes → award flow
 * (init.sql §39, TM/CF_ERP_PROCUREMENT_PLAN.md).
 *
 * PURCHASE FLOW v3 (§71, 2026-10-18, user-approved clean-up): the separate §39 purchase requests and RFQs are gone —
 * their screens, routes and services. The MR → PR (the PR IS the RFQ: vendor columns, quotes in the cells) → PO flow
 * replaces them (purchaseRequestService.js). The tables (cf_purchase_requests, cf_rfqs, cf_quotes …) and their rows stay,
 * readable; the buy list still says what sits in an old open request / RFQ (procurementShared.inProcurementByItem).
 *
 * Kept: the status words (GET /meta) and the parties module's reference check — a supplier on an old RFQ, or a vendor
 * column of a PR, is not deleted.
 */
export const PR_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'closed', 'cancelled'];
export const RFQ_STATUSES = ['draft', 'sent', 'closed', 'awarded', 'cancelled'];
export const RFQ_SUPPLIER_STATUSES = ['invited', 'sent', 'quoted', 'declined'];

/** Party references for the parties module: a supplier on an RFQ, or a vendor column of a purchase request, stays. */
export async function procurementPartyReferences(db, companyId, partyId) {
  const [[rows], [cols]] = await Promise.all([
    db.query(
      `SELECT DISTINCT r.code FROM cf_rfq_suppliers s JOIN cf_rfqs r ON r.id = s.rfq_id AND r.deleted_at IS NULL
        WHERE s.company_id = ? AND s.supplier_id = ? ORDER BY r.code DESC LIMIT 6`,
      [companyId, partyId],
    ),
    db.query(
      `SELECT DISTINCT b.code FROM cf_buy_request_vendors v JOIN cf_buy_requests b ON b.id = v.request_id AND b.deleted_at IS NULL
        WHERE v.company_id = ? AND v.supplier_id = ? AND v.deleted_at IS NULL ORDER BY b.code DESC LIMIT 6`,
      [companyId, partyId],
    ).catch(() => [[]]),
  ]);
  const out = [];
  if (rows.length) out.push(`it is a supplier on ${rows.map((r) => r.code).join(', ')}`);
  if (cols.length) out.push(`it is a vendor on ${cols.map((r) => r.code).join(', ')}`);
  return out;
}
