import { pool } from '../../../db.js';
import { shared } from './reportService.js';

/**
 * "Needs attention": rules that read the synced SAP data and say, in a
 * sentence, where someone should act — with the money at stake, who acts, how
 * it was worked out, and the evidence (rows, a ranking, sometimes a trend).
 *
 * FINDINGS KEEP THEIR IDENTITY. A rule returns one row per SUBJECT (a customer,
 * an item, an order line, a machine) with a stable `key`, a `metric` where
 * larger is worse, and sometimes a `band` (a step such as "30+ days late").
 * kd_insight_state holds each rule + subject's state:
 *   new → open → done / snoozed / muted ("not relevant") → resolved (gone from the data)
 * A handled finding comes back only when it gets MATERIALLY worse (its metric
 * grows by the rule's `worse` margin, or its band goes up), when a snooze ends,
 * when it is still there `GRACE_DAYS` after "done", or — for "not relevant" —
 * when it doubles. Small day-to-day changes never bring it back.
 *
 * NO FLICKER. Rules with a threshold raise at one level and clear at a safer
 * one (`ctx.held(key)`: a subject already open stays until the clear level).
 * Windows that compare periods end at YESTERDAY (`ctx.upTo`), never at a part day.
 *
 * WHEN: refresh() runs after every connector run (every 10 minutes) and keeps
 * the states; the screen reads them. Alerts (alertService.js) go out by each
 * rule's `cadence`: instant (working hours), daily digest, weekly digest.
 *
 * Thresholds live in LIMITS so Karni can tune them.
 */
const {
  load, masters, unitMap, lastSync, MASTER_SETS, prodRules,
  num, day, live, lineOpen, interUnit, trade, round, todayIso, addDays, monthKey, lastMonths,
} = shared;

export const LIMITS = {
  overdueDays: 90,
  quietDays: 45, quietMinMonths: 3,
  dropPct: 50, dropClearPct: 35, dropMinMonthly: 5e5,
  sellPriceDropPct: 5, sellPriceClearPct: 3, priceMinValue: 2e5,
  buyPriceUpPct: 10, buyPriceClearPct: 7,
  creditLimitClearPct: 95,
  creditNoteMin: 1e5, creditNoteSharePct: 5,
  notInvoicedDays: 3, grnNotInvoicedDays: 15,
  vendorLateDays: 7,
  coverDays: 7, coverClearDays: 10, overstockDays: 90,
  deadDays: 90, deadMinValue: 1e5,
  stuckDays: 14, recentOrderDays: 120,
  machineDropPct: 50, machineClearPct: 35, machineMinWeekly: 1000,
  scrapRiseX: 1.5, scrapMinPts: 2,
  graceDays: 7, // "done" but still in the data after this many days → back as open
  muteReturnX: 2, // "not relevant" returns only when the metric doubles
};
const GRACE_S = LIMITS.graceDays * 86400;

const DATASETS = [
  'invoices', 'creditNotes', 'invoiceLines', 'creditNoteLines', 'orderLines', 'deliveries', 'deliveryLines',
  'purchaseInvoices', 'purchaseInvoiceLines', 'purchaseOrderLines', 'grpoLines', 'stock', 'productionOrders', 'openProductionOrders', 'resources', 'productionReceipts', 'productionIssues',
  ...MASTER_SETS,
];

const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
const by = (list, keyFn) => { const m = new Map(); for (const x of list) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const priceOf = (l) => (num(l.Quantity) ? num(l.LineTotal) / num(l.Quantity) : 0);
const isOpenDoc = (x) => (x.DocumentStatus === 'bost_Open' || x.DocumentStatus === 'O') && live(x);
const L = (v) => `₹${(v / 1e5).toFixed(1)} L`;
const short = (v) => (Math.abs(v) >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : L(v));
const bandOf = (v, steps) => steps.filter((s) => v >= s).length; // 0, 1, 2 …
/** "SP-1", "SP - 1", "SP-01" are one machine. */
const WORSE_MONEY = { pct: 20, abs: 5e5 };
const WORSE_POINTS = { pct: 0, abs: 10 };

function monthlySeries(lines, valueFn, months) {
  const m = Object.fromEntries(months.map((k) => [k, 0]));
  for (const l of lines) { const k = monthKey(day(l.DocDate) || ''); if (k in m) m[k] += valueFn(l); }
  return months.map((k) => ({ x: k, y: round(m[k]) }));
}
function dailySeries(lines, valueFn, from, to) {
  const m = new Map();
  for (const l of lines) { const k = day(l.DocDate); m.set(k, (m.get(k) || 0) + valueFn(l)); }
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ x: d, y: round(m.get(d) || 0) });
  return out;
}

// ═════════════════════════════════════════════════════════════════════════
// Rules: define(meta, compute). compute(ctx) → { rows, view(rows) } or null.
// meta: id, area, owner, link, cadence ('instant' | 'daily' | 'weekly'), severity,
//       how, worse ({ pct, abs } on the metric), columns, rank, noState (info only)
// rows: [{ key, label, metric, band?, ...columns }]
// view(visibleRows): { title, impact, impactLabel, severity?, trend? }
// ═════════════════════════════════════════════════════════════════════════
const RULES = [];
const define = (meta, compute) => RULES.push({ worse: WORSE_MONEY, ...meta, compute });

// ── Money ────────────────────────────────────────────────────────────────
define({
  id: 'over-credit-limit', area: 'Money', owner: 'Accounts', link: 'receivables', cadence: 'instant', severity: 'high',
  how: `Customers whose account balance in SAP is above the credit limit on the business partner, with an invoice in the last 30 days. Once flagged, a customer stays until the balance is back under ${LIMITS.creditLimitClearPct}% of the limit.`,
  columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'balance', label: 'Balance', kind: 'inr' }, { key: 'limit', label: 'Credit limit', kind: 'inr' },
    { key: 'over', label: 'Over by', kind: 'inr' }, { key: 'billed30', label: 'Billed last 30 days', kind: 'inr' }],
  rank: { labelKey: 'customer', valueKey: 'over', kind: 'inr' },
}, ({ d, ok, upTo, held }) => {
  const billed = by((d.invoiceLines || []).filter((l) => trade(l) && ok(l.BPLName) && day(l.DocDate) > addDays(upTo, -30)), (l) => l.CardCode);
  const rows = (d.businessPartners || []).filter((b) => {
    const bal = num(b.CurrentAccountBalance); const lim = num(b.CreditLimit);
    if (b.CardType !== 'cCustomer' || lim <= 0 || !billed.has(b.CardCode)) return false;
    return bal > lim || (held(b.CardCode) && bal > lim * (LIMITS.creditLimitClearPct / 100));
  }).map((b) => {
    const bal = num(b.CurrentAccountBalance); const lim = num(b.CreditLimit);
    return { key: b.CardCode, label: b.CardName, metric: bal - lim, band: bandOf(bal / lim, [2, 5]),
      customer: b.CardName, balance: bal, limit: lim, over: round(bal - lim), billed30: round(sum(billed.get(b.CardCode), (l) => num(l.LineTotal))) };
  }).sort((a, b) => b.over - a.over);
  return { rows, view: (r) => ({
    title: `${r.length} customers are over their credit limit and still being billed — ${r[0].customer} owes ${short(r[0].balance)} against a ${short(r[0].limit)} limit`,
    impact: round(sum(r, (x) => Math.max(0, x.over))), impactLabel: 'above their limits',
  }) };
});

define({
  id: 'overdue-still-billed', area: 'Money', owner: 'Accounts / sales head', link: 'receivables', cadence: 'daily', severity: 'high',
  how: `Open A/R invoices whose due date passed more than ${LIMITS.overdueDays} days ago, for customers billed in the last 30 days. Inter-unit billing left out. If "payments not matched" also lists the customer, part of this may already be paid.`,
  columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'overdue', label: `Overdue ${LIMITS.overdueDays}+ days`, kind: 'inr' },
    { key: 'billed30', label: 'Billed last 30 days', kind: 'inr' }, { key: 'balance', label: 'Account balance', kind: 'inr' }],
  rank: { labelKey: 'customer', valueKey: 'overdue', kind: 'inr' },
}, ({ d, M, ok, today, upTo, invUnit }) => {
  const overdue = new Map();
  for (const x of d.invoices || []) {
    if (!isOpenDoc(x) || interUnit(x) || !ok(invUnit.get(x.DocEntry))) continue;
    const bal = num(x.DocTotal) - num(x.PaidToDate);
    if (bal > 1 && day(x.DocDueDate) < addDays(today, -LIMITS.overdueDays)) overdue.set(x.CardCode, (overdue.get(x.CardCode) || 0) + bal);
  }
  const billed = by((d.invoiceLines || []).filter((l) => trade(l) && ok(l.BPLName) && day(l.DocDate) > addDays(upTo, -30) && day(l.DocDate) <= upTo), (l) => l.CardCode);
  const rows = [...overdue.entries()].filter(([c]) => billed.has(c)).map(([c, v]) => ({
    key: c, label: M.partners.get(c)?.CardName || c, metric: v,
    customer: M.partners.get(c)?.CardName || c, cardCode: c, overdue: round(v), billed30: round(sum(billed.get(c), (l) => num(l.LineTotal))),
    balance: num(M.partners.get(c)?.CurrentAccountBalance),
  })).sort((a, b) => b.overdue - a.overdue);
  return { rows, view: (r) => ({
    title: `${r.length} customers were billed in the last 30 days while owing money for over ${LIMITS.overdueDays} days — ${r[0].customer} owes ${short(r[0].overdue)} beyond ${LIMITS.overdueDays} days and was billed ${short(r[0].billed30)}`,
    impact: round(sum(r, (x) => x.overdue)), impactLabel: `overdue beyond ${LIMITS.overdueDays} days`,
    trend: { title: `${r[0].customer}: billed per month`, kind: 'inr', points: monthlySeries((d.invoiceLines || []).filter((l) => trade(l) && l.CardCode === r[0].cardCode), (l) => num(l.LineTotal), lastMonths(6, today)) },
  }) };
});

define({
  id: 'unmatched-payments', area: 'Money', owner: 'Accounts', link: 'receivables', cadence: 'weekly', severity: 'medium',
  how: 'Open A/R invoices added up per customer against the customer\'s account balance in SAP. When the invoices are well above the balance, money was received or credited on account and not matched to the invoices — so overdue figures for that customer look worse than they are until Accounts matches them.',
  columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'openInvoices', label: 'Open invoices', kind: 'inr' },
    { key: 'balance', label: 'Account balance', kind: 'inr' }, { key: 'gap', label: 'Not matched', kind: 'inr' }],
  rank: { labelKey: 'customer', valueKey: 'gap', kind: 'inr' },
}, ({ d, M, unit }) => {
  if (unit) return null; // an account balance is not split by unit
  const open = new Map();
  for (const x of d.invoices || []) {
    if (isOpenDoc(x) && !interUnit(x)) open.set(x.CardCode, (open.get(x.CardCode) || 0) + num(x.DocTotal) - num(x.PaidToDate));
  }
  const rows = [...open.entries()].map(([c, v]) => {
    const b = M.partners.get(c); const bal = num(b?.CurrentAccountBalance);
    return { key: c, label: b?.CardName || c, metric: v - bal, customer: b?.CardName || c, openInvoices: round(v), balance: round(bal), gap: round(v - bal) };
  }).filter((r) => r.gap >= 1e5 && r.gap >= r.openInvoices * 0.1).sort((a, b) => b.gap - a.gap);
  return { rows, view: (r) => ({
    title: `${r.length} customers have payments not matched to their invoices — ${r[0].customer} shows ${short(r[0].openInvoices)} of open invoices but an account balance of ${short(r[0].balance)}`,
    impact: round(sum(r, (x) => x.gap)), impactLabel: 'received, not matched',
  }) };
});

define({
  id: 'due-this-week', area: 'Money', owner: 'Accounts', link: 'receivables', cadence: 'weekly', severity: 'low',
  how: 'Open A/R invoices with a due date from today to 7 days ahead: the collection calls to make this week.',
  columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'invoice', label: 'Invoice', kind: 'num' }, { key: 'due', label: 'Due', kind: 'date' }, { key: 'balance', label: 'Balance', kind: 'inr' }],
  rank: { labelKey: 'customer', valueKey: 'balance', kind: 'inr' },
}, ({ d, ok, today, invUnit }) => {
  const rows = (d.invoices || []).filter((x) => isOpenDoc(x) && !interUnit(x) && ok(invUnit.get(x.DocEntry)) && day(x.DocDueDate) >= today && day(x.DocDueDate) <= addDays(today, 7))
    .map((x) => ({ key: `inv-${x.DocEntry}`, label: `${x.CardName} · invoice ${x.DocNum}`, metric: num(x.DocTotal) - num(x.PaidToDate),
      customer: x.CardName, invoice: x.DocNum, due: day(x.DocDueDate), balance: round(num(x.DocTotal) - num(x.PaidToDate)) }))
    .filter((r) => r.balance > 1).sort((a, b) => b.balance - a.balance);
  return { rows, view: (r) => {
    const top = [...by(r, (x) => x.customer).entries()].map(([c, l]) => ({ c, v: sum(l, (x) => x.balance) })).sort((a, b) => b.v - a.v)[0];
    return { title: `${short(sum(r, (x) => x.balance))} falls due from customers in the next 7 days — biggest: ${top.c} (${short(top.v)})`,
      impact: round(sum(r, (x) => x.balance)), impactLabel: 'due in 7 days' };
  } };
});

define({
  id: 'delivered-not-invoiced', area: 'Money', owner: 'Accounts / dispatch', link: 'dispatch', cadence: 'daily', severity: 'medium',
  how: `Delivery notes still open in SAP (not copied to an A/R invoice) more than ${LIMITS.notInvoicedDays} days after delivery.`,
  columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'delivery', label: 'Delivery', kind: 'num' }, { key: 'date', label: 'Delivered', kind: 'date' }, { key: 'value', label: 'Value', kind: 'inr' }],
  rank: { labelKey: 'customer', valueKey: 'value', kind: 'inr' },
}, ({ d, ok, today }) => {
  const units = unitMap(d.deliveryLines);
  const rows = (d.deliveries || []).filter((x) => isOpenDoc(x) && !interUnit(x) && ok(units.get(x.DocEntry)) && day(x.DocDate) < addDays(today, -LIMITS.notInvoicedDays))
    .map((x) => {
      const age = Math.floor((Date.parse(today) - Date.parse(day(x.DocDate))) / 86400000);
      return { key: `dn-${x.DocEntry}`, label: `${x.CardName} · delivery ${x.DocNum}`, metric: num(x.DocTotal), band: bandOf(age, [15, 30]),
        customer: x.CardName, delivery: x.DocNum, date: day(x.DocDate), value: round(num(x.DocTotal)) };
    }).sort((a, b) => b.value - a.value);
  return { rows, view: (r) => ({
    title: `${r.length} deliveries went out but were never invoiced — ${short(sum(r, (x) => x.value))} not billed (oldest ${r.reduce((a, x) => (x.date < a ? x.date : a), today)})`,
    impact: round(sum(r, (x) => x.value)), impactLabel: 'delivered, not billed',
  }) };
});

// ── Sales ────────────────────────────────────────────────────────────────
function customerLines(d, ok, upTo) {
  const m = new Map();
  for (const l of (d.invoiceLines || [])) {
    if (!trade(l) || !ok(l.BPLName) || day(l.DocDate) > upTo) continue;
    const c = m.get(l.CardCode) || { customer: l.CardName, cardCode: l.CardCode, lines: [] };
    c.lines.push(l); m.set(l.CardCode, c);
  }
  return m;
}

define({
  id: 'quiet-customers', area: 'Sales', owner: 'Sales', link: 'sales', cadence: 'weekly', severity: 'medium',
  how: `Customers billed in at least ${LIMITS.quietMinMonths} of the 6 months before the last ${LIMITS.quietDays} days, and not since. Counted to yesterday.`,
  columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'lastBill', label: 'Last bill', kind: 'date' },
    { key: 'monthsActive', label: 'Months bought (of 6)', kind: 'num' }, { key: 'perMonth', label: 'Usual a month', kind: 'inr' }],
  rank: { labelKey: 'customer', valueKey: 'perMonth', kind: 'inr' },
}, ({ d, ok, today, upTo }) => {
  const from = addDays(upTo, -(LIMITS.quietDays + 180));
  const until = addDays(upTo, -LIMITS.quietDays);
  const all = customerLines(d, ok, upTo);
  const rows = [];
  for (const c of all.values()) {
    const last = c.lines.reduce((a, l) => (day(l.DocDate) > a ? day(l.DocDate) : a), '');
    if (last >= until) continue;
    const win = c.lines.filter((l) => day(l.DocDate) >= from && day(l.DocDate) < until);
    const months = new Set(win.map((l) => monthKey(day(l.DocDate))));
    if (months.size < LIMITS.quietMinMonths) continue;
    const silent = Math.floor((Date.parse(upTo) - Date.parse(last)) / 86400000);
    const perMonth = sum(win, (l) => num(l.LineTotal)) / 6;
    rows.push({ key: c.cardCode, label: c.customer, metric: perMonth, band: bandOf(silent, [90, 180]),
      customer: c.customer, cardCode: c.cardCode, lastBill: last, monthsActive: months.size, perMonth: round(perMonth) });
  }
  rows.sort((a, b) => b.perMonth - a.perMonth);
  return { rows, view: (r) => ({
    title: `${r.length} regular customers have not bought in ${LIMITS.quietDays}+ days — ${r[0].customer} used to buy about ${short(r[0].perMonth)} a month, last bill ${r[0].lastBill}`,
    impact: round(sum(r, (x) => x.perMonth)), impactLabel: 'usual sales a month',
    trend: { title: `${r[0].customer}: billed per month`, kind: 'inr', points: monthlySeries(all.get(r[0].cardCode).lines, (l) => num(l.LineTotal), lastMonths(9, today)) },
  }) };
});

define({
  id: 'buying-less', area: 'Sales', owner: 'Sales', link: 'sales', cadence: 'weekly', severity: 'medium', worse: WORSE_POINTS,
  how: `Last 30 days' billing (to yesterday) against the average month of the 90 days before; flagged when down ${LIMITS.dropPct}% or more from a usual month of at least ${short(LIMITS.dropMinMonthly)}, cleared when back within ${LIMITS.dropClearPct}%. Customers who stopped completely are in "gone quiet".`,
  columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'last30', label: 'Last 30 days', kind: 'inr' }, { key: 'usual', label: 'Usual month', kind: 'inr' }, { key: 'drop', label: 'Down by', kind: 'pct' }],
  rank: { labelKey: 'customer', valueKey: 'usual', kind: 'inr' },
}, ({ d, ok, today, upTo, held }) => {
  const all = customerLines(d, ok, upTo);
  const rows = [];
  for (const c of all.values()) {
    const now = sum(c.lines.filter((l) => day(l.DocDate) > addDays(upTo, -30)), (l) => num(l.LineTotal));
    const usual = sum(c.lines.filter((l) => day(l.DocDate) > addDays(upTo, -120) && day(l.DocDate) <= addDays(upTo, -30)), (l) => num(l.LineTotal)) / 3;
    if (now <= 0 || usual < LIMITS.dropMinMonthly) continue;
    const drop = ((usual - now) / usual) * 100;
    if (drop >= LIMITS.dropPct || (held(c.cardCode) && drop >= LIMITS.dropClearPct)) {
      rows.push({ key: c.cardCode, label: c.customer, metric: drop, customer: c.customer, cardCode: c.cardCode, last30: round(now), usual: round(usual), drop: round(drop) });
    }
  }
  rows.sort((a, b) => (b.usual - b.last30) - (a.usual - a.last30));
  return { rows, view: (r) => ({
    title: `${r.length} customers are buying much less than usual — ${r[0].customer}: ${short(r[0].last30)} in the last 30 days against a usual ${short(r[0].usual)} a month`,
    impact: round(sum(r, (x) => x.usual - x.last30)), impactLabel: 'below their usual month',
    trend: { title: `${r[0].customer}: billed per month`, kind: 'inr', points: monthlySeries(all.get(r[0].cardCode).lines, (l) => num(l.LineTotal), lastMonths(9, today)) },
  }) };
});

function priceWindows(lines, upTo) {
  const m = new Map();
  for (const l of lines) {
    if (num(l.Quantity) <= 0 || !l.ItemCode) continue;
    const x = m.get(l.ItemCode) || { item: l.ItemDescription, itemCode: l.ItemCode, nv: 0, nq: 0, bv: 0, bq: 0 };
    const dd = day(l.DocDate);
    if (dd > upTo) continue;
    if (dd > addDays(upTo, -30)) { x.nv += num(l.LineTotal); x.nq += num(l.Quantity); } else if (dd > addDays(upTo, -120)) { x.bv += num(l.LineTotal); x.bq += num(l.Quantity); }
    m.set(l.ItemCode, x);
  }
  return [...m.values()].filter((x) => x.nq && x.bq).map((x) => ({ ...x, now: x.nv / x.nq, before: x.bv / x.bq }));
}
function monthlyPrice(lines, itemCode, months) {
  const m = Object.fromEntries(months.map((k) => [k, { v: 0, q: 0 }]));
  for (const l of lines) if (l.ItemCode === itemCode) { const k = monthKey(day(l.DocDate) || ''); if (m[k]) { m[k].v += num(l.LineTotal); m[k].q += num(l.Quantity); } }
  return months.map((k) => ({ x: k, y: m[k].q ? round(m[k].v / m[k].q) : 0 }));
}

define({
  id: 'selling-price-down', area: 'Sales', owner: 'Sales head', link: 'sales', cadence: 'weekly', severity: 'medium', worse: { pct: 0, abs: 5 },
  how: `Average selling rate in the last 30 days (to yesterday) against the 90 days before, same item; flagged when down ${LIMITS.sellPriceDropPct}% or more on at least ${short(LIMITS.priceMinValue)} of sales, cleared when back within ${LIMITS.sellPriceClearPct}%.`,
  columns: [{ key: 'item', label: 'Item', kind: 'text' }, { key: 'now', label: 'Rate now', kind: 'inr' }, { key: 'before', label: 'Rate before', kind: 'inr' },
    { key: 'change', label: 'Change', kind: 'pct' }, { key: 'lost', label: 'Less realised', kind: 'inr' }],
  rank: { labelKey: 'item', valueKey: 'lost', kind: 'inr' },
}, ({ d, ok, today, upTo, held }) => {
  const lines = (d.invoiceLines || []).filter((l) => trade(l) && ok(l.BPLName));
  const rows = priceWindows(lines, upTo).filter((x) => x.nv >= LIMITS.priceMinValue).map((x) => ({ ...x, drop: ((x.before - x.now) / x.before) * 100 }))
    .filter((x) => x.drop >= LIMITS.sellPriceDropPct || (held(x.itemCode) && x.drop >= LIMITS.sellPriceClearPct))
    .map((x) => ({ key: x.itemCode, label: x.item, metric: x.drop, item: x.item, itemCode: x.itemCode, now: round(x.now), before: round(x.before),
      change: round(-x.drop), lost: round(x.nq * (x.before - x.now)) }))
    .sort((a, b) => b.lost - a.lost);
  return { rows, view: (r) => ({
    title: `Selling price has fallen on ${r.length} ${r.length === 1 ? 'item' : 'items'} — ${r[0].item} now sells at ₹${r[0].now} against ₹${r[0].before} (${r[0].change}%)`,
    impact: round(sum(r, (x) => x.lost)), impactLabel: 'less realised in 30 days',
    trend: { title: `${r[0].item}: selling rate per month`, kind: 'inr', points: monthlyPrice(lines, r[0].itemCode, lastMonths(6, today)) },
  }) };
});

define({
  id: 'credit-notes', area: 'Sales', owner: 'Sales / quality', link: 'sales', cadence: 'daily', severity: 'medium',
  how: `A/R credit notes (returns, rate differences, claims) in the last 30 days to yesterday, of at least ${short(LIMITS.creditNoteMin)} and ${LIMITS.creditNoteSharePct}% of what the customer was billed.`,
  columns: [{ key: 'customer', label: 'Customer', kind: 'text' }, { key: 'creditNotes', label: 'Credit notes', kind: 'inr' }, { key: 'sales30', label: 'Billed', kind: 'inr' }, { key: 'share', label: 'Share', kind: 'pct' }],
  rank: { labelKey: 'customer', valueKey: 'creditNotes', kind: 'inr' },
}, ({ d, ok, upTo }) => {
  const inWin = (l) => trade(l) && ok(l.BPLName) && day(l.DocDate) > addDays(upTo, -30) && day(l.DocDate) <= upTo;
  const cn = by((d.creditNoteLines || []).filter(inWin), (l) => l.CardCode);
  const sales = by((d.invoiceLines || []).filter(inWin), (l) => l.CardCode);
  const rows = [...cn.entries()].map(([c, l]) => {
    const v = sum(l, (x) => num(x.LineTotal)); const s = sum(sales.get(c) || [], (x) => num(x.LineTotal));
    return { key: c, label: l[0].CardName, metric: v, customer: l[0].CardName, creditNotes: round(v), sales30: round(s), share: s ? round((v / s) * 100) : null };
  }).filter((r) => r.creditNotes >= LIMITS.creditNoteMin && (r.share == null || r.share >= LIMITS.creditNoteSharePct)).sort((a, b) => b.creditNotes - a.creditNotes);
  return { rows, view: (r) => ({
    title: `Credit notes are piling up — ${r[0].customer}: ${short(r[0].creditNotes)} in the last 30 days${r[0].share != null ? ` (${r[0].share}% of what they were billed)` : ''}`,
    impact: round(sum(r, (x) => x.creditNotes)), impactLabel: 'credited in 30 days',
  }) };
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
const lineKey = (l) => `so-${l.DocEntry}-${l.LineNum}`;

define({
  id: 'late-can-ship', area: 'Orders', owner: 'Dispatch', link: 'sales-orders', cadence: 'daily', severity: 'high',
  how: 'Open sales-order lines past their delivery date where stock in hand (the unit\'s warehouses when a unit is chosen) covers the open quantity.',
  columns: [{ key: 'so', label: 'SO', kind: 'num' }, { key: 'customer', label: 'Customer', kind: 'text' }, { key: 'item', label: 'Item', kind: 'text' },
    { key: 'open', label: 'To ship', kind: 'qty' }, { key: 'stock', label: 'In stock', kind: 'qty' }, { key: 'due', label: 'Was due', kind: 'date' }, { key: 'value', label: 'Value', kind: 'inr' }],
  rank: { labelKey: 'customer', valueKey: 'value', kind: 'inr' },
}, ({ d, M, ok, unit, today }) => {
  const stock = stockIn(d, M, unit);
  const late = pendingLines(d, ok).filter((l) => day(l.ShipDate) && day(l.ShipDate) < today);
  const rows = late.filter((l) => (stock.get(l.ItemCode) || 0) >= num(l.RemainingOpenQuantity)).map((l) => {
    const daysLate = Math.floor((Date.parse(today) - Date.parse(day(l.ShipDate))) / 86400000);
    return { key: lineKey(l), label: `SO ${l.DocNum} · ${l.ItemDescription}`, metric: num(l.RemainingOpenQuantity) * priceOf(l), band: bandOf(daysLate, [7, 30]),
      so: l.DocNum, customer: l.CardName, item: l.ItemDescription, open: num(l.RemainingOpenQuantity), due: day(l.ShipDate),
      stock: round(stock.get(l.ItemCode) || 0), value: round(num(l.RemainingOpenQuantity) * priceOf(l)) };
  }).sort((a, b) => b.value - a.value);
  return { rows, view: (r) => ({
    title: `${r.length} of ${late.length} late order lines can ship today — the stock is already there (${short(sum(r, (x) => x.value))})`,
    impact: round(sum(r, (x) => x.value)), impactLabel: 'ready to ship',
  }) };
});

define({
  id: 'due-nothing-moving', area: 'Orders', owner: 'Planning / production', link: 'sales-orders', cadence: 'instant', severity: 'high',
  how: 'Open sales-order lines due in the next 7 days where stock in hand is short and no planned or released production order exists for the item.',
  columns: [{ key: 'so', label: 'SO', kind: 'num' }, { key: 'customer', label: 'Customer', kind: 'text' }, { key: 'item', label: 'Item', kind: 'text' },
    { key: 'open', label: 'To ship', kind: 'qty' }, { key: 'stock', label: 'In stock', kind: 'qty' }, { key: 'due', label: 'Due', kind: 'date' }, { key: 'value', label: 'Value', kind: 'inr' }],
  rank: { labelKey: 'customer', valueKey: 'value', kind: 'inr' },
}, ({ d, M, ok, unit, today }) => {
  const stock = stockIn(d, M, unit);
  const inProd = new Set((d.productionOrders || []).filter((o) => o.ProductionOrderStatus === 'boposReleased' || o.ProductionOrderStatus === 'boposPlanned').map((o) => o.ItemNo));
  const rows = pendingLines(d, ok).filter((l) => day(l.ShipDate) >= today && day(l.ShipDate) <= addDays(today, 7)
    && (stock.get(l.ItemCode) || 0) < num(l.RemainingOpenQuantity) && !inProd.has(l.ItemCode))
    .map((l) => ({ key: lineKey(l), label: `SO ${l.DocNum} · ${l.ItemDescription}`, metric: num(l.RemainingOpenQuantity) * priceOf(l),
      so: l.DocNum, customer: l.CardName, item: l.ItemDescription, open: num(l.RemainingOpenQuantity), stock: round(stock.get(l.ItemCode) || 0),
      due: day(l.ShipDate), value: round(num(l.RemainingOpenQuantity) * priceOf(l)) }))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  return { rows, view: (r) => ({
    title: `${r.length} order lines are due within 7 days with not enough stock and no production order — first due ${r[0].due} (${r[0].customer})`,
    impact: round(sum(r, (x) => x.value)), impactLabel: 'due this week, nothing in motion',
  }) };
});

define({
  id: 'order-book', area: 'Orders', owner: 'Management', link: 'sales-orders', cadence: 'weekly', severity: 'low', noState: true,
  how: 'Value still to ship on open sales-order lines, divided by the average daily dispatch value of the last 30 days to yesterday. Below 15 days the order book is thin.',
  columns: [], rank: null,
}, ({ d, ok, upTo }) => {
  const pending = sum(pendingLines(d, ok), (l) => num(l.RemainingOpenQuantity) * priceOf(l));
  const disp = (d.deliveryLines || []).filter((l) => trade(l) && ok(l.BPLName) && day(l.DocDate) <= upTo);
  const last30 = sum(disp.filter((l) => day(l.DocDate) > addDays(upTo, -30)), (l) => num(l.LineTotal));
  if (!pending || !last30) return null;
  const days = Math.round(pending / (last30 / 30));
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const to = addDays(upTo, -7 * i); const from = addDays(to, -6);
    weeks.push({ x: from, y: round(sum(disp.filter((l) => day(l.DocDate) >= from && day(l.DocDate) <= to), (l) => num(l.LineTotal))) });
  }
  return { rows: [], view: () => ({
    title: `The order book covers about ${days} days of dispatch — ${short(pending)} still to ship at the last 30 days' pace of ${short(last30)}`,
    impact: round(pending), impactLabel: 'still to ship', severity: days < 15 ? 'medium' : 'low',
    trend: { title: 'Dispatch value per week (last 12 weeks)', kind: 'inr', points: weeks },
  }) };
});

// ── Purchase ─────────────────────────────────────────────────────────────
define({
  id: 'buying-price-up', area: 'Purchase', owner: 'Purchase', link: 'purchase', cadence: 'weekly', severity: 'medium', worse: { pct: 0, abs: 5 },
  how: `Average purchase rate (A/P invoices) in the last 30 days to yesterday against the 90 days before, same item; flagged when up ${LIMITS.buyPriceUpPct}% or more on at least ₹1 L of purchases, cleared when back within ${LIMITS.buyPriceClearPct}%.`,
  columns: [{ key: 'item', label: 'Item', kind: 'text' }, { key: 'now', label: 'Rate now', kind: 'inr' }, { key: 'before', label: 'Rate before', kind: 'inr' },
    { key: 'change', label: 'Change', kind: 'pct' }, { key: 'extra', label: 'Extra paid', kind: 'inr' }],
  rank: { labelKey: 'item', valueKey: 'extra', kind: 'inr' },
}, ({ d, ok, today, upTo, held }) => {
  const lines = (d.purchaseInvoiceLines || []).filter((l) => trade(l) && ok(l.BPLName));
  const rows = priceWindows(lines, upTo).filter((x) => x.nv >= 1e5).map((x) => ({ ...x, up: ((x.now - x.before) / x.before) * 100 }))
    .filter((x) => x.up >= LIMITS.buyPriceUpPct || (held(x.itemCode) && x.up >= LIMITS.buyPriceClearPct))
    .map((x) => ({ key: x.itemCode, label: x.item, metric: x.up, item: x.item, itemCode: x.itemCode, now: round(x.now), before: round(x.before),
      change: round(x.up), extra: round(x.nq * (x.now - x.before)) }))
    .sort((a, b) => b.extra - a.extra);
  return { rows, view: (r) => ({
    title: `Buying prices are up on ${r.length} items — ${r[0].item} now costs ₹${r[0].now} against ₹${r[0].before} (+${r[0].change}%), ${short(r[0].extra)} extra in 30 days`,
    impact: round(sum(r, (x) => x.extra)), impactLabel: 'extra paid in 30 days',
    trend: { title: `${r[0].item}: purchase rate per month`, kind: 'inr', points: monthlyPrice(lines, r[0].itemCode, lastMonths(6, today)) },
  }) };
});

define({
  id: 'late-vendors', area: 'Purchase', owner: 'Purchase', link: 'purchase', cadence: 'daily', severity: 'medium',
  how: `Open purchase-order lines from the last 90 days whose delivery date passed more than ${LIMITS.vendorLateDays} days ago. "We owe overdue" is their unpaid A/P past due — often the reason for the delay.`,
  columns: [{ key: 'vendor', label: 'Vendor', kind: 'text' }, { key: 'lines', label: 'Late lines', kind: 'num' }, { key: 'pending', label: 'Pending value', kind: 'inr' },
    { key: 'oldestDue', label: 'Oldest due', kind: 'date' }, { key: 'weOweOverdue', label: 'We owe overdue', kind: 'inr' }],
  rank: { labelKey: 'vendor', valueKey: 'pending', kind: 'inr' },
}, ({ d, ok, today }) => {
  const owe = new Map();
  for (const x of d.purchaseInvoices || []) {
    if (isOpenDoc(x) && !interUnit(x) && day(x.DocDueDate) < today) owe.set(x.CardCode, (owe.get(x.CardCode) || 0) + num(x.DocTotal) - num(x.PaidToDate));
  }
  const late = (d.purchaseOrderLines || []).filter((l) => trade(l) && ok(l.BPLName) && lineOpen(l) && num(l.RemainingOpenQuantity) > 0
    && day(l.ShipDate) < addDays(today, -LIMITS.vendorLateDays) && day(l.DocDate) > addDays(today, -90));
  const rows = [...by(late, (l) => l.CardCode).entries()].map(([c, l]) => {
    const pending = sum(l, (x) => num(x.RemainingOpenQuantity) * priceOf(x));
    return { key: c, label: l[0].CardName, metric: pending, vendor: l[0].CardName, lines: l.length, pending: round(pending),
      oldestDue: l.reduce((a, x) => (day(x.ShipDate) < a ? day(x.ShipDate) : a), today), weOweOverdue: round(owe.get(c) || 0) };
  }).sort((a, b) => b.pending - a.pending);
  return { rows, view: (r) => ({
    title: `${r.length} vendors are more than ${LIMITS.vendorLateDays} days late — ${r[0].vendor} has ${short(r[0].pending)} pending${r[0].weOweOverdue > 1e5 ? `, and we owe them ${short(r[0].weOweOverdue)} overdue` : ''}`,
    impact: round(sum(r, (x) => x.pending)), impactLabel: 'late from vendors',
  }) };
});

define({
  id: 'grn-not-invoiced', area: 'Purchase', owner: 'Accounts', link: 'purchase', cadence: 'weekly', severity: 'low',
  how: `Goods receipt POs still open in SAP (no A/P invoice) more than ${LIMITS.grnNotInvoicedDays} days after receipt.`,
  columns: [{ key: 'vendor', label: 'Vendor', kind: 'text' }, { key: 'grn', label: 'GRN', kind: 'num' }, { key: 'date', label: 'Received', kind: 'date' }, { key: 'value', label: 'Value', kind: 'inr' }],
  rank: { labelKey: 'vendor', valueKey: 'value', kind: 'inr' },
}, ({ d, ok, today }) => {
  const docs = by((d.grpoLines || []).filter((l) => trade(l) && ok(l.BPLName) && (l.DocumentStatus === 'O' || l.DocumentStatus === 'bost_Open')
    && day(l.DocDate) < addDays(today, -LIMITS.grnNotInvoicedDays)), (l) => l.DocEntry);
  const rows = [...docs.values()].map((l) => {
    const age = Math.floor((Date.parse(today) - Date.parse(day(l[0].DocDate))) / 86400000);
    const v = sum(l, (x) => num(x.LineTotal));
    return { key: `grn-${l[0].DocEntry}`, label: `${l[0].CardName} · GRN ${l[0].DocNum}`, metric: v, band: bandOf(age, [30, 60]),
      vendor: l[0].CardName, grn: l[0].DocNum, date: day(l[0].DocDate), value: round(v) };
  }).sort((a, b) => b.value - a.value);
  return { rows, view: (r) => ({
    title: `${r.length} goods receipts have no vendor invoice after ${LIMITS.grnNotInvoicedDays}+ days — ${short(sum(r, (x) => x.value))} not booked as payable`,
    impact: round(sum(r, (x) => x.value)), impactLabel: 'received, not invoiced',
  }) };
});

// ── Stores ───────────────────────────────────────────────────────────────
function usage(d, ok, upTo, days) {
  const m = new Map();
  for (const l of d.productionIssues || []) {
    if (l.BaseType !== 202 || !ok(l.BPLName) || day(l.DocDate) <= addDays(upTo, -days) || day(l.DocDate) > upTo) continue;
    m.set(l.ItemCode, (m.get(l.ItemCode) || 0) + num(l.Quantity) / days);
  }
  return m;
}

define({
  id: 'low-cover', area: 'Stores', owner: 'Stores / purchase', link: 'inventory', cadence: 'instant', severity: 'high', worse: { pct: 0, abs: Infinity },
  how: `Stock in hand ÷ average daily issue to production over the 30 days to yesterday, for RM item groups. Flagged under ${LIMITS.coverDays} days, cleared above ${LIMITS.coverClearDays}. "On order" is open purchase-order quantity in SAP. Films slit from master rolls may show low cover while the master roll is in stock.`,
  columns: [{ key: 'item', label: 'Item', kind: 'text' }, { key: 'group', label: 'Group', kind: 'text' }, { key: 'daysLeft', label: 'Days left', kind: 'num' },
    { key: 'perDay', label: 'Uses a day', kind: 'qty' }, { key: 'stock', label: 'In stock', kind: 'qty' }, { key: 'onOrder', label: 'On order', kind: 'qty' }],
  rank: { labelKey: 'item', valueKey: 'perDay', kind: 'qty' },
}, ({ d, M, ok, unit, today, upTo, held }) => {
  const use = usage(d, ok, upTo, 30);
  const stock = stockIn(d, M, unit);
  const ordered = new Map(); for (const s of d.stock || []) ordered.set(s.ItemCode, (ordered.get(s.ItemCode) || 0) + num(s.Ordered));
  const rows = [...use.entries()].filter(([c, u]) => {
    if (!/^RM/i.test(M.itemGroup(c)) || u <= 0) return false;
    const left = (stock.get(c) || 0) / u;
    return left < LIMITS.coverDays || (held(c) && left < LIMITS.coverClearDays);
  }).map(([c, u]) => {
    const left = (stock.get(c) || 0) / u;
    return { key: c, label: M.items.get(c)?.ItemName || c, metric: -left, band: bandOf(-left, [-3, -1]),
      item: M.items.get(c)?.ItemName || c, itemCode: c, group: M.itemGroup(c), daysLeft: round(left), perDay: round(u),
      stock: round(stock.get(c) || 0), onOrder: round(ordered.get(c) || 0), uom: M.items.get(c)?.InventoryUOM || '' };
  }).sort((a, b) => Number(a.onOrder > 0) - Number(b.onOrder > 0) || a.daysLeft - b.daysLeft);
  return { rows, view: (r) => {
    const none = r.filter((x) => x.onOrder <= 0).length;
    return {
      title: `${r.length} raw materials have less than ${LIMITS.coverDays} days of stock — ${none} with nothing on order (e.g. ${r[0].item}: ${r[0].daysLeft} days left at ${r[0].perDay} ${r[0].uom}/day)`,
      impact: null, impactLabel: null, severity: none ? 'high' : 'medium',
      trend: { title: `${r[0].item}: issued to production per day`, kind: 'qty',
        points: dailySeries((d.productionIssues || []).filter((l) => l.BaseType === 202 && l.ItemCode === r[0].itemCode && ok(l.BPLName)), (l) => num(l.Quantity), addDays(upTo, -29), upTo) },
    };
  } };
});

define({
  id: 'dead-stock', area: 'Stores', owner: 'Stores / management', link: 'inventory', cadence: 'weekly', severity: 'medium',
  how: `Items worth at least ${short(LIMITS.deadMinValue)} in stock (quantity × average cost) with no issue to production, delivery or invoice in the last ${LIMITS.deadDays} days.`,
  columns: [{ key: 'item', label: 'Item', kind: 'text' }, { key: 'group', label: 'Group', kind: 'text' }, { key: 'value', label: 'Stock value', kind: 'inr' }],
  rank: { labelKey: 'item', valueKey: 'value', kind: 'inr' },
}, ({ d, M, unit, today }) => {
  const since = addDays(today, -LIMITS.deadDays);
  const moved = new Set([...(d.productionIssues || []), ...(d.deliveryLines || []), ...(d.invoiceLines || [])].filter((l) => day(l.DocDate) > since).map((l) => l.ItemCode));
  const val = new Map();
  for (const s of d.stock || []) {
    if (unit && M.whs.get(s.WarehouseCode)?.unit !== unit) continue;
    const v = num(s.InStock) * num(s.StandardAveragePrice);
    if (v > 0) val.set(s.ItemCode, (val.get(s.ItemCode) || 0) + v);
  }
  const rows = [...val.entries()].filter(([c, v]) => v >= LIMITS.deadMinValue && !moved.has(c))
    .map(([c, v]) => ({ key: c, label: M.items.get(c)?.ItemName || c, metric: v, item: M.items.get(c)?.ItemName || c, group: M.itemGroup(c), value: round(v) }))
    .sort((a, b) => b.value - a.value);
  return { rows, view: (r) => ({
    title: `${short(sum(r, (x) => x.value))} of stock has not moved in ${LIMITS.deadDays} days — ${r.length} items, the largest ${r[0].item} (${short(r[0].value)})`,
    impact: round(sum(r, (x) => x.value)), impactLabel: 'tied up in idle stock',
  }) };
});

define({
  id: 'buying-overstock', area: 'Purchase', owner: 'Purchase', link: 'purchase', cadence: 'weekly', severity: 'medium',
  how: `Open PO lines for RM, BFL and consumables where stock in hand ÷ average daily use (issues and sales, 90 days to yesterday) is above ${LIMITS.overstockDays} days.`,
  columns: [{ key: 'po', label: 'PO', kind: 'num' }, { key: 'vendor', label: 'Vendor', kind: 'text' }, { key: 'item', label: 'Item', kind: 'text' },
    { key: 'ordering', label: 'Still to come', kind: 'qty' }, { key: 'stock', label: 'In stock', kind: 'qty' }, { key: 'daysOfStock', label: 'Days of stock', kind: 'num' }, { key: 'value', label: 'Value', kind: 'inr' }],
  rank: { labelKey: 'item', valueKey: 'value', kind: 'inr' },
}, ({ d, M, ok, upTo }) => {
  const use = usage(d, ok, upTo, 90);
  for (const l of d.invoiceLines || []) if (day(l.DocDate) > addDays(upTo, -90) && day(l.DocDate) <= upTo) use.set(l.ItemCode, (use.get(l.ItemCode) || 0) + num(l.Quantity) / 90);
  const stock = new Map(); for (const s of d.stock || []) stock.set(s.ItemCode, (stock.get(s.ItemCode) || 0) + num(s.InStock));
  const rows = (d.purchaseOrderLines || []).filter((l) => trade(l) && ok(l.BPLName) && lineOpen(l) && num(l.RemainingOpenQuantity) > 0
    && /^(RM|BFL|Consumables)/i.test(M.itemGroup(l.ItemCode)) && (use.get(l.ItemCode) || 0) > 0
    && (stock.get(l.ItemCode) || 0) / use.get(l.ItemCode) > LIMITS.overstockDays)
    .map((l) => ({ key: `po-${l.DocEntry}-${l.LineNum}`, label: `PO ${l.DocNum} · ${l.ItemDescription}`, metric: num(l.RemainingOpenQuantity) * priceOf(l),
      po: l.DocNum, vendor: l.CardName, item: l.ItemDescription, ordering: num(l.RemainingOpenQuantity), stock: round(stock.get(l.ItemCode) || 0),
      daysOfStock: Math.round((stock.get(l.ItemCode) || 0) / use.get(l.ItemCode)), value: round(num(l.RemainingOpenQuantity) * priceOf(l)) }))
    .filter((r) => r.value >= 25000).sort((a, b) => b.value - a.value);
  return { rows, view: (r) => ({
    title: `${r.length} open purchase orders are for materials we already hold ${LIMITS.overstockDays}+ days of — ${short(sum(r, (x) => x.value))} could be held back`,
    impact: round(sum(r, (x) => x.value)), impactLabel: 'on order, not needed yet',
  }) };
});

// ── Production ───────────────────────────────────────────────────────────
define({
  id: 'stuck-orders', area: 'Production', owner: 'Production', link: 'production', cadence: 'daily', severity: 'medium', worse: { pct: 0, abs: Infinity },
  how: `Released orders posted in the last ${LIMITS.recentOrderDays} days, not complete, with material issued, and no receipt from production for ${LIMITS.stuckDays} days. Either the work is stuck or the order should be closed.`,
  columns: [{ key: 'order', label: 'Order', kind: 'num' }, { key: 'product', label: 'Product', kind: 'text' }, { key: 'machine', label: 'Machine', kind: 'text' },
    { key: 'done', label: 'Done', kind: 'qty' }, { key: 'planned', label: 'Planned', kind: 'qty' }, { key: 'progress', label: 'Progress', kind: 'pct' }, { key: 'lastActivity', label: 'Last activity', kind: 'date' }],
  rank: null,
}, ({ d, ok, today }) => {
  const lastOut = new Map(); const lastIssue = new Map(); const unitOf = new Map();
  for (const l of d.productionReceipts || []) {
    if (l.BaseType !== 202) continue;
    if (day(l.DocDate) > (lastOut.get(l.BaseEntry) || '')) lastOut.set(l.BaseEntry, day(l.DocDate));
    if (l.BPLName) unitOf.set(l.BaseEntry, l.BPLName);
  }
  for (const l of d.productionIssues || []) {
    if (l.BaseType !== 202) continue;
    if (day(l.DocDate) > (lastIssue.get(l.BaseEntry) || '')) lastIssue.set(l.BaseEntry, day(l.DocDate));
    if (l.BPLName) unitOf.set(l.BaseEntry, l.BPLName);
  }
  const rows = (d.productionOrders || []).filter((o) => o.ProductionOrderStatus === 'boposReleased' && day(o.PostingDate) > addDays(today, -LIMITS.recentOrderDays)
    && lastIssue.has(o.AbsoluteEntry) && ok(unitOf.get(o.AbsoluteEntry)) && num(o.CompletedQuantity) < num(o.PlannedQuantity)
    && (lastOut.get(o.AbsoluteEntry) || lastIssue.get(o.AbsoluteEntry)) < addDays(today, -LIMITS.stuckDays))
    .map((o) => {
      const last = lastOut.get(o.AbsoluteEntry) || lastIssue.get(o.AbsoluteEntry);
      const idle = Math.floor((Date.parse(today) - Date.parse(last)) / 86400000);
      return { key: `po-${o.AbsoluteEntry}`, label: `#${o.DocumentNumber} ${o.ProductDescription}`, metric: idle, band: bandOf(idle, [30, 60]),
        order: o.DocumentNumber, product: o.ProductDescription, machine: o.U_MACHINE || '—',
        done: num(o.CompletedQuantity), planned: num(o.PlannedQuantity), progress: round((num(o.CompletedQuantity) / (num(o.PlannedQuantity) || 1)) * 100), lastActivity: last };
    }).sort((a, b) => (a.lastActivity < b.lastActivity ? -1 : 1));
  return { rows, view: (r) => ({
    title: `${r.length} released production orders have had material issued but no output for ${LIMITS.stuckDays}+ days — oldest #${r[0].order} ${r[0].product}`,
    impact: null, impactLabel: null,
  }) };
});

/** Receipts per machine (Karni's machine names, see reportService prodRules), this week and the usual. */
function machineWeeks(d, P, ok, upTo, filter) {
  const m = new Map();
  for (const l of d.productionReceipts || []) {
    if (l.BaseType !== 202 || !ok(l.BPLName) || !filter(l)) continue;
    const k = P.machineOf(l);
    if (!k) continue;
    const dd = day(l.DocDate);
    if (dd > upTo) continue;
    const x = m.get(k) || { week: 0, usualMonth: 0, lines: [] };
    if (dd > addDays(upTo, -7)) x.week += num(l.Quantity);
    else if (dd > addDays(upTo, -37)) x.usualMonth += num(l.Quantity);
    if (dd > addDays(upTo, -37)) x.lines.push(l);
    m.set(k, x);
  }
  return { m, nameOf: P.machineName };
}

define({
  id: 'machine-drop', area: 'Production', owner: 'Production', link: 'production', cadence: 'daily', severity: 'medium', worse: WORSE_POINTS,
  how: `Output (receipts of the production order's own item; wastage and other items left out) in the 7 days to yesterday against the machine's average week over the 30 days before. Flagged below ${100 - LIMITS.machineDropPct}% of usual, cleared above ${100 - LIMITS.machineClearPct}%. Machines are named as in Karni's machine-wise SAP report.`,
  columns: [{ key: 'machine', label: 'Machine', kind: 'text' }, { key: 'week', label: 'Last 7 days', kind: 'qty' }, { key: 'usual', label: 'Usual week', kind: 'qty' }, { key: 'pctOfUsual', label: 'Of usual', kind: 'pct' }],
  rank: { labelKey: 'machine', valueKey: 'usual', kind: 'qty' },
}, ({ d, P, ok, upTo, held }) => {
  const { m, nameOf } = machineWeeks(d, P, ok, upTo, (l) => P.kindOf(l) === 'output');
  const all = [...m.entries()].map(([k, x]) => ({ k, machine: nameOf(k), week: x.week, usual: (x.usualMonth / 30) * 7, lines: x.lines }))
    .filter((r) => r.usual >= LIMITS.machineMinWeekly).map((r) => ({ ...r, drop: (1 - r.week / r.usual) * 100 }));
  const rows = all.filter((r) => r.drop >= LIMITS.machineDropPct || (held(r.k) && r.drop >= LIMITS.machineClearPct))
    .map((r) => ({ key: r.k, label: r.machine, metric: r.drop, machine: r.machine, week: round(r.week), usual: round(r.usual), pctOfUsual: round(100 - r.drop), lines: r.lines }))
    .sort((a, b) => (b.usual - b.week) - (a.usual - a.week));
  return { rows, view: (r) => ({
    title: `${r.length} machines produced far less than their usual week — ${r[0].machine}: ${Math.round(r[0].week)} kg in the last 7 days against about ${Math.round(r[0].usual)} kg`,
    impact: null, impactLabel: null,
    trend: { title: `${r[0].machine}: output per day`, kind: 'qty', points: dailySeries(r[0].lines, (l) => num(l.Quantity), addDays(upTo, -36), upTo) },
  }) };
});

define({
  id: 'scrap-up', area: 'Production', owner: 'Production / quality', link: 'production', cadence: 'daily', severity: 'medium', worse: { pct: 0, abs: 2 },
  how: 'Wastage received against production orders (trim and other wastage, SC items) as a share of output plus wastage, 7 days to yesterday against the 30 days before.',
  columns: [{ key: 'machine', label: 'Machine', kind: 'text' }, { key: 'scrapWeek', label: 'Scrap this week', kind: 'qty' }, { key: 'rateNow', label: 'Scrap rate now', kind: 'pct' }, { key: 'rateUsual', label: 'Usual rate', kind: 'pct' }],
  rank: { labelKey: 'machine', valueKey: 'rateNow', kind: 'pct' },
}, ({ d, P, ok, upTo }) => {
  const isScrap = (l) => ['trim', 'wastage'].includes(P.kindOf(l));
  const all = machineWeeks(d, P, ok, upTo, (l) => P.kindOf(l) !== 'other');
  const scrap = machineWeeks(d, P, ok, upTo, isScrap);
  const rows = [...scrap.m.entries()].map(([k, s]) => {
    const a = all.m.get(k); if (!a) return null;
    const rateNow = a.week ? (s.week / a.week) * 100 : 0;
    const rateUsual = a.usualMonth ? (s.usualMonth / a.usualMonth) * 100 : 0;
    return { key: k, label: all.nameOf(k), metric: rateNow, machine: all.nameOf(k), scrapWeek: round(s.week), rateNow: round(rateNow), rateUsual: round(rateUsual) };
  }).filter((r) => r && r.scrapWeek > 50 && r.rateNow >= r.rateUsual * LIMITS.scrapRiseX && r.rateNow - r.rateUsual >= LIMITS.scrapMinPts)
    .sort((a, b) => (b.rateNow - b.rateUsual) - (a.rateNow - a.rateUsual));
  return { rows, view: (r) => ({
    title: `Scrap is up on ${r.length} ${r.length === 1 ? 'machine' : 'machines'} — ${r[0].machine}: ${r[0].rateNow}% of output this week against a usual ${r[0].rateUsual}%`,
    impact: null, impactLabel: null,
  }) };
});

// ═════════════════════════════════════════════════════════════════════════
// Engine
// ═════════════════════════════════════════════════════════════════════════
export const RULE_META = Object.fromEntries(RULES.map((r) => [r.id, { area: r.area, cadence: r.cadence, owner: r.owner, link: r.link, noState: !!r.noState }]));
const SEVERITY = { high: 0, medium: 1, low: 2 };
const ACTIVE = new Set(['new', 'open']);
const HANDLED = new Set(['done', 'snoozed', 'muted']);

async function loadStates(companyId) {
  // Ages are worked out by the database, so its clock is the only one that matters.
  const [rows] = await pool.query(
    `SELECT *, (snooze_until IS NOT NULL AND snooze_until <= NOW()) AS snooze_over,
            TIMESTAMPDIFF(SECOND, acted_at, NOW()) AS acted_age, TIMESTAMPDIFF(SECOND, first_seen_at, NOW()) AS first_age
       FROM kd_insight_state WHERE company_id = ?`, [companyId]);
  const m = new Map();
  for (const s of rows) m.set(`${s.rule_id}|${s.subject_key}`, s);
  return m;
}

/** Run every rule for one unit (or all units). Returns raw rows per rule. */
async function evaluate(companyId, unit, states) {
  const d = await load(companyId, DATASETS);
  const M = masters(d);
  const P = prodRules(d, M);
  const today = todayIso();
  const out = [];
  const failed = [];
  for (const r of RULES) {
    const held = (key) => { const s = states.get(`${r.id}|${key}`); return !!s && s.status !== 'resolved'; };
    const ctx = { d, M, P, unit, ok: (v) => !unit || v === unit, today, upTo: addDays(today, -1), invUnit: unitMap(d.invoiceLines), held };
    try {
      const res = r.compute(ctx);
      if (res) out.push({ rule: r, rows: res.rows || [], view: res.view });
    } catch (err) {
      failed.push({ rule: r.id, error: err.message });
    }
  }
  return { out, failed };
}

/** Did this finding get materially worse since someone marked it? */
function worse(rule, row, s) {
  if (row.band != null && s.acted_band != null && row.band > s.acted_band) return 'moved into a worse band';
  if (s.acted_metric == null || row.metric == null) return null;
  const { pct, abs } = rule.worse;
  const grew = row.metric - s.acted_metric;
  if (grew >= abs && grew >= Math.abs(s.acted_metric) * (pct / 100)) return 'got worse';
  return null;
}

/**
 * Keep kd_insight_state in step with the data (all units). Runs after every
 * connector run. Returns the findings that became new (for instant alerts).
 */
export async function refresh(companyId) {
  const states = await loadStates(companyId);
  const { out, failed } = await evaluate(companyId, null, states);
  const changes = [];
  const seen = new Set();
  const failedIds = new Set(failed.map((f) => f.rule));

  for (const { rule, rows } of out) {
    if (rule.noState) continue;
    for (const row of rows) {
      const id = `${rule.id}|${row.key}`;
      seen.add(id);
      const s = states.get(id);
      let status = s?.status; let reason = s?.reason ?? null; let restart = !s; let clearActed = false;
      if (!s) { status = 'new'; reason = 'first seen'; }
      else if (s.status === 'resolved') { status = 'new'; reason = 'back again'; restart = true; clearActed = true; }
      else if (s.status === 'new' && s.first_age > 86400) { status = 'open'; }
      else if (s.status === 'done') {
        const w = worse(rule, row, s);
        if (w) { status = 'new'; reason = `${w} since marked done`; }
        else if (s.acted_age > GRACE_S) { status = 'open'; reason = `still here ${LIMITS.graceDays} days after marked done`; }
      } else if (s.status === 'snoozed') {
        const w = worse(rule, row, s);
        if (w) { status = 'new'; reason = `${w} while snoozed`; }
        else if (Number(s.snooze_over) === 1) { status = 'open'; reason = 'snooze ended'; }
      } else if (s.status === 'muted') {
        if (s.acted_metric > 0 && row.metric >= s.acted_metric * LIMITS.muteReturnX) { status = 'new'; reason = 'doubled since marked not relevant'; }
      }
      if (s && status !== s.status) changes.push({ rule: rule.id, key: row.key, from: s.status, to: status, reason, metric: row.metric });
      await pool.query(
        `INSERT INTO kd_insight_state (company_id, rule_id, subject_key, subject_label, status, reason, metric, band, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE subject_label = VALUES(subject_label), status = VALUES(status), reason = VALUES(reason), metric = VALUES(metric),
           band = VALUES(band), first_seen_at = IF(?, NOW(), first_seen_at), last_seen_at = NOW(), resolved_at = NULL
           ${clearActed ? ', acted_by = NULL, acted_by_name = NULL, acted_at = NULL, acted_metric = NULL, acted_band = NULL, snooze_until = NULL, note = NULL, notified_at = NULL' : ''}`,
        [companyId, rule.id, String(row.key).slice(0, 120), String(row.label || '').slice(0, 200), status, reason, row.metric ?? null, row.band ?? null, restart ? 1 : 0]);
    }
  }
  // Gone from the data → resolved (only for rules that ran cleanly).
  for (const [id, s] of states) {
    if (seen.has(id) || s.status === 'resolved' || failedIds.has(s.rule_id) || RULE_META[s.rule_id]?.noState) continue;
    await pool.query("UPDATE kd_insight_state SET status = 'resolved', reason = 'no longer in the data', resolved_at = NOW() WHERE company_id = ? AND rule_id = ? AND subject_key = ?",
      [companyId, s.rule_id, s.subject_key]);
    changes.push({ rule: s.rule_id, key: s.subject_key, from: s.status, to: 'resolved' });
  }
  if (changes.length) {
    const values = changes.map((c) => [companyId, c.rule, String(c.key).slice(0, 120), `auto:${c.to}`, null, 'system', c.metric ?? null, c.reason || null]);
    await pool.query('INSERT INTO kd_insight_log (company_id, rule_id, subject_key, action, by_user, by_name, metric, note) VALUES ?', [values]);
  }
  memo.clear();
  return { changes, failed };
}

// Answers are kept per company + unit until the data or a state changes.
const memo = new Map();
const lastRefresh = new Map();
const REFRESH_EVERY_MS = 15 * 60 * 1000;

/** The screen: findings that still need someone, cards built from them. */
export async function insights(companyId, q = {}) {
  const unit = q.unit || null;
  const showHandled = q.handled === '1';
  const asOf = await lastSync(companyId);
  // States are normally refreshed by the connector run; refresh here when that has not happened lately.
  if (!lastRefresh.get(companyId) || Date.now() - lastRefresh.get(companyId) > REFRESH_EVERY_MS) {
    await refresh(companyId); lastRefresh.set(companyId, Date.now());
  }
  const key = `${companyId}|${unit || ''}|${asOf}|${showHandled}`;
  const hit = memo.get(key);
  if (hit) return hit;

  const states = await loadStates(companyId);
  const { out, failed } = await evaluate(companyId, unit, states);
  const cards = [];
  const handled = [];
  for (const { rule, rows, view } of out) {
    const annotated = rows.map((r) => {
      const s = states.get(`${rule.id}|${r.key}`);
      return { ...r, _status: s?.status === 'resolved' || !s ? 'new' : s.status, _reason: s?.reason ?? null, _since: s?.first_seen_at ?? null,
        _by: s?.acted_by_name ?? null, _at: s?.acted_at ?? null, _note: s?.note ?? null, _until: s?.snooze_until ?? null };
    });
    const visible = rule.noState ? annotated : annotated.filter((r) => ACTIVE.has(r._status));
    const done = annotated.filter((r) => HANDLED.has(r._status));
    if (showHandled && done.length) handled.push({ id: rule.id, area: rule.area, columns: rule.columns, rows: done.map(strip) });
    if (!visible.length && !rule.noState) continue;
    const v = view(visible);
    cards.push({
      id: rule.id, area: rule.area, owner: rule.owner, link: rule.link, cadence: rule.cadence, how: rule.how,
      severity: v.severity || rule.severity, title: v.title, impact: v.impact ?? null, impactLabel: v.impactLabel ?? null, trend: v.trend,
      columns: rule.columns, rank: rule.rank, noState: !!rule.noState,
      rows: visible.slice(0, 200).map(strip), total: visible.length,
      newCount: visible.filter((r) => r._status === 'new').length, handledCount: done.length,
    });
  }
  cards.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || (b.impact ?? 0) - (a.impact ?? 0));
  const value = { asOf, today: todayIso(), unit, limits: LIMITS, insights: cards, handled, failed };
  memo.set(key, value);
  return value;
}

/** Rows go to the screen without internal fields (lines, item codes kept for keys). */
function strip(r) {
  const { lines, ...rest } = r;
  return rest;
}

/** Done / snooze / not relevant / reopen / note, on one finding. */
export async function act(companyId, ruleId, subjectKey, { action, days, note }, user) {
  const [[s]] = await pool.query('SELECT * FROM kd_insight_state WHERE company_id = ? AND rule_id = ? AND subject_key = ?', [companyId, ruleId, subjectKey]);
  if (!s) { const e = new Error('No such finding.'); e.status = 404; throw e; }
  const who = [user?.id ?? null, String(user?.name || user?.email || 'someone').slice(0, 120)];
  const cleanNote = note ? String(note).slice(0, 500) : null;
  if (action === 'done' || action === 'mute' || action === 'snooze') {
    const status = action === 'done' ? 'done' : action === 'mute' ? 'muted' : 'snoozed';
    const snoozeDays = action === 'snooze' ? Math.min(Math.max(Number(days) || 7, 1), 90) : null;
    await pool.query(
      `UPDATE kd_insight_state SET status = ?, reason = NULL, acted_by = ?, acted_by_name = ?, acted_at = NOW(), acted_metric = metric, acted_band = band,
         snooze_until = IF(? IS NULL, NULL, DATE_ADD(NOW(), INTERVAL ? DAY)), note = COALESCE(?, note) WHERE company_id = ? AND rule_id = ? AND subject_key = ?`,
      [status, ...who, snoozeDays, snoozeDays, cleanNote, companyId, ruleId, subjectKey]);
  } else if (action === 'reopen') {
    await pool.query(
      `UPDATE kd_insight_state SET status = 'open', reason = 'reopened', snooze_until = NULL WHERE company_id = ? AND rule_id = ? AND subject_key = ?`,
      [companyId, ruleId, subjectKey]);
  } else if (action === 'note') {
    await pool.query('UPDATE kd_insight_state SET note = ? WHERE company_id = ? AND rule_id = ? AND subject_key = ?', [cleanNote, companyId, ruleId, subjectKey]);
  } else {
    const e = new Error('Unknown action.'); e.status = 400; throw e;
  }
  await pool.query('INSERT INTO kd_insight_log (company_id, rule_id, subject_key, action, by_user, by_name, metric, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [companyId, ruleId, subjectKey, action, ...who, s.metric, cleanNote]);
  memo.clear();
  return { ok: true };
}

/** The history of one finding. */
export async function history(companyId, ruleId, subjectKey) {
  const [rows] = await pool.query(
    'SELECT action, by_name AS byName, at, metric, note FROM kd_insight_log WHERE company_id = ? AND rule_id = ? AND subject_key = ? ORDER BY at DESC LIMIT 50',
    [companyId, ruleId, subjectKey]);
  return { rows };
}
