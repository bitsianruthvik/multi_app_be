/**
 * cleanup_a_test.mjs — clean-up round A (2026-10-12).
 * Contract: TM/CF_HRMS_HIRING_SPEC.md §9 (department labels), §10 (positions
 * held, moving a person) and §11 (one code generator for everything).
 *
 *   1. LABELS: the defaults on first read; add; a rename reaches every
 *      department; reorder; delete in use with and without moveTo; the list
 *      never empties; a department cannot take a label that is not in the list;
 *   2. THE MIGRATION (apps/cf_hrms/scripts/cleanupALabels.mjs — the same code
 *      the script runs): Process -> Section, Shared crew -> Section + shared,
 *      Machine / area -> Machine, no label -> Department; twice changes nothing;
 *   3. CODES for departments, roles, positions and locations: the default rule
 *      on first use; a code a client sends is ignored on create and on update;
 *      a code already in use is stepped over; a rolled-back create gives its
 *      number back; add-sibling goes through the generator; the tokens render;
 *   4. POSITIONS HELD and MOVE: the old position ends the day before; the
 *      refusals; a second position; a move on a later date; how each ended;
 *   5. another company; 6. permissions, through the real middleware.
 *
 *   node scripts/cf_hrms/cleanup_a_test.mjs [--company=karni] [--verbose]
 *
 * NOTHING IS LEFT BEHIND. Every write is in a transaction that is ROLLED BACK.
 * The end re-reads every hrms_ row count and every code rule and counter of
 * both companies used.
 *
 * Local only — it refuses a non-local DB_HOST.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import { generate } from '../../apps/cf_erp/modules/codegen/index.js';
import { createScheme } from '../../apps/cf_erp/modules/codegen/service.js';
import * as LABELS from '../../apps/cf_hrms/services/departmentLabelService.js';
import * as ORG from '../../apps/cf_hrms/services/organisationService.js';
import * as RC from '../../apps/cf_hrms/services/roleContentService.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import * as HIRE from '../../apps/cf_hrms/services/hiringService.js';
import * as HELD from '../../apps/cf_hrms/services/employeePositionsService.js';
import { initials, cardCodeOf } from '../../apps/cf_hrms/services/codegenProvider.js';
import { planLabels, applyLabels, readCompany, renamed } from '../../apps/cf_hrms/scripts/cleanupALabels.mjs';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
if (!['localhost', '127.0.0.1', '::1'].includes(String(process.env.DB_HOST ?? 'localhost'))) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const skipped = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; if (VERBOSE) console.log(`  ok    ${name}`); } else { failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  return Boolean(cond);
};
const skip = (name, reason) => { skipped.push(`${name}: ${reason}`); };
const section = (title) => console.log(`\n${title}`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const refused = (e, status, code) => Boolean(e) && e.status === status && e.code === code;
const why = (e) => (e ? `${e.status ?? '?'} ${e.code ?? ''} ${e.message ?? ''} ${JSON.stringify(e.problems ?? '')}` : 'nothing was thrown');

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company "${slug}".`); process.exit(2); }
const COMPANY = company.id;
const TAG = `ZZCA${Date.now().toString(36).toUpperCase().slice(-5)}`;
const [[adminUser]] = await pool.query(
  `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);
const c = { companyId: COMPANY, userId: adminUser?.id ?? null };
// The other company: one with no departments and no code rules, so "first use" really is the first.
const [[other]] = await pool.query(
  `SELECT co.id, co.name FROM companies co
    WHERE co.id <> ? AND co.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM hrms_departments d WHERE d.company_id = co.id)
      AND NOT EXISTS (SELECT 1 FROM cf_code_schemes s WHERE s.company_id = co.id AND s.entity_type LIKE 'hrms\\_%' AND s.deleted_at IS NULL)
    ORDER BY co.id LIMIT 1`, [COMPANY]);
if (!other) { console.error('This test needs a second company with no departments and no hrms code rules.'); process.exit(2); }
const OTHER = other.id;
const there = { companyId: OTHER, userId: null };

const pad2 = (n) => String(n).padStart(2, '0');
const dayText = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = dayText(new Date());
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return dayText(d); };
const day = (v) => (v == null ? null : (v instanceof Date ? dayText(v) : String(v).slice(0, 10)));

const hrmsTables = (await pool.query(
  "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'hrms\\_%' ORDER BY TABLE_NAME"))[0].map((r) => r.t);
const snapshot = async () => {
  const out = {};
  for (const t of hrmsTables) {
    const [[r]] = await pool.query(`SELECT COUNT(*) AS total, SUM(deleted_at IS NULL) AS live FROM ${t} WHERE company_id IN (?, ?)`, [COMPANY, OTHER]);
    out[t] = `${r.total}/${r.live ?? 0}`;
  }
  const [[rules]] = await pool.query("SELECT COUNT(*) AS n FROM cf_code_schemes WHERE company_id IN (?, ?) AND entity_type LIKE 'hrms\\_%'", [COMPANY, OTHER]);
  const [counters] = await pool.query(
    `SELECT q.scheme_id, q.seq_key, q.next_value FROM cf_code_sequences q JOIN cf_code_schemes s ON s.id = q.scheme_id
      WHERE q.company_id IN (?, ?) AND s.entity_type LIKE 'hrms\\_%' ORDER BY q.scheme_id, q.seq_key`, [COMPANY, OTHER]);
  out.codeRules = String(rules.n);
  out.codeCounters = counters.map((r) => `${r.scheme_id}:${r.seq_key}=${r.next_value}`).join(',');
  const [[labels]] = await pool.query(
    "SELECT GROUP_CONCAT(CONCAT(company_id, ':', COALESCE(department_type, '-'), ':', is_shared) ORDER BY id SEPARATOR '|') AS s FROM hrms_departments WHERE company_id IN (?, ?)", [COMPANY, OTHER]);
  out.departmentLabels = labels.s ?? '';
  return out;
};
const baseline = await snapshot();
console.log(`cleanup_a_test — ${company.name} (${COMPANY}), run tag ${TAG}, today ${today}; the other company is ${other.name} (${OTHER})`);

async function rolledBack(fn) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await fn(db);
  } finally {
    try { await db.rollback(); } catch { /* nothing to undo */ }
    db.release();
  }
}
const names = (list) => list.labels.map((l) => l.name);
const typeOf = async (db, id) => (await db.query('SELECT department_type, is_shared, code FROM hrms_departments WHERE id = ?', [id]))[0][0];

/* ══ 1. labels ════════════════════════════════════════════════════════════ */
section('[1] Department labels');
await rolledBack(async (db) => {
  // ── a company that has never had a list ──
  const first = await LABELS.listLabels(db, OTHER);
  ok(JSON.stringify(names(first)) === JSON.stringify(['Department', 'Section', 'Machine']) && first.labels.every((l, i) => l.sortOrder === i + 1 && l.departmentCount === 0 && l.id > 0)
    // defaultShiftId joined on 2026-10-15 (§17.2, 'New positions start on' — none to begin with); the group fields
    // of §15 left again on 2026-10-16 (one label per department).
    && JSON.stringify(Object.keys(first.labels[0])) === JSON.stringify(['id', 'name', 'sortOrder', 'departmentCount', 'defaultShiftId']) && first.labels.every((l) => l.defaultShiftId === null),
  'a company with no list gets Department, Section, Machine the first time it is read: { labels: [{ id, name, sortOrder, departmentCount, defaultShiftId }] }', JSON.stringify(first.labels));
  ok(JSON.stringify((await LABELS.listLabels(db, OTHER)).labels.map((l) => l.id)) === JSON.stringify(first.labels.map((l) => l.id)), 'a second read writes nothing more');
  await db.query('DELETE FROM hrms_department_labels WHERE company_id = ?', [OTHER]);
  await db.query("INSERT INTO hrms_departments (company_id, code, name, department_type) VALUES (?, ?, ?, 'Bay'), (?, ?, ?, 'section')", [OTHER, `${TAG}X1`, `${TAG} X1`, OTHER, `${TAG}X2`, `${TAG} X2`]);
  const withOwn = await LABELS.listLabels(db, OTHER);
  ok(JSON.stringify(names(withOwn)) === JSON.stringify(['Department', 'Section', 'Machine', 'Bay']) && withOwn.labels[3].departmentCount === 1 && withOwn.labels[1].departmentCount === 1,
    'a company whose departments already use a label of their own gets it in the list too, and counts ignore case', JSON.stringify(withOwn.labels));

  // ── the company under test ──
  const start = await LABELS.listLabels(db, COMPANY);
  const [[liveDepartments]] = await db.query('SELECT COUNT(*) AS n FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  ok(start.labels.length >= 1 && start.labels.reduce((t, l) => t + l.departmentCount, 0) === Number(liveDepartments.n),
    `every department’s label is one of the list: the counts add up to the company’s ${liveDepartments.n} departments`, JSON.stringify(start.labels));
  const list0 = (await ORG.listDepartments(db, COMPANY));
  ok(JSON.stringify(list0.types) === JSON.stringify(names(start)), 'GET /organisation/departments still carries `types`: the list, in its order');

  // add
  const line = await LABELS.createLabel(db, c, { name: `  ${TAG}   Line ` });
  ok(line.name === `${TAG} Line` && line.departmentCount === 0 && line.sortOrder === Math.max(...start.labels.map((l) => l.sortOrder)) + 1 && line.label.id === line.id,
    'POST adds a label at the end, trimmed', JSON.stringify(line));
  ok(refused(await caught(() => LABELS.createLabel(db, c, { name: `${TAG} LINE` })), 409, 'DUPLICATE') && refused(await caught(() => LABELS.createLabel(db, c, { name: '   ' })), 422, 'INVALID')
    && refused(await caught(() => LABELS.createLabel(db, c, { name: 'x'.repeat(41) })), 422, 'INVALID') && refused(await caught(() => LABELS.createLabel(db, c, {})), 422, 'INVALID'),
  'the same name in other capitals: 409 DUPLICATE; no name, or over 40 characters: 422');
  // The key is (company, group, name) — every label lives in the company's one group row — so the raw insert names it.
  const [[{ group_id: lineGroup }]] = await db.query('SELECT group_id FROM hrms_department_labels WHERE id = ?', [line.id]);
  const dbDup = await caught(() => db.query('INSERT INTO hrms_department_labels (company_id, group_id, name) VALUES (?, ?, ?)', [COMPANY, lineGroup, `${TAG} line`]));
  ok(dbDup?.errno === 1062, 'and the database refuses it too (uq_hdlb_group_name, without case)', dbDup?.code ?? 'accepted');

  // a department and its label
  const d1 = await ORG.createDepartment(db, c, { name: `${TAG} One`, type: `${TAG} line` });
  const d2 = await ORG.createDepartment(db, c, { name: `${TAG} Two`, type: `${TAG} Line`, isShared: true });
  const d0 = await ORG.createDepartment(db, c, { name: `${TAG} Plain` });
  ok(d1.type === `${TAG} Line` && d2.type === `${TAG} Line` && d2.isShared === true && d0.type === start.labels[0].name,
    'a department takes a label of the list, spelled as the list spells it; one created with none takes the first of the list', `${d1.type} / ${d0.type}`);
  const unknown = await caught(() => ORG.createDepartment(db, c, { name: `${TAG} Bad`, type: `${TAG} Nope` }));
  const unknownUpdate = await caught(() => ORG.updateDepartment(db, c, d0.id, { type: 'Machine / area ' + TAG }));
  const blankUpdate = await caught(() => ORG.updateDepartment(db, c, d0.id, { type: '' }));
  ok(refused(unknown, 422, 'INVALID') && /not one of this company/.test(unknown.message) && unknown.problems[0].includes(start.labels[0].name)
    && refused(unknownUpdate, 422, 'INVALID') && refused(blankUpdate, 422, 'INVALID') && (await typeOf(db, d0.id)).department_type === start.labels[0].name,
  'a label that is not in the list is 422 on create and on update, naming the choices; a department cannot be left with none', `${why(unknown)} | ${why(blankUpdate)}`);
  ok((await ORG.updateDepartment(db, c, d0.id, { type: start.labels[start.labels.length - 1].name.toUpperCase() })).type === start.labels[start.labels.length - 1].name
    && (await ORG.updateDepartment(db, c, d0.id, { name: `${TAG} Plain renamed` })).type === start.labels[start.labels.length - 1].name,
  'a department moves to another label of the list; an edit that does not mention the label leaves it');
  ok((await LABELS.listLabels(db, COMPANY)).labels.find((l) => l.id === line.id).departmentCount === 2, 'the label says two departments use it');

  // rename
  const ren = await LABELS.updateLabel(db, c, line.id, { name: `${TAG} Production line` });
  ok(ren.name === `${TAG} Production line` && ren.departmentsRenamed === 2 && ren.departmentCount === 2
    && (await typeOf(db, d1.id)).department_type === `${TAG} Production line` && (await typeOf(db, d2.id)).department_type === `${TAG} Production line`
    && (await ORG.listDepartments(db, COMPANY)).rows.find((r) => r.id === d1.id).type === `${TAG} Production line`,
  'a rename also renames the label on every department that uses it, in the same transaction', JSON.stringify(ren));
  ok(refused(await caught(() => LABELS.updateLabel(db, c, line.id, { name: start.labels[0].name.toLowerCase() })), 409, 'DUPLICATE')
    && refused(await caught(() => LABELS.updateLabel(db, c, line.id, { name: '' })), 422, 'INVALID') && refused(await caught(() => LABELS.updateLabel(db, c, 999999999, { name: 'x' })), 404, 'NOT_FOUND')
    && (await LABELS.updateLabel(db, c, line.id, { name: `${TAG} Production line` })).departmentsRenamed === 0 && (await LABELS.updateLabel(db, c, line.id, { sortOrder: 50 })).sortOrder === 50,
  'renaming to another label’s name: 409; to nothing: 422; a label that does not exist: 404; the same name again changes nothing; sortOrder alone is saved');

  // reorder
  const before = (await LABELS.listLabels(db, COMPANY)).labels;
  const reversed = [...before].reverse().map((l) => l.id);
  const after = await LABELS.reorderLabels(db, c, { ids: reversed });
  ok(JSON.stringify(after.labels.map((l) => l.id)) === JSON.stringify(reversed) && after.labels.every((l, i) => l.sortOrder === i + 1)
    && JSON.stringify((await ORG.listDepartments(db, COMPANY)).types) === JSON.stringify(after.labels.map((l) => l.name)),
  'PUT …/order { ids } puts the list in that order (1, 2, 3 …) and the department form follows it');
  ok(refused(await caught(() => LABELS.reorderLabels(db, c, { ids: reversed.slice(1) })), 422, 'INVALID') && refused(await caught(() => LABELS.reorderLabels(db, c, { ids: [...reversed.slice(1), reversed[1]] })), 422, 'INVALID')
    && refused(await caught(() => LABELS.reorderLabels(db, c, { ids: [...reversed.slice(1), 999999999] })), 422, 'INVALID') && refused(await caught(() => LABELS.reorderLabels(db, c, {})), 422, 'INVALID'),
  'an order that leaves a label out, repeats one or names a stranger: 422');

  // delete
  const inUse = await caught(() => LABELS.deleteLabel(db, c, line.id));
  ok(refused(inUse, 409, 'IN_USE') && inUse.detail.departmentCount === 2 && /2 departments use/.test(inUse.message), 'deleting a label two departments use: 409 IN_USE with detail.departmentCount', why(inUse));
  const section2 = before.find((l) => l.id !== line.id);
  ok(refused(await caught(() => LABELS.deleteLabel(db, c, line.id, { moveTo: line.id })), 422, 'INVALID') && refused(await caught(() => LABELS.deleteLabel(db, c, line.id, { moveTo: 999999999 })), 422, 'INVALID')
    && refused(await caught(() => LABELS.deleteLabel(db, c, line.id, { moveTo: first.labels[0].id })), 422, 'INVALID') && (await typeOf(db, d1.id)).department_type === `${TAG} Production line`,
  'moveTo itself, a label that does not exist or another company’s label: 422, and nothing moved');
  const gone = await LABELS.deleteLabel(db, c, line.id, { moveTo: String(section2.id) });
  ok(gone.ok === true && gone.departmentsMoved === 2 && (await typeOf(db, d1.id)).department_type === section2.name && (await typeOf(db, d2.id)).department_type === section2.name
    && (await typeOf(db, d2.id)).is_shared === 1 && (await LABELS.listLabels(db, COMPANY)).labels.every((l) => l.id !== line.id),
  'with ?moveTo= its departments take that label first (shared stays shared), then it goes', JSON.stringify(gone));
  ok(refused(await caught(() => LABELS.deleteLabel(db, c, line.id)), 404, 'NOT_FOUND'), 'deleting it twice: 404');
  const spare = await LABELS.createLabel(db, c, { name: `${TAG} Spare` });
  ok((await LABELS.deleteLabel(db, c, spare.id)).departmentsMoved === 0 && (await LABELS.createLabel(db, c, { name: `${TAG} Spare` })).id !== spare.id, 'a label nobody uses is deleted without a moveTo, and its name is free again');
  const [[auditRows]] = await db.query("SELECT COUNT(*) AS n, SUM(action = 'DELETE') AS deletes FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_department_labels' AND actor_user_id <=> ?", [COMPANY, c.userId]);
  ok(Number(auditRows.n) >= 6 && Number(auditRows.deletes) >= 2, 'every change to the list is audited, in the same transaction', JSON.stringify(auditRows));

  // the list never empties (on the other company, which has four labels and two departments)
  const theirs = (await LABELS.listLabels(db, OTHER)).labels;
  const keep = theirs.find((l) => l.name === 'Section');
  for (const l of theirs) if (l.id !== keep.id) await LABELS.deleteLabel(db, there, l.id, { moveTo: keep.id });
  const last = await caught(() => LABELS.deleteLabel(db, there, keep.id));
  ok(refused(last, 409, 'LAST_LABEL') && (await LABELS.listLabels(db, OTHER)).labels.length === 1 && (await LABELS.listLabels(db, OTHER)).labels[0].departmentCount === 2,
    'the last label cannot be deleted (409 LAST_LABEL): a company never has an empty list', why(last));

  // another company
  const mine = (await LABELS.listLabels(db, COMPANY)).labels[0];
  ok(refused(await caught(() => LABELS.updateLabel(db, there, mine.id, { name: 'x' })), 404, 'NOT_FOUND') && refused(await caught(() => LABELS.deleteLabel(db, there, mine.id)), 404, 'NOT_FOUND')
    && (await LABELS.listLabels(db, OTHER)).labels.every((l) => l.id !== mine.id) && (await LABELS.listLabels(db, COMPANY)).labels[0].name === mine.name,
  'another company cannot rename or delete a label of this one, and does not see it');
});

/* ══ 2. the migration ═════════════════════════════════════════════════════ */
section('[2] The label migration (the code apply-cleanup-a.mjs runs)');
{
  ok(renamed('Process') === 'Section' && renamed('shared CREW') === 'Section' && renamed(' Machine / area ') === 'Machine' && renamed(null) === 'Department' && renamed('  ') === 'Department'
    && renamed('Department') === 'Department' && renamed(' Bay ') === 'Bay', 'the mapping: Process -> Section, Shared crew -> Section, Machine / area -> Machine, none -> Department, anything else kept');
  const plan = planLabels([
    { id: 1, department_type: 'Process', is_shared: 0, deleted_at: null },
    { id: 2, department_type: 'Shared crew', is_shared: 0, deleted_at: null },
    { id: 3, department_type: 'Shared crew', is_shared: 1, deleted_at: null },
    { id: 4, department_type: 'Machine / area', is_shared: 0, deleted_at: null },
    { id: 5, department_type: null, is_shared: 0, deleted_at: null },
    { id: 6, department_type: 'Section', is_shared: 0, deleted_at: null },
    { id: 7, department_type: 'Bay', is_shared: 0, deleted_at: null },
    { id: 8, department_type: 'Process', is_shared: 0, deleted_at: '2026-01-01 00:00:00' },
  ], []);
  ok(JSON.stringify(plan.before) === JSON.stringify({ '(no label)': 1, Bay: 1, 'Machine / area': 1, Process: 1, Section: 1, 'Shared crew': 2 })
    && JSON.stringify(plan.after) === JSON.stringify({ Bay: 1, Department: 1, Machine: 1, Section: 4 }) && plan.sharedBefore === 1 && plan.sharedAfter === 2
    && JSON.stringify(plan.share) === JSON.stringify([2]) && JSON.stringify(plan.add) === JSON.stringify(['Department', 'Section', 'Machine', 'Bay']) && plan.renameCount === 6
    && JSON.stringify(plan.rename.get('Section')) === JSON.stringify([1, 2, 3, 8]),
  'the plan: counts per label before and after (live departments), who becomes shared, what the list gains — a deleted department is renamed but not counted', JSON.stringify({ before: plan.before, after: plan.after, add: plan.add }));
  const keptList = planLabels([{ id: 1, department_type: 'Machine / area', is_shared: 0, deleted_at: null }, { id: 2, department_type: 'Bay', is_shared: 0, deleted_at: null }],
    [{ id: 9, name: 'Department', sort_order: 1 }, { id: 10, name: 'machine', sort_order: 2 }]);
  ok(JSON.stringify(keptList.add) === JSON.stringify(['Bay']), 'a company that already has a list is not given the defaults again — only a label its departments use and the list lacks', JSON.stringify(keptList.add));
}
await rolledBack(async (db) => {
  const rows = [['Process', 0], ['Shared crew', 0], ['shared crew', 1], ['Machine / area', 0], [null, 0], ['', 0], ['Section', 0], ['Bay', 0]];
  const ids = [];
  for (const [i, [type, shared]] of rows.entries()) {
    ids.push((await db.query('INSERT INTO hrms_departments (company_id, code, name, department_type, is_shared) VALUES (?, ?, ?, ?, ?)', [OTHER, `${TAG}M${i}`, `${TAG} M${i}`, type, shared]))[0].insertId);
  }
  const read1 = await readCompany(db, OTHER);
  const plan1 = planLabels(read1.departments, read1.labels);
  await applyLabels(db, OTHER, plan1, read1.labels);
  const got = [];
  for (const id of ids) { const r = await typeOf(db, id); got.push(`${r.department_type}:${r.is_shared}`); }
  ok(JSON.stringify(got) === JSON.stringify(['Section:0', 'Section:1', 'Section:1', 'Machine:0', 'Department:0', 'Department:0', 'Section:0', 'Bay:0']),
    'applied to a real company: Process -> Section; Shared crew -> Section and SHARED (set where it was not); Machine / area -> Machine; no label -> Department', got.join(' '));
  const listed = await LABELS.listLabels(db, OTHER);
  ok(JSON.stringify(names(listed)) === JSON.stringify(['Department', 'Section', 'Machine', 'Bay']) && JSON.stringify(listed.labels.map((l) => l.departmentCount)) === JSON.stringify([2, 4, 1, 1]),
    'its list: the three defaults, then the label of its own, each with its count', JSON.stringify(listed.labels));
  const read2 = await readCompany(db, OTHER);
  const plan2 = planLabels(read2.departments, read2.labels);
  ok(plan2.nothing === true && plan2.renameCount === 0 && plan2.add.length === 0 && JSON.stringify(plan2.before) === JSON.stringify(plan2.after) && JSON.stringify(plan2.after) === JSON.stringify(plan1.after),
    'run again: nothing to rename, nothing to add — idempotent', JSON.stringify(plan2.after));
  // The company under test has had the migration applied: the plan for it is empty too.
  const here = await readCompany(db, COMPANY);
  const planHere = planLabels(here.departments, here.labels);
  ok(planHere.nothing === true && !['Process', 'Shared crew', 'Machine / area', '(no label)'].some((k) => k in planHere.after), `${company.name}: migrated — no old label is left and the plan is empty`, JSON.stringify(planHere.after));
});

/* ══ 3. codes ═════════════════════════════════════════════════════════════ */
section('[3] Codes: departments, roles, positions, locations');
ok(initials('Quality Control') === 'QC' && initials('Unit 2') === 'U2' && initials('  shift in-charge ') === 'SIC' && initials('Stores') === 'S' && initials('') === '' && initials(null) === ''
  && cardCodeOf('P021-3') === 'P021' && cardCodeOf('P021') === 'P021' && cardCodeOf('') === null && cardCodeOf(null) === null, 'initials and the card code read as the guide says');

const split = (code) => { const m = /^(.*?)(\d+)$/.exec(String(code)); return m ? { head: m[1], n: Number(m[2]), width: m[2].length } : null; };
const nextOf = (code, by = 1) => { const s = split(code); return `${s.head}${String(s.n + by).padStart(s.width, '0')}`; };
const ruleCount = async (db, companyId, entityType) => Number((await db.query(
  "SELECT COUNT(*) AS n FROM cf_code_schemes WHERE company_id = ? AND entity_type = ? AND target_field = 'code' AND deleted_at IS NULL", [companyId, entityType]))[0][0].n);
const counters = async (db, companyId, entityType) => (await db.query(
  `SELECT q.seq_key, q.next_value FROM cf_code_sequences q JOIN cf_code_schemes s ON s.id = q.scheme_id
    WHERE q.company_id = ? AND s.entity_type = ? AND s.deleted_at IS NULL ORDER BY q.seq_key`, [companyId, entityType]))[0].map((r) => `${r.seq_key}=${r.next_value}`).join(',');

// ── the default rule on first use, in a company that has never had one ──
await rolledBack(async (db) => {
  ok((await ruleCount(db, OTHER, 'hrms_department')) + (await ruleCount(db, OTHER, 'hrms_role')) + (await ruleCount(db, OTHER, 'hrms_position')) + (await ruleCount(db, OTHER, 'hrms_location')) === 0,
    `${other.name} starts with no rule for any of the four`);
  const d1 = await ORG.createDepartment(db, there, { name: `${TAG} First department` });
  const d2 = await ORG.createDepartment(db, there, { name: `${TAG} Second department`, parentId: d1.id });
  const r1 = await RC.createRole(db, there, { title: `${TAG} First role`, status: 'ACTIVE' });
  const l1 = await ORG.createLocation(db, there, { name: `${TAG} First location` });
  const p1 = (await POS.createPosition(db, there, { roleId: r1.id, departmentId: d1.id, locationId: l1.id, status: 'ACTIVE' })).position;
  const p2 = (await POS.createPosition(db, there, { roleId: r1.id, status: 'ACTIVE' })).position;
  ok(d1.code === 'D001' && d2.code === 'D002' && r1.roleCode === 'R001' && l1.code === 'L01' && p1.positionCode === 'P001' && p2.positionCode === 'P002',
    'the first of each gets the default rule’s first code: D001, D002 · R001 · L01 · P001, P002', [d1.code, d2.code, r1.roleCode, l1.code, p1.positionCode, p2.positionCode].join(' '));
  const [made] = await db.query("SELECT entity_type, code, status FROM cf_code_schemes WHERE company_id = ? AND entity_type LIKE 'hrms\\_%' AND deleted_at IS NULL ORDER BY entity_type", [OTHER]);
  ok(JSON.stringify(made.map((m) => `${m.entity_type}:${m.code}:${m.status}`)) === JSON.stringify(['hrms_department:HRMS_DEPARTMENT:active', 'hrms_location:HRMS_LOCATION:active', 'hrms_position:HRMS_POSITION:active', 'hrms_role:HRMS_ROLE:active']),
    'each default rule was created once, on first use, and only for what was created', JSON.stringify(made.map((m) => m.code)));
  const sib = (await POS.addSiblingPosition(db, there, p1.id, {})).position;
  ok(sib.positionCode === 'P003', 'add-sibling under the default rule takes the next code like any new position', sib.positionCode);
});

await rolledBack(async (db) => {
  const G = (await db.query('SELECT id, code FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]))[0][0] ?? null;

  // THE TEST OWNS ITS POSITION RULE. The tenant's own (a plain running number, role code plus number, or
  // none at all) is switched off for this transaction, so no check below depends on how it codes positions.
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type = 'hrms_position' AND deleted_at IS NULL", [COMPANY]);
  await createScheme(db, COMPANY, c.userId, {
    code: `${TAG}_BASE`, name: `${TAG} base`, entityType: 'hrms_position', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', conditions: [],
    segments: [{ segmentType: 'literal', literalText: `${TAG}P` }, { segmentType: 'sequence', format: '000' }],
  });

  // ── a code a client sends is ignored, on create and on update ──
  const dept = await ORG.createDepartment(db, c, { name: `${TAG} Quality Control`, code: `${TAG}HACK`, type: 'Machine' });
  const role = await RC.createRole(db, c, { title: `${TAG} Quality Inspector`, roleCode: `${TAG}HACK`, status: 'ACTIVE', defaultDepartmentId: dept.id });
  const loc = await ORG.createLocation(db, c, { name: `${TAG} Unit 3`, code: `${TAG}HACK`, address: { city: 'Navi Mumbai' } });
  const pos = (await POS.createPosition(db, c, { roleId: role.id, departmentId: dept.id, locationId: loc.id, positionCode: `${TAG}HACK`, status: 'ACTIVE' })).position;
  const issued = { dept: dept.code, role: role.roleCode, loc: loc.code, pos: pos.positionCode };
  ok(Object.values(issued).every((v) => v && !String(v).includes('HACK')), 'create ignores a code the client sends: each record gets the company’s next code', JSON.stringify(issued));
  const dept2 = await ORG.updateDepartment(db, c, dept.id, { code: `${TAG}CHANGED`, name: `${TAG} Quality Control 2` });
  const role2 = await RC.updateRole(db, c, role.id, { roleCode: `${TAG}CHANGED`, roleSummary: 'Edited.' });
  const loc2 = await ORG.updateLocation(db, c, loc.id, { code: `${TAG}CHANGED`, name: `${TAG} Unit 3 renamed` });
  const pos2 = (await POS.updatePosition(db, c, pos.id, { positionCode: `${TAG}CHANGED`, positionTitle: `${TAG} Retitled` })).position;
  ok(dept2.code === issued.dept && dept2.name === `${TAG} Quality Control 2` && role2.roleCode === issued.role && loc2.code === issued.loc && loc2.name === `${TAG} Unit 3 renamed`
    && pos2.positionCode === issued.pos && pos2.positionTitle === `${TAG} Retitled`,
  'update never changes a code — the other fields of the same request are saved', JSON.stringify({ d: dept2.code, r: role2.roleCode, l: loc2.code, p: pos2.positionCode }));
  ok((await caught(() => ORG.updateDepartment(db, c, dept.id, { code: 'has spaces and is far too long to be a code at all, really it is' }))) === null, 'a nonsense code on update is not even validated: it is not read');

  // ── a code already in use is stepped over; a deleted record’s code too ──
  for (const [label, table, column, make, read] of [
    ['department', 'hrms_departments', 'code', () => ORG.createDepartment(db, c, { name: `${TAG} D ${Math.random()}` }), (x) => x.code],
    ['role', 'hrms_roles', 'role_code', () => RC.createRole(db, c, { title: `${TAG} R ${Math.random()}`, status: 'ACTIVE' }), (x) => x.roleCode],
    ['location', 'hrms_locations', 'code', () => ORG.createLocation(db, c, { name: `${TAG} L ${Math.random()}` }), (x) => x.code],
    ['position', 'hrms_positions', 'position_code', async () => (await POS.createPosition(db, c, { roleId: role.id, status: 'ACTIVE' })).position, (x) => x.positionCode],
  ]) {
    const a = read(await make());
    if (!split(a)) { skip(`${label}: stepping over a used code`, `this company’s ${label} rule does not end in a number (${a})`); continue; }
    // Somebody else already holds the next two codes: one live, one deleted.
    const extra = table === 'hrms_departments' || table === 'hrms_locations' ? ['name', `${TAG} taken`] : table === 'hrms_roles' ? ['title', `${TAG} taken ${label}`] : ['role_id', role.id];
    await db.query(`INSERT INTO ${table} (company_id, ${column}, ${extra[0]}) VALUES (?, ?, ?)`, [COMPANY, nextOf(a, 1).toLowerCase(), extra[1]]);
    await db.query(`INSERT INTO ${table} (company_id, ${column}, ${extra[0]}, deleted_at) VALUES (?, ?, ?, NOW())`, [COMPANY, nextOf(a, 2), `${extra[1]}${table === 'hrms_positions' ? '' : ' gone'}`]);
    const b = read(await make());
    ok(b === nextOf(a, 3), `${label}: the next two codes are taken (one by a live record in other capitals, one by a deleted record) — the generator steps over both`, `${a} -> ${b}`);
  }

  // ── a create that rolls back gives its number back ──
  for (const [label, entityType, make, read] of [
    ['department', 'hrms_department', () => ORG.createDepartment(db, c, { name: `${TAG} RB ${Math.random()}` }), (x) => x.code],
    ['role', 'hrms_role', () => RC.createRole(db, c, { title: `${TAG} RB ${Math.random()}`, status: 'ACTIVE' }), (x) => x.roleCode],
    ['location', 'hrms_location', () => ORG.createLocation(db, c, { name: `${TAG} RB ${Math.random()}` }), (x) => x.code],
    ['position', 'hrms_position', async () => (await POS.createPosition(db, c, { roleId: role.id, status: 'ACTIVE' })).position, (x) => x.positionCode],
  ]) {
    const before = await counters(db, COMPANY, entityType);
    await db.query('SAVEPOINT rb');
    const lost = read(await make());
    const during = await counters(db, COMPANY, entityType);
    await db.query('ROLLBACK TO SAVEPOINT rb');
    const after = await counters(db, COMPANY, entityType);
    const again = read(await make());
    ok(during !== before && after === before && again === lost, `${label}: a create that is rolled back gives its number back — the next one gets the same code`, `${lost} then ${again}; counter ${before} -> ${during} -> ${after}`);
  }
  // …and a create refused by a rule takes none.
  const beforeRefusal = await counters(db, COMPANY, 'hrms_department');
  await caught(() => ORG.createDepartment(db, c, { name: `${TAG} Refused`, type: `${TAG} no such label` }));
  await caught(() => ORG.createDepartment(db, c, { name: '', type: 'Machine' }));
  ok((await counters(db, COMPANY, 'hrms_department')) === beforeRefusal, 'a create refused for its label or its name takes no number');

  // ── the tokens render, and a rule with a condition beats the plain one ──
  const [[machine]] = await db.query("SELECT id FROM hrms_department_labels WHERE company_id = ? AND deleted_at IS NULL AND name = 'Machine'", [COMPANY]);
  const rule = (entityType, code, segments, conditions = []) => createScheme(db, COMPANY, c.userId, {
    code: `${TAG}_${code}`, name: `${TAG} ${code}`, entityType, targetField: 'code', seqScope: 'prefix', priority: 10, status: 'active', conditions, segments,
  });
  const lit = (t) => ({ segmentType: 'literal', literalText: t });
  const tok = (k, extra = {}) => ({ segmentType: 'token', tokenKey: k, ...extra });
  const seq = (f) => ({ segmentType: 'sequence', format: f });

  if (machine) {
    await rule('hrms_department', 'DEPT', [tok('label.initial'), lit('-'), tok('name.initials'), lit('-'), tok('parent.code'), lit('-'), seq('0')], [{ tokenKey: 'label', operator: 'eq', value: String(machine.id) }]);
    const press = await ORG.createDepartment(db, c, { name: 'Offset Press', type: 'Machine', parentId: dept.id });
    const press2 = await ORG.createDepartment(db, c, { name: 'offset  press two', type: 'machine', parentId: dept.id });
    const office = await ORG.createDepartment(db, c, { name: `${TAG} Office`, type: 'Department', parentId: dept.id });
    ok(press.code === `M-OP-${dept.code}-1` && press2.code === `M-OPT-${dept.code}-1` && split(office.code) && !office.code.startsWith('M-'),
      'a department rule {label.initial}-{name.initials}-{parent.code}-{#} for the label Machine: M-OP-<parent>-1; a Department still gets the plain rule', `${press.code} ${press2.code} ${office.code}`);
    const top = await caught(() => ORG.createDepartment(db, c, { name: 'Top Machine', type: 'Machine' }));
    ok(top?.status === 422 && top.code === 'TOKEN_MISSING' && /parent\.code/.test(top.message), 'a rule that needs the department above refuses a department with none (422 TOKEN_MISSING), rather than print a code with a hole in it', why(top));
    const preview = await generate(db, COMPANY, 'hrms_department', 'code', { entityId: press.id }, { consume: false });
    ok(preview.text === `M-OP-${dept.code}-2` && preview.schemeCode === `${TAG}_DEPT`, 'the rules screen can preview a SAVED department: its rule and the number that would be next', JSON.stringify(preview));
  } else skip('department tokens', 'this company has no label called Machine');

  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN ('hrms_role', 'hrms_location') AND code NOT LIKE ?", [COMPANY, `${TAG}%`]);
  await rule('hrms_role', 'ROLE', [tok('title.initials'), lit('/'), tok('department.code', { isRequired: false }), lit('/'), seq('00')]);
  const qi = await RC.createRole(db, c, { title: 'Quality  Inspector (night)', status: 'ACTIVE', defaultDepartmentId: dept.id });
  const qi2 = await RC.createRole(db, c, { title: 'quality inspector day', status: 'ACTIVE' });
  ok(qi.roleCode === `QIN/${dept.code}/01` && qi2.roleCode === 'QID//01', 'a role rule {title.initials}/{department.code}/{##}: QIN/<department>/01; a part that is not required prints nothing when the role has no department', `${qi.roleCode} ${qi2.roleCode}`);
  await rule('hrms_location', 'LOC', [tok('city.initials', { isRequired: false }), lit('-'), tok('name.initials'), lit('-'), seq('0')]);
  const u3 = await ORG.createLocation(db, c, { name: 'Unit 3', address: { city: 'Navi Mumbai' } });
  const u4 = await ORG.createLocation(db, c, { name: 'Head office' });
  ok(u3.code === 'NM-U3-1' && u4.code === '-HO-1', 'a location rule {city.initials}-{name.initials}-{#}: NM-U3-1; no city in the address prints nothing there', `${u3.code} ${u4.code}`);

  // ── positions: {department.code}-{role.code}-{##}, and add-sibling through the generator ──
  await rule('hrms_position', 'POS', [tok('department.code'), lit('-'), tok('role.code'), lit('-'), seq('00')], [{ tokenKey: 'role', operator: 'eq', value: String(qi.id) }]);
  const a1 = (await POS.createPosition(db, c, { roleId: qi.id, departmentId: dept.id, status: 'ACTIVE', ...(G ? { defaultShiftId: G.id } : {}) })).position;
  const a2 = (await POS.createPosition(db, c, { roleId: qi.id, departmentId: dept.id, status: 'ACTIVE' })).position;
  const elsewhere = (await POS.createPosition(db, c, { roleId: role.id, departmentId: dept.id, status: 'ACTIVE' })).position;
  ok(a1.positionCode === `${dept.code}-${qi.roleCode}-01` && a2.positionCode === `${dept.code}-${qi.roleCode}-02` && split(elsewhere.positionCode) && !elsewhere.positionCode.includes(qi.roleCode),
    'a position rule {department.code}-{role.code}-{##} for one role: <department>-<role>-01, -02; a position of another role still gets the plain rule', `${a1.positionCode} ${a2.positionCode} ${elsewhere.positionCode}`);
  const a3 = (await POS.addSiblingPosition(db, c, a1.id, {})).position;
  ok(a3.positionCode === `${dept.code}-${qi.roleCode}-03` && (await db.query('SELECT position_code FROM hrms_positions WHERE id = ?', [a1.id]))[0][0].position_code === a1.positionCode,
    'add-sibling goes through the generator: the same rule, the next number (-03) — not "<source>-2"; the source keeps its code', a3.positionCode);
  const underCondition = await rule('hrms_position', 'DEPTPOS', [lit('QC-'), tok('shift.code', { isRequired: false }), tok('location.code', { isRequired: false }), seq('000')], [{ tokenKey: 'department', operator: 'under', value: String(dept.id) }]);
  const b1 = (await POS.createPosition(db, c, { roleId: role.id, departmentId: dept.id, locationId: u3.id, status: 'ACTIVE', ...(G ? { defaultShiftId: G.id } : {}) })).position;
  const general = (await db.query("SELECT id, code FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY (UPPER(code) LIKE 'G%') DESC, id LIMIT 1", [COMPANY]))[0][0] ?? null;
  ok(b1.positionCode === `QC-${G?.code ?? general?.code ?? ''}NM-U3-1001` && underCondition.id > 0, 'a position rule "department is under X" prints the shift and location codes: QC-<shift><location>001', b1.positionCode);
  // That role in that department now has TWO rules that weigh the same. The generator does not guess.
  const tie = await caught(() => POS.createPosition(db, c, { roleId: qi.id, departmentId: dept.id, status: 'ACTIVE' }));
  ok(tie?.status === 409 && tie.code === 'SCHEME_TIE' && tie.message.includes(`${TAG}_POS`) && tie.message.includes(`${TAG}_DEPTPOS`),
    'two rules that apply equally (one by role, one by department) are a 409 SCHEME_TIE naming both — never decided by row order', why(tie));
  await db.query('UPDATE cf_code_schemes SET priority = 20 WHERE company_id = ? AND code = ?', [COMPANY, `${TAG}_POS`]);
  const a4 = (await POS.createPosition(db, c, { roleId: qi.id, departmentId: dept.id, status: 'ACTIVE' })).position;
  ok(a4.positionCode === `${dept.code}-${qi.roleCode}-04`, 'give one a higher priority and it wins; the refused create took no number (-04 is next)', a4.positionCode);

  // card.code: number the chairs of a card P021-1, P021-2 …
  const lone = (await POS.createPosition(db, c, { roleId: qi2.id, status: 'ACTIVE' })).position;
  await rule('hrms_position', 'CARD', [tok('card.code'), lit('-'), seq('0')], [{ tokenKey: 'role', operator: 'eq', value: String(qi2.id) }]);
  const s1 = (await POS.addSiblingPosition(db, c, lone.id, {})).position;
  const s2 = (await POS.addSiblingPosition(db, c, s1.id, {})).position;
  ok(s1.positionCode === `${lone.positionCode}-1` && s2.positionCode === `${lone.positionCode}-2`,
    'a rule {card.code}-{#}: siblings are numbered after the card’s first position — and a sibling OF a sibling strips the tail first', `${lone.positionCode} -> ${s1.positionCode}, ${s2.positionCode}`);
  await db.query('INSERT INTO hrms_positions (company_id, position_code, role_id) VALUES (?, ?, ?)', [COMPANY, `${lone.positionCode}-3`, qi2.id]);
  const s4 = (await POS.addSiblingPosition(db, c, lone.id, {})).position;
  ok(s4.positionCode === `${lone.positionCode}-4`, '…and steps over a number somebody already holds', s4.positionCode);
  const noCard = await caught(() => POS.createPosition(db, c, { roleId: qi2.id, status: 'ACTIVE' }));
  ok(noCard?.status === 422 && noCard.code === 'TOKEN_MISSING' && /card\.code/.test(noCard.message), 'under that rule a position created on its own has no card code: 422 TOKEN_MISSING, in words', why(noCard));
  const savedPreview = await generate(db, COMPANY, 'hrms_position', 'code', { entityId: s1.id }, { consume: false });
  ok(savedPreview.text === `${lone.positionCode}-5`, 'previewing a SAVED position reads its card from the chart', JSON.stringify(savedPreview));

  // ── role code plus number (setup-codes.mjs --position-by-role): {role.code}-{#}, counted per role ──
  const byRoleA = await RC.createRole(db, c, { title: `${TAG} Zeta Alpha`, status: 'ACTIVE' });
  const byRoleB = await RC.createRole(db, c, { title: `${TAG} Zeta Beta`, status: 'ACTIVE' });
  await rule('hrms_position', 'BYROLE', [tok('role.code'), lit('-'), seq('0')], [{ tokenKey: 'role', operator: 'in', value: `${byRoleA.id},${byRoleB.id}` }]);
  const mkBy = async (r) => (await POS.createPosition(db, c, { roleId: r.id, status: 'ACTIVE' })).position;
  const ra1 = await mkBy(byRoleA);
  const ra2 = await mkBy(byRoleA);
  await db.query('INSERT INTO hrms_positions (company_id, position_code, role_id) VALUES (?, ?, ?), (?, ?, ?)',
    [COMPANY, `${byRoleA.roleCode}-3`, byRoleA.id, COMPANY, `${byRoleA.roleCode}-4`.toLowerCase(), byRoleA.id]);
  const ra5 = (await POS.addSiblingPosition(db, c, ra1.id, {})).position;
  const rb1 = await mkBy(byRoleB);
  const rb2 = await mkBy(byRoleB);
  ok(ra1.positionCode === `${byRoleA.roleCode}-1` && ra2.positionCode === `${byRoleA.roleCode}-2` && ra5.positionCode === `${byRoleA.roleCode}-5`
    && rb1.positionCode === `${byRoleB.roleCode}-1` && rb2.positionCode === `${byRoleB.roleCode}-2` && byRoleA.roleCode !== byRoleB.roleCode,
  'under {role.code}-{#}: two positions of a role are <role>-1 and <role>-2, the next one (added beside the first) continues past the numbers already used (-5), and another role starts its own count at -1',
  [ra1, ra2, ra5, rb1, rb2].map((p) => p.positionCode).join(' '));

  // ── a code too long for the column is refused in words ──
  await rule('hrms_location', 'LONG', [lit('X'.repeat(60)), seq('0')]);
  await db.query('UPDATE cf_code_schemes SET priority = 99 WHERE company_id = ? AND code = ?', [COMPANY, `${TAG}_LONG`]);
  const tooLong = await caught(() => ORG.createLocation(db, c, { name: `${TAG} Too long` }));
  ok(refused(tooLong, 422, 'CODE_TOO_LONG') && /50 characters/.test(tooLong.message), 'a format that prints more than the 50 characters a code can hold: 422 CODE_TOO_LONG', why(tooLong));

  // ── the retired import path: a code the record already holds ──
  const imported = await ORG.createDepartment(db, c, { name: `${TAG} Imported` }, { importedCode: `${TAG}IMP` });
  const importedAgain = await caught(() => ORG.createDepartment(db, c, { name: `${TAG} Imported twice` }, { importedCode: `${TAG}imp` }));
  ok(imported.code === `${TAG}IMP` && refused(importedAgain, 409, 'DUPLICATE'), 'the import scripts’ own path (options.importedCode, never a request body) keeps a code as it is, and refuses one already used', why(importedAgain));

  // ── another company’s rules and counters are its own ──
  const theirRule = await caught(() => createScheme(db, OTHER, null, {
    code: `${TAG}_THEIRS`, name: 'x', entityType: 'hrms_position', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active',
    conditions: [{ tokenKey: 'role', operator: 'eq', value: String(qi.id) }], segments: [seq('0')],
  }));
  const theirLabelRule = machine ? await caught(() => createScheme(db, OTHER, null, {
    code: `${TAG}_THEIRS2`, name: 'x', entityType: 'hrms_department', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active',
    conditions: [{ tokenKey: 'label', operator: 'eq', value: String(machine.id) }], segments: [seq('0')],
  })) : { status: 422 };
  ok(theirRule?.status === 422 && theirLabelRule?.status === 422, 'another company cannot write a rule that tests this company’s role or label (422)', `${theirRule?.status} ${theirLabelRule?.status}`);
});

/* ══ 4. positions held, and moving a person ═══════════════════════════════ */
section('[4] Positions held, and moving a person');
await rolledBack(async (db) => {
  const [people] = await db.query(
    `SELECT e.id, e.full_name, e.employee_code, wa.id AS assignment_id, wa.position_id, wa.effective_from, p.position_code
       FROM hrms_employees e
       JOIN hrms_work_assignments wa ON wa.company_id = e.company_id AND wa.employee_id = e.id AND wa.deleted_at IS NULL AND wa.status = 'ACTIVE' AND wa.is_primary = 1
            AND wa.effective_to IS NULL AND wa.effective_from < ?
       JOIN hrms_positions p ON p.id = wa.position_id AND p.deleted_at IS NULL
      WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.employment_status = 'ACTIVE'
        AND (SELECT COUNT(*) FROM hrms_work_assignments x WHERE x.employee_id = e.id AND x.deleted_at IS NULL AND x.status <> 'ENDED') = 1
        AND NOT EXISTS (SELECT 1 FROM hrms_employee_exits x WHERE x.company_id = e.company_id AND x.employee_id = e.id AND x.deleted_at IS NULL AND x.status = 'OPEN')
      ORDER BY e.id LIMIT 6`, [today, COMPANY]);
  const [vacant] = await db.query(
    `SELECT p.id, p.position_code, p.role_id, p.default_shift_id FROM hrms_positions p
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status = 'ACTIVE' AND (p.effective_to IS NULL OR p.effective_to >= ?)
        AND NOT EXISTS (SELECT 1 FROM hrms_work_assignments wa WHERE wa.company_id = p.company_id AND wa.position_id = p.id AND wa.deleted_at IS NULL AND wa.status <> 'ENDED')
        AND NOT EXISTS (SELECT 1 FROM hrms_hirings h WHERE h.company_id = p.company_id AND h.open_position = p.id)
      ORDER BY p.id LIMIT 6`, [COMPANY, today]);
  if (people.length < 5 || vacant.length < 5) { skip('positions held and move', `needs 5 employees in one position each and 5 vacant positions; found ${people.length} and ${vacant.length}`); return; }
  const [E, F, K, X, L] = people;
  const [B, C, D, H, V] = vacant;
  const yesterday = plusDays(-1);
  const wa = async (id) => (await db.query('SELECT status, effective_from, effective_to, is_primary, position_id FROM hrms_work_assignments WHERE id = ?', [id]))[0][0];
  const occupantOf = async (positionId) => (await POS.getPosition(db, COMPANY, positionId)).position.occupant?.employeeId ?? null;

  // ── the history, before anything moves ──
  const held0 = await HELD.positionsHeld(db, COMPANY, E.id);
  const row0 = held0.positions[0];
  ok(JSON.stringify(Object.keys(held0)) === JSON.stringify(['employee', 'positions', 'current', 'can'])
    && JSON.stringify(held0.employee) === JSON.stringify({ id: E.id, code: E.employee_code, name: E.full_name, status: 'ACTIVE' })
    && held0.positions.length === 1 && JSON.stringify(held0.current) === JSON.stringify([E.assignment_id]) && held0.can.move === true && held0.can.addSecond === true,
  'GET /people/employees/:id/positions -> { employee, positions, current, can }');
  ok(JSON.stringify(Object.keys(row0)) === JSON.stringify(['assignmentId', 'positionId', 'positionCode', 'positionTitle', 'roleId', 'roleTitle', 'roleCode', 'departmentId', 'departmentName', 'locationName', 'shift', 'from', 'to', 'isMain', 'state', 'ended', 'reason'])
    && row0.positionId === E.position_id && row0.positionCode === E.position_code && row0.state === 'CURRENT' && row0.ended === null && row0.isMain === true && row0.to === null && row0.from === day(E.effective_from)
    && row0.roleTitle && (row0.shift === null || typeof row0.shift.summary === 'string'),
  'a position held: its code, role, department, shift, from, to, and how it ended (null while it is current)', JSON.stringify(row0));

  // ── move ──
  const moved = await HELD.moveEmployee(db, c, E.id, { positionId: B.id, effectiveFrom: today });
  const oldRow = await wa(E.assignment_id);
  const newRow = await wa(moved.moved.assignmentId);
  ok(JSON.stringify(moved.moved) === JSON.stringify({ assignmentId: moved.moved.assignmentId, positionId: B.id, positionCode: B.position_code, from: today, endedAssignmentId: E.assignment_id, endedOn: yesterday, keptCurrent: false }),
    'POST …/move -> { moved: { assignmentId, positionId, positionCode, from, endedAssignmentId, endedOn, keptCurrent }, …positions held }', JSON.stringify(moved.moved));
  ok(oldRow.status === 'ENDED' && day(oldRow.effective_to) === yesterday && newRow.status === 'ACTIVE' && day(newRow.effective_from) === today && newRow.effective_to === null && newRow.is_primary === 1 && newRow.position_id === B.id,
    'the old position ended the day BEFORE the new one starts; the new one is their main position', `${oldRow.status} to ${day(oldRow.effective_to)} / ${newRow.status} from ${day(newRow.effective_from)}`);
  ok((await occupantOf(E.position_id)) === null && (await occupantOf(B.id)) === E.id, 'the position they left is vacant; the one they moved to is theirs');
  ok(moved.positions.length === 2 && moved.positions[0].positionId === B.id && moved.positions[0].state === 'CURRENT' && moved.positions[0].ended === null
    && moved.positions[1].positionId === E.position_id && moved.positions[1].state === 'ENDED' && moved.positions[1].to === yesterday
    && JSON.stringify(moved.positions[1].ended) === JSON.stringify({ how: 'MOVED', label: `Moved to ${B.position_code}`, on: yesterday, movedToPositionCode: B.position_code })
    && JSON.stringify(moved.current) === JSON.stringify([moved.moved.assignmentId]),
  'positions held, newest first: the new one current, the old one ended — "Moved to <code>"', JSON.stringify(moved.positions.map((p) => [p.positionCode, p.state, p.ended?.label])));
  const [[event]] = await db.query("SELECT event_type, summary, work_assignment_id FROM hrms_employment_events WHERE company_id = ? AND employee_id = ? ORDER BY id DESC LIMIT 1", [COMPANY, E.id]);
  const [[auditRow]] = await db.query("SELECT after_json FROM hrms_audit_log WHERE company_id = ? AND entity_type = 'hrms_work_assignments' AND entity_id = ? AND action = 'CREATE'", [COMPANY, moved.moved.assignmentId]);
  ok(event?.event_type === 'ASSIGNMENT_CHANGE' && event.work_assignment_id === moved.moved.assignmentId && event.summary.includes(E.position_code) && event.summary.includes(B.position_code)
    && !/assignment|seat/i.test(event.summary) && Boolean(auditRow), 'the move is on their file ("Moved from … to …", no "assignment", no "seat") and in the audit log', event?.summary);

  // ── refusals ──
  const sentence = (e) => `${e?.message ?? ''} ${JSON.stringify(e?.problems ?? '')}`;
  const filled = await caught(() => HELD.moveEmployee(db, c, F.id, { positionId: B.id }));
  ok(refused(filled, 409, 'POSITION_FILLED') && filled.message.includes(E.full_name), 'to a position somebody is in: 409 POSITION_FILLED, naming them', why(filled));
  await HIRE.startHiring(db, c, C.id);
  const hiring = await caught(() => HELD.moveEmployee(db, c, F.id, { positionId: C.id }));
  ok(refused(hiring, 409, 'HIRING_OPEN'), 'to a position a hiring is open for: 409 HIRING_OPEN', why(hiring));
  const same = await caught(() => HELD.moveEmployee(db, c, F.id, { positionId: F.position_id }));
  ok(refused(same, 409, 'ALREADY_THERE') && same.message.includes(F.full_name), 'to the position they are already in: 409 ALREADY_THERE', why(same));
  await db.query("UPDATE hrms_employees SET employment_status = 'EXITED' WHERE id = ?", [X.id]);
  const left = await caught(() => HELD.moveEmployee(db, c, X.id, { positionId: D.id }));
  ok(refused(left, 409, 'EMPLOYEE_LEFT') && left.message.includes(X.full_name), 'somebody who has left: 409 EMPLOYEE_LEFT', why(left));
  ok((await HELD.positionsHeld(db, COMPANY, X.id)).can.move === false && (await HELD.positionsHeld(db, COMPANY, X.id)).can.addSecond === false, '…and their page says so: can.move and can.addSecond are false');
  await db.query("UPDATE hrms_positions SET status = 'CLOSED' WHERE id = ?", [V.id]);
  const closed = await caught(() => HELD.moveEmployee(db, c, F.id, { positionId: V.id }));
  ok(refused(closed, 409, 'POSITION_CLOSED'), 'to a closed position: 409 POSITION_CLOSED', why(closed));
  const early = await caught(() => HELD.moveEmployee(db, c, F.id, { positionId: D.id, effectiveFrom: day(F.effective_from) }));
  ok(refused(early, 422, 'INVALID') && /later date/.test(sentence(early)) && !/assignment/i.test(sentence(early)), 'on or before the day they started in the current position: 422, "choose a later date"', why(early));
  for (const [label, fn, status, code] of [
    ['no position', () => HELD.moveEmployee(db, c, F.id, {}), 422, 'INVALID'],
    ['a date that is not a date', () => HELD.moveEmployee(db, c, F.id, { positionId: D.id, effectiveFrom: '12/10/2026' }), 422, 'INVALID'],
    ['keepCurrent that is not yes or no', () => HELD.moveEmployee(db, c, F.id, { positionId: D.id, keepCurrent: 'maybe' }), 422, 'INVALID'],
    ['a position that does not exist', () => HELD.moveEmployee(db, c, F.id, { positionId: 999999999 }), 404, 'NOT_FOUND'],
    ['an employee that does not exist', () => HELD.moveEmployee(db, c, 999999999, { positionId: D.id }), 404, 'NOT_FOUND'],
    ['positions held of an employee that does not exist', () => HELD.positionsHeld(db, COMPANY, 999999999), 404, 'NOT_FOUND'],
  ]) ok(refused(await caught(fn), status, code), `${label}: ${status}`);
  ok((await wa(F.assignment_id)).status === 'ACTIVE' && (await wa(F.assignment_id)).effective_to === null && (await occupantOf(D.id)) === null, 'none of those refusals moved anybody');

  // ── a second position ──
  const second = await HELD.moveEmployee(db, c, F.id, { positionId: D.id, keepCurrent: true });
  const secondRow = await wa(second.moved.assignmentId);
  ok(second.moved.keptCurrent === true && second.moved.endedAssignmentId === null && second.moved.endedOn === null && (await wa(F.assignment_id)).status === 'ACTIVE' && (await wa(F.assignment_id)).is_primary === 1
    && secondRow.is_primary === 0 && secondRow.status === 'ACTIVE' && second.current.length === 2 && second.positions.filter((p) => p.state === 'CURRENT').length === 2
    && second.positions.find((p) => p.positionId === D.id).isMain === false && second.positions.find((p) => p.positionId === F.position_id).isMain === true
    && (await occupantOf(D.id)) === F.id && (await occupantOf(F.position_id)) === F.id,
  'keepCurrent: true adds a SECOND position — nothing ends, the first stays their main one, both are current');
  // Moving somebody who holds two: the main one ends unless the request names the other.
  const fromSecond = await HELD.moveEmployee(db, c, F.id, { positionId: H.id, effectiveFrom: plusDays(1), fromAssignmentId: second.moved.assignmentId });
  ok(fromSecond.moved.endedAssignmentId === second.moved.assignmentId && day((await wa(second.moved.assignmentId)).effective_to) === today && (await wa(F.assignment_id)).effective_to === null,
    'somebody with two positions: fromAssignmentId says which one the move is from', JSON.stringify(fromSecond.moved));
  ok(refused(await caught(() => HELD.moveEmployee(db, c, K.id, { positionId: H.id, fromAssignmentId: F.assignment_id })), 422, 'INVALID'), 'a fromAssignmentId that is not theirs: 422');

  // ── a move on a later date ──
  const later = plusDays(10);
  await db.query("UPDATE hrms_positions SET status = 'ACTIVE' WHERE id = ?", [V.id]);
  const planned = await HELD.moveEmployee(db, c, K.id, { positionId: V.id, effectiveFrom: later });
  const kOld = await wa(K.assignment_id);
  ok(planned.moved.endedOn === plusDays(9) && kOld.status === 'ACTIVE' && day(kOld.effective_to) === plusDays(9) && (await occupantOf(K.position_id)) === K.id,
    'a move dated later: the current position gets its last day (the day before) and they are STILL in it today', `${kOld.status} to ${day(kOld.effective_to)}`);
  const vNow = (await POS.getPosition(db, COMPANY, V.id)).position;
  ok(vNow.occupant === null && vNow.joining?.employeeId === K.id && planned.positions[0].state === 'COMING' && planned.positions[0].from === later && planned.positions[1].state === 'CURRENT'
    && planned.positions[1].to === plusDays(9) && planned.positions[1].ended === null && JSON.stringify(planned.current) === JSON.stringify([K.assignment_id]),
  'the new position shows them as joining on that date; their history: COMING first, then the CURRENT one with its last day', JSON.stringify(planned.positions.map((p) => [p.positionCode, p.state, p.from, p.to])));
  const asOfLater = await HELD.positionsHeld(db, COMPANY, K.id, { on: later });
  ok(asOfLater.positions[0].state === 'CURRENT' && asOfLater.positions[1].state === 'ENDED' && asOfLater.positions[1].ended.how === 'MOVED' && asOfLater.positions[1].ended.label === `Moved to ${V.position_code}`,
    'read as of that date (?on=): the new one is current and the old one reads "Moved to <code>"');
  const taken = await caught(() => HELD.moveEmployee(db, c, L.id, { positionId: V.id, effectiveFrom: plusDays(20) }));
  ok(refused(taken, 409, 'POSITION_FILLED'), 'a position promised to somebody from a later date is not free for another person after it: 409 POSITION_FILLED', why(taken));

  // ── how it ended: left the company ──
  await db.query("UPDATE hrms_work_assignments SET status = 'ENDED', effective_to = ? WHERE id = ?", [yesterday, L.assignment_id]);
  await db.query(
    "INSERT INTO hrms_employee_exits (company_id, employee_id, exit_type, reason_code, notice_date, last_working_day, status, closed_on) VALUES (?, ?, 'RESIGNED', 'OTHER', ?, ?, 'CLOSED', ?)",
    [COMPANY, L.id, plusDays(-5), yesterday, today]);
  await db.query("UPDATE hrms_employees SET employment_status = 'EXITED' WHERE id = ?", [L.id]);
  const gone = await HELD.positionsHeld(db, COMPANY, L.id);
  ok(JSON.stringify(gone.positions[0].ended) === JSON.stringify({ how: 'LEFT', label: 'Left the company', on: yesterday }) && gone.current.length === 0 && gone.employee.status === 'EXITED',
    'the last position of somebody who left reads "Left the company"', JSON.stringify(gone.positions[0].ended));
  await db.query("UPDATE hrms_work_assignments SET status = 'ENDED', effective_to = ? WHERE id = ?", [plusDays(-3), second.moved.assignmentId]);
  ok((await HELD.positionsHeld(db, COMPANY, F.id)).positions.find((p) => p.assignmentId === second.moved.assignmentId).ended.how === 'ENDED', 'a position that simply ended, with nothing after it, reads "Ended"');

  // ── another company ──
  ok(refused(await caught(() => HELD.positionsHeld(db, OTHER, E.id)), 404, 'NOT_FOUND') && refused(await caught(() => HELD.moveEmployee(db, there, E.id, { positionId: H.id })), 404, 'NOT_FOUND'),
    'another company cannot read a person’s positions or move them: 404');
  const [[foreign]] = await db.query('SELECT p.id FROM hrms_positions p WHERE p.company_id <> ? AND p.deleted_at IS NULL LIMIT 1', [COMPANY]);
  if (foreign) ok(refused(await caught(() => HELD.moveEmployee(db, c, L.id === E.id ? F.id : E.id, { positionId: foreign.id, keepCurrent: true })), 404, 'NOT_FOUND'), 'nor can this company move somebody into another company’s position: 404');
  else skip('moving into another company’s position', 'no other company has a position');
});

/* ══ 5. permissions and shapes over HTTP (reads and refusals only — nothing is written) ══ */
section('[5] Permissions and shapes, over HTTP');
{
  const server = express();
  server.use(express.json({ limit: '50mb' }));
  server.use(cookieParser());
  server.use('/api', appContext);
  hrmsApp.register(server);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const tokenFor = async (where) => {
    const [[u]] = await pool.query(
      `SELECT u.id, u.email, u.company_id, co.slug, r.name AS role FROM users u
         JOIN companies co ON co.id = u.company_id LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.deleted_at IS NULL AND ${where} ORDER BY u.id LIMIT 1`);
    return u ? { ...u, token: signToken({ id: u.id, email: u.email, role: u.role, company: u.slug, companyId: u.company_id, company_id: u.company_id, uiPermissions: [] }) } : null;
  };
  const call = async (who, method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  try {
    const hasApp = "EXISTS (SELECT 1 FROM app_user_access x JOIN apps a ON a.id = x.app_id WHERE x.user_id = u.id AND x.deleted_at IS NULL AND a.slug = 'cf_hrms')";
    const admin = await tokenFor(`u.company_id = ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp}`);
    const employee = await tokenFor(`u.company_id = ${COMPANY} AND r.name = 'Employee' AND ${hasApp} AND EXISTS (SELECT 1 FROM hrms_employees e WHERE e.user_id = u.id AND e.deleted_at IS NULL)`);
    const api = `/${slug}/cf_hrms`;
    const [[anyEmployee]] = await pool.query('SELECT id FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
    const ROUTES = [
      ['GET', '/organisation/department-labels'], ['POST', '/organisation/department-labels', { name: 'x' }], ['PUT', '/organisation/department-labels/order', { ids: [] }],
      ['PUT', '/organisation/department-labels/1', { name: 'x' }], ['DELETE', '/organisation/department-labels/1?moveTo=2'],
      ['GET', `/people/employees/${anyEmployee?.id ?? 1}/positions`], ['POST', `/people/employees/${anyEmployee?.id ?? 1}/move`, { positionId: 1 }],
      ['GET', '/codegen/entities'], ['POST', '/codegen/preview', { entityType: 'hrms_position', draft: {} }],
    ];
    if (employee) {
      const wrong = [];
      for (const [method, url, body] of ROUTES) { const r = await call(employee, method, `${api}${url}`, body); if (r.status !== 403) wrong.push(`${method} ${url} ${r.status}`); }
      ok(wrong.length === 0, `an Employee login gets 403 from all ${ROUTES.length} of the new routes`, wrong.join('; '));
    } else skip('an Employee login', 'no such login with access to the app');
    ok((await call(null, 'GET', `${api}/organisation/department-labels`)).status === 401 && (await call(null, 'POST', `${api}/people/employees/1/move`, {})).status === 401, 'no token at all: 401');
    if (admin) {
      const labels = await call(admin, 'GET', `${api}/organisation/department-labels`);
      ok(labels.status === 200 && Array.isArray(labels.json.labels) && labels.json.labels.length >= 1 && labels.json.labels.every((l) => typeof l.name === 'string' && Number.isInteger(l.departmentCount) && Number.isInteger(l.sortOrder)),
        'GET /organisation/department-labels answers { labels: [{ id, name, sortOrder, departmentCount }] }');
      const order = await call(admin, 'PUT', `${api}/organisation/department-labels/order`, { ids: [] });
      const noLabel = await call(admin, 'DELETE', `${api}/organisation/department-labels/999999999?moveTo=1`);
      ok(order.status === 422 && order.json.code === 'INVALID' && noLabel.status === 404, '"order" is not read as an id (422 for an order that is not the whole list); a label that does not exist is 404', `${order.status} ${noLabel.status}`);
      const held = await call(admin, 'GET', `${api}/people/employees/${anyEmployee.id}/positions`);
      ok(held.status === 200 && Array.isArray(held.json.positions) && 'can' in held.json && held.json.employee.id === anyEmployee.id, 'GET /people/employees/:id/positions answers over HTTP');
      const badMove = await call(admin, 'POST', `${api}/people/employees/${anyEmployee.id}/move`, {});
      ok(badMove.status === 422 && badMove.json.code === 'INVALID' && Array.isArray(badMove.json.problems), 'POST …/move with no position: 422 { code, message, problems[] } — nothing written', JSON.stringify(badMove.json));
      const entities = await call(admin, 'GET', `${api}/codegen/entities`);
      const by = Object.fromEntries((entities.json ?? []).map((e) => [e.entityType, e]));
      const keys = (e) => e.tokens.map((t) => t.key).join(' ');
      const tests = (e) => e.conditionTokens.map((t) => `${t.key}:${t.operators.join('/')}:${t.valueKind}`).join(' ');
      ok(entities.status === 200 && JSON.stringify(entities.json.map((e) => `${e.entityType}=${e.label}`)) === JSON.stringify([
        'hrms_department=Departments', 'hrms_role=Roles', 'hrms_position=Positions', 'hrms_location=Locations', 'hrms_employee=Employees', 'hrms_hiring=Letters (reference numbers)']),
      'GET /codegen/entities lists the six, in the order of the screen, with its labels', JSON.stringify(entities.json?.map?.((e) => e.label)));
      ok(keys(by.hrms_department) === 'label label.initial name.initials name parent.code' && tests(by.hrms_department) === 'label:eq/in:departmentLabel'
        && keys(by.hrms_role) === 'title.initials title department.code' && tests(by.hrms_role) === ''
        && keys(by.hrms_position) === 'role.code department.code shift.code location.code card.code' && tests(by.hrms_position) === 'department:under/eq/in:department role:eq/in:role'
        && keys(by.hrms_location) === 'name.initials name city.initials' && tests(by.hrms_location) === ''
        && ['hrms_department', 'hrms_role', 'hrms_position', 'hrms_location'].every((k) => by[k].tokens.every((t) => t.label && t.phrase && t.help && t.example && t.available === true)
          && by[k].conditionTokens.every((t) => t.label && t.phrase && t.help)),
      'each of the four offers its tokens and its conditions, every one with label, phrase, help and example');
      const preview = await call(admin, 'POST', `${api}/codegen/preview`, { entityType: 'hrms_role', draft: { title: 'Quality Inspector' } });
      ok(preview.status === 200 && typeof preview.json.text === 'string' && preview.json.text.length > 0, 'POST /codegen/preview for a role that is not saved yet shows the shape of its code', JSON.stringify(preview.json));
      const schemes = await call(admin, 'GET', `${api}/codegen/schemes?entityType=hrms_position`);
      ok(schemes.status === 200 && Array.isArray(schemes.json) && schemes.json.every((s) => s.entityType === 'hrms_position'), 'GET /codegen/schemes?entityType=hrms_position lists position rules only (whatever rule the company has, or none)');
    } else skip('an admin login', 'this company has no admin login with access to the app');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

section('[end] The tenant is as it was found');
{
  const after = await snapshot();
  const moved = Object.keys(baseline).filter((k) => after[k] !== baseline[k]);
  ok(moved.length === 0, `every hrms_ table, department label, code rule and counter of both companies is as it started (${hrmsTables.length} tables)`, moved.map((k) => `${k} ${String(baseline[k]).slice(0, 80)} -> ${String(after[k]).slice(0, 80)}`).join('; '));
  const [[left]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM hrms_departments WHERE name LIKE ?) AS departments, (SELECT COUNT(*) FROM hrms_department_labels WHERE name LIKE ?) AS labels,
            (SELECT COUNT(*) FROM cf_code_schemes WHERE code LIKE ?) AS rules`, [`${TAG}%`, `${TAG}%`, `${TAG}%`]);
  ok(Number(left.departments) === 0 && Number(left.labels) === 0 && Number(left.rules) === 0, 'no department, label or code rule made by this run is left');
}

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) console.log(`  skipped — ${s}`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
