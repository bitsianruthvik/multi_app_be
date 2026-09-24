import { Router } from 'express';
import { PERM, guard, handle } from '../lib/http.js';

const router = Router();

/**
 * cf_hrms — leave routes (plan §7).
 *
 * WILL OWN: leave types, balances and requests.
 *
 * Approving a request writes the attendance rows for the affected dates and moves the balance, in one transaction. That side effect is why leave is not a standalone list.
 *
 * STUB. Phase 1 is the schema; this router exists so routes/index.js mounts a
 * real Express router and the server boots with every mount point in place.
 * Phase 10 fills it in. Until then the only endpoint reports that, and
 * returns an empty list rather than a 404 — a screen wired early sees "nothing
 * yet", not "the backend is broken".
 *
 * Reads that are plain lists will go through the generic query API
 * (resourceDef.json) rather than through here. What lands here is everything
 * with a rule behind it: effective-dated writes, the three-way content
 * resolution, approvals, document generation and the import.
 */
router.get('/leave/status', guard(PERM.leaveView), handle(async () => ({
  section: 'leave',
  implemented: false,
  phase: 10,
  viewPermission: PERM.leaveView,
  managePermission: PERM.leaveManage,
  items: [],
  total: 0,
})));

export default router;
