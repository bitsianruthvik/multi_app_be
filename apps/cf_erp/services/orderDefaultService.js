/**
 * orderDefaultService.js — ORDER and LINE values for specifications (init.sql §65, lib/orderDefaults).
 *
 * User, 2026-10-16: "The various coats, MS BO or BR, all of these are also set at an order or a line
 * level typically and can be overridden in the values screen if required."
 *
 *   GET /orders/:id/spec-defaults
 *     -> the flagged specifications (Setup: "Can be set for a whole order"), the order's values, each
 *        line's values, and per line how its rows take each one (rows that have it, rows that follow,
 *        rows with their own entry, rows whose option list does not allow the value)
 *   PUT /orders/:id/spec-defaults   { lineId?: number | null, dryRun?, writes: [{ specCode, value }] }
 *     -> lineId absent / null = the whole order; a value of null or '' takes it away. Every open line
 *        the change reaches is worked out again at once (its rows store the value they now take); a
 *        LOCKED or released line is not touched — what it locked with stays (records.frozenBy).
 *
 * The precedence lives in ONE place, lib/orderDefaults.js, read by both resolvers:
 *   row entry > line value > order value > the specification's own rule.
 *
 * ROUND TRIPS. Read: 5 + one line context (~10) per custom line, to count how its rows take each value.
 * Write: order + lines FOR UPDATE (2), specs + options (2), current values (1), at most one statement
 * each for delete / update / insert / read-back / history, then per affected open line ONE
 * orderValuesService.materializeLine (≈ 12, whatever the number of rows) — never a row at a time.
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import { LOCKED_ORDER_STATUSES, lockedLineMessage, revisedOrderMessage, latestRevisionSql, workedOutWhy } from './records.js';
import { rawOf, displayOf, dateText } from './resolutionService.js';
import { coerce } from './valueService.js';
import { loadContext, resolveRecord, materializeLine, writeLineValues } from './orderValuesService.js';
import { loadOrderDefaultRows, missingSchema, LEVEL_WORD } from '../lib/orderDefaults.js';

const EMPTY = { value_number: null, value_text: null, value_bool: null, value_date: null, option_id: null };
const VALUE_COLS = ['value_number', 'value_text', 'value_bool', 'value_date', 'option_id', 'uom'];
const MAX_WRITES = 200;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const label = (o) => (Number(o.revision) > 1 ? `${o.code} rev ${o.revision}` : o.code);

async function loadOrder(db, companyId, orderId, { lock = false } = {}) {
  const [[o]] = await db.query(
    `SELECT o.id, o.code, o.revision, o.status, ${latestRevisionSql('o')} AS latest_revision
       FROM cf_sales_orders o WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, orderId],
  );
  if (!o) throw notFound('Sales order');
  return o;
}

/** The order's live lines with whether each is frozen. One query (FOR UPDATE on a write: value saves on a line take turns with this). */
async function loadLines(db, companyId, orderId, { lock = false } = {}) {
  const [rows] = await db.query(
    `SELECT l.id, l.line_no, l.line_type, l.item_id, l.description, l.locked_at,
            (SELECT r.id FROM cf_production_releases r
              WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_sales_order_lines l
      WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL
      ORDER BY l.line_no, l.id${lock ? ' FOR UPDATE' : ''}`,
    [companyId, orderId],
  );
  return rows.map((l) => ({
    id: l.id, lineNo: l.line_no, lineType: l.line_type, itemId: l.item_id, description: l.description ?? null,
    frozen: l.release_id ? 'released' : l.locked_at ? 'locked' : null,
  }));
}

/** The flagged specifications and their active options. Two queries; [] on a database without §65. */
export async function flaggedSpecs(db, companyId) {
  let specs;
  try {
    [specs] = await db.query(
      `SELECT id, code, name, data_type, default_uom, decimals FROM cf_specifications
        WHERE company_id = ? AND order_level = 1 AND deleted_at IS NULL AND data_type <> 'table' ORDER BY code`,
      [companyId],
    );
  } catch (err) {
    if (missingSchema(err)) return null;
    throw err;
  }
  const optionIds = specs.filter((s) => s.data_type === 'option').map((s) => s.id);
  const [options] = optionIds.length
    ? await db.query(
      `SELECT id, specification_id, value, label, status, sort_order FROM cf_spec_options
        WHERE company_id = ? AND specification_id IN (?) AND deleted_at IS NULL ORDER BY sort_order, value`,
      [companyId, optionIds])
    : [[]];
  return specs.map((s) => ({
    id: s.id, code: s.code, name: s.name, dataType: s.data_type, unit: s.default_uom ?? null, decimals: s.decimals ?? null,
    allOptions: options.filter((o) => o.specification_id === s.id),
  }));
}

/** How one stored value reads: { input, display } — `input` as a field edits it (an option's id). */
function shownValue(row, spec) {
  const shape = { dataType: spec.dataType, unit: spec.unit, decimals: spec.decimals };
  const raw = rawOf(row, spec.dataType);
  if (raw === null || raw === undefined) return null;
  const optionById = new Map((spec.allOptions ?? []).map((o) => [o.id, o]));
  const input = typeof raw === 'boolean' ? (raw ? 'true' : 'false') : String(raw);
  return { input, display: displayOf(raw, shape, optionById) };
}

/** Rows of one line: per flagged spec, how its own rows take the value. Pure, from a line context. */
function usageOfLine(ctx, specIds) {
  const out = {};
  const want = new Set(specIds);
  for (const rec of ctx.records.values()) {
    if (rec.is_deleted || rec.record_kind !== 'item' || rec.item_type !== 'temporary' || rec.owner_order_line_id !== ctx.line.id) continue;
    const r = resolveRecord(ctx, rec);
    for (const s of r.specs) {
      if (!want.has(s.spec.id) || !s.applicable || s.captureAt !== 'item' || s.spec.dataType === 'table') continue;
      if (!['entered', 'defaulted'].includes(s.rule.valueRule)) continue;
      if (!s.rule.formula && workedOutWhy(s.spec.code)) continue;
      const u = out[s.spec.code] ?? (out[s.spec.code] = { rows: 0, follow: 0, own: 0, notAllowed: 0, empty: 0 });
      u.rows += 1;
      if (s.fromOrder) u.follow += 1;
      else if (s.value?.source === 'entered') u.own += 1;
      else if (s.orderValue && !s.orderValue.allowed) u.notAllowed += 1;
      else if (!s.value) u.empty += 1;
    }
  }
  return out;
}

/**
 * GET /orders/:id/spec-defaults. `available: false` on a database without §65 (nothing to show).
 */
export async function readOrderDefaults(db, companyId, orderId, { usage = true } = {}) {
  const o = await loadOrder(db, companyId, orderId);
  const specs = await flaggedSpecs(db, companyId);
  const lines = await loadLines(db, companyId, orderId);
  const closed = LOCKED_ORDER_STATUSES.has(o.status);
  const base = {
    order: { id: o.id, code: o.code, revision: Number(o.revision ?? 1), status: o.status, label: label(o) },
    editable: !closed,
    lock: closed ? (o.status === 'revised' ? revisedOrderMessage(o.code, o.revision, o.latest_revision) : `Order ${label(o)} is ${o.status} — its values no longer change.`) : null,
  };
  if (specs === null) return { ...base, available: false, specs: [], values: {}, lines: [] };
  const rows = await loadOrderDefaultRows(db, companyId, orderId);
  const specById = new Map(specs.map((s) => [s.id, s]));
  const valuesAt = (lineId) => {
    const out = {};
    for (const r of rows) {
      if ((r.order_line_id ?? null) !== lineId) continue;
      const s = specById.get(Number(r.specification_id));
      const v = s ? shownValue(r, s) : null;
      if (v) out[s.code] = v;
    }
    return out;
  };
  const outLines = [];
  for (const l of lines) {
    const entry = {
      id: l.id, lineNo: l.lineNo, lineType: l.lineType, description: l.description, frozen: l.frozen,
      message: l.frozen === 'locked' ? lockedLineMessage(l.lineNo, label(o))
        : l.frozen === 'released' ? `Line ${l.lineNo} of ${label(o)} was released to production — its values are frozen.` : null,
      values: valuesAt(l.id),
      usage: null,
    };
    // How its rows take each value: the line's own context, worked out in memory (the Values screen's read).
    if (usage && specs.length && l.itemId && l.lineType === 'custom') {
      try { entry.usage = usageOfLine(await loadContext(db, companyId, l.id), specs.map((s) => s.id)); } catch { entry.usage = null; }
    }
    outLines.push(entry);
  }
  return {
    ...base,
    available: true,
    specs: specs.map(({ allOptions, ...s }) => ({
      ...s,
      ...(s.dataType === 'option' ? { options: allOptions.filter((x) => x.status === 'active').map((x) => ({ id: x.id, value: x.value, label: x.label })) } : {}),
    })),
    values: valuesAt(null),
    lines: outLines,
  };
}

/** One value as typed columns, against the preloaded option list (coerce's own rules, no query). */
async function coerceDefault(db, companyId, spec, value) {
  if (spec.dataType !== 'option') return coerce(db, companyId, { id: spec.id, code: spec.code, data_type: spec.dataType }, value, null);
  if (value === null || value === undefined || value === '') return { typed: null };
  const found = spec.allOptions.find((o) => o.id === Number(value))
    ?? spec.allOptions.find((o) => o.value.toLowerCase() === String(value).trim().toLowerCase());
  if (!found) return { problem: `"${value}" is not an option of ${spec.code}.` };
  if (found.status !== 'active') return { problem: `Option ${found.value} of ${spec.code} is retired.` };
  return { typed: { ...EMPTY, option_id: found.id } };
}

const sameTyped = (row, typed) => {
  const num = (x) => (x == null ? null : Number(x));
  const a = num(row.value_number); const b = num(typed.value_number);
  if ((a === null) !== (b === null) || (a !== null && Math.abs(a - b) > 1e-9)) return false;
  return (row.value_text ?? null) === (typed.value_text ?? null)
    && (row.value_bool == null ? null : Number(row.value_bool)) === (typed.value_bool == null ? null : Number(typed.value_bool))
    && dateText(row.value_date) === (typed.value_date ?? null)
    && (row.option_id ?? null) === (typed.option_id ?? null);
};
const snap = (row) => (row ? {
  number: row.value_number == null ? null : Number(row.value_number), text: row.value_text ?? null,
  bool: row.value_bool == null ? null : !!Number(row.value_bool), date: dateText(row.value_date),
  option_id: row.option_id ?? null, uom: row.uom ?? null,
} : null);

let savepointNo = 0;

/**
 * PUT /orders/:id/spec-defaults — { lineId?, dryRun?, writes: [{ specCode, value }] }. Needs a transaction.
 * All or nothing; every problem at once (422 `problems`). A dry run is the real write in a SAVEPOINT,
 * rolled back, so it says exactly what a save would change on each line.
 * -> { applied, dryRun, summary: { sentence, changed, lines: [{ lineId, lineNo, values, records } | { …, skipped }] },
 *      changes: [{ specCode, change }], linesWorked: [lineId], view }
 */
export async function writeOrderDefaults(db, c, orderId, input = {}) {
  const dryRun = input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1 || input.dryRun === '1';
  const lineId = input.lineId == null || input.lineId === '' ? null : Number(input.lineId);
  if (lineId !== null && (!Number.isInteger(lineId) || lineId <= 0)) throw invalid('INVALID', 'lineId must be a line of this order, or null for the whole order.');
  if (!Array.isArray(input.writes) || !input.writes.length) throw invalid('INVALID', 'writes must be a list of { specCode, value }.');
  if (input.writes.length > MAX_WRITES) throw invalid('INVALID', `Up to ${MAX_WRITES} values at once.`);

  const o = await loadOrder(db, c.companyId, orderId, { lock: true });
  if (LOCKED_ORDER_STATUSES.has(o.status)) {
    throw conflict('ORDER_CLOSED', o.status === 'revised' ? revisedOrderMessage(o.code, o.revision, o.latest_revision) : `Order ${label(o)} is ${o.status} — its values can no longer change.`);
  }
  const lines = await loadLines(db, c.companyId, orderId, { lock: true });
  const line = lineId !== null ? lines.find((l) => l.id === lineId) : null;
  if (lineId !== null && !line) throw invalid('NOT_THIS_ORDER', `Line #${lineId} is not a line of ${label(o)}.`);
  if (line?.frozen === 'locked') throw conflict('LOCKED', lockedLineMessage(line.lineNo, label(o)));
  if (line?.frozen === 'released') throw conflict('RELEASED', `Line ${line.lineNo} of ${label(o)} was released to production — its values are frozen.`);

  const specs = await flaggedSpecs(db, c.companyId);
  if (specs === null) throw conflict('NOT_READY', 'Order values need the database update init.sql §65 (TM/s65.sql) first.');
  const byCode = new Map(specs.map((s) => [s.code.toUpperCase(), s]));

  // ---- check everything before writing anything ----------------------------
  const problems = [];
  const plan = [];
  const seen = new Set();
  for (const [i, w] of input.writes.entries()) {
    const code = String(w?.specCode ?? '').trim().toUpperCase();
    const spec = byCode.get(code);
    if (!code) { problems.push(`Value ${i + 1}: specCode is required.`); continue; }
    if (!spec) { problems.push(`${code} cannot be set for a whole order — turn on "Can be set for a whole order" for it in Setup › Specifications first.`); continue; }
    if (seen.has(spec.id)) { problems.push(`${code} is given twice — say it once.`); continue; }
    seen.add(spec.id);
    const out = await coerceDefault(db, c.companyId, spec, w.value === undefined ? null : w.value);
    if (out.problem) { problems.push(out.problem); continue; }
    plan.push({ spec, typed: out.typed });
  }
  if (problems.length) throw invalid('INVALID', `${dryRun ? 'These values cannot be saved' : 'Nothing was saved'} — ${plural(problems.length, 'problem')} to fix first.`, { problems });

  // ---- the net change --------------------------------------------------------
  const [current] = await db.query(
    `SELECT * FROM cf_order_spec_defaults
      WHERE company_id = ? AND order_id = ? AND line_key = ? AND specification_id IN (?) AND deleted_at IS NULL`,
    [c.companyId, orderId, lineId ?? 0, plan.map((p) => p.spec.id)],
  );
  const currentOf = new Map(current.map((r) => [Number(r.specification_id), r]));
  const deletes = []; const updates = []; const inserts = []; const changes = [];
  for (const p of plan) {
    const row = currentOf.get(p.spec.id) ?? null;
    if (!p.typed) { if (row) { deletes.push({ row, p }); changes.push({ specCode: p.spec.code, change: 'cleared' }); } continue; }
    const next = { ...EMPTY, ...p.typed, uom: p.spec.unit ?? null };
    if (row && sameTyped(row, next)) continue;
    if (row) { updates.push({ row, next, p }); changes.push({ specCode: p.spec.code, change: 'changed' }); } else { inserts.push({ next, p }); changes.push({ specCode: p.spec.code, change: 'set' }); }
  }

  const where = line ? `line ${line.lineNo}` : 'the whole order';
  if (!changes.length) {
    return { applied: !dryRun, dryRun, summary: { sentence: `Nothing changed — ${where} already has these values.`, changed: 0, lines: [] }, changes, linesWorked: [], view: await readOrderDefaults(db, c.companyId, orderId) };
  }

  const sp = `cf_order_defaults_${savepointNo += 1}`;
  await db.query(`SAVEPOINT ${sp}`);
  let lineResults = [];
  try {
    const history = [];
    if (deletes.length) {
      await db.query('UPDATE cf_order_spec_defaults SET deleted_at = NOW(), updated_by = ? WHERE company_id = ? AND id IN (?)', [c.userId ?? null, c.companyId, deletes.map((d) => d.row.id)]);
      for (const d of deletes) history.push({ id: d.row.id, specId: d.p.spec.id, type: 'delete', before: snap(d.row), after: null });
    }
    if (updates.length) {
      const params = [];
      const sets = VALUE_COLS.map((col) => `${col} = CASE id ${updates.map((u) => { params.push(u.row.id, u.next[col] ?? null); return 'WHEN ? THEN ?'; }).join(' ')} END`).join(', ');
      params.push(c.userId ?? null, c.companyId, updates.map((u) => u.row.id));
      await db.query(`UPDATE cf_order_spec_defaults SET ${sets}, updated_by = ? WHERE company_id = ? AND id IN (?)`, params);
      for (const u of updates) history.push({ id: u.row.id, specId: u.p.spec.id, type: 'update', before: snap(u.row), after: snap(u.next) });
    }
    if (inserts.length) {
      const params = [];
      for (const ins of inserts) {
        params.push(c.companyId, orderId, lineId, ins.p.spec.id, ...VALUE_COLS.map((col) => ins.next[col] ?? null), c.userId ?? null);
      }
      await db.query(
        `INSERT INTO cf_order_spec_defaults (company_id, order_id, order_line_id, specification_id, ${VALUE_COLS.join(', ')}, created_by)
         VALUES ${inserts.map(() => `(${new Array(5 + VALUE_COLS.length).fill('?').join(', ')})`).join(', ')}`,
        params,
      );
      // The new ids by natural key (TiDB does not hand out AUTO_INCREMENT contiguously).
      const [back] = await db.query(
        `SELECT id, specification_id FROM cf_order_spec_defaults
          WHERE company_id = ? AND order_id = ? AND line_key = ? AND specification_id IN (?) AND deleted_at IS NULL`,
        [c.companyId, orderId, lineId ?? 0, inserts.map((x) => x.p.spec.id)],
      );
      const idOf = new Map(back.map((r) => [Number(r.specification_id), r.id]));
      for (const ins of inserts) history.push({ id: idOf.get(ins.p.spec.id), specId: ins.p.spec.id, type: 'create', before: null, after: snap(ins.next) });
    }
    const hp = [];
    for (const h of history) hp.push(c.companyId, h.id, orderId, lineId, h.specId, h.type, h.before ? JSON.stringify(h.before) : null, h.after ? JSON.stringify(h.after) : null, c.userId ?? null);
    await db.query(
      `INSERT INTO cf_order_spec_default_history (company_id, default_id, order_id, order_line_id, specification_id, change_type, old_value, new_value, changed_by)
       VALUES ${history.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      hp,
    );

    // ---- every open line it reaches: its rows take the new values now ----------------
    // A locked or released line is left exactly as it locked (frozenBy) — said in the answer.
    const reach = line ? [line] : lines;
    for (const l of reach) {
      if (l.lineType !== 'custom' || !l.itemId) continue;
      if (l.frozen) { lineResults.push({ lineId: l.id, lineNo: l.lineNo, skipped: l.frozen }); continue; }
      const m = await materializeLine(db, c, l.id);
      lineResults.push({ lineId: l.id, lineNo: l.lineNo, values: m.values, records: m.records });
    }
    if (dryRun) await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  } catch (err) {
    try { await db.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch { /* the original error matters */ }
    throw err;
  }

  const worked = lineResults.filter((l) => !l.skipped);
  const frozenLines = lineResults.filter((l) => l.skipped);
  const values = worked.reduce((n, l) => n + l.values, 0);
  const sentence = `${plural(changes.length, 'value')} of ${where} ${dryRun ? 'would be saved' : 'saved'}`
    + (worked.length ? `; ${plural(values, 'row value')} ${dryRun ? 'would follow' : 'followed'} on ${plural(worked.length, 'line')}` : '')
    + (frozenLines.length ? `. ${frozenLines.length === 1 ? 'Line' : 'Lines'} ${frozenLines.map((l) => l.lineNo).join(', ')} ${frozenLines.length === 1 ? 'is' : 'are'} locked — ${frozenLines.length === 1 ? 'it keeps' : 'they keep'} the values ${frozenLines.length === 1 ? 'it' : 'they'} locked with` : '')
    + '.';
  return {
    applied: !dryRun,
    dryRun,
    summary: { sentence, changed: changes.length, level: line ? LEVEL_WORD.line : LEVEL_WORD.order, lines: lineResults },
    changes,
    linesWorked: dryRun ? [] : worked.map((l) => l.lineId),
    view: await readOrderDefaults(db, c.companyId, orderId),
  };
}

/**
 * A new revision of an order takes its order and line values with it (revisionService.reviseOrder):
 * each line value goes to the line that revises it. Two statements (copy, history); nothing on a
 * database without §65. Returns how many values were copied.
 */
export async function copyOrderDefaults(db, c, fromOrderId, toOrderId) {
  try {
    const [ins] = await db.query(
      `INSERT INTO cf_order_spec_defaults (company_id, order_id, order_line_id, specification_id, ${VALUE_COLS.join(', ')}, created_by)
       SELECT d.company_id, ?, nl.id, d.specification_id, ${VALUE_COLS.map((col) => `d.${col}`).join(', ')}, ?
         FROM cf_order_spec_defaults d
         LEFT JOIN cf_sales_order_lines nl
           ON nl.company_id = d.company_id AND nl.order_id = ? AND nl.revises_line_id = d.order_line_id AND nl.deleted_at IS NULL
        WHERE d.company_id = ? AND d.order_id = ? AND d.deleted_at IS NULL
          AND (d.order_line_id IS NULL OR nl.id IS NOT NULL)`,
      [toOrderId, c.userId ?? null, toOrderId, c.companyId, fromOrderId],
    );
    if (!ins.affectedRows) return 0;
    await db.query(
      `INSERT INTO cf_order_spec_default_history (company_id, default_id, order_id, order_line_id, specification_id, change_type, old_value, new_value, note, changed_by)
       SELECT d.company_id, d.id, d.order_id, d.order_line_id, d.specification_id, 'create', NULL,
              JSON_OBJECT('number', d.value_number, 'text', d.value_text, 'bool', d.value_bool, 'date', d.value_date, 'option_id', d.option_id, 'uom', d.uom),
              ?, ?
         FROM cf_order_spec_defaults d
        WHERE d.company_id = ? AND d.order_id = ? AND d.deleted_at IS NULL`,
      [`copied from the earlier revision (order #${fromOrderId})`, c.userId ?? null, c.companyId, toOrderId],
    );
    return ins.affectedRows;
  } catch (err) {
    if (missingSchema(err)) return 0;
    throw err;
  }
}

/* ===========================================================================
 * A ONE-OFF for orders made before order values existed (scripts/cf_kepl/order-defaults-propose.mjs).
 * Nothing here runs on its own: existing orders are never changed silently.
 * ======================================================================== */

/**
 * What an order's rows say today, and the order values that would say the same with fewer entries:
 * for each specification, the most common value typed on its rows becomes the proposed ORDER value, and
 * the rows typed with exactly that value are the entries that would be taken away (they then take it
 * from the order — nothing they read changes). Rows typed differently keep their entry as an override.
 * Read-only. `specCodes` looks at those specifications whether or not they are flagged yet (a dry run
 * before Setup is changed); the default is the flagged ones. One line context per custom line.
 * -> { order, lines: [{ id, lineNo, frozen }], proposals: [{ code, name, dataType, value: { input, display } | null,
 *      rows, typedSame, typedOther, empty, fromOrder, others: [{ display, n }], perLine: { [lineNo]: {…} }, clear: { [lineId]: [recordId] } }] }
 */
export async function proposeOrderDefaults(db, companyId, orderId, { specCodes = null } = {}) {
  const o = await loadOrder(db, companyId, orderId);
  const lines = await loadLines(db, companyId, orderId);
  let specs;
  if (specCodes?.length) {
    const [rows] = await db.query(
      `SELECT id, code, name, data_type, default_uom, decimals FROM cf_specifications
        WHERE company_id = ? AND code IN (?) AND deleted_at IS NULL AND data_type <> 'table' ORDER BY code`,
      [companyId, specCodes.map((x) => String(x).trim().toUpperCase())],
    );
    const [opts] = rows.length ? await db.query('SELECT id, specification_id, value, label, status, sort_order FROM cf_spec_options WHERE company_id = ? AND specification_id IN (?) AND deleted_at IS NULL', [companyId, rows.map((r) => r.id)]) : [[]];
    specs = rows.map((s) => ({ id: s.id, code: s.code, name: s.name, dataType: s.data_type, unit: s.default_uom ?? null, decimals: s.decimals ?? null, allOptions: opts.filter((x) => x.specification_id === s.id) }));
  } else specs = (await flaggedSpecs(db, companyId)) ?? [];
  const byId = new Map(specs.map((s) => [s.id, s]));
  const tally = new Map(specs.map((s) => [s.id, { values: new Map(), rows: 0, empty: 0, fromOrder: 0, perLine: {}, typed: [] }]));
  const outLines = [];
  for (const l of lines) {
    outLines.push({ id: l.id, lineNo: l.lineNo, frozen: l.frozen });
    if (l.lineType !== 'custom' || !l.itemId) continue;
    const ctx = await loadContext(db, companyId, l.id);
    for (const rec of ctx.records.values()) {
      if (rec.is_deleted || rec.record_kind !== 'item' || rec.item_type !== 'temporary' || rec.owner_order_line_id !== l.id) continue;
      for (const s of resolveRecord(ctx, rec).specs) {
        const t = tally.get(s.spec.id);
        if (!t || !s.applicable || s.captureAt !== 'item' || !['entered', 'defaulted'].includes(s.rule.valueRule)) continue;
        const pl = t.perLine[l.lineNo] ?? (t.perLine[l.lineNo] = { rows: 0, typed: 0, empty: 0, fromOrder: 0, frozen: l.frozen });
        t.rows += 1; pl.rows += 1;
        if (s.fromOrder) { t.fromOrder += 1; pl.fromOrder += 1; continue; }
        if (s.value?.source !== 'entered') { if (!s.value) { t.empty += 1; pl.empty += 1; } continue; }
        // Frozen rows show only what they hold: an `entered` row there is a typed value too.
        const key = String(s.value.raw);
        const v = t.values.get(key) ?? { raw: s.value.raw, display: s.value.display, n: 0 };
        v.n += 1; t.values.set(key, v);
        pl.typed += 1;
        t.typed.push({ lineId: l.id, frozen: l.frozen, recordId: rec.id, key });
      }
    }
  }
  const proposals = [];
  for (const [specId, t] of tally) {
    const s = byId.get(specId);
    const ranked = [...t.values.values()].sort((a, b) => b.n - a.n);
    const best = ranked[0] ?? null;
    const clear = {};
    let same = 0;
    if (best) {
      for (const x of t.typed) {
        if (x.key !== String(best.raw)) continue;
        same += 1;
        if (x.frozen) continue;   // a locked line keeps its rows exactly as they are
        (clear[x.lineId] ?? (clear[x.lineId] = [])).push(x.recordId);
      }
    }
    proposals.push({
      code: s.code, name: s.name, dataType: s.dataType,
      value: best ? { input: typeof best.raw === 'boolean' ? String(best.raw) : String(best.raw), display: best.display } : null,
      rows: t.rows, typedSame: same, typedOther: t.typed.length - same, empty: t.empty, fromOrder: t.fromOrder,
      others: ranked.slice(1).map((v) => ({ display: v.display, n: v.n })),
      perLine: t.perLine, clear,
    });
  }
  return { order: { id: o.id, code: o.code, revision: Number(o.revision ?? 1), status: o.status, label: label(o) }, lines: outLines, proposals };
}

/**
 * Applies a proposal (proposeOrderDefaults): the ORDER values first, then on each open line the row
 * entries equal to them are taken away in one Values save (orderValuesService.writeLineValues) — so each
 * row reads exactly what it read before. Needs a transaction. Only flagged specifications are applied.
 */
export async function applyOrderDefaultsProposal(db, c, orderId, proposal) {
  const flagged = new Set(((await flaggedSpecs(db, c.companyId)) ?? []).map((s) => s.code));
  const take = proposal.proposals.filter((p) => p.value && flagged.has(p.code));
  if (!take.length) return { order: null, lines: [] };
  const order = await writeOrderDefaults(db, c, orderId, { writes: take.map((p) => ({ specCode: p.code, value: p.value.input })) });
  const perLine = new Map();
  for (const p of take) {
    for (const [lineId, ids] of Object.entries(p.clear)) {
      const list = perLine.get(Number(lineId)) ?? [];
      for (const recordId of ids) list.push({ recordId, specCode: p.code, value: null });
      perLine.set(Number(lineId), list);
    }
  }
  const lines = [];
  for (const [lineId, writes] of perLine) {
    const out = await writeLineValues(db, c, lineId, { writes });
    lines.push({ lineId, cleared: out.summary.changed, sentence: out.summary.sentence });
  }
  return { order: order.summary, lines };
}
