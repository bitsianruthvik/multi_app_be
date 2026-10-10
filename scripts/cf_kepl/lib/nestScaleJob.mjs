/**
 * nestScaleJob.mjs — a nesting job THE SIZE OF THE KEPL BRIDGE ORDER, made of numbers only (no
 * database): ~6,000 pieces of ~250 distinct cut plates in eight thickness groups (8 … 40 mm),
 * needing about 125 plates of 12000 × 2500 and 6300 × 2500, with 30 % of the distinct parts drawn
 * (the bridge shapes of nestDxfFixtures.mjs, in several sizes). Seeded: the same job every time.
 *
 * `scaleGroups()` gives, per steel group, exactly what nestingService.planNesting prepares for the
 * worker pool: `packInput` (nestingPacker's input) and `shapeInput` (shapePacker's), with the rim
 * rule of nestingService.rimOf. `jobsOf()` turns them into the pool's jobs the way planNesting does.
 */
import { girderShapes, flattenLoop, ringsShape, candidateOf } from './nestDxfFixtures.mjs';

export const THICKNESSES = [8, 10, 12, 16, 20, 25, 32, 40];
const kerfOf = (t) => (t <= 10 ? 2.5 : t <= 16 ? 3 : t <= 25 ? 4 : 5);
const rng = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

/** A fixture shape scaled (sx, sy), as the rings partGeometry would read from its drawing. */
function scaled(shape, sx, sy) {
  const loops = shape.loops.map((l) => flattenLoop(l).map(([x, y]) => [Math.round(x * sx * 10) / 10, Math.round(y * sy * 10) / 10]));
  const made = ringsShape(loops, shape.name);
  const c = candidateOf(made, { key: shape.name });
  // `shape` is the fixture shape itself: shapeToPartDxf(shape) is the part's own drawing, for a database fixture.
  return { rings: c.rings, length: c.length, width: c.width, shape: made };
}

export function scaleGroups({ seed = 20261010, pieces: wantPieces = 6000, parts: wantParts = 250, plates: wantPlates = 125, drawnShare = 0.3 } = {}) {
  const R = rng(seed);
  const S = girderShapes();
  const drawnKinds = [
    () => scaled(S.web, 0.6 + R() * 1.4, 0.6 + R() * 0.9),
    () => scaled(S.gusset, 0.8 + R() * 1.6, 0.8 + R() * 1.6),
    () => scaled(S.angle, 0.8 + R() * 1.4, 0.8 + R() * 1.4),
    () => scaled(S.stiffener, 0.8 + R() * 0.8, 0.6 + R() * 1.6),
    () => { const k = 0.5 + R() * 1.2; return scaled(S.disc, k, k); },
    () => scaled(S.frame, 0.8 + R() * 1.2, 0.8 + R() * 1.2),
    () => scaled(S.gusset, 1.5 + R() * 2, 0.6 + R()),
    () => scaled(S.stiffener, 1 + R(), 1 + R() * 1.2),
  ];
  const rectKinds = [
    () => ({ length: 6000 + Math.round(R() * 59) * 100, width: 300 + Math.round(R() * 8) * 50 }),       // flange
    () => ({ length: 3000 + Math.round(R() * 60) * 50, width: 1200 + Math.round(R() * 20) * 50 }),      // web panel
    () => ({ length: 600 + Math.round(R() * 30) * 20, width: 150 + Math.round(R() * 12) * 10 }),        // stiffener
    () => ({ length: 400 + Math.round(R() * 40) * 10, width: 300 + Math.round(R() * 30) * 10 }),        // splice / cover
    () => ({ length: 150 + Math.round(R() * 20) * 5, width: 80 + Math.round(R() * 20) * 5 }),           // packer (Small)
    () => ({ length: 1500 + Math.round(R() * 30) * 50, width: 500 + Math.round(R() * 10) * 50 }),       // diaphragm
  ];
  const perGroup = Math.round(wantParts / THICKNESSES.length);
  const groups = THICKNESSES.map((t, gi) => {
    const n = gi === THICKNESSES.length - 1 ? wantParts - perGroup * (THICKNESSES.length - 1) : perGroup;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const drawn = R() < drawnShare;
      const shape = drawn ? drawnKinds[Math.floor(R() * drawnKinds.length)]() : rectKinds[Math.floor(R() * rectKinds.length)]();
      const area = shape.length * shape.width;
      // Many of the small, few of the big — as a girder has.
      const weight = area > 4e6 ? 0.25 : area > 1e6 ? 0.6 : area > 2e5 ? 1.5 : 3;
      parts.push({ key: `cp${gi * 1000 + i}`, ...shape, rings: shape.rings ?? null, shape: shape.shape ?? null, weight: weight * (0.5 + R()) });
    }
    return { thickness: t, kerf: kerfOf(t), parts };
  });
  // Quantities: the wanted piece count shared by weight, then the plate sizes scaled to the wanted plate count.
  const all = groups.flatMap((g) => g.parts);
  const wsum = all.reduce((a, p) => a + p.weight, 0);
  for (const p of all) p.qty = Math.max(1, Math.round((p.weight / wsum) * wantPieces));
  const partArea = all.reduce((a, p) => a + p.length * p.width * p.qty, 0);
  // The mean plate bought is ~24 m² at ~80 % full; shrink or grow every part's count to land near `wantPlates`.
  const k = (wantPlates * 24e6 * 0.8) / partArea;
  if (k < 1) for (const p of all) { if (p.length * p.width > 1e6) p.qty = Math.max(1, Math.round(p.qty * k)); }
  const total = all.reduce((a, p) => a + p.qty, 0);
  let i = 0;
  while (all.reduce((a, p) => a + p.qty, 0) < wantPieces && i < 100000) { const p = all[i % all.length]; if (p.length * p.width < 2e5) p.qty += 1; i += 1; }
  void total;
  return groups.map((g) => {
    const sheets = [
      { key: 'A', length: 12000, width: 2500, available: 1000, preferred: false, areaCost: 12000 * 2500 },
      { key: 'B', length: 6300, width: 2500, available: 1000, preferred: false, areaCost: 6300 * 2500 },
    ];
    return { key: `${g.thickness}|E350|STEEL`, thickness: g.thickness, kerf: g.kerf, sheets, parts: g.parts };
  });
}

/** What planNesting hands the pool for one group (see nestingService.planNesting). `rim` = nestingService.rimOf. */
export function inputsOf(g, { effort = 'standard', seed = 1, rim, shapes = true, every = true } = {}) {
  const packInput = {
    pieces: g.parts.map((p) => ({ key: p.key, length: p.length, width: p.width, qty: p.qty, grain: 'any' })),
    sheets: g.sheets, kerf: g.kerf, gap: g.kerf, margin: rim.rectMargin, thickness: g.thickness,
    sequenceGap: 5, smallThreshold: 200, rowsPerSequence: { small: 2, big: 3 }, guillotine: false, effort, seed, restarts: undefined, budgetMs: null,
  };
  // Every steel is a shape job since 2026-10-10 (`every`); before, only one with a drawing in it.
  const drawn = shapes && (every || g.parts.some((p) => p.rings));
  const shapeInput = drawn ? {
    pieces: g.parts.map((p) => ({ key: p.key, qty: p.qty, rings: p.rings, length: p.length, width: p.width, grain: 'any', allowMirror: false })),
    sheets: g.sheets, kerf: g.kerf, margin: rim.shapeMargin, rotations: [0, 90, 180, 270], partInPart: true, effort, seed,
  } : null;
  return { packInput, shapeInput };
}
