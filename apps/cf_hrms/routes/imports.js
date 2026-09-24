import { Router } from 'express';
import { PERM, guard, handle } from '../lib/http.js';

const router = Router();

/**
 * cf_hrms — imports routes (plan §7).
 *
 * WILL OWN: the org-chart parse → validate → commit pipeline and its run history.
 *
 * Nothing is written to the HR tables until the user accepts the validation report. Every committed run records its full id map in hrms_import_runs so a bad import is traceable and reversible.
 *
 * STUB. Phase 1 is the schema; this router exists so routes/index.js mounts a
 * real Express router and the server boots with every mount point in place.
 * Phase 8 fills it in. Until then the only endpoint reports that, and
 * returns an empty list rather than a 404 — a screen wired early sees "nothing
 * yet", not "the backend is broken".
 *
 * Reads that are plain lists will go through the generic query API
 * (resourceDef.json) rather than through here. What lands here is everything
 * with a rule behind it: effective-dated writes, the three-way content
 * resolution, approvals, document generation and the import.
 */
router.get('/imports/status', guard(PERM.importManage), handle(async () => ({
  section: 'imports',
  implemented: false,
  phase: 8,
  viewPermission: PERM.importManage,
  managePermission: PERM.importManage,
  items: [],
  total: 0,
})));

export default router;
