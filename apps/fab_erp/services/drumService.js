// drumService.js — EU-9: the multi-project DRUM (CCPM "drum-buffer-rope").
//
// Across ALL active (status='baselined') sales-order plans, one resource TYPE is the
// system constraint — the drum. This module (1) auto-DETECTS that constraint by
// days-of-backlog, (2) SEQUENCES the projects onto the drum's single timeline (the
// "rope"), staggering their start so the constraint is never double-booked, and
// (3) shifts each plan's committed_finish to reflect when it can actually finish once
// it gets the drum. It persists the single fab_cc_drum row and rewrites
// fab_cc_drum_slots; it NEVER consumes buffer (adding work moves dates only — a
// locked CCPM decision), so consumed/buffer columns are never written here.
//
// Calendar math is NOT reinvented — it reuses taskWaitService's public helpers the
// same chunked way criticalChainService/resourceLevelingService do (neither exports
// an "advance a datetime by N working-minutes" helper, so the small loop is
// replicated below).

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import {
  resolveTaskPlantId,
  resolveCalendarIds,
  workingIntervalsInWindow,
} from './taskWaitService.js';

// ─── capacity fallbacks (documented) ───────────────────────────────────────────
// When a resource type declares no concurrency / no daily capacity, normalize with
// conservative defaults so days-of-backlog never divides by zero or goes NaN:
//   num_units          missing/≤0 ⇒ 1   (a single unit)
//   capacity_hrs_per_day missing/≤0 ⇒ 8 (480 working-minutes/day, one shift)
const DEFAULT_NUM_UNITS = 1;
const DEFAULT_CAP_HRS_PER_DAY = 8;
// A new type must beat the CURRENT drum's normalized load by this margin to steal the
// drum — hysteresis against flip-flop under the auto-detect choice.
const HYSTERESIS_MARGIN = 1.15;

// ─── helpers ───────────────────────────────────────────────────────────────────

// UTC 'YYYY-MM-DD HH:MM:SS' (mirrors criticalChainService.toDateTimeStr).
function toDateTimeStr(d) {
  return d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

const CHUNK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCAN_MS = 366 * 24 * 60 * 60 * 1000;

// Load minutes of a task: computed_hours × 60, rounded; 0 for null/≤0.
function taskLoadMinutes(task) {
  const h = Number(task.computed_hours);
  return h > 0 ? Math.round(h * 60) : 0;
}

/**
 * Advance `from` forward by `minutes` WORKING minutes across the given calendars.
 * Replicates criticalChainService.advanceWorkingMinutes (not exported there): with no
 * calendars (or non-positive minutes) it degrades to a wall-clock add — the same
 * optimistic 24/7 fallback EU-2/EU-3 use when no shift calendar resolves.
 */
async function advanceWorkingMinutes(companyId, calendarIds, from, minutes) {
  if (calendarIds.length === 0 || !(minutes > 0)) {
    return new Date(from.getTime() + Math.max(0, minutes) * 60000);
  }
  let remaining = minutes;
  let windowStart = new Date(from.getTime());
  let scanned = 0;
  while (remaining > 1e-9) {
    if (scanned > MAX_SCAN_MS) {
      throw new Error(
        `drumService: could not advance ${minutes} working minutes within ${MAX_SCAN_MS / 86400000} days after ${from.toISOString()} for calendars [${calendarIds.join(', ')}]`,
      );
    }
    const windowEnd = new Date(windowStart.getTime() + CHUNK_MS);
    const ivs = await workingIntervalsInWindow(companyId, calendarIds, windowStart, windowEnd);
    for (const iv of ivs) {
      const lenMin = (iv.end.getTime() - iv.start.getTime()) / 60000;
      if (remaining <= lenMin + 1e-9) {
        return new Date(iv.start.getTime() + remaining * 60000);
      }
      remaining -= lenMin;
    }
    windowStart = windowEnd;
    scanned += CHUNK_MS;
  }
  return new Date(windowStart.getTime());
}

/**
 * Load the per-company lookups drum math needs:
 *   typeCap:  typeId → { numUnits, capHrs, dailyCapMin }  (with fallbacks applied)
 *   resType:  resourceId → resource_type_id  (to map a pinned task to its type)
 */
async function loadTypeContext(companyId) {
  const [typeRows] = await pool.query(
    `SELECT id, num_units, capacity_hrs_per_day
       FROM fab_resource_types WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const [resRows] = await pool.query(
    `SELECT id, resource_type_id FROM fab_resources WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const typeCap = new Map();
  for (const r of typeRows) {
    const units = Number(r.num_units) > 0 ? Number(r.num_units) : DEFAULT_NUM_UNITS;
    const capHrs = Number(r.capacity_hrs_per_day) > 0 ? Number(r.capacity_hrs_per_day) : DEFAULT_CAP_HRS_PER_DAY;
    typeCap.set(Number(r.id), { numUnits: units, capHrs, dailyCapMin: units * capHrs * 60 });
  }
  const resType = new Map();
  for (const r of resRows) {
    if (r.resource_type_id != null) resType.set(Number(r.id), Number(r.resource_type_id));
  }
  return { typeCap, resType };
}

// Daily capacity (working-minutes) of a type, with fallbacks even for an unknown type.
function dailyCapMinFor(typeCap, typeId) {
  const c = typeCap.get(Number(typeId));
  if (c) return c.dailyCapMin;
  return DEFAULT_NUM_UNITS * DEFAULT_CAP_HRS_PER_DAY * 60;
}

/**
 * The resource TYPE a task loads: its own resource_type_id if set, else the type of
 * its pinned resource. Returns null for a fully unconstrained task (contributes to no
 * type's backlog). Preferring resource_type_id when present avoids double-counting.
 */
function effectiveTypeId(task, resType) {
  if (task.resource_type_id != null) return Number(task.resource_type_id);
  if (task.assigned_resource_id != null) {
    const t = resType.get(Number(task.assigned_resource_id));
    if (t != null) return t;
  }
  return null;
}

/**
 * The distinct order ids of active (baselined) SALES-order plans. Deduped to one plan
 * per order (max plan id — EU-3 supersedes older baselines, so this is normally 1:1),
 * returned deterministically ordered.
 */
async function loadActiveSalesOrderIds(companyId) {
  const [rows] = await pool.query(
    `SELECT p.order_id AS orderId, MAX(p.id) AS planId
       FROM fab_cc_plans p
       JOIN fab_orders o ON o.id = p.order_id AND o.company_id = p.company_id AND o.deleted_at IS NULL
      WHERE p.company_id = ? AND p.status = 'baselined' AND p.deleted_at IS NULL
        AND o.order_type = 'sales'
      GROUP BY p.order_id
      ORDER BY p.order_id ASC`,
    [companyId],
  );
  return rows.map((r) => ({ orderId: Number(r.orderId), planId: Number(r.planId) }));
}

// ─── 1. detectDrum ──────────────────────────────────────────────────────────────

/**
 * Pick the constraint resource TYPE across all active sales-order plans and upsert the
 * single fab_cc_drum row.
 *
 * Load per type = Σ(computed_hours×60) over NOT-done tasks (status NOT IN
 * ('done','cancelled')) of every baselined sales order, grouped by each task's
 * effective type. Normalized load = raw load ÷ daily capacity (days-of-backlog). The
 * drum is the type with the highest normalized load (tie-break: lower type id).
 *
 * HYSTERESIS: keep the CURRENT drum type unless a challenger's normalized load exceeds
 * the current drum's by ≥15% — prevents the auto-detect from flip-flopping between two
 * near-equal constraints.
 *
 * @returns {Promise<{resourceTypeId:number|null, drumId:number|null, loadMinutes:number}>}
 */
export async function detectDrum(companyId) {
  const { typeCap, resType } = await loadTypeContext(companyId);
  const orders = await loadActiveSalesOrderIds(companyId);

  // Aggregate raw load per type over not-done tasks of the active sales orders.
  const rawByType = new Map(); // typeId -> minutes
  if (orders.length > 0) {
    const orderIds = orders.map((o) => o.orderId);
    const [tasks] = await pool.query(
      `SELECT resource_type_id, assigned_resource_id, computed_hours
         FROM fab_project_tasks
        WHERE company_id = ? AND order_id IN (?)
          AND status NOT IN ('done','cancelled') AND deleted_at IS NULL`,
      [companyId, orderIds],
    );
    for (const t of tasks) {
      const tid = effectiveTypeId(t, resType);
      if (tid == null) continue; // unconstrained task — belongs to no type's backlog
      rawByType.set(tid, (rawByType.get(tid) || 0) + taskLoadMinutes(t));
    }
  }

  // Winner by normalized load (days-of-backlog); deterministic tie-break by lower id.
  let winner = null; // { typeId, raw, norm }
  const typeIds = [...rawByType.keys()].sort((a, b) => a - b);
  for (const tid of typeIds) {
    const raw = rawByType.get(tid);
    const norm = raw / dailyCapMinFor(typeCap, tid);
    if (winner === null || norm > winner.norm) winner = { typeId: tid, raw, norm };
  }

  // Current drum (the one active row per company).
  const [[current]] = await pool.query(
    `SELECT id, resource_type_id FROM fab_cc_drum WHERE company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId],
  );

  // Decide the drum type under hysteresis.
  let chosenTypeId;
  if (winner === null) {
    // No load anywhere: keep the current drum if one exists, else nothing to detect.
    chosenTypeId = current ? Number(current.resource_type_id) : null;
  } else if (!current) {
    chosenTypeId = winner.typeId; // no incumbent — adopt the winner outright
  } else if (Number(current.resource_type_id) === winner.typeId) {
    chosenTypeId = winner.typeId; // winner already is the drum
  } else {
    // Only switch if the challenger beats the CURRENT drum's normalized load by ≥15%.
    const curRaw = rawByType.get(Number(current.resource_type_id)) || 0;
    const curNorm = curRaw / dailyCapMinFor(typeCap, Number(current.resource_type_id));
    chosenTypeId = winner.norm >= curNorm * HYSTERESIS_MARGIN ? winner.typeId : Number(current.resource_type_id);
  }

  if (chosenTypeId == null) {
    return { resourceTypeId: null, drumId: current ? Number(current.id) : null, loadMinutes: 0 };
  }

  // load_minutes = the chosen type's raw backlog minutes.
  const loadMinutes = rawByType.get(chosenTypeId) || 0;

  // Upsert the single row (UPDATE keeps drumId stable for any external references).
  let drumId;
  if (current) {
    await pool.query(
      `UPDATE fab_cc_drum
          SET resource_type_id = ?, load_minutes = ?, method = 'auto', computed_at = NOW()
        WHERE id = ?`,
      [chosenTypeId, loadMinutes, current.id],
    );
    drumId = Number(current.id);
  } else {
    const [ins] = await pool.query(
      `INSERT INTO fab_cc_drum (company_id, resource_type_id, load_minutes, method, computed_at)
       VALUES (?, ?, ?, 'auto', NOW())`,
      [companyId, chosenTypeId, loadMinutes],
    );
    drumId = ins.insertId;
  }

  return { resourceTypeId: chosenTypeId, drumId, loadMinutes };
}

// ─── 2. sequenceProjects ────────────────────────────────────────────────────────

/**
 * The rope: stagger the active sales projects on the drum's single timeline and shift
 * their committed_finish. Rewrites fab_cc_drum_slots and updates each plan's
 * drum_planned_start + committed_finish inside one transaction.
 *
 * Order: committed projects (any task on the drum type in_progress OR done) are FROZEN
 * at the FRONT in required_date order — an already-started project cannot be bumped off
 * the constraint by a newer, earlier-due one. Unstarted projects queue strictly behind,
 * also by required_date (NULLs last), tie-broken by order id.
 *
 * finish shift: committed_finish = advanceWorkingMinutes(drum_planned_start,
 * chain_length_minutes + project_buffer_minutes) — once a project gets the drum it needs
 * its critical-chain length plus project buffer to finish. Monotonic in the drum start.
 * This is a DATE shift only — consumed/buffer columns are never touched (locked CCPM
 * decision: adding work moves dates, never consumes buffer).
 *
 * @param {{resourceTypeId:number|null, drumId:number|null}} drum
 */
export async function sequenceProjects(companyId, drum) {
  const now = new Date();
  const drumTypeId = drum ? drum.resourceTypeId : null;
  const drumId = drum ? drum.drumId : null;

  // No drum (no load anywhere / no incumbent): clear any stale slots and stop.
  if (drumTypeId == null || drumId == null) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM fab_cc_drum_slots WHERE company_id = ?`, [companyId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    return { drumId, resourceTypeId: null, projectCount: 0, committedCount: 0 };
  }

  const { resType } = await loadTypeContext(companyId);

  // Active sales plans with the plan fields the shift needs + the order's due date.
  const [plans] = await pool.query(
    `SELECT p.id AS planId, p.order_id AS orderId,
            p.chain_length_minutes AS chainLen, p.project_buffer_minutes AS projBuf,
            o.required_date AS requiredDate
       FROM fab_cc_plans p
       JOIN fab_orders o ON o.id = p.order_id AND o.company_id = p.company_id AND o.deleted_at IS NULL
      WHERE p.company_id = ? AND p.status = 'baselined' AND p.deleted_at IS NULL
        AND o.order_type = 'sales'`,
    [companyId],
  );

  // Dedupe to one plan per order (max plan id) — normally already 1:1 (EU-3 supersedes).
  const byOrder = new Map();
  for (const p of plans) {
    const prev = byOrder.get(p.orderId);
    if (!prev || Number(p.planId) > Number(prev.planId)) byOrder.set(p.orderId, p);
  }
  const projects = [...byOrder.values()];

  if (projects.length === 0) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM fab_cc_drum_slots WHERE company_id = ? AND drum_id = ?`, [companyId, drumId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    return { drumId, resourceTypeId: drumTypeId, projectCount: 0, committedCount: 0 };
  }

  // Per-order drum tasks: load (not-done) + committed flag (any in_progress/done) +
  // a representative task for calendar resolution.
  const orderIds = projects.map((p) => p.orderId);
  const [drumTasks] = await pool.query(
    `SELECT id, order_id, resource_type_id, assigned_resource_id, computed_hours, status
       FROM fab_project_tasks
      WHERE company_id = ? AND order_id IN (?)
        AND status <> 'cancelled' AND deleted_at IS NULL
      ORDER BY id ASC`,
    [companyId, orderIds],
  );
  const drumLoadByOrder = new Map();   // orderId -> not-done drum minutes
  const committedByOrder = new Map();  // orderId -> bool
  const calTaskByOrder = new Map();    // orderId -> {assigned_resource_id, resource_type_id}
  for (const t of drumTasks) {
    if (effectiveTypeId(t, resType) !== drumTypeId) continue; // only tasks on the drum type
    if (!calTaskByOrder.has(t.order_id)) {
      calTaskByOrder.set(t.order_id, {
        assigned_resource_id: t.assigned_resource_id,
        resource_type_id: t.resource_type_id,
      });
    }
    if (t.status !== 'done') {
      drumLoadByOrder.set(t.order_id, (drumLoadByOrder.get(t.order_id) || 0) + taskLoadMinutes(t));
    }
    if (t.status === 'in_progress' || t.status === 'done') committedByOrder.set(t.order_id, true);
  }

  // Sort within a group by required_date asc (NULL last), tie-break by order id.
  const dueMs = (rd) => (rd == null ? null : (rd instanceof Date ? rd.getTime() : new Date(rd).getTime()));
  const byDue = (a, b) => {
    const da = dueMs(a.requiredDate);
    const db = dueMs(b.requiredDate);
    if (da == null && db == null) return a.orderId - b.orderId;
    if (da == null) return 1;   // NULLs last
    if (db == null) return -1;
    return da - db || a.orderId - b.orderId;
  };

  // Committed projects frozen at the FRONT (still in required_date order); unstarted
  // queue behind, also by required_date.
  const committed = projects.filter((p) => committedByOrder.get(p.orderId)).sort(byDue);
  const uncommitted = projects.filter((p) => !committedByOrder.get(p.orderId)).sort(byDue);
  const ordered = [...committed, ...uncommitted];

  // Walk the drum timeline from now; build slot rows + per-plan date shifts.
  const slotRows = [];
  const planUpdates = [];
  let cursor = new Date(now.getTime());
  let seq = 0;
  for (const p of ordered) {
    const calTask = calTaskByOrder.get(p.orderId) ?? { assigned_resource_id: null, resource_type_id: drumTypeId };
    const plantId = await resolveTaskPlantId(companyId, calTask);
    const calendarIds = await resolveCalendarIds(companyId, plantId);

    const drumStart = new Date(cursor.getTime());
    const load = drumLoadByOrder.get(p.orderId) || 0;
    const plannedEnd = await advanceWorkingMinutes(companyId, calendarIds, drumStart, load);

    const capacityBuffer = 0; // tunable later; column populated so the gap is adjustable
    // committed_finish = drum start advanced by chain length + project buffer.
    const finishMinutes = (Number(p.chainLen) > 0 ? Number(p.chainLen) : 0) + (Number(p.projBuf) > 0 ? Number(p.projBuf) : 0);
    const committedFinish = await advanceWorkingMinutes(companyId, calendarIds, drumStart, finishMinutes);

    slotRows.push([
      companyId, drumId, p.orderId, p.planId, seq,
      toDateTimeStr(drumStart), toDateTimeStr(plannedEnd),
      capacityBuffer, committedByOrder.get(p.orderId) ? 1 : 0,
    ]);
    planUpdates.push({
      planId: p.planId,
      drumStart: toDateTimeStr(drumStart),
      committedFinish: toDateTimeStr(committedFinish),
    });

    // Next project starts after this one's drum slot + the capacity buffer gap.
    cursor = capacityBuffer > 0
      ? await advanceWorkingMinutes(companyId, calendarIds, plannedEnd, capacityBuffer)
      : plannedEnd;
    seq += 1;
  }

  // Persist: rewrite slots + shift plan dates atomically. NOTE: no path here writes
  // consumed_minutes / buffer_consumed_pct — adding work moves dates, never buffer.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM fab_cc_drum_slots WHERE company_id = ? AND drum_id = ?`, [companyId, drumId]);
    if (slotRows.length > 0) {
      await conn.query(
        `INSERT INTO fab_cc_drum_slots
           (company_id, drum_id, order_id, plan_id, seq,
            planned_start, planned_end, capacity_buffer_minutes, is_committed)
         VALUES ?`,
        [slotRows],
      );
    }
    for (const u of planUpdates) {
      await conn.query(
        `UPDATE fab_cc_plans SET drum_planned_start = ?, committed_finish = ?
          WHERE company_id = ? AND id = ?`,
        [u.drumStart, u.committedFinish, companyId, u.planId],
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return {
    drumId,
    resourceTypeId: drumTypeId,
    projectCount: ordered.length,
    committedCount: committed.length,
  };
}

// ─── 3. replan (entry point — EU-4's materialize hook dynamic-imports this) ──────

/**
 * Detect the drum, then sequence the projects onto it. This is the name EU-4's
 * materialize hook looks for (mod.replan(companyId)). Any failure propagates to the
 * caller; the slot/plan writes are transactional in sequenceProjects, so a failure
 * leaves no half-written slot set.
 */
export async function replan(companyId) {
  const drum = await detectDrum(companyId);
  const seqResult = await sequenceProjects(companyId, drum);
  const summary = {
    ok: true,
    companyId,
    drumId: drum.drumId,
    resourceTypeId: drum.resourceTypeId,
    loadMinutes: drum.loadMinutes,
    projectCount: seqResult.projectCount,
    committedCount: seqResult.committedCount,
  };
  logger.info(summary, '[cc] drum replan complete');
  return summary;
}
