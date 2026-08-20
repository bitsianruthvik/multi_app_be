/**
 * nestingSuggestService.js — propose a nesting; write nothing until accepted.
 *
 * A SUGGESTOR, NOT AN AUTOMATION. Nesting arrives three ways and this is the
 * third, not a replacement for the other two: the Excel sheet import and the
 * board's drag-and-drop stay exactly as they are. Somebody who already knows
 * what they want keeps doing it; somebody staring at four hundred parts gets a
 * starting point. `suggest()` therefore has no write path at all — the only way
 * anything reaches the database is `accept()`, with the nests a person chose.
 *
 * ── WHAT IT OPTIMISES ─────────────────────────────────────────────────────
 * Waste. Parts are grouped by the two things that decide what they can be cut
 * from — thickness and grade — and each group is packed onto plate sizes drawn
 * from the item catalog. Choosing the SIZE is most of the win: the same parts
 * on a badly chosen plate leave a third of it as offcut.
 *
 * ── WHERE THE CANDIDATE SIZES COME FROM ───────────────────────────────────
 * The `Plates` group of the item catalog, one item per buyable size, each
 * carrying thickness_mm / width_mm / length_mm / grade as field values. Nothing
 * here parses a name to work out what a plate is. A size that is not in the
 * catalog is not offered — if the drawing needs a plate nobody sells, the
 * suggestion says so rather than inventing one.
 *
 * ── WHAT ACCEPTING CHANGES ────────────────────────────────────────────────
 * The link's `catalog_item_id` is repointed to the SPECIFIC size, not just its
 * `nest_no` and dimensions. That is the difference between procurement buying
 * "20 of MS Plate 12mm" and buying "16 of 12 x 2300 x 12050 and 4 of
 * 12 x 2250 x 12050", and it is what lets the shortfall match stock size for
 * size. It is also more than the board's `assignParts` does, which is why
 * accept has its own write path rather than calling it.
 */

import { pool } from '../../../db.js';
import { resolveItemFields } from './itemFieldService.js';
import { resolveFields } from './fieldService.js';
import { nest, verify, utilisation } from './nestingPacker.js';
import { syncOrderProcurement } from './procurementService.js';

const PLATE_GROUP = 'Plates';
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function assertOrder(companyId, orderId) {
  const [[o]] = await pool.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!o) { const e = new Error('Order not found'); e.status = 404; throw e; }
}

/**
 * Every buyable plate in the catalog, with the numbers that decide nesting.
 *
 * Read through the field resolver rather than off columns, because width and
 * length have no column at catalog scope — only thickness does — so the columns
 * alone would give a set of plates with no size.
 */
async function plateCatalog(companyId, conn = null) {
  const exec = conn ?? pool;
  const [items] = await exec.query(
    `SELECT ic.id, ic.code, ic.name, ic.thickness_mm AS thicknessMm
       FROM fab_item_catalog ic
       JOIN fab_item_groups g ON g.id = ic.group_id AND g.name = ? AND g.deleted_at IS NULL
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL`,
    [PLATE_GROUP, companyId],
  );
  if (!items.length) return [];

  const resolved = await resolveFields(
    companyId,
    items.map((i) => ({ scope: 'catalog_item', scopeId: i.id })),
    { conn: exec },
  );
  const out = [];
  for (const i of items) {
    const f = resolved.get(`catalog_item:${i.id}`) ?? {};
    const length = num(f.length_mm?.value);
    const width = num(f.width_mm?.value);
    const thickness = num(f.thickness_mm?.value) ?? num(i.thicknessMm);
    const grade = f.grade?.value ?? null;
    // A plate with no size cannot be nested onto and is silently useless here;
    // it is left out rather than offered as a candidate that fits everything.
    if (length == null || width == null || thickness == null) continue;
    out.push({ id: i.id, code: i.code, name: i.name, length, width, thickness, grade });
  }
  return out;
}

/**
 * Offcuts on the shelf, as candidate plates.
 *
 * WHY THESE ARE DIFFERENT FROM CATALOGUE SIZES, in two ways that both matter:
 *
 *   available: 1   a catalogue size can be bought again; a drop is ONE piece of
 *                  steel and can be nested onto once.
 *   preferred      it is already paid for. The objective is the least steel
 *                  BOUGHT, not the tidiest plate, so a drop that fits is worth
 *                  more than a fresh sheet that fits better.
 *
 * Only drops of the materials this order actually uses are fetched — the yard
 * may hold hundreds and there is no sense packing against 16 mm offcuts for an
 * order made entirely of 12 mm.
 */
async function offcutSpecs(companyId, catalogItemIds, conn = null) {
  const exec = conn ?? pool;
  if (!catalogItemIds.length) return [];
  const [rows] = await exec.query(
    `SELECT p.id, p.code, p.catalog_item_id AS catalogItemId, p.length_mm AS length,
            p.width_mm AS width, p.dims_estimated AS estimated, ic.name AS materialName,
            ic.thickness_mm AS thickness
       FROM fab_stock_pieces p
       JOIN fab_item_catalog ic ON ic.id = p.catalog_item_id AND ic.deleted_at IS NULL
       LEFT JOIN fab_stock_reservations r
              ON r.stock_piece_id = p.id AND r.status = 'active' AND r.deleted_at IS NULL
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status = 'in_stock'
        AND p.origin_piece_id IS NOT NULL AND p.qty > 0
        AND p.length_mm IS NOT NULL AND p.width_mm IS NOT NULL
        AND p.catalog_item_id IN (?)
        -- A drop somebody else has claimed is not available to offer twice.
        AND r.id IS NULL
      ORDER BY p.length_mm * p.width_mm ASC`,
    [companyId, catalogItemIds],
  );
  return rows.map((r) => ({
    // Negative so it can never collide with a catalog item id in the same list.
    id: -Number(r.id),
    pieceId: Number(r.id),
    catalogItemId: Number(r.catalogItemId),
    code: r.code,
    name: `${r.materialName} — offcut ${r.code}`,
    length: Number(r.length),
    width: Number(r.width),
    thickness: r.thickness == null ? null : Number(r.thickness),
    grade: null, // filled from the material below
    estimated: Number(r.estimated) === 1,
    available: 1,
    preferred: true,
  }));
}

/**
 * The parts this order could nest, with their size and what they are cut from.
 *
 * A part here is the same thing the board calls one: a childless link row
 * carrying a catalog item and no flow, whose PARENT is the part proper. The
 * part's dimensions come from the field resolver; the link's are the plate's.
 */
async function nestableParts(companyId, orderId, { includeNested }) {
  const [links] = await pool.query(
    `SELECT rm.id AS linkId, rm.nest_no AS nestNo, rm.catalog_item_id AS materialId,
            fic.code AS materialCode, fic.name AS materialName,
            fic.thickness_mm AS materialThickness,
            p.id AS partId, p.code AS partCode, p.name AS partName, p.qty AS partQty
       FROM fab_items rm
       JOIN fab_items p ON p.id = rm.parent_item_id AND p.deleted_at IS NULL
       JOIN fab_item_catalog fic ON fic.id = rm.catalog_item_id AND fic.deleted_at IS NULL
      WHERE rm.company_id = ? AND rm.order_id = ? AND rm.deleted_at IS NULL
        AND rm.catalog_item_id IS NOT NULL AND rm.flow_id IS NULL
        ${includeNested ? '' : 'AND rm.nest_no IS NULL'}
      ORDER BY p.code`,
    [companyId, orderId],
  );
  if (!links.length) return { rows: [], skipped: [] };

  const fields = await resolveItemFields(companyId, [...new Set(links.map((l) => l.partId))]);
  // The grade of what each part is CURRENTLY linked to, so a suggestion keeps
  // the material somebody already chose rather than quietly changing it.
  const matGrades = await resolveFields(
    companyId,
    [...new Set(links.map((l) => l.materialId))].map((id) => ({ scope: 'catalog_item', scopeId: id })),
    {},
  );

  const rows = [];
  const skipped = [];
  for (const l of links) {
    /**
     * NOT EVERYTHING WITH A MATERIAL IS CUT FROM PLATE.
     *
     * A shear stud has a material link like any part does, and its own 175 x 25
     * even fits on a plate — so nothing about the part itself says "do not nest
     * me", and 7,212 of them sent the packer looking for a plate that could
     * hold them all. What says it is the MATERIAL: plate stock has a thickness,
     * a bought fastener does not. A part whose material is not plate is simply
     * not plate-nesting's business, and saying so is more useful than failing
     * to pack it.
     */
    if (num(l.materialThickness) == null) {
      skipped.push({
        linkId: l.linkId, partCode: l.partCode, partName: l.partName,
        reason: `${l.materialCode} is not plate stock — it has no thickness — so this part is `
              + 'bought or made some other way, not cut from a plate.',
      });
      continue;
    }
    const f = fields.get(l.partId) ?? {};
    const length = num(f.length_mm);
    const width = num(f.width_mm);
    const thickness = num(f.thickness_mm);
    if (length == null || width == null || thickness == null) {
      skipped.push({
        linkId: l.linkId, partCode: l.partCode, partName: l.partName,
        reason: `no ${length == null ? 'length' : width == null ? 'width' : 'thickness'} recorded, `
              + 'so there is nothing to nest',
      });
      continue;
    }
    rows.push({
      key: String(l.linkId),
      linkId: l.linkId,
      partId: l.partId,
      partCode: l.partCode,
      partName: l.partName,
      qty: Math.max(1, Number(l.partQty) || 1),
      length, width, thickness,
      currentNestNo: l.nestNo,
      currentMaterialId: l.materialId,
      currentMaterialCode: l.materialCode,
      grade: matGrades.get(`catalog_item:${l.materialId}`)?.grade?.value ?? null,
    });
  }
  return { rows, skipped };
}

/**
 * Propose a nesting for an order. Writes nothing.
 *
 * @param {object} opts
 *   includeNested  re-nest parts already on a plate (default false)
 *   grade          force a grade for parts whose material does not state one
 * @returns {Promise<object>} the proposal
 */
export async function suggestNesting(companyId, orderId, opts = {}) {
  await assertOrder(companyId, orderId);
  const includeNested = !!opts.includeNested;

  const [{ rows, skipped }, plates] = await Promise.all([
    nestableParts(companyId, orderId, { includeNested }),
    plateCatalog(companyId),
  ]);
  // Only the materials this order actually draws on.
  const offcuts = await offcutSpecs(companyId, [...new Set(rows.map((r) => r.currentMaterialId))]);

  if (!plates.length) {
    return {
      ok: false, groups: [], skipped, unplaced: [],
      message: `No plates in the "${PLATE_GROUP}" item group have a recorded size, `
             + 'so there is nothing to nest onto. Import the raw-material master first.',
    };
  }
  if (!rows.length) {
    return {
      ok: true, groups: [], skipped, unplaced: [], summary: emptySummary(),
      message: includeNested ? 'This order has no parts with material to nest.'
        : 'Every part with material is already nested. Re-run including nested parts to re-plan.',
    };
  }

  /**
   * Grouped by thickness AND grade, because those are the two properties that
   * decide what a part may be cut from. Grouping on thickness alone would
   * cheerfully nest an E350 part onto E250 plate and be more efficient for it.
   */
  const groups = new Map();
  for (const r of rows) {
    const grade = opts.grade ?? r.grade ?? null;
    const key = `${r.thickness}|${grade ?? '?'}`;
    if (!groups.has(key)) groups.set(key, { thickness: r.thickness, grade, rows: [] });
    groups.get(key).rows.push(r);
  }

  const out = [];
  const unplaced = [];
  for (const [, g] of groups) {
    // Candidates: the right thickness, and the right grade when one is known.
    // An unknown grade is NOT treated as "any grade" — it narrows to nothing and
    // is reported, because quietly picking a grade is a metallurgical decision
    // and not one a packer should make.
    const specs = plates.filter((p) => Math.abs(p.thickness - g.thickness) < 0.001
      && (g.grade == null || p.grade === g.grade));
    /**
     * Offcuts of the SAME material join the candidates.
     *
     * Matched on catalog item rather than on thickness and grade, because a
     * drop IS a piece of that exact item — it inherited the id from the plate
     * it was cut off. That is stricter than the thickness/grade test above and
     * deliberately so: there is no inference to make about what a drop is.
     */
    const drops = offcuts.filter((o) => g.rows.some((r) => r.currentMaterialId === o.catalogItemId));
    const candidates = [...drops, ...specs];

    if (!candidates.length) {
      for (const r of g.rows) {
        unplaced.push({
          linkId: r.linkId, partCode: r.partCode, partName: r.partName,
          reason: g.grade == null
            ? `${r.thickness} mm plate exists, but this part's material does not state a grade, `
              + 'so no size can be chosen. Set a grade on the material, or choose one for this run.'
            : `no ${g.thickness} mm plate in grade ${g.grade} is in the catalog`,
        });
      }
      continue;
    }

    const res = nest(g.rows, candidates);
    for (const u of res.unplaced) {
      unplaced.push({
        linkId: u.row.linkId, partCode: u.row.partCode, partName: u.row.partName, reason: u.reason,
      });
    }

    // Re-checked from the final assignment, not from the packer's own working.
    const problems = verify(res.plates);
    for (const p of res.plates) {
      const used = p.rows.reduce((s, r) => s + r.length * r.width * r.qty, 0);
      const area = p.spec.length * p.spec.width;
      out.push({
        thickness: g.thickness,
        grade: g.grade,
        plate: {
          /**
           * `id` is always the CATALOG item to link the part to — for an offcut
           * that is the item it was cut from, which it inherited. The spec's own
           * id is negative for a drop precisely so it can never be mistaken for
           * one, and `pieceId` names the single physical piece.
           */
          id: p.spec.catalogItemId ?? p.spec.id,
          pieceId: p.spec.pieceId ?? null,
          isOffcut: !!p.spec.pieceId,
          estimatedSize: !!p.spec.estimated,
          code: p.spec.code,
          name: p.spec.name,
          length: p.spec.length,
          width: p.spec.width,
        },
        parts: p.rows.map((r) => ({
          linkId: r.linkId, partId: r.partId, partCode: r.partCode,
          partName: r.partName, qty: r.qty, length: r.length, width: r.width,
        })),
        pieces: p.rows.reduce((s, r) => s + r.qty, 0),
        utilisationPct: Math.round(utilisation(p) * 1000) / 10,
        usedAreaMm2: Math.round(used),
        wasteAreaMm2: Math.round(area - used),
      });
    }
    if (problems.length) {
      // Cannot happen unless the packer is wrong, which is exactly when it must
      // be loud rather than returning a tidy proposal nobody can cut.
      const e = new Error(`The nesting produced an impossible result: ${problems[0]}`);
      e.status = 500;
      throw e;
    }
  }

  out.sort((a, b) => a.thickness - b.thickness || b.utilisationPct - a.utilisationPct);
  return {
    ok: unplaced.length === 0,
    groups: out,
    unplaced,
    skipped,
    summary: summarise(out, unplaced, skipped),
  };
}

const emptySummary = () => ({
  plates: 0, parts: 0, pieces: 0, meanUtilisationPct: 0,
  usedAreaM2: 0, plateAreaM2: 0, wasteAreaM2: 0, wastePct: 0, byThickness: [],
});

function summarise(groups, unplaced, skipped) {
  if (!groups.length) return { ...emptySummary(), unplaced: unplaced.length, skipped: skipped.length };
  const used = groups.reduce((s, g) => s + g.usedAreaMm2, 0);
  const waste = groups.reduce((s, g) => s + g.wasteAreaMm2, 0);
  const byT = new Map();
  for (const g of groups) {
    const k = `${g.thickness}|${g.grade ?? '?'}`;
    if (!byT.has(k)) byT.set(k, { thickness: g.thickness, grade: g.grade, plates: 0, used: 0, waste: 0 });
    const b = byT.get(k);
    b.plates++; b.used += g.usedAreaMm2; b.waste += g.wasteAreaMm2;
  }
  return {
    plates: groups.length,
    parts: groups.reduce((s, g) => s + g.parts.length, 0),
    pieces: groups.reduce((s, g) => s + g.pieces, 0),
    meanUtilisationPct: Math.round((groups.reduce((s, g) => s + g.utilisationPct, 0) / groups.length) * 10) / 10,
    usedAreaM2: Math.round(used / 1e6 * 100) / 100,
    plateAreaM2: Math.round((used + waste) / 1e6 * 100) / 100,
    wasteAreaM2: Math.round(waste / 1e6 * 100) / 100,
    wastePct: Math.round((waste / (used + waste)) * 1000) / 10,
    unplaced: unplaced.length,
    skipped: skipped.length,
    byThickness: [...byT.values()].map((b) => ({
      thickness: b.thickness, grade: b.grade, plates: b.plates,
      wastePct: Math.round((b.waste / (b.used + b.waste)) * 1000) / 10,
    })),
  };
}

/**
 * Write the nests a person accepted.
 *
 * Takes the proposal's own groups back rather than re-deriving them, so what is
 * saved is what was on screen — re-running the packer here could legitimately
 * produce a different answer (the catalog may have changed) and save something
 * nobody looked at.
 *
 * @param {Array<{plate:{id}, parts:Array<{linkId}>}>} accepted
 */
export async function acceptSuggestion(companyId, orderId, accepted) {
  await assertOrder(companyId, orderId);
  const nests = Array.isArray(accepted) ? accepted : [];
  if (!nests.length) { const e = new Error('No nests were accepted.'); e.status = 400; throw e; }

  const conn = await pool.getConnection();
  let applied = 0;
  let linksMoved = 0;
  let offcutsClaimed = 0;
  try {
    await conn.beginTransaction();

    // Numbering continues from whatever the order already has, so accepting a
    // suggestion never renumbers a nest somebody made by hand.
    const [[{ maxNo }]] = await conn.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(nest_no, 3) AS UNSIGNED)), 0) AS maxNo
         FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
          AND nest_no REGEXP '^N-[0-9]+$'`,
      [companyId, orderId],
    );
    let next = Number(maxNo) || 0;

    for (const n of nests) {
      const linkIds = (n.parts ?? []).map((p) => Number(p.linkId)).filter(Number.isFinite);
      const plateId = Number(n.plate?.id);
      if (!linkIds.length || !Number.isFinite(plateId)) continue;

      const [[plate]] = await conn.query(
        `SELECT ic.id, ic.name, ic.unit, ic.thickness_mm AS thicknessMm
           FROM fab_item_catalog ic WHERE ic.id = ? AND ic.company_id = ? AND ic.deleted_at IS NULL`,
        [plateId, companyId],
      );
      if (!plate) { const e = new Error('That plate is no longer in the catalog.'); e.status = 409; throw e; }

      // A nest already issued to the floor is not ours to rearrange. Checked on
      // the links being MOVED, since those are what would change underneath it.
      const [issued] = await conn.query(
        `SELECT DISTINCT i.nest_no FROM fab_items i
           JOIN fab_nest_issues ni ON ni.company_id = i.company_id AND ni.order_id = i.order_id
            AND ni.catalog_item_id = i.catalog_item_id AND ni.nest_no = i.nest_no
          WHERE i.company_id = ? AND i.order_id = ? AND i.id IN (?) AND i.deleted_at IS NULL`,
        [companyId, orderId, linkIds],
      );
      if (issued.length) {
        const e = new Error(`${issued.map((r) => r.nest_no).join(', ')} has already gone to the floor `
          + 'and cannot be re-arranged.');
        e.status = 409; throw e;
      }

      const nestNo = `N-${String(++next).padStart(3, '0')}`;
      const [res] = await conn.query(
        `UPDATE fab_items
            SET nest_no = ?, catalog_item_id = ?, name = ?, unit = ?,
                length = ?, width = ?, height = ?, qty = 1
          WHERE company_id = ? AND order_id = ? AND id IN (?) AND deleted_at IS NULL
            AND catalog_item_id IS NOT NULL AND flow_id IS NULL`,
        [nestNo, plate.id, plate.name, plate.unit || 'nos',
          n.plate.length, n.plate.width, plate.thicknessMm,
          companyId, orderId, linkIds],
      );
      applied++;
      linksMoved += res.affectedRows;

      /**
       * AN OFFCUT IS ONE PIECE, SO ACCEPTING ONE HAS TO CLAIM IT.
       *
       * A catalogue size can be bought again, so planning against it commits
       * nothing. A drop cannot: two orders that both accept a suggestion using
       * the same offcut have both planned around steel only one of them will
       * get, and the second finds out at the torch. The earmark is what makes
       * the suggestion honest, and it is also what keeps the NEXT suggestion
       * from offering the same drop (see offcutSpecs).
       *
       * Conditional on the piece still being free, so two accepts racing cannot
       * both claim it — the loser gets no reservation and is told.
       */
      if (n.plate?.pieceId) {
        const [claim] = await conn.query(
          // kind='order', not the column's default of 'task': this is the ORDER
          // laying claim to a piece at planning time, long before any task
          // exists to hold it.
          `INSERT INTO fab_stock_reservations
             (company_id, order_id, catalog_item_id, stock_piece_id, qty, status, kind, notes, created_at)
           SELECT ?, ?, ?, p.id, p.qty, 'active', 'order',
                  CONCAT('nested onto offcut ', COALESCE(p.code, p.id)), UTC_TIMESTAMP()
             FROM fab_stock_pieces p
            WHERE p.id = ? AND p.company_id = ? AND p.status = 'in_stock' AND p.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM fab_stock_reservations r
                               WHERE r.stock_piece_id = p.id AND r.status = 'active'
                                 AND r.deleted_at IS NULL)`,
          [companyId, orderId, plate.id, n.plate.pieceId, companyId],
        );
        if (!claim.affectedRows) {
          const e = new Error(
            `Offcut ${n.plate.code} has just been claimed by another order, so this plate `
            + 'is no longer free. Re-run the suggestion.',
          );
          e.status = 409; throw e;
        }
        offcutsClaimed++;
      }
    }

    // Repointing a link changes WHICH item the order buys, so the buy/make
    // picture is re-derived on the same connection, before the commit.
    await syncOrderProcurement(conn, companyId, orderId);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const { recomputeOrderWeights } = await import('./itemWeightService.js');
  await recomputeOrderWeights(companyId, orderId);
  return { nestsCreated: applied, partsNested: linksMoved, offcutsClaimed };
}
