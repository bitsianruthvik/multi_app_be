/**
 * selectionService.js — how a Selection Definition finds its catalog items.
 *
 *   allowed_list — only the items on its list
 *   spec_match   — any active catalog item whose values meet its criteria
 *   both         — items on the list that also meet the criteria
 *
 * Criteria on the SAME specification are OR'ed (GRADE = 8.8 or 10.9); criteria
 * on DIFFERENT specifications are AND'ed (... and DIAMETER = 20). Matching
 * reads stored values, which is why derived values are materialised (Q18): a
 * catalog item's defaulted density is a row like any entered value.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { subtreeIds } from './tree.js';
import { loadMaster, requireMaster } from './records.js';
import { coerce } from './valueService.js';
import { rawOf } from './resolutionService.js';

const OPERATORS = {
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  text: ['eq', 'neq'],
  option: ['eq', 'neq'],
  boolean: ['eq'],
};
const SQL_OP = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

async function requireSelection(db, companyId, id) {
  const d = await requireMaster(db, companyId, id, 'Selection definition');
  if (d.record_kind !== 'definition' || d.definition_type !== 'selection') {
    throw invalid('NOT_SELECTION', `${d.code ?? d.name} is not a selection definition.`);
  }
  return d;
}

export async function getSelection(db, companyId, definitionId) {
  const d = await requireSelection(db, companyId, definitionId);
  const [allowed] = await db.query(
    `SELECT a.id, a.item_id, a.is_default, a.sort_order, m.code, m.name, m.status
       FROM cf_definition_allowed_items a JOIN cf_master_records m ON m.id = a.item_id
      WHERE a.company_id = ? AND a.definition_id = ? AND a.deleted_at IS NULL AND m.deleted_at IS NULL
      ORDER BY a.sort_order, m.code`,
    [companyId, definitionId],
  );
  const [criteria] = await db.query(
    `SELECT c.*, s.code AS spec_code, s.name AS spec_name, s.data_type, s.default_uom, o.value AS option_value
       FROM cf_selection_criteria c
       JOIN cf_specifications s ON s.id = c.specification_id
       LEFT JOIN cf_spec_options o ON o.id = c.option_id
      WHERE c.company_id = ? AND c.definition_id = ? AND c.deleted_at IS NULL
      ORDER BY c.sort_order, c.id`,
    [companyId, definitionId],
  );
  return {
    definitionId: d.id,
    selectionMode: d.selection_mode,
    candidateClassificationId: d.candidate_classification_id,
    allowedItems: allowed.map((a) => ({ id: a.id, itemId: a.item_id, code: a.code, name: a.name, status: a.status, isDefault: !!a.is_default, sortOrder: a.sort_order })),
    criteria: criteria.map((c) => ({
      id: c.id, specificationId: c.specification_id, specCode: c.spec_code, specName: c.spec_name, dataType: c.data_type, unit: c.default_uom,
      operator: c.operator,
      value: c.data_type === 'option' ? c.option_value : rawOf(c, c.data_type),
      valueTo: c.value_number_to == null ? null : Number(c.value_number_to),
      optionId: c.option_id,
    })),
  };
}

export async function addAllowedItem(db, c, definitionId, input = {}) {
  await requireSelection(db, c.companyId, definitionId);
  const item = await loadMaster(db, c.companyId, Number(input.itemId));
  if (!item || item.record_kind !== 'item') throw notFound('Item');
  if (item.item_type !== 'catalog') throw invalid('NOT_CATALOG', 'A selection chooses from catalog items — temporary items belong to one order.');
  if (item.status === 'obsolete') throw invalid('OBSOLETE', `${item.code} is obsolete.`);
  const isDefault = !!input.isDefault;
  if (isDefault) {
    await db.query('UPDATE cf_definition_allowed_items SET is_default = 0 WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL', [c.companyId, definitionId]);
  }
  const [[{ n }]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM cf_definition_allowed_items WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL', [c.companyId, definitionId]);
  await db.query(
    'INSERT INTO cf_definition_allowed_items (company_id, definition_id, item_id, is_default, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [c.companyId, definitionId, item.id, isDefault ? 1 : 0, Number(n) + 1, c.userId],
  );
  return getSelection(db, c.companyId, definitionId);
}

async function requireAllowed(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_definition_allowed_items WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Allowed item');
  return row;
}

export async function setDefaultAllowed(db, c, id) {
  const row = await requireAllowed(db, c.companyId, id);
  await db.query('UPDATE cf_definition_allowed_items SET is_default = (id = ?) WHERE company_id = ? AND definition_id = ? AND deleted_at IS NULL', [id, c.companyId, row.definition_id]);
  return getSelection(db, c.companyId, row.definition_id);
}

export async function removeAllowedItem(db, c, id) {
  const row = await requireAllowed(db, c.companyId, id);
  await db.query('UPDATE cf_definition_allowed_items SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return getSelection(db, c.companyId, row.definition_id);
}

async function readCriterion(db, companyId, input, problems) {
  const [[spec]] = await db.query('SELECT * FROM cf_specifications WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, input.specificationId]);
  if (!spec) { problems.push('Choose a specification.'); return null; }
  const operator = input.operator ?? 'eq';
  const allowed = OPERATORS[spec.data_type] ?? [];
  if (!allowed.includes(operator)) problems.push(`${spec.code} (${spec.data_type}) can be compared with ${allowed.join(', ')}.`);
  const out = await coerce(db, companyId, spec, input.value);
  if (out.problem) problems.push(out.problem);
  else if (!out.typed) problems.push(`${spec.code} needs a value to compare with.`);
  let valueTo = null;
  if (operator === 'between') {
    if (spec.data_type !== 'number') problems.push('Between works on numbers.');
    valueTo = Number(input.valueTo);
    if (!Number.isFinite(valueTo)) problems.push('Between needs an upper bound.');
    else if (out.typed && valueTo < out.typed.value_number) problems.push('The upper bound is below the lower bound.');
  }
  return { spec, operator, typed: out.typed, valueTo };
}

export async function addCriterion(db, c, definitionId, input = {}) {
  await requireSelection(db, c.companyId, definitionId);
  const problems = [];
  const crit = await readCriterion(db, c.companyId, input, problems);
  assertNoProblems(problems, 'The criterion has problems.');
  const t = crit.typed;
  await db.query(
    `INSERT INTO cf_selection_criteria
       (company_id, definition_id, specification_id, operator, value_number, value_number_to, value_text, value_bool, value_date, option_id, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, definitionId, crit.spec.id, crit.operator, t.value_number, crit.valueTo, t.value_text, t.value_bool, t.value_date,
      t.option_id, Number(input.sortOrder) || 0, c.userId],
  );
  return getSelection(db, c.companyId, definitionId);
}

export async function updateCriterion(db, c, id, input = {}) {
  const [[row]] = await db.query('SELECT * FROM cf_selection_criteria WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (!row) throw notFound('Criterion');
  const problems = [];
  const crit = await readCriterion(db, c.companyId, { specificationId: row.specification_id, ...input }, problems);
  assertNoProblems(problems, 'The criterion has problems.');
  const t = crit.typed;
  await db.query(
    `UPDATE cf_selection_criteria
        SET specification_id = ?, operator = ?, value_number = ?, value_number_to = ?, value_text = ?, value_bool = ?, value_date = ?, option_id = ?
      WHERE company_id = ? AND id = ?`,
    [crit.spec.id, crit.operator, t.value_number, crit.valueTo, t.value_text, t.value_bool, t.value_date, t.option_id, c.companyId, id],
  );
  return getSelection(db, c.companyId, row.definition_id);
}

export async function removeCriterion(db, c, id) {
  const [[row]] = await db.query('SELECT * FROM cf_selection_criteria WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (!row) throw notFound('Criterion');
  await db.query('UPDATE cf_selection_criteria SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return getSelection(db, c.companyId, row.definition_id);
}

/** One SQL condition for one criterion, against the value alias `v`. */
function criterionSql(c) {
  switch (c.data_type) {
    case 'number':
      if (c.operator === 'between') return { sql: 'v.value_number BETWEEN ? AND ?', params: [c.value_number, c.value_number_to] };
      return { sql: `v.value_number ${SQL_OP[c.operator]} ?`, params: [c.value_number] };
    case 'date':
      return { sql: `v.value_date ${SQL_OP[c.operator]} ?`, params: [c.value_date] };
    case 'text': return { sql: `LOWER(v.value_text) ${SQL_OP[c.operator]} LOWER(?)`, params: [c.value_text] };
    case 'option': return { sql: `v.option_id ${SQL_OP[c.operator]} ?`, params: [c.option_id] };
    case 'boolean': return { sql: 'v.value_bool = ?', params: [c.value_bool] };
    default: return { sql: '0 = 1', params: [] };
  }
}

/**
 * The catalog items a selection resolves to right now: active, catalog, inside
 * its search area, and meeting its mode. Each comes with the values the
 * criteria looked at, so a person can see why it matched.
 */
export async function findCandidates(db, companyId, definitionId, { limit = 200 } = {}) {
  const d = await requireSelection(db, companyId, definitionId);
  const [criteria] = await db.query(
    `SELECT c.*, s.data_type, s.code AS spec_code FROM cf_selection_criteria c JOIN cf_specifications s ON s.id = c.specification_id
      WHERE c.company_id = ? AND c.definition_id = ? AND c.deleted_at IS NULL`,
    [companyId, definitionId],
  );
  const mode = d.selection_mode ?? 'allowed_list';
  const where = ['m.company_id = ?', 'm.deleted_at IS NULL', "m.status = 'active'", "i.item_type = 'catalog'"];
  const params = [companyId];

  if (d.candidate_classification_id && mode !== 'allowed_list') {
    where.push('m.classification_id IN (?)');
    params.push(await subtreeIds(db, companyId, d.candidate_classification_id));
  }
  if (mode === 'allowed_list' || mode === 'both') {
    where.push('m.id IN (SELECT a.item_id FROM cf_definition_allowed_items a WHERE a.company_id = ? AND a.definition_id = ? AND a.deleted_at IS NULL)');
    params.push(companyId, definitionId);
  }
  if (mode === 'spec_match' || mode === 'both') {
    if (!criteria.length) return { mode, candidates: [], note: 'No criteria yet — nothing to match.' };
    const bySpec = new Map();
    for (const c of criteria) {
      if (!bySpec.has(c.specification_id)) bySpec.set(c.specification_id, []);
      bySpec.get(c.specification_id).push(c);
    }
    for (const [specId, group] of bySpec) {
      const parts = group.map(criterionSql);
      where.push(`EXISTS (SELECT 1 FROM cf_spec_values v
                           WHERE v.company_id = m.company_id AND v.subject_type = 'master' AND v.subject_id = m.id
                             AND v.specification_id = ? AND v.deleted_at IS NULL AND (${parts.map((p) => p.sql).join(' OR ')}))`);
      params.push(specId, ...parts.flatMap((p) => p.params));
    }
  }

  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.revision, c.name AS classification_name,
            (SELECT a.is_default FROM cf_definition_allowed_items a
              WHERE a.company_id = m.company_id AND a.definition_id = ? AND a.item_id = m.id AND a.deleted_at IS NULL LIMIT 1) AS is_default
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       JOIN cf_classification_nodes c ON c.id = m.classification_id
      WHERE ${where.join(' AND ')}
      ORDER BY is_default DESC, m.code
      LIMIT ?`,
    [definitionId, ...params, Math.min(Number(limit) || 200, 1000)],
  );

  const specIds = [...new Set(criteria.map((c) => c.specification_id))];
  const shown = new Map();
  if (rows.length && specIds.length) {
    const [vals] = await db.query(
      `SELECT v.*, s.code AS spec_code, s.data_type, s.default_uom, o.value AS option_value
         FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id LEFT JOIN cf_spec_options o ON o.id = v.option_id
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.specification_id IN (?) AND v.deleted_at IS NULL`,
      [companyId, rows.map((r) => r.id), specIds],
    );
    for (const v of vals) {
      if (!shown.has(v.subject_id)) shown.set(v.subject_id, []);
      const raw = v.data_type === 'option' ? v.option_value : rawOf(v, v.data_type);
      shown.get(v.subject_id).push({ specCode: v.spec_code, value: raw, unit: v.default_uom, source: v.source });
    }
  }
  return {
    mode,
    candidates: rows.map((r) => ({
      id: r.id, code: r.code, name: r.name, revision: r.revision, classificationName: r.classification_name,
      isDefault: !!r.is_default, matchedValues: shown.get(r.id) ?? [],
    })),
  };
}
