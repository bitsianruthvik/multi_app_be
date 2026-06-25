// mutate.js — Express Router for the fab_erp permission-gated write path.
//
// Mounted by the app orchestrator under /api/:companySlug/fab_erp
// so the effective URL is:  POST /api/:companySlug/fab_erp/mutate
//
// DO NOT import or edit routes/index.js or app.js here.

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { mutate } from '../controllers/mutateController.js';

const router = Router();

// protect verifies the JWT (cookie or Authorization: Bearer) and attaches req.user.
// The controller handles resource-level permission checks.
router.post('/mutate', protect, mutate);

export default router;
