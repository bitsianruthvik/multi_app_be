/** Flow step edits: change a step's operation (refused once released), move steps (renumber in 10s, waits kept),
 * list filter by operation + inline steps. Local only, one rolled-back transaction, every CF table recounted.
 * Run from multi_app_be: node scripts/cf_kepl/flow_edit_test.mjs
 */
import { pool } from '../../db.js';
import { createFlow, addStep, updateStep, moveStep, addWaitRule, getFlow, listFlows } from '../../apps/cf_erp/services/flowService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const company = Number(process.env.CF_FLOWEDIT_COMPANY ?? 2);
const tag = `FE${Date.now().toString(36).toUpperCase()}`;
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();
let passed = 0, failed = 0;
function ok(label, condition) {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok needs label, boolean');
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
  condition ? passed++ : failed++;
}
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? e.message; } };
try {
  await db.beginTransaction();
  await db.query('SET FOREIGN_KEY_CHECKS = 0');
  const c = { companyId: company, userId: null };
  const op = async (s, extra = {}) => (await db.query('INSERT INTO cf_operations SET ?', [{ company_id: company, code: `${tag}-${s}`, name: `${tag} ${s}`, ...extra }]))[0].insertId;
  const A = await op('A'), B = await op('B'), C = await op('C'), D = await op('D'), off = await op('OFF', { status: 'inactive' });
  const flow = await createFlow(db, c, { code: `${tag}-F`, name: 'Flow edit' });
  const seqOf = (f) => f.steps.map((s) => `${s.operation.id === A ? 'A' : s.operation.id === B ? 'B' : s.operation.id === C ? 'C' : 'D'}${s.sequence}`).join(' ');
  let f = await addStep(db, c, flow.id, { operationId: A });
  f = await addStep(db, c, flow.id, { operationId: B });
  f = await addStep(db, c, flow.id, { operationId: C, sequence: 20 }); // alongside B
  const [sA, sB, sC] = f.steps.sort((x, y) => x.id - y.id);
  ok('setup A10 B20 C20', seqOf({ steps: [sA, sB, sC] }) === 'A10 B20 C20');

  // operation change
  f = await updateStep(db, c, sA.id, { operationId: D });
  ok('unused step: operation changes', f.steps.find((s) => s.id === sA.id).operation.id === D);
  ok('inactive operation refused', (await refused(() => updateStep(db, c, sA.id, { operationId: off }))) !== null);
  await db.query('INSERT INTO cf_production_steps SET ?', [{ company_id: company, production_item_id: 999999, flow_step_id: sA.id, operation_id: D, sequence: 10, quantity: 1 }]);
  ok('released step: operation change refused', (await refused(() => updateStep(db, c, sA.id, { operationId: A }))) === 'STEP_RELEASED');
  ok('released step: same operation + rename still fine', (await updateStep(db, c, sA.id, { operationId: D, stepName: 'Named' })).steps.find((s) => s.id === sA.id).stepName === 'Named');
  ok('clash at one sequence refused', (await refused(() => updateStep(db, c, sC.id, { operationId: B }))) !== null);

  // moves: D10 | B20 C20
  await addWaitRule(db, c, sB.id, { relation: 'parent' });
  f = await moveStep(db, c, sA.id, { direction: 'down' });
  ok('single step swaps with next group, renumbered in 10s', seqOf(f) === 'B10 C10 D20');
  ok('wait rule travelled with its step', f.steps.find((s) => s.id === sB.id).waits.length === 1);
  f = await moveStep(db, c, sC.id, { direction: 'down' });
  ok('step leaves a parallel group going down', seqOf(f) === 'B10 C20 D30');
  f = await moveStep(db, c, sC.id, { direction: 'up' });
  ok('and back up into its own number before the group', seqOf(f) === 'C10 B20 D30');
  f = await moveStep(db, c, sC.id, { direction: 'up' });
  ok('first step up is a no-op', seqOf(f) === 'C10 B20 D30');
  ok('bad direction refused', (await refused(() => moveStep(db, c, sC.id, { direction: 'sideways' }))) === 'INVALID');
  ok('wait still there after all moves', (await getFlow(db, company, flow.id)).steps.find((s) => s.id === sB.id).waits.length === 1);

  // list
  const all = await listFlows(db, company, { operationId: B });
  ok('list filter by operation finds the flow', all.some((x) => x.id === flow.id));
  ok('list filter excludes flows without it', !(await listFlows(db, company, { operationId: A })).some((x) => x.id === flow.id));
  const row = all.find((x) => x.id === flow.id);
  ok('list carries steps in order', row.steps.map((s) => s.operation.id).join() === [C, B, D].join());
} catch (e) { failed++; console.error('FAIL', e.stack); }
finally { await db.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {}); await db.rollback(); db.release(); }
ok('every CF table count restored', JSON.stringify(before) === JSON.stringify(await counts()));
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
