/**
 * unit_reporting_test.mjs — §40 "One structure, reporting that follows it".
 *
 *   1. the order (lib/unitReporting.js) on made-up trees: explicit, unit head, a head per shift,
 *      a head's Reports into (default and chosen), walk-up through vacant chairs, a head of
 *      several units, never oneself, loops;
 *   2. on the real tenant, every write in ONE transaction that is rolled back:
 *      Head / Reports into validation and tenants, move-check and a move with DEFAULT vs CHOSEN,
 *      every consistency finding and fix, the leave approver and team scope routed through it;
 *   3. the migration (suggest-unit-reporting.mjs): never changes a resolved manager, and refuses
 *      a plan that would;
 *   4. nothing left behind.
 *
 *   node scripts/cf_hrms/unit_reporting_test.mjs [--company=karni]
 * Local only.
 */
import { pool } from '../../db.js';
import { buildReportingModel, findInconsistencies } from '../../apps/cf_hrms/lib/unitReporting.js';
import { loadReportingModel, resolvePositionReporting } from '../../apps/cf_hrms/services/reportingResolver.js';
import {
  unitReporting, setUnitReporting, consistency, fixConsistency,
} from '../../apps/cf_hrms/services/unitReportingService.js';
import { moveCheck, updateDepartment, listDepartments } from '../../apps/cf_hrms/services/organisationService.js';
import { buildOrgChart } from '../../apps/cf_hrms/services/orgChartService.js';
import { loadWorlds, approverChain } from '../../apps/cf_hrms/services/leave/requestService.js';
import { loadMySlice } from '../../apps/cf_hrms/services/selfOrgChartService.js';
import { buildOrgTree } from '../../apps/cf_hrms/services/orgTree.js';
import { planCompany, resolveAll, differences } from '../../apps/cf_hrms/scripts/suggest-unit-reporting.mjs';

const slug = (process.argv.find((a) => a.startsWith('--company=')) || '--company=karni').split('=')[1];
if (!['localhost', '127.0.0.1'].includes(process.env.DB_HOST)) { console.error('Local only.'); process.exit(2); }

let passed = 0;
const failed = [];
const ok = (cond, name, detail = '') => { if (cond) passed += 1; else failed.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const refuses = async (fn, code, name) => {
  try { await fn(); ok(false, name, 'was not refused'); } catch (e) { ok(e.code === code, name, `${e.code}: ${e.message}`); }
};

/* ── 1. the order, on made-up trees ──────────────────────────────────────── */
{
  // Top(1) > Prod(2) > Print(3);  Other(4) under Top.
  const units = [
    { id: 1, name: 'Top', parentId: null, reportsIntoMode: 'DEFAULT' },
    { id: 2, name: 'Prod', parentId: 1, reportsIntoMode: 'DEFAULT' },
    { id: 3, name: 'Print', parentId: 2, reportsIntoMode: 'DEFAULT' },
    { id: 4, name: 'Other', parentId: 1, reportsIntoMode: 'DEFAULT' },
  ];
  const P = (id, departmentId, shiftId = null, occupied = true) => ({ id, code: `P${id}`, title: `T${id}`, departmentId, shiftId, live: true, occupied });
  const positions = [
    P(10, 1), P(20, 2, null, false), P(30, 3, 1), P(31, 3, 2), P(32, 3, 1), P(33, 3, 2), P(34, 3, 3), P(40, 4), P(41, 4), P(50, 2),
  ];
  const heads = [
    { unitId: 1, positionId: 10, shiftId: null },
    { unitId: 2, positionId: 20, shiftId: null },          // vacant head
    { unitId: 3, positionId: 30, shiftId: 1 },             // Day head
    { unitId: 3, positionId: 31, shiftId: 2 },             // Night head
    { unitId: 4, positionId: 10, shiftId: null },          // P10 heads Top AND Other (head of several units)
  ];
  const m = buildReportingModel({ positions, units, heads, explicit: [{ id: 900, fromPositionId: 50, toPositionId: 40, scopeType: 'GENERAL' }] });
  ok(m.step(50).source === 'EXPLICIT' && m.step(50).managerId === 40, 'explicit line wins');
  ok(m.step(32).source === 'UNIT_HEAD' && m.step(32).managerId === 30, 'per-shift head: Day position → Day head');
  ok(m.step(33).source === 'UNIT_HEAD' && m.step(33).managerId === 31, 'per-shift head: Night position → Night head');
  ok(m.step(34).source === 'REPORTS_INTO' && m.step(34).managerId === 20, 'a shift with no head → the unit Reports into (the parent head)');
  ok(m.step(30).source === 'REPORTS_INTO' && m.step(30).managerId === 20, 'a head → its unit Reports into, default = parent head');
  ok(m.step(20).source === 'REPORTS_INTO' && m.step(20).managerId === 10, 'Prod head → Top head');
  ok(m.step(10) === null, 'the head of the top unit has nobody');
  ok(m.step(41).source === 'UNIT_HEAD' && m.step(41).managerId === 10, 'a head of several units: Other people → P10');
  const w = m.manager(30);
  ok(w.positionId === 10 && w.source === 'WALKED_UP' && w.through.join() === '20', 'walk-up through a vacant chair', JSON.stringify(w));
  ok(m.manager(32).source === 'UNIT_HEAD', 'a filled manager is not walked past');
  // chosen Reports into in a parent unit
  const m2 = buildReportingModel({ positions, units: units.map((u) => (u.id === 3 ? { ...u, reportsIntoMode: 'CHOSEN', reportsIntoPositionId: 50 } : u)), heads, explicit: [] });
  ok(m2.step(30).source === 'REPORTS_INTO' && m2.step(30).managerId === 50 && m2.step(30).chosen, 'a chosen Reports into (a position of the parent unit)');
  ok(m2.inTreeAbove(3, 50) && !m2.inTreeAbove(3, 41), 'in the tree above: parent unit yes, a sibling branch no');
  // never oneself: P20 heads Prod and Print (no per-shift) and sits in Print
  const m3 = buildReportingModel({ positions: [P(10, 1), P(20, 3), P(35, 3)], units, heads: [{ unitId: 1, positionId: 10 }, { unitId: 2, positionId: 20 }, { unitId: 3, positionId: 20 }], explicit: [] });
  ok(m3.step(20).managerId === 10, 'a head of its unit and the unit above goes on up, never to itself');
  ok(m3.step(35).managerId === 20, 'its people → it');
  // loop + findings
  const m4 = buildReportingModel({ positions, units, heads, explicit: [{ id: 901, fromPositionId: 10, toPositionId: 32, scopeType: 'GENERAL' }] });
  const f4 = findInconsistencies(m4);
  ok(f4.some((f) => f.kind === 'LOOP'), 'a loop through a head is found');
  ok(f4.some((f) => f.kind === 'CROSS_TREE' && f.edgeId === 901), 'a line to a unit below is cross-tree');
  const m5 = buildReportingModel({ positions: [P(60, 1), P(61, 1)], units: [units[0]], heads: [], explicit: [] });
  const f5 = findInconsistencies(m5);
  ok(f5.some((f) => f.kind === 'UNIT_NO_HEAD') && f5.filter((f) => f.kind === 'NO_MANAGER').length === 2, 'no head and nothing above: the unit and both positions are found');
  // the tree builder
  const t = buildOrgTree({ units: [{ id: 1, name: 'A', code: 'D2', parent_department_id: null, sort_order: 2 }, { id: 2, name: 'B', code: 'D1', parent_department_id: null, sort_order: 1 }, { id: 3, name: 'C', code: 'D3', parent_department_id: 1, sort_order: 1 }, { id: 4, name: 'L', code: 'D4', parent_department_id: 5 }, { id: 5, name: 'M', code: 'D5', parent_department_id: 4 }] });
  ok(t.units.map((u) => u.id).join() === '2,1,3,4,5' && t.units[2].path === 'A › C' && t.units[3].inCycle, 'orgTree: stored order, paths, a loop ranked last');
}

/* ── 2. the real tenant, in one rolled-back transaction ──────────────────── */
const [[company]] = await pool.query('SELECT id FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
if (!company) { console.error(`No company ${slug}`); process.exit(2); }
const companyId = company.id;
const [[admin]] = await pool.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [companyId]);
const c = { companyId, userId: admin?.id ?? null };
const counts = async () => (await pool.query(
  `SELECT (SELECT COUNT(*) FROM hrms_unit_heads WHERE company_id = ?) h,
          (SELECT COUNT(*) FROM hrms_departments WHERE company_id = ? AND reports_into_mode = 'CHOSEN') ch,
          (SELECT COUNT(*) FROM hrms_position_reporting_relationships WHERE company_id = ? AND deleted_at IS NULL) r,
          (SELECT COUNT(*) FROM hrms_audit_log WHERE company_id = ?) a`, [companyId, companyId, companyId, companyId]))[0][0];
const before = await counts();
const resolvedBefore = resolveAll(await loadReportingModel(pool, companyId, {}));

// the chart still costs a fixed number of queries, whatever the size
{
  const q = { n: 0, query: (...a) => { q.n += 1; return pool.query(...a); } };
  const chart = await buildOrgChart(q, companyId, {});
  ok(q.n === 9 + (chart.nodes.some((n) => n.occupants.length) ? 1 : 0), 'the chart costs 9 company-wide reads (+ attendance)', String(q.n));
  ok(chart.edges.every((e) => typeof e.key === 'string' && ['EXPLICIT', 'DERIVED'].includes(e.origin)), 'every edge has a key and an origin');
  const list = await listDepartments(pool, companyId);
  const rank = new Map(chart.departments.map((d) => [d.id, d.rank]));
  ok(list.rows.every((r, i) => rank.get(r.id) === i), 'the Org units list and the chart use the same tree order');
}

const conn = await pool.getConnection();
await conn.beginTransaction();
try {
  const model = await loadReportingModel(conn, companyId, {});
  const live = [...model.positions.values()].filter((p) => p.live);
  // A unit with at least 3 live positions and a parent; a position outside its tree.
  const unit = [...model.units.values()].find((u) => u.parentId != null && live.filter((p) => Number(p.departmentId) === u.id).length >= 3);
  const parent = model.units.get(unit.parentId);
  const members = live.filter((p) => Number(p.departmentId) === unit.id).sort((a, b) => a.id - b.id);
  const below = model.subtree(unit.id);
  const aboveIds = new Set(model.ancestry(unit.id).map((u) => u.id));
  const outside = live.find((p) => p.departmentId != null && !aboveIds.has(Number(p.departmentId)) && !below.has(Number(p.departmentId)));
  const inParent = live.find((p) => Number(p.departmentId) === parent.id) ?? live.find((p) => model.ancestry(unit.id).slice(1).some((u) => u.id === Number(p.departmentId)));

  // validation
  await refuses(() => setUnitReporting(conn, c, unit.id, { heads: [{ positionId: outside.id, shiftId: null }] }), 'VALIDATION', 'a head outside the unit and above is refused');
  const [[sh]] = await conn.query("SELECT id FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1", [companyId]);
  if (sh) await refuses(() => setUnitReporting(conn, c, unit.id, { heads: [{ positionId: members[0].id, shiftId: sh.id }, { positionId: members[1].id, shiftId: sh.id }] }), 'VALIDATION', 'two heads on one shift are refused');
  await refuses(() => setUnitReporting(conn, c, parent.id, { reportsInto: { mode: 'CHOSEN', positionId: members[0].id } }), 'LOOP', 'Reports into a position under the unit is refused (loop)');
  await refuses(() => setUnitReporting(conn, c, unit.id, { reportsInto: { mode: 'CHOSEN', positionId: outside.id } }), 'REASON_NEEDED', 'Reports into outside the tree needs a reason');
  const [[otherPos]] = await conn.query('SELECT p.id FROM hrms_positions p WHERE p.company_id <> ? AND p.deleted_at IS NULL LIMIT 1', [companyId]);
  if (otherPos) await refuses(() => setUnitReporting(conn, c, unit.id, { heads: [{ positionId: otherPos.id, shiftId: null }] }), 'VALIDATION', 'another company\'s position is refused');
  const [[otherUnit]] = await conn.query('SELECT id FROM hrms_departments WHERE company_id <> ? AND deleted_at IS NULL LIMIT 1', [companyId]);
  if (otherUnit) await refuses(() => unitReporting(conn, companyId, otherUnit.id), 'NOT_FOUND', 'another company\'s unit reads as not found');

  // set a head; a member with no explicit line now reports to it (UNIT_HEAD)
  const head = members[0];
  const member = members[1];
  await conn.query("UPDATE hrms_position_reporting_relationships SET deleted_at = NOW() WHERE company_id = ? AND from_position_id = ? AND deleted_at IS NULL", [companyId, member.id]);
  const set = await setUnitReporting(conn, c, unit.id, { heads: [{ positionId: head.id, shiftId: null }] });
  ok(set.heads.length === 1 && set.heads[0].positionId === head.id, 'a head is set');
  const rr = await resolvePositionReporting(conn, companyId, member.id, {});
  const derived = rr.relationships.find((r) => r.origin === 'DERIVED');
  ok(derived && derived.source === 'UNIT_HEAD' && derived.managerPosition.id === head.id && derived.id === null, 'the member gets a DERIVED line to the head');
  ok(rr.resolvedManager.firstPositionId === head.id, 'resolvedManager names the head');
  const chart = await buildOrgChart(conn, companyId, {});
  ok(chart.edges.some((e) => e.origin === 'DERIVED' && e.fromPositionId === member.id && e.toPositionId === head.id && e.source === 'UNIT_HEAD'), 'the chart draws the derived line');
  ok(chart.departments.find((d) => d.id === unit.id).headPositionIds.includes(head.id), 'the chart departments carry the head');

  // the leave approver = the resolved manager (person in the head chair, or walked up)
  const [occ] = await conn.query("SELECT employee_id FROM hrms_work_assignments WHERE company_id = ? AND position_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' LIMIT 1", [companyId, member.id]);
  if (occ.length) {
    const worlds = await loadWorlds(conn, companyId, [occ[0].employee_id]);
    const wld = worlds.get(Number(occ[0].employee_id));
    const res = await approverChain(conn, companyId, wld);
    const m = (await loadReportingModel(conn, companyId, {})).manager(member.id);
    const expected = m.positionId != null ? (await loadReportingModel(conn, companyId, {})).positions.get(m.positionId).occupants[0]?.employeeId : null;
    ok(res.approverId === (expected ?? null) && (res.approverSource === m.source || (res.approverSource === 'WALKED_UP' && m.source === 'WALKED_UP')), 'the leave approver is the resolved manager', `${res.approverId} vs ${expected} (${res.approverSource}/${m.source})`);
  } else ok(true, 'leave approver (member vacant — skipped)');

  // team scope: the head's occupant sees the member as REPORT
  const [hocc] = await conn.query("SELECT e.user_id FROM hrms_work_assignments wa JOIN hrms_employees e ON e.id = wa.employee_id WHERE wa.company_id = ? AND wa.position_id = ? AND wa.deleted_at IS NULL AND wa.status = 'ACTIVE' AND e.user_id IS NOT NULL LIMIT 1", [companyId, head.id]);
  if (hocc.length) {
    const slice = await loadMySlice(conn, { companyId, userId: hocc[0].user_id }, {});
    ok(slice.relationOf(member.id) === 'REPORT' && slice.canChange(member.id), 'team scope: the head may change the member (derived line)');
  } else ok(true, 'team scope (head has no login — skipped)');

  // per-shift heads
  const [shifts] = await conn.query("SELECT id FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 2", [companyId]);
  if (shifts.length === 2) {
    const r2 = await setUnitReporting(conn, c, unit.id, { heads: [{ positionId: members[0].id, shiftId: shifts[0].id }, { positionId: members[2].id, shiftId: shifts[1].id }] });
    ok(r2.perShift && r2.heads.length === 2, 'a head per shift is saved');
    await setUnitReporting(conn, c, unit.id, { heads: [{ positionId: head.id, shiftId: null }] });
  }

  // a chosen Reports into in the parent unit, then a move: DEFAULT re-points, CHOSEN asks
  if (inParent) {
    const r3 = await setUnitReporting(conn, c, unit.id, { reportsInto: { mode: 'CHOSEN', positionId: inParent.id } });
    ok(r3.reportsInto.mode === 'CHOSEN' && r3.reportsInto.effective.positionId === inParent.id, 'a chosen Reports into in the parent unit is saved');
    const step = (await loadReportingModel(conn, companyId, {})).step(head.id);
    ok(head.id && (step.source === 'EXPLICIT' || (step.source === 'REPORTS_INTO' && step.managerId === inParent.id)), 'the head reports into the chosen position (unless it has its own line)');
    const target = [...model.units.values()].find((u) => u.id !== unit.id && u.id !== parent.id && !below.has(u.id));
    const mc = await moveCheck(conn, companyId, unit.id, target.id);
    ok(mc.reportsInto?.ask === true && /keep that, or switch/.test(mc.sentence), 'move-check: a CHOSEN Reports into asks keep or switch', mc.sentence);
    await updateDepartment(conn, c, unit.id, { parentId: target.id, reportsInto: 'KEEP' });
    ok((await unitReporting(conn, companyId, unit.id)).reportsInto.mode === 'CHOSEN', 'move with KEEP keeps the chosen one');
    await updateDepartment(conn, c, unit.id, { parentId: parent.id, reportsInto: 'SWITCH' });
    ok((await unitReporting(conn, companyId, unit.id)).reportsInto.mode === 'DEFAULT', 'move with SWITCH goes back to the default');
    const mc2 = await moveCheck(conn, companyId, unit.id, target.id);
    ok(mc2.reportsInto?.ask === false && /follows|nobody until/.test(mc2.sentence), 'move-check: a DEFAULT Reports into follows the new parent', mc2.sentence);
  }

  // consistency: make each finding and fix it
  // (a) cross-tree line
  if (outside) {
    await conn.query("UPDATE hrms_position_reporting_relationships SET deleted_at = NOW() WHERE company_id = ? AND from_position_id = ? AND deleted_at IS NULL", [companyId, members[2].id]);
    const [[t]] = await conn.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL LIMIT 1", [companyId]);
    const [ins] = await conn.query("INSERT INTO hrms_position_reporting_relationships (company_id, from_position_id, to_position_id, relationship_type_id, is_primary, effective_from) VALUES (?, ?, ?, ?, 1, '2020-01-01')", [companyId, members[2].id, outside.id, t.id]);
    let k = await consistency(conn, companyId);
    const key = `CROSS_TREE:E:${ins.insertId}`;
    const f = k.findings.find((x) => x.key === key);
    ok(f && f.fixes.map((x) => x.action).join() === 'USE_DEFAULT,CHOOSE,MARK_INTENDED', 'a cross-tree line is found with its three fixes', f ? f.fixes.map((x) => x.action).join() : 'none');
    await refuses(() => fixConsistency(conn, c, { key, action: 'MARK_INTENDED' }), 'VALIDATION', 'mark intended needs a reason');
    const r = await fixConsistency(conn, c, { key, action: 'MARK_INTENDED', reason: 'Test: reports to the other plant' });
    ok(!r.consistency.findings.some((x) => x.key === key), 'marked intended: gone from the check');
    const chartAfter = await buildOrgChart(conn, companyId, {});
    const e = chartAfter.edges.find((x) => x.id === ins.insertId);
    ok(e && e.crossTree && e.crossTreeReason === 'Test: reports to the other plant', 'the chart line is cross-tree with its reason');
    await conn.query('UPDATE hrms_position_reporting_relationships SET cross_tree_reason = NULL WHERE id = ?', [ins.insertId]);
    k = await consistency(conn, companyId);
    const f2 = k.findings.find((x) => x.key === key);
    if (f2.fixes.some((x) => x.action === 'USE_DEFAULT')) {
      await fixConsistency(conn, c, { key, action: 'USE_DEFAULT' });
      const s = (await loadReportingModel(conn, companyId, {})).step(members[2].id);
      ok(s && s.source !== 'EXPLICIT', 'use the default: the line is gone, the unit decides');
    } else {
      const cand = f2.fixes.find((x) => x.action === 'CHOOSE').candidates[0];
      await fixConsistency(conn, c, { key, action: 'CHOOSE', positionId: cand.positionId });
      ok(true, 'choose from above');
    }
    await fixConsistency(conn, c, { key: 'NOPE:1', action: 'USE_DEFAULT' }).then(() => ok(false, 'stale refused')).catch((err) => ok(err.code === 'STALE', 'a finding that is gone is STALE'));
  }
  // (b) a unit with no head and nothing above + NO_MANAGER: a fresh top unit with one position
  const [[role]] = await conn.query('SELECT id FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [companyId]);
  const [du] = await conn.query("INSERT INTO hrms_departments (company_id, code, name, status) VALUES (?, 'ZZTEST', 'Test top unit', 'ACTIVE')", [companyId]);
  const [pu] = await conn.query("INSERT INTO hrms_positions (company_id, position_code, role_id, department_id, status, effective_from) VALUES (?, 'ZZP1', ?, ?, 'ACTIVE', '2020-01-01')", [companyId, role.id, du.insertId]);
  let k2 = await consistency(conn, companyId);
  ok(k2.findings.some((x) => x.key === `UNIT_NO_HEAD:${du.insertId}`), 'a unit with no head and nothing above is found');
  const nm = k2.findings.find((x) => x.key === `NO_MANAGER:${pu.insertId}`);
  ok(nm && nm.fixes.some((x) => x.action === 'MAKE_HEAD'), 'a position with no manager is found, with "make it the head"');
  await fixConsistency(conn, c, { key: `NO_MANAGER:${pu.insertId}`, action: 'MAKE_HEAD', unitId: du.insertId });
  k2 = await consistency(conn, companyId);
  ok(!k2.findings.some((x) => x.key === `UNIT_NO_HEAD:${du.insertId}` || x.key === `NO_MANAGER:${pu.insertId}`), 'make head: both findings are gone');
  // (c) a loop
  const [[t2]] = await conn.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL LIMIT 1", [companyId]);
  const [pu2] = await conn.query("INSERT INTO hrms_positions (company_id, position_code, role_id, department_id, status, effective_from) VALUES (?, 'ZZP2', ?, ?, 'ACTIVE', '2020-01-01')", [companyId, role.id, du.insertId]);
  await conn.query("INSERT INTO hrms_position_reporting_relationships (company_id, from_position_id, to_position_id, relationship_type_id, is_primary, effective_from) VALUES (?, ?, ?, ?, 1, '2020-01-01')", [companyId, pu.insertId, pu2.insertId, t2.id]);
  k2 = await consistency(conn, companyId);
  const loop = k2.findings.find((x) => x.kind === 'LOOP' && x.loop.some((p) => p.positionId === pu.insertId));
  ok(loop && loop.fixes.length >= 1, 'a loop (an explicit line to someone whose unit head is you) is found with a fix');
  await fixConsistency(conn, c, { key: loop.key, action: 'USE_DEFAULT', edgeId: loop.fixes[0].edgeId });
  k2 = await consistency(conn, companyId);
  ok(!k2.findings.some((x) => x.kind === 'LOOP'), 'the loop is fixed');
  // adding that line by hand is refused (loop through the heads)
  const { addPositionReporting } = await import('../../apps/cf_hrms/services/positionService.js');
  const [pu3] = await conn.query("INSERT INTO hrms_positions (company_id, position_code, role_id, department_id, status, effective_from) VALUES (?, 'ZZP3', ?, ?, 'ACTIVE', '2020-01-01')", [companyId, role.id, du.insertId]);
  await refuses(() => addPositionReporting(conn, c, pu.insertId, { toPositionId: pu3.insertId, relationshipTypeId: t2.id }),'REPORTING_CYCLE', 'a primary line that closes a loop through a head is refused');
} finally {
  await conn.rollback();
  conn.release();
}

/* ── 3. the migration ────────────────────────────────────────────────────── */
{
  const model0 = await loadReportingModel(pool, companyId, {});
  const [explicitRows] = await pool.query(
    `SELECT rr.id, rr.from_position_id, rr.to_position_id, rr.scope_type, rr.scope_label, rr.notes, rr.effective_to, rr.cross_tree_reason
       FROM hrms_position_reporting_relationships rr JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
      WHERE rr.company_id = ? AND rr.deleted_at IS NULL AND t.code = 'PRIMARY_MANAGER'
        AND (rr.effective_from IS NULL OR rr.effective_from <= CURDATE()) AND (rr.effective_to IS NULL OR rr.effective_to >= CURDATE())
      ORDER BY rr.is_primary DESC, t.sort_order, rr.id`, [companyId]);
  const plan = planCompany(model0, explicitRows);
  ok(plan.diff.length === 0, 'the migration plan changes no resolved manager', String(plan.diff.length));
  ok(plan.newLoops.length === 0, 'the migration plan makes no loop');
  // a corrupted plan is caught: drop a line the unit would NOT give
  const keep = explicitRows.find((e) => !plan.remove.some((r) => r.id === e.id) && model0.positions.get(e.from_position_id)?.live);
  if (keep) {
    const m = buildReportingModel({
      positions: [...model0.positions.values()], units: [...model0.units.values()],
      heads: [...model0.units.keys()].flatMap((id) => model0.allHeadsOf(id)),
      explicit: explicitRows.filter((e) => e.id !== keep.id).map((e) => ({ id: e.id, fromPositionId: e.from_position_id, toPositionId: e.to_position_id, scopeType: e.scope_type })),
    });
    const changed = differences(resolveAll(model0), resolveAll(m));
    ok(changed.length > 0 || model0.step(keep.from_position_id) === null, 'removing a line the unit does not give WOULD change a manager — the guard sees it');
  }
}

/* ── 4. nothing left behind ──────────────────────────────────────────────── */
const after = await counts();
ok(JSON.stringify(after) === JSON.stringify(before), 'nothing left behind (heads, chosen, lines, audit)', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
ok(differences(resolvedBefore, resolveAll(await loadReportingModel(pool, companyId, {}))).length === 0, 'every resolved manager is as it was');

console.log(`\nunit_reporting_test: ${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log(`  FAIL ${f}`);
await pool.end();
process.exit(failed.length ? 1 : 0);
