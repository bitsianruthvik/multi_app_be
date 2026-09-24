import { Router } from 'express';
import { PERM, guard, handle } from '../lib/http.js';

const router = Router();

/**
 * cf_hrms — overview routes (plan §7).
 *
 * WILL OWN: the home cockpit counts and the navigation counts.
 *
 * Read-only aggregation over everything else; it is built last because it has nothing to count until the rest exists.
 *
 * STUB. Phase 1 is the schema; this router exists so routes/index.js mounts a
 * real Express router and the server boots with every mount point in place.
 * Phase 11 fills it in. Until then the only endpoint reports that, and
 * returns an empty list rather than a 404 — a screen wired early sees "nothing
 * yet", not "the backend is broken".
 *
 * Reads that are plain lists will go through the generic query API
 * (resourceDef.json) rather than through here. What lands here is everything
 * with a rule behind it: effective-dated writes, the three-way content
 * resolution, approvals, document generation and the import.
 */
router.get('/overview/status', guard(PERM.orgView), handle(async () => ({
  section: 'overview',
  implemented: false,
  phase: 11,
  viewPermission: PERM.orgView,
  managePermission: PERM.orgView,
  items: [],
  total: 0,
})));

export default router;
