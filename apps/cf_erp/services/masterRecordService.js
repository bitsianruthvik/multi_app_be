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
import { loadMaster, requireMaster, kindOf, frozenBy, assertNotFrozen } from './records.js';
import { requireLeaf } from './classificationService.js';
import { resolve, publicResolution, TRACK_DEPTH } from './resolutionService.js';
import { setValues, materialize, rematerialize, deleteAllForSubject as deleteValues } from './valueService.js';
import { deleteAllForSubject as deleteRules } from './assignmentService.js';
import { generate, findConditionsReferencing } from '../modules/codegen/index.js';
import { draftMaster, draftValueMap } from './drafts.js';
import { bomOfParent, deleteBomOf, placementOf } from './bomGraph.js';
import { nextRevision } from '../lib/revision.js';
import { requireUsableFlow } from './flowService.js';

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
  const shortName = readShortName(input.shortName, problems);
  const revision = blank(input.revision) ? null : String(input.revision).trim();
  if (revision && revision.length > 20) problems.push('Revision is up to 20 characters.');
  if (input.status && !['draft', 'active'].includes(input.status)) problems.push('A new record starts as draft or active.');
  return { code, name, shortName, revision, description: blank(input.description) ? null : String(input.description), status: input.status ?? 'draft' };
}

async function readSelection(db, companyId, definitionType, input, problems, existing = null) {
  if (definitionType !== 'selection') {
    if (input.selectionMode || input.candidateClassificationId) problems.push('Only selection definitions have a selection mode and a search area.');
    return { selectionMode: null, candidateClassificationId: null };
  }
  const selectionMode = input.selectionMode ?? existing?.selection_mode ?? 'allowed_list';
  if (!SELECTION_MODES.includes(selectionMode)) problems.push('Selection mode is allowed_list, spec_match or both.');
  const raw = input.candidateClassificationId !== undefined ? input.candidateClassificationId : existing?.candidate_classification_id ?? null;
  const candidateClassificationId = blank(raw) ? null : Number(raw);
  if (candidateClassificationId != null) {
    const area = await loadNode(db, companyId, candidateClassificationId);
    if (!area) problems.push('The search area does not exist.');
    else if (area.scope === 'machine') problems.push('The search area is a machine family — a selection searches catalog items.');
  }
  return { selectionMode, candidateClassificationId };
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
  const base = readBase(input, problems);
  assertNoProblems(problems);

  const [r] = await db.query(
    `INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, description, classification_id, status, revision, created_by)
     VALUES (?, 'item', ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [c.companyId, base.code, base.name ?? '(pending)', base.shortName, base.description, classificationId, base.revision, c.userId],
  );
  await db.query(
    `INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, source_definition_id, owner_order_line_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.insertId, c.companyId, itemType, trackedBy, uom, sourcing, sourceDefinitionId, ownerOrderLineId],
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
  const base = readBase(input, problems);
  assertNoProblems(problems);

  const [r] = await db.query(
    `INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, description, classification_id, status, revision, created_by)
     VALUES (?, 'definition', ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [c.companyId, base.code, base.name ?? '(pending)', base.shortName, base.description, classificationId, base.revision, c.userId],
  );
  await db.query(
    `INSERT INTO cf_definition_details (master_id, company_id, definition_type, selection_mode, candidate_classification_id)
     VALUES (?, ?, ?, ?, ?)`,
    [r.insertId, c.companyId, definitionType, sel.selectionMode, sel.candidateClassificationId],
  );
  return finishCreate(db, c, r.insertId, 'definition', base, input);
}

export async function updateRecord(db, c, id, input = {}) {
  const m = await requireMaster(db, c.companyId, id);
  assertNotFrozen(m, 'details');
  const problems = [];
  const sets = {};
  const detail = {};

  if (input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 255) problems.push('Name is required (up to 255 characters).');
    sets.name = name;
  }
  // Unlike the code, this one stays editable at any status: it feeds the codes
  // generated for stock and WIP from now on, not a code already on a document.
  if (input.shortName !== undefined) sets.short_name = readShortName(input.shortName, problems);
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
    if (input.itemType !== undefined && input.itemType !== m.item_type) problems.push('An item stays catalog or temporary.');
    if (input.sourceDefinitionId !== undefined && Number(input.sourceDefinitionId) !== m.source_definition_id) problems.push('The source definition is set when a temporary item is created.');
    if (input.ownerOrderLineId !== undefined && Number(input.ownerOrderLineId) !== m.owner_order_line_id) problems.push('The owner order line is set when a temporary item is created.');
  } else {
    if (input.definitionType !== undefined && input.definitionType !== m.definition_type) problems.push('A definition stays a template or a selection.');
    if (input.selectionMode !== undefined || input.candidateClassificationId !== undefined) {
      const sel = await readSelection(db, c.companyId, m.definition_type, input, problems, m);
      if (m.definition_type === 'selection') {
        detail.selection_mode = sel.selectionMode;
        detail.candidate_classification_id = sel.candidateClassificationId;
      }
    }
  }
  assertNoProblems(problems);

  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_master_records SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, id]);
  }
  if (Object.keys(detail).length) {
    const table = m.record_kind === 'item' ? 'cf_item_details' : 'cf_definition_details';
    await db.query(`UPDATE ${table} SET ${Object.keys(detail).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND master_id = ?`,
      [...Object.values(detail), c.companyId, id]);
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
      if (m.item_type === 'temporary') {
        const def = await loadMaster(db, c.companyId, m.source_definition_id);
        if (def && def.status !== 'active') problems.push(`Its definition ${def.code ?? def.name} is not active.`);
      }
    } else if (m.definition_type === 'selection') {
      const [[counts]] = await db.query(
        `SELECT (SELECT COUNT(*) FROM cf_definition_allowed_items WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL) AS allowed,
                (SELECT COUNT(*) FROM cf_selection_criteria WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL) AS criteria`,
        [c.companyId, id, c.companyId, id],
      );
      if (['allowed_list', 'both'].includes(m.selection_mode) && !Number(counts.allowed)) problems.push('The allowed list is empty.');
      if (['spec_match', 'both'].includes(m.selection_mode) && !Number(counts.criteria)) problems.push('There are no matching criteria.');
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
      `SELECT DISTINCT dm.code, dm.name FROM cf_definition_allowed_items a
         JOIN cf_master_records dm ON dm.id = a.definition_id AND dm.deleted_at IS NULL
        WHERE a.company_id = ? AND a.item_id = ? AND a.deleted_at IS NULL`,
      [c.companyId, id],
    );
    if (rows.length) reasons.push(`it is on the allowed list of ${rows.map((r) => r.code ?? r.name).join(', ')}`);
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_stock_ledger WHERE company_id = ? AND item_id = ?', [c.companyId, id]);
    if (Number(n)) reasons.push('it has stock history — mark it obsolete instead');
  }
  if (reasons.length) {
    throw conflict('IN_USE', `${m.code ?? m.name} cannot be deleted: ${reasons.join('; ')}.`, { problems: reasons });
  }
  if (m.record_kind === 'definition') {
    await db.query('UPDATE cf_definition_allowed_items SET deleted_at = NOW() WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL', [c.companyId, id]);
    await db.query('UPDATE cf_selection_criteria SET deleted_at = NOW() WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL', [c.companyId, id]);
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
  return {
    id: m.id,
    recordKind: m.record_kind,
    kind: kindOf(m),
    code: m.code,
    name: m.name,
    shortName: m.short_name ?? null,
    description: m.description,
    classificationId: m.classification_id,
    status: m.status,
    revision: m.revision,
    defaultFlowId: m.default_flow_id ?? null,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    item: m.record_kind === 'item'
      ? { itemType: m.item_type, trackedBy: m.tracked_by, uom: m.uom, sourcing: m.sourcing, sourceDefinitionId: m.source_definition_id, ownerOrderLineId: m.owner_order_line_id }
      : null,
    definition: m.record_kind === 'definition'
      ? { definitionType: m.definition_type, selectionMode: m.selection_mode, candidateClassificationId: m.candidate_classification_id }
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
              (SELECT COUNT(*) FROM cf_definition_allowed_items WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL) AS allowed_items,
              (SELECT COUNT(*) FROM cf_selection_criteria WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL) AS criteria`,
      [companyId, id, companyId, id, companyId, id],
    );
    out.counts = { temporaryItems: Number(counts.temporary_items), allowedItems: Number(counts.allowed_items), criteria: Number(counts.criteria) };
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

export async function listRecords(db, companyId, q = {}) {
  const where = ['m.company_id = ?', 'm.deleted_at IS NULL'];
  const params = [companyId];
  if (q.recordKind) { where.push('m.record_kind = ?'); params.push(q.recordKind); }
  if (q.kind) { where.push('(i.item_type = ? OR d.definition_type = ?)'); params.push(q.kind, q.kind); }
  // kinds=catalog,template,selection — what a BOM line or order line picker may offer
  const kinds = blank(q.kinds) ? [] : String(q.kinds).split(',').map((k) => k.trim()).filter((k) => ['catalog', 'temporary', 'template', 'selection'].includes(k));
  if (kinds.length) { where.push('(i.item_type IN (?) OR d.definition_type IN (?))'); params.push(kinds, kinds); }
  if (q.status) { where.push('m.status = ?'); params.push(q.status); }
  if (q.usable === '1' || q.usable === 1 || q.usable === true) where.push("m.status <> 'obsolete'");
  if (!blank(q.orderId)) {
    where.push('i.owner_order_line_id IN (SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ?)');
    params.push(companyId, Number(q.orderId));
  }
  if (!blank(q.classificationId)) {
    where.push('m.classification_id IN (?)');
    params.push(await subtreeIds(db, companyId, Number(q.classificationId)));
  }
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push('(m.code LIKE ? OR m.name LIKE ?)');
    params.push(like, like);
  }
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const from = `FROM cf_master_records m
    JOIN cf_classification_nodes c ON c.id = m.classification_id
    LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
    LEFT JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
    LEFT JOIN cf_master_records sd ON sd.id = i.source_definition_id
    LEFT JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
    LEFT JOIN cf_sales_orders so ON so.id = ol.order_id
   WHERE ${where.join(' AND ')}`;
  const [rows] = await db.query(
    `SELECT m.*, c.code AS classification_code, c.name AS classification_name,
            i.item_type, i.tracked_by, i.uom, i.sourcing, i.source_definition_id, i.owner_order_line_id,
            d.definition_type, d.selection_mode, d.candidate_classification_id,
            sd.code AS source_definition_code, ol.line_no AS owner_line_no, so.id AS owner_order_id, so.code AS owner_order_code,
            (SELECT b.status FROM cf_boms b WHERE b.company_id = m.company_id AND b.parent_id = m.id AND b.deleted_at IS NULL LIMIT 1) AS bom_status
       ${from}
      ORDER BY m.code IS NULL, m.code, m.id
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total ${from}`, params);
  return {
    total: Number(total),
    rows: rows.map((r) => ({
      ...shapeRecord(r),
      classificationCode: r.classification_code,
      classificationName: r.classification_name,
      sourceDefinitionCode: r.source_definition_code ?? null,
      bomStatus: r.bom_status ?? null,
      owner: r.owner_order_id ? { orderId: r.owner_order_id, orderCode: r.owner_order_code, lineNo: r.owner_line_no } : null,
    })),
  };
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
