/**
 * cutPlateService.js — the blanks a line's plate parts are cut from.
 *
 * A plate part on a sales order is a rectangle of steel: a thickness, a length,
 * a width and a grade. Several parts of the SAME rectangle in the same steel
 * are cut as one batch off the same raw plate, so they share one blank — the
 * "cut plate" (decided 2026-09-23: *a cut plate is a temporary item*, filed as a
 * variant beside bought plates so grade, thickness, density and the weight
 * formula come from the same place, and *a nest is a shared raw plate, not a
 * document*).
 *
 * What this writes, per line:
 *   part, part, part  ->  one cut plate (same thickness/length/width/grade)
 *                    ->  its own BOM: the SEL Plate selection, which NESTING
 *                        resolves to a real plate item from the catalog (no
 *                        default plate since 2026-09-30 — "chosen at nesting").
 * A part's line to its cut plate is quantity 1 — one blank per piece of that
 * part. The cut plate's line to the raw plate is the AREA FRACTION, below.
 *
 * It closes a hole in release: a made node with nothing under it asks for no
 * material at all, so parts that were `sourcing = make` with no BOM put nothing
 * on the buy list. releaseService now refuses that; this is what fills it in.
 *
 * ---------------------------------------------------------------------------
 * THE QUANTITY IS AN APPROXIMATION, ON PURPOSE.
 *
 * One raw plate yields many blanks, so "one plate per blank" would buy an
 * absurd amount of steel. Until real nesting exists the quantity is the area
 * fraction: (blank length × blank width) ÷ (plate length × plate width). It
 * ignores how the blanks actually lie on the sheet, the kerf between them and
 * the offcut left at the edge, so it is a first answer and not a cutting plan.
 * Real nesting will replace it, and it will buy MORE steel than this says, not
 * less. Everything this service returns carries that caveat in words.
 * ---------------------------------------------------------------------------
 *
 * Running it again is safe: it reconciles against what is already there rather
 * than making a second set — the same rectangle keeps its cut plate, a part
 * that changed size moves to another, and a cut plate nothing is cut from any
 * more is deleted with everything below it.
 *
 * ---------------------------------------------------------------------------
 * AUTOMATIC (user, 2026-09-26): "Once the values screen is completed, then cut
 * pieces should get created." refreshCutPieces is the entry point for that: it
 * is called after every value save and structure change on a line, and by
 * lock, and it derives only while the line is open and its values are
 * complete. So it runs OFTEN, and it had to become cheap first.
 *
 * IN BULK (2026-09-27). The derive used to be written one record at a time:
 * each blank through setValues (resolve, write, materialise, walk the parents)
 * and the code generator (~12 round trips each), each BOM line through three
 * statements, and at the end a refreshValues over every part and blank of the
 * line — one full resolution per record. On the KEPL line (152 parts, 25
 * blanks) a derive that CHANGED NOTHING cost 1,338 round trips, a minute on
 * production (~49 ms each); the read behind the Cut pieces screen cost 118.
 *
 * Now a derive is three phases, and only the last one writes:
 *
 *   load    everything the reconcile works from, in a fixed number of queries
 *           whatever the size: the line, the places in the tree and their
 *           subtrees (one recursive query), the plate selection, the line's
 *           temporary tree with its records (one recursive query), the part →
 *           blank lines, the stored values, each blank's plate line (with
 *           whether a nesting laid it out), the plates those lines hold. Eight.
 *   plan    the reconcile itself, in memory, step for step the one it replaces
 *           (see planGroups / planPlateLines) — so the read and the write can
 *           never disagree about what a derive would do.
 *   write   only when the plan changes something: one multi-row statement per
 *           kind of change (drops, new blanks with placeholder codes read back
 *           by natural key, their details, missing BOMs, every new line, the
 *           blanks' own values with history, plate-line updates, removals),
 *           then the values settled ONCE for the line through the Values
 *           engine (orderValuesService.materializeLineRecords — the same walk
 *           refreshValues does, in memory), then names and codes for the new
 *           blanks with the coding rules read once (codeRangeService
 *           readRulesOnce, the way release and the template copy do it).
 *
 * A derive that changes nothing writes nothing — not even the value refresh the
 * old one always ran — which is what makes it safe to call after every save.
 *
 * Measured on the KEPL line (2026-09-27): nothing to change 1,338 -> 8 round
 * trips; all 25 blanks made from scratch 4,488 -> 44; three parts changing size
 * (two new blanks, one removed) 1,579 -> 59; the read 118 -> 16, 8 of them the
 * Values engine's count. Proved result-for-result identical to the old derive
 * on that line — codes, names, every value, every BOM line, which part holds a
 * blank's first line — in five rolled-back scenarios, old and new side by side
 * (as it stood, from scratch, with a default plate, sizes changed, and coding
 * and naming rules printing derived values, the range and the parent's name).
 */
import { CfError, invalid, notFound, translateDbError } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { LOCKED_ORDER_STATUSES, lockedLineMessage, revisedOrderMessage, latestRevisionSql } from './records.js';
import { ancestors } from './tree.js';
import { resolve as resolveSpecs, rawOf, dateText } from './resolutionService.js';
import { temporaryTree } from './instantiationService.js';
import { requireUsableFlow, cutPlateFlowId, cutSectionFlowId } from './flowService.js';
import { syncSectionCuts } from './sectionNestingService.js';
import { readLineValues, materializeLineRecords } from './orderValuesService.js';
import { readRulesOnce, PLACED, rangesOf } from './codeRangeService.js';
import { generate } from '../modules/codegen/index.js';
import { refreshValues } from './valueService.js';
import { autofillLineSelections } from './selectionService.js';
import { cutPlaces, problemsOf } from '../lib/cutPlaces.js';
import { syncFlowSpecs } from './flowSpecService.js';
import {
  resolveCodes, sectionSteelOf, profileKeyOf, profileLabelOf, CUT_FROM_CODE, CUT_FROM_VALUES, STEEL_FROM_STOCK,
} from '../lib/cutFrom.js';

/**
 * ---------------------------------------------------------------------------
 * CUT FROM (2026-10-08, CF_ERP_CUT_FROM_PLAN.md): which parts get a cut piece
 * is no longer "whatever is filed under FAB_PARTS". Every part says how it is
 * cut — its CUT_FROM, inherited down the classification and from its template
 * definition (lib/cutFrom) — and where cut pieces are filed is a company
 * setting by node id (lib/cutPlaces), never a code. Two methods:
 *
 *   PLATE    exactly the derive described above, result for result.
 *   SECTION  a part cut to length from a stock bar. It names its bar
 *            (cf_master_records.cut_stock_id, its own or its template
 *            definition's), takes the bar's steel (STEEL_FROM_STOCK, written
 *            as 'inherited' where it has no entered value — syncSectionSteel),
 *            and parts of the same PROFILE (thickness, width, depth, grade,
 *            impact — the same bar in any stock length) and the same LENGTH
 *            share one blank filed at the section blanks place. Part -> blank
 *            quantity 1; blank -> its stock bar at length ÷ stock length,
 *            until section nesting replaces it with the real bar share.
 *
 * Both run in the same load / plan / write: the same reconcile, keyed per
 * method, the same bulk writes, one values settle for the line, and still
 * "a derive that changes nothing writes nothing". A part whose CUT_FROM
 * changes lets go of the blank of its old method in the same reconcile (its
 * line is dropped; the blank, if nothing else is cut from it, goes).
 * ---------------------------------------------------------------------------
 */

/** The four facts that make two parts the same blank. */
const SPEC_CODES = ['THICKNESS', 'LENGTH', 'WIDTH', 'GRADE'];
/** What a cut section is given of its own (where its place's rules take them), beside the steel its chain asks a part for. */
const SECTION_SIZE_CODES = ['THICKNESS', 'WIDTH', 'DEPTH', 'SECTION_AREA', 'LENGTH', 'GRADE', 'DENSITY'];
/** instantiationService.temporaryTree walks this far down (its MAX_DEPTH + 5). */
const TREE_DEPTH = 25;
/** bomGraph.descendantIds' cap, for the loop rule. */
const LOOP_DEPTH = 25;
const EMPTY = { value_number: null, value_text: null, value_bool: null, value_date: null, option_id: null };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A BLANK INHERITS ITS STEEL FROM THE PART IT SERVES — all of it, not four of it.
 *
 * The four sizes are what make two parts the SAME blank, so they are written
 * explicitly. But a blank is filed at CUT_PLATE, and that node's chain can
 * require more: in the KEPL tenant it inherits IMPACT_CLASS from the steel
 * family, and without it `setStatus('active')` refuses EVERY derived blank and
 * release stops behind a value nobody typed. A one-off script patched the
 * blanks that already existed and its own comment said "worth folding into
 * cutPlateService"; this is that, so the next order does not hit it again.
 *
 * Written as "whatever my own chain requires, ask the part for it" rather than
 * as a fifth hard-coded code — a fifth only moves the problem to a sixth the
 * next time somebody adds a rule to the steel family.
 *
 * It only ever COPIES. A value the part cannot answer either is left empty and
 * the activation error reports it: inventing steel is worse than not guessing.
 *
 * The part's answer is read where it is STORED (decision Q18: every value an
 * item ends up with — entered, defaulted, fixed, inherited, calculated — is
 * stored on the item), which is how the four sizes have always been read, so
 * one query answers every part at once. It used to be a full resolution of the
 * part per blank. The two agree wherever the item's values are settled, which
 * the Values engine and rematerialize keep true; the one way they can differ
 * is an entered value left on a part after its rule was switched off, which a
 * resolution ignores and this copies — as it copies the four sizes.
 */

export const AREA_FRACTION_CAVEAT = 'The plate quantity is the blank\'s area divided by the raw plate\'s — it ignores how the blanks lie on the sheet and the offcut left over, so it is a first answer, not a nesting plan. Real nesting will replace it, and it will ask for more steel than this, not less.';

/**
 * The cut pieces of a line that an ACCEPTED NESTING has laid out.
 *
 * Once a line is nested, a cut piece's plate line no longer carries the area
 * fraction: acceptNesting repoints it at the plate the layout actually uses and
 * writes the real share of it — waste included. That number is the one
 * procurement must buy from.
 *
 * This used to be invisible to the derivation, which rewrote any plate quantity
 * that differed from the area fraction. After nesting every one differs, so
 * "Derive again" silently put the smaller area fractions back under 120 nested
 * plates — the nesting stage still said done while the buy list under-ordered
 * by exactly the waste. It happened in production on 2026-09-26.
 *
 * So a nested cut piece's plate line belongs to NESTING. The derivation reads
 * it, reports it, and does not write it.
 */
const NESTED_NOTE = 'This quantity comes from the accepted nesting — the real share of the plate it is cut from, waste included — not the area fraction. Nesting the line again is what changes it.';

const round6 = (n) => Number(Number(n).toFixed(6));
const fmt = (n) => String(round6(n));
const blank = (v) => v == null || String(v).trim() === '';
const nameOf = (r) => r.code ?? r.name;
const list = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const brief = (m) => (m ? { id: m.id, code: m.code, name: m.name } : null);

// --- what the line is, and whether it may still be changed ---------------------

/**
 * The line, its order and its release. `db_now` is the database's clock, read
 * with the rows: the TIMESTAMP columns come back in the server's zone and the
 * driver labels them UTC, so a time is only right as a DIFFERENCE from a clock
 * read the same way (see lastMadeAt).
 */
async function requireLine(db, companyId, lineId, { lock = false } = {}) {
  const [[l]] = await db.query(
    `SELECT l.*, o.code AS order_code, o.status AS order_status, o.order_type, o.title AS order_title,
            o.revision AS order_revision, ${latestRevisionSql('o')} AS order_latest_revision,
            rel.id AS release_id, NOW() AS db_now
       FROM cf_sales_order_lines l
       JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
       LEFT JOIN cf_production_releases rel ON rel.order_line_id = l.id AND rel.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, lineId],
  );
  if (!l) throw notFound('Order line');
  return l;
}

/**
 * Cut plates are part of the structure, so the rules that close a structure to
 * change close this: a frozen order, a released line whose tracker is already
 * the snapshot of what was there, and a LOCKED line — lock rolls the BOM out
 * into pieces, and after it the line's structure, values and cut pieces never
 * change (a change is a new revision of the order).
 */
function lockOf(line) {
  if (LOCKED_ORDER_STATUSES.has(line.order_status)) {
    const message = line.order_status === 'revised' ? revisedOrderMessage(line.order_code, line.order_revision, line.order_latest_revision)
      : `Order ${line.order_code} is ${line.order_status} — its structure can no longer change, so its cut plates cannot either.`;
    return { reason: 'closed', code: 'ORDER_LOCKED', message };
  }
  if (line.release_id) {
    return { reason: 'released', code: 'RELEASED', message: `Line ${line.line_no} of ${line.order_code} is released to production — its structure is fixed. Take the release back (while nothing has started) before working out its cut plates.` };
  }
  if (line.locked_at) {
    return { reason: 'locked', code: 'LOCKED', message: lockedLineMessage(line.line_no, line.order_code) };
  }
  return null;
}

function assertOpen(line) {
  const f = lockOf(line);
  if (f) throw invalid(f.code, f.message);
}

// --- where cut pieces, raw stock and offcuts are filed (lib/cutPlaces) ----------

/**
 * The places, by id, from the one helper every service asks (Setup › Cutting).
 * Never throws: requirePlaces says what is missing, in its words, for the
 * methods a line actually uses — a line with no section parts need not hear
 * that no section place is set.
 */
async function loadPlaces(db, companyId) {
  const all = await cutPlaces(db, companyId);
  return {
    all,
    cutPlate: all.plate.blanksNodeId ? { id: all.plate.blanksNodeId } : null,
    cutIds: [...all.plate.blanksIds],
    cutSection: all.section.blanksNodeId ? { id: all.section.blanksNodeId } : null,
    sectionIds: [...all.section.blanksIds],
    blankIds: new Set([...all.plate.blanksIds, ...all.section.blanksIds]),
  };
}

/** The refusal for a method in use whose blanks place is not set — problemsOf's words. */
function placeProblem(places, kind) {
  const p = problemsOf(places.all, kind, ['blanks'])[0];
  return p ? invalid(kind === 'plate' ? 'NO_CUT_PLATE_CLASS' : 'NO_CUT_SECTION_CLASS', p.text) : null;
}

function requirePlaces(places, { plate = false, section = false } = {}) {
  const e = (plate && placeProblem(places, 'plate')) || (section && placeProblem(places, 'section'));
  if (e) throw e;
}

/**
 * The selection definition that chooses a raw plate — found by what it
 * searches (the plate stock place of Setup › Cutting), never by its id.
 * `where` is the cutPlaces answer, a list of node ids, or (older callers) a
 * node { id, code }.
 */
export async function plateSelection(db, companyId, where) {
  const nodeIds = where?.all?.plate ? where.all.plate.stockNodeIds
    : where?.plate?.stockNodeIds ? where.plate.stockNodeIds
      : Array.isArray(where) ? where.map(Number)
        : where?.stockNodeIds ? where.stockNodeIds
          : where?.id != null ? [Number(where.id)] : [];
  if (!nodeIds.length) {
    throw invalid('NO_PLATE_CLASS', 'No raw plate stock is set — choose where it is filed in Setup › Cutting, so a cut plate knows where its raw plate comes from.');
  }
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.status, n.code AS searches FROM cf_definition_details d
       JOIN cf_master_records m ON m.id = d.master_id AND m.deleted_at IS NULL
       LEFT JOIN cf_classification_nodes n ON n.id = d.candidate_classification_id
      WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.definition_type = 'selection'
        AND d.candidate_classification_id IN (?) AND m.status = 'active'
      ORDER BY m.id`,
    [companyId, nodeIds],
  );
  if (!rows.length) {
    throw invalid('NO_PLATE_SELECTION', 'Nothing chooses the raw plate: there is no active selection definition searching the raw plate stock. Make one (the SEL Plate selection) before working out cut plates.');
  }
  if (rows.length > 1) {
    throw invalid('MANY_PLATE_SELECTIONS', `${rows.length} selection definitions search the raw plate stock (${list(rows.map(nameOf))}) — a cut plate cannot be told which one chooses its raw plate. Retire the ones that do not.`);
  }
  const { searches, ...sel } = rows[0];
  return sel;
}
// --- the four values, read where they are already stored -----------------------

/**
 * Every value an item ends up with — entered, fixed, defaulted, calculated,
 * rolled up or inherited — is STORED on the item (decision Q18), so the four
 * sizes are one query rather than a full resolution per part. Every stored
 * value comes back, not only the four: the steel a new blank asks its part for
 * is read from the same rows (see the note at the top of the file).
 */
async function specValuesOf(db, companyId, masterIds) {
  const out = new Map(masterIds.map((id) => [id, new Map()]));
  if (!masterIds.length) return out;
  const [rows] = await db.query(
    `SELECT v.subject_id, s.code, s.data_type, v.value_number, v.value_text, v.value_bool, v.value_date, v.option_id,
            o.value AS option_value
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL`,
    [companyId, masterIds],
  );
  for (const r of rows) out.get(r.subject_id)?.set(String(r.code).toUpperCase(), r);
  return out;
}

function sizeOf(values) {
  const num = (code) => {
    const r = values.get(code);
    return r && r.value_number != null ? round6(Number(r.value_number)) : null;
  };
  const g = values.get('GRADE');
  const gradeId = g?.option_id ?? null;
  const gradeText = g?.option_value ?? g?.value_text ?? null;
  return { thickness: num('THICKNESS'), length: num('LENGTH'), width: num('WIDTH'), gradeId, gradeText };
}

/** What is missing, in the words of the specification codes. */
function missingOf(size) {
  const gone = [];
  if (size.thickness == null || size.thickness <= 0) gone.push('THICKNESS');
  if (size.length == null || size.length <= 0) gone.push('LENGTH');
  if (size.width == null || size.width <= 0) gone.push('WIDTH');
  if (size.gradeId == null && blank(size.gradeText)) gone.push('GRADE');
  return gone;
}

const keyOf = (s) => `${s.thickness}|${s.length}|${s.width}|${s.gradeId != null ? `o${s.gradeId}` : `t${String(s.gradeText).trim().toUpperCase()}`}`;

// --- reading the line: its parts, its cut plates, and what points at what -------

/**
 * The line's temporary tree with its records, in one recursive query — the set
 * instantiationService.temporaryTree walks a level at a time (temporary
 * children only, to the same depth), joined to the rows mastersOf read. In id
 * order, which is the order the per-record reads came back in. UNION ALL, as
 * every recursive query here that runs on TiDB: a blank reached from several
 * parts comes back once per part, and the IN below counts it once. Each row
 * also carries what CUT_FROM is resolved from (kind, template definition) and
 * the section it names (its own and its definition's cut_stock_id).
 */
const TREE_SQL = `
  WITH RECURSIVE walk AS (
    SELECT CAST(? AS SIGNED) AS id, CAST(0 AS SIGNED) AS depth
     UNION ALL
    SELECT l.child_id, w.depth + 1
      FROM walk w
      JOIN cf_boms b ON b.company_id = ? AND b.parent_id = w.id AND b.deleted_at IS NULL
      JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
      JOIN cf_item_details i ON i.master_id = l.child_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
     WHERE w.depth < ?
  )
  SELECT m.id, m.code, m.name, m.status, m.classification_id, i.item_type, m.created_at,
         m.record_kind, m.cut_stock_id, i.source_definition_id,
         d.cut_stock_id AS def_cut_stock_id, d.code AS def_code, d.name AS def_name
    FROM cf_master_records m
    JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
    LEFT JOIN cf_master_records d ON d.id = i.source_definition_id AND d.deleted_at IS NULL
   WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.id IN (SELECT id FROM walk)
   ORDER BY m.id`;

/** The CUT_FROM answer of a resolved entry, as one of its three words (null = no answer). */
const cutWordOf = (e) => {
  const v = e?.optionValue ?? (typeof e?.value === 'string' ? e.value : null);
  const up = v == null ? null : String(v).toUpperCase();
  return CUT_FROM_VALUES.includes(up) ? up : null;
};

/**
 * Everything the reconcile works from: the line's temporaries and how each is
 * cut (CUT_FROM, resolved for all of them at once), the blanks their BOMs
 * already point at, the lines that join them, and the values each carries.
 * Four queries for a line with no section parts; two more when it has some.
 *
 * "Leaf" is not asked of the parts, because after one run they are not leaves
 * any more — each has gained its cut piece. What makes a part a part is its
 * CUT_FROM: PLATE or SECTION. A blank is never a part (it is filed at a
 * blanks place).
 *
 * Returns { items, resolved, cutFrom, candidates, plate: { parts, cutPlates,
 * links }, section: { parts, cutPlates, links, lines, steel }, and parts /
 * cutPlates / links — the plate ones, as callers have always read them }.
 */
async function survey(db, companyId, line, places) {
  if (line.line_type !== 'custom') {
    throw invalid('NO_STRUCTURE', `Line ${line.line_no} of ${line.order_code} sells a catalog item, so it has no structure of its own — only a line built from a template has parts to cut.`);
  }
  // The walk always holds the line's own item, so "no structure at all" cannot
  // be reached past the check above.
  const [items] = await db.query(TREE_SQL, [line.item_id, companyId, TREE_DEPTH, companyId]);
  const candidates = items.filter((m) => m.item_type === 'temporary' && !places.blankIds.has(m.classification_id));
  const resolved = await resolveCodes(db, companyId, candidates, [CUT_FROM_CODE, ...STEEL_FROM_STOCK]);
  const cutFrom = new Map(candidates.map((m) => [m.id, cutWordOf(resolved.get(m.id)?.get(CUT_FROM_CODE))]));
  const plateParts = candidates.filter((m) => cutFrom.get(m.id) === 'PLATE');
  const sectionParts = candidates.filter((m) => cutFrom.get(m.id) === 'SECTION');

  // The blanks this line's rows are cut from — asked of EVERY row, not only of
  // today's parts, so a row whose CUT_FROM changed is seen holding the blank of
  // its old method and lets go of it. A blank nothing points at is
  // deliberately out of scope: an unclaimed one is an offcut, and an offcut is
  // nobody's to delete.
  const [links] = candidates.length && places.blankIds.size ? await db.query(
    `SELECT l.id AS line_id, l.quantity, b.parent_id AS part_id, l.child_id AS cut_plate_id, l.created_at,
            m.classification_id AS blank_classification_id
       FROM cf_boms b
       JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.child_id AND m.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.parent_id IN (?) AND m.classification_id IN (?)
      ORDER BY l.id`,
    [companyId, candidates.map((p) => p.id), [...places.blankIds]],
  ) : [[]];

  const cutPlateIds = new Set(links.map((l) => l.cut_plate_id));
  const blanks = items.filter((m) => cutPlateIds.has(m.id));
  // A blank is a temporary child of the part it is cut from, so the walk has
  // it — unless the part sits at the very bottom of the walk's depth. Read
  // those the old way rather than lose them.
  const lost = [...cutPlateIds].filter((id) => !blanks.some((cp) => cp.id === id));
  if (lost.length) {
    const [more] = await db.query(
      `SELECT m.id, m.code, m.name, m.status, m.classification_id, i.item_type, m.created_at
         FROM cf_master_records m
         JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
        WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`,
      [companyId, lost],
    );
    blanks.push(...more);
    blanks.sort((a, b) => a.id - b.id);
  }
  const parts = [...plateParts, ...sectionParts];
  const values = await specValuesOf(db, companyId, [...parts.map((p) => p.id), ...blanks.map((cp) => cp.id)]);
  for (const m of [...parts, ...blanks]) {
    m.values = values.get(m.id) ?? new Map();
    m.size = sizeOf(m.values);
  }
  const sectionClass = places.all.section.blanksIds;
  const plate = {
    parts: plateParts,
    cutPlates: blanks.filter((b) => !sectionClass.has(b.classification_id)),
    links: links.filter((l) => !sectionClass.has(l.blank_classification_id)),
  };
  const section = {
    parts: sectionParts,
    cutPlates: blanks.filter((b) => sectionClass.has(b.classification_id)),
    links: links.filter((l) => sectionClass.has(l.blank_classification_id)),
    lines: { lines: new Map(), nested: new Set() },
    steel: new Map(),
  };
  if (section.parts.length || section.cutPlates.length) await surveySections(db, companyId, line, places, section);
  return { items, resolved, cutFrom, candidates, plate, section, parts: plate.parts, cutPlates: plate.cutPlates, links: plate.links };
}

/** The bar a section part names: its own cut_stock_id, else its template definition's. */
const partStockOf = (p) => (p.cut_stock_id != null ? Number(p.cut_stock_id) : p.def_cut_stock_id != null ? Number(p.def_cut_stock_id) : null);

/**
 * The section side of the survey: the bar each section part names, each
 * section blank's stock line, and the steel of every bar involved. Two
 * queries. Gives every section part `section` = { stockId, stock, length,
 * missing[] } and every section blank `section` = { stockId, stock, length },
 * both with `sizeKey` — the profile + length the reconcile pools by (null
 * while a part cannot say it).
 */
async function surveySections(db, companyId, line, places, section) {
  const stockPlaces = places.all.section.stockIds;
  section.lines = await plateLinesOf(db, companyId, line.id, section.cutPlates.map((cp) => cp.id));
  const blankStock = new Map();
  for (const cp of section.cutPlates) {
    const own = (section.lines.lines.get(cp.id) ?? []).find((l) => l.child_record_kind === 'item' && stockPlaces.has(l.child_classification_id));
    blankStock.set(cp.id, own ? Number(own.child_id) : null);
  }
  section.steel = await sectionSteelOf(db, companyId, [...section.parts.map(partStockOf), ...blankStock.values()]);
  for (const p of section.parts) {
    const stockId = partStockOf(p);
    const stock = stockId != null ? section.steel.get(stockId) ?? null : null;
    const length = p.size.length;
    const missing = [];
    if (stockId == null) missing.push('no section chosen');
    else if (!stock || !stockPlaces.has(Number(stock.classificationId))) missing.push(`${stock ? nameOf(stock) : `item ${stockId}`} is not a section in stock`);
    if (length == null || length <= 0) missing.push('no LENGTH');
    const stockOk = !!stock && stockPlaces.has(Number(stock.classificationId));
    p.section = { stockId, stock, length, missing, stockOk };
    p.sizeKey = missing.length ? null : `S|${profileKeyOf(stock)}|L${length}`;
  }
  for (const cp of section.cutPlates) {
    const stockId = blankStock.get(cp.id);
    const stock = stockId != null ? section.steel.get(stockId) ?? null : null;
    cp.section = { stockId, stock, length: cp.size.length };
    cp.sizeKey = stock && cp.size.length > 0 ? `S|${profileKeyOf(stock)}|L${cp.size.length}` : null;
  }
}

/**
 * Each existing cut plate's own BOM and its live lines, in line order — what
 * bomOfParent + linesOfBom read per blank — and whether an accepted nesting of
 * THIS line has laid it out (see NESTED_NOTE): a placement on one of the
 * line's lots names it (a plate lot for a cut plate, a bar lot for a cut
 * section). One query. Returns
 *   { lines: Map(cutPlateId -> [line]), nested: Set(cutPlateId) }
 */
async function plateLinesOf(db, companyId, orderLineId, cutPlateIds) {
  const lines = new Map(cutPlateIds.map((id) => [id, []]));
  const nested = new Set();
  if (!cutPlateIds.length) return { lines, nested };
  const [rows] = await db.query(
    `SELECT cp.id AS parent_id, l.id, l.line_no, l.child_id, l.design_id, l.position, l.quantity,
            l.selection_definition_id, ch.record_kind AS child_record_kind, ch.classification_id AS child_classification_id,
            EXISTS (SELECT 1 FROM cf_nest_placements np
                      JOIN cf_plate_lots pl ON pl.id = np.plate_lot_id AND pl.deleted_at IS NULL
                     WHERE np.company_id = cp.company_id AND np.cut_plate_id = cp.id
                       AND pl.order_line_id = ? AND np.deleted_at IS NULL) AS nested
       FROM cf_master_records cp
       LEFT JOIN cf_boms b ON b.company_id = cp.company_id AND b.parent_id = cp.id AND b.deleted_at IS NULL
       LEFT JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
       LEFT JOIN cf_master_records ch ON ch.id = l.child_id
      WHERE cp.company_id = ? AND cp.id IN (?)
      ORDER BY cp.id, l.line_no, l.id`,
    [orderLineId, companyId, cutPlateIds],
  );
  for (const r of rows) {
    if (Number(r.nested)) nested.add(Number(r.parent_id));
    if (r.id != null) lines.get(r.parent_id)?.push(r);
  }
  return { lines, nested };
}

/**
 * The plates lines hold, with their sizes — chosenPlate for many at once. Only
 * a live CATALOG item is a plate; anything else comes back absent, as it did.
 */
async function platesOf(db, companyId, ids) {
  const want = [...new Set(ids.filter((id) => id != null).map(Number))];
  const out = new Map();
  if (!want.length) return out;
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, x.code AS spec_code, x.value_number, x.value_text, x.option_id, x.option_value
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
       LEFT JOIN (SELECT v.subject_id, s.code, v.value_number, v.value_text, v.option_id, o.value AS option_value
                    FROM cf_spec_values v
                    JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
                    LEFT JOIN cf_spec_options o ON o.id = v.option_id
                   WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?)
                     AND v.deleted_at IS NULL AND s.code IN (?)) x ON x.subject_id = m.id
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`,
    [companyId, want, SPEC_CODES, companyId, want],
  );
  const values = new Map();
  for (const r of rows) {
    if (!out.has(r.id)) { out.set(r.id, { id: r.id, code: r.code, name: r.name }); values.set(r.id, new Map()); }
    if (r.spec_code != null) values.get(r.id).set(String(r.spec_code).toUpperCase(), r);
  }
  for (const p of out.values()) p.size = sizeOf(values.get(p.id));
  return out;
}

// --- how much raw plate one blank takes ----------------------------------------

/**
 * The area fraction. Returns what to write on the cut plate's plate line, and
 * says in words what the number rests on, because "1" and "0.104" mean very
 * different things and nobody should have to guess which they are looking at.
 */
function plateQuantity(size, plate) {
  const blankArea = size.length * size.width;
  if (!plate) {
    return { quantity: 1, basis: 'unresolved', note: 'Plate: chosen at nesting. Until the line is nested there is no plate to divide by, so this 1 is a placeholder, not an answer — nothing is bought from it. A plate can also be chosen by hand on the cut plate\'s BOM line.' };
  }
  const area = (plate.size.length ?? 0) * (plate.size.width ?? 0);
  if (!(area > 0)) {
    return { quantity: 1, basis: 'plate has no size', note: `${nameOf(plate)} has no LENGTH and WIDTH, so its area is unknown — this is a placeholder of one plate per blank. Give the plate its size.` };
  }
  const quantity = round6(blankArea / area);
  if (quantity > 1) {
    return { quantity, basis: 'area', note: `The blank (${fmt(size.length)} × ${fmt(size.width)}) is larger than ${nameOf(plate)} (${fmt(plate.size.length)} × ${fmt(plate.size.width)}) — it cannot be cut from one. Choose a bigger plate.` };
  }
  return { quantity, basis: 'area', note: null };
}

// --- the plan: what a derive would do, worked out without writing ----------------

/** The parts grouped by the blank they share. Refuses, naming the parts, when a size is not set. */
function group(parts) {
  const short = parts.filter((p) => missingOf(p.size).length);
  if (short.length) {
    const named = short.slice(0, 8).map((p) => `${nameOf(p)} (no ${list(missingOf(p.size))})`);
    throw invalid('NO_DIMENSIONS', `${short.length === 1 ? 'One part has' : `${short.length} parts have`} no size, so there is nothing to pool them by: ${named.join('; ')}${short.length > 8 ? ', …' : ''}. Give ${short.length === 1 ? 'it' : 'them'} a thickness, length, width and grade first.`);
  }
  const groups = new Map();
  for (const p of parts) {
    const key = keyOf(p.size);
    if (!groups.has(key)) groups.set(key, { key, size: p.size, parts: [] });
    groups.get(key).parts.push(p);
  }
  return [...groups.values()];
}

/**
 * Steps 1 and 2 of the reconcile, exactly as they ran one write at a time:
 *
 *   1. A part whose size no longer matches the blank it points at lets go of
 *      it. Doing this first frees a blank that nothing needs any more, so step
 *      3 can see it, and lets a part join the right group in step 2.
 *   2. One cut plate per group: the one its parts already point at, or a new
 *      one. A group that somehow split across two blanks is pulled back onto
 *      one. A new blank is placed under the group's first part; every other
 *      part of the group is attached to it.
 *   3. (candidates) A blank nothing is cut from any more.
 *
 * Returns the plan with no plate lines yet — planPlateLines adds them once the
 * plates they would hold are read.
 */
function planGroups({ parts, cutPlates, links }, { groupOf = group, keyOfRecord = (m) => keyOf(m.size) } = {}) {
  const groups = groupOf(parts);
  const partById = new Map(parts.map((p) => [p.id, p]));
  const byId = new Map(cutPlates.map((cp) => [cp.id, cp]));
  const drops = new Set();

  const liveLinks = [];
  for (const l of links) {
    const part = partById.get(l.part_id);
    const cp = byId.get(l.cut_plate_id);
    if (part && cp && keyOfRecord(part) != null && keyOfRecord(part) === keyOfRecord(cp)) liveLinks.push(l);
    else drops.add(l.line_id);
  }

  const used = new Set();
  const planned = [];
  for (const g of groups) {
    const inGroup = new Set(g.parts.map((p) => p.id));
    const held = liveLinks.filter((l) => inGroup.has(l.part_id));
    const cp = held.map((l) => byId.get(l.cut_plate_id)).find((x) => x && !used.has(x.id)) ?? null;
    if (cp) {
      used.add(cp.id);
      const has = new Set(held.filter((l) => l.cut_plate_id === cp.id).map((l) => l.part_id));
      for (const l of held) if (l.cut_plate_id !== cp.id) { drops.add(l.line_id); has.delete(l.part_id); }
      planned.push({ group: g, cp, isNew: false, first: g.parts[0], attachTo: g.parts.filter((p) => !has.has(p.id)) });
    } else {
      planned.push({ group: g, cp: null, isNew: true, first: g.parts[0], attachTo: g.parts.slice(1) });
    }
  }
  return { groups: planned, drops, orphans: cutPlates.filter((cp) => !used.has(cp.id)) };
}

/** The lines of a blank's BOM that are its plate line — the selection's. */
const ownLines = (lines, selection) => lines.filter((l) => l.selection_definition_id === selection.id || l.design_id === selection.id);

/** The plates the plan reads: every plate line's plate, and the default candidate. */
function platesWanted(plan, plateLines, selection, pick) {
  const ids = pick ? [pick.id] : [];
  for (const x of plan.groups) {
    if (x.isNew) continue;
    const keep = ownLines(plateLines.lines.get(x.cp.id) ?? [], selection)[0];
    if (keep && keep.child_record_kind === 'item') ids.push(keep.child_id);
  }
  return ids;
}

/**
 * The cut plate's own BOM: exactly one line, the plate selection, at the area
 * fraction. Creates it, or moves the quantity when the parts or the chosen
 * plate changed. Never a second line, however often this runs. Anything else
 * somebody put under a cut plate is left alone and reported: this service owns
 * the plate line, not the whole BOM.
 *
 * Still nothing chosen: the line keeps the selection — "chosen at nesting".
 * `pick` (the selection's default candidate) is always null since 2026-09-30
 * (CF_ERP_ORDER_FLOW_PLAN); the path is kept only so a revision's carried
 * plate is written the same way. A plate a PERSON chose is never
 * second-guessed. Laid out by an accepted
 * nesting: the plate and the quantity are the nesting's answer — touch neither.
 *
 * `carried` (a revision only — refreshCutPieces' `carry`): per group key, what
 * was chosen for that rectangle on the line this one replaces — { plateId,
 * flowId }. A new blank of that rectangle is cut from that plate before the
 * selection's default, so the choice somebody (or nesting) made is not lost to
 * the revision; its quantity is the area fraction again, because nesting
 * follows lock. Its flow is written with it (applyPlan).
 */
function planPlateLines(plan, plateLines, { selection, pick, plates, carried = null }) {
  const { nested } = plateLines;
  for (const x of plan.groups) {
    const lines = x.isNew ? [] : (plateLines.lines.get(x.cp.id) ?? []);
    const own = ownLines(lines, selection);
    const otherLines = lines.length - own.length;
    const keep = own[0] ?? null;
    for (const dup of own.slice(1)) plan.drops.add(dup.id);

    if (!keep) {
      const was = carried?.get(x.group.key) ?? null;
      if (x.isNew && was?.flowId != null) x.carriedFlowId = was.flowId;
      const picked = (was?.plateId != null ? plates.get(Number(was.plateId)) ?? null : null) ?? (pick ? plates.get(Number(pick.id)) ?? null : null);
      const q = plateQuantity(x.group.size, picked);
      x.plateLine = { ...q, plate: brief(picked), changed: true, otherLines, add: { childId: picked?.id ?? selection.id, quantity: q.quantity } };
      continue;
    }
    if (nested.has(Number(x.cp.id))) {
      const plate = keep.child_record_kind === 'item' ? plates.get(Number(keep.child_id)) ?? null : null;
      x.plateLine = { quantity: round6(Number(keep.quantity)), basis: 'nesting', note: NESTED_NOTE, plate: brief(plate), changed: false, otherLines };
      continue;
    }
    let chosenId = keep.child_record_kind === 'item' ? keep.child_id : null;
    let fill = null;
    if (chosenId == null && pick) { fill = pick.id; chosenId = pick.id; }
    const plate = chosenId ? plates.get(Number(chosenId)) ?? null : null;
    const q = plateQuantity(x.group.size, plate);
    const changed = fill != null || Math.abs(Number(keep.quantity) - q.quantity) > 1e-9;
    x.plateLine = { ...q, plate: brief(plate), changed, otherLines, update: changed ? { lineId: keep.id, childId: fill, quantity: q.quantity } : null };
  }
}

/**
 * Whether a method's plan writes anything. A blank nothing is cut from any
 * more only appears when some line was let go of, so the drops cover it.
 */
const writesKind = (plan) => !!plan && (plan.drops.size > 0 || plan.groups.some((x) => x.isNew || x.attachTo.length > 0 || x.plateLine?.changed));
/** Whether the whole plan (both methods) writes anything. */
const writes = (plan) => (plan.plate || plan.section ? writesKind(plan.plate) || writesKind(plan.section) : writesKind(plan));

const EMPTY_PLAN = () => ({ groups: [], drops: new Set(), orphans: [] });

/** Both methods' plans as one: `groups` is every group, plate ones first. */
const combined = (plate, section) => {
  for (const x of plate.groups) x.kind = 'plate';
  for (const x of section.groups) x.kind = 'section';
  return { plate, section, groups: [...plate.groups, ...section.groups] };
};

/**
 * The plate method's plan, from what survey() read: the plate lines, the
 * default candidate and the plates, then the reconcile. `carried` — see
 * planPlateLines. No plate part and no plate blank: an empty plan, no query.
 */
async function planPlateFor(db, companyId, { line, st, selection, carried = null }) {
  if (!st.parts.length && !st.cutPlates.length) return EMPTY_PLAN();
  const plan = planGroups(st);
  if (!plan.groups.length) return plan;     // only blanks to let go of: no plate line to read
  const plateLines = await plateLinesOf(db, companyId, line.id, st.cutPlates.map((cp) => cp.id));
  // NO DEFAULT PLATE (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30): "how are the cut pieces
  // showing the plates that happens in the next step of nesting?" A new blank's
  // plate line holds the SELECTION — chosen at nesting — never the selection's
  // default candidate. A plate already on a line (chosen by a person, by an
  // earlier default, or carried by a revision) stays: it acts as a chosen plate.
  const pick = null;
  const plates = await platesOf(db, companyId, [...platesWanted(plan, plateLines, selection, pick), ...(carried ? [...carried.values()].map((v) => v.plateId) : [])]);
  planPlateLines(plan, plateLines, { selection, pick, plates, carried });
  return plan;
}

/**
 * The whole plan: the plate method's, then the section method's (which needs
 * no query of its own — survey read its lines and steel). `carried` — see
 * planPlateLines; for sections only the flow is carried.
 */
async function planFor(db, companyId, { line, state, selection, places, carried = null }) {
  const plate = await planPlateFor(db, companyId, { line, st: state.plate, selection, carried });
  const section = planSectionFor({ st: state.section, places, carried });
  return combined(plate, section);
}

// --- the section method ------------------------------------------------------------

const SECTION_NESTED_NOTE = 'This quantity comes from the accepted section nesting — the real share of the bar it is cut from, offcut and kerf included — not length ÷ stock length. Nesting the line again is what changes it.';
export const BAR_FRACTION_CAVEAT = 'The bar quantity is the cut length divided by the stock length — it ignores the saw kerf, the end trim and the leftover, so it is a first answer, not a cutting plan. Section nesting replaces it with the real bars; release rounds it up per section until then.';

/**
 * The section parts pooled by the blank they share: the same profile (the same
 * bar in any stock length) and the same cut length. Refuses, naming the parts,
 * while one has no section, no length, or names something that is not a stock
 * bar — the way the plate method refuses a part with no size.
 */
function sectionGroup(parts) {
  const short = parts.filter((p) => p.section?.missing?.length);
  if (short.length) {
    const named = short.slice(0, 8).map((p) => `${nameOf(p)} (${list(p.section.missing)})`);
    throw invalid('NO_SECTION', `${short.length === 1 ? 'One part is' : `${short.length} parts are`} cut from a section but cannot be pooled into a cut section yet: ${named.join('; ')}${short.length > 8 ? ', …' : ''}. Choose the section ${short.length === 1 ? 'it is' : 'each is'} cut from (a stock bar) and give ${short.length === 1 ? 'it' : 'them'} a length first.`);
  }
  const groups = new Map();
  for (const p of parts) {
    if (!groups.has(p.sizeKey)) groups.set(p.sizeKey, { key: p.sizeKey, size: p.size, section: { stock: p.section.stock, length: p.section.length }, parts: [] });
    groups.get(p.sizeKey).parts.push(p);
  }
  return [...groups.values()];
}

/** How much stock bar one cut section takes before nesting: length ÷ stock length, in words when it cannot be. */
function barQuantity(length, stock) {
  if (!(Number(stock?.lengthMm) > 0)) {
    return { quantity: 1, basis: 'stock has no length', note: `${stock ? nameOf(stock) : 'The stock bar'} has no LENGTH, so how many cut pieces one bar gives is unknown — this is a placeholder of one bar per piece. Give the bar its length.` };
  }
  const quantity = round6(length / stock.lengthMm);
  if (quantity > 1) {
    return { quantity, basis: 'length', note: `The cut length (${fmt(length)}) is longer than ${nameOf(stock)} (${fmt(stock.lengthMm)}) — it cannot be cut from one bar. Choose a longer stock length.` };
  }
  return { quantity, basis: 'length', note: null };
}

/**
 * The section method's plan: the same reconcile (planGroups) pooled by profile
 * + length, then each blank's stock line — exactly one, to the bar its group's
 * first part names, at length ÷ stock length. Follows a part that changed its
 * bar to another stock length of the same profile (child and quantity move);
 * never touches a line an accepted section nesting laid out.
 */
function planSectionFor({ st, places, carried = null }) {
  if (!st.parts.length && !st.cutPlates.length) return EMPTY_PLAN();
  const plan = planGroups(st, { groupOf: sectionGroup, keyOfRecord: (m) => m.sizeKey ?? null });
  const stockPlaces = places.all.section.stockIds;
  const { lines, nested } = st.lines;
  for (const x of plan.groups) {
    const all = x.isNew ? [] : (lines.get(x.cp.id) ?? []);
    const own = all.filter((l) => l.child_record_kind === 'item' && stockPlaces.has(l.child_classification_id));
    const otherLines = all.length - own.length;
    const keep = own[0] ?? null;
    for (const dup of own.slice(1)) plan.drops.add(dup.id);
    const stock = x.first.section.stock;
    const q = barQuantity(x.group.section.length, stock);
    if (!keep) {
      const was = carried?.get(x.group.key) ?? null;
      if (x.isNew && was?.flowId != null) x.carriedFlowId = was.flowId;
      x.plateLine = { ...q, plate: brief(stock), changed: true, otherLines, add: { childId: stock.id, quantity: q.quantity } };
      continue;
    }
    if (nested.has(Number(x.cp.id))) {
      const held = st.steel.get(Number(keep.child_id)) ?? { id: keep.child_id, code: null, name: null };
      x.plateLine = { quantity: round6(Number(keep.quantity)), basis: 'nesting', note: SECTION_NESTED_NOTE, plate: brief(held), changed: false, otherLines };
      continue;
    }
    const changed = Number(keep.child_id) !== Number(stock.id) || Math.abs(Number(keep.quantity) - q.quantity) > 1e-9;
    x.plateLine = { ...q, plate: brief(stock), changed, otherLines, update: changed ? { lineId: keep.id, childId: stock.id, quantity: q.quantity } : null };
  }
  return plan;
}

// --- writing the plan ------------------------------------------------------------

/**
 * What a blank filed at CUT_PLATE takes and needs, answered once for the
 * derive — every blank here is filed at the same node, so its rules are the
 * node's (a blank has no template definition, and no rules of its own yet).
 *
 *   extras   what its chain requires beyond the four sizes (the steel it must
 *            ask the part for) — the filter it has always used
 *   item     its item-level rules by spec code: what setValues checks a typed
 *            value against
 */
async function blankRulesAt(db, companyId, nodeId, sizeCodes = SPEC_CODES) {
  const view = await resolveSpecs(db, companyId, { nodeId });
  const specs = view.specs ?? [];
  const extras = specs
    .filter((e) => e.applicable && e.rule?.isRequired && e.rule?.valueRule === 'entered' && !sizeCodes.includes(e.spec.code))
    .map((e) => e.spec.code);
  const item = new Map(specs.filter((s) => s.captureAt === 'item').map((s) => [String(s.spec.code).toUpperCase(), s]));
  return { extras, item };
}

/** valueService.snapshot — what a history row records. */
function snapshot(row, source, uom) {
  if (!row) return null;
  return {
    number: row.value_number == null ? null : Number(row.value_number),
    text: row.value_text ?? null,
    bool: row.value_bool == null ? null : !!Number(row.value_bool),
    date: dateText(row.value_date),
    option_id: row.option_id ?? null,
    uom: uom ?? row.uom ?? null,
    source: source ?? row.source,
  };
}

/**
 * setValues' checks and valueService.coerce, for one value typed onto a new
 * blank — the same rules in the same order with the same words, answered from
 * the node's rules and the spec's options already read. Returns { typed } (null
 * typed writes nothing — the blank has no value to clear) or { problem }.
 */
function coerceOnto(rule, code, input, options) {
  if (!rule || !rule.applicable) return { problem: `${code} is not part of this item's setup.` };
  const vr = rule.rule.valueRule;
  if (vr === 'fixed') return { problem: `${rule.spec.code} is fixed at ${rule.definedAt.level.toLowerCase()} level — change it there.` };
  if (['calculated', 'rollup', 'inherited'].includes(vr)) return { problem: `${rule.spec.code} is ${vr} — it cannot be typed in.` };
  const spec = rule.spec;
  if (input === null || input === undefined || input === '') return { typed: null };
  switch (spec.dataType) {
    case 'number': {
      const n = typeof input === 'number' ? input : Number(String(input).trim());
      if (!Number.isFinite(n)) return { problem: `${spec.code} needs a number.` };
      if (Math.abs(n) >= 1e18) return { problem: `${spec.code} is too large.` };
      return { typed: { ...EMPTY, value_number: Number(n.toFixed(6)) } };
    }
    case 'text': {
      const s = String(input).trim();
      if (s.length > 500) return { problem: `${spec.code} is longer than 500 characters.` };
      return { typed: s ? { ...EMPTY, value_text: s } : null };
    }
    case 'boolean': {
      const s = String(input).trim().toLowerCase();
      if ([true, 1, '1', 'true', 'yes', 'y'].includes(input) || ['true', 'yes', 'y', '1'].includes(s)) return { typed: { ...EMPTY, value_bool: 1 } };
      if ([false, 0, '0', 'false', 'no', 'n'].includes(input) || ['false', 'no', 'n', '0'].includes(s)) return { typed: { ...EMPTY, value_bool: 0 } };
      return { problem: `${spec.code} is yes or no.` };
    }
    case 'date': {
      const s = String(input).trim();
      const d = new Date(`${s}T00:00:00`);
      if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || dateText(d) !== s) return { problem: `${spec.code} needs a date as YYYY-MM-DD.` };
      return { typed: { ...EMPTY, value_date: s } };
    }
    case 'option': {
      const all = options.get(spec.id) ?? [];
      const found = all.find((o) => o.id === Number(input))
        ?? all.find((o) => o.value.toLowerCase() === String(input).trim().toLowerCase());
      if (!found) return { problem: `"${input}" is not an option of ${spec.code}.` };
      if (found.status !== 'active') return { problem: `Option ${found.value} of ${spec.code} is retired.` };
      const allowed = rule.options ? new Set(rule.options.map((o) => o.id)) : null;
      if (allowed && allowed.size && !allowed.has(found.id)) return { problem: `${found.value} is not allowed for ${spec.code} here.` };
      return { typed: { ...EMPTY, option_id: found.id } };
    }
    default:
      return { problem: `${spec.code} has an unknown data type.` };
  }
}

/**
 * The values every new blank is given: its four sizes, then whatever else its
 * chain requires, copied from the group's first part. Everything it needs is
 * read here, once; `check(x)` then works out one group's values, or refuses
 * with the words setValues used — called group by group, before anything is
 * written, so the refusal is the one the one-at-a-time derive gave.
 */
async function blankValueChecker(db, companyId, fresh, desc) {
  const rules = await blankRulesAt(db, companyId, desc.nodeId, desc.sizeCodes);

  // Every option of the option specs being written, retired ones too, so a
  // refusal names the same reason coerce gives.
  const codes = [...desc.sizeCodes, ...rules.extras];
  const optionSpecIds = codes.map((code) => rules.item.get(code.toUpperCase())).filter((r) => r?.applicable && r.spec.dataType === 'option').map((r) => r.spec.id);
  const options = new Map();
  if (optionSpecIds.length) {
    const [rows] = await db.query(
      'SELECT id, specification_id, value, label, status FROM cf_spec_options WHERE company_id = ? AND specification_id IN (?) AND deleted_at IS NULL',
      [companyId, [...new Set(optionSpecIds)]],
    );
    for (const o of rows) {
      if (!options.has(o.specification_id)) options.set(o.specification_id, []);
      options.get(o.specification_id).push(o);
    }
  }

  // A code no rule mentions may not exist at all — setValues says which.
  let known = null;
  const unknownOr = async (code) => {
    if (!known) {
      const [rows] = await db.query('SELECT UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, codes]);
      known = new Set(rows.map((r) => r.code));
    }
    return known.has(code.toUpperCase()) ? null : `Unknown specification ${code}.`;
  };

  let alwaysRead = null;
  const alwaysSpecs = async () => {
    if (!alwaysRead) {
      const [rows] = await db.query('SELECT id, UPPER(code) AS code, data_type, default_uom FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, desc.alwaysCodes]);
      alwaysRead = new Map(rows.map((r) => [r.code, r]));
    }
    return alwaysRead;
  };

  const typed = async (entries) => {
    const problems = [];
    const out = [];
    for (const e of entries) {
      const rule = rules.item.get(e.code.toUpperCase());
      if (!rule) {
        problems.push((await unknownOr(e.code)) ?? `${e.code} is not part of this item's setup.`);
        continue;
      }
      const r = coerceOnto(rule, rule.spec.code, e.value, options);
      if (r.problem) problems.push(r.problem);
      else if (r.typed) out.push({ spec: rule.spec, typed: r.typed });
    }
    return { problems, out };
  };

  const check = async (x) => {
    // A cut plate is given its four sizes, every one required where it is
    // filed. A cut section is given what its place takes of its bar's size and
    // its length — a spec its place does not apply (or works out itself) is
    // simply not written there.
    let entries = desc.sizeEntries(x);
    const raw = [];
    if (!desc.strict) {
      entries = entries.filter((e) => {
        if (e.value == null || e.value === '') return false;
        const rule = rules.item.get(e.code.toUpperCase());
        const typable = rule && rule.applicable && ['entered', 'defaulted'].includes(rule.rule.valueRule);
        // SECTION_AREA and DENSITY are what a cut section is weighed by (the
        // ledger, valuation): written even where its place has no rule for them.
        if (!typable && (desc.alwaysCodes ?? []).includes(e.code) && (!rule || rule.applicable)) raw.push(e);
        return typable;
      });
    }
    const sizes = await typed(entries);
    if (raw.length) {
      const specs = await alwaysSpecs();
      for (const e of raw) {
        const sp = specs.get(e.code);
        const n = Number(e.value);
        if (sp && sp.data_type === 'number' && Number.isFinite(n)) sizes.out.push({ spec: { id: sp.id, code: sp.code, unit: sp.default_uom ?? null, dataType: 'number' }, typed: { ...EMPTY, value_number: Number(n.toFixed(6)) } });
      }
    }
    if (sizes.problems.length) {
      throw invalid(desc.kind === 'plate' ? 'CUT_PLATE_SPECS' : 'CUT_SECTION_SPECS', desc.kind === 'plate'
        ? 'A cut plate cannot be given its size where cut plates are filed — the four specifications have to be set there, the way they are for bought plates.'
        : 'A cut section cannot be given its size where cut sections are filed — the rules there refuse the bar\'s own values.', { problems: sizes.problems });
    }
    // Any part of the pool can say what steel this is — they are pooled
    // BECAUSE they share thickness, length, width and grade — so the first one
    // is the blank's source for anything else its own classification requires.
    // Its stored values were read with its sizes (survey).
    const theirs = x.first.values ?? new Map();
    const asked = rules.extras
      .map((code) => {
        const row = theirs.get(String(code).toUpperCase());
        return { code, value: row ? rawOf(row, row.data_type) : null };
      })
      .filter((e) => !(e.value == null || e.value === ''));   // the part cannot say either
    const steel = await typed(asked);
    if (steel.problems.length) {
      throw invalid(desc.kind === 'plate' ? 'CUT_PLATE_INHERIT' : 'CUT_SECTION_INHERIT', `A ${desc.noun} could not take ${asked.map((w) => w.code).join(', ')} from the part it is cut from — the rule where ${desc.noun}s are filed does not accept the part's own answer.`, { problems: steel.problems });
    }
    x.values = [...sizes.out, ...steel.out];
  };
  /**
   * An EXISTING blank's steel gaps: what its chain requires that it holds no
   * value for and one of its parts can answer. Only ever fills — a value the
   * blank already has is never touched. A part that cannot answer leaves the
   * gap (and the Values stage keeps saying so). Returns [{ spec, typed }].
   */
  const fill = async (x) => {
    const own = x.cp.values ?? new Map();
    const gaps = rules.extras.filter((code) => {
      const row = own.get(String(code).toUpperCase());
      return !row || rawOf(row, row.data_type) == null || rawOf(row, row.data_type) === '';
    });
    if (!gaps.length) return [];
    const asked = [];
    for (const code of gaps) {
      for (const part of x.group.parts) {
        const row = (part.values ?? new Map()).get(String(code).toUpperCase());
        const value = row ? rawOf(row, row.data_type) : null;
        if (value != null && value !== '') { asked.push({ code, value }); break; }
      }
    }
    const steel = await typed(asked);
    return steel.out;                                       // a part's answer the rule refuses stays a gap
  };
  return { rules, options, check, fill };
}

/**
 * What a new blank was just given, in the shape the code generator reads
 * (resolutionService.effectiveByCode). An entered value IS the effective one —
 * setValues refuses to type a fixed, calculated, rolled-up or inherited spec —
 * so a code printing only these needs nothing read back.
 */
function typedSpecs(x, options) {
  const out = new Map();
  for (const w of x.values ?? []) {
    const dt = w.spec.dataType;
    const raw = rawOf(w.typed, dt);
    if (raw === null) continue;
    const option = dt === 'option' ? (options.get(w.spec.id) ?? []).find((o) => o.id === raw) : null;
    out.set(w.spec.code, {
      raw, dataType: dt, optionValue: option ? option.value : null, display: option ? (option.label || option.value) : String(raw),
    });
  }
  return out;
}

/**
 * The item-level values a new blank holds once its values are settled, keyed
 * by spec code as the code generator reads them (resolutionService
 * effectiveByCode). Freshly written and freshly materialised, a new blank's
 * stored values ARE its effective ones; only specs its node applies at item
 * level are offered, as a resolution would. One query for every new blank.
 */
async function effectiveOf(db, companyId, ids, rules) {
  const out = new Map(ids.map((id) => [id, new Map()]));
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT v.*, s.code AS spec_code, s.data_type, o.value AS option_value, o.label AS option_label
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL`,
    [companyId, ids],
  );
  for (const r of rows) {
    const rule = rules.item.get(String(r.spec_code).toUpperCase());
    if (!rule || !rule.applicable || rule.spec.id !== r.specification_id) continue;
    const raw = rawOf(r, r.data_type);
    if (raw === null) continue;
    const optionValue = r.data_type === 'option' ? r.option_value ?? null : null;
    out.get(r.subject_id)?.set(rule.spec.code, {
      raw, dataType: r.data_type, optionValue, display: r.data_type === 'option' ? (r.option_label || r.option_value || `#${raw}`) : String(raw),
    });
  }
  return out;
}

/**
 * Names and codes for the new blanks, as createCutPlate gave them: a naming
 * rule's name or the fallback, then a coding rule's code — or none, while a
 * value its code needs is missing (a draft may wait, decision Q21).
 *
 * Each blank is coded as it stood when it was made: sitting on ONE line, its
 * first part's, with the values it was given. So the context carries that line
 * and the range it covers there, not the shared placement it has now. The
 * rules are read once for all of them (readRulesOnce); a dry pass says whether
 * a rule reads `range`, and only then are the first parts' lines read.
 */
async function nameAndCode(db, c, { line, desc, blankRules, fresh }) {
  const { companyId } = c;
  const memo = readRulesOnce(db);
  const chain = await ancestors(db, companyId, desc.nodeId);
  let stored = null;
  const effective = async () => {
    if (!stored) stored = await effectiveOf(db, companyId, fresh.map((x) => x.cp.id), blankRules.rules);
    return stored;
  };
  const owner = { line_no: line.line_no, position: line.position, order_code: line.order_code, order_title: line.order_title };

  let ranges = null;
  const rangeOf = async (x) => {
    if (!ranges) {
      const [rows] = await db.query(
        `SELECT l.id, l.bom_id, b.parent_id, b.bom_type, l.line_no, l.position, l.quantity, l.role, l.child_id,
                ch.code AS child_code, ch.name AS child_name, ch.short_name AS child_short_name,
                ch.record_kind AS child_record_kind, ci.item_type AS child_item_type,
                sd.name AS def_name, sd.short_name AS def_short_name
           FROM cf_bom_lines l
           JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
           JOIN cf_master_records ch ON ch.id = l.child_id
           LEFT JOIN cf_item_details ci ON ci.master_id = l.child_id AND ci.deleted_at IS NULL
           LEFT JOIN cf_master_records sd ON sd.id = ci.source_definition_id AND sd.deleted_at IS NULL
          WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.bom_id IN (?)
          ORDER BY l.bom_id, l.line_no, l.id`,
        [companyId, [...new Set(fresh.map((f) => f.place.bomId))]],
      );
      // As each blank was made: its own line, never another new blank's —
      // those parts' blanks did not exist yet (a part is in one group only).
      ranges = rows;
    }
    const mine = ranges.filter((r) => r.bom_id === x.place.bomId && !(r.child_id !== x.cp.id && fresh.some((f) => f.cp.id === r.child_id)));
    const at = mine.find((r) => r.child_id === x.cp.id);
    return at ? rangesOf(mine).get(at.id) ?? null : null;
  };

  const written = [];
  for (const x of fresh) {
    const size = x.group.size;
    const data = {
      master: {
        id: x.cp.id, company_id: companyId, record_kind: 'item', item_type: 'temporary', code: null, name: '(pending)',
        short_name: desc.shortName, classification_id: desc.nodeId, status: 'draft', owner_order_line_id: line.id, source_definition_id: null,
      },
      def: null,
      chain,
      specs: typedSpecs(x, blankRules.options),
      owner,
      place: {
        line_id: null, bom_id: x.place.bomId, line_no: x.place.lineNo, position: x.place.position, quantity: 1, role: 'Cut from',
        parent_id: x.first.id, parent_code: x.first.code, parent_name: x.first.name,
      },
      range: null,
      asked: new Set(),
    };
    const draft = { draft: { [PLACED]: data } };
    // A dry pass says which tokens the rule reads; only then is anything more
    // read — the range its line covers, or a value it was not just given.
    const render = async (field) => {
      data.asked = new Set();
      const dry = await generate(memo, companyId, 'item', field, draft, { consume: false });
      if (!dry) return null;
      if (data.asked.has('range') && !data.rangeRead) { data.range = await rangeOf(x); data.rangeRead = true; }
      if (!data.specsRead && [...data.asked].some((k) => k.startsWith('spec:') && !data.specs.has(k.slice(5).toUpperCase()))) {
        data.specs = (await effective()).get(x.cp.id) ?? new Map();
        data.specsRead = true;
      }
      data.asked = new Set();
      return generate(memo, companyId, 'item', field, draft, { consume: true });
    };

    const fallbackName = desc.fallbackName(x, size);
    const named = await render('name').catch(() => null);
    const name = named?.text || fallbackName;
    data.master = { ...data.master, name };
    let code = null;
    try {
      const coded = await render('code');
      if (coded?.text) code = coded.text;
    } catch (err) {
      // A draft may stand without a code until a rule applies (decision Q21).
      if (err.code !== 'TOKEN_MISSING') throw err;
    }
    x.cp = { ...x.cp, name, code };
    written.push([x.cp.id, name, code]);
  }
  if (Number(line.order_revision) > 1) {
    const moved = await revisionCodes(db, companyId, line, written);
    for (const x of fresh) if (moved.has(x.cp.id)) x.cp = { ...x.cp, code: moved.get(x.cp.id) };
  }

  for (let i = 0; i < written.length; i += 100) {
    const part = written.slice(i, i + 100);
    const params = [];
    const names = part.map(([id, name]) => { params.push(id, name); return 'WHEN ? THEN ?'; }).join(' ');
    const codes = part.map(([id, , code]) => { params.push(id, code); return 'WHEN ? THEN ?'; }).join(' ');
    params.push(companyId, part.map(([id]) => id));
    await db.query(`UPDATE cf_master_records SET name = CASE id ${names} END, code = CASE id ${codes} END WHERE company_id = ? AND id IN (?)`, params);
  }
}

/**
 * A REVISION's cut plates (init.sql §27). The rule prints the same code for the
 * same rectangle on the same line of the same order — and the revision it
 * replaced keeps its own cut plates, codes and all, exactly as they were. A
 * code is unique among live records, so where the plain code is still held by
 * a cut plate of an EARLIER revision of this order, this revision's carries its
 * revision number at the end: …-E250-R2. Anything else holding the code is a
 * real clash, which the database refuses as it always has. One query, and only
 * for a revision. Rewrites `written` in place; returns id -> the code it now has.
 */
async function revisionCodes(db, companyId, line, written) {
  const moved = new Map();
  const coded = written.filter(([, , code]) => code);
  if (!coded.length) return moved;
  const [held] = await db.query(
    `SELECT m.code_active AS code
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL AND i.item_type = 'temporary'
       JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
       JOIN cf_sales_orders o ON o.id = ol.order_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.code_active IN (?)
        AND o.company_id = ? AND o.code_active = LOWER(?) AND o.revision < ?`,
    [companyId, coded.map(([, , code]) => String(code).toLowerCase()), companyId, line.order_code, Number(line.order_revision)],
  );
  const taken = new Set(held.map((h) => h.code));
  for (const w of written) {
    if (!w[2] || !taken.has(String(w[2]).toLowerCase())) continue;
    w[2] = `${w[2]}-R${Number(line.order_revision)}`;
    moved.set(w[0], w[2]);
  }
  return moved;
}

/**
 * instantiationService.deleteTemporaryTree for several blanks at once: each
 * with everything below it that nothing else holds — values (with history),
 * item-level rules, Custom BOMs and their lines, detail and master rows. A
 * shared item below one stays, with its own structure (the root always goes).
 * Code numbers are never given back.
 */
async function deleteTrees(db, c, rootIds) {
  const { companyId } = c;
  const all = await temporaryTree(db, companyId, rootIds);
  const roots = new Set(rootIds.map(Number));
  const inTree = new Set(all);
  const below = all.filter((id) => !roots.has(id));
  let ids = all;
  if (below.length) {
    const [rows] = await db.query(
      `SELECT DISTINCT l.child_id, b.parent_id
         FROM cf_bom_lines l
         JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.child_id IN (?)`,
      [companyId, below],
    );
    const held = [...new Set(rows.filter((r) => !inTree.has(Number(r.parent_id))).map((r) => Number(r.child_id)))];
    if (held.length) {
      const keep = new Set(await temporaryTree(db, companyId, held));
      ids = all.filter((id) => roots.has(id) || !keep.has(id));
    }
  }
  const [vals] = await db.query(
    `SELECT v.* FROM cf_spec_values v
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL`,
    [companyId, ids],
  );
  if (vals.length) {
    await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, vals.map((v) => v.id)]);
    await insertRows(db, 'cf_spec_value_history',
      ['company_id', 'value_id', 'specification_id', 'subject_type', 'subject_id', 'change_type', 'old_value', 'new_value', 'changed_by'],
      vals.map((v) => [companyId, v.id, v.specification_id, 'master', v.subject_id, 'delete', JSON.stringify(snapshot(v)), null, c.userId]));
  }
  await db.query(
    `UPDATE cf_spec_assignment_options ao JOIN cf_spec_assignments a ON a.id = ao.assignment_id
        SET ao.deleted_at = NOW()
      WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id IN (?) AND ao.deleted_at IS NULL`,
    [companyId, ids],
  );
  await db.query("UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL", [companyId, ids]);
  await db.query(
    `UPDATE cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id
        SET l.deleted_at = NOW()
      WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL AND l.deleted_at IS NULL`,
    [companyId, ids],
  );
  await db.query('UPDATE cf_boms SET deleted_at = NOW() WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL', [companyId, ids]);
  await db.query('UPDATE cf_item_details SET deleted_at = NOW() WHERE company_id = ? AND master_id IN (?)', [companyId, ids]);
  await db.query('UPDATE cf_master_records SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, ids]);
}

/**
 * The loop rule, for every existing blank that gains parts: a part may never
 * end up inside its own blank. (A blank legitimately has several parents, so
 * the identity rule that stops a line changing what it holds does not apply —
 * only this one.) A new blank has nothing under it yet when its parts are
 * attached, so only existing ones are asked. One query; `check(x)` per group.
 */
async function loopChecker(db, companyId, plan) {
  const asked = plan.groups.filter((x) => !x.isNew && x.attachTo.length);
  const below = new Map();
  const check = (x) => {
    if (x.isNew || !x.attachTo.length) return;
    const under = below.get(x.cp.id);
    const caught = under && x.attachTo.find((p) => under.has(p.id));
    if (caught) throw invalid('LOOP', `${nameOf(x.cp)} already contains ${nameOf(caught)} further down — it cannot also be cut from it.`);
  };
  if (!asked.length) return { check };
  const [rows] = await db.query(
    `WITH RECURSIVE d AS (
       SELECT b.parent_id AS seed, l.child_id AS id, CAST(1 AS SIGNED) AS depth
         FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
        WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL
        UNION ALL
       SELECT d.seed, l.child_id, d.depth + 1
         FROM d
         JOIN cf_boms b ON b.company_id = ? AND b.parent_id = d.id AND b.deleted_at IS NULL
         JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
        WHERE d.depth < ?
     )
     SELECT DISTINCT seed, id FROM d`,
    [companyId, asked.map((x) => x.cp.id), companyId, LOOP_DEPTH],
  );
  for (const r of rows) {
    if (!below.has(r.seed)) below.set(r.seed, new Set());
    below.get(r.seed).add(r.id);
  }
  return { check };
}

/**
 * Writes the plan, a fixed number of statements whatever its size. Everything
 * that can be refused is refused before the first write.
 */
/** New value rows on blanks with their history, as setValues writes them. given: [{ subjectId, spec, typed }]. 3 statements. */
async function insertBlankValues(db, c, given) {
  const { companyId } = c;
  if (!given.length) return;
  await insertRows(db, 'cf_spec_values',
    ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_number', 'value_text', 'value_bool', 'value_date', 'option_id', 'uom', 'source', 'created_by'],
    given.map((w) => [companyId, w.spec.id, 'master', w.subjectId, w.typed.value_number, w.typed.value_text, w.typed.value_bool,
      w.typed.value_date, w.typed.option_id, w.spec.unit ?? null, 'entered', c.userId]));
  const [back] = await db.query(
    `SELECT id, subject_id, specification_id FROM cf_spec_values
      WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND specification_id IN (?) AND deleted_at IS NULL`,
    [companyId, [...new Set(given.map((w) => w.subjectId))], [...new Set(given.map((w) => w.spec.id))]],
  );
  const idOf = new Map(back.map((r) => [`${r.subject_id}:${r.specification_id}`, r.id]));
  await insertRows(db, 'cf_spec_value_history',
    ['company_id', 'value_id', 'specification_id', 'subject_type', 'subject_id', 'change_type', 'old_value', 'new_value', 'changed_by'],
    given.map((w) => {
      const valueId = idOf.get(`${w.subjectId}:${w.spec.id}`);
      if (!valueId) throw new Error(`cf_erp: value row for specification ${w.spec.id} on master ${w.subjectId} vanished between insert and read-back.`);
      return [companyId, valueId, w.spec.id, 'master', w.subjectId, 'create', null, JSON.stringify(snapshot(w.typed, 'entered', w.spec.unit ?? null)), c.userId];
    }));
}

/**
 * STEEL A BLANK MISSED (2026-10-03). A blank copies its steel (IMPACT_CLASS…)
 * from its part only when it is MADE. A blank whose size did not change is
 * left alone by every later derive — so a value filled on the part after the
 * blank was made never reached it, and the Freeze checklist kept counting it
 * missing while the Structure grid (which hides cut pieces) said all filled.
 * Every derive now fills such gaps on existing blanks: only empty values, only
 * from a part's stored answer. Nothing to fill = 0 statements past one cheap
 * pre-check; otherwise 1 rules read + 3 writes. Returns how many were filled.
 */
async function fillBlankGaps(db, c, desc, plan) {
  if (!desc || !plan) return 0;
  const existing = plan.groups.filter((x) => !x.isNew && x.cp);
  // Pre-check without reading any rule. Every blank sits on the same node, so a
  // steel code its chain asks for is one some blank of the line already holds
  // (it was given at birth). A gap = such a code, empty on this blank, that one
  // of its parts holds. (If EVERY blank missed it, this cannot see it — the
  // Values stage still names it; a part-only code like HOLED never costs a read.)
  const filledOn = (row) => row && rawOf(row, row.data_type) != null && rawOf(row, row.data_type) !== '';
  const blankCodes = new Set();
  for (const x of existing) for (const [k, row] of x.cp.values ?? new Map()) if (!desc.sizeCodes.includes(k) && filledOn(row)) blankCodes.add(k);
  const maybe = existing.filter((x) => {
    const own = x.cp.values ?? new Map();
    return [...blankCodes].some((k) => !filledOn(own.get(k)) && x.group.parts.some((part) => filledOn((part.values ?? new Map()).get(k))));
  });
  if (!maybe.length) return 0;
  const checker = await blankValueChecker(db, c.companyId, [], desc);
  if (!checker.rules.extras.length) return 0;
  const given = [];
  for (const x of maybe) for (const w of await checker.fill(x)) given.push({ subjectId: x.cp.id, ...w });
  // A blank may hold a deleted-or-empty row for the spec: soft-delete it first so the new one is the only live row.
  if (given.length) {
    await db.query(
      `UPDATE cf_spec_values SET deleted_at = NOW()
        WHERE company_id = ? AND subject_type = 'master' AND deleted_at IS NULL AND (subject_id, specification_id) IN (${given.map(() => '(?, ?)').join(', ')})`,
      [c.companyId, ...given.flatMap((w) => [w.subjectId, w.spec.id])],
    );
    await insertBlankValues(db, c, given);
  }
  return given.length;
}

/**
 * The two cutting methods, as the writer needs them: where a new blank is
 * filed, its short name and fallback name, the sizes it is given, its stock
 * line, and the house flow a new one takes. Null for a method whose blanks
 * place is not set (requirePlaces has refused before anything is written).
 */
function methodsOf(places, selection) {
  const plate = places.cutPlate ? {
    kind: 'plate',
    noun: 'cut plate',
    nodeId: places.cutPlate.id,
    shortName: 'CUTPL',
    sizeCodes: SPEC_CODES,
    strict: true,
    houseFlow: cutPlateFlowId,
    usesGivenFlow: true,
    sizeEntries: (x) => {
      const size = x.group.size;
      return [
        { code: 'THICKNESS', value: size.thickness },
        { code: 'LENGTH', value: size.length },
        { code: 'WIDTH', value: size.width },
        { code: 'GRADE', value: size.gradeId ?? size.gradeText },
      ];
    },
    stockLine: (x) => ({ childId: x.plateLine.add.childId, designId: selection.id, quantity: x.plateLine.add.quantity, role: 'Raw plate', selectionDefinitionId: selection.id }),
    fallbackName: (x, size) => `Cut plate ${fmt(size.thickness)} × ${fmt(size.width)} × ${fmt(size.length)}${size.gradeText ? ` ${size.gradeText}` : ''}`,
  } : null;
  const section = places.cutSection ? {
    kind: 'section',
    noun: 'cut section',
    nodeId: places.cutSection.id,
    shortName: 'CUTSC',
    sizeCodes: SECTION_SIZE_CODES,
    strict: false,
    houseFlow: cutSectionFlowId,
    usesGivenFlow: false,
    alwaysCodes: ['SECTION_AREA', 'DENSITY'],
    sizeEntries: (x) => {
      const st = x.group.section.stock;
      return [
        { code: 'THICKNESS', value: st.thickness },
        { code: 'WIDTH', value: st.width },
        { code: 'DEPTH', value: st.depth },
        { code: 'SECTION_AREA', value: st.sectionArea },
        { code: 'LENGTH', value: x.group.section.length },
        { code: 'GRADE', value: st.gradeId ?? st.grade },
        { code: 'DENSITY', value: st.density },
      ];
    },
    stockLine: (x) => ({ childId: x.plateLine.add.childId, designId: x.plateLine.add.childId, quantity: x.plateLine.add.quantity, role: 'Raw section', selectionDefinitionId: null }),
    fallbackName: (x) => `Cut section ${profileLabelOf(x.group.section.stock)} × ${fmt(x.group.section.length)}`,
  } : null;
  return { plate, section };
}

/**
 * Writes one method's plan — the statements the one-method derive always sent,
 * in its order — a fixed number of statements whatever its size. Everything
 * that can be refused was refused (applyPlan) before the first write.
 * Returns the blanks it removed.
 */
async function writeMethod(db, c, { line, desc, flowId, plan }) {
  const { companyId } = c;
  const fresh = plan.groups.filter((x) => x.isNew);

  // 1. Lines let go of: parts that changed size (or method), a group pulled
  //    back onto one blank, a blank's duplicate stock lines.
  if (plan.drops.size) {
    await db.query('UPDATE cf_bom_lines SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, [...plan.drops]]);
  }

  // 2. The new blanks. A cut piece is a temporary item with no template
  //    definition behind it — derived from the parts, not instantiated from a
  //    blueprint — so its rows are written here rather than through
  //    masterRecordService, whose createItem takes a temporary item's
  //    classification from a template definition. Born a draft like every
  //    other temporary item (decision Q21); counted, not identified — a batch
  //    of identical pieces, always made on its order, never stocked. Each is
  //    written with a code unique to this derive and found again by it (TiDB
  //    does not hand AUTO_INCREMENT ids out contiguously); nameAndCode
  //    overwrites every placeholder.
  if (fresh.length) {
    // How a new blank is made: what a revision carried for its group, else the
    // flow this derive was given (plates), else the house's flow for the
    // method (init.sql §33 / §48b — cutting belongs to the cut piece). Read
    // only when one of them still needs it; nothing already set changes.
    const given = desc.usesGivenFlow ? flowId : null;
    const house = given == null && fresh.some((x) => x.carriedFlowId == null) ? await desc.houseFlow(db, companyId) : null;
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const marker = (i) => `~cut~${token}~${i}`;
    await insertRows(db, 'cf_master_records',
      ['company_id', 'record_kind', 'code', 'name', 'short_name', 'classification_id', 'status', 'default_flow_id', 'created_by'],
      fresh.map((x, i) => [companyId, 'item', marker(i), '(pending)', desc.shortName, desc.nodeId, 'draft', x.carriedFlowId ?? given ?? house, c.userId]));
    const [back] = await db.query('SELECT id, code FROM cf_master_records WHERE company_id = ? AND code LIKE ?', [companyId, `~cut~${token}~%`]);
    const idOf = new Map(back.map((r) => [r.code, r.id]));
    fresh.forEach((x, i) => { x.cp = { id: idOf.get(marker(i)), code: null, name: '(pending)', status: 'draft', classification_id: desc.nodeId }; });
    if (fresh.some((x) => !x.cp.id)) throw new Error(`cf_erp: ${fresh.length} ${desc.noun}s written, ${back.length} read back.`);
    await insertRows(db, 'cf_item_details',
      ['master_id', 'company_id', 'item_type', 'tracked_by', 'uom', 'sourcing', 'source_definition_id', 'owner_order_line_id'],
      fresh.map((x) => [x.cp.id, companyId, 'temporary', 'quantity', 'nos', 'make', null, line.id]));
  }

  // 3. Every new BOM line, in the order the one-at-a-time derive made them:
  //    per group, a new blank's line under its first part, the other parts'
  //    lines to it, then its stock line. A blank legitimately has several
  //    parents — that is the whole point of pooling — and one blank per piece
  //    of a part: the part's own quantity already says how many pieces there
  //    are, so its line never multiplies.
  const adds = [];
  for (const x of plan.groups) {
    if (x.isNew) {
      x.place = { parentId: x.first.id };
      adds.push({ parentId: x.first.id, childId: x.cp.id, designId: x.cp.id, quantity: 1, role: 'Cut from', place: x.place });
    }
    for (const p of x.attachTo) adds.push({ parentId: p.id, childId: x.cp.id, designId: x.cp.id, quantity: 1, role: 'Cut from' });
    if (x.plateLine.add) adds.push({ parentId: x.cp.id, ...desc.stockLine(x) });
  }
  if (adds.length) {
    // The parent's BOM, created if it has none, and locked so two callers
    // cannot take one position.
    const parentIds = [...new Set(adds.map((a) => a.parentId))];
    const [held] = await db.query('SELECT id, parent_id FROM cf_boms WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL FOR UPDATE', [companyId, parentIds]);
    const bomOf = new Map(held.map((b) => [b.parent_id, b.id]));
    const missing = parentIds.filter((id) => !bomOf.has(id));
    if (missing.length) {
      await insertRows(db, 'cf_boms', ['company_id', 'parent_id', 'bom_type', 'status', 'source_bom_id', 'created_by'],
        missing.map((id) => [companyId, id, 'custom', 'draft', null, c.userId]));
      const [made] = await db.query('SELECT id, parent_id FROM cf_boms WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL', [companyId, missing]);
      for (const b of made) bomOf.set(b.parent_id, b.id);
      if (missing.some((id) => !bomOf.has(id))) throw new Error(`cf_erp: a ${desc.noun} BOM was written and not read back.`);
    }
    // Next line number: 10 past the highest live one. Next position for a
    // design: past the highest ever given, deleted lines too, so a number is
    // never reused. Read after the drops, as it always was.
    const bomIds = [...new Set(adds.map((a) => bomOf.get(a.parentId)))];
    const [tops] = await db.query(
      `SELECT bom_id, design_id, MAX(position) AS top_position, MAX(CASE WHEN deleted_at IS NULL THEN line_no END) AS top_line
         FROM cf_bom_lines WHERE company_id = ? AND bom_id IN (?) GROUP BY bom_id, design_id`,
      [companyId, bomIds],
    );
    const topLine = new Map();
    const topPosition = new Map();
    for (const t of tops) {
      topLine.set(t.bom_id, Math.max(topLine.get(t.bom_id) ?? 0, Number(t.top_line) || 0));
      topPosition.set(`${t.bom_id}:${t.design_id}`, Number(t.top_position) || 0);
    }
    const rows = adds.map((a) => {
      const bomId = bomOf.get(a.parentId);
      const lineNo = (topLine.get(bomId) ?? 0) + 10;
      topLine.set(bomId, lineNo);
      const k = `${bomId}:${a.designId}`;
      const position = (topPosition.get(k) ?? 0) + 1;
      topPosition.set(k, position);
      if (a.place) Object.assign(a.place, { bomId, lineNo, position });
      return [companyId, bomId, lineNo, a.childId, a.designId, position, a.role, a.quantity, a.selectionDefinitionId ?? null, null, null, null, c.userId];
    });
    await insertRows(db, 'cf_bom_lines',
      ['company_id', 'bom_id', 'line_no', 'child_id', 'design_id', 'position', 'role', 'quantity', 'selection_definition_id', 'source_line_id', 'operation_flow_id', 'notes', 'created_by'],
      rows);
  }

  // 4. The new blanks' own values — their sizes and the steel of the part —
  //    with their history, as setValues writes them.
  if (fresh.length) await insertBlankValues(db, c, fresh.flatMap((x) => x.values.map((w) => ({ subjectId: x.cp.id, ...w }))));

  // 5. Stock lines that move: a default filled in, a quantity that follows the
  //    parts or the plate, a bar that follows the part to another stock length.
  const updates = plan.groups.map((x) => x.plateLine.update).filter(Boolean);
  if (updates.length) {
    const params = [];
    const qty = updates.map((u) => { params.push(u.lineId, u.quantity); return 'WHEN ? THEN ?'; }).join(' ');
    const child = updates.map((u) => { params.push(u.lineId); return u.childId != null ? (params.push(u.childId), 'WHEN ? THEN ?') : 'WHEN ? THEN child_id'; }).join(' ');
    params.push(companyId, updates.map((u) => u.lineId));
    await db.query(`UPDATE cf_bom_lines SET quantity = CASE id ${qty} END, child_id = CASE id ${child} END WHERE company_id = ? AND id IN (?)`, params);
  }

  // 6. A blank nothing is cut from any more goes, with everything below it —
  //    the same as taking its line off a custom BOM, which deletes the
  //    temporary item it held. It exists only for the parts that shared it.
  //    Not while anything else still points at it, and not once it has stock
  //    history: then it is a real thing.
  const removed = [];
  if (plan.orphans.length) {
    const [held] = await db.query(
      `SELECT m.id,
              (SELECT COUNT(*) FROM cf_bom_lines l WHERE l.company_id = m.company_id AND l.child_id = m.id AND l.deleted_at IS NULL) AS pointed,
              (SELECT COUNT(*) FROM cf_stock_ledger s WHERE s.company_id = m.company_id AND s.item_id = m.id) AS moves
         FROM cf_master_records m
        WHERE m.company_id = ? AND m.id IN (?)`,
      [companyId, plan.orphans.map((cp) => cp.id)],
    );
    const kept = new Set(held.filter((r) => Number(r.pointed) || Number(r.moves)).map((r) => r.id));
    const gone = plan.orphans.filter((cp) => !kept.has(cp.id));
    if (gone.length) {
      await deleteTrees(db, c, gone.map((cp) => cp.id));
      removed.push(...gone.map((cp) => ({ id: cp.id, code: cp.code, name: cp.name, kind: desc.kind })));
    }
  }
  return removed;
}

/**
 * Writes the plan: everything that can be refused is refused before the first
 * write (the blanks' values, the loop rule — every method), then each method's
 * statements (plates first), then the values settled ONCE for the line, then
 * names and codes for the new blanks (a code may print a value).
 */
async function applyPlan(db, c, { line, places, selection, flowId, state, plan }) {
  const { companyId } = c;
  const methods = methodsOf(places, selection);
  const run = [
    { kind: 'plate', desc: methods.plate, plan: plan.plate ?? plan },
    { kind: 'section', desc: methods.section, plan: plan.section ?? EMPTY_PLAN() },
  ].filter((m) => writesKind(m.plan));
  for (const m of run) {
    if (!m.desc) throw placeProblem(places, m.kind);
    const fresh = m.plan.groups.filter((x) => x.isNew);
    m.values = fresh.length ? await blankValueChecker(db, companyId, fresh, m.desc) : null;
    const loops = await loopChecker(db, companyId, m.plan);
    for (const x of m.plan.groups) {
      if (x.isNew) await m.values.check(x);
      loops.check(x);
    }
  }

  const removed = [];
  for (const m of run) removed.push(...await writeMethod(db, c, { line, desc: m.desc, flowId, plan: m.plan }));

  // 7. The values, settled once for the line: new blanks worked out from their
  //    rules, and whatever reads them — parts' roll-ups, assemblies above —
  //    walked until nothing moves. New blanks before the parts above them.
  const settle = [...run.flatMap((m) => m.plan.groups.map((x) => x.cp.id)), ...run.flatMap((m) => (m.desc.kind === 'plate' ? state.plate : state.section).parts.map((p) => p.id))];
  await materializeLineRecords(db, c, line.id, settle);
  // 7b. New cut sections: their cuts and cut length (sectionNestingService.writeSectionCuts).
  if (run.some((m) => m.kind === 'section')) await syncSectionCuts(db, c, line);

  // 8. Names and codes for the new blanks — a code may print a value.
  for (const m of run) {
    const fresh = m.plan.groups.filter((x) => x.isNew);
    if (fresh.length) await nameAndCode(db, c, { line, desc: m.desc, blankRules: m.values, fresh });
  }
  return removed;
}

// --- what the screens are told ---------------------------------------------------

function shape(line, selection, cutPlates) {
  return {
    line: { id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code, quantity: Number(line.quantity) },
    selection: selection ? { id: selection.id, code: selection.code, name: selection.name } : null,
    basis: 'area fraction',
    caveat: AREA_FRACTION_CAVEAT,
    sectionCaveat: BAR_FRACTION_CAVEAT,
    cutPlates,
  };
}

/**
 * One blank as every screen reads it. `kind` is 'plate' or 'section'; a cut
 * section also says its section (the stock bar, `plate` holds the same) and its
 * cut length. For a cut section `sec` = { stock, length }.
 */
const describe = (cp, size, parts, plateLine, kind = 'plate', sec = null) => ({
  id: cp.id,
  code: cp.code,
  name: cp.name,
  status: cp.status,
  kind,
  size: kind === 'section'
    ? { thickness: sec?.stock?.thickness ?? null, length: sec?.length ?? null, width: sec?.stock?.width ?? null, depth: sec?.stock?.depth ?? null, grade: sec?.stock?.grade ?? null }
    : { thickness: size.thickness, length: size.length, width: size.width, grade: size.gradeText },
  section: kind === 'section' ? brief(sec?.stock ?? null) : null,
  lengthMm: kind === 'section' ? sec?.length ?? null : null,
  partCount: parts.length,
  parts: parts.map((p) => ({ id: p.id, code: p.code, name: p.name })),
  plate: plateLine.plate,
  plateQuantity: plateLine.quantity,
  plateQuantityBasis: plateLine.basis,
  // What the plate column says (CF_ERP_ORDER_FLOW_PLAN): 'at_nesting' — the
  // line still holds the selection, "chosen at nesting"; 'nested' — an accepted
  // nest laid it out (getCutPlates adds the lots); 'chosen' — a plate is on the
  // line, chosen by hand (or by an earlier default, which reads the same). A
  // cut section's bar is always chosen (its part names it) until it is nested.
  plateState: plateLine.basis === 'nesting' ? 'nested' : (kind === 'section' || plateLine.plate) ? 'chosen' : 'at_nesting',
  note: plateLine.note,
  otherLines: plateLine.otherLines,
});

const describeGroup = (x) => describe(x.cp, x.group.size, x.group.parts, x.plateLine, x.kind ?? 'plate', x.group.section ?? null);

/** Which methods a surveyed line uses — a method in use needs its place. */
const inUse = (state) => ({ plate: state.plate.parts.length > 0, section: state.section.parts.length > 0 });
const hasAnything = (state) => state.plate.parts.length + state.section.parts.length + state.plate.cutPlates.length + state.section.cutPlates.length > 0;

// --- a section part takes its steel from its bar ----------------------------------

const sameValueRow = (a, b) => {
  const n = (x) => (x == null ? null : Number(x));
  const an = n(a.value_number);
  const bn = n(b.value_number);
  if ((an === null) !== (bn === null) || (an !== null && Math.abs(an - bn) > 1e-9)) return false;
  return (a.value_text ?? null) === (b.value_text ?? null)
    && (a.value_bool == null ? null : Number(a.value_bool)) === (b.value_bool == null ? null : Number(b.value_bool))
    && (a.option_id ?? null) === (b.option_id ?? null);
};

/**
 * A SECTION PART'S STEEL IS ITS BAR'S (§3.2). Where a part's rule takes a
 * STEEL_FROM_STOCK code as ENTERED and nobody entered it, the part stores its
 * bar's value as source 'inherited' — so WEIGHT = SECTION_AREA × LENGTH ×
 * DENSITY and the required GRADE / IMPACT_CLASS are answered by choosing the
 * section. Choosing another bar moves them; a part that stops being a section
 * part (or loses its bar) has them taken away. An entered value is never
 * touched. Asked of every row of the line, from what survey() read — nothing
 * to change costs nothing. Changes: one soft delete, one insert, one read-back,
 * one history insert, then the values settled for the rows that moved.
 * Returns the ids of the rows that changed.
 */
async function syncSectionSteel(db, c, line, state) {
  const { companyId } = c;
  const sectionIds = new Set(state.section.parts.map((p) => p.id));
  const puts = [];
  const drops = [];
  for (const m of state.candidates ?? []) {
    const res = state.resolved?.get(m.id);
    if (!res) continue;
    const stock = sectionIds.has(m.id) && m.section?.stockOk ? m.section.stock : null;
    for (const code of STEEL_FROM_STOCK) {
      const e = res.get(code);
      if (!e?.rule?.applicable || e.rule.valueRule !== 'entered') continue;
      const own = e.own;
      if (own && own.source === 'entered') continue;
      const src = stock?.rows.get(code) ?? null;
      const want = src && rawOf(src, src.data_type) != null ? src : null;
      if (!want) { if (own && own.source === 'inherited') drops.push({ m, own }); continue; }
      if (own && own.source === 'inherited' && sameValueRow(own, want)) continue;
      puts.push({ m, own, want });
    }
  }
  if (!puts.length && !drops.length) return [];
  const old = [...drops.map((d) => d.own), ...puts.map((p) => p.own).filter(Boolean)];
  if (old.length) await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, old.map((r) => r.id)]);
  const typedOf = (r) => ({ value_number: r.value_number == null ? null : Number(r.value_number), value_text: r.value_text ?? null, value_bool: r.value_bool ?? null, value_date: r.value_date ?? null, option_id: r.option_id ?? null });
  let idOf = new Map();
  if (puts.length) {
    await insertRows(db, 'cf_spec_values',
      ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_number', 'value_text', 'value_bool', 'value_date', 'option_id', 'uom', 'source', 'created_by'],
      puts.map((p) => { const t = typedOf(p.want); return [companyId, p.want.specification_id, 'master', p.m.id, t.value_number, t.value_text, t.value_bool, t.value_date, t.option_id, p.want.uom ?? null, 'inherited', c.userId]; }));
    const [back] = await db.query(
      `SELECT id, subject_id, specification_id FROM cf_spec_values
        WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND specification_id IN (?) AND deleted_at IS NULL`,
      [companyId, [...new Set(puts.map((p) => p.m.id))], [...new Set(puts.map((p) => p.want.specification_id))]],
    );
    idOf = new Map(back.map((r) => [`${r.subject_id}:${r.specification_id}`, r.id]));
  }
  await insertRows(db, 'cf_spec_value_history',
    ['company_id', 'value_id', 'specification_id', 'subject_type', 'subject_id', 'change_type', 'old_value', 'new_value', 'changed_by'],
    [
      ...drops.map((d) => [companyId, d.own.id, d.own.specification_id, 'master', d.m.id, 'delete', JSON.stringify(snapshot(d.own)), null, c.userId]),
      ...puts.map((p) => [companyId, idOf.get(`${p.m.id}:${p.want.specification_id}`) ?? p.own?.id ?? null, p.want.specification_id, 'master', p.m.id,
        p.own ? 'update' : 'create', p.own ? JSON.stringify(snapshot(p.own)) : null, JSON.stringify(snapshot(typedOf(p.want), 'inherited', p.want.uom ?? null)), c.userId]),
    ].filter((r) => r[1] != null));
  const changed = [...new Set([...puts, ...drops].map((x) => x.m.id))];
  await materializeLineRecords(db, c, line.id, changed);
  // What the plan reads of those rows (a blank copies its steel from its part).
  const fresh = await specValuesOf(db, companyId, changed);
  for (const m of state.candidates) {
    if (!fresh.has(m.id)) continue;
    m.values = fresh.get(m.id);
    m.size = sizeOf(m.values);
  }
  return changed;
}

/** Everything a derive starts from, with the refusals in the order they have always come. */
async function openForDerive(db, c, orderLineId, input) {
  const line = await requireLine(db, c.companyId, orderLineId, { lock: true });
  assertOpen(line);
  if (!line.item_id) throw invalid('NO_ITEM', `Line ${line.line_no} of ${line.order_code} has no item yet.`);

  const problems = [];
  const flowId = blank(input.flowId) ? null : await requireUsableFlow(db, c.companyId, input.flowId, problems);
  if (problems.length) throw invalid('INVALID', 'The flow could not be used.', { problems });

  const places = await loadPlaces(db, c.companyId);
  const state = await survey(db, c.companyId, line, places);
  await syncSectionSteel(db, c, line, state);
  requirePlaces(places, inUse(state));
  const selection = state.plate.parts.length ? await plateSelection(db, c.companyId, places) : null;
  return { line, flowId, places, selection, state };
}

/** A derive from an opened line: plan, and write when the plan changes something. */
async function deriveOpened(db, c, { line, flowId, places, selection, state }, plan = null) {
  const p = plan ?? await planFor(db, c.companyId, { line, state, selection, places });
  const changed = writes(p);
  const removed = changed ? await applyPlan(db, c, { line, places, selection, flowId, state, plan: p }) : [];
  // A cut piece is an order row like any other: the values its own flow reads are its rules (flowSpecService).
  if (changed) {
    const [rows] = await db.query("SELECT master_id FROM cf_item_details WHERE company_id = ? AND owner_order_line_id = ? AND item_type = 'temporary' AND source_definition_id IS NULL AND deleted_at IS NULL", [c.companyId, line.id]);
    if (rows.length) await syncFlowSpecs(db, c, rows.map((x) => x.master_id));
  }
  const methods = methodsOf(places, selection);
  const filled = await fillBlankGaps(db, c, methods.plate, p.plate) + await fillBlankGaps(db, c, methods.section, p.section);
  const out = p.groups.map(describeGroup);
  const created = p.groups.filter((x) => x.isNew).length;
  const updated = p.groups.filter((x) => !x.isNew && x.plateLine.changed).length;
  return {
    ...shape(line, selection, out),
    created,
    updated,
    removed,
    unchanged: out.length - created - updated,
    changed: changed || filled > 0,
    filled,
  };
}

// --- the entry points --------------------------------------------------------------

/**
 * Works out the cut pieces a line's parts are cut from, and makes the structure
 * say so — whether or not the line's values are complete (it is the "Make them
 * now" button; refreshCutPieces is the automatic one). Re-runnable: what is
 * right is left alone, what changed is moved, and a cut piece nothing is cut
 * from any more is deleted. A derive that changes nothing writes nothing.
 *
 * input: { flowId? } — how a cut plate is made, put on the ones it creates, so
 * a derived blank is not a node release has to refuse for having no flow.
 * (A new cut section takes the house's cut-section flow.)
 */
export async function deriveCutPlates(db, c, orderLineId, input = {}) {
  return deriveOpened(db, c, await openForDerive(db, c, orderLineId, input));
}

/**
 * The required values still empty on the line's own rows, from the Values
 * engine's own count — leaving out the cut pieces' rows. Cut pieces are what
 * this step MAKES from the values; a value missing on one of them (steel its
 * part did not say) is shown on the Values stage, but it must not stop the cut
 * pieces being made again, or a blank missing a value would freeze every blank
 * on the line until somebody typed onto a row that is about to be replaced.
 */
function missingValues(view, places) {
  const cut = places.blankIds;
  let missing = 0;
  let items = 0;
  for (const g of view.groups ?? []) {
    if (!g.own || cut.has(g.classification?.id)) continue;
    for (const r of g.rows) {
      missing += Number(r.missing) || 0;
      if (Number(r.missing)) items += 1;
    }
  }
  return { missing, items, complete: missing === 0 };
}

/**
 * When the line's cut pieces were last made: the newest blank or part → blank
 * line. Measured against the database's own clock read with the line (see
 * requireLine), so it is right whatever zone the server keeps.
 */
function lastMadeAt(line, state) {
  const stamps = [...state.plate.cutPlates, ...state.section.cutPlates].map((cp) => cp.created_at)
    .concat([...state.plate.links, ...state.section.links].map((l) => l.created_at))
    .filter(Boolean).map((d) => new Date(d).getTime()).filter(Number.isFinite);
  if (!stamps.length || !line.db_now) return null;
  const age = new Date(line.db_now).getTime() - Math.max(...stamps);
  return new Date(Date.now() - Math.max(0, age)).toISOString();
}

/**
 * The cut pieces a line already has — cut plates and cut sections — exactly as
 * they stand. Writes nothing.
 *
 * Beside them, what the Cut pieces screen needs to say what happens next:
 *   lock        why they are frozen, when they are (closed, released, locked)
 *   values      { missing, items, complete } — required values still empty on
 *               the line's own rows (not the cut pieces'), while there are
 *               parts to cut and the line is open; null otherwise
 *   upToDate    whether a derive would change nothing now — the derive's own
 *               plan, not written; null while it cannot be worked out (a part
 *               with no size or no section, a frozen line)
 *   lastMadeAt  ISO time the newest cut piece or part line was made, or null
 *   parts       how many parts the line cuts (plateParts + sectionParts)
 */
export async function getCutPlates(db, companyId, orderLineId) {
  const line = await requireLine(db, companyId, orderLineId);
  if (!line.item_id) throw invalid('NO_ITEM', `Line ${line.line_no} of ${line.order_code} has no item yet.`);
  const places = await loadPlaces(db, companyId);
  const state = await survey(db, companyId, line, places);
  requirePlaces(places, inUse(state));
  const usesPlate = state.plate.parts.length > 0 || state.plate.cutPlates.length > 0;
  const selection = usesPlate ? await plateSelection(db, companyId, places) : null;
  const { plate: P, section: S } = state;
  const lock = lockOf(line);

  // The derive's own plan, not written: the same reconcile the write acts on.
  const plateLines = await plateLinesOf(db, companyId, orderLineId, P.cutPlates.map((cp) => cp.id));
  const nested = new Set([...plateLines.nested, ...S.lines.nested]);
  let plan = null;
  let planP = null;
  if (!lock) {
    try {
      planP = usesPlate ? planGroups(P) : EMPTY_PLAN();
      const planS = planSectionFor({ st: S, places });
      plan = combined(planP, planS);
    } catch (err) { if (!(err instanceof CfError)) throw err; plan = null; planP = null; }
  }
  // No default candidate any more: a plate line still holding the selection is
  // waiting for nesting, not behind (planFor).
  const pick = null;

  const keepOf = new Map(P.cutPlates.map((cp) => [cp.id, selection ? ownLines(plateLines.lines.get(cp.id) ?? [], selection)[0] ?? null : null]));
  const plates = await platesOf(db, companyId, [
    ...[...keepOf.values()].filter((k) => k && k.child_record_kind === 'item').map((k) => k.child_id),
    ...(pick ? [pick.id] : []),
  ]);
  if (planP && planP.groups.length) planPlateLines(planP, plateLines, { selection, pick, plates });

  // The nests each nested cut piece sits on, for the plate column ("N-012 · PL-…").
  // One query, and only when something is nested.
  const lotsOf = new Map();
  if (nested.size) {
    const [lotRows] = await db.query(
      `SELECT DISTINCT np.cut_plate_id, pl.id, pl.lot_no, pl.kind, m.code AS plate_code, m.name AS plate_name
         FROM cf_nest_placements np
         JOIN cf_plate_lots pl ON pl.id = np.plate_lot_id AND pl.deleted_at IS NULL
         LEFT JOIN cf_master_records m ON m.id = pl.plate_item_id
        WHERE np.company_id = ? AND pl.order_line_id = ? AND np.deleted_at IS NULL AND np.cut_plate_id IN (?)
        ORDER BY pl.lot_no, pl.id`,
      [companyId, orderLineId, [...nested]],
    );
    for (const r of lotRows) {
      if (!lotsOf.has(Number(r.cut_plate_id))) lotsOf.set(Number(r.cut_plate_id), []);
      lotsOf.get(Number(r.cut_plate_id)).push({ id: r.id, lotNo: r.lot_no, kind: r.kind ?? 'plate', plate: { code: r.plate_code, name: r.plate_name } });
    }
  }
  const nestOf = (id) => ({
    nestLots: lotsOf.get(Number(id)) ?? [],
    // The first nest it sits on, as the plate column shows it ("N-012 · PL-…");
    // `lots` says how many nests it is spread over.
    nest: lotsOf.get(Number(id))?.length
      ? { nestNo: lotsOf.get(Number(id))[0].lotNo, code: lotsOf.get(Number(id))[0].plate.code ?? null, lots: lotsOf.get(Number(id)).length }
      : null,
  });

  const partById = new Map([...P.parts, ...S.parts].map((p) => [p.id, p]));
  const out = [];
  for (const cp of P.cutPlates) {
    const mine = P.links.filter((l) => l.cut_plate_id === cp.id).map((l) => partById.get(l.part_id)).filter(Boolean);
    const keep = keepOf.get(cp.id);
    const plate = keep && keep.child_record_kind === 'item' ? plates.get(Number(keep.child_id)) ?? null : null;
    const isNested = nested.has(Number(cp.id));
    // A nested quantity differs from the area fraction ON PURPOSE. Calling it
    // stale told people to derive again, which is what destroyed the nesting.
    const fresh = isNested ? { quantity: null, basis: 'nesting', note: NESTED_NOTE } : plateQuantity(cp.size, plate);
    const stored = keep ? round6(Number(keep.quantity)) : null;
    const stale = !isNested && stored != null && Math.abs(stored - fresh.quantity) > 1e-9;
    out.push({
      ...describe(cp, cp.size, mine, {
        ...fresh,
        quantity: stored,
        note: stale ? `${fresh.note ? `${fresh.note} ` : ''}What is written here is ${fmt(stored)}; the area fraction now works out at ${fmt(fresh.quantity)} — work the cut plates out again to bring it up to date.` : fresh.note,
        plate: brief(plate),
        otherLines: 0,
      }),
      ...nestOf(cp.id),
    });
  }
  const stockPlaces = places.all.section.stockIds;
  for (const cp of S.cutPlates) {
    const mine = S.links.filter((l) => l.cut_plate_id === cp.id).map((l) => partById.get(l.part_id)).filter(Boolean);
    const keep = (S.lines.lines.get(cp.id) ?? []).find((l) => l.child_record_kind === 'item' && stockPlaces.has(l.child_classification_id)) ?? null;
    const stock = cp.section?.stock ?? null;
    const isNested = nested.has(Number(cp.id));
    const fresh = isNested ? { quantity: null, basis: 'nesting', note: SECTION_NESTED_NOTE } : barQuantity(cp.section?.length, stock);
    const stored = keep ? round6(Number(keep.quantity)) : null;
    const stale = !isNested && stored != null && Math.abs(stored - fresh.quantity) > 1e-9;
    out.push({
      ...describe(cp, cp.size, mine, {
        ...fresh,
        quantity: stored,
        note: stale ? `${fresh.note ? `${fresh.note} ` : ''}What is written here is ${fmt(stored)}; length ÷ stock length now works out at ${fmt(fresh.quantity)} — work the cut pieces out again to bring it up to date.` : (keep ? fresh.note : 'This cut section has no stock bar under it — work the cut pieces out again.'),
        plate: brief(stock),
        otherLines: 0,
      }, 'section', { stock, length: cp.section?.length ?? null }),
      ...nestOf(cp.id),
    });
  }
  const pooled = new Set([...P.links, ...S.links].filter((l) => partById.has(l.part_id)).map((l) => l.part_id));
  const pooledRight = new Set([
    ...P.links.filter((l) => P.parts.some((p) => p.id === l.part_id)).map((l) => l.part_id),
    ...S.links.filter((l) => S.parts.some((p) => p.id === l.part_id)).map((l) => l.part_id),
  ]);
  const parts = P.parts.length + S.parts.length;
  const values = !lock && parts ? missingValues(await readLineValues(db, companyId, orderLineId), places) : null;
  return {
    ...shape(line, selection, out),
    partsWithoutBlank: [
      ...P.parts.filter((p) => !pooledRight.has(p.id)).map((p) => ({ id: p.id, code: p.code, name: p.name, kind: 'plate', missing: missingOf(p.size) })),
      ...S.parts.filter((p) => !pooledRight.has(p.id)).map((p) => ({ id: p.id, code: p.code, name: p.name, kind: 'section', missing: p.section?.missing ?? [] })),
    ],
    lock: lock ? { reason: lock.reason, message: lock.message } : null,
    values,
    upToDate: plan ? !writes(plan) : null,
    lastMadeAt: lastMadeAt(line, state),
    parts,
    plateParts: P.parts.length,
    sectionParts: S.parts.length,
    pooled: pooled.size,
  };
}

let savepointNo = 0;

/** A refusal a person can act on — a rule, a missing setup, a clash — rather than something broken. */
const isRefusal = (err) => err instanceof CfError || (Number(err?.status) >= 400 && Number(err?.status) < 500) || err?.errno === 1062;

/**
 * THE AUTOMATIC ONE (user, 2026-09-26): once the line's values are complete,
 * its cut pieces are made — and made again whenever the values or the
 * structure change, until the line is locked.
 *
 * Call it after every value save and structure change on the line, and inside
 * lock BEFORE the line is stamped locked, on the same transaction. It never
 * throws for a reason a person can act on — a missing setup, a part with no
 * size or no section, a coding rule that clashes — because it runs behind
 * somebody else's save, and a save must not fail because the cut pieces could
 * not follow it. It says why instead, and anything it had begun writing is
 * rolled back to a savepoint first. Something genuinely broken (the database)
 * still throws.
 *
 * Before anything else, a section part's steel follows its bar
 * (syncSectionSteel) — values-complete or not, since the bar is what answers
 * the part's grade and size.
 *
 * Cheap when nothing changed, and it writes nothing then: the plan is worked
 * out first, and a plan that changes nothing ends it before the values are
 * even counted — about ten round trips on the KEPL line.
 *
 * opts.carry (a revision only): what was chosen for each rectangle on the line
 * this one replaces (rectangleChoices) — a new cut piece of that rectangle is
 * cut from the same plate and made by the same flow.
 *
 * Returns { made, reason, message, summary }:
 *   made     true when cut pieces were created, moved, re-quantified or removed
 *   reason   made | up_to_date | values_missing | no_plate_parts | locked |
 *            released | closed | no_structure | not_set_up | cannot_derive
 *            (no_plate_parts: the line has no part cut from plate or section)
 *   summary  { cutPieces, created, updated, removed, unchanged } after a
 *            derive; { missing, items } while values are missing; problems on
 *            a refusal
 */
export async function refreshCutPieces(db, c, lineId, opts = {}) {
  const { companyId } = c;
  const line = await requireLine(db, companyId, lineId, { lock: true });
  const stop = (reason, message, summary = {}) => ({ made: false, reason, message, summary });

  const frozen = lockOf(line);
  if (frozen) return stop(frozen.reason, frozen.message);
  if (line.line_type !== 'custom' || !line.item_id) {
    return stop('no_structure', `Line ${line.line_no} of ${line.order_code} sells a catalog item, so it has no parts to cut.`);
  }

  const places = await loadPlaces(db, companyId);
  let opened;
  let plan = null;
  let planError = null;
  try {
    const state = await survey(db, companyId, line, places);
    if (!hasAnything(state)) return stop('no_plate_parts', `Line ${line.line_no} has no part cut from a plate or a section, so there is nothing to cut.`, { cutPieces: 0 });
    await syncSectionSteel(db, c, line, state);
    const use = inUse(state);
    const missingPlace = (use.plate && placeProblem(places, 'plate')) || (use.section && placeProblem(places, 'section'));
    if (missingPlace) return stop('not_set_up', missingPlace.message);
    const selection = use.plate ? await plateSelection(db, companyId, places) : null;
    opened = { line, flowId: null, places, selection, state };
    try { plan = await planFor(db, companyId, { line, state, selection, places, carried: opts.carry ?? null }); } catch (err) { if (!isRefusal(err)) throw err; planError = err; }
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return stop('cannot_derive', err.message, { problems: err.problems ?? [] });
  }

  // Nothing would change: done, whatever the values say.
  if (plan && !writes(plan)) {
    // Same pieces — but one may still lack steel its part has since been given.
    const methods = methodsOf(places, opened.selection);
    const filled = await fillBlankGaps(db, c, methods.plate, plan.plate) + await fillBlankGaps(db, c, methods.section, plan.section);
    return stop('up_to_date', `The ${plural(plan.groups.length, 'cut piece')} of line ${line.line_no} already match its parts.`, { cutPieces: plan.groups.length, filled });
  }

  // Something would change — but only once the values are complete.
  const values = missingValues(await readLineValues(db, companyId, lineId), places);
  if (!values.complete) {
    return stop('values_missing',
      `${plural(values.missing, 'required value')} ${values.missing === 1 ? 'is' : 'are'} still empty on line ${line.line_no} — the cut pieces are made as soon as ${values.missing === 1 ? 'it is' : 'they are'} filled.`,
      { missing: values.missing, items: values.items });
  }
  if (planError) return stop('cannot_derive', planError.message, { problems: planError.problems ?? [] });

  const sp = `cf_cut_pieces_${savepointNo += 1}`;
  await db.query(`SAVEPOINT ${sp}`);
  let out;
  try {
    out = await deriveOpened(db, c, opened, plan);
  } catch (err) {
    try { await db.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch { /* the original error is the one that matters */ }
    if (!isRefusal(err)) throw err;
    const e = translateDbError(err);
    return stop('cannot_derive', e.message, { problems: e.problems ?? [] });
  }
  const bits = [
    out.created && `${out.created} new`,
    out.updated && `${out.updated} re-quantified`,
    out.removed.length && `${out.removed.length} removed`,
  ].filter(Boolean);
  return {
    made: true,
    reason: 'made',
    message: `Cut pieces of line ${line.line_no} made from its values — ${plural(out.cutPlates.length, 'cut piece')}${bits.length ? ` (${bits.join(', ')})` : ''}.`,
    summary: { cutPieces: out.cutPlates.length, created: out.created, updated: out.updated, removed: out.removed.length, unchanged: out.unchanged },
  };
}

/**
 * Whether refreshCutPieces COULD make a line's cut pieces now — the same
 * survey and plan, nothing written. For the Freeze design screen's look
 * (lockService.lockPlan): cut pieces are no longer a stage of their own
 * (user, 2026-10-02) — a part still without one is made by the freeze
 * itself — so the look only stops the freeze when the plan cannot be made, and
 * says why. A refusal while WRITING (a coding rule clash) cannot be foreseen
 * here; lockLine reports that one from the real run. About as many round trips
 * as refreshCutPieces' up-to-date path.
 *
 * Returns { ok, reason, message }; reason is one of refreshCutPieces' reasons,
 * or 'would_make' when ok.
 */
export async function previewCutPieces(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  const no = (reason, message) => ({ ok: false, reason, message });
  const frozen = lockOf(line);
  if (frozen) return no(frozen.reason, frozen.message);
  if (line.line_type !== 'custom' || !line.item_id) {
    return no('no_structure', `Line ${line.line_no} of ${line.order_code} sells a catalog item, so it has no parts to cut.`);
  }
  const places = await loadPlaces(db, companyId);
  try {
    const state = await survey(db, companyId, line, places);
    if (!hasAnything(state)) return no('no_plate_parts', `Line ${line.line_no} has no part cut from a plate or a section, so there is nothing to cut.`);
    const use = inUse(state);
    const missingPlace = (use.plate && placeProblem(places, 'plate')) || (use.section && placeProblem(places, 'section'));
    if (missingPlace) return no('not_set_up', missingPlace.message);
    const selection = use.plate ? await plateSelection(db, companyId, places) : null;
    await planFor(db, companyId, { line, state, selection, places });
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return no('cannot_derive', err.message);
  }
  return { ok: true, reason: 'would_make', message: `The cut pieces of line ${line.line_no} are made when its design is frozen.` };
}

/**
 * What was chosen for each rectangle of a line, keyed as the derive groups
 * parts: { plateId, flowId } — the catalog plate its cut plate's plate line
 * holds (chosen by a person, or by nesting; null while it still holds the
 * selection) and the flow the cut plate is made by. A cut section is keyed by
 * its profile + length with { plateId: null, flowId }. For a REVISION
 * (revisionService): the line that replaces this one hands it to
 * refreshCutPieces, so the same rectangle is cut from the same plate by the
 * same flow, instead of falling back to the selection's default and no flow —
 * which release would refuse. Read-only, and silent: a line with nothing to say
 * gives an empty map. About seven round trips.
 */
export async function rectangleChoices(db, companyId, lineId) {
  const out = new Map();
  const line = await requireLine(db, companyId, lineId);
  if (line.line_type !== 'custom' || !line.item_id) return out;
  const places = await loadPlaces(db, companyId);
  let state;
  let selection = null;
  try {
    state = await survey(db, companyId, line, places);
    if (!state.plate.cutPlates.length && !state.section.cutPlates.length) return out;
    if (state.plate.cutPlates.length && places.all.plate.stockNodeIds.length) selection = await plateSelection(db, companyId, places);
  } catch (err) {
    if (isRefusal(err)) return out;
    throw err;
  }
  const all = [...state.plate.cutPlates, ...state.section.cutPlates];
  const { lines } = selection ? await plateLinesOf(db, companyId, line.id, state.plate.cutPlates.map((cp) => cp.id)) : { lines: new Map() };
  const [flows] = await db.query('SELECT id, default_flow_id FROM cf_master_records WHERE company_id = ? AND id IN (?)', [companyId, all.map((cp) => cp.id)]);
  const flowOf = new Map(flows.map((r) => [r.id, r.default_flow_id ?? null]));
  if (selection) {
    for (const cp of state.plate.cutPlates) {
      if (missingOf(cp.size).length) continue;
      const keep = ownLines(lines.get(cp.id) ?? [], selection)[0];
      out.set(keyOf(cp.size), {
        plateId: keep && keep.child_record_kind === 'item' ? Number(keep.child_id) : null,
        flowId: flowOf.get(cp.id) ?? null,
      });
    }
  }
  for (const cp of state.section.cutPlates) {
    if (cp.sizeKey) out.set(cp.sizeKey, { plateId: null, flowId: flowOf.get(cp.id) ?? null });
  }
  return out;
}

/**
 * The order line a record belongs to — a row of an order's structure — or null
 * for anything else (a catalog item, a definition). The BOM routes and a
 * record's own value save know the record, not the line.
 */
export async function ownerLineOf(db, companyId, recordId) {
  if (recordId == null) return null;
  const [[r]] = await db.query(
    "SELECT owner_order_line_id AS lineId FROM cf_item_details WHERE company_id = ? AND master_id = ? AND item_type = 'temporary' AND deleted_at IS NULL",
    [companyId, recordId],
  );
  return r?.lineId ?? null;
}

/**
 * A save on a line's structure or values, followed by its cut pieces (user,
 * 2026-09-26): refreshCutPieces on the same transaction, what it did beside the
 * save's own answer as `cutPieces`. It never fails the save. `lineId` null — a
 * catalog record, a template — leaves the answer as it was.
 */
export async function withCutPieces(db, c, lineId, out) {
  if (lineId == null) return out;
  // Selection rows the system can answer on its own (a default, or one candidate) — before the cut pieces are worked out.
  await autofillLineSelections(db, c, lineId, { refresh: (ids) => refreshValues(db, c, ids) });
  const cutPieces = await refreshCutPieces(db, c, lineId);
  return out && typeof out === 'object' && !Array.isArray(out) ? { ...out, cutPieces } : out;
}

// --- the flow of every cut piece of a line -----------------------------------------

/** The house flow of a method, with its words: { id, code, name } | null. */
async function houseFlows(db, companyId) {
  const [[r]] = await db.query(
    `SELECT f.id AS p_id, f.code AS p_code, f.name AS p_name, g.id AS s_id, g.code AS s_code, g.name AS s_name
       FROM cf_company_settings s
       LEFT JOIN cf_operation_flows f ON f.company_id = s.company_id AND f.id = s.cut_plate_flow_id AND f.deleted_at IS NULL AND f.status <> 'obsolete'
       LEFT JOIN cf_operation_flows g ON g.company_id = s.company_id AND g.id = s.cut_section_flow_id AND g.deleted_at IS NULL AND g.status <> 'obsolete'
      WHERE s.company_id = ?`,
    [companyId],
  );
  return {
    plate: r?.p_id ? { id: r.p_id, code: r.p_code, name: r.p_name } : null,
    section: r?.s_id ? { id: r.s_id, code: r.s_code, name: r.s_name } : null,
  };
}

/**
 * Which cut pieces of a line have no flow, and the flow the house would give
 * them — cut plates as always, cut sections under `sections`. Read-only and
 * silent: a line with nothing to say (a catalog line, no places) answers zero.
 * Used by the release check so the dialog can offer ONE button instead of
 * listing one problem per cut piece.
 * { total, missing, names[], flow, sections: { total, missing, names[], flow } }
 */
export async function cutPlateFlowGaps(db, companyId, lineId) {
  const empty = () => ({ total: 0, missing: 0, names: [], flow: null });
  const none = { ...empty(), sections: empty() };
  const line = await requireLine(db, companyId, lineId);
  if (line.line_type !== 'custom' || !line.item_id) return none;
  const places = await loadPlaces(db, companyId);
  if (!places.blankIds.size) return none;
  let state;
  try { state = await survey(db, companyId, line, places); } catch (err) { if (isRefusal(err)) return none; throw err; }
  const all = [...state.plate.cutPlates, ...state.section.cutPlates];
  if (!all.length) return none;
  const [rows] = await db.query(
    'SELECT id, code, name, default_flow_id FROM cf_master_records WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL',
    [companyId, all.map((cp) => cp.id)],
  );
  const flows = await houseFlows(db, companyId);
  const isSection = new Set(state.section.cutPlates.map((cp) => cp.id));
  const of = (list, flow) => {
    const bare = list.filter((r) => r.default_flow_id == null);
    return { total: list.length, missing: bare.length, names: bare.flatMap((r) => [r.code, r.name]).filter(Boolean), flow };
  };
  return {
    ...of(rows.filter((r) => !isSection.has(r.id)), flows.plate),
    sections: of(rows.filter((r) => isSection.has(r.id)), flows.section),
  };
}

/**
 * Gives every cut piece of the line that has NO flow the company's flow for
 * its method (or the one named): cut plates the cut-plate flow (`flowId`
 * wins), cut sections the cut-section flow (`sectionFlowId`, else `flowId`,
 * wins). One set-based UPDATE per method; a cut piece that already has a flow
 * keeps it. Allowed on a locked line until it is released (a flow is the one
 * thing that still changes there — records.flowStillOpen); refused on a
 * released line or a closed/revised order.
 * input: { flowId?, sectionFlowId? } — returns { count, total, flowId, sections: { count, total, flowId } }.
 */
export async function setCutPlateFlows(db, c, lineId, input = {}) {
  const line = await requireLine(db, c.companyId, lineId, { lock: true });
  const f = lockOf(line);
  if (f && f.reason !== 'locked') throw invalid(f.code, f.message);
  const places = await loadPlaces(db, c.companyId);
  const state = line.line_type === 'custom' && line.item_id ? await survey(db, c.companyId, line, places) : null;
  const plateBlanks = state?.plate.cutPlates ?? [];
  const sectionBlanks = state?.section.cutPlates ?? [];
  const problems = [];
  let flowId;
  if (blank(input.flowId)) {
    flowId = await cutPlateFlowId(db, c.companyId);
    if (!flowId && (plateBlanks.length || !sectionBlanks.length)) throw invalid('NO_CUT_PLATE_FLOW', 'There is no cut-plate flow set. Set one under Production › Flows first, or say which flow.');
  } else {
    flowId = await requireUsableFlow(db, c.companyId, input.flowId, problems);
    if (problems.length) throw invalid('INVALID', 'The flow could not be used.', { problems });
  }
  const sections = { count: 0, total: sectionBlanks.length, flowId: null };
  if (sectionBlanks.length) {
    let sFlow = null;
    if (!blank(input.sectionFlowId)) {
      sFlow = await requireUsableFlow(db, c.companyId, input.sectionFlowId, problems);
      if (problems.length) throw invalid('INVALID', 'The flow could not be used.', { problems });
    } else sFlow = blank(input.flowId) ? await cutSectionFlowId(db, c.companyId) : flowId;
    sections.flowId = sFlow;
    const [[{ bare }]] = await db.query('SELECT COUNT(*) AS bare FROM cf_master_records WHERE company_id = ? AND id IN (?) AND default_flow_id IS NULL AND deleted_at IS NULL', [c.companyId, sectionBlanks.map((cp) => cp.id)]);
    if (Number(bare) && !sFlow) throw invalid('NO_CUT_SECTION_FLOW', 'There is no cut-section flow set. Set one under Setup › Cutting first, or say which flow.');
    if (Number(bare)) {
      const [r] = await db.query(
        'UPDATE cf_master_records SET default_flow_id = ? WHERE company_id = ? AND id IN (?) AND default_flow_id IS NULL AND deleted_at IS NULL',
        [sFlow, c.companyId, sectionBlanks.map((cp) => cp.id)],
      );
      sections.count = r.affectedRows;
    }
  }
  // Given a flow, a cut piece asks for what that flow reads.
  const follow = async () => { const ids = [...sectionBlanks, ...plateBlanks].map((cp) => cp.id); if (ids.length) await syncFlowSpecs(db, c, ids); };
  if (!plateBlanks.length) { await follow(); return { count: 0, total: 0, flowId, sections }; }
  const [r] = await db.query(
    'UPDATE cf_master_records SET default_flow_id = ? WHERE company_id = ? AND id IN (?) AND default_flow_id IS NULL AND deleted_at IS NULL',
    [flowId, c.companyId, plateBlanks.map((cp) => cp.id)],
  );
  await follow();
  return { count: r.affectedRows, total: plateBlanks.length, flowId, sections };
}

// --- for the freeze checks and release: every part, how it is cut, and what it lacks --

/**
 * Of these items (a line's temporaries — the roll-out's), the PARTS a cut piece
 * is made for and whether each has one, the made rows whose CUT_FROM has no
 * answer anywhere, and every section part's trouble — read in a fixed number
 * of queries. The one survey lockService (freeze checks), processService
 * (stages) and releaseService (release) ask, so "a part" means the same thing
 * everywhere.
 *
 * Returns {
 *   places,                          // the cutPlaces answer
 *   parts: [{ id, code, name, kind: 'plate'|'section', hasCutPiece }],
 *   unanswered: [{ id, code, name }],  // made rows with a parent and nothing made under them, CUT_FROM unanswered
 *   sections: [{ id, code, name, stock: Ref|null, lengthMm, problem: string|null }],
 *   inUse: { plate, section },
 * }
 * Only a row with nothing under it but its cut pieces can be "unanswered" (an
 * assembly is plainly not cut), and never opts.rootId (the line's own item).
 */
export async function cutPartsOf(db, companyId, itemIds, { rootId = null } = {}) {
  const ids = [...new Set(itemIds.map(Number))];
  const places = await loadPlaces(db, companyId);
  const out = { places: places.all, parts: [], unanswered: [], sections: [], inUse: { plate: false, section: false } };
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.record_kind, m.classification_id, m.cut_stock_id, i.item_type, i.source_definition_id,
            d.cut_stock_id AS def_cut_stock_id, d.code AS def_code, d.name AS def_name,
            (SELECT GROUP_CONCAT(DISTINCT x.classification_id) FROM cf_boms b
               JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
               JOIN cf_master_records x ON x.id = l.child_id AND x.deleted_at IS NULL
              WHERE b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL) AS child_classes
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL AND i.item_type = 'temporary'
       LEFT JOIN cf_master_records d ON d.id = i.source_definition_id AND d.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL
      ORDER BY m.id`,
    [companyId, ids],
  );
  const candidates = rows.filter((m) => !places.blankIds.has(Number(m.classification_id)));
  const resolved = await resolveCodes(db, companyId, candidates, [CUT_FROM_CODE, 'LENGTH']);
  const sectionParts = [];
  for (const m of candidates) {
    const kind = cutWordOf(resolved.get(m.id)?.get(CUT_FROM_CODE));
    const classes = String(m.child_classes ?? '').split(',').filter(Boolean).map(Number);
    if (kind === 'PLATE' || kind === 'SECTION') {
      const k = kind === 'PLATE' ? 'plate' : 'section';
      const blanksIds = places.all[k].blanksIds;
      out.parts.push({ id: m.id, code: m.code, name: m.name, kind: k, hasCutPiece: classes.some((x) => blanksIds.has(x)) });
      out.inUse[k] = true;
      if (k === 'section') sectionParts.push(m);
    } else if (kind == null && Number(m.id) !== Number(rootId) && classes.every((x) => places.blankIds.has(x))) {
      out.unanswered.push({ id: m.id, code: m.code, name: m.name });
    }
  }
  if (sectionParts.length) {
    const steel = await sectionSteelOf(db, companyId, sectionParts.map(partStockOf));
    // Every stock length of each profile in use, so "longer than every bar" can be said.
    const longest = await longestStockOf(db, companyId, places.all.section.stockIds, [...steel.values()]);
    for (const m of sectionParts) {
      const stockId = partStockOf(m);
      const stock = stockId != null ? steel.get(stockId) ?? null : null;
      const lenRow = resolved.get(m.id)?.get('LENGTH')?.own ?? null;
      const length = lenRow?.value_number != null ? round6(Number(lenRow.value_number)) : null;
      let problem = null;
      if (stockId == null) problem = 'no section chosen';
      else if (!stock || !places.all.section.stockIds.has(Number(stock.classificationId))) problem = `${stock ? nameOf(stock) : `item ${stockId}`} is not a section in stock`;
      else if (!(length > 0)) problem = 'no length';
      else {
        const max = longest.get(profileKeyOf(stock));
        if (max != null && length > max) problem = `${fmt(length)} mm is longer than any ${profileLabelOf(stock)} bar — ${fmt(max)} mm is the longest`;
      }
      out.sections.push({ id: m.id, code: m.code, name: m.name, stock: brief(stock), lengthMm: length, problem });
    }
  }
  return out;
}

/**
 * The longest stock length of each profile (profileKeyOf) among the given bars'
 * profiles, over every catalog bar in the section stock places. One query.
 */
async function longestStockOf(db, companyId, stockClassIds, bars) {
  const out = new Map();
  if (!stockClassIds.size || !bars.length) return out;
  const thick = [...new Set(bars.map((b) => b.thickness).filter((x) => x != null))];
  if (!thick.length) return out;
  const [rows] = await db.query(
    `SELECT m.id, UPPER(s.code) AS code, v.value_number, v.value_text, v.option_id, o.value AS option_value
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
       JOIN cf_spec_values v ON v.company_id = m.company_id AND v.subject_type = 'master' AND v.subject_id = m.id AND v.deleted_at IS NULL
       JOIN cf_specifications s ON s.id = v.specification_id AND s.code IN ('THICKNESS','WIDTH','DEPTH','GRADE','IMPACT_CLASS','LENGTH')
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.classification_id IN (?)
        AND m.id IN (SELECT t.subject_id FROM cf_spec_values t JOIN cf_specifications ts ON ts.id = t.specification_id AND ts.code = 'THICKNESS'
                      WHERE t.company_id = ? AND t.subject_type = 'master' AND t.deleted_at IS NULL AND t.value_number IN (?))`,
    [companyId, [...stockClassIds], companyId, thick],
  );
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.id)) byItem.set(r.id, { rows: new Map() });
    byItem.get(r.id).rows.set(r.code, r);
  }
  for (const it of byItem.values()) {
    const n = (code) => { const v = it.rows.get(code)?.value_number; return v == null ? null : round6(Number(v)); };
    const t = (code) => { const r = it.rows.get(code); return r ? (r.option_value ?? r.value_text ?? null) : null; };
    const prof = {
      thickness: n('THICKNESS'), width: n('WIDTH'), depth: n('DEPTH'),
      gradeId: it.rows.get('GRADE')?.option_id ?? null, grade: t('GRADE'),
      impactId: it.rows.get('IMPACT_CLASS')?.option_id ?? null, impactClass: t('IMPACT_CLASS'),
    };
    const len = n('LENGTH');
    if (len == null) continue;
    const k = profileKeyOf(prof);
    out.set(k, Math.max(out.get(k) ?? 0, len));
  }
  return out;
}

/**
 * What stops release because of a section (§5): a section part with no bar
 * (or none that is a stock bar), and a cut section with no stock line under
 * it. In words, one sentence per kind of trouble. Two or three queries; none
 * when the line cuts nothing from a section.
 */
export async function sectionStockProblems(db, companyId, itemIds) {
  const r = await cutPartsOf(db, companyId, itemIds);
  const problems = [];
  const unresolved = r.sections.filter((s) => s.problem === 'no section chosen' || /not a section in stock/.test(s.problem ?? ''));
  if (unresolved.length) {
    const names = unresolved.slice(0, 3).map((s) => s.code ?? s.name).join(', ');
    problems.push(`${plural(unresolved.length, 'part')} ${unresolved.length === 1 ? 'is' : 'are'} cut from a section but ${unresolved.length === 1 ? 'has' : 'have'} no stock bar chosen — ${names}${unresolved.length > 3 ? ` and ${unresolved.length - 3} more` : ''}. Choose the section ${unresolved.length === 1 ? 'it is' : 'each is'} cut from before release.`);
  }
  const blanksIds = r.places.section.blanksIds;
  if (blanksIds.size) {
    const ids = [...new Set(itemIds.map(Number))];
    const [bare] = ids.length ? await db.query(
      `SELECT m.id, m.code, m.name
         FROM cf_master_records m
        WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL AND m.classification_id IN (?)
          AND NOT EXISTS (SELECT 1 FROM cf_boms b
                            JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
                            JOIN cf_master_records x ON x.id = l.child_id AND x.deleted_at IS NULL AND x.record_kind = 'item'
                           WHERE b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL)`,
      [companyId, ids, [...blanksIds]],
    ) : [[]];
    if (bare.length) {
      problems.push(`${plural(bare.length, 'cut section')} ${bare.length === 1 ? 'has' : 'have'} no stock bar under ${bare.length === 1 ? 'it' : 'them'} — ${bare.slice(0, 3).map(nameOf).join(', ')}. Choose the section of the part it is cut from before release.`);
    }
  }
  return problems;
}
