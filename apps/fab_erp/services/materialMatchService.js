/**
 * materialMatchService.js — may this part be cut from this plate?
 *
 * THREE AXES must agree before a part may sit on a plate: THICKNESS, GRADE and
 * MATERIAL. Until 2026-08-21 only thickness was expressible, so only thickness
 * could be checked, and the other two were enforced by whoever happened to be
 * looking at the sheet.
 *
 *   thickness  a part cannot be cut from steel of a different thickness. This
 *              one is arithmetic and was always checkable.
 *   grade      E350 and E250 are different steels. The quality suffix is worse
 *              still: BR is a room-temperature impact test and B0 is at 0 °C, so
 *              substituting one is a structural decision, not a stores decision.
 *   material   the case this exists for. A stainless part nested onto mild steel
 *              cuts, welds, passes the shop, and then corrodes in service or
 *              fails inspection. Nothing in the system could have refused it.
 *
 * WHY THIS FILE EXISTS RATHER THAN THE RULE LIVING IN EACH CALLER. There are
 * three ways a part gets onto a plate — the suggestor proposes, the board is
 * dragged, and the integrity check audits what is already there. If the rule is
 * written three times it will be three rules within a month, and the failure
 * mode is the quiet one: the suggestor refuses what a drag-and-drop still
 * allows. One comparison, imported by all three.
 *
 * THE ASYMMETRY OF UNKNOWNS, which is deliberate and is the only subtle part:
 *
 *   unknown on the PART, when CHOOSING a plate -> narrows to nothing, and is
 *       reported. Picking a grade for a part that does not state one is a
 *       metallurgical decision and a packer must not make it silently. That
 *       rule lives in the suggestor, which is the only caller that chooses.
 *
 *   unknown on either side, when CHECKING an existing pairing -> not a
 *       conflict. This runs over orders built long before material was
 *       expressible. If every one of those became an error, the real
 *       contradictions would be buried in thousands of unknowns and nobody
 *       would read the list.
 *
 * So `axisConflict` answers only the narrow question — do these two DISAGREE —
 * and says nothing about whether silence is acceptable. Each caller decides.
 */

import { pool } from '../../../db.js';
import { resolveFields } from './fieldService.js';

/** How each axis is named to a person, and why a mismatch is refused. */
export const AXES = {
  thickness: {
    label: 'thickness',
    unit: ' mm',
    why: 'A part cannot be cut from material of a different thickness.',
  },
  grade: {
    label: 'grade',
    unit: '',
    why: 'Grades are not interchangeable — the quality suffix is an impact-test class.',
  },
  material: {
    label: 'material',
    unit: '',
    why: 'It would cut and weld, and then fail inspection or corrode in service.',
  },
};

/** Thicknesses within this are the same plate; below it is float noise. */
const THICKNESS_TOLERANCE_MM = 0.001;

/**
 * Every axis on which a part and a plate genuinely DISAGREE.
 *
 * Thickness is listed first because it is the one a person can see, and an
 * unknown on either side is absent from the result — silence is not agreement,
 * but it is not a contradiction either. See the header for why that asymmetry
 * matters more than it looks.
 *
 * @param {{thickness?:number|null, grade?:string|null, material?:string|null}} part
 * @param {{thickness?:number|null, grade?:string|null, material?:string|null}} plate
 * @returns {Array<{axis:string, partValue:*, plateValue:*}>}
 */
export function axisConflicts(part, plate) {
  const out = [];
  const pt = part?.thickness;
  const mt = plate?.thickness;
  if (pt != null && mt != null && Math.abs(pt - mt) > THICKNESS_TOLERANCE_MM) {
    out.push({ axis: 'thickness', partValue: pt, plateValue: mt });
  }
  for (const axis of ['grade', 'material']) {
    const a = part?.[axis];
    const b = plate?.[axis];
    if (a && b && a !== b) out.push({ axis, partValue: a, plateValue: b });
  }
  return out;
}

/** The first disagreement, for a caller that refuses on any one of them. */
export function axisConflict(part, plate) {
  return axisConflicts(part, plate)[0] ?? null;
}

/**
 * Would this plate do for this part, when CHOOSING one?
 *
 * Stricter than `axisConflicts` in exactly one direction: thickness must be
 * KNOWN and equal, because a plate of unrecorded thickness is not a candidate
 * for anything. Grade and material tolerate an unknown on the PLATE — a
 * catalogue that has not recorded a material yet should not be silently emptied
 * of every candidate — but not on the part, which is the caller's job to check
 * before it gets here.
 */
export function plateFits(part, plate) {
  if (plate?.thickness == null || part?.thickness == null) return false;
  if (Math.abs(plate.thickness - part.thickness) > THICKNESS_TOLERANCE_MM) return false;
  return axisConflicts(part, plate).length === 0;
}

/** A sentence a person can act on, for one conflict. */
export function conflictMessage(conflict, { partName, plateName }) {
  const { axis, partValue, plateValue } = conflict;
  const u = AXES[axis]?.unit ?? '';
  const why = AXES[axis]?.why ?? '';
  return `${partName} is ${partValue}${u} but ${plateName} is ${plateValue}${u}. ${why}`;
}

/**
 * The three axes for each part, resolved UP THE LADDER.
 *
 * An order states material and grade on its LINE, and a part that differs
 * overrides it — so a part's answer is usually not stored on the part at all.
 * Walking that is what `resolveFields` is for.
 *
 * A SECOND RESOLVER CALL IS NEEDED and it is not an oversight: `resolveItemFields`
 * is NUMBERS ONLY by documented contract because it feeds the formula engine, so
 * `grade` and `material` are simply not in what it returns. Reading `f.grade` off
 * it yields undefined and every part then looks unspecified.
 *
 * @returns {Promise<Map<number, {thickness:number|null, grade:string|null, material:string|null}>>}
 */
export async function partAxes(companyId, partIds, opts = {}) {
  const exec = opts.conn ?? pool;
  const ids = [...new Set((partIds ?? []).map(Number).filter(Number.isFinite))];
  const out = new Map();
  if (!ids.length) return out;

  const resolved = await resolveFields(
    companyId, ids.map((id) => ({ scope: 'order_item', scopeId: id })), { conn: exec },
  );
  for (const id of ids) {
    const f = resolved.get(`order_item:${id}`) ?? {};
    out.set(id, {
      thickness: numOrNull(f.thickness_mm?.value),
      grade: f.grade?.value ?? null,
      material: f.material?.value ?? null,
    });
  }
  return out;
}

/**
 * The three axes for each candidate plate, from its CATALOG item.
 *
 * Thickness falls back to `fab_item_catalog.thickness_mm`. That column is a
 * PROJECTION of the field and never a second source of truth, so the field wins
 * where both exist — but plenty of catalog rows predate the field and the column
 * is all they have.
 *
 * @returns {Promise<Map<number, {id:number, code:string, name:string,
 *   thickness:number|null, grade:string|null, material:string|null}>>}
 */
export async function plateAxes(companyId, catalogItemIds, opts = {}) {
  const exec = opts.conn ?? pool;
  const ids = [...new Set((catalogItemIds ?? []).map(Number).filter(Number.isFinite))];
  const out = new Map();
  if (!ids.length) return out;

  const [rows] = await exec.query(
    `SELECT id, code, name, thickness_mm AS thicknessMm FROM fab_item_catalog
      WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
    [companyId, ids],
  );
  if (!rows.length) return out;

  const resolved = await resolveFields(
    companyId, rows.map((r) => ({ scope: 'catalog_item', scopeId: r.id })), { conn: exec },
  );
  for (const r of rows) {
    const f = resolved.get(`catalog_item:${r.id}`) ?? {};
    out.set(Number(r.id), {
      id: Number(r.id),
      code: r.code,
      name: r.name,
      thickness: numOrNull(f.thickness_mm?.value) ?? numOrNull(r.thicknessMm),
      grade: f.grade?.value ?? null,
      material: f.material?.value ?? null,
    });
  }
  return out;
}

/**
 * The weight factors a part's SPECIFICATION implies, without choosing a plate.
 *
 * WHY THIS IS NEEDED AT ALL. A part's weight is volume × density, and density
 * used to be read off the plate the part was linked to. That worked only because
 * a part was linked to a plate from the moment the BOM was imported. Now the
 * plate is chosen at nesting, so between import and nesting there is no link —
 * and reading density through it would make every un-nested part weigh nothing.
 * A 668 MT order would report as zero until somebody nested it, and procurement
 * quantities and progress percentages are computed off that number.
 *
 * WHY LOOKING IT UP IS CORRECT RATHER THAN A WORKAROUND. Density is a property
 * of the MATERIAL, not of the piece: every MS plate is 7850 kg/m³ whether it is
 * 2000 or 2500 wide. So the answer does not depend on the decision that has not
 * been made yet, and there is nothing to store twice — it is read from the same
 * catalogue the nesting will pick from.
 *
 * `section_area_mm2` comes along because for anything that is not flat — an
 * angle, a channel, a beam — thickness × width is not the cross-section, and
 * using it is 47% light on an angle and 83% on a channel.
 *
 * MATCHING FALLS BACK deliberately, because refusing to weigh a part over a
 * missing grade would be worse than weighing it with the density of the same
 * steel in a different grade — which is the same number. Order of preference:
 *   material + grade + thickness  ->  material + thickness  ->  material
 *   ->  thickness alone
 * A tie takes the commonest density among the matches, not the first row, so one
 * mis-keyed catalogue entry cannot swing an order's tonnage.
 *
 * @returns {Promise<Map<number, {density:number|null, sectionArea:number|null}>>}
 */
export async function weightFactorsForParts(companyId, partIds, opts = {}) {
  const exec = opts.conn ?? pool;
  const out = new Map();
  const specs = opts.specs ?? await partAxes(companyId, partIds, { conn: exec });
  if (!specs.size) return out;

  const [rows] = await exec.query(
    `SELECT ic.id, ic.thickness_mm AS thickness, ic.density_kg_m3 AS density,
            ic.section_area_mm2 AS sectionArea
       FROM fab_item_catalog ic
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL
        AND ic.density_kg_m3 IS NOT NULL`,
    [companyId],
  );
  if (!rows.length) return out;

  const resolved = await resolveFields(
    companyId, rows.map((r) => ({ scope: 'catalog_item', scopeId: r.id })), { conn: exec },
  );
  const candidates = rows.map((r) => {
    const f = resolved.get(`catalog_item:${r.id}`) ?? {};
    return {
      thickness: numOrNull(f.thickness_mm?.value) ?? numOrNull(r.thickness),
      grade: f.grade?.value ?? null,
      material: f.material?.value ?? null,
      density: numOrNull(f.density_kg_m3?.value) ?? numOrNull(r.density),
      sectionArea: numOrNull(f.section_area_mm2?.value) ?? numOrNull(r.sectionArea),
    };
  }).filter((c) => c.density != null);

  const sameT = (a, b) => a != null && b != null && Math.abs(a - b) <= THICKNESS_TOLERANCE_MM;
  /** The commonest density among a set, so one bad row cannot swing a tonnage. */
  const consensus = (set) => {
    if (!set.length) return null;
    const tally = new Map();
    for (const c of set) tally.set(c.density, (tally.get(c.density) ?? 0) + 1);
    let best = null; let bestN = -1;
    for (const [d, n] of tally) if (n > bestN) { best = d; bestN = n; }
    // Section area only means anything for the rows that agreed on the density,
    // and only when they agree on it too — mixing an angle's and a plate's
    // would be worse than having none.
    const areas = new Set(set.filter((c) => c.density === best).map((c) => c.sectionArea));
    return { density: best, sectionArea: areas.size === 1 ? [...areas][0] : null };
  };

  for (const [partId, spec] of specs) {
    const tiers = [
      (c) => spec.material && spec.grade && c.material === spec.material
             && c.grade === spec.grade && sameT(c.thickness, spec.thickness),
      (c) => spec.material && c.material === spec.material && sameT(c.thickness, spec.thickness),
      (c) => spec.material && c.material === spec.material,
      (c) => sameT(c.thickness, spec.thickness),
    ];
    let picked = null;
    for (const t of tiers) {
      picked = consensus(candidates.filter(t));
      if (picked) break;
    }
    if (picked) out.set(partId, picked);
  }
  return out;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
