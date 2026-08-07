import { exportOrderItemsTemplate, importOrderItemsExcel } from '../services/orderItemsImportService.js';
import { recomputeOrderWeights } from '../services/itemWeightService.js';
import { generateOrderItemCodes, customerAbbrev } from '../services/itemCodeService.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

/** 404s unless the order exists in the caller's company. */
async function assertOrder(cid, orderId) {
  const [rows] = await pool.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, cid],
  );
  if (!rows.length) { const e = new Error('Order not found'); e.status = 404; throw e; }
}

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
    // 'replace' clears the order's existing tree first. Anything other than the
    // literal string is treated as 'append' — a destructive default reached by
    // a typo is not a tradeoff worth making.
    const mode = req.body?.mode === 'replace' ? 'replace' : 'append';
    const result = await importOrderItemsExcel(req.file, companyId(req), req.params.orderId, mode);
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'fab_erp: importOrderItemsExcel failed');
    const status = err.message === 'Order not found' ? 404 : 400;
    res.status(status).json({ message: err.message });
  }
};

export const recomputeOrderWeightsHandler = async (req, res) => {
  try {
    const cid = companyId(req);
    const orderId = Number(req.params.orderId);
    await assertOrder(cid, orderId);
    res.json(await recomputeOrderWeights(cid, orderId));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ message: err.message });
    logger.error({ err }, 'fab_erp: recomputeOrderWeights failed');
    res.status(500).json({ message: 'Failed to recompute weights', error: err.message });
  }
};

export const generateOrderItemCodesHandler = async (req, res) => {
  try {
    const cid = companyId(req);
    const orderId = Number(req.params.orderId);
    await assertOrder(cid, orderId);
    res.json(await generateOrderItemCodes(cid, orderId));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ message: err.message });
    logger.error({ err }, 'fab_erp: generateOrderItemCodes failed');
    res.status(500).json({ message: 'Failed to generate codes', error: err.message });
  }
};

/**
 * Read-only totals for the Items/BOM header strip. Deliberately not the
 * recompute route: rendering a page must not write to the database, and the
 * stored total_weight is already current — every path that changes a weight
 * recomputes before returning.
 */
export const orderWeightSummaryHandler = async (req, res) => {
  try {
    const cid = companyId(req);
    const orderId = Number(req.params.orderId);
    await assertOrder(cid, orderId);

    // Total sums the ROOTS only. Summing every row would count each piece once
    // per level it hangs under.
    const [[totals]] = await pool.query(
      `SELECT SUM(total_weight) AS total, COUNT(total_weight) AS weighedRoots, COUNT(*) AS roots
         FROM fab_items
        WHERE company_id = ? AND order_id = ? AND parent_item_id IS NULL AND deleted_at IS NULL`,
      [cid, orderId],
    );
    // A leaf with no weight is what makes a total incomplete — an assembly
    // without one simply has not been rolled up yet.
    const [[gaps]] = await pool.query(
      `SELECT COUNT(*) AS unweighedLeaves FROM fab_items p
        WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL
          AND p.unit_weight IS NULL AND p.computed_unit_weight IS NULL
          AND NOT EXISTS (SELECT 1 FROM fab_items c
                           WHERE c.parent_item_id = p.id AND c.deleted_at IS NULL)`,
      [cid, orderId],
    );
    const [[counts]] = await pool.query(
      `SELECT COUNT(*) AS itemCount, SUM(code IS NULL) AS uncoded
         FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
      [cid, orderId],
    );

    // Every code in one order opens with the same customer + order number, so
    // the tree shows only the part that differs and this prefix is stated once.
    const [[ord]] = await pool.query(
      `SELECT o.order_number, o.customer_name, c.name AS customer_master_name
         FROM fab_orders o
         LEFT JOIN fab_customers c ON c.id = o.customer_id AND c.deleted_at IS NULL
        WHERE o.id = ? AND o.company_id = ?`,
      [orderId, cid],
    );
    const codePrefix = ord
      ? `${customerAbbrev(ord.customer_master_name || ord.customer_name)}-${String(ord.order_number ?? '').toUpperCase().replace(/[^A-Z0-9-]+/g, '')}`
      : null;

    res.json({
      totalWeight: totals.weighedRoots > 0 ? Number(totals.total) : null,
      itemCount: Number(counts.itemCount),
      unweighedLeaves: Number(gaps.unweighedLeaves),
      uncodedItems: Number(counts.uncoded ?? 0),
      codePrefix,
    });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ message: err.message });
    logger.error({ err }, 'fab_erp: orderWeightSummary failed');
    res.status(500).json({ message: 'Failed to read weight summary', error: err.message });
  }
};
