/**
 * bomService.js — Standard, Template and Custom BOMs: read, add / change /
 * remove lines, choose a selection's catalog item, activate, revise, explode,
 * where-used.
 *
 * One engine; the parent decides the rules (models/init.sql §8):
 *   catalog item        -> Standard BOM: catalog items only
 *   template definition -> Template BOM: catalog items, template and selection definitions
 *   temporary item      -> Custom BOM:   catalog items; a template definition
 *                          becomes a NEW temporary item on the spot (Q21) with
 *                          its Template BOM copied beneath it; a selection stays
 *                          a placeholder until a catalog item is chosen
 * A BOM may never contain its own parent further down — that would be a loop
 * with no bottom, refused when the line is added.
 *
 * Every change re-works the values it can reach, in the same transaction:
 * roll-ups up the tree, inherited values down it (valueService.refreshValues).
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { requireMaster, kindOf, LOCKED_ORDER_STATUSES } from './records.js';
import {
  bomTypeOf, bomOfParent, bomsOfParents, linesOfBom, linesOfBoms, loadLine, childKindOf, descendantIds,
  createBom, insertLine, nextLineNo, nextPosition, effectiveFlowOf,
} from './bomGraph.js';
import { refreshValues } from './valueService.js';
import { findCandidates } from './selectionService.js';
import { instantiateTemplate, defaultCandidate, deleteTemporaryTree, checkTemplate } from './instantiationService.js';
import { nextRevision } from '../lib/revision.js';
import { requireUsableFlow } from './flowService.js';

export const ALLOWED_CHILDREN = {
  standard: ['catalog'],
  template: ['catalog', 'template', 'selection'],
  custom: ['catalog', 'template', 'selection'],
};
const TRANSITIONS = { draft: ['active'], active: ['obsolete'], obsolete: ['active'] };

const blank = (v) => v == null || String(v).trim() === '';
const labelOf = (m) => m.code ?? m.name;

function readQuantity(value, problems, required) {
  if (blank(value)) { if (required) problems.push('Quantity is required.'); return null; }
  const q = Number(value);
  if (!Number.isFinite(q) || q <= 0) { problems.push('Quantity must be more than zero.'); return null; }
  if (q >= 1e9) { problems.push('Quantity is too large.'); return null; }
  return Number(q.toFixed(6));
}

function readLineNo(value, problems) {
  if (blank(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 1e6) { problems.push('Line number is a positive whole number.'); return null; }
  return n;
}

function readRole(value, problems) {
  if (blank(value)) return null;
  const s = String(value).trim();
  if (s.length > 100) problems.push('Role is up to 100 characters.');
  return s;
}

function shapeBom(b) {
  return b ? { id: b.id, bomType: b.bom_type, status: b.status, revision: b.revision, sourceBomId: b.source_bom_id, notes: b.notes, updatedAt: b.updated_at } : null;
}

function shapeLine(l, hasBom) {
  const kind = childKindOf(l);
  return {
    id: l.id,
    lineNo: l.line_no,
    position: l.position,
    role: l.role,
    quantity: Number(l.quantity),
    notes: l.notes,
    child: {
      id: l.child_id, code: l.child_code, name: l.child_name, kind, status: l.child_status,
      recordKind: l.child_record_kind, uom: l.child_uom ?? null, hasBom: !!hasBom,
    },
    design: { id: l.design_id, code: l.design_code, name: l.design_name },
    selection: l.selection_definition_id ? { id: l.selection_definition_id, code: l.selection_code, name: l.selection_name } : null,
    resolved: l.child_record_kind === 'item',
    sourceLineId: l.source_line_id,
    // The flow this line names, and the one that applies (line, else the child's default).
    flow: l.operation_flow_id ? { id: l.operation_flow_id, code: l.line_flow_code, name: l.line_flow_name } : null,
    effectiveFlow: effectiveFlowOf(l),
  };
}

const SELECTION_FLOW = 'A selection line takes the flow of the catalog item chosen for it — it has none of its own.';

/** A flow for a line: null clears it; a selection line has none. */
async function readLineFlow(db, companyId, value, isSelection, problems) {
  if (blank(value)) return null;
  if (isSelection) { problems.push(SELECTION_FLOW); return null; }
  return requireUsableFlow(db, companyId, value, problems);
}

/** The order a temporary parent belongs to — its status decides whether its structure may change. */
async function ownerOrder(db, companyId, parent) {
  if (!parent.owner_order_line_id) return null;
  const [[o]] = await db.query(
    `SELECT o.id, o.code, o.status FROM cf_sales_order_lines ol JOIN cf_sales_orders o ON o.id = ol.order_id
      WHERE ol.company_id = ? AND ol.id = ?`,
    [companyId, parent.owner_order_line_id],
  );
  return o || null;
}

async function assertEditable(db, companyId, parent) {
  if (parent.status === 'obsolete') throw invalid('OBSOLETE', `${labelOf(parent)} is obsolete — reactivate it to change its BOM.`);
  const order = await ownerOrder(db, companyId, parent);
  if (order && LOCKED_ORDER_STATUSES.has(order.status)) throw invalid('ORDER_CLOSED', `Order ${order.code} is ${order.status} — its structure can no longer change.`);
  if (parent.owner_release_id) {
    throw invalid('RELEASED', `${labelOf(parent)} was released to production with line ${parent.owner_line_no} of ${order?.code ?? 'its order'} — its structure can no longer change. (Take the release back while nothing has started, or wait for change after release.)`);
  }
}

/** The BOM of any record, with its lines and what they may contain. */
export async function getBom(db, companyId, parentId) {
  const parent = await requireMaster(db, companyId, parentId);
  const bomType = bomTypeOf(parent);
  const bom = await bomOfParent(db, companyId, parentId);
  const lines = bom ? await linesOfBom(db, companyId, bom.id) : [];
  const childBoms = await bomsOfParents(db, companyId, [...new Set(lines.map((l) => l.child_id))]);
  const order = await ownerOrder(db, companyId, parent);
  return {
    parent: { id: parent.id, code: parent.code, name: parent.name, kind: kindOf(parent), status: parent.status },
    bomType,
    canHaveBom: !!bomType,
    allowedChildKinds: ALLOWED_CHILDREN[bomType] ?? [],
    order: order ? { id: order.id, code: order.code, status: order.status, released: !!parent.owner_release_id } : null,
    bom: shapeBom(bom),
    lines: lines.map((l) => shapeLine(l, childBoms.has(l.child_id))),
    unresolvedSelections: lines.filter((l) => l.child_record_kind === 'definition' && l.selection_definition_id).length,
  };
}

async function ensureBom(db, c, parent, bomType) {
  const existing = await bomOfParent(db, c.companyId, parent.id);
  const bom = existing ?? await createBom(db, c, { parentId: parent.id, bomType });
  // Serialises concurrent edits of one BOM, so two people cannot take the same position number.
  await db.query('SELECT id FROM cf_boms WHERE id = ? FOR UPDATE', [bom.id]);
  return bom;
}

/**
 * Adds a child. input: { childId, quantity, role?, lineNo?, notes?, operationFlowId? }.
 * operationFlowId is how the child is made in THIS parent, when that differs
 * from the child's own default flow.
 * On a Custom BOM a template definition becomes a new temporary item here and
 * a selection line starts with its default catalog item, if it has one.
 */
export async function addLine(db, c, parentId, input = {}) {
  const parent = await requireMaster(db, c.companyId, parentId);
  const bomType = bomTypeOf(parent);
  if (!bomType) throw invalid('NO_BOM', 'A selection definition has no BOM — it chooses a catalog item.');
  await assertEditable(db, c.companyId, parent);

  const problems = [];
  const quantity = readQuantity(input.quantity, problems, true);
  const lineNoIn = readLineNo(input.lineNo, problems);
  const role = readRole(input.role, problems);
  if (blank(input.childId)) problems.push('Choose what to add.');
  assertNoProblems(problems);

  const child = await requireMaster(db, c.companyId, Number(input.childId), 'That record');
  const childKind = kindOf(child);
  if (!ALLOWED_CHILDREN[bomType].includes(childKind)) {
    const why = {
      standard: 'A Standard BOM holds catalog items only — a structure that changes per order belongs on a template definition.',
      template: 'A Template BOM holds catalog items and definitions — temporary items belong to one order.',
      custom: 'Temporary items are created by adding their template definition here.',
    }[bomType];
    throw invalid('WRONG_CHILD', why);
  }
  if (child.status === 'obsolete') throw invalid('OBSOLETE_CHILD', `${labelOf(child)} is obsolete.`);
  if (child.id === parent.id) throw invalid('SELF', 'A record cannot contain itself.');
  if ((await descendantIds(db, c.companyId, child.id)).has(parent.id)) {
    throw invalid('LOOP', `${labelOf(child)} already contains ${labelOf(parent)} further down — adding it here would make a loop.`);
  }
  const operationFlowId = await readLineFlow(db, c.companyId, input.operationFlowId, childKind === 'selection', problems);
  assertNoProblems(problems);

  if (bomType === 'custom' && childKind === 'template') await checkTemplate(db, c.companyId, child);

  const bom = await ensureBom(db, c, parent, bomType);
  const lineNo = lineNoIn ?? await nextLineNo(db, c.companyId, bom.id);
  const position = await nextPosition(db, c.companyId, bom.id, child.id);
  const common = { lineNo, position, quantity, role, operationFlowId, notes: blank(input.notes) ? null : String(input.notes) };
  let created = [];

  if (bomType === 'custom' && childKind === 'template') {
    const out = await instantiateTemplate(db, c, { definition: child, ownerLineId: parent.owner_order_line_id, place: { bom, ...common } });
    created = out.created;
  } else if (bomType === 'custom' && childKind === 'selection') {
    const pick = await defaultCandidate(db, c.companyId, child.id);
    await insertLine(db, c, { bomId: bom.id, childId: pick?.id ?? child.id, designId: child.id, selectionDefinitionId: child.id, ...common });
  } else {
    await insertLine(db, c, { bomId: bom.id, childId: child.id, designId: child.id, ...common });
  }
  // New items first (children before parents), then the parent's roll-ups.
  await refreshValues(db, c, [...created.slice().reverse(), parent.id]);
  return getBom(db, c.companyId, parent.id);
}

async function requireLine(db, companyId, lineId) {
  const line = await loadLine(db, companyId, lineId);
  if (!line) throw notFound('BOM line');
  return line;
}

/** The parent a line belongs to — routes use it to pick the permission. */
export async function parentOfLine(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  return requireMaster(db, companyId, line.parent_id);
}

/** input: { quantity?, role?, lineNo?, notes?, operationFlowId? } — what a line IS cannot change; remove it and add another. */
export async function updateLine(db, c, lineId, input = {}) {
  const line = await requireLine(db, c.companyId, lineId);
  const parent = await requireMaster(db, c.companyId, line.parent_id);
  await assertEditable(db, c.companyId, parent);
  if (input.childId !== undefined && Number(input.childId) !== line.child_id) {
    throw invalid('IDENTITY', 'What a line holds cannot change — remove it and add the other one.');
  }
  const problems = [];
  const sets = {};
  if (input.quantity !== undefined) sets.quantity = readQuantity(input.quantity, problems, true);
  if (input.role !== undefined) sets.role = readRole(input.role, problems);
  if (input.lineNo !== undefined) sets.line_no = readLineNo(input.lineNo, problems) ?? line.line_no;
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : String(input.notes);
  if (input.operationFlowId !== undefined) {
    // A Template BOM holds the selection definition itself; a Custom BOM keeps it beside the chosen item.
    const isSelection = !!line.selection_definition_id || childKindOf(line) === 'selection';
    sets.operation_flow_id = await readLineFlow(db, c.companyId, input.operationFlowId, isSelection, problems);
  }
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_bom_lines SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, lineId]);
    if (sets.quantity !== undefined && sets.quantity !== Number(line.quantity)) await refreshValues(db, c, [parent.id]);
  }
  return getBom(db, c.companyId, parent.id);
}

/**
 * Removes a line. On a Custom BOM, a temporary item goes with its line —
 * together with everything below it, since it exists only for this place.
 */
export async function removeLine(db, c, lineId) {
  const line = await requireLine(db, c.companyId, lineId);
  const parent = await requireMaster(db, c.companyId, line.parent_id);
  await assertEditable(db, c.companyId, parent);
  if (line.bom_type === 'custom' && childKindOf(line) === 'temporary') await deleteTemporaryTree(db, c, line.child_id);
  await db.query('UPDATE cf_bom_lines SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, lineId]);
  await refreshValues(db, c, [parent.id]);
  return getBom(db, c.companyId, parent.id);
}

/** The catalog items a selection line may take, with the one it holds now. */
export async function lineCandidates(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  if (!line.selection_definition_id) throw invalid('NOT_SELECTION', 'This line is not a selection.');
  const found = await findCandidates(db, companyId, line.selection_definition_id);
  return {
    lineId: line.id,
    selection: { id: line.selection_definition_id, code: line.selection_code, name: line.selection_name },
    chosenItemId: line.child_record_kind === 'item' ? line.child_id : null,
    ...found,
  };
}

/** Chooses the catalog item for a selection line (Q12), or clears the choice with itemId null. */
export async function resolveLine(db, c, lineId, { itemId } = {}) {
  const line = await requireLine(db, c.companyId, lineId);
  const parent = await requireMaster(db, c.companyId, line.parent_id);
  await assertEditable(db, c.companyId, parent);
  if (!line.selection_definition_id) throw invalid('NOT_SELECTION', 'Only a selection line has an item to choose.');
  let childId = line.selection_definition_id;
  if (!blank(itemId)) {
    const { candidates } = await findCandidates(db, c.companyId, line.selection_definition_id, { limit: 1000 });
    const pick = candidates.find((x) => x.id === Number(itemId));
    if (!pick) throw invalid('NOT_A_CANDIDATE', `That item does not satisfy ${line.selection_code ?? line.selection_name}.`);
    childId = pick.id;
  }
  if (childId !== line.child_id) {
    await db.query('UPDATE cf_bom_lines SET child_id = ? WHERE company_id = ? AND id = ?', [childId, c.companyId, lineId]);
    await refreshValues(db, c, [parent.id]);
  }
  return getBom(db, c.companyId, parent.id);
}

/** Activate / obsolete a Standard or Template BOM. A Custom BOM follows its order. */
export async function setBomStatus(db, c, parentId, status) {
  const parent = await requireMaster(db, c.companyId, parentId);
  const bom = await bomOfParent(db, c.companyId, parentId);
  if (!bom) throw notFound('BOM');
  if (bom.bom_type === 'custom') throw invalid('CUSTOM_BOM', 'A custom BOM follows its sales order — it has no status of its own to set.');
  if (bom.status === status) return getBom(db, c.companyId, parentId);
  if (!(TRANSITIONS[bom.status] ?? []).includes(status)) throw invalid('BAD_TRANSITION', `A ${bom.status} BOM cannot become ${status}.`);
  if (status === 'active') {
    const lines = await linesOfBom(db, c.companyId, bom.id);
    const problems = [];
    if (!lines.length) problems.push('It has no lines.');
    for (const l of lines) {
      if (l.child_status !== 'active') problems.push(`${l.child_code ?? l.child_name} is ${l.child_status}.`);
    }
    if (problems.length) throw invalid('INCOMPLETE', `The BOM of ${labelOf(parent)} cannot be activated yet.`, { problems });
  }
  await db.query('UPDATE cf_boms SET status = ? WHERE company_id = ? AND id = ?', [status, c.companyId, bom.id]);
  return getBom(db, c.companyId, parentId);
}

/** Moves a Standard or Template BOM's revision label on (same BOM, same id — Q2). */
export async function reviseBom(db, c, parentId, input = {}) {
  const bom = await bomOfParent(db, c.companyId, parentId);
  if (!bom) throw notFound('BOM');
  if (bom.bom_type === 'custom') throw invalid('CUSTOM_BOM', 'A custom BOM is revised with its order, in a later phase.');
  if (bom.status === 'obsolete') throw invalid('OBSOLETE', 'Reactivate the BOM before revising it.');
  const label = blank(input.revision) ? nextRevision(bom.revision) : String(input.revision).trim();
  if (label.length > 20) throw invalid('INVALID', 'Revision is up to 20 characters.');
  if (label === bom.revision) throw invalid('SAME_REVISION', `It is already at revision ${label}.`);
  await db.query('UPDATE cf_boms SET revision = ? WHERE company_id = ? AND id = ?', [label, c.companyId, bom.id]);
  return getBom(db, c.companyId, parentId);
}

/**
 * The whole structure under a record, level by level (one query per level):
 * every node carries its quantity per parent and its total — the product of
 * the quantities above it, starting from rootQuantity (a sales line's).
 */
export async function explode(db, companyId, rootId, { rootQuantity = 1, maxDepth = 15 } = {}) {
  const root = await requireMaster(db, companyId, rootId);
  const rootBom = await bomOfParent(db, companyId, rootId);
  const [[rf]] = await db.query(
    `SELECT f.id AS child_flow_id, f.code AS child_flow_code, f.name AS child_flow_name,
            df.id AS def_flow_id, df.code AS def_flow_code, df.name AS def_flow_name
       FROM cf_master_records m
       LEFT JOIN cf_operation_flows f ON f.id = m.default_flow_id
       LEFT JOIN cf_master_records sd ON sd.id = ?
       LEFT JOIN cf_operation_flows df ON df.id = sd.default_flow_id
      WHERE m.company_id = ? AND m.id = ?`,
    [root.source_definition_id ?? null, companyId, root.id],
  );
  const rootNode = {
    key: `r${root.id}`, id: root.id, code: root.code, name: root.name, kind: kindOf(root), status: root.status,
    uom: root.uom ?? null, depth: 0, quantity: rootQuantity, total: rootQuantity, lineId: null, lineNo: null,
    position: null, role: null, selection: null, resolved: root.record_kind === 'item',
    flow: rf ? effectiveFlowOf(rf) : null,
    bom: rootBom ? { id: rootBom.id, bomType: rootBom.bom_type, status: rootBom.status, revision: rootBom.revision } : null,
    children: [],
  };
  const stats = { nodes: 1, temporary: kindOf(root) === 'temporary' ? 1 : 0, drafts: root.status === 'draft' ? 1 : 0, unresolved: 0, maxDepth: 0 };
  let frontier = rootBom ? [rootNode] : [];
  let truncated = false;
  for (let depth = 1; frontier.length; depth++) {
    if (depth > maxDepth) { truncated = true; break; }
    // One BOM can hang under SEVERAL parents at the same level — a blank that
    // three parts are all cut from is exactly that — so a bom id maps to a list
    // of nodes and each of them gets its own copy of the children. Keying one
    // node per bom kept only the last of them, and the copies it dropped took
    // their material with them: the tracker was built and nothing was ever
    // bought for those pieces.
    const byParent = new Map();
    for (const n of frontier) {
      if (!byParent.has(n.bom.id)) byParent.set(n.bom.id, []);
      byParent.get(n.bom.id).push(n);
    }
    const lines = await linesOfBoms(db, companyId, [...byParent.keys()]);
    const childBoms = await bomsOfParents(db, companyId, [...new Set(lines.map((l) => l.child_id))]);
    const next = [];
    for (const l of lines) {
      const cb = childBoms.get(l.child_id);
      const kind = childKindOf(l);
      const copies = byParent.get(l.bom_id) ?? [];
      for (const [i, parentNode] of copies.entries()) {
        const node = {
          // The line names the node, as it always has; only a line reached
          // through more than one parent has to say which copy it is.
          key: copies.length > 1 ? `l${l.id}#${i}` : `l${l.id}`,
          id: l.child_id, code: l.child_code, name: l.child_name, kind, status: l.child_status,
          uom: l.child_uom ?? null, depth, quantity: Number(l.quantity), total: Number((parentNode.total * Number(l.quantity)).toFixed(6)),
          lineId: l.id, lineNo: l.line_no, position: l.position, role: l.role,
          selection: l.selection_definition_id ? { id: l.selection_definition_id, code: l.selection_code, name: l.selection_name } : null,
          resolved: l.child_record_kind === 'item',
          flow: effectiveFlowOf(l),
          bom: cb ? { id: cb.id, bomType: cb.bom_type, status: cb.status, revision: cb.revision } : null,
          children: [],
        };
        parentNode.children.push(node);
        stats.nodes++;
        stats.maxDepth = Math.max(stats.maxDepth, depth);
        if (kind === 'temporary') stats.temporary++;
        if (l.child_status === 'draft') stats.drafts++;
        if (l.selection_definition_id && l.child_record_kind === 'definition') stats.unresolved++;
        if (cb) next.push(node);
      }
    }
    frontier = next;
  }
  return { root: rootNode, stats, truncated };
}

/** Where a record is used: the BOMs that hold it, and the selection lines it satisfies. */
export async function whereUsed(db, companyId, masterId) {
  await requireMaster(db, companyId, masterId);
  const [rows] = await db.query(
    `SELECT l.id AS line_id, l.quantity, l.role, l.position, l.child_id, l.selection_definition_id,
            b.bom_type, b.status AS bom_status, p.id AS parent_id, p.code AS parent_code, p.name AS parent_name,
            p.record_kind, pi.item_type, pd.definition_type, o.id AS order_id, o.code AS order_code
       FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
       JOIN cf_master_records p ON p.id = b.parent_id AND p.deleted_at IS NULL
       LEFT JOIN cf_item_details pi ON pi.master_id = p.id AND pi.deleted_at IS NULL
       LEFT JOIN cf_definition_details pd ON pd.master_id = p.id AND pd.deleted_at IS NULL
       LEFT JOIN cf_sales_order_lines ol ON ol.id = pi.owner_order_line_id
       LEFT JOIN cf_sales_orders o ON o.id = ol.order_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND (l.child_id = ? OR l.selection_definition_id = ?)
      ORDER BY b.bom_type, p.code
      LIMIT 300`,
    [companyId, masterId, masterId],
  );
  return rows.map((r) => ({
    lineId: r.line_id,
    quantity: Number(r.quantity),
    role: r.role,
    position: r.position,
    via: r.child_id === masterId ? 'child' : 'selection',
    bomType: r.bom_type,
    bomStatus: r.bom_status,
    parent: { id: r.parent_id, code: r.parent_code, name: r.parent_name, kind: r.record_kind === 'item' ? r.item_type : r.definition_type },
    order: r.order_id ? { id: r.order_id, code: r.order_code } : null,
  }));
}

