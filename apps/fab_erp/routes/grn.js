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
 *       lines: [{ catalog_item_id, batch_no?, serial_no?, heat_no?, mark_no?, qty, unit_cost? }, ...]
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
 * Traceability: which of batch_no/serial_no/heat_no/mark_no are mandatory
 * comes from the item's Category (batch_required/serial_required/...),
 * overridable per item (batch_required_override/...; NULL = inherit). This
 * is enforced here, before postGrn() runs, so a bad request never reaches
 * the DB transaction.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { postGrn } from '../services/grnService.js';
import { pool } from '../../../db.js';

const router = Router();

const TRACE_FIELDS = [
  { key: 'batch_no',  overrideCol: 'batch_required_override',  categoryCol: 'batch_required',  label: 'batch number' },
  { key: 'serial_no', overrideCol: 'serial_required_override', categoryCol: 'serial_required', label: 'serial number' },
  { key: 'heat_no',   overrideCol: 'heat_required_override',   categoryCol: 'heat_required',   label: 'heat number' },
  { key: 'mark_no',   overrideCol: 'mark_required_override',   categoryCol: 'mark_required',    label: 'mark number' },
];

/**
 * Fetch each item's effective traceability requirements (item override, else
 * category default) as a Map<catalogItemId, { batch_no: bool, serial_no: bool, ... }>.
 */
async function getEffectiveTraceability(companyId, catalogItemIds) {
  if (catalogItemIds.length === 0) return new Map();

  const [rows] = await pool.query(
    `SELECT fic.id,
            fic.batch_required_override, fic.serial_required_override,
            fic.heat_required_override, fic.mark_required_override,
            cat.batch_required, cat.serial_required, cat.heat_required, cat.mark_required
       FROM fab_item_catalog fic
       LEFT JOIN fab_item_categories cat ON cat.id = fic.category_id
      WHERE fic.company_id = ? AND fic.id IN (?) AND fic.deleted_at IS NULL`,
    [companyId, catalogItemIds],
  );

  const map = new Map();
  for (const row of rows) {
    map.set(row.id, {
      batch_no:  (row.batch_required_override  ?? row.batch_required  ?? 0) === 1,
      serial_no: (row.serial_required_override ?? row.serial_required ?? 0) === 1,
      heat_no:   (row.heat_required_override   ?? row.heat_required   ?? 0) === 1,
      mark_no:   (row.mark_required_override   ?? row.mark_required   ?? 0) === 1,
    });
  }
  return map;
}

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

    for (const f of TRACE_FIELDS) {
      if (line[f.key] !== undefined && line[f.key] !== null && typeof line[f.key] !== 'string') {
        return res.status(400).json({ message: `lines[${i}].${f.key} must be a string.` });
      }
    }

    if (typeof line.qty !== 'number' || !(line.qty > 0)) {
      return res.status(400).json({ message: `lines[${i}].qty is required and must be a number greater than 0.` });
    }
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // ── Traceability validation — only the fields each item requires ──────────
  try {
    const itemIds = [...new Set(lines.map((l) => l.catalog_item_id))];
    const effective = await getEffectiveTraceability(companyId, itemIds);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const reqs = effective.get(line.catalog_item_id);
      if (!reqs) {
        return res.status(400).json({ message: `lines[${i}].catalog_item_id does not exist.` });
      }
      for (const f of TRACE_FIELDS) {
        if (reqs[f.key] && !(line[f.key] && String(line[f.key]).trim())) {
          return res.status(400).json({ message: `lines[${i}]: this item requires a ${f.label}.` });
        }
      }
    }
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp grn/post: traceability validation error');
    return res.status(500).json({ message: 'Internal server error during traceability validation.' });
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
