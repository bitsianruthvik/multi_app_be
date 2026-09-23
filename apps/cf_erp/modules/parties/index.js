import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPartiesRouter } from './routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * parties — customers, suppliers and subcontractors.
 *
 * A separate module (like codegen) because these are the platform's shared
 * masters: a future CRM or supplier app should depend on them, not on cf_erp.
 * ./models/init.sql explains the table.
 *
 * Boundary rules — what keeps this module liftable into the platform core:
 *   - Nothing in this folder imports from the rest of cf_erp, and its table has
 *     no foreign keys into cf_erp tables (cf_erp tables point at it instead).
 *   - The host says what references a party through registerReferenceCheck.
 *   - The host supplies permission tags when it mounts the routes.
 */
export { registerReferenceCheck } from './service.js';
export { PartyError } from './errors.js';

export default {
  name: 'parties',
  resourceDefs: JSON.parse(fs.readFileSync(path.join(__dirname, 'resourceDef.json'), 'utf-8')),
  schema: path.join(__dirname, 'models', 'init.sql'),
  createRouter: createPartiesRouter,
};
