import { exportItemsTemplate, importItemsExcel } from '../services/itemsImportService.js';
import { logger } from '../../../core/utils/logger.js';

const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

export const exportItemsTemplateHandler = async (req, res) => {
  try {
    const buffer = await exportItemsTemplate(companyId(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Item_Catalog_Import_Template.xlsx"');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'fab_erp: exportItemsTemplate failed');
    res.status(500).json({ message: 'Failed to generate template', error: err.message });
  }
};

/**
 * `?dryRun=1` (or `mode=dry_run`) parses and validates the whole file,
 * creating any taxonomy it implies so the numbers match a real apply, then
 * rolls everything back — response is `{ problems, wouldInsert, wouldUpdate,
 * wouldSkip }` rather than the normal import summary. `mode=upsert` makes a
 * REAL apply update existing codes instead of skipping them.
 */
export const importItemsHandler = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const rawMode = req.query?.mode ?? req.body?.mode;
    const dryRun = ['1', 'true', 'yes'].includes(String(req.query?.dryRun ?? req.body?.dryRun ?? '').toLowerCase())
      || rawMode === 'dry_run';
    const mode = rawMode === 'upsert' ? 'upsert' : 'append';
    const result = await importItemsExcel(req.file, companyId(req), { dryRun, mode });
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'fab_erp: importItemsExcel failed');
    res.status(400).json({ message: err.message });
  }
};
