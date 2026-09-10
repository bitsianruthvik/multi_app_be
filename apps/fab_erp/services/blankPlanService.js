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
import { nest, DEFAULT_CUT_GAP_MM } from './nestingPacker.js';
import { orderBlanks } from './blankService.js';

const STEEL_DENSITY = 7850;

/** kg of one sheet of this size. */
const specKg = (s) => (s.thickness * s.width * s.length * STEEL_DENSITY) / 1e9;

/**
 * How hard to look. The budget belongs to the ORDER, not to each steel — a
 * six-thickness job must not take six times as long at the same setting.
 */
const EFFORT = {
  quick: { restarts: 8, budgetMs: 4000 },
  standard: { restarts: 60, budgetMs: 20000 },
  deep: { restarts: 400, budgetMs: 90000 },
};

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
  const packable = [...groups.values()].filter((g) => g.grade != null && g.material != null);
  const perGroupMs = packable.length
    ? EFFORT[effort].budgetMs / packable.length
    : EFFORT[effort].budgetMs;

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
    if (!specs.length) {
      for (const r of g.rows) {
        noSteel.push({ key: r.id, reason: `no ${g.thickness} mm ${g.material} ${g.grade} plate in the catalogue` });
      }
      continue;
    }

    const res = nest(g.rows, specs, {
      restarts: EFFORT[effort].restarts,
      margin: DEFAULT_CUT_GAP_MM,
      deadline: Date.now() + perGroupMs,
    });

    for (const pl of res.plates) {
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

  return { orderNumber, blanks: out, nests, skipped, summary: summarise(out, nests) };
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
