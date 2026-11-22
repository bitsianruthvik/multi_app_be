/**
 * stockEntryService.js — THE STOCK ENTRY WEEK (user, 2026-11-23): "1 temporary screen for now where they can see all the
 * list like in store/audit and change the number while they are auditing. And while changing, they should have the
 * ability segregate it by lots/batches/brands … This will be active for next one week to ensure we get the data in
 * correctly."
 *
 * Open while today ≤ the company setting stock_entry_until (Setup › Settings › Stores: audits and the stock book); after
 * that the list still reads but nothing is saved (ENTRY_CLOSED) and the menu hides the screen.
 *
 *   entryList   every catalog item of one store area (paged, the Stock screen's filters), each with its lots there:
 *               quantity, brand, vendor, the vendor's lot number, the date it came in; and whether it was entered already.
 *   saveEntry   one item: the lots as they really are. An existing lot is set to its quantity (and its brand / vendor /
 *               lot number corrected); a new row becomes a new lot. The differences are ONE adjustment (ADJ, reason
 *               "Stock entry …") at the stock's own cost — no approval: this week is for getting the data in — and the
 *               entry is kept as an audit (cf_stock_counts kind 'entry', posted), so it also counts for this month's audit.
 *               An item still counted by quantity is switched to lots first (stockService.keepByLot), as every stores
 *               item is kept by lot (§117).
 */
import { invalid, assertNoProblems } from '../lib/errors.js';
import { postMovement, keepByLot } from './stockService.js';
import { createBatch, updateBatch } from './batchService.js';
import { ledger } from './storesDeskService.js';
import { getSettings } from './settingsService.js';

const blank = (v) => v == null || String(v).trim() === '';
const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10));
const today = () => dateText(new Date());
const round6 = (n) => Number(Number(n).toFixed(6));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORE_PURPOSES = ['storage', 'quarantine'];

/** { open, until } — the screen is open through `until` (a date), closed when it is empty or past. */
export async function entryWindow(db, companyId) {
  const S = await getSettings(db, companyId);
  const until = S.stock_entry_until ?? null;
  return { until, open: !!until && today() <= until };
}

async function storeArea(db, companyId, areaId) {
  const [rows] = await db.query(
    `SELECT id, code, name, purpose FROM cf_stocking_areas WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND purpose IN (?) ORDER BY purpose DESC, name`,
    [companyId, STORE_PURPOSES]);
  const area = blank(areaId) ? rows.find((a) => a.purpose === 'storage') ?? rows[0] : rows.find((a) => Number(a.id) === Number(areaId));
  return { area: area ?? null, areas: rows };
}

/** The lots of some items in one area (with stock, or entered as none), oldest first. */
async function lotsOf(db, companyId, areaId, itemIds) {
  if (!itemIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT k.item_id, k.batch_id, k.quantity, b.code, b.status, b.received_on, b.supplier_ref, b.brand_id, br.name AS brand_name, br.is_unbranded,
            b.supplier_id, sp.name AS supplier_name, b.owner_party_id, op.name AS owner_name
       FROM cf_stock_balances k
       LEFT JOIN cf_stock_batches b ON b.id = k.batch_id
       LEFT JOIN cf_brands br ON br.id = b.brand_id
       LEFT JOIN cf_parties sp ON sp.id = b.supplier_id
       LEFT JOIN cf_parties op ON op.id = b.owner_party_id
      WHERE k.company_id = ? AND k.stocking_area_id = ? AND k.item_id IN (?) AND k.quantity <> 0
      ORDER BY k.item_id, b.received_on IS NULL, b.received_on, k.batch_id`, [companyId, areaId, itemIds]);
  const out = new Map();
  for (const r of rows) {
    const list = out.get(Number(r.item_id)) ?? [];
    list.push({
      lotId: r.batch_id ?? null, code: r.code ?? null, quantity: round6(r.quantity), status: r.status ?? null,
      receivedOn: dateText(r.received_on), supplierRef: r.supplier_ref ?? null,
      brand: r.brand_id ? { id: r.brand_id, name: r.brand_name, unbranded: Number(r.is_unbranded) === 1 } : null,
      vendor: r.supplier_id ? { id: r.supplier_id, name: r.supplier_name } : null,
      owner: r.owner_party_id ? { id: r.owner_party_id, name: r.owner_name } : null,
    });
    out.set(Number(r.item_id), list);
  }
  return out;
}

/**
 * GET /stores-desk/stock-entry?areaId=&search=&familyIds=&subfamilyIds=&variantIds=&todo=1&paged=1&limit=&offset=
 * One row an item of the catalog (every item, stock or not — it is how what is on the shelf gets in), with its lots in the
 * area. todo=1: only those not entered yet in this window.
 */
export async function entryList(db, companyId, q = {}) {
  const { area, areas } = await storeArea(db, companyId, q.areaId);
  if (!area) throw invalid('INVALID', 'Choose one of the store areas.');
  const win = await entryWindow(db, companyId);
  const since = win.until ? dateText(new Date(new Date(`${win.until}T00:00:00`).getTime() - 30 * 86400000)) : today();
  const [entered] = await db.query(
    `SELECT DISTINCT cl.item_id FROM cf_stock_count_lines cl JOIN cf_stock_counts n ON n.id = cl.count_id
      WHERE cl.company_id = ? AND n.area_id = ? AND n.kind = 'entry' AND n.deleted_at IS NULL AND n.count_date >= ?`, [companyId, area.id, since]);
  const done = new Set(entered.map((r) => Number(r.item_id)));
  const page = await ledger(db, companyId, {
    ...q, areaId: area.id, show: 'all', paged: 1,
    ...(q.todo === '1' || q.todo === 1 ? { excludeIds: [...done].join(',') } : {}),
  });
  const lots = await lotsOf(db, companyId, area.id, page.rows.map((r) => r.item.id));
  return {
    ...page,
    rows: page.rows.map((r) => {
      const list = lots.get(Number(r.item.id)) ?? [];
      return { item: r.item, group: r.group, book: round6(list.reduce((t, l) => t + l.quantity, 0)), lots: list, entered: done.has(Number(r.item.id)) };
    }),
    counts: { ...page.counts, area, areas, window: win, entered: done.size },
  };
}

/**
 * POST /stores-desk/stock-entry { areaId, itemId, note?, lots: [{ lotId?, quantity, brandId?, vendorId?, supplierRef?, receivedOn? }] }
 * The lots of the item in that area as they are on the shelf. A lot of the item there that is not sent is left as it is.
 * A row without lotId is a new lot (quantity > 0). Returns the item's row again.
 */
export async function saveEntry(db, c, input = {}) {
  const win = await entryWindow(db, c.companyId);
  if (!win.open) throw invalid('ENTRY_CLOSED', win.until ? `The stock entry screen closed after ${win.until}. Use Audit.` : 'The stock entry screen is not open. Use Audit.');
  const { area } = await storeArea(db, c.companyId, input.areaId);
  const problems = [];
  if (!area || blank(input.areaId)) problems.push('Choose one of the store areas.');
  const itemId = Number(input.itemId);
  const [[item]] = Number.isInteger(itemId) ? await db.query(
    `SELECT m.id, m.code, m.name, i.uom, i.tracked_by, i.item_type FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' FOR UPDATE`, [c.companyId, itemId]) : [[null]];
  if (!item) problems.push('That item does not exist.');
  else if (item.tracked_by === 'individual') problems.push(`${item.code} is tracked unit by unit — enter it on its own page.`);
  const rows = Array.isArray(input.lots) ? input.lots : [];
  if (!rows.length) problems.push('Give at least one lot, or the quantity.');
  if (rows.length > 50) problems.push('Up to 50 lots an item.');
  assertNoProblems(problems, 'The entry cannot be saved.');

  // read every row first
  const want = [];
  for (const [n, l] of rows.entries()) {
    const P = (m) => problems.push(`Lot ${n + 1}: ${m}`);
    const q = Number(l?.quantity);
    if (blank(l?.quantity) || !Number.isFinite(q) || q < 0) { P('the quantity is a number, zero or more.'); continue; }
    const loose = l.loose === true && blank(l.lotId);   // the item's stock with no lot yet (an item still counted by quantity)
    const lotId = blank(l.lotId) ? null : Number(l.lotId);
    if (lotId == null && !loose && q <= 0) continue;   // an empty new row is nothing
    const receivedOn = blank(l.receivedOn) ? null : String(l.receivedOn);
    if (receivedOn && (!DATE_RE.test(receivedOn) || receivedOn > today())) P('the date it came in is a past date.');
    const vendorId = blank(l.vendorId) ? null : Number(l.vendorId);
    want.push({ n: n + 1, lotId, loose, quantity: round6(q), brandId: blank(l.brandId) ? null : Number(l.brandId), vendorId, supplierRef: blank(l.supplierRef) ? null : String(l.supplierRef).trim().slice(0, 100), receivedOn });
  }
  const vendors = [...new Set(want.map((w) => w.vendorId).filter((v) => v != null))];
  if (vendors.length) {
    const [ok] = await db.query('SELECT id FROM cf_parties WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, vendors]);
    const have = new Set(ok.map((r) => Number(r.id)));
    for (const w of want) if (w.vendorId != null && !have.has(w.vendorId)) problems.push(`Lot ${w.n}: that vendor does not exist.`);
  }
  assertNoProblems(problems, 'The entry cannot be saved.');

  // an item still counted by quantity becomes kept by lot (its loose stock → one opening lot per area)
  // (and a lot-kept item with loose stock left from before has it put into an opening lot the same way)
  const [[lz]] = await db.query("SELECT COUNT(*) AS n FROM cf_stock_balances WHERE company_id = ? AND item_id = ? AND batch_key = 0 AND quantity <> 0", [c.companyId, item.id]);
  if (item.tracked_by !== 'batch' || Number(lz.n) > 0) {
    const k = await keepByLot(db, c, [{ itemId: item.id }], { reason: 'Stock entry: kept by lot from today' });
    const made = k.items.find((x) => x.itemId === item.id)?.lots.find((x) => Number(x.areaId) === Number(area.id));
    // the loose row the screen showed is now that opening lot
    for (const w of want) if (w.loose && made) w.lotId = Number(made.batchId);
  }
  // a loose row with nothing behind it is a new lot when it has a quantity, nothing when it has none
  const todo = want.filter((w) => w.lotId != null || w.quantity > 0);
  want.length = 0; want.push(...todo);

  const [have] = await db.query(
    `SELECT k.batch_id, k.quantity, b.item_id, b.owner_party_id, b.brand_id, b.supplier_id, b.supplier_ref, b.received_on FROM cf_stock_balances k
       LEFT JOIN cf_stock_batches b ON b.id = k.batch_id
      WHERE k.company_id = ? AND k.stocking_area_id = ? AND k.item_id = ? FOR UPDATE`, [c.companyId, area.id, item.id]);
  const book = new Map(have.map((h) => [h.batch_id == null ? 0 : Number(h.batch_id), h]));
  for (const w of want) {
    if (w.lotId == null) continue;
    if (!book.has(w.lotId)) {
      const [[b]] = await db.query('SELECT item_id FROM cf_stock_batches WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, w.lotId]);
      if (!b || Number(b.item_id) !== item.id) problems.push(`Lot ${w.n}: that lot is not of ${item.code}.`);
    }
  }
  const dup = want.filter((w) => w.lotId != null).map((w) => w.lotId);
  if (new Set(dup).size !== dup.length) problems.push('A lot is listed twice.');
  assertNoProblems(problems, 'The entry cannot be saved.');

  // the lots: corrected details, new lots made (no stock yet), then one adjustment for the differences
  const lines = [];   // { batchId, book, counted }
  for (const w of want) {
    if (w.lotId != null) {
      const h = book.get(w.lotId);
      const patch = {};
      if (w.brandId !== null && Number(h?.brand_id ?? 0) !== w.brandId) patch.brandId = w.brandId;
      if (w.supplierRef !== null && (h?.supplier_ref ?? null) !== w.supplierRef) patch.supplierRef = w.supplierRef;
      if (Object.keys(patch).length) await updateBatch(db, c, w.lotId, patch);
      const sets = [];
      const args = [];
      if (w.vendorId !== null && Number(h?.supplier_id ?? 0) !== w.vendorId) { sets.push('supplier_id = ?'); args.push(w.vendorId); }
      if (w.receivedOn !== null && dateText(h?.received_on) !== w.receivedOn) { sets.push('received_on = ?'); args.push(w.receivedOn); }
      if (sets.length) await db.query(`UPDATE cf_stock_batches SET ${sets.join(', ')} WHERE company_id = ? AND id = ?`, [...args, c.companyId, w.lotId]);
      lines.push({ batchId: w.lotId, book: round6(Number(h?.quantity ?? 0)), counted: w.quantity });
    } else {
      const batchId = await createBatch(db, c, item, { brandId: w.brandId, supplierId: w.vendorId, supplierRef: w.supplierRef, receivedOn: w.receivedOn ?? today() });
      lines.push({ batchId, book: 0, counted: w.quantity, made: true });
    }
  }
  const diffs = lines.filter((l) => Math.abs(l.counted - l.book) > 1e-9);
  let movementId = null;
  if (diffs.length) {
    const mv = await postMovement(db, c, {
      movementType: 'adjustment', areaId: area.id,
      reason: `Stock entry${blank(input.note) ? '' : `: ${String(input.note).trim()}`}`.slice(0, 255),
      lines: diffs.map((l) => ({ itemId: item.id, batchId: l.batchId, quantity: round6(l.counted - l.book), notes: l.made ? 'new lot on the shelf' : 'stock entry' })),
    });
    movementId = mv.id;
  }
  const [ins] = await db.query(
    'INSERT INTO cf_stock_counts (company_id, kind, area_id, count_date, status, lines_n, diff_n, diff_value, note, created_by, movement_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, 'entry', area.id, today(), diffs.length ? 'posted' : 'matched', lines.length, diffs.length, null, blank(input.note) ? 'Stock entry' : String(input.note).slice(0, 500), c.userId ?? null, movementId]);
  await db.query('UPDATE cf_stock_counts SET code = ? WHERE id = ?', [`CNT-${String(ins.insertId).padStart(6, '0')}`, ins.insertId]);
  // nothing on the shelf and nothing in the book: still one line, so the item reads as entered
  const rowsOut = lines.length ? lines : [{ batchId: null, book: 0, counted: 0 }];
  await db.query(
    `INSERT INTO cf_stock_count_lines (company_id, count_id, item_id, batch_id, book_qty, counted_qty, diff, unit_cost, reason) VALUES ${rowsOut.map(() => '(?, ?, ?, ?, ?, ?, ?, NULL, ?)').join(', ')}`,
    rowsOut.flatMap((l) => [c.companyId, ins.insertId, item.id, l.batchId, l.book, l.counted, round6(l.counted - l.book), 'Stock entry']));
  const back = await lotsOf(db, c.companyId, area.id, [item.id]);
  const list = back.get(item.id) ?? [];
  return { itemId: item.id, book: round6(list.reduce((t, l) => t + l.quantity, 0)), lots: list, entered: true, changed: diffs.length, movementId };
}
