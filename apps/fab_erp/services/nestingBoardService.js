/**
 * nestingBoardService.js — nesting as a board you arrange, not a sheet you type.
 *
 * The Excel path still exists and is still how a hundred plates get laid out in
 * one go. This is for the other half of the job: looking at what is left,
 * deciding what goes on the next plate, and moving a part off one nest and onto
 * another. That is a spatial task, and a spreadsheet is a poor way to do it.
 *
 * THERE IS NO NEST TABLE, and deliberately so. A nest is a group of raw-material
 * link rows in `fab_items` sharing (order_id, catalog_item_id, nest_no) — the
 * same label the sheet writes, so the gate, the stock draw and the material
 * report all read it exactly as they did before. Adding a table would mean two
 * definitions of the same thing.
 *
 * The consequence worth knowing: **a nest with no parts on it does not exist.**
 * There is nowhere to store it. The board creates one client-side and it becomes
 * real on the first drop, which is why `createNest` is not an endpoint.
 *
 * WHAT A PART CAN GO ON is decided by its material, which the BOM captured. A
 * part whose link says 20mm plate can only be dropped on a 20mm plate nest;
 * anything else would be a nest whose members are not all from one piece, which
 * is what a nest means.
 */

import { pool } from '../../../db.js';

/** 404s unless the order is in the caller's company. */
async function assertOrder(companyId, orderId) {
  const [rows] = await pool.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!rows.length) { const e = new Error('Order not found'); e.status = 404; throw e; }
}

/**
 * Everything the board draws: the parts, grouped by the material they need, and
 * the nests that exist so far.
 */
export async function nestingBoard(companyId, orderId) {
  await assertOrder(companyId, orderId);

  // One row per raw-material LINK — the part it hangs under, and the nest it
  // has been put on, if any.
  const [links] = await pool.query(
    `SELECT rm.id            AS linkId,
            rm.nest_no       AS nestNo,
            rm.qty           AS plates,
            rm.length, rm.width, rm.height,
            rm.catalog_item_id AS materialId,
            fic.code         AS materialCode,
            fic.name         AS materialName,
            fic.unit         AS materialUnit,
            -- The catalog's own thickness, so a nest can default to it rather
            -- than making somebody retype a number the catalog already knows.
            fic.thickness_mm AS materialThickness,
            p.id             AS partId,
            p.code           AS partCode,
            p.name           AS partName,
            p.qty            AS partQty,
            p.length         AS partLength,
            p.width          AS partWidth,
            p.height         AS partThick
       FROM fab_items rm
       JOIN fab_items p        ON p.id = rm.parent_item_id AND p.deleted_at IS NULL
       JOIN fab_item_catalog fic ON fic.id = rm.catalog_item_id
      WHERE rm.company_id = ? AND rm.order_id = ? AND rm.deleted_at IS NULL
        AND rm.catalog_item_id IS NOT NULL AND rm.flow_id IS NULL
      ORDER BY p.code`,
    [companyId, orderId],
  );

  // Parts with no material at all — the board shows them so the gap is visible
  // rather than the part simply being absent from a screen it belongs on.
  const [orphans] = await pool.query(
    `SELECT p.id AS partId, p.code AS partCode, p.name AS partName, p.qty AS partQty,
            p.length AS partLength, p.width AS partWidth, p.height AS partThick
       FROM fab_items p
       LEFT JOIN fab_items rm
              ON rm.parent_item_id = p.id AND rm.deleted_at IS NULL
             AND rm.catalog_item_id IS NOT NULL AND rm.flow_id IS NULL
      WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL
        AND p.level_kind = 'part'
      GROUP BY p.id, p.code, p.name, p.qty, p.length, p.width, p.height
     HAVING COUNT(rm.id) = 0
      ORDER BY p.code`,
    [companyId, orderId],
  );

  // Which nests have already gone to the floor. Those are settled — a plate
  // that has been cut cannot be re-arranged, and saying so is kinder than
  // letting someone drag a part off it and wonder why nothing changed.
  const [issued] = await pool.query(
    `SELECT catalog_item_id AS materialId, nest_no AS nestNo
       FROM fab_nest_issues WHERE company_id = ? AND order_id = ?`,
    [companyId, orderId],
  );
  const issuedKeys = new Set(issued.map((i) => `${i.materialId}|${i.nestNo}`));

  const materials = new Map();
  const nests = new Map();
  const unnested = [];

  for (const l of links) {
    if (!materials.has(l.materialId)) {
      materials.set(l.materialId, {
        id: l.materialId, code: l.materialCode, name: l.materialName, unit: l.materialUnit,
      });
    }
    const part = {
      linkId: l.linkId, partId: l.partId, code: l.partCode, name: l.partName,
      qty: l.partQty != null ? Number(l.partQty) : null,
      length: num(l.partLength), width: num(l.partWidth), thick: num(l.partThick),
      materialId: l.materialId, materialCode: l.materialCode,
    };
    if (!l.nestNo) { unnested.push(part); continue; }

    const k = `${l.materialId}|${l.nestNo}`;
    if (!nests.has(k)) {
      nests.set(k, {
        key: k,
        nestNo: l.nestNo,
        materialId: l.materialId,
        materialCode: l.materialCode,
        materialName: l.materialName,
        // The PLATE's size, carried on every link cut from it.
        //
        // Thickness falls back to the catalog item's own `thickness_mm`. A
        // "20mm plate" catalog row IS its thickness, so a nest drawn from it
        // can only be 20mm — asking somebody to retype that on every nest was
        // busywork that also invited a typo the rest of the system would then
        // trust. An explicit value on the link still wins, so a nest that was
        // deliberately set to something else is never overwritten.
        length: num(l.length), width: num(l.width),
        thick: num(l.height) ?? num(l.materialThickness),
        plates: l.plates != null ? Number(l.plates) : 1,
        issued: issuedKeys.has(k),
        parts: [],
      });
    }
    nests.get(k).parts.push(part);
  }

  return {
    materials: [...materials.values()].sort((a, b) => a.code.localeCompare(b.code)),
    nests: [...nests.values()].sort((a, b) => a.nestNo.localeCompare(b.nestNo)),
    unnested,
    noMaterial: orphans.map((o) => ({
      partId: o.partId, code: o.partCode, name: o.partName,
      qty: o.partQty != null ? Number(o.partQty) : null,
      length: num(o.partLength), width: num(o.partWidth), thick: num(o.partThick),
      materialId: null, materialCode: null,
    })),
  };
}

const num = (v) => (v == null ? null : Number(v));

/**
 * Put parts on a nest, or take them off it (`nestNo: null`).
 *
 * Every part must already need the nest's material. That is checked here rather
 * than trusted from the screen, because it is the invariant the whole idea rests
 * on: a nest is one physical plate, so its members cannot be different steel.
 *
 * Plate dimensions are written to every link on the nest, since they describe
 * the plate rather than the part — the same shape the sheet importer produces.
 */
export async function assignParts(companyId, orderId, { linkIds, nestNo, plate }) {
  await assertOrder(companyId, orderId);
  const ids = (Array.isArray(linkIds) ? linkIds : []).map(Number).filter(Number.isFinite);
  if (!ids.length) { const e = new Error('No parts given.'); e.status = 400; throw e; }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, catalog_item_id, nest_no FROM fab_items
        WHERE company_id = ? AND order_id = ? AND id IN (?) AND deleted_at IS NULL
          AND catalog_item_id IS NOT NULL AND flow_id IS NULL`,
      [companyId, orderId, ids],
    );
    if (rows.length !== ids.length) {
      const e = new Error('Some of those parts are no longer on this order.');
      e.status = 409; throw e;
    }

    if (nestNo) {
      const materials = new Set(rows.map((r) => r.catalog_item_id));
      if (materials.size > 1) {
        const e = new Error('Those parts are cut from different materials, so they cannot share a plate.');
        e.status = 422; throw e;
      }
      const materialId = [...materials][0];

      // Refuse to touch a nest already drawn from stock.
      const [[gone]] = await conn.query(
        `SELECT id FROM fab_nest_issues
          WHERE company_id = ? AND order_id = ? AND catalog_item_id = ? AND nest_no = ? LIMIT 1`,
        [companyId, orderId, materialId, nestNo],
      );
      if (gone) {
        const e = new Error(`${nestNo} has already gone to the floor and cannot be re-arranged.`);
        e.status = 409; throw e;
      }

      // An existing nest of that number must be the same material.
      const [[other]] = await conn.query(
        `SELECT catalog_item_id FROM fab_items
          WHERE company_id = ? AND order_id = ? AND nest_no = ? AND deleted_at IS NULL
            AND catalog_item_id IS NOT NULL AND flow_id IS NULL LIMIT 1`,
        [companyId, orderId, nestNo],
      );
      if (other && other.catalog_item_id !== materialId) {
        const e = new Error(`${nestNo} is a different material.`);
        e.status = 422; throw e;
      }
    }

    await conn.query(
      `UPDATE fab_items SET nest_no = ? WHERE company_id = ? AND order_id = ? AND id IN (?)`,
      [nestNo || null, companyId, orderId, ids],
    );

    if (nestNo && plate && (plate.length || plate.width || plate.thick || plate.plates)) {
      await conn.query(
        `UPDATE fab_items
            SET length = COALESCE(?, length), width = COALESCE(?, width),
                height = COALESCE(?, height), qty = COALESCE(?, qty)
          WHERE company_id = ? AND order_id = ? AND nest_no = ? AND deleted_at IS NULL
            AND catalog_item_id IS NOT NULL AND flow_id IS NULL`,
        [plate.length ?? null, plate.width ?? null, plate.thick ?? null, plate.plates ?? null,
          companyId, orderId, nestNo],
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const { recomputeOrderWeights } = await import('./itemWeightService.js');
  await recomputeOrderWeights(companyId, orderId);
  return nestingBoard(companyId, orderId);
}

/**
 * Set a nest's plate size without moving any parts.
 */
export async function updateNest(companyId, orderId, nestNo, plate = {}) {
  await assertOrder(companyId, orderId);
  const [res] = await pool.query(
    `UPDATE fab_items
        SET length = COALESCE(?, length), width = COALESCE(?, width),
            height = COALESCE(?, height), qty = COALESCE(?, qty)
      WHERE company_id = ? AND order_id = ? AND nest_no = ? AND deleted_at IS NULL
        AND catalog_item_id IS NOT NULL AND flow_id IS NULL`,
    [plate.length ?? null, plate.width ?? null, plate.thick ?? null, plate.plates ?? null,
      companyId, orderId, nestNo],
  );
  if (!res.affectedRows) { const e = new Error('Nest not found'); e.status = 404; throw e; }
  await (await import('./itemWeightService.js')).recomputeOrderWeights(companyId, orderId);
  return nestingBoard(companyId, orderId);
}

/**
 * Break a nest up. The parts keep their material and go back to the pool — the
 * plate was a grouping decision, and undoing it must not lose the fact that
 * these parts are made of 20mm steel.
 */
export async function clearNest(companyId, orderId, nestNo) {
  await assertOrder(companyId, orderId);
  const [[gone]] = await pool.query(
    `SELECT id FROM fab_nest_issues WHERE company_id = ? AND order_id = ? AND nest_no = ? LIMIT 1`,
    [companyId, orderId, nestNo],
  );
  if (gone) {
    const e = new Error(`${nestNo} has already gone to the floor and cannot be broken up.`);
    e.status = 409; throw e;
  }
  await pool.query(
    `UPDATE fab_items SET nest_no = NULL
      WHERE company_id = ? AND order_id = ? AND nest_no = ? AND deleted_at IS NULL
        AND catalog_item_id IS NOT NULL AND flow_id IS NULL`,
    [companyId, orderId, nestNo],
  );
  return nestingBoard(companyId, orderId);
}

/**
 * The next free nest number for a material, so the board can label a new card
 * before anything is dropped on it. Numbers run per material, matching the
 * sheet: two different plates are N-001 and N-002 whatever they are made of.
 */
export async function nextNestNo(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT nest_no FROM fab_items
      WHERE company_id = ? AND order_id = ? AND nest_no IS NOT NULL AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  let max = 0;
  for (const r of rows) {
    const m = /^N-(\d+)$/.exec(String(r.nest_no));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `N-${String(max + 1).padStart(3, '0')}`;
}
