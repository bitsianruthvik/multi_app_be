/**
 * valueReasonService.js — WHY a record asks for each of its values.
 *
 *   GET /records/:id/value-reasons
 *   -> { record: { id, code, name, kind },
 *        flow: { id, code, name } | null,          the flow the record is made by
 *        frozen: { reason, orderCode, lineNo } | null,
 *        values: [{ code, name, required, valueRule, reason }],
 *        notAsked: [{ code, name, display }] }
 *
 * "This is super important to maintain smallest set of specs for easy filling" (user, 2026-10-10).
 * A value is on a record's list for one of three reasons, and the screen says which:
 *
 *   flow     its flow reads it — a time formula of an operation in the record's flow names item.X, so
 *            flowSpecService put a required rule ON THE RECORD (origin 'flow'). The reason names the
 *            flow and the operations that read it. Such a rule looks after itself: it goes when
 *            nothing reads it any more.
 *   manual   somebody set an 'entered' rule by hand, at the level named (`at`). `readBy` is the
 *            operations of the record's flow that ALSO read it; an empty list is the signal the
 *            question exists for — a hand-made value nothing in its flow reads.
 *   derived  the value comes by itself (calculated, roll-up, inherited, fixed, defaulted): nobody
 *            has to fill it. `readBy` says what reads it, the same way.
 *
 * `notAsked` is what the record still HOLDS but no rule asks for any more (a retired flow value keeps
 * the number typed for it — flowSpecService). `frozen`: a row of a frozen or released line keeps the
 * list it had at freeze, so a flow-made value there may name no operation of today's flow.
 *
 * Which flow is a record's — flowSpecService's rule: a definition's or catalog item's default flow;
 * an order row's = the flow its BOM line names, else its own.
 *
 * Nothing is written and resolve() is not touched: the record's own flow-made rules are read beside
 * it (the Values tab's mirror of resolve() is compared with it field by field). A fixed number of
 * queries whatever the number of values — resolve()'s own, plus at most five here.
 */
import { requireMaster, kindOf } from './records.js';
import { resolve, publicResolution, rawOf, displayOf, parseJsonCol } from './resolutionService.js';
import { parseFormula } from './formulaEngine.js';

const DERIVED = new Set(['calculated', 'rollup', 'inherited', 'fixed', 'defaulted']);

/** The flow a record is made by (see the header), with its code and name. */
async function flowOfRecord(db, companyId, m) {
  if (m.record_kind === 'definition' && m.definition_type === 'selection') return null;
  let flowId = m.default_flow_id ?? null;
  if (m.record_kind === 'item' && m.item_type === 'temporary') {
    const [[line]] = await db.query(
      `SELECT bl.operation_flow_id FROM cf_bom_lines bl
        WHERE bl.company_id = ? AND bl.child_id = ? AND bl.deleted_at IS NULL AND bl.operation_flow_id IS NOT NULL
        ORDER BY bl.id LIMIT 1`,
      [companyId, m.id],
    );
    flowId = line?.operation_flow_id ?? flowId;
  }
  if (flowId == null) return null;
  const [[f]] = await db.query('SELECT id, code, name FROM cf_operation_flows WHERE company_id = ? AND id = ?', [companyId, flowId]);
  return f ? { id: Number(f.id), code: f.code, name: f.name } : null;
}

/**
 * code -> the operations of a flow whose time formulas read item.<code>, in step order, each once.
 * The same reading as flowSpecService.neededCodesOfFlows, keeping the operation.
 */
export async function readersOfFlow(db, companyId, flowId) {
  const out = new Map();
  if (flowId == null) return out;
  const [rows] = await db.query(
    `SELECT st.sequence, o.id AS op_id, o.code AS op_code, o.name AS op_name,
            r.work_expression, r.setup_expression, wf.expression AS wexpr, sf.expression AS sexpr
       FROM cf_operation_flow_steps st
       JOIN cf_operations o ON o.id = st.operation_id
       JOIN cf_operation_machine_rules r ON r.company_id = st.company_id AND r.operation_id = st.operation_id AND r.deleted_at IS NULL AND r.eligible = 1
       LEFT JOIN cf_formulas wf ON wf.id = r.work_formula_id AND wf.deleted_at IS NULL
       LEFT JOIN cf_formulas sf ON sf.id = r.setup_formula_id AND sf.deleted_at IS NULL
      WHERE st.company_id = ? AND st.flow_id = ? AND st.deleted_at IS NULL
      ORDER BY st.sequence, st.id, r.id`,
    [companyId, flowId],
  );
  const seen = new Set();
  for (const r of rows) {
    for (const text of [r.work_expression ?? r.wexpr, r.setup_expression ?? r.sexpr]) {
      if (text == null || String(text).trim() === '') continue;
      let p;
      try { p = parseFormula(String(text)); } catch { continue; }      // a broken formula reads nothing
      const codes = [...p.itemRefs, ...p.lookupRefs.filter((l) => l.role === 'item').map((l) => l.code)];
      for (const code of codes) {
        const key = `${code}:${r.op_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!out.has(code)) out.set(code, []);
        out.get(code).push({ id: Number(r.op_id), code: r.op_code, name: r.op_name });
      }
    }
  }
  return out;
}

/** What the record holds for values no rule asks for, as text. One query. */
async function notAskedOf(db, companyId, m, unassigned) {
  if (!unassigned.length) return [];
  const [rows] = await db.query(
    `SELECT v.*, s.code AS spec_code, s.name AS spec_name, s.data_type, s.decimals, s.default_uom, s.table_config,
            o.value AS option_value, o.label AS option_label
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
       LEFT JOIN cf_spec_options o ON o.id = v.option_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL`,
    [companyId, m.id],
  );
  const byCode = new Map(rows.map((r) => [String(r.spec_code).toUpperCase(), r]));
  const out = [];
  for (const u of unassigned) {
    const row = byCode.get(String(u.code).toUpperCase());
    let display = u.raw == null ? null : String(u.raw);
    if (row) {
      const spec = { dataType: row.data_type, decimals: row.decimals, unit: row.default_uom, tableConfig: row.data_type === 'table' ? parseJsonCol(row.table_config) : null };
      const raw = rawOf(row, row.data_type);
      const options = new Map(row.option_id != null ? [[row.option_id, { value: row.option_value, label: row.option_label }]] : []);
      try { display = displayOf(raw, spec, options); } catch { /* the raw text stands */ }
    }
    if (display == null || display === '') continue;       // an empty row holds nothing worth naming
    out.push({ code: u.code, name: u.name, display });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function getValueReasons(db, companyId, id) {
  const m = await requireMaster(db, companyId, id);
  const r = publicResolution(await resolve(db, companyId, { master: m }));
  const flow = await flowOfRecord(db, companyId, m);
  const readers = await readersOfFlow(db, companyId, flow?.id ?? null);
  // The record's OWN flow-made rules — the origin resolve() does not carry.
  const [own] = await db.query(
    `SELECT a.id FROM cf_spec_assignments a
      WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id = ? AND a.origin = 'flow' AND a.deleted_at IS NULL`,
    [companyId, m.id],
  );
  const flowMade = new Set(own.map((a) => Number(a.id)));

  const values = [];
  for (const s of r.specs) {
    if (!s.applicable || s.captureAt !== 'item') continue;
    const code = String(s.spec.code).toUpperCase();
    const readBy = readers.get(code) ?? [];
    const at = { level: s.definedAt.level, code: s.definedAt.code ?? null, name: s.definedAt.name ?? null };
    let reason;
    if (flowMade.has(Number(s.rule.assignmentId))) reason = { kind: 'flow', flow, operations: readBy };
    else if (DERIVED.has(s.rule.valueRule)) {
      reason = { kind: 'derived', how: s.rule.valueRule, at, readBy };
      if (s.rule.workedOut) reason.note = s.rule.workedOut;
      else if (s.rule.formula?.code) reason.formula = { code: s.rule.formula.code, name: s.rule.formula.name };
    } else reason = { kind: 'manual', at, readBy };
    values.push({ code: s.spec.code, name: s.spec.name, required: !!s.rule.isRequired, valueRule: s.rule.valueRule, hasValue: s.value != null, reason });
  }

  return {
    record: { id: m.id, code: m.code, name: m.name, kind: kindOf(m) },
    flow,
    frozen: r.frozen ? { reason: r.frozen.reason, orderCode: r.frozen.orderCode ?? null, lineNo: r.frozen.lineNo ?? null } : null,
    values,
    notAsked: await notAskedOf(db, companyId, m, r.unassignedValues ?? []),
  };
}
