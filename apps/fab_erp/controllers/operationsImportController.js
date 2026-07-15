import { exportOperationsTemplate, importOperationsExcel } from '../services/operationsImportService.js';
import { logger } from '../../../core/utils/logger.js';

const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

export const exportOperationsTemplateHandler = async (req, res) => {
  try {
    const buffer = await exportOperationsTemplate(companyId(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Operations_Import_Template.xlsx"');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'fab_erp: exportOperationsTemplate failed');
    res.status(500).json({ message: 'Failed to generate template', error: err.message });
  }
};

export const importOperationsHandler = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const result = await importOperationsExcel(req.file, companyId(req));
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'fab_erp: importOperationsExcel failed');
    res.status(400).json({ message: err.message });
  }
};
