/**
 * cf_bridge_data.mjs — the KEPL ROB 59.3 m BOQ, normalised into the shape
 * cf_erp needs. Pure data + derivation, no database access.
 *
 * Source: "BOQ OF 60MTR - 2 SPANS KEPL.pdf" (client KEPL, drawing
 * P103-VDB-WK-DD-MJB-200+003-401, dated 08-07-2026), decoded to boq.json.
 * Every weight in the document is reproduced exactly by
 * thickness x length x width x 7850 / 1e9, so nothing here is estimated.
 *
 * Two things the document does NOT say, declared here rather than guessed
 * silently — see ASSUMPTIONS below.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BOQ = JSON.parse(fs.readFileSync(path.join(HERE, 'boq.json'), 'utf8'));

export const ASSUMPTIONS = [
  'GRADE = E350 and IMPACT_CLASS = BO. The BOQ gives only density 7.85 and never states '
  + 'a grade, but both specs are required on a fabricated part. E350 BO is what their own '
  + 'plate catalog actually holds — 149 of 188 plates are E350, 162 of 188 are BO, and every '
  + 'thickness this girder needs (12, 16, 25, 28, 32, 40) exists in E350 BO. The earlier '
  + 'fab_erp build of this same bridge nested against the E350 BO catalog too. A bridge '
  + 'would often be specified BR (impact tested); if KEPL require BR, it is one value to change.',
  'The BOQ labels the 170-wide intermediate stiffener "Hole" in G2-2 and G2-5, and '
  + '"Plain" in the seventeen other places it appears; G2-5 also reverses G3-1, which is '
  + 'otherwise the identical segment. Taken literally that yields seven segment designs. '
  + 'This module ignores the label for that one part and lets the WIDTH decide — 178 drilled, '
  + '170 plain — which is the reading confirmed against this same BOQ in an earlier pass, and '
  + 'which yields FIVE designs matching the girder arrangement (G1 ends, G1/G4 middles, '
  + 'G2/G3 ends, G2/G3 middles, G4 ends). Weights are identical either way.',
];

export const GRADE = 'E350';
export const IMPACT_CLASS = 'BO';
export const DENSITY = 7850;          // kg/m3
export const UNIT_KG = 7.85e-6;       // kg per mm3, = DENSITY / 1e9

// --- part function -----------------------------------------------------------
// A part's identity is what it does plus its size — never its drawing mark,
// which is positional (the same 12x2995x170 stiffener is IS1 in one girder and
// IS2 in the next).
const FUNCTIONS = [
  [/^Top Flange$/, 'TOP_FLANGE', 'TF', 'Top flange'],
  [/^Web$/, 'WEB', 'WB', 'Web'],
  [/^Bottom Flange$/, 'BOTTOM_FLANGE', 'BF', 'Bottom flange'],
  [/^Bearing Stiffener/, 'BEARING_STIFFENER', 'BS', 'Bearing stiffener'],
  [/^End Stiffener/, 'END_STIFFENER', 'ES', 'End stiffener'],
  [/^Intermediate Stiffener/i, 'INTERMEDIATE_STIFFENER', 'IS', 'Intermediate stiffener'],
  [/^End Diaphragm Top Flange/, 'DIAPHRAGM_TOP_FLANGE', 'DTF', 'Diaphragm top flange'],
  [/^Inter\. Diaph\. Top Flange/, 'DIAPHRAGM_TOP_FLANGE', 'DTF', 'Diaphragm top flange'],
  [/^End Diaphragm Web/, 'DIAPHRAGM_WEB', 'DWB', 'Diaphragm web'],
  [/^Inter\. Diaph\. Web/, 'DIAPHRAGM_WEB', 'DWB', 'Diaphragm web'],
  [/^End Diaphragm Bottom Flange/, 'DIAPHRAGM_BOTTOM_FLANGE', 'DBF', 'Diaphragm bottom flange'],
  [/^Inter\. Diaph\. Bottom Flange/, 'DIAPHRAGM_BOTTOM_FLANGE', 'DBF', 'Diaphragm bottom flange'],
  [/^Jacking Stiffener/, 'JACKING_STIFFENER', 'JS', 'Jacking stiffener'],
  [/^Pad Plate/, 'PAD_PLATE', 'PP', 'Pad plate'],
  [/Cover Plate/, 'COVER_PLATE', 'CP', 'Cover plate'],
  [/^Inner (Side|Flange|Corner) Plate/, 'SPLICE_PLATE', 'SP', 'Splice plate'],
];

export const PART_FUNCTION_OPTIONS = [...new Map(
  FUNCTIONS.map(([, value, , label]) => [value, { value, label }]),
).values()];

export function functionOf(name) {
  const hit = FUNCTIONS.find(([re]) => re.test(name));
  if (!hit) throw new Error(`No part function for BOQ name "${name}" — add it to FUNCTIONS.`);
  return { fn: hit[1], short: hit[2], label: hit[3] };
}
/**
 * The BOQ says Plain or Hole only where it matters; elsewhere the part has no
 * such variant.
 *
 * EXCEPT for the intermediate stiffener, where the label disagrees with itself:
 * G2-2 and G2-5 call the 170-wide one "Hole" where the seventeen other places it
 * appears call it "Plain", and G2-5 reverses G3-1, which is otherwise the
 * identical segment. Across the document the WIDTH pairs with the drilling every
 * time — a drilled stiffener is made wider to keep edge distance — and that
 * reading was confirmed against this same BOQ in an earlier pass. So for an
 * intermediate stiffener the width decides and the label is ignored: 178 drilled,
 * 170 plain. Applying it collapses seven apparent segment designs into five,
 * which is what the girder arrangement (G1, G2=G3, G4) actually implies.
 */
export function holedOf(name, part) {
  if (part && /^Intermediate Stiffener/i.test(name)) return part.wid >= 178;
  return /Hole/i.test(name) ? true : /Plain/i.test(name) ? false : null;
}

export const unitKg = (p) => Number((p.thk * p.len * p.wid * UNIT_KG).toFixed(3));
export const partKey = (p) => {
  const { fn } = functionOf(p.name);
  return [fn, holedOf(p.name, p), p.thk, p.len, p.wid].join('|');
};

// --- the distinct parts ------------------------------------------------------
/** Every catalog part the job needs, keyed by function + holed + size. */
export const PARTS = (() => {
  const out = new Map();
  const add = (p) => {
    const key = partKey(p);
    if (out.has(key)) return out.get(key);
    const { fn, short, label } = functionOf(p.name);
    const holed = holedOf(p.name, p);
    const rec = {
      key, fn, short, holed, thk: p.thk, len: p.len, wid: p.wid,
      // A holed part gets its own short name, so the generated code tells the two
      // apart: IS-12X2995X170-E350 is plain, ISH-12X2995X170-E350 is drilled.
      shortName: short + (holed === true ? "H" : ""),
      unitKg: unitKg(p),
      name: `${label}${holed === null ? '' : holed ? ' holed' : ' plain'} `
        + `${p.thk} x ${p.len} x ${p.wid} ${GRADE}`,
    };
    out.set(key, rec);
    return rec;
  };
  for (const g of BOQ.girders) for (const p of g.parts) add(p);
  for (const s of BOQ.subAssemblies) for (const p of s.parts) add(p);
  return out;
})();

/** Roll a BOQ part list up into { partKey, quantity } lines, merging repeats. */
function linesOf(parts) {
  const m = new Map();
  for (const p of parts) m.set(partKey(p), (m.get(partKey(p)) ?? 0) + p.qty);
  return [...m].map(([key, quantity]) => ({ key, quantity }));
}

// --- girder segment designs --------------------------------------------------
/** Two girders with the same parts in the same counts are one design, whatever
 *  their marks. Seven designs cover the twenty positions in a span. */
export const SEGMENT_SHORT = "GS";
export const SEGMENTS = (() => {
  const byShape = new Map();
  for (const g of BOQ.girders) {
    const shape = linesOf(g.parts).map((l) => `${l.key}#${l.quantity}`).sort().join(',');
    if (!byShape.has(shape)) byShape.set(shape, { lines: linesOf(g.parts), marks: [], grossKg: g.grossKg });
    byShape.get(shape).marks.push(g.mark);
  }
  return [...byShape.values()].map((d, i) => ({
    ref: `GS-${String(i + 1).padStart(3, '0')}`,
    name: `Girder segment ${d.marks[0]} (ROB 59.3 m)`,
    description: `Used at ${d.marks.join(', ')}. ${d.grossKg.toFixed(2)} kg each, per the BOQ.`,
    ...d,
  }));
})();

export const SEGMENT_BY_MARK = new Map(SEGMENTS.flatMap((s) => s.marks.map((m) => [m, s])));

// --- sub-assemblies ----------------------------------------------------------
export const SUBS = BOQ.subAssemblies.map((s) => ({
  ref: s.mark,
  name: `${s.name} (ROB 59.3 m)`,
  short: { 'END-DIA': 'EDIA', 'INT-DIA': 'IDIA', SPLICE: 'SPLC' }[s.mark],
  perSpan: s.qty,
  unitKg: s.unitKg,
  lines: linesOf(s.parts),
}));

export const STUD = {
  ref: 'STUD', short: 'STUD', name: 'Shear stud 25 dia x 175',
  unitKg: BOQ.studs.unitKg, perGirderLine: BOQ.studs.qtyPerLine,
};

// --- the structure -----------------------------------------------------------
/** A girder line is five segments end to end, so four splice joints, plus the
 *  studs welded along its top flange. */
export const SEGMENTS_PER_LINE = 5;
export const SPLICES_PER_LINE = SEGMENTS_PER_LINE - 1;
export const GIRDER_LINES = ['G1', 'G2', 'G3', 'G4'];
export const LINE_LAYOUT = GIRDER_LINES.map((g) => ({
  line: g,
  segments: Array.from({ length: SEGMENTS_PER_LINE }, (_, i) => {
    const mark = `${g}-${i + 1}`;
    return { position: i + 1, mark, design: SEGMENT_BY_MARK.get(mark).ref };
  }),
}));

export const SPAN = {
  ref: 'SPAN', short: 'SPAN', name: 'ROB span 59.3 m, 4 girder lines (17 deg skew)',
  spanLengthMm: 59300, skewDeg: 17, girderLines: GIRDER_LINES.length,
  endDiaphragms: SUBS.find((s) => s.ref === 'END-DIA').perSpan,
  interDiaphragms: SUBS.find((s) => s.ref === 'INT-DIA').perSpan,
};
export const ORDER_SPANS = BOQ.check.spans;
