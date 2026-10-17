import { pool } from '../../../db.js';

/**
 * The dashboard's figures, worked out from the SAP rows the connector pushed
 * (kd_rows). Every report reads the rows once into memory per company and
 * keeps them until the next push (invalidate), so screens are quick and SAP is
 * never asked anything by a screen.
 *
 * SAP conventions used here:
 *   - a document is OPEN when DocumentStatus = 'bost_Open'
 *   - a cancelled document AND its cancellation both carry Cancelled = 'tYES';
 *     both are left out, which nets them to zero
 *   - sales are net of tax: DocTotal − VatSum; credit notes subtract
 *   - the financial year runs April to March
 */
const cache = new Map(); // companyId -> { at, data: { dataset: rows[] } }
const TTL_MS = 15 * 60 * 1000;

export function invalidate(companyId) {
  cache.delete(companyId);
}

async function load(companyId) {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const [rows] = await pool.query('SELECT dataset, data FROM kd_rows WHERE company_id = ?', [companyId]);
  const data = {};
  for (const r of rows) {
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    (data[r.dataset] ||= []).push(d);
  }
  cache.set(companyId, { at: Date.now(), data });
  return data;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const day = (v) => (v ? String(v).slice(0, 10) : null);
const live = (d) => d.Cancelled !== 'tYES';
const isOpen = (d) => d.DocumentStatus === 'bost_Open' && live(d);
const net = (d) => num(d.DocTotal) - num(d.VatSum);
const balance = (d) => num(d.DocTotal) - num(d.PaidToDate);
const todayIso = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
const round = (v) => Math.round(v * 100) / 100;

function fyStart(iso = todayIso()) {
  const [y, m] = iso.split('-').map(Number);
  return `${m >= 4 ? y : y - 1}-04-01`;
}
const monthKey = (iso) => iso.slice(0, 7);
function lastMonths(n, iso = todayIso()) {
  const [y, m] = iso.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** Signed sales lines: invoices +, credit notes −, cancelled pairs left out. */
function salesDocs(data) {
  return [
    ...(data.invoices || []).filter(live).map((d) => ({ d, sign: 1 })),
    ...(data.creditNotes || []).filter(live).map((d) => ({ d, sign: -1 })),
  ];
}

function sumSales(docs, from, to) {
  let t = 0;
  for (const { d, sign } of docs) {
    const dd = day(d.DocDate);
    if (dd && dd >= from && dd <= to) t += sign * net(d);
  }
  return round(t);
}

function bucketOf(daysOver) {
  if (daysOver <= 0) return 'notDue';
  if (daysOver <= 30) return 'd0_30';
  if (daysOver <= 60) return 'd31_60';
  if (daysOver <= 90) return 'd61_90';
  return 'd90plus';
}

/** Ageing of open documents by party: amounts by days past the due date. */
function ageing(docs, today) {
  const parties = new Map();
  const open = [];
  for (const d of docs) {
    if (!isOpen(d)) continue;
    const bal = balance(d);
    if (Math.abs(bal) < 0.005) continue;
    const due = day(d.DocDueDate) || day(d.DocDate);
    const over = due ? daysBetween(due, today) : 0;
    const b = bucketOf(over);
    const p = parties.get(d.CardCode) || {
      cardCode: d.CardCode, cardName: d.CardName, notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0, docs: 0,
    };
    p[b] += bal; p.total += bal; p.docs += 1;
    parties.set(d.CardCode, p);
    open.push({
      docEntry: d.DocEntry, docNum: d.DocNum, docDate: day(d.DocDate), dueDate: due, cardCode: d.CardCode,
      cardName: d.CardName, total: num(d.DocTotal), paid: num(d.PaidToDate), balance: round(bal), daysOverdue: Math.max(0, over),
    });
  }
  const rows = [...parties.values()].map((p) => {
    for (const k of ['notDue', 'd0_30', 'd31_60', 'd61_90', 'd90plus', 'total']) p[k] = round(p[k]);
    return p;
  }).sort((a, b) => b.total - a.total);
  const totals = rows.reduce((t, p) => {
    for (const k of ['notDue', 'd0_30', 'd31_60', 'd61_90', 'd90plus', 'total']) t[k] = round((t[k] || 0) + p[k]);
    return t;
  }, {});
  open.sort((a, b) => b.daysOverdue - a.daysOverdue || b.balance - a.balance);
  return { totals, parties: rows, open };
}

function openDocs(docs, today) {
  const rows = docs.filter(isOpen).map((d) => ({
    docEntry: d.DocEntry, docNum: d.DocNum, docDate: day(d.DocDate), dueDate: day(d.DocDueDate),
    cardCode: d.CardCode, cardName: d.CardName, total: num(d.DocTotal), net: round(net(d)),
    daysOld: d.DocDate ? daysBetween(day(d.DocDate), today) : null,
    late: d.DocDueDate ? day(d.DocDueDate) < today : false,
    salesPerson: d.SalesPersonCode,
  })).sort((a, b) => (a.docDate < b.docDate ? 1 : -1));
  return { count: rows.length, value: round(rows.reduce((t, r) => t + r.total, 0)), late: rows.filter((r) => r.late).length, rows };
}

export async function status(companyId) {
  const [connectors] = await pool.query(
    `SELECT id, connector_uid AS connectorUid, machine, win_user AS winUser, status, approved_at AS approvedAt,
            last_seen_at AS lastSeenAt, created_at AS createdAt
       FROM kd_connectors WHERE company_id = ? ORDER BY created_at DESC`, [companyId]);
  const [datasets] = await pool.query(
    `SELECT dataset, since_date AS sinceDate, last_ok_at AS lastOkAt, last_error AS lastError, last_rows AS rowCount
       FROM kd_dataset_state WHERE company_id = ? ORDER BY dataset`, [companyId]);
  const [runs] = await pool.query(
    `SELECT id, connector_id AS connectorId, started_at AS startedAt, finished_at AS finishedAt, ok, summary
       FROM kd_sync_runs WHERE company_id = ? ORDER BY started_at DESC LIMIT 20`, [companyId]);
  return {
    connectors, datasets,
    runs: runs.map((r) => ({ ...r, ok: !!r.ok, summary: typeof r.summary === 'string' ? JSON.parse(r.summary) : r.summary })),
  };
}

async function lastSync(companyId) {
  const [[r]] = await pool.query('SELECT MAX(last_ok_at) AS at FROM kd_dataset_state WHERE company_id = ?', [companyId]);
  return r?.at ?? null;
}

export async function overview(companyId) {
  const data = await load(companyId);
  const today = todayIso();
  const docs = salesDocs(data);
  const months = lastMonths(12, today);
  const byMonth = Object.fromEntries(months.map((m) => [m, 0]));
  const fy = fyStart(today);
  const byCustomer = new Map();
  for (const { d, sign } of docs) {
    const dd = day(d.DocDate);
    if (!dd) continue;
    const mk = monthKey(dd);
    if (mk in byMonth) byMonth[mk] += sign * net(d);
    if (dd >= fy) {
      const c = byCustomer.get(d.CardCode) || { cardCode: d.CardCode, cardName: d.CardName, sales: 0 };
      c.sales += sign * net(d);
      byCustomer.set(d.CardCode, c);
    }
  }
  const rec = ageing(data.invoices || [], today);
  const pay = ageing(data.purchaseInvoices || [], today);
  const so = openDocs(data.orders || [], today);
  const po = openDocs(data.purchaseOrders || [], today);
  return {
    asOf: await lastSync(companyId),
    fyStart: fy,
    salesMonth: sumSales(docs, `${today.slice(0, 7)}-01`, today),
    salesFy: sumSales(docs, fy, today),
    salesToday: sumSales(docs, today, today),
    receivables: rec.totals.total || 0,
    receivablesOverdue: round((rec.totals.total || 0) - (rec.totals.notDue || 0)),
    payables: pay.totals.total || 0,
    openSalesOrders: { count: so.count, value: so.value, late: so.late },
    openPurchaseOrders: { count: po.count, value: po.value, late: po.late },
    monthly: months.map((m) => ({ month: m, sales: round(byMonth[m]) })),
    topCustomers: [...byCustomer.values()].map((c) => ({ ...c, sales: round(c.sales) }))
      .sort((a, b) => b.sales - a.sales).slice(0, 10),
    receivablesAgeing: rec.totals,
  };
}

export async function sales(companyId, { from, to } = {}) {
  const data = await load(companyId);
  const today = todayIso();
  const f = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : fyStart(today);
  const t = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : today;
  const people = Object.fromEntries((data.salesPersons || []).map((p) => [p.SalesEmployeeCode, p.SalesEmployeeName]));
  const byMonth = new Map();
  const byCustomer = new Map();
  const byPerson = new Map();
  const docsInRange = [];
  for (const { d, sign } of salesDocs(data)) {
    const dd = day(d.DocDate);
    if (!dd || dd < f || dd > t) continue;
    const v = sign * net(d);
    const mk = monthKey(dd);
    byMonth.set(mk, (byMonth.get(mk) || 0) + v);
    const c = byCustomer.get(d.CardCode) || { cardCode: d.CardCode, cardName: d.CardName, sales: 0, docs: 0 };
    c.sales += v; c.docs += 1; byCustomer.set(d.CardCode, c);
    const pk = d.SalesPersonCode ?? -1;
    const p = byPerson.get(pk) || { code: pk, name: people[pk] || (pk === -1 ? 'No sales employee' : `#${pk}`), sales: 0, docs: 0 };
    p.sales += v; p.docs += 1; byPerson.set(pk, p);
    docsInRange.push({
      kind: sign > 0 ? 'Invoice' : 'Credit note', docEntry: d.DocEntry, docNum: d.DocNum, docDate: dd,
      cardCode: d.CardCode, cardName: d.CardName, net: round(v), total: round(sign * num(d.DocTotal)),
    });
  }
  docsInRange.sort((a, b) => (a.docDate < b.docDate ? 1 : a.docDate > b.docDate ? -1 : b.docNum - a.docNum));
  const r = (m) => [...m.values()].map((x) => ({ ...x, sales: round(x.sales) })).sort((a, b) => b.sales - a.sales);
  return {
    asOf: await lastSync(companyId), from: f, to: t,
    total: round(docsInRange.reduce((s, x) => s + x.net, 0)),
    monthly: [...byMonth.entries()].sort().map(([month, v]) => ({ month, sales: round(v) })),
    customers: r(byCustomer),
    salesPersons: r(byPerson),
    documents: docsInRange.slice(0, 500),
    documentCount: docsInRange.length,
  };
}

export async function receivables(companyId) {
  const data = await load(companyId);
  const bp = Object.fromEntries((data.businessPartners || []).map((b) => [b.CardCode, b]));
  const a = ageing(data.invoices || [], todayIso());
  a.parties = a.parties.map((p) => ({
    ...p, creditLimit: num(bp[p.cardCode]?.CreditLimit), accountBalance: num(bp[p.cardCode]?.CurrentAccountBalance),
  }));
  return { asOf: await lastSync(companyId), ...a, open: a.open.slice(0, 1000) };
}

export async function payables(companyId) {
  const data = await load(companyId);
  const a = ageing(data.purchaseInvoices || [], todayIso());
  return { asOf: await lastSync(companyId), ...a, open: a.open.slice(0, 1000) };
}

export async function salesOrders(companyId) {
  const data = await load(companyId);
  const people = Object.fromEntries((data.salesPersons || []).map((p) => [p.SalesEmployeeCode, p.SalesEmployeeName]));
  const o = openDocs(data.orders || [], todayIso());
  o.rows = o.rows.map((r) => ({ ...r, salesPersonName: people[r.salesPerson] || null }));
  return { asOf: await lastSync(companyId), ...o };
}

export async function purchaseOrders(companyId) {
  const data = await load(companyId);
  return { asOf: await lastSync(companyId), ...openDocs(data.purchaseOrders || [], todayIso()) };
}

export async function inventory(companyId) {
  const data = await load(companyId);
  const groups = Object.fromEntries((data.itemGroups || []).map((g) => [g.Number, g.GroupName]));
  const items = (data.items || []).filter((i) => i.Valid !== 'tNO').map((i) => ({
    itemCode: i.ItemCode, itemName: i.ItemName, group: groups[i.ItemsGroupCode] || `#${i.ItemsGroupCode}`,
    onHand: num(i.QuantityOnStock), onOrder: num(i.QuantityOrderedFromVendors), committed: num(i.QuantityOrderedByCustomers),
    uom: i.InventoryUOM || '',
  })).map((i) => ({ ...i, available: round(i.onHand - i.committed + i.onOrder), short: i.committed > i.onHand + i.onOrder }));
  const byGroup = new Map();
  for (const i of items) {
    const g = byGroup.get(i.group) || { group: i.group, items: 0, inStock: 0, short: 0 };
    g.items += 1; if (i.onHand > 0) g.inStock += 1; if (i.short) g.short += 1;
    byGroup.set(i.group, g);
  }
  const relevant = items.filter((i) => i.onHand || i.onOrder || i.committed)
    .sort((a, b) => Number(b.short) - Number(a.short) || b.onHand - a.onHand);
  return {
    asOf: await lastSync(companyId),
    itemCount: items.length, inStock: items.filter((i) => i.onHand > 0).length, shortCount: items.filter((i) => i.short).length,
    groups: [...byGroup.values()].sort((a, b) => b.items - a.items),
    items: relevant.slice(0, 2000),
  };
}

export async function savedReports(companyId) {
  const data = await load(companyId);
  const cats = Object.fromEntries((data.queryCategories || []).map((c) => [c.Code, c.Name]));
  const list = (data.userQueries || []).map((q) => ({
    id: `${q.QueryCategory}:${q.InternalKey}`, internalKey: q.InternalKey, categoryCode: q.QueryCategory,
    category: cats[q.QueryCategory] || (q.QueryCategory === -1 ? 'General' : `Category ${q.QueryCategory}`),
    name: q.QueryDescription, sql: q.Query || '',
  })).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return { asOf: await lastSync(companyId), count: list.length, reports: list };
}
