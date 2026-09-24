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
  const [rows] = await db.query(
    `SELECT f.*,
            (SELECT COUNT(*) FROM cf_operation_flow_steps s WHERE s.company_id = f.company_id AND s.flow_id = f.id AND s.deleted_at IS NULL) AS step_count,
            (SELECT COUNT(*) FROM cf_master_records m WHERE m.company_id = f.company_id AND m.default_flow_id = f.id AND m.deleted_at IS NULL)
            + (SELECT COUNT(*) FROM cf_bom_lines l WHERE l.company_id = f.company_id AND l.operation_flow_id = f.id AND l.deleted_at IS NULL) AS used_by
       FROM cf_operation_flows f WHERE ${where.join(' AND ')} ORDER BY f.code`,
    params,
  );
  return rows.map(shapeFlow);
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
    `SELECT m.id, m.code, m.name, m.record_kind, i.item_type, d.definition_type FROM cf_master_records m
       LEFT JOIN cf_item_details i ON i.master_id = m.id LEFT JOIN cf_definition_details d ON d.master_id = m.id
      WHERE m.company_id = ? AND m.default_flow_id = ? AND m.deleted_at IS NULL ORDER BY m.code LIMIT 100`,
    [companyId, id],
  );
  const [[{ line_count: lines }]] = await db.query('SELECT COUNT(*) AS line_count FROM cf_bom_lines WHERE company_id = ? AND operation_flow_id = ? AND deleted_at IS NULL', [companyId, id]);
  out.uses = {
    records: records.map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.record_kind === 'item' ? r.item_type : r.definition_type })),
    bomLines: Number(lines),
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
  const [[o]] = await db.query('SELECT id, code, status FROM cf_operations WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
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
  return getFlow(db, c.companyId, flowId);
}

/** input: { sequence?, stepName?, notes? } — the operation of a step does not change; remove it and add another. */
export async function updateStep(db, c, stepId, input = {}) {
  const step = await requireStep(db, c.companyId, stepId);
  if (step.flow_status === 'obsolete') throw invalid('OBSOLETE', `${step.flow_code} is obsolete — reactivate it to change its steps.`);
  if (input.operationId !== undefined && Number(input.operationId) !== step.operation_id) {
    throw invalid('IDENTITY', 'A step keeps its operation — remove it and add a step with the other one.');
  }
  const problems = [];
  const sets = {};
  if (input.sequence !== undefined) { const n = readSequence(input.sequence, problems); if (n != null) sets.sequence = n; }
  if (input.stepName !== undefined) sets.step_name = blank(input.stepName) ? null : String(input.stepName).trim().slice(0, 100);
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : String(input.notes);
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_operation_flow_steps SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, stepId]);
  }
  return getFlow(db, c.companyId, step.flow_id);
}

export async function removeStep(db, c, stepId) {
  const step = await requireStep(db, c.companyId, stepId);
  if (step.flow_status === 'obsolete') throw invalid('OBSOLETE', `${step.flow_code} is obsolete — reactivate it to change its steps.`);
  await db.query('UPDATE cf_step_wait_rules SET deleted_at = NOW() WHERE company_id = ? AND flow_step_id = ? AND deleted_at IS NULL', [c.companyId, stepId]);
  await db.query('UPDATE cf_operation_flow_steps SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, stepId]);
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
