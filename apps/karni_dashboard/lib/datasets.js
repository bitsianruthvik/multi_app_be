/**
 * What the connector reads from SAP Business One, and how.
 *
 * The connector asks for this list every run (GET /connector/plan), so a report
 * that needs more data is added HERE — nothing changes on the customer's machine.
 *
 * READ-ONLY: every entry is a Service Layer GET path (an OData read). The
 * connector itself refuses anything else; this list must never name an action.
 *
 *   key        — our name for the dataset
 *   entity     — the Service Layer collection
 *   select     — fields to read (an unknown field fails that dataset only; the
 *                error shows on the Connection screen)
 *   cross      — read a document's LINES flat: { lines, head, line } makes a
 *                $crossjoin(Entity,Entity/Lines) that returns only the named
 *                header and line fields; the server flattens each row to
 *                { ...head, ...line } (routes/connector.js)
 *   keyField   — the record's identity, or a function of the (flattened) row
 *   dateField  — the document date, stored as doc_date for date-range reports
 *   firstFrom  — the first sync reads documents from this date (by dateField)
 *   filter     — an extra OData filter, always applied
 *   full       — read everything every run and replace what we hold (small lists)
 *   sinceField — for entities without UpdateDate: re-read every row whose
 *                sinceField is within lookbackDays of the last good run
 *   everyMinutes — leave the dataset out of the plan until it is this old
 *   path       — a fixed GET path (probes)
 *
 * Otherwise a dataset reads only rows whose UpdateDate is on or after the
 * last good run, less a day.
 */
const DOC = 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,VatSum,DocCurrency,DocumentStatus,Cancelled,SalesPersonCode,UpdateDate';
const FIRST_FROM = '2023-04-01';
/** Lines and movements start one financial year back: enough for year-on-year. */
const LINES_FROM = '2025-04-01';

const HEAD = 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,BPLName,Cancelled,DocumentStatus,SalesPersonCode';
const lineKey = (r) => `${r.DocEntry}-${r.LineNum}`;
const linesOf = (key, entity, line, extra = {}) => ({
  key, entity, keyField: lineKey, dateField: 'DocDate', firstFrom: LINES_FROM,
  cross: { lines: 'DocumentLines', head: HEAD, line: `LineNum,${line}` }, ...extra,
});
const SALES_LINE = 'ItemCode,ItemDescription,Quantity,LineTotal,WarehouseCode,UoMCode';

export const DATASETS = [
  // ── Document headers ────────────────────────────────────────────────────
  { key: 'invoices', entity: 'Invoices', select: `${DOC},PaidToDate`, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
  { key: 'creditNotes', entity: 'CreditNotes', select: `${DOC},PaidToDate`, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
  { key: 'orders', entity: 'Orders', select: DOC, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
  { key: 'deliveries', entity: 'DeliveryNotes', select: DOC, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
  { key: 'purchaseOrders', entity: 'PurchaseOrders', select: DOC, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
  { key: 'purchaseInvoices', entity: 'PurchaseInvoices', select: `${DOC},PaidToDate`, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },

  // ── Document lines (flat, only the fields the reports use) ──────────────
  linesOf('invoiceLines', 'Invoices', SALES_LINE),
  linesOf('creditNoteLines', 'CreditNotes', SALES_LINE),
  linesOf('orderLines', 'Orders', `${SALES_LINE},RemainingOpenQuantity,LineStatus,ShipDate`),
  linesOf('deliveryLines', 'DeliveryNotes', SALES_LINE),
  linesOf('purchaseOrderLines', 'PurchaseOrders', `${SALES_LINE},RemainingOpenQuantity,LineStatus,ShipDate`),
  linesOf('grpoLines', 'PurchaseDeliveryNotes', `${SALES_LINE},BaseEntry,BaseType`),
  linesOf('purchaseInvoiceLines', 'PurchaseInvoices', SALES_LINE),
  // Production: receipts (output) and issues (material consumed), with machine / operator / shift / stage
  {
    key: 'productionReceipts', entity: 'InventoryGenEntries', keyField: lineKey, dateField: 'DocDate', firstFrom: LINES_FROM,
    cross: {
      lines: 'DocumentLines',
      head: 'DocEntry,DocNum,DocDate,BPLName,JournalMemo,U_EVT_MACHINE,U_EVT_OPER,U_EVT_SHIFT',
      line: 'LineNum,ItemCode,ItemDescription,Quantity,LineTotal,WarehouseCode,BaseEntry,BaseType',
    },
  },
  {
    key: 'productionIssues', entity: 'InventoryGenExits', keyField: lineKey, dateField: 'DocDate', firstFrom: LINES_FROM,
    cross: {
      lines: 'DocumentLines',
      head: 'DocEntry,DocNum,DocDate,BPLName,JournalMemo',
      line: 'LineNum,ItemCode,ItemDescription,Quantity,LineTotal,WarehouseCode,BaseEntry,BaseType,StgDesc',
    },
  },

  // ── Production orders (no UpdateDate: re-read the last 120 days every run) ─
  {
    key: 'productionOrders', entity: 'ProductionOrders', keyField: 'AbsoluteEntry', dateField: 'PostingDate',
    firstFrom: LINES_FROM, sinceField: 'PostingDate', lookbackDays: 120,
    select: 'AbsoluteEntry,DocumentNumber,ItemNo,ProductDescription,PlannedQuantity,CompletedQuantity,RejectedQuantity,'
      + 'ProductionOrderStatus,PostingDate,StartDate,DueDate,ClosingDate,Warehouse,CustomerCode,ProductionOrderOriginNumber,'
      + 'InventoryUOM,U_MACHINE,U_SECTION,U_Unit,U_UNE_Shift',
  },

  // ── Payments (no UpdateDate: re-read the last 10 days every run) ─────────
  {
    key: 'incomingPayments', entity: 'IncomingPayments', keyField: 'DocEntry', dateField: 'DocDate',
    firstFrom: LINES_FROM, sinceField: 'DocDate', lookbackDays: 10,
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,BPLName,CashSum,TransferSum,CancelStatus,DocType',
  },
  {
    key: 'vendorPayments', entity: 'VendorPayments', keyField: 'DocEntry', dateField: 'DocDate',
    firstFrom: LINES_FROM, sinceField: 'DocDate', lookbackDays: 10,
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,BPLName,CashSum,TransferSum,CancelStatus,DocType',
  },

  // ── Stock by warehouse (changes all day without touching the item: full, hourly) ─
  {
    key: 'stock', entity: 'Items', full: true, everyMinutes: 60, keyField: (r) => `${r.ItemCode}|${r.WarehouseCode}`,
    cross: {
      lines: 'ItemWarehouseInfoCollection', head: 'ItemCode', line: 'WarehouseCode,InStock,Committed,Ordered,StandardAveragePrice',
      join: 'ItemCode', lineFilter: '(InStock ne 0 or Committed ne 0 or Ordered ne 0)',
    },
  },
  { key: 'transferRequests', entity: 'InventoryTransferRequests', select: 'DocEntry,DocNum,DocDate,DueDate,FromWarehouse,ToWarehouse,DocumentStatus,BPLName,UpdateDate', keyField: 'DocEntry', dateField: 'DocDate', firstFrom: LINES_FROM },

  // ── Masters ──────────────────────────────────────────────────────────────
  {
    key: 'businessPartners', entity: 'BusinessPartners',
    select: 'CardCode,CardName,CardType,GroupCode,CurrentAccountBalance,CreditLimit,City,Phone1,EmailAddress,Valid,Frozen,UpdateDate',
    keyField: 'CardCode',
  },
  {
    key: 'items', entity: 'Items',
    select: 'ItemCode,ItemName,ItemsGroupCode,QuantityOnStock,QuantityOrderedFromVendors,QuantityOrderedByCustomers,InventoryUOM,Valid,Frozen,UpdateDate',
    keyField: 'ItemCode',
  },
  { key: 'itemGroups', entity: 'ItemGroups', select: 'Number,GroupName', keyField: 'Number', full: true },
  { key: 'warehouses', entity: 'Warehouses', select: 'WarehouseCode,WarehouseName,BusinessPlaceID', keyField: 'WarehouseCode', full: true },
  { key: 'businessPlaces', entity: 'BusinessPlaces', select: 'BPLID,BPLName', keyField: 'BPLID', full: true },
  { key: 'salesPersons', entity: 'SalesPersons', select: 'SalesEmployeeCode,SalesEmployeeName,Active', keyField: 'SalesEmployeeCode', full: true },
  { key: 'queryCategories', entity: 'QueryCategories', select: 'Code,Name', keyField: 'Code', full: true },
  {
    key: 'userQueries', entity: 'UserQueries', select: 'InternalKey,QueryCategory,QueryDescription,Query',
    keyField: (r) => `${r.QueryCategory}:${r.InternalKey}`, filter: 'QueryCategory ne -2', full: true,
  },
];

/**
 * PROBES: one or two sample records of an entity, every field, to build reports
 * against the fields THIS Service Layer actually has. Plain GETs with $top; the
 * rows land in kd_rows as `probe:<name>`. Remove a probe once it has been read.
 */
const PROBES = {
  downtime: 'U_EVT_BRK1?$top=2',
  breakdowns: 'U_EVT_BRKD?$top=2',
};
for (const [name, path] of Object.entries(PROBES)) {
  DATASETS.push({ key: `probe:${name}`, path, full: true, keyField: (r) => String(r.Code ?? r.DocEntry ?? 'sample') });
}

export const byKey = Object.fromEntries(DATASETS.map((d) => [d.key, d]));

const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const daysBefore = (d, n) => new Date(new Date(d).getTime() - n * 86400000);
// Encoded: curl refuses a URL with spaces or quotes in it.
const enc = encodeURIComponent;

/** The Service Layer GET path for one dataset, given where its last good sync got to. */
export function pathFor(ds, sinceDate) {
  if (ds.path) return ds.path;
  // The changed-since condition, on the header entity
  let since = null;
  if (!ds.full) {
    if (sinceDate && ds.sinceField) since = `${ds.sinceField} ge '${isoDay(daysBefore(sinceDate, ds.lookbackDays || 0))}'`;
    else if (sinceDate) since = `UpdateDate ge '${isoDay(sinceDate)}'`;
    else if (ds.firstFrom && ds.dateField) since = `${ds.dateField} ge '${ds.firstFrom}'`;
  }

  if (ds.cross) {
    const E = ds.entity;
    const L = `${E}/${ds.cross.lines}`;
    const join = ds.cross.join || 'DocEntry';
    const filters = [`${E}/${join} eq ${L}/${join}`];
    if (since) filters.push(`${E}/${since}`);
    if (ds.filter) filters.push(`${E}/${ds.filter}`);
    if (ds.cross.lineFilter) filters.push(ds.cross.lineFilter.replace(/\b(InStock|Committed|Ordered)\b/g, `${L}/$1`));
    return `$crossjoin(${E},${L})?$expand=${enc(`${E}($select=${ds.cross.head}),${L}($select=${ds.cross.line})`)}`
      + `&$filter=${enc(filters.join(' and '))}&$orderby=${enc(`${E}/${join}`)}`;
  }

  const filters = [];
  if (ds.filter) filters.push(ds.filter);
  if (since) filters.push(since);
  const q = [`$select=${ds.select}`];
  if (filters.length) q.push(`$filter=${enc(filters.map((f) => (filters.length > 1 ? `(${f})` : f)).join(' and '))}`);
  q.push(`$orderby=${typeof ds.keyField === 'string' ? ds.keyField : 'InternalKey'}`);
  return `${ds.entity}?${q.join('&')}`;
}

/** A crossjoin row is { Entity: {...}, 'Entity/Lines': {...} }: one flat record. */
export function flatten(ds, row) {
  if (!ds.cross) return row;
  const head = row[ds.entity] || {};
  const line = row[`${ds.entity}/${ds.cross.lines}`] || {};
  return { ...head, ...line };
}

export function keyOf(ds, row) {
  return String(typeof ds.keyField === 'function' ? ds.keyField(row) : row[ds.keyField]);
}

export function dateOf(ds, row) {
  const v = ds.dateField ? row[ds.dateField] : null;
  return v ? String(v).slice(0, 10) : null;
}
