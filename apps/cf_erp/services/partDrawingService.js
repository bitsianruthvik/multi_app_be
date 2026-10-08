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
 * NOT the drawings register (drawingService.js, cf_drawings): that one traces which sheet and
 * revision each node was built to and stores no file. This one holds the file itself.
 *
 * A line released to production takes no drawing changes. One live drawing per line and mark;
 * uploading a mark again replaces it. Cut pieces are never matched — they are worked out.
 */
import { invalid, notFound } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { explode } from './bomService.js';
import { readPartDrawing, orientTo } from './partGeometry.js';

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
    mark: null, markNorm: null, lengthMm: null, widthMm: null, thicknessMm: null, density: null, isPlatePart: false, cutPlateIds: [],
  }]));
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
    `SELECT id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2, cut_length_mm, piercings, holes, inner_cuts, geometry_json, warnings_json, created_at
       FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL ORDER BY mark_norm`,
    [companyId, lineId],
  );
  return rows.map((r) => ({ ...r, geometry: parseJson(r.geometry_json), warnings: parseJson(r.warnings_json) ?? [] }));
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

function viewOf(line, rows, drawings) {
  const byMark = new Map();
  for (const p of rows) if (p.markNorm) { if (!byMark.has(p.markNorm)) byMark.set(p.markNorm, []); byMark.get(p.markNorm).push(p); }
  const covered = new Set();
  let rectArea = 0; let trueArea = 0; let rectKg = 0; let trueKg = 0;
  const views = drawings.map((d) => {
    const matched = byMark.get(d.mark_norm) ?? [];
    for (const p of matched) {
      covered.add(p.id);
      const g = d.geometry;
      if (!g || !p.isPlatePart) continue;
      const t = p.thicknessMm ?? 0; const rho = p.density ?? FALLBACK_DENSITY;
      rectArea += g.rectAreaMm2 * p.pieces; trueArea += g.areaMm2 * p.pieces;
      rectKg += (g.rectAreaMm2 * t * rho * p.pieces) / 1e9; trueKg += (g.areaMm2 * t * rho * p.pieces) / 1e9;
    }
    return {
      id: d.id, mark: d.mark, fileName: d.file_name, fileKind: d.file_kind ?? 'dxf', uploadedAt: d.created_at,
      levels: [...new Set(matched.map((p) => p.level))],
      geometry: geometryView(d.geometry), rows: matched.map((p) => rowView(p, d.geometry)), warnings: d.warnings,
    };
  });
  const parts = rows.filter((p) => p.isPlatePart);
  const shaped = new Set(drawings.filter((d) => d.geometry).flatMap((d) => (byMark.get(d.mark_norm) ?? []).filter((p) => p.isPlatePart).map((p) => p.id)));
  return {
    line: { id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code, released: !!Number(line.released) },
    drawings: views,
    rowsWithoutDrawing: rows.filter((p) => !covered.has(p.id)).map((p) => ({ id: p.id, code: p.code, name: p.name, level: p.level, mark: p.mark, pieces: p.pieces, isPlatePart: p.isPlatePart })),
    summary: {
      rows: rows.length, rowsWithDrawing: covered.size,
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
  return viewOf(line, rows, drawings);
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
  const existing = new Map((await liveDrawings(db, companyId, line.id)).map((d) => [d.mark_norm, d]));
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const name = String(f?.name ?? '').trim();
    const kind = kindOf(name);
    const mark = name.replace(/\.(dxf|pdf)$/i, '').trim();
    const markNorm = normMark(mark);
    const entry = { name, mark, fileKind: kind, status: 'error', rows: [], geometry: null, problems: [], warnings: [], _save: null };
    out.push(entry);
    if (!kind) { entry.problems.push('Only DXF and PDF drawings are taken.'); continue; }
    if (!markNorm) { entry.problems.push('The file name is empty — name it by the drawing mark.'); continue; }
    if (seen.has(markNorm)) { entry.problems.push('Another file in this upload has the same drawing mark.'); continue; }
    seen.add(markNorm);
    const buf = decode(f.content);
    if (!buf.length) { entry.problems.push('The file is empty.'); continue; }
    if (buf.length > MAX_FILE_BYTES) { entry.problems.push('The file is larger than 4 MB.'); continue; }
    if (kind === 'pdf' && buf.subarray(0, 5).toString('latin1') !== '%PDF-') { entry.problems.push('This does not read as a PDF file.'); continue; }
    const matched = byMark.get(markNorm) ?? [];
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
    entry.status = existing.has(markNorm) ? 'replaces' : 'new';
    entry._save = { mark, markNorm, name, kind, g: plate.length ? g : null, warnings: entry.warnings, body: kind === 'dxf' ? text : buf.toString('base64') };
  }
  const toSave = out.filter((e) => e._save);
  let view = null;
  if (!dryRun && toSave.length) {
    const replaced = toSave.map((e) => existing.get(e._save.markNorm)?.id).filter(Boolean);
    if (replaced.length) await db.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, replaced]);
    for (const { _save: s } of toSave) {
      // One at a time: a drawing can be megabytes, and a TiDB statement is one entry.
      await insertRows(db, 'cf_part_drawings', [
        'company_id', 'order_line_id', 'mark', 'mark_norm', 'file_name', 'file_kind', 'length_mm', 'width_mm', 'area_mm2', 'cut_length_mm',
        'piercings', 'holes', 'inner_cuts', 'geometry_json', 'warnings_json', 'dxf_text', 'created_by',
      ], [[
        companyId, line.id, s.mark.slice(0, 120), s.markNorm.slice(0, 120), s.name.slice(0, 255), s.kind,
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
  const drawings = new Map((await liveDrawings(db, companyId, line.id)).filter((d) => d.geometry).map((d) => [d.mark_norm, d]));
  const acc = new Map();
  for (const p of parts) {
    const d = p.markNorm ? drawings.get(p.markNorm) : null;
    const w = Math.max(1, p.pieces);
    for (const cpId of p.cutPlateIds) {
      if (!acc.has(cpId)) acc.set(cpId, { n: 0, cut: 0, pierce: 0, aL: 0, aW: 0, drawn: 0, marks: new Set(), d: null, o: null });
      const a = acc.get(cpId);
      a.n += w;
      if (d && p.lengthMm > 0 && p.widthMm > 0) {
        const o = orientTo(d.geometry, p.lengthMm, p.widthMm);
        a.cut += w * d.geometry.cutLengthMm; a.pierce += w * d.geometry.piercings;
        a.aL += w * o.alongLength; a.aW += w * o.alongWidth; a.drawn += w; a.marks.add(p.markNorm); a.d = d; a.o = o;
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
