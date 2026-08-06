import { exportWorkersTemplate, importWorkersExcel } from '../services/workersImportService.js';
import { logger } from '../../../core/utils/logger.js';

const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

export const exportWorkersTemplateHandler = async (req, res) => {
  try {
    const buffer = await exportWorkersTemplate(companyId(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="People_Import_Template.xlsx"');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'fab_erp: exportWorkersTemplate failed');
    res.status(500).json({ message: 'Failed to generate template', error: err.message });
  }
};

export const importWorkersHandler = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const result = await importWorkersExcel(req.file, companyId(req), req.user?.id ?? null);
    // A file that failed validation is a 200 with ok:false, not a 4xx: the
    // caller needs the per-row error list to render, and an error status would
    // send it down the generic "request failed" path where that list is lost.
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'fab_erp: importWorkersExcel failed');
    res.status(400).json({ message: err.message });
  }
};
