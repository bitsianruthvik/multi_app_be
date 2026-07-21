/**
 * workers/jobHandlers.js — EU-3: background sweep for wait attribution.
 *
 * Exports a handler map keyed by job name. The 'fab_erp:attribution-sweep'
 * handler recomputes wait attribution across tasks:
 *   - data.companyId present → sweepCompany(companyId)
 *   - otherwise             → sweepAllCompanies()
 *
 * The object also carries a jobRegistry-compatible register({ getQueue }) so a
 * Bull processor is wired when Redis IS available. In this repo Redis is
 * optional (usually absent) — jobRegistry then skips registration and app.js's
 * interval invokes the handler inline instead (see app.js).
 */

import { logger } from '../../../core/utils/logger.js';
import { sweepCompany, sweepAllCompanies } from '../services/taskAttributionService.js';

const SWEEP_JOB = 'fab_erp:attribution-sweep';

const jobHandlers = {
  [SWEEP_JOB]: async (data = {}) => {
    const limit = data && data.limit != null ? Number(data.limit) : 500;
    if (data && data.companyId) {
      return sweepCompany(data.companyId, { limit });
    }
    return sweepAllCompanies({ limit });
  },

  // Wired only when Redis is available (jobRegistry short-circuits otherwise).
  async register({ getQueue }) {
    const queue = getQueue('fab_erp');
    if (!queue) {
      logger.warn('[jobs] fab_erp: queue unavailable, skipping attribution-sweep processor.');
      return;
    }
    queue.process(SWEEP_JOB, async (job) => jobHandlers[SWEEP_JOB](job.data || {}));
    logger.info('[jobs] fab_erp attribution-sweep processor registered.');
  },
};

export default jobHandlers;
