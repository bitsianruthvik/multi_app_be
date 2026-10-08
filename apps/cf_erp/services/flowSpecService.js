/**
 * flowSpecService.js — a record's flow decides which values it needs (init.sql §50, user 2026-10-08).
 *
 * "Not every part needs holes, piercings, hole transfers, metallising coats … while selecting a
 * default flow to an item, it should check if the item has all the required specifications or not —
 * if not it should add them to the item's specification rules." Decided: they are REQUIRED (option a).
 *
 * The rule: every operation's time formula says what it reads — `item.HOLES * 0.35` reads HOLES. So
 * the values a record needs are every item.X read by any rule of any operation in its flow (a LOOKUP's
 * key counts; the table a LOOKUP reads is the machine's, not the item's). A needed value the record's
 * chain does not already provide gets a rule ON THE RECORD: entered, required, origin 'flow'. Where the
 * chain gives it some other way (calculated weight, a defaulted or fixed value, a roll-up) nothing is
 * added — the value comes by itself. Where the chain has it entered but optional, the record's own
 * rule makes it required.
 *
 * Kept right afterwards (syncRecordsUsingFlows / syncRecordsUsingOperation): choosing a flow, a flow's
 * steps changing, and an operation's formula changing all run it again for the records concerned. A
 * flow-made rule no longer needed is removed only when nobody filled it in (the record, or for a
 * definition every item made from it) — a typed value is never lost.
 *
 * Which flow is a record's:
 *   definition       its default flow
 *   catalog item     its default flow
 *   temporary item   its OWN default flow, or the flow its BOM line names — only when it differs from
 *                    its definition's (the definition's rules already reach it). Frozen / released lines
 *                    are left alone.
 * All set-based: a fixed number of queries whatever the number of records.
 */
import { parseFormula } from './formulaEngine.js';
import { readMasters, resolveCodes } from '../lib/cutFrom.js';
import { insertRows } from '../lib/db.js';

/** item.X codes each flow's operations read, from every live rule's own expression or linked formula. */
export async function neededCodesOfFlows(db, companyId, flowIds) {
  const out = new Map(flowIds.map((f) => [Number(f), new Set()]));
  if (!flowIds.length) return out;
  const [rows] = await db.query(
    `SELECT st.flow_id, r.work_expression, r.setup_expression, wf.expression AS wexpr, sf.expression AS sexpr
       FROM cf_operation_flow_steps st
       JOIN cf_operation_machine_rules r ON r.company_id = st.company_id AND r.operation_id = st.operation_id AND r.deleted_at IS NULL AND r.eligible = 1
       LEFT JOIN cf_formulas wf ON wf.id = r.work_formula_id AND wf.deleted_at IS NULL
       LEFT JOIN cf_formulas sf ON sf.id = r.setup_formula_id AND sf.deleted_at IS NULL
      WHERE st.company_id = ? AND st.flow_id IN (?) AND st.deleted_at IS NULL`,
    [companyId, flowIds],
  );
  for (const r of rows) {
    for (const text of [r.work_expression ?? r.wexpr, r.setup_expression ?? r.sexpr]) {
      if (text == null || String(text).trim() === '') continue;
      let p;
      try { p = parseFormula(String(text)); } catch { continue; }      // a broken formula reads nothing
      const set = out.get(Number(r.flow_id));
      for (const code of p.itemRefs) set.add(code);
      for (const l of p.lookupRefs) if (l.role === 'item') set.add(l.code);
    }
  }
  return out;
}

/** The flow each record runs by (see the header), and whether it may be touched. */
async function flowsOf(db, companyId, ids) {
  // A row of a frozen (locked) or released line is fixed — its rules are not touched.
  const [rows] = await db.query(
    `SELECT m.id, m.record_kind, m.default_flow_id, i.item_type, d.default_flow_id AS def_flow,
            (SELECT bl.operation_flow_id FROM cf_bom_lines bl WHERE bl.company_id = m.company_id AND bl.child_id = m.id AND bl.deleted_at IS NULL AND bl.operation_flow_id IS NOT NULL ORDER BY bl.id LIMIT 1) AS line_flow,
            (ol.locked_at IS NOT NULL OR EXISTS (SELECT 1 FROM cf_production_releases r WHERE r.company_id = m.company_id AND r.order_line_id = ol.id AND r.deleted_at IS NULL)) AS locked
       FROM cf_master_records m
       LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_master_records d ON d.id = i.source_definition_id
       LEFT JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
      WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`,
    [companyId, ids],
  );
  const out = new Map();
  for (const r of rows) {
    let flow = null;
    if (r.record_kind === 'definition') flow = r.default_flow_id;
    else if (r.item_type === 'temporary') {
      if (Number(r.locked)) continue;
      const own = r.line_flow ?? r.default_flow_id;
      flow = own != null && Number(own) !== Number(r.def_flow ?? 0) ? own : null;
      if (flow == null) { out.set(Number(r.id), { flow: null, temporaryOnDefinition: true }); continue; }
    } else flow = r.default_flow_id;
    out.set(Number(r.id), { flow: flow == null ? null : Number(flow) });
  }
  return out;
}

/**
 * Bring records' flow-made rules in line with their flows. Returns
 * { added: [{ recordId, code }], removed: [...], kept: [{ recordId, code, why }], unknown: [code] }.
 */
export async function syncFlowSpecs(db, c, recordIds) {
  const { companyId } = c;
  const ids = [...new Set(recordIds.map(Number).filter(Boolean))];
  const result = { added: [], removed: [], kept: [], unknown: [] };
  if (!ids.length) return result;
  const flows = await flowsOf(db, companyId, ids);
  const flowIds = [...new Set([...flows.values()].map((f) => f.flow).filter((f) => f != null))];
  const needOf = await neededCodesOfFlows(db, companyId, flowIds);

  // The record's own flow-made rules (to remove what is no longer needed).
  const [mine] = await db.query(
    `SELECT a.id, a.subject_id, s.id AS spec_id, UPPER(s.code) AS code FROM cf_spec_assignments a
       JOIN cf_specifications s ON s.id = a.specification_id
      WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id IN (?) AND a.origin = 'flow' AND a.deleted_at IS NULL`,
    [companyId, ids],
  );
  const allCodes = new Set(mine.map((r) => r.code));
  for (const s of needOf.values()) for (const code of s) allCodes.add(code);
  const [specs] = allCodes.size ? await db.query('SELECT id, UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, [...allCodes]]) : [[]];
  const specOf = new Map(specs.map((s) => [s.code, Number(s.id)]));
  for (const code of allCodes) if (!specOf.has(code)) result.unknown.push(code);

  // What each record's chain already gives, WITHOUT its own flow-made rules (resolve, then discount them).
  const masters = await readMasters(db, companyId, ids);
  const resolved = specOf.size ? await resolveCodes(db, companyId, masters, [...specOf.keys()]) : new Map();
  const ownFlowRule = new Map(mine.map((r) => [`${r.subject_id}:${r.code}`, r]));
  // A rule the record already has of its own, made by hand (one live rule per record × spec × level):
  // never a second one beside it — an optional entered one is made required instead.
  const [ownManual] = specOf.size ? await db.query(
    `SELECT a.id, a.subject_id, UPPER(s.code) AS code, a.value_rule, a.is_required, a.is_applicable FROM cf_spec_assignments a
       JOIN cf_specifications s ON s.id = a.specification_id
      WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id IN (?) AND a.capture_at = 'item'
        AND a.origin = 'manual' AND a.deleted_at IS NULL AND s.code IN (?)`,
    [companyId, ids, [...specOf.keys()]],
  ) : [[]];
  const manualOf = new Map(ownManual.map((r) => [`${r.subject_id}:${r.code}`, r]));
  const makeRequired = [];

  const adds = [];
  for (const id of ids) {
    const f = flows.get(id);
    if (!f || f.temporaryOnDefinition) continue;
    const need = f.flow != null ? needOf.get(f.flow) ?? new Set() : new Set();
    for (const code of need) {
      if (!specOf.has(code) || ownFlowRule.has(`${id}:${code}`)) continue;
      const manual = manualOf.get(`${id}:${code}`);
      if (manual) {
        if (manual.is_applicable && manual.value_rule === 'entered' && !manual.is_required) { makeRequired.push(manual.id); result.added.push({ recordId: id, code, madeRequired: true }); }
        continue;
      }
      const e = resolved.get(id)?.get(code);
      const rule = e?.rule ?? null;
      if (rule && rule.applicable && rule.valueRule !== 'entered') continue;        // comes by itself
      if (rule && rule.applicable && rule.isRequired) continue;                      // already asked, required
      if (rule && !rule.applicable) { result.kept.push({ recordId: id, code, why: 'switched off on purpose above it' }); continue; }
      adds.push([companyId, specOf.get(code), 'master', id, 'item', 1, 1, 'entered', 'flow', c.userId ?? null]);
      result.added.push({ recordId: id, code });
    }
  }
  if (makeRequired.length) await db.query('UPDATE cf_spec_assignments SET is_required = 1 WHERE company_id = ? AND id IN (?)', [companyId, makeRequired]);
  if (adds.length) {
    await insertRows(db, 'cf_spec_assignments',
      ['company_id', 'specification_id', 'subject_type', 'subject_id', 'capture_at', 'is_required', 'is_applicable', 'value_rule', 'origin', 'created_by'], adds);
  }

  // Flow-made rules no longer needed: removed unless somebody filled them in.
  const stale = mine.filter((r) => {
    const f = flows.get(Number(r.subject_id));
    if (!f) return false;
    const need = f.flow != null ? needOf.get(f.flow) ?? new Set() : new Set();
    return !need.has(r.code);
  });
  if (stale.length) {
    const subjects = [...new Set(stale.map((r) => Number(r.subject_id)))];
    const [filled] = await db.query(
      `SELECT DISTINCT v.specification_id, COALESCE(i.source_definition_id, v.subject_id) AS owner, v.subject_id
         FROM cf_spec_values v
         LEFT JOIN cf_item_details i ON i.master_id = v.subject_id AND i.deleted_at IS NULL AND i.source_definition_id IN (?)
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL
          AND (v.subject_id IN (?) OR i.source_definition_id IN (?))
          AND (v.value_number IS NOT NULL OR v.value_text IS NOT NULL OR v.value_bool IS NOT NULL OR v.value_date IS NOT NULL OR v.option_id IS NOT NULL)`,
      [subjects, companyId, subjects, subjects],
    );
    const hasValue = new Set(filled.map((r) => `${r.owner}:${r.specification_id}`).concat(filled.map((r) => `${r.subject_id}:${r.specification_id}`)));
    const drop = [];
    for (const r of stale) {
      if (hasValue.has(`${r.subject_id}:${r.spec_id}`)) result.kept.push({ recordId: Number(r.subject_id), code: r.code, why: 'its flow no longer reads it, but it holds values' });
      else { drop.push(r.id); result.removed.push({ recordId: Number(r.subject_id), code: r.code }); }
    }
    if (drop.length) await db.query('UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, drop]);
  }
  return result;
}

/** Records whose flow is one of these: definitions and items by default flow, BOM line children by line flow. */
export async function recordsUsingFlows(db, companyId, flowIds) {
  if (!flowIds.length) return [];
  const [rows] = await db.query(
    `SELECT id FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND default_flow_id IN (?)
     UNION
     SELECT bl.child_id FROM cf_bom_lines bl WHERE bl.company_id = ? AND bl.deleted_at IS NULL AND bl.operation_flow_id IN (?)`,
    [companyId, flowIds, companyId, flowIds],
  );
  return rows.map((r) => Number(r.id));
}

export async function syncRecordsUsingFlows(db, c, flowIds) {
  return syncFlowSpecs(db, c, await recordsUsingFlows(db, c.companyId, flowIds.map(Number)));
}

/** After an operation's time formula changes: every record whose flow holds that operation. */
export async function syncRecordsUsingOperation(db, c, operationId) {
  const [flows] = await db.query('SELECT DISTINCT flow_id FROM cf_operation_flow_steps WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [c.companyId, operationId]);
  return syncRecordsUsingFlows(db, c, flows.map((f) => Number(f.flow_id)));
}

/** "Added the values its flow reads: Holes, Hole transfers" — for a toast, or null. */
export async function flowSpecWords(db, companyId, result, recordId) {
  const codes = [...new Set(result.added.filter((a) => a.recordId === Number(recordId)).map((a) => a.code))];
  if (!codes.length) return null;
  const [rows] = await db.query('SELECT UPPER(code) AS code, name FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)', [companyId, codes]);
  const name = new Map(rows.map((r) => [r.code, r.name]));
  return `Added the value${codes.length === 1 ? '' : 's'} its flow reads, as required: ${codes.map((c) => name.get(c) ?? c).join(', ')}.`;
}
