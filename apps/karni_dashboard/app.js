import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import connectorRoutes from './routes/connector.js';
import reportRoutes from './routes/reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * karni_dashboard — a live dashboard over the company's SAP Business One.
 *
 * STRICTLY READ-ONLY towards SAP (user's rule, 2026-10-17; CLAUDE.md, AGENTS.md §2).
 * Nothing here talks to SAP. A connector inside the customer's network
 * (connector/run.ps1) reads the Service Layer with GET only and pushes rows
 * here (routes/connector.js); the screens read those rows (routes/reports.js).
 *
 * Schema: models/init.sql — apply by hand. App row + access: scripts/setup.mjs.
 */
const router = Router({ mergeParams: true });
router.get('/health', (req, res) => res.json({ ok: true, app: 'karni_dashboard' }));
router.use(connectorRoutes);
router.use(reportRoutes);

export default {
  slug: 'karni_dashboard',
  resourceDefs: {},
  register(server) {
    server.use('/api/:companySlug/karni_dashboard', router);
  },
  migrations: path.join(__dirname, 'models', 'init.sql'),
};
