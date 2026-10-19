/**
 * plateGrade.js — CF_ERP. May this piece be cut from this plate, by GRADE and IMPACT CLASS? (user, 2026-10-18,
 * item 22: "Grade/impact check in nesting — think of the right way to bring this into nesting.")
 *
 * WHERE THE REQUIREMENT COMES FROM. A cut piece (a CUT_PLATE temporary) carries its own GRADE and IMPACT_CLASS
 * values; a blank copies its steel from the part it serves (cutPlateService), and an ORDER / LINE value
 * (cf_order_spec_defaults, init.sql §65 — "MS BO or BR … set at an order or a line level") is stored ON the rows as
 * source 'defaulted' (orderValuesService.derivedWrites). So the piece's own stored value IS the order's requirement
 * unless the row overrides it — nesting reads that one value, never the order again. A catalog plate carries GRADE
 * and IMPACT_CLASS the same way (E350 BO / E350 BR: two plates of one size).
 *
 * THE RULE (company setting `cf_company_settings.nest_grade_rule`, init.sql §90; NULL = 'exact', the default):
 *   'warn'    the check of 'better', shown — never refused, the AI's plates not narrowed (a company's choice)
 *   'better'  the plate's grade is the piece's grade; its impact class is the piece's or a BETTER one
 *   'exact'   the plate's grade and impact class are exactly the piece's
 *   'higher'  a HIGHER grade of the same family may stand in (E350 for E250), impact as 'better'
 *
 * THE ORDER OF IMPACT CLASSES (IS 2062:2011 sub-qualities, EN 10025 the same steps): A (no impact test) < BR (tested
 * at room temperature) < B0 (0 °C; written BO in the catalog) < C (−20 °C); JR < J0 < J2 < K2 alongside. A class not
 * in the list is only ever equal to itself. A plate class tested colder holds a piece that asks for a warmer test —
 * an RDSO BR piece on a BO plate is fine under 'better', and refused under 'exact'.
 *
 * DEFINITE vs NOT KNOWN. Both sides state a value and they do not fit → a DEFINITE mismatch (`ok: false`): nesting
 * never chooses that plate, and saving such a layout is refused naming the pieces and plates. The piece asks for an
 * impact class and the plate states none → NOT KNOWN (`ok: true, sure: false`): allowed, and said as a warning. A
 * plate with no grade is the long-standing data-entry gap (nestingService.agrees) — allowed, silently, as before.
 *
 * PURE.
 */

export const GRADE_RULES = Object.freeze(['warn', 'better', 'exact', 'higher']);
/**
 * The DEFAULT is 'exact' (the user, 2026-10-19: "BO/BR, don't allow for now" — a BR piece never on a BO plate nor the
 * reverse). 'warn' works the check out as 'better' and SHOWS it (accept's gradeCheck, the Compare tab, upload notes) but
 * refuses nothing and does not narrow the AI's plates — a company may pick it in Setup › Cutting.
 */
export const DEFAULT_GRADE_RULE = 'exact';
/** Does this rule refuse (and narrow the AI's plates)? Every rule but 'warn'. */
export const blocks = (rule) => ruleOf(rule) !== 'warn';

/** Rank of each impact class: higher = tested colder / harder. Aliases share a rank. */
const IMPACT_RANK = new Map([
  ['A', 0], ['NONE', 0], ['NA', 0],
  ['BR', 1], ['JR', 1],
  ['B0', 2], ['BO', 2], ['J0', 2],
  ['C', 3], ['J2', 3],
  ['K2', 4],
]);
/** The impact classes as the screens list them, weakest first. */
export const IMPACT_ORDER_WORDS = 'A (no impact test) < BR (room temperature) < BO / B0 (0 °C) < C (−20 °C)';

const blank = (v) => v == null || String(v).trim() === '';
const norm = (s) => (blank(s) ? null : String(s).trim().toUpperCase().replace(/\s+/g, ''));
/** "BO — no impact test" (an option's old label) → BO. */
const impactKey = (s) => { const n = norm(s); return n == null ? null : n.split(/[—–-]/)[0] || null; };
export const impactRank = (s) => { const k = impactKey(s); return k == null ? null : (IMPACT_RANK.has(k) ? IMPACT_RANK.get(k) : null); };

export const ruleOf = (r) => (GRADE_RULES.includes(String(r ?? '').toLowerCase()) ? String(r).toLowerCase() : DEFAULT_GRADE_RULE);

/** "E350" → { family: 'E', strength: 350 } ("IS 2062 E350" too); null when it does not read that way. */
export function gradeParts(g) {
  const s = norm(g)?.replace(/^IS2062/, '').replace(/^IS:?2062/, '');
  const m = s ? /^([A-Z]+)(\d+)/.exec(s) : null;
  return m ? { family: m[1], strength: Number(m[2]) } : null;
}

/** The plate's grade against the piece's: 'same' | 'higher' | 'other' | 'unknown' (one side blank). */
export function gradeRelation(plateGrade, pieceGrade) {
  if (blank(plateGrade) || blank(pieceGrade)) return 'unknown';
  if (norm(plateGrade) === norm(pieceGrade)) return 'same';
  const a = gradeParts(plateGrade); const b = gradeParts(pieceGrade);
  if (a && b && a.family === b.family && a.strength > b.strength) return 'higher';
  return 'other';
}

/** The plate's impact class against the piece's: 'same' | 'better' | 'worse' | 'other' | 'none' (piece asks none) | 'unknown' (plate states none). */
export function impactRelation(plateImpact, pieceImpact) {
  const want = impactKey(pieceImpact);
  if (want == null) return 'none';
  const have = impactKey(plateImpact);
  if (have == null) return 'unknown';
  if (have === want) return 'same';
  const a = impactRank(have); const b = impactRank(want);
  if (a == null || b == null) return 'other';
  if (a === b) return 'same';                         // BO and B0
  return a > b ? 'better' : 'worse';
}

const words = (g, i) => [g, i].filter((x) => !blank(x)).join(' ') || 'no stated grade';

/**
 * Does the plate hold the piece? plate / piece: { grade, impactClass }.
 * → { ok, sure, code: null | 'GRADE' | 'IMPACT' | 'IMPACT_UNKNOWN', substitute: null | 'grade' | 'impact', why }
 */
export function fits(plate, piece, rule = DEFAULT_GRADE_RULE) {
  const R0 = ruleOf(rule);
  const R = R0 === 'warn' ? 'better' : R0;             // 'warn' checks as 'better'; it only does not refuse
  const g = gradeRelation(plate?.grade, piece?.grade);
  if (g === 'other' || (g === 'higher' && R !== 'higher')) {
    return { ok: false, sure: true, code: 'GRADE', substitute: null, why: `the plate is ${words(plate?.grade)} and the piece needs ${words(piece?.grade)}${g === 'higher' ? ' (a higher grade stands in only when Setup › Cutting allows it)' : ''}` };
  }
  const i = impactRelation(plate?.impactClass, piece?.impactClass);
  if (i === 'worse' || i === 'other' || (i === 'better' && R === 'exact')) {
    return {
      ok: false, sure: true, code: 'IMPACT', substitute: null,
      why: i === 'better'
        ? `the plate is ${impactKey(plate.impactClass)} and the piece needs exactly ${impactKey(piece.impactClass)} (Setup › Cutting: exact impact class)`
        : `the plate is ${impactKey(plate.impactClass)} and the piece needs ${impactKey(piece.impactClass)}${i === 'worse' && R !== 'exact' ? ' or better' : ''}`,
    };
  }
  if (i === 'unknown') return { ok: true, sure: false, code: 'IMPACT_UNKNOWN', substitute: g === 'higher' ? 'grade' : null, why: `the piece needs ${impactKey(piece.impactClass)} and the plate does not state an impact class` };
  return { ok: true, sure: true, code: null, substitute: g === 'higher' ? 'grade' : i === 'better' ? 'impact' : null, why: null };
}

/** The piece's requirement in words: "E350 BR". */
export const needWords = (s) => words(s?.grade, impactKey(s?.impactClass));

/**
 * Of a set of plates, those that hold EVERY one of these pieces: the ones that surely do, else (none of them
 * surely does) those that might — then `sure: false`. Plates are { id, steel: { grade, impactClass } }; pieces
 * are steels { grade, impactClass }. → { plates, sure }
 */
export function platesForAll(plates, steels, rule = DEFAULT_GRADE_RULE) {
  const verdicts = plates.map((p) => steels.map((s) => fits(p.steel, s, rule)));
  const sure = plates.filter((_, i) => verdicts[i].every((v) => v.ok && v.sure));
  if (sure.length) return { plates: sure, sure: true };
  return { plates: plates.filter((_, i) => verdicts[i].every((v) => v.ok)), sure: false };
}

/**
 * The check of one saved / proposed nesting: every piece against its plate.
 *   lots   [{ lotNo, plateCode, plate: { grade, impactClass }, pieces: [{ cutPlateId, code, steel: { grade, impactClass } }] }]
 * → { ok, mismatches: [{ lotNo, plateCode, plate, cutPlateId, code, need, pieces, why, code }], unknown: [...same], substitutes: [...same],
 *     sentence }   one entry per (plate, cut piece), its count in `pieces`.
 */
export function gradeCheck(lots, rule = DEFAULT_GRADE_RULE) {
  const bad = new Map(); const unknown = new Map(); const subs = new Map();
  for (const l of lots ?? []) {
    for (const p of l.pieces ?? []) {
      const v = fits(l.plate, p.steel, rule);
      const bucket = !v.ok ? bad : !v.sure ? unknown : v.substitute ? subs : null;
      if (!bucket) continue;
      const key = `${l.lotNo}|${p.cutPlateId}`;
      const had = bucket.get(key);
      if (had) { had.pieces += 1; continue; }
      bucket.set(key, {
        lotNo: l.lotNo ?? null, plateCode: l.plateCode ?? null, plate: words(l.plate?.grade, impactKey(l.plate?.impactClass)),
        cutPlateId: p.cutPlateId ?? null, cutPlateCode: p.code ?? null, need: needWords(p.steel), pieces: 1, code: v.code, substitute: v.substitute ?? null, why: v.why,
      });
    }
  }
  const mismatches = [...bad.values()]; const notKnown = [...unknown.values()]; const substitutes = [...subs.values()];
  return { ok: !mismatches.length, rule: ruleOf(rule), blocking: blocks(rule), mismatches, unknown: notKnown, substitutes, sentence: checkSentence(mismatches, notKnown, substitutes) };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const listOf = (xs, max = 6) => (xs.length <= max ? xs : [...xs.slice(0, max), `${xs.length - max} more`]);
const join = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join('; ')} and ${xs[xs.length - 1]}`);

/** One sentence a person can act on. */
export function checkSentence(mismatches, unknown = [], substitutes = []) {
  if (mismatches.length) {
    const lines = mismatches.map((m) => `${m.cutPlateCode ?? `piece ${m.cutPlateId}`} (${m.need}, ${plural(m.pieces, 'piece', 'pieces')}) on ${m.lotNo ? `plate ${m.lotNo}, ` : ''}${m.plateCode ?? 'a plate'} (${m.plate})`);
    return `Grade / impact class do not match: ${join(listOf(lines))}. Nest these pieces on a plate of their grade and impact class (${IMPACT_ORDER_WORDS}).`;
  }
  if (unknown.length) {
    const plates = [...new Set(unknown.map((u) => u.plateCode ?? u.lotNo))];
    return `${plural(unknown.reduce((a, u) => a + u.pieces, 0), 'piece asks', 'pieces ask')} for an impact class (${[...new Set(unknown.map((u) => u.need))].join(', ')}) and ${plates.length === 1 ? `${plates[0]} does` : `${plates.length} plates (${listOf(plates, 4).join(', ')}) do`} not state one — check the mill certificate.`;
  }
  if (substitutes.length) return `Every piece is on a plate of its grade and impact class or better (${plural(substitutes.reduce((a, u) => a + u.pieces, 0), 'piece', 'pieces')} on a better plate).`;
  return 'Every piece is on a plate of its grade and impact class.';
}
