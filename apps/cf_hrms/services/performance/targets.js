/**
 * targets.js — a job's KPI target, as a plan holds it. (Spec §18.1.)
 *
 * A plan KPI has a direction, and a number with a unit — or words:
 *   HIGHER_BETTER  95 %            "95%", "at least 95%", "2400 MT"
 *   LOWER_BETTER   30 minutes      "Max 30 minutes", "under 2 hours", "< 3", "1.50%" of a wastage KPI
 *   EXACT          0               "0" when nothing says which way is better
 *   TEXT           (words)         "100% adoption by end of Nov'26" — a target written as words
 *
 * WHAT COUNTS AS "CLEARLY A NUMBER WITH A UNIT". The whole target, and nothing
 * else: an optional "max / at most / under / < …" or "min / at least / over /
 * > …", ONE number (Indian grouping "1,50,000" allowed), an optional unit from
 * the list below, and at most one closing word of the kind "compliance" or
 * "accuracy". Anything more — a date ("by Nov'26"), a second number ("1) …
 * 2) …"), a condition ("in Q3", "in a month") — is words, kept as written with
 * direction TEXT. Wrongly turning words into a number is worse than leaving a
 * number as words: the plan shows the words and a person can type the number.
 *
 * WHICH WAY IS BETTER, when the target does not say ("95%", "15 minutes"):
 *   - "compliance", "accuracy" … after the number: higher;
 *   - a time (minutes, hours, days): lower — it is how long something takes;
 *   - the KPI's own name speaks of something to keep down (wastage, scrap,
 *     complaints, rejection, downtime, delay, deviation, time, TAT …): lower;
 *   - the definition's own direction, when it has one;
 *   - a bare 0 with none of the above: exactly;
 *   - otherwise higher.
 *
 * Pure: no database.
 */

export const DIRECTIONS = ['HIGHER_BETTER', 'LOWER_BETTER', 'EXACT', 'TEXT'];
export const DIRECTION_WORDS = { HIGHER_BETTER: 'Higher is better', LOWER_BETTER: 'Lower is better', EXACT: 'Exactly', TEXT: 'Written as words' };

const LOWER_PREFIX = /^(?:max(?:imum)?\.?|at most|up ?to|under|below|less than|not more than|no more than|within|<=?|≤)\s*/i;
const HIGHER_PREFIX = /^(?:min(?:imum)?\.?|at least|over|above|more than|not less than|>=?|≥)\s*/i;
const CURRENCY_PREFIX = /^(?:₹|rs\.?|inr)\s*/i;
const NUMBER = /^(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?/;

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
  [/^(?:lakhs?|lacs?)$/i, 'lakh'],
  [/^(?:crores?|cr\.?)$/i, 'crore'],
];
const TIME_UNITS = new Set(['minutes', 'hours', 'days']);
/** One closing word allowed after "95%": the kind of percentage it is. All of them mean "higher". */
const HIGHER_QUALIFIERS = /^(?:compliance|accuracy|adherence|achievement|attendance|completion|utili[sz]ation|efficiency|on[- ]time|availability|uptime|coverage)$/i;
/** A KPI whose name says what it measures is something to keep down. */
const LOWER_NAME = /\b(?:wastage|waste|scrap|reject(?:ion|s)?|complaints?|downtime|breakdowns?|delays?|deviation|variance|errors?|defects?|accidents?|incidents?|absent(?:eeism)?|leakage|loss(?:es)?|returns?|escalations?|overdue|pending|backlog|tat|time|turnaround|lead time|cost)\b/i;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Parse a target written as text. Returns { parsed: true, direction, number, unit }
 * or { parsed: false } (keep the text, direction TEXT).
 */
export function parseTargetText(text, { kpiName = '', definitionDirection = null } = {}) {
  let s = clean(text);
  if (!s) return { parsed: false };
  let direction = null;
  const lower = LOWER_PREFIX.exec(s);
  if (lower) { direction = 'LOWER_BETTER'; s = s.slice(lower[0].length); } else {
    const higher = HIGHER_PREFIX.exec(s);
    if (higher) { direction = 'HIGHER_BETTER'; s = s.slice(higher[0].length); }
  }
  let unit = null;
  const cur = CURRENCY_PREFIX.exec(s);
  if (cur) { unit = '₹'; s = s.slice(cur[0].length); }
  const n = NUMBER.exec(s);
  if (!n) return { parsed: false };
  const number = Number(`${n[1].replace(/,/g, '')}${n[2] ? `.${n[2]}` : ''}`);
  if (!Number.isFinite(number)) return { parsed: false };
  let rest = s.slice(n[0].length).trim();

  // The unit: "%" may touch the number; a word unit may too ("200m").
  let qualifier = null;
  if (rest.startsWith('%')) { if (unit) return { parsed: false }; unit = '%'; rest = rest.slice(1).trim(); }
  if (rest) {
    const words = rest.split(' ');
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

  if (!direction) {
    if (qualifier) direction = 'HIGHER_BETTER';
    else if (TIME_UNITS.has(unit)) direction = 'LOWER_BETTER';
    else if (LOWER_NAME.test(String(kpiName))) direction = 'LOWER_BETTER';
    else if (definitionDirection === 'LOWER_BETTER' || definitionDirection === 'HIGHER_BETTER') direction = definitionDirection;
    else if (number === 0) direction = 'EXACT';
    else direction = 'HIGHER_BETTER';
  }
  return { parsed: true, direction, number, unit };
}

const MEASUREMENT_UNIT = { PERCENTAGE: '%', CURRENCY: '₹' };

/**
 * A resolved job KPI (contentResolver item) -> what a plan KPI starts with.
 *   { direction, targetNumber, targetText, unit, jobTargetText, parsed }
 * `jobTargetText` is the job's target as a person reads it ("95%", "at least 95%").
 */
export function planTargetOf(item) {
  const op = item.targetOperator ?? null;
  const v = item.targetValue;
  const raw = v && typeof v === 'object' && !Array.isArray(v) ? v.value : v;
  const defUnit = item.unit ?? MEASUREMENT_UNIT[item.measurementType] ?? null;
  const name = item.name ?? '';
  const words = (text) => ({ direction: 'TEXT', targetNumber: null, targetText: clean(text).slice(0, 500) || null, unit: defUnit, jobTargetText: clean(text).slice(0, 500) || null, parsed: false });

  if (!op || op === 'INFO') return { ...words(''), jobTargetText: null };
  if (op === 'BETWEEN') return words(item.targetText ?? '');
  if (item.measurementType === 'BOOLEAN') return words(item.targetText ?? '');

  // A number stored as a number: the operator says which way.
  if (typeof raw === 'number' || (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) && item.measurementType !== 'TEXT')) {
    const number = Number(raw);
    const direction = op === 'GTE' ? 'HIGHER_BETTER' : op === 'LTE' ? 'LOWER_BETTER'
      : (LOWER_NAME.test(name) ? 'LOWER_BETTER' : (item.direction === 'HIGHER_BETTER' || item.direction === 'LOWER_BETTER' ? item.direction : 'EXACT'));
    return { direction, targetNumber: number, targetText: null, unit: defUnit, jobTargetText: item.targetText ?? String(number), parsed: true };
  }

  // Words: parse when it is clearly a number with a unit (Karni writes every target this way).
  if (typeof raw === 'string') {
    const p = parseTargetText(raw, { kpiName: name, definitionDirection: item.direction ?? null });
    const written = clean(raw).slice(0, 500);
    if (!p.parsed) return words(raw);
    // GTE / LTE on a text target still say which way.
    const direction = op === 'GTE' ? 'HIGHER_BETTER' : op === 'LTE' ? 'LOWER_BETTER' : p.direction;
    return { direction, targetNumber: p.number, targetText: null, unit: p.unit ?? defUnit, jobTargetText: written, parsed: true };
  }
  return words(item.targetText ?? '');
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 4 });
/** "at least 95%", "at most 30 minutes", "exactly 0", or the words. */
export function planTargetText({ direction, targetNumber, targetText, unit }) {
  if (direction === 'TEXT' || targetNumber == null) return targetText ?? 'No target set';
  const n = NUMBER_FORMAT.format(Number(targetNumber));
  const u = !unit ? '' : (unit === '%' ? '%' : unit === '₹' ? '' : ` ${unit}`);
  const value = unit === '₹' ? `₹${n}` : `${n}${u}`;
  return `${{ HIGHER_BETTER: 'at least', LOWER_BETTER: 'at most', EXACT: 'exactly' }[direction] ?? ''} ${value}`.trim();
}

export default { DIRECTIONS, DIRECTION_WORDS, parseTargetText, planTargetOf, planTargetText };
