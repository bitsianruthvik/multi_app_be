/**
 * batchService.js — Issue 4: several parts through one machine in a single run.
 * ---------------------------------------------------------------------------
 * The task model is one item × one operation, each with its own estimate. The
 * shop floor is not: eight plates get nested on one sheet and cut in a single
 * CNC program, twelve stiffeners are stacked and drilled in one setup, and a
 * galvanising dip takes the same time for three pieces or thirty. Counting
 * those as 8 / 12 / 30 independent jobs overstates load, hides real capacity,
 * and — because completed tasks feed operationStatsService — teaches the
 * duration model that a five-minute part takes forty.
 *
 * WHERE BATCHABILITY LIVES
 * ------------------------
 * On fab_operation_resource_types — the operation × resource-type mapping — and
 * deliberately not on the operation or the item. A plate has no opinion about
 * whether it can be batched; a plasma table batches and a welding bay does not,
 * and the same "Drill" operation batches on a multi-spindle line but not on a
 * mag drill. The machine decides, so the flag sits where machine and operation
 * meet.
 *
 * THE FOUR MODES
 * --------------
 *   none            not batchable. The default, and what every existing
 *                   mapping is until someone says otherwise.
 *   shared_setup    every piece is still individually worked, but the setup is
 *                   paid once (stack-and-drill, one fixture, n holes).
 *                   → setup + Σ unit
 *   fixed_cycle     the run costs the same regardless of how many go in — a
 *                   galvanising dip, a heat-treat load, one nested cut.
 *                   → setup + max(unit)      [capacity is a hard limit]
 *   capacity_cycle  fixed_cycle, but the machine holds a limited number, so
 *                   more parts means more cycles.
 *                   → setup + ceil(n / capacity) × max(unit)
 *
 * Capacity falls back to fab_resources.num_units — a column that has existed
 * since the schema was written and had no reader until now.
 *
 * TIME ATTRIBUTION (the part that matters most)
 * ---------------------------------------------
 * Actual duration is derived from the event log, so a naive batch — eight tasks
 * all started 09:00, all completed 09:40 — would derive 40 minutes for each and
 * feed 320 minutes of "actual" back into learning for a 40-minute run.
 *
 * Run time is therefore split across the batch **proportionally to each task's
 * computed_hours** (equal split when no task carries a usable estimate) and
 * written to fab_project_tasks.attributed_minutes, which both readers of touch
 * time prefer over the event-derived value. Proportional, not equal, because
 * the parts in a batch are usually not the same size — an equal split would
 * quietly make small parts look expensive and large ones cheap, and that error
 * compounds every time the learned duration feeds the next plan.
 *
 * Setup is held at the batch level and never divided into the parts. Setup is a
 * property of the run, not of any piece in it; dividing it would make the same
 * part learn a different duration depending on how many things it happened to
 * be batched with.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { computeTaskWaitMetrics } from './taskWaitService.js';
import { openOrMoveWipOnStart, finalizeWipOnComplete } from './wipInventoryService.js';
import { rollUpOrderStatus, spawnReworkTask } from './taskEngineService.js';
import { isOutputBlocked } from './taskGatingService.js';

export const BATCH_MODES = new Set(['none', 'shared_setup', 'fixed_cycle', 'capacity_cycle']);

export const BATCH_MODE_LABELS = {
  none: 'Not batchable',
  shared_setup: 'Shared setup',
  fixed_cycle: 'Fixed cycle',
  capacity_cycle: 'Capacity cycle',
};

const round2 = (n) => Math.round(n * 100) / 100;

function toPosInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** JSON columns arrive parsed from mysql2, but tolerate a raw string too. */
function parseMatchKeys(raw) {
  if (raw == null) return [];
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}

// ── Policy ────────────────────────────────────────────────────────────────────

/**
 * The batching policy for `operationId` when run on machine `resourceId`.
 * Returns null when the machine doesn't exist. A machine with no mapping row
 * for the operation is 'none' — absence of configuration means "don't batch",
 * never "batch freely".
 */
export async function getBatchPolicy(exec, companyId, { operationId, resourceId }) {
  const [rows] = await exec.query(
    `SELECT r.id             AS resource_id,
            r.name           AS resource_name,
            r.resource_type_id,
            r.num_units,
            r.setup_time_hrs,
            orc.batch_mode,
            orc.batch_capacity,
            orc.batch_match_keys,
            op.name          AS operation_name
       FROM fab_resources r
       LEFT JOIN fab_operation_resource_types orc
              ON orc.company_id       = r.company_id
             AND orc.resource_type_id = r.resource_type_id
             AND orc.operation_id     = ?
             AND orc.deleted_at IS NULL
       LEFT JOIN fab_operations op
              ON op.id = ? AND op.company_id = r.company_id AND op.deleted_at IS NULL
      WHERE r.id = ? AND r.company_id = ? AND r.deleted_at IS NULL
      LIMIT 1`,
    [operationId, operationId, resourceId, companyId],
  );
  if (!rows.length) return null;

  const r = rows[0];
  const mode = BATCH_MODES.has(r.batch_mode) ? r.batch_mode : 'none';
  return {
    companyId,
    operationId: Number(operationId),
    operationName: r.operation_name ?? null,
    resourceId: r.resource_id,
    resourceName: r.resource_name,
    resourceTypeId: r.resource_type_id,
    batchMode: mode,
    // Explicit override → the machine's parallel-unit count → unlimited.
    capacity: toPosInt(r.batch_capacity) ?? toPosInt(r.num_units) ?? null,
    capacitySource: toPosInt(r.batch_capacity) ? 'mapping' : (toPosInt(r.num_units) ? 'machine' : null),
    matchKeys: parseMatchKeys(r.batch_match_keys),
    setupMinutes: r.setup_time_hrs != null ? round2(Number(r.setup_time_hrs) * 60) : 0,
  };
}

// ── Estimation ────────────────────────────────────────────────────────────────

/**
 * What a batch of these unit-durations costs under `policy`, and what the same
 * work would cost run one task at a time. `soloMinutes` charges setup per task,
 * which is what actually happens today — that difference is the whole point.
 */
export function estimateBatch(policy, unitMinutesList) {
  const units = unitMinutesList.map((m) => (Number.isFinite(Number(m)) && Number(m) > 0 ? Number(m) : 0));
  const n = units.length;
  const sum = units.reduce((a, b) => a + b, 0);
  const max = n ? Math.max(...units) : 0;
  const setup = policy.setupMinutes || 0;
  const cap = policy.capacity && policy.capacity > 0 ? policy.capacity : (n || 1);

  let runMinutes;
  let cycles = 1;
  switch (policy.batchMode) {
    case 'shared_setup':
      runMinutes = sum;
      break;
    case 'fixed_cycle':
      runMinutes = max;
      break;
    case 'capacity_cycle':
      cycles = Math.max(1, Math.ceil(n / cap));
      runMinutes = cycles * max;
      break;
    default: // 'none' — no benefit; the caller shouldn't have got here
      runMinutes = sum;
      break;
  }

  const totalMinutes = setup + runMinutes;
  const soloMinutes = sum + setup * n;
  return {
    totalMinutes: round2(totalMinutes),
    setupMinutes: round2(setup),
    runMinutes: round2(runMinutes),
    cycles,
    soloMinutes: round2(soloMinutes),
    savedMinutes: round2(Math.max(0, soloMinutes - totalMinutes)),
  };
}

/**
 * Split `runMinutes` across tasks in proportion to their planned hours.
 * Rounding drift lands on the largest share so the parts always sum to the
 * whole — a batch whose attributions don't add up to its run time is a
 * reconciliation bug waiting to be found by someone else.
 */
export function allocateMinutes(tasks, runMinutes) {
  const out = new Map();
  if (!tasks.length) return out;

  const weights = tasks.map((t) => {
    const h = Number(t.computedHours ?? t.computed_hours);
    return Number.isFinite(h) && h > 0 ? h : 0;
  });
  const total = weights.reduce((a, b) => a + b, 0);

  if (total <= 0) {
    // Nothing to weight by — an equal split is the only honest answer.
    const each = round2(runMinutes / tasks.length);
    tasks.forEach((t) => out.set(t.id, each));
    return out;
  }

  let acc = 0;
  let heaviest = 0;
  tasks.forEach((t, i) => {
    const v = round2((runMinutes * weights[i]) / total);
    out.set(t.id, v);
    acc += v;
    if (weights[i] > weights[heaviest]) heaviest = i;
  });
  const drift = round2(runMinutes - acc);
  if (drift !== 0) out.set(tasks[heaviest].id, round2(out.get(tasks[heaviest].id) + drift));
  return out;
}

// ── Candidate evaluation ──────────────────────────────────────────────────────

/** Metric values, keyed item → metric_key → value, for match-key comparison. */
async function loadMetrics(exec, companyId, itemIds, keys) {
  const byItem = new Map();
  if (!itemIds.length || !keys.length) return byItem;
  const [rows] = await exec.query(
    `SELECT item_id, metric_key, metric_value
       FROM fab_item_metric_values
      WHERE company_id = ? AND item_id IN (?) AND metric_key IN (?) AND deleted_at IS NULL`,
    [companyId, itemIds, keys],
  );
  for (const r of rows) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, new Map());
    byItem.get(r.item_id).set(r.metric_key, r.metric_value == null ? null : Number(r.metric_value));
  }
  return byItem;
}

/**
 * Which of this machine's queued tasks can join a batch anchored on
 * `anchorTaskId`, and — for the ones that can't — why not.
 *
 * Every candidate is returned, eligible or not, with a human reason. A greyed
 * row that explains itself is the difference between an operator trusting the
 * screen and an operator working around it.
 */
export async function evaluateCandidates(companyId, { resourceId, anchorTaskId }) {
  const [anchorRows] = await pool.query(
    `SELECT id, operation_id, resource_type_id, item_id, order_id, status, computed_hours
       FROM fab_project_tasks
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [anchorTaskId, companyId],
  );
  if (!anchorRows.length) return { error: 'ANCHOR_NOT_FOUND' };
  const anchor = anchorRows[0];

  const policy = await getBatchPolicy(pool, companyId, {
    operationId: anchor.operation_id,
    resourceId,
  });
  if (!policy) return { error: 'RESOURCE_NOT_FOUND' };

  if (policy.batchMode === 'none') {
    return { policy, anchorTaskId: anchor.id, batchable: false, candidates: [] };
  }

  // The same set the queue screen shows: assigned here, or unassigned but of a
  // type this machine can run.
  const [rows] = await pool.query(
    `SELECT t.id, t.operation_id, t.resource_type_id, t.item_id, t.order_id, t.status,
            t.computed_hours, t.assigned_resource_id, t.batch_id,
            it.name AS item_name, it.mark AS item_mark, it.qty AS item_qty,
            fo.order_number
       FROM fab_project_tasks t
       LEFT JOIN fab_items  it ON it.id = t.item_id AND it.deleted_at IS NULL
       LEFT JOIN fab_orders fo ON fo.id = t.order_id
      WHERE t.company_id = ?
        AND t.deleted_at IS NULL
        AND t.status IN ('eligible', 'paused')
        AND t.id <> ?
        AND (t.assigned_resource_id = ? OR (t.assigned_resource_id IS NULL AND t.resource_type_id = ?))
      ORDER BY t.seq_no ASC, t.id ASC`,
    [companyId, anchor.id, resourceId, policy.resourceTypeId],
  );

  const itemIds = [...new Set([anchor.item_id, ...rows.map((r) => r.item_id)].filter(Boolean))];
  const metrics = await loadMetrics(pool, companyId, itemIds, policy.matchKeys);
  const anchorMetrics = metrics.get(anchor.item_id) ?? new Map();

  const candidates = rows.map((r) => {
    let eligible = true;
    let reason = null;

    if (r.operation_id !== anchor.operation_id) {
      eligible = false;
      reason = 'Different operation';
    } else if (r.batch_id != null) {
      eligible = false;
      reason = 'Already in another batch';
    } else if (policy.matchKeys.length) {
      const m = metrics.get(r.item_id) ?? new Map();
      for (const key of policy.matchKeys) {
        const a = anchorMetrics.get(key);
        const b = m.get(key);
        if (a == null || b == null) {
          eligible = false;
          reason = `Missing ${key}`;
          break;
        }
        if (a !== b) {
          eligible = false;
          reason = `${key} differs (${b} vs ${a})`;
          break;
        }
      }
    }

    return {
      taskId: r.id,
      itemId: r.item_id,
      itemName: r.item_name,
      itemMark: r.item_mark,
      itemQty: r.item_qty == null ? null : Number(r.item_qty),
      orderId: r.order_id,
      orderNumber: r.order_number,
      status: r.status,
      computedHours: r.computed_hours == null ? null : Number(r.computed_hours),
      eligible,
      reason,
    };
  });

  return { policy, anchorTaskId: anchor.id, batchable: true, candidates };
}

/** Estimate for an explicit selection — what the "Start N together" button reads. */
export async function previewBatch(companyId, { resourceId, taskIds }) {
  const [rows] = await pool.query(
    `SELECT id, operation_id, computed_hours
       FROM fab_project_tasks
      WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
    [companyId, taskIds],
  );
  if (!rows.length) return { error: 'NO_TASKS' };

  const opIds = [...new Set(rows.map((r) => r.operation_id))];
  if (opIds.length > 1) return { error: 'MIXED_OPERATIONS' };

  const policy = await getBatchPolicy(pool, companyId, { operationId: opIds[0], resourceId });
  if (!policy) return { error: 'RESOURCE_NOT_FOUND' };

  const unitMinutes = rows.map((r) => (r.computed_hours == null ? 0 : Number(r.computed_hours) * 60));
  const estimate = estimateBatch(policy, unitMinutes);
  return { policy, taskCount: rows.length, estimate };
}

// ── Start ─────────────────────────────────────────────────────────────────────

class BatchError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Start every task in `taskIds` on `resourceId` as one batch.
 *
 * All-or-nothing, in a single transaction: if any member is ineligible, output-
 * blocked, or short of material, nothing starts. A half-started batch would put
 * the operator in a state no screen can describe.
 */
export async function startBatch(companyId, { resourceId, taskIds, userId, isAdmin, force }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [tasks] = await conn.query(
      `SELECT id, company_id, order_id, item_id, flow_id, seq_no, operation_id,
              resource_type_id, assigned_resource_id, deps_cleared_at, status,
              computed_hours, batch_id
         FROM fab_project_tasks
        WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL
        FOR UPDATE`,
      [companyId, taskIds],
    );

    if (tasks.length !== taskIds.length) {
      throw new BatchError('TASK_NOT_FOUND', 'One or more selected tasks no longer exist.');
    }

    const opIds = [...new Set(tasks.map((t) => t.operation_id))];
    if (opIds.length > 1) {
      throw new BatchError('MIXED_OPERATIONS', 'A batch must be a single operation.');
    }

    const policy = await getBatchPolicy(conn, companyId, { operationId: opIds[0], resourceId });
    if (!policy) throw new BatchError('RESOURCE_NOT_FOUND', 'Selected machine was not found.');
    if (policy.batchMode === 'none') {
      throw new BatchError('NOT_BATCHABLE', `${policy.operationName ?? 'This operation'} is not set up to batch on ${policy.resourceName}.`);
    }
    // fixed_cycle is a physical load — the machine holds what it holds.
    if (policy.batchMode === 'fixed_cycle' && policy.capacity && tasks.length > policy.capacity) {
      throw new BatchError('OVER_CAPACITY', `${policy.resourceName} holds ${policy.capacity} at a time.`);
    }

    for (const t of tasks) {
      if (t.status !== 'eligible' && t.status !== 'paused') {
        throw new BatchError('BAD_STATUS', `Task #${t.id} is "${t.status}" and cannot be started.`);
      }
      if (t.batch_id != null) {
        throw new BatchError('ALREADY_BATCHED', `Task #${t.id} is already in batch #${t.batch_id}.`);
      }
      if (t.resource_type_id && policy.resourceTypeId && t.resource_type_id !== policy.resourceTypeId) {
        throw new BatchError('WRONG_MACHINE_TYPE', `Task #${t.id} needs a machine of a different resource type.`);
      }
    }

    // Same no-double-booking rule as a solo start — except that members of THIS
    // batch are, by definition, allowed to run together.
    const [busy] = await conn.query(
      `SELECT id FROM fab_project_tasks
        WHERE company_id = ? AND assigned_resource_id = ? AND status = 'in_progress'
          AND deleted_at IS NULL AND id NOT IN (?) LIMIT 1 FOR UPDATE`,
      [companyId, resourceId, taskIds],
    );
    if (busy.length) {
      throw new BatchError('MACHINE_BUSY', `That machine is already running task #${busy[0].id}. Finish or pause it first.`);
    }

    const [machineRows] = await conn.query(
      `SELECT id, resource_type_id, plant_id, stock_location_id, name
         FROM fab_resources WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [resourceId, companyId],
    );
    const machine = machineRows[0];

    // Output gating, per member — one blocked part blocks the batch.
    const blocked = [];
    for (const t of tasks) {
      const r = await isOutputBlocked(companyId, { ...t, assigned_resource_id: resourceId }, conn);
      if (r.blocked) blocked.push({ taskId: t.id, reason: r.reason });
    }
    if (blocked.length && !(force && isAdmin)) {
      throw new BatchError('OUTPUT_BLOCKED', blocked[0].reason, { blocked });
    }

    const [ins] = await conn.query(
      `INSERT INTO fab_task_batches
         (company_id, resource_id, operation_id, batch_mode, status, started_at, setup_minutes, created_by)
       VALUES (?, ?, ?, ?, 'in_progress', NOW(), ?, ?)`,
      [companyId, resourceId, opIds[0], policy.batchMode, policy.setupMinutes || null, userId ?? null],
    );
    const batchId = ins.insertId;

    const now = new Date();
    const started = [];
    for (const t of tasks) {
      const metrics = await computeTaskWaitMetrics(t, now);
      const [upd] = await conn.query(
        `UPDATE fab_project_tasks
            SET wait_working_minutes = ?,
                blocked_by_other_tasks_minutes = ?,
                idle_wait_minutes = ?,
                assigned_resource_id = ?,
                batch_id = ?,
                started_at = NOW(),
                status = 'in_progress'
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL AND status = ?`,
        [
          metrics.wait_working_minutes,
          metrics.blocked_by_other_tasks_minutes,
          metrics.idle_wait_minutes,
          resourceId,
          batchId,
          t.id,
          companyId,
          t.status,
        ],
      );
      if (upd.affectedRows === 0) {
        throw new BatchError('CONFLICT', `Task #${t.id} changed before the batch could start. Refresh and try again.`);
      }
      await openOrMoveWipOnStart(conn, companyId, t, machine);
      started.push({ taskId: t.id, priorStatus: t.status, orderId: t.order_id });
    }

    for (const orderId of [...new Set(tasks.map((t) => t.order_id).filter(Boolean))]) {
      await rollUpOrderStatus(conn, companyId, orderId);
    }

    const estimate = estimateBatch(policy, tasks.map((t) => (t.computed_hours == null ? 0 : Number(t.computed_hours) * 60)));

    await conn.commit();
    return { batchId, policy, estimate, started, blocked, forced: blocked.length > 0 };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ── Complete ──────────────────────────────────────────────────────────────────

/**
 * Complete a whole batch: per-member output capture, WIP finalize (or rework on
 * a QC fail), and the proportional time attribution described at the top of
 * this file.
 *
 * `outcomes` is keyed by task id: { producedQty, scrapQty, qcResult }. A member
 * with no entry passes QC at its planned quantity — the common case is "all
 * twelve came out fine" and making the operator confirm twelve identical rows
 * is how you train people to click through without reading.
 */
export async function completeBatch(companyId, batchId, { outcomes = {}, userId, setupMinutesOverride }) {
  const conn = await pool.getConnection();
  let result;
  try {
    await conn.beginTransaction();

    const [batchRows] = await conn.query(
      `SELECT id, company_id, resource_id, operation_id, batch_mode, status, started_at, setup_minutes
         FROM fab_task_batches
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL FOR UPDATE`,
      [batchId, companyId],
    );
    if (!batchRows.length) throw new BatchError('BATCH_NOT_FOUND', `Batch #${batchId} not found.`);
    const batch = batchRows[0];
    if (batch.status !== 'in_progress') {
      throw new BatchError('BAD_STATUS', `Batch #${batchId} is "${batch.status}" and cannot be completed.`);
    }

    const [tasks] = await conn.query(
      `SELECT t.id, t.order_id, t.item_id, t.seq_no, t.assigned_resource_id, t.status,
              t.computed_hours, COALESCE(i.qty, 1) AS planned_qty
         FROM fab_project_tasks t
         LEFT JOIN fab_items i ON i.id = t.item_id AND i.company_id = t.company_id AND i.deleted_at IS NULL
        WHERE t.company_id = ? AND t.batch_id = ? AND t.deleted_at IS NULL
        FOR UPDATE`,
      [companyId, batchId],
    );
    const running = tasks.filter((t) => t.status === 'in_progress');
    if (!running.length) throw new BatchError('NO_RUNNING_TASKS', 'No tasks in this batch are in progress.');

    // ── Time ──────────────────────────────────────────────────────────────────
    const startedAt = batch.started_at ? new Date(batch.started_at) : null;
    const totalMinutes = startedAt ? Math.max(0, round2((Date.now() - startedAt.getTime()) / 60000)) : 0;
    let setupMinutes = setupMinutesOverride != null ? Number(setupMinutesOverride)
      : (batch.setup_minutes != null ? Number(batch.setup_minutes) : 0);
    if (!Number.isFinite(setupMinutes) || setupMinutes < 0) setupMinutes = 0;
    // A run shorter than its own nominal setup means the setup estimate is
    // wrong, not that run time is negative. Clamp rather than emit nonsense.
    setupMinutes = Math.min(setupMinutes, totalMinutes);
    const runMinutes = round2(totalMinutes - setupMinutes);

    const allocation = allocateMinutes(
      running.map((t) => ({ id: t.id, computedHours: t.computed_hours })),
      runMinutes,
    );

    const members = [];
    for (const t of running) {
      const o = outcomes[t.id] ?? outcomes[String(t.id)] ?? {};
      const qcResult = o.qcResult === 'fail' ? 'fail' : 'pass';
      const scrapQty = Number.isFinite(Number(o.scrapQty)) && Number(o.scrapQty) >= 0 ? Number(o.scrapQty) : 0;
      const producedQty = Number.isFinite(Number(o.producedQty)) && Number(o.producedQty) >= 0
        ? Number(o.producedQty)
        : (Number(t.planned_qty) || 1);

      const [upd] = await conn.query(
        `UPDATE fab_project_tasks
            SET status = 'done',
                completed_at = NOW(),
                produced_qty = ?,
                scrap_qty = ?,
                qc_result = ?,
                attributed_minutes = ?
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL AND status = 'in_progress'`,
        [producedQty, scrapQty, qcResult, allocation.get(t.id) ?? null, t.id, companyId],
      );
      if (upd.affectedRows === 0) {
        throw new BatchError('CONFLICT', `Task #${t.id} is no longer in progress. Refresh and try again.`);
      }

      let rework = null;
      if (qcResult === 'fail') {
        rework = await spawnReworkTask(conn, companyId, t.id);
      } else {
        await finalizeWipOnComplete(conn, companyId, t, { goodQty: producedQty, scrapQty });
      }

      members.push({
        taskId: t.id,
        orderId: t.order_id,
        producedQty,
        scrapQty,
        qcResult,
        attributedMinutes: allocation.get(t.id) ?? null,
        planHours: t.computed_hours == null ? null : Number(t.computed_hours),
        reworkTaskId: rework?.reworkTaskId ?? null,
      });
    }

    await conn.query(
      `UPDATE fab_task_batches
          SET status = 'done', completed_at = NOW(), total_minutes = ?, setup_minutes = ?
        WHERE id = ? AND company_id = ?`,
      [Math.round(totalMinutes), Math.round(setupMinutes), batchId, companyId],
    );

    await conn.commit();
    result = { batchId, totalMinutes, setupMinutes, runMinutes, members };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  logger.info(
    { batchId, companyId, members: result.members.length, totalMinutes: result.totalMinutes },
    'fab_erp batch completed',
  );
  return result;
}

export { BatchError };
