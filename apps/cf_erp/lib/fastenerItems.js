/**
 * fastenerItems.js — the catalog's bought fasteners by their exact size (user, 2026-11-28: "You use only what's there even
 * when you know the dimension is different. Every time this happens, you need to create the new item and add it to the
 * selector definition and then select that one in the SO BOM."). PURE: names in the catalog's own pattern, sizes read
 * back from a name, unit weights, and a bolt's length from its grip. Never a nearest size.
 *
 *   bolt set  "HSFG bolt set M22 x 130, class 8.8 (bolt + nut + 2 washers)"   (non-HSFG: "Bolt set M10 x 55, class 8.8 (…)")
 *   stud      "Shear stud 25 dia x 175"
 */

/** IS 6623 HSFG nut height and IS 4218 coarse pitch by diameter (as drawing_bom/src/bolts.mjs), IS 6649 washer 4 mm. */
export const NUT = { 10: 8, 12: 10, 16: 16, 20: 20, 22: 22, 24: 24, 27: 27, 30: 30, 36: 36 };
export const PITCH = { 10: 1.5, 12: 1.75, 16: 2, 20: 2.5, 22: 2.5, 24: 3, 27: 3, 30: 3.5, 36: 4 };
export const WASHER = 4;

/** A catalog bolt set's name → { dia, length, grade, hsfg } | null. */
export function boltOfName(name) {
  const s = String(name ?? '');
  const m = /\bM(\d{2})\s*x\s*(\d{2,3})\b/i.exec(s);
  if (!m || !/bolt set/i.test(s)) return null;
  return { dia: Number(m[1]), length: Number(m[2]), grade: /class\s*(\d{1,2}\.\d)/i.exec(s)?.[1] ?? null, hsfg: /\bHSFG\b/i.test(s) };
}

/** The bolt set's name in the catalog's pattern. */
export function boltSetName({ dia, length, grade, hsfg = true }) {
  return `${hsfg ? 'HSFG bolt set' : 'Bolt set'} M${dia} x ${length}, class ${grade} (bolt + nut + 2 washers)`;
}

/** A shear stud's name → { dia, height } | null ("Shear stud 25 dia x 175"; the package's "stud 25 dia x 100" too). */
export function studOfName(name) {
  const m = /(\d{2})\s*(?:dia|ø|Ø|mm dia)\s*[x×]\s*(\d{2,3})/i.exec(String(name ?? ''));
  return m ? { dia: Number(m[1]), height: Number(m[2]) } : null;
}
export const studName = ({ dia, height }) => `Shear stud ${dia} dia x ${height}`;

const r3 = (x) => Math.round(x * 1000) / 1000;
const STEEL = 7850e-9; // kg/mm³

/**
 * A bolt set's unit weight: shank (π/4·d²·L) + head + nut + 2 hardened washers (IS 3757 / 6623 / 6649 typical) — the
 * same figures scripts/cf_kepl/bolt-weights.mjs gave the catalog's sets (M22 x 95 → 0.543 kg).
 */
const FIXED = { 10: 0.03, 12: 0.05, 16: 0.12, 20: 0.2, 22: 0.26, 24: 0.33, 27: 0.45, 30: 0.6 };
export const boltSetKg = (d, L) => r3((Math.PI / 4) * d * d * L * STEEL + (FIXED[d] ?? 0.0006 * d * d));

/**
 * A headed shear stud's unit weight: head (ISO 13918 SD: head dia × head height) + shank to the stud's height. The
 * height is over the head (the size a drawing gives, "100 mm height shear studs").
 */
const STUD_HEAD = { 10: [19, 7], 13: [25, 8], 16: [32, 8], 19: [32, 10], 20: [35, 10], 22: [35, 10], 25: [40, 12] };
export function studKg(d, h) {
  const [hd, hk] = STUD_HEAD[d] ?? [1.6 * d, 0.5 * d];
  return r3((Math.PI / 4) * (hd * hd * hk + d * d * Math.max(0, h - hk)) * STEEL);
}

/**
 * A bolt's length from its grip: plies + 2 washers + nut + 3 threads past the nut, rounded UP to the catalog's length
 * series for that diameter (5 mm unless every catalog length of that diameter is a multiple of 10). `catalogLengths` are
 * the lengths the catalog holds for this diameter (any class).
 */
export function boltLengthFromGrip(dia, grip, catalogLengths = []) {
  if (!NUT[dia] || !(grip > 0)) return null;
  const need = grip + 2 * WASHER + NUT[dia] + 3 * PITCH[dia];
  const step = catalogLengths.length && catalogLengths.every((l) => l % 10 === 0) ? 10 : 5;
  return Math.ceil(need / step - 1e-9) * step;
}

/**
 * The catalog bolt of EXACTLY this size and class, or what to make. `bolts` [{ id, code, name }].
 *   → { match } | { make: { kind: 'bolt', name, dia, length, grade, hsfg, weightKg } } | { open: reason }
 * With no class given, a size held in ONE class only is that size; held in several, it is left open (never guessed).
 */
export function exactBolt(want, bolts = [], { hsfg = true } = {}) {
  if (!want?.dia || !want?.length) return { open: 'diameter or length not given' };
  const same = bolts.filter((b) => { const o = boltOfName(b.name); return o && o.dia === want.dia && o.length === want.length && o.hsfg === hsfg; });
  if (want.grade) {
    const hit = same.find((b) => boltOfName(b.name).grade === want.grade);
    if (hit) return { match: hit };
    return { make: { kind: 'bolt', name: boltSetName({ dia: want.dia, length: want.length, grade: want.grade, hsfg }), dia: want.dia, length: want.length, grade: want.grade, hsfg, weightKg: boltSetKg(want.dia, want.length) } };
  }
  const grades = [...new Set(same.map((b) => boltOfName(b.name).grade))];
  if (same.length && grades.length === 1) return { match: same[0] };
  return { open: grades.length > 1 ? `class not given; the catalog holds M${want.dia} x ${want.length} in classes ${grades.join(' and ')}` : 'class not given, and no catalog bolt of this size' };
}

/** The catalog stud of EXACTLY this diameter and height, or what to make. `studs` [{ id, code, name }]. */
export function exactStud(want, studs = []) {
  if (!want?.dia || !want?.height) return { open: 'stud size not given' };
  const hit = studs.find((s) => { const o = /^shear stud/i.test(String(s.name)) ? studOfName(s.name) : null; return o && o.dia === want.dia && o.height === want.height; });
  if (hit) return { match: hit };
  return { make: { kind: 'stud', name: studName(want), dia: want.dia, height: want.height, weightKg: studKg(want.dia, want.height) } };
}
