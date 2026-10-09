/**
 * process-flow-v7.mjs — charts and operation times from Process_Flow_v7-Formulae.xlsx (user,
 * 2026-10-09: "think through all the formulas … show me the charts … then the formulas … Once I say
 * ok, you can upload"; answers: welding is on the structure → item.variant, 1 day = one 12 h shift,
 * blasting per piece and "big", a piece value for the hole drilling thickness).
 *
 *   CHARTS   CNC_DRILL_TIME (renamed from CNC_DRILL_TIME_2) moves from PFPL/CNCD/01 to the CNC
 *            drilling type, rows in seconds as in the sheet + "cannot" rows (the x cells);
 *            SAW_RATE becomes Structure (variant) × SAW weld size, s/m; new MIG_RATE (variant × MIG
 *            weld size, min/m) on MIG welding; ARC_RATE gets the same columns, no rows yet; new
 *            TRIAL_ASM_DAYS (girder type × span) on Gantry crane; new BLAST_TIME (coats) on
 *            Automatic blasting. CUT_SPEED and GAS_CUT_SPEED are unchanged.
 *   VALUES   new piece value HOLE_DRILL_THICKNESS (mm); new machine value PAINT_DRY_TIME = 90 min on
 *            Airless paint sprayer.
 *   TIMES    every operation time of the sheet, through updateTimingRule (charts written by name are
 *            stored as the LOOKUP they stand for; each operation's flow values follow).
 *
 *   node scripts/cf_kepl/process-flow-v7.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/process-flow-v7.mjs --company 30005 --apply    (commits)
 * Re-running after an apply changes nothing it has already done.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const { createChart, updateChart, setChartValue, listCharts } = await import('../../apps/cf_erp/services/chartService.js');
const { createSpec } = await import('../../apps/cf_erp/services/specificationService.js');
const { setValues } = await import('../../apps/cf_erp/services/valueService.js');
const { updateTimingRule, listTimingRules, timingPreview } = await import('../../apps/cf_erp/services/operationService.js');

const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
const say = (...a) => console.log(...a);
const one = async (sql, p) => (await db.query(sql, p))[0][0] ?? null;
const typeId = async (name) => { const r = await one("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND scope = 'machine' AND deleted_at IS NULL AND name = ?", [COMPANY, name]); if (!r) throw new Error(`No machine type "${name}"`); return Number(r.id); };
const specOf = async (code) => one('SELECT * FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
const T = (id) => ({ type: 'classification', id });

try {
  await db.beginTransaction();

  // ---------------------------------------------------------------- charts
  say('1. Charts');
  const types = {
    drill: await typeId('CNC drilling'), saw: await typeId('SAW welding'), mig: await typeId('MIG welding'),
    arc: await typeId('Arc welding'), gantry: await typeId('Gantry crane'), blast: await typeId('Automatic blasting'),
    paint: await typeId('Airless paint sprayer'),
  };

  // CNC drilling: back to its plain name, on the type, rows in seconds.
  let drill = await specOf('CNC_DRILL_TIME') ?? await specOf('CNC_DRILL_TIME_2');
  if (!drill) throw new Error('No CNC drill chart');
  if (drill.code !== 'CNC_DRILL_TIME') {
    await db.query("UPDATE cf_specifications SET code = 'CNC_DRILL_TIME' WHERE company_id = ? AND id = ?", [COMPANY, drill.id]);
    await db.query("UPDATE cf_operation_machine_rules SET work_expression = REPLACE(work_expression, 'machine.CNC_DRILL_TIME_2', 'machine.CNC_DRILL_TIME') WHERE company_id = ? AND work_expression LIKE '%CNC_DRILL_TIME_2%'", [COMPANY]);
    say('   CNC_DRILL_TIME_2 → CNC_DRILL_TIME');
  }
  const own = await db.query("SELECT a.id, a.subject_id FROM cf_spec_assignments a WHERE a.company_id = ? AND a.specification_id = ? AND a.subject_type = 'machine' AND a.deleted_at IS NULL", [COMPANY, drill.id]);
  for (const a of own[0]) {
    await setValues(db, c, 'machine', a.subject_id, [{ specificationId: drill.id, value: null }]);
    await db.query('UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE id = ?', [a.id]);
  }
  if (!(await one("SELECT id FROM cf_spec_assignments WHERE company_id = ? AND specification_id = ? AND subject_type = 'classification' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, drill.id, types.drill]))) {
    await db.query("INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule) VALUES (?, ?, 'classification', ?, 'item', 0, 1, 'defaulted')", [COMPANY, drill.id, types.drill]);
  }
  await updateChart(db, c, drill.id, { name: 'CNC drill time', resultUnit: 's', mode: 'linear', inputs: [{ field: 'HOLE_DIA', from: 0 }, { field: 'THICKNESS', from: 1 }] });
  const THK = [10, 20, 30, 40, 50, 60, 70];
  const drillRows = [
    ...THK.map((t, i) => [21, t, [50, 80, 110, 180, 240, 270, 300][i]]),
    ...THK.map((t, i) => [26, t, [55, 100, 120, 210, 270, 330, 360][i]]),
    // The sheet's "x": the machine cannot drill these diameters.
    ...[14, 35, 45, 60].flatMap((d) => THK.map((t) => [d, t, null])),
  ];
  await setChartValue(db, c, T(types.drill), drill.id, drillRows);
  say(`   CNC_DRILL_TIME on CNC drilling: ${drillRows.length} rows (s), 14/35/45/60 mm marked "cannot"${own[0].length ? `; taken off ${own[0].length} machine` : ''}`);

  // SAW: structure × weld size.
  const saw = await specOf('SAW_RATE');
  // Its old rows (by weld size alone, minutes labelled s) go everywhere — the type's and every machine's copy — so the new columns start clean.
  await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL', [COMPANY, saw.id]);
  await updateChart(db, c, saw.id, { name: 'SAW welding rate', resultUnit: 's/m', mode: 'step_up', inputs: [{ level: 'VARIANT' }, { field: 'SAW_WELD_SIZE' }] });
  await setChartValue(db, c, T(types.saw), saw.id, [['Arch box', 6, 40], ['Arch box', 10, 300], ['Girder segment', 6, 200], ['Girder segment', 12, 350]]);
  say('   SAW_RATE on SAW welding: Structure × SAW weld size, 4 rows (s/m)');

  // MIG: new. "-" in the sheet = cannot.
  const migRows = [
    ['Arch box', 8, 5], ['Arch box', 10, null], ['Arch box', 12, 15],
    ['Bottom longitudinal beam', 8, null], ['Bottom longitudinal beam', 10, null], ['Bottom longitudinal beam', 12, 15],
    ['Intermediate cross beam', 8, null], ['Intermediate cross beam', 10, null], ['Intermediate cross beam', 12, 15],
    ['Top tie beam', 8, 5], ['Top tie beam', 10, null], ['Top tie beam', 12, 15],
    ['Bottom Lateral Bracings', 10, 15], ['Bottom Lateral Bracings', 12, 15], ['Bottom Lateral Bracings', 16, 30],
  ];
  let mig = await specOf('MIG_RATE');
  if (!mig) {
    const made = await createChart(db, c, T(types.mig), { name: 'MIG welding rate', code: 'MIG_RATE', resultUnit: 'min/m', mode: 'step_up', inputs: [{ level: 'VARIANT' }, { field: 'MIG_WELD_SIZE' }], rows: migRows });
    mig = await specOf(made.code);
  } else await setChartValue(db, c, T(types.mig), mig.id, migRows);
  say(`   ${mig.code} on MIG welding: Structure × MIG weld size, ${migRows.length} rows (min/m)`);

  // Arc: same columns, rows to come.
  const arcSpec = await specOf('ARC_RATE');
  await updateChart(db, c, arcSpec.id, { name: 'Arc welding rate', resultUnit: 'min/m', mode: 'step_up', inputs: [{ level: 'VARIANT' }, { field: 'ARC_WELD_SIZE' }] });
  say('   ARC_RATE on Arc welding: Structure × Arc weld size, no rows yet (the time keeps × 2.8)');

  // Trial assembly days by girder type and span.
  const trialRows = [
    ['composite', 18000, 1.5], ['composite', 36000, 6.5], ['composite', 52000, 11],
    ['bowstring', 18000, 8.5], ['bowstring', 36000, 8.5], ['bowstring', 52000, 8.5],
    ['open_web', 36000, 12], ['open_web', 52000, 12],
  ];
  let trial = await specOf('TRIAL_ASM_DAYS');
  if (!trial) {
    const made = await createChart(db, c, T(types.gantry), { name: 'Trial assembly days', code: 'TRIAL_ASM_DAYS', resultUnit: 'days', mode: 'linear', inputs: [{ field: 'GIRDER_TYPE' }, { field: 'SPAN_LENGTH' }], rows: trialRows });
    trial = await specOf(made.code);
  } else await setChartValue(db, c, T(types.gantry), trial.id, trialRows);
  say(`   ${trial.code} on Gantry crane: Girder type × Span length, ${trialRows.length} rows (days)`);

  // Blasting, per piece, "big": 20 + 15 + 10 min for the three passes.
  const blastRows = [[1, 20], [2, 35], [3, 45]];
  let blast = await specOf('BLAST_TIME');
  if (!blast) {
    const made = await createChart(db, c, T(types.blast), { name: 'Blasting time', code: 'BLAST_TIME', resultUnit: 'min', mode: 'step_up', inputs: [{ field: 'COATS' }], rows: blastRows });
    blast = await specOf(made.code);
  } else await setChartValue(db, c, T(types.blast), blast.id, blastRows);
  say(`   ${blast.code} on Automatic blasting: Coats, 3 rows (min)`);

  // ---------------------------------------------------------------- values
  say('\n2. Values');
  if (!(await specOf('HOLE_DRILL_THICKNESS'))) {
    await createSpec(db, c, { code: 'HOLE_DRILL_THICKNESS', name: 'Hole drilling thickness', dataType: 'number', defaultUom: 'mm', measurementType: 'LENGTH', decimals: 2, description: 'The thickness drilled through (e.g. splice plate + girder); over 50 mm the holes are marked first.' });
    say('   new piece value HOLE_DRILL_THICKNESS (mm)');
  } else say('   HOLE_DRILL_THICKNESS already there');
  let dry = await specOf('PAINT_DRY_TIME');
  if (!dry) {
    await createSpec(db, c, { code: 'PAINT_DRY_TIME', name: 'Paint drying time between coats', dataType: 'number', defaultUom: 'min', decimals: 0, description: 'Touch dry, 1–2 h.' });
    dry = await specOf('PAINT_DRY_TIME');
  }
  if (!(await one("SELECT id FROM cf_spec_assignments WHERE company_id = ? AND specification_id = ? AND subject_type = 'classification' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, dry.id, types.paint]))) {
    await db.query("INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, sort_order) VALUES (?, ?, 'classification', ?, 'item', 0, 1, 'defaulted', 50)", [COMPANY, dry.id, types.paint]);
  }
  await setValues(db, c, 'classification', types.paint, [{ specificationId: dry.id, value: 90 }]);
  say('   PAINT_DRY_TIME = 90 min on Airless paint sprayer');

  // ---------------------------------------------------------------- times
  say('\n3. Times (min per piece)');
  const mandrill = (holes, transfers) => `item.${holes} * (machine.MANUAL_DRILL_TIME + IF(item.HOLE_DRILL_THICKNESS > 50, machine.MARK_TIME, 0))${transfers ? ' + item.HOLE_TRANSFERS * 1.5' : ''}`;
  const TIMES = {
    'CNCP-CUT': { work: 'item.CUT_LENGTH / machine.CUT_SPEED + item.PIERCINGS * machine.PIERCE_TIME / 60' },
    'CG-GASCUT': { work: 'item.CUT_LENGTH / machine.GAS_CUT_SPEED' },
    'CG-HBFIT': { work: '133 * item.LENGTH / 1000 / 19', setup: '60' },
    'CG-SAWWELD': { work: 'item.SAW_WELD_LENGTH * machine.SAW_RATE / 60' },
    'CG-LINEMATCH': { work: 'item.LINEMATCH_JOINTS * 360' },
    'CG-CNCDRILL': { work: 'item.HOLES * machine.CNC_DRILL_TIME / 60' },
    'CG-MANDRILL': { work: mandrill('HOLES', true) },
    'CG-MANDRILL-TOP': { work: mandrill('HOLES_TOP') },
    'CG-MANDRILL-BOTTOM': { work: mandrill('HOLES_BOTTOM') },
    'CG-MANDRILL-INNER': { work: mandrill('HOLES_INNER') },
    'CG-STIFFFIT': { work: 'item.STIFFENERS * 17.5' },
    'CG-STIFFFIT-2': { work: 'item.STIFFENERS_AFTER_FLIP * 17.5' },
    'CG-MIGWELD': { work: `item.MIG_WELD_LENGTH * machine.${mig.code}` },
    'CG-TRIALASM': { work: `machine.${trial.code} * 720` },
    'CG-DISMANTLE': { work: `0.5 * machine.${trial.code} * 720` },
    'CG-STUDWELD': { work: 'item.STUDS * machine.STUD_TIME / 60' },
    'CG-METALLIZE': { work: 'item.SURFACE_AREA * machine.METAL_RATE * item.METALLISE_COATS' },
    'CG-PAINT': { work: 'item.SURFACE_AREA * machine.PAINT_RATE * item.PAINT_COATS + (item.PAINT_COATS - 1) * machine.PAINT_DRY_TIME' },
    'CG-BLAST': { work: `machine.${blast.code} + 17.5` },
  };
  for (const [code, t] of Object.entries(TIMES)) {
    const op = await one('SELECT id FROM cf_operations WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (!op) { say(`   ! ${code}: no such operation`); continue; }
    const rules = await listTimingRules(db, COMPANY, op.id);
    const rule = rules.find((r) => r.subject.type === 'classification') ?? rules[0];
    if (!rule) { say(`   ! ${code}: no rule (no machine type) — not set`); continue; }
    await updateTimingRule(db, c, rule.id, { workExpression: t.work, ...(t.setup != null ? { setupExpression: t.setup } : {}) });
    const shown = (await listTimingRules(db, COMPANY, op.id)).find((r) => r.id === rule.id);
    say(`   ${code.padEnd(19)} ${shown.work.display ?? shown.work.expression}${t.setup ? `   | setup ${t.setup}` : ''}`);
  }
  const brace = await one('SELECT o.id FROM cf_operations o WHERE o.company_id = ? AND o.code = ? AND o.deleted_at IS NULL', [COMPANY, 'CG-BRACEFIT']);
  if (brace && !(await listTimingRules(db, COMPANY, brace.id)).length) say('   ! CG-BRACEFIT (X-frame fit-up, 240 min) has no machine type — give it one and set 240');

  // ---------------------------------------------------------------- check
  say('\n4. Worked out on a machine of each type (typed values)');
  const { checkForBuilder } = await import('../../apps/cf_erp/services/formulaBuilderService.js');
  const { chartBindings } = await import('../../apps/cf_erp/services/chartService.js');
  const { expandCharts } = await import('../../apps/cf_erp/lib/chartFormula.js');
  const bindings = await chartBindings(db, COMPANY);
  const machineOf = async (type) => Number((await one('SELECT id FROM cf_machines WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY, type])).id);
  const trials = [
    ['CNC drill 10 holes, 26 mm, 35 thick', types.drill, `item.HOLES * machine.CNC_DRILL_TIME / 60`, { 'item.HOLES': 10, 'item.HOLE_DIA': 26, 'item.THICKNESS': 35 }, 10 * (120 + 210) / 2 / 60],
    ['CNC drill 30 mm hole (sheet: x after 26)', types.drill, `item.HOLES * machine.CNC_DRILL_TIME / 60`, { 'item.HOLES': 10, 'item.HOLE_DIA': 30, 'item.THICKNESS': 20 }, null],
    ['Blasting 2 coats', types.blast, `machine.${blast.code} + 17.5`, { 'item.COATS': 2 }, 52.5],
  ];
  for (const [label, type, expr, sample, expect] of trials) {
    const out = await checkForBuilder(db, COMPANY, { expression: expandCharts(expr, bindings), machineId: await machineOf(type), sample });
    const r = out.result ?? {};
    say(`   ${label}: ${r.value ?? (r.missing ?? [r.error]).join(' | ')}${expect != null ? `  (expected ${+expect.toFixed(3)})` : ''}${r.notes ? `  [${r.notes.join('; ')}]` : ''}`);
  }

  if (APPLY) { await db.commit(); say('\nCOMMITTED'); } else { await db.rollback(); say('\nDRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message, err.problems ? JSON.stringify(err.problems) : '');
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
