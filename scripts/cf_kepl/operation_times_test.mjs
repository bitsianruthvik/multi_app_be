/**
 * operation_times_test.mjs — scripts/cf_kepl/cf_operation_times.mjs: the plan
 * reads only, the commit produces the expected rules, formulas, specs, flow
 * steps and values, a second run changes nothing, a locked line is refused
 * unless --locked-line-values, and the Times grid then gives the hours.
 *
 *   cd multi_app_be && node scripts/cf_kepl/operation_times_test.mjs
 *   CF_OT_COMPANY=2 (default)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table.
 *
 * IT OWNS ITS FIXTURE: every code and name carries this run's tag as a
 * prefix (machine types, item classes, specifications, formulas, operations,
 * flows), and cf_operation_times.run() takes the same prefix — so the plan runs
 * against the fixture alone, never against the tenant's own setup. Only the
 * shift report also sees the company's other machines (read, and written
 * inside the rolled-back transaction).
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { getLineTimes } from '../../apps/cf_erp/services/timeEstimateService.js';
import { resolveLineRecords } from '../../apps/cf_erp/services/orderValuesService.js';
import { effectiveByCode } from '../../apps/cf_erp/services/resolutionService.js';
import { run, trialFactor, DAY_MIN } from './cf_operation_times.mjs';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_OT_COMPANY ?? 2);
const T = `OT${Date.now().toString(36).toUpperCase()}_`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(Number(a) - Number(b)) < eps;
const section = (s) => console.log(`\n${s}`);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
const log = [];
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { log.push(String(typeof a[0] === 'string' ? a[0] : a[0]?.sql ?? '')); return t.query(...a); } : Reflect.get(t, p)) });

try {
  await conn.beginTransaction();
  attachNodeCache(db);
  const c = { companyId: COMPANY, userId: null };
  const ins = async (table, body) => { const [r] = await conn.query(`INSERT INTO ${table} SET ?`, { company_id: COMPANY, ...body }); return r.insertId; };
  const one = async (sql, params) => (await conn.query(sql, params))[0][0] ?? null;
  const val = async (subjectId, code, subjectType = 'master') => one(
    `SELECT v.value_number, v.source FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
      WHERE v.company_id = ? AND v.subject_type = ? AND v.subject_id = ? AND s.code = ? AND v.deleted_at IS NULL`, [COMPANY, subjectType, subjectId, `${T}${code}`]);

  /* ------------------------------------------------------------------------
   * The fixture: a small composite-girder world, all tagged
   * --------------------------------------------------------------------- */
  section('Fixture');
  const node = (code, name, scope, parent_id = null, depth = 0) => ins('cf_classification_nodes', { code: `${T}${code}`, name: `${T}${name}`, scope, parent_id, depth });
  const mFam = await node('MC', 'Machines', 'machine');
  const type = async (code, name) => node(code, name, 'machine', mFam, 1);
  const tJack = await type('JACK', 'Hydraulic jack');
  const tEot = await type('EOT', 'EOT crane');
  const tGantry = await type('GANTRY', 'Gantry crane');
  const tDrill = await type('MANDRILL', 'Manual drilling');
  const tArc = await type('ARC', 'Arc welding');
  const tMig = await type('MIG', 'MIG welding');
  const machine = (code, classification_id) => ins('cf_machines', { code: `${T}${code}`, name: `${T}${code}`, classification_id });
  const mJack = await machine('JACK1', tJack);
  await machine('EOT1', tEot);
  await machine('GAN1', tGantry);
  await machine('DRL1', tDrill);
  await machine('ARC1', tArc);
  await machine('MIG1', tMig);
  // A machine on the house Day shift: stretched to 08-20 and given a Night by --shifts.
  const mEot2 = await machine('EOT2', tEot);
  const houseShift = await ins('cf_machine_shifts', { machine_id: mEot2, name: 'Day', weekdays: 'mon,tue,wed,thu,fri,sat', start_time: '08:00', end_time: '17:00', break_minutes: 60 });

  const fab = await node('FAB', 'Fabricated', 'both');
  const assy = await node('FAB_ASSY', 'Assemblies', 'both', fab, 1);
  const plates = await node('PLATES', 'Plates', 'both', fab, 1);
  const cSeg = await node('GIRDER_SEGMENT', 'Girder segment', 'both', assy, 2);
  const cLine = await node('GIRDER_LINE', 'Girder line', 'both', assy, 2);
  const cSpan = await node('BRIDGE_SPAN', 'Bridge span', 'both', assy, 2);
  const cPart = await node('PLATE_PART', 'Plate part', 'both', plates, 2);
  const cCut = await node('CUT_PLATE', 'Cut plate', 'both', plates, 2);

  const spec = (code, extra = {}) => ins('cf_specifications', { code: `${T}${code}`, name: `${T} ${code}`, data_type: 'number', ...extra });
  const chart = (code, unit) => spec(code, { data_type: 'table', table_config: JSON.stringify({ mode: 'step_up', axes: [{ label: 'Size', unit }] }) });
  const S = {};
  for (const [code, uom] of [['LENGTH', 'mm'], ['WIDTH', 'mm'], ['WEIGHT', 'kg'], ['SPAN_LENGTH', 'mm'], ['SURFACE_AREA', 'm2'], ['WELD_LENGTH', 'm'], ['WELD_SIZE', 'mm'],
    ['COATS', null], ['HOLES', null], ['HOLE_TRANSFERS', null], ['STIFFENERS', null], ['STUDS', null], ['MANUAL_DRILL_TIME', 'min'], ['MARK_TIME', 'min'], ['METAL_RATE', null], ['PAINT_RATE', null]]) {
    S[code] = await spec(code, { default_uom: uom });
  }
  for (const code of ['SAW_RATE', 'ARC_RATE', 'MIG_RATE']) S[code] = await chart(code, 'mm');
  const rule = (specCode, subjectId, value_rule = 'entered', subject_type = 'classification') => ins('cf_spec_assignments', { specification_id: S[specCode], subject_type, subject_id: subjectId, capture_at: 'item', value_rule });
  await rule('LENGTH', fab);
  await rule('WEIGHT', fab);
  await rule('WIDTH', plates);
  for (const code of ['WELD_LENGTH', 'WELD_SIZE', 'COATS', 'STIFFENERS', 'STUDS', 'SURFACE_AREA', 'SPAN_LENGTH']) await rule(code, assy);
  for (const code of ['HOLES', 'HOLE_TRANSFERS']) await rule(code, cPart);
  await rule('MANUAL_DRILL_TIME', mFam, 'defaulted');
  await rule('MARK_TIME', mFam, 'defaulted');
  await ins('cf_spec_values', { specification_id: S.MANUAL_DRILL_TIME, subject_type: 'classification', subject_id: tDrill, value_number: 2.5 });
  await ins('cf_spec_values', { specification_id: S.MARK_TIME, subject_type: 'classification', subject_id: tDrill, value_number: 0.5 });

  const i = (code) => `item.${T}${code}`;
  const m = (code) => `machine.${T}${code}`;
  const formula = (code, expression) => ins('cf_formulas', { code: `${T}${code}`, name: `${T} ${code}`, expression });
  const F = {
    saw: await formula('CG_SAW_WELD_TIME', `${i('WELD_LENGTH')} * LOOKUP(${m('SAW_RATE')}, ${i('WELD_SIZE')})`),
    arc: await formula('CG_ARC_WELD_TIME', `${i('WELD_LENGTH')} * LOOKUP(${m('ARC_RATE')}, ${i('WELD_SIZE')})`),
    mig: await formula('CG_MIG_WELD_TIME', `${i('WELD_LENGTH')} * LOOKUP(${m('MIG_RATE')}, ${i('WELD_SIZE')})`),
    metal: await formula('CG_METALLIZE_TIME', `${i('SURFACE_AREA')} * ${m('METAL_RATE')} * ${i('COATS')}`),
    paint: await formula('CG_PAINT_TIME', `${i('SURFACE_AREA')} * ${m('PAINT_RATE')} * ${i('COATS')}`),
    drill: await formula('CG_MANUAL_DRILL_TIME', `${i('HOLES')} * ${m('MANUAL_DRILL_TIME')} + ${i('HOLE_TRANSFERS')} * ${m('MARK_TIME')}`),
    stiff: await formula('CG_STIFFENER_FITUP_TIME', `${i('STIFFENERS')} * 20`),
  };
  const op = (code) => ins('cf_operations', { code: `${T}${code}`, name: `${T} ${code}` });
  const O = {};
  for (const code of ['CG-JACKBEND', 'CG-LINEMATCH', 'CG-TRIALASM', 'CG-DISMANTLE', 'CG-MANDRILL', 'CG-STIFFFIT', 'CG-MIGWELD']) O[code] = await op(code);
  const timing = (opCode, subjectId, body = {}) => ins('cf_operation_machine_rules', { operation_id: O[opCode], subject_type: 'classification', subject_id: subjectId, eligible: 1, ...body });
  await timing('CG-LINEMATCH', tEot);
  await timing('CG-TRIALASM', tGantry);
  await timing('CG-DISMANTLE', tGantry);
  await timing('CG-MANDRILL', tDrill, { work_formula_id: F.drill });
  await timing('CG-STIFFFIT', tArc, { work_formula_id: F.stiff });
  await timing('CG-MIGWELD', tMig, { work_formula_id: F.mig });
  const flow = async (code, steps) => {
    const id = await ins('cf_operation_flows', { code: `${T}${code}`, name: `${T} ${code}`, status: 'active' });
    for (const [seq, opCode] of steps) await ins('cf_operation_flow_steps', { flow_id: id, sequence: seq, operation_id: O[opCode] });
    return id;
  };
  const girderFlow = await flow('CG-GIRDERASM', [[10, 'CG-JACKBEND'], [20, 'CG-LINEMATCH'], [50, 'CG-MANDRILL'], [60, 'CG-STIFFFIT'], [70, 'CG-MIGWELD'],
    [90, 'CG-STIFFFIT'], [100, 'CG-MIGWELD'], [110, 'CG-MANDRILL'], [120, 'CG-MANDRILL'], [130, 'CG-TRIALASM'], [140, 'CG-DISMANTLE']]);
  await flow('CG-INNERSPLICE', [[20, 'CG-MANDRILL'], [30, 'CG-MANDRILL'], [40, 'CG-TRIALASM']]);

  // The order: a span of one girder line of 1 + 2 segments (3 per line -> 2 joints).
  const orderId = await ins('cf_sales_orders', { code: `${T}SO`, status: 'confirmed' });
  const item = async (name, classification_id, extra = {}) => {
    const id = await ins('cf_master_records', { record_kind: 'item', name, classification_id, status: 'active', ...extra });
    await ins('cf_item_details', { master_id: id, item_type: 'temporary' });
    return id;
  };
  const span = await item('Composite girder span', cSpan);
  const lineId = await ins('cf_sales_order_lines', { order_id: orderId, line_no: 10, line_type: 'custom', item_id: span, design_id: span, position: 1, quantity: 1 });
  const gl = await item('Girder line', cLine);
  const segA = await item('Girder segment', cSeg, { default_flow_id: girderFlow });
  const segB = await item('Girder segment', cSeg, { default_flow_id: girderFlow });
  const webA = await item('Web', cPart);
  const flangeA = await item('Top flange', cPart);
  const webB = await item('Web', cPart);
  const cut = await item('Cut plate 1000 x 500', cCut);
  await conn.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id IN (?)', [lineId, COMPANY, [span, gl, segA, segB, webA, flangeA, webB, cut]]);
  const bomOf = async (parent, kids) => {
    const b = await ins('cf_boms', { parent_id: parent, bom_type: 'custom', status: 'active' });
    for (const [n, [child, q]] of kids.entries()) await ins('cf_bom_lines', { bom_id: b, line_no: (n + 1) * 10, child_id: child, design_id: child, position: 1, quantity: q });
  };
  await bomOf(span, [[gl, 1]]);
  await bomOf(gl, [[segA, 1], [segB, 2]]);
  await bomOf(segA, [[webA, 1], [flangeA, 1]]);
  await bomOf(segB, [[webB, 1]]);
  await bomOf(webA, [[cut, 1]]);
  const value = (subject_id, code, value_number) => ins('cf_spec_values', { specification_id: S[code], subject_type: 'master', subject_id, value_number });
  await value(span, 'WEIGHT', 1000);
  await value(segA, 'WEIGHT', 300);
  await value(segB, 'WEIGHT', 350);
  await value(webA, 'LENGTH', 11650);
  await value(flangeA, 'LENGTH', 11700); // longer than the web: the web wins
  await value(webB, 'LENGTH', 12000);
  await value(cut, 'LENGTH', 1000);
  await value(cut, 'WIDTH', 500);
  ok('fixture built', true);

  const go = (opts = {}) => run(db, COMPANY, { prefix: T, lineId, ...opts });
  const changes = (out) => out.actions.filter((a) => a.status === 'change');
  const find = (out, area, what) => out.actions.find((a) => a.area === area && a.what.startsWith(what));

  /* ------------------------------------------------------------------------
   * 1. The plan alone reads, and only reads
   * --------------------------------------------------------------------- */
  section('1. The plan reads only');
  log.length = 0;
  const dry = await go();
  const writes = log.filter((s) => !/^\s*(SELECT|\(SELECT|WITH)\b/i.test(s));
  ok('a plan-only run issues SELECTs only', writes.length === 0, writes.slice(0, 2).join(' | '));
  ok(`the plan reads in a fixed number of round trips (${log.length})`, log.length <= 20, String(log.length));
  ok('it plans changes', changes(dry).length > 30, String(changes(dry).length));
  ok('nothing was applied', dry.appliedActions === 0 && dry.appliedShifts === 0);

  /* ------------------------------------------------------------------------
   * 2. Commit on the LOCKED line: setup changes; item values refused
   * --------------------------------------------------------------------- */
  section('2. Locked line — commit without --locked-line-values');
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE company_id = ? AND id = ?', [COMPANY, lineId]);
  const locked = await go({ commit: true });
  const blockedValues = locked.actions.find((a) => a.area === 'Item values');
  ok('the item values are BLOCKED on a locked line', blockedValues?.status === 'blocked' && /locked/.test(blockedValues.why ?? ''), JSON.stringify(blockedValues));
  ok('…and nothing was written on the segments', (await val(segA, 'LENGTH')) === null);

  const formulaOf = async (code) => one('SELECT id, expression FROM cf_formulas WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, `${T}${code}`]);
  const ruleOn = async (opCode, subjectId) => one(
    `SELECT r.*, f.code AS work_code FROM cf_operation_machine_rules r JOIN cf_operations o ON o.id = r.operation_id
       LEFT JOIN cf_formulas f ON f.id = r.work_formula_id
      WHERE r.company_id = ? AND o.code = ? AND r.subject_type = 'classification' AND r.subject_id = ? AND r.deleted_at IS NULL`, [COMPANY, `${T}${opCode}`, subjectId]);

  section('   1. jack bend');
  ok('CG_JACK_BEND_TIME = item.LENGTH * 30 / 1000', (await formulaOf('CG_JACK_BEND_TIME'))?.expression === `${i('LENGTH')} * 30 / 1000`);
  const jackRule = await ruleOn('CG-JACKBEND', tJack);
  ok('a rule on the Hydraulic jack type (found by name) reads it', jackRule?.work_code === `${T}CG_JACK_BEND_TIME` && jackRule.work_minutes == null);
  ok('its notes quote the workbook (12 h shift = 24 m)', /24 m of girder length/.test(jackRule?.notes ?? ''));

  section('   2. line matching');
  const lm = await ruleOn('CG-LINEMATCH', tEot);
  ok('3 segments a girder line -> 2/3 x 720 = 480 min a segment', near(lm?.work_minutes, 480), String(lm?.work_minutes));
  ok('its notes carry "need to confirm"', /NEED TO CONFIRM/.test(lm?.notes ?? ''));

  section('   3. trial assembly and dismantling');
  const T36 = 6.5 * DAY_MIN * (59300 / 36000) * trialFactor(59300);
  const rate = Number((T36 / 1000).toPrecision(6));
  ok(`trial assembly = item.WEIGHT * ${rate} (59.3 m, x1.2, 24 h days, 1,000 kg span)`, (await formulaOf('CG_TRIAL_ASSEMBLY_TIME'))?.expression === `${i('WEIGHT')} * ${rate}`, (await formulaOf('CG_TRIAL_ASSEMBLY_TIME'))?.expression);
  ok('dismantling is half', (await formulaOf('CG_DISMANTLE_TIME'))?.expression === `${i('WEIGHT')} * ${Number((T36 / 2 / 1000).toPrecision(6))}`);
  ok('the Gantry rules read them', (await ruleOn('CG-TRIALASM', tGantry))?.work_code === `${T}CG_TRIAL_ASSEMBLY_TIME` && (await ruleOn('CG-DISMANTLE', tGantry))?.work_code === `${T}CG_DISMANTLE_TIME`);
  ok('trialFactor: x0.8 under 36 m, x1 at 36, x1.2 over', trialFactor(18000) === 0.8 && trialFactor(36000) === 1 && trialFactor(52000) === 1.2);

  section('   5. cut plates');
  const ruleOnClass = async (specCode, nodeId) => one(
    `SELECT a.value_rule, f.code AS formula_code FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id LEFT JOIN cf_formulas f ON f.id = a.formula_id
      WHERE a.company_id = ? AND s.code = ? AND a.subject_type = 'classification' AND a.subject_id = ? AND a.deleted_at IS NULL`, [COMPANY, `${T}${specCode}`, nodeId]);
  ok('CUT_LENGTH and PIERCINGS were made (the fixture had neither)', !!(await one('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ?', [COMPANY, `${T}CUT_LENGTH`])) && !!(await one('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ?', [COMPANY, `${T}PIERCINGS`])));
  ok('CUT_LENGTH on Cut plate: calculated = 2 * (LENGTH + WIDTH)', (await ruleOnClass('CUT_LENGTH', cCut))?.formula_code === `${T}CG_CUT_PLATE_PERIMETER` && (await formulaOf('CG_CUT_PLATE_PERIMETER'))?.expression === `2 * (${T}LENGTH + ${T}WIDTH)`);
  ok('PIERCINGS on Cut plate: defaulted, 1 on the classification', (await ruleOnClass('PIERCINGS', cCut))?.value_rule === 'defaulted' && near((await val(cCut, 'PIERCINGS', 'classification'))?.value_number, 1));
  ok('the LOCKED line\'s blank got no CUT_LENGTH (frozen)', (await val(cut, 'CUT_LENGTH')) === null);

  section('   6a. one quantity per process; both faces');
  for (const code of ['SAW_WELD_LENGTH', 'SAW_WELD_SIZE', 'ARC_WELD_LENGTH', 'ARC_WELD_SIZE', 'MIG_WELD_LENGTH', 'MIG_WELD_SIZE', 'METALLISE_COATS', 'PAINT_COATS']) {
    const r = await ruleOnClass(code, assy);
    ok(`${code} made and assignable on Assemblies, like the shared one`, r?.value_rule === 'entered');
  }
  ok('SAW reads SAW_WELD_LENGTH / SAW_WELD_SIZE', (await formulaOf('CG_SAW_WELD_TIME')).expression === `${i('SAW_WELD_LENGTH')} * LOOKUP(${m('SAW_RATE')}, ${i('SAW_WELD_SIZE')})`);
  ok('ARC reads ARC_WELD_LENGTH / ARC_WELD_SIZE', (await formulaOf('CG_ARC_WELD_TIME')).expression === `${i('ARC_WELD_LENGTH')} * LOOKUP(${m('ARC_RATE')}, ${i('ARC_WELD_SIZE')})`);
  ok('MIG reads MIG_WELD_LENGTH / MIG_WELD_SIZE', (await formulaOf('CG_MIG_WELD_TIME')).expression === `${i('MIG_WELD_LENGTH')} * LOOKUP(${m('MIG_RATE')}, ${i('MIG_WELD_SIZE')})`);
  ok('metallising: both faces, its own coats', (await formulaOf('CG_METALLIZE_TIME')).expression === `${i('SURFACE_AREA')} * 2 * ${m('METAL_RATE')} * ${i('METALLISE_COATS')}`);
  ok('painting: both faces, its own coats', (await formulaOf('CG_PAINT_TIME')).expression === `${i('SURFACE_AREA')} * 2 * ${m('PAINT_RATE')} * ${i('PAINT_COATS')}`);
  ok('no value was invented for any of them', !(await one(`SELECT v.id FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id WHERE v.company_id = ? AND s.code IN (?) AND v.deleted_at IS NULL`,
    [COMPANY, ['SAW_WELD_LENGTH', 'ARC_WELD_LENGTH', 'MIG_WELD_LENGTH', 'METALLISE_COATS', 'PAINT_COATS', 'HOLES_TOP', 'HOLES_BOTTOM', 'STIFFENERS_AFTER_FLIP'].map((x) => `${T}${x}`)])));

  section('   6b. each later pass is its own operation');
  const stepsOf = async (flowCode) => (await conn.query(
    `SELECT s.sequence, o.code, s.step_name FROM cf_operation_flow_steps s JOIN cf_operations o ON o.id = s.operation_id JOIN cf_operation_flows f ON f.id = s.flow_id
      WHERE s.company_id = ? AND f.code = ? AND s.deleted_at IS NULL ORDER BY s.sequence`, [COMPANY, `${T}${flowCode}`]))[0];
  const g = new Map((await stepsOf('CG-GIRDERASM')).map((s) => [s.sequence, s]));
  ok('girder pass 1 keeps CG-MANDRILL (hole transfer)', g.get(50).code === `${T}CG-MANDRILL` && g.get(50).step_name === 'Hole transfer (S9)');
  ok('girder pass 2 -> CG-MANDRILL-TOP', g.get(110).code === `${T}CG-MANDRILL-TOP` && /top \(S20\)/.test(g.get(110).step_name));
  ok('girder pass 3 -> CG-MANDRILL-BOTTOM', g.get(120).code === `${T}CG-MANDRILL-BOTTOM`);
  ok('stiffener fit-up after the flip -> CG-STIFFFIT-2', g.get(60).code === `${T}CG-STIFFFIT` && g.get(90).code === `${T}CG-STIFFFIT-2`);
  ok('MIG after the flip -> CG-MIGWELD-2', g.get(70).code === `${T}CG-MIGWELD` && g.get(100).code === `${T}CG-MIGWELD-2`);
  const inner = await stepsOf('CG-INNERSPLICE');
  ok('inner splice pass 2 -> CG-MANDRILL-INNER', inner[0].code === `${T}CG-MANDRILL` && inner[1].code === `${T}CG-MANDRILL-INNER`);
  ok('each new operation has the original\'s machine type, with its own formula',
    (await ruleOn('CG-MANDRILL-TOP', tDrill))?.work_code === `${T}CG_MANUAL_DRILL_TOP_TIME` && (await ruleOn('CG-STIFFFIT-2', tArc))?.work_code === `${T}CG_STIFFENER_FITUP_2_TIME` && (await ruleOn('CG-MIGWELD-2', tMig))?.work_code === `${T}CG_MIG_WELD_2_TIME`);
  ok('top pass reads only HOLES_TOP', (await formulaOf('CG_MANUAL_DRILL_TOP_TIME')).expression === `${i('HOLES_TOP')} * ${m('MANUAL_DRILL_TIME')}`);

  section('   6d. what the girder flow reads is assignable on the girder segment');
  for (const code of ['HOLES', 'HOLE_TRANSFERS', 'HOLES_TOP', 'HOLES_BOTTOM', 'STIFFENERS_AFTER_FLIP', 'MIG_WELD_LENGTH_AFTER_FLIP']) {
    ok(`${code} on Girder segment`, (await ruleOnClass(code, cSeg))?.value_rule === 'entered');
  }
  ok('LENGTH is NOT re-added there (Fabricated already has it)', (await ruleOnClass('LENGTH', cSeg)) === null);

  /* ------------------------------------------------------------------------
   * 3. Idempotent
   * --------------------------------------------------------------------- */
  section('3. A second run changes nothing');
  const again = await go({ commit: true });
  ok('nothing left to change', changes(again).length === 0 && again.appliedActions === 0, changes(again).map((a) => `${a.area} ${a.what}`).join('; '));
  ok('only the locked line\'s values stay blocked', again.actions.filter((a) => a.status === 'blocked').every((a) => a.area === 'Item values'));

  /* ------------------------------------------------------------------------
   * 4. --locked-line-values writes them, once
   * --------------------------------------------------------------------- */
  section('4. --locked-line-values');
  const forced = await go({ commit: true, lockedLineValues: true });
  ok('one item-values change applied', forced.appliedActions === 1, String(forced.appliedActions));
  ok('segment A LENGTH = its web, 11,650 (not the longer flange)', near((await val(segA, 'LENGTH'))?.value_number, 11650));
  ok('segment B LENGTH = 12,000', near((await val(segB, 'LENGTH'))?.value_number, 12000));
  ok('the blank: CUT_LENGTH 3,000 (calculated), PIERCINGS 1 (defaulted)', near((await val(cut, 'CUT_LENGTH'))?.value_number, 3000) && (await val(cut, 'CUT_LENGTH')).source === 'calculated' && near((await val(cut, 'PIERCINGS'))?.value_number, 1));
  ok('history rows were written for them', Number((await one('SELECT COUNT(*) AS n FROM cf_spec_value_history WHERE company_id = ? AND subject_type = ? AND subject_id IN (?)', [COMPANY, 'master', [segA, segB, cut]])).n) >= 4);
  const third = await go({ commit: true, lockedLineValues: true });
  ok('and a third run changes nothing at all', changes(third).length === 0 && third.actions.every((a) => a.status !== 'blocked'), third.actions.filter((a) => a.status !== 'same').map((a) => `${a.area} ${a.what}`).join('; '));

  /* ------------------------------------------------------------------------
   * 5. The Times grid now gives the hours
   * --------------------------------------------------------------------- */
  section('5. Times grid (getLineTimes) on the line');
  const v = await getLineTimes(db, COMPANY, orderId, lineId);
  const byCode = new Map(v.operations.map((o) => [o.code, v.totals.byOperation[o.id] ?? null]));
  ok('jack bend = (11,650 x 1 + 12,000 x 2) x 30 / 1000 = 1,069.5 min', near(byCode.get(`${T}CG-JACKBEND`), 1069.5, 1e-3), String(byCode.get(`${T}CG-JACKBEND`)));
  ok('line matching = 3 segments x 480 = 1,440 min (2 joints = 1 day)', near(byCode.get(`${T}CG-LINEMATCH`), 1440, 1e-3), String(byCode.get(`${T}CG-LINEMATCH`)));
  ok(`trial assembly on the segments = (300 + 2 x 350) x ${rate}`, near(byCode.get(`${T}CG-TRIALASM`), 1000 * rate, 1e-2), String(byCode.get(`${T}CG-TRIALASM`)));
  const mandrill = v.rows.find((r) => r.itemId === segA)?.cells[O['CG-MANDRILL']];
  ok('CG-MANDRILL now runs ONCE in the girder flow (passes 1)', mandrill?.passes === 1, JSON.stringify(mandrill));
  ok('the top-hole pass waits for its own quantity, not HOLES', /HOLES_TOP/.test(v.rows.find((r) => r.itemId === segA)?.cells[(await one('SELECT id FROM cf_operations WHERE company_id = ? AND code = ?', [COMPANY, `${T}CG-MANDRILL-TOP`])).id]?.missing ?? ''));

  /* ------------------------------------------------------------------------
   * 6. A live line: values through valueService; new blanks get their perimeter
   * --------------------------------------------------------------------- */
  section('6. Live line');
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE company_id = ? AND id = ?', [COMPANY, lineId]);
  const segC = await item('Girder segment', cSeg, { default_flow_id: girderFlow });
  const webC = await item('Web', cPart);
  const cut2 = await item('Cut plate 800 x 400', cCut);
  await conn.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id IN (?)', [lineId, COMPANY, [segC, webC, cut2]]);
  const [[glBom]] = await conn.query('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ?', [COMPANY, gl]);
  await ins('cf_bom_lines', { bom_id: glBom.id, line_no: 30, child_id: segC, design_id: segC, position: 1, quantity: 1 });
  await bomOf(segC, [[webC, 1]]);
  await bomOf(webC, [[cut2, 1]]);
  await value(webC, 'LENGTH', 9000);
  await value(cut2, 'LENGTH', 800);
  await value(cut2, 'WIDTH', 400);
  const live = await go({ commit: true });
  ok('the live segment gets LENGTH 9,000 through valueService (entered)', near((await val(segC, 'LENGTH'))?.value_number, 9000) && (await val(segC, 'LENGTH')).source === 'entered');
  ok('line matching follows the structure: 4 segments -> 3/4 x 720 = 540', near((await ruleOn('CG-LINEMATCH', tEot))?.work_minutes, 540));
  const res = await resolveLineRecords(db, COMPANY, lineId);
  const eff = effectiveByCode(res.get(cut2));
  ok('a new blank on a live line reads CUT_LENGTH = 2 x (800 + 400) from the rule', near(eff.get(`${T}CUT_LENGTH`)?.raw, 2400), JSON.stringify(eff.get(`${T}CUT_LENGTH`)));
  ok('…and PIERCINGS 1 from the classification default', near(eff.get(`${T}PIERCINGS`)?.raw, 1));
  ok('the run changed only what the new structure needed', live.appliedActions === 2, `${live.appliedActions}: ${changes(live).map((a) => `${a.area} ${a.what}`).join('; ')}`);

  /* ------------------------------------------------------------------------
   * 7. Shifts: report, then round the clock on --shifts
   * --------------------------------------------------------------------- */
  section('7. Shifts');
  const rep = live.shiftPlan.machines;
  const jackRec = rep.find((r) => r.machine.id === mJack);
  const eotRec = rep.find((r) => r.machine.id === mEot2);
  ok('the jack is a production machine now that it has a rule', !!jackRec);
  ok('no shift today -> "none"; the house Day shift -> "house-day"', jackRec?.kind === 'none' && eotRec?.kind === 'house-day');
  ok('the report alone wrote no shift', Number((await one('SELECT COUNT(*) AS n FROM cf_machine_shifts WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [COMPANY, mJack])).n) === 0);
  const sh = await go({ shifts: true });
  ok('--shifts sets machines round the clock', sh.appliedShifts > 0 && sh.appliedActions === 0);
  const shiftsOf = async (id) => (await conn.query('SELECT id, name, start_time, end_time, break_minutes, weekdays FROM cf_machine_shifts WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL ORDER BY start_time', [COMPANY, id]))[0];
  const jackShifts = await shiftsOf(mJack);
  const t = sh.shiftPlan.template;
  if (!t) {
    ok('the jack: Day 08-20 + Night 20-08 (2 x 12 h, the workbook\'s shift)', jackShifts.length === 2 && String(jackShifts[0].start_time).startsWith('08:00') && String(jackShifts[0].end_time).startsWith('20:00') && String(jackShifts[1].start_time).startsWith('20:00'), JSON.stringify(jackShifts));
    const eot = await shiftsOf(mEot2);
    ok('the house Day shift was STRETCHED (same row), and a Night added', eot.length === 2 && eot.some((s) => s.id === houseShift && String(s.end_time).startsWith('20:00')), JSON.stringify(eot));
  } else ok(`a round-the-clock template from the company was used (${t.source})`, jackShifts.length === t.shifts.length);
  const sh2 = await go({ shifts: true });
  ok('a second --shifts changes nothing', sh2.appliedShifts === 0, String(sh2.appliedShifts));
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
