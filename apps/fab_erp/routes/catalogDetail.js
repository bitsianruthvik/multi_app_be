/**
 * catalogDetail.js — what the item page asks about ONE catalog item, and the
 * per-node counts the taxonomy tree shows.
 *
 * NEW FILE rather than more routes in `routes/catalog.js`, which is being
 * edited concurrently by other work. Same prefix, same mounting pattern as
 * the planner/procurement/actuals/catalog routers in `app.js`.
 *
 * All read-only, so `protect` alone — no manage permission.
 *
 *   GET /catalog/items/:id/where-used   BOM rows that use it + orders whose structure references it
 *   GET /catalog/items/:id/stock        on hand / reserved / available + the pieces themselves
 *   GET /catalog/items/:id/purchases    last 10 purchase-order lines for it
 *   GET /taxonomy/counts                catalog items per category / group / sub-group
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { fail } from '../../../core/middleware/requirePerm.js';
import { pool } from '../../../db.js';
import { availabilityFor } from '../services/availabilityService.js';

const router = Router();
const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

/** Both lists are capped; the total says how much the cap hid. */
const WHERE_USED_CAP = 50;
const PURCHASES_CAP = 10;

function itemId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: 'Invalid item id.' });
    return null;
  }
  return id;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /catalog/items/:id/where-used
// ─────────────────────────────────────────────────────────────────────────

router.get('/catalog/items/:id/where-used', protect, async (req, res) => {
  const cid = companyId(req);
  const id = itemId(req, res);
  if (id == null) return;
  try {
    const [[bomRows], [[bomTotal]], [orderRows], [[orderTotal]]] = await Promise.all([
      // The BOM rows this item is a CHILD of — "what is it a part of".
      pool.query(
        `SELECT b.id AS bomId, b.parent_item_id AS parentItemId,
                p.name AS parentName, p.code AS parentCode,
                b.qty_num AS qtyNum, b.qty_param AS qtyParam, b.default_qty AS defaultQty,
                b.per_instance_qty AS perInstanceQty
           FROM fab_item_bom b
           JOIN fab_item_catalog p ON p.id = b.parent_item_id AND p.deleted_at IS NULL
          WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.child_item_id = ?
          ORDER BY p.name ASC, b.sort_order ASC
          LIMIT ?`,
        [cid, id, WHERE_USED_CAP],
      ),
      pool.query(
        `SELECT COUNT(*) AS n
           FROM fab_item_bom b
           JOIN fab_item_catalog p ON p.id = b.parent_item_id AND p.deleted_at IS NULL
          WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.child_item_id = ?`,
        [cid, id],
      ),
      // Orders whose deployed structure (fab_items) names this catalog item.
      pool.query(
        `SELECT o.id AS orderId, o.order_number AS orderNumber, o.order_type AS orderType,
                o.status, o.customer_name AS customerName,
                COUNT(*) AS rowCount, COALESCE(SUM(i.qty), 0) AS totalQty
           FROM fab_items i
           JOIN fab_orders o ON o.id = i.order_id AND o.deleted_at IS NULL
          WHERE i.company_id = ? AND i.deleted_at IS NULL AND i.catalog_item_id = ?
          GROUP BY o.id, o.order_number, o.order_type, o.status, o.customer_name
          ORDER BY o.created_at DESC
          LIMIT ?`,
        [cid, id, WHERE_USED_CAP],
      ),
      pool.query(
        `SELECT COUNT(DISTINCT i.order_id) AS n
           FROM fab_items i
           JOIN fab_orders o ON o.id = i.order_id AND o.deleted_at IS NULL
          WHERE i.company_id = ? AND i.deleted_at IS NULL AND i.catalog_item_id = ?`,
        [cid, id],
      ),
    ]);

    res.json({
      boms: bomRows.map((r) => ({
        ...r,
        qtyNum: r.qtyNum == null ? null : Number(r.qtyNum),
        defaultQty: r.defaultQty == null ? null : Number(r.defaultQty),
        perInstanceQty: Number(r.perInstanceQty) === 1,
      })),
      bomTotal: Number(bomTotal?.n ?? 0),
      orders: orderRows.map((r) => ({
        ...r,
        rowCount: Number(r.rowCount),
        totalQty: Number(r.totalQty),
      })),
      orderTotal: Number(orderTotal?.n ?? 0),
      cap: WHERE_USED_CAP,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /catalog/items/:id/stock
// ─────────────────────────────────────────────────────────────────────────

router.get('/catalog/items/:id/stock', protect, async (req, res) => {
  const cid = companyId(req);
  const id = itemId(req, res);
  if (id == null) return;
  try {
    // The headline numbers come from the SAME helper the Buy step uses, so
    // this page and the production step never disagree about what is free.
    // (It ignores offcuts and anything not 'in_stock' — see its header.)
    const [avail, [pieces]] = await Promise.all([
      availabilityFor(cid, [id]),
      pool.query(
        `SELECT sp.id, sp.code, sp.qty, sp.uom, sp.status,
                sp.batch_no AS batchNo, sp.heat_no AS heatNo, sp.serial_no AS serialNo,
                sp.received_date AS receivedDate, sp.length_mm AS lengthMm, sp.width_mm AS widthMm,
                sp.origin_piece_id AS originPieceId, sp.source,
                pl.name AS plantName, sl.name AS locationName, sl.code AS locationCode
           FROM fab_stock_pieces sp
           LEFT JOIN fab_plants pl ON pl.id = sp.plant_id
           LEFT JOIN fab_stock_locations sl ON sl.id = sp.stock_location_id
          WHERE sp.company_id = ? AND sp.deleted_at IS NULL
            AND sp.catalog_item_id = ?
            AND sp.status = 'in_stock' AND sp.qty > 0
          ORDER BY sp.received_date DESC, sp.id DESC
          LIMIT 200`,
        [cid, id],
      ),
    ]);
    const a = avail.get(id) ?? { onHand: 0, reserved: 0, available: 0 };
    res.json({
      onHand: Number(a.onHand),
      reserved: Number(a.reserved),
      available: Number(a.available),
      pieces: pieces.map((p) => ({
        ...p,
        qty: Number(p.qty),
        lengthMm: p.lengthMm == null ? null : Number(p.lengthMm),
        widthMm: p.widthMm == null ? null : Number(p.widthMm),
        isOffcut: p.originPieceId != null,
      })),
      pieceCount: pieces.length,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /catalog/items/:id/purchases
// ─────────────────────────────────────────────────────────────────────────

router.get('/catalog/items/:id/purchases', protect, async (req, res) => {
  const cid = companyId(req);
  const id = itemId(req, res);
  if (id == null) return;
  try {
    const [rows] = await pool.query(
      `SELECT o.id AS orderId, o.order_number AS orderNumber, o.status,
              o.supplier_id AS supplierId, s.name AS supplierName,
              l.id AS lineId, l.qty, l.qty_received AS qtyReceived, l.unit,
              l.unit_price AS unitPrice, l.expected_date AS expectedDate,
              o.created_at AS orderedAt
         FROM fab_order_lines l
         JOIN fab_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
                          AND o.order_type = 'purchase' AND o.company_id = l.company_id
         LEFT JOIN fab_suppliers s ON s.id = o.supplier_id
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.catalog_item_id = ?
        ORDER BY o.created_at DESC, l.id DESC
        LIMIT ?`,
      [cid, id, PURCHASES_CAP],
    );
    res.json({
      lines: rows.map((r) => ({
        ...r,
        qty: Number(r.qty),
        qtyReceived: Number(r.qtyReceived ?? 0),
        unitPrice: r.unitPrice == null ? null : Number(r.unitPrice),
      })),
      cap: PURCHASES_CAP,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /taxonomy/counts — items per node, for the tree
// ─────────────────────────────────────────────────────────────────────────

router.get('/taxonomy/counts', protect, async (req, res) => {
  const cid = companyId(req);
  try {
    const [[cats], [grps], [subs]] = await Promise.all([
      pool.query(
        `SELECT category_id AS id, COUNT(*) AS n FROM fab_item_catalog
          WHERE company_id = ? AND deleted_at IS NULL AND category_id IS NOT NULL GROUP BY category_id`,
        [cid],
      ),
      pool.query(
        `SELECT group_id AS id, COUNT(*) AS n FROM fab_item_catalog
          WHERE company_id = ? AND deleted_at IS NULL AND group_id IS NOT NULL GROUP BY group_id`,
        [cid],
      ),
      pool.query(
        `SELECT subgroup_id AS id, COUNT(*) AS n FROM fab_item_catalog
          WHERE company_id = ? AND deleted_at IS NULL AND subgroup_id IS NOT NULL GROUP BY subgroup_id`,
        [cid],
      ),
    ]);
    const toMap = (rows) => Object.fromEntries(rows.map((r) => [String(r.id), Number(r.n)]));
    res.json({ categories: toMap(cats), groups: toMap(grps), subgroups: toMap(subs) });
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
