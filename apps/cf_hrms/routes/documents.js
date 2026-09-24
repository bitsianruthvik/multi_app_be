import { Router } from 'express';
import { PERM, guard, handle } from '../lib/http.js';

const router = Router();

/**
 * cf_hrms — documents routes (plan §7).
 *
 * WILL OWN: Role JD and Employee Responsibility Profile generation, snapshot retrieval and DOCX / PDF download.
 *
 * The snapshot is written BEFORE the file is rendered, and a historical document re-renders from its own snapshot and never from today’s role definition.
 *
 * STUB. Phase 1 is the schema; this router exists so routes/index.js mounts a
 * real Express router and the server boots with every mount point in place.
 * Phase 7 fills it in. Until then the only endpoint reports that, and
 * returns an empty list rather than a 404 — a screen wired early sees "nothing
 * yet", not "the backend is broken".
 *
 * Reads that are plain lists will go through the generic query API
 * (resourceDef.json) rather than through here. What lands here is everything
 * with a rule behind it: effective-dated writes, the three-way content
 * resolution, approvals, document generation and the import.
 */
router.get('/documents/status', guard(PERM.orgView), handle(async () => ({
  section: 'documents',
  implemented: false,
  phase: 7,
  viewPermission: PERM.orgView,
  managePermission: PERM.documentsGenerate,
  items: [],
  total: 0,
})));

export default router;
