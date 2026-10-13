/**
 * nest_dxf_reader_test.mjs — reading a customer's nesting DXF and copying the whole nest
 * (lib/nestDxfReader.js, 2026-10-10). The files are written by lib/nestDxfFixtures.mjs, the way
 * different nesting programs write them. No database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_dxf_reader_test.mjs
 */
import { readNestDxf, matchNest, placeRings, ringsDeviation, rectRings } from '../../apps/cf_erp/lib/nestDxfReader.js';
import { nestToDxf } from '../../apps/cf_erp/services/nestGeometry.js';
import { makeNestDxf, girderShapes, candidateOf, shelfLayout, rectShape, entityCount, gridParts } from './lib/nestDxfFixtures.mjs';

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const section = (s) => console.log(`\n${s}`);
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e.code ?? `threw ${e.message}`; } };
const angleGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

const S = girderShapes();
const PLATE = { length: 12000, width: 2500 };
/** Candidates as the app holds them: rings read from each part's own drawing by partGeometry. */
const C = {
  flange: candidateOf(S.flange, { key: 'cp-flange', codes: ['G1-TF1', 'DRG-101'] }),
  web: candidateOf(S.web, { key: 'cp-web', codes: ['G1-WEB1'] }),
  gusset: candidateOf(S.gusset, { key: 'cp-gusset', codes: ['GP-7'] }),
  angle: candidateOf(S.angle, { key: 'cp-angle', codes: ['BKT 12'] }),
  stiffener: candidateOf(S.stiffener, { key: 'cp-stiff', codes: ['ST-3'] }),
  disc: candidateOf(S.disc, { key: 'cp-disc', codes: ['BP-1'] }),
  splice: candidateOf(S.splice, { key: 'cp-splice', codes: ['SP-2'] }),
  frame: candidateOf(S.frame, { key: 'cp-frame', codes: ['FR-1'] }),
  shim: candidateOf(S.shim, { key: 'cp-shim', codes: ['PK-9'], rings: false }),       // a cut plate with no drawing: size only
};
const CANDS = Object.values(C);
const LABEL = { flange: 'G1-TF1', web: 'g1 web1', gusset: 'GP-7', angle: 'BKT-12', stiffener: 'ST3', disc: 'BP-1', splice: 'SP-2', frame: 'FR-1', shim: 'PK-9' };

/** What the reader should report for a part placed at (angle, mirrored), given the shape's symmetry. */
function canonical(shape, rotationDeg, mirrored) {
  const { rot, mirror } = shape.symmetry;
  const step = rot === Infinity ? 0 : 360 / rot;
  const a = ((rotationDeg % 360) + 360) % 360;
  return { rotationDeg: step ? a % step : 0, mirrored: mirror ? false : mirrored };
}

/** The main nest: every girder shape, free angles, mirrored copies, a packer in the frame's window. */
function mainNest() {
  const items = [
    ['web', 0, false], ['web', 180, true], ['flange', 0, false],
    ['gusset', 37.5, false], ['gusset', 215, true], ['angle', 90, false], ['angle', 12.25, true], ['flange', 180, false],
    ['stiffener', 270, false], ['stiffener', 37.5, true], ['disc', 37.5, false],
    ['splice', 200, false], ['splice', 37.5, false], ['frame', 90, false], ['frame', 0, false], ['gusset', 0, false],
  ].map(([name, rotationDeg, mirrored]) => ({ name, shape: S[name], rotationDeg, mirrored, label: LABEL[name] }));
  const placed = shelfLayout(items, PLATE);
  // A packer in the window of the first frame (turned 90°: its window is 300 wide × 500 high, at +150/+150).
  const fr = placed.find((p) => p.name === 'frame' && p.rotationDeg === 90);
  placed.push({ name: 'shim', shape: S.shim, rotationDeg: 90, mirrored: false, label: LABEL.shim, x: fr.x + 150 + 60, y: fr.y + 150 + 100, inside: 'frame' });
  return placed;
}

/**
 * Reads a nest written in one style and checks every part came back as the right cut plate, in
 * the right place — and that re-placing the matched candidates reproduces the file.
 */
function roundTrip(title, parts, { style, options, by, plateFound = 'outline', candidates = CANDS, labels = true }) {
  section(title);
  const dxf = makeNestDxf({ plate: PLATE, parts: labels ? parts : parts.map((p) => ({ ...p, label: undefined })), style, options });
  const nest = readNestDxf(dxf);
  const m = matchNest(nest, candidates);
  // Where each part should be, in plate coordinates (the bounds of all parts when no plate is drawn).
  const want = parts.map((p) => {
    const cand = C[p.name];
    const canon = canonical(p.shape, p.rotationDeg, p.mirrored);
    const rings = cand.rings ?? rectRings(cand.length, cand.width);
    const drawn = placeRings(rings, { x: p.x, y: p.y, rotationDeg: p.rotationDeg, mirrored: p.mirrored });
    const xs = drawn[0].map((q) => q[0]); const ys = drawn[0].map((q) => q[1]);
    return { p, cand, canon, x: p.x, y: p.y, x1: Math.max(...xs), y1: Math.max(...ys) };
  });
  const off = plateFound === 'bounds' ? [Math.min(...want.map((w) => w.x)), Math.min(...want.map((w) => w.y))] : [0, 0];

  ok(`${nest.parts.length} parts read (${parts.length} drawn), the plate from its ${nest.plate.found}`, nest.parts.length === parts.length && nest.plate.found === plateFound, `${nest.parts.length} parts, ${nest.plate.found}; warnings: ${nest.warnings.join(' | ')}`);
  if (plateFound === 'outline') ok('the plate is 12000 × 2500', Math.abs(nest.plate.length - PLATE.length) < 0.01 && Math.abs(nest.plate.width - PLATE.width) < 0.01, `${nest.plate.length} × ${nest.plate.width}`);
  ok('nothing unmatched, nothing ambiguous', m.unmatched.length === 0 && m.ambiguous.length === 0, JSON.stringify({ u: m.unmatched.map((x) => [x.partId, x.why]), a: m.ambiguous.map((a) => [a.partId, a.candidateKeys]) }));

  let wrongKey = 0; let worstPos = 0; let worstRot = 0; let wrongHand = 0; let worstFit = 0; let missing = 0; const bys = new Set(); const notes = [];
  for (const w of want) {
    const pl = m.placements.find((q) => Math.abs(q.x - (w.x - off[0])) <= 1.5 && Math.abs(q.y - (w.y - off[1])) <= 1.5 && q.candidateKey === w.cand.key)
      ?? m.placements.find((q) => Math.abs(q.x - (w.x - off[0])) <= 1.5 && Math.abs(q.y - (w.y - off[1])) <= 1.5);
    if (!pl) { missing++; notes.push(`${w.p.name}@${w.p.rotationDeg} not placed at ${w.x},${w.y}`); continue; }
    if (pl.candidateKey !== w.cand.key) { wrongKey++; notes.push(`${w.p.name} read as ${pl.candidateKey}`); }
    worstPos = Math.max(worstPos, Math.abs(pl.x - (w.x - off[0])), Math.abs(pl.y - (w.y - off[1])));
    const gap = angleGap(pl.rotationDeg, w.canon.rotationDeg);
    if (gap > 0.05) notes.push(`${w.p.name}@${w.p.rotationDeg}${w.p.mirrored ? 'M' : ''} reported ${pl.rotationDeg}${pl.mirrored ? 'M' : ''}`);
    worstRot = Math.max(worstRot, gap);
    if (pl.mirrored !== w.canon.mirrored) { wrongHand++; notes.push(`${w.p.name}@${w.p.rotationDeg} hand ${pl.mirrored}`); }
    bys.add(pl.by);
    // THE PROOF: the candidate, re-placed by the convention, lands on the shape in the file.
    const part = nest.parts.find((q) => q.id === pl.partId);
    if (w.cand.rings) worstFit = Math.max(worstFit, ringsDeviation(placeRings(w.cand.rings, pl), part.rings));
    else worstFit = Math.max(worstFit, ringsDeviation(placeRings(rectRings(w.cand.length, w.cand.width), pl), [part.rings.outline]));
  }
  ok('every part is the right cut plate', missing === 0 && wrongKey === 0, notes.join('; '));
  ok(`positions within 0.5 mm (worst ${worstPos.toFixed(3)})`, missing === 0 && worstPos <= 0.5, notes.join('; '));
  ok(`rotations within 0.05° (worst ${worstRot.toFixed(4)}), free angles and symmetric shapes alike`, missing === 0 && worstRot <= 0.05, notes.join('; '));
  ok('mirrored parts reported mirrored, and only those', wrongHand === 0, notes.join('; '));
  ok(`re-placing every matched candidate lands on the file's shape within 0.5 mm (worst ${worstFit.toFixed(3)})`, missing === 0 && worstFit <= 0.5);
  if (by) ok(`matched by ${by.join(' / ')}`, [...bys].every((b) => by.includes(b)) && by.every((b) => bys.has(b)), [...bys].join(','));
  const n = (key) => want.filter((w) => w.cand.key === key).length;
  ok('counts per cut plate are right', CANDS.every((c) => (m.counts[c.key] ?? 0) === n(c.key)), JSON.stringify(m.counts));
  return { nest, m, dxf };
}

const MAIN = mainNest();

/* 1. closed polylines + text labels */
{
  const { nest } = roundTrip('1. polyline style — closed LWPOLYLINEs, CIRCLEs, a TEXT in each part', MAIN, { style: 'polyline', by: ['label'] });
  const splice = nest.parts.find((p) => p.labels.includes('SP-2'));
  ok('a splice plate keeps its 12 drilled holes', splice?.rings.holes.length === 12 && splice.rings.cutouts.length === 0);
  const web = nest.parts.find((p) => p.labels.includes('g1 web1'));
  ok('the web keeps its drain opening as a cut-out', web?.rings.cutouts.length === 1 && web.rings.holes.length === 0);
  const frame = nest.parts.find((p) => p.labels.includes('FR-1') && nest.parts.some((q) => q.within === p.id));
  const shim = nest.parts.find((p) => p.labels.includes('PK-9'));
  ok('the packer in the frame\'s window is its own part, not a hole of the frame', !!frame && shim?.within === frame.id && frame.rings.cutouts.length === 1 && frame.rings.holes.length === 0, JSON.stringify([frame?.id, shim?.within]));
  ok('units are mm and there are no warnings', nest.units === 'mm' && nest.warnings.length === 0, nest.warnings.join(' | '));
  ok('every text of the file is listed', nest.texts.length === MAIN.length);
}

/* 2. the same nest with no labels at all: shape and size alone */
roundTrip('2. polyline style, NO labels — matched by shape (and the drawing-less packer by size)', MAIN, { style: 'polyline', labels: false, by: ['shape', 'size'] });

/* 3. loose segments, no plate */
{
  const { nest } = roundTrip('3. segments style — loose LINEs and ARCs in no order, no plate outline', MAIN, { style: 'segments', by: ['label'], plateFound: 'bounds' });
  ok('it warns that the plate is only the rectangle round the parts', nest.warnings.some((w) => /does not draw the plate/.test(w)), nest.warnings.join(' | '));
}
roundTrip('3b. segments style, NO labels', MAIN, { style: 'segments', labels: false, by: ['shape', 'size'], plateFound: 'bounds' });

/* 4. blocks */
roundTrip('4. blocks style — every part an INSERT of a block named by its label (rotation, mirror)', MAIN, { style: 'blocks', by: ['label'] });
roundTrip('4b. blocks inside blocks — a wrapper block turned and mirrored round the shape\'s block', MAIN, { style: 'blocks', options: { nestedBlocks: true }, by: ['label'] });

/* 5. inches */
{
  const { nest } = roundTrip('5. inches style — drawn in inches ($INSUNITS 1)', MAIN, { style: 'inches', by: ['label'] });
  ok('units reported as in, sizes returned in mm', nest.units === 'in' && Math.abs(nest.plate.length - 12000) < 0.01);
}

/* 6. noisy */
{
  const { nest } = roundTrip('6. noisy style — offset origin, lead-ins, pierce marks, rapid moves, border, title block', MAIN, { style: 'noisy', by: ['label'] });
  ok('the plate\'s corner in the file is the offset origin', Math.abs(nest.plate.origin[0] - 1234.5) < 0.01 && Math.abs(nest.plate.origin[1] + 678.9) < 0.01, JSON.stringify(nest.plate.origin));
  ok('it warns about the strays it dropped', nest.warnings.some((w) => /do not close|does not close/.test(w)) && nest.warnings.some((w) => /pierce/.test(w)), nest.warnings.join(' | '));
  ok('hints from the title block: 16 mm, E350, 12000 x 2500, nest N12', nest.hints.thicknessMm === 16 && nest.hints.grade === 'E350' && nest.hints.nestNo === 'N12' && nest.hints.plateSize?.length === 12000 && nest.hints.plateSize?.width === 2500, JSON.stringify(nest.hints));
  ok('MTEXT formatting is stripped from labels', nest.parts.every((p) => p.labels.every((l) => !/[{}\\]/.test(l))), JSON.stringify(nest.parts.map((p) => p.labels)));
}
{
  const { nest } = roundTrip('6b. noisy + loose segments — lead-ins END ON the cut lines and rapids join the parts, all on a cut layer',
    MAIN, { style: 'noisy', options: { geom: 'segments', plate: 'segments', rapidLayer: 'TOOLPATH', shuffle: true }, by: ['label'] });
  ok('lead-ins and rapids are counted as strays', nest.warnings.some((w) => /not close into a shape/.test(w)), nest.warnings.join(' | '));
}

/* 7. common cut */
section('7. commoncut style — shared cuts drawn once, collinear cuts as one long line');
{
  const flg = candidateOf(rectShape(600, 300), { key: 'cp-a', codes: ['A-1'], rings: false });
  const pkg = candidateOf(rectShape(400, 200), { key: 'cp-b', codes: ['B-1'], rings: false });
  const cands = [flg, pkg, C.stiffener, C.gusset];
  const parts = [
    { rect: { length: 600, width: 300 }, x: 100, y: 100, label: 'A-1' },
    { rect: { length: 400, width: 200 }, x: 700, y: 100, label: 'B-1' },                    // shares part of A's right edge
    { rect: { length: 600, width: 300 }, x: 1100, y: 100, rotationDeg: 90, label: 'A-1' },   // A's twin turned 90°, sharing B's right edge
    { shape: S.stiffener, x: 1400, y: 100, label: 'ST-3' },                                  // shares the twin's right edge
    { shape: S.gusset, x: 100, y: 400, label: 'GP-7' },                                      // sits on A's top edge
  ];
  for (const labelled of [true, false]) {
    const dxf = makeNestDxf({ plate: { length: 3000, width: 1500 }, parts: labelled ? parts : parts.map((p) => ({ ...p, label: undefined })), style: 'commoncut' });
    const nest = readNestDxf(dxf);
    const m = matchNest(nest, cands);
    const tag = labelled ? 'labelled' : 'no labels';
    ok(`${tag}: 5 parts from ${entityCount(dxf)} entities (5 separate outlines would be 21 lines + the plate)`, nest.parts.length === 5 && nest.plate.found === 'outline', `${nest.parts.length}; ${nest.warnings.join(' | ')}`);
    const at = (x, y) => m.placements.find((p) => Math.abs(p.x - x) <= 0.5 && Math.abs(p.y - y) <= 0.5);
    ok(`${tag}: the rectangle is A at 0°`, at(100, 100)?.candidateKey === 'cp-a' && at(100, 100).rotationDeg === 0, JSON.stringify(at(100, 100)));
    ok(`${tag}: its twin is A at 90°`, at(1100, 100)?.candidateKey === 'cp-a' && at(1100, 100).rotationDeg === 90, JSON.stringify(at(1100, 100)));
    ok(`${tag}: B, the stiffener and the gusset are found`, at(700, 100)?.candidateKey === 'cp-b' && at(1400, 100)?.candidateKey === 'cp-stiff' && at(100, 400)?.candidateKey === 'cp-gusset', JSON.stringify(m.placements.map((p) => [p.candidateKey, p.x, p.y])));
    ok(`${tag}: counts A 2, B 1`, m.counts['cp-a'] === 2 && m.counts['cp-b'] === 1 && m.unmatched.length === 0 && m.ambiguous.length === 0, JSON.stringify([m.counts, m.unmatched, m.ambiguous]));
    const worst = Math.max(...m.placements.map((pl) => { const c = cands.find((k) => k.key === pl.candidateKey); const part = nest.parts.find((q) => q.id === pl.partId); return ringsDeviation(placeRings(c.rings ?? rectRings(c.length, c.width), pl), part.rings); }));
    ok(`${tag}: re-placed candidates land on the shapes (worst ${worst.toFixed(3)} mm)`, worst <= 0.5);
  }
}

/* 8. our own export */
section('8. our own nestToDxf export reads back');
{
  const flg = { key: 'cp-flg', codes: ['CP-0001'], rings: null, length: 600, width: 300 };
  const pieces = [
    { x: 10, y: 10, length: 600, width: 300, code: 'CP-0001' },
    { x: 620, y: 10, length: 300, width: 600, code: 'CP-0001' },                         // turned
    { x: 940, y: 10, length: C.gusset.length, width: C.gusset.width, code: 'GP-7', outline: placeRings(C.gusset.rings, { x: 940, y: 10 }) },
    { x: 1500, y: 10, length: C.splice.width, width: C.splice.length, code: 'SP-2', outline: placeRings(C.splice.rings, { x: 1500, y: 10, rotationDeg: 90 }) },
  ];
  const dxf = nestToDxf({ lot: { lotNo: 'N-007', plateCode: 'PL-12-E350', thickness: 12, grade: 'E350', length: 3000, width: 1000 }, pieces,
    offcuts: [{ offcutNo: 'N-007-A', outline: [[[2000, 0], [3000, 0], [3000, 1000], [2000, 1000]]], rect: { x: 2000, y: 0, length: 1000, width: 1000 } }] });
  const nest = readNestDxf(dxf, { filename: 'N-007.dxf' });
  const m = matchNest(nest, [flg, C.gusset, C.splice, C.web]);
  ok('the plate is 3000 × 1000 from its outline', nest.plate.found === 'outline' && nest.plate.length === 3000 && nest.plate.width === 1000);
  ok('4 parts; the offcut is not a part and keeps its number', nest.parts.length === 4 && nest.offcuts.length === 1 && nest.offcuts[0].label === 'N-007-A', JSON.stringify([nest.parts.length, nest.offcuts]));
  ok('all four matched by label', m.placements.length === 4 && m.placements.every((p) => p.by === 'label') && m.unmatched.length === 0, JSON.stringify([m.placements, m.unmatched]));
  const got = (i) => m.placements.find((p) => Math.abs(p.x - pieces[i].x) <= 0.5 && Math.abs(p.y - pieces[i].y) <= 0.5);
  ok('positions and turns are the ones exported', got(0)?.rotationDeg === 0 && got(1)?.rotationDeg === 90 && got(2)?.candidateKey === 'cp-gusset' && got(2).rotationDeg === 0 && got(3)?.candidateKey === 'cp-splice' && got(3).rotationDeg === 90, JSON.stringify(m.placements));
  ok('counts: 2 of CP-0001, none of the web', m.counts['cp-flg'] === 2 && m.counts['cp-web'] === 0);
  ok('hints from our title: nest N-007, 12 mm, E350, 3000 x 1000', nest.hints.nestNo === 'N-007' && nest.hints.thicknessMm === 12 && nest.hints.grade === 'E350' && nest.hints.plateSize?.length === 3000 && nest.hints.plateSize?.width === 1000, JSON.stringify(nest.hints));
}

/* 9. the awkward cases */
section('9. labels that disagree, unknown parts, ambiguity, symmetry');
{
  // A 640 × 300 rectangle labelled as the 3000 × 450 flange's code; a stiffener labelled as the gusset.
  const parts = shelfLayout([
    { rect: { length: 640, width: 300 }, label: 'G1-TF1' },
    { shape: S.stiffener, rotationDeg: 20, label: 'GP-7' },
    { shape: S.gusset, rotationDeg: 300, label: 'GP-7' },
    { rect: { length: 777, width: 333 }, label: 'ZZ-9' },                 // nobody's
    { shape: S.angle, rotationDeg: 45 },                                  // unlabelled, known shape
  ], PLATE);
  const nest = readNestDxf(makeNestDxf({ plate: PLATE, parts, style: 'polyline' }));
  const m = matchNest(nest, CANDS);
  const u = (label) => m.unmatched.find((x) => x.labels.includes(label) && (label !== 'GP-7' || /stiff|ST-3/i.test(x.why)));
  ok('a part labelled G1-TF1 that is not its shape is unmatched, in words', /labelled "G1-TF1".*not the shape of G1-TF1.*3000 x 450.*640 x 300/.test(u('G1-TF1')?.why ?? ''), JSON.stringify(m.unmatched));
  ok('a stiffener labelled as the gusset is unmatched, and the why says whose shape it has', /labelled "GP-7"/.test(u('GP-7')?.why ?? '') && /shape of ST-3/.test(u('GP-7')?.why ?? ''), JSON.stringify(m.unmatched));
  ok('the real gusset with the same label is placed', m.counts['cp-gusset'] === 1 && m.counts['cp-stiff'] === 0);
  const zz = m.unmatched.find((x) => x.labels.includes('ZZ-9'));
  ok('an unknown part is unmatched with its size', /"ZZ-9" is not one of the codes.*777 x 333/.test(zz?.why ?? '') && zz.bbox.length === 777, JSON.stringify(zz));
  const ang = m.placements.find((p) => p.candidateKey === 'cp-angle');
  ok('an unlabelled known shape at 45° is matched by shape', ang?.by === 'shape' && angleGap(ang.rotationDeg, 45) <= 0.05 && ang.confidence < 1, JSON.stringify(ang));
  ok('3 unmatched, 2 placed, none ambiguous', m.unmatched.length === 3 && m.placements.length === 2 && m.ambiguous.length === 0);
}
{
  // Two different cut plates of the same size, no label: ambiguous. A label settles it.
  const a = { key: 'cp-x', codes: ['X-1'], rings: null, length: 500, width: 250 };
  const b = { key: 'cp-y', codes: ['Y-1'], rings: null, length: 500, width: 250 };
  const parts = shelfLayout([{ rect: { length: 500, width: 250 } }, { rect: { length: 500, width: 250 }, rotationDeg: 90 }, { rect: { length: 500, width: 250 }, label: 'y 1' }], PLATE);
  const nest = readNestDxf(makeNestDxf({ plate: PLATE, parts, style: 'polyline' }));
  const m = matchNest(nest, [a, b]);
  ok('same-size rectangles of two cut plates with no label are ambiguous', m.ambiguous.length === 2 && m.ambiguous.every((x) => x.candidateKeys.length === 2 && x.candidateKeys.includes('cp-x') && x.candidateKeys.includes('cp-y')), JSON.stringify(m.ambiguous));
  ok('…each with the placement it would have as either', m.ambiguous.every((x) => x.options.length === 2 && x.options.every((o) => o.by === 'size')) && m.ambiguous.some((x) => x.options[0].rotationDeg === 90));
  ok('…and the labelled one is settled by its label', m.placements.length === 1 && m.placements[0].candidateKey === 'cp-y' && m.placements[0].by === 'label' && m.counts['cp-y'] === 1 && m.counts['cp-x'] === 0);
}
{
  // Symmetric shapes report ONE canonical angle whatever way they were turned.
  const parts = shelfLayout([0, 90, 180, 270, 45, 225].map((rotationDeg) => ({ rect: { length: 400, width: 400 }, rotationDeg })).concat([10, 190].map((rotationDeg) => ({ shape: S.splice, rotationDeg })), [{ shape: S.disc, rotationDeg: 123 }]), PLATE);
  const nest = readNestDxf(makeNestDxf({ plate: PLATE, parts, style: 'segments' }));
  const m = matchNest(nest, [{ key: 'sq', codes: [], rings: null, length: 400, width: 400 }, C.splice, C.disc]);
  const sq = m.placements.filter((p) => p.candidateKey === 'sq').map((p) => p.rotationDeg).sort((x, y) => x - y);
  ok('a square turned 0/90/180/270 reports 0, turned 45/225 reports 45', sq.length === 6 && sq.slice(0, 4).every((r) => r === 0) && sq.slice(4).every((r) => Math.abs(r - 45) <= 0.05), JSON.stringify(sq));
  const sp = m.placements.filter((p) => p.candidateKey === 'cp-splice').map((p) => p.rotationDeg);
  ok('a splice plate turned 10° and 190° both report 10°', sp.length === 2 && sp.every((r) => Math.abs(r - 10) <= 0.05), JSON.stringify(sp));
  const disc = m.placements.find((p) => p.candidateKey === 'cp-disc');
  ok('a disc reports 0° and never mirrored', disc?.rotationDeg === 0 && disc.mirrored === false && m.placements.every((p) => !p.mirrored), JSON.stringify(disc));
}

/* 10. many copies */
section('10. forty copies of one part, and a 3,000-entity file');
{
  const parts = shelfLayout(Array.from({ length: 40 }, (_, i) => ({ shape: S.gusset, rotationDeg: (i * 37.5) % 360, mirrored: i % 3 === 0 })).concat([{ shape: S.stiffener }, { shape: S.stiffener, rotationDeg: 90 }]), PLATE);
  const nest = readNestDxf(makeNestDxf({ plate: PLATE, parts, style: 'segments' }));
  const m = matchNest(nest, CANDS);
  ok('40 gussets and 2 stiffeners counted', m.counts['cp-gusset'] === 40 && m.counts['cp-stiff'] === 2 && m.unmatched.length === 0 && m.ambiguous.length === 0, JSON.stringify([m.counts, m.unmatched.length]));
  ok('14 of the gussets are mirrored', m.placements.filter((p) => p.candidateKey === 'cp-gusset' && p.mirrored).length === 14);
}
{
  const big = { length: 24000, width: 12000 };
  const items = [];
  for (let i = 0; i < 165; i++) items.push({ shape: S.splice, rotationDeg: i % 2 ? 90 : 0, label: 'SP-2' });
  for (let i = 0; i < 60; i++) items.push({ shape: S.gusset, rotationDeg: (i * 17) % 360, mirrored: i % 2 === 0, label: 'GP-7' });
  const dxf = makeNestDxf({ plate: big, parts: shelfLayout(items, big), style: 'segments', options: { plate: 'segments' } });
  const n = entityCount(dxf);
  let t = performance.now();
  const nest = readNestDxf(dxf);
  const readMs = performance.now() - t;
  t = performance.now();
  const m = matchNest(nest, CANDS);
  const matchMs = performance.now() - t;
  console.log(`        ${n} entities (${(dxf.length / 1024).toFixed(0)} KB): read in ${readMs.toFixed(0)} ms, matched in ${matchMs.toFixed(0)} ms`);
  ok(`a ${n}-entity file reads in under 2 s (${readMs.toFixed(0)} ms)`, n >= 3000 && readMs < 2000);
  ok('…and every one of its 225 parts is matched', nest.parts.length === 225 && m.counts['cp-splice'] === 165 && m.counts['cp-gusset'] === 60, JSON.stringify([nest.parts.length, m.counts['cp-splice'], m.counts['cp-gusset'], m.unmatched.length]));
}

/* 11. files that are not a nest */
section('11. bad files, empty nests, hints');
{
  ok('a binary buffer is BAD_FILE', codeOf(() => readNestDxf(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 8, 0, 0, 0]))) === 'BAD_FILE');
  ok('a DWG is BAD_FILE, in words', (() => { try { readNestDxf(Buffer.concat([Buffer.from('AC1027'), Buffer.alloc(64)])); } catch (e) { return e.code === 'BAD_FILE' && /DWG/.test(e.message); } return false; })());
  ok('a binary DXF is BAD_FILE, in words', (() => { try { readNestDxf(Buffer.concat([Buffer.from('AutoCAD Binary DXF\r\n\x1a'), Buffer.alloc(64)])); } catch (e) { return e.code === 'BAD_FILE' && /binary/.test(e.message); } return false; })());
  ok('garbage text is BAD_FILE', codeOf(() => readNestDxf('Nest,Cut plate,Qty\nN1,CP-1,4\n')) === 'BAD_FILE');
  ok('nothing at all is BAD_FILE', codeOf(() => readNestDxf(null)) === 'BAD_FILE' && codeOf(() => readNestDxf('')) === 'BAD_FILE');
  const wrap = (ents) => ['0', 'SECTION', '2', 'ENTITIES', ...ents, '0', 'ENDSEC', '0', 'EOF'].join('\n');
  ok('a DXF with only open lines and text is EMPTY_NEST', codeOf(() => readNestDxf(wrap(['0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '100', '21', '0', '0', 'TEXT', '8', '0', '10', '5', '20', '5', '40', '10', '1', 'hello']))) === 'EMPTY_NEST');
  ok('a DXF with no entities is EMPTY_NEST', codeOf(() => readNestDxf(wrap([]))) === 'EMPTY_NEST');
  ok('a plate with nothing on it is EMPTY_NEST', codeOf(() => readNestDxf(makeNestDxf({ plate: PLATE, parts: [], style: 'polyline' }))) === 'EMPTY_NEST');
  // A block of one circle placed as a 1000 × 1000 array is a million shapes: more than one plate.
  const bomb = ['0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'DOT', '10', '0', '20', '0', '0', 'CIRCLE', '8', '0', '10', '0', '20', '0', '40', '5', '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '8', '0', '2', 'DOT', '10', '0', '20', '0', '70', '1000', '71', '1000', '44', '20', '45', '20', '0', 'ENDSEC', '0', 'EOF'].join('\n');
  ok('a file of a million shapes is TOO_BIG', codeOf(() => readNestDxf(bomb)) === 'TOO_BIG');
  // The same block as a 3 × 2 array is six parts, 20 apart.
  const six = readNestDxf(bomb.replace("'1000'", '').replace('\n70\n1000\n71\n1000\n', '\n70\n3\n71\n2\n'));
  ok('an INSERT array of 3 × 2 is six parts', six.parts.length === 6 && six.plate.found === 'bounds' && six.plate.length === 50 && six.plate.width === 30, JSON.stringify([six.parts.length, six.plate.length, six.plate.width]));

  const one = makeNestDxf({ plate: PLATE, parts: shelfLayout([{ shape: S.gusset, label: 'GP-7' }], PLATE), style: 'polyline' });
  const h = readNestDxf(one, { filename: 'N12_16mm_E350.dxf' }).hints;
  ok('hints from the file name N12_16mm_E350.dxf', h.nestNo === 'N12' && h.thicknessMm === 16 && h.grade === 'E350' && h.plateSize === null, JSON.stringify(h));
  const h2 = readNestDxf(one, { filename: 'C:\\nests\\KEPL-ROB_P0042_T25_12000x2500_S355J2.DXF' }).hints;
  ok('…and from P0042_T25_12000x2500_S355J2', h2.nestNo === 'P0042' && h2.thicknessMm === 25 && h2.grade === 'S355J2' && h2.plateSize?.length === 12000 && h2.plateSize?.width === 2500, JSON.stringify(h2));
  ok('no file name, no title: every hint is null (and `from` says nothing gave one)', (() => { const { from, ...hints } = readNestDxf(one).hints; return Object.values(hints).every((v) => v === null) && Object.values(from).every((v) => v === null); })());

  // A single part with holes and nothing else is a PART, not a plate holding round parts.
  const lone = readNestDxf(makeNestDxf({ plate: PLATE, parts: [{ shape: S.splice, x: 0, y: 0 }], style: 'segments' }));
  ok('one splice plate alone is one part with 12 holes (plate from bounds)', lone.parts.length === 1 && lone.parts[0].rings.holes.length === 12 && lone.plate.found === 'bounds', JSON.stringify([lone.parts.length, lone.plate.found]));
  // Unitless file whose title says a plate 25.4× bigger: warned.
  const inch = readNestDxf(makeNestDxf({ plate: PLATE, parts: shelfLayout([{ shape: S.gusset, label: 'GP-7' }], PLATE), style: 'inches', options: { insUnits: null, title: ['PL 16 x 2500 x 12000 E350'] } }));
  ok('a unitless file drawn in inches is warned about', inch.warnings.some((w) => /inches/.test(w)), inch.warnings.join(' | '));
}

/* 12. common cuts that cross */
section('12. commoncut-grid style — blocks of equal parts, the shared cuts crossing with no end at the crossing');
{
  const A = { key: 'cp-a', codes: ['A-1'], rings: null, length: 600, width: 300 };
  const B2 = { key: 'cp-b', codes: ['B-1'], rings: null, length: 400, width: 300 };
  const cands = [A, B2, C.gusset, C.stiffener, C.splice];
  const SMALL = { length: 3000, width: 1500 };
  const lineCount = (dxf) => (dxf.match(/\nLINE\r?\n/g) ?? []).length;
  /** Every drawn part must come back as `key`, where it was drawn, at its angle. */
  const cellsRight = (nest, m, parts, keyOf, off = [0, 0]) => parts.every((pt) => {
    const pl = m.placements.find((q) => Math.abs(q.x - (pt.x - off[0])) <= 0.5 && Math.abs(q.y - (pt.y - off[1])) <= 0.5);
    return pl && pl.candidateKey === keyOf(pt) && angleGap(pl.rotationDeg, pt.want ?? pt.rotationDeg ?? 0) <= 0.05 && pl.mirrored === false;
  });
  const worstFit = (nest, m, list) => Math.max(0, ...m.placements.map((pl) => { const c = list.find((k) => k.key === pl.candidateKey); const part = nest.parts.find((q) => q.id === pl.partId); return ringsDeviation(placeRings(c.rings ?? rectRings(c.length, c.width), pl), c.rings ? part.rings : [part.rings.outline]); }));

  // 12a. 2 × 2 inside a drawn plate: a rim, one long horizontal cut and one long vertical cut.
  for (const labelled of [true, false]) {
    const parts = gridParts({ rect: { length: 600, width: 300 }, cols: 2, rows: 2, x: 100, y: 100, label: labelled ? 'A-1' : undefined });
    const dxf = makeNestDxf({ plate: SMALL, parts, style: 'commoncut-grid' });
    const nest = readNestDxf(dxf);
    const m = matchNest(nest, cands);
    const tag = labelled ? 'labelled' : 'no labels';
    ok(`2 × 2, ${tag}: 4 parts from ${lineCount(dxf)} lines (plate 4, rim 4, one cut each way)`, lineCount(dxf) === 10 && nest.parts.length === 4 && nest.plate.found === 'outline' && nest.plate.length === 3000, `${lineCount(dxf)} lines, ${nest.parts.length} parts; ${nest.warnings.join(' | ')}`);
    ok(`2 × 2, ${tag}: every cell is A at 0°, where it was drawn`, m.counts['cp-a'] === 4 && m.unmatched.length === 0 && m.ambiguous.length === 0 && cellsRight(nest, m, parts, () => 'cp-a') && m.placements.every((q) => q.by === (labelled ? 'label' : 'size')), JSON.stringify([m.placements, m.unmatched]));
    ok(`2 × 2, ${tag}: each cell shares half its outline, and re-placing lands on it (worst ${worstFit(nest, m, cands).toFixed(3)} mm)`, nest.parts.every((q) => Math.abs(q.commonCut - 0.5) < 0.01) && worstFit(nest, m, cands) <= 0.5, JSON.stringify(nest.parts.map((q) => q.commonCut)));
  }

  // 12b. 4 × 3 of the same part turned 90°.
  {
    const parts = gridParts({ rect: { length: 600, width: 300 }, cols: 4, rows: 3, x: 200, y: 150, rotationDeg: 90 });
    const dxf = makeNestDxf({ plate: { length: 3000, width: 2500 }, parts, style: 'commoncut-grid' });
    const nest = readNestDxf(dxf);
    const m = matchNest(nest, cands);
    ok(`4 × 3 turned 90°: 12 parts from ${lineCount(dxf)} lines`, lineCount(dxf) === 4 + 4 + 3 + 2 && nest.parts.length === 12, `${lineCount(dxf)} lines, ${nest.parts.length} parts`);
    ok('4 × 3 turned 90°: every cell is A at 90°, where it was drawn', m.counts['cp-a'] === 12 && m.unmatched.length === 0 && cellsRight(nest, m, parts, () => 'cp-a'), JSON.stringify([m.counts, m.unmatched]));
    ok('…the middle cells share all four cuts, the corner cells two', nest.parts.filter((q) => q.commonCut === 1).length === 2 && nest.parts.filter((q) => Math.abs(q.commonCut - 0.5) < 0.01).length === 4, JSON.stringify(nest.parts.map((q) => q.commonCut)));
  }

  // 12c. The rim of the block IS the plate's edge: a plate cut up completely.
  {
    const full = { length: 2400, width: 900 };
    const parts = gridParts({ rect: { length: 600, width: 300 }, cols: 4, rows: 3, label: 'A-1' });
    const dxf = makeNestDxf({ plate: full, parts, style: 'commoncut-grid' });
    ok(`rim = plate edge: ${lineCount(dxf)} lines in all (4 edges + 3 + 2 cuts)`, lineCount(dxf) === 9);
    const blind = readNestDxf(dxf);
    const mb = matchNest(blind, cands);
    ok('rim = plate edge, nothing known: 12 parts, all A, positions right (plate from bounds, with the warning)', blind.parts.length === 12 && mb.counts['cp-a'] === 12 && cellsRight(blind, mb, parts, () => 'cp-a') && blind.plate.found === 'bounds' && blind.plate.length === 2400 && blind.plate.width === 900, JSON.stringify([blind.parts.length, mb.counts, blind.plate.found]));
    const sized = readNestDxf(dxf, { plateSize: { length: 2400, width: 900 } });
    ok('…with the plate size known the rim is the plate outline, no warning', sized.plate.found === 'outline' && sized.parts.length === 12 && sized.warnings.length === 0 && sized.skeleton === null, JSON.stringify([sized.plate.found, sized.warnings]));
    const told = readNestDxf(dxf, { plateOutline: true });
    ok('…and so it is when the caller says the plate is drawn', told.plate.found === 'outline' && told.parts.length === 12 && matchNest(told, cands).counts['cp-a'] === 12);
    const titled = readNestDxf(makeNestDxf({ plate: full, parts, style: 'commoncut-grid', options: { title: ['PL 20 x 900 x 2400 E250'] } }));
    ok('…or when the title block gives the size', titled.plate.found === 'outline' && titled.parts.length === 12 && titled.hints.thicknessMm === 20, JSON.stringify([titled.plate.found, titled.hints]));
  }

  // 12d. A block against the plate's corner, free parts elsewhere on the same plate: mixed, rim = plate edge.
  for (const labelled of [true, false]) {
    const grid = gridParts({ rect: { length: 600, width: 300 }, cols: 2, rows: 3, label: labelled ? 'A-1' : undefined }).map((q) => ({ ...q, key: 'cp-a' }));
    const free = [
      { shape: S.gusset, x: 1500, y: 200, rotationDeg: 37.5, label: labelled ? 'GP-7' : undefined, key: 'cp-gusset' },
      { shape: S.splice, x: 1400, y: 900, rotationDeg: 0, label: labelled ? 'SP-2' : undefined, key: 'cp-splice' },
      { shape: S.stiffener, x: 2500, y: 300, rotationDeg: 0, label: labelled ? 'ST-3' : undefined, key: 'cp-stiff' },
    ];
    const parts = [...grid, ...free];
    const nest = readNestDxf(makeNestDxf({ plate: SMALL, parts, style: 'commoncut-grid' }));
    const m = matchNest(nest, cands);
    const tag = labelled ? 'labelled' : 'no labels';
    ok(`corner block + free parts, ${tag}: 9 parts, the plate 3000 × 1500 from its outline, the rest is the skeleton`, nest.parts.length === 9 && nest.plate.found === 'outline' && nest.plate.length === 3000 && nest.plate.width === 1500 && !!nest.skeleton && nest.warnings.length === 0, JSON.stringify([nest.parts.length, nest.plate, nest.warnings]));
    ok(`corner block + free parts, ${tag}: every cell and every free part is the right cut plate, place and angle`, m.unmatched.length === 0 && m.ambiguous.length === 0 && m.counts['cp-a'] === 6 && cellsRight(nest, m, parts, (q) => q.key), JSON.stringify([m.counts, m.unmatched, m.placements.map((q) => [q.candidateKey, q.x, q.y, q.rotationDeg])]));
    ok(`corner block + free parts, ${tag}: the splice plate keeps its 12 holes; re-placing lands (worst ${worstFit(nest, m, cands).toFixed(3)} mm)`, nest.parts.some((q) => q.rings.holes.length === 12) && worstFit(nest, m, cands) <= 0.5);
  }

  // 12e. A block in the middle of a drawn plate next to free parts (the plate a separate outline).
  {
    const grid = gridParts({ rect: { length: 400, width: 300 }, cols: 3, rows: 2, x: 150, y: 120, label: 'B-1' }).map((q) => ({ ...q, key: 'cp-b' }));
    const free = [{ shape: S.gusset, x: 1700, y: 200, rotationDeg: 215, mirrored: true, label: 'GP-7', key: 'cp-gusset' }, { shape: S.stiffener, x: 2400, y: 100, rotationDeg: 0, label: 'ST-3', key: 'cp-stiff' }];
    const nest = readNestDxf(makeNestDxf({ plate: SMALL, parts: [...grid, ...free], style: 'commoncut-grid' }));
    const m = matchNest(nest, cands);
    ok('block in the plate + free parts: 8 parts, 6 of B, the gusset mirrored at 215°', nest.parts.length === 8 && nest.plate.found === 'outline' && nest.skeleton === null && m.counts['cp-b'] === 6 && m.counts['cp-gusset'] === 1 && m.counts['cp-stiff'] === 1 && cellsRight(nest, m, grid, (q) => q.key)
      && m.placements.find((q) => q.candidateKey === 'cp-gusset').mirrored === true && angleGap(m.placements.find((q) => q.candidateKey === 'cp-gusset').rotationDeg, 215) <= 0.05, JSON.stringify([nest.parts.length, m.counts, m.unmatched]));
  }

  // 12f. Four parts in a pinwheel close in a 100 × 100 void: it stays a part, unmatched, and the why says scrap.
  {
    const parts = [
      { rect: { length: 400, width: 300 }, x: 100, y: 100 },
      { rect: { length: 400, width: 300 }, x: 500, y: 100, rotationDeg: 90 },
      { rect: { length: 400, width: 300 }, x: 400, y: 500 },
      { rect: { length: 400, width: 300 }, x: 100, y: 400, rotationDeg: 90 },
    ];
    const nest = readNestDxf(makeNestDxf({ plate: SMALL, parts, style: 'commoncut-grid' }));
    const m = matchNest(nest, cands);
    const v = m.unmatched[0];
    ok('pinwheel: 5 loops read, the 4 parts are B (two at 0°, two at 90°)', nest.parts.length === 5 && m.counts['cp-b'] === 4 && cellsRight(nest, m, parts, () => 'cp-b'), JSON.stringify([nest.parts.length, m.counts]));
    ok('pinwheel: the 100 × 100 void is unmatched, flagged, and the why says it may be scrap between parts', m.unmatched.length === 1 && v.maybeScrap === true && v.bbox.length === 100 && v.bbox.x === 400 && /scrap between parts/.test(v.why) && nest.parts.find((q) => q.id === v.partId).commonCut === 1, JSON.stringify(m.unmatched));
    const free = matchNest(readNestDxf(makeNestDxf({ plate: SMALL, parts: [{ rect: { length: 100, width: 100 }, x: 50, y: 50 }, { shape: S.gusset, x: 400, y: 50 }], style: 'polyline' })), cands).unmatched[0];
    ok('…a free unknown part is NOT called scrap', free && free.maybeScrap === false && !/scrap/.test(free.why), JSON.stringify(free));
  }
}

/* 13. a part across the plate's edge */
section('13. a part lying across the plate\'s edge is returned, flagged — not dropped');
{
  const SMALL = { length: 3000, width: 1500 };
  const parts = [
    { shape: S.gusset, x: 2800, y: 300, label: 'GP-7' },                 // 520 long from x = 2800: 320 off the plate
    { shape: S.stiffener, x: 200, y: 100, label: 'ST-3' },
    { shape: S.splice, x: 900, y: 1300, label: 'SP-2' },                 // 400 high from y = 1300: 200 off the top
  ];
  for (const [style, options] of [['polyline', {}], ['segments', { plate: 'segments' }], ['blocks', {}], ['noisy', { title: null }]]) {
    const nest = readNestDxf(makeNestDxf({ plate: SMALL, parts, style, options }));
    const m = matchNest(nest, CANDS);
    const g = nest.parts.find((q) => Math.abs(q.bbox.x - 2800) < 0.5);
    const sp = nest.parts.find((q) => Math.abs(q.bbox.y - 1300) < 0.5);
    const st = nest.parts.find((q) => Math.abs(q.bbox.x - 200) < 0.5);
    ok(`${style}: 3 parts, the plate still 3000 × 1500 from its outline`, nest.parts.length === 3 && nest.plate.found === 'outline' && nest.plate.length === 3000 && nest.plate.width === 1500, JSON.stringify([nest.parts.length, nest.plate.found, nest.plate.length, nest.warnings]));
    ok(`${style}: the gusset is flagged 320 mm off the plate, the splice plate 200 mm, the stiffener not at all`, g?.outsidePlate === true && Math.abs(g.outsideMm - 320) < 0.5 && sp?.outsidePlate === true && Math.abs(sp.outsideMm - 200) < 0.5 && sp.rings.holes.length === 12 && st?.outsidePlate === false && st.outsideMm === 0, JSON.stringify([g, st].map((q) => q && [q.outsidePlate, q.outsideMm])));
    ok(`${style}: all three are still matched where they are drawn, and it is warned about`, m.counts['cp-gusset'] === 1 && m.counts['cp-splice'] === 1 && m.counts['cp-stiff'] === 1 && Math.abs(m.placements.find((q) => q.candidateKey === 'cp-gusset').x - 2800) <= 0.5 && nest.warnings.some((w) => /2 parts lie partly off the plate/.test(w)), JSON.stringify([m.counts, nest.warnings]));
  }
  // A shape wholly beside the plate (a parts list, a legend) is still left out, with the note.
  const beside = readNestDxf(makeNestDxf({ plate: SMALL, parts: [{ shape: S.stiffener, x: 200, y: 100 }, { shape: S.gusset, x: 3500, y: 100 }], style: 'polyline' }));
  ok('a shape wholly beside the plate is left out with the note, as before', beside.parts.length === 1 && beside.warnings.some((w) => /1 shape drawn outside the plate ignored/.test(w)), JSON.stringify([beside.parts.length, beside.warnings]));
}

/* 14. a big common-cut plate */
section('14. speed with crossings');
{
  const big = { length: 12000, width: 6000 };
  const parts = gridParts({ rect: { length: 300, width: 200 }, cols: 40, rows: 30, label: 'T-1' });
  const dxf = makeNestDxf({ plate: big, parts, style: 'commoncut-grid' });
  let t = performance.now();
  const nest = readNestDxf(dxf);
  const readMs = performance.now() - t;
  t = performance.now();
  const m = matchNest(nest, [{ key: 'tile', codes: ['T-1'], rings: null, length: 300, width: 200 }]);
  const matchMs = performance.now() - t;
  console.log(`        40 × 30 block, ${entityCount(dxf)} entities, 1,131 crossings: read in ${readMs.toFixed(0)} ms, matched in ${matchMs.toFixed(0)} ms`);
  ok(`a 1,200-part common-cut plate reads in under 2 s (${readMs.toFixed(0)} ms) and every cell is matched`, readMs < 2000 && nest.parts.length === 1200 && m.counts.tile === 1200, JSON.stringify([nest.parts.length, m.counts]));

  // 3,000+ loose lines that cross nothing, plus a block: the crossing search must not slow the plain case.
  const items = [];
  for (let i = 0; i < 700; i++) items.push({ shape: S.stiffener, rotationDeg: i % 2 ? 90 : 0 });
  const wide = { length: 40000, width: 20000 };
  const mixed = makeNestDxf({ plate: wide, parts: [...shelfLayout(items, { length: 40000, width: 14000 }), ...gridParts({ rect: { length: 600, width: 300 }, cols: 20, rows: 10, x: 1000, y: 15000 })], style: 'commoncut-grid' });
  t = performance.now();
  const n2 = readNestDxf(mixed);
  const ms2 = performance.now() - t;
  console.log(`        700 free parts + a 20 × 10 block, ${entityCount(mixed)} entities: read in ${ms2.toFixed(0)} ms`);
  ok(`a ${entityCount(mixed)}-entity mixed file reads in under 2 s (${ms2.toFixed(0)} ms): 900 parts`, entityCount(mixed) >= 3000 && ms2 < 2000 && n2.parts.length === 900, String(n2.parts.length));
}

/* ───────────── 2026-10-13: nothing lost quietly, the plate, marking, kerf compensation ───────────── */
{
  const f6 = (n) => String(Number(Number(n).toFixed(6)));
  const LN = (layer, p, q, colour = null) => ['0', 'LINE', '8', layer, ...(colour != null ? ['62', String(colour)] : []), '10', f6(p[0]), '20', f6(p[1]), '11', f6(q[0]), '21', f6(q[1])];
  const PL = (layer, pts, colour = null) => ['0', 'LWPOLYLINE', '8', layer, ...(colour != null ? ['62', String(colour)] : []), '90', String(pts.length), '70', '1', ...pts.flatMap(([x, y, b]) => ['10', f6(x), '20', f6(y), ...(b ? ['42', f6(b)] : [])])];
  const TX = (layer, p, h, s) => ['0', 'TEXT', '8', layer, '10', f6(p[0]), '20', f6(p[1]), '40', f6(h), '1', s, '72', '1', '11', f6(p[0]), '21', f6(p[1]), '73', '2'];
  const file = (ents, { insunits = 4, scale = 1 } = {}) => {
    const body = ents.flat().map((v, i, all) => (i % 2 === 1 && ['10', '20', '11', '21', '40'].includes(all[i - 1]) && all[i - 1] !== '1' ? f6(Number(v) * scale) : v));
    return [...(insunits == null ? [] : ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(insunits), '0', 'ENDSEC']), '0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF'].join('\r\n');
  };
  const rect = (x, y, l, w) => [[x, y], [x + l, y], [x + l, y + w], [x, y + w]];
  const sides = (layer, c, colour = null) => c.map((p, i) => LN(layer, p, c[(i + 1) % c.length], colour));
  const plate = PL('PLATE', rect(0, 0, 3000, 1500));
  const R = { key: 'r', codes: ['R-1'], rings: null, length: 1200, width: 400 };
  const Q = { key: 'q', codes: ['Q-1'], rings: null, length: 800, width: 200 };
  const codes = (list) => list.map((x) => x.code).join();

  section('15. A gap in an outline: closed when it is a tab or a sloppy corner, SAID when it is wider — never dropped quietly');
  {
    // 1200 × 400 as four lines, with a 1.5 mm tab left in the middle of its bottom edge.
    const tab = (gap) => [LN('CUT', [100, 100], [700 - gap / 2, 100]), LN('CUT', [700 + gap / 2, 100], [1300, 100]), LN('CUT', [1300, 100], [1300, 500]), LN('CUT', [1300, 500], [100, 500]), LN('CUT', [100, 500], [100, 100])];
    let n = readNestDxf(file([plate, ...tab(1.5), TX('TXT', [700, 300], 30, 'R-1')]));
    let m = matchNest(n, [R, Q]);
    ok('a 1.5 mm micro-joint is closed: the part is read, matched, and a note says a gap was closed and where', n.parts.length === 1 && n.closedGaps === 1 && m.placements[0]?.candidateKey === 'r' && n.problems.length === 0 && n.warnings.some((w) => /1 gap in an outline closed \(1\.5 mm, at \(700, 100\)\)/.test(w)), JSON.stringify([n.parts.length, n.warnings, n.problems]));
    // A line that stops 0.3 mm short of its corner.
    n = readNestDxf(file([plate, LN('CUT', [100, 100], [1299.7, 100]), LN('CUT', [1300, 100], [1300, 500]), LN('CUT', [1300, 500], [100, 500]), LN('CUT', [100, 500], [100, 100])]));
    ok('a line 0.3 mm short of its corner is closed too', n.parts.length === 1 && n.closedGaps === 1 && Math.abs(n.parts[0].bbox.length - 1200) < 0.01, JSON.stringify([n.parts.map((p) => p.bbox), n.warnings]));
    // 4.2 mm: wider than any tab. Not closed; the file is refused with where and how wide.
    n = readNestDxf(file([plate, ...tab(4.2), PL('CUT', rect(100, 700, 800, 200))]));
    const open = n.problems.find((p) => p.code === 'OPEN_CONTOUR');
    ok('a 4.2 mm gap is NOT closed: OPEN_CONTOUR names the shape, the gap and where it is', n.parts.length === 1 && !!open && open.gapMm === 4.2 && open.at[0] === 700 && open.at[1] === 100 && /about 1200 x 400 at \(100, 100\) is not a closed outline: its ends are 4\.2 mm apart at \(700, 100\)\. Close it in the nesting program and export again\./.test(open.message), JSON.stringify(n.problems));
    ok('…and it is not ALSO said as "lead-ins ignored"', !n.warnings.some((w) => /lead-ins/.test(w)), JSON.stringify(n.warnings));
    n = readNestDxf(file([plate, ...tab(1.5), PL('CUT', rect(100, 700, 800, 200))]), { gapTolMm: 0 });
    ok('gapTolMm: 0 closes nothing — the same tab is then an OPEN_CONTOUR, not a vanished part', n.parts.length === 1 && n.problems[0]?.code === 'OPEN_CONTOUR' && n.problems[0].gapMm === 1.5, JSON.stringify(n.problems));
    // Two loose ends 1.5 mm apart that do NOT point at each other (two lead-ins side by side) are never joined.
    n = readNestDxf(file([plate, ...sides('CUT', rect(100, 100, 1200, 400)), LN('CUT', [400, 100], [400, 92]), LN('CUT', [401.5, 100], [401.5, 92])]));
    ok('two lead-ins whose loose ends are 1.5 mm apart are not joined into a shape', n.parts.length === 1 && n.closedGaps === 0 && n.problems.length === 0 && n.warnings.some((w) => /2 lines that do not close/.test(w)), JSON.stringify([n.parts.length, n.closedGaps, n.warnings]));
    // Two different parts, each closed, 1.5 mm apart: nothing to join, two parts.
    n = readNestDxf(file([plate, ...sides('CUT', rect(100, 100, 300, 180)), ...sides('CUT', rect(401.5, 100, 300, 180))]));
    ok('two closed parts 1.5 mm apart stay two parts', n.parts.length === 2 && n.closedGaps === 0);
    // Three sides only: it could have been a part — a caution, not a note.
    n = readNestDxf(file([plate, LN('CUT', [100, 500], [100, 100]), LN('CUT', [100, 100], [1300, 100]), LN('CUT', [1300, 100], [1300, 500]), PL('CUT', rect(100, 700, 800, 200))]));
    ok('three sides of a part (ends 1200 mm apart) are a SHAPE_IGNORED caution that needs the user\'s eye', n.problems.length === 0 && n.cautions.length === 1 && n.cautions[0].code === 'SHAPE_IGNORED' && /1200 x 400 at \(100, 100\)/.test(n.cautions[0].message), JSON.stringify([n.problems, n.cautions]));
    // Rapid moves hopping over parts, a lead-in, an exploded dimension: still only a note.
    n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400)), PL('CUT', rect(100, 700, 800, 200)), PL('CUT', rect(1500, 100, 800, 200)),
      LN('CUT', [50, 50], [700, 300]), LN('CUT', [700, 300], [500, 800]), LN('CUT', [500, 800], [1900, 200]), LN('CUT', [1900, 200], [2900, 1400]),
      LN('0', [1500, 320], [1500, 400]), LN('0', [2300, 320], [2300, 400]), LN('0', [1500, 390], [2300, 390])]));
    ok('rapid moves across parts and an exploded dimension are a note, not a problem or a caution', n.parts.length === 3 && !n.problems.length && !n.cautions.length && n.warnings.some((w) => /lines that do not close into a shape ignored/.test(w)), JSON.stringify([n.problems, n.cautions, n.warnings]));
  }

  section('16. More than one plate in a file is refused in words; what is not read is a caution');
  {
    const sheet = (ox, layer) => [PL(layer, rect(ox, 0, 3000, 1500)), PL('0', rect(ox + 100, 100, 1200, 400)), TX('0', [ox + 700, 300], 30, 'R-1'), PL('0', rect(ox + 100, 700, 800, 200)), TX('0', [ox + 500, 800], 30, 'Q-1')];
    let n = readNestDxf(file([...sheet(0, 'PLATE'), ...sheet(3500, 'PLATE')]));
    ok('two plates on a plate layer: MULTIPLE_PLATES, "it holds 2 plates"', n.plates === 2 && n.problems.length === 1 && n.problems[0].code === 'MULTIPLE_PLATES' && n.problems[0].plates === 2 && /it holds 2 plates \(each 3000 x 1500\)\. One file is one plate/.test(n.problems[0].message), JSON.stringify(n.problems));
    n = readNestDxf(file([...sheet(0, '0'), ...sheet(3500, '0'), ...sheet(7000, '0')]));
    ok('three plates with everything on layer 0: MULTIPLE_PLATES 3, and the first plate is the one shown', n.plates === 3 && n.problems[0]?.code === 'MULTIPLE_PLATES' && n.plate.length === 3000 && n.parts.length === 2, JSON.stringify([n.plates, n.problems, n.parts.length]));
    // Two equal parts with holes and NO plate drawn are two parts, not two plates.
    const holed = (x) => [PL('0', rect(x, 0, 500, 300)), ['0', 'CIRCLE', '8', '0', '10', String(x + 100), '20', '100', '40', '11'], ['0', 'CIRCLE', '8', '0', '10', String(x + 300), '20', '100', '40', '11']];
    n = readNestDxf(file([...holed(0), ...holed(600)]));
    ok('two equal holed parts with no plate drawn are two parts, not two plates', n.plates === 1 && n.problems.length === 0 && n.parts.length === 2 && n.plate.found === 'bounds', JSON.stringify([n.plates, n.problems, n.parts.length, n.plate.found]));
    // A closed shape beside the plate is handed to the caller, with its label.
    n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400)), PL('CUT', rect(3200, 100, 800, 200)), TX('TXT', [3600, 200], 30, 'Q-1')]));
    ok('a closed shape beside the plate comes back in `outside` with its label (the caller says what it is)', n.outside.length === 1 && n.outside[0].bbox.x === 3200 && n.outside[0].labels[0] === 'Q-1' && n.outside[0].inFrame === false && n.plates === 1, JSON.stringify(n.outside));
    // Things the reader does not read.
    n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400)), ['0', 'HATCH', '8', 'CUT', '2', 'SOLID', '70', '1'], ['0', 'INSERT', '8', 'CUT', '2', 'GHOST', '10', '0', '20', '0']]));
    ok('a HATCH and a block the file does not define are SHAPE_IGNORED cautions', n.cautions.length === 2 && n.cautions.every((c) => c.code === 'SHAPE_IGNORED') && n.cautions.some((c) => /1 HATCH item/.test(c.message)) && n.cautions.some((c) => /"GHOST"/.test(c.message)), JSON.stringify(n.cautions));
    n = readNestDxf(file([plate, ['0', 'SPLINE', '8', 'CUT', '70', '9', '71', '3', '10', '100', '20', '100', '10', '700', '20', '100', '10', '700', '20', '500', '10', '100', '20', '500']]));
    ok('a spline given only by control points is a CURVE_APPROXIMATE caution', n.cautions.some((c) => c.code === 'CURVE_APPROXIMATE'), JSON.stringify(n.cautions));
  }

  section('17. The plate: a frame round it, loose dimension text, a crop line, inches');
  {
    const inner = [PL('0', rect(0, 0, 3000, 1500)), PL('0', rect(100, 100, 1200, 400)), TX('0', [700, 300], 30, 'R-1'), PL('0', rect(100, 700, 800, 200)), TX('0', [500, 800], 30, 'Q-1')];
    const frame = [PL('0', rect(-300, -700, 3600, 2500)), PL('0', rect(2300, -650, 900, 300)), TX('0', [2750, -500], 40, 'DRG NO 17')];
    let n = readNestDxf(file([...frame, ...inner]), { plateSizes: [{ length: 3000, width: 1500 }, { length: 6000, width: 2500 }] });
    ok('a frame on layer 0 round a plate of a catalog size: the plate is the inner rectangle, a note says so, the title box is not a part', n.plate.length === 3000 && n.plate.width === 1500 && n.parts.length === 2 && n.warnings.some((w) => /A frame \(3600 x 2500\) is drawn round the plate: the plate is the 3000 x 1500 rectangle inside it/.test(w)) && n.outside.length === 1 && n.outside[0].inFrame === true && n.plates === 1, JSON.stringify([n.plate.length, n.parts.length, n.warnings, n.outside]));
    n = readNestDxf(file([...frame, ...inner]), { filename: 'N7_12mm_3000x1500.dxf' });
    ok('…or of the size the file name states', n.plate.length === 3000 && n.parts.length === 2);
    n = readNestDxf(file([...frame, ...inner]));
    ok('with nothing to say what a plate is, the outer rectangle stays the plate — and `plate.inside` names the rectangle that may be the real one', n.plate.length === 3600 && n.plate.inside?.length === 3000 && n.plate.inside?.width === 1500, JSON.stringify(n.plate));
    // A plate of a catalog size holding one big holed rectangle is not a frame.
    n = readNestDxf(file([PL('0', rect(0, 0, 3000, 1500)), PL('0', rect(100, 100, 2500, 1250)), PL('0', rect(300, 300, 200, 200)), PL('0', rect(900, 300, 200, 200))]), { plateSizes: [{ length: 3000, width: 1500 }, { length: 2500, width: 1250 }] });
    ok('a plate of a catalog size is never peeled, even when the one part on it is the size of another plate', n.plate.length === 3000 && n.parts.length === 1 && n.parts[0].rings.cutouts.length === 2, JSON.stringify([n.plate.length, n.parts.length]));

    // Words: a bare "25 mm" is a dimension, not a thickness; the file name wins over the words.
    n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400)), TX('0', [1400, 300], 20, '25 mm'), TX('0', [1500, 1530], 40, '3000')]), { filename: 'N62_12mm_E350_3000x1500.dxf' });
    ok('a loose "25 mm" is not the plate\'s thickness: the file name\'s 12 mm is', n.hints.thicknessMm === 12 && n.hints.from.thicknessMm === 'file name', JSON.stringify(n.hints));
    n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400)), TX('0', [1400, 300], 20, '25 mm')]));
    ok('…and with no file name it is no thickness at all', n.hints.thicknessMm === null);
    n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400)), TX('TITLE', [0, -200], 60, 'MATERIAL: IS 2062 E350 BR   THK 16')]), { filename: 'N9_12mm_3000x1500.dxf' });
    ok('a title that says THK 16 against a file name that says 12mm: the name is taken, and a note says they disagree', n.hints.thicknessMm === 12 && n.hints.grade != null && n.warnings.some((w) => /say 16 mm thick and the file name says 12 mm — the file name is taken/.test(w)), JSON.stringify([n.hints, n.warnings]));
    for (const [words, t] of [['PL 12 x 3000 x 1500 E350', 12], ['THK 16', 16], ['20 THK', 20], ['T = 25', 25], ['PL 10', 10], ['Nest N-1  |  12 mm  |  E350  |  3000 x 1500', 12]]) {
      n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400)), TX('TITLE', [0, -200], 60, words)]));
      ok(`"${words}" in the title is ${t} mm`, n.hints.thicknessMm === t && n.hints.from.thicknessMm === 'words', JSON.stringify(n.hints));
    }

    // A crop line across a plate drawn as loose lines.
    const loose = [...sides('0', rect(0, 0, 3000, 1500)), PL('0', rect(100, 100, 1200, 400))];
    n = readNestDxf(file([...loose, LN('REMNANT', [2000, 0], [2000, 1500])]));
    ok('a crop line on a REMNANT layer does not split the plate: it is 3000 × 1500 and a note says the line was ignored', n.plate.length === 3000 && n.plate.width === 1500 && n.parts.length === 1 && n.warnings.some((w) => /offcut \/ remnant layer/.test(w)), JSON.stringify([n.plate.length, n.parts.length, n.warnings]));
    n = readNestDxf(file([...loose, LN('0', [2000, 0], [2000, 1500])]), { plateSizes: [{ length: 3000, width: 1500 }] });
    const rest = matchNest(n, [R]);
    ok('a crop line on layer 0: the two halves together are the 3000 × 1500 plate, and the empty half is scrap, not an unknown part', n.plate.found === 'outline' && n.plate.length === 3000 && rest.placements.length === 1 && rest.unmatched.every((u) => u.maybeScrap), JSON.stringify([n.plate, rest.placements.length, rest.unmatched]));

    // Inches with no units in the header.
    const inch = file([plate, PL('CUT', rect(100, 100, 1200, 400)), TX('TXT', [700, 300], 30, 'R-1')], { insunits: null, scale: 1 / 25.4 });
    n = readNestDxf(inch);
    const asMm = matchNest(n, [R, Q]);
    const n2 = readNestDxf(inch, { units: 'in' });
    const asIn = matchNest(n2, [R, Q]);
    ok('a file in inches with no units: unitsStated is false and nothing matches as mm; read again with units: "in" the part matches', n.unitsStated === false && n.units === 'mm' && asMm.placements.length === 0 && n2.units === 'in' && asIn.placements.length === 1 && Math.abs(n2.plate.length - 3000) < 0.01, JSON.stringify([n.unitsStated, asMm.placements.length, n2.units, asIn.placements.length, n2.plate.length]));
    ok('a file that states millimetres says unitsStated: true', readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400))])).unitsStated === true);
  }

  section('18. Marking is not a cut-out: by where it lies, its layer and its colour');
  {
    const letters = (layer, colour = null) => [PL(layer, rect(200, 350, 40, 70), colour), PL(layer, rect(260, 350, 40, 70), colour)];
    // A layout line inside the part on layer M gives the layer away: the closed letters on it are marking.
    let n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400)), ...letters('LAYER_3'), LN('LAYER_3', [700, 100], [700, 500])]));
    ok('closed letters on the layer of an open marking line inside the part are left out of it', n.parts.length === 1 && n.parts[0].rings.cutouts.length === 0 && !n.parts[0].ringsNoMarks && n.markingStyles.includes('LAYER_3|') && n.warnings.some((w) => /2 closed shapes inside parts.*read as marking/.test(w)) && n.warnings.some((w) => /1 open line inside parts ignored/.test(w)), JSON.stringify([n.parts[0].rings.cutouts.length, n.markingStyles, n.warnings]));
    // The same by COLOUR on the cut layer.
    n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400), 1), ...letters('CUT', 2), LN('CUT', [700, 150], [700, 450], 2)]));
    ok('…and the same told apart only by colour (62)', n.parts[0].rings.cutouts.length === 0 && n.markingStyles.includes('CUT|2'), JSON.stringify([n.parts[0].rings.cutouts.length, n.markingStyles]));
    // No marking line: nothing says what the letters are. The part comes both ways.
    n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400)), ...letters('LAYER_3')]));
    const p = n.parts[0];
    ok('closed shapes in another layer with nothing to give them away: the part comes with them (`rings`) and without (`ringsNoMarks`)', p.rings.cutouts.length === 2 && p.ringsNoMarks?.cutouts.length === 0 && p.unsureMarks === 2 && p.unsureStyle === 'layer LAYER_3' && p.areaNoMarks === 480000, JSON.stringify([p.rings.cutouts.length, p.ringsNoMarks, p.unsureMarks, p.unsureStyle]));
    let m = matchNest(n, [R]);
    ok('…a cut plate with no drawing is matched without them, and the placement says how many were left out', m.placements[0]?.candidateKey === 'r' && m.placements[0].marksLeftOut === 2, JSON.stringify(m.placements));
    const windowed = { key: 'w', codes: ['W-1'], rings: [rect(0, 0, 1200, 400), rect(100, 250, 40, 70), rect(160, 250, 40, 70)], length: 1200, width: 400 };
    m = matchNest(n, [windowed]);
    ok('…a cut plate whose DRAWING has those two openings is matched with them: they are cut-outs', m.placements[0]?.candidateKey === 'w' && !m.placements[0].marksLeftOut && m.placements[0].by === 'shape', JSON.stringify(m.placements));
    // Round holes are holes whatever layer they are on; the same layer as the outline is a cut-out.
    n = readNestDxf(file([plate, PL('CUT', rect(100, 100, 1200, 400)), ['0', 'CIRCLE', '8', 'HOLES', '10', '300', '20', '300', '40', '11'], PL('CUT', rect(600, 250, 100, 100))]));
    ok('a drill-size circle on another layer is a hole, and a closed shape on the outline\'s own layer a cut-out — neither is in doubt', n.parts[0].rings.holes.length === 1 && n.parts[0].rings.cutouts.length === 1 && !n.parts[0].ringsNoMarks);
    // A marking line from edge to edge of a part drawn as loose lines, in another colour.
    const split = file([plate, ...sides('CUT', rect(100, 100, 1200, 400), 1), LN('CUT', [700, 100], [700, 500], 2)]);
    n = readNestDxf(split);
    ok('a line of another colour from edge to edge splits the part in two — and the reader names the style to try as marking', n.parts.length === 2 && n.splitStyles.length === 1 && n.splitStyles[0] === 'CUT|2', JSON.stringify([n.parts.length, n.splitStyles]));
    n = readNestDxf(split, { markingStyles: n.splitStyles });
    ok('…read again with that style as marking, it is one 1200 × 400 part', n.parts.length === 1 && n.parts[0].bbox.length === 1200 && n.warnings.some((w) => /1 line drawn in a marking colour or layer read as marking/.test(w)), JSON.stringify([n.parts.length, n.warnings]));
    n = readNestDxf(file([plate, ...sides('CUT', rect(100, 100, 600, 400)), ...sides('CUT', rect(700, 100, 600, 400)).slice(0, 3)]));
    ok('a common cut in the parts\' own style is not offered as marking', n.parts.length === 2 && n.splitStyles.length === 0, JSON.stringify([n.parts.length, n.splitStyles]));
  }

  section('19. Kerf-compensated outlines: matched at nominal size only when EVERY part is oversize by the same offset');
  {
    const grown = (x, y, l, w, d) => rect(x - d, y - d, l + 2 * d, w + 2 * d);
    const labelled = (d1, d2 = d1) => file([plate, PL('CUT', grown(100, 100, 1200, 400, d1)), TX('TXT', [700, 300], 30, 'R-1'), PL('CUT', grown(100, 700, 800, 200, d2)), TX('TXT', [500, 800], 30, 'Q-1')]);
    let m = matchNest(readNestDxf(labelled(1.5)), [R, Q]);
    ok('every part 1.5 mm oversize all round: matched to its nominal size, the offset recorded', m.kerfOffsetMm === 1.5 && m.placements.length === 2 && m.unmatched.length === 0 && m.placements.every((p) => p.by === 'label'), JSON.stringify([m.kerfOffsetMm, m.placements.length, m.unmatched]));
    const at = m.placements.find((p) => p.candidateKey === 'r');
    ok('…and placed where the NOMINAL part is (100, 100), not where the torch path starts', Math.abs(at.x - 100) < 0.01 && Math.abs(at.y - 100) < 0.01 && Math.abs(m.nominal.get(at.partId).full.outline[0][0] - 100) < 0.01, JSON.stringify(at));
    m = matchNest(readNestDxf(labelled(1.5, 0)), [R, Q]);
    ok('one part oversize and one not: NOT kerf compensation — the oversize part stays unmatched at the ordinary tolerance', m.kerfOffsetMm === 0 && m.placements.length === 1 && m.unmatched.length === 1, JSON.stringify([m.kerfOffsetMm, m.placements.length, m.unmatched.length]));
    m = matchNest(readNestDxf(labelled(1.5, 0.6)), [R, Q]);
    ok('two parts oversize by DIFFERENT offsets (1.5 and 0.6): not uniform, nothing is matched', m.kerfOffsetMm === 0 && m.placements.length === 0, JSON.stringify([m.kerfOffsetMm, m.placements.length]));
    m = matchNest(readNestDxf(labelled(4)), [R, Q]);
    ok('4 mm a side is more than half any kerf: not taken as compensation', m.kerfOffsetMm === 0 && m.placements.length === 0);
    m = matchNest(readNestDxf(labelled(1.5)), [R, Q], { kerfOffsetMaxMm: 0 });
    ok('kerfOffsetMaxMm: 0 switches it off', m.kerfOffsetMm === 0 && m.placements.length === 0);
    // The torch path with ROUNDED corners (an arc of the offset's radius round each corner), a shaped part with a hole, unlabelled, turned.
    const cand = candidateOf(S.gusset, { key: 'cp-gusset', codes: ['GP-7'] });
    const frameCand = candidateOf(S.frame, { key: 'cp-frame', codes: ['FR-1'] });
    const openRing = (r) => (Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 1e-9 ? r.slice(0, -1) : r);
    const nominal = placeRings(cand.rings, { x: 400, y: 300, rotationDeg: 33, mirrored: false }).map(openRing);
    const framed = placeRings(frameCand.rings, { x: 1500, y: 300, rotationDeg: 0, mirrored: false }).map(openRing);
    const d = 1.2;
    const round = (ring, out) => {            // every corner pushed out along both its sides' normals, with the arc between
      const ccw = ring.reduce((a, pt, i) => a + (ring[(i + ring.length - 1) % ring.length][0] * pt[1] - pt[0] * ring[(i + ring.length - 1) % ring.length][1]), 0) > 0 ? ring : ring.slice().reverse();
      const pts = [];
      for (let i = 0; i < ccw.length; i++) {
        const a = ccw[(i + ccw.length - 1) % ccw.length]; const b = ccw[i]; const c = ccw[(i + 1) % ccw.length];
        const n1 = Math.atan2(-(b[0] - a[0]), b[1] - a[1]) + (out ? 0 : Math.PI); const n2 = Math.atan2(-(c[0] - b[0]), c[1] - b[1]) + (out ? 0 : Math.PI);
        let sweep = n2 - n1; while (sweep > Math.PI) sweep -= 2 * Math.PI; while (sweep < -Math.PI) sweep += 2 * Math.PI;
        const convex = out ? sweep > 0 : sweep < 0;
        if (convex) for (let k = 0; k <= 6; k++) { const t = n1 + (sweep * k) / 6; pts.push([b[0] + d * Math.cos(t), b[1] + d * Math.sin(t)]); }
        else { const h = (n1 + sweep / 2); const r = d / Math.cos(sweep / 2); pts.push([b[0] + r * Math.cos(h), b[1] + r * Math.sin(h)]); }
      }
      return pts;
    };
    const torch = [nominal, framed].flatMap((rings) => [PL('CUT', round(rings[0], true)), ...rings.slice(1).map((r) => PL('CUT', round(r, false)))]);
    const nk = readNestDxf(file([plate, ...torch, PL('CUT', grown(100, 1000, 800, 200, d))]));
    m = matchNest(nk, [cand, frameCand, Q]);
    const g = m.placements.find((p) => p.candidateKey === 'cp-gusset');
    const fr = m.placements.find((p) => p.candidateKey === 'cp-frame');
    ok('a turned trapezoid and a frame with its window, drawn as the torch\'s path (rounded corners 1.2 mm out, the window 1.2 mm in): matched by shape at the nominal size', m.kerfOffsetMm === 1.2 && m.placements.length === 3 && g?.by === 'shape' && Math.abs(g.rotationDeg - 33) < 0.05 && ringsDeviation(placeRings(cand.rings, g), nominal) < 0.3 && fr?.by === 'shape' && ringsDeviation(placeRings(frameCand.rings, fr), framed) < 0.3, JSON.stringify([m.kerfOffsetMm, m.placements, m.unmatched]));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
