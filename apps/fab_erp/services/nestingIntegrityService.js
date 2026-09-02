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

import {
  axisConflicts, conflictMessage, partAxes, plateAxes,
} from './materialMatchService.js';

/** Issue kinds, so callers can group and the UI can phrase them. */
export const ISSUE = {
  MISSING_PART_DIMS: 'missing_part_dimensions',
  MISSING_PLATE_DIMS: 'missing_plate_dimensions',
  /**
   * The part has material but has not been laid onto a plate yet.
   *
   * Split out of MISSING_PLATE_DIMS, which was reporting two different
   * situations under one name and one severity. "Nobody has nested this yet"
   * is the NORMAL state of a fresh order — every part is in it the moment the
   * material is picked — and it is not a reason to refuse a purchase order,
   * because buying to a cutting list and nesting afterwards is how the shop
   * actually works. MISSING_PLATE_DIMS now means only what its name says:
   * a plate somebody HAS committed a part to, whose size is unknown.
   */
  NOT_NESTED_YET: 'not_nested_yet',
  THICKNESS_MISMATCH: 'thickness_mismatch',
  /**
   * The part and the plate disagree on WHAT THE STEEL IS.
   *
   * Separate kinds from THICKNESS_MISMATCH because the remedies differ: a
   * thickness mismatch is usually a nesting slip, while a grade or material
   * mismatch is a specification error and the part may be unbuildable from
   * anything the yard holds. A stainless part on mild steel plate cuts, welds,
   * and then fails inspection or corrodes in service — which is why this is
   * blocking rather than advisory.
   */
  GRADE_MISMATCH: 'grade_mismatch',
  MATERIAL_MISMATCH: 'material_mismatch',
  PART_TOO_BIG: 'part_too_big',
  PLATE_OVERFILLED: 'plate_overfilled',
  NO_MATERIAL: 'no_material',
};

/** Which issue kind each axis of a mismatch is reported as. */
const AXIS_ISSUE = {
  thickness: ISSUE.THICKNESS_MISMATCH,
  grade: ISSUE.GRADE_MISMATCH,
  material: ISSUE.MATERIAL_MISMATCH,
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
        AND rm.node_kind = 'material'
        -- Only MADE leaves are nesting's business. A part that is BOUGHT whole —
        -- a stud, a bolt, a bearing — is not cut from anything, so asking which
        -- plate it comes off is the wrong question; procurement matches it to
        -- stock or raises an order for it instead.
        AND COALESCE(p.procurement_type, 'make') = 'make'
      ORDER BY fic.code, rm.nest_no, p.code`,
    [companyId, orderId],
  );

  /**
   * LEAF parts that get MADE but say nothing about what they are made of.
   *
   * WHAT THIS NOW ASKS, and it is a different question from before. It used to
   * be "has this part got a material LINK", which was answerable at BOM time
   * because the sheet named a catalogue item on every row. It is not answerable
   * any more and must not be asked: the link is created at NESTING, so between
   * import and nesting every part in the order would be reported as cut from
   * nothing. That is the normal state of a fresh order, not a fault.
   *
   * The question that survives is whether the part states a SPECIFICATION —
   * thickness, and a material — because that is what somebody has to supply and
   * what nesting needs in order to choose anything at all. A part with a spec
   * and no plate yet is simply not nested; a part with no spec cannot be nested,
   * bought, or weighed, and that is worth reporting.
   *
   * TWO EXCLUSIONS, both learned from false positives:
   *
   *   children     an item with children comes from them. A girder segment
   *                carries the assembly flow and legitimately has no raw
   *                material — it is welded from the three parts beneath it.
   *                Requiring material of an assembly blocked two live orders.
   *
   *   'buy' parts  a shear stud is not cut from anything. It is bought whole,
   *                matched to stock or ordered at the procurement step, and
   *                nesting has no business with it. Asking a stud for a grade of
   *                plate is asking the wrong question of the wrong thing.
   */
  const [orphans] = await exec.query(
    `SELECT p.id, p.code, p.name FROM fab_items p
      WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL
        AND p.flow_id IS NOT NULL
        AND COALESCE(p.procurement_type, 'make') = 'make'
        AND NOT EXISTS (SELECT 1 FROM fab_items k
                         WHERE k.parent_item_id = p.id AND k.deleted_at IS NULL)`,
    [companyId, orderId],
  );

  const issues = [];
  const add = (type, o) => issues.push({ type, ...o });

  if (orphans.length) {
    const spec = await partAxes(companyId, orphans.map((o) => o.id), { conn: exec });
    for (const o of orphans) {
      const s = spec.get(o.id) ?? {};
      const missing = [
        s.thickness == null ? 'thickness' : null,
        !s.material ? 'material' : null,
      ].filter(Boolean);
      if (!missing.length) continue;
      add(ISSUE.NO_MATERIAL, {
        partId: o.id, partCode: o.code, partName: o.name, missing,
        message: `${o.name} has no ${missing.join(' or ')} — nesting cannot choose a plate for it, `
               + 'and it cannot be bought or costed.',
      });
    }
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

  /**
   * Grade and material for both sides, read through the shared matcher so this
   * audit compares exactly what the suggestor and the board compare.
   *
   * Sequential and NOT Promise.all: `exec` may be a single caller-supplied
   * connection, and mysql2 cannot multiplex two queries on one — it waits on the
   * socket forever rather than erroring, which is a hang and not a failure.
   */
  const materialIds = [...new Set(links.map((l) => l.materialId).filter(Boolean))];
  const partSpec = await partAxes(companyId, partIds, { conn: exec });
  const plateSpec = await plateAxes(companyId, materialIds, { conn: exec });

  // Area consumed per (material, nest), to catch a plate asked to yield more
  // than it physically contains.
  const nests = new Map();

  for (const l of links) {
    const f = partFields.get(l.partId) ?? {};
    const partL = num(f.length_mm);
    const partW = num(f.width_mm);
    const partT = num(f.thickness_mm);
    const partGrade = partSpec.get(l.partId)?.grade ?? null;
    const partMaterial = partSpec.get(l.partId)?.material ?? null;
    const plateGrade = plateSpec.get(Number(l.materialId))?.grade ?? null;
    const plateMaterial = plateSpec.get(Number(l.materialId))?.material ?? null;
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

    /**
     * ALL THREE AXES, from the one comparison the suggestor and the board also
     * use. Thickness is compared against the CATALOG item, because that is what
     * the material IS — a "MS Plate 20mm" is 20 mm whatever a nest row says —
     * and grade and material come from the plate's own resolved fields rather
     * than being inferred from its name.
     *
     * The part's side is resolved up the ladder: its order line states the
     * material and grade, and the part overrides only where it differs.
     *
     * An unknown on either side is not a conflict here. This runs over orders
     * built long before material was expressible, and reporting every one of
     * them as uncuttable would bury the real contradictions.
     */
    for (const c of axisConflicts(
      { thickness: partT, grade: partGrade, material: partMaterial },
      { thickness: matT, grade: plateGrade, material: plateMaterial },
    )) {
      add(AXIS_ISSUE[c.axis], {
        ...where,
        axis: c.axis,
        partValue: c.partValue,
        plateValue: c.plateValue,
        // Kept for callers written against the older shape, which named the
        // thickness pair specifically.
        ...(c.axis === 'thickness'
          ? { partThickness: c.partValue, materialThickness: c.plateValue } : {}),
        message: conflictMessage(c, { partName: l.partName, plateName: l.materialCode }),
      });
    }

    if (plateL == null || plateW == null) {
      /**
       * TWO DIFFERENT STATES, TWO DIFFERENT TYPES, TWO DIFFERENT SEVERITIES.
       *
       * A link with no plate size is one of two things, and until now both were
       * reported as MISSING_PLATE_DIMS and both blocked:
       *
       *   nest_no set    — somebody HAS committed this part to a specific plate
       *                    and that plate's size is unknown. Nobody can cut it,
       *                    cost it, or check the part fits on it. A real fault
       *                    on work already done. BLOCKING.
       *
       *   nest_no null   — the part simply has not been laid onto a plate yet,
       *                    and no sized stock of the material existed for
       *                    itemMaterialService.plateDimsForMaterial() to assume
       *                    a size from. This is the ordinary state of a fresh
       *                    order: every part is in it from the moment material
       *                    is picked until somebody nests. WARNING.
       *
       * Blocking the second one had a concrete cost in production: on a fresh
       * 28-part order Procurement refused to raise a PO and needed an explicit
       * "Order anyway", and Production refused too — for an order that was
       * simply at the stage it was supposed to be at. Shops buy plate to a
       * cutting list and nest afterwards; the gate was refusing normal practice.
       *
       * The split is a distinct TYPE rather than a flag on MISSING_PLATE_DIMS
       * so callers can branch on `i.type` and never have to read the sentence
       * to work out how serious it is. Nothing is suppressed: the issue is
       * still reported, still counted in `summary`, still makes `ok` false —
       * it changes severity, it does not vanish.
       */
      if (l.nestNo) {
        add(ISSUE.MISSING_PLATE_DIMS, {
          ...where, nested: true,
          message: `The plate for ${l.partName} (${l.materialCode}, nest ${l.nestNo}) has no size, `
                 + 'so nothing can check the part fits or buy the right plate.',
        });
      } else {
        add(ISSUE.NOT_NESTED_YET, {
          ...where, nested: false,
          message: `${l.partName} is not on a nest yet, and no sized stock of ${l.materialCode} `
                 + 'is on hand to assume a plate size from — so nothing can check it fits. '
                 + 'Ordinary before nesting: the cutting list can still be bought to.',
        });
      }
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
 * Both still block — buying a plate for a part of unknown size is exactly as
 * useless as buying one that cannot hold it.
 *
 * NOT_NESTED_YET is the one exception, and it is deliberately outside this set.
 * It is not an unfinished job in the sense the paragraph above means; it is the
 * job at the stage it is meant to be at. Every part on a fresh order is "not
 * nested yet" the instant its material is picked, and refusing to buy at that
 * point refuses the normal sequence of work — you order to a cutting list, then
 * nest. It is still reported, so no screen goes quiet about it; it just does
 * not stop a purchase order.
 *
 * Nothing here is loosened for the impossibilities. THICKNESS_MISMATCH and
 * PART_TOO_BIG describe parts that cannot come off the material at all, and
 * they must keep refusing: an order that is genuinely uncuttable is exactly
 * what these gates exist for.
 */
export const BLOCKING = new Set([
  ISSUE.MISSING_PART_DIMS,
  ISSUE.MISSING_PLATE_DIMS,
  ISSUE.THICKNESS_MISMATCH,
  ISSUE.GRADE_MISMATCH,
  ISSUE.MATERIAL_MISMATCH,
  ISSUE.PART_TOO_BIG,
  ISSUE.PLATE_OVERFILLED,
  ISSUE.NO_MATERIAL,
]);

/**
 * Reported, not refused. Kept as its own named set rather than "everything not
 * in BLOCKING" so a caller that wants to show these — the readiness strip has
 * to, or an order with nothing nested reads as green — can ask for them by
 * name and cannot accidentally scoop up a future blocking type.
 */
export const ADVISORY = new Set([
  ISSUE.NOT_NESTED_YET,
]);

export const blockingIssues = (result) =>
  (result?.issues ?? []).filter((i) => BLOCKING.has(i.type));

/** The issues worth saying out loud that are not grounds for a refusal. */
export const advisoryIssues = (result) =>
  (result?.issues ?? []).filter((i) => ADVISORY.has(i.type));
