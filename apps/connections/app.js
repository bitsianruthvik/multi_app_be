import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import connectionRoutes from './routes/connections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * connections — a company's links to outside data (OneDrive first).
 *
 * STRICTLY READ-ONLY towards the outside system: a provider has no write method.
 * A new kind of connection is one file in providers/ plus one line in
 * providers/index.js; the screen builds its form from the provider's fields.
 * Other apps read through services/connectionService.js (listFiles, openFile).
 *
 * Schema: models/init.sql — apply by hand. App row + access: scripts/setup.mjs.
 * Secrets are encrypted with CONNECTIONS_KEY (lib/secrets.js).
 */
const router = Router({ mergeParams: true });
router.get('/health', (req, res) => res.json({ ok: true, app: 'connections' }));
router.use(connectionRoutes);

export default {
  slug: 'connections',
  resourceDefs: {},
  register(server) {
    server.use('/api/:companySlug/connections', router);
  },
  migrations: path.join(__dirname, 'models', 'init.sql'),
};
