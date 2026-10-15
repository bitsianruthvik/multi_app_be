/**
 * ask_test.mjs — "Who owns X?" (CF_HRMS_HIRING_SPEC.md §21; services/semantic/askService.js).
 *
 *   1. reading the question: leading question words and trailing kind words off,
 *      a trailing "in <place>" read as a filter, articles and fillers;
 *   2. the person-layer batch reader (effectiveLinesForAssignments) agrees with
 *      resolveContent({ workAssignmentId }) for every holder;
 *   3. people first: one entry per person, ranked; vacant positions listed after,
 *      with no person on them;
 *   4. a person-layer line is found for THAT person only, and a line they
 *      switched off is not (rolled back);
 *   5. a role's purpose and a department with its label are matched;
 *   6. filters: kinds (given and read from the question), department (and below),
 *      label, location, and the place read from the question;
 *   7. scope: a department-scoped login gets people from its scope only;
 *      positions stay company-wide without outside names;
 *   8. the memory guard: keyword mode with a notice, same answer as exact;
 *   9. tenant isolation;
 *  10. over HTTP: /orgchart/ask (admin 200, scoped, Employee 403, other
 *      company 403, bad kind 422) and /orgchart/search's old envelope unchanged;
 *  11. the eight example questions (printed with their top answers);
 *  end. nothing left behind.
 *
 *   node scripts/cf_hrms/ask_test.mjs [--company=karni] [--verbose]
 *
 * Local only. Writes happen in transactions that are rolled back. Needs the
 * index built (apps/cf_hrms/scripts/build-search-index.mjs --company=karni --apply);
 * a missing index only makes the first question slower.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from '../../db.js';
import { signToken } from '../../core/utils/jwt.js';
import { appContext } from '../../core/middleware/appContext.js';
import hrmsApp from '../../apps/cf_hrms/app.js';
import * as POS from '../../apps/cf_hrms/services/positionService.js';
import { addAssignmentOverride } from '../../apps/cf_hrms/services/assignmentService.js';
import { resolveContent, effectiveLinesForAssignments } from '../../apps/cf_hrms/services/contentResolver.js';
import { askWhoOwns, readQuestion } from '../../apps/cf_hrms/services/semantic/askService.js';
import { loadEntities, invalidateVectors, entityText } from '../../apps/cf_hrms/services/semantic/searchIndex.js';
import { scopeFor } from '../../apps/cf_hrms/services/accessScope.js';
import { __clearFailure, unload } from '../../apps/cf_hrms/services/semantic/embedder.js';

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
const skip = (name, why) => { skipped.push(`${name}: ${why}`); console.log(`  skip  ${name}: ${why}`); };
const section = (title) => console.log(`\n${title}`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const [[company]] = await pool.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company "${slug}".`); process.exit(2); }
const COMPANY = company.id;
const IS_KARNI = slug === 'karni';
const TAG = `zzask${Date.now().toString(36).slice(-5)}`;
const on = POS.today();
const [[adminUser]] = await pool.query(
  `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(r.name) = 'admin' ORDER BY u.id LIMIT 1`, [COMPANY]);
const c = { companyId: COMPANY, userId: adminUser?.id ?? null, owner: true };
const [[other]] = await pool.query('SELECT id, slug FROM companies WHERE id <> ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);

const counts = async () => {
  const [[v]] = await pool.query('SELECT COUNT(*) n, MAX(updated_at) m FROM hrms_search_vectors WHERE company_id = ?', [COMPANY]);
  const [[o]] = await pool.query('SELECT COUNT(*) n FROM hrms_work_assignment_content_overrides WHERE company_id = ?', [COMPANY]);
  const [[d]] = await pool.query('SELECT COUNT(*) n FROM hrms_responsibility_definitions WHERE company_id = ?', [COMPANY]);
  return `vectors ${v.n} (${v.m}), person overrides ${o.n}, responsibility defs ${d.n}`;
};
const before = await counts();

const [holders] = await pool.query(
  `SELECT wa.id AS workAssignmentId, wa.position_id AS positionId, wa.role_id AS roleId, wa.employee_id AS employeeId,
          p.role_id AS positionRoleId, p.department_id AS departmentId
     FROM hrms_work_assignments wa
     JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id AND p.deleted_at IS NULL
    WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED' AND ${POS.LIVE_ON('wa')}
      AND p.status <> 'CLOSED' AND ${POS.LIVE_ON('p')}
    ORDER BY wa.id`, [COMPANY, on, on, on, on]);

/* ══ 1 ════════════════════════════════════════════════════════════════════ */
section('[1] Reading the question');
{
  const places = new Map([['unit 2', { kind: 'LOCATION', id: 1, name: 'Unit 2' }], ['printing', { kind: 'DEPARTMENT', id: 2, name: 'Printing' }]]);
  const CASES = [
    ['Who owns vendor onboarding?', 'vendor onboarding', null, null],
    ['Who is responsible for collections?', 'collections', null, null],
    ["who's in charge of the boiler", 'boiler', null, null],
    ['Who has customer complaints as a KRA?', 'customer complaints', ['KRA'], null],
    ['who has scrap under 2% as a KPI', 'scrap under 2%', ['KPI'], null],
    ['Who handles SAP?', 'SAP', null, null],
    ['who looks after machine maintenance in Unit 2', 'machine maintenance', null, 'Unit 2'],
    ['who prepares the dispatch plan', 'prepares the dispatch plan', null, null],
    ['who trains new operators', 'trains new operators', null, null],
    ['Which position does stock audits?', 'stock audits', null, null],
    ['tell me who takes care of ink mixing in printing', 'ink mixing', null, 'Printing'],
    ['is there anyone who approves vendor payments', 'approves vendor payments', null, null],
    ['training in the canteen', 'training in the canteen', null, null],
    ['safety audit', 'safety audit', null, null],
    ['who', 'who', null, null],
  ];
  for (const [q, want, kinds, place] of CASES) {
    const r = readQuestion(q, places);
    ok(r.searchedFor === want && JSON.stringify(r.kinds) === JSON.stringify(kinds) && (r.place?.name ?? null) === place,
      `"${q}" -> "${want}"${kinds ? ` (${kinds})` : ''}${place ? ` in ${place}` : ''}`,
      `got "${r.searchedFor}" ${JSON.stringify(r.kinds)} ${r.place?.name ?? ''} stripped ${JSON.stringify(r.stripped)}`);
  }
  ok(readQuestion('Who owns vendor onboarding?').stripped.join('|') === '?|Who owns', 'what was taken off is listed, in order');
  ok(JSON.stringify(readQuestion('who prepares the dispatch plan').words) === JSON.stringify(['prepares', 'dispatch', 'plan']),
    'small words are not counted as words a line must contain');
  const empty = await caught(() => askWhoOwns(pool, COMPANY, { q: '  ' }));
  ok(empty?.status === 422, 'an empty question is refused (422)');
  const bad = await caught(() => askWhoOwns(pool, COMPANY, { q: 'x', kinds: 'SALARY' }));
  ok(bad?.status === 422, 'an unknown kind is refused (422)');
}

/* ══ 2 ════════════════════════════════════════════════════════════════════ */
section('[2] The person-layer batch reader agrees with resolveContent');
const resolvedSet = (r) => [
  ...r.kras, ...r.kras.flatMap((k) => [...k.responsibilities, ...k.kpis]), ...r.additional.responsibilities, ...r.additional.kpis,
].map((i) => `${i.kind}:${i.definitionId}:${i.origin}`).sort().join('|');
const lineSet = (lines) => lines.map((l) => `${l.kind}:${l.definitionId}:${l.origin}`).sort().join('|');
async function crossCheck(db, list) {
  const batch = await effectiveLinesForAssignments(db, COMPANY, list, { on, kinds: ['KRA', 'RESPONSIBILITY', 'KPI'] });
  const wrong = [];
  for (const a of list) {
    if (Number(a.roleId) !== Number(a.positionRoleId)) continue;
    let r;
    try { r = await resolveContent(db, COMPANY, { workAssignmentId: a.workAssignmentId, on }); } catch { continue; }
    if (resolvedSet(r) !== lineSet(batch.get(Number(a.workAssignmentId)) ?? [])) wrong.push(a.workAssignmentId);
  }
  return wrong;
}
{
  const wrong = await crossCheck(pool, holders);
  ok(holders.length > 0 && wrong.length === 0, `person lines match resolveContent for all ${holders.length} holders`, `differ: ${wrong.slice(0, 10).join(', ')}`);
}

/* ══ 3 ════════════════════════════════════════════════════════════════════ */
section('[3] People first, then vacant positions');
{
  const r = await askWhoOwns(pool, COMPANY, { q: 'Who is responsible for safety?', limit: 200 });
  const ids = r.people.map((p) => p.employeeId);
  ok(r.people.length > 0 && new Set(ids).size === ids.length, `one entry per person (${r.people.length} people)`);
  ok(r.people.every((p, i, a) => i === 0 || a[i - 1].rank >= p.rank), 'people are ranked best first');
  ok(r.people.every((p) => p.matches.length > 0 && p.matchCount >= p.matches.length && p.score === p.matches[0].score
    && new Set(p.matches.map((m) => `${m.kind}:${m.id}`)).size === p.matches.length),
  'each person carries their matched lines, best first, once each');
  ok(r.people.every((p) => p.matches.every((m) => typeof m.why === 'string' && m.why.length > 0 && m.text)), 'every match says why');
  ok(r.people.every((p) => p.positions.length > 0 && p.positions.every((x) => x.positionId && x.title)), 'each person with their position(s), department');
  // Same best line, different number of matching lines: more lines first.
  let pairFound = false;
  for (const q of ['Who is responsible for safety?', 'Who handles SAP?', 'who trains new operators', 'who looks after machine maintenance', 'Who is responsible for collections?']) {
    const x = await askWhoOwns(pool, COMPANY, { q, limit: 200 });
    for (const a of x.people) {
      const b = x.people.find((p) => p.score === a.score && p.matchCount < a.matchCount);
      if (!b) continue;
      pairFound = true;
      ok(x.people.indexOf(a) < x.people.indexOf(b), `with the same best line, more matching lines rank higher ("${q}": ${a.matchCount} lines before ${b.matchCount})`);
      break;
    }
    if (pairFound) break;
  }
  if (!pairFound) skip('several lines rank higher', 'no two people with the same best line');
  ok(r.vacant.length > 0 && r.vacant.every((p) => p.vacant && p.occupants.length === 0 && p.hiddenOccupants === 0 && /^No one — the position .+ is vacant$/.test(p.sentence)),
    `vacant positions listed with "No one — …" (${r.vacant.length})`);
  const personPositions = new Set(r.people.flatMap((p) => p.positions.map((x) => x.positionId)));
  ok(r.vacant.every((p) => !personPositions.has(p.positionId)), 'no person is put on a vacant position');
  ok(r.positions.filter((p) => p.vacant).length === r.totals.vacant && r.totals.people === r.people.length,
    'totals agree with the lists');
}

/* ══ 4 ════════════════════════════════════════════════════════════════════ */
section('[4] A person\'s own line (rolled back)');
{
  // Two people in positions of the same role: the change is made for the first only.
  const byRole = new Map();
  for (const h of holders) if (Number(h.roleId) === Number(h.positionRoleId)) byRole.set(h.roleId, [...(byRole.get(h.roleId) ?? []), h]);
  const pair = [...byRole.values()].find((l) => l.length >= 2 && new Set(l.map((h) => h.employeeId)).size >= 2);
  if (!pair) skip('person layer', 'no role held by two people');
  else {
    const [me, sibling] = pair;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      invalidateVectors(COMPANY);
      const text = `Calibrate the ${TAG} zirconia hygrometer bank every fortnight.`;
      const [res] = await conn.query(
        "INSERT INTO hrms_responsibility_definitions (company_id, name, description, status) VALUES (?, ?, ?, 'ACTIVE')", [COMPANY, text, text]);
      await addAssignmentOverride(conn, c, me.workAssignmentId, { contentType: 'RESPONSIBILITY', action: 'ADD', responsibilityDefinitionId: res.insertId, reason: TAG });
      const r = await askWhoOwns(conn, COMPANY, { q: 'Who calibrates the hygrometer bank?', limit: 200 });
      const mine = r.people.find((p) => p.employeeId === Number(me.employeeId));
      const m = mine?.matches.find((x) => x.kind === 'RESPONSIBILITY' && x.id === res.insertId);
      ok(Boolean(m) && m.layer === 'PERSON' && /added for this person/.test(m.why), 'the person\'s own line is found for them, marked as theirs', JSON.stringify(m));
      ok(!r.people.some((p) => p.employeeId !== Number(me.employeeId) && p.matches.some((x) => x.id === res.insertId && x.kind === 'RESPONSIBILITY')),
        'and for nobody else (not the other holder of the same role)');
      const pos = r.positions.find((p) => p.positionId === Number(me.positionId));
      ok(Boolean(pos) && !pos.matches.some((x) => x.id === res.insertId && x.kind === 'RESPONSIBILITY'),
        'the position is listed (someone in it owns it) but the line is not the position\'s');

      // Switch off, for this person only, a role line the sibling keeps.
      const [[roleLine]] = await conn.query(
        `SELECT a.responsibility_definition_id AS id, d.name FROM hrms_role_responsibility_assignments a
           JOIN hrms_responsibility_definitions d ON d.id = a.responsibility_definition_id
          WHERE a.company_id = ? AND a.role_id = ? AND a.deleted_at IS NULL AND ${POS.LIVE_ON('a')} ORDER BY a.id LIMIT 1`,
        [COMPANY, me.roleId, on, on]);
      if (!roleLine) skip('switch off', 'the role has no responsibility');
      else {
        await addAssignmentOverride(conn, c, me.workAssignmentId, { contentType: 'RESPONSIBILITY', action: 'SUPPRESS', responsibilityDefinitionId: roleLine.id, reason: TAG });
        const s = await askWhoOwns(conn, COMPANY, { q: roleLine.name, kinds: 'RESPONSIBILITY', mode: 'exact', limit: 200 });
        const has = (emp) => s.people.find((p) => p.employeeId === Number(emp))?.matches.some((x) => x.id === roleLine.id);
        ok(!has(me.employeeId) && has(sibling.employeeId), 'a role line switched off for one person: not theirs any more, still the other holder\'s');
      }
      const wrong = await crossCheck(conn, [me, sibling]);
      ok(wrong.length === 0, 'the batch reader still agrees with resolveContent for both');
    } finally {
      await conn.rollback();
      conn.release();
      invalidateVectors(COMPANY);
    }
  }
}

/* ══ 5 ════════════════════════════════════════════════════════════════════ */
section('[5] Roles and departments are matched too');
{
  const roles = await loadEntities(pool, COMPANY, ['ROLE']);
  const role = roles.find((x) => /dispatch|planning|recruit/i.test(x.text) && x.text.length > x.name.length + 20) ?? roles.find((x) => x.text.length > x.name.length + 20);
  if (!role) skip('role purpose', 'no role with a purpose');
  else {
    const purpose = role.text.slice(role.name.length + 2).split(/[,.;]/)[0];
    const r = await askWhoOwns(pool, COMPANY, { q: `who ${purpose}`, kinds: 'ROLE', limit: 200 });
    const hit = r.positions.find((p) => p.matches.some((m) => m.kind === 'ROLE' && m.id === role.id));
    ok(Boolean(hit) && r.positions.every((p) => p.matches.every((m) => m.kind === 'ROLE' || m.kind === 'POSITION')),
      `a role's purpose ("${purpose.slice(0, 50)}…") finds that role's positions, kinds=ROLE only`);
  }
  const depts = await loadEntities(pool, COMPANY, ['DEPARTMENT']);
  const dept = depts.find((d) => d.labels?.length && d.labels.some((l) => l.toLowerCase() !== 'department'));
  if (!dept) skip('department label', 'no department with a label other than Department');
  else {
    const label = dept.labels.find((l) => l.toLowerCase() !== 'department');
    ok(dept.text === entityText.DEPARTMENT(dept.name, dept.labels) && dept.text.includes(label), `a department is indexed with its labels ("${dept.text}")`);
    const r = await askWhoOwns(pool, COMPANY, { q: `who works in ${dept.name} ${label}`, kinds: 'DEPARTMENT', limit: 200 });
    const inIt = r.positions.filter((p) => p.departmentId === dept.id);
    ok(inIt.length > 0 && inIt.every((p) => p.matches.some((m) => m.kind === 'DEPARTMENT' && m.id === dept.id)),
      `"${dept.name} ${label}": the positions of that department match by the department`);
    const person = r.people.find((p) => p.positions.some((x) => x.departmentId === dept.id));
    if (person) ok(person.matches.some((m) => m.kind === 'DEPARTMENT' && /^Works in /.test(m.why)), 'and its people, "Works in …"');
  }
}

/* ══ 6 ════════════════════════════════════════════════════════════════════ */
section('[6] Filters');
{
  const [depts] = await pool.query('SELECT id, name, parent_department_id FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  const kids = new Map();
  for (const d of depts) if (d.parent_department_id) kids.set(d.parent_department_id, [...(kids.get(d.parent_department_id) ?? []), d.id]);
  const tree = (id) => { const out = new Set(); const w = [id]; while (w.length) { const x = w.pop(); if (out.has(x)) continue; out.add(x); w.push(...(kids.get(x) ?? [])); } return out; };
  const parent = depts.find((d) => (kids.get(d.id) ?? []).length > 0 && d.parent_department_id);
  const q = 'Who is responsible for safety?';
  const all = await askWhoOwns(pool, COMPANY, { q, limit: 200 });
  if (parent) {
    const within = tree(parent.id);
    const r = await askWhoOwns(pool, COMPANY, { q, department: parent.id, limit: 200 });
    ok(r.positions.length > 0 && r.positions.every((p) => within.has(p.departmentId)) && r.positions.some((p) => p.departmentId !== parent.id),
      `department ${parent.name}: only it and the ones below it (${r.positions.length} positions)`);
    ok(r.people.every((p) => p.positions.some((x) => within.has(x.departmentId))) && r.filters.department?.name === parent.name, 'people too, and the filter is echoed');
  }
  const kinds = await askWhoOwns(pool, COMPANY, { q, kinds: 'KPI,KRA', limit: 200 });
  ok(kinds.people.every((p) => p.matches.every((m) => m.kind === 'KRA' || m.kind === 'KPI')) && kinds.kinds.join(',') === 'KRA,KPI', 'kinds=KPI,KRA: only KRAs and KPIs');
  const fromQ = await askWhoOwns(pool, COMPANY, { q: 'Who has safety as a KPI?', limit: 200 });
  ok(fromQ.kinds.join(',') === 'KPI' && fromQ.reading.kindsFromQuestion?.[0] === 'KPI' && fromQ.positions.every((p) => p.matches.every((m) => m.kind === 'KPI')),
    '"… as a KPI" narrows to KPIs');
  const given = await askWhoOwns(pool, COMPANY, { q: 'Who has safety as a KPI?', kinds: 'KRA', limit: 200 });
  ok(given.kinds.join(',') === 'KRA', 'kinds given win over the question');
  const [[label]] = await pool.query(
    `SELECT l.id, l.name FROM hrms_department_labels l JOIN hrms_label_groups g ON g.id = l.group_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND LOWER(l.name) = 'machine' LIMIT 1`, [COMPANY]);
  if (label) {
    const [inLabel] = await pool.query('SELECT id FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL AND LOWER(department_type) = LOWER(?)', [COMPANY, label.name]);
    const ids = new Set(inLabel.map((d) => d.id));
    const r = await askWhoOwns(pool, COMPANY, { q, label: String(label.id), limit: 200 });
    ok(r.positions.length > 0 && r.positions.length < all.positions.length && r.positions.every((p) => ids.has(p.departmentId)),
      `label ${label.name}: only positions in departments with it (${r.positions.length} of ${all.positions.length})`);
  } else skip('label filter', 'no Machine label');
  const [[loc]] = await pool.query('SELECT id, name FROM hrms_locations WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  if (loc) {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL AND location_id = ?', [COMPANY, loc.id]);
    const r = await askWhoOwns(pool, COMPANY, { q, location: loc.id, limit: 200 });
    ok(r.filters.location?.name === loc.name && r.positions.length <= all.positions.length && (Number(n) > 0 || r.positions.length === 0), `location ${loc.name}: filter applied`);
    const placed = await askWhoOwns(pool, COMPANY, { q: `who is responsible for safety in ${loc.name}`, limit: 200 });
    ok(placed.reading.place?.kind === 'LOCATION' && placed.filters.location?.id === loc.id && placed.reading.searchedFor === 'safety',
      `"… in ${loc.name}" is read as the location filter`);
    const nope = await askWhoOwns(pool, COMPANY, { q, location: 999999999, limit: 200 });
    ok(nope.people.length === 0 && nope.positions.length === 0, 'a location of no position: nothing');
  }
  const badDept = await caught(() => askWhoOwns(pool, COMPANY, { q, department: 'abc' }));
  ok(badDept?.status === 422, 'a department that is not an id is refused');
}

/* ══ 7 ════════════════════════════════════════════════════════════════════ */
section('[7] Scope: a department-scoped login');
let scopedIds = null;
{
  const [[head]] = await pool.query(
    `SELECT e.user_id FROM hrms_employees e
       JOIN hrms_work_assignments wa ON wa.company_id = e.company_id AND wa.employee_id = e.id AND wa.deleted_at IS NULL AND wa.status <> 'ENDED'
       JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id AND p.deleted_at IS NULL
      WHERE e.company_id = ? AND e.user_id IS NOT NULL
        -- a department with nothing below it, so the scope is narrower than the company
        AND p.department_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hrms_departments k
              WHERE k.company_id = p.company_id AND k.parent_department_id = p.department_id AND k.deleted_at IS NULL)
      ORDER BY e.id LIMIT 1`, [COMPANY]);
  if (!head) skip('scope', 'no employee with a login');
  else {
    const scope = await scopeFor(pool, { companyId: COMPANY, userId: head.user_id, scope: 'DEPARTMENT' });
    scopedIds = [...scope.departmentIds];
    // A question somebody inside the scope answers, so "only the scope" is not trivially true.
    let q = null;
    let all = null;
    let r = null;
    for (const cand of ['who prepares the dispatch plan', 'Who is responsible for safety?', 'Who handles SAP?', 'who is responsible for planning', 'who trains new operators']) {
      all = await askWhoOwns(pool, COMPANY, { q: cand, limit: 200 });
      r = await askWhoOwns(pool, COMPANY, { q: cand, limit: 200, scope });
      q = cand;
      if (r.people.length) break;
    }
    ok(r.people.length > 0, `"${q}": someone inside the scope answers (${r.people.length})`);
    ok(!scope.all && scope.departmentIds.size > 0, `scope: ${scope.departmentNames.join(', ')} and below (${scope.departmentIds.size} departments)`);
    ok(r.scoped && r.people.every((p) => p.positions.every((x) => scope.departmentIds.has(x.departmentId))),
      `people only from the scope (${r.people.length} of ${all.people.length})`);
    ok(r.people.length < all.people.length, 'fewer people than the company-wide answer');
    ok(r.positions.length === all.positions.length, 'positions stay company-wide (structure)');
    const outside = r.positions.filter((p) => !scope.departmentIds.has(p.departmentId) && !p.vacant);
    ok(outside.length > 0 && outside.every((p) => p.occupants.length === 0 && p.hiddenOccupants > 0), 'without the names of people outside the scope');
    const empty = await askWhoOwns(pool, COMPANY, { q, limit: 200, scope: { all: false, departmentIds: new Set() } });
    ok(empty.people.length === 0 && empty.positions.length === all.positions.length, 'an empty scope: no people, the structure still answers');
  }
}

/* ══ 8 ════════════════════════════════════════════════════════════════════ */
section('[8] The memory guard');
{
  const saved = process.env.CF_HRMS_MEMORY_LIMIT_MB;
  try {
    await unload();
    __clearFailure();
    const rss = Math.round(process.memoryUsage().rss / 1048576);
    process.env.CF_HRMS_MEMORY_LIMIT_MB = String(Math.ceil((rss + 100) / 0.8));
    const r = await askWhoOwns(pool, COMPANY, { q: 'Who is responsible for collections?', limit: 200 });
    const ex = await askWhoOwns(pool, COMPANY, { q: 'Who is responsible for collections?', mode: 'exact', limit: 200 });
    ok(r.mode === 'keyword' && /short of memory/.test(r.notice ?? ''), 'no headroom: answered by exact words, and it says so', `${r.mode} / ${r.notice}`);
    ok(r.people.length > 0 && JSON.stringify(r.people.map((p) => p.employeeId)) === JSON.stringify(ex.people.map((p) => p.employeeId))
      && JSON.stringify(r.vacant.map((p) => p.positionId)) === JSON.stringify(ex.vacant.map((p) => p.positionId)),
    'the same people and vacant positions as exact mode');
    ok(r.people.every((p) => p.matches.every((m) => m.text.toLowerCase().includes('collections'))), 'every match carries the word');
  } finally {
    if (saved === undefined) delete process.env.CF_HRMS_MEMORY_LIMIT_MB; else process.env.CF_HRMS_MEMORY_LIMIT_MB = saved;
    __clearFailure();
  }
  const back = await askWhoOwns(pool, COMPANY, { q: 'Who is responsible for collections?' });
  ok(back.mode === 'meaning', 'and by meaning again once there is room');
}

/* ══ 9 ════════════════════════════════════════════════════════════════════ */
section('[9] Tenant isolation');
{
  const [mine] = await pool.query('SELECT id FROM hrms_positions WHERE company_id = ?', [COMPANY]);
  const [myPeople] = await pool.query('SELECT id FROM hrms_employees WHERE company_id = ?', [COMPANY]);
  const myPos = new Set(mine.map((p) => Number(p.id)));
  const myEmp = new Set(myPeople.map((p) => Number(p.id)));
  const r = await askWhoOwns(pool, COMPANY, { q: 'Who is responsible for safety?', limit: 200 });
  ok(r.positions.every((p) => myPos.has(p.positionId)) && r.people.every((p) => myEmp.has(p.employeeId)), 'every answer is of this company');
  if (other) {
    const o = await askWhoOwns(pool, other.id, { q: 'Who is responsible for safety?', limit: 200 });
    ok(o.positions.every((p) => !myPos.has(p.positionId)) && o.people.every((p) => !myEmp.has(p.employeeId)),
      `another company (${other.slug}) gets none of this company's people or positions (${o.people.length} people, ${o.positions.length} positions)`);
  } else skip('another company', 'there is none');
}

/* ══ 10 ═══════════════════════════════════════════════════════════════════ */
section('[10] Over HTTP');
{
  const server = express();
  server.use(express.json());
  server.use(cookieParser());
  // Test only: a request can carry a department scope, which scopeOf() honours (req.hrmsScope).
  server.use((req, _res, next) => {
    const h = req.headers['x-test-scope'];
    if (h) req.hrmsScope = { all: false, departmentIds: new Set(String(h).split(',').filter(Boolean).map(Number)), rootIds: [], departmentNames: [] };
    next();
  });
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
  const call = async (who, url, headers = {}) => {
    const res = await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${who.token}`, ...headers } });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  try {
    const hasApp = `EXISTS (SELECT 1 FROM app_user_access x JOIN apps a ON a.id = x.app_id WHERE x.user_id = u.id AND x.deleted_at IS NULL AND a.slug = 'cf_hrms')`;
    const admin = await tokenFor(`u.company_id = ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp}`);
    const employee = await tokenFor(`u.company_id = ${COMPANY} AND r.name = 'Employee' AND ${hasApp}`);
    const outsider = await tokenFor(`u.company_id <> ${COMPANY} AND LOWER(r.name) = 'admin' AND ${hasApp}`);
    const url = `/${slug}/cf_hrms/orgchart/ask?q=${encodeURIComponent('Who is responsible for collections?')}`;
    if (!admin) skip('admin over HTTP', 'no admin login');
    else {
      const a = await call(admin, url);
      ok(a.status === 200 && a.json?.reading?.searchedFor === 'collections' && Array.isArray(a.json?.people) && Array.isArray(a.json?.vacant) && a.json.people.length > 0,
        'admin: 200 with { reading, people, positions, vacant }', `${a.status} ${JSON.stringify(a.json)?.slice(0, 160)}`);
      const f = await call(admin, `${url}&kinds=KRA&mode=exact&limit=2`);
      ok(f.status === 200 && f.json.mode === 'exact' && f.json.kinds.join(',') === 'KRA' && f.json.people.length <= 2, 'kinds, mode and limit are honoured');
      const bad = await call(admin, `${url}&kinds=SALARY`);
      ok(bad.status === 422, 'a bad kind: 422', `${bad.status}`);
      if (scopedIds) {
        const s = await call(admin, url, { 'x-test-scope': scopedIds.join(',') });
        const all = a.json;
        ok(s.status === 200 && s.json.scoped === true && s.json.people.every((p) => p.positions.every((x) => scopedIds.includes(x.departmentId)))
          && s.json.positions.length === all.positions.length, 'the route reads the login\'s scope: people from it only, positions company-wide');
      }
      // Old callers: /orgchart/search answers exactly its old envelope.
      const old = await call(admin, `/${slug}/cf_hrms/orgchart/search?q=${encodeURIComponent('customer complaints')}&mode=exact`);
      ok(old.status === 200 && JSON.stringify(Object.keys(old.json)) === JSON.stringify(['mode', 'notice', 'kinds', 'pending', 'total', 'items'])
        && old.json.items.every((h) => h.positionId && h.matches.every((m) => m.kind && m.definitionId && m.origin)),
      '/orgchart/search keeps its envelope { mode, notice, kinds, pending, total, items } for the ⌘K palette');
    }
    if (!employee) skip('Employee over HTTP', 'no Employee login with the app');
    else ok((await call(employee, url)).status === 403, 'an Employee login: 403');
    if (!outsider) skip('another company\'s admin', 'none');
    else ok((await call(outsider, url)).status === 403, `an admin of another company (${outsider.slug}): 403`);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

/* ══ 11 ═══════════════════════════════════════════════════════════════════ */
section('[11] The example questions');
if (!IS_KARNI) skip('examples', 'Karni\'s questions');
else {
  const EXAMPLES = [
    ['Who owns vendor onboarding?', /vendor/i],
    ['Who is responsible for collections?', /collection/i],
    ['Who has customer complaints as a KRA?', /customer complaints/i],
    ['Who handles SAP?', /SAP/],
    ['who looks after machine maintenance in Unit 2', /maintenance/i],
    ['who prepares the dispatch plan', /dispatch/i],
    ['who trains new operators', /train/i],
    ['who is responsible for safety', /safety/i],
  ];
  for (const [q, re] of EXAMPLES) {
    const started = Date.now();
    const r = await askWhoOwns(pool, COMPANY, { q, limit: 200 });
    const ms = Date.now() - started;
    const top = r.people.slice(0, 3);
    console.log(`  "${q}"  read as "${r.reading.searchedFor}"${r.reading.place ? ` in ${r.reading.place.name}` : ''}${r.reading.kindsFromQuestion ? ` (${r.reading.kindsFromQuestion})` : ''} — ${r.totals.people} people, ${r.totals.vacant} vacant, ${ms} ms`);
    for (const p of top) console.log(`      ${p.name} — ${p.positions[0].positionCode} ${p.positions[0].title} (${p.positions[0].departmentName}): ${p.matches[0].text.slice(0, 70)} [${p.matches[0].why}]`);
    if (r.vacant[0]) console.log(`      ${r.vacant[0].sentence} (${r.vacant[0].title}): ${r.vacant[0].matches[0]?.text.slice(0, 60)}`);
    ok(r.people.length > 0 && r.people.slice(0, 3).some((p) => p.matches.some((m) => re.test(m.text))), `"${q}": a top-3 person carries a line about it`);
  }
}

/* ══ the end ══════════════════════════════════════════════════════════════ */
section('[end] Nothing left behind');
const after = await counts();
ok(after === before, 'vectors, person overrides and definitions as found', `${before} -> ${after}`);

await unload();
console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (failed.length) { console.log('\nFAILED:'); for (const f of failed) console.log(`  - ${f}`); }
await pool.end();
process.exit(failed.length ? 1 : 0);
