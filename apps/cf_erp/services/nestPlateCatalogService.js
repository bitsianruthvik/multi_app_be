/**
 * nestPlateCatalogService.js — CF_ERP. Plates an uploaded nesting is cut on that the catalog does
 * not have (user, 2026-10-14: "Sometimes the plate sizes are not there in RM. So give an option to
 * create all of them (by default as custom sizes).").
 *
 *   the upload preview    missingPlatesOf   which plates are missing, once each, and what each would be called
 *   POST /orders/:o/lines/:l/nesting/plates   createNestPlates   { plates: [{ key | size…, kind, code?, name? }], dryRun? }
 *
 * A NEW PLATE IS MODELLED ON ONE THE CATALOG HAS (`similarTo`): a plate of the same thickness when
 * there is one, else of the nearest thickness, the same grade and impact class preferred. From it
 * come the classification (so the new plate is filed with the plates), the short name, the unit,
 * tracking, sourcing, HSN / GST and a price that is a RATE (per kg, per tonne) — a price for one
 * plate is not copied, the new plate is another size. Nothing is copied from its VALUES: those are
 * worked out for the new plate by the same rules an item made in Items gets (resolutionService):
 *
 *   entered      THICKNESS, LENGTH (the long side), WIDTH, GRADE, IMPACT_CLASS — and PLATE_KIND
 *                when it is not what the rule defaults to, MATERIAL / DENSITY where they are typed
 *   fixed, defaulted, calculated   as the classification's rules say — MATERIAL, DENSITY, NESTING,
 *                and WEIGHT by its own formula, on the new plate's size
 *
 * ITS CODE is the tenant's coding rule's (the code generator, on the values above); ITS NAME a
 * naming rule's when one applies, else the model plate's name with the model's size, grade and
 * impact class changed for the new ones ("MS Plate 40 x 2150 x 12050 E350 BO" →
 * "MS Plate 10 x 2000 x 6000 E350 BO").
 *
 * SET-BASED (production is ~49 ms a round trip). Everything is READ ONCE whatever the number of
 * plates — the stock places, the catalog plates, the model plates, the classification's rules,
 * values and options, the coding rules (`readOnce`: the same read asked again costs nothing) — and
 * WRITTEN IN BULK: the records, their ids read back by code, the item details, the values, their
 * ids read back, the history. The count grows only with the number of DIFFERENT classifications the
 * model plates sit in (one in every catalog so far), and a coding rule with a running number draws
 * it per plate, as it must.
 */
import { invalid } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { cutPlaces } from '../lib/cutPlaces.js';
import { generate } from '../modules/codegen/index.js';
import { loadMasters } from './records.js';
import { ancestors } from './tree.js';
import { resolve, effectiveByCode } from './resolutionService.js';
import { PLACED } from './codeRangeService.js';
import { candidatePlates, requireLine, PLATE_KIND_SPEC_CODE } from './nestingService.js';

/** One request may ask for at most this many plates. */
export const MAX_NEW_PLATES = 200;
const SIZE_TOL = 0.5;
const THICKNESS_TOL = 0.01;
const KINDS = ['custom', 'standard'];

const blank = (v) => v == null || String(v).trim() === '';
const norm = (s) => (blank(s) ? null : String(s).trim().toUpperCase());
const squash = (s) => String(s ?? '').toUpperCase().replace(/[\s\-_]+/g, '');
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const fmt = (n) => (n == null || !Number.isFinite(Number(n)) ? '?' : String(r3(n)));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const sameSize = (a, b) => Math.abs(Number(a) - Number(b)) <= SIZE_TOL;
const eitherWay = (l, w, L, W) => (sameSize(l, L) && sameSize(w, W)) || (sameSize(l, W) && sameSize(w, L));
const positive = (v) => (blank(v) || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : r3(v));

/**
 * What names a missing plate: thickness | length | width | grade | impact class, the long side
 * first, blank where it is not known — "10|6000|2000|E350|BO". The preview hands it out and the
 * create route reads it back, so the screen need not send the five values again.
 */
export function plateKey(p) {
  const long = Math.max(Number(p.length) || 0, Number(p.width) || 0); const short = Math.min(Number(p.length) || 0, Number(p.width) || 0);
  return [p.thickness == null ? '' : fmt(p.thickness), fmt(long), fmt(short), norm(p.grade) ?? '', norm(p.impactClass) ?? ''].join('|');
}
function readKey(key) {
  const parts = String(key ?? '').split('|');
  if (parts.length !== 5) return null;
  const [t, l, w, g, i] = parts.map((x) => x.trim());
  return { thickness: t === '' ? null : t, length: l, width: w, grade: g === '' ? null : g, impactClass: i === '' ? null : i };
}
/** "10 mm × 6000 × 2000 E350 BO" — how a plate is said in a sentence. */
export const plateWords = (p) => `${p.thickness == null ? '' : `${fmt(p.thickness)} mm × `}${fmt(Math.max(p.length, p.width))} × ${fmt(Math.min(p.length, p.width))}${p.grade ? ` ${p.grade}` : ''}${p.impactClass ? ` ${p.impactClass}` : ''}`;

/**
 * The same read asked twice is answered once: the plan below resolves every new plate through the
 * services an item made by hand goes through, and those ask the same things for each. Only plain
 * SELECTs are remembered (never one FOR UPDATE — a running number is drawn for real), and only
 * while nothing is written: the caller plans first and writes afterwards, on the real connection.
 */
function readOnce(db) {
  const seen = new Map();
  const query = (sql, params) => {
    if (typeof sql !== 'string' || !/^\s*(?:SELECT|WITH)\b/i.test(sql) || /\bFOR\s+UPDATE\b/i.test(sql)) return db.query(sql, params);
    const key = `${sql}\u0000${JSON.stringify(params ?? [])}`;
    if (!seen.has(key)) seen.set(key, db.query(sql, params));
    return seen.get(key);
  };
  return new Proxy(db, { get: (target, prop) => (prop === 'query' ? query : Reflect.get(target, prop)) });
}

/** The catalog plate that already IS this one: the same thickness, size (either way round), grade and impact class. */
function existingPlate(plates, p) {
  return plates.find((x) => x.steel?.thickness > 0 && x.steel?.length > 0 && x.steel?.width > 0
    && Math.abs(x.steel.thickness - p.thickness) <= THICKNESS_TOL && eitherWay(x.steel.length, x.steel.width, p.length, p.width)
    && norm(x.steel.grade) === norm(p.grade) && norm(x.steel.impactClass) === norm(p.impactClass)) ?? null;
}

/**
 * The catalog plate a new one is modelled on: the same thickness when the catalog has it, else the
 * nearest; among those the same grade AND impact class, then the same grade; then the nearest size;
 * then the oldest (a fixed answer for the same catalog).
 */
function modelFor(plates, p) {
  const usable = plates.filter((x) => x.steel?.thickness > 0 && x.steel?.length > 0 && x.steel?.width > 0);
  if (!usable.length) return null;
  const score = (x) => [
    p.thickness == null ? 0 : Math.abs(x.steel.thickness - p.thickness),
    norm(x.steel.grade) === norm(p.grade) && norm(x.steel.impactClass) === norm(p.impactClass) ? 0 : norm(x.steel.grade) === norm(p.grade) ? 1 : 2,
    Math.abs(Math.max(x.steel.length, x.steel.width) - Math.max(p.length, p.width)) + Math.abs(Math.min(x.steel.length, x.steel.width) - Math.min(p.length, p.width)),
    x.id,
  ];
  return usable.map((x) => ({ x, s: score(x) })).sort((a, b) => a.s[0] - b.s[0] || a.s[1] - b.s[1] || a.s[2] - b.s[2] || a.s[3] - b.s[3])[0].x;
}

/**
 * The model plate's name with its own size, grade and impact class changed for the new plate's —
 * word by word, so "MS Plate 12 x 2500 x 12000 E350 BO" keeps its words and its order. A name that
 * does not say all three sizes cannot be followed: the new plate is then named plainly.
 */
function nameLike(model, p) {
  const m = model.steel;
  const plain = `${p.material ? `${p.material} ` : ''}Plate ${fmt(p.thickness)} x ${fmt(p.width)} x ${fmt(p.length)}${p.grade ? ` ${p.grade}` : ''}${p.impactClass ? ` ${p.impactClass}` : ''}`;
  if (blank(model.name)) return plain;
  // The model's sizes, in the order thickness, width, length: a number of the name is taken as the first of them it equals.
  const left = [['thickness', m.thickness], ['width', m.width], ['length', m.length]];
  let sizes = 0;
  const words = String(model.name).split(/(\s+)/).map((word) => {
    if (/^\s*$/.test(word)) return word;
    if (/^\d+(?:\.\d+)?$/.test(word)) {
      const i = left.findIndex(([, v]) => Math.abs(Number(word) - v) <= 0.0005);
      if (i < 0) return word;
      const [role] = left.splice(i, 1)[0];
      sizes += 1;
      return fmt(p[role]);
    }
    if (m.grade && norm(word) === norm(m.grade)) return p.grade ?? '';
    if (m.impactClass && norm(word) === norm(m.impactClass)) return p.impactClass ?? '';
    return word;
  });
  return sizes === 3 ? words.join('').replace(/\s+/g, ' ').trim() : plain;
}

/** A specification's option that a text names: exactly, else ignoring spaces and dashes, else (a grade) as a file writes it. */
function optionFor(options, text, alike = null) {
  if (blank(text) || !options?.length) return null;
  const exact = options.find((o) => norm(o.value) === norm(text)) ?? options.find((o) => squash(o.value) === squash(text));
  if (exact) return exact;
  const near = alike ? options.filter((o) => alike(o.value, text)) : [];
  return near.length === 1 ? near[0] : null;
}

const EMPTY = { value_number: null, value_text: null, value_bool: null, value_date: null, option_id: null, value_json: null };
const typedOf = (row) => ({
  value_number: row.value_number == null ? null : Number(row.value_number), value_text: row.value_text ?? null,
  value_bool: row.value_bool == null ? null : Number(row.value_bool), value_date: row.value_date ?? null,
  option_id: row.option_id ?? null, value_json: row.value_json == null ? null : (typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json),
});

/**
 * The value rows a NEW item is stored with, from its resolution as a draft — what creating it in
 * Items would leave behind (valueService: the entered values, then storeDerived). A typed value is
 * 'entered'; a rule's own answer is stored under the rule's name.
 */
function valueRows(r, draft) {
  const rows = [];
  for (const s of r.specs) {
    if (!s.applicable || s.captureAt !== 'item' || !s.value) continue;
    const own = draft.get(s.spec.id) ?? null;
    const rule = s.rule.valueRule;
    const stored = r.internal.effectiveRows.get(s.spec.id) ?? null;
    let typed = null; let source = null;
    if (own && (rule === 'entered' || rule === 'defaulted')) { typed = typedOf(own); source = 'entered'; }
    else if (rule === 'fixed' && stored) { typed = typedOf(stored); source = 'fixed'; }
    else if (rule === 'defaulted' && stored) { typed = typedOf(stored); source = s.derived ? (s.derived.rollup ? 'rollup' : 'calculated') : 'defaulted'; }
    else if (rule === 'calculated' && s.status === 'calculated') { typed = { ...EMPTY, value_number: s.value.raw }; source = 'calculated'; }
    if (typed) rows.push({ specId: s.spec.id, code: s.spec.code, uom: s.spec.unit ?? null, typed, source });
  }
  return rows;
}

const TOKEN_WORDS = { 'spec:GRADE': 'grade', 'spec:IMPACT_CLASS': 'impact class', 'spec:THICKNESS': 'thickness', 'spec:MATERIAL': 'material' };
const notKnown = (what) => `its ${what} is not known — match its parts first, or name the plate`;

/**
 * Works out, for every plate asked for, whether the catalog already has it, the plate it is
 * modelled on, its values, its code and its name — and why not, in words, when it cannot be made.
 * Writes nothing (a coding rule's running number is only looked at).
 *
 *   wanted   [{ thickness, length, width, grade, impactClass, material?, density?, kind?, code?, name? }]
 *   opts     plates     the catalog plates when the caller has them (the upload's ctx.plates)
 *            alikeGrade (a, b) → a grade as a file writes it against the catalog's (the upload's sameGrade)
 *
 * → [{ key, thickness, length, width, grade, impactClass, material, density, kind,
 *      existing: plate | null, model: master | null, similarTo, code, name, suggestedCode, suggestedName,
 *      rows, problems: [sentence], cannot: sentence | null, draftOf() }]
 */
export async function planPlates(db, companyId, wanted, { plates = null, alikeGrade = null } = {}) {
  // The upload already read the plates of the stock places (it refuses a company with none): they are not read again.
  const places = plates ? null : (await cutPlaces(db, companyId)).plate;
  const noPlace = places && !places.stockNodeIds.length ? 'no raw plate stock is set, so nothing says where a new plate is filed — choose it in Setup › Cutting' : null;
  const catalog = noPlace ? [] : plates ?? await candidatePlates(db, companyId, [...places.stockIds]);
  const once = readOnce(db);

  const plans = wanted.map((w) => {
    const problems = [];
    const size = (v, what) => { const n = positive(v); if (n == null) problems.push(`its ${what} is "${blank(v) ? '' : v}", and has to be a number above 0`); return n; };
    const thickness = w.thickness == null ? null : size(w.thickness, 'thickness');
    const a = size(w.length, 'length'); const b = size(w.width, 'width');
    const kind = blank(w.kind) ? 'custom' : String(w.kind).trim().toLowerCase();
    if (!KINDS.includes(kind)) problems.push(`its kind is "${w.kind}" — a plate is custom or standard`);
    return {
      thickness, length: a != null && b != null ? Math.max(a, b) : a, width: a != null && b != null ? Math.min(a, b) : b,
      grade: blank(w.grade) ? null : String(w.grade).trim(), impactClass: blank(w.impactClass) ? null : String(w.impactClass).trim(),
      material: blank(w.material) ? null : String(w.material).trim(), density: positive(w.density),
      kind: KINDS.includes(kind) ? kind : 'custom', askedCode: blank(w.code) ? null : String(w.code).trim(), askedName: blank(w.name) ? null : String(w.name).trim(),
      problems, cannot: null, existing: null, model: null, similarTo: null, code: null, name: null, suggestedCode: null, suggestedName: null, rows: [], input: w,
    };
  });
  const sized = (p) => p.length != null && p.width != null && !p.problems.length;
  for (const p of plans) {
    if (!sized(p)) continue;
    if (noPlace) { p.cannot = noPlace; continue; }
    if (p.thickness != null) p.existing = existingPlate(catalog, p);
    if (!p.existing) p.modelPlate = modelFor(catalog, p);
    if (!p.existing && !p.modelPlate) p.cannot = 'the catalog has no plate yet to model a new one on — add the first plate in Items, and the next can be added from here';
  }

  // The model plates as records, in one read: their classification, short name, unit, tracking, sourcing, tax and price.
  const models = await loadMasters(db, companyId, plans.filter((p) => p.modelPlate).map((p) => p.modelPlate.id));
  const drafts = new Map();                         // classification → what a draft plate there resolves to with nothing entered
  for (const p of plans) {
    if (!p.modelPlate) continue;
    p.model = models.get(p.modelPlate.id) ?? null;
    if (!p.model) { p.cannot = `${p.modelPlate.code ?? 'the plate it would be modelled on'} is no longer in the catalog — read the files again`; continue; }
    p.similarTo = { itemId: p.model.id, code: p.model.code ?? null };
    const cls = p.model.classification_id;
    const master = { id: null, record_kind: 'item', item_type: 'catalog', code: null, name: null, short_name: p.model.short_name ?? null, classification_id: cls, tracked_by: p.model.tracked_by ?? 'quantity', source_definition_id: null, owner_order_line_id: null };
    if (!drafts.has(cls)) {
      const bare = await resolve(once, companyId, { master, draftValues: new Map() });
      drafts.set(cls, { bare, byCode: new Map(bare.specs.filter((s) => s.captureAt === 'item' && s.applicable).map((s) => [String(s.spec.code).toUpperCase(), s])), chain: await ancestors(once, companyId, cls) });
    }
    const { byCode, chain } = drafts.get(cls);

    // ---- the values typed on the new plate ---------------------------------
    const draft = new Map();
    const typable = (s) => s && ['entered', 'defaulted'].includes(s.rule.valueRule);
    const number = (code, v, must = true) => {
      const s = byCode.get(code);
      if (!typable(s)) { if (must) p.problems.push(`${code} is not a value a plate is given in this catalog (Setup › Specifications), so the new plate could not say its size`); return; }
      draft.set(s.spec.id, { ...EMPTY, value_number: v, source: 'entered' });
    };
    const option = (code, text, what, { must = false, alike = null } = {}) => {
      const s = byCode.get(code);
      if (blank(text)) return null;
      if (!typable(s)) { if (must) p.problems.push(`${code} is not a value a plate is given in this catalog (Setup › Specifications)`); return null; }
      const o = optionFor(s.options, text, alike);
      if (!o) { p.problems.push(`its ${what} is "${text}", which is not one of the ${code} options (${s.options?.length ? list(s.options.slice(0, 12).map((x) => x.value)) : 'there are none'}) — add it in Setup › Specifications, or correct the plate`); return null; }
      draft.set(s.spec.id, { ...EMPTY, option_id: o.id, source: 'entered' });
      return o.value;
    };
    if (p.thickness != null) number('THICKNESS', p.thickness);
    number('LENGTH', p.length); number('WIDTH', p.width);
    p.grade = option('GRADE', p.grade, 'grade', { must: true, alike: alikeGrade }) ?? p.grade;
    p.impactClass = option('IMPACT_CLASS', p.impactClass, 'impact class', { must: true }) ?? p.impactClass;
    // The kind: typed only when it is not what the rule already defaults to (a plate made in Items is stored the same way).
    const kindSpec = byCode.get(PLATE_KIND_SPEC_CODE);
    const kindNow = norm(kindSpec?.value?.optionValue ?? kindSpec?.value?.raw);
    if (kindNow !== p.kind.toUpperCase()) {
      if (!typable(kindSpec)) { if (p.kind === 'standard') p.problems.push('plates in this catalog do not say whether they are standard or custom (no PLATE_KIND value on them), so one cannot be made standard here'); }
      else option(PLATE_KIND_SPEC_CODE, p.kind, 'kind');
    }
    // Material and density: the classification usually fixes them; where they are typed, the cut pieces' — else the model plate's.
    const mat = byCode.get('MATERIAL');
    if (typable(mat) && !mat.value) { const o = optionFor(mat.options, p.material ?? p.modelPlate.steel.material); if (o) draft.set(mat.spec.id, { ...EMPTY, option_id: o.id, source: 'entered' }); }
    const den = byCode.get('DENSITY');
    if (typable(den) && !den.value && (p.density ?? p.modelPlate.steel.density) > 0) draft.set(den.spec.id, { ...EMPTY, value_number: p.density ?? p.modelPlate.steel.density, source: 'entered' });

    if (p.thickness == null) p.cannot = notKnown('thickness');
    else if (p.grade == null) p.cannot = notKnown('grade');
    if (p.problems.length || p.cannot) continue;

    // ---- every value the rules give it, the weight among them ----------------
    const r = await resolve(once, companyId, { master, draftValues: draft });
    for (const s of r.missingRequired) {
      if (['IMPACT_CLASS', 'GRADE', 'MATERIAL'].includes(s.code)) p.cannot ??= notKnown(String(s.name ?? s.code).toLowerCase());
      else p.problems.push(`${s.code} (${s.name}) is required on a plate and nothing gives it a value`);
    }
    p.problems.push(...r.problems);
    if (p.problems.length || p.cannot) continue;
    const specs = effectiveByCode(r);
    p.material = specs.get('MATERIAL')?.optionValue ?? specs.get('MATERIAL')?.raw ?? p.material ?? null;
    p.density = specs.get('DENSITY')?.raw ?? p.density ?? null;
    p.weightKg = specs.get('WEIGHT')?.raw ?? null;
    p.rows = valueRows(r, draft);

    // ---- its name, then its code — in the order an item made by hand gets them ----
    const data = { master, def: null, chain, specs, owner: null, place: null, range: null };
    p.draftOf = () => ({ draft: { [PLACED]: data } });
    const named = await generate(once, companyId, 'item', 'name', p.draftOf(), { consume: false });
    p.suggestedName = named?.text ?? nameLike(p.modelPlate, p);
    p.name = p.askedName ?? p.suggestedName;
    master.name = p.name;
    const coded = await generate(once, companyId, 'item', 'code', p.draftOf(), { consume: false });
    p.codeRule = coded ? { missing: coded.missing ?? [], numbered: coded.number != null } : null;
    p.suggestedCode = coded?.text ?? null;
    p.code = p.askedCode ?? p.suggestedCode;
    if (coded && !coded.text && !p.askedCode) {
      const what = (coded.missing ?? []).map((k) => TOKEN_WORDS[k] ?? k.replace(/^spec:/, '').toLowerCase().replace(/_/g, ' '));
      p.cannot = what.length ? notKnown(list(what)) : 'its coding rule gives no code';
    }
    if (p.name.length > 255) p.problems.push('its name is longer than 255 characters');
    if (p.code && p.code.length > 100) p.problems.push('its code is longer than 100 characters');
  }

  for (const p of plans) p.key = plateKey(p);
  // ---- a code somebody already has (one read for all of them) ----------------
  const live = plans.filter((p) => !p.existing && !p.cannot && !p.problems.length && p.code);
  if (live.length) {
    const [taken] = await db.query(
      'SELECT id, code, name, status FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)',
      [companyId, [...new Set(live.map((p) => p.code))]],
    );
    const owner = new Map(taken.map((t) => [norm(t.code), t]));
    const mine = new Map();
    for (const p of live) {
      const t = owner.get(norm(p.code));
      if (t) p.problems.push(`the code ${p.code} is already taken, by ${t.name}${t.status === 'active' ? '' : ` (${t.status})`} — ${p.askedCode ? 'give it another code' : 'that item is not an active plate filed with the plates, so it is not found by size; make it one in Items, or give this plate another code'}`);
      else if (mine.get(norm(p.code))?.key === p.key) continue;        // the same plate named twice: the caller adds it once
      else if (mine.has(norm(p.code))) p.problems.push(`the code ${p.code} is given to two plates of this request (${plateWords(mine.get(norm(p.code)))} too) — give one of them another code`);
      else mine.set(norm(p.code), p);
    }
  }
  return plans;
}

/**
 * The plates an upload is cut on that the catalog does not have — one entry per distinct thickness
 * × length × width × grade × impact class — for the preview's `missingPlates`. `found` is what
 * resolvePlate could tell of each file / nest whose plate it did not find ([{ filename, nestNo,
 * thickness, length, width, grade, impactClass, material, density, mixed?, frame? }], one per
 * physical plate). No missing plate, no round trip.
 */
export async function missingPlatesOf(db, companyId, ctx, found, { alikeGrade = null } = {}) {
  if (!found.length) return [];
  const groups = new Map();
  for (const f of found) {
    const key = plateKey(f);
    if (!groups.has(key)) groups.set(key, { ...f, nests: [], plates: 0, notes: new Set() });
    const g = groups.get(key);
    g.plates += 1;
    if (!g.nests.some((n) => n.filename === f.filename && n.nestNo === f.nestNo)) g.nests.push({ filename: f.filename, ...(f.nestNo != null ? { nestNo: f.nestNo } : {}) });
    if (f.mixed) g.notes.add(f.mixed);
    if (f.frame) g.frame = true;
  }
  const asked = [...groups.values()];
  const plans = await planPlates(db, companyId, asked, { plates: ctx.plates, alikeGrade });
  const out = new Map();
  plans.forEach((p, i) => {
    const g = asked[i];
    // A plate the catalog has after all (the file wrote its grade another way) is not missing.
    if (p.existing) return;
    const why = g.frame ? 'the rectangle read as the plate may be a drawing frame round the real plate — name the plate (plateCode), or add this size in Items if it really is the plate'
      : p.cannot ?? (p.problems.length ? p.problems.join('; ') : null);
    const had = out.get(p.key);
    if (had) { had.plates += g.plates; for (const n of g.nests) if (!had.nests.some((x) => x.filename === n.filename && x.nestNo === n.nestNo)) had.nests.push(n); return; }
    out.set(p.key, {
      key: p.key, thickness: p.thickness, length: p.length, width: p.width, grade: p.grade, impactClass: p.impactClass,
      material: p.material ?? null, density: p.density ?? null,
      nests: g.nests, plates: g.plates,
      suggestedCode: p.suggestedCode, suggestedName: p.suggestedName, kind: 'custom', similarTo: p.similarTo,
      canCreate: !why, ...(why ? { why: `${why}.`.replace(/\.\.$/, '.') } : {}), ...(g.notes.size ? { note: [...g.notes].join(' ') } : {}),
    });
  });
  return [...out.values()];
}

/**
 * POST …/nesting/plates — adds plates to the catalog, all of them in a fixed number of round trips.
 *
 *   input.plates   [{ key | thickness, length, width, grade, impactClass, kind: 'custom' (default) | 'standard', code?, name? }]
 *   input.dryRun   say what would be created, write nothing
 *
 * → { dryRun, created: [{ key, itemId, code, name, kind }], skipped: [{ key, why, itemId?, code? }], message }
 *
 * IDEMPOTENT: a plate the catalog already has — the same thickness, size, grade and impact class —
 * is SKIPPED with that item named, never made twice; so is one named twice in the request.
 * ALL OR NOTHING for what is wrong: a size that is no number, a grade that is not an option, a code
 * already taken, no plate stock place, no plate to model on — every one said, and nothing written.
 */
export async function createNestPlates(db, c, lineId, input = {}) {
  await requireLine(db, c.companyId, lineId);
  const dryRun = input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1 || input.dryRun === '1';
  const asked = Array.isArray(input.plates) ? input.plates : [];
  if (!asked.length) throw invalid('NO_PLATES', 'Say which plates to add (plates).');
  if (asked.length > MAX_NEW_PLATES) throw invalid('TOO_MANY', `One request adds at most ${MAX_NEW_PLATES} plates, and this one names ${asked.length}.`);

  const unread = [];
  const wanted = asked.map((a, i) => {
    const row = a && typeof a === 'object' ? a : {};
    const fromKey = blank(row.key) ? null : readKey(row.key);
    if (!blank(row.key) && !fromKey) unread.push(`Plate ${i + 1}: "${row.key}" is not a plate this screen listed — read the files again.`);
    return { ...(fromKey ?? {}), ...Object.fromEntries(['thickness', 'length', 'width', 'grade', 'impactClass', 'material', 'density'].filter((k) => !blank(row[k])).map((k) => [k, row[k]])), kind: row.kind, code: row.code, name: row.name };
  });
  if (unread.length) throw invalid('PLATES_INVALID', 'Nothing was added to the catalog.', { problems: unread });

  const plans = await planPlates(db, c.companyId, wanted);
  const problems = [];
  const skipped = [];
  const make = [];
  const seen = new Set();
  for (const p of plans) {
    const words = p.length != null && p.width != null ? plateWords(p) : `Plate ${plans.indexOf(p) + 1}`;
    if (p.existing) { skipped.push({ key: p.key, itemId: p.existing.id, code: p.existing.code ?? null, why: `${words} is already in the catalog: ${p.existing.code ?? p.existing.name}.` }); continue; }
    if (p.cannot) { problems.push(`${words}: ${p.cannot}.`); continue; }
    if (p.problems.length) { problems.push(...p.problems.map((x) => `${words}: ${x}.`)); continue; }
    if (!p.code) { problems.push(`${words}: no coding rule gives a raw plate its code here — type a code for it (Choose…), or add a rule in Setup › Coding rules.`); continue; }
    if (seen.has(p.key)) { skipped.push({ key: p.key, why: `${words} is named twice in this request — it is added once.` }); continue; }
    seen.add(p.key);
    make.push(p);
  }
  if (problems.length) throw invalid('PLATES_INVALID', `Nothing was added to the catalog — ${plural(problems.length, 'thing needs', 'things need')} fixing first.`, { problems });

  const say = (created) => {
    // "Added A and B to the catalog as custom sizes, and C as a standard size."
    const groups = KINDS.map((kind) => ({ kind, codes: created.filter((x) => x.kind === kind).map((x) => x.code) })).filter((g) => g.codes.length);
    const as = (g) => (g.codes.length === 1 ? `a ${g.kind} size` : `${g.kind} sizes`);
    const added = groups.length ? `${dryRun ? 'Would add' : 'Added'} ${list(groups[0].codes)} to the catalog as ${as(groups[0])}${groups[1] ? `, and ${list(groups[1].codes)} as ${as(groups[1])}` : ''}.` : '';
    const not = skipped.length ? `${plural(skipped.length, 'plate was', 'plates were')} not added: ${skipped.map((s) => s.why).join(' ')}` : '';
    return [added, not].filter(Boolean).join(' ') || 'Nothing to add.';
  };
  if (dryRun || !make.length) {
    const created = dryRun ? make.map((p) => ({ key: p.key, itemId: null, code: p.code, name: p.name, kind: p.kind })) : [];
    return { dryRun, created, skipped, message: say(created) };
  }

  // ---- a code its rule numbers is drawn now, for real (one plate at a time: the number is the point) ----
  for (const p of make) {
    if (p.askedCode || !p.codeRule?.numbered) continue;
    p.code = (await generate(db, c.companyId, 'item', 'code', p.draftOf(), { consume: true })).text;
  }

  // ---- the writes, in bulk ---------------------------------------------------
  await insertRows(db, 'cf_master_records',
    ['company_id', 'record_kind', 'code', 'name', 'short_name', 'classification_id', 'status', 'created_by'],
    make.map((p) => [c.companyId, 'item', p.code, p.name, p.model.short_name ?? null, p.model.classification_id, 'active', c.userId ?? null]));
  // Ids are read back by the code just written (never counted on from insertId: TiDB does not hand them out in a row).
  const [fresh] = await db.query('SELECT id, code FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [c.companyId, make.map((p) => p.code)]);
  const idOf = new Map(fresh.map((x) => [norm(x.code), x.id]));
  for (const p of make) {
    p.id = idOf.get(norm(p.code));
    if (!p.id) throw new Error(`cf_erp: the plate ${p.code} vanished between its insert and the read-back.`);
  }
  const rate = (m) => (['kg', 'tonne'].includes(m.price_basis) ? m.list_price ?? null : null);
  await insertRows(db, 'cf_item_details',
    ['master_id', 'company_id', 'item_type', 'tracked_by', 'uom', 'sourcing', 'list_price', 'price_basis', 'currency', 'hsn_code', 'gst_rate', 'is_service'],
    make.map((p) => [p.id, c.companyId, 'catalog', p.model.tracked_by ?? 'quantity', p.model.uom ?? 'nos', p.model.sourcing ?? 'stock',
      rate(p.model), p.model.price_basis ?? 'unit', p.model.price_currency ?? 'INR', p.model.hsn_code ?? null, p.model.gst_rate ?? null, Number(p.model.is_service) ? 1 : 0]));
  const json = (v) => (v == null ? null : JSON.stringify(v));
  const values = make.flatMap((p) => p.rows.map((v) => ({ ...v, subjectId: p.id })));
  await insertRows(db, 'cf_spec_values',
    ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_number', 'value_text', 'value_bool', 'value_date', 'option_id', 'value_json', 'uom', 'source', 'created_by'],
    values.map((v) => [c.companyId, v.specId, 'master', v.subjectId, v.typed.value_number, v.typed.value_text, v.typed.value_bool, v.typed.value_date, v.typed.option_id, json(v.typed.value_json), v.uom, v.source, c.userId ?? null]));
  if (values.length) {
    const [stored] = await db.query(
      "SELECT id, specification_id, subject_id FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL",
      [c.companyId, make.map((p) => p.id)],
    );
    const valueId = new Map(stored.map((s) => [`${s.subject_id}:${s.specification_id}`, s.id]));
    // The history a value written by hand leaves: one 'create' row each, saying what it was set to.
    await insertRows(db, 'cf_spec_value_history',
      ['company_id', 'value_id', 'specification_id', 'subject_type', 'subject_id', 'change_type', 'old_value', 'new_value', 'changed_by'],
      values.map((v) => [c.companyId, valueId.get(`${v.subjectId}:${v.specId}`), v.specId, 'master', v.subjectId, 'create', null, JSON.stringify({
        number: v.typed.value_number, text: v.typed.value_text, bool: v.typed.value_bool == null ? null : !!Number(v.typed.value_bool), date: v.typed.value_date,
        option_id: v.typed.option_id, json: v.typed.value_json, uom: v.uom, source: v.source,
      }), c.userId ?? null]));
  }
  const created = make.map((p) => ({ key: p.key, itemId: p.id, code: p.code, name: p.name, kind: p.kind }));
  return { dryRun: false, created, skipped, message: say(created) };
}

export const _test = { nameLike, modelFor, existingPlate, readOnce, valueRows };
