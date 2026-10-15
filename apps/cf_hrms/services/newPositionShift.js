/**
 * newPositionShift.js — the shift a NEW position starts on when none is named
 * (TM/CF_HRMS_HIRING_SPEC.md §17.2).
 *
 * THE RULE, and its one implementation (`chooseNewShift`, pure):
 *   1. a shift named by whoever creates the position always wins — callers only
 *      ask this when none was named;
 *   2. else the first label of the position's department, in group order, that
 *      carries a default shift ("New positions start on: Day") — the
 *      department's OWN labels, never a parent's (§15.3); a default that points
 *      at an inactive or removed shift is passed over;
 *   3. else, for "Add a position like this" only, the shift of the position it
 *      is added beside (what that path did before labels had defaults);
 *   4. else the company's General shift (a code starting with G), else its first.
 * Existing positions never change: nothing here is read except on create.
 *
 * Every creation path asks it: the position form and POST /positions
 * (positionService.readPositionBody), add-sibling (positionService), the Excel
 * positions upload (excel/entities/positions.js — in memory, from lists it has
 * loaded once) and the command bar's add_position (its preview and its apply).
 * The position form shows the answer's `line` before saving
 * (GET /positions/new-shift).
 */

const LIVE = (s) => s && String(s.status ?? 'ACTIVE').toUpperCase() !== 'INACTIVE';

/** "Day" -> "Day shift"; "Night Shift" stays. */
export const shiftWords = (name) => (/shift\s*$/i.test(String(name ?? '')) ? String(name) : `${name} shift`);

/** The company's General shift: a code starting with G, else its first (by id). Today's rule, unchanged. */
export function generalShiftOf(shifts) {
  const sorted = [...shifts].sort((a, b) => a.id - b.id);
  return sorted.find((s) => String(s.code ?? '').trim().toUpperCase().startsWith('G')) ?? sorted[0] ?? null;
}

const refOf = (s) => ({ id: s.id, code: s.code ?? null, name: s.name });

/**
 * @param labels  the department's own labels, IN GROUP ORDER: [{ labelId|id, name, groupName, defaultShiftId }]
 * @param shifts  the company's live shifts: [{ id, code, name, status? }]
 * @param likeShiftId  add-sibling only: the shift of the position it is added beside
 * @returns { shift: { id, code, name } | null, from: 'LABEL' | 'LIKE' | 'GENERAL' | null,
 *            label: { id, name, groupName } | null,
 *            line: "Starts on Day shift (from the label Machine)" }
 */
export function chooseNewShift({ labels = [], shifts = [], likeShiftId = null } = {}) {
  const byId = new Map(shifts.map((s) => [Number(s.id), s]));
  for (const l of labels) {
    const s = l.defaultShiftId != null ? byId.get(Number(l.defaultShiftId)) : null;
    if (LIVE(s)) {
      return {
        shift: refOf(s), from: 'LABEL', label: { id: l.labelId ?? l.id, name: l.name, groupName: l.groupName ?? null },
        line: `Starts on ${shiftWords(s.name)} (from the label ${l.name})`,
      };
    }
  }
  const like = likeShiftId != null ? byId.get(Number(likeShiftId)) : null;
  if (like) return { shift: refOf(like), from: 'LIKE', label: null, line: `Starts on ${shiftWords(like.name)} (like the position it is added beside)` };
  const general = generalShiftOf(shifts);
  if (general) return { shift: refOf(general), from: 'GENERAL', label: null, line: `Starts on ${shiftWords(general.name)} (the company’s general shift)` };
  return { shift: null, from: null, label: null, line: 'This company has no shift yet.' };
}

/**
 * The labels with a default shift that a department carries, in group order:
 * one query. Kind by department_type (without case), the others by link — the
 * rule of labelGroupService.DEPARTMENT_LABELS_SQL.
 */
export async function departmentShiftLabels(db, companyId, departmentId) {
  if (departmentId == null) return [];
  const [rows] = await db.query(
    `SELECT l.id, l.name, g.name AS group_name, l.default_shift_id
       FROM hrms_department_labels l
       JOIN hrms_label_groups g ON g.company_id = l.company_id AND g.id = l.group_id AND g.deleted_at IS NULL
       JOIN hrms_departments d ON d.company_id = l.company_id AND d.id = ?
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.default_shift_id IS NOT NULL
        AND IF(g.is_kind = 1,
               LOWER(l.name) = LOWER(d.department_type),
               EXISTS (SELECT 1 FROM hrms_department_label_links k
                        WHERE k.company_id = l.company_id AND k.department_id = d.id AND k.group_id = g.id
                          AND k.label_id = l.id AND k.deleted_at IS NULL))
      ORDER BY g.sort_order, g.id`,
    [Number(departmentId), companyId],
  );
  return rows.map((r) => ({ labelId: r.id, name: r.name, groupName: r.group_name, defaultShiftId: r.default_shift_id }));
}

/** The choice for one new position, from the database: two queries, sent together. */
export async function newPositionShift(db, companyId, { departmentId = null, likeShiftId = null } = {}) {
  const [labels, [shifts]] = await Promise.all([
    departmentShiftLabels(db, companyId, departmentId),
    db.query('SELECT id, code, name, status FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [companyId]),
  ]);
  return chooseNewShift({ labels, shifts, likeShiftId });
}

export default { shiftWords, generalShiftOf, chooseNewShift, departmentShiftLabels, newPositionShift };
