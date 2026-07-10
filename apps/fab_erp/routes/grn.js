/**
 * routes/grn.js
 * -------------
 * EU-3: Goods Receipt Note (GRN) posting routes for fab_erp.
 *
 * Mounted by the orchestrator under /api/:companySlug/fab_erp
 * (do NOT edit routes/index.js or app.js).
 *
 * Routes:
 *   POST /grn/post
 *     Body: {
 *       header: { grn_number, grn_date, plant_id, stock_location_id,
 *                  supplier_id?, supplier_ref?, notes? },
 *       lines: [{
 *         catalog_item_id, unit_cost?,
 *         pieces: [{ qty, batch_no?, heat_no?, serial_no?, mark_no?,
 *                    custom_fields?: [{ field_key, field_type?, field_value? }, ...] }, ...]
 *       }, ...]
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
 *
 * Traceability: per the stock-piece redesign (PLAN.md EU-1/EU-3), batch_no /
 * heat_no / serial_no / mark_no are free-text per-piece attributes with no
 * mandatory/required flag anymore (fab_item_categories.*_required and
 * fab_item_catalog.*_required_override were dropped in EU-1). There is no
 * pre-post traceability validation here — every item is processed uniformly;
 * only structural/shape validation (qty > 0, required ids present, and — if
 * present — a well-formed custom_fields array per piece) happens before
 * postGrn() runs.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { postGrn } from '../services/grnService.js';

const router = Router();

const PIECE_ATTR_FIELDS = ['batch_no', 'heat_no', 'serial_no', 'mark_no'];

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

    if (
      line.unit_cost !== undefined &&
      line.unit_cost !== null &&
      typeof line.unit_cost !== 'number'
    ) {
      return res.status(400).json({ message: `lines[${i}].unit_cost must be a number.` });
    }

    if (!Array.isArray(line.pieces) || line.pieces.length === 0) {
      return res.status(400).json({ message: `lines[${i}].pieces must be a non-empty array.` });
    }

    for (let j = 0; j < line.pieces.length; j++) {
      const piece = line.pieces[j];

      if (!piece || typeof piece !== 'object') {
        return res.status(400).json({ message: `lines[${i}].pieces[${j}] is invalid.` });
      }

      if (typeof piece.qty !== 'number' || !(piece.qty > 0)) {
        return res.status(400).json({
          message: `lines[${i}].pieces[${j}].qty is required and must be a number greater than 0.`,
        });
      }

      for (const f of PIECE_ATTR_FIELDS) {
        if (piece[f] !== undefined && piece[f] !== null && typeof piece[f] !== 'string') {
          return res.status(400).json({ message: `lines[${i}].pieces[${j}].${f} must be a string.` });
        }
      }

      if (piece.custom_fields !== undefined && piece.custom_fields !== null) {
        if (!Array.isArray(piece.custom_fields)) {
          return res.status(400).json({
            message: `lines[${i}].pieces[${j}].custom_fields must be an array.`,
          });
        }

        for (let k = 0; k < piece.custom_fields.length; k++) {
          const cf = piece.custom_fields[k];

          if (!cf || typeof cf !== 'object') {
            return res.status(400).json({
              message: `lines[${i}].pieces[${j}].custom_fields[${k}] is invalid.`,
            });
          }

          if (typeof cf.field_key !== 'string' || cf.field_key.trim() === '') {
            return res.status(400).json({
              message: `lines[${i}].pieces[${j}].custom_fields[${k}].field_key is required and must be a non-empty string.`,
            });
          }

          if (
            cf.field_type !== undefined &&
            cf.field_type !== null &&
            typeof cf.field_type !== 'string'
          ) {
            return res.status(400).json({
              message: `lines[${i}].pieces[${j}].custom_fields[${k}].field_type must be a string.`,
            });
          }

          if (
            cf.field_value !== undefined &&
            cf.field_value !== null &&
            typeof cf.field_value !== 'string' &&
            typeof cf.field_value !== 'number' &&
            typeof cf.field_value !== 'boolean'
          ) {
            return res.status(400).json({
              message: `lines[${i}].pieces[${j}].custom_fields[${k}].field_value must be a string, number, or boolean.`,
            });
          }
        }
      }
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
