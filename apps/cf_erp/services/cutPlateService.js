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
 *                    ->  its own BOM: the SEL Plate selection, which resolves
 *                        to a real plate item from the catalog.
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
 */
import { invalid, notFound } from '../lib/errors.js';
import { LOCKED_ORDER_STATUSES, loadMaster } from './records.js';
import { subtreeIds } from './tree.js';
import { setValues, refreshValues } from './valueService.js';
import { resolve as resolveSpecs } from './resolutionService.js';
import { bomOfParent, createBom, insertLine, linesOfBom, nextLineNo, nextPosition, descendantIds } from './bomGraph.js';
import { temporaryTree, deleteTemporaryTree, defaultCandidate } from './instantiationService.js';
import { requireUsableFlow } from './flowService.js';
import { generate } from '../modules/codegen/index.js';

/** The four facts that make two parts the same blank. */
const SPEC_CODES = ['THICKNESS', 'LENGTH', 'WIDTH', 'GRADE'];
const CUT_PLATE_CODE = 'CUT_PLATE';
const PLATE_CODE = 'PLATE';
const PARTS_CODE = 'FAB_PARTS';

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
 */

/**
 * Which specs a blank filed HERE will need beyond the four sizes. Resolved from
 * the CLASSIFICATION once per derivation, not once per blank — every blank in a
 * run is filed at the same node, and over the production link a needless
 * resolve per blank is 49 ms each.
 */
async function extrasRequiredAt(db, companyId, classificationId) {
  const view = await resolveSpecs(db, companyId, { nodeId: classificationId });
  return (view.specs ?? [])
    .filter((e) => e.applicable
      && e.rule?.isRequired
      && e.rule?.valueRule === 'entered'
      && !SPEC_CODES.includes(e.spec.code))
    .map((e) => e.spec.code);
}

/** Copy those from the part, where the part can answer. */
async function inheritRemainingSteel(db, c, blankId, partId, extras) {
  if (!extras?.length || !partId) return;
  // loadMaster, NOT a bare row: resolve() needs source_definition_id to include
  // the TEMPLATE DEFINITION level in the chain, and a part's steel is very often
  // set there rather than typed onto the instance. A bare SELECT * silently
  // drops that level and the value is never found.
  const part = await loadMaster(db, c.companyId, partId);
  if (!part) return;
  const theirs = await resolveSpecs(db, c.companyId, { master: part });
  const byCode = new Map((theirs.specs ?? []).map((e) => [e.spec.code, e]));

  const writes = [];
  for (const code of extras) {
    const raw = byCode.get(code)?.value?.raw;
    if (raw == null || raw === '') continue;          // the part cannot say either
    writes.push({ specCode: code, value: raw });
  }
  if (!writes.length) return;
  try {
    await setValues(db, c, 'master', blankId, writes);
  } catch (err) {
    if (err.code !== 'INVALID_VALUES') throw err;
    throw invalid('CUT_PLATE_INHERIT', `A cut plate could not take ${writes.map((w) => w.specCode).join(', ')} from the part it is cut from — the rule where cut plates are filed does not accept the part's own answer.`, { problems: err.problems ?? [] });
  }
}

export const AREA_FRACTION_CAVEAT = 'The plate quantity is the blank\'s area divided by the raw plate\'s — it ignores how the blanks lie on the sheet and the offcut left over, so it is a first answer, not a nesting plan. Real nesting will replace it, and it will ask for more steel than this, not less.';

const round6 = (n) => Number(Number(n).toFixed(6));
const fmt = (n) => String(round6(n));
const blank = (v) => v == null || String(v).trim() === '';
const nameOf = (r) => r.code ?? r.name;
const list = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// --- what the line is, and whether it may still be changed ---------------------

async function requireLine(db, companyId, lineId, { lock = false } = {}) {
  const [[l]] = await db.query(
    `SELECT l.*, o.code AS order_code, o.status AS order_status, o.order_type,
            rel.id AS release_id
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
 * Cut plates are part of the structure, so the same two rules that close a
 * structure to change close this: a frozen order, and a released line whose
 * tracker is already the snapshot of what was there.
 */
function assertOpen(line) {
  if (LOCKED_ORDER_STATUSES.has(line.order_status)) {
    throw invalid('ORDER_LOCKED', `Order ${line.order_code} is ${line.order_status} — its structure can no longer change, so its cut plates cannot either.`);
  }
  if (line.release_id) {
    throw invalid('RELEASED', `Line ${line.line_no} of ${line.order_code} is released to production — its structure is fixed. Take the release back (while nothing has started) before working out its cut plates.`);
  }
}

// --- the three places in the classification tree this needs --------------------

async function nodeByCode(db, companyId, code) {
  const [[n]] = await db.query(
    'SELECT id, code, name FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL',
    [companyId, code],
  );
  return n || null;
}

/**
 * Where the part temporaries are filed. The code is the first answer; naming it
 * "Parts" under "Fabricated" is the second, so a tree built by hand still works.
 */
async function partsNode(db, companyId) {
  const found = await nodeByCode(db, companyId, PARTS_CODE);
  if (found) return found;
  const [[n]] = await db.query(
    `SELECT n.id, n.code, n.name FROM cf_classification_nodes n
       JOIN cf_classification_nodes p ON p.id = n.parent_id AND p.deleted_at IS NULL
      WHERE n.company_id = ? AND n.deleted_at IS NULL AND n.name = 'Parts' AND p.name = 'Fabricated'
      ORDER BY n.id LIMIT 1`,
    [companyId],
  );
  if (!n) throw invalid('NO_PARTS_CLASS', 'Nothing in the classification tree says where parts are filed — add Fabricated › Parts (or a node coded FAB_PARTS) and put the plate parts under it.');
  return n;
}

/** The selection definition that chooses a raw plate — found by what it searches, never by its id. */
async function plateSelection(db, companyId) {
  const plate = await nodeByCode(db, companyId, PLATE_CODE);
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
 * sizes are one query rather than a full resolution per part.
 */
async function specValuesOf(db, companyId, masterIds) {
  const out = new Map(masterIds.map((id) => [id, new Map()]));
  if (!masterIds.length) return out;
  const [rows] = await db.query(
    `SELECT v.subject_id, s.code, v.value_number, v.value_text, v.option_id, o.value AS option_value
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?)
        AND v.deleted_at IS NULL AND s.code IN (?)`,
    [companyId, masterIds, SPEC_CODES],
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

async function mastersOf(db, companyId, ids) {
  if (!ids.length) return [];
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.status, m.classification_id, i.item_type
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`,
    [companyId, ids],
  );
  return rows;
}

/**
 * Everything the reconcile works from: the part temporaries under the line, the
 * cut plates their BOMs already point at, the lines that join them, and the
 * size each of them carries.
 *
 * "Leaf" is not asked of the parts, because after one run they are not leaves
 * any more — each has gained its cut plate. What makes a part a part is where
 * it is filed.
 */
async function survey(db, companyId, line, places) {
  if (line.line_type !== 'custom') {
    throw invalid('NO_STRUCTURE', `Line ${line.line_no} of ${line.order_code} sells a catalog item, so it has no structure of its own — only a line built from a template has parts to cut.`);
  }
  const treeIds = [...new Set(await temporaryTree(db, companyId, line.item_id))];
  if (!treeIds.length) throw invalid('NO_STRUCTURE', `Line ${line.line_no} of ${line.order_code} has no structure of its own — only a line built from a template has parts to cut.`);

  const partSet = new Set(await subtreeIds(db, companyId, places.parts.id));
  const cutNodes = await subtreeIds(db, companyId, places.cutPlate.id);
  const items = await mastersOf(db, companyId, treeIds);
  const parts = items.filter((m) => m.item_type === 'temporary' && partSet.has(m.classification_id));

  // The cut plates this line's parts are cut from. A cut plate nothing points
  // at is deliberately out of scope: an unclaimed one is an offcut, and an
  // offcut is nobody's to delete.
  const [links] = parts.length ? await db.query(
    `SELECT l.id AS line_id, l.quantity, b.parent_id AS part_id, l.child_id AS cut_plate_id
       FROM cf_boms b
       JOIN cf_bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_master_records m ON m.id = l.child_id AND m.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.parent_id IN (?) AND m.classification_id IN (?)
      ORDER BY l.id`,
    [companyId, parts.map((p) => p.id), cutNodes],
  ) : [[]];

  const cutPlateIds = [...new Set(links.map((l) => l.cut_plate_id))];
  const cutPlates = await mastersOf(db, companyId, cutPlateIds);
  const values = await specValuesOf(db, companyId, [...parts.map((p) => p.id), ...cutPlateIds]);
  for (const m of [...parts, ...cutPlates]) m.size = sizeOf(values.get(m.id) ?? new Map());
  return { parts, cutPlates, links };
}

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

// --- creating one cut plate ----------------------------------------------------

/**
 * A cut plate is a temporary item with no template definition behind it — it is
 * derived from the parts, not instantiated from a blueprint — so the master and
 * detail rows are written here rather than through masterRecordService, whose
 * createItem takes a temporary item's classification from a template definition
 * and refuses one without it. Everything after the two inserts is what
 * createItem does: values, then the name, then the code.
 *
 * It is born a draft like every other temporary item (decision Q21). Release
 * refuses drafts, so the structure is activated once, at the end, the way the
 * rest of it already is.
 */
async function createCutPlate(db, c, { size, classificationId, place, flowId, extras = [] }) {
  const [r] = await db.query(
    `INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, default_flow_id, created_by)
     VALUES (?, 'item', NULL, '(pending)', 'CUTPL', ?, 'draft', ?, ?)`,
    [c.companyId, classificationId, flowId ?? null, c.userId],
  );
  const id = r.insertId;
  // Counted, not identified: the blank is a quantity of identical rectangles
  // cut as one batch, and it is always made on its order, never stocked.
  await db.query(
    `INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, source_definition_id, owner_order_line_id)
     VALUES (?, ?, 'temporary', 'quantity', 'nos', 'make', NULL, ?)`,
    [id, c.companyId, place.ownerLineId],
  );
  // Placed before it is valued and named, so a coding rule built on the parent's
  // code or the position has something to read — exactly as createItem places it.
  await place.insert(id);

  try {
    await setValues(db, c, 'master', id, [
      { specCode: 'THICKNESS', value: size.thickness },
      { specCode: 'LENGTH', value: size.length },
      { specCode: 'WIDTH', value: size.width },
      { specCode: 'GRADE', value: size.gradeId ?? size.gradeText },
    ]);
  } catch (err) {
    if (err.code !== 'INVALID_VALUES') throw err;
    throw invalid('CUT_PLATE_SPECS', 'A cut plate cannot be given its size where cut plates are filed — the four specifications have to be set there, the way they are for bought plates.', { problems: err.problems ?? [] });
  }

  await inheritRemainingSteel(db, c, id, place.partId ?? null, extras);

  const fallbackName = `Cut plate ${fmt(size.thickness)} × ${fmt(size.width)} × ${fmt(size.length)}${size.gradeText ? ` ${size.gradeText}` : ''}`;
  const named = await generate(db, c.companyId, 'item', 'name', { entityId: id }, { consume: true }).catch(() => null);
  await db.query('UPDATE cf_master_records SET name = ? WHERE company_id = ? AND id = ?', [named?.text || fallbackName, c.companyId, id]);
  try {
    const coded = await generate(db, c.companyId, 'item', 'code', { entityId: id }, { consume: true });
    if (coded?.text) await db.query('UPDATE cf_master_records SET code = ? WHERE company_id = ? AND id = ?', [coded.text, c.companyId, id]);
  } catch (err) {
    // A draft may stand without a code until a rule applies (decision Q21).
    if (err.code !== 'TOKEN_MISSING') throw err;
  }
  const [[row]] = await db.query('SELECT id, code, name, status, classification_id FROM cf_master_records WHERE id = ?', [id]);
  return { ...row, size };
}

// --- BOM lines -----------------------------------------------------------------

/** The parent's BOM, created if it has none, and locked so two callers cannot take one position. */
async function bomFor(db, c, parentId) {
  const bom = await bomOfParent(db, c.companyId, parentId) ?? await createBom(db, c, { parentId, bomType: 'custom' });
  await db.query('SELECT id FROM cf_boms WHERE id = ? FOR UPDATE', [bom.id]);
  return bom;
}

async function addChild(db, c, parentId, { childId, designId, selectionDefinitionId = null, quantity, role = null }) {
  const bom = await bomFor(db, c, parentId);
  return insertLine(db, c, {
    bomId: bom.id,
    lineNo: await nextLineNo(db, c.companyId, bom.id),
    childId,
    designId,
    position: await nextPosition(db, c.companyId, bom.id, designId),
    quantity,
    role,
    selectionDefinitionId,
  });
}

const dropLine = (db, c, lineId) => db.query('UPDATE cf_bom_lines SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, lineId]);

// --- how much raw plate one blank takes ----------------------------------------

/**
 * The area fraction. Returns what to write on the cut plate's plate line, and
 * says in words what the number rests on, because "1" and "0.104" mean very
 * different things and nobody should have to guess which they are looking at.
 */
function plateQuantity(size, plate) {
  const blankArea = size.length * size.width;
  if (!plate) {
    return { quantity: 1, basis: 'unresolved', note: 'No raw plate is chosen yet, so there is no plate area to divide by — this is a placeholder of one plate per blank, not an answer. Choose the plate on the cut plate\'s BOM line.' };
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

/** The plate a resolved selection line holds, with its size — or null while nothing is chosen. */
async function chosenPlate(db, companyId, childId) {
  const [[m]] = await db.query(
    `SELECT m.id, m.code, m.name FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL`,
    [companyId, childId],
  );
  if (!m) return null;
  const values = await specValuesOf(db, companyId, [m.id]);
  return { ...m, size: sizeOf(values.get(m.id) ?? new Map()) };
}

/**
 * The cut plate's own BOM: exactly one line, the plate selection, at the area
 * fraction. Creates it, or moves the quantity when the parts or the chosen
 * plate changed. Never a second line, however often this runs.
 */
async function reconcilePlateLine(db, c, cutPlate, size, selection) {
  const bom = await bomOfParent(db, c.companyId, cutPlate.id);
  const lines = bom ? await linesOfBom(db, c.companyId, bom.id) : [];
  const own = lines.filter((l) => l.selection_definition_id === selection.id || l.design_id === selection.id);
  const extra = lines.filter((l) => !own.includes(l));
  // Anything else somebody put under a cut plate is left alone and reported:
  // this service owns the plate line, not the whole BOM.
  const keep = own[0] ?? null;
  for (const dup of own.slice(1)) await dropLine(db, c, dup.id);

  if (!keep) {
    const pick = await defaultCandidate(db, c.companyId, selection.id);
    const picked = pick ? await chosenPlate(db, c.companyId, pick.id) : null;
    const q = plateQuantity(size, picked);
    await addChild(db, c, cutPlate.id, {
      childId: picked?.id ?? selection.id, designId: selection.id, selectionDefinitionId: selection.id, quantity: q.quantity, role: 'Raw plate',
    });
    return { ...q, plate: picked ? { id: picked.id, code: picked.code, name: picked.name } : null, changed: true, otherLines: extra.length };
  }
  // Still nothing chosen: if the selection has since gained a default, the line
  // takes it, exactly as a line created now would. A plate a PERSON chose is
  // never second-guessed — this only fills a blank in.
  let chosenId = keep.child_record_kind === 'item' ? keep.child_id : null;
  let filled = false;
  if (chosenId == null) {
    const pick = await defaultCandidate(db, c.companyId, selection.id);
    if (pick) {
      await db.query('UPDATE cf_bom_lines SET child_id = ? WHERE company_id = ? AND id = ?', [pick.id, c.companyId, keep.id]);
      chosenId = pick.id;
      filled = true;
    }
  }
  const plate = chosenId ? await chosenPlate(db, c.companyId, chosenId) : null;
  const q = plateQuantity(size, plate);
  const changed = filled || Math.abs(Number(keep.quantity) - q.quantity) > 1e-9;
  if (changed) await db.query('UPDATE cf_bom_lines SET quantity = ? WHERE company_id = ? AND id = ?', [q.quantity, c.companyId, keep.id]);
  return { ...q, plate: plate ? { id: plate.id, code: plate.code, name: plate.name } : null, changed, otherLines: extra.length };
}

// --- the two entry points ------------------------------------------------------

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
  note: plateLine.note,
  otherLines: plateLine.otherLines,
});

/**
 * Works out the cut plates a line's parts are cut from, and makes the structure
 * say so. Re-runnable: what is right is left alone, what changed is moved, and
 * a cut plate nothing is cut from any more is deleted.
 *
 * input: { flowId? } — how a cut plate is made, put on the ones it creates, so
 * a derived blank is not a node release has to refuse for having no flow.
 */
export async function deriveCutPlates(db, c, orderLineId, input = {}) {
  const line = await requireLine(db, c.companyId, orderLineId, { lock: true });
  assertOpen(line);
  if (!line.item_id) throw invalid('NO_ITEM', `Line ${line.line_no} of ${line.order_code} has no item yet.`);

  const problems = [];
  const flowId = blank(input.flowId) ? null : await requireUsableFlow(db, c.companyId, input.flowId, problems);
  if (problems.length) throw invalid('INVALID', 'The flow could not be used.', { problems });

  const places = {
    parts: await partsNode(db, c.companyId),
    cutPlate: await nodeByCode(db, c.companyId, CUT_PLATE_CODE),
  };
  if (!places.cutPlate) throw invalid('NO_CUT_PLATE_CLASS', `There is no ${CUT_PLATE_CODE} variant under Steel › Plates — a cut plate has nowhere to be filed.`);
  // Once per run: every blank here is filed at the same node, so ask it what it
  // needs beyond the four sizes a single time rather than per blank.
  const blankExtras = await extrasRequiredAt(db, c.companyId, places.cutPlate.id);
  const selection = await plateSelection(db, c.companyId);

  const { parts, cutPlates, links } = await survey(db, c.companyId, line, places);
  const groups = group(parts);
  const byId = new Map(cutPlates.map((cp) => [cp.id, cp]));
  const created = [];
  const updated = [];
  const removed = [];
  const out = [];

  // 1. A part whose size no longer matches the blank it points at lets go of it.
  //    Doing this first frees a blank that nothing needs any more, so step 3 can
  //    see it, and lets a part join the right group in step 2.
  const liveLinks = [];
  for (const l of links) {
    const part = parts.find((p) => p.id === l.part_id);
    const cp = byId.get(l.cut_plate_id);
    if (part && cp && keyOf(part.size) === keyOf(cp.size)) liveLinks.push(l);
    else await dropLine(db, c, l.line_id);
  }

  // 2. One cut plate per group: the one its parts already point at, or a new one.
  const touched = new Set();
  const usedCutPlates = new Set();
  for (const g of groups) {
    const held = liveLinks.filter((l) => g.parts.some((p) => p.id === l.part_id));
    let cp = held.map((l) => byId.get(l.cut_plate_id)).find((x) => x && !usedCutPlates.has(x.id)) ?? null;
    let attachTo = g.parts;
    if (cp) {
      usedCutPlates.add(cp.id);
      const has = new Set(held.filter((l) => l.cut_plate_id === cp.id).map((l) => l.part_id));
      // A group that somehow split across two blanks is pulled back onto one.
      for (const l of held) if (l.cut_plate_id !== cp.id) { await dropLine(db, c, l.line_id); has.delete(l.part_id); }
      attachTo = g.parts.filter((p) => !has.has(p.id));
    } else {
      const first = g.parts[0];
      cp = await createCutPlate(db, c, {
        size: g.size,
        classificationId: places.cutPlate.id,
        flowId,
        extras: blankExtras,
        place: {
          ownerLineId: line.id,
          // Any part of the pool can say what steel this is — they are pooled
          // BECAUSE they share thickness, length, width and grade — so the
          // first one is the blank's source for anything else its own
          // classification requires.
          partId: first.id,
          // One blank per piece of that part: the part's own quantity already
          // says how many pieces there are, so this line never multiplies.
          insert: (id) => addChild(db, c, first.id, { childId: id, designId: id, quantity: 1, role: 'Cut from' }),
        },
      });
      byId.set(cp.id, cp);
      usedCutPlates.add(cp.id);
      created.push(cp.id);
      attachTo = g.parts.slice(1);
    }
    // A blank legitimately has several parents — that is the whole point of
    // pooling — so the identity rule that stops a line changing what it holds
    // does not apply here. Only the loop rule does: a part may never end up
    // inside its own blank.
    if (attachTo.length) {
      const below = await descendantIds(db, c.companyId, cp.id);
      const caught = attachTo.find((p) => below.has(p.id));
      if (caught) throw invalid('LOOP', `${nameOf(cp)} already contains ${nameOf(caught)} further down — it cannot also be cut from it.`);
    }
    for (const p of attachTo) {
      await addChild(db, c, p.id, { childId: cp.id, designId: cp.id, quantity: 1, role: 'Cut from' });
      touched.add(p.id);
    }
    const plateLine = await reconcilePlateLine(db, c, cp, g.size, selection);
    if (plateLine.changed && !created.includes(cp.id)) updated.push(cp.id);
    for (const p of g.parts) touched.add(p.id);
    out.push(describe(cp, g.size, g.parts, plateLine));
  }

  // 3. A blank nothing is cut from any more goes, with everything below it — the
  //    same as taking its line off a custom BOM, which deletes the temporary item
  //    it held. It exists only for the parts that shared it.
  for (const cp of cutPlates) {
    if (usedCutPlates.has(cp.id)) continue;
    const [[{ n }]] = await db.query(
      'SELECT COUNT(*) AS n FROM cf_bom_lines WHERE company_id = ? AND child_id = ? AND deleted_at IS NULL',
      [c.companyId, cp.id],
    );
    if (Number(n)) continue;                       // something else still points at it
    const [[{ moves }]] = await db.query(
      'SELECT COUNT(*) AS moves FROM cf_stock_ledger WHERE company_id = ? AND item_id = ?',
      [c.companyId, cp.id],
    );
    if (Number(moves)) continue;                   // it has stock history: it is a real thing now
    await deleteTemporaryTree(db, c, cp.id);
    removed.push({ id: cp.id, code: cp.code, name: cp.name });
  }

  // New blanks before the parts above them, so roll-ups read them in order.
  await refreshValues(db, c, [...new Set([...usedCutPlates, ...touched])]);
  return {
    ...shape(line, selection, out),
    created: created.length,
    updated: updated.length,
    removed,
    unchanged: out.length - created.length - updated.length,
  };
}

/** The cut plates a line already has, exactly as they stand. Writes nothing. */
export async function getCutPlates(db, companyId, orderLineId) {
  const line = await requireLine(db, companyId, orderLineId);
  if (!line.item_id) throw invalid('NO_ITEM', `Line ${line.line_no} of ${line.order_code} has no item yet.`);
  const places = {
    parts: await partsNode(db, companyId),
    cutPlate: await nodeByCode(db, companyId, CUT_PLATE_CODE),
  };
  if (!places.cutPlate) throw invalid('NO_CUT_PLATE_CLASS', `There is no ${CUT_PLATE_CODE} variant under Steel › Plates — a cut plate has nowhere to be filed.`);
  const selection = await plateSelection(db, companyId);
  const { parts, cutPlates, links } = await survey(db, companyId, line, places);

  const out = [];
  for (const cp of cutPlates) {
    const mine = links.filter((l) => l.cut_plate_id === cp.id).map((l) => parts.find((p) => p.id === l.part_id)).filter(Boolean);
    const bom = await bomOfParent(db, companyId, cp.id);
    const own = (bom ? await linesOfBom(db, companyId, bom.id) : []).filter((l) => l.selection_definition_id === selection.id || l.design_id === selection.id);
    const keep = own[0] ?? null;
    const plate = keep && keep.child_record_kind === 'item' ? await chosenPlate(db, companyId, keep.child_id) : null;
    const fresh = plateQuantity(cp.size, plate);
    const stored = keep ? round6(Number(keep.quantity)) : null;
    const stale = stored != null && Math.abs(stored - fresh.quantity) > 1e-9;
    out.push(describe(cp, cp.size, mine, {
      ...fresh,
      quantity: stored,
      note: stale ? `${fresh.note ? `${fresh.note} ` : ''}What is written here is ${fmt(stored)}; the area fraction now works out at ${fmt(fresh.quantity)} — work the cut plates out again to bring it up to date.` : fresh.note,
      plate: plate ? { id: plate.id, code: plate.code, name: plate.name } : null,
      otherLines: 0,
    }));
  }
  const pooled = new Set(links.map((l) => l.part_id));
  return {
    ...shape(line, selection, out),
    partsWithoutBlank: parts.filter((p) => !pooled.has(p.id)).map((p) => ({ id: p.id, code: p.code, name: p.name, missing: missingOf(p.size) })),
  };
}
