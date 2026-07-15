import { exportOrderItemsTemplate, importOrderItemsExcel } from '../services/orderItemsImportService.js';
import { logger } from '../../../core/utils/logger.js';

const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

export const exportOrderItemsTemplateHandler = async (req, res) => {
  try {
    const buffer = await exportOrderItemsTemplate(companyId(req), req.params.orderId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Order_Items_Import_Template.xlsx"');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'fab_erp: exportOrderItemsTemplate failed');
    const status = err.message === 'Order not found' ? 404 : 500;
    res.status(status).json({ message: 'Failed to generate template', error: err.message });
  }
};

export const importOrderItemsHandler = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const result = await importOrderItemsExcel(req.file, companyId(req), req.params.orderId);
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'fab_erp: importOrderItemsExcel failed');
    const status = err.message === 'Order not found' ? 404 : 400;
    res.status(status).json({ message: err.message });
  }
};
