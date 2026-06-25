import fs   from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';
import indexRoutes            from './routes/index.js';
import { runMrp, markAutoRun } from './services/mrpService.js';
import { pool }                from '../../db.js';
import { logger }              from '../../core/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const resourceDefs = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'resourceDef.json'), 'utf-8'),
);

// ── Per-company MRP cron ──────────────────────────────────────────────────────
// Runs every minute. For each company whose scheduled time matches NOW()
// and hasn't run today, triggers an MRP run and marks today as done.
async function checkAndRunMrp() {
  try {
    const now   = new Date();
    const h     = now.getHours();
    const m     = now.getMinutes();
    const today = now.toISOString().slice(0, 10);

    const [companies] = await pool.query(
      `SELECT c.id,
              COALESCE(s.run_hour,   23) AS run_hour,
              COALESCE(s.run_minute,  0) AS run_minute,
              s.last_auto_run_date
       FROM companies c
       LEFT JOIN fab_mrp_settings s ON s.company_id = c.id
       WHERE c.deleted_at IS NULL
         AND COALESCE(s.auto_run_enabled, 1) = 1
         AND COALESCE(s.run_hour, 23)   = ?
         AND COALESCE(s.run_minute, 0)  = ?
         AND (s.last_auto_run_date IS NULL OR s.last_auto_run_date < ?)`,
      [h, m, today],
    );

    for (const c of companies) {
      // Mark first to avoid a second tick in the same minute re-running it
      await markAutoRun(c.id, today).catch(() => {});
      runMrp(c.id, { triggeredBy: 'cron' }).catch((err) =>
        logger.error({ err, companyId: c.id }, '[mrp] cron run failed'),
      );
    }
  } catch (err) {
    logger.error({ err }, '[mrp] cron check failed');
  }
}

export default {
  slug: 'fab_erp',
  resourceDefs,
  jobHandlers: {},

  register(server) {
    server.use('/api/:companySlug/fab_erp', indexRoutes);
    // Tick every 60 s — checks each company's configured run time
    setInterval(checkAndRunMrp, 60 * 1000);
    logger.info('[mrp] per-company nightly scheduler started');
  },

  migrations: path.join(__dirname, 'models', 'init.sql'),
};
