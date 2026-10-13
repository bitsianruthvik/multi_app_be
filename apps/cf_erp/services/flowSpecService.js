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
 * steps changing, an operation's formula changing and a chart's inputs changing all run it again for
 * the records concerned. A flow-made rule no longer needed is REMOVED — the smallest set to fill
 * (user, 2026-10-10: "values that are not required are retiring and values that are required are
 * coming up"); a value typed for it stays stored, it is only no longer asked for.
 *
 * Which flow is a record's (user, same day: "the temp item field list should be based on the flow
 * it is attached to … this list should get fixed once we freeze"):
 *   definition       its default flow — its rules are ITS OWN and do not reach the rows made from it
 *                    (resolutionService.loadRules drops an inherited flow-made rule)
 *   catalog item     its default flow
 *   temporary item   the flow its BOM line names, else its own (stamped when the row was made —
 *                    instantiationService). Every row carries its own flow's rules. A row of a FROZEN
 *                    (locked) or released line is left alone: its list is the one it had at freeze.
 * All set-based: a fixed number of queries whatever the number of records.
 *
 * HOW A FLOW-ASKED VALUE COMES (2026-10-12, "values from the drawing and from the parts"). The flow
 * says the record NEEDS the value; the classification may say HOW it is worked out:
 *
 *   a RECIPE   a rule ON A CLASSIFICATION NODE with origin 'flow', Defaulted, naming a formula. It
 *              reaches no record by itself (every resolver drops a flow-made rule that is not the
 *              record's own) — it only says: "a record under this node whose flow asks for this
 *              value gets it from this formula, and a person may type over it".
 *
 * So a record's own flow-made rule is written as the recipe says — Defaulted, that formula, required
 * — where there is one (nearest node up), and Entered, required where there is none. The same when
 * the chain holds an ordinary Defaulted rule with a formula that is not required: the record's own
 * rule repeats it, required. An existing flow-made rule is brought in line on the next sync (a typed
 * value stays exactly as typed — it now sits over the formula's answer); a frozen row is not touched.
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
async function flowsOf(db, companyId, ids, { includeLocked = false } = {}) {
  // A row of a frozen (locked) or released line is fixed — its rules are not touched.
  const [rows] = await db.query(
    `SELECT m.id, m.record_kind, m.default_flow_id, i.item_type, d.default_flow_id AS def_flow,
            (CASE WHEN ol.deleted_at IS NULL THEN ol.id END) AS line_id,
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
      if (Number(r.locked) && !includeLocked) continue;
      flow = r.line_flow ?? r.default_flow_id;
    } else flow = r.default_flow_id;
    out.set(Number(r.id), { flow: flow == null ? null : Number(flow), kind: r.record_kind, lineId: r.item_type === 'temporary' && r.line_id != null ? Number(r.line_id) : null });
  }
  return out;
}

/**
 * A record whose flow-made rule just became "worked out" (or stopped being): its values are worked
 * out again and stored, so what reads STORED values — a parent's roll-up, an operation's time — sees
 * the formula's answer. One pass per order line (orderValuesService.materializeLineRecords: a fixed
 * number of statements whatever the number of rows); a catalog item, which has no line, by itself.
 */
async function settleValues(db, c, flows, recordIds) {
  const byLine = new Map();
  const alone = [];
  for (const id of new Set(recordIds)) {
    const f = flows.get(id);
    if (!f || f.kind !== 'item') continue;
    if (f.lineId == null) { alone.push(id); continue; }
    if (!byLine.has(f.lineId)) byLine.set(f.lineId, []);
    byLine.get(f.lineId).push(id);
  }
  if (byLine.size) {
    const { materializeLineRecords } = await import('./orderValuesService.js');
    for (const [lineId, ids] of byLine) await materializeLineRecords(db, c, lineId, ids);
  }
  if (alone.length) {
    const { refreshValues } = await import('./valueService.js');
    await refreshValues(db, c, alone);
  }
}

/**
 * Bring records' flow-made rules in line with their flows. Returns
 * { added: [{ recordId, code }], removed: [...], kept: [{ recordId, code, why }], unknown: [code],
 *   changed: [{ recordId, code, to: 'worked out' | 'typed' }] — own flow-made rules brought in line with a recipe }.
 */
export async function syncFlowSpecs(db, c, recordIds, opts = {}) {
  const { companyId } = c;
  const ids = [...new Set(recordIds.map(Number).filter(Boolean))];
  const result = { added: [], removed: [], kept: [], changed: [], unknown: [] };
  if (!ids.length) return result;
  // opts.includeLocked: only for the one-time migration that gives every frozen row the list it has today.
  const flows = await flowsOf(db, companyId, ids, opts);
  const flowIds = [...new Set([...flows.values()].map((f) => f.flow).filter((f) => f != null))];
  const needOf = await neededCodesOfFlows(db, companyId, flowIds);

  // The record's own flow-made rules (to remove what is no longer needed).
  const [mine] = await db.query(
    `SELECT a.id, a.subject_id, s.id AS spec_id, UPPER(s.code) AS code, a.value_rule, a.formula_id FROM cf_spec_assignments a
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
    `SELECT a.id, a.subject_id, UPPER(s.code) AS code, a.value_rule, a.formula_id, a.is_required, a.is_applicable FROM cf_spec_assignments a
       JOIN cf_specifications s ON s.id = a.specification_id
      WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id IN (?) AND a.capture_at = 'item'
        AND a.origin = 'manual' AND a.deleted_at IS NULL AND s.code IN (?)`,
    [companyId, ids, [...specOf.keys()]],
  ) : [[]];
  const manualOf = new Map(ownManual.map((r) => [`${r.subject_id}:${r.code}`, r]));
  const makeRequired = [];

  // How a flow-asked value is worked out for this record, if anything says: the chain's own Defaulted
  // rule with a formula (the nearest wins, as in resolution), else the nearest recipe above. Null = typed.
  const howOf = (e) => {
    const b = e?.below ?? null;
    if (b && b.applicable && b.valueRule === 'defaulted' && b.formulaId != null) return b.formulaId;
    return e?.recipe?.formulaId ?? null;
  };
  const adds = [];
  const reshape = new Map();   // "rule|formula" -> ids of the record's own flow-made rules to bring in line
  for (const id of ids) {
    const f = flows.get(id);
    if (!f) continue;
    const need = f.flow != null ? needOf.get(f.flow) ?? new Set() : new Set();
    for (const code of need) {
      if (!specOf.has(code)) continue;
      const e = resolved.get(id)?.get(code);
      const how = howOf(e);
      const mineNow = ownFlowRule.get(`${id}:${code}`);
      if (mineNow) {
        // Its own flow-made rule is there: as the recipe says today, or typed where nothing says.
        const want = how != null ? 'defaulted' : 'entered';
        if (mineNow.value_rule !== want || (mineNow.formula_id == null ? null : Number(mineNow.formula_id)) !== how) {
          const k = `${want}|${how ?? ''}`;
          if (!reshape.has(k)) reshape.set(k, { valueRule: want, formulaId: how, ids: [] });
          reshape.get(k).ids.push(mineNow.id);
          result.changed.push({ recordId: id, code, to: how != null ? 'worked out' : 'typed' });
        }
        continue;
      }
      const manual = manualOf.get(`${id}:${code}`);
      if (manual) {
        const asked = manual.value_rule === 'entered' || (manual.value_rule === 'defaulted' && manual.formula_id != null);
        if (manual.is_applicable && asked && !manual.is_required) { makeRequired.push(manual.id); result.added.push({ recordId: id, code, madeRequired: true }); }
        continue;
      }
      const rule = e?.rule ?? null;
      const worked = !!rule && rule.valueRule === 'defaulted' && rule.formulaId != null;
      if (rule && rule.applicable && rule.valueRule !== 'entered' && !worked) continue;   // comes by itself
      if (rule && rule.applicable && rule.isRequired) continue;                           // already asked, required
      if (rule && !rule.applicable) { result.kept.push({ recordId: id, code, why: 'switched off on purpose above it' }); continue; }
      adds.push([companyId, specOf.get(code), 'master', id, 'item', 1, 1, how != null ? 'defaulted' : 'entered', how, 'flow', c.userId ?? null]);
      result.added.push({ recordId: id, code, ...(how != null ? { workedOut: true } : {}) });
    }
  }
  if (makeRequired.length) await db.query('UPDATE cf_spec_assignments SET is_required = 1 WHERE company_id = ? AND id IN (?)', [companyId, makeRequired]);
  if (adds.length) {
    await insertRows(db, 'cf_spec_assignments',
      ['company_id', 'specification_id', 'subject_type', 'subject_id', 'capture_at', 'is_required', 'is_applicable', 'value_rule', 'formula_id', 'origin', 'created_by'], adds);
  }
  // One UPDATE per shape (there are as many shapes as recipes — a handful), never one per record.
  for (const g of reshape.values()) {
    await db.query('UPDATE cf_spec_assignments SET value_rule = ?, formula_id = ? WHERE company_id = ? AND id IN (?)', [g.valueRule, g.formulaId, companyId, g.ids]);
  }

  // Flow-made rules no longer needed are removed; a value typed for one stays stored.
  const stale = mine.filter((r) => {
    const f = flows.get(Number(r.subject_id));
    if (!f) return false;
    const need = f.flow != null ? needOf.get(f.flow) ?? new Set() : new Set();
    return !need.has(r.code);
  });
  if (stale.length) {
    for (const r of stale) result.removed.push({ recordId: Number(r.subject_id), code: r.code });
    await db.query('UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, stale.map((r) => r.id)]);
  }
  // opts.settle === false: the caller works the values out itself right after (a template copy does).
  const reworked = [...result.added.filter((a) => a.workedOut).map((a) => a.recordId), ...result.changed.map((x) => x.recordId)];
  if (reworked.length && opts.settle !== false) await settleValues(db, c, flows, reworked);
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

/**
 * After the way a value is worked out changes on a classification or a definition (a recipe added,
 * repointed or removed; a Defaulted rule given or losing its formula): every record whose own
 * flow-made rule asks for that value takes the new way. One query to find them, then the usual sync.
 */
export async function syncRecordsAskedFor(db, c, specificationId) {
  const [rows] = await db.query(
    "SELECT DISTINCT subject_id FROM cf_spec_assignments WHERE company_id = ? AND subject_type = 'master' AND origin = 'flow' AND specification_id = ? AND deleted_at IS NULL",
    [c.companyId, specificationId],
  );
  return rows.length ? syncFlowSpecs(db, c, rows.map((r) => Number(r.subject_id))) : null;
}

export async function syncRecordsUsingFlows(db, c, flowIds) {
  return syncFlowSpecs(db, c, await recordsUsingFlows(db, c.companyId, flowIds.map(Number)));
}

/** After an operation's time formula changes: every record whose flow holds that operation. */
export async function syncRecordsUsingOperation(db, c, operationId) {
  // Catalog flows only: no record names a frozen order line's copy of a flow (init.sql §60), and a frozen row is not synced anyway.
  const [flows] = await db.query(
    `SELECT DISTINCT s.flow_id FROM cf_operation_flow_steps s JOIN cf_operation_flows f ON f.id = s.flow_id AND f.owner_order_line_id IS NULL
      WHERE s.company_id = ? AND s.operation_id = ? AND s.deleted_at IS NULL`, [c.companyId, operationId]);
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
