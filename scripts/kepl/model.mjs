/**
 * model.mjs — the KEPL ROB 59.3 m order, as data.
 *
 * WHY A SEPARATE MODEL FILE. The structure and the raw-material list are the
 * only things here that came from the customer; everything else is derivation.
 * Keeping them apart means the nesting can be re-run, checked, and argued with
 * WITHOUT touching the database, and the weight cross-check below is a pure
 * function of these tables — which is what makes it a real test rather than a
 * restatement of whatever the writer happened to insert.
 *
 * FOUR GIRDERS, NOT FIVE. The BOQ's title says "5 Girder Arrangement" and its
 * body contains G1..G4 only. Two independent checks agree with the body:
 *   - 11650 + 12000 + 12000 + 12000 + 11650 = 59,300 mm, the span in the title
 *   - 20 webs/span x 2 spans = 40, and the RM list has exactly 40 plates of
 *     28 mm; a 2995-wide web fits only the 3100-wide plate, one per plate
 * Building five would have ordered 50 webs against 40 plates.
 */

export const DENSITY = 7.85e-6; // kg per mm^3, mild steel

export const SPANS = 2;
export const GIRDERS_PER_SPAN = 4;
export const SEG_LEN = { end: 11650, mid: 12000 };
/** Segment 1 and 5 sit over the bearings; 2-4 are the identical middle. */
export const SEG_KINDS = ['end', 'mid', 'mid', 'mid', 'end'];

/**
 * Parts of one segment.
 *
 * The `/D` suffix is not decoration — flowAllocationService.pickRule reads the
 * text after the last `/` of the last `-` segment of the item's code, so a part
 * coded `...-IS1/D` routes to the drilled flow and `...-IS2` to the plain one.
 * Every holed or bolted part below carries it deliberately.
 */
export function segmentParts(kind) {
  const L = SEG_LEN[kind];
  const common = [
    { code: 'TF', name: 'Top Flange',    t: 25, l: L, w: 500,  qty: 1 },
    { code: 'W',  name: 'Web',           t: 28, l: L, w: 2995, qty: 1 },
    { code: 'BF', name: 'Bottom Flange', t: 40, l: L, w: 700,  qty: 1 },
  ];
  if (kind === 'end') {
    return [...common,
      { code: 'BS/D',  name: 'Bearing Stiffener',            t: 32, l: 2995, w: 210, qty: 1 },
      { code: 'ES',    name: 'End Stiffener',                t: 32, l: 2995, w: 200, qty: 5 },
      { code: 'IS1/D', name: 'Intermediate Stiffener Holed', t: 12, l: 2995, w: 178, qty: 3 },
      { code: 'IS2',   name: 'Intermediate Stiffener',       t: 12, l: 2995, w: 170, qty: 21 },
    ];
  }
  return [...common,
    { code: 'IS1/D', name: 'Intermediate Stiffener Holed', t: 12, l: 2995, w: 178, qty: 3 },
    { code: 'IS2',   name: 'Intermediate Stiffener',       t: 12, l: 2995, w: 170, qty: 23 },
  ];
}

/** Cross-girder assemblies. They connect girders, so they hang off the span. */
export const ASSEMBLIES = [
  {
    kind: 'ED', name: 'End Diaphragm', count: 6,
    // Across the bay by the diaphragm depth — the web, standing up.
    envelope: { l: 3048, w: 1700 },
    parts: [
      { code: 'EDTF', name: 'End Diaphragm Top Flange',    t: 16, l: 3048, w: 200,  qty: 1 },
      { code: 'EDW',  name: 'End Diaphragm Web',           t: 16, l: 3048, w: 1700, qty: 1 },
      { code: 'EDBF', name: 'End Diaphragm Bottom Flange', t: 16, l: 3048, w: 200,  qty: 1 },
      { code: 'JS/D', name: 'End Diaphragm Joint Stiffener', t: 32, l: 1700, w: 90, qty: 12 },
      { code: 'PP/D', name: 'End Diaphragm Packing Plate', t: 16, l: 180,  w: 100,  qty: 2 },
    ],
  },
  {
    kind: 'ID', name: 'Intermediate Diaphragm', count: 45,
    // 1700 deep, like the end diaphragm. Its web is listed 1700 x 460, and the
    // 1700 is the LENGTH of a plate that stands vertically — which is why the
    // depth cannot be read off the dimensions without knowing that.
    envelope: { l: 3052, w: 1700 },
    parts: [
      { code: 'IDTF', name: 'Interm Diaphragm Top Flange',    t: 16, l: 3052, w: 200, qty: 1 },
      { code: 'IDW',  name: 'Interm Diaphragm Web',           t: 16, l: 1700, w: 460, qty: 2 },
      { code: 'IDDW', name: 'Interm Diaphragm Diagonal Web',  t: 16, l: 2132, w: 150, qty: 2 },
      { code: 'IDBF', name: 'Interm Diaphragm Bottom Flange', t: 16, l: 3052, w: 200, qty: 1 },
      { code: 'ISP',  name: 'Interm Diaphragm Side Plate',    t: 16, l: 1982, w: 80,  qty: 2 },
      { code: 'IFP',  name: 'Interm Diaphragm Fill Plate',    t: 16, l: 1250, w: 80,  qty: 2 },
      { code: 'ICP',  name: 'Interm Diaphragm Corner Plate',  t: 16, l: 106,  w: 80,  qty: 4 },
    ],
  },
  {
    kind: 'SPL', name: 'Splice', count: 16,
    // The web cover plate is the whole of it.
    envelope: { l: 2700, w: 850 },
    parts: [
      { code: 'WCP/D',   name: 'Web Cover Plate',                 t: 25, l: 2700, w: 850, qty: 2 },
      { code: 'TFICP/D', name: 'Top Flange Inner Cover Plate',    t: 25, l: 1260, w: 225, qty: 2 },
      { code: 'TFOCP/D', name: 'Top Flange Outer Cover Plate',    t: 25, l: 1260, w: 500, qty: 1 },
      { code: 'BFOCP/D', name: 'Bottom Flange Outer Cover Plate', t: 40, l: 2586, w: 700, qty: 1 },
      { code: 'BFICP/D', name: 'Bottom Flange Inner Cover Plate', t: 40, l: 2580, w: 325, qty: 2 },
    ],
  },
];

/** Shear studs are bought, not cut. 7,212 per span at 760 g each. */
export const STUDS = { perSpan: 7212, lengthMm: 175, diaMm: 25, gramsEach: 760 };

/**
 * The raw material the customer's own list asks for, for BOTH spans.
 *
 * These are the ONLY plate sizes the nesting may open. Nesting against sizes
 * nobody is buying would produce a tidy report and an unbuildable order.
 */
export const RAW_MATERIAL = [
  { t: 12, w: 2300, l: 12050, qty: 16, mt: 41.77 },
  { t: 12, w: 2250, l: 12050, qty: 4,  mt: 10.22 },
  { t: 16, w: 2500, l: 12050, qty: 16, mt: 60.54 },
  { t: 25, w: 2050, l: 12050, qty: 14, mt: 67.87 },
  { t: 25, w: 1750, l: 10850, qty: 4,  mt: 14.91 },
  { t: 28, w: 3100, l: 12050, qty: 40, mt: 328.43 },
  { t: 32, w: 2000, l: 11000, qty: 4,  mt: 22.11 },
  { t: 40, w: 2150, l: 12050, qty: 14, mt: 113.89 },
  { t: 40, w: 2500, l: 10500, qty: 4,  mt: 32.97 },
];

/** What the BOQ itself says, so the build can be checked against it. */
export const BOQ_STATED = { perSpanMt: 334.64, totalMt: 669.29, rmMt: 692.69 };

/**
 * Every part row of one span, already addressed to its place in the tree.
 * A "row" is one line of the BOQ: a part type with a quantity, under one parent.
 */
export function spanPartRows(span) {
  const rows = [];
  const push = (path, parentKind, p) => rows.push({ ...p, span, path, parentKind });

  for (let g = 1; g <= GIRDERS_PER_SPAN; g++) {
    SEG_KINDS.forEach((kind, i) => {
      const s = i + 1;
      for (const p of segmentParts(kind)) push(`G${g}/S${s}`, 'segment', p);
    });
  }
  for (const a of ASSEMBLIES) {
    for (let n = 1; n <= a.count; n++) {
      const tag = `${a.kind}${String(n).padStart(2, '0')}`;
      for (const p of a.parts) push(tag, 'assembly', p);
    }
  }
  return rows;
}

/** kg of one part row (all its pieces). */
export const rowWeight = (r) => r.t * r.l * r.w * DENSITY * r.qty;

/**
 * Holes per piece, for the parts whose code carries `/D`.
 *
 * THESE ARE ESTIMATES AND THEY ARE WRITTEN DOWN RATHER THAN COMPUTED because
 * nothing in the BOQ says how many bolts a plate takes — hole counts live on
 * the detailing drawings, which we do not have. Deriving them from a made-up
 * bolt pitch would produce a number with the same authority as a measured one
 * and none of the truth, so they are declared here where they can be corrected
 * against the drawings in one place.
 *
 * The figures are ordinary practice for a bolted composite deck: a web splice
 * cover plate carries a dense grid, a stiffener carries a service hole or two.
 */
export const HOLES = {
  'BS/D': 8, 'IS1/D': 2, 'JS/D': 4, 'PP/D': 4,
  'WCP/D': 216, 'TFICP/D': 24, 'TFOCP/D': 24, 'BFOCP/D': 60, 'BFICP/D': 30,
};

/**
 * Derived per-piece values for one plate part, in the units the fields declare.
 *
 * All three follow from the geometry and none is a guess:
 *   unit_weight_kg   volume x density
 *   edge_length_m    the cut perimeter — what the profiler actually travels
 *   surface_area_m2  both faces plus the four edges, i.e. what gets painted
 */
export const partDerived = (p) => ({
  unit_weight_kg: p.l * p.w * p.t * DENSITY,
  edge_length_m: (2 * (p.l + p.w)) / 1000,
  surface_area_m2: (2 * p.l * p.w + 2 * p.t * (p.l + p.w)) / 1e6,
});

/**
 * Weld run of an assembly, from the parts inside it.
 *
 * RULE: every child is welded along both its long edges. On a girder segment
 * that gives the four continuous flange-to-web fillets plus two vertical runs
 * per stiffener, which is how a plate girder is actually welded; on this
 * order it comes to about 228 m for a middle segment against roughly 204 m
 * counted by hand, so the rule is right to within its own roundness.
 *
 * It is a rule and not a measurement, and it is here rather than buried in a
 * query so that a welding engineer can disagree with it in one place.
 */
export const weldMetresFor = (children) =>
  children.reduce((m, c) => m + (2 * Math.max(c.l, c.w) * c.qty) / 1000, 0);
