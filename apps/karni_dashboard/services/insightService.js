import { shared } from './reportService.js';

/**
 * "Needs attention": rules that read the synced SAP data and say, in a
 * sentence, where someone should act — each with its rupee impact, who acts,
 * how it was worked out, and the evidence (rows, a ranking, sometimes a trend).
 *
 * Every rule is plain arithmetic on data the connector already reads; nothing
 * is guessed and nothing is asked of SAP. Thresholds live in LIMITS so Karni
 * can tune them. A rule that finds nothing returns null and shows no card.
 *
 * Shape of an insight (the screen renders any insight from this alone):
 *   { id, area, severity: 'high'|'medium'|'low', owner, title, how, impact, impactLabel,
 *     count, link, columns: [{ key, label, kind }], rows, rank: { labelKey, valueKey, kind },
 *     trend?: { title, kind, points: [{ x, y }] } }
 *   kind: 'text' | 'inr' | 'qty' | 'date' | 'pct' | 'num'
 */
const {
  load, masters, unitMap, lastSync, MASTER_SETS,
  num, day, live, lineOpen, interUnit, trade, round, todayIso, addDays, monthKey, lastMonths,
} = shared;

export const LIMITS = {
  overdueDays: 90, // "seriously overdue"
  quietDays: 45, quietMinMonths: 3, // regular buyer = bought in ≥3 of the 6 months before going quiet
  dropPct: 50, dropMinMonthly: 5e5, // buying ≥50% less than a usual month of ≥ ₹5 L
  sellPriceDropPct: 5, priceMinValue: 2e5,
  buyPriceUpPct: 10,
  creditNoteMin: 1e5, creditNoteSharePct: 5,
  notInvoicedDays: 3, grnNotInvoicedDays: 15,
  vendorLateDays: 7,
  coverDays: 7, overstockDays: 90,
  deadDays: 90, deadMinValue: 1e5,
  stuckDays: 14, recentOrderDays: 120,
  machineDropPct: 50, machineMinWeekly: 1000,
  scrapRiseX: 1.5, scrapMinPts: 2,
};

const DATASETS = [
  'invoices', 'creditNotes', 'invoiceLines', 'creditNoteLines', 'orderLines', 'deliveries', 'deliveryLines',
  'purchaseInvoices', 'purchaseInvoiceLines', 'purchaseOrderLines', 'grpoLines', 'stock', 'productionOrders', 'productionReceipts', 'productionIssues',
  ...MASTER_SETS,
];

const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
const by = (list, keyFn) => { const m = new Map(); for (const x of list) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const priceOf = (l) => (num(l.Quantity) ? num(l.LineTotal) / num(l.Quantity) : 0);
const isOpenDoc = (x) => (x.DocumentStatus === 'bost_Open' || x.DocumentStatus === 'O') && live(x);
const L = (v) => `₹${(v / 1e5).toFixed(v >= 1e7 ? 0 : 1)} L`;
const short = (v) => (Math.abs(v) >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : L(v));
/** "SP-1", "SP - 1", "SP-01" are one machine. */
const machineKey = (m) => String(m || '').toUpperCase().replace(/[\s_\-.]+/g, '').replace(/(\D)0+(\d)/g, '$1$2');

function monthlySeries(lines, valueFn, months) {
  const m = Object.fromEntries(months.map((k) => [k, 0]));
  for (const l of lines) { const k = monthKey(day(l.DocDate) || ''); if (k in m) m[k] += valueFn(l); }
  return months.map((k) => ({ x: k, y: round(m[k]) }));
}
function dailySeries(lines, valueFn, from, to) {
  const out = [];
  const m = new Map();
  for (const l of lines) { const k = day(l.DocDate); m.set(k, (m.get(k) || 0) + valueFn(l)); }
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ x: d, y: round(m.get(d) || 0) });
  return out;
}

// ═════════════════════════════════════════════════════════════════════════
// Rules
// ═════════════════════════════════════════════════════════════════════════
const RULES = [];
const rule = (fn) => RULES.push(fn);

// ── Money ────────────────────────────────────────────────────────────────
rule(function overdueStillBilled({ d, M, ok, today, invUnit }) {
  const overdue = new Map();
  for (const x of d.invoices || []) {
    if (!isOpenDoc(x) || interUnit(x) || !ok(invUnit.get(x.DocEntry))) continue;
    const bal = num(x.DocTotal) - num(x.PaidToDate);
    if (bal > 1 && day(x.DocDueDate) < addDays(today, -LIMITS.overdueDays)) overdue.set(x.CardCode, (overdue.get(x.CardCode) || 0) + bal);
  }
  const billed = by((d.invoiceLines || []).filter((l) => trade(l) && ok(l.BPLName) && day(l.DocDate) > addDays(today, -30)), (l) => l.CardCode);
  const rows = [...overdue.entries()].filter(([c]) => billed.has(c)).map(([c, v]) => ({
    customer: M.partners.get(c)?.CardName || c, cardCode: c, overdue: round(v), billed30: round(sum(billed.get(c), (l) => num(l.LineTotal))),
    balance: num(M.partners.get(c)?.CurrentAccountBalance),
  })).sort((a, b) => b.overdue - a.overdue);
  if (!rows.length) return null;
  const top = rows[0];
  const months = lastMonths(6, today);
  return {
    id: 'overdue-still-billed', area: 'Money', severity: 'high', owner: 'Accounts / sales head', link: 'receivables',
    title: `${rows.length} customers were billed this month while owing money for over ${LIMITS.overdueDays} days — ${top.customer} owes ${short(top.overdue)} beyond ${LIMITS.overdueDays} days and was billed ${short(top.billed30)} in the last 30 days`,
    how: `Open A/R invoices whose due date passed more than ${LIMITS.overdueDays} days ago, for customers with an invoice in the last 30 days. Inter-unit billing left out.`,
    impact: round(sum(rows, (r) => r.overdue)), impactLabel: `overdue beyond ${LIMITS.overdueDays} days`, count: rows.length,
    columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'overdue', label: `Overdue ${LIMITS.overdueDays}+ days`, kind: 'inr' },
      { key: 'billed30', label: 'Billed last 30 days', kind: 'inr' }, { key: 'balance', label: 'Account balance', kind: 'inr' }],
    rows, rank: { labelKey: 'customer', valueKey: 'overdue', kind: 'inr' },
    trend: { title: `${top.customer}: billed per month`, kind: 'inr', points: monthlySeries((d.invoiceLines || []).filter((l) => trade(l) && l.CardCode === top.cardCode), (l) => num(l.LineTotal), months) },
  };
});

rule(function unmatchedPayments({ d, M, unit }) {
  // Company-wide: an account balance is not split by unit.
  if (unit) return null;
  const open = new Map();
  for (const x of d.invoices || []) {
    if (!isOpenDoc(x) || interUnit(x)) continue;
    open.set(x.CardCode, (open.get(x.CardCode) || 0) + num(x.DocTotal) - num(x.PaidToDate));
  }
  const rows = [...open.entries()].map(([c, v]) => {
    const b = M.partners.get(c);
    return { customer: b?.CardName || c, openInvoices: round(v), balance: round(num(b?.CurrentAccountBalance)), gap: round(v - num(b?.CurrentAccountBalance)) };
  }).filter((r) => r.gap >= 1e5 && r.gap >= r.openInvoices * 0.1).sort((a, b) => b.gap - a.gap);
  if (!rows.length) return null;
  const t = rows[0];
  return {
    id: 'unmatched-payments', area: 'Money', severity: 'medium', owner: 'Accounts', link: 'receivables',
    title: `${rows.length} customers have payments not matched to their invoices — ${t.customer} shows ${short(t.openInvoices)} of open invoices but an account balance of ${short(t.balance)}`,
    how: 'Open A/R invoices added up per customer against the customer\'s account balance in SAP. When the invoices are well above the balance, money was received or credited on account and not reconciled to the invoices — so overdue figures for that customer look worse than they are until Accounts matches them.',
    impact: round(sum(rows, (r) => r.gap)), impactLabel: 'received, not matched', count: rows.length,
    columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'openInvoices', label: 'Open invoices', kind: 'inr' },
      { key: 'balance', label: 'Account balance', kind: 'inr' }, { key: 'gap', label: 'Not matched', kind: 'inr' }],
    rows, rank: { labelKey: 'customer', valueKey: 'gap', kind: 'inr' },
  };
});

rule(function overCreditLimit({ d, M, ok, today }) {
  const billed = by((d.invoiceLines || []).filter((l) => trade(l) && ok(l.BPLName) && day(l.DocDate) > addDays(today, -30)), (l) => l.CardCode);
  const rows = (d.businessPartners || []).filter((b) => b.CardType === 'cCustomer' && num(b.CreditLimit) > 0 && num(b.CurrentAccountBalance) > num(b.CreditLimit) && billed.has(b.CardCode))
    .map((b) => ({
      customer: b.CardName, balance: num(b.CurrentAccountBalance), limit: num(b.CreditLimit), over: round(num(b.CurrentAccountBalance) - num(b.CreditLimit)),
      billed30: round(sum(billed.get(b.CardCode), (l) => num(l.LineTotal))),
    })).sort((a, b) => b.over - a.over);
  if (!rows.length) return null;
  const t = rows[0];
  return {
    id: 'over-credit-limit', area: 'Money', severity: 'high', owner: 'Accounts', link: 'receivables',
    title: `${rows.length} customers are over their credit limit and still being billed — ${t.customer} owes ${short(t.balance)} against a ${short(t.limit)} limit`,
    how: 'Customers whose account balance in SAP is above the credit limit set on the business partner, with an invoice in the last 30 days.',
    impact: round(sum(rows, (r) => r.over)), impactLabel: 'above their limits', count: rows.length,
    columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'balance', label: 'Balance', kind: 'inr' }, { key: 'limit', label: 'Credit limit', kind: 'inr' },
      { key: 'over', label: 'Over by', kind: 'inr' }, { key: 'billed30', label: 'Billed last 30 days', kind: 'inr' }],
    rows, rank: { labelKey: 'customer', valueKey: 'over', kind: 'inr' },
  };
});

rule(function dueThisWeek({ d, M, ok, today, invUnit }) {
  const rows = (d.invoices || []).filter((x) => isOpenDoc(x) && !interUnit(x) && ok(invUnit.get(x.DocEntry)) && day(x.DocDueDate) >= today && day(x.DocDueDate) <= addDays(today, 7))
    .map((x) => ({ customer: x.CardName, invoice: x.DocNum, due: day(x.DocDueDate), balance: round(num(x.DocTotal) - num(x.PaidToDate)) }))
    .filter((r) => r.balance > 1).sort((a, b) => b.balance - a.balance);
  if (!rows.length) return null;
  const byC = [...by(rows, (r) => r.customer).entries()].map(([c, l]) => ({ c, v: sum(l, (r) => r.balance) })).sort((a, b) => b.v - a.v);
  return {
    id: 'due-this-week', area: 'Money', severity: 'low', owner: 'Accounts', link: 'receivables',
    title: `${short(sum(rows, (r) => r.balance))} falls due from customers in the next 7 days — biggest: ${byC[0].c} (${short(byC[0].v)})`,
    how: 'Open A/R invoices with a due date from today to 7 days ahead: the collection calls to make this week.',
    impact: round(sum(rows, (r) => r.balance)), impactLabel: 'due in 7 days', count: rows.length,
    columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'invoice', label: 'Invoice', kind: 'num' }, { key: 'due', label: 'Due', kind: 'date' }, { key: 'balance', label: 'Balance', kind: 'inr' }],
    rows, rank: { labelKey: 'customer', valueKey: 'balance', kind: 'inr' },
  };
});

rule(function deliveredNotInvoiced({ d, ok, today }) {
  const units = unitMap(d.deliveryLines);
  const rows = (d.deliveries || []).filter((x) => isOpenDoc(x) && !interUnit(x) && ok(units.get(x.DocEntry)) && day(x.DocDate) < addDays(today, -LIMITS.notInvoicedDays))
    .map((x) => ({ customer: x.CardName, delivery: x.DocNum, date: day(x.DocDate), value: round(num(x.DocTotal)) })).sort((a, b) => b.value - a.value);
  if (!rows.length) return null;
  return {
    id: 'delivered-not-invoiced', area: 'Money', severity: 'medium', owner: 'Accounts / dispatch', link: 'dispatch',
    title: `${rows.length} deliveries went out but were never invoiced — ${short(sum(rows, (r) => r.value))} not billed (oldest ${rows.reduce((a, r) => (r.date < a ? r.date : a), today)})`,
    how: `Delivery notes still open in SAP (not copied to an A/R invoice) more than ${LIMITS.notInvoicedDays} days after delivery.`,
    impact: round(sum(rows, (r) => r.value)), impactLabel: 'delivered, not billed', count: rows.length,
    columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'delivery', label: 'Delivery', kind: 'num' }, { key: 'date', label: 'Delivered', kind: 'date' }, { key: 'value', label: 'Value', kind: 'inr' }],
    rows, rank: { labelKey: 'customer', valueKey: 'value', kind: 'inr' },
  };
});

// ── Sales ────────────────────────────────────────────────────────────────
function customerMonths(d, ok) {
  const m = new Map();
  for (const l of (d.invoiceLines || []).filter((x) => trade(x) && ok(x.BPLName))) {
    const c = m.get(l.CardCode) || { customer: l.CardName, cardCode: l.CardCode, lines: [] };
    c.lines.push(l); m.set(l.CardCode, c);
  }
  return m;
}

rule(function quietCustomers({ d, ok, today }) {
  const from = addDays(today, -(LIMITS.quietDays + 180));
  const until = addDays(today, -LIMITS.quietDays);
  const rows = [];
  for (const c of customerMonths(d, ok).values()) {
    const last = c.lines.reduce((a, l) => (day(l.DocDate) > a ? day(l.DocDate) : a), '');
    if (last >= until) continue;
    const window = c.lines.filter((l) => day(l.DocDate) >= from && day(l.DocDate) < until);
    const months = new Set(window.map((l) => monthKey(day(l.DocDate))));
    if (months.size < LIMITS.quietMinMonths) continue;
    rows.push({ customer: c.customer, cardCode: c.cardCode, lastBill: last, monthsActive: months.size, perMonth: round(sum(window, (l) => num(l.LineTotal)) / 6) });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b.perMonth - a.perMonth);
  const t = rows[0];
  return {
    id: 'quiet-customers', area: 'Sales', severity: 'medium', owner: 'Sales', link: 'sales',
    title: `${rows.length} regular customers have not bought in ${LIMITS.quietDays}+ days — ${t.customer} used to buy about ${short(t.perMonth)} a month, last bill ${t.lastBill}`,
    how: `Customers who were billed in at least ${LIMITS.quietMinMonths} of the 6 months before the last ${LIMITS.quietDays} days, and not since.`,
    impact: round(sum(rows, (r) => r.perMonth)), impactLabel: 'usual sales a month', count: rows.length,
    columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'lastBill', label: 'Last bill', kind: 'date' },
      { key: 'monthsActive', label: 'Months bought (of 6)', kind: 'num' }, { key: 'perMonth', label: 'Usual a month', kind: 'inr' }],
    rows, rank: { labelKey: 'customer', valueKey: 'perMonth', kind: 'inr' },
    trend: { title: `${t.customer}: billed per month`, kind: 'inr', points: monthlySeries(customerMonths(d, ok).get(t.cardCode).lines, (l) => num(l.LineTotal), lastMonths(9, today)) },
  };
});

rule(function buyingLess({ d, ok, today }) {
  const rows = [];
  for (const c of customerMonths(d, ok).values()) {
    const now = sum(c.lines.filter((l) => day(l.DocDate) > addDays(today, -30)), (l) => num(l.LineTotal));
    const usual = sum(c.lines.filter((l) => day(l.DocDate) > addDays(today, -120) && day(l.DocDate) <= addDays(today, -30)), (l) => num(l.LineTotal)) / 3;
    if (now > 0 && usual >= LIMITS.dropMinMonthly && now < usual * (1 - LIMITS.dropPct / 100)) {
      rows.push({ customer: c.customer, cardCode: c.cardCode, last30: round(now), usual: round(usual), drop: round(((usual - now) / usual) * 100) });
    }
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (b.usual - b.last30) - (a.usual - a.last30));
  const t = rows[0];
  return {
    id: 'buying-less', area: 'Sales', severity: 'medium', owner: 'Sales', link: 'sales',
    title: `${rows.length} customers are buying much less than usual — ${t.customer}: ${short(t.last30)} in the last 30 days against a usual ${short(t.usual)} a month`,
    how: `Last 30 days' billing against the average month of the 90 days before; customers down ${LIMITS.dropPct}% or more from a usual month of at least ${short(LIMITS.dropMinMonthly)}. Customers who stopped completely are in "gone quiet".`,
    impact: round(sum(rows, (r) => r.usual - r.last30)), impactLabel: 'below their usual month', count: rows.length,
    columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'last30', label: 'Last 30 days', kind: 'inr' }, { key: 'usual', label: 'Usual month', kind: 'inr' }, { key: 'drop', label: 'Down by', kind: 'pct' }],
    rows, rank: { labelKey: 'customer', valueKey: 'usual', kind: 'inr' },
    trend: { title: `${t.customer}: billed per month`, kind: 'inr', points: monthlySeries(customerMonths(d, ok).get(t.cardCode).lines, (l) => num(l.LineTotal), lastMonths(9, today)) },
  };
});

function priceWindows(lines, today) {
  const m = new Map();
  for (const l of lines) {
    if (num(l.Quantity) <= 0) continue;
    const x = m.get(l.ItemCode) || { item: l.ItemDescription, itemCode: l.ItemCode, nv: 0, nq: 0, bv: 0, bq: 0 };
    const dd = day(l.DocDate);
    if (dd > addDays(today, -30)) { x.nv += num(l.LineTotal); x.nq += num(l.Quantity); } else if (dd > addDays(today, -120)) { x.bv += num(l.LineTotal); x.bq += num(l.Quantity); }
    m.set(l.ItemCode, x);
  }
  return [...m.values()].filter((x) => x.nq && x.bq).map((x) => ({ ...x, now: x.nv / x.nq, before: x.bv / x.bq }));
}
function monthlyPrice(lines, itemCode, months) {
  const m = Object.fromEntries(months.map((k) => [k, { v: 0, q: 0 }]));
  for (const l of lines) if (l.ItemCode === itemCode) { const k = monthKey(day(l.DocDate) || ''); if (m[k]) { m[k].v += num(l.LineTotal); m[k].q += num(l.Quantity); } }
  return months.map((k) => ({ x: k, y: m[k].q ? round(m[k].v / m[k].q) : 0 }));
}

rule(function sellingPriceDown({ d, ok, today }) {
  const lines = (d.invoiceLines || []).filter((l) => trade(l) && ok(l.BPLName));
  const rows = priceWindows(lines, today).filter((x) => x.nv >= LIMITS.priceMinValue && x.now < x.before * (1 - LIMITS.sellPriceDropPct / 100))
    .map((x) => ({ item: x.item, itemCode: x.itemCode, now: round(x.now), before: round(x.before), change: round(((x.now - x.before) / x.before) * 100), lost: round(x.nq * (x.before - x.now)) }))
    .sort((a, b) => b.lost - a.lost);
  if (!rows.length) return null;
  const t = rows[0];
  return {
    id: 'selling-price-down', area: 'Sales', severity: 'medium', owner: 'Sales head', link: 'sales',
    title: `Selling price has fallen on ${rows.length} items — ${t.item} now sells at ₹${t.now} against ₹${t.before} (${t.change}%)`,
    how: `Average selling rate in the last 30 days against the 90 days before, same item; down ${LIMITS.sellPriceDropPct}% or more on at least ${short(LIMITS.priceMinValue)} of sales.`,
    impact: round(sum(rows, (r) => r.lost)), impactLabel: 'less realised in 30 days', count: rows.length,
    columns: [{ key: 'item', label: 'Item', kind: 'text' }, { key: 'now', label: 'Rate now', kind: 'inr' }, { key: 'before', label: 'Rate before', kind: 'inr' },
      { key: 'change', label: 'Change', kind: 'pct' }, { key: 'lost', label: 'Less realised', kind: 'inr' }],
    rows, rank: { labelKey: 'item', valueKey: 'lost', kind: 'inr' },
    trend: { title: `${t.item}: selling rate per month`, kind: 'inr', points: monthlyPrice(lines, t.itemCode, lastMonths(6, today)) },
  };
});

rule(function creditNotes({ d, ok, today }) {
  const cn = by((d.creditNoteLines || []).filter((l) => trade(l) && ok(l.BPLName) && day(l.DocDate) > addDays(today, -30)), (l) => l.CardCode);
  const sales = by((d.invoiceLines || []).filter((l) => trade(l) && ok(l.BPLName) && day(l.DocDate) > addDays(today, -30)), (l) => l.CardCode);
  const rows = [...cn.entries()].map(([c, l]) => {
    const v = sum(l, (x) => num(x.LineTotal)); const s = sum(sales.get(c) || [], (x) => num(x.LineTotal));
    return { customer: l[0].CardName, creditNotes: round(v), sales30: round(s), share: s ? round((v / s) * 100) : null };
  }).filter((r) => r.creditNotes >= LIMITS.creditNoteMin && (r.share == null || r.share >= LIMITS.creditNoteSharePct)).sort((a, b) => b.creditNotes - a.creditNotes);
  if (!rows.length) return null;
  const t = rows[0];
  return {
    id: 'credit-notes', area: 'Sales', severity: 'medium', owner: 'Sales / quality', link: 'sales',
    title: `Credit notes are piling up — ${t.customer}: ${short(t.creditNotes)} in the last 30 days${t.share != null ? ` (${t.share}% of what they were billed)` : ''}`,
    how: `A/R credit notes (returns, rate differences, claims) in the last 30 days of at least ${short(LIMITS.creditNoteMin)} and ${LIMITS.creditNoteSharePct}% of the customer's billing.`,
    impact: round(sum(rows, (r) => r.creditNotes)), impactLabel: 'credited in 30 days', count: rows.length,
    columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'creditNotes', label: 'Credit notes', kind: 'inr' }, { key: 'sales30', label: 'Billed', kind: 'inr' }, { key: 'share', label: 'Share', kind: 'pct' }],
    rows, rank: { labelKey: 'customer', valueKey: 'creditNotes', kind: 'inr' },
  };
});

// ── Orders ───────────────────────────────────────────────────────────────
function stockIn(d, M, unit) {
  const m = new Map();
  for (const s of d.stock || []) {
    if (unit && M.whs.get(s.WarehouseCode)?.unit !== unit) continue;
    m.set(s.ItemCode, (m.get(s.ItemCode) || 0) + num(s.InStock));
  }
  return m;
}
const pendingLines = (d, ok) => (d.orderLines || []).filter((l) => trade(l) && ok(l.BPLName) && lineOpen(l) && num(l.RemainingOpenQuantity) > 0);

rule(function lateCanShip({ d, M, ok, unit, today }) {
  const stock = stockIn(d, M, unit);
  const rows = pendingLines(d, ok).filter((l) => day(l.ShipDate) && day(l.ShipDate) < today && (stock.get(l.ItemCode) || 0) >= num(l.RemainingOpenQuantity))
    .map((l) => ({ so: l.DocNum, customer: l.CardName, item: l.ItemDescription, open: num(l.RemainingOpenQuantity), due: day(l.ShipDate),
      stock: round(stock.get(l.ItemCode) || 0), value: round(num(l.RemainingOpenQuantity) * priceOf(l)) }))
    .sort((a, b) => b.value - a.value);
  if (!rows.length) return null;
  const late = pendingLines(d, ok).filter((l) => day(l.ShipDate) && day(l.ShipDate) < today).length;
  return {
    id: 'late-can-ship', area: 'Orders', severity: 'high', owner: 'Dispatch', link: 'sales-orders',
    title: `${rows.length} of ${late} late order lines can ship today — the stock is already there (${short(sum(rows, (r) => r.value))})`,
    how: 'Open sales-order lines past their delivery date where stock in hand (the unit\'s warehouses when a unit is chosen) covers the open quantity.',
    impact: round(sum(rows, (r) => r.value)), impactLabel: 'ready to ship', count: rows.length,
    columns: [{ key: 'so', label: 'SO', kind: 'num' }, { key: 'customer', label: 'Customer', kind: 'text' }, { key: 'item', label: 'Item', kind: 'text' },
      { key: 'open', label: 'To ship', kind: 'qty' }, { key: 'stock', label: 'In stock', kind: 'qty' }, { key: 'due', label: 'Was due', kind: 'date' }, { key: 'value', label: 'Value', kind: 'inr' }],
    rows, rank: { labelKey: 'customer', valueKey: 'value', kind: 'inr' },
  };
});

rule(function dueNothingMoving({ d, M, ok, unit, today }) {
  const stock = stockIn(d, M, unit);
  const inProd = new Set((d.productionOrders || []).filter((o) => o.ProductionOrderStatus === 'boposReleased' || o.ProductionOrderStatus === 'boposPlanned').map((o) => o.ItemNo));
  const rows = pendingLines(d, ok).filter((l) => day(l.ShipDate) >= today && day(l.ShipDate) <= addDays(today, 7)
    && (stock.get(l.ItemCode) || 0) < num(l.RemainingOpenQuantity) && !inProd.has(l.ItemCode))
    .map((l) => ({ so: l.DocNum, customer: l.CardName, item: l.ItemDescription, open: num(l.RemainingOpenQuantity), stock: round(stock.get(l.ItemCode) || 0),
      due: day(l.ShipDate), value: round(num(l.RemainingOpenQuantity) * priceOf(l)) }))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  if (!rows.length) return null;
  return {
    id: 'due-nothing-moving', area: 'Orders', severity: 'high', owner: 'Planning / production', link: 'sales-orders',
    title: `${rows.length} order lines are due within 7 days with not enough stock and no production order — first due ${rows[0].due} (${rows[0].customer})`,
    how: 'Open sales-order lines due in the next 7 days where stock in hand is short and no planned or released production order exists for the item.',
    impact: round(sum(rows, (r) => r.value)), impactLabel: 'due this week, nothing in motion', count: rows.length,
    columns: [{ key: 'so', label: 'SO', kind: 'num' }, { key: 'customer', label: 'Customer', kind: 'text' }, { key: 'item', label: 'Item', kind: 'text' },
      { key: 'open', label: 'To ship', kind: 'qty' }, { key: 'stock', label: 'In stock', kind: 'qty' }, { key: 'due', label: 'Due', kind: 'date' }, { key: 'value', label: 'Value', kind: 'inr' }],
    rows, rank: { labelKey: 'customer', valueKey: 'value', kind: 'inr' },
  };
});

rule(function orderBook({ d, ok, today }) {
  const pending = sum(pendingLines(d, ok), (l) => num(l.RemainingOpenQuantity) * priceOf(l));
  const disp = (d.deliveryLines || []).filter((l) => trade(l) && ok(l.BPLName));
  const last30 = sum(disp.filter((l) => day(l.DocDate) > addDays(today, -30)), (l) => num(l.LineTotal));
  if (!pending || !last30) return null;
  const days = Math.round(pending / (last30 / 30));
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const to = addDays(today, -7 * i); const from = addDays(to, -6);
    weeks.push({ x: from, y: round(sum(disp.filter((l) => day(l.DocDate) >= from && day(l.DocDate) <= to), (l) => num(l.LineTotal))) });
  }
  return {
    id: 'order-book', area: 'Orders', severity: days < 15 ? 'medium' : 'low', owner: 'Management', link: 'sales-orders',
    title: `The order book covers about ${days} days of dispatch — ${short(pending)} still to ship at the last 30 days' pace of ${short(last30)}`,
    how: 'Value still to ship on open sales-order lines, divided by the average daily dispatch value of the last 30 days. Below 15 days the order book is thin.',
    impact: round(pending), impactLabel: 'still to ship', count: null,
    columns: [], rows: [], rank: null,
    trend: { title: 'Dispatch value per week (last 12 weeks)', kind: 'inr', points: weeks },
  };
});

// ── Purchase ─────────────────────────────────────────────────────────────
rule(function buyingPriceUp({ d, ok, today }) {
  const lines = (d.purchaseInvoiceLines || []).filter((l) => trade(l) && ok(l.BPLName));
  const rows = priceWindows(lines, today).filter((x) => x.nv >= 1e5 && x.now > x.before * (1 + LIMITS.buyPriceUpPct / 100))
    .map((x) => ({ item: x.item, itemCode: x.itemCode, now: round(x.now), before: round(x.before), change: round(((x.now - x.before) / x.before) * 100), extra: round(x.nq * (x.now - x.before)) }))
    .sort((a, b) => b.extra - a.extra);
  if (!rows.length) return null;
  const t = rows[0];
  return {
    id: 'buying-price-up', area: 'Purchase', severity: 'medium', owner: 'Purchase', link: 'purchase',
    title: `Buying prices are up on ${rows.length} items — ${t.item} now costs ₹${t.now} against ₹${t.before} (+${t.change}%), ${short(t.extra)} extra in 30 days`,
    how: `Average purchase rate (A/P invoices) in the last 30 days against the 90 days before, same item; up ${LIMITS.buyPriceUpPct}% or more on at least ₹1 L of purchases.`,
    impact: round(sum(rows, (r) => r.extra)), impactLabel: 'extra paid in 30 days', count: rows.length,
    columns: [{ key: 'item', label: 'Item', kind: 'text' }, { key: 'now', label: 'Rate now', kind: 'inr' }, { key: 'before', label: 'Rate before', kind: 'inr' },
      { key: 'change', label: 'Change', kind: 'pct' }, { key: 'extra', label: 'Extra paid', kind: 'inr' }],
    rows, rank: { labelKey: 'item', valueKey: 'extra', kind: 'inr' },
    trend: { title: `${t.item}: purchase rate per month`, kind: 'inr', points: monthlyPrice(lines, t.itemCode, lastMonths(6, today)) },
  };
});

rule(function lateVendors({ d, ok, today }) {
  const owe = new Map();
  for (const x of d.purchaseInvoices || []) {
    if (isOpenDoc(x) && !interUnit(x) && day(x.DocDueDate) < today) owe.set(x.CardCode, (owe.get(x.CardCode) || 0) + num(x.DocTotal) - num(x.PaidToDate));
  }
  const late = (d.purchaseOrderLines || []).filter((l) => trade(l) && ok(l.BPLName) && lineOpen(l) && num(l.RemainingOpenQuantity) > 0
    && day(l.ShipDate) < addDays(today, -LIMITS.vendorLateDays) && day(l.DocDate) > addDays(today, -90));
  const rows = [...by(late, (l) => l.CardCode).entries()].map(([c, l]) => ({
    vendor: l[0].CardName, lines: l.length, pending: round(sum(l, (x) => num(x.RemainingOpenQuantity) * priceOf(x))),
    oldestDue: l.reduce((a, x) => (day(x.ShipDate) < a ? day(x.ShipDate) : a), today), weOweOverdue: round(owe.get(c) || 0),
  })).sort((a, b) => b.pending - a.pending);
  if (!rows.length) return null;
  const t = rows[0];
  return {
    id: 'late-vendors', area: 'Purchase', severity: 'medium', owner: 'Purchase', link: 'purchase',
    title: `${rows.length} vendors are more than ${LIMITS.vendorLateDays} days late — ${t.vendor} has ${short(t.pending)} pending${t.weOweOverdue > 1e5 ? `, and we owe them ${short(t.weOweOverdue)} overdue` : ''}`,
    how: `Open purchase-order lines from the last 90 days whose delivery date passed more than ${LIMITS.vendorLateDays} days ago. "We owe overdue" is their unpaid A/P past due — often the reason for the delay.`,
    impact: round(sum(rows, (r) => r.pending)), impactLabel: 'late from vendors', count: rows.length,
    columns: [{ key: 'vendor', label: 'Vendor', kind: 'text' }, { key: 'lines', label: 'Late lines', kind: 'num' }, { key: 'pending', label: 'Pending value', kind: 'inr' },
      { key: 'oldestDue', label: 'Oldest due', kind: 'date' }, { key: 'weOweOverdue', label: 'We owe overdue', kind: 'inr' }],
    rows, rank: { labelKey: 'vendor', valueKey: 'pending', kind: 'inr' },
  };
});

rule(function grnNotInvoiced({ d, ok, today }) {
  const docs = by((d.grpoLines || []).filter((l) => trade(l) && ok(l.BPLName) && (l.DocumentStatus === 'O' || l.DocumentStatus === 'bost_Open')
    && day(l.DocDate) < addDays(today, -LIMITS.grnNotInvoicedDays)), (l) => l.DocEntry);
  const rows = [...docs.values()].map((l) => ({ vendor: l[0].CardName, grn: l[0].DocNum, date: day(l[0].DocDate), value: round(sum(l, (x) => num(x.LineTotal))) }))
    .sort((a, b) => b.value - a.value);
  if (!rows.length) return null;
  return {
    id: 'grn-not-invoiced', area: 'Purchase', severity: 'low', owner: 'Accounts', link: 'purchase',
    title: `${rows.length} goods receipts have no vendor invoice after ${LIMITS.grnNotInvoicedDays}+ days — ${short(sum(rows, (r) => r.value))} not booked as payable`,
    how: `Goods receipt POs still open in SAP (no A/P invoice) more than ${LIMITS.grnNotInvoicedDays} days after receipt.`,
    impact: round(sum(rows, (r) => r.value)), impactLabel: 'received, not invoiced', count: rows.length,
    columns: [{ key: 'vendor', label: 'Vendor', kind: 'text' }, { key: 'grn', label: 'GRN', kind: 'num' }, { key: 'date', label: 'Received', kind: 'date' }, { key: 'value', label: 'Value', kind: 'inr' }],
    rows, rank: { labelKey: 'vendor', valueKey: 'value', kind: 'inr' },
  };
});

// ── Stores ───────────────────────────────────────────────────────────────
function usage(d, ok, today, days) {
  const m = new Map();
  for (const l of d.productionIssues || []) {
    if (l.BaseType !== 202 || !ok(l.BPLName) || day(l.DocDate) <= addDays(today, -days)) continue;
    m.set(l.ItemCode, (m.get(l.ItemCode) || 0) + num(l.Quantity) / days);
  }
  return m;
}
const RM = /^RM/i;

rule(function lowCover({ d, M, ok, unit, today }) {
  const use = usage(d, ok, today, 30);
  const stock = stockIn(d, M, unit);
  const ordered = new Map(); for (const s of d.stock || []) ordered.set(s.ItemCode, (ordered.get(s.ItemCode) || 0) + num(s.Ordered));
  const rows = [...use.entries()].filter(([c, u]) => RM.test(M.itemGroup(c)) && u > 0 && (stock.get(c) || 0) / u < LIMITS.coverDays)
    .map(([c, u]) => ({ item: M.items.get(c)?.ItemName || c, itemCode: c, group: M.itemGroup(c), daysLeft: round((stock.get(c) || 0) / u), perDay: round(u),
      stock: round(stock.get(c) || 0), onOrder: round(ordered.get(c) || 0), uom: M.items.get(c)?.InventoryUOM || '' }))
    .sort((a, b) => Number(a.onOrder > 0) - Number(b.onOrder > 0) || a.daysLeft - b.daysLeft);
  if (!rows.length) return null;
  const none = rows.filter((r) => r.onOrder <= 0).length;
  const t = rows[0];
  return {
    id: 'low-cover', area: 'Stores', severity: none ? 'high' : 'medium', owner: 'Stores / purchase', link: 'inventory',
    title: `${rows.length} raw materials have less than ${LIMITS.coverDays} days of stock — ${none} with nothing on order (e.g. ${t.item}: ${t.daysLeft} days left at ${t.perDay} ${t.uom}/day)`,
    how: `Stock in hand ÷ average daily issue to production over the last 30 days, for RM item groups. "On order" is open purchase-order quantity in SAP. Films slit from master rolls may show low cover while the master roll is in stock.`,
    impact: null, impactLabel: null, count: rows.length,
    columns: [{ key: 'item', label: 'Item', kind: 'text' }, { key: 'group', label: 'Group', kind: 'text' }, { key: 'daysLeft', label: 'Days left', kind: 'num' },
      { key: 'perDay', label: 'Uses a day', kind: 'qty' }, { key: 'stock', label: 'In stock', kind: 'qty' }, { key: 'onOrder', label: 'On order', kind: 'qty' }],
    rows, rank: { labelKey: 'item', valueKey: 'perDay', kind: 'qty' },
    trend: { title: `${t.item}: issued to production per day`, kind: 'qty',
      points: dailySeries((d.productionIssues || []).filter((l) => l.BaseType === 202 && l.ItemCode === t.itemCode && ok(l.BPLName)), (l) => num(l.Quantity), addDays(today, -29), today) },
  };
});

rule(function deadStock({ d, M, ok, unit, today }) {
  const since = addDays(today, -LIMITS.deadDays);
  const moved = new Set([...(d.productionIssues || []), ...(d.deliveryLines || []), ...(d.invoiceLines || [])].filter((l) => day(l.DocDate) > since).map((l) => l.ItemCode));
  const val = new Map();
  for (const s of d.stock || []) {
    if (unit && M.whs.get(s.WarehouseCode)?.unit !== unit) continue;
    const v = num(s.InStock) * num(s.StandardAveragePrice);
    if (v > 0) val.set(s.ItemCode, (val.get(s.ItemCode) || 0) + v);
  }
  const rows = [...val.entries()].filter(([c, v]) => v >= LIMITS.deadMinValue && !moved.has(c))
    .map(([c, v]) => ({ item: M.items.get(c)?.ItemName || c, group: M.itemGroup(c), value: round(v) })).sort((a, b) => b.value - a.value);
  if (!rows.length) return null;
  return {
    id: 'dead-stock', area: 'Stores', severity: 'medium', owner: 'Stores / management', link: 'inventory',
    title: `${short(sum(rows, (r) => r.value))} of stock has not moved in ${LIMITS.deadDays} days — ${rows.length} items, the largest ${rows[0].item} (${short(rows[0].value)})`,
    how: `Items worth at least ${short(LIMITS.deadMinValue)} in stock (quantity × average cost) with no issue to production, delivery or invoice in the last ${LIMITS.deadDays} days.`,
    impact: round(sum(rows, (r) => r.value)), impactLabel: 'tied up in idle stock', count: rows.length,
    columns: [{ key: 'item', label: 'Item', kind: 'text' }, { key: 'group', label: 'Group', kind: 'text' }, { key: 'value', label: 'Stock value', kind: 'inr' }],
    rows, rank: { labelKey: 'item', valueKey: 'value', kind: 'inr' },
  };
});

rule(function buyingOverstock({ d, M, ok, today }) {
  const use = usage(d, ok, today, 90);
  for (const l of d.invoiceLines || []) if (day(l.DocDate) > addDays(today, -90)) use.set(l.ItemCode, (use.get(l.ItemCode) || 0) + num(l.Quantity) / 90);
  const stock = new Map(); for (const s of d.stock || []) stock.set(s.ItemCode, (stock.get(s.ItemCode) || 0) + num(s.InStock));
  const rows = (d.purchaseOrderLines || []).filter((l) => trade(l) && ok(l.BPLName) && lineOpen(l) && num(l.RemainingOpenQuantity) > 0
    && /^(RM|BFL|Consumables)/i.test(M.itemGroup(l.ItemCode)) && (use.get(l.ItemCode) || 0) > 0
    && (stock.get(l.ItemCode) || 0) / use.get(l.ItemCode) > LIMITS.overstockDays)
    .map((l) => ({ po: l.DocNum, vendor: l.CardName, item: l.ItemDescription, ordering: num(l.RemainingOpenQuantity), stock: round(stock.get(l.ItemCode) || 0),
      daysOfStock: Math.round((stock.get(l.ItemCode) || 0) / use.get(l.ItemCode)), value: round(num(l.RemainingOpenQuantity) * priceOf(l)) }))
    .filter((r) => r.value >= 25000).sort((a, b) => b.value - a.value);
  if (!rows.length) return null;
  return {
    id: 'buying-overstock', area: 'Purchase', severity: 'medium', owner: 'Purchase', link: 'purchase',
    title: `${rows.length} open purchase orders are for materials we already hold ${LIMITS.overstockDays}+ days of — ${short(sum(rows, (r) => r.value))} could be held back`,
    how: `Open PO lines for RM, BFL and consumables where stock in hand ÷ average daily use (issues and sales, last 90 days) is above ${LIMITS.overstockDays} days.`,
    impact: round(sum(rows, (r) => r.value)), impactLabel: 'on order, not needed yet', count: rows.length,
    columns: [{ key: 'po', label: 'PO', kind: 'num' }, { key: 'vendor', label: 'Vendor', kind: 'text' }, { key: 'item', label: 'Item', kind: 'text' },
      { key: 'ordering', label: 'Still to come', kind: 'qty' }, { key: 'stock', label: 'In stock', kind: 'qty' }, { key: 'daysOfStock', label: 'Days of stock', kind: 'num' }, { key: 'value', label: 'Value', kind: 'inr' }],
    rows, rank: { labelKey: 'item', valueKey: 'value', kind: 'inr' },
  };
});

// ── Production ───────────────────────────────────────────────────────────
rule(function stuckOrders({ d, ok, today }) {
  const lastOut = new Map(); const unitOf = new Map();
  for (const l of d.productionReceipts || []) {
    if (l.BaseType !== 202) continue;
    if (day(l.DocDate) > (lastOut.get(l.BaseEntry) || '')) lastOut.set(l.BaseEntry, day(l.DocDate));
    if (l.BPLName) unitOf.set(l.BaseEntry, l.BPLName);
  }
  const lastIssue = new Map();
  for (const l of d.productionIssues || []) {
    if (l.BaseType !== 202) continue;
    if (day(l.DocDate) > (lastIssue.get(l.BaseEntry) || '')) lastIssue.set(l.BaseEntry, day(l.DocDate));
    if (l.BPLName) unitOf.set(l.BaseEntry, l.BPLName);
  }
  const rows = (d.productionOrders || []).filter((o) => o.ProductionOrderStatus === 'boposReleased' && day(o.PostingDate) > addDays(today, -LIMITS.recentOrderDays)
    && lastIssue.has(o.AbsoluteEntry) && ok(unitOf.get(o.AbsoluteEntry)) && num(o.CompletedQuantity) < num(o.PlannedQuantity)
    && (lastOut.get(o.AbsoluteEntry) || lastIssue.get(o.AbsoluteEntry)) < addDays(today, -LIMITS.stuckDays))
    .map((o) => ({ order: o.DocumentNumber, product: o.ProductDescription, machine: o.U_MACHINE || '—', section: o.U_SECTION || '—',
      done: num(o.CompletedQuantity), planned: num(o.PlannedQuantity), progress: round((num(o.CompletedQuantity) / (num(o.PlannedQuantity) || 1)) * 100),
      lastActivity: lastOut.get(o.AbsoluteEntry) || lastIssue.get(o.AbsoluteEntry) }))
    .sort((a, b) => (a.lastActivity < b.lastActivity ? -1 : 1));
  if (!rows.length) return null;
  return {
    id: 'stuck-orders', area: 'Production', severity: 'medium', owner: 'Production', link: 'production',
    title: `${rows.length} released production orders have had material issued but no output for ${LIMITS.stuckDays}+ days — oldest #${rows[0].order} ${rows[0].product}`,
    how: `Released orders posted in the last ${LIMITS.recentOrderDays} days, not complete, with material issued, and no receipt from production for ${LIMITS.stuckDays} days. Either the work is stuck or the order should be closed.`,
    impact: null, impactLabel: null, count: rows.length,
    columns: [{ key: 'order', label: 'Order', kind: 'num' }, { key: 'product', label: 'Product', kind: 'text' }, { key: 'machine', label: 'Machine', kind: 'text' },
      { key: 'done', label: 'Done', kind: 'qty' }, { key: 'planned', label: 'Planned', kind: 'qty' }, { key: 'progress', label: 'Progress', kind: 'pct' }, { key: 'lastActivity', label: 'Last activity', kind: 'date' }],
    rows, rank: null,
  };
});

function machineWeeks(d, ok, today, filter) {
  const names = new Map(); const m = new Map();
  for (const l of d.productionReceipts || []) {
    if (l.BaseType !== 202 || !l.U_EVT_MACHINE || !ok(l.BPLName) || !filter(l)) continue;
    const k = machineKey(l.U_EVT_MACHINE);
    const n = names.get(k) || {}; n[l.U_EVT_MACHINE] = (n[l.U_EVT_MACHINE] || 0) + 1; names.set(k, n);
    const x = m.get(k) || { week: 0, usualMonth: 0, lines: [] };
    const dd = day(l.DocDate);
    if (dd > addDays(today, -7)) x.week += num(l.Quantity);
    else if (dd > addDays(today, -37)) x.usualMonth += num(l.Quantity);
    if (dd > addDays(today, -37)) x.lines.push(l);
    m.set(k, x);
  }
  const nameOf = (k) => Object.entries(names.get(k) || { [k]: 1 }).sort((a, b) => b[1] - a[1])[0][0];
  return { m, nameOf };
}

rule(function machineDrop({ d, M, ok, today }) {
  const isScrap = (l) => /^SC /i.test(M.itemGroup(l.ItemCode));
  const { m, nameOf } = machineWeeks(d, ok, today, (l) => !isScrap(l));
  const rows = [...m.entries()].map(([k, x]) => ({ machine: nameOf(k), key: k, week: round(x.week), usual: round((x.usualMonth / 30) * 7), lines: x.lines }))
    .filter((r) => r.usual >= LIMITS.machineMinWeekly && r.week < r.usual * (1 - LIMITS.machineDropPct / 100))
    .map((r) => ({ ...r, pctOfUsual: round((r.week / r.usual) * 100) })).sort((a, b) => (b.usual - b.week) - (a.usual - a.week));
  if (!rows.length) return null;
  const t = rows[0];
  return {
    id: 'machine-drop', area: 'Production', severity: 'medium', owner: 'Production', link: 'production',
    title: `${rows.length} machines produced less than half their usual week — ${t.machine}: ${Math.round(t.week)} kg in the last 7 days against about ${Math.round(t.usual)} kg`,
    how: `Output (production receipts, scrap left out) in the last 7 days against the machine's average week over the 30 days before. Machine names are matched ignoring spaces, dashes and leading zeros ("SP-1" = "SP - 01").`,
    impact: null, impactLabel: null, count: rows.length,
    columns: [{ key: 'machine', label: 'Machine', kind: 'text' }, { key: 'week', label: 'Last 7 days', kind: 'qty' }, { key: 'usual', label: 'Usual week', kind: 'qty' }, { key: 'pctOfUsual', label: 'Of usual', kind: 'pct' }],
    rows: rows.map(({ lines, key, ...r }) => r), rank: { labelKey: 'machine', valueKey: 'usual', kind: 'qty' },
    trend: { title: `${t.machine}: output per day`, kind: 'qty', points: dailySeries(t.lines, (l) => num(l.Quantity), addDays(today, -36), today) },
  };
});

rule(function scrapUp({ d, M, ok, today }) {
  const isScrap = (l) => /^SC /i.test(M.itemGroup(l.ItemCode));
  const all = machineWeeks(d, ok, today, () => true);
  const scrap = machineWeeks(d, ok, today, isScrap);
  const rows = [...scrap.m.entries()].map(([k, s]) => {
    const a = all.m.get(k); if (!a) return null;
    const rateNow = a.week ? (s.week / a.week) * 100 : 0;
    const rateUsual = a.usualMonth ? (s.usualMonth / a.usualMonth) * 100 : 0;
    return { machine: all.nameOf(k), scrapWeek: round(s.week), rateNow: round(rateNow), rateUsual: round(rateUsual) };
  }).filter((r) => r && r.scrapWeek > 50 && r.rateNow >= r.rateUsual * LIMITS.scrapRiseX && r.rateNow - r.rateUsual >= LIMITS.scrapMinPts)
    .sort((a, b) => (b.rateNow - b.rateUsual) - (a.rateNow - a.rateUsual));
  if (!rows.length) return null;
  const t = rows[0];
  return {
    id: 'scrap-up', area: 'Production', severity: 'medium', owner: 'Production / quality', link: 'production',
    title: `Scrap is up on ${rows.length} machines — ${t.machine}: ${t.rateNow}% of output this week against a usual ${t.rateUsual}%`,
    how: 'Scrap received from production (item groups starting "SC") as a share of everything the machine produced, last 7 days against the 30 days before.',
    impact: null, impactLabel: null, count: rows.length,
    columns: [{ key: 'machine', label: 'Machine', kind: 'text' }, { key: 'scrapWeek', label: 'Scrap this week', kind: 'qty' }, { key: 'rateNow', label: 'Scrap rate now', kind: 'pct' }, { key: 'rateUsual', label: 'Usual rate', kind: 'pct' }],
    rows, rank: { labelKey: 'machine', valueKey: 'rateNow', kind: 'pct' },
  };
});

// ═════════════════════════════════════════════════════════════════════════
const SEVERITY = { high: 0, medium: 1, low: 2 };

// Rules run over ~200k rows: keep each company's answer for a few minutes (data changes every 10).
const memo = new Map();
const MEMO_MS = 5 * 60 * 1000;

export async function insights(companyId, q = {}) {
  const unit = q.unit || null;
  const asOf = await lastSync(companyId);
  const key = `${companyId}|${unit || ''}|${asOf}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  const d = await load(companyId, DATASETS);
  const M = masters(d);
  const ctx = { d, M, unit, ok: (v) => !unit || v === unit, today: todayIso(), invUnit: unitMap(d.invoiceLines) };
  const list = [];
  const failed = [];
  for (const r of RULES) {
    try {
      const x = r(ctx);
      if (x) list.push({ ...x, rows: (x.rows || []).slice(0, 200), total: (x.rows || []).length });
    } catch (err) {
      failed.push({ rule: r.name, error: err.message });
    }
  }
  list.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || (b.impact ?? 0) - (a.impact ?? 0));
  const value = { asOf, today: ctx.today, unit, limits: LIMITS, insights: list, failed };
  // Drop answers computed from older data; keep the other units' answers for this data.
  for (const k of memo.keys()) if (k.startsWith(`${companyId}|`) && !k.endsWith(`|${asOf}`)) memo.delete(k);
  memo.set(key, { at: Date.now(), value });
  return value;
}
