/**
 * partDrawingService.js — drawings on an order line's rows (init.sql §51/§51b, user 2026-10-08:
 * "Build A", then "keep it at the structure tab … upload drawings for not just parts but all the
 * levels").
 *
 * A drawing is uploaded on its order line; its file name is its DRAWING MARK and it belongs to
 * every row of the line — span, girder line, segment, assembly, part — whose DRAWING_MARK says the
 * same (case, spaces, hyphens, underscores and the ending do not matter). DXF or PDF.
 *
 * For every row it is the row's drawing, kept and downloadable. For a PLATE PART (a row cut into a
 * cut plate) a DXF is also read as its shape (partGeometry.js), and that is used for:
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
 * A line released to production takes no drawing changes. One live drawing per line and mark;
 * uploading a mark again replaces it. Cut pieces are never matched — they are worked out.
 */
import { invalid, notFound } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { explode } from './bomService.js';
import { readPartDrawing, orientTo } from './partGeometry.js';
import { createDrawing, reviseDrawing } from './drawingService.js';
import { nextRevision } from '../lib/revision.js';

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
    `SELECT l.id, l.order_id, l.line_no, l.line_type, l.item_id, l.quantity, o.code AS order_code,
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
    `SELECT m.id, m.code, m.name, m.classification_id, n.name AS level
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL AND i.owner_order_line_id = ?
       LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
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
  (function walk(node, d) {
    for (const ch of node.children ?? []) {
      if (ch.id != null) {
        pieces.set(Number(ch.id), (pieces.get(Number(ch.id)) ?? 0) + Number(ch.total ?? 0));
        if (!depth.has(Number(ch.id))) depth.set(Number(ch.id), d + 1);
      }
      walk(ch, d + 1);
    }
  }(tree.root, 0));
  const out = new Map(mine.map((r) => [Number(r.id), {
    id: Number(r.id), code: r.code, name: r.name, level: r.level ?? 'Row', depth: depth.get(Number(r.id)) ?? 99,
    pieces: Number(r.id) === Number(line.item_id) ? Number(line.quantity) : Math.round(pieces.get(Number(r.id)) ?? 0),
    mark: null, markNorm: null, lengthMm: null, widthMm: null, thicknessMm: null, density: null, isPlatePart: false, cutPlateIds: [], drawingIds: [],
  }]));
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

/** The line's plate parts only (rows cut into a cut plate). */
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

/**
 * The register side of some drawings: Map id -> { id, code, number, revision, status, title,
 * earlier: [{ id, revision, status, hasFile, fileName }] } — earlier revisions of the same drawing, oldest first.
 */
async function registerRefs(db, companyId, ids) {
  const out = new Map();
  const want = [...new Set(ids.filter((x) => x != null).map(Number))];
  if (!want.length) return out;
  const [rows] = await db.query('SELECT id, code, number, revision, status, title, root_id FROM cf_drawings WHERE company_id = ? AND id IN (?)', [companyId, want]);
  const roots = [...new Set(rows.map((r) => Number(r.root_id ?? r.id)))];
  const [revs] = roots.length ? await db.query('SELECT id, revision, status, root_id FROM cf_drawings WHERE company_id = ? AND deleted_at IS NULL AND root_id IN (?) ORDER BY id', [companyId, roots]) : [[]];
  const [filed] = revs.length ? await db.query('SELECT drawing_id, file_name FROM cf_part_drawings WHERE company_id = ? AND drawing_id IN (?) ORDER BY deleted_at IS NULL, id', [companyId, revs.map((r) => r.id)]) : [[]];
  // Each revision's newest file name (live last, so it wins).
  const fileName = new Map(filed.map((f) => [Number(f.drawing_id), f.file_name]));
  for (const r of rows) {
    const root = Number(r.root_id ?? r.id);
    out.set(Number(r.id), {
      id: Number(r.id), code: r.code, number: r.number, revision: r.revision, status: r.status, title: r.title,
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

export async function getDrawings(db, companyId, orderId, lineId) {
  const line = await requireLine(db, companyId, orderId, lineId);
  const [rows, drawings] = [await rowsOfLine(db, companyId, line), await liveDrawings(db, companyId, line.id)];
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
 * input: { rowIds, number, revision?, title?, source?, status?, notes? }
 */
export async function startDrawing(db, c, orderId, lineId, input = {}) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, orderId, lineId);
  const rows = await rowsOfLine(db, companyId, line);
  const want = [...new Set((Array.isArray(input.rowIds) ? input.rowIds : []).map(Number).filter(Number.isInteger))];
  if (!want.length) throw invalid('NO_ROWS', 'Choose the row (or rows) the drawing is for.');
  const byId = new Map(rows.map((p) => [p.id, p]));
  const foreign = want.filter((id) => !byId.has(id));
  if (foreign.length) throw invalid('NOT_ON_LINE', `${foreign.length === 1 ? 'A chosen row is' : `${foreign.length} chosen rows are`} not on line ${line.line_no} of ${line.order_code}.`);
  const first = byId.get(want[0]);
  const d = await createDrawing(db, c, {
    number: input.number, revision: input.revision, source: input.source, status: input.status, notes: input.notes,
    title: input.title !== undefined ? input.title : first?.name ?? null,
  });
  await insertRows(db, 'cf_drawing_links', ['company_id', 'drawing_id', 'subject_type', 'subject_id', 'created_by'],
    want.map((id) => [companyId, d.id, 'master_record', id, c.userId ?? null]));
  return { drawing: { id: d.id, code: d.code, number: d.number, revision: d.revision, status: d.status }, view: await getDrawings(db, companyId, null, line.id) };
}

const decode = (content) => Buffer.from(String(content ?? '').replace(/^data:[^,]*,/, ''), 'base64');

/**
 * input: { files: [{ name, content (base64) }], dryRun }. Each file: matched by mark, and for a
 * plate part a DXF read as its shape. status new | replaces | unmatched | error. A non-dry run
 * saves the new and replacing ones and refreshes the line's cut plates' cut length and piercings.
 */
export async function uploadDrawings(db, c, orderId, lineId, input = {}) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, orderId, lineId);
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw invalid('NO_FILES', 'Choose one or more drawings (DXF or PDF) — each named by its drawing mark.');
  if (Number(line.released)) throw invalid('RELEASED', `Line ${line.line_no} of ${line.order_code} is released to production — its drawings can no longer change.`);
  const dryRun = input.dryRun !== false;
  const rows = await rowsOfLine(db, companyId, line);
  const byMark = new Map();
  for (const p of rows) if (p.markNorm) { if (!byMark.has(p.markNorm)) byMark.set(p.markNorm, []); byMark.get(p.markNorm).push(p); }
  const live = await liveDrawings(db, companyId, line.id);
  const existing = new Map(live.map((d) => [d.mark_norm, d]));
  const fileOfDrawing = new Map(live.filter((d) => d.drawing_id != null).map((d) => [Number(d.drawing_id), d]));
  const seen = new Set();
  const seenDrawing = new Set();
  const taken = new Set();
  const out = [];
  for (const f of files) {
    const name = String(f?.name ?? '').trim();
    const kind = kindOf(name);
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
    const markNorm = normMark(mark);
    const entry = { name, mark, fileKind: kind, status: 'error', rows: [], geometry: null, problems: [], warnings: [], register: null, _save: null };
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
    if (!target) {
      const waitingIds = [...new Set((byMark.get(markNorm) ?? []).flatMap((p) => p.drawingIds))].filter((id) => !fileOfDrawing.has(id));
      if (waitingIds.length) {
        const [cands] = await db.query("SELECT * FROM cf_drawings WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL AND status IN ('draft', 'issued') ORDER BY id", [companyId, waitingIds]);
        target = cands.find((d) => normMark(String(d.number).split('/').pop()) === markNorm) ?? cands[0] ?? null;
      }
    }
    if (target && seenDrawing.has(Number(target.id))) { entry.problems.push(`Another file in this upload goes on the same drawing (${target.number}).`); continue; }
    if (target) seenDrawing.add(Number(target.id));
    const matched = rows.filter((p) => (p.markNorm && p.markNorm === markNorm) || (target && p.drawingIds.includes(Number(target.id))));
    const plate = matched.filter((p) => p.isPlatePart);
    entry.rows = matched.map((p) => rowView(p, null));
    let g = null;
    let text = null;
    if (kind === 'dxf') {
      text = buf.toString('latin1');
      // Not a DXF at all (a DWG, a binary DXF, something renamed) is refused whatever row it is for.
      const notDxf = readPartDrawing(text.slice(0, 4096)).problems.find((x) => /DWG|binary DXF|does not read as a DXF/.test(x));
      if (notDxf && !/(^|\n)\s*0\s*\r?\n\s*SECTION/.test(text)) { entry.problems.push(notDxf); continue; }
      // A plate part's DXF is its shape; any other row's DXF is only kept (a GA is not one outline).
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
      for (const p of plate) {
        const o = orientTo(g, p.lengthMm, p.widthMm);
        if (o.sizeMatches === false) entry.warnings.push(`${p.code ?? p.name} is ${p.lengthMm} × ${p.widthMm} on the order, and the drawing's rectangle is ${o.swap ? `${g.widthMm} × ${g.lengthMm}` : `${g.lengthMm} × ${g.widthMm}`} — nesting lays out the order's size.`);
      }
    }
    if (!matched.length) { entry.status = 'unmatched'; entry.warnings.push(`No row on this line has drawing mark ${mark}.`); continue; }
    const hadFile = target ? fileOfDrawing.has(Number(target.id)) : false;
    entry.status = existing.has(markNorm) || hadFile ? 'replaces' : 'new';
    const action = !target ? 'create' : hadFile ? (target.status === 'issued' ? 'revise' : 'replace') : 'attach';
    const number = target ? target.number : await freeNumber(db, companyId, line, mark, taken);
    entry.register = {
      action, drawingId: target ? Number(target.id) : null, code: target?.code ?? null, number,
      revision: action === 'revise' ? nextRevision(target.revision) : target ? target.revision : 'A',
      fromRevision: action === 'revise' ? target.revision : null,
    };
    entry._save = {
      mark, markNorm, name, kind, g: plate.length ? g : null, warnings: entry.warnings, body: kind === 'dxf' ? text : buf.toString('base64'),
      action, target, number, title: matched[0]?.name ?? null, rowIds: matched.map((p) => p.id),
      replaces: [existing.get(markNorm)?.id, target ? fileOfDrawing.get(Number(target.id))?.id : null].filter(Boolean),
    };
  }
  const toSave = out.filter((e) => e._save);
  let view = null;
  if (!dryRun && toSave.length) {
    const replaced = [...new Set(toSave.flatMap((e) => e._save.replaces))];
    // The replaced files keep their drawing_id: an issued revision's file stays downloadable from it.
    if (replaced.length) await db.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, replaced]);
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
    const { refreshPlateCuts } = await import('./plateCutsService.js');
    await refreshPlateCuts(db, c, line.id);
    view = await getDrawings(db, companyId, null, line.id);
  }
  return { dryRun, saved: !dryRun && toSave.length > 0, files: out.map(({ _save, ...e }) => e), view };
}

export async function deleteDrawing(db, c, orderId, lineId, drawingId) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, orderId, lineId);
  if (Number(line.released)) throw invalid('RELEASED', `Line ${line.line_no} of ${line.order_code} is released to production — its drawings can no longer change.`);
  const [r] = await db.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND id = ? AND deleted_at IS NULL', [companyId, line.id, Number(drawingId)]);
  if (!r.affectedRows) throw notFound('Drawing');
  const { refreshPlateCuts } = await import('./plateCutsService.js');
  await refreshPlateCuts(db, c, line.id);
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
 * Map cutPlateId -> { cutLengthMm, piercings, alongLength, alongWidth, rings | null }
 * rings only when every piece of the cut plate has the same shape, oriented to its length.
 */
export async function drawingFactsOfLine(db, companyId, lineId) {
  const [has] = await db.query('SELECT COUNT(*) AS n FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND geometry_json IS NOT NULL', [companyId, lineId]);
  const out = new Map();
  if (!Number(has[0].n)) return out;
  const line = await requireLine(db, companyId, null, lineId);
  const parts = await platePartsOfLine(db, companyId, line);
  const shaped = (await liveDrawings(db, companyId, line.id)).filter((d) => d.geometry);
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
        a.aL += w * o.alongLength; a.aW += w * o.alongWidth; a.drawn += w; a.marks.add(d.id); a.d = d; a.o = o;
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
    out.set(cpId, { cutLengthMm: r1(a.cut / a.n), piercings: r3(a.pierce / a.n), alongLength: r3(a.aL / a.n), alongWidth: r3(a.aW / a.n), rings });
  }
  return out;
}

/** The file of one register revision — also an earlier, superseded one — to download. */
export async function registerFile(db, companyId, drawingId) {
  const [[d]] = await db.query(
    'SELECT file_name, file_kind, dxf_text FROM cf_part_drawings WHERE company_id = ? AND drawing_id = ? AND dxf_text IS NOT NULL ORDER BY deleted_at IS NULL DESC, id DESC LIMIT 1',
    [companyId, Number(drawingId)],
  );
  if (!d) throw notFound('Drawing file');
  const kind = d.file_kind ?? 'dxf';
  return { filename: d.file_name, contentType: KINDS[kind], buffer: kind === 'pdf' ? Buffer.from(d.dxf_text, 'base64') : Buffer.from(d.dxf_text, 'latin1') };
}
