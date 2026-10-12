/**
 * departmentLabelService.js — a company's own short list of department labels.
 * (TM/CF_HRMS_HIRING_SPEC.md §9.)
 *
 * Everything is a department. A department carries a LABEL
 * (hrms_departments.department_type) chosen from this list, and a separate fact,
 * is_shared. Nothing branches on a label's words — it is what the company calls
 * that level, nothing more.
 *
 * THE LIST IS NEVER EMPTY. A company with no labels gets the defaults the first
 * time the list is read (ensureLabels), together with any label its departments
 * already use, and the last label cannot be deleted.
 *
 * THE DEPARTMENT KEEPS THE NAME. Renaming a label renames it on every department
 * that uses it, in the same transaction. Deleting one in use is refused unless
 * the caller says where its departments go (moveTo).
 *
 * A leaf: this file imports no other service.
 */
import { invalid, notFound, conflict } from '../lib/errors.js';

export const DEFAULT_LABELS = ['Department', 'Section', 'Machine'];
const MAX = 40;

const shape = (r) => ({ id: r.id, name: r.name, sortOrder: Number(r.sort_order), departmentCount: Number(r.department_count ?? 0) });

async function readLabels(db, companyId) {
  const [rows] = await db.query(
    `SELECT l.id, l.name, l.sort_order,
            (SELECT COUNT(*) FROM hrms_departments d
              WHERE d.company_id = l.company_id AND d.deleted_at IS NULL AND LOWER(d.department_type) = LOWER(l.name)) AS department_count
       FROM hrms_department_labels l
      WHERE l.company_id = ? AND l.deleted_at IS NULL
      ORDER BY l.sort_order, l.id`,
    [companyId],
  );
  return rows;
}

/**
 * The company's labels, creating the defaults when it has none. The insert is
 * INSERT IGNORE on the unique name, so two first reads at once write one list.
 */
export async function ensureLabels(db, companyId, userId = null) {
  let rows = await readLabels(db, companyId);
  if (rows.length) return rows;
  const [used] = await db.query(
    `SELECT DISTINCT TRIM(department_type) AS name FROM hrms_departments
      WHERE company_id = ? AND deleted_at IS NULL AND department_type IS NOT NULL AND TRIM(department_type) <> ''`,
    [companyId],
  );
  const names = [...DEFAULT_LABELS];
  for (const u of used) if (!names.some((n) => n.toLowerCase() === u.name.toLowerCase())) names.push(u.name.slice(0, MAX));
  await db.query(
    `INSERT IGNORE INTO hrms_department_labels (company_id, name, sort_order, created_by) VALUES ${names.map(() => '(?, ?, ?, ?)').join(', ')}`,
    names.flatMap((n, i) => [companyId, n, i + 1, userId]),
  );
  rows = await readLabels(db, companyId);
  return rows;
}

export async function listLabels(db, companyId) {
  return { labels: (await ensureLabels(db, companyId)).map(shape) };
}

/**
 * The label a department is being given, as the list spells it.
 *   blank, with `fallbackToFirst` (a create that names none) -> the first label of the list;
 *   blank otherwise, or a name that is not in the list       -> 422.
 *
 * `addIfMissing` is for the retired workbook import alone (never a route): a
 * label typed in the workbook that the list lacks is ADDED to the list, so the
 * rule "a department's label is in the list" still holds afterwards.
 */
export async function resolveLabel(db, companyId, given, { fallbackToFirst = false, addIfMissing = false, userId = null } = {}) {
  const labels = await ensureLabels(db, companyId);
  const text = given == null ? '' : String(given).trim();
  const choices = labels.map((l) => l.name).join(', ');
  if (!text) {
    if (fallbackToFirst) return labels[0].name;
    throw invalid('INVALID', 'Choose a label for the department.', { problems: [`Choose a label: ${choices}.`] });
  }
  const hit = labels.find((l) => l.name.toLowerCase() === text.toLowerCase());
  if (!hit && addIfMissing) {
    const name = readName(text);
    await db.query(
      'INSERT INTO hrms_department_labels (company_id, name, sort_order, created_by) VALUES (?, ?, ?, ?)',
      [companyId, name, labels.reduce((m, l) => Math.max(m, Number(l.sort_order)), 0) + 1, userId],
    );
    return name;
  }
  if (!hit) {
    const shown = text.slice(0, 60);
    throw invalid('INVALID', `"${shown}" is not one of this company's department labels.`, {
      problems: [`"${shown}" is not one of this company's labels. Choose one of ${choices}, or add it to the list first.`],
    });
  }
  return hit.name;
}

function readName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw invalid('INVALID', 'A label needs a name.', { problems: ['A label needs a name.'] });
  if (name.length > MAX) {
    throw invalid('INVALID', `A label is up to ${MAX} characters.`, { problems: [`A label is up to ${MAX} characters. It is a word for the level, not a description.`] });
  }
  return name;
}

async function requireLabel(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM hrms_department_labels WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  if (!row) throw notFound('Label');
  return row;
}

async function assertNameFree(db, companyId, name, exceptId = 0) {
  const [[clash]] = await db.query(
    'SELECT id, name FROM hrms_department_labels WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id <> ?',
    [companyId, name, exceptId],
  );
  if (clash) {
    throw conflict('DUPLICATE', `The label "${clash.name}" already exists.`, {
      problems: [`"${clash.name}" is already in the list. Labels are matched without case.`], detail: { labelId: clash.id },
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

const one = async (db, companyId, id) => shape((await readLabels(db, companyId)).find((l) => l.id === id));

export async function createLabel(db, c, body = {}) {
  await ensureLabels(db, c.companyId, c.userId);
  const name = readName(body.name);
  await assertNameFree(db, c.companyId, name);
  const [[last]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM hrms_department_labels WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const [res] = await db.query(
    'INSERT INTO hrms_department_labels (company_id, name, sort_order, created_by) VALUES (?, ?, ?, ?)',
    [c.companyId, name, Number(last.n) + 1, c.userId ?? null],
  );
  await audit(db, c, res.insertId, 'CREATE', null, { name });
  const label = await one(db, c.companyId, res.insertId);
  return { ...label, label };
}

/** A rename also renames the label on every department that uses it — one transaction. */
export async function updateLabel(db, c, id, body = {}) {
  const before = await requireLabel(db, c.companyId, id);
  const after = {};
  let renamed = 0;
  if (body.name !== undefined) {
    const name = readName(body.name);
    if (name !== before.name) {
      await assertNameFree(db, c.companyId, name, id);
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
  if (Object.keys(after).length) await audit(db, c, id, 'UPDATE', { name: before.name, sortOrder: before.sort_order }, { ...after, departmentsRenamed: renamed });
  const label = await one(db, c.companyId, id);
  return { ...label, label, departmentsRenamed: renamed };
}

/** PUT /organisation/department-labels/order { ids } — the whole list, in the order wanted. */
export async function reorderLabels(db, c, body = {}) {
  const labels = await ensureLabels(db, c.companyId, c.userId);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;
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
 * With `moveTo` (another label's id) its departments take that label first.
 */
export async function deleteLabel(db, c, id, { moveTo = null } = {}) {
  const before = await requireLabel(db, c.companyId, id);
  const labels = await readLabels(db, c.companyId);
  if (labels.length <= 1) {
    throw conflict('LAST_LABEL', 'This is the only label left. A department needs a label, so add another before removing this one.');
  }
  const departmentCount = Number(labels.find((l) => l.id === id)?.department_count ?? 0);
  let moved = 0;
  if (departmentCount > 0) {
    const many = departmentCount !== 1;
    if (moveTo == null || moveTo === '') {
      throw conflict('IN_USE', `${departmentCount} ${many ? 'departments use' : 'department uses'} the label "${before.name}". Choose the label ${many ? 'they move' : 'it moves'} to.`, {
        problems: [`${departmentCount} ${many ? 'departments are' : 'department is'} labelled "${before.name}". Choose another label for ${many ? 'them' : 'it'}, then remove this one.`],
        detail: { departmentCount },
      });
    }
    const target = labels.find((l) => l.id === Number(moveTo));
    if (!target || target.id === id) {
      throw invalid('INVALID', 'Choose another label of the list to move the departments to.', {
        problems: ['The label to move the departments to must be another label of this list.'], detail: { departmentCount },
      });
    }
    const [res] = await db.query(
      'UPDATE hrms_departments SET department_type = ? WHERE company_id = ? AND LOWER(department_type) = LOWER(?)',
      [target.name, c.companyId, before.name],
    );
    moved = res.affectedRows;
  }
  await db.query('UPDATE hrms_department_labels SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(db, c, id, 'DELETE', { name: before.name, departmentCount }, moved ? { movedTo: Number(moveTo), departmentsMoved: moved } : null);
  return { ok: true, id, departmentsMoved: moved };
}

export default { DEFAULT_LABELS, ensureLabels, listLabels, resolveLabel, createLabel, updateLabel, reorderLabels, deleteLabel };
