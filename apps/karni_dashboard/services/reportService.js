import { pool } from '../../../db.js';

/**
 * The dashboard's figures, worked out from the SAP rows the connector pushed
 * (kd_rows). Each dataset is read once per company and kept in memory until a
 * push replaces it (invalidate), so screens are quick and never ask SAP.
 *
 * SAP conventions used here:
 *   - a document is OPEN when DocumentStatus = 'bost_Open'
 *   - a cancelled document AND its cancellation both carry Cancelled = 'tYES';
 *     both are left out, which nets them to zero
 *   - sales are net of tax: DocTotal − VatSum (headers) or LineTotal (lines);
 *     credit notes subtract
 *   - the financial year runs April to March; "today" is India time
 *   - a document's unit is its business place (BPLName, "Unit 1" / "Unit 2"),
 *     carried on the line datasets; header-only datasets borrow it by DocEntry
 *   - production output = receipts from production (BaseType 202) and input =
 *     issues for production (BaseType 202), both keyed to the production order
 */
const cache = new Map(); // `${companyId}:${dataset}` -> { at, rows }
const TTL_MS = 15 * 60 * 1000;

export function invalidate(companyId, dataset) {
  for (const k of [...cache.keys()]) {
    if (k === `${companyId}:${dataset}` || (!dataset && k.startsWith(`${companyId}:`))) cache.delete(k);
  }
}

async function rows(companyId, dataset) {
  const k = `${companyId}:${dataset}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const [r] = await pool.query('SELECT data FROM kd_rows WHERE company_id = ? AND dataset = ?', [companyId, dataset]);
  const list = r.map((x) => (typeof x.data === 'string' ? JSON.parse(x.data) : x.data));
  cache.set(k, { at: Date.now(), rows: list });
  return list;
}

async function load(companyId, names) {
  const out = {};
  await Promise.all(names.map(async (n) => { out[n] = await rows(companyId, n); }));
  return out;
}

// ── Small helpers ─────────────────────────────────────────────────────────
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const day = (v) => (v ? String(v).slice(0, 10) : null);
// The document API says tYES / bost_Open; line data read through $crossjoin carries SAP's raw codes (Y, C / O).
const live = (d) => d.Cancelled !== 'tYES' && d.Cancelled !== 'Y' && d.Cancelled !== 'C';
const lineOpen = (l) => l.LineStatus === 'bost_Open' || l.LineStatus === 'O';
/** Inter-unit documents (Karni billing itself between units): left out of trade figures. */
const interUnit = (x) => /^IBR/i.test(x.CardCode || '') || /^KARNI PACKAGING/i.test(x.CardName || '');
const trade = (x) => live(x) && !interUnit(x);
const isOpen = (d) => (d.DocumentStatus === 'bost_Open' || d.DocumentStatus === 'O') && live(d);
const net = (d) => num(d.DocTotal) - num(d.VatSum);
const balance = (d) => num(d.DocTotal) - num(d.PaidToDate);
const round = (v) => Math.round(v * 100) / 100;
const IST_MS = 5.5 * 3600000;
const todayIso = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
const monthKey = (iso) => iso.slice(0, 7);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const sumBy = (list, f) => list.reduce((t, x) => t + f(x), 0);

function fyStart(iso = todayIso()) {
  const [y, m] = iso.split('-').map(Number);
  return `${m >= 4 ? y : y - 1}-04-01`;
}
function lastMonths(n, iso = todayIso()) {
  const [y, m] = iso.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  return out;
}
function daysRange(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}
/** Range from the query, defaulting to this financial year. */
function rangeOf(q = {}, defFrom) {
  const to = ISO.test(q.to || '') ? q.to : todayIso();
  const from = ISO.test(q.from || '') ? q.from : (defFrom || fyStart(to));
  return { from, to };
}
const inRange = (d, { from, to }) => { const x = day(d); return x && x >= from && x <= to; };

/** Group rows by a key and add up the named measures. */
function group(list, keyFn, measures, extra = () => ({})) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    let g = m.get(k);
    if (!g) { g = { key: k, count: 0, ...extra(x) }; for (const name of Object.keys(measures)) g[name] = 0; m.set(k, g); }
    g.count += 1;
    for (const [name, f] of Object.entries(measures)) g[name] += f(x);
  }
  return [...m.values()].map((g) => {
    for (const name of Object.keys(measures)) g[name] = round(g[name]);
    return g;
  });
}
const desc = (k) => (a, b) => b[k] - a[k];

// ── Masters ───────────────────────────────────────────────────────────────
function masters(d) {
  const groups = Object.fromEntries((d.itemGroups || []).map((g) => [g.Number, g.GroupName]));
  const items = new Map((d.items || []).map((i) => [i.ItemCode, i]));
  const itemGroup = (code) => {
    const it = items.get(code);
    return it ? (groups[it.ItemsGroupCode] || `Group ${it.ItemsGroupCode}`) : 'Unknown';
  };
  const places = Object.fromEntries((d.businessPlaces || []).map((p) => [p.BPLID, p.BPLName]));
  const whs = new Map((d.warehouses || []).map((w) => [w.WarehouseCode, { name: w.WarehouseName, unit: places[w.BusinessPlaceID] || null }]));
  const people = Object.fromEntries((d.salesPersons || []).map((p) => [p.SalesEmployeeCode, p.SalesEmployeeName]));
  const uomOf = (l) => (l.UoMCode && l.UoMCode !== 'Manual' ? l.UoMCode : items.get(l.ItemCode)?.InventoryUOM || '');
  const partners = new Map((d.businessPartners || []).map((b) => [b.CardCode, b]));
  return { groups, items, itemGroup, whs, people, partners, uomOf };
}
const MASTER_SETS = ['items', 'itemGroups', 'warehouses', 'businessPlaces', 'salesPersons', 'businessPartners'];

/** DocEntry -> unit, from a line dataset. */
function unitMap(lines) {
  const m = new Map();
  for (const l of lines || []) if (l.BPLName && !m.has(l.DocEntry)) m.set(l.DocEntry, l.BPLName);
  return m;
}
const unitOk = (unit) => (v) => !unit || v === unit;

async function lastSync(companyId) {
  const [[r]] = await pool.query("SELECT MAX(last_ok_at) AS at FROM kd_dataset_state WHERE company_id = ? AND dataset NOT LIKE 'probe:%'", [companyId]);
  return r?.at ?? null;
}

/** The units seen in the data, for the unit switch. */
export async function units(companyId) {
  const d = await load(companyId, ['businessPlaces', 'invoiceLines']);
  const seen = new Set((d.businessPlaces || []).map((p) => p.BPLName).filter(Boolean));
  for (const l of d.invoiceLines || []) if (l.BPLName) seen.add(l.BPLName);
  return { units: [...seen].sort() };
}

// ── Sales lines (invoice + / credit note −) ───────────────────────────────
function salesLines(d, unit) {
  const ok = unitOk(unit);
  return [
    ...(d.invoiceLines || []).filter((l) => trade(l) && ok(l.BPLName)).map((l) => ({ ...l, sign: 1 })),
    ...(d.creditNoteLines || []).filter((l) => trade(l) && ok(l.BPLName)).map((l) => ({ ...l, sign: -1 })),
  ];
}
function salesDocs(d, unit) {
  const iu = unitMap(d.invoiceLines);
  const cu = unitMap(d.creditNoteLines);
  const ok = unitOk(unit);
  return [
    ...(d.invoices || []).filter((x) => trade(x) && ok(iu.get(x.DocEntry))).map((x) => ({ d: x, sign: 1, unit: iu.get(x.DocEntry) || null })),
    ...(d.creditNotes || []).filter((x) => trade(x) && ok(cu.get(x.DocEntry))).map((x) => ({ d: x, sign: -1, unit: cu.get(x.DocEntry) || null })),
  ];
}
function sumSales(docs, from, to) {
  let t = 0;
  for (const { d, sign } of docs) { const x = day(d.DocDate); if (x && x >= from && x <= to) t += sign * net(d); }
  return round(t);
}
const payTotal = (p) => num(p.CashSum) + num(p.TransferSum);
const payLive = (p) => p.CancelStatus !== 'csYes' && p.CancelStatus !== 'csCancellation';

// ── Ageing of open documents ──────────────────────────────────────────────
function bucketOf(over) {
  if (over <= 0) return 'notDue';
  if (over <= 30) return 'd0_30';
  if (over <= 60) return 'd31_60';
  if (over <= 90) return 'd61_90';
  return 'd90plus';
}
const AGE_KEYS = ['notDue', 'd0_30', 'd31_60', 'd61_90', 'd90plus', 'total'];
function ageing(docs, today, units = new Map()) {
  const parties = new Map();
  const open = [];
  for (const d of docs) {
    if (!isOpen(d)) continue;
    const bal = balance(d);
    if (Math.abs(bal) < 0.005) continue;
    const due = day(d.DocDueDate) || day(d.DocDate);
    const over = due ? daysBetween(due, today) : 0;
    const p = parties.get(d.CardCode) || { cardCode: d.CardCode, cardName: d.CardName, notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0, docs: 0 };
    p[bucketOf(over)] += bal; p.total += bal; p.docs += 1;
    parties.set(d.CardCode, p);
    open.push({
      docEntry: d.DocEntry, docNum: d.DocNum, docDate: day(d.DocDate), dueDate: due, cardCode: d.CardCode, cardName: d.CardName,
      unit: units.get(d.DocEntry) || null, total: num(d.DocTotal), paid: num(d.PaidToDate), balance: round(bal), daysOverdue: Math.max(0, over),
    });
  }
  const list = [...parties.values()].map((p) => { for (const k of AGE_KEYS) p[k] = round(p[k]); return p; }).sort(desc('total'));
  const totals = Object.fromEntries(AGE_KEYS.map((k) => [k, round(sumBy(list, (p) => p[k]))]));
  open.sort((a, b) => b.daysOverdue - a.daysOverdue || b.balance - a.balance);
  return { totals, parties: list, open };
}
function dueSoon(open, today, days) {
  const until = addDays(today, days);
  const list = open.filter((o) => o.dueDate >= today && o.dueDate <= until).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  return { count: list.length, amount: round(sumBy(list, (o) => o.balance)), docs: list.slice(0, 50) };
}

function openDocs(docs, today, units, unit, people = {}) {
  const ok = unitOk(unit);
  const list = docs.filter((x) => isOpen(x) && ok(units.get(x.DocEntry))).map((x) => ({
    docEntry: x.DocEntry, docNum: x.DocNum, docDate: day(x.DocDate), dueDate: day(x.DocDueDate), cardCode: x.CardCode, cardName: x.CardName,
    unit: units.get(x.DocEntry) || null, total: num(x.DocTotal), net: round(net(x)),
    daysOld: x.DocDate ? daysBetween(day(x.DocDate), today) : null, late: x.DocDueDate ? day(x.DocDueDate) < today : false,
    salesPerson: x.SalesPersonCode, salesPersonName: people[x.SalesPersonCode] || null,
  })).sort((a, b) => (a.docDate < b.docDate ? 1 : -1));
  return { count: list.length, value: round(sumBy(list, (r) => r.total)), late: list.filter((r) => r.late).length, rows: list };
}

// ═════════════════════════════════════════════════════════════════════════
// Screens
// ═════════════════════════════════════════════════════════════════════════

export async function status(companyId) {
  const [connectors] = await pool.query(
    `SELECT id, connector_uid AS connectorUid, machine, win_user AS winUser, status, approved_at AS approvedAt,
            last_seen_at AS lastSeenAt, created_at AS createdAt
       FROM kd_connectors WHERE company_id = ? ORDER BY created_at DESC`, [companyId]);
  const [datasets] = await pool.query(
    `SELECT dataset, since_date AS sinceDate, last_ok_at AS lastOkAt, last_error AS lastError, last_rows AS rowCount
       FROM kd_dataset_state WHERE company_id = ? AND dataset NOT LIKE 'probe:%' ORDER BY dataset`, [companyId]);
  const [runs] = await pool.query(
    `SELECT id, connector_id AS connectorId, started_at AS startedAt, finished_at AS finishedAt, ok, summary
       FROM kd_sync_runs WHERE company_id = ? ORDER BY started_at DESC LIMIT 20`, [companyId]);
  return {
    connectors, datasets,
    runs: runs.map((r) => ({ ...r, ok: !!r.ok, summary: typeof r.summary === 'string' ? JSON.parse(r.summary) : r.summary })),
  };
}

// ── Overview ──────────────────────────────────────────────────────────────
export async function overview(companyId, q = {}) {
  const unit = q.unit || null;
  const d = await load(companyId, [
    'invoices', 'creditNotes', 'invoiceLines', 'creditNoteLines', 'orders', 'orderLines', 'purchaseOrders', 'purchaseOrderLines',
    'purchaseInvoices', 'purchaseInvoiceLines', 'deliveryLines', 'grpoLines', 'incomingPayments', 'vendorPayments', 'productionReceipts',
  ]);
  const ok = unitOk(unit);
  const today = todayIso();
  const fy = fyStart(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevMonthStart = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
  const prevMonthSameDay = addDays(prevMonthStart, Number(today.slice(8, 10)) - 1);
  const prevFy = `${Number(fy.slice(0, 4)) - 1}-04-01`;
  const prevFyToday = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;

  const docs = salesDocs(d, unit);
  const months = lastMonths(12, today);
  const salesByMonth = Object.fromEntries(months.map((m) => [m, 0]));
  const salesByDay = Object.fromEntries(daysRange(addDays(today, -29), today).map((x) => [x, 0]));
  const byCustomer = new Map();
  const byUnit = new Map();
  for (const { d: x, sign, unit: u } of docs) {
    const dd = day(x.DocDate); if (!dd) continue;
    const v = sign * net(x);
    if (monthKey(dd) in salesByMonth) salesByMonth[monthKey(dd)] += v;
    if (dd in salesByDay) salesByDay[dd] += v;
    if (dd >= fy) {
      const c = byCustomer.get(x.CardCode) || { cardCode: x.CardCode, cardName: x.CardName, sales: 0 };
      c.sales += v; byCustomer.set(x.CardCode, c);
      const uk = u || 'Not split'; byUnit.set(uk, (byUnit.get(uk) || 0) + v);
    }
  }
  const pays = (d.incomingPayments || []).filter((p) => payLive(p) && !interUnit(p) && ok(p.BPLName));
  const vpays = (d.vendorPayments || []).filter((p) => payLive(p) && !interUnit(p) && ok(p.BPLName));
  const collByMonth = Object.fromEntries(months.map((m) => [m, 0]));
  for (const p of pays) { const mk = monthKey(day(p.DocDate) || ''); if (mk in collByMonth) collByMonth[mk] += payTotal(p); }

  const iu = unitMap(d.invoiceLines);
  const pu = unitMap(d.purchaseInvoiceLines);
  const rec = ageing((d.invoices || []).filter((x) => !interUnit(x) && ok(iu.get(x.DocEntry))), today, iu);
  const pay = ageing((d.purchaseInvoices || []).filter((x) => !interUnit(x) && ok(pu.get(x.DocEntry))), today, pu);
  const so = openDocs((d.orders || []).filter((x) => !interUnit(x)), today, unitMap(d.orderLines), unit);
  const po = openDocs((d.purchaseOrders || []).filter((x) => !interUnit(x)), today, unitMap(d.purchaseOrderLines), unit);

  const todayLines = (list) => (list || []).filter((l) => trade(l) && ok(l.BPLName) && day(l.DocDate) === today);
  const ordersToday = todayLines(d.orderLines);
  const deliveriesToday = todayLines(d.deliveryLines);
  const grnToday = todayLines(d.grpoLines);
  const output = (d.productionReceipts || []).filter((l) => l.BaseType === 202 && ok(l.BPLName));
  const outputToday = output.filter((l) => day(l.DocDate) === today);
  const outputMonth = output.filter((l) => day(l.DocDate) >= monthStart);
  const docsCount = (list) => new Set(list.map((l) => l.DocEntry)).size;

  return {
    asOf: await lastSync(companyId), today, fyStart: fy, unit,
    salesToday: sumSales(docs, today, today),
    salesMonth: sumSales(docs, monthStart, today),
    salesPrevMonthSamePeriod: sumSales(docs, prevMonthStart, prevMonthSameDay),
    salesFy: sumSales(docs, fy, today),
    interUnitFy: round(
      sumBy((d.invoices || []).filter((x) => live(x) && interUnit(x) && day(x.DocDate) >= fy), net)
      - sumBy((d.creditNotes || []).filter((x) => live(x) && interUnit(x) && day(x.DocDate) >= fy), net)),
    salesPrevFySamePeriod: sumSales(docs, prevFy, prevFyToday),
    collectionsMonth: round(sumBy(pays.filter((p) => day(p.DocDate) >= monthStart), payTotal)),
    paymentsMonth: round(sumBy(vpays.filter((p) => day(p.DocDate) >= monthStart), payTotal)),
    receivables: rec.totals.total, receivablesOverdue: round(rec.totals.total - rec.totals.notDue),
    payables: pay.totals.total, payablesOverdue: round(pay.totals.total - pay.totals.notDue),
    openSalesOrders: { count: so.count, value: so.value, late: so.late },
    openPurchaseOrders: { count: po.count, value: po.value, late: po.late },
    productionMonthQty: round(sumBy(outputMonth, (l) => num(l.Quantity))),
    monthly: months.map((m) => ({ month: m, sales: round(salesByMonth[m]), collections: round(collByMonth[m]) })),
    daily: Object.entries(salesByDay).map(([date, v]) => ({ date, sales: round(v) })),
    byUnit: [...byUnit.entries()].map(([name, v]) => ({ unit: name, sales: round(v) })).sort(desc('sales')),
    topCustomers: [...byCustomer.values()].map((c) => ({ ...c, sales: round(c.sales) })).sort(desc('sales')).slice(0, 10),
    receivablesAgeing: rec.totals,
    todayActivity: {
      ordersCount: docsCount(ordersToday), ordersValue: round(sumBy(ordersToday, (l) => num(l.LineTotal))),
      deliveriesCount: docsCount(deliveriesToday), deliveriesQty: round(sumBy(deliveriesToday, (l) => num(l.Quantity))),
      grnCount: docsCount(grnToday), grnValue: round(sumBy(grnToday, (l) => num(l.LineTotal))),
      productionQty: round(sumBy(outputToday, (l) => num(l.Quantity))), productionDocs: docsCount(outputToday),
    },
    dueIn7Receivable: dueSoon(rec.open, today, 7),
    dueIn7Payable: dueSoon(pay.open, today, 7),
  };
}

// ── Sales ─────────────────────────────────────────────────────────────────
export async function sales(companyId, q = {}) {
  const unit = q.unit || null;
  const range = rangeOf(q);
  const d = await load(companyId, ['invoices', 'creditNotes', 'invoiceLines', 'creditNoteLines', ...MASTER_SETS]);
  const M = masters(d);
  const docs = salesDocs(d, unit).filter(({ d: x }) => inRange(x.DocDate, range));
  const lines = salesLines(d, unit).filter((l) => inRange(l.DocDate, range));
  const v = ({ d: x, sign }) => sign * net(x);
  const lv = (l) => l.sign * num(l.LineTotal);
  const lq = (l) => l.sign * num(l.Quantity);

  const byMonth = group(docs, ({ d: x }) => monthKey(day(x.DocDate)), { sales: v }).sort((a, b) => (a.key < b.key ? -1 : 1));
  const span = daysBetween(range.from, range.to);
  const dayList = span <= 92 ? daysRange(range.from, range.to) : [];
  const byDayMap = Object.fromEntries(dayList.map((x) => [x, 0]));
  for (const x of docs) { const k = day(x.d.DocDate); if (k in byDayMap) byDayMap[k] += v(x); }

  const customers = group(docs, ({ d: x }) => x.CardCode, { sales: v }, ({ d: x }) => ({ cardName: x.CardName })).sort(desc('sales'));
  const persons = group(docs, ({ d: x }) => x.SalesPersonCode ?? -1, { sales: v })
    .map((p) => ({ ...p, name: M.people[p.key] || (p.key === -1 ? 'No sales employee' : `#${p.key}`) })).sort(desc('sales'));
  const items = group(lines, (l) => l.ItemCode, { sales: lv, qty: lq }, (l) => ({ itemName: l.ItemDescription, uom: M.uomOf(l), group: M.itemGroup(l.ItemCode) })).sort(desc('sales'));
  const itemGroups = group(lines, (l) => M.itemGroup(l.ItemCode), { sales: lv, qty: lq }).sort(desc('sales'));
  const byUnit = group(lines, (l) => l.BPLName || 'Not split', { sales: lv, qty: lq }).sort(desc('sales'));
  const documents = docs.map(({ d: x, sign, unit: u }) => ({
    kind: sign > 0 ? 'Invoice' : 'Credit note', docEntry: x.DocEntry, docNum: x.DocNum, docDate: day(x.DocDate), unit: u,
    cardCode: x.CardCode, cardName: x.CardName, net: round(sign * net(x)), tax: round(sign * num(x.VatSum)), total: round(sign * num(x.DocTotal)),
  })).sort((a, b) => (a.docDate < b.docDate ? 1 : a.docDate > b.docDate ? -1 : b.docNum - a.docNum));
  const total = round(sumBy(docs, v));
  const iuSales = sumBy((d.invoices || []).filter((x) => live(x) && interUnit(x) && inRange(x.DocDate, range)), net)
    - sumBy((d.creditNotes || []).filter((x) => live(x) && interUnit(x) && inRange(x.DocDate, range)), net);
  return {
    asOf: await lastSync(companyId), ...range, unit, total, interUnit: round(iuSales),
    tax: round(sumBy(docs, ({ d: x, sign }) => sign * num(x.VatSum))),
    qty: round(sumBy(lines, lq)),
    documentCount: documents.length, customerCount: customers.length,
    monthly: byMonth.map((m) => ({ month: m.key, sales: m.sales })),
    daily: Object.entries(byDayMap).map(([date, s]) => ({ date, sales: round(s) })),
    customers: customers.map((c) => ({ cardCode: c.key, cardName: c.cardName, sales: c.sales, docs: c.count })),
    salesPersons: persons.map((p) => ({ code: p.key, name: p.name, sales: p.sales, docs: p.count })),
    items: items.slice(0, 1000).map((i) => ({ itemCode: i.key, itemName: i.itemName, group: i.group, uom: i.uom, qty: i.qty, sales: i.sales, lines: i.count })),
    itemGroups: itemGroups.map((g) => ({ group: g.key, sales: g.sales, qty: g.qty })),
    byUnit: byUnit.map((g) => ({ unit: g.key, sales: g.sales, qty: g.qty })),
    documents: documents.slice(0, 1000),
  };
}

/** One customer in a range: items bought, month by month, and their documents. */
export async function salesCustomer(companyId, cardCode, q = {}) {
  const unit = q.unit || null;
  const range = rangeOf(q);
  const d = await load(companyId, ['invoiceLines', 'creditNoteLines', ...MASTER_SETS]);
  const M = masters(d);
  const lines = salesLines(d, unit).filter((l) => l.CardCode === cardCode && inRange(l.DocDate, range));
  const lv = (l) => l.sign * num(l.LineTotal);
  const bp = M.partners.get(cardCode);
  return {
    ...range, cardCode, cardName: bp?.CardName || lines[0]?.CardName || cardCode,
    city: bp?.City || null, balance: num(bp?.CurrentAccountBalance), creditLimit: num(bp?.CreditLimit),
    total: round(sumBy(lines, lv)),
    items: group(lines, (l) => l.ItemCode, { sales: lv, qty: (l) => l.sign * num(l.Quantity) }, (l) => ({ itemName: l.ItemDescription, uom: M.uomOf(l) }))
      .sort(desc('sales')).map((i) => ({ itemCode: i.key, itemName: i.itemName, uom: i.uom, qty: i.qty, sales: i.sales })),
    monthly: group(lines, (l) => monthKey(day(l.DocDate)), { sales: lv }).sort((a, b) => (a.key < b.key ? -1 : 1)).map((m) => ({ month: m.key, sales: m.sales })),
  };
}

// ── Sales orders: open orders and pending lines against stock ────────────
export async function salesOrders(companyId, q = {}) {
  const unit = q.unit || null;
  const today = todayIso();
  const d = await load(companyId, ['orders', 'orderLines', 'stock', ...MASTER_SETS]);
  const M = masters(d);
  const ok = unitOk(unit);
  const head = openDocs((d.orders || []).filter((x) => !interUnit(x)), today, unitMap(d.orderLines), unit, M.people);

  // Stock in hand per item (the unit's warehouses when a unit is chosen)
  const stockOf = new Map();
  for (const s of d.stock || []) {
    if (unit && M.whs.get(s.WarehouseCode)?.unit !== unit) continue;
    stockOf.set(s.ItemCode, (stockOf.get(s.ItemCode) || 0) + num(s.InStock));
  }
  const pending = (d.orderLines || []).filter((l) => trade(l) && ok(l.BPLName) && lineOpen(l) && num(l.RemainingOpenQuantity) > 0)
    .map((l) => {
      const price = num(l.Quantity) ? num(l.LineTotal) / num(l.Quantity) : 0;
      return {
        docEntry: l.DocEntry, docNum: l.DocNum, docDate: day(l.DocDate), lineNum: l.LineNum, unit: l.BPLName || null,
        cardCode: l.CardCode, cardName: l.CardName, itemCode: l.ItemCode, itemName: l.ItemDescription, uom: M.uomOf(l),
        ordered: num(l.Quantity), open: num(l.RemainingOpenQuantity), value: round(num(l.RemainingOpenQuantity) * price),
        shipDate: day(l.ShipDate), late: day(l.ShipDate) ? day(l.ShipDate) < today : false,
      };
    });
  const byItem = group(pending, (p) => p.itemCode, { open: (p) => p.open, value: (p) => p.value, late: (p) => (p.late ? 1 : 0) },
    (p) => ({ itemName: p.itemName, uom: p.uom })).map((g) => {
    const stock = round(stockOf.get(g.key) || 0);
    return { itemCode: g.key, itemName: g.itemName, uom: g.uom, open: g.open, value: g.value, lines: g.count, late: g.late, stock, short: round(Math.max(0, g.open - stock)) };
  }).sort(desc('value'));
  const byCustomer = group(pending, (p) => p.cardCode, { open: (p) => p.open, value: (p) => p.value, late: (p) => (p.late ? 1 : 0) },
    (p) => ({ cardName: p.cardName })).map((g) => ({ cardCode: g.key, cardName: g.cardName, lines: g.count, open: g.open, value: g.value, late: g.late }))
    .sort(desc('value'));
  return {
    asOf: await lastSync(companyId), unit, ...head,
    pendingValue: round(sumBy(pending, (p) => p.value)), pendingLines: pending.length, lateLines: pending.filter((p) => p.late).length,
    itemsShort: byItem.filter((i) => i.short > 0).length,
    byItem, byCustomer, pending: pending.sort((a, b) => Number(b.late) - Number(a.late) || (a.shipDate < b.shipDate ? -1 : 1)).slice(0, 2000),
  };
}

// ── Dispatch (deliveries) ────────────────────────────────────────────────
export async function dispatch(companyId, q = {}) {
  const unit = q.unit || null;
  const range = rangeOf(q, addDays(todayIso(), -29));
  const d = await load(companyId, ['deliveryLines', ...MASTER_SETS]);
  const M = masters(d);
  const ok = unitOk(unit);
  const lines = (d.deliveryLines || []).filter((l) => trade(l) && ok(l.BPLName) && inRange(l.DocDate, range));
  const qty = (l) => num(l.Quantity);
  const val = (l) => num(l.LineTotal);
  const byDayMap = Object.fromEntries(daysRange(range.from, range.to).map((x) => [x, { qty: 0, value: 0 }]));
  for (const l of lines) { const k = day(l.DocDate); if (byDayMap[k]) { byDayMap[k].qty += qty(l); byDayMap[k].value += val(l); } }
  const docs = group(lines, (l) => l.DocEntry, { qty, value: val }, (l) => ({ docNum: l.DocNum, docDate: day(l.DocDate), cardName: l.CardName, unit: l.BPLName || null }))
    .sort((a, b) => (a.docDate < b.docDate ? 1 : -1));
  return {
    asOf: await lastSync(companyId), unit, ...range,
    qty: round(sumBy(lines, qty)), value: round(sumBy(lines, val)), deliveries: docs.length,
    customers: new Set(lines.map((l) => l.CardCode)).size,
    daily: Object.entries(byDayMap).map(([date, x]) => ({ date, qty: round(x.qty), value: round(x.value) })),
    byCustomer: group(lines, (l) => l.CardCode, { qty, value: val }, (l) => ({ cardName: l.CardName })).sort(desc('value'))
      .map((g) => ({ cardCode: g.key, cardName: g.cardName, qty: g.qty, value: g.value, lines: g.count })),
    byItem: group(lines, (l) => l.ItemCode, { qty, value: val }, (l) => ({ itemName: l.ItemDescription, uom: M.uomOf(l), group: M.itemGroup(l.ItemCode) })).sort(desc('qty'))
      .map((g) => ({ itemCode: g.key, itemName: g.itemName, group: g.group, uom: g.uom, qty: g.qty, value: g.value })).slice(0, 1000),
    byGroup: group(lines, (l) => M.itemGroup(l.ItemCode), { qty, value: val }).sort(desc('qty')).map((g) => ({ group: g.key, qty: g.qty, value: g.value })),
    documents: docs.slice(0, 1000).map((g) => ({ docEntry: g.key, docNum: g.docNum, docDate: g.docDate, cardName: g.cardName, unit: g.unit, qty: g.qty, value: g.value })),
  };
}

// ── Receivables / payables with collections and payments ─────────────────
async function partyBook(companyId, q, kind) {
  const unit = q.unit || null;
  const today = todayIso();
  const sales = kind === 'receivables';
  const docSet = sales ? 'invoices' : 'purchaseInvoices';
  const lineSet = sales ? 'invoiceLines' : 'purchaseInvoiceLines';
  const paySet = sales ? 'incomingPayments' : 'vendorPayments';
  const d = await load(companyId, [docSet, lineSet, paySet, 'businessPartners']);
  const units = unitMap(d[lineSet]);
  const ok = unitOk(unit);
  const bp = new Map((d.businessPartners || []).map((b) => [b.CardCode, b]));
  const a = ageing((d[docSet] || []).filter((x) => !interUnit(x) && ok(units.get(x.DocEntry))), today, units);
  if (sales) a.parties = a.parties.map((p) => ({ ...p, creditLimit: num(bp.get(p.cardCode)?.CreditLimit), accountBalance: num(bp.get(p.cardCode)?.CurrentAccountBalance) }));

  const pays = (d[paySet] || []).filter((p) => payLive(p) && !interUnit(p) && ok(p.BPLName));
  const months = lastMonths(12, today);
  const byMonth = Object.fromEntries(months.map((m) => [m, 0]));
  for (const p of pays) { const mk = monthKey(day(p.DocDate) || ''); if (mk in byMonth) byMonth[mk] += payTotal(p); }
  const fy = fyStart(today);
  const fyPays = pays.filter((p) => day(p.DocDate) >= fy);
  return {
    asOf: await lastSync(companyId), unit, ...a, open: a.open.slice(0, 2000),
    dueIn7: dueSoon(a.open, today, 7),
    payments: {
      monthly: months.map((m) => ({ month: m, amount: round(byMonth[m]) })),
      fy: round(sumBy(fyPays, payTotal)),
      month: round(sumBy(pays.filter((p) => day(p.DocDate) >= `${today.slice(0, 7)}-01`), payTotal)),
      byParty: group(fyPays, (p) => p.CardCode, { amount: payTotal }, (p) => ({ cardName: p.CardName })).sort(desc('amount')).slice(0, 200)
        .map((g) => ({ cardCode: g.key, cardName: g.cardName, amount: g.amount, count: g.count })),
      recent: pays.sort((x, y) => (day(x.DocDate) < day(y.DocDate) ? 1 : -1)).slice(0, 300)
        .map((p) => ({ docEntry: p.DocEntry, docNum: p.DocNum, docDate: day(p.DocDate), cardName: p.CardName, unit: p.BPLName || null, amount: round(payTotal(p)) })),
    },
  };
}
export const receivables = (cid, q) => partyBook(cid, q, 'receivables');
export const payables = (cid, q) => partyBook(cid, q, 'payables');

// ── Purchase: register, PO vs GRN, open POs ──────────────────────────────
export async function purchase(companyId, q = {}) {
  const unit = q.unit || null;
  const range = rangeOf(q);
  const today = todayIso();
  const d = await load(companyId, ['purchaseInvoiceLines', 'purchaseOrders', 'purchaseOrderLines', 'grpoLines', ...MASTER_SETS]);
  const M = masters(d);
  const ok = unitOk(unit);
  const inv = (d.purchaseInvoiceLines || []).filter((l) => trade(l) && ok(l.BPLName) && inRange(l.DocDate, range));
  const val = (l) => num(l.LineTotal);
  const qty = (l) => num(l.Quantity);

  const poLines = (d.purchaseOrderLines || []).filter((l) => trade(l) && ok(l.BPLName) && inRange(l.DocDate, range)).map((l) => {
    const ordered = num(l.Quantity);
    const pendingQ = lineOpen(l) ? num(l.RemainingOpenQuantity) : 0;
    const received = Math.max(0, ordered - num(l.RemainingOpenQuantity));
    return {
      docEntry: l.DocEntry, docNum: l.DocNum, docDate: day(l.DocDate), lineNum: l.LineNum, unit: l.BPLName || null,
      cardCode: l.CardCode, cardName: l.CardName, itemCode: l.ItemCode, itemName: l.ItemDescription, uom: M.uomOf(l),
      ordered, received: round(received), pending: round(pendingQ), value: round(val(l)),
      open: lineOpen(l), shipDate: day(l.ShipDate), late: lineOpen(l) && day(l.ShipDate) && day(l.ShipDate) < today,
    };
  });
  const vendorFill = group(poLines, (l) => l.cardCode, { ordered: (l) => l.ordered, received: (l) => l.received, pending: (l) => l.pending, late: (l) => (l.late ? 1 : 0) },
    (l) => ({ cardName: l.cardName })).map((g) => ({ cardCode: g.key, cardName: g.cardName, lines: g.count, ordered: g.ordered, received: g.received, pending: g.pending, late: g.late,
    fill: g.ordered ? Math.round((g.received / g.ordered) * 1000) / 10 : null })).sort(desc('ordered'));

  const grn30 = (d.grpoLines || []).filter((l) => trade(l) && ok(l.BPLName) && day(l.DocDate) >= addDays(today, -29));
  const grnDays = Object.fromEntries(daysRange(addDays(today, -29), today).map((x) => [x, 0]));
  for (const l of grn30) { const k = day(l.DocDate); if (k in grnDays) grnDays[k] += val(l); }

  return {
    asOf: await lastSync(companyId), unit, ...range,
    spend: round(sumBy(inv, val)), invoices: new Set(inv.map((l) => l.DocEntry)).size, vendors: new Set(inv.map((l) => l.CardCode)).size,
    monthly: group(inv, (l) => monthKey(day(l.DocDate)), { spend: val }).sort((a, b) => (a.key < b.key ? -1 : 1)).map((m) => ({ month: m.key, spend: m.spend })),
    byVendor: group(inv, (l) => l.CardCode, { spend: val, qty }, (l) => ({ cardName: l.CardName })).sort(desc('spend'))
      .map((g) => ({ cardCode: g.key, cardName: g.cardName, spend: g.spend, qty: g.qty, lines: g.count })),
    byItem: group(inv, (l) => l.ItemCode, { spend: val, qty }, (l) => ({ itemName: l.ItemDescription, uom: M.uomOf(l), group: M.itemGroup(l.ItemCode) })).sort(desc('spend'))
      .slice(0, 1000).map((g) => ({ itemCode: g.key, itemName: g.itemName, group: g.group, uom: g.uom, spend: g.spend, qty: g.qty, avgPrice: g.qty ? round(g.spend / g.qty) : null })),
    byGroup: group(inv, (l) => M.itemGroup(l.ItemCode), { spend: val, qty }).sort(desc('spend')).map((g) => ({ group: g.key, spend: g.spend, qty: g.qty })),
    poVsGrn: {
      ordered: round(sumBy(poLines, (l) => l.ordered)), received: round(sumBy(poLines, (l) => l.received)), pending: round(sumBy(poLines, (l) => l.pending)),
      lateLines: poLines.filter((l) => l.late).length, vendors: vendorFill,
      lines: poLines.filter((l) => l.open).sort((a, b) => Number(b.late) - Number(a.late) || (a.shipDate < b.shipDate ? -1 : 1)).slice(0, 2000),
    },
    grnDaily: Object.entries(grnDays).map(([date, value]) => ({ date, value: round(value) })),
    grnByGroup: group(grn30, (l) => M.itemGroup(l.ItemCode), { value: val, qty }).sort(desc('value')).map((g) => ({ group: g.key, value: g.value, qty: g.qty })),
  };
}

export async function purchaseOrders(companyId, q = {}) {
  const d = await load(companyId, ['purchaseOrders', 'purchaseOrderLines']);
  return { asOf: await lastSync(companyId), ...openDocs((d.purchaseOrders || []).filter((x) => !interUnit(x)), todayIso(), unitMap(d.purchaseOrderLines), q.unit || null) };
}

// ── Production ───────────────────────────────────────────────────────────
const PO_STATUS = { boposPlanned: 'Planned', boposReleased: 'Released', boposClosed: 'Closed', boposCancelled: 'Cancelled' };

export async function production(companyId, q = {}) {
  const unit = q.unit || null;
  const today = todayIso();
  const range = rangeOf(q, addDays(today, -29));
  const d = await load(companyId, ['productionOrders', 'productionReceipts', 'productionIssues', ...MASTER_SETS]);
  const M = masters(d);
  const ok = unitOk(unit);

  // Unit of an order: its receipts / issues carry the business place
  const orderUnit = new Map();
  for (const l of [...(d.productionReceipts || []), ...(d.productionIssues || [])]) {
    if (l.BaseType === 202 && l.BPLName && !orderUnit.has(l.BaseEntry)) orderUnit.set(l.BaseEntry, l.BPLName);
  }
  // Section of an order without U_SECTION: the routing stage most of its material was issued at.
  const stageVotes = new Map();
  for (const l of d.productionIssues || []) {
    if (l.BaseType !== 202 || !l.StgDesc) continue;
    const v = stageVotes.get(l.BaseEntry) || {}; v[l.StgDesc] = (v[l.StgDesc] || 0) + 1; stageVotes.set(l.BaseEntry, v);
  }
  const stageOf = (id) => { const v = stageVotes.get(id); return v ? Object.entries(v).sort((a, b) => b[1] - a[1])[0][0] : null; };
  const orders = (d.productionOrders || []).map((o) => ({
    id: o.AbsoluteEntry, docNum: o.DocumentNumber, itemCode: o.ItemNo, itemName: o.ProductDescription, uom: o.InventoryUOM,
    status: PO_STATUS[o.ProductionOrderStatus] || o.ProductionOrderStatus, planned: num(o.PlannedQuantity), completed: num(o.CompletedQuantity),
    rejected: num(o.RejectedQuantity), postingDate: day(o.PostingDate), dueDate: day(o.DueDate), closingDate: day(o.ClosingDate),
    machine: o.U_MACHINE || 'Not set', section: o.U_SECTION || stageOf(o.AbsoluteEntry) || 'Not set', shift: o.U_UNE_Shift || null,
    unit: orderUnit.get(o.AbsoluteEntry) || o.U_Unit || null, salesOrder: o.ProductionOrderOriginNumber || null,
    customer: M.partners.get(o.CustomerCode)?.CardName || o.CustomerCode || null,
  })).filter((o) => o.status !== 'Cancelled' && ok(o.unit));
  // Orders are re-read for 120 days after posting; older open ones may have been closed in SAP since.
  const recentFrom = addDays(today, -120);
  const isOpenStatus = (o) => o.status === 'Planned' || o.status === 'Released';
  const olderOpen = orders.filter((o) => isOpenStatus(o) && o.postingDate < recentFrom).length;
  const open = orders.filter((o) => isOpenStatus(o) && o.postingDate >= recentFrom).map((o) => ({
    ...o, progress: o.planned ? Math.round((o.completed / o.planned) * 1000) / 10 : 0, late: !!o.dueDate && o.dueDate < today,
  }));
  const machineSection = new Map();
  for (const o of orders) if (o.machine !== 'Not set' && !machineSection.has(o.machine)) machineSection.set(o.machine, o.section);

  const receipts = (d.productionReceipts || []).filter((l) => l.BaseType === 202 && ok(l.BPLName));
  // Resources (machine / labour time posted as items) are not material.
  const isResource = (code) => /resource/i.test(M.itemGroup(code));
  const issues = (d.productionIssues || []).filter((l) => l.BaseType === 202 && ok(l.BPLName) && !isResource(l.ItemCode));
  // Yield compares kg with kg: orders whose product is counted in pieces are left out of it.
  const kg = new Set(orders.filter((o) => /^kgs?$/i.test(o.uom || '')).map((o) => o.id));
  const kgItem = (code) => /^kgs?$/i.test(M.items.get(code)?.InventoryUOM || '');
  const kgLine = (l) => kg.has(l.BaseEntry) && kgItem(l.ItemCode);
  const rIn = receipts.filter((l) => inRange(l.DocDate, range));
  const iIn = issues.filter((l) => inRange(l.DocDate, range));
  const qty = (l) => num(l.Quantity);
  const val = (l) => num(l.LineTotal);
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const machineOf = (l) => l.U_EVT_MACHINE || orderById.get(l.BaseEntry)?.machine || 'Not set';
  const sectionOf = (l) => {
    const o = orderById.get(l.BaseEntry);
    if (o && o.section !== 'Not set') return o.section;
    return machineSection.get(machineOf(l)) || 'Not set';
  };

  // Output by day, split by section (stacked chart)
  const sections = [...new Set(rIn.map(sectionOf))].sort();
  const dayMap = Object.fromEntries(daysRange(range.from, range.to).map((x) => [x, Object.fromEntries(sections.map((s) => [s, 0]))]));
  for (const l of rIn) { const k = day(l.DocDate); if (dayMap[k]) dayMap[k][sectionOf(l)] += qty(l); }

  // Yield per order: output ÷ material issued (same unit of measure in this plant: KG)
  const issuedBy = new Map();
  for (const l of issues) if (kgLine(l)) issuedBy.set(l.BaseEntry, (issuedBy.get(l.BaseEntry) || 0) + qty(l));
  const outBy = new Map();
  for (const l of receipts) if (kgLine(l)) outBy.set(l.BaseEntry, (outBy.get(l.BaseEntry) || 0) + qty(l));
  // Yield on finished work only: a closed kg order, closed in this period, with material and output.
  const yieldRows = orders.filter((o) => kg.has(o.id) && o.status === 'Closed' && inRange(o.closingDate || o.postingDate, range) && issuedBy.get(o.id) > 0 && outBy.get(o.id) > 0)
    .map((o) => {
      const input = issuedBy.get(o.id); const output = outBy.get(o.id);
      return { id: o.id, docNum: o.docNum, itemName: o.itemName, machine: o.machine, section: o.section, status: o.status, input: round(input), output: round(output),
        loss: round(input - output), yield: Math.round((output / input) * 1000) / 10 };
    });

  const byMachine = group(open, (o) => o.machine, { planned: (o) => o.planned, completed: (o) => o.completed, late: (o) => (o.late ? 1 : 0) }, (o) => ({ section: o.section }));
  const outByMachine = group(rIn, machineOf, { output: qty, value: val });
  const yieldByMachine = group(yieldRows, (r) => r.machine, { input: (r) => r.input, output: (r) => r.output });
  const machineRows = [...new Set([...byMachine.map((m) => m.key), ...outByMachine.map((m) => m.key)])].map((name) => {
    const a = byMachine.find((m) => m.key === name) || {}; const b = outByMachine.find((m) => m.key === name) || {}; const y = yieldByMachine.find((m) => m.key === name);
    return {
      machine: name, section: a.section || machineSection.get(name) || 'Other', openOrders: a.count || 0, planned: a.planned || 0, completed: a.completed || 0, late: a.late || 0,
      output: b.output || 0, outputValue: b.value || 0, yield: y && y.input ? Math.round((y.output / y.input) * 1000) / 10 : null,
    };
  }).sort(desc('output'));

  return {
    asOf: await lastSync(companyId), unit, ...range,
    kpis: {
      openOrders: open.length, released: open.filter((o) => o.status === 'Released').length, planned: open.filter((o) => o.status === 'Planned').length,
      lateOrders: open.filter((o) => o.late).length,
      output: round(sumBy(rIn, qty)), outputValue: round(sumBy(rIn, val)), issued: round(sumBy(iIn, qty)),
      outputToday: round(sumBy(receipts.filter((l) => day(l.DocDate) === today), qty)),
      yield: (() => { const i = sumBy(yieldRows, (r) => r.input); return i ? Math.round((sumBy(yieldRows, (r) => r.output) / i) * 1000) / 10 : null; })(),
      olderOpen,
      closedInRange: orders.filter((o) => o.status === 'Closed' && inRange(o.closingDate, range)).length,
    },
    statusCounts: group(orders.filter((o) => inRange(o.postingDate, range) || o.status === 'Released' || o.status === 'Planned'), (o) => o.status, {}).map((g) => ({ status: g.key, count: g.count })),
    sections,
    daily: Object.entries(dayMap).map(([date, s]) => ({ date, ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, round(v)])) })),
    bySection: group(open, (o) => o.section, { planned: (o) => o.planned, completed: (o) => o.completed, late: (o) => (o.late ? 1 : 0) })
      .map((g) => ({ section: g.key, openOrders: g.count, planned: g.planned, completed: g.completed, late: g.late, progress: g.planned ? Math.round((g.completed / g.planned) * 1000) / 10 : 0 }))
      .sort(desc('openOrders')),
    machines: machineRows,
    shifts: group(rIn, (l) => l.U_EVT_SHIFT || 'Not set', { output: qty }).map((g) => ({ shift: g.key, output: g.output, receipts: g.count })).sort(desc('output')),
    operators: group(rIn, (l) => l.U_EVT_OPER || 'Not set', { output: qty }, (l) => ({ machine: machineOf(l) })).sort(desc('output')).slice(0, 30)
      .map((g) => ({ operator: g.key, machine: g.machine, output: g.output, receipts: g.count })),
    consumptionByGroup: group(iIn, (l) => M.itemGroup(l.ItemCode), { qty, value: val }).sort(desc('qty')).map((g) => ({ group: g.key, qty: g.qty, value: g.value })),
    consumptionByStage: group(iIn, (l) => l.StgDesc || 'Not set', { qty, value: val }).sort(desc('qty')).map((g) => ({ stage: g.key, qty: g.qty, value: g.value })),
    yieldOrders: yieldRows.sort((a, b) => a.yield - b.yield).slice(0, 500),
    openOrders: open.sort((a, b) => Number(b.late) - Number(a.late) || (a.dueDate < b.dueDate ? -1 : 1)).slice(0, 2000),
  };
}

// ── Inventory ────────────────────────────────────────────────────────────
export async function inventory(companyId, q = {}) {
  const unit = q.unit || null;
  const today = todayIso();
  const d = await load(companyId, ['stock', 'transferRequests', 'productionIssues', ...MASTER_SETS]);
  const M = masters(d);
  const stock = (d.stock || []).filter((s) => !unit || M.whs.get(s.WarehouseCode)?.unit === unit).map((s) => {
    const it = M.items.get(s.ItemCode);
    return {
      itemCode: s.ItemCode, itemName: it?.ItemName || s.ItemCode, group: M.itemGroup(s.ItemCode), uom: it?.InventoryUOM || '',
      warehouse: s.WarehouseCode, warehouseName: M.whs.get(s.WarehouseCode)?.name || s.WarehouseCode, unit: M.whs.get(s.WarehouseCode)?.unit || null,
      onHand: num(s.InStock), committed: num(s.Committed), onOrder: num(s.Ordered), value: round(num(s.InStock) * num(s.StandardAveragePrice)),
    };
  });
  const items = group(stock, (s) => s.itemCode, { onHand: (s) => s.onHand, committed: (s) => s.committed, onOrder: (s) => s.onOrder, value: (s) => s.value },
    (s) => ({ itemName: s.itemName, group: s.group, uom: s.uom })).map((g) => ({
    itemCode: g.key, itemName: g.itemName, group: g.group, uom: g.uom, onHand: g.onHand, committed: g.committed, onOrder: g.onOrder, value: g.value,
    warehouses: g.count, available: round(g.onHand - g.committed + g.onOrder), short: g.committed > g.onHand + g.onOrder,
  })).sort(desc('value'));
  const consumption = (d.productionIssues || []).filter((l) => l.BaseType === 202 && !/resource/i.test(M.itemGroup(l.ItemCode)) && (!unit || l.BPLName === unit) && day(l.DocDate) >= addDays(today, -29));
  return {
    asOf: await lastSync(companyId), unit,
    value: round(sumBy(stock, (s) => s.value)), qty: round(sumBy(stock, (s) => s.onHand)),
    itemCount: items.filter((i) => i.onHand > 0).length, shortCount: items.filter((i) => i.short).length,
    byWarehouse: group(stock, (s) => s.warehouse, { onHand: (s) => s.onHand, value: (s) => s.value }, (s) => ({ name: s.warehouseName, unit: s.unit }))
      .map((g) => ({ warehouse: g.key, name: g.name, unit: g.unit, items: g.count, onHand: g.onHand, value: g.value })).sort(desc('value')),
    byGroup: group(stock, (s) => s.group, { onHand: (s) => s.onHand, value: (s) => s.value }).map((g) => ({ group: g.key, lines: g.count, onHand: g.onHand, value: g.value })).sort(desc('value')),
    byUnit: group(stock, (s) => s.unit || 'Not split', { value: (s) => s.value, onHand: (s) => s.onHand }).map((g) => ({ unit: g.key, value: g.value, onHand: g.onHand })),
    items: items.slice(0, 3000),
    consumption: group(consumption, (l) => M.itemGroup(l.ItemCode), { qty: (l) => num(l.Quantity), value: (l) => num(l.LineTotal) }).sort(desc('qty'))
      .map((g) => ({ group: g.key, qty: g.qty, value: g.value })),
    transfers: (d.transferRequests || []).filter((t) => t.DocumentStatus === 'bost_Open' && (!unit || t.BPLName === unit))
      .map((t) => ({ docEntry: t.DocEntry, docNum: t.DocNum, docDate: day(t.DocDate), dueDate: day(t.DueDate), from: t.FromWarehouse, to: t.ToWarehouse, unit: t.BPLName || null,
        late: day(t.DueDate) ? day(t.DueDate) < today : false }))
      .sort((a, b) => (a.docDate < b.docDate ? 1 : -1)),
  };
}

/** Stock of one item, warehouse by warehouse. */
export async function inventoryItem(companyId, itemCode) {
  const d = await load(companyId, ['stock', ...MASTER_SETS]);
  const M = masters(d);
  const it = M.items.get(itemCode);
  return {
    itemCode, itemName: it?.ItemName || itemCode, group: M.itemGroup(itemCode), uom: it?.InventoryUOM || '',
    warehouses: (d.stock || []).filter((s) => s.ItemCode === itemCode).map((s) => ({
      warehouse: s.WarehouseCode, name: M.whs.get(s.WarehouseCode)?.name || s.WarehouseCode, unit: M.whs.get(s.WarehouseCode)?.unit || null,
      onHand: num(s.InStock), committed: num(s.Committed), onOrder: num(s.Ordered), value: round(num(s.InStock) * num(s.StandardAveragePrice)),
    })).sort(desc('onHand')),
  };
}

// ── SAP saved queries, each pointed at the screen that answers it ─────────
const COVERS = [
  [/downtime|breakdown|machine|production|wip|routing|issue vs|plan vs|planned vs|wastage|curing|slit|lam_|print_|packing|ibc|dpr|job card|unit 2 production|\b2205\b|dashboard/i, 'production'],
  [/consumption|stock|inventory|godown|batch|ageing|aeging|granule|solvent|adhesive|ink|transfer|qc onhold/i, 'inventory'],
  [/vendor|outgoing|a\/p|tds/i, 'payables'],
  [/purchase|\bpo\b|grpo|grn|order vs/i, 'purchase'],
  [/deliver|dispatch|logistics/i, 'dispatch'],
  [/pending so|open so|sales order|\bso\b/i, 'sales-orders'],
  [/customer payment|receiv|aeging summary|incoming|cash/i, 'receivables'],
  [/sales|hsn|gstr|e-billing|invoice|price|customer/i, 'sales'],
];
export async function savedReports(companyId) {
  const d = await load(companyId, ['userQueries', 'queryCategories']);
  const cats = Object.fromEntries((d.queryCategories || []).map((c) => [c.Code, c.Name]));
  const list = (d.userQueries || []).map((q) => {
    const category = cats[q.QueryCategory] || (q.QueryCategory === -1 ? 'General' : `Category ${q.QueryCategory}`);
    const standard = /^SAP_DASHBOARD|^KPI_MOBILE/.test(category);
    const text = `${q.QueryDescription} ${category}`;
    const cover = standard ? null : (COVERS.find(([re]) => re.test(text)) || [])[1] || null;
    return { id: `${q.QueryCategory}:${q.InternalKey}`, internalKey: q.InternalKey, categoryCode: q.QueryCategory, category, name: q.QueryDescription, sql: q.Query || '', standard, coveredBy: cover };
  }).sort((a, b) => Number(a.standard) - Number(b.standard) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return { asOf: await lastSync(companyId), count: list.length, karni: list.filter((r) => !r.standard).length, reports: list };
}

/** Shared with the insight engine (services/insightService.js). */
export const shared = {
  load, masters, unitMap, lastSync, MASTER_SETS,
  num, day, live, lineOpen, interUnit, trade, round, todayIso, addDays, monthKey, fyStart, lastMonths, payTotal, payLive,
};
