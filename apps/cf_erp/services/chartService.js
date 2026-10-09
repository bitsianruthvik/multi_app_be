/**
 * chartService.js — charts on a machine type or a machine (user, 2026-10-08: "give an option on a
 * machine or a machine type to add a new lookup specification … mention the units in the column
 * heading … edit the specification table from the machine or machine type itself"; then "multiple
 * variables and a single value … selecting specifications as variables and a particular value name
 * … classifications also as an option … item.family, item.subfamily").
 *
 * A CHART is a table specification, kept as ROWS (table_config.version 2):
 *   inputs   any number of columns, each either a SPECIFICATION of the piece (number, pick-list or
 *            text; its heading is the specification's name and its unit) or a LEVEL of the tree
 *            (Family, Subfamily, Variant — a cell names a node at that level);
 *   result   one number: the chart's name and unit (e.g. Drill time, s);
 *   mode     a number between two rows steps up to the next row, or every number column reads
 *            on straight lines at once (formulaEngine.lookupRows);
 *   rows     [[in1, …, inN, result], …] — read left to right by formulaEngine.lookupRows.
 * One form on the machine type or machine page creates the specification, its rule where it was
 * added (defaulted: a machine type's chart is every machine's of that type unless a machine has
 * its own) and its rows.
 *
 * In a time formula a chart is written as the machine's — `item.HOLES * machine.DRILL_TIME / 60` — and reads
 * its inputs from the piece by itself (lib/chartFormula.js).
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { ancestors, loadNode, LEVELS } from './tree.js';
import { requireMachine } from './records.js';
import { setValues } from './valueService.js';

const MODES = ['step_up', 'linear'];
const LEVEL_KEYS = LEVELS.map((l) => l.toUpperCase());          // FAMILY, SUBFAMILY, VARIANT
const blank = (v) => v == null || String(v).trim() === '';
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const codeFrom = (name) => String(name ?? '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 60);
const norm = (s) => String(s ?? '').trim().toLowerCase();

/** An input column's word in a formula: item.THICKNESS, item.FAMILY. */
const inputRef = (a) => (a.kind === 'level' ? a.level : a.field);

/**
 * Map CODE -> [FIELD | LEVEL, …] for every chart whose every column names something of the piece —
 * a specification or a tree level (the short formula form, lib/chartFormula.js).
 */
export async function chartBindings(db, companyId) {
  const [rows] = await db.query("SELECT UPPER(code) AS code, table_config FROM cf_specifications WHERE company_id = ? AND data_type = 'table' AND deleted_at IS NULL", [companyId]);
  const out = new Map();
  for (const r of rows) {
    const axes = parseJson(r.table_config)?.axes ?? [];
    const refs = axes.map((a) => (a.kind === 'level' ? a.level : a.field)).filter((x) => !blank(x));
    if (axes.length && refs.length === axes.length) out.set(r.code, refs.map((x) => String(x).toUpperCase()));
  }
  return out;
}

async function fieldsOf(db, companyId) {
  const [rows] = await db.query("SELECT id, UPPER(code) AS code, name, data_type, default_uom AS unit FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND data_type IN ('number', 'option', 'text')", [companyId]);
  return new Map(rows.map((r) => [r.code, r]));
}

/** The chart as screens read it, from its specification row (a version-1 chart reads as rows too). */
function chartSpec(r, fields) {
  const cfg = parseJson(r.table_config) ?? {};
  const axes = (cfg.axes ?? []).map((a) => {
    if (a.kind === 'level') return { kind: 'level', level: a.level, label: a.label ?? a.level, unit: null, dataType: 'level' };
    const f = a.field ? fields.get(String(a.field).toUpperCase()) : null;
    return {
      kind: 'spec', field: a.field ? String(a.field).toUpperCase() : null, label: a.label ?? f?.name ?? '',
      unit: a.unit ?? f?.unit ?? null, dataType: a.dataType ?? f?.data_type ?? 'number',
    };
  });
  return { specId: r.id, code: r.code, name: r.name, resultUnit: r.default_uom ?? null, mode: cfg.mode ?? 'step_up', version: cfg.version ?? 1, axes };
}

/** A version-1 value ({ x, v } or { x, y, v }) as rows, so every chart reads the same way. */
export function rowsOfValue(value) {
  const v = parseJson(value);
  if (!v) return null;
  if (Array.isArray(v.rows)) return v.rows;
  if (!Array.isArray(v.x)) return null;
  if (Array.isArray(v.y) && v.y.length) {
    const out = [];
    // A blank cell stays a row with a blank result: "the machine cannot" — never a step on to the next size.
    v.y.forEach((y, j) => v.x.forEach((x, i) => { out.push([x, y, v.v?.[j]?.[i] ?? null]); }));
    return out;
  }
  return v.x.map((x, i) => [x, v.v?.[i] ?? null]);
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
 * The charts that reach a machine type or a machine: where each is set up, where its rows come
 * from (here, or the machine type above), which operations' times read it, and the tree nodes its
 * level columns name ({ id: { code, name } }).
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
  const nodeIds = new Set();
  for (const c of out.values()) {
    const mine = vals.filter((v) => Number(v.specification_id) === c.specId).map((v) => ({ ...v, at: level(v.subject_type, v.subject_id) })).sort((a, b) => b.at - a.at);
    const v = mine[0] ?? null;
    c.rows = v ? rowsOfValue(v.value_json) : null;
    c.valueFrom = v ? subjectAt(v.at) : null;
    c.own = !!v && v.at === chain.length - 1;
    c.axes.forEach((a, i) => { if (a.kind === 'level') for (const row of c.rows ?? []) nodeIds.add(Number(row[i])); });
  }
  const [nodes] = nodeIds.size ? await db.query('SELECT id, code, name FROM cf_classification_nodes WHERE company_id = ? AND id IN (?)', [companyId, [...nodeIds]]) : [[]];
  const nodeMap = Object.fromEntries(nodes.map((n) => [n.id, { code: n.code, name: n.name }]));
  const codes = [...out.values()].map((c) => c.code);
  const [uses] = await db.query(
    `SELECT DISTINCT o.code, r.work_expression, r.setup_expression FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id AND o.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND (${codes.map(() => "CONCAT(COALESCE(r.work_expression, ''), ' ', COALESCE(r.setup_expression, '')) LIKE ?").join(' OR ')})`,
    [companyId, ...codes.map((code) => `%machine.${code}%`)],
  );
  for (const c of out.values()) {
    c.usedBy = [...new Set(uses.filter((u) => `${u.work_expression ?? ''} ${u.setup_expression ?? ''}`.toUpperCase().includes(`MACHINE.${c.code.toUpperCase()}`)).map((u) => u.code))];
    c.shortForm = c.axes.length > 0 && c.axes.every((a) => (a.kind === 'level' ? a.level : a.field)) ? `machine.${c.code}` : null;
    c.nodes = nodeMap;
    // Kept for screens written against the first version: the one- and two-column shape.
    c.value = c.rows ? { rows: c.rows } : null;
    delete c._ruleAt;
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Columns from the form: [{ field: CODE, unit? } | { level: 'FAMILY' | 'SUBFAMILY' | 'VARIANT' }]
 * (the first version's { label, unit } stays readable) → table_config axes, with problems in words.
 */
function readInputs(raw, fields, problems) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) { problems.push('A chart is read by at least one value of the piece.'); return []; }
  const seen = new Set();
  return list.map((a, i) => {
    const which = `Column ${i + 1}`;
    if (!blank(a?.level)) {
      const lv = String(a.level).toUpperCase();
      if (!LEVEL_KEYS.includes(lv)) { problems.push(`${which}: the tree's levels are ${LEVELS.join(', ')}.`); return null; }
      if (seen.has(lv)) problems.push(`${which}: ${LEVELS[LEVEL_KEYS.indexOf(lv)]} is already a column.`);
      seen.add(lv);
      return { kind: 'level', level: lv, label: LEVELS[LEVEL_KEYS.indexOf(lv)] };
    }
    if (!blank(a?.field)) {
      const f = fields.get(String(a.field).toUpperCase());
      if (!f) { problems.push(`${which}: ${a.field} is not a value a piece has.`); return null; }
      if (seen.has(f.code)) problems.push(`${which}: ${f.name} is already a column.`);
      seen.add(f.code);
      const unit = blank(a.unit) ? f.unit : String(a.unit).trim();
      // A count (coats, holes, studs) has no unit and needs none: its heading is just its name (user, 2026-10-09).
      return { kind: 'spec', field: f.code, label: f.name, unit: f.data_type === 'number' ? unit : null, dataType: f.data_type };
    }
    problems.push(`${which}: pick a specification of the piece, or a level of the tree.`);
    return null;
  }).filter(Boolean);
}

/**
 * Rows as typed or pasted → as stored: a level cell may be the node's id, code or name (a node
 * at that level of the tree); a pick-list cell its option's value or label (stored as the value).
 * Returns { rows } or throws with the problems in words.
 */
export async function normaliseRows(db, companyId, axes, rawRows) {
  if (rawRows == null) return null;
  const rows = Array.isArray(rawRows) ? rawRows : (Array.isArray(rawRows?.rows) ? rawRows.rows : null);
  if (!rows) throw invalid('INVALID', 'A chart is saved as rows: its inputs, then its result.');
  const problems = [];
  const levelIdx = axes.map((a, i) => (a.kind === 'level' ? i : -1)).filter((i) => i >= 0);
  const optionIdx = axes.map((a, i) => (a.kind === 'spec' && a.dataType === 'option' ? i : -1)).filter((i) => i >= 0);
  let nodes = [];
  if (levelIdx.length) [nodes] = await db.query("SELECT id, code, name, depth FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND scope <> 'machine'", [companyId]);
  const options = new Map();
  if (optionIdx.length) {
    const [opts] = await db.query(
      `SELECT UPPER(s.code) AS spec, o.value, o.label FROM cf_spec_options o JOIN cf_specifications s ON s.id = o.specification_id
        WHERE o.company_id = ? AND o.deleted_at IS NULL AND s.code IN (?)`,
      [companyId, optionIdx.map((i) => axes[i].field)],
    );
    for (const o of opts) { if (!options.has(o.spec)) options.set(o.spec, []); options.get(o.spec).push(o); }
  }
  const out = rows.map((row, n) => {
    const r = Array.isArray(row) ? [...row] : [];
    for (const i of levelIdx) {
      const cell = r[i];
      const depth = LEVEL_KEYS.indexOf(axes[i].level);
      const atLevel = nodes.filter((x) => Number(x.depth) === depth);
      const hit = atLevel.find((x) => Number(x.id) === Number(cell)) ?? atLevel.find((x) => norm(x.code) === norm(cell)) ?? atLevel.find((x) => norm(x.name) === norm(cell));
      if (!hit) problems.push(`Row ${n + 1}: "${cell ?? ''}" is not a ${axes[i].label.toLowerCase()} of the tree.`);
      else r[i] = Number(hit.id);
    }
    for (const i of optionIdx) {
      const list = options.get(axes[i].field) ?? [];
      const hit = list.find((o) => norm(o.value) === norm(r[i])) ?? list.find((o) => norm(o.label) === norm(r[i]));
      if (!hit) problems.push(`Row ${n + 1}: "${r[i] ?? ''}" is not one of ${axes[i].label}'s choices.`);
      else r[i] = hit.value;
    }
    return r;
  });
  assertNoProblems(problems, 'Some rows cannot be read.');
  return { rows: out };
}

async function specRow(db, companyId, specId) {
  const [[s]] = await db.query("SELECT id, code, name, default_uom, table_config FROM cf_specifications WHERE company_id = ? AND id = ? AND data_type = 'table' AND deleted_at IS NULL", [companyId, Number(specId)]);
  if (!s) throw notFound('Chart');
  return s;
}

/** Saves a chart's rows on a machine type or machine (value null = drop its own). Returns the subject's charts. */
export async function setChartValue(db, c, subject, specId, value) {
  const s = await specRow(db, c.companyId, specId);
  const cfg = parseJson(s.table_config) ?? {};
  const v = value == null || value === '' ? null : (cfg.version >= 2 ? await normaliseRows(db, c.companyId, cfg.axes ?? [], value) : value);
  await setValues(db, c, subject.type, subject.id, [{ specificationId: s.id, value: v }]);
  return listCharts(db, c.companyId, subject);
}

/**
 * input: { name, code?, resultUnit, inputs: [{ field, unit? } | { level }], mode?, rows? }
 * (`axes` is read as `inputs`). subject: { type: 'classification' | 'machine', id }.
 */
export async function createChart(db, c, subject, input = {}) {
  const { companyId } = c;
  await chainOf(db, companyId, subject);
  const problems = [];
  const name = String(input.name ?? '').trim();
  if (!name) problems.push('Give what the chart gives a name, e.g. Drill time.');
  if (blank(input.resultUnit)) problems.push('Say its unit, e.g. s, min/m, mm/min.');
  const mode = input.mode ?? 'step_up';
  if (!MODES.includes(mode)) problems.push('Between two rows the chart steps up to the next row, or reads a straight line.');
  const axes = readInputs(input.inputs ?? input.axes, await fieldsOf(db, companyId), problems);
  let code = codeFrom(blank(input.code) ? name : input.code);
  if (!code) problems.push('The chart needs a code of letters and numbers.');
  assertNoProblems(problems, 'The chart cannot be added yet.');
  // A code the company already has gets a number after it.
  const [taken] = await db.query('SELECT UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND code LIKE ?', [companyId, `${code}%`]);
  const used = new Set(taken.map((t) => t.code));
  if (used.has(code)) { let n = 2; while (used.has(`${code}_${n}`)) n++; code = `${code}_${n}`; }
  const [r] = await db.query(
    "INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, table_config, status, created_by) VALUES (?, ?, ?, 'table', ?, ?, 'active', ?)",
    [companyId, code, name.slice(0, 255), String(input.resultUnit).trim().slice(0, 30), JSON.stringify({ version: 2, axes, mode }), c.userId ?? null],
  );
  await db.query(
    "INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, created_by) VALUES (?, ?, ?, ?, 'item', 0, 1, 'defaulted', ?)",
    [companyId, r.insertId, subject.type, subject.id, c.userId ?? null],
  );
  const rows = input.rows ?? input.value;
  if (rows != null && rows !== '' && !(Array.isArray(rows) && !rows.length)) await setChartValue(db, c, subject, r.insertId, rows);
  return { chartId: r.insertId, code, charts: await listCharts(db, companyId, subject) };
}

/** "A, B" for the words of a row's inputs. */
const rowWords = (row, n) => row.slice(0, n).map((v) => (v == null || v === '' ? 'blank' : String(v))).join(', ');
const sameCell = (x, y) => (x == null || x === '' ? y == null || y === '' : String(x).trim().toLowerCase() === String(y ?? '').trim().toLowerCase());

/**
 * A chart's rows re-laid for new inputs (user, 2026-10-09: "not letting me edit … change the order of
 * variables or adding new variables or changing the units"). from[i] = the old column the new
 * column i was, or null for a new one, which takes fill[i] in every existing row. A removed column's
 * values go; two rows that then read the same and give different results are refused, in words.
 * Returns { rows } or { problem }.
 */
export function relayRows(rows, oldCount, from, fill) {
  const out = [];
  const seen = new Map();
  for (const r of rows) {
    const next = [...from.map((k, i) => (k != null ? r[k] : fill[i] ?? null)), r[oldCount] ?? null];
    const key = JSON.stringify(next.slice(0, from.length).map((v) => (v == null ? '' : String(v).trim().toLowerCase())));
    const had = seen.get(key);
    if (had) {
      if (sameCell(had[from.length], next[from.length])) continue;
      return { problem: `Without the removed input two rows would both read ${rowWords(next, from.length)} but give ${had[from.length] ?? 'blank'} and ${next[from.length] ?? 'blank'}. Change or delete one of them first.` };
    }
    seen.set(key, next);
    out.push(next);
  }
  return { rows: out };
}

/**
 * input: { name?, resultUnit?, inputs?, mode? }. Each input may carry `from` (the index of the old
 * column it is — so a moved column moves its values) and, for a new input on a chart that already has
 * rows, `fill` (the value every existing row is for). Every value of the chart (the type's, a
 * machine's own, a machine's copy) is re-laid the same way, and every saved time that reads the chart
 * by its old inputs is rewritten to its new ones. A unit is the heading's word: the rows are not converted.
 */
export async function updateChart(db, c, specId, input = {}) {
  const { companyId } = c;
  const s = await specRow(db, companyId, specId);
  const cfg = parseJson(s.table_config) ?? { axes: [], mode: 'step_up' };
  const oldAxes = cfg.axes ?? [];
  const problems = [];
  const sets = {};
  if (input.name !== undefined) { const n = String(input.name ?? '').trim(); if (!n) problems.push('A chart needs a name.'); else sets.name = n.slice(0, 255); }
  if (input.resultUnit !== undefined) { if (blank(input.resultUnit)) problems.push('Say the unit of what the chart gives.'); else sets.default_uom = String(input.resultUnit).trim().slice(0, 30); }
  if (input.mode !== undefined) { if (!MODES.includes(input.mode)) problems.push('Between two rows the chart steps up or reads a straight line.'); else cfg.mode = input.mode; }
  const given = input.inputs ?? input.axes;
  let relaid = null;
  let refsChanged = false;
  if (given !== undefined) {
    const axes = readInputs(given, await fieldsOf(db, companyId), problems);
    if (!problems.length) {
      const from = axes.map((a, i) => {
        const g = given[i] ?? {};
        if (g.from != null && g.from !== '' && Number.isInteger(Number(g.from)) && Number(g.from) >= 0 && Number(g.from) < oldAxes.length) return Number(g.from);
        const k = oldAxes.findIndex((o) => inputRef(o) && String(inputRef(o)).toUpperCase() === String(inputRef(a)).toUpperCase());
        return k >= 0 ? k : null;
      });
      const fill = axes.map((_, i) => (blank(given[i]?.fill) ? null : String(given[i].fill).trim()));
      const unchanged = from.length === oldAxes.length && from.every((k, i) => k === i);
      refsChanged = !(axes.length === oldAxes.length && axes.every((x, i) => String(inputRef(x) ?? '').toUpperCase() === String(inputRef(oldAxes[i]) ?? '').toUpperCase()));
      if (!unchanged) {
        const [vals] = await db.query('SELECT id, value_json FROM cf_spec_values WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL AND value_json IS NOT NULL', [companyId, s.id]);
        const withRows = vals.map((v) => ({ id: v.id, rows: rowsOfValue(v.value_json) })).filter((v) => v.rows?.length);
        if (withRows.length) {
          axes.forEach((x, i) => {
            if (from[i] == null && fill[i] == null) problems.push(`${x.label} is a new input and the chart already has rows: say which ${x.kind === 'level' ? x.label.toLowerCase() : 'value'} those rows are for.`);
            if (from[i] != null && x.kind !== (oldAxes[from[i]].kind === 'level' ? 'level' : 'spec')) problems.push(`${x.label} cannot take over a column of another kind.`);
          });
          if (!problems.length) {
            relaid = [];
            for (const v of withRows) {
              const r = relayRows(v.rows, oldAxes.length, from, fill);
              if (r.problem) { problems.push(r.problem); break; }
              // A new tree-level or pick-list column names its node or choice by name: stored as id / value.
              const norm = axes.some((x, i) => from[i] == null && (x.kind === 'level' || x.dataType === 'option')) ? (await normaliseRows(db, companyId, axes, r.rows)).rows : r.rows;
              relaid.push({ id: v.id, rows: norm });
            }
          }
        }
      }
    }
    cfg.axes = axes;
    cfg.version = 2;
  }
  assertNoProblems(problems, 'The chart cannot be changed like that.');
  sets.table_config = JSON.stringify(cfg);
  await db.query(`UPDATE cf_specifications SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...Object.values(sets), companyId, s.id]);
  for (const v of relaid ?? []) await db.query('UPDATE cf_spec_values SET value_json = ? WHERE company_id = ? AND id = ?', [JSON.stringify({ rows: v.rows }), companyId, v.id]);
  if (refsChanged) await rewriteTimes(db, companyId, s.code, oldAxes, cfg.axes);
  return chartSpec(await specRow(db, companyId, s.id), await fieldsOf(db, companyId));
}

/**
 * Saved times read a chart as LOOKUP(machine.CODE, item.A, item.B) (lib/chartFormula.js). When its
 * inputs change, every LOOKUP that read it by exactly its old inputs is rewritten to the new ones,
 * so the time still reads the chart the way the person wrote it (machine.CODE).
 */
async function rewriteTimes(db, companyId, code, oldAxes, newAxes) {
  const oldArgs = oldAxes.map((x) => `item.${String(inputRef(x) ?? '').toUpperCase()}`);
  const newArgs = newAxes.map((x) => `item.${String(inputRef(x)).toUpperCase()}`).join(', ');
  const re = new RegExp(`LOOKUP\\s*\\(\\s*machine\\.${code.replace(/[^A-Za-z0-9_]/g, '')}\\s*,([^()]*)\\)`, 'gi');
  const swap = (expr) => (expr == null ? expr : String(expr).replace(re, (whole, rest) => {
    const args = rest.split(',').map((x) => x.trim().toUpperCase().replace(/^ITEM\./, 'item.'));
    // Its old inputs in any order (a column reads its own value, formulaEngine.alignedArgs).
    return args.length === oldArgs.length && new Set(args).size === args.length && oldArgs.every((x) => args.includes(x)) ? `LOOKUP(machine.${code}, ${newArgs})` : whole;
  }));
  const like = `%machine.${code}%`;
  const [rules] = await db.query('SELECT id, work_expression AS w, setup_expression AS s FROM cf_operation_machine_rules WHERE company_id = ? AND deleted_at IS NULL AND (work_expression LIKE ? OR setup_expression LIKE ?)', [companyId, like, like]);
  for (const r of rules) {
    const w = swap(r.w); const st = swap(r.s);
    if (w !== r.w || st !== r.s) await db.query('UPDATE cf_operation_machine_rules SET work_expression = ?, setup_expression = ? WHERE company_id = ? AND id = ?', [w, st, companyId, r.id]);
  }
  const [forms] = await db.query('SELECT id, expression FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL AND expression LIKE ?', [companyId, like]);
  for (const f of forms) { const e = swap(f.expression); if (e !== f.expression) await db.query('UPDATE cf_formulas SET expression = ? WHERE company_id = ? AND id = ?', [e, companyId, f.id]); }
}

/**
 * Deletes a chart: the specification, its rules and every value. Refused while a time or a formula
 * still reads it — they are named, so the person can change them first.
 */
export async function deleteChart(db, c, specId) {
  const { companyId } = c;
  const s = await specRow(db, companyId, specId);
  const reads = new RegExp(`machine\\.${s.code.replace(/[^A-Za-z0-9_]/g, '')}(?![A-Za-z0-9_])`, 'i');
  const like = `%machine.${s.code}%`;
  const [rules] = await db.query(
    `SELECT o.code, o.name, r.work_expression AS w, r.setup_expression AS st FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id AND o.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND (r.work_expression LIKE ? OR r.setup_expression LIKE ?)`, [companyId, like, like]);
  const [forms] = await db.query('SELECT code, name, expression FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL AND expression LIKE ?', [companyId, like]);
  const users = [...new Set([
    ...rules.filter((r) => reads.test(`${r.w ?? ''} ${r.st ?? ''}`)).map((r) => `operation ${r.code}`),
    ...forms.filter((f) => reads.test(f.expression ?? '')).map((f) => `formula ${f.code ?? f.name}`),
  ])];
  if (users.length) throw invalid('IN_USE', `${s.name} is read by ${users.join(', ')}. Change ${users.length === 1 ? 'that time' : 'those'} first, then delete the chart.`);
  await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL', [companyId, s.id]);
  await db.query('UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL', [companyId, s.id]);
  await db.query('UPDATE cf_specifications SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [companyId, s.id]);
  return { ok: true, deleted: { specId: s.id, code: s.code, name: s.name } };
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
