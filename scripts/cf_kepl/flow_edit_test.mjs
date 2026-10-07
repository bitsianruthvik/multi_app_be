/** Flow step edits: change a step's operation (refused once released), move steps (renumber in 10s, waits kept),
 * list filter by operation + inline steps. Local only, one rolled-back transaction, every CF table recounted.
 * Run from multi_app_be: node scripts/cf_kepl/flow_edit_test.mjs
 */
import { pool } from '../../db.js';
import { createFlow, addStep, updateStep, moveStep, addWaitRule, getFlow, listFlows, replaceStepOperation } from '../../apps/cf_erp/services/flowService.js';

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

  // replace (user, 2026-10-07): released lines keep the old operation; the rest moves over
  const E = await op('E'), X = await op('X');
  const [[piece]] = await db.query('SELECT id, bom_line_id, order_line_id FROM cf_order_pieces WHERE company_id = ? AND bom_line_id IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 1', [company]);
  ok('a locked piece to hang work on', !!piece);
  await db.query('UPDATE cf_bom_lines SET operation_flow_id = ? WHERE id = ?', [flow.id, piece.bom_line_id]);
  const L = piece.order_line_id, BL = piece.bom_line_id;
  await db.query('INSERT INTO cf_time_overrides SET ?', [{ company_id: company, order_line_id: L, bom_line_id: BL, operation_id: B, work_minutes: 5 }]);
  await db.query('INSERT INTO cf_work_order_cells SET ?', [{ company_id: company, work_order_id: 999999, order_line_id: L, order_piece_id: piece.id, operation_id: B }]);
  let r = await replaceStepOperation(db, c, sB.id, { operationId: E });
  let after = r.flow.steps.find((x) => x.id === sB.id);
  ok('replace: the step takes the new operation', after.operation.id === E);
  ok('replace: place, waits kept', after.sequence === 20 && after.waits.length === 1);
  ok('replace: the time override moves to the new operation', r.replaced.overridesMoved === 1);
  ok('replace: the work-order cell moves too', r.replaced.cellsMoved === 1);
  const [[ov]] = await db.query('SELECT operation_id FROM cf_time_overrides WHERE company_id = ? AND order_line_id = ? AND bom_line_id = ? AND work_minutes = 5 AND deleted_at IS NULL', [company, L, BL]);
  ok('…and it is the same row, now on E', Number(ov.operation_id) === E);
  ok('replace: from/to named', r.replaced.from.id === B && r.replaced.to.id === E && r.replaced.to.name === `${tag} E`);
  r = await replaceStepOperation(db, c, sA.id, { operationId: A });
  ok('replace on a released step is allowed and counts what keeps the old one', r.replaced.released === 1);
  const [[ps]] = await db.query('SELECT operation_id FROM cf_production_steps WHERE company_id = ? AND flow_step_id = ?', [company, sA.id]);
  ok('the released production step keeps its operation', Number(ps.operation_id) === D);
  await db.query('INSERT INTO cf_time_overrides SET ?', [{ company_id: company, order_line_id: L, bom_line_id: BL, operation_id: C, work_minutes: 7 }]);
  r = await replaceStepOperation(db, c, sC.id, { operationId: X });
  ok('replace: a row with no entry for the new operation moves', r.replaced.overridesMoved === 1 && r.replaced.kept === 0);
  await db.query('INSERT INTO cf_time_overrides SET ?', [{ company_id: company, order_line_id: L, bom_line_id: BL, operation_id: A, work_minutes: 9 }]);
  r = await replaceStepOperation(db, c, sA.id, { operationId: D });
  ok('replace back to D carries the A override with it', r.flow.steps.find((x) => x.id === sA.id).operation.id === D && r.replaced.overridesMoved === 1);
  await db.query('INSERT INTO cf_time_overrides SET ?', [{ company_id: company, order_line_id: L, bom_line_id: BL, operation_id: A, work_minutes: 11 }]); // the A row moved to D above, so A is free; now both exist
  r = await replaceStepOperation(db, c, sA.id, { operationId: A });
  ok('replace: a row that already has the new operation keeps its own; the old is counted', r.replaced.kept === 1 && r.replaced.overridesMoved === 0);
  // The piece's line released (inside the rolled-back transaction): its entries stay on the old operation.
  await db.query('INSERT INTO cf_production_releases SET ?', [{ company_id: company, order_id: 0, order_line_id: L, item_id: 0, quantity: 1 }]);
  const [[relRow]] = await db.query('SELECT COUNT(*) n FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [company, L]);
  ok('the line is released for this check', Number(relRow.n) === 1);
  {
    r = await replaceStepOperation(db, c, sB.id, { operationId: B });
    ok('replace: a released line keeps its override and cell on the old operation', r.replaced.overridesMoved === 0 && r.replaced.cellsMoved === 0);
  }
  ok('replace with the same operation refused', (await refused(() => replaceStepOperation(db, c, sB.id, { operationId: r.flow.steps.find((x) => x.id === sB.id).operation.id }))) === 'SAME_OPERATION');
  await addStep(db, c, flow.id, { operationId: C, sequence: 20 });
  ok('replace into a clash at the same number refused', (await refused(() => replaceStepOperation(db, c, sB.id, { operationId: C }))) === 'DUPLICATE_STEP');
  ok('replace with an inactive operation refused', (await refused(() => replaceStepOperation(db, c, sB.id, { operationId: off }))) !== null);
} catch (e) { failed++; console.error('FAIL', e.stack); }
finally { await db.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {}); await db.rollback(); db.release(); }
ok('every CF table count restored', JSON.stringify(before) === JSON.stringify(await counts()));
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
