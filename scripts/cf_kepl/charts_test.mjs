/**
 * charts_test.mjs — charts on a machine type or machine, and the short chart name in a time
 * formula (chartService, lib/chartFormula.js, 2026-10-08).
 * Local only, one rolled-back transaction, every cf_ table re-counted.
 *
 *   cd multi_app_be && node scripts/cf_kepl/charts_test.mjs
 */
import { pool } from '../../db.js';
import { expandCharts, contractCharts } from '../../apps/cf_erp/lib/chartFormula.js';
import { createChart, updateChart, listCharts, machineTypeDetails, chartBindings } from '../../apps/cf_erp/services/chartService.js';
import { setValues } from '../../apps/cf_erp/services/valueService.js';
import { createTimingRule, listTimingRules, timingPreview } from '../../apps/cf_erp/services/operationService.js';
import { neededCodesOfFlows } from '../../apps/cf_erp/services/flowSpecService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const COMPANY = 2;
let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// --- pure: short ↔ long ---------------------------------------------------------
const B = new Map([['GAS_CUT_SPEED', ['THICKNESS']], ['DRILL_TIME', ['THICKNESS', 'HOLE_DIA']]]);
ok('a chart by its name becomes the LOOKUP it stands for', expandCharts('item.CUT_LENGTH / GAS_CUT_SPEED', B) === 'item.CUT_LENGTH / LOOKUP(machine.GAS_CUT_SPEED, item.THICKNESS)');
ok('…machine.NAME too, and two columns in order', expandCharts('item.HOLES * machine.drill_time / 60', B) === 'item.HOLES * LOOKUP(machine.DRILL_TIME, item.THICKNESS, item.HOLE_DIA) / 60');
ok('a LOOKUP written out is left alone', expandCharts('LOOKUP(machine.GAS_CUT_SPEED, item.WIDTH)', B) === 'LOOKUP(machine.GAS_CUT_SPEED, item.WIDTH)');
ok('item.X of the same name is not a chart', expandCharts('item.GAS_CUT_SPEED + 1', B) === 'item.GAS_CUT_SPEED + 1');
ok('long → short when it reads its own columns', contractCharts('item.CUT_LENGTH / LOOKUP(machine.GAS_CUT_SPEED, item.THICKNESS) + 5', B) === 'item.CUT_LENGTH / GAS_CUT_SPEED + 5');
ok('…but a LOOKUP with other arguments stays long', contractCharts('LOOKUP(machine.GAS_CUT_SPEED, item.WIDTH)', B) === 'LOOKUP(machine.GAS_CUT_SPEED, item.WIDTH)');
const round = 'item.HOLES * DRILL_TIME / 60 + item.CUT_LENGTH / GAS_CUT_SPEED';
ok('short → long → short is the same text', contractCharts(expandCharts(round, B), B) === round);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const c = { companyId: COMPANY, userId: null };
  const [[mc]] = await db.query(
    `SELECT m.id, m.code, m.classification_id FROM cf_machines m JOIN cf_classification_nodes n ON n.id = m.classification_id AND n.scope = 'machine'
      WHERE m.company_id = ? AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1`, [COMPANY]);
  const typeId = Number(mc.classification_id);
  const T = `FCH${Date.now() % 100000}`;

  // Add a chart on the machine type, in one go.
  const bad = await refused(() => createChart(db, c, { type: 'classification', id: typeId }, { name: 'x', axes: [{ label: 'Thickness' }] }));
  ok('a chart without its units is refused, in words', !!bad && /unit/.test(JSON.stringify(bad.problems)), JSON.stringify(bad?.problems));
  const made = await createChart(db, c, { type: 'classification', id: typeId }, {
    name: `${T} gas cutting speed`, resultUnit: 'mm/min', axes: [{ field: 'THICKNESS' }], value: { x: [6, 12, 25], v: [650, 520, 440] },
  });
  const chart = made.charts.find((x) => x.specId === made.chartId);
  ok('added on the machine type: name, result unit, column tied to Thickness with its unit', chart && chart.resultUnit === 'mm/min' && chart.axes[0].field?.code === 'THICKNESS' && chart.axes[0].unit === 'mm', JSON.stringify(chart?.axes));
  ok('…its values are on the type, and it can be written by its name', chart.own === true && chart.value?.v?.[1] === 520 && chart.shortForm === made.code);
  const dupe = await createChart(db, c, { type: 'classification', id: typeId }, { name: `${T} gas cutting speed`, resultUnit: 'mm/min', axes: [{ field: 'THICKNESS' }] });
  ok('a second chart of the same name gets its own code', dupe.code === `${made.code}_2`, dupe.code);

  // On a machine of that type: the type's chart, then its own.
  let onMachine = (await listCharts(db, COMPANY, { type: 'machine', id: mc.id })).find((x) => x.specId === made.chartId);
  ok('a machine of the type sees the chart, from its type', onMachine && !onMachine.own && onMachine.valueFrom?.type === 'classification' && onMachine.value?.v?.[0] === 650);
  await setValues(db, c, 'machine', mc.id, [{ specificationId: made.chartId, value: { x: [6, 12, 25], v: [700, 560, 470] } }]);
  onMachine = (await listCharts(db, COMPANY, { type: 'machine', id: mc.id })).find((x) => x.specId === made.chartId);
  ok('…and its own chart once given one', onMachine.own && onMachine.value.v[0] === 700);
  await setValues(db, c, 'machine', mc.id, [{ specificationId: made.chartId, value: null }]);
  onMachine = (await listCharts(db, COMPANY, { type: 'machine', id: mc.id })).find((x) => x.specId === made.chartId);
  ok('…and back to the type\'s when its own is taken away', !onMachine.own && onMachine.value.v[0] === 650);

  // Editing the chart itself.
  const ed = await updateChart(db, c, made.chartId, { resultUnit: 'm/min', mode: 'linear' });
  ok('the chart is edited in place (unit, between rows)', ed.resultUnit === 'm/min' && ed.mode === 'linear');
  const two = await refused(() => updateChart(db, c, made.chartId, { axes: [{ field: 'THICKNESS' }, { label: 'Hole diameter', unit: 'mm' }] }));
  ok('a chart with values keeps its number of columns, said in words', !!two && /number of columns/.test(JSON.stringify(two.problems)));
  await updateChart(db, c, made.chartId, { resultUnit: 'mm/min' });

  // The machine type page.
  const page = await machineTypeDetails(db, COMPANY, typeId);
  ok('the machine type page: path, its machines, its charts', page.path.at(-1).id === typeId && page.machines.some((m) => m.id === mc.id) && page.charts.some((x) => x.specId === made.chartId));

  // A time written with the chart's name.
  ok('the chart is in the bindings', (await chartBindings(db, COMPANY)).get(made.code)?.[0] === 'THICKNESS');
  const [o] = await db.query("INSERT INTO cf_operations (company_id, code, name, status) VALUES (?, ?, 'Test op', 'active')", [COMPANY, `${T}-OP`]);
  const rule = await createTimingRule(db, c, o.insertId, { subjectType: 'classification', subjectId: typeId, workExpression: `item.CUT_LENGTH / ${made.code}` });
  const [[stored]] = await db.query('SELECT work_expression FROM cf_operation_machine_rules WHERE id = ?', [rule.id]);
  ok('saved as the LOOKUP it stands for', stored.work_expression === `item.CUT_LENGTH / LOOKUP(machine.${made.code}, item.THICKNESS)`, stored.work_expression);
  const shown = (await listTimingRules(db, COMPANY, o.insertId)).find((r) => r.id === rule.id);
  ok('…and shown by its name', shown.work.display === `item.CUT_LENGTH / ${made.code}`, shown.work.display);
  const [f] = await db.query("INSERT INTO cf_operation_flows (company_id, code, name, status) VALUES (?, ?, 'Test flow', 'active')", [COMPANY, `${T}-FL`]);
  await db.query('INSERT INTO cf_operation_flow_steps (company_id, flow_id, sequence, operation_id) VALUES (?, ?, 10, ?)', [COMPANY, f.insertId, o.insertId]);
  const need = (await neededCodesOfFlows(db, COMPANY, [f.insertId])).get(f.insertId);
  ok('a flow with it needs the piece\'s Thickness (the column) and Cut length', need.has('THICKNESS') && need.has('CUT_LENGTH'), [...need].join(','));
  const pv = await timingPreview(db, COMPANY, o.insertId, { machineId: mc.id });
  ok('the preview reads the chart from the machine (waiting only for the piece)', pv.eligible !== false, JSON.stringify(pv).slice(0, 300));
} catch (e) {
  failed++;
  console.error('  ERROR', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 3).join(' '));
} finally {
  await db.rollback();
  db.release();
  const after = await counts();
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
