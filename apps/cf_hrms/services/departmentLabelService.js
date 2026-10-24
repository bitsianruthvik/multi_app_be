/**
 * departmentLabelService.js — the company's department labels: ONE short list,
 * ONE label per department (TM/CF_HRMS_HIRING_SPEC.md §9; the groups of §15
 * were removed on 2026-10-16). The list is read through labelGroupService.js's
 * model; a department's label is kept, by name, in
 * hrms_departments.department_type.
 *
 * THE LIST IS NEVER EMPTY. A company with none gets the defaults the first time
 * the list is read (ensureLabels), together with any label its departments
 * already use, and the last label cannot be deleted.
 *
 * Renaming a label renames it on every department that uses it, in the same
 * transaction. Deleting a label in use is refused unless the caller says where
 * its departments go (moveTo — another label of the list).
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import { ensureKind, readModel, readName, DEFAULT_LABELS } from './labelGroupService.js';

export { DEFAULT_LABELS };

/**
 * COLOUR PER KIND (spec §34.1). A palette KEY, never a raw hex: the screens map
 * each key to a fill, a text and an edge colour checked for contrast in the
 * light and the dark theme (multi_app_fe …/cf_hrms/components/kindColours.css).
 * A kind with no colour chosen shows its default: Department blue, Section
 * teal, Machine amber; any other kind the first palette key no other kind of
 * the company shows yet (in the kinds' order).
 */
export const KIND_COLOURS = Object.freeze(['blue', 'teal', 'green', 'lime', 'amber', 'orange', 'red', 'pink', 'purple', 'indigo', 'cyan', 'slate']);
export const DEFAULT_KIND_COLOURS = Object.freeze({ department: 'blue', section: 'teal', machine: 'amber' });

/** labelId -> the colour each kind shows, for a list in the kinds' order. */
export function shownColours(labels) {
  const out = new Map();
  const used = new Set();
  for (const l of labels) if (KIND_COLOURS.includes(l.colour)) { out.set(l.id, l.colour); used.add(l.colour); }
  for (const l of labels) {
    if (out.has(l.id)) continue;
    const wanted = DEFAULT_KIND_COLOURS[String(l.name ?? '').trim().toLowerCase()];
    const key = wanted && !used.has(wanted) ? wanted : (KIND_COLOURS.find((k) => !used.has(k)) ?? KIND_COLOURS[used.size % KIND_COLOURS.length]);
    out.set(l.id, key);
    used.add(key);
  }
  return out;
}

/** A colour from a body: a palette key, or null / '' for the default. Anything else is refused. */
function readColour(value) {
  if (value === null || value === '') return null;
  const key = String(value ?? '').trim().toLowerCase();
  if (!KIND_COLOURS.includes(key)) {
    throw invalid('INVALID', 'Choose one of the colours offered.', {
      problems: [`"${String(value).slice(0, 30)}" is not one of the colours. Choose one of ${KIND_COLOURS.join(', ')}, or the default.`],
    });
  }
  return key;
}

const shape = (r, colours = null) => ({
  id: r.id, name: r.name, sortOrder: Number(r.sort_order), departmentCount: Number(r.department_count ?? 0),
  // 'New positions start on' (spec §17.2): the shift a new position in a department carrying this label gets.
  defaultShiftId: r.default_shift_id ?? null,
  // §34.1: `colour` the palette key the kind SHOWS (chosen or default); `colourChosen` the stored one, null = default.
  colour: colours?.get(r.id) ?? (KIND_COLOURS.includes(r.colour) ? r.colour : null),
  colourChosen: KIND_COLOURS.includes(r.colour) ? r.colour : null,
});

/**
 * 'New positions start on' (spec §17.2): a label's default shift — a live shift
 * of this company, or null for none. Existing positions never change with it;
 * only a position created without a shift reads it (positionService).
 */
async function readDefaultShift(db, companyId, value) {
  if (value === null || value === '' || value === undefined) return null;
  const id = Number(value);
  const [[row]] = Number.isInteger(id) && id > 0
    ? await db.query('SELECT id FROM hrms_shifts WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id])
    : [[null]];
  if (!row) throw invalid('INVALID', 'Choose one of this company’s shifts, or no default.', { problems: ['The shift new positions start on must be one of this company’s shifts.'] });
  return id;
}

/** The company's labels, rows as the database has them (+ department_count), made when it has none. */
export async function ensureLabels(db, companyId, userId = null) {
  return (await ensureKind(db, companyId, userId)).labels;
}

/**
 * GET /organisation/department-labels
 *   -> { labels: [{ id, name, sortOrder, departmentCount, defaultShiftId }], shifts: [{ id, code, name }] }
 * `shifts`: the company's active shifts, the choices of 'New positions start on' (spec §17.2), so the
 * Labels sheet needs no other right to offer them.
 */
export async function listLabels(db, companyId) {
  const [model, [shifts]] = await Promise.all([
    ensureKind(db, companyId),
    db.query("SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY id", [companyId]),
  ]);
  const colours = shownColours(model.labels);
  return { labels: model.labels.map((l) => shape(l, colours)), shifts: shifts.map((x) => ({ id: x.id, code: x.code ?? null, name: x.name })) };
}

/**
 * The label a department is being given, as the list spells it -> the row.
 *   blank, with `fallbackToFirst` (a create that names none) -> the first label;
 *   blank otherwise, or a name that is not in the list       -> 422.
 *
 * `addIfMissing` is for the retired workbook import alone (never a route): a
 * label typed in the workbook that the list lacks is ADDED to the list, so the
 * rule "a department's label is in the list" still holds afterwards.
 */
export async function resolveKindLabel(db, companyId, given, { fallbackToFirst = false, addIfMissing = false, userId = null } = {}) {
  const model = await ensureKind(db, companyId);
  const labels = model.labels;
  const text = given == null ? '' : String(given).trim();
  const choices = labels.map((l) => l.name).join(', ');
  if (!text) {
    if (fallbackToFirst) return labels[0];
    throw invalid('INVALID', 'Choose what kind of org unit it is.', { problems: [`Choose a kind: ${choices}.`] });
  }
  const hit = labels.find((l) => l.name.toLowerCase() === text.toLowerCase());
  if (!hit && addIfMissing) {
    const name = readName(text);
    const [res] = await db.query(
      'INSERT INTO hrms_department_labels (company_id, group_id, name, sort_order, created_by) VALUES (?, ?, ?, ?, ?)',
      [companyId, model.kind.id, name, labels.reduce((m, l) => Math.max(m, Number(l.sort_order)), 0) + 1, userId],
    );
    return { id: res.insertId, group_id: model.kind.id, name, sort_order: labels.length + 1 };
  }
  if (!hit) {
    const shown = text.slice(0, 60);
    throw invalid('INVALID', `"${shown}" is not one of this company's kinds of org unit.`, {
      problems: [`"${shown}" is not one of this company's kinds. Choose one of ${choices}, or add it to the list first.`],
    });
  }
  return hit;
}

/** The label's NAME (what department_type holds). Kept for older callers. */
export async function resolveLabel(db, companyId, given, options = {}) {
  return (await resolveKindLabel(db, companyId, given, options)).name;
}

/** A label of the list, locked for the write. */
async function requireLabel(db, companyId, id, model) {
  const [[row]] = await db.query(
    'SELECT * FROM hrms_department_labels WHERE company_id = ? AND id = ? AND group_id = ? AND deleted_at IS NULL FOR UPDATE',
    [companyId, id, model.kind.id],
  );
  if (!row) throw notFound('Label');
  return row;
}

async function assertNameFree(db, companyId, groupId, name, exceptId = 0) {
  const [[clash]] = await db.query(
    'SELECT id, name FROM hrms_department_labels WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id <> ?',
    [companyId, groupId, name, exceptId],
  );
  if (clash) {
    throw conflict('DUPLICATE', `The label "${clash.name}" already exists.`, {
      problems: [`"${clash.name}" is already in this list. Labels are matched without case.`], detail: { labelId: clash.id },
    });
  }
}

async function audit(db, c, id, action, before, after) {
  await db.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by)
     VALUES (?, ?, 'hrms_department_labels', ?, ?, ?, ?, ?)`,
    [c.companyId, c.userId ?? null, id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, c.userId ?? null],
  );
}

const one = async (db, companyId, id) => {
  const model = await readModel(db, companyId);
  return shape(model.labelById.get(id), shownColours(model.labels));
};

/** POST /organisation/department-labels { name, defaultShiftId?, colour? } — no colour: the first one no other kind shows. */
export async function createLabel(db, c, body = {}) {
  const model = await ensureKind(db, c.companyId, c.userId);
  const groupId = model.kind.id;
  const name = readName(body.name);
  await assertNameFree(db, c.companyId, groupId, name);
  const defaultShiftId = await readDefaultShift(db, c.companyId, body.defaultShiftId);
  // No colour asked for: the one it would show as the last kind of the list, stored, so it keeps it when others move.
  const colour = body.colour !== undefined && body.colour !== null && body.colour !== ''
    ? readColour(body.colour)
    : shownColours([...model.labels, { id: 0, name, colour: null }]).get(0);
  const [[last]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM hrms_department_labels WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL', [c.companyId, groupId]);
  const [res] = await db.query(
    'INSERT INTO hrms_department_labels (company_id, group_id, name, sort_order, colour, default_shift_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, groupId, name, Number(last.n) + 1, colour, defaultShiftId, c.userId ?? null],
  );
  await audit(db, c, res.insertId, 'CREATE', null, { name, colour, defaultShiftId });
  const label = await one(db, c.companyId, res.insertId);
  return { ...label, label };
}

/** PUT /organisation/department-labels/:id — a rename also renames the label on every department that uses it, one transaction. */
export async function updateLabel(db, c, id, body = {}) {
  const model = await ensureKind(db, c.companyId, c.userId);
  const before = await requireLabel(db, c.companyId, id, model);
  const after = {};
  let renamed = 0;
  if (body.name !== undefined) {
    const name = readName(body.name);
    if (name !== before.name) {
      await assertNameFree(db, c.companyId, model.kind.id, name, id);
      await db.query('UPDATE hrms_department_labels SET name = ? WHERE company_id = ? AND id = ?', [name, c.companyId, id]);
      // Every department, deleted ones too: a restored department must not come back with a label nobody has.
      const [res] = await db.query(
        'UPDATE hrms_departments SET department_type = ? WHERE company_id = ? AND LOWER(department_type) = LOWER(?)',
        [name, c.companyId, before.name],
      );
      renamed = res.affectedRows;
      after.name = name;
    }
  }
  if (body.sortOrder !== undefined) {
    const n = Number(body.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 9999) {
      throw invalid('INVALID', 'The order must be a whole number.', { problems: ['The order must be a whole number from 0 to 9999.'] });
    }
    await db.query('UPDATE hrms_department_labels SET sort_order = ? WHERE company_id = ? AND id = ?', [n, c.companyId, id]);
    after.sortOrder = n;
  }
  if (body.defaultShiftId !== undefined) {
    const shiftId = await readDefaultShift(db, c.companyId, body.defaultShiftId);
    if (shiftId !== (before.default_shift_id ?? null)) {
      await db.query('UPDATE hrms_department_labels SET default_shift_id = ? WHERE company_id = ? AND id = ?', [shiftId, c.companyId, id]);
      after.defaultShiftId = shiftId;
    }
  }
  if (body.colour !== undefined) {
    const colour = readColour(body.colour);
    if (colour !== (before.colour ?? null)) {
      await db.query('UPDATE hrms_department_labels SET colour = ? WHERE company_id = ? AND id = ?', [colour, c.companyId, id]);
      after.colour = colour;
    }
  }
  if (Object.keys(after).length) await audit(db, c, id, 'UPDATE', { name: before.name, sortOrder: before.sort_order, colour: before.colour ?? null, defaultShiftId: before.default_shift_id ?? null }, { ...after, departmentsRenamed: renamed });
  const label = await one(db, c.companyId, id);
  return { ...label, label, departmentsRenamed: renamed };
}

/** PUT /organisation/department-labels/order { ids } — every label once, in the order wanted. -> { labels, shifts } */
export async function reorderLabels(db, c, body = {}) {
  const model = await ensureKind(db, c.companyId, c.userId);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;
  const labels = model.labels;
  const have = new Set(labels.map((l) => l.id));
  if (!ids || ids.length !== labels.length || new Set(ids).size !== ids.length || ids.some((v) => !have.has(v))) {
    throw invalid('INVALID', 'Send every label once, in the order wanted.', {
      problems: [`The list has ${labels.length} labels. Send the id of each one exactly once, in the order wanted.`],
    });
  }
  await db.query(
    `UPDATE hrms_department_labels SET sort_order = CASE id ${ids.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
    [...ids.flatMap((v, i) => [v, i + 1]), c.companyId, ids],
  );
  return listLabels(db, c.companyId);
}

/**
 * DELETE. In use and no `moveTo`: 409 IN_USE with detail.departmentCount.
 * With `moveTo` (another label of the list) its departments take that label
 * first. The last label is never removed (409 LAST_LABEL).
 */
export async function deleteLabel(db, c, id, { moveTo = null } = {}) {
  const model = await ensureKind(db, c.companyId, c.userId);
  const before = await requireLabel(db, c.companyId, id, model);
  const labels = model.labels;
  if (labels.length <= 1) {
    throw conflict('LAST_LABEL', 'This is the only kind left. Every org unit needs one, so add another before removing this one.');
  }
  const departmentCount = Number(labels.find((l) => l.id === id)?.department_count ?? 0);
  let moved = 0;
  let target = null;
  if (departmentCount > 0) {
    const many = departmentCount !== 1;
    if (moveTo == null || moveTo === '') {
      throw conflict('IN_USE', `${departmentCount} ${many ? 'org units are' : 'org unit is'} of the kind "${before.name}". Choose the kind ${many ? 'they move' : 'it moves'} to.`, {
        problems: [`${departmentCount} ${many ? 'org units are' : 'org unit is'} of the kind "${before.name}". Choose another kind for ${many ? 'them' : 'it'}, then remove this one.`],
        detail: { departmentCount },
      });
    }
    target = labels.find((l) => l.id === Number(moveTo));
    if (!target || target.id === id) {
      throw invalid('INVALID', 'Choose another kind of the list to move the org units to.', {
        problems: ['The kind to move the org units to must be another kind of the list.'], detail: { departmentCount },
      });
    }
    const [res] = await db.query(
      'UPDATE hrms_departments SET department_type = ? WHERE company_id = ? AND LOWER(department_type) = LOWER(?)',
      [target.name, c.companyId, before.name],
    );
    moved = res.affectedRows;
  }
  // The link rows follow the name: one live link per department, its label changed in place.
  if (target) await db.query('UPDATE hrms_department_label_links SET label_id = ? WHERE company_id = ? AND label_id = ? AND deleted_at IS NULL', [target.id, c.companyId, id]);
  else await db.query('UPDATE hrms_department_label_links SET deleted_at = NOW() WHERE company_id = ? AND label_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE hrms_department_labels SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(db, c, id, 'DELETE', { name: before.name, departmentCount }, moved ? { movedTo: target.id, departmentsMoved: moved } : null);
  return { ok: true, id, departmentsMoved: moved };
}

export default { DEFAULT_LABELS, KIND_COLOURS, DEFAULT_KIND_COLOURS, shownColours, ensureLabels, listLabels, resolveLabel, resolveKindLabel, createLabel, updateLabel, reorderLabels, deleteLabel };
