/**
 * service.js — create, change and delete coding rules.
 *
 * A rule is saved whole: scheme row, conditions and segments in one call, the
 * old conditions and segments soft-deleted and replaced. That matches how the
 * rules screen edits them (a builder, not row-by-row forms) and means a rule
 * is never half-changed.
 *
 * Validation happens here, before anything is written, and reports every
 * problem at once. Token keys and condition values are checked by the entity's
 * provider — this module does not know what a specification or a
 * classification is.
 */
import { CodegenError } from './errors.js';
import { getProvider } from './engine.js';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SEGMENT_TYPES = ['literal', 'token', 'sequence', 'date'];
const TRANSFORMS = ['none', 'upper', 'lower'];
const DATE_FORMAT_RE = /^(YYYY|YY|MM|DD|[-_/.])+$/;

/** Accepts camelCase (API) or snake_case (rows) and returns rows. */
export function normalizeSegments(segments = []) {
  return segments.map((s, i) => ({
    sort_order: i + 1,
    segment_type: s.segmentType ?? s.segment_type,
    literal_text: s.literalText ?? s.literal_text ?? null,
    token_key: s.tokenKey ?? s.token_key ?? null,
    format: (s.format ?? '') === '' ? null : s.format,
    transform: s.transform ?? 'none',
    max_length: s.maxLength ?? s.max_length ?? null,
    is_required: (s.isRequired ?? s.is_required ?? true) ? 1 : 0,
  }));
}

function normalizeConditions(conditions = []) {
  return conditions.map((c) => ({
    token_key: c.tokenKey ?? c.token_key,
    operator: c.operator ?? 'eq',
    value: c.value == null ? '' : String(c.value).trim(),
  }));
}

async function validate(db, companyId, input, segments, conditions) {
  const problems = [];
  if (!input.code || !CODE_RE.test(input.code) || input.code.length > 100) {
    problems.push('Code: letters, digits, "-" or "_", starting with a letter or digit.');
  }
  if (!input.name || !String(input.name).trim()) problems.push('Name is required.');

  let provider = null;
  try { provider = getProvider(input.entityType); } catch (e) { problems.push(e.message); }
  if (!['code', 'name'].includes(input.targetField)) problems.push('A rule makes either a code or a name.');
  if (!['prefix', 'scheme'].includes(input.seqScope)) problems.push('Running numbers restart per prefix or run for the whole rule.');
  if (!Number.isInteger(input.priority)) problems.push('Priority must be a whole number.');

  if (provider) {
    for (const [i, c] of conditions.entries()) {
      const where = `Condition ${i + 1}`;
      const token = provider.conditionTokens.find((t) => t.key === c.token_key);
      if (!token) { problems.push(`${where}: "${c.token_key}" cannot be tested.`); continue; }
      if (!token.operators.includes(c.operator)) {
        problems.push(`${where}: ${token.label} can be tested with ${token.operators.join(' / ')}, not "${c.operator}".`);
      }
      if (!c.value) { problems.push(`${where}: needs a value.`); continue; }
      const p = await provider.validateCondition(db, companyId, c);
      if (p) problems.push(`${where}: ${p}`);
    }
  }

  if (!segments.length) problems.push('The pattern needs at least one part.');
  let sequences = 0;
  let variable = 0;
  for (const [i, s] of segments.entries()) {
    const where = `Part ${i + 1}`;
    if (!SEGMENT_TYPES.includes(s.segment_type)) { problems.push(`${where}: unknown type.`); continue; }
    if (!TRANSFORMS.includes(s.transform)) problems.push(`${where}: unknown letter case.`);
    if (s.max_length != null && (!Number.isInteger(Number(s.max_length)) || s.max_length < 1 || s.max_length > 100)) {
      problems.push(`${where}: a length limit is between 1 and 100.`);
    }
    if (s.segment_type === 'literal') {
      if (!s.literal_text) problems.push(`${where}: fixed text is empty.`);
      else if (s.literal_text.length > 100) problems.push(`${where}: fixed text is longer than 100 characters.`);
    }
    if (s.segment_type === 'token') {
      variable++;
      if (!s.token_key) problems.push(`${where}: choose which value to insert.`);
      else if (provider) {
        const p = await provider.validateToken(db, companyId, s.token_key);
        if (p) problems.push(`${where}: ${p}`);
      }
      if (s.format && !/^(0{1,9}|0\.0{1,6})$/.test(s.format)) problems.push(`${where}: a number format is zeros (00 pads 1 to 01) or 0.00 for decimals.`);
    }
    if (s.segment_type === 'sequence') {
      variable++;
      sequences++;
      if (s.format && !/^0{1,9}$/.test(s.format)) problems.push(`${where}: a number format is zeros only, e.g. 000.`);
    }
    if (s.segment_type === 'date') {
      variable++;
      if (s.format && !DATE_FORMAT_RE.test(s.format)) problems.push(`${where}: date format uses YYYY, YY, MM, DD and - _ / .`);
    }
  }
  if (sequences > 1) problems.push('A pattern can have only one running number.');
  if (input.targetField === 'code' && segments.length && variable === 0) {
    problems.push('A code pattern of fixed text only would give every record the same code.');
  }
  return problems;
}

function inputFrom(body) {
  return {
    code: typeof body.code === 'string' ? body.code.trim() : body.code,
    name: typeof body.name === 'string' ? body.name.trim() : body.name,
    entityType: body.entityType,
    targetField: body.targetField ?? 'code',
    seqScope: body.seqScope ?? 'prefix',
    priority: body.priority == null || body.priority === '' ? 0 : Number(body.priority),
    description: body.description ?? null,
    status: body.status ?? 'active',
  };
}

/** Throws INVALID_SCHEME listing every problem, or returns normalized parts. */
export async function checkScheme(db, companyId, body) {
  const input = inputFrom(body);
  const segments = normalizeSegments(body.segments);
  const conditions = normalizeConditions(body.conditions);
  const problems = await validate(db, companyId, input, segments, conditions);
  if (!['active', 'inactive'].includes(input.status)) problems.push('Status is active or inactive.');
  if (problems.length) throw new CodegenError(422, 'INVALID_SCHEME', 'The coding rule has problems.', { problems });
  return { input, segments, conditions };
}

async function writeParts(db, companyId, userId, schemeId, conditions, segments) {
  await db.query('UPDATE cf_code_scheme_conditions SET deleted_at = NOW() WHERE company_id = ? AND scheme_id = ? AND deleted_at IS NULL', [companyId, schemeId]);
  await db.query('UPDATE cf_code_scheme_segments SET deleted_at = NOW() WHERE company_id = ? AND scheme_id = ? AND deleted_at IS NULL', [companyId, schemeId]);
  for (const c of conditions) {
    await db.query(
      `INSERT INTO cf_code_scheme_conditions (company_id, scheme_id, token_key, operator, value, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [companyId, schemeId, c.token_key, c.operator, c.value, userId],
    );
  }
  for (const s of segments) {
    await db.query(
      `INSERT INTO cf_code_scheme_segments
         (company_id, scheme_id, sort_order, segment_type, literal_text, token_key, format, transform, max_length, is_required, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, schemeId, s.sort_order, s.segment_type, s.literal_text, s.token_key, s.format,
        s.transform, s.max_length, s.is_required, userId],
    );
  }
}

export async function createScheme(db, companyId, userId, body) {
  const { input, segments, conditions } = await checkScheme(db, companyId, body);
  const [r] = await db.query(
    `INSERT INTO cf_code_schemes (company_id, code, name, entity_type, target_field, seq_scope, priority, description, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, input.code, input.name, input.entityType, input.targetField, input.seqScope,
      input.priority, input.description, input.status, userId],
  );
  await writeParts(db, companyId, userId, r.insertId, conditions, segments);
  return getScheme(db, companyId, r.insertId);
}

/**
 * Replaces a rule. Its running-number counters are kept on purpose — even if
 * the pattern changes, a number already handed out must never be handed out
 * again under the same prefix.
 */
export async function updateScheme(db, companyId, userId, id, body) {
  await requireScheme(db, companyId, id);
  const { input, segments, conditions } = await checkScheme(db, companyId, body);
  await db.query(
    `UPDATE cf_code_schemes
        SET code = ?, name = ?, entity_type = ?, target_field = ?, seq_scope = ?, priority = ?, description = ?, status = ?
      WHERE company_id = ? AND id = ?`,
    [input.code, input.name, input.entityType, input.targetField, input.seqScope, input.priority,
      input.description, input.status, companyId, id],
  );
  await writeParts(db, companyId, userId, id, conditions, segments);
  return getScheme(db, companyId, id);
}

/** Soft-deletes the rule and its parts. Counters stay, inert, so numbers are never reissued. */
export async function deleteScheme(db, companyId, id) {
  await requireScheme(db, companyId, id);
  await db.query('UPDATE cf_code_scheme_conditions SET deleted_at = NOW() WHERE company_id = ? AND scheme_id = ? AND deleted_at IS NULL', [companyId, id]);
  await db.query('UPDATE cf_code_scheme_segments SET deleted_at = NOW() WHERE company_id = ? AND scheme_id = ? AND deleted_at IS NULL', [companyId, id]);
  await db.query('UPDATE cf_code_schemes SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [companyId, id]);
  return { ok: true };
}

async function requireScheme(db, companyId, id) {
  const [[row]] = await db.query('SELECT id FROM cf_code_schemes WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw new CodegenError(404, 'NOT_FOUND', 'Coding rule not found.');
  return row;
}

function shapeScheme(s, conditions, segments, counters) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    entityType: s.entity_type,
    targetField: s.target_field,
    seqScope: s.seq_scope,
    priority: s.priority,
    description: s.description,
    status: s.status,
    updatedAt: s.updated_at,
    conditions: conditions.map((c) => ({ tokenKey: c.token_key, operator: c.operator, value: c.value })),
    segments: segments.map((g) => ({
      segmentType: g.segment_type, literalText: g.literal_text, tokenKey: g.token_key, format: g.format,
      transform: g.transform, maxLength: g.max_length, isRequired: !!g.is_required,
    })),
    counters: counters.map((q) => ({ prefix: q.seq_key, nextValue: q.next_value })),
  };
}

export async function listSchemes(db, companyId, { entityType } = {}) {
  const params = [companyId];
  let where = 'company_id = ? AND deleted_at IS NULL';
  if (entityType) { where += ' AND entity_type = ?'; params.push(entityType); }
  const [schemes] = await db.query(`SELECT * FROM cf_code_schemes WHERE ${where} ORDER BY entity_type, target_field, code`, params);
  if (!schemes.length) return [];
  const ids = schemes.map((s) => s.id);
  const [conds] = await db.query('SELECT * FROM cf_code_scheme_conditions WHERE company_id = ? AND scheme_id IN (?) AND deleted_at IS NULL ORDER BY id', [companyId, ids]);
  const [segs] = await db.query('SELECT * FROM cf_code_scheme_segments WHERE company_id = ? AND scheme_id IN (?) AND deleted_at IS NULL ORDER BY sort_order, id', [companyId, ids]);
  const [ctrs] = await db.query('SELECT * FROM cf_code_sequences WHERE company_id = ? AND scheme_id IN (?) ORDER BY updated_at DESC', [companyId, ids]);
  const by = (rows) => (id) => rows.filter((r) => r.scheme_id === id);
  return schemes.map((s) => shapeScheme(s, by(conds)(s.id), by(segs)(s.id), by(ctrs)(s.id)));
}

export async function getScheme(db, companyId, id) {
  const [[s]] = await db.query('SELECT * FROM cf_code_schemes WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!s) throw new CodegenError(404, 'NOT_FOUND', 'Coding rule not found.');
  const [conds] = await db.query('SELECT * FROM cf_code_scheme_conditions WHERE company_id = ? AND scheme_id = ? AND deleted_at IS NULL ORDER BY id', [companyId, id]);
  const [segs] = await db.query('SELECT * FROM cf_code_scheme_segments WHERE company_id = ? AND scheme_id = ? AND deleted_at IS NULL ORDER BY sort_order, id', [companyId, id]);
  const [ctrs] = await db.query('SELECT * FROM cf_code_sequences WHERE company_id = ? AND scheme_id = ? ORDER BY updated_at DESC', [companyId, id]);
  return shapeScheme(s, conds, segs, ctrs);
}

/**
 * Live rules whose conditions name a value — e.g. which rules test
 * "classification = 42". The host app calls this before deleting the thing
 * the value refers to, so a rule is never left silently matching nothing.
 */
export async function findConditionsReferencing(db, companyId, tokenKey, value) {
  const [rows] = await db.query(
    `SELECT DISTINCT s.id, s.code
       FROM cf_code_scheme_conditions c
       JOIN cf_code_schemes s ON s.id = c.scheme_id AND s.deleted_at IS NULL
      WHERE c.company_id = ? AND c.token_key = ? AND c.deleted_at IS NULL
        AND (c.value = ? OR FIND_IN_SET(?, REPLACE(c.value, ' ', '')) > 0)`,
    [companyId, tokenKey, String(value), String(value)],
  );
  return rows;
}

/** Live token segments that insert a given token — e.g. before a specification is deleted. */
export async function findSegmentsUsingToken(db, companyId, tokenKey) {
  const [rows] = await db.query(
    `SELECT DISTINCT s.id, s.code
       FROM cf_code_scheme_segments g
       JOIN cf_code_schemes s ON s.id = g.scheme_id AND s.deleted_at IS NULL
      WHERE g.company_id = ? AND g.token_key = ? AND g.deleted_at IS NULL`,
    [companyId, tokenKey],
  );
  return rows;
}
