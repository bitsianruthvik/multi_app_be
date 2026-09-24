/**
 * operationService.js — operations, and which machines can do them in how long.
 *
 * Machine rules (cf_operation_machine_rules) are set per machine TYPE — any
 * level of the tree — and optionally per machine. For one machine, the most
 * specific rule valid on the day wins, the way specification rules do: a rule
 * on the machine beats its Variant, which beats its Subfamily, which beats its
 * Family. eligible = 0 on a deeper rule takes a type or a machine out.
 *
 * Each time is a constant or a formula, in minutes; setup is per run and work
 * per piece. Timing formulas read item.<SPEC> and machine.<SPEC>, so a single
 * rule — "work = item.CUT_LENGTH / machine.CUTTING_SPEED" on the Cutting family —
 * gives every cutting machine its own time from its own speed.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { ancestors, levelName, loadNode } from './tree.js';
import { loadMaster, requireMachine, loadMachine } from './records.js';
import { resolve, effectiveByCode, dateText } from './resolutionService.js';
import { parseFormula, evaluateFormula } from './formulaEngine.js';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v) => v == null || String(v).trim() === '';
const today = () => dateText(new Date());

async function requireOperation(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_operations WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Operation');
  return row;
}

const shapeOp = (o) => ({
  id: o.id, code: o.code, name: o.name, description: o.description, status: o.status,
  flowCount: o.flow_count == null ? undefined : Number(o.flow_count),
  ruleCount: o.rule_count == null ? undefined : Number(o.rule_count),
  createdAt: o.created_at, updatedAt: o.updated_at,
});

export async function listOperations(db, companyId, q = {}) {
  const where = ['o.company_id = ?', 'o.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.status)) { where.push('o.status = ?'); params.push(q.status); }
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push('(o.code LIKE ? OR o.name LIKE ?)');
    params.push(like, like);
  }
  const [rows] = await db.query(
    `SELECT o.*,
            (SELECT COUNT(DISTINCT s.flow_id) FROM cf_operation_flow_steps s WHERE s.company_id = o.company_id AND s.operation_id = o.id AND s.deleted_at IS NULL) AS flow_count,
            (SELECT COUNT(*) FROM cf_operation_machine_rules r WHERE r.company_id = o.company_id AND r.operation_id = o.id AND r.deleted_at IS NULL) AS rule_count
       FROM cf_operations o WHERE ${where.join(' AND ')} ORDER BY o.code`,
    params,
  );
  return rows.map(shapeOp);
}

export async function getOperation(db, companyId, id) {
  const o = await requireOperation(db, companyId, id);
  const out = shapeOp(o);
  out.rules = await listTimingRules(db, companyId, id);
  const [flows] = await db.query(
    // A flow may run one operation more than once, so DISTINCT over a row
    // carrying s.sequence would list the same flow once per pass. Group it:
    // the sequence shown is where the operation FIRST comes up, and `times`
    // says how many passes there are.
    `SELECT f.id, f.code, f.name, f.status, MIN(s.sequence) AS sequence, COUNT(*) AS times
       FROM cf_operation_flow_steps s JOIN cf_operation_flows f ON f.id = s.flow_id AND f.deleted_at IS NULL
      WHERE s.company_id = ? AND s.operation_id = ? AND s.deleted_at IS NULL
      GROUP BY f.id, f.code, f.name, f.status ORDER BY f.code`,
    [companyId, id],
  );
  out.flows = flows.map((f) => ({ id: f.id, code: f.code, name: f.name, status: f.status, sequence: f.sequence, times: Number(f.times) }));
  out.machines = await machinesForOperation(db, companyId, id);
  return out;
}

function readOp(input, problems, partial) {
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
  if (input.status !== undefined) {
    if (!['active', 'inactive'].includes(input.status)) problems.push('Status is active or inactive.');
    out.status = input.status;
  }
  return out;
}

export async function createOperation(db, c, input = {}) {
  const problems = [];
  const f = readOp(input, problems, false);
  assertNoProblems(problems);
  const [r] = await db.query(
    'INSERT INTO cf_operations (company_id, code, name, description, status, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [c.companyId, f.code, f.name, f.description ?? null, f.status ?? 'active', c.userId],
  );
  return getOperation(db, c.companyId, r.insertId);
}

export async function updateOperation(db, c, id, input = {}) {
  await requireOperation(db, c.companyId, id);
  const problems = [];
  const f = readOp(input, problems, true);
  assertNoProblems(problems);
  if (Object.keys(f).length) {
    await db.query(`UPDATE cf_operations SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(f), c.companyId, id]);
  }
  return getOperation(db, c.companyId, id);
}

export async function deleteOperation(db, c, id) {
  const o = await requireOperation(db, c.companyId, id);
  const reasons = [];
  const [flows] = await db.query(
    `SELECT DISTINCT f.code FROM cf_operation_flow_steps s JOIN cf_operation_flows f ON f.id = s.flow_id AND f.deleted_at IS NULL
      WHERE s.company_id = ? AND s.operation_id = ? AND s.deleted_at IS NULL LIMIT 6`, [c.companyId, id]);
  if (flows.length) reasons.push(`it is a step of flow ${flows.map((f) => f.code).join(', ')}`);
  const [[{ waits }]] = await db.query('SELECT COUNT(*) AS waits FROM cf_step_wait_rules WHERE company_id = ? AND target_operation_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (Number(waits)) reasons.push(`${waits} wait rule(s) wait for it`);
  if (reasons.length) throw conflict('IN_USE', `${o.code} cannot be deleted: ${reasons.join('; ')}. Mark it inactive instead.`, { problems: reasons });
  await db.query('UPDATE cf_operation_machine_rules SET deleted_at = NOW() WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_operations SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

// --- machine rules ------------------------------------------------------------

const RULE_SELECT = `SELECT r.*, sf.code AS setup_formula_code, sf.expression AS setup_expression, wf.code AS work_formula_code, wf.expression AS work_expression,
       n.code AS node_code, n.name AS node_name, n.depth AS node_depth, mc.code AS machine_code, mc.name AS machine_name
  FROM cf_operation_machine_rules r
  LEFT JOIN cf_formulas sf ON sf.id = r.setup_formula_id
  LEFT JOIN cf_formulas wf ON wf.id = r.work_formula_id
  LEFT JOIN cf_classification_nodes n ON r.subject_type = 'classification' AND n.id = r.subject_id
  LEFT JOIN cf_machines mc ON r.subject_type = 'machine' AND mc.id = r.subject_id`;

function shapeRule(r) {
  const time = (minutes, formulaId, code, expression) => (minutes != null
    ? { minutes: Number(minutes), formula: null }
    : formulaId ? { minutes: null, formula: { id: formulaId, code, expression } } : null);
  return {
    id: r.id,
    operationId: r.operation_id,
    subject: r.subject_type === 'machine'
      ? { type: 'machine', id: r.subject_id, code: r.machine_code, name: r.machine_name, level: 'Machine' }
      : { type: 'classification', id: r.subject_id, code: r.node_code, name: r.node_name, level: levelName(r.node_depth) },
    eligible: !!r.eligible,
    setup: time(r.setup_minutes, r.setup_formula_id, r.setup_formula_code, r.setup_expression),
    work: time(r.work_minutes, r.work_formula_id, r.work_formula_code, r.work_expression),
    effectiveFrom: dateText(r.effective_from),
    effectiveTo: dateText(r.effective_to),
    notes: r.notes,
  };
}

export async function listTimingRules(db, companyId, operationId) {
  const [rows] = await db.query(`${RULE_SELECT} WHERE r.company_id = ? AND r.operation_id = ? AND r.deleted_at IS NULL
    ORDER BY r.subject_type = 'machine', n.depth, r.effective_from`, [companyId, operationId]);
  return rows.map(shapeRule);
}

/** A timing formula reads item. and machine. values; a constant expression works too. */
async function readTimingFormula(db, companyId, raw, label, problems) {
  if (blank(raw)) return null;
  const [[f]] = await db.query('SELECT id, code, expression, status FROM cf_formulas WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(raw)]);
  if (!f) { problems.push(`${label}: that formula does not exist.`); return null; }
  if (f.status !== 'active') problems.push(`${label}: formula ${f.code} is inactive.`);
  const parsed = parseFormula(f.expression);
  if (parsed.kind === 'rollup' || (parsed.kind === 'value' && parsed.references.length)) {
    problems.push(`${label}: ${f.code} reads values of one record — a timing formula reads item.X and machine.X, e.g. item.CUT_LENGTH / machine.CUTTING_SPEED.`);
  }
  return f.id;
}

function readMinutes(raw, label, problems) {
  if (blank(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1e6) { problems.push(`${label} is a number of minutes, zero or more.`); return null; }
  return Number(n.toFixed(4));
}

function readDate(raw, label, problems) {
  if (blank(raw)) return null;
  const s = String(raw).trim();
  const d = new Date(`${s}T00:00:00`);
  if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || dateText(d) !== s) { problems.push(`${label} needs a date as YYYY-MM-DD.`); return null; }
  return s;
}

async function readRuleBody(db, companyId, input, problems, existing = null) {
  const pick = (k, fallback) => (input[k] !== undefined ? input[k] : fallback);
  const eligible = pick('eligible', existing ? !!existing.eligible : true) !== false;
  const out = { eligible };
  const setupMinutes = readMinutes(pick('setupMinutes', existing?.setup_minutes), 'Setup', problems);
  const setupFormulaId = await readTimingFormula(db, companyId, pick('setupFormulaId', existing?.setup_formula_id), 'Setup', problems);
  const workMinutes = readMinutes(pick('workMinutes', existing?.work_minutes), 'Work', problems);
  const workFormulaId = await readTimingFormula(db, companyId, pick('workFormulaId', existing?.work_formula_id), 'Work', problems);
  if (setupMinutes != null && setupFormulaId) problems.push('Setup is a constant or a formula, not both.');
  if (workMinutes != null && workFormulaId) problems.push('Work is a constant or a formula, not both.');
  // A rule that takes machines out carries no times.
  Object.assign(out, eligible
    ? { setup_minutes: setupMinutes, setup_formula_id: setupFormulaId, work_minutes: workMinutes, work_formula_id: workFormulaId }
    : { setup_minutes: null, setup_formula_id: null, work_minutes: null, work_formula_id: null });
  out.effective_from = readDate(pick('effectiveFrom', dateText(existing?.effective_from)), 'Valid from', problems);
  out.effective_to = readDate(pick('effectiveTo', dateText(existing?.effective_to)), 'Valid to', problems);
  if (out.effective_from && out.effective_to && out.effective_from > out.effective_to) problems.push('Valid from comes after valid to.');
  const notes = pick('notes', existing?.notes);
  out.notes = blank(notes) ? null : String(notes);
  return out;
}

async function checkSubject(db, companyId, subjectType, subjectId, problems) {
  if (subjectType === 'classification') {
    const n = await loadNode(db, companyId, subjectId);
    if (!n) problems.push('That machine type does not exist.');
    else if (n.scope !== 'machine') problems.push(`${n.name} is not in a machine family — timing is set on a machine type or a machine.`);
    return;
  }
  if (subjectType === 'machine') {
    if (!(await loadMachine(db, companyId, subjectId))) problems.push('That machine does not exist.');
    return;
  }
  problems.push('A rule is for a machine type or a machine.');
}

/** input: { subjectType, subjectId, eligible?, setupMinutes | setupFormulaId, workMinutes | workFormulaId, effectiveFrom?, effectiveTo?, notes? } */
export async function createTimingRule(db, c, operationId, input = {}) {
  await requireOperation(db, c.companyId, operationId);
  const problems = [];
  const subjectType = input.subjectType;
  const subjectId = Number(input.subjectId);
  await checkSubject(db, c.companyId, subjectType, subjectId, problems);
  const body = await readRuleBody(db, c.companyId, input, problems);
  assertNoProblems(problems, 'The rule has problems.');
  const [r] = await db.query(
    `INSERT INTO cf_operation_machine_rules
       (company_id, operation_id, subject_type, subject_id, eligible, setup_minutes, setup_formula_id, work_minutes, work_formula_id, effective_from, effective_to, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, operationId, subjectType, subjectId, body.eligible ? 1 : 0, body.setup_minutes, body.setup_formula_id,
      body.work_minutes, body.work_formula_id, body.effective_from, body.effective_to, body.notes, c.userId],
  );
  return (await listTimingRules(db, c.companyId, operationId)).find((x) => x.id === r.insertId);
}

async function requireRule(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_operation_machine_rules WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Machine rule');
  return row;
}

export async function updateTimingRule(db, c, id, input = {}) {
  const rule = await requireRule(db, c.companyId, id);
  if ((input.subjectType !== undefined && input.subjectType !== rule.subject_type) || (input.subjectId !== undefined && Number(input.subjectId) !== rule.subject_id)) {
    throw invalid('IDENTITY', 'Who a rule is for cannot change — delete it and add another.');
  }
  const problems = [];
  const body = await readRuleBody(db, c.companyId, input, problems, rule);
  assertNoProblems(problems, 'The rule has problems.');
  await db.query(
    `UPDATE cf_operation_machine_rules SET eligible = ?, setup_minutes = ?, setup_formula_id = ?, work_minutes = ?, work_formula_id = ?,
            effective_from = ?, effective_to = ?, notes = ? WHERE company_id = ? AND id = ?`,
    [body.eligible ? 1 : 0, body.setup_minutes, body.setup_formula_id, body.work_minutes, body.work_formula_id,
      body.effective_from, body.effective_to, body.notes, c.companyId, id],
  );
  return (await listTimingRules(db, c.companyId, rule.operation_id)).find((x) => x.id === id);
}

export async function deleteTimingRule(db, c, id) {
  await requireRule(db, c.companyId, id);
  await db.query('UPDATE cf_operation_machine_rules SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

/**
 * The rule that decides whether a machine can do an operation on a day, and
 * where it was set: the machine itself, else the deepest machine type above it.
 * Among rules on the same subject, the one that started latest wins.
 */
export async function resolveTiming(db, companyId, operationId, machine, date = today()) {
  const nodes = await ancestors(db, companyId, machine.classification_id);
  const rankOf = new Map(nodes.map((n) => [`classification:${n.id}`, n.depth]));
  rankOf.set(`machine:${machine.id}`, 99);
  const [rows] = await db.query(
    `${RULE_SELECT}
      WHERE r.company_id = ? AND r.operation_id = ? AND r.deleted_at IS NULL
        AND ((r.subject_type = 'classification' AND r.subject_id IN (?)) OR (r.subject_type = 'machine' AND r.subject_id = ?))
        AND (r.effective_from IS NULL OR r.effective_from <= ?) AND (r.effective_to IS NULL OR r.effective_to >= ?)`,
    [companyId, operationId, nodes.length ? nodes.map((n) => n.id) : [0], machine.id, date, date],
  );
  if (!rows.length) return null;
  rows.sort((a, b) => (rankOf.get(`${b.subject_type}:${b.subject_id}`) - rankOf.get(`${a.subject_type}:${a.subject_id}`))
    || String(dateText(b.effective_from) ?? '').localeCompare(String(dateText(a.effective_from) ?? '')));
  return shapeRule(rows[0]);
}

/** Every active machine an operation's rules reach, eligible first. */
export async function machinesForOperation(db, companyId, operationId, date = today()) {
  const [machines] = await db.query("SELECT * FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY code", [companyId]);
  const out = [];
  for (const m of machines) {
    const rule = await resolveTiming(db, companyId, operationId, m, date);
    if (rule) out.push({ machine: { id: m.id, code: m.code, name: m.name }, eligible: rule.eligible, from: rule.subject, setup: rule.setup, work: rule.work });
  }
  return out.sort((a, b) => Number(b.eligible) - Number(a.eligible));
}

/** Every active operation a machine has a rule for — what it can (and cannot) do. */
export async function operationsForMachine(db, companyId, machine, date = today()) {
  const [ops] = await db.query("SELECT * FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY code", [companyId]);
  const out = [];
  for (const o of ops) {
    const rule = await resolveTiming(db, companyId, o.id, machine, date);
    if (rule) out.push({ operation: { id: o.id, code: o.code, name: o.name }, eligible: rule.eligible, from: rule.subject, setup: rule.setup, work: rule.work });
  }
  return out;
}

const numericValues = (resolution) => {
  const map = effectiveByCode(resolution);
  return (code) => {
    const v = map.get(code);
    return v && v.dataType === 'number' ? v.raw : null;
  };
};

/**
 * How long a machine takes to do an operation on an item: setup (per run) plus
 * work (per piece) × quantity, from the rule that applies, with its formulas
 * fed the item's and the machine's own values. Missing inputs are named.
 */
export async function timingPreview(db, companyId, operationId, input = {}) {
  const op = await requireOperation(db, companyId, operationId);
  if (blank(input.machineId)) throw invalid('INVALID', 'Choose a machine to time.');
  const machine = await requireMachine(db, companyId, Number(input.machineId));
  const quantity = blank(input.quantity) ? 1 : Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw invalid('INVALID', 'Quantity must be more than zero.');
  const date = blank(input.date) ? today() : String(input.date);
  const rule = await resolveTiming(db, companyId, operationId, machine, date);
  const base = { operation: { id: op.id, code: op.code, name: op.name }, machine: { id: machine.id, code: machine.code, name: machine.name }, quantity, date };
  if (!rule) return { ...base, eligible: false, reason: `No rule lets ${machine.code} do ${op.code}.` };
  if (!rule.eligible) return { ...base, eligible: false, from: rule.subject, reason: `${machine.code} is taken out of ${op.code} at ${rule.subject.level.toLowerCase()} ${rule.subject.code ?? rule.subject.name}.` };

  let item = null;
  if (!blank(input.itemId)) {
    item = await loadMaster(db, companyId, Number(input.itemId));
    if (!item || item.record_kind !== 'item') throw invalid('INVALID', 'Choose an item to time.');
  }
  const context = {
    item: item ? numericValues(await resolve(db, companyId, { master: item })) : () => null,
    machine: numericValues(await resolve(db, companyId, { machine })),
  };
  // No setup on the rule means none; no work time means the rule is not finished.
  const evaluate = (time, what) => {
    if (!time) return what === 'setup' ? { minutes: 0, formula: null } : { minutes: null, formula: null, error: 'The rule sets no work time.' };
    if (time.minutes != null) return { minutes: time.minutes, formula: null };
    const out = evaluateFormula(parseFormula(time.formula.expression), () => null, null, context);
    return { minutes: out.value, formula: time.formula.code, missing: out.missing, error: out.error };
  };
  const setup = evaluate(rule.setup, 'setup');
  const work = evaluate(rule.work, 'work');
  const total = setup.minutes != null && work.minutes != null ? Number((setup.minutes + work.minutes * quantity).toFixed(4)) : null;
  return {
    ...base,
    item: item ? { id: item.id, code: item.code, name: item.name } : null,
    eligible: true,
    from: rule.subject,
    setupMinutes: setup.minutes,
    workMinutesPerPiece: work.minutes,
    totalMinutes: total,
    setup,
    work,
  };
}
