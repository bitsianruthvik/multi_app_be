/**
 * sectionNestingService.js — a line's SECTION cut pieces laid out on stock bars
 * (CF_ERP_CUT_FROM_PLAN.md §4 and §11.3). The 1-D twin of nestingService.
 *
 * WHAT IT NESTS. A section cut piece ("blank") is a temporary item of the line
 * filed under the section blanks place (Setup › Cutting, lib/cutPlaces.js),
 * carrying its cut LENGTH, with ONE BOM line to the stock bar it is cut from (a
 * catalog item under the section stock places, e.g. ISA 75 x 75 x 8 x 6000 E350
 * BO) at length ÷ stock length. How many pieces the line needs of it comes from
 * the line's explosion, exactly as plate nesting counts (the line quantity is
 * multiplied there, once).
 *
 * PROFILES. Blanks are grouped by the PROFILE of their stock bar — the same bar
 * whatever its length: classification, thickness, width, depth, section area,
 * grade, impact class and material. (Section area is in the key because
 * ISMB 100 x 75 x 4 and ISLB 100 x 75 x 4 share the three dimensions and are not
 * the same bar.) Every catalog stock length of that profile is a candidate, and
 * reusable bar offcuts of it (cf_offcuts kind 'bar', status 'available', ours or
 * the order customer's) are offered first and free.
 *
 * SUGGEST, THEN ACCEPT — as plates:
 *   getSectionNesting    the SAVED plan (a look is a look; nothing is packed)
 *   planSectionNesting   a fresh plan, nothing written
 *   acceptSectionNesting plans again and writes it
 *   takeBackSectionNesting  the saved plan withdrawn while nothing is cut
 *
 * WHAT ACCEPT WRITES — the plate tables, with a kind switch (§4.3):
 *   cf_plate_lots       kind 'bar': one stock bar each (plate_item_id = the bar
 *                       item; length = the bar; thickness / width = the
 *                       section's), lot numbers BAR-001…, origin 'auto' (the
 *                       sheet's are 'imported'); a bar from an offcut has source
 *                       'offcut', origin_lot_id = the lot that left it, and the
 *                       offcut's id in waste_json.offcutId — that offcut is
 *                       marked 'used' (claimed) until the plan is replaced.
 *   cf_nest_placements  x_mm = where the cut starts along the bar, y_mm 0,
 *                       length_mm = the cut, width_mm = the section width.
 *   cf_offcuts          kind 'bar' for a leftover ≥ the minimum offcut: status
 *                       'planned' (the ledger makes it a stock piece when the
 *                       bar is cut), length_mm, stock_item_id, area = length × width.
 *   BOM lines           each blank's stock line becomes the REAL bar count per
 *                       piece (bars charged ÷ pieces), as plates' area fractions
 *                       are replaced. A bar is charged to the blanks on it by
 *                       their share of its cut length.
 *
 * A BLANK ON TWO STOCK LENGTHS. When a blank's pieces sit on bars of two
 * different stock lengths of its profile (some on 6 m bars, some on 12 m), it
 * gets ONE BOM LINE PER STOCK ITEM it draws, each with that item's bars charged
 * by length share ÷ the blank's pieces — so the buy list asks for both lengths,
 * each in whole-plan numbers. The blank's original stock line is kept for the
 * item it already named when the plan uses it (else repointed to the item that
 * carries most of it); extra lines are added beside it and taken away again
 * when the plan changes. A blank cut ENTIRELY from offcuts keeps its line at
 * quantity 0: nothing is bought for it. Taking the plan back leaves one line
 * per blank (its first) at length ÷ stock length again.
 *
 * Every write is set-based: a fixed number of statements whatever the size
 * (production is ~49 ms a round trip).
 */
import { invalid, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { explode } from './bomService.js';
import {
  requireLine, assertOpen, assertFrozen, isFrozenForNesting, piecesByRecord, updateBomLines, FREEZE_FIRST,
} from './nestingService.js';
import { packBars } from './sectionPacker.js';
import { lastPricesPaid, listPricesOf, perUnitPrice } from './priceService.js';

const EPS = 1e-6;
const FALLBACK_DENSITY = 7850;
export const BAR_LOT_PREFIX = 'BAR-';
const STEEL_CODES = ['THICKNESS', 'WIDTH', 'DEPTH', 'SECTION_AREA', 'GRADE', 'IMPACT_CLASS', 'MATERIAL', 'DENSITY', 'LENGTH', 'WEIGHT'];

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const blank = (v) => v == null || String(v).trim() === '';
const norm = (s) => (blank(s) ? '' : String(s).trim().toUpperCase());
const num = (v) => (v == null || v === '' ? null : Number(v));
const fmt = (n) => (n == null ? '?' : String(r3(n)));
const mmText = (n) => `${Number(r3(n)).toLocaleString('en-US')} mm`;
const nameOf = (r) => r?.code ?? r?.name ?? `#${r?.id}`;
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

/* ---------------------------------------------------------------------------
 * Values and profiles
 * ------------------------------------------------------------------------ */

/** The steel of records: Map id -> { thickness, width, depth, sectionArea, grade, impactClass, material, density, lengthMm, weight }. */
export async function steelOf(db, companyId, ids) {
  const list = [...new Set(ids.filter((x) => x != null).map(Number))];
  const out = new Map(list.map((id) => [id, {}]));
  if (!list.length) return out;
  const [rows] = await db.query(
    `SELECT v.subject_id, UPPER(s.code) AS code, v.value_number, v.value_text, o.value AS option_value
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL AND s.code IN (?)`,
    [companyId, list, STEEL_CODES],
  );
  const key = { THICKNESS: 'thickness', WIDTH: 'width', DEPTH: 'depth', SECTION_AREA: 'sectionArea', DENSITY: 'density', LENGTH: 'lengthMm', WEIGHT: 'weight', GRADE: 'grade', IMPACT_CLASS: 'impactClass', MATERIAL: 'material' };
  for (const r of rows) {
    const o = out.get(Number(r.subject_id));
    if (!o) continue;
    const k = key[r.code];
    if (['grade', 'impactClass', 'material'].includes(k)) { const t = r.option_value ?? r.value_text; if (!blank(t)) o[k] = String(t).trim(); } else if (r.value_number != null) o[k] = Number(r.value_number);
  }
  return out;
}

/** One key per bar profile: the same bar whatever its length. */
export const profileKeyOf = (classificationId, s) => [
  classificationId ?? '', fmt(s.thickness), fmt(s.width), fmt(s.depth), fmt(s.sectionArea), norm(s.grade), norm(s.impactClass), norm(s.material),
].join('|');

/** "ISA 75 x 75 x 10" from the stock item's name (its first word) and dimensions. */
function shapeOf(name, s) {
  const word = String(name ?? '').trim().split(/\s+/)[0] || 'Section';
  const dims = [s.depth, s.width, s.thickness].filter((x) => x != null).map(fmt);
  return { word, text: `${word} ${dims.join(' x ')}`.trim() };
}

const kgPerMmOf = (s) => {
  if (s.sectionArea > 0) return (s.sectionArea * (s.density > 0 ? s.density : FALLBACK_DENSITY)) / 1e9;
  if (s.weight > 0 && s.lengthMm > 0) return s.weight / s.lengthMm;
  return null;
};

/* ---------------------------------------------------------------------------
 * Reading the line
 * ------------------------------------------------------------------------ */

const lineView = (line) => ({ id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code });

/** The line's live bar lots (rows), one query. */
async function barLotsOf(db, companyId, lineId) {
  const [rows] = await db.query(
    `SELECT l.*, m.code AS item_code, m.name AS item_name
       FROM cf_plate_lots l
       LEFT JOIN cf_master_records m ON m.id = l.plate_item_id
      WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL AND l.kind = 'bar'
      ORDER BY l.lot_no, l.id`,
    [companyId, lineId],
  );
  return rows;
}

/**
 * Everything section nesting needs about a line, in a fixed handful of queries:
 * the places, the section blanks and how many pieces of each the line needs,
 * their stock lines, the profiles (candidates and offcuts unless `light`).
 *
 * Returns { places, settings, problems: string[], blanks: Map, profiles: Map, barLots }.
 * blank = { id, code, name, lengthMm, pieces, parts, stockLines: [line rows], stockItemId, profileKey }
 */
export async function surveySections(db, companyId, line, { tree = null, light = false } = {}) {
  const places = await cutPlaces(db, companyId);
  const sec = places.section;
  const out = { places, settings: places.settings, problems: [], blanks: new Map(), profiles: new Map(), barLots: [], stockById: new Map() };
  out.barLots = await barLotsOf(db, companyId, line.id);
  if (line.line_type !== 'custom' || !line.item_id) return out;
  if (!sec.blanksNodeId) {
    out.problems.push('No place is set for section cut pieces — choose one in Setup › Cutting.');
    return out;
  }
  const t = tree ?? await explode(db, companyId, line.item_id, { rootQuantity: Number(line.quantity) });
  const totals = piecesByRecord(t);
  const parentsOf = new Map();
  (function walk(node) {
    for (const ch of node.children) {
      if (node.depth >= 0 && node.id != null && ch.id != null) {
        if (!parentsOf.has(ch.id)) parentsOf.set(ch.id, new Set());
        if (node.depth > 0) parentsOf.get(ch.id).add(node.code ?? node.name ?? `#${node.id}`);
      }
      walk(ch);
    }
  }(t.root));
  const ids = [...totals.keys()];
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL AND m.classification_id IN (?)
      ORDER BY m.id`,
    [companyId, ids, [...sec.blanksIds]],
  );
  if (!rows.length) return out;
  const blankIds = rows.map((r) => r.id);
  const [lineRows] = await db.query(
    `SELECT b.parent_id AS blank_id, b.id AS bom_id, l.id AS line_id, l.child_id, l.quantity, l.design_id, l.role,
            l.selection_definition_id, m.classification_id, m.record_kind, m.code AS child_code
       FROM cf_boms b
       JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.child_id AND m.deleted_at IS NULL
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.parent_id IN (?)
      ORDER BY l.id`,
    [companyId, blankIds],
  );
  const stockLines = new Map(blankIds.map((id) => [id, []]));
  for (const r of lineRows) if (r.record_kind === 'item' && sec.stockIds.has(Number(r.classification_id))) stockLines.get(r.blank_id)?.push(r);

  // Offcuts first (their stock items join the one steel read), unless light.
  const claimed = new Set(out.barLots.filter((l) => l.source === 'offcut').map((l) => Number(parseJson(l.waste_json)?.offcutId)).filter(Boolean));
  let offRows = [];
  if (!light) {
    const [[order]] = await db.query('SELECT customer_id FROM cf_sales_orders WHERE company_id = ? AND id = ?', [companyId, line.order_id]);
    [offRows] = await db.query(
      `SELECT id, offcut_no, length_mm, stock_item_id, owner_party_id, plate_lot_id, status
         FROM cf_offcuts
        WHERE company_id = ? AND deleted_at IS NULL AND kind = 'bar' AND stock_item_id IS NOT NULL AND length_mm > 0
          AND (status = 'available' OR id IN (?))
          AND (owner_party_id IS NULL OR owner_party_id = ?)
        ORDER BY length_mm DESC, id`,
      [companyId, [0, ...claimed], order?.customer_id ?? 0],
    );
  }
  const lotItemIds = out.barLots.map((l) => l.plate_item_id);
  const firstStock = [...stockLines.values()].flatMap((ls) => ls.map((l) => l.child_id));
  const steel = await steelOf(db, companyId, [...blankIds, ...firstStock, ...offRows.map((o) => o.stock_item_id), ...lotItemIds]);
  const [itemRows] = await db.query(
    'SELECT id, code, name, classification_id, status FROM cf_master_records WHERE company_id = ? AND id IN (?)',
    [companyId, [0, ...firstStock, ...offRows.map((o) => o.stock_item_id), ...lotItemIds]],
  );
  for (const r of itemRows) out.stockById.set(Number(r.id), { ...r, steel: steel.get(Number(r.id)) ?? {} });

  // Profiles, from the stock each blank names.
  const ensureProfile = (item) => {
    const s = item.steel;
    const key = profileKeyOf(item.classification_id, s);
    if (!out.profiles.has(key)) {
      const shape = shapeOf(item.name, s);
      out.profiles.set(key, {
        key, classificationId: Number(item.classification_id), shape: shape.word,
        label: `${shape.text}${s.grade ? ` ${s.grade}` : ''}${s.impactClass ? ` ${s.impactClass}` : ''}`,
        grade: s.grade ?? null, impactClass: s.impactClass ?? null, material: s.material ?? null,
        thickness: s.thickness ?? null, width: s.width ?? null, depth: s.depth ?? null, sectionArea: s.sectionArea ?? null,
        density: s.density ?? null, kgPerMm: kgPerMmOf(s),
        pieces: [], stock: [], offcuts: [], sample: item,
      });
    }
    return out.profiles.get(key);
  };
  for (const r of rows) {
    const s = steel.get(r.id) ?? {};
    const lines = stockLines.get(r.id) ?? [];
    const pieces = Math.round(totals.get(r.id) ?? 0);
    const b = {
      id: r.id, code: r.code, name: r.name, lengthMm: s.lengthMm ?? null, pieces,
      parts: [...(parentsOf.get(r.id) ?? [])].sort(), stockLines: lines, stockItemId: null, profileKey: null,
    };
    out.blanks.set(r.id, b);
    if (!pieces) continue;
    if (!(b.lengthMm > 0)) { out.problems.push(`${nameOf(b)} does not say its LENGTH, so it cannot be laid out on a bar.`); continue; }
    if (!lines.length) { out.problems.push(`${nameOf(b)} has no stock bar — no section is chosen for the part it is cut from, so there is nothing to cut it from.`); continue; }
    const items = lines.map((l) => out.stockById.get(Number(l.child_id))).filter(Boolean);
    const keys = new Set(items.map((it) => profileKeyOf(it.classification_id, it.steel)));
    if (keys.size > 1) { out.problems.push(`${nameOf(b)} is cut from bars of different sections (${items.map(nameOf).join(', ')}) — one cut piece is one section.`); continue; }
    const p = ensureProfile(items[0]);
    b.stockItemId = items[0].id;
    b.profileKey = p.key;
    p.pieces.push({ cutPieceId: b.id, code: b.code, lengthMm: r3(b.lengthMm), quantity: pieces, parts: b.parts });
  }
  for (const p of out.profiles.values()) p.pieces.sort((a, b) => b.lengthMm - a.lengthMm || a.cutPieceId - b.cutPieceId);
  if (light || !out.profiles.size) return out;

  // Candidates: every catalog stock length of each profile.
  const classIds = [...new Set([...out.profiles.values()].map((p) => p.classificationId))];
  const [cands] = await db.query(
    `SELECT m.id, m.code, m.name, m.classification_id, m.status
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.classification_id IN (?) AND m.status = 'active'
      ORDER BY m.id`,
    [companyId, classIds],
  );
  const candSteel = await steelOf(db, companyId, cands.map((c) => c.id));
  for (const c of cands) out.stockById.set(Number(c.id), { ...c, steel: candSteel.get(Number(c.id)) ?? {} });
  const candIds = [];
  for (const c of cands) {
    const it = out.stockById.get(Number(c.id));
    const p = out.profiles.get(profileKeyOf(c.classification_id, it.steel));
    if (!p || !(it.steel.lengthMm > 0)) continue;
    p.stock.push({ itemId: c.id, code: c.code, lengthMm: r3(it.steel.lengthMm) });
    candIds.push(c.id);
  }
  // A stock item a blank names but which is not active is still its own candidate.
  for (const b of out.blanks.values()) {
    if (!b.profileKey) continue;
    const p = out.profiles.get(b.profileKey);
    const it = out.stockById.get(b.stockItemId);
    if (it?.steel.lengthMm > 0 && !p.stock.some((s) => s.itemId === it.id)) { p.stock.push({ itemId: it.id, code: it.code, lengthMm: r3(it.steel.lengthMm) }); candIds.push(it.id); }
  }
  // Values: a price per bar for every candidate of a profile, else its length.
  const [paid, listed] = await Promise.all([lastPricesPaid(db, companyId, candIds), listPricesOf(db, companyId, candIds)]);
  for (const p of out.profiles.values()) {
    p.stock.sort((a, b) => b.lengthMm - a.lengthMm || a.itemId - b.itemId);
    const priceOf = (s) => {
      const lp = paid.get(s.itemId);
      if (lp?.unitPrice > 0) return lp.unitPrice;
      const l = listed.get(s.itemId);
      const st = out.stockById.get(s.itemId)?.steel ?? {};
      return l?.listPrice != null ? perUnitPrice(l.listPrice, l.priceBasis, { weightKg: st.weight ?? null, lengthM: st.lengthMm ? st.lengthMm / 1000 : null }) : null;
    };
    const prices = p.stock.map(priceOf);
    p.priced = prices.length > 0 && prices.every((x) => x > 0);
    p.stock.forEach((s, i) => { s.value = p.priced ? prices[i] : s.lengthMm; });
  }
  for (const o of offRows) {
    const it = out.stockById.get(Number(o.stock_item_id));
    if (!it) continue;
    const p = out.profiles.get(profileKeyOf(it.classification_id, it.steel));
    if (p) p.offcuts.push({ offcutId: o.id, offcutNo: o.offcut_no, lengthMm: r3(o.length_mm), stockItemId: Number(o.stock_item_id), ownerPartyId: o.owner_party_id ?? null, plateLotId: o.plate_lot_id });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Plans: packing, shaping, numbering
 * ------------------------------------------------------------------------ */

/** Packs every profile. Returns Map key -> packed | null, and the words of any refusal. */
function packProfiles(survey) {
  const out = new Map();
  const problems = [];
  for (const p of survey.profiles.values()) {
    if (!p.pieces.length) { out.set(p.key, null); continue; }
    if (!p.stock.length) { problems.push(`${p.label}: no stock bar of this section is in the catalog, so its cut pieces have nothing to be cut from.`); out.set(p.key, null); continue; }
    try {
      out.set(p.key, packBars({
        pieces: p.pieces.map((x) => ({ id: x.cutPieceId, code: x.code, lengthMm: x.lengthMm, qty: x.quantity })),
        stock: p.stock.map((s) => ({ itemId: s.itemId, lengthMm: s.lengthMm, value: s.value })),
        offcuts: p.offcuts.map((o) => ({ offcutId: o.offcutId, lengthMm: o.lengthMm })),
        settings: survey.settings,
        label: p.label,
      }));
    } catch (e) {
      problems.push(...(e.problems ?? [e.message]));
      out.set(p.key, null);
    }
  }
  return { packed: out, problems };
}

/** BAR-001, BAR-002 … skipping a number a plate lot on the line already wears. */
async function barNumbers(db, companyId, lineId, count) {
  const [rows] = await db.query("SELECT lot_no FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [companyId, lineId]);
  const taken = new Set(rows.map((r) => String(r.lot_no).toUpperCase()));
  const out = [];
  for (let n = 1; out.length < count; n++) {
    const no = `${BAR_LOT_PREFIX}${String(n).padStart(3, '0')}`;
    if (!taken.has(no)) out.push(no);
  }
  return out;
}

/**
 * Packed bars -> the contract's Bar shape (and what a write needs, under _w).
 * `codes` names cut pieces; offcut bars carry their offcut's stock item.
 */
function shapeBars(survey, profile, bars, lotNos) {
  return bars.map((b, i) => {
    const off = b.source === 'offcut' ? profile.offcuts.find((o) => o.offcutId === b.offcutId) : null;
    const itemId = off ? off.stockItemId : b.itemId;
    const item = survey.stockById.get(Number(itemId));
    return {
      lotId: b.lotId ?? null,
      lotNo: b.lotNo ?? lotNos[i] ?? null,
      source: b.source,
      itemId: itemId ?? null,
      itemCode: item?.code ?? null,
      offcutId: off ? off.offcutId : null,
      offcutNo: off ? off.offcutNo : null,
      lengthMm: r3(b.lengthMm),
      cuts: b.cuts.map((c) => ({ cutPieceId: Number(c.id ?? c.cutPieceId), code: survey.blanks.get(Number(c.id ?? c.cutPieceId))?.code ?? null, xMm: r3(c.xMm), lengthMm: r3(c.lengthMm) })),
      wasteMm: r3(b.wasteMm),
      keptOffcutMm: r3(b.keptOffcutMm),
    };
  });
}

function planSummary(bars, extra = {}) {
  const total = bars.reduce((a, b) => a + b.lengthMm, 0);
  const waste = bars.reduce((a, b) => a + b.wasteMm, 0);
  const kept = bars.filter((b) => b.keptOffcutMm > 0);
  return {
    bars,
    barsBought: bars.filter((b) => b.source === 'catalog').length,
    barsFromOffcuts: bars.filter((b) => b.source === 'offcut').length,
    totalLengthMm: r3(total),
    wasteMm: r3(waste),
    wastePct: total > 0 ? r3((waste / total) * 100) : 0,
    keptOffcuts: kept.length,
    keptOffcutMm: r3(kept.reduce((a, b) => a + b.keptOffcutMm, 0)),
    ...extra,
  };
}

/** A fresh plan for every profile: Map key -> plan | null, and problems. Numbers BAR-… in profile order. */
async function freshPlans(db, companyId, line, survey) {
  const { packed, problems } = packProfiles(survey);
  const count = [...packed.values()].reduce((a, p) => a + (p?.bars.length ?? 0), 0);
  const numbers = await barNumbers(db, companyId, line.id, count);
  let at = 0;
  const plans = new Map();
  for (const p of survey.profiles.values()) {
    const pk = packed.get(p.key);
    if (!pk) { plans.set(p.key, null); continue; }
    const nos = numbers.slice(at, at + pk.bars.length);
    at += pk.bars.length;
    plans.set(p.key, planSummary(shapeBars(survey, p, pk.bars, nos), { method: pk.method, exact: pk.exact }));
  }
  return { plans, problems };
}

/** The saved plan, per profile key, from the line's bar lots (two queries). */
async function savedPlans(db, companyId, survey) {
  const lots = survey.barLots;
  const plans = new Map();
  const placed = new Map();
  if (!lots.length) return { plans, placed };
  const [rows] = await db.query(
    `SELECT p.plate_lot_id, p.cut_plate_id, p.pos_no, p.x_mm, p.length_mm, m.code
       FROM cf_nest_placements p LEFT JOIN cf_master_records m ON m.id = p.cut_plate_id
      WHERE p.company_id = ? AND p.plate_lot_id IN (?) AND p.deleted_at IS NULL
      ORDER BY p.plate_lot_id, p.pos_no, p.id`,
    [companyId, lots.map((l) => l.id)],
  );
  const cutsOf = new Map(lots.map((l) => [l.id, []]));
  for (const r of rows) {
    cutsOf.get(r.plate_lot_id)?.push({ cutPieceId: Number(r.cut_plate_id), code: r.code, xMm: r3(r.x_mm ?? 0), lengthMm: r3(r.length_mm) });
    placed.set(Number(r.cut_plate_id), (placed.get(Number(r.cut_plate_id)) ?? 0) + 1);
  }
  const byKey = new Map();
  for (const l of lots) {
    const it = survey.stockById.get(Number(l.plate_item_id));
    const key = it ? profileKeyOf(it.classification_id, it.steel) : `lot:${l.id}`;
    const w = parseJson(l.waste_json) ?? {};
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({
      lotId: l.id, lotNo: l.lot_no, source: l.source, itemId: l.plate_item_id, itemCode: l.item_code ?? null,
      offcutId: w.offcutId ?? null, offcutNo: w.offcutNo ?? null,
      lengthMm: r3(l.length_mm), cuts: cutsOf.get(l.id) ?? [],
      wasteMm: r3(w.wasteMm ?? 0), keptOffcutMm: r3(w.keptOffcutMm ?? 0),
      origin: l.origin, createdAt: l.created_at,
    });
  }
  for (const [key, bars] of byKey) plans.set(key, planSummary(bars.map(({ origin, createdAt, ...b }) => b), { origin: bars[0].origin }));
  return { plans, placed, byKey };
}

/** What the saved plan no longer matches, in words (blank count changed, unplaced, gone). */
function driftOf(survey, placed) {
  const out = [];
  for (const b of survey.blanks.values()) {
    if (!b.pieces && !placed.get(b.id)) continue;
    const got = placed.get(b.id) ?? 0;
    if (got !== b.pieces) out.push({ cutPieceId: b.id, code: b.code, needs: b.pieces, placed: got });
  }
  for (const [id, got] of placed) if (!survey.blanks.has(id)) out.push({ cutPieceId: id, code: null, needs: 0, placed: got });
  return out;
}

const driftWords = (d) => (d.needs === 0
  ? `${d.code ?? `Cut piece ${d.cutPieceId}`} is on the saved bars but no longer in the structure.`
  : d.placed === 0 ? `${d.code} (${d.needs} needed) is not on any saved bar.`
    : `${d.code}: the line needs ${d.needs} and the saved bars hold ${d.placed}.`);

function profileView(p, plan) {
  return {
    key: p.key, label: p.label, grade: p.grade,
    impactClass: p.impactClass, material: p.material,
    thickness: p.thickness, width: p.width, depth: p.depth, sectionArea: p.sectionArea,
    pieces: p.pieces,
    stockLengths: p.stock.map((s) => ({ itemId: s.itemId, code: s.code, lengthMm: s.lengthMm })),
    offcuts: p.offcuts.map((o) => ({ offcutId: o.offcutId, offcutNo: o.offcutNo, lengthMm: o.lengthMm })),
    plan: plan ?? null,
  };
}

function viewOf(line, survey, plans, { accepted, acceptedAt, problems }) {
  const profiles = [...survey.profiles.values()].map((p) => profileView(p, plans.get(p.key)));
  // Saved bars of a profile the line no longer has: shown, so they can be taken back.
  for (const [key, plan] of plans) {
    if (survey.profiles.has(key) || !plan) continue;
    const first = plan.bars[0];
    profiles.push({ key, label: first?.itemCode ?? key, grade: null, pieces: [], stockLengths: [], offcuts: [], plan });
  }
  return {
    line: lineView(line),
    settings: survey.settings,
    accepted, acceptedAt,
    frozen: isFrozenForNesting(line), released: !!line.release_id,
    problems,
    profiles,
  };
}

/** When the newest saved bar was written (the accept / the sheet save). */
const latestOf = (lots) => { let at = null; for (const l of lots) { const t = l.created_at ? new Date(l.created_at) : null; if (t && (!at || t > at)) at = t; } return at; };

const placeProblems = (survey) => (survey.blanks.size || survey.problems.length
  ? survey.places.problems.filter((p) => p.kind === 'section' && p.what !== 'blanks').map((p) => p.text)
  : []);

/* ---------------------------------------------------------------------------
 * The four entry points
 * ------------------------------------------------------------------------ */

/** GET — the SAVED plan. Nothing is packed. */
export async function getSectionNesting(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  const survey = await surveySections(db, companyId, line);
  const { plans, placed } = await savedPlans(db, companyId, survey);
  const accepted = survey.barLots.length > 0;
  const problems = [...survey.problems, ...placeProblems(survey)];
  if (line.line_type !== 'custom') problems.push(`Line ${line.line_no} of ${line.order_code} sells a catalog item, so it has no structure of its own — nothing to cut to length.`);
  if (accepted) problems.push(...driftOf(survey, placed).map(driftWords));
  const acceptedAt = accepted ? latestOf(survey.barLots) : null;
  return viewOf(line, survey, plans, { accepted, acceptedAt, problems });
}

/** POST /plan — a fresh plan for every profile; nothing written. */
export async function planSectionNesting(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  assertFrozen(line);
  const survey = await surveySections(db, companyId, line);
  const { plans, problems } = await freshPlans(db, companyId, line, survey);
  const accepted = survey.barLots.length > 0;
  return viewOf(line, survey, plans, {
    accepted,
    acceptedAt: accepted ? latestOf(survey.barLots) : null,
    problems: [...survey.problems, ...placeProblems(survey), ...problems],
  });
}

/**
 * Refuses, in words, once anything of the line's section nesting is cut on the
 * floor: a bar offcut no longer 'planned' (the ledger made it a stock piece at
 * the cut), or a step of a section cut piece started or done.
 */
export async function assertSectionNotCut(db, companyId, line, places = null) {
  const sec = (places ?? await cutPlaces(db, companyId)).section;
  const [[off]] = await db.query(
    `SELECT COUNT(*) AS n FROM cf_offcuts o
       JOIN cf_plate_lots pl ON pl.id = o.plate_lot_id AND pl.company_id = o.company_id
      WHERE pl.company_id = ? AND pl.order_line_id = ? AND pl.kind = 'bar' AND pl.deleted_at IS NULL
        AND o.deleted_at IS NULL AND o.status <> 'planned'`,
    [companyId, line.id],
  );
  let started = 0;
  if (line.release_id && sec.blanksIds.size) {
    const [[s]] = await db.query(
      `SELECT COUNT(*) AS n FROM cf_production_steps st
         JOIN cf_production_items pi ON pi.id = st.production_item_id AND pi.company_id = st.company_id AND pi.deleted_at IS NULL
         JOIN cf_master_records m ON m.id = pi.item_id
        WHERE st.company_id = ? AND pi.release_id = ? AND st.deleted_at IS NULL AND m.classification_id IN (?)
          AND (st.state IN ('in_progress','done') OR st.ledger_out > 0)`,
      [companyId, line.release_id, [...sec.blanksIds]],
    );
    started = Number(s.n);
  }
  if (Number(off.n) > 0 || started > 0) {
    throw invalid('CUT_ON_FLOOR', `Line ${line.line_no} of ${line.order_code}: its section bars are already being cut on the floor, so the section nesting cannot change now.`);
  }
}

/**
 * Soft-deletes the line's bar lots, their placements and their offcuts, and
 * gives back the offcuts they had claimed. Never touches a plate lot. Four
 * statements at most.
 */
async function clearBarLots(db, c, lineId, barLots) {
  if (!barLots.length) return 0;
  const ids = barLots.map((l) => l.id);
  const claimed = barLots.filter((l) => l.source === 'offcut').map((l) => Number(parseJson(l.waste_json)?.offcutId)).filter(Boolean);
  if (claimed.length) await db.query("UPDATE cf_offcuts SET status = 'available' WHERE company_id = ? AND id IN (?) AND status = 'used'", [c.companyId, claimed]);
  await db.query('UPDATE cf_nest_placements SET deleted_at = NOW() WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL', [c.companyId, ids]);
  await db.query('UPDATE cf_offcuts SET deleted_at = NOW() WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL', [c.companyId, ids]);
  await db.query("UPDATE cf_plate_lots SET deleted_at = NOW() WHERE company_id = ? AND id IN (?) AND kind = 'bar'", [c.companyId, ids]);
  return ids.length;
}

/**
 * Writes bars (the contract's Bar shape, grouped per profile) as lots,
 * placements and offcuts, claims the offcuts they use, and puts the real bar
 * counts on the blanks' stock lines. A fixed number of statements.
 *   plans: Map profileKey -> { bars }
 */
export async function writeSectionPlan(db, c, line, survey, plans, { origin = 'auto' } = {}) {
  const companyId = c.companyId;
  const user = c.userId ?? null;
  const s = survey.settings;
  const replaced = await clearBarLots(db, c, line.id, survey.barLots);
  const all = [];
  for (const [key, plan] of plans) {
    const p = survey.profiles.get(key);
    if (!plan || !p) continue;
    for (const b of plan.bars) all.push({ p, b });
  }
  if (all.length) {
    // Numbers: what the plan carries, else the next free BAR-… ones.
    const missing = all.filter((x) => !x.b.lotNo).length;
    const extra = missing ? await barNumbers(db, companyId, line.id, all.length + missing) : [];
    const used = new Set(all.map((x) => String(x.b.lotNo ?? '').toUpperCase()).filter(Boolean));
    const free = extra.filter((n) => !used.has(n.toUpperCase()));
    for (const x of all) if (!x.b.lotNo) x.b.lotNo = free.shift();

    await insertRows(db, 'cf_plate_lots', [
      'company_id', 'order_line_id', 'plate_item_id', 'lot_no', 'source', 'kind', 'origin_lot_id', 'thickness_mm', 'length_mm', 'width_mm',
      'required_length_mm', 'required_width_mm', 'grade', 'material', 'density', 'kerf_mm', 'seq_gap_min_mm', 'seq_gap_max_mm',
      'guillotine', 'is_manual', 'origin', 'waste_json', 'notes', 'owner_party_id', 'created_by',
    ], all.map(({ p, b }) => {
      const off = b.offcutId ? p.offcuts.find((o) => o.offcutId === b.offcutId) : null;
      const last = b.cuts[b.cuts.length - 1];
      const span = last ? r3(last.xMm + last.lengthMm + s.endTrimMm) : null;
      return [
        companyId, line.id, b.itemId, b.lotNo, b.source === 'offcut' ? 'offcut' : 'catalog', 'bar', off?.plateLotId ?? null,
        p.thickness ?? 0, b.lengthMm, p.width ?? 0, span, p.width ?? null, p.grade, p.material, p.density,
        s.sawKerfMm, 0, 0, 0, 0, origin,
        JSON.stringify({ kind: 'bar', offcutId: off?.offcutId ?? null, offcutNo: off?.offcutNo ?? null, sawKerfMm: s.sawKerfMm, endTrimMm: s.endTrimMm, minOffcutMm: s.minOffcutMm, wasteMm: b.wasteMm, keptOffcutMm: b.keptOffcutMm, partsMm: r3(b.cuts.reduce((a, x) => a + x.lengthMm, 0)) }),
        off ? `Cut from offcut ${off.offcutNo}` : null, off?.ownerPartyId ?? null, user,
      ];
    }), 500);
    const [idRows] = await db.query(
      "SELECT id, lot_no FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'bar' AND lot_no IN (?)",
      [companyId, line.id, all.map((x) => x.b.lotNo)],
    );
    const idOf = new Map(idRows.map((r) => [String(r.lot_no).toUpperCase(), r.id]));
    const placements = [];
    const offcuts = [];
    for (const { p, b } of all) {
      const lotId = idOf.get(String(b.lotNo).toUpperCase());
      b.lotId = lotId;
      b.cuts.forEach((cut, j) => placements.push([companyId, lotId, cut.cutPieceId, 1, 1, j + 1, cut.xMm, 0, cut.lengthMm, p.width ?? 0, 0, user]));
      if (b.keptOffcutMm > 0) {
        const off = b.offcutId ? p.offcuts.find((o) => o.offcutId === b.offcutId) : null;
        const len = b.keptOffcutMm;
        offcuts.push([
          companyId, line.id, lotId, `${b.lotNo}-A`, 'bar', p.thickness, p.grade, p.material, p.density,
          r3(len * (p.width ?? 0)), len, b.itemId, p.kgPerMm != null ? r3(p.kgPerMm * len) : null,
          r3(b.lengthMm - len), 0, len, p.width ?? null, '[]', 'planned', off?.ownerPartyId ?? null, user,
        ]);
      }
    }
    await insertRows(db, 'cf_nest_placements', [
      'company_id', 'plate_lot_id', 'cut_plate_id', 'seq_no', 'row_no', 'pos_no', 'x_mm', 'y_mm', 'length_mm', 'width_mm', 'rotated', 'created_by',
    ], placements, 1000);
    await insertRows(db, 'cf_offcuts', [
      'company_id', 'order_line_id', 'plate_lot_id', 'offcut_no', 'kind', 'thickness_mm', 'grade', 'material', 'density',
      'area_mm2', 'length_mm', 'stock_item_id', 'weight_kg', 'rect_x_mm', 'rect_y_mm', 'rect_length_mm', 'rect_width_mm',
      'outline_json', 'status', 'owner_party_id', 'created_by',
    ], offcuts, 200);
    const claim = all.map((x) => x.b.offcutId).filter(Boolean);
    if (claim.length) await db.query("UPDATE cf_offcuts SET status = 'used' WHERE company_id = ? AND id IN (?) AND status = 'available'", [companyId, claim]);
  }
  const quantities = await chargeStockLines(db, c, survey, all.map((x) => x.b));
  return {
    replacedLots: replaced,
    lots: all.length,
    barsBought: all.filter((x) => x.b.source === 'catalog').length,
    barsFromOffcuts: all.filter((x) => x.b.source === 'offcut').length,
    pieces: all.reduce((a, x) => a + x.b.cuts.length, 0),
    offcutsKept: all.filter((x) => x.b.keptOffcutMm > 0).length,
    quantities,
  };
}

/**
 * Each blank's stock line(s) = the real bar count per piece (see the top of
 * the file for a blank on two stock lengths). With `bars` empty, every blank is
 * put back to its estimate: one line at length ÷ stock length.
 */
async function chargeStockLines(db, c, survey, bars) {
  const companyId = c.companyId;
  const charge = new Map();                         // blankId -> Map(itemId -> bars)
  for (const b of bars) {
    if (b.source !== 'catalog') continue;
    const total = b.cuts.reduce((a, x) => a + x.lengthMm, 0);
    if (!(total > 0)) continue;
    for (const cut of b.cuts) {
      if (!charge.has(cut.cutPieceId)) charge.set(cut.cutPieceId, new Map());
      const m = charge.get(cut.cutPieceId);
      m.set(Number(b.itemId), (m.get(Number(b.itemId)) ?? 0) + cut.lengthMm / total);
    }
  }
  const restore = !bars.length;
  const updates = [];                                // [lineId, childId, quantity]
  const drops = [];
  const adds = [];                                   // { blank, first, itemId, quantity }
  const out = [];
  for (const b of survey.blanks.values()) {
    const lines = b.stockLines;
    if (!lines.length) continue;
    const first = lines[0];
    if (restore || (!b.pieces)) {
      if (!restore) continue;
      const it = survey.stockById.get(Number(first.child_id));
      const sl = it?.steel.lengthMm;
      const q = sl > 0 && b.lengthMm > 0 ? r6(b.lengthMm / sl) : Number(first.quantity);
      updates.push([first.line_id, Number(first.child_id), q]);
      drops.push(...lines.slice(1).map((l) => l.line_id));
      out.push({ cutPieceId: b.id, code: b.code, basis: 'estimate', lines: [{ itemId: Number(first.child_id), itemCode: it?.code ?? null, quantity: q }] });
      continue;
    }
    const m = charge.get(b.id) ?? new Map();
    const ranked = [...m.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    if (!ranked.length) {
      updates.push([first.line_id, Number(first.child_id), 0]);
      drops.push(...lines.slice(1).map((l) => l.line_id));
      out.push({ cutPieceId: b.id, code: b.code, basis: 'nesting plan', lines: [{ itemId: Number(first.child_id), quantity: 0, bars: 0, note: 'Cut entirely from offcuts — nothing to buy.' }] });
      continue;
    }
    // The first line keeps the item it already names when the plan uses it.
    const order = ranked.slice();
    const keep = order.findIndex(([id]) => id === Number(first.child_id));
    if (keep > 0) order.unshift(...order.splice(keep, 1));
    const entry = { cutPieceId: b.id, code: b.code, basis: 'nesting plan', lines: [] };
    order.forEach(([itemId, used], i) => {
      const q = r6(used / b.pieces);
      const line = lines[i];
      if (line) updates.push([line.line_id, itemId, q]);
      else adds.push({ blank: b, first, itemId, quantity: q });
      entry.lines.push({ itemId, itemCode: survey.stockById.get(itemId)?.code ?? null, quantity: q, bars: r6(used) });
    });
    drops.push(...lines.slice(order.length).map((l) => l.line_id));
    out.push(entry);
  }
  await updateBomLines(db, companyId, updates);
  if (drops.length) await db.query('UPDATE cf_bom_lines SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, drops]);
  if (adds.length) {
    const bomIds = [...new Set(adds.map((a) => a.first.bom_id))];
    const [tops] = await db.query(
      `SELECT bom_id, design_id, MAX(position) AS top_position, MAX(CASE WHEN deleted_at IS NULL THEN line_no END) AS top_line
         FROM cf_bom_lines WHERE company_id = ? AND bom_id IN (?) GROUP BY bom_id, design_id`,
      [companyId, bomIds],
    );
    const topLine = new Map();
    const topPos = new Map();
    for (const t of tops) {
      topLine.set(t.bom_id, Math.max(topLine.get(t.bom_id) ?? 0, Number(t.top_line) || 0));
      topPos.set(`${t.bom_id}:${t.design_id}`, Number(t.top_position) || 0);
    }
    const rows = adds.map((a) => {
      const bomId = a.first.bom_id;
      const lineNo = (topLine.get(bomId) ?? 0) + 10;
      topLine.set(bomId, lineNo);
      const k = `${bomId}:${a.first.design_id}`;
      const position = (topPos.get(k) ?? 0) + 1;
      topPos.set(k, position);
      return [companyId, bomId, lineNo, a.itemId, a.first.design_id, position, a.first.role, a.quantity, a.first.selection_definition_id ?? null,
        'Added by section nesting: this cut piece also draws this stock length.', c.userId ?? null];
    });
    await insertRows(db, 'cf_bom_lines', ['company_id', 'bom_id', 'line_no', 'child_id', 'design_id', 'position', 'role', 'quantity', 'selection_definition_id', 'notes', 'created_by'], rows);
  }
  return out;
}

/** POST /accept — plans again (the database decides, not the request) and writes it. */
export async function acceptSectionNesting(db, c, lineId) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, lineId, { lock: true });
  const survey = await surveySections(db, companyId, line);
  await assertSectionNotCut(db, companyId, line, survey.places);
  assertOpen(line);
  assertFrozen(line);
  const { plans, problems } = await freshPlans(db, companyId, line, survey);
  assertNoProblems([...survey.problems, ...placeProblems(survey), ...problems], 'That section nesting cannot be accepted.');
  if (!survey.profiles.size && !survey.barLots.length) {
    throw invalid('NOTHING_TO_NEST', `Line ${line.line_no} of ${line.order_code} has no section cut pieces to lay out on bars.`);
  }
  const written = await writeSectionPlan(db, c, line, survey, plans, { origin: 'auto' });
  return { ...(await getSectionNesting(db, companyId, lineId)), written };
}

/** DELETE — the accepted section nest taken back, while nothing is cut. Blanks go back to their estimate. */
export async function takeBackSectionNesting(db, c, lineId) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, lineId, { lock: true });
  const survey = await surveySections(db, companyId, line, { light: true });
  await assertSectionNotCut(db, companyId, line, survey.places);
  assertOpen(line);
  if (!survey.barLots.length) throw invalid('NOT_NESTED', `Line ${line.line_no} of ${line.order_code} has no accepted section nesting to take back.`);
  const replaced = await clearBarLots(db, c, line.id, survey.barLots);
  const quantities = await chargeStockLines(db, c, survey, []);
  return { ...(await getSectionNesting(db, companyId, lineId)), takenBack: { lots: replaced, quantities } };
}

/**
 * For processService: does the line need section nesting, and is it done?
 *   needed    the line has section cut pieces with pieces to cut
 *   accepted  bar lots are saved AND they place every piece the line needs
 * plus counts and the drift in words. `tree` may be handed in (already exploded).
 */
export async function sectionNestingState(db, companyId, lineId, { tree = null } = {}) {
  const line = await requireLine(db, companyId, lineId);
  const survey = await surveySections(db, companyId, line, { tree, light: true });
  const blanks = [...survey.blanks.values()].filter((b) => b.pieces > 0);
  const needed = blanks.length > 0;
  let placed = new Map();
  if (survey.barLots.length) {
    const [rows] = await db.query(
      'SELECT cut_plate_id, COUNT(*) AS n FROM cf_nest_placements WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL GROUP BY cut_plate_id',
      [companyId, survey.barLots.map((l) => l.id)],
    );
    placed = new Map(rows.map((r) => [Number(r.cut_plate_id), Number(r.n)]));
  }
  const drift = survey.barLots.length ? driftOf(survey, placed) : [];
  return {
    needed,
    accepted: needed && survey.barLots.length > 0 && drift.length === 0,
    cutPieces: blanks.length,
    pieces: blanks.reduce((a, b) => a + b.pieces, 0),
    bars: survey.barLots.length,
    drift,
    problems: [...survey.problems, ...drift.map(driftWords)],
  };
}

/** For the sheet: the line, its survey, and helpers, read once. */
export async function sectionSheetContext(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  const survey = await surveySections(db, companyId, line);
  return { line, survey };
}

export { lineView, planSummary, shapeBars, freshPlans, savedPlans, FREEZE_FIRST, mmText, EPS };
