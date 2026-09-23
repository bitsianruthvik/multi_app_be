/**
 * assignmentService.js — spec rules: "this specification applies here, is
 * captured at this level, and gets its value this way".
 *
 * The identity of a rule is (specification, subject, capture level). Changing
 * any of those is a different rule — delete and create — so update only
 * touches how the value is obtained.
 *
 * Checks the database cannot make (polymorphic subject, TiDB without CHECK):
 *   - the subject exists in this company (classification node or record;
 *     machines arrive later);
 *   - calculated and roll-up rules name a formula of the matching kind, and
 *     other rules name none;
 *   - batch and individual captures are entered or calculated — a measured
 *     heat number is never "fixed from above";
 *   - on an item, nothing is captured deeper than the item is tracked;
 *   - narrowed options belong to the spec.
 * Every change re-materialises the items it reaches.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { requireNode } from './tree.js';
import { loadMaster, assertNotFrozen } from './records.js';
import { parseFormula } from './formulaEngine.js';
import { rematerialize } from './valueService.js';
import { CAPTURE_DEPTH, TRACK_DEPTH } from './resolutionService.js';

export const VALUE_RULES = ['entered', 'fixed', 'defaulted', 'calculated', 'rollup', 'inherited'];
export const CAPTURE_LEVELS = ['item', 'batch', 'individual'];
export const SUBJECT_TYPES = ['classification', 'master', 'machine'];

async function requireRule(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_spec_assignments WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Rule');
  return row;
}

async function subjectInfo(db, companyId, subjectType, subjectId) {
  if (subjectType === 'machine') {
    const [[mc]] = await db.query('SELECT id FROM cf_machines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, subjectId]);
    if (!mc) throw notFound('Machine');
    return { reach: { machineId: mc.id }, trackDepth: 0, machine: true };
  }
  if (subjectType === 'classification') {
    const node = await requireNode(db, companyId, subjectId);
    // Rules on a machine family describe machines: captured on the machine, nothing to roll up or inherit.
    if (node.scope === 'machine') return { reach: { classificationId: subjectId }, trackDepth: 0, machine: true };
    return { reach: { classificationId: subjectId }, trackDepth: Infinity };
  }
  if (subjectType === 'master') {
    const m = await loadMaster(db, companyId, subjectId);
    if (!m) throw notFound('Item or definition');
    assertNotFrozen(m, 'rules');
    if (m.record_kind === 'item') return { reach: { masterId: m.id }, trackDepth: TRACK_DEPTH[m.tracked_by], trackedBy: m.tracked_by };
    return { reach: { definitionId: m.id }, trackDepth: Infinity };
  }
  throw invalid('INVALID', 'A rule attaches to a classification node, a record or a machine.');
}

async function checkRuleBody(db, companyId, spec, body, subject, problems) {
  const { valueRule, captureAt, isApplicable, isRequired, formulaId } = body;
  if (!VALUE_RULES.includes(valueRule)) problems.push(`How the value is obtained is one of ${VALUE_RULES.join(', ')}.`);
  if (!CAPTURE_LEVELS.includes(captureAt)) problems.push('Captured at item, batch or individual level.');
  if (!isApplicable) {
    if (isRequired) problems.push('A switched-off specification cannot be required.');
    return;
  }
  if (captureAt !== 'item' && !['entered', 'calculated'].includes(valueRule)) {
    problems.push('Batch and individual values are entered or calculated where they are captured.');
  }
  if (CAPTURE_DEPTH[captureAt] > subject.trackDepth) {
    problems.push(subject.machine
      ? 'A machine has no batches or units — its specifications are captured on the machine itself.'
      : `This item is tracked by ${subject.trackedBy}; it has no ${captureAt}-level records to capture on.`);
  }
  if (subject.machine && ['rollup', 'inherited'].includes(valueRule)) {
    problems.push('A machine has no BOM — nothing to roll up or inherit.');
  }
  if (['calculated', 'rollup'].includes(valueRule)) {
    if (spec.data_type !== 'number') problems.push(`${spec.code} is a ${spec.data_type}; only numbers are calculated.`);
    if (!formulaId) { problems.push(`A ${valueRule} rule needs a formula.`); return; }
    const [[f]] = await db.query('SELECT id, code, expression, status FROM cf_formulas WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, formulaId]);
    if (!f) { problems.push('That formula does not exist.'); return; }
    if (f.status !== 'active') problems.push(`Formula ${f.code} is inactive.`);
    const parsed = parseFormula(f.expression);
    if (parsed.usesContext) { problems.push(`${f.code} reads item. and machine. values — it is a timing formula for operations, not a specification rule.`); return; }
    if (valueRule === 'calculated' && parsed.usesRollup) problems.push(`${f.code} reads BOM children — use it with a Roll-up rule.`);
    if (valueRule === 'rollup' && !parsed.usesRollup) problems.push(`${f.code} does not read BOM children — a roll-up needs e.g. SUM(children.${spec.code}).`);
    if (valueRule === 'calculated' && parsed.references.includes(spec.code)) problems.push(`${f.code} reads ${spec.code} itself.`);
  } else if (formulaId) {
    problems.push(`A ${valueRule} rule does not use a formula.`);
  }
}

async function checkOptions(db, companyId, spec, optionIds, problems) {
  if (!optionIds?.length) return [];
  if (spec.data_type !== 'option') { problems.push(`${spec.code} is not an option list; nothing to narrow.`); return []; }
  const ids = [...new Set(optionIds.map(Number))];
  const [rows] = await db.query(
    'SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND id IN (?) AND deleted_at IS NULL',
    [companyId, spec.id, ids],
  );
  if (rows.length !== ids.length) problems.push(`Some chosen options are not options of ${spec.code}.`);
  return ids;
}

async function writeOptions(db, c, assignmentId, optionIds) {
  await db.query('UPDATE cf_spec_assignment_options SET deleted_at = NOW() WHERE company_id = ? AND assignment_id = ? AND deleted_at IS NULL', [c.companyId, assignmentId]);
  for (const optionId of optionIds) {
    await db.query('INSERT INTO cf_spec_assignment_options (company_id, assignment_id, option_id, created_by) VALUES (?, ?, ?, ?)', [c.companyId, assignmentId, optionId, c.userId]);
  }
}

// Accepts JSON booleans from the API and 0/1 from the database.
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true';

function readBody(input, existing = {}) {
  const pick = (k, fallback) => (input[k] !== undefined ? input[k] : fallback);
  return {
    captureAt: pick('captureAt', existing.capture_at ?? 'item'),
    valueRule: pick('valueRule', existing.value_rule ?? 'entered'),
    isRequired: flag(pick('isRequired', existing.is_required ?? 0)),
    isApplicable: flag(pick('isApplicable', existing.is_applicable ?? 1)),
    formulaId: pick('formulaId', existing.formula_id ?? null) || null,
    sortOrder: Number(pick('sortOrder', existing.sort_order ?? 0)) || 0,
  };
}

export async function listRules(db, companyId, subjectType, subjectId) {
  const [rows] = await db.query(
    `SELECT a.*, s.code AS spec_code, s.name AS spec_name, s.data_type, s.default_uom, f.code AS formula_code
       FROM cf_spec_assignments a
       JOIN cf_specifications s ON s.id = a.specification_id
       LEFT JOIN cf_formulas f ON f.id = a.formula_id
      WHERE a.company_id = ? AND a.subject_type = ? AND a.subject_id = ? AND a.deleted_at IS NULL
      ORDER BY a.sort_order, s.code`,
    [companyId, subjectType, subjectId],
  );
  const ids = rows.map((r) => r.id);
  const [opts] = ids.length
    ? await db.query(
      `SELECT ao.assignment_id, o.id, o.value FROM cf_spec_assignment_options ao JOIN cf_spec_options o ON o.id = ao.option_id
        WHERE ao.company_id = ? AND ao.assignment_id IN (?) AND ao.deleted_at IS NULL`,
      [companyId, ids])
    : [[]];
  return rows.map((r) => ({
    id: r.id,
    specificationId: r.specification_id, specCode: r.spec_code, specName: r.spec_name, dataType: r.data_type, unit: r.default_uom,
    subjectType: r.subject_type, subjectId: r.subject_id,
    captureAt: r.capture_at, valueRule: r.value_rule, isRequired: !!r.is_required, isApplicable: !!r.is_applicable,
    formulaId: r.formula_id, formulaCode: r.formula_code, sortOrder: r.sort_order,
    optionIds: opts.filter((o) => o.assignment_id === r.id).map((o) => o.id),
    optionValues: opts.filter((o) => o.assignment_id === r.id).map((o) => o.value),
  }));
}

export async function createRule(db, c, input = {}) {
  const problems = [];
  const subjectType = input.subjectType;
  if (!SUBJECT_TYPES.includes(subjectType)) throw invalid('INVALID', 'A rule attaches to a classification node or a record.');
  const subjectId = Number(input.subjectId);
  const subject = await subjectInfo(db, c.companyId, subjectType, subjectId);
  const [[spec]] = await db.query('SELECT * FROM cf_specifications WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, input.specificationId]);
  if (!spec) throw notFound('Specification');
  if (spec.status !== 'active') problems.push(`${spec.code} is inactive.`);
  const body = readBody(input);
  await checkRuleBody(db, c.companyId, spec, body, subject, problems);
  const optionIds = await checkOptions(db, c.companyId, spec, body.isApplicable ? input.optionIds : [], problems);
  assertNoProblems(problems, 'The rule has problems.');

  const [r] = await db.query(
    `INSERT INTO cf_spec_assignments
       (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, spec.id, subjectType, subjectId, body.captureAt, body.isRequired ? 1 : 0, body.isApplicable ? 1 : 0,
      body.isApplicable ? body.valueRule : 'entered', body.isApplicable ? body.formulaId : null, body.sortOrder, c.userId],
  );
  await writeOptions(db, c, r.insertId, optionIds);
  await rematerialize(db, c, subject.reach);
  return (await listRules(db, c.companyId, subjectType, subjectId)).find((x) => x.id === r.insertId);
}

export async function updateRule(db, c, id, input = {}) {
  const rule = await requireRule(db, c.companyId, id);
  for (const k of ['specificationId', 'subjectType', 'subjectId', 'captureAt']) {
    if (input[k] !== undefined && String(input[k]) !== String({ specificationId: rule.specification_id, subjectType: rule.subject_type, subjectId: rule.subject_id, captureAt: rule.capture_at }[k])) {
      throw invalid('IDENTITY', 'Specification, subject and capture level identify a rule — delete it and add a new one to change them.');
    }
  }
  const subject = await subjectInfo(db, c.companyId, rule.subject_type, rule.subject_id);
  const [[spec]] = await db.query('SELECT * FROM cf_specifications WHERE company_id = ? AND id = ?', [c.companyId, rule.specification_id]);
  const problems = [];
  const body = readBody(input, rule);
  await checkRuleBody(db, c.companyId, spec, body, subject, problems);
  const optionIds = input.optionIds !== undefined ? await checkOptions(db, c.companyId, spec, body.isApplicable ? input.optionIds : [], problems) : null;
  assertNoProblems(problems, 'The rule has problems.');

  await db.query(
    `UPDATE cf_spec_assignments SET is_required = ?, is_applicable = ?, value_rule = ?, formula_id = ?, sort_order = ?
      WHERE company_id = ? AND id = ?`,
    [body.isRequired ? 1 : 0, body.isApplicable ? 1 : 0, body.isApplicable ? body.valueRule : 'entered',
      body.isApplicable ? body.formulaId : null, body.sortOrder, c.companyId, id],
  );
  if (optionIds !== null || !body.isApplicable) await writeOptions(db, c, id, body.isApplicable ? optionIds ?? [] : []);
  await rematerialize(db, c, subject.reach);
  return (await listRules(db, c.companyId, rule.subject_type, rule.subject_id)).find((x) => x.id === id);
}

export async function deleteRule(db, c, id) {
  const rule = await requireRule(db, c.companyId, id);
  const subject = await subjectInfo(db, c.companyId, rule.subject_type, rule.subject_id);
  await db.query('UPDATE cf_spec_assignment_options SET deleted_at = NOW() WHERE company_id = ? AND assignment_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await rematerialize(db, c, subject.reach);
  return { ok: true };
}

/** Soft-deletes every rule on a subject that is being deleted. No re-materialise: the subject is going. */
export async function deleteAllForSubject(db, c, subjectType, subjectId) {
  await db.query(
    `UPDATE cf_spec_assignment_options ao JOIN cf_spec_assignments a ON a.id = ao.assignment_id
        SET ao.deleted_at = NOW()
      WHERE a.company_id = ? AND a.subject_type = ? AND a.subject_id = ? AND ao.deleted_at IS NULL`,
    [c.companyId, subjectType, subjectId],
  );
  await db.query(
    'UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE company_id = ? AND subject_type = ? AND subject_id = ? AND deleted_at IS NULL',
    [c.companyId, subjectType, subjectId],
  );
}
