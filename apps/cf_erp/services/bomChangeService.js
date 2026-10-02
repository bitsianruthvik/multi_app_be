/**
 * bomChangeService.js — edit mode: many changes to the structure on one BOM
 * screen, saved in one go.
 *
 *   POST /bom-changes
 *   { scope:   { recordId } | { orderLineId },
 *     dryRun?: boolean,
 *     changes: [ { op: 'quantity', lineId, quantity }
 *              | { op: 'flow',     lineId, flowId }            (null clears it)
 *              | { op: 'remove',   lineId }
 *              | { op: 'paste',    sourceLineId, parentId, afterLineId?, quantity? } ] }
 *   -> { applied, dryRun, summary: { sentence, counts }, results }
 *
 * WHAT ONE SCREEN MAY CHANGE
 * Exactly what BomPanel offers, and no more. A line may change when the record
 * whose BOM holds it is the record the screen was opened for (a record's own
 * BOM tab) or one of an order's own temporary items. Every other line in the
 * tree belongs to another record and is changed there — a catalog item's
 * Standard BOM is shared by every order that uses it. A line id that is not in
 * the tree under `scope` is refused, never guessed at: it is how a screen that
 * went stale finds out. Permission follows the PARENT of each line, as
 * routes/boms.js does for single lines — the route is handed the BOM type of
 * every parent touched and asks for the matching grant.
 *
 * ONE MUTATION PATH
 * Quantity, flow and remove go through bomService.writeLineUpdate /
 * writeLineRemoval — the writes updateLine / removeLine make — and a paste into
 * a Template or Standard BOM through bomService.addLine: the path the per-line
 * dialogs and the BOM sheet already take, with its freeze rule, its loop check
 * and its "a removed temporary item takes its subtree with it". What differs is
 * WHEN the values are worked out again: the per-line path does it after every
 * line, a batch once at the end for every parent it touched (ROUND TRIPS).
 * bomSheetService could not be reused as such: its plan is
 * built from spreadsheet cells (headers, Row IDs, a Delete? column), only for an
 * order line, and knows nothing of flows or pastes; its APPLY is exactly this —
 * bomService's mutators, one change at a time.
 *
 * The one thing bomService has no mutator for is a deep copy of an order's own
 * temporary items. That lives in treeCopyService, batched, because a revision
 * of an order copies with the same machine; copyInto below calls it.
 *
 * PASTE
 *   into a Custom BOM (a temporary item) — a DEEP COPY. The source line's
 *     temporary item and every temporary item below it become NEW temporary
 *     items, with their specification values (history written, as
 *     valueService does), their own specification rules, their BOM lines and
 *     their flows. Catalog items, templates and selections inside the subtree
 *     are REFERENCED: they are shared definitions. The copy is independent —
 *     nothing in it points back at the original, except `source_line_id` /
 *     `source_bom_id`, which keep saying which TEMPLATE line they came from.
 *     New items are drafts, like every temporary item at birth, and take
 *     their codes from the code generator one by one, parents first, exactly
 *     as instantiation does — numbering is the generator's business.
 *   into a Template or Standard BOM — another line pointing at the SAME child,
 *     because those children are reusable definitions, not instances.
 *   A paste cannot put a thing under itself: descendantIds, the loop check
 *   bomService uses, refuses a copy of X going anywhere inside X.
 *
 * CUT PLATES ARE SHARED, NOT COPIED
 * A cut plate is a temporary item too, but it belongs to a RECTANGLE on the
 * order line, not to one part: "part, part, part -> one cut plate"
 * (cutPlateService). A copied part is one more part of that same rectangle, so
 * its line points at the SAME cut plate. Copying the blank instead would make a
 * second one for the same rectangle — and the tenant's blank coding rule is
 * built from the order, line and rectangle, so the copy was refused as a
 * duplicate code the first time this ran against the KEPL order. A cut plate is
 * what cutPlateService and nestingService say it is: a temporary item filed
 * under the CUT_PLATE classification.
 *
 * NO CODES ON ROWS
 * A row of an order's BOM is a design with a quantity, not an item, so a copy
 * gets no code (user, 2026-09-26 — "the codes can't live on the BOM as it is
 * yet to be rolled out based on the quantity"). Its pieces get their codes when
 * the line is LOCKED; until then each row shows a placeholder (placeholderService).
 * So a paste among other rows moves nobody's code: there are none to move.
 *
 * A REMOVAL LEAVES A SHARED ITEM WHERE IT IS
 * A removed line takes the temporary items below it that nothing else holds.
 * A cut plate nineteen other parts are still cut from stays: deleteTemporaryTree
 * keeps anything a live line outside the removed subtree still holds. (This
 * screen used to refuse such a removal because the delete did not know — on the
 * KEPL order that made almost every part impossible to remove, and the one-line
 * Remove really did delete the shared plate.) Removing the LAST part cut to a
 * rectangle does take its cut plate, and the nesting stage then says the layout
 * is out of date.
 *
 * ORDER, AND WHAT A PASTE COPIES
 * Pastes run first, then quantity and flow changes, then removals. So a paste
 * copies what is SAVED — the clipboard's snapshot, not the half-edited screen —
 * and "paste it there, remove it here" is a move. Every source subtree is read
 * before any paste writes, so two pastes in one save never copy each other.
 *
 * ALL OR NOTHING, EVERY PROBLEM AT ONCE
 * Everything that can be checked without writing is checked first and refused
 * together (422, `problems`). Then every change is applied inside its own
 * SAVEPOINT: a refusal only the write path can find is rolled back to that
 * savepoint, collected, and the rest carry on — so those come back together
 * too. Any problem at all rolls the whole batch back to the batch's savepoint
 * before the 422 leaves here, so a caller that keeps its transaction (a test)
 * is left exactly as it was. A frozen structure (closed order, released line,
 * obsolete record) is a 409.
 *
 * DRY RUN
 * The real thing, inside a SAVEPOINT, rolled back. It reports exactly what Save
 * would do — including the codes the copies would get, because the generator
 * really ran and the counters it moved went back with the rollback.
 *
 * ROUND TRIPS (TiDB is ~49 ms a hop away)
 * A deep copy costs a fixed number of round trips for its reads and writes,
 * whatever its size — multi-row INSERTs, ids read back by natural key (TiDB
 * does not hand out AUTO_INCREMENT ids contiguously) — plus the code
 * generator's own per-record cost, which is its business. A paste works its
 * values out straight away, because the copy's codes may need them. Quantity,
 * flow and remove only WRITE, line by line; the values are worked out once at
 * the end for every parent they touched, and each parent's range codes once
 * after that. One quantity deep in the KEPL order re-works the values up to the
 * span — 251 round trips, ~12 s — so ten of them under one girder cost two
 * minutes when each refreshed on its own. Now they are one walk.
 */
import { invalid, notFound, conflict, CfError, translateDbError } from '../lib/errors.js';
import { requireMaster, LOCKED_ORDER_STATUSES, lockedLineMessage, revisedOrderMessage, latestRevisionSql } from './records.js';
import { BOM_TYPE_BY_KIND, descendantIds } from './bomGraph.js';
import { explode, writeLineUpdate, writeLineRemoval, addLine, assertEditable, ALLOWED_CHILDREN } from './bomService.js';
import { refreshValues, setValues } from './valueService.js';
import { requireUsableFlow } from './flowService.js';
import { CUT_PLATE_CODE } from './nestingService.js';
import { insertRows } from '../lib/db.js';
import { snapshotSubtrees, writeCopies, cutPlateNodes, LINE_COLUMNS } from './treeCopyService.js';
import { arrangeBomLines, spaceAfterLine } from './bomOrderService.js';
import { writeLineValues } from './orderValuesService.js';

export const OPS = ['quantity', 'flow', 'role', 'remove', 'paste', 'arrange', 'values'];
const MAX_CHANGES = 1000;
const ID_CHUNK = 500;   // ids per IN list
const FROZEN_CODES = new Set(['OBSOLETE', 'ORDER_CLOSED', 'RELEASED', 'LOCKED']);
const SELECTION_FLOW = 'A selection line takes the flow of the catalog item chosen for it — it has none of its own.';

const blank = (v) => v == null || String(v).trim() === '';
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
const chunk = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const labelOf = (n) => n?.code ?? n?.name ?? `#${n?.id}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const bomTypeOfKind = (kind) => BOM_TYPE_BY_KIND[kind] ?? null;

/** The same rule and the same words as bomService.readQuantity, checked before anything is written. */
function quantityProblem(value) {
  if (blank(value)) return 'Quantity is required.';
  const q = Number(value);
  if (!Number.isFinite(q) || q <= 0) return 'Quantity must be more than zero.';
  if (q >= 1e9) return 'Quantity is too large.';
  return null;
}
const readQuantity = (value) => Number(Number(value).toFixed(6));

/** A 4xx error is something a person can act on; anything else is a fault and propagates. */
const personal = (e) => Number.isInteger(e?.status) && e.status >= 400 && e.status < 500;
const problemsOf = (e) => (Array.isArray(e?.problems) && e.problems.length ? e.problems : [e.message]);

/** assertEditable's refusals, as the 409 the contract promises for a frozen structure. */
async function assertOpen(db, companyId, master, opts = {}) {
  try {
    await assertEditable(db, companyId, master, opts);
  } catch (e) {
    if (e instanceof CfError && FROZEN_CODES.has(e.code)) throw conflict(e.code, e.message);
    throw e;
  }
}

// A name of its own for every savepoint: re-declaring one silently deletes the
// earlier one, and a batch must not be able to eat a caller's (nestingSheet's lesson).
let savepointNo = 0;
const savepointName = (what) => { savepointNo += 1; return `cf_bom_${what}_${savepointNo}`; };

/* ===========================================================================
 * Reading the request and the structure it is about
 * ======================================================================== */

function readScope(scope) {
  const s = scope ?? {};
  const hasRecord = !blank(s.recordId);
  const hasLine = !blank(s.orderLineId);
  if (hasRecord === hasLine) {
    throw invalid('INVALID', 'Say which structure these changes are for — scope.recordId or scope.orderLineId, one of them.');
  }
  const id = posInt(hasRecord ? s.recordId : s.orderLineId);
  if (!id) throw invalid('INVALID', `${hasRecord ? 'scope.recordId' : 'scope.orderLineId'} must be a positive whole number.`);
  return hasRecord ? { recordId: id } : { orderLineId: id };
}

/** Each change in a single shape, with the problems its shape alone has. */
function readChanges(raw, problems) {
  if (!Array.isArray(raw)) throw invalid('INVALID', '`changes` must be a list.');
  if (raw.length > MAX_CHANGES) throw invalid('TOO_BIG', `More than ${MAX_CHANGES} changes is more than one save will take.`);
  const out = [];
  raw.forEach((ch, index) => {
    const where = `Change ${index + 1}`;
    const op = ch?.op;
    if (!OPS.includes(op)) { problems.push(`${where}: "${op ?? ''}" is not a change this screen makes (${OPS.join(', ')}).`); return; }
    const c = { index, op };
    const needId = (key) => {
      const v = posInt(ch[key]);
      if (!v) problems.push(`${where}: ${key} must be a positive whole number.`);
      return v;
    };
    if (op === 'values') {
      if (!Array.isArray(ch.writes)) { problems.push(`${where}: values need a list of writes.`); return; }
      if (ch.writes.length > 20000 || ch.writes.some((w) => !posInt(w?.recordId) || typeof w.specCode !== 'string' || !w.specCode.trim())) { problems.push(`${where}: each value needs a record and specification code.`); return; }
      c.writes = ch.writes;
    } else if (op === 'arrange') {
      if (!Array.isArray(ch.groups) || !ch.groups.length || ch.groups.length > MAX_CHANGES) { problems.push(`${where}: give the parent rows to arrange.`); return; }
      c.groups = ch.groups.map((g) => ({ parentId: posInt(g?.parentId), lineIds: g?.lineIds }));
      if (c.groups.some((g) => !g.parentId || !Array.isArray(g.lineIds) || g.lineIds.length > 20000 || g.lineIds.some((id) => !posInt(id) && !(typeof id === 'string' && /^copy-[A-Za-z0-9_-]+$/.test(id))))) {
        problems.push(`${where}: row order needs valid line IDs or copy keys.`); return;
      }
    } else if (op === 'paste') {
      c.sourceLineId = needId('sourceLineId');
      c.key = ch.key == null ? null : String(ch.key);
      if (c.key != null && !/^copy-[A-Za-z0-9_-]+$/.test(c.key)) { problems.push(`${where}: invalid copy key.`); return; }
      c.parentId = needId('parentId');
      c.afterLineId = blank(ch.afterLineId) ? null : needId('afterLineId');
      c.quantity = blank(ch.quantity) ? null : ch.quantity;
      // What the screen showed the copy as (a description edited but not yet saved on its source); absent = the source's own.
      if (ch.role !== undefined) c.role = ch.role == null ? null : String(ch.role).trim().slice(0, 100) || null;
      if (!c.sourceLineId || !c.parentId || (!blank(ch.afterLineId) && !c.afterLineId)) return;
    } else {
      c.lineId = needId('lineId');
      if (!c.lineId) return;
      if (op === 'quantity') c.quantity = ch.quantity;
      if (op === 'role') {
        // The row's description (the text after the dot). Empty clears it.
        if (ch.role === undefined) { problems.push(`${where}: say the description — role, or null to clear it.`); return; }
        c.role = ch.role;
      }
      if (op === 'flow') {
        if (ch.flowId === undefined) { problems.push(`${where}: say which flow — flowId, or null to go back to the usual one.`); return; }
        c.flowId = blank(ch.flowId) ? null : posInt(ch.flowId);
        if (!blank(ch.flowId) && !c.flowId) { problems.push(`${where}: flowId must be a positive whole number, or null.`); return; }
      }
    }
    out.push(c);
  });
  return out;
}

async function requireOrderLine(db, companyId, lineId) {
  const [[row]] = await db.query(
    `SELECT ol.id, ol.line_no, ol.line_type, ol.item_id, ol.quantity, ol.locked_at,
            o.id AS order_id, o.code AS order_code, o.status AS order_status,
            o.revision AS order_revision, ${latestRevisionSql('o')} AS order_latest_revision,
            (SELECT r.id FROM cf_production_releases r WHERE r.order_line_id = ol.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_sales_order_lines ol
       JOIN cf_sales_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
      WHERE ol.company_id = ? AND ol.id = ? AND ol.deleted_at IS NULL`,
    [companyId, lineId],
  );
  if (!row) throw notFound('Order line');
  if (!row.item_id) throw invalid('NO_ITEM', 'This line has no item yet — there is no structure to change.');
  return row;
}

/** The tree under the scope, indexed by line and by record. */
function indexTree(root) {
  const lines = new Map();    // lineId -> { node, parent, places }
  const byRecord = new Map(); // record id -> [{ node, parent }]
  const walk = (node, parent) => {
    if (node.lineId != null) {
      const e = lines.get(node.lineId);
      if (e) e.places += 1;
      else lines.set(node.lineId, { node, parent, places: 1 });
    }
    if (!byRecord.has(node.id)) byRecord.set(node.id, []);
    byRecord.get(node.id).push({ node, parent });
    for (const kid of node.children) walk(kid, node);
  };
  walk(root, null);
  return { lines, byRecord };
}

/** Every node key in the subtree under (and including) a node. */
function subtreeKeys(node, into = new Set()) {
  into.add(node.key);
  for (const kid of node.children) subtreeKeys(kid, into);
  return into;
}

/* ===========================================================================
 * The entry point
 * ======================================================================== */

/**
 * Applies (or, with dryRun, rehearses) a batch of changes. Needs a transaction:
 * it is handed the caller's connection and uses savepoints on it.
 *
 *   opts.allow(bomType)  called once for each BOM type whose lines the batch
 *                        touches ('custom' | 'template' | 'standard'); the route
 *                        throws 403 from it when the grant is missing.
 *   opts.cutPlateCode    the classification code cut plates are filed under
 *                        (CUT_PLATE, as cutPlateService files them). Only a
 *                        test that owns its own classification passes another.
 */
export async function applyBomChanges(db, c, input = {}, opts = {}) {
  const allow = opts.allow ?? (() => {});
  const cutPlateCode = opts.cutPlateCode ?? CUT_PLATE_CODE;
  const dryRun = input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1;
  const scope = readScope(input.scope);
  const shapeProblems = [];
  const changes = readChanges(input.changes, shapeProblems);
  const companyId = c.companyId;

  // ---- the structure the screen showed ------------------------------------
  let root;
  let rootQuantity = 1;
  let line = null;
  if (scope.orderLineId) {
    line = await requireOrderLine(db, companyId, scope.orderLineId);
    root = await requireMaster(db, companyId, line.item_id);
    rootQuantity = Number(line.quantity);
  } else {
    root = await requireMaster(db, companyId, scope.recordId);
  }
  const tree = await explode(db, companyId, root.id, { rootQuantity });
  const { lines, byRecord } = indexTree(tree.root);

  // Whose lines this screen may change — BomPanel's `mine`, exactly: the
  // record's own BOM on its own tab, and an order's own temporary items.
  const holds = (node) => !!node && !!bomTypeOfKind(node.kind)
    && (node.kind === 'temporary' || (scope.recordId != null && node.depth === 0));
  // Why a record's lines are not this screen's to change — BomPanel's wording.
  const notHere = (parent) => {
    const p = labelOf(parent);
    if (parent.depth === 0 && scope.orderLineId && parent.kind === 'catalog') {
      return `${p}’s Standard BOM is shared by every order that sells it — change it on the item itself`;
    }
    if (parent.kind === 'catalog') return `${p}’s Standard BOM is shared by everything that uses ${p} — change it on ${p} itself`;
    if (parent.kind === 'template') return `${p}’s Template BOM is changed on the template itself`;
    if (!bomTypeOfKind(parent.kind)) return `${p} is a selection, which holds no BOM`;
    return `${p} belongs to another structure`;
  };
  // A row of an order has no code (its pieces are coded at LOCK), and two
  // segments both hold a "Flange plate" — so a problem names a row by where it
  // sits: the names down from the nearest thing with a code, each with its line
  // number as the tree shows it. "Girder › 10 Girder segment › 20 Flange plate".
  const pathLabel = (node) => {
    const parts = [];
    let n = node;
    for (let hops = 0; n && hops < 30; hops++) {
      if (n.code) { parts.unshift(n.code); break; }
      parts.unshift(n.lineNo != null ? `${n.lineNo} ${n.name}` : n.name);
      n = n.lineId != null ? lines.get(n.lineId)?.parent ?? null : null;
    }
    return parts.join(' › ');
  };
  const lineLabel = (e) => pathLabel(e.node);

  // ---- who may do this, and whether anything may change at all ------------
  const touched = new Set();
  for (const ch of changes) {
    if (ch.op === 'values') { touched.add(scope.orderLineId ? 'custom' : 'standard'); continue; }
    if (ch.op === 'arrange') {
      for (const g of ch.groups) {
        const t = byRecord.get(g.parentId)?.[0]?.node;
        if (holds(t)) touched.add(bomTypeOfKind(t.kind));
      }
      continue;
    }
    const e = ch.op === 'paste' ? null : lines.get(ch.lineId);
    if (e && holds(e.parent)) touched.add(bomTypeOfKind(e.parent.kind));
    if (ch.op === 'paste') {
      const t = byRecord.get(ch.parentId)?.[0]?.node;
      if (holds(t)) touched.add(bomTypeOfKind(t.kind));
    }
  }
  for (const bomType of touched) allow(bomType);

  // A batch of nothing but flow changes — the one kind a locked line still takes.
  const flowOnly = changes.length > 0 && changes.every((ch) => ch.op === 'flow');
  if (line) {
    if (LOCKED_ORDER_STATUSES.has(line.order_status)) {
      throw conflict('ORDER_CLOSED', line.order_status === 'revised' ? revisedOrderMessage(line.order_code, line.order_revision, line.order_latest_revision)
        : `Order ${line.order_code} is ${line.order_status} — its structure can no longer change.`);
    }
    if (line.release_id) {
      throw conflict('RELEASED', `Line ${line.line_no} of ${line.order_code} was released to production — its structure is frozen. Take the release back, while nothing has started, to change it.`);
    }
    // Only flows still change on a locked line, until it is released (records.flowStillOpen).
    if (line.locked_at && !flowOnly) throw conflict('LOCKED', lockedLineMessage(line.line_no, line.order_code));
  }
  await assertOpen(db, companyId, root, { flowOnly });

  // ---- everything that can be checked without writing ---------------------
  const problems = [...shapeProblems];
  const seen = { quantity: new Set(), flow: new Set(), role: new Set(), remove: new Set() };
  const flowIds = new Map(); // flow id -> [labels]
  const pastes = [];
  const updates = [];
  const removes = [];
  const arrangements = [];
  const valueChanges = [];
  const copyKeys = new Set();

  for (const ch of changes) {
    if (ch.op === 'values') {
      if (!scope.orderLineId && ch.writes.some((w) => {
        const id = Number(w.recordId), node = byRecord.get(id)?.[0]?.node;
        return id !== root.id && node?.kind !== 'temporary';
      })) problems.push('Shared child values are read-only here. Open that item or definition to change its values.');
      if (valueChanges.length) problems.push('Give the value changes once.');
      valueChanges.push(ch); continue;
    }
    if (ch.op === 'arrange') {
      if (arrangements.length) problems.push('Give the new row arrangement once.');
      for (const g of ch.groups) {
        const t = byRecord.get(g.parentId)?.[0]?.node;
        if (!holds(t)) problems.push('A destination cannot be rearranged from this screen.');
      }
      arrangements.push(ch); continue;
    }
    if (ch.op === 'paste') {
      if (ch.key && copyKeys.has(ch.key)) problems.push('Each new copy needs its own key.');
      if (ch.key) copyKeys.add(ch.key);
      pastes.push(ch); continue;
    }
    const e = lines.get(ch.lineId);
    if (!e) {
      problems.push(`Line ${ch.lineId} is not part of this structure — it may have changed since the screen was opened. Reload it and make the change again.`);
      continue;
    }
    ch.entry = e;
    const label = lineLabel(e);
    if (!holds(e.parent)) { problems.push(`${label} cannot change here — ${notHere(e.parent)}.`); continue; }
    if (e.parent.status === 'obsolete') { problems.push(`${label}: ${pathLabel(e.parent)} is obsolete — reactivate it to change its BOM.`); continue; }
    if (seen[ch.op].has(ch.lineId)) { problems.push(`${label} is given more than one ${ch.op === 'remove' ? 'removal' : ch.op} — say it once.`); continue; }
    seen[ch.op].add(ch.lineId);
    if (ch.op === 'quantity') {
      const p = quantityProblem(ch.quantity);
      if (p) { problems.push(`${label}: ${p}`); continue; }
      ch.quantity = readQuantity(ch.quantity);
      updates.push(ch);
    } else if (ch.op === 'role') {
      // A description is part of what the row IS on its locked line, so it is
      // frozen with the rest at LOCK (only flows stay open) — assertOpen above
      // refuses it there. It never changes a code or a value.
      const found = [];
      const role = readRoleText(ch.role, found);
      if (found.length) { for (const f of found) problems.push(`${label}: ${f}`); continue; }
      ch.role = role;
      updates.push(ch);
    } else if (ch.op === 'flow') {
      if (ch.flowId != null && (e.node.selection || e.node.kind === 'selection')) { problems.push(`${label}: ${SELECTION_FLOW}`); continue; }
      if (ch.flowId != null) {
        if (!flowIds.has(ch.flowId)) flowIds.set(ch.flowId, []);
        flowIds.get(ch.flowId).push(label);
      }
      updates.push(ch);
    } else {
      removes.push(ch);
    }
  }

  // Flows named by the batch: one read each, the same rule the mutator applies.
  for (const [flowId, labels] of flowIds) {
    const found = [];
    await requireUsableFlow(db, companyId, flowId, found);
    for (const p of found) for (const l of labels) problems.push(`${l}: ${p}`);
  }

  // What goes, place by place: a removed line and everything drawn below it.
  const doomed = new Set();
  for (const ch of removes) subtreeKeys(ch.entry.node, doomed);
  const removedKeys = new Set(removes.map((ch) => ch.entry.node.key));

  for (const ch of updates) {
    const e = ch.entry;
    if (!doomed.has(e.node.key)) continue;
    problems.push(removedKeys.has(e.node.key)
      ? `${lineLabel(e)} is changed and removed in the same save — take one of them out.`
      : `${lineLabel(e)} is changed, but it also goes when a line above it is removed — take the change out, or keep the line above.`);
  }

  // Pastes: the source, where it goes, and whether it may go there.
  const sourceIds = [...new Set(pastes.map((p) => p.sourceLineId).filter((id) => lines.has(id)))];
  const sourceRows = new Map();
  for (const part of chunk(sourceIds, ID_CHUNK)) {
    const [rows] = await db.query(
      `SELECT l.id, l.bom_id, l.line_no, l.child_id, l.design_id, l.position, l.role, l.quantity,
              l.selection_definition_id, l.source_line_id, l.operation_flow_id, l.notes, l.auto_chosen,
              ci.item_type AS child_item_type, cm.classification_id AS child_classification_id,
              cm.name AS child_name
         FROM cf_bom_lines l
         JOIN cf_master_records cm ON cm.id = l.child_id
         LEFT JOIN cf_item_details ci ON ci.master_id = l.child_id AND ci.deleted_at IS NULL
        WHERE l.company_id = ? AND l.id IN (?) AND l.deleted_at IS NULL`,
      [companyId, part],
    );
    for (const r of rows) sourceRows.set(r.id, r);
  }
  const cutPlates = pastes.length ? await cutPlateNodes(db, companyId, cutPlateCode) : new Set();
  // Temporary items a copy makes afresh: every one except a cut plate, which is shared.
  const copies = (row) => row.child_item_type === 'temporary' && !cutPlates.has(row.child_classification_id);

  for (const ch of pastes) {
    const src = lines.get(ch.sourceLineId);
    const place = byRecord.get(ch.parentId);
    if (!src || !sourceRows.has(ch.sourceLineId)) {
      problems.push(`Line ${ch.sourceLineId}, copied to be pasted, is not part of this structure any more — reload it and copy it again.`);
      continue;
    }
    const what = lineLabel(src);
    if (!place) { problems.push(`${what} cannot be pasted there — record ${ch.parentId} is not part of this structure.`); continue; }
    const target = place[0].node;
    const into = pathLabel(target);
    if (!holds(target)) { problems.push(`${what} cannot be pasted into ${into} — ${notHere(target)}.`); continue; }
    if (target.status === 'obsolete') { problems.push(`${what} cannot be pasted into ${into}: it is obsolete — reactivate it to change its BOM.`); continue; }
    if (doomed.has(target.key)) { problems.push(`${what} is pasted into ${into}, which this save removes — paste it somewhere that stays.`); continue; }
    if (ch.quantity != null) {
      const p = quantityProblem(ch.quantity);
      if (p) { problems.push(`${what}, pasted into ${into}: ${p}`); continue; }
      ch.quantity = readQuantity(ch.quantity);
    }
    if (ch.afterLineId != null) {
      const anchor = lines.get(ch.afterLineId);
      if (!anchor || anchor.parent?.key !== target.key) {
        problems.push(`${what}: line ${ch.afterLineId}, which it should follow, is not a line of ${into}.`);
        continue;
      }
    }
    const targetType = bomTypeOfKind(target.kind);
    const kind = src.node.kind;
    const row = sourceRows.get(ch.sourceLineId);
    ch.source = { entry: src, row };
    ch.target = target;
    if (targetType === 'custom') {
      if (kind === 'template') {
        problems.push(`${what} is a template line — on an order it is laid out as rows. Add the template to ${into} with Add line instead.`);
        continue;
      }
      ch.mode = copies(row) ? 'copy' : 'line';
      if (ch.mode === 'copy') {
        // A copy of X cannot go inside X — the loop bomService refuses, asked the same way.
        if (target.id === row.child_id) { problems.push(`${what} cannot be pasted into itself.`); continue; }
        if ((await descendantIds(db, companyId, row.child_id)).has(target.id)) {
          problems.push(`${what} cannot be pasted into ${into}, which is inside ${what} — a thing cannot go under itself.`);
          continue;
        }
      }
    } else {
      // A Template or Standard BOM holds definitions: another line to the SAME child.
      ch.mode = 'reference';
      if (!ALLOWED_CHILDREN[targetType].includes(kind)) {
        problems.push(targetType === 'standard'
          ? `${what} cannot go into ${into}: a Standard BOM holds catalog items only.`
          : `${what} cannot go into ${into}: a Template BOM holds catalog items and definitions — an order’s rows belong to that order.`);
        continue;
      }
      if (src.node.status === 'obsolete') { problems.push(`${what} is obsolete, so it cannot be pasted into ${into}.`); continue; }
      if (target.id === row.child_id) { problems.push(`${what} cannot be pasted into itself.`); continue; }
      if ((await descendantIds(db, companyId, row.child_id)).has(target.id)) {
        problems.push(`${what} cannot be pasted into ${into} — ${what} already contains ${into} further down, and a thing cannot go under itself.`);
        continue;
      }
      if (row.operation_flow_id) {
        const found = [];
        await requireUsableFlow(db, companyId, row.operation_flow_id, found);
        for (const p of found) problems.push(`${what}, pasted into ${into}: its flow — ${p}`);
      }
    }
  }

  if (problems.length) {
    throw invalid('INVALID', `${dryRun ? 'These changes cannot be saved' : 'Nothing was saved'} — ${plural(problems.length, 'problem', 'problems')} to fix first.`, { problems });
  }

  // ---- apply, inside a savepoint the whole batch can go back to ------------
  const batch = savepointName('batch');
  await db.query(`SAVEPOINT ${batch}`);
  const applyProblems = [];
  const results = new Array(changes.length).fill(null);
  try {
    const attempt = async (label, fn) => {
      const sp = savepointName('change');
      await db.query(`SAVEPOINT ${sp}`);
      try {
        return { ok: true, out: await fn() };
      } catch (raw) {
        const e = translateDbError(raw);
        if (!personal(e)) throw raw;
        await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        for (const p of problemsOf(e)) applyProblems.push(`${label}: ${p}`);
        return { ok: false };
      }
    };

    // Values first: a one-click duplicate carries the values currently typed
    // on this screen. The enclosing savepoint also rolls these back if a move
    // or any other part of the same save is refused.
    for (const ch of valueChanges) {
      const r = await attempt('Specification values', async () => {
        if (scope.orderLineId) return writeLineValues(db, c, scope.orderLineId, { writes: ch.writes });
        if (root.owner_order_line_id) return writeLineValues(db, c, root.owner_order_line_id, { writes: ch.writes });
        const out = await setValues(db, c, 'master', root.id, ch.writes);
        return { summary: { changed: out.changes.length, records: out.changes.length ? 1 : 0 } };
      });
      if (r.ok) results[ch.index] = { op: 'values', changed: r.out.summary.changed, records: r.out.summary.records };
    }

    // 1. Pastes, from what is saved. Every copied subtree is read before any
    //    paste writes, so no paste can copy another's result.
    const snap = await snapshotSubtrees(db, companyId, pastes.filter((p) => p.mode === 'copy').map((p) => p.source.row.child_id), copies);
    const lastPasteAfter = new Map(); // anchor line id -> the line pasted after it last, so A then B stay in order
    const newLines = new Map();
    for (const ch of pastes) {
      const src = ch.source.entry;
      const label = `${lineLabel(src)}, pasted into ${pathLabel(ch.target)}`;
      const r = await attempt(label, async () => {
        const after = ch.afterLineId == null ? null : (lastPasteAfter.get(ch.afterLineId) ?? ch.afterLineId);
        const out = ch.mode === 'reference'
          ? await pasteReference(db, c, ch, after)
          : await copyInto(db, c, snap, ch, after);
        if (ch.afterLineId != null) lastPasteAfter.set(ch.afterLineId, out.lineId);
        return out;
      });
      if (r.ok) {
        if (ch.key) newLines.set(ch.key, r.out.lineId);
        results[ch.index] = {
          op: 'paste', sourceLineId: ch.sourceLineId, parentId: ch.parentId, mode: ch.mode,
          lineId: dryRun ? null : r.out.lineId,
          quantity: ch.quantity ?? Number(ch.source.row.quantity),
          created: r.out.items.length,
          items: r.out.items.map((it) => ({ id: dryRun ? null : it.id, code: it.code, name: it.name, depth: it.depth })),
          notes: r.out.notes,
        };
      }
    }

    // Parents whose values the writes below moved — worked out ONCE, in step 4.
    const valueParents = new Set();

    // 2. Quantity and flow — one write per line; the refresh waits for step 4.
    const byLine = new Map();
    for (const ch of updates) {
      if (!byLine.has(ch.lineId)) byLine.set(ch.lineId, []);
      byLine.get(ch.lineId).push(ch);
    }
    for (const [lineId, chs] of byLine) {
      const e = chs[0].entry;
      const savedFlow = e.node.flow?.from === 'line' ? e.node.flow.id : null;
      const sets = {};
      for (const ch of chs) {
        if (ch.op === 'quantity' && !near(ch.quantity, e.node.quantity)) sets.quantity = ch.quantity;
        if (ch.op === 'flow' && (ch.flowId ?? null) !== savedFlow) sets.operationFlowId = ch.flowId;
        if (ch.op === 'role' && ch.role !== (e.node.role ?? null)) sets.role = ch.role;
      }
      let ok = true;
      if (Object.keys(sets).length) {
        const r = await attempt(lineLabel(e), () => writeLineUpdate(db, c, lineId, sets));
        ok = r.ok;
        if (ok && r.out.values) valueParents.add(r.out.parentId);
      }
      if (!ok) continue;
      for (const ch of chs) {
        results[ch.index] = ch.op === 'role'
          ? { op: 'role', lineId, from: e.node.role ?? null, to: ch.role, changed: sets.role !== undefined }
          : ch.op === 'quantity'
            ? { op: 'quantity', lineId, from: Number(e.node.quantity), to: ch.quantity, changed: sets.quantity !== undefined }
            : { op: 'flow', lineId, from: savedFlow, to: ch.flowId ?? null, changed: sets.operationFlowId !== undefined };
      }
    }

    // 3. Removals, shallowest first: a parent takes its subtree with it, so a
    //    deeper removal may already be gone by the time its turn comes.
    for (const ch of [...removes].sort((a, b) => a.entry.node.depth - b.entry.node.depth)) {
      const e = ch.entry;
      const [[still]] = await db.query('SELECT id FROM cf_bom_lines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, ch.lineId]);
      const beneath = subtreeKeys(e.node).size - 1;
      if (!still) {
        results[ch.index] = { op: 'remove', lineId: ch.lineId, beneath, withParent: true };
        continue;
      }
      const r = await attempt(lineLabel(e), () => writeLineRemoval(db, c, ch.lineId));
      if (r.ok) {
        valueParents.add(r.out.parentId);
        results[ch.index] = { op: 'remove', lineId: ch.lineId, beneath, withParent: false };
      }
    }

    // Arrange after copies/removals, so a new on-screen copy can be dragged
    // before its real line ID exists. Moving keeps the same row and subtree.
    for (const ch of arrangements) {
      const r = await attempt('Rearranging rows', async () => {
        const groups = ch.groups.map((g) => ({ parentId: g.parentId, lineIds: g.lineIds.map((id) => typeof id === 'string' && id.startsWith('copy-') ? newLines.get(id) : Number(id)) }));
        if (groups.some((g) => g.lineIds.some((id) => !id))) throw invalid('ARRANGEMENT', 'A copied row could not be found. Reload and try again.');
        const fresh = await explode(db, companyId, root.id, { rootQuantity });
        const out = await arrangeBomLines(db, c, groups, fresh.root);
        out.refresh.forEach((id) => valueParents.add(id));
        return out;
      });
      if (r.ok) results[ch.index] = { op: 'arrange', moved: r.out.moved, reordered: r.out.reordered };
    }

    // 4. Values, once for every parent the writes above moved. A parent that
    //    went with a line removed above it is gone, and is not worked out.
    if (valueParents.size) {
      const [alive] = await db.query('SELECT id FROM cf_master_records WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [companyId, [...valueParents]]);
      if (alive.length) await attempt('Working the values out again', () => refreshValues(db, c, alive.map((a) => a.id)));
    }

    if (applyProblems.length) {
      throw invalid('INVALID', `${dryRun ? 'These changes cannot be saved' : 'Nothing was saved'} — ${plural(applyProblems.length, 'problem', 'problems')} to fix first.`, { problems: applyProblems });
    }
    if (dryRun) await db.query(`ROLLBACK TO SAVEPOINT ${batch}`);
  } catch (e) {
    // Whatever went wrong, the batch leaves nothing behind in the caller's transaction.
    try { await db.query(`ROLLBACK TO SAVEPOINT ${batch}`); } catch { /* the original error is the one that matters */ }
    throw e;
  }

  const counts = countsOf(results, removes, doomed, removedKeys);
  return { applied: !dryRun, dryRun, summary: { sentence: sentenceOf(counts), counts }, results };
}

/* ===========================================================================
 * The summary
 * ======================================================================== */

function countsOf(results, removes, doomed, removedKeys) {
  const done = results.filter(Boolean);
  const pasted = done.filter((r) => r.op === 'paste');
  return {
    quantity: done.filter((r) => r.op === 'quantity' && r.changed).length,
    flow: done.filter((r) => r.op === 'flow' && r.changed).length,
    role: done.filter((r) => r.op === 'role' && r.changed).length,
    rearranged: done.filter((r) => r.op === 'arrange').reduce((n, r) => n + r.reordered, 0),
    moved: done.filter((r) => r.op === 'arrange').reduce((n, r) => n + r.moved, 0),
    values: done.filter((r) => r.op === 'values').reduce((n, r) => n + r.changed, 0),
    pasted: pasted.length,
    copiedItems: pasted.reduce((n, r) => n + r.created, 0),
    removed: done.filter((r) => r.op === 'remove' && !r.withParent).length,
    // Rows drawn below a removed line that are not removed in their own right.
    removedBeneath: [...doomed].filter((k) => !removedKeys.has(k)).length,
    unchanged: done.filter((r) => (r.op === 'quantity' || r.op === 'flow' || r.op === 'role') && !r.changed).length,
    changes: results.length,
  };
}

function sentenceOf(k) {
  const bits = [];
  if (k.quantity) bits.push(plural(k.quantity, 'quantity changed', 'quantities changed'));
  if (k.flow) bits.push(plural(k.flow, 'flow changed', 'flows changed'));
  if (k.role) bits.push(plural(k.role, 'description changed', 'descriptions changed'));
  if (k.rearranged) bits.push(plural(k.rearranged, 'BOM rearranged', 'BOMs rearranged'));
  if (k.moved) bits.push(plural(k.moved, 'row moved to another parent', 'rows moved to another parent'));
  if (k.values) bits.push(plural(k.values, 'value changed', 'values changed'));
  if (k.pasted) {
    bits.push(`${plural(k.pasted, 'line pasted', 'lines pasted')}${k.copiedItems ? ` (${plural(k.copiedItems, 'new row', 'new rows')})` : ''}`);
  }
  if (k.removed) bits.push(plural(k.removed, 'line removed', 'lines removed'));
  // The number somebody has to see before they agree to a removal.
  if (k.removedBeneath) bits.push(`${plural(k.removedBeneath, 'row', 'rows')} beneath ${k.removed === 1 ? 'it' : 'them'} going too`);
  return bits.length ? bits.join(', ') : 'nothing to change';
}

/* ===========================================================================
 * Paste into a Template or Standard BOM: bomService.addLine, to the same child
 * ======================================================================== */

/** The text of a description, or null when empty; problems go in `problems`. */
function readRoleText(value, problems) {
  if (value == null || String(value).trim() === '') return null;
  const t = String(value).trim();
  if (t.length > 100) problems.push('A description is up to 100 characters.');
  return t;
}

/** A copy keeps its source's description exactly (user, 2026-10-02: no "(copy)" suffix). Nothing to say when there is none. */
function copyRole(role) {
  if (role == null || String(role).trim() === '') return null;
  return String(role).trim().slice(0, 100);
}

async function pasteReference(db, c, ch, afterLineId) {
  const row = ch.source.row;
  const input = {
    childId: row.child_id,
    quantity: ch.quantity ?? Number(row.quantity),
    role: row.role,
    notes: row.notes,
    operationFlowId: row.operation_flow_id,
  };
  if (afterLineId != null) input.lineNo = await lineNoAfter(db, c.companyId, ch.target, null, afterLineId);
  await addLine(db, c, ch.target.id, input);
  // addLine gives a Standard or Template line design = child and the next
  // position for it (bomGraph.nextPosition, deleted lines counted), so the new
  // line is the one with the highest position for that design in this BOM —
  // (bom, design, position) is unique, whatever id the engine handed out.
  const [[fresh]] = await db.query(
    `SELECT l.id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
      WHERE b.company_id = ? AND b.parent_id = ? AND l.design_id = ? AND l.deleted_at IS NULL
      ORDER BY l.position DESC LIMIT 1`,
    [c.companyId, ch.target.id, row.child_id],
  );
  return { lineId: fresh?.id ?? null, items: [], notes: [] };
}

/** A line number between an anchor and the line after it, or a refusal when there is no gap. */
async function lineNoAfter(db, companyId, target, bomId, afterLineId) {
  const [ls] = await db.query(
    `SELECT l.id, l.bom_id, l.line_no FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
      WHERE l.company_id = ? AND ${bomId ? 'l.bom_id = ?' : 'b.parent_id = ?'} AND l.deleted_at IS NULL
      ORDER BY l.line_no, l.id`,
    [companyId, bomId ?? target.id],
  );
  const i = ls.findIndex((l) => l.id === afterLineId);
  if (i < 0) throw invalid('NO_ANCHOR', `The line it should follow is no longer in ${labelOf(target)}.`);
  const here = Number(ls[i].line_no);
  if (i === ls.length - 1) return here + 10;
  const next = Number(ls[i + 1].line_no);
  const mid = Math.floor((here + next) / 2);
  if (mid <= here) return spaceAfterLine(db, companyId, ls[i].bom_id, ls, i);
  return mid;
}

/* ===========================================================================
 * Paste into a Custom BOM: a deep copy of the order's own temporary items
 * ======================================================================== */

/**
 * One paste into a Custom BOM. The top line goes into the target's BOM; when it
 * holds a temporary item, that item and every temporary item below it are
 * created afresh, in a fixed number of statements:
 *
 *   lock the target's BOM, read its line numbers and the next position   3
 *   INSERT every item (placeholder codes), read their ids back            2
 *   INSERT their detail rows, their BOMs, read the BOM ids back           3
 *   INSERT every line                                                     1
 *   INSERT every value, read the ids back, INSERT the history rows        3
 *   INSERT their own rules, read them back, INSERT the option lists       0-3
 *
 * (one more of each per 200 rows). Then the values around it are re-worked
 * and each new item's code is generated, a level at a time.
 *
 * WHY PLACEHOLDER CODES
 * A multi-row INSERT reports only its first id, and TiDB does not hand out
 * AUTO_INCREMENT ids contiguously (valueService explains), so the new ids are
 * read back by a natural key — and a brand-new temporary item has none: its
 * code is empty and its name repeats. So each is born with a placeholder code
 * unique to this paste, read back by it, and every placeholder is overwritten
 * with the generated code, or emptied, before the paste returns. The
 * placeholder never leaves the transaction.
 */
async function copyInto(db, c, snap, ch, afterLineId) {
  const companyId = c.companyId;
  const row = ch.source.row;
  const target = await requireMaster(db, companyId, ch.target.id);
  await assertOpen(db, companyId, target);

  // The target's BOM, created if it has none, and held for the rest of the
  // transaction — two pastes into one BOM must not take the same position.
  let [[bom]] = await db.query(
    'SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL FOR UPDATE',
    [companyId, target.id],
  );
  if (!bom) {
    const [b] = await db.query(
      "INSERT INTO cf_boms (company_id, parent_id, bom_type, status, created_by) VALUES (?, ?, 'custom', 'draft', ?)",
      [companyId, target.id, c.userId],
    );
    bom = { id: b.insertId };
  }
  const lineNo = afterLineId != null
    ? await lineNoAfter(db, companyId, ch.target, bom.id, afterLineId)
    : (Number((await db.query('SELECT MAX(line_no) AS top FROM cf_bom_lines WHERE company_id = ? AND bom_id = ? AND deleted_at IS NULL', [companyId, bom.id]))[0][0].top) || 0) + 10;
  // Counts deleted lines too, like bomGraph.nextPosition: a position is never reused.
  const [[{ top: topPos }]] = await db.query(
    'SELECT MAX(position) AS top FROM cf_bom_lines WHERE company_id = ? AND bom_id = ? AND design_id = ?',
    [companyId, bom.id, row.design_id],
  );
  const position = (Number(topPos) || 0) + 1;
  const quantity = ch.quantity ?? Number(row.quantity);


  // ---- the copies: every row below the top one, written by the shared copy ---
  // (treeCopyService.writeCopies — the same machine a revision copies with).
  // A line to a cut plate is written pointing at the SAME cut plate: a copied
  // part is one more part of that rectangle, never a second blank for it.
  let idMap = new Map();
  let levels = [];
  const sharedPlates = new Set(); // cut plates the copy points at rather than duplicates
  if (ch.mode === 'line' && row.child_item_type === 'temporary') sharedPlates.add(labelOf(ch.source.entry.node));
  if (ch.mode === 'copy') {
    const out = await writeCopies(db, c, snap, [{ srcId: row.child_id, ownerLineId: target.owner_order_line_id }]);
    if (!out.levels.length) throw invalid('NOT_FOUND', `${labelOf(ch.source.entry.node)} could not be read to copy it.`);
    ({ idMap, levels } = out);
    for (const label of out.shared) sharedPlates.add(label);
  }

  // ---- the top line, into the target's BOM ----------------------------------
  const topChild = ch.mode === 'copy' ? idMap.get(row.child_id) : row.child_id;
  await insertRows(db, 'cf_bom_lines', LINE_COLUMNS, [[companyId, bom.id, lineNo, topChild, row.design_id, position, ch.role !== undefined ? ch.role : copyRole(row.role), quantity,
    row.selection_definition_id, row.source_line_id, row.operation_flow_id, row.notes, c.userId, row.auto_chosen ?? null]]);
  const [[top]] = await db.query(
    'SELECT id FROM cf_bom_lines WHERE company_id = ? AND bom_id = ? AND design_id = ? AND position = ?',
    [companyId, bom.id, row.design_id, position],
  );

  // ---- values around it: the copy may inherit from its new parent, and the
  //      new parent rolls the copy up. Everything below the copy holds exactly
  //      what its original holds, so the walk only goes further if the top moved.
  await refreshValues(db, c, ch.mode === 'copy' ? [topChild, target.id] : [target.id]);

  // ---- no codes: a row is a design, its pieces get their codes at LOCK --------
  // (user, 2026-09-26). writeCopies already emptied the placeholder codes.
  const items = [];
  const notes = [];
  if (sharedPlates.size) {
    notes.push(`Shares ${plural(sharedPlates.size, 'cut plate', 'cut plates')} with the original (${[...sharedPlates].slice(0, 3).join(', ')}${sharedPlates.size > 3 ? ', …' : ''}) — a cut plate belongs to its rectangle on this line, not to one part.`);
  }
  for (const [depth, level] of levels.entries()) {
    for (const srcId of level) items.push({ id: idMap.get(srcId), code: null, name: snap.items.get(srcId).name, depth });
  }
  return { lineId: top?.id ?? null, items, notes };
}
