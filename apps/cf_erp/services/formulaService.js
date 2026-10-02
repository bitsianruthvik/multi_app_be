/**
 * formulaService.js — reusable formulas.
 *
 * A formula is checked when it is saved: it must parse, and every name in it
 * must be a specification code. Changing the expression bumps `version` (an
 * attribute, like revision) and re-materialises every item whose calculated
 * value it produces.
 *
 * Three kinds, told apart by what the expression reads:
 *   value   — plain codes (LENGTH * WIDTH): calculated specification rules
 *   rollup  — children.X inside SUM / COUNT / AVG: roll-up rules
 *   timing  — item.X and machine.X: setup and work times of an operation
 * A formula in use keeps its kind.
 */
import { conflict, notFound, assertNoProblems } from '../lib/errors.js';
import { parseFormula, evaluateFormula, FormulaError } from './formulaEngine.js';
import { rematerialize } from './valueService.js';
import { tableSummary } from './resolutionService.js';

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;

async function requireFormula(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_formulas WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Formula');
  return row;
}

function kindOfExpression(expression) {
  try { return parseFormula(expression).kind; } catch { return null; }
}

const shape = (f, usage = 0, timingUsage = 0) => ({
  id: f.id, code: f.code, name: f.name, expression: f.expression, version: f.version,
  description: f.description, status: f.status, kind: kindOfExpression(f.expression),
  ruleCount: Number(usage), timingRuleCount: Number(timingUsage),
});

const TIMING_USAGE = `SELECT COUNT(*) FROM cf_operation_machine_rules t
   WHERE t.company_id = f.company_id AND t.deleted_at IS NULL AND (t.setup_formula_id = f.id OR t.work_formula_id = f.id)`;

export async function listFormulas(db, companyId) {
  const [rows] = await db.query(
    `SELECT f.*, (SELECT COUNT(*) FROM cf_spec_assignments a WHERE a.company_id = f.company_id AND a.formula_id = f.id AND a.deleted_at IS NULL) AS usage_count,
            (${TIMING_USAGE}) AS timing_count
       FROM cf_formulas f WHERE f.company_id = ? AND f.deleted_at IS NULL ORDER BY f.code`,
    [companyId],
  );
  return rows.map((f) => shape(f, f.usage_count, f.timing_count));
}

async function timingUsage(db, companyId, id) {
  const [[{ n }]] = await db.query(
    `SELECT COUNT(*) AS n FROM cf_operation_machine_rules WHERE company_id = ? AND deleted_at IS NULL AND (setup_formula_id = ? OR work_formula_id = ?)`,
    [companyId, id, id],
  );
  return Number(n);
}

/**
 * Parses and checks names. Returns { parsed, problems }; `sample` (code -> number,
 * or item.CODE / machine.CODE -> number for a timing formula; a table's own code
 * -> { x, v } / { x, y, v }, its LOOKUP target, for a sample table) is evaluated
 * when given, so the editor can show a result while typing.
 */
export async function checkFormula(db, companyId, expression, sample = null, readers = null) {
  const problems = [];
  let parsed = null;
  try {
    parsed = parseFormula(expression);
  } catch (e) {
    if (e instanceof FormulaError) return { parsed: null, problems: [e.message], references: [], result: null };
    throw e;
  }
  const lookupRefs = parsed.lookupRefs ?? [];
  const names = [...new Set([...parsed.references, ...parsed.rollupTerms, ...parsed.itemRefs, ...parsed.machineRefs, ...lookupRefs.map((r) => r.code)])];
  let known = new Map();
  if (names.length) {
    const [rows] = await db.query(
      'SELECT code, data_type, table_config FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)',
      [companyId, names],
    );
    known = new Map(rows.map((r) => [r.code, { dataType: r.data_type, tableConfig: typeof r.table_config === 'string' ? JSON.parse(r.table_config) : r.table_config }]));
    // Ordinary references must all be numbers — a table read this way (not
    // through LOOKUP) gets its own message, so it says what to do about it.
    for (const n of [...parsed.references, ...parsed.rollupTerms, ...parsed.itemRefs, ...parsed.machineRefs]) {
      const meta = known.get(n);
      if (!meta) problems.push(`Unknown specification ${n}.`);
      else if (meta.dataType === 'table') problems.push(`${n} is a table — read it with LOOKUP(${n}, …).`);
      else if (meta.dataType !== 'number') problems.push(`${n} is a ${meta.dataType}, not a number.`);
    }
    // LOOKUP's own target: must exist, must be a table, and must be asked for
    // the number of values its own axes take.
    for (const ref of lookupRefs) {
      const meta = known.get(ref.code);
      if (!meta) { problems.push(`Unknown specification ${ref.code}.`); continue; }
      if (meta.dataType !== 'table') {
        problems.push(`LOOKUP's first argument must be a table specification — ${ref.code} is a ${meta.dataType}. Read it directly instead of through LOOKUP.`);
        continue;
      }
      const axisCount = meta.tableConfig?.axes?.length || 1;
      if (ref.arity - 1 !== axisCount) {
        problems.push(`${ref.code} has ${axisCount} chart axis${axisCount === 1 ? '' : 'es'} — LOOKUP(${ref.code}${axisCount === 1 ? ', x' : ', x, y'}) takes ${axisCount} value${axisCount === 1 ? '' : 's'} to look up, not ${ref.arity - 1}.`);
      }
    }
  }
  let result = null;
  let inputs;
  if ((sample || readers) && !problems.length && !parsed.usesRollup) {
    const given = sample ?? {};
    const num = (k) => (given[k] === undefined || given[k] === '' || given[k] === null || typeof given[k] === 'object' ? null : Number(given[k]));
    const tableAt = (k) => (given[k] && typeof given[k] === 'object' ? given[k] : null);
    // A typed sample beats the real piece / machine (the time builder lets
    // people try "what if this plate were 20 mm"); otherwise the real value.
    const typedOf = (role, code, kind) => (kind === 'number' ? num(`${role}.${code}`) : tableAt(`${role}.${code}`));
    const side = (role, kind) => (code) => typedOf(role, code, kind) ?? readers?.[role]?.[kind]?.(code) ?? null;
    const context = parsed.usesContext ? {
      item: side('item', 'number'), machine: side('machine', 'number'),
      itemTable: side('item', 'table'), machineTable: side('machine', 'table'),
    } : null;
    result = evaluateFormula(parsed, num, null, context, (code) => tableAt(code));
    if (readers && context) {
      // What each name read, and from where — the time builder shows it beside the result.
      const from = (role, code, kind) => {
        if (typedOf(role, code, kind) != null) return 'typed';
        return readers?.[role]?.[kind]?.(code) != null ? (role === 'item' ? 'piece' : 'machine') : null;
      };
      inputs = [
        ...parsed.itemRefs.map((code) => ({ ref: `item.${code}`, value: context.item(code), from: from('item', code, 'number') })),
        ...parsed.machineRefs.map((code) => ({ ref: `machine.${code}`, value: context.machine(code), from: from('machine', code, 'number') })),
        ...lookupRefs.filter((r) => r.role !== 'plain').map((r) => {
          const t = r.role === 'item' ? context.itemTable(r.code) : context.machineTable(r.code);
          return { ref: `${r.role}.${r.code}`, value: null, chart: t ? tableSummary(known.get(r.code)?.tableConfig ?? null, t) : null, from: from(r.role, r.code, 'table') };
        }),
      ];
    }
  }
  return {
    parsed, problems, kind: parsed.kind, references: parsed.references, rollupTerms: parsed.rollupTerms, usesRollup: parsed.usesRollup,
    itemRefs: parsed.itemRefs, machineRefs: parsed.machineRefs, lookupRefs, result, ...(inputs ? { inputs } : {}),
  };
}

function readFields(input, problems, { partial }) {
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = String(input.name ?? '').trim();
    if (!out.name || out.name.length > 255) problems.push('Name is required (up to 255 characters).');
  }
  if (input.description !== undefined) out.description = input.description ? String(input.description) : null;
  if (input.status !== undefined) {
    if (!['active', 'inactive'].includes(input.status)) problems.push('Status is active or inactive.');
    out.status = input.status;
  }
  return out;
}

export async function createFormula(db, c, input = {}) {
  const problems = [];
  const code = String(input.code ?? '').trim().toUpperCase();
  if (!CODE_RE.test(code) || code.length > 100) problems.push('Code: capital letters, digits and "_", starting with a letter.');
  const fields = readFields(input, problems, { partial: false });
  const check = await checkFormula(db, c.companyId, input.expression);
  problems.push(...check.problems);
  assertNoProblems(problems, 'The formula has problems.');
  const [r] = await db.query(
    `INSERT INTO cf_formulas (company_id, code, name, expression, version, description, status, created_by)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    [c.companyId, code, fields.name, String(input.expression).trim(), fields.description ?? null, fields.status ?? 'active', c.userId],
  );
  return shape(await requireFormula(db, c.companyId, r.insertId));
}

export async function updateFormula(db, c, id, input = {}) {
  const f = await requireFormula(db, c.companyId, id);
  const problems = [];
  if (input.code !== undefined && String(input.code).trim().toUpperCase() !== f.code) {
    problems.push('A formula code is permanent.');
  }
  const fields = readFields(input, problems, { partial: true });
  let changedExpression = false;
  if (input.expression !== undefined && String(input.expression).trim() !== f.expression) {
    const check = await checkFormula(db, c.companyId, input.expression);
    problems.push(...check.problems);
    // A formula already used by a rule must stay the same kind: calculated rules
    // cannot suddenly read BOM children, nor roll-ups lose them.
    if (check.parsed) {
      const [kinds] = await db.query('SELECT DISTINCT value_rule FROM cf_spec_assignments WHERE company_id = ? AND formula_id = ? AND deleted_at IS NULL', [c.companyId, id]);
      const rules = kinds.map((k) => k.value_rule);
      if (rules.includes('calculated') && check.usesRollup) problems.push('Calculated rules use this formula; it cannot read BOM children.');
      if (rules.includes('rollup') && !check.usesRollup) problems.push('Roll-up rules use this formula; it must read BOM children, e.g. SUM(children.WEIGHT).');
      if (rules.length && check.kind === 'timing') problems.push('Specification rules use this formula; it cannot read item. or machine. values.');
      if (await timingUsage(db, c.companyId, id)) {
        const bareLookup = (check.lookupRefs ?? []).some((r) => r.role === 'plain');
        if (check.kind === 'rollup' || (check.kind === 'value' && (check.references.length || bareLookup))) {
          problems.push('Operation timing rules use this formula; it reads item.X and machine.X (or LOOKUP(item.X, …) / LOOKUP(machine.X, …), or is a plain number).');
        }
      }
    }
    fields.expression = String(input.expression).trim();
    changedExpression = true;
  }
  assertNoProblems(problems, 'The formula has problems.');
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  if (changedExpression) sets.push('version = version + 1');
  if (sets.length) {
    await db.query(`UPDATE cf_formulas SET ${sets.join(', ')} WHERE company_id = ? AND id = ?`, [...Object.values(fields), c.companyId, id]);
  }
  if (changedExpression) await rematerialize(db, c, { formulaId: id });
  return shape(await requireFormula(db, c.companyId, id));
}

export async function deleteFormula(db, c, id) {
  const f = await requireFormula(db, c.companyId, id);
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_spec_assignments WHERE company_id = ? AND formula_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  const timing = await timingUsage(db, c.companyId, id);
  if (Number(n) || timing) {
    const uses = [Number(n) ? `${n} specification rule(s)` : null, timing ? `${timing} operation timing rule(s)` : null].filter(Boolean).join(' and ');
    throw conflict('IN_USE', `${f.code} is used by ${uses}. Retire it (status inactive) instead.`);
  }
  await db.query('UPDATE cf_formulas SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}
