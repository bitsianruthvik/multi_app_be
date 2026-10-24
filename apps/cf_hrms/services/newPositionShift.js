/**
 * newPositionShift.js — the shift a NEW position starts on when none is named
 * (TM/CF_HRMS_HIRING_SPEC.md §17.2; one label per department since 2026-10-16).
 *
 * THE RULE, and its one implementation (`chooseNewShift`, pure):
 *   1. a shift named by whoever creates the position always wins — callers only
 *      ask this when none was named;
 *   2. else the department's label, when it carries a default shift ("New
 *      positions start on: Day") — the department's OWN label, never a
 *      parent's; a default that points at an inactive or removed shift is
 *      passed over;
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
 * @param label   the department's label: { id, name, defaultShiftId } | null
 * @param shifts  the company's live shifts: [{ id, code, name, status? }]
 * @param likeShiftId  add-sibling only: the shift of the position it is added beside
 * @returns { shift: { id, code, name } | null, from: 'LABEL' | 'LIKE' | 'GENERAL' | null,
 *            label: { id, name } | null,
 *            line: "Starts on Day shift (from the kind Machine)" }
 */
export function chooseNewShift({ label = null, shifts = [], likeShiftId = null } = {}) {
  const byId = new Map(shifts.map((s) => [Number(s.id), s]));
  const own = label?.defaultShiftId != null ? byId.get(Number(label.defaultShiftId)) : null;
  if (LIVE(own)) {
    return {
      shift: refOf(own), from: 'LABEL', label: { id: label.id, name: label.name },
      line: `Starts on ${shiftWords(own.name)} (from the kind ${label.name})`,
    };
  }
  const like = likeShiftId != null ? byId.get(Number(likeShiftId)) : null;
  if (like) return { shift: refOf(like), from: 'LIKE', label: null, line: `Starts on ${shiftWords(like.name)} (like the position it is added beside)` };
  const general = generalShiftOf(shifts);
  if (general) return { shift: refOf(general), from: 'GENERAL', label: null, line: `Starts on ${shiftWords(general.name)} (the company’s general shift)` };
  return { shift: null, from: null, label: null, line: 'This company has no shift yet.' };
}

/** The department's label (by department_type, without case) with its default shift, or null: one query. */
export async function departmentShiftLabel(db, companyId, departmentId) {
  if (departmentId == null) return null;
  const [[row]] = await db.query(
    `SELECT l.id, l.name, l.default_shift_id
       FROM hrms_departments d
       JOIN hrms_label_groups g ON g.company_id = d.company_id AND g.is_kind = 1 AND g.deleted_at IS NULL
       JOIN hrms_department_labels l ON l.company_id = d.company_id AND l.group_id = g.id AND l.deleted_at IS NULL
                                    AND LOWER(l.name) = LOWER(d.department_type)
      WHERE d.company_id = ? AND d.id = ?
      ORDER BY l.id LIMIT 1`,
    [companyId, Number(departmentId)],
  );
  return row ? { id: row.id, name: row.name, defaultShiftId: row.default_shift_id ?? null } : null;
}

/** The choice for one new position, from the database: two queries, sent together. */
export async function newPositionShift(db, companyId, { departmentId = null, likeShiftId = null } = {}) {
  const [label, [shifts]] = await Promise.all([
    departmentShiftLabel(db, companyId, departmentId),
    db.query('SELECT id, code, name, status FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [companyId]),
  ]);
  return chooseNewShift({ label, shifts, likeShiftId });
}

export default { shiftWords, generalShiftOf, chooseNewShift, departmentShiftLabel, newPositionShift };
