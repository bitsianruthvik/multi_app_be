/**
 * departmentLabelService.js — the labels of a group: a company's own short
 * lists. (TM/CF_HRMS_HIRING_SPEC.md §9, in groups since §15.)
 *
 * Every label belongs to ONE group (labelGroupService.js). The group Kind holds
 * the list §9 began with — Department, Section, Machine — and a department's
 * Kind label is also kept, by name, in hrms_departments.department_type.
 *
 * WITHOUT A groupId every function here means the Kind group, as it did before
 * groups existed: the old screens and callers keep working unchanged.
 *
 * THE KIND LIST IS NEVER EMPTY. A company with none gets the defaults the first
 * time the list is read (ensureLabels), together with any label its
 * departments already use, and the last Kind label cannot be deleted (nor the
 * last label of any required group). An optional group may be empty.
 *
 * Renaming a Kind label renames it on every department that uses it, in the
 * same transaction. Deleting a label in use is refused unless the caller says
 * where its departments go (moveTo — another label of the SAME group; for an
 * optional group, `none` takes the label off them).
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import { ensureKind, readModel, readName, DEFAULT_LABELS } from './labelGroupService.js';

export { DEFAULT_LABELS };

const shape = (r) => ({ id: r.id, name: r.name, sortOrder: Number(r.sort_order), departmentCount: Number(r.department_count ?? 0), groupId: r.group_id });

/** The group a call means: the one named, or Kind. */
function groupOf(model, groupId) {
  if (groupId == null || groupId === '') return model.kind;
  const g = model.groupById.get(Number(groupId));
  if (!g) throw invalid('INVALID', 'Choose one of this company’s label groups.', { problems: ['That label group is not one of this company’s.'] });
  return g;
}

/**
 * The company's KIND labels, rows as the database has them (+ department_count),
 * creating the Kind group and its defaults when it has none.
 */
export async function ensureLabels(db, companyId, userId = null) {
  return (await ensureKind(db, companyId, userId)).kindLabels;
}

/** GET /organisation/department-labels[?groupId=] -> { labels: [{ id, name, sortOrder, departmentCount, groupId }] } */
export async function listLabels(db, companyId, { groupId = null } = {}) {
  const model = await ensureKind(db, companyId);
  return { labels: model.labelsOf(groupOf(model, groupId).id).map(shape) };
}

/**
 * The Kind label a department is being given, as the list spells it -> the row.
 *   blank, with `fallbackToFirst` (a create that names none) -> the first Kind label;
 *   blank otherwise, or a name that is not in the list       -> 422.
 *
 * `addIfMissing` is for the retired workbook import alone (never a route): a
 * label typed in the workbook that the list lacks is ADDED to Kind, so the
 * rule "a department's label is in the list" still holds afterwards.
 */
export async function resolveKindLabel(db, companyId, given, { fallbackToFirst = false, addIfMissing = false, userId = null } = {}) {
  const model = await ensureKind(db, companyId);
  const labels = model.kindLabels;
  const text = given == null ? '' : String(given).trim();
  const choices = labels.map((l) => l.name).join(', ');
  if (!text) {
    if (fallbackToFirst) return labels[0];
    throw invalid('INVALID', `Choose a ${model.kind.name} label for the department.`, { problems: [`Choose a ${model.kind.name} label: ${choices}.`] });
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
    throw invalid('INVALID', `"${shown}" is not one of this company's department labels.`, {
      problems: [`"${shown}" is not one of this company's labels. Choose one of ${choices}, or add it to the list first.`],
    });
  }
  return hit;
}

/** The Kind label's NAME (what department_type holds). Kept for older callers. */
export async function resolveLabel(db, companyId, given, options = {}) {
  return (await resolveKindLabel(db, companyId, given, options)).name;
}

async function requireLabel(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM hrms_department_labels WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
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

const one = async (db, companyId, id) => shape((await readModel(db, companyId)).labelById.get(id));

/** POST /organisation/department-labels { name, groupId? } — without groupId, a Kind label. */
export async function createLabel(db, c, body = {}) {
  const model = await ensureKind(db, c.companyId, c.userId);
  const group = groupOf(model, body.groupId);
  const name = readName(body.name);
  await assertNameFree(db, c.companyId, group.id, name);
  const [[last]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM hrms_department_labels WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL', [c.companyId, group.id]);
  const [res] = await db.query(
    'INSERT INTO hrms_department_labels (company_id, group_id, name, sort_order, created_by) VALUES (?, ?, ?, ?, ?)',
    [c.companyId, group.id, name, Number(last.n) + 1, c.userId ?? null],
  );
  await audit(db, c, res.insertId, 'CREATE', null, { name, groupId: group.id });
  const label = await one(db, c.companyId, res.insertId);
  return { ...label, label };
}

/** A rename of a Kind label also renames it on every department that uses it — one transaction. */
export async function updateLabel(db, c, id, body = {}) {
  const before = await requireLabel(db, c.companyId, id);
  const model = await ensureKind(db, c.companyId, c.userId);
  const isKind = before.group_id === model.kind.id || before.group_id == null;
  const after = {};
  let renamed = 0;
  if (body.name !== undefined) {
    const name = readName(body.name);
    if (name !== before.name) {
      await assertNameFree(db, c.companyId, before.group_id ?? model.kind.id, name, id);
      await db.query('UPDATE hrms_department_labels SET name = ? WHERE company_id = ? AND id = ?', [name, c.companyId, id]);
      if (isKind) {
        // Every department, deleted ones too: a restored department must not come back with a label nobody has.
        const [res] = await db.query(
          'UPDATE hrms_departments SET department_type = ? WHERE company_id = ? AND LOWER(department_type) = LOWER(?)',
          [name, c.companyId, before.name],
        );
        renamed = res.affectedRows;
      } else {
        const [[n]] = await db.query('SELECT COUNT(*) AS n FROM hrms_department_label_links WHERE company_id = ? AND label_id = ? AND deleted_at IS NULL', [c.companyId, id]);
        renamed = Number(n.n);
      }
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
  if (Object.keys(after).length) await audit(db, c, id, 'UPDATE', { name: before.name, sortOrder: before.sort_order }, { ...after, departmentsRenamed: renamed });
  const label = await one(db, c.companyId, id);
  return { ...label, label, departmentsRenamed: renamed };
}

/**
 * PUT /organisation/department-labels/order { ids, groupId? } — every label of
 * ONE group, in the order wanted. The group is the one named, else the group of
 * the labels sent, else Kind.
 */
export async function reorderLabels(db, c, body = {}) {
  const model = await ensureKind(db, c.companyId, c.userId);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;
  const sentGroup = body.groupId != null ? body.groupId : (ids?.length ? model.labelById.get(ids[0])?.group_id ?? null : null);
  const group = groupOf(model, sentGroup);
  const labels = model.labelsOf(group.id);
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
  return listLabels(db, c.companyId, { groupId: group.id });
}

/**
 * DELETE. In use and no `moveTo`: 409 IN_USE with detail.departmentCount.
 * With `moveTo` (another label of the same group) its departments take that
 * label first; `moveTo=none` (optional groups only) takes the label off them.
 */
export async function deleteLabel(db, c, id, { moveTo = null } = {}) {
  const before = await requireLabel(db, c.companyId, id);
  const model = await ensureKind(db, c.companyId, c.userId);
  const group = model.groupById.get(before.group_id) ?? model.kind;
  const isKind = group.id === model.kind.id;
  const required = Number(group.is_required) === 1;
  const labels = model.labelsOf(group.id);
  if (required && labels.length <= 1) {
    throw conflict('LAST_LABEL', `This is the only ${group.name} label left. Every department needs one, so add another before removing this one.`);
  }
  const departmentCount = Number(labels.find((l) => l.id === id)?.department_count ?? 0);
  let moved = 0;
  const clear = !required && String(moveTo ?? '').toLowerCase() === 'none';
  if (departmentCount > 0) {
    const many = departmentCount !== 1;
    if ((moveTo == null || moveTo === '') && !clear) {
      throw conflict('IN_USE', `${departmentCount} ${many ? 'departments use' : 'department uses'} the label "${before.name}". Choose the label ${many ? 'they move' : 'it moves'} to.`, {
        problems: [`${departmentCount} ${many ? 'departments are' : 'department is'} labelled "${before.name}". Choose another label for ${many ? 'them' : 'it'}, then remove this one.`],
        detail: { departmentCount },
      });
    }
    if (clear) {
      const [res] = await db.query('UPDATE hrms_department_label_links SET deleted_at = NOW() WHERE company_id = ? AND label_id = ? AND deleted_at IS NULL', [c.companyId, id]);
      moved = res.affectedRows;
    } else {
      const target = labels.find((l) => l.id === Number(moveTo));
      if (!target || target.id === id) {
        throw invalid('INVALID', 'Choose another label of the same list to move the departments to.', {
          problems: [`The label to move the departments to must be another label of "${group.name}".`], detail: { departmentCount },
        });
      }
      if (isKind) {
        const [res] = await db.query(
          'UPDATE hrms_departments SET department_type = ? WHERE company_id = ? AND LOWER(department_type) = LOWER(?)',
          [target.name, c.companyId, before.name],
        );
        moved = res.affectedRows;
      }
      // One live link per (department, group): the link changes its label in place.
      const [res] = await db.query('UPDATE hrms_department_label_links SET label_id = ? WHERE company_id = ? AND label_id = ? AND deleted_at IS NULL', [target.id, c.companyId, id]);
      if (!isKind) moved = res.affectedRows;
    }
  } else if (!isKind) {
    // Links of departments that are gone.
    await db.query('UPDATE hrms_department_label_links SET deleted_at = NOW() WHERE company_id = ? AND label_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  }
  await db.query('UPDATE hrms_department_labels SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(db, c, id, 'DELETE', { name: before.name, groupId: group.id, departmentCount }, moved ? (clear ? { cleared: moved } : { movedTo: Number(moveTo), departmentsMoved: moved }) : null);
  return { ok: true, id, departmentsMoved: moved };
}

export default { DEFAULT_LABELS, ensureLabels, listLabels, resolveLabel, resolveKindLabel, createLabel, updateLabel, reorderLabels, deleteLabel };
