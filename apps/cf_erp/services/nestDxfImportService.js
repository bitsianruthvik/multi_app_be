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
 *             grade, nest number, plate size) in the title or the file name. What it cannot take
 *             as drawn is never dropped with only a note (2026-10-13): an outline left open or a
 *             second plate BLOCKS (OPEN_CONTOUR, MULTIPLE_PLATES); anything else that could have
 *             been a part is a WARNING that needs `force` (SHAPE_IGNORED, CURVE_APPROXIMATE,
 *             MARKING_UNSURE, CUTOUTS_FROM_FILE). A file may be read a second time another way —
 *             as inches, or with a line style taken as marking — when only that explains it.
 *   match     matchNest against the line's cut plates. A cut plate answers to its own code, to the
 *             DRAWING MARK and the item code of the rows cut from it; its shape is its drawing
 *             when the line has one for it (partDrawingService.drawingFactsOfLine), else its
 *             rectangle LENGTH × WIDTH. Kerf-compensated outlines (every part oversize by one
 *             offset) are matched at nominal size; parts that could be any of several IDENTICAL
 *             cut plates are shared out by the quantity the line still needs (`by: 'quantity'`).
 *   choose    (2026-10-14) the user may name the cut piece of ANY part (`choices`): it is the
 *             match whatever the ladder said (`by: 'choice'`). The answer carries a PARTS TABLE —
 *             one row per distinct part, what it was matched to and how, and every cut piece of
 *             the line ranked best fit first to choose another from (`partTables`, `rankCutPieces`).
 *   plate    named in the request (`plateCode`), else found by the size the file draws / says,
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
 * PRONEST JOB FILES (2026-10-13). The same upload takes a ProNest job (.nif) beside the DXFs: one
 * file is a whole JOB — every nest of one plate thickness, a nest perhaps cut on N identical
 * plates. lib/nifReader.readNif reads and CHECKS it (a file of another ProNest version, or one that
 * does not agree with itself, is refused whole, in words); `expandJobs` then turns every nest, as
 * many times as it is cut, into "one file = one plate" and the steps below run unchanged — the same
 * answer, the same diff, the same checks. What is different for a ProNest part:
 *   match    its label is the shop's free-text part NAME and it is matched by its OUTLINE alone
 *            (matchNest's longer ladder: label, shape, size, the size in the name);
 *   steel    the job says the thickness and only "MS": the grade is the matched cut pieces'. A cut
 *            piece up to 2 mm THINNER than the plate is taken with a warning (PART_THINNER_THAN_PLATE:
 *            the shop cuts 9 mm packings from 10 mm plate);
 *   shape    the nested outline is what is stored and measured (`shapeFrom: 'nesting file'`), also
 *            when the cut piece has a drawing — it is what will be cut. Marking is never a cut-out;
 *   lots     `<job>-N07` (`-1…-N` when the nest is cut on N plates): uploading the job again
 *            REPLACES its plates, and a plate of it the new upload no longer makes is removed;
 *   file     kept ONCE for all its plates, as base64 (cf_nest_files.file_kind 'pronest').
 *
 * A PLATE THE CATALOG DOES NOT HAVE (2026-10-14). A file or a nest whose plate no catalog item
 * matches still answers PLATE_NOT_FOUND and saves nothing — and the answer now says, structurally,
 * which plates are missing (`missingPlates`: once per thickness × size × grade × impact class, with
 * the code each would get), so the screen can add them (services/nestPlateCatalogService.js, POST
 * …/nesting/plates) and read the files again. The grade and the impact class are the cut pieces'
 * matched on the nest — matching runs BEFORE the plate is looked for, so the vote is there also
 * when the plate is not.
 *
 * ROUND TRIPS (TiDB is ~49 ms each): a fixed number whatever the files hold — the reads are the
 * line, its cut plates, the catalog plates, the drawings and the saved lots; the writes are bulk.
 * The one thing that grows is the file text itself, sent in statements of at most ~8 MB.
 */
import { createHash } from 'node:crypto';
import { invalid, notFound, CfError } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { readNestDxf, matchNest, styleWords, CUT_ALLOWANCE_MAX_MM } from '../lib/nestDxfReader.js';
import { readNif, isNif, nestOfNif } from '../lib/nifReader.js';
import { drawingFactsOfLine } from './partDrawingService.js';
import { writePlateCuts } from './plateCutsService.js';
import {
  importContext, importBlocker, requireLine, assertNestable, pickCutSettings, wasteOfLot, offcutLetters, writeLots, clearLots,
  replaceAreaFractions, autoLotNumbers, agrees, kgOf, lineHead, exclusionsOfLine, DEFAULT_CUT_SETTINGS,
  savedLotsOf, isUploadedPiece, relotMany, wastesOf,
} from './nestingService.js';
import { measurePlates } from './nestMeasure.js';
import { memoryRun } from './nestRunService.js';
import { missingPlatesOf } from './nestPlateCatalogService.js';

export { savedLotsOf, isUploadedPiece };
import {
  shapeOfCutPlate, placeShape, boxOfShape, ringsObject, ringsArea, verifyPlate, isPlainPlacement, normDeg, VERIFY_ENGINE, displayRings, rimOf,
} from './nestShapes.js';

/** A row is one TiDB entry (6 MB at most); the file is stored as text, so 4 MB is the cap. */
export const MAX_NEST_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_NEST_FILES = 200;
/** As stored (utf8mb4): under TiDB's 6 MB entry with room for the row's other columns. */
const MAX_STORED_FILE_BYTES = 5.5 * 1024 * 1024;
/** One request may make at most this many plates (a ProNest job is many plates in one file). */
export const MAX_NEST_PLATES = 600;
/** A ProNest part's cut piece may be this much THINNER than the plate it is nested on (a warning, not a refusal). */
export const THINNER_MAX_MM = 2;
/** A plate lot's number (cf_plate_lots.lot_no). */
const LOT_NO_MAX = 30;
const FILE_INSERT_BYTES = 8 * 1024 * 1024;
const SIZE_TOL = 0.5;

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
const blank = (v) => v == null || String(v).trim() === '';
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const r1 = (n) => Math.round(Number(n) * 10) / 10;
const fmt = (n) => (n == null || !Number.isFinite(Number(n)) ? '?' : String(r3(n)));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const normCode = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
const squash = (s) => normCode(s).replace(/[\s\-_]+/g, '');
const norm = (s) => (blank(s) ? null : String(s).trim().toUpperCase());
const sameSize = (a, b, tol = SIZE_TOL) => Math.abs(Number(a) - Number(b)) <= tol;
const eitherWay = (l, w, L, W) => (sameSize(l, L) && sameSize(w, W)) || (sameSize(l, W) && sameSize(w, L));
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
/**
 * A grade as a file writes it against the catalog's: the same, or the same with the standard in
 * front or a quality suffix behind — "IS 2062 E350 BR" and "E350BR" are the catalog's "E350". Two
 * sub-grades (E350A / E350C) or two strengths (E250 / E350) are not. A word that is only the
 * standard says nothing about the grade, so it disagrees with nothing.
 */
const gradeKey = (s) => squash(s).replace(/^IS2062/, '');
export function sameGrade(a, b) {
  const x = gradeKey(a); const y = gradeKey(b);
  if (!x || !y || x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long.startsWith(short) && !/\d/.test(long.slice(short.length));
}
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
    const out = { index: i, filename, plateCode: blank(f?.plateCode) ? null : String(f.plateCode).trim(), nestNo: blank(f?.nestNo) ? null : String(f.nestNo).trim(), buffer: null, hash: null, problem: null, kind: 'dxf' };
    const body = f?.file ?? f?.content ?? f?.fileBase64;
    try {
      if (f?.text != null && body == null) out.buffer = Buffer.from(String(f.text), 'latin1');
      else if (body == null || body === '') out.problem = { code: 'BAD_FILE', message: 'it carries no file.' };
      else out.buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body).replace(/^data:[^,]*,/, ''), 'base64');
    } catch { out.problem = { code: 'BAD_FILE', message: 'it could not be read — send it as base64.' }; }
    if (out.buffer && !out.buffer.length) out.problem = { code: 'BAD_FILE', message: 'the file is empty.' };
    if (out.buffer && out.buffer.length > MAX_NEST_FILE_BYTES) out.problem = { code: 'FILE_TOO_BIG', message: `it is ${(out.buffer.length / 1048576).toFixed(1)} MB and one nesting file may be at most ${MAX_NEST_FILE_BYTES / 1048576} MB.` };
    // A ProNest job (.nif) is binary and is kept as base64 — a third longer, all ASCII: 4 MB is 5.4 MB stored.
    if (out.buffer && isNif(out.buffer, filename)) out.kind = 'pronest';
    // The text is kept in a utf8mb4 column: every byte above 0x7F is stored as two. A file of
    // accented or binary bytes could pass the 4 MB cap and still overflow TiDB's 6 MB row.
    if (out.buffer && !out.problem && out.kind === 'dxf') {
      let high = 0;
      for (let b = 0; b < out.buffer.length; b += 1) if (out.buffer[b] > 127) high += 1;
      if (out.buffer.length + high > MAX_STORED_FILE_BYTES) out.problem = { code: 'FILE_TOO_BIG', message: `it holds ${high} non-ASCII bytes and would take ${((out.buffer.length + high) / 1048576).toFixed(1)} MB to store — more than one row holds. Export the nest as a plain ASCII DXF.` };
    }
    if (out.buffer && !out.problem) out.hash = createHash('sha256').update(out.buffer).digest('hex');
    return out;
  });
}

/* ───────────────────────────── a ProNest job is many plates ───────────────────────────── */

const pad2 = (n) => String(n).padStart(2, '0');
/** The job a ProNest lot number belongs to: "16MM-NECL-PATNA-N07-2" → "16MM-NECL-PATNA". */
const jobOfLotNo = (lotNo) => /^(.*)-N\d+(?:-\d+)?$/.exec(String(lotNo ?? '').toUpperCase())?.[1] ?? null;

/**
 * Every .nif of the request read (lib/nifReader — pure, checked against itself) and opened into
 * its plates: one entry per nest and per plate it is cut on, each shaped like an uploaded file so
 * prepareFile takes it unchanged. A job that cannot be read stays ONE entry carrying the reason.
 *
 * LOT NUMBERS ARE THE JOB'S: `<job>-N<nest>`, and `-<k>` when the nest is cut on more than one
 * plate — the same job uploaded again lands on the same plates and replaces them. The job is the
 * name ProNest keeps inside the file (a renamed file is still the same job); `nestNo` on the
 * request's file overrides it, for two jobs that carry the same name.
 *
 * → { plates: [file-like], jobs: [{ file, doc | null, error | null, prefix }] }
 */
function expandJobs(files) {
  const plates = []; const jobs = [];
  for (const file of files) {
    if (file.kind !== 'pronest' || file.problem) { plates.push(file); continue; }
    let doc = null;
    try { doc = readNif(file.buffer, { filename: file.filename }); } catch (e) {
      const known = ['BAD_FILE', 'TOO_BIG', 'UNSUPPORTED_VERSION', 'NEST_CHECK_FAILED', 'EMPTY_NEST'].includes(e?.code);
      // The reader names the file itself: the entry's own "<file>: " goes in front of the rest.
      const said = known ? String(e.message).replace(/^"[^"]*" /, 'it ').replace(/^The file /, 'it ') : 'it could not be read as a ProNest job.';
      file.problem = { code: known ? e.code : 'BAD_FILE', message: said, ...(e?.check ? { check: e.check } : {}), ...(e?.program ? { program: e.program, version: e.version, supported: e.supported } : {}) };
      jobs.push({ file, doc: null, error: file.problem, prefix: null });
      plates.push(file);
      continue;
    }
    const total = doc.nests.reduce((a, n) => a + n.quantity, 0);
    if (plates.length + total > MAX_NEST_PLATES) {
      file.problem = { code: 'TOO_BIG', message: `it is ${plural(total, 'plate', 'plates')} (${plural(doc.nests.length, 'nest', 'nests')}, some cut on several plates) and one upload makes at most ${MAX_NEST_PLATES}. Send the jobs in two goes — a second upload adds to the first.` };
      jobs.push({ file, doc, error: file.problem, prefix: null });
      plates.push(file);
      continue;
    }
    const prefixFull = String(file.nestNo ?? doc.jobName ?? stem(file.filename)).replace(/\s+/g, ' ').trim() || 'JOB';
    // Room for "-N07-12" within the lot number: the job's name is cut, never the nest's number.
    const widest = Math.max(...doc.nests.map((n) => `-N${pad2(n.nestNo)}${n.quantity > 1 ? `-${n.quantity}` : ''}`.length));
    const prefix = prefixFull.slice(0, LOT_NO_MAX - widest).trim();
    const job = { file, doc, error: null, prefix, entries: [] };
    jobs.push(job);
    for (const nest of doc.nests) {
      const base = `${prefix}-N${pad2(nest.nestNo)}`;
      const shared = { nest: null, match: null };      // read and matched once for all the plates of the nest
      for (let k = 1; k <= nest.quantity; k += 1) {
        const lotNo = nest.quantity > 1 ? `${base}-${k}` : base;
        plates.push({
          index: plates.length, filename: `${file.filename} nest ${nest.nestNo}`, plateCode: file.plateCode, nestNo: lotNo,
          buffer: file.buffer, hash: createHash('sha256').update(`${file.hash}|nest ${nest.nestNo}|plate ${k}`).digest('hex'), problem: null, kind: 'pronest',
          pronest: { job, doc, nest, shared, sourceFile: file.filename, fileHash: file.hash, prefix, base, copy: k },
        });
      }
    }
  }
  return { plates, jobs };
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
  const impact = vote((s) => norm(s.impactClass));
  /*
   * WHAT IS KNOWN OF A PLATE THE CATALOG DOES NOT HAVE (2026-10-14): its size and thickness from the
   * file, its grade, impact class, material and density from the cut pieces matched on it (the vote
   * above, as the cut pieces write them) — else the grade the file itself states. More than one
   * grade or impact class among the pieces is said (`mixed`); the one most pieces have is taken.
   */
  const asWritten = (key, v) => (v == null ? null : steels.map(key).find((x) => norm(x) === v) ?? null);
  const kinds = (key) => { const n = new Map(); for (const s of steels) { const v = norm(key(s)); if (v != null) n.set(v, (n.get(v) ?? 0) + 1); } return [...n].sort((a, b) => b[1] - a[1]); };
  const missingOf = (size, frame = false) => {
    const hinted = gradeKey(hints.grade) ? String(hints.grade).trim() : null;
    const grades = kinds((s) => s.grade); const impacts = kinds((s) => s.impactClass);
    const said = [];
    if (grades.length > 1) said.push(`The cut pieces on it are of ${plural(grades.length, 'grade', 'grades')} (${grades.map(([g, n]) => `${g} × ${n}`).join(', ')}): the plate is taken as ${grades[0][0]}.`);
    if (impacts.length > 1) said.push(`The cut pieces on it are of ${plural(impacts.length, 'impact class', 'impact classes')} (${impacts.map(([g, n]) => `${g} × ${n}`).join(', ')}): the plate is taken as ${impacts[0][0]}.`);
    return {
      thickness: thickness ?? null, length: Math.max(size.length, size.width), width: Math.min(size.length, size.width),
      grade: asWritten((s) => s.grade, grade) ?? hinted, impactClass: asWritten((s) => s.impactClass, impact),
      material: asWritten((s) => s.material, material), density: vote((s) => (s.density > 0 ? r3(s.density) : null)),
      ...(said.length ? { mixed: said.join(' ') } : {}), ...(frame ? { frame: true } : {}),
    };
  };
  const ADD_IT = 'It can be added to the catalog from here (Add to the catalog)';

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
  if (!hits.length) {
    // The rectangle taken as the plate holds ONE rectangle that holds everything else: perhaps a frame round the real plate.
    const inner = drawn && nest.plate.inside ? ` (That rectangle holds one other, ${fmt(nest.plate.inside.length)} × ${fmt(nest.plate.inside.width)}, with everything else inside it — if the outer one is a drawing frame, the plate is that, and no catalog plate is that size either.)` : '';
    return { error: { code: 'PLATE_NOT_FOUND', message: `no catalog plate is ${sizeWords}.${inner} ${ADD_IT}, or name the plate you mean (plateCode).`, missing: missingOf(size, !!inner) } };
  }
  if (thickness != null) {
    const t = hits.filter((p) => Math.abs(p.steel.thickness - thickness) <= 0.01);
    if (!t.length) {
      return { error: { code: 'PLATE_NOT_FOUND', message: `no catalog plate is ${fmt(thickness)} mm × ${sizeWords} — that size is in the catalog only at ${list([...new Set(hits.map((p) => fmt(p.steel.thickness)))])} mm. ${ADD_IT}, or name the plate you mean (plateCode).`, missing: missingOf(size) } };
    }
    hits = t;
  }
  if (hits.length > 1) {
    const hintGrade = gradeKey(hints.grade) ? norm(hints.grade) : null;   // "IS 2062" alone names no grade
    const exact = hits.filter((p) => norm(p.steel.grade) === (hintGrade ?? grade) && (material == null || norm(p.steel.material) === material));
    // The file's grade written in full (E350BR, IS 2062 E350 BR) is the catalog's E350.
    const same = exact.length || !hintGrade ? [] : hits.filter((p) => p.steel.grade != null && sameGrade(p.steel.grade, hintGrade) && (material == null || norm(p.steel.material) === material));
    const loose = hits.filter((p) => agrees(p.steel.grade, hintGrade ?? grade) && agrees(p.steel.material, material));
    hits = exact.length ? exact : same.length ? same : loose.length ? loose : hits;
  }
  // Still two or more: plates of one size, thickness and grade that differ by impact class (E350 BO / E350 BR).
  // The cut pieces on the nest say which — the plate of THEIR impact class (user, 2026-10-14: "it should pick
  // that info from the cut piece"). Only when exactly that narrows it; a nest of mixed classes still asks.
  let byImpact = false;
  if (hits.length > 1 && impact != null) {
    const same = hits.filter((p) => norm(p.steel.impactClass) === impact);
    const mixed = new Set(steels.map((s) => norm(s.impactClass)).filter((v) => v != null)).size > 1;
    if (same.length >= 1 && same.length < hits.length && !mixed) { hits = same; byImpact = true; }
  }
  if (hits.length > 1) {
    return { error: { code: 'PLATE_AMBIGUOUS', message: `${sizeWords}${thickness != null ? ` at ${fmt(thickness)} mm` : ''} is ${plural(hits.length, 'catalog plate', 'catalog plates')} (${hits.map((p) => `${p.code}${p.steel.grade ? ` ${p.steel.grade}` : ''}`).join(', ')}) — name the one you mean (plateCode).`, choices: hits.map((p) => p.code) } };
  }
  return { plate: hits[0], by: 'size', ...(byImpact ? { byImpactClass: steels.find((s) => s.impactClass != null)?.impactClass ?? null } : {}) };
}

/** A catalog plate by its code (exactly, else ignoring spaces, dashes and underscores). */
const plateByCode = (ctx, code) => ctx.plates.find((p) => normCode(p.code) === normCode(code)) ?? ctx.plates.find((p) => squash(p.code) === squash(code)) ?? null;

/** Corners in a set of rings. */
const cornersOf = (o) => o.outline.length + o.cutouts.reduce((a, r) => a + r.length, 0) + o.holes.reduce((a, r) => a + r.length, 0);
/** A stored outline may hold at most this many corners (cf_nest_placements.rings_json; a row stays far under TiDB's 6 MB). */
export const MAX_FILE_RING_CORNERS = 2000;

/**
 * Reads, matches, places and checks ONE file — IN FOUR STEPS, because one of the things it needs
 * is known only when EVERY file of the request has been read, and two are exact polygon work that
 * must not hold the server's thread (services/nestMeasure.js):
 *
 *   prepareFile(file, ctx, choices) → { entry, sure, share, verifyArgs, verified, measured }
 *     reads the DXF, matches its parts, finds the plate. `sure` is what it placed for certain
 *     (by label, shape, size, steel, or the user's choice);
 *   share(left)
 *     shares out the parts that could be any of several IDENTICAL cut plates, by what the line
 *     still needs of each (`left`: Map cutPlateId → pieces not yet nested, over the whole
 *     request — see quotaOf). Then sets `verifyArgs` (or leaves it null): what
 *     nestShapes.verifyPlate is asked about the layout;
 *   verified(check) → [lot, pieces] | null
 *     takes that answer, says the overlaps / the edge / the kerf, builds what a save stores, and
 *     hands back what nestingService.wasteOfLot is asked about the plate (or null);
 *   measured(waste)
 *     takes that answer: the file's metrics and `entry._lot`, what a save writes.
 *
 * uploadNestFiles runs the steps for every file with the two measurements made together, off this
 * thread; `processFile` runs them in place (tests, one file).
 * Pure but for what `ctx` already holds. `entry` is the file's entry in the answer.
 */
function prepareFile(file, ctx, choices) {
  const entry = {
    filename: file.filename, bytes: file.buffer?.length ?? 0, hash: file.hash, nestNo: null, lotNo: null,
    status: 'ok', action: null, units: null, plate: null, parts: 0, placed: 0,
    placements: [], counts: [], errors: [], warnings: [], notes: [], metrics: null,
    // Where it came from: a DXF is its own file; a plate of a ProNest job says its job and its nest.
    sourceFile: file.pronest?.sourceFile ?? file.filename, sourceKind: file.kind === 'pronest' ? 'pronest' : 'dxf',
  };
  const nif = file.pronest ?? null;
  if (nif) {
    Object.assign(entry, { jobName: nif.doc.jobName ?? null, program: nif.doc.program, version: nif.doc.version, jobNestNo: nif.nest.nestNo, jobNests: nif.doc.nests.length, nestQuantity: nif.nest.quantity, copy: nif.copy });
    entry._nif = { fileIndex: nif.job.file.index, nestNo: nif.nest.nestNo, copy: nif.copy, prefix: nif.prefix, fileHash: nif.fileHash };
  } else if (file.kind === 'pronest') {
    entry._nif = { fileIndex: file.index, failed: true };
  }
  const done = { entry, sure: [], share: () => {}, verifyArgs: null, verified: () => null, measured: () => {} };
  const name = () => (entry.plate?.code ? `plate ${entry.plate.code}` : entry.nestNo ? `nest ${entry.nestNo}` : 'its plate');
  const err = (code, message, extra = {}) => entry.errors.push({ code, message: `${file.filename}: ${message}`, ...extra });
  // A ProNest nest holds the SAME part many times (132 stiffeners): what is wrong with one is wrong
  // with all of them, and is said once — the first piece named, the others counted (`partIds`, `count`).
  const said = new Map();
  const partErr = (code, part, message, extra = {}) => {
    const text = `${file.filename}, ${name()}, part ${part.id}${part.labels?.length ? ` ("${part.labels[0]}")` : ''} at ${at(part.bbox)}: ${message}`;
    if (!nif) { entry.errors.push({ code, partId: part.id, partKey: keyOfPart(part), message: text, ...extra }); return; }
    const key = `${code}|${part.partName}|${message}`;
    const first = said.get(key);
    if (first) {
      first.error.count += 1; first.error.partIds.push(part.id);
      first.error.message = `${first.text} The same goes for ${plural(first.error.count - 1, 'more piece', 'more pieces')} of this part on the nest.`;
      return;
    }
    const error = { code, partId: part.id, partName: part.partName ?? null, partKey: keyOfPart(part), partIds: [part.id], count: 1, message: text, ...extra };
    said.set(key, { error, text });
    entry.errors.push(error);
  };
  const warn = (code, message, extra = {}) => entry.warnings.push({ code, needsForce: true, message: `${file.filename}, ${name()}: ${message}`, ...extra });
  const settle = () => { entry.status = entry.errors.length ? 'error' : entry.warnings.length ? 'warning' : 'ok'; };

  if (file.problem) { const { code, message, ...rest } = file.problem; err(code, message, rest); settle(); return done; }

  // A plate named in the request is known before the file is read: its size tells the reader that
  // a block of parts cut edge to edge and filling that size IS the plate (lib/nestDxfReader `plateSize`).
  // Every catalog plate's size goes too (`plateSizes`): a rectangle of one of those sizes inside a
  // bigger one is the plate inside a drawing frame.
  const named = file.plateCode ? plateByCode(ctx, file.plateCode) : null;
  const sizeOfNamed = named?.steel?.length > 0 && named?.steel?.width > 0 ? { length: named.steel.length, width: named.steel.width } : null;
  const reading = {};
  // A plate of a ProNest job is already read (expandJobs): its nest in the form a DXF plate has, made
  // and matched ONCE for all the plates the nest is cut on. Its parts are true outlines: no kerf offset.
  const read = (extra = {}) => (nif
    ? (nif.shared.nest ??= nestOfNif(nif.doc, nif.nest))
    : readNestDxf(file.buffer, { filename: file.filename, plateSizes: ctx.plateSizes, ...(sizeOfNamed ? { plateSize: sizeOfNamed } : {}), ...reading, ...extra }));
  // The job states its thickness: a cut piece of it — or up to 2 mm thinner — is what its parts are looked for among first.
  const cutFromJob = (key) => { const d = Number(nif.nest.plate.thickness) - ctx.cpByKey.get(key).steel.thickness; return d >= -0.0005 && d <= THINNER_MAX_MM + 0.0005; };
  const match = (n) => (nif
    ? (nif.shared.match ??= matchNest(n, ctx.candidates, { toleranceMm: 0.5, kerfOffsetMaxMm: 0, prefer: cutFromJob }))
    : matchNest(n, ctx.candidates, { toleranceMm: 0.5 }));
  let nest;
  try { nest = read(); } catch (e) {
    err(e?.code && ['BAD_FILE', 'EMPTY_NEST', 'TOO_BIG'].includes(e.code) ? e.code : 'BAD_FILE', e?.message ?? 'it could not be read as a DXF drawing.');
    settle();
    return done;
  }

  // ---- which cut plate each part is ----------------------------------------
  let m = match(nest);
  /*
   * ANOTHER READING OF THE SAME FILE, taken only when it explains the file and the first does not.
   * The reader cannot know two things the cut plates can settle:
   *   - INCHES with no units in the header: nothing is the size of a cut plate as millimetres, and
   *     every part is one at × 25.4;
   *   - a MARKING LINE from edge to edge of a part, on the cut layer in another colour (or on a
   *     layer of its own): read as a cut it splits the part into two shapes that are nobody's;
   *     read as marking, every part is a cut plate.
   * At most two more reads of the file, in memory — no round trip.
   */
  const lost = (x) => x.unmatched.filter((u) => !u.maybeScrap).length;
  const found = (x) => x.placements.length + x.ambiguous.length;
  const secondReading = [];
  const tryReading = (extra, better) => {
    try {
      const n2 = read(extra); const m2 = match(n2);
      if (!better(m2)) return false;
      nest = n2; m = m2; Object.assign(reading, extra);
      return true;
    } catch { return false; }
  };
  if (!nest.unitsStated && nest.parts.length && !found(m)) {
    if (tryReading({ units: 'in' }, (m2) => found(m2) > 0 && !lost(m2))) secondReading.push('The file does not say its units. Read as millimetres nothing in it is the size of a cut plate; read as inches every part is one — so it was read as drawn in inches.');
  }
  if (lost(m) && nest.splitStyles?.length) {
    const styles = nest.splitStyles;
    if (tryReading({ markingStyles: styles }, (m2) => found(m2) > 0 && !lost(m2))) secondReading.push(`Lines drawn in ${list(styles.map(styleWords))} run from edge to edge of parts. Read as cuts they split a part into shapes that are no cut plate; read as marking every part is one — so they were read as marking, not as cuts.`);
  }
  entry.units = nest.units;
  entry.parts = nest.parts.length;
  entry.nestNo = file.nestNo ?? nest.hints?.nestNo ?? stem(file.filename);
  entry.lotNo = String(entry.nestNo).slice(0, 30);
  for (const w of nest.warnings ?? []) entry.notes.push(w);
  for (const s of secondReading) entry.notes.push(s);
  if (nif && nif.nest.quantity > 1) entry.notes.push(`ProNest cuts this nest on ${nif.nest.quantity} identical plates: it is ${nif.nest.quantity} plates here (${nif.base}-1 … ${nif.base}-${nif.nest.quantity}), this one plate ${nif.copy}.`);
  // What the reader could not take as it is drawn: an outline left open, more than one plate.
  for (const { code, message, ...rest } of nest.problems ?? []) err(code, message, rest);

  /*
   * KERF-COMPENSATED OUTLINES (matchNest `kerfOffsetMm`): every part is drawn that much outside its
   * true edge, all of them alike. They were matched at their nominal size, and from here on the
   * part IS its nominal outline — what is checked, measured and stored. One note says so.
   */
  if (m.kerfOffsetMm) {
    for (const p of nest.parts) {
      const n = m.nominal?.get(p.id);
      if (!n) continue;
      p.rings = n.full;
      if (n.bare) p.ringsNoMarks = n.bare;
      p.bbox = boxOfShape(n.full);
    }
    entry.kerfOffsetMm = m.kerfOffsetMm;
    entry.notes.push(`The parts are drawn ${fmt(m.kerfOffsetMm)} mm oversize on every side — kerf compensation: the file is the path of the torch, not the parts — and were matched to their nominal size. They are stored at their nominal size, where the file has them.`);
  }

  const partById = new Map(nest.parts.map((p) => [p.id, p]));
  /*
   * THE ROW A PART BELONGS TO in the parts table of the answer (2026-10-14): a ProNest part is its
   * name in the job; a DXF part is its size and its label, on its thickness (see partTables).
   */
  const rankThickness = nif ? Number(nif.nest.plate.thickness) : nest.hints?.thicknessMm ?? null;
  const sizeOfPart = (part) => {
    const own = nif && part.drawnSize ? part.drawnSize : m.facts?.get(part.id)?.size ?? [part.bbox?.length ?? 0, part.bbox?.width ?? 0];
    return [r1(Math.max(own[0], own[1])), r1(Math.min(own[0], own[1]))];
  };
  function keyOfPart(part) {
    if (!part) return null;
    if (nif) return part.partName ?? part.id;
    const [a, b] = sizeOfPart(part);
    return `${a} x ${b}${part.labels?.length ? ` | ${part.labels[0]}` : ''}`;
  }
  /*
   * A PART LYING ACROSS THE PLATE'S EDGE (`outsidePlate`, the reader's own finding) is a part
   * hanging off the plate: it is said (OUTSIDE_PLATE, which blocks the save) and it is NOT nested
   * — not placed, not counted, not checked against its neighbours. A reader that does not set the
   * flag simply never reports one here; the geometry check below then says the same thing.
   */
  const across = new Set(nest.parts.filter((p) => p.outsidePlate).map((p) => p.id));
  const matchedKey = new Map(m.placements.map((pl) => [pl.partId, pl.candidateKey]));

  /*
   * THE USER'S OWN CHOICE OF CUT PIECE (2026-10-14) — for ANY part: one the ladder matched, one that
   * could be several, one that matched nothing. The cut piece chosen is taken as the match whatever
   * the ladder said (`by: 'choice'`, `chosen`), laid where the part is drawn (matchNest `placeAs`);
   * everything after this — the plate, the steel, the overlaps, the coverage — reads it as any other
   * match, so a cut piece of the wrong thickness still blocks. A ProNest job may be answered once for
   * the whole job, and by the part's NAME — every piece of that part, on every nest; an answer for
   * one piece (its part id) beats the answer for its name.
   */
  const jobWide = nif ? { ...(choices?.[stem(nif.sourceFile)] ?? {}), ...(choices?.[nif.sourceFile] ?? {}) } : {};
  const ownChoices = nif ? choices?.[file.filename] ?? {} : choices?.[file.filename] ?? choices?.[stem(file.filename)] ?? {};
  const chosen = { ...jobWide, ...ownChoices };
  const choiceFor = (part) => { const v = chosen[part.id] ?? (nif && part.partName != null ? chosen[part.partName] : undefined); return blank(v) ? null : v; };
  const keyOfChoice = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (ctx.cpByKey.has(s)) return s;
    if (/^\d+$/.test(s) && ctx.cpByKey.has(`cp${s}`)) return `cp${s}`;
    const cp = ctx.cutPlates.find((c) => normCode(c.code) === normCode(s));
    return cp && ctx.cpByKey.has(`cp${cp.id}`) ? `cp${cp.id}` : null;
  };
  const decided = new Set();      // parts the user answered for: the ladder's own answer no longer counts
  const refused = [];             // { part, asked } — said (CHOICE_INVALID) once the plate has its name
  const placed = [];
  for (const part of nest.parts) {
    if (across.has(part.id)) continue;              // hanging off the plate: which cut piece it is no longer matters
    const asked = choiceFor(part);
    if (asked == null) continue;
    decided.add(part.id);
    const want = keyOfChoice(asked);
    const made = want ? m.placeAs(part, want) : null;
    if (!made) { refused.push({ part, asked }); continue; }
    placed.push({ ...made, by: 'choice', chosen: true, part, cp: ctx.cpByKey.get(want) });
  }
  // A choice for something the file does not hold is said, not dropped (a job-wide one: uploadNestFiles, once for the job).
  const strangers = Object.keys(ownChoices).filter((key) => !blank(ownChoices[key]) && !partById.has(key) && !(nif && nest.parts.some((p) => p.partName === key)));
  for (const pl of m.placements) if (!across.has(pl.partId) && !decided.has(pl.partId)) placed.push({ ...pl, part: partById.get(pl.partId), cp: ctx.cpByKey.get(pl.candidateKey) });

  // ---- the plate -----------------------------------------------------------
  // Parts that could be any of several cut plates of ONE steel say as much about the plate's steel as a part that is settled.
  const oneSteel = (keys) => { const a = ctx.cpByKey.get(keys[0]).steel; return keys.every((key) => { const s = ctx.cpByKey.get(key).steel; return Math.abs(s.thickness - a.thickness) <= 0.0005 && norm(s.grade) === norm(a.grade) && norm(s.material) === norm(a.material); }); };
  // (A part whose choice was refused still says what the ladder made of it: the plate must not go unnamed because of a bad choice.)
  const given = new Set(placed.filter((pl) => pl.chosen).map((pl) => pl.partId));
  const unheeded = new Set(refused.map((r) => r.part.id));
  const alike = m.ambiguous.filter((a) => !across.has(a.partId) && !given.has(a.partId) && oneSteel(a.candidateKeys)).map((a) => ({ cp: ctx.cpByKey.get(a.candidateKeys[0]) }));
  const laddered = m.placements.filter((pl) => unheeded.has(pl.partId)).map((pl) => ({ cp: ctx.cpByKey.get(pl.candidateKey) }));
  const res = resolvePlate({ file, nest, placed: [...placed, ...alike, ...laddered], ctx });
  if (res.error) err(res.error.code, res.error.message, res.error.choices ? { choices: res.error.choices } : {});
  // A plate the catalog does not have: what is known of it stays on the entry for the answer's `missingPlates`.
  if (res.error?.missing) entry._missing = res.error.missing;
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
      err('PLATE_WRONG_THICKNESS', `the ${nest.hints.from?.thicknessMm === 'file name' ? 'file name' : 'file'} says ${fmt(nest.hints.thicknessMm)} mm and ${plate.code} is ${fmt(P.thickness)} mm.`);
    }
    if (nest.hints?.grade && P.grade && !sameGrade(nest.hints.grade, P.grade)) {
      err('PLATE_WRONG_GRADE', `the file says ${nest.hints.grade} and ${plate.code} is ${P.grade}.`);
    }
  }
  const settings = pickCutSettings(ctx.settingRows, plate?.steel.thickness ?? nest.hints?.thicknessMm ?? placed[0]?.cp.steel.thickness ?? null);
  const k = Number(settings.kerfMm) || 0;
  // A file that does not draw its plate measures from the corner of its parts: they are put one
  // kerf in from the plate's corner (when there is room), and the answer says by how much.
  let dx = 0; let dy = 0;
  if (!drawn && plate && nest.plate.length + 2 * k <= lotL + 1e-6 && nest.plate.width + 2 * k <= lotW + 1e-6) { dx = k; dy = k; }
  if (plate && res.byImpactClass) entry.notes.push(`${plate.code} was chosen among plates of this size, thickness and grade because the cut pieces on the nest are ${res.byImpactClass}.`);
  entry.plate = plate
    ? { itemId: plate.id, code: plate.code, name: plate.name ?? null, thickness: plate.steel.thickness, grade: plate.steel.grade ?? null, material: plate.steel.material ?? null, length: lotL, width: lotW, drawn, resolvedBy: res.by, offset: [dx, dy], kerfMm: k }
    : { itemId: null, code: null, length: lotL, width: lotW, drawn, resolvedBy: null, offset: [0, 0], kerfMm: k };

  /*
   * NOTHING THAT COULD HAVE BEEN A PART IS DROPPED WITH ONLY A NOTE (2026-10-13). What the reader
   * could not read as it should — a curve given by control points, a block the file does not
   * define, a filled area, a run of lines that does not close — is a WARNING that needs "save
   * anyway". So is a closed shape drawn OUTSIDE the plate: when it is one of this line's cut plates
   * the warning names it; inside a drawing frame, and nobody's shape, it is the sheet's own
   * furniture (a title block) and stays the reader's note.
   */
  for (const { code, message, ...rest } of nest.cautions ?? []) warn(code, message, rest);
  if (nest.outside?.length) {
    const beside = nest.outside.map((o, i) => ({ id: `O${i + 1}`, rings: o.rings, bbox: o.bbox, labels: o.labels ?? [], labelFrom: o.labels?.length ? 'inside' : null, inFrame: o.inFrame }));
    const om = matchNest({ parts: beside }, ctx.candidates, { toleranceMm: 0.5, kerfOffsetMaxMm: 0 });
    const ours = new Map([...om.placements.map((pl) => [pl.partId, [pl.candidateKey]]), ...om.ambiguous.map((a) => [a.partId, a.candidateKeys])]);
    const mine = beside.filter((o) => ours.has(o.id));
    const others = beside.filter((o) => !ours.has(o.id) && !o.inFrame);
    if (mine.length) {
      const words = mine.slice(0, 3).map((o) => `${ours.get(o.id).map((key) => ctx.cpByKey.get(key).code).join(' or ')} at ${at(o.bbox)}`);
      warn('SHAPE_IGNORED', `${plural(mine.length, 'shape', 'shapes')} drawn OUTSIDE the plate ${mine.length === 1 ? 'is one of this line\'s cut plates' : 'are this line\'s cut plates'} (${words.join(', ')}${mine.length > 3 ? ', …' : ''}) and ${mine.length === 1 ? 'is' : 'are'} not nested — only what is on the plate is read. Move ${mine.length === 1 ? 'it' : 'them'} onto the plate in the nesting program, or save anyway without ${mine.length === 1 ? 'it' : 'them'}.`, { shapes: mine.map((o) => o.bbox) });
    }
    if (others.length) {
      warn('SHAPE_IGNORED', `${plural(others.length, 'closed shape', 'closed shapes')} drawn outside the plate ${others.length === 1 ? 'is' : 'are'} not read as ${others.length === 1 ? 'a part' : 'parts'} (the first ${fmt(others[0].bbox.length)} × ${fmt(others[0].bbox.width)} at ${at(others[0].bbox)}). If ${others.length === 1 ? 'it is a part' : 'one is a part'}, move it onto the plate in the nesting program — or save anyway.`, { shapes: others.map((o) => o.bbox) });
    }
  }

  // ---- parts hanging off the plate -------------------------------------------
  for (const id of across) {
    const part = partById.get(id);
    const cp = matchedKey.has(id) ? ctx.cpByKey.get(matchedKey.get(id)) : null;
    entry.errors.push({
      code: 'OUTSIDE_PLATE', partId: id, ...(cp ? { cutPlateId: cp.id, cutPlateCode: cp.code } : {}),
      message: `${file.filename}, ${name()}: ${cp ? cp.code : `a part${part.labels?.length ? ` ("${part.labels[0]}")` : ''}`} at ${at(part.bbox)}, ${fmt(part.bbox.length)} × ${fmt(part.bbox.width)}, runs off the plate${Number(part.outsideMm) > 0 ? ` by ${fmt(part.outsideMm)} mm` : ''}, which is ${fmt(lotL)} × ${fmt(lotW)}. It is not counted as nested.`,
    });
  }

  // ---- a choice that names no cut piece of the line, or no part of the file ----
  for (const { part, asked } of refused) partErr('CHOICE_INVALID', part, `"${asked}" was chosen for it, but that is not one of this line's cut pieces.`);
  if (strangers.length && (!nif || nif.copy === 1)) {
    err('CHOICE_INVALID', `a cut piece was chosen for ${list(strangers.slice(0, 5).map((key) => `"${key}"`))}${strangers.length > 5 ? ` and ${strangers.length - 5} more` : ''}, but ${strangers.length === 1 ? 'that is not a part' : 'those are not parts'} of this ${nif ? 'nest' : 'file'}. Nothing was done with ${strangers.length === 1 ? 'it' : 'them'} — take the choice away, or choose again.`, { parts: strangers });
  }

  // ---- parts that could be more than one cut plate --------------------------
  const steelFits = (cp) => !plate || (Math.abs(cp.steel.thickness - plate.steel.thickness) <= 0.0005 && agrees(plate.steel.grade, cp.steel.grade) && agrees(plate.steel.material, cp.steel.material));
  // How much THINNER than the plate a cut piece is (ProNest only): 0 = the same, null = thicker, or thinner by more than is taken.
  const thinnerBy = (cp) => { if (!plate) return 0; const d = plate.steel.thickness - cp.steel.thickness; return Math.abs(d) <= 0.0005 ? 0 : (nif && d > 0 && d <= THINNER_MAX_MM + 0.0005 ? d : null); };
  /**
   * Of the cut pieces a ProNest part could be, the ones whose steel fits its plate — in this order:
   * the thickness its NAME states ("9MM-…" on a 10 mm job), the plate's own thickness, then one up
   * to 2 mm thinner. (A DXF part: the plate's own steel, as before.)
   */
  const fitting = (keys, part) => {
    if (!nif || !plate) return keys.filter((key) => steelFits(ctx.cpByKey.get(key)));
    const ok = keys.filter((key) => { const cp = ctx.cpByKey.get(key); return thinnerBy(cp) != null && agrees(plate.steel.grade, cp.steel.grade) && agrees(plate.steel.material, cp.steel.material); });
    const named = part?.nameThickness != null ? ok.filter((key) => Math.abs(ctx.cpByKey.get(key).steel.thickness - part.nameThickness) <= 0.01) : [];
    const exact = ok.filter((key) => thinnerBy(ctx.cpByKey.get(key)) === 0);
    return named.length ? named : exact.length ? exact : ok;
  };
  const optionsOf = (keys) => keys.map((key) => { const cp = ctx.cpByKey.get(key); return { key, cutPlateId: cp.id, code: cp.code, thickness: cp.steel.thickness, grade: cp.steel.grade ?? null }; });
  const pending = [];           // still open after the user's choices and the plate's steel: { a, part, keys }
  for (const a of m.ambiguous) {
    if (across.has(a.partId)) continue;               // said above; which cut plate it is no longer matters
    if (decided.has(a.partId)) continue;              // the user said which
    const part = partById.get(a.partId);
    const fit = fitting(a.candidateKeys, part);
    if (!(plate && fit.length === 1)) { pending.push({ a, part, keys: plate && fit.length ? fit : a.candidateKeys }); continue; }
    const opt = a.options.find((o) => o.candidateKey === fit[0]);
    placed.push({ ...opt, by: 'steel', part, cp: ctx.cpByKey.get(fit[0]) });
  }
  done.sure = placed.slice();

  done.share = (left = null) => {
    /*
     * IDENTICAL CUT PLATES, NO LABEL (2026-10-13). A part that could be any of several cut plates
     * of the SAME shape, thickness, grade and material is physically the same piece of steel
     * whichever it is called — in a bridge that is the rule (left / right, span 1 / span 2). Such
     * parts are SHARED OUT by what the line still needs of each cut plate, in a fixed order (parts
     * as the file has them, cut plates by code): `by: 'quantity'`, with the others it could have
     * been in `alternatives`, and one note. A part stays PART_AMBIGUOUS only when its candidates
     * differ in steel, or the line needs no more of any of them (one more would over-fill).
     * The user's own `choices` were settled above and always win.
     */
    const shared = new Map();     // the codes it was shared between → how many parts
    for (const { a, part, keys } of pending) {
      const order = keys.slice().sort((p, q) => String(ctx.cpByKey.get(p).code).localeCompare(String(ctx.cpByKey.get(q).code), undefined, { numeric: true }) || ctx.cpByKey.get(p).id - ctx.cpByKey.get(q).id);
      const same = left && order.length > 1 && oneSteel(order);
      const pick = same ? order.find((key) => (left.get(ctx.cpByKey.get(key).id) ?? 0) > 0) ?? null : null;
      if (!pick) {
        const options = optionsOf(a.candidateKeys);
        const full = same ? ` The line needs no more of ${order.length === 2 ? 'either' : 'any of them'} — the files already nest every piece of each — so one more cannot be shared out.` : '';
        partErr('PART_AMBIGUOUS', part, `it could be ${list(options.map((o) => `${o.code} (${steelWords(o)})`))} — they are the same shape.${full} Say which (choices), or label the part in the file.`, { choices: options });
        continue;
      }
      const cp = ctx.cpByKey.get(pick);
      left.set(cp.id, (left.get(cp.id) ?? 0) - 1);
      const opt = a.options.find((o) => o.candidateKey === pick);
      placed.push({ ...opt, by: 'quantity', part, cp, alternatives: order.filter((key) => key !== pick).map((key) => ({ key, cutPlateId: ctx.cpByKey.get(key).id, code: ctx.cpByKey.get(key).code })) });
      const codes = order.map((key) => ctx.cpByKey.get(key).code).join('|');
      shared.set(codes, (shared.get(codes) ?? 0) + 1);
    }
    if (shared.size) {
      const total = [...shared.values()].reduce((x, y) => x + y, 0);
      entry.notes.push(`${plural(total, 'unlabelled part', 'unlabelled parts')} that could each be any of several identical cut plates ${total === 1 ? 'was' : 'were'} shared out by the quantity the line still needs of each: ${[...shared].map(([codes, n]) => `${n} between ${list(codes.split('|'))}`).join('; ')}. They are the same shape, thickness and grade, so the steel is the same either way — choose by hand (choices) if it matters which is which.`);
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
      if (across.has(u.partId) || decided.has(u.partId)) continue;
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
      const thinner = new Map();                      // cut plate id → { cp, parts } — ProNest: a piece cut from the next plate up
      for (const pl of placed) {
        const s = pl.cp.steel;
        const by = thinnerBy(pl.cp);
        if (by != null && by > 0 && agrees(plate.steel.grade, s.grade) && agrees(plate.steel.material, s.material)) {
          if (!thinner.has(pl.cp.id)) thinner.set(pl.cp.id, { cp: pl.cp, parts: [] });
          thinner.get(pl.cp.id).parts.push(pl.partId);
        } else if (Math.abs(s.thickness - plate.steel.thickness) > 0.0005) partErr('PART_WRONG_THICKNESS', pl.part, `${pl.cp.code} is ${fmt(s.thickness)} mm and ${plate.code} is ${fmt(plate.steel.thickness)} mm, so it cannot be cut from it.`, { cutPlateCode: pl.cp.code });
        else if (!agrees(plate.steel.grade, s.grade)) partErr('PART_WRONG_GRADE', pl.part, `${pl.cp.code} is ${s.grade ?? 'of no stated grade'} and ${plate.code} is ${plate.steel.grade}. A nest cannot mix grades.`, { cutPlateCode: pl.cp.code });
        else if (!agrees(plate.steel.material, s.material)) partErr('PART_WRONG_GRADE', pl.part, `${pl.cp.code} is ${s.material ?? 'of no stated material'} and ${plate.code} is ${plate.steel.material}.`, { cutPlateCode: pl.cp.code });
      }
      for (const { cp, parts } of thinner.values()) {
        warn('PART_THINNER_THAN_PLATE', `${cp.code} is ${fmt(cp.steel.thickness)} mm and is nested on ${fmt(plate.steel.thickness)} mm plate (${plural(parts.length, 'piece', 'pieces')}). A piece may be cut from the next plate up — it is then ${fmt(plate.steel.thickness)} mm thick, not ${fmt(cp.steel.thickness)} — so check that is meant, then save anyway. The cut piece keeps its own thickness and weight.`,
          { cutPlateId: cp.id, cutPlateCode: cp.code, cutPlateThickness: cp.steel.thickness, plateThickness: plate.steel.thickness, parts });
      }
    }

    // ---- matched by the size in its name: how the nested outline differs --------
    {
      const byCode = new Map();
      for (const pl of placed) if (pl.outlineDiffers && !byCode.has(pl.cp.id)) byCode.set(pl.cp.id, pl);
      for (const pl of byCode.values()) {
        const d = pl.outlineDiffers;
        const words = pl.part.partName ?? pl.part.labels?.[0] ?? null;
        if (pl.chosen && pl.allowanceMm == null) {
          entry.notes.push(`${pl.cp.code} was chosen for ${words ? `"${words}"` : `part ${pl.partId}`}, which is another size: it is drawn ${fmt(d.drawn[0])} × ${fmt(d.drawn[1])}, the cut piece is ${fmt(d.cutPiece[0])} × ${fmt(d.cutPiece[1])}. ${!nif && ctx.shapeOf(pl.cp).drawn
            ? 'The cut piece has a drawing, so its drawing is what is stored, laid where the part is drawn.'
            : 'The nested outline is what is cut: it is what is stored and measured here; the cut piece keeps its own size.'}`);
          continue;
        }
        if (pl.allowanceMm != null) {
          entry.notes.push(`${pl.cp.code} ("${pl.part.partName ?? pl.part.labels?.[0] ?? ''}") is nested ${fmt(pl.allowanceMm)} mm longer than the cut piece (${fmt(d.cutPiece[0])} × ${fmt(d.cutPiece[1])}) — taken as the cutting allowance. The nested outline is what is cut; the cut piece keeps its own length and weight.`);
          continue;
        }
        entry.notes.push(`${pl.cp.code} ("${pl.part.partName ?? pl.part.labels?.[0] ?? ''}") was matched by the size in its name: it is drawn ${fmt(d.drawn[0])} × ${fmt(d.drawn[1])}, the cut piece is ${fmt(d.cutPiece[0])} × ${fmt(d.cutPiece[1])} — the nesting's outline is another size (camber, or an allowance for cutting). The nested outline is what is cut: it is what is stored and measured here; the cut piece keeps its own size.`);
      }
    }

    /*
     * MARKING, NOT CUT-OUTS. A part that came with closed shapes inside it in another layer or
     * colour than its outline (`ringsNoMarks`) and was matched WITHOUT them (`marksLeftOut`) is from
     * here on the part without them: scribed letters are never stored as cut-outs. When its cut
     * plate has a drawing, the drawing has no such openings — they are marking, and a note says so.
     * When it has none, nothing can tell: a warning that needs "save anyway".
     */
    const bare = new Set(placed.filter((pl) => pl.marksLeftOut > 0 && pl.part?.ringsNoMarks).map((pl) => pl.partId));
    const ringsOfPart = (p) => (bare.has(p.id) ? p.ringsNoMarks : p.rings);
    {
      const told = placed.filter((pl) => bare.has(pl.partId) && ctx.shapeOf(pl.cp).drawn);
      const untold = placed.filter((pl) => bare.has(pl.partId) && !ctx.shapeOf(pl.cp).drawn);
      const count = (xs) => xs.reduce((n, pl) => n + pl.marksLeftOut, 0);
      if (told.length) entry.notes.push(`${plural(count(told), 'closed shape', 'closed shapes')} inside ${plural(told.length, 'part', 'parts')}, drawn in another layer or colour than the outline, ${count(told) === 1 ? 'is' : 'are'} not in the part's drawing: read as marking, not as ${count(told) === 1 ? 'a cut-out' : 'cut-outs'}.`);
      if (untold.length) {
        const pl = untold[0];
        warn('MARKING_UNSURE', `${pl.cp.code} at ${at({ x: pl.part.bbox.x + dx, y: pl.part.bbox.y + dy })} has ${plural(pl.marksLeftOut, 'closed shape', 'closed shapes')} inside it on ${pl.part.unsureStyle ?? 'another layer'} — not the layer and colour of its outline — and no drawing to say whether ${pl.marksLeftOut === 1 ? 'it is a cut-out' : 'they are cut-outs'} or marking${untold.length > 1 ? ` (and ${plural(untold.length - 1, 'more part', 'more parts')} like it)` : ''}. ${count(untold) === 1 ? 'It is' : 'They are'} NOT stored as ${count(untold) === 1 ? 'a cut-out' : 'cut-outs'}. Upload the part's drawing if ${count(untold) === 1 ? 'it is one' : 'they are'} — or save anyway.`, { parts: untold.map((x) => x.partId) });
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
    done.verifyArgs = { length: lotL, width: lotW, kerf: k, margin: rimOf(k).legalMin, rim: drawn, placements: onPlate.map((p) => ({ key: p.id, rings: move(ringsOfPart(p)) })) };

    done.verified = (check) => {
      const close = [];
      const rim = [];
      const commonLine = [];        // ProNest: two pieces of ONE common-line-cut group — one cut between them, drawn a kerf apart
      for (const pr of check.problems) {
        const A = onPlate[pr.ai]; const B = pr.bi != null && pr.bi >= 0 ? onPlate[pr.bi] : null;
        if (pr.kind === 'too_close' && nif && A.clcGroup && B && A.clcGroup === B.clcGroup) { commonLine.push(pr.distance ?? null); continue; }
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
      if (commonLine.length) {
        const gaps = commonLine.filter((d) => d != null);
        entry.notes.push(`${plural(commonLine.length, 'pair of pieces is', 'pairs of pieces are')} cut on a common line in ProNest${gaps.length ? ` (drawn ${fmt(Math.min(...gaps))}${Math.max(...gaps) - Math.min(...gaps) > 0.01 ? ` – ${fmt(Math.max(...gaps))}` : ''} mm apart)` : ''}: one cut between the two, so being closer than our ${fmt(k)} mm kerf is as meant.`);
      }
      if (!drawn && plate) entry.notes.push(dx || dy ? `The file does not draw the plate, so its parts are placed ${fmt(dx)} mm in from the plate's lower-left corner.` : 'The file does not draw the plate, so its parts are measured from the plate\'s lower-left corner.');

      // ---- what it stores: our shape, placed exactly where the file has it --------
      const pieces = [];
      const count = new Map();
      let fromFile = 0; let tooIntricate = 0; let plainInFile = 0; let overDrawing = 0;
      const openings = [];          // parts with no drawing whose file outline has openings that are not round holes
      for (const pl of placed.sort((p, q) => (p.part.bbox.y - q.part.bbox.y) || (p.part.bbox.x - q.part.bbox.x))) {
        const shape = ctx.shapeOf(pl.cp);
        const rot = normDeg(pl.rotationDeg ?? 0);
        let rings = placeShape(shape.rings, { x: Number(pl.x) + dx, y: Number(pl.y) + dy, rotationDeg: rot, mirrored: !!pl.mirrored });
        // Our drawing has holes or a shaped edge and the file draws the bare rectangle (holes drilled later): our drawing is stored.
        if (shape.drawn && pl.by === 'size' && !nif) plainInFile += 1;
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
        const partRings = pl.part ? ringsOfPart(pl.part) : null;
        /*
         * A PRONEST PART keeps the NESTED OUTLINE whatever it is — a rectangle, a cambered web, a part
         * whose cut piece has a drawing with holes the nesting leaves out: it is what will be cut, so
         * it is what is drawn, checked and measured (`asCut`: it stands also when a drawing is there,
         * where a DXF's outline gives way to one).
         */
        if (nif && partRings) {
          const own = move(partRings);
          if (cornersOf(own) <= MAX_FILE_RING_CORNERS) {
            const r = (ring) => ring.map(([x, y]) => [r3(x), r3(y)]);
            fileRings = { outline: r(own.outline), cutouts: own.cutouts.map(r), holes: own.holes.map(r), asCut: true };
            rings = fileRings;
            if (shape.drawn) overDrawing += 1;
            if (own.cutouts.length && !shape.drawn) openings.push({ pl, n: own.cutouts.length });
          } else tooIntricate += 1;
        } else if (!shape.drawn && partRings) {
          const own = move(partRings);
          const b = boxOfShape(own);
          const boxArea = b.length * b.width;
          const notARectangle = own.cutouts.length > 0 || own.holes.length > 0 || ringsArea(own) < boxArea - Math.max(1, boxArea * 1e-4);
          // Lying square it must not be a rectangle; at a free angle a rectangle's own outline IS what placeShape gives.
          const turnedRect = !isPlainPlacement(rot, !!pl.mirrored) && own.outline.length === 4 && !own.cutouts.length && !own.holes.length;
          // Chosen by the user although it is another size than the cut piece: the outline in the file is what is cut.
          const otherSize = !!(pl.chosen && pl.outlineDiffers);
          if ((notARectangle && !turnedRect) || otherSize) {
            if (cornersOf(own) <= MAX_FILE_RING_CORNERS) {
              const r = (ring) => ring.map(([x, y]) => [r3(x), r3(y)]);
              fileRings = { outline: r(own.outline), cutouts: own.cutouts.map(r), holes: own.holes.map(r) };
              rings = fileRings;
              if (notARectangle && !turnedRect) fromFile += 1;
              if (own.cutouts.length) openings.push({ pl, n: own.cutouts.length });
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
          ...(fileRings ? { fileRings } : {}),
          shapeFrom: fileRings ? 'nesting file' : shape.shapeFrom,
          ...(pl.alternatives ? { alternatives: pl.alternatives } : {}),
          ...(pl.chosen ? { chosen: true } : {}), partKey: keyOfPart(pl.part),
          ...(nif ? { partName: pl.part?.partName ?? null } : {}),
          ...(pl.outlineDiffers ? { outlineDiffers: pl.outlineDiffers } : {}), ...(pl.allowanceMm != null ? { allowanceMm: pl.allowanceMm } : {}),
        };
        pieces.push(piece);
        count.set(pl.cp.id, (count.get(pl.cp.id) ?? 0) + 1);
      }
      if (fromFile) entry.notes.push(`${plural(fromFile, 'part has', 'parts have')} no drawing and ${fromFile === 1 ? 'is' : 'are'} not a rectangle in the file: ${fromFile === 1 ? 'its shape is' : 'their shapes are'} taken from the nesting file. The cut plate's own size and weight stay the catalog's until a drawing is uploaded.`);
      if (overDrawing) entry.notes.push(`${plural(overDrawing, 'part has', 'parts have')} a drawing and ${overDrawing === 1 ? 'is' : 'are'} stored as the nesting file's outline all the same: it is what will be cut (holes the drawing has and the nesting leaves out are drilled later).`);
      if (tooIntricate) entry.notes.push(`${plural(tooIntricate, 'part without a drawing is', 'parts without a drawing are')} too intricate in the file to keep the outline of (more than ${MAX_FILE_RING_CORNERS} corners): stored as the rectangle round ${tooIntricate === 1 ? 'it' : 'them'}.`);
      if (plainInFile) entry.notes.push(`${plural(plainInFile, 'part is', 'parts are')} drawn in the file as a plain rectangle although ${plainInFile === 1 ? 'its drawing has' : 'their drawings have'} holes or a shaped edge (holes drilled later, perhaps): stored as ${plainInFile === 1 ? 'its drawing' : 'their drawings'}, not as the file drew ${plainInFile === 1 ? 'it' : 'them'}.`);
      // Openings that are not round holes, on a part with no drawing: they may be cut-outs or scribed
      // letters on the cut layer — nothing can tell. Stored as cut-outs, with a warning that needs force.
      if (openings.length) {
        const { pl, n } = openings[0];
        warn('CUTOUTS_FROM_FILE', `${pl.cp.code} at ${at({ x: pl.part.bbox.x + dx, y: pl.part.bbox.y + dy })} has no drawing, and the file draws ${plural(n, 'opening', 'openings')} in it that ${n === 1 ? 'is not a round hole' : 'are not round holes'}${openings.length > 1 ? ` (and ${plural(openings.length - 1, 'more part', 'more parts')} like it)` : ''}. ${n === 1 && openings.length === 1 ? 'It is stored as a cut-out' : 'They are stored as cut-outs'}, taken from the nesting file. Check ${n === 1 && openings.length === 1 ? 'it is a cut-out' : 'they are cut-outs'} and not scribed marking — then save anyway, or upload the part's drawing.`, { parts: openings.map((o) => o.pl.partId) });
      }
      entry.placed = pieces.length;
      entry.counts = [...count].map(([id, qty]) => ({ cutPlateId: id, cutPlateCode: ctx.cpById.get(id).code, qty }));
      entry.placements = pieces.map((p) => ({
        partId: p.partId, cutPlateId: p.cutPlateId, cutPlateCode: p.cutPlateCode, x: p.x, y: p.y, length: p.length, width: p.width,
        rotationDeg: p.rotationDeg, mirrored: p.mirrored, placedBy: 'customer', area: p.area, by: p.by, confidence: p.confidence, rings: displayRings(p.placedRings),
        shapeFrom: p.shapeFrom,
        ...(p.alternatives ? { alternatives: p.alternatives } : {}),
        ...(p.chosen ? { chosen: true } : {}), partKey: p.partKey,
        ...(p.partName !== undefined ? { partName: p.partName } : {}),
        ...(p.outlineDiffers ? { outlineDiffers: p.outlineDiffers } : {}), ...(p.allowanceMm != null ? { allowanceMm: p.allowanceMm } : {}),
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
          sourceKind: nif ? 'pronest' : 'dxf', sourceFile: nif ? nif.sourceFile : file.filename, sourceHash: file.hash, layoutOrigin: 'customer',
        };
      };
      return [wasteLot, pieces];
    };

    // ---- what became of every part: the rows of the parts table (partTables) ----
    {
      const placedOf = new Map(placed.map((pl) => [pl.partId, pl]));
      const open = new Set(entry.errors.filter((e) => e.code === 'PART_AMBIGUOUS').flatMap((e) => e.partIds ?? [e.partId]));
      entry._rank = { thickness: plate?.steel.thickness ?? rankThickness ?? null, thinnerOk: !!nif };
      entry._parts = nest.parts.filter((p) => !across.has(p.id) && (!scrap.has(p.id) || placedOf.has(p.id))).map((part) => {
        const pl = placedOf.get(part.id) ?? null;
        return {
          id: part.id, key: keyOfPart(part), name: nif ? part.partName ?? null : null, label: part.labels?.[0] ?? null,
          drawn: sizeOfPart(part), nameSize: nif && part.nameSize ? [Math.max(...part.nameSize), Math.min(...part.nameSize)] : null,
          fits: m.facts?.get(part.id)?.fits ?? null, pl,
          status: pl ? (pl.chosen ? 'chosen' : pl.allowanceMm != null ? 'allowance' : 'matched') : open.has(part.id) ? 'ambiguous' : 'unmatched',
        };
      });
    }
    settle();
  };
  settle();
  return done;
}

/**
 * What the line still needs of each cut plate once everything CERTAIN is counted — the pieces the
 * request's files place for sure, and the customer's pieces on saved uploaded plates the request
 * leaves alone: Map cutPlateId → pieces. What prepareFile's `share` hands out from.
 * `opts`: { mode, remove } of the request (a plate it replaces or removes no longer counts).
 */
function quotaOf(stages, ctx, { mode = 'merge', remove = [] } = {}) {
  const left = new Map(ctx.cutPlates.map((cp) => [cp.id, Number(cp.pieces) || 0]));
  const take = (id) => left.set(id, (left.get(id) ?? 0) - 1);
  const nos = new Set(stages.map((s) => s.entry.lotNo?.toUpperCase()).filter(Boolean));
  const names = new Set(stages.map((s) => String(s.entry.filename).toLowerCase()));
  const gone = new Set(remove.map((r) => String(r).trim().toUpperCase()));
  // A ProNest job uploaded again replaces or removes every plate saved from it.
  const jobs = new Set(stages.map((s) => s.entry._nif?.prefix?.toUpperCase()).filter(Boolean));
  for (const l of ctx.saved ?? []) {
    if (l.origin !== 'imported' || mode === 'replace') continue;
    if (l.sourceKind === 'pronest' && jobs.has(jobOfLotNo(l.lotNo))) continue;
    if (nos.has(l.lotNo.toUpperCase()) || (l.sourceFile && names.has(l.sourceFile.toLowerCase())) || gone.has(String(l.id)) || gone.has(l.lotNo.toUpperCase())) continue;
    for (const p of l.pieces) if (isUploadedPiece(l, p)) take(p.cutPlateId);
  }
  for (const s of stages) for (const pl of s.sure) take(pl.cp.id);
  return left;
}

/** The steps of prepareFile in place, on this thread — one file, or a test. */
function processFile(file, ctx, choices, opts = {}) {
  const st = prepareFile(file, ctx, choices);
  st.share(quotaOf([st], ctx, opts));
  if (st.verifyArgs) {
    const pair = st.verified(verifyPlate(st.verifyArgs));
    if (pair) st.measured(wasteOfLot(...pair));
  }
  return st.entry;
}

/** Every file of a request through prepareFile, the two measurements made together off this thread. */
async function processFiles(files, ctx, choices, opts = {}) {
  const stages = [];
  for (const f of files) { stages.push(prepareFile(f, ctx, choices)); await new Promise((resolve) => { setImmediate(resolve); }); }
  // Identical cut plates are shared out over the WHOLE request, in the order the files were sent.
  const left = quotaOf(stages, ctx, opts);
  for (const s of stages) s.share(left);
  const checking = stages.filter((s) => s.verifyArgs);
  const checks = await measurePlates(checking.map((s) => ({ kind: 'verify', args: s.verifyArgs })));
  const pairs = [];
  checking.forEach((s, i) => { const pair = s.verified(checks[i]); if (pair) pairs.push({ s, pair }); });
  const wastes = await wastesOf(pairs.map((x) => x.pair));
  pairs.forEach((x, i) => x.s.measured(wastes[i]));
  return stages.map((s) => s.entry);
}

/* ───────────────────────────── a ProNest job in the answer ───────────────────────────── */

const WORST = { ok: 0, warning: 1, error: 2 };

/**
 * The entries as the answer gives them. A DXF is its own entry. A NEST of a ProNest job is ONE
 * entry however many plates it is cut on (`nestQuantity`): the first plate's, with `lotNos` and
 * `copies: [{ copy, lotNo, action, status, counts, lotId? }]` saying each plate — the plates of a
 * nest are the same layout, and differ at most in which of several identical cut plates a piece
 * was shared out to (`copies[].counts`). What only the save needs (`_lot`, `_nif`) stays inside.
 */
function presentEntries(entries, lotIds = null) {
  const out = []; const heads = new Map();
  const idOf = (e) => (lotIds && e.lotNo ? { lotId: lotIds.get(e.lotNo.toUpperCase()) ?? null } : {});
  for (const { _lot, _nif, _parts, _rank, _missing, ...e } of entries) {
    if (!_nif || _nif.failed) { out.push({ ...e, ...idOf(e) }); continue; }
    const key = `${_nif.fileIndex}|${_nif.nestNo}`;
    const one = { copy: _nif.copy, lotNo: e.lotNo, action: e.action, status: e.status, counts: e.counts, ...idOf(e) };
    const head = heads.get(key);
    if (!head) {
      const { copy, ...rest } = e;
      const first = { ...rest, ...idOf(e), errors: e.errors.slice(), warnings: e.warnings.slice(), lotNos: [e.lotNo], copies: [one] };
      heads.set(key, first); out.push(first);
      continue;
    }
    head.lotNos.push(e.lotNo); head.copies.push(one);
    for (const x of e.errors) if (!head.errors.some((y) => y.code === x.code && y.message === x.message)) head.errors.push(x);
    for (const x of e.warnings) if (!head.warnings.some((y) => y.code === x.code && y.message === x.message)) head.warnings.push(x);
    if (WORST[e.status] > WORST[head.status]) head.status = e.status;
  }
  return out;
}

/* ───────────────────────────── the parts table, and the list a cut piece is chosen from ───────────────────────────── */

const THICKNESS_STEP = 1e7; const KIND_STEP = 1e6;
const mmWords = (n) => fmt(Math.round(Math.abs(n) * 10) / 10);

/**
 * EVERY plate cut piece of the line, best fit first, for ONE part — the list a person picks from
 * (user, 2026-10-14: "show all the cut pieces in the order of whatever fits the best to worst").
 * Arithmetic only: the two sizes of the part (as drawn, and as its name says) against each cut
 * piece's length × width, plus what the ladder already found to fit (`fits`). Nothing is dropped.
 *
 * The order (`fit`, smaller is better):
 *   1. the thickness — the plate's own, then (a ProNest job) up to 2 mm thinner, then any other.
 *      A cut piece of another thickness cannot be cut from the plate: `possible: false`, always last;
 *   2. the same SHAPE (the ladder's true-shape fit), then the same SIZE, then the size with a cutting
 *      allowance (the part up to CUT_ALLOWANCE_MAX_MM longer, the same width — the smallest first),
 *      then the nearest size: the two side differences added, long side with long side.
 * `why` says it in words, the nested part against the cut piece ("15 mm longer, same width").
 *
 * @param part { drawn: [l, w], nameSize: [l, w] | null, fits: Map cutPlateKey → 'shape' | 'size' | null }
 * @param opts { thickness: the plate's (null: not known — every thickness is possible), thinnerOk }
 */
export function rankCutPieces(ctx, part, { thickness = null, thinnerOk = false } = {}) {
  const sizes = [part.drawn, part.nameSize].filter((x) => x && x[0] > 0 && x[1] > 0).map(([a, b]) => [Math.max(a, b), Math.min(a, b)]);
  const out = [];
  for (const [key, cp] of ctx.cpByKey) {
    const S = cp.steel;
    const L = Math.max(S.length, S.width); const W = Math.min(S.length, S.width);
    const thinner = thickness == null ? 0 : thickness - S.thickness;
    const cls = Math.abs(thinner) <= 0.0005 ? 0 : (thinnerOk && thinner > 0 && thinner <= THINNER_MAX_MM + 0.0005 ? 1 : 2);
    const found = part.fits?.get(key) ?? null;
    let allowance = null; let near = null;
    let same = found != null;
    for (const [l, w] of sizes) {
      const dl = l - L; const dw = w - W;
      if (Math.abs(dl) <= 1 && Math.abs(dw) <= 1) same = true;
      if (Math.abs(dw) <= 1 && dl > 1 && dl <= CUT_ALLOWANCE_MAX_MM && (allowance == null || dl < allowance)) allowance = dl;
      if (!near || Math.abs(dl) + Math.abs(dw) < near.sum) near = { dl, dw, sum: Math.abs(dl) + Math.abs(dw), ratio: (l * w) / (L * W) };
    }
    let kind; let off = 0; let words;
    if (found === 'shape') { kind = 0; words = 'same shape'; }
    else if (same) { kind = 1; words = 'same size'; }
    else if (allowance != null) { kind = 2; off = allowance; words = `${mmWords(allowance)} mm longer, same width`; }
    else {
      kind = 3; off = near?.sum ?? KIND_STEP - 1;
      if (!near) words = 'its size is not known';
      else if (Math.abs(near.dw) <= 1) words = `same width, ${mmWords(near.dl)} mm ${near.dl > 0 ? 'longer' : 'shorter'}`;
      else if (Math.abs(near.dl) <= 1) words = `same length, ${mmWords(near.dw)} mm ${near.dw > 0 ? 'wider' : 'narrower'}`;
      else if (near.ratio < 0.5) words = 'much smaller';
      else if (near.ratio > 2) words = 'much larger';
      else words = `${mmWords(near.dl)} mm ${near.dl > 0 ? 'longer' : 'shorter'}, ${mmWords(near.dw)} mm ${near.dw > 0 ? 'wider' : 'narrower'}`;
    }
    const why = cls === 2 ? `other thickness (${fmt(S.thickness)} mm)` : cls === 1 ? `${words} · ${mmWords(thinner)} mm thinner than the plate` : words;
    out.push({
      cutPlateId: cp.id, code: cp.code, ...(cp.name ? { name: cp.name } : {}), thickness: S.thickness, length: L, width: W, grade: S.grade ?? null,
      needed: Number(cp.pieces) || 0, fit: cls * THICKNESS_STEP + kind * KIND_STEP + Math.min(KIND_STEP - 1, Math.round(off * 10) / 10), why, possible: cls < 2,
    });
  }
  return out.sort((a, b) => a.fit - b.fit || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }) || a.cutPlateId - b.cutPlateId);
}

const STATUS_ORDER = ['unmatched', 'ambiguous', 'chosen', 'allowance', 'matched'];

/**
 * THE PARTS TABLE (2026-10-14): one row per DISTINCT part, saying what it was matched to and how,
 * with the ranked list to choose another from. The list is worked out ONCE per row — a ProNest part
 * is one row per job however many nests and plates hold it (`jobs[].partRows`); DXF parts of one size,
 * label and thickness are one row over all the DXF files of the request (`dxfPartRows`).
 * A row's `status` is its worst piece's: unmatched, ambiguous, chosen, allowance, matched.
 */
function partTables(entries, ctx) {
  const groups = new Map();       // "job <index>" | "dxf" → Map row key → { nif, rows: [{ e, r }] }
  for (const e of entries) {
    for (const r of e._parts ?? []) {
      const nif = !!e._nif;
      const table = nif ? `job ${e._nif.fileIndex}` : 'dxf';
      const key = nif ? r.key : `${fmt(e._rank?.thickness)} mm | ${r.key}`;
      if (!nif) r.tableKey = key;
      if (!groups.has(table)) groups.set(table, new Map());
      const rows = groups.get(table);
      if (!rows.has(key)) rows.set(key, { key, nif, list: [] });
      rows.get(key).list.push({ e, r });
    }
  }
  const tables = new Map();
  for (const [table, rows] of groups) {
    const out = [];
    for (const { key, nif, list: group } of rows.values()) {
      const { e, r } = group[0];
      const to = new Map();
      for (const g of group) {
        const pl = g.r.pl;
        if (!pl) continue;
        if (!to.has(pl.cp.id)) to.set(pl.cp.id, { cutPlateId: pl.cp.id, code: pl.cp.code, by: pl.by, pieces: 0, ...(pl.allowanceMm != null ? { allowanceMm: pl.allowanceMm } : {}), ...(pl.outlineDiffers ? { outlineDiffers: pl.outlineDiffers } : {}) });
        to.get(pl.cp.id).pieces += 1;
      }
      const matchedTo = [...to.values()].sort((a, b) => b.pieces - a.pieces);
      const files = new Map();
      if (!nif) for (const g of group) { if (!files.has(g.e.filename)) files.set(g.e.filename, []); files.get(g.e.filename).push(g.r.id); }
      out.push({
        key,
        ...(nif
          ? { partName: r.name ?? r.key, nests: [...new Set(group.map((g) => g.e._nif.nestNo))] }
          : { label: r.label, thickness: e._rank?.thickness ?? null, files: [...files].map(([filename, partIds]) => ({ filename, partIds })) }),
        pieces: group.length, open: group.filter((g) => g.r.status === 'unmatched' || g.r.status === 'ambiguous').length,
        drawn: r.drawn, ...(r.nameSize ? { nameSize: r.nameSize } : {}),
        matched: matchedTo[0] ?? null, ...(matchedTo.length > 1 ? { matchedTo } : {}),
        status: STATUS_ORDER.find((st) => group.some((g) => g.r.status === st)) ?? 'unmatched',
        candidates: rankCutPieces(ctx, r, e._rank ?? {}),
      });
    }
    // What needs a person first: not matched, then matched with an allowance or by hand.
    out.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
    tables.set(table, out);
  }
  // A DXF placement points at its row by the row's whole key (the thickness is part of it).
  for (const e of entries) {
    if (e._nif || !e._parts) continue;
    const keyOf = new Map(e._parts.map((r) => [r.id, r.tableKey]));
    for (const p of e.placements) if (keyOf.has(p.partId)) p.partKey = keyOf.get(p.partId);
    for (const x of e.errors) if (x.partId != null && keyOf.has(x.partId)) x.partKey = keyOf.get(x.partId);
  }
  return tables;
}

/**
 * One line per ProNest job of the request: what it holds, how much of it was recognised and by
 * which rule, and — plainly — what the job itself has NOT nested (`notNested`: the shop's own
 * left-over, by the names in the job; the line's `leftOver` says the same in cut plates).
 */
function jobSummaries(jobs, entries, tables = null) {
  return jobs.map((j) => {
    const base = { filename: j.file.filename, sourceKind: 'pronest', bytes: j.file.buffer?.length ?? 0, program: j.doc?.program ?? j.error?.program ?? null, version: j.doc?.version ?? j.error?.version ?? null, jobName: j.doc?.jobName ?? null };
    if (!j.doc || j.error) {
      return { ...base, status: 'error', lotPrefix: null, nests: j.doc?.counts.nests ?? 0, plates: j.doc?.counts.plates ?? 0, parts: j.doc?.counts.parts ?? 0, placed: 0, matched: 0, matchedBy: {}, notNested: [], notes: [], partRows: [], error: { code: j.error.code, message: `${j.file.filename}: ${j.error.message}` } };
    }
    const mine = entries.filter((e) => e._nif && !e._nif.failed && e._nif.fileIndex === j.file.index);
    const matchedBy = {}; let matched = 0;
    for (const e of mine) for (const p of e.placements) { matched += 1; matchedBy[p.by] = (matchedBy[p.by] ?? 0) + 1; }
    // Pieces matched ONLY THANKS TO THE CUTTING ALLOWANCE — an "of which": they are also counted under the rung that found them.
    const allowance = mine.reduce((n, e) => n + e.placements.filter((p) => p.allowanceMm != null && p.by !== 'choice').length, 0);
    if (allowance) matchedBy.allowance = allowance;
    return {
      ...base, status: mine.reduce((w, e) => (WORST[e.status] > WORST[w] ? e.status : w), 'ok'), lotPrefix: j.prefix,
      nests: j.doc.counts.nests, plates: j.doc.counts.plates, parts: j.doc.counts.parts,
      placed: j.doc.counts.pieces,          // pieces the job nests, over all its plates
      matched, matchedBy,                   // of them, recognised as cut plates of this line — and by which rule
      notNested: j.doc.partsList.filter((p) => p.notNested > 0).map((p) => ({ name: p.name, required: p.required, nested: p.nested, notNested: p.notNested })),
      notes: j.doc.notes,
      // One row per part of the job: what it was matched to, how, and the list to choose another from.
      partRows: tables?.get(`job ${j.file.index}`) ?? [],
    };
  });
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
    // Every size a catalog plate comes in: what tells the reader a plate from the drawing frame round it.
    plateSizes: ctx.plates.filter((p) => p.steel?.length > 0 && p.steel?.width > 0).map((p) => ({ length: p.steel.length, width: p.steel.width })),
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
 *   input.files     [{ filename, file (base64), plateCode?, nestNo? }] — DXFs (one plate each) and ProNest
 *                   jobs (.nif: every nest of the job; `nestNo` then names the JOB, see expandJobs)
 *   input.dryRun    default TRUE: read, match, check, say the difference — write nothing
 *   input.force     save although a file has warnings (closer than kerf, inside the rim) or a cut
 *                   plate is nested more often than the line needs
 *   input.mode      'merge' (default) | 'replace'
 *   input.remove    [lotId | nestNo] — plates to take off the line in the same save
 *   input.choices   { [filename]: { [partId | ProNest part name]: cutPlateId | 'cp<id>' | cut plate code } } — for ANY
 *                   part: the cut piece named is the match, whatever the ladder said (see prepareFile)
 */
export async function uploadNestFiles(db, c, lineId, input = {}) {
  const dryRun = input.dryRun === undefined ? true : truthy(input.dryRun);
  const force = truthy(input.force);
  const mode = String(input.mode ?? 'merge').toLowerCase() === 'replace' ? 'replace' : 'merge';
  const removeAsk = Array.isArray(input.remove) ? input.remove : [];
  const sent = input.files == null && removeAsk.length ? [] : readFiles(input);
  // A ProNest job is read here and opened into its plates: from now on `files` is one entry per plate.
  const { plates: files, jobs } = expandJobs(sent);
  const companyId = c.companyId;
  const ctx = await uploadContext(db, companyId, lineId);
  const codeOf = (id) => ctx.cpById.get(id)?.code ?? `#${id}`;
  const problems = [];
  const warnings = [];
  const blocker = importBlocker(ctx.line);
  if (blocker) problems.push({ code: blocker.code ?? 'INVALID', message: blocker.message });

  const entries = await processFiles(files, ctx, input.choices ?? null, { mode, remove: removeAsk });

  // ---- a choice made for the whole job, for a part the job does not have --------
  for (const j of jobs) {
    if (!j.doc || j.error) continue;
    const asked = { ...(input.choices?.[stem(j.file.filename)] ?? {}), ...(input.choices?.[j.file.filename] ?? {}) };
    const known = new Set(j.doc.partsList.map((p) => p.name));
    for (const n of j.doc.nests) for (const p of n.parts) { known.add(p.id); known.add(p.name); }
    const strangers = Object.keys(asked).filter((key) => !blank(asked[key]) && !known.has(key));
    const first = entries.find((e) => e._nif && !e._nif.failed && e._nif.fileIndex === j.file.index);
    if (strangers.length && first) {
      first.errors.push({ code: 'CHOICE_INVALID', parts: strangers, message: `${j.file.filename}: a cut piece was chosen for ${list(strangers.slice(0, 5).map((key) => `"${key}"`))}${strangers.length > 5 ? ` and ${strangers.length - 5} more` : ''}, but ${strangers.length === 1 ? 'that is not a part' : 'those are not parts'} of this job. Nothing was done with ${strangers.length === 1 ? 'it' : 'them'} — take the choice away, or choose again.` });
    }
  }
  const tables = partTables(entries, ctx);

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
      if (byNest.has(key) && !e.errors.some((x) => x.code === 'DUPLICATE_FILE')) {
        e.errors.push({ code: 'DUPLICATE_NEST', message: e._nif
          ? `${e.filename}: it would be plate ${e.lotNo}, and so would ${byNest.get(key).filename} — the two jobs carry the same name${e.jobName ? ` ("${e.jobName}")` : ''}. Give one of them its own (nestNo on the file).`
          : `${e.filename}: it is nest ${e.nestNo}, and so is ${byNest.get(key).filename}. One file is one plate — give each its own nest number (in the file, in its name, or as nestNo).` });
      } else if (!byNest.has(key)) byNest.set(key, e);
      if (ctx.barNos.has(key)) e.errors.push({ code: 'LOT_NAME_TAKEN', message: `${e.filename}: ${e.lotNo} is already the name of a section bar on this line — give the nest another name (nestNo).` });
    }
  }

  // ---- against what is saved: replaced, added, unchanged, removed -------------
  const saved = ctx.saved;
  const imported = saved.filter((l) => l.origin === 'imported');
  // A DXF also finds its plate by its file name; a plate of a ProNest job only by its lot number (the job's file is many plates).
  const targetOf = (e) => imported.find((l) => l.lotNo.toUpperCase() === e.lotNo?.toUpperCase())
    ?? (e._nif ? null : imported.find((l) => l.sourceKind !== 'pronest' && l.sourceFile && l.sourceFile.toLowerCase() === e.filename.toLowerCase()))
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
  /*
   * A PRONEST JOB IS UPLOADED WHOLE. A plate saved from an earlier upload of the same job that this
   * upload no longer makes — a nest taken out of the job, a nest now cut on fewer plates — goes with
   * it, also in `merge`: otherwise the old nest would stay beside the new job and nest its pieces twice.
   */
  const jobsSent = new Set(entries.filter((e) => e._nif?.prefix).map((e) => e._nif.prefix.toUpperCase()));
  const jobGone = new Set();
  for (const l of imported) {
    if (l.sourceKind !== 'pronest' || replacing.has(l.id) || removing.has(l.id) || !jobsSent.has(jobOfLotNo(l.lotNo))) continue;
    removing.set(l.id, l); jobGone.add(l.id);
  }
  for (const l of removing.values()) diff.removed.push({ ...describe(l), ...(jobGone.has(l.id) ? { because: 'the job uploaded now no longer has this plate' } : {}) });

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
  for (const e of fresh) for (const cnt of e.counts) { customer.set(cnt.cutPlateId, (customer.get(cnt.cutPlateId) ?? 0) + cnt.qty); addWhere(cnt.cutPlateId, e._nif && e.nestQuantity > 1 ? `${e.filename}, plate ${e._nif.copy} of ${e.nestQuantity}` : e.filename, cnt.qty); }
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

  // The plates a nest is cut on say the same thing in the same words: each is said once.
  const once = new Set();
  const fresher = (e, x) => { if (!e._nif) return true; const key = `${e._nif.fileIndex}|${e._nif.nestNo ?? ''}|${x.code}|${x.message}`; if (once.has(key)) return false; once.add(key); return true; };
  for (const e of entries) {
    for (const x of e.errors) if (fresher(e, x)) problems.push(x);
    if (e.action !== 'unchanged') for (const w of e.warnings) if (fresher(e, w)) warnings.push(w);
    e.status = e.errors.length ? 'error' : e.warnings.length ? 'warning' : 'ok';
  }
  const changes = fresh.length + removing.size + dropLots.size + rewrite.size;
  const canSave = problems.length === 0 && changes > 0;
  const needsForce = warnings.some((w) => w.needsForce);

  // ---- plates the catalog does not have: once each, with the code each would get ---------------
  const missingPlates = await missingPlatesOf(db, companyId, ctx, entries.filter((e) => e._missing).map((e) => ({
    ...e._missing, filename: e.sourceFile ?? e.filename, nestNo: e._nif ? e.jobNestNo ?? null : e.nestNo ?? null,
  })), { alikeGrade: sameGrade });

  const say = [];
  if (problems.length) say.push(`${plural(problems.length, 'thing needs', 'things need')} fixing before this can be saved`);
  if (sent.length) say.push(`${plural(sent.length, 'file', 'files')} read${jobs.length ? ` (${plural(jobs.length, 'ProNest job', 'ProNest jobs')}: ${plural(jobs.reduce((a, j) => a + (j.error ? 0 : j.doc.counts.nests), 0), 'nest', 'nests')}, ${plural(jobs.reduce((a, j) => a + (j.error ? 0 : j.doc.counts.plates), 0), 'plate', 'plates')})` : ''}`);
  const d = diff;
  const parts = [d.added.length && `${d.added.length} added`, d.replaced.length && `${d.replaced.length} replaced`, d.unchanged.length && `${d.unchanged.length} unchanged`, d.removed.length && `${d.removed.length} removed`].filter(Boolean);
  if (parts.length) say.push(`plates: ${parts.join(', ')}`);
  if (d.droppedAuto.length) say.push(`${plural(d.droppedAuto.length, 'automatic plate is', 'automatic plates are')} dropped (its pieces are now in the files)`);
  if (surplus.length) say.push(`${plural(surplus.length, 'cut plate is', 'cut plates are')} nested more often than the line needs`);
  const leftPieces = leftOver.filter((x) => !x.manual && !x.leftOut).reduce((a, x) => a + x.qty, 0);
  if (leftPieces) say.push(`${plural(leftPieces, 'piece is', 'pieces are')} left over — nest the rest afterwards`);

  const out = {
    line: lineHead(ctx.line), dryRun, applied: false, mode, canSave, needsForce, engine: VERIFY_ENGINE,
    files: presentEntries(entries),
    // One line per ProNest job of the request ([] when it holds none).
    jobs: jobSummaries(jobs, entries, tables),
    // The DXF files' parts, one row per distinct part over all of them ([] when the request holds no DXF part).
    dxfPartRows: tables.get('dxf') ?? [],
    problems: problems.map((p) => p.message), problemList: problems,
    warnings: warnings.map((w) => w.message), warningList: warnings,
    diff, coverage, leftOver, surplus,
    // Plates these files are cut on that are not catalog items ([] when every plate was found): POST …/nesting/plates adds them.
    missingPlates,
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
    files: presentEntries(entries, lotIds),
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
  // (A ProNest job's file is ONE row for all its plates: it goes only when the last of them does.)
  const fileStays = new Set(ctx.saved.filter((l) => l.nestFileId && (!removeIds.includes(l.id) || rewriteIds.has(l.id))).map((l) => l.nestFileId));
  const goneFiles = [...new Set(ctx.saved.filter((l) => removeIds.includes(l.id) && !rewriteIds.has(l.id) && l.nestFileId && !fileStays.has(l.nestFileId)).map((l) => l.nestFileId))];
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
  // One row per FILE. A DXF is its plate's file, kept as its text. A ProNest job is kept ONCE for
  // all the plates it makes, as base64 (it is binary) under its own hash; `nest_no` is then the job's name.
  const fileOf = new Map(files.map((f) => [f.hash, f]));
  const storedHash = (e) => fileOf.get(e.hash)?.pronest?.fileHash ?? e.hash;
  const byStored = new Map();
  for (const e of fresh) {
    const f = fileOf.get(e.hash); const key = storedHash(e);
    if (byStored.has(key)) continue;
    byStored.set(key, f.pronest
      ? [companyId, lineId, f.pronest.sourceFile, 'pronest', key, f.buffer.length, String(f.pronest.doc.jobName ?? f.pronest.prefix).slice(0, 60), f.buffer.toString('base64'), c.userId ?? null]
      : [companyId, lineId, e.filename, 'dxf', e.hash, f.buffer.length, String(e.nestNo).slice(0, 60), f.buffer.toString('latin1'), c.userId ?? null]);
  }
  const rows = [...byStored.values()];
  let batch = []; let bytes = 0;
  const flush = async () => { if (batch.length) await insertRows(db, 'cf_nest_files', ['company_id', 'order_line_id', 'file_name', 'file_kind', 'file_hash', 'byte_size', 'nest_no', 'file_text', 'created_by'], batch, batch.length); batch = []; bytes = 0; };
  for (const r of rows) { if (bytes + r[7].length > FILE_INSERT_BYTES) await flush(); batch.push(r); bytes += r[7].length; }
  await flush();
  const idByHash = new Map();
  if (rows.length) {
    const [ids] = await db.query('SELECT id, file_hash FROM cf_nest_files WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND file_hash IN (?) ORDER BY id', [companyId, lineId, rows.map((r) => r[4])]);
    for (const r of ids) idByHash.set(r.file_hash, r.id);
  }

  const toWrite = [
    ...fresh.map((e) => {
      const reasons = e.warnings.map((w) => w.message);
      return { ...e._lot, verdict: reasons.length ? 'tight' : 'fits', reasons: reasons.length ? reasons : null, forced: forced && reasons.length > 0, nestFileId: idByHash.get(storedHash(e)) ?? null, waste: { ...e._lot.waste, offcuts: e._lot.waste.offcuts.map((o, i) => ({ ...o, offcutNo: `${e._lot.lotNo}-${offcutLetters(i)}` })) } };
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
  const [files] = fileIds.length ? await db.query('SELECT id, file_name, file_kind, file_hash, byte_size, nest_no, created_at, created_by FROM cf_nest_files WHERE company_id = ? AND id IN (?)', [companyId, fileIds]) : [[]];
  const fileById = new Map(files.map((f) => [f.id, f]));
  const cpById = new Map(ctx.cutPlates.map((cp) => [cp.id, cp]));
  const codeOf = (id) => cpById.get(id)?.code ?? `#${id}`;
  const { coverage, leftOver } = coverageOfLots(ctx.cutPlates, saved, excl);
  const blocker = importBlocker(ctx.line);
  return {
    line: lineHead(ctx.line),
    canUpload: !blocker, readOnlyReason: blocker?.message ?? null,
    limits: { maxFiles: MAX_NEST_FILES, maxFileBytes: MAX_NEST_FILE_BYTES, kinds: ['dxf', 'nif'], maxPlates: MAX_NEST_PLATES },
    plates: saved.map((l) => {
      const f = l.nestFileId ? fileById.get(l.nestFileId) : null;
      const customer = l.pieces.filter((p) => isUploadedPiece(l, p));
      const ours = l.pieces.filter((p) => !customer.includes(p));
      return {
        lotId: l.id, lotNo: l.lotNo, origin: l.origin, sourceKind: l.sourceKind, layoutOrigin: l.layoutOrigin,
        plateItemId: l.plateItemId, plateCode: l.plateCode, thickness: l.thickness, grade: l.grade, length: l.length, width: l.width,
        // kind 'pronest': the file is a whole ProNest job, the same one for every plate of it (`nestNo` is then the job's name).
        file: f ? { id: f.id, filename: f.file_name, kind: f.file_kind ?? 'dxf', hash: f.file_hash, bytes: Number(f.byte_size), nestNo: f.nest_no, uploadedAt: f.created_at } : null,
        pieces: l.pieces.length, customerPieces: customer.length, ourPieces: ours.length,
        parts: tally(customer, codeOf), addedByUs: tally(ours, codeOf),
        verdict: l.verdict, forced: l.forced, warnings: l.reasons,
      };
    }),
    coverage, leftOver, totals: totalsOfLots(saved, leftOver),
  };
}

/**
 * GET …/nesting/files/:lotId — the customer's file a plate was read from, as it was sent, byte for
 * byte: a DXF, or the whole ProNest job (.nif) the plate is one nest of.
 */
export async function nestFileOf(db, companyId, lineId, lotId) {
  const [[row]] = await db.query(
    `SELECT f.file_name, f.file_kind, f.file_text
       FROM cf_plate_lots l JOIN cf_nest_files f ON f.id = l.nest_file_id AND f.company_id = l.company_id
      WHERE l.company_id = ? AND l.order_line_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [companyId, lineId, Number(lotId)],
  );
  if (!row || row.file_text == null) throw notFound('Nesting file');
  if (row.file_kind === 'pronest') return { filename: row.file_name, contentType: 'application/octet-stream', buffer: Buffer.from(row.file_text, 'base64') };
  return { filename: row.file_name, contentType: 'application/dxf', buffer: Buffer.from(row.file_text, 'latin1') };
}

export const _test = { processFile, prepareFile, uploadContext, resolvePlate, applyChanges, expandJobs, readFiles, DEFAULT_CUT_SETTINGS };
