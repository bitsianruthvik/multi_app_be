/**
 * departments_model_test.mjs — "everything is a department" (2026-10-10).
 *
 * What the chart is built against, checked on the real services and a real
 * tenant, with nothing written (every write is in a transaction that is rolled
 * back):
 *
 *   1. GET /orgchart            the `departments` contract; every node's
 *                               departmentId resolves; contexts is []; the
 *                               query count did not grow.
 *   2. GET /user/me/orgchart    for EVERY linked employee: only the departments
 *                               the slice may see, every parentId and serves id
 *                               resolves inside the payload, and nothing beyond
 *                               the whitelist travels.
 *   3. GET /orgchart/departments  the rollup no longer reads work contexts.
 *   4. department create/update/delete: type, isShared and serves are
 *                               validated in the service (TiDB holds no CHECK).
 *
 *   node scripts/cf_hrms/departments_model_test.mjs [--company=karni]
 *
 * No hard-coded data: it reads the tenant and SKIPS, saying why, what the data
 * cannot exercise. Local only — it refuses a non-local DB_HOST.
 */
import { pool } from '../../db.js';
import { buildOrgChart, getPositionCard } from '../../apps/cf_hrms/services/orgChartService.js';
import { myOrgChart, sliceDepartments, computeSlice } from '../../apps/cf_hrms/services/selfOrgChartService.js';
import { buildDepartmentRollup } from '../../apps/cf_hrms/services/departmentRollupService.js';
import {
  listDepartments, createDepartment, updateDepartment, deleteDepartment, lookups,
} from '../../apps/cf_hrms/services/organisationService.js';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
if (!['localhost', '127.0.0.1'].includes(process.env.DB_HOST)) {
  console.error(`Refusing to run against DB_HOST=${process.env.DB_HOST}. This test is local only.`);
  process.exit(2);
}

let passed = 0;
const failed = [];
const skipped = [];
const ok = (cond, name, detail = '') => { if (cond) passed += 1; else failed.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const skip = (name, why) => skipped.push(`${name}: ${why}`);
const keysOf = (o) => Object.keys(o).sort().join(',');

/** Count round trips on a connection-like object. */
const counting = (db) => { const c = { n: 0, query: (...a) => { c.n += 1; return db.query(...a); } }; return c; };

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company "${slug}".`); process.exit(2); }
const companyId = company.id;

/* ── 1. the chart payload ─────────────────────────────────────────────────── */
const counted = counting(pool);
const chart = await buildOrgChart(counted, companyId, {});
const DEPT_KEYS = 'code,id,isShared,name,parentId,rank,serves,type';
ok(Array.isArray(chart.departments) && chart.departments.length > 0, 'orgchart carries departments');
ok(chart.departments.every((d) => keysOf(d) === DEPT_KEYS), 'every department has exactly the contract\'s fields',
  chart.departments.find((d) => keysOf(d) !== DEPT_KEYS) ? keysOf(chart.departments.find((d) => keysOf(d) !== DEPT_KEYS)) : '');
const deptById = new Map(chart.departments.map((d) => [d.id, d]));
ok(chart.departments.every((d) => d.parentId == null || deptById.has(d.parentId)), 'every parentId is a department in the payload');
ok(chart.departments.every((d) => typeof d.isShared === 'boolean' && Array.isArray(d.serves)), 'isShared is a boolean and serves an array');
ok(chart.departments.every((d) => d.serves.every((id) => deptById.has(id) && id !== d.id)), 'every serves id is another department in the payload');
ok(chart.departments.every((d) => d.isShared || d.serves.length === 0), 'only a shared department serves anything');
ok(new Set(chart.departments.map((d) => d.rank)).size === chart.departments.length, 'ranks are distinct');
ok(chart.departments.every((d, i, a) => i === 0 || a[i - 1].rank < d.rank), 'departments arrive in rank order');
// rank is a pre-order: a parent always ranks before its children
ok(chart.departments.every((d) => d.parentId == null || deptById.get(d.parentId).rank < d.rank), 'a parent ranks before its children');
ok(chart.nodes.every((n) => 'departmentId' in n), 'every node carries departmentId');
ok(chart.nodes.every((n) => n.departmentId == null || deptById.has(n.departmentId)), 'every node\'s departmentId is in departments');
ok(chart.nodes.every((n) => n.departmentId == null
  || (n.departmentName === deptById.get(n.departmentId).name && n.departmentCode === deptById.get(n.departmentId).code
    && n.departmentRank === deptById.get(n.departmentId).rank && n.departmentIsRoot === (deptById.get(n.departmentId).parentId == null))),
'departmentName / Code / Rank / IsRoot still agree with the tree');
ok(chart.nodes.every((n) => Array.isArray(n.contexts) && n.contexts.length === 0), 'node.contexts is an empty array');
// 9 company-wide reads + attendance when anyone is seated. It was the same before departments joined the payload.
const expectedQueries = 9 + (chart.nodes.some((n) => n.occupants.length) ? 1 : 0);
ok(counted.n === expectedQueries, 'the chart still costs the same number of queries', `${counted.n} (expected ${expectedQueries})`);
const sharedDepts = chart.departments.filter((d) => d.isShared);
if (!sharedDepts.length) skip('shared departments in the payload', 'this company has none');
else ok(sharedDepts.every((d) => d.serves.length >= 2), 'a shared department serves two or more', sharedDepts.map((d) => `${d.name}:${d.serves.length}`).join(' '));

// re-rooted: still the whole tree
const anyManager = chart.edges.find((e) => e.typeCode === 'PRIMARY_MANAGER');
if (anyManager) {
  const sub = await buildOrgChart(pool, companyId, { root: anyManager.toPositionId });
  ok(sub.departments.length === chart.departments.length, 'a re-rooted chart still carries the whole department tree');
}

// the card
if (chart.nodes.length) {
  const cardDb = counting(pool);
  const n = chart.nodes.find((x) => x.departmentId != null) ?? chart.nodes[0];
  const card = await getPositionCard(cardDb, companyId, n.id, {});
  ok(Array.isArray(card.contexts) && card.contexts.length === 0 && card.counts.contexts === 0, 'the card\'s contexts are empty');
  ok(card.departmentId === n.departmentId && 'departmentType' in card && 'departmentIsShared' in card, 'the card names the seat\'s department, its label and whether it is shared');
}

/* ── 2. the employee slice, for every linked employee ─────────────────────── */
const [linked] = await pool.query(
  'SELECT e.id, e.user_id, e.full_name FROM hrms_employees e WHERE e.company_id = ? AND e.user_id IS NOT NULL AND e.deleted_at IS NULL', [companyId]);
const NODE_KEYS = 'contexts,defaultShift,departmentCode,departmentId,departmentIsRoot,departmentName,departmentRank,displayTitle,effectiveSanctioned,id,locationName,occupants,positionCode,relation,requirements,roleTitle,sanctionedHeadcount,shiftPattern,title';
if (!linked.length) skip('the employee slice', 'no employee is linked to a login (run create-employee-logins.mjs --apply)');
else {
  let leaks = 0, dangling = 0, badKeys = 0, missing = 0, wide = 0, slices = 0, emptyCtx = 0, withShared = 0;
  for (const e of linked) {
    const slice = await myOrgChart(pool, { companyId, userId: e.user_id }, {});
    if (!slice.linked) continue;
    slices += 1;
    const ids = new Set(slice.departments.map((d) => d.id));
    // What the slice is ALLOWED to see, recomputed here from the full chart.
    const allowed = new Set();
    const add = (id) => { let c = deptById.get(id), g = 0; while (c && g++ < 100) { allowed.add(c.id); c = c.parentId != null ? deptById.get(c.parentId) : null; } };
    for (const n of slice.nodes) if (n.departmentId != null) add(n.departmentId);
    for (const id of [...allowed]) { const d = deptById.get(id); if (d.isShared) d.serves.forEach(add); }
    if ([...ids].some((id) => !allowed.has(id))) leaks += 1;
    if ([...allowed].some((id) => !ids.has(id))) missing += 1;
    if (slice.departments.some((d) => (d.parentId != null && !ids.has(d.parentId)) || d.serves.some((s) => !ids.has(s)))) dangling += 1;
    if (slice.departments.some((d) => keysOf(d) !== DEPT_KEYS) || slice.nodes.some((n) => keysOf(n) !== NODE_KEYS)) badKeys += 1;
    if (slice.nodes.some((n) => n.contexts.length)) emptyCtx += 1;
    if (ids.size === chart.departments.length && slice.nodes.length < chart.nodes.length) wide += 1;
    if (slice.departments.some((d) => d.isShared)) withShared += 1;
  }
  ok(slices > 0, 'at least one employee has a slice');
  ok(leaks === 0, 'no slice carries a department its seats do not imply', `${leaks} of ${slices}`);
  ok(missing === 0, 'no slice is missing a department its seats imply', `${missing} of ${slices}`);
  ok(dangling === 0, 'every parentId and serves id in a slice resolves inside it', `${dangling} of ${slices}`);
  ok(badKeys === 0, 'a slice carries only whitelisted fields (nodes and departments)', `${badKeys} of ${slices}`);
  ok(emptyCtx === 0, 'a slice\'s contexts are always empty');
  ok(wide === 0, 'no partial slice was handed the whole department tree', `${wide} of ${slices}`);
  console.log(`  slices checked: ${slices} (${withShared} include a shared department)`);
}
// the pure function, on a made-up tree: a shared department drags in what it serves, and their ancestors
{
  const tree = [
    { id: 1, code: 'A', name: 'A', parentId: null, type: null, isShared: false, serves: [], rank: 0 },
    { id: 2, code: 'B', name: 'B', parentId: 1, type: null, isShared: false, serves: [], rank: 1 },
    { id: 3, code: 'C', name: 'C', parentId: 2, type: null, isShared: false, serves: [], rank: 2 },
    { id: 4, code: 'D', name: 'D', parentId: 1, type: null, isShared: false, serves: [], rank: 3 },
    { id: 5, code: 'E', name: 'E', parentId: 4, type: null, isShared: false, serves: [], rank: 4 },
    { id: 6, code: 'S', name: 'S', parentId: 1, type: null, isShared: true, serves: [3, 5], rank: 5 },
    { id: 7, code: 'X', name: 'X', parentId: null, type: null, isShared: false, serves: [], rank: 6 },
    { id: 8, code: 'Y', name: 'Y', parentId: 4, type: null, isShared: false, serves: [], rank: 7 },
  ];
  const got = (ids) => sliceDepartments(tree, ids).map((d) => d.code).join('');
  ok(got([3]) === 'ABC', 'slice: a seat\'s department and its ancestors only', got([3]));
  ok(got([6]) === 'ABCDES', 'slice: a shared department brings what it serves, and their ancestors', got([6]));
  ok(got([5]) === 'ADE', 'slice: a served department does NOT bring the shared department serving it', got([5]));
  ok(got([null]) === '', 'slice: a seat with no department brings nothing');
  ok(typeof computeSlice === 'function', 'computeSlice is still exported');
}

/* ── 3. the rollup ───────────────────────────────────────────────────────── */
{
  const seen = [];
  const spy = { query: (sql, ...rest) => { seen.push(String(sql)); return pool.query(sql, ...rest); } };
  const roll = await buildDepartmentRollup(spy, companyId, {});
  ok(!seen.some((sql) => /hrms_(position_)?work_contexts|hrms_work_assignment_contexts/.test(sql)), 'the rollup reads no work-context table');
  ok(roll.units.length === chart.departments.length, 'the rollup has one unit per department', `${roll.units.length} vs ${chart.departments.length}`);
  ok(roll.units.every((u) => 'type' in u && typeof u.isShared === 'boolean'), 'every rollup unit carries type and isShared');
  ok(roll.units.every((u) => u.qualifierKind !== 'context'), 'no unit is qualified by a work context any more');
}
{
  const seen = [];
  const spy = { query: (sql, ...rest) => { seen.push(String(sql)); return pool.query(sql, ...rest); } };
  await buildOrgChart(spy, companyId, {});
  ok(!seen.some((sql) => /hrms_position_work_contexts|hrms_work_assignment_contexts/.test(sql)), 'the chart reads no context-link table');
}

/* ── 4. department writes, rolled back ───────────────────────────────────── */
{
  const conn = await pool.getConnection();
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [companyId]);
  const c = { companyId, userId: user?.id ?? null };
  const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  const tag = `ZZT${Date.now().toString(36)}`;
  try {
    await conn.beginTransaction();
    const a = await createDepartment(conn, c, { name: `${tag} A`, type: 'Machine / area' });
    const b = await createDepartment(conn, c, { name: `${tag} B`, type: '  Line  ' });
    ok(a.type === 'Machine / area' && a.isShared === false && a.serves.length === 0, 'create: type is stored, not shared by default');
    ok(b.type === 'Line', 'create: the label is trimmed', JSON.stringify(b.type));
    const s = await createDepartment(conn, c, { name: `${tag} Shared`, type: 'Shared crew', isShared: true, serves: [a.id, b.id] });
    ok(s.isShared === true && s.serves.slice().sort().join() === [a.id, b.id].sort().join(), 'create: a shared department with what it serves');

    const e1 = await refused(() => createDepartment(conn, c, { name: `${tag} bad`, serves: [a.id] }));
    ok(e1 && /shared/i.test(JSON.stringify(e1.problems ?? e1.message)), 'refused: serves on a department that is not shared');
    const e2 = await refused(() => updateDepartment(conn, c, s.id, { serves: [s.id] }));
    ok(e2 && /itself/i.test(JSON.stringify(e2.problems ?? e2.message)), 'refused: a department serving itself');
    const e3 = await refused(() => updateDepartment(conn, c, s.id, { serves: [987654321] }));
    ok(e3 && /not exist/i.test(JSON.stringify(e3.problems ?? e3.message)), 'refused: serving a department that does not exist');
    const e4 = await refused(() => createDepartment(conn, c, { name: `${tag} long`, type: 'x'.repeat(41) }));
    ok(e4 && /40/.test(JSON.stringify(e4.problems ?? e4.message)), 'refused: a label over 40 characters');
    const e5 = await refused(() => createDepartment(conn, c, { name: `${tag} maybe`, isShared: 'perhaps' }));
    ok(!!e5, 'refused: isShared that is not yes or no');
    const [[other]] = await conn.query('SELECT d.id FROM hrms_departments d WHERE d.company_id <> ? AND d.deleted_at IS NULL LIMIT 1', [companyId]);
    if (!other) skip('serving another company\'s department', 'no other company has a department');
    else {
      const e6 = await refused(() => updateDepartment(conn, c, s.id, { serves: [a.id, other.id] }));
      ok(!!e6, 'refused: serving a department of ANOTHER company');
    }

    const s2 = await updateDepartment(conn, c, s.id, { serves: [a.id] });
    ok(s2.serves.join() === String(a.id), 'update: serves is replaced, not appended');
    const s3 = await updateDepartment(conn, c, s.id, { serves: [a.id, b.id] });
    ok(s3.serves.length === 2, 'update: a pair that was removed can be added again (soft-delete-aware key)');
    const e7 = await refused(() => deleteDepartment(conn, c, a.id));
    ok(e7 && /shared department/i.test(JSON.stringify(e7.problems ?? e7.message)), 'refused: deleting a department a shared one still serves');
    const s4 = await updateDepartment(conn, c, s.id, { isShared: false });
    ok(s4.isShared === false && s4.serves.length === 0, 'update: un-sharing retires what it served');
    const [[live]] = await conn.query('SELECT COUNT(*) n FROM hrms_department_serves WHERE company_id = ? AND department_id = ? AND deleted_at IS NULL', [companyId, s.id]);
    ok(Number(live.n) === 0, 'no live serves row is left on a department that is no longer shared');
    const gone = await deleteDepartment(conn, c, a.id);
    ok(gone.ok === true, 'delete: allowed once nothing serves it');

    const list = await listDepartments(conn, companyId);
    ok(Array.isArray(list.types) && list.types.includes('Line'), 'list: the labels in use are offered back');
    ok(list.rows.every((r) => 'type' in r && typeof r.isShared === 'boolean' && Array.isArray(r.serves)), 'list: every row carries type, isShared and serves');
    const look = await lookups(conn, companyId);
    ok(look.departments.every((d) => 'parentId' in d && 'type' in d && 'isShared' in d), 'lookups: departments carry parentId, type, isShared');
  } finally {
    await conn.rollback();
    conn.release();
  }
  const [[left]] = await pool.query('SELECT COUNT(*) n FROM hrms_departments WHERE company_id = ? AND name LIKE ?', [companyId, `${tag}%`]);
  ok(Number(left.n) === 0, 'the test left nothing behind');
}

await pool.end();
console.log(`\n  ${company.name}: ${passed} passed, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
for (const s of skipped) console.log(`    skip ${s}`);
for (const f of failed) console.log(`    FAIL ${f}`);
process.exit(failed.length ? 1 : 0);
