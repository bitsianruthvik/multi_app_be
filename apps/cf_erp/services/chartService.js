/**
 * chartService.js — charts on a machine type or a machine (user, 2026-10-08: "give an option on a
 * machine or a machine type to add a new lookup specification … mention the units in the column
 * heading … edit the specification table from the machine or machine type itself").
 *
 * A CHART is a table specification. What used to be four steps in three places — create the
 * specification, attach it to the machine type, fill it in, remember its code for LOOKUP — is one
 * form on the machine type or machine page:
 *   name, the result's unit (required), its columns — each one the piece's value it is read by
 *   (Thickness → THICKNESS, its unit taken from that value) or a free label with a unit — whether
 *   a value between two rows steps up or is read on a straight line, and the values.
 * Saving creates the specification, its rule where the chart was added (defaulted: a machine type's
 * chart is every machine's of that type unless a machine has its own) and its values.
 *
 * A chart whose every column names a piece's value can be written by its name in a time formula
 * (lib/chartFormula.js): `item.CUT_LENGTH / GAS_CUT_SPEED`.
 *
 * Values are saved the usual way (PUT /classification/:id/values, PUT /machines/:id/values).
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { ancestors, loadNode } from './tree.js';
import { requireMachine } from './records.js';
import { setValues } from './valueService.js';

const MODES = ['step_up', 'linear'];
const blank = (v) => v == null || String(v).trim() === '';
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const codeFrom = (name) => String(name ?? '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 60);

/** Map CODE -> [FIELD, …] for every chart whose every column names a piece's value (the short formula form). */
export async function chartBindings(db, companyId) {
  const [rows] = await db.query("SELECT UPPER(code) AS code, table_config FROM cf_specifications WHERE company_id = ? AND data_type = 'table' AND deleted_at IS NULL", [companyId]);
  const out = new Map();
  for (const r of rows) {
    const axes = parseJson(r.table_config)?.axes ?? [];
    if (axes.length && axes.every((a) => !blank(a.field))) out.set(r.code, axes.map((a) => String(a.field).toUpperCase()));
  }
  return out;
}

/** The chart's own shape, from its specification row. */
function chartSpec(r, fieldsByCode) {
  const cfg = parseJson(r.table_config) ?? {};
  return {
    specId: r.id, code: r.code, name: r.name, resultUnit: r.default_uom ?? null, mode: cfg.mode ?? 'step_up',
    axes: (cfg.axes ?? []).map((a) => {
      const f = a.field ? fieldsByCode.get(String(a.field).toUpperCase()) : null;
      return { label: a.label ?? f?.name ?? '', unit: a.unit ?? f?.unit ?? null, field: f ? { code: f.code, name: f.name, unit: f.unit } : (a.field ? { code: String(a.field).toUpperCase(), name: String(a.field), unit: null } : null) };
    }),
  };
}

async function fieldsOf(db, companyId) {
  const [rows] = await db.query("SELECT id, UPPER(code) AS code, name, default_uom AS unit FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND data_type = 'number'", [companyId]);
  return new Map(rows.map((r) => [r.code, r]));
}

/** subject: { type: 'classification' | 'machine', id } → { chain: [{ type, id, name }] (broadest first, the subject last) } */
async function chainOf(db, companyId, subject) {
  if (subject.type === 'machine') {
    const m = await requireMachine(db, companyId, subject.id);
    const nodes = await ancestors(db, companyId, m.classification_id);
    return { machine: m, chain: [...nodes.map((n) => ({ type: 'classification', id: Number(n.id), name: n.name, code: n.code })), { type: 'machine', id: Number(m.id), name: m.name, code: m.code }] };
  }
  const node = await loadNode(db, companyId, subject.id);
  if (!node) throw notFound('Machine type');
  if (node.scope !== 'machine') throw invalid('NOT_MACHINE', `${node.name} is not a machine family or type.`);
  const nodes = await ancestors(db, companyId, subject.id);
  return { node, chain: nodes.map((n) => ({ type: 'classification', id: Number(n.id), name: n.name, code: n.code })) };
}

/**
 * The charts that reach a machine type or a machine: where each is set up, where its values come
 * from (here, or the machine type above), and which operations' times read it.
 */
export async function listCharts(db, companyId, subject) {
  const { chain } = await chainOf(db, companyId, subject);
  const classIds = chain.filter((s) => s.type === 'classification').map((s) => s.id);
  const machineId = chain.find((s) => s.type === 'machine')?.id ?? null;
  const where = `(a.subject_type = 'classification' AND a.subject_id IN (?))${machineId ? " OR (a.subject_type = 'machine' AND a.subject_id = ?)" : ''}`;
  const [rules] = await db.query(
    `SELECT s.id, s.code, s.name, s.default_uom, s.table_config, a.subject_type, a.subject_id, a.value_rule
       FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id AND s.data_type = 'table' AND s.deleted_at IS NULL
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.is_applicable = 1 AND (${where})`,
    machineId ? [companyId, [0, ...classIds], machineId] : [companyId, [0, ...classIds]],
  );
  if (!rules.length) return [];
  const specIds = [...new Set(rules.map((r) => r.id))];
  const vWhere = `(v.subject_type = 'classification' AND v.subject_id IN (?))${machineId ? " OR (v.subject_type = 'machine' AND v.subject_id = ?)" : ''}`;
  const [vals] = await db.query(
    // Only values someone set: a machine also holds a 'defaulted' COPY of its type's chart (valueService.materializeMachine).
    `SELECT v.specification_id, v.subject_type, v.subject_id, v.value_json FROM cf_spec_values v
      WHERE v.company_id = ? AND v.deleted_at IS NULL AND v.specification_id IN (?) AND (${vWhere}) AND (v.source IS NULL OR v.source = 'entered')`,
    machineId ? [companyId, specIds, [0, ...classIds], machineId] : [companyId, specIds, [0, ...classIds]],
  );
  const fields = await fieldsOf(db, companyId);
  const level = (t, id) => chain.findIndex((s) => s.type === t && s.id === Number(id));
  const subjectAt = (i) => (i >= 0 ? { type: chain[i].type, id: chain[i].id, name: chain[i].name } : null);
  const out = new Map();
  for (const r of rules) {
    const i = level(r.subject_type, r.subject_id);
    const prev = out.get(r.id);
    if (!prev || i > prev._ruleAt) out.set(r.id, { ...chartSpec(r, fields), _ruleAt: i, definedAt: subjectAt(i), valueRule: r.value_rule });
  }
  for (const c of out.values()) {
    const mine = vals.filter((v) => Number(v.specification_id) === c.specId).map((v) => ({ ...v, at: level(v.subject_type, v.subject_id) })).sort((a, b) => b.at - a.at);
    const v = mine[0] ?? null;
    c.value = v ? parseJson(v.value_json) : null;
    c.valueFrom = v ? subjectAt(v.at) : null;
    c.own = !!v && v.at === chain.length - 1;
  }
  const codes = [...out.values()].map((c) => c.code);
  const [uses] = await db.query(
    `SELECT DISTINCT o.code, r.work_expression, r.setup_expression FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id AND o.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND (${codes.map(() => "CONCAT(COALESCE(r.work_expression, ''), ' ', COALESCE(r.setup_expression, '')) LIKE ?").join(' OR ')})`,
    [companyId, ...codes.map((code) => `%machine.${code}%`)],
  );
  for (const c of out.values()) {
    c.usedBy = [...new Set(uses.filter((u) => `${u.work_expression ?? ''} ${u.setup_expression ?? ''}`.toUpperCase().includes(`MACHINE.${c.code.toUpperCase()}`)).map((u) => u.code))];
    c.shortForm = c.axes.length > 0 && c.axes.every((a) => a.field) ? c.code : null;
    delete c._ruleAt;
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Columns from the form: [{ field } | { label, unit }] → table_config axes, with problems in words. */
function readAxes(raw, fields, problems) {
  const axes = Array.isArray(raw) ? raw : [];
  if (axes.length < 1 || axes.length > 2) { problems.push('A chart has one or two columns it is read by.'); return []; }
  return axes.map((a, i) => {
    const which = i === 0 ? 'The first column' : 'The second column';
    if (!blank(a?.field)) {
      const f = fields.get(String(a.field).toUpperCase());
      if (!f) { problems.push(`${which}: ${a.field} is not a number value of a piece.`); return null; }
      const unit = blank(a.unit) ? f.unit : String(a.unit).trim();
      if (blank(unit)) problems.push(`${which}: ${f.name} has no unit — give one.`);
      return { label: blank(a.label) ? f.name : String(a.label).trim(), unit: unit ?? null, field: f.code };
    }
    if (blank(a?.label)) { problems.push(`${which}: say what it is read by.`); return null; }
    if (blank(a?.unit)) problems.push(`${which}: give its unit.`);
    return { label: String(a.label).trim(), unit: blank(a.unit) ? null : String(a.unit).trim() };
  }).filter(Boolean);
}

/**
 * input: { name, code?, resultUnit, axes: [{ field } | { label, unit }], mode?, value? }
 * subject: { type: 'classification' | 'machine', id }. Returns the subject's charts.
 */
export async function createChart(db, c, subject, input = {}) {
  const { companyId } = c;
  await chainOf(db, companyId, subject);
  const problems = [];
  const name = String(input.name ?? '').trim();
  if (!name) problems.push('Give the chart a name, e.g. Gas cutting speed.');
  if (blank(input.resultUnit)) problems.push('Say the unit of what the chart gives, e.g. mm/min.');
  const mode = input.mode ?? 'step_up';
  if (!MODES.includes(mode)) problems.push('Between two rows the chart steps up to the next row, or reads a straight line.');
  const fields = await fieldsOf(db, companyId);
  const axes = readAxes(input.axes, fields, problems);
  let code = codeFrom(blank(input.code) ? name : input.code);
  if (!code) problems.push('The chart needs a code of letters and numbers.');
  assertNoProblems(problems, 'The chart cannot be added yet.');
  // A code the company already has gets a number after it.
  const [taken] = await db.query('SELECT UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND code LIKE ?', [companyId, `${code}%`]);
  const used = new Set(taken.map((t) => t.code));
  if (used.has(code)) { let n = 2; while (used.has(`${code}_${n}`)) n++; code = `${code}_${n}`; }
  const [r] = await db.query(
    "INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, table_config, status, created_by) VALUES (?, ?, ?, 'table', ?, ?, 'active', ?)",
    [companyId, code, name.slice(0, 255), String(input.resultUnit).trim().slice(0, 30), JSON.stringify({ axes, mode }), c.userId ?? null],
  );
  await db.query(
    "INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, created_by) VALUES (?, ?, ?, ?, 'item', 0, 1, 'defaulted', ?)",
    [companyId, r.insertId, subject.type, subject.id, c.userId ?? null],
  );
  if (input.value != null && input.value !== '') await setValues(db, c, subject.type, subject.id, [{ specificationId: r.insertId, value: input.value }]);
  return { chartId: r.insertId, code, charts: await listCharts(db, companyId, subject) };
}

/** input: { name?, resultUnit?, axes?, mode? } — the column COUNT is fixed once the chart has values. */
export async function updateChart(db, c, specId, input = {}) {
  const { companyId } = c;
  const [[s]] = await db.query("SELECT id, code, name, default_uom, table_config FROM cf_specifications WHERE company_id = ? AND id = ? AND data_type = 'table' AND deleted_at IS NULL", [companyId, Number(specId)]);
  if (!s) throw notFound('Chart');
  const cfg = parseJson(s.table_config) ?? { axes: [], mode: 'step_up' };
  const problems = [];
  const sets = {};
  if (input.name !== undefined) { const n = String(input.name ?? '').trim(); if (!n) problems.push('A chart needs a name.'); else sets.name = n.slice(0, 255); }
  if (input.resultUnit !== undefined) { if (blank(input.resultUnit)) problems.push('Say the unit of what the chart gives.'); else sets.default_uom = String(input.resultUnit).trim().slice(0, 30); }
  if (input.mode !== undefined) { if (!MODES.includes(input.mode)) problems.push('Between two rows the chart steps up or reads a straight line.'); else cfg.mode = input.mode; }
  if (input.axes !== undefined) {
    const axes = readAxes(input.axes, await fieldsOf(db, companyId), problems);
    if (axes.length !== (cfg.axes?.length ?? 0)) {
      const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_spec_values WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL', [companyId, s.id]);
      if (Number(n)) problems.push('The chart has values, so it keeps its number of columns — add a new chart for another shape.');
    }
    cfg.axes = axes;
  }
  assertNoProblems(problems, 'The chart cannot be changed like that.');
  sets.table_config = JSON.stringify(cfg);
  await db.query(`UPDATE cf_specifications SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...Object.values(sets), companyId, s.id]);
  const [[row]] = await db.query('SELECT id, code, name, default_uom, table_config FROM cf_specifications WHERE id = ?', [s.id]);
  return chartSpec(row, await fieldsOf(db, companyId));
}

/** The machine type page: its path, its machines and its charts (its rules come from GET /classification/:id/resolved). */
export async function machineTypeDetails(db, companyId, nodeId) {
  const { node, chain } = await chainOf(db, companyId, { type: 'classification', id: nodeId });
  const [machines] = await db.query(
    `WITH RECURSIVE sub AS (SELECT id FROM cf_classification_nodes WHERE company_id = ? AND id = ?
       UNION ALL SELECT n.id FROM cf_classification_nodes n JOIN sub ON n.parent_id = sub.id WHERE n.deleted_at IS NULL)
     SELECT m.id, m.code, m.name, m.status, m.classification_id FROM cf_machines m
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.classification_id IN (SELECT id FROM sub) ORDER BY m.code, m.name`,
    [companyId, nodeId, companyId],
  );
  return {
    node: { id: Number(node.id), code: node.code, name: node.name, depth: node.depth, status: node.status ?? null, description: node.description ?? null },
    path: chain.map((s) => ({ id: s.id, code: s.code, name: s.name })),
    machines: machines.map((m) => ({ id: m.id, code: m.code, name: m.name, status: m.status })),
    charts: await listCharts(db, companyId, { type: 'classification', id: nodeId }),
  };
}
