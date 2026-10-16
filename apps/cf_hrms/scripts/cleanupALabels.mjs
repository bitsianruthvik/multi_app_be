/**
 * cleanupALabels.mjs — the label migration of apply-cleanup-a.mjs, as two
 * functions with no connection of their own, so the script and the test
 * (scripts/cf_hrms/label_test.mjs, section 10) run the SAME code:
 *
 *   planLabels(departments, labels)        pure: what would change for one company
 *   applyLabels(conn, companyId, plan)     writes it, on the caller's connection
 *
 * The mapping (TM/CF_HRMS_HIRING_SPEC.md §9):
 *     Process          -> Section
 *     Shared crew      -> Section, and the department is marked shared
 *     Machine / area   -> Machine
 *     no label         -> Department
 * matched without case. Any other label is kept and added to the company's list.
 */
export const TABLE = 'hrms_department_labels';
export const DEFAULTS = ['Department', 'Section', 'Machine'];
export const NO_LABEL = '(no label)';

/** old label (lower case) -> { to, shared } */
const RENAMES = new Map([
  ['process', { to: 'Section', shared: false }],
  ['shared crew', { to: 'Section', shared: true }],
  ['machine / area', { to: 'Machine', shared: false }],
]);

const norm = (v) => String(v ?? '').trim();
const key = (v) => norm(v).toLowerCase();

/** The label a department has after the rename. */
export function renamed(label) {
  const k = key(label);
  if (!k) return 'Department';
  return RENAMES.get(k)?.to ?? norm(label);
}

function countBy(rows, labelOf) {
  const out = new Map();
  for (const r of rows) {
    const name = labelOf(r) || NO_LABEL;
    const hit = [...out.keys()].find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
    out.set(hit, (out.get(hit) ?? 0) + 1);
  }
  return Object.fromEntries([...out.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * @param departments [{ id, department_type, is_shared, deleted_at }] — EVERY department of the company, deleted ones too
 * @param labels      [{ id, name, sort_order }] — its live labels (empty when it has no list yet)
 * @returns {{
 *   rename: Map<string, number[]>,   new label -> department ids
 *   share: number[],                 department ids to mark shared
 *   add: string[],                   labels the list gains, in order
 *   before, after: { [label]: count }   live departments per label
 *   sharedBefore, sharedAfter: number,
 *   nothing: boolean,
 * }}
 */
export function planLabels(departments, labels) {
  const live = departments.filter((d) => d.deleted_at == null);
  const rename = new Map();
  for (const d of departments) {
    const to = renamed(d.department_type);
    if (to !== (d.department_type ?? null)) rename.set(to, [...(rename.get(to) ?? []), d.id]);
  }
  const willShare = (d) => Boolean(RENAMES.get(key(d.department_type))?.shared);
  const share = departments.filter((d) => willShare(d) && !d.is_shared).map((d) => d.id);

  // The defaults only for a company with no list at all — a label somebody removed stays removed.
  const have = new Set(labels.map((l) => l.name.toLowerCase()));
  const wanted = labels.length ? [] : [...DEFAULTS];
  for (const d of live) {
    const name = renamed(d.department_type);
    if (!have.has(name.toLowerCase()) && !wanted.some((w) => w.toLowerCase() === name.toLowerCase())) wanted.push(name);
  }
  const add = wanted.filter((w) => !have.has(w.toLowerCase()));

  return {
    rename,
    share,
    add,
    before: countBy(live, (d) => norm(d.department_type)),
    after: countBy(live, (d) => renamed(d.department_type)),
    sharedBefore: live.filter((d) => d.is_shared).length,
    sharedAfter: live.filter((d) => d.is_shared || willShare(d)).length,
    renameCount: [...rename.values()].reduce((n, ids) => n + ids.length, 0),
    nothing: rename.size === 0 && share.length === 0 && add.length === 0,
  };
}

/** One UPDATE per new label, not per department; one INSERT for the list. */
export async function applyLabels(conn, companyId, plan, labels = []) {
  if (plan.share.length) await conn.query('UPDATE hrms_departments SET is_shared = 1 WHERE company_id = ? AND id IN (?)', [companyId, plan.share]);
  for (const [to, ids] of plan.rename) {
    await conn.query('UPDATE hrms_departments SET department_type = ? WHERE company_id = ? AND id IN (?)', [to, companyId, ids]);
  }
  if (plan.add.length) {
    const base = labels.reduce((m, l) => Math.max(m, Number(l.sort_order)), 0);
    await conn.query(
      `INSERT INTO ${TABLE} (company_id, name, sort_order) VALUES ${plan.add.map(() => '(?, ?, ?)').join(', ')}`,
      plan.add.flatMap((name, i) => [companyId, name.slice(0, 40), base + i + 1]),
    );
  }
}

/** Everything planLabels needs for one company, in two reads. */
export async function readCompany(conn, companyId, { tableExists = true } = {}) {
  const [departments] = await conn.query('SELECT id, department_type, is_shared, deleted_at FROM hrms_departments WHERE company_id = ?', [companyId]);
  const [labels] = tableExists
    ? await conn.query(`SELECT id, name, sort_order FROM ${TABLE} WHERE company_id = ? AND deleted_at IS NULL ORDER BY sort_order, id`, [companyId])
    : [[]];
  return { departments, labels };
}
