/**
 * specificationService.js — the specification library and its option lists.
 *
 * A specification's code is permanent (taxonomy §6: "a permanent code"): it is
 * what formulas and coding rules refer to, so it can be set once and never
 * edited. Codes are identifiers — capital letters, digits and underscores — so
 * a formula can name them without quoting.
 *
 * Changing a data type is refused once values exist; retiring is the way out,
 * not rewriting what stored values mean.
 */
import { invalid, conflict, notFound, assertNoProblems } from '../lib/errors.js';
import { findSegmentsUsingToken } from '../modules/codegen/index.js';

export const DATA_TYPES = ['number', 'text', 'boolean', 'date', 'option'];
export const MEASUREMENT_TYPES = ['LENGTH', 'AREA', 'VOLUME', 'MASS', 'DENSITY', 'COUNT', 'TIME', 'SPEED', 'FORCE', 'PRESSURE', 'TEMPERATURE', 'ANGLE', 'RATIO'];
const CODE_RE = /^[A-Z][A-Z0-9_]*$/;

async function requireSpec(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_specifications WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Specification');
  return row;
}

function shapeSpec(s, options = [], usage = {}) {
  return {
    id: s.id, code: s.code, name: s.name, dataType: s.data_type, measurementType: s.measurement_type,
    defaultUom: s.default_uom, decimals: s.decimals, description: s.description, status: s.status,
    options: s.data_type === 'option' ? options.map((o) => ({ id: o.id, value: o.value, label: o.label, sortOrder: o.sort_order, status: o.status })) : undefined,
    ruleCount: Number(usage.rules ?? 0),
    valueCount: Number(usage.values ?? 0),
  };
}

export async function listSpecs(db, companyId) {
  const [specs] = await db.query(
    `SELECT s.*,
            (SELECT COUNT(*) FROM cf_spec_assignments a WHERE a.company_id = s.company_id AND a.specification_id = s.id AND a.deleted_at IS NULL) AS rules,
            (SELECT COUNT(*) FROM cf_spec_values v WHERE v.company_id = s.company_id AND v.specification_id = s.id AND v.deleted_at IS NULL) AS \`values\`
       FROM cf_specifications s WHERE s.company_id = ? AND s.deleted_at IS NULL ORDER BY s.code`,
    [companyId],
  );
  const [options] = await db.query(
    'SELECT * FROM cf_spec_options WHERE company_id = ? AND deleted_at IS NULL ORDER BY sort_order, value',
    [companyId],
  );
  return specs.map((s) => shapeSpec(s, options.filter((o) => o.specification_id === s.id), { rules: s.rules, values: s.values }));
}

export async function getSpec(db, companyId, id) {
  const s = await requireSpec(db, companyId, id);
  const [options] = await db.query('SELECT * FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL ORDER BY sort_order, value', [companyId, id]);
  const [[usage]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM cf_spec_assignments WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL) AS rules,
            (SELECT COUNT(*) FROM cf_spec_values WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL) AS \`values\``,
    [companyId, id, companyId, id],
  );
  return shapeSpec(s, options, usage);
}

function readCommon(input, problems) {
  const out = {};
  if (input.name !== undefined) {
    out.name = String(input.name ?? '').trim();
    if (!out.name || out.name.length > 255) problems.push('Name is required (up to 255 characters).');
  }
  if (input.measurementType !== undefined) {
    out.measurement_type = input.measurementType ? String(input.measurementType).toUpperCase() : null;
    if (out.measurement_type && !MEASUREMENT_TYPES.includes(out.measurement_type)) problems.push(`Measurement type is one of ${MEASUREMENT_TYPES.join(', ')}.`);
  }
  if (input.defaultUom !== undefined) {
    out.default_uom = input.defaultUom ? String(input.defaultUom).trim() : null;
    if (out.default_uom && out.default_uom.length > 20) problems.push('Unit is up to 20 characters.');
  }
  if (input.decimals !== undefined) {
    out.decimals = input.decimals === null || input.decimals === '' ? null : Number(input.decimals);
    if (out.decimals !== null && (!Number.isInteger(out.decimals) || out.decimals < 0 || out.decimals > 6)) problems.push('Decimals is 0 to 6.');
  }
  if (input.description !== undefined) out.description = input.description ? String(input.description) : null;
  if (input.status !== undefined) {
    if (!['active', 'inactive'].includes(input.status)) problems.push('Status is active or inactive.');
    out.status = input.status;
  }
  return out;
}

export async function createSpec(db, c, input = {}) {
  const problems = [];
  const code = String(input.code ?? '').trim().toUpperCase();
  if (!CODE_RE.test(code) || code.length > 100) problems.push('Code: capital letters, digits and "_", starting with a letter — e.g. THICKNESS.');
  const dataType = input.dataType ?? 'number';
  if (!DATA_TYPES.includes(dataType)) problems.push(`Data type is one of ${DATA_TYPES.join(', ')}.`);
  const fields = readCommon({ name: input.name ?? '', ...input }, problems);
  if (dataType !== 'number' && (fields.decimals != null)) problems.push('Decimals apply to numbers only.');
  const options = Array.isArray(input.options) ? input.options : [];
  if (dataType !== 'option' && options.length) problems.push('Only option specifications have an option list.');
  if (dataType === 'option' && !options.length) problems.push('An option specification needs at least one option.');
  const seen = new Set();
  for (const o of options) {
    const v = String(o.value ?? '').trim();
    if (!v || v.length > 100) problems.push('Every option needs a value (up to 100 characters).');
    else if (seen.has(v.toLowerCase())) problems.push(`Option ${v} is listed twice.`);
    seen.add(v.toLowerCase());
  }
  assertNoProblems(problems);

  const [r] = await db.query(
    `INSERT INTO cf_specifications (company_id, code, name, data_type, measurement_type, default_uom, decimals, description, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, code, fields.name, dataType, fields.measurement_type ?? null, fields.default_uom ?? null,
      fields.decimals ?? null, fields.description ?? null, fields.status ?? 'active', c.userId],
  );
  for (const [i, o] of options.entries()) {
    await db.query(
      'INSERT INTO cf_spec_options (company_id, specification_id, value, label, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [c.companyId, r.insertId, String(o.value).trim(), o.label ? String(o.label).trim() : null, o.sortOrder ?? i + 1, c.userId],
    );
  }
  return getSpec(db, c.companyId, r.insertId);
}

export async function updateSpec(db, c, id, input = {}) {
  const spec = await requireSpec(db, c.companyId, id);
  const problems = [];
  if (input.code !== undefined && String(input.code).trim().toUpperCase() !== spec.code) {
    problems.push('A specification code is permanent — formulas and coding rules refer to it.');
  }
  const fields = readCommon(input, problems);
  if (input.dataType !== undefined && input.dataType !== spec.data_type) {
    if (!DATA_TYPES.includes(input.dataType)) problems.push(`Data type is one of ${DATA_TYPES.join(', ')}.`);
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_spec_values WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL', [c.companyId, id]);
    if (Number(n)) problems.push(`${spec.code} already has ${n} value(s); its data type cannot change.`);
    fields.data_type = input.dataType;
  }
  assertNoProblems(problems);
  const keys = Object.keys(fields);
  if (keys.length) {
    await db.query(
      `UPDATE cf_specifications SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(fields), c.companyId, id],
    );
  }
  return getSpec(db, c.companyId, id);
}

export async function deleteSpec(db, c, id) {
  const spec = await requireSpec(db, c.companyId, id);
  const count = async (sql) => Number((await db.query(sql, [c.companyId, id]))[0][0].n);
  const reasons = [];
  const rules = await count('SELECT COUNT(*) AS n FROM cf_spec_assignments WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL');
  if (rules) reasons.push(`${rules} rule(s)`);
  const values = await count('SELECT COUNT(*) AS n FROM cf_spec_values WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL');
  if (values) reasons.push(`${values} value(s)`);
  const criteria = await count('SELECT COUNT(*) AS n FROM cf_selection_criteria WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL');
  if (criteria) reasons.push(`${criteria} selection criterion/criteria`);
  const schemes = await findSegmentsUsingToken(db, c.companyId, `spec:${spec.code}`);
  if (schemes.length) reasons.push(`coding rule(s) ${schemes.map((s) => s.code).join(', ')}`);
  const [formulas] = await db.query('SELECT code, expression FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const re = new RegExp(`(^|[^A-Za-z0-9_.])(children\\.)?${spec.code}([^A-Za-z0-9_]|$)`, 'i');
  const using = formulas.filter((f) => re.test(f.expression)).map((f) => f.code);
  if (using.length) reasons.push(`formula(s) ${using.join(', ')}`);
  if (reasons.length) {
    throw conflict('IN_USE', `${spec.code} is still used by ${reasons.join('; ')}. Retire it (status inactive) instead.`, { problems: reasons });
  }
  await db.query('UPDATE cf_spec_options SET deleted_at = NOW() WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_specifications SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

// ----- options -------------------------------------------------------------

async function requireOption(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_spec_options WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Option');
  return row;
}

export async function addOption(db, c, specId, input = {}) {
  const spec = await requireSpec(db, c.companyId, specId);
  if (spec.data_type !== 'option') throw invalid('NOT_OPTION', `${spec.code} is a ${spec.data_type}, not an option list.`);
  const value = String(input.value ?? '').trim();
  if (!value || value.length > 100) throw invalid('INVALID', 'An option needs a value (up to 100 characters).');
  const [[{ n }]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL', [c.companyId, specId]);
  await db.query(
    'INSERT INTO cf_spec_options (company_id, specification_id, value, label, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [c.companyId, specId, value, input.label ? String(input.label).trim() : null, input.sortOrder ?? Number(n) + 1, c.userId],
  );
  return getSpec(db, c.companyId, specId);
}

/**
 * Options are stored by id on every value, so renaming one is safe — every
 * value follows. Retiring (status inactive) keeps old values readable while
 * stopping new use.
 */
export async function updateOption(db, c, id, input = {}) {
  const opt = await requireOption(db, c.companyId, id);
  const sets = [];
  const params = [];
  if (input.value !== undefined) {
    const value = String(input.value ?? '').trim();
    if (!value || value.length > 100) throw invalid('INVALID', 'An option needs a value (up to 100 characters).');
    sets.push('value = ?'); params.push(value);
  }
  if (input.label !== undefined) { sets.push('label = ?'); params.push(input.label ? String(input.label).trim() : null); }
  if (input.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(Number(input.sortOrder) || 0); }
  if (input.status !== undefined) {
    if (!['active', 'inactive'].includes(input.status)) throw invalid('INVALID', 'Status is active or inactive.');
    sets.push('status = ?'); params.push(input.status);
  }
  if (sets.length) await db.query(`UPDATE cf_spec_options SET ${sets.join(', ')} WHERE company_id = ? AND id = ?`, [...params, c.companyId, id]);
  return getSpec(db, c.companyId, opt.specification_id);
}

export async function deleteOption(db, c, id) {
  const opt = await requireOption(db, c.companyId, id);
  const count = async (sql) => Number((await db.query(sql, [c.companyId, id]))[0][0].n);
  const values = await count('SELECT COUNT(*) AS n FROM cf_spec_values WHERE company_id = ? AND option_id = ? AND deleted_at IS NULL');
  const criteria = await count('SELECT COUNT(*) AS n FROM cf_selection_criteria WHERE company_id = ? AND option_id = ? AND deleted_at IS NULL');
  if (values || criteria) {
    throw conflict('IN_USE', `${opt.value} is used by ${values} value(s) and ${criteria} criterion/criteria. Retire it instead.`);
  }
  await db.query('UPDATE cf_spec_assignment_options SET deleted_at = NOW() WHERE company_id = ? AND option_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_spec_options SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return getSpec(db, c.companyId, opt.specification_id);
}
