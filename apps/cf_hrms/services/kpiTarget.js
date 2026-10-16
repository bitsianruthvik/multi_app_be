/**
 * kpiTarget.js — a KPI's target as a STRUCTURE, in one place. (TM/CF_HRMS_HIRING_SPEC.md §24 step 2.)
 *
 * WHAT IS STORED WHERE
 *   the library KPI (hrms_kpi_definitions)   measured in  = measurement_type  (PERCENTAGE · NUMBER · CURRENCY ·
 *                                                            DURATION · WEIGHT · LENGTH · BOOLEAN · DATE;
 *                                                            TEXT / RATING = not set)
 *                                            unit         = unit             ("%", "minutes", "MT", "cylinders" …)
 *                                            which way    = direction        (HIGHER_BETTER · LOWER_BETTER · EXACT ·
 *                                                                              TARGET_RANGE; NEUTRAL / NULL = not set)
 *   a job's KPI line (role row, or a position / person override)
 *                                            the TEXT     = target_value, a JSON string, operator EQ — as before. It
 *                                                           stays the display and the fallback: the JD, the Ask index,
 *                                                           Excel and the command bar read it and need nothing new.
 *                                            the SPEC     = target_json (role row) / override_json.targetSpec:
 *                                                           { measure, unit, direction, value | min + max | date }
 *   Both are optional. A KPI with neither behaves exactly as before.
 *
 * READING (effectiveTarget): the definition's measured-in, unit and direction WIN over the line's, so every
 * role, position and person using a KPI follows it; the line gives the number (or the range, or the date). A
 * line with no stored spec is read from its text (readTargetText) with the definition in mind; a line written
 * the older structured way (GTE {value: 95}) is read from its operator. What cannot be read is words.
 *
 * WRITING (readTargetInput): a structured target (a number, a range, a date, or "done") writes its TEXT from
 * the structure ("at least 95%", "between ₹10 L and ₹12 L", "done by 30 Nov 2026"); free text is kept exactly
 * as typed and its spec is filled when it reads cleanly.
 *
 * Pure: no database.
 */
import { amountText } from './performance/scoring.js';

export const MEASURES = ['PERCENTAGE', 'NUMBER', 'CURRENCY', 'DURATION', 'WEIGHT', 'LENGTH', 'BOOLEAN', 'DATE'];
export const MEASURE_WORDS = {
  PERCENTAGE: 'Percentage', NUMBER: 'Number', CURRENCY: 'Rupees', DURATION: 'Time', WEIGHT: 'Weight', LENGTH: 'Length',
  BOOLEAN: 'Done or not', DATE: 'Date / milestone',
};
/** The units a measure is counted in; the first is the default. NUMBER takes any label of its own ("cylinders"). */
export const MEASURE_UNITS = {
  PERCENTAGE: ['%'], CURRENCY: ['₹'], DURATION: ['minutes', 'hours', 'days'], WEIGHT: ['kg', 'MT'], LENGTH: ['m'], NUMBER: [], BOOLEAN: [], DATE: [],
};
export const BETTER = ['HIGHER_BETTER', 'LOWER_BETTER', 'EXACT', 'TARGET_RANGE'];
export const BETTER_WORDS = { HIGHER_BETTER: 'Higher is better', LOWER_BETTER: 'Lower is better', EXACT: 'Exactly', TARGET_RANGE: 'Within a range' };
export const BETTER_MARK = { HIGHER_BETTER: '▲', LOWER_BETTER: '▼', EXACT: '=', TARGET_RANGE: '↔' };
/** Measures that have no "which way": done or not, and a date (done on or before it). */
const NO_DIRECTION = new Set(['BOOLEAN', 'DATE']);

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const finite = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The definition's measured-in, or null when it is not set (TEXT, RATING, nothing). */
export const measureOf = (def) => (MEASURES.includes(String(def?.measurementType ?? def?.measurement_type ?? '').toUpperCase())
  ? String(def.measurementType ?? def.measurement_type).toUpperCase() : null);
/** The definition's which-way, or null when it is not set (NEUTRAL, nothing). */
export const betterOf = (def) => (BETTER.includes(String(def?.direction ?? '').toUpperCase()) ? String(def.direction).toUpperCase() : null);

/** A unit as written -> the measure it belongs to. */
export function unitMeasure(unit) {
  if (unit == null || unit === '') return null;
  const u = String(unit).trim();
  if (u === '%') return 'PERCENTAGE';
  if (u === '₹') return 'CURRENCY';
  if (/^(minutes?|hours?|days?)$/i.test(u)) return 'DURATION';
  if (/^(kg|mt)$/i.test(u)) return 'WEIGHT';
  if (/^m$/i.test(u)) return 'LENGTH';
  return 'NUMBER';
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading free text — the parser (performance/targets.js re-exports it)
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS AS "CLEARLY A NUMBER WITH A UNIT". The whole target, and nothing
 * else: an optional "max / at most / under / < …" or "min / at least / over /
 * > …", ONE number (Indian grouping "1,50,000" allowed), an optional unit from
 * the list below, and at most one closing word of the kind "compliance" or
 * "accuracy". Anything more — a date ("by Nov'26"), a second number ("1) …
 * 2) …"), a condition ("in Q3", "in a month") — is words, kept as written.
 * Wrongly turning words into a number is worse than leaving a number as words.
 *
 * WHICH WAY IS BETTER, when the target does not say ("95%", "15 minutes"):
 *   - "compliance", "accuracy" … after the number: higher;
 *   - a time (minutes, hours, days): lower — it is how long something takes;
 *   - the KPI's own name speaks of something to keep down (wastage, scrap,
 *     complaints, rejection, downtime, delay, deviation, time, TAT …): lower;
 *   - the definition's own direction, when it has one;
 *   - a bare 0 with none of the above: exactly;
 *   - otherwise higher.
 * (readTargetText puts the definition's direction FIRST: a guess never beats it.)
 */
const LOWER_PREFIX = /^(?:max(?:imum)?\.?|at most|up ?to|under|below|less than|not more than|no more than|within|<=?|≤)\s*/i;
const HIGHER_PREFIX = /^(?:min(?:imum)?\.?|at least|over|above|more than|not less than|>=?|≥)\s*/i;
const EXACT_PREFIX = /^(?:exactly|=)\s*/i;
const CURRENCY_PREFIX = /^(?:₹|rs\.?|inr)\s*/i;
const NUMBER = /^(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?/;
// "L" only as a capital: a lower-case "l" may be litres.
const MULTIPLIER = [[/^L$/, 1e5], [/^(?:lakhs?|lacs?)$/i, 1e5], [/^(?:cr\.?|crores?)$/i, 1e7]];
const MULTIPLIER_END = /(?:\bL|\b(?:lakhs?|lacs?|cr\.?|crores?))\s*$/i;

/** Unit as written -> the unit a plan stores. Order matters: longer forms first. */
const UNITS = [
  [/^%$/, '%'],
  [/^(?:working\s+)?minutes?$|^mins?\.?$/i, 'minutes'],
  [/^(?:working\s+)?hours?$|^hrs?\.?$/i, 'hours'],
  [/^(?:working\s+)?days?$/i, 'days'],
  [/^m$|^mtrs?\.?$|^metres?$|^meters?$/i, 'm'],
  [/^mt$|^tonnes?$|^tons?$/i, 'MT'],
  [/^kgs?\.?$/i, 'kg'],
  [/^(?:nos?\.?|numbers?|units?|pcs\.?|pieces?|count)$/i, 'count'],
];
const TIME_UNITS = new Set(['minutes', 'hours', 'days']);
/** One closing word allowed after "95%": the kind of percentage it is. All of them mean "higher". */
const HIGHER_QUALIFIERS = /^(?:compliance|accuracy|adherence|achievement|attendance|completion|utili[sz]ation|efficiency|on[- ]time|availability|uptime|coverage)$/i;
/** A KPI whose name says what it measures is something to keep down. */
export const LOWER_NAME = /\b(?:wastage|waste|scrap|reject(?:ion|s)?|complaints?|downtime|breakdowns?|delays?|deviation|variance|errors?|defects?|accidents?|incidents?|absent(?:eeism)?|leakage|loss(?:es)?|returns?|escalations?|overdue|pending|backlog|tat|time|turnaround|lead time|cost)\b/i;

/**
 * Parse ONE target written as text. Returns { parsed: true, direction, number, unit, explicit }
 * (`explicit`: the text itself said which way — "max", "at least", "compliance") or { parsed: false }.
 * "₹12 L", "12 lakh", "₹1.5 Cr" are rupees (unit ₹, the number in rupees).
 */
export function parseTargetText(text, { kpiName = '', definitionDirection = null } = {}) {
  let s = clean(text);
  if (!s) return { parsed: false };
  let direction = null;
  const lower = LOWER_PREFIX.exec(s);
  if (lower) { direction = 'LOWER_BETTER'; s = s.slice(lower[0].length); } else {
    const higher = HIGHER_PREFIX.exec(s);
    if (higher) { direction = 'HIGHER_BETTER'; s = s.slice(higher[0].length); } else {
      const exact = EXACT_PREFIX.exec(s);
      if (exact) { direction = 'EXACT'; s = s.slice(exact[0].length); }
    }
  }
  const explicitPrefix = direction != null;
  let unit = null;
  const cur = CURRENCY_PREFIX.exec(s);
  if (cur) { unit = '₹'; s = s.slice(cur[0].length); }
  const n = NUMBER.exec(s);
  if (!n) return { parsed: false };
  let number = Number(`${n[1].replace(/,/g, '')}${n[2] ? `.${n[2]}` : ''}`);
  if (!Number.isFinite(number)) return { parsed: false };
  let rest = s.slice(n[0].length).trim();

  // The unit: "%" may touch the number; a word unit may too ("200m").
  let qualifier = null;
  if (rest.startsWith('%')) { if (unit) return { parsed: false }; unit = '%'; rest = rest.slice(1).trim(); }
  if (rest) {
    let words = rest.split(' ');
    // Lakh / crore: rupees, with or without the ₹ in front.
    const mult = MULTIPLIER.find(([re]) => re.test(words[0]));
    if (mult && (unit === '₹' || unit === null)) { number *= mult[1]; unit = '₹'; words = words.slice(1); }
    // A unit is one or two words ("working hours"); after it, at most one qualifier.
    let matched = null;
    for (const take of [2, 1]) {
      if (unit || words.length < take) continue;
      const cand = words.slice(0, take).join(' ');
      const hit = UNITS.find(([re]) => re.test(cand));
      if (hit) { matched = { unit: hit[1], take }; break; }
    }
    let left = words;
    if (matched) { unit = matched.unit; left = words.slice(matched.take); }
    if (left.length > 1) return { parsed: false };
    if (left.length === 1) {
      if (unit !== '%' || !HIGHER_QUALIFIERS.test(left[0])) return { parsed: false };
      qualifier = left[0];
    }
  }
  number = Math.round(number * 10000) / 10000;

  if (!direction) {
    if (qualifier) direction = 'HIGHER_BETTER';
    else if (TIME_UNITS.has(unit)) direction = 'LOWER_BETTER';
    else if (LOWER_NAME.test(String(kpiName))) direction = 'LOWER_BETTER';
    else if (definitionDirection === 'LOWER_BETTER' || definitionDirection === 'HIGHER_BETTER') direction = definitionDirection;
    else if (number === 0) direction = 'EXACT';
    else direction = 'HIGHER_BETTER';
  }
  return { parsed: true, direction, number, unit, explicit: explicitPrefix || qualifier != null };
}

/* ── dates ─────────────────────────────────────────────────────────────── */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (w) => MONTHS.indexOf(String(w).slice(0, 3).toLowerCase()) + 1;
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const year4 = (y) => (String(y).length === 2 ? 2000 + Number(y) : Number(y));
function realDate(y, m, d) {
  if (!(y >= 2000 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= lastDay(y, m))) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
const DATE_PREFIX = /^(?:(?:to be )?(?:done|completed?|achieved?|closed|delivered|implemented)\s+)?(?:by|before|on or before|on|due(?: by| on)?|deadline:?)\s+/i;
const MONTH_WORD = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/** "by 30 Nov 2026", "30/11/2026", "2026-11-30", "by end of Nov'26", "Nov 2026" (its last day) -> "2026-11-30"; else null. */
export function readDateTarget(text) {
  let s = clean(text).replace(/[.,]$/, '');
  if (!s) return null;
  const pre = DATE_PREFIX.exec(s);
  if (pre) s = s.slice(pre[0].length);
  s = s.replace(/^(?:the )?end of (?:the month of )?/i, 'end ');
  const end = /^end /i.test(s);
  if (end) s = s.slice(4);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m && !end) return realDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(s);
  if (m && !end) return realDate(year4(m[3]), Number(m[2]), Number(m[1]));
  m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_WORD}\\.?\\s*(?:'|’)?\\s*(\\d{2}|\\d{4})$`, 'i').exec(s);
  if (m && !end) return realDate(year4(m[3]), monthOf(m[2]), Number(m[1]));
  m = new RegExp(`^${MONTH_WORD}\\.?\\s*(?:'|’)?\\s*(\\d{2}|\\d{4})$`, 'i').exec(s);
  if (m) { const y = year4(m[2]); const mo = monthOf(m[1]); return realDate(y, mo, lastDay(y, mo)); }
  return null;
}
const LONG_DAY = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/* ── ranges ────────────────────────────────────────────────────────────── */
const RANGE = /^(?:between|from)?\s*(.+?)\s*(?:–|—|-|\bto\b|\band\b)\s*(.+)$/i;
/** "10-12%", "between ₹10 L and ₹12 L", "2 to 4 hours" -> { min, max, unit }; else null. */
export function readRangeText(text) {
  const s = clean(text);
  const m = RANGE.exec(s);
  if (!m) return null;
  const a = parseTargetText(m[1]);
  const b = parseTargetText(m[2]);
  if (!a.parsed || !b.parsed || a.explicit || b.explicit) return null;
  // One side may leave the unit, or the lakh / crore, to the other: "10-12%", "10-12 L", "₹10-12 Cr".
  let ua = a.unit ?? null;
  const ub = b.unit ?? null;
  let min = a.number;
  if (ub === '₹' && (ua == null || ua === '₹') && MULTIPLIER_END.test(m[2]) && !MULTIPLIER_END.test(m[1])) {
    min = a.number * (/(?:cr\.?|crores?)\s*$/i.test(m[2]) ? 1e7 : 1e5);
    ua = '₹';
  }
  const unit = ua ?? ub;
  if (ua && ub && ua !== ub) return null;
  if (!(b.number > min)) return null;
  return { min, max: b.number, unit };
}

/* ══════════════════════════════════════════════════════════════════════════
 * The spec
 * ══════════════════════════════════════════════════════════════════════════ */

/** A spec with its keys in one order and only the ones it needs — what is stored. null when it holds nothing. */
export function normaliseSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const measure = MEASURES.includes(spec.measure) ? spec.measure : null;
  const direction = measure && NO_DIRECTION.has(measure) ? null : (BETTER.includes(spec.direction) ? spec.direction : null);
  const out = { measure, unit: spec.unit == null || spec.unit === '' ? null : String(spec.unit).slice(0, 30), direction };
  if (measure === 'BOOLEAN') return { measure, unit: null, direction: null };
  if (measure === 'DATE') return ISO.test(String(spec.date ?? '')) ? { measure, unit: null, direction: null, date: String(spec.date) } : null;
  if (direction === 'TARGET_RANGE') {
    const min = finite(spec.min);
    const max = finite(spec.max);
    return min != null && max != null ? { ...out, min, max } : null;
  }
  const value = finite(spec.value);
  return value != null ? { ...out, value } : (measure || direction ? out : null);
}

/** The older structured way (GTE {value: 95}, BETWEEN {min, max}, EQ true) -> a spec; EQ "words" -> null (read the text). */
export function specFromOperator(operator, value) {
  const op = String(operator ?? '').toUpperCase();
  if (!op || op === 'INFO') return null;
  const raw = value && typeof value === 'object' && !Array.isArray(value) && 'value' in value ? value.value : value;
  if (op === 'BETWEEN') {
    const min = finite(value?.min ?? value?.[0]);
    const max = finite(value?.max ?? value?.[1]);
    return min != null && max != null ? { measure: null, unit: null, direction: 'TARGET_RANGE', min, max } : null;
  }
  if (raw === true || raw === false) return { measure: 'BOOLEAN', unit: null, direction: null };
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : null);
  if (n == null) return null;
  return { measure: null, unit: null, direction: op === 'GTE' ? 'HIGHER_BETTER' : op === 'LTE' ? 'LOWER_BETTER' : null, value: n };
}

/** The target's words: the text an EQ line stores, or null. */
export function textOfTarget(operator, value) {
  if (String(operator ?? '').toUpperCase() !== 'EQ') return null;
  const raw = value && typeof value === 'object' && !Array.isArray(value) && 'value' in value ? value.value : value;
  // A number stored as the words of an EQ line ("0" decodes to 0) is still what the line says.
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return typeof raw === 'string' && clean(raw) ? clean(raw) : null;
}

/** Does a unit fit a measure? (A NUMBER takes any label; an empty unit fits anything.) */
const unitFits = (measure, unit) => !unit || !measure || measure === 'NUMBER' ? true
  : (MEASURE_UNITS[measure] ?? []).some((u) => u.toLowerCase() === String(unit).toLowerCase());

/**
 * Text -> a spec, with the definition in mind; null when it does not read cleanly (it stays words).
 *   - a "Done or not" KPI: any text is "done" (the words say what is to be done);
 *   - a date ("by 30 Nov 2026") — only for a KPI not measured in something else;
 *   - a range ("10-12%") — only when the KPI is not set to one way;
 *   - one number with a unit — its unit must fit the measured-in, and an explicit
 *     "max" / "at least" must agree with the definition's direction.
 * The definition's direction wins over every guess.
 */
export function readTargetText(text, { def = null, name = '' } = {}) {
  const s = clean(text);
  if (!s) return null;
  const dm = measureOf(def);
  const db = betterOf(def);
  const dUnit = def?.unit ? String(def.unit).trim() : null;
  if (dm === 'BOOLEAN') return { measure: 'BOOLEAN', unit: null, direction: null };

  const date = readDateTarget(s);
  if (date) return dm && dm !== 'DATE' ? null : { measure: 'DATE', unit: null, direction: null, date };
  if (dm === 'DATE') return null;

  const fit = (unit) => {
    const pm = unit ? unitMeasure(unit) : null;
    if (dm && pm && pm !== dm && !(dm === 'NUMBER' && unit === 'count')) return false;
    if (dm && dUnit && unit && dm !== 'NUMBER' && unit.toLowerCase() !== dUnit.toLowerCase()) return false;
    return true;
  };
  const measureFor = (unit) => dm ?? (unit ? unitMeasure(unit) : 'NUMBER');
  const unitFor = (unit) => (dm ? (dUnit ?? unit ?? MEASURE_UNITS[dm]?.[0] ?? null) : unit ?? null);

  const range = readRangeText(s);
  if (range) {
    if (db && db !== 'TARGET_RANGE') return null;
    if (!fit(range.unit)) return null;
    return { measure: measureFor(range.unit), unit: unitFor(range.unit), direction: 'TARGET_RANGE', min: range.min, max: range.max };
  }

  // A NUMBER KPI's own label ("2400 cylinders") is its unit.
  let t = s;
  let labelled = false;
  if (dm === 'NUMBER' && dUnit) {
    const re = new RegExp(`\\s*${dUnit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/s$/i, '')}s?$`, 'i');
    if (re.test(t) && t.replace(re, '').trim()) { t = t.replace(re, '').trim(); labelled = true; }
  }
  const p = parseTargetText(t, { kpiName: name, definitionDirection: db });
  if (!p.parsed) return null;
  const unit = labelled ? dUnit : p.unit;
  if (!labelled && !fit(unit)) return null;
  if (db === 'TARGET_RANGE') return null;
  if (db && p.explicit && p.direction !== db) return null;
  return { measure: measureFor(unit), unit: unitFor(unit), direction: db ?? p.direction, value: p.number };
}

/**
 * THE effective target of a KPI line: the definition's measured-in / unit / direction over the line's spec.
 * @param def   { measurementType, unit, direction }  (or the snake_case row)
 * @param line  { spec?, operator?, value?, text? }   the stored spec, else the older operator, else the text
 * @returns { measure, unit, direction, value?, min?, max?, date?, mark, sentence, text, short, from: {measure, direction} } or null (words)
 */
export function effectiveTarget(def, { spec = undefined, operator = null, value = null, text = null, name = '' } = {}) {
  const dm = measureOf(def);
  const db = betterOf(def);
  const words = text ?? textOfTarget(operator, value);
  let raw = spec && typeof spec === 'object' ? spec : null;
  if (!raw) raw = specFromOperator(operator, value);
  if (!raw && words) raw = readTargetText(words, { def, name });
  if (!raw && typeof value === 'string' && ['GTE', 'LTE'].includes(String(operator).toUpperCase())) {
    // An older line: GTE / LTE on a target written as text ("95%") still says which way.
    raw = readTargetText(value, { def, name });
    if (raw && raw.value != null && !betterOf(def)) raw = { ...raw, direction: String(operator).toUpperCase() === 'GTE' ? 'HIGHER_BETTER' : 'LOWER_BETTER' };
  }
  if (!raw && dm === 'BOOLEAN' && operator && operator !== 'INFO') raw = { measure: 'BOOLEAN' };
  if (!raw) return null;

  const measure = dm ?? raw.measure ?? (raw.unit ? unitMeasure(raw.unit) : null) ?? 'NUMBER';
  let direction = NO_DIRECTION.has(measure) ? null : (db ?? raw.direction ?? null);
  const defUnit = def?.unit ? String(def.unit).trim() : null;
  const unit = NO_DIRECTION.has(measure) ? null
    : dm ? (defUnit ?? (unitFits(dm, raw.unit) ? raw.unit : null) ?? MEASURE_UNITS[dm]?.[0] ?? null)
      : (raw.unit ?? null);
  const out = { measure, unit, direction };
  if (measure === 'BOOLEAN') return finish(out, def, dm, db);
  if (measure === 'DATE') return raw.date ? finish({ ...out, date: raw.date }, def, dm, db) : null;
  if (direction === 'TARGET_RANGE') {
    if (raw.min == null || raw.max == null) return null;
    return finish({ ...out, min: Number(raw.min), max: Number(raw.max) }, def, dm, db);
  }
  if (raw.value == null) return null;
  // A number that does not say which way ("0", EQ 5): the KPI's name first ("complaints" is lower), as the parser does.
  if (!direction) direction = LOWER_NAME.test(String(name)) ? 'LOWER_BETTER' : Number(raw.value) === 0 ? 'EXACT' : 'HIGHER_BETTER';
  return finish({ ...out, direction, value: Number(raw.value) }, def, dm, db);
}

function finish(spec, def, dm, db) {
  return {
    ...spec,
    mark: spec.measure === 'DATE' ? 'by' : spec.measure === 'BOOLEAN' ? '✓' : BETTER_MARK[spec.direction] ?? null,
    sentence: targetSentence(spec),
    text: writtenText(spec),
    short: shortText(spec),
    from: { measure: dm != null, direction: db != null },
  };
}

/** A number with its unit: "95%", "30 minutes", "₹12 L", "2,400 cylinders". */
export const amount = (value, unit) => amountText(value, unit === 'count' ? null : unit) ?? String(value);
/** Two ends of a range: "₹10 L and ₹12 L", "10% and 12%", "2 and 4 hours". */
const ends = (spec, join) => (spec.unit === '₹' || spec.unit === '%' || !spec.unit || spec.unit === 'count'
  ? `${amount(spec.min, spec.unit)}${join}${amount(spec.max, spec.unit)}`
  : `${amount(spec.min, null)}${join}${amount(spec.max, spec.unit)}`);

/** The value alone, short — "95%", "₹10 L – ₹12 L", "30 Nov 2026", "Done". */
export function shortText(spec) {
  if (!spec) return null;
  if (spec.measure === 'BOOLEAN') return 'Done';
  if (spec.measure === 'DATE') return spec.date ? LONG_DAY(spec.date) : null;
  if (spec.direction === 'TARGET_RANGE') return ends(spec, ' – ');
  return spec.value == null ? null : amount(spec.value, spec.unit);
}

/** The text a structured line STORES (what the JD prints): "at least 95%", "between ₹10 L and ₹12 L", "done by 30 Nov 2026". */
export function writtenText(spec) {
  if (!spec) return null;
  if (spec.measure === 'BOOLEAN') return 'done';
  if (spec.measure === 'DATE') return spec.date ? `done by ${LONG_DAY(spec.date)}` : null;
  if (spec.direction === 'TARGET_RANGE') return `between ${ends(spec, ' and ')}`;
  if (spec.value == null) return null;
  const word = { HIGHER_BETTER: 'at least', LOWER_BETTER: 'at most', EXACT: 'exactly' }[spec.direction] ?? '';
  return `${word} ${amount(spec.value, spec.unit)}`.trim();
}

/** The live sentence: "At least 95% — higher is better", "Between ₹10 L and ₹12 L", "Done by 30 Nov 2026". */
export function targetSentence(spec) {
  if (!spec) return null;
  if (spec.measure === 'BOOLEAN') return 'Done or not — met when it is done';
  if (spec.measure === 'DATE') return spec.date ? `Done by ${LONG_DAY(spec.date)}` : null;
  if (spec.direction === 'TARGET_RANGE') return `Between ${ends(spec, ' and ')} — inside the range is met`;
  if (spec.value == null) return null;
  const a = amount(spec.value, spec.unit);
  if (spec.direction === 'LOWER_BETTER') return `At most ${a} — lower is better`;
  if (spec.direction === 'EXACT') return `Exactly ${a} — no more, no less`;
  return `At least ${a} — higher is better`;
}

/**
 * A target as a screen or a file sends it -> what a line stores.
 *   { text }                               free text: kept as typed; its spec filled when it reads cleanly
 *   { value } | { min, max } | { date } | { done: true }
 *                                          structured: checked against the definition; the TEXT is written from it
 *   (+ { direction, measure, unit } when the definition does not say them)
 *   null / {} / { text: '' }               no target
 * @returns { operator: 'EQ'|null, text: string|null, spec: object|null, empty: boolean }
 */
export function readTargetInput(input, def, problems, { name = '' } = {}) {
  const t = input && typeof input === 'object' ? input : (typeof input === 'string' ? { text: input } : {});
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  const structured = has(t.value) || has(t.min) || has(t.max) || has(t.date) || t.done === true;
  if (!structured) {
    const text = clean(t.text);
    if (!text) return { operator: null, text: null, spec: null, empty: true };
    if (text.length > 500) problems.push('A target is up to 500 characters.');
    return { operator: 'EQ', text, spec: normaliseSpec(readTargetText(text, { def, name })), empty: false };
  }
  const dm = measureOf(def);
  const db = betterOf(def);
  const measure = dm ?? (MEASURES.includes(String(t.measure ?? '').toUpperCase()) ? String(t.measure).toUpperCase() : null)
    ?? (t.done === true ? 'BOOLEAN' : has(t.date) ? 'DATE' : (t.unit ? unitMeasure(t.unit) : 'NUMBER'));
  const direction = NO_DIRECTION.has(measure) ? null
    : db ?? (BETTER.includes(String(t.direction ?? '').toUpperCase()) ? String(t.direction).toUpperCase() : (has(t.min) || has(t.max) ? 'TARGET_RANGE' : null));
  const unit = NO_DIRECTION.has(measure) ? null : (dm ? (def?.unit || MEASURE_UNITS[dm]?.[0] || null) : (has(t.unit) ? clean(t.unit).slice(0, 30) : MEASURE_UNITS[measure]?.[0] ?? null));
  const before = problems.length;
  let spec = null;
  if (measure === 'BOOLEAN') spec = { measure, unit: null, direction: null };
  else if (measure === 'DATE') {
    const d = String(t.date ?? '').slice(0, 10);
    if (!ISO.test(d) || !realDate(Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10)))) problems.push('Give the date it is due (YYYY-MM-DD).');
    else spec = { measure, unit: null, direction: null, date: d };
  } else if (direction === 'TARGET_RANGE') {
    const min = finite(t.min);
    const max = finite(t.max);
    if (min == null || max == null) problems.push('A range needs its lowest and its highest value, as numbers.');
    else if (!(max > min)) problems.push('The highest value of the range must be above the lowest.');
    else spec = { measure, unit, direction, min, max };
  } else {
    const value = finite(t.value);
    if (value == null) problems.push('The target is a number.');
    else if (!direction) problems.push('Say which way is better: higher, lower or exactly.');
    else spec = { measure, unit, direction, value };
  }
  if (spec && measure === 'PERCENTAGE' && [spec.value, spec.min, spec.max].some((v) => v != null && (v < 0 || v > 1000))) problems.push('A percentage target is between 0 and 1000.');
  if (problems.length > before) return { operator: null, text: null, spec: null, empty: false };
  const eff = effectiveTarget(def, { spec, name });
  return { operator: 'EQ', text: eff?.text ?? writtenText(spec), spec: normaliseSpec(spec), empty: false };
}

/** The vocabularies, as a screen draws them. */
export function targetVocabulary() {
  return {
    measures: MEASURES.map((m) => ({ value: m, label: MEASURE_WORDS[m], units: MEASURE_UNITS[m] })),
    directions: BETTER.map((d) => ({ value: d, label: BETTER_WORDS[d], mark: BETTER_MARK[d] })),
  };
}

export default {
  MEASURES, MEASURE_WORDS, MEASURE_UNITS, BETTER, BETTER_WORDS, BETTER_MARK, measureOf, betterOf, unitMeasure,
  parseTargetText, readDateTarget, readRangeText, readTargetText, normaliseSpec, specFromOperator, textOfTarget,
  effectiveTarget, writtenText, targetSentence, shortText, readTargetInput, targetVocabulary, amount,
};
