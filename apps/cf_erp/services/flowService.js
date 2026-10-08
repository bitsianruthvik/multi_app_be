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

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const TRANSITIONS = { draft: ['active'], active: ['obsolete'], obsolete: ['active'] };
export const RELATIONS = ['parent', 'children', 'siblings', 'ancestor'];
const blank = (v) => v == null || String(v).trim() === '';

async function requireFlow(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_operation_flows WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Flow');
  return row;
}

async function requireStep(db, companyId, id) {
  const [[row]] = await db.query(
    `SELECT s.*, f.status AS flow_status, f.code AS flow_code FROM cf_operation_flow_steps s
       JOIN cf_operation_flows f ON f.id = s.flow_id AND f.deleted_at IS NULL
      WHERE s.company_id = ? AND s.id = ? AND s.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound('Flow step');
  return row;
}

const shapeFlow = (f) => ({
  id: f.id, code: f.code, name: f.name, description: f.description, revision: f.revision, status: f.status,
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

async function stepsOf(db, companyId, flowId) {
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
  return steps.map((s) => ({
    id: s.id,
    sequence: s.sequence,
    operation: { id: s.operation_id, code: s.operation_code, name: s.operation_name, status: s.operation_status },
    stepName: s.step_name,
    notes: s.notes,
    waits: rules.filter((w) => w.flow_step_id === s.id).map(shapeWait),
  }));
}

const RELATION_TEXT = { parent: 'its parent', children: 'its children', siblings: 'its siblings' };

/** The rule in one sentence, as the flow screen and the tracker will show it. */
export function waitText(w) {
  const madeFrom = w.definition_code ?? w.definition_name;
  const who = w.relation === 'ancestor'
    ? `the nearest ${madeFrom ?? 'ancestor'} above it`
    : `${RELATION_TEXT[w.relation]}${madeFrom && w.relation !== 'parent' ? ` made from ${madeFrom}` : ''}`;
  const plural = w.relation === 'children' || w.relation === 'siblings';
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
  out.steps = await stepsOf(db, companyId, id);
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
    const steps = await stepsOf(db, c.companyId, id);
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
  await db.query('UPDATE cf_operation_flow_steps SET deleted_at = NOW() WHERE company_id = ? AND flow_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_operation_flows SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

// --- steps --------------------------------------------------------------------

function assertEditable(flow) {
  if (flow.status === 'obsolete') throw invalid('OBSOLETE', `${flow.code} is obsolete — reactivate it to change its steps.`);
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
  if (input.sequence !== undefined) { const n = readSequence(input.sequence, problems); if (n != null) sets.sequence = n; }
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
 */
export async function replaceStepOperation(db, c, stepId, input = {}) {
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
    const flowCols = `COALESCE(bl.operation_flow_id, ch.default_flow_id, sdef.default_flow_id) AS row_flow,
                      COALESCE(lm.default_flow_id, lsd.default_flow_id) AS line_flow`;
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
  await syncRecordsUsingFlows(db, c, [step.flow_id]);
  return {
    flow: await getFlow(db, c.companyId, step.flow_id),
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
  await db.query('UPDATE cf_operation_flow_steps SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, stepId]);
  await syncRecordsUsingFlows(db, c, [step.flow_id]);
  return getFlow(db, c.companyId, step.flow_id);
}

// --- wait rules -----------------------------------------------------------------

/**
 * input: { relation, targetDefinitionId?, targetOperationId?, requiredStatus? }
 *   relation parent | children | siblings | ancestor
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
  const relation = String(input.relation ?? '');
  if (!RELATIONS.includes(relation)) problems.push('Wait for its parent, its children, its siblings or an ancestor.');
  let definitionId = null;
  if (!blank(input.targetDefinitionId)) {
    const def = await loadMaster(db, c.companyId, Number(input.targetDefinitionId));
    if (!def || def.record_kind !== 'definition' || def.definition_type !== 'template') problems.push('Narrow it with a template definition.');
    else if (def.status === 'obsolete') problems.push(`${def.code ?? def.name} is obsolete.`);
    else definitionId = def.id;
    if (relation === 'parent') problems.push('A node has one parent — there is nothing to narrow.');
  } else if (relation === 'ancestor') {
    problems.push('Say which ancestor: the nearest one made from which template definition.');
  }
  let operationId = null;
  if (!blank(input.targetOperationId)) {
    const op = await requireActiveOperation(db, c.companyId, input.targetOperationId, problems);
    operationId = op?.id ?? null;
  }
  const requiredStatus = input.requiredStatus ?? 'done';
  if (!['started', 'done'].includes(requiredStatus)) problems.push('Wait until the target has started or has finished.');
  assertNoProblems(problems, 'The wait rule has problems.');
  await db.query(
    `INSERT INTO cf_step_wait_rules (company_id, flow_step_id, relation, target_definition_id, target_operation_id, required_status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, stepId, relation, definitionId, operationId, requiredStatus, blank(input.notes) ? null : String(input.notes), c.userId],
  );
  return getFlow(db, c.companyId, step.flow_id);
}

export async function removeWaitRule(db, c, ruleId) {
  const [[rule]] = await db.query('SELECT * FROM cf_step_wait_rules WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, ruleId]);
  if (!rule) throw notFound('Wait rule');
  const step = await requireStep(db, c.companyId, rule.flow_step_id);
  if (step.flow_status === 'obsolete') throw invalid('OBSOLETE', `${step.flow_code} is obsolete — reactivate it to change its steps.`);
  await db.query('UPDATE cf_step_wait_rules SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, ruleId]);
  return getFlow(db, c.companyId, step.flow_id);
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
