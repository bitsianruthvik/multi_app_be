/**
 * flowService.js — operation flows, their steps and the Wait-For rules on them.
 *
 * A flow is the usual way to make something: an ordered list of operations.
 * Steps with the same sequence number may run in parallel, and since
 * 2026-09-24 a flow MAY run the same operation more than once — welded one
 * side, crane-turned, welded the other. A step is therefore identified inside
 * its flow by its SEQUENCE, not by its operation. The only repeat forbidden is
 * the same operation twice at ONE sequence number (uq_cofs_operation_seq),
 * which would leave the passes unordered.
 *
 * Wait-For rules sit on the WAITING step and name a relative target — the
 * parent, the children, the siblings or the nearest ancestor of a given
 * template, at one of their operations or as a whole.
 *
 * A rule names an OPERATION, never a step. That is forced, not chosen: the
 * target is a relative node whose flow is unknown when the rule is written —
 * two children can be made by two different flows — and a step id means
 * nothing outside its own flow. Where that operation repeats in the target's
 * flow, the rule means:
 *
 *     done     the LAST pass.  "Finished welding" is not true while another
 *                              weld pass is still to come.
 *     started  the FIRST pass. "Started welding" is true the moment the first
 *                              pass begins.
 *
 * which is no more than what the two words mean, and each is the safe end of
 * its range — the strictest instant for `done`, the earliest for `started`.
 * waitText() below says which pass out loud, so nobody has to infer it, and
 * planSteps() in releaseService.js resolves it the same way.
 *
 * Rules are resolved on the production tracker tree when an order is released
 * (decided 2026-09-22: "the parent and child in that tree define it"); here
 * they are only checked for sense.
 *
 * Revision and status work like the masters': draft → active → obsolete, the
 * revision label moves on, the id never changes.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { loadMaster } from './records.js';
import { nextRevision } from '../lib/revision.js';
import { syncRecordsUsingFlows } from './flowSpecService.js';
import { mainTimesOf, NO_TIME } from './operationService.js';
import { insertRows } from '../lib/db.js';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const TRANSITIONS = { draft: ['active'], active: ['obsolete'], obsolete: ['active'] };
/** descendants (2026-10-10): every piece below at any depth — a span's trial assembly waits for its girder segments, two levels down. */
export const RELATIONS = ['parent', 'children', 'siblings', 'ancestor', 'descendants'];
const blank = (v) => v == null || String(v).trim() === '';

async function requireFlow(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_operation_flows WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Flow');
  return row;
}

async function requireStep(db, companyId, id) {
  const [[row]] = await db.query(
    `SELECT s.*, f.status AS flow_status, f.code AS flow_code, f.linked AS flow_linked FROM cf_operation_flow_steps s
       JOIN cf_operation_flows f ON f.id = s.flow_id AND f.deleted_at IS NULL
      WHERE s.company_id = ? AND s.id = ? AND s.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound('Flow step');
  return row;
}

const shapeFlow = (f) => ({
  id: f.id, code: f.code, name: f.name, description: f.description, revision: f.revision, status: f.status,
  // true = saved by the lane editor and read by its links; false = a legacy flow, read by sequence number.
  linked: !!f.linked,
  stepCount: f.step_count == null ? undefined : Number(f.step_count),
  usedBy: f.used_by == null ? undefined : Number(f.used_by),
  createdAt: f.created_at, updatedAt: f.updated_at,
});

export async function listFlows(db, companyId, q = {}) {
  const where = ['f.company_id = ?', 'f.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.status)) { where.push('f.status = ?'); params.push(q.status); }
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push('(f.code LIKE ? OR f.name LIKE ?)');
    params.push(like, like);
  }
  if (!blank(q.operationId)) {
    where.push('EXISTS (SELECT 1 FROM cf_operation_flow_steps x WHERE x.company_id = f.company_id AND x.flow_id = f.id AND x.operation_id = ? AND x.deleted_at IS NULL)');
    params.push(Number(q.operationId));
  }
  const [rows] = await db.query(
    `SELECT f.*,
            (SELECT COUNT(*) FROM cf_operation_flow_steps s WHERE s.company_id = f.company_id AND s.flow_id = f.id AND s.deleted_at IS NULL) AS step_count,
            (SELECT COUNT(*) FROM cf_master_records m WHERE m.company_id = f.company_id AND m.default_flow_id = f.id AND m.deleted_at IS NULL)
            + (SELECT COUNT(*) FROM cf_bom_lines l WHERE l.company_id = f.company_id AND l.operation_flow_id = f.id AND l.deleted_at IS NULL) AS used_by
       FROM cf_operation_flows f WHERE ${where.join(' AND ')} ORDER BY f.code`,
    params,
  );
  // The steps of every listed flow in ONE query, for the "CNC Cutting > Drilling" line.
  const ids = rows.map((f) => f.id);
  const [stepRows] = ids.length ? await db.query(
    `SELECT s.flow_id, s.sequence, s.operation_id, o.code AS operation_code, o.name AS operation_name
       FROM cf_operation_flow_steps s JOIN cf_operations o ON o.id = s.operation_id
      WHERE s.company_id = ? AND s.flow_id IN (?) AND s.deleted_at IS NULL ORDER BY s.sequence, s.id`,
    [companyId, ids],
  ) : [[]];
  return rows.map((f) => ({
    ...shapeFlow(f),
    steps: stepRows.filter((s) => s.flow_id === f.id).map((s) => ({ sequence: s.sequence, operation: { id: s.operation_id, code: s.operation_code, name: s.operation_name } })),
  }));
}

async function stepsOf(db, companyId, flowId, linked) {
  const [steps] = await db.query(
    `SELECT s.*, o.code AS operation_code, o.name AS operation_name, o.status AS operation_status
       FROM cf_operation_flow_steps s JOIN cf_operations o ON o.id = s.operation_id
      WHERE s.company_id = ? AND s.flow_id = ? AND s.deleted_at IS NULL ORDER BY s.sequence, s.id`,
    [companyId, flowId],
  );
  const ids = steps.map((s) => s.id);
  const [rules] = ids.length ? await db.query(
    `SELECT w.*, dm.code AS definition_code, dm.name AS definition_name, o.code AS operation_code, o.name AS operation_name
       FROM cf_step_wait_rules w
       LEFT JOIN cf_master_records dm ON dm.id = w.target_definition_id
       LEFT JOIN cf_operations o ON o.id = w.target_operation_id
      WHERE w.company_id = ? AND w.flow_step_id IN (?) AND w.deleted_at IS NULL ORDER BY w.id`,
    [companyId, ids],
  ) : [[]];
  // The operation's own times (its main rule), for the step card — one read for all the steps.
  const times = await mainTimesOf(db, companyId, steps.map((s) => s.operation_id));
  const order = await orderOf(db, companyId, flowId, steps, linked);
  return steps.map((s) => ({
    id: s.id,
    sequence: s.sequence,
    // Where it is drawn and which steps it starts after — stored for a linked flow, worked out for a legacy one.
    lane: order.get(Number(s.id)).lane,
    after: order.get(Number(s.id)).after,
    operation: { id: s.operation_id, code: s.operation_code, name: s.operation_name, status: s.operation_status },
    stepName: s.step_name,
    notes: s.notes,
    time: times.get(Number(s.operation_id)) ?? NO_TIME,
    waits: rules.filter((w) => w.flow_step_id === s.id).map(shapeWait),
  }));
}

/**
 * Each step's lane and the steps it starts after: Map stepId -> { lane, after: [stepId] }.
 * A LINKED flow has them stored (cf_operation_flow_steps.lane, cf_flow_step_links — init.sql §54).
 * A legacy flow is read by the old rule and handed over in the same shape, so the page draws either:
 * steps sharing a sequence number are lanes side by side (lane = their order), each after every step
 * of the number before. `steps` in flow order (sequence, id).
 */
async function orderOf(db, companyId, flowId, steps, linked) {
  const out = new Map();
  if (linked) {
    const [links] = steps.length ? await db.query(
      'SELECT step_id, after_step_id FROM cf_flow_step_links WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL ORDER BY id', [companyId, flowId],
    ) : [[]];
    for (const s of steps) out.set(Number(s.id), { lane: Number(s.lane) || 0, after: [] });
    for (const l of links) if (out.has(Number(l.step_id)) && out.has(Number(l.after_step_id))) out.get(Number(l.step_id)).after.push(Number(l.after_step_id));
    return out;
  }
  let before = [], row = [], seq = null;
  for (const s of steps) {
    if (seq !== s.sequence) { if (row.length) before = row; row = []; seq = s.sequence; }
    out.set(Number(s.id), { lane: row.length, after: [...before] });
    row.push(Number(s.id));
  }
  return out;
}

const RELATION_TEXT = { parent: 'its parent', children: 'its children', siblings: 'its siblings', descendants: 'every piece below it' };

/** The rule in one sentence, as the flow screen and the tracker will show it. */
export function waitText(w) {
  const madeFrom = w.definition_code ?? w.definition_name;
  const who = w.relation === 'ancestor'
    ? `the nearest ${madeFrom ?? 'ancestor'} above it`
    : `${RELATION_TEXT[w.relation]}${madeFrom && w.relation !== 'parent' ? ` made from ${madeFrom}` : ''}`;
  const plural = w.relation === 'children' || w.relation === 'siblings' || w.relation === 'descendants';
  const started = w.required_status === 'started';
  if (w.target_operation_id) {
    // Which pass, said out loud rather than left to be inferred: a flow may run
    // one operation several times, and `done` means the last of them while
    // `started` means the first. Only worth a clause where it can differ, so
    // the sentence stays the same for a flow that does the operation once.
    const pass = started
      ? ' Where a flow does it more than once, that means the first pass.'
      : ' Where a flow does it more than once, that means the last pass.';
    return `Waits until ${who} ${plural ? 'have' : 'has'} ${started ? 'started' : 'finished'} ${w.operation_name} (${w.operation_code}).${pass}`;
  }
  return `Waits until ${who} ${plural ? 'are' : 'is'} ${started ? 'started' : 'complete'}.`;
}

function shapeWait(w) {
  return {
    id: w.id,
    relation: w.relation,
    targetDefinition: w.target_definition_id ? { id: w.target_definition_id, code: w.definition_code, name: w.definition_name } : null,
    targetOperation: w.target_operation_id ? { id: w.target_operation_id, code: w.operation_code, name: w.operation_name } : null,
    requiredStatus: w.required_status,
    notes: w.notes,
    text: waitText(w),
  };
}

export async function getFlow(db, companyId, id) {
  const f = await requireFlow(db, companyId, id);
  const out = shapeFlow(f);
  out.steps = await stepsOf(db, companyId, id, f.linked);
  const [records] = await db.query(
    `SELECT m.id, m.code, m.short_name, m.name, m.record_kind, i.item_type, d.definition_type FROM cf_master_records m
       LEFT JOIN cf_item_details i ON i.master_id = m.id LEFT JOIN cf_definition_details d ON d.master_id = m.id
      WHERE m.company_id = ? AND m.default_flow_id = ? AND m.deleted_at IS NULL ORDER BY m.code LIMIT 100`,
    [companyId, id],
  );
  const [[{ line_count: lines }]] = await db.query('SELECT COUNT(*) AS line_count FROM cf_bom_lines WHERE company_id = ? AND operation_flow_id = ? AND deleted_at IS NULL', [companyId, id]);
  // The list above stops at 100; this is every record that names the flow (same WHERE, still one cheap COUNT).
  const [[{ record_count: recordCount }]] = await db.query('SELECT COUNT(*) AS record_count FROM cf_master_records WHERE company_id = ? AND default_flow_id = ? AND deleted_at IS NULL', [companyId, id]);
  out.uses = {
    records: records.map((r) => ({ id: r.id, code: r.code, shortName: r.short_name ?? null, name: r.name, kind: r.record_kind === 'item' ? r.item_type : r.definition_type })),
    bomLines: Number(lines),
    recordCount: Number(recordCount),
  };
  return out;
}

function readFlow(input, problems, partial) {
  const out = {};
  if (!partial || input.code !== undefined) {
    const code = String(input.code ?? '').trim();
    if (!code || !CODE_RE.test(code) || code.length > 50) problems.push('Code: up to 50 letters, digits and - _ . /, no spaces.');
    out.code = code;
  }
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 255) problems.push('Name is required (up to 255 characters).');
    out.name = name;
  }
  if (input.description !== undefined) out.description = blank(input.description) ? null : String(input.description);
  return out;
}

export async function createFlow(db, c, input = {}) {
  const problems = [];
  const f = readFlow(input, problems, false);
  assertNoProblems(problems);
  const [r] = await db.query(
    "INSERT INTO cf_operation_flows (company_id, code, name, description, status, created_by) VALUES (?, ?, ?, ?, 'draft', ?)",
    [c.companyId, f.code, f.name, f.description ?? null, c.userId],
  );
  return getFlow(db, c.companyId, r.insertId);
}

export async function updateFlow(db, c, id, input = {}) {
  const flow = await requireFlow(db, c.companyId, id);
  const problems = [];
  const f = readFlow(input, problems, true);
  if (f.code !== undefined && f.code !== flow.code && flow.status !== 'draft') problems.push('A flow code is fixed once the flow is active.');
  assertNoProblems(problems);
  if (Object.keys(f).length) {
    await db.query(`UPDATE cf_operation_flows SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(f), c.companyId, id]);
  }
  return getFlow(db, c.companyId, id);
}

/** Activation needs steps, every operation active, and every wait target still valid. */
export async function setFlowStatus(db, c, id, status) {
  const flow = await requireFlow(db, c.companyId, id);
  if (flow.status === status) return getFlow(db, c.companyId, id);
  if (!(TRANSITIONS[flow.status] ?? []).includes(status)) throw invalid('BAD_TRANSITION', `A ${flow.status} flow cannot become ${status}.`);
  if (status === 'active') {
    const steps = await stepsOf(db, c.companyId, id, flow.linked);
    const problems = [];
    if (!steps.length) problems.push('It has no steps.');
    for (const s of steps) {
      if (s.operation.status !== 'active') problems.push(`Operation ${s.operation.code} is inactive.`);
      for (const w of s.waits) {
        if (w.targetOperation) {
          const [[o]] = await db.query('SELECT status FROM cf_operations WHERE id = ?', [w.targetOperation.id]);
          if (o?.status !== 'active') problems.push(`${s.operation.code} waits for ${w.targetOperation.code}, which is inactive.`);
        }
      }
    }
    if (problems.length) throw invalid('INCOMPLETE', `${flow.code} cannot be activated yet.`, { problems });
  }
  await db.query('UPDATE cf_operation_flows SET status = ? WHERE company_id = ? AND id = ?', [status, c.companyId, id]);
  return getFlow(db, c.companyId, id);
}

export async function reviseFlow(db, c, id, input = {}) {
  const flow = await requireFlow(db, c.companyId, id);
  if (flow.status === 'obsolete') throw invalid('OBSOLETE', 'Reactivate the flow before revising it.');
  const label = blank(input.revision) ? nextRevision(flow.revision) : String(input.revision).trim();
  if (label.length > 20) throw invalid('INVALID', 'Revision is up to 20 characters.');
  if (label === flow.revision) throw invalid('SAME_REVISION', `It is already at revision ${label}.`);
  await db.query('UPDATE cf_operation_flows SET revision = ? WHERE company_id = ? AND id = ?', [label, c.companyId, id]);
  return getFlow(db, c.companyId, id);
}

export async function deleteFlow(db, c, id) {
  const flow = await requireFlow(db, c.companyId, id);
  const [[{ record_count: records }]] = await db.query('SELECT COUNT(*) AS record_count FROM cf_master_records WHERE company_id = ? AND default_flow_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  const [[{ line_count: lines }]] = await db.query('SELECT COUNT(*) AS line_count FROM cf_bom_lines WHERE company_id = ? AND operation_flow_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  const reasons = [];
  if (Number(records)) reasons.push(`${records} item(s) or definition(s) are usually made by it`);
  if (Number(lines)) reasons.push(`${lines} BOM line(s) name it`);
  if (reasons.length) throw conflict('IN_USE', `${flow.code} cannot be deleted: ${reasons.join('; ')}. Mark it obsolete instead.`, { problems: reasons });
  await db.query(
    `UPDATE cf_step_wait_rules w JOIN cf_operation_flow_steps s ON s.id = w.flow_step_id
        SET w.deleted_at = NOW() WHERE s.company_id = ? AND s.flow_id = ? AND w.deleted_at IS NULL`,
    [c.companyId, id],
  );
  await db.query('UPDATE cf_flow_step_links SET deleted_at = NOW() WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_operation_flow_steps SET deleted_at = NOW() WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_operation_flows SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

// --- steps --------------------------------------------------------------------

function assertEditable(flow) {
  if (flow.status === 'obsolete') throw invalid('OBSOLETE', `${flow.code} is obsolete — reactivate it to change its steps.`);
}

/**
 * The per-step routes place a step by its sequence NUMBER. A linked flow goes by what each step
 * starts after (init.sql §54), so a number alone no longer says where a step belongs: those changes
 * are made on the flow page, which sends the whole list (applyFlowChanges).
 */
function assertBySequence(flow) {
  if (flow.linked) throw conflict('FLOW_HAS_LANES', `${flow.code} is laid out in lanes — change its steps on the flow page (Edit steps), which saves the whole flow at once.`);
}

function readSequence(raw, problems) {
  if (blank(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 1e6) { problems.push('Sequence is a positive whole number (10, 20, 30 …).'); return null; }
  return n;
}

async function requireActiveOperation(db, companyId, id, problems) {
  const [[o]] = await db.query('SELECT id, code, name, status FROM cf_operations WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!o) { problems.push('That operation does not exist.'); return null; }
  if (o.status !== 'active') problems.push(`Operation ${o.code} is inactive.`);
  return o;
}

/** input: { operationId, sequence?, stepName?, notes? } — sequence defaults to 10 past the last. */
export async function addStep(db, c, flowId, input = {}) {
  const flow = await requireFlow(db, c.companyId, flowId);
  assertEditable(flow);
  assertBySequence(flow);
  const problems = [];
  const op = blank(input.operationId) ? (problems.push('Choose an operation.'), null) : await requireActiveOperation(db, c.companyId, input.operationId, problems);
  let sequence = readSequence(input.sequence, problems);
  const stepName = blank(input.stepName) ? null : String(input.stepName).trim().slice(0, 100);
  assertNoProblems(problems);
  if (sequence == null) {
    const [[{ top }]] = await db.query('SELECT MAX(sequence) AS top FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL', [c.companyId, flowId]);
    sequence = (Number(top) || 0) + 10;
  }
  await db.query(
    'INSERT INTO cf_operation_flow_steps (company_id, flow_id, sequence, operation_id, step_name, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, flowId, sequence, op.id, stepName, blank(input.notes) ? null : String(input.notes), c.userId],
  );
  await syncRecordsUsingFlows(db, c, [flowId]);
  return getFlow(db, c.companyId, flowId);
}

/** How many live production steps were released from this flow step. */
async function releasedUses(db, companyId, stepId) {
  const [[r]] = await db.query('SELECT COUNT(*) AS n FROM cf_production_steps WHERE company_id = ? AND flow_step_id = ? AND deleted_at IS NULL', [companyId, stepId]);
  return Number(r.n);
}

/**
 * input: { operationId?, sequence?, stepName?, notes? }
 * The operation of a step may change while no released production step was
 * copied from it (a released tracker keeps what it was released with); after
 * that, add a step with the other operation instead.
 */
export async function updateStep(db, c, stepId, input = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  if (step.flow_status === 'obsolete') throw invalid('OBSOLETE', `${step.flow_code} is obsolete — reactivate it to change its steps.`);
  const problems = [];
  const sets = {};
  if (input.operationId !== undefined && Number(input.operationId) !== step.operation_id) {
    const used = await releasedUses(db, c.companyId, stepId);
    if (used) throw conflict('STEP_RELEASED', `This step is already in production (${used} released step${used === 1 ? '' : 's'}), so its operation cannot change. Add a new step with the other operation for future orders.`);
    const op = await requireActiveOperation(db, c.companyId, input.operationId, problems);
    if (op) sets.operation_id = op.id;
  }
  if (input.sequence !== undefined) {
    const n = readSequence(input.sequence, problems);
    if (n != null && n !== step.sequence) { assertBySequence({ linked: step.flow_linked, code: step.flow_code }); sets.sequence = n; }
  }
  if (input.stepName !== undefined) sets.step_name = blank(input.stepName) ? null : String(input.stepName).trim().slice(0, 100);
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : String(input.notes);
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_operation_flow_steps SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, stepId]);
    if (sets.operation_id) await syncRecordsUsingFlows(db, c, [step.flow_id]);
  }
  return getFlow(db, c.companyId, step.flow_id);
}

/**
 * Replace the operation of one step (user, 2026-10-07: "replace inside the flow
 * a particular operation with another"). The step keeps its place, name, notes
 * and waits. Lines already RELEASED keep the operation they were released with
 * (their production steps hold their own copy); everything not yet released
 * takes the new one.
 *
 * What hangs off the old operation for those unreleased lines moves with it —
 * time overrides (order line × row × operation) and work-order cells (piece ×
 * operation) — for the rows whose flow IS this flow, and only when the old
 * operation no longer appears in the flow (a second pass of it keeps them). A
 * row that already has the new operation keeps its own entry; the old one is
 * left alone and counted.
 * input: { operationId } → { flow, replaced: { from, to, released, overridesMoved, cellsMoved, kept, waitsNaming } }
 * opts.deferSync (applyFlowChanges): the caller syncs once for the whole save and reads the flow itself.
 */
export async function replaceStepOperation(db, c, stepId, input = {}, opts = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  assertEditable({ status: step.flow_status, code: step.flow_code });
  const problems = [];
  if (blank(input.operationId)) throw invalid('INVALID', 'Choose the operation that replaces it.');
  if (Number(input.operationId) === step.operation_id) throw invalid('SAME_OPERATION', 'That is already this step\'s operation.');
  const op = await requireActiveOperation(db, c.companyId, input.operationId, problems);
  assertNoProblems(problems);
  const [[clash]] = await db.query(
    'SELECT id FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id = ? AND operation_id = ? AND sequence = ? AND deleted_at IS NULL AND id <> ?',
    [c.companyId, step.flow_id, op.id, step.sequence, step.id],
  );
  if (clash) throw invalid('DUPLICATE_STEP', `${op.name} is already at step ${step.sequence} of this flow — give one of them another number first.`);
  const [[from]] = await db.query('SELECT id, code, name FROM cf_operations WHERE company_id = ? AND id = ?', [c.companyId, step.operation_id]);
  const released = await releasedUses(db, c.companyId, step.id);
  await db.query('UPDATE cf_operation_flow_steps SET operation_id = ? WHERE company_id = ? AND id = ?', [op.id, c.companyId, step.id]);

  let overridesMoved = 0, cellsMoved = 0, kept = 0;
  const [[still]] = await db.query(
    'SELECT COUNT(*) AS n FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id = ? AND operation_id = ? AND deleted_at IS NULL',
    [c.companyId, step.flow_id, step.operation_id],
  );
  if (!Number(still.n)) {
    // The row's flow, as bomGraph.effectiveFlowOf reads it: the row's own, else
    // the item's, else its template's; the line's own item (no row) from the item.
    const flowCols = `COALESCE(bl.operation_flow_id, ch.default_flow_id) AS row_flow,
                      lm.default_flow_id AS line_flow`;
    const flowJoins = `JOIN cf_sales_order_lines ol ON ol.company_id = x.company_id AND ol.id = x.order_line_id AND ol.deleted_at IS NULL
      LEFT JOIN cf_bom_lines bl ON bl.id = x.bom_line_id
      LEFT JOIN cf_master_records ch ON ch.id = bl.child_id
      LEFT JOIN cf_item_details ci ON ci.master_id = bl.child_id AND ci.deleted_at IS NULL
      LEFT JOIN cf_master_records sdef ON sdef.id = ci.source_definition_id
      LEFT JOIN cf_master_records lm ON lm.id = ol.item_id
      LEFT JOIN cf_item_details li ON li.master_id = ol.item_id AND li.deleted_at IS NULL
      LEFT JOIN cf_master_records lsd ON lsd.id = li.source_definition_id`;
    const [ovs] = await db.query(
      `SELECT x.id, x.order_line_id, x.bom_line_id, ${flowCols} FROM cf_time_overrides x ${flowJoins}
        WHERE x.company_id = ? AND x.operation_id = ? AND x.deleted_at IS NULL`,
      [c.companyId, step.operation_id],
    );
    const [cells] = await db.query(
      `SELECT x.id, x.order_line_id, x.order_piece_id, x.bom_line_id, ${flowCols}
         FROM (SELECT w.id, w.company_id, w.order_line_id, w.order_piece_id, p.bom_line_id
                 FROM cf_work_order_cells w JOIN cf_order_pieces p ON p.id = w.order_piece_id
                WHERE w.company_id = ? AND w.operation_id = ? AND w.deleted_at IS NULL) x ${flowJoins}`,
      [c.companyId, step.operation_id],
    );
    const lineIds = [...new Set([...ovs, ...cells].map((r) => r.order_line_id))];
    const [rel] = lineIds.length ? await db.query(
      'SELECT DISTINCT order_line_id FROM cf_production_releases WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [c.companyId, lineIds],
    ) : [[]];
    const releasedLines = new Set(rel.map((r) => r.order_line_id));
    const ours = (r) => !releasedLines.has(r.order_line_id) && Number(r.bom_line_id == null ? r.line_flow : r.row_flow) === Number(step.flow_id);
    const ovMine = ovs.filter(ours), cellMine = cells.filter(ours);
    if (ovMine.length) {
      const [taken] = await db.query(
        'SELECT order_line_id, bom_key FROM cf_time_overrides WHERE company_id = ? AND operation_id = ? AND order_line_id IN (?) AND deleted_at IS NULL',
        [c.companyId, op.id, [...new Set(ovMine.map((r) => r.order_line_id))]],
      );
      const has = new Set(taken.map((t) => `${t.order_line_id}:${t.bom_key}`));
      const move = ovMine.filter((r) => !has.has(`${r.order_line_id}:${r.bom_line_id ?? 0}`));
      kept += ovMine.length - move.length;
      if (move.length) await db.query('UPDATE cf_time_overrides SET operation_id = ? WHERE company_id = ? AND id IN (?)', [op.id, c.companyId, move.map((r) => r.id)]);
      overridesMoved = move.length;
    }
    if (cellMine.length) {
      const [taken] = await db.query(
        'SELECT order_piece_id FROM cf_work_order_cells WHERE company_id = ? AND operation_id = ? AND order_piece_id IN (?) AND deleted_at IS NULL',
        [c.companyId, op.id, cellMine.map((r) => r.order_piece_id)],
      );
      const has = new Set(taken.map((t) => t.order_piece_id));
      const move = cellMine.filter((r) => !has.has(r.order_piece_id));
      kept += cellMine.length - move.length;
      if (move.length) await db.query('UPDATE cf_work_order_cells SET operation_id = ? WHERE company_id = ? AND id IN (?)', [op.id, c.companyId, move.map((r) => r.id)]);
      cellsMoved = move.length;
    }
  }
  // Waits elsewhere that name the old operation are the planner's to decide; say how many.
  const [[waits]] = await db.query(
    'SELECT COUNT(*) AS n FROM cf_step_wait_rules WHERE company_id = ? AND target_operation_id = ? AND deleted_at IS NULL', [c.companyId, step.operation_id],
  );
  if (!opts.deferSync) await syncRecordsUsingFlows(db, c, [step.flow_id]);
  return {
    flow: opts.deferSync ? null : await getFlow(db, c.companyId, step.flow_id),
    replaced: {
      from: from ? { id: from.id, code: from.code, name: from.name } : null, to: { id: op.id, code: op.code, name: op.name },
      released, overridesMoved, cellsMoved, kept, waitsNaming: Number(waits.n),
    },
  };
}

/**
 * Moves a step one place up or down and renumbers the flow in 10s. Steps that
 * share a number run alongside; that is kept: a step inside a group of several
 * first steps OUT of the group (into its own number just before/after it), and
 * a step alone at its number swaps places with the neighbouring number. Wait
 * rules hang on the step, so they travel with it.
 * input: { direction: 'up' | 'down' }
 */
export async function moveStep(db, c, stepId, input = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  if (step.flow_status === 'obsolete') throw invalid('OBSOLETE', `${step.flow_code} is obsolete — reactivate it to change its steps.`);
  const dir = input.direction;
  if (dir !== 'up' && dir !== 'down') throw invalid('INVALID', 'Move a step up or down.');
  assertBySequence({ linked: step.flow_linked, code: step.flow_code });
  const [rows] = await db.query(
    'SELECT id, sequence FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL ORDER BY sequence, id',
    [c.companyId, step.flow_id],
  );
  const groups = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.seq === r.sequence) last.ids.push(r.id); else groups.push({ seq: r.sequence, ids: [r.id] });
  }
  const gi = groups.findIndex((g) => g.ids.includes(Number(stepId)));
  const g = groups[gi];
  const off = dir === 'up' ? -1 : 1;
  if (g.ids.length > 1) {
    g.ids = g.ids.filter((i) => i !== Number(stepId));
    groups.splice(dir === 'up' ? gi : gi + 1, 0, { seq: 0, ids: [Number(stepId)] });
  } else if (groups[gi + off]) {
    [groups[gi], groups[gi + off]] = [groups[gi + off], groups[gi]];
  }
  await renumber(db, c.companyId, groups);
  return getFlow(db, c.companyId, step.flow_id);
}

/** Groups in order -> sequences 10, 20, 30 …. Two passes so uq_cofs_operation_seq never sees a clash half way. */
async function renumber(db, companyId, groups) {
  const all = groups.flatMap((g) => g.ids);
  if (!all.length) return;
  await db.query('UPDATE cf_operation_flow_steps SET sequence = sequence + 100000000 WHERE company_id = ? AND id IN (?)', [companyId, all]);
  for (let i = 0; i < groups.length; i++) {
    await db.query('UPDATE cf_operation_flow_steps SET sequence = ? WHERE company_id = ? AND id IN (?)', [(i + 1) * 10, companyId, groups[i].ids]);
  }
}

export async function removeStep(db, c, stepId) {
  const step = await requireStep(db, c.companyId, stepId);
  if (step.flow_status === 'obsolete') throw invalid('OBSOLETE', `${step.flow_code} is obsolete — reactivate it to change its steps.`);
  await db.query('UPDATE cf_step_wait_rules SET deleted_at = NOW() WHERE company_id = ? AND flow_step_id = ? AND deleted_at IS NULL', [c.companyId, stepId]);
  if (step.flow_linked) {
    // A linked flow: what started after the removed step now starts after what IT started after.
    const [links] = await db.query('SELECT id, step_id, after_step_id FROM cf_flow_step_links WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL', [c.companyId, step.flow_id]);
    const id = Number(stepId);
    const before = links.filter((l) => Number(l.step_id) === id).map((l) => Number(l.after_step_id));
    const next = links.filter((l) => Number(l.after_step_id) === id).map((l) => Number(l.step_id));
    const has = new Set(links.map((l) => `${l.step_id}:${l.after_step_id}`));
    const bridge = next.flatMap((n) => before.filter((b) => !has.has(`${n}:${b}`)).map((b) => [c.companyId, step.flow_id, n, b, c.userId ?? null]));
    const gone = links.filter((l) => Number(l.step_id) === id || Number(l.after_step_id) === id).map((l) => l.id);
    if (gone.length) await db.query('UPDATE cf_flow_step_links SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, gone]);
    if (bridge.length) await insertRows(db, 'cf_flow_step_links', ['company_id', 'flow_id', 'step_id', 'after_step_id', 'created_by'], bridge);
  }
  await db.query('UPDATE cf_operation_flow_steps SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, stepId]);
  await syncRecordsUsingFlows(db, c, [step.flow_id]);
  return getFlow(db, c.companyId, step.flow_id);
}

// --- wait rules -----------------------------------------------------------------

/**
 * input: { relation, targetDefinitionId?, targetOperationId?, requiredStatus? }
 *   relation parent | children | siblings | ancestor | descendants (every piece below, at any depth)
 *   targetDefinitionId narrows children / siblings to those made from a template
 *     definition; for ancestor it is required (the nearest one of that kind)
 *   targetOperationId  the OPERATION to wait for; empty = the target as a whole.
 *     It is an operation and not a step because the target's flow is not known
 *     here. Where that flow repeats the operation, `done` waits for its last
 *     pass and `started` for its first (see the header).
 */
export async function addWaitRule(db, c, stepId, input = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  if (step.flow_status === 'obsolete') throw invalid('OBSOLETE', `${step.flow_code} is obsolete — reactivate it to change its steps.`);
  const problems = [];
  const w = await readWaitInput(db, c.companyId, input, problems);
  assertNoProblems(problems, 'The wait rule has problems.');
  await db.query(
    `INSERT INTO cf_step_wait_rules (company_id, flow_step_id, relation, target_definition_id, target_operation_id, required_status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, stepId, w.relation, w.definitionId, w.operationId, w.requiredStatus, w.notes, c.userId],
  );
  return getFlow(db, c.companyId, step.flow_id);
}

/** One wait rule as typed, checked for sense — addWaitRule and applyFlowChanges share it. Problems in words. */
async function readWaitInput(db, companyId, input, problems) {
  const relation = String(input.relation ?? '');
  if (!RELATIONS.includes(relation)) problems.push('Wait for its parent, its children, its siblings, an ancestor or the pieces below it.');
  let definitionId = null;
  if (!blank(input.targetDefinitionId)) {
    const def = await loadMaster(db, companyId, Number(input.targetDefinitionId));
    if (!def || def.record_kind !== 'definition' || def.definition_type !== 'template') problems.push('Narrow it with a template definition.');
    else if (def.status === 'obsolete') problems.push(`${def.code ?? def.name} is obsolete.`);
    else definitionId = def.id;
    if (relation === 'parent') problems.push('A node has one parent — there is nothing to narrow.');
  } else if (relation === 'ancestor') {
    problems.push('Say which ancestor: the nearest one made from which template definition.');
  }
  let operationId = null;
  if (!blank(input.targetOperationId)) {
    const op = await requireActiveOperation(db, companyId, input.targetOperationId, problems);
    operationId = op?.id ?? null;
  }
  const requiredStatus = input.requiredStatus ?? 'done';
  if (!['started', 'done'].includes(requiredStatus)) problems.push('Wait until the target has started or has finished.');
  return { relation, definitionId, operationId, requiredStatus, notes: blank(input.notes) ? null : String(input.notes) };
}

export async function removeWaitRule(db, c, ruleId) {
  const [[rule]] = await db.query('SELECT * FROM cf_step_wait_rules WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, ruleId]);
  if (!rule) throw notFound('Wait rule');
  const step = await requireStep(db, c.companyId, rule.flow_step_id);
  if (step.flow_status === 'obsolete') throw invalid('OBSOLETE', `${step.flow_code} is obsolete — reactivate it to change its steps.`);
  await db.query('UPDATE cf_step_wait_rules SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, ruleId]);
  return getFlow(db, c.companyId, step.flow_id);
}

// --- the whole flow in one save ---------------------------------------------------

const PARK = 100000000; // above any sequence a person may type (readSequence stops at 1e6)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Makes the flow's steps match one list, in ONE save (user, 2026-10-10: "only after clicking on the
 * save button should the flow change. Because flow change will trigger a lot of things across app").
 * The flow page edits a copy and sends the whole of it here.
 *
 * input: { steps: [{ id?, key?, operationId, stepName?, notes?, lane?, after?, group?, waits? }], dryRun? }
 *   id      an existing step of this flow — kept and updated; a step with no id is new; an existing
 *           step that is not in the list is removed (its waits with it)
 *   key     the name the list gives the step, for `after` to point at (default: its id, or "#n")
 *   after   the keys of the steps it STARTS AFTER — the whole of the flow's order (init.sql §54).
 *           None = a first step. A step after two or more is where lanes meet.
 *   lane    the lane it is drawn in: 0 = the trunk, 1, 2 … to its right
 *   group   only read when NO step carries `after` (a plain list): the steps are a chain in list
 *           order, steps with the same group value side by side, each after every step of the group before.
 *   waits   the step's whole list: { id } keeps that rule as it is, anything else is a new rule,
 *           and a rule of the step that is not listed goes. Left out on a kept step = untouched.
 *
 * What it writes: lane, the links (set-based: missing ones added, gone ones soft-deleted),
 * `sequence` = the ROW the step sits in — 10 × its depth in the order, so everything that sorts by
 * sequence still reads top to bottom — and cf_operation_flows.linked = 1: from this save on the flow
 * is read by its links, not by its numbers. (Two steps of one operation in one row cannot share a
 * number — uq_cofs_operation_seq — so the second takes the next one up: 20, 21.)
 *
 * Refused, all problems at once: an obsolete flow; an operation that does not exist, or an inactive
 * one on a new step or a changed one; a step whose operation changes after production steps were
 * released from it (releasedUses); an `after` that names no step of the list, or the step itself;
 * a CIRCLE; a LANE LEFT OPEN — the flow must end in one step, so every lane a split opened has to
 * meet another again (user, 2026-10-10: "If a parallel doesn't get closed, don't let it save");
 * a wait rule that makes no sense or is there twice. An operation changed in place goes through
 * replaceStepOperation, so time overrides and work-order cells move as they do there.
 *
 * Records are re-synced ONCE, and only when the set of operations changed (a step added, removed
 * or given another operation) — order, lanes, names and waits do not change which values a flow reads.
 *
 * dryRun: checks everything and says what would change; writes nothing.
 * → { flow, summary, changes: { added, removed, replaced, edited, waitsAdded, waitsRemoved, orderChanged, lanesChanged, renumbered }, synced, dryRun }
 */
export async function applyFlowChanges(db, c, flowId, input = {}) {
  const flow = await requireFlow(db, c.companyId, flowId);
  assertEditable(flow);
  if (!Array.isArray(input.steps)) throw invalid('INVALID', 'Send the whole list of steps, in order.');
  const dryRun = input.dryRun === true;
  const list = input.steps.map((s) => s ?? {});
  const current = await stepsOf(db, c.companyId, flowId, flow.linked);
  const byId = new Map(current.map((s) => [Number(s.id), s]));

  const opIds = [...new Set(list.map((s) => Number(s.operationId)).filter((n) => Number.isInteger(n) && n > 0))];
  const [opRows] = opIds.length ? await db.query('SELECT id, code, name, status FROM cf_operations WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, opIds]) : [[]];
  const ops = new Map(opRows.map((o) => [Number(o.id), o]));
  const oldOf = (raw) => (blank(raw.id) ? null : byId.get(Number(raw.id)) ?? null);
  const opOf = (raw) => (blank(raw.operationId) ? null : ops.get(Number(raw.operationId)) ?? null);
  // Steps already in production, for the ones whose operation would change — one read.
  const swapped = list.filter((raw) => { const old = oldOf(raw); const op = opOf(raw); return old && op && Number(old.operation.id) !== Number(op.id); }).map((raw) => Number(raw.id));
  const [relRows] = swapped.length ? await db.query(
    'SELECT flow_step_id, COUNT(*) AS n FROM cf_production_steps WHERE company_id = ? AND flow_step_id IN (?) AND deleted_at IS NULL GROUP BY flow_step_id', [c.companyId, swapped],
  ) : [[]];
  const releasedOf = new Map(relRows.map((r) => [Number(r.flow_step_id), Number(r.n)]));

  // A plain list (no step says what it starts after) is read as rows: see `group` above.
  const explicit = list.some((raw) => raw.after !== undefined);
  const problems = [];
  const seen = new Set();
  const rowOf = new Map();
  const rows = [];
  const byKey = new Map();
  const want = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const old = oldOf(raw);
    const op = opOf(raw);
    const label = `Step ${i + 1}${op ? ` (${op.code})` : ''}`;
    const say = (text) => problems.push(`${label}: ${text}`);
    if (!blank(raw.id)) {
      if (!old) say('It is no longer a step of this flow — reload the page.');
      else if (seen.has(Number(old.id))) say('It is in the list twice.');
      else seen.add(Number(old.id));
    }
    if (blank(raw.operationId)) say('Choose an operation.');
    else if (!op) say('That operation does not exist.');
    const opChanged = !!op && !!old && Number(old.operation.id) !== Number(op.id);
    if (op && (!old || opChanged) && op.status !== 'active') say(`Operation ${op.code} is inactive.`);
    if (opChanged && releasedOf.get(Number(old.id))) {
      const used = releasedOf.get(Number(old.id));
      say(`This step is already in production (${used} released step${used === 1 ? '' : 's'}), so its operation cannot change. Add a new step with the other operation for future orders.`);
    }
    const key = !blank(raw.key) ? String(raw.key) : old ? String(old.id) : `#${i + 1}`;
    if (byKey.has(key)) say('Its key is used by another step of the list.');
    let lane = 0;
    if (explicit && raw.lane !== undefined) {
      lane = Number(raw.lane);
      if (!Number.isInteger(lane) || lane < 0 || lane > 1000) { say('Lane is a whole number from 0.'); lane = 0; }
    }
    if (!explicit) {
      const groupKey = blank(raw.group) ? `#${i}` : `g:${String(raw.group)}`;
      if (!rowOf.has(groupKey)) { rowOf.set(groupKey, rows.length); rows.push([]); }
      const row = rows[rowOf.get(groupKey)];
      if (op && row.some((x) => x.op && Number(x.op.id) === Number(op.id))) say(`${op.name} is already at step ${(rowOf.get(groupKey) + 1) * 10} of this flow — give one of them another number first.`);
      lane = row.length;
    }
    // Waits: { id } keeps a rule of this step; anything else is read as addWaitRule reads it.
    const keepWaits = [];
    const newWaits = [];
    const waitKeys = new Set();
    const oldWaits = new Map((old?.waits ?? []).map((w) => [Number(w.id), w]));
    const asked = Array.isArray(raw.waits) ? raw.waits : (old?.waits ?? []).map((w) => ({ id: w.id }));
    for (const rw of asked) {
      let wk;
      if (!blank(rw?.id)) {
        const keptWait = oldWaits.get(Number(rw.id));
        if (!keptWait) { say('One of its waits is no longer there — reload the page.'); continue; }
        keepWaits.push(Number(keptWait.id));
        wk = `${keptWait.relation}:${keptWait.targetDefinition?.id ?? 0}:${keptWait.targetOperation?.id ?? 0}`;
      } else {
        const mine = [];
        const w = await readWaitInput(db, c.companyId, rw ?? {}, mine);
        for (const m of mine) say(`Wait rule — ${m}`);
        if (mine.length) continue;
        newWaits.push(w);
        wk = `${w.relation}:${w.definitionId ?? 0}:${w.operationId ?? 0}`;
      }
      if (waitKeys.has(wk)) say('It waits for the same thing twice.');
      waitKeys.add(wk);
    }
    const stepName = raw.stepName === undefined && old ? old.stepName : (blank(raw.stepName) ? null : String(raw.stepName).trim().slice(0, 100));
    const notes = raw.notes === undefined && old ? old.notes : (blank(raw.notes) ? null : String(raw.notes));
    const w = { raw, i, key, label, say, old, op, opChanged, lane, after: [], stepName, notes, keepWaits, newWaits, waitsGone: [...oldWaits.keys()].filter((id) => !keepWaits.includes(id)) };
    want.push(w);
    if (!byKey.has(key)) byKey.set(key, w);
    if (!explicit) rows[rowOf.get(blank(raw.group) ? `#${i}` : `g:${String(raw.group)}`)].push(w);
  }

  // The order: what each step starts after.
  if (explicit) {
    for (const w of want) {
      if (w.raw.after === undefined) continue;
      if (!Array.isArray(w.raw.after)) { w.say('"after" is the list of steps it starts after.'); continue; }
      for (const a of w.raw.after) {
        const k = String(a);
        if (k === w.key) w.say('It cannot start after itself.');
        else if (!byKey.has(k)) w.say(`It starts after a step that is not in the list (${k}).`);
        else if (!w.after.includes(k)) w.after.push(k);
      }
    }
  } else {
    rows.forEach((row, r) => { if (r > 0) for (const w of row) w.after = rows[r - 1].map((p) => p.key); });
  }
  // No circle; each step's depth is its row (the longest way down to it).
  const name = (w) => (w.op ? `${w.op.code} (step ${w.i + 1})` : `step ${w.i + 1}`);
  const next = new Map(want.map((w) => [w.key, []]));
  const waiting = new Map(want.map((w) => [w.key, w.after.length]));
  for (const w of want) for (const a of w.after) next.get(a).push(w);
  const ready = want.filter((w) => w.after.length === 0);
  for (const w of ready) w.depth = 1;
  let placed = 0;
  while (ready.length) {
    const w = ready.shift();
    placed += 1;
    for (const n of next.get(w.key)) {
      n.depth = Math.max(n.depth ?? 0, w.depth + 1);
      waiting.set(n.key, waiting.get(n.key) - 1);
      if (waiting.get(n.key) === 0) ready.push(n);
    }
  }
  if (placed < want.length) {
    // What is left after the sort feeds on a circle; walk back from one of them until a step repeats.
    const left = new Set(want.filter((w) => waiting.get(w.key) > 0).map((w) => w.key));
    const path = [];
    let at = byKey.get([...left][0]);
    while (!path.includes(at)) { path.push(at); at = byKey.get(at.after.find((a) => left.has(a))); }
    const circle = path.slice(path.indexOf(at)).reverse();
    problems.push(`These steps would wait for each other, so none could start: ${circle.map(name).join(' → ')} → ${name(circle[0])}. Take one of them out of the circle.`);
  } else {
    // Every lane closed: the flow ends in ONE step. Any other step nothing starts after is a lane left open.
    const ends = want.filter((w) => next.get(w.key).length === 0);
    if (ends.length > 1) {
      const trunkEnd = ends.filter((w) => w.lane === 0).sort((a, b) => b.depth - a.depth)[0] ?? null;
      for (const w of ends) {
        if (w === trunkEnd) continue;
        problems.push(`Lane ${w.lane + 1} (ends at ${w.op ? w.op.code : `step ${w.i + 1}`}) is still open — merge it back before saving.`);
      }
    }
  }
  if (problems.length) throw invalid('INVALID', `${flow.code} cannot be saved like this.`, { problems });
  // The number of each step: its row. One operation twice in a row takes the next number up.
  const taken = new Set();
  for (const w of want) {
    let sequence = w.depth * 10;
    while (taken.has(`${sequence}:${w.op.id}`)) sequence += 1;
    taken.add(`${sequence}:${w.op.id}`);
    w.sequence = sequence;
  }

  // What this save changes, counted before anything is written.
  const kept = want.filter((w) => w.old);
  const added = want.filter((w) => !w.old);
  const removed = current.filter((s) => !seen.has(Number(s.id)));
  const replaced = kept.filter((w) => w.opChanged);
  const edited = kept.filter((w) => (w.stepName ?? null) !== (w.old.stepName ?? null) || (w.notes ?? null) !== (w.old.notes ?? null));
  // Order: for every kept step, which kept steps come before it (through any step, kept or not) — before and now.
  const comesBefore = (ids, afterOf, isKept) => {
    const memo = new Map();
    const up = (id) => {
      if (memo.has(id)) return memo.get(id);
      const set = new Set();
      memo.set(id, set);
      for (const a of afterOf(id)) { set.add(a); for (const x of up(a)) set.add(x); }
      return set;
    };
    return JSON.stringify(ids.map((id) => [String(id), [...up(id)].filter(isKept).map(String).sort()]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  };
  const keptIdSet = new Set(kept.map((w) => Number(w.old.id)));
  const keyToId = (k) => (byKey.get(k).old ? Number(byKey.get(k).old.id) : `new:${k}`);
  const wantById = new Map(want.map((w) => [keyToId(w.key), w]));
  const orderBefore = comesBefore([...keptIdSet], (id) => byId.get(id)?.after ?? [], (id) => keptIdSet.has(id));
  const orderNow = comesBefore([...keptIdSet], (id) => wantById.get(id).after.map(keyToId), (id) => keptIdSet.has(id));
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const linksChanged = kept.some((w) => !sameSet(w.after.map(keyToId), w.old.after));
  const changes = {
    added: added.length,
    removed: removed.length,
    replaced: replaced.length,
    edited: edited.length,
    waitsAdded: want.reduce((n, w) => n + w.newWaits.length, 0),
    waitsRemoved: kept.reduce((n, w) => n + w.waitsGone.length, 0),
    orderChanged: orderBefore !== orderNow,
    lanesChanged: kept.some((w) => w.lane !== w.old.lane),
    renumbered: kept.some((w) => w.sequence !== w.old.sequence),
  };
  const words = [
    changes.added && `${plural(changes.added, 'step', 'steps')} added`,
    changes.removed && `${plural(changes.removed, 'step', 'steps')} removed`,
    changes.replaced && `${plural(changes.replaced, 'operation', 'operations')} replaced`,
    changes.edited && `${plural(changes.edited, 'step', 'steps')} edited`,
    changes.orderChanged && 'order changed',
    !changes.orderChanged && changes.lanesChanged && 'lanes rearranged',
    !changes.orderChanged && !changes.added && !changes.removed && changes.renumbered && 'steps renumbered',
    changes.waitsAdded && `${plural(changes.waitsAdded, 'wait', 'waits')} added`,
    changes.waitsRemoved && `${plural(changes.waitsRemoved, 'wait', 'waits')} removed`,
  ].filter(Boolean);
  const sentence = words.join(', ');
  // A legacy flow is written the first time it is saved here even when nothing else changed: its links.
  const toWrite = words.length > 0 || linksChanged || (!flow.linked && want.length > 0);
  let summary = words.length ? `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.` : toWrite ? 'Saved.' : 'Nothing changed.';
  const operationsChanged = !!(changes.added || changes.removed || changes.replaced);
  if (dryRun || !toWrite) {
    return { flow: await getFlow(db, c.companyId, flowId), summary, changes, synced: false, dryRun };
  }

  // 1. Steps that are gone, and their waits with them (as removeStep).
  if (removed.length) {
    const ids = removed.map((s) => s.id);
    await db.query('UPDATE cf_step_wait_rules SET deleted_at = NOW() WHERE company_id = ? AND flow_step_id IN (?) AND deleted_at IS NULL', [c.companyId, ids]);
    await db.query('UPDATE cf_operation_flow_steps SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, ids]);
  }
  // 2. Every step out of the way, each at a number of its own, so neither uq_cofs_operation_seq nor
  //    replaceStepOperation's same-number check can trip over a half-written order.
  const keptIds = kept.map((w) => Number(w.old.id));
  if (keptIds.length) {
    await db.query(`UPDATE cf_operation_flow_steps SET sequence = ${PARK} + FIELD(id, ?) WHERE company_id = ? AND id IN (?)`, [keptIds, c.companyId, keptIds]);
  }
  // 3. New steps, parked too. Ids are read back by their parked number — never worked out from insertId (lib/db.js).
  if (added.length) {
    const base = PARK + keptIds.length;
    added.forEach((w, i) => { w.parked = base + i + 1; });
    await insertRows(db, 'cf_operation_flow_steps', ['company_id', 'flow_id', 'sequence', 'operation_id', 'step_name', 'notes', 'created_by'],
      added.map((w) => [c.companyId, flowId, w.parked, w.op.id, w.stepName, w.notes, c.userId ?? null]));
    const [made] = await db.query('SELECT id, sequence FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id = ? AND sequence > ? AND deleted_at IS NULL', [c.companyId, flowId, base]);
    const idAt = new Map(made.map((r) => [Number(r.sequence), Number(r.id)]));
    for (const w of added) w.id = idAt.get(w.parked);
  }
  for (const w of kept) w.id = Number(w.old.id);
  // 4. Operations changed in place, with what hangs off the old one (overrides, work-order cells).
  let overridesMoved = 0, cellsMoved = 0;
  for (const w of replaced) {
    const r = await replaceStepOperation(db, c, w.id, { operationId: w.op.id }, { deferSync: true });
    overridesMoved += r.replaced.overridesMoved; cellsMoved += r.replaced.cellsMoved;
  }
  // 5. Row numbers and lanes in one statement, then names and notes where they changed.
  if (want.length) {
    const cases = want.map(() => 'WHEN ? THEN ?').join(' ');
    await db.query(
      `UPDATE cf_operation_flow_steps SET sequence = CASE id ${cases} END, lane = CASE id ${cases} END WHERE company_id = ? AND id IN (?)`,
      [...want.flatMap((w) => [w.id, w.sequence]), ...want.flatMap((w) => [w.id, w.lane]), c.companyId, want.map((w) => w.id)],
    );
  }
  for (const w of edited) {
    await db.query('UPDATE cf_operation_flow_steps SET step_name = ?, notes = ? WHERE company_id = ? AND id = ?', [w.stepName, w.notes, c.companyId, w.id]);
  }
  // 6. Waits: the ones no longer listed go, the new ones are written.
  const gone = kept.flatMap((w) => w.waitsGone);
  if (gone.length) await db.query('UPDATE cf_step_wait_rules SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, gone]);
  const newWaits = want.flatMap((w) => w.newWaits.map((x) => [c.companyId, w.id, x.relation, x.definitionId, x.operationId, x.requiredStatus, x.notes, c.userId ?? null]));
  if (newWaits.length) {
    await insertRows(db, 'cf_step_wait_rules', ['company_id', 'flow_step_id', 'relation', 'target_definition_id', 'target_operation_id', 'required_status', 'notes', 'created_by'], newWaits);
  }
  // 7. The links, against what is stored: missing ones added, the rest soft-deleted. The flow is read by them from now on.
  const [stored] = await db.query('SELECT id, step_id, after_step_id FROM cf_flow_step_links WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL', [c.companyId, flowId]);
  const wanted = new Map(want.flatMap((w) => w.after.map((k) => [`${w.id}:${byKey.get(k).id}`, [c.companyId, flowId, w.id, byKey.get(k).id, c.userId ?? null]])));
  const have = new Set(stored.map((l) => `${l.step_id}:${l.after_step_id}`));
  const dead = stored.filter((l) => !wanted.has(`${l.step_id}:${l.after_step_id}`)).map((l) => l.id);
  if (dead.length) await db.query('UPDATE cf_flow_step_links SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, dead]);
  const fresh = [...wanted].filter(([k]) => !have.has(k)).map(([, row]) => row);
  if (fresh.length) await insertRows(db, 'cf_flow_step_links', ['company_id', 'flow_id', 'step_id', 'after_step_id', 'created_by'], fresh);
  if (!flow.linked) await db.query('UPDATE cf_operation_flows SET linked = 1 WHERE company_id = ? AND id = ?', [c.companyId, flowId]);
  // 8. One sync for the whole save.
  if (operationsChanged) await syncRecordsUsingFlows(db, c, [flowId]);
  const moved = [overridesMoved && plural(overridesMoved, 'time override', 'time overrides'), cellsMoved && plural(cellsMoved, 'contractor assignment', 'contractor assignments')].filter(Boolean);
  if (moved.length) summary += ` Moved to the new operation: ${moved.join(' and ')}.`;
  return { flow: await getFlow(db, c.companyId, flowId), summary, changes, synced: operationsChanged, dryRun: false };
}

/** A flow a record or a BOM line may name: live and not obsolete. */
export async function requireUsableFlow(db, companyId, id, problems) {
  const [[f]] = await db.query('SELECT id, code, status FROM cf_operation_flows WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!f) { problems.push('That flow does not exist.'); return null; }
  if (f.status === 'obsolete') { problems.push(`Flow ${f.code} is obsolete.`); return null; }
  return f.id;
}

/* ===========================================================================
 * The flow cut plates are made by (init.sql §33)
 *
 * User, 2026-09-30: cutting moves to the cut plate — a cut plate is made by a
 * cutting flow ("CNC Cutting"), and a part's own flow no longer cuts. Cut
 * plates are made automatically (cutPlateService.refreshCutPieces) with nobody
 * there to choose a flow, so the house says once which flow a NEW cut plate
 * takes. A cut plate that already has a flow keeps it.
 * ======================================================================== */

/** { flow: { id, code, name, status } | null } — what Production › Flows shows. */
export async function getCutPlateFlow(db, companyId) {
  const [[row]] = await db.query(
    `SELECT f.id, f.code, f.name, f.status
       FROM cf_company_settings s
       JOIN cf_operation_flows f ON f.company_id = s.company_id AND f.id = s.cut_plate_flow_id AND f.deleted_at IS NULL
      WHERE s.company_id = ?`,
    [companyId],
  );
  return { flow: row ? { id: row.id, code: row.code, name: row.name, status: row.status } : null };
}

/** input: { flowId } — null clears it. */
export async function setCutPlateFlow(db, c, input = {}) {
  if (input.flowId === undefined) throw invalid('INVALID', 'Say which flow — flowId, or null for none.');
  const problems = [];
  const flowId = input.flowId == null || String(input.flowId).trim() === '' ? null : await requireUsableFlow(db, c.companyId, input.flowId, problems);
  assertNoProblems(problems);
  await db.query(
    `INSERT INTO cf_company_settings (company_id, cut_plate_flow_id, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE cut_plate_flow_id = VALUES(cut_plate_flow_id), updated_by = VALUES(updated_by)`,
    [c.companyId, flowId, c.userId ?? null],
  );
  return getCutPlateFlow(db, c.companyId);
}

/**
 * The flow id a new cut plate takes, or null: set, live and not obsolete. One
 * round trip, asked only when a derive is about to write new cut plates.
 */
export async function cutPlateFlowId(db, companyId) {
  const [[row]] = await db.query(
    `SELECT f.id FROM cf_company_settings s
       JOIN cf_operation_flows f ON f.company_id = s.company_id AND f.id = s.cut_plate_flow_id
                                AND f.deleted_at IS NULL AND f.status <> 'obsolete'
      WHERE s.company_id = ?`,
    [companyId],
  );
  return row?.id ?? null;
}

/* ===========================================================================
 * The flow cut SECTIONS are made by (init.sql §48b, CF_ERP_CUT_FROM_PLAN.md)
 *
 * The section twin of the cut-plate flow above: a cut section (a part's length
 * sawn off a stock bar) is made automatically too, so the house says once which
 * flow a new one takes. Unset: a cut section has no flow and release says so.
 * ======================================================================== */

/** { flow: { id, code, name, status } | null } */
export async function getCutSectionFlow(db, companyId) {
  const [[row]] = await db.query(
    `SELECT f.id, f.code, f.name, f.status
       FROM cf_company_settings s
       JOIN cf_operation_flows f ON f.company_id = s.company_id AND f.id = s.cut_section_flow_id AND f.deleted_at IS NULL
      WHERE s.company_id = ?`,
    [companyId],
  );
  return { flow: row ? { id: row.id, code: row.code, name: row.name, status: row.status } : null };
}

/** input: { flowId } — null clears it. */
export async function setCutSectionFlow(db, c, input = {}) {
  if (input.flowId === undefined) throw invalid('INVALID', 'Say which flow — flowId, or null for none.');
  const problems = [];
  const flowId = input.flowId == null || String(input.flowId).trim() === '' ? null : await requireUsableFlow(db, c.companyId, input.flowId, problems);
  assertNoProblems(problems);
  await db.query(
    `INSERT INTO cf_company_settings (company_id, cut_section_flow_id, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE cut_section_flow_id = VALUES(cut_section_flow_id), updated_by = VALUES(updated_by)`,
    [c.companyId, flowId, c.userId ?? null],
  );
  return getCutSectionFlow(db, c.companyId);
}

/** The flow id a new cut section takes, or null: set, live and not obsolete. One round trip. */
export async function cutSectionFlowId(db, companyId) {
  const [[row]] = await db.query(
    `SELECT f.id FROM cf_company_settings s
       JOIN cf_operation_flows f ON f.company_id = s.company_id AND f.id = s.cut_section_flow_id
                                AND f.deleted_at IS NULL AND f.status <> 'obsolete'
      WHERE s.company_id = ?`,
    [companyId],
  );
  return row?.id ?? null;
}
