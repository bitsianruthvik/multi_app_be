import { exportResourcesTemplate, importResourcesExcel } from '../services/resourcesImportService.js';
import { logger } from '../../../core/utils/logger.js';

const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

export const exportResourcesTemplateHandler = async (req, res) => {
  try {
    const buffer = await exportResourcesTemplate(companyId(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Resource_Catalog_Import_Template.xlsx"');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'fab_erp: exportResourcesTemplate failed');
    res.status(500).json({ message: 'Failed to generate template', error: err.message });
  }
};

export const importResourcesHandler = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const result = await importResourcesExcel(req.file, companyId(req));
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'fab_erp: importResourcesExcel failed');
    res.status(400).json({ message: err.message });
  }
};
