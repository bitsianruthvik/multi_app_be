/**
 * modelValueService.js — VALUES FROM THE 3D MODEL (2026-11-08, TM/plans/values-from-model.md, init.sql §100).
 *
 * User, 2026-11-08: "We are first putting BOM, then for each line it is getting refreshed which makes no sense. The values
 * will be wrong anyway, because only when we upload the 3D json can it infer most values. The values should compute when
 * we upload the 3D json. Until then only manual fill."
 *
 * applyModel(db, c, { versionId | lineId, bom? }) reads the structure's ONE model (cf_standard_drawing_files kind 'model',
 * the standard's latest) and the version's / line's part files, and writes per row, by its DRAWING_MARK (lib/modelValues.js
 * does the geometry, pure):
 *   part rows      LENGTH / WIDTH / THICKNESS (the part file's flat shape where there is one, else the model's), the HOLES
 *                  count and HOLE_SET, the drawing facts (TRUE_AREA, DRAWN_HOLES, DRAWN_HOLE_DIA, DRAWN_EDGE_LENGTH,
 *                  DRAWN_HOLE_SET — drawingValueService.factsOfShape, the same formulas), SURFACE_AREA (both faces and
 *                  every edge), HOLE_DRILL_THICKNESS (the most a bolt through the part's holes clamps: its grip)
 *   assembly rows  weld length (its T-joints, a fillet each side, model) and weld size (bom.json `welds`, when given)
 *   piece counts   the model's pieces per mark against the BOM's — REPORTED, never written
 *
 * RULES (decisions of 2026-11-08):
 *   1. The model's value wins (user, 2026-11-08: "I want the calculated one, not the typed one"): a typed value
 *      (source 'entered') the model says otherwise is REPLACED and listed in `replaced` ("was 9135, model 9133.681").
 *      Only a drawing fact (drawingValueService, from the part's own file) that differs is listed as a disagreement.
 *   2. Order choices (grade, impact class, coats) are never written — the model does not know them.
 *   3. Computed on the standard's VERSION when its model is attached; a line made or replaced from that version copies
 *      the values with the rows (treeCopyService keeps the source). A line can be computed on its own too.
 * A value is written only where the row asks for it with a rule a person could type (entered, or defaulted with no
 * formula — a formula works its value out from these), or for the drawing facts (they need no rule). Written with source
 * 'model': the row's own value for resolution, not a typed one. A re-upload rewrites only 'model' values (and clears those
 * the new model no longer gives). A LOCKED, released or closed line: the differences are reported, nothing is written.
 *
 * ROUND TRIPS (production ~50 ms each): never resolve()/setValues() a row at a time. One loadContext (8–9 reads) — two for
 * a version, whose rows first get their flow rules (flowSpecService.syncFlowSpecs, set-based) — the model and the part
 * files (2 reads), then orderValuesService.applyOwnWrites: the rows, their formulas and roll-ups worked out in memory and
 * the NET difference flushed in a few multi-row statements; one more loadContext to count what is still open; one
 * refreshCutPieces for a line; one INSERT of the run.
 */
import { invalid, notFound } from '../lib/errors.js';
import { marksOfModel, holeDrillThickness, weldLengths, weldSizeFor, inUom, normMark } from '../lib/modelValues.js';
import { holeSetOf, sameList } from '../lib/listSpec.js';
import { factsOfShape } from './drawingValueService.js';
import { DRAWING_FACT_SPECS, LIST_FACT_SPECS, LOCKED_ORDER_STATUSES } from './records.js';
import { isWorkedDefault } from './resolutionService.js';

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

/** What each kind of code is, by its name (the tenant's own codes vary: HOLES / NO_OF_HOLES, MIG_WELD_LENGTH …). */
const HOLE_COUNT = /^HOLES?(_COUNT)?$|^NO_OF_HOLES$/;
const DRILL = /HOLE.*(DRILL|THICK)|DRILL.*THICK/;
const WELD_LEN = /WELD.*LEN/;
const WELD_SIZE = /WELD.*SIZE/;
/** The specifications the 3D model fills — the Values screen says "waiting for the 3D model" on these while none is attached. */
export function isModelCode(code) {
  const C = String(code ?? '').toUpperCase();
  return ['LENGTH', 'WIDTH', 'THICKNESS', 'HOLE_SET', 'SURFACE_AREA'].includes(C) || DRAWING_FACT_SPECS.has(C)
    || HOLE_COUNT.test(C) || DRILL.test(C) || WELD_LEN.test(C) || WELD_SIZE.test(C);
}
const COUNT_CODES = (C) => HOLE_COUNT.test(C) || C === 'DRAWN_HOLES';
const MM_CODES = (C) => ['LENGTH', 'WIDTH', 'THICKNESS', 'DRAWN_HOLE_DIA'].includes(C) || DRILL.test(C) || WELD_LEN.test(C) || WELD_SIZE.test(C);

/** Equal for this code: counts exactly, sizes within 1 mm (either way round is decided by the caller), others within 0.5 %. */
export function sameFor(code, a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && sameList(a, b);
  if (a == null || b == null) return a == null && b == null;
  const x = Number(a); const y = Number(b);
  if (COUNT_CODES(code)) return x === y;
  if (MM_CODES(code)) return Math.abs(x - y) <= 1;
  return Math.abs(x - y) <= Math.max(1e-6, 0.005 * Math.max(Math.abs(x), Math.abs(y)));
}

const held = (row) => {
  if (!row) return null;
  if (row.value_json != null) return parseJson(row.value_json);
  if (row.value_number != null) return Number(row.value_number);
  return null;
};
const words = (code, v, uom) => (v == null ? '—' : Array.isArray(v) ? (v.length ? v.map((x) => `${x.COUNT} × Ø${x.DIA}`).join(', ') : 'no holes') : `${Number(r3(v))}${uom ? ` ${uom}` : ''}`);

/** The target: a version or a line, its tree's root, its standard, and whether it is frozen. */
async function targetOf(db, companyId, { versionId, lineId }) {
  if (versionId != null) {
    const [[v]] = await db.query('SELECT id, standard_id, version_no, root_item_id FROM cf_standard_drawing_versions WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(versionId)]);
    if (!v) throw notFound('Version of the standard drawing');
    if (!v.root_item_id) throw invalid('NO_BOM', `Version ${v.version_no} has no BOM.`);
    return { kind: 'version', id: Number(v.id), standardId: Number(v.standard_id), rootId: Number(v.root_item_id), frozen: null, label: `version ${v.version_no}` };
  }
  if (lineId == null) throw invalid('NO_TARGET', 'Say which version or line the model is applied to.');
  const [[l]] = await db.query(
    `SELECT l.id, l.line_no, l.item_id, l.standard_id, l.locked_at, o.code AS order_code, o.status AS order_status,
            EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS released
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`, [companyId, Number(lineId)]);
  if (!l) throw notFound('Order line');
  if (!l.item_id) throw invalid('NO_BOM', `Line ${l.line_no} of ${l.order_code} has no BOM.`);
  const frozen = LOCKED_ORDER_STATUSES.has(l.order_status) ? `${l.order_code} is ${l.order_status}` : Number(l.released) ? 'released to production' : l.locked_at ? 'locked' : null;
  return { kind: 'line', id: Number(l.id), standardId: l.standard_id ? Number(l.standard_id) : null, rootId: Number(l.item_id), frozen, label: `${l.order_code} line ${l.line_no}` };
}

/** The standard's ONE model (the latest live one), or null. */
export async function modelFileOf(db, companyId, standardId, { text = true } = {}) {
  if (!standardId) return null;
  const [[f]] = await db.query(
    `SELECT id, file_name${text ? ', file_text' : ''} FROM cf_standard_drawing_files
      WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [companyId, standardId]);
  return f ?? null;
}

/** The target's part files, lean (never the geometry megabytes): Map markNorm → { lengthMm, widthMm, areaMm2, cutLengthMm, holes, holeDiameters }. */
async function partFilesOf(db, companyId, target) {
  const [rows] = target.kind === 'version'
    ? await db.query(
      `SELECT mark_norm, length_mm, width_mm, area_mm2, cut_length_mm, holes, JSON_EXTRACT(geometry_json, '$.holeDiameters') AS dias
         FROM cf_standard_drawing_files WHERE company_id = ? AND version_id = ? AND kind = 'part' AND deleted_at IS NULL AND geometry_json IS NOT NULL`, [companyId, target.id])
    : await db.query(
      `SELECT mark_norm, length_mm, width_mm, area_mm2, cut_length_mm, holes, JSON_EXTRACT(geometry_json, '$.holeDiameters') AS dias
         FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND file_kind = 'dxf' AND deleted_at IS NULL AND geometry_json IS NOT NULL`, [companyId, target.id]);
  const out = new Map();
  for (const f of rows) {
    if (!f.mark_norm || out.has(f.mark_norm)) continue;
    const L = Number(f.length_mm); const W = Number(f.width_mm);
    out.set(f.mark_norm, {
      lengthMm: Math.max(L, W), widthMm: Math.min(L, W), areaMm2: f.area_mm2 == null ? null : Number(f.area_mm2),
      cutLengthMm: f.cut_length_mm == null ? null : Number(f.cut_length_mm), holes: f.holes == null ? null : Number(f.holes),
      holeDiameters: (parseJson(f.dias) ?? []).map(Number),
    });
  }
  return out;
}

/**
 * PURE: what the model gives one row — Map CODE → { value (mm / mm² / count / list rows), kind: 'len' | 'area' | 'count' | 'list' }.
 * `info` { mark (norm), shape (marksOfModel's), file (part file, lean), drill, weld, weldSize }; `specCodes` the tenant's codes.
 * Also → `missing` [{ code, why }] for what this row would take and the model cannot say.
 */
export function valuesForRow(info, specCodes) {
  const out = new Map(); const missing = [];
  const put = (code, value, kind) => { if (value != null && !(typeof value === 'number' && !Number.isFinite(value))) out.set(code, { value, kind }); };
  const codes = [...specCodes];
  const s = info.shape; const f = info.file;
  if (s && s.kind !== 'studs') {
    const plate = s.kind === 'plate';
    const L = f && plate ? f.lengthMm : s.lengthMm; const W = f && plate ? f.widthMm : s.widthMm;
    const holes = f && plate ? f.holes : s.holes; const dias = f && plate ? f.holeDiameters : s.holeDiameters;
    put('LENGTH', L, 'len');
    if (plate) put('WIDTH', W, 'len');
    if (L == null && s.how === 'bent') missing.push({ code: 'LENGTH', why: 'a bent plate: its flat size comes from its part file' });
    put('THICKNESS', s.t, 'len');
    if (holes != null) {
      for (const C of codes.filter((x) => HOLE_COUNT.test(x))) put(C, holes, 'count');
      put('HOLE_SET', holeSetOf(dias) ?? [], 'list');
    }
    // The drawing facts: from the part file (the same as drawingValueService), else the model's own outline.
    const shape = f && plate ? f : plate && s.areaMm2 != null ? s : null;
    if (shape) {
      const facts = factsOfShape({ areaMm2: shape.areaMm2, cutLengthMm: shape.cutLengthMm, holes: shape.holes, holeDiameters: shape.holeDiameters });
      for (const [code, v] of Object.entries(facts)) put(code, v, LIST_FACT_SPECS.has(code) ? 'list' : code === 'DRAWN_HOLES' ? 'count' : code === 'TRUE_AREA' ? 'area' : 'len');
      // Both faces and every edge (user, 2026-11-01: "when they do any coat, they will need entire surface area").
      if (facts.TRUE_AREA != null && facts.DRAWN_EDGE_LENGTH != null && s.t) put('SURFACE_AREA', 2 * facts.TRUE_AREA + facts.DRAWN_EDGE_LENGTH * s.t, 'area');
    }
    const drill = info.drill?.grip ?? (holes > 0 && s.t ? s.t : holes === 0 ? 0 : null);
    for (const C of codes.filter((x) => DRILL.test(x))) put(C, drill, 'len');
  }
  if (info.weld) {
    for (const C of codes.filter((x) => WELD_LEN.test(x))) {
      if (info.weld.mm > 0) put(C, info.weld.mm, 'len');
      else missing.push({ code: C, why: info.weld.skipped ? `too many pieces to look at (${info.weld.skipped})` : 'no T-joint between its plates in the model' });
    }
    for (const C of codes.filter((x) => WELD_SIZE.test(x))) {
      if (info.weldSize) put(C, info.weldSize, 'len'); else missing.push({ code: C, why: 'the drawing set gives no weld size for it' });
    }
  }
  return { values: out, missing };
}

/** How many required values are still open on the own rows of a resolved set. */
const openRequired = (resolved) => {
  let n = 0;
  for (const r of resolved.values()) for (const s of r.specs) if (s.applicable && s.captureAt === 'item' && s.status === 'missing') n += 1;
  return n;
};

/**
 * Applies the model to a standard version or an order line. Needs a transaction (the caller's).
 * opts: { versionId | lineId, bom? (the set's bom.json: its `welds`), record? (default true: keep the run) }.
 * → { target, model, applied, rows, written, cleared, unchanged, kept, disagreements, notDerivable, notAsked, pieces,
 *     openRequired: { before, after }, records, values, cutPieces?, skipped? }
 */
export async function applyModel(db, c, opts = {}) {
  const { companyId } = c;
  const target = await targetOf(db, companyId, opts);
  const out = { target: { kind: target.kind, id: target.id, label: target.label, standardId: target.standardId }, applied: false, rows: 0,
    written: 0, cleared: 0, unchanged: 0, kept: 0, disagreements: [], notDerivable: [], notAsked: 0, pieces: [], openRequired: null, records: 0, values: 0 };
  const file = await modelFileOf(db, companyId, target.standardId);
  if (!file) return { ...out, skipped: 'no_model' };
  const model = typeof file.file_text === 'string' ? JSON.parse(file.file_text) : file.file_text;
  if (!model || !Array.isArray(model.elements) || !model.parts) throw invalid('NOT_A_MODEL', `File ${file.file_name} is not a cf-erp-model3d model.`);
  out.model = { fileId: Number(file.id), fileName: file.file_name, title: model.title ?? null, elements: model.elements.length };

  const { loadContext, resolveOwnRows, applyOwnWrites } = await import('./orderValuesService.js');
  const load = () => (target.kind === 'version' ? loadContext(db, companyId, null, { rootItemId: target.rootId }) : loadContext(db, companyId, target.id));
  let ctx = await load();
  if (target.kind === 'version') {
    // A version's rows get the rules their flows ask for first (what a line does when it is made), so the values the
    // flows need can be held here and copied with the rows.
    const ids = [...resolveOwnRows(ctx).keys()];
    if (ids.length) {
      const { syncFlowSpecs } = await import('./flowSpecService.js');
      const res = await syncFlowSpecs(db, c, ids, { settle: false });
      if (res && (res.added.length || res.changed.length || res.removed.length)) ctx = await load();
    }
  }
  const resolved = resolveOwnRows(ctx);
  out.rows = resolved.size;
  out.openRequired = { before: openRequired(resolved), after: null };

  const [[specRows], files] = await Promise.all([
    db.query('SELECT id, UPPER(code) AS code, data_type, default_uom FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    partFilesOf(db, companyId, target),
  ]);
  const specByCode = new Map(specRows.map((s) => [s.code, { id: Number(s.id), code: s.code, data_type: s.data_type, default_uom: s.default_uom }]));
  const markSpec = specByCode.get('DRAWING_MARK');
  if (!markSpec) return { ...out, skipped: 'no_drawing_mark' };
  const modelCodes = new Set([...specByCode.keys()].filter(isModelCode));

  const marks = marksOfModel(model);
  const drill = holeDrillThickness(model);
  const welds = weldLengths(model);
  const levelNames = new Map(Object.entries(model.levels ?? {}).map(([k, v]) => [normMark(k), v?.name ?? k]));

  const writes = []; const bomQty = new Map();
  const ownOf = (id) => ctx.store.get(`master:${id}`) ?? new Map();
  // The BOM's pieces per mark: the product of quantities down from the root (one structure).
  const walk = (id, mult, guard = 0) => {
    if (guard > 40) return;
    const mr = ownOf(id).get(markSpec.id);
    const text = mr?.value_text ?? (mr?.value_number != null ? String(Number(mr.value_number)) : null);
    if (text && resolved.has(id)) { const m = normMark(text); bomQty.set(m, (bomQty.get(m) ?? 0) + mult); }
    for (const l of ctx.linesByParent.get(id) ?? []) walk(l.childId, mult * Number(l.quantity), guard + 1);
  };
  walk(ctx.line.itemId, 1);

  for (const [id, r] of resolved) {
    const own = ownOf(id);
    const markRow = own.get(markSpec.id);
    const markText = markRow?.value_text ?? (markRow?.value_number != null ? String(Number(markRow.value_number)) : null);
    const m = markText ? normMark(markText) : null;
    const rec = ctx.records.get(id);
    const info = { mark: m, shape: m ? marks.get(m)?.shape ?? null : null, file: m ? files.get(m) ?? null : null, drill: m ? drill.get(m) ?? null : null,
      weld: m && welds.has(m) ? welds.get(m) : null, weldSize: null };
    if (info.weld) info.weldSize = weldSizeFor(opts.bom?.welds, `${rec?.name ?? ''} ${levelNames.get(m) ?? ''}`)?.mm ?? null;
    const known = !!(info.shape || info.weld);
    const { values, missing } = known ? valuesForRow(info, modelCodes) : { values: new Map(), missing: [] };
    if (m && !known && !marks.has(m)) out.notDerivable.push({ recordId: id, mark: markText, why: 'not in the model' });
    if (m && marks.get(m)?.variantsDiffer) out.notDerivable.push({ recordId: id, mark: markText, why: 'its pieces differ in the model (another outline, thickness or holes) — the first one is used' });
    const asks = new Map(r.specs.filter((s) => s.applicable && s.captureAt === 'item').map((s) => [s.spec.code.toUpperCase(), s]));
    for (const mi of missing) if (asks.has(mi.code)) out.notDerivable.push({ recordId: id, mark: markText, code: mi.code, why: mi.why });

    for (const code of modelCodes) {
      const spec = specByCode.get(code);
      const isFact = DRAWING_FACT_SPECS.has(code);
      const ask = asks.get(code);
      const want = values.get(code) ?? null;
      const row = own.get(spec.id) ?? null;
      // A fact on a LINE row with its own part file is the drawing's (drawingValueService keeps it); not written twice.
      if (isFact && target.kind === 'line' && info.file) continue;
      const may = isFact || (ask && ['entered', 'defaulted'].includes(ask.rule.valueRule) && !isWorkedDefault(ask.rule));
      if (!may) { if (want && ask) out.notAsked += 1; continue; }
      const value = want == null ? null : want.kind === 'list' ? want.value : r3(inUom(want.value, want.kind, spec.default_uom));
      if (value == null) {
        if (row?.source === 'model') { writes.push({ recordId: id, spec, typed: null, source: 'model' }); out.cleared += 1; }
        continue;
      }
      const now = held(row);
      // LENGTH and WIDTH are one rectangle: typed the other way round is the same plate.
      const pairSame = (code === 'LENGTH' || code === 'WIDTH') && (() => {
        const other = specByCode.get(code === 'LENGTH' ? 'WIDTH' : 'LENGTH');
        const o = other ? held(own.get(other.id)) : null; const ow = values.get(other?.code)?.value;
        return o != null && ow != null && sameFor(code, now, inUom(ow, 'len', spec.default_uom)) && sameFor(code, o, value);
      })();
      const same = now != null && (sameFor(code, now, value) || pairSame);
      if (!row || row.source === 'model' || row.source === 'defaulted') {
        if (row?.source === 'model' && same) { out.unchanged += 1; continue; }
        writes.push({ recordId: id, spec, typed: Array.isArray(value) ? { value_json: value } : { value_number: value }, source: 'model' });
        out.written += 1;
      } else if (row.source === 'entered') {
        if (same) { out.kept += 1; continue; }
        // User, 2026-11-08: "I want the calculated one, not the typed one." The model's value replaces a typed one
        // (a fact the drawing wrote stays the drawing's); every replacement is listed with what was there.
        if (!isFact) {
          writes.push({ recordId: id, spec, typed: Array.isArray(value) ? { value_json: value } : { value_number: value }, source: 'model' });
          out.written += 1;
          out.replaced = out.replaced ?? [];
          out.replaced.push({ recordId: id, mark: markText, row: rec?.name ?? null, code, was: now, model: value, wasText: words(code, now, spec.default_uom), modelText: words(code, value, spec.default_uom) });
          continue;
        }
        out.disagreements.push({
          recordId: id, mark: markText, row: rec?.name ?? null, code, held: now, model: value, heldText: words(code, now, spec.default_uom), modelText: words(code, value, spec.default_uom),
          // A fact the drawing wrote (drawingValueService) is not a person's: its part file and the model differ — said, not accepted.
          by: isFact ? 'drawing' : 'typed', acceptable: !isFact,
        });
      } else if (!same) out.notAsked += 1;   // its rule works it out another way
    }
  }
  // Pieces: the model's count per mark against the BOM's (reported only).
  for (const [m, q] of bomQty) {
    const x = marks.get(m);
    if (!x || x.kind === 'studs') continue;
    if (x.pieces !== q) out.pieces.push({ mark: x.mark, model: x.pieces, bom: q });
  }
  out.notDerivable = out.notDerivable.slice(0, 300);

  if (target.frozen) {
    out.frozen = target.frozen;
    out.wouldWrite = writes.length;
    out.written = 0; out.cleared = 0;
  } else if (writes.length) {
    const done = await applyOwnWrites(db, c, ctx, writes);
    out.records = done.records; out.values = done.values; out.applied = true;
    ctx = await load();
    out.openRequired.after = openRequired(resolveOwnRows(ctx));
    if (target.kind === 'line') {
      try {
        const { refreshCutPieces } = await import('./cutPlateService.js');
        const cut = await refreshCutPieces(db, c, target.id);
        out.cutPieces = { made: cut.made, reason: cut.reason ?? null, message: cut.message ?? null };
      } catch (err) { out.cutPieces = { made: false, error: err?.message ?? String(err) }; }
    }
  } else out.applied = true;
  if (out.openRequired.after == null) out.openRequired.after = out.openRequired.before;

  if (opts.record !== false) {
    try {
      await db.query(
        'INSERT INTO cf_model_value_runs (company_id, subject_type, subject_id, standard_id, model_file_id, applied, report_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [companyId, target.kind, target.id, target.standardId, Number(file.id), target.frozen ? 0 : 1,
          JSON.stringify({ ...out, notDerivable: out.notDerivable.slice(0, 100) }), c.userId ?? null]);
    } catch (err) { if (!/cf_model_value_runs/.test(String(err?.message))) throw err; }
  }
  return out;
}

/**
 * The 3D model's state for a line's Values screen: { attached, ranAt, disagreements } — the latest run's disagreements
 * that still stand (the typed value is still there and still differs). `ctx` the screen's loadContext, which read the state
 * with the line (no round trip); 1 read on a database without it.
 */
export async function modelStateOfLine(db, companyId, ctx) {
  const lineId = ctx.line.id;
  if (lineId == null) return null;
  let row = ctx.line.modelRow ? { models: ctx.line.modelRow.models, report: ctx.line.modelRow.report, ran_at: ctx.line.modelRow.ranAt } : null;
  if (!row) try {
    [[row]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM cf_standard_drawing_files f WHERE f.company_id = l.company_id AND f.standard_id = l.standard_id AND f.kind = 'model' AND f.deleted_at IS NULL) AS models,
              (SELECT r.report_json FROM cf_model_value_runs r WHERE r.company_id = l.company_id AND r.subject_type = 'line' AND r.subject_id = l.id AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1) AS report,
              (SELECT r.created_at FROM cf_model_value_runs r WHERE r.company_id = l.company_id AND r.subject_type = 'line' AND r.subject_id = l.id AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1) AS ran_at
         FROM cf_sales_order_lines l WHERE l.company_id = ? AND l.id = ?`, [companyId, lineId]);
  } catch (err) {
    if (/cf_model_value_runs/.test(String(err?.message))) return { attached: false, ranAt: null, disagreements: [] };
    throw err;
  }
  const report = parseJson(row?.report);
  const specIdOf = new Map([...ctx.specMeta].map(([id, s]) => [String(s.code).toUpperCase(), id]));
  const standing = (report?.disagreements ?? []).filter((d) => {
    const specId = specIdOf.get(d.code);
    const cur = specId != null ? ctx.store.get(`master:${d.recordId}`)?.get(specId) : null;
    return cur && cur.source === 'entered' && JSON.stringify(held(cur)) === JSON.stringify(d.held);
  });
  return { attached: Number(row?.models) > 0, ranAt: row?.ran_at ?? null, disagreements: standing };
}
