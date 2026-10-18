/**
 * nestCost.js — CF_ERP. What a plate layout COSTS, beyond the steel bought (2026-10-18, the ProNest
 * comparison: TM/nest_learning/COMPARE.md, "what the AI should still learn" 1–3).
 *
 * The packers' own score is steel bought (`areaCost` per plate, summed). On that score alone the AI
 * mixed up to six catalog sizes per thickness, several of them short CUSTOM plates, to save a few
 * hundred kilograms on paper — and counted a big clean remnant as pure waste. The shop buys one or
 * two sizes per thickness and keeps its remnants. So a layout is now judged by
 *
 *   score = Σ plate price (areaCost)                        the steel bought, priced
 *         + Σ plate penalty (CUSTOM / short plates)         per plate, from its catalog row
 *         + handling × plates bought                        every plate is a crane lift and a setup
 *         + sizePenalty × (distinct sizes − 1)              every size is one more stock line to buy
 *         − offcutValue × usable remnant × its price        a clean remnant at a plate end is kept
 *   and, above the score, `sizeOver` = distinct sizes beyond `maxSizes` (company setting, default 2):
 *   a layout that places every piece on fewer sizes always beats one that needs more than the limit.
 *
 * Everything is in the packers' unit: mm² of steel of that thickness at the group's reference price.
 * The penalties are set in KG of steel (so they mean the same money at every thickness) and turned
 * into mm² here. `areaCost` stays the plate's price as area-equivalent (equal to its area when no
 * catalog price is set, or when every plate of the thickness has the same rate) — `areaBought` keeps
 * meaning "steel bought".
 *
 * PURE: numbers in, numbers out. Used by nestingService (sheets + rules), shapePacker (its search),
 * packJob (rows vs true shapes) and packerPool.pickBest (best of the seeds).
 */

/** The defaults; a company setting overrides `maxSizes` (cf_company_settings.nest_max_plate_sizes, init.sql §83). */
export const COST_DEFAULTS = Object.freeze({
  maxSizes: 2,            // distinct plate sizes per thickness (0 / null = no limit)
  sizePenaltyKg: 150,     // per distinct size beyond the first
  plateHandlingKg: 20,    // per plate bought
  customPct: 0.02,        // a CUSTOM plate (or one that does not say) costs 2 % more than a STANDARD one
  shortPct: 0.03,         // a short plate (under half the longest length offered) 3 % more
  shortRatio: 0.5,
  offcutValue: 0.5,       // a usable remnant is worth half its steel
});

const DENSITY_KG_MM3 = 7.85e-6;

/** kg of steel of this thickness → mm² of plate. */
export const kgToArea = (kg, thicknessMm, density = 7850) => {
  const t = Number(thicknessMm);
  const d = (Number(density) > 0 ? Number(density) : 7850) * 1e-9;
  return t > 0 ? Number(kg) / (t * (d || DENSITY_KG_MM3)) : 0;
};

/** A plate's price per kg from its list price, or null. basis 'tonne' | 'kg' | 'unit' (a unit = one plate). */
export function ratePerKg(listPrice, basis, plateKg) {
  const p = Number(listPrice);
  if (!(p > 0)) return null;
  if (basis === 'tonne') return p / 1000;
  if (basis === 'kg') return p;
  if (basis === 'unit' && plateKg > 0) return p / plateKg;
  return null;
}

/**
 * The price and penalty of each candidate plate of ONE thickness.
 * plates: [{ length, width, kind?: 'STANDARD'|'CUSTOM'|null, ratePerKg?: number|null }]
 * → [{ areaCost, penalty }] in the same order. areaCost = area × rate / reference rate (the median of the
 * priced plates; an unpriced plate is at the reference rate), penalty = areaCost × (custom % + short %).
 */
export function plateCosts(plates, rules = {}) {
  const R = { ...COST_DEFAULTS, ...rules };
  const rates = plates.map((p) => Number(p.ratePerKg)).filter((r) => r > 0).sort((a, b) => a - b);
  const ref = rates.length ? rates[Math.floor(rates.length / 2)] : null;
  const longest = Math.max(0, ...plates.map((p) => Math.max(Number(p.length), Number(p.width))));
  return plates.map((p) => {
    const area = Number(p.length) * Number(p.width);
    const r = Number(p.ratePerKg);
    const areaCost = ref && r > 0 ? area * (r / ref) : area;
    const custom = String(p.kind ?? '').toUpperCase() !== 'STANDARD';
    const short = Math.max(Number(p.length), Number(p.width)) < R.shortRatio * longest - 1e-6;
    return { areaCost, penalty: areaCost * ((custom ? R.customPct : 0) + (short ? R.shortPct : 0)) };
  });
}

/** The packer's cost rules for one thickness, in mm². `maxSizes` 0 / null = no limit. */
export function costRulesFor(thicknessMm, { maxSizes, density, offcutMinArea = 90000, offcutMinSide = 100, ...rest } = {}) {
  const R = { ...COST_DEFAULTS, ...rest };
  const ms = maxSizes === undefined ? R.maxSizes : maxSizes;
  return {
    maxSizes: Number(ms) > 0 ? Math.trunc(Number(ms)) : null,
    sizePenalty: kgToArea(R.sizePenaltyKg, thicknessMm, density),
    platePenalty: kgToArea(R.plateHandlingKg, thicknessMm, density),
    offcutValue: Math.max(0, Math.min(0.95, Number(R.offcutValue) || 0)),
    offcutMinArea: Number(offcutMinArea) || 0,
    offcutMinSide: Number(offcutMinSide) || 0,
  };
}

/**
 * The usable remnant of one plate whose parts end at maxX (along) / maxY (across): the larger of the
 * clean strip at the far END (full width) and the strip along the far SIDE (as long as the parts run),
 * when it passes the offcut rule. mm².
 */
export function remnantArea({ length, width, maxX, maxY, margin = 0, gap = 0, minArea = 0, minSide = 0 }) {
  const ok = (a, b) => a >= minSide - 1e-9 && b >= minSide - 1e-9 && a * b >= minArea - 1e-6;
  const endL = Number(length) - Number(maxX) - Number(gap) - Number(margin);
  const endW = Number(width) - 2 * Number(margin);
  const sideW = Number(width) - Number(maxY) - Number(gap) - Number(margin);
  const sideL = Number(maxX) - Number(margin);
  let best = 0;
  if (endL > 0 && endW > 0 && ok(endL, endW)) best = Math.max(best, endL * endW);
  if (sideW > 0 && sideL > 0 && ok(sideW, sideL)) best = Math.max(best, sideW * sideL);
  return best;
}

/**
 * The score of a finished layout (any packer's nests). `sheets`: Map sheetKey → { length, width, areaCost,
 * penalty?, preferred?, fixed? }; nests: [{ sheetKey, extent: { maxX, maxY } }].
 * → { cost, score, sizes, sizeOver, plates }   (cost = Σ areaCost of the plates bought: the old score)
 */
export function layoutScore(nests, sheets, rules = null, { margin = 0, gap = 0 } = {}) {
  let cost = 0; let pen = 0; let credit = 0; let plates = 0;
  const sizes = new Set();
  for (const n of nests ?? []) {
    const s = sheets.get(String(n.sheetKey)) ?? sheets.get(n.sheetKey);
    if (!s) continue;
    const c = s.fixed ? 0 : Number(s.areaCost ?? (s.preferred ? 0 : s.length * s.width)) || 0;
    cost += c;
    if (c <= 0) continue;                               // owned / the customer's: not bought, no size
    plates += 1;
    pen += Number(s.penalty) || 0;
    sizes.add(`${Math.max(s.length, s.width)}x${Math.min(s.length, s.width)}`);
    if (rules?.offcutValue > 0 && n.extent) {
      const a = remnantArea({ length: s.length, width: s.width, maxX: n.extent.maxX, maxY: n.extent.maxY, margin, gap, minArea: rules.offcutMinArea, minSide: rules.offcutMinSide });
      credit += rules.offcutValue * a * (c / (s.length * s.width));
    }
  }
  if (!rules) return { cost, score: cost, sizes: sizes.size, sizeOver: 0, plates };
  const score = cost + pen + rules.platePenalty * plates + rules.sizePenalty * Math.max(0, sizes.size - 1) - credit;
  return { cost, score, sizes: sizes.size, sizeOver: rules.maxSizes ? Math.max(0, sizes.size - rules.maxSizes) : 0, plates };
}

/** The extent of a nest from either packer: true-shape placements (bbox) or row pieces (x + length). */
export function extentOf(nest) {
  let maxX = 0; let maxY = 0;
  for (const p of nest?.placements ?? []) { maxX = Math.max(maxX, p.bbox ? p.bbox.x1 : p.x); maxY = Math.max(maxY, p.bbox ? p.bbox.y1 : p.y); }
  for (const p of nest?.pieces ?? []) { maxX = Math.max(maxX, Number(p.x) + Number(p.length)); maxY = Math.max(maxY, Number(p.y) + Number(p.width)); }
  return { maxX, maxY };
}

/** Order of two scored answers: fewer pieces left off, then fewer sizes over the limit, then the lower score. <0 = a better. */
export function compareScored(a, b) {
  if (a.off !== b.off) return a.off - b.off;
  if ((a.sizeOver ?? 0) !== (b.sizeOver ?? 0)) return (a.sizeOver ?? 0) - (b.sizeOver ?? 0);
  const d = (a.score ?? a.area) - (b.score ?? b.area);
  return Math.abs(d) > 1e-6 ? d : 0;
}
