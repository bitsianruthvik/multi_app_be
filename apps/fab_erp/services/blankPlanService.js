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

import { plateCatalog, offcutSpecs } from './nestingSuggestService.js';
import { nest, shrinkPlates, DEFAULT_CUT_GAP_MM } from './nestingPacker.js';
import { orderBlanks } from './blankService.js';

const STEEL_DENSITY = 7850;

/** kg of one sheet of this size. */
const specKg = (s) => (s.thickness * s.width * s.length * STEEL_DENSITY) / 1e9;

/**
 * How hard to look — counted in RESTARTS, never in seconds.
 *
 * ── WHY THE CLOCK HAD TO GO ──────────────────────────────────────────────────
 *
 * Each level used to carry a millisecond budget and the restart loop stopped
 * when it expired. That makes the ANSWER depend on how busy the machine was:
 * the same order packed twice gave 127 sheets and then 126, and a plan that
 * moves under you is a plan you cannot check, quote from, or hand to the floor.
 *
 * With a fixed seed and a fixed restart count, one order always packs the same
 * way. Verified: two runs at 60 restarts, byte-identical at 710.39 t.
 *
 * ── WHAT MORE EFFORT ACTUALLY BUYS ──────────────────────────────────────────
 *
 * Measured on the KEPL order — 24 rectangles over six thicknesses — with the
 * candidate sizes SORTED, which matters: an earlier round of these numbers was
 * taken against an unordered plate list and is not comparable.
 *
 *     1 restart    0.1 s   129 sheets   711.0 t
 *     8 restarts   0.6 s   128 sheets   710.5 t
 *    60 restarts   5.3 s   127 sheets   710.4 t
 *   150 restarts  12.5 s   127 sheets   710.3 t
 *
 * The whole range is 0.7 t on a 710 t order — one tenth of one per cent. The
 * greedy first pass is already there, because MIXING is where the tonnes are and
 * mixing comes free with longest-side-first placement rather than from
 * searching. Restarts only shuffle which near-equal arrangement you land on.
 *
 * SHEET COUNT IS NOISIER THAN TONNAGE, and worth knowing before reading too much
 * into it: the same order at the same restart count lands on 127 or 130 sheets
 * depending only on the seed, for the same steel. The packer scores on area
 * BOUGHT — the invoice — and treats plate count as a tie-break, so it will spend
 * three more sheets to save a kilogram. If setups ever cost more than that
 * kilogram, the scoring is the thing to change, not the effort level.
 *
const EFFORT = {
  quick: { restarts: 4 },
  standard: { restarts: 60 },
  deep: { restarts: 150 },
};

/**
 * A last-resort stop, in case an order is pathological in a way KEPL is not.
 *
 * It is deliberately far beyond anything the levels above should reach, so it
 * never fires in normal use — and when it does fire the answer is no longer
 * reproducible, which the caller is TOLD rather than left to discover by
 * noticing the number moved.
 */
const SAFETY_MS = 60000;

/**
 * The plan for an order: the sheets, what is on each, and the demand behind it.
 *
 * @param {object} opts
 * @param {'quick'|'standard'|'deep'} [opts.effort]
 */
export async function blankPlan(companyId, orderId, opts = {}) {
  const { orderNumber, blanks, skipped } = await orderBlanks(companyId, orderId);
  if (!blanks.length) {
    return { orderNumber, blanks: [], nests: [], skipped, summary: emptySummary() };
  }

  const plates = await plateCatalog(companyId);
  let drops = [];
  try {
    drops = await offcutSpecs(companyId, plates.map((p) => p.id));
  } catch {
    drops = [];        // offcut tracking is optional; its absence is not an error
  }

  const byKey = new Map(blanks.map((b) => [b.key, b]));

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
    groups.get(k).rows.push({ id: b.key, length: b.length, width: b.width, qty: b.qty });
  }

  const effort = EFFORT[opts.effort] ? opts.effort : 'standard';
  /*
   * SEEDED FROM THE ORDER. A constant would do for reproducibility, but seeding
   * per order means two orders explore different arrangements rather than every
   * order walking the same sequence of "random" restarts.
   */
  const seed = Number(orderId) || 1;
  const deadline = Date.now() + SAFETY_MS;
  let timedOut = false;

  const nests = [];
  const noSteel = [];
  let nestNo = 0;

  for (const g of groups.values()) {
    // A rectangle that does not state its steel is refused, not guessed.
    if (g.grade == null || g.material == null) {
      for (const r of g.rows) noSteel.push({ key: r.id, reason: 'no grade or material stated' });
      continue;
    }
    const specs = [...drops, ...plates].filter((p) => Number(p.thickness) === Number(g.thickness)
      && (!p.grade || String(p.grade) === String(g.grade))
      && (!p.material || String(p.material) === String(g.material)));
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
        noSteel.push({ key: r.id, reason: `no ${g.thickness} mm ${g.material} ${g.grade} plate in the catalogue` });
      }
      continue;
    }

    if (Date.now() >= deadline) timedOut = true;
    const res = nest(g.rows, specs, {
      restarts: EFFORT[effort].restarts,
      margin: DEFAULT_CUT_GAP_MM,
      seed,
      deadline,
    });

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
    const packed = shrinkPlates(res.plates, specs, DEFAULT_CUT_GAP_MM);

    for (const pl of packed) {
      nestNo += 1;
      const usedMm2 = pl.rows.reduce((s, r) => s + r.length * r.width * r.qty, 0);
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
        usedPct: usedMm2 / (pl.spec.width * pl.spec.length),
        items: pl.rows.map((r) => ({
          key: r.id,
          name: byKey.get(r.id)?.name ?? String(r.id),
          rect: `${byKey.get(r.id)?.thickness} × ${r.width} × ${r.length}`,
          qty: r.qty,
        })),
      });
    }
    for (const u of res.unplaced) {
      noSteel.push({ key: u.id ?? String(u), reason: 'would not fit any available sheet' });
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

  const out = blanks.map((b) => {
    const on = onPlates.get(b.key) ?? [];
    const placed = on.reduce((s, x) => s + x.qty, 0);
    return {
      key: b.key,
      code: b.code,
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
    reproducible: !timedOut,
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
