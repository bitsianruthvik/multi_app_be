import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import reportRoutes from './routes/reports.js';

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
router.get('/health', (req, res) => res.json({ ok: true, app: 'sumangal_dashboard' }));
router.use(reportRoutes);

export default {
  slug: 'sumangal_dashboard',
  resourceDefs: {},
  register(server) {
    server.use('/api/:companySlug/sumangal_dashboard', router);
  },
  migrations: path.join(__dirname, 'models', 'init.sql'),
};
