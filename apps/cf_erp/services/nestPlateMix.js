/**
 * nestPlateMix.js — CF_ERP. THE PLATE MIX OF A WHOLE STEEL, chosen at once (2026-11-10, nest benchmark SO260018:
 * TM/nest_bench/reports/nesting_benchmark_SO260018.html, "IMPROVE EXISTING" item 1).
 *
 * One packer run decides plate by plate. This takes SEVERAL complete layouts of the same pieces (packJob makes them:
 * its own answer and runs on single plate sizes), treats every plate of every layout as a PATTERN (its pieces, the room
 * its parts need), and picks, for each allowed set of plate sizes (one or two — the company's sizes per thickness), the
 * patterns that cover every piece for the least price: greedy by useful steel per unit price, surplus copies simply not
 * cut (a legal layout less some parts is still legal). The least-used plates of the best covers are then packed again
 * (packJob does that; `tailOf` says which). packJob keeps the result only when its own ranking says it is better.
 *
 * PURE: numbers in, numbers out. No packer is called from here.
 */

const EPS = 1e-6;
/** A round hole up to this is a bolt hole: it never takes a part, so the extra searches are spared its points. */
export const BOLT_HOLE_MAX_MM = 42;

const boxOf = (r) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, x1, y1 }; };
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a / 2); };

/** Shape pieces with their bolt holes (round, ≤ BOLT_HOLE_MAX_MM across) left out of the rings. Cut-outs stay. */
export function withoutBoltHoles(pieces) {
  return (pieces ?? []).map((p) => {
    const r = p?.rings;
    if (!r || Array.isArray(r) || !Array.isArray(r.holes) || !r.holes.length) return p;
    const holes = r.holes.filter((h) => { const b = boxOf(h); return Math.max(b.x1 - b.x0, b.y1 - b.y0) > BOLT_HOLE_MAX_MM + 0.5; });
    return holes.length === r.holes.length ? p : { ...p, rings: { ...r, holes } };
  });
}

/** Steel in one piece (outline less cut-outs and holes), mm²; its rectangle when it has no rings. */
export function pieceArea(p) {
  const r = p?.rings;
  if (r && !Array.isArray(r) && r.outline) return Math.max(0, ringArea(r.outline) - (r.cutouts ?? []).reduce((a, c) => a + ringArea(c), 0) - (r.holes ?? []).reduce((a, c) => a + ringArea(c), 0));
  if (Array.isArray(r) && r.length) { const list = typeof r[0]?.[0] === 'number' ? [r] : r; return Math.max(0, ringArea(list[0]) - list.slice(1).reduce((a, c) => a + ringArea(c), 0)); }
  return (Number(p?.length) || 0) * (Number(p?.width) || 0);
}

/**
 * The plates of one packer answer (true-shape `placements`, or the row packer's `pieces`) as patterns:
 * [{ sheetKey, placements: [{ key, x, y, rotationDeg, mirrored, bbox }], counts: Map key → n, ex, ey }].
 * A row piece's box is its footprint (never smaller than its outline).
 */
export function platesOf(out) {
  const plates = [];
  for (const n of out?.nests ?? []) {
    const pl = n.placements
      ? n.placements.map((q) => ({ key: q.key, x: Number(q.x), y: Number(q.y), rotationDeg: q.rotationDeg ?? 0, mirrored: !!q.mirrored, bbox: q.bbox ?? null }))
      : (n.pieces ?? []).map((q) => ({ key: q.key, x: Number(q.x), y: Number(q.y), rotationDeg: q.rotated ? 90 : 0, mirrored: false, bbox: { x0: Number(q.x), y0: Number(q.y), x1: Number(q.x) + Number(q.length), y1: Number(q.y) + Number(q.width) } }));
    if (!pl.length || pl.some((q) => !q.bbox)) continue;
    plates.push(pattern(n.sheetKey, pl));
  }
  return plates;
}
function pattern(sheetKey, placements) {
  let ex = 0, ey = 0;
  const counts = new Map();
  for (const q of placements) { ex = Math.max(ex, q.bbox.x1); ey = Math.max(ey, q.bbox.y1); counts.set(String(q.key), (counts.get(String(q.key)) ?? 0) + 1); }
  return { sheetKey: String(sheetKey), placements, counts, ex, ey };
}

/** A pattern cut down to `take` (key → n): the other parts are simply not cut. */
function trim(p, take) {
  const left = new Map(take);
  const pl = [];
  for (const q of p.placements) { const n = left.get(String(q.key)) ?? 0; if (n > 0) { pl.push(q); left.set(String(q.key), n - 1); } }
  return pattern(p.sheetKey, pl);
}

/**
 * The covers of `demand` (Map key → qty) by the patterns of `layouts` (arrays of patterns), one per allowed set of sizes.
 *   sheets   Map sheetKey → { length, width, areaCost, penalty, available, preferred }  (only bought sheets are used)
 *   net      Map key → steel of one piece (mm²): what a pattern is worth
 *   margin   the clearance a part keeps from the plate edge: a pattern may be bought as any size that holds ex/ey + margin
 *   rules    nestCost.costRulesFor (platePenalty, sizePenalty, maxSizes) or null
 * → [{ sizes: [sheetKey], plates: [pattern + buy], cost }] cheapest first. Pure.
 */
export function covers(layouts, { demand, sheets, net, margin = 0, rules = null }) {
  const pool = layouts.flat();
  const bought = [...sheets.entries()].filter(([, s]) => !s.preferred && !s.fixed);
  const costOf = (s) => (Number(s.areaCost ?? s.length * s.width) || 0) + (Number(s.penalty) || 0) + (Number(rules?.platePenalty) || 0);
  const fits = (p, s) => p.ex + margin <= s.length + EPS && p.ey + margin <= s.width + EPS;
  const maxSizes = rules?.maxSizes == null ? 2 : Math.max(1, Number(rules.maxSizes));
  const sets = [];
  bought.forEach((a, i) => { sets.push([a]); if (maxSizes >= 2) bought.slice(i + 1).forEach((b) => sets.push([a, b])); });
  const out = [];
  for (const S of sets) {
    // each pattern bought as the cheapest size of S that holds it
    const usable = [];
    for (const p of pool) {
      let best = null;
      for (const [k, s] of S) if (fits(p, s) && (!best || costOf(s) < best.c)) best = { k, c: costOf(s) };
      if (best) usable.push({ p, ...best });
    }
    if (!usable.length) continue;
    const rem = new Map(demand);
    let left = [...rem.values()].reduce((a, b) => a + b, 0);
    const used = new Map();
    const plates = [];
    while (left > 0) {
      let pick = null;
      for (const u of usable) {
        if ((used.get(u.k) ?? 0) >= (Number(sheets.get(u.k).available) || Infinity)) continue;
        let a = 0;
        for (const [k, n] of u.p.counts) { const r = rem.get(k) ?? 0; if (r > 0) a += Math.min(n, r) * (net.get(k) ?? 0); }
        if (a <= 0) continue;
        const e = a / u.c;
        if (!pick || e > pick.e + 1e-12 || (Math.abs(e - pick.e) <= 1e-12 && u.c < pick.u.c)) pick = { u, e };
      }
      if (!pick) break;
      const take = new Map();
      for (const [k, n] of pick.u.p.counts) { const r = rem.get(k) ?? 0; const t = Math.min(n, r); if (t > 0) { take.set(k, t); rem.set(k, r - t); left -= t; } }
      used.set(pick.u.k, (used.get(pick.u.k) ?? 0) + 1);
      plates.push({ ...trim(pick.u.p, take), buy: pick.u.k, cost: pick.u.c });
    }
    if (left > 0) continue;
    const sizes = [...new Set(plates.map((p) => p.buy))];
    const cost = plates.reduce((a, p) => a + p.cost, 0) + (Number(rules?.sizePenalty) || 0) * Math.max(0, sizes.length - 1);
    out.push({ sizes: S.map(([k]) => k), plates, cost });
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/** The least-used plates of a cover (useful steel per price): at least two, 15 % of them; and the pieces they hold. */
export function tailOf(cover, net) {
  const order = cover.plates.map((p, i) => ({ i, u: [...p.counts].reduce((a, [k, n]) => a + n * (net.get(k) ?? 0), 0) / Math.max(1, p.cost) })).sort((a, b) => a.u - b.u);
  const pick = new Set(order.slice(0, Math.max(2, Math.ceil(cover.plates.length * 0.15))).map((x) => x.i));
  const need = new Map();
  for (const i of pick) for (const [k, n] of cover.plates[i].counts) need.set(k, (need.get(k) ?? 0) + n);
  return { keep: cover.plates.filter((_, i) => !pick.has(i)), need, count: pick.size };
}

/** Patterns back into a packer answer's nests (the bought size as the sheet). */
export function nestsOf(plates, sheets) {
  return plates.map((p) => { const s = sheets.get(p.buy ?? p.sheetKey); return { sheetKey: p.buy ?? p.sheetKey, sheetLength: s?.length, sheetWidth: s?.width, placements: p.placements }; });
}
