/**
 * assetPurchaseService.js — buying spare parts for a machine, and buying machines.
 *
 * Two new reasons to raise a purchase order, neither of which is caused by a
 * sales order:
 *
 *   SPARES     a bearing for plasma table #2
 *   NEW PLANT  another table of type "CNC Plate Cutting"
 *
 * WHY NOT `raiseProcurement`. That function is the sales-order path and is built
 * on two assumptions this case breaks. It requires a sales order to exist
 * (`order_type = 'sales'`, and it stamps `source_order_id` and a "Raised for SO-x"
 * note), and it requires every line to name a `fab_item_catalog` row — a line
 * without a numeric `catalogItemId` is silently dropped. It also reserves stock
 * and recomputes the order shortfall first, which is meaningless for a gearbox.
 * Bending it to accept a null sales order and free-text lines would put four
 * conditionals through the middle of the one function that raises real material
 * POs, so this is a separate, smaller path that writes the same tables.
 *
 * LINES ARE FREE TEXT BY DEFAULT. `fab_order_lines.code`/`description` exist and
 * `catalog_item_id` is nullable, so a spare can be described rather than
 * catalogued. That is the honest model: nobody wants a catalog item per
 * O-ring, and inventing one to satisfy a foreign key would fill the material
 * catalog with things that are not materials and would then appear in every
 * raw-material picker in the app.
 *
 * THE CONSEQUENCE, STATED PLAINLY: a free-text line CANNOT BE RECEIVED INTO
 * STOCK. `receiveLineWithin` refuses a line with no catalog item, deliberately —
 * there is nowhere to put it. For a machine that is correct (a plasma table does
 * not go on a shelf). For a spare you genuinely want to stock, pass a
 * `catalogItemId` on the line and it behaves exactly like any other material.
 */

import { pool } from '../../../db.js';

const PO_DRAFT = 'draft';

/** `PO-YYYYMMDD-NNNN`, matching the sales path's numbering exactly. */
async function nextPoNumber(conn, companyId) {
  const [[t]] = await conn.query('SELECT DATE_FORMAT(NOW(), "%Y%m%d") AS ymd');
  const stamp = t.ymd;
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM fab_orders
      WHERE company_id = ? AND order_type = 'purchase' AND order_number LIKE ?`,
    [companyId, `PO-${stamp}-%`],
  );
  return `PO-${stamp}-${String(Number(row.n) + 1).padStart(4, '0')}`;
}

/**
 * Raise a purchase order against a machine or a machine type.
 *
 * Exactly one of `resourceId` / `resourceTypeId` — a PO is for a specific
 * machine's spares or for a new machine of a type, and a row claiming both
 * would have no answer to "which machine did we spend this on".
 *
 * @param {object} p
 * @param {number} [p.resourceId]      the machine these spares are for
 * @param {number} [p.resourceTypeId]  the type this new machine will be
 * @param {number} p.supplierId
 * @param {Array<{description:string, qty:number, unitPrice?:number, code?:string,
 *                unit?:string, catalogItemId?:number|null}>} p.lines
 */
export async function raiseAssetPurchase(companyId, p = {}, userId = null) {
  const {
    resourceId = null, resourceTypeId = null, supplierId,
    lines = [], expectedDate = null, notes = null,
  } = p;

  if (!resourceId && !resourceTypeId) {
    throw new Error('A purchase order needs a machine or a machine type to be raised against.');
  }
  if (resourceId && resourceTypeId) {
    throw new Error('Raise against a machine OR a machine type, not both.');
  }
  if (!supplierId) throw new Error('Choose a supplier.');

  const clean = (lines || [])
    .map((l) => ({
      description: String(l.description ?? '').trim(),
      code: l.code ? String(l.code).trim() : null,
      qty: Number(l.qty),
      unit: l.unit ?? null,
      unitPrice: l.unitPrice == null || l.unitPrice === '' ? null : Number(l.unitPrice),
      catalogItemId: l.catalogItemId == null ? null : Number(l.catalogItemId),
    }))
    // A line with no description and no catalog item names nothing; a line with
    // no quantity orders nothing. Both are rejected rather than dropped — the
    // sales path silently skips such lines, which is how you press "raise" and
    // get a PO with fewer lines than you typed.
    .filter((l) => (l.description || l.catalogItemId != null) && Number.isFinite(l.qty) && l.qty > 0);

  if (!clean.length) {
    throw new Error('Every line needs a description and a quantity above zero.');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[sup]] = await conn.query(
      `SELECT id, name, payment_terms, currency FROM fab_suppliers
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [supplierId, companyId],
    );
    if (!sup) { const e = new Error('Supplier not found.'); e.status = 404; throw e; }

    let forLabel = '';
    let plantId = null;
    if (resourceId) {
      const [[r]] = await conn.query(
        `SELECT id, name, code, plant_id FROM fab_resources
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [resourceId, companyId],
      );
      if (!r) { const e = new Error('Machine not found.'); e.status = 404; throw e; }
      forLabel = `Spares for ${r.name}${r.code ? ` (${r.code})` : ''}`;
      plantId = r.plant_id ?? null;
    } else {
      const [[t]] = await conn.query(
        `SELECT id, name, code, plant_id FROM fab_resource_types
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [resourceTypeId, companyId],
      );
      if (!t) { const e = new Error('Machine type not found.'); e.status = 404; throw e; }
      forLabel = `New machine — ${t.name}${t.code ? ` (${t.code})` : ''}`;
      plantId = t.plant_id ?? null;
    }

    const orderNumber = await nextPoNumber(conn, companyId);
    const [ins] = await conn.query(
      `INSERT INTO fab_orders
         (company_id, order_number, order_type, status, supplier_id,
          for_resource_id, for_resource_type_id, plant_id, required_date,
          payment_terms, currency, created_by, notes)
       VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, orderNumber, PO_DRAFT, supplierId,
       resourceId, resourceTypeId, plantId, expectedDate,
       sup.payment_terms ?? null, sup.currency ?? null, userId,
       notes ? `${forLabel}\n${notes}` : forLabel],
    );
    const poId = ins.insertId;

    let lineNo = 1;
    for (const l of clean) {
      let code = l.code;
      let description = l.description;
      let unit = l.unit;
      if (l.catalogItemId != null) {
        // Catalogued spare: take its identity from the catalog so the line
        // reads the same as any material line and can be received into stock.
        const [[cat]] = await conn.query(
          `SELECT code, name, unit FROM fab_item_catalog
            WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
          [l.catalogItemId, companyId],
        );
        if (cat) {
          code = cat.code ?? code;
          description = description || cat.name;
          unit = unit ?? cat.unit;
        }
      }
      await conn.query(
        `INSERT INTO fab_order_lines
           (company_id, order_id, line_no, code, description, catalog_item_id,
            qty, unit, unit_price, expected_date, status, qty_received)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0)`,
        [companyId, poId, lineNo++, code, description, l.catalogItemId,
         l.qty, unit, l.unitPrice, expectedDate],
      );
    }

    await conn.commit();
    return {
      id: poId,
      orderNumber,
      supplierId: Number(supplierId),
      supplierName: sup.name,
      lineCount: clean.length,
      /** True when nothing on this PO can be received into stock — see header. */
      freeTextOnly: clean.every((l) => l.catalogItemId == null),
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Purchase orders raised for a machine, or for a machine type. */
export async function assetPurchases(companyId, { resourceId = null, resourceTypeId = null } = {}) {
  if (!resourceId && !resourceTypeId) return [];
  const [rows] = await pool.query(
    `SELECT o.id, o.order_number AS orderNumber, o.status, o.created_at AS createdAt,
            o.currency, s.name AS supplierName,
            COUNT(l.id) AS lineCount,
            COALESCE(SUM(l.qty * COALESCE(l.unit_price, 0)), 0) AS value
       FROM fab_orders o
       LEFT JOIN fab_suppliers s ON s.id = o.supplier_id
       LEFT JOIN fab_order_lines l ON l.order_id = o.id AND l.deleted_at IS NULL
      WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.order_type = 'purchase'
        AND ${resourceId ? 'o.for_resource_id = ?' : 'o.for_resource_type_id = ?'}
      GROUP BY o.id, o.order_number, o.status, o.created_at, o.currency, s.name
      ORDER BY o.created_at DESC`,
    [companyId, resourceId ?? resourceTypeId],
  );
  return rows;
}
