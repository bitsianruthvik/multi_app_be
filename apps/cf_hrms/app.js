import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import indexRoutes from './routes/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resourceDefs = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'resourceDef.json'), 'utf-8'),
);

/**
 * cf_hrms — People + Organisation Definition.
 *
 * Data model: HRMS_Core_V1_Taxonomy + HRMS_Core_V1_Architecture, with every
 * decision, every platform adaptation and every deviation from the spec
 * recorded in TM/CF_HRMS_PLAN.md. READ THAT FIRST. models/init.sql explains
 * each of the 46 tables and why it is shaped the way it is.
 *
 * The model in one sentence: the centre is not the employee row and not the
 * org-chart box, it is the WORK ASSIGNMENT — what one person is actually doing
 * now — and everything else hangs off that.
 *
 * Shares no code with cf_erp or fab_erp. lib/ mirrors cf_erp's shape because
 * the platform conventions are the same, but nothing is imported across apps:
 * this app's rules are its own and a shared helper would drag one app's model
 * decisions into another's.
 */
export default {
  slug: 'cf_hrms',
  resourceDefs,

  register(server) {
    server.use('/api/:companySlug/cf_hrms', indexRoutes);
  },

  // Nothing executes these — apps/_loader.js ignores the field and push-to-prod
  // applies a HARD-CODED list (see .claude/commands/push-to-prod.md, step "apply
  // schema"). cf_hrms is deliberately NOT in that list yet: nothing is deployed
  // until asked. When it is added, these two files go in, in this order —
  // init.sql creates everything, seed.sql then grants the permissions and seeds
  // each company's reporting relationship types and shifts.
  //
  // Both files are idempotent and safe to re-run. There is no migrations/
  // folder for this app on purpose: push-to-prod never runs one, so a schema
  // change that lives only there is a change that never reaches production.
  migrations: [
    path.join(__dirname, 'models', 'init.sql'),
    path.join(__dirname, 'models', 'seed.sql'),
  ],
};
