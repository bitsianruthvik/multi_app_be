/**
 * routes/stock.js
 * ----------------
 * EU-5: Stock aggregation route for fab_erp.
 *
 * Mounted by the orchestrator under /api/:companySlug/fab_erp
 * (via routes/index.js — do NOT edit app.js to mount individual routers,
 * that file only wires routes/index.js as a whole).
 *
 * Routes:
 *   GET /stock/summary
 *     Query: {
 *       plantId?          — optional filter, integer
 *       stockLocationId?  — optional filter, integer
 *       catalogItemId?    — optional filter, integer — scope the breakdown to one item
 *       groupBy?          — optional, one of:
 *                             batchNo | heatNo | serialNo | markNo |
 *                             stockLocationId | status | customField:<field_key>
 *     }
 *     Auth: JWT required (protect middleware).
 *     Authz: req.user.role === 'admin'  OR
 *            req.user.uiPermissions includes 'fab_erp_inventory_view'
 *            (admin-bypass pattern mirrors routes/mrp.js / routes/version.js —
 *            routes/items.js's uiPermissions-only check is a known bug and is
 *            NOT replicated here).
 *     Returns:
 *       200  { ok: true, data: { items: [...] } }
 *       400  { message: '...' }   — bad groupBy value
 *       403  { message: '...' }   — permission denied
 *       500  { message: '...' }   — unexpected errors
 *
 * This is a hand-written route bypassing both the generic /query engine
 * (no GROUP BY support) and /mutate (this is a read). Because of that there
 * is no automatic securityInjector — company scoping and parameterization
 * are handled explicitly in every query below.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { pool } from '../../../db.js';

const router = Router();

// groupBy values that map directly onto a fab_stock_pieces column.
const PIECE_COLUMN_GROUP_BYS = {
  batchNo: 'batch_no',
  heatNo: 'heat_no',
  serialNo: 'serial_no',
  markNo: 'mark_no',
  stockLocationId: 'stock_location_id',
  status: 'status',
};

// ── GET /stock/summary ────────────────────────────────────────────────────
router.get('/stock/summary', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_inventory_view';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);
    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp stock/summary: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // ── Parse + validate query params ─────────────────────────────────────
  const { plantId, stockLocationId, groupBy, catalogItemId } = req.query;

  const filters = ['fsp.company_id = ?', 'fsp.deleted_at IS NULL'];
  const params = [companyId];

  if (plantId !== undefined && plantId !== '') {
    const n = Number(plantId);
    if (!Number.isInteger(n)) {
      return res.status(400).json({ message: 'plantId must be an integer.' });
    }
    filters.push('fsp.plant_id = ?');
    params.push(n);
  }

  if (stockLocationId !== undefined && stockLocationId !== '') {
    const n = Number(stockLocationId);
    if (!Number.isInteger(n)) {
      return res.status(400).json({ message: 'stockLocationId must be an integer.' });
    }
    filters.push('fsp.stock_location_id = ?');
    params.push(n);
  }

  if (catalogItemId !== undefined && catalogItemId !== '') {
    const n = Number(catalogItemId);
    if (!Number.isInteger(n)) {
      return res.status(400).json({ message: 'catalogItemId must be an integer.' });
    }
    filters.push('fsp.catalog_item_id = ?');
    params.push(n);
  }

  let customFieldKey = null;
  let pieceColumn = null;

  if (groupBy !== undefined && groupBy !== '') {
    if (typeof groupBy === 'string' && groupBy.startsWith('customField:')) {
      customFieldKey = groupBy.slice('customField:'.length);
      if (!customFieldKey) {
        return res.status(400).json({ message: 'groupBy=customField:<field_key> requires a field_key.' });
      }
    } else if (Object.prototype.hasOwnProperty.call(PIECE_COLUMN_GROUP_BYS, groupBy)) {
      pieceColumn = PIECE_COLUMN_GROUP_BYS[groupBy];
    } else {
      return res.status(400).json({
        message:
          'groupBy must be one of batchNo, heatNo, serialNo, markNo, stockLocationId, status, or customField:<field_key>.',
      });
    }
  }

  const whereClause = filters.join(' AND ');

  try {
    if (!pieceColumn && !customFieldKey) {
      // ── Mode 1: item-level totals only ──────────────────────────────
      const [rows] = await pool.query(
        `SELECT fic.id AS catalog_item_id, fic.name, fic.code, fic.unit, SUM(fsp.qty) AS qty
           FROM fab_stock_pieces fsp
           JOIN fab_item_catalog fic ON fic.id = fsp.catalog_item_id
          WHERE ${whereClause}
          GROUP BY fic.id, fic.name, fic.code, fic.unit
          ORDER BY fic.name`,
        params,
      );

      const items = rows.map((r) => ({
        catalogItemId: r.catalog_item_id,
        name: r.name,
        code: r.code,
        unit: r.unit,
        qty: r.qty,
      }));

      return res.status(200).json({ ok: true, data: { items } });
    }

    // ── Mode 2: item-level totals + per-dimension breakdown ────────────
    let segmentRows;
    if (customFieldKey) {
      const [rows] = await pool.query(
        `SELECT fic.id AS catalog_item_id, fic.name, fic.code, fic.unit,
                cf.field_value AS segment_value, SUM(fsp.qty) AS qty
           FROM fab_stock_pieces fsp
           JOIN fab_item_catalog fic ON fic.id = fsp.catalog_item_id
           LEFT JOIN fab_custom_fields cf
                  ON cf.level = 'stock_piece'
                 AND cf.level_id = fsp.id
                 AND cf.field_key = ?
                 AND cf.deleted_at IS NULL
          WHERE ${whereClause}
          GROUP BY fic.id, fic.name, fic.code, fic.unit, cf.field_value
          ORDER BY fic.name, segment_value`,
        [customFieldKey, ...params],
      );
      segmentRows = rows;
    } else {
      const [rows] = await pool.query(
        `SELECT fic.id AS catalog_item_id, fic.name, fic.code, fic.unit,
                fsp.${pieceColumn} AS segment_value, SUM(fsp.qty) AS qty
           FROM fab_stock_pieces fsp
           JOIN fab_item_catalog fic ON fic.id = fsp.catalog_item_id
          WHERE ${whereClause}
          GROUP BY fic.id, fic.name, fic.code, fic.unit, fsp.${pieceColumn}
          ORDER BY fic.name, segment_value`,
        params,
      );
      segmentRows = rows;
    }

    // Fold the flat rows into { items: [{ ...totals, segments: [...] }] }
    const itemsByCatalogId = new Map();
    for (const r of segmentRows) {
      let item = itemsByCatalogId.get(r.catalog_item_id);
      if (!item) {
        item = {
          catalogItemId: r.catalog_item_id,
          name: r.name,
          code: r.code,
          unit: r.unit,
          qty: 0,
          segments: [],
        };
        itemsByCatalogId.set(r.catalog_item_id, item);
      }
      item.qty += Number(r.qty);
      item.segments.push({ value: r.segment_value, qty: r.qty });
    }

    return res.status(200).json({ ok: true, data: { items: [...itemsByCatalogId.values()] } });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp stock/summary: unexpected error');
    return res.status(500).json({ message: 'Internal server error during stock summary query.' });
  }
});

export default router;
