/**
 * masterRecordService.js — items and definitions: create, change, activate,
 * revise, delete, list, and preview a draft.
 *
 * One record = one master row + one detail row, always written together (the
 * route wraps every call in a transaction). The rules the database cannot hold:
 *   - catalog items and definitions sit on a Variant; a temporary item sits
 *     where its template definition sits (Q20) and belongs to one sales order
 *     line (Q3 — the sales order is the project);
 *   - a code is set by a person or by the code generator, and is fixed once the
 *     record is active — documents may already carry it;
 *   - activation requires a code and every required item-level value;
 *   - status moves draft -> active <-> obsolete, never back to draft;
 *   - a revision is a label on the same row (Q2): the id never changes.
 */
import { invalid, conflict, assertNoProblems } from '../lib/errors.js';
import { ancestors, levelName, loadNode, subtreeIds } from './tree.js';
import { loadMaster, requireMaster, kindOf, frozenBy, assertNotFrozen, flowStillOpen } from './records.js';
import { requireLeaf } from './classificationService.js';
import { resolve, publicResolution, TRACK_DEPTH } from './resolutionService.js';
import { setValues, materialize, rematerialize, deleteAllForSubject as deleteValues } from './valueService.js';
import { deleteAllForSubject as deleteRules } from './assignmentService.js';
import { generate, findConditionsReferencing } from '../modules/codegen/index.js';
import { draftMaster, draftValueMap } from './drafts.js';
import { bomOfParent, deleteBomOf, placementOf } from './bomGraph.js';
import { nextRevision } from '../lib/revision.js';
import { wantsPage, pageArgs, orderBy, likeOf, pageOf } from '../lib/listing.js';
import { requireUsableFlow } from './flowService.js';
import { readPrice, readBasis, readCurrency } from './priceService.js';
import { readItemTax } from './taxService.js';
import { writeEntries, addEntry, entryCount, deleteSelectionRules } from './selectionService.js';
import { cutFromDetailOf, cutStockOf, sectionSteelOf, CUT_FROM_CODE, CUT_FROM_VALUES } from '../lib/cutFrom.js';
import { cutPlaces } from '../lib/cutPlaces.js';

/**
 * CUT FROM on a record's page (CF_ERP_CUT_FROM_PLAN §11.2):
 *   cutFrom  { value: PLATE|SECTION|NONE|null, source: own|definition|classification|null, from }
 *   cutStock { own: Ref|null, effective: (Ref & { steel })|null, from: own|definition|null }
 * Five queries; none of them per anything.
 */
async function cutOfRecord(db, companyId, m) {
  const [detail, stock] = await Promise.all([
    cutFromDetailOf(db, companyId, [m.id]),
    cutStockOf(db, companyId, [m.id]),
  ]);
  const eff = stock.get(Number(m.id));
  const ids = [m.cut_stock_id, eff?.stockId].filter((x) => x != null);
  const steel = ids.length ? await sectionSteelOf(db, companyId, ids) : new Map();
  const ref = (id) => { const st = steel.get(Number(id)); return st ? { id: st.id, code: st.code, name: st.name } : { id: Number(id), code: null, name: null }; };
  const effective = eff ? (() => {
    const st = steel.get(eff.stockId);
    return {
      ...ref(eff.stockId),
      steel: st ? {
        thickness: st.thickness, width: st.width, depth: st.depth, sectionArea: st.sectionArea, lengthMm: st.lengthMm,
        grade: st.grade, impactClass: st.impactClass, material: st.material, density: st.density,
      } : null,
    };
  })() : null;
  return {
    cutFrom: detail.get(Number(m.id)) ?? { value: null, source: null, from: null },
    cutStock: { own: m.cut_stock_id != null ? ref(m.cut_stock_id) : null, effective, from: eff?.from ?? null },
  };
}

/**
 * A section a part may name: a live catalog item filed under the section stock
 * places of Setup › Cutting. null clears. Returns the id, or pushes a problem.
 */
async function readCutStock(db, companyId, value, problems) {
  if (value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) { problems.push('cutStockId must be a catalog item id, or null to clear it.'); return undefined; }
  const places = await cutPlaces(db, companyId);
  const [[it]] = await db.query(
    `SELECT m.id, m.code, m.name, m.classification_id, i.item_type FROM cf_master_records m
       LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!it) { problems.push(`Item ${id} does not exist.`); return undefined; }
  if (it.item_type !== 'catalog' || !places.section.stockIds.has(Number(it.classification_id))) {
    problems.push(`${it.code ?? it.name} is not a section in stock — a part is cut from a catalog bar filed under the section stock of Setup › Cutting (angles, beams, channels …).`);
    return undefined;
  }
  return id;
}

const TEMP_TAX_MESSAGE = 'A row of an order\'s structure takes its HSN code and GST rate from its template — set them there.';
const SELECTION_TAX_MESSAGE = 'A selection takes its HSN code and GST rate from the catalog item it picks — set them on the item.';
const setsTax = (tax) => Object.values(tax).some((v) => v != null && v !== 0);

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const SHORT_NAME_RE = /^[A-Za-z0-9_\-./]+$/;
const TRACKING = ['quantity', 'batch', 'individual'];
const SOURCING = ['stock', 'make', 'both'];
const SELECTION_MODES = ['allowed_list', 'spec_match', 'both'];
const TRANSITIONS = { draft: ['active'], active: ['obsolete'], obsolete: ['active'] };

const blank = (v) => v == null || String(v).trim() === '';

/**
 * The few characters that stand for the thing ("WEB", "FLG") — the code
 * generator builds stock and WIP codes from it, so it is kept in one case and
 * free of anything that would not survive being pasted into a code.
 *
 * Three states, on purpose. A value prints. NULL is "not set yet": codes fall
 * back to the template's short name, then to the first word of the name. An
 * EMPTY string is "none" — set deliberately (`noShortName: true`), it prints
 * nothing and stops the fallback: a girder segment reads …-G1-1 under the one
 * part rule, with no rule of its own (user, 2026-09-26). A blank field on a
 * form means "not set", never "none" — that takes the explicit flag.
 */
function readShortName(raw, problems) {
  if (blank(raw)) return null;
  const shortName = String(raw).trim().toUpperCase();
  if (!SHORT_NAME_RE.test(shortName) || shortName.length > 30) problems.push('Short name: up to 30 letters, digits and - _ . /, no spaces.');
  return shortName;
}

function readBase(input, problems) {
  const code = blank(input.code) ? null : String(input.code).trim();
  if (code && (!CODE_RE.test(code) || code.length > 100)) problems.push('Code: up to 100 letters, digits and - _ . /, no spaces.');
  const name = blank(input.name) ? null : String(input.name).trim();
  if (name && name.length > 255) problems.push('Name is up to 255 characters.');
  const shortName = input.noShortName === true ? '' : readShortName(input.shortName, problems);
  const revision = blank(input.revision) ? null : String(input.revision).trim();
  if (revision && revision.length > 20) problems.push('Revision is up to 20 characters.');
  if (input.status && !['draft', 'active'].includes(input.status)) problems.push('A new record starts as draft or active.');
  return { code, name, shortName, revision, description: blank(input.description) ? null : String(input.description), status: input.status ?? 'draft' };
}

/**
 * A selection's "picks from" on create / update (init.sql §42). The entries are
 * the rule now: `scope` = [{ nodeId } | { itemId, isDefault? }]. selectionMode is
 * accepted from older screens and otherwise ignored — it is derived from the
 * entries (selectionService.syncLegacy). An older screen's candidateClassificationId
 * becomes a branch entry unless its mode said the node was not used.
 */
async function readSelection(db, companyId, definitionType, input, problems, existing = null) {
  if (definitionType !== 'selection') {
    if (input.selectionMode || input.candidateClassificationId || (Array.isArray(input.scope) && input.scope.length)) problems.push('Only selection definitions pick from branches and items.');
    return { selectionMode: null, candidateClassificationId: null, scope: [] };
  }
  if (input.scope !== undefined && !Array.isArray(input.scope)) problems.push('What it picks from is a list of branches and items.');
  const selectionMode = input.selectionMode ?? existing?.selection_mode ?? 'allowed_list';
  if (!SELECTION_MODES.includes(selectionMode)) problems.push('Selection mode is allowed_list, spec_match or both.');
  const raw = input.candidateClassificationId !== undefined ? input.candidateClassificationId : existing?.candidate_classification_id ?? null;
  const candidateClassificationId = blank(raw) ? null : Number(raw);
  if (candidateClassificationId != null) {
    const area = await loadNode(db, companyId, candidateClassificationId);
    if (!area) problems.push('The search area does not exist.');
    else if (area.scope === 'machine') problems.push('The search area is a machine family — a selection searches catalog items.');
  }
  const scope = Array.isArray(input.scope) ? [...input.scope] : [];
  if (candidateClassificationId != null && selectionMode !== 'allowed_list' && !scope.some((e) => Number(e?.nodeId) === candidateClassificationId)) {
    scope.unshift({ nodeId: candidateClassificationId });
  }
  return { selectionMode, candidateClassificationId, scope };
}

/**
 * Values, derived values, name and code — the second half of creating any record.
 * A draft may be left without a code when its coding rule needs values that are
 * not entered yet; activating it generates the code then.
 */
async function finishCreate(db, c, id, entityType, base, input, opts = {}) {
  const warnings = [];
  if (Array.isArray(input.values) && input.values.length) await setValues(db, c, 'master', id, input.values);
  else if (entityType === 'item') await materialize(db, c, id);

  if (!base.name) {
    const g = await generate(db, c.companyId, entityType, 'name', { entityId: id }, { consume: true });
    const name = g?.text ?? opts.fallbackName ?? null;
    if (!name) throw invalid('NAME_REQUIRED', `Give the ${entityType} a name — no naming rule applies to it.`);
    await db.query('UPDATE cf_master_records SET name = ? WHERE id = ?', [name, id]);
  }
  if (!base.code) {
    try {
      const g = await generate(db, c.companyId, entityType, 'code', { entityId: id }, { consume: true });
      if (g?.text) await db.query('UPDATE cf_master_records SET code = ? WHERE id = ?', [g.text, id]);
      else if (base.status === 'draft') warnings.push('No coding rule applies yet; the code stays empty until one does, or is typed in.');
    } catch (e) {
      if (e.code !== 'TOKEN_MISSING' || base.status !== 'draft') throw e;
      warnings.push(`${e.message} The code will be generated on activation.`);
    }
  }
  if (base.status === 'active') await setStatus(db, c, id, 'active');
  return { ...(await getRecord(db, c.companyId, id)), warnings };
}

/**
 * Creates a catalog item — or, when the instantiation service calls it with
 * `opts.place`, a temporary item. `place(id)` runs after the rows exist and
 * before the name and code are generated, so the item already sits in its BOM
 * (codes are built from the parent and the position) and its owner line is set.
 * Temporary items have no other way in: they are born from a template line.
 */
export async function createItem(db, c, input = {}, opts = {}) {
  const problems = [];
  if (input.itemType && !['catalog', 'temporary'].includes(input.itemType)) problems.push('An item is catalog or temporary.');
  const itemType = input.itemType === 'temporary' ? 'temporary' : 'catalog';
  let classificationId = null;
  let sourceDefinitionId = null;
  let ownerOrderLineId = null;

  if (itemType === 'temporary' && !opts.place) {
    throw invalid('ORDER_ONLY', 'Temporary items are created from a sales order: choose a template definition on an order line, or add one to a custom BOM.');
  }
  if (itemType === 'temporary') {
    const def = blank(input.sourceDefinitionId) ? null : await loadMaster(db, c.companyId, Number(input.sourceDefinitionId));
    if (!def || def.record_kind !== 'definition' || def.definition_type !== 'template') problems.push('A temporary item is created from a template definition.');
    else if (def.status === 'obsolete') problems.push(`${def.code ?? def.name} is obsolete.`);
    else { sourceDefinitionId = def.id; classificationId = def.classification_id; }
    ownerOrderLineId = Number(input.ownerOrderLineId);
    if (!Number.isInteger(ownerOrderLineId) || ownerOrderLineId <= 0) problems.push('A temporary item belongs to a sales order line.');
  } else {
    if (!blank(input.sourceDefinitionId) || !blank(input.ownerOrderLineId)) problems.push('Only temporary items have a source definition and an owner order line.');
    try { classificationId = (await requireLeaf(db, c.companyId, input.classificationId)).id; } catch (e) { problems.push(e.message); }
  }
  const trackedBy = input.trackedBy ?? (itemType === 'temporary' ? 'individual' : 'quantity');
  if (!TRACKING.includes(trackedBy)) problems.push('Tracked by quantity, batch or individual.');
  // Where a catalog item comes from when an order asks for one. A temporary item
  // exists only to be made, so it is never stocked.
  const sourcing = itemType === 'temporary' ? 'make' : (blank(input.sourcing) ? 'stock' : String(input.sourcing));
  if (!SOURCING.includes(sourcing)) problems.push('Comes from stock, made on the order, or either.');
  const uom = blank(input.uom) ? 'nos' : String(input.uom).trim();
  if (uom.length > 20) problems.push('Unit of measure is up to 20 characters.');
  // A catalog item may be given its list price as it is created (init.sql §36).
  const listPrice = readPrice(input.listPrice, 'List price', problems);
  const priceBasis = readBasis(input.priceBasis, 'Price basis', problems) ?? 'unit';
  readCurrency(input.currency, problems);
  if (itemType === 'temporary' && listPrice != null) problems.push('A row of an order\'s structure has no list price — price it on its order line.');
  // HSN / GST rate (init.sql §37). A row of an order takes them from its template.
  const tax = {};
  await readItemTax(db, c.companyId, input, null, tax, problems);
  if (itemType === 'temporary' && setsTax(tax)) problems.push(TEMP_TAX_MESSAGE);
  const base = readBase(input, problems);
  assertNoProblems(problems);

  const [r] = await db.query(
    `INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, description, classification_id, status, revision, created_by)
     VALUES (?, 'item', ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [c.companyId, base.code, base.name ?? '(pending)', base.shortName, base.description, classificationId, base.revision, c.userId],
  );
  await db.query(
    `INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, source_definition_id, owner_order_line_id, list_price, price_basis,
                                  hsn_code, gst_rate, is_service)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.insertId, c.companyId, itemType, trackedBy, uom, sourcing, sourceDefinitionId, ownerOrderLineId, listPrice, priceBasis,
      tax.hsn_code ?? null, tax.gst_rate ?? null, tax.is_service ?? 0],
  );
  if (opts.place) await opts.place(r.insertId);
  return finishCreate(db, c, r.insertId, 'item', base, input, opts);
}

export async function createDefinition(db, c, input = {}) {
  const problems = [];
  if (input.definitionType && !['template', 'selection'].includes(input.definitionType)) problems.push('A definition is a template or a selection.');
  const definitionType = input.definitionType === 'selection' ? 'selection' : 'template';
  let classificationId = null;
  try { classificationId = (await requireLeaf(db, c.companyId, input.classificationId)).id; } catch (e) { problems.push(e.message); }
  const sel = await readSelection(db, c.companyId, definitionType, input, problems);
  const tax = {};
  await readItemTax(db, c.companyId, input, null, tax, problems);
  if (definitionType === 'selection' && setsTax(tax)) problems.push(SELECTION_TAX_MESSAGE);
  const base = readBase(input, problems);
  assertNoProblems(problems);

  const [r] = await db.query(
    `INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, description, classification_id, status, revision, created_by)
     VALUES (?, 'definition', ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [c.companyId, base.code, base.name ?? '(pending)', base.shortName, base.description, classificationId, base.revision, c.userId],
  );
  await db.query(
    `INSERT INTO cf_definition_details (master_id, company_id, definition_type, selection_mode, candidate_classification_id, hsn_code, gst_rate, is_service)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.insertId, c.companyId, definitionType, sel.selectionMode, sel.candidateClassificationId, tax.hsn_code ?? null, tax.gst_rate ?? null, tax.is_service ?? 0],
  );
  // What it picks from — the old columns follow (selectionService.syncLegacy).
  if (definitionType === 'selection') await writeEntries(db, c, r.insertId, sel.scope);
  return finishCreate(db, c, r.insertId, 'definition', base, input);
}

export async function updateRecord(db, c, id, input = {}) {
  const m = await requireMaster(db, c.companyId, id);
  // CUT FROM (§48): how this definition's / item's pieces are cut, and the
  // section a section part is cut from. Like any other detail, refused on a
  // frozen record (a locked line's rows) — assertNotFrozen below.
  let cutFromWrite;
  let cutStockWrite;
  if (input.cutFrom !== undefined || input.cutStockId !== undefined) {
    const isSelection = m.record_kind === 'definition' && m.definition_type === 'selection';
    if (isSelection) throw invalid('INVALID', 'A selection chooses a catalog item — it is not cut, so it has no Cut from.');
    const p = [];
    if (input.cutFrom !== undefined) {
      const v = input.cutFrom == null || input.cutFrom === '' ? null : String(input.cutFrom).trim().toUpperCase();
      if (v != null && !CUT_FROM_VALUES.includes(v)) p.push('cutFrom is PLATE, SECTION or NONE — or null to take it from the definition or classification.');
      else cutFromWrite = { value: v };
    }
    if (input.cutStockId !== undefined) {
      const sid = await readCutStock(db, c.companyId, input.cutStockId, p);
      if (sid !== undefined) cutStockWrite = { id: sid };
    }
    assertNoProblems(p);
  }
  // A locked line still takes a new flow — and nothing else — until it is
  // released (records.flowStillOpen). Any other field in the same save is
  // refused in the locked line's one sentence.
  const flowOnly = input.defaultFlowId !== undefined
    && Object.keys(input).every((k) => k === 'defaultFlowId' || input[k] === undefined);
  if (!(flowOnly && flowStillOpen(frozenBy(m)))) assertNotFrozen(m, flowOnly ? 'flow' : 'details');
  const problems = [];
  const sets = {};
  const detail = {};
  const laterEntries = [];

  if (input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 255) problems.push('Name is required (up to 255 characters).');
    sets.name = name;
  }
  // Unlike the code, this one stays editable at any status: it feeds the codes
  // generated for stock and WIP from now on, not a code already on a document.
  if (input.noShortName === true) sets.short_name = '';
  else if (input.shortName !== undefined || input.noShortName === false) sets.short_name = readShortName(input.shortName, problems);
  if (input.description !== undefined) sets.description = blank(input.description) ? null : String(input.description);
  if (input.defaultFlowId !== undefined) {
    if (m.record_kind === 'definition' && m.definition_type === 'selection') problems.push('A selection chooses a catalog item — it is not made here, so it has no flow.');
    else sets.default_flow_id = blank(input.defaultFlowId) ? null : await requireUsableFlow(db, c.companyId, input.defaultFlowId, problems);
  }
  if (input.code !== undefined) {
    const code = blank(input.code) ? null : String(input.code).trim();
    if (code !== m.code) {
      if (m.status !== 'draft') problems.push('A code is fixed once the record is active — documents may already carry it.');
      else if (code && (!CODE_RE.test(code) || code.length > 100)) problems.push('Code: up to 100 letters, digits and - _ . /, no spaces.');
      sets.code = code;
    }
  }
  let moved = false;
  if (input.classificationId !== undefined && Number(input.classificationId) !== m.classification_id) {
    if (m.record_kind === 'item' && m.item_type === 'temporary') problems.push('A temporary item sits where its definition sits.');
    else {
      try { sets.classification_id = (await requireLeaf(db, c.companyId, input.classificationId)).id; moved = true; } catch (e) { problems.push(e.message); }
    }
  }

  if (m.record_kind === 'item') {
    // Stock is counted in the item's unit and kept at its tracking level; once it has stock history both are fixed.
    const changesStockShape = (input.uom !== undefined && String(input.uom ?? '').trim() !== m.uom)
      || (input.trackedBy !== undefined && input.trackedBy !== m.tracked_by);
    if (changesStockShape) {
      const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_stock_ledger WHERE company_id = ? AND item_id = ?', [c.companyId, id]);
      if (Number(n)) problems.push(`${m.code ?? m.name} has stock history — its unit and how it is tracked can no longer change.`);
    }
    if (input.uom !== undefined) {
      const uom = String(input.uom ?? '').trim();
      if (!uom || uom.length > 20) problems.push('Unit of measure is up to 20 characters.');
      detail.uom = uom;
    }
    if (input.trackedBy !== undefined && input.trackedBy !== m.tracked_by) {
      if (!TRACKING.includes(input.trackedBy)) problems.push('Tracked by quantity, batch or individual.');
      else {
        const [[{ n }]] = await db.query(
          `SELECT COUNT(*) AS n FROM cf_spec_assignments
            WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND deleted_at IS NULL AND is_applicable = 1
              AND FIELD(capture_at, 'item', 'batch', 'individual') - 1 > ?`,
          [c.companyId, id, TRACK_DEPTH[input.trackedBy]],
        );
        if (Number(n)) problems.push(`${n} rule(s) on this item capture deeper than ${input.trackedBy}.`);
        detail.tracked_by = input.trackedBy;
      }
    }
    if (input.sourcing !== undefined && input.sourcing !== m.sourcing) {
      if (!SOURCING.includes(input.sourcing)) problems.push('Comes from stock, made on the order, or either.');
      else if (m.item_type === 'temporary') problems.push('A temporary item is always made on its order.');
      else detail.sourcing = input.sourcing;
    }
    // The list price (init.sql §36): what a catalog item sells for, net of tax. A
    // row of an order's structure is priced on its order line, never here.
    if (input.listPrice !== undefined || input.priceBasis !== undefined || input.currency !== undefined) {
      if (m.item_type === 'temporary') problems.push('A row of an order\'s structure has no list price — price it on its order line.');
      else {
        if (input.listPrice !== undefined) detail.list_price = readPrice(input.listPrice, 'List price', problems);
        if (input.priceBasis !== undefined) detail.price_basis = readBasis(input.priceBasis, 'Price basis', problems) ?? 'unit';
        readCurrency(input.currency, problems);
      }
    }
    if (input.itemType !== undefined && input.itemType !== m.item_type) problems.push('An item stays catalog or temporary.');
    if (input.sourceDefinitionId !== undefined && Number(input.sourceDefinitionId) !== m.source_definition_id) problems.push('The source definition is set when a temporary item is created.');
    if (input.ownerOrderLineId !== undefined && Number(input.ownerOrderLineId) !== m.owner_order_line_id) problems.push('The owner order line is set when a temporary item is created.');
  } else {
    if (input.definitionType !== undefined && input.definitionType !== m.definition_type) problems.push('A definition stays a template or a selection.');
    // The mode is derived now; an older screen's search area becomes a branch entry (after the checks below).
    if (input.selectionMode !== undefined || input.candidateClassificationId !== undefined) {
      const sel = await readSelection(db, c.companyId, m.definition_type, input, problems, m);
      if (m.definition_type === 'selection' && input.candidateClassificationId != null && input.candidateClassificationId !== '') {
        laterEntries.push(...sel.scope.filter((e) => e.nodeId != null));
      }
    }
  }
  // HSN / GST rate (init.sql §37): catalog items and template definitions. A row
  // of an order takes them from its template; a selection from the item it picks.
  if (input.hsnCode !== undefined || input.gstRate !== undefined || input.isService !== undefined) {
    if (m.record_kind === 'item' && m.item_type === 'temporary') problems.push(TEMP_TAX_MESSAGE);
    else if (m.record_kind === 'definition' && m.definition_type === 'selection') problems.push(SELECTION_TAX_MESSAGE);
    else await readItemTax(db, c.companyId, input, m, detail, problems);
  }
  assertNoProblems(problems);

  if (cutStockWrite) sets.cut_stock_id = cutStockWrite.id;
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_master_records SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, id]);
  }
  // Cut from is a specification value: written through the value path, with
  // its history (null removes the record's own answer, so it inherits again).
  if (cutFromWrite) await setValues(db, c, 'master', id, [{ specCode: CUT_FROM_CODE, value: cutFromWrite.value }]);
  if (Object.keys(detail).length) {
    const table = m.record_kind === 'item' ? 'cf_item_details' : 'cf_definition_details';
    await db.query(`UPDATE ${table} SET ${Object.keys(detail).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND master_id = ?`,
      [...Object.values(detail), c.companyId, id]);
  }
  for (const e of laterEntries) {
    try { await addEntry(db, c, id, e); } catch (err) { if (err.code !== 'DUPLICATE_ENTRY') throw err; }
  }
  if (moved && m.record_kind === 'definition' && m.definition_type === 'template') {
    // Its temporary items follow it (Q20), and inherit from the new place.
    await db.query(
      `UPDATE cf_master_records mr JOIN cf_item_details i ON i.master_id = mr.id AND i.deleted_at IS NULL
          SET mr.classification_id = ?
        WHERE i.company_id = ? AND i.source_definition_id = ? AND mr.deleted_at IS NULL`,
      [sets.classification_id, c.companyId, id],
    );
    await rematerialize(db, c, { definitionId: id });
  } else if ((moved || detail.tracked_by) && m.record_kind === 'item') {
    await materialize(db, c, id);
  }
  return getRecord(db, c.companyId, id);
}

export async function setStatus(db, c, id, status) {
  const m = await requireMaster(db, c.companyId, id);
  assertNotFrozen(m, 'status');
  // A row of an order's structure (a temporary item, cut plates included) has no
  // life of its own: it is a design with no code until its line is LOCKED, and
  // locking is what activates it (lockService) — user, 2026-09-26.
  if (m.record_kind === 'item' && m.item_type === 'temporary') {
    throw invalid('ROW_STATUS', `${m.name ?? 'This row'} is part of an order's structure — it becomes active when its line is locked.`);
  }
  if (m.status === status) return getRecord(db, c.companyId, id);
  if (!(TRANSITIONS[m.status] ?? []).includes(status)) {
    const article = /^[aeiou]/.test(m.status) ? 'An' : 'A';
    throw invalid('BAD_TRANSITION', `${article} ${m.status} record cannot become ${status}.`);
  }
  if (status === 'active') {
    const problems = [];
    let { code } = m;
    if (!code) {
      const g = await generate(db, c.companyId, m.record_kind, 'code', { entityId: id }, { consume: true });
      if (g?.text) {
        code = g.text;
        await db.query('UPDATE cf_master_records SET code = ? WHERE id = ?', [code, id]);
      } else {
        problems.push('It needs a code — type one in, or add a coding rule that applies.');
      }
    }
    if (m.record_kind === 'item') {
      const r = await resolve(db, c.companyId, { master: m });
      for (const s of r.missingRequired) problems.push(`${s.code} (${s.name}) is required.`);
      problems.push(...r.problems);
    } else if (m.definition_type === 'selection') {
      // At least one branch or item to pick from (init.sql §42); spec filters are optional.
      if (!(await entryCount(db, c.companyId, id))) problems.push('It picks from nothing yet — add a branch of the classification or a catalog item.');
    }
    if (problems.length) throw invalid('INCOMPLETE', `${code ?? m.name} cannot be activated yet.`, { problems });
  }
  await db.query('UPDATE cf_master_records SET status = ? WHERE company_id = ? AND id = ?', [status, c.companyId, id]);
  return getRecord(db, c.companyId, id);
}

export { nextRevision };

/** Moves the revision label on (Q2: same row, same id — documents keep the label they used). */
export async function reviseRecord(db, c, id, input = {}) {
  const m = await requireMaster(db, c.companyId, id);
  assertNotFrozen(m, 'revision');
  if (m.status === 'obsolete') throw invalid('OBSOLETE', 'Reactivate the record before revising it.');
  const label = blank(input.revision) ? nextRevision(m.revision) : String(input.revision).trim();
  if (label.length > 20) throw invalid('INVALID', 'Revision is up to 20 characters.');
  if (label === m.revision) throw invalid('SAME_REVISION', `It is already at revision ${label}.`);
  await db.query('UPDATE cf_master_records SET revision = ? WHERE company_id = ? AND id = ?', [label, c.companyId, id]);
  return getRecord(db, c.companyId, id);
}

/** BOMs and sales order lines that name a record — a record in use cannot be deleted. */
async function usesInStructures(db, companyId, id) {
  const reasons = [];
  const [boms] = await db.query(
    `SELECT DISTINCT p.code, p.name FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
       JOIN cf_master_records p ON p.id = b.parent_id AND p.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND (l.child_id = ? OR l.design_id = ? OR l.selection_definition_id = ?)
      LIMIT 6`,
    [companyId, id, id, id],
  );
  if (boms.length) reasons.push(`it is in the BOM of ${boms.map((r) => r.code ?? r.name).join(', ')}`);
  const [orders] = await db.query(
    `SELECT DISTINCT o.code FROM cf_sales_order_lines ol
       JOIN cf_sales_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
      WHERE ol.company_id = ? AND ol.deleted_at IS NULL AND (ol.item_id = ? OR ol.design_id = ?)
      LIMIT 6`,
    [companyId, id, id],
  );
  if (orders.length) reasons.push(`it is on sales order ${orders.map((r) => r.code).join(', ')}`);
  return reasons;
}

export async function deleteRecord(db, c, id) {
  const m = await requireMaster(db, c.companyId, id);
  if (m.record_kind === 'item' && m.item_type === 'temporary') {
    throw conflict('ORDER_OWNED', `${m.code ?? m.name} belongs to a sales order — remove it from the order's structure instead.`);
  }
  const reasons = await usesInStructures(db, c.companyId, id);
  if (m.record_kind === 'definition') {
    const [[{ n }]] = await db.query(
      `SELECT COUNT(*) AS n FROM cf_item_details i JOIN cf_master_records mr ON mr.id = i.master_id AND mr.deleted_at IS NULL
        WHERE i.company_id = ? AND i.source_definition_id = ? AND i.deleted_at IS NULL`,
      [c.companyId, id],
    );
    if (Number(n)) reasons.push(`${n} temporary item(s) were created from it`);
    const rules = await findConditionsReferencing(db, c.companyId, 'definition', id);
    if (rules.length) reasons.push(`coding rule(s) ${rules.map((r) => r.code).join(', ')} test it`);
  } else {
    const [rows] = await db.query(
      `SELECT DISTINCT dm.code, dm.name FROM cf_selection_scope a
         JOIN cf_master_records dm ON dm.id = a.definition_id AND dm.deleted_at IS NULL
        WHERE a.company_id = ? AND a.item_id = ?`,
      [c.companyId, id],
    );
    if (rows.length) reasons.push(`${rows.map((r) => r.code ?? r.name).join(', ')} pick${rows.length === 1 ? 's' : ''} from it`);
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_stock_ledger WHERE company_id = ? AND item_id = ?', [c.companyId, id]);
    if (Number(n)) reasons.push('it has stock history — mark it obsolete instead');
  }
  if (reasons.length) {
    throw conflict('IN_USE', `${m.code ?? m.name} cannot be deleted: ${reasons.join('; ')}.`, { problems: reasons });
  }
  if (m.record_kind === 'definition') {
    await deleteSelectionRules(db, c, id);
  }
  await deleteBomOf(db, c, id);
  await deleteValues(db, c, 'master', id);
  await deleteRules(db, c, 'master', id);
  const table = m.record_kind === 'item' ? 'cf_item_details' : 'cf_definition_details';
  await db.query(`UPDATE ${table} SET deleted_at = NOW() WHERE company_id = ? AND master_id = ?`, [c.companyId, id]);
  await db.query('UPDATE cf_master_records SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

function shapeRecord(m) {
  // GST (init.sql §37): HSN/SAC, rate and service flag — on catalog items and
  // template definitions. Top level AND inside item / definition, same values.
  const tax = {
    hsnCode: m.hsn_code ?? null,
    gstRate: m.gst_rate == null ? null : Number(m.gst_rate),
    isService: !!Number(m.is_service ?? 0),
  };
  return {
    ...tax,
    id: m.id,
    recordKind: m.record_kind,
    kind: kindOf(m),
    code: m.code,
    name: m.name,
    shortName: m.short_name ?? null,
    /** The short name was set to none: codes print nothing where it goes (shortName is ''). */
    noShortName: m.short_name === '',
    description: m.description,
    classificationId: m.classification_id,
    status: m.status,
    revision: m.revision,
    defaultFlowId: m.default_flow_id ?? null,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    item: m.record_kind === 'item'
      ? {
        itemType: m.item_type, trackedBy: m.tracked_by, uom: m.uom, sourcing: m.sourcing, sourceDefinitionId: m.source_definition_id, ownerOrderLineId: m.owner_order_line_id,
        // What it sells for, net of tax (init.sql §36). Per price_basis: unit, kg, tonne or metre.
        listPrice: m.list_price == null ? null : Number(m.list_price),
        priceBasis: m.price_basis ?? 'unit',
        currency: m.price_currency ?? 'INR',
        ...tax,
      }
      : null,
    definition: m.record_kind === 'definition'
      ? { definitionType: m.definition_type, selectionMode: m.selection_mode, candidateClassificationId: m.candidate_classification_id, ...tax }
      : null,
  };
}

export async function getRecord(db, companyId, id) {
  const m = await requireMaster(db, companyId, id);
  const out = shapeRecord(m);
  out.frozen = frozenBy(m);
  const path = await ancestors(db, companyId, m.classification_id);
  out.classificationPath = path.map((n) => ({ id: n.id, code: n.code, name: n.name, level: levelName(n.depth) }));
  if (m.source_definition_id) {
    const d = await loadMaster(db, companyId, m.source_definition_id);
    out.sourceDefinition = d ? { id: d.id, code: d.code, name: d.name, status: d.status } : null;
  }
  if (m.record_kind === 'definition') {
    const [[counts]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM cf_item_details i JOIN cf_master_records mr ON mr.id = i.master_id AND mr.deleted_at IS NULL
                WHERE i.company_id = ? AND i.source_definition_id = ? AND i.deleted_at IS NULL) AS temporary_items,
              (SELECT COUNT(*) FROM cf_selection_scope WHERE company_id = ? AND definition_id = ? AND item_id IS NOT NULL) AS allowed_items,
              (SELECT COUNT(*) FROM cf_selection_scope WHERE company_id = ? AND definition_id = ? AND node_id IS NOT NULL) AS branches,
              (SELECT COUNT(*) FROM cf_selection_criteria WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL) AS criteria`,
      [companyId, id, companyId, id, companyId, id, companyId, id],
    );
    out.counts = { temporaryItems: Number(counts.temporary_items), allowedItems: Number(counts.allowed_items), branches: Number(counts.branches), criteria: Number(counts.criteria) };
  }
  if (m.candidate_classification_id) {
    const n = await loadNode(db, companyId, m.candidate_classification_id);
    out.definition.candidateClassification = n ? { id: n.id, code: n.code, name: n.name, level: levelName(n.depth) } : null;
  }
  const flowOf = async (flowId) => {
    if (!flowId) return null;
    const [[fl]] = await db.query('SELECT id, code, name, status FROM cf_operation_flows WHERE id = ? AND deleted_at IS NULL', [flowId]);
    return fl ? { id: fl.id, code: fl.code, name: fl.name, status: fl.status } : null;
  };
  out.defaultFlow = await flowOf(m.default_flow_id);
  if (m.record_kind === 'item' || m.definition_type === 'template') Object.assign(out, await cutOfRecord(db, companyId, m));
  // A temporary item made the way its template usually is, unless it says otherwise.
  if (!out.defaultFlow && m.source_definition_id) {
    const [[d]] = await db.query('SELECT default_flow_id FROM cf_master_records WHERE id = ?', [m.source_definition_id]);
    out.definitionFlow = await flowOf(d?.default_flow_id);
  }
  const bom = await bomOfParent(db, companyId, id);
  if (bom) {
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_bom_lines WHERE company_id = ? AND bom_id = ? AND deleted_at IS NULL', [companyId, bom.id]);
    out.bom = { id: bom.id, bomType: bom.bom_type, status: bom.status, revision: bom.revision, lineCount: Number(n) };
  } else {
    out.bom = null;
  }
  if (m.owner_order_line_id) {
    const [[owner]] = await db.query(
      `SELECT ol.id AS line_id, ol.line_no, ol.item_id, o.id AS order_id, o.code AS order_code, o.status AS order_status
         FROM cf_sales_order_lines ol JOIN cf_sales_orders o ON o.id = ol.order_id
        WHERE ol.company_id = ? AND ol.id = ?`,
      [companyId, m.owner_order_line_id],
    );
    out.owner = owner ? {
      orderId: owner.order_id, orderCode: owner.order_code, orderStatus: owner.order_status,
      lineId: owner.line_id, lineNo: owner.line_no, isLineItem: owner.item_id === id,
    } : null;
    const place = await placementOf(db, companyId, id);
    out.placement = place ? { parentId: place.parent_id, parentCode: place.parent_code, parentName: place.parent_name, bomLineId: place.line_id, position: place.position, quantity: Number(place.quantity), role: place.role } : null;
  }
  return out;
}

export async function getRecordSpecs(db, companyId, id) {
  const m = await requireMaster(db, companyId, id);
  return publicResolution(await resolve(db, companyId, { master: m }));
}

const RECORD_KINDS = ['catalog', 'temporary', 'template', 'selection'];

/** Columns the paged list may sort by (the screen's column keys). BOM size has no cheap sortable expression. */
const RECORD_SORT = {
  code: 'm.code', name: 'm.name', shortName: 'm.short_name', kind: 'COALESCE(i.item_type, d.definition_type)',
  classification: 'c.name', status: 'm.status', rev: 'm.revision', tracked: 'i.tracked_by',
  chooses: 'd.selection_mode', sourcing: 'i.sourcing',
};
const RECORD_STATUSES = ['draft', 'active', 'obsolete'];

export async function listRecords(db, companyId, q = {}) {
  // `rest` is every filter but kind and status. ONE grouped read over `rest`
  // (kind x status) answers the total, the kind chips (each over the status
  // filter), the status chips (each over the kind filter) and the tiles — no
  // per-row work, one round trip beside the rows (prod is ~49 ms per trip;
  // 2026-10-02: Items tiles counted only the loaded rows).
  const rest = ['m.company_id = ?', 'm.deleted_at IS NULL'];
  const restParams = [companyId];
  const kindWhere = [];
  const kindParams = [];
  if (q.recordKind) { rest.push('m.record_kind = ?'); restParams.push(q.recordKind); }
  if (q.kind) { kindWhere.push('(i.item_type = ? OR d.definition_type = ?)'); kindParams.push(q.kind, q.kind); }
  // kinds=catalog,template,selection — what a BOM line or order line picker may offer
  const kinds = blank(q.kinds) ? [] : String(q.kinds).split(',').map((k) => k.trim()).filter((k) => RECORD_KINDS.includes(k));
  if (kinds.length) { kindWhere.push('(i.item_type IN (?) OR d.definition_type IN (?))'); kindParams.push(kinds, kinds); }
  // An order's rows (temporary items, cut plates too) live on the order: a list
  // shows them only when asked for them by name or by order (user, 2026-09-26 —
  // a row is a design, not a catalog item).
  const hideTemporary = q.kind !== 'temporary' && !kinds.includes('temporary') && blank(q.orderId);
  if (hideTemporary) kindWhere.push("(i.item_type IS NULL OR i.item_type <> 'temporary')");
  if (q.usable === '1' || q.usable === 1 || q.usable === true) rest.push("m.status <> 'obsolete'");
  if (!blank(q.orderId)) {
    rest.push('i.owner_order_line_id IN (SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ?)');
    restParams.push(companyId, Number(q.orderId));
  }
  if (!blank(q.classificationId)) {
    rest.push('m.classification_id IN (?)');
    restParams.push(await subtreeIds(db, companyId, Number(q.classificationId)));
  }
  if (!blank(q.search)) {
    const like = likeOf(q.search);
    rest.push('(m.code LIKE ? OR m.name LIKE ?)');
    restParams.push(like, like);
  }
  const statusOk = (s) => blank(q.status) || s === q.status;
  const kindOk = (k) => (q.kind ? k === q.kind
    : kinds.length ? kinds.includes(k)
      : !(hideTemporary && k === 'temporary'));
  const paged = wantsPage(q);
  const page = paged ? pageArgs(q, { def: 100 }) : { limit: Math.min(Math.max(Number(q.limit) || 100, 1), 500), offset: Math.max(Number(q.offset) || 0, 0) };
  const where = [...rest];
  const params = [...restParams];
  if (!blank(q.status)) { where.push('m.status = ?'); params.push(q.status); }
  where.push(...kindWhere);
  params.push(...kindParams);
  const joins = `FROM cf_master_records m
    JOIN cf_classification_nodes c ON c.id = m.classification_id
    LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
    LEFT JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL`;
  const from = `${joins}
    LEFT JOIN cf_master_records sd ON sd.id = i.source_definition_id
    LEFT JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
    LEFT JOIN cf_sales_orders so ON so.id = ol.order_id
   WHERE ${where.join(' AND ')}`;
  const order = paged ? orderBy(q, RECORD_SORT, 'm.code IS NULL, m.code, m.id', 'm.id') : 'm.code IS NULL, m.code, m.id';
  const rowsQuery = db.query(
    `SELECT m.*, c.code AS classification_code, c.name AS classification_name,
            i.item_type, i.tracked_by, i.uom, i.sourcing, i.source_definition_id, i.owner_order_line_id,
            i.list_price, i.price_basis, i.currency AS price_currency,
            COALESCE(i.hsn_code, d.hsn_code) AS hsn_code, COALESCE(i.gst_rate, d.gst_rate) AS gst_rate, COALESCE(i.is_service, d.is_service, 0) AS is_service,
            d.definition_type, d.selection_mode, d.candidate_classification_id,
            sd.code AS source_definition_code, ol.line_no AS owner_line_no, so.id AS owner_order_id, so.code AS owner_order_code,
            (SELECT b.status FROM cf_boms b WHERE b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL LIMIT 1) AS bom_status,
            -- The list shows how big a BOM is, not just that there is one, so a
            -- user can see at a glance which records are built and which are bare.
            (SELECT COUNT(*) FROM cf_bom_lines bl JOIN cf_boms b2 ON b2.id = bl.bom_id
              WHERE b2.company_id = m.company_id AND b2.parent_id = m.id AND b2.deleted_at IS NULL
                AND bl.deleted_at IS NULL) AS bom_line_count
       ${from}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`,
    [...params, page.limit, page.offset],
  );
  const matrixQuery = db.query(
    `SELECT COALESCE(i.item_type, d.definition_type) AS kind, m.status AS status, COUNT(*) AS n, SUM(m.code IS NULL) AS no_code
       ${joins} WHERE ${rest.join(' AND ')} GROUP BY COALESCE(i.item_type, d.definition_type), m.status`,
    restParams,
  );
  // "of N overall": every record of this screen's kind, whatever else is filtered.
  const overallQuery = paged && q.recordKind
    ? db.query(
      `SELECT COALESCE(i.item_type, d.definition_type) AS kind, COUNT(*) AS n ${joins}
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = ? GROUP BY COALESCE(i.item_type, d.definition_type)`,
      [companyId, q.recordKind],
    )
    : Promise.resolve([[]]);
  const [[rows], [matrix], [overallRows]] = await Promise.all([rowsQuery, matrixQuery, overallQuery]);
  const kindCounts = { catalog: 0, temporary: 0, template: 0, selection: 0 };
  const statusCounts = Object.fromEntries(RECORD_STATUSES.map((s) => [s, 0]));
  let total = 0;
  let noCode = 0;
  let statusAll = 0;
  for (const r of matrix) {
    const n = Number(r.n);
    if (r.kind && kindCounts[r.kind] !== undefined && statusOk(r.status)) kindCounts[r.kind] += n;
    if (kindOk(r.kind)) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + n;
      statusAll += n;
      if (statusOk(r.status)) { total += n; noCode += Number(r.no_code || 0); }
    }
  }
  const shaped = rows.map((r) => ({
    ...shapeRecord(r),
    classificationCode: r.classification_code,
    classificationName: r.classification_name,
    sourceDefinitionCode: r.source_definition_code ?? null,
    bomStatus: r.bom_status ?? null,
    bomLineCount: r.bom_status ? Number(r.bom_line_count ?? 0) : null,
    owner: r.owner_order_id ? { orderId: r.owner_order_id, orderCode: r.owner_order_code, lineNo: r.owner_line_no } : null,
  }));
  if (!paged) return { total, kindCounts, rows: shaped };
  const overall = { catalog: 0, temporary: 0, template: 0, selection: 0 };
  for (const r of overallRows) if (r.kind && overall[r.kind] !== undefined) overall[r.kind] = Number(r.n);
  return pageOf(shaped, total, page, {
    kindCounts,
    counts: {
      total,
      kind: kindCounts,
      status: { ...statusCounts, all: statusAll },
      noCode,
      // Every record of this screen's kinds, whatever is filtered (the "of N").
      overall: q.recordKind === 'definition' ? overall.template + overall.selection : overall.catalog + overall.temporary,
    },
  });
}

/**
 * What a record would look like before it is saved: the specifications that
 * apply (so the form can render the right fields), and the code and name the
 * generator would give it. Writes nothing and takes no number.
 */
export async function previewDraft(db, companyId, draft = {}) {
  const master = await draftMaster(db, companyId, draft);
  if (!master.classification_id) {
    return { resolution: null, code: null, name: null, note: master.item_type === 'temporary' ? 'Choose a template definition.' : 'Choose a Variant.' };
  }
  const r = await resolve(db, companyId, { master, draftValues: await draftValueMap(db, companyId, draft.values) });
  const attempt = async (targetField) => {
    if (!blank(draft[targetField])) return null;
    try {
      return await generate(db, companyId, master.record_kind, targetField, { draft }, { consume: false });
    } catch (e) {
      return { error: e.message, problems: e.problems };
    }
  };
  return { resolution: publicResolution(r), code: await attempt('code'), name: await attempt('name') };
}
