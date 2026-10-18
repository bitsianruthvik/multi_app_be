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
 *
 * SCRAP & OFFCUTS (2026-10-18): the order's ACTUAL scrap kg (receipts into the SCRAP area) and offcut kg (the offcut
 * lots cutting made from its plates) with their value, against what the acceptance CHARGES the customer for them (a
 * charge with basis scrap / offcut kg or % of material: its estimate, what it has earned, and the actual kg at its rate).
 * NEVER ₹0 SILENTLY: `flags` names what is not costed — scrap with no scrap rate, stock with no cost (no plate rate) —
 * each with where to fix it ({ label, to } relative to /:company/cf_erp/).
 */
import { notFound } from '../lib/errors.js';
import { round2 } from './priceService.js';
import { orderCosts, orderCostSheets } from './valuationService.js';
import { billingFacts, cardsOf, todayText } from './billingService.js';
import { contractorCostOf } from './contractorWorkOrderService.js';
import { scrapRate } from './scrapService.js';

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
    // A % of the material (scrap & offcuts) is quantity ₹ × rate %; every other basis is quantity × rate.
    const per = ch.basis?.type === 'scrap' && ch.basis.of === 'material_pct' ? Number(ch.rate ?? 0) / 100 : Number(ch.rate ?? 0);
    rows.push({
      key: ch.key, label: ch.label, kind: ch.basis?.type === 'scrap' ? 'scrap_charge' : 'charge', scrapOf: ch.basis?.type === 'scrap' ? ch.basis.of : undefined,
      operation: F.opName.get(Number(ch.operationId)) ?? null, billing: ch.billing,
      quantity: round3(qty), earnedQuantity: round3(earnedQty), unit: e.unit ?? (ch.basis?.type === 'weight' ? 't' : ch.basis?.unit ?? null), rate: ch.rate,
      amount: round2(earnedQty * per), contract: round2(qty * per),
      note: ch.billing === 'on_completion' ? (share >= 1 - EPS ? 'Operation complete' : `On completion — ${Math.round(share * 100)} % through so far`) : `${Math.round(share * 100)} % through ${F.opName.get(Number(ch.operationId)) ?? 'the operation'}`,
    });
  }
  if (est.material?.amount) {
    // The material is earned once it is in place. "In place" is only OBSERVED for orders billed on a material_in_place
    // milestone (billingService.observeMaterial), so an order billed on dispatch never had it and earned ₹0 for its
    // material (SO260014, 2026-10-18). What has been dispatched certainly had its material: take the larger share.
    const shipped = Math.min(1, (P.shipments ?? []).reduce((t, s) => t + Number(s.frac ?? 0), 0));
    const share = Math.max(Number(P.materialShare ?? 0), shipped);
    rows.push({ key: 'material', label: 'Material', kind: 'material', quantity: est.material.quantity, earnedQuantity: round3(Number(est.material.quantity ?? 0) * share), unit: 't', rate: est.material.rate,
      amount: round2(Number(est.material.amount) * share), contract: round2(est.material.amount),
      note: share > Number(P.materialShare ?? 0) + EPS ? `${Math.round(share * 100)} % — its share dispatched` : `${Math.round(share * 100)} % of the material in place` });
  }
  for (const l of est.lumpSums ?? []) {
    rows.push({ key: l.key, label: l.label, kind: 'lump_sum', quantity: null, earnedQuantity: null, unit: null, rate: null,
      amount: P.fullyOn ? round2(l.amount) : 0, contract: round2(l.amount), note: P.fullyOn ? 'Everything dispatched' : 'When everything is dispatched' });
  }
  return { rows, total: round2(rows.reduce((t, r) => t + r.amount, 0)), contract: round2(Number(est.value ?? 0)) };
}

/**
 * The order's scrap & offcuts: actual kg and value (the cost sheet), what the acceptance charges for them, and the flags
 * for anything valued at nothing. Pure. rate = scrapService.scrapRate; earned = earnedOf (or null without terms).
 */
export function scrapOffcutsOf(s, rate, earned = null, terms = null) {
  const c = s?.credits ?? {};
  const actual = {
    scrapKg: round3(Number(c.scrapKg ?? 0)), scrapValue: round2(Number(c.scrap ?? 0)),
    offcutKg: round3(Number(c.offcutKg ?? 0)), offcutValue: round2(Number(c.offcuts ?? 0)), offcutLots: Number(c.offcutLots ?? 0),
  };
  const ratePerKg = rate?.ratePerKg ?? null;
  const charges = (earned?.rows ?? []).filter((r) => r.kind === 'scrap_charge').map((r) => {
    const ch = (terms?.charges ?? []).find((x) => x.key === r.key);
    const kg = r.scrapOf === 'offcut' ? actual.offcutKg : r.scrapOf === 'scrap' ? actual.scrapKg : null;
    return {
      key: r.key, label: r.label, of: r.scrapOf, estimate: r.quantity, unit: r.unit, rate: r.rate, contract: r.contract, earned: r.amount,
      // What the charge would come to on the kilograms actually made (kg bases only).
      actualKg: kg, onActual: kg == null || ch?.rate == null ? null : round2(kg * Number(ch.rate)),
    };
  });
  const flags = [];
  if (actual.scrapKg > EPS && ratePerKg == null) {
    flags.push({ code: 'NO_SCRAP_RATE', message: `Scrap ${actual.scrapKg} kg not costed — set the scrap rate.`, fix: { label: 'Setup › Cutting (scrap rate)', to: 'cutting' } });
  }
  const uncosted = (s?.items ?? []).filter((i) => Number(i.uncosted) > 0 && i.kind !== 'scrap');
  for (const i of uncosted.slice(0, 8)) {
    flags.push({ code: 'NOT_COSTED', message: `${i.code ?? i.name ?? `Item ${i.itemId}`}: ${i.uncosted} stock row${i.uncosted === 1 ? '' : 's'} not costed — set the plate rate (received with no price).`, fix: { label: 'Open the item', to: `items/${i.itemId}` } });
  }
  if (uncosted.length > 8) flags.push({ code: 'NOT_COSTED', message: `${uncosted.length - 8} more items not costed.`, fix: null });
  return {
    actual, ratePerKg, charges,
    charged: { contract: round2(charges.reduce((t, x) => t + (x.contract ?? 0), 0)), earned: round2(charges.reduce((t, x) => t + (x.earned ?? 0), 0)) },
    flags,
  };
}

function sheetRow(F, P, s, summary, cw = null, rate = null) {
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
    scrapOffcuts: scrapOffcutsOf(s, rate, earned, F.terms),
  };
}

/** GET /accounts/costing?search= — one row per accepted customer order (confirmed, or closed in 180 days). Fixed reads. */
export async function costingList(db, companyId, q = {}) {
  const facts = await billingFacts(db, companyId, { search: q.search });
  const [sheets, cws, rate] = await Promise.all([orderCostSheets(db, companyId, facts.map((F) => F.order.id)), contractorCostOf(db, companyId, facts.map((F) => F.order.id)), scrapRate(db, companyId)]);
  const today = todayText();
  const rows = facts.map((F) => {
    const { summary, progress } = cardsOf(F, today);
    const { earned, contractorWork, scrapOffcuts: so, ...row } = sheetRow(F, progress, sheets.get(F.order.id), summary, cws.get(F.order.id), rate);
    // The list keeps it short: the kilograms, what the charges earned for them, and how many things are not costed.
    return { ...row, scrapKg: so.actual.scrapKg, offcutKg: so.actual.offcutKg, scrapCharged: so.charged.earned, flags: so.flags.length };
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
  const [sheets, detail, cws, rate] = await Promise.all([orderCostSheets(db, companyId, [Number(orderId)]), orderCosts(db, companyId, orderId), contractorCostOf(db, companyId, [Number(orderId)]), scrapRate(db, companyId)]);
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
      scrapOffcuts: scrapOffcutsOf(s, rate),
    };
  }
  const { summary, progress } = cardsOf(F, todayText());
  return { ...sheetRow(F, progress, s, summary, cw, rate), hasTerms: true, items: s?.items ?? [], lines: detail.lines, totals: detail.totals };
}

