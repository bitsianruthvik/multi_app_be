/**
 * workers/jobHandlers.js — EU-3: background sweep for wait attribution.
 *                          EU-14: nightly operation-stats recompute.
 *
 * Exports a handler map keyed by job name. The 'fab_erp:attribution-sweep'
 * handler recomputes wait attribution across tasks:
 *   - data.companyId present → sweepCompany(companyId)
 *   - otherwise             → sweepAllCompanies()
 *
 * The 'fab_erp:cc-sweep' handler (EU-5) recomputes Critical Chain buffer
 * consumption for every status='baselined' plan (batch-limited). Unlike the two
 * sweeps above — whose 15-min/24h ticks live in app.js — this module self-starts
 * its own 15-min tick (see startCcSweepScheduler at the bottom) so the whole
 * EU-5 sweep stays self-contained here. Same getQueue null-guard inline fallback:
 * enqueue onto the 'fab_erp' Bull queue when Redis is available, run inline when
 * it isn't (this repo's default).
 *
 * The object also carries a jobRegistry-compatible register({ getQueue }) so a
 * Bull processor is wired when Redis IS available. In this repo Redis is
 * optional (usually absent) — jobRegistry then skips registration and app.js's
 * interval invokes the handler inline instead (see app.js).
 */

import { logger } from '../../../core/utils/logger.js';
import { getQueue } from '../../../core/jobs/queue.js';
import { sweepCompany, sweepAllCompanies } from '../services/taskAttributionService.js';
import { recomputeAllBaselined } from '../services/ccBufferService.js';
import { sweepBlockedTasksAllCompanies } from '../services/taskGatingService.js';

const SWEEP_JOB = 'fab_erp:attribution-sweep';
const CC_SWEEP_JOB = 'fab_erp:cc-sweep';
const GATE_SWEEP_JOB = 'fab_erp:gate-sweep';
let _gateSweepRunning = false;
const CC_SWEEP_PERIOD_MS = 15 * 60 * 1000;

const jobHandlers = {
  [SWEEP_JOB]: async (data = {}) => {
    const limit = data && data.limit != null ? Number(data.limit) : 500;
    if (data && data.companyId) {
      return sweepCompany(data.companyId, { limit });
    }
    return sweepAllCompanies({ limit });
  },

  // Re-check tasks still blocked on material. The receipt-time hook is the
  // primary path and is retried; this is the net under it, because that hook is
  // the ONLY thing that unblocks material-gated work and a process restart
  // mid-receipt would otherwise strand it indefinitely.
  // Re-entrancy guarded and batch-capped: a full pass over 275 blocked tasks
  // measured ~36s against TiDB, which is comfortably inside the 15-minute tick
  // but not so far inside that two passes could never overlap on a bigger shop.
  // Overlapping passes would double the load to reach the same answer.
  [GATE_SWEEP_JOB]: async (data = {}) => {
    if (_gateSweepRunning) {
      logger.warn('[gate-sweep] previous pass still running; skipping this tick');
      return { skipped: true };
    }
    _gateSweepRunning = true;
    try {
      const limit = data && data.limit != null ? Number(data.limit) : 200;
      return await sweepBlockedTasksAllCompanies({ limit });
    } finally {
      _gateSweepRunning = false;
    }
  },

  // EU-5: recompute CC buffer consumption for all baselined plans, batch-limited.
  [CC_SWEEP_JOB]: async (data = {}) => {
    const limit = data && data.limit != null ? Number(data.limit) : 500;
    return recomputeAllBaselined({ limit });
  },

  // Wired only when Redis is available (jobRegistry short-circuits otherwise).
  async register({ getQueue: getQ }) {
    const queue = getQ('fab_erp');
    if (!queue) {
      logger.warn('[jobs] fab_erp: queue unavailable, skipping attribution-sweep/operation-stats/cc-sweep processors.');
      return;
    }
    queue.process(SWEEP_JOB, async (job) => jobHandlers[SWEEP_JOB](job.data || {}));
    queue.process(CC_SWEEP_JOB, async (job) => jobHandlers[CC_SWEEP_JOB](job.data || {}));
    // Must be registered, not just enqueued: the scheduler above adds a
    // GATE_SWEEP_JOB on every tick when Redis is up, and without a processor
    // those would accumulate unread while the safety net silently never ran.
    queue.process(GATE_SWEEP_JOB, async (job) => jobHandlers[GATE_SWEEP_JOB](job.data || {}));
    logger.info('[jobs] fab_erp attribution-sweep + cc-sweep + gate-sweep processors registered.');
  },
};

// EU-5: 15-min Critical-Chain buffer-consumption sweep. Mirrors app.js's
// attribution-sweep tick (enqueue on the 'fab_erp' Bull queue when Redis is up;
// run the handler inline when getQueue → null), but self-scheduled here so the
// EU-5 sweep is fully self-contained in this module. Fire-and-forget — a failure
// never escapes the tick. Guarded so it starts exactly once per process.
let _ccSweepStarted = false;
export function startCcSweepScheduler() {
  if (_ccSweepStarted) return;
  _ccSweepStarted = true;
  setInterval(() => {
    try {
      const queue = getQueue('fab_erp');
      if (queue) {
        queue.add(CC_SWEEP_JOB, {}).catch(() => {});
        queue.add(GATE_SWEEP_JOB, {}).catch(() => {});
      } else {
        jobHandlers[CC_SWEEP_JOB]({}).catch((err) =>
          logger.error({ err }, '[cc-sweep] inline sweep failed'),
        );
        // Rides the same tick rather than adding a second timer: both answer
        // "has something changed underneath a stored decision?", and neither
        // needs to be more punctual than the other.
        jobHandlers[GATE_SWEEP_JOB]({})
          .then((r) => {
            if (r?.cleared?.length) {
              logger.info({ cleared: r.cleared.length }, '[gate-sweep] unblocked tasks the receipt hook had missed');
            }
          })
          .catch((err) => logger.error({ err }, '[gate-sweep] inline sweep failed'));
      }
    } catch (err) {
      logger.error({ err }, '[cc-sweep] sweep tick failed');
    }
  }, CC_SWEEP_PERIOD_MS);
  logger.info('[cc-sweep] critical-chain and material-gate sweep scheduler started');
}

// Start on module load. jobHandlers.js is imported once, at server boot (app.js →
// _loader), so this schedules the tick at startup without touching app.js.
startCcSweepScheduler();

export default jobHandlers;
