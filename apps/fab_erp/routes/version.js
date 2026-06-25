// routes/version.js — POST /version/new
// Mounted by the orchestrator under /api/:companySlug/fab_erp
// EU-B5

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { createVersion } from '../services/versionService.js';

const router = Router();

/**
 * POST /version/new
 * Body: { entity: string, sourceId: number }
 * Returns: { newId: number, versionNo: number }
 */
router.post('/version/new', protect, async (req, res) => {
  try {
    const { entity, sourceId } = req.body ?? {};

    if (!entity || sourceId == null) {
      return res.status(400).json({ message: 'entity and sourceId are required.' });
    }

    const companyId = req.user?.companyId ?? req.user?.company_id;
    if (!companyId) {
      return res.status(401).json({ message: 'Cannot resolve companyId from token.' });
    }

    const { newId, versionNo } = await createVersion(entity, Number(sourceId), Number(companyId));

    return res.status(201).json({ newId, versionNo });
  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ message: err.message ?? 'Versioning failed.' });
  }
});

export default router;
