/**
 * search.js — Global entity search for fab_erp
 *
 * GET /search?q=<term>
 *
 * Runs parallel LIKE queries against 9 entity tables for the requesting company
 * and returns up to 5 hits per type, merged into one flat array with type labels.
 * Minimum query length: 2 characters.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';

const router = Router();
const PER_TYPE = 5;

const TYPE_LABEL = {
  item:           'Item',
  order:          'Order',
  plant:          'Plant',
  supplier:       'Supplier',
  customer:       'Customer',
  bom:            'BOM',
  grn:            'GRN',
  resource_type:  'Resource type',
  stock_location: 'Stock location',
};

router.get('/search', protect, async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ results: [] });

    const companyId = req.user.companyId ?? req.user.company_id;
    const like = `%${q}%`;

    const [items, orders, plants, suppliers, customers, boms, grns, resourceTypes, stockLocs] =
      await Promise.allSettled([
        pool.query(
          `SELECT id, name, code, unit AS detail
           FROM fab_item_catalog
           WHERE company_id=? AND deleted_at IS NULL AND (name LIKE ? OR code LIKE ?)
           LIMIT ?`,
          [companyId, like, like, PER_TYPE],
        ),
        pool.query(
          `SELECT id, order_number AS name, order_type AS code, status AS detail
           FROM fab_orders
           WHERE company_id=? AND deleted_at IS NULL AND order_number LIKE ?
           LIMIT ?`,
          [companyId, like, PER_TYPE],
        ),
        pool.query(
          `SELECT id, name, code, '' AS detail
           FROM fab_plants
           WHERE company_id=? AND deleted_at IS NULL AND (name LIKE ? OR code LIKE ?)
           LIMIT ?`,
          [companyId, like, like, PER_TYPE],
        ),
        pool.query(
          `SELECT id, name, code, contact_name AS detail
           FROM fab_suppliers
           WHERE company_id=? AND deleted_at IS NULL AND (name LIKE ? OR code LIKE ?)
           LIMIT ?`,
          [companyId, like, like, PER_TYPE],
        ),
        pool.query(
          `SELECT id, name, code, contact_name AS detail
           FROM fab_customers
           WHERE company_id=? AND deleted_at IS NULL AND (name LIKE ? OR code LIKE ?)
           LIMIT ?`,
          [companyId, like, like, PER_TYPE],
        ),
        pool.query(
          `SELECT id, name, '' AS code, description AS detail
           FROM fab_material_boms
           WHERE company_id=? AND deleted_at IS NULL AND name LIKE ?
           LIMIT ?`,
          [companyId, like, PER_TYPE],
        ),
        pool.query(
          `SELECT id, grn_number AS name, status AS code, supplier_ref AS detail
           FROM fab_grns
           WHERE company_id=? AND deleted_at IS NULL AND grn_number LIKE ?
           LIMIT ?`,
          [companyId, like, PER_TYPE],
        ),
        pool.query(
          `SELECT id, name, code, category AS detail
           FROM fab_resource_types
           WHERE company_id=? AND deleted_at IS NULL AND (name LIKE ? OR code LIKE ?)
           LIMIT ?`,
          [companyId, like, like, PER_TYPE],
        ),
        pool.query(
          `SELECT id, name, code, description AS detail
           FROM fab_stock_locations
           WHERE company_id=? AND deleted_at IS NULL AND (name LIKE ? OR code LIKE ?)
           LIMIT ?`,
          [companyId, like, like, PER_TYPE],
        ),
      ]);

    function extract(settled, type) {
      if (settled.status !== 'fulfilled') return [];
      return (settled.value[0] ?? []).map((row) => ({
        ...row,
        type,
        typeLabel: TYPE_LABEL[type],
      }));
    }

    const results = [
      ...extract(items,         'item'),
      ...extract(orders,        'order'),
      ...extract(plants,        'plant'),
      ...extract(suppliers,     'supplier'),
      ...extract(customers,     'customer'),
      ...extract(boms,          'bom'),
      ...extract(grns,          'grn'),
      ...extract(resourceTypes, 'resource_type'),
      ...extract(stockLocs,     'stock_location'),
    ];

    res.json({ results });
  } catch (err) {
    res.status(500).json({ message: err.message ?? 'Search failed' });
  }
});

export default router;
