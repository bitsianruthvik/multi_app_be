import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import dataRoutes from './routes/data.js';
import setupRoutes from './routes/setup.js';
import commsRoutes from './routes/comms.js';
import { startDigest } from './lib/digest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * cf_crm — a customer, referral and marketing network (NorthEast Network,
 * ported). Contacts, companies, groups, leads with per-business pipelines,
 * follow-ups, referrals, segments, campaigns, documents, team chat.
 *
 * TENANCY. Unlike the other apps, the data belongs to a CUSTOMER, not to a
 * company: a customer (cf_crm_customers) owns one shared network and its
 * branding, and every company linked to it (cf_crm_customer_companies) works
 * on that network. Northeast is one customer with two companies, the chit
 * fund and the real estate business. Everything is keyed by customer_id, and
 * the customer always comes from the login's company (lib/context.js).
 *
 * THE SCREEN is the original single-page app, kept as it was because the
 * customer chose it: multi_app_fe/public/cf_crm/ (app.js, app.css,
 * app.html), shown full-screen by the React route /:company/cf_crm/*. It keeps
 * a local copy of the records and syncs through /sync and /records.
 *
 * Nothing is registered with the generic query API: every read here applies
 * the owner / private / business visibility rules, which that API cannot.
 *
 * Schema: models/init.sql (12 tables, ends SCHEMA-OK). Not run by the loader;
 * apply it by hand, like every app's schema. Customers and their companies:
 * scripts/seed_northeast.mjs.
 */
const router = Router({ mergeParams: true });
router.get('/health', (req, res) => res.json({ ok: true, app: 'cf_crm' }));
router.use(dataRoutes);
router.use(setupRoutes);
router.use(commsRoutes);

export default {
  slug: 'cf_crm',
  resourceDefs: {},
  register(server) {
    server.use('/api/:companySlug/cf_crm', router);
    // the morning follow-up reminder (every 15 minutes it checks whose morning it is)
    startDigest();
  },
  migrations: path.join(__dirname, 'models', 'init.sql'),
};
