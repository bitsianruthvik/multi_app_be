import { exportOrderItemsTemplate, importOrderItemsExcel } from '../services/orderItemsImportService.js';
import { recomputeOrderWeights } from '../services/itemWeightService.js';
import { generateOrderItemCodes, customerAbbrev } from '../services/itemCodeService.js';
import { exportBoqSheet, importBoqSheet, buildWizardRows } from '../services/boqSheetService.js';
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

/** GET — the order's BOQ as one sheet (its current tree, or a blank template). */
export const exportBoqHandler = async (req, res) => {
  try {
    const buffer = await exportBoqSheet(companyId(req), Number(req.params.orderId));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Order_BOQ.xlsx"');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'fab_erp: exportBoqSheet failed');
    res.status(err.message === 'Order not found' ? 404 : 500).json({ message: err.message });
  }
};

/**
 * POST — the structure wizard. Returns a SHEET, never database rows: it is
 * scaffolding to save typing the same codes hundreds of times, and everything
 * it guesses is meant to be edited before upload. Writing a half-thought-out
 * structure straight into the order would be much harder to walk back than
 * deleting a spreadsheet.
 */
export const boqWizardHandler = async (req, res) => {
  try {
    const cid = companyId(req);
    const orderId = Number(req.params.orderId);
    await assertOrder(cid, orderId);
    const rows = buildWizardRows(req.body ?? {});
    const buffer = await exportBoqSheet(cid, orderId, rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Order_BOQ_starter.xlsx"');
    res.send(buffer);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ message: err.message });
    logger.error({ err }, 'fab_erp: boqWizard failed');
    res.status(500).json({ message: err.message });
  }
};

/** POST — upload a filled BOQ sheet. */
export const importBoqHandler = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const mode = req.body?.mode === 'replace' ? 'replace' : 'append';
    res.json(await importBoqSheet(req.file, companyId(req), Number(req.params.orderId), mode));
  } catch (err) {
    logger.error({ err }, 'fab_erp: importBoqSheet failed');
    res.status(err.message === 'Order not found' ? 404 : 400).json({ message: err.message });
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
 * The nesting view: each raw material on this order, every part cut from it,
 * and whether it is actually in stock.
 *
 * Stock receipt already releases the tasks waiting on a material — stockInService
 * re-checks them on every receipt and a background sweep catches what it missed.
 * Nothing showed you that, though, so an order could sit blocked on one plate
 * with no screen saying so. This is that screen's data.
 *
 * `onHand` is company-wide for the material, not earmarked per order: earmarking
 * was removed in 2026-08 (the reservations table held zero rows in production),
 * so two orders CAN both read the same plate as available. Shown as "what exists"
 * rather than "what is yours".
 */
export const orderNestingHandler = async (req, res) => {
  try {
    const cid = companyId(req);
    const orderId = Number(req.params.orderId);
    await assertOrder(cid, orderId);

    // A raw-material link is a childless row carrying a catalog item and no
    // flow — the same shape taskGatingService treats as material to consume.
    const [rows] = await pool.query(
      `SELECT rm.catalog_item_id                         AS catalogItemId,
              fic.code                                   AS materialCode,
              fic.name                                   AS materialName,
              fic.unit                                   AS materialUnit,
              rm.id                                      AS linkId,
              rm.nest_no                                 AS nestNo,
              rm.qty                                     AS qtyPerPart,
              parent.id                                  AS partId,
              parent.code                                AS partCode,
              parent.name                                AS partName,
              parent.qty                                 AS partQty
         FROM fab_items rm
         JOIN fab_items parent
           ON parent.id = rm.parent_item_id AND parent.deleted_at IS NULL
         JOIN fab_item_catalog fic ON fic.id = rm.catalog_item_id
        WHERE rm.company_id = ? AND rm.order_id = ? AND rm.deleted_at IS NULL
          AND rm.catalog_item_id IS NOT NULL AND rm.flow_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM fab_items c
                           WHERE c.parent_item_id = rm.id AND c.deleted_at IS NULL)
        ORDER BY fic.code, rm.nest_no, parent.code`,
      [cid, orderId],
    );

    const catalogIds = [...new Set(rows.map((r) => r.catalogItemId))];
    const stockByItem = new Map();
    if (catalogIds.length) {
      const [stock] = await pool.query(
        `SELECT catalog_item_id, SUM(qty) AS onHand, COUNT(*) AS pieces
           FROM fab_stock_pieces
          WHERE company_id = ? AND status = 'in_stock' AND deleted_at IS NULL
            AND catalog_item_id IN (?)
          GROUP BY catalog_item_id`,
        [cid, catalogIds],
      );
      for (const s of stock) stockByItem.set(s.catalog_item_id, s);
    }

    const materials = [];
    const byId = new Map();
    for (const r of rows) {
      if (!byId.has(r.catalogItemId)) {
        const s = stockByItem.get(r.catalogItemId);
        const entry = {
          catalogItemId: r.catalogItemId,
          materialCode: r.materialCode,
          materialName: r.materialName,
          unit: r.materialUnit,
          onHand: s ? Number(s.onHand) : 0,
          pieces: s ? Number(s.pieces) : 0,
          inStock: !!s && Number(s.onHand) > 0,
          nests: [],
          parts: [],
        };
        byId.set(r.catalogItemId, entry);
        materials.push(entry);
      }
      const entry = byId.get(r.catalogItemId);
      const part = {
        linkId: r.linkId,
        partId: r.partId,
        partCode: r.partCode,
        partName: r.partName,
        partQty: Number(r.partQty),
        qtyPerPart: r.qtyPerPart != null ? Number(r.qtyPerPart) : null,
      };
      entry.parts.push(part);

      // Grouped by nest as well as flat, because a nest is one physical plate:
      // "these fourteen come off N-001" is the question the shop asks, and a
      // flat list of ninety parts against a material cannot answer it.
      // Links with no nest_no stand alone rather than being lumped together —
      // nobody has said they share a plate.
      const nestKey = r.nestNo || `~solo-${r.linkId}`;
      let nest = entry.nests.find((n) => n.key === nestKey);
      if (!nest) {
        nest = {
          key: nestKey,
          nestNo: r.nestNo ?? null,
          // On a nested link the quantity describes the plate, so it is the
          // nest's requirement — counted once however many parts sit on it.
          qty: r.qtyPerPart != null ? Number(r.qtyPerPart) : null,
          parts: [],
        };
        entry.nests.push(nest);
      }
      nest.parts.push(part);
    }

    // Requirement = one plate per nest. Summing the per-part rows would ask for
    // the same plate as many times as it has parts on it, which is exactly the
    // arithmetic this replaced.
    const [issued] = catalogIds.length
      ? await pool.query(
        `SELECT catalog_item_id, nest_no FROM fab_nest_issues
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
        [cid, orderId],
      )
      : [[]];
    const issuedSet = new Set(issued.map((i) => `${i.catalog_item_id}|${i.nest_no}`));

    for (const m of materials) {
      m.required = m.nests.reduce((sum, n) => sum + (n.qty ?? 0), 0) || null;
      for (const n of m.nests) {
        n.issued = n.nestNo ? issuedSet.has(`${m.catalogItemId}|${n.nestNo}`) : false;
      }
      m.nestsIssued = m.nests.filter((n) => n.issued).length;
      // What still has to be on hand — a plate already cut is no longer needed.
      m.stillRequired = m.nests
        .filter((n) => !n.issued)
        .reduce((sum, n) => sum + (n.qty ?? 0), 0) || null;
      m.short = m.stillRequired != null && m.stillRequired > m.onHand;
    }

    // "Short" is the sharper signal than "not in stock": a material can have
    // pieces on hand and still not cover the plates this order has left to cut.
    const blocked = materials.filter((m) => m.short || !m.inStock);
    res.json({
      materials,
      nests: materials.reduce((n, m) => n + m.nests.length, 0),
      waitingOnStock: blocked.length,
      nestsBlocked: blocked.reduce((n, m) => n + m.nests.filter((x) => !x.issued).length, 0),
      partsBlocked: blocked.reduce((n, m) => n + m.parts.length, 0),
    });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ message: err.message });
    logger.error({ err }, 'fab_erp: orderNesting failed');
    res.status(500).json({ message: 'Failed to read nesting', error: err.message });
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
