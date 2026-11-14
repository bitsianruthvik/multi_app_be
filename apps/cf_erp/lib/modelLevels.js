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
const cache = new Map();   // file id → { levels, pieces } upper-case marks
const CACHE_MAX = 24;

/** PURE. The marks of the model's pieces (elements), upper case: a part or a bought section the screens can draw alone. */
export function piecesOfModel(model) {
  const out = new Set();
  for (const e of model?.elements ?? []) if (e.mark != null && e.mark !== '') out.add(up(e.mark));
  return out;
}

const EMPTY = { levels: new Set(), pieces: new Set() };
/** { levels, pieces } (upper-case marks) of a standard's ONE model; empty when it has none. Two small queries when cached. */
async function marksOfStandard(db, companyId, standardId) {
  if (!standardId) return EMPTY;
  const [[f]] = await db.query(
    "SELECT id FROM cf_standard_drawing_files WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
    [companyId, Number(standardId)],
  );
  if (!f) return EMPTY;
  const id = Number(f.id);
  if (cache.has(id)) return cache.get(id);
  const [[t]] = await db.query('SELECT file_text FROM cf_standard_drawing_files WHERE id = ?', [id]);
  let marks = EMPTY;
  try { const model = JSON.parse(t?.file_text ?? 'null'); marks = { levels: new Set(levelsOfModel(model).keys()), pieces: piecesOfModel(model) }; } catch { /* not a model: nothing drawn from it */ }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(id, marks);
  return marks;
}

/** The level marks of a standard's model (the standard's own viewer draws levels from it). */
export async function modelLevelsOfStandard(db, companyId, standardId) {
  return (await marksOfStandard(db, companyId, standardId)).levels;
}

/**
 * Every mark an order line's screens can draw from its standard's model: its levels, and its pieces (a bracing angle, a
 * bolt, a plate with no DXF), each drawn alone (user, 2026-11-07: "do it" — the 4 bracing angles had no drawing).
 */
export async function modelDrawsOfStandard(db, companyId, standardId) {
  const m = await marksOfStandard(db, companyId, standardId);
  return new Set([...m.levels, ...m.pieces]);
}

/** Does the model draw this row? Its mark is one of the model's levels. */
export const drawnByModel = (levels, mark) => !!mark && levels.has(up(mark));

/**
 * PURE. THE TOP ROW IS THE WHOLE MODEL (user, 2026-11-14: "one of the top two orders doesn't have diagram at the top line
 * level"): a line's top row may carry a mark its model does not use — the BOM's "RDSO" where the model's top level is
 * "SPAN" (SO260026, RDSO/B-17186). The top row is the whole structure all the same, so the model is handed over with
 * that mark added after its one top level in every element's `in`: every screen (2D levels, 3D, progress) then finds it.
 * The model as it was when the mark is already a level, or the model has no single top level.
 */
export function withTopAlias(model, topMark) {
  if (!model?.elements?.length || topMark == null || String(topMark).trim() === '') return model;
  if (levelsOfModel(model).has(up(topMark))) return model;
  const { tops } = levelParents(model);
  if (tops.size !== 1) return model;
  const top = [...tops.keys()][0];
  const alias = String(topMark);
  return {
    ...model,
    elements: model.elements.map((e) => {
      const chain = e.in ?? [];
      return chain.length && up(chain.at(-1)) === top ? { ...e, in: [...chain, alias] } : e;
    }),
  };
}
