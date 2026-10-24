/**
 * labelGroupService.js — the company's department labels: ONE label per
 * department (TM/CF_HRMS_HIRING_SPEC.md §9; §15 groups removed 2026-10-16).
 *
 * The user (2026-10-16): "only one label for a department … one label and a
 * name for every department, so we can filter and use the labels for a bunch
 * of operations later." So every department has exactly one label, always.
 *
 * THE TABLES OF §15 STAY (no schema churn): hrms_label_groups keeps one row per
 * company, the `is_kind` group, and every label lives in it. Nothing here reads
 * or writes any other group; a label left in another group (none exists) is
 * invisible. The word "group" is not shown anywhere.
 *
 * WHERE A DEPARTMENT'S LABEL LIVES
 *   hrms_departments.department_type holds the label's NAME (matched without
 *   case) — the column every reader already keeps right (a rename renames it,
 *   remove-with-move-to moves it). A link row (hrms_department_label_links) is
 *   written beside it in the same transaction, so the table stays whole.
 *   DEPARTMENT_LABEL_ID_SQL is the one read of "this department's label id".
 *
 * THE LIST IS MADE ON FIRST USE (ensureKind): a company with none gets the
 * group and its defaults (Department, Section, Machine + any name its
 * departments already carry); a label with no group is moved into it.
 *
 * Nothing here branches on a label's words. A label is what the company calls
 * something, nothing more.
 */
import { invalid } from '../lib/errors.js';

export const KIND_GROUP = 'Kind';
export const DEFAULT_LABELS = ['Department', 'Section', 'Machine'];
const MAX = 40;

/**
 * A department's label id as ONE column (alias `d` = hrms_departments): the
 * label whose name is the department's department_type, without case.
 */
export const DEPARTMENT_LABEL_ID_SQL = (d = 'd') => `(
  SELECT l.id FROM hrms_department_labels l
    JOIN hrms_label_groups g ON g.company_id = l.company_id AND g.id = l.group_id AND g.is_kind = 1 AND g.deleted_at IS NULL
   WHERE l.company_id = ${d}.company_id AND l.deleted_at IS NULL AND LOWER(l.name) = LOWER(${d}.department_type)
   ORDER BY l.id LIMIT 1)`;

/* ── names ─────────────────────────────────────────────────────────────── */

export function readName(value, what = 'A label') {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw invalid('INVALID', `${what} needs a name.`, { problems: [`${what} needs a name.`] });
  if (name.length > MAX) {
    throw invalid('INVALID', `${what} is up to ${MAX} characters.`, { problems: [`${what} is up to ${MAX} characters. It is a word or two, not a description.`] });
  }
  return name;
}

/* ── the model: the company's labels ───────────────────────────────────── */

/**
 * The company's labels, with how many live departments carry each one (by
 * department_type, without case). `kind` is the group row the labels live in;
 * `orphans` are labels with no live group (an older backend's), for ensureKind.
 */
export async function readModel(db, companyId) {
  const [[groups], [labels]] = await Promise.all([
    db.query(
      `SELECT id, name, sort_order, is_kind FROM hrms_label_groups
        WHERE company_id = ? AND deleted_at IS NULL ORDER BY is_kind DESC, sort_order, id`, [companyId]),
    db.query(
      `SELECT l.id, l.group_id, l.name, l.sort_order, l.colour, IF(s.id IS NULL, NULL, l.default_shift_id) AS default_shift_id,
              (SELECT COUNT(*) FROM hrms_departments d
                WHERE d.company_id = l.company_id AND d.deleted_at IS NULL AND LOWER(d.department_type) = LOWER(l.name)) AS department_count
         FROM hrms_department_labels l
         LEFT JOIN hrms_shifts s ON s.company_id = l.company_id AND s.id = l.default_shift_id AND s.deleted_at IS NULL
        WHERE l.company_id = ? AND l.deleted_at IS NULL
        ORDER BY l.sort_order, l.id`, [companyId]),
  ]);
  return modelOf(groups, labels);
}

/** The labels in ONE query, without the counts — for readers that only need the list (the Excel files). */
export async function readLists(db, companyId) {
  const [rows] = await db.query(
    `SELECT g.id AS gid, g.name AS gname, g.sort_order AS gsort, g.is_kind, l.id, l.name, l.sort_order, l.colour,
            IF(s.id IS NULL, NULL, l.default_shift_id) AS default_shift_id
       FROM hrms_label_groups g
       LEFT JOIN hrms_department_labels l ON l.company_id = g.company_id AND l.group_id = g.id AND l.deleted_at IS NULL
       LEFT JOIN hrms_shifts s ON s.company_id = l.company_id AND s.id = l.default_shift_id AND s.deleted_at IS NULL
      WHERE g.company_id = ? AND g.deleted_at IS NULL AND g.is_kind = 1
      ORDER BY l.sort_order, l.id`, [companyId]);
  if (!rows.some((r) => r.id != null)) return ensureKind(db, companyId);
  const kind = { id: rows[0].gid, name: rows[0].gname, sort_order: rows[0].gsort, is_kind: 1 };
  const labels = rows.filter((r) => r.id != null)
    .map((r) => ({ id: r.id, group_id: r.gid, name: r.name, sort_order: r.sort_order, colour: r.colour ?? null, default_shift_id: r.default_shift_id ?? null }));
  return modelOf([kind], labels);
}

function modelOf(groups, labels) {
  const kind = groups.find((g) => Number(g.is_kind) === 1) ?? null;
  const live = new Set(groups.map((g) => g.id));
  const kindLabels = kind ? labels.filter((l) => l.group_id === kind.id) : [];
  return {
    kind,
    /** THE list: the labels a department may carry, in the company's order. */
    labels: kindLabels,
    kindLabels,
    labelById: new Map(kindLabels.map((l) => [l.id, l])),
    orphans: labels.filter((l) => l.group_id == null || !live.has(l.group_id)),
  };
}

/**
 * The company's label group, made when missing; labels with no group moved
 * into it; and the list seeded (Department, Section, Machine + every other name
 * its departments already carry) when it is empty. INSERT IGNORE on the unique
 * keys, so two first reads at once write one group and one list.
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
  if (!model.kind) throw new Error('[cf_hrms] the label list could not be made.');
  // Labels an older backend wrote with no group, or left in a group that is gone.
  if (model.orphans.length) {
    // One the list already has under the same name is a duplicate: labels are matched by name, so it is retired.
    const twins = model.orphans.filter((o) => model.labels.some((k) => k.name.toLowerCase() === o.name.toLowerCase())).map((o) => o.id);
    if (twins.length) await db.query('UPDATE hrms_department_labels SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, twins]);
    await db.query(
      `UPDATE hrms_department_labels l SET l.group_id = ?
        WHERE l.company_id = ? AND (l.group_id IS NULL OR NOT EXISTS
              (SELECT 1 FROM hrms_label_groups g WHERE g.company_id = l.company_id AND g.id = l.group_id))`,
      [model.kind.id, companyId]);
    wrote = true;
  }
  if (!wrote && model.labels.length) return model;
  if (wrote) model = await readModel(db, companyId);
  if (model.labels.length) return model;
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

/* ── a department's label: the link row beside department_type ─────────── */

/** Writes the department's one link (retiring an older one) when it changed. -> { before, after } label ids */
export async function linkDepartmentLabel(db, c, departmentId, { groupId, labelId }) {
  if (!groupId || !labelId) return { before: null, after: null };
  const [current] = await db.query(
    'SELECT id, label_id FROM hrms_department_label_links WHERE company_id = ? AND department_id = ? AND group_id = ? AND deleted_at IS NULL',
    [c.companyId, departmentId, groupId],
  );
  if (current.length === 1 && current[0].label_id === labelId) return { before: labelId, after: labelId };
  if (current.length) {
    await db.query('UPDATE hrms_department_label_links SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, current.map((k) => k.id)]);
  }
  await db.query(
    'INSERT INTO hrms_department_label_links (company_id, department_id, group_id, label_id, created_by) VALUES (?, ?, ?, ?, ?)',
    [c.companyId, departmentId, groupId, labelId, c.userId ?? null],
  );
  return { before: current[0]?.label_id ?? null, after: labelId };
}

/** A department removed: its link goes with it. */
export async function retireDepartmentLabels(db, c, departmentId) {
  await db.query('UPDATE hrms_department_label_links SET deleted_at = NOW() WHERE company_id = ? AND department_id = ? AND deleted_at IS NULL', [c.companyId, departmentId]);
}

/* ── filters: "label=" on the lists ─────────────────────────────────────── */

/**
 * What the lists' `label` filter needs, read once: each live department's
 * label id, and labels by name and by id (an address may name a label, as §13.6 had it).
 */
export async function labelIndex(db, companyId) {
  const [[departments], [labels]] = await Promise.all([
    db.query(`SELECT d.id, ${DEPARTMENT_LABEL_ID_SQL('d')} AS label_id FROM hrms_departments d WHERE d.company_id = ? AND d.deleted_at IS NULL`, [companyId]),
    db.query(
      `SELECT l.id, l.name FROM hrms_department_labels l
         JOIN hrms_label_groups g ON g.company_id = l.company_id AND g.id = l.group_id AND g.is_kind = 1 AND g.deleted_at IS NULL
        WHERE l.company_id = ? AND l.deleted_at IS NULL`, [companyId]),
  ]);
  const ofDepartment = new Map(departments.map((d) => [d.id, d.label_id == null ? null : Number(d.label_id)]));
  const known = new Set(labels.map((l) => l.id));
  const byName = new Map(labels.map((l) => [l.name.toLowerCase(), l.id]));
  const names = new Map(labels.map((l) => [l.id, l.name]));
  return { ofDepartment, known, byName, names };
}

/**
 * The test for one address value: label ids (or names), comma-separated —
 * "any of". A value that is not a label of this company matches nothing.
 */
export function labelMatcher(index, value) {
  const tokens = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!tokens.length) return () => true;
  const wanted = new Set();
  for (const t of tokens) {
    const id = /^\d+$/.test(t) ? Number(t) : index.byName.get(t.toLowerCase());
    if (id != null && index.known.has(id)) wanted.add(id);
  }
  return (departmentId) => {
    const mine = index.ofDepartment.get(Number(departmentId));
    return mine != null && wanted.has(mine);
  };
}

export default {
  KIND_GROUP, DEFAULT_LABELS, DEPARTMENT_LABEL_ID_SQL, readName, readModel, readLists, ensureKind,
  linkDepartmentLabel, retireDepartmentLabels, labelIndex, labelMatcher,
};
