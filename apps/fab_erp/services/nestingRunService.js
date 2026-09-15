/**
 * nestingRunService.js — a blank-plan pack that runs in the background.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 *
 * `standard`/`deep` can run for tens of seconds; `blankPlanService`'s own
 * `SAFETY_MS` ceiling is five minutes. `GET /orders/:id/blanks` runs that
 * synchronously today — the request just blocks, and the frontend's only
 * option is to sit on a spinner and hope the connection does not time out
 * first. `fab_nesting_runs` (EU-1) is the row a client can instead fire and
 * poll: `startRun` returns its id immediately, and the pack happens off to
 * the side.
 *
 * ── GRACEFUL JOB QUEUE DEGRADATION (§12), THE CONTRACT EITHER WAY ──────────
 *
 * When Redis is up the pack is enqueued on the shared `fab_erp` Bull queue and
 * a processor (registered in `workers/jobHandlers.js`) runs it; when it is not
 * (this repo's default — `core/jobs/queue.js` returns `getQueue() → null`) it
 * runs inline, via `setImmediate` so the HTTP response carrying the run id
 * returns to the caller BEFORE the pack starts rather than after. Either way
 * the `fab_nesting_runs` row is the only thing a caller reads — the frontend
 * polls one way regardless of which path actually ran the job.
 *
 * ── PROGRESS AND CANCEL ARE COARSE, ON PURPOSE ──────────────────────────────
 *
 * `blankPlanService.blankPlan` exposes neither a progress callback nor a
 * cooperative cancel hook (its own restart loop runs to a deadline via
 * `nestAsync`, one call per material group), and it is outside this EU's file
 * allowlist — adding either belongs to whoever next touches that file. So:
 *
 *   progress   only two real values happen — 1 while running, 100 once the
 *              whole pack returns. There is no "40% done" to report.
 *   cancel     `cancelRun` marks the row `cancelled` immediately, whatever the
 *              pack is doing. `runQueuedJob` checks that flag the ONE place it
 *              can — after `blankPlan` returns — and DISCARDS the result
 *              rather than overwriting a row the caller already told to stop.
 *              The pack itself keeps running to completion either way; this
 *              is "stop showing me this" not "stop the CPU".
 */

import { pool } from '../../../db.js';
import { getQueue } from '../../../core/jobs/queue.js';
import { blankPlan } from './blankPlanService.js';
import { logger } from '../../../core/utils/logger.js';

export const NESTING_RUN_JOB = 'fab_erp:nesting-run';

const parseJson = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v; // mysql2 already parses JSON columns
  try { return JSON.parse(v); } catch { return null; }
};

const rowToRun = (row) => ({
  id: Number(row.id),
  status: row.status,
  progress: Number(row.progress) || 0,
  kind: row.kind,
  effort: row.effort ?? null,
  result: parseJson(row.result_json ?? row.resultJson),
  error: row.error_text ?? row.errorText ?? null,
  startedAt: row.started_at ?? row.startedAt ?? null,
  finishedAt: row.finished_at ?? row.finishedAt ?? null,
  createdAt: row.created_at ?? row.createdAt ?? null,
});

/**
 * Queue a blank-plan pack for an order. Returns as soon as the row exists —
 * before the pack has necessarily even started — so the caller can begin
 * polling `getRun` right away.
 *
 * @param {number} companyId
 * @param {number} orderId
 * @param {{kind?:string, effort?:'quick'|'standard'|'deep', requestedBy?:number}} opts
 * @returns {Promise<{runId:number}>}
 */
export async function startRun(companyId, orderId, opts = {}) {
  const kind = opts.kind ?? 'blank_plan';
  const effort = opts.effort ?? null;
  const [ins] = await pool.query(
    `INSERT INTO fab_nesting_runs
       (company_id, order_id, kind, effort, status, progress, params_json, requested_by, created_at)
     VALUES (?,?,?,?,'queued',0,?,?, UTC_TIMESTAMP())`,
    [companyId, orderId, kind, effort, JSON.stringify({ effort }), opts.requestedBy ?? null],
  );
  const runId = ins.insertId;
  const data = { runId, companyId, orderId, effort };

  const queue = getQueue('fab_erp');
  if (queue) {
    /*
     * NOT AWAITED, AND RACED AGAINST A TIMEOUT — `getQueue()` returns a
     * live-looking Bull instance the moment REDIS_URL is merely SET, whether
     * or not a Redis server actually answers (this repo's local `.env` sets
     * one with nothing listening). ioredis's default offline queue means
     * `.add()` against a socket that never connects neither resolves NOR
     * rejects — it just sits, so the `app.js`/`jobHandlers.js` sweep ticks'
     * plain `.catch(() => {})` idiom is not enough here: nothing would ever
     * run this queued row. `runQueuedJob` is safe to invoke twice (its own
     * `UPDATE ... WHERE status = 'queued'` lets only the first caller win),
     * so racing a short timeout against the real enqueue can only ever run
     * the pack once, from whichever side gets there.
     */
    const ENQUEUE_TIMEOUT_MS = 2000;
    Promise.race([
      queue.add(NESTING_RUN_JOB, data).then(() => 'enqueued'),
      new Promise((resolve) => setTimeout(resolve, ENQUEUE_TIMEOUT_MS, 'timed-out')),
    ])
      .catch((err) => { logger.error({ err, runId }, 'fab_erp: nesting-run enqueue failed'); return 'timed-out'; })
      .then((outcome) => {
        if (outcome === 'enqueued') return null;
        logger.warn({ runId }, 'fab_erp: nesting-run queue did not confirm in time, running inline');
        return runQueuedJob(data);
      })
      .catch((err) => logger.error({ err, runId }, 'fab_erp: inline nesting run failed'));
  } else {
    // No Redis configured at all. `setImmediate`, not a bare await, so the
    // HTTP response carrying `runId` reaches the caller before a pack that
    // can run for minutes ties up this tick.
    setImmediate(() => runQueuedJob(data).catch((err) =>
      logger.error({ err, runId }, 'fab_erp: inline nesting run failed')));
  }
  return { runId };
}

/**
 * The job itself — called by the Bull processor (`workers/jobHandlers.js`)
 * when Redis is up, or directly via `setImmediate` above when it is not. Both
 * paths converge here so there is exactly one place that runs a pack and
 * writes its result.
 */
export async function runQueuedJob({ runId, companyId, orderId, effort }) {
  // Only a still-`queued` row is ours to start — a cancel that landed before
  // this tick fired must not be resurrected into `running`.
  const [claim] = await pool.query(
    `UPDATE fab_nesting_runs SET status = 'running', started_at = UTC_TIMESTAMP(), progress = 1
      WHERE id = ? AND company_id = ? AND status = 'queued'`,
    [runId, companyId],
  );
  if (!claim.affectedRows) return;

  /*
   * PROGRESS IS REAL NOW. The search reports how much of its budget it has
   * spent (blankPlanService threads `onProgress` through to the packer's
   * repair loop); it is written back at most every couple of seconds so a
   * five-minute run does not turn into a hundred UPDATEs.
   */
  let lastWrite = 0;
  let lastPct = 1;
  const onProgress = (fraction) => {
    const pct = Math.max(1, Math.min(99, Math.round(fraction * 100)));
    const now = Date.now();
    if (pct === lastPct || now - lastWrite < 2000) return;
    lastPct = pct; lastWrite = now;
    pool.query(
      `UPDATE fab_nesting_runs SET progress = ? WHERE id = ? AND company_id = ? AND status = 'running'`,
      [pct, runId, companyId],
    ).catch(() => {});
  };

  let result;
  try {
    result = await blankPlan(companyId, orderId, { effort: effort ?? undefined, repack: true, onProgress });
  } catch (err) {
    await pool.query(
      `UPDATE fab_nesting_runs SET status = 'error', error_text = ?, progress = 100,
              finished_at = UTC_TIMESTAMP()
        WHERE id = ? AND company_id = ? AND status = 'running'`,
      [String(err?.message ?? err).slice(0, 4000), runId, companyId],
    );
    return;
  }

  // See the file header: this is the one place a cancel that arrived mid-pack
  // is honoured, by discarding the result rather than overwriting `cancelled`.
  const [[row]] = await pool.query(
    `SELECT status FROM fab_nesting_runs WHERE id = ? AND company_id = ? LIMIT 1`,
    [runId, companyId],
  );
  if (row?.status === 'cancelled') return;

  await pool.query(
    `UPDATE fab_nesting_runs SET status = 'done', result_json = ?, progress = 100,
            finished_at = UTC_TIMESTAMP()
      WHERE id = ? AND company_id = ? AND status = 'running'`,
    [JSON.stringify(result), runId, companyId],
  );
}

/** One run, as the poll endpoint reports it. Null if it does not exist / is not this order's. */
export async function getRun(companyId, orderId, runId) {
  const [[row]] = await pool.query(
    `SELECT id, status, progress, kind, effort, result_json, error_text,
            started_at, finished_at, created_at
       FROM fab_nesting_runs
      WHERE id = ? AND company_id = ? AND order_id = ? AND deleted_at IS NULL LIMIT 1`,
    [runId, companyId, orderId],
  );
  return row ? rowToRun(row) : null;
}

/** The newest run to finish `done` for this order — what EU-18 shows on mount instead of auto-packing. */
export async function latestDoneRun(companyId, orderId) {
  const [[row]] = await pool.query(
    `SELECT id FROM fab_nesting_runs
      WHERE company_id = ? AND order_id = ? AND status = 'done' AND deleted_at IS NULL
        -- 'accepted' rows hold a plan's kept layouts (blankService), not a run.
        AND kind <> 'accepted'
      ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [companyId, orderId],
  );
  return row ? getRun(companyId, orderId, row.id) : null;
}

/**
 * Ask a run to stop. Only a `queued` or `running` row moves — cancelling a
 * run that already finished (or was already cancelled) is a no-op, reported
 * as such rather than an error, since the caller cannot tell which happened
 * first without asking.
 */
export async function cancelRun(companyId, orderId, runId) {
  const [upd] = await pool.query(
    `UPDATE fab_nesting_runs SET status = 'cancelled', finished_at = UTC_TIMESTAMP()
      WHERE id = ? AND company_id = ? AND order_id = ? AND status IN ('queued','running')
        AND deleted_at IS NULL`,
    [runId, companyId, orderId],
  );
  return { cancelled: upd.affectedRows > 0 };
}
