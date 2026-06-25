/**
 * routes/processTemplateSteps.js
 * --------------------------------
 * Custom step save endpoint with cycle detection and approval gating.
 *
 * Route:
 *   POST /process-template-steps/save
 *     Body: { id?, process_template_id, sub_template_id?, name, seq_no,
 *             process_master_id?, allowed_resource_type_ids?, formula?,
 *             standard_values?, resource_type_id? }
 *     Returns: { ok: true, id?: number }
 *
 * Called from the frontend instead of fabMutate when sub_template_id is set.
 * For steps without sub_template_id, fabMutate still works fine.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { wouldCreateCycle } from '../services/templateCycles.js';
import { pool } from '../../../db.js';

const router = Router();

router.post('/process-template-steps/save', protect, async (req, res) => {
  const {
    id,
    process_template_id,
    sub_template_id,
    name,
    seq_no,
    process_master_id,
    allowed_resource_type_ids,
    formula,
    standard_values,
    resource_type_id,
  } = req.body;

  // Validate required fields
  if (!process_template_id) {
    return res.status(400).json({ error: 'process_template_id is required' });
  }

  // Sub-template validation
  if (sub_template_id) {
    // 1. Must be approved and current
    const [rows] = await pool.query(
      `SELECT approval_status, is_current_version
         FROM fab_process_templates
        WHERE id = ? AND deleted_at IS NULL`,
      [sub_template_id],
    );
    if (!rows[0]) {
      return res.status(422).json({ error: 'Sub-template not found.' });
    }
    if (rows[0].approval_status !== 'approved' || !rows[0].is_current_version) {
      return res.status(422).json({
        error: 'Sub-template must be approved and the current version.',
      });
    }

    // 2. Cycle detection
    const cycle = await wouldCreateCycle(Number(process_template_id), Number(sub_template_id));
    if (cycle) {
      return res.status(422).json({
        error: 'Circular template embedding detected. This would create an infinite loop.',
      });
    }
  }

  try {
    if (id) {
      // UPDATE existing step
      await pool.query(
        `UPDATE fab_process_template_steps
            SET name                    = ?,
                seq_no                  = ?,
                resource_type_id        = ?,
                process_master_id       = ?,
                allowed_resource_type_ids = ?,
                formula                 = ?,
                standard_values         = ?,
                sub_template_id         = ?,
                updated_at              = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [
          name ?? null,
          seq_no ?? null,
          resource_type_id ?? null,
          process_master_id ?? null,
          allowed_resource_type_ids ? JSON.stringify(allowed_resource_type_ids) : null,
          formula ?? null,
          standard_values ? JSON.stringify(standard_values) : null,
          sub_template_id ?? null,
          id,
        ],
      );
      return res.json({ ok: true });
    } else {
      // INSERT new step
      const companyId = req.user?.companyId ?? req.user?.company_id;
      const [result] = await pool.query(
        `INSERT INTO fab_process_template_steps
           (company_id, process_template_id, seq_no, name, resource_type_id,
            process_master_id, allowed_resource_type_ids, formula, standard_values,
            sub_template_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          companyId,
          process_template_id,
          seq_no ?? null,
          name ?? null,
          resource_type_id ?? null,
          process_master_id ?? null,
          allowed_resource_type_ids ? JSON.stringify(allowed_resource_type_ids) : null,
          formula ?? null,
          standard_values ? JSON.stringify(standard_values) : null,
          sub_template_id ?? null,
        ],
      );
      return res.json({ ok: true, id: result.insertId });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message ?? 'Internal server error' });
  }
});

export default router;
