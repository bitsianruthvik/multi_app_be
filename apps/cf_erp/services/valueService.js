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
import { isDeepStrictEqual } from 'node:util';
import { invalid } from '../lib/errors.js';
import { requireNode, subtreeIds } from './tree.js';
import { loadMaster, requireMaster, frozenBy, assertNotFrozen, loadMachine, requireMachine, AFTER_LOCK_SPECS } from './records.js';
import { resolve, dateText, tableSummary } from './resolutionService.js';
import { parentsOf, tempChildrenOf } from './bomGraph.js';
import { STEEL_FROM_STOCK_SET } from '../lib/cutFrom.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY = { value_number: null, value_text: null, value_bool: null, value_date: null, option_id: null, value_json: null };

/** JSON columns come back parsed on some drivers, as text on others. */
const parseJsonCol = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

export async function loadSpecs(db, companyId, entries) {
  const ids = entries.map((e) => e.specificationId).filter((v) => v != null).map(Number);
  const codes = entries.map((e) => e.specCode).filter(Boolean).map((c) => String(c).toUpperCase());
  if (!ids.length && !codes.length) return { byId: new Map(), byCode: new Map() };
  const [rows] = await db.query(
    `SELECT id, code, name, data_type, default_uom, status, table_config FROM cf_specifications
      WHERE company_id = ? AND deleted_at IS NULL AND (id IN (?) OR code IN (?))`,
    [companyId, ids.length ? ids : [0], codes.length ? codes : ['']],
  );
  return { byId: new Map(rows.map((r) => [r.id, r])), byCode: new Map(rows.map((r) => [r.code.toUpperCase(), r])) };
}

/**
 * Validates a table value against its spec's axes (from table_config: one axis
 * or two) and normalises it to a fixed key order — { x, v } or { x, y, v },
 * v[yIndex][xIndex] — so two writes of the same chart compare equal. `spec`
 * needs `code` and `table_config` (loadSpecs already selects it).
 *
 * Returns { typed } (value_json-ready, `null` clears the whole chart) or
 * { problem } in words: which row is wrong and why, never "invalid input".
 */
export function validateTableValue(spec, input) {
  if (input === null || input === undefined || input === '') return { typed: null };
  // The shared specification editor keeps draft values as strings for every
  // data type. Decode its chart at this boundary, then apply the same checks.
  if (typeof input === 'string') {
    try { input = JSON.parse(input); }
    catch { return { problem: `${spec.code} needs a valid table of values.` }; }
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { problem: `${spec.code} needs a table of values (x and v, or x, y and v) — not a plain value.` };
  }
  const config = parseJsonCol(spec.table_config);
  const axisCount = config?.axes?.length || 1;

  const axis = (name, arr) => {
    if (!Array.isArray(arr) || !arr.length) return { problem: `${spec.code} needs at least one ${name} value.` };
    const nums = [];
    for (const raw of arr) {
      const n = Number(raw);
      if (!['number', 'string'].includes(typeof raw) || String(raw).trim() === '' || !Number.isFinite(n)) return { problem: `${spec.code}'s ${name} values must all be numbers.` };
      nums.push(n);
    }
    for (let i = 1; i < nums.length; i++) {
      if (!(nums[i] > nums[i - 1])) return { problem: `${spec.code}'s ${name} values must keep increasing left to right — ${nums[i - 1]} is not less than ${nums[i]}.` };
    }
    return { values: nums };
  };
  const cell = (raw, where) => {
    if (raw === null || raw === undefined || raw === '') return { value: null };
    const n = Number(raw);
    if (!['number', 'string'].includes(typeof raw) || String(raw).trim() === '' || !Number.isFinite(n)) return { problem: `${spec.code}: ${where} is not a number — leave it blank if the machine cannot do it.` };
    return { value: Number(n.toFixed(6)) };
  };

  const x = axis(config?.axes?.[0]?.label || 'x', input.x);
  if (x.problem) return { problem: x.problem };

  if (axisCount === 1) {
    if (input.y != null) return { problem: `${spec.code} has one axis — give x and v, not y.` };
    if (!Array.isArray(input.v)) return { problem: `${spec.code} needs a v value under every x.` };
    if (input.v.length !== x.values.length) {
      return { problem: `${spec.code}: ${x.values.length} x value(s) but ${input.v.length} v value(s) — every column needs exactly one row.` };
    }
    const v = [];
    for (let i = 0; i < input.v.length; i++) {
      const c = cell(input.v[i], `the value at x = ${x.values[i]}`);
      if (c.problem) return { problem: c.problem };
      v.push(c.value);
    }
    return { typed: { ...EMPTY, value_json: { x: x.values, v } } };
  }

  const y = axis(config?.axes?.[1]?.label || 'y', input.y);
  if (y.problem) return { problem: y.problem };
  if (!Array.isArray(input.v) || input.v.length !== y.values.length) {
    return { problem: `${spec.code}: ${y.values.length} y value(s) but ${Array.isArray(input.v) ? input.v.length : 0} row(s) of v — every y needs one row.` };
  }
  const v = [];
  for (let j = 0; j < input.v.length; j++) {
    const row = input.v[j];
    if (!Array.isArray(row) || row.length !== x.values.length) {
      return { problem: `${spec.code}: the row for y = ${y.values[j]} has ${Array.isArray(row) ? row.length : 0} value(s), not ${x.values.length} — every x needs one column.` };
    }
    const outRow = [];
    for (let i = 0; i < row.length; i++) {
      const c = cell(row[i], `the value at x = ${x.values[i]}, y = ${y.values[j]}`);
      if (c.problem) return { problem: c.problem };
      outRow.push(c.value);
    }
    v.push(outRow);
  }
  return { typed: { ...EMPTY, value_json: { x: x.values, y: y.values, v } } };
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
  // Every OTHER type takes a plain value — an object here is a caller mistake
  // (e.g. a table value sent for a number spec), not a value to coerce into text.
  if (spec.data_type !== 'table' && typeof input === 'object') return { problem: `${spec.code} needs a plain value, not a table.` };
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
    case 'table':
      return validateTableValue(spec, input);
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
    && (row.option_id ?? null) === (typed.option_id ?? null)
    // MySQL reorders JSON object keys. Compare contents so an unchanged chart
    // does not write history or keep a materialization cascade running.
    && isDeepStrictEqual(parseJsonCol(row.value_json), typed.value_json ?? null);
}

function snapshot(row, source, uom) {
  if (!row) return null;
  return {
    number: row.value_number == null ? null : Number(row.value_number),
    text: row.value_text ?? null,
    bool: row.value_bool == null ? null : !!Number(row.value_bool),
    date: dateText(row.value_date),
    option_id: row.option_id ?? null,
    json: row.value_json === undefined ? null : parseJsonCol(row.value_json),
    uom: uom ?? row.uom ?? null,
    source: source ?? row.source,
  };
}

/* ---------------------------------------------------------------------------
 * Writing values — one subject, any number of specs, a fixed number of queries.
 *
 * One value used to cost three round trips: read its current row, write the new
 * one, write its history row. Creating a catalog item writes nine values, so 27
 * of its 65 queries were this one loop. Over a link to TiDB (49 ms a hop) that
 * is 1.3 s per item, and it was the largest block left.
 *
 * Every caller writes to ONE subject at a time — setValues, storeDerived,
 * deleteAllForSubject and the batch service all fix (subject_type, subject_id)
 * and vary the spec — so the batch is per subject. That also keeps the read
 * simple: `subject_type = ? AND subject_id = ? AND specification_id IN (...)`
 * is a plain index range, not a row-constructor IN list the planner has to
 * think about. A create-only payload of any size now costs four queries:
 *
 *     SELECT the rows that already exist      1
 *     INSERT the new value rows               1  multi-row
 *     SELECT their ids back                   1
 *     INSERT the history rows                 1  multi-row
 *
 * WHY THE IDS ARE READ BACK RATHER THAN COUNTED FORWARD
 * A history row names the value row it describes. A multi-row INSERT reports
 * only `insertId` (the first row) and `affectedRows`; working the rest out by
 * adding one is an assumption that the engine hands out AUTO_INCREMENT
 * contiguously. TiDB does not — each node caches a block of the sequence, so
 * ids from one statement are ascending but not adjacent, and two nodes
 * interleave their blocks. So the ids are read back by the natural key instead.
 * (company_id, specification_id, subject_type, subject_id) with deleted_at NULL
 * is the unique key uq_csv_value, so each key matches exactly the row this
 * transaction just inserted, whatever number the engine gave it. True on MySQL,
 * true on TiDB, and still true if the allocator ever changes.
 *
 * ORDER
 * Value rows are written deletes, then updates, then inserts — they are
 * different rows with different keys, so nothing depends on the order between
 * them. History rows then go in one statement in the order the caller listed
 * the writes, so history still reads back in write order (getHistory sorts by
 * changed_at, then id, and everything in one transaction shares a second).
 *
 * A spec named twice in one payload is split into a second pass, because the
 * second write must see the first — exactly what the one-at-a-time loop did.
 * ------------------------------------------------------------------------ */

// Placeholder budgets. mysql2 interpolates client-side, so the ceiling is
// max_allowed_packet (MySQL) / txn-entry and statement limits (TiDB), not the
// 65535 parameter cap. 200 value rows is 2400 placeholders and a few tens of
// kilobytes of SQL — two orders of magnitude inside either limit — while still
// being one round trip for every payload a person can realistically type.
const INSERT_CHUNK = 200;   // rows per multi-row INSERT
const UPDATE_CHUNK = 100;   // rows per CASE update (7 columns x 2 params a row, plus the id list)
const READ_CHUNK = 500;     // spec ids per IN list

const chunk = (xs, n) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

const SET_COLS = ['value_number', 'value_text', 'value_bool', 'value_date', 'option_id', 'value_json', 'uom', 'source'];
// mysql2 does not serialise a JS object into a JSON column on its own (the
// codebase's other JSON writer, insertHistory, stringifies explicitly too).
const cellOf = (r, col) => (col === 'uom' ? r.uom : col === 'source' ? r.source
  : col === 'value_json' ? (r.typed.value_json == null ? null : JSON.stringify(r.typed.value_json)) : r.typed[col]);

/** The live value rows for these specs on one subject, keyed by specification_id. */
async function ownRowsFor(db, companyId, subjectType, subjectId, specIds) {
  const out = new Map();
  const ids = [...new Set(specIds)];
  if (!ids.length) return out;
  for (const part of chunk(ids, READ_CHUNK)) {
    const [rows] = await db.query(
      `SELECT * FROM cf_spec_values
        WHERE company_id = ? AND subject_type = ? AND subject_id = ? AND specification_id IN (?) AND deleted_at IS NULL`,
      [companyId, subjectType, subjectId, part],
    );
    for (const r of rows) out.set(r.specification_id, r);
  }
  return out;
}

async function clearRows(db, ids) {
  for (const part of chunk(ids, INSERT_CHUNK)) {
    await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE id IN (?)', [part]);
  }
}

async function updateRows(db, rows) {
  for (const part of chunk(rows, UPDATE_CHUNK)) {
    if (part.length === 1) {
      const r = part[0];
      await db.query(
        `UPDATE cf_spec_values
            SET value_number = ?, value_text = ?, value_bool = ?, value_date = ?, option_id = ?, value_json = ?, uom = ?, source = ?
          WHERE id = ?`,
        [r.typed.value_number, r.typed.value_text, r.typed.value_bool, r.typed.value_date, r.typed.option_id,
          r.typed.value_json == null ? null : JSON.stringify(r.typed.value_json), r.uom, r.source, r.id],
      );
      continue;
    }
    // One statement, one CASE per column. Every id in the WHERE has a WHEN, so
    // no row can fall through to the implicit ELSE NULL.
    const params = [];
    const sets = SET_COLS.map((col) => {
      const whens = part.map((r) => { params.push(r.id, cellOf(r, col)); return 'WHEN ? THEN ?'; }).join(' ');
      return `${col} = CASE id ${whens} END`;
    }).join(', ');
    params.push(part.map((r) => r.id));
    await db.query(`UPDATE cf_spec_values SET ${sets} WHERE id IN (?)`, params);
  }
}

async function insertRows(db, c, subjectType, subjectId, rows) {
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const params = [];
    for (const r of part) {
      params.push(c.companyId, r.spec.id, subjectType, subjectId, r.typed.value_number, r.typed.value_text,
        r.typed.value_bool, r.typed.value_date, r.typed.option_id,
        r.typed.value_json == null ? null : JSON.stringify(r.typed.value_json), r.uom, r.source, c.userId);
    }
    await db.query(
      `INSERT INTO cf_spec_values
         (company_id, specification_id, subject_type, subject_id, value_number, value_text, value_bool, value_date, option_id, value_json, uom, source, created_by)
       VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      params,
    );
  }
}

async function insertHistory(db, c, subjectType, subjectId, rows) {
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const params = [];
    for (const h of part) {
      params.push(c.companyId, h.valueId, h.specId, subjectType, subjectId, h.changeType,
        h.before ? JSON.stringify(h.before) : null, h.after ? JSON.stringify(h.after) : null, c.userId);
    }
    await db.query(
      `INSERT INTO cf_spec_value_history
         (company_id, value_id, specification_id, subject_type, subject_id, change_type, old_value, new_value, changed_by)
       VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      params,
    );
  }
}

/**
 * One pass: every spec in it is distinct, so the whole pass reads and writes
 * together. History rows are appended to `history` rather than written here —
 * see applyWrites for why.
 */
async function applyPass(db, c, subjectType, subjectId, pass, out, history) {
  const own = await ownRowsFor(db, c.companyId, subjectType, subjectId, pass.map((w) => w.spec.id));
  const cleared = [];
  const changed = [];
  const created = [];
  const mine = [];

  for (const w of pass) {
    const row = own.get(w.spec.id) ?? null;
    if (!w.typed) {
      if (!row) continue;
      cleared.push(row.id);
      mine.push({ idx: w.idx, valueId: row.id, specId: w.spec.id, changeType: 'delete', before: snapshot(row), after: null });
      out[w.idx] = { spec: w.spec.code, change: 'cleared', source: row.source };
      continue;
    }
    const uom = w.spec.default_uom ?? null; // locked to the spec's unit for now (Q11)
    if (!row) {
      created.push({ spec: w.spec, typed: w.typed, uom, source: w.source });
      mine.push({ idx: w.idx, valueId: null, specId: w.spec.id, changeType: 'create', before: null, after: snapshot(w.typed, w.source, uom) });
      out[w.idx] = { spec: w.spec.code, change: 'set', source: w.source };
      continue;
    }
    if (sameValue(row, w.typed) && row.source === w.source) continue;
    changed.push({ id: row.id, typed: w.typed, uom, source: w.source });
    mine.push({ idx: w.idx, valueId: row.id, specId: w.spec.id, changeType: 'update', before: snapshot(row), after: snapshot(w.typed, w.source, uom) });
    out[w.idx] = { spec: w.spec.code, change: 'changed', source: w.source };
  }
  if (!mine.length) return;

  if (cleared.length) await clearRows(db, cleared);
  if (changed.length) await updateRows(db, changed);
  if (created.length) {
    await insertRows(db, c, subjectType, subjectId, created);
    const fresh = await ownRowsFor(db, c.companyId, subjectType, subjectId, created.map((r) => r.spec.id));
    for (const h of mine) {
      if (h.changeType !== 'create') continue;
      const row = fresh.get(h.specId);
      if (!row) throw new Error(`cf_erp: value row for specification ${h.specId} on ${subjectType} ${subjectId} vanished between insert and read-back.`);
      h.valueId = row.id;
    }
  }
  history.push(...mine);
}

/**
 * Creates, changes or clears many values on ONE subject, with history.
 * writes: [{ spec, typed, source }] — `typed` null clears that value.
 * Returns the change records, in the order given, with the no-ops dropped.
 */
export async function upsertValues(db, c, subjectType, subjectId, writes = []) {
  return (await applyWrites(db, c, subjectType, subjectId, writes)).filter(Boolean);
}

async function applyWrites(db, c, subjectType, subjectId, writes) {
  const out = new Array(writes.length).fill(null);
  const history = [];
  let pending = writes.map((w, idx) => ({ ...w, idx }));
  while (pending.length) {
    const pass = [];
    const later = [];
    const seen = new Set();
    for (const w of pending) {
      if (seen.has(w.spec.id)) later.push(w);
      else { seen.add(w.spec.id); pass.push(w); }
    }
    await applyPass(db, c, subjectType, subjectId, pass, out, history);
    pending = later;
  }
  // Every history row for the call, in one statement, in the order the caller
  // listed the writes. The passes above reorder the value writes when a spec is
  // named twice (the second write has to see the first); sorting by the
  // caller's index puts history back exactly as the one-at-a-time loop left it.
  // Every value row is written before any history row, which is also what the
  // foreign key on value_id needs.
  if (history.length) {
    history.sort((a, b) => a.idx - b.idx);
    await insertHistory(db, c, subjectType, subjectId, history);
  }
  return out;
}

/**
 * Creates, changes or clears one value, with history. `typed` null clears it.
 * Returns a change record, or null when nothing changed.
 */
export async function upsertValue(db, c, spec, subjectType, subjectId, typed, source) {
  const [change] = await applyWrites(db, c, subjectType, subjectId, [{ spec, typed, source }]);
  return change ?? null;
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
  const machine = subjectType === 'machine' ? await requireMachine(db, c.companyId, subjectId) : null;
  if (subjectType === 'classification') await requireNode(db, c.companyId, subjectId);

  const { byId, byCode } = await loadSpecs(db, c.companyId, entries);
  if (master) {
    // A locked line still takes nesting's own values (records.AFTER_LOCK_SPECS):
    // nesting comes after lock. Anything else on a frozen record is refused.
    const codeOf = (e) => String((e.specificationId != null ? byId.get(Number(e.specificationId))?.code : e.specCode) ?? '').toUpperCase();
    const planningOnly = frozenBy(master)?.reason === 'locked' && entries.every((e) => AFTER_LOCK_SPECS.has(codeOf(e)));
    if (!planningOnly) assertNotFrozen(master, 'values');
  }
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

  const changes = await upsertValues(db, c, subjectType, subjectId,
    writes.map((w) => ({ spec: w.spec, typed: w.typed, source: 'entered' })));

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
  // Nothing in either loop reads a value back, so the writes are collected and
  // sent as one batch at the end; the list keeps the order they were decided in.
  const writes = [];
  const touch = (s, typed, source) => {
    writes.push({ spec: { id: s.spec.id, code: s.spec.code, default_uom: s.spec.unit }, typed, source });
  };
  const typedOf = (row) => (row ? {
    value_number: row.value_number == null ? null : Number(row.value_number),
    value_text: row.value_text ?? null,
    value_bool: row.value_bool == null ? null : Number(row.value_bool),
    value_date: dateText(row.value_date),
    option_id: row.option_id ?? null,
    value_json: row.value_json === undefined ? null : parseJsonCol(row.value_json),
  } : null);

  const produced = new Set();
  for (const s of r.specs) {
    if (!s.applicable || s.captureAt !== 'item') continue;
    produced.add(s.spec.id);
    const own = ownRows.get(s.spec.id) ?? null;
    switch (s.rule.valueRule) {
      case 'fixed':
        if (s.value) touch(s, typedOf(effectiveRows.get(s.spec.id)), 'fixed');
        else if (own && own.source === 'fixed') touch(s, null, 'fixed');
        break;
      case 'defaulted':
        if (own && own.source === 'entered') break;
        if (s.value) touch(s, typedOf(effectiveRows.get(s.spec.id)), 'defaulted');
        else if (own) touch(s, null, 'defaulted');
        break;
      case 'calculated':
        if (s.status === 'calculated') touch(s, { ...EMPTY, value_number: s.value.raw }, 'calculated');
        else if (own) touch(s, null, 'calculated');
        break;
      case 'rollup':
        if (s.status === 'rollup') touch(s, { ...EMPTY, value_number: s.value.raw }, 'rollup');
        else if (own) touch(s, null, 'rollup');
        break;
      case 'inherited':
        if (s.status === 'inherited') touch(s, typedOf(effectiveRows.get(s.spec.id)), 'inherited');
        else if (own) touch(s, null, 'inherited');
        break;
      case 'entered':
        // A section part's steel taken from its stock bar (lib/cutFrom STEEL_FROM_STOCK) is stored
        // 'inherited' under an entered rule; the cut-piece derive owns those rows, not this.
        if (own && own.source !== 'entered' && !(own.source === 'inherited' && STEEL_FROM_STOCK_SET.has(String(s.spec.code).toUpperCase()))) touch(s, null, own.source);
        break;
      default:
        break;
    }
  }
  // Derived values whose rule is gone. Entered values stay — they are a person's data.
  for (const own of ownRows.values()) {
    if (!produced.has(own.specification_id) && own.source !== 'entered') {
      writes.push({ spec: { id: own.specification_id, code: own.spec_code, default_uom: own.uom }, typed: null, source: own.source });
    }
  }
  return upsertValues(db, c, subjectType, subjectId, writes);
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
  await upsertValues(db, c, subjectType, subjectId, rows.map((row) => ({
    spec: { id: row.specification_id, code: row.spec_code, default_uom: row.uom }, typed: null, source: row.source,
  })));
  return rows.length;
}

export async function getHistory(db, companyId, subjectType, subjectId, limit = 200) {
  const [rows] = await db.query(
    `SELECT h.id, h.change_type, h.old_value, h.new_value, h.changed_at, h.changed_by,
            s.code AS spec_code, s.name AS spec_name, s.data_type, s.decimals, s.default_uom, s.table_config,
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
    if (j.json != null) return tableSummary(parseJsonCol(row.table_config), j.json);
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
