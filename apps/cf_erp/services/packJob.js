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
 * WHICH LAYOUT A PLATE KEEPS — ONE RULE. The job makes the row layout (the floor) and the
 * true-shape layout seeded with it, and takes the true-shape one ONLY WHEN IT IS BETTER: fewer
 * pieces left off, less steel bought, or the same steel on fewer plates (`chosen: 'shape'`). When
 * it is not better, the row layout stands, rows and sequences and all (`chosen: 'rect'`). So a
 * group's plates are all free layouts (no rows, no sequences; cut order by position) or all row
 * layouts — never a free layout that merely re-states the rows.
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
    onProgress: (p) => tell({ plates: base.plates + p.sheets, areaBought: base.area + p.areaBought, unplaced: p.unplaced, source: p.source, trials: p.trials }),
    ...(typeof hooks.onCheckpoint === 'function' ? {
      checkpointMs: input.checkpointMs ?? 60_000,
      onCheckpoint: (c) => { try { hooks.onCheckpoint({ start: c.layout, fill: fillSlim, plates: c.sheets, areaBought: c.areaBought, unplaced: c.unplaced }); } catch { /* a listener never breaks a pack */ } },
    } : {}),
  });
  const score = (o, plates, area) => ({ off: stranded(o), area, plates });
  const beats = (a, b) => a.off < b.off || (a.off === b.off && (a.area < b.area - 1e-6 || (Math.abs(a.area - b.area) <= 1e-6 && a.plates < b.plates)));
  const noWorse = (a, b) => a.off <= b.off && a.area <= b.area + 1e-6 && a.plates <= b.plates;
  const errors = [];
  let outOfTime = false;
  const resume = input.resume ?? null;
  const coarse = Math.max(0, Math.trunc(Number(input.coarse) || 0));
  // What a coarser re-run changes in the true-shape packer's input (see the header).
  const coarser = coarse === 1 ? { maxPieces: 12, nfpMax: 35_000 } : {};
  const slimLayout = (o) => (o?.nests ?? []).map((n) => ({ sheetKey: n.sheetKey, placements: (n.placements ?? []).map((q) => ({ key: q.key, x: q.x, y: q.y, rotationDeg: q.rotationDeg, mirrored: !!q.mirrored })) }));
  let fillSlim = null;                                // what went into the saved plates, as a checkpoint keeps it

  /** Step 3 for some pieces: the rectangle layout, the true-shape one seeded with it, and which is taken. */
  const newPlates = (rectPieces, shapePieces, share) => {
    if (!rectPieces.length) return { chosen: 'rect', rect: { nests: [], unplaced: [], areaBought: 0, deterministic: true }, shape: null, score: { off: 0, area: 0, plates: 0 } };
    const tRect = Date.now();
    const rect = rectOf(rectPieces, share * 0.4);
    const rs = score(rect, (rect.nests ?? []).length, Number(rect.areaBought) || 0);
    tell({ plates: rs.plates, areaBought: rs.area, unplaced: rs.off, source: 'rows', trials: 0 });
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
      } catch (e) { errors.push(e?.message ?? String(e)); }
    }
    if (shape) {
      const ss = score(shape, (shape.nests ?? []).length, Number(shape.totals?.areaBought ?? Infinity));
      // A layout the search made is taken when it beats the rows. So is a KEPT layout handed back as it
      // was ('start' — a steel picked up again that found nothing better): it was a true-shape layout
      // that beat the rows when it was kept. (The row layout handed in as a start is never "taken".)
      if ((shape.source === 'shape' || (kept && shape.source === 'start')) && beats(ss, rs)) return { chosen: 'shape', rect, shape: slim(shape), score: ss };
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
  if (!result) {
    const r = newPlates(allRect, allShape, 0.9);
    // The floor already worked out (a fill that did not pay) may still be the better rectangle layout.
    result = { ...r, fill: null };
  }

  const win = result.chosen === 'shape' ? result.shape : result.rect;
  return {
    packer: 'shape', chosen: result.chosen, rect: result.rect, shape: result.shape, fill: result.fill,
    shapeError: errors[0] ?? null,
    // What the pool compares runs by, in nestingPacker's own words.
    nests: win?.nests ?? [],
    unplaced: win?.unplaced ?? [],
    areaBought: result.score.area,
    deterministic: !outOfTime && [floor, result.rect, result.shape, result.fill].every((o) => (o?.deterministic ?? true) !== false),
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
