// Deterministic BOM extractor for structural-steel fabrication drawings in the PFPL house style.
// A drawing database (LibreDWG's shape: dxfDb.readDxfDb or dwgDb.readDwgDb) -> parts list (+ one DXF text per part
// whose detail view is found). No LLM, no network, no files.
//
// COPIED from TM/drawing_bom/src/extract.mjs (2026-10-18) for "Add line › From a new drawing": the engine ships
// with the backend. Changes against the original: it takes the database (not a path) and writes nothing (the part
// DXFs come back as text in `files`); a drawing with NO title block (a cropped GA, one view saved as DXF) is read as
// ONE sheet over the whole drawing instead of ignoring every caption. Keep the rules in step with the original.
import { flatten } from './flatten.js';
import { findSheets, sheetOf } from './sheets.js';
import { parseCaption, sameSize, sizeKey, unitKg } from './captions.js';
import { rawEdges, splitEdges, buildGraph, components, outerFace, ringPoints, polyArea, bboxOf, inPoly } from './geometry.js';
import { partDxf, normalisePart } from './partDxf.js';

const SCALES = [1, 1.5, 2, 2.5, 3, 4, 5];
const DRILL_MAX_DIA = 50;
const NOT_PART_LAYER = /(^|[^A-Z])(DIM|DIMENSION|TEXT|TITLE|DEFPOINTS|HATCH|CEN|CENTRE|CENTER|BORDER)([^A-Z]|$)/i;

// ------------------------------------------------------------------ geometry index
function geometryIndex(db, flat) {
  const lt = new Map((db.tables?.LAYER?.entries ?? []).map((l) => [l.name, String(l.lineType ?? '').toUpperCase()]));
  const okLayer = (name) => { const t = lt.get(name) ?? 'CONTINUOUS'; return !NOT_PART_LAYER.test(name) && (t === '' || t === 'CONTINUOUS' || t === 'BYLAYER' || t === 'BYBLOCK'); };
  const okLt = (o) => { const t = String(o.lt ?? '').toUpperCase(); return t === '' || t === 'BYLAYER' || t === 'BYBLOCK' || t === 'CONTINUOUS'; };
  const prims = flat.filter((o) => 'LAP'.includes(o.k) && okLayer(o.layer) && okLt(o));
  const circles = flat.filter((o) => o.k === 'C' && okLayer(o.layer) && okLt(o));
  const g = buildGraph(splitEdges(rawEdges(prims)));
  const comps = [];
  for (const c of components(g)) {
    const of = outerFace(g, c);
    if (!of) continue;
    const pts = ringPoints(of.ring);
    const b = bboxOf(pts);
    comps.push(withRotation({ id: comps.length, ring: of.ring, pts, area: of.area, box: b, dx: b.x1 - b.x0, dy: b.y1 - b.y0, edges: c.length, edgeIdx: c }));
  }
  // outlines drawn as ONE open polyline (the last side missing): closed with a straight edge, used only
  // when no properly closed shape fits a caption (they sort after real shapes)
  for (const o of prims) {
    if (o.k !== 'P' || o.closed || o.pts.length < 3) continue;
    const a = o.pts[0], z = o.pts[o.pts.length - 1];
    if (Math.hypot(a[0] - z[0], a[1] - z[1]) < 0.5) continue;
    const ring = o.pts.map((p, i) => ({ x: p[0], y: p[1], bulge: i === o.pts.length - 1 ? 0 : (p[2] || 0) }));
    const pts = ringPoints(ring); let area = polyArea(pts);
    if (area < 0) { const n = ring.length; const rev = []; for (let k = n - 1; k >= 0; k--) rev.push({ x: ring[(k + 1) % n].x, y: ring[(k + 1) % n].y, bulge: -ring[k].bulge }); ring.splice(0, n, ...rev); area = -area; }
    const P2 = ringPoints(ring); const b = bboxOf(P2);
    comps.push(withRotation({ id: comps.length, ring, pts: P2, area, box: b, dx: b.x1 - b.x0, dy: b.y1 - b.y0, edges: ring.length, closedByRule: true }));
  }
  // circle grid for hole lookup
  const CG = 500; const cgrid = new Map();
  for (const c of circles) { const k = Math.floor(c.x / CG) + ',' + Math.floor(c.y / CG); if (!cgrid.has(k)) cgrid.set(k, []); cgrid.get(k).push(c); }
  const circlesIn = (b) => { const out = []; for (let i = Math.floor(b.x0 / CG); i <= Math.floor(b.x1 / CG); i++) for (let j = Math.floor(b.y0 / CG); j <= Math.floor(b.y1 / CG); j++) for (const c of cgrid.get(i + ',' + j) ?? []) if (c.x >= b.x0 && c.x <= b.x1 && c.y >= b.y0 && c.y <= b.y1) out.push(c); return out; };
  return { g, comps, circlesIn, stats: { prims: prims.length, edges: g.edges.length, comps: comps.length, circles: circles.length } };
}

/** A shape drawn at an angle: its rectangle in the frame of its longest straight side. */
function withRotation(c) {
  let best = null;
  for (let k = 0; k < c.ring.length; k++) {
    const p = c.ring[k], q = c.ring[(k + 1) % c.ring.length];
    if (p.bulge) continue;
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    if (!best || L > best.L) best = { L, th: Math.atan2(q.y - p.y, q.x - p.x) };
  }
  if (!best) return c;
  let th = best.th % (Math.PI / 2); if (th < 0) th += Math.PI / 2;
  if (th < 1e-3 || Math.PI / 2 - th < 1e-3) return c;
  const cs = Math.cos(-th), sn = Math.sin(-th);
  const rp = c.pts.map(([x, y]) => [x * cs - y * sn, x * sn + y * cs]);
  const rb = bboxOf(rp);
  c.rot = { th, box: rb, dx: rb.x1 - rb.x0, dy: rb.y1 - rb.y0 };
  return c;
}

/**
 * A part's outline merged with lines that touch it (hand-drawn dimension lines on the part layer,
 * leader stubs): try every placement of the caption-size rectangle whose sides land on the shape's
 * own corner coordinates, keep only the edges inside it, and see whether they close into a shape
 * of exactly that size.
 */
function clipCandidates(gi, comp, W, L, s) {
  const out = [];
  const g = gi.g; const tol = 0.6 * s;
  const nodesOf = new Set(); for (const i of comp.edgeIdx) { nodesOf.add(g.edges[i].u); nodesOf.add(g.edges[i].v); }
  const xs = [...new Set([...nodesOf].map((n) => Math.round(g.nodes[n][0] * 10) / 10))].sort((a, b) => a - b);
  const ys = [...new Set([...nodesOf].map((n) => Math.round(g.nodes[n][1] * 10) / 10))].sort((a, b) => a - b);
  const has = (arr, v) => arr.some((a) => Math.abs(a - v) <= tol);
  for (const [bx, by] of [[s * L, s * W], [s * W, s * L]]) {
    const X0 = xs.filter((x) => has(xs, x + bx)); const Y0 = ys.filter((y) => has(ys, y + by));
    if (X0.length * Y0.length > 400) continue;
    for (const x0 of X0) for (const y0 of Y0) {
      const box = { x0: x0 - tol, y0: y0 - tol, x1: x0 + bx + tol, y1: y0 + by + tol };
      const inB = (p) => p[0] >= box.x0 && p[0] <= box.x1 && p[1] >= box.y0 && p[1] <= box.y1;
      let sub = comp.edgeIdx.filter((i) => { const e = g.edges[i]; return inB(g.nodes[e.u]) && inB(g.nodes[e.v]); });
      // prune dangling inside the box
      for (;;) { const deg = new Map(); for (const i of sub) { const e = g.edges[i]; deg.set(e.u, (deg.get(e.u) || 0) + 1); deg.set(e.v, (deg.get(e.v) || 0) + 1); } const keep = sub.filter((i) => deg.get(g.edges[i].u) > 1 && deg.get(g.edges[i].v) > 1); if (keep.length === sub.length) break; sub = keep; }
      if (sub.length < 3) continue;
      const sg = { nodes: g.nodes, edges: sub.map((i) => g.edges[i]) };
      for (const part of components(sg)) {
        const of = outerFace(sg, part); if (!of) continue;
        const pts = ringPoints(of.ring); const b = bboxOf(pts);
        if (Math.abs((b.x1 - b.x0) - bx) <= tol && Math.abs((b.y1 - b.y0) - by) <= tol) out.push({ id: `${comp.id}c${x0},${y0}`, ring: of.ring, pts, area: of.area, box: b, dx: b.x1 - b.x0, dy: b.y1 - b.y0, clippedFrom: comp.id });
      }
    }
  }
  return out;
}

const boxDist = (b, x, y) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));

/** Candidate detail views for a caption: components whose rectangle is the caption size at some drawing scale. */
function candidatesFor(cap, comps) {
  const W = cap.size.widthMm, L = cap.size.lengthMm;
  const out = [];
  for (const c of comps) {
    if (c.sheet !== cap.sheet) continue; // a detail sits on the same sheet as its caption
    for (const frame of [c, c.rot].filter(Boolean)) {
      const big = Math.max(frame.dx, frame.dy), small = Math.min(frame.dx, frame.dy);
      let hit = false;
      for (const s of SCALES) {
        const tol = Math.max(1.0, 0.0005 * L) * s;
        if (Math.abs(big - s * L) <= tol && Math.abs(small - s * W) <= tol) {
          const d = boxDist(c.box, cap.x, cap.y);
          const reach = 1.2 * s * L + 40 * (cap.h || 60) + 600;
          if (d <= reach) out.push({ comp: c, scale: s, dist: d, rel: d / reach + (c.closedByRule ? 10 : 0) + (frame !== c ? 5 : 0), rotated: frame !== c });
          hit = true; break;
        }
      }
      if (hit) break;
    }
  }
  return out;
}

function holesAndCuts(view, gi, comps) {
  const b = view.comp.box;
  const s = view.scale;
  const seen = [];
  const holes = []; const bigCircles = [];
  for (const c of gi.circlesIn(b)) {
    if (!inPoly([c.x, c.y], view.comp.pts)) continue;
    if (seen.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < 0.5 && Math.abs(q.r - c.r) < 0.5)) continue;
    seen.push(c);
    if (2 * c.r / s <= DRILL_MAX_DIA + 1e-6) holes.push(c); else bigCircles.push(c);
  }
  // a drilled hole is ONE circle; two circles on one centre (shank + head) are a welded stud / bolt symbol
  const byCentre = []; const symbols = [];
  for (const h of holes) {
    const same = holes.filter((q) => Math.hypot(q.x - h.x, q.y - h.y) < 0.5);
    if (same.length > 1) { if (!symbols.some((q) => Math.hypot(q.x - h.x, q.y - h.y) < 0.5)) symbols.push(h); continue; }
    byCentre.push(h);
  }
  // inner closed shapes that do not touch the outline -> cut-outs
  const cutouts = [];
  for (const c of comps) {
    if (c === view.comp) continue;
    if (c.box.x0 < b.x0 || c.box.x1 > b.x1 || c.box.y0 < b.y0 || c.box.y1 > b.y1) continue;
    if (!c.pts.every((p) => inPoly(p, view.comp.pts))) continue;
    if (c.area < 0.005 * view.comp.area) continue;
    cutouts.push(c);
  }
  return { holes: byCentre, bigCircles, cutouts, symbols };
}

/** Compare two detail views as plates: same area, same hole count and diameters. */
function sameGeometry(a, b) {
  if (!a || !b) return null;
  const A = a.areaMm2, B = b.areaMm2;
  if (Math.abs(A - B) > 0.005 * Math.max(A, B)) return false;
  if (a.holes !== b.holes) return false;
  return JSON.stringify(a.holeDia) === JSON.stringify(b.holeDia);
}

// ------------------------------------------------------------------ main
export function extractFromDb(db, { readPartDrawing, name = 'drawing' } = {}) {
  const t0 = Date.now();
  const flat = flatten(db);
  const sheets = findSheets(flat);
  const framed = sheets.length > 0;
  if (!framed) {
    // No title block: the whole drawing is one sheet, titled by its biggest text that is not a caption.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y) => { if (!Number.isFinite(x) || !Number.isFinite(y)) return; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const o of flat) {
      if (o.k === 'L') { grow(o.x1, o.y1); grow(o.x2, o.y2); } else if (o.k === 'P') { for (const p of o.pts) grow(p[0], p[1]); } else if (o.k === 'C' || o.k === 'A') { grow(o.x - o.r, o.y - o.r); grow(o.x + o.r, o.y + o.r); } else if (o.k === 'T') grow(o.x, o.y);
    }
    if (x1 > x0) {
      const big = flat.filter((o) => o.k === 'T' && o.src !== 'DIM' && o.text && o.text.length < 160 && !parseCaption(o.text)).sort((a, b) => (b.h || 0) - (a.h || 0))[0];
      sheets.push({ no: name, num: 1, x0: x0 - 1, x1: x1 + 1, y0: y0 - 1, y1: y1 + 1, textH: 0, title: big ? big.text.replace(/\n/g, ' ') : null, framedBy: 'whole drawing' });
    }
  }
  const texts = flat.filter((o) => o.k === 'T' && o.src !== 'DIM');
  const dims = flat.filter((o) => o.k === 'T' && o.src === 'DIM');
  const gi = geometryIndex(db, flat);
  for (const c of gi.comps) c.sheet = sheetOf(sheets, (c.box.x0 + c.box.x1) / 2, (c.box.y0 + c.box.y1) / 2);

  // general grade note
  let grade = null;
  for (const t of texts) {
    const m = t.text.toUpperCase().replace(/\n/g, ' ').match(/GRADE OF[^.]*?\b(E\s?\d{3}(?:\s?-?\s?B[OR0]|\s?[A-C])?)\b/);
    if (m) { grade = m[1].replace(/\s+/g, '').replace(/BO$/, 'B0'); break; }
  }

  // captions
  const caps = [];
  for (const t of texts) {
    const c = parseCaption(t.text);
    if (!c) continue;
    const sh = sheetOf(sheets, t.x, t.y);
    caps.push({ ...c, x: t.x, y: t.y, h: t.h || 60, src: t.src, sheet: sh, sheetNo: sh?.num ?? null });
  }
  const inSheet = caps.filter((c) => c.sheet);
  const outside = caps.filter((c) => !c.sheet);

  // a "(TOKEN)" shared by captions of different sizes is a GROUP (e.g. SP1 = splice joint 1), not a part mark
  const tokSizes = new Map();
  for (const c of inSheet) if (c.token) { if (!tokSizes.has(c.token)) tokSizes.set(c.token, new Set()); tokSizes.get(c.token).add(sizeKey(c)); }
  // ...unless it is only two near-identical sizes (same thickness, one side equal): then it is ONE part whose
  // size the drawing states two ways — a conflict for a human, not a group
  const conflictTok = new Map();
  for (const [tok, set] of tokSizes) {
    if (set.size !== 2) continue;
    const [a, b] = [...set].map((k) => k.split('x').map(Number));
    const close = (p, q) => Math.abs(p - q) <= 0.15 * Math.max(p, q);
    if (a.length === 3 && b.length === 3 && a[0] === b[0] && ((a[1] === b[1] && close(a[2], b[2])) || (a[2] === b[2] && close(a[1], b[1])))) conflictTok.set(tok, [...set]);
  }
  for (const c of inSheet) { c.group = c.token && tokSizes.get(c.token).size > 1 && !conflictTok.has(c.token) ? c.token : null; c.mark = c.token && !c.group ? c.token : null; }

  // detail views: greedy one-to-one assignment by distance (captions with a stated qty first)
  const pairs = [];
  inSheet.forEach((c, ci) => { for (const v of candidatesFor(c, gi.comps)) pairs.push({ ci, ...v, pri: c.qty != null ? 0 : 1 }); });
  pairs.sort((p, q) => p.pri - q.pri || p.scale !== q.scale && (p.scale === 1 ? -1 : q.scale === 1 ? 1 : 0) || p.rel - q.rel || p.ci - q.ci);
  const compTaken = new Map(); // comp id -> sizeKey|mark
  for (const p of pairs) {
    const c = inSheet[p.ci];
    if (c.view) continue;
    const ident = sizeKey(c) + '|' + (c.mark ?? c.desc);
    const owner = compTaken.get(p.comp.id);
    if (owner && owner !== ident) continue;
    if (owner === ident && c.qty != null) continue; // a second stated caption of the same part wants its own view
    c.view = { comp: p.comp, scale: p.scale, dist: p.dist, rotated: p.rotated };
    compTaken.set(p.comp.id, ident);
  }
  // second pass: captions still without a view — clip bigger shapes nearby to the caption rectangle
  const pairs2 = [];
  inSheet.forEach((c, ci) => {
    if (c.view || c.kind !== 'plate' && c.kind !== 'section') return;
    const W = c.size.widthMm, L = c.size.lengthMm;
    for (const comp of gi.comps) {
      if (!comp.edgeIdx || compTaken.has(comp.id) || comp.sheet !== c.sheet) continue;
      for (const s of SCALES) {
        const reach = 1.2 * s * L + 40 * (c.h || 60) + 600;
        const big = Math.max(comp.dx, comp.dy), small = Math.min(comp.dx, comp.dy);
        if (big < s * L - 1 || small < s * W - 1 || big > 3 * s * L + 2000 || small > 3 * s * L + 2000) continue;
        const d = boxDist(comp.box, c.x, c.y); if (d > reach) continue;
        for (const sub of clipCandidates(gi, comp, W, L, s)) pairs2.push({ ci, comp: sub, scale: s, dist: boxDist(sub.box, c.x, c.y), rel: boxDist(sub.box, c.x, c.y) / reach });
        break;
      }
    }
  });
  pairs2.sort((p, q) => (p.scale === 1 ? 0 : 1) - (q.scale === 1 ? 0 : 1) || p.rel - q.rel || p.ci - q.ci);
  const subTaken = new Set();
  for (const p of pairs2) {
    const c = inSheet[p.ci];
    if (c.view || subTaken.has(p.comp.id)) continue;
    c.view = { comp: p.comp, scale: p.scale, dist: p.dist, rotated: false, clipped: true };
    subTaken.add(p.comp.id);
  }
  for (const c of inSheet) {
    if (!c.view) continue;
    const hc = holesAndCuts(c.view, gi, gi.comps);
    const s = c.view.scale;
    const dia = [...new Set(hc.holes.map((h) => Math.round(2 * h.r / s * 10) / 10))].sort((a, b) => a - b);
    const cutArea = hc.cutouts.reduce((a, q) => a + q.area, 0) + hc.bigCircles.reduce((a, q) => a + Math.PI * q.r * q.r, 0);
    c.geo = {
      holes: hc.holes.length, holeDia: dia,
      holeGroups: dia.map((d) => [hc.holes.filter((h) => Math.abs(2 * h.r / s - d) < 0.06).length, d]),
      areaMm2: (c.view.comp.area - cutArea) / (s * s) - hc.holes.reduce((a, h) => a + Math.PI * h.r * h.r, 0) / (s * s),
      cutouts: hc.cutouts.length + hc.bigCircles.length, scale: s, symbols: hc.symbols.length,
      raw: hc,
    };
  }

  // ---------------- rows from stated-quantity captions
  const stated = inSheet.filter((c) => c.qty != null);
  const rows = [];
  for (const c of stated) {
    // merge with an existing row: same size AND (same mark, or both unmarked with the same drawing / same words)
    let how = null;
    const r = rows.find((r) => {
      if (!sameSize(r.cap, c) || (r.cap.group ?? null) !== (c.group ?? null)) return false;
      if (c.mark && r.cap.mark === c.mark) { how = 'same mark'; return true; }
      if (c.mark || r.cap.mark) return false;
      const sg = sameGeometry(r.cap.geo, c.geo);
      if (sg === true) { how = 'identical detail drawings'; return true; }
      if (sg === null && r.cap.desc === c.desc && r.cap.sheet === c.sheet) { how = 'same words on the same sheet'; return true; }
      return false;
    });
    if (r) r.mergeHow = r.mergeHow && r.mergeHow !== how ? r.mergeHow + ' / ' + how : how;
    if (r) { r.captions.push(c); continue; }
    rows.push({ cap: c, captions: [c] });
  }
  // ---------------- rows from call-outs whose size no stated caption has
  const callouts = inSheet.filter((c) => c.qty == null && !stated.some((s) => sameSize(s, c)));
  const bySize = new Map();
  for (const c of callouts) { const k = sizeKey(c) + '|'; if (!bySize.has(k)) bySize.set(k, []); bySize.get(k).push(c); }

  // girder plates: flange / web call-outs with no quantity, long enough to be a girder segment
  const isGirderPlate = (c) => c.kind === 'plate' && /\b(FLANGE|WEB)\b/.test(c.desc) && c.size.lengthMm >= 3000;
  const girderCallouts = callouts.filter(isGirderPlate);
  // girder count: labels "G1".."Gn" in the drawing
  const gl = new Set();
  for (const t of texts) { const m = t.text.trim().toUpperCase().match(/^\(?G\s?-?(\d{1,2})\)?$/); if (m) gl.add(Number(m[1])); }
  const nGirders = gl.size ? Math.max(...gl) : null;
  const girderConsistent = gl.size > 0 && gl.size === Math.max(...gl);
  // views: call-outs of girder plates clustered per sheet by height on the sheet
  const clusters = [];
  for (const c of [...girderCallouts].sort((p, q) => (p.sheetNo - q.sheetNo) || p.y - q.y || p.x - q.x)) {
    const last = clusters[clusters.length - 1];
    if (last && last.sheet === c.sheet && c.y - last.ymax <= 6 * c.h) { last.items.push(c); last.ymax = c.y; }
    else clusters.push({ sheet: c.sheet, ymax: c.y, items: [c] });
  }
  // For each family (top flange / web / bottom flange) pick ONE view: the one whose call-outs, laid end
  // to end, add up to a length the drawing dimensions somewhere (the girder's overall length). A
  // single-girder elevation does; a cross section (one call-out) or a plan of several girders does not.
  const famOf = (c) => /\bWEB\b/.test(c.desc) ? 'WEB' : /\b(TOP)\b/.test(c.desc) ? 'TOP FLANGE' : 'BOTTOM FLANGE';
  const dimVals = dims.map((d) => d.meas).filter((m) => m > 3000);
  const perGirder = new Map(); // sizeKey -> { n, cl, how }
  const famLen = {}; const famHow = {};
  const famOpts = {};
  for (const fam of ['TOP FLANGE', 'WEB', 'BOTTOM FLANGE']) {
    const opts = [];
    for (const cl of clusters) {
      const its = cl.items.filter((c) => famOf(c) === fam);
      if (!its.length) continue;
      const sum = its.reduce((a, c) => a + c.size.lengthMm, 0);
      const dim = dimVals.filter((d) => Math.abs(d - sum) <= 0.0025 * sum).sort((p, q) => Math.abs(p - sum) - Math.abs(q - sum))[0];
      opts.push({ cl, its, sum, dim });
    }
    if (opts.length) famOpts[fam] = opts;
  }
  // the girder length most families agree on (first choice of each family); then every family takes
  // a view whose segments add up to exactly that length if it has one
  const first = Object.values(famOpts).map((opts) => [...opts].sort((p, q) => (q.dim ? 1 : 0) - (p.dim ? 1 : 0) || q.its.length - p.its.length || p.sum - q.sum)[0].sum);
  const agreed = first.sort((a, b) => first.filter((x) => Math.abs(x - b) <= 1).length - first.filter((x) => Math.abs(x - a) <= 1).length || b - a)[0];
  for (const [fam, opts] of Object.entries(famOpts)) {
    opts.sort((p, q) => (Math.abs(q.sum - agreed) <= 1 ? 1 : 0) - (Math.abs(p.sum - agreed) <= 1 ? 1 : 0) || (q.dim ? 1 : 0) - (p.dim ? 1 : 0) || q.its.length - p.its.length || p.sum - q.sum);
    const pick = opts[0];
    famLen[fam] = pick.sum; famHow[fam] = pick.dim ? `adds up to the dimension ${Math.round(pick.dim)}` : 'no dimension matches';
    for (const c of pick.its) { const k = sizeKey(c); const cur = perGirder.get(k) ?? { n: 0, cl: pick.cl, fam, dimOk: !!pick.dim, items: [] }; cur.n++; cur.items.push(c); perGirder.set(k, cur); }
  }
  const lens = Object.values(famLen);
  const famConsistent = lens.length >= 2 && Math.max(...lens) - Math.min(...lens) <= 1;
  // segment order along the girder: x order of the girder-plate call-outs in each family's chosen view
  const segOf = new Map();
  for (const fam of ['TOP FLANGE', 'WEB', 'BOTTOM FLANGE']) {
    const items = [];
    for (const [, v] of perGirder) if (v.fam === fam) items.push(...v.items);
    const uniqItems = [...new Set(items)].sort((p, q) => p.x - q.x);
    uniqItems.forEach((c, i) => { const k = sizeKey(c); if (!segOf.has(k)) segOf.set(k, []); if (!segOf.get(k).includes(i + 1)) segOf.get(k).push(i + 1); });
  }
  // web depth (for stiffener membership)
  const webDepths = girderCallouts.filter((c) => /\bWEB\b/.test(c.desc)).map((c) => c.size.widthMm);

  for (const [k, list] of bySize) {
    // prefer the caption that found a detail view, then MTEXT over leader
    const best = [...list].sort((p, q) => (q.view ? 1 : 0) - (p.view ? 1 : 0) || (q.mark ? 1 : 0) - (p.mark ? 1 : 0) || (p.src === 'MTEXT' ? -1 : 1) - (q.src === 'MTEXT' ? -1 : 1))[0];
    rows.push({ cap: best, captions: list, calloutOnly: true });
  }

  // view titles (big words like "DETAIL OF LONGITUDINAL SEISMIC STOPPER") for the membership fallback
  const VIEW_HINT = /(DETAIL|ELEVATION|PLAN|LAYOUT|SECTION|VIEW)/;
  const viewTitles = texts.filter((t) => VIEW_HINT.test(t.text.toUpperCase()) && !parseCaption(t.text) && t.h > 0).map((t) => ({ text: t.text.toUpperCase().replace(/\n/g, ' '), x: t.x, y: t.y, h: t.h, sheet: sheetOf(sheets, t.x, t.y) })).filter((t) => t.sheet);
  // ---------------- finish rows
  const outRows = [];
  const files = {};
  const usedNames = new Set();
  for (const r of rows) {
    const c = r.cap;
    const reasons = [];
    let conf = 'high';
    const down = (lvl) => { const order = ['high', 'medium', 'low']; if (order.indexOf(lvl) > order.indexOf(conf)) conf = lvl; };
    // quantity
    let qty = null, qtyHow = null;
    if (!r.calloutOnly) {
      const distinct = [];
      for (const x of r.captions) if (!distinct.some((d) => d.text === x.text)) distinct.push(x);
      qty = distinct.reduce((a, x) => a + x.qty, 0);
      qtyHow = distinct.length > 1 ? `sum of ${distinct.length} captions (${distinct.map((x) => x.qty).join(' + ')})` : 'stated on the caption';
      if (distinct.length > 1) { reasons.push(`quantity is the sum of ${distinct.length} captions of the same part (${r.mergeHow})`); if (/words/.test(r.mergeHow)) down('medium'); }
    } else if (isGirderPlate(c) && perGirder.has(sizeKey(c)) && nGirders) {
      const pg = perGirder.get(sizeKey(c));
      qty = pg.n * nGirders;
      qtyHow = `${pg.n} per girder (call-outs in one view on sheet ${pg.cl.sheet.num}, ${famHow[pg.fam]}) x ${nGirders} girders (labels G1..G${nGirders})`;
      reasons.push('girder plate: quantity counted, not stated');
      if (!famConsistent || !girderConsistent || !pg.dimOk) { reasons.push('girder-length check failed: the segment lengths do not add up to a dimensioned girder length in every family'); down('low'); } else reasons.push(`checks passed: girder labels G1..G${nGirders} complete; top flange, web and bottom flange segments each add up to ${famLen[pg.fam]} mm, a dimensioned length`);
    } else {
      reasons.push('no quantity stated on the drawing'); down('low');
    }
    // the same mark drawn at two sizes
    if (c.mark && conflictTok.has(c.mark)) { reasons.push(`size conflict: the drawing gives mark ${c.mark} two sizes (${conflictTok.get(c.mark).join(' and ')}) — a human must pick`); down('low'); }
    // geometry
    let geo = null, file = null, reader = null;
    let gconf = 'high';
    const gdown = (lvl) => { const order = ['high', 'medium', 'low']; if (order.indexOf(lvl) > order.indexOf(gconf)) gconf = lvl; };
    const withView = r.captions.filter((x) => x.view);
    const v = withView[0];
    if (v) {
      geo = v.geo;
      if (withView.length > 1 && withView.some((x) => sameGeometry(x.geo, v.geo) === false)) { reasons.push('the merged captions point at detail views that differ'); gdown('medium'); }
      if (v.view.scale !== 1) { reasons.push(`detail drawn at x${v.view.scale} (rescaled)`); gdown('medium'); }
      if (geo.cutouts) { reasons.push(`${geo.cutouts} inner shape(s) taken as cut-outs: check they are openings, not plates drawn on top`); gdown('medium'); }
      if (geo.symbols) reasons.push(`${geo.symbols} double circles (stud / bolt symbols) not counted as holes`);
      // a hole row given as "13@62.5" means 14 holes on that line; fewer drawn circles = holes not all drawn
      {
        const b = v.view.comp.box; const m = 0.15 * Math.max(b.x1 - b.x0, b.y1 - b.y0);
        let implied = 0; let txt = null;
        for (const d of dims) {
          if (d.x < b.x0 - m || d.x > b.x1 + m || d.y < b.y0 - m || d.y > b.y1 + m) continue;
          const mm = String(d.text).match(/(\d+)\s*@\s*\d/); if (mm && Number(mm[1]) + 1 > implied) { implied = Number(mm[1]) + 1; txt = d.text; }
        }
        if (implied > 1 && geo.holes > 0 && geo.holes < implied) { reasons.push(`pitch dimension "${txt}" implies at least ${implied} holes on a line but only ${geo.holes} circles are drawn: holes need a human`); gdown('low'); }
      }
      if (c.kind === 'section') reasons.push('rolled section: the file is the flat view of one leg (length x leg) with its holes');
      if (isGirderPlate(c)) { reasons.push('outline taken from a plan / elevation of the girder: holes are those drawn on that one plate; the same plate on other girders may differ'); gdown('medium'); }
      // file
      const base = (c.mark ?? c.group ?? c.desc.split(' ').slice(0, 3).join('-')).replace(/[^A-Z0-9'\-]+/gi, '-').replace(/'/g, 'p').replace(/-+/g, '-').replace(/^-|-$/g, '');
      let name = `${base}_${c.size.thicknessMm}mm_${c.size.widthMm}x${c.size.lengthMm}`;
      while (usedNames.has(name)) name += '_b';
      usedNames.add(name);
      if (v.view.clipped) { reasons.push('outline touched by other lines; cut free at the caption size'); gdown('medium'); }
      if (v.view.comp.closedByRule) { reasons.push('outline drawn as an open polyline; closed with a straight edge'); gdown('medium'); }
      if (v.view.rotated) { reasons.push(`detail drawn at an angle (${Math.round(v.view.comp.rot.th * 180 / Math.PI * 10) / 10}°); turned square`); gdown('medium'); }
      let part = { ring: v.view.comp.ring, cutouts: geo.raw.cutouts.map((q) => q.ring), holes: geo.raw.holes };
      let box = v.view.comp.box;
      if (v.view.rotated) {
        const th = v.view.comp.rot.th, cs = Math.cos(-th), sn = Math.sin(-th);
        const R = (x, y) => [x * cs - y * sn, x * sn + y * cs];
        const RR = (r) => r.map((p) => { const [x, y] = R(p.x, p.y); return { x, y, bulge: p.bulge }; });
        part = { ring: RR(part.ring), cutouts: part.cutouts.map(RR), holes: part.holes.map((h) => { const [x, y] = R(h.x, h.y); return { x, y, r: h.r }; }) };
        box = v.view.comp.rot.box;
      }
      const np = normalisePart(part, box, v.view.scale);
      const txt = partDxf({ ...np, comments: [`drawing_bom extractor (deterministic). Caption: ${c.text}`, `Sheet ${v.sheet?.no ?? '?'}; detail at (${Math.round(v.view.comp.box.x0)},${Math.round(v.view.comp.box.y0)}) scale x${v.view.scale}`] });
      file = `${name}.dxf`;
      files[file] = txt;
      if (readPartDrawing) {
        const rd = readPartDrawing(txt);
        const g = rd.geometry;
        const sizeOk = !!g && Math.abs(Math.max(g.lengthMm, g.widthMm) - c.size.lengthMm) <= 1 && Math.abs(Math.min(g.lengthMm, g.widthMm) - c.size.widthMm) <= 1;
        reader = { ok: !!g, sizeOk, lengthMm: g?.lengthMm, widthMm: g?.widthMm, holes: g?.holes, holeDia: g ? [...new Set(g.holeDiameters)] : [], areaMm2: g?.areaMm2, warnings: rd.warnings, problems: rd.problems };
        if (!g) { reasons.push('part reader refused the file: ' + rd.problems.join('; ')); gdown('low'); }
        else if (!sizeOk) { reasons.push(`part reader size ${g.lengthMm} x ${g.widthMm} differs from the caption`); gdown('low'); }
        else if (g.holes !== geo.holes) { reasons.push(`reader holes ${g.holes} vs found ${geo.holes}`); gdown('medium'); }
      }
    } else {
      reasons.push(r.calloutOnly ? 'no detail view: size from the call-out only (outline and holes not known)' : 'no detail view found near the caption: size from the caption only');
      gconf = 'none';
    }
    // assembly membership
    // membership: the first caption of the part that a rule can decide
    let asm = { name: 'unknown', how: 'unknown' };
    for (const x of [c, ...r.captions.filter((q) => q !== c)]) { asm = membership(x, r, { webDepths, segOf, isGirderPlate, viewTitles }); if (asm.how !== 'unknown') break; }
    if (asm.how === 'unknown') reasons.push('assembly: no rule decides');
    outRows.push({
      mark: c.mark ?? null,
      group: c.group ?? null,
      description: c.desc,
      caption: c.text,
      captions: r.captions.map((x) => x.text),
      kind: c.kind,
      profile: c.kind === 'section' ? c.size.profile : 'PL',
      thicknessMm: c.size.thicknessMm,
      widthMm: c.size.widthMm,
      lengthMm: c.size.lengthMm,
      grade: grade,
      gradeHow: grade ? 'general note (not on the caption)' : null,
      qty, qtyHow,
      unitKg: Math.round(unitKg(c) * 100) / 100,
      totalKg: qty != null ? Math.round(unitKg(c) * qty * 10) / 10 : null,
      holes: geo ? geo.holes : null,
      holeGroups: geo ? geo.holeGroups : null,
      cutouts: geo ? geo.cutouts : null,
      shapeAreaMm2: geo ? Math.round(geo.areaMm2) : null,
      detail: v ? { sheet: v.sheet?.no, scale: v.view.scale, x: Math.round(v.view.comp.box.x0), y: Math.round(v.view.comp.box.y0) } : null,
      file, reader,
      sheets: [...new Set(r.captions.map((x) => x.sheet?.num))],
      assembly: asm.name, assemblyHow: asm.how,
      confidence: conf, geometryConfidence: gconf, reasons,
      at: [Math.round(c.x), Math.round(c.y)],
    });
  }
  outRows.sort((a, b) => (a.sheets[0] ?? 99) - (b.sheets[0] ?? 99) || a.at[1] - b.at[1] || a.at[0] - b.at[0]);
  const result = {
    drawing: name,
    framed,
    ms: Date.now() - t0,
    stats: { ...gi.stats, texts: texts.length, dims: dims.length, captions: caps.length, captionsOutsideSheets: outside.length },
    sheets: sheets.map((s) => ({ num: s.num, no: s.no, title: s.title, box: [s.x0, s.x1, s.y0, s.y1].map(Math.round), framedBy: s.framedBy })),
    grade, girders: nGirders, girderLabelsComplete: girderConsistent, girderFamilyLengths: famLen, girderLengthsAgree: famConsistent,
    parts: outRows,
    ignoredOutsideSheets: outside.map((c) => c.text),
    files,
  };
  return result;
}

// ------------------------------------------------------------------ assembly membership rules
const CATS = [
  [/SEISMIC|ARRESTOR|STOPPER/, 'Seismic arrestor / stopper'],
  [/SPLICE/, 'Splice joint'],
  [/CROSS GIRDER/, 'Cross girder (end diaphragm)'],
  [/CROSS FRAME/, 'Cross frame'],
  [/LATERAL BRACING|\bBLB\b/, 'Bottom lateral bracing'],
];
function membership(c, r, { webDepths, segOf, isGirderPlate, viewTitles }) {
  const desc = c.desc;
  const title = (c.sheet?.title ?? '').toUpperCase();
  if (isGirderPlate(c)) {
    const segs = segOf.get(sizeKey(c));
    return { name: segs ? `Main girder, segment ${segs.map((s) => 'S' + s).join('+')}` : 'Main girder', how: segs ? 'girder plate; segment = order of its call-out along the girder elevation' : 'girder plate' };
  }
  for (const [re, name] of CATS) if (re.test(desc)) return { name: c.group ? `${name} ${c.group}` : name, how: 'words of the caption' };
  if (/STIFFENER|STFR/.test(desc) && webDepths.some((d) => Math.abs(c.size.lengthMm - d) <= 60)) return { name: 'Main girder (stiffener)', how: 'stiffener as long as the girder web is deep' };
  if (c.group) return { name: `Group ${c.group}`, how: 'caption group token' };
  const hits = [];
  if (/END DIAPHRAGM/.test(title)) hits.push('End diaphragm');
  if (/INTERMEDIATE DIAPHRAGM|INTERMEDIATE ELEVATION/.test(title)) hits.push('Intermediate diaphragm');
  for (const [re, name] of CATS) if (re.test(title)) hits.push(name);
  if (/^ED\b/.test(desc)) return { name: 'End diaphragm', how: 'ED prefix' };
  if (/^ID\b/.test(desc)) return { name: 'Intermediate diaphragm', how: 'ID prefix' };
  if (hits.length === 1) return { name: hits[0], how: `sheet title "${c.sheet.title}"` };
  // nearest view title on the same sheet (within 0.6 of the sheet width)
  const reach = 0.6 * (c.sheet.x1 - c.sheet.x0);
  const vt = viewTitles.filter((t) => t.sheet === c.sheet && t.h >= c.h && Math.hypot(t.x - c.x, t.y - c.y) <= reach)
    .sort((p, q) => Math.hypot(p.x - c.x, p.y - c.y) - Math.hypot(q.x - c.x, q.y - c.y))[0];
  if (vt) {
    const vh = [];
    if (/END DIAPHRAGM/.test(vt.text)) vh.push('End diaphragm');
    if (/INTERMEDIATE DIAPHRAGM/.test(vt.text)) vh.push('Intermediate diaphragm');
    for (const [re, name] of CATS) if (re.test(vt.text)) vh.push(name);
    if (vh.length === 1) return { name: vh[0], how: `nearest view title "${vt.text.slice(0, 80)}"` };
  }
  return { name: 'unknown', how: 'unknown' };
}
