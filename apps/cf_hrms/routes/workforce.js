import { Router } from 'express';
import { PERM, guard, handle } from '../lib/http.js';

const router = Router();

/**
 * cf_hrms — workforce routes (plan §7).
 *
 * WILL OWN: manpower requirements, shift rosters, attendance records and regularisations.
 *
 * ATTENDANCE IS PER EMPLOYEE PER DAY PER SHIFT. Nothing in this file may create a second attendance row because a person holds a second role; work_assignment_id is attribution only.
 *
 * STUB. Phase 1 is the schema; this router exists so routes/index.js mounts a
 * real Express router and the server boots with every mount point in place.
 * Phase 9 fills it in. Until then the only endpoint reports that, and
 * returns an empty list rather than a 404 — a screen wired early sees "nothing
 * yet", not "the backend is broken".
 *
 * Reads that are plain lists will go through the generic query API
 * (resourceDef.json) rather than through here. What lands here is everything
 * with a rule behind it: effective-dated writes, the three-way content
 * resolution, approvals, document generation and the import.
 */
router.get('/workforce/status', guard(PERM.attendanceView), handle(async () => ({
  section: 'workforce',
  implemented: false,
  phase: 9,
  viewPermission: PERM.attendanceView,
  managePermission: PERM.attendanceManage,
  items: [],
  total: 0,
})));

export default router;
