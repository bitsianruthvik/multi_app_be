/**
 * costingService.js — ACCOUNTS › ORDER COSTING (init.sql §74). One row per sales order, opened as a cost sheet.
 *
 *   Charged so far   what the order has EARNED by its accepted charges (not what is invoiced):
 *                      a charge billed pro-rata   = its quantity (weight or formula, from the approved estimate) × the
 *                                                   share of the work through its operation × the rate;
 *                      a charge on completion     = all of it once its operation is complete for the order, else 0;
 *                      the material row           = its amount × the share of the material in place;
 *                      a lump sum                 = all of it once everything is dispatched.
 *   Material         plates / sections / bought parts the order used, at cost (valuationService.orderCostSheets);
 *                    the customer's material at ₹0 (its quantity shown).
 *   Consumables      issues from stock "Used for" the order that are not MR material.
 *   Contractor work  what was PAID to contractors on the order's work orders (Step 6, §85: contractorCostOf).
 *   Credits          scrap at the scrap rate + offcuts back to stock.
 *   MARGIN           = Charged so far − Material − Consumables − Contractor work + Credits; % of Charged so far.
 * The per-line nest figures of the order page (valuationService.orderCosts) come with the sheet as its detail.
 */
import { notFound } from '../lib/errors.js';
import { round2 } from './priceService.js';
import { orderCosts, orderCostSheets } from './valuationService.js';
import { billingFacts, cardsOf, todayText } from './billingService.js';
import { contractorCostOf } from './contractorWorkOrderService.js';

const EPS = 1e-6;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/** What an order has earned by its charges (pure over billingFacts' row and its progress). */
export function earnedOf(F, P) {
  const terms = F.terms ?? {};
  const est = F.estimate ?? {};
  const rows = [];
  for (const ch of terms.charges ?? []) {
    const e = (est.charges ?? []).find((x) => x.key === ch.key) ?? {};
    const qty = Number(e.quantity ?? 0);
    const p = P.ops.get(Number(ch.operationId));
    const share = p ? p.done : 0;
    const earnedQty = ch.billing === 'on_completion' ? (share >= 1 - EPS ? qty : 0) : qty * share;
    rows.push({
      key: ch.key, label: ch.label, kind: 'charge', operation: F.opName.get(Number(ch.operationId)) ?? null, billing: ch.billing,
      quantity: round3(qty), earnedQuantity: round3(earnedQty), unit: e.unit ?? (ch.basis?.type === 'weight' ? 't' : ch.basis?.unit ?? null), rate: ch.rate,
      amount: round2(earnedQty * Number(ch.rate ?? 0)), contract: round2(qty * Number(ch.rate ?? 0)),
      note: ch.billing === 'on_completion' ? (share >= 1 - EPS ? 'Operation complete' : `On completion — ${Math.round(share * 100)} % through so far`) : `${Math.round(share * 100)} % through ${F.opName.get(Number(ch.operationId)) ?? 'the operation'}`,
    });
  }
  if (est.material?.amount) {
    rows.push({ key: 'material', label: 'Material', kind: 'material', quantity: est.material.quantity, earnedQuantity: round3(Number(est.material.quantity ?? 0) * P.materialShare), unit: 't', rate: est.material.rate,
      amount: round2(Number(est.material.amount) * P.materialShare), contract: round2(est.material.amount), note: `${Math.round(P.materialShare * 100)} % of the material in place` });
  }
  for (const l of est.lumpSums ?? []) {
    rows.push({ key: l.key, label: l.label, kind: 'lump_sum', quantity: null, earnedQuantity: null, unit: null, rate: null,
      amount: P.fullyOn ? round2(l.amount) : 0, contract: round2(l.amount), note: P.fullyOn ? 'Everything dispatched' : 'When everything is dispatched' });
  }
  return { rows, total: round2(rows.reduce((t, r) => t + r.amount, 0)), contract: round2(Number(est.value ?? 0)) };
}

function sheetRow(F, P, s, summary, cw = null) {
  const earned = earnedOf(F, P);
  const material = s?.material ?? 0;
  const consumables = s?.consumables ?? 0;
  const contractor = cw?.paid ?? 0;
  const credits = s?.credits?.total ?? 0;
  const margin = round2(earned.total - material - consumables - contractor + credits);
  return {
    order: { id: F.order.id, code: F.order.code, title: F.order.title, status: F.order.status, customer: F.order.customer },
    contract: earned.contract, charged: earned.total, invoiced: summary.billed, received: summary.received,
    material, consumables, contractor, credits, creditsScrap: s?.credits?.scrap ?? 0, creditsOffcuts: s?.credits?.offcuts ?? 0,
    customerMaterial: s?.customer ?? { rows: 0, quantity: 0 }, uncostedRows: s?.uncostedRows ?? 0,
    margin, marginPct: earned.total > EPS ? round2((margin / earned.total) * 100) : null,
    contractorWork: cw ?? { paid: 0, doneValue: 0, committed: 0, workOrders: [] },
    earned,
  };
}

/** GET /accounts/costing?search= — one row per accepted customer order (confirmed, or closed in 180 days). Fixed reads. */
export async function costingList(db, companyId, q = {}) {
  const facts = await billingFacts(db, companyId, { search: q.search });
  const [sheets, cws] = await Promise.all([orderCostSheets(db, companyId, facts.map((F) => F.order.id)), contractorCostOf(db, companyId, facts.map((F) => F.order.id))]);
  const today = todayText();
  const rows = facts.map((F) => {
    const { summary, progress } = cardsOf(F, today);
    const { earned, contractorWork, ...row } = sheetRow(F, progress, sheets.get(F.order.id), summary, cws.get(F.order.id));
    return row;
  });
  const [[general]] = await db.query(
    `SELECT COALESCE(-SUM(l.value), 0) AS value, SUM(l.value IS NULL) AS uncosted FROM cf_stock_ledger l JOIN cf_stock_movements m ON m.id = l.movement_id
      WHERE l.company_id = ? AND m.movement_type = 'issue' AND m.used_for = 'general' AND m.deleted_at IS NULL AND m.movement_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
    [companyId],
  );
  const sum = (k) => round2(rows.reduce((t, r) => t + Number(r[k] ?? 0), 0));
  return {
    rows,
    totals: { contract: sum('contract'), charged: sum('charged'), material: sum('material'), consumables: sum('consumables'), contractor: sum('contractor'), credits: sum('credits'), margin: sum('margin') },
    generalThisMonth: { value: round2(Number(general?.value ?? 0)), uncostedRows: Number(general?.uncosted ?? 0) },
  };
}

/** GET /accounts/costing/:orderId — the cost sheet of one order: the row, what each charge earned, the items, and the
 *  per-line nest figures (valuationService.orderCosts). */
export async function costSheet(db, companyId, orderId) {
  const facts = await billingFacts(db, companyId, { orderIds: [Number(orderId)] });
  const [sheets, detail, cws] = await Promise.all([orderCostSheets(db, companyId, [Number(orderId)]), orderCosts(db, companyId, orderId), contractorCostOf(db, companyId, [Number(orderId)])]);
  const cw = cws.get(Number(orderId));
  const F = facts[0];
  const s = sheets.get(Number(orderId));
  if (!F) {
    // No accepted terms: nothing is charged yet, the costs still are.
    const [[o]] = await db.query('SELECT o.id, o.code, o.title, o.status, p.name AS customer_name FROM cf_sales_orders o LEFT JOIN cf_parties p ON p.id = o.customer_id WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL', [companyId, Number(orderId)]);
    if (!o) throw notFound('Sales order');
    const material = s?.material ?? 0; const consumables = s?.consumables ?? 0; const credits = s?.credits?.total ?? 0; const contractor = cw?.paid ?? 0;
    return {
      order: { id: o.id, code: o.code, title: o.title ?? null, status: o.status, customer: o.customer_name ?? null }, hasTerms: false,
      contract: 0, charged: 0, invoiced: 0, received: 0, material, consumables, contractor, contractorWork: cw, credits, creditsScrap: s?.credits?.scrap ?? 0, creditsOffcuts: s?.credits?.offcuts ?? 0,
      customerMaterial: s?.customer ?? { rows: 0, quantity: 0 }, uncostedRows: s?.uncostedRows ?? 0,
      margin: round2(-material - consumables - contractor + credits), marginPct: null, earned: { rows: [], total: 0, contract: 0 }, items: s?.items ?? [], lines: detail.lines, totals: detail.totals,
    };
  }
  const { summary, progress } = cardsOf(F, todayText());
  return { ...sheetRow(F, progress, s, summary, cw), hasTerms: true, items: s?.items ?? [], lines: detail.lines, totals: detail.totals };
}

