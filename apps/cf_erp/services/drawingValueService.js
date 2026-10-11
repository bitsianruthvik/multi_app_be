/**
 * drawingValueService.js — what a plate part's DRAWING says, written on the part
 * (user, 2026-10-12: "Use the true shape wherever possible for plates … but give an option to
 * override manually").
 *
 * A plate part with a DXF read as its shape (partDrawingService, partGeometry) holds three FACTS
 * (records.DRAWING_FACT_SPECS), one value row each:
 *
 *   TRUE_AREA        mm² — the outline less its cut-outs and holes (geometry.areaMm2)
 *   DRAWN_HOLES      the drilled holes the drawing shows (geometry.holes)
 *   DRAWN_HOLE_DIA   mm — their diameter; the commonest when they differ, the larger on a tie.
 *                    No holes, no value.
 *
 * Nothing here knows what they are used for. The tenant's FORMULAS read them
 * (FIRST(TRUE_AREA, LENGTH * WIDTH) * THICKNESS * DENSITY / 1e9 — the true shape where there is
 * one, the rectangle where not), and resolution reports a value worked out from one as "from the
 * drawing". So weights, areas and hole counts stay DATA: cf_formulas, set up per tenant
 * (scripts/cf_kepl/derived-values-setup.mjs).
 *
 * WHICH ROW TAKES WHICH DRAWING — partDrawingService's own rule: the file with the row's drawing
 * mark, else the file of a register drawing the row is linked to. Only for a row cut from PLATE
 * (its CUT_FROM, resolved as every value is — lib/cutFrom), and only while the drawing IS the row:
 * its rectangle must be the row's LENGTH × WIDTH within 1 mm, either way round (partGeometry.orientTo
 * — the check the Drawings dialog already words). A part re-sized away from its drawing loses the
 * facts and is weighed by its rectangle again, until the drawing of the new size arrives.
 *
 * NO STALE AREAS. The facts are worked out again, and the difference written, wherever the answer
 * can change:
 *   a drawing uploaded / replaced by a new revision / deleted   partDrawingService (always)
 *   cut pieces derived (a shape read late)                      partDrawingService.shapesAfterCutPieces
 *   any other save on the line (a size, a drawing mark)         cutPlateService.withCutPieces
 * and the records whose facts moved are worked out again with everything that reads them
 * (orderValuesService.materializeLineRecords — parents roll up), so an assembly's weight follows.
 *
 * FROZEN STAYS FROZEN. A locked or released line, or one of a closed or revised order, is not
 * touched: its rows keep the values they were frozen with (resolution works nothing out there).
 *
 * ROUND TRIPS (production is ~49 ms each), whatever the size of the line:
 *   no DXF on the line          1   (the line, with its count of drawings)
 *   nothing changed             7   line · specifications · rows · CUT_FROM · values · links · drawings
 *   facts changed               + 2 writes + materializeLineRecords (8 reads, a handful of writes)
 */
import { insertRows } from '../lib/db.js';
import { cutFromOf } from '../lib/cutFrom.js';
import { LOCKED_ORDER_STATUSES, DRAWING_FACT_SPECS } from './records.js';
import { orientTo } from './partGeometry.js';
import { normMark, NOT_ONE_PLATE } from './partDrawingService.js';

const FACTS = [...DRAWING_FACT_SPECS];
const READ = ['LENGTH', 'WIDTH', 'DRAWING_MARK', ...FACTS];
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

/** The one diameter of a part's holes: the commonest, the larger on a tie; null when it has none. */
export function holeDiameterOf(diameters) {
  const count = new Map();
  for (const d of diameters ?? []) { const n = Number(d); if (Number.isFinite(n) && n > 0) count.set(n, (count.get(n) ?? 0) + 1); }
  let best = null;
  for (const [d, n] of count) if (best == null || n > count.get(best) || (n === count.get(best) && d > best)) best = d;
  return best;
}

/**
 * Pure: what a shape says. `g` needs areaMm2, holes and holeDiameters (a stored geometry, or the
 * lean columns of a drawing row). → { TRUE_AREA, DRAWN_HOLES, DRAWN_HOLE_DIA } (a null = no value).
 */
export function factsOfShape(g) {
  const holes = g?.holes == null ? null : Number(g.holes);
  return {
    TRUE_AREA: g?.areaMm2 != null && Number(g.areaMm2) > 0 ? r3(g.areaMm2) : null,
    DRAWN_HOLES: holes != null && Number.isFinite(holes) ? holes : null,
    DRAWN_HOLE_DIA: holes ? holeDiameterOf(g.holeDiameters) : null,
  };
}

/**
 * Pure: the facts every row should hold.
 *   rows      [{ id, isPlatePart, markNorm, drawingIds: [], lengthMm, widthMm }]
 *   drawings  [{ id, drawing_id, mark_norm, lengthMm, widthMm, areaMm2, holes, holeDiameters }] — shaped ones only
 * → Map rowId -> { TRUE_AREA, DRAWN_HOLES, DRAWN_HOLE_DIA, drawingId } for the rows that have a
 *   drawing of their own size; a row that is absent holds none.
 */
export function planFacts(rows, drawings) {
  const out = new Map();
  for (const p of rows) {
    if (!p.isPlatePart) continue;
    const d = drawings.find((x) => p.markNorm && x.mark_norm === p.markNorm)
      ?? drawings.find((x) => x.drawing_id != null && (p.drawingIds ?? []).includes(Number(x.drawing_id)));
    if (!d) continue;
    // Its rectangle must be the row's (either way round); a size not typed yet does not contradict it.
    if (orientTo({ lengthMm: Number(d.lengthMm), widthMm: Number(d.widthMm) }, p.lengthMm ?? null, p.widthMm ?? null).sizeMatches === false) continue;
    out.set(p.id, { ...factsOfShape(d), drawingId: Number(d.id) });
  }
  return out;
}

/** The fact specifications this company has: Map CODE -> { id, default_uom }, with the three codes the rows are read by. */
async function loadSpecs(db, companyId) {
  const [rows] = await db.query('SELECT id, UPPER(code) AS code, default_uom FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, READ]);
  return new Map(rows.map((s) => [s.code, s]));
}

/**
 * The line's rows cut from plate, with what the facts are decided by and the facts they hold now,
 * and its drawings as lean rows (never the megabytes of geometry). 5 round trips.
 * → { rows: [{ id, isPlatePart, markNorm, drawingIds, lengthMm, widthMm, held: Map CODE -> number }], drawings, bare }
 *   `bare`: DXFs of a plate part that still lack a shape and were not already found not to be one plate.
 */
export async function readFactInputs(db, companyId, lineId, specs = null) {
  const spec = specs ?? await loadSpecs(db, companyId);
  const [masters] = await db.query(
    `SELECT m.id, m.code, m.name, m.record_kind, m.classification_id, m.cut_stock_id,
            i.item_type, i.source_definition_id, d.cut_stock_id AS def_cut_stock_id, d.code AS def_code, d.name AS def_name
       FROM cf_item_details i
       JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL
       LEFT JOIN cf_master_records d ON d.id = i.source_definition_id AND d.deleted_at IS NULL
      WHERE i.company_id = ? AND i.owner_order_line_id = ? AND i.item_type = 'temporary' AND i.deleted_at IS NULL`,
    [companyId, lineId],
  );
  if (!masters.length) return { rows: [], drawings: [], bare: [] };
  const ids = masters.map((m) => Number(m.id));
  const cutFrom = await cutFromOf(db, companyId, ids, { masters });
  const specIds = [...spec.values()].map((s) => s.id);
  const [[vals], [links], [files]] = await Promise.all([
    specIds.length ? db.query(
      `SELECT v.subject_id, v.specification_id, v.value_number, v.value_text FROM cf_spec_values v
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?) AND v.specification_id IN (?)`,
      [companyId, ids, specIds]) : [[]],
    db.query(
      `SELECT l.subject_id, l.drawing_id FROM cf_drawing_links l
         JOIN cf_drawings d ON d.id = l.drawing_id AND d.deleted_at IS NULL AND d.status IN ('draft', 'issued')
        WHERE l.company_id = ? AND l.subject_type = 'master_record' AND l.deleted_at IS NULL AND l.subject_id IN (?)`,
      [companyId, ids]),
    db.query(
      `SELECT id, drawing_id, mark_norm, length_mm, width_mm, area_mm2, holes,
              JSON_EXTRACT(geometry_json, '$.holeDiameters') AS hole_dias, (geometry_json IS NOT NULL) AS shaped,
              (dxf_text IS NOT NULL) AS has_text, (warnings_json LIKE ?) AS not_one_plate
         FROM cf_part_drawings
        WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND file_kind = 'dxf' ORDER BY mark_norm, id`,
      [`%${NOT_ONE_PLATE.slice(0, 40).replace(/[%_\\]/g, '\\$&')}%`, companyId, lineId]),
  ]);
  const codeOf = new Map([...spec].map(([code, s]) => [Number(s.id), code]));
  const rows = new Map(masters.map((m) => [Number(m.id), {
    id: Number(m.id), isPlatePart: cutFrom.get(Number(m.id)) === 'PLATE', markNorm: null, drawingIds: [], lengthMm: null, widthMm: null, held: new Map(),
  }]));
  for (const v of vals) {
    const p = rows.get(Number(v.subject_id));
    const code = codeOf.get(Number(v.specification_id));
    if (!p || !code) continue;
    if (code === 'DRAWING_MARK') { const mark = v.value_text ?? (v.value_number != null ? String(Number(v.value_number)) : null); p.markNorm = mark ? normMark(mark) : null; }
    else if (v.value_number == null) continue;
    else if (code === 'LENGTH') p.lengthMm = Number(v.value_number);
    else if (code === 'WIDTH') p.widthMm = Number(v.value_number);
    else p.held.set(code, Number(v.value_number));
  }
  for (const k of links) { const p = rows.get(Number(k.subject_id)); if (p && !p.drawingIds.includes(Number(k.drawing_id))) p.drawingIds.push(Number(k.drawing_id)); }
  const list = [...rows.values()];
  const matches = (p, f) => (!!p.markNorm && p.markNorm === f.mark_norm) || (f.drawing_id != null && p.drawingIds.includes(Number(f.drawing_id)));
  const drawings = files.filter((f) => Number(f.shaped)).map((f) => ({
    id: Number(f.id), drawing_id: f.drawing_id, mark_norm: f.mark_norm, lengthMm: Number(f.length_mm), widthMm: Number(f.width_mm),
    areaMm2: f.area_mm2 == null ? null : Number(f.area_mm2), holes: f.holes == null ? null : Number(f.holes), holeDiameters: parseJson(f.hole_dias) ?? [],
  }));
  const bare = files.filter((f) => !Number(f.shaped) && Number(f.has_text) && !Number(f.not_one_plate) && list.some((p) => p.isPlatePart && matches(p, f)));
  return { rows: list, drawings, bare };
}

let savepointNo = 0;

/**
 * Brings a line's drawing facts in line with its drawings, and works out again whatever reads them.
 * Needs a transaction. `force`: also when the line has no DXF (the last one was just deleted).
 * → { drawings, written, cleared, records, values, skipped? } — `skipped`: 'frozen' | 'no_drawings' | 'not_set_up'.
 */
export async function refreshDrawingValues(db, c, lineId, { force = false } = {}) {
  const companyId = c.companyId;
  const out = { drawings: 0, written: 0, cleared: 0, records: 0, values: 0 };
  const [[line]] = await db.query(
    `SELECT l.id, l.locked_at, o.status AS order_status,
            EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS released,
            (SELECT COUNT(*) FROM cf_part_drawings d WHERE d.company_id = l.company_id AND d.order_line_id = l.id AND d.deleted_at IS NULL AND d.file_kind = 'dxf') AS dxf
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [companyId, lineId],
  );
  if (!line) return { ...out, skipped: 'no_line' };
  out.drawings = Number(line.dxf);
  if (line.locked_at || Number(line.released) || LOCKED_ORDER_STATUSES.has(line.order_status)) return { ...out, skipped: 'frozen' };
  if (!out.drawings && !force) return { ...out, skipped: 'no_drawings' };
  const spec = await loadSpecs(db, companyId);
  if (!FACTS.some((code) => spec.has(code))) return { ...out, skipped: 'not_set_up' };

  let input = await readFactInputs(db, companyId, lineId, spec);
  if (input.bare.length) {
    // A plate part's DXF saved without a shape: read now (partDrawingService's late read), then looked at again.
    const { lateShapesOfLine } = await import('./partDrawingService.js');
    await lateShapesOfLine(db, companyId, lineId);
    input = await readFactInputs(db, companyId, lineId, spec);
  }
  const want = planFacts(input.rows, input.drawings);
  const clears = [];   // [recordId, specId]
  const sets = [];     // [recordId, code, value]
  const moved = new Set();
  for (const p of input.rows) {
    const w = want.get(p.id) ?? null;
    for (const code of FACTS) {
      if (!spec.has(code)) continue;
      const now = p.held.has(code) ? p.held.get(code) : null;
      const next = w ? w[code] ?? null : null;
      if (now == null && next == null) continue;
      if (now != null && next != null && Math.abs(now - next) < 1e-6) continue;
      if (now != null) clears.push([p.id, spec.get(code).id]);
      if (next != null) sets.push([p.id, code, next]);
      moved.add(p.id);
    }
  }
  if (!moved.size) return out;
  const sp = `cf_drawing_values_${savepointNo += 1}`;
  await db.query(`SAVEPOINT ${sp}`);
  try {
    if (clears.length) {
      await db.query(
        `UPDATE cf_spec_values SET deleted_at = NOW()
          WHERE company_id = ? AND subject_type = 'master' AND deleted_at IS NULL AND (subject_id, specification_id) IN (${clears.map(() => '(?, ?)').join(', ')})`,
        [companyId, ...clears.flat()],
      );
    }
    if (sets.length) {
      // Stored like PIERCINGS: source 'entered' (records.DRAWING_FACT_SPECS says why).
      await insertRows(db, 'cf_spec_values', ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_number', 'uom', 'source', 'created_by'],
        sets.map(([id, code, value]) => [companyId, spec.get(code).id, 'master', id, value, spec.get(code).default_uom ?? null, 'entered', c.userId ?? null]));
    }
    const { materializeLineRecords } = await import('./orderValuesService.js');
    const settled = await materializeLineRecords(db, c, lineId, [...moved]);
    out.records = settled.records; out.values = settled.values;
  } catch (err) {
    try { await db.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch { /* the original error is the one that matters */ }
    throw err;
  }
  out.written = sets.length;
  out.cleared = clears.length - sets.filter(([id, code]) => clears.some(([cid, sid]) => cid === id && sid === spec.get(code).id)).length;
  return out;
}

/**
 * refreshDrawingValues behind a save that must not fail because of it (a value save, a BOM change):
 * a failure is undone to where it started and said on the answer, never thrown.
 */
export async function drawingValuesAfterSave(db, c, lineId) {
  try {
    return await refreshDrawingValues(db, c, lineId);
  } catch (err) {
    return { drawings: 0, written: 0, cleared: 0, records: 0, values: 0, error: err?.message ?? String(err) };
  }
}
