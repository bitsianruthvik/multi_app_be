/**
 * valueService.js — every write of a specification value goes through here.
 *
 * Three jobs:
 *   1. setValues   — a person types values. Each is checked against its spec's
 *                    type and, on an item, against its rule: a fixed or
 *                    calculated value cannot be typed in.
 *   2. materialize — the values a rule produces (fixed, defaulted, calculated,
 *                    rollup, inherited) are STORED on the item (decision Q18),
 *                    tagged with the rule that produced them, so matching and
 *                    reporting read one table. Re-run whenever an input changes.
 *   3. history     — every create / update / delete writes a history row in
 *                    the same transaction (Q19). TiDB has no triggers, so a
 *                    write that bypasses this service is a write nobody audited.
 *
 * Values on classification nodes and definitions are defaults for the items
 * below them. They are allowed for any specification, and take effect wherever
 * a Fixed or Defaulted rule reaches an item.
 *
 * BOMs make values travel between records: a roll-up reads the children, an
 * inherited value reads the parent. refreshValues follows both directions until
 * nothing changes any more.
 */
import { invalid } from '../lib/errors.js';
import { requireNode, subtreeIds } from './tree.js';
import { loadMaster, requireMaster, frozenBy, assertNotFrozen, loadMachine, requireMachine } from './records.js';
import { resolve, dateText } from './resolutionService.js';
import { parentsOf, tempChildrenOf } from './bomGraph.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY = { value_number: null, value_text: null, value_bool: null, value_date: null, option_id: null };

export async function loadSpecs(db, companyId, entries) {
  const ids = entries.map((e) => e.specificationId).filter((v) => v != null).map(Number);
  const codes = entries.map((e) => e.specCode).filter(Boolean).map((c) => String(c).toUpperCase());
  if (!ids.length && !codes.length) return { byId: new Map(), byCode: new Map() };
  const [rows] = await db.query(
    `SELECT id, code, name, data_type, default_uom, status FROM cf_specifications
      WHERE company_id = ? AND deleted_at IS NULL AND (id IN (?) OR code IN (?))`,
    [companyId, ids.length ? ids : [0], codes.length ? codes : ['']],
  );
  return { byId: new Map(rows.map((r) => [r.id, r])), byCode: new Map(rows.map((r) => [r.code.toUpperCase(), r])) };
}

async function loadSpecOptions(db, companyId, specId) {
  const [rows] = await db.query(
    'SELECT id, value, label, status FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL',
    [companyId, specId],
  );
  return rows;
}

/**
 * Turns an input value into typed columns for the spec's data type.
 * Returns { typed } (null typed = clear the value) or { problem }.
 */
export async function coerce(db, companyId, spec, input, allowedOptionIds = null) {
  if (input === null || input === undefined || input === '') return { typed: null };
  switch (spec.data_type) {
    case 'number': {
      const n = typeof input === 'number' ? input : Number(String(input).trim());
      if (!Number.isFinite(n)) return { problem: `${spec.code} needs a number.` };
      if (Math.abs(n) >= 1e18) return { problem: `${spec.code} is too large.` };
      return { typed: { ...EMPTY, value_number: Number(n.toFixed(6)) } };
    }
    case 'text': {
      const s = String(input).trim();
      if (s.length > 500) return { problem: `${spec.code} is longer than 500 characters.` };
      return { typed: s ? { ...EMPTY, value_text: s } : null };
    }
    case 'boolean': {
      const s = String(input).trim().toLowerCase();
      if ([true, 1, '1', 'true', 'yes', 'y'].includes(input) || ['true', 'yes', 'y', '1'].includes(s)) return { typed: { ...EMPTY, value_bool: 1 } };
      if ([false, 0, '0', 'false', 'no', 'n'].includes(input) || ['false', 'no', 'n', '0'].includes(s)) return { typed: { ...EMPTY, value_bool: 0 } };
      return { problem: `${spec.code} is yes or no.` };
    }
    case 'date': {
      const s = String(input).trim();
      const d = new Date(`${s}T00:00:00`);
      if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || dateText(d) !== s) return { problem: `${spec.code} needs a date as YYYY-MM-DD.` };
      return { typed: { ...EMPTY, value_date: s } };
    }
    case 'option': {
      const options = await loadSpecOptions(db, companyId, spec.id);
      const found = options.find((o) => o.id === Number(input))
        ?? options.find((o) => o.value.toLowerCase() === String(input).trim().toLowerCase());
      if (!found) return { problem: `"${input}" is not an option of ${spec.code}.` };
      if (found.status !== 'active') return { problem: `Option ${found.value} of ${spec.code} is retired.` };
      if (allowedOptionIds && allowedOptionIds.size && !allowedOptionIds.has(found.id)) {
        return { problem: `${found.value} is not allowed for ${spec.code} here.` };
      }
      return { typed: { ...EMPTY, option_id: found.id } };
    }
    default:
      return { problem: `${spec.code} has an unknown data type.` };
  }
}

function sameValue(row, typed) {
  const num = (x) => (x == null ? null : Number(x));
  const a = num(row.value_number);
  const b = num(typed.value_number);
  if ((a === null) !== (b === null) || (a !== null && Math.abs(a - b) > 1e-9)) return false;
  return (row.value_text ?? null) === (typed.value_text ?? null)
    && (row.value_bool == null ? null : Number(row.value_bool)) === (typed.value_bool == null ? null : Number(typed.value_bool))
    && dateText(row.value_date) === (typed.value_date ?? null)
    && (row.option_id ?? null) === (typed.option_id ?? null);
}

function snapshot(row, source, uom) {
  if (!row) return null;
  return {
    number: row.value_number == null ? null : Number(row.value_number),
    text: row.value_text ?? null,
    bool: row.value_bool == null ? null : !!Number(row.value_bool),
    date: dateText(row.value_date),
    option_id: row.option_id ?? null,
    uom: uom ?? row.uom ?? null,
    source: source ?? row.source,
  };
}

async function writeHistory(db, c, { valueId, specId, subjectType, subjectId, changeType, before, after }) {
  await db.query(
    `INSERT INTO cf_spec_value_history
       (company_id, value_id, specification_id, subject_type, subject_id, change_type, old_value, new_value, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, valueId, specId, subjectType, subjectId, changeType,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, c.userId],
  );
}

/**
 * Creates, changes or clears one value, with history. `typed` null clears it.
 * Returns a change record, or null when nothing changed.
 */
export async function upsertValue(db, c, spec, subjectType, subjectId, typed, source) {
  const [[own]] = await db.query(
    `SELECT * FROM cf_spec_values
      WHERE company_id = ? AND specification_id = ? AND subject_type = ? AND subject_id = ? AND deleted_at IS NULL`,
    [c.companyId, spec.id, subjectType, subjectId],
  );
  const base = { specId: spec.id, subjectType, subjectId };

  if (!typed) {
    if (!own) return null;
    await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE id = ?', [own.id]);
    await writeHistory(db, c, { ...base, valueId: own.id, changeType: 'delete', before: snapshot(own), after: null });
    return { spec: spec.code, change: 'cleared', source: own.source };
  }

  const uom = spec.default_uom ?? null; // locked to the spec's unit for now (Q11)
  if (!own) {
    const [r] = await db.query(
      `INSERT INTO cf_spec_values
         (company_id, specification_id, subject_type, subject_id, value_number, value_text, value_bool, value_date, option_id, uom, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.companyId, spec.id, subjectType, subjectId, typed.value_number, typed.value_text, typed.value_bool,
        typed.value_date, typed.option_id, uom, source, c.userId],
    );
    await writeHistory(db, c, { ...base, valueId: r.insertId, changeType: 'create', before: null, after: snapshot(typed, source, uom) });
    return { spec: spec.code, change: 'set', source };
  }

  if (sameValue(own, typed) && own.source === source) return null;
  await db.query(
    `UPDATE cf_spec_values
        SET value_number = ?, value_text = ?, value_bool = ?, value_date = ?, option_id = ?, uom = ?, source = ?
      WHERE id = ?`,
    [typed.value_number, typed.value_text, typed.value_bool, typed.value_date, typed.option_id, uom, source, own.id],
  );
  await writeHistory(db, c, { ...base, valueId: own.id, changeType: 'update', before: snapshot(own), after: snapshot(typed, source, uom) });
  return { spec: spec.code, change: 'changed', source };
}

/**
 * A person sets values on one subject. entries: [{ specificationId | specCode, value }].
 * Everything is validated first; nothing is written if anything is wrong.
 */
export async function setValues(db, c, subjectType, subjectId, entries = []) {
  if (!Array.isArray(entries) || !entries.length) return { changes: [], materialized: 0 };
  if (!['classification', 'master', 'machine'].includes(subjectType)) {
    throw invalid('NOT_HERE', subjectType === 'batch' ? 'Batch values are set on the batch (Inventory › Batches).' : 'Values on individual units arrive with production.');
  }
  const master = subjectType === 'master' ? await requireMaster(db, c.companyId, subjectId) : null;
  if (master) assertNotFrozen(master, 'values');
  const machine = subjectType === 'machine' ? await requireMachine(db, c.companyId, subjectId) : null;
  if (subjectType === 'classification') await requireNode(db, c.companyId, subjectId);

  const { byId, byCode } = await loadSpecs(db, c.companyId, entries);
  let rules = null;
  if ((master && master.record_kind === 'item') || machine) {
    const r = await resolve(db, c.companyId, machine ? { machine } : { master });
    rules = new Map(r.specs.filter((s) => s.captureAt === 'item').map((s) => [s.spec.id, s]));
  }

  const problems = [];
  const writes = [];
  const seen = new Set();
  for (const e of entries) {
    const spec = e.specificationId != null ? byId.get(Number(e.specificationId)) : byCode.get(String(e.specCode ?? '').toUpperCase());
    if (!spec) { problems.push(`Unknown specification ${e.specCode ?? e.specificationId}.`); continue; }
    if (seen.has(spec.id)) { problems.push(`${spec.code} is given twice.`); continue; }
    seen.add(spec.id);

    let allowed = null;
    if (rules) {
      const rule = rules.get(spec.id);
      if (!rule || !rule.applicable) { problems.push(`${spec.code} is not part of this ${machine ? 'machine' : 'item'}'s setup.`); continue; }
      const vr = rule.rule.valueRule;
      if (vr === 'fixed') { problems.push(`${spec.code} is fixed at ${rule.definedAt.level.toLowerCase()} level — change it there.`); continue; }
      if (['calculated', 'rollup', 'inherited'].includes(vr)) { problems.push(`${spec.code} is ${vr} — it cannot be typed in.`); continue; }
      if (rule.options) allowed = new Set(rule.options.map((o) => o.id));
    } else if (spec.status !== 'active' && e.value !== null && e.value !== '') {
      problems.push(`${spec.code} is inactive.`);
      continue;
    }
    const out = await coerce(db, c.companyId, spec, e.value, allowed);
    if (out.problem) problems.push(out.problem);
    else writes.push({ spec, typed: out.typed });
  }
  if (problems.length) throw invalid('INVALID_VALUES', 'Some values could not be saved.', { problems });

  const changes = [];
  for (const w of writes) {
    const ch = await upsertValue(db, c, w.spec, subjectType, subjectId, w.typed, 'entered');
    if (ch) changes.push(ch);
  }

  let materialized;
  if (machine) {
    materialized = { records: 1, changes: (await materializeMachine(db, c, machine.id)).length };
  } else if (master && master.record_kind === 'item') {
    const own = (await materialize(db, c, master.id)).length;
    // Its parents roll it up and its children may inherit from it.
    const around = changes.length || own ? await refreshValues(db, c, [master.id], { startWithNeighbours: true }) : { records: 0, changes: 0 };
    materialized = { records: 1 + around.records, changes: own + around.changes };
  } else if (master) materialized = await rematerialize(db, c, { definitionId: master.id });
  else materialized = await rematerialize(db, c, { classificationId: subjectId });
  return { changes, materialized };
}

/**
 * Stores the values an item's rules produce, and removes derived values that
 * no rule produces any more. Entered values are never touched, except that an
 * entered value under a Fixed rule is replaced by the fixed one.
 *
 * An item of a closed, lost or cancelled order is left exactly as it is: a
 * formula edited next year must not rewrite the weight of a girder already
 * delivered. Returning no change also stops the walk through BOMs there.
 */
export async function materialize(db, c, masterId) {
  const master = await loadMaster(db, c.companyId, masterId);
  if (!master || master.record_kind !== 'item' || frozenBy(master)) return [];
  return storeDerived(db, c, 'master', master.id, await resolve(db, c.companyId, { master }));
}

/** The same for a machine: fixed and default values from its machine type, calculated ones from its own. */
export async function materializeMachine(db, c, machineId) {
  const machine = await loadMachine(db, c.companyId, machineId);
  if (!machine) return [];
  return storeDerived(db, c, 'machine', machine.id, await resolve(db, c.companyId, { machine }));
}

async function storeDerived(db, c, subjectType, subjectId, r) {
  const { ownRows, effectiveRows } = r.internal;
  const changes = [];
  const touch = async (s, typed, source) => {
    const ch = await upsertValue(db, c, { id: s.spec.id, code: s.spec.code, default_uom: s.spec.unit }, subjectType, subjectId, typed, source);
    if (ch) changes.push(ch);
  };
  const typedOf = (row) => (row ? {
    value_number: row.value_number == null ? null : Number(row.value_number),
    value_text: row.value_text ?? null,
    value_bool: row.value_bool == null ? null : Number(row.value_bool),
    value_date: dateText(row.value_date),
    option_id: row.option_id ?? null,
  } : null);

  const produced = new Set();
  for (const s of r.specs) {
    if (!s.applicable || s.captureAt !== 'item') continue;
    produced.add(s.spec.id);
    const own = ownRows.get(s.spec.id) ?? null;
    switch (s.rule.valueRule) {
      case 'fixed':
        if (s.value) await touch(s, typedOf(effectiveRows.get(s.spec.id)), 'fixed');
        else if (own && own.source === 'fixed') await touch(s, null, 'fixed');
        break;
      case 'defaulted':
        if (own && own.source === 'entered') break;
        if (s.value) await touch(s, typedOf(effectiveRows.get(s.spec.id)), 'defaulted');
        else if (own) await touch(s, null, 'defaulted');
        break;
      case 'calculated':
        if (s.status === 'calculated') await touch(s, { ...EMPTY, value_number: s.value.raw }, 'calculated');
        else if (own) await touch(s, null, 'calculated');
        break;
      case 'rollup':
        if (s.status === 'rollup') await touch(s, { ...EMPTY, value_number: s.value.raw }, 'rollup');
        else if (own) await touch(s, null, 'rollup');
        break;
      case 'inherited':
        if (s.status === 'inherited') await touch(s, typedOf(effectiveRows.get(s.spec.id)), 'inherited');
        else if (own) await touch(s, null, 'inherited');
        break;
      case 'entered':
        if (own && own.source !== 'entered') await touch(s, null, own.source);
        break;
      default:
        break;
    }
  }
  // Derived values whose rule is gone. Entered values stay — they are a person's data.
  for (const own of ownRows.values()) {
    if (!produced.has(own.specification_id) && own.source !== 'entered') {
      const ch = await upsertValue(db, c, { id: own.specification_id, code: own.spec_code, default_uom: own.uom }, subjectType, subjectId, null, own.source);
      if (ch) changes.push(ch);
    }
  }
  return changes;
}

/** Item ids a setup change on a definition or a classification subtree reaches. */
async function affectedItems(db, c, { definitionId, classificationId }) {
  if (definitionId) {
    const [rows] = await db.query(
      'SELECT master_id AS id FROM cf_item_details WHERE company_id = ? AND source_definition_id = ? AND deleted_at IS NULL',
      [c.companyId, definitionId],
    );
    return rows.map((r) => r.id);
  }
  // Temporary items share their definition's classification, so a subtree covers them too.
  const nodes = await subtreeIds(db, c.companyId, classificationId);
  const [rows] = await db.query(
    `SELECT m.id FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.classification_id IN (?)`,
    [c.companyId, nodes],
  );
  return rows.map((r) => r.id);
}

const MAX_VISITS = 20;

/**
 * Re-materialises records and follows the change through BOMs until nothing
 * moves: when an item's values change, its BOM parents are re-worked (their
 * roll-ups read it) and so are the temporary items under it (they may inherit
 * from it). With `startWithNeighbours` the given records have already changed —
 * a person typed a value — so the walk starts from their neighbours.
 *
 * Converges because BOMs cannot loop (the BOM service refuses it). A record
 * re-worked more than MAX_VISITS times means two rules feed each other through
 * the BOM — a roll-up over an inherited value of the same spec, say — and that
 * is reported instead of spinning.
 *
 * Runs inline in the caller's transaction; if structures grow large this is
 * the loop to move onto the job queue.
 */
export async function refreshValues(db, c, ids, { startWithNeighbours = false } = {}) {
  const queue = [];
  const queued = new Set();
  const visits = new Map();
  const push = (id) => { if (!queued.has(id)) { queued.add(id); queue.push(id); } };
  const pushNeighbours = async (id) => {
    for (const p of await parentsOf(db, c.companyId, [id])) push(p);
    for (const k of await tempChildrenOf(db, c.companyId, [id])) push(k);
  };
  if (startWithNeighbours) for (const id of ids) await pushNeighbours(id);
  else ids.forEach(push);

  let records = 0;
  let changes = 0;
  while (queue.length) {
    const id = queue.shift();
    queued.delete(id);
    const n = (visits.get(id) ?? 0) + 1;
    visits.set(id, n);
    if (n > MAX_VISITS) {
      const m = await loadMaster(db, c.companyId, id);
      throw invalid('VALUE_LOOP', `Values on ${m?.code ?? m?.name ?? id} keep changing each other through the BOM — a roll-up and an inherited rule probably feed each other. Check the rules on this structure.`);
    }
    const ch = await materialize(db, c, id);
    records++;
    if (ch.length) { changes += ch.length; await pushNeighbours(id); }
  }
  return { records, changes };
}

/** Machines whose machine type sits in a classification subtree. */
async function affectedMachines(db, c, classificationId) {
  const nodes = await subtreeIds(db, c.companyId, classificationId);
  const [rows] = await db.query(
    'SELECT id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND classification_id IN (?)',
    [c.companyId, nodes],
  );
  return rows.map((r) => r.id);
}

/**
 * Re-materialises every item and machine a setup change can affect, and
 * whatever the items' changes reach through BOMs. scope is one of
 * { masterId } | { machineId } | { definitionId } | { classificationId } | { formulaId }.
 */
export async function rematerialize(db, c, scope) {
  const ids = new Set();
  const machines = new Set();
  if (scope.masterId) ids.add(scope.masterId);
  if (scope.machineId) machines.add(scope.machineId);
  if (scope.definitionId || scope.classificationId) {
    (await affectedItems(db, c, scope)).forEach((id) => ids.add(id));
  }
  if (scope.classificationId) (await affectedMachines(db, c, scope.classificationId)).forEach((id) => machines.add(id));
  if (scope.formulaId) {
    const [subjects] = await db.query(
      `SELECT DISTINCT a.subject_type, a.subject_id, m.record_kind
         FROM cf_spec_assignments a
         LEFT JOIN cf_master_records m ON a.subject_type = 'master' AND m.id = a.subject_id
        WHERE a.company_id = ? AND a.formula_id = ? AND a.deleted_at IS NULL`,
      [c.companyId, scope.formulaId],
    );
    for (const s of subjects) {
      if (s.subject_type === 'machine') machines.add(s.subject_id);
      else if (s.subject_type === 'master' && s.record_kind === 'item') ids.add(s.subject_id);
      else {
        const reach = s.subject_type === 'classification' ? { classificationId: s.subject_id } : { definitionId: s.subject_id };
        (await affectedItems(db, c, reach)).forEach((id) => ids.add(id));
        if (s.subject_type === 'classification') (await affectedMachines(db, c, s.subject_id)).forEach((id) => machines.add(id));
      }
    }
  }
  let machineChanges = 0;
  for (const id of machines) machineChanges += (await materializeMachine(db, c, id)).length;
  const out = await refreshValues(db, c, [...ids]);
  return { records: out.records + machines.size, changes: out.changes + machineChanges };
}

/** Clears every value on a subject that is being deleted, with history. */
export async function deleteAllForSubject(db, c, subjectType, subjectId) {
  const [rows] = await db.query(
    `SELECT v.*, s.code AS spec_code FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
      WHERE v.company_id = ? AND v.subject_type = ? AND v.subject_id = ? AND v.deleted_at IS NULL`,
    [c.companyId, subjectType, subjectId],
  );
  for (const row of rows) {
    await upsertValue(db, c, { id: row.specification_id, code: row.spec_code, default_uom: row.uom }, subjectType, subjectId, null, row.source);
  }
  return rows.length;
}

export async function getHistory(db, companyId, subjectType, subjectId, limit = 200) {
  const [rows] = await db.query(
    `SELECT h.id, h.change_type, h.old_value, h.new_value, h.changed_at, h.changed_by,
            s.code AS spec_code, s.name AS spec_name, s.data_type, s.decimals, s.default_uom,
            u.email AS changed_by_email
       FROM cf_spec_value_history h
       JOIN cf_specifications s ON s.id = h.specification_id
       LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.company_id = ? AND h.subject_type = ? AND h.subject_id = ?
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT ?`,
    [companyId, subjectType, subjectId, Math.min(Number(limit) || 200, 1000)],
  );
  const [optRows] = await db.query('SELECT id, value, label FROM cf_spec_options WHERE company_id = ?', [companyId]);
  const optionText = new Map(optRows.map((o) => [o.id, o.label || o.value]));
  const text = (snap, row) => {
    if (!snap) return null;
    const j = typeof snap === 'string' ? JSON.parse(snap) : snap;
    if (j.number != null) return row.decimals == null ? String(j.number) : Number(j.number).toFixed(row.decimals);
    if (j.option_id != null) return optionText.get(j.option_id) ?? `#${j.option_id}`;
    if (j.bool != null) return j.bool ? 'Yes' : 'No';
    return j.date ?? j.text ?? null;
  };
  return rows.map((row) => {
    const oldV = typeof row.old_value === 'string' ? JSON.parse(row.old_value) : row.old_value;
    const newV = typeof row.new_value === 'string' ? JSON.parse(row.new_value) : row.new_value;
    return {
      id: row.id,
      specCode: row.spec_code,
      specName: row.spec_name,
      change: row.change_type,
      from: text(oldV, row),
      to: text(newV, row),
      unit: row.default_uom,
      source: newV?.source ?? oldV?.source ?? null,
      changedAt: row.changed_at,
      changedBy: row.changed_by_email ?? null,
    };
  });
}
