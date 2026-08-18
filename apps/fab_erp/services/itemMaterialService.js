/**
 * itemMaterialService.js — "what is this part cut from", set one part at a time.
 *
 * The BOQ importer has always been able to answer this, via the sheet's Raw
 * Material column. The SCREEN could not: the item tree let you set a flow and
 * dimensions inline but had no material control anywhere, so the nesting step
 * told people to "set the Raw Material column and re-upload" — an Excel round
 * trip to change one dropdown. That was the last thing forcing the spreadsheet
 * after the structure wizard learned to accept as-is.
 *
 * THE SHAPE OF A MATERIAL LINK, which this file now owns for both callers:
 *
 *   a CHILD fab_items row under the part
 *     catalog_item_id  the material            <- what makes it a material row
 *     flow_id          NULL                    <- and not a made child part
 *     level_kind       'material'
 *     qty              1
 *     nest_no          NULL until nesting groups it onto a plate
 *
 * That `catalog_item_id IS NOT NULL AND flow_id IS NULL` pair is the same test
 * taskGatingService and the formula engine use to tell a `raw_material` input
 * from a `child_parts` one, so a link made here behaves identically to an
 * imported one everywhere downstream.
 *
 * CHANGING THE MATERIAL CLEARS THE NEST. A nest is a group of parts sharing ONE
 * physical plate; a part that is now a different material cannot stay on it.
 * The importer already did this and the reason is worth keeping next to the
 * code, because it is not obvious that editing a dropdown should discard
 * nesting work.
 */

import { pool } from '../../../db.js';
import { composeCode, materialSegment } from './itemCodeService.js';

/** The part, with enough context to build its material row's code. */
async function loadPart(exec, companyId, itemId) {
  const [[part]] = await exec.query(
    `SELECT i.id, i.order_id AS orderId, i.order_line_id AS lineId, i.code, i.name,
            i.flow_id AS flowId, i.level_kind AS levelKind
       FROM fab_items i
      WHERE i.id = ? AND i.company_id = ? AND i.deleted_at IS NULL LIMIT 1`,
    [itemId, companyId],
  );
  return part ?? null;
}

/** The existing material child of a part, if it has one. */
async function existingLink(exec, companyId, partId) {
  const [[row]] = await exec.query(
    `SELECT id, catalog_item_id AS catalogItemId, nest_no AS nestNo FROM fab_items
      WHERE company_id = ? AND parent_item_id = ? AND catalog_item_id IS NOT NULL
        AND flow_id IS NULL AND deleted_at IS NULL LIMIT 1`,
    [companyId, partId],
  );
  return row ?? null;
}

/**
 * Set (or clear) what a part is cut from.
 *
 * @param {number|null} catalogItemId null removes the link entirely — "we do
 *   not know yet" is a real answer, and it is how someone undoes a mistake
 *   without having to pick a different wrong material.
 * @returns {Promise<object>} what changed, plus the orderId so the caller can
 *   refresh readiness
 */
export async function setItemMaterial(companyId, itemId, catalogItemId, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();

    const part = await loadPart(conn, companyId, itemId);
    if (!part) { const e = new Error('That item does not exist.'); e.status = 404; throw e; }

    const link = await existingLink(conn, companyId, part.id);

    // ── clearing ──────────────────────────────────────────────────────────
    if (!catalogItemId) {
      if (link) {
        await conn.query(
          'UPDATE fab_items SET deleted_at = NOW() WHERE id = ? AND company_id = ?',
          [link.id, companyId],
        );
      }
      if (owned) await conn.commit();
      return { itemId: part.id, orderId: part.orderId, cleared: !!link, materialId: null };
    }

    const [[material]] = await conn.query(
      `SELECT id, code, name, unit FROM fab_item_catalog
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [catalogItemId, companyId],
    );
    if (!material) {
      const e = new Error('That material is not in the item catalog.');
      e.status = 404;
      throw e;
    }

    // ── unchanged ─────────────────────────────────────────────────────────
    if (link && Number(link.catalogItemId) === Number(material.id)) {
      if (owned) await conn.commit();
      return {
        itemId: part.id, orderId: part.orderId, materialId: material.id,
        materialCode: material.code, unchanged: true, nestCleared: false,
      };
    }

    // ── changing ──────────────────────────────────────────────────────────
    if (link) {
      await conn.query(
        `UPDATE fab_items SET catalog_item_id = ?, name = ?, unit = ?, nest_no = NULL
          WHERE id = ? AND company_id = ?`,
        [material.id, material.name, material.unit || 'pcs', link.id, companyId],
      );
      if (owned) await conn.commit();
      return {
        itemId: part.id, orderId: part.orderId, materialId: material.id,
        materialCode: material.code, nestCleared: link.nestNo != null,
      };
    }

    // ── creating ──────────────────────────────────────────────────────────
    await conn.query(
      `INSERT INTO fab_items
         (company_id, order_id, order_line_id, parent_item_id, catalog_item_id, name, unit,
          qty, flow_id, code, nest_no, level_kind)
       VALUES (?,?,?,?,?,?,?,1,NULL,?,NULL,'material')`,
      [
        companyId, part.orderId, part.lineId, part.id, material.id, material.name,
        material.unit || 'pcs',
        composeCode(part.code, materialSegment(material.code, material.name)),
      ],
    );
    if (owned) await conn.commit();
    return {
      itemId: part.id, orderId: part.orderId, materialId: material.id,
      materialCode: material.code, created: true, nestCleared: false,
    };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/**
 * What each of these parts is currently cut from.
 *
 * Batched because the item tree renders a few hundred rows and asking per row
 * would be a few hundred round trips.
 *
 * @returns {Promise<Map<number, {materialId, code, name, thicknessMm}>>}
 */
export async function materialsForItems(companyId, itemIds, conn = null) {
  const exec = conn ?? pool;
  const ids = [...new Set((itemIds ?? []).map(Number).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;

  const [rows] = await exec.query(
    `SELECT i.parent_item_id AS partId, i.catalog_item_id AS materialId,
            c.code, c.name, c.thickness_mm AS thicknessMm, c.material_form AS materialForm
       FROM fab_items i
       JOIN fab_item_catalog c ON c.id = i.catalog_item_id
      WHERE i.company_id = ? AND i.flow_id IS NULL AND i.deleted_at IS NULL
        AND i.parent_item_id IN (${ids.map(() => '?').join(',')})`,
    [companyId, ...ids],
  );
  for (const r of rows) out.set(Number(r.partId), r);
  return out;
}
