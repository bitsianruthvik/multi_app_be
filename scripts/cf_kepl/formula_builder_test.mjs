/**
 * formula_builder_test.mjs — the operation-time builder's backend:
 *   GET  /operations/:id/formula-builder  (formulaBuilderService.builderContext)
 *   POST /formulas/check with itemId / machineId  (checkForBuilder)
 *
 *   cd multi_app_be && node scripts/cf_kepl/formula_builder_test.mjs
 *   CF_FB_COMPANY=2 (default)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table. It owns its fixture (every code
 * carries this run's tag) and counts its round trips: the context is a fixed
 * number of reads however many machines and pieces.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { builderContext, checkForBuilder } from '../../apps/cf_erp/services/formulaBuilderService.js';
import { checkFormula } from '../../apps/cf_erp/services/formulaService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_FB_COMPANY ?? 2);
const T = `FB${Date.now().toString(36).toUpperCase()}_`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(Number(a) - Number(b)) < eps;

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
const log = [];
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { log.push(String(typeof a[0] === 'string' ? a[0] : a[0]?.sql ?? '')); return t.query(...a); } : Reflect.get(t, p)) });

try {
  await conn.beginTransaction();
  attachNodeCache(db);
  const ins = async (table, body) => { const [r] = await conn.query(`INSERT INTO ${table} SET ?`, { company_id: COMPANY, ...body }); return r.insertId; };

  console.log('\nFixture');
  const node = (code, name, scope, parent_id = null, depth = 0) => ins('cf_classification_nodes', { code: `${T}${code}`, name: `${T}${name}`, scope, parent_id, depth });
  const fam = await node('MC', 'Machines', 'machine');
  const tCut = await node('CUTTERS', 'Cutters', 'machine', fam, 1);
  const tPlasma = await node('PLASMA', 'Plasma', 'machine', tCut, 2);
  const tSaw = await node('SAW', 'Saw welding', 'machine', fam, 1);
  const m1 = await ins('cf_machines', { code: `${T}P1`, name: `${T}P1`, classification_id: tPlasma });
  const m2 = await ins('cf_machines', { code: `${T}P2`, name: `${T}P2`, classification_id: tPlasma });
  const mSaw = await ins('cf_machines', { code: `${T}S1`, name: `${T}S1`, classification_id: tSaw });
  const cls = await node('PLATES', 'Plates', 'both');

  const spec = (code, extra = {}) => ins('cf_specifications', { code: `${T}${code}`, name: `${T} ${code}`, data_type: 'number', ...extra });
  const S = {
    CUT_LENGTH: await spec('CUT_LENGTH', { default_uom: 'mm', measurement_type: 'LENGTH' }),
    THICKNESS: await spec('THICKNESS', { default_uom: 'mm', measurement_type: 'LENGTH' }),
    PIERCINGS: await spec('PIERCINGS', { measurement_type: 'COUNT' }),
    PIERCE_TIME: await spec('PIERCE_TIME', { default_uom: 'min' }),
    CUT_SPEED: await spec('CUT_SPEED', { data_type: 'table', default_uom: 'mm/min', table_config: JSON.stringify({ mode: 'step_up', axes: [{ label: 'Thickness', unit: 'mm' }] }) }),
  };
  const rule = (code, subject_type, subject_id, value_rule = 'entered') => ins('cf_spec_assignments', { specification_id: S[code], subject_type, subject_id, capture_at: 'item', value_rule });
  for (const c of ['CUT_LENGTH', 'THICKNESS', 'PIERCINGS']) await rule(c, 'classification', cls);
  for (const c of ['PIERCE_TIME', 'CUT_SPEED']) await rule(c, 'classification', tCut, 'defaulted');
  // The type gives a pierce time; P2 overrides it. The chart sits on the type.
  await ins('cf_spec_values', { specification_id: S.PIERCE_TIME, subject_type: 'classification', subject_id: tCut, value_number: 0.2 });
  await ins('cf_spec_values', { specification_id: S.PIERCE_TIME, subject_type: 'machine', subject_id: m2, value_number: 0.3 });
  await ins('cf_spec_values', { specification_id: S.CUT_SPEED, subject_type: 'classification', subject_id: tCut, value_json: JSON.stringify({ x: [10, 20, 40], v: [2000, 1200, 500] }) });

  const opCut = await ins('cf_operations', { code: `${T}CUT`, name: `${T} Cutting`, status: 'active' });
  const opIdle = await ins('cf_operations', { code: `${T}IDLE`, name: `${T} Idle`, status: 'active' });
  const flow = await ins('cf_operation_flows', { code: `${T}F`, name: `${T} F`, status: 'active' });
  await ins('cf_operation_flow_steps', { flow_id: flow, sequence: 1, operation_id: opCut });
  await ins('cf_operation_machine_rules', { operation_id: opCut, subject_type: 'classification', subject_id: tCut, eligible: 1, work_minutes: 3 });

  const item = async (name, extra = {}) => {
    const id = await ins('cf_master_records', { record_kind: 'item', name: `${T}${name}`, code: `${T}${name}`, classification_id: cls, status: 'active', ...extra });
    await ins('cf_item_details', { master_id: id, item_type: 'temporary' });
    return id;
  };
  const p1 = await item('PL1', { default_flow_id: flow });
  const p2 = await item('PL2', { default_flow_id: flow });
  const other = await item('OTHER');
  const val = (subject_id, code, value_number) => ins('cf_spec_values', { specification_id: S[code], subject_type: 'master', subject_id, value_number });
  await val(p1, 'CUT_LENGTH', 2400); await val(p1, 'THICKNESS', 12); await val(p1, 'PIERCINGS', 4);
  await val(p2, 'CUT_LENGTH', 9000); await val(p2, 'THICKNESS', 25);
  await val(other, 'CUT_LENGTH', 1);
  ok('fixture built', true);

  console.log('\nContext for a rule on the Cutters type');
  log.length = 0;
  const ctx = await builderContext(db, COMPANY, opCut, { subjectType: 'classification', subjectId: tCut });
  const reads = log.length;
  ok(`a fixed number of reads (${reads})`, reads <= 10, String(reads));
  ok('no subquery inside a JOIN ... ON', !log.some((q) => /\bON\b[^()]*\(\s*SELECT/i.test(q)));
  ok('the machines under the type, and only them', ctx.machines.map((m) => m.id).sort().join() === [m1, m2].sort().join(), JSON.stringify(ctx.machines.map((m) => m.code)));
  const P1 = ctx.machines.find((m) => m.id === m1);
  const P2 = ctx.machines.find((m) => m.id === m2);
  ok('a machine reads its type\'s value', near(P1.values[`${T}PIERCE_TIME`], 0.2));
  ok('a machine\'s own value beats its type\'s', near(P2.values[`${T}PIERCE_TIME`], 0.3));
  ok('a chart comes with its axes and mode, ready for LOOKUP', P1.values[`${T}CUT_SPEED`]?.x?.length === 3 && P1.values[`${T}CUT_SPEED`]?.axes?.[0]?.label === 'Thickness' && P1.values[`${T}CUT_SPEED`]?.mode === 'step_up');
  const mf = ctx.machineFields.find((f) => f.code === `${T}CUT_SPEED`);
  ok('machine fields list the chart with its unit and axis', mf?.dataType === 'table' && mf.unit === 'mm/min' && mf.tableConfig?.axes?.[0]?.unit === 'mm' && mf.count === 2);
  ok('machine fields list the pierce time with an example', near(ctx.machineFields.find((f) => f.code === `${T}PIERCE_TIME`)?.example, 0.2));
  ok('sample pieces = the ones whose flow has this operation, newest first', ctx.samplePieces.map((p) => p.id).join() === [p2, p1].join() && ctx.samplePieces.every((p) => p.fromOperation), JSON.stringify(ctx.samplePieces.map((p) => p.code)));
  ok('a sample piece carries its own values', near(ctx.samplePieces.find((p) => p.id === p1).values[`${T}CUT_LENGTH`], 2400));
  const cl = ctx.itemFields.find((f) => f.code === `${T}CUT_LENGTH`);
  ok('item fields: name, unit, measurement type and a real example', cl?.unit === 'mm' && cl.measurementType === 'LENGTH' && near(cl.example, 9000) && cl.count === 2, JSON.stringify(cl));
  ok('item fields with real values come first', ctx.itemFields.findIndex((f) => f.code === `${T}CUT_LENGTH`) < ctx.itemFields.findIndex((f) => f.code === `${T}PIERCINGS`) || ctx.itemFields.find((f) => f.code === `${T}PIERCINGS`).count > 0);
  ok('machine-only fields are not offered as piece fields', !ctx.itemFields.some((f) => f.code === `${T}PIERCE_TIME`));

  const ctxOne = await builderContext(db, COMPANY, opCut, { subjectType: 'machine', subjectId: mSaw });
  ok('a rule on one machine covers just that machine', ctxOne.machines.length === 1 && ctxOne.machines[0].id === mSaw);
  const ctxAll = await builderContext(db, COMPANY, opCut, {});
  ok('no subject: every machine an eligible rule names', ctxAll.machines.length === 2);
  const idle = await builderContext(db, COMPANY, opIdle, {});
  ok('an operation in no flow falls back to recent order pieces, said so', idle.samplePieces.length > 0 && idle.samplePieces.every((p) => !p.fromOperation));

  console.log('\nThe check, on a real piece and machine');
  const expr = `item.${T}CUT_LENGTH / LOOKUP(machine.${T}CUT_SPEED, item.${T}THICKNESS) + item.${T}PIERCINGS * machine.${T}PIERCE_TIME`;
  const c1 = await checkForBuilder(db, COMPANY, { expression: expr, itemId: p1, machineId: m1 });
  ok('step-up chart: 12 mm reads the 20 mm row, 2400 / 1200 + 4 × 0.2 = 2.8 min', near(c1.result?.value, 2.8), JSON.stringify(c1.result));
  ok('inputs say what each name read and from where', c1.inputs?.find((i) => i.ref === `item.${T}CUT_LENGTH`)?.from === 'piece'
    && near(c1.inputs.find((i) => i.ref === `machine.${T}PIERCE_TIME`)?.value, 0.2)
    && /3 rows/.test(c1.inputs.find((i) => i.ref === `machine.${T}CUT_SPEED`)?.chart ?? ''), JSON.stringify(c1.inputs));
  const c2 = await checkForBuilder(db, COMPANY, { expression: expr, itemId: p1, machineId: m2 });
  ok('another machine of the type gives its own time (0.3 pierce)', near(c2.result?.value, 3.2), JSON.stringify(c2.result));
  const c3 = await checkForBuilder(db, COMPANY, { expression: expr, itemId: p1, machineId: m1, sample: { [`item.${T}THICKNESS`]: 10 } });
  ok('a typed value beats the piece\'s (10 mm → 2000 mm/min: 1.2 + 0.8)', near(c3.result?.value, 2.0) && c3.inputs.find((i) => i.ref === `item.${T}THICKNESS`)?.from === 'typed', JSON.stringify(c3.result));
  const c4 = await checkForBuilder(db, COMPANY, { expression: expr, itemId: p2, machineId: m1 });
  ok('a missing input is named, never guessed', c4.result?.value == null && (c4.result?.missing ?? []).some((x) => x.includes(`${T}PIERCINGS`)), JSON.stringify(c4.result));
  const c5 = await checkForBuilder(db, COMPANY, { expression: `item.${T}NOPE * 2`, itemId: p1 });
  ok('problems still come back (unknown field)', c5.problems.some((p) => p.includes(`${T}NOPE`)));
  const plain = await checkFormula(db, COMPANY, `item.${T}CUT_LENGTH / 1000 * 1.5`, { [`item.${T}CUT_LENGTH`]: 2000 });
  ok('the old sample-only check is unchanged (no inputs)', near(plain.result?.value, 3) && plain.inputs === undefined);
} catch (e) {
  failed++;
  console.error('\nFAILED with an exception:', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 4).join(' | '));
} finally {
  detachNodeCache(db);
  await conn.rollback();
  conn.release();
  const after = await counts();
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back to where it was', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
