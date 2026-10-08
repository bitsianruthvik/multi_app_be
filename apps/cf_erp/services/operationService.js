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
import { ancestors, levelName, loadNode, LEAF_DEPTH } from './tree.js';
import { loadMaster, requireMachine, loadMachine } from './records.js';
import { resolve, effectiveByCode, dateText } from './resolutionService.js';
import { parseFormula, evaluateFormula } from './formulaEngine.js';
import { syncRecordsUsingOperation } from './flowSpecService.js';

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
  const out = rows.map(shapeOp);
  // The row's headline: ONE read of every rule of the company (the list is a few dozen
  // operations; a call per row costs ~49 ms each on the production link), grouped here.
  if (out.length) {
    const [rules] = await db.query(`${RULE_SELECT} WHERE r.company_id = ? AND r.deleted_at IS NULL ORDER BY r.operation_id, r.id`, [companyId]);
    const byOp = new Map();
    for (const r of rules) { if (!byOp.has(r.operation_id)) byOp.set(r.operation_id, []); byOp.get(r.operation_id).push(r); }
    for (const o of out) o.mainRule = mainRuleOf(byOp.get(o.id) ?? []);
  }
  return out;
}

/**
 * The rule a list row shows: one on a machine type before one on a single machine, a rule valid
 * today before a dated-out one, one that lets machines in before one that keeps them out, then the
 * higher level of the tree, then the oldest. Null when the operation has no rule.
 */
export function mainRuleOf(rules, date = today()) {
  if (!rules.length) return null;
  const validToday = (r) => (!r.effective_from || dateText(r.effective_from) <= date) && (!r.effective_to || dateText(r.effective_to) >= date);
  const rank = (r) => [r.subject_type === 'classification' ? 0 : 1, validToday(r) ? 0 : 1, r.eligible ? 0 : 1, r.node_depth ?? 99, r.id];
  const best = [...rules].sort((a, b) => { const x = rank(a); const y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; })[0];
  return shapeRule(best);
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
  clearProductionMachines(c.companyId);
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
  clearProductionMachines(c.companyId);
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
  clearProductionMachines(c.companyId);
  return { ok: true };
}

// --- machine rules ------------------------------------------------------------

// A rule's times are its OWN expressions (§49, 2026-10-08: "all formulas on the operation");
// a rule still pointing at a shared formula (before the move) reads that formula's expression.
const RULE_SELECT = `SELECT r.*, sf.code AS setup_formula_code, sf.expression AS setup_formula_expression, wf.code AS work_formula_code, wf.expression AS work_formula_expression,
       n.code AS node_code, n.name AS node_name, n.depth AS node_depth, mc.code AS machine_code, mc.name AS machine_name
  FROM cf_operation_machine_rules r
  LEFT JOIN cf_formulas sf ON sf.id = r.setup_formula_id
  LEFT JOIN cf_formulas wf ON wf.id = r.work_formula_id
  LEFT JOIN cf_classification_nodes n ON r.subject_type = 'classification' AND n.id = r.subject_id
  LEFT JOIN cf_machines mc ON r.subject_type = 'machine' AND mc.id = r.subject_id`;

function shapeRule(r) {
  // { minutes, formula: { id, code, expression }, expression } — the rule's own expression has no
  // formula id or code; `expression` is always the text the time is worked out from.
  const time = (minutes, formulaId, code, formulaExpression, own) => {
    if (!blank(own)) return { minutes: null, expression: own, formula: { id: null, code: null, expression: own } };
    if (minutes != null) return { minutes: Number(minutes), expression: String(Number(minutes)), formula: null };
    return formulaId ? { minutes: null, expression: formulaExpression, formula: { id: formulaId, code, expression: formulaExpression } } : null;
  };
  return {
    id: r.id,
    operationId: r.operation_id,
    subject: r.subject_type === 'machine'
      ? { type: 'machine', id: r.subject_id, code: r.machine_code, name: r.machine_name, level: 'Machine' }
      : { type: 'classification', id: r.subject_id, code: r.node_code, name: r.node_name, level: levelName(r.node_depth) },
    eligible: !!r.eligible,
    setup: time(r.setup_minutes, r.setup_formula_id, r.setup_formula_code, r.setup_formula_expression, r.setup_expression),
    work: time(r.work_minutes, r.work_formula_id, r.work_formula_code, r.work_formula_expression, r.work_expression),
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

/**
 * A rule's own time expression (§49): item.X and machine.X values, LOOKUP, MIN/MAX/ROUND/IF — or
 * just a number for a fixed time. '' / null clears it. Returns undefined when not given.
 */
function readTimingExpression(raw, label, problems) {
  if (raw === undefined) return undefined;
  if (blank(raw)) return null;
  const expression = String(raw).trim();
  if (expression.length > 2000) { problems.push(`${label}: the formula is longer than 2,000 characters.`); return null; }
  let parsed;
  try { parsed = parseFormula(expression); } catch (e) { problems.push(`${label}: ${e.message}`); return null; }
  if (parsed.kind === 'rollup' || (parsed.kind === 'value' && parsed.references.length)) {
    problems.push(`${label}: a time reads item.X and machine.X values (e.g. item.CUT_LENGTH / machine.CUTTING_SPEED), or is a number of minutes.`);
    return null;
  }
  return expression;
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
  // §49: an expression given replaces whatever the time was (minutes, a shared formula); not given
  // keeps the rule's own expression as it is.
  const setupExpr = readTimingExpression(input.setupExpression, 'Setup', problems);
  const workExpr = readTimingExpression(input.workExpression, 'Work', problems);
  const times = {
    setup_minutes: setupMinutes, setup_formula_id: setupFormulaId, setup_expression: existing?.setup_expression ?? null,
    work_minutes: workMinutes, work_formula_id: workFormulaId, work_expression: existing?.work_expression ?? null,
  };
  if (setupExpr !== undefined) Object.assign(times, { setup_expression: setupExpr, setup_minutes: null, setup_formula_id: null });
  if (workExpr !== undefined) Object.assign(times, { work_expression: workExpr, work_minutes: null, work_formula_id: null });
  // Minutes or a formula given the old way replace an own expression.
  if (setupExpr === undefined && (input.setupMinutes !== undefined || input.setupFormulaId !== undefined)) times.setup_expression = null;
  if (workExpr === undefined && (input.workMinutes !== undefined || input.workFormulaId !== undefined)) times.work_expression = null;
  // A rule that takes machines out carries no times.
  Object.assign(out, eligible ? times
    : { setup_minutes: null, setup_formula_id: null, setup_expression: null, work_minutes: null, work_formula_id: null, work_expression: null });
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

/** input: { subjectType, subjectId, eligible?, setupExpression?, workExpression? (or the older setupMinutes | setupFormulaId, workMinutes | workFormulaId), effectiveFrom?, effectiveTo?, notes? } */
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
       (company_id, operation_id, subject_type, subject_id, eligible, setup_minutes, setup_formula_id, setup_expression, work_minutes, work_formula_id, work_expression, effective_from, effective_to, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, operationId, subjectType, subjectId, body.eligible ? 1 : 0, body.setup_minutes, body.setup_formula_id, body.setup_expression,
      body.work_minutes, body.work_formula_id, body.work_expression, body.effective_from, body.effective_to, body.notes, c.userId],
  );
  clearProductionMachines(c.companyId);
  await syncRecordsUsingOperation(db, c, operationId);
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
    `UPDATE cf_operation_machine_rules SET eligible = ?, setup_minutes = ?, setup_formula_id = ?, setup_expression = ?, work_minutes = ?, work_formula_id = ?, work_expression = ?,
            effective_from = ?, effective_to = ?, notes = ? WHERE company_id = ? AND id = ?`,
    [body.eligible ? 1 : 0, body.setup_minutes, body.setup_formula_id, body.setup_expression, body.work_minutes, body.work_formula_id, body.work_expression,
      body.effective_from, body.effective_to, body.notes, c.companyId, id],
  );
  clearProductionMachines(c.companyId);
  await syncRecordsUsingOperation(db, c, rule.operation_id);
  return (await listTimingRules(db, c.companyId, rule.operation_id)).find((x) => x.id === id);
}

export async function deleteTimingRule(db, c, id) {
  await requireRule(db, c.companyId, id);
  await db.query('UPDATE cf_operation_machine_rules SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  clearProductionMachines(c.companyId);
  await syncRecordsUsingOperation(db, c, (await db.query('SELECT operation_id FROM cf_operation_machine_rules WHERE company_id = ? AND id = ?', [c.companyId, id]))[0][0].operation_id);
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
  // One read of the rules, not one per asset. The plant register can include
  // hundreds of tools and panels that have no rule for this operation at all.
  const [rules] = await db.query(`${RULE_SELECT} WHERE r.company_id = ? AND r.operation_id = ? AND r.deleted_at IS NULL
    AND (r.effective_from IS NULL OR r.effective_from <= ?) AND (r.effective_to IS NULL OR r.effective_to >= ?)`, [companyId, operationId, date, date]);
  if (!rules.length) return [];
  const [machines] = await db.query("SELECT * FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY code", [companyId]);
  const [nodes] = await db.query('SELECT id,parent_id,depth FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const bySubject = new Map();
  for (const r of rules) {
    const key = `${r.subject_type}:${r.subject_id}`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(r);
  }
  const out = [];
  for (const m of machines) {
    const rank = new Map([[`machine:${m.id}`, 99]]);
    // Match ancestors()' chain bound, including its handling of a missing
    // parent. This map lives only for this read and never crosses requests.
    let node = byId.get(m.classification_id);
    for (let hop = 0; node && hop < LEAF_DEPTH + 3; hop++, node = byId.get(node.parent_id)) rank.set(`classification:${node.id}`, node.depth);
    const candidates = [...rank.keys()].flatMap((key) => bySubject.get(key) ?? []);
    const rule = winningTiming(candidates, rank);
    if (rule) out.push({ machine: { id: m.id, code: m.code, name: m.name }, eligible: rule.eligible, from: rule.subject, setup: rule.setup, work: rule.work });
  }
  return out.sort((a, b) => Number(b.eligible) - Number(a.eligible));
}

// --- production machines -----------------------------------------------------------

/**
 * Which machines are PRODUCTION machines: some active operation can run on them.
 * A machine qualifies when, for at least one active operation, the winning timing
 * rule valid today (the machine's own, else the deepest machine type above it —
 * the same precedence as operationsForMachine) is eligible. Contractor rules name
 * no machine, so they never count. The plant register also holds vehicles, panels
 * and tools that no operation reaches; production screens hide those.
 *
 * Set-based: 3 reads however many machines. Cached 60 s per company; every write
 * that can change the answer (rules, operations, machines, the tree) calls
 * clearProductionMachines.
 */
const PRODUCTION_TTL_MS = 60_000;
const productionCache = new Map();
export function clearProductionMachines(companyId) {
  if (companyId == null) productionCache.clear(); else productionCache.delete(Number(companyId));
}

export async function productionMachineIds(db, companyId, date = today()) {
  const hit = productionCache.get(Number(companyId));
  if (hit && hit.date === date && Date.now() - hit.at < PRODUCTION_TTL_MS) return hit.ids;
  const [[rules], [machines], [nodes]] = await Promise.all([
    db.query(
      `SELECT r.operation_id, r.subject_type, r.subject_id, r.eligible, r.effective_from
         FROM cf_operation_machine_rules r
         JOIN cf_operations o ON o.id = r.operation_id AND o.company_id = r.company_id AND o.deleted_at IS NULL AND o.status = 'active'
        WHERE r.company_id = ? AND r.deleted_at IS NULL
          AND (r.effective_from IS NULL OR r.effective_from <= ?) AND (r.effective_to IS NULL OR r.effective_to >= ?)`,
      [companyId, date, date],
    ),
    db.query('SELECT id, classification_id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    db.query('SELECT id, parent_id, depth FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
  ]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const bySubject = new Map();
  for (const r of rules) {
    const key = `${r.subject_type}:${r.subject_id}`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(r);
  }
  const ids = new Set();
  for (const m of machines) {
    const rank = new Map([[`machine:${m.id}`, 99]]);
    let node = byId.get(m.classification_id);
    for (let hop = 0; node && hop < LEAF_DEPTH + 3; hop++, node = byId.get(node.parent_id)) rank.set(`classification:${node.id}`, node.depth);
    const best = new Map(); // operation id -> { r, rk } the winning rule
    for (const [key, rk] of rank) {
      for (const r of bySubject.get(key) ?? []) {
        const cur = best.get(r.operation_id);
        if (!cur || rk > cur.rk || (rk === cur.rk && String(dateText(r.effective_from) ?? '') > String(dateText(cur.r.effective_from) ?? ''))) best.set(r.operation_id, { r, rk });
      }
    }
    for (const { r } of best.values()) if (r.eligible) { ids.add(m.id); break; }
  }
  productionCache.set(Number(companyId), { at: Date.now(), date, ids });
  return ids;
}

/** Every active operation a machine has a rule for — what it can (and cannot) do. */
export async function operationsForMachine(db, companyId, machine, date = today()) {
  const [ops] = await db.query("SELECT * FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY code", [companyId]);
  if (!ops.length) return [];
  const nodes = await ancestors(db, companyId, machine.classification_id);
  const rank = new Map(nodes.map((n) => [`classification:${n.id}`, n.depth]));
  rank.set(`machine:${machine.id}`, 99);
  const [rules] = await db.query(`${RULE_SELECT} WHERE r.company_id = ? AND r.operation_id IN (?) AND r.deleted_at IS NULL
    AND ((r.subject_type = 'classification' AND r.subject_id IN (?)) OR (r.subject_type = 'machine' AND r.subject_id = ?))
    AND (r.effective_from IS NULL OR r.effective_from <= ?) AND (r.effective_to IS NULL OR r.effective_to >= ?)`,
  [companyId, ops.map((o) => o.id), nodes.length ? nodes.map((n) => n.id) : [0], machine.id, date, date]);
  const byOperation = new Map();
  for (const r of rules) {
    if (!byOperation.has(r.operation_id)) byOperation.set(r.operation_id, []);
    byOperation.get(r.operation_id).push(r);
  }
  const out = [];
  for (const o of ops) {
    const rule = winningTiming(byOperation.get(o.id) ?? [], rank);
    if (rule) out.push({ operation: { id: o.id, code: o.code, name: o.name }, eligible: rule.eligible, from: rule.subject, setup: rule.setup, work: rule.work });
  }
  return out;
}

/** Same precedence as resolveTiming; callers already filtered validity dates. */
function winningTiming(rows, rank) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => (rank.get(`${b.subject_type}:${b.subject_id}`) - rank.get(`${a.subject_type}:${a.subject_id}`))
    || String(dateText(b.effective_from) ?? '').localeCompare(String(dateText(a.effective_from) ?? '')));
  return shapeRule(sorted[0]);
}

/**
 * The two readers a timing formula takes for one subject, from a map of
 * spec code -> { raw, dataType, tableConfig } (effectiveByCode's shape). Shared
 * by timingPreview (one machine, one item) and timeEstimateService (every row of
 * an order line at once), so both read values the same way.
 */
export function valueReaders(map) {
  return {
    number: (code) => {
      const v = map.get(code);
      return v && v.dataType === 'number' ? v.raw : null;
    },
    // LOOKUP's own reader.
    table: (code) => {
      const v = map.get(code);
      if (!v || v.dataType !== 'table' || v.raw == null) return null;
      return { mode: v.tableConfig?.mode ?? 'step_up', axes: v.tableConfig?.axes ?? [], ...v.raw };
    },
  };
}

const parsedCache = new Map();
/** Formulas are parsed once per expression — the Times grid evaluates one rule for hundreds of rows. */
function parsedOf(expression) {
  let p = parsedCache.get(expression);
  if (!p) {
    p = parseFormula(expression);
    if (parsedCache.size > 2000) parsedCache.clear();
    parsedCache.set(expression, p);
  }
  return p;
}

/**
 * THE time computation: a rule's setup (per run) and work (per piece), each a
 * constant or a formula fed the item's and the machine's values. No setup on
 * the rule means none; no work time means the rule is not finished. Missing
 * inputs are named, never guessed. Used by timingPreview and by the bulk
 * estimate (timeEstimateService), so a preview and the Times grid agree.
 *
 *   item, machine   valueReaders(...) of each side (null = no values)
 */
export function evaluateRuleTimes(rule, { item = null, machine = null } = {}) {
  const context = {
    item: item ? item.number : () => null,
    machine: machine ? machine.number : () => null,
    itemTable: item ? item.table : () => null,
    machineTable: machine ? machine.table : () => null,
  };
  const evaluate = (time, what) => {
    if (!time) return what === 'setup' ? { minutes: 0, formula: null } : { minutes: null, formula: null, error: 'The rule sets no work time.' };
    if (time.minutes != null) return { minutes: time.minutes, formula: null };
    const expression = time.expression ?? time.formula?.expression;
    const name = time.formula?.code ?? null;
    let parsed;
    try { parsed = parsedOf(expression); } catch (e) { return { minutes: null, formula: name, error: e.message }; }
    const out = evaluateFormula(parsed, () => null, null, context);
    return { minutes: out.value, formula: name, missing: out.missing, error: out.error };
  };
  return { setup: evaluate(rule.setup, 'setup'), work: evaluate(rule.work, 'work') };
}

/**
 * Everything the bulk estimate needs to know about machines for a set of
 * operations, in three reads whatever the number of operations or assets —
 * machinesForOperation's reads, for many operations at once: the rules valid
 * on the day, the active machines, the classification tree. Returns the rules
 * by operation and subject, and the helpers that rank a machine's (or a machine
 * TYPE's) chain the way resolveTiming does.
 */
export async function loadTimingSetup(db, companyId, operationIds, date = today()) {
  const empty = { rulesByOp: new Map(), machines: [], nodesById: new Map(), rankOfMachine: () => new Map(), rankOfNode: () => new Map(), winning: () => null };
  if (!operationIds.length) return empty;
  const [rules] = await db.query(`${RULE_SELECT} WHERE r.company_id = ? AND r.operation_id IN (?) AND r.deleted_at IS NULL
    AND (r.effective_from IS NULL OR r.effective_from <= ?) AND (r.effective_to IS NULL OR r.effective_to >= ?)`, [companyId, operationIds, date, date]);
  if (!rules.length) return empty;
  const [[machines], [nodes]] = await Promise.all([
    db.query("SELECT id, code, name, classification_id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY code", [companyId]),
    db.query('SELECT id, parent_id, depth, code, name FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
  ]);
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const rulesByOp = new Map();
  for (const r of rules) {
    if (!rulesByOp.has(r.operation_id)) rulesByOp.set(r.operation_id, new Map());
    const bySubject = rulesByOp.get(r.operation_id);
    const key = `${r.subject_type}:${r.subject_id}`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(r);
  }
  // ancestors()' chain bound, including its handling of a missing parent.
  const rankOfNode = (nodeId) => {
    const rank = new Map();
    let node = nodesById.get(nodeId);
    for (let hop = 0; node && hop < LEAF_DEPTH + 3; hop++, node = nodesById.get(node.parent_id)) rank.set(`classification:${node.id}`, node.depth);
    return rank;
  };
  const rankOfMachine = (m) => {
    const rank = rankOfNode(m.classification_id);
    rank.set(`machine:${m.id}`, 99);
    return rank;
  };
  /** The winning rule of an operation for a chain rank, or null. */
  const winning = (operationId, rank) => {
    const bySubject = rulesByOp.get(operationId);
    if (!bySubject) return null;
    return winningTiming([...rank.keys()].flatMap((key) => bySubject.get(key) ?? []), rank);
  };
  return { rulesByOp, machines, nodesById, rankOfMachine, rankOfNode, winning };
}

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
  // Resolved once per subject and shared by both readers below — a formula
  // reading item.CUT_LENGTH and LOOKUP(item.SOME_CHART, ...) must not pay for
  // resolving the item's specs twice.
  const itemResolution = item ? await resolve(db, companyId, { master: item }) : null;
  const machineResolution = await resolve(db, companyId, { machine });
  const { setup, work } = evaluateRuleTimes(rule, {
    item: itemResolution ? valueReaders(effectiveByCode(itemResolution)) : null,
    machine: valueReaders(effectiveByCode(machineResolution)),
  });
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
