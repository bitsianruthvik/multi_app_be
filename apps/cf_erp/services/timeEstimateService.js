/**
 * timeEstimateService.js — how long each row of an order line takes at each
 * operation of its flow, and the times a person typed over (cf_time_overrides,
 * init.sql §30). The Times tab of the order's Production stage is built on it,
 * and release copies the same numbers onto the production steps (est_*).
 *
 *   GET /orders/:o/lines/:l/times   -> the grid: rows = the line's BOM tree,
 *                                      columns = the operations of the rows' flows
 *   PUT /orders/:o/lines/:l/times   { cells: [{ bomLineId|null, operationId, work?, setup?, note? }] }
 *
 * A TIME IS WORK MINUTES PER PIECE (the user took this, 2026-09-29). Setup is
 * once per run and stays with the formula; it can be typed over only in the
 * grid's "Show setup" view. null clears an override and the formula's number
 * comes back.
 *
 * WHICH MACHINE AN ESTIMATE READS (decision 3). Before release nobody has
 * picked a machine, so the estimate uses the machine TYPE's rate chart: the
 * rule that applies to the type (cf_operation_machine_rules on a classification
 * node) fed the type's own specification values. Where the type carries no
 * chart and only single machines do, every eligible machine of the type is
 * worked out and the SLOWEST is taken — cautious, never optimistic. Several
 * eligible types: the slowest of them. The cell names what it used (`machine`,
 * and `machineInfo` with the basis), and when an input is missing it says what
 * in plain words (`missing`) — never an invented number.
 *
 * ONE COMPUTATION. The arithmetic is operationService.evaluateRuleTimes — the
 * same function timingPreview (the machine screen's "time this") uses. What is
 * new here is doing it for every (row, operation) of a line at once:
 *
 *   item values     orderValuesService.resolveLineRecords — the Values stage's
 *                   bulk mirror of resolve(), every record of the line in one load
 *   machine side    operationService.loadTimingSetup (rules, machines, tree:
 *                   three reads) + the machine types' and machines' spec rules
 *                   and values (two reads)
 *
 * Machine values are read the way resolve() reads a machine (item mode) or a
 * machine type (setup mode): the most specific rule of each specification wins;
 * entered = the machine's own value, defaulted = its own entered value else the
 * nearest above, fixed = the nearest above; a type reads its own value else the
 * nearest above. A CALCULATED machine specification is not worked out here —
 * none exists today; one would read as missing, not as a wrong number.
 *
 * ROUND TRIPS (GET): line 1 · explode 2 + one a level · flow steps 1 ·
 * overrides 1 · item values 6 · machine side 5. About 25 for the KEPL line
 * whatever its size; PUT adds a FOR UPDATE and at most three writes.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { LOCKED_ORDER_STATUSES, revisedOrderMessage, latestRevisionSql } from './records.js';
import { explode } from './bomService.js';
import { resolveLineRecords } from './orderValuesService.js';
import { effectiveByCode, levelsOfResolution, parseJsonCol } from './resolutionService.js';
import { loadTimingSetup, evaluateRuleTimes, valueReaders } from './operationService.js';

const round3 = (n) => (n == null ? null : Number(Number(n).toFixed(3)));
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const MAX_CELLS = 5000;
const NOTE_MAX = 300;
export const RELEASED_WHY = 'Times are fixed at release — they are on the production steps now.';

/* ===========================================================================
 * The line, addressed through its order
 * ======================================================================== */

/**
 * The order line with what every guard here reads: its order's status and
 * revision, whether it is locked, whether it is released. /orders/7/lines/99
 * must not quietly serve line 99 of order 3, so the pair is checked.
 */
export async function lineOnOrder(db, companyId, orderId, lineId, { lock = false } = {}) {
  const [[row]] = await db.query(
    `SELECT ol.id, ol.order_id, ol.line_no, ol.line_type, ol.item_id, ol.quantity, ol.locked_at,
            o.code AS order_code, o.status AS order_status, o.revision AS order_revision,
            IF(o.status = 'revised', ${latestRevisionSql('o')}, NULL) AS order_latest_revision,
            (SELECT r.id FROM cf_production_releases r
              WHERE r.company_id = ol.company_id AND r.order_line_id = ol.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_sales_order_lines ol
       JOIN cf_sales_orders o ON o.company_id = ol.company_id AND o.id = ol.order_id AND o.deleted_at IS NULL
      WHERE ol.company_id = ? AND ol.id = ? AND ol.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, lineId],
  );
  if (!row) throw notFound('Order line');
  if (orderId != null && Number(orderId) !== Number(row.order_id)) {
    throw invalid('WRONG_ORDER', `Line ${row.line_no} is not on order ${orderId} — it is on ${row.order_code}.`);
  }
  return row;
}

/** Why an order's line takes no more changes of any kind, or null. */
export function orderClosedWhy(line) {
  if (line.order_status === 'revised') return revisedOrderMessage(line.order_code, line.order_revision, line.order_latest_revision);
  if (LOCKED_ORDER_STATUSES.has(line.order_status)) return `Order ${line.order_code} is ${line.order_status} — nothing more is recorded on it.`;
  return null;
}

/* ===========================================================================
 * The machine side: which machine (type) an estimate reads
 * ======================================================================== */

const subjectKey = (type, id) => `${type}:${id}`;

/**
 * Everything machine-related for a set of operations, loaded once. Returns
 * estimate(operationId, itemReaders) — { setup, work, machine, machineInfo,
 * missing } — which is pure memory from then on.
 */
export async function loadMachineSide(db, companyId, operations, date) {
  const opIds = [...operations.keys()];
  const setup = await loadTimingSetup(db, companyId, opIds, date);

  // Per operation: the eligible machines, grouped by machine type (the node a
  // machine is filed under), and the rule that applies to each type itself.
  const perOp = new Map();
  const typeIds = new Set();
  const machineIds = new Set();
  for (const opId of opIds) {
    if (!setup.rulesByOp.has(opId)) { perOp.set(opId, null); continue; }
    const types = new Map();
    for (const m of setup.machines) {
      const rule = setup.winning(opId, setup.rankOfMachine(m));
      if (!rule || !rule.eligible) continue;
      if (!types.has(m.classification_id)) types.set(m.classification_id, { nodeId: m.classification_id, machines: [] });
      types.get(m.classification_id).machines.push({ machine: m, rule });
      machineIds.add(m.id);
    }
    for (const t of types.values()) {
      t.rule = setup.winning(opId, setup.rankOfNode(t.nodeId));
      typeIds.add(t.nodeId);
    }
    perOp.set(opId, [...types.values()].sort((a, b) => a.nodeId - b.nodeId));
  }

  // The spec rules and values on every subject those chains touch: two reads.
  const clsIds = new Set();
  for (const t of typeIds) for (const key of setup.rankOfNode(t).keys()) clsIds.add(Number(key.split(':')[1]));
  const scope = (alias) => {
    const parts = [];
    const params = [];
    if (clsIds.size) { parts.push(`(${alias}.subject_type = 'classification' AND ${alias}.subject_id IN (?))`); params.push([...clsIds]); }
    if (machineIds.size) { parts.push(`(${alias}.subject_type = 'machine' AND ${alias}.subject_id IN (?))`); params.push([...machineIds]); }
    return { sql: parts.join(' OR '), params };
  };
  const rulesAt = new Map();   // subject -> specId -> rule (capture item only)
  const valuesAt = new Map();  // subject -> specId -> value row
  if (clsIds.size || machineIds.size) {
    const sa = scope('a');
    const sv = scope('v');
    const [[ruleRows], [valueRows]] = await Promise.all([
      db.query(
        `SELECT a.specification_id, a.subject_type, a.subject_id, a.is_applicable, a.value_rule,
                s.code AS spec_code, s.data_type, s.table_config
           FROM cf_spec_assignments a
           JOIN cf_specifications s ON s.id = a.specification_id AND s.deleted_at IS NULL
          WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.capture_at = 'item' AND (${sa.sql})`,
        [companyId, ...sa.params],
      ),
      db.query(
        `SELECT v.specification_id, v.subject_type, v.subject_id, v.value_number, v.value_json, v.source
           FROM cf_spec_values v
           JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
          WHERE v.company_id = ? AND v.deleted_at IS NULL AND (${sv.sql})`,
        [companyId, ...sv.params],
      ),
    ]);
    for (const r of ruleRows) {
      const k = subjectKey(r.subject_type, r.subject_id);
      if (!rulesAt.has(k)) rulesAt.set(k, new Map());
      rulesAt.get(k).set(r.specification_id, r);
    }
    for (const v of valueRows) {
      const k = subjectKey(v.subject_type, v.subject_id);
      if (!valuesAt.has(k)) valuesAt.set(k, new Map());
      valuesAt.get(k).set(v.specification_id, v);
    }
  }

  // A chain, broadest first: the type's branch of the tree, then (for a machine) the machine.
  const chainOfNode = (nodeId) => [...setup.rankOfNode(nodeId).entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const rawOf = (row, dataType) => {
    if (!row) return null;
    if (dataType === 'number') return row.value_number == null ? null : Number(row.value_number);
    if (dataType === 'table') return row.value_json == null ? null : parseJsonCol(row.value_json);
    return null; // timing formulas read numbers and charts only
  };
  /** code -> { raw, dataType, tableConfig } for a chain, the way resolve() gives a machine (self = last) or a type (setup mode). */
  const valuesOfChain = (chain, selfIsMachine) => {
    const merged = new Map(); // specId -> { rule, level }
    chain.forEach((k, level) => {
      for (const [specId, r] of rulesAt.get(k) ?? []) merged.set(specId, { rule: r, level });
    });
    const out = new Map();
    const selfIndex = chain.length - 1;
    for (const [specId, { rule }] of merged) {
      if (!rule.is_applicable) continue;
      if (!['number', 'table'].includes(rule.data_type)) continue;
      const own = valuesAt.get(chain[selfIndex])?.get(specId) ?? null;
      let above = null;
      for (let i = selfIndex - 1; i >= 0 && !above; i--) above = valuesAt.get(chain[i])?.get(specId) ?? null;
      let row = null;
      if (!selfIsMachine) {
        // setup mode (a machine type): computed rules are worked out on machines, not here
        if (!['calculated', 'rollup', 'inherited'].includes(rule.value_rule)) row = own ?? above;
      } else if (rule.value_rule === 'entered') row = own;
      else if (rule.value_rule === 'defaulted') row = own && own.source === 'entered' ? own : above;
      else if (rule.value_rule === 'fixed') row = above;
      const raw = rawOf(row, rule.data_type);
      if (raw == null) continue;
      out.set(rule.spec_code, { raw, dataType: rule.data_type, tableConfig: rule.data_type === 'table' ? parseJsonCol(rule.table_config) : null });
    }
    return out;
  };
  const typeReaders = new Map();
  const readersOfType = (nodeId) => {
    if (!typeReaders.has(nodeId)) typeReaders.set(nodeId, valueReaders(valuesOfChain(chainOfNode(nodeId), false)));
    return typeReaders.get(nodeId);
  };
  const machineReaders = new Map();
  const readersOfMachine = (m) => {
    if (!machineReaders.has(m.id)) machineReaders.set(m.id, valueReaders(valuesOfChain([...chainOfNode(m.classification_id), subjectKey('machine', m.id)], true)));
    return machineReaders.get(m.id);
  };

  const reasonOf = (r, op) => {
    const bad = r.work.minutes == null ? r.work : r.setup;
    if (bad.missing?.length) return `Needs ${bad.missing.join(', ')}.`;
    if (bad.error === 'The rule sets no work time.') return `The machine rule for ${op.code} sets no work time yet.`;
    return `The formula ${bad.formula ?? ''} cannot be worked out: ${bad.error ?? 'no result'}.`.replace('  ', ' ');
  };

  /** The estimate for one operation on one item (itemReaders from valueReaders, or null). */
  function estimate(opId, item) {
    const op = operations.get(opId) ?? { code: String(opId) };
    const types = perOp.get(opId);
    if (!types) return { setup: null, work: null, machine: null, machineInfo: null, missing: `No machine can do ${op.code} — there is no machine rule for it.` };
    if (!types.length) return { setup: null, work: null, machine: null, machineInfo: null, missing: `No active machine is eligible for ${op.code}.` };
    const candidates = [];
    let problem = null;
    for (const t of types) {
      if (t.rule && t.rule.eligible) {
        const r = evaluateRuleTimes(t.rule, { item, machine: readersOfType(t.nodeId) });
        if (r.work.minutes != null && r.setup.minutes != null) {
          const n = setup.nodesById.get(t.nodeId);
          candidates.push({ basis: 'type', id: t.nodeId, code: n?.code ?? null, name: n?.name ?? null, setup: r.setup.minutes, work: r.work.minutes });
          continue;
        }
        problem ??= r;
      }
      // The type's chart could not answer: the slowest single machine that can.
      for (const { machine: m, rule } of t.machines) {
        const r = evaluateRuleTimes(rule, { item, machine: readersOfMachine(m) });
        if (r.work.minutes != null && r.setup.minutes != null) candidates.push({ basis: 'machine', id: m.id, code: m.code, name: m.name, setup: r.setup.minutes, work: r.work.minutes });
        else problem ??= r;
      }
    }
    if (!candidates.length) return { setup: null, work: null, machine: null, machineInfo: null, missing: problem ? reasonOf(problem, op) : `No machine can do ${op.code}.` };
    candidates.sort((a, b) => b.work - a.work || b.setup - a.setup || String(a.code).localeCompare(String(b.code)));
    const c = candidates[0];
    const label = c.basis === 'type' ? `${c.name ?? c.code} (machine type)` : `${c.code}${c.name && c.name !== c.code ? ` ${c.name}` : ''} (slowest machine)`;
    return {
      setup: round3(c.setup), work: round3(c.work), machine: label,
      machineInfo: { basis: c.basis, id: c.id, code: c.code, name: c.name }, missing: null,
    };
  }
  return { estimate };
}

/* ===========================================================================
 * The line's rows, flows and overrides
 * ======================================================================== */

/** The steps of these flows, in order, with their operations. One read. */
export async function flowSteps(db, companyId, flowIds) {
  const out = new Map();
  if (!flowIds.length) return out;
  const [rows] = await db.query(
    `SELECT s.flow_id, s.sequence, s.id, s.operation_id, o.code AS op_code, o.name AS op_name
       FROM cf_operation_flow_steps s JOIN cf_operations o ON o.id = s.operation_id
      WHERE s.company_id = ? AND s.flow_id IN (?) AND s.deleted_at IS NULL ORDER BY s.flow_id, s.sequence, s.id`,
    [companyId, flowIds],
  );
  for (const r of rows) {
    if (!out.has(r.flow_id)) out.set(r.flow_id, []);
    out.get(r.flow_id).push(r);
  }
  return out;
}

/** An operation run several times by one flow (weld, turn, weld) is one column: its passes counted. */
export function opsOfFlow(steps) {
  const ops = new Map();
  for (const s of steps ?? []) {
    const o = ops.get(s.operation_id);
    if (o) o.passes += 1;
    // seq: where the operation first comes in the flow — the planner books a unit's work in this order.
    else ops.set(s.operation_id, { id: s.operation_id, code: s.op_code, name: s.op_name, passes: 1, seq: Number(s.sequence ?? 0) });
  }
  return ops;
}

async function loadOverrides(db, companyId, lineId, { lock = false } = {}) {
  const [rows] = await db.query(
    `SELECT id, bom_line_id, operation_id, work_minutes, setup_minutes, note FROM cf_time_overrides
      WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, lineId],
  );
  const out = new Map();
  for (const r of rows) {
    out.set(`${r.bom_line_id ?? 0}:${r.operation_id}`, {
      id: r.id, bomLineId: r.bom_line_id, operationId: r.operation_id,
      work: r.work_minutes == null ? null : Number(r.work_minutes),
      setup: r.setup_minutes == null ? null : Number(r.setup_minutes),
      note: r.note ?? null,
    });
  }
  return out;
}

/** item id -> valueReaders of its effective values, from the Values stage's one-load mirror. */
async function itemReadersOf(db, companyId, lineId) {
  const resolutions = await resolveLineRecords(db, companyId, lineId);
  const readers = new Map();
  return (itemId) => {
    if (!readers.has(itemId)) {
      const r = resolutions.get(itemId);
      readers.set(itemId, r ? valueReaders(effectiveByCode(r), levelsOfResolution(r)) : null);
    }
    return readers.get(itemId);
  };
}

/**
 * Formula estimates for (item, operation) pairs of one line, with the line's
 * overrides laid over them. `pairs` = [{ bomLineId|null, itemId, operationId }].
 * Returns a function (bomLineId, itemId, operationId) -> the cell's numbers.
 * This is what release uses to fill est_* on the steps, and what the grid shows.
 */
export async function estimatorForLine(db, companyId, lineId, pairs, { date, overrides = null, operations = null } = {}) {
  const ops = operations ?? new Map();
  if (!operations) {
    const ids = [...new Set(pairs.map((p) => p.operationId))];
    if (ids.length) {
      const [rows] = await db.query('SELECT id, code, name FROM cf_operations WHERE company_id = ? AND id IN (?)', [companyId, ids]);
      for (const r of rows) ops.set(r.id, { id: r.id, code: r.code, name: r.name });
    }
  }
  const over = overrides ?? await loadOverrides(db, companyId, lineId);
  if (!pairs.length) return () => null;
  const itemReaders = await itemReadersOf(db, companyId, lineId);
  const { estimate } = await loadMachineSide(db, companyId, ops, date);
  const memo = new Map();
  return (bomLineId, itemId, operationId) => {
    const mk = `${itemId}:${operationId}`;
    if (!memo.has(mk)) memo.set(mk, estimate(operationId, itemReaders(itemId)));
    const f = memo.get(mk);
    const o = over.get(`${bomLineId ?? 0}:${operationId}`) ?? null;
    return {
      work: o?.work != null ? o.work : f.work,
      setup: o?.setup != null ? o.setup : f.setup,
      formulaWork: f.work,
      formulaSetup: f.setup,
      overridden: o?.work != null,
      setupOverridden: o?.setup != null,
      machine: f.machine,
      machineInfo: f.machineInfo,
      missing: o?.work != null ? null : f.missing,
      note: o?.note ?? null,
    };
  };
}

/* ===========================================================================
 * The grid
 * ======================================================================== */

async function loadTimesContext(db, companyId, orderId, lineId, { lock = false, date = undefined } = {}) {
  const line = await lineOnOrder(db, companyId, orderId, lineId, { lock });
  const closedWhy = orderClosedWhy(line);
  const why = line.release_id ? RELEASED_WHY : closedWhy ?? (!line.item_id ? 'This line has no item yet.' : null);
  const ctx = { line, why, rows: [], overrides: new Map(), flowOps: new Map(), cellAt: () => null };
  if (!line.item_id) return ctx;

  const tree = await explode(db, companyId, line.item_id, { rootQuantity: Number(line.quantity), maxDepth: 15 });
  // Rows in the order the tree shows them: line number, then line id.
  const rows = [];
  const walk = (n, parentKey) => {
    rows.push({ node: n, parentKey });
    const kids = [...n.children].sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0) || (a.lineId ?? 0) - (b.lineId ?? 0));
    for (const k of kids) walk(k, n.key);
  };
  walk(tree.root, null);
  ctx.rows = rows;
  ctx.truncated = tree.truncated;

  const flows = await flowSteps(db, companyId, [...new Set(rows.map((r) => r.node.flow?.id).filter(Boolean))]);
  for (const [flowId, steps] of flows) ctx.flowOps.set(flowId, opsOfFlow(steps));
  const operations = new Map();
  for (const ops of ctx.flowOps.values()) for (const o of ops.values()) if (!operations.has(o.id)) operations.set(o.id, o);
  ctx.operations = operations;

  ctx.overrides = await loadOverrides(db, companyId, line.id, { lock });
  const pairs = [];
  for (const { node } of rows) {
    for (const o of ctx.flowOps.get(node.flow?.id)?.values() ?? []) pairs.push({ bomLineId: node.lineId, itemId: node.id, operationId: o.id });
  }
  const estimator = await estimatorForLine(db, companyId, line.id, pairs, { date, overrides: ctx.overrides, operations });
  ctx.estimator = estimator;
  return ctx;
}

function buildTimesView(ctx) {
  const { line } = ctx;
  const released = !!line.release_id;
  const out = {
    line: { id: line.id, lineNo: line.line_no, released, editable: !ctx.why },
    operations: [],
    rows: [],
    totals: { byOperation: {}, all: 0 },
  };
  if (ctx.why) out.line.why = ctx.why;
  if (ctx.truncated) out.line.truncated = true;
  // Columns: the union of the rows' flows, in flow order — each flow's
  // operations in its own order, a new one placed after the last one already seen.
  const order = [];
  const seen = new Set();
  for (const { node } of ctx.rows) {
    const ops = ctx.flowOps.get(node.flow?.id);
    if (!ops) continue;
    let at = -1;
    for (const o of ops.values()) {
      if (seen.has(o.id)) { at = Math.max(at, order.indexOf(o.id)); continue; }
      order.splice(at + 1, 0, o.id);
      seen.add(o.id);
      at += 1;
    }
  }
  out.operations = order.map((id) => {
    const o = ctx.operations.get(id);
    return { id: o.id, code: o.code, name: o.name };
  });
  let all = 0;
  const byOp = {};
  for (const { node, parentKey } of ctx.rows) {
    const cells = {};
    for (const o of ctx.flowOps.get(node.flow?.id)?.values() ?? []) {
      const c = ctx.estimator(node.lineId, node.id, o.id);
      cells[o.id] = { ...c, passes: o.passes };
      if (c.work != null) {
        const minutes = ((c.setup ?? 0) + c.work * Number(node.total)) * o.passes;
        byOp[o.id] = (byOp[o.id] ?? 0) + minutes;
        all += minutes;
      }
    }
    out.rows.push({
      key: node.key,
      bomLineId: node.lineId ?? null,
      // The item this row is (the line's own item for the root): rows sharing it are the same thing.
      itemId: node.id ?? null,
      parentKey,
      depth: node.depth,
      name: node.name,
      // A row of the order is a design and has no code (AGENTS.md §7).
      code: node.kind === 'temporary' ? null : node.code ?? null,
      qtyPerParent: Number(node.quantity),
      totalQty: Number(node.total),
      flowName: node.flow?.name ?? null,
      cells,
    });
  }
  for (const [k, v] of Object.entries(byOp)) out.totals.byOperation[k] = round3(v);
  out.totals.all = round3(all);
  return out;
}

export async function getLineTimes(db, companyId, orderId, lineId, { date } = {}) {
  return buildTimesView(await loadTimesContext(db, companyId, orderId, lineId, { date }));
}

/** A number of minutes from the request: undefined = leave, null / '' = clear. */
function readMinutes(raw, label, problems) {
  if (raw === undefined) return undefined;
  if (blank(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) { problems.push(`${label} is not a number.`); return undefined; }
  if (n < 0) { problems.push(`${label} cannot be negative.`); return undefined; }
  if (n > 1e8) { problems.push(`${label} is too large.`); return undefined; }
  return Number(n.toFixed(3));
}

/**
 * Writes typed times (and clears them) in one go, all or nothing: every
 * problem is reported at once, and nothing is written unless all cells pass.
 */
export async function setLineTimes(db, c, orderId, lineId, input = {}) {
  const cells = Array.isArray(input.cells) ? input.cells : null;
  if (!cells) throw invalid('INVALID', 'Send the cells to change: { cells: [{ bomLineId, operationId, work?, setup? }] }.');
  if (cells.length > MAX_CELLS) throw invalid('TOO_MANY', `At most ${MAX_CELLS} cells in one save.`);
  const ctx = await loadTimesContext(db, c.companyId, orderId, lineId, { lock: true });
  if (ctx.line.release_id) throw invalid('RELEASED', `${RELEASED_WHY}`);
  if (ctx.why) throw invalid('READ_ONLY', ctx.why);

  // Which operations each row's flow has. A row reached through several parents
  // (a shared cut plate) is one row of the BOM: the same flow either way.
  const flowOfBomLine = new Map();
  for (const { node } of ctx.rows) {
    const k = node.lineId ?? 0;
    if (!flowOfBomLine.has(k)) flowOfBomLine.set(k, { node, ops: ctx.flowOps.get(node.flow?.id) ?? new Map() });
  }
  const problems = [];
  const want = new Map(); // key -> { bomLineId, operationId, work?, setup?, note? }
  cells.forEach((cell, i) => {
    const where = `Cell ${i + 1}`;
    const bomLineId = cell?.bomLineId == null ? null : Number(cell.bomLineId);
    const operationId = Number(cell?.operationId);
    if (bomLineId != null && (!Number.isInteger(bomLineId) || bomLineId <= 0)) { problems.push(`${where}: bomLineId is a row id, or null for the line's own item.`); return; }
    if (!Number.isInteger(operationId) || operationId <= 0) { problems.push(`${where}: operationId is missing.`); return; }
    const row = flowOfBomLine.get(bomLineId ?? 0);
    if (!row) { problems.push(`${where}: that row is not part of line ${ctx.line.line_no}.`); return; }
    const name = row.node.name;
    const op = row.ops.get(operationId);
    if (!op) {
      const opName = ctx.operations.get(operationId)?.code ?? `operation ${operationId}`;
      problems.push(row.node.flow ? `${name}: ${opName} is not in its flow ${row.node.flow.code ?? row.node.flow.name} — there is no time to set.` : `${name} has no flow — there is no time to set.`);
      return;
    }
    const work = readMinutes(cell.work, `${name} · ${op.code} work minutes`, problems);
    const setup = readMinutes(cell.setup, `${name} · ${op.code} setup minutes`, problems);
    let note;
    if (cell.note !== undefined) {
      note = blank(cell.note) ? null : String(cell.note).trim();
      if (note && note.length > NOTE_MAX) problems.push(`${name} · ${op.code}: a note is at most ${NOTE_MAX} characters.`);
    }
    const key = `${bomLineId ?? 0}:${operationId}`;
    const prev = want.get(key) ?? { bomLineId, operationId };
    if (work !== undefined) prev.work = work;
    if (setup !== undefined) prev.setup = setup;
    if (note !== undefined) prev.note = note;
    want.set(key, prev);
  });
  assertNoProblems(problems, 'Some times cannot be saved.');

  const inserts = [];
  const updates = [];
  const retire = [];
  for (const [key, w] of want) {
    const cur = ctx.overrides.get(key) ?? null;
    const work = w.work !== undefined ? w.work : cur?.work ?? null;
    const setup = w.setup !== undefined ? w.setup : cur?.setup ?? null;
    const note = w.note !== undefined ? w.note : cur?.note ?? null;
    if (work == null && setup == null) {
      // Nothing typed any more: the formula's numbers come back.
      if (cur) { retire.push(cur.id); ctx.overrides.delete(key); }
      continue;
    }
    if (cur) {
      if (cur.work === work && cur.setup === setup && cur.note === note) continue;
      updates.push({ id: cur.id, work, setup, note });
      ctx.overrides.set(key, { ...cur, work, setup, note });
    } else {
      inserts.push([c.companyId, ctx.line.id, w.bomLineId, w.operationId, work, setup, note, c.userId ?? null]);
      ctx.overrides.set(key, { id: null, bomLineId: w.bomLineId, operationId: w.operationId, work, setup, note });
    }
  }
  if (retire.length) {
    await db.query('UPDATE cf_time_overrides SET deleted_at = NOW(), updated_by = ? WHERE company_id = ? AND id IN (?)', [c.userId ?? null, c.companyId, retire]);
  }
  for (let i = 0; i < updates.length; i += 200) {
    const part = updates.slice(i, i + 200);
    const ids = part.map((u) => u.id);
    const cases = () => `CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} END`;
    await db.query(
      `UPDATE cf_time_overrides SET work_minutes = ${cases()}, setup_minutes = ${cases()}, note = ${cases()}, updated_by = ?
        WHERE company_id = ? AND id IN (?)`,
      [...part.flatMap((u) => [u.id, u.work]), ...part.flatMap((u) => [u.id, u.setup]), ...part.flatMap((u) => [u.id, u.note]),
        c.userId ?? null, c.companyId, ids],
    );
  }
  if (inserts.length) {
    await insertRows(db, 'cf_time_overrides',
      ['company_id', 'order_line_id', 'bom_line_id', 'operation_id', 'work_minutes', 'setup_minutes', 'note', 'updated_by'], inserts);
  }
  // The view is worked out from what was just written — the estimator reads the
  // same override map, so no second load.
  return buildTimesView(ctx);
}
