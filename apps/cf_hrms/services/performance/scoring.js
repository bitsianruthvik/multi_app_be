/**
 * scoring.js — achievement, KRA score, plan score and status band, computed in
 * ONE place and never stored. (TM/CF_HRMS_HIRING_SPEC.md §19.1.)
 *
 * Every read that shows a number — the plan page, the Plans list's Score
 * column, the Actuals grid's chip, the org chart's dot, My plan — gets it from
 * scorePlan() below, through actualsService.scorePlans(). Pure: no database.
 *
 * ACHIEVEMENT of one KPI (a percentage, capped to 0–120):
 *   HIGHER_BETTER   actual ÷ target              (a target of 0 or less: met when actual ≥ target)
 *   LOWER_BETTER    target ÷ actual              (an actual of 0 counts as 100% when the target is ≥ 0)
 *   EXACT           100 when equal, else 0
 *   TARGET_RANGE    inside the range (lowest ≤ actual ≤ highest) → 100. Outside, by distance,
 *                   the same two rules as above against the nearer end:
 *                     below the lowest   actual ÷ lowest      (as HIGHER_BETTER against the lowest)
 *                     above the highest  highest ÷ actual     (as LOWER_BETTER against the highest)
 *                   so 9% for a 10–12% range is 90%, and 15% is 80%. Never above 100.
 *                   (rangeAchievement below is the one place this rule is written.)
 *   DATE            done on or before the date → 100; done after it → 0. Not done yet →
 *                   not counted. The actual is the day it was done (value_text, YYYY-MM-DD).
 *   TEXT            met → 100, not met → 0, no answer → not counted
 *
 * SEVERAL SLOTS make one actual, as the KPI's combine rule says:
 *   SUM       the slots' values added (counts, output, leads). The target is for
 *             the whole period, so it is taken pro rata to the slots that have a
 *             value: 800 MT in the one month entered, of a 2,400 MT quarter, is
 *             100% of the 800 MT that month needed — not "33%, behind".
 *   AVERAGE   the slots' mean (percentages, rates, times)
 *   LAST      the latest slot with a value (a level at the end)
 *   A target written as words takes each slot's met / not met: AVERAGE (and SUM)
 *   = the share of slots met; LAST = the latest answer.
 *
 * KRA SCORE = the average of its KPIs' achievements; weighted by the KPI weights
 * when every KPI of the KRA has one. PLAN SCORE = the weighted average of the KRA
 * scores (KRA weights; equal when none are set). KPIs under no KRA count as one
 * more heading, weighing as much as the average KRA. A KPI with no actual yet is
 * left out — of its KRA and of the plan — and the plan says "based on N of M KPIs".
 * A heading with nothing counted is left out too; the weights of the rest are
 * scaled up to fill.
 *
 * BANDS (thresholds from Performance settings): on track ≥ 90 · at risk ≥ 70 ·
 * behind below · no data.
 *
 * THE GAP, in words, next to the achievement (kpiResult's `gapText`): the combined
 * actual against the target it is held to, direction- and unit-aware —
 * "3 pts short" / "2 pts ahead" (%), "₹2.1 L ahead" / "₹50,000 short" (money,
 * Indian grouping), "12 min over" / "4 hours under" (lower is better), "on target",
 * "met" / "not met" (words). PACE: a SUM KPI part-way through the period (fewer
 * slots in than it has) is held to the target pro rata (above), so its gap is
 * against that, and `pace` says ON_PACE / BEHIND_PACE with `paceNote`
 * "Target pro-rated to 1 of 3 months: …".
 *
 * THE RESULT TONE (resultTone) — what a scorecard row is coloured by: MET or not.
 * Not the band (a KPI at 97% is "on track" but not met):
 *   MET      achievement ≥ 100 (beaten counts; a words target met; a SUM on pace)
 *   CLOSE    not met, but at or above the company's at-risk threshold
 *   BELOW    below the at-risk threshold
 *   NO_DATA  no actual yet
 * The bands and the plan score are unchanged; a plan's score takes the same tone.
 */

export const COMBINE_RULES = ['SUM', 'AVERAGE', 'LAST'];
export const COMBINE_WORDS = { SUM: 'Added up', AVERAGE: 'Average', LAST: 'Latest' };
export const BANDS = ['ON_TRACK', 'AT_RISK', 'BEHIND', 'NO_DATA'];
export const BAND_WORDS = { ON_TRACK: 'On track', AT_RISK: 'At risk', BEHIND: 'Behind', NO_DATA: 'No data' };
export const DEFAULT_BANDS = Object.freeze({ onTrack: 90, atRisk: 70 });
export const CAP = 120;

/** Units that are a rate or a time: their slots are averaged. Everything else (counts, MT, m, ₹ …) is added up. */
const AVERAGE_UNIT = /%|percent|minute|min\b|mins|hour|hrs?\b|day|rate|ratio|score|rating|index|time|days?$/i;

/** The combine rule a KPI starts with, from its unit and direction. */
export function defaultCombine(unit, direction) {
  if (String(direction ?? '').toUpperCase() === 'TEXT') return 'AVERAGE';
  if (String(direction ?? '').toUpperCase() === 'DATE') return 'LAST';
  return unit && AVERAGE_UNIT.test(String(unit)) ? 'AVERAGE' : 'SUM';
}

const AMOUNT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
/** A number with its unit, as a person reads it: "92%", "8 hours", "₹12 L", "₹1.5 Cr", "₹50,000". */
export function amountText(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  if (unit === '₹') {
    const sign = v < 0 ? '-' : '';
    const a = Math.abs(v);
    if (a >= 1e7) return `${sign}₹${AMOUNT.format(a / 1e7)} Cr`;
    if (a >= 1e5) return `${sign}₹${AMOUNT.format(a / 1e5)} L`;
    return `${sign}₹${AMOUNT.format(a)}`;
  }
  const n = AMOUNT.format(v);
  if (!unit) return n;
  return unit === '%' ? `${n}%` : `${n} ${unit}`;
}
/** A difference with its unit: percentage POINTS for %, else the amount. */
const diffText = (d, unit) => (unit === '%' ? `${AMOUNT.format(d)} pt${Math.abs(d) === 1 ? '' : 's'}` : amountText(d, unit));
const SLOT_NOUN = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', QUARTERLY: 'quarter', HALF_YEARLY: 'half', YEARLY: 'year' };

/**
 * The gap of a combined actual against the target it is held to, in words.
 * @returns { gap: number|null (positive = better than the target), gapText }
 */
export function gapOf(direction, combined, target, unit, targetMax = null) {
  if (direction === 'TEXT' || direction === 'DATE' || combined == null || target == null || !Number.isFinite(Number(combined))) return { gap: null, gapText: null };
  if (direction === 'TARGET_RANGE') {
    if (targetMax == null) return { gap: null, gapText: null };
    const c = Number(combined);
    if (c < Number(target)) { const d = Math.round((Number(target) - c) * 100) / 100; return { gap: -d, gapText: `${diffText(d, unit)} below the range` }; }
    if (c > Number(targetMax)) { const d = Math.round((c - Number(targetMax)) * 100) / 100; return { gap: -d, gapText: `${diffText(d, unit)} above the range` }; }
    return { gap: 0, gapText: 'within the range' };
  }
  const d = Math.round((Number(combined) - Number(target)) * 100) / 100;
  if (Math.abs(d) < 0.005) return { gap: 0, gapText: 'on target' };
  if (direction === 'LOWER_BETTER') return { gap: -d, gapText: `${diffText(Math.abs(d), unit)} ${d > 0 ? 'over' : 'under'}` };
  if (direction === 'EXACT') return { gap: -Math.abs(d), gapText: `${diffText(Math.abs(d), unit)} ${d > 0 ? 'over' : 'under'}` };
  return { gap: d, gapText: `${diffText(Math.abs(d), unit)} ${d > 0 ? 'ahead' : 'short'}` };
}

export const RESULT_TONES = ['MET', 'CLOSE', 'BELOW', 'NO_DATA'];
export const RESULT_WORDS = { MET: 'Met', CLOSE: 'Not met — close', BELOW: 'Not met — below', NO_DATA: 'No actual yet' };
/** The tone of a result: met or beaten / close / below / no data (thresholds from Performance settings). */
export function resultTone(achievement, bands = DEFAULT_BANDS) {
  if (achievement == null || !Number.isFinite(Number(achievement))) return 'NO_DATA';
  const a = Number(achievement);
  if (a >= 100) return 'MET';
  return a >= Number(bands.atRisk) ? 'CLOSE' : 'BELOW';
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const cap = (n) => Math.max(0, Math.min(CAP, n));
const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.00005;

/** Achievement of one number against one target (a range: `target` its lowest, `targetMax` its highest), capped. null when there is no target. */
export function achievementOf(direction, actual, target, targetMax = null) {
  if (actual == null || !Number.isFinite(Number(actual))) return null;
  const a = Number(actual);
  if (direction === 'TARGET_RANGE') return rangeAchievement(a, target, targetMax);
  if (direction === 'EXACT') return target == null ? null : (same(a, target) ? 100 : 0);
  if (target == null || !Number.isFinite(Number(target))) return null;
  const t = Number(target);
  if (direction === 'HIGHER_BETTER') return cap(t > 0 ? (a / t) * 100 : (a >= t ? 100 : 0));
  if (direction === 'LOWER_BETTER') {
    if (a <= 0) return t >= 0 || a <= t ? 100 : 0;
    return cap((t / a) * 100);
  }
  return null;
}

/**
 * THE range rule (one place): inside → 100; below the lowest → actual ÷ lowest; above the
 * highest → highest ÷ actual. 0 when the end it is held to is 0 or less (nothing to divide by).
 */
export function rangeAchievement(actual, min, max) {
  if (actual == null || min == null || max == null) return null;
  const a = Number(actual);
  const lo = Number(min);
  const hi = Number(max);
  if (a >= lo && a <= hi) return 100;
  if (a < lo) return lo > 0 ? Math.max(0, Math.min(100, (a / lo) * 100)) : 0;
  return a > 0 ? Math.max(0, Math.min(100, (hi / a) * 100)) : 0;
}

const DAY_MS = 86400000;
const isoDay = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);
/** Days from a to b (b later = positive). */
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const DAY_WORDS = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A met / not met answer as an achievement. */
const metAchievement = (met) => (met === 'YES' ? 100 : met === 'NO' ? 0 : null);

/**
 * One KPI's result from its live actuals.
 * @param kpi { direction, targetNumber, combine, slotCount }
 * @param actuals [{ slotStart, valueNumber, met }]   the live ones, any order
 * @returns { achievement, combined, combinedTarget, counted, slotCount, band? }
 */
export function kpiResult(kpi, actuals = []) {
  const rule = COMBINE_RULES.includes(kpi.combine) ? kpi.combine : defaultCombine(kpi.unit, kpi.direction);
  const slotCount = Math.max(1, Number(kpi.slotCount ?? 1));
  const sorted = [...actuals].sort((x, y) => (x.slotStart < y.slotStart ? -1 : x.slotStart > y.slotStart ? 1 : 0));
  if (kpi.direction === 'DATE') {
    // The latest slot that says when it was done; met when on or before the target date.
    const done = sorted.filter((a) => isoDay(a.valueText));
    const target = isoDay(kpi.targetDate);
    if (!done.length || !target) return { achievement: null, combined: null, combinedTarget: target, counted: 0, slotCount, rule: 'LAST', gap: null, gapText: null, pace: null, paceNote: null };
    const day = isoDay(done[done.length - 1].valueText);
    const early = daysBetween(day, target);
    const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
    return {
      achievement: early >= 0 ? 100 : 0, combined: day, combinedTarget: target, counted: done.length, slotCount, rule: 'LAST',
      gap: early, gapText: early === 0 ? 'done on the day' : early > 0 ? `done ${days(early)} early` : `done ${days(-early)} late`,
      pace: null, paceNote: null, doneOn: DAY_WORDS(day),
    };
  }
  if (kpi.direction === 'TEXT') {
    const answered = sorted.filter((a) => a.met === 'YES' || a.met === 'NO');
    if (!answered.length) return { achievement: null, combined: null, combinedTarget: null, counted: 0, slotCount, rule, gap: null, gapText: null, pace: null, paceNote: null };
    const met = answered.filter((a) => a.met === 'YES').length;
    const achievement = rule === 'LAST' ? metAchievement(answered[answered.length - 1].met) : (met / answered.length) * 100;
    return {
      achievement: round1(achievement), combined: rule === 'LAST' ? answered[answered.length - 1].met : `${met} of ${answered.length} met`,
      combinedTarget: null, counted: answered.length, slotCount, rule,
      gap: null, gapText: achievement === 100 ? 'met' : achievement === 0 ? 'not met' : `${met} of ${answered.length} met`, pace: null, paceNote: null,
    };
  }
  const values = sorted.filter((a) => a.valueNumber != null && Number.isFinite(Number(a.valueNumber)));
  if (!values.length) return { achievement: null, combined: null, combinedTarget: null, counted: 0, slotCount, rule, gap: null, gapText: null, pace: null, paceNote: null };
  const nums = values.map((a) => Number(a.valueNumber));
  let combined;
  let target = kpi.targetNumber == null ? null : Number(kpi.targetNumber);
  let targetMax = kpi.direction === 'TARGET_RANGE' && kpi.targetMax != null ? Number(kpi.targetMax) : null;
  if (rule === 'SUM') {
    combined = nums.reduce((t, n) => t + n, 0);
    if (target != null && slotCount > 1) target = (target * values.length) / slotCount;
    if (targetMax != null && slotCount > 1) targetMax = (targetMax * values.length) / slotCount;
  } else if (rule === 'LAST') combined = nums[nums.length - 1];
  else combined = nums.reduce((t, n) => t + n, 0) / nums.length;
  const achievement = achievementOf(kpi.direction, combined, target, targetMax);
  const { gap, gapText } = gapOf(kpi.direction, combined, target, kpi.unit ?? null, targetMax);
  // Part-way through: a SUM target taken pro rata — the gap is against that, and says so.
  const partWay = rule === 'SUM' && slotCount > 1 && values.length < slotCount && target != null;
  const noun = SLOT_NOUN[String(kpi.entryFrequency ?? '').toUpperCase()] ?? 'slot';
  return {
    achievement: round1(achievement), combined: Math.round(combined * 10000) / 10000,
    combinedTarget: target == null ? null : Math.round(target * 10000) / 10000,
    combinedTargetMax: targetMax == null ? null : Math.round(targetMax * 10000) / 10000, counted: values.length, slotCount, rule,
    gap, gapText: partWay && gapText ? `${gap >= 0 ? 'on pace' : 'behind pace'} · ${gapText}` : gapText,
    pace: partWay ? (gap >= 0 ? 'ON_PACE' : 'BEHIND_PACE') : null,
    paceNote: partWay ? `Target pro-rated to ${values.length} of ${slotCount} ${noun}${slotCount === 1 ? '' : 's'}: ${amountText(target, kpi.unit ?? null)}${targetMax != null ? ` – ${amountText(targetMax, kpi.unit ?? null)}` : ''}` : null,
  };
}

/** The band of a score. */
export function bandOf(score, bands = DEFAULT_BANDS) {
  if (score == null) return 'NO_DATA';
  if (score >= Number(bands.onTrack)) return 'ON_TRACK';
  if (score >= Number(bands.atRisk)) return 'AT_RISK';
  return 'BEHIND';
}

/** A weighted average over [{ score, weight }] with a score; equal when no weight is usable. */
function weighted(items) {
  const scored = items.filter((x) => x.score != null);
  if (!scored.length) return null;
  const total = scored.reduce((t, x) => t + (x.weight ?? 0), 0);
  if (!(total > 0)) return scored.reduce((t, x) => t + x.score, 0) / scored.length;
  return scored.reduce((t, x) => t + x.score * (x.weight ?? 0), 0) / total;
}

/**
 * A whole plan.
 * @param plan { kras: [{ id, weightPercent }], kpis: [{ id, planKraId, weightPercent, direction, targetNumber, unit, combine, slotCount }] }
 * @param actualsByKpi Map<kpiId, [{ slotStart, valueNumber, met }]>
 * @returns { score, band, basedOn: { counted, total }, line, kras: Map<kraId, {score, band, counted, total}>, kpis: Map<kpiId, result+band>, ungrouped }
 */
export function scorePlan(plan, actualsByKpi, bands = DEFAULT_BANDS) {
  const kpis = new Map();
  for (const k of plan.kpis) {
    const r = kpiResult(k, actualsByKpi.get(Number(k.id)) ?? []);
    kpis.set(Number(k.id), { ...r, band: bandOf(r.achievement, bands) });
  }
  const groupScore = (list) => {
    const allWeighted = list.length > 0 && list.every((k) => k.weightPercent != null);
    const score = weighted(list.map((k) => ({ score: kpis.get(Number(k.id)).achievement, weight: allWeighted ? Number(k.weightPercent) : 1 })));
    const counted = list.filter((k) => kpis.get(Number(k.id)).achievement != null).length;
    return { score: round1(score), band: bandOf(score == null ? null : round1(score), bands), counted, total: list.length };
  };
  const kras = new Map();
  for (const kra of plan.kras) kras.set(Number(kra.id), groupScore(plan.kpis.filter((k) => Number(k.planKraId) === Number(kra.id))));
  const loose = plan.kpis.filter((k) => k.planKraId == null || !kras.has(Number(k.planKraId)));
  const ungrouped = loose.length ? groupScore(loose) : null;

  const kraWeights = plan.kras.filter((k) => k.weightPercent != null).map((k) => Number(k.weightPercent));
  const useWeights = plan.kras.length > 0 && kraWeights.length === plan.kras.length;
  const avgWeight = useWeights ? kraWeights.reduce((t, w) => t + w, 0) / kraWeights.length : 1;
  const groups = plan.kras.map((k) => ({ score: kras.get(Number(k.id)).score, weight: useWeights ? Number(k.weightPercent) : 1 }));
  if (ungrouped) groups.push({ score: ungrouped.score, weight: avgWeight });
  const score = round1(weighted(groups));
  const counted = [...kpis.values()].filter((r) => r.achievement != null).length;
  const total = plan.kpis.length;
  return {
    score, band: bandOf(score, bands), bandLabel: BAND_WORDS[bandOf(score, bands)],
    basedOn: { counted, total },
    line: total === 0 ? 'This plan has no KPIs.' : counted === 0 ? 'No actuals yet.' : `Based on ${counted} of ${total} KPI${total === 1 ? '' : 's'}.`,
    kras, kpis, ungrouped,
  };
}

export default { COMBINE_RULES, COMBINE_WORDS, BANDS, BAND_WORDS, DEFAULT_BANDS, CAP, defaultCombine, achievementOf, rangeAchievement, kpiResult, bandOf, scorePlan, gapOf, amountText, resultTone, RESULT_TONES, RESULT_WORDS };
