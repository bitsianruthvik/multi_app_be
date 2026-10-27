import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import leadRoutes from './routes/leads.js';
import { startSweeper } from './lib/deliver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * web_leads — enquiries from the public website (ceofactory.vc, repo TM/ceofactory_site).
 *
 * Not a company app: there is no company or app slug, no screen and no login. The website's own
 * server code posts each form submission to POST /api/public/website/leads with a shared key; the
 * lead is saved in web_leads, then sent to the team's email, Meta's Conversions API and a CRM
 * webhook, each retried until it goes through (lib/deliver.js). appContext skips /api/public.
 *
 * Environment (all optional except WEB_LEADS_KEY; a destination without its settings is skipped):
 *   WEB_LEADS_KEY                     shared with the website's Vercel project
 *   SMTP_URL, WEB_LEADS_NOTIFY_TO, WEB_LEADS_FROM            team email
 *   META_PIXEL_ID, META_CAPI_TOKEN, META_GRAPH_VERSION, META_TEST_EVENT_CODE   Meta CAPI
 *   WEB_LEADS_CRM_WEBHOOK_URL, WEB_LEADS_CRM_SECRET          CRM
 *   WEB_LEADS_SWEEP=off               no retry timer (tests)
 *
 * Schema: models/init.sql (2 tables, ends SCHEMA-OK). Not run by the loader; apply it by hand.
 */
const limiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

export default {
  slug: 'web_leads',
  resourceDefs: {},
  register(server) {
    server.use('/api/public/website', limiter, express.json({ limit: '64kb' }), leadRoutes);
    startSweeper();
  },
  migrations: path.join(__dirname, 'models', 'init.sql'),
};
