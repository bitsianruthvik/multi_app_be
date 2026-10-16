/**
 * cutAllowanceService.js — CUTTING ALLOWANCE by BOM part name (init.sql §64, TM/s64.sql, 2026-10-16).
 *
 * User, 2026-10-16: customers cut flanges and webs a little long (+10–15 mm) so welding shrinkage and end
 * trimming can be absorbed — ProNest files from NECL show flanges 12–15 mm and webs 4–10 mm longer than drawn.
 * An option per customer.
 *
 * WHAT A RULE IS. mm added at EACH end of the length (× 2 ends), plus optional mm for every metre of the drawn
 * length. Length only; the width never changes. extra = 2 × perEnd + perMetre × drawn ÷ 1000, to 0.1 mm.
 *
 * WHO IT APPLIES TO. Chosen by the BOM PART NAME: the template definition a row comes from ("Top flange",
 * "Web plate") — not the PART_FUNCTION spec. Three levels, the most specific wins whole:
 *     row      one row of an order (the line's temporary item)
 *     order    one part name on one order
 *     customer one part name for every order of the customer
 * A rule of 0 / 0 is a rule too ("none here"): it beats the level above. No rule anywhere = no allowance.
 *
 * WHAT IT CHANGES. Only the CUT PIECE (cutPlateService): a plate part is pooled and its cut piece made at
 * drawn + extra, so the cut piece's LENGTH, code, weight and the plate it is cut from follow — nesting and the
 * plate bought use the longer size. The row's own LENGTH and the order weight stay as drawn.
 *
 * LOCK. A locked (or released, or closed) line keeps its cut pieces: cutPlateService applies rules to OPEN
 * lines only. A change made after lock reaches the line through a revision (revisionService copies the order's
 * and its rows' rules onto the new revision, whose cut pieces are derived again). Before lock, every change here
 * re-derives the line's cut pieces (refreshCutPieces) in the same transaction.
 *
 * Reads are a fixed number of round trips; writes are one statement each. Every row carries company_id; a rule
 * is removed by deleted_at.
 */
import { invalid, notFound } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { cutFromOf } from '../lib/cutFrom.js';
import { LOCKED_ORDER_STATUSES, latestRevisionSql, revisedOrderMessage } from './records.js';

export const MAX_PER_END_MM = 200;
export const MAX_PER_METRE_MM = 20;
export const SCOPES = ['customer', 'order', 'row'];

const r1 = (n) => Math.round(Number(n) * 10) / 10;
const r6 = (n) => Number(Number(n).toFixed(6));
const mm = (n) => `${Number.isInteger(r1(n)) ? r1(n) : r1(n).toFixed(1)} mm`;
const plain = (n) => String(r1(n));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The extra length a rule gives a part of this drawn length, to 0.1 mm. */
export function extraMmOf(rule, drawnLength) {
  if (!rule) return 0;
  const L = Number(drawnLength);
  const e = 2 * (Number(rule.perEndMm) || 0) + (Number(rule.perMetreMm) || 0) * (L > 0 ? L / 1000 : 0);
  return r1(e);
}

/** "7.5 mm at each end", "7.5 mm at each end + 1 mm a metre", "none". */
export function ruleWords(rule) {
  if (!rule) return 'none';
  const bits = [];
  if (Number(rule.perEndMm)) bits.push(`${mm(rule.perEndMm)} at each end`);
  if (Number(rule.perMetreMm)) bits.push(`${mm(rule.perMetreMm)} a metre`);
  return bits.length ? bits.join(' + ') : 'none';
}

/** A worked example on one drawn length: { drawnLength, cutLength, extraMm, words: "11940 → 11955 mm (+15 mm)" }. */
export function exampleOf(rule, drawnLength) {
  const L = Number(drawnLength);
  if (!(L > 0)) return null;
  const extraMm = extraMmOf(rule, L);
  const cutLength = r1(L + extraMm);
  return { drawnLength: r1(L), cutLength, extraMm, words: extraMm ? `${plain(L)} → ${plain(cutLength)} mm (+${mm(extraMm)})` : `${plain(L)} mm, cut as drawn` };
}

const ruleOfRow = (r) => ({
  id: Number(r.id), scope: r.scope, perEndMm: r6(r.per_end_mm), perMetreMm: r6(r.per_metre_mm),
  customerId: r.customer_id != null ? Number(r.customer_id) : null, orderId: r.order_id != null ? Number(r.order_id) : null,
  definitionId: r.definition_id != null ? Number(r.definition_id) : null, partId: r.part_id != null ? Number(r.part_id) : null,
});
const shown = (rule) => (rule ? { id: rule.id, scope: rule.scope, perEndMm: rule.perEndMm, perMetreMm: rule.perMetreMm, words: ruleWords(rule) } : null);

/**
 * Every rule that can reach a line of this order: the order's own (part names and rows) and its customer's.
 * One query.
 */
export async function rulesOf(db, companyId, { orderId, customerId }) {
  const [rows] = await db.query(
    `SELECT id, scope, customer_id, order_id, definition_id, part_id, per_end_mm, per_metre_mm
       FROM cf_cut_allowances
      WHERE company_id = ? AND deleted_at IS NULL AND (order_id = ? OR (scope = 'customer' AND customer_id = ?))`,
    [companyId, orderId ?? 0, customerId ?? 0],
  );
  return rows.map(ruleOfRow);
}

/** The levels for one row: { row, order, customer, effective } — effective is the most specific (null = none). */
export function levelsFor(rules, { partId, definitionId }) {
  const row = rules.find((r) => r.scope === 'row' && r.partId === Number(partId)) ?? null;
  const order = definitionId != null ? rules.find((r) => r.scope === 'order' && r.definitionId === Number(definitionId)) ?? null : null;
  const customer = definitionId != null ? rules.find((r) => r.scope === 'customer' && r.definitionId === Number(definitionId)) ?? null : null;
  return { row, order, customer, effective: row ?? order ?? customer };
}

/**
 * For cutPlateService.survey, on an OPEN line: each plate part keeps its drawn length in `drawnLength` and,
 * when its rule adds something, its `size.length` becomes drawn + extra — the size its cut piece is pooled by
 * and made at. `allowance` = { scope, ruleId, perEndMm, perMetreMm, extraMm } when a rule reaches it.
 * Pure: no query.
 */
export function applyToParts(rules, parts) {
  for (const p of parts) {
    if (p.drawnLength === undefined) p.drawnLength = p.size?.length ?? null;
    if (!rules.length) continue;
    const { effective } = levelsFor(rules, { partId: p.id, definitionId: p.source_definition_id });
    if (!effective || !(Number(p.drawnLength) > 0)) continue;
    const extraMm = extraMmOf(effective, p.drawnLength);
    p.allowance = { scope: effective.scope, ruleId: effective.id, perEndMm: effective.perEndMm, perMetreMm: effective.perMetreMm, extraMm };
    if (extraMm > 0) p.size = { ...p.size, length: r6(Number(p.drawnLength) + extraMm) };
  }
  return parts;
}

/**
 * What one cut piece carries, read from what is STORED (its LENGTH against its parts' drawn LENGTH) — so it is
 * right on a locked line too, and on an open line whose rule changed since. null when it is cut as drawn.
 *   { extraMm, minMm, maxMm, drawnLength, cutLength, rule: { scope, perEndMm, perMetreMm, words } | null, words }
 */
export function cutAllowanceOf(cutLength, parts) {
  const L = Number(cutLength);
  if (!(L > 0) || !parts?.length) return null;
  const drawn = parts.map((p) => Number(p.drawnLength ?? p.size?.length)).filter((x) => x > 0);
  if (!drawn.length) return null;
  const extras = drawn.map((d) => r1(L - d));
  const minMm = Math.min(...extras);
  const maxMm = Math.max(...extras);
  if (Math.abs(minMm) < 0.05 && Math.abs(maxMm) < 0.05) return null;
  const same = maxMm - minMm < 0.05;
  const rules = parts.map((p) => p.allowance ?? null);
  const one = rules[0] && rules.every((r) => r && r.scope === rules[0].scope && r.perEndMm === rules[0].perEndMm && r.perMetreMm === rules[0].perMetreMm) ? rules[0] : null;
  return {
    extraMm: same ? minMm : null, minMm, maxMm,
    drawnLength: same ? r1(drawn[0]) : null, cutLength: r1(L),
    rule: one ? { scope: one.scope, perEndMm: one.perEndMm, perMetreMm: one.perMetreMm, words: ruleWords(one) } : null,
    words: same ? `+${mm(minMm)} allowance` : `+${plain(minMm)} to +${mm(maxMm)} allowance`,
  };
}

/**
 * For the nesting upload (nestDxfImportService.uploadContext → lib/nestDxfReader.matchNest): the drawn LENGTHs
 * of the rows a cut piece is cut for, when the cut piece is longer than them — it carries a cutting allowance.
 * A part whose NAME states such a drawn length is then that cut piece EXACTLY. `rows`: { cutPlateId, length }.
 * Pure: no query.
 */
export function drawnLengthsOf(cp, rows) {
  const L = Number(cp?.steel?.length ?? cp?.length);
  if (!(L > 0)) return [];
  const out = new Set();
  for (const r of rows ?? []) {
    if (Number(r.cutPlateId) !== Number(cp.id)) continue;
    const d = Number(r.length);
    if (d > 0 && L - d > 0.5) out.add(r6(d));
  }
  return [...out];
}

// --- reads ---------------------------------------------------------------------------

/** The plate-part definitions of the catalog — the part names a rule can name. Two to four round trips. */
export async function partNames(db, companyId, { search = '' } = {}) {
  const term = String(search ?? '').trim();
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.short_name
       FROM cf_master_records m
       JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL AND d.definition_type = 'template'
      WHERE m.company_id = ? AND m.record_kind = 'definition' AND m.deleted_at IS NULL AND m.status <> 'obsolete'
        ${term ? 'AND (m.name LIKE ? OR m.code LIKE ? OR m.short_name LIKE ?)' : ''}
      ORDER BY m.name, m.id`,
    term ? [companyId, `%${term}%`, `%${term}%`, `%${term}%`] : [companyId],
  );
  if (!rows.length) return { partNames: [] };
  const cut = await cutFromOf(db, companyId, rows.map((r) => r.id));
  return { partNames: rows.filter((r) => cut.get(r.id) === 'PLATE').map((r) => ({ id: Number(r.id), code: r.code, name: r.name, shortName: r.short_name ?? null })) };
}

async function requireCustomer(db, companyId, customerId) {
  const [[p]] = await db.query('SELECT id, code, name FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, customerId]);
  if (!p) throw notFound('Customer');
  return { id: Number(p.id), code: p.code, name: p.name };
}

async function requireOrder(db, companyId, orderId) {
  const [[o]] = await db.query(
    `SELECT o.id, o.code, o.status, o.order_type, o.revision, o.customer_id, ${latestRevisionSql('o')} AS latest_revision,
            p.code AS customer_code, p.name AS customer_name
       FROM cf_sales_orders o
       LEFT JOIN cf_parties p ON p.company_id = o.company_id AND p.id = o.customer_id
      WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL`,
    [companyId, orderId],
  );
  if (!o) throw notFound('Order');
  return o;
}

/** Why an order takes no allowance change, in words — null when it does. */
function orderRefusal(o) {
  if (o.status === 'revised' || Number(o.latest_revision) > Number(o.revision)) return revisedOrderMessage(o.code, o.revision, o.latest_revision);
  if (LOCKED_ORDER_STATUSES.has(o.status)) return `Order ${o.code} is ${o.status} — its cut pieces can no longer change, so its cutting allowance cannot either.`;
  return null;
}

/** An order's custom lines, with whether each is frozen and why. One query. */
async function linesOf(db, companyId, orderIds) {
  if (!orderIds.length) return [];
  const [rows] = await db.query(
    `SELECT l.id, l.line_no, l.order_id, l.item_id, l.locked_at, o.code AS order_code, o.status AS order_status, o.revision,
            ${latestRevisionSql('o')} AS latest_revision,
            (SELECT COUNT(*) FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS released
       FROM cf_sales_order_lines l
       JOIN cf_sales_orders o ON o.id = l.order_id AND o.company_id = l.company_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.order_id IN (?) AND l.deleted_at IS NULL AND l.line_type = 'custom'
      ORDER BY l.order_id, l.line_no`,
    [companyId, orderIds],
  );
  return rows.map((l) => {
    let frozen = null;
    if (LOCKED_ORDER_STATUSES.has(l.order_status) || Number(l.latest_revision) > Number(l.revision)) frozen = { reason: 'closed', message: `Order ${l.order_code} is ${l.order_status === 'revised' || Number(l.latest_revision) > Number(l.revision) ? 'revised' : l.order_status} — its cut pieces stay as they are.` };
    else if (Number(l.released)) frozen = { reason: 'released', message: `Line ${l.line_no} of ${l.order_code} is released to production — its cut pieces stay as they are.` };
    else if (l.locked_at) frozen = { reason: 'locked', message: `Line ${l.line_no} of ${l.order_code} is frozen — its cut pieces stay as they are. A revision of the order takes the new allowance.` };
    return { id: Number(l.id), lineNo: l.line_no, orderId: Number(l.order_id), orderCode: l.order_code, itemId: l.item_id != null ? Number(l.item_id) : null, frozen };
  });
}

/**
 * The plate parts of some order lines: { id, code, name, lineId, definitionId, definition, drawnLength }.
 * Rows filed where cut pieces are filed are never parts. Four round trips (rows, places, CUT_FROM ×2… as
 * cutFromOf reads, LENGTH).
 */
async function platePartsOf(db, companyId, lineIds) {
  if (!lineIds.length) return [];
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.classification_id, i.owner_order_line_id AS line_id, i.source_definition_id,
            d.code AS def_code, d.name AS def_name
       FROM cf_item_details i
       JOIN cf_master_records m ON m.id = i.master_id AND m.company_id = i.company_id AND m.deleted_at IS NULL
       LEFT JOIN cf_master_records d ON d.id = i.source_definition_id AND d.deleted_at IS NULL
      WHERE i.company_id = ? AND i.deleted_at IS NULL AND i.item_type = 'temporary' AND i.owner_order_line_id IN (?)
      ORDER BY m.id`,
    [companyId, lineIds],
  );
  if (!rows.length) return [];
  const places = await cutPlaces(db, companyId);
  const blanks = new Set([...places.plate.blanksIds, ...places.section.blanksIds]);
  const candidates = rows.filter((r) => !blanks.has(Number(r.classification_id)));
  if (!candidates.length) return [];
  const cut = await cutFromOf(db, companyId, candidates.map((r) => r.id));
  const parts = candidates.filter((r) => cut.get(r.id) === 'PLATE');
  if (!parts.length) return [];
  const [lens] = await db.query(
    `SELECT v.subject_id, v.value_number FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'LENGTH'
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?)`,
    [companyId, parts.map((p) => p.id)],
  );
  const lenOf = new Map(lens.map((r) => [Number(r.subject_id), r.value_number != null ? r6(r.value_number) : null]));
  return parts.map((p) => ({
    id: Number(p.id), code: p.code ?? null, name: p.name ?? null, lineId: Number(p.line_id),
    definitionId: p.source_definition_id != null ? Number(p.source_definition_id) : null,
    definition: p.source_definition_id != null ? { id: Number(p.source_definition_id), code: p.def_code ?? null, name: p.def_name ?? null } : null,
    drawnLength: lenOf.get(Number(p.id)) ?? null,
  }));
}

const NOTE = 'The allowance changes only the cut pieces: their length, code and weight, and the plate they are cut from. The rows keep their drawn length, so the order weight stays as drawn. A line whose design is frozen keeps its cut pieces; a revision of the order takes the new allowance.';

/** GET /customers/:id/cut-allowances */
export async function customerAllowances(db, companyId, customerId) {
  const customer = await requireCustomer(db, companyId, customerId);
  const [rows] = await db.query(
    `SELECT a.id, a.scope, a.customer_id, a.order_id, a.definition_id, a.part_id, a.per_end_mm, a.per_metre_mm, m.code AS def_code, m.name AS def_name
       FROM cf_cut_allowances a
       LEFT JOIN cf_master_records m ON m.id = a.definition_id AND m.company_id = a.company_id
      WHERE a.company_id = ? AND a.scope = 'customer' AND a.customer_id = ? AND a.deleted_at IS NULL
      ORDER BY m.name, a.id`,
    [companyId, customer.id],
  );
  return {
    customer,
    rules: rows.map((r) => ({ ...shown(ruleOfRow(r)), definitionId: Number(r.definition_id), definition: { id: Number(r.definition_id), code: r.def_code, name: r.def_name }, example: exampleOf(ruleOfRow(r), 12000) })),
    note: NOTE,
  };
}

/** The order's plate parts by part name, and its rows with their own rule. */
async function orderView(db, companyId, o) {
  const lines = await linesOf(db, companyId, [Number(o.id)]);
  const parts = await platePartsOf(db, companyId, lines.map((l) => l.id));
  const rules = await rulesOf(db, companyId, { orderId: o.id, customerId: o.customer_id });
  const lineOf = new Map(lines.map((l) => [l.id, l]));
  const byDef = new Map();
  for (const p of parts) {
    if (p.definitionId == null) continue;
    if (!byDef.has(p.definitionId)) byDef.set(p.definitionId, { definition: p.definition, parts: [] });
    byDef.get(p.definitionId).parts.push(p);
  }
  const partNamesOut = [...byDef.values()].map(({ definition, parts: ps }) => {
    const lv = levelsFor(rules, { partId: -1, definitionId: definition.id });
    const lens = ps.map((p) => p.drawnLength).filter((x) => x > 0);
    const longest = lens.length ? Math.max(...lens) : null;
    return {
      definitionId: definition.id, definition, rows: ps.length,
      lengths: lens.length ? { min: Math.min(...lens), max: longest } : null,
      customer: shown(lv.customer), order: shown(lv.order),
      effective: lv.effective ? shown(lv.effective) : null,
      example: longest ? exampleOf(lv.effective, longest) : null,
      rowOverrides: ps.filter((p) => rules.some((r) => r.scope === 'row' && r.partId === p.id)).length,
    };
  }).sort((a, b) => String(a.definition.name ?? '').localeCompare(String(b.definition.name ?? '')));
  const partById = new Map(parts.map((p) => [p.id, p]));
  const rowsOut = rules.filter((r) => r.scope === 'row').map((r) => {
    const p = partById.get(r.partId);
    if (!p) return null;
    return { ...rowOut(p, lineOf.get(p.lineId)), rule: shown(r), example: exampleOf(r, p.drawnLength) };
  }).filter(Boolean);
  return {
    order: {
      id: Number(o.id), code: o.code, revision: o.revision, status: o.status,
      customer: o.customer_id != null ? { id: Number(o.customer_id), code: o.customer_code, name: o.customer_name } : null,
      editable: !orderRefusal(o), reason: orderRefusal(o),
    },
    partNames: partNamesOut,
    rows: rowsOut,
    noPartName: parts.filter((p) => p.definitionId == null).length,
    lines: lines.map((l) => ({ lineId: l.id, lineNo: l.lineNo, frozen: !!l.frozen, reason: l.frozen?.reason ?? null, message: l.frozen?.message ?? null })),
    note: NOTE,
  };
}

const rowOut = (p, line) => ({
  partId: p.id, code: p.code, name: p.name, lineId: p.lineId, lineNo: line?.lineNo ?? null,
  definition: p.definition, drawnLength: p.drawnLength,
});

/** GET /orders/:id/cut-allowances */
export async function orderAllowances(db, companyId, orderId) {
  return orderView(db, companyId, await requireOrder(db, companyId, orderId));
}

/** GET /orders/:id/lines/:lineId/rows/:rowId/cut-allowance */
export async function rowAllowance(db, companyId, orderId, lineId, partId) {
  const o = await requireOrder(db, companyId, orderId);
  const lines = await linesOf(db, companyId, [Number(o.id)]);
  const line = lines.find((l) => l.id === Number(lineId));
  if (!line) throw invalid('WRONG_ORDER', `Line ${lineId} is not a line of ${o.code} with a structure.`);
  const parts = await platePartsOf(db, companyId, [line.id]);
  const p = parts.find((x) => x.id === Number(partId));
  if (!p) throw invalid('NOT_A_PLATE_PART', 'This row is not a part cut from plate on this line, so it has no cutting allowance.');
  const rules = await rulesOf(db, companyId, { orderId: o.id, customerId: o.customer_id });
  const lv = levelsFor(rules, { partId: p.id, definitionId: p.definitionId });
  return {
    row: rowOut(p, line),
    customer: shown(lv.customer), order: shown(lv.order), own: shown(lv.row),
    effective: shown(lv.effective),
    example: exampleOf(lv.effective, p.drawnLength),
    editable: !orderRefusal(o), reason: orderRefusal(o),
    lineFrozen: line.frozen ? { reason: line.frozen.reason, message: line.frozen.message } : null,
    note: NOTE,
  };
}

// --- writes ----------------------------------------------------------------------------

function readRule(body) {
  const num = (v, name, max) => {
    if (v == null || v === '') return 0;
    const n = Number(v);
    if (!Number.isFinite(n)) throw invalid('INVALID', `${name} must be a number of mm.`);
    if (n < 0) throw invalid('INVALID', `${name} cannot be less than 0 — an allowance only makes a cut piece longer.`);
    if (n > max) throw invalid('INVALID', `${name} can be at most ${max} mm.`);
    return r6(n);
  };
  return { perEndMm: num(body?.perEndMm, 'mm at each end', MAX_PER_END_MM), perMetreMm: num(body?.perMetreMm, 'mm a metre', MAX_PER_METRE_MM) };
}

async function requirePlateDefinition(db, companyId, definitionId) {
  const [[d]] = await db.query(
    `SELECT m.id, m.code, m.name FROM cf_master_records m
       JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL AND d.definition_type = 'template'
      WHERE m.company_id = ? AND m.id = ? AND m.record_kind = 'definition' AND m.deleted_at IS NULL`,
    [companyId, definitionId],
  );
  if (!d) throw notFound('Part name');
  const cut = await cutFromOf(db, companyId, [d.id]);
  if (cut.get(d.id) !== 'PLATE') throw invalid('NOT_A_PLATE_PART', `${d.name ?? d.code} is not cut from plate, so it takes no cutting allowance.`);
  return d;
}

/** One live rule per target: written over the live one (the generated live key), or created. One statement. */
async function upsert(db, c, { scope, customerId = null, orderId = null, definitionId = null, partId = null }, rule) {
  await db.query(
    `INSERT INTO cf_cut_allowances (company_id, scope, customer_id, order_id, definition_id, part_id, per_end_mm, per_metre_mm, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE per_end_mm = VALUES(per_end_mm), per_metre_mm = VALUES(per_metre_mm), updated_by = VALUES(updated_by)`,
    [c.companyId, scope, customerId, orderId, definitionId, partId, rule.perEndMm, rule.perMetreMm, c.userId ?? null, c.userId ?? null],
  );
}

async function remove(db, c, { scope, customerId = null, orderId = null, definitionId = null, partId = null }) {
  const [r] = await db.query(
    `UPDATE cf_cut_allowances SET deleted_at = NOW(), updated_by = ?
      WHERE company_id = ? AND scope = ? AND deleted_at IS NULL
        AND customer_id <=> ? AND order_id <=> ? AND definition_id <=> ? AND part_id <=> ?`,
    [c.userId ?? null, c.companyId, scope, customerId, orderId, definitionId, partId],
  );
  return r.affectedRows;
}

/**
 * The cut pieces of every open line the change reaches, worked out again (refreshCutPieces never fails the
 * save: it says why). Frozen lines are listed with their sentence, untouched. One refresh per open line.
 */
async function follow(db, c, lines) {
  const { refreshCutPieces } = await import('./cutPlateService.js');
  const refreshed = [];
  const frozen = [];
  for (const l of lines) {
    if (l.frozen) { frozen.push({ lineId: l.id, lineNo: l.lineNo, orderId: l.orderId, orderCode: l.orderCode, reason: l.frozen.reason, message: l.frozen.message }); continue; }
    if (l.itemId == null) continue;
    const r = await refreshCutPieces(db, c, l.id);
    refreshed.push({ lineId: l.id, lineNo: l.lineNo, orderId: l.orderId, orderCode: l.orderCode, made: r.made, reason: r.reason, message: r.message });
  }
  const bits = [];
  const made = refreshed.filter((r) => r.made).length;
  if (made) bits.push(`The cut pieces of ${plural(made, 'line')} were worked out again.`);
  if (frozen.length) bits.push(`${plural(frozen.length, 'frozen line')} ${frozen.length === 1 ? 'keeps its' : 'keep their'} cut pieces — a revision of the order takes the new allowance.`);
  return { refreshed, frozen, message: bits.join(' ') || null };
}

/** The open lines a customer's rule reaches: every custom line of the customer's customer orders. */
async function customerLines(db, companyId, customerId) {
  const [orders] = await db.query(
    "SELECT id FROM cf_sales_orders WHERE company_id = ? AND customer_id = ? AND order_type = 'customer' AND deleted_at IS NULL",
    [companyId, customerId],
  );
  const lines = await linesOf(db, companyId, orders.map((o) => Number(o.id)));
  // An order that is closed or revised is not news: only a LOCKED line of a live order is worth saying.
  return lines.filter((l) => !l.frozen || l.frozen.reason !== 'closed');
}

/** PUT /customers/:id/cut-allowances/:definitionId { perEndMm, perMetreMm } */
export async function setCustomerAllowance(db, c, customerId, definitionId, body) {
  const customer = await requireCustomer(db, c.companyId, customerId);
  await requirePlateDefinition(db, c.companyId, definitionId);
  await upsert(db, c, { scope: 'customer', customerId: customer.id, definitionId: Number(definitionId) }, readRule(body));
  const after = await follow(db, c, await customerLines(db, c.companyId, customer.id));
  return { ...await customerAllowances(db, c.companyId, customer.id), ...after };
}

/** DELETE /customers/:id/cut-allowances/:definitionId */
export async function clearCustomerAllowance(db, c, customerId, definitionId) {
  const customer = await requireCustomer(db, c.companyId, customerId);
  const gone = await remove(db, c, { scope: 'customer', customerId: customer.id, definitionId: Number(definitionId) });
  const after = gone ? await follow(db, c, await customerLines(db, c.companyId, customer.id)) : { refreshed: [], frozen: [], message: null };
  return { ...await customerAllowances(db, c.companyId, customer.id), ...after };
}

async function writableOrder(db, companyId, orderId) {
  const o = await requireOrder(db, companyId, orderId);
  const why = orderRefusal(o);
  if (why) throw invalid('ORDER_LOCKED', why);
  return o;
}

/** PUT /orders/:id/cut-allowances/:definitionId { perEndMm, perMetreMm } — an override for one part name on this order. */
export async function setOrderAllowance(db, c, orderId, definitionId, body) {
  const o = await writableOrder(db, c.companyId, orderId);
  await requirePlateDefinition(db, c.companyId, definitionId);
  await upsert(db, c, { scope: 'order', orderId: Number(o.id), definitionId: Number(definitionId) }, readRule(body));
  const after = await follow(db, c, await linesOf(db, c.companyId, [Number(o.id)]));
  return { ...await orderView(db, c.companyId, o), ...after };
}

/** DELETE /orders/:id/cut-allowances/:definitionId — back to the customer's. */
export async function clearOrderAllowance(db, c, orderId, definitionId) {
  const o = await writableOrder(db, c.companyId, orderId);
  const gone = await remove(db, c, { scope: 'order', orderId: Number(o.id), definitionId: Number(definitionId) });
  const after = gone ? await follow(db, c, await linesOf(db, c.companyId, [Number(o.id)])) : { refreshed: [], frozen: [], message: null };
  return { ...await orderView(db, c.companyId, o), ...after };
}

async function writableRow(db, companyId, orderId, lineId, partId) {
  const o = await writableOrder(db, companyId, orderId);
  const lines = await linesOf(db, companyId, [Number(o.id)]);
  const line = lines.find((l) => l.id === Number(lineId));
  if (!line) throw invalid('WRONG_ORDER', `Line ${lineId} is not a line of ${o.code} with a structure.`);
  const parts = await platePartsOf(db, companyId, [line.id]);
  if (!parts.some((p) => p.id === Number(partId))) throw invalid('NOT_A_PLATE_PART', 'This row is not a part cut from plate on this line, so it has no cutting allowance.');
  return { o, line };
}

/** PUT /orders/:id/lines/:lineId/rows/:rowId/cut-allowance { perEndMm, perMetreMm } — this row only. */
export async function setRowAllowance(db, c, orderId, lineId, partId, body) {
  const { o, line } = await writableRow(db, c.companyId, orderId, lineId, partId);
  await upsert(db, c, { scope: 'row', orderId: Number(o.id), partId: Number(partId) }, readRule(body));
  const after = await follow(db, c, [line]);
  return { ...await rowAllowance(db, c.companyId, o.id, line.id, partId), ...after };
}

/** DELETE /orders/:id/lines/:lineId/rows/:rowId/cut-allowance — back to the part name's. */
export async function clearRowAllowance(db, c, orderId, lineId, partId) {
  const { o, line } = await writableRow(db, c.companyId, orderId, lineId, partId);
  const gone = await remove(db, c, { scope: 'row', orderId: Number(o.id), partId: Number(partId) });
  const after = gone ? await follow(db, c, [line]) : { refreshed: [], frozen: [], message: null };
  return { ...await rowAllowance(db, c.companyId, o.id, line.id, partId), ...after };
}

/**
 * A REVISION (revisionService.reviseOrder): the order's part-name rules and its rows' rules go to the new
 * revision, each row's to its copy (`idMap`: old row id → new row id). The old revision keeps its own.
 * Two reads at most, two inserts at most.
 */
export async function carryToRevision(db, c, fromOrderId, toOrderId, idMap) {
  const [rows] = await db.query(
    `SELECT scope, definition_id, part_id, per_end_mm, per_metre_mm FROM cf_cut_allowances
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND scope IN ('order', 'row')`,
    [c.companyId, fromOrderId],
  );
  const out = [];
  for (const r of rows) {
    const partId = r.scope === 'row' ? idMap.get(Number(r.part_id)) ?? null : null;
    if (r.scope === 'row' && partId == null) continue;
    out.push([c.companyId, r.scope, null, toOrderId, r.scope === 'order' ? r.definition_id : null, partId, r.per_end_mm, r.per_metre_mm, c.userId ?? null]);
  }
  if (out.length) {
    await insertRows(db, 'cf_cut_allowances',
      ['company_id', 'scope', 'customer_id', 'order_id', 'definition_id', 'part_id', 'per_end_mm', 'per_metre_mm', 'created_by'], out);
  }
  return out.length;
}
