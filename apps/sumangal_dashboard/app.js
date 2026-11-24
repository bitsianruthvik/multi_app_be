import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import reportRoutes from './routes/reports.js';
import agentRoutes from './routes/agent.js';
import { protect as protectHealth } from '../../core/middleware/authmiddleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * sumangal_dashboard — customers, operations and order types for an investment
 * casting company, worked out from rows loaded out of a snapshot of its ERP.
 *
 * Nothing here talks to the ERP. scripts/build-facts.mjs makes the rows and
 * scripts/load-facts.mjs stores them in sd_rows. Only what the ERP records, added up.
 *
 * Schema: models/init.sql. App row, company and access: scripts/setup.mjs.
 */
const router = Router({ mergeParams: true });
// signed in only (2026-11-24): answered under a company's address, it told anyone which companies use this app
router.get('/health', protectHealth, (req, res) => res.json({ ok: true, app: 'sumangal_dashboard' }));
router.use(agentRoutes);
router.use(reportRoutes);

export default {
  slug: 'sumangal_dashboard',
  resourceDefs: {},
  register(server) {
    server.use('/api/:companySlug/sumangal_dashboard', router);
  },
  migrations: path.join(__dirname, 'models', 'init.sql'),
};
