/**
 * templateCopyService.js — "Copy" on a line of a template's BOM.
 *
 * Decided with the product owner 2026-09-18: copying a line gives a NEW PART,
 * ready to change — not a second line naming the same part. A second line of
 * the same part is indistinguishable on screen and means nothing a quantity
 * does not already say, so Copy looked like it did nothing.
 *
 *   copying "Top Flange" under Segment
 *     → a new template part "Top Flange (copy)" — same category/group/sub-group,
 *       unit, short code and its own field values
 *     → if it is an ASSEMBLY, the new part contains the same lines the original
 *       does (the parts beneath are shared, not copied again)
 *     → a new line right below the original, carrying the same quantity,
 *       question, flow, code segment, explode/code-join, pick filter and sizes
 *
 * A CATALOG child (a stud, a stocked stiffener) is not minted again — it is a
 * real item, not a design. Its line is copied as a second line of the same
 * item, which the person can then point at another.
 */
import { pool } from '../../../db.js';
import { generateCode } from './codegenService.js';

/** "Top Flange (copy)", or "(copy 2)", "(copy 3)"… — names are unique per company among live rows. */
async function freeCopyName(conn, companyId, name) {
  const base = `${name} (copy`;
  const [rows] = await conn.query(
    'SELECT name FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL AND name LIKE ?',
    [companyId, `${base}%`],
  );
  const taken = new Set(rows.map((r) => r.name));
  if (!taken.has(`${name} (copy)`)) return `${name} (copy)`;
  for (let n = 2; n < 1000; n += 1) if (!taken.has(`${name} (copy ${n})`)) return `${name} (copy ${n})`;
  return `${name} (copy ${Date.now()})`;
}

/** Copy every live field value of one scope row onto another. New ids, so nothing to collide with. */
async function copyFieldValues(conn, companyId, scope, fromId, toId) {
  await conn.query(
    `INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_num, value_text, value_date, unit_code)
     SELECT company_id, field_id, scope, ?, value_num, value_text, value_date, unit_code
       FROM fab_field_values
      WHERE company_id = ? AND scope = ? AND scope_id = ? AND deleted_at IS NULL`,
    [toId, companyId, scope, fromId],
  );
}

const LINE_COLS = [
  'qty_num', 'qty_param', 'default_qty', 'per_instance_qty', 'code_segment', 'help_text', 'active', 'notes',
  'default_flow_id', 'code_join', 'explode',
  'pick_category_id', 'pick_group_id', 'pick_subgroup_id', 'pick_default_item_id',
];

/**
 * @returns {Promise<{lineId:number, itemId:number, name:string, newPart:boolean}>}
 */
export async function copyBomLine(companyId, lineId, { conn: outer = null } = {}) {
  const conn = outer ?? await pool.getConnection();
  const owned = !outer;
  try {
    if (owned) await conn.beginTransaction();
    const [[line]] = await conn.query(
      'SELECT * FROM fab_item_bom WHERE id = ? AND company_id = ? AND deleted_at IS NULL FOR UPDATE',
      [lineId, companyId],
    );
    if (!line) { const e = new Error('That line does not exist.'); e.status = 404; throw e; }
    const [[child]] = await conn.query(
      'SELECT * FROM fab_item_catalog WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
      [line.child_item_id, companyId],
    );
    if (!child) { const e = new Error('The part on that line no longer exists.'); e.status = 404; throw e; }

    // ── the part: a new one for a template part, the same one for a catalog item
    let childId = Number(child.id);
    let name = child.name;
    const newPart = Number(child.is_cataloged) === 0;
    if (newPart) {
      name = await freeCopyName(conn, companyId, child.name);
      const code = (await generateCode(companyId, 'item', { categoryId: child.category_id }, conn)).toUpperCase();
      const [ins] = await conn.query(
        `INSERT INTO fab_item_catalog
           (company_id, name, code, short_code, unit, description, category_id, group_id, subgroup_id,
            hsn_code, procurement_type, lead_time_days, mrp_policy, thickness_mm, material_form,
            density_kg_m3, section_area_mm2, is_cataloged)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        [companyId, name, code, child.short_code, child.unit,
          child.description, child.category_id, child.group_id, child.subgroup_id,
          child.hsn_code, child.procurement_type || 'make', child.lead_time_days, child.mrp_policy,
          child.thickness_mm, child.material_form, child.density_kg_m3, child.section_area_mm2],
      );
      childId = Number(ins.insertId);
      await copyFieldValues(conn, companyId, 'catalog_item', child.id, childId);

      // An assembly's copy contains what the original contains (shared parts).
      const [subLines] = await conn.query(
        'SELECT * FROM fab_item_bom WHERE company_id = ? AND parent_item_id = ? AND deleted_at IS NULL ORDER BY sort_order, id',
        [companyId, child.id],
      );
      for (const s of subLines) {
        const [r] = await conn.query(
          `INSERT INTO fab_item_bom (company_id, parent_item_id, child_item_id, sort_order, ${LINE_COLS.join(', ')})
           VALUES (?, ?, ?, ?, ${LINE_COLS.map(() => '?').join(', ')})`,
          [companyId, childId, s.child_item_id, s.sort_order, ...LINE_COLS.map((c) => s[c])],
        );
        await copyFieldValues(conn, companyId, 'bom_line', s.id, r.insertId);
      }
    }

    // ── the line, right below the original
    const at = Number(line.sort_order ?? 0) + 1;
    await conn.query(
      `UPDATE fab_item_bom SET sort_order = sort_order + 1
        WHERE company_id = ? AND parent_item_id = ? AND deleted_at IS NULL AND sort_order >= ? AND id <> ?`,
      [companyId, line.parent_item_id, at, line.id],
    );
    const [r] = await conn.query(
      `INSERT INTO fab_item_bom (company_id, parent_item_id, child_item_id, sort_order, ${LINE_COLS.join(', ')})
       VALUES (?, ?, ?, ?, ${LINE_COLS.map(() => '?').join(', ')})`,
      [companyId, line.parent_item_id, childId, at, ...LINE_COLS.map((c) => line[c])],
    );
    await copyFieldValues(conn, companyId, 'bom_line', line.id, r.insertId);

    if (owned) await conn.commit();
    return { lineId: Number(r.insertId), itemId: childId, name, newPart };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}
