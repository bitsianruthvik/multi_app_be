/**
 * partDrawingService.js — part drawings on an order line (init.sql §51, user 2026-10-08: "Build A").
 *
 * A plate part's DXF is uploaded on its order line; its file name is its DRAWING MARK and it
 * belongs to every plate part of the line whose DRAWING_MARK says the same (case, spaces, hyphens,
 * underscores and the .dxf ending do not matter). partGeometry.js reads it. What it is used for:
 *
 *   - the measure the user asked for: how much of each part's rectangle is real part, and so the
 *     most a true-shape nesting could save on the line (summary.savingKg);
 *   - CNC inputs: plateCutsService takes cut length and piercings from the drawings of the parts
 *     a cut plate is cut for, and lets a shared cut save only the share of a side the outline
 *     really runs along (drawingFactsOfLine);
 *   - a row whose size is not the drawing's rectangle is said, not changed.
 * Nesting still lays out the rectangle (the row's LENGTH × WIDTH) — option A.
 *
 * NOT the drawings register (drawingService.js, cf_drawings): that one traces which sheet and
 * revision each node was built to and stores no file. This one is the cutting SHAPE of a plate
 * part, stored and read. The screens call it "Part shapes (DXF)".
 *
 * A line released to production takes no drawing changes. One live drawing per line and mark;
 * uploading a mark again replaces it.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { explode } from './bomService.js';
import { readPartDrawing, orientTo } from './partGeometry.js';

const FALLBACK_DENSITY = 7850;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const r1 = (n) => Math.round(Number(n) * 10) / 10;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
// Case, and spaces, hyphens and underscores between words, do not matter: a file cannot always be named as the mark is written.
export const normMark = (s) => String(s ?? '').replace(/\.dxf$/i, '').trim().replace(/[\s_-]+/g, '-').toUpperCase();
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
 * The line's plate parts — rows cut into a cut plate — with what a drawing is checked against.
 * [{ id, code, name, pieces, mark, markNorm, lengthMm, widthMm, thicknessMm, density, cutPlateIds }]
 */
export async function platePartsOfLine(db, companyId, line) {
  if (line.line_type !== 'custom' || !line.item_id) return [];
  const places = await cutPlaces(db, companyId);
  const plateNodes = [...(places.plate?.blanksIds ?? [])];
  if (!plateNodes.length) return [];
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, bl.child_id AS cut_plate_id
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL AND i.owner_order_line_id = ?
       JOIN cf_boms b ON b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL
       JOIN cf_bom_lines bl ON bl.company_id = b.company_id AND bl.bom_id = b.id AND bl.deleted_at IS NULL
       JOIN cf_master_records cp ON cp.id = bl.child_id AND cp.deleted_at IS NULL AND cp.classification_id IN (?)
      WHERE m.company_id = ? AND m.deleted_at IS NULL`,
    [line.id, plateNodes, companyId],
  );
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => Number(r.id)))];
  const [vals] = await db.query(
    `SELECT v.subject_id, UPPER(s.code) AS code, v.value_number, v.value_text
       FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?)
        AND s.code IN ('LENGTH', 'WIDTH', 'THICKNESS', 'DENSITY', 'DRAWING_MARK')`,
    [companyId, ids],
  );
  const tree = await explode(db, companyId, line.item_id, { rootQuantity: Number(line.quantity) });
  const pieces = new Map();
  (function walk(node) { for (const ch of node.children ?? []) { if (ch.id != null) pieces.set(Number(ch.id), (pieces.get(Number(ch.id)) ?? 0) + Number(ch.total ?? 0)); walk(ch); } }(tree.root));
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.id)) out.set(r.id, { id: Number(r.id), code: r.code, name: r.name, pieces: Math.round(pieces.get(Number(r.id)) ?? 0), mark: null, markNorm: null, lengthMm: null, widthMm: null, thicknessMm: null, density: null, cutPlateIds: [] });
    out.get(r.id).cutPlateIds.push(Number(r.cut_plate_id));
  }
  for (const v of vals) {
    const p = out.get(v.subject_id);
    if (!p) continue;
    if (v.code === 'DRAWING_MARK') { p.mark = v.value_text ?? (v.value_number != null ? String(Number(v.value_number)) : null); p.markNorm = p.mark ? normMark(p.mark) : null; }
    else if (v.value_number != null) p[{ LENGTH: 'lengthMm', WIDTH: 'widthMm', THICKNESS: 'thicknessMm', DENSITY: 'density' }[v.code]] = Number(v.value_number);
  }
  return [...out.values()].sort((a, b) => String(a.mark ?? '').localeCompare(String(b.mark ?? '')) || a.id - b.id);
}

async function liveDrawings(db, companyId, lineId, { withDxf = false } = {}) {
  const [rows] = await db.query(
    `SELECT id, mark, mark_norm, file_name, length_mm, width_mm, area_mm2, cut_length_mm, piercings, holes, inner_cuts, geometry_json, warnings_json, created_at${withDxf ? ', dxf_text' : ''}
       FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL ORDER BY mark_norm`,
    [companyId, lineId],
  );
  return rows.map((r) => ({ ...r, geometry: parseJson(r.geometry_json), warnings: parseJson(r.warnings_json) ?? [] }));
}

const rowView = (p, g) => ({
  id: p.id, code: p.code, name: p.name, pieces: p.pieces,
  lengthMm: p.lengthMm, widthMm: p.widthMm, thicknessMm: p.thicknessMm,
  sizeMatches: g ? orientTo(g, p.lengthMm, p.widthMm).sizeMatches : null,
});
const geometryView = (g) => (g ? {
  lengthMm: g.lengthMm, widthMm: g.widthMm, areaMm2: g.areaMm2, rectAreaMm2: g.rectAreaMm2, usePct: g.usePct,
  cutLengthMm: g.cutLengthMm, piercings: g.piercings, holes: g.holes, holeDiameters: g.holeDiameters, innerCuts: g.innerCuts, rings: g.rings,
} : null);

function viewOf(line, parts, drawings) {
  const byMark = new Map();
  for (const p of parts) if (p.markNorm) { if (!byMark.has(p.markNorm)) byMark.set(p.markNorm, []); byMark.get(p.markNorm).push(p); }
  const covered = new Set();
  let rectArea = 0; let trueArea = 0; let rectKg = 0; let trueKg = 0;
  const views = drawings.map((d) => {
    const rows = byMark.get(d.mark_norm) ?? [];
    for (const p of rows) {
      covered.add(p.id);
      const g = d.geometry;
      const t = p.thicknessMm ?? 0; const rho = p.density ?? FALLBACK_DENSITY;
      rectArea += g.rectAreaMm2 * p.pieces; trueArea += g.areaMm2 * p.pieces;
      rectKg += (g.rectAreaMm2 * t * rho * p.pieces) / 1e9; trueKg += (g.areaMm2 * t * rho * p.pieces) / 1e9;
    }
    return { id: d.id, mark: d.mark, fileName: d.file_name, uploadedAt: d.created_at, geometry: geometryView(d.geometry), rows: rows.map((p) => rowView(p, d.geometry)), warnings: d.warnings };
  });
  const without = parts.filter((p) => !covered.has(p.id));
  const pieces = parts.reduce((a, p) => a + p.pieces, 0);
  return {
    line: { id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code, released: !!Number(line.released) },
    drawings: views,
    partsWithoutDrawing: without.map((p) => ({ id: p.id, code: p.code, name: p.name, mark: p.mark, pieces: p.pieces })),
    summary: {
      parts: parts.length, partsWithDrawing: covered.size,
      pieces, piecesWithDrawing: parts.filter((p) => covered.has(p.id)).reduce((a, p) => a + p.pieces, 0),
      rectAreaM2: r3(rectArea / 1e6), trueAreaM2: r3(trueArea / 1e6), usePct: rectArea > 0 ? r1((trueArea / rectArea) * 100) : null,
      rectKg: r1(rectKg), trueKg: r1(trueKg), savingKg: r1(rectKg - trueKg),
    },
  };
}

export async function getDrawings(db, companyId, orderId, lineId) {
  const line = await requireLine(db, companyId, orderId, lineId);
  const [parts, drawings] = [await platePartsOfLine(db, companyId, line), await liveDrawings(db, companyId, line.id)];
  return viewOf(line, parts, drawings);
}

const decode = (content) => {
  const s = String(content ?? '');
  const b64 = s.replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(b64, 'base64');
  return buf;
};

/**
 * input: { files: [{ name, content (base64) }], dryRun }. Each file: read, matched by mark,
 * status new | replaces | unmatched | error. A non-dry run saves the new and replacing ones and
 * refreshes the line's cut plates' cut length and piercings.
 */
export async function uploadDrawings(db, c, orderId, lineId, input = {}) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, orderId, lineId);
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw invalid('NO_FILES', 'Choose one or more DXF files — each named by its part\'s drawing mark.');
  if (Number(line.released)) throw invalid('RELEASED', `Line ${line.line_no} of ${line.order_code} is released to production — its drawings can no longer change.`);
  const dryRun = input.dryRun !== false;
  const parts = await platePartsOfLine(db, companyId, line);
  const byMark = new Map();
  for (const p of parts) if (p.markNorm) { if (!byMark.has(p.markNorm)) byMark.set(p.markNorm, []); byMark.get(p.markNorm).push(p); }
  const existing = new Map((await liveDrawings(db, companyId, line.id)).map((d) => [d.mark_norm, d]));
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const name = String(f?.name ?? '').trim();
    const mark = name.replace(/\.dxf$/i, '').trim();
    const markNorm = normMark(mark);
    const entry = { name, mark, status: 'error', rows: [], geometry: null, problems: [], warnings: [], _save: null };
    out.push(entry);
    if (!/\.dxf$/i.test(name)) { entry.problems.push('Only DXF files are read — export the drawing from CAD as a DXF.'); continue; }
    if (!markNorm) { entry.problems.push('The file name is empty — name it by the part\'s drawing mark.'); continue; }
    if (seen.has(markNorm)) { entry.problems.push('Another file in this upload has the same drawing mark.'); continue; }
    seen.add(markNorm);
    const buf = decode(f.content);
    if (!buf.length) { entry.problems.push('The file is empty.'); continue; }
    if (buf.length > MAX_FILE_BYTES) { entry.problems.push('The file is larger than 8 MB — one part per file.'); continue; }
    const text = buf.toString('latin1');
    const read = readPartDrawing(text);
    entry.warnings.push(...read.warnings);
    if (!read.geometry) { entry.problems.push(...read.problems); continue; }
    entry.geometry = geometryView(read.geometry);
    const rows = byMark.get(markNorm) ?? [];
    entry.rows = rows.map((p) => rowView(p, read.geometry));
    for (const p of rows) {
      const o = orientTo(read.geometry, p.lengthMm, p.widthMm);
      if (o.sizeMatches === false) entry.warnings.push(`${p.code ?? p.name} is ${p.lengthMm} × ${p.widthMm} on the order, and the drawing's rectangle is ${o.swap ? `${read.geometry.widthMm} × ${read.geometry.lengthMm}` : `${read.geometry.lengthMm} × ${read.geometry.widthMm}`} — nesting lays out the order's size.`);
    }
    if (!rows.length) { entry.status = 'unmatched'; entry.warnings.push(`No plate part on this line has drawing mark ${mark}.`); continue; }
    entry.status = existing.has(markNorm) ? 'replaces' : 'new';
    entry._save = { mark, markNorm, name, g: read.geometry, warnings: read.warnings, text };
  }
  const toSave = out.filter((e) => e._save);
  let view = null;
  if (!dryRun && toSave.length) {
    const replaced = toSave.map((e) => existing.get(e._save.markNorm)?.id).filter(Boolean);
    if (replaced.length) await db.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, replaced]);
    await insertRows(db, 'cf_part_drawings', [
      'company_id', 'order_line_id', 'mark', 'mark_norm', 'file_name', 'length_mm', 'width_mm', 'area_mm2', 'cut_length_mm',
      'piercings', 'holes', 'inner_cuts', 'geometry_json', 'warnings_json', 'dxf_text', 'created_by',
    ], toSave.map(({ _save: s }) => [
      companyId, line.id, s.mark.slice(0, 120), s.markNorm.slice(0, 120), s.name.slice(0, 255), s.g.lengthMm, s.g.widthMm, s.g.areaMm2, s.g.cutLengthMm,
      s.g.piercings, s.g.holes, s.g.innerCuts, JSON.stringify(s.g), JSON.stringify(s.warnings), s.text, c.userId ?? null,
    ]), 20);
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

/**
 * For plateCutsService and the CNC file: per cut plate of the line, what its parts' drawings say,
 * averaged over the pieces it is cut for (parts without a drawing count as rectangles).
 * Map cutPlateId -> { cutLengthMm, piercings, alongLength, alongWidth, lengthMm, widthMm, rings | null }
 * rings only when every piece of the cut plate has the same drawing, oriented to its length.
 */
export async function drawingFactsOfLine(db, companyId, lineId) {
  const [has] = await db.query('SELECT COUNT(*) AS n FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [companyId, lineId]);
  const out = new Map();
  if (!Number(has[0].n)) return out;
  const line = await requireLine(db, companyId, null, lineId);
  const parts = await platePartsOfLine(db, companyId, line);
  const drawings = new Map((await liveDrawings(db, companyId, line.id)).map((d) => [d.mark_norm, d]));
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
