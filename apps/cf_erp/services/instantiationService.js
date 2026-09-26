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
import { invalid, notFound } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { loadMasters } from './records.js';
import { findCandidates } from './selectionService.js';
import { deleteAllForSubject as deleteValues } from './valueService.js';
import { deleteAllForSubject as deleteRules } from './assignmentService.js';
import { bomOfParent, bomsOfParents, linesOfBoms, childKindOf } from './bomGraph.js';
import { materializeLineRecords } from './orderValuesService.js';
import { codeNewItems } from './codeRangeService.js';

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
 * Creates the temporary items of a template definition — the one an order line
 * sells, or one put on a Custom BOM (`place`) — with the definition's Template
 * BOM copied beneath it, recursively.
 *
 *   ownerLineId  the sales order line every item of this structure belongs to
 *   place        { bom, lineNo, position, quantity, role, notes, sourceLineId, operationFlowId }
 *                where it sits in its parent's Custom BOM — omitted for the item
 *                the sales line itself sells, whose line is pointed at it here
 *
 * IN BULK. This used to create one item at a time through createItem — the
 * record, its line, its values resolved three times over, its name and its code
 * each through the code generator, the whole record read back — about 49 round
 * trips an item, then a refreshValues over all of them that changed nothing. On
 * production, ~49 ms a round trip, a 62-item bridge span took three minutes;
 * the screen gave up at thirty seconds and a second click made a second line
 * (SO-20260926-0001). Now:
 *
 *   read the template tree, a level at a time     3 statements a level
 *   INSERT the items with placeholder codes,
 *     read their ids back                         2
 *   INSERT their details, their BOMs,
 *     read the BOM ids back, INSERT every line    4
 *   work out their values, once for the line      orderValuesService.materializeLineRecords
 *   name and code them, once for the tree         codeRangeService.codeNewItems
 *
 * (one more statement per 200 rows, and one per selection line's default.) The
 * same checks refuse the same things before anything is written, and the result
 * is the per-item copy's, item for item — proved against it on real templates
 * (a 203-item span, selections, a template put into an existing structure)
 * before it replaced it.
 *
 * Returns { itemId, created, warnings } — created lists every new item in the
 * order the per-item copy made them (depth first, a parent before its
 * children). Their values, names and codes are settled: a caller has nothing
 * left to refresh for them, only for what they were put under.
 */
export async function instantiateTemplate(db, c, { definition, ownerLineId, place = null }) {
  const { companyId } = c;

  // ---- 1. the whole template tree — every refusal before any write ---------
  const root = { def: definition, depth: 0, path: [], tls: [], childByTl: new Map() };
  const bomOf = new Map();   // definition id -> its Template BOM, or null
  const picks = new Map();   // selection id -> its default candidate, or null
  let frontier = [root];
  while (frontier.length) {
    for (const n of frontier) {
      if (n.depth > MAX_DEPTH) throw invalid('TOO_DEEP', `Templates nest more than ${MAX_DEPTH} levels deep here — check for a template that contains itself.`);
      if (n.path.includes(n.def.id)) throw invalid('TEMPLATE_LOOP', `${n.def.code ?? n.def.name} contains itself further down its Template BOM.`);
      refuseInactive(n.def, n.depth);
    }
    const unread = [...new Set(frontier.map((n) => n.def.id))].filter((id) => !bomOf.has(id));
    const boms = await bomsOfParents(db, companyId, unread);
    for (const id of unread) bomOf.set(id, boms.get(id) ?? null);
    for (const n of frontier) {
      const b = bomOf.get(n.def.id);
      if (b && b.status !== 'active') {
        throw invalid('TEMPLATE_BOM_NOT_ACTIVE', `The Template BOM of ${n.def.code ?? n.def.name} is ${b.status} — activate it before using it on an order.`);
      }
    }
    const bomIds = [...new Set(frontier.map((n) => bomOf.get(n.def.id)?.id).filter(Boolean))];
    const tlsOf = new Map();
    for (const tl of await linesOfBoms(db, companyId, bomIds)) {
      if (!tlsOf.has(tl.bom_id)) tlsOf.set(tl.bom_id, []);
      tlsOf.get(tl.bom_id).push(tl);
    }
    const all = [...tlsOf.values()].flat();
    const defs = await loadMasters(db, companyId, all.filter((tl) => childKindOf(tl) === 'template').map((tl) => tl.child_id));
    for (const tl of all) {
      if (childKindOf(tl) === 'selection' && !picks.has(tl.child_id)) picks.set(tl.child_id, await defaultCandidate(db, companyId, tl.child_id));
    }
    const next = [];
    for (const n of frontier) {
      const b = bomOf.get(n.def.id);
      if (!b) continue;
      n.tls = tlsOf.get(b.id) ?? [];
      for (const tl of n.tls) {
        if (childKindOf(tl) !== 'template') continue;
        const def = defs.get(tl.child_id);
        if (!def) throw notFound('Template definition');
        const child = { def, depth: n.depth + 1, path: [...n.path, n.def.id], tls: [], childByTl: new Map() };
        n.childByTl.set(tl.id, child);
        next.push(child);
      }
    }
    frontier = next;
  }

  // ---- 2. depth first: the order the per-item copy made them in -------------
  const order = [];
  (function walk(n) {
    order.push(n);
    for (const tl of n.tls) { const child = n.childByTl.get(tl.id); if (child) walk(child); }
  }(root));

  // ---- 3. the items, born with placeholder codes to read their ids back by --
  // A new temporary item has no natural key of its own — its code is empty and
  // its name repeats — so each is written with a code unique to this copy and
  // found again by it. codeNewItems overwrites every placeholder, with the
  // generated code or with nothing, before this returns.
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const marker = (i) => `~tpl~${token}~${i}`;
  await insertRows(db, 'cf_master_records',
    ['company_id', 'record_kind', 'code', 'name', 'short_name', 'description', 'classification_id', 'status', 'revision', 'created_by'],
    order.map((n, i) => [companyId, 'item', marker(i), '(pending)', null, null, n.def.classification_id, 'draft', null, c.userId]));
  const [back] = await db.query('SELECT id, code FROM cf_master_records WHERE company_id = ? AND code LIKE ?', [companyId, `~tpl~${token}~%`]);
  const idOf = new Map(back.map((r) => [r.code, r.id]));
  order.forEach((n, i) => { n.id = idOf.get(marker(i)); });
  if (order.some((n) => !n.id)) throw new Error(`cf_erp: ${order.length} temporary items written, ${back.length} read back.`);

  await insertRows(db, 'cf_item_details',
    ['master_id', 'company_id', 'item_type', 'tracked_by', 'uom', 'sourcing', 'source_definition_id', 'owner_order_line_id'],
    order.map((n) => [n.id, companyId, 'temporary', 'individual', 'nos', 'make', n.def.id, ownerLineId]));

  // ---- 4. their Custom BOMs, copied from the Template BOMs ------------------
  const withBom = order.filter((n) => bomOf.get(n.def.id));
  await insertRows(db, 'cf_boms', ['company_id', 'parent_id', 'bom_type', 'status', 'source_bom_id', 'created_by'],
    withBom.map((n) => [companyId, n.id, 'custom', 'draft', bomOf.get(n.def.id).id, c.userId]));
  const custom = await bomsOfParents(db, companyId, withBom.map((n) => n.id)); // one live BOM a parent
  for (const n of withBom) {
    n.customBomId = custom.get(n.id)?.id;
    if (!n.customBomId) throw new Error(`cf_erp: the Custom BOM of temporary item ${n.id} was written and not read back.`);
  }

  // ---- 5. every line: where the top item sits, and each copied line ---------
  // A template line becomes the new item it made; a selection keeps its
  // definition beside the default candidate (Q12); a catalog item is copied as
  // it is. Positions and line numbers are the template's.
  const rows = [];
  const line = (bomId, l) => [companyId, bomId, l.lineNo, l.childId, l.designId, l.position, l.role ?? null, l.quantity,
    l.selectionDefinitionId ?? null, l.sourceLineId ?? null, l.operationFlowId ?? null, l.notes ?? null, c.userId];
  if (place) {
    rows.push(line(place.bom.id, {
      lineNo: place.lineNo, childId: root.id, designId: definition.id, position: place.position, quantity: place.quantity,
      role: place.role, notes: place.notes, sourceLineId: place.sourceLineId, operationFlowId: place.operationFlowId,
    }));
  }
  for (const n of order) {
    for (const tl of n.tls) {
      const common = {
        lineNo: tl.line_no, position: tl.position, quantity: Number(tl.quantity), role: tl.role, notes: tl.notes, sourceLineId: tl.id,
        operationFlowId: tl.operation_flow_id,
      };
      const kind = childKindOf(tl);
      if (kind === 'template') {
        const child = n.childByTl.get(tl.id);
        rows.push(line(n.customBomId, { ...common, childId: child.id, designId: child.def.id }));
      } else if (kind === 'selection') {
        const pick = picks.get(tl.child_id);
        rows.push(line(n.customBomId, { ...common, childId: pick?.id ?? tl.child_id, designId: tl.child_id, selectionDefinitionId: tl.child_id, operationFlowId: null }));
      } else {
        rows.push(line(n.customBomId, { ...common, childId: tl.child_id, designId: tl.design_id }));
      }
    }
  }
  await insertRows(db, 'cf_bom_lines',
    ['company_id', 'bom_id', 'line_no', 'child_id', 'design_id', 'position', 'role', 'quantity', 'selection_definition_id', 'source_line_id', 'operation_flow_id', 'notes', 'created_by'],
    rows);

  // The item the sales line sells: the line points at it before its values are
  // worked out, because the line's structure is read from there.
  if (!place) await db.query('UPDATE cf_sales_order_lines SET item_id = ? WHERE company_id = ? AND id = ?', [root.id, companyId, ownerLineId]);

  // ---- 6. values, then names and codes — a code may print a value ----------
  const created = order.map((n) => n.id);
  await materializeLineRecords(db, c, ownerLineId, created);
  const coded = await codeNewItems(db, c, {
    rootId: root.id,
    parentId: place ? place.bom.parent_id : null,
    ids: created,
    fallbackName: new Map(order.map((n) => [n.id, n.def.name])),
  });
  return { itemId: root.id, created, warnings: coded.warnings };
}

/**
 * A temporary item and every temporary item below it, children first, each
 * once. `rootId` may be one id or several. An item reached twice — a cut plate
 * several parts share — is listed once, below everything that holds it.
 */
export async function temporaryTree(db, companyId, rootId) {
  const order = [];
  let frontier = [...new Set((Array.isArray(rootId) ? rootId : [rootId]).map(Number))];
  for (let depth = 0; frontier.length && depth <= MAX_DEPTH + 5; depth++) {
    order.push(...frontier);
    const [rows] = await db.query(
      `SELECT l.child_id FROM cf_boms b
         JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
         JOIN cf_item_details i ON i.master_id = l.child_id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
        WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`,
      [companyId, frontier],
    );
    frontier = [...new Set(rows.map((r) => Number(r.child_id)))];
  }
  // Children first; a node seen at several depths keeps its deepest place.
  const seen = new Set();
  return order.reverse().filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

/**
 * The part of a temporary tree that nothing outside it still holds.
 *
 * A temporary item is not always private to one place. A cut plate is one
 * rectangle pooled from every part cut to that size, so seven parts each hold a
 * line to the SAME cut plate. Removing one part walked down into that cut plate
 * and deleted it, and the six parts left were pointing at a deleted record —
 * found on the KEPL order on 2026-09-26, through the ordinary Remove.
 *
 * So an item below the root that a live line OUTSIDE the tree still holds is
 * kept, with everything below it: a kept item's own structure is what it stands
 * on. The root always goes — removing it is what the caller asked for.
 */
async function privatePart(db, companyId, rootId, ids) {
  const inTree = new Set(ids);
  const below = ids.filter((id) => id !== rootId);
  if (!below.length) return ids;
  const [rows] = await db.query(
    `SELECT DISTINCT l.child_id, b.parent_id
       FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.child_id IN (?)`,
    [companyId, below],
  );
  const held = [...new Set(rows.filter((r) => !inTree.has(Number(r.parent_id))).map((r) => Number(r.child_id)))];
  if (!held.length) return ids;
  const keep = new Set(await temporaryTree(db, companyId, held));
  return ids.filter((id) => !keep.has(id));
}

/**
 * Deletes a temporary item with everything below it that nothing else holds:
 * values (with history), item-level rules, Custom BOMs and their lines, detail
 * and master rows. A shared item below it stays — see privatePart. The line
 * that held the top item is the caller's to remove. Code numbers are never
 * given back — a deleted P100-G01-WEB02 is not reissued.
 */
export async function deleteTemporaryTree(db, c, rootId) {
  const root = Number(rootId);
  const ids = await privatePart(db, c.companyId, root, await temporaryTree(db, c.companyId, root));
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
