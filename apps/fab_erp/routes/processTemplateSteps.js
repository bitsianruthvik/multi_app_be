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
 *
 * OWN COMPANY ONLY (2026-11-24 isolation audit): it had no permission check and updated a step by id alone, so any
 * fab_erp login could rewrite another company's step formulas; the template, sub-template, resource type and process
 * master named were not checked either. Same permission as the generic write of steps (fab_erp_templates_manage).
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { requirePerm } from '../../../core/middleware/requirePerm.js';
import { wouldCreateCycle } from '../services/templateCycles.js';
import { pool } from '../../../db.js';

const router = Router();

/** Is row `id` of `table` this company's (a missing id is nobody's business)? */
async function owns(table, id, companyId) {
  if (id === null || id === undefined || id === '') return true;
  const [rows] = await pool.query(`SELECT 1 FROM \`${table}\` WHERE id = ? AND company_id = ? LIMIT 1`, [id, companyId]);
  return rows.length > 0;
}

router.post('/process-template-steps/save', protect, requirePerm('fab_erp_templates_manage'), async (req, res) => {
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

  const companyId = Number(req.user?.companyId ?? req.user?.company_id) || null;
  if (!companyId) return res.status(403).json({ error: 'A signed-in person of a company is required.' });

  // Validate required fields
  if (!process_template_id) {
    return res.status(400).json({ error: 'process_template_id is required' });
  }

  try {
    // Everything the step names must be this company's: one answer for "another company's" and "not there".
    if (!(await owns('fab_process_templates', process_template_id, companyId))) return res.status(404).json({ error: 'Template not found.' });
    if (!(await owns('fab_resource_types', resource_type_id, companyId))) return res.status(404).json({ error: 'Resource type not found.' });
    if (!(await owns('fab_process_master', process_master_id, companyId))) return res.status(404).json({ error: 'Process not found.' });
    for (const rt of Array.isArray(allowed_resource_type_ids) ? allowed_resource_type_ids : []) {
      if (!(await owns('fab_resource_types', rt, companyId))) return res.status(404).json({ error: 'Resource type not found.' });
    }

    // Sub-template validation
    if (sub_template_id) {
      // 1. Must be approved and current
      const [rows] = await pool.query(
        `SELECT approval_status, is_current_version
           FROM fab_process_templates
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
        [sub_template_id, companyId],
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

    if (id) {
      // UPDATE existing step — this company's only
      const [r] = await pool.query(
        `UPDATE fab_process_template_steps
            SET name                    = ?,
                seq_no                  = ?,
                resource_type_id        = ?,
                process_master_id       = ?,
                allowed_resource_type_ids = ?,
                formula                 = ?,
                standard_values         = ?,
                sub_template_id         = ?,
                updated_at              = UTC_TIMESTAMP()
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
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
          companyId,
        ],
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'Step not found.' });
      return res.json({ ok: true });
    } else {
      // INSERT new step
      const [result] = await pool.query(
        `INSERT INTO fab_process_template_steps
           (company_id, process_template_id, seq_no, name, resource_type_id,
            process_master_id, allowed_resource_type_ids, formula, standard_values,
            sub_template_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
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
