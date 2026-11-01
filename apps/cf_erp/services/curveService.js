/**
 * curveService.js — CF_ERP. An order line on a CURVED track (user, 2026-11-01: "in RDSO diagrams they would have given
 * you how to calculate for different angles … build the curve feature"; init.sql §98).
 *
 * The rule is the series' own (cf_standard_drawings.curve_json, from drawing_bom src/rdso/curveMeta.mjs — the X-frame
 * sheet's note 4 and 5): the girders are laid on CHORDS of the curved alignment so the track's eccentricity on the deck
 * is the same at the centre and the ends; the design takes a maximum eccentricity for curvature at the series' maximum
 * degree, the 100 mm standard eccentricity on top; the deck slab may be trapezoidal at the outer side between spans.
 * The STEEL does not change for any curve up to that degree — what changes is the layout, worked out here:
 *
 *   R (m)                   = 15.25 / sin(D/2)            Indian Railways' degree of curve: D° on a 30.5 m chord
 *   eccentricity for curve  = e_max × D / D_max           the design value scales with 1/R (∝ D)
 *   total eccentricity      = that + the standard 100 mm  (the figure to set the track to on the deck)
 *   half-versine (check)    = L² / (16 R)                 the chord's mid-ordinate halved — what laying on chords gives
 *   angle between spans     = 2 · asin(L / 2R)            each span a chord of the curve, L its overall length
 *   outer-gap opening       = girder spacing × that angle the gap at the outer girders' ends is this much wider
 * A curve beyond the series' maximum is refused (the series does not apply); a series that states no curve is straight
 * only; a standard with no rule says so. Pure maths in `curveOf` (tested directly); the service reads and saves.
 */
import { invalid, notFound } from '../lib/errors.js';

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;

/** The rule as stored (JSON text or object) → object | null. */
export function curveRuleOf(v) {
  let o = v;
  if (o == null) return null;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
  return o && typeof o === 'object' ? o : null;
}

/**
 * The layout of `spans` spans on a curve of D degrees under `rule`. → { available, deg, maxDeg, results | null,
 * problems: [sentences], note }. PURE.
 */
export function curveOf(rule, D, { spans = 1 } = {}) {
  const out = { available: false, deg: D == null ? null : Number(D), maxDeg: null, results: null, problems: [], note: null, rule: rule ?? null };
  if (!rule) { out.note = 'The standard this line comes from does not say which curves it is designed for.'; return out; }
  out.maxDeg = Number(rule.maxDeg) || 0;
  if (!out.maxDeg) { out.note = rule.note ?? 'This series is for a straight alignment only.'; if (D > 0) out.problems.push(`This series is for a straight alignment only — a ${D}° curve is outside it.`); return out; }
  out.available = true;
  if (D == null || !(Number(D) > 0)) { out.note = `Designed for curves up to ${out.maxDeg}°. Straight, as set.`; return out; }
  const d = Number(D);
  if (d > out.maxDeg + 1e-9) {
    out.problems.push(`This series is designed for curves up to ${out.maxDeg}°; a ${d}° curve is outside it — the design has to be checked by the designer.`);
  }
  const R = 15.25 / Math.sin(rad(d / 2));
  const L = (Number(rule.overallMm) || 0) / 1000;
  const s = Number(rule.girderSpacingMm) || 0;
  const eCurve = (Number(rule.eccentricityAtMaxMm) || 0) * (d / out.maxDeg);
  const theta = L > 0 ? 2 * Math.asin(Math.min(1, L / (2 * R))) : 0;
  out.results = {
    radiusM: r1(R),
    eccentricityCurveMm: r1(eCurve),
    standardEccentricityMm: Number(rule.standardEccentricityMm) || 0,
    eccentricityTotalMm: r1(eCurve + (Number(rule.standardEccentricityMm) || 0)),
    halfVersineMm: L > 0 ? r1(((L * L) / (16 * R)) * 1000) : null,
    angleBetweenSpansDeg: r3(deg(theta)),
    outerGapOpeningMm: s ? r1(s * theta) : null,
    spans,
    turnDeg: r3(deg(theta) * Math.max(0, spans - 1)),
  };
  return out;
}

/**
 * The plan of the spans on the curve as SVG (offsets exaggerated so they show): the track's arc, each span a chord with
 * its girders, the eccentricity at the centre and the ends, the gap opening at the outer side. PURE.
 */
export function curveSvg(c, rule) {
  const res = c.results; if (!res || !rule) return null;
  const n = Math.max(1, Math.min(6, res.spans || 1));
  const L = Number(rule.overallMm); const R = res.radiusM * 1000; const sp = Number(rule.girderSpacingMm) || 2400;
  if (!(L > 0 && R > 0)) return null;
  const step = 2 * Math.asin(Math.min(1, L / (2 * R)));
  const half = (n * step) / 2;
  // True geometry (mm, centre of the curve at the origin) drawn with the distance OFF the track's arc exaggerated, so
  // a 100 mm eccentricity on a 437 m radius shows: a point at angle a, radius r is drawn at angle a, R + EX·(r − R),
  // and the angle is opened out so the run is about four times as long as it is deep.
  // Opened angle: the run's sag drawn about a sixth of its length (true sag (nL)²/8R is far too flat to see).
  const run = n * L; const sagTrue = (run * run) / (8 * R);
  const A = Math.max(1, Math.sqrt((run / 6) / sagTrue));
  // Offsets off the arc: the girder spacing drawn about a twelfth of the (opened) run.
  const EX = Math.max(1, (A * run) / 12 / sp);
  const draw = (a, r) => { const rr = R + EX * (r - R); const aa = a * A; return [rr * Math.sin(aa), -rr * Math.cos(aa)]; };
  const polar = ([x, y]) => [Math.atan2(x, y), Math.hypot(x, y)];
  const P = (a, r) => [r * Math.sin(a), r * Math.cos(a)];
  const shift = res.halfVersineMm ?? 0;                // the span's centreline set out so the track deviates ± half-versine
  const segs = []; const xs = []; const ys = [];
  const path = (pts, attrs) => { const d = pts.map(([a, r]) => draw(a, r)); for (const [x, y] of d) { xs.push(x); ys.push(y); } segs.push(`<polyline points="${d.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" ${attrs}/>`); };
  for (let k = 0; k < n; k++) {
    const a0 = -half + k * step; const a1 = a0 + step;
    for (const off of [-sp / 2, sp / 2]) {
      // A girder: the chord at the span's ends, set out by `shift` from the arc and ± half the girder spacing.
      const e0 = P(a0, R + shift + off); const e1 = P(a1, R + shift + off);
      const pts = []; for (let i = 0; i <= 20; i++) { const t = i / 20; pts.push(polar([e0[0] + (e1[0] - e0[0]) * t, e0[1] + (e1[1] - e0[1]) * t])); }
      path(pts, 'stroke="#2563eb" stroke-width="LW2"');
    }
  }
  const arc = []; for (let i = 0; i <= 80; i++) arc.push([-half + (2 * half * i) / 80, R]);
  path(arc, 'stroke="#dc2626" stroke-width="LW1" stroke-dasharray="DASH"');
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const W0 = maxX - minX; const pad = W0 * 0.04; const W = W0 + 2 * pad; const H = maxY - minY + 2 * pad; const lw = W / 500;
  const t = (x, y, s, anchor = 'middle') => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${(W / 60).toFixed(1)}" text-anchor="${anchor}" fill="#334155" font-family="sans-serif">${s}</text>`;
  const notes = [t(minX, maxY + pad * 0.8, `Track centre (red, dashed) · girders on chords (blue) · offsets from the arc drawn ${Math.round(EX)}× · ${n} span${n === 1 ? '' : 's'}, ${res.angleBetweenSpansDeg}° between spans`, 'start')];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${Math.round((1200 * (H + pad)) / W)}" viewBox="${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${W.toFixed(1)} ${(H + pad).toFixed(1)}" preserveAspectRatio="xMidYMid meet">`
    + segs.join('').replace(/LW2/g, (lw * 1.8).toFixed(2)).replace(/LW1/g, (lw * 1.2).toFixed(2)).replace(/DASH/g, `${(lw * 8).toFixed(1)} ${(lw * 5).toFixed(1)}`)
    + notes.join('') + `</svg>`;
}

/** GET /order-lines/:id/curve — the line's curve, its rule and the layout. */
export async function lineCurve(db, companyId, lineId) {
  const [[line]] = await db.query(
    `SELECT l.id, l.order_id, l.quantity, l.curve_deg, l.standard_id, s.number AS standard_number, s.curve_json
       FROM cf_sales_order_lines l LEFT JOIN cf_standard_drawings s ON s.id = l.standard_id AND s.company_id = l.company_id
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [companyId, Number(lineId)],
  );
  if (!line) throw notFound('Order line');
  const rule = curveRuleOf(line.curve_json);
  const D = line.curve_deg == null ? null : Number(line.curve_deg);
  const c = curveOf(rule, D, { spans: Math.max(1, Math.round(Number(line.quantity) || 1)) });
  return { lineId: Number(line.id), orderId: Number(line.order_id), standard: line.standard_id ? { id: Number(line.standard_id), number: line.standard_number } : null, ...c, svg: curveSvg(c, rule) };
}

/** PUT /order-lines/:id/curve { deg } — the site's degree of curve (null / 0 = straight). Refused beyond the series. */
export async function setLineCurve(db, c, lineId, input = {}) {
  const [[line]] = await db.query(
    `SELECT l.id, o.status AS order_status, s.curve_json FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id
       LEFT JOIN cf_standard_drawings s ON s.id = l.standard_id AND s.company_id = l.company_id
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL FOR UPDATE`,
    [c.companyId, Number(lineId)],
  );
  if (!line) throw notFound('Order line');
  if (['closed', 'cancelled', 'revised', 'lost'].includes(line.order_status)) throw invalid('ORDER_CLOSED', `The order is ${line.order_status} — its lines cannot change.`);
  const raw = input.deg;
  const D = raw == null || raw === '' ? null : Number(raw);
  if (D != null && (!Number.isFinite(D) || D < 0 || D > 30)) throw invalid('INVALID', 'The curve is a number of degrees, 0 or more.');
  const check = curveOf(curveRuleOf(line.curve_json), D);
  if (check.problems.length) throw invalid('OUT_OF_SERIES', check.problems[0], { problems: check.problems });
  await db.query('UPDATE cf_sales_order_lines SET curve_deg = ? WHERE company_id = ? AND id = ?', [D == null || D === 0 ? null : D, c.companyId, line.id]);
  return lineCurve(db, c.companyId, line.id);
}
