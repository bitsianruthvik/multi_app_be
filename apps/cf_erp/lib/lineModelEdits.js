/**
 * lineModelEdits.js — PURE: a line's BOM edits applied to its standard's 3D model (user, 2026-11-12):
 *
 *   "we might have got 95% of it right using the ai and automation but … there will be minor tweaks. In BOM, they should be
 *    able to shuffle the order of things a bit, that shouldn't change the overall diagram. If they delete a row, that should
 *    get deleted from the diagram too. If they add a row and give dimensions, add that separately as a cuboid based on
 *    dimensions. If they replace the diagram of a part, then that should be handled too."
 *
 * Decided with the user the same day: the edits live on the ORDER LINE only (the standard's model is never changed); a new
 * row's cuboid sits beside its parent assembly and can be moved by X / Y / Z; "replace" is a new DXF uploaded for a part row.
 *
 * Nothing is stored about a reorder: pieces are matched to rows by DRAWING MARK, never by position, so shuffling rows (or
 * moving one under another parent) leaves the diagram alone.
 *
 * WHAT IS STORED — cf_sales_order_lines.model_edits_json (init.sql §101):
 *   { removed: [MARK, …]          marks (normalised) of rows removed in the Structure step (bomChangeService records them
 *                                 as they go: a removed row's own values are cleared, so they cannot be read back later)
 *     placed:  { rowId: [x, y, z] }  where a new row's cuboid is put, its left-front-bottom corner in model mm }
 *
 * WHAT IS WORKED OUT on every read (applyLineEdits):
 *   hidden     every piece whose mark, or a mark of an assembly above it (`in`), was removed and is on no live row now
 *              (pasting the row back brings it back)
 *   added      a live row with no rows under it, made after the model was saved, whose mark the model does not have, with
 *              LENGTH, WIDTH and THICKNESS: a box of those sizes (length along x, width along y, thickness along z), beside
 *              its parent's pieces (stacked when several) or where `placed` puts it. A row still lacking a size is listed
 *              in `waiting`.
 *   replaced   a later part DXF for a mark that already had one on this line (the caller passes only those), read as one
 *              plate (cf_part_drawings.geometry_json): the mark's pieces take its outline, cut-outs and holes, in the same place
 *              (the new outline's corner on the old one's; turned a quarter when it is drawn the other way round). When its size
 *              does not match the placed part (a curved or bent part's flat outline), the piece keeps its model shape and is
 *              only marked changed (kept). The old part stays for other marks.
 */

const up = (s) => String(s ?? '').replace(/\.(dxf|pdf)$/i, '').trim().replace(/[\s_-]+/g, '-').toUpperCase();
const finite = (v) => Number.isFinite(Number(v)) && v !== null && v !== '';
const r1 = (n) => Math.round(Number(n) * 10) / 10;

/** A stored model_edits_json as { removed: [MARK], placed: { rowId: [x, y, z] } } (missing or broken = none). */
export function editsOf(v) {
  let a = v;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (!a || typeof a !== 'object') a = {};
  const removed = [...new Set((Array.isArray(a.removed) ? a.removed : []).map(up).filter(Boolean))];
  const placed = {};
  for (const [k, p] of Object.entries(a.placed && typeof a.placed === 'object' ? a.placed : {})) {
    if (Array.isArray(p) && p.length === 3 && p.every(finite)) placed[String(Number(k))] = p.map(Number);
  }
  return { removed, placed };
}

/** Marks added to a line's removed list (normalised, no repeats, at most 5000 kept). */
export function withRemoved(edits, marks) {
  const e = editsOf(edits);
  const removed = [...new Set([...e.removed, ...marks.map(up).filter(Boolean)])].slice(-5000);
  return { ...e, removed };
}

/** A new row's cuboid put at [x, y, z] (null takes it back beside its parent). */
export function withPlaced(edits, rowId, at) {
  const e = editsOf(edits);
  const placed = { ...e.placed };
  if (at == null) delete placed[String(Number(rowId))];
  else placed[String(Number(rowId))] = at.map(Number);
  return { ...e, placed };
}

const V = (a) => [Number(a?.[0]) || 0, Number(a?.[1]) || 0, Number(a?.[2]) || 0];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

/** The corners an element reaches, in model mm (a /2 plate through its part; a member; a box; studs by their grid). */
function pointsOf(e, parts) {
  const p = e.plate ?? (e.part && parts?.[e.part] ? { ...parts[e.part], o: e.o, u: e.u, v: e.v, w: e.w } : null);
  if (p && Array.isArray(p.pts) && p.o && p.u && p.v) {
    const o = V(p.o); const u = V(p.u); const v = V(p.v); const w = V(p.w ?? [0, 0, 1]); const t = Number(p.t) || 0;
    const out = [];
    for (const q of p.pts) { const at = add(o, add(mul(u, Number(q[0]) || 0), mul(v, Number(q[1]) || 0))); out.push(at, add(at, mul(w, t))); }
    return out;
  }
  if (e.member) {
    const s = e.member.section ?? {};
    const r = Math.max(Number(s.h) || 0, Number(s.d) || 0, Number(s.bTop) || 0, Number(s.w) || 0) / 2;
    const a = V(e.member.a); const b = V(e.member.b);
    return [a, b].flatMap((c) => [add(c, [-r, -r, -r]), add(c, [r, r, r])]);
  }
  if (e.box) { const c = V(e.box.c); const h = mul(V(e.box.size), 0.5); return [add(c, mul(h, -1)), add(c, h)]; }
  if (e.studs) { const a = V(e.studs.a); return [a, add(a, mul(V(e.studs.up), Number(e.studs.h) || 0))]; }
  return [];
}

/** The box round some elements: { min, max } (null for none). */
export function boundsOf(elements, parts) {
  let min = null; let max = null;
  for (const e of elements) {
    for (const q of pointsOf(e, parts)) {
      if (!q.every(Number.isFinite)) continue;
      min = min ? [Math.min(min[0], q[0]), Math.min(min[1], q[1]), Math.min(min[2], q[2])] : [...q];
      max = max ? [Math.max(max[0], q[0]), Math.max(max[1], q[1]), Math.max(max[2], q[2])] : [...q];
    }
  }
  return min ? { min, max } : null;
}

/** A part DXF's stored shape (partGeometry.readPartDrawing → rings: [outer, …cut-outs, …holes]) as a model part. */
export function partFromGeometry(g, thickness) {
  const rings = Array.isArray(g?.rings) ? g.rings : [];
  if (!rings.length || !Array.isArray(rings[0]) || rings[0].length < 3) return null;
  const nHoles = Math.max(0, Number(g.holes) || 0);
  const nCuts = Math.max(0, Number(g.innerCuts) || 0);
  const pts = rings[0].map((q) => [Number(q[0]), Number(q[1])]);
  const cuts = rings.slice(1, 1 + nCuts).map((r) => r.map((q) => [Number(q[0]), Number(q[1])]));
  const holes = rings.slice(1 + nCuts, 1 + nCuts + nHoles).map((r) => {
    const xs = r.map((q) => Number(q[0])); const ys = r.map((q) => Number(q[1]));
    const dx = Math.max(...xs) - Math.min(...xs); const dy = Math.max(...ys) - Math.min(...ys);
    return [r1((Math.max(...xs) + Math.min(...xs)) / 2), r1((Math.max(...ys) + Math.min(...ys)) / 2), r1((dx + dy) / 2)];
  });
  return { pts, ...(cuts.length ? { cuts } : {}), ...(holes.length ? { holes } : {}), t: Number(thickness) || 0 };
}

function boxOf2(pts) {
  const xs = pts.map((q) => Number(q[0])); const ys = pts.map((q) => Number(q[1]));
  return { x0: Math.min(...xs), y0: Math.min(...ys), dx: Math.max(...xs) - Math.min(...xs), dy: Math.max(...ys) - Math.min(...ys) };
}

/** The flat outline's two sides (sorted) match the placed part's within 1 % (5 mm at least). */
export function sameSize(next, old) {
  const dims = (pts) => { const b = boxOf2(pts); return [b.dx, b.dy].sort((p, q) => p - q); };
  const a = dims(old.pts); const b = dims(next.pts);
  return a.every((v, i) => Math.abs(v - b[i]) <= Math.max(5, 0.01 * v));
}

/**
 * The new part laid over the old one: the same corner, and a quarter turn when the new drawing's length runs the other way
 * (its x/y swapped). Thickness: the old part's when the new one says none.
 */
export function fitPart(next, old) {
  const a = boxOf2(old.pts); const b = boxOf2(next.pts);
  const swap = Math.abs(b.dx - a.dy) + Math.abs(b.dy - a.dx) + 1e-6 < Math.abs(b.dx - a.dx) + Math.abs(b.dy - a.dy);
  const map = ([x, y]) => (swap ? [r1(a.x0 + (y - b.y0)), r1(a.y0 + (x - b.x0))] : [r1(a.x0 + (x - b.x0)), r1(a.y0 + (y - b.y0))]);
  return {
    pts: next.pts.map(map),
    ...(next.cuts ? { cuts: next.cuts.map((r) => r.map(map)) } : {}),
    ...(next.holes ? { holes: next.holes.map(([x, y, d]) => [...map([x, y]), d]) } : {}),
    t: Number(next.t) || Number(old.t) || 0,
    swapped: swap,
  };
}

/**
 * The model as this line has it. PURE; the input is left alone.
 *   model       the stored model (cf-erp-model3d/1 or /2, as saved)
 *   savedAt     when the model was saved (rows made, and DXFs uploaded, after it are this line's own)
 *   rows        the line's live rows (partDrawingService.rowsOfLine): { id, name, mark, markNorm, parentId, lengthMm,
 *               widthMm, thicknessMm, createdAt, hasChildren }
 *   edits       the line's model_edits_json
 *   drawings    the line's live part DXFs read as one plate: { id, markNorm, mark, fileName, createdAt, geometry }
 * → { model, edits: { hidden: { marks, pieces }, added: [{ rowId, name, mark, size, at, moved }], waiting: [{ rowId, name,
 *     missing }], replaced: [{ mark, drawingId, fileName, pieces, swapped }] } }
 */
export function applyLineEdits(model, { savedAt = null, rows = [], edits = null, drawings = [] } = {}) {
  const e = editsOf(edits);
  const parts = model?.parts ? { ...model.parts } : null;
  let elements = Array.isArray(model?.elements) ? [...model.elements] : [];
  const live = new Set(rows.map((r) => r.markNorm ?? up(r.mark)).filter(Boolean));
  const modelMarks = new Set();
  for (const el of elements) { if (el.mark) modelMarks.add(up(el.mark)); for (const m of el.in ?? []) modelMarks.add(up(m)); }
  const unplaced = new Set(Object.keys(model?.unplaced ?? {}).map(up));
  const after = (t) => !!savedAt && !!t && new Date(t).getTime() > new Date(savedAt).getTime();

  // 1. Removed rows: their pieces, and everything inside a removed assembly, go.
  const gone = new Set(e.removed.filter((m) => !live.has(m) && modelMarks.has(m)));
  let hiddenPieces = 0;
  if (gone.size) {
    elements = elements.filter((el) => {
      const out = (el.mark && gone.has(up(el.mark))) || (el.in ?? []).some((m) => gone.has(up(m)));
      if (out) hiddenPieces += 1;
      return !out;
    });
  }

  // 2. A part DXF uploaded after the model was saved: the mark's pieces take its shape.
  const replaced = [];
  const newest = new Map();
  for (const d of drawings) {
    if (!d.geometry || !d.markNorm || !modelMarks.has(d.markNorm) || gone.has(d.markNorm)) continue;
    const was = newest.get(d.markNorm);
    if (!was || new Date(d.createdAt) > new Date(was.createdAt) || (String(d.createdAt) === String(was.createdAt) && d.id > was.id)) newest.set(d.markNorm, d);
  }
  for (const [mark, d] of newest) {
    let pieces = 0; let swapped = false; let kept = false;
    const shapes = new Map();
    elements = elements.map((el) => {
      if (!el.mark || up(el.mark) !== mark) return el;
      const old = el.plate ?? (el.part && parts?.[el.part]) ?? null;
      if (!old?.pts?.length) return el;
      const next = partFromGeometry(d.geometry, old.t);
      if (!next) return el;
      if (!sameSize(next, old)) { pieces += 1; kept = true; return { ...el, replaced: true }; }
      const key = el.part ?? `inline${el.id}`;
      let fit = shapes.get(key);
      if (!fit) { fit = fitPart(next, old); shapes.set(key, fit); }
      swapped = swapped || fit.swapped;
      pieces += 1;
      const { swapped: _s, ...shape } = fit;
      if (el.plate) return { ...el, plate: { ...el.plate, ...shape }, replaced: true };
      const id = `${el.part}~dxf${d.id}`;
      parts[id] = shape;
      return { ...el, part: id, replaced: true };
    });
    if (pieces) replaced.push({ mark: d.mark ?? mark, drawingId: Number(d.id), fileName: d.fileName ?? null, pieces, swapped, kept });
  }

  // 3. New rows with sizes: a box each, beside its parent's pieces.
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const added = [];
  const waiting = [];
  const whole = boundsOf(elements, parts);
  const stack = new Map();   // parent key → how high its new boxes reach so far
  for (const r of rows) {
    const mark = r.markNorm ?? (r.mark ? up(r.mark) : null);
    if (r.hasChildren || !after(r.createdAt) || (mark && (modelMarks.has(mark) || unplaced.has(mark)))) continue;
    const L = Number(r.lengthMm); const W = Number(r.widthMm); const T = Number(r.thicknessMm);
    const missing = [!(L > 0) && 'length', !(W > 0) && 'width', !(T > 0) && 'thickness'].filter(Boolean);
    if (missing.length) { waiting.push({ rowId: Number(r.id), name: r.name ?? null, mark: r.mark ?? null, missing }); continue; }
    // The nearest row above with a mark the model has: the cuboid sits beside its pieces, and lights with it.
    let parent = byId.get(Number(r.parentId)) ?? null;
    for (let hops = 0; parent && !(parent.markNorm && modelMarks.has(parent.markNorm)) && hops < 50; hops++) parent = byId.get(Number(parent.parentId)) ?? null;
    const pMark = parent?.markNorm ?? null;
    const near = pMark ? elements.filter((el) => (el.mark && up(el.mark) === pMark) || (el.in ?? []).some((m) => up(m) === pMark)) : [];
    // `in` and copies as one of the parent's pieces has them, so the box lights with that level.
    const host = near.find((el) => el.mark && up(el.mark) === pMark) ?? near[0] ?? null;
    let inn = [];
    let n;
    if (host) {
      if (host.mark && up(host.mark) === pMark) { inn = [host.mark, ...(host.in ?? [])]; n = host.n ? [1, ...host.n] : undefined; }
      else { const i = (host.in ?? []).findIndex((m) => up(m) === pMark); inn = (host.in ?? []).slice(i); n = host.n ? host.n.slice(i) : undefined; }
    }
    const b = (near.length ? boundsOf(near, parts) : null) ?? whole ?? { min: [0, 0, 0], max: [0, 0, 0] };
    const key = pMark ?? '';
    const placed = e.placed[String(Number(r.id))] ?? null;
    let corner;
    if (placed) corner = placed;
    else {
      const z = stack.get(key) ?? b.min[2];
      corner = [r1(b.max[0] + 200), r1(b.min[1]), r1(z)];
      stack.set(key, z + T + 100);
    }
    const size = [L, W, T];
    elements.push({
      id: `row${r.id}`, mark: r.mark ?? `${r.name ?? 'Row'} (new)`, ...(inn.length ? { in: inn } : {}), ...(n ? { n } : {}),
      label: r.name ?? undefined, box: { c: [corner[0] + L / 2, corner[1] + W / 2, corner[2] + T / 2], size }, added: true, rowId: Number(r.id),
    });
    added.push({ rowId: Number(r.id), name: r.name ?? null, mark: r.mark ?? null, size, at: corner, moved: !!placed, parentMark: parent?.mark ?? null });
  }

  return {
    model: { ...model, ...(parts ? { parts } : {}), elements },
    edits: { hidden: { marks: [...gone].sort(), pieces: hiddenPieces }, added, waiting, replaced },
  };
}

/** True when the line's diagram differs from the standard's model. */
export const hasEdits = (x) => !!x && (x.hidden.pieces > 0 || x.added.length > 0 || x.replaced.length > 0 || x.waiting.length > 0);
