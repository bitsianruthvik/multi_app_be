/**
 * What the connector reads from SAP Business One, and how.
 *
 * The connector asks for this list every run (GET /connector/plan), so a report
 * that needs more data is added HERE — nothing changes on the customer's machine.
 *
 * READ-ONLY: every entry is a Service Layer GET path (an OData read). The
 * connector itself refuses anything else; this list must never name an action.
 *
 *   key       — our name for the dataset
 *   entity    — the Service Layer collection
 *   select    — fields to read (an unknown field fails that dataset only; the
 *               error shows on the Connection screen)
 *   keyField  — the record's identity, or a function of the row
 *   dateField — the document date, stored as doc_date for date-range reports
 *   firstFrom — the first sync reads documents from this date (by dateField)
 *   filter    — an extra OData filter, always applied
 *   full      — read everything every run (small lists); else only rows whose
 *               UpdateDate is on or after the last good run, less a day
 */
const DOC = 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,VatSum,DocCurrency,DocumentStatus,Cancelled,SalesPersonCode,UpdateDate';
const FIRST_FROM = '2023-04-01';

export const DATASETS = [
  { key: 'invoices', entity: 'Invoices', select: `${DOC},PaidToDate`, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
  { key: 'creditNotes', entity: 'CreditNotes', select: `${DOC},PaidToDate`, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
  { key: 'orders', entity: 'Orders', select: DOC, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
  { key: 'deliveries', entity: 'DeliveryNotes', select: DOC, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
  { key: 'purchaseOrders', entity: 'PurchaseOrders', select: DOC, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
  { key: 'purchaseInvoices', entity: 'PurchaseInvoices', select: `${DOC},PaidToDate`, keyField: 'DocEntry', dateField: 'DocDate', firstFrom: FIRST_FROM },
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
  { key: 'salesPersons', entity: 'SalesPersons', select: 'SalesEmployeeCode,SalesEmployeeName,Active', keyField: 'SalesEmployeeCode', full: true },
  { key: 'queryCategories', entity: 'QueryCategories', select: 'Code,Name', keyField: 'Code', full: true },
  {
    key: 'userQueries', entity: 'UserQueries', select: 'InternalKey,QueryCategory,QueryDescription,Query',
    keyField: (r) => `${r.QueryCategory}:${r.InternalKey}`, filter: 'QueryCategory ne -2', full: true,
  },
];

export const byKey = Object.fromEntries(DATASETS.map((d) => [d.key, d]));

const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** The Service Layer GET path for one dataset, given where its last good sync got to. */
export function pathFor(ds, sinceDate) {
  const filters = [];
  if (ds.filter) filters.push(ds.filter);
  if (!ds.full) {
    if (sinceDate) filters.push(`UpdateDate ge '${isoDay(sinceDate)}'`);
    else if (ds.firstFrom && ds.dateField) filters.push(`${ds.dateField} ge '${ds.firstFrom}'`);
  }
  const q = [`$select=${ds.select}`];
  // Encoded: curl refuses a URL with spaces or quotes in it.
  if (filters.length) q.push(`$filter=${encodeURIComponent(filters.map((f) => (filters.length > 1 ? `(${f})` : f)).join(' and '))}`);
  q.push(`$orderby=${typeof ds.keyField === 'string' ? ds.keyField : 'InternalKey'}`);
  return `${ds.entity}?${q.join('&')}`;
}

export function keyOf(ds, row) {
  return String(typeof ds.keyField === 'function' ? ds.keyField(row) : row[ds.keyField]);
}

export function dateOf(ds, row) {
  const v = ds.dateField ? row[ds.dateField] : null;
  return v ? String(v).slice(0, 10) : null;
}
