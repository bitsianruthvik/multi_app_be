/**
 * nestingIntegrityService.js — is this nesting physically possible?
 *
 * Nesting is asserted by whoever fills the sheet or drags the board, and until
 * now it was believed by everything downstream without a single check. Three
 * dimensional relationships exist and NONE of them were enforced server-side:
 *
 *   1. a part's thickness must equal the material it is cut from
 *   2. a part must FIT on the plate it is nested on
 *   3. the declared plate must match a plate that exists  (Phase 6)
 *
 * (1) was enforced in the picker UI only, and only from 2026-08-16 — the Excel
 * import never checked it at all, so a 16 mm part could be attached to 40 mm
 * plate and nothing objected right through to the shop floor. (2) was checked
 * nowhere whatsoever: a 3000 mm part could be declared as cut from a 2000 mm
 * plate and the first anybody knew was a cutter looking at it.
 *
 * WHY THIS REPORTS RATHER THAN THROWS. Every issue here is a data problem on an
 * order that already exists, often one somebody is mid-way through. A hard
 * refusal at save time would block the edit that FIXES it. So the service
 * answers "what is wrong with this order", and the callers decide: the readiness
 * stage refuses to go green, and raising procurement refuses with the list. The
 * plan's rule 4 — enforcement runs report-only against production first.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It is not a nesting algorithm. Whether
 * eleven specific parts can actually be laid out on one plate is 2D bin packing,
 * and the shop does that in real nesting software for good reasons. This checks
 * only what can be checked with certainty: a part bigger than its plate in any
 * orientation cannot be cut from it, and parts whose total area exceeds the
 * plate's cannot all come off it. Both are impossibilities, not opinions —
 * anything short of that is left to the people with the real tool.
 */

import { pool } from '../../../db.js';
import { resolveItemFields } from './itemFieldService.js';

/** Issue kinds, so callers can group and the UI can phrase them. */
export const ISSUE = {
  MISSING_PART_DIMS: 'missing_part_dimensions',
  MISSING_PLATE_DIMS: 'missing_plate_dimensions',
  THICKNESS_MISMATCH: 'thickness_mismatch',
  PART_TOO_BIG: 'part_too_big',
  PLATE_OVERFILLED: 'plate_overfilled',
  NO_MATERIAL: 'no_material',
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Two dimensions "fit" if the part sits inside the plate in EITHER orientation.
 *
 * Rotation is allowed because a plate is not directional for cutting — refusing
 * a 2000x800 part on a 1000x2500 plate would be arithmetically tidy and wrong
 * on the floor.
 */
const fitsWithin = (pl, pw, PL, PW, tol) =>
  (pl <= PL + tol && pw <= PW + tol) || (pl <= PW + tol && pw <= PL + tol);

/**
 * Everything wrong with one order's nesting.
 *
 * @returns {Promise<{ok:boolean, checked:number, issues:object[], summary:object}>}
 */
export async function checkOrderNesting(companyId, orderId, opts = {}) {
  const exec = opts.conn ?? pool;
  // Millimetres of slack allowed before a part counts as too big. A drawing
  // rounded to the millimetre against a plate quoted in round numbers should
  // not raise an issue nobody can act on.
  const tol = opts.toleranceMm ?? 1;

  // Every raw-material link with the part above it. This is the same shape
  // nestingBoardService reads: a link is a childless row carrying a catalog
  // item and no flow, and its length/width/height are the PLATE's.
  const [links] = await exec.query(
    `SELECT rm.id AS linkId, rm.nest_no AS nestNo, rm.qty AS plates,
            rm.length AS plateLength, rm.width AS plateWidth, rm.height AS plateThick,
            rm.catalog_item_id AS materialId,
            fic.code AS materialCode, fic.name AS materialName,
            fic.thickness_mm AS materialThickness,
            p.id AS partId, p.code AS partCode, p.name AS partName, p.qty AS partQty
       FROM fab_items rm
       JOIN fab_items p ON p.id = rm.parent_item_id AND p.deleted_at IS NULL
       JOIN fab_item_catalog fic ON fic.id = rm.catalog_item_id AND fic.deleted_at IS NULL
      WHERE rm.company_id = ? AND rm.order_id = ? AND rm.deleted_at IS NULL
        AND rm.catalog_item_id IS NOT NULL AND rm.flow_id IS NULL
      ORDER BY fic.code, rm.nest_no, p.code`,
    [companyId, orderId],
  );

  /**
   * LEAF parts that get made but are cut from nothing.
   *
   * "Has a flow and no material" is NOT the test, and using it produced a false
   * positive on the first production run: a girder segment carries the assembly
   * flow and legitimately has no raw material, because it is welded from the
   * three parts beneath it rather than cut from plate. Requiring material of an
   * assembly would have blocked two live orders for doing nothing wrong.
   *
   * The real test is childlessness. A part with no children of its own has to
   * come from somewhere physical; an item with children comes from them.
   */
  const [orphans] = await exec.query(
    `SELECT p.id, p.code, p.name FROM fab_items p
      WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL
        AND p.flow_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fab_items k
                         WHERE k.parent_item_id = p.id AND k.deleted_at IS NULL)`,
    [companyId, orderId],
  );

  const issues = [];
  const add = (type, o) => issues.push({ type, ...o });

  for (const o of orphans) {
    add(ISSUE.NO_MATERIAL, {
      partId: o.id, partCode: o.code, partName: o.name,
      message: `${o.name} has no material — it cannot be cut from anything, bought, or costed.`,
    });
  }

  if (!links.length) {
    return {
      ok: issues.length === 0, checked: 0, issues,
      summary: summarise(issues),
    };
  }

  // The part's OWN dimensions come from the field resolver, not from its
  // columns — after Phase 3 that is the one place that knows where a value
  // lives, and reading columns here would reintroduce the split this whole
  // effort exists to remove.
  const partIds = [...new Set(links.map((l) => l.partId))];
  const partFields = await resolveItemFields(companyId, partIds, { conn: exec });

  // Area consumed per (material, nest), to catch a plate asked to yield more
  // than it physically contains.
  const nests = new Map();

  for (const l of links) {
    const f = partFields.get(l.partId) ?? {};
    const partL = num(f.length_mm);
    const partW = num(f.width_mm);
    const partT = num(f.thickness_mm);
    const plateL = num(l.plateLength);
    const plateW = num(l.plateWidth);
    const plateT = num(l.plateThick) ?? num(l.materialThickness);
    const matT = num(l.materialThickness);

    const where = { partId: l.partId, partCode: l.partCode, partName: l.partName,
      materialCode: l.materialCode, nestNo: l.nestNo, linkId: l.linkId };

    if (partL == null || partW == null) {
      add(ISSUE.MISSING_PART_DIMS, {
        ...where,
        message: `${l.partName} has no ${partL == null ? 'length' : 'width'} — it cannot be nested, `
               + 'and procurement would be sizing a plate for a part of unknown size.',
      });
    }

    // Thickness: the part must be the same thickness as the stuff it is cut
    // from. Compared against the CATALOG item, because that is what the
    // material IS — a "MS Plate 20mm" is 20 mm whatever a nest row says.
    if (partT != null && matT != null && Math.abs(partT - matT) > 0.001) {
      add(ISSUE.THICKNESS_MISMATCH, {
        ...where, partThickness: partT, materialThickness: matT,
        message: `${l.partName} is ${partT} mm but ${l.materialCode} is ${matT} mm. `
               + 'A part cannot be cut from material of a different thickness.',
      });
    }

    if (plateL == null || plateW == null) {
      /**
       * SAY WHICH OF THE TWO STATES THIS IS.
       *
       * This fires for every link without dimensions, nested or not, and the
       * old sentence described both as "the plate has no size". For a part
       * that simply has not been laid onto a plate yet, that reads as a data
       * fault when the honest answer is "not nested yet" — and since a fresh
       * order has every part in that state, it produced one alarming line per
       * part on an order where nothing was actually wrong.
       *
       * Both remain BLOCKING: you cannot cost or cut a plate of unknown size
       * either way. Only the explanation changes, and with it whether the
       * reader knows what to do next.
       */
      add(ISSUE.MISSING_PLATE_DIMS, {
        ...where,
        message: l.nestNo
          ? `The plate for ${l.partName} (${l.materialCode}, nest ${l.nestNo}) has no size, `
            + 'so nothing can check the part fits or buy the right plate.'
          : `${l.partName} is not on a nest yet, and no sized stock of ${l.materialCode} `
            + 'is on hand to assume a plate size from — so nothing can check it fits '
            + 'or buy the right plate.',
      });
    } else if (partL != null && partW != null && !fitsWithin(partL, partW, plateL, plateW, tol)) {
      add(ISSUE.PART_TOO_BIG, {
        ...where, partSize: `${partL}×${partW}`, plateSize: `${plateL}×${plateW}`,
        message: `${l.partName} is ${partL}×${partW} mm but its plate is only ${plateL}×${plateW} mm. `
               + 'It does not fit in either orientation.',
      });
    }

    // Aggregate area, per physical plate.
    if (l.nestNo && plateL != null && plateW != null && partL != null && partW != null) {
      const key = `${l.materialId}|${l.nestNo}`;
      if (!nests.has(key)) {
        nests.set(key, {
          materialCode: l.materialCode, nestNo: l.nestNo,
          plateArea: plateL * plateW * Math.max(1, num(l.plates) ?? 1),
          usedArea: 0, parts: 0, plateSize: `${plateL}×${plateW}`,
          plates: Math.max(1, num(l.plates) ?? 1),
        });
      }
      const n = nests.get(key);
      n.usedArea += partL * partW * Math.max(1, num(l.partQty) ?? 1);
      n.parts += 1;
    }

    void plateT; // read for clarity above; the mismatch check uses the catalog
  }

  for (const n of nests.values()) {
    if (n.usedArea > n.plateArea) {
      add(ISSUE.PLATE_OVERFILLED, {
        nestNo: n.nestNo, materialCode: n.materialCode,
        usedAreaMm2: Math.round(n.usedArea), plateAreaMm2: Math.round(n.plateArea),
        message: `Nest ${n.nestNo} on ${n.materialCode} asks for ${Math.round(n.usedArea / 1e6)} m² of part `
               + `from ${Math.round(n.plateArea / 1e6)} m² of plate (${n.plates} × ${n.plateSize}). `
               + 'That is more than the plate contains, before any offcut.',
      });
    }
  }

  return { ok: issues.length === 0, checked: links.length, issues, summary: summarise(issues) };
}

function summarise(issues) {
  const s = {};
  for (const i of issues) s[i.type] = (s[i.type] ?? 0) + 1;
  return s;
}

/**
 * The issues that must block, as opposed to those worth showing.
 *
 * A missing dimension and an impossible one are different: the first means
 * nobody has finished the job yet, the second means somebody finished it wrong.
 * Both block procurement — buying a plate for a part of unknown size is exactly
 * as useless as buying one that cannot hold it.
 */
export const BLOCKING = new Set([
  ISSUE.MISSING_PART_DIMS,
  ISSUE.MISSING_PLATE_DIMS,
  ISSUE.THICKNESS_MISMATCH,
  ISSUE.PART_TOO_BIG,
  ISSUE.PLATE_OVERFILLED,
  ISSUE.NO_MATERIAL,
]);

export const blockingIssues = (result) =>
  (result?.issues ?? []).filter((i) => BLOCKING.has(i.type));
