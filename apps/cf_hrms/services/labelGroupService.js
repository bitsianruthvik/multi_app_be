/**
 * labelGroupService.js — labels in groups (TM/CF_HRMS_HIRING_SPEC.md §15).
 *
 * A department's labels belong to named GROUPS, ONE label per group per
 * department. Every company has the group Kind (required): its labels are the
 * Department / Section / Machine list of §9 (departmentLabelService.js keeps
 * that list's routes). Other groups are the company's own — "Unit" with Unit 1,
 * Unit 2 … — and may be optional.
 *
 * WHERE A DEPARTMENT'S LABELS LIVE
 *   - Kind: hrms_departments.department_type (the label's NAME, as before §15)
 *     AND a link row. Both are written in the same transaction. Reads take the
 *     Kind label from department_type — it is the column every older reader and
 *     writer already keeps right (a rename renames it; the retired import writes
 *     it), so a department is never shown without its Kind.
 *   - every other group: hrms_department_label_links only.
 *   DEPARTMENT_LABELS_SQL is the one read of "this department's labels", used by
 *   the lists, the chart, the filters and Excel alike.
 *
 * THE KIND GROUP IS MADE ON FIRST USE (ensureKind): a company that has none gets
 * it, and any label with no group (written by an older backend) is moved into
 * it. scripts/apply-label-groups.mjs does the same for every company at once and
 * links the departments.
 *
 * Nothing here branches on a label's words. A label is what the company calls
 * something, nothing more.
 */
import { invalid, notFound, conflict } from '../lib/errors.js';

export const KIND_GROUP = 'Kind';
export const DEFAULT_LABELS = ['Department', 'Section', 'Machine'];
const MAX = 40;
const FIELD = String.fromCharCode(31);
/**
 * Every group id this server has read, of any company (ids are unique across
 * companies). The code generator's rule check looks a condition up by its key
 * and cannot ask the database; codegenOrgProvider.js answers `label.<groupId>`
 * from this set, and checks the group is the company's own when validating.
 */
export const KNOWN_GROUP_IDS = new Set();
const ROW = String.fromCharCode(30);

/**
 * A department's labels as ONE string column (alias `d` = hrms_departments),
 * group order. Parse it with parseLabelList. The Kind label is the Kind label
 * whose name is the department's department_type; the others are its links.
 */
export const DEPARTMENT_LABELS_SQL = (d = 'd') => `(
  SELECT GROUP_CONCAT(CONCAT_WS('${FIELD}', g.id, g.name, l.id, l.name) ORDER BY g.sort_order, g.id SEPARATOR '${ROW}')
    FROM hrms_label_groups g
    JOIN hrms_department_labels l ON l.company_id = g.company_id AND l.group_id = g.id AND l.deleted_at IS NULL
   WHERE g.company_id = ${d}.company_id AND g.deleted_at IS NULL
     AND IF(g.is_kind = 1,
            LOWER(l.name) = LOWER(${d}.department_type),
            EXISTS (SELECT 1 FROM hrms_department_label_links k
                     WHERE k.company_id = ${d}.company_id AND k.department_id = ${d}.id AND k.group_id = g.id
                       AND k.label_id = l.id AND k.deleted_at IS NULL)))`;

/** "3␟Kind␟5␟Section␞7␟Unit␟21␟Unit 2" -> [{ groupId, groupName, labelId, name }] */
export function parseLabelList(text) {
  if (text == null || text === '') return [];
  const raw = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  return raw.split(ROW).filter(Boolean).map((part) => {
    const [groupId, groupName, labelId, name] = part.split(FIELD);
    return { groupId: Number(groupId), groupName, labelId: Number(labelId), name };
  });
}

/* ── names ─────────────────────────────────────────────────────────────── */

export function readName(value, what = 'A label') {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw invalid('INVALID', `${what} needs a name.`, { problems: [`${what} needs a name.`] });
  if (name.length > MAX) {
    throw invalid('INVALID', `${what} is up to ${MAX} characters.`, { problems: [`${what} is up to ${MAX} characters. It is a word or two, not a description.`] });
  }
  return name;
}

async function audit(db, c, table, id, action, before, after) {
  await db.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, c.userId ?? null, table, id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, c.userId ?? null],
  );
}

/* ── the model: groups and labels of a company ─────────────────────────── */

/**
 * Every live group and label of a company, with how many live departments use
 * each label (Kind by department_type, without case; the others by link) and
 * how many live departments a group leaves without a label.
 */
export async function readModel(db, companyId) {
  const [[groups], [labels], [[live]]] = await Promise.all([
    db.query(
      `SELECT id, name, sort_order, is_required, is_kind FROM hrms_label_groups
        WHERE company_id = ? AND deleted_at IS NULL ORDER BY sort_order, id`, [companyId]),
    db.query(
      `SELECT l.id, l.group_id, l.name, l.sort_order, IF(s.id IS NULL, NULL, l.default_shift_id) AS default_shift_id,
              IF(g.is_kind = 1,
                 (SELECT COUNT(*) FROM hrms_departments d
                   WHERE d.company_id = l.company_id AND d.deleted_at IS NULL AND LOWER(d.department_type) = LOWER(l.name)),
                 (SELECT COUNT(*) FROM hrms_department_label_links k
                    JOIN hrms_departments d ON d.company_id = k.company_id AND d.id = k.department_id AND d.deleted_at IS NULL
                   WHERE k.company_id = l.company_id AND k.label_id = l.id AND k.deleted_at IS NULL)) AS department_count
         FROM hrms_department_labels l
         LEFT JOIN hrms_label_groups g ON g.company_id = l.company_id AND g.id = l.group_id
         LEFT JOIN hrms_shifts s ON s.company_id = l.company_id AND s.id = l.default_shift_id AND s.deleted_at IS NULL
        WHERE l.company_id = ? AND l.deleted_at IS NULL
        ORDER BY l.sort_order, l.id`, [companyId]),
    db.query('SELECT COUNT(*) AS n FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
  ]);
  for (const g of groups) KNOWN_GROUP_IDS.add(g.id);
  return modelOf(groups, labels, Number(live.n));
}

/**
 * The groups and their labels in ONE query, without the counts — for readers
 * that only need the lists (the Excel files). Falls back to ensureKind when the
 * company has no Kind group yet.
 */
export async function readLists(db, companyId) {
  const [rows] = await db.query(
    `SELECT g.id AS gid, g.name AS gname, g.sort_order AS gsort, g.is_required, g.is_kind, l.id, l.name, l.sort_order,
            IF(s.id IS NULL, NULL, l.default_shift_id) AS default_shift_id
       FROM hrms_label_groups g
       LEFT JOIN hrms_department_labels l ON l.company_id = g.company_id AND l.group_id = g.id AND l.deleted_at IS NULL
       LEFT JOIN hrms_shifts s ON s.company_id = l.company_id AND s.id = l.default_shift_id AND s.deleted_at IS NULL
      WHERE g.company_id = ? AND g.deleted_at IS NULL
      ORDER BY g.sort_order, g.id, l.sort_order, l.id`, [companyId]);
  if (!rows.some((r) => Number(r.is_kind) === 1 && r.id != null)) return ensureKind(db, companyId);
  const groups = [];
  const labels = [];
  for (const r of rows) {
    if (!groups.some((g) => g.id === r.gid)) {
      groups.push({ id: r.gid, name: r.gname, sort_order: r.gsort, is_required: r.is_required, is_kind: r.is_kind });
      KNOWN_GROUP_IDS.add(r.gid);
    }
    if (r.id != null) labels.push({ id: r.id, group_id: r.gid, name: r.name, sort_order: r.sort_order, default_shift_id: r.default_shift_id ?? null });
  }
  return modelOf(groups, labels, null);
}

function modelOf(groups, labels, departmentCount) {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const labelById = new Map(labels.map((l) => [l.id, l]));
  const kind = groups.find((g) => Number(g.is_kind) === 1) ?? null;
  const labelsOf = (groupId) => labels.filter((l) => l.group_id === groupId);
  return {
    groups, labels, groupById, labelById, kind, labelsOf, departmentCount,
    kindLabels: kind ? labelsOf(kind.id) : [],
    orphans: labels.filter((l) => l.group_id == null || !groupById.has(l.group_id)),
  };
}

/**
 * The company's Kind group, made when missing; labels with no group moved into
 * it; and the Kind list seeded (Department, Section, Machine + every other
 * label its departments already use) when it is empty. INSERT IGNORE on the
 * unique keys, so two first reads at once write one group and one list.
 * Costs the three reads of readModel when nothing is missing.
 */
export async function ensureKind(db, companyId, userId = null) {
  let model = await readModel(db, companyId);
  let wrote = false;
  if (!model.kind) {
    const [[taken]] = await db.query(
      'SELECT id FROM hrms_label_groups WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?)', [companyId, KIND_GROUP]);
    if (taken) await db.query('UPDATE hrms_label_groups SET is_kind = 1, is_required = 1 WHERE company_id = ? AND id = ?', [companyId, taken.id]);
    else {
      await db.query(
        `INSERT IGNORE INTO hrms_label_groups (company_id, name, sort_order, is_required, is_kind, created_by)
         VALUES (?, ?, 0, 1, 1, ?)`, [companyId, KIND_GROUP, userId]);
    }
    wrote = true;
  }
  if (wrote) model = await readModel(db, companyId);
  if (!model.kind) throw new Error('[cf_hrms] the Kind group could not be made.');
  // Labels an older backend wrote with no group, or left in a group that is gone: they were Kind labels.
  // Seen on live labels; moved with the deleted ones too, so a restore cannot bring back a label nobody can see.
  if (model.orphans.length) {
    // One that Kind already has under the same name is a duplicate: Kind is matched by name, so it is retired.
    const twins = model.orphans.filter((o) => model.kindLabels.some((k) => k.name.toLowerCase() === o.name.toLowerCase())).map((o) => o.id);
    if (twins.length) await db.query('UPDATE hrms_department_labels SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, twins]);
    await db.query(
      `UPDATE hrms_department_labels l SET l.group_id = ?
        WHERE l.company_id = ? AND (l.group_id IS NULL OR NOT EXISTS
              (SELECT 1 FROM hrms_label_groups g WHERE g.company_id = l.company_id AND g.id = l.group_id))`,
      [model.kind.id, companyId]);
    wrote = true;
  }
  if (!wrote && model.kindLabels.length) return model;
  if (wrote) model = await readModel(db, companyId);
  if (model.kindLabels.length) return model;
  const [used] = await db.query(
    `SELECT DISTINCT TRIM(department_type) AS name FROM hrms_departments
      WHERE company_id = ? AND deleted_at IS NULL AND department_type IS NOT NULL AND TRIM(department_type) <> ''`,
    [companyId],
  );
  const names = [...DEFAULT_LABELS];
  for (const u of used) if (!names.some((n) => n.toLowerCase() === u.name.toLowerCase())) names.push(u.name.slice(0, MAX));
  await db.query(
    `INSERT IGNORE INTO hrms_department_labels (company_id, group_id, name, sort_order, created_by) VALUES ${names.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
    names.flatMap((n, i) => [companyId, model.kind.id, n, i + 1, userId]),
  );
  return readModel(db, companyId);
}

/* ── groups: reading ───────────────────────────────────────────────────── */

const shapeLabel = (l) => ({
  id: l.id, name: l.name, sortOrder: Number(l.sort_order), departmentCount: Number(l.department_count ?? 0), groupId: l.group_id,
  // 'New positions start on' (spec §17.2): the shift a new position in a department carrying this label gets.
  defaultShiftId: l.default_shift_id ?? null,
});

export function shapeGroup(model, g) {
  const labels = model.labelsOf(g.id).map(shapeLabel);
  const used = labels.reduce((t, l) => t + l.departmentCount, 0);
  return {
    id: g.id,
    name: g.name,
    sortOrder: Number(g.sort_order),
    isRequired: Number(g.is_required) === 1,
    isKind: Number(g.is_kind) === 1,
    // The Kind group cannot be removed and is always required.
    locked: Number(g.is_kind) === 1,
    departmentsWithout: Math.max(0, model.departmentCount - used),
    labels,
  };
}

/** GET /organisation/label-groups */
export async function listGroups(db, companyId) {
  const [model, [shifts]] = await Promise.all([
    ensureKind(db, companyId),
    // The choices of 'New positions start on' (spec §17.2), so the Labels sheet needs no other right to offer them.
    db.query("SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY id", [companyId]),
  ]);
  return { groups: model.groups.map((g) => shapeGroup(model, g)), departmentCount: model.departmentCount, shifts: shifts.map((x) => ({ id: x.id, code: x.code, name: x.name })) };
}

/* ── groups: writing ───────────────────────────────────────────────────── */

async function requireGroup(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM hrms_label_groups WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  if (!row) throw notFound('Label group');
  return row;
}

async function assertGroupNameFree(db, companyId, name, exceptId = 0) {
  const [[clash]] = await db.query(
    'SELECT id, name FROM hrms_label_groups WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id <> ?',
    [companyId, name, exceptId],
  );
  if (clash) {
    throw conflict('DUPLICATE', `The group "${clash.name}" already exists.`, {
      problems: [`"${clash.name}" is already a group. Group names are matched without case.`], detail: { groupId: clash.id },
    });
  }
}

const yesNo = (v, what) => {
  if ([true, 1, '1', 'true'].includes(v)) return 1;
  if ([false, 0, '0', 'false'].includes(v)) return 0;
  throw invalid('INVALID', `${what} must be yes or no.`, { problems: [`${what} must be yes or no.`] });
};

const groupOne = async (db, companyId, id) => {
  const model = await readModel(db, companyId);
  return shapeGroup(model, model.groupById.get(id));
};

/** POST /organisation/label-groups { name, isRequired? } */
export async function createGroup(db, c, body = {}) {
  await ensureKind(db, c.companyId, c.userId);
  const name = readName(body.name, 'A group');
  await assertGroupNameFree(db, c.companyId, name);
  const isRequired = body.isRequired === undefined ? 0 : yesNo(body.isRequired, 'Required');
  const [[last]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM hrms_label_groups WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const [res] = await db.query(
    'INSERT INTO hrms_label_groups (company_id, name, sort_order, is_required, is_kind, created_by) VALUES (?, ?, ?, ?, 0, ?)',
    [c.companyId, name, Number(last.n) + 1, isRequired, c.userId ?? null],
  );
  await audit(db, c, 'hrms_label_groups', res.insertId, 'CREATE', null, { name, isRequired: Boolean(isRequired) });
  const group = await groupOne(db, c.companyId, res.insertId);
  return { ...group, group };
}

/** PUT /organisation/label-groups/:id { name?, isRequired?, sortOrder? } — Kind stays required. */
export async function updateGroup(db, c, id, body = {}) {
  const before = await requireGroup(db, c.companyId, id);
  const after = {};
  if (body.name !== undefined) {
    const name = readName(body.name, 'A group');
    if (name !== before.name) {
      await assertGroupNameFree(db, c.companyId, name, id);
      await db.query('UPDATE hrms_label_groups SET name = ? WHERE company_id = ? AND id = ?', [name, c.companyId, id]);
      after.name = name;
    }
  }
  if (body.isRequired !== undefined) {
    const req = yesNo(body.isRequired, 'Required');
    if (Number(before.is_kind) === 1 && !req) {
      throw conflict('LOCKED', `${before.name} is always required: every department has a ${before.name} label.`);
    }
    if (req !== Number(before.is_required)) {
      await db.query('UPDATE hrms_label_groups SET is_required = ? WHERE company_id = ? AND id = ?', [req, c.companyId, id]);
      after.isRequired = Boolean(req);
    }
  }
  if (body.sortOrder !== undefined) {
    const n = Number(body.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 9999) {
      throw invalid('INVALID', 'The order must be a whole number.', { problems: ['The order must be a whole number from 0 to 9999.'] });
    }
    await db.query('UPDATE hrms_label_groups SET sort_order = ? WHERE company_id = ? AND id = ?', [n, c.companyId, id]);
    after.sortOrder = n;
  }
  if (Object.keys(after).length) {
    await audit(db, c, 'hrms_label_groups', id, 'UPDATE', { name: before.name, isRequired: Boolean(before.is_required), sortOrder: before.sort_order }, after);
  }
  const group = await groupOne(db, c.companyId, id);
  return { ...group, group };
}

/** PUT /organisation/label-groups/order { ids } — every group once, in the order wanted. */
export async function reorderGroups(db, c, body = {}) {
  const model = await ensureKind(db, c.companyId, c.userId);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;
  const have = new Set(model.groups.map((g) => g.id));
  if (!ids || ids.length !== model.groups.length || new Set(ids).size !== ids.length || ids.some((v) => !have.has(v))) {
    throw invalid('INVALID', 'Send every group once, in the order wanted.', {
      problems: [`There are ${model.groups.length} groups. Send the id of each one exactly once, in the order wanted.`],
    });
  }
  await db.query(
    `UPDATE hrms_label_groups SET sort_order = CASE id ${ids.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
    [...ids.flatMap((v, i) => [v, i + 1]), c.companyId, ids],
  );
  return listGroups(db, c.companyId);
}

/**
 * DELETE /organisation/label-groups/:id[?force=1]. Never Kind (409 LOCKED).
 * Used by departments and no force: 409 IN_USE with detail.departmentCount.
 * With force (or unused): its labels and every department's label in it go.
 */
export async function deleteGroup(db, c, id, { force = false } = {}) {
  const before = await requireGroup(db, c.companyId, id);
  if (Number(before.is_kind) === 1) {
    throw conflict('LOCKED', `${before.name} cannot be removed: every department has a ${before.name} label. Rename it or change its labels instead.`);
  }
  const [[used]] = await db.query(
    `SELECT COUNT(*) AS n FROM hrms_department_label_links k
       JOIN hrms_departments d ON d.company_id = k.company_id AND d.id = k.department_id AND d.deleted_at IS NULL
      WHERE k.company_id = ? AND k.group_id = ? AND k.deleted_at IS NULL`, [c.companyId, id]);
  const departmentCount = Number(used.n);
  if (departmentCount > 0 && !force) {
    const many = departmentCount !== 1;
    throw conflict('IN_USE', `${departmentCount} ${many ? 'departments have' : 'department has'} a ${before.name} label. Removing the group takes it off ${many ? 'them' : 'it'}.`, {
      problems: [`${departmentCount} ${many ? 'departments carry' : 'department carries'} a label of "${before.name}". Remove the group anyway to take ${many ? 'those labels' : 'that label'} off, or keep the group.`],
      detail: { departmentCount },
    });
  }
  const [unlinked] = await db.query('UPDATE hrms_department_label_links SET deleted_at = NOW() WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  const [labelsGone] = await db.query('UPDATE hrms_department_labels SET deleted_at = NOW() WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE hrms_label_groups SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(db, c, 'hrms_label_groups', id, 'DELETE', { name: before.name, departmentCount }, { labelsRemoved: labelsGone.affectedRows, linksRemoved: unlinked.affectedRows });
  return { ok: true, id, departmentsUnlabelled: departmentCount, labelsRemoved: labelsGone.affectedRows };
}

/* ── a department's labels: reading what a write asks for ──────────────── */

/**
 * `labels: { [groupId]: labelId | null }` from a department create / update,
 * checked against the model. Kind's entry (if any) comes back as `kind` (the
 * label row); every other group's as `set` (groupId -> labelId | null).
 * On create every required group must end up with a label (Kind has its own
 * fallback in the caller, so it is not asked for here).
 */
export function readLabelsInput(model, raw, { creating = false } = {}) {
  const problems = [];
  const set = new Map();
  let kind = null;
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    problems.push('Labels are given per group: { groupId: labelId }.');
    return { kind, set, problems };
  }
  for (const [key, value] of Object.entries(raw ?? {})) {
    const groupId = Number(key);
    const group = model.groupById.get(groupId);
    if (!group) { problems.push(`There is no label group "${String(key).slice(0, 20)}" in this company.`); continue; }
    if (value == null || value === '') {
      if (Number(group.is_required) === 1) problems.push(`${group.name}: choose a label. Every department has a ${group.name} label.`);
      else set.set(groupId, null);
      continue;
    }
    const label = model.labelById.get(Number(value));
    if (!label || label.group_id !== groupId) {
      const choices = model.labelsOf(groupId).map((l) => l.name).join(', ') || 'none yet';
      problems.push(`${group.name}: that is not one of this group's labels (${choices}).`);
      continue;
    }
    if (Number(group.is_kind) === 1) kind = label;
    else set.set(groupId, label.id);
  }
  if (creating) {
    for (const g of model.groups) {
      if (Number(g.is_required) === 1 && Number(g.is_kind) !== 1 && !set.get(g.id)) {
        problems.push(`${g.name}: choose a label. Every department has a ${g.name} label.`);
      }
    }
  }
  return { kind, set, problems };
}

/**
 * Writes a department's labels: `set` (groupId -> labelId | null) for groups
 * other than Kind, and `kindLabelId` for Kind (the caller writes the name into
 * department_type in the same transaction). A link that changes is retired and
 * a new one written — one live link per (department, group).
 * -> { before: { groupId: labelId }, after: { groupId: labelId } } of what changed
 */
export async function writeDepartmentLabels(db, c, departmentId, { set = new Map(), kindGroupId = null, kindLabelId = null } = {}) {
  const wanted = new Map(set);
  if (kindGroupId && kindLabelId) wanted.set(kindGroupId, kindLabelId);
  if (!wanted.size) return { before: {}, after: {} };
  const [current] = await db.query(
    'SELECT id, group_id, label_id FROM hrms_department_label_links WHERE company_id = ? AND department_id = ? AND deleted_at IS NULL',
    [c.companyId, departmentId],
  );
  const now = new Map(current.map((k) => [k.group_id, k]));
  const before = {};
  const after = {};
  const retire = [];
  const add = [];
  for (const [groupId, labelId] of wanted) {
    const link = now.get(groupId);
    if ((link?.label_id ?? null) === (labelId ?? null)) continue;
    before[groupId] = link?.label_id ?? null;
    after[groupId] = labelId ?? null;
    if (link) retire.push(link.id);
    if (labelId) add.push([c.companyId, departmentId, groupId, labelId, c.userId ?? null]);
  }
  if (retire.length) await db.query('UPDATE hrms_department_label_links SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, retire]);
  if (add.length) {
    await db.query(
      `INSERT INTO hrms_department_label_links (company_id, department_id, group_id, label_id, created_by) VALUES ${add.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      add.flat(),
    );
  }
  return { before, after };
}

/** A department removed: its links go with it. */
export async function retireDepartmentLabels(db, c, departmentId) {
  await db.query('UPDATE hrms_department_label_links SET deleted_at = NOW() WHERE company_id = ? AND department_id = ? AND deleted_at IS NULL', [c.companyId, departmentId]);
}

/* ── filters: "label=" on the lists ─────────────────────────────────────── */

/**
 * What the lists' `label` filter needs, read once: each live department's label
 * ids, each label's group, and labels by name (an address may still name a Kind
 * label, as §13.6 had it). Two queries.
 */
export async function labelIndex(db, companyId) {
  const [[departments], [labels]] = await Promise.all([
    db.query(`SELECT d.id, ${DEPARTMENT_LABELS_SQL('d')} AS label_list FROM hrms_departments d WHERE d.company_id = ? AND d.deleted_at IS NULL`, [companyId]),
    db.query('SELECT id, group_id, name FROM hrms_department_labels WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
  ]);
  const ofDepartment = new Map(departments.map((d) => [d.id, new Set(parseLabelList(d.label_list).map((l) => l.labelId))]));
  const groupOf = new Map(labels.map((l) => [l.id, l.group_id]));
  const byName = new Map();
  for (const l of labels) byName.set(l.name.toLowerCase(), [...(byName.get(l.name.toLowerCase()) ?? []), l.id]);
  return { ofDepartment, groupOf, byName };
}

/**
 * The test for one address value: label ids (or names), comma-separated.
 * Labels of ONE group are "any of"; groups combine as "and". An id that is not
 * a label of this company matches nothing.
 */
export function labelMatcher(index, value) {
  const tokens = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const byGroup = new Map();
  for (const t of tokens) {
    const ids = /^\d+$/.test(t) ? [Number(t)] : (index.byName.get(t.toLowerCase()) ?? []);
    if (!ids.length) { byGroup.set(`none:${t}`, new Set()); continue; }
    for (const id of ids) {
      const g = index.groupOf.get(id) ?? `none:${id}`;
      if (!byGroup.has(g)) byGroup.set(g, new Set());
      if (index.groupOf.has(id)) byGroup.get(g).add(id);
    }
  }
  return (departmentId) => {
    if (!byGroup.size) return true;
    const mine = index.ofDepartment.get(Number(departmentId));
    if (!mine) return false;
    for (const wanted of byGroup.values()) if (![...wanted].some((id) => mine.has(id))) return false;
    return true;
  };
}

export default {
  KIND_GROUP, DEFAULT_LABELS, DEPARTMENT_LABELS_SQL, parseLabelList, readName, readModel, ensureKind, shapeGroup,
  listGroups, createGroup, updateGroup, reorderGroups, deleteGroup,
  readLabelsInput, writeDepartmentLabels, retireDepartmentLabels, labelIndex, labelMatcher,
};
