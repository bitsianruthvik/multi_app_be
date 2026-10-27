/**
 * partDrawingService.js — drawings on an order line's rows (init.sql §51/§51b, user 2026-10-08:
 * "Build A", then "keep it at the structure tab … upload drawings for not just parts but all the
 * levels").
 *
 * A drawing is uploaded on its order line; its file name is its DRAWING MARK and it belongs to
 * every row of the line — span, girder line, segment, assembly, part — whose DRAWING_MARK says the
 * same (case, spaces, hyphens, underscores and the ending do not matter). DXF or PDF.
 *
 * For every row it is the row's drawing, kept and downloadable. For a PLATE PART a DXF is also read
 * as its shape (partGeometry.js), and that is used for:
 *   - the measure the user asked for: how much of each part's rectangle is real part, and so the
 *     most a true-shape nesting could save on the line (summary.savingKg);
 *   - CNC inputs: plateCutsService takes cut length and piercings from the parts' drawings, and a
 *     shared cut only saves the share of a side the outline really runs along (drawingFactsOfLine);
 *   - a row whose size is not the drawing's rectangle is said, not changed.
 * Nesting still lays out the rectangle (the row's LENGTH × WIDTH) — option A.
 *
 * THE REGISTER (option B, 2026-10-09: "go with B for drawings"). Every file here is the file of a
 * revision in the drawings register (drawingService.js, cf_drawings): the register says which sheet
 * and revision a row is built to, this table holds that revision's file (drawing_id). So:
 *   - a drawing can be STARTED from a row before any file exists (startDrawing) — it waits for one;
 *   - a file that arrives finds its register drawing: the one its mark's file already sits on, else
 *     one waiting on a matched row, else a new one is created (number = order code / mark);
 *   - uploading again over an ISSUED revision makes the NEXT revision (links carried, the old file
 *     stays on the old revision and can still be downloaded); over a DRAFT it just replaces the file;
 *   - a file belongs to the rows with its drawing mark AND the rows its register drawing is linked to.
 * Deleting a file leaves the register drawing in place, waiting for a file again.
 *
 * WHAT A PLATE PART IS (2026-10-11) — decided from the row's OWN data, never from when its cut
 * plate happened to be made:
 *     a row is a plate part when its CUT_FROM, resolved for that row the way every spec is resolved
 *     (lib/cutFrom.js: classification chain -> template definition -> the row; "Plate part" says
 *     PLATE, "Profile part" SECTION, assemblies NONE), is PLATE — OR it already has a cut plate
 *     below it (a row made before CUT_FROM, or one whose CUT_FROM changed and has not been
 *     re-derived yet, is still cut from that plate).
 * It is exactly the test the cut-piece derive applies (cutPlateService.survey), so "this row will
 * get a cut plate" and "this row's DXF is a shape" cannot disagree. cutPlateIds stays what it was:
 * the cut plates that exist today (empty until the line's values are complete).
 *
 * A SHAPE DOES NOT DEPEND ON WHEN THE FILE ARRIVED. A plate part's DXF stored without a shape
 * (uploaded while the row was not known as a plate part, or before this rule) is read from its
 * stored text by readMissingShapes — ONE read of the texts that lack a shape, ONE bulk UPDATE —
 * at three moments: when cut pieces are derived (shapesAfterCutPieces, called by cutPlateService),
 * on every read that shows or uses shapes (getDrawings, drawingFactsOfLine), and by the backfill
 * (scripts/cf_kepl/drawings-read-shapes.mjs). A file that is not one plate part cannot be refused
 * any more by then — it is kept as a plain drawing and says why in its warnings (NOT_ONE_PLATE),
 * which is also what stops it being parsed again on every read.
 *
 * A line released to production takes no drawing changes. One live drawing per line and mark;
 * uploading a mark again replaces it. Cut pieces are never matched — they are worked out.
 *
 * BY CODE, AND TO EVERY COPY (2026-10-12, CF_ERP_LINKED_COPIES_PLAN.md). A file is matched in this
 * order: aimed at a row or a register drawing → its NAME as the end of the rows' code, the way the
 * screen prints it (`L(1,5)-1-TFL1.dxf`; lib/drawingName.js — the code preview before the design
 * is frozen, the real piece codes after) → its name as a drawing mark (whole, then without the
 * thickness / grade it carries). Matching never depends on sizes: drawings are often uploaded
 * before a dimension is typed. Every linked copy of a row found ("same design", linkService) takes
 * the drawing too — the drawing is part of the design, so a copy without it would stop being one.
 * The size, thickness and grade a file states go into the cells that are still EMPTY, in one bulk
 * write (uploadDrawings says how).
 *
 * WHAT A SHAPE SAYS IS WRITTEN ON THE PART (2026-10-12): its true area, its holes and their
 * diameter, as values the tenant's formulas read — the part's weight and surface by its TRUE shape
 * (drawingValueService.refreshDrawingValues). Run here after every upload (a new file, a replaced
 * one, a new revision), every delete and every late read, so no part keeps the area of a drawing
 * it no longer has.
 */
import { CfError, invalid, notFound } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { memoized } from '../lib/requestMemo.js';
import { cutFromOf } from '../lib/cutFrom.js';
import { explode } from './bomService.js';
import { readPartDrawing, orientTo } from './partGeometry.js';
import { createDrawing, reviseDrawing } from './drawingService.js';
import { nextRevision } from '../lib/revision.js';
import { parseDrawingName, matchCodePattern, codeWithNumbers } from '../lib/drawingName.js';
import { dxfTextHints } from '../lib/nestDxfReader.js';

const FALLBACK_DENSITY = 7850;
// A row is one TiDB entry (6 MB at most): a 4 MB file is 5.3 MB as base64.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const KINDS = { dxf: 'application/dxf', pdf: 'application/pdf' };
const r1 = (n) => Math.round(Number(n) * 10) / 10;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const kindOf = (name) => { const m = /\.(dxf|pdf)$/i.exec(String(name ?? '')); return m ? m[1].toLowerCase() : null; };
// Case, the ending, and spaces, hyphens and underscores between words, do not matter: a file cannot always be named as the mark is written.
export const normMark = (s) => String(s ?? '').replace(/\.(dxf|pdf)$/i, '').trim().replace(/[\s_-]+/g, '-').toUpperCase();
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

async function requireLine(db, companyId, orderId, lineId) {
  const [[l]] = await db.query(
    `SELECT l.id, l.order_id, l.line_no, l.line_type, l.item_id, l.quantity, l.locked_at, o.code AS order_code,
            EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL) AS released
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL${orderId != null ? ' AND l.order_id = ?' : ''}`,
    orderId != null ? [companyId, lineId, orderId] : [companyId, lineId],
  );
  if (!l) throw notFound('Order line');
  return l;
}

/**
 * Every row of the line a drawing can belong to (cut pieces left out), top first:
 * [{ id, code, name, level, depth, pieces, mark, markNorm, lengthMm, widthMm, thicknessMm, density,
 *    isPlatePart, cutPlateIds }]
 */
export async function rowsOfLine(db, companyId, line) {
  if (line.line_type !== 'custom' || !line.item_id) return [];
  const places = await cutPlaces(db, companyId);
  const cutNodes = new Set([...(places.plate?.blanksIds ?? []), ...(places.plate?.offcutIds ?? []), ...(places.section?.blanksIds ?? []), ...(places.section?.offcutIds ?? [])].map(Number));
  const plateNodes = [...(places.plate?.blanksIds ?? [])];
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.classification_id, n.name AS level,
            m.record_kind, i.item_type, i.source_definition_id, d.code AS def_code, d.name AS def_name
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL AND i.owner_order_line_id = ?
       LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
       LEFT JOIN cf_master_records d ON d.id = i.source_definition_id AND d.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL`,
    [line.id, companyId],
  );
  const mine = rows.filter((r) => !cutNodes.has(Number(r.classification_id)));
  if (!mine.length) return [];
  const ids = mine.map((r) => Number(r.id));
  const [cuts] = plateNodes.length ? await db.query(
    `SELECT b.parent_id, bl.child_id FROM cf_boms b
       JOIN cf_bom_lines bl ON bl.company_id = b.company_id AND bl.bom_id = b.id AND bl.deleted_at IS NULL
       JOIN cf_master_records cp ON cp.id = bl.child_id AND cp.deleted_at IS NULL AND cp.classification_id IN (?)
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.parent_id IN (?)`,
    [plateNodes, companyId, ids],
  ) : [[]];
  // How each row is cut, resolved for all of them at once (one round trip) — the derive's own test.
  const cutFrom = await cutFromOf(db, companyId, ids, { masters: mine });
  const [vals] = await db.query(
    `SELECT v.subject_id, UPPER(s.code) AS code, v.value_number, v.value_text
       FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?)
        AND s.code IN ('LENGTH', 'WIDTH', 'THICKNESS', 'DENSITY', 'DRAWING_MARK')`,
    [companyId, ids],
  );
  const tree = await explode(db, companyId, line.item_id, { rootQuantity: Number(line.quantity) });
  const pieces = new Map();
  const depth = new Map([[Number(line.item_id), 0]]);
  const parentOf = new Map();   // node id -> the node above it (first met), for the drawing tree
  const seqOf = new Map();      // node id -> its place in the BOM walk
  (function walk(node, d) {
    for (const ch of node.children ?? []) {
      if (ch.id != null) {
        if (!parentOf.has(Number(ch.id))) { parentOf.set(Number(ch.id), node.id != null ? Number(node.id) : Number(line.item_id)); seqOf.set(Number(ch.id), seqOf.size + 1); }
        pieces.set(Number(ch.id), (pieces.get(Number(ch.id)) ?? 0) + Number(ch.total ?? 0));
        if (!depth.has(Number(ch.id))) depth.set(Number(ch.id), d + 1);
      }
      walk(ch, d + 1);
    }
  }(tree.root, 0));
  const out = new Map(mine.map((r) => [Number(r.id), {
    id: Number(r.id), code: r.code, name: r.name, level: r.level ?? 'Row', depth: depth.get(Number(r.id)) ?? 99,
    pieces: Number(r.id) === Number(line.item_id) ? Number(line.quantity) : Math.round(pieces.get(Number(r.id)) ?? 0),
    mark: null, markNorm: null, lengthMm: null, widthMm: null, thicknessMm: null, density: null,
    // THE RULE (see the header): cut from plate by its own CUT_FROM — or, below, by a cut plate it already has.
    cutFrom: cutFrom.get(Number(r.id)) ?? null, isPlatePart: cutFrom.get(Number(r.id)) === 'PLATE', cutPlateIds: [], drawingIds: [],
    parentId: null, seq: seqOf.get(Number(r.id)) ?? 0,
  }]));
  // The nearest row above that is one of the line's own (a cut piece or a catalog row in between is passed over).
  for (const p of out.values()) {
    let up = parentOf.get(p.id);
    for (let hops = 0; up != null && !out.has(up) && hops < 50; hops++) up = parentOf.get(up);
    p.parentId = up != null && out.has(up) ? up : null;
  }
  // The register drawings (in play: draft or issued) each row is linked to.
  const [links] = await db.query(
    `SELECT l.subject_id, l.drawing_id FROM cf_drawing_links l
       JOIN cf_drawings d ON d.id = l.drawing_id AND d.deleted_at IS NULL AND d.status IN ('draft', 'issued')
      WHERE l.company_id = ? AND l.subject_type = 'master_record' AND l.deleted_at IS NULL AND l.subject_id IN (?)`,
    [companyId, ids],
  );
  for (const k of links) { const p = out.get(Number(k.subject_id)); if (p && !p.drawingIds.includes(Number(k.drawing_id))) p.drawingIds.push(Number(k.drawing_id)); }
  for (const c of cuts) { const p = out.get(Number(c.parent_id)); if (p) { p.isPlatePart = true; p.cutPlateIds.push(Number(c.child_id)); } }
  for (const v of vals) {
    const p = out.get(Number(v.subject_id));
    if (!p) continue;
    if (v.code === 'DRAWING_MARK') { p.mark = v.value_text ?? (v.value_number != null ? String(Number(v.value_number)) : null); p.markNorm = p.mark ? normMark(p.mark) : null; }
    else if (v.value_number != null) p[{ LENGTH: 'lengthMm', WIDTH: 'widthMm', THICKNESS: 'thicknessMm', DENSITY: 'density' }[v.code]] = Number(v.value_number);
  }
  return [...out.values()].sort((a, b) => a.depth - b.depth || String(a.mark ?? '~').localeCompare(String(b.mark ?? '~')) || a.id - b.id);
}

/** The line's plate parts only (rows cut from plate — see the header's rule; cutPlateIds may still be empty). */
export async function platePartsOfLine(db, companyId, line) {
  return (await rowsOfLine(db, companyId, line)).filter((r) => r.isPlatePart);
}

async function liveDrawings(db, companyId, lineId) {
  const [rows] = await db.query(
    `SELECT id, drawing_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2, cut_length_mm, piercings, holes, inner_cuts, geometry_json, warnings_json, created_at
       FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL ORDER BY mark_norm`,
    [companyId, lineId],
  );
  return rows.map((r) => ({ ...r, geometry: parseJson(r.geometry_json), warnings: parseJson(r.warnings_json) ?? [] }));
}

/** A file belongs to the rows with its drawing mark and the rows its register drawing is linked to. */
const matches = (p, d) => (!!p.markNorm && p.markNorm === d.mark_norm) || (d.drawing_id != null && p.drawingIds.includes(Number(d.drawing_id)));
/** The file a row is read by: its own mark's first, else its register drawing's. */
const fileFor = (p, files) => files.find((d) => p.markNorm && d.mark_norm === p.markNorm) ?? files.find((d) => d.drawing_id != null && p.drawingIds.includes(Number(d.drawing_id))) ?? null;

/** Said (and stored in warnings_json) of a plate part's DXF that could not be read as ONE plate after it was saved. */
export const NOT_ONE_PLATE = 'No shape was read from this drawing, so the part is nested and cut as its rectangle: ';
const notOnePlate = (d) => (d.warnings ?? []).some((w) => String(w).startsWith(NOT_ONE_PLATE));
const sizeWarning = (p, g) => {
  const o = orientTo(g, p.lengthMm, p.widthMm);
  return o.sizeMatches === false ? `${p.code ?? p.name} is ${p.lengthMm} × ${p.widthMm} on the order, and the drawing's rectangle is ${o.swap ? `${g.widthMm} × ${g.lengthMm}` : `${g.lengthMm} × ${g.widthMm}`} — nesting lays out the order's size.` : null;
};
// One statement carries every shape of the pass; past this many drawings it is cut in two (a shape is ~10–150 kB of JSON).
const SHAPE_WRITE_CHUNK = 100;
const SHAPE_COLUMNS = ['length_mm', 'width_mm', 'area_mm2', 'cut_length_mm', 'piercings', 'holes', 'inner_cuts', 'geometry_json', 'warnings_json'];
const SHAPE_FIELD = { length_mm: 'lengthMm', width_mm: 'widthMm', area_mm2: 'areaMm2', cut_length_mm: 'cutLengthMm', piercings: 'piercings', holes: 'holes', inner_cuts: 'innerCuts' };

/**
 * THE LATE READ. Every live DXF of the line that belongs to a plate part and has no shape yet is
 * read from its stored text — in memory for this answer (`drawings` is changed in place: geometry
 * and warnings) and, unless `persist` is false, saved so it is never parsed again.
 *   rows      rowsOfLine's answer        drawings  liveDrawings' answer
 * Work is bounded: only files that lack a shape and were not already found not to be one plate
 * (NOT_ONE_PLATE) are read. Round trips: 0 when nothing lacks a shape, else ONE read of those
 * texts + ONE bulk UPDATE (per SHAPE_WRITE_CHUNK drawings) — never one per row.
 * A file read late cannot be refused, so what an upload would have refused is said in its warnings;
 * a size that disagrees with a row is warned in the same words as at upload.
 * → { looked, read: [{ id, mark, rows }], notOnePlate: [{ id, mark, why, known }], sizeMismatches: [text], writes }
 */
export async function readMissingShapes(db, companyId, rows, drawings, { persist = true } = {}) {
  const out = { looked: 0, read: [], notOnePlate: [], sizeMismatches: [], writes: [] };
  const todo = [];
  for (const d of drawings) {
    if ((d.file_kind ?? 'dxf') !== 'dxf' || d.geometry) continue;
    const plate = rows.filter((p) => p.isPlatePart && matches(p, d));
    if (!plate.length) continue;
    out.looked += 1;
    if (notOnePlate(d)) { out.notOnePlate.push({ id: d.id, mark: d.mark, why: d.warnings.find((w) => String(w).startsWith(NOT_ONE_PLATE)).slice(NOT_ONE_PLATE.length), known: true }); continue; }
    todo.push({ d, plate });
  }
  if (!todo.length) return out;
  const [texts] = await db.query('SELECT id, dxf_text FROM cf_part_drawings WHERE company_id = ? AND id IN (?) AND dxf_text IS NOT NULL', [companyId, todo.map((t) => t.d.id)]);
  const textOf = new Map(texts.map((t) => [Number(t.id), t.dxf_text]));
  for (const { d, plate } of todo) {
    const text = textOf.get(Number(d.id));
    if (text == null) continue;
    const got = readPartDrawing(text);
    const g = got.geometry ?? null;
    const warnings = new Set([...(d.warnings ?? []), ...got.warnings]);
    if (g) {
      for (const p of plate) { const w = sizeWarning(p, g); if (w) { warnings.add(w); out.sizeMismatches.push(w); } }
      out.read.push({ id: d.id, mark: d.mark, rows: plate.length });
    } else {
      const why = got.problems.join(' ') || 'it does not read as one plate part.';
      warnings.add(`${NOT_ONE_PLATE}${why}`);
      out.notOnePlate.push({ id: d.id, mark: d.mark, why, known: false });
    }
    d.geometry = g; d.warnings = [...warnings];
    out.writes.push({ id: Number(d.id), g, warnings: d.warnings });
  }
  if (persist) await writeShapes(db, companyId, out.writes);
  return out;
}

/** The shapes of a late read, saved: ONE UPDATE for all of them (a file that already has a shape is left alone). */
export async function writeShapes(db, companyId, writes) {
  for (let i = 0; i < writes.length; i += SHAPE_WRITE_CHUNK) {
    const part = writes.slice(i, i + SHAPE_WRITE_CHUNK);
    const valueOf = (w, col) => (col === 'warnings_json' ? JSON.stringify(w.warnings) : col === 'geometry_json' ? (w.g ? JSON.stringify(w.g) : null) : w.g ? w.g[SHAPE_FIELD[col]] ?? null : null);
    const sets = SHAPE_COLUMNS.map((col) => `${col} = CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} ELSE ${col} END`);
    const params = SHAPE_COLUMNS.flatMap((col) => part.flatMap((w) => [w.id, valueOf(w, col)]));
    await db.query(`UPDATE cf_part_drawings SET ${sets.join(', ')} WHERE company_id = ? AND id IN (?) AND geometry_json IS NULL AND deleted_at IS NULL`, [...params, companyId, part.map((w) => w.id)]);
  }
  return writes.length;
}

/**
 * The late read for one line by its id (the derive hook and the backfill script): readMissingShapes'
 * answer plus `line` { id, lineNo, orderId, orderCode, released }. `persist: false` leaves the
 * saving to the caller (writeShapes with the answer's `writes` — the backfill saves an order at once).
 */
export async function lateShapesOfLine(db, companyId, lineId, { persist = true } = {}) {
  const line = await requireLine(db, companyId, null, lineId);
  const late = await readMissingShapes(db, companyId, await rowsOfLine(db, companyId, line), await liveDrawings(db, companyId, line.id), { persist });
  return { line: { id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code, released: !!Number(line.released) }, ...late };
}

/**
 * After a line's cut pieces were derived (cutPlateService.deriveOpened): the plate parts' drawings
 * that still lack a shape are read (readMissingShapes), and the cut plates — which may exist only
 * since a moment ago — take cut length and piercings from the shapes. ONE count when the line has
 * no DXF at all; a fixed number of round trips otherwise, whatever the size of the line.
 * → { drawings, read, notOnePlate, written }
 */
export async function shapesAfterCutPieces(db, c, lineId) {
  const companyId = c.companyId;
  const [[n]] = await db.query(
    `SELECT COALESCE(SUM(geometry_json IS NULL AND dxf_text IS NOT NULL), 0) AS bare, COALESCE(SUM(geometry_json IS NOT NULL), 0) AS shaped
       FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND file_kind = 'dxf'`,
    [companyId, lineId],
  );
  const out = { drawings: Number(n.bare) + Number(n.shaped), read: 0, notOnePlate: 0, written: 0 };
  if (!out.drawings) return out;
  let shaped = Number(n.shaped);
  if (Number(n.bare)) {
    const late = await lateShapesOfLine(db, companyId, lineId);
    out.read = late.read.length; out.notOnePlate = late.notOnePlate.length; shaped += late.read.length;
  }
  if (shaped) {
    const { refreshPlateCuts } = await import('./plateCutsService.js');
    out.written = (await refreshPlateCuts(db, c, lineId)).written;
  }
  // The parts' own values from their shapes (true area, holes) — and whatever is worked out from them.
  const { refreshDrawingValues } = await import('./drawingValueService.js');
  out.values = await refreshDrawingValues(db, c, lineId);
  return out;
}

/**
 * The register side of some drawings: Map id -> { id, code, number, revision, status, title,
 * earlier: [{ id, revision, status, hasFile, fileName }] } — earlier revisions of the same drawing, oldest first.
 */
async function registerRefs(db, companyId, ids) {
  const out = new Map();
  const want = [...new Set(ids.filter((x) => x != null).map(Number))];
  if (!want.length) return out;
  const [rows] = await db.query('SELECT id, code, number, revision, status, title, url, root_id FROM cf_drawings WHERE company_id = ? AND id IN (?)', [companyId, want]);
  const roots = [...new Set(rows.map((r) => Number(r.root_id ?? r.id)))];
  const [revs] = roots.length ? await db.query('SELECT id, revision, status, root_id FROM cf_drawings WHERE company_id = ? AND deleted_at IS NULL AND root_id IN (?) ORDER BY id', [companyId, roots]) : [[]];
  const revIds = [...new Set([...revs.map((r) => Number(r.id)), ...want])];
  // Where a revision's file is: uploaded on an order line, or held by a standard drawing (its sheet, a version's part file).
  const [filed] = await db.query(
    `SELECT drawing_id, file_name, file_kind FROM (
       SELECT drawing_id, file_name, file_kind, deleted_at IS NULL AS live, id, 0 AS std FROM cf_part_drawings WHERE company_id = ? AND drawing_id IN (?) AND dxf_text IS NOT NULL
       UNION ALL
       SELECT drawing_id, file_name, file_kind, deleted_at IS NULL AS live, id, 1 AS std FROM cf_standard_drawing_files WHERE company_id = ? AND drawing_id IN (?) AND file_text IS NOT NULL
     ) f ORDER BY std DESC, live, id`,
    [companyId, revIds, companyId, revIds],
  );
  // Each revision's file (an order line's live upload last, so it wins).
  const fileName = new Map(filed.map((f) => [Number(f.drawing_id), f.file_name]));
  const fileKind = new Map(filed.map((f) => [Number(f.drawing_id), f.file_kind === 'pdf' ? 'pdf' : 'dxf']));
  for (const r of rows) {
    const root = Number(r.root_id ?? r.id);
    out.set(Number(r.id), {
      id: Number(r.id), code: r.code, number: r.number, revision: r.revision, status: r.status, title: r.title,
      // Where the sheet lives when no file is kept here (an RDSO standard's series PDF), and whether one is kept.
      url: r.url ?? null, hasFile: fileName.has(Number(r.id)), fileName: fileName.get(Number(r.id)) ?? null, fileKind: fileKind.get(Number(r.id)) ?? null,
      earlier: revs.filter((v) => Number(v.root_id) === root && Number(v.id) < Number(r.id)).map((v) => ({ id: Number(v.id), revision: v.revision, status: v.status, hasFile: fileName.has(Number(v.id)), fileName: fileName.get(Number(v.id)) ?? null })),
    });
  }
  return out;
}

const rowView = (p, g) => ({
  id: p.id, code: p.code, name: p.name, level: p.level, isPlatePart: p.isPlatePart, pieces: p.pieces,
  lengthMm: p.lengthMm, widthMm: p.widthMm, thicknessMm: p.thicknessMm,
  sizeMatches: g && p.isPlatePart ? orientTo(g, p.lengthMm, p.widthMm).sizeMatches : null,
});
const geometryView = (g) => (g ? {
  lengthMm: g.lengthMm, widthMm: g.widthMm, areaMm2: g.areaMm2, rectAreaMm2: g.rectAreaMm2, usePct: g.usePct,
  cutLengthMm: g.cutLengthMm, piercings: g.piercings, holes: g.holes, holeDiameters: g.holeDiameters, innerCuts: g.innerCuts, rings: g.rings,
} : null);

function viewOf(line, rows, drawings, refs = new Map()) {
  const covered = new Set();
  const measured = new Set();
  let rectArea = 0; let trueArea = 0; let rectKg = 0; let trueKg = 0;
  const views = drawings.map((d) => {
    const matched = rows.filter((p) => matches(p, d));
    for (const p of matched) {
      covered.add(p.id);
      const g = d.geometry;
      // A part is measured once, by the file it is read by.
      if (!g || !p.isPlatePart || measured.has(p.id) || fileFor(p, drawings) !== d) continue;
      measured.add(p.id);
      const t = p.thicknessMm ?? 0; const rho = p.density ?? FALLBACK_DENSITY;
      rectArea += g.rectAreaMm2 * p.pieces; trueArea += g.areaMm2 * p.pieces;
      rectKg += (g.rectAreaMm2 * t * rho * p.pieces) / 1e9; trueKg += (g.areaMm2 * t * rho * p.pieces) / 1e9;
    }
    return {
      id: d.id, mark: d.mark, fileName: d.file_name, fileKind: d.file_kind ?? 'dxf', uploadedAt: d.created_at,
      drawing: d.drawing_id != null ? refs.get(Number(d.drawing_id)) ?? null : null,
      levels: [...new Set(matched.map((p) => p.level))],
      geometry: geometryView(d.geometry), rows: matched.map((p) => rowView(p, d.geometry)), warnings: d.warnings,
    };
  });
  // Register drawings linked to rows of the line that have no file here yet.
  const filed = new Set(drawings.map((d) => Number(d.drawing_id)).filter(Boolean));
  const waitingIds = [...new Set(rows.flatMap((p) => p.drawingIds))].filter((id) => !filed.has(id) && refs.has(id));
  const waiting = waitingIds.map((id) => {
    const linked = rows.filter((p) => p.drawingIds.includes(id));
    for (const p of linked) covered.add(p.id);
    return { drawing: refs.get(id), rows: linked.map((p) => rowView(p, null)) };
  }).sort((a, b) => String(a.drawing.number).localeCompare(String(b.drawing.number)));
  const parts = rows.filter((p) => p.isPlatePart);
  const shaped = measured;
  return {
    line: { id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code, released: !!Number(line.released) },
    drawings: views,
    waiting,
    rowsWithoutDrawing: rows.filter((p) => !covered.has(p.id)).map((p) => ({ id: p.id, code: p.code, name: p.name, level: p.level, mark: p.mark, pieces: p.pieces, isPlatePart: p.isPlatePart })),
    summary: {
      rows: rows.length, rowsWithDrawing: covered.size, waiting: waiting.length,
      parts: parts.length, partsWithShape: shaped.size,
      pieces: parts.reduce((a, p) => a + p.pieces, 0), piecesWithShape: parts.filter((p) => shaped.has(p.id)).reduce((a, p) => a + p.pieces, 0),
      rectAreaM2: r3(rectArea / 1e6), trueAreaM2: r3(trueArea / 1e6), usePct: rectArea > 0 ? r1((trueArea / rectArea) * 100) : null,
      rectKg: r1(rectKg), trueKg: r1(trueKg), savingKg: r1(rectKg - trueKg),
    },
  };
}

/**
 * Every row of the line with its place in the structure and whether it has a drawing — ONE set-based read for the
 * viewer's breadcrumb and "parts in this assembly" list, so production screens need no round trip per level.
 * [{ rowId, parentId, code, name, level, depth, seq, mark, hasDrawing, drawingId, fileKind, fileName, number, revision, status,
 *    isPlatePart, cutPlateIds }]
 * (`drawingId` is the file's id for GET …/drawings/:id/file). Fixed number of queries whatever the size of the line.
 */
export async function drawingTree(db, companyId, orderId, lineId) {
  const line = await requireLine(db, companyId, orderId, lineId);
  const rows = await rowsOfLine(db, companyId, line);
  const drawings = await liveDrawings(db, companyId, line.id);
  const refs = await registerRefs(db, companyId, [...drawings.map((d) => d.drawing_id), ...rows.flatMap((p) => p.drawingIds)]);
  // A row with no file on the line may still be covered by a register drawing: one whose file a standard holds (it
  // opens with GET /drawings/:id/file), else one kept elsewhere (its link — an RDSO series sheet). Its file first.
  const sheetOf = (p) => {
    const cands = p.drawingIds.map((id) => refs.get(id)).filter((r) => r && r.status !== 'withdrawn');
    const r = cands.find((x) => x.hasFile) ?? cands.find((x) => x.url) ?? cands[0] ?? null;
    return r ? { id: r.id, number: r.number, revision: r.revision, title: r.title, status: r.status, url: r.url, hasFile: r.hasFile, fileName: r.fileName, fileKind: r.fileKind } : null;
  };
  return {
    line: { id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code, released: !!Number(line.released) },
    rows: rows.map((p) => {
      const d = fileFor(p, drawings);
      const ref = d?.drawing_id != null ? refs.get(Number(d.drawing_id)) : null;
      return {
        rowId: p.id, parentId: p.parentId, code: p.code, name: p.name, level: p.level, depth: p.depth, seq: p.seq, mark: p.mark,
        hasDrawing: !!d, drawingId: d ? Number(d.id) : null, fileKind: d ? d.file_kind ?? 'dxf' : null, fileName: d?.file_name ?? null,
        number: ref?.number ?? null, revision: ref?.revision ?? null, status: ref?.status ?? null,
        // No file on the line: the register drawing that covers the row (opens by its file, or by its link), else null.
        sheet: d ? null : sheetOf(p),
        // A plate part's cut plates, so the nesting screen (which knows cut plates, not rows) can find the part's drawing.
        isPlatePart: p.isPlatePart, cutPlateIds: p.cutPlateIds,
      };
    }).sort((a, b) => a.depth - b.depth || a.seq - b.seq),
  };
}

export async function getDrawings(db, companyId, orderId, lineId) {
  const line = await requireLine(db, companyId, orderId, lineId);
  const [rows, drawings] = [await rowsOfLine(db, companyId, line), await liveDrawings(db, companyId, line.id)];
  // The safety net: a plate part's drawing saved without a shape is read now, shown, and kept.
  await readMissingShapes(db, companyId, rows, drawings);
  const refs = await registerRefs(db, companyId, [...drawings.map((d) => d.drawing_id), ...rows.flatMap((p) => p.drawingIds)]);
  return viewOf(line, rows, drawings, refs);
}

/** A number no other shop drawing has: "SO-20260930-0001/TF1", else with the line, else numbered on. */
async function freeNumber(db, companyId, line, mark, taken) {
  const base = [`${line.order_code}/${mark}`, `${line.order_code}/L${line.line_no}/${mark}`];
  for (let i = 2; i < 50; i++) base.push(`${line.order_code}/L${line.line_no}/${mark}-${i}`);
  const cands = base.map((x) => x.slice(0, 150));
  const [rows] = await db.query("SELECT LOWER(number) AS n FROM cf_drawings WHERE company_id = ? AND source = 'shop' AND deleted_at IS NULL AND LOWER(number) IN (?)", [companyId, cands.map((x) => x.toLowerCase())]);
  const used = new Set([...rows.map((r) => r.n), ...taken]);
  const pick = cands.find((x) => !used.has(x.toLowerCase())) ?? `${line.order_code}/${mark}-${Date.now()}`.slice(0, 150);
  taken.add(pick.toLowerCase());
  return pick;
}

/** The live revision (draft or issued) of the drawing `id` belongs to, or null when it was withdrawn. */
async function liveRevisionOf(db, companyId, id) {
  const [[x]] = await db.query('SELECT id, root_id FROM cf_drawings WHERE company_id = ? AND id = ?', [companyId, Number(id)]);
  if (!x) return null;
  const [[d]] = await db.query(
    "SELECT * FROM cf_drawings WHERE company_id = ? AND root_id = ? AND deleted_at IS NULL AND status IN ('draft', 'issued') ORDER BY id DESC LIMIT 1",
    [companyId, Number(x.root_id ?? x.id)],
  );
  return d ?? null;
}

/**
 * START a drawing from rows of the line, before any file exists — the register entry (number,
 * revision, title, customer's or ours, draft or issued) linked to those rows. Its file comes later
 * (upload with drawingId, or by the rows' drawing mark).
 * input: { rowIds, number, revision?, title?, source?, status?, notes?, links? }
 * Every linked copy of a chosen row is covered too ("same design" — the drawing is part of it),
 * unless `links: 'one'`; the answer's `fanOut` says which rows were added.
 */
export async function startDrawing(db, c, orderId, lineId, input = {}) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, orderId, lineId);
  const rows = await rowsOfLine(db, companyId, line);
  const chosen = [...new Set((Array.isArray(input.rowIds) ? input.rowIds : []).map(Number).filter(Number.isInteger))];
  if (!chosen.length) throw invalid('NO_ROWS', 'Choose the row (or rows) the drawing is for.');
  const byId = new Map(rows.map((p) => [p.id, p]));
  const foreign = chosen.filter((id) => !byId.has(id));
  if (foreign.length) throw invalid('NOT_ON_LINE', `${foreign.length === 1 ? 'A chosen row is' : `${foreign.length} chosen rows are`} not on line ${line.line_no} of ${line.order_code}.`);
  // The copies of the rows chosen: one cheap question, and the line's links only when it has any.
  const fanOut = { fromRowIds: [], added: [], skipped: [] };
  const [[anyLinked]] = await db.query(
    "SELECT 1 AS x FROM cf_item_details WHERE company_id = ? AND master_id IN (?) AND link_group IS NOT NULL AND deleted_at IS NULL LIMIT 1",
    [companyId, chosen],
  );
  if (anyLinked) {
    const mates = matesOf(await linksOfLine(db, companyId, line.id), chosen).filter((m) => byId.has(m.id));
    fanOut.fromRowIds = [...new Set(mates.map((m) => m.from))];
    if (input.links === 'one') fanOut.skipped = mates.map((m) => ({ rowId: m.id, why: 'only the rows chosen were asked for' }));
    else fanOut.added = mates.map((m) => m.id);
  }
  const want = [...chosen, ...fanOut.added];
  const first = byId.get(want[0]);
  const d = await createDrawing(db, c, {
    number: input.number, revision: input.revision, source: input.source, status: input.status, notes: input.notes,
    title: input.title !== undefined ? input.title : first?.name ?? null,
  });
  await insertRows(db, 'cf_drawing_links', ['company_id', 'drawing_id', 'subject_type', 'subject_id', 'created_by'],
    want.map((id) => [companyId, d.id, 'master_record', id, c.userId ?? null]));
  // A drawing started on some copies only makes them a different design from the rest.
  if (anyLinked && fanOut.skipped.length) { const { settleLine } = await import('./linkService.js'); await settleLine(db, c, line.id); }
  return { drawing: { id: d.id, code: d.code, number: d.number, revision: d.revision, status: d.status }, fanOut, view: await getDrawings(db, companyId, null, line.id) };
}

const decode = (content) => Buffer.from(String(content ?? '').replace(/^data:[^,]*,/, ''), 'base64');
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listOf = (xs, max = 3) => (xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`);

/**
 * THE CODES A FILE NAME IS MATCHED AGAINST (lib/drawingName.js): one entry per row of the line.
 * Before the design is frozen a row has no code, so it is the code its pieces WILL get, printed
 * with the numbers each # stands for (placeholderService — what the screen shows); once the line is
 * locked, the real code of each of its pieces (cf_order_pieces). A fixed handful of round trips.
 * → { rows: [{ id, texts: [code] , code, segments, pieces }], frozen }
 */
export async function codeRowsOfLine(db, companyId, line, rowIds = null) {
  const keep = rowIds ? new Set(rowIds.map(Number)) : null;
  const out = new Map();
  if (line.locked_at) {
    const [pieces] = await db.query(
      'SELECT item_id, code FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL ORDER BY sort_order, id',
      [companyId, line.id],
    );
    for (const p of pieces) {
      const id = Number(p.item_id);
      if (keep && !keep.has(id)) continue;
      if (!out.has(id)) out.set(id, { id, texts: [], code: null, segments: null, pieces: 0 });
      const row = out.get(id);
      row.texts.push(p.code); row.pieces += 1;
    }
    return { rows: [...out.values()], frozen: true };
  }
  const { linePlaceholders } = await import('./placeholderService.js');
  let ph;
  try { ph = await linePlaceholders(db, companyId, line.id); } catch { return { rows: [], frozen: false }; }
  for (const r of ph.rows ?? []) {
    const id = Number(r.itemId);
    if ((keep && !keep.has(id)) || r.code == null) continue;
    if (!out.has(id)) out.set(id, { id, texts: [], code: r.code, segments: r.segments ?? null, pieces: 0 });
    const row = out.get(id);
    row.texts.push(codeWithNumbers(r.code, r.segments));
    row.pieces += Number(r.pieces ?? 0);
  }
  return { rows: [...out.values()], frozen: false };
}

/**
 * The line as the Values screen loads it (orderValuesService.loadContext — 9 reads, whatever its
 * size) with its linked copies worked out from the same rows: what an upload needs to send a
 * drawing to every copy and to fill only the cells that are still empty. null when the line cannot
 * be read that way (no structure yet).
 */
async function linksOfLine(db, companyId, lineId) {
  const { loadContext } = await import('./orderValuesService.js');
  const { readLinks } = await import('./linkService.js');
  let ctx;
  try { ctx = await loadContext(db, companyId, lineId); } catch { return null; }
  return readLinks(db, companyId, lineId, { ctx });
}

/** Every effective link-mate of some rows that is not one of them: [{ from, id }]. */
function matesOf(links, ids) {
  if (!links) return [];
  const have = new Set(ids);
  const out = [];
  for (const id of ids) {
    const g = links.byRecord.get(id)?.g;
    if (!g) continue;
    for (const m of links.groups.get(g)) if (!have.has(m)) { have.add(m); out.push({ from: id, id: m }); }
  }
  return out;
}

const SIZE_TOL = 1;   // mm: partGeometry.orientTo's own tolerance for "the drawing is the row's size"
const sameNumber = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= 0.011;
const sameWord = (a, b) => String(a ?? '').replace(/[\s_-]+/g, '').toUpperCase() === String(b ?? '').replace(/[\s_-]+/g, '').toUpperCase();

/**
 * What a file can say about the VALUES of its rows — the drawing's rectangle (LENGTH, WIDTH; a
 * plate part's DXF only), and the thickness and grade its name or its own words state — and which
 * of those go into EMPTY cells. A filled cell is never changed: one that disagrees is said.
 *   offers   [{ specCode, value, from: 'drawing' | 'name' | 'title' }]
 *   cells    orderValuesService.cellStates' answer       rows   the rows the file goes to
 * → { values: [{ specCode, value, from, rows: [ids to write], kept: [ids that keep their own] }], warnings }
 */
function planValues(offers, rows, cells, labelOf) {
  const values = [];
  const warnings = [];
  for (const o of offers) {
    const v = { specCode: o.specCode, value: o.value, from: o.from, rows: [], kept: [] };
    const differ = [];
    for (const p of rows) {
      if (o.plateOnly && !p.isPlatePart) continue;
      const cell = cells.get(p.id)?.get(o.specCode);
      if (!cell || !cell.typeable) continue;
      if (cell.empty) {
        if (cell.dataType === 'option' && !(cell.options ?? []).some((x) => sameWord(x.value, o.value) || sameWord(x.label, o.value))) {
          if (!warnings.some((w) => w.startsWith(`${o.value} `))) warnings.push(`${o.value} (from the ${o.from === 'name' ? 'file name' : 'drawing'}) is not one of the choices of ${o.specCode} here — it is not written.`);
          continue;
        }
        // A size is only written when it does not contradict the other side already typed.
        if (o.pairWith) {
          const other = cells.get(p.id)?.get(o.pairWith.specCode);
          if (other && !other.empty && Math.abs(Number(other.raw) - o.pairWith.value) > SIZE_TOL) continue;
        }
        v.rows.push(p.id);
        continue;
      }
      v.kept.push(p.id);
      const same = cell.dataType === 'option' ? sameWord(cell.optionValue, o.value) || sameWord(cell.display, o.value) : cell.dataType === 'number' ? sameNumber(cell.raw, o.value) : sameWord(cell.raw, o.value);
      if (!same && !o.quiet) differ.push(`${labelOf(p)} (${cell.display ?? cell.raw})`);
    }
    if (differ.length) warnings.push(`${o.specCode} is already ${differ.length === 1 ? `filled on ${differ[0]}` : `filled on ${listOf(differ)}`}; the ${o.from === 'name' ? 'file name' : o.from === 'title' ? 'drawing\'s title' : 'drawing'} says ${o.value} — the order's value is kept.`);
    if (v.rows.length || v.kept.length) values.push(v);
  }
  return { values, warnings };
}

/**
 * input: { files: [{ name, content (base64), rowId?, drawingId?, links?, replaceOnMembers? }], dryRun,
 *          links?, replaceOnMembers? }  (the two last: the default for every file)
 *
 * WHICH ROWS A FILE IS FOR — in this order, the first that finds a row wins (`matchedBy`):
 *   row / register   it is AIMED: rowId (a row of the line) or drawingId (a register drawing).
 *                    A markless row aimed at takes the file name as its DRAWING_MARK (written on
 *                    save); a row with another mark keeps it and the answer says so (`notes`).
 *   code             its NAME is the end of the rows' code, as the screen prints it:
 *                    `L(1,5)-1-TFL1.dxf`, `L(2-4)-1-TFL1.dxf` (lib/drawingName.js). Before the
 *                    design is frozen that is the code preview; after, the real piece codes.
 *   mark             its name is a row's DRAWING_MARK — the whole name first, then the name
 *                    without the thickness / grade it carries (`TFL1_25mm_E350.dxf` → TFL1).
 * THEN EVERY LINKED COPY of every row found takes the drawing too ("same design", linkService) —
 * unless `links: 'one'` on a file aimed at a row, which keeps it to that row (it then stops being
 * a copy: the drawing is part of the design). One register drawing; cf_drawing_links carries the
 * extra rows. `fanOut` says which rows were added.
 *
 * WHAT IS REFUSED OR ASKED
 *   error      two files of one upload reaching the same row (the later one); a name whose
 *              brackets do not read; what was refused before (not a DXF, too large…)
 *   conflict   a row reached through a copy or a code already has ANOTHER live drawing. Nothing is
 *              saved for that file unless `replaceOnMembers: true`, which takes the other drawing
 *              off those rows.
 *   a note     a name that reaches rows which are not the same design, or only some pieces of a
 *              row (the drawing goes on the whole row — decision D5).
 *
 * VALUES (per file `values`, the line's total as `valuesWritten`). Into EMPTY cells only, one bulk
 * write for all files and rows: LENGTH and WIDTH from a plate part's drawing rectangle, THICKNESS
 * and GRADE from the file name (`_25mm_E350`) else the drawing's own words. A filled cell that
 * disagrees is a warning. A locked line takes the drawing and no value. The parts' true area and
 * holes follow as before (drawingValueService).
 *
 * Each file: status new | replaces | unmatched | conflict | error. A non-dry run saves the new and
 * replacing ones and refreshes the line's cut plates' cut length and piercings.
 */
export async function uploadDrawings(db, c, orderId, lineId, input = {}) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, orderId, lineId);
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw invalid('NO_FILES', 'Choose one or more drawings (DXF or PDF) — each named by its drawing mark or its code.');
  if (Number(line.released)) throw invalid('RELEASED', `Line ${line.line_no} of ${line.order_code} is released to production — its drawings can no longer change.`);
  const dryRun = input.dryRun !== false;
  const rows = await rowsOfLine(db, companyId, line);
  const byMark = new Map();
  for (const p of rows) if (p.markNorm) { if (!byMark.has(p.markNorm)) byMark.set(p.markNorm, []); byMark.get(p.markNorm).push(p); }
  const rowById = new Map(rows.map((p) => [p.id, p]));
  const live = await liveDrawings(db, companyId, line.id);
  const existing = new Map(live.map((d) => [d.mark_norm, d]));
  const fileOfDrawing = new Map(live.filter((d) => d.drawing_id != null).map((d) => [Number(d.drawing_id), d]));
  // The line's values and linked copies (one load), and — only when a file is not aimed — the codes names are matched against.
  const links = await linksOfLine(db, companyId, line.id);
  const labelOf = (p) => p.code ?? (p.mark ? `${p.name} (${p.mark})` : p.name);
  let codeRows = null;
  const codesOnce = async () => { codeRows ??= (await codeRowsOfLine(db, companyId, line, rows.map((p) => p.id))).rows; return codeRows; };
  const seen = new Set();
  const seenDrawing = new Set();
  const taken = new Set();
  const claimed = new Map();   // row id -> the file of this upload that goes to it
  const out = [];
  for (const f of files) {
    const name = String(f?.name ?? '').trim();
    const kind = kindOf(name);
    const parsed = parseDrawingName(name);
    let mark = name.replace(/\.(dxf|pdf)$/i, '').trim();
    // Attached to a register drawing by hand: its rows' drawing mark, when they share one.
    const wanted = f?.drawingId != null && f.drawingId !== '' ? Number(f.drawingId) : null;
    let target = null;
    let targetProblem = null;
    if (wanted != null) {
      const [[d]] = await db.query('SELECT * FROM cf_drawings WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, wanted]);
      const linked = rows.filter((p) => p.drawingIds.includes(wanted));
      if (!d) targetProblem = 'That register drawing no longer exists.';
      else if (!['draft', 'issued'].includes(d.status)) targetProblem = `${d.number} rev ${d.revision} is ${d.status} — attach the file to its live revision.`;
      else if (!linked.length) targetProblem = `${d.number} covers no row of this line.`;
      else {
        target = d;
        const marks = [...new Set(linked.map((p) => p.mark).filter(Boolean))];
        mark = marks.length === 1 ? marks[0] : String(d.number);
      }
    }
    // Aimed at one row by hand: the row's own mark, else the file's name becomes it.
    const aimed = f?.rowId != null && f.rowId !== '' ? Number(f.rowId) : null;
    const tRow = aimed != null ? rowById.get(aimed) ?? null : null;
    const notes = [];
    let markFromName = false;
    if (aimed != null && !tRow) targetProblem = targetProblem ?? 'That row is not on this line.';
    else if (tRow && !target) {
      if (tRow.mark) {
        if (normMark(name) !== tRow.markNorm) notes.push(`The file name ${name} differs from this row's drawing mark ${tRow.mark} — the file is kept for the row, nothing is renamed.`);
        mark = tRow.mark;
      } else markFromName = true;
    }
    // Not aimed: its name as a code (the end of the rows' printed code), then as a drawing mark.
    let matchedBy = wanted != null ? 'register' : aimed != null ? 'row' : 'none';
    let codeHits = null;
    if (wanted == null && aimed == null && !targetProblem) {
      if (parsed.kind === 'code' && parsed.problems.length) targetProblem = `The brackets in ${name} do not read: ${parsed.problems.join(' ')}`;
      else {
        const hits = parsed.pattern ? matchCodePattern(parsed.pattern, await codesOnce()).filter((h) => rowById.has(h.id)) : [];
        if (hits.length) { matchedBy = 'code'; codeHits = hits; mark = parsed.base; }
        else if (byMark.has(parsed.markFull)) matchedBy = 'mark';
        else if (parsed.markStripped && byMark.has(parsed.markStripped)) { matchedBy = 'mark'; mark = parsed.base; }
      }
    }
    const markNorm = normMark(mark);
    const entry = {
      name, mark, fileKind: kind, status: 'error', matchedBy, pattern: matchedBy === 'code' ? parsed.base : null,
      hints: { thicknessMm: parsed.hints.thicknessMm, grade: parsed.hints.grade },
      rows: [], geometry: null, problems: [], warnings: [], notes, targetRowId: tRow?.id ?? null, markSet: false, register: null,
      fanOut: { fromRowIds: [], added: [], skipped: [] }, values: [], _save: null, _offers: null,
    };
    out.push(entry);
    if (targetProblem) { entry.problems.push(targetProblem); continue; }
    if (!kind) { entry.problems.push('Only DXF and PDF drawings are taken.'); continue; }
    if (!markNorm) { entry.problems.push('The file name is empty — name it by the drawing mark.'); continue; }
    if (seen.has(markNorm)) { entry.problems.push('Another file in this upload has the same drawing mark.'); continue; }
    seen.add(markNorm);
    const buf = decode(f.content);
    if (!buf.length) { entry.problems.push('The file is empty.'); continue; }
    if (buf.length > MAX_FILE_BYTES) { entry.problems.push('The file is larger than 4 MB.'); continue; }
    if (kind === 'pdf' && buf.subarray(0, 5).toString('latin1') !== '%PDF-') { entry.problems.push('This does not read as a PDF file.'); continue; }
    // The register drawing it goes on: the one asked for, else the one its mark's file sits on, else
    // one waiting (no file yet) on a row with its mark.
    if (!target && existing.get(markNorm)?.drawing_id != null) target = await liveRevisionOf(db, companyId, existing.get(markNorm).drawing_id);
    const hitIds = new Set((codeHits ?? []).map((h) => h.id));
    // The rows found for the file itself (before its copies are added).
    const directOf = () => rows.filter((p) => (tRow && p.id === tRow.id) || hitIds.has(p.id) || (p.markNorm && p.markNorm === markNorm) || (target && p.drawingIds.includes(Number(target.id))));
    let direct = directOf();
    // What the file says about copies, read early: a file aimed at ONE row and kept to it is that row's own drawing.
    const choice = f?.links ?? input.links ?? null;
    const onlyThis = choice === 'one' && tRow != null;
    // …else the ONE live drawing every row found is already read by: the same sheet under a new
    // name is a new file for it (a draft's file replaced, an issued one revised) — not a second drawing.
    if (!target && direct.length && !onlyThis) {
      const current = new Set(direct.map((p) => fileFor(p, live)));
      const only = current.size === 1 ? [...current][0] : null;
      if (only?.drawing_id != null && (matchedBy === 'code' || (matchedBy === 'row' && !tRow?.mark))) target = await liveRevisionOf(db, companyId, only.drawing_id);
    }
    if (!target) {
      const waitingIds = [...new Set([...(byMark.get(markNorm) ?? []), ...(tRow ? [tRow] : []), ...direct].flatMap((p) => p.drawingIds))].filter((id) => !fileOfDrawing.has(id));
      if (waitingIds.length) {
        const [cands] = await db.query("SELECT * FROM cf_drawings WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL AND status IN ('draft', 'issued') ORDER BY id", [companyId, waitingIds]);
        target = cands.find((d) => normMark(String(d.number).split('/').pop()) === markNorm) ?? cands[0] ?? null;
      }
    }
    if (target && seenDrawing.has(Number(target.id))) { entry.problems.push(`Another file in this upload goes on the same drawing (${target.number}).`); continue; }
    if (target) seenDrawing.add(Number(target.id));
    direct = directOf();
    // Every linked copy of a row found takes the drawing too — unless a file aimed at ONE row says otherwise.
    const mates = matesOf(links, direct.map((p) => p.id)).filter((m) => rowById.has(m.id));
    entry.fanOut.fromRowIds = [...new Set(mates.map((m) => m.from))];
    if (onlyThis) {
      entry.fanOut.skipped = mates.map((m) => ({ rowId: m.id, label: labelOf(rowById.get(m.id)), why: 'only this row was asked for' }));
      if (mates.length) notes.push(`${labelOf(tRow)} has ${plural(mates.length, 'linked copy', 'linked copies')}; with this drawing on it alone it stops being a copy of ${mates.length === 1 ? 'it' : 'them'}.`);
    } else entry.fanOut.added = mates.map((m) => m.id);
    const added = onlyThis ? [] : mates.map((m) => rowById.get(m.id));
    const matched = [...direct, ...added];
    const plate = matched.filter((p) => p.isPlatePart);
    entry.rows = matched.map((p) => rowView(p, null));
    if (added.length) notes.push(`Goes to ${plural(matched.length, 'linked row')} — ${plural(added.length, 'copy', 'copies')} of ${direct.length === 1 ? labelOf(direct[0]) : 'the rows it names'}.`);
    if (codeHits) {
      const partial = codeHits.filter((h) => h.partial && rowById.has(h.id));
      if (partial.length) notes.push(`${name} names only some of the pieces of ${listOf(partial.map((h) => labelOf(rowById.get(h.id))))} — a drawing belongs to the whole row, so it goes on ${partial.length === 1 ? 'it' : 'each of them'} as a whole.`);
      if (links && new Set(direct.map((p) => links.fp.get(p.id))).size > 1) notes.push(`The ${direct.length} rows this name reaches are not all the same design — the drawing is attached to every one of them.`);
    }
    let g = null;
    let text = null;
    if (kind === 'dxf') {
      text = buf.toString('latin1');
      // Not a DXF at all (a DWG, a binary DXF, something renamed) is refused whatever row it is for.
      const notDxf = readPartDrawing(text.slice(0, 4096)).problems.find((x) => /DWG|binary DXF|does not read as a DXF/.test(x));
      if (notDxf && !/(^|\n)\s*0\s*\r?\n\s*SECTION/.test(text)) { entry.problems.push(notDxf); continue; }
      // A plate part's DXF is its shape — whether or not its cut plate exists yet (the header's rule);
      // any other row's DXF (an assembly, a profile part) is only kept (a GA is not one outline).
      if (plate.length || !matched.length) {
        const read = readPartDrawing(text);
        entry.warnings.push(...read.warnings);
        if (read.geometry) g = read.geometry;
        else if (plate.length) { entry.problems.push(...read.problems); continue; }
      }
    } else if (plate.length) entry.warnings.push('A PDF has no shape to read — upload the part\'s DXF for its true area, cut length and piercings.');
    if (g) {
      entry.geometry = geometryView(g);
      entry.rows = matched.map((p) => rowView(p, g));
      for (const p of plate) { const w = sizeWarning(p, g); if (w) entry.warnings.push(w); }
    }
    if (!matched.length) {
      entry.status = 'unmatched';
      entry.warnings.push(parsed.kind === 'code' ? `No row on this line has a code ending in ${parsed.base}.` : `No row on this line has drawing mark ${mark}.`);
      continue;
    }
    // One drawing file per row in an upload: the later file is the one refused.
    const clash = matched.filter((p) => claimed.has(p.id));
    if (clash.length) {
      entry.problems.push(`${listOf(clash.map(labelOf))} already ${clash.length === 1 ? 'takes' : 'take'} ${claimed.get(clash[0].id)} from this upload — a row takes one drawing file at a time.`);
      continue;
    }
    for (const p of matched) claimed.set(p.id, name);
    const hadFile = target ? fileOfDrawing.has(Number(target.id)) : false;
    const replaces = [existing.get(markNorm)?.id, target ? fileOfDrawing.get(Number(target.id))?.id : null].filter(Boolean);
    // A row reached through a copy or a code that is already read by ANOTHER live drawing.
    const reached = new Set([...added.map((p) => p.id), ...hitIds]);
    const conflicts = matched.filter((p) => reached.has(p.id)).flatMap((p) => live.filter((d) => matches(p, d) && !replaces.includes(d.id)).map((d) => ({ p, d })));
    const replaceOnMembers = (f?.replaceOnMembers ?? input.replaceOnMembers) === true;
    if (conflicts.length) {
      entry.conflicts = conflicts.map(({ p, d }) => ({ rowId: p.id, label: labelOf(p), drawingId: Number(d.id), fileName: d.file_name, mark: d.mark }));
      if (!replaceOnMembers) {
        entry.status = 'conflict';
        entry.warnings.push(`${listOf(conflicts.map(({ p, d }) => `${labelOf(p)} (${d.file_name})`))} already ${conflicts.length === 1 ? 'has' : 'have'} another drawing — choose "Replace on all" to put this one in its place, or leave ${conflicts.length === 1 ? 'it' : 'them'} out.`);
        for (const p of matched) claimed.delete(p.id);
        continue;
      }
      const byMarkStill = conflicts.filter(({ p, d }) => p.markNorm && p.markNorm === d.mark_norm);
      if (byMarkStill.length) notes.push(`${listOf(byMarkStill.map(({ p }) => labelOf(p)))} still ${byMarkStill.length === 1 ? 'carries' : 'carry'} the drawing mark of the drawing replaced — that file goes with it only when no other row uses it.`);
    }
    entry.markSet = markFromName;
    entry.status = existing.has(markNorm) || hadFile ? 'replaces' : 'new';
    const action = !target ? 'create' : hadFile ? (target.status === 'issued' ? 'revise' : 'replace') : 'attach';
    const number = target ? target.number : await freeNumber(db, companyId, line, mark, taken);
    entry.register = {
      action, drawingId: target ? Number(target.id) : null, code: target?.code ?? null, number,
      revision: action === 'revise' ? nextRevision(target.revision) : target ? target.revision : 'A',
      fromRevision: action === 'revise' ? target.revision : null,
    };
    // What the file can say about its rows' values (written into empty cells only, below).
    const offers = [];
    if (g && plate.length) {
      const [long, short] = [Math.max(g.lengthMm, g.widthMm), Math.min(g.lengthMm, g.widthMm)].map(r2);
      offers.push({ specCode: 'LENGTH', value: long, from: 'drawing', plateOnly: true, quiet: true, pairWith: { specCode: 'WIDTH', value: short } });
      offers.push({ specCode: 'WIDTH', value: short, from: 'drawing', plateOnly: true, quiet: true, pairWith: { specCode: 'LENGTH', value: long } });
    }
    const words = text != null && (parsed.hints.thicknessMm == null || parsed.hints.grade == null) ? dxfTextHints(text) : { thicknessMm: null, grade: null };
    const thickness = parsed.hints.thicknessMm ?? words.thicknessMm;
    const grade = parsed.hints.grade ?? words.grade;
    if (thickness != null) offers.push({ specCode: 'THICKNESS', value: thickness, from: parsed.hints.thicknessMm != null ? 'name' : 'title' });
    if (grade != null) offers.push({ specCode: 'GRADE', value: grade, from: parsed.hints.grade != null ? 'name' : 'title' });
    entry.hints = { thicknessMm: thickness ?? null, grade: grade ?? null };
    entry._offers = { offers, rows: matched };
    entry._save = {
      markRowId: markFromName ? tRow.id : null, mark, markNorm, name, kind, g: plate.length ? g : null, warnings: entry.warnings, body: kind === 'dxf' ? text : buf.toString('base64'),
      action, target, number, title: matched[0]?.name ?? null, rowIds: matched.map((p) => p.id), replaces,
      detach: replaceOnMembers ? conflicts.map(({ p, d }) => ({ rowId: p.id, fileId: Number(d.id), drawingId: d.drawing_id != null ? Number(d.drawing_id) : null })) : [],
    };
  }
  const toSave = out.filter((e) => e._save);

  // ---- the values the files state, for the cells that are still empty (from the load above) ----
  const offering = toSave.filter((e) => e._offers.offers.length);
  let writes = [];
  if (offering.length) {
    const { cellStates } = await import('./orderValuesService.js');
    const ctx = links?.ctx ?? null;
    if (ctx) {
      const frozen = !!ctx.line.lockedAt;
      const cells = cellStates(ctx, [...new Set(offering.flatMap((e) => e._offers.rows.map((p) => p.id)))], ['LENGTH', 'WIDTH', 'THICKNESS', 'GRADE']);
      for (const e of offering) {
        const planned = planValues(e._offers.offers, e._offers.rows, cells, labelOf);
        e.values = planned.values.map(({ specCode, value, from, rows: to, kept }) => ({ specCode, value, from, rows: frozen ? [] : to, kept: frozen ? [...kept, ...to] : kept }));
        e.warnings.push(...planned.warnings);
        if (frozen) { if (planned.values.some((v) => v.rows.length)) e.notes.push('The design is frozen — the drawing is attached, and no value is written from it.'); continue; }
        for (const v of planned.values) for (const id of v.rows) writes.push({ recordId: id, specCode: v.specCode, value: v.value });
      }
      // Two files saying two things for one cell cannot both be written: the first stands.
      const first = new Map();
      writes = writes.filter((w) => { const k = `${w.recordId}:${w.specCode}`; if (first.has(k)) return false; first.set(k, w); return true; });
    }
  }

  let view = null;
  let values = null;
  let valuesWritten = null;
  if (!dryRun && toSave.length) {
    const replaced = [...new Set(toSave.flatMap((e) => e._save.replaces))];
    // Rows aimed at with a file but no mark yet take the file's name as their DRAWING_MARK: one lookup, one insert.
    const marked = toSave.map((e) => e._save).filter((s) => s.markRowId != null);
    if (marked.length) {
      const [[spec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'DRAWING_MARK' AND deleted_at IS NULL", [companyId]);
      if (spec) {
        await db.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND specification_id = ? AND subject_id IN (?) AND deleted_at IS NULL", [companyId, spec.id, marked.map((s) => s.markRowId)]);
        await insertRows(db, 'cf_spec_values', ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_text', 'source'], marked.map((s) => [companyId, spec.id, 'master', s.markRowId, s.mark.slice(0, 120), 'entered']));
      }
    }
    // The replaced files keep their drawing_id: an issued revision's file stays downloadable from it.
    if (replaced.length) await db.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, replaced]);
    // "Replace on all": the other drawing comes off the rows this one now goes to — its register
    // link in one statement, and the file itself when no row of the line is left to read it.
    const detach = toSave.flatMap((e) => e._save.detach);
    if (detach.length) {
      const pairs = detach.filter((d) => d.drawingId != null);
      if (pairs.length) {
        await db.query(
          `UPDATE cf_drawing_links SET deleted_at = NOW()
            WHERE company_id = ? AND subject_type = 'master_record' AND deleted_at IS NULL AND (drawing_id, subject_id) IN (${pairs.map(() => '(?, ?)').join(', ')})`,
          [companyId, ...pairs.flatMap((d) => [d.drawingId, d.rowId])],
        );
      }
      const gone = new Map();   // file id -> rows taken off it
      for (const d of detach) { if (!gone.has(d.fileId)) gone.set(d.fileId, new Set()); gone.get(d.fileId).add(d.rowId); }
      const orphaned = [...gone].filter(([fileId, off]) => {
        const file = live.find((x) => Number(x.id) === fileId);
        return file && rows.filter((p) => matches(p, file)).every((p) => off.has(p.id));
      }).map(([fileId]) => fileId);
      if (orphaned.length) await db.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [companyId, orphaned]);
    }
    for (const { _save: s } of toSave) {
      let drawingId;
      if (s.action === 'create') drawingId = (await createDrawing(db, c, { number: s.number, revision: 'A', title: s.title, source: 'shop', status: 'issued' })).id;
      else if (s.action === 'revise') drawingId = (await reviseDrawing(db, c, s.target.id, {})).id;
      else drawingId = Number(s.target.id);
      const [have] = await db.query("SELECT subject_id FROM cf_drawing_links WHERE company_id = ? AND drawing_id = ? AND subject_type = 'master_record' AND deleted_at IS NULL", [companyId, drawingId]);
      const linked = new Set(have.map((h) => Number(h.subject_id)));
      const add = s.rowIds.filter((id) => !linked.has(id));
      if (add.length) await insertRows(db, 'cf_drawing_links', ['company_id', 'drawing_id', 'subject_type', 'subject_id', 'created_by'], add.map((id) => [companyId, drawingId, 'master_record', id, c.userId ?? null]));
      // One at a time: a drawing can be megabytes, and a TiDB statement is one entry.
      await insertRows(db, 'cf_part_drawings', [
        'company_id', 'order_line_id', 'drawing_id', 'mark', 'mark_norm', 'file_name', 'file_kind', 'length_mm', 'width_mm', 'area_mm2', 'cut_length_mm',
        'piercings', 'holes', 'inner_cuts', 'geometry_json', 'warnings_json', 'dxf_text', 'created_by',
      ], [[
        companyId, line.id, drawingId, s.mark.slice(0, 120), s.markNorm.slice(0, 120), s.name.slice(0, 255), s.kind,
        s.g?.lengthMm ?? null, s.g?.widthMm ?? null, s.g?.areaMm2 ?? null, s.g?.cutLengthMm ?? null,
        s.g?.piercings ?? null, s.g?.holes ?? null, s.g?.innerCuts ?? null, s.g ? JSON.stringify(s.g) : null, JSON.stringify(s.warnings), s.body, c.userId ?? null,
      ]]);
    }
    // The sizes, thickness and grade the files state, into the empty cells: ONE bulk write for
    // every file and every row (orderValuesService — rules, history, what is worked out from them,
    // and the linked copies settled). Every copy takes the same value, so nothing stops being one.
    if (writes.length) {
      try {
        const { writeLineValues } = await import('./orderValuesService.js');
        const w = await writeLineValues(db, c, line.id, { writes });
        valuesWritten = { written: w.summary.changed, derived: w.summary.derived, records: w.summary.records };
      } catch (err) {
        valuesWritten = { written: 0, error: err?.problems?.length ? err.problems.slice(0, 3).join(' ') : err?.message ?? String(err) };
        for (const e of offering) { e.values = e.values.map((v) => ({ ...v, kept: [...v.kept, ...v.rows], rows: [] })); e.warnings.push(`The values from the drawing were not written: ${valuesWritten.error}`); }
      }
    }
    const { refreshPlateCuts } = await import('./plateCutsService.js');
    await refreshPlateCuts(db, c, line.id);
    // The parts take their true area and holes from the new shapes; a replaced drawing's are replaced with it.
    const { refreshDrawingValues } = await import('./drawingValueService.js');
    values = await refreshDrawingValues(db, c, line.id, { force: true });
    // The drawing a row is built to is part of its design: a row that got one alone is not a copy any more.
    // (ONE round trip when nothing on the line is linked; the value write above has done it otherwise.)
    if (!(valuesWritten && !valuesWritten.error)) { const { settleLine } = await import('./linkService.js'); await settleLine(db, c, line.id); }
    view = await getDrawings(db, companyId, null, line.id);
  }
  return {
    dryRun, saved: !dryRun && toSave.length > 0, files: out.map(({ _save, _offers, ...e }) => e), view,
    ...(values ? { values } : {}), ...(valuesWritten ? { valuesWritten } : {}),
  };
}

/**
 * GET /order-lines/:id/design-uses?group=|recordId=|drawingId= — the rows one design is used by,
 * and the pieces they are ("used by N pieces"). Codes are not shared between copies: each row keeps
 * its own, so they are listed, never merged.
 *   group      a link group's key (as GET values gives it)      recordId   a row: its group, or itself
 *   drawingId  a drawing FILE of the line (the id GET …/drawings and …/drawings/tree give), else a
 *              register drawing's id: the rows it is on
 * → { rows: [{ recordId, label, code, segments, pieces }], pieces: [{ code, recordId }], total, frozen }
 *   code / segments  the row's code as the screen prints it (the preview before the design is
 *                    frozen, null once it is: the pieces then carry the codes)
 *   pieces           before the design is frozen there are no piece codes yet: [] — `total` still
 *                    says how many pieces the rows stand for
 */
export async function designUses(db, companyId, lineId, query = {}) {
  const line = await requireLine(db, companyId, null, lineId);
  const { readLinks } = await import('./linkService.js');
  const { labelOfRecord } = await import('./orderValuesService.js');
  const links = await readLinks(db, companyId, line.id);
  let ids = [];
  if (query.group != null && query.group !== '') ids = links.groups.get(String(query.group)) ?? [];
  else if (query.recordId != null && query.recordId !== '') {
    const id = Number(query.recordId);
    if (!links.fp.has(id)) throw notFound('Row');
    const g = links.byRecord.get(id)?.g;
    ids = g ? links.groups.get(g) : [id];
  } else if (query.drawingId != null && query.drawingId !== '') {
    const want = Number(query.drawingId);
    const rows = await rowsOfLine(db, companyId, line);
    const live = await liveDrawings(db, companyId, line.id);
    const file = live.find((d) => Number(d.id) === want) ?? null;
    ids = file ? rows.filter((p) => matches(p, file)).map((p) => p.id) : rows.filter((p) => p.drawingIds.includes(want)).map((p) => p.id);
    if (!file && !ids.length) throw notFound('Drawing');
  } else throw invalid('INVALID', 'Say which design — group, recordId or drawingId.');
  const coded = await codeRowsOfLine(db, companyId, line, ids);
  const byId = new Map(coded.rows.map((r) => [r.id, r]));
  const order = new Map([[links.ctx.line.itemId, 0], ...links.ctx.lines.map((l, i) => [l.childId, i + 1])]);
  const sorted = [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0) || a - b);
  const rows = sorted.map((id) => {
    const r = byId.get(id);
    return { recordId: id, label: labelOfRecord(links.ctx.records.get(id), links.ctx), code: coded.frozen ? null : r?.code ?? null, segments: coded.frozen ? null : r?.segments ?? null, pieces: r?.pieces ?? 0 };
  });
  const pieces = coded.frozen ? sorted.flatMap((id) => (byId.get(id)?.texts ?? []).map((code) => ({ code, recordId: id }))) : [];
  return { rows, pieces, total: rows.reduce((n, r) => n + Number(r.pieces ?? 0), 0), frozen: coded.frozen };
}

export async function deleteDrawing(db, c, orderId, lineId, drawingId) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, orderId, lineId);
  if (Number(line.released)) throw invalid('RELEASED', `Line ${line.line_no} of ${line.order_code} is released to production — its drawings can no longer change.`);
  const [r] = await db.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND id = ? AND deleted_at IS NULL', [companyId, line.id, Number(drawingId)]);
  if (!r.affectedRows) throw notFound('Drawing');
  const { refreshPlateCuts } = await import('./plateCutsService.js');
  await refreshPlateCuts(db, c, line.id);
  // Its parts go back to their rectangle (or to another drawing that still fits them).
  const { refreshDrawingValues } = await import('./drawingValueService.js');
  await refreshDrawingValues(db, c, line.id, { force: true });
  return getDrawings(db, companyId, null, line.id);
}

/** The file itself, to download: { filename, contentType, buffer }. */
export async function drawingFile(db, companyId, orderId, lineId, drawingId) {
  const line = await requireLine(db, companyId, orderId, lineId);
  const [[d]] = await db.query('SELECT file_name, file_kind, dxf_text FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND id = ? AND deleted_at IS NULL', [companyId, line.id, Number(drawingId)]);
  if (!d || d.dxf_text == null) throw notFound('Drawing');
  const kind = d.file_kind ?? 'dxf';
  return { filename: d.file_name, contentType: KINDS[kind], buffer: kind === 'pdf' ? Buffer.from(d.dxf_text, 'base64') : Buffer.from(d.dxf_text, 'latin1') };
}

/**
 * For plateCutsService and the CNC file: per cut plate of the line, what its parts' shapes say,
 * averaged over the pieces it is cut for (parts without a shape count as rectangles).
 * Map cutPlateId -> { cutLengthMm, piercings, alongLength, alongWidth, rings | null, pieces, drawnPieces, drawings, shapeNote | null }
 * rings only when every piece of the cut plate has the same shape, oriented to its length;
 * shapeNote says why not, when some piece of it does have a drawing.
 */
export function drawingFactsOfLine(db, companyId, lineId) {
  // Read once per plate save (lib/requestMemo.js — plateChangeGate's scope): a nesting save writes no drawing.
  return memoized(db, `drawingFacts:${companyId}:${Number(lineId)}`, () => readDrawingFacts(db, companyId, lineId));
}

async function readDrawingFacts(db, companyId, lineId) {
  // A DXF without a shape counts too: it may be a plate part's, saved before the row was known as one.
  const [has] = await db.query("SELECT COUNT(*) AS n FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND (geometry_json IS NOT NULL OR (file_kind = 'dxf' AND dxf_text IS NOT NULL))", [companyId, lineId]);
  const out = new Map();
  if (!Number(has[0].n)) return out;
  const line = await requireLine(db, companyId, null, lineId);
  const rows = await rowsOfLine(db, companyId, line);
  const parts = rows.filter((r) => r.isPlatePart);
  const drawings = await liveDrawings(db, companyId, line.id);
  // The safety net: nesting, cut length and the CNC file never see a plate part "without a shape" because of ordering.
  await readMissingShapes(db, companyId, rows, drawings);
  const shaped = drawings.filter((d) => d.geometry);
  const acc = new Map();
  for (const p of parts) {
    const d = fileFor(p, shaped);
    const w = Math.max(1, p.pieces);
    for (const cpId of p.cutPlateIds) {
      if (!acc.has(cpId)) acc.set(cpId, { n: 0, cut: 0, pierce: 0, aL: 0, aW: 0, drawn: 0, marks: new Set(), d: null, o: null });
      const a = acc.get(cpId);
      a.n += w;
      if (d && p.lengthMm > 0 && p.widthMm > 0) {
        const o = orientTo(d.geometry, p.lengthMm, p.widthMm);
        a.cut += w * d.geometry.cutLengthMm; a.pierce += w * d.geometry.piercings;
        a.aL += w * o.alongLength; a.aW += w * o.alongWidth; a.drawn += w; a.marks.add(d.id); a.d = d; a.o = o; a.partLength = p.lengthMm;
      } else {
        a.cut += w * 2 * ((p.lengthMm ?? 0) + (p.widthMm ?? 0)); a.pierce += w; a.aL += w; a.aW += w; a.marks.add(null);
      }
    }
  }
  for (const [cpId, a] of acc) {
    if (!a.drawn) continue;
    const single = a.marks.size === 1 && a.d;
    let rings = null;
    if (single) {
      const g = a.d.geometry;
      // Turned a quarter, not mirrored: the drawing's x becomes the length.
      rings = a.o.swap ? g.rings.map((ring) => ring.map(([x, y]) => [y, Math.round((g.lengthMm - x) * 10) / 10])) : g.rings;
    }
    /*
     * WHY IT IS A RECTANGLE ALTHOUGH A DRAWING EXISTS (the pooled cut plate): said in words, so every
     * screen that shows the cut plate can say where its shape comes from (nestShapes.shapeFromOf).
     */
    const kinds = [...a.marks].filter((x) => x != null).length;
    const shapeNote = rings ? null
      : a.marks.has(null) ? `${a.drawn} of its ${a.n} pieces ${a.drawn === 1 ? 'has' : 'have'} a drawing and the ${a.n - a.drawn === 1 ? 'other has' : 'others have'} none, so it is nested as its rectangle.`
        : `Its rows have ${kinds} different drawings, so it is nested as its rectangle.`;
    // partLength: the drawn LENGTH of the row the drawing is of — a cut piece longer than it carries a cutting allowance (§64).
    out.set(cpId, { cutLengthMm: r1(a.cut / a.n), piercings: r3(a.pierce / a.n), alongLength: r3(a.aL / a.n), alongWidth: r3(a.aW / a.n), rings, pieces: a.n, drawnPieces: a.drawn, drawings: kinds, shapeNote, partLength: rings ? a.partLength ?? null : null });
  }
  return out;
}

/** The file of one register revision — also an earlier, superseded one — to download. */
export async function registerFile(db, companyId, drawingId) {
  const [[d]] = await db.query(
    'SELECT file_name, file_kind, dxf_text FROM cf_part_drawings WHERE company_id = ? AND drawing_id = ? AND dxf_text IS NOT NULL ORDER BY deleted_at IS NULL DESC, id DESC LIMIT 1',
    [companyId, Number(drawingId)],
  );
  // Not uploaded on any order line: a standard drawing may hold it (its own sheet, or a part file of a version).
  const [[s]] = d ? [[null]] : await db.query(
    "SELECT file_name, file_kind, file_text AS dxf_text FROM cf_standard_drawing_files WHERE company_id = ? AND drawing_id = ? AND file_text IS NOT NULL ORDER BY deleted_at IS NULL DESC, kind = 'source' DESC, id DESC LIMIT 1",
    [companyId, Number(drawingId)],
  );
  const f = d ?? s;
  if (!f) {
    const [[reg]] = await db.query('SELECT number, revision, url FROM cf_drawings WHERE company_id = ? AND id = ?', [companyId, Number(drawingId)]);
    if (!reg) throw notFound('Drawing');
    const where = reg.url ? ` It is kept at ${reg.url} — open it there.` : ' Attach the file to the drawing to see it here.';
    throw new CfError(404, 'NO_FILE', `${reg.number} rev ${reg.revision} has no file in the system.${where}`, { detail: { url: reg.url ?? null } });
  }
  const kind = f.file_kind === 'pdf' ? 'pdf' : 'dxf';
  return { filename: f.file_name, contentType: KINDS[kind], buffer: kind === 'pdf' ? Buffer.from(f.dxf_text, 'base64') : Buffer.from(f.dxf_text, 'latin1') };
}
