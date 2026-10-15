/**
 * labelGroupsMigration.mjs — the code apply-label-groups.mjs runs, kept apart so
 * scripts/cf_hrms/label_groups_test.mjs runs the SAME code on a real company
 * inside a transaction it rolls back. (TM/CF_HRMS_HIRING_SPEC.md §15.1.)
 *
 *   schemaSteps(conn)                what DDL is missing -> [{ what, sql }]
 *   readCompany(conn, companyId)     its groups, labels, departments, links
 *   planCompany(state)               what would change, and the counts before / after
 *   applyCompany(conn, companyId, plan, userId?)
 *
 * PER COMPANY:
 *   1. the group Kind (required) — made when missing;
 *   2. every label with no group (or a group that is gone) moves into Kind;
 *   3. a Kind label for every department_type the departments use and Kind
 *      lacks; a department with no label gets the first Kind label (Department);
 *   4. every live department linked to its Kind label, read from
 *      department_type (without case) — a missing link is written, a link to
 *      another label is retired and replaced.
 * Nothing else: no department changes its Kind, no other group is touched.
 * Idempotent — a second run plans nothing.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const KIND = 'Kind';
export const DEFAULTS = ['Department', 'Section', 'Machine'];

const initSql = () => fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/init.sql'), 'utf8');

/** The CREATE TABLE text of a table, out of models/init.sql — never retyped here. */
export function createOf(table, sql = initSql()) {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`init.sql has no CREATE TABLE for ${table}`);
  return sql.slice(start, sql.indexOf(';', sql.indexOf('\n)', start)));
}

const tableThere = async (conn, t) => Number((await conn.query('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]))[0][0].n) > 0;
const columnThere = async (conn, t, c) => Number((await conn.query('SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]))[0][0].n) > 0;
const indexThere = async (conn, t, i) => Number((await conn.query('SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [t, i]))[0][0].n) > 0;

/** The DDL still missing, in the order it must run. One change per statement (TiDB). */
export async function schemaSteps(conn) {
  const sql = initSql();
  const steps = [];
  if (!await tableThere(conn, 'hrms_label_groups')) steps.push({ what: 'create hrms_label_groups', sql: createOf('hrms_label_groups', sql) });
  if (!await columnThere(conn, 'hrms_department_labels', 'group_id')) {
    steps.push({ what: 'add hrms_department_labels.group_id', sql: 'ALTER TABLE hrms_department_labels ADD COLUMN group_id INT NULL AFTER company_id' });
  }
  if (!await indexThere(conn, 'hrms_department_labels', 'uq_hdlb_group_name')) {
    steps.push({ what: 'add unique key uq_hdlb_group_name (a name once per group)', sql: 'ALTER TABLE hrms_department_labels ADD UNIQUE KEY uq_hdlb_group_name (company_id, group_id, name_active)' });
  }
  if (await indexThere(conn, 'hrms_department_labels', 'uq_hdlb_name')) {
    steps.push({ what: 'drop unique key uq_hdlb_name (a name once per company)', sql: 'ALTER TABLE hrms_department_labels DROP INDEX uq_hdlb_name' });
  }
  if (!await tableThere(conn, 'hrms_department_label_links')) steps.push({ what: 'create hrms_department_label_links', sql: createOf('hrms_department_label_links', sql) });
  return steps;
}

/** Everything about one company the plan needs. Works before the new tables exist (they read as empty). */
export async function readCompany(conn, companyId, { schemaReady = true } = {}) {
  const q = async (s, p) => (await conn.query(s, p))[0];
  const [departments, labels] = await Promise.all([
    q('SELECT id, name, department_type, deleted_at FROM hrms_departments WHERE company_id = ? ORDER BY id', [companyId]),
    q(`SELECT id, ${schemaReady ? 'group_id' : 'NULL AS group_id'}, name, sort_order, deleted_at FROM hrms_department_labels WHERE company_id = ? ORDER BY sort_order, id`, [companyId]),
  ]);
  const groups = schemaReady ? await q('SELECT id, name, sort_order, is_required, is_kind FROM hrms_label_groups WHERE company_id = ? AND deleted_at IS NULL ORDER BY sort_order, id', [companyId]) : [];
  const links = schemaReady ? await q('SELECT id, department_id, group_id, label_id FROM hrms_department_label_links WHERE company_id = ? AND deleted_at IS NULL', [companyId]) : [];
  return { companyId, departments, labels, groups, links };
}

const lower = (v) => String(v ?? '').trim().toLowerCase();
const countBy = (rows, key) => { const out = {}; for (const r of rows) { const k = key(r); out[k] = (out[k] ?? 0) + 1; } return out; };

/**
 * What would change. Pure.
 * -> { nothing, makeKind, moveLabels: [labelId], addLabels: [name], blankDepartments: [id],
 *      link: [{ departmentId, labelName }], relink: [{ departmentId, linkId, labelName }],
 *      before: { byType, kindLinks }, after: { byType, kindLinks } }
 */
export function planCompany(state) {
  const kind = state.groups.find((g) => Number(g.is_kind) === 1) ?? null;
  const groupIds = new Set(state.groups.map((g) => g.id));
  const moveLabels = state.labels.filter((l) => l.group_id == null || !groupIds.has(l.group_id)).map((l) => l.id);
  const liveKindLabels = state.labels.filter((l) => l.deleted_at == null && (moveLabels.includes(l.id) || (kind && l.group_id === kind.id)));
  const kindNames = liveKindLabels.map((l) => l.name);
  const live = state.departments.filter((d) => d.deleted_at == null);
  const blankDepartments = live.filter((d) => !String(d.department_type ?? '').trim()).map((d) => d.id);
  const firstKind = kindNames[0] ?? DEFAULTS[0];
  const typeOf = (d) => (blankDepartments.includes(d.id) ? firstKind : String(d.department_type).trim());
  const addLabels = [];
  if (!kindNames.length) addLabels.push(...DEFAULTS);
  for (const d of live) {
    const t = typeOf(d);
    if (![...kindNames, ...addLabels].some((n) => lower(n) === lower(t))) addLabels.push(t);
  }
  // Each live department's Kind link, against its department_type.
  const nameOfLabel = new Map(state.labels.map((l) => [l.id, l.name]));
  const kindLinkOf = new Map(kind ? state.links.filter((k) => k.group_id === kind.id).map((k) => [k.department_id, k]) : []);
  const link = [];
  const relink = [];
  for (const d of live) {
    const want = typeOf(d);
    const have = kindLinkOf.get(d.id);
    if (!have) link.push({ departmentId: d.id, labelName: want });
    else if (lower(nameOfLabel.get(have.label_id)) !== lower(want) || !liveKindLabels.some((l) => l.id === have.label_id)) {
      relink.push({ departmentId: d.id, linkId: have.id, labelName: want });
    }
  }
  const byTypeBefore = countBy(live, (d) => String(d.department_type ?? '').trim() || '(no label)');
  const byTypeAfter = countBy(live, typeOf);
  const kindLinksBefore = countBy([...kindLinkOf.values()].filter((k) => live.some((d) => d.id === k.department_id)), (k) => nameOfLabel.get(k.label_id) ?? '?');
  return {
    nothing: Boolean(kind) && !moveLabels.length && !addLabels.length && !blankDepartments.length && !link.length && !relink.length,
    makeKind: !kind,
    moveLabels, addLabels, blankDepartments, link, relink,
    before: { byType: byTypeBefore, kindLinks: kindLinksBefore },
    after: { byType: byTypeAfter, kindLinks: byTypeAfter },
  };
}

/** Writes the plan, on the caller's transaction. */
export async function applyCompany(conn, companyId, plan, userId = null) {
  if (plan.nothing) return;
  const q = async (s, p) => (await conn.query(s, p))[0];
  let [kind] = await q('SELECT id FROM hrms_label_groups WHERE company_id = ? AND deleted_at IS NULL AND is_kind = 1', [companyId]);
  if (!kind) {
    const [named] = await q('SELECT id FROM hrms_label_groups WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?)', [companyId, KIND]);
    if (named) await q('UPDATE hrms_label_groups SET is_kind = 1, is_required = 1 WHERE company_id = ? AND id = ?', [companyId, named.id]);
    else await q('INSERT INTO hrms_label_groups (company_id, name, sort_order, is_required, is_kind, created_by) VALUES (?, ?, 0, 1, 1, ?)', [companyId, KIND, userId]);
    [kind] = await q('SELECT id FROM hrms_label_groups WHERE company_id = ? AND deleted_at IS NULL AND is_kind = 1', [companyId]);
  }
  if (plan.moveLabels.length) await q('UPDATE hrms_department_labels SET group_id = ? WHERE company_id = ? AND id IN (?)', [kind.id, companyId, plan.moveLabels]);
  if (plan.addLabels.length) {
    const [[last]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM hrms_department_labels WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL', [companyId, kind.id]);
    await q(
      `INSERT INTO hrms_department_labels (company_id, group_id, name, sort_order, created_by) VALUES ${plan.addLabels.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      plan.addLabels.flatMap((n, i) => [companyId, kind.id, n.slice(0, 40), Number(last.n) + i + 1, userId]),
    );
  }
  const labels = await q('SELECT id, name FROM hrms_department_labels WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL ORDER BY sort_order, id', [companyId, kind.id]);
  const idOf = (name) => labels.find((l) => lower(l.name) === lower(name))?.id;
  if (plan.blankDepartments.length) {
    await q('UPDATE hrms_departments SET department_type = ? WHERE company_id = ? AND id IN (?)', [labels[0].name, companyId, plan.blankDepartments]);
  }
  if (plan.relink.length) await q('UPDATE hrms_department_label_links SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [companyId, plan.relink.map((r) => r.linkId)]);
  const rows = [...plan.link, ...plan.relink].map((r) => [companyId, r.departmentId, kind.id, idOf(r.labelName), userId]);
  if (rows.some((r) => !r[3])) throw new Error(`A department's label has no Kind label to link to (company ${companyId}).`);
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    // eslint-disable-next-line no-await-in-loop -- 200 rows a statement
    await q(`INSERT INTO hrms_department_label_links (company_id, department_id, group_id, label_id, created_by) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`, part.flat());
  }
}

export default { KIND, DEFAULTS, createOf, schemaSteps, readCompany, planCompany, applyCompany };
