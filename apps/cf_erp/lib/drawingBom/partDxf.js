// Write one part as an ASCII DXF (mm, 1:1, origin at the lower-left, length along X).
// Layers: OUTLINE (closed LWPOLYLINE with bulges), CUTOUT (closed LWPOLYLINE), HOLES (CIRCLE).
const f = (n) => { const s = (Math.round(n * 1e4) / 1e4).toFixed(4).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };

export function partDxf({ outline, cutouts = [], holes = [], comments = [] }) {
  const L = [];
  const P = (c, v) => { L.push(String(c), String(v)); };
  for (const c of comments) P(999, String(c).replace(/[\r\n]+/g, ' ').slice(0, 250));
  P(0, 'SECTION'); P(2, 'HEADER'); P(9, '$INSUNITS'); P(70, 4); P(0, 'ENDSEC');
  P(0, 'SECTION'); P(2, 'TABLES');
  P(0, 'TABLE'); P(2, 'LAYER'); P(70, 3);
  for (const [name, col] of [['OUTLINE', 7], ['CUTOUT', 1], ['HOLES', 3]]) { P(0, 'LAYER'); P(2, name); P(70, 0); P(62, col); P(6, 'CONTINUOUS'); }
  P(0, 'ENDTAB'); P(0, 'ENDSEC');
  P(0, 'SECTION'); P(2, 'ENTITIES');
  const poly = (ring, layer) => {
    P(0, 'LWPOLYLINE'); P(8, layer); P(90, ring.length); P(70, 1);
    for (const p of ring) { P(10, f(p.x)); P(20, f(p.y)); if (p.bulge) P(42, Math.round(p.bulge * 1e8) / 1e8); }
  };
  poly(outline, 'OUTLINE');
  for (const c of cutouts) poly(c, 'CUTOUT');
  for (const h of holes) { P(0, 'CIRCLE'); P(8, 'HOLES'); P(10, f(h.x)); P(20, f(h.y)); P(30, 0); P(40, f(h.r)); }
  P(0, 'ENDSEC'); P(0, 'EOF');
  return L.join('\n') + '\n';
}

/** Move/rotate/scale a part so its rectangle starts at (0,0) and its long side runs along X. */
export function normalisePart({ ring, cutouts = [], holes = [] }, box, scale = 1) {
  const rot = (box.y1 - box.y0) > (box.x1 - box.x0) + 1e-6; // drawn upright -> turn 90° clockwise
  const k = 1 / scale;
  // turning clockwise: (x, y) -> (y - y0, x1 - x)
  const tf = rot ? (x, y) => [(y - box.y0) * k, (box.x1 - x) * k] : (x, y) => [(x - box.x0) * k, (y - box.y0) * k];
  const R = (r) => r.map((p) => { const [x, y] = tf(p.x, p.y); return { x, y, bulge: p.bulge }; }); // rotation keeps orientation, so bulges keep sign
  return {
    outline: R(ring),
    cutouts: cutouts.map(R),
    holes: holes.map((h) => { const [x, y] = tf(h.x, h.y); return { x, y, r: h.r * k }; }),
    rotated: rot,
  };
}
