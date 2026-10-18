/**
 * standardGaps.js — what a standard drawing's BOM still lacks before an order line made from it can be frozen and
 * released, and what of it can be worked out from the drawing's own data (2026-10-18).
 *
 * Production 2026-10-18: RDSO/B-11753R3 v1 made line SO260014/1 with 20 required values blank, 4 section parts with
 * no section and 3 rows with no flow, each found one at a time — at freeze, at "Choose section", at release. This
 * asks the same questions of a standard's version at once, READ-ONLY, with the engine's own readers:
 *
 *   values      processService.missingRequiredValues — what the freeze checklist counts. A specification the ORDER
 *               gives (`order_level`: coats, MS BO / BR) is apart (`orderValues`): the order fills it on the line.
 *   sections    a part cut from a SECTION with no stock bar (explode withCut — the BOM grid's "Choose section")
 *   flows       a made row (temporary item) whose effective flow is none (explode — what release reads)
 *   quantities  a BOM line quantity that is zero, negative or not a whole number of pieces; and a part's pieces a
 *               span against the drawing's own count (bom.json)
 *
 * And for each gap, `derive` when the drawing data says what it is (bom.json under TM/drawing_bom/out/<set>, the
 * part's own values, the catalog), else none — then a person must say. `derive` is { value | optionId | stockId |
 * flowId, how } — `how` is the sentence the report prints.
 *
 * Every statement is a read; `db` may be a read-only wrapper.
 */
import fs from 'fs';
import path from 'path';
import { explode } from '../services/bomService.js';
import { chainsFor, missingRequiredValues } from '../services/processService.js';
import { neededCodesOfFlows } from '../services/flowSpecService.js';
import { readMasters, resolveCodes } from './cutFrom.js';
import { parseSectionSize, profileOfName } from './sectionSize.js';

const rawOf = (r) => (r == null ? null : r.option_id != null ? Number(r.option_id) : r.value_number != null ? Number(r.value_number) : r.value_text ?? (r.value_bool != null ? !!Number(r.value_bool) : r.value_date ?? null));

/**
 * The values a row's FLOW will ask for once the row is on an order line (flowSpecService.syncFlowSpecs runs when a
 * standard is copied to a line — settleLineRows — not on the standard itself, so its version shows none of them).
 * The same decision, read-only: every item.X an operation of the row's flow reads, that the chain does not give by
 * itself, becomes a required rule on the row — typed (no recipe: MISSING unless the row holds its own value) or
 * worked out by a classification's recipe formula (not counted: the formula fills it).
 * → Map(id -> [{ code, name, workedOut }]) of the asks that would be EMPTY on the line.
 */
export async function flowAskedGaps(db, companyId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT m.id, m.default_flow_id,
            (SELECT bl.operation_flow_id FROM cf_bom_lines bl WHERE bl.company_id = m.company_id AND bl.child_id = m.id AND bl.deleted_at IS NULL AND bl.operation_flow_id IS NOT NULL ORDER BY bl.id LIMIT 1) AS line_flow
       FROM cf_master_records m WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`, [companyId, ids]);
  const flowOf = new Map(rows.map((r) => [Number(r.id), r.line_flow ?? r.default_flow_id ?? null]));
  const flowIds = [...new Set([...flowOf.values()].filter((f) => f != null).map(Number))];
  if (!flowIds.length) return out;
  const needOf = await neededCodesOfFlows(db, companyId, flowIds);
  const codes = new Set();
  for (const set of needOf.values()) for (const c of set) codes.add(String(c).toUpperCase());
  if (!codes.size) return out;
  const [specs] = await db.query('SELECT UPPER(code) AS code, name FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, [...codes]]);
  const nameOf = new Map(specs.map((x) => [x.code, x.name]));
  const known = [...codes].filter((c) => nameOf.has(c));
  if (!known.length) return out;
  const masters = await readMasters(db, companyId, ids);
  const resolved = await resolveCodes(db, companyId, masters, known);
  for (const id of ids) {
    const f = flowOf.get(id);
    if (f == null) continue;
    for (const code0 of needOf.get(Number(f)) ?? []) {
      const code = String(code0).toUpperCase();
      if (!nameOf.has(code)) continue;
      const e = resolved.get(id)?.get(code);
      const rule = e?.rule ?? null;
      const how = (e?.below && e.below.applicable && e.below.valueRule === 'defaulted' && e.below.formulaId != null) ? e.below.formulaId : e?.recipe?.formulaId ?? null;
      if (rule && rule.origin === 'flow') { /* already the row's own flow rule — missingRequiredValues counts it */ continue; }
      const worked = !!rule && rule.valueRule === 'defaulted' && rule.formulaId != null;
      if (rule && rule.applicable && rule.valueRule !== 'entered' && !worked) continue;   // comes by itself
      if (rule && rule.applicable && rule.isRequired) continue;                           // asked already (counted there)
      if (rule && !rule.applicable) continue;                                             // switched off above
      if (rawOf(e?.own) != null) continue;                                                // the row holds it
      if (!out.has(id)) out.set(id, []);
      // A formula works it out on the line (a recipe, or the chain's Defaulted formula). It may still come out EMPTY
      // — SO260014: HOLES of the girder segments (NONZERO of the web's drawn holes) and SURFACE_AREA of three
      // assemblies (a SUM that waits for every part) did — so it is listed, marked, for the drawing to settle.
      out.get(id).push({ specCode: code, specName: nameOf.get(code), flowAsked: true, ...(how != null ? { workedOut: true, formulaId: Number(how) } : {}) });
    }
  }
  return out;
}

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const whole = (n) => Math.abs(Number(n) - Math.round(Number(n))) < 1e-6;

/** "RDSO/B-11753R3" → "RDSO_11753R3", "RDSO/B-1534/R" → "RDSO_1534R", "CBS-0055" → "RDSO_CBS-0055". */
export function setFolderOf(number, bomDir) {
  const n = String(number ?? '').toUpperCase().trim();
  const cands = [];
  const m = /^RDSO\/B-([0-9]+)\/?(R\d*)?$/.exec(n);
  if (m) cands.push(`RDSO_${m[1]}${m[2] ?? ''}`, `RDSO_${m[1]}`);
  cands.push(`RDSO_${n.replace(/^RDSO\/?B?-?/, '').replace(/\//g, '')}`, n.replace(/[^A-Z0-9-]+/g, '_'));
  for (const c of cands) if (bomDir && fs.existsSync(path.join(bomDir, c, 'bom.json'))) return c;
  // Last: any set whose bom.json names this drawing number (+ revision).
  if (bomDir && fs.existsSync(bomDir)) {
    for (const d of fs.readdirSync(bomDir)) {
      const f = path.join(bomDir, d, 'bom.json');
      if (!fs.existsSync(f)) continue;
      try {
        const b = JSON.parse(fs.readFileSync(f, 'utf8'));
        const num = `${b.drawing?.number ?? ''}${/^[A-Za-z0-9._/-]{1,20}$/.test(String(b.drawing?.revision ?? '')) ? b.drawing.revision : ''}`.toUpperCase();
        if (num === n || String(b.drawing?.number ?? '').toUpperCase() === n) return d;
      } catch { /* a set that does not read is not this one */ }
    }
  }
  return null;
}

/** bom.json's items by the mark a row carries (planImport gives a duplicated mark the item's id instead). */
export function itemsByRowMark(bom) {
  const count = new Map();
  for (const it of bom?.items ?? []) if (it.mark) count.set(it.mark, (count.get(it.mark) ?? 0) + 1);
  const out = new Map();
  for (const it of bom?.items ?? []) out.set(String(it.mark && count.get(it.mark) > 1 ? it.id : it.mark ?? it.id).toUpperCase(), it);
  return out;
}

/** Pieces of each item a span, from the drawing's tree (bought items included; the caller ignores what is not a row). */
export function piecesPerSpan(bom) {
  const out = new Map();
  const walk = (n, mult) => {
    const q = Number(n.qtyPerParent ?? 1) * mult;
    if (n.item != null) out.set(n.item, (out.get(n.item) ?? 0) + q);
    for (const c of n.children ?? []) walk(c, n.item != null ? mult : q);
  };
  if (bom?.assembly) for (const c of bom.assembly.children ?? []) walk(c, Number(bom.assembly.qtyPerParent ?? 1));
  return out;
}

/** The plate's whole outside surface, m² (both faces and the four edges) — the paint / blast area of one piece. */
export const plateSurfaceM2 = (l, w, t) => (2 * (l * w + l * t + w * t)) / 1e6;

/**
 * What the drawing data says a missing value is. `ctx`: { node, item (bom.json), bom, values (the row's own values by
 * code), spec ({ code, data_type, default_uom, options: Map(UPPER value -> id) }), segment ({ fromMm, toMm }) }.
 * → { value? , optionId?, how } | null.
 */
export function deriveValue(code, ctx) {
  const { item, spec, values = {} } = ctx;
  const C = String(code).toUpperCase();
  const opt = (v) => spec?.options?.get(String(v).toUpperCase()) ?? null;
  const n = (k) => (values[k] == null || values[k] === '' ? null : Number(values[k]));
  const L = n('LENGTH') ?? (Number(item?.lengthMm) || null);
  const W = n('WIDTH') ?? (Number(item?.widthMm) || null);
  const T = n('THICKNESS') ?? (Number(item?.thicknessMm) || null);
  // A girder segment's length is its stretch of the girder in the drawing's layout (GA 0–7650 → 7650 mm).
  if (/SEGMENT.*LENGTH|^LENGTH$/.test(C) && ctx.segment && Number(ctx.segment.toMm) > Number(ctx.segment.fromMm)) {
    return { value: r3(Number(ctx.segment.toMm) - Number(ctx.segment.fromMm)), how: `the drawing's girder layout (${ctx.segment.segment} ${ctx.segment.fromMm}–${ctx.segment.toMm} mm)` };
  }
  // …or, where the drawing gives no layout, the segment's shipping size ("Girder segment ZA (shipping piece 6380 x 650 x 1655)").
  if (C === 'LENGTH' && !ctx.item && /segment/i.test(`${ctx.node?.role ?? ''} ${ctx.node?.name ?? ''}`)) {
    const env = /shipping\s+piece\s+(\d{3,6})\s*[x×*]/i.exec(`${ctx.node?.role ?? ''} ${ctx.node?.name ?? ''}`) ?? /^(\d{3,6})\s*[x×*]/.exec(String(ctx.envelope ?? ''));
    if (env) return { value: Number(env[1]), how: `the segment's shipping size on the drawing (${env[0].replace(/\s*[x×*]$/, '')} …)` };
  }
  if (/^SPAN_LENGTH$/.test(C) && ctx.bom?.assembly) {
    const layout = (ctx.bom.assembly.children ?? []).flatMap((c) => c.layoutMm ?? []);
    const span = layout.length ? Math.max(...layout.map((s) => Number(s.toMm) || 0)) : null;
    if (span) return { value: span, how: 'the drawing\'s girder layout (overall length)' };
  }
  if (C === 'LENGTH' && item && Number(item.lengthMm) > 0) return { value: Number(item.lengthMm), how: 'the drawing\'s part list' };
  if (C === 'WIDTH' && item && Number(item.widthMm) > 0) return { value: Number(item.widthMm), how: 'the drawing\'s part list' };
  if (C === 'THICKNESS' && item && Number(item.thicknessMm) > 0) return { value: Number(item.thicknessMm), how: 'the drawing\'s part list' };
  // An ASSEMBLY's surface: the catalog's own formulas over its parts (CG_ASSY_SURFACE_AREA = SUM(children.SURFACE_AREA),
  // PART_PLATE_AREA = FIRST(TRUE_AREA, LENGTH × WIDTH) / 1e6 — one face), an angle's one face of each leg (a + b) × L.
  // On the line the sum came out EMPTY whenever one part had no area (a section, a stud): here every part has one.
  if (/SURFACE_AREA/.test(C) && ctx.children?.length) {
    const a = assemblyArea(ctx.children);
    if (a.ok && a.m2 > 0) return { value: r3(a.m2), how: `the parts' areas, as the catalog's formulas add them (${a.parts} parts)` };
    return null;
  }
  // A girder segment's holes drilled on the assembly are its WEB's (SEG_HOLES_WEB), through the web's thickness.
  if (/^HOLES$/.test(C) && ctx.children?.length) {
    const webs = ctx.children.filter((k) => /\bweb\b/i.test(k.name) && !/stiffener|cover|splice/i.test(k.name));
    if (webs.length) {
      const h = webs.reduce((t, k) => t + k.quantity * Number(k.values?.DRAWN_HOLES ?? k.item?.holes?.count ?? NaN), 0);
      // None drawn is not "none": SEG_HOLES_WEB refuses 0 on purpose (NONZERO) — a person says.
      if (Number.isFinite(h) && h > 0) return { value: h, how: `the web plate's holes on the drawing (${webs.map((k) => k.mark ?? k.name).join(', ')})` };
    }
    return null;
  }
  if (/HOLE.*(DRILL|THICK)/.test(C) && ctx.children?.length) {
    const web = ctx.children.find((k) => /\bweb\b/i.test(k.name) && !/stiffener|cover|splice/i.test(k.name));
    const t = Number(web?.values?.THICKNESS ?? web?.item?.thicknessMm);
    const holes = Number(web?.values?.DRAWN_HOLES ?? web?.item?.holes?.count ?? 0);
    if (t > 0 && holes > 0) return { value: t, how: `the web plate's thickness (${web.mark ?? web.name}), the plate drilled on the assembly` };
    return null;
  }
  // Holes: the drawing counts them on the part (0 when the part list gives none and the part's DXF shows none).
  if (/^HOLES?(_COUNT)?$|^NO_OF_HOLES$/.test(C) && item) {
    const h = item.holes?.count;
    if (h != null && Number.isFinite(Number(h))) return { value: Number(h), how: `the drawing's part list (${Number(h)} hole${Number(h) === 1 ? '' : 's'}${item.holes?.dia?.length ? ` Ø${item.holes.dia.join('/')}` : ''})` };
  }
  // The thickness a hole is drilled through is the part's own (a single plate drilled on its own).
  if (/HOLE.*(DRILL|THICK)|DRILL.*THICK/.test(C) && T) {
    const h = Number(item?.holes?.count ?? n('HOLES') ?? 0);
    if (h > 0) return { value: T, how: 'the part\'s own thickness (drilled through the plate)' };
    if (item && item.holes != null) return { value: 0, how: 'no holes on the drawing' };
  }
  if (/SURFACE_AREA|PAINT_AREA|BLAST_AREA/.test(C) && L && W && T && (item?.category ?? 'plate') === 'plate') {
    return { value: r3(plateSurfaceM2(L, W, T)), how: `2 × (L×W + L×T + W×T) of the plate ${L} × ${W} × ${T} mm` };
  }
  if (/GIRDER_TYPE/.test(C) && ctx.bom?.drawing && spec?.options?.size) {
    const words = `${ctx.bom.drawing.type ?? ''} ${ctx.bom.drawing.title ?? ''}`.toUpperCase();
    for (const [label, id] of spec.options) {
      const L2 = label.toUpperCase();
      const key = L2.replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !['GIRDER', 'PLATE', 'STEEL', 'TYPE'].includes(w));
      if (key.length && key.every((w) => words.includes(w))) return { optionId: id, display: label, how: `the drawing title ("${String(ctx.bom.drawing.type ?? ctx.bom.drawing.title).slice(0, 60)}")` };
    }
  }
  if (C === 'GRADE' && item?.grade && spec?.options) {
    const g = /\bE\s?(250|275|300|350|410|450)\b/i.exec(String(item.grade));
    if (g && opt(`E${g[1]}`) != null) return { optionId: opt(`E${g[1]}`), display: `E${g[1]}`, how: `the drawing's grade (${item.grade})` };
  }
  return null;
}

/**
 * Will a formula-worked flow ask come out EMPTY on the line? The two shapes seen empty on SO260014 (all other
 * formula asks filled there): an assembly's SURFACE_AREA (SUM(children.SURFACE_AREA) waits for every child — a
 * stud, a section or a part with no size has none), and a segment's HOLES (NONZERO of the web's drawn holes — no
 * holes on the web, nothing). Anything else a formula works out is taken to fill.
 */
export function formulaComesOutEmpty(code, children) {
  const C = String(code).toUpperCase();
  if (!children?.length) return false;
  if (/SURFACE_AREA/.test(C)) {
    const hasArea = (k) => {
      if (k.kind === 'selection') return false;
      if (k.children?.length) return k.children.every(hasArea);
      if (k.cutFrom === 'SECTION' || k.item?.category === 'section') return false;
      const v = k.values ?? {};
      return Number(v.TRUE_AREA) > 0 || (Number(v.LENGTH ?? k.item?.lengthMm) > 0 && Number(v.WIDTH ?? k.item?.widthMm) > 0);
    };
    return !children.every(hasArea);
  }
  if (C === 'HOLES') {
    const webs = children.filter((k) => /\bweb\b/i.test(k.name) && !/stiffener|cover|splice/i.test(k.name));
    const h = webs.reduce((t, k) => t + k.quantity * Number(k.values?.DRAWN_HOLES ?? 0), 0);
    return !(h > 0);
  }
  return false;
}

/** Σ quantity × area over an assembly's parts, recursively; ok=false when a part has no size to go by. */
export function assemblyArea(children) {
  let m2 = 0; let parts = 0; let ok = true;
  for (const k of children) {
    if (k.kind === 'selection' || k.kind === 'catalog') continue;   // a stud, a bought item: not painted with the steel
    if (k.children?.length) { const a = assemblyArea(k.children); if (!a.ok) ok = false; m2 += k.quantity * a.m2; parts += k.quantity * a.parts; continue; }
    const v = k.values ?? {};
    const L = Number(v.LENGTH ?? k.item?.lengthMm); const W = Number(v.WIDTH ?? k.item?.widthMm);
    let a = null;
    if (k.cutFrom === 'SECTION' || k.item?.category === 'section') {
      const D = Number(v.DEPTH ?? 0) || W;
      if (L > 0 && W > 0) a = ((W + D) * L) / 1e6;
    } else if (Number(v.TRUE_AREA) > 0) a = Number(v.TRUE_AREA) / 1e6;
    else if (L > 0 && W > 0) a = (L * W) / 1e6;
    if (a == null) { ok = false; continue; }
    m2 += k.quantity * a; parts += k.quantity;
  }
  return { m2, parts, ok };
}

/**
 * The gaps of the given versions. `versions`: [{ id, standard_id, version_no, root_item_id, number }].
 * opts: { bomDir, cutStockOf?: (profile, grade, lengthMm) => Promise<{ id, code } | null>, flowOf?: (defId) => … }.
 * → [{ versionId, standardId, number, versionNo, set, rows, gaps: { values, orderValues, sections, flows, quantities }, total }]
 */
export async function versionGaps(db, companyId, versions, opts = {}) {
  const out = [];
  let reads = 0;
  const q = async (sql, params) => { reads += 1; return db.query(sql, params); };
  // The specifications once: code, type, order level, options.
  const [specRows] = await q('SELECT id, code, name, data_type, default_uom, order_level FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const specByCode = new Map(specRows.map((s) => [String(s.code).toUpperCase(), { ...s, options: new Map() }]));
  const [optRows] = await q(
    `SELECT o.id, o.value, o.label, s.code FROM cf_spec_options o JOIN cf_specifications s ON s.id = o.specification_id
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND o.deleted_at IS NULL`, [companyId],
  ).catch(() => [[]]);
  for (const o of optRows) { const s = specByCode.get(String(o.code).toUpperCase()); if (s) { s.options.set(String(o.value).toUpperCase(), o.id); if (o.label) s.options.set(String(o.label).toUpperCase(), o.id); } }

  for (const v of versions) {
    const tree = await explode(db, companyId, Number(v.root_item_id), { rootQuantity: 1, withCut: true });
    reads += 3 + (tree.stats?.maxDepth ?? 0) + 3;
    const nodes = [];
    const walk = (nd, trail, parent) => {
      const label = nd.role || nd.shortName || nd.name;
      const p = [...trail, label];
      nodes.push({ nd, path: p.join(' › '), parent });
      for (const k of nd.children ?? []) walk(k, p, nd);
    };
    walk(tree.root, [], null);
    const temps = nodes.filter((x) => x.nd.kind === 'temporary');
    const ids = [...new Set(temps.map((x) => Number(x.nd.id)))];
    const [masters] = ids.length ? await q(
      `SELECT m.id, m.classification_id, i.source_definition_id, d.name AS def_name, d.code AS def_code
         FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
         LEFT JOIN cf_master_records d ON d.id = i.source_definition_id
        WHERE m.company_id = ? AND m.id IN (?)`, [companyId, ids]) : [[]];
    const masterOf = new Map(masters.map((m) => [Number(m.id), m]));
    // The rows' own values (marks, sizes) — one read.
    const [vals] = ids.length ? await q(
      `SELECT v.subject_id, UPPER(s.code) AS code, v.value_number, v.value_text, v.option_id, o.value AS option_value
         FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
         LEFT JOIN cf_spec_options o ON o.id = v.option_id
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL`, [companyId, ids]) : [[]];
    const valuesOf = new Map();
    for (const r of vals) {
      if (!valuesOf.has(Number(r.subject_id))) valuesOf.set(Number(r.subject_id), {});
      valuesOf.get(Number(r.subject_id))[r.code] = r.value_number != null ? Number(r.value_number) : r.option_value ?? r.value_text ?? (r.option_id != null ? Number(r.option_id) : null);
    }
    const chains = await chainsFor(db, companyId, masters.map((m) => ({ id: Number(m.id), classification_id: m.classification_id, source_definition_id: m.source_definition_id })));
    reads += 4;
    const missing = await missingRequiredValues(db, companyId, chains);
    const asked = await flowAskedGaps(db, companyId, ids);
    reads += 7;

    // The drawing's data: given (an import has it in hand), else the set folder of the standard's number.
    const set = opts.bom ? (opts.bom.set ?? 'given') : opts.bomDir ? setFolderOf(v.number, opts.bomDir) : null;
    let bom = opts.bom ?? null;
    if (!bom && set) { try { bom = JSON.parse(fs.readFileSync(path.join(opts.bomDir, set, 'bom.json'), 'utf8')); } catch { bom = null; } }
    const byMark = bom ? itemsByRowMark(bom) : new Map();
    const segments = new Map((bom?.assembly?.children ?? []).flatMap((g) => (g.layoutMm ?? []).map((s) => [String(s.segment).toUpperCase(), s])));
    const itemOf = (id) => byMark.get(String(valuesOf.get(id)?.DRAWING_MARK ?? '').toUpperCase()) ?? null;
    const segmentOf = (id) => segments.get(String(valuesOf.get(id)?.DRAWING_MARK ?? '').toUpperCase()) ?? null;

    const kidCtx = (nd) => (nd.children ?? []).map((k) => ({ id: Number(k.id), kind: k.kind, name: `${k.role ?? ''} ${k.name ?? ''}`, quantity: Number(k.quantity), cutFrom: k.cutFrom ?? null,
      values: valuesOf.get(Number(k.id)) ?? {}, item: itemOf(Number(k.id)), mark: valuesOf.get(Number(k.id))?.DRAWING_MARK ?? null, children: kidCtx(k) }));
    const gaps = { values: [], orderValues: [], sections: [], flows: [], quantities: [] };
    for (const x of temps) {
      const id = Number(x.nd.id);
      const m = masterOf.get(id);
      const miss = [...(missing.get(id)?.missing ?? []), ...(asked.get(id) ?? [])];
      for (const s of miss) {
        if (s.workedOut && !formulaComesOutEmpty(s.specCode, (x.nd.children ?? []).length ? kidCtx(x.nd) : null)) continue;
        const spec = specByCode.get(String(s.specCode).toUpperCase());
        const row = { itemId: id, bomLineId: x.nd.lineId ?? null, path: x.path, mark: valuesOf.get(id)?.DRAWING_MARK ?? null, definition: m?.def_name ?? null, specCode: s.specCode, specName: s.specName, ...(s.flowAsked ? { flowAsked: true } : {}), ...(s.workedOut ? { workedOut: true, formulaId: s.formulaId } : {}) };
        if (spec && Number(spec.order_level)) { gaps.orderValues.push(row); continue; }
        const d = deriveValue(s.specCode, { node: x.nd, item: itemOf(id), bom, values: valuesOf.get(id) ?? {}, spec, segment: segmentOf(id), children: (x.nd.children ?? []).length ? kidCtx(x.nd) : null });
        gaps.values.push(d ? { ...row, derive: d } : row);
      }
      if (x.nd.cutFrom === 'SECTION' && !x.nd.cutStock) {
        const it = itemOf(id);
        const vals2 = valuesOf.get(id) ?? {};
        const profile = it?.profile ?? (vals2.WIDTH && vals2.DEPTH && vals2.THICKNESS ? `ISA ${vals2.WIDTH} x ${vals2.DEPTH} x ${vals2.THICKNESS}` : null);
        // The grade as the catalog names it: the row's own GRADE, else the drawing's ("IS 2062 … Gr B" is E250 today).
        const gradeText = String(vals2.GRADE ?? (/\bE\s?(250|275|300|350|410|450)\b/i.exec(String(it?.grade ?? ''))?.[0] ?? (/IS\s*2062|IS\s*226|IRS/i.test(String(it?.grade ?? '')) ? 'E250' : ''))).replace(/\s+/g, '');
        const impact = vals2.IMPACT_CLASS ?? null;
        const grade = `${gradeText}${impact ?? ''}`;
        const bar = opts.cutStockOf && profile ? await opts.cutStockOf(profile, gradeText, Number(vals2.LENGTH ?? it?.lengthMm) || null, impact) : null;
        gaps.sections.push({ itemId: id, path: x.path, mark: vals2.DRAWING_MARK ?? null, definition: m?.def_name ?? null, profile, grade: grade || null, lengthMm: Number(vals2.LENGTH ?? it?.lengthMm) || null, ...(bar ? { derive: bar } : {}) });
      }
      if (!x.nd.flow) {
        const f = opts.flowOf && m?.source_definition_id ? await opts.flowOf(Number(m.source_definition_id)) : null;
        gaps.flows.push({ itemId: id, bomLineId: x.nd.lineId ?? null, path: x.path, mark: valuesOf.get(id)?.DRAWING_MARK ?? null, definition: m?.def_name ?? null, definitionId: m?.source_definition_id ?? null, ...(f ? { derive: f } : {}) });
      }
    }
    // Quantities: every BOM line, and a part's pieces a span against the drawing's count.
    const pieces = new Map();
    for (const x of nodes) {
      if (!x.nd.lineId) continue;
      const qn = Number(x.nd.quantity);
      if (!(qn > 0)) gaps.quantities.push({ itemId: Number(x.nd.id), bomLineId: x.nd.lineId, path: x.path, problem: `quantity ${qn}` });
      else if ((x.nd.kind === 'temporary' || x.nd.kind === 'selection') && !whole(qn)) gaps.quantities.push({ itemId: Number(x.nd.id), bomLineId: x.nd.lineId, path: x.path, problem: `quantity ${qn} is not a whole number of pieces` });
      const mark = valuesOf.get(Number(x.nd.id))?.DRAWING_MARK;
      if (mark && !(x.nd.children ?? []).length) pieces.set(String(mark).toUpperCase(), (pieces.get(String(mark).toUpperCase()) ?? 0) + Number(x.nd.total));
    }
    if (bom) {
      const want = piecesPerSpan(bom);
      for (const [mark, got] of pieces) {
        const it = byMark.get(mark);
        if (!it || !want.has(it.id)) continue;
        const w = want.get(it.id);
        if (Math.abs(w - got) > 1e-6) gaps.quantities.push({ itemId: null, bomLineId: null, path: `mark ${mark} (${it.description ?? ''})`.trim(), problem: `${r3(got)} pieces a span in the BOM, the drawing counts ${r3(w)}` });
      }
    }
    const total = gaps.values.length + gaps.sections.length + gaps.flows.length + gaps.quantities.length;
    out.push({ versionId: Number(v.id), standardId: Number(v.standard_id), number: v.number, versionNo: Number(v.version_no), set, rows: temps.length, gaps, total });
  }
  return { versions: out, reads };
}

/**
 * The catalog readers the gap list uses for its suggestions: the stock bar a section part is cut from, and the flow
 * a definition's rows are made by elsewhere. Read-only.
 */
export async function gapReaders(db, companyId) {
  const { sectionNearest } = await import('../routes/cutting.js');
  const barCache = new Map();
  /**
   * The catalog bar a section part is cut from: the drawing's size AND profile (an ISMC 200 is not an ISA 200 × 100 —
   * the picker's fallback to any profile is not taken here), the part's grade, the longest stock length that holds
   * the part. The impact class (BO / BR / A) is part of the bar (ISA-…-E250BR): a row that holds its own class takes
   * that bar; a row whose class the ORDER gives gets one candidate per class (`byClass`) — the fix script needs
   * --section-class to choose, because the standard cannot know the order's.
   */
  const cutStockOf = async (profile, grade, lengthMm, impact = null) => {
    const k = `${profile}|${grade}|${lengthMm}|${impact}`;
    if (barCache.has(k)) return barCache.get(k);
    const r = await sectionNearest(db, companyId, { search: profile });
    const want = parseSectionSize(profile);
    const fam = (w) => (w === 'L' ? 'ISA' : w);
    // An angle whose thickness the drawing does not show ("L 100x75 (thickness not shown)") is a person's to choose.
    if (want && fam(want.profile) === 'ISA' && want.dims.length < 3) { barCache.set(k, null); return null; }
    const g = String(grade ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const bars = (r.exact ?? [])
      .filter((b) => !want?.profile || fam(profileOfName(b.name)) === fam(want.profile) || fam(profileOfName(b.code)) === fam(want.profile))
      .filter((b) => !lengthMm || !b.lengthMm || Number(b.lengthMm) >= lengthMm);
    const tail = (b) => String(b.code ?? '').toUpperCase().split('-').pop();            // "E250BR"
    const ofGrade = g ? bars.filter((b) => tail(b).startsWith(g) || String(b.grade ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') === g) : [];
    const longest = (list) => list.slice().sort((a, b) => Number(b.lengthMm ?? 0) - Number(a.lengthMm ?? 0))[0] ?? null;
    const view = (b, cls) => ({ stockId: Number(b.id), code: b.code, how: `catalog bar of the drawing's size, profile and grade (${profile}, ${g}${cls ?? ''})` });
    let out = null;
    if (ofGrade.length) {
      if (impact) {
        const b = longest(ofGrade.filter((x) => tail(x) === `${g}${String(impact).toUpperCase()}`));
        out = b ? view(b, String(impact).toUpperCase()) : null;
      } else {
        const byClass = {};
        for (const cls of ['BR', 'BO', 'A', 'C']) { const b = longest(ofGrade.filter((x) => tail(x) === `${g}${cls}`)); if (b) byClass[cls] = view(b, cls); }
        const plain = longest(ofGrade.filter((x) => tail(x) === g));
        if (plain) out = view(plain, '');
        else if (Object.keys(byClass).length) out = { byClass, code: Object.values(byClass).map((x) => x.code).join(' / '), how: `catalog bars of the drawing's size and grade, one per impact class — the class is the order's (${Object.keys(byClass).join(', ')})` };
      }
    }
    barCache.set(k, out);
    return out;
  };
  // The flow this definition is made by elsewhere: rows of the same definition that have one, the most used.
  const flowCache = new Map();
  const flowOf = async (defId) => {
    if (flowCache.has(defId)) return flowCache.get(defId);
    const [rows] = await db.query(
      `SELECT COALESCE(l.operation_flow_id, m.default_flow_id) AS flow_id, f.code, f.name, COUNT(*) AS n
         FROM cf_item_details i
         JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL
         LEFT JOIN cf_bom_lines l ON l.company_id = i.company_id AND l.child_id = i.master_id AND l.deleted_at IS NULL
         JOIN cf_operation_flows f ON f.id = COALESCE(l.operation_flow_id, m.default_flow_id) AND f.deleted_at IS NULL AND f.status = 'active' AND f.owner_order_line_id IS NULL
        WHERE i.company_id = ? AND i.source_definition_id = ? AND i.deleted_at IS NULL
        GROUP BY COALESCE(l.operation_flow_id, m.default_flow_id), f.code, f.name ORDER BY n DESC LIMIT 2`, [companyId, defId]).catch(() => [[]]);
    const top = rows[0];
    const out = top && (!rows[1] || Number(rows[1].n) * 3 <= Number(top.n)) ? { flowId: Number(top.flow_id), code: top.code, how: `the flow the same part has on ${top.n} other row${Number(top.n) === 1 ? '' : 's'}` } : null;
    flowCache.set(defId, out);
    return out;
  };
  return { cutStockOf, flowOf };
}

/** Every standard (or `only` numbers), its current version or all of them, with the lines made from each. */
export async function checkStandards(db, companyId, { only = null, allVersions = false, bomDir = null } = {}) {
  const [vers] = await db.query(
    `SELECT v.id, v.standard_id, v.version_no, v.root_item_id, v.note, s.number, s.current_version_id
       FROM cf_standard_drawings s JOIN cf_standard_drawing_versions v ON v.company_id = s.company_id AND v.standard_id = s.id AND v.deleted_at IS NULL
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND v.root_item_id IS NOT NULL ORDER BY s.number, v.version_no`, [companyId]);
  const pickV = vers.filter((v) => (allVersions || Number(v.id) === Number(v.current_version_id)) && (!only || only.some((o) => o.toLowerCase() === String(v.number).toLowerCase())));
  const [lines] = await db.query(
    `SELECT l.id, l.standard_version_id, o.code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id
      WHERE l.company_id = ? AND l.standard_version_id IS NOT NULL AND l.deleted_at IS NULL`, [companyId]);
  const { cutStockOf, flowOf } = await gapReaders(db, companyId);
  const res = await versionGaps(db, companyId, pickV, { bomDir, cutStockOf, flowOf });
  const usedBy = (vid) => lines.filter((l) => Number(l.standard_version_id) === vid).map((l) => `${l.code}#${l.id}`);
  return {
    companyId,
    reads: res.reads + 2,
    standards: res.versions.map((v) => ({ ...v, usedByLines: usedBy(v.versionId), current: pickV.find((x) => Number(x.id) === v.versionId)?.current_version_id === v.versionId })),
  };
}
