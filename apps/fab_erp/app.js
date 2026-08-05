import fs   from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';
import indexRoutes            from './routes/index.js';
import criticalChainRoutes    from './routes/criticalChain.js';
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
    // rather than folded into routes/index.js — see routes/criticalChain.js.
    server.use('/api/:companySlug/fab_erp', criticalChainRoutes);
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
