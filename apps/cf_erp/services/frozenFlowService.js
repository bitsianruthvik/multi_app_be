/**
 * frozenFlowService.js — a frozen order line reads its OWN copy of every flow it uses (init.sql §60).
 *
 * User, 2026-10-12: "Once the order passes through freeze design nothing should change. Before
 * that it can change." Until then a locked but unreleased line read the shared catalog flow by id,
 * so a step added in the catalog changed the order's Times grid, its work-order cells, its plan and,
 * at release, its production steps.
 *
 * THE RULE. Locking a line copies every flow its structure names — header, steps, links and wait
 * rules — into flows that belong to the line (cf_operation_flows.owner_order_line_id). From then on
 * everything that reads "the steps of this row's flow" for that line reads the copy.
 *
 * BY MAPPING, NEVER BY REPOINTING. A row's pointer (cf_bom_lines.operation_flow_id, or its item's
 * cf_master_records.default_flow_id) keeps naming the CATALOG flow; the copy is found by
 * (owner_order_line_id, source_flow_id). Three things follow, and all three are wanted:
 *   - a catalog item made inside the line is frozen too, though its pointer is shared with the
 *     catalog and could never be repointed;
 *   - a new revision of the order, and a pasted row, copy the pointers as they are and so read the
 *     live catalog flow again — no pointer anywhere names a copy;
 *   - the flow cell of the order screens still shows a flow the picker knows.
 *
 * ALL OF A LINE'S FLOWS TOGETHER. A wait rule names an operation of ANOTHER node's flow and is
 * resolved at release against that node's own flow — so one flow frozen and its neighbour live
 * would still let the order move. Every flow anywhere in the line's tree is copied, also the flow of
 * a thing taken from stock (never read; a copy too many is harmless, one too few is not).
 *
 * WHAT STAYS LIVE: times, and a flow that is not ACTIVE yet (see ensureLineFlowCopies). An operation's rules and charts are read live until release, as before.
 *
 * WHERE IT IS CALLED: lockService.lockLine; a flow given, after freeze, to a row that had none
 * (masterRecordService, bomService, cutPlateService.setCutPlateFlows); and release
 * (rollOutPlan's `ensure`), the safety net for a line locked before this existed. Idempotent: a flow
 * that already has its copy is never copied again, so a copy never follows its source.
 *
 * A copy is NOT a catalog flow: it keeps its source's code and name (uq_cof_catalog_code leaves it
 * out), it is in no list and no picker, and flowService refuses every change to it.
 */
import { insertRows } from '../lib/db.js';
import { explode } from './bomService.js';

/** SQL: this flow (alias `f`) is a catalog flow, not an order line's copy. Every list and count of flows says it. */
export const catalogFlowSql = (alias = 'f') => `${alias}.owner_order_line_id IS NULL`;

/** The one sentence for a flow that may no longer change on a frozen line. */
export const frozenFlowMessage = (rowName) =>
  `This order's design is frozen, so the flow of ${rowName ?? 'this row'} cannot change. Make a new revision of the order to change it.`;

/**
 * What a frozen line still takes: a flow for a row that has NONE. `had` is the row's flow today
 * (bomGraph.effectiveFlowOf — the line's, else its item's), `next` what is asked for.
 * → 'same' (nothing to do) | 'fill' (allowed; copy it) | 'refuse'.
 */
export function frozenFlowChange(had, next) {
  if (Number(had ?? 0) === Number(next ?? 0)) return 'same';
  return had == null && next != null ? 'fill' : 'refuse';
}

/**
 * The copies of these lines: Map(lineId -> Map(sourceFlowId -> copyFlowId)). ONE query whatever
 * the number of lines; a line with no copy (not locked, or nothing made by a flow) is absent.
 */
export async function frozenFlowMap(db, companyId, lineIds) {
  const out = new Map();
  const ids = [...new Set((lineIds ?? []).filter((id) => id != null).map(Number))];
  if (!ids.length) return out;
  const [rows] = await db.query(
    'SELECT id, owner_order_line_id, source_flow_id FROM cf_operation_flows WHERE company_id = ? AND owner_order_line_id IN (?) AND deleted_at IS NULL',
    [companyId, ids],
  );
  for (const r of rows) {
    const line = Number(r.owner_order_line_id);
    if (!out.has(line)) out.set(line, new Map());
    out.get(line).set(Number(r.source_flow_id), Number(r.id));
  }
  return out;
}

/** One line's copies, source -> copy. A line that is not locked reads the catalog: empty, and no query. */
export async function frozenFlowsOfLine(db, companyId, line) {
  if (!line?.id || !line.locked_at) return new Map();
  return (await frozenFlowMap(db, companyId, [line.id])).get(Number(line.id)) ?? new Map();
}

/** The flow id to READ STEPS BY: the line's copy where it has one, else the flow itself. */
export const frozenIdOf = (copies, flowId) => (flowId == null ? flowId : copies?.get(Number(flowId)) ?? flowId);

/**
 * Puts a line's copies on an exploded tree (bomService.explode): every node whose flow has a copy
 * reads the copy from here on — `flow.id` is the copy, `flow.sourceId` the catalog flow the row
 * names. THE one place a tree of a locked line is translated; call it right after explode().
 */
export function freezeTree(root, copies) {
  if (!root || !copies?.size) return root;
  const walk = (n) => {
    const copy = n.flow ? copies.get(Number(n.flow.id)) : null;
    if (copy != null) n.flow = { ...n.flow, id: copy, sourceId: n.flow.id };
    for (const k of n.children ?? []) walk(k);
  };
  walk(root);
  return root;
}

/** Every flow id named anywhere in an exploded tree (before freezeTree). */
export function flowIdsOfTree(root) {
  const ids = new Set();
  const walk = (n) => { if (n.flow?.id != null) ids.add(Number(n.flow.sourceId ?? n.flow.id)); for (const k of n.children ?? []) walk(k); };
  if (root) walk(root);
  return [...ids];
}

/**
 * Makes sure the line owns a copy of every flow it uses. Idempotent and set-based.
 *
 *   opts.tree     the line's exploded tree, when the caller already has it (lock, release)
 *   opts.flowIds  or just these flows (a flow given to one row after freeze)
 *   neither       the tree is read here (bomService.explode: one read per level of the structure)
 *
 * Round trips, whatever the number of flows, steps, links and waits: ONE when nothing is missing
 * (the line's copies); ELEVEN at most when something is — the sources, the new headers and their
 * ids, the source steps, the new steps and their ids, the links read and written, the waits read
 * and written. New ids are read back by a natural key, never worked out from insertId (lib/db.js).
 *
 * Whether the line is locked is the CALLER's business: lock calls this just before it stamps the line.
 * → { copied, flows: Map(sourceFlowId -> copyFlowId) } — every copy of the line, old and new.
 */
export async function ensureLineFlowCopies(db, c, lineId, opts = {}) {
  const { companyId } = c;
  const line = Number(lineId);
  let wanted = opts.flowIds ?? (opts.tree ? flowIdsOfTree(opts.tree) : null);
  if (!wanted) {
    const [[l]] = await db.query('SELECT item_id, quantity FROM cf_sales_order_lines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, line]);
    if (!l?.item_id) return { copied: 0, flows: new Map() };
    wanted = flowIdsOfTree((await explode(db, companyId, l.item_id, { rootQuantity: Number(l.quantity), maxDepth: 15 })).root);
  }
  wanted = [...new Set(wanted.filter((id) => id != null).map(Number))];
  const flows = (await frozenFlowMap(db, companyId, [line])).get(line) ?? new Map();
  const missing = wanted.filter((id) => !flows.has(id));
  if (!missing.length) return { copied: 0, flows };

  // 1. The headers. A flow that is gone cannot be copied (release says so, as it always did); a
  //    copy is never copied — no pointer names one, so this only guards a hand-written id.
  //    ONLY AN ACTIVE FLOW IS FROZEN. A draft flow is one nobody has finished, and a copy can never
  //    be changed or activated: frozen as a draft it could not be released, ever, short of a new
  //    revision of the order. So a flow that is not active stays read live, and is copied the next
  //    time this runs after it is activated — at release at the latest.
  const [sources] = await db.query(
    `SELECT id, code, name, description, revision, status, linked FROM cf_operation_flows
      WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL AND owner_order_line_id IS NULL AND status = 'active'`,
    [companyId, missing],
  );
  if (!sources.length) return { copied: 0, flows };
  const sourceIds = sources.map((f) => Number(f.id));
  // Same code, name, revision label and status: what was true of the flow when the line froze.
  await insertRows(db, 'cf_operation_flows',
    ['company_id', 'code', 'name', 'description', 'revision', 'status', 'linked', 'owner_order_line_id', 'source_flow_id', 'source_revision', 'created_by'],
    sources.map((f) => [companyId, f.code, f.name, f.description, f.revision, f.status, f.linked, line, f.id, f.revision, c.userId ?? null]));
  const [made] = await db.query(
    'SELECT id, source_flow_id FROM cf_operation_flows WHERE company_id = ? AND owner_order_line_id = ? AND source_flow_id IN (?) AND deleted_at IS NULL',
    [companyId, line, sourceIds],
  );
  const copyOf = new Map(made.map((r) => [Number(r.source_flow_id), Number(r.id)]));
  if (copyOf.size !== sourceIds.length) throw new Error(`cf_erp: ${sourceIds.length} flows copied for line ${line}, ${copyOf.size} read back.`);
  for (const [source, copy] of copyOf) flows.set(source, copy);

  // 2. The steps, found again by (flow, sequence, operation) — unique among a flow's live steps (uq_cofs_operation_seq).
  const [steps] = await db.query(
    'SELECT id, flow_id, sequence, lane, operation_id, step_name, notes FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id IN (?) AND deleted_at IS NULL ORDER BY flow_id, sequence, id',
    [companyId, sourceIds],
  );
  if (!steps.length) return { copied: copyOf.size, flows };
  await insertRows(db, 'cf_operation_flow_steps', ['company_id', 'flow_id', 'sequence', 'lane', 'operation_id', 'step_name', 'notes', 'created_by'],
    steps.map((s) => [companyId, copyOf.get(Number(s.flow_id)), s.sequence, s.lane, s.operation_id, s.step_name, s.notes, c.userId ?? null]));
  const [madeSteps] = await db.query(
    'SELECT id, flow_id, sequence, operation_id FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id IN (?) AND deleted_at IS NULL',
    [companyId, [...copyOf.values()]],
  );
  const at = new Map(madeSteps.map((s) => [`${s.flow_id}:${s.sequence}:${s.operation_id}`, Number(s.id)]));
  const stepOf = new Map();
  for (const s of steps) {
    const id = at.get(`${copyOf.get(Number(s.flow_id))}:${s.sequence}:${s.operation_id}`);
    if (!id) throw new Error(`cf_erp: step ${s.id} of flow ${s.flow_id} was copied for line ${line} and not read back.`);
    stepOf.set(Number(s.id), id);
  }
  const stepIds = [...stepOf.keys()];

  // 3. What each step starts after, and what it waits for — both name steps of their own flow only.
  const [links] = await db.query(
    'SELECT flow_id, step_id, after_step_id FROM cf_flow_step_links WHERE company_id = ? AND flow_id IN (?) AND deleted_at IS NULL ORDER BY id',
    [companyId, sourceIds],
  );
  const linkRows = links.filter((l) => stepOf.has(Number(l.step_id)) && stepOf.has(Number(l.after_step_id)))
    .map((l) => [companyId, copyOf.get(Number(l.flow_id)), stepOf.get(Number(l.step_id)), stepOf.get(Number(l.after_step_id)), c.userId ?? null]);
  if (linkRows.length) await insertRows(db, 'cf_flow_step_links', ['company_id', 'flow_id', 'step_id', 'after_step_id', 'created_by'], linkRows);
  const [waits] = await db.query(
    `SELECT flow_step_id, relation, target_definition_id, target_operation_id, required_status, notes
       FROM cf_step_wait_rules WHERE company_id = ? AND flow_step_id IN (?) AND deleted_at IS NULL ORDER BY id`,
    [companyId, stepIds],
  );
  if (waits.length) {
    await insertRows(db, 'cf_step_wait_rules',
      ['company_id', 'flow_step_id', 'relation', 'target_definition_id', 'target_operation_id', 'required_status', 'notes', 'created_by'],
      waits.map((w) => [companyId, stepOf.get(Number(w.flow_step_id)), w.relation, w.target_definition_id, w.target_operation_id, w.required_status, w.notes, c.userId ?? null]));
  }
  return { copied: copyOf.size, flows };
}
