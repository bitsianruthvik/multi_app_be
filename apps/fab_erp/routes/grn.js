/**
 * routes/grn.js
 * -------------
 * EU-5: Goods Receipt Note (GRN) posting routes for fab_erp.
 *
 * Mounted by the orchestrator under /api/:companySlug/fab_erp
 * (do NOT edit routes/index.js or app.js).
 *
 * Routes:
 *   POST /grn/post
 *     Body: {
 *       header: { grn_number, grn_date, plant_id, stock_location_id,
 *                  supplier_id?, supplier_ref?, notes? },
 *       lines: [{ catalog_item_id, batch_code, qty, unit_cost? }, ...]
 *     }
 *     Auth: JWT required (protect middleware).
 *     Authz: req.user.role === 'admin'  OR
 *            req.user.uiPermissions includes 'fab_erp_grn_manage'
 *     Calls: postGrn(companyId, { header, lines })
 *     Returns:
 *       201  { ok: true, grnId, lineCount }
 *       400  { message: '...' }   — validation error
 *       403  { message: '...' }   — permission denied
 *       409  { message: 'GRN number already exists' } — duplicate grn_number
 *       500  { message: '...' }   — unexpected errors
 *
 * Authorization pattern mirrors planning.js / mutateController.js:
 *   const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
 *   if (!isAdmin) check uiPermissions for the required feature tag.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { postGrn } from '../services/grnService.js';

const router = Router();

// ── POST /grn/post ─────────────────────────────────────────────────────────

router.post('/grn/post', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_grn_manage';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);

    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp grn/post: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const { header, lines } = req.body ?? {};

  if (!header || typeof header !== 'object') {
    return res.status(400).json({ message: 'Missing required body field: header.' });
  }

  if (!header.grn_number || typeof header.grn_number !== 'string') {
    return res.status(400).json({ message: 'header.grn_number is required and must be a non-empty string.' });
  }

  if (!header.grn_date) {
    return res.status(400).json({ message: 'header.grn_date is required.' });
  }

  if (header.plant_id === undefined || header.plant_id === null) {
    return res.status(400).json({ message: 'header.plant_id is required.' });
  }

  if (header.stock_location_id === undefined || header.stock_location_id === null) {
    return res.status(400).json({ message: 'header.stock_location_id is required.' });
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ message: 'lines must be a non-empty array.' });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line || typeof line !== 'object') {
      return res.status(400).json({ message: `lines[${i}] is invalid.` });
    }

    if (line.catalog_item_id === undefined || line.catalog_item_id === null) {
      return res.status(400).json({ message: `lines[${i}].catalog_item_id is required.` });
    }

    if (!line.batch_code || typeof line.batch_code !== 'string') {
      return res.status(400).json({ message: `lines[${i}].batch_code is required and must be a non-empty string.` });
    }

    if (typeof line.qty !== 'number' || !(line.qty > 0)) {
      return res.status(400).json({ message: `lines[${i}].qty is required and must be a number greater than 0.` });
    }
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // ── Call service ───────────────────────────────────────────────────────────
  try {
    const result = await postGrn(companyId, { header, lines });

    return res.status(201).json(result);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'GRN number already exists' });
    }

    logger.error({ err, companyId }, 'fab_erp grn/post: unexpected error');
    return res.status(500).json({ message: 'Internal server error during GRN posting.' });
  }
});

export default router;
