/**
 * formulaBuilderService.js — what the operation-time builder needs to help
 * someone write a timing formula: which fields a piece and a machine have
 * (name, unit, a real example value), the machines a rule covers with their
 * own values and charts, and real pieces that go through the operation to try
 * the formula on.
 *
 * SET-BASED: a fixed number of reads however many machines or pieces — five
 * round trips, most of them in parallel — because every round trip is ~49 ms on
 * production. Values are read straight from cf_spec_values (own value beats the
 * template's; a machine's own beats its deepest type's), which is what the
 * builder needs for EXAMPLES. The live preview itself resolves the one chosen
 * piece and machine properly (checkForBuilder below), exactly as the Times
 * grid does.
 */
import { invalid, notFound } from '../lib/errors.js';
import { loadMaster, requireMachine } from './records.js';
import { resolve, effectiveByCode, levelsOfResolution, parseJsonCol } from './resolutionService.js';
import { valueReaders } from './operationService.js';
import { checkFormula } from './formulaService.js';
import { LEAF_DEPTH } from './tree.js';

const MAX_MACHINES = 60;
const MAX_PIECES = 30;

const blank = (v) => v == null || String(v).trim() === '';
const num = (v) => (v == null ? null : Number(v));

function fieldOf(s) {
  return {
    code: s.code,
    name: s.name,
    dataType: s.data_type,
    measurementType: s.measurement_type ?? null,
    unit: s.default_uom ?? null,
    description: s.description ?? null,
    ...(s.data_type === 'table' ? { tableConfig: parseJsonCol(s.table_config) } : {}),
  };
}

/**
 * GET /operations/:id/formula-builder?subjectType=&subjectId=
 * subject = the timing rule's (a machine type at any level, or one machine);
 * without one, every machine an eligible rule of the operation names.
 */
export async function builderContext(db, companyId, operationId, q = {}) {
  const [[op]] = await db.query('SELECT id, code, name FROM cf_operations WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, operationId]);
  if (!op) throw notFound('Operation');
  const subjectType = blank(q.subjectType) ? null : String(q.subjectType);
  const subjectId = blank(q.subjectId) ? null : Number(q.subjectId);
  if (subjectType && !['classification', 'machine'].includes(subjectType)) throw invalid('INVALID', 'subjectType is classification or machine.');

  const [[specs], [nodes], [machines], [flows], [rules]] = await Promise.all([
    db.query(`SELECT id, code, name, data_type, measurement_type, default_uom, table_config, description FROM cf_specifications
               WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND data_type IN ('number', 'table', 'option', 'text') ORDER BY name`, [companyId]),
    db.query("SELECT id, parent_id, depth, code, name FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND scope = 'machine'", [companyId]),
    db.query("SELECT id, code, name, classification_id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY code", [companyId]),
    db.query('SELECT DISTINCT flow_id FROM cf_operation_flow_steps WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [companyId, operationId]),
    db.query('SELECT subject_type, subject_id FROM cf_operation_machine_rules WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL AND eligible = 1', [companyId, operationId]),
  ]);
  const specById = new Map(specs.map((s) => [s.id, s]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // A machine's type chain, deepest first (the same bound as tree.ancestors).
  const chainOf = (nodeId) => {
    const out = [];
    let n = nodeById.get(nodeId);
    for (let hop = 0; n && hop < LEAF_DEPTH + 3; hop++, n = nodeById.get(n.parent_id)) out.push(n);
    return out;
  };

  // Which machines the builder can preview on.
  const covers = (m, type, id) => (type === 'machine' ? m.id === id : chainOf(m.classification_id).some((n) => n.id === id));
  const subjects = subjectType && subjectId ? [{ subject_type: subjectType, subject_id: subjectId }] : rules;
  const reached = machines.filter((m) => subjects.some((s) => covers(m, s.subject_type, s.subject_id))).slice(0, MAX_MACHINES);

  // Their values: the type chains' and their own, in two reads.
  const clsIds = [...new Set(reached.flatMap((m) => chainOf(m.classification_id).map((n) => n.id)))];
  const machineIds = reached.map((m) => m.id);
  const scope = [];
  const scopeParams = [];
  if (clsIds.length) { scope.push("(subject_type = 'classification' AND subject_id IN (?))"); scopeParams.push(clsIds); }
  if (machineIds.length) { scope.push("(subject_type = 'machine' AND subject_id IN (?))"); scopeParams.push(machineIds); }
  const flowIds = flows.map((f) => f.flow_id);
  const pieceSql = `SELECT m.id, m.code, m.name, i.item_type, i.source_definition_id, so.code AS order_code, ol.line_no
       FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_master_records def ON def.id = i.source_definition_id
       LEFT JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
       LEFT JOIN cf_sales_orders so ON so.id = ol.order_id`;
  const [[assigned], [machineValues], [pieces]] = await Promise.all([
    scope.length
      ? db.query(`SELECT DISTINCT specification_id FROM cf_spec_assignments WHERE company_id = ? AND deleted_at IS NULL AND capture_at = 'item' AND (${scope.join(' OR ')})`, [companyId, ...scopeParams])
      : [[]],
    scope.length
      ? db.query(`SELECT specification_id, subject_type, subject_id, value_number, value_json FROM cf_spec_values WHERE company_id = ? AND deleted_at IS NULL AND (${scope.join(' OR ')})`, [companyId, ...scopeParams])
      : [[]],
    // Real pieces that go through this operation: their flow (own, their
    // template's, or the BOM line's) has a step for it. Newest first.
    flowIds.length
      ? db.query(`${pieceSql}
          WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item'
            AND (m.default_flow_id IN (?) OR def.default_flow_id IN (?)
                 OR m.id IN (SELECT l.child_id FROM cf_bom_lines l WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.operation_flow_id IN (?)))
          ORDER BY m.id DESC LIMIT ${MAX_PIECES}`, [companyId, flowIds, flowIds, companyId, flowIds])
      : [[]],
  ]);
  let samplePieces = pieces.map((p) => ({ ...p, fromOperation: true }));
  if (!samplePieces.length) {
    // Nothing goes through it yet: offer the newest order pieces, said so.
    const [recent] = await db.query(`${pieceSql} WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND i.item_type = 'temporary'
      ORDER BY m.id DESC LIMIT ${MAX_PIECES}`, [companyId]);
    samplePieces = recent.map((p) => ({ ...p, fromOperation: false }));
  }

  // The pieces' own values, and their templates' (a template's fixed value
  // reaches every piece made from it) — one read.
  const pieceSubjects = [...new Set(samplePieces.flatMap((p) => [p.id, p.source_definition_id]).filter(Boolean))];
  const [pieceValues] = pieceSubjects.length
    ? await db.query(`SELECT v.specification_id, v.subject_id, v.value_number, v.value_json, v.value_text, o.value AS option_value FROM cf_spec_values v LEFT JOIN cf_spec_options o ON o.id = v.option_id
        WHERE v.company_id = ? AND v.deleted_at IS NULL AND v.subject_type = 'master' AND v.subject_id IN (?)`, [companyId, pieceSubjects])
    : [[]];
  // A pick-list or text value is a word (2026-10-08: words in formulas — IF(item.GRADE = "E350", …)).
  const valueOf = (row, spec) => (spec.data_type === 'table' ? parseJsonCol(row.value_json)
    : spec.data_type === 'option' ? (row.option_value ?? null)
      : spec.data_type === 'text' ? (row.value_text ?? null)
        : num(row.value_number));
  const bySubject = new Map();
  for (const v of pieceValues) {
    const spec = specById.get(v.specification_id);
    if (!spec) continue;
    const val = valueOf(v, spec);
    if (val == null) continue;
    if (!bySubject.has(v.subject_id)) bySubject.set(v.subject_id, {});
    bySubject.get(v.subject_id)[spec.code] = val;
  }
  const pieceOut = samplePieces.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    kind: p.item_type,
    orderCode: p.order_code ?? null,
    lineNo: p.line_no ?? null,
    fromOperation: p.fromOperation,
    values: { ...(bySubject.get(p.source_definition_id) ?? {}), ...(bySubject.get(p.id) ?? {}) },
  }));

  // Each machine's values: most specific wins (the machine, then its deepest type).
  const valueAt = new Map();
  for (const v of machineValues) valueAt.set(`${v.subject_type}:${v.subject_id}:${v.specification_id}`, v);
  const machineSpecIds = new Set([...assigned.map((a) => a.specification_id), ...machineValues.map((v) => v.specification_id)]);
  const machinesOut = reached.map((m) => {
    const values = {};
    const chain = [{ type: 'machine', id: m.id }, ...chainOf(m.classification_id).map((n) => ({ type: 'classification', id: n.id }))];
    for (const specId of machineSpecIds) {
      const spec = specById.get(specId);
      if (!spec) continue;
      for (const s of chain) {
        const row = valueAt.get(`${s.type}:${s.id}:${specId}`);
        const val = row ? valueOf(row, spec) : null;
        if (val != null) {
          values[spec.code] = spec.data_type === 'table' ? { mode: parseJsonCol(spec.table_config)?.mode ?? 'step_up', axes: parseJsonCol(spec.table_config)?.axes ?? [], ...val } : val;
          break;
        }
      }
    }
    const type = nodeById.get(m.classification_id);
    return { id: m.id, code: m.code, name: m.name, typeName: type?.name ?? null, values };
  });

  const machineFields = [...machineSpecIds].map((id) => specById.get(id)).filter(Boolean).map((s) => {
    const withIt = machinesOut.filter((m) => m.values[s.code] != null);
    return { ...fieldOf(s), example: withIt[0] ? (s.data_type === 'table' ? null : withIt[0].values[s.code]) : null, exampleFrom: withIt[0]?.code ?? null, count: withIt.length };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Every number / table field a piece might carry; the ones real pieces have first.
  // A chart is offered on the piece side only when a real piece has one (charts live on machines).
  const onPiece = (s) => pieceOut.some((p) => p.values[s.code] != null);
  const itemFields = specs.filter((s) => (['number', 'option', 'text'].includes(s.data_type) && !machineSpecIds.has(s.id)) || onPiece(s)).map((s) => {
    const withIt = pieceOut.filter((p) => p.values[s.code] != null);
    return { ...fieldOf(s), example: withIt[0] && s.data_type !== 'table' ? withIt[0].values[s.code] : null, exampleFrom: withIt[0]?.code ?? null, count: withIt.length };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    operation: { id: op.id, code: op.code, name: op.name },
    machines: machinesOut,
    machineFields,
    itemFields,
    samplePieces: pieceOut,
  };
}

/**
 * POST /formulas/check with itemId / machineId: the same check, evaluated on a
 * real piece and a real machine (resolved properly, as the Times grid does),
 * with any typed sample value laid over them. Returns `inputs` — what each name
 * read and from where.
 */
export async function checkForBuilder(db, companyId, body = {}) {
  const readers = {};
  if (!blank(body.itemId)) {
    const item = await loadMaster(db, companyId, Number(body.itemId));
    if (!item || item.record_kind !== 'item') throw invalid('INVALID', 'That piece does not exist.');
    const ir = await resolve(db, companyId, { master: item });
    readers.item = valueReaders(effectiveByCode(ir), levelsOfResolution(ir));
  }
  if (!blank(body.machineId)) {
    const machine = await requireMachine(db, companyId, Number(body.machineId));
    readers.machine = valueReaders(effectiveByCode(await resolve(db, companyId, { machine })));
  }
  return checkFormula(db, companyId, body.expression, body.sample ?? null, readers);
}
