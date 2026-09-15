/**
 * blankPlanService.js — how the blanks are actually cut out of plate.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
 *
 * `blankService` says WHAT has to be cut: 24 rectangles, so many of each. This
 * says HOW — the actual sheets, each holding a mix of blanks, with what lands
 * where.
 *
 * ── IT USES THE REAL PACKER, AND THE FIRST VERSION DID NOT ───────────────────
 *
 * The first version picked one plate SIZE per blank and gave each blank its own
 * dedicated sheets. It was simple, it was wrong, and the cost was measurable: on
 * the KEPL order it bought 759 t across 146 plates where `nest()` buys 708 t
 * across 125 — 51 tonnes, about ₹4.4M at the ₹85,000/t the suggestor prices with.
 *
 * All of that difference is MIXING. Putting a web plate and forty stiffeners on
 * one sheet is where the efficiency lives, and a per-blank allocator can never
 * find it because it never looks at two blanks together. The packer's own notes
 * make the same point from the other side: two strategies that tried to build
 * mixing deliberately were ~60 t WORSE than plain greedy, because greedy gets
 * mixing for free and they had to rediscover it.
 *
 * So this groups blanks by steel and hands each group to `nest()` — the same
 * shipped packer the old suggestor used, restarts and all.
 *
 * ── A NEST IS A PLATE ────────────────────────────────────────────────────────
 *
 * One sheet, one `nest_no`, several blanks on it. Which is exactly what
 * `wipInventoryService.claimNest` already expects: raw material on a link
 * carrying a `nest_no` is issued ONCE for the whole nest, because the shop takes
 * one plate to the machine and cuts everything out of it.
 */

import { pool } from '../../../db.js';
import { plateCatalog, offcutSpecs } from './plateSourceService.js';
import {
  nestAsync, nestAtEffortAsync, shrinkPlates, fillOne, sizeAdvice, EFFORT_LEVELS,
} from './nestingPacker.js';
import { orderBlanks, CUTTING_FLOW_CODE } from './blankService.js';
import { plateFits } from './materialMatchService.js';
import { kerfFor } from './kerfService.js';

const STEEL_DENSITY = 7850;

/**
 * Yield bands the screen colours `utilisationPct` against — one place, so the
 * FE's own hardcoded 90/75 fallback (labelled "(default)" on screen) stops
 * being the only source. REPAIR-D item 1.
 */
const THRESHOLDS = Object.freeze({ good: 90, warn: 75 });

/**
 * The packer never tags a placed rectangle with the row it came from — `plate.
 * pieces` is pushed by `placePiece` knowing only l/w/x/y/rotated, and `plate.
 * rows` is pushed once per `placeSome` call with the count that landed (see
 * nestingPacker.js). But those two arrays are built in lockstep by the SAME
 * calls — every row contributes exactly `row.qty` consecutive pieces, in the
 * order the rows array records them — for every path that builds a plate
 * (nestOnce, ruinRecreate, shrinkPlates, fillOne alike), because `placePiece`/
 * `placeSome` are the only places either array is ever mutated. So the row a
 * piece belongs to is recoverable by walking `rows` and consuming `pieces`
 * sequentially, without touching the packer itself (out of this file's scope).
 */
function piecesWithKeys(pl) {
  const pieces = [];
  let cursor = 0;
  for (const row of pl.rows) {
    for (let i = 0; i < row.qty; i += 1) {
      const p = pl.pieces[cursor];
      cursor += 1;
      if (!p) break;
      pieces.push({
        key: row.key, x: p.x, y: p.y, l: p.l, w: p.w, rotated: p.rotated,
      });
    }
  }
  return pieces;
}

/**
 * A SAVED nest has no persisted geometry — `acceptNestingPlan` writes qty per
 * (blank, sheet), never x/y — so there is nothing to read back. This re-packs
 * just that one sheet's own items onto its own plate size, same kerf and grain
 * rules the plan itself used, no restarts (`fillOne`'s `rng=null` is the
 * deterministic floor). It is a DISPLAY layout, not the one actually cut —
 * hence `piecesDerived: true` alongside it, so nobody mistakes a re-pack for
 * the record.
 */
async function derivedPieces(companyId, nest, byKey, kerfCache) {
  const rows = [];
  for (const it of nest.items) {
    const b = byKey.get(it.key);
    if (!b) continue;
    rows.push({
      key: it.key, length: b.length, width: b.width, qty: it.qty, grain: b.grain,
    });
  }
  if (!rows.length) return [];
  const kerfMm = await kerfFor(companyId, nest.thickness, 'cutting', kerfCache);
  const { plate } = fillOne({ length: nest.length, width: nest.width }, rows, null, kerfMm, false);
  return piecesWithKeys(plate);
}

/** kg of one sheet of this size. */
const specKg = (s) => (s.thickness * s.width * s.length * STEEL_DENSITY) / 1e9;

/**
 * How hard to look — one shared table with everything else that nests
 * (`nestingSuggestService`'s suggestor), imported rather than kept as a
 * second copy. This file used to run its own {200,500,2000} restart counts;
 * two effort tables is how they drift apart without anyone deciding to change
 * either one. `EFFORT_LEVELS` (`nestingPacker.js`) is quoted in restarts AND a
 * millisecond budget — this file still drives the search with `nestAsync`
 * (event-loop breathing, see that function's own header) rather than the
 * synchronous ruin-and-recreate `nestAtEffort` uses for standard/deep, so a
 * level's `budgetMs` is spent here as `nestAsync`'s own restart-and-deadline
 * loop, not as a repair phase.
 */

/**
 * A last-resort stop, in case an order is pathological in a way KEPL is not.
 *
 * It is deliberately far beyond anything the levels above should reach, so it
 * never fires in normal use — and when it does fire the answer is no longer
 * reproducible, which the caller is TOLD rather than left to discover by
 * noticing the number moved.
 */
const SAFETY_MS = 300000;

/**
 * The cutting machine's bed, if the order's cutting flow names a resource type
 * and that type's resources agree on a size. NULL/unresolvable means no
 * limit — exactly how every order behaved before a bed size ever existed.
 *
 * The type comes off the cutting flow's FIRST step (lowest `seq_no`), falling
 * back to that step's operation's own default when the step itself does not
 * override it. `fab_resources.bed_length_mm/bed_width_mm` are NULL on every
 * row today, so this resolves to "no limit" for every local and production
 * order until somebody enters a machine's bed.
 */
async function cuttingBedLimit(companyId) {
  const [[flow]] = await pool.query(
    `SELECT id FROM fab_operation_flows
      WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId, CUTTING_FLOW_CODE],
  );
  if (!flow) return { lengthMm: null, widthMm: null, reason: 'no cutting flow on this company' };

  const [[step]] = await pool.query(
    `SELECT s.resource_type_id AS stepResourceTypeId, o.default_resource_type_id AS opResourceTypeId
       FROM fab_operation_flow_steps s
       JOIN fab_operations o ON o.id = s.operation_id AND o.deleted_at IS NULL
      WHERE s.company_id = ? AND s.flow_id = ? AND s.deleted_at IS NULL
      ORDER BY s.seq_no LIMIT 1`,
    [companyId, flow.id],
  );
  const resourceTypeId = Number(step?.stepResourceTypeId ?? step?.opResourceTypeId) || null;
  if (!resourceTypeId) {
    return { lengthMm: null, widthMm: null, reason: 'the cutting flow names no resource type' };
  }

  const [[bed]] = await pool.query(
    `SELECT MIN(bed_length_mm) AS lengthMm, MIN(bed_width_mm) AS widthMm
       FROM fab_resources WHERE company_id = ? AND resource_type_id = ? AND deleted_at IS NULL`,
    [companyId, resourceTypeId],
  );
  const lengthMm = bed?.lengthMm != null ? Number(bed.lengthMm) : null;
  const widthMm = bed?.widthMm != null ? Number(bed.widthMm) : null;
  if (lengthMm == null || widthMm == null) {
    return { lengthMm: null, widthMm: null, reason: 'no resource of that type has a bed size on record' };
  }
  return { lengthMm, widthMm, reason: null };
}

/**
 * The sheets THIS ORDER HAS ALREADY ACCEPTED, read straight back.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Opening the nesting screen used to re-pack from scratch every time — around
 * 36 seconds at 500 restarts, on an order whose plan was decided days ago. The
 * screen looked stuck, and it was burning a CPU to arrive back at the answer it
 * had already been given.
 *
 * A saved plan IS the plan. Re-packing is a thing somebody asks for, not the
 * price of looking.
 *
 * The rows are the material links under each blank: one per (blank, sheet), all
 * the rows for one sheet sharing a nest_no. That is enough to rebuild exactly
 * what was accepted — nothing is re-derived, so what you see is what will be cut.
 */
async function savedNests(companyId, orderId, byKeyCode, byKey) {
  const [rows] = await pool.query(
    `SELECT m.nest_no AS nestNo, m.qty AS qty,
            b.code AS blankCode,
            pc.id AS plateId, pc.code AS plateCode, pc.name AS plateName,
            pc.thickness_mm AS thickness,
            m.width AS plateWidth, m.length AS plateLength
       FROM fab_items m
       JOIN fab_items bl ON bl.id = m.parent_item_id AND bl.deleted_at IS NULL
       JOIN fab_item_catalog b ON b.id = bl.catalog_item_id AND b.material_form = 'blank'
       JOIN fab_item_catalog pc ON pc.id = m.catalog_item_id
      WHERE m.company_id = ? AND m.order_id = ? AND m.deleted_at IS NULL
        AND m.node_kind = 'material' AND m.nest_no IS NOT NULL
      ORDER BY m.nest_no, m.id`,
    [companyId, orderId],
  );
  if (!rows.length) return null;

  /*
   * THE LAYOUTS ACCEPTED WITH THIS PLAN, when they were kept (blankService
   * writes them on a `fab_nesting_runs` row of kind 'accepted'). Matched by
   * nest_no, and only trusted when the sheet still carries exactly what the
   * layout says it does.
   */
  const layoutByNest = new Map();
  const [[layoutRow]] = await pool.query(
    `SELECT result_json AS resultJson FROM fab_nesting_runs
      WHERE company_id = ? AND order_id = ? AND kind = 'accepted' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [companyId, orderId],
  );
  if (layoutRow) {
    const raw = layoutRow.resultJson;
    const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
    for (const n of parsed?.nests ?? []) if (n?.nestNo) layoutByNest.set(String(n.nestNo), n);
  }

  const bySheet = new Map();
  for (const r of rows) {
    const key = byKeyCode.get(String(r.blankCode));
    if (!key) continue;             // a blank the structure no longer calls for
    const hit = bySheet.get(r.nestNo) ?? {
      nestNo: r.nestNo,
      plateCatalogItemId: Number(r.plateId),
      plateCode: r.plateCode ?? null,
      plateName: r.plateName ?? null,
      thickness: Number(r.thickness) || 0,
      width: Number(r.plateWidth) || 0,
      length: Number(r.plateLength) || 0,
      isDrop: false,
      items: [],
    };
    // `rect`/`name` — same shape `mergeItems` puts on the fresh-pack path's
    // items, so the sheets tab stops reading "2 × undefined" for an accepted
    // plan (REPAIR-D item 2).
    const b = byKey.get(key);
    hit.items.push({
      key,
      name: b?.name ?? key,
      rect: b ? `${b.thickness} × ${b.width} × ${b.length}` : null,
      qty: Number(r.qty) || 0,
    });
    hit.layout = layoutByNest.get(String(r.nestNo)) ?? null;
    bySheet.set(r.nestNo, hit);
  }
  return [...bySheet.values()];
}

/**
 * The plan for an order: the sheets, what is on each, and the demand behind it.
 *
 * @param {object} opts
 * @param {'quick'|'standard'|'deep'} [opts.effort]
 */
export async function blankPlan(companyId, orderId, opts = {}) {
  const { orderNumber, blanks, skipped } = await orderBlanks(companyId, orderId);
  if (!blanks.length) {
    return {
      orderNumber, blanks: [], nests: [], skipped, summary: emptySummary(), thresholds: THRESHOLDS,
    };
  }

  // Built once, ahead of the saved/fresh fork — both paths need a blank's own
  // size/name/grain to describe an item or re-derive a layout, not just its key.
  const byKey = new Map(blanks.map((b) => [b.key, b]));

  /*
   * THE SAVED PLAN WINS, unless somebody asks for a fresh one.
   *
   * Re-packing on every visit meant a 36-second spinner to be shown the plan the
   * order already had. Reading it back is a single query, and it is also more
   * honest: what is on screen is then literally what will be cut, rather than a
   * fresh proposal that may differ from what was accepted.
   */
  const byKeyCode = new Map(blanks.map((b) => [b.code, b.key]));
  if (!opts.repack) {
    const saved = await savedNests(companyId, orderId, byKeyCode, byKey);
    if (saved?.length) {
      const kerfCache = new Map();
      const withKg = await Promise.all(saved.map(async (n) => {
        const frac = usedFraction(n, blanks);
        const utilisationPct = frac == null ? null : Math.round(frac * 1000) / 10;
        // The layout accepted with this sheet, if one was kept and it still
        // describes exactly what the sheet carries; else a re-pack for display.
        const kept = n.layout;
        const sameContents = kept && kept.items?.length === n.items.length
          && n.items.every((it) => kept.items.some((k) => k.key === it.key && Number(k.qty) === it.qty));
        const pieces = sameContents ? kept.pieces : await derivedPieces(companyId, n, byKey, kerfCache);
        const { layout: _drop, ...rest } = n;
        return {
          ...rest,
          plateKg: specKg(n),
          utilisationPct,
          overfilled: utilisationPct != null && utilisationPct > 100,
          // Deprecated alias of `utilisationPct` — EU-21 removes it once EU-18
          // reads the new name.
          usedPct: utilisationPct,
          pieces,
          // True only when this is a re-pack for display, not the accepted cut.
          piecesDerived: !sameContents,
        };
      }));
      const rows = describeBlanks(blanks, withKg, new Map());
      /*
       * HOW THIS PLAN WAS ARRIVED AT, kept so the screen can say so.
       *
       * Written onto the cutting order when the plan was accepted. It lives in
       * that order's `notes` rather than a column of its own — it is one short
       * human sentence, it is worth reading on the order itself, and a column
       * per fact is how a table grows twenty of them. The trade is that it is
       * text: fine to show, not something to compute against.
       */
      const provenance = await savedProvenance(companyId, orderId);
      return {
        orderNumber,
        blanks: rows,
        nests: withKg,
        skipped,
        summary: summarise(rows, withKg),
        effort: null,
        seed: null,
        reproducible: true,
        fromSaved: true,
        accepted: true,
        provenance,
        thresholds: THRESHOLDS,
      };
    }
    /*
     * "ONLY WHAT IS SAVED": a screen opening on an order it has never seen
     * asks this way, so an order with nothing accepted yet gets an honest
     * empty answer rather than a pack it did not ask for.
     */
    if (opts.savedOnly) {
      return {
        orderNumber, blanks: [], nests: [], skipped, summary: emptySummary(),
        accepted: false, fromSaved: false, thresholds: THRESHOLDS,
      };
    }
  }

  const plates = await plateCatalog(companyId);
  let drops = [];
  try {
    drops = await offcutSpecs(companyId, plates.map((p) => p.id));
  } catch {
    drops = [];        // offcut tracking is optional; its absence is not an error
  }

  /*
   * GROUPED ON ALL THREE AXES. Thickness alone nests an E350 rectangle onto
   * E250 and scores better for it. Substituting either is a metallurgical
   * decision and a packer must not make it silently.
   */
  const groups = new Map();
  for (const b of blanks) {
    const k = `${b.thickness}|${b.grade ?? '?'}|${b.material ?? '?'}`;
    if (!groups.has(k)) {
      groups.set(k, { thickness: b.thickness, grade: b.grade, material: b.material, rows: [] });
    }
    // `key`, not `id` — the packer's own row identity (PLAN.md EU-10), so
    // `verify()` and `unplaced` can report a row by the same name this file
    // gave it. `grain` is `undefined` for every blank today (blankService's
    // pooling has no way yet to carry one part's grain onto a rectangle
    // several parts share — see the EU-10 report), which the packer reads as
    // 'any': free rotation, unchanged from before this option existed.
    groups.get(k).rows.push({
      key: String(b.key), length: b.length, width: b.width, qty: b.qty, grain: b.grain,
    });
  }

  /*
   * A LOOK IS A LOOK. Only an explicit re-pack (a nesting run) spends a
   * budgeted search; a plain read with nothing saved yet — the spreadsheet
   * download, a screen asking what the order has — gets the quick pack, not a
   * minute of the server's time behind a spinner.
   */
  const effort = opts.repack ? (EFFORT_LEVELS[opts.effort] ? opts.effort : 'standard') : 'quick';
  const level = EFFORT_LEVELS[effort];
  /*
   * SEEDED FROM THE ORDER. A constant would do for reproducibility, but seeding
   * per order means two orders explore different arrangements rather than every
   * order walking the same sequence of "random" restarts.
   */
  const startedAt = Date.now();
  const seed = Number(orderId) || 1;
  // A level's own budget is the real deadline once it has one; SAFETY_MS is
  // only the last-resort ceiling for 'quick', which states none.
  const deadline = Date.now() + (level.budgetMs || SAFETY_MS);
  let timedOut = false;

  const bed = await cuttingBedLimit(companyId);
  const kerfCache = new Map();

  const nests = [];
  const noSteel = [];
  const advice = [];
  let nestNo = 0;

  /*
   * ── TWO PASSES: A FLOOR FOR EVERY GROUP, THEN THE BUDGET WHERE THE WASTE IS
   *
   * The search budget used to be spent per group in the order the groups
   * happened to come, and a level's minutes are the ORDER's, not each
   * thickness's. Worse, splitting by size sent half of it to the 28 mm webs —
   * one part per sheet, 16 t of waste that is the catalogue's and that no
   * arrangement can touch — and starved the 16 mm group where forty small
   * parts share a sheet and the search actually earns its keep.
   *
   * So every group is first packed once, cheaply (the deterministic floor plus
   * a few restarts, well under a second on KEPL). The budget is then shared
   * out in proportion to each group's WASTE on that floor: a group with
   * nothing to recover gets a token slice, a group with tonnes to recover
   * gets most of the clock. 'quick' stops after the floor.
   */
  const prepared = [];
  for (const g of groups.values()) {
    // A rectangle that does not state its steel is refused, not guessed.
    if (g.grade == null || g.material == null) {
      for (const r of g.rows) noSteel.push({ key: r.key, reason: 'no grade or material stated' });
      continue;
    }
    // The same three-axis rule the suggestor and the integrity check use
    // (materialMatchService.plateFits), replacing a local re-implementation
    // that used strict `===` on thickness rather than a tolerance — see
    // PLAN.md EU-3 for the one behavioural difference this resolves.
    const specs = [...drops, ...plates].filter((p) => plateFits(g, p));
    /*
     * SORTED, OR NONE OF THE ABOVE IS TRUE.
     *
     * plateCatalog has no ORDER BY, so TiDB may hand the sizes back in any
     * order — and the greedy packer walks the candidate list, so a different
     * order is a different answer. A fixed seed and a fixed restart count buy
     * nothing while the INPUT is unordered: deep packed 130 sheets twice with
     * different contents before this line existed.
     *
     * By id, which is stable and unique.
     */
    specs.sort((x, y) => Number(x.id) - Number(y.id));

    if (!specs.length) {
      for (const r of g.rows) {
        noSteel.push({ key: r.key, reason: `no ${g.thickness} mm ${g.material} ${g.grade} plate in the catalogue` });
      }
      continue;
    }

    // Banded by process + thickness (kerfService.kerfFor); empty locally and in
    // production today, so this always resolves to the same blanket 2 mm the
    // packer used before this option existed — bit-identical until somebody
    // enters a row.
    const kerfMm = await kerfFor(companyId, g.thickness, 'cutting', kerfCache);
    const packOpts = {
      kerfMm, seed, bedLengthMm: bed.lengthMm, bedWidthMm: bed.widthMm,
    };
    const floor = await nestAsync(g.rows, specs, { ...packOpts, restarts: EFFORT_LEVELS.quick.restarts, jitterPlacement: true });
    const usedMm2 = g.rows.reduce((s, r) => s + r.length * r.width * r.qty, 0);
    const boughtMm2 = floor.plates.reduce((s, p) => s + p.spec.length * p.spec.width, 0);
    prepared.push({
      g, specs, kerfMm, packOpts, res: floor, wasteMm2: Math.max(0, boughtMm2 - usedMm2) * g.thickness,
    });
  }

  const totalWaste = prepared.reduce((s, p) => s + p.wasteMm2, 0);
  // The floors above already cost time; the level's budget is for the WHOLE
  // call, so the search gets what is left (never less than a third of it).
  const budgetMs = level.budgetMs
    ? Math.max(level.budgetMs / 3, level.budgetMs - (Date.now() - startedAt))
    : 0;
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  let spent = 0;
  for (const p of prepared) {
    const { g, specs, kerfMm, packOpts } = p;
    if (budgetMs > 0 && p.wasteMm2 > 0) {
      // At least a twentieth each, the rest in proportion to waste.
      const share = budgetMs * (0.05 + 0.95 * (totalWaste > 0 ? p.wasteMm2 / totalWaste : 1 / prepared.length));
      const before = spent;
      /*
       * AWAITED, so the server stays answerable while this runs — the search
       * hands control back every few repairs (nestingPacker.ruinRecreateAsync).
       */
      const deep = await nestAtEffortAsync(g.rows, specs, packOpts, effort, share,
        report ? (f) => report(Math.min(0.99, (before + f * share) / budgetMs)) : null);
      spent += share;
      // The floor is kept when the search only matched it; never worse.
      const area = (r) => r.plates.reduce((s, pl) => s + (pl.spec.available != null ? 0 : pl.spec.length * pl.spec.width), 0);
      if (deep && deep.unplaced.length <= p.res.unplaced.length
        && (area(deep) < area(p.res) || (area(deep) === area(p.res) && deep.plates.length < p.res.plates.length))) {
        p.res = deep;
      }
    }
    const res = p.res;
    // The safety ceiling, checked AFTER the group's own run — a group that
    // used it up mid-pack used to slip through unflagged until the NEXT
    // group's pre-check caught it (PLAN.md EU-10).
    if (Date.now() >= deadline) timedOut = true;

    /*
     * SHRINK EACH SHEET to the smallest that still holds what landed on it.
     *
     * Measured on the KEPL order this changes NOTHING — 0 of 127 sheets could
     * be swapped — because the greedy loop already picks a tight spec. It is
     * kept because it provably cannot make the answer worse (a swap requires
     * every row re-placed on a strictly smaller sheet) and because "the packer
     * happens to choose well here" is a property of THIS catalogue rather than
     * a guarantee. A yard with more sizes per thickness would give it work.
     */
    const packed = shrinkPlates(res.plates, specs, kerfMm);

    /*
     * WHAT SIZE WOULD HAVE HELPED — the waste that belongs to the catalogue.
     * Reported in kilogrammes of this group's steel so the screen can say
     * "ask the mill for 12050 x 3000 and save 15.8 t" without knowing the
     * density of anything.
     */
    for (const a of sizeAdvice(packed, kerfMm)) {
      advice.push({
        thickness: g.thickness,
        grade: g.grade,
        material: g.material,
        plates: a.plates,
        from: { length: a.specLength, width: a.specWidth },
        to: { length: a.length, width: a.width },
        savingPct: a.savingPct,
        savingKg: Math.round((a.savingMm2 * g.thickness * STEEL_DENSITY) / 1e9),
      });
    }

    for (const pl of packed) {
      nestNo += 1;
      const usedMm2 = pl.rows.reduce((s, r) => s + r.length * r.width * r.qty, 0);
      const utilisationPct = Math.round((usedMm2 / (pl.spec.width * pl.spec.length)) * 1000) / 10;
      nests.push({
        nestNo: `N-${String(nestNo).padStart(3, '0')}`,
        plateCatalogItemId: pl.spec.id,
        plateCode: pl.spec.code ?? null,
        plateName: pl.spec.name ?? null,
        thickness: pl.spec.thickness,
        width: pl.spec.width,
        length: pl.spec.length,
        isDrop: pl.spec.available != null,
        plateKg: specKg(pl.spec),
        utilisationPct,
        overfilled: utilisationPct > 100,
        // Deprecated alias of `utilisationPct` — EU-21 removes it.
        usedPct: utilisationPct,
        /*
         * ONE ENTRY PER BLANK, however many passes it took to place.
         *
         * The packer can lay part of a row, come back and lay more on the same
         * sheet, and record that as two rows. True, and not what a sheet's
         * contents are: "how many of this rectangle are on this plate" is one
         * number. Left unmerged it also broke the write — two material rows
         * for one (blank, sheet) collide on fab_items' unique code, so
         * re-accepting a plan failed outright.
         */
        items: mergeItems(pl.rows, byKey),
        // The real cut, not a preview — `piecesWithKeys` recovers each piece's
        // row from `pl.rows`/`pl.pieces` walked in lockstep (see that function).
        pieces: piecesWithKeys(pl),
      });
    }
    for (const u of res.unplaced) {
      // `u.row.key` — the packer's unplaced entries are `{row, reason}`; this
      // used to read `u.id`, which does not exist on that shape and was always
      // `undefined` (PLAN.md EU-10).
      noSteel.push({ key: u.row.key, reason: u.reason });
    }
  }

  /*
   * WHERE EACH RECTANGLE ENDED UP. A blank spreads over several sheets — 960
   * stiffeners do not fit on one — and the table must say so rather than
   * pretending every rectangle gets a plate of its own.
   */
  const onPlates = new Map();
  for (const n of nests) {
    for (const it of n.items) {
      onPlates.set(it.key, [...(onPlates.get(it.key) ?? []), { qty: it.qty, plate: n }]);
    }
  }
  const reasonFor = new Map(noSteel.map((x) => [x.key, x.reason]));

  const out = describeBlanks(blanks, nests, reasonFor);

  return {
    orderNumber,
    blanks: out,
    nests,
    skipped,
    summary: summarise(out, nests),
    /*
     * So the screen can say "this plan is reproducible" and mean it — and stop
     * saying so on the one run where the safety stop fired.
     */
    effort,
    seed,
    /*
     * ONLY 'QUICK' REPEATS EXACTLY. Standard and deep spend a time budget on
     * repair, and how far a budget gets depends on the machine — the same
     * order on a slower server explores less. So the honest answer is: quick
     * is reproducible from its seed; anything budgeted may move a little.
     */
    reproducible: !timedOut && !level.budgetMs,
    accepted: false,
    /** What this run was, in the words the screen will show. */
    provenance: `${effort[0].toUpperCase()}${effort.slice(1)} — `
      + `${level.budgetMs ? 'search' : `${level.restarts} restarts`} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    restarts: level.restarts,
    ms: Date.now() - startedAt,
    /** Sheet sizes that would have cut waste, most steel first — a purchasing answer, not a packing one.
     *  Under 100 kg is not worth a phone call to the mill and reads as "0.0 t" on screen. */
    advice: advice.filter((a) => a.savingKg >= 100).sort((a, b) => b.savingKg - a.savingKg).slice(0, 6),
    // NULL/no dimensions = no limit resolved — say so, rather than let a run
    // that quietly excluded plates look identical to one that didn't (PLAN.md
    // EU-10 item 3).
    bedLimit: bed.lengthMm != null ? { lengthMm: bed.lengthMm, widthMm: bed.widthMm } : null,
    bedLimitReason: bed.reason,
    thresholds: THRESHOLDS,
  };
}

function emptySummary() {
  return {
    blanks: 0, pieces: 0, plates: 0, mixedPlates: 0,
    boughtKg: 0, grossKg: 0, usedKg: 0, dropKg: 0, yield: 0, short: 0,
  };
}

function summarise(rows, nests) {
  const grossKg = nests.reduce((s, n) => s + n.plateKg, 0);
  const usedKg = rows.reduce((s, r) => s + r.totalWeightKg, 0);
  return {
    blanks: rows.length,
    pieces: rows.reduce((s, r) => s + r.qty, 0),
    plates: nests.length,
    mixedPlates: nests.filter((n) => n.items.length > 1).length,
    // A drop is already paid for, so it is not steel BOUGHT — but it is steel
    // USED, which is why the yield below divides by gross and not by this.
    boughtKg: nests.reduce((s, n) => s + (n.isDrop ? 0 : n.plateKg), 0),
    grossKg,
    usedKg,
    dropKg: Math.max(0, grossKg - usedKg),
    yield: grossKg > 0 ? usedKg / grossKg : 0,
    short: rows.filter((r) => r.short > 0).length,
  };
}

/**
 * The per-blank view: where each rectangle ended up and whether it is covered.
 *
 * Shared by both paths on purpose. The saved plan and a fresh pack must describe
 * a blank identically — two descriptions of one thing is how a screen ends up
 * disagreeing with itself depending on which way you arrived at it.
 */
function describeBlanks(blanks, nests, reasonFor) {
  const onPlates = new Map();
  for (const n of nests) {
    for (const it of n.items) {
      onPlates.set(it.key, [...(onPlates.get(it.key) ?? []), { qty: it.qty, plate: n }]);
    }
  }
  return blanks.map((b) => {
    const on = onPlates.get(b.key) ?? [];
    const placed = on.reduce((s, x) => s + x.qty, 0);
    return {
      key: b.key,
      code: b.code,
      ref: b.ref,
      name: b.name,
      material: b.material,
      grade: b.grade,
      thickness: b.thickness,
      width: b.width,
      length: b.length,
      qty: b.qty,
      unitWeightKg: b.unitWeightKg,
      totalWeightKg: b.totalWeightKg,
      partNames: b.partNames,
      partCount: b.parts.length,
      /** The sheets this rectangle is cut from, and how many land on each. */
      nests: on.map((x) => ({
        nestNo: x.plate.nestNo,
        qty: x.qty,
        plate: `${x.plate.thickness} × ${x.plate.width} × ${x.plate.length}`,
        isDrop: x.plate.isDrop,
        sharedWith: x.plate.items.length - 1,
      })),
      plateSizes: [...new Set(on.map((x) => `${x.plate.thickness} × ${x.plate.width} × ${x.plate.length}`))],
      plateCount: on.length,
      /** Sheets carrying something else too — the whole point of mixing. */
      sharesPlates: on.filter((x) => x.plate.items.length > 1).length,
      placed,
      short: Math.max(0, b.qty - placed),
      reason: placed === 0 ? (reasonFor.get(b.key) ?? null) : null,
    };
  });


}

/**
 * How much of a sheet its contents actually use.
 *
 * UNCAPPED. Capping at 1 hid an over-filled hand plan — a saved nest whose
 * blanks no longer fit it (a line qty rose, or someone hand-edited the plan)
 * read as a tidy 100% instead of the impossible fit it actually is. The
 * caller turns this into a percentage and flags `overfilled` above 100.
 *
 * `null`, not 0, when the plate has no known size — a genuinely empty sheet
 * and a sheet whose dimensions never resolved both used to read as a tidy 0%
 * fill, and only one of those is actually a fact about the plate.
 */
function usedFraction(nest, blanks) {
  const byKey = new Map(blanks.map((b) => [b.key, b]));
  const area = (nest.width || 0) * (nest.length || 0);
  if (!area) return null;
  const used = nest.items.reduce((a, it) => {
    const b = byKey.get(it.key);
    return a + (b ? b.width * b.length * it.qty : 0);
  }, 0);
  return used / area;
}

/** The one-line note the cutting order carries about how its plan was made. */
async function savedProvenance(companyId, orderId) {
  const [[row]] = await pool.query(
    `SELECT notes FROM fab_orders
      WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
        AND mo_purpose = 'cutting' AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    [companyId, orderId],
  );
  const note = String(row?.notes ?? '');
  const i = note.indexOf('· ');
  return i >= 0 ? note.slice(i + 2).trim() : null;
}

/** Collapse a plate's rows to one entry per blank. */
function mergeItems(rows, byKey) {
  const by = new Map();
  for (const r of rows) {
    const b = byKey.get(r.key);
    const hit = by.get(r.key) ?? {
      key: r.key,
      name: b?.name ?? String(r.key),
      rect: `${b?.thickness} × ${r.width} × ${r.length}`,
      qty: 0,
    };
    hit.qty += r.qty;
    by.set(r.key, hit);
  }
  return [...by.values()];
}
