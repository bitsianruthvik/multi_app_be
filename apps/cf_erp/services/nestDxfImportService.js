/**
 * nestDxfImportService.js — CF_ERP. Upload the customer's nesting: one DXF per plate, copied
 * exactly as drawn (user, 2026-10-10: "We should ideally be able to just upload nesting files and
 * it should copy the entire nesting from the customer").
 *
 *   POST   /orders/:o/lines/:l/nesting/files          uploadNestFiles   { files, dryRun, force, mode, remove, choices }
 *   GET    /orders/:o/lines/:l/nesting/files          getNestFiles      what is saved, what is left over
 *   GET    /orders/:o/lines/:l/nesting/files/:lotId   nestFileOf        the file a plate was read from
 *   DELETE /orders/:o/lines/:l/nesting/lots/:lotId    deleteNestLot     one plate off the line
 *
 * WHAT ONE FILE GOES THROUGH
 *   read      lib/nestDxfReader.readNestDxf — the plate, the parts on it, the words (thickness,
 *             grade, nest number, plate size) in the title or the file name.
 *   match     matchNest against the line's cut plates. A cut plate answers to its own code, to the
 *             DRAWING MARK and the item code of the rows cut from it; its shape is its drawing
 *             when the line has one for it (partDrawingService.drawingFactsOfLine), else its
 *             rectangle LENGTH × WIDTH.
 *   plate     named in the request (`plateCode`), else found by the size the file draws / says,
 *             exactly as the nesting sheet finds a plate by size: length and width either way
 *             round, ±0.5 mm, told apart by thickness, grade and material.
 *   check     services/nestShapes.verifyPlate (shapePacker.verifyLayout): overlap and a part off
 *             the plate BLOCK; nearer than our kerf, or inside the rim, is a WARNING that needs
 *             `force` — the customer's program may cut with another kerf. Parts that touch are a
 *             common cut and are not a problem at all. A part the reader finds ACROSS the plate's
 *             edge (`outsidePlate`) blocks and is not counted as nested; a closed area between
 *             common-cut parts that matches nothing (`maybeScrap`) is a note, not a part.
 *             The check and the waste measure are exact polygon work: every file's are made
 *             together OFF THIS THREAD (services/nestMeasure.js).
 *   store     x, y, rotation_deg, mirrored per part, exactly as drawn (init.sql §55); the lot is
 *             `origin = 'imported'`, `layout_origin = 'customer'`, and the file text is kept.
 *
 * A RE-UPLOAD IS A DIFFERENCE, NOT A WIPE (`mode: 'merge'`, the default). A file whose nest number
 * (or file name) is a saved uploaded plate REPLACES that plate; a new one is ADDED; plates not
 * mentioned STAY. `mode: 'replace'` also removes every uploaded plate the request does not
 * mention, and `remove: [lotId | nestNo]` removes the ones it names. The dry run says all of it
 * (`diff`) before anything is written. Pieces our own packer placed that the new upload makes
 * surplus — automatic plates, and our additions on a customer's plate — are named in the diff and
 * dropped only by the confirmed save.
 *
 * COVERAGE. Fewer pieces than the line needs is fine: `leftOver` says exactly what is left, and
 * "nest the rest" places it. MORE is refused (needs `force`), with the surplus named.
 *
 * NOTHING THROWS FOR A BAD FILE OR A BAD PART: every problem is collected, per file and per part,
 * and each names the file, the plate and the part. Only "there is nothing to read at all" throws.
 *
 * ONE WRITER AT A TIME. A save (and a delete) is refused while a nesting run is working on the
 * line (RUN_BUSY: its proposal would be for a line that no longer exists), and — because the
 * state it was worked out from was read before the line's lock was taken — it reads the line's
 * live plates once more UNDER the lock and refuses (CHANGED_MEANWHILE) when another save got in
 * first. Nothing is written in either case.
 *
 * ROUND TRIPS (TiDB is ~49 ms each): a fixed number whatever the files hold — the reads are the
 * line, its cut plates, the catalog plates, the drawings and the saved lots; the writes are bulk.
 * The one thing that grows is the file text itself, sent in statements of at most ~8 MB.
 */
import { createHash } from 'node:crypto';
import { invalid, notFound, CfError } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { readNestDxf, matchNest } from '../lib/nestDxfReader.js';
import { drawingFactsOfLine } from './partDrawingService.js';
import { writePlateCuts } from './plateCutsService.js';
import {
  importContext, importBlocker, requireLine, assertNestable, pickCutSettings, wasteOfLot, offcutLetters, writeLots, clearLots,
  replaceAreaFractions, autoLotNumbers, agrees, kgOf, lineHead, exclusionsOfLine, DEFAULT_CUT_SETTINGS,
  savedLotsOf, isUploadedPiece, relotMany, wastesOf,
} from './nestingService.js';
import { measurePlates } from './nestMeasure.js';
import { memoryRun } from './nestRunService.js';

export { savedLotsOf, isUploadedPiece };
import {
  shapeOfCutPlate, placeShape, boxOfShape, ringsObject, ringsArea, verifyPlate, isPlainPlacement, normDeg, VERIFY_ENGINE, displayRings, rimOf,
} from './nestShapes.js';

/** A row is one TiDB entry (6 MB at most); the file is stored as text, so 4 MB is the cap. */
export const MAX_NEST_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_NEST_FILES = 200;
/** As stored (utf8mb4): under TiDB's 6 MB entry with room for the row's other columns. */
const MAX_STORED_FILE_BYTES = 5.5 * 1024 * 1024;
const FILE_INSERT_BYTES = 8 * 1024 * 1024;
const SIZE_TOL = 0.5;

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
const blank = (v) => v == null || String(v).trim() === '';
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const fmt = (n) => (n == null || !Number.isFinite(Number(n)) ? '?' : String(r3(n)));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const normCode = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
const squash = (s) => normCode(s).replace(/[\s\-_]+/g, '');
const norm = (s) => (blank(s) ? null : String(s).trim().toUpperCase());
const sameSize = (a, b, tol = SIZE_TOL) => Math.abs(Number(a) - Number(b)) <= tol;
const eitherWay = (l, w, L, W) => (sameSize(l, L) && sameSize(w, W)) || (sameSize(l, W) && sameSize(w, L));
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const stem = (name) => String(name ?? '').split(/[\\/]/).pop().replace(/\.[A-Za-z0-9]{1,5}$/, '');

/* ───────────────────────────── the saved state ───────────────────────────── */

/** Pieces of each cut plate on a set of lots: Map cutPlateId → { customer, ours }. */
function countsOn(lots) {
  const out = new Map();
  for (const l of lots) {
    for (const p of l.pieces) {
      if (!out.has(p.cutPlateId)) out.set(p.cutPlateId, { customer: 0, ours: 0 });
      out.get(p.cutPlateId)[isUploadedPiece(l, p) ? 'customer' : 'ours'] += 1;
    }
  }
  return out;
}

/**
 * Needed against nested, cut plate by cut plate — and what is LEFT OVER, exactly.
 *   coverage  [{ cutPlateId, cutPlateCode, needed, nested, customer, ours, diff, manual, leftOut }]
 *   leftOver  [{ cutPlateId, cutPlateCode, qty, thickness, length, width, grade, manual, leftOut }]
 */
export function coverageOfLots(cutPlates, lots, excl = null) {
  const counts = countsOn(lots);
  const coverage = [];
  const leftOver = [];
  const seen = new Set();
  for (const cp of cutPlates) {
    seen.add(cp.id);
    const c = counts.get(cp.id) ?? { customer: 0, ours: 0 };
    const nested = c.customer + c.ours;
    if (!cp.pieces && !nested) continue;
    const leftOut = !!excl?.cutPlates?.has(cp.id);
    coverage.push({ cutPlateId: cp.id, cutPlateCode: cp.code ?? `#${cp.id}`, needed: cp.pieces, nested, customer: c.customer, ours: c.ours, diff: nested - cp.pieces, manual: !!cp.manual, leftOut });
    if (nested < cp.pieces) {
      leftOver.push({
        cutPlateId: cp.id, cutPlateCode: cp.code ?? `#${cp.id}`, qty: cp.pieces - nested,
        thickness: cp.steel?.thickness ?? null, length: cp.steel?.length ?? null, width: cp.steel?.width ?? null, grade: cp.steel?.grade ?? null,
        manual: !!cp.manual, leftOut,
      });
    }
  }
  for (const [id, c] of counts) {
    if (seen.has(id)) continue;                    // a piece of a cut plate the line no longer has
    coverage.push({ cutPlateId: id, cutPlateCode: `#${id}`, needed: 0, nested: c.customer + c.ours, customer: c.customer, ours: c.ours, diff: c.customer + c.ours, manual: false, leftOut: false });
  }
  return { coverage, leftOver };
}

/* ───────────────────────────── reading the request ───────────────────────────── */

function readFiles(input) {
  const raw = Array.isArray(input.files) ? input.files : (input.file != null ? [{ filename: input.filename, file: input.file }] : null);
  if (!raw || !raw.length) throw invalid('NO_FILE', 'There is no nesting file to read — send `files: [{ filename, file }]`, each file as base64.');
  if (raw.length > MAX_NEST_FILES) throw invalid('TOO_MANY_FILES', `${raw.length} files is more than one upload takes (${MAX_NEST_FILES}). Send them in two goes — a second upload adds to the first.`);
  return raw.map((f, i) => {
    const filename = String(f?.filename ?? f?.name ?? `file ${i + 1}`).split(/[\\/]/).pop().slice(0, 255);
    const out = { index: i, filename, plateCode: blank(f?.plateCode) ? null : String(f.plateCode).trim(), nestNo: blank(f?.nestNo) ? null : String(f.nestNo).trim(), buffer: null, hash: null, problem: null };
    const body = f?.file ?? f?.content ?? f?.fileBase64;
    try {
      if (f?.text != null && body == null) out.buffer = Buffer.from(String(f.text), 'latin1');
      else if (body == null || body === '') out.problem = { code: 'BAD_FILE', message: 'it carries no file.' };
      else out.buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body).replace(/^data:[^,]*,/, ''), 'base64');
    } catch { out.problem = { code: 'BAD_FILE', message: 'it could not be read — send it as base64.' }; }
    if (out.buffer && !out.buffer.length) out.problem = { code: 'BAD_FILE', message: 'the file is empty.' };
    if (out.buffer && out.buffer.length > MAX_NEST_FILE_BYTES) out.problem = { code: 'FILE_TOO_BIG', message: `it is ${(out.buffer.length / 1048576).toFixed(1)} MB and one nesting file may be at most ${MAX_NEST_FILE_BYTES / 1048576} MB.` };
    // The text is kept in a utf8mb4 column: every byte above 0x7F is stored as two. A file of
    // accented or binary bytes could pass the 4 MB cap and still overflow TiDB's 6 MB row.
    if (out.buffer && !out.problem) {
      let high = 0;
      for (let b = 0; b < out.buffer.length; b += 1) if (out.buffer[b] > 127) high += 1;
      if (out.buffer.length + high > MAX_STORED_FILE_BYTES) out.problem = { code: 'FILE_TOO_BIG', message: `it holds ${high} non-ASCII bytes and would take ${((out.buffer.length + high) / 1048576).toFixed(1)} MB to store — more than one row holds. Export the nest as a plain ASCII DXF.` };
    }
    if (out.buffer && !out.problem) out.hash = createHash('sha256').update(out.buffer).digest('hex');
    return out;
  });
}

/* ───────────────────────────── one file ───────────────────────────── */

const steelWords = (s) => `${fmt(s.thickness)} mm${s.grade ? ` ${s.grade}` : ''}`;
const at = (p) => `(${fmt(p.x)}, ${fmt(p.y)})`;

/** The catalog plate a file is on, or why not. */
function resolvePlate({ file, nest, placed, ctx }) {
  const hints = nest.hints ?? {};
  const drawn = nest.plate.found === 'outline';
  const byCode = (code) => ctx.plates.find((p) => normCode(p.code) === normCode(code)) ?? ctx.plates.find((p) => squash(p.code) === squash(code));
  const usable = (p) => p.steel?.length > 0 && p.steel?.width > 0 && p.steel?.thickness > 0;
  // The steel the matched parts are: what tells two plates of one size apart.
  const steels = placed.map((pl) => pl.cp.steel);
  const vote = (key) => { const n = new Map(); for (const s of steels) { const v = key(s); if (v != null) n.set(v, (n.get(v) ?? 0) + 1); } return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
  const thickness = hints.thicknessMm ?? vote((s) => (s.thickness > 0 ? r3(s.thickness) : null));
  const grade = vote((s) => norm(s.grade));
  const material = vote((s) => norm(s.material));

  if (file.plateCode) {
    const plate = byCode(file.plateCode);
    if (!plate) return { error: { code: 'PLATE_NOT_FOUND', message: `"${file.plateCode}" is not the code of an active catalog plate.` } };
    if (!usable(plate)) return { error: { code: 'PLATE_NOT_FOUND', message: `${plate.code} has no thickness, length and width in the catalog, so nothing can be checked against it.` } };
    if (drawn && !eitherWay(nest.plate.length, nest.plate.width, plate.steel.length, plate.steel.width)) {
      return { plate, error: { code: 'PLATE_SIZE', message: `the file draws a ${fmt(nest.plate.length)} × ${fmt(nest.plate.width)} plate and ${plate.code} is ${fmt(plate.steel.length)} × ${fmt(plate.steel.width)}.` } };
    }
    return { plate, by: 'code' };
  }

  const size = drawn ? { length: nest.plate.length, width: nest.plate.width } : hints.plateSize;
  if (!size) {
    return { error: { code: 'PLATE_NOT_DRAWN', message: 'the file does not draw the plate and does not say its size, so nothing says which plate this is — name it (plateCode), or put the size in the file name, like N1_12mm_2500x1250.dxf.' } };
  }
  let hits = ctx.plates.filter((p) => usable(p) && eitherWay(p.steel.length, p.steel.width, size.length, size.width));
  const sizeWords = `${fmt(Math.max(size.length, size.width))} × ${fmt(Math.min(size.length, size.width))}`;
  if (!hits.length) return { error: { code: 'PLATE_NOT_FOUND', message: `no catalog plate is ${sizeWords}. Add it to the catalog, or name the plate you mean (plateCode).` } };
  if (thickness != null) {
    const t = hits.filter((p) => Math.abs(p.steel.thickness - thickness) <= 0.01);
    if (!t.length) {
      return { error: { code: 'PLATE_NOT_FOUND', message: `no catalog plate is ${fmt(thickness)} mm × ${sizeWords} — that size is in the catalog only at ${list([...new Set(hits.map((p) => fmt(p.steel.thickness)))])} mm.` } };
    }
    hits = t;
  }
  if (hits.length > 1) {
    const hintGrade = norm(hints.grade);
    const exact = hits.filter((p) => norm(p.steel.grade) === (hintGrade ?? grade) && (material == null || norm(p.steel.material) === material));
    const loose = hits.filter((p) => agrees(p.steel.grade, hintGrade ?? grade) && agrees(p.steel.material, material));
    hits = exact.length ? exact : loose.length ? loose : hits;
  }
  if (hits.length > 1) {
    return { error: { code: 'PLATE_AMBIGUOUS', message: `${sizeWords}${thickness != null ? ` at ${fmt(thickness)} mm` : ''} is ${plural(hits.length, 'catalog plate', 'catalog plates')} (${hits.map((p) => `${p.code}${p.steel.grade ? ` ${p.steel.grade}` : ''}`).join(', ')}) — name the one you mean (plateCode).`, choices: hits.map((p) => p.code) } };
  }
  return { plate: hits[0], by: 'size' };
}

/** A catalog plate by its code (exactly, else ignoring spaces, dashes and underscores). */
const plateByCode = (ctx, code) => ctx.plates.find((p) => normCode(p.code) === normCode(code)) ?? ctx.plates.find((p) => squash(p.code) === squash(code)) ?? null;

/** Corners in a set of rings. */
const cornersOf = (o) => o.outline.length + o.cutouts.reduce((a, r) => a + r.length, 0) + o.holes.reduce((a, r) => a + r.length, 0);
/** A stored outline may hold at most this many corners (cf_nest_placements.rings_json; a row stays far under TiDB's 6 MB). */
export const MAX_FILE_RING_CORNERS = 2000;

/**
 * Reads, matches, places and checks ONE file — IN THREE STEPS, because two of the things it needs
 * are exact polygon work that must not hold the server's thread (services/nestMeasure.js):
 *
 *   prepareFile(file, ctx, choices) → { entry, verifyArgs, verified, measured }
 *     reads the DXF, matches its parts, finds the plate. `verifyArgs` (or null) is what
 *     nestShapes.verifyPlate is asked about the layout;
 *   verified(check) → [lot, pieces] | null
 *     takes that answer, says the overlaps / the edge / the kerf, builds what a save stores, and
 *     hands back what nestingService.wasteOfLot is asked about the plate (or null);
 *   measured(waste)
 *     takes that answer: the file's metrics and `entry._lot`, what a save writes.
 *
 * uploadNestFiles runs the three steps for every file with the two measurements made together,
 * off this thread; `processFile` runs them in place (tests, one file).
 * Pure but for what `ctx` already holds. `entry` is the file's entry in the answer.
 */
function prepareFile(file, ctx, choices) {
  const entry = {
    filename: file.filename, bytes: file.buffer?.length ?? 0, hash: file.hash, nestNo: null, lotNo: null,
    status: 'ok', action: null, units: null, plate: null, parts: 0, placed: 0,
    placements: [], counts: [], errors: [], warnings: [], notes: [], metrics: null,
  };
  const done = { entry, verifyArgs: null, verified: () => null, measured: () => {} };
  const name = () => (entry.plate?.code ? `plate ${entry.plate.code}` : entry.nestNo ? `nest ${entry.nestNo}` : 'its plate');
  const err = (code, message, extra = {}) => entry.errors.push({ code, message: `${file.filename}: ${message}`, ...extra });
  const partErr = (code, part, message, extra = {}) => entry.errors.push({ code, partId: part.id, message: `${file.filename}, ${name()}, part ${part.id}${part.labels?.length ? ` ("${part.labels[0]}")` : ''} at ${at(part.bbox)}: ${message}`, ...extra });
  const warn = (code, message, extra = {}) => entry.warnings.push({ code, needsForce: true, message: `${file.filename}, ${name()}: ${message}`, ...extra });
  const settle = () => { entry.status = entry.errors.length ? 'error' : entry.warnings.length ? 'warning' : 'ok'; };

  if (file.problem) { err(file.problem.code, file.problem.message); settle(); return done; }

  // A plate named in the request is known before the file is read: its size tells the reader that
  // a block of parts cut edge to edge and filling that size IS the plate (lib/nestDxfReader `plateSize`).
  const named = file.plateCode ? plateByCode(ctx, file.plateCode) : null;
  const sizeOfNamed = named?.steel?.length > 0 && named?.steel?.width > 0 ? { length: named.steel.length, width: named.steel.width } : null;
  let nest;
  try { nest = readNestDxf(file.buffer, { filename: file.filename, ...(sizeOfNamed ? { plateSize: sizeOfNamed } : {}) }); } catch (e) {
    err(e?.code && ['BAD_FILE', 'EMPTY_NEST', 'TOO_BIG'].includes(e.code) ? e.code : 'BAD_FILE', e?.message ?? 'it could not be read as a DXF drawing.');
    settle();
    return done;
  }
  entry.units = nest.units;
  entry.parts = nest.parts.length;
  entry.nestNo = file.nestNo ?? nest.hints?.nestNo ?? stem(file.filename);
  entry.lotNo = String(entry.nestNo).slice(0, 30);
  for (const w of nest.warnings ?? []) entry.notes.push(w);

  // ---- which cut plate each part is ----------------------------------------
  const m = matchNest(nest, ctx.candidates, { toleranceMm: 0.5 });
  const partById = new Map(nest.parts.map((p) => [p.id, p]));
  /*
   * A PART LYING ACROSS THE PLATE'S EDGE (`outsidePlate`, the reader's own finding) is a part
   * hanging off the plate: it is said (OUTSIDE_PLATE, which blocks the save) and it is NOT nested
   * — not placed, not counted, not checked against its neighbours. A reader that does not set the
   * flag simply never reports one here; the geometry check below then says the same thing.
   */
  const across = new Set(nest.parts.filter((p) => p.outsidePlate).map((p) => p.id));
  const matchedKey = new Map(m.placements.map((pl) => [pl.partId, pl.candidateKey]));
  const placed = [];
  for (const pl of m.placements) if (!across.has(pl.partId)) placed.push({ ...pl, part: partById.get(pl.partId), cp: ctx.cpByKey.get(pl.candidateKey) });

  // ---- the plate -----------------------------------------------------------
  const res = resolvePlate({ file, nest, placed, ctx });
  if (res.error) err(res.error.code, res.error.message, res.error.choices ? { choices: res.error.choices } : {});
  const plate = res.plate ?? null;
  const drawn = nest.plate.found === 'outline';
  // The lot is the plate AS THE FILE DREW IT: a customer may draw 2500 × 1250 standing up.
  let lotL = nest.plate.length; let lotW = nest.plate.width;
  if (plate) {
    const P = plate.steel;
    if (drawn) { const flat = sameSize(lotL, P.length) && sameSize(lotW, P.width); lotL = flat ? P.length : P.width; lotW = flat ? P.width : P.length; }
    else {
      // Not drawn: the plate lies as the catalog has it, unless the parts only fit on it stood up.
      const fits = (L, W) => nest.plate.length <= L + SIZE_TOL && nest.plate.width <= W + SIZE_TOL;
      const flat = fits(P.length, P.width) || !fits(P.width, P.length);
      lotL = flat ? P.length : P.width; lotW = flat ? P.width : P.length;
    }
    if (nest.hints?.thicknessMm != null && Math.abs(Number(nest.hints.thicknessMm) - P.thickness) > 0.01) {
      err('PLATE_WRONG_THICKNESS', `the file says ${fmt(nest.hints.thicknessMm)} mm and ${plate.code} is ${fmt(P.thickness)} mm.`);
    }
    if (nest.hints?.grade && P.grade && squash(nest.hints.grade) !== squash(P.grade)) {
      err('PLATE_WRONG_GRADE', `the file says ${nest.hints.grade} and ${plate.code} is ${P.grade}.`);
    }
  }
  const settings = pickCutSettings(ctx.settingRows, plate?.steel.thickness ?? nest.hints?.thicknessMm ?? placed[0]?.cp.steel.thickness ?? null);
  const k = Number(settings.kerfMm) || 0;
  // A file that does not draw its plate measures from the corner of its parts: they are put one
  // kerf in from the plate's corner (when there is room), and the answer says by how much.
  let dx = 0; let dy = 0;
  if (!drawn && plate && nest.plate.length + 2 * k <= lotL + 1e-6 && nest.plate.width + 2 * k <= lotW + 1e-6) { dx = k; dy = k; }
  entry.plate = plate
    ? { itemId: plate.id, code: plate.code, name: plate.name ?? null, thickness: plate.steel.thickness, grade: plate.steel.grade ?? null, material: plate.steel.material ?? null, length: lotL, width: lotW, drawn, resolvedBy: res.by, offset: [dx, dy], kerfMm: k }
    : { itemId: null, code: null, length: lotL, width: lotW, drawn, resolvedBy: null, offset: [0, 0], kerfMm: k };

  // ---- parts hanging off the plate -------------------------------------------
  for (const id of across) {
    const part = partById.get(id);
    const cp = matchedKey.has(id) ? ctx.cpByKey.get(matchedKey.get(id)) : null;
    entry.errors.push({
      code: 'OUTSIDE_PLATE', partId: id, ...(cp ? { cutPlateId: cp.id, cutPlateCode: cp.code } : {}),
      message: `${file.filename}, ${name()}: ${cp ? cp.code : `a part${part.labels?.length ? ` ("${part.labels[0]}")` : ''}`} at ${at(part.bbox)}, ${fmt(part.bbox.length)} × ${fmt(part.bbox.width)}, runs off the plate${Number(part.outsideMm) > 0 ? ` by ${fmt(part.outsideMm)} mm` : ''}, which is ${fmt(lotL)} × ${fmt(lotW)}. It is not counted as nested.`,
    });
  }

  // ---- parts that could be more than one cut plate --------------------------
  const chosen = choices?.[file.filename] ?? choices?.[stem(file.filename)] ?? {};
  const keyOfChoice = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (ctx.cpByKey.has(s)) return s;
    if (/^\d+$/.test(s) && ctx.cpByKey.has(`cp${s}`)) return `cp${s}`;
    const cp = ctx.cutPlates.find((c) => normCode(c.code) === normCode(s));
    return cp ? `cp${cp.id}` : null;
  };
  const steelFits = (cp) => !plate || (Math.abs(cp.steel.thickness - plate.steel.thickness) <= 0.0005 && agrees(plate.steel.grade, cp.steel.grade) && agrees(plate.steel.material, cp.steel.material));
  for (const a of m.ambiguous) {
    if (across.has(a.partId)) continue;               // said above; which cut plate it is no longer matters
    const part = partById.get(a.partId);
    const want = keyOfChoice(chosen[a.partId]);
    let pick = null; let by = null;
    if (chosen[a.partId] != null) {
      if (want && a.candidateKeys.includes(want)) { pick = want; by = 'choice'; } else {
        partErr('CHOICE_INVALID', part, `"${chosen[a.partId]}" was chosen for it, but it can only be ${list(a.candidateKeys.map((key) => ctx.cpByKey.get(key).code))}.`, { choices: a.candidateKeys.map((key) => ({ key, cutPlateId: ctx.cpByKey.get(key).id, code: ctx.cpByKey.get(key).code })) });
        continue;
      }
    } else {
      const fit = a.candidateKeys.filter((key) => steelFits(ctx.cpByKey.get(key)));
      if (plate && fit.length === 1) { pick = fit[0]; by = 'steel'; }
    }
    if (!pick) {
      const options = a.candidateKeys.map((key) => { const cp = ctx.cpByKey.get(key); return { key, cutPlateId: cp.id, code: cp.code, thickness: cp.steel.thickness, grade: cp.steel.grade ?? null }; });
      partErr('PART_AMBIGUOUS', part, `it could be ${list(options.map((o) => `${o.code} (${steelWords(o)})`))} — they are the same shape. Say which (choices), or label the part in the file.`, { choices: options });
      continue;
    }
    const opt = a.options.find((o) => o.candidateKey === pick);
    placed.push({ ...opt, by, part, cp: ctx.cpByKey.get(pick) });
  }

  // ---- parts that are none of the line's cut plates -------------------------
  /*
   * A CLOSED AREA BETWEEN COMMON-CUT PARTS that matches nothing (`maybeScrap`: every side of it is
   * a cut shared with a part, and it carries no label) is the scrap between parts, not a part the
   * line forgot: it is a NOTE, it blocks nothing, and it is left out of the layout check. Anything
   * else unmatched is still a part nobody can name, and blocks.
   */
  const scrap = new Set();
  for (const u of m.unmatched) {
    if (across.has(u.partId)) continue;
    const part = partById.get(u.partId) ?? { id: u.partId, bbox: u.bbox, labels: u.labels };
    if (u.maybeScrap) {
      scrap.add(u.partId);
      (entry.scrap ??= []).push({ partId: u.partId, x: part.bbox.x, y: part.bbox.y, length: part.bbox.length, width: part.bbox.width });
      continue;
    }
    if (/^It is labelled/.test(u.why ?? '')) partErr('PART_LABEL_MISMATCH', part, u.why);
    else partErr('PART_UNKNOWN', part, `${u.why ?? 'It matches no cut plate.'} It is not one of this line's cut plates.`);
  }
  if (scrap.size) {
    const first = partById.get([...scrap][0]);
    entry.notes.push(`${plural(scrap.size, 'closed area', 'closed areas')} between common-cut parts ${scrap.size === 1 ? 'matches' : 'match'} no cut plate (the first at ${at(first.bbox)}, ${fmt(first.bbox.length)} × ${fmt(first.bbox.width)}) — taken as the scrap between the parts, not as a part.`);
  }
  if (nest.skeleton) entry.notes.push(`The parts are cut against the plate's own edge; what is left of the plate (${fmt(nest.skeleton.bbox?.length)} × ${fmt(nest.skeleton.bbox?.width)} overall) is its remainder, not a part.`);

  // ---- the steel has to agree, part by part ---------------------------------
  if (plate) {
    for (const pl of placed) {
      const s = pl.cp.steel;
      if (Math.abs(s.thickness - plate.steel.thickness) > 0.0005) partErr('PART_WRONG_THICKNESS', pl.part, `${pl.cp.code} is ${fmt(s.thickness)} mm and ${plate.code} is ${fmt(plate.steel.thickness)} mm, so it cannot be cut from it.`, { cutPlateCode: pl.cp.code });
      else if (!agrees(plate.steel.grade, s.grade)) partErr('PART_WRONG_GRADE', pl.part, `${pl.cp.code} is ${s.grade ?? 'of no stated grade'} and ${plate.code} is ${plate.steel.grade}. A nest cannot mix grades.`, { cutPlateCode: pl.cp.code });
      else if (!agrees(plate.steel.material, s.material)) partErr('PART_WRONG_GRADE', pl.part, `${pl.cp.code} is ${s.material ?? 'of no stated material'} and ${plate.code} is ${plate.steel.material}.`, { cutPlateCode: pl.cp.code });
    }
  }

  // ---- the layout itself, on the customer's own lines -----------------------
  const move = (rings) => { const o = ringsObject(rings); const f = (r) => r.map(([x, y]) => [x + dx, y + dy]); return { outline: f(o.outline), cutouts: o.cutouts.map(f), holes: o.holes.map(f) }; };
  const cpOfPart = new Map(placed.map((pl) => [pl.partId, pl.cp]));
  // What is checked: every shape ON the plate that is a part (not one hanging off it, not scrap).
  const onPlate = nest.parts.filter((p) => !across.has(p.id) && !scrap.has(p.id));
  const label = (i) => { const part = onPlate[i]; const cp = cpOfPart.get(part.id); return `${cp ? cp.code : `part ${part.id}`} at ${at({ x: part.bbox.x + dx, y: part.bbox.y + dy })}`; };
  // Our kerf, and one kerf at the edge (rimOf().legalMin): the same legal minimum our own layouts
  // are verified against — but a customer's layout only WARNS below it (their program may cut
  // with another kerf), where ours is refused.
  done.verifyArgs = { length: lotL, width: lotW, kerf: k, margin: rimOf(k).legalMin, rim: drawn, placements: onPlate.map((p) => ({ key: p.id, rings: move(p.rings) })) };

  done.verified = (check) => {
    const close = [];
    const rim = [];
    for (const pr of check.problems) {
      const A = onPlate[pr.ai]; const B = pr.bi != null && pr.bi >= 0 ? onPlate[pr.bi] : null;
      if (pr.kind === 'overlap') entry.errors.push({ code: 'OVERLAP', partId: A.id, otherPartId: B?.id ?? null, message: `${file.filename}, ${name()}: ${label(pr.ai)} and ${label(pr.bi)} overlap — two parts cannot be cut from the same steel.` });
      else if (pr.kind === 'outside') entry.errors.push({ code: 'OUTSIDE_PLATE', partId: A.id, message: `${file.filename}, ${name()}: ${label(pr.ai)} runs off the plate, which is ${fmt(lotL)} × ${fmt(lotW)}${drawn ? '' : ' (the file does not draw it, so its parts are measured from the plate corner)'}.` });
      else if (pr.kind === 'too_close') close.push({ a: A.id, b: B?.id ?? null, distance: pr.distance ?? null, text: `${label(pr.ai)} and ${label(pr.bi)}${pr.distance != null ? ` are ${fmt(pr.distance)} mm apart` : ''}` });
      else if (pr.kind === 'in_rim') rim.push({ a: A.id, text: label(pr.ai) });
    }
    if (close.length) {
      warn('TOO_CLOSE', `${close[0].text}${close.length > 1 ? ` (and ${plural(close.length - 1, 'more pair', 'more pairs')})` : ''} — closer than the ${fmt(k)} mm kerf we cut ${fmt(plate?.steel.thickness ?? null)} mm plate with. The customer's program may use another kerf — save anyway to keep the layout as drawn.`, { pairs: close.slice(0, 50) });
    }
    if (rim.length) {
      warn('IN_RIM', `${rim[0].text}${rim.length > 1 ? ` and ${plural(rim.length - 1, 'more part', 'more parts')}` : ''} ${rim.length > 1 ? 'sit' : 'sits'} nearer the plate edge than one ${fmt(k)} mm kerf. A plate edge is not straight, so we keep a kerf clear of it — save anyway to keep the layout as drawn.`, { parts: rim.slice(0, 50).map((r) => r.a) });
    }
    if (check.commonCuts.length) entry.notes.push(`${plural(check.commonCuts.length, 'common cut', 'common cuts')}: parts that touch share one cut line.`);
    if (!drawn && plate) entry.notes.push(dx || dy ? `The file does not draw the plate, so its parts are placed ${fmt(dx)} mm in from the plate's lower-left corner.` : 'The file does not draw the plate, so its parts are measured from the plate\'s lower-left corner.');

    // ---- what it stores: our shape, placed exactly where the file has it --------
    const pieces = [];
    const count = new Map();
    let fromFile = 0; let tooIntricate = 0;
    for (const pl of placed.sort((p, q) => (p.part.bbox.y - q.part.bbox.y) || (p.part.bbox.x - q.part.bbox.x))) {
      const shape = ctx.shapeOf(pl.cp);
      const rot = normDeg(pl.rotationDeg ?? 0);
      let rings = placeShape(shape.rings, { x: Number(pl.x) + dx, y: Number(pl.y) + dy, rotationDeg: rot, mirrored: !!pl.mirrored });
      /*
       * A CUT PLATE WITH NO DRAWING, DRAWN BY THE CUSTOMER AS SOMETHING OTHER THAN A RECTANGLE
       * (it was matched by its label or by the box round it): the customer's own outline is kept
       * for this placement — the diagram, the overlap check, the free space and the offcuts then
       * use the real shape instead of a rectangle that is not there. On THIS PLATE the steel in the
       * part (`area`, cf_nest_placements.area_mm2) is then the outline's — otherwise the plate would
       * not add up — but nothing is written on the cut plate itself: its catalog LENGTH, WIDTH and
       * weight stay what they are until a drawing is uploaded, and a drawing, once there, wins.
       */
      let fileRings = null;
      if (!shape.drawn && pl.part?.rings) {
        const own = move(pl.part.rings);
        const b = boxOfShape(own);
        const boxArea = b.length * b.width;
        const notARectangle = own.cutouts.length > 0 || own.holes.length > 0 || ringsArea(own) < boxArea - Math.max(1, boxArea * 1e-4);
        // Lying square it must not be a rectangle; at a free angle a rectangle's own outline IS what placeShape gives.
        const turnedRect = !isPlainPlacement(rot, !!pl.mirrored) && own.outline.length === 4 && !own.cutouts.length && !own.holes.length;
        if (notARectangle && !turnedRect) {
          if (cornersOf(own) <= MAX_FILE_RING_CORNERS) {
            const r = (ring) => ring.map(([x, y]) => [r3(x), r3(y)]);
            fileRings = { outline: r(own.outline), cutouts: own.cutouts.map(r), holes: own.holes.map(r) };
            rings = fileRings;
            fromFile += 1;
          } else tooIntricate += 1;
        }
      }
      const box = boxOfShape(rings);
      const piece = {
        partId: pl.partId, cutPlateId: pl.cp.id, cutPlateCode: pl.cp.code,
        seqNo: 1, rowNo: 1, posNo: pieces.length + 1,
        x: box.x, y: box.y, length: box.length, width: box.width,
        rotationDeg: rot, mirrored: !!pl.mirrored, placedBy: 'customer', area: fileRings ? r3(ringsArea(fileRings)) : shape.area,
        by: pl.by, confidence: pl.confidence ?? null,
        shaped: shape.drawn || !!fileRings || !isPlainPlacement(rot, !!pl.mirrored), placedRings: rings,
        ...(fileRings ? { fileRings, shapeFrom: 'nesting file' } : {}),
      };
      pieces.push(piece);
      count.set(pl.cp.id, (count.get(pl.cp.id) ?? 0) + 1);
    }
    if (fromFile) entry.notes.push(`${plural(fromFile, 'part has', 'parts have')} no drawing and ${fromFile === 1 ? 'is' : 'are'} not a rectangle in the file: ${fromFile === 1 ? 'its shape is' : 'their shapes are'} taken from the nesting file. The cut plate's own size and weight stay the catalog's until a drawing is uploaded.`);
    if (tooIntricate) entry.notes.push(`${plural(tooIntricate, 'part without a drawing is', 'parts without a drawing are')} too intricate in the file to keep the outline of (more than ${MAX_FILE_RING_CORNERS} corners): stored as the rectangle round ${tooIntricate === 1 ? 'it' : 'them'}.`);
    entry.placed = pieces.length;
    entry.counts = [...count].map(([id, qty]) => ({ cutPlateId: id, cutPlateCode: ctx.cpById.get(id).code, qty }));
    entry.placements = pieces.map((p) => ({
      partId: p.partId, cutPlateId: p.cutPlateId, cutPlateCode: p.cutPlateCode, x: p.x, y: p.y, length: p.length, width: p.width,
      rotationDeg: p.rotationDeg, mirrored: p.mirrored, placedBy: 'customer', area: p.area, by: p.by, confidence: p.confidence, rings: displayRings(p.placedRings),
      ...(p.shapeFrom ? { shapeFrom: p.shapeFrom } : {}),
    }));
    settle();
    if (!(plate && pieces.length)) return null;

    const steel = ctx.cpById.get(pieces[0].cutPlateId).steel;
    const density = plate.steel.density ?? steel.density ?? null;
    const wasteLot = {
      lotNo: entry.lotNo, length: lotL, width: lotW, thickness: plate.steel.thickness, density, kerfMm: k, seqGapMinMm: settings.seqGapMinMm,
      offcutMinAreaMm2: settings.offcutMinAreaMm2, offcutMinSideMm: settings.offcutMinSideMm,
    };
    done.measured = (waste) => {
      const plateKg = kgOf(lotL * lotW, plate.steel.thickness, density);
      entry.metrics = {
        plateKg, partsKg: waste.partsKg, wasteKgTotal: r3(plateKg - waste.partsKg), wastePct: lotL * lotW > 0 ? r3(((lotL * lotW - waste.partsArea) / (lotL * lotW)) * 100) : null,
        waste: waste.waste, wasteKg: waste.wasteKg, offcuts: waste.offcuts.length, offcutKg: r3(waste.offcuts.reduce((a, o) => a + (o.weightKg ?? 0), 0)),
      };
      const maxX = Math.max(...pieces.map((p) => p.x + p.length)); const maxY = Math.max(...pieces.map((p) => p.y + p.width));
      entry._lot = {
        lotNo: entry.lotNo, plate, lengthMm: lotL, widthMm: lotW, source: 'catalog', isManual: false, settings,
        grade: steel.grade ?? plate.steel.grade, material: steel.material ?? plate.steel.material, density,
        requiredLength: r3(maxX + k), requiredWidth: r3(maxY + k),
        origin: 'imported', verdict: null, reasons: null, forced: false,
        notes: String(entry.nestNo).length > 30 ? `Nest in the file: ${entry.nestNo}`.slice(0, 500) : null,
        waste, pieces,
        sourceKind: 'dxf', sourceFile: file.filename, sourceHash: file.hash, layoutOrigin: 'customer',
      };
    };
    return [wasteLot, pieces];
  };
  return done;
}

/** The three steps of prepareFile in place, on this thread — one file, or a test. */
function processFile(file, ctx, choices) {
  const st = prepareFile(file, ctx, choices);
  if (st.verifyArgs) {
    const pair = st.verified(verifyPlate(st.verifyArgs));
    if (pair) st.measured(wasteOfLot(...pair));
  }
  return st.entry;
}

/** Every file of a request through prepareFile, the two measurements made together off this thread. */
async function processFiles(files, ctx, choices) {
  const stages = [];
  for (const f of files) { stages.push(prepareFile(f, ctx, choices)); await new Promise((resolve) => { setImmediate(resolve); }); }
  const checking = stages.filter((s) => s.verifyArgs);
  const checks = await measurePlates(checking.map((s) => ({ kind: 'verify', args: s.verifyArgs })));
  const pairs = [];
  checking.forEach((s, i) => { const pair = s.verified(checks[i]); if (pair) pairs.push({ s, pair }); });
  const wastes = await wastesOf(pairs.map((x) => x.pair));
  pairs.forEach((x, i) => x.s.measured(wastes[i]));
  return stages.map((s) => s.entry);
}

/* ───────────────────────────── the context ───────────────────────────── */

/**
 * The rows cut from each cut plate — the item whose BOM holds it — with their code and DRAWING
 * MARK: the other names a customer's file may give a part. Two reads, whatever the size.
 * → [{ cutPlateId, code, mark }]
 */
async function rowsCutFrom(db, companyId, cutPlateIds) {
  if (!cutPlateIds.length) return [];
  const [parents] = await db.query(
    `SELECT bl.child_id AS cut_plate_id, m.id, m.code
       FROM cf_bom_lines bl
       JOIN cf_boms b ON b.id = bl.bom_id AND b.company_id = bl.company_id AND b.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = b.parent_id AND m.company_id = b.company_id AND m.deleted_at IS NULL
      WHERE bl.company_id = ? AND bl.deleted_at IS NULL AND bl.child_id IN (?)`,
    [companyId, cutPlateIds],
  );
  if (!parents.length) return [];
  const [marks] = await db.query(
    `SELECT v.subject_id, v.value_text
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.code = 'DRAWING_MARK'
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.subject_id IN (?)`,
    [companyId, [...new Set(parents.map((p) => p.id))]],
  );
  const markOf = new Map(marks.map((r) => [Number(r.subject_id), r.value_text]));
  return parents.map((p) => ({ cutPlateId: Number(p.cut_plate_id), code: p.code ?? null, mark: markOf.get(Number(p.id)) ?? null }));
}

/** Everything an upload is checked against, read once (a fixed number of round trips). */
async function uploadContext(db, companyId, lineId) {
  const ctx = await importContext(db, companyId, lineId);
  const [facts, rows, saved, excl] = await Promise.all([
    drawingFactsOfLine(db, companyId, lineId),
    rowsCutFrom(db, companyId, ctx.cutPlates.map((cp) => cp.id)),
    savedLotsOf(db, companyId, lineId),
    exclusionsOfLine(db, companyId, lineId),
  ]);
  const [bars] = await db.query("SELECT lot_no FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'bar'", [companyId, lineId]);
  // A cut plate answers to its own code, and to the drawing mark and item code of every row cut from it.
  const codes = new Map(ctx.cutPlates.map((cp) => [cp.id, new Set([cp.code].filter(Boolean))]));
  for (const row of rows) { const s = codes.get(row.cutPlateId); if (s) { if (row.mark) s.add(row.mark); if (row.code) s.add(row.code); } }
  const shapes = new Map();
  const shapeOf = (cp) => { if (!shapes.has(cp.id)) shapes.set(cp.id, shapeOfCutPlate(cp, facts)); return shapes.get(cp.id); };
  const usable = ctx.cutPlates.filter((cp) => cp.steel?.length > 0 && cp.steel?.width > 0 && cp.steel?.thickness > 0);
  const candidates = usable.map((cp) => { const s = shapeOf(cp); return { key: `cp${cp.id}`, codes: [...codes.get(cp.id)], rings: s.drawn ? s.rings : null, length: cp.steel.length, width: cp.steel.width }; });
  return {
    ...ctx, facts, saved, excl, candidates, shapeOf,
    cpByKey: new Map(usable.map((cp) => [`cp${cp.id}`, cp])),
    cpById: new Map(ctx.cutPlates.map((cp) => [cp.id, cp])),
    barNos: new Set(bars.map((b) => String(b.lot_no).toUpperCase())),
  };
}

/* ───────────────────────────── the difference ───────────────────────────── */

const samePlace = (a, b) => a.cutPlateId === b.cutPlateId && Math.abs(a.x - b.x) <= 0.01 && Math.abs(a.y - b.y) <= 0.01
  && Math.abs(normDeg(a.rotationDeg) - normDeg(b.rotationDeg)) <= 0.01 && !!a.mirrored === !!b.mirrored;
const tally = (pieces, codeOf) => { const m = new Map(); for (const p of pieces) m.set(p.cutPlateId, (m.get(p.cutPlateId) ?? 0) + 1); return [...m].map(([id, qty]) => ({ cutPlateId: id, cutPlateCode: codeOf(id), qty })); };

/** What changed between a saved uploaded plate and the file that replaces it. */
function changeOf(old, now, codeOf) {
  const was = old.pieces.filter((p) => isUploadedPiece(old, p));
  const ours = old.pieces.filter((p) => !isUploadedPiece(old, p));
  const a = new Map(); const b = new Map();
  for (const p of was) a.set(p.cutPlateId, (a.get(p.cutPlateId) ?? 0) + 1);
  for (const p of now) b.set(p.cutPlateId, (b.get(p.cutPlateId) ?? 0) + 1);
  const parts = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(id) ?? 0) !== (b.get(id) ?? 0)) parts.push({ cutPlateId: id, cutPlateCode: codeOf(id), was: a.get(id) ?? 0, now: b.get(id) ?? 0, change: (b.get(id) ?? 0) - (a.get(id) ?? 0) });
  }
  // Moved: a part both versions have, that is not where it was.
  const left = was.slice();
  let still = 0;
  for (const p of now) { const i = left.findIndex((q) => samePlace(p, q)); if (i >= 0) { left.splice(i, 1); still += 1; } }
  let common = 0;
  for (const id of new Set([...a.keys(), ...b.keys()])) common += Math.min(a.get(id) ?? 0, b.get(id) ?? 0);
  return { parts, moved: Math.max(0, common - still), added: parts.filter((p) => p.change > 0).reduce((s, p) => s + p.change, 0), removed: parts.filter((p) => p.change < 0).reduce((s, p) => s - p.change, 0), droppedOurs: tally(ours, codeOf) };
}

/* ───────────────────────────── upload ───────────────────────────── */

/**
 * POST …/nesting/files — the preview (dryRun, the default) or the save.
 *
 *   input.files     [{ filename, file (base64), plateCode?, nestNo? }]
 *   input.dryRun    default TRUE: read, match, check, say the difference — write nothing
 *   input.force     save although a file has warnings (closer than kerf, inside the rim) or a cut
 *                   plate is nested more often than the line needs
 *   input.mode      'merge' (default) | 'replace'
 *   input.remove    [lotId | nestNo] — plates to take off the line in the same save
 *   input.choices   { [filename]: { [partId]: cutPlateId | 'cp<id>' | cut plate code } }
 */
export async function uploadNestFiles(db, c, lineId, input = {}) {
  const dryRun = input.dryRun === undefined ? true : truthy(input.dryRun);
  const force = truthy(input.force);
  const mode = String(input.mode ?? 'merge').toLowerCase() === 'replace' ? 'replace' : 'merge';
  const removeAsk = Array.isArray(input.remove) ? input.remove : [];
  const files = input.files == null && removeAsk.length ? [] : readFiles(input);
  const companyId = c.companyId;
  const ctx = await uploadContext(db, companyId, lineId);
  const codeOf = (id) => ctx.cpById.get(id)?.code ?? `#${id}`;
  const problems = [];
  const warnings = [];
  const blocker = importBlocker(ctx.line);
  if (blocker) problems.push({ code: blocker.code ?? 'INVALID', message: blocker.message });

  const entries = await processFiles(files, ctx, input.choices ?? null);

  // ---- the same file twice, two files for one nest -------------------------
  const byHash = new Map();
  const byNest = new Map();
  for (const e of entries) {
    if (e.hash) {
      if (byHash.has(e.hash)) e.errors.push({ code: 'DUPLICATE_FILE', message: `${e.filename}: it is the same file as ${byHash.get(e.hash).filename} — the same plate uploaded twice. Send it once.` });
      else byHash.set(e.hash, e);
    }
    if (e.lotNo) {
      const key = e.lotNo.toUpperCase();
      if (byNest.has(key) && !e.errors.some((x) => x.code === 'DUPLICATE_FILE')) e.errors.push({ code: 'DUPLICATE_NEST', message: `${e.filename}: it is nest ${e.nestNo}, and so is ${byNest.get(key).filename}. One file is one plate — give each its own nest number (in the file, in its name, or as nestNo).` });
      else if (!byNest.has(key)) byNest.set(key, e);
      if (ctx.barNos.has(key)) e.errors.push({ code: 'LOT_NAME_TAKEN', message: `${e.filename}: ${e.lotNo} is already the name of a section bar on this line — give the nest another name (nestNo).` });
    }
  }

  // ---- against what is saved: replaced, added, unchanged, removed -------------
  const saved = ctx.saved;
  const imported = saved.filter((l) => l.origin === 'imported');
  const targetOf = (e) => imported.find((l) => l.lotNo.toUpperCase() === e.lotNo?.toUpperCase())
    ?? imported.find((l) => l.sourceFile && l.sourceFile.toLowerCase() === e.filename.toLowerCase())
    ?? null;
  const diff = { added: [], replaced: [], unchanged: [], removed: [], droppedAuto: [], droppedOurs: [], renumbered: [] };
  const replacing = new Map();                      // saved lot id → entry
  for (const e of entries) {
    if (!e.lotNo) continue;
    const t = targetOf(e);
    if (t && replacing.has(t.id)) continue;         // a second file for the same plate: already an error above
    if (t && t.sourceHash && t.sourceHash === e.hash && !e.errors.length) {
      e.action = 'unchanged';
      diff.unchanged.push({ lotId: t.id, lotNo: t.lotNo, filename: e.filename, plateCode: t.plateCode, pieces: t.pieces.length });
      replacing.set(t.id, null);
      continue;
    }
    if (t) {
      e.action = 'replace';
      replacing.set(t.id, e);
      diff.replaced.push({ lotId: t.id, lotNo: t.lotNo, newLotNo: e.lotNo, filename: e.filename, was: { plateCode: t.plateCode, pieces: t.pieces.length, filename: t.sourceFile }, now: { plateCode: e.plate?.code ?? null, pieces: e.placed }, ...changeOf(t, e._lot?.pieces ?? [], codeOf) });
    } else {
      e.action = 'add';
      const twin = imported.find((l) => l.sourceHash && l.sourceHash === e.hash);
      if (twin) e.errors.push({ code: 'DUPLICATE_FILE', message: `${e.filename}: it is the same file nest ${twin.lotNo} was saved from${twin.sourceFile ? ` (${twin.sourceFile})` : ''} — the same plate uploaded twice. If it really is a second plate cut the same way, give it its own nest number in the file.` });
      diff.added.push({ lotNo: e.lotNo, filename: e.filename, plateCode: e.plate?.code ?? null, pieces: e.placed, parts: e.counts });
    }
  }
  const removing = new Map();
  const describe = (l) => ({ lotId: l.id, lotNo: l.lotNo, origin: l.origin, filename: l.sourceFile, plateCode: l.plateCode, pieces: l.pieces.length, parts: tally(l.pieces, codeOf) });
  for (const r of removeAsk) {
    const hit = saved.find((l) => String(l.id) === String(r)) ?? saved.find((l) => l.lotNo.toUpperCase() === String(r).trim().toUpperCase());
    if (!hit) { problems.push({ code: 'REMOVE_UNKNOWN', message: `"${r}" is not a plate saved on this line, so it cannot be removed.` }); continue; }
    if (replacing.get(hit.id)) { problems.push({ code: 'REMOVE_AND_REPLACE', message: `${hit.lotNo} is being replaced by ${replacing.get(hit.id).filename} and removed in the same request — do one or the other.` }); continue; }
    removing.set(hit.id, hit);
  }
  if (mode === 'replace') for (const l of imported) if (!replacing.has(l.id)) removing.set(l.id, l);
  for (const l of removing.values()) diff.removed.push(describe(l));

  // ---- an uploaded nest number an automatic plate already wears: ours moves ---
  const goneIds = new Set([...removing.keys(), ...[...replacing].filter(([, e]) => e).map(([id]) => id)]);
  const newNos = new Set(entries.filter((e) => e.action === 'add' || e.action === 'replace').map((e) => e.lotNo.toUpperCase()));
  const clashing = saved.filter((l) => !goneIds.has(l.id) && l.origin !== 'imported' && newNos.has(l.lotNo.toUpperCase()));
  for (const e of entries) {
    if (e.action !== 'add' && e.action !== 'replace') continue;
    const other = saved.find((l) => !goneIds.has(l.id) && l.origin === 'imported' && l.lotNo.toUpperCase() === e.lotNo.toUpperCase() && replacing.get(l.id) !== e);
    if (other) e.errors.push({ code: 'DUPLICATE_NEST', message: `${e.filename}: nest ${e.lotNo} is already saved from ${other.sourceFile ?? 'another upload'}, and this file was matched to another plate by its name. Give it its own nest number (nestNo).` });
  }

  // ---- coverage: what the customer's files nest, against what the line needs --
  const kept = saved.filter((l) => !goneIds.has(l.id));
  const fresh = entries.filter((e) => (e.action === 'add' || e.action === 'replace') && e._lot);
  const customer = new Map();                       // cutPlateId → pieces the customer's files place
  const whereIs = new Map();                        // cutPlateId → [{ name, qty }]
  const addWhere = (id, nameOf, qty) => { if (!whereIs.has(id)) whereIs.set(id, []); whereIs.get(id).push({ name: nameOf, qty }); };
  for (const l of kept) {
    if (l.origin !== 'imported') continue;
    const m = new Map();
    for (const p of l.pieces) if (isUploadedPiece(l, p)) m.set(p.cutPlateId, (m.get(p.cutPlateId) ?? 0) + 1);
    for (const [id, q] of m) { customer.set(id, (customer.get(id) ?? 0) + q); addWhere(id, `${l.lotNo} (saved)`, q); }
  }
  for (const e of fresh) for (const cnt of e.counts) { customer.set(cnt.cutPlateId, (customer.get(cnt.cutPlateId) ?? 0) + cnt.qty); addWhere(cnt.cutPlateId, e.filename, cnt.qty); }
  const surplus = [];
  for (const [id, got] of customer) {
    const need = ctx.cpById.get(id)?.pieces ?? 0;
    if (got > need) surplus.push({ cutPlateId: id, cutPlateCode: codeOf(id), needed: need, nested: got, surplus: got - need, on: whereIs.get(id) ?? [] });
  }
  for (const s of surplus) {
    const sentence = `${s.cutPlateCode}: the files nest ${s.nested} and the line needs ${s.needed === 0 ? 'none' : `only ${s.needed}`} — ${plural(s.surplus, 'piece', 'pieces')} too many (${s.on.map((o) => `${o.qty} on ${o.name}`).join(', ')}). Take the extra off a file, or save anyway.`;
    warnings.push({ code: 'OVER_COVERAGE', needsForce: true, message: sentence, cutPlateId: s.cutPlateId, cutPlateCode: s.cutPlateCode, surplus: s.surplus });
  }

  // ---- what OUR packer placed, that the upload now makes surplus --------------
  const oursOn = (l) => l.pieces.filter((p) => !isUploadedPiece(l, p));
  const oursCount = new Map();
  for (const l of kept) for (const p of oursOn(l)) oursCount.set(p.cutPlateId, (oursCount.get(p.cutPlateId) ?? 0) + 1);
  const over = new Set();
  for (const [id, n] of oursCount) if (n + (customer.get(id) ?? 0) > (ctx.cpById.get(id)?.pieces ?? 0)) over.add(id);
  const dropLots = new Map();                       // automatic plates that go whole
  const rewrite = new Map();                        // a customer's plate that loses our additions: lot → pieces kept
  if (fresh.length || removing.size || entries.some((e) => e.action === 'replace')) {
    for (const l of kept) {
      const mine = oursOn(l).filter((p) => over.has(p.cutPlateId));
      if (!mine.length) continue;
      if (l.origin !== 'imported') {
        dropLots.set(l.id, l);
        diff.droppedAuto.push({ ...describe(l), because: tally(mine, codeOf).map((x) => x.cutPlateCode) });
      } else {
        rewrite.set(l.id, { lot: l, pieces: l.pieces.filter((p) => isUploadedPiece(l, p) || !over.has(p.cutPlateId)) });
        diff.droppedOurs.push({ lotId: l.id, lotNo: l.lotNo, parts: tally(mine, codeOf) });
      }
    }
  }
  for (const d of diff.replaced) if (d.droppedOurs?.length) diff.droppedOurs.push({ lotId: d.lotId, lotNo: d.lotNo, parts: d.droppedOurs, because: 'the plate is replaced' });

  // ---- the line as it would be after the save ----------------------------------
  const finalLots = [
    ...kept.filter((l) => !dropLots.has(l.id)).map((l) => (rewrite.has(l.id) ? { ...l, pieces: rewrite.get(l.id).pieces } : l)),
    ...fresh.map((e) => ({ id: null, lotNo: e.lotNo, origin: 'imported', layoutOrigin: 'customer', plateItemId: e._lot.plate.id, plateCode: e._lot.plate.code, length: e._lot.lengthMm, width: e._lot.widthMm, pieces: e._lot.pieces })),
  ];
  const { coverage, leftOver } = coverageOfLots(ctx.cutPlates, finalLots, ctx.excl);

  for (const e of entries) { for (const x of e.errors) problems.push(x); if (e.action !== 'unchanged') for (const w of e.warnings) warnings.push(w); e.status = e.errors.length ? 'error' : e.warnings.length ? 'warning' : 'ok'; }
  const changes = fresh.length + removing.size + dropLots.size + rewrite.size;
  const canSave = problems.length === 0 && changes > 0;
  const needsForce = warnings.some((w) => w.needsForce);

  const say = [];
  if (problems.length) say.push(`${plural(problems.length, 'thing needs', 'things need')} fixing before this can be saved`);
  if (entries.length) say.push(`${plural(entries.length, 'file', 'files')} read`);
  const d = diff;
  const parts = [d.added.length && `${d.added.length} added`, d.replaced.length && `${d.replaced.length} replaced`, d.unchanged.length && `${d.unchanged.length} unchanged`, d.removed.length && `${d.removed.length} removed`].filter(Boolean);
  if (parts.length) say.push(`plates: ${parts.join(', ')}`);
  if (d.droppedAuto.length) say.push(`${plural(d.droppedAuto.length, 'automatic plate is', 'automatic plates are')} dropped (its pieces are now in the files)`);
  if (surplus.length) say.push(`${plural(surplus.length, 'cut plate is', 'cut plates are')} nested more often than the line needs`);
  const leftPieces = leftOver.filter((x) => !x.manual && !x.leftOut).reduce((a, x) => a + x.qty, 0);
  if (leftPieces) say.push(`${plural(leftPieces, 'piece is', 'pieces are')} left over — nest the rest afterwards`);

  const out = {
    line: lineHead(ctx.line), dryRun, applied: false, mode, canSave, needsForce, engine: VERIFY_ENGINE,
    files: entries.map(({ _lot, ...e }) => e),
    problems: problems.map((p) => p.message), problemList: problems,
    warnings: warnings.map((w) => w.message), warningList: warnings,
    diff, coverage, leftOver, surplus,
    totals: totalsOfLots(finalLots, leftOver),
    message: `${say.join('; ') || 'Nothing to do'}.`,
  };
  if (dryRun || !canSave) return out;
  if (needsForce && !force) return { ...out, message: `${out.message} Not saved: ${warnings.find((w) => w.needsForce).code === 'OVER_COVERAGE' ? 'a cut plate is nested more often than the line needs' : 'a file has a warning'} — save anyway to keep it.` };
  assertNoRunWorking(companyId, lineId, 'save the files');

  const saved2 = await applyChanges(db, c, lineId, ctx, {
    fresh, removeIds: [...goneIds, ...dropLots.keys(), ...rewrite.keys()], rewrite: [...rewrite.values()], clashing, files, keep: kept.filter((l) => !dropLots.has(l.id) && !rewrite.has(l.id)),
    forced: needsForce,
  });
  diff.renumbered = saved2.renumbered;
  const lotIds = new Map(saved2.written.map((w) => [String(w.lotNo).toUpperCase(), w.id]));
  return {
    ...out, applied: true, forced: needsForce,
    files: out.files.map((e) => ({ ...e, lotId: e.lotNo ? lotIds.get(e.lotNo.toUpperCase()) ?? null : null })),
    saved: { lots: saved2.written.length, pieces: saved2.written.reduce((a, l) => a + l.pieces, 0), offcuts: saved2.written.reduce((a, l) => a + l.offcuts, 0), removedLots: saved2.removed, quantities: saved2.quantities, cuts: saved2.cuts },
    message: `Saved. ${out.message}`,
  };
}

function totalsOfLots(lots, leftOver) {
  const customerLot = (l) => l.origin === 'imported';
  return {
    plates: lots.length,
    uploadedPlates: lots.filter(customerLot).length,
    automaticPlates: lots.filter((l) => !customerLot(l)).length,
    pieces: lots.reduce((a, l) => a + l.pieces.length, 0),
    piecesAddedByUs: lots.filter(customerLot).reduce((a, l) => a + l.pieces.filter((p) => !isUploadedPiece(l, p)).length, 0),
    leftOverPieces: leftOver.reduce((a, x) => a + x.qty, 0),
    leftOverToNest: leftOver.filter((x) => !x.manual && !x.leftOut).reduce((a, x) => a + x.qty, 0),
  };
}

/* ───────────────────────────── writing ───────────────────────────── */

/**
 * What a saved plate is made of, worked out from its pieces as they are now (or from SOME of
 * them: `pieces` — the customer's own, without what we added). For the comparison.
 * ctx: { cpById, shapeOf, settingRows, plates }.
 */
export async function measureSavedLots(pairs, ctx) {
  // The same plate with the same pieces is asked for twice by the comparison (the uploaded side and
  // the whole line): measured once.
  const keyOf = ([lot, pieces]) => `${lot.id}|${pieces.map((q) => q.id ?? `${q.cutPlateId}@${q.x},${q.y}`).join(',')}`;
  const firstOf = new Map();
  const unique = [];
  const at = pairs.map((pair) => { const k = keyOf(pair); if (!firstOf.has(k)) { firstOf.set(k, unique.length); unique.push(pair); } return firstOf.get(k); });
  const lots = await relotMany(unique, ctx);
  return at.map((i) => ({ waste: lots[i].waste, pieces: lots[i].pieces }));
}

/** A lot as replaceAreaFractions reads it: the plate, and each cut plate's steel on it. */
const chargeable = (plate, length, width, pieces) => ({
  plate: { id: plate.id, code: plate.code, steel: { ...plate.steel, length, width } },
  pieces: pieces.map((p) => ({ cutPlateId: p.cutPlateId, area: p.area ?? p.length * p.width })),
});

/**
 * The confirmed save: plates off, files in, plates on, and everything worked out again. A fixed
 * number of statements — the lots, placements and offcuts in bulk (writeLots), one CASE update
 * for the BOM lines, and the cut lengths.
 */
async function applyChanges(db, c, lineId, ctx, { fresh = [], removeIds = [], rewrite = [], clashing = [], files = [], keep = [], forced = false }) {
  const companyId = c.companyId;
  const line = await requireLine(db, companyId, lineId, { lock: true });
  assertNestable(line);
  await assertUnchanged(db, companyId, lineId, ctx.saved);

  // Plates that go: their placements, their offcuts — and the file of one that is not rewritten.
  const rewriteIds = new Set(rewrite.map((r) => r.lot.id));
  const goneFiles = ctx.saved.filter((l) => removeIds.includes(l.id) && !rewriteIds.has(l.id) && l.nestFileId).map((l) => l.nestFileId);
  const removed = removeIds.length ? await clearLots(db, c, lineId, { ids: removeIds, keepFiles: true }) : 0;
  if (goneFiles.length) await db.query('UPDATE cf_nest_files SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND id IN (?) AND deleted_at IS NULL', [companyId, lineId, goneFiles]);

  // An automatic plate wearing a nest number the customer's file wears gets the next free number of ours.
  const renumbered = [];
  if (clashing.length) {
    const taken = new Set([...keep.map((l) => l.lotNo.toUpperCase()), ...fresh.map((e) => e.lotNo.toUpperCase()), ...ctx.barNos]);
    const nos = autoLotNumbers(clashing.length, taken);
    clashing.forEach((l, i) => renumbered.push({ lotId: l.id, from: l.lotNo, to: nos[i] }));
    await db.query(
      `UPDATE cf_plate_lots SET lot_no = CASE id ${renumbered.map(() => 'WHEN ? THEN ?').join(' ')} ELSE lot_no END WHERE company_id = ? AND id IN (?)`,
      [...renumbered.flatMap((r) => [r.lotId, r.to]), companyId, renumbered.map((r) => r.lotId)],
    );
    await db.query(
      `UPDATE cf_offcuts SET offcut_no = CASE plate_lot_id ${renumbered.map(() => 'WHEN ? THEN CONCAT(?, SUBSTRING(offcut_no, ?))').join(' ')} ELSE offcut_no END
        WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL`,
      [...renumbered.flatMap((r) => [r.lotId, r.to, r.from.length + 1]), companyId, renumbered.map((r) => r.lotId)],
    );
    for (const l of keep) { const r = renumbered.find((x) => x.lotId === l.id); if (r) l.lotNo = r.to; }
  }

  // The files themselves, then their ids back by hash.
  const fileOf = new Map(files.map((f) => [f.hash, f]));
  const rows = fresh.map((e) => { const f = fileOf.get(e.hash); return [companyId, lineId, e.filename, 'dxf', e.hash, f.buffer.length, String(e.nestNo).slice(0, 60), f.buffer.toString('latin1'), c.userId ?? null]; });
  let batch = []; let bytes = 0;
  const flush = async () => { if (batch.length) await insertRows(db, 'cf_nest_files', ['company_id', 'order_line_id', 'file_name', 'file_kind', 'file_hash', 'byte_size', 'nest_no', 'file_text', 'created_by'], batch, batch.length); batch = []; bytes = 0; };
  for (const r of rows) { if (bytes + r[5] > FILE_INSERT_BYTES) await flush(); batch.push(r); bytes += r[5]; }
  await flush();
  const idByHash = new Map();
  if (rows.length) {
    const [ids] = await db.query('SELECT id, file_hash FROM cf_nest_files WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND file_hash IN (?) ORDER BY id', [companyId, lineId, fresh.map((e) => e.hash)]);
    for (const r of ids) idByHash.set(r.file_hash, r.id);
  }

  const toWrite = [
    ...fresh.map((e) => {
      const reasons = e.warnings.map((w) => w.message);
      return { ...e._lot, verdict: reasons.length ? 'tight' : 'fits', reasons: reasons.length ? reasons : null, forced: forced && reasons.length > 0, nestFileId: idByHash.get(e.hash) ?? null, waste: { ...e._lot.waste, offcuts: e._lot.waste.offcuts.map((o, i) => ({ ...o, offcutNo: `${e._lot.lotNo}-${offcutLetters(i)}` })) } };
    }),
    ...(await relotMany(rewrite.map((r) => [r.lot, r.pieces]), ctx)),
  ];
  const written = await writeLots(db, c, lineId, toWrite);

  // Everything derived: the plate quantity on each cut plate's BOM line over EVERY live lot (a cut
  // plate on no lot now goes back to its area fraction), then cut length and piercings.
  const plateById = new Map(ctx.plates.map((p) => [p.id, p]));
  const plateOf = (l) => plateById.get(l.plateItemId) ?? { id: l.plateItemId, code: l.plateCode, steel: { thickness: l.thickness, length: l.length, width: l.width } };
  const all = [
    ...keep.map((l) => chargeable(plateOf(l), l.length, l.width, l.pieces)),
    ...toWrite.map((l) => chargeable(l.plate, l.lengthMm ?? l.plate.steel.length, l.widthMm ?? l.plate.steel.width, l.pieces)),
  ];
  const blanks = new Map(ctx.cutPlates.filter((cp) => cp.pieces).map((cp) => [cp.id, cp.pieces]));
  const quantities = await replaceAreaFractions(db, c, ctx.where, all, blanks, { restore: { cutPlates: ctx.cutPlates, plateById } });
  const cuts = await writePlateCuts(db, c, lineId, ctx.cutPlates, { facts: ctx.facts });
  return { written, removed, renumbered, quantities, cuts };
}

/** A nesting run working on the line (in this process): nothing may change the line's plates under it. */
function assertNoRunWorking(companyId, lineId, what) {
  const run = memoryRun(companyId, lineId);
  if (run?.status === 'running') {
    throw invalid('RUN_BUSY', `A nesting run is working on this line${run.purpose === 'compare' ? ' (the comparison with our automatic nesting)' : ''} — it is laying out the line as it is now. Wait for it to finish, then ${what}.`);
  }
}

/**
 * THE LOCK IS TAKEN AFTER THE STATE WAS READ (the request read the line's plates to work out its
 * difference, then applyChanges locks the line), and a plain read inside a transaction keeps
 * seeing the snapshot it started with — on MySQL and on TiDB alike. So two saves of the same line
 * queue on the lock and the second would write a difference worked out against plates the first
 * has just replaced. A LOCKING read sees what is committed now: the line's live plate lots, read
 * once more under the lock, must be the ones this request was worked out from. One round trip.
 */
async function assertUnchanged(db, companyId, lineId, saved) {
  const [rows] = await db.query(
    "SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate' ORDER BY id FOR UPDATE",
    [companyId, lineId],
  );
  const now = rows.map((r) => Number(r.id)).join(',');
  const was = saved.map((l) => Number(l.id)).sort((x, y) => x - y).join(',');
  if (now !== was) throw new CfError(409, 'CHANGED_MEANWHILE', 'The plates on this line changed while this was being worked out — somebody else saved a nesting for it. Nothing was saved: look at the line again, then save again.');
}

/* ───────────────────────────── delete one plate ───────────────────────────── */

/**
 * DELETE …/nesting/lots/:lotId — one plate off the line (an uploaded one or one of ours). Its
 * pieces go back to "left over"; the plate quantities and cut lengths are worked out again.
 */
export async function deleteNestLot(db, c, lineId, lotId) {
  const ctx = await uploadContext(db, c.companyId, lineId);
  const lot = ctx.saved.find((l) => Number(l.id) === Number(lotId));
  if (!lot) throw notFound('Plate lot');
  const blocker = importBlocker(ctx.line);
  if (blocker) throw blocker;
  assertNoRunWorking(c.companyId, lineId, 'take the plate off');
  const keep = ctx.saved.filter((l) => l.id !== lot.id);
  const res = await applyChanges(db, c, lineId, ctx, { removeIds: [lot.id], keep });
  const codeOf = (id) => ctx.cpById.get(id)?.code ?? `#${id}`;
  const { coverage, leftOver } = coverageOfLots(ctx.cutPlates, keep, ctx.excl);
  return {
    line: lineHead(ctx.line), applied: true,
    removed: { lotId: lot.id, lotNo: lot.lotNo, origin: lot.origin, filename: lot.sourceFile, plateCode: lot.plateCode, pieces: lot.pieces.length, parts: tally(lot.pieces, codeOf) },
    coverage, leftOver, totals: totalsOfLots(keep, leftOver),
    saved: { removedLots: res.removed, quantities: res.quantities, cuts: res.cuts },
    message: `${lot.lotNo} is off the line; ${plural(lot.pieces.length, 'piece goes', 'pieces go')} back to be nested.`,
  };
}

/* ───────────────────────────── what is saved ───────────────────────────── */

/** GET …/nesting/files — the plates saved on the line, the files they came from, and what is left over. */
export async function getNestFiles(db, companyId, lineId) {
  const ctx = await importContext(db, companyId, lineId);
  const [saved, excl] = await Promise.all([savedLotsOf(db, companyId, lineId), exclusionsOfLine(db, companyId, lineId)]);
  const fileIds = saved.map((l) => l.nestFileId).filter(Boolean);
  const [files] = fileIds.length ? await db.query('SELECT id, file_name, file_hash, byte_size, nest_no, created_at, created_by FROM cf_nest_files WHERE company_id = ? AND id IN (?)', [companyId, fileIds]) : [[]];
  const fileById = new Map(files.map((f) => [f.id, f]));
  const cpById = new Map(ctx.cutPlates.map((cp) => [cp.id, cp]));
  const codeOf = (id) => cpById.get(id)?.code ?? `#${id}`;
  const { coverage, leftOver } = coverageOfLots(ctx.cutPlates, saved, excl);
  const blocker = importBlocker(ctx.line);
  return {
    line: lineHead(ctx.line),
    canUpload: !blocker, readOnlyReason: blocker?.message ?? null,
    limits: { maxFiles: MAX_NEST_FILES, maxFileBytes: MAX_NEST_FILE_BYTES, kinds: ['dxf'] },
    plates: saved.map((l) => {
      const f = l.nestFileId ? fileById.get(l.nestFileId) : null;
      const customer = l.pieces.filter((p) => isUploadedPiece(l, p));
      const ours = l.pieces.filter((p) => !customer.includes(p));
      return {
        lotId: l.id, lotNo: l.lotNo, origin: l.origin, sourceKind: l.sourceKind, layoutOrigin: l.layoutOrigin,
        plateItemId: l.plateItemId, plateCode: l.plateCode, thickness: l.thickness, grade: l.grade, length: l.length, width: l.width,
        file: f ? { id: f.id, filename: f.file_name, hash: f.file_hash, bytes: Number(f.byte_size), nestNo: f.nest_no, uploadedAt: f.created_at } : null,
        pieces: l.pieces.length, customerPieces: customer.length, ourPieces: ours.length,
        parts: tally(customer, codeOf), addedByUs: tally(ours, codeOf),
        verdict: l.verdict, forced: l.forced, warnings: l.reasons,
      };
    }),
    coverage, leftOver, totals: totalsOfLots(saved, leftOver),
  };
}

/** GET …/nesting/files/:lotId — the customer's file a plate was read from, as it was sent. */
export async function nestFileOf(db, companyId, lineId, lotId) {
  const [[row]] = await db.query(
    `SELECT f.file_name, f.file_text
       FROM cf_plate_lots l JOIN cf_nest_files f ON f.id = l.nest_file_id AND f.company_id = l.company_id
      WHERE l.company_id = ? AND l.order_line_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [companyId, lineId, Number(lotId)],
  );
  if (!row || row.file_text == null) throw notFound('Nesting file');
  return { filename: row.file_name, contentType: 'application/dxf', buffer: Buffer.from(row.file_text, 'latin1') };
}

export const _test = { processFile, prepareFile, uploadContext, resolvePlate, applyChanges, DEFAULT_CUT_SETTINGS };
