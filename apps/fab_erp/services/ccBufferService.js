// ccBufferService.js — EU-5: live buffer-consumption + projected-finish engine.
//
// EU-3 (criticalChainService) freezes a CCPM baseline: the critical chain length,
// the project buffer, per-feeding-group feeding buffers, and each chain task's
// aggressive (50%) minutes. This module turns that frozen baseline into a LIVE
// fever chart: as tasks run and overrun their aggressive estimate, that overrun
// burns down the buffers, and we re-project the committed finish.
//
// LOCKED DECISION — execution variance ONLY. `consumed_minutes` tracks nothing but
// actual-vs-aggressive overrun of executed work. Drum date-shifts / re-baselining are
// deliberately NOT folded in here (that lives in the drum EUs); we only ever ADD
// max(0, actual − aggressive) per started chain task.
//
// Actual touch-time is NOT reimplemented: we reuse taskVarianceService
// .computeActualHoursForTasks, which itself reuses operationStatsService.buildSample
// (started→completed minus pause gaps) — so the numbers reconcile with the learned-
// duration + variance readouts. A task with no usable started/completed pair yet
// (e.g. still in_progress, no 'completed' event) yields null actual → 0 overrun until
// it completes and the recompute fires again.
//
// Calendar-forward projection reuses taskWaitService (resolveTaskCalendarIds /
// resolveCalendarIds / workingIntervalsInWindow) the same chunked way EU-2/EU-3 do;
// there is no exported "advance by N working-minutes" helper, so that small loop is
// replicated here (identical to criticalChainService.advanceWorkingMinutes).

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { computeActualHoursForTasks } from './taskVarianceService.js';
import {
  resolveTaskCalendarIds,
  workingIntervalsInWindow,
} from './taskWaitService.js';

// ─── fever-chart thresholds (shared with FE — EU-7) ────────────────────────────
// Two diagonal lines over (chain_complete_pct = c, buffer_consumed_pct = b):
//   green if b below greenLine(c); red if b above redLine(c); yellow in between.
// Exported so the frontend fever chart draws the exact same boundaries.
export const CC_FEVER = {
  greenLine: (c) => 15 + 0.45 * c,
  redLine: (c) => 35 + 0.5 * c,
  zoneFor(c, b) {
    if (b < CC_FEVER.greenLine(c)) return 'green';
    if (b > CC_FEVER.redLine(c)) return 'red';
    return 'yellow';
  },
};

// ─── helpers ───────────────────────────────────────────────────────────────────

// Store instants as UTC 'YYYY-MM-DD HH:MM:SS' (mirrors criticalChainService).
function toDateTimeStr(d) {
  return d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

const CHUNK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCAN_MS = 366 * 24 * 60 * 60 * 1000;

// Clamp a percentage into a signed-TINYINT-safe range. Chain completion clamps to
// 0..100; buffer burn floors at 0 but may exceed 100 (a >100% burn = deep red) — we
// still cap at 127 so it fits the TINYINT column without overflow.
function clampPct(n, max = 127) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

/**
 * Advance `from` forward by `minutes` WORKING minutes across the given calendars.
 * Empty calendars (or non-positive minutes) degrade to a wall-clock add — the same
 * optimistic 24/7 fallback EU-2/EU-3 use. Replicated from
 * criticalChainService.advanceWorkingMinutes (not exported there).
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
        `ccBufferService: could not advance ${minutes} working minutes within ${MAX_SCAN_MS / 86400000} days after ${from.toISOString()} for calendars [${calendarIds.join(', ')}]`,
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

// ─── main entry ────────────────────────────────────────────────────────────────

/**
 * Recompute live buffer consumption + projected finish for one baselined plan and
 * persist the results (plan headline fields, each buffer's consumed_minutes, and a
 * fresh project-buffer fever snapshot).
 *
 * @returns {Promise<object>} a summary, or {ok:false, reason} when nothing to do.
 */
export async function recomputeConsumption(companyId, planId) {
  const now = new Date();

  const [[plan]] = await pool.query(
    `SELECT id, order_id, status, chain_length_minutes, project_buffer_minutes
       FROM fab_cc_plans
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [planId, companyId],
  );
  if (!plan) return { ok: false, reason: 'plan_not_found', companyId, planId };

  const [chainTasks] = await pool.query(
    `SELECT task_id, seq, chain_role, feeding_group_id, aggressive_minutes
       FROM fab_cc_chain_tasks
      WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL`,
    [companyId, planId],
  );
  const [buffers] = await pool.query(
    `SELECT id, kind, size_minutes, consumed_minutes, feeds_task_id, after_task_id
       FROM fab_cc_buffers
      WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL`,
    [companyId, planId],
  );

  // Live status + resource of each chain task (resource fields feed the calendar
  // projection below). order_id restricts to this plan's order for safety.
  const taskIds = chainTasks.map((c) => c.task_id);
  let liveById = new Map();
  if (taskIds.length > 0) {
    const [liveRows] = await pool.query(
      `SELECT id, status, resource_type_id, assigned_resource_id
         FROM fab_project_tasks
        WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
      [companyId, taskIds],
    );
    liveById = new Map(liveRows.map((r) => [r.id, r]));
  }

  const chainLength = Number(plan.chain_length_minutes) || 0;
  const isDone = (id) => liveById.get(id)?.status === 'done';
  const isStarted = (id) => {
    const s = liveById.get(id)?.status;
    return s === 'in_progress' || s === 'done';
  };

  // chain_complete_pct = aggressive minutes of DONE critical tasks / chain length.
  let doneCriticalAgg = 0;
  for (const c of chainTasks) {
    if (c.chain_role === 'critical' && isDone(c.task_id)) doneCriticalAgg += Number(c.aggressive_minutes) || 0;
  }
  const chainCompletePct = chainLength > 0 ? clampPct((100 * doneCriticalAgg) / chainLength, 100) : 0;

  // Actual touch-hours for every STARTED chain task (one reused query). Not-yet-
  // startable tasks contribute nothing; a started task with no completed event yet
  // returns null actual → 0 overrun.
  const startedIds = chainTasks.filter((c) => isStarted(c.task_id)).map((c) => c.task_id);
  const actualHoursById = startedIds.length > 0
    ? await computeActualHoursForTasks(pool, companyId, startedIds)
    : new Map();

  const overrunOf = (c) => {
    if (!isStarted(c.task_id)) return 0;
    const h = actualHoursById.get(c.task_id);
    const actualMin = h == null ? 0 : Number(h) * 60;
    return Math.max(0, actualMin - (Number(c.aggressive_minutes) || 0));
  };

  // Accumulate overrun: critical → project buffer directly; feeding → per group.
  let criticalOverrun = 0;
  const feedingOverrunByGroup = new Map(); // feeding_group_id -> minutes
  for (const c of chainTasks) {
    const o = overrunOf(c);
    if (o <= 0) continue;
    if (c.chain_role === 'critical') {
      criticalOverrun += o;
    } else {
      const g = c.feeding_group_id; // may be null → no matching feeding buffer, spills to project
      feedingOverrunByGroup.set(g, (feedingOverrunByGroup.get(g) || 0) + o);
    }
  }

  // Feeding-then-project spillover: a group's overrun consumes its own feeding buffer
  // first; anything beyond that buffer's SIZE spills into the project buffer. A group
  // with no feeding buffer (null group / no matching row) spills entirely to project.
  const feedingBufferByGroup = new Map();
  let projectBuffer = null;
  for (const b of buffers) {
    if (b.kind === 'project') projectBuffer = b;
    else if (b.kind === 'feeding' && b.feeds_task_id != null) feedingBufferByGroup.set(b.feeds_task_id, b);
  }

  const feedingConsumed = new Map(); // buffer id -> true consumed minutes
  let projectSpill = 0;
  for (const [group, overrun] of feedingOverrunByGroup) {
    const fb = group == null ? null : feedingBufferByGroup.get(group);
    if (fb) {
      feedingConsumed.set(fb.id, overrun); // true consumed (may exceed size = >100% burn)
      projectSpill += Math.max(0, overrun - (Number(fb.size_minutes) || 0));
    } else {
      projectSpill += overrun; // no feeding buffer → straight to project
    }
  }

  const projectConsumed = criticalOverrun + projectSpill;
  const projectSize = projectBuffer ? Number(projectBuffer.size_minutes) || 0 : Number(plan.project_buffer_minutes) || 0;

  // buffer_consumed_pct headline = project buffer burn. Divide-by-zero guard: a
  // zero-size buffer reads 100% when anything spilled into it, else 0%.
  const bufferConsumedPctNum = projectSize > 0
    ? Math.max(0, (100 * projectConsumed) / projectSize)
    : (projectConsumed > 0 ? 100 : 0);
  const bufferConsumedPct = clampPct(bufferConsumedPctNum);
  const zone = CC_FEVER.zoneFor(chainCompletePct, bufferConsumedPctNum);

  // ── projected committed_finish ──────────────────────────────────────────────
  // now + remaining critical work + remaining (unconsumed) project buffer, walked
  // FORWARD on the order's calendar. Remaining critical work = aggressive minutes of
  // not-done critical tasks (a simple, defensible estimate — no re-leveling here).
  let remainingCriticalWork = 0;
  let representative = null; // highest-seq critical chain task, for calendar resolution
  for (const c of chainTasks) {
    if (c.chain_role !== 'critical') continue;
    if (!isDone(c.task_id)) remainingCriticalWork += Number(c.aggressive_minutes) || 0;
    if (representative == null || Number(c.seq) > Number(representative.seq)) representative = c;
  }
  const remainingProjectBuffer = Math.max(0, projectSize - projectConsumed);
  const totalRemaining = remainingCriticalWork + remainingProjectBuffer;

  let committedFinish;
  let calendarFallback = false;
  try {
    let calendarIds = [];
    if (representative) {
      const live = liveById.get(representative.task_id);
      if (live) {
        calendarIds = await resolveTaskCalendarIds(companyId, live);
      }
    }
    calendarFallback = calendarIds.length === 0;
    committedFinish = await advanceWorkingMinutes(companyId, calendarIds, now, totalRemaining);
  } catch (err) {
    // Never let a calendar-scan edge case null out the projection — fall back to a
    // wall-clock add (same optimistic 24/7 degradation as an empty calendar).
    logger.warn({ err, companyId, planId }, '[cc-buffer] projection fell back to wall-clock');
    committedFinish = new Date(now.getTime() + totalRemaining * 60000);
    calendarFallback = true;
  }

  // ── persist ─────────────────────────────────────────────────────────────────
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE fab_cc_plans
          SET committed_finish = ?, fever_zone = ?, buffer_consumed_pct = ?, chain_complete_pct = ?
        WHERE id = ? AND company_id = ?`,
      [toDateTimeStr(committedFinish), zone, bufferConsumedPct, chainCompletePct, planId, companyId],
    );

    if (projectBuffer) {
      await conn.query(
        `UPDATE fab_cc_buffers SET consumed_minutes = ? WHERE id = ? AND company_id = ?`,
        [Math.round(projectConsumed), projectBuffer.id, companyId],
      );
    }
    for (const b of buffers) {
      if (b.kind !== 'feeding') continue;
      const consumed = feedingConsumed.get(b.id) || 0;
      await conn.query(
        `UPDATE fab_cc_buffers SET consumed_minutes = ? WHERE id = ? AND company_id = ?`,
        [Math.round(consumed), b.id, companyId],
      );
    }

    // Fever trail: one snapshot row for the project buffer per recompute.
    if (projectBuffer) {
      await conn.query(
        `INSERT INTO fab_cc_buffer_snapshots
           (company_id, plan_id, buffer_id, at, chain_complete_pct, buffer_consumed_pct, zone)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [companyId, planId, projectBuffer.id, toDateTimeStr(now), chainCompletePct, bufferConsumedPct, zone],
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
    ok: true,
    companyId,
    planId,
    orderId: plan.order_id,
    chainCompletePct,
    bufferConsumedPct,
    zone,
    projectConsumedMinutes: Math.round(projectConsumed),
    projectBufferMinutes: projectSize,
    committedFinish: toDateTimeStr(committedFinish),
    calendarFallback,
  };
}

/**
 * Recompute the order's ACTIVE (status='baselined') plan, if any. Routes call this —
 * they have order_id, not plan_id. No-op (not an error) when the order has no active
 * baseline yet.
 */
export async function recomputeForOrder(companyId, orderId) {
  const [[plan]] = await pool.query(
    `SELECT id FROM fab_cc_plans
      WHERE company_id = ? AND order_id = ? AND status = 'baselined' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [companyId, orderId],
  );
  if (!plan) return { ok: false, reason: 'no_active_plan', companyId, orderId };
  return recomputeConsumption(companyId, plan.id);
}

/**
 * Sweep: recompute every status='baselined' plan across all companies, batch-limited.
 * Driven by the 15-min cc-sweep job (workers/jobHandlers.js). Per-plan failures are
 * logged and skipped so one bad plan never aborts the batch.
 */
export async function recomputeAllBaselined({ limit = 500 } = {}) {
  const [plans] = await pool.query(
    `SELECT id, company_id FROM fab_cc_plans
      WHERE status = 'baselined' AND deleted_at IS NULL
      ORDER BY id ASC
      LIMIT ?`,
    [Number(limit) > 0 ? Number(limit) : 500],
  );
  let recomputed = 0;
  let failed = 0;
  for (const p of plans) {
    try {
      await recomputeConsumption(p.company_id, p.id);
      recomputed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, companyId: p.company_id, planId: p.id }, '[cc-sweep] plan recompute failed');
    }
  }
  return { ok: true, plans: plans.length, recomputed, failed };
}
