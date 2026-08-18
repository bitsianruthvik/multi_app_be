import fs   from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';
import indexRoutes            from './routes/index.js';
import plannerRoutes          from './routes/planner.js';
import procurementRoutes      from './routes/procurement.js';
import { logger }              from '../../core/utils/logger.js';
import { getQueue }            from '../../core/jobs/queue.js';
import attributionJobHandlers  from './workers/jobHandlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const resourceDefs = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'resourceDef.json'), 'utf-8'),
);

export default {
  slug: 'fab_erp',
  resourceDefs,
  jobHandlers: attributionJobHandlers,

  register(server) {
    server.use('/api/:companySlug/fab_erp', indexRoutes);
    // EU-4: critical-chain baseline route, mounted separately (same prefix)
    // Production Planner: the time-phased day/week plan. Same prefix, same
    // reason as the two above. It REPLACED routes/dispatch.js (deleted
    // 2026-08-14) — dispatch answered the same question with no time axis, and
    // two endpoints disagreeing about what to work on next is worse than one.
    // `services/dispatchService.js` deliberately survives: computeOrderSlack is
    // the planner's priority input and its file header is the reasoning behind
    // the whole ranking. The fab_dispatch_* tables stay as history.
    server.use('/api/:companySlug/fab_erp', plannerRoutes);
    // Procurement + production orders: the two documents a finished BOM leads
    // to. Same prefix, same reason as the two above.
    server.use('/api/:companySlug/fab_erp', procurementRoutes);
    // EU-3: wait-attribution sweep every 15 min. When Redis is available we
    // enqueue onto the 'fab_erp' Bull queue (processor wired by jobHandlers);
    // when it isn't (getQueue → null, this repo's default) we run the sweep
    // handler inline instead. Fully fire-and-forget — never throws into the tick.
    setInterval(() => {
      try {
        const queue = getQueue('fab_erp');
        if (queue) {
          queue.add('fab_erp:attribution-sweep', {}).catch(() => {});
        } else {
          attributionJobHandlers['fab_erp:attribution-sweep']({}).catch((err) =>
            logger.error({ err }, '[attribution] inline sweep failed'),
          );
        }
      } catch (err) {
        logger.error({ err }, '[attribution] sweep tick failed');
      }
    }, 15 * 60 * 1000);
    logger.info('[attribution] wait-attribution sweep scheduler started');

    // The nightly learned-duration recompute lived here. Learned durations were
    // removed 2026-08-05 (buffer sizing is a fixed 50%, so nothing consumed
    // them) along with the 'fab_erp:operation-stats' handler this tick invoked.
    // Left in place it would have dereferenced an undefined handler once a day,
    // caught by the outer try/catch and logged as a recurring error forever.
  },

  migrations: path.join(__dirname, 'models', 'init.sql'),
};
