/**
 * nesting_learnings_test.mjs — the shop's cutting habits in our plate "AI" nesting (2026-10-18,
 * TM/nest_learning/LEARNINGS.md), and the true-shape accept fix (SO260014 N-002).
 *
 *   cd multi_app_be && node scripts/cf_kepl/nesting_learnings_test.mjs
 *
 * NO DATABASE: every plate below is made up and hand-checkable. Sections:
 *   0. accept of a true-shape plate: boxes overlap, outlines do not → accepted; outlines overlap → refused
 *   0b. accept of a cambered web: its box is its outline's, not LENGTH × WIDTH
 *   1. shop spacing as a setting (per thickness, defaults from the files) and what the packers get
 *   2. part in part: small parts in a frame's opening, cut BEFORE the opening
 *   3. true shape with quarter turns (tapered flanges interlock); free rotation only on request
 *   4. shared-line blocks: equal edges one kerf apart, one pierce per part
 *   5. marking: the part CODE before holes and outline
 *   6. leads, pierce, kerf side
 *   7. cut order: block by block along the plate, our sequences first, the small-part back-step
 *   8. the DXF: layers, closed polylines, mm — read back by our own DXF reader
 */
import { pairVerdict, nestRules, pickCutSettings, __acceptInternals } from '../../apps/cf_erp/services/nestingService.js';
import { verifyPlate, placeShape } from '../../apps/cf_erp/services/nestShapes.js';
import { shopKerfFor, shopRulesFor, withShopSpacing, shopRimOf, rotationsOf, SHOP_DEFAULTS } from '../../apps/cf_erp/services/shopRules.js';
import { planCuts, checkCutPlan, aiRulesOf } from '../../apps/cf_erp/services/aiCutPlan.js';
import { aiPlanToDxf } from '../../apps/cf_erp/services/aiNestDxf.js';
import { rimOf } from '../../apps/cf_erp/services/nestShapes.js';
import { packShapes, verifyLayout } from '../../apps/cf_erp/services/shapePacker.js';
import { nest as rowNest } from '../../apps/cf_erp/services/nestingPacker.js';
import { readNestDxf, matchNest } from '../../apps/cf_erp/lib/nestDxfReader.js';

let passed = 0; let failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${String(detail).slice(0, 600)}` : ''}`); if (cond) passed += 1; else failed += 1; };
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);

/* ───────────── 0. true shapes at accept ───────────── */
section('0. Accept of a true-shape plate (SO260014 N-002): the outlines decide, the same rule as the proposal');
{
  // A tapered flange 1254 long, 160 at one end and 60 at the other (16 mm). Two of them interlock:
  // the second turned 180°, its slanted edge parallel to the first one's. A's top edge runs
  // y = 160 − 100x/1254; B at 180° placed at y = Y has its bottom edge at y = Y + 100 − 100x/1254, so
  // the gap is (Y − 60)·cos(atan(100/1254)) = (Y − 60)·0.99683 mm. Kerf 3: legal from Y = 63.0095.
  const TAPER = { outline: [[0, 0], [1254, 0], [1254, 60], [0, 160]], cutouts: [], holes: [] };
  const k = 3;
  const cp = { id: 11, code: 'SO260014-1-16X160X1254-E250', name: 'TAPER', pieces: 2, manual: false, steel: { thickness: 16, length: 1254, width: 160, grade: 'E250', material: 'MS' } };
  const plate = { id: 900, code: 'PL16-2500x12000', steel: { thickness: 16, length: 12000, width: 2500, grade: 'E250', material: 'MS' } };
  const shapeOf = () => ({ rings: TAPER, drawn: true, area: 1254 * 110, length: 1254, width: 160 });
  const piece = (x, y, rot) => {
    const rings = placeShape(TAPER, { x, y, rotationDeg: rot, mirrored: false });
    const b = rings.outline.reduce((m, [px, py]) => ({ x0: Math.min(m.x0, px), y0: Math.min(m.y0, py), x1: Math.max(m.x1, px), y1: Math.max(m.y1, py) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    return { cutPlateId: 11, x: b.x0, y: b.y0, length: b.x1 - b.x0, width: b.y1 - b.y0, rotated: false, rotationDeg: rot, rings, placedRings: rings };
  };
  const accept = (pieces, { layout } = {}) => {
    const problems = []; const pending = [];
    const lot = { plate, settings: { kerfMm: k, seqGapMinMm: 5, seqGapMaxMm: 8 }, pieces: [] };
    const n = { pieces: pieces.map(({ rings, placedRings, ...p }) => p), ...(layout ? { layout } : {}) };
    __acceptInternals.verifyLot(lot, n, { label: 'Lot N-002', cpById: new Map([[11, cp]]), required: new Map([[11, 2]]), placed: new Map(), problems, shapeOf, pending });
    for (const q of pending) q.report(verifyPlate(q.args));
    return { problems, free: !!lot.free };
  };

  const A = piece(100, 10, 0);
  const goodB = piece(100, 10 + 63.2, 180);
  const closeB = piece(100, 10 + 62.0, 180);
  const badB = piece(100, 10 + 40, 180);
  ok('the boxes of the interlocked pair overlap (the old check refused this)', goodB.y < A.y + A.width);
  ok('pairVerdict: interlocked 0.2 mm beyond the kerf → legal, decided on the outlines', ['ok', 'shared'].includes(pairVerdict(A, goodB, k).kind) && pairVerdict(A, goodB, k).exact, J(pairVerdict(A, goodB, k)));
  ok('pairVerdict: 2 mm gap on a 3 mm kerf → too close', pairVerdict(A, closeB, k).kind === 'close', J(pairVerdict(A, closeB, k)));
  ok('pairVerdict: outlines share steel → overlap', pairVerdict(A, badB, k).kind === 'overlap', J(pairVerdict(A, badB, k)));
  const noRings = pairVerdict({ ...A, rings: null, placedRings: null }, { ...goodB, rings: null, placedRings: null }, k);
  ok('pairVerdict: without outlines the boxes decide (overlap)', noRings.kind === 'overlap');

  for (const layout of [undefined, 'free']) {
    const tag = layout ? 'plan says layout free' : 'plan does NOT say layout (the browser dropped it)';
    const g = accept([A, goodB], { layout });
    ok(`accept (${tag}): the interlocked pair is accepted, checked as a true-shape plate`, g.problems.length === 0 && g.free, J(g.problems));
    const b = accept([A, badB], { layout });
    ok(`accept (${tag}): outlines that overlap are refused "overlap"`, b.problems.length >= 1 && b.problems.some((p) => /overlap/.test(p)), J(b.problems));
    const c = accept([A, closeB], { layout });
    ok(`accept (${tag}): outlines nearer than the kerf are refused "closer than the 3 mm kerf"`, c.problems.length >= 1 && c.problems.some((p) => /closer than the 3 mm kerf/.test(p)), J(c.problems));
  }
  // The proposal's badge (nestRules) on the same plate says the same thing.
  const rulesOf = (q) => nestRules({ length: 12000, width: 2500, thickness: 16, pieces: [A, q].map((p) => ({ ...p, cutPlateCode: cp.code, seqNo: 1, rowNo: 1 })) }, { kerfMm: k, seqGapMinMm: 5, seqGapMaxMm: 8 });
  const spacing = (r) => r.checks.find((c) => c.key === 'spacing');
  ok('nestRules (the proposal badge): interlocked pair → spacing ok', spacing(rulesOf(goodB)).ok === true, J(spacing(rulesOf(goodB))));
  ok('nestRules: overlapping outlines → spacing fails "overlap"', spacing(rulesOf(badB)).ok === false && /overlap/.test(spacing(rulesOf(badB)).label));
  ok('nestRules: too close → spacing fails "closer than kerf"', spacing(rulesOf(closeB)).ok === false && /closer/.test(spacing(rulesOf(closeB)).label));
}

section('0b. Accept of a cambered web placed by true shape: its box is the OUTLINE\'s box, not LENGTH × WIDTH (SO260014 18 mm)');
{
  // A web 7650 long, 1350 deep, cambered 23.8 mm (the arc flattened to a polyline): its box is
  // 7650 × 1373.8. The old accept refused "it is drawn 7650 × 1373.8 but … is 7650 × 1350".
  const L = 7650; const D = 1350; const C = 23.8; const N = 24;
  const top = []; const bot = [];
  for (let i = 0; i <= N; i += 1) { const x = (L * i) / N; const c = C * (1 - ((2 * x) / L - 1) ** 2); bot.push([x, c]); top.push([x, c + D]); }
  const WEB = { outline: [...bot, ...top.reverse()], cutouts: [], holes: [] };
  const k = 4;
  const cp = { id: 21, code: 'SO260014-1-18X1350X7650-E250', name: 'WEB', pieces: 2, manual: false, steel: { thickness: 18, length: L, width: D, grade: 'E250', material: 'MS' } };
  const plate = { id: 901, code: 'PL18-8000x12000', steel: { thickness: 18, length: 12000, width: 8000, grade: 'E250', material: 'MS' } };
  const shapeOf = () => ({ rings: WEB, drawn: true, area: L * D, length: L, width: D });
  const piece = (x, y, rot) => {
    const rings = placeShape(WEB, { x, y, rotationDeg: rot, mirrored: false });
    const xs = rings.outline.map((p) => p[0]); const ys = rings.outline.map((p) => p[1]);
    return { cutPlateId: 21, x: Math.min(...xs), y: Math.min(...ys), length: Math.max(...xs) - Math.min(...xs), width: Math.max(...ys) - Math.min(...ys), rotated: false, rotationDeg: rot };
  };
  const accept = (pieces, layout) => {
    const problems = []; const pending = [];
    const lot = { plate, settings: { kerfMm: k, seqGapMinMm: 5, seqGapMaxMm: 8 }, pieces: [] };
    __acceptInternals.verifyLot(lot, { pieces, ...(layout ? { layout } : {}) }, { label: 'Lot N-002', cpById: new Map([[21, cp]]), required: new Map([[21, 2]]), placed: new Map(), problems, shapeOf, pending });
    for (const q of pending) q.report(verifyPlate(q.args));
    return problems;
  };
  const a = piece(10, 10, 0);
  ok(`the web's drawn box is ${a.length} × ${Math.round(a.width * 10) / 10}, not ${L} × ${D}`, Math.abs(a.width - (D + C)) < 0.05);
  // Two webs nested camber into camber: the second one's bottom follows the first one's top, kerf apart.
  const b = piece(10, 10 + D + 4.2, 0);
  for (const layout of [undefined, 'free']) {
    const tag = layout ? 'layout free' : 'no layout said';
    const g = accept([a, b], layout);
    ok(`accept (${tag}): two cambered webs, camber in camber, 4.2 mm apart on a 4 mm kerf → accepted`, g.length === 0, J(g));
    const bad = accept([a, piece(10, 10 + D + 2, 0)], layout);
    ok(`accept (${tag}): the same 2 mm apart → refused on the outline (closer than the kerf)`, bad.some((p) => /closer than the 4 mm kerf/.test(p)), J(bad));
    const rim = accept([piece(2, 10, 0), b], layout);
    ok(`accept (${tag}): a web 2 mm from the plate edge → refused at the rim`, rim.some((p) => /edge/.test(p)), J(rim));
    const turned = accept([piece(10, 10, 90), piece(10 + D + C + 10, 10, 270)], layout);
    ok(`accept (${tag}): webs turned 90° / 270° are accepted at their outline's box`, turned.length === 0, J(turned));
  }
}

/* ───────────── helpers for the plans below ───────────── */
const rect = (x, y, l, w) => ({ outline: [[x, y], [x + l, y], [x + l, y + w], [x, y + w]], cutouts: [], holes: [] });
const circle = (cx, cy, d, n = 24) => Array.from({ length: n }, (_, i) => [cx + (d / 2) * Math.cos((2 * Math.PI * i) / n), cy + (d / 2) * Math.sin((2 * Math.PI * i) / n)]);
const RULES = (k = 3, extra = {}) => ({ ...aiRulesOf({ kerfMm: k }), ...extra });
const stepsOf = (plan, part) => plan.steps.filter((s) => s.part === part);
const distToRing = (p, ring) => { let d = Infinity; for (let i = 0; i < ring.length; i += 1) { const a = ring[i]; const b = ring[(i + 1) % ring.length]; const ab = [b[0] - a[0], b[1] - a[1]]; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2 || 1))); d = Math.min(d, Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1])); } return d; };

/* ───────────── 1. spacing ───────────── */
section('1. Shop spacing: a setting per thickness, the files as defaults, what the packers are handed');
{
  const want = { 10: 3, 12: 3, 16: 3, 20: 4, 25: 4, 36: 5, 45: 5, 18: 4, 30: 4, 6: 3, 50: 5, 40: 5 };
  ok(`kerf from the files: ${Object.entries(want).map(([t, k]) => `${t}→${k}`).join(' ')} (nearest; 18 mm ties 16/20 → the wider)`, Object.entries(want).every(([t, k]) => shopKerfFor(Number(t)) === k), J(Object.keys(want).map((t) => shopKerfFor(Number(t)))));
  const d = shopRulesFor(16);
  ok('defaults: edge 5, part gap 5, block gap 13, leads 6 / 2, hole arc 6, common line 6.35 / 1.27, pierce 6 off, quarter turns only',
    d.edgeMarginMm === 5 && d.partGapMm === 5 && d.groupGapMm === 13 && d.leadInMm === 6 && d.leadOutMm === 2 && d.holeLeadRadiusMm === 6 && d.sharedLeadInMm === 6.35 && d.sharedLeadOutMm === 1.27 && d.pierceOffsetMm === 6 && d.freeRotationStepDeg === null && d.source.groupGapMm === 'files');
  const saved = [{ thickness_mm: 12, group_gap_mm: 11, edge_margin_mm: null }, { thickness_mm: 36, part_gap_mm: 5.2, group_gap_mm: 14 }];
  const r12 = shopRulesFor(12, saved); const r13 = shopRulesFor(13, saved); const r16 = shopRulesFor(16, saved); const r40 = shopRulesFor(40, saved); const r24 = shopRulesFor(24, saved);
  ok('a saved row decides its own thickness and the ones nearer to it than to any thickness of the files (12 → 11, 13 → 11; 16 is a files thickness → 13; 40 ties the 36 row with the files → the row: 14 / 5.2; 24 → the files 13)', r12.groupGapMm === 11 && r12.source.groupGapMm === 'saved 12 mm' && r13.groupGapMm === 11 && r16.groupGapMm === 13 && r16.source.groupGapMm === 'files' && r40.groupGapMm === 14 && r40.partGapMm === 5.2 && r24.groupGapMm === 13 && r16.edgeMarginMm === 5, J([r12.groupGapMm, r13.groupGapMm, r16.groupGapMm, r40.groupGapMm, r40.partGapMm, r24.groupGapMm]));
  const band = { id: 1, kerfMm: 5, seqGapMinMm: 5, seqGapMaxMm: 8, basis: '25–50 mm band' };
  ok('switch OFF: the cut settings come back untouched (the same object)', withShopSpacing(band, { on: false, rows: [] }, 25) === band);
  const on = withShopSpacing(band, { on: true, rows: [] }, 25);
  ok('switch ON at 25 mm: kerf stays the band\'s 5 mm, the files said 4 (kerfDiffers); blocks 13 apart (seqGapMin 13, max ≥ 13); edge 5', on.kerfMm === 5 && on.shopKerfMm === 4 && on.kerfDiffers && on.seqGapMinMm === 13 && on.seqGapMaxMm >= 13 && on.edgeMarginMm === 5 && on.shopSpacing, J(on));
  const rimOff = shopRimOf({ kerfMm: 3 }, rimOf); const rimOn = shopRimOf(withShopSpacing({ kerfMm: 3, seqGapMinMm: 5, seqGapMaxMm: 8, basis: 'x' }, { on: true, rows: [] }, 12), rimOf);
  ok('the rim: OFF = one kerf (rows add 0, shapes 3); ON = the 5 mm edge (rows add 2 to their own kerf, shapes 5)', rimOff.rectMargin === 0 && rimOff.shapeMargin === 3 && rimOn.rectMargin === 2 && rimOn.shapeMargin === 5, J([rimOff, rimOn]));
  const rows = [{ id: 1, thickness_min_mm: 5, thickness_max_mm: 16, kerf_mm: 3, seq_gap_min_mm: 5, seq_gap_max_mm: 8, order_margin_length_mm: 100, order_margin_width_mm: 50, order_step_mm: 50, guillotine: 0 }];
  Object.defineProperty(rows, 'shop', { value: { on: true, rows: [{ thickness_mm: 12, group_gap_mm: 12 }] } });
  const pk = pickCutSettings(rows, 12);
  ok('pickCutSettings lays the company\'s shop spacing over the band (12 mm: kerf 3, blocks 12 apart from the saved row, edge 5)', pk.kerfMm === 3 && pk.seqGapMinMm === 12 && pk.edgeMarginMm === 5 && pk.shopSpacing, J(pk));
  const plain = [...rows]; // no `shop` → off
  ok('…and without the switch it is the band exactly as before', pickCutSettings(plain, 12).seqGapMinMm === 5 && pickCutSettings(plain, 12).shopSpacing === undefined);

  // The row packer with the shop's spacing: every part ≥ 5 mm from the edge, sequences (blocks) ≥ 13 apart,
  // equal-height neighbours one kerf apart (a shared cut), separate cuts ≥ the 5 mm part gap.
  const set = withShopSpacing({ kerfMm: 3, seqGapMinMm: 5, seqGapMaxMm: 8, basis: 'x' }, { on: true, rows: [] }, 12);
  const rim = shopRimOf(set, rimOf);
  const res = rowNest({ pieces: [{ key: 'st', length: 1500, width: 160, qty: 12 }, { key: 'gp', length: 300, width: 250, qty: 9 }, { key: 'pk', length: 120, width: 80, qty: 14 }],
    sheets: [{ key: 'S', length: 6000, width: 2000 }], kerf: set.kerfMm, margin: rim.rectMargin, sequenceGap: set.seqGapMinMm, effort: 'quick' });
  const ps = res.nests.flatMap((n) => n.pieces.map((p) => ({ ...p, L: n.length ?? 6000, W: n.width ?? 2000 })));
  const edge = Math.min(...ps.map((p) => Math.min(p.x, p.y, 6000 - (p.x + p.length), 2000 - (p.y + p.width))));
  ok(`row packer, shop spacing on: ${ps.length} pieces on ${res.nests.length} plate(s), closest to the edge ${edge.toFixed(2)} mm (≥ 5)`, ps.length === 35 && edge >= 5 - 1e-6, J(res.unplaced));
  let close = 0; let sharedN = 0; let seqClose = 0;
  for (const n of res.nests) {
    for (let i = 0; i < n.pieces.length; i += 1) for (let j = i + 1; j < n.pieces.length; j += 1) {
      const p = n.pieces[i]; const q = n.pieces[j];
      const v = pairVerdict(p, q, 3);
      if (v.kind === 'shared') { sharedN += 1; if (p.sequence !== q.sequence) seqClose += 1; continue; }
      // diagonal neighbours of a common-cut grid sit a kerf off on BOTH axes: corners across a crossing, not a gap
      const sx = Math.max(q.x - (p.x + p.length), p.x - (q.x + q.length)); const sy = Math.max(q.y - (p.y + p.width), p.y - (q.y + q.width));
      if (Math.abs(sx - 3) < 1e-3 && Math.abs(sy - 3) < 1e-3) continue;
      if (v.sep < 5 - 1e-6) close += 1;
      if (p.sequence !== q.sequence && v.sep < 13 - 1e-6) seqClose += 1;
    }
  }
  ok(`…${sharedN} shared cuts (one kerf), no two separately cut parts nearer than 5 mm, no two sequences nearer than 13 mm`, sharedN > 0 && close === 0 && seqClose === 0, J({ sharedN, close, seqClose }));
  // The true-shape packer with the shop's edge margin.
  const sp = packShapes({ pieces: [{ key: 'a', length: 400, width: 300, qty: 6 }], sheets: [{ key: 'S', length: 2000, width: 1000 }], kerf: 3, margin: rim.shapeMargin, effort: 'quick', budgetMs: 2000 });
  const edge2 = Math.min(...sp.nests.flatMap((n) => n.placements.map((p) => { const xs = p.rings.outline.map((q) => q[0]); const ys = p.rings.outline.map((q) => q[1]); return Math.min(Math.min(...xs), Math.min(...ys), 2000 - Math.max(...xs), 1000 - Math.max(...ys)); })));
  ok(`true-shape packer handed the shop rim: closest to the edge ${edge2.toFixed(2)} mm (≥ 5)`, edge2 >= 5 - 1e-6);
}

/* ───────────── 2. part in part ───────────── */
section('2. Part in part: small parts nested in a frame\'s opening, always cut before the opening');
{
  // A frame 900 × 600 with a window 760 × 460; four 300 × 180 plates fit the window (2 × 2 with kerf).
  const frame = { outline: [[0, 0], [900, 0], [900, 600], [0, 600]], cutouts: [[[70, 70], [830, 70], [830, 530], [70, 530]]], holes: [] };
  const sp = packShapes({ pieces: [{ key: 'frame', rings: frame, qty: 1 }, { key: 'plate', length: 300, width: 180, qty: 4 }], sheets: [{ key: 'S', length: 1200, width: 800 }], kerf: 3, margin: 5, effort: 'quick', budgetMs: 4000 });
  ok(`the true-shape packer puts everything on ONE 1200 × 800 plate (only possible with the plates in the window): ${sp.nests.length} plate(s), ${sp.unplaced.length} left`, sp.nests.length === 1 && sp.unplaced.length === 0);
  const n0 = sp.nests[0];
  const plan = planCuts({ plate: { length: 1200, width: 800 }, pieces: n0.placements.map((p) => ({ key: p.key, code: p.key === 'frame' ? 'FR-1' : 'PL-1', rings: p.rings })), rules: RULES(3) });
  const host = plan.parts.find((p) => p.code === 'FR-1').idx;
  const inWindow = n0.placements.filter((p) => p.key === 'plate' && p.rings.outline.every(([x, y]) => x > 0 && y > 0) && (() => { const f = n0.placements.find((q) => q.key === 'frame').rings.outline; const xs = f.map((q) => q[0]); const ys = f.map((q) => q[1]); return p.rings.outline.every(([x, y]) => x > Math.min(...xs) + 69 && x < Math.max(...xs) - 69 && y > Math.min(...ys) + 69 && y < Math.max(...ys) - 69); })()).length;
  ok(`the plan finds the parts in the opening: ${plan.partInPart.length} (the packer put ${inWindow} plates in the window)`, plan.partInPart.length >= 1 && plan.partInPart.length === inWindow && plan.partInPart.every((x) => x.host === host && x.opening === 0), J(plan.partInPart));
  const opening = plan.steps.find((s) => s.part === host && s.kind === 'hole');
  const innerLast = Math.max(...plan.partInPart.map((x) => Math.max(...stepsOf(plan, x.inner).map((s) => s.n))));
  ok(`every inner part is cut (step ≤ ${innerLast}) before the opening (step ${opening.n}) and before the frame's outline`, innerLast < opening.n && opening.inners.length === inWindow && plan.check.ok, J(plan.check.problems));
  ok('…although along the plate the frame starts first (the inner parts were moved before it: forcedByInner)', plan.units.filter((u) => u.forcedByInner).length >= 1);
  // A hand-made layout where the inner part lies far along the plate: the rule still holds.
  const lay = [{ key: 'F', code: 'FR', rings: { outline: [[10, 10], [2010, 10], [2010, 1010], [10, 1010]], cutouts: [[[100, 100], [1900, 100], [1900, 900], [100, 900]]], holes: [] } },
    { key: 'I', code: 'IN', rings: rect(1700, 500, 150, 150) }, { key: 'X', code: 'X1', rings: rect(2100, 10, 400, 400) }];
  const p2 = planCuts({ plate: { length: 3000, width: 1500 }, pieces: lay, rules: RULES(3) });
  ok('a hand layout: the inner part IN (x 1700) before FR\'s opening, FR before X1 further along', p2.check.ok && Math.max(...stepsOf(p2, 1).map((s) => s.n)) < p2.steps.find((s) => s.part === 0 && s.kind === 'hole').n
    && Math.max(...stepsOf(p2, 0).map((s) => s.n)) < Math.min(...stepsOf(p2, 2).map((s) => s.n)), J(p2.steps.map((s) => [s.n, s.kind, s.part])));
  // Doctor it: swap the inner part after the opening → the check refuses.
  const bad = JSON.parse(JSON.stringify(p2));
  const iSteps = bad.steps.filter((s) => s.part === 1); bad.steps = [...bad.steps.filter((s) => s.part !== 1), ...iSteps];
  ok('a plan that cuts the inner part after the opening is refused (INNER_AFTER_OPENING)', checkCutPlan(bad).problems.some((x) => x.kind === 'INNER_AFTER_OPENING'));
}

/* ───────────── 3. true shape, rotations ───────────── */
section('3. True shape with quarter turns: tapered flanges interlock; free rotation only when asked');
{
  const TAPER = { outline: [[0, 0], [1200, 0], [1200, 80], [0, 240]], cutouts: [], holes: [] };
  const sp = packShapes({ pieces: [{ key: 'tf', rings: TAPER, qty: 8 }], sheets: [{ key: 'S', length: 1300, width: 2000 }], kerf: 3, margin: 5, rotations: rotationsOf({}), effort: 'quick', budgetMs: 5000 });
  const pl = sp.nests.flatMap((n) => n.placements);
  ok(`8 tapered flanges placed (${pl.length}), every turn one of 0/90/180/270 (${[...new Set(pl.map((p) => p.rotationDeg))].join(', ')})`, pl.length === 8 && pl.every((p) => [0, 90, 180, 270].includes(p.rotationDeg)));
  const boxes = pl.map((p) => { const xs = p.rings.outline.map((q) => q[0]); const ys = p.rings.outline.map((q) => q[1]); return { x: Math.min(...xs), y: Math.min(...ys), length: Math.max(...xs) - Math.min(...xs), width: Math.max(...ys) - Math.min(...ys), rings: p.rings }; });
  let interlocked = 0;
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) { const a = boxes[i]; const b = boxes[j]; if (Math.max(b.x - (a.x + a.length), a.x - (b.x + b.length), b.y - (a.y + a.width), a.y - (b.y + b.width)) < 0) interlocked += 1; }
  const used = Math.max(...boxes.map((b) => b.y + b.width));
  ok(`the flanges interlock by their true shape (${interlocked} pairs whose boxes overlap), using ${used.toFixed(0)} mm of plate where boxes would need ${8 * 240 + 7 * 3 + 5}`, interlocked >= 3 && used < 8 * 240);
  ok('…and the layout is legal on the outlines (verifyLayout)', sp.nests.every((n) => verifyLayout({ sheet: { length: 1300, width: 2000 }, placements: n.placements, kerf: 3, margin: 5 }).ok));
  ok('rotations: the default is the quarter turns; a free step only with the setting (15°)', J(rotationsOf({})) === J([0, 90, 180, 270]) && J(rotationsOf({ freeRotationStepDeg: 15 })) === J({ stepDeg: 15 }) && J(rotationsOf({ freeRotationStepDeg: 90 })) === J([0, 90, 180, 270]));
  const tri = { outline: [[0, 0], [400, 0], [0, 300]], cutouts: [], holes: [] };
  const fr = packShapes({ pieces: [{ key: 'g', rings: tri, qty: 4 }], sheets: [{ key: 'S', length: 1000, width: 1000 }], kerf: 3, margin: 5, rotations: rotationsOf({ freeRotationStepDeg: 15 }), effort: 'quick', budgetMs: 3000 });
  ok('free rotation (15° steps) when asked: every turn a multiple of 15°', fr.nests.flatMap((n) => n.placements).every((p) => Math.abs(p.rotationDeg / 15 - Math.round(p.rotationDeg / 15)) < 1e-9) && fr.unplaced.length === 0);
}

/* ───────────── 4. shared-line blocks ───────────── */
section('4. Shared-line (common-line) blocks: equal edges one kerf apart, one pierce per part');
{
  const k = 3;
  // five strips 1500 × 160 stacked a kerf apart; a plate 1500 × 120 with an equal 1500 edge on top of them;
  // a 1400 × 160 strip beside them a kerf away (unequal edge → not in the block); a loose gusset.
  const pcs = [];
  for (let i = 0; i < 5; i += 1) pcs.push({ key: `s${i}`, code: `ST-${i + 1}`, rings: rect(10, 10 + i * (160 + k), 1500, 160) });
  pcs.push({ key: 'cp', code: 'CP-1', rings: rect(10, 10 + 5 * (160 + k), 1500, 120) });
  pcs.push({ key: 'u', code: 'UN-1', rings: rect(10 + 1500 + k, 10, 1400, 150) });
  pcs.push({ key: 'g', code: 'GP-1', rings: rect(3200, 10, 300, 300) });
  const plan = planCuts({ plate: { length: 4000, width: 2000 }, pieces: pcs, rules: RULES(k) });
  const blocks = plan.groups;
  ok(`one block of 6 (five strips + the equal-edged cover plate, mixed parts are fine): ${blocks.map((g) => g.members.length).join(', ')}`, blocks.length === 1 && blocks[0].members.length === 6 && blocks[0].sharedEdges.length === 5, J(blocks));
  ok('the 1400 × 150 strip a kerf away is NOT in it (its 150 end does not equal the 160 one); the gusset stands alone', !blocks[0].members.includes(6) && !blocks[0].members.includes(7));
  ok(`shared cut length ${blocks[0].sharedLengthMm} mm = 5 × 1500`, Math.abs(blocks[0].sharedLengthMm - 7500) < 1e-6);
  const st = plan.steps.filter((s) => blocks[0].members.includes(s.part) && s.kind !== 'mark');
  ok(`in the block: the first part a full outline, every further part ONE open stroke (${st.map((s) => s.kind[0]).join('')}), one pierce per part`, st.length === 6 && st[0].kind === 'outline' && st.slice(1).every((s) => s.kind === 'stroke' && !s.closed && s.path.length === 4));
  ok('the block is cut in one go (no other part between its steps), the check is clean', plan.check.ok && plan.check.problems.length === 0, J(plan.check.problems));
  ok('strip by strip, top to bottom (the cover plate on top first, then ST-5 … ST-1)', J(st.map((s) => plan.parts[s.part].code)) === J(['CP-1', 'ST-5', 'ST-4', 'ST-3', 'ST-2', 'ST-1']), J(st.map((s) => plan.parts[s.part].code)));
  ok(`counts: ${plan.counts.blocks} block, ${plan.counts.inBlocks} parts in blocks, ${plan.counts.strokes} strokes`, plan.counts.blocks === 1 && plan.counts.inBlocks === 6 && plan.counts.strokes === 5);
  const noK = planCuts({ plate: { length: 4000, width: 2000 }, pieces: [{ key: 'a', rings: rect(10, 10, 500, 100) }, { key: 'b', rings: rect(10, 115, 500, 100) }], rules: RULES(k) });
  ok('parts 5 mm apart on a 3 mm kerf are cut separately (no block)', noK.groups.length === 0 && noK.steps.filter((s) => s.kind === 'outline').length === 2);
}

/* ───────────── 5. marking ───────────── */
section('5. Marking: the part CODE, single-stroke text, before the holes and the outline');
{
  const web = { outline: [[10, 10], [2010, 10], [2010, 810], [10, 810]], cutouts: [], holes: [circle(300, 400, 40), circle(1700, 400, 40)] };
  const plan = planCuts({ plate: { length: 2500, width: 1000 }, pieces: [{ key: 'w', code: 'WEB-1', rings: web }], rules: RULES(3) });
  const ks = plan.steps.map((s) => s.kind);
  ok(`order inside the part: ${ks.join(' → ')}`, J(ks) === J(['mark', 'hole', 'hole', 'outline']));
  const m = plan.steps[0];
  ok(`the mark is "${m.text}" at (${m.at.join(', ')}), ${m.heightMm} mm high, inside the part's steel, no pierce, no leads`, m.text === 'WEB-1' && m.at[0] > 10 && m.at[0] < 2010 && m.at[1] > 10 && m.at[1] < 810 && m.heightMm >= 3 && m.heightMm <= 100 && m.pierce == null && m.leadIn == null);
  const doctored = { ...plan, steps: [plan.steps[1], plan.steps[0], plan.steps[2], plan.steps[3]] };
  ok('a plan that marks after a hole is refused (PART_ORDER)', checkCutPlan(doctored).problems.some((p) => p.kind === 'PART_ORDER'));
  const off = planCuts({ plate: { length: 2500, width: 1000 }, pieces: [{ key: 'w', code: 'WEB-1', rings: web }], rules: RULES(3), options: { marking: false } });
  ok('marking can be turned off (options.marking false)', off.steps.every((s) => s.kind !== 'mark'));
}

/* ───────────── 6. leads ───────────── */
section('6. Leads, pierce points and kerf side');
{
  const web = { outline: [[100, 100], [1100, 100], [1100, 600], [100, 600]], cutouts: [], holes: [circle(600, 350, 80, 36), circle(300, 350, 10, 24)] };
  const plan = planCuts({ plate: { length: 2000, width: 1000 }, pieces: [{ key: 'w', code: 'P1', rings: web }], rules: RULES(3) });
  const o = plan.steps.find((s) => s.kind === 'outline');
  const S = o.path[0]; const u = [o.path[1][0] - S[0], o.path[1][1] - S[1]]; const ul = Math.hypot(...u);
  const P = o.pierce;
  ok(`outline: starts at a corner (${S.join(', ')}) — the one at the plate start (x min), the top one`, o.startAt === 'corner' && S[0] === 100 && S[1] === 600);
  ok('outline: straight lead-in of 6 mm in line with the first edge (pierce = start − 6 × the edge direction)', o.leadIn.type === 'line' && o.leadIn.lengthMm === 6 && o.leadIn.angleDeg === 0 && Math.abs(P[0] - (S[0] - (6 * u[0]) / ul)) < 1e-3 && Math.abs(P[1] - (S[1] - (6 * u[1]) / ul)) < 1e-3);
  ok(`outline: the pierce is in the scrap, ${distToRing(P, web.outline).toFixed(2)} mm off the part (6)`, Math.abs(distToRing(P, web.outline) - 6) < 1e-3);
  const E = o.leadOut.path[1]; const last = o.path[o.path.length - 2];
  const w = [S[0] - last[0], S[1] - last[1]]; const wl = Math.hypot(...w);
  ok('outline: lead-out straight 2 mm in line with the last edge, no overcut (overcutMm 0)', o.leadOut.lengthMm === 2 && Math.abs(E[0] - (S[0] + (2 * w[0]) / wl)) < 1e-3 && Math.abs(E[1] - (S[1] + (2 * w[1]) / wl)) < 1e-3 && plan.rules.overcutMm === 0);
  ok('outline: clockwise, kerf OUTSIDE', o.direction === 'cw' && o.kerfSide === 'outside');
  const holes = plan.steps.filter((s) => s.kind === 'hole');
  const big = holes.find((h) => h.path.some((q) => q[0] > 590));
  const hS = big.path[0];
  ok(`hole Ø80: arc lead-in radius 6, 90°, the pierce inside the hole ${Math.hypot(big.pierce[0] - hS[0], big.pierce[1] - hS[1]).toFixed(3)} mm from the start (6√2 = 8.485)`, big.leadIn.type === 'arc' && big.leadIn.radiusMm === 6 && big.leadIn.angleDeg === 90 && Math.abs(Math.hypot(big.pierce[0] - hS[0], big.pierce[1] - hS[1]) - 6 * Math.SQRT2) < 1e-2 && Math.hypot(big.pierce[0] - 600, big.pierce[1] - 350) < 40);
  ok('hole: counter-clockwise, kerf INSIDE, lead-out 2 mm into the hole', big.direction === 'ccw' && big.kerfSide === 'inside' && big.leadOut.lengthMm === 2 && Math.hypot(big.leadOut.path[1][0] - 600, big.leadOut.path[1][1] - 350) < 40);
  const small = holes.find((h) => h !== big);
  ok(`a Ø10 hole: the arc is shrunk to fit (${small.leadIn.radiusMm} mm), the pierce still inside the hole`, small.leadIn.shrunk && small.leadIn.radiusMm < 6 && Math.hypot(small.pierce[0] - 300, small.pierce[1] - 350) < 5);
  // A part pressed against a neighbour on the start side: the straight lead turns 90°, never into steel.
  const two = planCuts({ plate: { length: 3000, width: 1000 }, pieces: [{ key: 'a', rings: rect(10, 10, 500, 300) }, { key: 'b', rings: rect(515, 10, 500, 300) }], rules: RULES(3) });
  ok('every pierce of a two-part plate lies off both parts\' steel and inside the plate', two.steps.filter((s) => s.pierce).every((s) => s.pierceOk && s.pierce[0] >= 0 && s.pierce[1] >= 0));
  // common-line strokes
  const blk = planCuts({ plate: { length: 3000, width: 1000 }, pieces: [0, 1, 2].map((i) => ({ key: `s${i}`, rings: rect(10, 10 + i * 203, 1000, 200) })), rules: RULES(3) });
  const strokes = blk.steps.filter((s) => s.kind === 'stroke');
  ok(`common-line strokes: lead-in 6.35, lead-out 1.27 (${strokes.length} strokes)`, strokes.length === 2 && strokes.every((s) => s.leadIn.lengthMm === 6.35 && s.leadOut.lengthMm === 1.27));
  ok('…their pierce is not on a part already cut (a lead at 90° away from the part where in line would cross it)', strokes.every((s) => s.pierceOk) && blk.check.ok, J(strokes.map((s) => [s.leadIn.angleDeg, s.pierce])));
}

/* ───────────── 7. cut order ───────────── */
section('7. Cut order: block by block along the plate, our sequences first, the small-part back-step');
{
  const k = 3;
  // free layout: block A (x 10…), part B (x 1100…), part C (x 2300…), all big
  const lay = [
    { key: 'C', code: 'C', rings: rect(2300, 10, 600, 400) },
    { key: 'A1', code: 'A1', rings: rect(10, 10, 1000, 200) }, { key: 'A2', code: 'A2', rings: rect(10, 213, 1000, 200) },
    { key: 'B', code: 'B', rings: rect(1100, 10, 800, 900) },
  ];
  const plan = planCuts({ plate: { length: 3000, width: 1500 }, pieces: lay, rules: RULES(k) });
  const seqCodes = plan.units.map((u) => u.members.map((m) => plan.parts[m].code).join('+'));
  ok(`free layout: from the plate start to the far end, block by block: ${seqCodes.join(' → ')}`, J(seqCodes) === J(['A2+A1', 'B', 'C']) && plan.mode === 'free' && plan.check.ok);
  // the back-step: a small part at x 100 just above a tall part that starts at x 200
  const bs = [
    { key: 'A', code: 'A', rings: rect(10, 10, 3000, 500) },
    { key: 'T', code: 'T', rings: rect(200, 600, 800, 1300) },
    { key: 's', code: 's', rings: rect(100, 1905, 90, 60) },
  ];
  const withBs = planCuts({ plate: { length: 4000, width: 2000 }, pieces: bs, rules: RULES(k) });
  const order1 = withBs.units.map((u) => plan.parts && withBs.parts[u.members[0]].code);
  ok(`a small part in the gap by the tall part is cut right after it, stepping back along the plate: ${order1.join(' → ')}`, J(order1) === J(['A', 'T', 's']) && withBs.units[2].backStep && withBs.check.ok);
  const noBs = planCuts({ plate: { length: 4000, width: 2000 }, pieces: bs, rules: RULES(k), options: { smallBackStep: false } });
  ok(`…and in plain position order with the back-step off: ${noBs.units.map((u) => noBs.parts[u.members[0]].code).join(' → ')}`, J(noBs.units.map((u) => noBs.parts[u.members[0]].code)) === J(['A', 's', 'T']));
  const bigBack = JSON.parse(JSON.stringify(withBs)); bigBack.units[1].backStep = true; bigBack.units[1].small = false;
  ok('a BIG part stepping back is refused by the check (BACKSTEP_NOT_SMALL)', checkCutPlan(bigBack).problems.some((p) => p.kind === 'BACKSTEP_NOT_SMALL'));
  const split = JSON.parse(JSON.stringify(plan)); const a = split.steps.findIndex((s) => plan.parts[s.part].code === 'A1'); const b = split.steps.findIndex((s) => plan.parts[s.part].code === 'B');
  [split.steps[a], split.steps[b]] = [split.steps[b], split.steps[a]];
  ok('a block cut in two goes is refused (BLOCK_SPLIT)', checkCutPlan(split).problems.some((p) => p.kind === 'BLOCK_SPLIT'));

  // OUR ROW LAYOUT: sequences win over "along the plate". Pack with the row packer and plan its cut.
  const res = rowNest({ pieces: [{ key: 'st', length: 1500, width: 160, qty: 9 }, { key: 'gp', length: 300, width: 250, qty: 6 }, { key: 'pk', length: 120, width: 80, qty: 10 }],
    sheets: [{ key: 'S', length: 6000, width: 2000 }], kerf: k, margin: 0, sequenceGap: 6, effort: 'quick' });
  const n0 = res.nests[0];
  const rp = planCuts({ plate: { length: 6000, width: 2000 }, pieces: n0.pieces.map((p, i) => ({ key: i, code: `${p.key}`, x: p.x, y: p.y, length: p.length, width: p.width, seqNo: p.sequence, rowNo: p.row, posNo: p.order })), rules: RULES(k) });
  const seqs = rp.units.map((u) => u.seqNo);
  ok(`row layout (${n0.pieces.length} pieces, ${new Set(seqs).size} sequences): cut sequence by sequence — ${[...new Set(seqs)].join(', ')} — never back to an earlier one`, rp.mode === 'sequences' && seqs.every((s, i) => i === 0 || s >= seqs[i - 1]) && rp.check.ok, J(rp.check.problems));
  ok('…a shared-line block never spans two rows of it (our row → part order)', rp.groups.every((g) => new Set(g.members.map((m) => `${rp.parts[m].seqNo}:${rp.parts[m].rowNo}`)).size === 1));
  const bad = JSON.parse(JSON.stringify(rp)); bad.units.reverse();
  ok('a plan that goes back to an earlier sequence is refused (SEQUENCE_ORDER)', new Set(seqs).size < 2 || checkCutPlan(bad).problems.some((p) => p.kind === 'SEQUENCE_ORDER'));
  ok(`one pierce per part in the row layout's blocks: ${rp.counts.pierces} pierces for ${rp.counts.parts} parts`, rp.counts.pierces === rp.counts.parts);
}

/* ───────────── 8. the DXF ───────────── */
section('8. The DXF ProNest opens: layers, closed polylines, mm — and our own reader reads it back');
{
  const frame = { outline: [[10, 10], [910, 10], [910, 610], [10, 610]], cutouts: [[[80, 80], [840, 80], [840, 540], [80, 540]]], holes: [] };
  const pcs = [
    { key: 'F', code: 'FR-1', rings: frame },
    { key: 'I', code: 'PL-7', rings: rect(100, 100, 300, 180) },
    { key: 'W', code: 'WEB-1', rings: { outline: [[1000, 10], [2500, 10], [2500, 610], [1000, 610]], cutouts: [], holes: [circle(1200, 300, 40), circle(2300, 300, 40)] } },
    ...[0, 1, 2].map((i) => ({ key: `S${i}`, code: `ST-${i + 1}`, rings: rect(10, 700 + i * 163, 1500, 160) })),
  ];
  const plan = planCuts({ plate: { length: 3000, width: 1500 }, pieces: pcs, rules: RULES(3) });
  ok('the plan of the test plate is clean', plan.check.ok, J(plan.check.problems));
  for (const variant of [{ leads: false, order: false }, { leads: true, order: true }]) {
    const tag = variant.leads ? 'with LEADS and CUT_ORDER' : 'plain';
    const dxf = aiPlanToDxf({ lot: { lotNo: 'N-001', plateCode: 'PL', thickness: 12 }, plan, ...variant });
    const lines = dxf.split('\r\n');
    const pairs = []; for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
    const layerOf = []; for (let i = 0; i < pairs.length; i += 1) if (pairs[i][0] === '0' && pairs[i][1] === 'POLYLINE') { const ly = pairs.slice(i + 1, i + 3).find((p) => p[0] === '8')?.[1]; const fl = pairs.slice(i + 1, i + 8).find((p) => p[0] === '70')?.[1]; layerOf.push([ly, fl]); }
    const closedOn = (ly) => layerOf.filter(([l, f]) => l === ly && f === '1').length;
    ok(`${tag}: R12, mm ($INSUNITS 4, $MEASUREMENT 1), layers PLATE / OUTLINES / HOLES / MARKING${variant.leads ? ' / LEADS / CUT_ORDER' : ''}`, dxf.includes('AC1009') && /\$INSUNITS\r\n 70\r\n4|\$INSUNITS\r\n70\r\n4/.test(dxf) && ['PLATE', 'OUTLINES', 'HOLES', 'MARKING', ...(variant.leads ? ['LEADS', 'CUT_ORDER'] : [])].every((l) => dxf.includes(`\r\n${l}\r\n`)));
    ok(`${tag}: closed polylines — plate 1, outlines ${closedOn('OUTLINES')} (6 parts), holes ${closedOn('HOLES')} (the window + 2)`, closedOn('PLATE') === 1 && closedOn('OUTLINES') === 6 && closedOn('HOLES') === 3);
    ok(`${tag}: the part codes as single-stroke TEXT (style SIMPLEX → simplex.shx) on MARKING`, dxf.includes('simplex.shx') && ['FR-1', 'PL-7', 'WEB-1', 'ST-1', 'ST-2', 'ST-3'].every((c) => dxf.includes(`\r\n${c}\r\n`)));
    const back = readNestDxf(dxf, { filename: 'N-001.dxf' });
    ok(`${tag}: read back — plate ${back.plate.length} × ${back.plate.width}, ${back.parts.length} parts (6), no problems`, Math.abs(back.plate.length - 3000) < 1e-6 && Math.abs(back.plate.width - 1500) < 1e-6 && back.parts.length === 6 && !(back.problems ?? []).length, J({ w: back.warnings, p: back.problems }));
    const labels = back.parts.map((p) => p.labels.join('|')).sort();
    // (with CUT_ORDER on, a hole's step number is a word inside its part too — the code is still there)
    ok(`${tag}: every part read back carries its own code (${labels.join(', ')})`, variant.order
      ? ['FR-1', 'PL-7', 'ST-1', 'ST-2', 'ST-3', 'WEB-1'].every((c) => back.parts.filter((p) => p.labels.includes(c)).length === 1)
      : J(labels) === J(['FR-1', 'PL-7', 'ST-1', 'ST-2', 'ST-3', 'WEB-1']));
    const web = back.parts.find((p) => p.labels.includes('WEB-1')); const fr = back.parts.find((p) => p.labels.includes('FR-1'));
    ok(`${tag}: the web keeps its 2 holes, the frame its window, the plate in the window is a part of its own`, (web.rings.holes.length + web.rings.cutouts.length) === 2 && fr.rings.cutouts.length + fr.rings.holes.length === 1);
    const m = matchNest(back, [
      { key: 'FR', codes: ['FR-1'], rings: { outline: [[0, 0], [900, 0], [900, 600], [0, 600]], cutouts: [[[70, 70], [830, 70], [830, 530], [70, 530]]], holes: [] }, length: 900, width: 600 },
      { key: 'PL', codes: ['PL-7'], length: 300, width: 180 },
      { key: 'WEB', codes: ['WEB-1'], rings: { outline: [[0, 0], [1500, 0], [1500, 600], [0, 600]], cutouts: [], holes: [circle(200, 290, 40), circle(1300, 290, 40)] }, length: 1500, width: 600 },
      { key: 'ST', codes: ['ST-1', 'ST-2', 'ST-3'], length: 1500, width: 160 },
    ]);
    ok(`${tag}: matched to the cut plates by code and shape (${m.placements.length} placed, ${m.unmatched.length} unmatched)`, m.placements.length === 6 && m.unmatched.length === 0, J(m.unmatched));
  }
}

/* ───────────── 9. the setting in the database (local, rolled back) ───────────── */
section('9. The setting in the database: saved, read back, laid over the cut settings — then rolled back (local DB; skipped without one)');
{
  const { cutSettingRows } = await import('../../apps/cf_erp/services/nestingService.js');
  const { readShopRules, saveShopRules, getShopRules } = await import('../../apps/cf_erp/services/shopRules.js');
  // a database WITHOUT §75: both readers answer as before, nothing thrown
  const missing = (sqlHas) => ({ calls: 0, async query(sql) { this.calls += 1; if (sqlHas.some((w) => sql.includes(w))) { const e = new Error('Unknown column'); e.code = 'ER_BAD_FIELD_ERROR'; e.errno = 1054; throw e; } return [[{ id: 1, thickness_min_mm: null, thickness_max_mm: null, kerf_mm: 3, seq_gap_min_mm: 5, seq_gap_max_mm: 8, order_margin_length_mm: 100, order_margin_width_mm: 50, order_step_mm: 50, guillotine: 0 }]]; } });
  const m1 = missing(['nest_shop_spacing']);
  const r1 = await readShopRules(m1, 1);
  ok('without §75: readShopRules → off, schema false (one statement)', r1.on === false && r1.schema === false && m1.calls === 1);
  const m2 = missing(['nest_shop_spacing']);
  const rows = await cutSettingRows(m2, 1);
  ok('without §75: cutSettingRows answers the old query (2 statements: the new one failed), the band unchanged', rows.length === 1 && m2.calls === 2 && pickCutSettings(rows, 12).seqGapMinMm === 5);
  let db = null;
  try {
    const { pool } = await import('../../apps/cf_erp/lib/db.js');
    db = await pool.getConnection();
    await db.query('SELECT 1 FROM cf_nest_shop_rules LIMIT 1');
  } catch (e) { console.log(`  (skipped: no local database with §75 — ${e.code ?? e.message})`); db = null; }
  if (db) {
    const counted = { n: 0, query: (...a) => { counted.n += 1; return db.query(...a); } };
    const [[co]] = await db.query("SELECT c.id FROM companies c JOIN cf_cut_settings s ON s.company_id = c.id AND s.deleted_at IS NULL LIMIT 1");
    await db.beginTransaction();
    try {
      const before = await cutSettingRows(db, co.id);
      const off = pickCutSettings(before, 16);
      counted.n = 0;
      const saved = await saveShopRules(counted, { companyId: co.id, userId: null }, { on: true, rows: [{ thicknessMm: 16, groupGapMm: 12.5 }, { thicknessMm: 36, partGapMm: 5.2 }] });
      ok(`save: the switch and two rows in ${counted.n} statements (read 2 + switch 1 + upsert 1 + soft delete 1 + read back 2)`, counted.n === 7 && saved.on && saved.rows.length === 2, J({ n: counted.n, saved: saved.rows }));
      counted.n = 0;
      const after = await cutSettingRows(counted, co.id);
      const on16 = pickCutSettings(after, 16); const on40 = pickCutSettings(after, 40);
      ok(`cutSettingRows with the switch on: 2 statements; 16 mm blocks 12.5 apart (saved), edge 5; kerf stays ${off.kerfMm}`, counted.n === 2 && on16.seqGapMinMm === 12.5 && on16.edgeMarginMm === 5 && on16.kerfMm === off.kerfMm, J({ n: counted.n, on16 }));
      ok('40 mm takes the 36 mm row (part gap 5.2) and the block gap from the files (13); 16 mm keeps the part gap of the files (5)', on40.partGapMm === 5.2 && on40.seqGapMinMm === 13 && on16.partGapMm === 5);
      await saveShopRules(db, { companyId: co.id, userId: null }, { on: false, rows: [{ thicknessMm: 16, groupGapMm: 12.5 }] });
      counted.n = 0;
      const offAgain = await cutSettingRows(counted, co.id);
      ok('switched off: ONE statement, and the band exactly as before the setting existed', counted.n === 1 && pickCutSettings(offAgain, 16).seqGapMinMm === off.seqGapMinMm && pickCutSettings(offAgain, 16).shopSpacing === undefined);
      const g = await getShopRules(db, co.id);
      ok('the 36 mm row left out of the save was soft-deleted; the screen view resolves the shop thicknesses', g.rows.length === 1 && g.rows[0].thicknessMm === 16 && g.resolved.some((r) => r.thicknessMm === 45 && r.kerfMm === 5));
      let refused = null;
      try { await saveShopRules(db, { companyId: co.id, userId: null }, { rows: [{ thicknessMm: 16 }, { thicknessMm: 16 }] }); } catch (e) { refused = e; }
      ok('a thickness listed twice is refused (422)', refused?.status === 422 || refused?.statusCode === 422 || refused?.code === 'INVALID_SHOP_RULES', refused?.message);
    } finally { await db.rollback(); db.release(); }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
