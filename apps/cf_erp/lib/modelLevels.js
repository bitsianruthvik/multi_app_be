/**
 * modelLevels.js — WHICH ROWS THE ONE JSON DRAWS (user, 2026-11-06: "the drawings are only available at parts level and not
 * at every other level … we just have one json").
 *
 * A structure has ONE model (`cf-erp-model3d/2`, kept once with its standard in cf_standard_drawing_files, kind 'model').
 * The screens draw any level from it (multi_app_fe lib/modelDrawing.ts levelDrawing): no file per level is made, stored or
 * copied. So a row whose drawing mark is a LEVEL of that model (a name in some element's `in`) has a drawing, file or no
 * file. This module says which marks those are; partDrawingService and standardDrawingService tell the screens.
 *
 * It also works out the mark a row with none should carry (levelMarkFor): the top row is the model's top level, any other
 * assembly row is the level directly above its children's marks — so a span or a girder line imported without a mark can
 * be given the one the model already uses.
 */

const up = (s) => String(s ?? '').trim().toUpperCase();

/** PURE. The model's level marks, upper case → the name as written. */
export function levelsOfModel(model) {
  const out = new Map();
  for (const e of model?.elements ?? []) for (const x of e.in ?? []) if (x != null && x !== '' && !out.has(up(x))) out.set(up(x), String(x));
  return out;
}

/**
 * PURE. The level above each level: child mark (upper) → parent marks (upper) seen above it, and the top levels (those
 * that are last in some element's `in`).
 */
export function levelParents(model) {
  const parents = new Map(); const tops = new Map();
  for (const e of model?.elements ?? []) {
    const chain = [e.mark, ...(e.in ?? [])].filter((x) => x != null && x !== '');
    for (let i = 0; i + 1 < chain.length; i++) {
      const k = up(chain[i]);
      if (!parents.has(k)) parents.set(k, new Map());
      parents.get(k).set(up(chain[i + 1]), String(chain[i + 1]));
    }
    const last = (e.in ?? []).at(-1);
    if (last != null && last !== '') tops.set(up(last), String(last));
  }
  return { parents, tops };
}

/**
 * PURE. The mark an assembly row with none should carry, from the model: the top row → the model's one top level; any other
 * row → the one level directly above all its children's marks. null when the model does not say it unambiguously.
 * row: { isTop, childMarks: [string] }.
 */
export function levelMarkFor(model, row, rel = levelParents(model)) {
  if (row.isTop) return rel.tops.size === 1 ? [...rel.tops.values()][0] : null;
  const marks = (row.childMarks ?? []).filter(Boolean);
  if (!marks.length) return null;
  let common = null;
  for (const m of marks) {
    const above = rel.parents.get(up(m));
    if (!above) return null;
    const names = new Map(above);
    if (common == null) common = names;
    else for (const k of [...common.keys()]) if (!names.has(k)) common.delete(k);
    if (!common.size) return null;
  }
  return common.size === 1 ? [...common.values()][0] : null;
}

// One parse per model file: a model is up to a few MB and the drawing tree is read on every production screen.
const cache = new Map();   // file id → Set of upper-case level marks
const CACHE_MAX = 24;

/** The level marks (upper case) of a standard's ONE model; an empty Set when it has none. Two small queries when cached. */
export async function modelLevelsOfStandard(db, companyId, standardId) {
  if (!standardId) return new Set();
  const [[f]] = await db.query(
    "SELECT id FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
    [companyId, Number(standardId)],
  );
  if (!f) return new Set();
  const id = Number(f.id);
  if (cache.has(id)) return cache.get(id);
  const [[t]] = await db.query('SELECT file_text FROM cf_standard_drawing_files WHERE id = ?', [id]);
  let levels = new Set();
  try { levels = new Set(levelsOfModel(JSON.parse(t?.file_text ?? 'null')).keys()); } catch { /* not a model: nothing drawn from it */ }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(id, levels);
  return levels;
}

/** Does the model draw this row? Its mark is one of the model's levels. */
export const drawnByModel = (levels, mark) => !!mark && levels.has(up(mark));
