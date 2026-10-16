/**
 * stockViewService.js — the Stock screen (Inventory v2, 2026-10-16).
 *
 * The user's rules: tracking follows each item's own setting — a QUANTITY item
 * is one running total per item and area; a BATCH item has lots (opened from
 * its row); an INDIVIDUAL item has pieces (opened from its row, one record per
 * piece, cf_stock_units). Never more tracking than the item asks for.
 *
 *   GET /stock/view          groups (item × area × owner × what it counts as), paged,
 *                            with chips' counts and the totals by owner over every match
 *   GET /stock/view/lots     the lots of one group (a batch item)
 *   (the pieces of a group: GET /stock/units — unitService.listUnits)
 *
 * WHAT A ROW COUNTS AS (category), first match wins:
 *   rejected (lot rejected) · held (lot on hold, or a quarantine area) · scrap (a
 *   scrap area) · offcut (an offcut item, wherever it lies) · in_process (a WIP
 *   area) · dispatch (a dispatch area) · finished (a lot production made, on a
 *   storage shelf) · available (raw material and everything else in storage).
 *
 * MONEY. Ours at cost (a lot at its unit cost; loose stock at the item's
 * average over the share of it that is costed — stockService.valueRows' rule);
 * our scrap at the scrap rate (0 and "no scrap rate set" when there is none).
 * A customer's stock is never in our value: their quantity and kg, and the
 * reference value it came with, apart.
 *
 * Fixed queries, whatever the page holds: the page, its count, four chip
 * counts, the totals, one read of averages, the item weights, the scrap rate
 * and the cutting places (offcut items).
 */
import { pageArgs, pageOf, countsBy } from '../lib/listing.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { unitKgOf } from './valuationService.js';
import { scrapRate, scrapItemId } from './scrapService.js';

export const VIEW_CATEGORIES = ['available', 'in_process', 'finished', 'held', 'rejected', 'dispatch', 'scrap', 'offcut'];
export const TRACKING = ['quantity', 'batch', 'individual'];
const EPS = 1e-9;
const blank = (v) => v == null || String(v).trim() === '';
const round2 = (n) => Number(Number(n).toFixed(2));
const round3 = (n) => Number(Number(n).toFixed(3));
const round6 = (n) => Number(Number(n).toFixed(6));
const like = (s) => `%${String(s).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

const FROM = `FROM cf_stock_balances k
  JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
  JOIN cf_master_records r ON r.id = k.item_id
  JOIN cf_item_details i ON i.master_id = k.item_id
  LEFT JOIN cf_stock_batches b ON b.id = k.batch_id
  LEFT JOIN cf_parties op ON op.id = b.owner_party_id`;

/** What a balance row counts as, in SQL. `offcutIds` = classification ids of offcut items. */
function categorySql(offcutIds) {
  const ids = offcutIds.length ? offcutIds.map(Number).filter(Number.isFinite).join(',') : '0';
  return `(CASE WHEN b.status = 'rejected' THEN 'rejected'
    WHEN b.status = 'on_hold' OR a.purpose = 'quarantine' THEN 'held'
    WHEN a.purpose = 'scrap' THEN 'scrap'
    WHEN r.classification_id IN (${ids}) THEN 'offcut'
    WHEN a.purpose = 'wip' THEN 'in_process'
    WHEN a.purpose = 'dispatch' THEN 'dispatch'
    WHEN b.production_item_id IS NOT NULL THEN 'finished'
    ELSE 'available' END)`;
}

/** Every node at or under the chosen classification (one read of the tree). */
async function classificationBranch(db, companyId, id) {
  const [nodes] = await db.query('SELECT id, parent_id FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const kids = new Map();
  for (const n of nodes) {
    if (!kids.has(n.parent_id)) kids.set(n.parent_id, []);
    kids.get(n.parent_id).push(n.id);
  }
  const out = new Set();
  const walk = [Number(id)];
  while (walk.length) {
    const x = walk.pop();
    if (out.has(x)) continue;
    out.add(x);
    walk.push(...(kids.get(x) ?? []));
  }
  return [...out];
}

/** Filters; `skip` leaves facets out ('category', 'owner', 'kind', 'tracking') so a chip counts the others. */
function viewWhere(companyId, q, cat, branch, skip = []) {
  const where = ['k.company_id = ?', 'k.quantity <> 0'];
  const params = [companyId];
  if (!blank(q.areaId)) { where.push('k.stocking_area_id = ?'); params.push(Number(q.areaId)); }
  if (!blank(q.itemId)) { where.push('k.item_id = ?'); params.push(Number(q.itemId)); }
  if (!skip.includes('category') && !blank(q.category)) { where.push(`${cat} = ?`); params.push(String(q.category)); }
  if (!skip.includes('owner')) {
    if (q.owner === 'ours') where.push('b.owner_party_id IS NULL');
    else if (q.owner === 'customer') where.push('b.owner_party_id IS NOT NULL');
    else if (!blank(q.owner) && Number.isInteger(Number(q.owner))) { where.push('b.owner_party_id = ?'); params.push(Number(q.owner)); }
  }
  if (!skip.includes('kind')) {
    if (q.kind === 'standard') where.push("i.item_type = 'catalog'");
    else if (q.kind === 'custom') where.push("i.item_type = 'temporary'");
  }
  if (!skip.includes('tracking') && TRACKING.includes(String(q.tracking))) { where.push('i.tracked_by = ?'); params.push(String(q.tracking)); }
  if (branch) { where.push('r.classification_id IN (?)'); params.push(branch.length ? branch : [0]); }
  if (!blank(q.search)) {
    where.push('(r.code LIKE ? OR r.name LIKE ? OR b.code LIKE ?)');
    const s = like(q.search);
    params.push(s, s, s);
  }
  return { where: where.join(' AND '), params };
}

const GROUP_SORT = {
  item: 'MAX(r.code)', area: 'MAX(a.code)', qty: 'SUM(k.quantity)', category: 'cat', owner: 'MAX(op.name)', updated: 'MAX(k.updated_at)',
};

/**
 * Loose stock's average per item (stockService.valueRows' rule): Map itemId ->
 * { avg, share } where share = the part of all its loose stock that is costed.
 */
async function poolsOf(db, companyId, itemIds) {
  const ids = [...new Set(itemIds)];
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT c.item_id, c.avg_unit_cost, c.costed_qty,
            (SELECT COALESCE(SUM(k.quantity), 0) FROM cf_stock_balances k WHERE k.company_id = c.company_id AND k.item_id = c.item_id AND k.batch_id IS NULL) AS loose
       FROM cf_item_costs c WHERE c.company_id = ? AND c.owner_key = 0 AND c.item_id IN (?)`,
    [companyId, ids],
  );
  for (const r of rows) {
    const avg = r.avg_unit_cost == null ? null : Number(r.avg_unit_cost);
    const costed = Number(r.costed_qty);
    const loose = Number(r.loose);
    if (avg == null || costed <= EPS) continue;
    out.set(r.item_id, { avg, share: loose > EPS ? Math.min(1, costed / loose) : 1 });
  }
  return out;
}

/** Value of a group's or total's figures: { value, uncostedQty } (ours; a customer's is their reference value). */
function moneyOf(g, pool) {
  const lotValue = g.lot_value == null ? 0 : Number(g.lot_value);
  const lotUncosted = Number(g.lot_uncosted ?? 0);
  const loose = Number(g.loose_qty ?? 0);
  let value = lotValue;
  let uncosted = lotUncosted;
  if (loose > EPS) {
    if (pool) { value += loose * pool.share * pool.avg; uncosted += loose * (1 - pool.share); } else uncosted += loose;
  }
  return { value: round2(value), uncostedQty: round6(uncosted) };
}

const SUMS = `SUM(k.quantity) AS qty, COUNT(*) AS n_lines, COUNT(k.batch_id) AS n_lots, MAX(k.updated_at) AS updated,
  SUM(CASE WHEN k.batch_id IS NOT NULL AND b.unit_cost IS NOT NULL THEN k.quantity * b.unit_cost END) AS lot_value,
  SUM(CASE WHEN k.batch_id IS NOT NULL AND b.unit_cost IS NULL THEN k.quantity ELSE 0 END) AS lot_uncosted,
  SUM(CASE WHEN k.batch_id IS NULL THEN k.quantity ELSE 0 END) AS loose_qty`;

/**
 * GET /stock/view. q: { search?, areaId?, itemId?, category?, owner? (ours | customer | party id),
 *   kind? (standard | custom), classificationId?, tracking? (quantity | batch | individual), sort?, dir?, limit?, offset? }
 * Returns (always paged): { rows, total, limit, offset, hasMore, counts, totals, scrapRate }
 *   rows    [{ key, item: { id, code, name, uom, trackedBy, kind, classificationId }, area, owner, category,
 *              quantity, kg, lines, lots, open: 'lots' | 'pieces' | null, unitCost, value, uncostedQty,
 *              referenceValue, scrap, updatedAt }] — ordered by tracking (quantity, batch, individual), then item
 *   counts  { categories, owners: { ours, parties }, kinds: { standard, custom }, tracking: { quantity, batch, individual } }
 *   totals  { ours: { value, uncostedQty, kg, lines, scrapKg }, customers: [{ party, kg, quantities: [{ uom, quantity }],
 *              referenceValue, uncostedQty, lines }] } — over every match (the owner chip aside)
 */
export async function stockView(db, companyId, q = {}) {
  const places = await cutPlaces(db, companyId);
  const offcutIds = [...places.plate.offcutIds, ...places.section.offcutIds];
  if (!offcutIds.length) {
    const [[node]] = await db.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'OFFCUT' AND deleted_at IS NULL", [companyId]);
    if (node) offcutIds.push(node.id);
  }
  const cat = categorySql(offcutIds);
  const branch = blank(q.classificationId) ? null : await classificationBranch(db, companyId, q.classificationId);
  const page = pageArgs({ ...q, paged: 1 }, { def: 100 });
  const all = viewWhere(companyId, q, cat, branch);
  const noCat = viewWhere(companyId, q, cat, branch, ['category']);
  const noOwner = viewWhere(companyId, q, cat, branch, ['owner']);
  const noKind = viewWhere(companyId, q, cat, branch, ['kind']);
  const noTrack = viewWhere(companyId, q, cat, branch, ['tracking']);
  const groupBy = `GROUP BY k.item_id, k.stocking_area_id, b.owner_party_id, ${cat}`;
  const sortKey = Object.prototype.hasOwnProperty.call(GROUP_SORT, q.sort) ? GROUP_SORT[q.sort] : null;
  const dir = String(q.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const order = `FIELD(MAX(i.tracked_by), 'quantity', 'batch', 'individual')${sortKey ? `, ${sortKey} ${dir}` : ''}, MAX(r.code), MAX(a.code), b.owner_party_id IS NOT NULL, MAX(op.name), k.item_id, k.stocking_area_id, cat`;
  const [[rows], [[cnt]], [catRows], [ownerRows], [kindRows], [trackRows], [totRows], rate, scrapId] = await Promise.all([
    db.query(
      `SELECT k.item_id, k.stocking_area_id, b.owner_party_id, ${cat} AS cat, ${SUMS},
              MAX(r.code) AS item_code, MAX(r.name) AS item_name, MAX(r.classification_id) AS classification_id,
              MAX(i.uom) AS uom, MAX(i.tracked_by) AS tracked_by, MAX(i.item_type) AS item_type,
              MAX(a.code) AS area_code, MAX(a.name) AS area_name, MAX(a.purpose) AS purpose,
              MAX(op.code) AS owner_code, MAX(op.name) AS owner_name
         ${FROM} WHERE ${all.where} ${groupBy} ORDER BY ${order} LIMIT ${page.limit} OFFSET ${page.offset}`, all.params),
    db.query(`SELECT COUNT(*) AS n FROM (SELECT 1 AS one ${FROM} WHERE ${all.where} ${groupBy}) x`, all.params),
    db.query(`SELECT x.cat AS k, COUNT(*) AS n FROM (SELECT ${cat} AS cat ${FROM} WHERE ${noCat.where} ${groupBy}) x GROUP BY x.cat`, noCat.params),
    db.query(`SELECT x.pid, MAX(x.name) AS name, MAX(x.code) AS code, COUNT(*) AS n FROM (SELECT b.owner_party_id AS pid, MAX(op.name) AS name, MAX(op.code) AS code ${FROM} WHERE ${noOwner.where} ${groupBy}) x GROUP BY x.pid`, noOwner.params),
    db.query(`SELECT x.k, COUNT(*) AS n FROM (SELECT IF(MAX(i.item_type) = 'temporary', 'custom', 'standard') AS k ${FROM} WHERE ${noKind.where} ${groupBy}) x GROUP BY x.k`, noKind.params),
    db.query(`SELECT x.k, COUNT(*) AS n FROM (SELECT MAX(i.tracked_by) AS k ${FROM} WHERE ${noTrack.where} ${groupBy}) x GROUP BY x.k`, noTrack.params),
    db.query(
      `SELECT b.owner_party_id AS pid, MAX(op.code) AS code, MAX(op.name) AS name, k.item_id, MAX(i.uom) AS uom, ${SUMS}
         ${FROM} WHERE ${noOwner.where} GROUP BY b.owner_party_id, k.item_id`, noOwner.params),
    scrapRate(db, companyId),
    scrapItemId(db, companyId),
  ]);
  const itemIds = [...new Set([...rows.map((r) => r.item_id), ...totRows.map((r) => r.item_id)])];
  const [kgOf, pools] = await Promise.all([
    unitKgOf(db, companyId, itemIds),
    poolsOf(db, companyId, [...rows.filter((r) => Number(r.loose_qty) > EPS).map((r) => r.item_id), ...totRows.filter((r) => Number(r.loose_qty) > EPS).map((r) => r.item_id)]),
  ]);
  const out = rows.map((g) => {
    const qty = round6(Number(g.qty));
    const per = kgOf.get(g.item_id);
    const theirs = g.owner_party_id != null;
    const m = moneyOf(g, pools.get(g.item_id));
    const isScrap = scrapId != null && Number(g.item_id) === Number(scrapId);
    return {
      key: `${g.item_id}:${g.stocking_area_id}:${g.owner_party_id ?? 0}:${g.cat}`,
      item: {
        id: g.item_id, code: g.item_code, name: g.item_name, uom: g.uom, trackedBy: g.tracked_by,
        kind: g.item_type === 'temporary' ? 'custom' : 'standard', classificationId: g.classification_id,
      },
      area: { id: g.stocking_area_id, code: g.area_code, name: g.area_name, purpose: g.purpose },
      owner: theirs ? { id: g.owner_party_id, code: g.owner_code ?? null, name: g.owner_name ?? null } : null,
      category: g.cat,
      quantity: qty,
      kg: per == null ? null : round3(qty * per),
      lines: Number(g.n_lines),
      lots: Number(g.n_lots),
      // How the row opens — what the item's own tracking asks for, nothing more.
      open: g.tracked_by === 'batch' && Number(g.n_lots) > 0 ? 'lots' : g.tracked_by === 'individual' ? 'pieces' : null,
      unitCost: qty > EPS && !theirs && m.uncostedQty <= EPS ? round6(m.value / qty) : null,
      value: theirs ? null : m.value,
      uncostedQty: theirs ? 0 : m.uncostedQty,
      referenceValue: theirs ? m.value : null,
      scrap: isScrap ? { ratePerKg: rate.ratePerKg, note: rate.note } : null,
      updatedAt: g.updated,
    };
  });

  // Totals by owner — ours valued, each customer's quantity and kg with their reference value apart.
  const ours = { value: 0, uncostedQty: 0, kg: 0, unweighed: 0, lines: 0, scrapKg: 0 };
  const parties = new Map();
  for (const t of totRows) {
    const qty = Number(t.qty);
    const per = kgOf.get(t.item_id);
    const m = moneyOf(t, pools.get(t.item_id));
    if (t.pid == null) {
      ours.value += m.value; ours.uncostedQty += m.uncostedQty; ours.lines += Number(t.n_lines);
      if (per == null) ours.unweighed += 1; else ours.kg += qty * per;
      if (scrapId != null && Number(t.item_id) === Number(scrapId)) ours.scrapKg += qty;
      continue;
    }
    const p = parties.get(t.pid) ?? { party: { id: t.pid, code: t.code ?? null, name: t.name ?? null }, kg: 0, unweighed: 0, quantities: new Map(), referenceValue: 0, uncostedQty: 0, lines: 0 };
    p.lines += Number(t.n_lines);
    p.referenceValue += m.value; p.uncostedQty += m.uncostedQty;
    if (per == null) p.unweighed += 1; else p.kg += qty * per;
    const uom = String(t.uom ?? '').toLowerCase();
    p.quantities.set(uom, (p.quantities.get(uom) ?? 0) + qty);
    parties.set(t.pid, p);
  }
  const totals = {
    currency: 'INR',
    ours: { value: round2(ours.value), uncostedQty: round6(ours.uncostedQty), kg: round3(ours.kg), unweighedItems: ours.unweighed, lines: ours.lines, scrapKg: round3(ours.scrapKg) },
    customers: [...parties.values()].map((p) => ({
      party: p.party, kg: round3(p.kg), unweighedItems: p.unweighed, lines: p.lines,
      quantities: [...p.quantities.entries()].map(([uom, quantity]) => ({ uom, quantity: round6(quantity) })),
      referenceValue: round2(p.referenceValue), uncostedQty: round6(p.uncostedQty),
    })).sort((a, b) => String(a.party.name ?? a.party.code ?? '').localeCompare(String(b.party.name ?? b.party.code ?? ''))),
  };
  const categories = countsBy(catRows, VIEW_CATEGORIES);
  const kinds = countsBy(kindRows, ['standard', 'custom']);
  const tracking = countsBy(trackRows, TRACKING);
  const counts = {
    categories: { ...categories, all: Object.values(categories).reduce((t, n) => t + n, 0) },
    owners: {
      ours: ownerRows.filter((r) => r.pid == null).reduce((t, r) => t + Number(r.n), 0),
      parties: ownerRows.filter((r) => r.pid != null).map((r) => ({ id: r.pid, name: r.name ?? null, code: r.code ?? null, n: Number(r.n) }))
        .sort((x, y) => String(x.name ?? x.code ?? '').localeCompare(String(y.name ?? y.code ?? ''))),
    },
    kinds: { ...kinds, all: kinds.standard + kinds.custom },
    tracking: { ...tracking, all: Object.values(tracking).reduce((t, n) => t + n, 0) },
  };
  return { ...pageOf(out, cnt.n, page), counts, totals, scrapRate: rate };
}

/**
 * GET /stock/view/lots?itemId=&areaId=&owner=&category= — the lots of one Stock
 * row (a batch item; also a quantity item's production or customer lots).
 * [{ batch: { id, code, status }, quantity, kg, unitCost, value, referenceValue, owner, piece, offcut, receivedOn, updatedAt }]
 */
export async function stockViewLots(db, companyId, q = {}) {
  if (blank(q.itemId)) return [];
  const places = await cutPlaces(db, companyId);
  const offcutIds = [...places.plate.offcutIds, ...places.section.offcutIds];
  const cat = categorySql(offcutIds);
  const f = viewWhere(companyId, { ...q, search: undefined }, cat, null);
  const [rows] = await db.query(
    `SELECT k.batch_id, k.quantity, k.updated_at, b.code AS batch_code, b.status AS batch_status, b.unit_cost, b.received_on, b.owner_party_id,
            op.code AS owner_code, op.name AS owner_name, pi.id AS piece_id, pi.code AS piece_code, o.id AS offcut_id, o.offcut_no, so.code AS order_code
       ${FROM}
       LEFT JOIN cf_production_items pi ON pi.id = b.production_item_id
       LEFT JOIN cf_offcuts o ON o.company_id = k.company_id AND o.batch_id = k.batch_id AND o.deleted_at IS NULL
       LEFT JOIN cf_sales_orders so ON so.id = b.owner_order_id
      WHERE ${f.where} AND k.batch_id IS NOT NULL
      ORDER BY b.received_on, b.code, k.batch_id LIMIT 2000`,
    f.params,
  );
  const kgOf = await unitKgOf(db, companyId, [Number(q.itemId)]);
  const per = kgOf.get(Number(q.itemId));
  return rows.map((r) => {
    const qty = Number(r.quantity);
    const unit = r.unit_cost == null ? null : Number(r.unit_cost);
    const v = unit == null ? null : round2(qty * unit);
    const theirs = r.owner_party_id != null;
    return {
      batch: { id: r.batch_id, code: r.batch_code, status: r.batch_status },
      quantity: round6(qty), kg: per == null ? null : round3(qty * per),
      unitCost: theirs ? null : unit, value: theirs ? null : v, referenceValue: theirs ? v : null,
      owner: theirs ? { id: r.owner_party_id, code: r.owner_code ?? null, name: r.owner_name ?? null } : null,
      ownerOrder: r.order_code ?? null,
      piece: r.piece_id ? { productionItemId: r.piece_id, code: r.piece_code } : null,
      offcut: r.offcut_id ? { id: r.offcut_id, offcutNo: r.offcut_no } : null,
      receivedOn: r.received_on, updatedAt: r.updated_at,
    };
  });
}

