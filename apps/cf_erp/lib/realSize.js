/**
 * realSize.js — PURE: the REAL size of a plate from its flat outline (user, 2026-11-28: "Camber webs and IS and other
 * places, show the real width. Let the blank size come from nesting anyways." … "the lengths are coming from the 3D
 * diagram itself"). The same function as TM/drawing_bom/src/method2/realSize.mjs (the compilers that write bom.json and
 * model.json, and check rule R125), so the BOM, the model's values and the drawing agree.
 *
 *   band   a strip of one depth along a line that is not straight or not level in the plate's own axes (a web cut to the
 *          camber, a sloped or kinked web): its long edges stand the same plumb distance apart all along (within 2 mm)
 *          and its bottom edge is not one level line.
 *          width  = that plumb depth, to the whole mm (the web depth the drawing gives)
 *          length = its bottom edge developed, to 0.1 mm (the longer edge when the ends are cut on a skew: edges > 1 % apart)
 *   rect   anything else (a rectangle, clipped or notched corners, a taper, a gusset): the rectangle round its outline in
 *          its own axes — the size the detail prints.
 * The BLANK (the rectangle round the outline, however the plate lies on the steel) is not a part value: nesting cuts the
 * DXF outline (nestShapes.shapeOfCutPlate). It is returned only to say what the old figure was.
 */
const r1 = (v) => Math.round(v * 10) / 10;

/** → { kind: 'band' | 'rect', widthMm, lengthMm, blank: { widthMm, lengthMm } } | null, for [[x, y] …] in mm. */
export function realPlateSize(pts0) {
  let P = (pts0 ?? []).map((q) => [Number(q[0]), Number(q[1])]).filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
  if (P.length > 3 && Math.abs(P[0][0] - P.at(-1)[0]) < 1e-9 && Math.abs(P[0][1] - P.at(-1)[1]) < 1e-9) P.pop();
  if (P.length < 3) return null;
  const xs = P.map((p) => p[0]); const ys = P.map((p) => p[1]);
  const dx = Math.max(...xs) - Math.min(...xs); const dy = Math.max(...ys) - Math.min(...ys);
  const blank = { lengthMm: r1(Math.max(dx, dy)), widthMm: r1(Math.min(dx, dy)) };
  const rect = { kind: 'rect', lengthMm: blank.lengthMm, widthMm: blank.widthMm, blank };
  if (P.length < 5) return rect;
  if (dy > dx) P = P.map(([x, y]) => [y, x]);               // x along the strip
  const A = P.reduce((s, p, i) => { const q = P[(i + 1) % P.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
  if (A < 0) P.reverse();                                    // counter-clockwise: the bottom edge runs +x
  const x0 = Math.min(...P.map((p) => p[0])); const L = Math.max(...P.map((p) => p[0])) - x0;
  const lo = []; const d = [];
  for (let k = 0; k <= 180; k++) {
    const x = x0 + L * (0.05 + (0.9 * k) / 180); const hit = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i]; const b = P[(i + 1) % P.length];
      if ((a[0] - x) * (b[0] - x) < 0 || (a[0] === x && b[0] !== x)) hit.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
    }
    if (hit.length !== 2) return rect;
    lo.push(Math.min(...hit)); d.push(Math.abs(hit[0] - hit[1]));
  }
  const spread = (v) => Math.max(...v) - Math.min(...v);
  if (spread(d) > 2 || spread(lo) <= 1) return rect;
  const depth = Math.max(...d);   // the most: a curve drawn by chords sags a part of a mm here and there (NECL WEB-1 2149.3 to 2150.4)
  // its long edges developed: the bottom one runs +x, the top one -x (counter-clockwise)
  let bottom = 0; let top = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i]; const b = P[(i + 1) % P.length]; const ex = b[0] - a[0]; const ey = b[1] - a[1];
    if (Math.abs(ex) >= Math.abs(ey)) { if (ex > 0) bottom += Math.hypot(ex, ey); else top += Math.hypot(ex, ey); }
  }
  // ends square to the strip (edges within 1 % of each other): the bottom edge; ends cut on a skew: the longer edge
  const along = Math.abs(top - bottom) <= 0.01 * Math.max(top, bottom) ? bottom : Math.max(top, bottom);
  return { kind: 'band', widthMm: Math.round(depth), lengthMm: r1(along), blank };
}
