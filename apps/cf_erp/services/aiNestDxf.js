/**
 * aiNestDxf.js — CF_ERP. One nested plate as a DXF that ProNest opens (2026-10-18, "AI" nesting).
 *
 *   aiPlanToDxf({ lot, plan, leads?, order? }) → string
 *
 * DXF R12 (AC1009), ASCII, millimetres ($INSUNITS 4, $MEASUREMENT 1), origin at the plate's lower-left
 * corner, x along the plate's length. One file per plate. Every contour is a CLOSED POLYLINE (70 = 1)
 * at the part's TRUE size — kerf compensation is the cutting software's job (the plan says which side).
 *
 *   PLATE     the plate boundary
 *   OUTLINES  every part's outline, clockwise — a part of a shared-line block too (ProNest makes its own
 *             common-line paths from parts exactly one kerf apart)
 *   HOLES     cut-outs and holes, counter-clockwise
 *   MARKING   the part CODE as single-stroke text (style SIMPLEX, font simplex.shx) — written before
 *             the part's holes and outline, as it is cut
 *   LEADS     (leads: true) lead-ins and lead-outs as open polylines, and a POINT at every pierce
 *   CUT_ORDER (order: true) the step number at every pierce
 * Entities come in the plan's cut order. No title or note outside the plate: a stray text would be
 * read as something to cut by some programs. Our own reader (lib/nestDxfReader.readNestDxf) reads the
 * file back to the same plate, parts and codes (scripts/cf_kepl/nesting_learnings_test.mjs).
 */
const LAYERS = [
  { name: 'PLATE', color: 7 },
  { name: 'OUTLINES', color: 3 },
  { name: 'HOLES', color: 4 },
  { name: 'MARKING', color: 2 },
];
const LEAD_LAYERS = [{ name: 'LEADS', color: 1 }];
const ORDER_LAYERS = [{ name: 'CUT_ORDER', color: 6 }];

const num = (v) => {
  const s = (Math.round(Number(v) * 1000) / 1000).toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
};
const txt = (s) => String(s ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '').trim();

export function aiPlanToDxf({ lot = {}, plan, leads = false, order = false } = {}) {
  if (!plan?.plate) throw new TypeError('aiPlanToDxf: a cut plan (aiCutPlan.planCuts) is needed');
  const L = Number(plan.plate.length); const W = Number(plan.plate.width);
  const out = [];
  const g = (code, value) => { out.push(String(code), String(value)); };
  const layers = [...LAYERS, ...(leads ? LEAD_LAYERS : []), ...(order ? ORDER_LAYERS : [])];

  g(999, txt(`CF_ERP AI nest ${lot.lotNo ?? lot.lot_no ?? ''} ${lot.plateCode ?? ''} ${lot.thickness != null ? `${num(lot.thickness)} mm` : ''} ${num(L)} x ${num(W)} mm`).slice(0, 250));
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(9, '$MEASUREMENT'); g(70, 1);
  g(9, '$EXTMIN'); g(10, 0); g(20, 0); g(30, 0);
  g(9, '$EXTMAX'); g(10, num(L)); g(20, num(W)); g(30, 0);
  g(9, '$LIMMIN'); g(10, 0); g(20, 0);
  g(9, '$LIMMAX'); g(10, num(L)); g(20, num(W));
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length + 1);
  for (const ly of [{ name: '0', color: 7 }, ...layers]) { g(0, 'LAYER'); g(2, ly.name); g(70, 0); g(62, ly.color); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'STYLE'); g(70, 1);
  g(0, 'STYLE'); g(2, 'SIMPLEX'); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 10); g(3, 'simplex.shx'); g(4, '');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'BLOCKS'); g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  const poly = (layer, pts, closed) => {
    const ring = closed && pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.slice(0, -1) : pts;
    if (ring.length < 2) return;
    g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, closed ? 1 : 0);
    for (const [x, y] of ring) { g(0, 'VERTEX'); g(8, layer); g(10, num(x)); g(20, num(y)); g(30, 0); }
    g(0, 'SEQEND'); g(8, layer);
  };
  const text = (layer, x, y, h, s, style = null) => {
    g(0, 'TEXT'); g(8, layer); g(10, num(x)); g(20, num(y)); g(30, 0); g(40, num(h)); g(1, s);
    if (style) g(7, style);
    g(72, 1); g(11, num(x)); g(21, num(y)); g(31, 0); g(73, 2);
  };
  const point = (layer, p) => { g(0, 'POINT'); g(8, layer); g(10, num(p[0])); g(20, num(p[1])); g(30, 0); };

  poly('PLATE', [[0, 0], [L, 0], [L, W], [0, W]], true);
  // A part of a block is cut in strokes; its full outline is written once, at its last stroke.
  const lastStroke = new Map();
  plan.steps.forEach((s, i) => { if (s.kind === 'stroke' || s.kind === 'freed') lastStroke.set(s.part, i); });
  const outlineOf = new Map();
  for (const s of plan.steps) if (s.kind === 'outline') outlineOf.set(s.part, s.path);
  plan.steps.forEach((s, i) => {
    if (s.kind === 'mark') { const c = txt(s.text); if (c) text('MARKING', s.at[0], s.at[1], s.heightMm, c, 'SIMPLEX'); return; }
    if (s.kind === 'hole') poly('HOLES', s.path, true);
    else if (s.kind === 'outline') poly('OUTLINES', s.path, true);
    else if ((s.kind === 'stroke' || s.kind === 'freed') && lastStroke.get(s.part) === i) {
      const ring = s.outline ?? plan.parts[s.part]?.outline ?? null;
      if (ring) poly('OUTLINES', ring, true);
    }
    if (leads && s.leadIn?.path) poly('LEADS', s.leadIn.path, false);
    if (leads && s.leadOut?.path) poly('LEADS', s.leadOut.path, false);
    if (leads && s.pierce) point('LEADS', s.pierce);
    if (leads && s.kind === 'stroke') poly('LEADS', s.path, false);
    if (order && s.pierce) text('CUT_ORDER', s.pierce[0], s.pierce[1], 8, String(s.n));
  });
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return `${out.join('\r\n')}\r\n`;
}
