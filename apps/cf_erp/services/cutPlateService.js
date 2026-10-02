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
import { requireUsableFlow, cutPlateFlowId } from './flowService.js';
import { readLineValues, materializeLineRecords } from './orderValuesService.js';
import { readRulesOnce, PLACED, rangesOf } from './codeRangeService.js';
import { generate } from '../modules/codegen/index.js';
import { refreshValues } from './valueService.js';
import { autofillLineSelections } from './selectionService.js';

/** The four facts that make two parts the same blank. */
const SPEC_CODES = ['THICKNESS', 'LENGTH', 'WIDTH', 'GRADE'];
const CUT_PLATE_CODE = 'CUT_PLATE';
const PLATE_CODE = 'PLATE';
const PARTS_CODE = 'FAB_PARTS';
/** instantiationService.temporaryTree walks this far down (its MAX_DEPTH + 5). */
const TREE_DEPTH = 25;
/** bomGraph.descendantIds' cap, for the loop rule. */
const LOOP_DEPTH = 25;
/** Well past Family › Subfamily › Variant, as a guard against a parent_id cycle. */
const SUBTREE_HOPS = 8;
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

// --- the three places in the classification tree this needs --------------------

/**
 * Nodes found by `where` and every live node below each, in one query. `seed_id`
 * says which found node a row hangs under — the same walk tree.subtreeIds does
 * a level at a time.
 */
const SUBTREES_SQL = (where) => `
  WITH RECURSIVE sub AS (
    SELECT n.id, n.parent_id, n.code, n.name, n.id AS seed_id, CAST(0 AS SIGNED) AS hop
      FROM cf_classification_nodes n
     WHERE n.company_id = ? AND n.deleted_at IS NULL AND ${where}
     UNION ALL
    SELECT c.id, c.parent_id, c.code, c.name, s.seed_id, s.hop + 1
      FROM sub s
      JOIN cf_classification_nodes c ON c.company_id = ? AND c.parent_id = s.id AND c.deleted_at IS NULL
     WHERE s.hop < ?
  )
  SELECT id, parent_id, code, name, seed_id, hop FROM sub`;

/**
 * Where the part temporaries are filed (FAB_PARTS — the code is the first
 * answer; "Parts" under "Fabricated" the second, so a tree built by hand still
 * works), where blanks are filed (CUT_PLATE), and where raw plates are filed
 * (PLATE) — with the subtrees of the first two. One query; two only when the
 * parts node has to be found by its name. Never throws: requirePlaces says what
 * is missing, in the order the checks have always been made.
 */
async function loadPlaces(db, companyId) {
  const [rows] = await db.query(SUBTREES_SQL('n.code IN (?)'), [companyId, [PARTS_CODE, CUT_PLATE_CODE, PLATE_CODE], companyId, SUBTREE_HOPS]);
  const seed = (code) => rows.find((r) => Number(r.hop) === 0 && String(r.code).toUpperCase() === code) ?? null;
  const under = (node, from) => (node ? from.filter((r) => r.seed_id === node.id).map((r) => r.id) : []);
  let parts = seed(PARTS_CODE);
  let partIds = under(parts, rows);
  if (!parts) {
    const [[n]] = await db.query(
      `SELECT n.id, n.code, n.name FROM cf_classification_nodes n
         JOIN cf_classification_nodes p ON p.id = n.parent_id AND p.deleted_at IS NULL
        WHERE n.company_id = ? AND n.deleted_at IS NULL AND n.name = 'Parts' AND p.name = 'Fabricated'
        ORDER BY n.id LIMIT 1`,
      [companyId],
    );
    if (n) {
      const [sub] = await db.query(SUBTREES_SQL('n.id = ?'), [companyId, n.id, companyId, SUBTREE_HOPS]);
      parts = n;
      partIds = under(n, sub);
    }
  }
  const cutPlate = seed(CUT_PLATE_CODE);
  const plate = seed(PLATE_CODE);
  return {
    parts: parts ? { id: parts.id, code: parts.code, name: parts.name } : null,
    partIds: new Set(partIds),
    cutPlate: cutPlate ? { id: cutPlate.id, code: cutPlate.code, name: cutPlate.name } : null,
    cutIds: under(cutPlate, rows),
    plate: plate ? { id: plate.id, code: plate.code, name: plate.name } : null,
  };
}

function requirePlaces(places) {
  if (!places.parts) throw invalid('NO_PARTS_CLASS', 'Nothing in the classification tree says where parts are filed — add Fabricated › Parts (or a node coded FAB_PARTS) and put the plate parts under it.');
  if (!places.cutPlate) throw invalid('NO_CUT_PLATE_CLASS', `There is no ${CUT_PLATE_CODE} variant under Steel › Plates — a cut plate has nowhere to be filed.`);
}

/** The selection definition that chooses a raw plate — found by what it searches, never by its id. */
export async function plateSelection(db, companyId, plate) {
  if (!plate) throw invalid('NO_PLATE_CLASS', `There is no ${PLATE_CODE} variant under Steel › Plates, so nothing says where raw plates are filed.`);
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.status FROM cf_definition_details d
       JOIN cf_master_records m ON m.id = d.master_id AND m.deleted_at IS NULL
      WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.definition_type = 'selection'
        AND d.candidate_classification_id = ? AND m.status = 'active'
      ORDER BY m.id`,
    [companyId, plate.id],
  );
  if (!rows.length) {
    throw invalid('NO_PLATE_SELECTION', `Nothing chooses the raw plate: there is no active selection definition searching ${plate.code}. Make one (the SEL Plate selection) before working out cut plates.`);
  }
  if (rows.length > 1) {
    throw invalid('MANY_PLATE_SELECTIONS', `${rows.length} selection definitions search ${plate.code} (${list(rows.map(nameOf))}) — a cut plate cannot be told which one chooses its raw plate. Retire the ones that do not.`);
  }
  return rows[0];
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
 * parts comes back once per part, and the IN below counts it once.
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
  SELECT m.id, m.code, m.name, m.status, m.classification_id, i.item_type, m.created_at
    FROM cf_master_records m
    JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
   WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.id IN (SELECT id FROM walk)
   ORDER BY m.id`;

/**
 * Everything the reconcile works from: the part temporaries under the line, the
 * cut plates their BOMs already point at, the lines that join them, and the
 * size each of them carries. Four queries.
 *
 * "Leaf" is not asked of the parts, because after one run they are not leaves
 * any more — each has gained its cut plate. What makes a part a part is where
 * it is filed.
 */
async function survey(db, companyId, line, places) {
  if (line.line_type !== 'custom') {
    throw invalid('NO_STRUCTURE', `Line ${line.line_no} of ${line.order_code} sells a catalog item, so it has no structure of its own — only a line built from a template has parts to cut.`);
  }
  // The walk always holds the line's own item, so "no structure at all" cannot
  // be reached past the check above.
  const [items] = await db.query(TREE_SQL, [line.item_id, companyId, TREE_DEPTH, companyId]);
  const parts = items.filter((m) => m.item_type === 'temporary' && places.partIds.has(m.classification_id));

  // The cut plates this line's parts are cut from. A cut plate nothing points
  // at is deliberately out of scope: an unclaimed one is an offcut, and an
  // offcut is nobody's to delete.
  const [links] = parts.length && places.cutIds.length ? await db.query(
    `SELECT l.id AS line_id, l.quantity, b.parent_id AS part_id, l.child_id AS cut_plate_id, l.created_at
       FROM cf_boms b
       JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.child_id AND m.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.parent_id IN (?) AND m.classification_id IN (?)
      ORDER BY l.id`,
    [companyId, parts.map((p) => p.id), places.cutIds],
  ) : [[]];

  const cutPlateIds = new Set(links.map((l) => l.cut_plate_id));
  const cutPlates = items.filter((m) => cutPlateIds.has(m.id));
  // A blank is a temporary child of the part it is cut from, so the walk has
  // it — unless the part sits at the very bottom of the walk's depth. Read
  // those the old way rather than lose them.
  const lost = [...cutPlateIds].filter((id) => !cutPlates.some((cp) => cp.id === id));
  if (lost.length) {
    const [more] = await db.query(
      `SELECT m.id, m.code, m.name, m.status, m.classification_id, i.item_type, m.created_at
         FROM cf_master_records m
         JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
        WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`,
      [companyId, lost],
    );
    cutPlates.push(...more);
    cutPlates.sort((a, b) => a.id - b.id);
  }
  const values = await specValuesOf(db, companyId, [...parts.map((p) => p.id), ...cutPlates.map((cp) => cp.id)]);
  for (const m of [...parts, ...cutPlates]) {
    m.values = values.get(m.id) ?? new Map();
    m.size = sizeOf(m.values);
  }
  return { parts, cutPlates, links };
}

/**
 * Each existing cut plate's own BOM and its live lines, in line order — what
 * bomOfParent + linesOfBom read per blank — and whether an accepted nesting of
 * THIS line has laid it out (see NESTED_NOTE): a placement on one of the
 * line's plate lots names it. One query. Returns
 *   { lines: Map(cutPlateId -> [line]), nested: Set(cutPlateId) }
 */
async function plateLinesOf(db, companyId, orderLineId, cutPlateIds) {
  const lines = new Map(cutPlateIds.map((id) => [id, []]));
  const nested = new Set();
  if (!cutPlateIds.length) return { lines, nested };
  const [rows] = await db.query(
    `SELECT cp.id AS parent_id, l.id, l.line_no, l.child_id, l.design_id, l.position, l.quantity,
            l.selection_definition_id, ch.record_kind AS child_record_kind,
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
function planGroups({ parts, cutPlates, links }) {
  const groups = group(parts);
  const partById = new Map(parts.map((p) => [p.id, p]));
  const byId = new Map(cutPlates.map((cp) => [cp.id, cp]));
  const drops = new Set();

  const liveLinks = [];
  for (const l of links) {
    const part = partById.get(l.part_id);
    const cp = byId.get(l.cut_plate_id);
    if (part && cp && keyOf(part.size) === keyOf(cp.size)) liveLinks.push(l);
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
 * Whether the plan writes anything. A blank nothing is cut from any more only
 * appears when some line was let go of, so the drops cover it.
 */
const writes = (plan) => plan.drops.size > 0 || plan.groups.some((x) => x.isNew || x.attachTo.length > 0 || x.plateLine?.changed);

/**
 * The whole plan, from what survey() read: the plate lines, the default
 * candidate and the plates, then the reconcile. `carried` — see planPlateLines.
 */
async function planFor(db, companyId, { line, state, selection, carried = null }) {
  const plateLines = await plateLinesOf(db, companyId, line.id, state.cutPlates.map((cp) => cp.id));
  const plan = planGroups(state);
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
async function blankRulesAt(db, companyId, cutPlateId) {
  const view = await resolveSpecs(db, companyId, { nodeId: cutPlateId });
  const specs = view.specs ?? [];
  const extras = specs
    .filter((e) => e.applicable && e.rule?.isRequired && e.rule?.valueRule === 'entered' && !SPEC_CODES.includes(e.spec.code))
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
async function blankValueChecker(db, companyId, fresh, cutPlateId) {
  const rules = await blankRulesAt(db, companyId, cutPlateId);

  // Every option of the option specs being written, retired ones too, so a
  // refusal names the same reason coerce gives.
  const codes = [...SPEC_CODES, ...rules.extras];
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
    const size = x.group.size;
    const sizes = await typed([
      { code: 'THICKNESS', value: size.thickness },
      { code: 'LENGTH', value: size.length },
      { code: 'WIDTH', value: size.width },
      { code: 'GRADE', value: size.gradeId ?? size.gradeText },
    ]);
    if (sizes.problems.length) {
      throw invalid('CUT_PLATE_SPECS', 'A cut plate cannot be given its size where cut plates are filed — the four specifications have to be set there, the way they are for bought plates.', { problems: sizes.problems });
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
      throw invalid('CUT_PLATE_INHERIT', `A cut plate could not take ${asked.map((w) => w.code).join(', ')} from the part it is cut from — the rule where cut plates are filed does not accept the part's own answer.`, { problems: steel.problems });
    }
    x.values = [...sizes.out, ...steel.out];
  };
  return { rules, options, check };
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
async function nameAndCode(db, c, { line, places, blankRules, fresh }) {
  const { companyId } = c;
  const memo = readRulesOnce(db);
  const chain = await ancestors(db, companyId, places.cutPlate.id);
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
        short_name: 'CUTPL', classification_id: places.cutPlate.id, status: 'draft', owner_order_line_id: line.id, source_definition_id: null,
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

    const fallbackName = `Cut plate ${fmt(size.thickness)} × ${fmt(size.width)} × ${fmt(size.length)}${size.gradeText ? ` ${size.gradeText}` : ''}`;
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
async function applyPlan(db, c, { line, places, selection, flowId, state, plan }) {
  const { companyId } = c;
  const fresh = plan.groups.filter((x) => x.isNew);
  const values = fresh.length ? await blankValueChecker(db, companyId, fresh, places.cutPlate.id) : null;
  const loops = await loopChecker(db, companyId, plan);
  for (const x of plan.groups) {
    if (x.isNew) await values.check(x);
    loops.check(x);
  }

  // 1. Lines let go of: parts that changed size, a group pulled back onto one
  //    blank, a blank's duplicate plate lines.
  if (plan.drops.size) {
    await db.query('UPDATE cf_bom_lines SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, [...plan.drops]]);
  }

  // 2. The new blanks. A cut plate is a temporary item with no template
  //    definition behind it — derived from the parts, not instantiated from a
  //    blueprint — so its rows are written here rather than through
  //    masterRecordService, whose createItem takes a temporary item's
  //    classification from a template definition. Born a draft like every
  //    other temporary item (decision Q21); counted, not identified — a batch
  //    of identical rectangles, always made on its order, never stocked. Each
  //    is written with a code unique to this derive and found again by it
  //    (TiDB does not hand AUTO_INCREMENT ids out contiguously); nameAndCode
  //    overwrites every placeholder.
  if (fresh.length) {
    // How a new cut plate is made: what a revision carried for its rectangle,
    // else the flow this derive was given, else the house's cut-plate flow
    // (init.sql §33 — user, 2026-09-30: cutting belongs to the cut plate).
    // Read only when one of them still needs it; nothing already set changes.
    const house = flowId == null && fresh.some((x) => x.carriedFlowId == null) ? await cutPlateFlowId(db, companyId) : null;
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const marker = (i) => `~cut~${token}~${i}`;
    await insertRows(db, 'cf_master_records',
      ['company_id', 'record_kind', 'code', 'name', 'short_name', 'classification_id', 'status', 'default_flow_id', 'created_by'],
      fresh.map((x, i) => [companyId, 'item', marker(i), '(pending)', 'CUTPL', places.cutPlate.id, 'draft', x.carriedFlowId ?? flowId ?? house, c.userId]));
    const [back] = await db.query('SELECT id, code FROM cf_master_records WHERE company_id = ? AND code LIKE ?', [companyId, `~cut~${token}~%`]);
    const idOf = new Map(back.map((r) => [r.code, r.id]));
    fresh.forEach((x, i) => { x.cp = { id: idOf.get(marker(i)), code: null, name: '(pending)', status: 'draft', classification_id: places.cutPlate.id }; });
    if (fresh.some((x) => !x.cp.id)) throw new Error(`cf_erp: ${fresh.length} cut plates written, ${back.length} read back.`);
    await insertRows(db, 'cf_item_details',
      ['master_id', 'company_id', 'item_type', 'tracked_by', 'uom', 'sourcing', 'source_definition_id', 'owner_order_line_id'],
      fresh.map((x) => [x.cp.id, companyId, 'temporary', 'quantity', 'nos', 'make', null, line.id]));
  }

  // 3. Every new BOM line, in the order the one-at-a-time derive made them:
  //    per group, a new blank's line under its first part, the other parts'
  //    lines to it, then its plate line. A blank legitimately has several
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
    if (x.plateLine.add) {
      adds.push({ parentId: x.cp.id, childId: x.plateLine.add.childId, designId: selection.id, quantity: x.plateLine.add.quantity, role: 'Raw plate', selectionDefinitionId: selection.id });
    }
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
      if (missing.some((id) => !bomOf.has(id))) throw new Error('cf_erp: a cut plate BOM was written and not read back.');
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

  // 4. The new blanks' own values — the four sizes and the steel of the part —
  //    with their history, as setValues writes them.
  if (fresh.length) {
    const given = fresh.flatMap((x) => x.values.map((w) => ({ subjectId: x.cp.id, ...w })));
    if (given.length) {
      await insertRows(db, 'cf_spec_values',
        ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_number', 'value_text', 'value_bool', 'value_date', 'option_id', 'uom', 'source', 'created_by'],
        given.map((w) => [companyId, w.spec.id, 'master', w.subjectId, w.typed.value_number, w.typed.value_text, w.typed.value_bool,
          w.typed.value_date, w.typed.option_id, w.spec.unit ?? null, 'entered', c.userId]));
      const [back] = await db.query(
        `SELECT id, subject_id, specification_id FROM cf_spec_values
          WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND specification_id IN (?) AND deleted_at IS NULL`,
        [companyId, fresh.map((x) => x.cp.id), [...new Set(given.map((w) => w.spec.id))]],
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
  }

  // 5. Plate lines that move: a default filled in, a quantity that follows the
  //    parts or the plate.
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
      removed.push(...gone.map((cp) => ({ id: cp.id, code: cp.code, name: cp.name })));
    }
  }

  // 7. The values, settled once for the line: new blanks worked out from their
  //    rules, and whatever reads them — parts' roll-ups, assemblies above —
  //    walked until nothing moves. New blanks before the parts above them.
  const settle = [...plan.groups.map((x) => x.cp.id), ...state.parts.map((p) => p.id)];
  await materializeLineRecords(db, c, line.id, settle);

  // 8. Names and codes for the new blanks — a code may print a value.
  if (fresh.length) await nameAndCode(db, c, { line, places, blankRules: values, fresh });
  return removed;
}

// --- what the screens are told ---------------------------------------------------

function shape(line, selection, cutPlates) {
  return {
    line: { id: line.id, lineNo: line.line_no, orderId: line.order_id, orderCode: line.order_code, quantity: Number(line.quantity) },
    selection: { id: selection.id, code: selection.code, name: selection.name },
    basis: 'area fraction',
    caveat: AREA_FRACTION_CAVEAT,
    cutPlates,
  };
}

const describe = (cp, size, parts, plateLine) => ({
  id: cp.id,
  code: cp.code,
  name: cp.name,
  status: cp.status,
  size: { thickness: size.thickness, length: size.length, width: size.width, grade: size.gradeText },
  partCount: parts.length,
  parts: parts.map((p) => ({ id: p.id, code: p.code, name: p.name })),
  plate: plateLine.plate,
  plateQuantity: plateLine.quantity,
  plateQuantityBasis: plateLine.basis,
  // What the plate column says (CF_ERP_ORDER_FLOW_PLAN): 'at_nesting' — the
  // line still holds the selection, "chosen at nesting"; 'nested' — an accepted
  // nest laid it out (getCutPlates adds the lots); 'chosen' — a plate is on the
  // line, chosen by hand (or by an earlier default, which reads the same).
  plateState: plateLine.basis === 'nesting' ? 'nested' : plateLine.plate ? 'chosen' : 'at_nesting',
  note: plateLine.note,
  otherLines: plateLine.otherLines,
});

/** Everything a derive starts from, with the refusals in the order they have always come. */
async function openForDerive(db, c, orderLineId, input) {
  const line = await requireLine(db, c.companyId, orderLineId, { lock: true });
  assertOpen(line);
  if (!line.item_id) throw invalid('NO_ITEM', `Line ${line.line_no} of ${line.order_code} has no item yet.`);

  const problems = [];
  const flowId = blank(input.flowId) ? null : await requireUsableFlow(db, c.companyId, input.flowId, problems);
  if (problems.length) throw invalid('INVALID', 'The flow could not be used.', { problems });

  const places = await loadPlaces(db, c.companyId);
  requirePlaces(places);
  const selection = await plateSelection(db, c.companyId, places.plate);
  const state = await survey(db, c.companyId, line, places);
  return { line, flowId, places, selection, state };
}

/** A derive from an opened line: plan, and write when the plan changes something. */
async function deriveOpened(db, c, { line, flowId, places, selection, state }, plan = null) {
  const p = plan ?? await planFor(db, c.companyId, { line, state, selection });
  const changed = writes(p);
  const removed = changed ? await applyPlan(db, c, { line, places, selection, flowId, state, plan: p }) : [];
  const out = p.groups.map((x) => describe(x.cp, x.group.size, x.group.parts, x.plateLine));
  const created = p.groups.filter((x) => x.isNew).length;
  const updated = p.groups.filter((x) => !x.isNew && x.plateLine.changed).length;
  return {
    ...shape(line, selection, out),
    created,
    updated,
    removed,
    unchanged: out.length - created - updated,
    changed,
  };
}

// --- the entry points --------------------------------------------------------------

/**
 * Works out the cut plates a line's parts are cut from, and makes the structure
 * say so — whether or not the line's values are complete (it is the "Make them
 * now" button; refreshCutPieces is the automatic one). Re-runnable: what is
 * right is left alone, what changed is moved, and a cut plate nothing is cut
 * from any more is deleted. A derive that changes nothing writes nothing.
 *
 * input: { flowId? } — how a cut plate is made, put on the ones it creates, so
 * a derived blank is not a node release has to refuse for having no flow.
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
  const cut = new Set(places.cutIds);
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
  const stamps = [...state.cutPlates.map((cp) => cp.created_at), ...state.links.map((l) => l.created_at)]
    .filter(Boolean).map((d) => new Date(d).getTime()).filter(Number.isFinite);
  if (!stamps.length || !line.db_now) return null;
  const age = new Date(line.db_now).getTime() - Math.max(...stamps);
  return new Date(Date.now() - Math.max(0, age)).toISOString();
}

/**
 * The cut plates a line already has, exactly as they stand. Writes nothing.
 *
 * Beside them, what the Cut pieces screen needs to say what happens next:
 *   lock        why they are frozen, when they are (closed, released, locked)
 *   values      { missing, items, complete } — required values still empty on
 *               the line's own rows (not the cut pieces'), while there are
 *               parts to cut and the line is open; null otherwise
 *   upToDate    whether a derive would change nothing now — the derive's own
 *               plan, not written; null while it cannot be worked out (a part
 *               with no size, a frozen line)
 *   lastMadeAt  ISO time the newest cut piece or part line was made, or null
 *   parts       how many plate parts the line has
 */
export async function getCutPlates(db, companyId, orderLineId) {
  const line = await requireLine(db, companyId, orderLineId);
  if (!line.item_id) throw invalid('NO_ITEM', `Line ${line.line_no} of ${line.order_code} has no item yet.`);
  const places = await loadPlaces(db, companyId);
  requirePlaces(places);
  const selection = await plateSelection(db, companyId, places.plate);
  const state = await survey(db, companyId, line, places);
  const { parts, cutPlates, links } = state;
  const lock = lockOf(line);

  // The derive's own plan, not written: the same reconcile the write acts on.
  const plateLines = await plateLinesOf(db, companyId, orderLineId, cutPlates.map((cp) => cp.id));
  const { nested } = plateLines;
  let plan = null;
  if (!lock) {
    try { plan = planGroups(state); } catch (err) { if (!(err instanceof CfError)) throw err; }
  }
  // No default candidate any more: a plate line still holding the selection is
  // waiting for nesting, not behind (planFor).
  const pick = null;

  const keepOf = new Map(cutPlates.map((cp) => [cp.id, ownLines(plateLines.lines.get(cp.id) ?? [], selection)[0] ?? null]));
  const plates = await platesOf(db, companyId, [
    ...[...keepOf.values()].filter((k) => k && k.child_record_kind === 'item').map((k) => k.child_id),
    ...(pick ? [pick.id] : []),
  ]);
  if (plan) planPlateLines(plan, plateLines, { selection, pick, plates });

  // The nests each nested cut plate sits on, for the plate column ("N-012 · PL-…").
  // One query, and only when something is nested.
  const lotsOf = new Map();
  if (nested.size) {
    const [lotRows] = await db.query(
      `SELECT DISTINCT np.cut_plate_id, pl.id, pl.lot_no, m.code AS plate_code, m.name AS plate_name
         FROM cf_nest_placements np
         JOIN cf_plate_lots pl ON pl.id = np.plate_lot_id AND pl.deleted_at IS NULL
         LEFT JOIN cf_master_records m ON m.id = pl.plate_item_id
        WHERE np.company_id = ? AND pl.order_line_id = ? AND np.deleted_at IS NULL AND np.cut_plate_id IN (?)
        ORDER BY pl.lot_no, pl.id`,
      [companyId, orderLineId, [...nested]],
    );
    for (const r of lotRows) {
      if (!lotsOf.has(Number(r.cut_plate_id))) lotsOf.set(Number(r.cut_plate_id), []);
      lotsOf.get(Number(r.cut_plate_id)).push({ id: r.id, lotNo: r.lot_no, plate: { code: r.plate_code, name: r.plate_name } });
    }
  }

  const partById = new Map(parts.map((p) => [p.id, p]));
  const out = [];
  for (const cp of cutPlates) {
    const mine = links.filter((l) => l.cut_plate_id === cp.id).map((l) => partById.get(l.part_id)).filter(Boolean);
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
      nestLots: lotsOf.get(Number(cp.id)) ?? [],
      // The first nest it sits on, as the plate column shows it ("N-012 · PL-…");
      // `lots` says how many nests it is spread over.
      nest: lotsOf.get(Number(cp.id))?.length
        ? { nestNo: lotsOf.get(Number(cp.id))[0].lotNo, code: lotsOf.get(Number(cp.id))[0].plate.code ?? null, lots: lotsOf.get(Number(cp.id)).length }
        : null,
    });
  }
  const pooled = new Set(links.map((l) => l.part_id));
  const values = !lock && parts.length ? missingValues(await readLineValues(db, companyId, orderLineId), places) : null;
  return {
    ...shape(line, selection, out),
    partsWithoutBlank: parts.filter((p) => !pooled.has(p.id)).map((p) => ({ id: p.id, code: p.code, name: p.name, missing: missingOf(p.size) })),
    lock: lock ? { reason: lock.reason, message: lock.message } : null,
    values,
    upToDate: plan ? !writes(plan) : null,
    lastMadeAt: lastMadeAt(line, state),
    parts: parts.length,
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
 * size, a coding rule that clashes — because it runs behind somebody else's
 * save, and a save must not fail because the cut pieces could not follow it.
 * It says why instead, and anything it had begun writing is rolled back to a
 * savepoint first. Something genuinely broken (the database) still throws.
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
  if (!places.parts || !places.cutPlate) {
    return stop('not_set_up', !places.parts
      ? 'Nothing in the classification tree says where parts are filed, so there is nothing to pool.'
      : `There is no ${CUT_PLATE_CODE} variant, so a cut piece has nowhere to be filed.`);
  }
  let opened;
  let plan = null;
  let planError = null;
  try {
    const state = await survey(db, companyId, line, places);
    if (!state.parts.length) return stop('no_plate_parts', `Line ${line.line_no} has no plate parts, so there is nothing to cut.`, { cutPieces: 0 });
    const selection = await plateSelection(db, companyId, places.plate);
    opened = { line, flowId: null, places, selection, state };
    try { plan = await planFor(db, companyId, { line, state, selection, carried: opts.carry ?? null }); } catch (err) { if (!isRefusal(err)) throw err; planError = err; }
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return stop('cannot_derive', err.message, { problems: err.problems ?? [] });
  }

  // Nothing would change: done, whatever the values say.
  if (plan && !writes(plan)) {
    return stop('up_to_date', `The ${plural(plan.groups.length, 'cut piece')} of line ${line.line_no} already match its parts.`, { cutPieces: plan.groups.length });
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
 * (user, 2026-10-02) — a plate part still without one is made by the freeze
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
  if (!places.parts || !places.cutPlate) {
    return no('not_set_up', !places.parts
      ? 'Nothing in the classification tree says where parts are filed, so there is nothing to pool.'
      : `There is no ${CUT_PLATE_CODE} variant, so a cut piece has nowhere to be filed.`);
  }
  try {
    const state = await survey(db, companyId, line, places);
    if (!state.parts.length) return no('no_plate_parts', `Line ${line.line_no} has no plate parts, so there is nothing to cut.`);
    const selection = await plateSelection(db, companyId, places.plate);
    await planFor(db, companyId, { line, state, selection });
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
 * selection) and the flow the cut plate is made by. For a REVISION
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
  if (!places.parts || !places.cutPlate || !places.plate) return out;
  let state;
  let selection;
  try {
    state = await survey(db, companyId, line, places);
    if (!state.cutPlates.length) return out;
    selection = await plateSelection(db, companyId, places.plate);
  } catch (err) {
    if (isRefusal(err)) return out;
    throw err;
  }
  const { lines } = await plateLinesOf(db, companyId, line.id, state.cutPlates.map((cp) => cp.id));
  const [flows] = await db.query('SELECT id, default_flow_id FROM cf_master_records WHERE company_id = ? AND id IN (?)', [companyId, state.cutPlates.map((cp) => cp.id)]);
  const flowOf = new Map(flows.map((r) => [r.id, r.default_flow_id ?? null]));
  for (const cp of state.cutPlates) {
    if (missingOf(cp.size).length) continue;
    const keep = ownLines(lines.get(cp.id) ?? [], selection)[0];
    out.set(keyOf(cp.size), {
      plateId: keep && keep.child_record_kind === 'item' ? Number(keep.child_id) : null,
      flowId: flowOf.get(cp.id) ?? null,
    });
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

// --- the flow of every cut plate of a line -----------------------------------------

/**
 * Which cut plates of a line have no flow, and the flow the house would give
 * them. Read-only and silent: a line with nothing to say (a catalog line, no
 * plate classes) answers zero. Used by the release check so the dialog can
 * offer ONE button instead of listing one problem per cut plate.
 * { total, missing, names[], flow: { id, code, name } | null }
 */
export async function cutPlateFlowGaps(db, companyId, lineId) {
  const none = { total: 0, missing: 0, names: [], flow: null };
  const line = await requireLine(db, companyId, lineId);
  if (line.line_type !== 'custom' || !line.item_id) return none;
  const places = await loadPlaces(db, companyId);
  if (!places.parts || !places.cutPlate || !places.plate) return none;
  let state;
  try { state = await survey(db, companyId, line, places); } catch (err) { if (isRefusal(err)) return none; throw err; }
  if (!state.cutPlates.length) return none;
  const [rows] = await db.query(
    'SELECT id, code, name, default_flow_id FROM cf_master_records WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL',
    [companyId, state.cutPlates.map((cp) => cp.id)],
  );
  const bare = rows.filter((r) => r.default_flow_id == null);
  const [[f]] = await db.query(
    `SELECT f.id, f.code, f.name FROM cf_company_settings s
       JOIN cf_operation_flows f ON f.company_id = s.company_id AND f.id = s.cut_plate_flow_id AND f.deleted_at IS NULL AND f.status <> 'obsolete'
      WHERE s.company_id = ?`,
    [companyId],
  );
  return {
    total: rows.length,
    missing: bare.length,
    names: bare.flatMap((r) => [r.code, r.name]).filter(Boolean),
    flow: f ? { id: f.id, code: f.code, name: f.name } : null,
  };
}

/**
 * Gives every cut plate of the line that has NO flow the company's cut-plate
 * flow (or `flowId`). One set-based UPDATE; a cut plate that already has a flow
 * keeps it. Allowed on a locked line until it is released (a flow is the one
 * thing that still changes there — records.flowStillOpen); refused on a
 * released line or a closed/revised order.
 * input: { flowId? } — returns { count, total, flow }.
 */
export async function setCutPlateFlows(db, c, lineId, input = {}) {
  const line = await requireLine(db, c.companyId, lineId, { lock: true });
  const f = lockOf(line);
  if (f && f.reason !== 'locked') throw invalid(f.code, f.message);
  const problems = [];
  let flowId;
  if (blank(input.flowId)) {
    flowId = await cutPlateFlowId(db, c.companyId);
    if (!flowId) throw invalid('NO_CUT_PLATE_FLOW', 'There is no cut-plate flow set. Set one under Production › Flows first, or say which flow.');
  } else {
    flowId = await requireUsableFlow(db, c.companyId, input.flowId, problems);
    if (problems.length) throw invalid('INVALID', 'The flow could not be used.', { problems });
  }
  const places = await loadPlaces(db, c.companyId);
  requirePlaces(places);
  const state = await survey(db, c.companyId, line, places);
  if (!state.cutPlates.length) return { count: 0, total: 0, flowId };
  const [r] = await db.query(
    'UPDATE cf_master_records SET default_flow_id = ? WHERE company_id = ? AND id IN (?) AND default_flow_id IS NULL AND deleted_at IS NULL',
    [flowId, c.companyId, state.cutPlates.map((cp) => cp.id)],
  );
  return { count: r.affectedRows, total: state.cutPlates.length, flowId };
}
