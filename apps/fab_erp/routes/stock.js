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
 *                             batchNo | heatNo | piece
 *     }
 *
 *     groupBy=piece returns one segment row per individual fab_stock_pieces
 *     row (not aggregated), with every stock-piece-level custom field
 *     (fab_custom_fields, level='stock_piece') attached as a customFields
 *     array — this is what the Item Batches UI uses for its "Stock Piece"
 *     segment-by option so users can see Width/Length/etc. per physical piece.
 *     Auth: JWT required (protect middleware).
 *     Authz: req.user.role === 'admin'  OR
 *            req.user.uiPermissions includes 'fab_erp_inventory_view'
 *            (admin-bypass pattern mirrors routes/version.js —
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
//
// `stockLocationId` was missing here while Plants.tsx's Stock Levels tab had
// always requested it (its own comment claimed the value was supported), so
// that tab 400'd on every load and permanently showed "No stock data for the
// selected filters". Adding it is purely additive — the column exists on
// fab_stock_pieces and the grouping logic is column-agnostic.
const PIECE_COLUMN_GROUP_BYS = {
  batchNo: 'batch_no',
  heatNo: 'heat_no',
  stockLocationId: 'stock_location_id',
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

  let pieceColumn = null;
  let byPiece = false;

  if (groupBy !== undefined && groupBy !== '') {
    if (groupBy === 'piece') {
      byPiece = true;
    } else if (Object.prototype.hasOwnProperty.call(PIECE_COLUMN_GROUP_BYS, groupBy)) {
      pieceColumn = PIECE_COLUMN_GROUP_BYS[groupBy];
    } else {
      // Build the list from the map so this message can't drift out of sync
      // with what is actually accepted — which is how the missing
      // stockLocationId value went unnoticed.
      return res.status(400).json({
        message: `groupBy must be one of ${Object.keys(PIECE_COLUMN_GROUP_BYS).join(', ')}, or piece.`,
      });
    }
  }

  const whereClause = filters.join(' AND ');

  try {
    if (!pieceColumn && !byPiece) {
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

    if (byPiece) {
      // ── Mode 3: individual stock pieces, each with its custom fields ──
      const [pieceRows] = await pool.query(
        `SELECT fsp.id, fsp.batch_no, fsp.heat_no, fsp.serial_no, fsp.mark_no,
                fsp.qty, fsp.uom, fsp.status, fsp.stock_location_id, fsp.received_date,
                fic.id AS catalog_item_id, fic.name, fic.code, fic.unit
           FROM fab_stock_pieces fsp
           JOIN fab_item_catalog fic ON fic.id = fsp.catalog_item_id
          WHERE ${whereClause}
          ORDER BY fic.name, fsp.id`,
        params,
      );

      const pieceIds = pieceRows.map((r) => r.id);
      const customFieldsByPieceId = new Map();
      if (pieceIds.length) {
        const [cfRows] = await pool.query(
          `SELECT level_id, field_key, field_value
             FROM fab_custom_fields
            WHERE company_id = ? AND level = 'stock_piece' AND level_id IN (?) AND deleted_at IS NULL
            ORDER BY sort_order`,
          [companyId, pieceIds],
        );
        for (const cf of cfRows) {
          if (!customFieldsByPieceId.has(cf.level_id)) customFieldsByPieceId.set(cf.level_id, []);
          customFieldsByPieceId.get(cf.level_id).push({ fieldKey: cf.field_key, fieldValue: cf.field_value });
        }
      }

      const itemsByCatalogId = new Map();
      for (const r of pieceRows) {
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
        item.segments.push({
          value: r.batch_no ?? r.serial_no ?? r.heat_no ?? r.mark_no ?? `Piece #${r.id}`,
          qty: r.qty,
          pieceId: r.id,
          batchNo: r.batch_no,
          heatNo: r.heat_no,
          serialNo: r.serial_no,
          markNo: r.mark_no,
          status: r.status,
          stockLocationId: r.stock_location_id,
          receivedDate: r.received_date,
          customFields: customFieldsByPieceId.get(r.id) ?? [],
        });
      }

      return res.status(200).json({ ok: true, data: { items: [...itemsByCatalogId.values()] } });
    }

    // ── Mode 2: item-level totals + per-dimension breakdown ────────────
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

    // Fold the flat rows into { items: [{ ...totals, segments: [...] }] }
    const itemsByCatalogId = new Map();
    for (const r of rows) {
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
