/**
 * charts_test.mjs — charts on a machine type or machine, and the short chart name in a time
 * formula (chartService, lib/chartFormula.js, 2026-10-08).
 * Local only, one rolled-back transaction, every cf_ table re-counted.
 *
 *   cd multi_app_be && node scripts/cf_kepl/charts_test.mjs
 */
import { pool } from '../../db.js';
import { expandCharts, contractCharts } from '../../apps/cf_erp/lib/chartFormula.js';
import { createChart, updateChart, deleteChart, relayRows, listCharts, machineTypeDetails, chartBindings } from '../../apps/cf_erp/services/chartService.js';
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
ok('long → short when it reads its own columns', contractCharts('item.CUT_LENGTH / LOOKUP(machine.GAS_CUT_SPEED, item.THICKNESS) + 5', B) === 'item.CUT_LENGTH / machine.GAS_CUT_SPEED + 5');
ok('…but a LOOKUP with other arguments stays long', contractCharts('LOOKUP(machine.GAS_CUT_SPEED, item.WIDTH)', B) === 'LOOKUP(machine.GAS_CUT_SPEED, item.WIDTH)');
ok('machine.NAME is read the same as the bare name', expandCharts('item.CUT_LENGTH / machine.GAS_CUT_SPEED', B) === expandCharts('item.CUT_LENGTH / GAS_CUT_SPEED', B));
const round = 'item.HOLES * machine.DRILL_TIME / 60 + item.CUT_LENGTH / machine.GAS_CUT_SPEED';
ok('short → long → short is the same text', contractCharts(expandCharts(round, B), B) === round);

// --- pure: straight lines across every number column (2026-10-09) ---------------
const { lookupRows } = await import('../../apps/cf_erp/services/formulaEngine.js');
const NUM = (label, unit) => ({ kind: 'spec', dataType: 'number', label, unit });
const grid = { mode: 'linear', axes: [NUM('Thickness', 'mm'), { kind: 'spec', dataType: 'option', label: 'Grade' }, NUM('Coats', null), { kind: 'level', label: 'Variant' }],
  rows: [[10, 'E350', 1, 7, 10], [20, 'E350', 1, 7, 20], [10, 'E350', 3, 7, 30], [20, 'E350', 3, 7, 40], [10, 'E250', 1, 7, 5], [20, 'E250', 3, 7, 9]] };
const PP = { id: 7, name: 'Plate part' };
ok('a straight line over two number columns, a word and a tree level between them: the four corners blended', Math.abs(lookupRows(grid, [15, 'E350', 2, PP]).value - 25) < 1e-9);
ok('…on an edge only two corners count', Math.abs(lookupRows(grid, [15, 'E350', 1, PP]).value - 15) < 1e-9 && Math.abs(lookupRows(grid, [10, 'E350', 2, PP]).value - 20) < 1e-9);
ok('…a value exactly on a row is that row', lookupRows(grid, [20, 'E350', 3, PP]).value === 40);
ok('a missing corner is said in words, never filled in', /needs a row at Thickness 10 mm, Coats 3/.test(lookupRows(grid, [15, 'E250', 2, PP]).missingReason ?? ''), lookupRows(grid, [15, 'E250', 2, PP]).missingReason);
ok('outside the chart is a gap, no extending', /above the chart/.test(lookupRows(grid, [25, 'E350', 2, PP]).missingReason ?? ''));
ok('step up on the same rows is unchanged (20 mm, 3 coats)', lookupRows({ ...grid, mode: 'step_up' }, [15, 'E350', 2, PP]).value === 40);

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
  const bad = await refused(() => createChart(db, c, { type: 'classification', id: typeId }, { name: 'x', inputs: [{ label: 'Thickness' }] }));
  ok('a chart without its units is refused, in words', !!bad && /unit/.test(JSON.stringify(bad.problems)), JSON.stringify(bad?.problems));
  const made = await createChart(db, c, { type: 'classification', id: typeId }, {
    name: `${T} gas cutting speed`, resultUnit: 'mm/min', inputs: [{ field: 'THICKNESS' }], rows: [[6, 650], [12, 520], [25, 440]],
  });
  const chart = made.charts.find((x) => x.specId === made.chartId);
  ok('added on the machine type: name, result unit, column tied to Thickness with its unit', chart && chart.resultUnit === 'mm/min' && chart.axes[0].field === 'THICKNESS' && chart.axes[0].unit === 'mm', JSON.stringify(chart?.axes));
  ok('…its values are on the type, and it can be written by its name', chart.own === true && chart.rows?.[1]?.[1] === 520 && chart.shortForm === `machine.${made.code}`);
  const dupe = await createChart(db, c, { type: 'classification', id: typeId }, { name: `${T} gas cutting speed`, resultUnit: 'mm/min', inputs: [{ field: 'THICKNESS' }] });
  ok('a second chart of the same name gets its own code', dupe.code === `${made.code}_2`, dupe.code);

  // On a machine of that type: the type's chart, then its own.
  let onMachine = (await listCharts(db, COMPANY, { type: 'machine', id: mc.id })).find((x) => x.specId === made.chartId);
  ok('a machine of the type sees the chart, from its type', onMachine && !onMachine.own && onMachine.valueFrom?.type === 'classification' && onMachine.rows?.[0]?.[1] === 650);
  await setValues(db, c, 'machine', mc.id, [{ specificationId: made.chartId, value: { rows: [[6, 700], [12, 560], [25, 470]] } }]);
  onMachine = (await listCharts(db, COMPANY, { type: 'machine', id: mc.id })).find((x) => x.specId === made.chartId);
  ok('…and its own chart once given one', onMachine.own && onMachine.rows[0][1] === 700);
  await setValues(db, c, 'machine', mc.id, [{ specificationId: made.chartId, value: null }]);
  onMachine = (await listCharts(db, COMPANY, { type: 'machine', id: mc.id })).find((x) => x.specId === made.chartId);
  ok('…and back to the type\'s when its own is taken away', !onMachine.own && onMachine.rows[0][1] === 650);

  // Editing the chart itself.
  const ed = await updateChart(db, c, made.chartId, { resultUnit: 'm/min', mode: 'linear' });
  ok('the chart is edited in place (unit, between rows)', ed.resultUnit === 'm/min' && ed.mode === 'linear');
  const two = await refused(() => updateChart(db, c, made.chartId, { inputs: [{ field: 'THICKNESS', from: 0 }, { level: 'FAMILY' }] }));
  ok('a new input on a chart with rows needs the value those rows are for, said in words', !!two && /new input/.test(JSON.stringify(two.problems)), JSON.stringify(two?.problems));
  await updateChart(db, c, made.chartId, { resultUnit: 'mm/min' });

  // Many inputs: Thickness (number), Grade (pick-list), Family (tree level), pasted in words.
  const [[piece]] = await db.query(
    `SELECT m.id, t.value_number AS thk, o.value AS grade FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL
       JOIN cf_spec_values t ON t.subject_id = m.id AND t.subject_type = 'master' AND t.deleted_at IS NULL AND t.value_number IS NOT NULL
       JOIN cf_specifications ts ON ts.id = t.specification_id AND ts.code = 'THICKNESS'
       JOIN cf_spec_values g ON g.subject_id = m.id AND g.subject_type = 'master' AND g.deleted_at IS NULL AND g.option_id IS NOT NULL
       JOIN cf_specifications gs ON gs.id = g.specification_id AND gs.code = 'GRADE'
       JOIN cf_spec_options o ON o.id = g.option_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1`, [COMPANY]);
  const { resolve, levelsOfResolution } = await import('../../apps/cf_erp/services/resolutionService.js');
  const pieceRec = (await db.query('SELECT * FROM cf_master_records WHERE id = ?', [piece.id]))[0][0];
  const lv = levelsOfResolution(await resolve(db, COMPANY, { master: pieceRec }));
  ok(`a piece knows its family and subfamily (${lv.FAMILY?.name} › ${lv.SUBFAMILY?.name})`, !!lv.FAMILY && !!lv.SUBFAMILY);
  const thk = Number(piece.thk);
  const many = await createChart(db, c, { type: 'classification', id: typeId }, {
    name: `${T} drill time`, resultUnit: 's', inputs: [{ field: 'THICKNESS' }, { field: 'GRADE' }, { level: 'FAMILY' }],
    rows: [[thk - 1, piece.grade, lv.FAMILY.name, 11], [thk + 2, piece.grade, lv.FAMILY.code, 22], [thk + 2, 'NOT-A-GRADE-X', lv.FAMILY.name, 33]].slice(0, 2),
  });
  const mchart = many.charts.find((x) => x.specId === many.chartId);
  ok('a chart of three inputs: headings from the specifications and the tree', mchart.axes.map((a) => a.label).join(' | ') === 'Thickness | Grade | Family' && mchart.axes[0].unit === 'mm', mchart.axes.map((a) => `${a.label} ${a.unit ?? ''}`).join(' | '));
  ok('…its rows pasted in words are stored as the tree node and the choice', Number(mchart.rows[0][2]) === lv.FAMILY.id && mchart.rows[1][1] === piece.grade && mchart.nodes[lv.FAMILY.id]?.name === lv.FAMILY.name, JSON.stringify(mchart.rows));
  const badRow = await refused(() => createChart(db, c, { type: 'classification', id: typeId }, { name: `${T} bad`, resultUnit: 's', inputs: [{ field: 'THICKNESS' }, { level: 'FAMILY' }], rows: [[10, 'No Such Family', 5]] }));
  ok('a row naming a family the tree does not have is refused, in words', !!badRow && /not a family/.test(JSON.stringify(badRow.problems)), JSON.stringify(badRow?.problems));
  const [o2] = await db.query("INSERT INTO cf_operations (company_id, code, name, status) VALUES (?, ?, 'Drill test', 'active')", [COMPANY, `${T}-DR`]);
  const r2 = await createTimingRule(db, c, o2.insertId, { subjectType: 'classification', subjectId: typeId, workExpression: `${many.code} / 60 + IF(item.family = "${lv.FAMILY.name}", 1, 0) + IF(item.GRADE = "${piece.grade}", 2, 0)` });
  const [[st]] = await db.query('SELECT work_expression FROM cf_operation_machine_rules WHERE id = ?', [r2.id]);
  ok('the chart by its name reads its three inputs from the piece', st.work_expression.startsWith(`LOOKUP(machine.${many.code}, item.THICKNESS, item.GRADE, item.FAMILY)`), st.work_expression);
  const pv2 = await timingPreview(db, COMPANY, o2.insertId, { machineId: mc.id, itemId: piece.id });
  // thk steps up to thk + 2 (the row at or above), its grade, its family: 22 s = 0.3667 min, + 1 + 2.
  ok(`worked out on the real piece: 22 s / 60 + 1 (family) + 2 (grade) = ${(22 / 60 + 3).toFixed(4)} min`, Math.abs((pv2.work?.minutes ?? -1) - (22 / 60 + 3)) < 1e-3, JSON.stringify(pv2.work));
  // Editing the inputs of a chart that has rows and a time reading it (2026-10-09).
  const rowsOf = async (id) => (await listCharts(db, COMPANY, { type: 'classification', id: typeId })).find((x) => x.specId === id);
  const exprOf = async () => (await db.query('SELECT work_expression FROM cf_operation_machine_rules WHERE id = ?', [r2.id]))[0][0].work_expression;
  await updateChart(db, c, many.chartId, { inputs: [{ field: 'GRADE', from: 1 }, { field: 'THICKNESS', from: 0 }, { level: 'FAMILY', from: 2 }] });
  let mc2 = await rowsOf(many.chartId);
  ok('inputs reordered: every row\'s values move with their column', mc2.axes.map((a) => a.label).join('|') === 'Grade|Thickness|Family' && mc2.rows[1][0] === piece.grade && Number(mc2.rows[1][1]) === thk + 2 && mc2.rows[1][3] === 22, JSON.stringify(mc2.rows));
  ok('…and the saved time reads it in the new order', (await exprOf()).startsWith(`LOOKUP(machine.${many.code}, item.GRADE, item.THICKNESS, item.FAMILY)`), await exprOf());
  const pv3 = await timingPreview(db, COMPANY, o2.insertId, { machineId: mc.id, itemId: piece.id });
  ok('…worked out the same on the real piece', Math.abs((pv3.work?.minutes ?? -1) - (22 / 60 + 3)) < 1e-3, JSON.stringify(pv3.work));
  // A time that still lists the inputs in the OLD order reads each column by its own value.
  await db.query('UPDATE cf_operation_machine_rules SET work_expression = ? WHERE id = ?', [`LOOKUP(machine.${many.code},item.THICKNESS, item.GRADE, item.FAMILY) / 60 + IF(item.family = "${lv.FAMILY.name}", 1, 0) + IF(item.GRADE = "${piece.grade}", 2, 0)`, r2.id]);
  const pv4 = await timingPreview(db, COMPANY, o2.insertId, { machineId: mc.id, itemId: piece.id });
  ok('a time listing the inputs in another order still reads each column by its own value', Math.abs((pv4.work?.minutes ?? -1) - (22 / 60 + 3)) < 1e-3, JSON.stringify(pv4.work));
  ok('…and is shown exactly as written, not swapped for the name', (await listTimingRules(db, COMPANY, o2.insertId)).find((r) => r.id === r2.id).work.display.startsWith(`LOOKUP(machine.${many.code},item.THICKNESS, item.GRADE, item.FAMILY)`));
  ok('pure: own columns in another order are shown as written; in order they become the name', contractCharts('LOOKUP(machine.DRILL_TIME, item.HOLE_DIA, item.THICKNESS)', B) === 'LOOKUP(machine.DRILL_TIME, item.HOLE_DIA, item.THICKNESS)' && contractCharts('LOOKUP(machine.DRILL_TIME, item.THICKNESS, item.HOLE_DIA)', B) === 'machine.DRILL_TIME' && contractCharts('LOOKUP(machine.DRILL_TIME, item.HOLE_DIA, item.WIDTH)', B) !== 'machine.DRILL_TIME');
  await updateChart(db, c, many.chartId, { inputs: [{ field: 'GRADE', from: 0 }, { field: 'THICKNESS', from: 1 }, { level: 'FAMILY', from: 2 }, { field: 'WIDTH', unit: 'mm', fill: '300' }] });
  mc2 = await rowsOf(many.chartId);
  ok('an input added with the value the rows are for: every row has it', mc2.axes.length === 4 && mc2.rows.every((r) => Number(r[3]) === 300 && r.length === 5), JSON.stringify(mc2.rows));
  ok('…and the time reads the fourth input too', (await exprOf()).includes(`item.FAMILY, item.WIDTH)`), await exprOf());
  const clash = await refused(() => updateChart(db, c, many.chartId, { inputs: [{ field: 'GRADE', from: 0 }, { level: 'FAMILY', from: 2 }, { field: 'WIDTH', from: 3 }] }));
  ok('removing an input that two rows differ by (11 and 22) is refused, in words', !!clash && /two rows would both read/.test(JSON.stringify(clash.problems)), JSON.stringify(clash?.problems));
  await updateChart(db, c, many.chartId, { inputs: [{ field: 'GRADE', from: 0 }, { field: 'THICKNESS', from: 1 }, { level: 'FAMILY', from: 2 }] });
  mc2 = await rowsOf(many.chartId);
  ok('removing the added input drops its values, the rest stay', mc2.axes.length === 3 && mc2.rows.every((r) => r.length === 4) && mc2.rows[1][3] === 22 && (await exprOf()).startsWith(`LOOKUP(machine.${many.code}, item.GRADE, item.THICKNESS, item.FAMILY)`));
  ok('a removed input with identical rows merges them', JSON.stringify(relayRows([[1, 'a', 5], [2, 'a', 5]], 2, [1], [null]).rows) === JSON.stringify([['a', 5]]));
  // Deleting.
  const inUse = await refused(() => deleteChart(db, c, many.chartId));
  ok('a chart a time reads cannot be deleted; the operation is named', !!inUse && new RegExp(`${T}-DR`).test(inUse.message), inUse?.message);
  const gone = await deleteChart(db, c, dupe.chartId);
  ok('an unused chart is deleted: gone from the type and from the formula names', gone.ok && !(await listCharts(db, COMPANY, { type: 'classification', id: typeId })).some((x) => x.specId === dupe.chartId) && !(await chartBindings(db, COMPANY)).has(dupe.code));

  const need2 = (await neededCodesOfFlows(db, COMPANY, [])).size === 0;
  ok('(sanity) no flows, nothing needed', need2);

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
  ok('…and shown by its name', shown.work.display === `item.CUT_LENGTH / machine.${made.code}`, shown.work.display);
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
