/**
 * packJob.js — CF_ERP. What ONE packing job does, on a worker thread (nestingWorker.js) or — when
 * no worker can be started — in the pool's own thread (lib/packerPool.js). Pure: numbers in,
 * a layout out.
 *
 * TWO KINDS OF JOB.
 *   a shape job       `input = { packer: 'shape', rect, shape, fillSheets?, seed, budgetMs?, deadlineAt? }`.
 *                     EVERY steel group of a plan since 2026-10-10 ("Use the new packer everywhere,
 *                     even without drawings"): a piece with a drawing is its outline, a piece
 *                     without one is its rectangle. Saved customer plates are filled first.
 *   a rectangle job   `input` is nestingPacker's own input, and the answer is nestingPacker's own
 *                     answer, untouched. Only when asked for by name (`shapes: false`), when a test
 *                     injects its own packer, or when shapePacker.js cannot be loaded.
 *
 * WHICH LAYOUT A PLATE KEEPS — TWO RULES, by what the steel's pieces are.
 *   A steel with a REAL DRAWING (`input.shapesDecide`: a cut plate of it has a drawing whose
 *   outline is not its bounding rectangle — 2026-10-13, "if we have the exact diagram then the cut
 *   pieces should be based on the diagram and not the dimensions"): THE DRAWING DECIDES. The
 *   true-shape layout is taken ALWAYS (`chosen: 'shape'`), also when it only ties with the rows —
 *   unless it leaves MORE pieces off than the row layout, or could not be made at all (no time, no
 *   memory, an error). Then the rows stand and `rowsBecause` says which: 'unplaced' | 'time' |
 *   'memory' | 'error' | 'unavailable'. Never worse than the rows in steel: the true-shape search
 *   starts from the row layout and may only keep what buys no more.
 *   Every other steel (no drawing, or drawings that are plain rectangles with holes): the job
 *   makes the row layout (the floor) and the true-shape layout seeded with it, and takes the
 *   true-shape one ONLY WHEN IT IS BETTER: fewer pieces left off, less steel bought, or the same
 *   steel on fewer plates. When it is not better, the row layout stands, rows and sequences and all
 *   (`chosen: 'rect'`).
 * Either way a group's plates are all free layouts (no rows, no sequences; cut order by position)
 * or all row layouts.
 *
 * A SHAPE JOB, IN ORDER.
 *   1. THE FLOOR. nestingPacker on every piece, new plates only — the same input a rectangle job
 *      would get, so this is today's answer. Nothing below may end up worse than it.
 *   2. FILL (only with `fillSheets`: plates already saved, their parts fixed). shapePacker is
 *      offered ONLY those plates: whatever fits their free space goes there, a kerf from
 *      everything on them. The rest is what still needs a new plate.
 *   3. NEW PLATES for what is left: nestingPacker again, and — when a piece has a drawing —
 *      shapePacker with that answer as its `start`, so it can only keep a layout that leaves no
 *      more pieces off, uses no more plates, and buys no more steel. The true-shape layout is
 *      TAKEN when it leaves fewer off, buys less steel, or the same steel on fewer plates;
 *      otherwise the rectangle layout stands, rows and sequences and all.
 *   4. THE CHECK. Fill + new plates must be no worse than the floor (pieces left off, steel
 *      bought, new plates). If it is — a fill that left an awkward remainder — the fill is
 *      dropped and step 3 is done for every piece instead.
 *
 * Why the fill is its own step and not one search over old and new plates together:
 * shapePacker's guard for a `start` layout counts an already-owned plate as a plate used, so a
 * layout that fills two saved plates and opens one new one loses to a start that opens two new
 * ones. Filling first, then packing the remainder, says what is wanted directly.
 *
 * THE CLOCK. The pool hands a job its share of the plan's budget (`budgetMs`, `deadlineAt`); each
 * step gets a part of what is left. The rectangle layout is made FIRST and is a complete answer, so
 * the true-shape search on top of it can be cut at any moment (shapePacker's first pass too, since
 * it is handed that layout as its `start`): a job never runs past its share by more than one
 * plate's worth of work, and what it answers is then the rectangle layout — `deterministic: false`
 * says the clock decided.
 *
 * PICKED UP AGAIN (`input.resume`, 2026-10-10 — a run that survives a sleep or a deploy).
 *   resume.start   the steel's best layout when the run was last checkpointed: the search starts
 *                  FROM it (as its `start`), so nothing found before is lost;
 *   resume.fill    what had been put into the saved customer plates: kept as it is, not searched again;
 *   resume.done    this steel had finished: its layout is taken as it stands (no time is given to it).
 * While it works a job hands out the same thing (`hooks.onCheckpoint`): `{ start, fill, plates,
 * areaBought, unplaced }` when a plate is saved and at most once a minute otherwise.
 *
 * COARSER, NOT FAILED (`input.coarse`). A job whose worker ran out of heap is run again by the pool
 * with `coarse: 1` — shapes cut into at most 12 convex pieces and a quarter of the no-fit-polygon
 * cache, which is where the memory goes — and, if that dies too, `coarse: 2`: the row layout alone.
 * The run goes on either way, and the group says which it was (`coarse`).
 *
 * A THIRD KIND, NOT A PACK:  `{ packer: 'measure', tasks: [{ kind: 'verify' | 'waste', args }] }`
 * — nestShapes.verifyPlate / shapedWaste on plates already laid out (services/nestMeasure.js).
 * They are exact polygon work, 50–250 ms a plate of a hundred parts, and a line has a hundred
 * plates: on the server's own thread that is seconds with every other request waiting.
 */
import { nest } from './nestingPacker.js';
import { layoutScore, extentOf } from './nestCost.js';
import { withoutBoltHoles, platesOf, covers, tailOf, nestsOf, pieceArea } from './nestPlateMix.js';

let SP = null;
try { SP = await import('./shapePacker.js'); } catch { SP = null; }
let NS = null;
try { NS = await import('./nestShapes.js'); } catch { NS = null; }

/** One measuring task, wherever it runs (a worker, or — for a small one — the caller's own thread). */
export function runMeasureTask(t) {
  if (!NS) throw new Error('nestShapes.js could not be loaded');
  return t.kind === 'verify' ? NS.verifyPlate(t.args) : NS.shapedWaste(t.args);
}
const runMeasure = (input) => ({ packer: 'measure', results: (input.tasks ?? []).map(runMeasureTask), nests: [], unplaced: [], areaBought: 0, deterministic: true });

export const shapeJobsAvailable = !!SP?.packShapes;
/** The true-shape packer's own time allowance for an effort (nestingPacker says 'standard', shapePacker 'normal'). 0 without it. */
export const shapeCapMs = (effort) => Number(SP?.SHAPE_EFFORT?.[effort === 'standard' ? 'normal' : effort]?.capMs) || 0;

const stranded = (o) => (o?.unplaced ?? []).reduce((a, u) => a + (Number(u.qty) || 0), 0);

/** nestingPacker's nests as a `start` layout for shapePacker: the same boxes, turned as it turned them. */
export const rectAsStart = (rectOut) => (rectOut?.nests ?? []).map((n) => ({
  sheetKey: n.sheetKey,
  placements: (n.pieces ?? []).map((p) => ({ key: p.key, x: Number(p.x), y: Number(p.y), rotationDeg: p.rotated ? 90 : 0, mirrored: false })),
}));

/** The free regions are worked out again where they are needed; they are not worth cloning across threads. */
const slim = (o) => (o ? { ...o, nests: (o.nests ?? []).map(({ metrics, ...n }) => ({ ...n, metrics: metrics ? { ...metrics, freeRegions: undefined } : null })) } : null);

function runShapeJob(input, hooks = {}) {
  const t0 = Date.now();
  const stopNow = () => { try { return typeof hooks.shouldStop === 'function' && !!hooks.shouldStop(); } catch { return false; } };
  const tell = (p) => { if (typeof hooks.onProgress === 'function') { try { hooks.onProgress(p); } catch { /* progress only */ } } };
  const total = input.budgetMs == null ? null : Math.max(0, Number(input.budgetMs));
  const deadlineAt = input.deadlineAt ?? null;
  const seed = input.seed ?? input.rect?.seed ?? 1;
  /** A share of what is left of the job's budget, for one step. */
  const clock = (share) => {
    if (total == null) return {};
    const left = Math.max(0, total - (Date.now() - t0));
    return { budgetMs: Math.max(200, Math.floor(left * share)), deadlineAt };
  };
  /*
   * THE ROW LAYOUT IS A FLOOR, NOT A SEARCH (2026-10-10: "use the new packer everywhere"). It is
   * made at nestingPacker's QUICK level — its one deterministic pass, a fraction of a second —
   * whatever effort was asked: the true-shape search starts from it and has beaten nestingPacker's
   * own long search on every job measured (the bridge-size line: 123 plates after four minutes of
   * row search, 115 after four seconds of this), so the time is spent where it buys plates. It
   * also keeps a stop prompt: the row packer cannot be interrupted, and a pass of it is short.
   */
  const rectOf = (pieces, share) => nest({ ...input.rect, effort: 'quick', restarts: undefined, pieces, seed, ...clock(share) });
  /** What the search reports, in the pool's words: plates and steel of the best layout so far. */
  const hooksFor = (base) => ({
    shouldStop: stopNow,
    onProgress: (p) => tell({ plates: base.plates + p.sheets, areaBought: base.area + p.areaBought, score: base.area + (p.score ?? p.areaBought), sizeOver: p.sizeOver ?? 0, unplaced: p.unplaced, source: p.source, trials: p.trials }),
    ...(typeof hooks.onCheckpoint === 'function' ? {
      checkpointMs: input.checkpointMs ?? 60_000,
      onCheckpoint: (c) => { try { hooks.onCheckpoint({ start: c.layout, fill: fillSlim, plates: c.sheets, areaBought: c.areaBought, unplaced: c.unplaced }); } catch { /* a listener never breaks a pack */ } },
    } : {}),
  });
  /*
   * THE SCORE (nestCost.js, 2026-10-18): with `shape.costRules` the rows and the true shapes are judged
   * alike by plate sizes over the company's limit, then the score (price + plate penalties + handling +
   * sizes − kept remnants); without them by steel bought, as before.
   */
  const R = input.shape?.costRules ?? null;
  const sheetMap = new Map((input.shape?.sheets ?? input.rect?.sheets ?? []).map((s) => [String(s.key), s]));
  const score = (o, plates, area) => {
    const base = { off: stranded(o), area, plates };
    if (!R) return base;
    const ls = layoutScore((o?.nests ?? []).map((n) => ({ sheetKey: n.sheetKey, extent: extentOf(n) })), sheetMap, R,
      { margin: Number(input.shape?.margin) || 0, gap: Math.max(Number(input.shape?.gap) || 0, Number(input.shape?.kerf) || 0) });
    return { ...base, score: ls.score, sizeOver: ls.sizeOver };
  };
  const sc = (a) => (a.score ?? a.area);
  const ov = (a) => (a.sizeOver ?? 0);
  const beats = (a, b) => a.off < b.off || (a.off === b.off && (ov(a) < ov(b) || (ov(a) === ov(b)
    && (sc(a) < sc(b) - 1e-6 || (Math.abs(sc(a) - sc(b)) <= 1e-6 && (a.area < b.area - 1e-6 || (Math.abs(a.area - b.area) <= 1e-6 && a.plates < b.plates)))))));
  const noWorse = (a, b) => a.off <= b.off && (R ? ov(a) <= ov(b) && sc(a) <= sc(b) + 1e-6 : a.area <= b.area + 1e-6 && a.plates <= b.plates);
  const errors = [];
  let outOfTime = false;
  // The drawing decides (see the header): why the rows stand although it should have.
  const shapesDecide = input.shapesDecide === true;
  let rowsBecause = null;
  const resume = input.resume ?? null;
  const coarse = Math.max(0, Math.trunc(Number(input.coarse) || 0));
  // What a coarser re-run changes in the true-shape packer's input (see the header).
  const coarser = coarse === 1 ? { maxPieces: 12, nfpMax: 35_000 } : {};
  const slimLayout = (o) => (o?.nests ?? []).map((n) => ({ sheetKey: n.sheetKey, placements: (n.placements ?? []).map((q) => ({ key: q.key, x: q.x, y: q.y, rotationDeg: q.rotationDeg, mirrored: !!q.mirrored })) }));
  let fillSlim = null;                                // what went into the saved plates, as a checkpoint keeps it

  /** The pieces a true-shape answer left off, placed again: onto its own plates (their parts fixed), else new plates. */
  const rescue = (shape, shapePieces) => {
    const left = new Map();
    for (const u of shape.unplaced ?? []) left.set(String(u.key), (left.get(String(u.key)) ?? 0) + (Number(u.qty) || 0));
    const pcs = shapePieces.filter((p) => (left.get(String(p.key)) ?? 0) > 0).map((p) => ({ ...p, qty: left.get(String(p.key)) }));
    if (!pcs.length) return null;
    const usedBy = new Map();
    for (const n of shape.nests ?? []) usedBy.set(String(n.sheetKey), (usedBy.get(String(n.sheetKey)) ?? 0) + 1);
    // Only the emptiest plates (by their parts' box area) are offered back — every plate offered is an obstacle set to
    // build — and their parts go without bolt holes (an obstacle needs none).
    const fill = (n) => (n.placements ?? []).reduce((a, q) => a + (q.bbox ? (q.bbox.x1 - q.bbox.x0) * (q.bbox.y1 - q.bbox.y0) : 0), 0) / Math.max(1, (Number(n.sheetLength) || 1) * (Number(n.sheetWidth) || 1));
    const roomiest = new Set((shape.nests ?? []).map((n, i) => ({ i, f: fill(n) })).sort((a, b) => a.f - b.f).slice(0, 6).map((x) => x.i));
    const keep = (shape.nests ?? []).map((n, i) => ({ n, i })).filter(({ i }) => roomiest.has(i)).map(({ n, i }) => {
      const s = sheetMap.get(String(n.sheetKey)) ?? { length: n.sheetLength, width: n.sheetWidth };
      return { key: `__keep${i}`, length: s.length, width: s.width, available: 1, preferred: true, areaCost: 0, penalty: 0,
        fixed: withoutBoltHoles((n.placements ?? []).map((q, j) => ({ key: `k${i}_${j}`, placed: true, rings: q.rings }))) };
    });
    const fresh = (input.shape.sheets ?? []).filter((s) => !s.preferred)
      .map((s) => ({ ...s, available: Math.max(0, (Number(s.available) || 0) - (usedBy.get(String(s.key)) ?? 0)) })).filter((s) => s.available > 0);
    let r;
    try {
      r = SP.packShapes({ ...input.shape, ...coarser, pieces: pcs, sheets: [...keep, ...fresh], seed, rectFloor: false, freeRegions: false, ...clock(0.2), shouldStop: stopNow });
    } catch (e) { errors.push(e?.message ?? String(e)); return null; }
    if (stranded(r) >= stranded(shape)) return null;
    const add = new Map(); const extra = [];
    for (const n of r.nests ?? []) { const m = String(n.sheetKey).match(/^__keep(\d+)$/); if (m) add.set(Number(m[1]), n.placements ?? []); else extra.push(n); }
    const nests = (shape.nests ?? []).map((n, i) => (add.has(i) ? { ...n, placements: [...(n.placements ?? []), ...add.get(i)], metrics: null } : n));
    return {
      ...shape, nests: [...nests, ...extra], unplaced: r.unplaced ?? [], source: 'shape',
      deterministic: shape.deterministic !== false && r.deterministic !== false,
      totals: { ...(shape.totals ?? {}), sheets: nests.length + extra.length, areaBought: (Number(shape.totals?.areaBought) || 0) + (Number(r.totals?.areaBought) || 0) },
      rescued: { pieces: pcs.reduce((a, p) => a + p.qty, 0) - stranded(r), ontoOwnPlates: add.size, newPlates: extra.length },
    };
  };

  /**
   * THE PLATE MIX OF THE WHOLE STEEL (2026-11-10, nestPlateMix.js): beside the answer in hand, the same pieces on the two
   * single plate sizes a quick row pass rates best; then, per set of one or two sizes, the plates of all of them that
   * cover every piece for the least price; then the least-used plates of the best covers packed again. Taken only when
   * the job's own ranking (beats) says it is better than the answer in hand. Bolt holes are left out of these extra
   * searches (they never take a part); the answer's placements get the full rings back.
   */
  const plateMix = (res) => {
    const resOut = res.chosen === 'shape' ? res.shape : res.rect;
    if (!resOut || stranded(resOut) > 0) return null;
    // ITS OWN CLOCK: everything here ends by 92 % of the job's budget (and the plan's deadline), so the job still lands
    // inside its share; a step with too little room left is not started.
    const mixEnd = Math.min(t0 + Math.floor(total * 0.92), deadlineAt ?? Infinity);
    const room = () => mixEnd - Date.now();
    const mclock = (share) => ({ budgetMs: Math.max(0, Math.floor(room() * share)), deadlineAt: mixEnd });
    if (room() < Math.max(2000, 0.1 * total)) return null;
    const net = new Map(allShape.map((p) => [String(p.key), pieceArea(p)]));
    const demand = new Map(allShape.map((p) => [String(p.key), Number(p.qty) || 0]));
    const lean = withoutBoltHoles(allShape);
    const bought = (input.shape.sheets ?? []).filter((s) => !s.preferred);
    // WHICH SINGLE SIZES: the two the answer in hand uses most, else the largest (a row pass per size to rate them
    // cannot be interrupted, and on a bridge-size steel six of them overran the budget).
    const usedN = new Map(); for (const n of resOut.nests ?? []) usedN.set(String(n.sheetKey), (usedN.get(String(n.sheetKey)) ?? 0) + 1);
    const est = bought.map((s) => ({ s, area: -((usedN.get(String(s.key)) ?? 0) * 1e12 + s.length * s.width) }));
    const layouts = [platesOf(resOut)];
    let det = true;
    est.sort((a, b) => a.area - b.area).slice(0, 2).forEach((e, i) => {
      if (stopNow() || room() < Math.max(1500, 0.25 * total)) return;
      try {
        const o = SP.packShapes({ ...input.shape, ...coarser, pieces: lean, sheets: [e.s], seed, freeRegions: false, ...mclock(i === 0 ? 0.35 : 0.5), shouldStop: stopNow });
        if (o.deterministic === false) det = false;
        layouts.push(platesOf(o));
      } catch (err) { errors.push(err?.message ?? String(err)); }
    });
    const cs = covers(layouts, { demand, sheets: sheetMap, net, margin: Number(input.shape.margin) || 0, rules: R });
    const cands = cs.slice(0, 3).map((c) => c.plates);
    for (const c of cs.slice(0, 2)) {
      if (stopNow() || c.plates.length < 3 || room() < Math.max(1000, 0.1 * total)) continue;
      const t = tailOf(c, net);
      const pcs = lean.filter((p) => (t.need.get(String(p.key)) ?? 0) > 0).map((p) => ({ ...p, qty: t.need.get(String(p.key)) }));
      const usedBy = new Map(); for (const p of t.keep) usedBy.set(p.buy, (usedBy.get(p.buy) ?? 0) + 1);
      const sh = c.sizes.map((k) => sheetMap.get(k)).filter(Boolean).map((s) => ({ ...s, available: Math.max(0, (Number(s.available) || 0) - (usedBy.get(String(s.key)) ?? 0)) })).filter((s) => s.available > 0);
      if (!sh.length) continue;
      try {
        const o = SP.packShapes({ ...input.shape, ...coarser, pieces: pcs, sheets: sh, seed: seed + 17, freeRegions: false, ...mclock(0.5), shouldStop: stopNow });
        if (o.deterministic === false) det = false;
        if (!stranded(o)) cands.push([...t.keep, ...platesOf(o).map((p) => ({ ...p, buy: p.sheetKey }))]);
      } catch (err) { errors.push(err?.message ?? String(err)); }
    }
    let best = null;
    for (const plates of cands) {
      const nests = nestsOf(plates, sheetMap);
      const area = nests.reduce((a, n) => { const s = sheetMap.get(String(n.sheetKey)); return a + (Number(s?.areaCost ?? s?.length * s?.width) || 0); }, 0);
      const sc0 = score({ nests, unplaced: [] }, nests.length, area);
      if (!best || beats(sc0, best.sc)) best = { nests, sc: sc0, area };
    }
    if (!best || !beats(best.sc, res.score)) return null;
    tell({ plates: best.sc.plates, areaBought: best.sc.area, score: best.sc.score ?? best.sc.area, sizeOver: best.sc.sizeOver ?? 0, unplaced: 0, source: 'mix', trials: 0 });
    const ringsOf = new Map(allShape.map((p) => [String(p.key), p.rings ?? { outline: [[0, 0], [p.length, 0], [p.length, p.width], [0, p.width]], cutouts: [], holes: [] }]));
    const nests = best.nests.map((n) => ({ ...n, placements: n.placements.map((q) => ({ ...q, rings: SP.placeRings(ringsOf.get(String(q.key)), { x: q.x, y: q.y, rotationDeg: q.rotationDeg, mirrored: q.mirrored }) })) }));
    return { chosen: 'shape', rect: res.rect, shape: { nests, unplaced: [], source: 'mix', deterministic: det, totals: { sheets: nests.length, areaBought: best.area } }, score: best.sc, fill: null };
  };

  /** Step 3 for some pieces: the rectangle layout, the true-shape one seeded with it, and which is taken. */
  const newPlates = (rectPieces, shapePieces, share) => {
    if (!rectPieces.length) return { chosen: 'rect', rect: { nests: [], unplaced: [], areaBought: 0, deterministic: true }, shape: null, score: { off: 0, area: 0, plates: 0 } };
    const tRect = Date.now();
    const rect = rectOf(rectPieces, share * 0.4);
    const rs = score(rect, (rect.nests ?? []).length, Number(rect.areaBought) || 0);
    tell({ plates: rs.plates, areaBought: rs.area, score: rs.score ?? rs.area, sizeOver: rs.sizeOver ?? 0, unplaced: rs.off, source: 'rows', trials: 0 });
    let shape = null;
    // NO TIME LEFT FOR SHAPES? Then the rectangle layout is the answer and the true-shape step is
    // not started at all: even cut short at once it reads and checks the whole start layout, which
    // on a big steel costs as much as the rectangle pass did. Said, not hidden (`outOfTime`).
    const leftMs = total == null ? Infinity : Math.min(total - (Date.now() - t0), deadlineAt == null ? Infinity : deadlineAt - Date.now());
    // EVERY steel goes to the true-shape packer, drawings or not (a piece without one is its rectangle).
    const kept = resume?.start?.length ? resume.start : null;      // the layout a checkpoint kept for this steel
    if (coarse >= 2) errors.push('The true-shape packer ran out of memory on this steel twice, so its row layout stands.');
    else if (SP?.packShapes && !kept && (leftMs <= Math.max(250, Date.now() - tRect) || stopNow())) outOfTime = true;
    else if (SP?.packShapes) {
      try {
        // The rectangle layout just made IS the floor: handed over as `start`, so shapePacker does not
        // run the rectangle packer a second time on the same boxes. (When it strands a piece there is
        // no legal start to hand over, and shapePacker makes its own floor.) A run picked up again
        // starts from the layout its checkpoint kept instead — and a steel that had FINISHED is given
        // no time: its layout comes straight back.
        const start = kept ?? (stranded(rect) ? undefined : rectAsStart(rect));
        const time = resume?.done ? { budgetMs: 0, deadlineAt: Date.now() } : clock(share);
        shape = SP.packShapes({ ...input.shape, ...coarser, pieces: shapePieces, seed, start, rectFloor: start ? false : undefined, freeRegions: false, ...time, ...hooksFor({ plates: 0, area: 0 }) });
        // A kept layout the packer could not read (a drawing changed under it) is not an answer: search afresh.
        if (kept && shape?.source !== 'start' && shape?.source !== 'shape') shape = null;
        // STRANDED PIECES (2026-11-10): the search left a few pieces off. Place just those — into the room left on its
        // own plates first, then on new plates — rather than lose the whole true-shape layout to the rows for them
        // (SO260018 32 mm: 1–2 pieces off cost 61 row plates against 45–47).
        if (shape && stranded(shape) > 0 && !stopNow()) { const r = rescue(shape, shapePieces); if (r) shape = r; }
      } catch (e) { errors.push(e?.message ?? String(e)); }
    }
    if (shape) {
      const ss = score(shape, (shape.nests ?? []).length, Number(shape.totals?.areaBought ?? Infinity));
      if (shape.rescued) tell({ plates: ss.plates, areaBought: ss.area, score: ss.score ?? ss.area, sizeOver: ss.sizeOver ?? 0, unplaced: ss.off, source: 'shape', trials: 0 });
      // A layout the search made is taken when it beats the rows. So is a KEPT layout handed back as it
      // was ('start' — a steel picked up again that found nothing better): it was a true-shape layout
      // that beat the rows when it was kept. (The row layout handed in as a start is never "taken".)
      if ((shape.source === 'shape' || (kept && shape.source === 'start')) && beats(ss, rs)) return { chosen: 'shape', rect, shape: slim(shape), score: ss };
      // THE DRAWING DECIDES: a steel with a real drawing takes the true-shape layout even when it does
      // not beat the rows (it is then the rows' own positions, read as outlines: a free layout whose
      // every part is its drawing) — unless it leaves more pieces off than the rows do.
      if (shapesDecide && (shape.nests ?? []).length && ss.off <= rs.off) return { chosen: 'shape', rect, shape: slim(shape), score: ss, tied: true };
      if (shapesDecide) rowsBecause = { why: 'unplaced', shapeOff: ss.off, rowsOff: rs.off };
    } else if (shapesDecide) {
      rowsBecause = { why: coarse >= 2 ? 'memory' : outOfTime ? 'time' : errors.length ? 'error' : 'unavailable' };
    }
    return { chosen: 'rect', rect, shape: slim(shape), score: rs };
  };

  const allRect = input.rect.pieces;
  const allShape = input.shape.pieces;
  let fill = null;
  let result = null;
  let floor = null;

  if (SP?.packShapes && input.fillSheets?.length) {
    // 1. the floor, 2. the fill, 3. new plates for the remainder, 4. the check.
    floor = rectOf(allRect, 0.2);
    const fs = score(floor, (floor.nests ?? []).length, Number(floor.areaBought) || 0);
    if (resume?.fill) {
      // Picked up again: what had gone into the saved plates is kept, not searched again.
      fill = { nests: resume.fill.nests ?? [], unplaced: resume.fill.unplaced ?? [], deterministic: true, resumed: true };
    } else {
      try {
        fill = SP.packShapes({ ...input.shape, ...coarser, pieces: allShape, sheets: input.fillSheets, seed, rectFloor: false, freeRegions: false, ...clock(0.35), shouldStop: stopNow });
      } catch (e) { errors.push(e?.message ?? String(e)); fill = null; }
    }
    const placed = (fill?.nests ?? []).reduce((a, n) => a + (n.placements?.length ?? 0), 0);
    if (placed > 0) {
      fillSlim = { nests: slimLayout(fill), unplaced: (fill.unplaced ?? []).map((u) => ({ key: u.key, qty: u.qty })) };
      const leftBy = new Map((fill.unplaced ?? []).map((u) => [String(u.key), 0]));
      for (const u of fill.unplaced ?? []) leftBy.set(String(u.key), leftBy.get(String(u.key)) + (Number(u.qty) || 0));
      const rest = (pieces) => pieces.map((p) => ({ ...p, qty: leftBy.get(String(p.key)) ?? 0 })).filter((p) => p.qty > 0);
      const r = newPlates(rest(allRect), rest(allShape), 0.8);
      if (noWorse(r.score, fs)) result = { ...r, fill: slim(fill) };
    }
    if (!result) { fill = null; fillSlim = null; }
  }
  // The plate mix needs a budget to share and at least two plate sizes to choose between.
  const mixOn = !!SP?.packShapes && total != null && !input.fillSheets?.length && input.plateMix !== false && !resume?.done && !resume?.start?.length && coarse < 2
    && new Set((input.shape?.sheets ?? []).filter((s) => !s.preferred).map((s) => `${s.length}x${s.width}`)).size >= 2;
  if (!result) {
    const r = newPlates(allRect, allShape, mixOn ? 0.6 : 0.9);
    // The floor already worked out (a fill that did not pay) may still be the better rectangle layout.
    result = { ...r, fill: null };
  }

  if (mixOn && !result.fill && !stopNow()) {
    try { const m = plateMix(result); if (m) result = m; } catch (e) { errors.push(e?.message ?? String(e)); }
  }

  const win = result.chosen === 'shape' ? result.shape : result.rect;
  return {
    packer: 'shape', chosen: result.chosen, rect: result.rect, shape: result.shape, fill: result.fill,
    shapeError: errors[0] ?? null,
    // What the pool compares runs by, in nestingPacker's own words.
    nests: win?.nests ?? [],
    unplaced: win?.unplaced ?? [],
    areaBought: result.score.area,
    /** nestCost.js: what the pool ranks seeds by (= areaBought without cost rules), and the plate sizes over the limit. */
    score: sc(result.score),
    sizeOver: ov(result.score),
    deterministic: !outOfTime && [floor, result.rect, result.shape, result.fill].every((o) => (o?.deterministic ?? true) !== false),
    /** A steel with a real drawing: true when the true-shape layout was to be taken whatever the rows did. */
    shapesDecide,
    /** …and, when the rows stand all the same, why: { why: 'unplaced' | 'time' | 'memory' | 'error' | 'unavailable', shapeOff?, rowsOff? }. */
    rowsBecause: result.chosen === 'rect' ? rowsBecause : null,
    /** The clock left no room to try the drawings at all: the answer is the rectangle layout. */
    shapeSkippedForTime: outOfTime,
    /** 0 = as asked; 1 = re-run coarser after its worker ran out of heap; 2 = the row layout alone. */
    coarse,
    /** The caller's stop ended the search: this is the best layout it had. */
    stopped: !![result.shape, result.fill].some((o) => o?.stopped) || (outOfTime && stopNow()),
    floorMs: (Number(result.rect?.floorMs) || 0) + (Number(result.shape?.floorMs) || 0),
    proven: false,
    elapsedMs: Date.now() - t0,
    sizeAdvice: result.chosen === 'rect' ? (result.rect?.sizeAdvice ?? []) : [],
  };
}

/** One job, whichever kind it is. */
/** A shape job's answer as a checkpoint keeps it: `{ start, fill, plates, areaBought, unplaced }` (start null = the row layout stands). */
export function checkpointOf(out) {
  const lay = (o) => (o?.nests ?? []).map((n) => ({ sheetKey: n.sheetKey, placements: (n.placements ?? []).map((q) => ({ key: q.key, x: q.x, y: q.y, rotationDeg: q.rotationDeg, mirrored: !!q.mirrored })) }));
  const fill = out?.fill?.nests?.some((n) => n.placements?.length) ? { nests: lay(out.fill), unplaced: (out.fill.unplaced ?? []).map((u) => ({ key: u.key, qty: u.qty })) } : null;
  return {
    start: out?.chosen === 'shape' && out.shape ? lay(out.shape) : null, fill,
    plates: (out?.nests ?? []).length, areaBought: Number(out?.areaBought) || 0,
    unplaced: (out?.unplaced ?? []).reduce((a, u) => a + (Number(u.qty) || 0), 0),
  };
}

export function runPackJob(input, hooks = {}) {
  if (input?.packer === 'measure') return runMeasure(input);
  return input?.packer === 'shape' ? runShapeJob(input, hooks) : nest(input);
}
