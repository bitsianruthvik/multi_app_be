import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import indexRoutes from './routes/index.js';
import codegenModule from '../cf_erp/modules/codegen/index.js';
import { PERM } from './lib/http.js';
// Side effect: registers employee codes and letter references with the code generator.
import {
  EMPLOYEE_ENTITY, HIRING_ENTITY, DEPARTMENT_ENTITY, ROLE_ENTITY, POSITION_ENTITY, LOCATION_ENTITY,
} from './services/codegenProvider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * NOTHING OF THIS APP IS REGISTERED WITH THE GENERIC QUERY API (2026-10-12, spec §12.6).
 *
 * resourceDef.json describes 46 hrms tables for /api/query/v1/base_resource.
 * That endpoint knows the caller's company and nothing else: it runs no rights
 * check and has no app context, and so served any login of the tenant — an
 * Employee login, or one whose access to this app had been removed — every
 * employee's phone, email, address and date of birth (cfHrmsEmployee), every
 * work assignment and the audit log. Rights, the department scope and the
 * contact rule mean nothing with that door open.
 *
 * No screen of this app and no other code reads an hrms resource through it
 * (checked: no `cfHrms…` resource is named anywhere in the frontend or the
 * backend), so none is registered. The file stays as the description of the
 * tables. To bring ONE back, register it here by name — and only a table
 * that holds nothing about a person.
 */
const resourceDefs = {};
/** What the file describes — for the test that none of it is reachable. */
export const DESCRIBED_RESOURCES = Object.keys(JSON.parse(
  fs.readFileSync(path.join(__dirname, 'resourceDef.json'), 'utf-8').replace(/^﻿/, ''),
));

/**
 * cf_hrms — People + Organisation Definition.
 *
 * Data model: HRMS_Core_V1_Taxonomy + HRMS_Core_V1_Architecture, with every
 * decision, every platform adaptation and every deviation from the spec
 * recorded in TM/CF_HRMS_PLAN.md. READ THAT FIRST. models/init.sql explains
 * each of the 51 tables and why it is shaped the way it is.
 *
 * The model in one sentence: the centre is not the employee row and not the
 * org-chart box, it is the WORK ASSIGNMENT — what one person is actually doing
 * now — and everything else hangs off that.
 *
 * Shares no code with cf_erp or fab_erp. lib/ mirrors cf_erp's shape because
 * the platform conventions are the same, but nothing is imported across apps:
 * this app's rules are its own and a shared helper would drag one app's model
 * decisions into another's.
 *
 * ONE EXCEPTION, and it is a module, not an app's model: the code generator
 * (apps/cf_erp/modules/codegen). It was written to be lifted — nothing in it
 * imports from cf_erp, entities register a provider, the host supplies the
 * permission tags — and employee codes and letter reference numbers come from
 * it (TM/CF_HRMS_HIRING_SPEC.md §1). It is imported, never copied; what an
 * employee offers it is services/codegenProvider.js. Its tables (cf_code_*)
 * are created by cf_erp's schema files.
 */
export default {
  slug: 'cf_hrms',
  resourceDefs,

  register(server) {
    server.use('/api/:companySlug/cf_hrms', indexRoutes);
    // Code formats: the generator's own routes (/codegen/…), limited to this
    // app's six entity types — cf_erp's item and order rules are not shown here,
    // and its own mount leaves every hrms_ type out.
    server.use('/api/:companySlug/cf_hrms', codegenModule.createRouter({
      viewPerm: PERM.setup.view, managePerm: PERM.setup.edit, entityTypes: [DEPARTMENT_ENTITY, ROLE_ENTITY, POSITION_ENTITY, LOCATION_ENTITY, EMPLOYEE_ENTITY, HIRING_ENTITY],
    }));
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
