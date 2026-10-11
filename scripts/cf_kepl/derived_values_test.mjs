/**
 * derived_values_test.mjs — values that come from the drawing and from the parts (2026-10-12).
 *
 *   1  the formula language: FIRST, NONZERO, CONTAINS / AND / OR / NOT, children told apart by words,
 *      IF per child inside a roll-up, and what a formula waits for;
 *   2  the rule: a Defaulted rule that names a formula — the formula's answer, a typed value over it
 *      (reported with the answer beside it), back again when the typed value goes, equal = no override;
 *   3  a fixture girder of this run's own (order, line, 2 flanges + web + stiffeners on both sides +
 *      studs, under a girder line), the tenant's setup laid on by scripts/cf_kepl/derived-values-setup.mjs:
 *      a plate weighs by its drawing's TRUE area and by its rectangle without one; replacing or deleting
 *      the drawing, or re-sizing the part, refreshes; assemblies follow; every value of the list equals
 *      the hand calculation; override / clear; a frozen line is left alone; the Excel round trip (the
 *      typed mark, the empty cell, the equal number, other typed values untouched); "why these values";
 *      the setup script (dry run changes nothing, a second run changes nothing, no typed value moves);
 *      the compare report; round trips do not grow.
 *
 * Local only, company 2, ONE rolled-back transaction, every cf_ table re-counted.
 *   cd multi_app_be && node scripts/cf_kepl/derived_values_test.mjs
 */
import { spawnSync } from 'child_process';
import ExcelJS from 'exceljs';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { parseFormula, evaluateFormula } from '../../apps/cf_erp/services/formulaEngine.js';
import { resolve, publicResolution, sameAsCalculated } from '../../apps/cf_erp/services/resolutionService.js';
import { readLineValues, writeLineValues, resolveLineRecords, compareLineValues } from '../../apps/cf_erp/services/orderValuesService.js';
import { loadMaster } from '../../apps/cf_erp/services/records.js';
import { uploadDrawings, deleteDrawing } from '../../apps/cf_erp/services/partDrawingService.js';
import { refreshDrawingValues, holeDiameterOf, factsOfShape, planFacts } from '../../apps/cf_erp/services/drawingValueService.js';
import { withCutPieces } from '../../apps/cf_erp/services/cutPlateService.js';
import { getValueReasons } from '../../apps/cf_erp/services/valueReasonService.js';
import { exportOrderSheet, importOrderSheet, TYPED_MARK } from '../../apps/cf_erp/services/orderSheetService.js';
import { createTimingRule } from '../../apps/cf_erp/services/operationService.js';
import { addStep } from '../../apps/cf_erp/services/flowService.js';
import { createRule, deleteRule, listRules } from '../../apps/cf_erp/services/assignmentService.js';
import { measuresOf, amountOf } from '../../apps/cf_erp/services/priceService.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import * as MR from '../../apps/cf_erp/services/masterRecordService.js';
import * as V from '../../apps/cf_erp/services/valueService.js';
import * as B from '../../apps/cf_erp/services/bomService.js';
import * as SO from '../../apps/cf_erp/services/salesOrderService.js';
import * as PARTIES from '../../apps/cf_erp/modules/parties/service.js';
import { setup, compareOrder, FORMULAS } from './derived-values-setup.mjs';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const COMPANY = 2;
const KEPL_LINE = 923;
let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const near = (a, b, tol = 1e-3) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;

/* ===========================================================================
 * 1. The formula language (no database)
 * ======================================================================== */
console.log('\n  1. the formula language');
const kid = (label, quantity, nums = {}, words = {}) => ({ label, quantity, get: (code) => nums[code] ?? null, word: (code) => words[code] ?? null });
const named = (...names) => ({ names });
const girderKids = ({ far = true } = {}) => [
  kid('TF', 1, { LENGTH: 12000, WIDTH: 500, HOLES: 8 }, { NAME: named('Row TF', 'Top flange', 'TFL') }),
  kid('BF', 1, { LENGTH: 12000, WIDTH: 700, DRAWN_HOLES: 6 }, { NAME: named('Bottom flange') }),
  kid('WEB', 1, { LENGTH: 12000, WIDTH: 2995 }, { NAME: named('Web plate') }),
  kid('IS', 6, { LENGTH: 170, WIDTH: 2995 }, { NAME: named('Intermediate stiffener') }),
  kid('IS2', 4, { LENGTH: 2995, WIDTH: 170 }, { NAME: named('Intermediate stiffener'), ROLE: far ? 'Far side' : null }),
  kid('BS', 2, { LENGTH: 2995, WIDTH: 200 }, { NAME: named('Bearing stiffener') }),
  kid('COVER', 3, { LENGTH: 500, WIDTH: 300, HOLES: 20 }, { NAME: named('Top Flange Outer Cover Plate') }),
  kid('STUD', 120, {}, { NAME: named('Shear stud 25'), VARIANT: { name: 'Shear stud', code: 'SHEAR_STUD' } }),
];
const run = (expression, values = {}, children = null) => evaluateFormula(parseFormula(expression), (code) => values[code] ?? null, children);
const text = (f, u = { length: 1000 }) => (typeof FORMULAS[f].expression === 'function' ? FORMULAS[f].expression(u) : FORMULAS[f].expression);

ok('FIRST takes the first expression that has its values', run('FIRST(TRUE_AREA, LENGTH * WIDTH) * 2', { TRUE_AREA: 10, LENGTH: 3, WIDTH: 4 }).value === 20);
ok('…and the next one where the first has none', run('FIRST(TRUE_AREA, LENGTH * WIDTH) * 2', { LENGTH: 3, WIDTH: 4 }).value === 24);
ok('…waiting for what the LAST one reads when none can be worked out', JSON.stringify(run('FIRST(TRUE_AREA, LENGTH * WIDTH) * 2', { LENGTH: 3 }).missing) === '["WIDTH"]', JSON.stringify(run('FIRST(TRUE_AREA, LENGTH * WIDTH) * 2', { LENGTH: 3 })));
ok('a name read only inside FIRST is not one the formula must have', (() => { const p = parseFormula('FIRST(A, B) * C'); return p.requiredReferences.join() === 'C' && p.references.sort().join() === 'A,B,C'; })());
ok('a name outside FIRST still makes it wait', JSON.stringify(run('FIRST(A, 1) * C', { A: 2 }).missing) === '["C"]');
ok('NONZERO is the number, and no value when it is 0', run('NONZERO(X, "studs")', { X: 5 }).value === 5 && JSON.stringify(run('NONZERO(X, "studs")', { X: 0 }).missing) === '["studs"]');
ok('CONTAINS, AND, OR, NOT are tests (1 or 0)', run('AND(1, NOT(0), OR(0, 1))').value === 1 && run('AND(1, 0)').value === 0 && run('CONTAINS("Top flange", "FLANGE")').value === 1 && run('CONTAINS("Web", "flange")').value === 0);
ok('a child is told by its name or its template\'s — exactly, or by a word in it',
  run('SUM(IF(children.name = "top flange", 1, 0))', {}, girderKids()).value === 1 && run('SUM(IF(children.name = "TFL", 1, 0))', {}, girderKids()).value === 1
  && run('SUM(IF(CONTAINS(children.name, "stiffener"), 1, 0))', {}, girderKids()).value === 12);
ok('…by its place in the tree, and by the description on its BOM line', run('SUM(IF(children.variant = "Shear stud", 1, 0))', {}, girderKids()).value === 120
  && run('SUM(IF(children.variant = "SHEAR_STUD", 1, 0))', {}, girderKids()).value === 120 && run('SUM(IF(CONTAINS(children.role, "far side"), 1, 0))', {}, girderKids()).value === 4);
ok('inside a roll-up IF reads only the branch taken: a child that is not asked needs no value', run('SUM(IF(children.name = "Top flange", children.HOLES, 0))', {}, girderKids()).value === 8);
ok('…a child that IS asked and has none makes it wait, by name', JSON.stringify(run('SUM(IF(CONTAINS(children.name, "web"), children.HOLES, 0))', {}, girderKids()).missing) === '["WEB · HOLES"]');
ok('a roll-up that waits says everything it waits for', run('SUM(children.WEIGHT)', {}, girderKids()).missing.length === 8);
ok('a word that is not there matches nothing (it is not a gap)', run('SUM(IF(children.PART_FUNCTION = "Web", 1, 0))', {}, girderKids()).value === 0);
ok('a child\'s word is not a specification the formula reads', (() => { const p = parseFormula('SUM(IF(children.name = "x", children.HOLES, 0))'); return p.rollupTerms.join() === 'HOLES' && p.childWords.join() === 'NAME' && p.kind === 'rollup'; })());
let threw = null; try { parseFormula('children.name = "x"'); } catch (e) { threw = e.message; }
ok('children.name outside a roll-up is refused when the formula is saved', /inside SUM, COUNT or AVG/.test(threw ?? ''));

// The tenant's formulas (the setup script's own text) on a girder segment, against the hand calculation.
const seg = girderKids();
ok('SAW weld: 2 runs along the long edge of each flange = 4 × 12 m = 48 m (the cover plate is not a flange)', near(run(text('ASSY_SAW_WELD_LENGTH'), {}, seg).value, 48));
ok('…in mm where the value is kept in mm', near(run(text('ASSY_SAW_WELD_LENGTH', { length: 1 }), {}, seg).value, 48000));
// 10 intermediate (2 × 2995 + 4 × 170 = 6670) + 2 bearing (2 × 2995 + 4 × 200 = 6790) = 66700 + 13580 = 80280 mm
ok('MIG weld: per stiffener 2 × long edge + 4 × short edge = 80.28 m', near(run(text('ASSY_MIG_WELD_LENGTH'), {}, seg).value, 80.28));
ok('stiffeners after the flip: the rows that say "far side" (4)', run(text('ASSY_STIFFENERS_AFTER_FLIP'), {}, seg).value === 4);
ok('…where no row says: half of the 12, rounded down (6)', run(text('ASSY_STIFFENERS_AFTER_FLIP'), {}, girderKids({ far: false })).value === 6);
ok('stiffeners: all 12 where the row has no after-flip value', run(text('ASSY_STIFFENERS'), {}, seg).value === 12);
ok('…less the ones after the flip where it has (12 − 4 = 8)', run(text('ASSY_STIFFENERS'), { STIFFENERS_AFTER_FLIP: 4 }, seg).value === 8);
ok('holes of the top flange: its own HOLES (8)', run(text('SEG_HOLES_TOP'), {}, seg).value === 8);
ok('holes of the bottom flange: what its drawing shows where it has no HOLES (6)', run(text('SEG_HOLES_BOTTOM'), {}, seg).value === 6);
ok('holes of the web: neither — it waits for the web, by name', JSON.stringify(run(text('SEG_HOLES_WEB'), {}, seg).missing) === '["WEB · DRAWN_HOLES"]', JSON.stringify(run(text('SEG_HOLES_WEB'), {}, seg)));
ok('studs: the shear stud children (120)', run(text('ASSY_STUDS'), {}, seg).value === 120);
ok('…and no value where there are none below — a person fills it', JSON.stringify(run(text('ASSY_STUDS'), {}, seg.filter((k) => k.label !== 'STUD')).missing) === '["shear studs below this row"]');
const lineKids = [kid('SEG', 5, {}, { VARIANT: { name: 'Girder segment', code: 'GIRDER_SEGMENT' } }), kid('SPLICE', 4, {}, { VARIANT: { name: 'Splice set' } }), kid('STUD', 1803, {}, { VARIANT: { name: 'Shear stud' } })];
ok('line matching joints: 5 girder segments − 1 = 4', run(text('LINE_MATCH_JOINTS'), {}, lineKids).value === 4);
ok('the true area where the drawing gives one, else the rectangle', near(run(text('PART_PLATE_WEIGHT'), { TRUE_AREA: 5_000_000, LENGTH: 12000, WIDTH: 500, THICKNESS: 25, DENSITY: 7850 }).value, 981.25)
  && near(run(text('PART_PLATE_WEIGHT'), { LENGTH: 12000, WIDTH: 500, THICKNESS: 25, DENSITY: 7850 }).value, 1177.5));
ok('the same number is the same at the specification\'s decimals', sameAsCalculated(48, 48.0004, 3) && !sameAsCalculated(48, 48.0006, 3) && sameAsCalculated(1177.5, 1177.5, null) && !sameAsCalculated(0, null, 0));
ok('one diameter for a part\'s holes: the commonest, the larger on a tie', holeDiameterOf([22, 22, 26]) === 22 && holeDiameterOf([22, 26]) === 26 && holeDiameterOf([]) === null);
ok('what a shape says: its area, its holes, their diameter', JSON.stringify(factsOfShape({ areaMm2: 1234.5678, holes: 2, holeDiameters: [22, 22] })) === '{"TRUE_AREA":1234.568,"DRAWN_HOLES":2,"DRAWN_HOLE_DIA":22}'
  && factsOfShape({ areaMm2: 10, holes: 0, holeDiameters: [] }).DRAWN_HOLE_DIA === null);
ok('a drawing is a row\'s only while it is the row\'s size (either way round), and only for a plate part', (() => {
  const d = [{ id: 1, drawing_id: null, mark_norm: 'TF1', lengthMm: 12000, widthMm: 500, areaMm2: 5e6, holes: 0, holeDiameters: [] }];
  const row = (more) => ({ id: 7, isPlatePart: true, markNorm: 'TF1', drawingIds: [], lengthMm: 12000, widthMm: 500, ...more });
  return planFacts([row({})], d).get(7)?.TRUE_AREA === 5e6 && planFacts([row({ lengthMm: 500, widthMm: 12000 })], d).has(7) && !planFacts([row({ lengthMm: 11000 })], d).has(7)
    && planFacts([row({ lengthMm: null, widthMm: null })], d).has(7) && !planFacts([row({ isPlatePart: false })], d).has(7) && !planFacts([row({ markNorm: 'XX' })], d).has(7);
})());

/* ===========================================================================
 * 2 + 3. On the database: the rule, and a fixture girder
 * ======================================================================== */
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

// The script as the user runs it: a dry run by default, on its own connection — it must leave nothing behind.
const cli = spawnSync(process.execPath, ['scripts/cf_kepl/derived-values-setup.mjs', '--company', String(COMPANY)], { encoding: 'utf8' });
const afterCli = await counts();
ok('the setup script runs as a dry run by default, and says so', cli.status === 0 && /DRY RUN — \d+ changes? would be made; everything was rolled back/.test(cli.stdout) && /Typed values: \d+ before, \d+ after — none changed/.test(cli.stdout), (cli.stdout + cli.stderr).slice(-400));
ok('…and its dry run changed nothing (every cf_ table count as before)', afterCli.every((a) => before.find((b) => b.name === a.name)?.n === a.n));

const dxf = (entities) => ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities.flat(), '0', 'ENDSEC', '0', 'EOF'].join('\n');
const lw = (pts) => ['0', 'LWPOLYLINE', '8', 'PART', '90', pts.length, '70', 1, ...pts.flatMap(([x, y]) => ['10', x, '20', y])].map(String);
const circle = (cx, cy, r) => ['0', 'CIRCLE', '8', 'PART', '10', cx, '20', cy, '40', r].map(String);
const file = (name, body) => ({ name, content: Buffer.from(body, 'latin1').toString('base64') });
/** A plate L × W with two snipes of `s` mm and `n` holes of diameter `dia`. */
const plateDxf = (L, W, { snipe = 40, holes = 0, dia = 22 } = {}) => dxf([
  lw([[snipe, 0], [L, 0], [L, W - snipe], [L - snipe, W], [0, W], [0, snipe]]),
  ...Array.from({ length: holes }, (_, i) => circle(200 + i * 150, W / 2, dia / 2)),
]);

const db = await pool.getConnection();
const counted = async (fn) => { const real = db.query.bind(db); let n = 0; db.query = (...a) => { n += 1; return real(...a); }; try { return { out: await fn(), n }; } finally { db.query = real; } };
try {
  await db.beginTransaction();
  attachNodeCache(db);
  const c = { companyId: COMPANY, userId: null };
  const tag = `DV${Date.now().toString(36).toUpperCase()}`;

  // ---- round trips of reading a line, BEFORE anything of this feature is set up ----
  const readBefore = await counted(() => readLineValues(db, COMPANY, KEPL_LINE));
  const keplRows = readBefore.out.counts.rows;

  // ---- the tenant as production has it: the operation values exist as specifications ----
  const spec = {};
  const ensureSpec = async (code, name, uom, decimals) => {
    const [[have]] = await db.query('SELECT id, default_uom, decimals FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (have) { spec[code] = { id: have.id, code }; return; }
    const [r] = await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, decimals, status) VALUES (?, ?, ?, 'number', ?, ?, 'active')", [COMPANY, code, name, uom, decimals]);
    spec[code] = { id: r.insertId, code, made: true };
  };
  for (const [code, name, uom, dec] of [
    ['SURFACE_AREA', 'Surface area', 'm2', 3], ['HOLES', 'Holes', null, 0], ['HOLE_DIA', 'Hole diameter', 'mm', 1], ['HOLE_DRILL_THICKNESS', 'Hole drilling thickness', 'mm', 2],
    ['HOLES_TOP', 'Holes - girder top', null, 0], ['HOLES_BOTTOM', 'Holes - girder bottom', null, 0], ['SAW_WELD_LENGTH', 'SAW weld length', 'm', 3], ['MIG_WELD_LENGTH', 'MIG weld length', 'm', 3],
    ['STIFFENERS', 'Stiffeners', null, 0], ['STIFFENERS_AFTER_FLIP', 'Stiffeners fitted after the flip', null, 0], ['STUDS', 'Studs', null, 0], ['LINEMATCH_JOINTS', 'Line matching joints', null, 0],
  ]) await ensureSpec(code, name, uom, dec);
  const [realSpecs] = await db.query("SELECT id, UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN ('LENGTH', 'WIDTH', 'THICKNESS', 'DENSITY', 'WEIGHT', 'DRAWING_MARK', 'GRADE')", [COMPANY]);
  for (const s of realSpecs) spec[s.code] = { id: s.id, code: s.code };
  const [nodes] = await db.query("SELECT id, UPPER(code) AS code FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND code IN ('PLATE_PART', 'GIRDER_SEGMENT', 'GIRDER_LINE', 'SHEAR_STUD', 'FAB_ASSY', 'FAB_STRUCT')", [COMPANY]);
  const node = Object.fromEntries(nodes.map((n) => [n.code, n.id]));
  ok('the local tenant has the tree the setup names (plate part, girder segment, girder line, shear stud)', ['PLATE_PART', 'GIRDER_SEGMENT', 'GIRDER_LINE', 'SHEAR_STUD', 'FAB_ASSY'].every((k) => node[k]), JSON.stringify(node));
  // Surface area as production has it: calculated on a plate part (one face), rolled up on assemblies and structures.
  if (spec.SURFACE_AREA.made) {
    const [f1] = await db.query("INSERT INTO cf_formulas (company_id, code, name, expression, version, status) VALUES (?, ?, 'cg surface area', 'LENGTH * WIDTH / 1e6', 1, 'active')", [COMPANY, `${tag}_SA`]);
    const [f2] = await db.query("INSERT INTO cf_formulas (company_id, code, name, expression, version, status) VALUES (?, ?, 'cg assy surface area', 'SUM(children.SURFACE_AREA)', 1, 'active')", [COMPANY, `${tag}_ASA`]);
    await db.query("INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order) VALUES (?, ?, 'classification', ?, 'item', 0, 1, 'calculated', ?, 70), (?, ?, 'classification', ?, 'item', 0, 1, 'rollup', ?, 70), (?, ?, 'classification', ?, 'item', 0, 1, 'rollup', ?, 70)",
      [COMPANY, spec.SURFACE_AREA.id, node.PLATE_PART, f1.insertId, COMPANY, spec.SURFACE_AREA.id, node.FAB_ASSY, f2.insertId, COMPANY, spec.SURFACE_AREA.id, node.FAB_STRUCT, f2.insertId]);
  }

  // ---- flows whose times read the values (so each row is ASKED for them by its own flow) ----
  const [[mc]] = await db.query('SELECT id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [COMPANY]);
  const flowOf = async (key, work) => {
    const [o] = await db.query("INSERT INTO cf_operations (company_id, code, name, status) VALUES (?, ?, ?, 'active')", [COMPANY, `${tag}-OP-${key}`, `${tag} op ${key}`]);
    await createTimingRule(db, c, o.insertId, { subjectType: 'machine', subjectId: mc.id, workExpression: work });
    const [f] = await db.query("INSERT INTO cf_operation_flows (company_id, code, name, status) VALUES (?, ?, ?, 'active')", [COMPANY, `${tag}-FL-${key}`, `${tag} flow ${key}`]);
    await addStep(db, c, f.insertId, { operationId: o.insertId });
    return f.insertId;
  };
  const holedFlow = await flowOf('HOLED', 'item.HOLES * 0.35 + item.HOLE_DIA * 0 + item.HOLE_DRILL_THICKNESS * 0');
  const segFlow = await flowOf('SEG', 'item.SAW_WELD_LENGTH + item.MIG_WELD_LENGTH + item.STIFFENERS * 17.5 + item.STIFFENERS_AFTER_FLIP * 17.5 + item.STUDS + item.HOLES + item.HOLES_TOP + item.HOLES_BOTTOM + item.SURFACE_AREA');
  const lineFlow = await flowOf('LINE', 'item.LINEMATCH_JOINTS * 360 + item.STUDS');

  // ---- templates under the tenant's own nodes, named as the plant names them ----
  const tpl = async (key, name, classificationId, flowId = null) => {
    const d = await MR.createDefinition(db, c, { definitionType: 'template', classificationId, code: `${tag}-${key}`, name: `${name} ${tag}`, shortName: `${tag}${key}`.slice(0, 30) });
    await MR.setStatus(db, c, d.id, 'active');
    if (flowId) await MR.updateRecord(db, c, d.id, { defaultFlowId: flowId });
    return d.id;
  };
  const T = {
    TF: await tpl('TF', 'Top flange', node.PLATE_PART, holedFlow), BF: await tpl('BF', 'Bottom flange', node.PLATE_PART, holedFlow), WEB: await tpl('WB', 'Web plate', node.PLATE_PART, holedFlow),
    IS: await tpl('IS', 'Intermediate stiffener', node.PLATE_PART), BS: await tpl('BS', 'Bearing stiffener', node.PLATE_PART), STUD: await tpl('ST', 'Stud', node.SHEAR_STUD),
    SEG: await tpl('GS', 'Segment', node.GIRDER_SEGMENT, segFlow), LINE: await tpl('GL', 'Line', node.GIRDER_LINE, lineFlow),
  };
  // A bought-out stud has no paint surface of its own: 0 by default, so an assembly's roll-up does not wait for it.
  await createRule(db, c, { specificationId: spec.SURFACE_AREA.id, subjectType: 'master', subjectId: T.STUD, captureAt: 'item', valueRule: 'defaulted', isRequired: false, isApplicable: true });
  await V.setValues(db, c, 'master', T.STUD, [{ specCode: 'SURFACE_AREA', value: 0 }]);
  for (const [childId, quantity, role] of [[T.TF, 1, null], [T.BF, 1, null], [T.WEB, 1, null], [T.IS, 6, null], [T.IS, 4, 'Far side'], [T.BS, 2, null], [T.STUD, 120, null]]) await B.addLine(db, c, T.SEG, { childId, quantity, role });
  await B.setBomStatus(db, c, T.SEG, 'active');
  await B.addLine(db, c, T.LINE, { childId: T.SEG, quantity: 2 });
  await B.addLine(db, c, T.LINE, { childId: T.STUD, quantity: 300 });
  await B.setBomStatus(db, c, T.LINE, 'active');
  const cust = await PARTIES.createParty(db, c, { code: `${tag}-CU`, name: `${tag} bridge co`, roles: ['customer'] });
  const order = await SO.createOrder(db, c, { orderType: 'customer', customerId: cust.id, code: `${tag}-SO`, committedDate: '2026-12-31' });
  const made = await SO.addOrderLine(db, c, order.id, { recordId: T.LINE, quantity: 1 });
  const line = made.lines[made.lines.length - 1];
  const LINE = line.id;
  const [temps] = await db.query(
    `SELECT m.id, i.source_definition_id AS def, bl.role FROM cf_item_details i JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL
       LEFT JOIN cf_bom_lines bl ON bl.child_id = m.id AND bl.deleted_at IS NULL
      WHERE i.company_id = ? AND i.item_type = 'temporary' AND i.deleted_at IS NULL AND i.owner_order_line_id = ?`, [COMPANY, LINE]);
  const row = (key, role = undefined) => temps.find((t) => Number(t.def) === Number(T[key]) && (role === undefined || (t.role ?? null) === role))?.id;
  const R = { TF: row('TF'), BF: row('BF'), WEB: row('WB') ?? row('WEB'), ISN: row('IS', null), ISF: row('IS', 'Far side'), BS: row('BS'), SEG: row('SEG'), LINE: row('LINE'), STUDSEG: temps.find((t) => Number(t.def) === Number(T.STUD) && t.id !== undefined)?.id };
  ok('the fixture line is made: a girder line, its segment and the segment\'s parts, each a row of its own', Object.values(R).every(Boolean), JSON.stringify(R));

  const save = async (writes) => writeLineValues(db, c, LINE, { writes });
  const w = (recordId, specCode, value) => ({ recordId, specCode, value });
  // Sizes, as the Values screen leaves them (L × W × T).
  const SIZE = { TF: [12000, 500, 25], BF: [12000, 700, 40], WEB: [12000, 2995, 28], ISN: [2995, 170, 12], ISF: [2995, 170, 12], BS: [2995, 200, 32] };
  await save(Object.entries(SIZE).flatMap(([k, [l, wd, t]]) => [w(R[k], 'LENGTH', l), w(R[k], 'WIDTH', wd), w(R[k], 'THICKNESS', t)]));
  await save([w(R.TF, 'DRAWING_MARK', `${tag}-TF1`), w(R.BF, 'DRAWING_MARK', `${tag}-BF1`), w(R.WEB, 'DRAWING_MARK', `${tag}-WB1`)]);
  const studRows = temps.filter((t) => Number(t.def) === Number(T.STUD)).map((t) => t.id);
  await save(studRows.map((id) => w(id, 'WEIGHT', 0.5)));

  const stored = async (recordId, code) => {
    const [[v]] = await db.query(
      `SELECT v.value_number, v.source FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL AND s.code = ?`, [COMPANY, recordId, code]);
    return v ? { n: v.value_number == null ? null : Number(v.value_number), source: v.source } : null;
  };
  const cellOf = async (recordId, code, view = null) => {
    const v = view ?? await readLineValues(db, COMPANY, LINE);
    for (const g of v.groups) { const r = g.rows.find((x) => x.id === recordId); if (r && r.cells[code]) { const col = g.columns.find((x) => x.code === code); return { ...r.cells[code], from: 'from' in r.cells[code] ? r.cells[code].from : col.from ?? null, rule: r.cells[code].rule ?? col.rule, required: r.cells[code].required ?? col.required }; } }
    return null;
  };
  const specOf = async (recordId, code) => publicResolution(await resolve(db, COMPANY, { master: await loadMaster(db, COMPANY, recordId) })).specs.find((s) => s.spec.code === code && s.captureAt === 'item');
  const ruleOf = async (recordId, code) => (await db.query(
    `SELECT a.value_rule, a.formula_id, a.is_required, a.origin, f.code AS formula FROM cf_spec_assignments a JOIN cf_specifications s ON s.id = a.specification_id LEFT JOIN cf_formulas f ON f.id = a.formula_id
      WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id = ? AND a.deleted_at IS NULL AND s.code = ?`, [COMPANY, recordId, code]))[0][0] ?? null;

  console.log('\n  2. before the setup: today\'s behaviour');
  const rect = (k) => (SIZE[k][0] * SIZE[k][1] * SIZE[k][2] * 7850) / 1e9;
  ok(`a plate weighs by its rectangle (top flange ${rect('TF')} kg)`, near((await stored(R.TF, 'WEIGHT'))?.n, rect('TF')) && (await stored(R.TF, 'WEIGHT')).source === 'calculated', JSON.stringify(await stored(R.TF, 'WEIGHT')));
  ok('each row is asked for what its own flow reads, typed and required', (await ruleOf(R.SEG, 'SAW_WELD_LENGTH'))?.value_rule === 'entered' && (await ruleOf(R.SEG, 'SAW_WELD_LENGTH')).origin === 'flow' && (await ruleOf(R.TF, 'HOLES'))?.origin === 'flow' && (await ruleOf(R.LINE, 'LINEMATCH_JOINTS'))?.origin === 'flow', JSON.stringify(await ruleOf(R.SEG, 'SAW_WELD_LENGTH')));
  ok('a plain stiffener, whose flow drills nothing, is not asked for holes', (await ruleOf(R.ISN, 'HOLES')) === null);
  let refused = null; try { await save([w(R.TF, 'WEIGHT', 999)]); } catch (e) { refused = e.problems?.join(' ') ?? e.message; }
  ok('a calculated value cannot be typed over today', /calculated — it cannot be typed in/.test(refused ?? ''), refused);
  // What the plant typed from its take-off — one right, one wrong, one rounded.
  await save([w(R.SEG, 'SAW_WELD_LENGTH', 48), w(R.SEG, 'MIG_WELD_LENGTH', 79.5), w(R.SEG, 'STUDS', 120), w(R.SEG, 'STIFFENERS_AFTER_FLIP', 4), w(R.TF, 'HOLES', 8), w(R.LINE, 'LINEMATCH_JOINTS', 3)]);
  const typedBefore = Object.fromEntries(await Promise.all([[R.SEG, 'SAW_WELD_LENGTH'], [R.SEG, 'MIG_WELD_LENGTH'], [R.SEG, 'STUDS'], [R.TF, 'HOLES'], [R.LINE, 'LINEMATCH_JOINTS']].map(async ([id, code]) => [`${id}:${code}`, await stored(id, code)])));
  const rootBefore = (await measuresOf(db, COMPANY, [R.LINE])).get(R.LINE)?.weightKg ?? null;

  // The drawings arrive while designing: the top flange (snipes + 8 holes of 22) and the bottom flange (6 holes of 26).
  const tfDxf = plateDxf(12000, 500, { holes: 8, dia: 22 });
  const bfDxf = plateDxf(12000, 700, { holes: 6, dia: 26 });
  const up1 = await uploadDrawings(db, c, order.id, LINE, { files: [file(`${tag}-TF1.dxf`, tfDxf), file(`${tag}-BF1.dxf`, bfDxf)], dryRun: false });
  const gTF = up1.view.drawings.find((d) => d.mark === `${tag}-TF1`)?.geometry;
  const gBF = up1.view.drawings.find((d) => d.mark === `${tag}-BF1`)?.geometry;
  const analytic = 12000 * 500 - 2 * (40 * 40 / 2) - 8 * Math.PI * 11 * 11;
  ok(`the top flange's shape is read: true area ${gTF?.areaMm2} mm² (by hand ${analytic.toFixed(0)}), 8 holes of 22`, gTF && Math.abs(gTF.areaMm2 - analytic) / analytic < 2e-4 && gTF.holes === 8 && gTF.holeDiameters.every((d) => d === 22), JSON.stringify({ a: gTF?.areaMm2, h: gTF?.holes }));
  ok('before the setup the tenant has nowhere to keep what the drawing says: nothing is written, nothing breaks', (await stored(R.TF, 'TRUE_AREA')) === null && up1.values?.skipped === 'not_set_up', JSON.stringify(up1.values));
  ok('…and the weight is still the rectangle\'s', near((await stored(R.TF, 'WEIGHT'))?.n, rect('TF')));

  /* ------------------------------------------------------------------------- */
  console.log('\n  3. the setup, laid on by the script');
  const said = [];
  const first = await setup(db, { companyId: COMPANY, log: (x) => said.push(x) });
  ok('the script says what it adds or changes, per value and node', said.some((x) => /PLATE_PART · WEIGHT — CHANGED: calculated \(PLATE_WEIGHT = .*\)\s+→\s+typeable over, PART_PLATE_WEIGHT = FIRST\(TRUE_AREA, LENGTH \* WIDTH\)/.test(x))
    && said.some((x) => /GIRDER_SEGMENT · SAW_WELD_LENGTH — ADDED for the rows whose flow reads it/.test(x)) && said.some((x) => /GIRDER_LINE · LINEMATCH_JOINTS — ADDED/.test(x)), said.filter((x) => /·/.test(x)).join(' | ').slice(0, 500));
  ok('surface area keeps today\'s formula with the true area in place of the rectangle (one face stays one face)', first.rules.some((r) => r.spec === 'SURFACE_AREA' && r.node === 'PLATE_PART' && r.action === 'changed' && r.expression === 'FIRST(TRUE_AREA, LENGTH * WIDTH) / 1e6')
    && first.rules.some((r) => r.spec === 'SURFACE_AREA' && r.node === 'FAB_ASSY' && r.action === 'made typeable'), JSON.stringify(first.rules.filter((r) => r.spec === 'SURFACE_AREA')));
  const mineLine = first.lines.find((l) => l.lineId === LINE);
  ok(`it reports each open line: ${mineLine?.typed} typed and different, ${mineLine?.same} typed and equal, ${mineLine?.calculated} filled by the formula`, mineLine && mineLine.typed === 2 && mineLine.same === 4 && mineLine.calculated > 5, JSON.stringify(mineLine));
  ok('no typed value moved (count and checksum before = after)', first.typed.before.n === first.typed.after.n && first.typed.before.sum === first.typed.after.sum && said.some((x) => /none changed/.test(x)));
  ok('…each number the plant typed is exactly as it was', (await Promise.all(Object.entries(typedBefore).map(async ([k, v]) => { const [id, code] = k.split(':'); const now = await stored(Number(id), code); return now && now.n === v.n && now.source === 'entered'; }))).every(Boolean));
  const second = await setup(db, { companyId: COMPANY, log: () => {} });
  ok('a second run changes nothing', second.changed === 0 && second.rules.every((r) => ['kept', 'skipped'].includes(r.action)), JSON.stringify({ changed: second.changed, actions: [...new Set(second.rules.map((r) => r.action))] }));

  ok('the row\'s own flow-made rule now says how the value comes — Defaulted, by the formula, still required', (await ruleOf(R.SEG, 'SAW_WELD_LENGTH'))?.value_rule === 'defaulted' && (await ruleOf(R.SEG, 'SAW_WELD_LENGTH')).formula === 'ASSY_SAW_WELD_LENGTH' && (await ruleOf(R.SEG, 'SAW_WELD_LENGTH')).is_required === 1 && (await ruleOf(R.SEG, 'SAW_WELD_LENGTH')).origin === 'flow');
  ok('the field list is still the flow\'s: a plain stiffener is not shown holes', (await cellOf(R.ISN, 'HOLES')) === null && (await ruleOf(R.ISN, 'HOLES')) === null);

  // (a) the true shape
  const trueKg = (g, t) => (g.areaMm2 * t * 7850) / 1e9;
  const wTF = await cellOf(R.TF, 'WEIGHT');
  ok(`a plate with a drawing weighs by its TRUE area: ${trueKg(gTF, 25).toFixed(3)} kg, not ${rect('TF')}`, near((await stored(R.TF, 'WEIGHT'))?.n, trueKg(gTF, 25)) && wTF.from === 'drawing' && wTF.rule === 'defaulted', JSON.stringify([await stored(R.TF, 'WEIGHT'), wTF]));
  ok('a plate without one weighs by its rectangle, and says "worked out"', near((await stored(R.WEB, 'WEIGHT'))?.n, rect('WEB')) && (await cellOf(R.WEB, 'WEIGHT')).from === 'calculated');
  ok('its surface area likewise: the true area, one face (m²)', near((await stored(R.TF, 'SURFACE_AREA'))?.n, gTF.areaMm2 / 1e6) && near((await stored(R.WEB, 'SURFACE_AREA'))?.n, (12000 * 2995) / 1e6));
  const kg = { TF: trueKg(gTF, 25), BF: trueKg(gBF, 40), WEB: rect('WEB'), ISN: rect('ISN'), ISF: rect('ISF'), BS: rect('BS') };
  const segKg = kg.TF + kg.BF + kg.WEB + 6 * kg.ISN + 4 * kg.ISF + 2 * kg.BS + 120 * 0.5;
  ok(`the assemblies correct themselves through their roll-ups: the segment ${segKg.toFixed(3)} kg, the line 2 × that + 300 studs`, near((await stored(R.SEG, 'WEIGHT'))?.n, segKg, 0.01) && near((await stored(R.LINE, 'WEIGHT'))?.n, 2 * segKg + 150, 0.02), JSON.stringify([await stored(R.SEG, 'WEIGHT'), await stored(R.LINE, 'WEIGHT')]));
  const areaSeg = (gTF.areaMm2 + gBF.areaMm2 + 12000 * 2995 + 10 * 2995 * 170 + 2 * 2995 * 200) / 1e6;

  // (b) every value of the list, against the hand calculation
  const val = async (id, code) => (await specOf(id, code))?.value?.raw ?? null;
  ok('PART: holes and their diameter from the drawing (8 of 22)', (await val(R.TF, 'HOLES')) === 8 && (await val(R.TF, 'HOLE_DIA')) === 22 && (await specOf(R.TF, 'HOLE_DIA')).derived?.source === 'drawing');
  ok('PART: hole drilling thickness is the part\'s own thickness (25)', (await val(R.TF, 'HOLE_DRILL_THICKNESS')) === 25 && (await specOf(R.TF, 'HOLE_DRILL_THICKNESS')).derived?.source === 'calculated');
  ok('PART without a drawing: holes are asked for (required, missing) — a person fills them', (await specOf(R.WEB, 'HOLES')).status === 'missing' && (await cellOf(R.WEB, 'HOLES')).missing === true && /waiting for DRAWN_HOLES/.test((await cellOf(R.WEB, 'HOLES')).noCalc ?? ''), JSON.stringify(await cellOf(R.WEB, 'HOLES')));
  ok('SEGMENT: holes of the top flange 8, of the bottom flange 6 (its drawing — it has no HOLES of its own... it has: its flow drills)', (await val(R.SEG, 'HOLES_TOP')) === 8 && (await val(R.SEG, 'HOLES_BOTTOM')) === 6, JSON.stringify([await val(R.SEG, 'HOLES_TOP'), await val(R.SEG, 'HOLES_BOTTOM')]));
  ok('SEGMENT: holes of the web wait for the web, which has no drawing — asked for', (await specOf(R.SEG, 'HOLES')).status === 'missing' && (await specOf(R.SEG, 'HOLES')).missingInputs?.length === 1, JSON.stringify((await specOf(R.SEG, 'HOLES')).missingInputs));
  ok('SEGMENT: SAW weld 4 × 12 m = 48 m', near(await val(R.SEG, 'SAW_WELD_LENGTH'), 48));
  ok('SEGMENT: stiffeners after the flip = the far-side rows (4); before = 12 − 4 = 8', (await val(R.SEG, 'STIFFENERS_AFTER_FLIP')) === 4 && (await val(R.SEG, 'STIFFENERS')) === 8);
  ok('SEGMENT: studs = its 120 stud children; LINE: studs 300, joints = 2 segments − 1 = 1', (await val(R.SEG, 'STUDS')) === 120 && (await val(R.LINE, 'STUDS')) === 300);
  ok(`SEGMENT: paint surface = Σ of its parts' true areas, one face = ${areaSeg.toFixed(3)} m² (the paint time multiplies by its own factor)`, near(await val(R.SEG, 'SURFACE_AREA'), areaSeg, 0.002) && (await specOf(R.SEG, 'SURFACE_AREA')).derived?.overridable === true, String(await val(R.SEG, 'SURFACE_AREA')));

  // typed before the setup: equal → shown as calculated; different → typed over, with the calculated one beside it
  const saw = await specOf(R.SEG, 'SAW_WELD_LENGTH');
  ok('typed 48 = calculated 48: shown as worked out, the typed row is kept', saw.derived?.source === 'calculated' && saw.derived.held === true && saw.value.source === 'defaulted' && (await stored(R.SEG, 'SAW_WELD_LENGTH')).source === 'entered' && (await cellOf(R.SEG, 'SAW_WELD_LENGTH')).input === undefined && (await cellOf(R.SEG, 'SAW_WELD_LENGTH')).defaultDisplay === '48.000 m', JSON.stringify([saw.derived, await cellOf(R.SEG, 'SAW_WELD_LENGTH')]));
  const mig = await specOf(R.SEG, 'MIG_WELD_LENGTH');
  ok('typed 79.5 ≠ calculated 80.28: reported as typed by hand, with the calculated value', mig.value.raw === 79.5 && mig.value.source === 'entered' && mig.derived?.source === 'typed' && near(mig.derived.calculated.raw, 80.28) && mig.derived.calculated.display === '80.280 m', JSON.stringify(mig.derived));
  const migCell = await cellOf(R.SEG, 'MIG_WELD_LENGTH');
  ok('…and the cell says so: from typed, input 79.5, calculated "80.280 m"', migCell.from === 'typed' && migCell.input === '79.5' && migCell.calculated === '80.280 m', JSON.stringify(migCell));
  const joints = await specOf(R.LINE, 'LINEMATCH_JOINTS');
  ok('typed 3 joints against 1 calculated: typed over', joints.derived?.source === 'typed' && joints.derived.calculated.raw === 1);
  ok('the resolve() of one record and the line\'s mirror say the same, field for field', await (async () => {
    const all = await resolveLineRecords(db, COMPANY, LINE);
    for (const id of [R.SEG, R.LINE, R.TF, R.WEB]) { const { internal, ...one } = await resolve(db, COMPANY, { master: await loadMaster(db, COMPANY, id) }); if (JSON.stringify(one.specs) !== JSON.stringify(all.get(id).specs)) return false; }
    return true;
  })());

  // (c) override, and back
  console.log('\n  4. typing over, and going back');
  const o1 = await save([w(R.SEG, 'SAW_WELD_LENGTH', 50)]);
  ok('typing 50 over the calculated 48 is saved as an override', o1.summary.changed === 1 && (await stored(R.SEG, 'SAW_WELD_LENGTH')).n === 50 && (await cellOf(R.SEG, 'SAW_WELD_LENGTH', o1.view)).from === 'typed' && (await cellOf(R.SEG, 'SAW_WELD_LENGTH', o1.view)).calculated === '48.000 m');
  const o2 = await save([w(R.SEG, 'SAW_WELD_LENGTH', null)]);
  ok('emptying the cell goes back to the calculated value (stored as calculated again)', (await stored(R.SEG, 'SAW_WELD_LENGTH')).n === 48 && (await stored(R.SEG, 'SAW_WELD_LENGTH')).source !== 'entered' && (await cellOf(R.SEG, 'SAW_WELD_LENGTH', o2.view)).from === 'calculated', JSON.stringify(await stored(R.SEG, 'SAW_WELD_LENGTH')));
  const o3 = await save([w(R.SEG, 'SAW_WELD_LENGTH', 48)]);
  ok('typing the calculated number itself is no override: nothing is stored as typed, nothing changed', o3.summary.changed === 0 && (await stored(R.SEG, 'SAW_WELD_LENGTH')).source !== 'entered', JSON.stringify(o3.summary));
  const o4 = await save([w(R.SEG, 'MIG_WELD_LENGTH', 80.28)]);
  ok('typing the calculated number over an override takes the override away', o4.summary.changed === 1 && (await stored(R.SEG, 'MIG_WELD_LENGTH')).source !== 'entered' && near((await stored(R.SEG, 'MIG_WELD_LENGTH')).n, 80.28));
  await save([w(R.SEG, 'MIG_WELD_LENGTH', 79.5)]);
  const wOver = await save([w(R.TF, 'WEIGHT', 1200)]);
  ok('a plate\'s weight can now be typed over (1200 kg) — its segment and line roll the typed weight up', (await stored(R.TF, 'WEIGHT')).n === 1200 && (await stored(R.TF, 'WEIGHT')).source === 'entered' && (await cellOf(R.TF, 'WEIGHT', wOver.view)).calculated === `${trueKg(gTF, 25).toFixed(3)} kg` && wOver.summary.derived >= 1, JSON.stringify(wOver.summary));
  await save([w(R.TF, 'WEIGHT', '')]);
  ok('…and back: the true-shape weight again', near((await stored(R.TF, 'WEIGHT')).n, trueKg(gTF, 25)) && (await stored(R.TF, 'WEIGHT')).source === 'calculated');
  refused = null; try { await save([w(R.TF, 'TRUE_AREA', 5)]); } catch (e) { refused = e.problems?.join(' ') ?? e.message; }
  ok('what the drawing says cannot be typed', /not part of this item|read from the drawing/.test(refused ?? ''), refused);

  // "Why these values"
  const why = await getValueReasons(db, COMPANY, R.SEG);
  const reason = (code) => why.values.find((v) => v.code === code)?.reason;
  ok('why these values: the typed-over one is in its own group, with what was typed and the calculated value', reason('MIG_WELD_LENGTH')?.kind === 'typedOver' && reason('MIG_WELD_LENGTH').value === '79.500 m' && reason('MIG_WELD_LENGTH').calculated === '80.280 m' && reason('MIG_WELD_LENGTH').formula?.code === 'ASSY_MIG_WELD_LENGTH', JSON.stringify(reason('MIG_WELD_LENGTH')));
  ok('…a worked-out one says it can be typed over and which operation reads it; one still to fill stays "from its flow"', reason('SAW_WELD_LENGTH')?.kind === 'derived' && reason('SAW_WELD_LENGTH').overridable === true && reason('SAW_WELD_LENGTH').readBy.length === 1 && reason('HOLES')?.kind === 'flow', JSON.stringify([reason('SAW_WELD_LENGTH'), reason('HOLES')]));
  ok('…and the part\'s holes say "from the drawing"; its facts are not listed as forgotten values', (await getValueReasons(db, COMPANY, R.TF)).values.find((v) => v.code === 'HOLE_DIA')?.reason.how === 'drawing' && !(await getValueReasons(db, COMPANY, R.TF)).notAsked.some((n) => ['TRUE_AREA', 'DRAWN_HOLES', 'DRAWN_HOLE_DIA'].includes(n.code)));

  /* ------------------------------------------------------------------------- */
  console.log('\n  5. the drawing changes, the part changes');
  const segBefore = (await stored(R.SEG, 'WEIGHT'))?.n ?? null;
  // A new revision of the top flange: bigger snipes, 10 holes of 26.
  const up2 = await uploadDrawings(db, c, order.id, LINE, { files: [file(`${tag}-TF1.dxf`, plateDxf(12000, 500, { snipe: 100, holes: 10, dia: 26 }))], dryRun: false });
  const gTF2 = up2.view.drawings.find((d) => d.mark === `${tag}-TF1`)?.geometry;
  ok('a new revision of the drawing replaces the facts: area, 10 holes of 26', up2.files[0].status === 'replaces' && near((await stored(R.TF, 'TRUE_AREA')).n, gTF2.areaMm2, 0.01) && (await stored(R.TF, 'DRAWN_HOLES')).n === 10 && (await stored(R.TF, 'DRAWN_HOLE_DIA')).n === 26);
  ok('…and the weight follows the new shape; the hole diameter too', near((await stored(R.TF, 'WEIGHT')).n, trueKg(gTF2, 25)) && gTF2.areaMm2 < gTF.areaMm2 && (await stored(R.TF, 'HOLE_DIA'))?.n === 26);
  ok('…the typed 8 holes stay typed, now different from the drawing\'s 10', (await stored(R.TF, 'HOLES')).n === 8 && (await specOf(R.TF, 'HOLES')).derived?.source === 'typed' && (await specOf(R.TF, 'HOLES')).derived.calculated.raw === 10);
  ok('…the segment reads the part\'s typed 8, not the drawing\'s 10 (an override travels up)', (await val(R.SEG, 'HOLES_TOP')) === 8);
  if (segBefore != null) ok('…and the segment\'s weight moved with its part', near((await stored(R.SEG, 'WEIGHT')).n, segBefore - trueKg(gTF, 25) + trueKg(gTF2, 25), 0.01));
  // Re-sized away from its drawing: the facts go, the rectangle is back — through the save's own tail (cutPlateService.withCutPieces).
  const resized = await save([w(R.BF, 'LENGTH', 11500)]);
  await withCutPieces(db, c, LINE, resized);
  ok('a part re-sized away from its drawing loses the drawing\'s facts (no stale area) and weighs by its new rectangle', (await stored(R.BF, 'TRUE_AREA')) === null && (await stored(R.BF, 'DRAWN_HOLES')) === null && near((await stored(R.BF, 'WEIGHT')).n, (11500 * 700 * 40 * 7850) / 1e9) && (await cellOf(R.BF, 'WEIGHT')).from === 'calculated', JSON.stringify(await stored(R.BF, 'WEIGHT')));
  const back = await save([w(R.BF, 'LENGTH', 12000)]);
  const tail = await withCutPieces(db, c, LINE, back);
  ok('…sized back to its drawing, it takes them again — and the save answers with the values as they are now', near((await stored(R.BF, 'TRUE_AREA'))?.n, gBF.areaMm2, 0.01) && near((await stored(R.BF, 'WEIGHT')).n, trueKg(gBF, 40)) && (await cellOf(R.BF, 'WEIGHT', tail.view)).from === 'drawing');
  // A drawing is a row's by its mark OR by the register link the upload made (partDrawingService's rule).
  await withCutPieces(db, c, LINE, await save([w(R.BF, 'DRAWING_MARK', `${tag}-OTHER`)]));
  ok('a retyped drawing mark alone does not take the drawing away: the row is still linked to it in the register', near((await stored(R.BF, 'TRUE_AREA'))?.n, gBF.areaMm2, 0.01));
  const [bfLinks] = await db.query("SELECT id FROM cf_drawing_links WHERE company_id = ? AND subject_type = 'master_record' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, R.BF]);
  await db.query('UPDATE cf_drawing_links SET deleted_at = NOW() WHERE id IN (?)', [bfLinks.map((l) => l.id)]);
  await withCutPieces(db, c, LINE, await save([w(R.BF, 'DRAWING_MARK', `${tag}-OTHER2`)]));
  ok('a row that neither names the file nor is linked to its drawing loses the facts, and weighs by its rectangle', (await stored(R.BF, 'TRUE_AREA')) === null && near((await stored(R.BF, 'WEIGHT')).n, rect('BF')));
  await db.query('UPDATE cf_drawing_links SET deleted_at = NULL WHERE id IN (?)', [bfLinks.map((l) => l.id)]);
  await withCutPieces(db, c, LINE, await save([w(R.BF, 'DRAWING_MARK', `${tag}-BF1`)]));
  const again = await counted(() => refreshDrawingValues(db, c, LINE));
  ok(`refreshing when nothing changed writes nothing, in ${again.n} round trips`, again.out.written === 0 && again.out.cleared === 0 && again.n <= 7, JSON.stringify(again.out));
  // Deleting the drawing: back to the rectangle.
  const tfFile = (await db.query('SELECT id FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND mark_norm = ? AND deleted_at IS NULL', [COMPANY, LINE, `${tag}-TF1`]))[0][0];
  await deleteDrawing(db, c, order.id, LINE, tfFile.id);
  ok('deleting the drawing takes its facts away: the part weighs by its rectangle, its holes are only the typed ones', (await stored(R.TF, 'TRUE_AREA')) === null && near((await stored(R.TF, 'WEIGHT')).n, rect('TF')) && (await stored(R.TF, 'HOLE_DIA')) === null && (await stored(R.TF, 'HOLES')).n === 8);
  await uploadDrawings(db, c, order.id, LINE, { files: [file(`${tag}-TF1.dxf`, tfDxf)], dryRun: false });
  ok('uploading it again brings them back', near((await stored(R.TF, 'WEIGHT')).n, trueKg(gTF, 25)) && (await specOf(R.TF, 'HOLES')).derived?.held === true);

  // Weight feeds price: a custom line priced per tonne.
  const rootAfter = (await measuresOf(db, COMPANY, [R.LINE])).get(R.LINE)?.weightKg ?? null;
  if (rootBefore != null && rootAfter != null) {
    const priceBefore = amountOf(95000, 'tonne', 1, { weightKg: rootBefore }, 'nos');
    const priceAfter = amountOf(95000, 'tonne', 1, { weightKg: rootAfter }, 'nos');
    console.log(`        the line: ${rootBefore.toFixed(3)} kg by rectangles → ${rootAfter.toFixed(3)} kg by true shapes (${(rootAfter - rootBefore).toFixed(3)} kg, ${(100 * (rootAfter - rootBefore) / rootBefore).toFixed(4)} %); at ₹95,000 a tonne ${priceBefore?.amount ?? priceBefore} → ${priceAfter?.amount ?? priceAfter}`);
    ok('the line\'s weight — and so a per-tonne price — is lower by exactly the steel the drawings take away', near(rootBefore - rootAfter, 2 * ((rect('TF') - trueKg(gTF, 25)) + (rect('BF') - trueKg(gBF, 40))), 0.01), `${rootBefore} → ${rootAfter}`);
  } else ok('the line has a weight before and after', false, `${rootBefore} / ${rootAfter}`);

  /* ------------------------------------------------------------------------- */
  console.log('\n  6. Excel, both ways');
  const pairs = (ws) => {
    const out = new Map();
    ws.eachRow((r, n) => { for (let i = 1; i <= r.cellCount; i++) { const m = /^([NV])\|(.+)$/.exec(String(r.getCell(i).value ?? '')); if (m) { if (!out.has(m[2])) out.set(m[2], {}); out.get(m[2])[m[1]] = n; } } });
    return out;
  };
  const download = async () => { const out = await exportOrderSheet(db, COMPANY, LINE); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(out.buffer); const ws = wb.getWorksheet('BOM'); return { wb, ws, pairs: pairs(ws) }; };
  const cellIn = (d, recordId, label) => {
    for (const [id, p] of d.pairs) {
      if (!id.endsWith(`:${recordId}`)) continue;
      const names = d.ws.getRow(p.N); const values = d.ws.getRow(p.V);
      for (let i = 2; i <= names.cellCount; i++) if (String(names.getCell(i).value ?? '') === label) return { name: names.getCell(i), value: values.getCell(i) };
    }
    return null;
  };
  const labelsOf = (d, recordId) => { for (const [id, p] of d.pairs) if (id.endsWith(`:${recordId}`)) { const out = []; const names = d.ws.getRow(p.N); for (let i = 2; i <= names.cellCount; i++) out.push(String(names.getCell(i).value ?? '')); return out; } return []; };
  const upload = async (d, dryRun = false) => importOrderSheet(db, c, LINE, { file: Buffer.from(await d.wb.xlsx.writeBuffer()), dryRun });
  let d = await download();
  const migTyped = cellIn(d, R.SEG, `MIG weld length (m)${TYPED_MARK}`);
  const sawCalc = cellIn(d, R.SEG, 'SAW weld length (m)');
  ok('the sheet marks a typed-over value in its NAME ("— typed") and says the calculated value in a cell note', migTyped && migTyped.value.value === 79.5 && /the calculated value is 80\.280 m/.test(JSON.stringify(migTyped.value.note ?? '')), JSON.stringify(labelsOf(d, R.SEG)));
  ok('…a calculated one is written as the default it is (no mark), in a cell that can be typed', sawCalc && sawCalc.value.value === '48.000 m' && !labelsOf(d, R.SEG).includes(`SAW weld length (m)${TYPED_MARK}`));
  ok('…and the banner says how to go back', /empty its cell to go back/.test(String(d.ws.getRow(1).getCell(1).value)));
  const untouched = await upload(d, true);
  ok('uploading the sheet unchanged changes nothing (a calculated value that is only shown is not turned into a typed one)', untouched.ok && untouched.summary.valuesChanged === 0, JSON.stringify(untouched.problems));
  // The other typed values of the line, to prove none of them is touched by what follows.
  const othersBefore = JSON.stringify((await db.query(
    `SELECT v.subject_id, v.specification_id, v.value_number, v.value_text, v.option_id FROM cf_spec_values v JOIN cf_item_details i ON i.master_id = v.subject_id AND i.owner_order_line_id = ?
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.source = 'entered' AND v.specification_id NOT IN (?) ORDER BY v.subject_id, v.specification_id`,
    [LINE, COMPANY, [spec.MIG_WELD_LENGTH.id, spec.SAW_WELD_LENGTH.id, spec.STUDS.id]]))[0]);
  migTyped.value.value = null;                      // empty cell under a "— typed" name: back to the calculated value
  sawCalc.value.value = 51;                          // a different number: an override
  cellIn(d, R.SEG, 'Studs').value.value = 120;       // the calculated number itself: no override
  const applied = await upload(d);
  ok('an EMPTY cell under a typed name takes the override away', applied.ok && (await stored(R.SEG, 'MIG_WELD_LENGTH')).source !== 'entered' && near((await stored(R.SEG, 'MIG_WELD_LENGTH')).n, 80.28), JSON.stringify(applied.problems));
  ok('a number different from the calculated one becomes an override', (await stored(R.SEG, 'SAW_WELD_LENGTH')).n === 51 && (await stored(R.SEG, 'SAW_WELD_LENGTH')).source === 'entered');
  ok('the calculated number itself is not an override', (await specOf(R.SEG, 'STUDS')).derived?.source === 'calculated' && applied.summary.valuesChanged === 2, JSON.stringify(applied.summary));
  const othersAfter = JSON.stringify((await db.query(
    `SELECT v.subject_id, v.specification_id, v.value_number, v.value_text, v.option_id FROM cf_spec_values v JOIN cf_item_details i ON i.master_id = v.subject_id AND i.owner_order_line_id = ?
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL AND v.source = 'entered' AND v.specification_id NOT IN (?) ORDER BY v.subject_id, v.specification_id`,
    [LINE, COMPANY, [spec.MIG_WELD_LENGTH.id, spec.SAW_WELD_LENGTH.id, spec.STUDS.id]]))[0]);
  ok('every other typed value of the line is exactly as it was (sizes, marks, the typed holes and joints)', othersBefore === othersAfter && JSON.parse(othersBefore).length > 15);
  d = await download();
  ok('downloaded again: the marks have moved with the values (SAW is typed now, MIG is not)', labelsOf(d, R.SEG).includes(`SAW weld length (m)${TYPED_MARK}`) && labelsOf(d, R.SEG).includes('MIG weld length (m)') && cellIn(d, R.SEG, 'MIG weld length (m)').value.value === '80.280 m');
  const stale = await download(); cellIn(stale, R.SEG, `SAW weld length (m)${TYPED_MARK}`).name.value = 'SAW weld length (m)';
  ok('a sheet whose "— typed" name was edited away is refused in words, not guessed at', (await upload(stale, true)).ok === false);
  await save([w(R.SEG, 'SAW_WELD_LENGTH', null)]);

  /* ------------------------------------------------------------------------- */
  console.log('\n  7. a frozen line keeps what it was frozen with');
  await save([w(R.SEG, 'MIG_WELD_LENGTH', 79.5)]);
  const frozenWeight = (await stored(R.TF, 'WEIGHT')).n;
  const frozenRule = await ruleOf(R.WEB, 'HOLES');
  await db.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [LINE]);
  await uploadDrawings(db, c, order.id, LINE, { files: [file(`${tag}-TF1.dxf`, plateDxf(12000, 500, { snipe: 200, holes: 3, dia: 30 }))], dryRun: false });
  ok('a new drawing on a locked line changes no value: no fact, no weight', near((await stored(R.TF, 'TRUE_AREA')).n, gTF.areaMm2, 0.01) && (await stored(R.TF, 'WEIGHT')).n === frozenWeight && (await refreshDrawingValues(db, c, LINE, { force: true })).skipped === 'frozen');
  const fz = await specOf(R.SEG, 'MIG_WELD_LENGTH');
  ok('its rows show what they hold, and say which were typed', fz.status === 'frozen' && fz.value.raw === 79.5 && fz.derived?.source === 'typed' && (await specOf(R.TF, 'WEIGHT')).status === 'frozen' && (await cellOf(R.SEG, 'MIG_WELD_LENGTH')).from === 'typed');
  let frozenRefusal = null; try { await save([w(R.SEG, 'MIG_WELD_LENGTH', null)]); } catch (e) { frozenRefusal = e.code ?? e.message; }
  ok('…and nothing on it can be typed or cleared', frozenRefusal === 'LOCKED', String(frozenRefusal));
  const third = await setup(db, { companyId: COMPANY, log: () => {} });
  ok('the setup run again leaves a frozen line alone (its rules and values as frozen)', third.changed === 0 && JSON.stringify(await ruleOf(R.WEB, 'HOLES')) === JSON.stringify(frozenRule) && (await stored(R.TF, 'WEIGHT')).n === frozenWeight);

  // The compare report reads a frozen line as if it were open — and writes nothing.
  const stateOf = async () => JSON.stringify((await db.query('SELECT COUNT(*) n, COALESCE(SUM(CRC32(CONCAT_WS(\'|\', id, IFNULL(value_number, \'\'), source, IFNULL(deleted_at, \'\')))), 0) s FROM cf_spec_values WHERE company_id = ?', [COMPANY]))[0][0]);
  const valuesBefore = await stateOf();
  const lines = [];
  const report = await compareOrder(db, { companyId: COMPANY, orderCode: order.code, log: (x) => lines.push(x) });
  const rows = report.orders[0].lines[0].rows;
  const cmp = (id, code) => rows.find((r) => r.recordId === id && r.code === code);
  ok('compare: one order, every typed value beside the calculated one (MIG 79.5 against 80.28, −0.78)', report.orders.length === 1 && cmp(R.SEG, 'MIG_WELD_LENGTH')?.state === 'typed' && near(cmp(R.SEG, 'MIG_WELD_LENGTH').difference, -0.78) && cmp(R.LINE, 'LINEMATCH_JOINTS')?.typed === 3 && cmp(R.LINE, 'LINEMATCH_JOINTS').calculated === 1, JSON.stringify(cmp(R.SEG, 'MIG_WELD_LENGTH')));
  ok('…the frozen line is read with the drawing it has NOW (3 holes of 30 against the typed 8) — as a check, not a change', cmp(R.TF, 'HOLES')?.typed === 8 && cmp(R.TF, 'HOLES').calculated === 3 && cmp(R.TF, 'HOLES').from === 'drawing' && report.orders[0].lines[0].frozen === 'locked', JSON.stringify(cmp(R.TF, 'HOLES')));
  ok('…in words: the differences largest first, and the count', lines.some((x) => /typed ≠ calculated/.test(x)) && lines.some((x) => /LINEMATCH_JOINTS\s+typed\s+3\s+calculated\s+1/.test(x)) && lines.some((x) => new RegExp(`ORDER ${order.code}: \\d+ typed and DIFFERENT`).test(x)), lines.slice(-6).join(' / '));
  ok('…and it wrote nothing', valuesBefore === await stateOf());
  await db.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [LINE]);
  await refreshDrawingValues(db, c, LINE);   // (a lock is never taken back in the app; the test does, so it brings the facts up to the drawing uploaded meanwhile)
  const openCmp = await compareLineValues(db, COMPANY, LINE);
  ok('an open line compares from what it holds: MIG, the joints, and the 8 typed holes against the 3 now drawn', openCmp.frozen === null && openCmp.rows.some((r) => r.code === 'MIG_WELD_LENGTH' && r.state === 'typed') && openCmp.counts.typed === 3, JSON.stringify(openCmp.counts));

  /* ------------------------------------------------------------------------- */
  console.log('\n  8. round trips');
  const readAfter = await counted(() => readLineValues(db, COMPANY, KEPL_LINE));
  const readSmall = await counted(() => readLineValues(db, COMPANY, LINE));
  ok(`reading a line's values costs the same after the setup as before: ${readBefore.n} → ${readAfter.n} for the ${keplRows}-row KEPL line`, readAfter.n === readBefore.n && readAfter.out.counts.rows === keplRows);
  ok(`…and the same for ${readSmall.out.counts.rows} rows as for ${keplRows}: formulas over children issue no query (${readSmall.n})`, readSmall.n === readAfter.n && readSmall.out.counts.rows < keplRows);
  const writeSmall = await counted(() => save([w(R.SEG, 'MIG_WELD_LENGTH', 79)]));
  const writeMany = await counted(() => save([w(R.SEG, 'MIG_WELD_LENGTH', 79.5), w(R.SEG, 'SAW_WELD_LENGTH', 49), w(R.LINE, 'LINEMATCH_JOINTS', 2), w(R.TF, 'WEIGHT', 1100), w(R.BF, 'WEIGHT', 2600), w(R.WEB, 'WEIGHT', 7900)]));
  ok(`an override costs a fixed number of round trips: 1 value ${writeSmall.n}, 6 values on 5 rows ${writeMany.n}`, writeMany.n <= writeSmall.n + 2 && writeSmall.n <= 16, `${writeSmall.n} / ${writeMany.n}`);
  const noDxf = await counted(() => refreshDrawingValues(db, c, KEPL_LINE));
  ok(`a save on a line with no drawing costs ONE more round trip (${noDxf.n})`, noDxf.n === 1 && ['frozen', 'no_drawings'].includes(noDxf.out.skipped));

  // A recipe is tenant setup like any rule: it is listed on its node, and taking it away is followed by the rows.
  const lineRules = await listRules(db, COMPANY, 'classification', node.GIRDER_LINE);
  const studRecipe = lineRules.find((r) => r.specCode === 'STUDS');
  ok('a recipe is listed on its node as what it is (for the rows whose flow reads it)', studRecipe && studRecipe.origin === 'flow' && studRecipe.valueRule === 'defaulted' && studRecipe.formulaCode === 'ASSY_STUDS', JSON.stringify(studRecipe));
  await deleteRule(db, c, studRecipe.id);
  ok('taking a recipe away: the rows that were asked go back to typing the value, and no calculated number is left on them', (await ruleOf(R.LINE, 'STUDS'))?.value_rule === 'entered' && (await ruleOf(R.LINE, 'STUDS')).formula === null && (await ruleOf(R.LINE, 'STUDS')).is_required === 1
    && (await stored(R.LINE, 'STUDS')) === null && (await specOf(R.LINE, 'STUDS')).status === 'missing', JSON.stringify([await ruleOf(R.LINE, 'STUDS'), await stored(R.LINE, 'STUDS')]));
  ok('…the segment, whose recipe stays, is untouched', (await ruleOf(R.SEG, 'STUDS'))?.formula === 'ASSY_STUDS' && (await val(R.SEG, 'STUDS')) === 120);

  // The rule can be made by hand as well: a Defaulted rule that names a formula (the Setup screen's own save).
  const [[anyFormula]] = await db.query("SELECT id FROM cf_formulas WHERE company_id = ? AND code = 'PART_DRILL_THICKNESS' AND deleted_at IS NULL", [COMPANY]);
  let byHand = null; try { byHand = await createRule(db, c, { specificationId: spec.HOLE_DRILL_THICKNESS.id, subjectType: 'master', subjectId: T.IS, captureAt: 'item', valueRule: 'defaulted', isRequired: false, isApplicable: true, formulaId: anyFormula.id }); } catch (e) { byHand = e; }
  ok('a Defaulted rule may name a formula from the Setup screen too', byHand && byHand.valueRule === 'defaulted' && Number(byHand.formulaId) === Number(anyFormula.id), byHand?.problems?.join(' ') ?? byHand?.message);
} catch (e) {
  failed++;
  console.error('  ERROR', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 4).join(' '));
} finally {
  detachNodeCache(db);
  await db.rollback();
  db.release();
  const after = await counts();
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
