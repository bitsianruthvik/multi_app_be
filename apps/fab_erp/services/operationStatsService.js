/**
 * operationStatsService.js — EU-14: rolling operation stats (learned durations).
 * -----------------------------------------------------------------------------
 * Nightly job (see workers/jobHandlers.js + app.js) that recomputes, per
 * company and per (operation_id, resource_type_id) group, how long a task
 * actually takes once it's running — feeding EU-15's duration estimates for
 * not-yet-run tasks of the same operation/resource type.
 *
 * TOUCH TIME (per completed task, from fab_task_events — never from the
 * fab_project_tasks.started_at/completed_at columns, so a corrected/
 * superseded event history is always the source of truth):
 *
 *     touch_minutes = (completed.at − started.at) − Σ(resumed.at − paused.at)
 *
 * Only non-superseded, non-deleted events are read (superseded_by_event_id
 * IS NULL AND deleted_at IS NULL), same convention as
 * taskAttributionService.js. A task missing either a 'started' or a
 * 'completed' event contributes no sample (touch time is undefined).
 *
 * BACKFILL-INCLUSION RULE: a task is "backfill-sourced" if its started or
 * completed event has source='backfill' (vs 'live'/'system'). Backfilled
 * samples are noisier (manually keyed in after the fact), so a group's
 * backfill samples are excluded until the group has amassed ≥10 live/system
 * samples — at that point the live signal is trusted enough that adding the
 * backfill samples only helps the sample size. Below that threshold, only
 * live/system samples count (and toward sample_count).
 *
 * MINIMUM SAMPLES: a group needs ≥3 usable samples before its median/p80/
 * ewma are considered trustworthy. Groups below that still get a row (so
 * sample_count is visible / the group is known to exist) but with NULL
 * stats — see getUsableStat(), which is EU-15's read gate.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

const MIN_SAMPLES = 3;
const BACKFILL_INCLUSION_THRESHOLD = 10;
const EWMA_ALPHA = 0.3;

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

/**
 * Reduce one completed task's ordered event list to a single sample:
 * { touchMinutes, completedAt, isBackfill }, or null if the task has no
 * usable started/completed pair. Only the first 'started' and the last
 * 'completed' event are used (defensive against duplicate/corrected rows
 * that slipped through without being marked superseded); paused/resumed are
 * summed as closed pairs only — a pause left open at completion (shouldn't
 * happen for a 'done' task, but data can be messy) contributes 0 to the
 * subtracted pause time rather than corrupting the result.
 */
function buildSample(events) {
  let startedAt = null;
  let startedSource = null;
  let completedAt = null;
  let completedSource = null;
  let pauseStart = null;
  let pauseMinutes = 0;

  for (const ev of events) {
    const at = new Date(ev.at);
    if (ev.event_type === 'started') {
      if (!startedAt) {
        startedAt = at;
        startedSource = ev.source;
      }
    } else if (ev.event_type === 'completed') {
      completedAt = at;
      completedSource = ev.source;
    } else if (ev.event_type === 'paused') {
      if (!pauseStart) pauseStart = at;
    } else if (ev.event_type === 'resumed') {
      if (pauseStart) {
        pauseMinutes += (at - pauseStart) / 60000;
        pauseStart = null;
      }
    }
  }

  if (!startedAt || !completedAt || completedAt <= startedAt) return null;

  const totalMinutes = (completedAt - startedAt) / 60000;
  const touchMinutes = Math.max(0, totalMinutes - pauseMinutes);
  const isBackfill = startedSource === 'backfill' || completedSource === 'backfill';
  return { touchMinutes, completedAt, isBackfill };
}

/** Sorted-array median. */
function median(sorted) {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 80th percentile via linear interpolation between closest ranks (the
 * common "PERCENTILE.INC" / numpy-default method) over a pre-sorted array.
 */
function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Exponentially weighted moving average, walked in completion-time order. */
function ewma(valuesInTimeOrder, alpha) {
  let e = null;
  for (const v of valuesInTimeOrder) {
    e = e === null ? v : alpha * v + (1 - alpha) * e;
  }
  return e;
}

/**
 * Recompute and UPSERT fab_operation_stats for every (operation_id,
 * resource_type_id) group among `companyId`'s completed (status='done')
 * tasks.
 *
 * @returns {Promise<{ok:boolean, companyId:number, groups:number}>}
 */
export async function recomputeStatsForCompany(companyId) {
  const [tasks] = await pool.query(
    `SELECT id, operation_id, resource_type_id
       FROM fab_project_tasks
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'done'`,
    [companyId],
  );
  if (tasks.length === 0) return { ok: true, companyId, groups: 0 };

  const taskIds = tasks.map((t) => t.id);
  const [events] = await pool.query(
    `SELECT task_id, event_type, at, source
       FROM fab_task_events
      WHERE company_id = ? AND task_id IN (?)
        AND superseded_by_event_id IS NULL AND deleted_at IS NULL
        AND event_type IN ('started','paused','resumed','completed')
      ORDER BY task_id ASC, at ASC`,
    [companyId, taskIds],
  );

  const eventsByTask = new Map();
  for (const ev of events) {
    if (!eventsByTask.has(ev.task_id)) eventsByTask.set(ev.task_id, []);
    eventsByTask.get(ev.task_id).push(ev);
  }

  // key -> { operationId, resourceTypeId, live:[sample], backfill:[sample] }
  const groups = new Map();
  for (const task of tasks) {
    const taskEvents = eventsByTask.get(task.id);
    if (!taskEvents) continue;
    const sample = buildSample(taskEvents);
    if (!sample) continue;

    const key = `${task.operation_id}::${task.resource_type_id == null ? 'null' : task.resource_type_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        operationId: task.operation_id,
        resourceTypeId: task.resource_type_id,
        live: [],
        backfill: [],
      });
    }
    const g = groups.get(key);
    (sample.isBackfill ? g.backfill : g.live).push(sample);
  }

  const now = new Date();
  const rows = [];
  for (const g of groups.values()) {
    // Backfill-inclusion rule (see file header).
    const usable = g.live.length >= BACKFILL_INCLUSION_THRESHOLD
      ? g.live.concat(g.backfill)
      : g.live;
    usable.sort((a, b) => a.completedAt - b.completedAt);

    const sampleCount = usable.length;
    let medianMinutes = null;
    let p80Minutes = null;
    let ewmaMinutes = null;

    if (sampleCount >= MIN_SAMPLES) {
      const sortedTouch = usable.map((s) => s.touchMinutes).sort((a, b) => a - b);
      medianMinutes = round2(median(sortedTouch));
      p80Minutes = round2(percentile(sortedTouch, 80));
      ewmaMinutes = round2(ewma(usable.map((s) => s.touchMinutes), EWMA_ALPHA));
    }

    rows.push([
      companyId,
      g.operationId,
      g.resourceTypeId,
      sampleCount,
      medianMinutes,
      p80Minutes,
      ewmaMinutes,
      now,
    ]);
  }

  if (rows.length > 0) {
    await pool.query(
      `INSERT INTO fab_operation_stats
         (company_id, operation_id, resource_type_id, sample_count,
          median_minutes, p80_minutes, ewma_minutes, updated_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         sample_count    = VALUES(sample_count),
         median_minutes  = VALUES(median_minutes),
         p80_minutes     = VALUES(p80_minutes),
         ewma_minutes    = VALUES(ewma_minutes),
         updated_at      = VALUES(updated_at)`,
      [rows],
    );
  }

  return { ok: true, companyId, groups: rows.length };
}

/** Recompute every company that owns at least one completed task. */
export async function recomputeAllCompanies() {
  const [rows] = await pool.query(
    `SELECT DISTINCT company_id FROM fab_project_tasks
      WHERE deleted_at IS NULL AND status = 'done'`,
  );
  const results = [];
  for (const r of rows) {
    try {
      results.push(await recomputeStatsForCompany(r.company_id));
    } catch (err) {
      logger.error({ err, companyId: r.company_id }, 'recomputeAllCompanies: company failed');
    }
  }
  return { ok: true, companies: results.length, results };
}

/**
 * EU-15's read gate: returns the fab_operation_stats row for this
 * (company, operation, resourceType) group only if it's "usable" —
 * sample_count ≥ 3 (MIN_SAMPLES) and p80_minutes is present. Otherwise null.
 * resourceTypeId may be null (matches the group with no resource-type
 * breakdown).
 */
export async function getUsableStat(companyId, operationId, resourceTypeId) {
  const resourceTypeClause = resourceTypeId == null ? 'resource_type_id IS NULL' : 'resource_type_id = ?';
  const params = resourceTypeId == null
    ? [companyId, operationId, MIN_SAMPLES]
    : [companyId, operationId, resourceTypeId, MIN_SAMPLES];

  const [rows] = await pool.query(
    `SELECT id, company_id, operation_id, resource_type_id, sample_count,
            median_minutes, p80_minutes, ewma_minutes, updated_at
       FROM fab_operation_stats
      WHERE company_id = ? AND operation_id = ? AND ${resourceTypeClause}
        AND deleted_at IS NULL AND sample_count >= ? AND p80_minutes IS NOT NULL
      LIMIT 1`,
    params,
  );
  return rows.length > 0 ? rows[0] : null;
}
