/**
 * plannerService.js — Production › Plan: the snapshot the planner screen plans
 * from, and the few small writes it makes (TM/CF_ERP_PLANNER_PLAN.md §2 is the
 * contract; init.sql §31 the schema).
 *
 * The user, 2026-09-29: plan this month and the next two automatically from the
 * orders, by order priority and a monthly output goal; plan a whole order, or
 * break it down through the BOM (span → girder line → segment); plan by
 * SHIPPING MARKS — "if we set that at least one line should be shipped, that is
 * what gets optimised"; never plan work before its planned procurement date.
 *
 * WHERE THE WORK IS DONE. The backend hands the screen EVERYTHING it needs to
 * judge a plan — units at every level of every line, their work per function,
 * tonnes, materials, capacity per function per period, supply lots — and the
 * engine (multi_app_fe/src/apps/cf_erp/lib/planner, pure TS) evaluates and
 * auto-plans in the browser, so a drag gets its feedback at once. So this
 * service decides nothing about WHEN; it only reads, and stores what the
 * person (or an applied auto-plan) chose.
 *
 *   GET /planner?from=YYYY-MM-DD
 *   PUT /planner/entries      { entries: [{ unitKey, shipDate|null, startDate?, pinned }] }
 *   PUT /planner/priorities   { orderIds: [...] }       a whole ranking
 *   PUT /planner/lines/:id/level  { level }             'line' | '0' | '1' … | null
 *   PUT /planner/targets      { 'YYYY-MM': tonnes|null }
 *   PUT /planner/settings     { minLinesPerMonth?, allowPartialLines? }
 *
 * UNITS. A plan unit is what sits on the board: the whole order line
 * ('l<lineId>'), or one piece of the LOCKED piece tree ('p<pieceId>') at a
 * depth down to the shipping marks. Units are built for every level at once,
 * so the screen switches level without a reload; `levels` on each unit says at
 * which levels it is on the board (a piece at that depth, or a shallower mark
 * or leaf, which is never split below itself).
 *
 *   mark        a piece whose item's SHIP_UNIT resolves to yes (through its
 *               chain — set once on the template definition). A piece with no
 *               mark anywhere under it, whose parent has marks under it (or
 *               which is a top piece of a line with no marks at all), is a mark
 *               too: "a line with no marks = its root is the mark".
 *   groupKey    the shipping line a unit belongs to = the parent of its mark
 *               ('l<lineId>' for a top piece). A unit that holds marks and is
 *               under none is its own group (a girder line; a span).
 *   lot         loose marks (marks only because they are loose — not SHIP_UNIT)
 *               with the same parent piece AND the same design row (bom line)
 *               are ONE unit 'g<parent piece id>.<bom line id>': the 45
 *               intermediate diaphragms of a span ship as one lot, one mark,
 *               quantity 45, their tonnes / work / materials summed. pieceId is
 *               its first piece, pieceIds all of them.
 *
 * WORK per function (a function = a machine TYPE, the classification node the
 * machine a timing rule resolves to is filed under). The numbers are the Times
 * tab's (timeEstimateService: formula or typed override, the machine type's
 * chart else its slowest machine). A row's SETUP is once per row in the Times
 * total, so each piece carries setup × its share of the row — every level then
 * sums to the same line total as GET …/times. Released lines use the steps:
 * est_minutes × (1 − qty_good / quantity); a done step is 0. Contractor cells
 * (cf_work_order_cells, or a released step's work_order_id) go to the
 * pseudo-function `contractor` — unconstrained (decision 3).
 *
 * MATERIALS: what rollOutService's roll-out draws as material under each piece
 * (catalog items that are not made — plates of a cut plate's area-fraction BOM
 * line, studs …), except a nested cut plate, which draws its nest lots' plates
 * instead (each placement's area share of its sheet). A released line has its
 * own requirements and reservations, so its units list no materials.
 * SUPPLY: free stock now (reservations already out) and open purchase lines
 * (ordered / partially received — a draft suggestion is not supply) by date.
 *
 * ROUND TRIPS (GET), the cost that matters on production (~49 ms each):
 *   fixed   ~19 — orders+lines, settings, targets, entries, pieces, placements,
 *           flow steps, overrides, operations, machine side (5), machines,
 *           shifts + exceptions, types, released steps, cells, stock (2), PO
 *           lines, item names
 *   a line  roll-out (explode 2 + one a level, details, ranges …) + the value
 *           mirror (6-8) — about 20 for the 6,072-piece KEPL line, whatever its
 *           size. Lines are loaded side by side (a pool runs them at once).
 *   Nothing is paid per piece.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { rollOutPlan, lockedBothOf, attachLockedCodes } from './rollOutService.js';
import {
  lineNeeds, loadSupply, evaluate, giveBack, takeAgain, orderRanks, orderKeyOf, today as clockToday, dayWords, DATED_PO_STATUSES,
} from './materialReadyService.js';
import { resolveLineRecords } from './orderValuesService.js';
import { effectiveByCode, levelsOfResolution, dateText } from './resolutionService.js';
import { loadMachineSide, flowSteps, opsOfFlow } from './timeEstimateService.js';
import { valueReaders, productionMachineIds } from './operationService.js';
import { machinesCalendar } from './shiftService.js';
import { LEAF_DEPTH, levelName } from './tree.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
// p<piece>, p<piece>#<n> (the n-th of a row of N, planner v2), l<line>; g<parent>.<row> = an old lot card.
const UNIT_RE = /^(?:([pl])([1-9]\d*)(?:#([1-9]\d*))?|(g)([1-9]\d*)\.([1-9]\d*))$/;
const MAX_ENTRIES = 5000;
const MAX_DEPTH_LEVEL = 15;
const OPEN_ORDER_STATUSES = ['inquiry', 'quoted', 'confirmed'];
// One status set for "a purchase order that gives a date" — the material-ready engine's own (§56).
const OPEN_PO_STATUSES = DATED_PO_STATUSES;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DEFAULT_SETTINGS = { minLinesPerMonth: 1, allowPartialLines: true };
export const CONTRACTOR = 'contractor';
export const UNASSIGNED = 'unassigned';

/**
 * A machine type's path in the classification tree, root first
 * ([{ id, name, depth, level }], level = Family / Subfamily / Variant), read in
 * the same query as the type: one LEFT JOIN per level above it (as floorService).
 * The screen groups types into machine AREAS by one level of it.
 */
const NODE_PATH_JOINS = Array.from({ length: LEAF_DEPTH }, (_, i) =>
  `LEFT JOIN cf_classification_nodes a${i + 1} ON a${i + 1}.id = ${i ? `a${i}` : 'n'}.parent_id`).join(' ');
const NODE_PATH_COLS = Array.from({ length: LEAF_DEPTH }, (_, i) =>
  `a${i + 1}.id AS a${i + 1}_id, a${i + 1}.name AS a${i + 1}_name, a${i + 1}.depth AS a${i + 1}_depth`).join(', ');
function nodePathOf(n) {
  const path = [{ id: n.id, name: n.name, depth: Number(n.depth), level: levelName(Number(n.depth)) }];
  for (let i = 1; i <= LEAF_DEPTH; i++) {
    if (n[`a${i}_id`] == null) break;
    const depth = Number(n[`a${i}_depth`]);
    path.unshift({ id: n[`a${i}_id`], name: n[`a${i}_name`], depth, level: levelName(depth) });
  }
  return path;
}

const r3 = (n) => Number(Number(n).toFixed(3));
const r6 = (n) => Number(Number(n).toFixed(6));
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ===========================================================================
 * Dates and periods — local calendar dates, no time zone (as shiftService)
 * ======================================================================== */

const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
// Today is the material-ready engine's today (one clock; a test can set it).
const todayText = () => clockToday();
const validDate = (s) => typeof s === 'string' && DATE_RE.test(s) && dateText(parseDate(s)) === s;
/**
 * The first plan period that STARTS on or after a date: periods are ISO weeks
 * cut at month ends, so that is the date itself when it is a Monday or the
 * first of a month, else the next one. Material that arrives on a Wednesday
 * lets its work start the week after — the rule the board has always used.
 */
export function periodFloor(text) {
  let d = parseDate(text);
  while (!(d.getDay() === 1 || d.getDate() === 1)) d = addDays(d, 1);
  return dateText(d);
}

/**
 * Every live placement of some lines with the area it is charged by (see the caller). One read.
 * A database that has not had init.sql §55 yet has no area_mm2: the box is read instead (the
 * failed statement writes nothing, and the normal path stays one round trip).
 */
async function placementsOfLines(db, companyId, lineIds) {
  const sql = (area) => `SELECT pl.order_line_id, pl.id AS lot_id, pl.plate_item_id, np.cut_plate_id,
                CASE WHEN pl.kind = 'bar' THEN np.length_mm ELSE ${area} END AS area
           FROM cf_plate_lots pl
           JOIN cf_nest_placements np ON np.company_id = pl.company_id AND np.plate_lot_id = pl.id AND np.deleted_at IS NULL
          WHERE pl.company_id = ? AND pl.order_line_id IN (?) AND pl.deleted_at IS NULL AND pl.plate_item_id IS NOT NULL`;
  try {
    return await db.query(sql('COALESCE(np.area_mm2, np.length_mm * np.width_mm)'), [companyId, lineIds]);
  } catch (e) {
    if (!(e?.code === 'ER_BAD_FIELD_ERROR' || e?.errno === 1054)) throw e;
    return db.query(sql('np.length_mm * np.width_mm'), [companyId, lineIds]);
  }
}

/** ISO week number of a local date. */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/**
 * The horizon: `from` (default the first of this month) to the last day of the
 * month two after it. Periods are ISO weeks cut at month ends — a week that
 * spans two months is two periods, so every period's tonnes belong to one month.
 * A period's key is its start date (what cf_plan_entries.ship_date stores).
 */
export function horizonOf(fromInput = null) {
  let from;
  if (!blank(fromInput)) {
    if (!validDate(String(fromInput))) throw invalid('INVALID', 'from needs a date as YYYY-MM-DD.');
    from = parseDate(String(fromInput));
  } else {
    const t = new Date();
    from = new Date(t.getFullYear(), t.getMonth(), 1);
  }
  const to = new Date(from.getFullYear(), from.getMonth() + 3, 0);
  const periods = [];
  let start = from;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const next = addDays(d, 1);
    const cut = next > to || next.getDay() === 1 || next.getDate() === 1;
    if (!cut) continue;
    const s = start;
    const sameMonth = s.getMonth() === d.getMonth();
    periods.push({
      key: dateText(s),
      start: dateText(s),
      end: dateText(d),
      month: dateText(s).slice(0, 7),
      label: `W${isoWeek(s)} · ${s.getDate()}${sameMonth ? '' : ` ${MONTHS[s.getMonth()]}`}–${d.getDate()} ${MONTHS[d.getMonth()]}`,
      days: Math.round((d - s) / 86400000) + 1,
    });
    start = next;
  }
  return { from: dateText(from), to: dateText(to), periods };
}

/* ===========================================================================
 * The orders the planner plans
 * ======================================================================== */

/**
 * Customer and stock orders that are not draft / lost / cancelled / closed /
 * revised, and their lines that are not fully delivered. One read.
 */
async function loadOrderLines(db, companyId) {
  const [rows] = await db.query(
    `SELECT o.id AS order_id, o.code AS order_code, o.order_type, o.status AS order_status, o.committed_date AS order_committed,
            o.plan_priority, o.customer_id, p.name AS customer_name,
            ol.id, ol.line_no, ol.line_type, ol.item_id, ol.quantity, ol.made_qty, ol.delivered_qty, ol.committed_date,
            ol.locked_at, ol.plan_level, ol.description, m.name AS item_name, m.code AS item_code,
            (SELECT r.id FROM cf_production_releases r
              WHERE r.company_id = ol.company_id AND r.order_line_id = ol.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_sales_orders o
       JOIN cf_sales_order_lines ol ON ol.company_id = o.company_id AND ol.order_id = o.id AND ol.deleted_at IS NULL
       LEFT JOIN cf_parties p ON p.company_id = o.company_id AND p.id = o.customer_id
       LEFT JOIN cf_master_records m ON m.company_id = ol.company_id AND m.id = ol.item_id
      WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.status IN (?)
        AND COALESCE(ol.delivered_qty, 0) < ol.quantity
      ORDER BY o.id, ol.line_no, ol.id`,
    [companyId, OPEN_ORDER_STATUSES],
  );
  return rows;
}

/* ===========================================================================
 * One line: its pieces, their work, materials, weights and marks
 * ======================================================================== */

/**
 * The per-line reads: the roll-out (what is made, laid out as pieces, and the
 * material each piece draws) and the value mirror (every record's effective
 * values — WEIGHT, SHIP_UNIT and the inputs of the timing formulas). The two
 * are independent, so they go out together.
 */
async function loadLineStructure(db, companyId, line, lockedPieces) {
  if (!line.item_id) return { problems: ['This line has no item yet.'], nodes: [], reqs: [], resolutions: new Map() };
  const lockedBoth = lockedPieces ? lockedBothOf(lockedPieces) : null;
  const [plan, resolutions] = await Promise.all([
    rollOutPlan(db, companyId, {
      id: line.id, order_id: line.order_id, order_code: line.order_code, order_type: line.order_type,
      line_no: line.line_no, item_id: line.item_id, quantity: line.quantity,
    }, { lockedBoth }),
    resolveLineRecords(db, companyId, line.id).catch(() => new Map()),
  ]);
  if (lockedPieces) attachLockedCodes(plan.nodes, lockedPieces);
  return { ...plan, resolutions };
}

/** Effective values of an item on this line, by code (null when the mirror does not know it). */
function valuesOf(resolutions, itemId) {
  const r = resolutions.get(itemId);
  return r ? effectiveByCode(r) : null;
}

/* ===========================================================================
 * GET /planner
 * ======================================================================== */

export async function getPlanner(db, companyId, q = {}) {
  return (await buildSnapshot(db, companyId, q)).snapshot;
}

/**
 * The snapshot, and the entries as they are STORED. `overrides` (a save being
 * checked): Map(unitKey -> { shipDate, startDate, pinned } | null) laid over
 * the stored entries, and Map(unitKey -> rank) over the stored ranks — the
 * material-ready engine then answers for the plan as it would be saved.
 */
/*
 * onlyOrderIds (a Set): build the UNITS of those orders only — the roll-out is paid for their lines alone —
 * while every other open line still claims material, each as ONE consumer (its whole need, in the ranking's
 * place; cards pinned on those other lines are not seen). What a purchase-line edit asks: "which planned
 * cards of the orders this is bought for does it make late?" without a whole planner read.
 */
async function buildSnapshot(db, companyId, q = {}, { overrides = null, rankOverrides = null, onlyOrderIds = null } = {}) {
  const horizon = horizonOf(q.from);
  const today = todayText();

  // ---- orders, and what the company stored about the plan -------------------
  const [allLineRows, [[settingRow]], [targetRows], [entryRows], [machineRowsAll], [nodeRows], [rankRows], production] = await Promise.all([
    loadOrderLines(db, companyId),
    // The settings row (if any) and WEIGHT's unit, in one read.
    db.query(
      `SELECT s.min_lines_per_month, s.allow_partial_lines,
              (SELECT w.default_uom FROM cf_specifications w
                WHERE w.company_id = ? AND w.code = 'WEIGHT' AND w.deleted_at IS NULL LIMIT 1) AS weight_uom
         FROM (SELECT 1 AS one) x LEFT JOIN cf_plan_settings s ON s.company_id = ?`,
      [companyId, companyId],
    ),
    db.query('SELECT month, tonnes FROM cf_plan_targets WHERE company_id = ? ORDER BY month', [companyId]),
    db.query('SELECT unit_key, ship_date, start_date, pinned, material_state, material_date FROM cf_plan_entries WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    db.query("SELECT id, code, name, classification_id FROM cf_machines WHERE company_id = ? AND status = 'active' AND deleted_at IS NULL", [companyId]),
    // The machine types: the nodes machines are filed under, with the nodes
    // above them (Family › Subfamily › Variant), in the same read.
    db.query(
      `SELECT DISTINCT n.id, n.code, n.name, n.depth, ${NODE_PATH_COLS} FROM cf_classification_nodes n
         JOIN cf_machines m ON m.company_id = n.company_id AND m.classification_id = n.id AND m.deleted_at IS NULL
         ${NODE_PATH_JOINS}
        WHERE n.company_id = ?`,
      [companyId],
    ),
    // The order of a line's units, dragged by hand (§38).
    db.query('SELECT unit_key, rank_no FROM cf_plan_ranks WHERE company_id = ? ORDER BY order_line_id, rank_no', [companyId]),
    // Plan usage counts the machines that do production work, not the asset register.
    productionMachineIds(db, companyId),
  ]);
  const lineRows = onlyOrderIds ? allLineRows.filter((l) => onlyOrderIds.has(Number(l.order_id))) : allLineRows;
  const machineRows = machineRowsAll.filter((m) => production.has(m.id));
  const weightToTonnes = String(settingRow?.weight_uom ?? 'kg').toLowerCase().startsWith('t') ? 1 : 0.001;
  const settings = settingRow?.min_lines_per_month != null
    ? { minLinesPerMonth: Number(settingRow.min_lines_per_month), allowPartialLines: !!Number(settingRow.allow_partial_lines) }
    : { ...DEFAULT_SETTINGS };
  const targets = {};
  for (const t of targetRows) targets[dateText(t.month).slice(0, 7)] = Number(t.tonnes);

  const lineIds = lineRows.map((l) => l.id);
  const lockedIds = lineRows.filter((l) => l.locked_at).map((l) => l.id);
  const releaseIds = lineRows.filter((l) => l.release_id).map((l) => l.release_id);

  // ---- line-wide reads, all lines at once -------------------------------------
  const [[pieceRows], [placementRows], [overrideRows], [cellRows], [stepRows]] = await Promise.all([
    lockedIds.length
      ? db.query(
        `SELECT id, order_line_id, parent_id, item_id, bom_line_id, piece_no, piece_seq, quantity, code, rule_code, path_key, depth, sort_order
           FROM cf_order_pieces WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL ORDER BY order_line_id, sort_order, id`,
        [companyId, lockedIds])
      : [[]],
    lineIds.length
      // A plate lot is shared out by placed AREA; a section bar lot (kind
      // 'bar', §48) by placed LENGTH — its pieces are all one section wide.
      // THE AREA IS THE STEEL IN THE PART (area_mm2, §55) when the placement says
      // it — a gusset drawn by its true shape, a part at a free angle — and the
      // box round it (length × width) when it does not: every row written before
      // §55, and every plain rectangle. Sharing a plate by boxes charged a
      // triangular gusset twice its steel and its rectangular neighbours less.
      ? placementsOfLines(db, companyId, lineIds)
      : [[]],
    lineIds.length
      ? db.query(
        `SELECT order_line_id, bom_line_id, operation_id, work_minutes, setup_minutes FROM cf_time_overrides
          WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL`,
        [companyId, lineIds])
      : [[]],
    lockedIds.length
      ? db.query(
        `SELECT c.order_piece_id, c.operation_id FROM cf_work_order_cells c
           JOIN cf_work_orders w ON w.company_id = c.company_id AND w.id = c.work_order_id AND w.deleted_at IS NULL AND w.status <> 'cancelled'
          WHERE c.company_id = ? AND c.order_line_id IN (?) AND c.deleted_at IS NULL`,
        [companyId, lockedIds])
      : [[]],
    releaseIds.length
      ? db.query(
        `SELECT r.order_line_id, pi.order_piece_id, pi.code AS piece_code, pi.item_id, pi.bom_line_id,
                s.operation_id, s.sequence, s.state, s.quantity, s.qty_good, s.est_minutes, s.machine_id, s.work_order_id
           FROM cf_production_steps s
           JOIN cf_production_items pi ON pi.company_id = s.company_id AND pi.id = s.production_item_id AND pi.deleted_at IS NULL
           JOIN cf_production_releases r ON r.company_id = pi.company_id AND r.id = pi.release_id
          WHERE s.company_id = ? AND pi.release_id IN (?) AND s.deleted_at IS NULL`,
        [companyId, releaseIds])
      : [[]],
  ]);
  const piecesOfLine = new Map();
  for (const p of pieceRows) {
    if (!piecesOfLine.has(p.order_line_id)) piecesOfLine.set(p.order_line_id, []);
    piecesOfLine.get(p.order_line_id).push(p);
  }
  const groupBy = (rows, key) => {
    const m = new Map();
    for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  };
  const placementsOfLine = groupBy(placementRows, 'order_line_id');
  const stepsOfLine = groupBy(stepRows, 'order_line_id');
  const overridesOfLine = new Map();
  for (const o of overrideRows) {
    if (!overridesOfLine.has(o.order_line_id)) overridesOfLine.set(o.order_line_id, new Map());
    overridesOfLine.get(o.order_line_id).set(`${o.bom_line_id ?? 0}:${o.operation_id}`, {
      work: o.work_minutes == null ? null : Number(o.work_minutes),
      setup: o.setup_minutes == null ? null : Number(o.setup_minutes),
    });
  }
  const contractorCells = new Set(cellRows.map((c) => `${c.order_piece_id}:${c.operation_id}`));
  // Rows planned "their parts separately" (§47). A database without §47 yet plans none.
  const splitsOfLine = new Map();
  if (lineIds.length) {
    let rows = [];
    try {
      [rows] = await db.query('SELECT order_line_id, bom_line_id FROM cf_plan_splits WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [companyId, lineIds]);
    } catch (e) { if (e?.code !== 'ER_NO_SUCH_TABLE' && e?.errno !== 1146) throw e; }
    for (const r of rows) { if (!splitsOfLine.has(r.order_line_id)) splitsOfLine.set(r.order_line_id, new Set()); splitsOfLine.get(r.order_line_id).add(Number(r.bom_line_id)); }
  }

  // ---- the per-line structure, side by side ---------------------------------
  const structures = await Promise.all(lineRows.map((l) => loadLineStructure(db, companyId, l, l.locked_at ? piecesOfLine.get(l.id) ?? [] : null)));

  // ---- flows, operations, the machine side: once for every line -------------
  const flowIds = new Set();
  for (const s of structures) for (const n of s.nodes ?? []) if (n.design.flow?.id) flowIds.add(n.design.flow.id);
  const stepsOfFlow = await flowSteps(db, companyId, [...flowIds]);
  const opsOfFlowId = new Map([...stepsOfFlow].map(([id, st]) => [id, opsOfFlow(st)]));
  const operations = new Map();
  for (const ops of opsOfFlowId.values()) for (const o of ops.values()) if (!operations.has(o.id)) operations.set(o.id, o);
  for (const s of stepRows) if (!operations.has(s.operation_id)) operations.set(s.operation_id, { id: s.operation_id, code: String(s.operation_id) });

  const [machineSide, calendars] = await Promise.all([
    loadMachineSide(db, companyId, operations, today),
    machinesCalendar(db, companyId, { from: horizon.from, to: horizon.to, machineIds: machineRows.map((m) => m.id) }),
  ]);
  const machineById = new Map(machineRows.map((m) => [m.id, m]));
  // A machine that is not active (or deleted) can still be named on an old step.
  const typeOfMachine = (id) => machineById.get(id)?.classification_id ?? null;
  const functionOfEstimate = (e) => {
    if (!e?.machineInfo) return null;
    if (e.machineInfo.basis === 'type') return e.machineInfo.id;
    return typeOfMachine(e.machineInfo.id);
  };
  const usedFunctions = new Set();

  // ---- units ----------------------------------------------------------------
  const units = [];
  const orders = new Map();
  const materialItems = new Set();
  // What each unit draws, as the roll-out shares it out — for EVERY line, released ones too: the
  // material-ready engine shares a line's need over its units by it (unit.materials stays empty on a released line).
  const unitShares = new Map();

  lineRows.forEach((line, li) => {
    const st = structures[li];
    const released = !!line.release_id;
    const locked = !!line.locked_at;
    const lineKey = `l${line.id}`;
    const committedDate = dateText(line.committed_date ?? line.order_committed) ?? null;
    const nodes = st.nodes ?? [];
    const resolutions = st.resolutions ?? new Map();
    const over = overridesOfLine.get(line.id) ?? new Map();
    const readers = new Map();
    const readersOf = (itemId) => {
      if (!readers.has(itemId)) { const v = valuesOf(resolutions, itemId); readers.set(itemId, v ? valueReaders(v, levelsOfResolution(resolutions.get(itemId))) : null); }
      return readers.get(itemId);
    };
    const shipUnit = (itemId) => valuesOf(resolutions, itemId)?.get('SHIP_UNIT')?.raw === true;
    const weightOf = (itemId) => {
      const w = valuesOf(resolutions, itemId)?.get('WEIGHT')?.raw;
      return typeof w === 'number' && Number.isFinite(w) ? w : null;
    };

    // Per laid-out node: its own work, missing rates, estimate totals and materials.
    const own = nodes.map(() => ({ work: {}, noRate: new Set(), est: 0, left: 0, steps: 0, doneSteps: 0, materials: new Map(), seq: [] }));
    // PLANNER V2: each piece's work also keeps WHERE in its flow it comes (seq),
    // so a unit's stages can be booked in order — deepest level first.
    const addWork = (k, fn, minutes, seq = 0) => {
      if (!(minutes > 0)) return;
      const key = String(fn);
      own[k].work[key] = (own[k].work[key] ?? 0) + minutes;
      own[k].seq.push({ seq: Number(seq) || 0, fn: key, minutes });
      usedFunctions.add(key);
    };
    // Σ of each design's laid-out quantity — a row's setup is shared over its pieces by it.
    const designQty = new Map();
    for (const n of nodes) designQty.set(n.design, (designQty.get(n.design) ?? 0) + Number(n.quantity));

    if (!released) {
      for (const n of nodes) {
        const ops = opsOfFlowId.get(n.design.flow?.id);
        if (!ops) continue;
        const q = Number(n.quantity);
        const share = q / (designQty.get(n.design) || q || 1);
        for (const o of ops.values()) {
          const f = machineSide.estimate(o.id, readersOf(n.itemId));
          const ov = over.get(`${n.bomLineId ?? 0}:${o.id}`) ?? null;
          const work = ov?.work != null ? ov.work : f.work;
          const setup = ov?.setup != null ? ov.setup : f.setup;
          if (work == null) { own[n.k].noRate.add(`${n.bomLineId ?? 0}:${o.id}`); continue; }
          const minutes = ((setup ?? 0) * share + work * q) * o.passes;
          const onContract = n.lockedPieceId != null && contractorCells.has(`${n.lockedPieceId}:${o.id}`);
          addWork(n.k, onContract ? CONTRACTOR : functionOfEstimate(f) ?? UNASSIGNED, minutes, o.seq);
        }
      }
    } else {
      // The tracker's own numbers: what is left of each step's estimate.
      const byPiece = new Map(nodes.filter((n) => n.lockedPieceId != null).map((n) => [n.lockedPieceId, n.k]));
      const byCode = new Map(nodes.filter((n) => n.code).map((n) => [n.code, n.k]));
      for (const s of stepsOfLine.get(line.id) ?? []) {
        const k = byPiece.get(s.order_piece_id) ?? byCode.get(s.piece_code) ?? (nodes.length ? 0 : null);
        if (k == null) continue;
        const o = own[k];
        o.steps += 1;
        const qty = Number(s.quantity) || 0;
        const good = Math.min(qty, Number(s.qty_good) || 0);
        const isDone = s.state === 'done';
        if (isDone) o.doneSteps += 1;
        if (s.est_minutes == null) { if (!isDone) o.noRate.add(`${s.bom_line_id ?? 0}:${s.operation_id}`); continue; }
        const est = Number(s.est_minutes);
        const left = isDone ? 0 : est * (qty > 0 ? 1 - good / qty : 1);
        o.est += est;
        o.left += left;
        let fn;
        if (s.work_order_id) fn = CONTRACTOR;
        else if (s.machine_id && typeOfMachine(s.machine_id)) fn = typeOfMachine(s.machine_id);
        else fn = functionOfEstimate(machineSide.estimate(s.operation_id, readersOf(s.item_id))) ?? UNASSIGNED;
        addWork(k, fn, left, s.sequence);
      }
    }

    // Materials. A released line has its own requirements, so its units LIST none (unit.materials) —
    // but how its material is shared over its units is worked out all the same, for the engine.
    {
      const placements = placementsOfLine.get(line.id) ?? [];
      const lotArea = new Map();
      for (const p of placements) lotArea.set(p.lot_id, (lotArea.get(p.lot_id) ?? 0) + Number(p.area || 0));
      const placementsOfCut = groupBy(placements, 'cut_plate_id');
      const qtyOfItem = new Map();
      for (const n of nodes) qtyOfItem.set(n.itemId, (qtyOfItem.get(n.itemId) ?? 0) + Number(n.quantity));
      const nestedFrac = new Map();
      for (const n of nodes) {
        const pl = placementsOfCut.get(n.itemId);
        if (!pl || nestedFrac.has(n.itemId)) continue;
        const total = qtyOfItem.get(n.itemId) || pl.length;
        nestedFrac.set(n.itemId, { frac: Math.min(1, pl.length / total), per: Math.max(total, pl.length), pl });
      }
      const addMat = (k, itemId, qty) => {
        if (!(qty > 0)) return;
        own[k].materials.set(itemId, (own[k].materials.get(itemId) ?? 0) + qty);
        if (!released) materialItems.add(itemId);
      };
      for (const r of st.reqs ?? []) {
        if (r.nodeK == null) continue;
        const cut = nestedFrac.get(nodes[r.nodeK].itemId);
        addMat(r.nodeK, r.itemId, Number(r.quantity) * (cut ? 1 - cut.frac : 1));
      }
      for (const n of nodes) {
        const cut = nestedFrac.get(n.itemId);
        if (!cut) continue;
        const q = Number(n.quantity);
        for (const p of cut.pl) {
          const area = lotArea.get(p.lot_id) || 0;
          const share = area > 0 ? Number(p.area || 0) / area : 0;
          addMat(n.k, p.plate_item_id, (share * q) / cut.per);
        }
      }
    }

    // ---- marks and groups over the laid-out tree ----------------------------
    const kids = nodes.map(() => []);
    for (const n of nodes) if (n.parentK != null) kids[n.parentK].push(n.k);
    // A row the planner was told to plan "its parts separately" (cf_plan_splits,
    // §47) is no mark of its own; its made children are marks instead — for this
    // line only. The template's Ships-as-one-unit stays everyone else's default.
    const splitRows = splitsOfLine.get(line.id) ?? new Set();
    const emitPiecesPossible = locked && nodes.length > 0 && nodes.every((n) => n.lockedPieceId != null);
    const isSplit = nodes.map((n) => emitPiecesPossible && n.bomLineId != null && splitRows.has(Number(n.bomLineId)));
    const explicit = nodes.map((n, k) => (isSplit[k] ? false
      : (shipUnit(n.itemId) || (n.parentK != null && isSplit[n.parentK]))));
    const hasMarkBelow = new Array(nodes.length).fill(false); // self or a descendant is SHIP_UNIT
    for (let k = nodes.length - 1; k >= 0; k--) {
      if (explicit[k] || kids[k].some((c) => hasMarkBelow[c])) hasMarkBelow[k] = true;
    }
    const lineHasMarks = nodes.some((n, k) => n.parentK == null && hasMarkBelow[k]);
    const isMark = new Array(nodes.length).fill(false);
    const underMark = new Array(nodes.length).fill(false);
    for (const n of nodes) {
      const k = n.k;
      if (n.parentK != null && (isMark[n.parentK] || underMark[n.parentK])) { underMark[k] = true; continue; }
      const parentHas = n.parentK == null ? lineHasMarks : hasMarkBelow[n.parentK];
      isMark[k] = explicit[k] || (!hasMarkBelow[k] && (parentHas || n.parentK == null));
    }
    // Units are the pieces at or above the marks — nothing strictly under one.
    let markDepth = -1;
    for (const n of nodes) if (isMark[n.k]) markDepth = Math.max(markDepth, n.depth);
    const isUnit = nodes.map((n) => !underMark[n.k] && n.depth <= markDepth);
    // A locked line is planned piece by piece — if its pieces still match its structure.
    const emitPieces = locked && nodes.length > 0 && nodes.every((n) => n.lockedPieceId != null);

    // Default level: the depth of the shipping lines (the parents of real marks).
    const groupDepths = new Map();
    nodes.forEach((n, k) => { if (explicit[k] && isMark[k]) groupDepths.set(n.depth - 1, (groupDepths.get(n.depth - 1) ?? 0) + 1); });
    let defaultLevel = 'line';
    if (emitPieces && groupDepths.size) {
      const [d] = [...groupDepths].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (d >= 0) defaultLevel = String(d);
    }

    // ---- roll every node's own numbers up into the units above it -----------
    const agg = new Map(); // unit node k (or 'line') -> totals
    const blankAgg = () => ({ work: {}, noRate: new Set(), est: 0, left: 0, steps: 0, doneSteps: 0, materials: new Map() });
    const lineAgg = blankAgg();
    const fold = (into, from) => {
      for (const [fn, m] of Object.entries(from.work)) into.work[fn] = (into.work[fn] ?? 0) + m;
      for (const x of from.noRate) into.noRate.add(x);
      into.est += from.est; into.left += from.left; into.steps += from.steps; into.doneSteps += from.doneSteps;
      for (const [it, qv] of from.materials) into.materials.set(it, (into.materials.get(it) ?? 0) + qv);
    };
    for (const n of nodes) {
      fold(lineAgg, own[n.k]);
      if (!emitPieces) continue;
      for (let a = n.k; a != null; a = nodes[a].parentK) {
        if (!isUnit[a]) continue;
        if (!agg.has(a)) agg.set(a, blankAgg());
        fold(agg.get(a), own[n.k]);
      }
    }
    // LOOSE PIECES ARE ONE LOT. A piece that is a mark only because it is loose
    // (no mark under it, its parent has marks) — the 45 intermediate diaphragms
    // of a span, the splice sets of a girder line — ships with its siblings of
    // the same design row: those pieces are ONE unit 'g<parent piece>.<bom line>',
    // one mark, quantity = how many. A real SHIP_UNIT mark is never grouped.
    // PLANNER V2 (user, 2026-10-04): "each quantity can be shipped separately" —
    // no lot cards any more; a row of N pieces is N units (multiOf below).
    const looseOf = new Array(nodes.length).fill(null);
    const looseGroups = new Map();
    if (false) {
      for (const n of nodes) {
        const k = n.k;
        if (!isUnit[k] || !isMark[k] || explicit[k] || n.parentK == null || n.bomLineId == null) continue;
        const key = `g${nodes[n.parentK].lockedPieceId}.${n.bomLineId}`;
        if (!looseGroups.has(key)) looseGroups.set(key, []);
        looseGroups.get(key).push(k);
      }
      for (const [key, ks] of looseGroups) {
        if (ks.length < 2) { looseGroups.delete(key); continue; } // one piece is simply itself
        for (const k of ks) looseOf[k] = key;
      }
    }
    // A lot counts as one mark (on its first piece).
    // A unit piece standing for N physical pieces (a leaf row, quantity N) is N units of one.
    const MULTI_CAP = 500;
    const multiOf = (k) => {
      const q = Number(nodes[k].quantity);
      return emitPieces && isUnit[k] && Number.isInteger(q) && q > 1 && q <= MULTI_CAP && !kids[k].some((c) => isUnit[c]) ? q : 1;
    };
    const marksBelow = new Array(nodes.length).fill(0);
    for (let k = nodes.length - 1; k >= 0; k--) {
      marksBelow[k] = (isMark[k] ? multiOf(k) : 0) + kids[k].reduce((t, c) => t + marksBelow[c], 0);
    }
    // A parent's OWN work (a girder line's assembly, a span's trial assembly) and
    // own material are planned with its pieces when the line is planned below
    // it: each unit under it carries a share, by weight. The weight used is
    // made additive (a unit with units under it weighs what they weigh), so at
    // every level the shares add up to exactly the parent's own numbers; a
    // parent whose pieces weigh nothing shares by marks instead.
    const unitWeight = new Map();
    let shareOfUnit = () => 0;
    if (emitPieces) {
      for (let k = nodes.length - 1; k >= 0; k--) {
        if (!isUnit[k]) continue;
        const under = kids[k].filter((c) => isUnit[c]);
        if (under.length) unitWeight.set(k, under.reduce((t, c) => t + unitWeight.get(c), 0));
        else { const w = weightOf(nodes[k].itemId); unitWeight.set(k, w == null ? 0 : w * Number(nodes[k].quantity)); }
      }
      const shareOf = (u, a) => {
        const wa = unitWeight.get(a);
        return wa > 0 ? unitWeight.get(u) / wa : marksBelow[u] / (marksBelow[a] || 1);
      };
      shareOfUnit = shareOf;
      const inherited = new Map();
      for (const n of nodes) {
        if (!isUnit[n.k]) continue;
        const into = blankAgg();
        for (let a = n.parentK; a != null; a = nodes[a].parentK) {
          if (!isUnit[a]) continue;
          const f = shareOf(n.k, a);
          if (!(f > 0)) continue;
          for (const [fn, m] of Object.entries(own[a].work)) into.work[fn] = (into.work[fn] ?? 0) + m * f;
          for (const [it, qv] of own[a].materials) into.materials.set(it, (into.materials.get(it) ?? 0) + qv * f);
        }
        inherited.set(n.k, into);
      }
      for (const [k, into] of inherited) fold(agg.get(k), into);
    }
    const shapeWork = (w) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, r3(v)]).filter(([, v]) => v > 0));
    /*
     * STAGES (planner v2): a unit's work in the order it is done — deepest BOM
     * level first (cut plates, parts, sub-assemblies, the unit itself, then the
     * share of its parents' assembly), and inside a level the flow's operations
     * in sequence. Pieces of one level run side by side, so one sequence
     * position is one step: its minutes summed across them, per machine type.
     * [{ depth, steps: [{ fn, minutes }] }], scaled by `f`.
     */
    const stagesOf = (rootK, f = 1) => {
      const cells = new Map();                       // depth -> seq -> fn -> minutes
      const take = (m, scale, depth) => {
        for (const e of own[m].seq) {
          if (!cells.has(depth)) cells.set(depth, new Map());
          const bySeq = cells.get(depth);
          if (!bySeq.has(e.seq)) bySeq.set(e.seq, new Map());
          const byFn = bySeq.get(e.seq);
          byFn.set(e.fn, (byFn.get(e.fn) ?? 0) + e.minutes * scale);
        }
      };
      const walk = (k) => { take(k, f, nodes[k].depth); for (const ch of kids[k]) walk(ch); };
      if (rootK == null) { for (const n of nodes) if (n.parentK == null) walk(n.k); } else walk(rootK);
      // The parents' own work this unit carries (its share of their assembly) comes last.
      if (rootK != null && emitPieces) {
        for (let a = nodes[rootK].parentK; a != null; a = nodes[a].parentK) {
          if (!isUnit[a]) continue;
          const sh = shareOfUnit(rootK, a);
          if (sh > 0) take(a, sh * f, nodes[a].depth);
        }
      }
      return [...cells].sort((x, y) => y[0] - x[0]).map(([depth, bySeq]) => ({
        depth,
        steps: [...bySeq].sort((x, y) => x[0] - y[0]).flatMap(([, byFn]) => [...byFn].filter(([, m]) => m > 0).map(([fn, m]) => ({ fn, minutes: r3(m) }))),
      })).filter((st) => st.steps.length);
    };
    const shapeMaterials = (m) => [...m].map(([itemId, qty]) => ({ itemId, qty: r6(qty) })).filter((x) => x.qty > 0).sort((a, b) => a.itemId - b.itemId);
    const progressOf = (a) => (released ? (a.est > 0 ? r3(1 - a.left / a.est) : (a.steps && a.doneSteps === a.steps ? 1 : 0)) : 0);
    const doneOf = (a) => released && a.steps > 0 && a.doneSteps === a.steps;

    // The line unit.
    const lineWeight = weightOf(line.item_id);
    const lineDone = Number(line.made_qty ?? 0) >= Number(line.quantity) - 1e-9 || doneOf(lineAgg);
    unitShares.set(lineKey, shapeMaterials(lineAgg.materials));
    units.push({
      key: lineKey, orderId: line.order_id, lineId: line.id, level: 'line', levels: ['line'], pieceId: null,
      code: line.item_code ?? null, name: line.item_name ?? line.description ?? `Line ${line.line_no}`,
      depth: -1, parentKey: null, groupKey: lineKey,
      isMark: !emitPieces || markDepth < 0, marks: emitPieces ? nodes.reduce((t, n) => t + (n.parentK == null ? marksBelow[n.k] : 0), 0) : 1,
      quantity: Number(line.quantity), itemId: line.item_id ?? null,
      tonnes: lineWeight == null ? 0 : r3(lineWeight * Number(line.quantity) * weightToTonnes), noWeight: lineWeight == null,
      work: shapeWork(lineAgg.work), noRate: lineAgg.noRate.size, done: lineDone, progress: lineDone ? 1 : progressOf(lineAgg),
      materials: released ? [] : shapeMaterials(lineAgg.materials), committedDate,
      stages: stagesOf(null),
    });

    // The piece units, with the levels at which each is on the board.
    const levelValues = [];
    if (emitPieces) {
      for (let d = 0; d <= markDepth; d++) levelValues.push(String(d));
      const hasUnitChild = nodes.map((n) => kids[n.k].some((c) => isUnit[c]));
      const groupOf = (k) => {
        // The mark this node is (or is under): its parent is the shipping line.
        let m = k;
        while (m != null && !isMark[m]) m = nodes[m].parentK;
        if (m == null) return `p${nodes[k].lockedPieceId}`;
        return nodes[m].parentK == null ? lineKey : `p${nodes[nodes[m].parentK].lockedPieceId}`;
      };
      const shownAtOf = (n) => {
        if (isSplit[n.k]) return [];                                     // its parts are planned instead
        const underSplit = n.parentK != null && isSplit[n.parentK];
        return levelValues.filter((lv) => Number(lv) === n.depth || (underSplit && Number(lv) >= nodes[n.parentK].depth)
          || (Number(lv) > n.depth && (isMark[n.k] || !hasUnitChild[n.k])));
      };
      const stripOrder = (code) => (code && line.order_code && code.startsWith(`${line.order_code}-`) ? code.slice(line.order_code.length + 1) : code);
      for (const n of nodes) {
        if (!isUnit[n.k]) continue;
        const lotKey = looseOf[n.k];
        if (lotKey != null) {
          const ks = looseGroups.get(lotKey);
          if (ks[0] !== n.k) continue; // a lot is one unit, emitted at its first piece
          const a = blankAgg();
          let qty = 0, weight = 0, noWeight = false;
          for (const k of ks) {
            fold(a, agg.get(k) ?? blankAgg());
            const q = Number(nodes[k].quantity);
            qty += q;
            const w = weightOf(nodes[k].itemId);
            if (w == null) noWeight = true; else weight += w * q;
          }
          const parent = nodes[n.parentK];
          units.push({
            key: lotKey, orderId: line.order_id, lineId: line.id, level: String(n.depth), levels: shownAtOf(n),
            // pieceId = the lot's first piece (a null pieceId means the whole line to the engine); pieceIds = every piece.
            pieceId: n.lockedPieceId, pieceIds: ks.map((k) => nodes[k].lockedPieceId), lot: true,
            code: `${stripOrder(parent.code) ?? `p${parent.lockedPieceId}`} · ${n.design.name}`, name: n.design.name,
            depth: n.depth, parentKey: `p${parent.lockedPieceId}`,
            groupKey: groupOf(n.k), isMark: true, marks: 1,
            quantity: qty, itemId: n.itemId,
            tonnes: r3(weight * weightToTonnes), noWeight,
            work: shapeWork(a.work), noRate: a.noRate.size, done: doneOf(a), progress: progressOf(a),
            materials: shapeMaterials(a.materials), committedDate,
          });
          continue;
        }
        const a = agg.get(n.k) ?? blankAgg();
        const w = weightOf(n.itemId);
        const shownAt = shownAtOf(n);
        const N = multiOf(n.k);
        const scaleW = (o) => Object.fromEntries(Object.entries(shapeWork(o)).map(([k, v]) => [k, r3(v / N)]));
        const scaleM = (m) => shapeMaterials(new Map([...m].map(([it, qv]) => [it, qv / N])));
        const stages = stagesOf(n.k, 1 / N);
        const mats = N > 1 ? scaleM(a.materials) : shapeMaterials(a.materials);
        for (let i = 1; i <= N; i++) {
          unitShares.set(N > 1 ? `p${n.lockedPieceId}#${i}` : `p${n.lockedPieceId}`, mats);
          units.push({
            key: N > 1 ? `p${n.lockedPieceId}#${i}` : `p${n.lockedPieceId}`, orderId: line.order_id, lineId: line.id, level: String(n.depth), levels: shownAt,
            pieceId: n.lockedPieceId, copy: N > 1 ? i : null, code: N > 1 ? `${stripOrder(n.code) ?? n.design.name} ${i}/${N}` : (n.code ?? null), name: n.design.name,
            depth: n.depth, parentKey: n.parentK == null ? lineKey : `p${nodes[n.parentK].lockedPieceId}`,
            groupKey: groupOf(n.k), isMark: isMark[n.k], marks: N > 1 ? 1 : marksBelow[n.k],
            quantity: Number(n.quantity) / N, itemId: n.itemId,
            tonnes: w == null ? 0 : r3((w * Number(n.quantity) * weightToTonnes) / N), noWeight: w == null,
            work: N > 1 ? scaleW(a.work) : shapeWork(a.work), noRate: a.noRate.size, done: doneOf(a), progress: progressOf(a),
            materials: released ? [] : mats, committedDate,
            // Splitting changes something only on a mark with parts below it (they become the marks).
            stages, split: isSplit[n.k], splittable: n.bomLineId != null && isMark[n.k] && kids[n.k].length > 0 && N === 1,
            bomLineId: n.bomLineId ?? null,
          });
        }
      }
    }

    // The line as the orders rail shows it.
    if (!orders.has(line.order_id)) {
      orders.set(line.order_id, {
        id: line.order_id, code: line.order_code, customer: line.customer_name ?? null, orderType: line.order_type,
        status: line.order_status, committedDate: dateText(line.order_committed) ?? null,
        priority: line.plan_priority == null ? null : Number(line.plan_priority), lines: [],
      });
    }
    const levels = [{ value: 'line', label: 'Whole line' }];
    for (const lv of levelValues) {
      // A depth is named by what the shipping structure is made of there — the
      // pieces that are, or hold, real marks ("Girder line", not the diaphragms
      // beside it); a depth without any is named by all its pieces.
      const atDepth = nodes.filter((n) => isUnit[n.k] && String(n.depth) === lv);
      const structural = atDepth.filter((n) => hasMarkBelow[n.k]);
      const names = new Map();
      for (const n of structural.length ? structural : atDepth) names.set(n.design.name, (names.get(n.design.name) ?? 0) + 1);
      const top = [...names].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([nm]) => nm);
      levels.push({ value: lv, label: top.length > 2 ? `${top.slice(0, 2).join(' / ')} +${top.length - 2}` : top.join(' / ') || `Depth ${lv}` });
    }
    const stored = line.plan_level;
    const level = stored && levels.some((l) => l.value === stored) ? stored : defaultLevel;
    const lineOut = {
      id: line.id, lineNo: line.line_no, name: line.item_name ?? line.description ?? `Line ${line.line_no}`,
      quantity: Number(line.quantity), locked, released, level, defaultLevel, levels,
      committedDate: dateText(line.committed_date) ?? null,
    };
    if (st.problems?.length && !nodes.length) lineOut.problems = st.problems;
    if (locked && nodes.length && !emitPieces) lineOut.problems = [...(lineOut.problems ?? []), 'The locked pieces do not match the structure any more — planned as a whole line.'];
    orders.get(line.order_id).lines.push(lineOut);
  });

  // Ranked orders first (1 = first), then the rest by committed date.
  const orderList = [...orders.values()].sort((a, b) => {
    if ((a.priority == null) !== (b.priority == null)) return a.priority == null ? 1 : -1;
    if (a.priority != null && a.priority !== b.priority) return a.priority - b.priority;
    return String(a.committedDate ?? '9999').localeCompare(String(b.committedDate ?? '9999')) || a.id - b.id;
  });

  // ---- functions and capacity ---------------------------------------------------
  const periodOfDate = new Map();
  for (const p of horizon.periods) {
    for (let d = parseDate(p.start); dateText(d) <= p.end; d = addDays(d, 1)) periodOfDate.set(dateText(d), p.key);
  }
  const typeName = new Map(nodeRows.map((n) => [String(n.id), n.name]));
  const typePath = new Map(nodeRows.map((n) => [String(n.id), nodePathOf(n)]));
  const byType = new Map();
  for (const m of machineRows) {
    const key = String(m.classification_id);
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(m);
  }
  const functions = [];
  const fnKeys = new Set([...byType.keys(), ...[...usedFunctions].filter((k) => k !== CONTRACTOR && k !== UNASSIGNED)]);
  for (const key of fnKeys) {
    const machines = byType.get(key) ?? [];
    const capacity = Object.fromEntries(horizon.periods.map((p) => [p.key, 0]));
    let anyShift = false;
    for (const m of machines) {
      const cal = calendars.get(m.id);
      if (!cal) continue;
      if (cal.hasShifts) anyShift = true;
      for (const d of cal.days) {
        const pk = periodOfDate.get(d.date);
        if (pk) capacity[pk] += d.minutes;
      }
    }
    functions.push({
      key, name: typeName.get(key) ?? `Machine type ${key}`, machines: machines.length, capacity, noShifts: !anyShift, used: usedFunctions.has(key),
      path: typePath.get(key) ?? [],
    });
  }
  functions.sort((a, b) => Number(b.used) - Number(a.used) || a.name.localeCompare(b.name));
  functions.push({ key: CONTRACTOR, name: 'Contractors', machines: 0, capacity: {}, noShifts: false, unlimited: true, used: usedFunctions.has(CONTRACTOR) });
  if (usedFunctions.has(UNASSIGNED)) {
    functions.push({ key: UNASSIGNED, name: 'No machine type', machines: 0, capacity: {}, noShifts: false, unlimited: true, used: true });
  }

  // ---- entries --------------------------------------------------------------------
  const unitKeys = new Set(units.map((u) => u.key));
  const entries = {};
  const stored = new Map();                          // as saved, before any override: what a save is compared with
  const placedWith = new Map();                      // unit -> what the engine said when the card was placed
  for (const e of entryRows) {
    if (!unitKeys.has(e.unit_key)) continue;
    const row = { shipDate: dateText(e.ship_date), startDate: e.start_date ? dateText(e.start_date) : null, pinned: !!Number(e.pinned) };
    entries[e.unit_key] = row;
    stored.set(e.unit_key, row);
    placedWith.set(e.unit_key, { state: e.material_state ?? null, date: e.material_date ? dateText(e.material_date) : null });
  }
  if (overrides) {
    for (const [k, v] of overrides) {
      if (!unitKeys.has(k)) continue;
      if (v == null) delete entries[k]; else entries[k] = { shipDate: v.shipDate, startDate: v.startDate ?? null, pinned: !!v.pinned };
    }
  }
  // A line's units in the order dragged by hand (1 = first); units that are gone are left out.
  const ranks = {};
  for (const r of rankRows) if (unitKeys.has(r.unit_key)) ranks[r.unit_key] = Number(r.rank_no);
  if (rankOverrides) for (const [k, v] of rankOverrides) if (unitKeys.has(k)) ranks[k] = v;

  // ---- material: THE engine (materialReadyService), for every unit at every level -----------
  const mr = await unitReadiness(db, companyId, { lineRows, allLines: allLineRows, units, orders: orderList, unitShares, entries, ranks, today });
  const counts = { ready: 0, dated: 0, late: 0, waiting: 0 };
  for (const u of units) {
    const res = mr.results.get(u.key);
    if (!res) { u.material = null; continue; }
    const need = mr.needs.get(u.lineId);
    u.material = shapeUnitMaterial(res, { today, known: need?.known ?? false, incomplete: need?.known && !need.ready ? need.why : null });
    if (u.levels.includes(mr.levelOfLine.get(u.lineId) ?? 'line')) counts[res.state] += 1;
    /*
     * unit.materials is what the OLD browser gate asks the pooled `supply` for.
     * What is already issued, reserved or held for THIS order is not asked for
     * again — the old gate took an order's own holds out of the free stock and
     * then found the order short of them.
     */
    if (u.materials.length) {
      const hard = new Map();
      for (const r of res.reasons) {
        const h = r.cover.filter((x) => x.kind === 'issued' || x.kind === 'reserved' || x.kind === 'held').reduce((t, x) => t + x.qty, 0);
        if (h > 0 && r.need > 0) hard.set(Number(r.item.id), Math.min(1, h / r.need));
      }
      if (hard.size) u.materials = u.materials.map((m) => (hard.has(Number(m.itemId)) ? { ...m, qty: r6(m.qty * (1 - hard.get(Number(m.itemId)))) } : m)).filter((m) => m.qty > 0);
    }
  }

  // ---- supply (the OLD browser gate's pooled lots — kept until the new board ships) ----------
  const supply = {};
  for (const id of materialItems) {
    const it = mr.supply.items.get(id);
    const lots = [];
    const f = mr.supply.freeOurs.get(id) ?? 0;
    if (f > 0) lots.push({ date: today, qty: r6(f), source: 'stock', received: true });
    supply[id] = { name: it?.name ?? null, code: it?.code ?? null, uom: it?.uom ?? null, lots };
  }
  for (const p of mr.supply.poLines) {
    if (!supply[p.itemId] || !OPEN_PO_STATUSES.includes(p.status)) continue;
    supply[p.itemId].lots.push({ date: p.due ?? null, qty: r6(p.quantity - p.received), source: p.code ?? `PO-${p.poId}`, received: false });
  }
  // By date — stock (today) first; a line with no date waits at the end.
  for (const s of Object.values(supply)) {
    s.lots.sort((a, b) => String(a.date ?? '9999-99-99').localeCompare(String(b.date ?? '9999-99-99'))
      || Number(b.received) - Number(a.received) || String(a.source).localeCompare(String(b.source)));
  }

  // ---- placements the material no longer allows: reported, never moved ---------------------
  const unitOf = new Map(units.map((u) => [u.key, u]));
  let blockedEntries = 0;
  for (const [k, e] of Object.entries(entries)) {
    const b = entryBlock(unitOf.get(k)?.material, e, placedWith.get(k));
    if (b) { e.blocked = b; blockedEntries += 1; }
  }

  const snapshot = {
    horizon: { from: horizon.from, to: horizon.to, today, periods: horizon.periods },
    settings,
    targets,
    functions,
    orders: orderList,
    units,
    supply,
    entries,
    ranks,
    // §56: the engine's summary. counts = the units at each line's saved level.
    materialReady: { engine: 2, today, counts, blockedEntries },
  };
  return { snapshot, stored };
}

/* ===========================================================================
 * Material: the one engine, per unit
 * ======================================================================== */

/**
 * THE CLAIM ORDER OF UNITS — who is served first when two units want the same
 * stock or the same unallocated purchase line. Deterministic:
 *   1. cards PINNED by hand (a stored entry with pinned = 1) before all others
 *   2. the order's place in the planner's ranking (plan_priority, then the
 *      order's committed date, then its id) — materialReadyService.orderRanks
 *   3. the line, in the order the planner lists lines (order id, line number)
 *   4. the unit's rank on its line as dragged by hand (cf_plan_ranks), else
 *   5. the unit's place in the snapshot (the piece tree's own order)
 * Claims are worked out with every line at its SAVED level (line.level).
 */
function claimOrderOfUnits(list, { entries, ranks, oRank, lineIdx, unitIdx }) {
  const keyOf = (u) => [entries[u.key]?.pinned ? 0 : 1, oRank.get(u.orderId) ?? 1e9, lineIdx.get(u.lineId) ?? 1e9, ranks[u.key] ?? 1e9, unitIdx.get(u.key)];
  const keys = new Map(list.map((u) => [u.key, keyOf(u)]));
  return [...list].sort((a, b) => { const x = keys.get(a.key), y = keys.get(b.key); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
}

/**
 * The engine's answer for every unit. A line's NEED per material is the one
 * the requisition and release use (lineNeeds); the units of a level share it in
 * the proportions the roll-out draws it (`unitShares` — a nested plate by the
 * area each unit's parts take of it), so at any level the units' needs add up
 * to the line's need exactly, and the same plate is never counted for two
 * units. A line whose need is not known yet (not frozen) is judged on the
 * roll-out's estimate. Units off their line's saved level are answered "as if
 * the line were planned at that level", against what the OTHER lines leave.
 * Round trips: lineNeeds (≤ 4) + loadSupply (5); nothing per unit.
 */
async function unitReadiness(db, companyId, { lineRows, allLines = lineRows, units: ownUnits, orders, unitShares, entries, ranks, today }) {
  const needs = await lineNeeds(db, companyId, allLines);
  // A line whose units were not built (a restricted read) still claims: one consumer, its whole need.
  const built = new Set(lineRows.map((l) => l.id));
  const units = allLines.length === lineRows.length ? ownUnits
    : [...ownUnits, ...allLines.filter((l) => !built.has(l.id)).map((l) => ({ key: `l${l.id}`, lineId: l.id, orderId: l.order_id, levels: ['line'] }))];
  const itemIds = new Set();
  for (const n of needs.values()) for (const id of n.items.keys()) itemIds.add(id);
  for (const list of unitShares.values()) for (const m of list) itemIds.add(Number(m.itemId));
  const supply = await loadSupply(db, companyId, [...itemIds], { needs, todayText: today });

  const lineOf = new Map(allLines.map((l) => [l.id, l]));
  const lineIdx = new Map(allLines.map((l, i) => [l.id, i]));
  const unitIdx = new Map(units.map((u, i) => [u.key, i]));
  const oRank = orderRanks(allLines);
  const levelOfLine = new Map();
  for (const o of orders) for (const l of o.lines) levelOfLine.set(l.id, l.level);
  const unitsOfLine = new Map();
  for (const u of units) { if (!unitsOfLine.has(u.lineId)) unitsOfLine.set(u.lineId, []); unitsOfLine.get(u.lineId).push(u); }
  const order = (list) => claimOrderOfUnits(list, { entries, ranks, oRank, lineIdx, unitIdx });

  /** The units of one level of a line as consumers: each its share of the line's need. */
  const consumersOf = (lineId, set) => {
    const line = lineOf.get(lineId);
    const n = needs.get(lineId);
    const demand = n?.known ? n.items : null;
    const shareMaps = set.map((u) => new Map((unitShares.get(u.key) ?? []).map((m) => [Number(m.itemId), m.qty])));
    const ids = new Set(demand ? demand.keys() : []);
    for (const sm of shareMaps) for (const id of sm.keys()) ids.add(id);
    const out = set.map((u) => ({ key: u.key, lineId, orderKey: orderKeyOf(line.order_code), customerId: line.customer_id ?? null, needs: [] }));
    for (const id of ids) {
      const S = shareMaps.reduce((t, sm) => t + (sm.get(id) ?? 0), 0);
      const N = demand ? (demand.get(id)?.need ?? 0) : S;
      if (!(N > 1e-9)) continue;                     // drawn by the roll-out but not bought (a reused offcut's plate)
      set.forEach((u, i) => {
        const qty = S > 1e-9 ? ((shareMaps[i].get(id) ?? 0) * N) / S : N / set.length;
        if (qty > 1e-9) out[i].needs.push({ itemId: id, qty });
      });
    }
    return out;
  };
  const setAt = (lineId, level) => (unitsOfLine.get(lineId) ?? []).filter((u) => u.levels.includes(level));

  // 1. Every line at its saved level, all units in one claim order.
  const active = [];
  const activeKeysOf = new Map();
  for (const l of allLines) {
    let set = setAt(l.id, levelOfLine.get(l.id) ?? 'line');
    if (!set.length) set = setAt(l.id, 'line');
    activeKeysOf.set(l.id, set.map((u) => u.key));
    active.push(...set);
  }
  const consumerOf = new Map();
  for (const l of allLines) {
    const set = active.filter((u) => u.lineId === l.id);
    for (const c of consumersOf(l.id, set)) consumerOf.set(c.key, c);
  }
  const main = evaluate(supply, order(active).map((u) => consumerOf.get(u.key)), { full: true });
  const results = new Map(main.results);

  // 2. The other levels of each line: its own claims given back, that level served, then put back.
  for (const l of lineRows) {
    const mine = unitsOfLine.get(l.id) ?? [];
    const levels = [...new Set(mine.flatMap((u) => u.levels))].filter((lv) => lv !== (levelOfLine.get(l.id) ?? 'line'));
    if (!levels.length || mine.every((u) => results.has(u.key))) continue;
    const taken = (activeKeysOf.get(l.id) ?? []).flatMap((k) => main.takes.get(k) ?? []);
    giveBack(taken);
    for (const lv of levels) {
      const set = setAt(l.id, lv);
      if (set.every((u) => results.has(u.key))) continue;
      const cons = new Map(consumersOf(l.id, set).map((c) => [c.key, c]));
      const alt = evaluate(supply, order(set).map((u) => cons.get(u.key)), { full: true });
      for (const [k, r] of alt.results) if (!results.has(k)) results.set(k, r);
      for (const t of alt.takes.values()) giveBack(t);
    }
    takeAgain(taken);
  }
  return { results, needs, supply, levelOfLine };
}

/** At most this many reasons ride on a unit in the snapshot (the rest are counted): 200 units × 25 plates is a megabyte. */
export const MAX_UNIT_REASONS = 3;
const REASON_RANK = { waiting: 0, late: 1, dated: 2, ready: 3 };

/**
 * A unit's engine result as the snapshot carries it: reasons only for what is
 * not simply here — what it waits on first, then what is overdue, then the
 * latest dates — the first MAX_UNIT_REASONS of them, `moreReasons` counting
 * the rest. The line's full list is GET /order-lines/:id/material-ready.
 */
function shapeUnitMaterial(res, { today, known, incomplete = null }) {
  const all = res.reasons.filter((r) => r.state !== 'ready' || r.cover.some((x) => x.kind === 'free'))
    .sort((a, b) => REASON_RANK[a.state] - REASON_RANK[b.state] || String(b.date ?? '').localeCompare(String(a.date ?? '')) || Number(a.item.id) - Number(b.item.id));
  const reasons = all.slice(0, MAX_UNIT_REASONS)
    .map((r) => ({
      ...r, item: { id: r.item.id, code: r.item.code ?? null, name: r.item.name ?? null, uom: r.item.uom ?? null },
      need: r6(r.need), short: r6(r.short), cover: r.cover.map((x) => ({ ...x, qty: r6(x.qty) })),
    }));
  return {
    state: res.state,
    readyDate: res.readyDate,
    // The first week its work may start (null = any week): the period that starts on or after the day the last material arrives.
    earliest: res.readyDate && res.readyDate > today ? periodFloor(res.readyDate) : null,
    soft: !!res.soft,
    materials: res.materials,
    // The line's need is not known yet (not frozen): judged on the roll-out's estimate.
    ...(known ? {} : { estimate: true }),
    // Some of the line's material is not known yet (a cut plate with no plate: nest the line) — judged on what is.
    ...(incomplete ? { incomplete } : {}),
    text: res.text,
    reasons,
    ...(all.length > reasons.length ? { moreReasons: all.length - reasons.length } : {}),
  };
}

/**
 * Why a stored placement cannot stand as it is, or null: { kind: 'waiting' |
 * 'material_late', message, readyDate, earliest, was: { state, date } }.
 * `was` is what the engine said when the card was placed, so the message can
 * say what changed. Reported on every read; nothing is ever moved by itself.
 */
function entryBlock(m, e, was) {
  if (!m || !e?.shipDate) return null;
  const before = { state: was?.state ?? null, date: was?.date ?? null };
  if (m.state === 'waiting') {
    const changed = before.state && before.state !== 'waiting'
      ? ` When this card was placed its material was ${before.state === 'ready' ? 'here' : `due ${dayWords(before.date)}`}.` : '';
    return { kind: 'waiting', message: `${m.text}${changed}`, readyDate: null, earliest: null, was: before };
  }
  if (!m.earliest) return null;
  const startsEarly = !!e.startDate && e.startDate < m.earliest;
  if (!(e.shipDate < m.earliest) && !startsEarly) return null;
  const moved = before.date && before.date !== m.readyDate ? ` (it was ${dayWords(before.date)} when this card was placed)`
    : before.state === 'ready' ? ' (it was here when this card was placed)' : '';
  return {
    kind: 'material_late',
    message: `Its material now arrives ${dayWords(m.readyDate)}${moved} — ${startsEarly && !(e.shipDate < m.earliest) ? `its bar starts in the week of ${dayWords(e.startDate)}` : `it is planned to ship in the week of ${dayWords(e.shipDate)}`}. Move it to the week of ${dayWords(m.earliest)} or later. ${m.text}`,
    readyDate: m.readyDate, earliest: m.earliest, was: before,
  };
}

/**
 * The PLANNED cards of some orders that their material no longer allows — after
 * a purchase line's date or quantity changed, a PO was cancelled, a receipt was
 * reversed. Only those orders' units are built (buildSnapshot onlyOrderIds).
 * { late, waiting, units: [{ unitKey, code, name, order: { id, code }, line: { id, lineNo }, kind:
 *   'material_late' | 'waiting', week (the placement's week), startDate, wasDate, wasState (what the
 *   engine said when the card was placed), readyDate (now), earliest, message }] }
 */
export async function plannedUnitsOfOrders(db, companyId, orderIds) {
  const ids = [...new Set((orderIds ?? []).map(Number).filter(Boolean))];
  const out = { late: 0, waiting: 0, units: [] };
  if (!ids.length) return out;
  const { snapshot } = await buildSnapshot(db, companyId, {}, { onlyOrderIds: new Set(ids) });
  const unitOf = new Map(snapshot.units.map((u) => [u.key, u]));
  const orderOf = new Map(snapshot.orders.map((o) => [o.id, o]));
  for (const [k, e] of Object.entries(snapshot.entries)) {
    if (!e.blocked) continue;
    const u = unitOf.get(k);
    const o = orderOf.get(u.orderId);
    const l = o?.lines.find((x) => x.id === u.lineId);
    if (e.blocked.kind === 'waiting') out.waiting += 1; else out.late += 1;
    out.units.push({
      unitKey: k, code: u.code ?? null, name: u.name ?? null, order: { id: u.orderId, code: o?.code ?? null }, line: { id: u.lineId, lineNo: l?.lineNo ?? null },
      kind: e.blocked.kind, week: e.shipDate, startDate: e.startDate ?? null, wasDate: e.blocked.was.date, wasState: e.blocked.was.state,
      readyDate: e.blocked.readyDate, earliest: e.blocked.earliest, message: e.blocked.message,
    });
  }
  return out;
}

/**
 * A SAVE IS REFUSED where the material says no (§56): a card being placed or
 * moved (its week or its start changes) must not ship — or start — before the
 * week its material allows, and cannot be placed at all while it waits. Cards
 * that stay where they are are not checked here (they are flagged on the next
 * read), nor is a card whose delivery is merely overdue. The engine answers for
 * the plan AS IT WOULD BE SAVED (the new pins change who claims stock first).
 * Returns Map(unitKey -> { state, date }) to store on the entries.
 * `reader`: where the planner read is made — the pool in a route (side by
 * side, outside the write's transaction), the transaction itself in a test.
 */
async function materialGate(reader, c, want, { rankOverrides = null } = {}) {
  const said = new Map();
  if (!want.some((w) => w.shipDate != null)) return said;
  const overrides = new Map(want.map((w) => [w.unitKey, w.shipDate == null ? null : { shipDate: w.shipDate, startDate: w.startDate ?? null, pinned: w.pinned }]));
  const { snapshot, stored } = await buildSnapshot(reader, c.companyId, {}, { overrides, rankOverrides });
  const unitOf = new Map(snapshot.units.map((u) => [u.key, u]));
  const orderCode = new Map(snapshot.orders.map((o) => [o.id, o.code]));
  const problems = [];
  const refused = [];
  for (const w of want) {
    if (w.shipDate == null) continue;
    const u = unitOf.get(w.unitKey);
    const m = u?.material;
    if (!m) continue;
    said.set(w.unitKey, { state: m.state, date: m.readyDate });
    const was = stored.get(w.unitKey);
    if (was && was.shipDate === w.shipDate && (was.startDate ?? null) === (w.startDate ?? null)) continue;
    const who = `${orderCode.get(u.orderId) ?? 'Order'} · ${u.code ?? u.name ?? w.unitKey}`;
    if (m.state === 'waiting') {
      problems.push(`${who} cannot be planned yet — it is waiting for material. ${m.text}`);
      refused.push({ unitKey: w.unitKey, kind: 'waiting', readyDate: null, earliest: null });
    } else if (m.earliest && (w.shipDate < m.earliest || (w.startDate && w.startDate < m.earliest))) {
      problems.push(`${who} cannot ${w.shipDate < m.earliest ? `ship in the week of ${dayWords(w.shipDate)}` : `start in the week of ${dayWords(w.startDate)}`} — its material arrives ${dayWords(m.readyDate)}. Plan it for the week of ${dayWords(m.earliest)} or later. ${m.text}`);
      refused.push({ unitKey: w.unitKey, kind: 'material_late', readyDate: m.readyDate, earliest: m.earliest });
    }
  }
  if (problems.length) {
    throw invalid('MATERIAL_NOT_READY', problems.length === 1 ? problems[0] : `${problems.length} cards cannot be placed there — their material is not ready.`, { problems, detail: { units: refused } });
  }
  return said;
}

/* ===========================================================================
 * Writes — small, validated, tenant-scoped, set-based
 * ======================================================================== */

const toBool = (v, label, problems) => {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1 || v === '0' || v === '1') return Number(v) === 1;
  problems.push(`${label} is yes or no (true / false).`);
  return undefined;
};

/**
 * PUT /planner/entries { entries: [{ unitKey, shipDate|null, pinned }] }.
 * shipDate null unplans the unit (its row is retired). All or nothing: every
 * unit must be a live piece or line of this company. One read to check, one
 * statement to retire, one (chunked) upsert, one read back.
 */
export async function putEntries(db, c, input = {}, { reader = db } = {}) {
  const list = Array.isArray(input.entries) ? input.entries : null;
  if (!list) throw invalid('INVALID', 'Send the entries: { entries: [{ unitKey, shipDate, pinned }] }.');
  const want = parseEntries(list);
  if (!want.length) return { entries: {} };
  await attachLines(db, c, want);
  return writeEntries(db, c, want, await materialGate(reader, c, want));
}

const KEY_WORDS = "unitKey is 'p<piece id>', 'l<line id>' or 'g<parent piece id>.<bom line id>'.";

/** Validate entry rows (no reads); throws 422 with every problem. */
function parseEntries(list) {
  if (list.length > MAX_ENTRIES) throw invalid('TOO_MANY', `At most ${MAX_ENTRIES} entries in one save.`);
  const problems = [];
  const seen = new Set();
  const want = [];
  list.forEach((e, i) => {
    const at = `Entry ${i + 1}`;
    const k = parseUnitKey(e?.unitKey);
    if (!k) { problems.push(`${at}: ${KEY_WORDS}`); return; }
    if (seen.has(e.unitKey)) { problems.push(`${at}: ${e.unitKey} is named twice.`); return; }
    seen.add(e.unitKey);
    let shipDate = null;
    if (e.shipDate !== null && e.shipDate !== undefined && e.shipDate !== '') {
      if (!validDate(String(e.shipDate))) { problems.push(`${at}: shipDate needs a date as YYYY-MM-DD, or null to unplan.`); return; }
      shipDate = String(e.shipDate);
    }
    // A stretched bar's first week (planner v2); it must come before the ship date.
    let startDate = null;
    if (shipDate && e.startDate !== null && e.startDate !== undefined && e.startDate !== '') {
      if (!validDate(String(e.startDate))) { problems.push(`${at}: startDate needs a date as YYYY-MM-DD, or null.`); return; }
      if (String(e.startDate) >= shipDate) { problems.push(`${at}: startDate must come before shipDate.`); return; }
      startDate = String(e.startDate);
    }
    const pinned = toBool(e.pinned ?? false, `${at}: pinned`, problems);
    want.push({ unitKey: e.unitKey, ...k, shipDate, startDate, pinned: !!pinned });
  });
  assertNoProblems(problems, 'Some entries need attention.');
  return want;
}

/**
 * Validate rank rows { lineId, unitKeys: [...] } (no reads): each is the WHOLE
 * order of one line's units, first first; an empty list clears the line's order.
 */
function parseRanks(list) {
  if (list.length > 500) throw invalid('TOO_MANY', 'At most 500 lines in one save.');
  const problems = [];
  const lines = [];
  const seenLines = new Set();
  const seenKeys = new Set();
  let total = 0;
  list.forEach((r, i) => {
    const at = `Rank ${i + 1}`;
    const lineId = Number(r?.lineId);
    if (!Number.isInteger(lineId) || lineId <= 0) { problems.push(`${at}: lineId is an order line id.`); return; }
    if (seenLines.has(lineId)) { problems.push(`${at}: line ${lineId} is named twice.`); return; }
    seenLines.add(lineId);
    if (!Array.isArray(r.unitKeys)) { problems.push(`${at}: unitKeys is the line's units in order (a list).`); return; }
    total += r.unitKeys.length;
    const units = [];
    for (const key of r.unitKeys) {
      const k = parseUnitKey(key);
      if (!k) { problems.push(`${at}: ${KEY_WORDS}`); return; }
      if (seenKeys.has(key)) { problems.push(`${at}: ${key} is named twice.`); return; }
      seenKeys.add(key);
      units.push({ unitKey: key, ...k, rankLine: lineId });
    }
    lines.push({ lineId, units });
  });
  if (total > MAX_ENTRIES) problems.push(`At most ${MAX_ENTRIES} ranked units in one save.`);
  assertNoProblems(problems, 'Some ranks need attention.');
  return lines;
}

/**
 * PUT /planner/changes { entries: [...], ranks: [{ lineId, unitKeys }] } —
 * everything the Save button sends, in ONE transaction: where units ship
 * (as PUT /planner/entries) and the order of each named line's units (§38).
 * Both lists are checked before anything is written. Round trips: one stage of
 * up to four reads, one retire, the upsert (per 500), one read back, and per
 * save of ranks one delete + one insert.
 */
export async function putChanges(db, c, input = {}, { reader = db } = {}) {
  const entryList = input.entries == null ? [] : input.entries;
  const rankList = input.ranks == null ? [] : input.ranks;
  if (!Array.isArray(entryList) || !Array.isArray(rankList)) {
    throw invalid('INVALID', 'Send { entries: [{ unitKey, shipDate, pinned }], ranks: [{ lineId, unitKeys }] }.');
  }
  const want = parseEntries(entryList);
  const lines = parseRanks(rankList);
  const ranked = lines.flatMap((l) => l.units);
  const lineIds = lines.map((l) => l.lineId);
  const [, liveLines] = await Promise.all([
    want.length || ranked.length ? attachLines(db, c, [...want, ...ranked]) : null,
    lineIds.length
      ? db.query('SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, lineIds]).then(([r]) => new Set(r.map((x) => x.id)))
      : new Set(),
  ]);
  const problems = [];
  for (const l of lines) if (!liveLines.has(l.lineId)) problems.push(`Line ${l.lineId} is not an order line here.`);
  for (const u of ranked) if (u.lineId !== u.rankLine) problems.push(`${u.unitKey} is not a unit of line ${u.rankLine}.`);
  assertNoProblems(problems, 'Some ranks name units of another line.');

  // The order of a line's units being saved in the same call decides who claims material first, too.
  const rankOverrides = new Map(lines.flatMap((l) => l.units.map((u, i) => [u.unitKey, i + 1])));
  const out = want.length ? await writeEntries(db, c, want, await materialGate(reader, c, want, { rankOverrides })) : { entries: {} };
  const ranks = await writeRanks(db, c, lines);
  return { entries: out.entries, ranks };
}

/** Replace the order of each named line's units; returns { [lineId]: [unitKey…] }. */
async function writeRanks(db, c, lines) {
  const out = {};
  if (!lines.length) return out;
  await db.query('DELETE FROM cf_plan_ranks WHERE company_id = ? AND order_line_id IN (?)', [c.companyId, lines.map((l) => l.lineId)]);
  const rows = lines.flatMap((l) => l.units.map((u, i) => [c.companyId, l.lineId, u.unitKey, i + 1, c.userId ?? null]));
  // A unit ranked under another line before (it cannot be: a unit has one line) would trip uq_cprk_unit.
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await db.query(
      `INSERT INTO cf_plan_ranks (company_id, order_line_id, unit_key, rank_no, updated_by) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      part.flat(),
    );
  }
  for (const l of lines) out[l.lineId] = l.units.map((u) => u.unitKey);
  return out;
}

/** Parse a unit key into { kind, id, bomLineId? }; null when it is not one. */
function parseUnitKey(key) {
  const m = UNIT_RE.exec(String(key ?? ''));
  if (!m) return null;
  return m[4] ? { kind: 'g', id: Number(m[5]), bomLineId: Number(m[6]) } : { kind: m[1], id: Number(m[2]), copy: m[3] ? Number(m[3]) : null };
}

/**
 * Which order line each unit belongs to — and that it is this company's
 * (sets `w.lineId`; refuses the lot if any names nothing here). One stage of
 * up to three reads, whatever the number of units.
 */
async function attachLines(db, c, want) {
  const problems = [];
  const pieceIds = want.filter((w) => w.kind === 'p').map((w) => w.id);
  const lineIds = want.filter((w) => w.kind === 'l').map((w) => w.id);
  const lots = want.filter((w) => w.kind === 'g');
  const [[pieces], [lines], [lotRows]] = await Promise.all([
    pieceIds.length
      ? db.query('SELECT id, order_line_id FROM cf_order_pieces WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, pieceIds])
      : [[]],
    lineIds.length
      ? db.query('SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, lineIds])
      : [[]],
    // A lot = the live pieces of one design row under one parent piece.
    lots.length
      ? db.query(
        `SELECT parent_id, bom_line_id, MIN(order_line_id) AS order_line_id FROM cf_order_pieces
          WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL GROUP BY parent_id, bom_line_id`,
        [c.companyId, [...new Set(lots.map((w) => w.id))]])
      : [[]],
  ]);
  const lineOfPiece = new Map(pieces.map((p) => [p.id, p.order_line_id]));
  const liveLines = new Set(lines.map((l) => l.id));
  const lineOfLot = new Map(lotRows.map((r) => [`${r.parent_id}.${r.bom_line_id}`, r.order_line_id]));
  const kindWord = { p: 'piece', g: 'lot of pieces', l: 'line' };
  for (const w of want) {
    if (w.kind === 'p') w.lineId = lineOfPiece.get(w.id);
    else if (w.kind === 'g') w.lineId = lineOfLot.get(`${w.id}.${w.bomLineId}`);
    else w.lineId = liveLines.has(w.id) ? w.id : undefined;
    if (w.lineId == null) problems.push(`${w.unitKey} is not a ${kindWord[w.kind]} of an order here.`);
  }
  assertNoProblems(problems, 'Some entries name nothing that can be planned.');
}

/** Retire / upsert entries whose lines are attached; returns what changed. */
async function writeEntries(db, c, want, said = new Map()) {
  const drop = want.filter((w) => w.shipDate == null).map((w) => w.unitKey);
  const keep = want.filter((w) => w.shipDate != null);
  if (drop.length) {
    await db.query(
      'UPDATE cf_plan_entries SET deleted_at = NOW(), updated_by = ? WHERE company_id = ? AND unit_key IN (?) AND deleted_at IS NULL',
      [c.userId ?? null, c.companyId, drop],
    );
  }
  if (keep.length) {
    // One live row per unit (uq_cpe_unit): an existing one is updated in place.
    for (let i = 0; i < keep.length; i += 500) {
      const part = keep.slice(i, i + 500);
      await db.query(
        // material_state / material_date (§56): what the engine said as the card was placed, so a later read can say what changed.
        `INSERT INTO cf_plan_entries (company_id, order_line_id, unit_key, ship_date, start_date, pinned, updated_by, material_state, material_date)
         VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON DUPLICATE KEY UPDATE order_line_id = VALUES(order_line_id), ship_date = VALUES(ship_date),
                                 start_date = VALUES(start_date), pinned = VALUES(pinned), updated_by = VALUES(updated_by),
                                 material_state = VALUES(material_state), material_date = VALUES(material_date)`,
        part.flatMap((w) => [c.companyId, w.lineId, w.unitKey, w.shipDate, w.startDate ?? null, w.pinned ? 1 : 0, c.userId ?? null,
          said.get(w.unitKey)?.state ?? null, said.get(w.unitKey)?.date ?? null]),
      );
    }
  }
  const out = {};
  for (const k of drop) out[k] = null;
  if (keep.length) {
    const [rows] = await db.query(
      'SELECT unit_key, ship_date, start_date, pinned FROM cf_plan_entries WHERE company_id = ? AND unit_key IN (?) AND deleted_at IS NULL',
      [c.companyId, keep.map((w) => w.unitKey)],
    );
    for (const r of rows) out[r.unit_key] = { shipDate: dateText(r.ship_date), startDate: r.start_date ? dateText(r.start_date) : null, pinned: !!Number(r.pinned) };
  }
  return { entries: out };
}

/**
 * PUT /planner/priorities { orderIds: [...] } — the whole ranking: the first is
 * priority 1. Every other order of the company loses its rank (NULL = after
 * the ranked ones, by committed date). Two statements.
 */
export async function putPriorities(db, c, input = {}) {
  const ids = Array.isArray(input.orderIds) ? input.orderIds : null;
  if (!ids) throw invalid('INVALID', 'Send the ranking: { orderIds: [first, second, …] }.');
  if (ids.length > 2000) throw invalid('TOO_MANY', 'At most 2000 orders in a ranking.');
  const problems = [];
  const nums = ids.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) problems.push('orderIds are order ids (positive whole numbers).');
  if (new Set(nums).size !== nums.length) problems.push('An order is named twice in the ranking.');
  assertNoProblems(problems, 'The ranking needs attention.');
  if (nums.length) {
    const [rows] = await db.query('SELECT id FROM cf_sales_orders WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, nums]);
    const found = new Set(rows.map((r) => r.id));
    const missing = nums.filter((n) => !found.has(n));
    if (missing.length) throw invalid('UNKNOWN_ORDER', `${plural(missing.length, 'order')} in the ranking ${missing.length === 1 ? 'is' : 'are'} not here: ${missing.slice(0, 10).join(', ')}.`);
    await db.query(
      `UPDATE cf_sales_orders SET plan_priority = CASE id ${nums.map(() => 'WHEN ? THEN ?').join(' ')} END
        WHERE company_id = ? AND id IN (?)`,
      [...nums.flatMap((id, i) => [id, i + 1]), c.companyId, nums],
    );
  }
  await db.query(
    `UPDATE cf_sales_orders SET plan_priority = NULL WHERE company_id = ? AND plan_priority IS NOT NULL${nums.length ? ' AND id NOT IN (?)' : ''}`,
    nums.length ? [c.companyId, nums] : [c.companyId],
  );
  return { orders: nums.map((id, i) => ({ id, priority: i + 1 })) };
}

/**
 * PUT /planner/lines/:id/level { level } — 'line', a depth of the locked piece
 * tree ('0', '1' …), or null for the default. Only a locked line breaks down
 * into pieces.
 */
/**
 * PUT /planner/lines/:id/splits { bomLineId, split } — plan a row's parts
 * separately (true) or as one unit again (false), for this line only
 * (planner v2, §47). The line must be locked: only a locked line is planned
 * piece by piece. Entries of the row's units stay and simply stop showing.
 */
export async function putLineSplit(db, c, lineId, input = {}) {
  const [[line]] = await db.query('SELECT id, locked_at FROM cf_sales_order_lines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(lineId)]);
  if (!line) throw notFound('Order line');
  if (!line.locked_at) throw invalid('NOT_LOCKED', 'Freeze the design first — a line is planned piece by piece only once it is frozen.');
  const bomLineId = Number(input.bomLineId);
  if (!Number.isInteger(bomLineId) || bomLineId <= 0) throw invalid('INVALID', 'Say which row (bomLineId).');
  const [[piece]] = await db.query('SELECT id FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND bom_line_id = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, line.id, bomLineId]);
  if (!piece) throw invalid('INVALID', 'That row is not part of this line.');
  if (input.split === true || input.split === 'true') {
    await db.query(
      'INSERT INTO cf_plan_splits (company_id, order_line_id, bom_line_id, created_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE deleted_at = NULL',
      [c.companyId, line.id, bomLineId, c.userId ?? null],
    );
  } else {
    await db.query('UPDATE cf_plan_splits SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND bom_line_id = ? AND deleted_at IS NULL', [c.companyId, line.id, bomLineId]);
  }
  return { lineId: line.id, bomLineId, split: input.split === true || input.split === 'true' };
}

export async function putLineLevel(db, c, lineId, input = {}) {
  const raw = input.level;
  let level = null;
  if (!(raw === null || raw === undefined || raw === '')) {
    level = String(raw).trim().toLowerCase();
    if (level !== 'line' && !(/^\d+$/.test(level) && Number(level) <= MAX_DEPTH_LEVEL)) {
      throw invalid('INVALID', "level is 'line', a depth of the piece tree (0, 1, 2 …), or null for the default.");
    }
    if (level !== 'line') level = String(Number(level));
  }
  const [[line]] = await db.query(
    `SELECT ol.id, ol.line_no, ol.locked_at,
            (SELECT MAX(p.depth) FROM cf_order_pieces p WHERE p.company_id = ol.company_id AND p.order_line_id = ol.id AND p.deleted_at IS NULL) AS max_depth
       FROM cf_sales_order_lines ol WHERE ol.company_id = ? AND ol.id = ? AND ol.deleted_at IS NULL`,
    [c.companyId, lineId],
  );
  if (!line) throw notFound('Order line');
  if (level != null && level !== 'line') {
    if (!line.locked_at) throw invalid('NOT_LOCKED', `Line ${line.line_no} is not locked — only a locked line breaks down into pieces. Plan it as a whole line, or lock it first.`);
    if (line.max_depth == null || Number(level) > Number(line.max_depth)) {
      throw invalid('INVALID', `Line ${line.line_no}'s pieces go ${line.max_depth == null ? 'nowhere' : `down to depth ${line.max_depth}`} — there is no depth ${level}.`);
    }
  }
  await db.query('UPDATE cf_sales_order_lines SET plan_level = ? WHERE company_id = ? AND id = ?', [level, c.companyId, lineId]);
  return { line: { id: Number(lineId), level } };
}

/** PUT /planner/targets { 'YYYY-MM': tonnes | null } — null clears that month's goal. */
export async function putTargets(db, c, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('INVALID', "Send the goals: { 'YYYY-MM': tonnes }.");
  const problems = [];
  const set = [];
  const clear = [];
  const keys = Object.keys(input);
  if (keys.length > 60) problems.push('At most 60 months in one save.');
  for (const k of keys) {
    if (!MONTH_RE.test(k)) { problems.push(`${k} is not a month (YYYY-MM).`); continue; }
    const v = input[k];
    if (v === null || v === '') { clear.push(`${k}-01`); continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e8) { problems.push(`${k}: the goal is tonnes, zero or more.`); continue; }
    set.push([`${k}-01`, r3(n)]);
  }
  assertNoProblems(problems, 'The goals need attention.');
  if (set.length) {
    await db.query(
      `INSERT INTO cf_plan_targets (company_id, month, tonnes, updated_by) VALUES ${set.map(() => '(?, ?, ?, ?)').join(', ')}
       ON DUPLICATE KEY UPDATE tonnes = VALUES(tonnes), updated_by = VALUES(updated_by)`,
      set.flatMap(([m, t]) => [c.companyId, m, t, c.userId ?? null]),
    );
  }
  if (clear.length) await db.query('DELETE FROM cf_plan_targets WHERE company_id = ? AND month IN (?)', [c.companyId, clear]);
  const targets = {};
  for (const [m, t] of set) targets[m.slice(0, 7)] = t;
  for (const m of clear) targets[m.slice(0, 7)] = null;
  return { targets };
}

/** PUT /planner/settings { minLinesPerMonth?, allowPartialLines? } — what is left out keeps its value. */
export async function putSettings(db, c, input = {}) {
  const problems = [];
  let min;
  if (input.minLinesPerMonth !== undefined) {
    min = Number(input.minLinesPerMonth);
    if (!Number.isInteger(min) || min < 0 || min > 100) problems.push('minLinesPerMonth is a whole number from 0 to 100.');
  }
  const partial = toBool(input.allowPartialLines, 'allowPartialLines', problems);
  assertNoProblems(problems, 'The settings need attention.');
  const [[row]] = await db.query('SELECT min_lines_per_month, allow_partial_lines FROM cf_plan_settings WHERE company_id = ? FOR UPDATE', [c.companyId]);
  const next = {
    minLinesPerMonth: min !== undefined ? min : row ? Number(row.min_lines_per_month) : DEFAULT_SETTINGS.minLinesPerMonth,
    allowPartialLines: partial !== undefined ? partial : row ? !!Number(row.allow_partial_lines) : DEFAULT_SETTINGS.allowPartialLines,
  };
  await db.query(
    `INSERT INTO cf_plan_settings (company_id, min_lines_per_month, allow_partial_lines, updated_by) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE min_lines_per_month = VALUES(min_lines_per_month), allow_partial_lines = VALUES(allow_partial_lines), updated_by = VALUES(updated_by)`,
    [c.companyId, next.minLinesPerMonth, next.allowPartialLines ? 1 : 0, c.userId ?? null],
  );
  return { settings: next };
}
