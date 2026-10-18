/**
 * sectionSize.js — a section size as a person types it, and the catalog bars nearest to it (the section picker,
 * routes/cutting.js GET /section-stock and GET /section-stock/nearest; walkthrough 2026-10-18 step 13: "110 x 110 x 12"
 * found nothing, and nothing said that ISA 100 × 100 × 12, 110 × 110 × 10 or 130 × 130 × 12 were there). Pure, no database.
 *
 *   parseSectionSize("ISA 110 x 110 x 12")  → { profile: 'ISA', dims: [110, 110, 12] }
 *   parseSectionSize("110×110×12mm")        → { profile: null, dims: [110, 110, 12] }
 *   parseSectionSize("110 110 12")          → { profile: null, dims: [110, 110, 12] }
 *   parseSectionSize("ISA110")              → { profile: 'ISA', dims: [110] }
 *   parseSectionSize("L 75*75*8")           → { profile: 'L', dims: [75, 75, 8] }
 *   parseSectionSize("E350")                → null   (a grade, not a size)
 *
 * A bar's size is its steel (lib/cutFrom.sectionSteelOf): DEPTH and WIDTH are the two legs / the depth and the flange,
 * THICKNESS the thickness. Typed dims are read as: three → two legs (either order) and the thickness; two → the two
 * legs; one → either leg.
 */

const NUM = /\d+(?:\.\d+)?/g;

/** The profile word a size starts with ("ISA", "ISMC", "L", "UB"…), upper case; null when it starts with a number. */
const profileWord = (s) => {
  const m = /^\s*([a-z]{1,6})(?=[\s\d.\-_×x*]|$)/i.exec(s);
  if (!m) return null;
  const w = m[1].toUpperCase();
  return w === 'X' ? null : w;
};

export function parseSectionSize(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const s = raw.replace(/×/g, 'x');
  // Only the numbers of the size: a grade (E250, E350BR, IS2062) or a stock length after the size are not dims.
  const head = s.replace(/\b(e|fe|is)\s*\d+[a-z0-9]*\b/gi, ' ').replace(/\bmm\b/gi, ' ');
  const nums = (head.match(NUM) ?? []).map(Number).filter((n) => n > 0);
  if (!nums.length) return null;
  const profile = profileWord(s);
  // "110x110x12x6000": a fourth number is the stock length.
  const dims = nums.slice(0, 3);
  const lengthMm = nums.length >= 4 && nums[3] >= 1000 ? nums[3] : null;
  return { profile, dims, lengthMm };
}

/** The leading profile word of a catalog name ("ISA 100 x 100 x 12 …" → "ISA"), else null. */
export const profileOfName = (name) => profileWord(String(name ?? '').replace(/×/g, 'x'));

const legsOf = (bar) => [bar.depth, bar.width].filter((v) => v != null && Number(v) > 0).map(Number).sort((a, b) => b - a);

/**
 * Does this bar have exactly the typed size? Legs compare in either order; a dim not typed is not asked.
 * `bar` = { depth, width, thickness } (numbers or null).
 */
export function sizeMatches(size, bar) {
  if (!size?.dims?.length) return false;
  const eq = (a, b) => a != null && Math.abs(Number(a) - Number(b)) < 0.01;
  const legs = legsOf(bar);
  const d = size.dims;
  if (d.length === 1) return legs.some((l) => eq(l, d[0]));
  const want = [d[0], d[1]].sort((a, b) => b - a);
  if (legs.length === 1) { if (!(eq(legs[0], want[0]) && eq(legs[0], want[1]))) return false; }
  else if (!(eq(legs[0], want[0]) && eq(legs[1], want[1]))) return false;
  return d.length < 3 || eq(bar.thickness, d[2]);
}

/** A rough weight index (mm² of steel), the same for the typed size and a bar, so heavier / lighter compare fairly. */
export function areaIndex(legs, thickness) {
  const [a = 0, b = a] = legs;
  if (!thickness) return a + b;
  return thickness * (a + b - thickness);
}

/**
 * The catalog SIZES nearest to a typed size, best first — same profile (the one typed, else the closest bar's) — each
 * with how it differs and whether it is heavier or lighter, and its bars (every grade and stock length of that size:
 * a part is cut from one of them).
 *
 *   bars: [{ id, name, code, depth, width, thickness, lengthMm, grade, … }]
 *   → [{ key, label: '100 × 100 × 12', profile, distance, differs: 'legs 10 mm smaller', weight: 'heavier' | 'lighter' |
 *        'same', weightPct, bars: [bar…] }]   (at most `limit` sizes)
 */
export function nearestSections(size, bars, { limit = 6 } = {}) {
  if (!size?.dims?.length) return [];
  const d = size.dims;
  const want = d.length >= 2 ? [d[0], d[1]].sort((a, b) => b - a) : [d[0]];
  const t = d.length >= 3 ? d[2] : null;
  const groups = new Map();
  for (const bar of bars) {
    const legs = legsOf(bar);
    if (!legs.length) continue;
    const bt = bar.thickness != null ? Number(bar.thickness) : null;
    const profile = profileOfName(bar.name);
    const key = `${profile ?? ''}|${legs.join('x')}|${bt ?? ''}`;
    if (groups.has(key)) { groups.get(key).bars.push(bar); continue; }
    let dist = 0;
    if (want.length === 1) dist += Math.min(...legs.map((l) => Math.abs(l - want[0]))) / want[0];
    else {
      const bl = legs.length === 1 ? [legs[0], legs[0]] : legs;
      dist += (Math.abs(bl[0] - want[0]) / want[0] + Math.abs(bl[1] - want[1]) / want[1]) / 2;
    }
    if (t != null) dist += bt == null ? 1 : (Math.abs(bt - t) / t) * 0.75;
    groups.set(key, { key, profile, legs, bt, dist, bars: [bar] });
  }
  const all = [...groups.values()].sort((a, b) => a.dist - b.dist || a.key.localeCompare(b.key));
  if (!all.length) return [];
  const profile = size.profile ?? all[0].profile;
  const same = profile ? all.filter((g) => g.profile === profile) : all;
  const pool = same.length ? same : all;
  const full = (legs) => (legs.length === 1 ? [legs[0], legs[0]] : legs);
  const typedIndex = areaIndex(full(want), t);
  const mm = (x) => Math.abs(Math.round(x * 10) / 10);
  return pool.slice(0, limit).map(({ key, profile: p, legs, bt, dist, bars: its }) => {
    const pct = typedIndex > 0 ? Math.round(((areaIndex(full(legs), t != null ? bt : null) - typedIndex) / typedIndex) * 100) : 0;
    const words = [];
    const diff = (x) => (Math.abs(x) < 0.01 ? 'the same' : `${mm(x)} mm ${x > 0 ? 'bigger' : 'smaller'}`);
    const first = legs[0] - want[0];
    const second = want.length > 1 ? full(legs)[1] - want[1] : first;
    if (want.length === 1) { if (Math.abs(first) >= 0.01) words.push(`leg ${diff(first)}`); }
    else if (Math.abs(second - first) < 0.01) { if (Math.abs(first) >= 0.01) words.push(`legs ${diff(first)}`); }
    else words.push(`long leg ${diff(first)}, short leg ${diff(second)}`);
    if (t != null && bt != null && Math.abs(bt - t) >= 0.01) words.push(`${mm(bt - t)} mm ${bt > t ? 'thicker' : 'thinner'}`);
    const label = [...full(legs), ...(bt != null ? [bt] : [])].map((x) => String(Math.round(x * 100) / 100)).join(' × ');
    return {
      key, label, profile: p, distance: Math.round(dist * 1000) / 1000,
      differs: words.length ? words.join(', ') : 'same size',
      weight: pct > 0 ? 'heavier' : pct < 0 ? 'lighter' : 'same', weightPct: pct,
      bars: [...its].sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id - b.id),
    };
  });
}
