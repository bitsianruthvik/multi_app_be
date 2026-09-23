/**
 * resolutionService.js — which specifications apply to a thing, under which
 * rule, and what value each one has, with where that value came from.
 *
 * The chain (decision Q4), broadest first:
 *   Family -> Subfamily -> Variant -> [its Template Definition] -> the record
 * The Template Definition link only exists for temporary items; it is how "a
 * Template Definition says what specifications must be captured" reaches every
 * item created from it without copying rules.
 *
 * Merging: the most specific rule for a (specification, capture level) pair
 * wins, whole — its rule, required flag, formula and option list. A rule with
 * is_applicable = 0 switches the spec off from that level down (Q9). Keyed by
 * capture level because the same spec can be calculated at item level and
 * entered at individual level (Q16).
 *
 * Values (Q8) — a value may sit at any level; for a record:
 *   entered     its own value
 *   defaulted   its own entered value, else the nearest value above
 *   fixed       the nearest value above; its own entry cannot override
 *   calculated  the formula over its other values, evaluated here
 *   rollup      the formula over its BOM children — Σ line quantity × child
 *               value — evaluated with the calculated ones, so either can feed
 *               the other; no BOM (or an empty one) is "no BOM", never zero
 *   inherited   its BOM parent's value (Q7). Only a temporary item has exactly
 *               one BOM parent; a catalog item sits in many BOMs, and the item
 *               a sales order line sells sits in none — both read "no parent"
 *
 * Two modes. "item" resolves a real item: values are the item's, required
 * specs without a value are reported missing. "setup" resolves a
 * classification node or a definition, whose values are defaults for the
 * items below — nothing there is ever "missing".
 *
 * An item of a closed, lost or cancelled order is frozen: it shows the values
 * it holds (status "frozen"), and nothing is worked out again — not formulas,
 * roll-ups or inherited values — so a later setup change cannot alter what was
 * delivered. `frozen` on the result names the order.
 */
import { ancestors, levelName } from './tree.js';
import { loadMaster, frozenBy } from './records.js';
import { parseFormula, evaluateFormula } from './formulaEngine.js';
import { placementOf, rollupChildren, storedValues } from './bomGraph.js';

export const CAPTURE_DEPTH = { item: 0, batch: 1, individual: 2 };
export const TRACK_DEPTH = { quantity: 0, batch: 1, individual: 2 };

const pad = (n) => String(n).padStart(2, '0');
export function dateText(d) {
  if (!d) return null;
  if (d instanceof Date) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return String(d).slice(0, 10);
}

/** The subjects whose rules reach a master record, broadest first. A draft (no id) has no own level. */
export async function chainForMaster(db, companyId, master) {
  const nodes = await ancestors(db, companyId, master.classification_id);
  const chain = nodes.map((n) => ({
    subjectType: 'classification', subjectId: n.id, level: levelName(n.depth), code: n.code, name: n.name, self: false,
  }));
  if (master.record_kind === 'item' && master.item_type === 'temporary' && master.source_definition_id) {
    const def = await loadMaster(db, companyId, master.source_definition_id);
    if (def) {
      chain.push({ subjectType: 'master', subjectId: def.id, level: 'Template definition', code: def.code, name: def.name, self: false });
    }
  }
  if (master.id != null) {
    chain.push({
      subjectType: 'master', subjectId: master.id,
      level: master.record_kind === 'item' ? 'This item' : 'This definition',
      code: master.code, name: master.name, self: true,
    });
  }
  return chain;
}

/** A machine's chain: its machine type's branch of the tree, then the machine itself. */
export async function chainForMachine(db, companyId, machine) {
  const nodes = await ancestors(db, companyId, machine.classification_id);
  return [
    ...nodes.map((n) => ({ subjectType: 'classification', subjectId: n.id, level: levelName(n.depth), code: n.code, name: n.name, self: false })),
    { subjectType: 'machine', subjectId: machine.id, level: 'This machine', code: machine.code, name: machine.name, self: true },
  ];
}

export async function chainForNode(db, companyId, nodeId) {
  const nodes = await ancestors(db, companyId, nodeId);
  return nodes.map((n, i) => ({
    subjectType: 'classification', subjectId: n.id, level: levelName(n.depth), code: n.code, name: n.name,
    self: i === nodes.length - 1,
  }));
}

function subjectFilter(chain, alias) {
  return {
    sql: chain.map(() => `(${alias}.subject_type = ? AND ${alias}.subject_id = ?)`).join(' OR '),
    params: chain.flatMap((s) => [s.subjectType, s.subjectId]),
  };
}

async function loadRules(db, companyId, chain) {
  if (!chain.length) return [];
  const f = subjectFilter(chain, 'a');
  const [rows] = await db.query(
    `SELECT a.id, a.specification_id, a.subject_type, a.subject_id, a.capture_at, a.is_required, a.is_applicable,
            a.value_rule, a.formula_id, a.sort_order,
            s.code AS spec_code, s.name AS spec_name, s.data_type, s.default_uom, s.decimals,
            f.code AS formula_code, f.name AS formula_name, f.expression AS formula_expression, f.version AS formula_version
       FROM cf_spec_assignments a
       JOIN cf_specifications s ON s.id = a.specification_id AND s.deleted_at IS NULL
       LEFT JOIN cf_formulas f  ON f.id = a.formula_id AND f.deleted_at IS NULL
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND (${f.sql})`,
    [companyId, ...f.params],
  );
  return rows;
}

async function loadValues(db, companyId, chain) {
  if (!chain.length) return [];
  const f = subjectFilter(chain, 'v');
  const [rows] = await db.query(
    `SELECT v.*, s.code AS spec_code, s.name AS spec_name, s.data_type, s.decimals
       FROM cf_spec_values v
       JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
      WHERE v.company_id = ? AND v.deleted_at IS NULL AND (${f.sql})`,
    [companyId, ...f.params],
  );
  return rows;
}

async function loadOptions(db, companyId, specIds, assignmentIds) {
  const options = specIds.length
    ? (await db.query(
      `SELECT id, specification_id, value, label, status, sort_order FROM cf_spec_options
        WHERE company_id = ? AND specification_id IN (?) AND deleted_at IS NULL ORDER BY sort_order, value`,
      [companyId, specIds]))[0]
    : [];
  const narrowed = assignmentIds.length
    ? (await db.query(
      `SELECT assignment_id, option_id FROM cf_spec_assignment_options
        WHERE company_id = ? AND assignment_id IN (?) AND deleted_at IS NULL`,
      [companyId, assignmentIds]))[0]
    : [];
  return { options, narrowed };
}

/** The raw value of a value row, as its data type. Options resolve to the option id. */
export function rawOf(row, dataType) {
  if (!row) return null;
  switch (dataType) {
    case 'number': return row.value_number == null ? null : Number(row.value_number);
    case 'text': return row.value_text ?? null;
    case 'boolean': return row.value_bool == null ? null : !!row.value_bool;
    case 'date': return dateText(row.value_date);
    case 'option': return row.option_id ?? null;
    default: return null;
  }
}

export function displayOf(raw, spec, optionById) {
  if (raw === null || raw === undefined) return null;
  switch (spec.dataType) {
    case 'number': {
      const d = spec.decimals;
      const text = d == null ? String(Number(raw.toFixed(6))) : raw.toFixed(d);
      return spec.unit ? `${text} ${spec.unit}` : text;
    }
    case 'boolean': return raw ? 'Yes' : 'No';
    case 'option': {
      const o = optionById.get(raw);
      return o ? (o.label || o.value) : `#${raw}`;
    }
    default: return String(raw);
  }
}

/**
 * Resolves a master record (saved, or a draft with `draftValues`) or a
 * classification node. Returns the public shape plus `internal` (the rows
 * materialisation needs) — callers that answer HTTP send publicResolution().
 *
 * draftValues: Map(specId -> value-row-like object) standing in for the
 * record's own values when it has not been saved yet.
 *
 * A machine resolves like an item (its own values, required ones reported
 * missing) along its machine type's branch; it has no batches, units or BOM.
 */
export async function resolve(db, companyId, { master = null, machine = null, nodeId = null, draftValues = null } = {}) {
  const isMachine = !!machine;
  const chain = isMachine ? await chainForMachine(db, companyId, machine)
    : master ? await chainForMaster(db, companyId, master) : await chainForNode(db, companyId, nodeId);
  const mode = isMachine || (master && master.record_kind === 'item') ? 'item' : 'setup';
  const levelOf = new Map(chain.map((s, i) => [`${s.subjectType}:${s.subjectId}`, i]));
  const selfIndex = chain.findIndex((s) => s.self);
  const aboveTop = selfIndex >= 0 ? selfIndex - 1 : chain.length - 1;

  const rules = (await loadRules(db, companyId, chain))
    .map((r) => ({ ...r, levelIndex: levelOf.get(`${r.subject_type}:${r.subject_id}`) }))
    .sort((a, b) => a.levelIndex - b.levelIndex || a.sort_order - b.sort_order || a.id - b.id);

  const merged = new Map();
  for (const r of rules) {
    const key = `${r.specification_id}:${r.capture_at}`;
    const prev = merged.get(key);
    merged.set(key, { rule: r, overridden: prev ? [...prev.overridden, prev.rule] : [] });
  }

  const specIds = [...new Set(rules.map((r) => r.specification_id))];
  const winning = [...merged.values()].map((m) => m.rule);
  const { options, narrowed } = await loadOptions(db, companyId, specIds, winning.map((r) => r.id));
  const optionById = new Map(options.map((o) => [o.id, o]));

  const values = await loadValues(db, companyId, chain);
  const valueAt = new Map(values.map((v) => [`${levelOf.get(`${v.subject_type}:${v.subject_id}`)}:${v.specification_id}`, v]));
  const ownRow = (specId) => (draftValues ? draftValues.get(specId) ?? null : (selfIndex >= 0 ? valueAt.get(`${selfIndex}:${specId}`) ?? null : null));
  const aboveRow = (specId) => {
    for (let i = aboveTop; i >= 0; i--) {
      const v = valueAt.get(`${i}:${specId}`);
      if (v) return { row: v, levelIndex: i };
    }
    return null;
  };
  const trackDepth = mode !== 'item' ? Infinity : isMachine ? 0 : TRACK_DEPTH[master.tracked_by ?? 'quantity'];
  // A closed, lost or cancelled order's item shows the values it holds, as they
  // were when the order locked — nothing is worked out again (decided 2026-09-22).
  const frozen = master ? frozenBy(master) : null;

  // Inherited values come from the BOM parent (Q7). Only looked up when a rule needs it.
  const inheritedSpecIds = mode === 'item' && !frozen && !isMachine
    ? winning.filter((r) => r.is_applicable && r.capture_at === 'item' && r.value_rule === 'inherited').map((r) => r.specification_id)
    : [];
  let parentPlace = null;
  let parentRows = new Map();
  if (inheritedSpecIds.length && master.id != null && master.item_type === 'temporary') {
    parentPlace = await placementOf(db, companyId, master.id);
    if (parentPlace) parentRows = await storedValues(db, companyId, parentPlace.parent_id, inheritedSpecIds);
  }

  const specs = [];
  const effectiveRows = new Map();
  for (const { rule: r, overridden } of merged.values()) {
    const spec = { id: r.specification_id, code: r.spec_code, name: r.spec_name, dataType: r.data_type, unit: r.default_uom, decimals: r.decimals };
    let allowed;
    if (r.data_type === 'option') {
      const narrowIds = new Set(narrowed.filter((n) => n.assignment_id === r.id).map((n) => n.option_id));
      allowed = options
        .filter((o) => o.specification_id === r.specification_id && o.status === 'active' && (!narrowIds.size || narrowIds.has(o.id)))
        .map((o) => ({ id: o.id, value: o.value, label: o.label }));
    }
    const entry = {
      spec,
      captureAt: r.capture_at,
      applicable: !!r.is_applicable,
      capturable: CAPTURE_DEPTH[r.capture_at] <= trackDepth,
      rule: {
        assignmentId: r.id,
        valueRule: r.value_rule,
        isRequired: !!r.is_required,
        formula: r.formula_id ? { id: r.formula_id, code: r.formula_code, name: r.formula_name, expression: r.formula_expression, version: r.formula_version } : null,
        sortOrder: r.sort_order,
      },
      definedAt: { level: chain[r.levelIndex].level, subjectType: r.subject_type, subjectId: r.subject_id, code: chain[r.levelIndex].code, name: chain[r.levelIndex].name },
      overrides: overridden.map((o) => ({ level: chain[o.levelIndex].level, valueRule: o.value_rule, applicable: !!o.is_applicable })),
      options: allowed,
      value: null,
      status: 'empty',
    };
    specs.push(entry);

    if (!entry.applicable) { entry.status = 'switched_off'; continue; }
    if (r.capture_at !== 'item') { entry.status = entry.capturable ? 'captured_later' : 'not_capturable'; continue; }

    const own = ownRow(spec.id);
    const above = aboveRow(spec.id);
    const view = (row, source, from) => {
      const raw = rawOf(row, spec.dataType);
      if (raw === null) return null;
      const v = { raw, display: displayOf(raw, spec, optionById), source, from };
      // Codes want the stored option value (E250), not its display label.
      if (spec.dataType === 'option') v.optionValue = optionById.get(raw)?.value ?? null;
      return v;
    };

    if (frozen) {
      if (own) entry.value = view(own, own.source, 'here');
      entry.status = 'frozen';
      continue;
    }

    if (mode === 'setup') {
      if (['calculated', 'rollup', 'inherited'].includes(r.value_rule)) { entry.status = 'computed_on_items'; continue; }
      if (own) { entry.value = view(own, own.source, 'here'); entry.status = 'set_here'; effectiveRows.set(spec.id, own); }
      else if (above) { entry.value = view(above.row, above.row.source, chain[above.levelIndex].level); entry.status = 'default_from_above'; }
      continue;
    }

    switch (r.value_rule) {
      case 'entered':
        if (own) { entry.value = view(own, own.source, 'here'); entry.status = 'set'; effectiveRows.set(spec.id, own); }
        break;
      case 'defaulted':
        if (own && own.source === 'entered') { entry.value = view(own, 'entered', 'here'); entry.status = 'set'; effectiveRows.set(spec.id, own); }
        else if (above) { entry.value = view(above.row, 'defaulted', chain[above.levelIndex].level); entry.status = 'default'; effectiveRows.set(spec.id, above.row); }
        break;
      case 'fixed':
        if (above) {
          entry.value = view(above.row, 'fixed', chain[above.levelIndex].level);
          entry.status = 'fixed';
          effectiveRows.set(spec.id, above.row);
          if (own && own.source === 'entered' && rawOf(own, spec.dataType) !== entry.value.raw) entry.conflict = 'An entered value here is overridden by the fixed value.';
        } else {
          entry.status = 'no_fixed_value';
          entry.problem = `The rule says fixed, but no value is set at ${entry.definedAt.level.toLowerCase()} level or above.`;
        }
        break;
      case 'inherited': {
        if (isMachine) { entry.status = 'no_parent'; entry.note = 'A machine has no BOM parent.'; break; }
        if (master.item_type !== 'temporary' || master.id == null) {
          entry.status = 'no_parent';
          entry.note = 'A catalog item sits in many BOMs, so it has no single parent to inherit from.';
          break;
        }
        if (!parentPlace) {
          entry.status = 'no_parent';
          entry.note = 'This is the item a sales order line sells — it has no BOM parent.';
          break;
        }
        const parentLabel = parentPlace.parent_code ?? parentPlace.parent_name;
        const row = parentRows.get(spec.id);
        if (!row) { entry.status = 'waiting_parent'; entry.missingInputs = [`${parentLabel} · ${spec.code}`]; break; }
        entry.value = view(row, 'inherited', `parent ${parentLabel}`);
        entry.status = 'inherited';
        effectiveRows.set(spec.id, row);
        if (allowed && row.option_id != null && !allowed.some((o) => o.id === row.option_id)) {
          entry.problem = `${entry.value?.display} from the parent is not allowed here.`;
        }
        break;
      }
      default:
        break; // calculated and rollup: second pass
    }
    if (entry.rule.isRequired && !entry.value && ['entered', 'defaulted'].includes(r.value_rule)) entry.status = 'missing';
  }

  // Calculated and roll-up values, in dependency order. A formula waits while
  // one of its own inputs is itself a formula value not yet worked out; whatever
  // is still waiting when nothing moves is a cycle. Roll-ups read the BOM
  // children's stored values — other records, so they never wait inside here.
  if (mode === 'item' && !frozen) {
    const lookup = new Map();
    for (const s of specs) if (s.value && s.spec.dataType === 'number') lookup.set(s.spec.code, s.value.raw);
    const calc = specs.filter((s) => s.applicable && s.captureAt === 'item' && ['calculated', 'rollup'].includes(s.rule.valueRule));
    const parsedOf = new Map();
    for (const s of calc) {
      if (!s.rule.formula) continue;
      try { parsedOf.set(s, parseFormula(s.rule.formula.expression)); } catch (e) { parsedOf.set(s, e); }
    }
    let children = null;
    const rollupTerms = new Set();
    for (const [s, p] of parsedOf) if (s.rule.valueRule === 'rollup' && !(p instanceof Error)) p.rollupTerms.forEach((t) => rollupTerms.add(t));
    if (!isMachine && master.id != null && calc.some((s) => s.rule.valueRule === 'rollup')) {
      children = await rollupChildren(db, companyId, master.id, [...rollupTerms]);
    }
    const done = new Set();
    let moved = true;
    while (moved) {
      moved = false;
      for (const s of calc) {
        if (done.has(s)) continue;
        const isRollup = s.rule.valueRule === 'rollup';
        if (!s.rule.formula) { s.status = 'formula_missing'; done.add(s); moved = true; continue; }
        const parsed = parsedOf.get(s);
        if (parsed instanceof Error) { s.status = 'formula_error'; s.problem = parsed.message; done.add(s); moved = true; continue; }
        if (isRollup && (!children || !children.length)) {
          s.status = 'no_bom';
          s.note = isMachine ? 'A machine has no BOM.' : children ? 'Its BOM has no lines yet.' : 'It has no BOM to roll up.';
          done.add(s); moved = true; continue;
        }
        const waiting = parsed.references.some((code) => !lookup.has(code) && calc.some((o) => o.spec.code === code && !done.has(o)));
        if (waiting) continue;
        const out = evaluateFormula(parsed, (code) => (lookup.has(code) ? lookup.get(code) : null), isRollup ? children : null);
        done.add(s);
        moved = true;
        if (out.value === null) {
          s.status = out.missing ? 'waiting_inputs' : 'formula_error';
          if (out.missing) s.missingInputs = out.missing;
          if (out.error) s.problem = out.error;
        } else {
          s.value = {
            raw: out.value,
            display: displayOf(out.value, s.spec, optionById),
            source: isRollup ? 'rollup' : 'calculated',
            from: isRollup ? `BOM · ${children.length} line${children.length === 1 ? '' : 's'}` : `formula ${s.rule.formula.code}`,
          };
          s.status = isRollup ? 'rollup' : 'calculated';
          lookup.set(s.spec.code, out.value);
          effectiveRows.set(s.spec.id, { value_number: out.value, value_text: null, value_bool: null, value_date: null, option_id: null });
        }
      }
    }
    for (const s of calc) {
      if (!done.has(s)) { s.status = 'formula_cycle'; s.problem = 'This formula depends on itself through other calculated values.'; }
    }
  }

  specs.sort((a, b) => CAPTURE_DEPTH[a.captureAt] - CAPTURE_DEPTH[b.captureAt]
    || a.rule.sortOrder - b.rule.sortOrder || a.spec.code.localeCompare(b.spec.code));

  const resolvedItemSpecs = new Set(specs.filter((s) => s.applicable && s.captureAt === 'item').map((s) => s.spec.id));
  const ownRows = new Map();
  if (!draftValues && selfIndex >= 0) {
    for (const v of values) if (levelOf.get(`${v.subject_type}:${v.subject_id}`) === selfIndex) ownRows.set(v.specification_id, v);
  }
  const unassigned = [...ownRows.values()]
    .filter((v) => !resolvedItemSpecs.has(v.specification_id))
    .map((v) => ({ code: v.spec_code, name: v.spec_name, source: v.source, raw: rawOf(v, v.data_type) }));

  return {
    mode,
    chain: chain.map(({ subjectType, subjectId, level, code, name, self }) => ({ subjectType, subjectId, level, code, name, self })),
    specs,
    missingRequired: specs.filter((s) => s.status === 'missing').map((s) => ({ code: s.spec.code, name: s.spec.name })),
    problems: specs.filter((s) => s.problem).map((s) => `${s.spec.code}: ${s.problem}`),
    unassignedValues: unassigned,
    frozen,
    internal: { ownRows, effectiveRows },
  };
}

export function publicResolution(r) {
  const { internal, ...rest } = r;
  return rest;
}

/** Effective value of a spec by code, as the code generator and matching want it. */
export function effectiveByCode(r) {
  const out = new Map();
  for (const s of r.specs) {
    if (!s.value || s.captureAt !== 'item') continue;
    out.set(s.spec.code, { raw: s.value.raw, dataType: s.spec.dataType, optionValue: s.value.optionValue ?? null, display: s.value.display });
  }
  return out;
}

/**
 * The batch-level specifications of an item — what each delivery lot must
 * record, like HEAT_NO — with one batch's values, or those of a batch being
 * received (draftValues: Map specId -> value row). Batch rules are entered or
 * calculated (assignmentService refuses the rest); a calculated one reads the
 * batch's own values first, then the item's. Same shape as resolve().
 */
export async function resolveBatch(db, companyId, { item, batchId = null, draftValues = null }) {
  const chain = await chainForMaster(db, companyId, item);
  const levelOf = new Map(chain.map((s, i) => [`${s.subjectType}:${s.subjectId}`, i]));
  const rules = (await loadRules(db, companyId, chain))
    .map((r) => ({ ...r, levelIndex: levelOf.get(`${r.subject_type}:${r.subject_id}`) }))
    .sort((a, b) => a.levelIndex - b.levelIndex || a.sort_order - b.sort_order || a.id - b.id);
  const merged = new Map();
  for (const r of rules) {
    if (r.capture_at !== 'batch') continue;
    const prev = merged.get(r.specification_id);
    merged.set(r.specification_id, { rule: r, overridden: prev ? [...prev.overridden, prev.rule] : [] });
  }
  const winning = [...merged.values()].map((m) => m.rule);
  const { options, narrowed } = await loadOptions(db, companyId, winning.map((r) => r.specification_id), winning.map((r) => r.id));
  const optionById = new Map(options.map((o) => [o.id, o]));
  let own = draftValues ?? new Map();
  if (!draftValues && batchId) {
    const [rows] = await db.query(
      "SELECT * FROM cf_spec_values WHERE company_id = ? AND subject_type = 'batch' AND subject_id = ? AND deleted_at IS NULL",
      [companyId, batchId],
    );
    own = new Map(rows.map((v) => [v.specification_id, v]));
  }
  const lookup = new Map();
  for (const [code, v] of effectiveByCode(await resolve(db, companyId, { master: item }))) if (v.dataType === 'number') lookup.set(code, v.raw);

  const specs = [];
  const calc = [];
  for (const { rule: r, overridden } of merged.values()) {
    const spec = { id: r.specification_id, code: r.spec_code, name: r.spec_name, dataType: r.data_type, unit: r.default_uom, decimals: r.decimals };
    let allowed;
    if (r.data_type === 'option') {
      const narrowIds = new Set(narrowed.filter((n) => n.assignment_id === r.id).map((n) => n.option_id));
      allowed = options
        .filter((o) => o.specification_id === r.specification_id && o.status === 'active' && (!narrowIds.size || narrowIds.has(o.id)))
        .map((o) => ({ id: o.id, value: o.value, label: o.label }));
    }
    const entry = {
      spec,
      captureAt: 'batch',
      applicable: !!r.is_applicable,
      capturable: true,
      rule: {
        assignmentId: r.id, valueRule: r.value_rule, isRequired: !!r.is_required, sortOrder: r.sort_order,
        formula: r.formula_id ? { id: r.formula_id, code: r.formula_code, name: r.formula_name, expression: r.formula_expression, version: r.formula_version } : null,
      },
      definedAt: { level: chain[r.levelIndex].level, subjectType: r.subject_type, subjectId: r.subject_id, code: chain[r.levelIndex].code, name: chain[r.levelIndex].name },
      overrides: overridden.map((o) => ({ level: chain[o.levelIndex].level, valueRule: o.value_rule, applicable: !!o.is_applicable })),
      options: allowed,
      value: null,
      status: 'empty',
    };
    specs.push(entry);
    if (!entry.applicable) { entry.status = 'switched_off'; continue; }
    if (r.value_rule === 'calculated') { calc.push(entry); continue; }
    const row = own.get(spec.id);
    const raw = row ? rawOf(row, spec.dataType) : null;
    if (raw !== null) {
      entry.value = { raw, display: displayOf(raw, spec, optionById), source: 'entered', from: 'here' };
      if (spec.dataType === 'option') entry.value.optionValue = optionById.get(raw)?.value ?? null;
      entry.status = 'set';
      if (spec.dataType === 'number') lookup.set(spec.code, raw);
    } else if (entry.rule.isRequired) entry.status = 'missing';
  }
  const done = new Set();
  let moved = true;
  while (moved) {
    moved = false;
    for (const s of calc) {
      if (done.has(s)) continue;
      if (!s.rule.formula) { s.status = 'formula_missing'; done.add(s); moved = true; continue; }
      let parsed;
      try { parsed = parseFormula(s.rule.formula.expression); } catch (e) { s.status = 'formula_error'; s.problem = e.message; done.add(s); moved = true; continue; }
      if (parsed.references.some((code) => !lookup.has(code) && calc.some((o) => o.spec.code === code && !done.has(o)))) continue;
      const out = evaluateFormula(parsed, (code) => (lookup.has(code) ? lookup.get(code) : null));
      done.add(s);
      moved = true;
      if (out.value === null) {
        s.status = out.missing ? 'waiting_inputs' : 'formula_error';
        if (out.missing) s.missingInputs = out.missing;
        if (out.error) s.problem = out.error;
      } else {
        s.value = { raw: out.value, display: displayOf(out.value, s.spec, optionById), source: 'calculated', from: `formula ${s.rule.formula.code}` };
        s.status = 'calculated';
        lookup.set(s.spec.code, out.value);
      }
    }
  }
  for (const s of calc) if (!done.has(s)) { s.status = 'formula_cycle'; s.problem = 'This formula depends on itself through other calculated values.'; }
  specs.sort((a, b) => a.rule.sortOrder - b.rule.sortOrder || a.spec.code.localeCompare(b.spec.code));
  return {
    mode: 'batch',
    chain: [
      ...chain.map(({ subjectType, subjectId, level, code, name }) => ({ subjectType, subjectId, level, code, name, self: false })),
      { subjectType: 'batch', subjectId: batchId, level: 'This batch', code: null, name: '', self: true },
    ],
    specs,
    missingRequired: specs.filter((s) => s.status === 'missing').map((s) => ({ code: s.spec.code, name: s.spec.name })),
    problems: specs.filter((s) => s.problem).map((s) => `${s.spec.code}: ${s.problem}`),
    unassignedValues: [],
    frozen: null,
  };
}
