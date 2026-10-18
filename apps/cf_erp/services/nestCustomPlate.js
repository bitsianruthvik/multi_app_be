/**
 * nestCustomPlate.js — CF_ERP. The AI proposes ONE custom plate size per steel, within the mill's sizes, and it is
 * added to the catalog when that nesting is used (user, 2026-10-18, item 20: "AI proposes the optimal custom plate
 * size within limits; add it to the catalog when that nesting is accepted").
 *
 * WHAT IS PROPOSED. The packers lay a steel's pieces out on the CATALOG sizes; a plate's layout often stops well short
 * of its end or far side. A plate of exactly the size the layout needs — its extent plus the ordering margins (mill
 * edges are not straight), rounded up to the order step (orderedSize, the rule the size advice already uses) — is a
 * size a mill rolls to order. For each steel this module tries every size the plates' layouts need (lengths × widths
 * of the needed sizes, inside the limits) as ONE custom size the plates may move to, and keeps the one that saves the
 * most, by the cost the packers already rank by (nestCost.js):
 *
 *   cost of a plate  = its price (catalog list price as area; else its area) + its CUSTOM / short-plate penalty
 *                      − half the price of the usable remnant it leaves (a remnant is kept; COMPARE.md)
 *   a plate moves    when its cost on the custom size (the same price per mm², + the custom premium, 2 %) is lower
 *   one more size    costs the size penalty (150 kg of steel), and is refused when it would break the company's
 *                    "plate sizes per thickness, at most" (§83) — unless the custom size REPLACES a size
 *   proposed         only when the saving is at least MIN_SAVING_KG (and 1 % of the steel's plates) — never noise
 *
 * Steel bought and waste fall by the same kilograms (the parts do not change): both are reported, before and after.
 *
 * THE LIMITS (`cf_company_settings.nest_custom_plates`, init.sql §90; Setup › Cutting): { on, maxLength, maxWidth,
 * minLength, minWidth, step }. NULL / off = no custom size is ever proposed (the default: the mill's sizes are the
 * company's to say). A blank limit = the catalog's own range (the longest / widest plate of that thickness, the
 * shortest / narrowest of all); a blank step = the cut-settings band's order step.
 *
 * PURE but for nothing: numbers in, numbers out.
 */
import { remnantArea, kgToArea, COST_DEFAULTS } from './nestCost.js';

/** A proposal must save at least this much steel (kg), and 1 % of the steel's plates. */
export const MIN_SAVING_KG = 50;
const EPS = 0.0005;

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };

/** The stored setting (JSON text or object) → { on, maxLength, maxWidth, minLength, minWidth, step } | null (off). */
export function customPlateSetting(v) {
  let o = v;
  if (o == null) return null;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
  if (!o || typeof o !== 'object' || !(o.on === true || o.on === 1 || o.on === '1')) return null;
  return { on: true, maxLength: pos(o.maxLength), maxWidth: pos(o.maxWidth), minLength: pos(o.minLength), minWidth: pos(o.minWidth), step: pos(o.step) };
}

/** What a setting is saved as, checked: → { value (JSON text or null), problems }. */
export function customPlateInput(input) {
  if (input == null || input === false || input?.on === false) return { value: input?.on === false ? JSON.stringify({ on: false, ...limitsOf(input) }) : null, problems: [] };
  const problems = [];
  const L = limitsOf(input);
  for (const [k, words] of [['maxLength', 'Longest'], ['maxWidth', 'Widest'], ['minLength', 'Shortest'], ['minWidth', 'Narrowest'], ['step', 'Step']]) {
    const raw = input[k];
    if (raw == null || raw === '') continue;
    if (!(Number(raw) > 0 && Number(raw) <= 30000)) problems.push(`${words}: a number of mm between 1 and 30 000, or blank.`);
  }
  if (L.maxLength && L.minLength && L.minLength > L.maxLength) problems.push('The shortest length is more than the longest.');
  if (L.maxWidth && L.minWidth && L.minWidth > L.maxWidth) problems.push('The narrowest width is more than the widest.');
  if (L.maxWidth && L.maxLength && L.maxWidth > L.maxLength) problems.push('The widest width is more than the longest length (a plate\'s length is its long side).');
  return { value: JSON.stringify({ on: true, ...L }), problems };
}
function limitsOf(o) {
  return { maxLength: pos(o?.maxLength), maxWidth: pos(o?.maxWidth), minLength: pos(o?.minLength), minWidth: pos(o?.minWidth), step: pos(o?.step) };
}

/**
 * The limits for one thickness: the setting where it says, else the catalog's range.
 *   catalog   every catalog plate [{ steel: { thickness, length, width } }] (any grade)
 *   band      the cut settings of this thickness (orderMarginLengthMm, orderMarginWidthMm, orderStepMm)
 * → { maxLength, maxWidth, minLength, minWidth, step, marginLength, marginWidth, basis }
 */
export function customLimits(setting, catalog, thickness, band) {
  const sized = (catalog ?? []).filter((p) => p.steel?.length > 0 && p.steel?.width > 0);
  const same = sized.filter((p) => Math.abs(Number(p.steel.thickness) - Number(thickness)) <= 0.01);
  const pool = same.length ? same : sized;
  const long = (p) => Math.max(p.steel.length, p.steel.width); const short = (p) => Math.min(p.steel.length, p.steel.width);
  const from = [];
  const pick = (own, fallback, what) => { if (own != null) return own; if (fallback != null) from.push(what); return fallback; };
  const out = {
    maxLength: pick(setting?.maxLength, pool.length ? Math.max(...pool.map(long)) : null, 'longest'),
    maxWidth: pick(setting?.maxWidth, pool.length ? Math.max(...pool.map(short)) : null, 'widest'),
    minLength: pick(setting?.minLength, sized.length ? Math.min(...sized.map(long)) : null, 'shortest'),
    minWidth: pick(setting?.minWidth, sized.length ? Math.min(...sized.map(short)) : null, 'narrowest'),
    step: setting?.step ?? (Number(band?.orderStepMm) > 0 ? Number(band.orderStepMm) : 50),
    marginLength: Number(band?.orderMarginLengthMm) || 0,
    marginWidth: Number(band?.orderMarginWidthMm) || 0,
  };
  out.basis = from.length ? `the ${from.join(', ')} from the catalog${same.length ? ` (${fmtMm(thickness)} mm plates)` : ''}, the rest as set in Setup › Cutting` : 'as set in Setup › Cutting';
  return out;
}

const fmtMm = (n) => String(Math.round(Number(n) * 1000) / 1000);
const up = (v, step) => Math.ceil((Number(v) - EPS) / step) * step;

/**
 * The best custom size for one steel's plates, or null.
 *   nests     [{ length, width, requiredLength, requiredWidth, plateItemId, ownerPartyId, source, areaCost?, penalty? }]
 *             areaCost / penalty: the plate's price as area and its penalty (nestCost.plateCosts); absent = its area, 0
 *   opts      { limits, thickness, density, maxSizes, rules: { customPct, sizePenaltyKg, offcutValue, offcutMinArea, offcutMinSide } }
 * → { length, width, moves: [index], savingArea, savingKg, before: { plates, areaMm2, kg }, after: { … }, sizesBefore, sizesAfter } | null
 */
export function proposeCustomSize(nests, { limits, thickness, density = 7850, maxSizes = COST_DEFAULTS.maxSizes, rules = {} } = {}) {
  const R = { ...COST_DEFAULTS, offcutMinArea: 90000, offcutMinSide: 100, ...rules };
  if (!limits?.maxLength || !limits?.maxWidth) return null;
  const step = Number(limits.step) > 0 ? Number(limits.step) : 50;
  const kgPerMm2 = (Number(thickness) || 0) * ((Number(density) > 0 ? Number(density) : 7850) * 1e-9);
  const sizeKey = (l, w) => `${Math.max(l, w)}x${Math.min(l, w)}`;
  const bought = nests.map((n, i) => ({ n, i })).filter(({ n }) => !n.ownerPartyId && n.source !== 'offcut' && n.length > 0 && n.width > 0);
  if (!bought.length) return null;
  const rows = bought.map(({ n, i }) => {
    const area = n.length * n.width;
    const price = Number(n.areaCost) > 0 ? Number(n.areaCost) : area;
    const unit = price / area;                                   // price of one mm² of this plate
    const remnantOld = remnantArea({ length: n.length, width: n.width, maxX: n.requiredLength, maxY: n.requiredWidth, minArea: R.offcutMinArea, minSide: R.offcutMinSide });
    const costOld = price + (Number(n.penalty) || 0) - R.offcutValue * remnantOld * unit;
    let needL = Math.max(up(Number(n.requiredLength) + (limits.marginLength ?? 0), step), limits.minLength ?? 0);
    let needW = Math.max(up(Number(n.requiredWidth) + (limits.marginWidth ?? 0), step), limits.minWidth ?? 0);
    if (needL < needW) needL = needW;                            // the length is the long side: the layout runs along it
    // A size never larger than the plate it would replace (it would only cost more), never past the mill's limits.
    needL = Math.min(needL, Math.max(n.length, n.width)); needW = Math.min(needW, Math.min(n.length, n.width));
    const fitsLimits = needL <= limits.maxLength + EPS && needW <= limits.maxWidth + EPS && needL + EPS >= Number(n.requiredLength) && needW + EPS >= Number(n.requiredWidth);
    return { i, n, area, unit, costOld, needL, needW, fitsLimits, key: sizeKey(n.length, n.width) };
  });
  const sizesBefore = new Set(rows.map((r) => r.key)).size;
  const lengths = [...new Set(rows.filter((r) => r.fitsLimits).map((r) => r.needL))];
  const widths = [...new Set(rows.filter((r) => r.fitsLimits).map((r) => r.needW))];
  const sizePen = kgToArea(R.sizePenaltyKg, thickness, density);
  let best = null;
  for (const L of lengths) {
    for (const W of widths) {
      if (W > L || L > limits.maxLength + EPS || W > limits.maxWidth + EPS || L + EPS < (limits.minLength ?? 0) || W + EPS < (limits.minWidth ?? 0)) continue;
      let gain = 0; const moves = [];
      for (const r of rows) {
        if (!r.fitsLimits || r.needL > L + EPS || r.needW > W + EPS) continue;
        if (Math.abs(L * W - r.area) <= 1) continue;               // the same size: nothing to gain
        const remnantNew = remnantArea({ length: L, width: W, maxX: r.n.requiredLength, maxY: r.n.requiredWidth, minArea: R.offcutMinArea, minSide: R.offcutMinSide });
        const costNew = L * W * r.unit * (1 + R.customPct) - R.offcutValue * remnantNew * r.unit;
        if (r.costOld - costNew > 0) { gain += r.costOld - costNew; moves.push(r); }
      }
      if (!moves.length) continue;
      const kept = rows.filter((r) => !moves.includes(r));
      const sizesAfter = new Set([...kept.map((r) => r.key), sizeKey(L, W)]).size;
      if (maxSizes && sizesAfter > maxSizes && sizesAfter > sizesBefore) continue;
      const net = gain - sizePen * Math.max(0, sizesAfter - sizesBefore);
      if (!best || net > best.net + 1e-6 || (Math.abs(net - best.net) <= 1e-6 && L * W < best.L * best.W)) best = { L, W, moves, net, sizesAfter };
    }
  }
  if (!best) return null;
  const areaBefore = rows.reduce((a, r) => a + r.area, 0);
  const areaAfter = areaBefore - best.moves.reduce((a, r) => a + r.area - best.L * best.W, 0);
  const savingKg = (areaBefore - areaAfter) * kgPerMm2;
  const netKg = best.net / (rows.reduce((a, r) => a + r.unit, 0) / rows.length) * kgPerMm2;
  if (netKg < MIN_SAVING_KG || savingKg < 0.01 * areaBefore * kgPerMm2) return null;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    length: best.L, width: best.W,
    moves: best.moves.map((r) => r.i),
    replaces: [...new Map(best.moves.map((r) => [r.n.plateItemId ?? r.key, { plateItemId: r.n.plateItemId ?? null, plateCode: r.n.plateCode ?? null, length: r.n.length, width: r.n.width, plates: best.moves.filter((x) => (x.n.plateItemId ?? x.key) === (r.n.plateItemId ?? r.key)).length }])).values()],
    savingKg: r3(savingKg), netSavingKg: r3(netKg),
    before: { plates: rows.length, kg: r3(areaBefore * kgPerMm2) },
    after: { plates: rows.length, kg: r3(areaAfter * kgPerMm2) },
    sizesBefore, sizesAfter: best.sizesAfter,
  };
}
