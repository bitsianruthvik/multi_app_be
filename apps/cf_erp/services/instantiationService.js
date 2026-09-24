/**
 * instantiationService.js — turning template definitions into temporary items,
 * and taking them away again.
 *
 * A temporary item is born the moment a template definition is put on an order
 * (decision Q21) — as the item a sales line sells, or as a line of a Custom BOM
 * — always as a draft. Its definition's Template BOM is copied under it at the
 * same time, recursively (taxonomy §3: "may start from a Template BOM and can
 * then be changed freely"):
 *   template definition line -> a new temporary item, one per line (Q5), with
 *                               its own Template BOM copied beneath it
 *   selection line           -> stays the selection until a catalog item is
 *                               chosen; the default candidate (or the only one)
 *                               is pre-filled, and the line keeps both (Q12)
 *   catalog item line        -> copied as it is
 * Positions and line numbers are copied, so the order's structure numbers its
 * webs and flanges the way the template does. Nothing follows the template
 * afterwards — source_bom_id / source_line_id only record where it came from.
 *
 * Only active blueprints are copied: an order is a commitment, and a draft or
 * obsolete template, or a Template BOM still in draft, is refused with its code.
 */
import { invalid } from '../lib/errors.js';
import { requireMaster } from './records.js';
import { createItem } from './masterRecordService.js';
import { findCandidates } from './selectionService.js';
import { deleteAllForSubject as deleteValues } from './valueService.js';
import { deleteAllForSubject as deleteRules } from './assignmentService.js';
import { bomOfParent, linesOfBom, childKindOf, createBom, insertLine } from './bomGraph.js';

const MAX_DEPTH = 20;

/** The catalog item a selection line starts with: its default, or its only candidate. */
export async function defaultCandidate(db, companyId, selectionId) {
  const { candidates } = await findCandidates(db, companyId, selectionId, { limit: 2 });
  if (!candidates.length) return null;
  if (candidates[0].isDefault) return candidates[0];
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * The checks on the template itself, run before anything is written, so a
 * refused line leaves nothing behind. (Templates further down are checked as
 * they are copied; the caller's transaction undoes a refusal there.)
 */
export async function checkTemplate(db, companyId, definition) {
  refuseInactive(definition, 0);
  const templateBom = await bomOfParent(db, companyId, definition.id);
  if (templateBom && templateBom.status !== 'active') {
    throw invalid('TEMPLATE_BOM_NOT_ACTIVE', `The Template BOM of ${definition.code ?? definition.name} is ${templateBom.status} — activate it before using it on an order.`);
  }
}

function refuseInactive(def, depth) {
  const label = def.code ?? def.name;
  if (def.record_kind !== 'definition' || def.definition_type !== 'template') {
    throw invalid('NOT_TEMPLATE', `${label} is not a template definition.`);
  }
  if (def.status !== 'active') {
    throw invalid('TEMPLATE_NOT_ACTIVE', depth === 0
      ? `${label} is ${def.status} — activate it before putting it on an order.`
      : `${label}, inside the template being copied, is ${def.status} — activate it or take it out of that Template BOM.`);
  }
}

/**
 * Creates one temporary item from a template definition, places it, and copies
 * the definition's Template BOM beneath it.
 *
 *   ownerLineId  the sales order line every item of this structure belongs to
 *   place        { bom, lineNo, position, quantity, role, notes, sourceLineId, operationFlowId }
 *                where it sits in its parent's Custom BOM — omitted for the item
 *                the sales line itself sells
 *
 * Returns { itemId, created } — created lists every new temporary item, parents
 * before children, so the caller can refresh their values bottom-up.
 */
export async function instantiateTemplate(db, c, { definition, ownerLineId, place = null, depth = 0, path = [] }) {
  if (depth > MAX_DEPTH) throw invalid('TOO_DEEP', `Templates nest more than ${MAX_DEPTH} levels deep here — check for a template that contains itself.`);
  if (path.includes(definition.id)) throw invalid('TEMPLATE_LOOP', `${definition.code ?? definition.name} contains itself further down its Template BOM.`);
  refuseInactive(definition, depth);
  const templateBom = await bomOfParent(db, c.companyId, definition.id);
  if (templateBom && templateBom.status !== 'active') {
    throw invalid('TEMPLATE_BOM_NOT_ACTIVE', `The Template BOM of ${definition.code ?? definition.name} is ${templateBom.status} — activate it before using it on an order.`);
  }

  // The name says what the thing IS — "Top flange", not "Top flange 01". The
  // trailing number used to be here to keep names apart, which was never needed
  // and never worked: cf_master_records is unique on the CODE, not the name, so
  // "Top flange 01" already existed under two different segments. Three things
  // already say which one this is — the code, the place in the BOM tree, and the
  // line's role ("Intermediate stiffener — plain" against "— drilled"). A number
  // on top of that is noise that reads like meaning. (User, 2026-09-24.)
  const item = await createItem(db, c, {
    itemType: 'temporary', sourceDefinitionId: definition.id, ownerOrderLineId: ownerLineId, status: 'draft',
  }, {
    fallbackName: definition.name,
    place: async (itemId) => {
      if (!place) return;
      await insertLine(db, c, {
        bomId: place.bom.id, lineNo: place.lineNo, childId: itemId, designId: definition.id, position: place.position,
        quantity: place.quantity, role: place.role, notes: place.notes, sourceLineId: place.sourceLineId,
        operationFlowId: place.operationFlowId,
      });
    },
  });
  const created = [item.id];
  if (!templateBom) return { itemId: item.id, created, item };

  const custom = await createBom(db, c, { parentId: item.id, bomType: 'custom', sourceBomId: templateBom.id });
  for (const tl of await linesOfBom(db, c.companyId, templateBom.id)) {
    // A flow named on the template line travels with the copy.
    const common = {
      lineNo: tl.line_no, position: tl.position, quantity: Number(tl.quantity), role: tl.role, notes: tl.notes, sourceLineId: tl.id,
      operationFlowId: tl.operation_flow_id,
    };
    const kind = childKindOf(tl);
    if (kind === 'template') {
      const def = await requireMaster(db, c.companyId, tl.child_id, 'Template definition');
      const sub = await instantiateTemplate(db, c, {
        definition: def, ownerLineId, place: { bom: custom, ...common }, depth: depth + 1, path: [...path, definition.id],
      });
      created.push(...sub.created);
    } else if (kind === 'selection') {
      const pick = await defaultCandidate(db, c.companyId, tl.child_id);
      await insertLine(db, c, { bomId: custom.id, childId: pick?.id ?? tl.child_id, designId: tl.child_id, selectionDefinitionId: tl.child_id, ...common, operationFlowId: null });
    } else {
      await insertLine(db, c, { bomId: custom.id, childId: tl.child_id, designId: tl.design_id, ...common });
    }
  }
  return { itemId: item.id, created, item };
}

/** A temporary item and every temporary item below it, children first. */
export async function temporaryTree(db, companyId, rootId) {
  const order = [];
  let frontier = [rootId];
  for (let depth = 0; frontier.length && depth <= MAX_DEPTH + 5; depth++) {
    order.push(...frontier);
    const [rows] = await db.query(
      `SELECT l.child_id FROM cf_boms b
         JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
         JOIN cf_item_details i ON i.master_id = l.child_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
        WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`,
      [companyId, frontier],
    );
    frontier = rows.map((r) => r.child_id);
  }
  return order.reverse();
}

/**
 * Deletes a temporary item with everything below it: values (with history),
 * item-level rules, Custom BOMs and their lines, detail and master rows. The
 * line that held the top item is the caller's to remove. Code numbers are never
 * given back — a deleted P100-G01-WEB02 is not reissued.
 */
export async function deleteTemporaryTree(db, c, rootId) {
  const ids = await temporaryTree(db, c.companyId, rootId);
  for (const id of ids) {
    await deleteValues(db, c, 'master', id);
    await deleteRules(db, c, 'master', id);
    const bom = await bomOfParent(db, c.companyId, id);
    if (bom) {
      await db.query('UPDATE cf_bom_lines SET deleted_at = NOW() WHERE company_id = ? AND bom_id = ? AND deleted_at IS NULL', [c.companyId, bom.id]);
      await db.query('UPDATE cf_boms SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, bom.id]);
    }
    await db.query('UPDATE cf_item_details SET deleted_at = NOW() WHERE company_id = ? AND master_id = ?', [c.companyId, id]);
    await db.query('UPDATE cf_master_records SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  }
  return ids.length;
}
