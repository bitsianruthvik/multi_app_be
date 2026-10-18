/**
 * plannerV3Service.js — STEP 5: the PLANNER per production order, at step level (init.sql §84, TM/s84.sql; contract
 * TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — Step 5: the planner"). The engine is plannerV3Engine.js (pure); this file
 * reads what it needs, hands it over, shapes the answer and stores what the person saves.
 *
 * The user, 2026-10-18 (the decisions, in short — the contract block has them all):
 *   - plan per PRODUCTION ORDER ("SO260008 · Span 2 of 3"), step level;
 *   - a step waits for its predecessors and its material; material first come, first served by planned start: free
 *     stock, then purchase lines by date (the PO line's date, else the PO's; a receipt is stock); a cut piece counts when
 *     its step is done (a wait); real dates override planned;
 *   - capacity per machine type = each machine's shifts − planned downtime − open faults (shiftService.machinesCalendar);
 *   - AUTO ("by AI"): committed dates, then money unlocked earliest, then manual priority; pinning keeps a production
 *     order's rank and earliest start. MANUAL ("Management"): earliest start + rank; higher rank takes what it can;
 *   - BASELINE saved at the first saved plan; RE-BASELINE needs Management's approval (approval type 'rebaseline');
 *     PLAN HEALTH = on time vs baseline, slip by reason;
 *   - NO frozen window; started steps keep (planned − elapsed); the order's time override (§76) flows through stepMinutes.
 *
 *   GET  /planner3?mode=&steps=1&po=     the live plan (worked out on every read — nothing is stale)
 *   PUT  /planner3/settings               { mode: 'auto' | 'manual' }
 *   PUT  /planner3/orders                 { rows: [{ id, earliestStart?: 'YYYY-MM-DD' | null, rank?: n | null, pinned?: bool }] }
 *   POST /planner3/run                    { mode? } — SAVE the plan (dates on every step and production order); the first
 *                                         save is the baseline
 *   POST /planner3/rebaseline             { note } — ask Management to make the saved plan the new baseline
 *   GET  /planner3/health                 plan health (Management dashboard): the saved plan vs the baseline
 *
 * ROUND TRIPS (production ~49 ms each): GET = 2 stages. Stage 1, side by side: settings, inputs, production orders,
 * steps, waits, material requirements, work sessions, machines, production machines (3, cached), acceptances,
 * baseline, faults, planned downtime, pending re-baseline. Stage 2, side by side: machinesCalendar (3), the machine
 * side for steps with no machine (≤ 5), supply (5). About 30, whatever the number of steps.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { planAll, DAY } from './plannerV3Engine.js';
import { machinesCalendar } from './shiftService.js';
import { loadMachineSide, stepMinutes } from './timeEstimateService.js';
import { productionMachineIds } from './operationService.js';
import { loadSupply, evaluate, giveBack, orderKeyOf, dayWords } from './materialReadyService.js';
import { plantZone, wallOf } from './floorService.js';
import { requestApproval } from './approvalService.js';

export const MODES = ['auto', 'manual'];
export const HORIZON_DAYS = 365;
export const CONTRACTOR = 'contractor';
export const NO_TYPE = 'none';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EPS = 1e-6;
/** Milestones whose money comes as production finishes (Step 3B's triggers). */
const PRODUCTION_TRIGGERS = new Set(['production_started', 'operation_completed', 'dispatched', 'fully_dispatched', 'post_stage']);
export const REASON_LABEL = {
  material: 'Material', capacity: 'Machine busy', down: 'Machine down', start: 'Earliest start', no_capacity: 'No shift time',
  horizon: 'Beyond a year', predecessor: 'Waiting for earlier steps', other: 'Other',
};

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const pad = (n) => String(n).padStart(2, '0');
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const missingTable = (e) => e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146 || e?.code === 'ER_BAD_FIELD_ERROR' || e?.errno === 1054;
const tolerant = (p) => p.catch((e) => { if (missingTable(e)) return [[]]; throw e; });

/* ---- the clock ---------------------------------------------------------------------------------------------
 * The PLANT's wall clock (floorService.plantZone — the machine log's own), as the app stores DATETIMEs: their UTC
 * fields are the wall clock (db.js timezone 'Z'). All arithmetic on a zone-free line (UTC), so no host zone and no
 * daylight saving moves a minute. The engine's clock = minutes from 00:00 of the plant's today.
 */

let fixedNow = null;
/** Tests only: the plant's wall clock 'YYYY-MM-DD HH:MM' (or null to follow the real clock). */
export function setPlannerNow(text) { fixedNow = text ?? null; }
const dms = (s) => Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`);
const wms = (w) => Date.parse(`${String(w).replace(' ', 'T').slice(0, 19)}Z`);
const dstr = (ms) => new Date(ms).toISOString().slice(0, 10);
/** A DATETIME as read (a Date whose UTC fields are the wall clock, or text) → 'YYYY-MM-DD HH:MM:SS'. */
const dbWall = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : String(d).replace('T', ' ').slice(0, 19));
/** A DATE (a 'YYYY-MM-DD' string — db.js dateStrings) or a DATETIME → its day. */
const dayOf = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const daysBetween = (a, b) => Math.round((dms(b) - dms(a)) / 86400000);
const validDay = (s) => DATE_RE.test(s) && dstr(dms(s)) === s;

async function makeClock(db, companyId) {
  let wallNow;
  if (fixedNow) {
    const [d, t = '00:00'] = String(fixedNow).split(/[ T]/);
    wallNow = `${d} ${t.length === 5 ? `${t}:00` : t}`;
  } else wallNow = wallOf(Date.now(), await plantZone(db, companyId));
  const today = wallNow.slice(0, 10);
  const base = dms(today);
  const toClock = (v) => {
    if (v == null) return null;
    const ms = v instanceof Date ? v.getTime() : wms(v);
    return Number.isNaN(ms) ? null : (ms - base) / 60000;
  };
  const fromClock = (m) => (m == null || !Number.isFinite(m) ? null : new Date(base + Math.round(m * 60) * 1000).toISOString().slice(0, 19).replace('T', ' '));
  const dateOfClock = (m) => (m == null || !Number.isFinite(m) ? null : fromClock(m).slice(0, 10));
  const clockOfDate = (s) => (s ? daysBetween(today, s) * DAY : null);
  return { today, wallNow, now: toClock(wallNow), toClock, fromClock, dateOfClock, clockOfDate, lastDay: dstr(base + (HORIZON_DAYS - 1) * 86400000) };
}

/* ---- stage 1: everything that does not depend on another read ---------------------------------------------- */

const OPEN_PO = "po.company_id = ? AND po.deleted_at IS NULL AND po.status <> 'closed' AND o.deleted_at IS NULL AND o.status NOT IN ('closed','cancelled','lost','revised')";

async function readFacts(db, companyId, clock) {
  const toDate = clock.lastDay;
  const [
    [settingsRows], [inputRows], [poRows], [stepRows], [waitRows], [reqRows], [sessionRows], [machineRows], production,
    [acceptRows], [baseRows], [faultRows], [downRows], [pendingRows],
  ] = await Promise.all([
    tolerant(db.query('SELECT mode, last_run_at, last_run_by, last_run_mode FROM cf_plan3_settings WHERE company_id = ?', [companyId])),
    tolerant(db.query('SELECT production_order_id, earliest_start, priority_rank, pinned FROM cf_plan3_order_inputs WHERE company_id = ?', [companyId])),
    db.query(
      `SELECT po.id, po.code, po.label, po.order_id, po.order_line_id, po.status, po.seq, po.released_at,
              o.code AS order_code, o.customer_id, o.committed_date AS order_committed, o.plan_priority, o.time_override_seconds,
              l.committed_date AS line_committed
         FROM cf_production_orders po
         JOIN cf_sales_orders o ON o.id = po.order_id AND o.company_id = po.company_id
         LEFT JOIN cf_sales_order_lines l ON l.id = po.order_line_id AND l.company_id = po.company_id
        WHERE ${OPEN_PO}
        ORDER BY o.id, po.seq`,
      [companyId],
    ),
    db.query(
      `SELECT s.id, s.production_order_id AS po_id, s.production_item_id AS item_row, s.operation_id, s.sequence, s.step_name, s.quantity, s.state,
              s.qty_good, s.machine_id, s.mach_machine_id, s.started_at, s.finished_at, s.eff_minutes, s.work_order_id,
              pi.sort_order, pi.depth, pi.code AS piece_code, pi.release_id, r.order_line_id, m.name AS piece_name, op.code AS op_code, op.name AS op_name
         FROM cf_production_steps s
         JOIN cf_production_orders po ON po.id = s.production_order_id AND po.company_id = s.company_id
         JOIN cf_sales_orders o ON o.id = po.order_id AND o.company_id = po.company_id
         JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
         JOIN cf_master_records m ON m.id = pi.item_id
         JOIN cf_operations op ON op.id = s.operation_id
        WHERE s.company_id = ? AND s.deleted_at IS NULL AND ${OPEN_PO}
        ORDER BY s.production_order_id, pi.sort_order, s.sequence, s.id`,
      [companyId, companyId],
    ),
    // The waits (flow, rules, nest): on a step, or on a whole piece (every step of it).
    db.query(
      `SELECT d.step_id, d.target_step_id, d.target_item_id, d.required
         FROM cf_step_dependencies d
         JOIN cf_production_steps s ON s.id = d.step_id AND s.deleted_at IS NULL
         JOIN cf_production_orders po ON po.id = s.production_order_id AND po.company_id = s.company_id
         JOIN cf_sales_orders o ON o.id = po.order_id AND o.company_id = po.company_id
        WHERE d.company_id = ? AND d.deleted_at IS NULL AND ${OPEN_PO}`,
      [companyId, companyId],
    ),
    // Material: each requirement of a released line that a production order plans, with what is reserved for it.
    db.query(
      `SELECT q.id, q.step_id, q.production_item_id, q.item_id, q.quantity, LEAST(q.issued, q.quantity) AS issued, r.order_line_id,
              COALESCE(v.reserved, 0) AS reserved, mr.code AS item_code, mr.name AS item_name, i.uom, i.tracked_by
         FROM cf_material_requirements q
         JOIN cf_production_releases r ON r.id = q.release_id AND r.deleted_at IS NULL
         JOIN cf_master_records mr ON mr.id = q.item_id
         LEFT JOIN cf_item_details i ON i.master_id = q.item_id AND i.deleted_at IS NULL
         LEFT JOIN (SELECT v.requirement_id, SUM(v.quantity) AS reserved FROM cf_stock_reservations v
                     WHERE v.company_id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND v.requirement_id IS NOT NULL
                     GROUP BY v.requirement_id) v ON v.requirement_id = q.id
        WHERE q.company_id = ? AND q.deleted_at IS NULL AND q.release_id IN (
              SELECT DISTINCT pi.release_id FROM cf_production_items pi
                JOIN cf_production_orders po ON po.id = pi.production_order_id AND po.company_id = pi.company_id
                JOIN cf_sales_orders o ON o.id = po.order_id AND o.company_id = po.company_id
               WHERE pi.company_id = ? AND pi.deleted_at IS NULL AND ${OPEN_PO})`,
      [companyId, companyId, companyId, companyId],
    ),
    // How long a started step has run: its work sessions (an open one runs to now).
    db.query(
      `SELECT ws.step_id, SUM(TIMESTAMPDIFF(SECOND, ws.started_at, COALESCE(ws.ended_at, ?))) / 60 AS minutes
         FROM cf_work_sessions ws
         JOIN cf_production_steps s ON s.id = ws.step_id AND s.state IN ('in_progress','on_hold') AND s.deleted_at IS NULL
         JOIN cf_production_orders po ON po.id = s.production_order_id AND po.company_id = s.company_id
         JOIN cf_sales_orders o ON o.id = po.order_id AND o.company_id = po.company_id
        WHERE ws.company_id = ? AND ws.deleted_at IS NULL AND ${OPEN_PO}
        GROUP BY ws.step_id`,
      [clock.wallNow, companyId, companyId],
    ),
    db.query(
      `SELECT m.id, m.code, m.name, m.status, m.classification_id, n.name AS type_name, n.code AS type_code
         FROM cf_machines m LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
        WHERE m.company_id = ? AND m.deleted_at IS NULL`,
      [companyId],
    ),
    productionMachineIds(db, companyId),
    tolerant(db.query(
      `SELECT a.order_id, a.terms_json, a.estimate_json FROM cf_order_acceptances a
         JOIN cf_sales_orders o ON o.id = a.order_id
        WHERE a.company_id = ? AND a.status = 'approved' AND a.deleted_at IS NULL AND o.deleted_at IS NULL
        ORDER BY a.order_id, a.version`,
      [companyId],
    )),
    tolerant(db.query(
      `SELECT b.id, b.version, b.status, b.created_at, b.decided_at, bo.production_order_id, bo.planned_start, bo.planned_end
         FROM cf_plan3_baselines b
         LEFT JOIN cf_plan3_baseline_orders bo ON bo.baseline_id = b.id
        WHERE b.company_id = ? AND b.status = 'active'`,
      [companyId],
    )),
    // Open faults (a stop held by an open maintenance order): the machine is down from then on (§82).
    tolerant(db.query(
      `SELECT st.machine_id, MIN(st.started_at) AS started_at, MIN(mo.code) AS mo_code
         FROM cf_machine_stops st
         JOIN cf_maintenance_orders mo ON mo.company_id = st.company_id AND mo.deleted_at IS NULL
              AND mo.status IN ('open', 'in_progress', 'waiting_parts') AND (mo.stop_id = st.id OR mo.stop_id = st.replaces_id)
        WHERE st.company_id = ? AND st.ended_at IS NULL AND st.deleted_at IS NULL
        GROUP BY st.machine_id`,
      [companyId],
    )),
    // Planned downtime written into the calendar (§82): which machine is down on which day — only to NAME a slowdown.
    tolerant(db.query(
      `SELECT DISTINCT machine_id, exception_date FROM cf_machine_calendar_exceptions
        WHERE company_id = ? AND deleted_at IS NULL AND downtime_id IS NOT NULL AND kind = 'closed' AND exception_date BETWEEN ? AND ?`,
      [companyId, clock.today, toDate],
    )),
    tolerant(db.query(
      `SELECT b.id, b.version, b.created_at, b.note, b.approval_id, b.requested_by FROM cf_plan3_baselines b
        WHERE b.company_id = ? AND b.status = 'pending' ORDER BY b.id DESC LIMIT 1`,
      [companyId],
    )),
  ]);
  return {
    settings: settingsRows[0] ?? null, inputRows, poRows, stepRows, waitRows, reqRows, sessionRows, machineRows, production,
    acceptRows, baseRows, faultRows, downRows, pending: pendingRows[0] ?? null, toDate,
  };
}

/* ---- money: what each production order's finish unlocks ------------------------------------------------------ */

/**
 * The money of an order's milestones that come as production finishes (operation done, dispatch, post-production …,
 * or N days after one of them), from the APPROVED acceptance (terms + its estimate). Shared over the order's production
 * orders by their work minutes (equal shares when none has minutes yet).
 */
function moneyOfOrders(acceptRows) {
  const out = new Map();
  for (const a of acceptRows) {
    const terms = parseJson(a.terms_json) ?? {};
    const est = parseJson(a.estimate_json) ?? {};
    const amountOf = new Map((est.milestones ?? []).map((m) => [String(m.key), Number(m.amount) || 0]));
    let sum = 0;
    for (const m of terms.milestones ?? []) {
      const t = m?.trigger ?? {};
      const linked = PRODUCTION_TRIGGERS.has(t.type) || (t.type === 'days_after' && PRODUCTION_TRIGGERS.has(t.after));
      if (linked) sum += amountOf.get(String(m.key)) ?? 0;
    }
    out.set(Number(a.order_id), r2(sum));    // the latest approved version wins (rows come by version)
  }
  return out;
}

/* ---- the plan ----------------------------------------------------------------------------------------------- */

/**
 * Reads everything and plans it. q.mode overrides the stored mode for a look ("what would AI do?").
 * Returns the raw pieces the GET, the save and the health need.
 */
export async function buildPlan(db, companyId, q = {}) {
  const clock = await makeClock(db, companyId);
  const facts = await readFacts(db, companyId, clock);
  const storedMode = MODES.includes(facts.settings?.mode) ? facts.settings.mode : 'auto';
  const mode = MODES.includes(q.mode) ? q.mode : storedMode;

  // ---- machines and types --------------------------------------------------------------------------------------
  const machineById = new Map(facts.machineRows.map((m) => [Number(m.id), m]));
  const laneRows = facts.machineRows.filter((m) => m.status === 'active' && facts.production.has(m.id));
  const typeOfMachine = (id) => { const m = machineById.get(Number(id)); return m?.classification_id ? String(m.classification_id) : null; };
  const typeName = new Map();
  for (const m of facts.machineRows) if (m.classification_id) typeName.set(String(m.classification_id), m.type_name ?? m.type_code ?? `Machine type ${m.classification_id}`);
  const lanesPerType = new Map();
  for (const m of laneRows) { const k = String(m.classification_id); lanesPerType.set(k, (lanesPerType.get(k) ?? 0) + 1); }

  // Steps with no machine of their own: the machine types that may do their operation (the timing rules).
  const needSide = facts.stepRows.filter((s) => !s.work_order_id && s.machine_id == null && s.mach_machine_id == null);
  const ops = new Map();
  for (const s of needSide) if (!ops.has(s.operation_id)) ops.set(s.operation_id, { id: s.operation_id, code: s.op_code, name: s.op_name });

  // ---- material: needs per (line, item), and the consumers (steps) ---------------------------------------------
  const stepsOfItemRow = new Map();
  for (const s of facts.stepRows) { const k = Number(s.item_row); if (!stepsOfItemRow.has(k)) stepsOfItemRow.set(k, []); stepsOfItemRow.get(k).push(s); }
  const stepIds = new Set(facts.stepRows.map((s) => Number(s.id)));
  const needs = new Map();
  const stepNeeds = new Map();        // stepId -> Map(itemId -> qty)
  for (const r of facts.reqRows) {
    let stepId = r.step_id != null && stepIds.has(Number(r.step_id)) ? Number(r.step_id) : null;
    if (stepId == null && r.production_item_id != null) stepId = Number(stepsOfItemRow.get(Number(r.production_item_id))?.[0]?.id ?? 0) || null;
    const lineId = Number(r.order_line_id);
    if (!needs.has(lineId)) needs.set(lineId, { items: new Map() });
    const e = needs.get(lineId).items.get(Number(r.item_id)) ?? { need: 0, issued: 0, reserved: 0, item: { id: Number(r.item_id), code: r.item_code, name: r.item_name, uom: r.uom ?? null, trackedBy: r.tracked_by ?? null } };
    e.need += Number(r.quantity);
    e.issued += Number(r.issued);
    e.reserved += Math.min(Number(r.reserved), Math.max(0, Number(r.quantity) - Number(r.issued)));
    needs.get(lineId).items.set(Number(r.item_id), e);
    if (stepId == null) continue;      // a line-wide requirement no step names: it is the release's, not a step's wait
    if (!stepNeeds.has(stepId)) stepNeeds.set(stepId, new Map());
    const m = stepNeeds.get(stepId);
    m.set(Number(r.item_id), (m.get(Number(r.item_id)) ?? 0) + Number(r.quantity));
  }
  const itemIds = [...new Set(facts.reqRows.map((r) => Number(r.item_id)))];

  // ---- stage 2 ---------------------------------------------------------------------------------------------------
  const [calendars, side, supply] = await Promise.all([
    laneRows.length ? machinesCalendar(db, companyId, { from: clock.today, to: facts.toDate, machineIds: laneRows.map((m) => m.id) }) : new Map(),
    ops.size ? loadMachineSide(db, companyId, ops, clock.today) : null,
    itemIds.length ? loadSupply(db, companyId, itemIds, { needs, todayText: clock.today }) : null,
  ]);

  // ---- production orders, their steps -----------------------------------------------------------------------------
  const inputOf = new Map(facts.inputRows.map((r) => [Number(r.production_order_id), r]));
  const runOf = new Map(facts.sessionRows.map((r) => [Number(r.step_id), Number(r.minutes) || 0]));
  const sideType = (opId) => {
    const list = side?.machinesOf(opId) ?? [];
    const counts = new Map();
    for (const x of list) counts.set(String(x.typeId), (counts.get(String(x.typeId)) ?? 0) + (lanesPerType.has(String(x.typeId)) ? 1 : 0));
    const best = [...counts].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
    return best ? best[0] : null;
  };
  const steps = [];
  const stepInfo = new Map();
  const poMinutes = new Map();
  const poOfStep = new Map();
  const overrideOfPo = new Map(facts.poRows.map((p) => [Number(p.id), p.time_override_seconds == null ? null : Number(p.time_override_seconds)]));
  for (const s of facts.stepRows) {
    const po = Number(s.po_id);
    const overrideSec = overrideOfPo.get(po) ?? null;
    const qty = Number(s.quantity) || 0;
    // The order's "all times = N s" (§76) goes through the one formula: (setup + work) × quantity, N s each.
    const planned = overrideSec != null ? (stepMinutes(overrideSec / 60, overrideSec / 60, qty) ?? 0) : (s.eff_minutes == null ? null : Number(s.eff_minutes));
    const full = planned ?? 0;
    let left;
    if (s.state === 'done') left = 0;
    else if (s.state === 'pending' || (s.state === 'on_hold' && !s.started_at)) left = full * (qty > 0 ? Math.max(0, 1 - Number(s.qty_good) / qty) : 1);
    else {
      // Started: what is left = planned − elapsed (the sessions' run time; else the share of good pieces). ≤ 0 = it ends now.
      const elapsed = runOf.has(Number(s.id)) ? runOf.get(Number(s.id)) : full * (qty > 0 ? Number(s.qty_good) / qty : 0);
      left = Math.max(0, full - elapsed);
    }
    let typeKey = null;
    let machineId = null;
    if (s.work_order_id) typeKey = CONTRACTOR;
    else if (s.machine_id != null && facts.production.has(s.machine_id) && machineById.get(Number(s.machine_id))?.status === 'active') { machineId = Number(s.machine_id); typeKey = typeOfMachine(s.machine_id); }
    else if (s.machine_id != null) typeKey = typeOfMachine(s.machine_id);
    else if (s.mach_machine_id != null) typeKey = typeOfMachine(s.mach_machine_id);
    else typeKey = sideType(s.operation_id);
    const step = {
      id: Number(s.id), poId: po, typeKey: typeKey === CONTRACTOR ? null : typeKey, machineId, contractor: typeKey === CONTRACTOR,
      minutes: r3(left), state: s.state, startedAt: clock.toClock(s.started_at), finishedAt: clock.toClock(s.finished_at),
      order: Number(s.sort_order) * 10000 + Number(s.sequence),
    };
    steps.push(step);
    poOfStep.set(step.id, po);
    poMinutes.set(po, (poMinutes.get(po) ?? 0) + full);
    stepInfo.set(step.id, {
      label: `${s.piece_code ?? s.piece_name} · ${s.step_name || s.op_name}`, op: s.op_code, noRate: planned == null && s.state !== 'done',
      typeKey: typeKey ?? NO_TYPE, planned: r3(full), quantity: qty, lineId: Number(s.order_line_id), state: s.state,
    });
  }

  // Waits, as step → step. A wait on a piece = on every step of it (done: its last; started: its first).
  const waits = [];
  for (const d of facts.waitRows) {
    const req = d.required === 'started' ? 'started' : 'done';
    if (d.target_step_id) { waits.push({ stepId: Number(d.step_id), onStepId: Number(d.target_step_id), required: req }); continue; }
    for (const t of stepsOfItemRow.get(Number(d.target_item_id)) ?? []) waits.push({ stepId: Number(d.step_id), onStepId: Number(t.id), required: req });
  }

  // ---- the order of production orders ----------------------------------------------------------------------------
  const money = moneyOfOrders(facts.acceptRows);
  const minutesOfOrder = new Map();
  const posOfOrder = new Map();
  for (const p of facts.poRows) {
    const oid = Number(p.order_id);
    minutesOfOrder.set(oid, (minutesOfOrder.get(oid) ?? 0) + (poMinutes.get(Number(p.id)) ?? 0));
    posOfOrder.set(oid, (posOfOrder.get(oid) ?? 0) + 1);
  }
  const committedOf = (p) => {
    const d = p.line_committed ?? p.order_committed;
    return dayOf(d);
  };
  const leftOfPo = new Map();
  for (const s of steps) leftOfPo.set(s.poId, (leftOfPo.get(s.poId) ?? 0) + s.minutes);
  const pos = facts.poRows.map((p) => {
    const id = Number(p.id);
    const oid = Number(p.order_id);
    const total = minutesOfOrder.get(oid) ?? 0;
    const share = total > EPS ? (poMinutes.get(id) ?? 0) / total : 1 / (posOfOrder.get(oid) || 1);
    const inp = inputOf.get(id);
    const earliest = dayOf(inp?.earliest_start);
    return {
      row: p, id, orderId: oid, committed: committedOf(p), money: r2((money.get(oid) ?? 0) * share),
      rank: inp?.priority_rank == null ? null : Number(inp.priority_rank), earliest, pinned: !!Number(inp?.pinned ?? 0),
      orderPriority: p.plan_priority == null ? null : Number(p.plan_priority), left: leftOfPo.get(id) ?? 0, hasSteps: (poMinutes.has(id)),
    };
  });
  const big = Number.MAX_SAFE_INTEGER;
  const manualKey = (a, b) => (a.rank ?? big) - (b.rank ?? big) || (a.orderPriority ?? big) - (b.orderPriority ?? big);
  const sorted = [...pos].sort(mode === 'manual'
    // MANUAL: the rank Management gave, then the committed date.
    ? (a, b) => manualKey(a, b) || String(a.committed ?? '9999').localeCompare(String(b.committed ?? '9999')) || a.id - b.id
    // AUTO (by AI): pinned first (in their rank); then ① committed date ② money unlocked per hour of work left ③ the manual rank.
    : (a, b) => Number(b.pinned) - Number(a.pinned) || (a.pinned && b.pinned ? manualKey(a, b) : 0)
      || String(a.committed ?? '9999').localeCompare(String(b.committed ?? '9999'))
      || (b.money / Math.max(1, b.left / 60)) - (a.money / Math.max(1, a.left / 60))
      || manualKey(a, b) || a.id - b.id);
  const useStart = (p) => (mode === 'manual' || p.pinned) && p.earliest;
  const orders = sorted.map((p) => ({ id: p.id, earliestStart: useStart(p) ? clock.clockOfDate(p.earliest) : null }));

  // ---- machines for the engine -------------------------------------------------------------------------------------
  const dayIndex = (d) => daysBetween(clock.today, dayOf(d));
  const downDays = new Map();
  for (const r of facts.downRows) { const k = Number(r.machine_id); if (!downDays.has(k)) downDays.set(k, new Set()); downDays.get(k).add(dayIndex(r.exception_date)); }
  const faultOf = new Map(facts.faultRows.map((f) => [Number(f.machine_id), f]));
  for (const f of facts.faultRows) {
    const k = Number(f.machine_id);
    if (!downDays.has(k)) downDays.set(k, new Set());
    for (let d = Math.max(0, dayIndex(f.started_at)); d < HORIZON_DAYS; d++) downDays.get(k).add(d);
  }
  const machines = laneRows.map((m) => ({
    id: Number(m.id), code: m.code, typeKey: String(m.classification_id),
    days: (calendars.get(m.id)?.days ?? []).map((d) => d.minutes), down: [...(downDays.get(Number(m.id)) ?? [])],
  }));

  // ---- material, first come first served in the claim order the engine asks ---------------------------------------
  const lineOrder = new Map(facts.poRows.map((p) => [Number(p.id), p]));
  // Only work not begun claims material: a started step has its material (it could not have started without it).
  const stateOf = new Map(steps.map((s) => [s.id, s.state]));
  const materialStepIds = [...stepNeeds.keys()].filter((id) => stateOf.get(id) === 'pending' || stateOf.get(id) === 'on_hold');
  const materialOf = supply ? (claim) => {
    const consumers = claim.map((id) => {
      const info = stepInfo.get(id);
      const p = lineOrder.get(poOfStep.get(id));
      return { key: id, lineId: info.lineId, orderKey: orderKeyOf(p?.order_code), customerId: p?.customer_id ?? null, needs: [...stepNeeds.get(id)].map(([itemId, qty]) => ({ itemId, qty })) };
    });
    const { results, takes } = evaluate(supply, consumers);
    for (const t of takes.values()) giveBack(t);         // the same supply serves the next pass
    const out = new Map();
    for (const [id, r] of results) {
      const at = r.state === 'waiting' ? null : Math.max(clock.now, clock.clockOfDate(r.readyDate ?? clock.today));
      out.set(id, { at, text: r.state === 'ready' ? null : r.text, state: r.state });
    }
    return out;
  } : null;

  const res = planAll({ now: clock.now, horizonDays: HORIZON_DAYS, machines, orders, steps, waits, materialStepIds }, materialOf);
  return { clock, facts, mode, storedMode, pos, sorted, steps, stepInfo, res, typeName, machineById, faultOf, laneRows, calendars, supply: !!supply };
}

/* ---- words ----------------------------------------------------------------------------------------------------- */

function reasonWords(b, ctx) {
  if (!b) return null;
  const { typeName, machineById, faultOf, poLabel, clock } = ctx;
  switch (b.kind) {
    case 'material': return { kind: 'material', text: b.text ? `material — ${b.text}` : 'material', waited: b.waited ?? 0 };
    case 'capacity': {
      const who = b.behindPo != null ? poLabel(b.behindPo) : null;
      return { kind: 'capacity', text: `${typeName.get(String(b.typeKey)) ?? 'the machine'} busy${who ? ` with ${who}` : ''}`, waited: b.waited ?? 0 };
    }
    case 'down': {
      const m = machineById.get(Number(b.machineId));
      const f = faultOf.get(Number(b.machineId));
      return { kind: 'down', text: f ? `${m?.code ?? 'a machine'} is down — fault ${f.mo_code}` : `${m?.code ?? 'a machine'} has planned downtime`, waited: b.waited ?? 0 };
    }
    case 'start': return { kind: 'start', text: `its earliest start (${dayWords(clock.dateOfClock(b.at ?? 0))})`, waited: b.waited ?? 0 };
    case 'no_capacity': {
      const down = (ctx.laneRows ?? []).filter((m) => String(m.classification_id) === String(b.typeKey) && faultOf.has(Number(m.id)));
      if (down.length) return { kind: 'down', text: down.map((m) => `${m.code} is down — fault ${faultOf.get(Number(m.id)).mo_code}`).join(', '), waited: 0 };
      return { kind: 'no_capacity', text: `${typeName.get(String(b.typeKey)) ?? 'its machine type'} has no shift time`, waited: 0 };
    }
    case 'horizon': return { kind: 'horizon', text: 'it does not fit in the next year', waited: 0 };
    default: return null;
  }
}

/** The chain of what held a production order's last step back: its slowed-by reasons, biggest first. */
function slowedBy(poId, stepIdsOfPo, res, ctx) {
  const results = stepIdsOfPo.map((id) => [id, res.steps.get(id)]);
  const unplanned = results.filter(([, r]) => r.unplanned);
  let startId = null;
  if (unplanned.length) startId = unplanned[0][0];
  else {
    let best = -Infinity;
    for (const [id, r] of results) if (r.end != null && r.end > best) { best = r.end; startId = id; }
  }
  const out = new Map();
  let id = startId;
  for (let hops = 0; id != null && hops < 400; hops++) {
    const r = res.steps.get(id);
    if (!r) break;
    let b = r.binding;
    const add = (x) => {
      const w = reasonWords(x, ctx);
      if (!w) return;
      const cur = out.get(w.text);
      if (cur) cur.waited += w.waited; else out.set(w.text, { ...w });
    };
    if (b.kind === 'after') { id = b.on; continue; }
    if (b.kind === 'capacity' || b.kind === 'down') { add(b); b = b.was ?? { kind: 'now' }; }
    if (b.kind === 'predecessor') { id = b.on; continue; }
    add(b);
    break;
  }
  return [...out.values()].sort((a, b) => b.waited - a.waited).map((x) => ({ kind: x.kind, text: x.text, days: r2(x.waited / DAY) }));
}

/** The production orders' results, shaped: start, end, late, money, slowed by, against the baseline. */
function shapeOrders(plan) {
  const { clock, facts, pos, sorted, steps, res, stepInfo } = plan;
  const labelOf = new Map(pos.map((p) => [p.id, p.row.label]));
  const ctx = { ...plan, poLabel: (id) => labelOf.get(Number(id)) ?? `production order ${id}`, clock };
  const stepsOfPo = new Map();
  for (const s of steps) { if (!stepsOfPo.has(s.poId)) stepsOfPo.set(s.poId, []); stepsOfPo.get(s.poId).push(s.id); }
  const base = new Map();
  for (const b of facts.baseRows) if (b.production_order_id != null) base.set(Number(b.production_order_id), b);
  const rankOf = new Map(sorted.map((p, i) => [p.id, i + 1]));
  return pos.map((p) => {
    const ids = stepsOfPo.get(p.id) ?? [];
    let start = Infinity;
    let end = -Infinity;
    let done = 0;
    let unplanned = 0;
    let started = 0;
    let noRate = 0;
    for (const id of ids) {
      const r = res.steps.get(id);
      const info = stepInfo.get(id);
      if (info.state === 'done') done += 1;
      if (info.state === 'in_progress' || info.state === 'done') started += 1;
      if (info.noRate) noRate += 1;
      if (r.unplanned) { unplanned += 1; continue; }
      if (r.start != null && r.start < start) start = r.start;
      if (r.end != null && r.end > end) end = r.end;
    }
    const finished = ids.length > 0 && done === ids.length;
    const endText = unplanned || !ids.length ? null : clock.fromClock(end);
    const startText = ids.length && Number.isFinite(start) ? clock.fromClock(start) : null;
    const late = !!(endText && p.committed && endText.slice(0, 10) > p.committed);
    const b = base.get(p.id);
    const baseEnd = b?.planned_end ? clock.fromClock(clock.toClock(b.planned_end)) : null;
    const slipDays = baseEnd && endText ? daysBetween(baseEnd, endText) : null;
    return {
      id: p.id, code: p.row.code, label: p.row.label, orderId: p.orderId, orderCode: p.row.order_code,
      status: p.row.status, released: p.row.status !== 'yet_to_plan',
      state: !ids.length ? 'not_released' : finished ? 'finished' : started ? 'in_production' : 'planned',
      rank: rankOf.get(p.id), manual: { earliestStart: p.earliest, rank: p.rank, pinned: p.pinned },
      committedDate: p.committed, money: p.money, minutesLeft: r3(p.left),
      steps: ids.length, stepsDone: done, unplanned, noRate,
      start: startText, end: endText, late,
      baseline: b ? { start: b.planned_start ? clock.fromClock(clock.toClock(b.planned_start)) : null, end: baseEnd } : null,
      slipDays,
      slowedBy: ids.length ? slowedBy(p.id, ids, res, ctx).slice(0, 3) : [],
      waitingFor: !ids.length ? 'Release it to plan it — a production order Yet to plan has no steps yet.' : unplanned ? 'Some steps cannot be planned yet (see slowed by).' : null,
    };
  });
}

/** Per machine type, per day: capacity and planned load (minutes), and which production orders. */
function shapeTypes(plan, days) {
  const { res, steps, stepInfo, typeName, laneRows, calendars, clock } = plan;
  const types = new Map();
  const ensure = (key, name) => {
    if (!types.has(key)) types.set(key, { key, name, machines: [], capacity: new Array(days).fill(0), load: new Array(days).fill(0), byPo: new Array(days).fill(null).map(() => ({})) });
    return types.get(key);
  };
  for (const m of laneRows) {
    const t = ensure(String(m.classification_id), typeName.get(String(m.classification_id)) ?? `Machine type ${m.classification_id}`);
    const cal = calendars.get(m.id);
    t.machines.push({ id: Number(m.id), code: m.code, name: m.name, hasShifts: !!cal?.hasShifts, down: plan.faultOf.has(Number(m.id)) });
    (cal?.days ?? []).slice(0, days).forEach((d, i) => { t.capacity[i] += d.minutes; });
  }
  // A step's minutes are laid on its days in proportion to the clock it spans (a step may span days).
  for (const s of steps) {
    const r = res.steps.get(s.id);
    if (!r || r.unplanned || r.real || r.start == null || r.end == null) continue;
    const info = stepInfo.get(s.id);
    const key = s.contractor ? CONTRACTOR : String(info.typeKey);
    const t = ensure(key, key === CONTRACTOR ? 'Contractors' : key === NO_TYPE ? 'No machine type' : typeName.get(key) ?? `Machine type ${key}`);
    const from = Math.max(r.start, clock.now);
    const span = r.end - from;
    if (!(s.minutes > EPS)) continue;
    for (let d = Math.max(0, Math.floor(from / DAY)); d <= Math.min(days - 1, Math.floor((r.end - 1e-9) / DAY)); d++) {
      const part = span <= EPS ? 1 : (Math.min(r.end, (d + 1) * DAY) - Math.max(from, d * DAY)) / span;
      if (!(part > 0)) continue;
      const m = s.minutes * part;
      t.load[d] += m;
      t.byPo[d][s.poId] = (t.byPo[d][s.poId] ?? 0) + m;
    }
  }
  return [...types.values()].map((t) => ({
    ...t, capacity: t.capacity.map(r3), load: t.load.map(r3),
    byPo: t.byPo.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r3(v)]))),
    unlimited: t.key === CONTRACTOR || t.key === NO_TYPE,
  })).sort((a, b) => Number(a.unlimited) - Number(b.unlimited) || a.name.localeCompare(b.name));
}

/** On time vs the baseline, slip by reason — the same for the live plan (GET) and the saved one (health). */
export function healthOf(rows) {
  const compared = rows.filter((r) => r.baselineEnd != null);
  const late = compared.filter((r) => r.end == null || (r.slipDays ?? 0) > 0);
  const byReason = new Map();
  for (const r of late) {
    const k = r.reasonKind ?? 'other';
    const e = byReason.get(k) ?? { kind: k, label: REASON_LABEL[k] ?? k, orders: 0, days: 0 };
    e.orders += 1;
    e.days += Math.max(0, r.slipDays ?? 0);
    byReason.set(k, e);
  }
  return {
    compared: compared.length, onTime: compared.length - late.length, late: late.length,
    onTimePct: compared.length ? Math.round(((compared.length - late.length) / compared.length) * 100) : null,
    slipDays: late.reduce((t, r) => t + Math.max(0, r.slipDays ?? 0), 0),
    byReason: [...byReason.values()].sort((a, b) => b.days - a.days || b.orders - a.orders),
    worst: [...late].sort((a, b) => (b.slipDays ?? 1e9) - (a.slipDays ?? 1e9)).slice(0, 5)
      .map((r) => ({ id: r.id, code: r.code, label: r.label, slipDays: r.slipDays, reason: r.reasonText ?? null })),
  };
}

/* ---- GET /planner3 -------------------------------------------------------------------------------------------- */

export async function getPlanner3(db, companyId, q = {}) {
  const plan = await buildPlan(db, companyId, q);
  const { clock, res, steps, stepInfo, facts } = plan;
  const orders = shapeOrders(plan);
  let lastEnd = 0;
  for (const s of steps) { const r = res.steps.get(s.id); if (r?.end != null && Number.isFinite(r.end)) lastEnd = Math.max(lastEnd, r.end); }
  const days = Math.min(HORIZON_DAYS, Math.max(14, Math.ceil(lastEnd / DAY) + 2));
  const dayList = Array.from({ length: days }, (_, i) => clock.dateOfClock(i * DAY));
  const wantSteps = q.steps === '1' || q.steps === true || !blank(q.po);
  const onlyPo = blank(q.po) ? null : Number(q.po);
  const stepRows = wantSteps ? steps.filter((s) => onlyPo == null || s.poId === onlyPo).map((s) => {
    const r = res.steps.get(s.id);
    const info = stepInfo.get(s.id);
    const w = r.unplanned ? reasonWords(r.binding, { ...plan, poLabel: (id) => String(id), clock }) : null;
    return {
      id: s.id, productionOrderId: s.poId, label: info.label, operation: info.op, typeKey: s.contractor ? CONTRACTOR : info.typeKey,
      machineId: r.machineId ?? null, state: info.state, minutes: s.minutes, planned: info.planned, noRate: info.noRate,
      start: clock.fromClock(r.start), end: clock.fromClock(r.end), real: !!r.real, binding: r.binding?.kind ?? null,
      why: r.unplanned ? (w?.text ?? (r.binding?.kind === 'after' ? 'an earlier step cannot be planned' : 'cannot be planned')) : null,
    };
  }) : undefined;
  const baseline = facts.baseRows[0] ? { id: facts.baseRows[0].id, version: facts.baseRows[0].version, savedAt: dbWall(facts.baseRows[0].created_at), approvedAt: dbWall(facts.baseRows[0].decided_at) } : null;
  const live = healthOf(orders.map((o) => ({ ...o, baselineEnd: o.baseline?.end ?? null, reasonKind: o.slowedBy[0]?.kind ?? null, reasonText: o.slowedBy[0]?.text ?? null })));
  return {
    today: clock.today, now: clock.fromClock(clock.now), mode: plan.mode, storedMode: plan.storedMode,
    madeBy: plan.mode === 'auto' ? 'AI' : 'Management',
    days: dayList, horizonDays: HORIZON_DAYS, passes: res.passes,
    productionOrders: orders.sort((a, b) => a.rank - b.rank),
    machineTypes: shapeTypes(plan, days),
    steps: stepRows,
    baseline, pendingRebaseline: facts.pending ? { id: facts.pending.id, version: facts.pending.version, askedAt: dbWall(facts.pending.created_at), note: facts.pending.note, approvalId: facts.pending.approval_id } : null,
    saved: facts.settings?.last_run_at ? { at: dbWall(facts.settings.last_run_at), mode: facts.settings.last_run_mode ?? null } : null,
    health: baseline ? live : null,
    counts: { productionOrders: orders.length, steps: steps.length, unplanned: orders.reduce((t, o) => t + o.unplanned, 0), late: orders.filter((o) => o.late).length },
  };
}

/* ---- writes ----------------------------------------------------------------------------------------------------- */

export async function putSettings(db, c, input = {}) {
  if (!MODES.includes(input.mode)) throw invalid('INVALID', 'Mode is auto or manual.');
  await db.query(
    'INSERT INTO cf_plan3_settings (company_id, mode, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mode = VALUES(mode), updated_by = VALUES(updated_by)',
    [c.companyId, input.mode, c.userId ?? null],
  );
  return { mode: input.mode };
}

/** PUT /planner3/orders — Management's inputs per production order, set-based (2 round trips for any number). */
export async function putOrderInputs(db, c, input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : null;
  if (!rows?.length) throw invalid('INVALID', 'Send rows: [{ id, earliestStart, rank, pinned }].');
  if (rows.length > 5000) throw invalid('INVALID', 'At most 5000 rows at a time.');
  const problems = [];
  const clean = rows.map((r, i) => {
    const id = Number(r?.id);
    if (!Number.isInteger(id) || id < 1) problems.push(`Row ${i + 1}: which production order?`);
    const es = blank(r?.earliestStart) ? null : String(r.earliestStart);
    if (es && !validDay(es)) problems.push(`Row ${i + 1}: the earliest start needs a date (YYYY-MM-DD).`);
    const rank = r?.rank == null || r.rank === '' ? null : Number(r.rank);
    if (rank != null && (!Number.isInteger(rank) || rank < 1 || rank > 100000)) problems.push(`Row ${i + 1}: the rank is a whole number from 1.`);
    return { id, es, rank, pinned: r?.pinned ? 1 : 0, has: { es: 'earliestStart' in (r ?? {}), rank: 'rank' in (r ?? {}), pinned: 'pinned' in (r ?? {}) } };
  });
  assertNoProblems(problems);
  const ids = [...new Set(clean.map((r) => r.id))];
  // The production orders and what is stored for them, in one read: a field not sent keeps what is stored.
  const [found] = await db.query(
    `SELECT po.id, i.earliest_start, i.priority_rank, i.pinned FROM cf_production_orders po
       LEFT JOIN cf_plan3_order_inputs i ON i.company_id = po.company_id AND i.production_order_id = po.id
      WHERE po.company_id = ? AND po.id IN (?) AND po.deleted_at IS NULL`,
    [c.companyId, ids],
  );
  const have = new Map(found.map((r) => [Number(r.id), r]));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length) throw notFound(`Production order ${missing.join(', ')}`);
  const merged = new Map();
  for (const r of clean) {
    const was = merged.get(r.id) ?? (() => {
      const h = have.get(r.id);
      return { es: dayOf(h.earliest_start), rank: h.priority_rank == null ? null : Number(h.priority_rank), pinned: Number(h.pinned ?? 0) };
    })();
    merged.set(r.id, { es: r.has.es ? r.es : was.es, rank: r.has.rank ? r.rank : was.rank, pinned: r.has.pinned ? r.pinned : was.pinned });
  }
  const values = [...merged].map(([id, v]) => [c.companyId, id, v.es, v.rank, v.pinned, c.userId ?? null]);
  await db.query(
    `INSERT INTO cf_plan3_order_inputs (company_id, production_order_id, earliest_start, priority_rank, pinned, updated_by) VALUES ?
     ON DUPLICATE KEY UPDATE earliest_start = VALUES(earliest_start), priority_rank = VALUES(priority_rank), pinned = VALUES(pinned), updated_by = VALUES(updated_by)`,
    [values],
  );
  return { saved: merged.size, rows: [...merged].map(([id, v]) => ({ id, earliestStart: v.es, rank: v.rank, pinned: !!v.pinned })) };
}

/**
 * POST /planner3/run — SAVE the plan: every step's and production order's planned dates (replaced, set-based), the
 * mode it was made in, and — when there is no baseline yet — the BASELINE (saved at the first plan, no approval).
 */
export async function savePlan(db, c, input = {}, { reader = db } = {}) {
  const mode = MODES.includes(input.mode) ? input.mode : undefined;
  const plan = await buildPlan(reader, c.companyId, { mode });
  const orders = shapeOrders(plan);
  const { clock, res, steps, stepInfo } = plan;
  const runAt = clock.fromClock(clock.now);
  await Promise.all([
    db.query('DELETE FROM cf_plan3_steps WHERE company_id = ?', [c.companyId]),
    db.query('DELETE FROM cf_plan3_orders WHERE company_id = ?', [c.companyId]),
  ]);
  const stepVals = steps.map((s) => {
    const r = res.steps.get(s.id);
    return [c.companyId, s.id, s.poId, r.machineId ?? null, s.contractor ? CONTRACTOR : String(stepInfo.get(s.id).typeKey).slice(0, 20),
      clock.fromClock(r.start), clock.fromClock(r.end), String(r.binding?.kind ?? '').slice(0, 20) || null];
  });
  const orderVals = orders.map((o) => [c.companyId, o.id, o.start, o.end, o.money, o.late ? 1 : 0, o.slowedBy[0]?.kind ?? null,
    o.slowedBy.map((x) => x.text).join('; ').slice(0, 500) || null, o.minutesLeft, o.unplanned, o.rank, runAt]);
  await Promise.all([
    insertRows(db, 'cf_plan3_steps', ['company_id', 'step_id', 'production_order_id', 'machine_id', 'type_key', 'planned_start', 'planned_end', 'binding'], stepVals, 2000),
    insertRows(db, 'cf_plan3_orders', ['company_id', 'production_order_id', 'planned_start', 'planned_end', 'money', 'late', 'reason_kind', 'reason_text', 'minutes_left', 'unplanned', 'rank_no', 'run_at'], orderVals, 1000),
    db.query(
      `INSERT INTO cf_plan3_settings (company_id, mode, last_run_at, last_run_by, last_run_mode) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_run_at = VALUES(last_run_at), last_run_by = VALUES(last_run_by), last_run_mode = VALUES(last_run_mode)`,
      [c.companyId, plan.storedMode, runAt, c.userId ?? null, plan.mode],
    ),
  ]);
  let baseline = null;
  if (!plan.facts.baseRows.length) {
    const [ins] = await db.query(
      "INSERT INTO cf_plan3_baselines (company_id, version, status, note, requested_by, decided_at) VALUES (?, 1, 'active', 'Saved at the first plan.', ?, NOW())",
      [c.companyId, c.userId ?? null],
    );
    await copyPlanToBaseline(db, c.companyId, ins.insertId);
    baseline = { id: ins.insertId, version: 1, first: true };
  }
  return {
    saved: { at: runAt, mode: plan.mode, madeBy: plan.mode === 'auto' ? 'AI' : 'Management', steps: steps.length, productionOrders: orders.length },
    baseline,
    late: orders.filter((o) => o.late).length,
    unplanned: orders.reduce((t, o) => t + o.unplanned, 0),
  };
}

/** The saved plan's production order dates become a baseline's. 1 write. */
async function copyPlanToBaseline(db, companyId, baselineId) {
  await db.query(
    `INSERT INTO cf_plan3_baseline_orders (baseline_id, company_id, production_order_id, planned_start, planned_end, money)
     SELECT ?, company_id, production_order_id, planned_start, planned_end, money FROM cf_plan3_orders WHERE company_id = ?`,
    [baselineId, companyId],
  );
}

/**
 * POST /planner3/rebaseline { note } — ask Management to make the SAVED plan the new baseline. The pending baseline is
 * the saved plan as it is now (copied), so what Management approves is what was asked. One pending at a time.
 */
export async function askRebaseline(db, c, input = {}) {
  const note = blank(input.note) ? null : String(input.note).trim().slice(0, 500);
  if (!note) throw invalid('REASON', 'Say why the baseline should move — Management reads it.');
  const [[saved], [[pend]], [[act]]] = await Promise.all([
    db.query('SELECT COUNT(*) AS n, MAX(run_at) AS at FROM cf_plan3_orders WHERE company_id = ?', [c.companyId]),
    db.query("SELECT id FROM cf_plan3_baselines WHERE company_id = ? AND status = 'pending' LIMIT 1 FOR UPDATE", [c.companyId]),
    db.query("SELECT id, version FROM cf_plan3_baselines WHERE company_id = ? AND status = 'active' LIMIT 1", [c.companyId]),
  ]);
  if (!Number(saved[0]?.n)) throw invalid('NO_PLAN', 'Save a plan first — the baseline is made from the saved plan.');
  if (pend) throw invalid('PENDING', 'A re-baseline is already waiting for Management.');
  if (!act) throw invalid('NO_BASELINE', 'There is no baseline yet — saving the plan makes the first one.');
  const [[ver]] = await db.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM cf_plan3_baselines WHERE company_id = ?', [c.companyId]);
  const [ins] = await db.query(
    "INSERT INTO cf_plan3_baselines (company_id, version, status, note, requested_by) VALUES (?, ?, 'pending', ?, ?)",
    [c.companyId, Number(ver.v), note, c.userId ?? null],
  );
  await copyPlanToBaseline(db, c.companyId, ins.insertId);
  const ctx = (await rebaselineContexts(db, c.companyId, [{ id: 0, subject: { id: ins.insertId } }])).get(0);
  const approvalId = await requestApproval(db, c, {
    type: 'rebaseline', subjectId: ins.insertId, subjectCode: `Baseline v${ver.v}`, title: `Re-baseline the plan (v${act.version} → v${ver.v})`,
    summary: ctx?.summary ?? null, note, context: ctx ?? null,
  });
  await db.query('UPDATE cf_plan3_baselines SET approval_id = ? WHERE company_id = ? AND id = ?', [approvalId, c.companyId, ins.insertId]);
  return { baseline: { id: ins.insertId, version: Number(ver.v), status: 'pending' }, approvalId };
}

/** What Management sees on a re-baseline: how many production orders move, and by how much. 1 read for all rows. */
async function rebaselineContexts(db, companyId, rows) {
  const out = new Map();
  const ids = [...new Set(rows.map((r) => Number(r.subject?.id)).filter(Boolean))];
  if (!ids.length) return out;
  const [list] = await db.query(
    `SELECT nb.baseline_id, nb.production_order_id, nb.planned_end AS new_end, ob.planned_end AS old_end, po.code, po.label
       FROM cf_plan3_baseline_orders nb
       JOIN cf_production_orders po ON po.id = nb.production_order_id
       LEFT JOIN cf_plan3_baselines a ON a.company_id = nb.company_id AND a.status = 'active'
       LEFT JOIN cf_plan3_baseline_orders ob ON ob.baseline_id = a.id AND ob.production_order_id = nb.production_order_id
      WHERE nb.company_id = ? AND nb.baseline_id IN (?)`,
    [companyId, ids],
  );
  const byBase = new Map();
  for (const r of list) { const k = Number(r.baseline_id); if (!byBase.has(k)) byBase.set(k, []); byBase.get(k).push(r); }
  for (const r of rows) {
    const items = byBase.get(Number(r.subject?.id)) ?? [];
    const moves = items.map((x) => ({
      code: x.code, label: x.label,
      from: dayOf(dbWall(x.old_end)), to: dayOf(dbWall(x.new_end)),
      days: x.old_end && x.new_end ? daysBetween(dayOf(dbWall(x.old_end)), dayOf(dbWall(x.new_end))) : null,
    }));
    const later = moves.filter((m) => (m.days ?? 0) > 0);
    out.set(r.id, {
      kind: 'rebaseline', productionOrders: moves.length, later: later.length, earlier: moves.filter((m) => (m.days ?? 0) < 0).length,
      slipDays: later.reduce((t, m) => t + m.days, 0), moves: moves.filter((m) => m.days !== 0).slice(0, 50),
      summary: `${moves.length} production order${moves.length === 1 ? '' : 's'}; ${later.length} end later (${later.reduce((t, m) => t + m.days, 0)} days in all).`,
    });
  }
  return out;
}

/** approvalService's handler for 'rebaseline' (HANDLERS loads it on first use). */
export const rebaselineApprovalHandler = {
  async onApprove(db, c, row) {
    await db.query("UPDATE cf_plan3_baselines SET status = 'superseded' WHERE company_id = ? AND status = 'active'", [c.companyId]);
    await db.query("UPDATE cf_plan3_baselines SET status = 'active', decided_at = NOW(), decided_by = ? WHERE company_id = ? AND id = ? AND status = 'pending'",
      [c.userId ?? null, c.companyId, Number(row.subject_id)]);
    return { baseline: Number(row.subject_id), status: 'active' };
  },
  async onReject(db, c, row) {
    await db.query("UPDATE cf_plan3_baselines SET status = 'rejected', decided_at = NOW(), decided_by = ? WHERE company_id = ? AND id = ? AND status = 'pending'",
      [c.userId ?? null, c.companyId, Number(row.subject_id)]);
    return { baseline: Number(row.subject_id), status: 'rejected' };
  },
  async onWithdraw(db, c, row) {
    await db.query("UPDATE cf_plan3_baselines SET status = 'withdrawn', decided_at = NOW() WHERE company_id = ? AND id = ? AND status = 'pending'", [c.companyId, Number(row.subject_id)]);
  },
  context: rebaselineContexts,
};

/** GET /planner3/health — PLAN HEALTH for the Management dashboard: the SAVED plan vs the active baseline. 2 reads. */
export async function planHealth(db, companyId) {
  const [[base], [rows]] = await Promise.all([
    tolerant(db.query("SELECT id, version, created_at, decided_at FROM cf_plan3_baselines WHERE company_id = ? AND status = 'active' LIMIT 1", [companyId])),
    tolerant(db.query(
      `SELECT po.id, po.code, po.label, p.planned_end, p.reason_kind, p.reason_text, p.run_at, bo.planned_end AS base_end
         FROM cf_plan3_orders p
         JOIN cf_production_orders po ON po.id = p.production_order_id AND po.deleted_at IS NULL
         LEFT JOIN cf_plan3_baselines b ON b.company_id = p.company_id AND b.status = 'active'
         LEFT JOIN cf_plan3_baseline_orders bo ON bo.baseline_id = b.id AND bo.production_order_id = p.production_order_id
        WHERE p.company_id = ?`,
      [companyId],
    )),
  ]);
  const b = base[0] ?? null;
  const day = (v) => dayOf(dbWall(v));
  const shaped = rows.map((r) => ({
    id: r.id, code: r.code, label: r.label, end: day(r.planned_end), baselineEnd: day(r.base_end),
    slipDays: r.planned_end && r.base_end ? daysBetween(day(r.base_end), day(r.planned_end)) : null,
    reasonKind: r.reason_kind ?? null, reasonText: r.reason_text ?? null,
  }));
  return {
    baseline: b ? { id: b.id, version: b.version, savedAt: dbWall(b.created_at), approvedAt: dbWall(b.decided_at) } : null,
    savedAt: dbWall(rows[0]?.run_at),
    ...healthOf(shaped),
  };
}
