/**
 * production_machines_test.mjs — which machines are PRODUCTION machines
 * (operationService.productionMachineIds) and the screens that use it.
 *
 *   cd multi_app_be && node scripts/cf_kepl/production_machines_test.mjs
 *   CF_PM_COMPANY=2 (the default: the local KEPL copy)
 *
 * Everything runs inside ONE transaction that is rolled back; the last thing it
 * does is re-count every cf_ table.
 *
 *   1. a rule on a Family reaches machines of every type below it
 *   2. a rule on one machine makes that machine production, nothing else
 *   3. eligible = 0 on a deeper rule takes a machine or a type out
 *   4. an asset on no rule, and a rule of an inactive operation, do not count
 *   5. the 60 s cache holds until a write clears it (rule, operation, machine)
 *   6. machine list: isProduction on every row; ?production=1 filters whole pages
 *   7. floor machine picker and dashboard by machine show production only
 */
import '../../apps/cf_erp/services/codegenProvider.js';
import { pool } from '../../db.js';
import { attachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { createMachineType } from '../../apps/cf_erp/services/classificationService.js';
import { createMachine, listMachines, updateMachine, getMachine } from '../../apps/cf_erp/services/machineService.js';
import {
  createOperation, updateOperation, createTimingRule, updateTimingRule, deleteTimingRule, productionMachineIds, clearProductionMachines,
} from '../../apps/cf_erp/services/operationService.js';
import { listMachines as floorMachines } from '../../apps/cf_erp/services/floorService.js';
import { machinesDashboard } from '../../apps/cf_erp/services/dashboardService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_PM_COMPANY ?? 2);

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (condition) passed++; else failed++;
}
const section = (s) => console.log(`\n${s}`);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let exitCode = 0;

try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  clearProductionMachines();
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const tag = `PM${Date.now().toString(36).toUpperCase()}`.slice(0, 10);

  // Family F > subfamilies S1, S2 > types T1, T2, T3 ; a second family G > H > T4 (the "asset" side).
  const t1 = await createMachineType(conn, c, { family: { code: `${tag}F`, name: `${tag} Family` }, subfamily: { code: `${tag}S1`, name: `${tag} Sub1` }, code: `${tag}T1`, name: `${tag} T1` });
  const t2 = await createMachineType(conn, c, { family: { id: t1.familyId }, subfamily: { code: `${tag}S2`, name: `${tag} Sub2` }, code: `${tag}T2`, name: `${tag} T2` });
  const t3 = await createMachineType(conn, c, { family: { id: t1.familyId }, subfamily: { id: t1.subfamilyId }, code: `${tag}T3`, name: `${tag} T3` });
  const t4 = await createMachineType(conn, c, { family: { code: `${tag}G`, name: `${tag} Assets` }, subfamily: { code: `${tag}H`, name: `${tag} Vehicles` }, code: `${tag}T4`, name: `${tag} T4` });
  const mk = (code, type) => createMachine(conn, c, { code: `${tag}-${code}`, name: `${tag} ${code}`, classificationId: type.id });
  const mA = await mk('A', t1); // under F via S1
  const mB = await mk('B', t2); // under F via S2
  const mC = await mk('C', t3); // under F via S1, taken out by a machine rule later
  const mD = await mk('D', t4); // asset: nothing reaches it
  const mE = await mk('E', t4); // asset with a rule of its own
  const mF = await mk('F', t4); // asset reached only by an operation that goes inactive
  const ids = { A: mA.id, B: mB.id, C: mC.id, D: mD.id, E: mE.id, F: mF.id };
  const prod = async () => {
    const s = await productionMachineIds(conn, COMPANY);
    return Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, s.has(v)]));
  };

  section('1. before any rule nothing of ours is production');
  let p = await prod();
  ok('no rule, no production machine', Object.values(p).every((v) => !v), JSON.stringify(p));

  const op = await createOperation(conn, c, { code: `${tag}OP`, name: `${tag} cut` });
  await createTimingRule(conn, c, op.id, { subjectType: 'classification', subjectId: t1.familyId, workMinutes: 1 });
  section('1. a rule on a Family reaches every type below it (cache cleared by the write)');
  p = await prod();
  ok('A and B (two subfamilies) and C are production', p.A && p.B && p.C, JSON.stringify(p));
  ok('the other family stays out', !p.D && !p.E && !p.F, JSON.stringify(p));

  section('2. a rule on one machine');
  const rE = await createTimingRule(conn, c, op.id, { subjectType: 'machine', subjectId: mE.id, workMinutes: 2 });
  p = await prod();
  ok('E is production, D (same type) is not', p.E && !p.D, JSON.stringify(p));

  section('3. eligible = 0 on a deeper rule takes a machine out');
  const rC = await createTimingRule(conn, c, op.id, { subjectType: 'machine', subjectId: mC.id, eligible: false });
  p = await prod();
  ok('C is out although its Family is eligible', !p.C && p.A && p.B, JSON.stringify(p));
  await updateTimingRule(conn, c, rC.id, { eligible: true, workMinutes: 3 });
  ok('eligible again: C is back', (await prod()).C);
  await deleteTimingRule(conn, c, rC.id);
  ok('rule deleted: C still reached by the Family', (await prod()).C);
  const rSub = await createTimingRule(conn, c, op.id, { subjectType: 'classification', subjectId: t2.subfamilyId, eligible: false });
  p = await prod();
  ok('a rule on the Subfamily takes B out, not A', !p.B && p.A, JSON.stringify(p));
  await deleteTimingRule(conn, c, rSub.id);

  section('4. inactive operation, and an operation that can do something else');
  const op2 = await createOperation(conn, c, { code: `${tag}O2`, name: `${tag} other` });
  await createTimingRule(conn, c, op2.id, { subjectType: 'machine', subjectId: mF.id, workMinutes: 1 });
  ok('F is production through an active operation', (await prod()).F);
  await updateOperation(conn, c, op2.id, { status: 'inactive' });
  ok('F is out once the operation is inactive (cache cleared by the write)', !(await prod()).F);
  const op3 = await createOperation(conn, c, { code: `${tag}O3`, name: `${tag} third` });
  await createTimingRule(conn, c, op3.id, { subjectType: 'classification', subjectId: t2.id, eligible: false });
  ok('a second operation that excludes B does not remove it (the first still runs there)', (await prod()).B);

  section('5. the cache');
  const live = await productionMachineIds(conn, COMPANY);
  await conn.query('UPDATE cf_operation_machine_rules SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [COMPANY, rE.id]);
  ok('a raw SQL change is not seen inside the TTL', (await productionMachineIds(conn, COMPANY)) === live && live.has(mE.id));
  clearProductionMachines(COMPANY);
  ok('clearProductionMachines drops it', !(await productionMachineIds(conn, COMPANY)).has(mE.id));
  await updateMachine(conn, c, mD.id, { classificationId: t1.id });
  ok('moving a machine to a production type clears the cache (D now production)', (await prod()).D);
  const dn = await getMachine(conn, COMPANY, mD.id);
  ok('machine detail carries isProduction', dn.isProduction === true);

  section('6. machine list');
  const all = await listMachines(conn, COMPANY, {});
  const mine = all.filter((m) => Object.values(ids).includes(m.id));
  ok('every row carries isProduction', all.every((m) => typeof m.isProduction === 'boolean'));
  ok('our rows: A B C D production, E F not (E rule removed, F operation inactive)', mine.filter((m) => m.isProduction).map((m) => m.code.replace(`${tag}-`, '')).sort().join('') === 'ABCD');
  const only = await listMachines(conn, COMPANY, { production: '1' });
  ok('?production=1 returns exactly the production ones', only.length === all.filter((m) => m.isProduction).length && only.every((m) => m.isProduction));
  const via = await listMachines(conn, COMPANY, { production: '1', search: tag });
  ok('?production=1 combines with search', via.length === 4 && via.every((m) => m.isProduction), String(via.length));

  section('7. floor picker and dashboard');
  const fl = await floorMachines(conn, COMPANY);
  ok('floor picker: A B C D listed; E F (assets) not', [mA, mB, mC, mD].every((m) => fl.some((x) => x.id === m.id)) && ![mE, mF].some((m) => fl.some((x) => x.id === m.id)));
  ok('floor picker holds only production machines', fl.every((x) => all.find((m) => m.id === x.id)?.isProduction));
  const dash = await machinesDashboard(conn, COMPANY, {});
  ok('dashboard machines: A B C D present; E F not', [mA, mB, mC, mD].every((m) => dash.machines.some((x) => x.id === m.id)) && ![mE, mF].some((m) => dash.machines.some((x) => x.id === m.id)));
  ok('dashboard holds only production machines', dash.machines.every((x) => all.find((m) => m.id === x.id)?.isProduction));
} catch (e) {
  console.error(e);
  failed++;
  exitCode = 1;
} finally {
  await conn.rollback();
  conn.release();
  clearProductionMachines();
}

const after = await counts();
const drift = after.filter((a, i) => Number(a.n) !== Number(before[i].n));
ok('every cf_ table has the row count it started with', drift.length === 0, JSON.stringify(drift));
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed || exitCode ? 1 : 0);
