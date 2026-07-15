import fs from 'fs';
import { pool } from '../../../db.js';
import { exportFlowStepsTemplate, importFlowStepsExcel } from '../services/flowStepsImportService.js';
import { logger } from '../../../core/utils/logger.js';

const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

async function assertFlowOwnership(flowId, companyId) {
  const [rows] = await pool.query(
    'SELECT id FROM fab_operation_flows WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [flowId, companyId],
  );
  return rows.length > 0;
}

export const exportFlowStepsTemplateHandler = async (req, res) => {
  try {
    const flowId = Number(req.params.flowId);
    if (!Number.isFinite(flowId) || !(await assertFlowOwnership(flowId, companyId(req)))) {
      return res.status(404).json({ message: 'Flow not found' });
    }
    const buffer = await exportFlowStepsTemplate(flowId, companyId(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Flow_Steps_Template.xlsx"');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'fab_erp: exportFlowStepsTemplate failed');
    res.status(500).json({ message: 'Failed to generate template', error: err.message });
  }
};

export const importFlowStepsHandler = async (req, res) => {
  try {
    const flowId = Number(req.params.flowId);
    if (!Number.isFinite(flowId) || !(await assertFlowOwnership(flowId, companyId(req)))) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ message: 'Flow not found' });
    }
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const result = await importFlowStepsExcel(req.file, flowId, companyId(req));
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'fab_erp: importFlowStepsExcel failed');
    res.status(400).json({ message: err.message });
  }
};
