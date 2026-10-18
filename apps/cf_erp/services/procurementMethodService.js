/**
 * procurementMethodService.js — HOW EACH ITEM IS PROCURED, and Stores' "TO REORDER" list (init.sql §79, user 2026-10-18;
 * contract TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — Stores chain").
 *
 * Every catalog item AND every DEFINITION may say how it is procured (cf_procurement_settings, one row per master record):
 *   make                made in-house (cut pieces, assemblies)
 *   buy_on_requirement  bought when an order / MR needs it — never on the reorder list
 *   buy_min_max         free stock below MIN → suggest up to MAX
 *   buy_periodic        every PERIOD_DAYS → suggest what was used since the period began
 *   customer_supplies   the customer sends it
 *   subcontract         made outside on a contractor PO
 * plus lead time (days), order multiple, minimum order quantity and preferred vendors.
 *
 * INHERITANCE. A temporary (order-specific) item takes its DEFINITION's settings (source_definition_id) unless it has a
 * method of its own ("a temporary item may override it"). With nothing set anywhere the DEFAULT applies: a template
 * definition (cut pieces, assemblies) and an item made in-house (sourcing 'make') = make; a selection definition (picks a
 * bought-out) and a bought item = buy on requirement. A row whose method is NULL is "not set here" (the whole set is
 * inherited — the fields travel with the method that owns them).
 *
 * THE REORDER ENGINE ("by AI" on screen — an algorithm's suggestion, a person ticks the rows). Catalog items only:
 *   buy_min_max   position = free stock (availability's rule: usable areas less every reservation) + what is already
 *                 coming for stock (stock MRs' lines not yet received). position < min → suggest max − position.
 *   buy_periodic  due when today ≥ the period's start + period_days: suggest what was ISSUED (net of reversals) since the
 *                 period began, less what is already coming for stock. Raising an MR for it starts the next period.
 *   Every suggestion is raised to the minimum order quantity, then up to a whole order multiple.
 *   Make, on-requirement, customer-supplied and subcontracted items never appear.
 * Ticked rows → ONE MR for stock (requisitionService.createRequisition, for_type 'stock') → saved at once with nothing taken
 * from stock → its PR (purchaseRequestService.saveMr). Fixed round trips: the list = 4 reads (settings, availability ×2,
 * pipeline, issues); raising = createRequisition (≤ 5) + saveMr + 1.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { availability } from './rollOutService.js';
import { today as clockToday } from './materialReadyService.js';
import { createRequisition } from './requisitionService.js';
import { saveMr, mrScreen } from './purchaseRequestService.js';

export const METHODS = ['make', 'buy_on_requirement', 'buy_min_max', 'buy_periodic', 'customer_supplies', 'subcontract'];
export const METHOD_LABEL = {
  make: 'Make (in-house)', buy_on_requirement: 'Buy on requirement', buy_min_max: 'Buy to min / max',
  buy_periodic: 'Buy periodically', customer_supplies: 'Customer supplies', subcontract: 'Subcontract',
};
const REORDERED = ['buy_min_max', 'buy_periodic'];

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const fmt = (n) => String(Number(Number(n).toFixed(3)));
const numOrNull = (v) => (v == null ? null : Number(v));
const dateText = (d) => (d == null ? null : d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).slice(0, 10));
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const vendorIdsOf = (text) => (blank(text) ? [] : String(text).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0));

/** The default when nothing is set: made things are made, bought things are bought on requirement. */
export function defaultMethod(row) {
  if (row.record_kind === 'definition') return row.definition_type === 'template' ? 'make' : 'buy_on_requirement';
  return row.sourcing === 'make' ? 'make' : 'buy_on_requirement';
}

/** A settings row → its fields (null when the row is absent or has no method). */
function settingsOf(r) {
  if (!r || r.method == null) return null;
  return {
    method: r.method, methodLabel: METHOD_LABEL[r.method],
    minQty: numOrNull(r.min_qty), maxQty: numOrNull(r.max_qty), periodDays: numOrNull(r.period_days), periodicFrom: dateText(r.periodic_from),
    leadTimeDays: numOrNull(r.lead_time_days), orderMultiple: numOrNull(r.order_multiple), minOrderQty: numOrNull(r.min_order_qty),
    preferredVendorIds: vendorIdsOf(r.preferred_vendor_ids),
  };
}
const bare = (method) => ({
  method, methodLabel: METHOD_LABEL[method], minQty: null, maxQty: null, periodDays: null, periodicFrom: null,
  leadTimeDays: null, orderMultiple: null, minOrderQty: null, preferredVendorIds: [],
});

const SUBJECT_SQL = `SELECT m.id, m.code, m.name, m.record_kind, i.item_type, i.sourcing, i.source_definition_id, d.definition_type,
            sd.code AS def_code, sd.name AS def_name, sdd.definition_type AS def_type,
            own.method, own.min_qty, own.max_qty, own.period_days, own.periodic_from, own.lead_time_days, own.order_multiple, own.min_order_qty, own.preferred_vendor_ids,
            inh.method AS i_method, inh.min_qty AS i_min_qty, inh.max_qty AS i_max_qty, inh.period_days AS i_period_days, inh.periodic_from AS i_periodic_from,
            inh.lead_time_days AS i_lead_time_days, inh.order_multiple AS i_order_multiple, inh.min_order_qty AS i_min_order_qty, inh.preferred_vendor_ids AS i_preferred_vendor_ids
       FROM cf_master_records m
       LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
       LEFT JOIN cf_master_records sd ON sd.id = i.source_definition_id
       LEFT JOIN cf_definition_details sdd ON sdd.master_id = i.source_definition_id AND sdd.deleted_at IS NULL
       LEFT JOIN cf_procurement_settings own ON own.company_id = m.company_id AND own.master_id = m.id
       LEFT JOIN cf_procurement_settings inh ON inh.company_id = m.company_id AND inh.master_id = i.source_definition_id`;

/** One subject row → { own, inherited, effective, source }. */
function resolve(r) {
  const own = settingsOf(r);
  const fromDef = r.source_definition_id != null;
  const inheritedSettings = fromDef
    ? settingsOf({
      method: r.i_method, min_qty: r.i_min_qty, max_qty: r.i_max_qty, period_days: r.i_period_days, periodic_from: r.i_periodic_from,
      lead_time_days: r.i_lead_time_days, order_multiple: r.i_order_multiple, min_order_qty: r.i_min_order_qty, preferred_vendor_ids: r.i_preferred_vendor_ids,
    }) ?? bare(r.def_type === 'template' ? 'make' : 'buy_on_requirement')
    : null;
  const fallback = bare(defaultMethod(r));
  const effective = own ?? inheritedSettings ?? fallback;
  const source = own ? 'own' : inheritedSettings ? 'definition' : 'default';
  return {
    own,
    inherited: fromDef ? { from: { id: r.source_definition_id, code: r.def_code, name: r.def_name }, settings: inheritedSettings } : null,
    effective, source,
    defaultMethod: fallback.method,
  };
}

/**
 * The effective method of many items / definitions at once: Map masterId -> { method, …, source }. 1 read.
 * For the planner, the MR and the buy list — what "how is it procured" answers.
 */
export async function effectiveMethods(db, companyId, masterIds) {
  const out = new Map();
  if (!masterIds.length) return out;
  const [rows] = await db.query(`${SUBJECT_SQL} WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`, [companyId, masterIds]);
  for (const r of rows) { const x = resolve(r); out.set(Number(r.id), { ...x.effective, source: x.source }); }
  return out;
}

/** GET /procurement/:masterId — the Procurement card of an item or a definition. 2 reads. */
export async function readProcurement(db, companyId, masterId) {
  const [[r]] = await db.query(`${SUBJECT_SQL} WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL`, [companyId, Number(masterId)]);
  if (!r) throw notFound('Item or definition');
  const x = resolve(r);
  const ids = [...new Set([...(x.own?.preferredVendorIds ?? []), ...(x.inherited?.settings?.preferredVendorIds ?? [])])];
  const [vendors] = ids.length ? await db.query('SELECT id, code, name FROM cf_parties WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [companyId, ids]) : [[]];
  const named = (list) => list.map((id) => vendors.find((v) => Number(v.id) === id)).filter(Boolean).map((v) => ({ id: v.id, code: v.code, name: v.name }));
  const kind = r.record_kind === 'definition' ? 'definition' : 'item';
  return {
    subject: { id: r.id, code: r.code, name: r.name, kind, itemType: r.item_type ?? null, definitionType: r.definition_type ?? null },
    methods: METHODS.map((key) => ({ key, label: METHOD_LABEL[key] })),
    own: x.own ? { ...x.own, preferredVendors: named(x.own.preferredVendorIds) } : null,
    inherited: x.inherited ? { from: x.inherited.from, settings: x.inherited.settings ? { ...x.inherited.settings, preferredVendors: named(x.inherited.settings.preferredVendorIds) } : null } : null,
    effective: { ...x.effective, preferredVendors: named(x.effective.preferredVendorIds) },
    source: x.source,
    defaultMethod: x.defaultMethod,
    // Words for the card: where the method comes from.
    sourceWords: x.source === 'own' ? 'Set here.'
      : x.source === 'definition' ? `From its definition ${x.inherited.from.code ?? x.inherited.from.name}.`
        : `Default — ${METHOD_LABEL[x.defaultMethod].toLowerCase()}.`,
  };
}

/**
 * PUT /procurement/:masterId { method | null, minQty?, maxQty?, periodDays?, leadTimeDays?, orderMultiple?, minOrderQty?,
 * preferredVendorIds? } — method null (or '') clears the row: the item inherits / takes the default again. Every
 * problem at once. ≤ 3 reads + 1 write.
 */
export async function setProcurement(db, c, masterId, input = {}) {
  const [[m]] = await db.query('SELECT id, code, record_kind FROM cf_master_records WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(masterId)]);
  if (!m) throw notFound('Item or definition');
  const method = blank(input.method) ? null : String(input.method);
  if (method == null) {
    await db.query('DELETE FROM cf_procurement_settings WHERE company_id = ? AND master_id = ?', [c.companyId, m.id]);
    return readProcurement(db, c.companyId, m.id);
  }
  const problems = [];
  if (!METHODS.includes(method)) problems.push(`The method is one of: ${METHODS.map((k) => METHOD_LABEL[k]).join(', ')}.`);
  const num = (key, label, { int = false, min = 0, required = false } = {}) => {
    const v = input[key];
    if (blank(v)) { if (required) problems.push(`${label} is needed for "${METHOD_LABEL[method]}".`); return null; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) { problems.push(`${label} is a ${int ? 'whole ' : ''}number${min > 0 ? ` of at least ${min}` : ', zero or more'}.`); return null; }
    return n;
  };
  const minQty = num('minQty', 'Minimum stock', { required: method === 'buy_min_max' });
  const maxQty = num('maxQty', 'Maximum stock', { required: method === 'buy_min_max' });
  const periodDays = num('periodDays', 'Every N days', { int: true, min: 1, required: method === 'buy_periodic' });
  const leadTimeDays = num('leadTimeDays', 'Lead time (days)', { int: true });
  const orderMultiple = num('orderMultiple', 'Order multiple');
  const minOrderQty = num('minOrderQty', 'Minimum order quantity');
  if (method === 'buy_min_max' && minQty != null && maxQty != null && maxQty <= minQty) problems.push('Maximum stock is above the minimum.');
  if (orderMultiple != null && orderMultiple <= 0) problems.push('The order multiple is above zero (leave it blank for none).');
  const vendorIds = [...new Set((Array.isArray(input.preferredVendorIds) ? input.preferredVendorIds : []).map(Number))];
  if (vendorIds.some((v) => !Number.isInteger(v) || v <= 0)) problems.push('A preferred vendor is not valid.');
  if (vendorIds.length > 10) problems.push('At most 10 preferred vendors.');
  if (vendorIds.length && !problems.length) {
    const [vs] = await db.query('SELECT id, name, is_supplier FROM cf_parties WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, vendorIds]);
    for (const id of vendorIds) {
      const v = vs.find((x) => Number(x.id) === id);
      if (!v) problems.push(`Vendor ${id} does not exist.`);
      else if (!Number(v.is_supplier)) problems.push(`${v.name} is not marked as a supplier.`);
    }
  }
  assertNoProblems(problems, 'How it is procured cannot be saved.');
  // A periodic item counts from today when it becomes periodic (an existing period keeps its start).
  const start = method === 'buy_periodic' ? clockToday() : null;
  await db.query(
    `INSERT INTO cf_procurement_settings (company_id, master_id, method, min_qty, max_qty, period_days, periodic_from, lead_time_days, order_multiple, min_order_qty, preferred_vendor_ids, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE periodic_from = IF(VALUES(method) = 'buy_periodic', IF(method = 'buy_periodic', COALESCE(periodic_from, VALUES(periodic_from)), VALUES(periodic_from)), NULL),
       method = VALUES(method), min_qty = VALUES(min_qty), max_qty = VALUES(max_qty), period_days = VALUES(period_days),
       lead_time_days = VALUES(lead_time_days), order_multiple = VALUES(order_multiple), min_order_qty = VALUES(min_order_qty),
       preferred_vendor_ids = VALUES(preferred_vendor_ids), updated_by = VALUES(updated_by)`,
    [c.companyId, m.id, method, method === 'buy_min_max' ? minQty : null, method === 'buy_min_max' ? maxQty : null, method === 'buy_periodic' ? periodDays : null, start,
      leadTimeDays, orderMultiple, minOrderQty, vendorIds.length ? vendorIds.join(',') : null, c.userId ?? null],
  );
  return readProcurement(db, c.companyId, m.id);
}

/** Rounds a suggestion up to the minimum order quantity, then to a whole order multiple. */
export function roundOrder(q, { minOrderQty = null, orderMultiple = null } = {}) {
  let x = round6(Math.max(0, q));
  if (x <= EPS) return 0;
  if (minOrderQty != null && x < minOrderQty) x = minOrderQty;
  if (orderMultiple != null && orderMultiple > EPS) x = round6(Math.ceil(round6(x / orderMultiple) - 1e-9) * orderMultiple);
  return round6(x);
}

/**
 * GET /stores/reorder?search= — Stores' "To reorder" list (by AI): one row per catalog item bought to min / max or
 * periodically that needs buying now. → { today, rows: [{ item, method, methodLabel, free, coming, min, max, periodDays,
 * periodFrom, used, suggest, why, leadTimeDays, preferredVendors }], counts }. 4–5 reads whatever the number of items.
 */
export async function reorderSuggestions(db, companyId, q = {}) {
  const todayText = clockToday();
  const like = blank(q.search) ? null : `%${String(q.search).trim()}%`;
  const [items] = await db.query(
    `SELECT ps.master_id AS item_id, ps.method, ps.min_qty, ps.max_qty, ps.period_days, ps.periodic_from, ps.lead_time_days, ps.order_multiple, ps.min_order_qty,
            ps.preferred_vendor_ids, DATE(ps.created_at) AS since, m.code, m.name, i.uom, i.tracked_by
       FROM cf_procurement_settings ps
       JOIN cf_master_records m ON m.id = ps.master_id AND m.deleted_at IS NULL AND m.status <> 'obsolete'
       JOIN cf_item_details i ON i.master_id = ps.master_id AND i.deleted_at IS NULL AND i.item_type = 'catalog'
      WHERE ps.company_id = ? AND ps.method IN (?)${like ? ' AND (m.code LIKE ? OR m.name LIKE ?)' : ''}
      ORDER BY m.code, m.id`,
    like ? [companyId, REORDERED, like, like] : [companyId, REORDERED],
  );
  if (!items.length) return { today: todayText, rows: [], counts: { all: 0, buy_min_max: 0, buy_periodic: 0 } };
  const ids = items.map((r) => Number(r.item_id));
  const [av, [coming], [used]] = await Promise.all([
    availability(db, companyId, ids),
    // What is already coming FOR STOCK: each stock MR line's quantity less what has arrived on its POs.
    db.query(
      `SELECT rl.item_id, SUM(GREATEST(rl.quantity - COALESCE(rc.received, 0), 0)) AS q
         FROM cf_requisition_lines rl
         JOIN cf_requisitions r ON r.id = rl.requisition_id AND r.deleted_at IS NULL AND r.for_type = 'stock' AND r.order_line_id IS NULL
         LEFT JOIN (SELECT a.pr_line_id, SUM(a.qty_received) AS received FROM cf_purchase_line_orders a
                     JOIN cf_requisition_lines x ON x.id = a.pr_line_id AND x.company_id = ? AND x.item_id IN (?)
                    WHERE a.company_id = ? AND a.deleted_at IS NULL GROUP BY a.pr_line_id) rc ON rc.pr_line_id = rl.id
        WHERE rl.company_id = ? AND rl.item_id IN (?) AND rl.deleted_at IS NULL
        GROUP BY rl.item_id`,
      [companyId, ids, companyId, companyId, ids],
    ),
    // What was ISSUED (net of reversals) since each periodic item's period began.
    db.query(
      `SELECT l.item_id, -SUM(l.quantity) AS q
         FROM cf_stock_ledger l
         JOIN cf_stock_movements mv ON mv.id = l.movement_id AND mv.deleted_at IS NULL AND mv.movement_type = 'issue'
         JOIN cf_procurement_settings ps ON ps.company_id = l.company_id AND ps.master_id = l.item_id AND ps.method = 'buy_periodic'
        WHERE l.company_id = ? AND l.item_id IN (?) AND l.deleted_at IS NULL
          AND mv.movement_date >= COALESCE(ps.periodic_from, DATE(ps.created_at))
        GROUP BY l.item_id`,
      [companyId, ids],
    ),
  ]);
  const comingOf = new Map(coming.map((r) => [Number(r.item_id), round6(r.q)]));
  const usedOf = new Map(used.map((r) => [Number(r.item_id), round6(Math.max(0, Number(r.q)))]));
  const vendorIds = [...new Set(items.flatMap((r) => vendorIdsOf(r.preferred_vendor_ids)))];
  const [vendors] = vendorIds.length ? await db.query('SELECT id, name FROM cf_parties WHERE company_id = ? AND id IN (?)', [companyId, vendorIds]) : [[]];
  const rows = [];
  for (const r of items) {
    const id = Number(r.item_id);
    const free = round6(av.get(id)?.free ?? 0);
    const inbound = comingOf.get(id) ?? 0;
    const u = r.uom ? ` ${r.uom}` : '';
    const rounding = { minOrderQty: numOrNull(r.min_order_qty), orderMultiple: numOrNull(r.order_multiple) };
    let suggest = 0;
    let why = null;
    let used2 = null;
    let from = null;
    let dueOn = null;
    if (r.method === 'buy_min_max') {
      const min = Number(r.min_qty ?? 0);
      const max = Number(r.max_qty ?? 0);
      const position = round6(free + inbound);
      if (position + EPS >= min) continue;
      suggest = roundOrder(max - position, rounding);
      why = `${fmt(free)}${u} free${inbound > EPS ? ` + ${fmt(inbound)} coming` : ''} is below the minimum ${fmt(min)} — up to the maximum ${fmt(max)}.`;
    } else {
      from = dateText(r.periodic_from) ?? dateText(r.since);
      dueOn = addDays(from, Number(r.period_days ?? 0));
      if (dueOn > todayText) continue;
      used2 = usedOf.get(id) ?? 0;
      const need = round6(used2 - inbound);
      if (need <= EPS) continue;
      suggest = roundOrder(need, rounding);
      why = `Every ${Number(r.period_days)} days: ${fmt(used2)}${u} used since ${from}${inbound > EPS ? `, ${fmt(inbound)} already coming` : ''}.`;
    }
    if (suggest <= EPS) continue;
    rows.push({
      item: { id, code: r.code, name: r.name, uom: r.uom ?? null, trackedBy: r.tracked_by ?? null },
      method: r.method, methodLabel: METHOD_LABEL[r.method],
      free, coming: inbound, min: numOrNull(r.min_qty), max: numOrNull(r.max_qty),
      periodDays: numOrNull(r.period_days), periodFrom: from, dueOn, used: used2,
      suggest, why,
      leadTimeDays: numOrNull(r.lead_time_days), minOrderQty: rounding.minOrderQty, orderMultiple: rounding.orderMultiple,
      preferredVendors: vendorIdsOf(r.preferred_vendor_ids).map((v) => vendors.find((x) => Number(x.id) === v)).filter(Boolean).map((v) => ({ id: v.id, name: v.name })),
    });
  }
  return {
    today: todayText, rows,
    counts: { all: rows.length, buy_min_max: rows.filter((x) => x.method === 'buy_min_max').length, buy_periodic: rows.filter((x) => x.method === 'buy_periodic').length },
  };
}

/**
 * POST /stores/reorder/raise { rows: [{ itemId, qty }], note? } — the ticked rows become ONE MR for stock, saved at once
 * (nothing taken from stock — it refills it) → its PR. A periodic item's next period starts today.
 * → { requisition: { id, code }, materialRequest (the MR screen), purchaseRequest }.
 */
export async function raiseReorder(db, c, input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (!rows.length) throw invalid('INVALID', 'Tick at least one row to reorder.');
  const lines = rows.map((r) => ({ itemId: r?.itemId, qty: r?.qty ?? r?.quantity, uom: r?.uom }));
  const note = blank(input.note) ? 'Reorder (by AI) — Stores › To reorder.' : String(input.note);
  const made = await createRequisition(db, c, { forType: 'stock', note, lines });
  const screen = await mrScreen(db, c.companyId, made.id);
  const saved = await saveMr(db, c, made.id, { lines: screen.lines.map((l) => ({ lineId: l.id, takeFromStock: 0 })) });
  const itemIds = [...new Set(lines.map((l) => Number(l.itemId)))];
  await db.query("UPDATE cf_procurement_settings SET periodic_from = ? WHERE company_id = ? AND master_id IN (?) AND method = 'buy_periodic'", [clockToday(), c.companyId, itemIds]);
  return { requisition: made, materialRequest: saved, purchaseRequest: saved.purchaseRequest };
}
