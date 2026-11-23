/**
 * storesDeskService.js — the Stores desk (init.sql §111, user 2026-11-19).
 *
 * "User shouldn't be able to edit the stock directly. They should only be able to do so using internal mechanism."
 * Nothing here writes a balance: every change is a movement posted by stockService.postMovement, as it always was.
 * This module adds what the storekeeper's paper ledger had and the Stock screen did not:
 *
 *   ledger        each item with Opening, In, Out and Balance for a period, over the STORE's own areas (storage and
 *                 quarantine) added up, plus what is out with people and vendors, what is on order, and its minimum.
 *                 It is a read of cf_stock_balances and cf_stock_ledger — no figure is kept twice.
 *   give out      an issue charged to exactly ONE of a sales order, a department or a vendor; who collected it and
 *                 the machine are optional. A returnable item (cf_item_details.stores_kind) and anything sent to a
 *                 vendor is written to cf_stock_custody: it is expected back.
 *   out with      what is ours and not here; each row comes back (a receipt into its area), or is worn out, or lost.
 *   count         book against counted for one area. Differences post as ONE adjustment when small; above
 *                 cf_company_settings.count_auto_limit they wait in Management's Approvals (type stock_count).
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { likeOf, pageArgs, pageOf } from '../lib/listing.js';
import { postMovement, reverseMovement, getMovement } from './stockService.js';
import { requestApproval } from './approvalService.js';
import { getSettings } from './settingsService.js';

const blank = (v) => v == null || String(v).trim() === '';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10));
const today = () => dateText(new Date());
const round6 = (n) => Number(Number(n).toFixed(6));
const round2 = (n) => Number(Number(n).toFixed(2));
const num = (v) => (v == null ? 0 : Number(v));
/** The store's own areas: where stock is kept and where a receipt waits. WIP, dispatch and scrap belong to production. */
const STORE_PURPOSES = ['storage', 'quarantine'];
export const GIVEN_TYPES = ['order', 'department', 'vendor'];
export const CUSTODY_KINDS = ['returned', 'worn', 'lost'];
export const COUNT_KINDS = ['daily', 'weekly', 'spot', 'monthly'];

/** The stores switches of a company. Reads the defaults when the columns are not there yet. */
export async function deskSettings(db, companyId) {
  try {
    const [[s]] = await db.query('SELECT * FROM cf_company_settings WHERE company_id = ?', [companyId]);
    return {
      storesV2: Number(s?.stores_v2) === 1, countAutoLimit: s?.count_auto_limit == null ? 500 : Number(s.count_auto_limit),
      // §112: the closed period, backdating, the store's hours, and how long is too long out
      closedThrough: dateText(s?.stock_closed_through), backdateDays: s?.stock_backdate_days == null ? 3 : Number(s.stock_backdate_days),
      openTime: s?.store_open_time ?? '08:00', closeTime: s?.store_close_time ?? '18:00', toolsOutDays: s?.tools_out_days == null ? 90 : Number(s.tools_out_days),
    };
  } catch (e) {
    if (e.errno === 1054 || e.errno === 1146) return { storesV2: false, countAutoLimit: 500, closedThrough: null, backdateDays: 3, openTime: '08:00', closeTime: '18:00', toolsOutDays: 90 };
    throw e;
  }
}

/**
 * POST /movements on a company that runs the Stores desk: the free receipt, issue and count are closed (user 2026-11-19:
 * stock changes only through the app's own mechanisms). A transfer between areas, a scrap and a customer return stay.
 */
const DESK_WAY = { receipt: 'Receive against a PO (Stores › Receive)', issue: 'Give out (Stores › Stock)', adjustment: 'an audit (Stores › Audit)' };
export async function assertDeskAllows(db, companyId, movementType) {
  if (!DESK_WAY[movementType]) return;
  if ((await deskSettings(db, companyId)).storesV2) throw invalid('USE_THE_DESK', `Stock is not changed directly here — use ${DESK_WAY[movementType]}.`);
}

// --- the short lists ------------------------------------------------------------

export async function listDepartments(db, companyId) {
  const [rows] = await db.query("SELECT id, name FROM cf_departments WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY name", [companyId]);
  return rows;
}
export async function addDepartment(db, c, input = {}) {
  const name = blank(input.name) ? null : String(input.name).trim().slice(0, 80);
  if (!name) throw invalid('INVALID', 'Give the department a name.');
  const [[have]] = await db.query('SELECT id, name FROM cf_departments WHERE company_id = ? AND deleted_at IS NULL AND name = ?', [c.companyId, name]);
  if (have) return have;
  const [r] = await db.query('INSERT INTO cf_departments (company_id, name, created_by) VALUES (?, ?, ?)', [c.companyId, name, c.userId ?? null]);
  return { id: r.insertId, name };
}
export async function listPeople(db, companyId, q = {}) {
  const where = ["p.company_id = ?", 'p.deleted_at IS NULL', "p.status = 'active'"];
  const params = [companyId];
  const like = likeOf(q.search);
  if (like) { where.push('p.name LIKE ?'); params.push(like); }
  const [rows] = await db.query(
    `SELECT p.id, p.name, p.department_id, d.name AS department_name FROM cf_store_people p
       LEFT JOIN cf_departments d ON d.id = p.department_id AND d.deleted_at IS NULL
      WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT 500`, params);
  return rows.map((r) => ({ id: r.id, name: r.name, department: r.department_id ? { id: r.department_id, name: r.department_name } : null }));
}
export async function addPerson(db, c, input = {}) {
  const name = blank(input.name) ? null : String(input.name).trim().slice(0, 120);
  if (!name) throw invalid('INVALID', 'Give the person a name.');
  let departmentId = null;
  if (!blank(input.departmentId)) {
    const [[d]] = await db.query('SELECT id FROM cf_departments WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.departmentId)]);
    if (!d) throw invalid('INVALID', 'That department does not exist.');
    departmentId = d.id;
  }
  const [[have]] = await db.query('SELECT id FROM cf_store_people WHERE company_id = ? AND deleted_at IS NULL AND name = ? AND COALESCE(department_id, 0) = ?', [c.companyId, name, departmentId ?? 0]);
  if (have) return { id: have.id, name, departmentId };
  const [r] = await db.query('INSERT INTO cf_store_people (company_id, name, department_id, created_by) VALUES (?, ?, ?, ?)', [c.companyId, name, departmentId, c.userId ?? null]);
  return { id: r.insertId, name, departmentId };
}

// --- the ledger -----------------------------------------------------------------

/** from / to of a period: this month unless said. */
function periodOf(q = {}) {
  const t = today();
  const from = DATE_RE.test(String(q.from ?? '')) ? String(q.from) : `${t.slice(0, 8)}01`;
  const to = DATE_RE.test(String(q.to ?? '')) ? String(q.to) : t;
  if (from > to) throw invalid('INVALID', 'The period starts after it ends.');
  return { from, to };
}

/** The store's areas of a company (or the one asked for), and the SQL list of their ids. */
async function storeAreas(db, companyId, areaId = null) {
  const [rows] = await db.query(
    `SELECT id, code, name, purpose FROM cf_stocking_areas WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND purpose IN (?) ORDER BY purpose DESC, name`,
    [companyId, STORE_PURPOSES]);
  const picked = areaId ? rows.filter((a) => Number(a.id) === Number(areaId)) : rows;
  return { all: rows, ids: picked.map((a) => a.id) };
}

/**
 * GET /stores-desk/ledger?from=&to=&areaId=&familyId=&subfamilyId=&owner=ours|customer&search=&show=all|stock|low|out&paged=1
 *   (2026-11-23) familyIds= / subfamilyIds= / variantIds= — several at once, comma lists (each level narrows the one above:
 *   an item passes when it is in a picked variant, else in a picked sub-family, else in a picked family); all=1 every row
 *   (print / download). Rows and groups carry the variant too.
 * owner (user, 2026-11-22): ours = our own stock only, customer = material a customer supplied (a lot with an owner);
 * left out = both added up. Opening / in / out / balance all follow it; each row also says how much of it is a customer's.
 * One row an item of the catalog: opening, in, out, balance (at `to`), out with, on order, reserved, minimum.
 * Opening = the balance now less everything since `from`; a transfer between two store areas is neither in nor out.
 * Fixed reads: the areas, the rows (one statement), the total, the groups.
 */
export async function ledger(db, companyId, q = {}) {
  const { from, to } = periodOf(q);
  const areas = await storeAreas(db, companyId, blank(q.areaId) ? null : Number(q.areaId));
  const page = pageArgs(q, { def: 100 });
  const areaIds = areas.ids.length ? areas.ids : [0];
  const where = ["m.company_id = ?", 'm.deleted_at IS NULL', "m.record_kind = 'item'", "i.item_type = 'catalog'"];
  const params = [companyId];
  const like = likeOf(q.search);
  // (2026-11-23) also the description (the stores' own other names for it: "Also called: …", "Stores ledger name: …")
  // and the brand of any of its lots — stores look for "Berger" or "Epilux" once the brand is off the item's name
  if (like) {
    where.push(`(m.name LIKE ? OR m.code LIKE ? OR m.description LIKE ? OR EXISTS (SELECT 1 FROM cf_stock_batches sb JOIN cf_brands br ON br.id = sb.brand_id
      WHERE sb.company_id = m.company_id AND sb.item_id = m.id AND sb.deleted_at IS NULL AND br.name LIKE ?))`);
    params.push(like, like, like, like);
  }
  // one item (the item page's "Stock" link) / everything but some (the stock entry screen's "not entered yet")
  if (!blank(q.itemId)) { where.push('m.id = ?'); params.push(Number(q.itemId)); }
  const notIds = String(q.excludeIds ?? '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (notIds.length) { where.push('m.id NOT IN (?)'); params.push(notIds); }
  if (!blank(q.familyId)) { where.push('f.id = ?'); params.push(Number(q.familyId)); }
  if (!blank(q.subfamilyId)) { where.push('s.id = ?'); params.push(Number(q.subfamilyId)); }
  // several families / sub-families / variants (the picker narrows top-down): the most specific level picked under a
  // family decides for that family, so "Consumables + its Painting sub-family + all of Tools" reads as the user means it
  const ids = (v) => String(v ?? '').split(',').map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  const fams = ids(q.familyIds); const subsP = ids(q.subfamilyIds); const vars = ids(q.variantIds);
  if (fams.length || subsP.length || vars.length) {
    const ors = [];
    if (vars.length) { ors.push('v.id IN (?)'); params.push(vars); }
    if (subsP.length) { ors.push(`(s.id IN (?)${vars.length ? ' AND NOT EXISTS (SELECT 1 FROM cf_classification_nodes pv WHERE pv.parent_id = s.id AND pv.id IN (?))' : ''})`); params.push(subsP); if (vars.length) params.push(vars); }
    if (fams.length) { ors.push(`(f.id IN (?)${subsP.length || vars.length ? ' AND NOT EXISTS (SELECT 1 FROM cf_classification_nodes ps2 WHERE ps2.parent_id = f.id AND (ps2.id IN (?) OR EXISTS (SELECT 1 FROM cf_classification_nodes pv2 WHERE pv2.parent_id = ps2.id AND pv2.id IN (?))))' : ''})`); params.push(fams); if (subsP.length || vars.length) params.push(subsP.length ? subsP : [0], vars.length ? vars : [0]); }
    where.push(`(${ors.join(' OR ')})`);
  }
  const show = ['stock', 'low', 'out', 'reserved'].includes(q.show) ? q.show : 'all';
  // 2026-11-23 (user: "add a customer filter to see by customer their stocks"): customerId = that customer's own material only
  const customerId = Number.isInteger(Number(q.customerId)) && Number(q.customerId) > 0 ? Number(q.customerId) : null;
  const owner = customerId ? 'customer' : ['ours', 'customer'].includes(q.owner) ? q.owner : null;
  const ownBal = customerId ? `AND ob.owner_party_id = ${customerId}` : owner === 'ours' ? 'AND ob.owner_party_id IS NULL' : owner === 'customer' ? 'AND ob.owner_party_id IS NOT NULL' : '';
  const ownLed = customerId ? `AND l.owner_party_id = ${customerId}` : owner === 'ours' ? 'AND l.owner_party_id IS NULL' : owner === 'customer' ? 'AND l.owner_party_id IS NOT NULL' : '';
  if (owner === 'customer') where.push('(COALESCE(bal.q, 0) <> 0 OR COALESCE(mv.in_q, 0) <> 0 OR COALESCE(mv.out_q, 0) <> 0)');
  if (show === 'stock') where.push('(COALESCE(bal.q, 0) <> 0 OR COALESCE(mv.in_q, 0) <> 0 OR COALESCE(mv.out_q, 0) <> 0 OR COALESCE(cu.q, 0) <> 0)');
  if (show === 'low') where.push('ps.min_qty IS NOT NULL AND COALESCE(bal.q, 0) < ps.min_qty');
  if (show === 'out') where.push('COALESCE(cu.q, 0) > 0');
  if (show === 'reserved') where.push('COALESCE(rs.q, 0) > 0');   // locked for a sales order (2026-11-22)
  const FROM = `
      FROM cf_master_records m
      JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      LEFT JOIN cf_classification_nodes v ON v.id = m.classification_id
      LEFT JOIN cf_classification_nodes s ON s.id = v.parent_id
      LEFT JOIN cf_classification_nodes f ON f.id = s.parent_id
      LEFT JOIN (SELECT k.item_id, SUM(k.quantity) AS q, SUM(IF(ob.owner_party_id IS NOT NULL, k.quantity, 0)) AS cust_q
                   FROM cf_stock_balances k LEFT JOIN cf_stock_batches ob ON ob.id = k.batch_id
                  WHERE k.company_id = ? AND k.stocking_area_id IN (?) ${ownBal} GROUP BY k.item_id) bal ON bal.item_id = m.id
      LEFT JOIN (SELECT x.item_id,
                        SUM(CASE WHEN x.d <= ? AND x.live = 1 AND x.q > 0 THEN x.q ELSE 0 END) AS in_q,
                        SUM(CASE WHEN x.d <= ? AND x.live = 1 AND x.q < 0 THEN -x.q ELSE 0 END) AS out_q,
                        SUM(x.q) AS since_q,
                        SUM(CASE WHEN x.d > ? THEN x.q ELSE 0 END) AS after_q
                   FROM (SELECT l.item_id, l.movement_id, mm.movement_date AS d, SUM(l.quantity) AS q,
                                (mm.reversed_by_id IS NULL AND mm.reversal_of_id IS NULL) AS live
                           FROM cf_stock_ledger l JOIN cf_stock_movements mm ON mm.id = l.movement_id
                          WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.stocking_area_id IN (?) AND mm.movement_date >= ? ${ownLed}
                          GROUP BY l.item_id, l.movement_id, mm.movement_date, live) x
                  GROUP BY x.item_id) mv ON mv.item_id = m.id
      LEFT JOIN (SELECT item_id, SUM(quantity - qty_returned - qty_worn - qty_lost) AS q FROM cf_stock_custody
                  WHERE company_id = ? AND status = 'open' AND deleted_at IS NULL GROUP BY item_id) cu ON cu.item_id = m.id
      LEFT JOIN (SELECT pl.item_id, SUM(GREATEST(pl.quantity - COALESCE(pl.qty_received, 0) - COALESCE(pl.qty_closed, 0), 0)) AS q
                   FROM cf_purchase_order_lines pl JOIN cf_purchase_orders p ON p.id = pl.purchase_order_id AND p.deleted_at IS NULL
                  WHERE pl.company_id = ? AND pl.deleted_at IS NULL AND p.status IN ('ordered', 'partially_received') GROUP BY pl.item_id) po ON po.item_id = m.id
      LEFT JOIN (SELECT item_id, SUM(quantity) AS q FROM cf_stock_reservations
                  WHERE company_id = ? AND status = 'active' AND deleted_at IS NULL GROUP BY item_id) rs ON rs.item_id = m.id
      LEFT JOIN cf_procurement_settings ps ON ps.company_id = m.company_id AND ps.master_id = m.id`;
  const fromParams = [companyId, areaIds, to, to, to, companyId, areaIds, from, companyId, companyId, companyId];
  const sort = { name: 'm.name', balance: 'balance', out: 'out_q' }[q.sort] ?? null;
  const dir = String(q.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const [[rows], [[{ n: total }]], [groups], [owners]] = await Promise.all([
    db.query(
      `SELECT m.id, m.code, m.name, m.status, i.uom, i.tracked_by, i.stores_kind, i.issue_conditions,
              f.id AS family_id, f.name AS family_name, s.id AS subfamily_id, s.name AS subfamily_name, v.id AS variant_id, v.name AS variant_name,
              COALESCE(bal.q, 0) - COALESCE(mv.after_q, 0) AS balance, COALESCE(bal.q, 0) AS now_q,
              COALESCE(bal.q, 0) - COALESCE(mv.since_q, 0) AS opening,
              COALESCE(mv.in_q, 0) AS in_q, COALESCE(mv.out_q, 0) AS out_q,
              COALESCE(cu.q, 0) AS out_with, COALESCE(po.q, 0) AS on_order, COALESCE(rs.q, 0) AS reserved, COALESCE(bal.cust_q, 0) AS cust_q,
              ps.method, ps.min_qty, ps.max_qty
         ${FROM}
        WHERE ${where.join(' AND ')}
        ORDER BY ${sort ? `${sort} ${dir}, ` : ''}f.name, s.name, v.name, m.name, m.id
        LIMIT ? OFFSET ?`,
      [...fromParams, ...params, page.limit, page.offset]),
    db.query(`SELECT COUNT(*) AS n ${FROM} WHERE ${where.join(' AND ')}`, [...fromParams, ...params]),
    db.query(
      `SELECT f.id AS family_id, f.name AS family_name, s.id AS subfamily_id, s.name AS subfamily_name, v.id AS variant_id, v.name AS variant_name, COUNT(*) AS n
         FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
         JOIN cf_classification_nodes v ON v.id = m.classification_id
         JOIN cf_classification_nodes s ON s.id = v.parent_id
         JOIN cf_classification_nodes f ON f.id = s.parent_id
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND i.item_type = 'catalog'
        GROUP BY f.id, f.name, s.id, s.name, v.id, v.name ORDER BY f.name, s.name, v.name`, [companyId]),
    // the customers whose material is in the store now (the customer filter's choices)
    db.query(
      `SELECT p.id, p.name, COUNT(DISTINCT k.item_id) AS items, COUNT(DISTINCT b.id) AS lots
         FROM cf_stock_balances k JOIN cf_stock_batches b ON b.id = k.batch_id JOIN cf_parties p ON p.id = b.owner_party_id
        WHERE k.company_id = ? AND k.stocking_area_id IN (?) AND k.quantity > 0 GROUP BY p.id, p.name ORDER BY p.name`, [companyId, areaIds]),
  ]);
  return pageOf(rows.map((r) => ({
    item: { id: r.id, code: r.code, name: r.name, uom: r.uom, trackedBy: r.tracked_by, returnable: r.stores_kind === 'returnable', status: r.status, issueConditions: r.issue_conditions ?? null },
    group: { familyId: r.family_id, family: r.family_name, subfamilyId: r.subfamily_id, subfamily: r.subfamily_name, variantId: r.variant_id, variant: r.variant_name },
    opening: round6(r.opening), in: round6(r.in_q), out: round6(r.out_q), balance: round6(r.balance), now: round6(r.now_q),
    outWith: round6(r.out_with), onOrder: round6(r.on_order), reserved: round6(r.reserved), customers: round6(r.cust_q),
    min: r.min_qty == null ? null : Number(r.min_qty), max: r.max_qty == null ? null : Number(r.max_qty), method: r.method ?? null,
    low: r.min_qty != null && Number(r.now_q) < Number(r.min_qty),
  })), total, page, {
    // beside the page, as every paged list carries its chips (lib/listing.js)
    counts: {
      period: { from, to }, owner: owner ?? 'all', customerId,
      customers: owners.map((o) => ({ id: Number(o.id), name: o.name, items: Number(o.items), lots: Number(o.lots) })),
      areas: areas.all,
      // one row a variant (2026-11-23); a sub-family's items = its variants' added up
      groups: groups.map((g) => ({ familyId: g.family_id, family: g.family_name, subfamilyId: g.subfamily_id, subfamily: g.subfamily_name, variantId: g.variant_id, variant: g.variant_name, items: Number(g.n) })),
    },
  });
}

export const GIVEN_JOINS = `
       LEFT JOIN cf_sales_orders so ON so.id = mm.order_id
       LEFT JOIN cf_departments dp ON dp.id = mm.department_id
       LEFT JOIN cf_parties gp ON gp.id = mm.given_party_id
       LEFT JOIN cf_parties sp ON sp.id = mm.party_id
       LEFT JOIN cf_store_people pe ON pe.id = mm.person_id
       LEFT JOIN cf_machines mc ON mc.id = mm.machine_id`;
/** What a movement row says it was for, in the words the ledger shows. */
export function givenOf(r) {
  if (r.given_type === 'vendor') return { type: 'vendor', label: r.given_party_name ?? 'Vendor' };
  if (r.given_type === 'department') return { type: 'department', label: r.department_name ?? 'Department' };
  if (r.order_code) return { type: 'order', label: r.order_code };
  if (r.movement_type === 'issue' && r.used_for === 'general') return { type: 'general', label: 'General' };
  if (r.movement_type === 'receipt' && r.supplier_name) return { type: 'supplier', label: r.supplier_name };
  return null;
}

/**
 * GET /stores-desk/ledger/:itemId?from=&to= — everything behind one row: where it is (every area), its lots, each event
 * of the period, who holds some of it, and what is on order. Six reads.
 */
export async function itemLedger(db, companyId, itemId, q = {}) {
  const { from, to } = periodOf(q);
  const id = Number(itemId);
  const [[item]] = await db.query(
    `SELECT m.id, m.code, m.name, i.uom, i.tracked_by, i.stores_kind, i.due_days, ps.method, ps.min_qty, ps.max_qty, ps.lead_time_days
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
       LEFT JOIN cf_procurement_settings ps ON ps.company_id = m.company_id AND ps.master_id = m.id
      WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item'`, [companyId, id]);
  if (!item) throw notFound('Item');
  const [[byArea], [lots], [events], [custody], [orders]] = await Promise.all([
    db.query(
      `SELECT a.id, a.code, a.name, a.purpose, SUM(k.quantity) AS q FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
        WHERE k.company_id = ? AND k.item_id = ? GROUP BY a.id, a.code, a.name, a.purpose HAVING ABS(SUM(k.quantity)) > 0.0000001 ORDER BY a.name`, [companyId, id]),
    db.query(
      `SELECT b.id, b.code, b.status, b.supplier_ref, b.received_on, b.unit_cost, a.id AS area_id, a.name AS area_name, k.quantity,
              b.brand_id, br.name AS brand_name, br.is_unbranded, b.supplier_id, sp.name AS supplier_name, b.owner_party_id, op.name AS owner_name,
              (SELECT SUM(r.quantity) FROM cf_stock_reservations r
                WHERE r.company_id = k.company_id AND r.batch_id = b.id AND r.status = 'active' AND r.deleted_at IS NULL) AS held_q
         FROM cf_stock_balances k JOIN cf_stock_batches b ON b.id = k.batch_id JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
         LEFT JOIN cf_brands br ON br.id = b.brand_id LEFT JOIN cf_parties sp ON sp.id = b.supplier_id LEFT JOIN cf_parties op ON op.id = b.owner_party_id
        WHERE k.company_id = ? AND k.item_id = ? AND k.quantity > 0 AND a.purpose IN (?) ORDER BY b.id LIMIT 200`, [companyId, id, STORE_PURPOSES]),
    db.query(
      `SELECT l.id, l.quantity, l.batch_id, bt.code AS batch_code, a.name AS area_name, a.purpose,
              mm.id AS movement_id, mm.code, mm.movement_type, mm.movement_date, mm.reference, mm.reason, mm.used_for, mm.given_type,
              mm.reversal_of_id, mm.reversed_by_id, so.code AS order_code, dp.name AS department_name, gp.name AS given_party_name,
              sp.name AS supplier_name, pe.name AS person_name, mc.code AS machine_code, mc.name AS machine_name, u.name AS by_name
         FROM cf_stock_ledger l
         JOIN cf_stock_movements mm ON mm.id = l.movement_id
         JOIN cf_stocking_areas a ON a.id = l.stocking_area_id
         LEFT JOIN cf_stock_batches bt ON bt.id = l.batch_id
         ${GIVEN_JOINS}
         LEFT JOIN users u ON u.id = mm.created_by
        WHERE l.company_id = ? AND l.item_id = ? AND l.deleted_at IS NULL AND mm.movement_date BETWEEN ? AND ?
        ORDER BY mm.movement_date DESC, l.id DESC LIMIT 300`, [companyId, id, from, to]),
    db.query(`${CUSTODY_SELECT} WHERE c.company_id = ? AND c.item_id = ? AND c.status = 'open' AND c.deleted_at IS NULL ORDER BY c.issued_on`, [companyId, id]),
    db.query(
      `SELECT p.id, p.code, p.status, COALESCE(pl.expected_date, p.expected_date) AS expected, sp.name AS supplier_name,
              GREATEST(pl.quantity - COALESCE(pl.qty_received, 0) - COALESCE(pl.qty_closed, 0), 0) AS open_q
         FROM cf_purchase_order_lines pl JOIN cf_purchase_orders p ON p.id = pl.purchase_order_id AND p.deleted_at IS NULL
         LEFT JOIN cf_parties sp ON sp.id = p.supplier_id
        WHERE pl.company_id = ? AND pl.item_id = ? AND pl.deleted_at IS NULL AND p.status IN ('ordered', 'partially_received')
       HAVING open_q > 0 ORDER BY expected`, [companyId, id]),
  ]);
  return {
    item: {
      id: item.id, code: item.code, name: item.name, uom: item.uom, trackedBy: item.tracked_by, returnable: item.stores_kind === 'returnable',
      dueDays: item.due_days ?? null, method: item.method ?? null, min: item.min_qty == null ? null : Number(item.min_qty), max: item.max_qty == null ? null : Number(item.max_qty),
    },
    period: { from, to },
    areas: byArea.map((a) => ({ id: a.id, code: a.code, name: a.name, purpose: a.purpose, quantity: round6(a.q), store: STORE_PURPOSES.includes(a.purpose) })),
    // §117: each lot's brand (null = not recorded) and vendor (the GRN's supplier), oldest first: the order give-out takes them
    lots: lots.map((b) => ({
      id: b.id, code: b.code, status: b.status, supplierRef: b.supplier_ref ?? null, area: { id: b.area_id, name: b.area_name }, quantity: round6(b.quantity),
      receivedOn: dateText(b.received_on), unitCost: b.unit_cost == null ? null : Number(b.unit_cost),
      brand: b.brand_id ? { id: b.brand_id, name: b.brand_name, unbranded: Number(b.is_unbranded) === 1 } : null,
      vendor: b.supplier_id ? { id: b.supplier_id, name: b.supplier_name } : null,
      // 2026-11-23: whose it is (a customer's material) and how much of it is held for a request or an order
      owner: b.owner_party_id ? { id: b.owner_party_id, name: b.owner_name } : null, held: round6(b.held_q ?? 0),
    })),
    events: events.map((e) => ({
      id: e.id, movementId: e.movement_id, code: e.code, type: e.movement_type, date: dateText(e.movement_date), change: round6(e.quantity),
      area: e.area_name, store: STORE_PURPOSES.includes(e.purpose), lot: e.batch_code ?? null, reference: e.reference ?? null, reason: e.reason ?? null,
      given: givenOf(e), person: e.person_name ?? null, machine: e.machine_code ? `${e.machine_code}${e.machine_name ? ` ${e.machine_name}` : ''}` : null,
      returnIn: e.given_type === 'return_in', reversed: !!e.reversed_by_id, reversal: !!e.reversal_of_id, by: e.by_name ?? null,
    })),
    outWith: custody.map((r) => shapeCustody(r)),
    onOrder: orders.map((o) => ({ id: o.id, code: o.code, status: o.status, supplier: o.supplier_name ?? null, expected: dateText(o.expected), quantity: round6(o.open_q) })),
  };
}

// --- give out -------------------------------------------------------------------

/** The store area that holds the most of an item (where a give-out comes from when none is said). */
async function mainAreaOf(db, companyId, itemId) {
  const [[a]] = await db.query(
    `SELECT k.stocking_area_id AS id FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
      WHERE k.company_id = ? AND k.item_id = ? AND a.purpose = 'storage' AND a.deleted_at IS NULL
      GROUP BY k.stocking_area_id ORDER BY SUM(k.quantity) DESC LIMIT 1`, [companyId, itemId]);
  if (a) return a.id;
  const [[any]] = await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [companyId]);
  return any?.id ?? null;
}

/** Oldest available lots of a batch-kept item in one area that cover a quantity: [{ batchId, quantity }]. */
async function lotsFor(db, companyId, itemId, areaId, quantity) {
  const [rows] = await db.query(
    `SELECT k.batch_id, k.quantity FROM cf_stock_balances k JOIN cf_stock_batches b ON b.id = k.batch_id
      WHERE k.company_id = ? AND k.item_id = ? AND k.stocking_area_id = ? AND k.quantity > 0 AND b.status = 'available' AND b.owner_party_id IS NULL
      ORDER BY b.id`, [companyId, itemId, areaId]);
  const out = [];
  let left = quantity;
  for (const r of rows) {
    if (left <= 1e-9) break;
    const take = Math.min(left, Number(r.quantity));
    out.push({ batchId: r.batch_id, quantity: round6(take) });
    left = round6(left - take);
  }
  return { lots: out, short: left > 1e-9 ? left : 0 };
}

/**
 * POST /stores-desk/give-out {
 *   givenFor: { type: 'order' | 'department' | 'vendor', orderId?, orderLineId?, departmentId?, partyId? },   exactly one
 *   personId?, machineId?, maintenanceOrderId?, notes?,
 *   lines: [{ itemId, quantity, areaId?, batchId? }]
 * }
 * One issue movement (stockService.postMovement — its refusals are the stock's own: not enough, a held batch, a closed
 * order). A returnable item needs a person or a department to come back from; it and anything sent to a vendor are
 * written to "Out with". → { movement, outWith: n }
 */
export async function giveOut(db, c, input = {}) {
  const problems = [];
  const g = input.givenFor ?? {};
  // 2026-11-22 (user): a give-out is for a sales order or goes to a contractor; departments and "collected by" are
  // company settings, off unless switched on (Setup › Settings › Stores: the day).
  const S0 = await getSettings(db, c.companyId);
  // 2026-11-23 (user): "there shouldn't be a loose stock-out" — without the switch a give-out is made on a request.
  if (S0.giveout_loose !== true) throw invalid('USE_A_REQUEST', 'Stock is given out against a material request: open the request on Stores › Requests and press Issue now.');
  const allowDept = S0.giveout_departments === true;
  const allowPerson = S0.giveout_person === true;
  const type = GIVEN_TYPES.includes(g.type) && (g.type !== 'department' || allowDept) ? g.type : null;
  if (!type) problems.push(allowDept ? 'Say what it is given for: a sales order, a department or a contractor.' : 'Say what it is given for: a sales order or a contractor.');
  const given = { type };
  let orderId = null;
  if (type === 'order') {
    if (blank(g.orderId)) problems.push('Choose the sales order.');
    else orderId = Number(g.orderId);
  }
  if (type === 'department') {
    const [[d]] = blank(g.departmentId) ? [[null]] : await db.query("SELECT id, name FROM cf_departments WHERE company_id = ? AND id = ? AND deleted_at IS NULL", [c.companyId, Number(g.departmentId)]);
    if (!d) problems.push('Choose the department.');
    else given.departmentId = d.id;
  }
  if (type === 'vendor') {
    const [[p]] = blank(g.partyId) ? [[null]] : await db.query('SELECT id, name, is_subcontractor FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(g.partyId)]);
    if (!p) problems.push('Choose the contractor it is sent to.');
    else if (!Number(p.is_subcontractor)) problems.push(`${p.name} is not marked as a contractor. Mark it on its party page, or choose a contractor.`);
    else given.partyId = p.id;
  }
  let person = null;
  if (allowPerson && !blank(input.personId)) {
    [[person]] = await db.query('SELECT id, name, department_id FROM cf_store_people WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.personId)]);
    if (!person) problems.push('That person is not on the list.');
    else given.personId = person.id;
  }
  if (!blank(input.machineId)) {
    const [[mc]] = await db.query('SELECT id FROM cf_machines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.machineId)]);
    if (!mc) problems.push('That machine does not exist.');
    else given.machineId = mc.id;
  }
  const asked = Array.isArray(input.lines) ? input.lines : [];
  if (!asked.length) problems.push('Add at least one item.');
  const lines = [];
  const plans = [];   // what each asked line is, for "Out with"
  for (const [n, l] of asked.slice(0, 100).entries()) {
    const P = (msg) => problems.push(`Line ${n + 1}: ${msg}`);
    const qty = Number(l?.quantity);
    if (blank(l?.itemId)) { P('choose an item.'); continue; }
    if (!Number.isFinite(qty) || qty <= 0) { P('the quantity is a number above zero.'); continue; }
    const [[item]] = await db.query(
      `SELECT i.*, m.id, m.code, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
        WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item'`, [c.companyId, Number(l.itemId)]);
    if (!item) { P('that item does not exist.'); continue; }
    // §114: what maintenance wants checked before this goes out — the storekeeper confirms it on the line.
    if (!blank(item.issue_conditions) && l.conditionsChecked !== true) { P(`${item.name} — check before giving it out: ${item.issue_conditions}`); continue; }
    const returnable = item.stores_kind === 'returnable';
    if (allowPerson && returnable && type === 'order' && !person) { P(`${item.name} comes back — say who is collecting it.`); continue; }
    const areaId = blank(l.areaId) ? await mainAreaOf(db, c.companyId, item.id) : Number(l.areaId);
    if (!areaId) { P('there is no store area to give it out from.'); continue; }
    const before = lines.length;
    if (item.tracked_by === 'batch' && blank(l.batchId)) {
      const { lots, short } = await lotsFor(db, c.companyId, item.id, areaId, round6(qty));
      if (short) { P(`only ${round6(qty - short)} of ${item.name} is available here.`); continue; }
      for (const lot of lots) lines.push({ itemId: item.id, quantity: lot.quantity, fromAreaId: areaId, batchId: lot.batchId });
    } else {
      lines.push({ itemId: item.id, quantity: round6(qty), fromAreaId: areaId, ...(blank(l.batchId) ? {} : { batchId: Number(l.batchId) }) });
    }
    for (let k = before; k < lines.length; k++) plans.push({ item, areaId, expectBack: returnable });   // Out with holds tools only — a consumable sent to a contractor is used up (user, 2026-11-22)
  }
  assertNoProblems(problems, 'It cannot be given out.');

  const movement = await postMovement(db, c, {
    movementType: 'issue',
    ...(type === 'order' ? { usedFor: 'order', orderId, ...(blank(g.orderLineId) ? {} : { orderLineId: Number(g.orderLineId) }) } : {}),
    ...(type === 'department' ? { usedFor: 'general' } : {}),
    ...(blank(input.maintenanceOrderId) ? {} : { maintenanceOrderId: Number(input.maintenanceOrderId) }),
    notes: blank(input.notes) ? null : String(input.notes).slice(0, 500),
    lines,
  }, { given, ...(type === 'vendor' ? { usedFor: 'vendor' } : {}) });

  // Out with: one row a line that is expected back.
  let outWith = 0;
  const t = today();
  for (const [k, ln] of movement.lines.entries()) {
    const plan = plans[k];
    if (!plan?.expectBack) continue;
    const holder = type === 'vendor' ? 'vendor' : person ? 'person' : type === 'order' ? 'order' : 'department';
    const due = plan.item.due_days ? dateText(new Date(Date.now() + Number(plan.item.due_days) * 86400000)) : null;
    await db.query(
      `INSERT INTO cf_stock_custody (company_id, movement_id, item_id, batch_id, area_id, quantity, holder_type, department_id, person_id, party_id, order_id, machine_id, issued_on, due_on, unit_cost, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, movement.id, ln.item.id, ln.batch?.id ?? null, plan.areaId, ln.quantity, holder, given.departmentId ?? person?.department_id ?? null, given.personId ?? null,
        given.partyId ?? null, orderId, given.machineId ?? null, t, due, ln.unitCost ?? null, c.userId ?? null]);
    outWith += 1;
  }
  return { movement, outWith };
}

/**
 * POST /stores-desk/take-back { movementId, itemId, quantity, note? } — some of what was given out comes back unused
 * (user, 2026-11-22: "if there was excess of consumable given and they want to return … super simple").
 * The give-out is undone and written again for what was really used, so the sales order (or contractor) is charged
 * only for that and the store's book is right — both by the stock's own reversal, nothing typed into the book.
 * A tool comes back on Out with, not here. → { takenBack, item, from: code, instead: code | null }
 */
export async function takeBack(db, c, input = {}) {
  const qty = Number(input.quantity);
  if (blank(input.movementId) || blank(input.itemId)) throw invalid('INVALID', 'Choose the give-out and the item.');
  if (!Number.isFinite(qty) || qty <= 0) throw invalid('INVALID', 'The quantity is a number above zero.');
  const [[m]] = await db.query('SELECT * FROM cf_stock_movements WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(input.movementId)]);
  if (!m || m.movement_type !== 'issue') throw notFound('This give-out');
  if (m.reversed_by_id || m.reversal_of_id) throw invalid('REVERSED', `${m.code} was already undone.`);
  const full = await getMovement(db, c.companyId, m.id);
  const [[kind]] = await db.query('SELECT stores_kind FROM cf_item_details WHERE master_id = ?', [Number(input.itemId)]);
  if (kind?.stores_kind === 'returnable') throw invalid('HAS_TOOLS', 'A tool comes back on Stores › Out with, not here.');
  const mine = full.lines.filter((l) => Number(l.item.id) === Number(input.itemId));
  const had = round6(mine.reduce((a, l) => a + l.quantity, 0));
  if (!mine.length) throw invalid('INVALID', 'That item is not on this give-out.');
  if (qty > had + 1e-9) throw invalid('TOO_MANY', `Only ${had} ${mine[0].item.uom ?? ''} of ${mine[0].item.name} was given out on ${m.code}.`);
  const note = blank(input.note) ? null : String(input.note).trim().slice(0, 200);
  const [oldCust] = await db.query('SELECT id, item_id, qty_returned, qty_worn, qty_lost FROM cf_stock_custody WHERE company_id = ? AND movement_id = ? AND deleted_at IS NULL', [c.companyId, m.id]);
  await reverseMovement(db, c, m.id, { reason: `Taken back: ${round6(qty)} ${mine[0].item.uom ?? ''} of ${mine[0].item.name}${note ? ` — ${note}` : ''}`.slice(0, 255) });
  // what was really used: every other line as it was, this item less what came back (from its last lot first)
  let back = round6(qty);
  const keep = [];
  for (const l of [...full.lines].reverse()) {
    let q = l.quantity;
    if (Number(l.item.id) === Number(input.itemId) && back > 1e-9) { const t = Math.min(back, q); q = round6(q - t); back = round6(back - t); }
    if (q > 1e-9) keep.unshift({ itemId: l.item.id, quantity: q, fromAreaId: l.from?.id, ...(l.batch ? { batchId: l.batch.id } : {}) });
  }
  let instead = null;
  if (m.requisition_id != null) {
    // A give-out made on a request: undoing it puts the stock back on hold for that request (stockService), and what
    // was really used is issued again THROUGH the request, so the request, its order and its contractor stay right.
    const { issueMr } = await import('./purchaseRequestService.js');
    const [mrLines] = await db.query('SELECT id, item_id FROM cf_requisition_lines WHERE company_id = ? AND requisition_id = ? AND deleted_at IS NULL', [c.companyId, m.requisition_id]);
    const lineOf = new Map(mrLines.map((l) => [Number(l.item_id), l.id]));
    const byItem = new Map();
    for (const k of keep) byItem.set(Number(k.itemId), round6((byItem.get(Number(k.itemId)) ?? 0) + k.quantity));
    const again = [...byItem].filter(([itemId]) => lineOf.has(itemId)).map(([itemId, quantity]) => ({ lineId: lineOf.get(itemId), quantity }));
    if (again.length) {
      // What is put back in its place was checked when it first went out, so it is not asked again.
      const out = await issueMr(db, c, m.requisition_id, { lines: again, conditionsChecked: [...byItem.keys()] });
      instead = out.movement.code;
      // tools: the Out with row written again by the request's issue replaces an untouched old one; an old row that
      // already had something come back is kept, moved to the new entry, and its new twin is dropped.
      for (const o of oldCust) {
        const touched = Number(o.qty_returned) + Number(o.qty_worn) + Number(o.qty_lost) > 1e-9;
        if (!touched) await db.query('UPDATE cf_stock_custody SET deleted_at = NOW() WHERE id = ?', [o.id]);
        else {
          await db.query('UPDATE cf_stock_custody SET deleted_at = NOW() WHERE company_id = ? AND movement_id = ? AND item_id = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, out.movement.id, o.item_id]);
          await db.query('UPDATE cf_stock_custody SET movement_id = ? WHERE id = ?', [out.movement.id, o.id]);
        }
      }
    } else if (oldCust.length) await db.query('UPDATE cf_stock_custody SET deleted_at = NOW() WHERE id IN (?)', [oldCust.map((o) => o.id)]);
    return { takenBack: round6(qty), item: { id: mine[0].item.id, name: mine[0].item.name, uom: mine[0].item.uom }, from: m.code, instead, request: m.requisition_id };
  }
  if (keep.length) {
    const given = { type: m.given_type ?? (m.order_id ? 'order' : 'department'), departmentId: m.department_id ?? null, partyId: m.given_party_id ?? null, personId: m.person_id ?? null, machineId: m.machine_id ?? null };
    const mv = await postMovement(db, c, {
      movementType: 'issue',
      ...(m.used_for === 'order' ? { usedFor: 'order', orderId: m.order_id, ...(m.order_line_id ? { orderLineId: m.order_line_id } : {}) } : m.used_for === 'general' ? { usedFor: 'general' } : {}),
      ...(m.maintenance_order_id ? { maintenanceOrderId: m.maintenance_order_id } : {}),
      reference: `In place of ${m.code}`.slice(0, 100), notes: m.notes ?? null, lines: keep,
    }, { given, ...(m.used_for === 'vendor' ? { usedFor: 'vendor' } : {}) });
    instead = mv.code;
    // a tool given on the same entry is still out: its Out with row follows the entry written in its place
    await db.query('UPDATE cf_stock_custody SET movement_id = ? WHERE company_id = ? AND movement_id = ?', [mv.id, c.companyId, m.id]);
  }
  return { takenBack: round6(qty), item: { id: mine[0].item.id, name: mine[0].item.name, uom: mine[0].item.uom }, from: m.code, instead };
}

/**
 * The "Out with" rows of an issue made somewhere else than Give out (a material request's issue, §116): one a line whose
 * item is a tool, held by the contractor named, else by the sales order. Nothing when it is for neither.
 */
export async function custodyForIssue(db, c, movement, { partyId = null, orderId = null } = {}) {
  if (!partyId && !orderId) return 0;
  const ids = [...new Set(movement.lines.map((l) => l.item.id))];
  if (!ids.length) return 0;
  const [tools] = await db.query("SELECT master_id, due_days FROM cf_item_details WHERE master_id IN (?) AND stores_kind = 'returnable'", [ids]);
  const due = new Map(tools.map((t) => [Number(t.master_id), t.due_days]));
  let n = 0;
  for (const ln of movement.lines) {
    if (!due.has(Number(ln.item.id))) continue;
    const d = due.get(Number(ln.item.id));
    await db.query(
      `INSERT INTO cf_stock_custody (company_id, movement_id, item_id, batch_id, area_id, quantity, holder_type, party_id, order_id, issued_on, due_on, unit_cost, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, movement.id, ln.item.id, ln.batch?.id ?? null, ln.from?.id ?? null, ln.quantity, partyId ? 'vendor' : 'order', partyId, orderId, today(),
        d ? dateText(new Date(Date.now() + Number(d) * 86400000)) : null, ln.unitCost ?? null, c.userId ?? null]);
    n += 1;
  }
  return n;
}

// --- out with -------------------------------------------------------------------

const CUSTODY_SELECT = `SELECT c.*, m.code AS item_code, m.name AS item_name, i.uom, mv.code AS movement_code,
       dp.name AS department_name, pe.name AS person_name, pa.name AS party_name, so.code AS order_code, mc.code AS machine_code
  FROM cf_stock_custody c
  JOIN cf_master_records m ON m.id = c.item_id
  JOIN cf_item_details i ON i.master_id = c.item_id
  LEFT JOIN cf_stock_movements mv ON mv.id = c.movement_id
  LEFT JOIN cf_departments dp ON dp.id = c.department_id
  LEFT JOIN cf_store_people pe ON pe.id = c.person_id
  LEFT JOIN cf_parties pa ON pa.id = c.party_id
  LEFT JOIN cf_sales_orders so ON so.id = c.order_id
  LEFT JOIN cf_machines mc ON mc.id = c.machine_id`;

function shapeCustody(r, longDays = 90) {
  const left = round6(num(r.quantity) - num(r.qty_returned) - num(r.qty_worn) - num(r.qty_lost));
  const due = dateText(r.due_on);
  const t = today();
  const daysOut = Math.max(0, Math.round((new Date(t) - new Date(dateText(r.issued_on))) / 86400000));
  return {
    id: r.id, item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom },
    quantity: round6(r.quantity), returned: round6(r.qty_returned), worn: round6(r.qty_worn), lost: round6(r.qty_lost), left,
    holderType: r.holder_type,
    holder: r.holder_type === 'vendor' ? r.party_name : r.holder_type === 'person' ? r.person_name : r.holder_type === 'order' ? r.order_code : r.department_name,
    department: r.department_name ?? null, order: r.order_code ?? null, machine: r.machine_code ?? null,
    issuedOn: dateText(r.issued_on), dueOn: due, daysOut,
    // past its own due date, or (with none) out longer than the company's limit
    overdueDays: r.status !== 'open' ? 0 : due ? (due < t ? Math.round((new Date(t) - new Date(due)) / 86400000) : 0) : Math.max(0, daysOut - longDays),
    movementId: r.movement_id, movementCode: r.movement_code ?? null, status: r.status,
  };
}

/** How long a thing has been out: the three bands of the Out with screen (days since it was given; settings out_bucket_*). */
export const ageBuckets = (b1, b2) => {
  const a = Math.trunc(Number(b1)) || 30; const b = Math.max(Math.trunc(Number(b2)) || 90, a + 1);
  return { d30: `DATEDIFF(CURDATE(), c.issued_on) <= ${a}`, d90: `DATEDIFF(CURDATE(), c.issued_on) BETWEEN ${a + 1} AND ${b}`, over: `DATEDIFF(CURDATE(), c.issued_on) > ${b}`, bands: [a, b] };
};
/** Out too long: past its due date, or — with none — out longer than the company's limit (cf_company_settings.tools_out_days). */
const LONG_OUT = '((c.due_on IS NOT NULL AND c.due_on < CURDATE()) OR (c.due_on IS NULL AND DATEDIFF(CURDATE(), c.issued_on) > ?))';

/** GET /stores-desk/out-with?holder=person|department|vendor&overdue=1&age=d30|d90|over&search=&status=open|closed — and the chip counts. */
export async function outWith(db, companyId, q = {}) {
  const { toolsOutDays } = await deskSettings(db, companyId);
  const S = await getSettings(db, companyId);
  const AGE_BUCKETS = ageBuckets(S.out_bucket_1_days, S.out_bucket_2_days);
  const status = q.status === 'closed' ? 'closed' : 'open';
  const where = ['c.company_id = ?', 'c.deleted_at IS NULL', 'c.status = ?'];
  const params = [companyId, status];
  if (['person', 'department', 'vendor', 'order'].includes(q.holder)) { where.push('c.holder_type = ?'); params.push(q.holder); }
  if (q.overdue === '1' || q.overdue === 1) { where.push(LONG_OUT); params.push(toolsOutDays); }
  if (['d30', 'd90', 'over'].includes(q.age)) where.push(AGE_BUCKETS[q.age]);
  const like = likeOf(q.search);
  if (like) { where.push('(m.name LIKE ? OR pe.name LIKE ? OR dp.name LIKE ? OR pa.name LIKE ? OR so.code LIKE ?)'); params.push(like, like, like, like, like); }
  const [[rows], [chips]] = await Promise.all([
    db.query(`${CUSTODY_SELECT} WHERE ${where.join(' AND ')} ORDER BY (c.due_on IS NULL), c.due_on, c.issued_on, c.id LIMIT 500`, params),
    db.query(
      `SELECT c.holder_type AS k, COUNT(*) AS n, SUM(${LONG_OUT}) AS overdue,
              SUM(${AGE_BUCKETS.d30}) AS d30, SUM(${AGE_BUCKETS.d90}) AS d90, SUM(${AGE_BUCKETS.over}) AS over_n
         FROM cf_stock_custody c WHERE c.company_id = ? AND c.deleted_at IS NULL AND c.status = 'open' GROUP BY c.holder_type`, [toolsOutDays, companyId]),
  ]);
  const counts = { person: 0, department: 0, vendor: 0, order: 0, overdue: 0, all: 0, d30: 0, d90: 0, over: 0 };
  for (const r of chips) {
    counts[r.k] = Number(r.n); counts.all += Number(r.n); counts.overdue += Number(r.overdue) || 0;
    counts.d30 += Number(r.d30) || 0; counts.d90 += Number(r.d90) || 0; counts.over += Number(r.over_n) || 0;
  }
  return { rows: rows.map((r) => shapeCustody(r, toolsOutDays)), counts, longDays: toolsOutDays, bands: AGE_BUCKETS.bands };
}

/**
 * POST /stores-desk/out-with/:id/back { kind: 'returned' | 'worn' | 'lost', quantity?, note? }
 *   returned   it is on the shelf again: a receipt into the area it left (marked return_in), at the cost it went out at
 *   worn       handed in, used up — nothing goes back into stock
 *   lost       not coming back — nothing goes back; a note says what is known
 * quantity defaults to all that is still out.
 */
export async function custodyBack(db, c, id, input = {}) {
  const kind = CUSTODY_KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) throw invalid('INVALID', 'Say what happened: returned, worn out or lost.');
  const [[r]] = await db.query('SELECT * FROM cf_stock_custody WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(id)]);
  if (!r) throw notFound('This entry');
  const left = round6(num(r.quantity) - num(r.qty_returned) - num(r.qty_worn) - num(r.qty_lost));
  if (r.status !== 'open' || left <= 1e-9) throw invalid('CLOSED', 'Nothing of this is out any more.');
  const qty = blank(input.quantity) ? left : Number(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw invalid('INVALID', 'The quantity is a number above zero.');
  if (qty > left + 1e-9) throw invalid('TOO_MANY', `Only ${left} is still out.`);
  const note = blank(input.note) ? null : String(input.note).trim().slice(0, 255);
  if (kind === 'lost' && !note) throw invalid('REASON', 'Say what is known about the loss — the report to Management shows it.');
  // §114: how long it lasted. A tool worn out well before its life needs a word on why — maintenance reads these.
  const [[life]] = await db.query('SELECT i.*, DATEDIFF(CURDATE(), ?) AS days FROM cf_item_details i WHERE i.master_id = ?', [r.issued_on, r.item_id]);
  const daysUsed = Math.max(0, Number(life?.days) || 0);
  if (kind === 'worn' && !note && life?.life_days != null) {
    const S = await getSettings(db, c.companyId);
    if (daysUsed < (Number(life.life_days) * Number(S.maint_early_wear_pct)) / 100) {
      throw invalid('REASON', `This lasted ${daysUsed} day${daysUsed === 1 ? '' : 's'}; it should last ${life.life_days}. Say what happened — Maintenance reads it.`);
    }
  }
  let movementId = null;
  if (kind === 'returned') {
    const [[src]] = await db.query('SELECT code FROM cf_stock_movements WHERE id = ?', [r.movement_id]);
    const areaId = r.area_id ?? await mainAreaOf(db, c.companyId, r.item_id);
    const mv = await postMovement(db, c, {
      movementType: 'receipt',
      reference: `Back from ${src?.code ?? 'issue'}`.slice(0, 100),
      notes: note,
      lines: [{ itemId: r.item_id, quantity: round6(qty), toAreaId: areaId, ...(r.batch_id ? { batchId: r.batch_id } : {}), ...(r.unit_cost != null ? { unitCost: Number(r.unit_cost) } : {}) }],
    }, { given: { type: 'return_in', departmentId: r.department_id, partyId: r.party_id, personId: r.person_id, machineId: r.machine_id } });
    movementId = mv.id;
  }
  const col = { returned: 'qty_returned', worn: 'qty_worn', lost: 'qty_lost' }[kind];
  const closes = round6(left - qty) <= 1e-9;
  await db.query(`UPDATE cf_stock_custody SET ${col} = ${col} + ?, status = ?, closed_at = ${closes ? 'NOW()' : 'NULL'} WHERE company_id = ? AND id = ?`,
    [round6(qty), closes ? 'closed' : 'open', c.companyId, r.id]);
  const [ev] = await db.query('INSERT INTO cf_stock_custody_events (company_id, custody_id, kind, quantity, movement_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, r.id, kind, round6(qty), movementId, note, c.userId ?? null]);
  await db.query('UPDATE cf_stock_custody_events SET days_used = ? WHERE id = ?', [daysUsed, ev.insertId]).catch((e) => { if (e.errno !== 1054) throw e; });
  const [[fresh]] = await db.query(`${CUSTODY_SELECT} WHERE c.company_id = ? AND c.id = ?`, [c.companyId, r.id]);
  return shapeCustody(fresh);
}

// --- count ----------------------------------------------------------------------

/** The latest cost an item moved at (a lot's own when it has one): what a count difference is worth. null = not costed. */
async function costsOf(db, companyId, itemIds) {
  const out = new Map();
  if (!itemIds.length) return out;
  const [rows] = await db.query(
    `SELECT l.item_id, l.unit_cost FROM cf_stock_ledger l
       JOIN (SELECT item_id, MAX(id) AS id FROM cf_stock_ledger WHERE company_id = ? AND item_id IN (?) AND unit_cost IS NOT NULL AND deleted_at IS NULL GROUP BY item_id) x ON x.id = l.id`,
    [companyId, itemIds]);
  for (const r of rows) out.set(Number(r.item_id), Number(r.unit_cost));
  return out;
}

/**
 * GET /stores-desk/count-list?areaId=&kind=daily|weekly&subfamilyId=
 *   daily    what moved in that area since its last count (at most 40 lines, the busiest first)
 *   weekly   every item of one group that has stock there or moved in the last 90 days
 *   monthly  EVERYTHING that has stock there or moved this month (user, 2026-11-22: "monthly audit should not just be one
 *            group but everything"); ?subfamilyId= only narrows what is shown. Each line says whether it was audited this
 *            month already — the audit is saved in parts (500 lines a save) until every line is done.
 * Each line: the book quantity now (per lot for a batch-kept item).
 */
export async function countList(db, companyId, q = {}) {
  const areas = await storeAreas(db, companyId);
  const areaId = blank(q.areaId) ? areas.all.find((a) => a.purpose === 'storage')?.id ?? areas.all[0]?.id : Number(q.areaId);
  if (!areaId || !areas.all.some((a) => Number(a.id) === Number(areaId))) throw invalid('INVALID', 'Choose one of the store areas to audit.');
  const kind = q.kind === 'weekly' ? 'weekly' : q.kind === 'monthly' ? 'monthly' : 'daily';
  const monthStart = `${dateText(new Date()).slice(0, 8)}01`;
  const S = await getSettings(db, companyId);
  const [[last]] = await db.query('SELECT MAX(count_date) AS d FROM cf_stock_counts WHERE company_id = ? AND area_id = ? AND deleted_at IS NULL', [companyId, areaId]);
  const since = dateText(last?.d) ?? dateText(new Date(Date.now() - 2 * 86400000));
  let itemIds = [];
  if (kind === 'daily') {
    const [moved] = await db.query(
      `SELECT l.item_id, COUNT(*) AS n FROM cf_stock_ledger l JOIN cf_stock_movements mm ON mm.id = l.movement_id
        WHERE l.company_id = ? AND l.stocking_area_id = ? AND l.deleted_at IS NULL AND mm.movement_date >= ? AND mm.movement_type <> 'adjustment'
        GROUP BY l.item_id ORDER BY n DESC, l.item_id LIMIT ?`, [companyId, areaId, since, Number(S.count_daily_max_lines)]);
    itemIds = moved.map((r) => Number(r.item_id));
  } else if (kind === 'monthly') {
    const [all] = await db.query(
      `SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog'
         LEFT JOIN cf_classification_nodes v ON v.id = m.classification_id
        WHERE m.company_id = ? AND m.deleted_at IS NULL ${blank(q.subfamilyId) ? '' : 'AND v.parent_id = ?'}
          AND (EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.company_id = m.company_id AND k.item_id = m.id AND k.stocking_area_id = ? AND k.quantity <> 0)
            OR EXISTS (SELECT 1 FROM cf_stock_ledger l JOIN cf_stock_movements mm ON mm.id = l.movement_id
                        WHERE l.company_id = m.company_id AND l.item_id = m.id AND l.stocking_area_id = ? AND l.deleted_at IS NULL AND mm.movement_date >= ?))
        ORDER BY m.name LIMIT 5000`, [companyId, ...(blank(q.subfamilyId) ? [] : [Number(q.subfamilyId)]), areaId, areaId, monthStart]);
    itemIds = all.map((r) => Number(r.id));
  } else {
    if (blank(q.subfamilyId)) throw invalid('INVALID', 'Choose the group to audit this week.');
    const [inGroup] = await db.query(
      `SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog'
         JOIN cf_classification_nodes v ON v.id = m.classification_id
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND v.parent_id = ?
          AND (EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.company_id = m.company_id AND k.item_id = m.id AND k.stocking_area_id = ? AND k.quantity <> 0)
            OR EXISTS (SELECT 1 FROM cf_stock_ledger l WHERE l.company_id = m.company_id AND l.item_id = m.id AND l.stocking_area_id = ? AND l.created_at >= NOW() - INTERVAL ? DAY))
        ORDER BY m.name LIMIT 500`, [companyId, Number(q.subfamilyId), areaId, areaId, Number(S.count_weekly_lookback_days)]);
    itemIds = inGroup.map((r) => Number(r.id));
  }
  let lines = [];
  if (itemIds.length) {
    const [rows] = await db.query(
      `SELECT m.id, m.code, m.name, i.uom, i.tracked_by, k.batch_id, b.code AS batch_code, COALESCE(k.quantity, 0) AS q
         FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
         LEFT JOIN cf_stock_balances k ON k.company_id = m.company_id AND k.item_id = m.id AND k.stocking_area_id = ?
         LEFT JOIN cf_stock_batches b ON b.id = k.batch_id
        WHERE m.company_id = ? AND m.id IN (?) ORDER BY m.name, k.batch_id`, [areaId, companyId, itemIds]);
    lines = rows.filter((r) => r.tracked_by !== 'batch' || r.batch_id).map((r) => ({
      item: { id: r.id, code: r.code, name: r.name, uom: r.uom }, lot: r.batch_id ? { id: r.batch_id, code: r.batch_code } : null, book: round6(r.q),
    }));
  }
  let month = null;
  if (kind === 'monthly') {
    // what this month's audits already covered in this area (a line a lot)
    const [done] = await db.query(
      `SELECT DISTINCT cl.item_id, IFNULL(cl.batch_id, 0) AS b FROM cf_stock_count_lines cl JOIN cf_stock_counts n ON n.id = cl.count_id
        WHERE cl.company_id = ? AND n.area_id = ? AND n.deleted_at IS NULL AND n.status <> 'rejected' AND n.count_date >= ?`, [companyId, areaId, monthStart]);
    const seen = new Set(done.map((d) => `${d.item_id}:${d.b}`));
    for (const l of lines) l.audited = seen.has(`${l.item.id}:${l.lot?.id ?? 0}`);
    let total = lines.length; let audited = lines.filter((l) => l.audited).length;
    if (!blank(q.subfamilyId)) {   // the progress is of everything, whatever is shown
      const whole = await countList(db, companyId, { areaId, kind: 'monthly' });
      total = whole.month.total; audited = whole.month.audited;
    }
    month = { from: monthStart, total, audited, done: total > 0 && audited >= total };
  }
  return { area: areas.all.find((a) => Number(a.id) === Number(areaId)), areas: areas.all, kind, since, lines, lastCount: dateText(last?.d), ...(month ? { month } : {}) };
}

/** The adjustment a count's differences become: signed changes, one movement. */
async function postCountAdjustment(db, c, count, lines) {
  const mv = await postMovement(db, c, {
    movementType: 'adjustment',
    reason: `Audit ${count.code}`.slice(0, 255),
    areaId: count.area_id,
    lines: lines.map((l) => ({ itemId: l.item_id, quantity: Number(l.diff), ...(l.batch_id ? { batchId: l.batch_id } : {}), notes: l.reason ?? null })),
  });
  return mv.id;
}

/**
 * POST /stores-desk/counts { areaId, kind?, note?, lines: [{ itemId, lotId?, counted, reason? }] }
 * Book is read now, under a lock. No difference → matched. A difference needs its reason. Small ones (every differing line
 * costed and together within the company's limit; an uncosted line by one unit or a tenth of the book) post at once;
 * the rest wait for an approval — the book stays as it is until then.
 */
export async function postCount(db, c, input = {}) {
  const problems = [];
  const areas = await storeAreas(db, c.companyId);
  const area = areas.all.find((a) => Number(a.id) === Number(input.areaId));
  if (!area) problems.push('Choose one of the store areas.');
  const kind = COUNT_KINDS.includes(input.kind) ? input.kind : 'daily';
  const asked = Array.isArray(input.lines) ? input.lines.filter((l) => !blank(l?.counted)) : [];
  if (!asked.length) problems.push('Type what is on the shelf for at least one item.');
  if (asked.length > 500) problems.push('Up to 500 lines an audit.');
  assertNoProblems(problems, 'The audit cannot be saved.');

  const costs = await costsOf(db, c.companyId, [...new Set(asked.map((l) => Number(l.itemId)))]);
  const lines = [];
  for (const [n, l] of asked.entries()) {
    const counted = Number(l.counted);
    if (!Number.isFinite(counted) || counted < 0) { problems.push(`Line ${n + 1}: the quantity on the shelf is a number, zero or more.`); continue; }
    const lotId = blank(l.lotId) ? null : Number(l.lotId);
    const [[k]] = await db.query('SELECT quantity FROM cf_stock_balances WHERE company_id = ? AND stocking_area_id = ? AND item_id = ? AND batch_key = ? FOR UPDATE',
      [c.companyId, area.id, Number(l.itemId), lotId ?? 0]);
    const book = k ? Number(k.quantity) : 0;
    const diff = round6(counted - book);
    const reason = blank(l.reason) ? null : String(l.reason).trim().slice(0, 255);
    if (Math.abs(diff) > 1e-9 && !reason) problems.push(`Line ${n + 1}: say why the audit differs from the book.`);
    lines.push({ item_id: Number(l.itemId), batch_id: lotId, book, counted: round6(counted), diff, cost: costs.get(Number(l.itemId)) ?? null, reason });
  }
  assertNoProblems(problems, 'The audit cannot be saved.');

  const diffs = lines.filter((l) => Math.abs(l.diff) > 1e-9);
  const { countAutoLimit } = await deskSettings(db, c.companyId);
  const value = diffs.every((l) => l.cost != null) ? round2(diffs.reduce((t, l) => t + Math.abs(l.diff) * l.cost, 0)) : null;
  const costedValue = round2(diffs.filter((l) => l.cost != null).reduce((t, l) => t + Math.abs(l.diff) * l.cost, 0));
  const uncostedBig = diffs.some((l) => l.cost == null && Math.abs(l.diff) > Math.max(1, 0.1 * l.book));
  const small = costedValue <= countAutoLimit && !uncostedBig;
  const status = !diffs.length ? 'matched' : small ? 'posted' : 'pending';
  const note = blank(input.note) ? null : String(input.note).trim().slice(0, 500);
  const [ins] = await db.query(
    'INSERT INTO cf_stock_counts (company_id, kind, area_id, count_date, status, lines_n, diff_n, diff_value, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, kind, area.id, today(), status, lines.length, diffs.length, value, note, c.userId ?? null]);
  const count = { id: ins.insertId, code: `CNT-${String(ins.insertId).padStart(6, '0')}`, area_id: area.id };
  await db.query('UPDATE cf_stock_counts SET code = ? WHERE id = ?', [count.code, count.id]);
  for (let i = 0; i < lines.length; i += 200) {
    const part = lines.slice(i, i + 200);
    await db.query(
      `INSERT INTO cf_stock_count_lines (company_id, count_id, item_id, batch_id, book_qty, counted_qty, diff, unit_cost, reason) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      part.flatMap((l) => [c.companyId, count.id, l.item_id, l.batch_id, l.book, l.counted, l.diff, l.cost, l.reason]));
  }
  if (status === 'posted') {
    const movementId = await postCountAdjustment(db, c, count, diffs);
    await db.query('UPDATE cf_stock_counts SET movement_id = ? WHERE id = ?', [movementId, count.id]);
  } else if (status === 'pending') {
    const approvalId = await requestApproval(db, c, {
      type: 'stock_count', subjectId: count.id, subjectCode: count.code,
      title: `Stock audit ${count.code}: ${diffs.length} item${diffs.length === 1 ? '' : 's'} differ in ${area.name}`,
      summary: diffs.slice(0, 4).map((l) => `${l.diff > 0 ? '+' : ''}${l.diff}`).join(', ') + (value != null ? ` · ₹${value.toLocaleString('en-IN')}` : ' · some items have no cost yet'),
      amount: value, note,
    });
    await db.query('UPDATE cf_stock_counts SET approval_id = ? WHERE id = ?', [approvalId, count.id]);
  }
  return getCount(db, c.companyId, count.id);
}

export async function getCount(db, companyId, id) {
  const [[h]] = await db.query(
    `SELECT n.*, a.name AS area_name, u.name AS by_name FROM cf_stock_counts n JOIN cf_stocking_areas a ON a.id = n.area_id LEFT JOIN users u ON u.id = n.created_by
      WHERE n.company_id = ? AND n.id = ? AND n.deleted_at IS NULL`, [companyId, Number(id)]);
  if (!h) throw notFound('Audit');
  const [lines] = await db.query(
    `SELECT l.*, m.code AS item_code, m.name AS item_name, i.uom, b.code AS batch_code FROM cf_stock_count_lines l
       JOIN cf_master_records m ON m.id = l.item_id JOIN cf_item_details i ON i.master_id = l.item_id LEFT JOIN cf_stock_batches b ON b.id = l.batch_id
      WHERE l.company_id = ? AND l.count_id = ? ORDER BY (ABS(l.diff) > 0) DESC, m.name`, [companyId, h.id]);
  return {
    ...shapeCount(h),
    lines: lines.map((l) => ({
      item: { id: l.item_id, code: l.item_code, name: l.item_name, uom: l.uom }, lot: l.batch_id ? { id: l.batch_id, code: l.batch_code } : null,
      book: round6(l.book_qty), counted: round6(l.counted_qty), diff: round6(l.diff), reason: l.reason ?? null,
      value: l.unit_cost == null ? null : round2(Math.abs(Number(l.diff)) * Number(l.unit_cost)),
    })),
  };
}
const shapeCount = (h) => ({
  id: h.id, code: h.code, kind: h.kind, area: { id: h.area_id, name: h.area_name }, date: dateText(h.count_date), status: h.status,
  lines: Number(h.lines_n), differences: Number(h.diff_n), value: h.diff_value == null ? null : Number(h.diff_value), note: h.note ?? null,
  movementId: h.movement_id ?? null, approvalId: h.approval_id ?? null, by: h.by_name ?? null,
});

/** GET /stores-desk/counts — the last 60 counts, newest first. */
export async function listCounts(db, companyId) {
  const [rows] = await db.query(
    `SELECT n.*, a.name AS area_name, u.name AS by_name FROM cf_stock_counts n JOIN cf_stocking_areas a ON a.id = n.area_id LEFT JOIN users u ON u.id = n.created_by
      WHERE n.company_id = ? AND n.deleted_at IS NULL ORDER BY n.id DESC LIMIT 60`, [companyId]);
  return rows.map(shapeCount);
}

/** Management's decision on a count that differed by more than the limit (approvalService HANDLERS.stock_count). */
export const stockCountApprovalHandler = {
  async onApprove(db, c, row) {
    const [[n]] = await db.query('SELECT * FROM cf_stock_counts WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, row.subject_id]);
    if (!n || n.status !== 'pending') throw invalid('NOT_PENDING', 'This audit is not waiting for a decision.');
    const [lines] = await db.query('SELECT item_id, batch_id, diff, reason FROM cf_stock_count_lines WHERE company_id = ? AND count_id = ? AND ABS(diff) > 0.0000001', [c.companyId, n.id]);
    const movementId = await postCountAdjustment(db, c, n, lines);
    await db.query("UPDATE cf_stock_counts SET status = 'posted', movement_id = ?, decided_by = ?, decided_at = NOW() WHERE id = ?", [movementId, c.userId ?? null, n.id]);
    return { posted: true, movementId };
  },
  async onReject(db, c, row, note) {
    await db.query("UPDATE cf_stock_counts SET status = 'rejected', note = ?, decided_by = ?, decided_at = NOW() WHERE company_id = ? AND id = ? AND status = 'pending'",
      [note ? `Sent back: ${String(note).slice(0, 480)}` : null, c.userId ?? null, c.companyId, row.subject_id]);
    return { rejected: true };
  },
  async onWithdraw(db, c, row) {
    await db.query("UPDATE cf_stock_counts SET status = 'rejected' WHERE company_id = ? AND id = ? AND status = 'pending'", [c.companyId, row.subject_id]);
  },
};
