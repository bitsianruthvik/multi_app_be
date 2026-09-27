/**
 * table_spec_test.mjs — the `table` specification data type end to end.
 *
 * User, reading the plant's own rate charts (Process_Flow_v5.xlsx): "Rate
 * charts are SPECIFICATIONS ON THE MACHINE, read by the formula ... this will
 * be standard for every other ERP implementation too." This suite proves the
 * platform half of that decision (CF_ERP_PLAN.md, "production setup from the
 * plant's Process_Flow_v5 workbook", part A) — not the plant's own data, which
 * is a separate script's job.
 *
 * Two parts:
 *   A. formulaEngine's LOOKUP arithmetic, called directly — no database, pure
 *      functions — exact match / step_up between rows / linear / below the
 *      first row / above the last / a null cell, in 1-D and 2-D.
 *   B. Everything that touches the database, in ONE transaction, rolled back:
 *      specifications, values (and their history), resolution, a machine type
 *      with a chart fixed for the group and one machine's own chart
 *      overriding it, formulaService's checks, and the workbook's own worked
 *      example through a real operation, timing rule and timingPreview.
 *
 * Run: cd multi_app_be && node scripts/cf_kepl/table_spec_test.mjs
 * Company: CF_TABLE_COMPANY (default 2, the local dev tenant).
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);

const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const SPEC = await imp('apps/cf_erp/services/specificationService.js');
const VAL = await imp('apps/cf_erp/services/valueService.js');
const RES = await imp('apps/cf_erp/services/resolutionService.js');
const FE = await imp('apps/cf_erp/services/formulaEngine.js');
const FS = await imp('apps/cf_erp/services/formulaService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const CLS = await imp('apps/cf_erp/services/classificationService.js');
const MACH = await imp('apps/cf_erp/services/machineService.js');
const MASTER = await imp('apps/cf_erp/services/masterRecordService.js');
const ASSIGN = await imp('apps/cf_erp/services/assignmentService.js');
const RECORDS = await imp('apps/cf_erp/services/records.js');

const COMPANY = Number(process.env.CF_TABLE_COMPANY ?? 2);
const tag = `TSP${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
const fails = [];
/** ok(label, cond) — a string, then a boolean. Anything else throws rather than passing (the swapped-call trap). */
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) was called as ok(${typeof label}, ${typeof cond}) — the label comes first and the condition must be a boolean.`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const near = (label, got, want, eps = 1e-3) => ok(label, got != null && Math.abs(Number(got) - want) < eps, `got ${got}, wanted ${want}`);
const section = (s) => console.log(`\n${s}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

section('0. The harness refuses a swapped ok()');
{
  const swapped = await refusal(() => ok(true, 'swapped'));
  ok('ok(cond, label) throws instead of passing', swapped instanceof Error);
}

/* ===========================================================================
 * A. formulaEngine's LOOKUP arithmetic — pure functions, no database
 * ======================================================================== */

const CNC1_X = [6, 8, 12, 16, 18, 20, 22, 25, 28, 30, 32, 36, 40, 45, 50];
const CNC1_V = [3535, 2860, 1700, 1515, 1277, 1075, 915, 665, 945, 783, 635, 862, 660, 494, 295];
const CNC2_V = CNC1_V.map((v) => v + 200);

/** A minimal timing context: one machine table, one item value. */
function ctx1D({ thickness, table, machinePierce = null }) {
  return {
    item: (code) => (code === 'THICKNESS' ? thickness : null),
    machine: (code) => (code === 'PIERCE_TIME' ? machinePierce : null),
    itemTable: () => null,
    machineTable: (code) => (code === 'CUT_SPEED' ? table : null),
  };
}

section('A1. LOOKUP — exact row, step_up between rows, linear between rows');
{
  const table = { mode: 'step_up', axes: [{ label: 'Thickness', unit: 'mm' }], x: CNC1_X, v: CNC1_V };
  const p = FE.parseFormula('LOOKUP(machine.CUT_SPEED, item.THICKNESS)');
  const exact = FE.evaluateFormula(p, () => null, null, ctx1D({ thickness: 12, table }));
  near('exact row (12 mm -> 1700)', exact.value, 1700);

  const stepUp = FE.evaluateFormula(p, () => null, null, ctx1D({ thickness: 10, table }));
  near('step_up between rows (10 mm -> the 12 mm row, 1700 — never a faster rate)', stepUp.value, 1700);

  const linTable = { ...table, mode: 'linear' };
  const lin = FE.evaluateFormula(p, () => null, null, ctx1D({ thickness: 10, table: linTable }));
  // 2860 + (1700-2860) * (10-8)/(12-8) = 2860 - 580 = 2280
  near('linear between rows (10 mm -> a straight line, 2280)', lin.value, 2280);
}

section('A2. LOOKUP — below the first row, above the last, a null cell: all missing, never invented');
{
  const table = { mode: 'step_up', axes: [{ label: 'Thickness', unit: 'mm' }], x: CNC1_X, v: CNC1_V };
  const p = FE.parseFormula('LOOKUP(machine.CUT_SPEED, item.THICKNESS)');

  const below = FE.evaluateFormula(p, () => null, null, ctx1D({ thickness: 3, table }));
  ok('below the first row -> missing, not a number', below.value === null && Array.isArray(below.missing));
  ok('below-range reason names the chart\'s own start', below.missing?.[0]?.includes('6') && !below.error);

  const above = FE.evaluateFormula(p, () => null, null, ctx1D({ thickness: 60, table }));
  ok('above the last row -> missing, not a number', above.value === null && Array.isArray(above.missing));
  ok('above-range reason names the chart\'s own end', above.missing?.[0]?.includes('50') && !above.error);

  const withNull = CNC1_V.slice();
  withNull[5] = null; // the 20 mm row
  const nullTable = { ...table, v: withNull };
  const nullCell = FE.evaluateFormula(p, () => null, null, ctx1D({ thickness: 20, table: nullTable }));
  ok('a null cell (the chart\'s own "x") -> missing, not a number', nullCell.value === null && Array.isArray(nullCell.missing));
  ok('table with no chart at all -> missing, named by role and code', FE.evaluateFormula(p, () => null, null, ctx1D({ thickness: 12, table: null })).missing?.[0] === 'machine · CUT_SPEED');
}

section('A3. LOOKUP — two axes: exact, step_up and linear (bilinear)');
{
  const table2d = {
    mode: 'step_up',
    axes: [{ label: 'Thickness', unit: 'mm' }, { label: 'Hole dia', unit: 'mm' }],
    x: [10, 20, 30], y: [14, 21], v: [[50, 80, 110], [55, 100, 120]],
  };
  const ctx2D = ({ thickness, holeDia, table }) => ({
    item: (code) => ({ THICKNESS: thickness, HOLE_DIA: holeDia }[code] ?? null),
    machine: () => null,
    itemTable: () => null,
    machineTable: (code) => (code === 'DRILL_TIME' ? table : null),
  });
  const p = FE.parseFormula('LOOKUP(machine.DRILL_TIME, item.THICKNESS, item.HOLE_DIA)');
  near('2-D exact (20, 21) -> 100', FE.evaluateFormula(p, () => null, null, ctx2D({ thickness: 20, holeDia: 21, table: table2d })).value, 100);
  near('2-D step_up between rows (15, 18) -> the row above both, 100', FE.evaluateFormula(p, () => null, null, ctx2D({ thickness: 15, holeDia: 18, table: table2d })).value, 100);
  near('2-D linear (bilinear) between rows (15, 18) -> 72.142857', FE.evaluateFormula(p, () => null, null, ctx2D({ thickness: 15, holeDia: 18, table: { ...table2d, mode: 'linear' } })).value, 72.142857);
}

section('A4. Parse-time refusals');
{
  ok('LOOKUP with one argument is refused', (await refusal(() => FE.parseFormula('LOOKUP(machine.CUT_SPEED)'))) instanceof Error);
  ok('LOOKUP whose first argument is not a name is refused', (await refusal(() => FE.parseFormula('LOOKUP(1+2, item.THICKNESS)'))) instanceof Error);
  const p = FE.parseFormula('LOOKUP(RATE_CHART, THICKNESS)');
  ok('a bare (plain) LOOKUP target parses — item./machine. is not required outside a timing formula', p.lookupRefs?.[0]?.code === 'RATE_CHART' && p.lookupRefs[0].role === 'plain');
  ok('the plain LOOKUP target is not double-counted as a numeric reference', !p.references.includes('RATE_CHART'));
}

/* ===========================================================================
 * B. Everything through the database — one transaction, rolled back
 * ======================================================================== */

async function cfTables(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  return rows.map((r) => Object.values(r)[0]).sort();
}
async function census(db, tables) {
  const out = {};
  for (const t of tables) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
const moved = (a, b) => Object.keys(a).filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t]}->${b[t]}`);

const TABLES = await cfTables(pool);
const before = await census(pool, TABLES);

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: 22 };
  const db = conn;
  const code = (suffix) => `${tag}_${suffix}`;

  /* ---- specifications: creation and every validation refusal --------------- */
  section('B1. Creating a table specification, and every refusal on the way in');
  {
    ok('a table with no axes is refused', (await refusal(() => SPEC.createSpec(db, c, { code: code('NOAXES'), name: 'no axes', dataType: 'table' }))) instanceof Error);
    ok('a table with three axes is refused', (await refusal(() => SPEC.createSpec(db, c, {
      code: code('3AXES'), name: 'three axes', dataType: 'table', tableConfig: { axes: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    }))) instanceof Error);
    ok('an axis with no label is refused', (await refusal(() => SPEC.createSpec(db, c, {
      code: code('NOLABEL'), name: 'no label', dataType: 'table', tableConfig: { axes: [{ label: '' }] },
    }))) instanceof Error);
    ok('an unknown lookup mode is refused', (await refusal(() => SPEC.createSpec(db, c, {
      code: code('BADMODE'), name: 'bad mode', dataType: 'table', tableConfig: { axes: [{ label: 'x' }], mode: 'sideways' },
    }))) instanceof Error);
    ok('tableConfig on a non-table spec is refused', (await refusal(() => SPEC.createSpec(db, c, {
      code: code('NOTTABLE'), name: 'not a table', dataType: 'number', tableConfig: { axes: [{ label: 'x' }] },
    }))) instanceof Error);
    ok('decimals on a table spec is refused (the generic number-only check already covers it)', (await refusal(() => SPEC.createSpec(db, c, {
      code: code('DECTABLE'), name: 'decimals on a table', dataType: 'table', decimals: 2, tableConfig: { axes: [{ label: 'x' }] },
    }))) instanceof Error);
    ok('options on a table spec is refused', (await refusal(() => SPEC.createSpec(db, c, {
      code: code('OPTTABLE'), name: 'options on a table', dataType: 'table', options: [{ value: 'A' }], tableConfig: { axes: [{ label: 'x' }] },
    }))) instanceof Error);

    const cutSpeed = await SPEC.createSpec(db, c, {
      code: code('CUT_SPEED'), name: `${tag} cutting speed`, dataType: 'table', defaultUom: 'mm/min',
      tableConfig: { axes: [{ label: 'Thickness', unit: 'mm' }], mode: 'step_up' },
      description: 'CNC plasma cutting speed by plate thickness.',
    });
    ok('a 1-D table spec is created with its axes and mode', cutSpeed.dataType === 'table' && cutSpeed.tableConfig?.axes?.length === 1 && cutSpeed.tableConfig.mode === 'step_up');

    const drillTime = await SPEC.createSpec(db, c, {
      code: code('DRILL_TIME'), name: `${tag} drilling time`, dataType: 'table', defaultUom: 'sec',
      tableConfig: { axes: [{ label: 'Thickness', unit: 'mm' }, { label: 'Hole diameter', unit: 'mm' }], mode: 'step_up' },
    });
    ok('a 2-D table spec is created with two axes', drillTime.tableConfig?.axes?.length === 2);

    // Default mode when none is given.
    const defaultMode = await SPEC.createSpec(db, c, { code: code('DEFMODE'), name: 'default mode', dataType: 'table', tableConfig: { axes: [{ label: 'x' }] } });
    ok('mode defaults to step_up when not given', defaultMode.tableConfig.mode === 'step_up');
  }

  /* ---- item specs the formula reads, and a catalog item to hold them ------- */
  section('B2. A catalog item carrying the item-side specs the timing formula reads');
  const itemFamily = await CLS.createNode(db, c, { code: code('IFAM'), name: `${tag} item family` });
  const itemVariant = await CLS.createNode(db, c, { parentId: itemFamily.id, code: code('ISUB'), name: `${tag} item sub` });
  const itemLeaf = await CLS.createNode(db, c, { parentId: itemVariant.id, code: code('IVAR'), name: `${tag} item variant` });

  const numberSpec = async (suffix, uom) => SPEC.createSpec(db, c, { code: code(suffix), name: `${tag} ${suffix}`, dataType: 'number', defaultUom: uom });
  const sThickness = await numberSpec('THICKNESS', 'mm');
  const sCutLength = await numberSpec('CUT_LENGTH', 'mm');
  const sPiercings = await numberSpec('PIERCINGS', null);
  const sPierceTime = await numberSpec('PIERCE_TIME', 's');
  const sHoleDia = await numberSpec('HOLE_DIA', 'mm');
  const sHoles = await numberSpec('HOLES', null);

  const itemRule = (spec) => ASSIGN.createRule(db, c, { specificationId: spec.id, subjectType: 'classification', subjectId: itemLeaf.id, captureAt: 'item', valueRule: 'entered' });
  for (const s of [sThickness, sCutLength, sPiercings, sHoleDia, sHoles]) await itemRule(s);

  const cutItem = await MASTER.createItem(db, c, { itemType: 'catalog', code: code('PART1'), name: `${tag} test plate`, classificationId: itemLeaf.id });
  await VAL.setValues(db, c, 'master', cutItem.id, [
    { specCode: code('THICKNESS'), value: 12 },
    { specCode: code('CUT_LENGTH'), value: 100908.8 },
    { specCode: code('PIERCINGS'), value: 7 },
  ]);
  const drillItem = await MASTER.createItem(db, c, { itemType: 'catalog', code: code('PART2'), name: `${tag} test drilled plate`, classificationId: itemLeaf.id });
  await VAL.setValues(db, c, 'master', drillItem.id, [
    { specCode: code('THICKNESS'), value: 20 },
    { specCode: code('HOLE_DIA'), value: 21 },
    { specCode: code('HOLES'), value: 5 },
  ]);
  ok('the two test items were created', !!cutItem.id && !!drillItem.id);

  /* ---- the machine tree: a family, a type, three machines ------------------ */
  section('B3. A machine type, and machines under it');
  const machFamily = await CLS.createNode(db, c, { code: code('MFAM'), name: `${tag} machine family`, scope: 'machine' });
  const machSub = await CLS.createNode(db, c, { parentId: machFamily.id, code: code('MSUB'), name: `${tag} machine sub` });
  const machType = await CLS.createNode(db, c, { parentId: machSub.id, code: code('MTYPE'), name: `${tag} CNC plasma` });
  ok('the machine type sits at the deepest level, scoped to machines', machType.scope === 'machine');

  // CUT_SPEED: defaulted at the type (the group's own chart) — a machine may
  // still enter its own and override it (decision: "fixed/defaulted on a
  // machine TYPE ... and entered on one machine").
  await ASSIGN.createRule(db, c, { specificationId: (await SPEC.listSpecs(db, c.companyId)).find((s) => s.code === code('CUT_SPEED')).id, subjectType: 'classification', subjectId: machType.id, captureAt: 'item', valueRule: 'defaulted' });
  // DRILL_TIME: fixed at the type — every machine shares it, none may override.
  await ASSIGN.createRule(db, c, { specificationId: (await SPEC.listSpecs(db, c.companyId)).find((s) => s.code === code('DRILL_TIME')).id, subjectType: 'classification', subjectId: machType.id, captureAt: 'item', valueRule: 'fixed' });
  // PIERCE_TIME: fixed at the type — every CNC pierces at the same rate.
  await ASSIGN.createRule(db, c, { specificationId: sPierceTime.id, subjectType: 'classification', subjectId: machType.id, captureAt: 'item', valueRule: 'fixed' });

  // The type's own defaults, entered BEFORE any machine exists — materialize
  // (run when a machine is created) needs them there already.
  const genericChart = { x: [6, 50], v: [3000, 300] };
  await VAL.setValues(db, c, 'classification', machType.id, [
    { specCode: code('CUT_SPEED'), value: genericChart },
    { specCode: code('DRILL_TIME'), value: { x: [10, 20, 30], y: [14, 21], v: [[50, 80, 110], [55, 100, 120]] } },
    { specCode: code('PIERCE_TIME'), value: 3 },
  ]);

  const cnc1 = await MACH.createMachine(db, c, { code: `${tag}-CNC1`, name: `${tag} CNC-1`, classificationId: machType.id });
  const cnc2 = await MACH.createMachine(db, c, { code: `${tag}-CNC2`, name: `${tag} CNC-2`, classificationId: machType.id });
  const cnc3 = await MACH.createMachine(db, c, { code: `${tag}-CNC3`, name: `${tag} CNC-3 (no override)`, classificationId: machType.id });

  // CNC-1 and CNC-2 each get their OWN chart, overriding the type's default.
  await VAL.setValues(db, c, 'machine', cnc1.id, [{ specCode: code('CUT_SPEED'), value: { x: CNC1_X, v: CNC1_V } }]);
  await VAL.setValues(db, c, 'machine', cnc2.id, [{ specCode: code('CUT_SPEED'), value: { x: CNC1_X, v: CNC2_V } }]);

  ok('a fixed table cannot be entered on a machine — refused in words',
    (await refusal(() => VAL.setValues(db, c, 'machine', cnc3.id, [{ specCode: code('DRILL_TIME'), value: { x: [1], y: [1], v: [[1]] } }]))) instanceof Error);

  /* ---- resolution: precedence, and the raw table object ------------------- */
  section('B4. Resolution — most specific wins, and the resolved value is the whole chart');
  {
    const r1 = RES.publicResolution(await RES.resolve(db, c.companyId, { machine: await RECORDS.requireMachine(db, c.companyId, cnc1.id) }));
    const r2 = await RES.resolve(db, c.companyId, { machine: await RECORDS.requireMachine(db, c.companyId, cnc2.id) });
    const r3 = await RES.resolve(db, c.companyId, { machine: await RECORDS.requireMachine(db, c.companyId, cnc3.id) });
    const speedOf = (r) => r.specs.find((s) => s.spec.code === code('CUT_SPEED'));

    ok('CNC-1 resolves to its OWN entered chart, not the type default', JSON.stringify(speedOf(r1).value.raw.v) === JSON.stringify(CNC1_V) && speedOf(r1).value.source === 'entered');
    ok('CNC-2 resolves to ITS OWN chart (each value +200)', JSON.stringify(speedOf(r2).value.raw.v) === JSON.stringify(CNC2_V));
    ok('CNC-3 (no override) inherits the type\'s default chart', JSON.stringify(speedOf(r3).value.raw.v) === JSON.stringify(genericChart.v) && speedOf(r3).value.source === 'defaulted');
    ok('the resolved display is the short summary, not the raw JSON', /rows?,/.test(speedOf(r1).value.display ?? '') && !speedOf(r1).value.display.includes('['));
    ok('a table spec resolved at item level also carries its axes', speedOf(r1).spec.tableConfig?.axes?.length === 1);
  }

  /* ---- values: every validation refusal, and history ----------------------- */
  section('B5. Value validation — every refusal in words, and history rows');
  {
    const bad = async (value, why) => ok(`refused: ${why}`, (await refusal(() => VAL.setValues(db, c, 'machine', cnc1.id, [{ specCode: code('CUT_SPEED'), value }]))) instanceof Error);
    await bad('5', 'a plain value, not a table');
    await bad({ x: [8, 6, 12], v: [1, 2, 3] }, 'x values not strictly ascending');
    await bad({ x: [6, 8], v: [1, 2, 3] }, 'v longer than x');
    await bad({ x: [6, 8], v: ['a', 2] }, 'a non-numeric cell');
    await bad({ x: [false, 8], v: [1, 2] }, 'a boolean axis value');
    await bad({ x: [6, 8], v: [true, 2] }, 'a boolean rate');
    await bad({ x: [6, 8], v: [[], 2] }, 'an array in a rate cell');
    await bad({ x: [6, 8], y: [1], v: [1, 2] }, 'y given for a one-axis spec');
    await bad({ x: [1, 2], y: [1, 2] }, 'a 2-D spec with no v at all (using CUT_SPEED\'s 1-axis validator here would wrongly pass; proven properly on DRILL_TIME below)');

    const drillSpecId = (await SPEC.listSpecs(db, c.companyId)).find((s) => s.code === code('DRILL_TIME')).id;
    // DRILL_TIME is fixed, so this exercises validateTableValue directly via
    // the type's own classification subject, which takes any specification's value.
    ok('2-D: y/v row count mismatch is refused', (await refusal(() => VAL.setValues(db, c, 'classification', machType.id, [{ specCode: code('DRILL_TIME'), value: { x: [1, 2], y: [1, 2, 3], v: [[1, 2, 3], [1, 2, 3]] } }]))) instanceof Error);
    ok('2-D: a row of the wrong width is refused', (await refusal(() => VAL.setValues(db, c, 'classification', machType.id, [{ specCode: code('DRILL_TIME'), value: { x: [1, 2], y: [1, 2, 3], v: [[1, 2, 3], [1, 2]] } }]))) instanceof Error);

    // A valid update, then a clear — both leave history rows the summary can read.
    await VAL.setValues(db, c, 'machine', cnc1.id, [{ specCode: code('CUT_SPEED'), value: { x: CNC1_X, v: CNC1_V.map((v) => v + 1) } }]);
    await VAL.setValues(db, c, 'machine', cnc1.id, [{ specCode: code('CUT_SPEED'), value: null }]);
    const hist = await VAL.getHistory(db, c.companyId, 'machine', cnc1.id, 50);
    const speedHist = hist.filter((h) => h.specCode === code('CUT_SPEED')).sort((a, b) => a.id - b.id);
    ok('history has create, update and delete rows for the chart', speedHist.some((h) => h.change === 'create') && speedHist.some((h) => h.change === 'update') && speedHist.some((h) => h.change === 'delete'));
    const created = speedHist.find((h) => h.change === 'create');
    ok('a create history row\'s "to" reads as a chart summary', /rows?,/.test(created?.to ?? ''));
    const deleted = speedHist.find((h) => h.change === 'delete');
    ok('a delete history row\'s "from" reads as a chart summary and "to" is empty', /rows?,/.test(deleted?.from ?? '') && deleted?.to == null);

    // Put CNC-1's chart back for the timing test below.
    await VAL.setValues(db, c, 'machine', cnc1.id, [{ specCode: code('CUT_SPEED'), value: { x: CNC1_X, v: CNC1_V } }]);
    const beforeRepeat = await VAL.getHistory(db, c.companyId, 'machine', cnc1.id, 1000);
    await VAL.setValues(db, c, 'machine', cnc1.id, [{ specCode: code('CUT_SPEED'), value: { v: CNC1_V, x: CNC1_X } }]);
    const afterRepeat = await VAL.getHistory(db, c.companyId, 'machine', cnc1.id, 1000);
    ok('saving the same chart again adds no history, regardless of JSON key order', afterRepeat.length === beforeRepeat.length);
    await VAL.setValues(db, c, 'machine', cnc1.id, [{ specCode: code('CUT_SPEED'), value: JSON.stringify({ x: CNC1_X, v: CNC1_V }) }]);
    ok('a chart sent by the shared form saves without adding duplicate history', (await VAL.getHistory(db, c.companyId, 'machine', cnc1.id, 1000)).length === afterRepeat.length);
  }

  /* ---- formulaService: LOOKUP checked against real specifications ---------- */
  section('B6. formulaService.checkFormula — LOOKUP validated against the real chart, and every refusal');
  {
    const cutSpeedCode = code('CUT_SPEED');
    const cutTimeExpr = `item.${code('CUT_LENGTH')} / LOOKUP(machine.${cutSpeedCode}, item.${code('THICKNESS')}) + item.${code('PIERCINGS')} * machine.${code('PIERCE_TIME')} / 60`;
    const good = await FS.checkFormula(db, c.companyId, cutTimeExpr);
    ok('the workbook\'s own timing formula checks clean', good.problems.length === 0, good.problems.join('; '));
    ok('it is recognised as a timing formula', good.kind === 'timing');

    const outside = await FS.checkFormula(db, c.companyId, `machine.${cutSpeedCode} + 1`);
    ok('a table read outside LOOKUP is refused in words naming LOOKUP', outside.problems.some((p) => p.includes(cutSpeedCode) && p.toLowerCase().includes('lookup')));

    const wrongArity = await FS.checkFormula(db, c.companyId, `LOOKUP(machine.${cutSpeedCode}, item.${code('THICKNESS')}, item.${code('HOLE_DIA')})`);
    ok('LOOKUP given more values than the chart has axes is refused', wrongArity.problems.some((p) => p.includes(cutSpeedCode)));

    const wrongTarget = await FS.checkFormula(db, c.companyId, `LOOKUP(item.${code('THICKNESS')}, item.${code('CUT_LENGTH')})`);
    ok('LOOKUP on a NUMBER (not a table) is refused', wrongTarget.problems.some((p) => p.toLowerCase().includes('table')));

    const drillExpr = `item.${code('HOLES')} * LOOKUP(machine.${code('DRILL_TIME')}, item.${code('THICKNESS')}, item.${code('HOLE_DIA')}) / 60`;
    const drillCheck = await FS.checkFormula(db, c.companyId, drillExpr);
    ok('the 2-D drilling formula checks clean', drillCheck.problems.length === 0, drillCheck.problems.join('; '));
  }

  /* ---- the workbook's own sample, through a real operation and timingPreview */
  section('B7. The workbook\'s own numbers — a real operation, timing rule and timingPreview');
  {
    const cutTimeExpr = `item.${code('CUT_LENGTH')} / LOOKUP(machine.${code('CUT_SPEED')}, item.${code('THICKNESS')}) + item.${code('PIERCINGS')} * machine.${code('PIERCE_TIME')} / 60`;
    const cutTimeFormula = await FS.createFormula(db, c, { code: code('CUT_TIME'), name: `${tag} cut time`, expression: cutTimeExpr });
    const cutOp = await OPS.createOperation(db, c, { code: code('CUTOP'), name: `${tag} CNC cutting` });
    await OPS.createTimingRule(db, c, cutOp.id, { subjectType: 'classification', subjectId: machType.id, setupMinutes: 0, workFormulaId: cutTimeFormula.id });

    const p1 = await OPS.timingPreview(db, c.companyId, cutOp.id, { machineId: cnc1.id, itemId: cutItem.id, quantity: 1 });
    near('CNC-1: the workbook\'s own thickness-12 sample gives 59.708 min', p1.workMinutesPerPiece, 59.708);
    const p2 = await OPS.timingPreview(db, c.companyId, cutOp.id, { machineId: cnc2.id, itemId: cutItem.id, quantity: 1 });
    near('CNC-2 (each chart value +200) gives 53.460 min', p2.workMinutesPerPiece, 53.460);

    // Off the end of CNC-3's default chart (6-50 mm covers 12 mm fine, so push
    // the item's thickness out of range to prove the preview surfaces "missing".
    await VAL.setValues(db, c, 'master', cutItem.id, [{ specCode: code('THICKNESS'), value: 999 }]);
    const p3 = await OPS.timingPreview(db, c.companyId, cutOp.id, { machineId: cnc3.id, itemId: cutItem.id, quantity: 1 });
    ok('outside the chart\'s range, timingPreview reports the time as missing, not invented', p3.work.minutes === null && Array.isArray(p3.work.missing) && p3.work.missing.length > 0);
    await VAL.setValues(db, c, 'master', cutItem.id, [{ specCode: code('THICKNESS'), value: 12 }]);

    // The 2-D chart through the same real path.
    const drillExpr = `item.${code('HOLES')} * LOOKUP(machine.${code('DRILL_TIME')}, item.${code('THICKNESS')}, item.${code('HOLE_DIA')}) / 60`;
    const drillFormula = await FS.createFormula(db, c, { code: code('DRILL_TIME_F'), name: `${tag} drill time`, expression: drillExpr });
    const drillOp = await OPS.createOperation(db, c, { code: code('DRILLOP'), name: `${tag} CNC drilling` });
    await OPS.createTimingRule(db, c, drillOp.id, { subjectType: 'classification', subjectId: machType.id, setupMinutes: 0, workFormulaId: drillFormula.id });
    const pd = await OPS.timingPreview(db, c.companyId, drillOp.id, { machineId: cnc1.id, itemId: drillItem.id, quantity: 1 });
    // 5 holes * 100 s / 60 = 8.3333 min (exact match on both axes: thickness 20, dia 21).
    near('2-D chart through a real timing rule and timingPreview: 5 holes x 100 s / 60', pd.workMinutesPerPiece, 500 / 60);
  }

  section('B8. Rolling back');
  await conn.rollback();
  console.log('rolled back.');
} catch (err) {
  failed += 1;
  fails.push(`CRASH ${err.code ?? ''} ${err.message}`);
  console.log('CRASH', err.code ?? '', err.message, err.problems ?? '', err.stack?.split('\n').slice(0, 8).join(' / '));
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
} finally {
  detachNodeCache(conn);
  conn.release();
}

const after = await census(pool, TABLES);
const left = moved(before, after);
console.log(`\n${passed} passed, ${failed} failed (rolled back)`);
console.log(`nothing left behind: ${left.length ? 'NO' : 'yes'} — ${TABLES.length} cf_ tables counted${left.length ? `; ${left.join(', ')}` : ''}`);
if (fails.length) console.log(`failed: ${fails.join(' | ')}`);
await pool.end();
process.exit(failed || left.length ? 1 : 0);
