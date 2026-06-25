import { createReadStream } from 'fs';
import { approvePlan, revisePlan, getPlanReadiness } from '../services/planService.js';
import { parseExcel, importBatch } from '../services/excelImportService.js';
import { exportPlan } from '../services/excelExportService.js';
import { getNodeDetail, uploadNodeDiagram, getNodeDiagramPath } from '../services/nodeDiagramService.js';
import { logger } from '../../../core/utils/logger.js';

const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

export const approvePlanHandler = async (req, res) => {
  try {
    const result = await approvePlan(Number(req.params.planId), req.user.id, companyId(req));
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, 'fab_flow: approvePlan failed');
    res.status(400).json({ success: false, error: err.message });
  }
};

export const revisePlanHandler = async (req, res) => {
  try {
    const result = await revisePlan(Number(req.params.planId), req.user.id, companyId(req));
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, 'fab_flow: revisePlan failed');
    res.status(400).json({ success: false, error: err.message });
  }
};

export const uploadExcelHandler = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const result = await parseExcel(req.file, Number(req.params.planId), req.user.id, companyId(req));
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, 'fab_flow: parseExcel failed');
    res.status(400).json({ success: false, error: err.message });
  }
};

export const importExcelBatch = async (req, res) => {
  try {
    const result = await importBatch(Number(req.params.batchId), req.user.id, companyId(req));
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, 'fab_flow: importBatch failed');
    res.status(400).json({ success: false, error: err.message });
  }
};

export const exportPlanHandler = async (req, res) => {
  try {
    const buffer = await exportPlan(Number(req.params.planId), companyId(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="FabFlow_Plan_${req.params.planId}_export.xlsx"`);
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'fab_flow: exportPlan failed');
    res.status(500).json({ success: false, error: err.message });
  }
};

export const planReadinessHandler = async (req, res) => {
  try {
    const result = await getPlanReadiness(Number(req.params.planId), companyId(req));
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, 'fab_flow: getPlanReadiness failed');
    res.status(400).json({ success: false, error: err.message });
  }
};

export const getNodeDetailHandler = async (req, res) => {
  try {
    const result = await getNodeDetail(Number(req.params.nodeId), companyId(req));
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, 'fab_flow: getNodeDetail failed');
    res.status(404).json({ success: false, error: err.message });
  }
};

export const uploadNodeDiagramHandler = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ success: false, error: 'Only PDF files are accepted' });
    }
    const result = await uploadNodeDiagram(Number(req.params.nodeId), companyId(req), req.file);
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, 'fab_flow: uploadNodeDiagram failed');
    res.status(400).json({ success: false, error: err.message });
  }
};

export const downloadNodeDiagramHandler = async (req, res) => {
  try {
    const { filePath, fileName, mimeType } = await getNodeDiagramPath(Number(req.params.nodeId), companyId(req));
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    createReadStream(filePath).pipe(res);
  } catch (err) {
    logger.error({ err }, 'fab_flow: downloadNodeDiagram failed');
    res.status(404).json({ success: false, error: err.message });
  }
};
