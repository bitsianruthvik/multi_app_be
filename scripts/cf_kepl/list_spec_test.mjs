/**
 * list_spec_test.mjs — LIST specifications and HOLE_SET (2026-11-01, user: "a linked array store … have the two
 * specifications linked"), and the whole-surface facts of a drawing.
 *
 *   1  lib/listSpec: columns, a typed list, its words, the drawing's holes as a set
 *   2  the formula language: EACH(list, row.X), FIRST past a missing list, the checks
 *   3  the drawing: DRAWN_EDGE_LENGTH (outline + cut-outs + hole walls) and DRAWN_HOLE_SET
 *   4  resolution: HOLE_SET defaulted from the drawing, HOLES its count, a typed set over it, the whole surface
 *   5  the services (local company 2, ONE rolled-back transaction): a list spec, a typed value, a formula, a rule
 *
 *   cd multi_app_be && node scripts/cf_kepl/list_spec_test.mjs
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { parseFormula, evaluateFormula } from '../../apps/cf_erp/services/formulaEngine.js';
import { workOutFormulas } from '../../apps/cf_erp/services/resolutionService.js';
import { factsOfShape } from '../../apps/cf_erp/services/drawingValueService.js';
import { checkListConfig, checkListValue, listSummary, holeSetOf, sameList, HOLE_SET_CONFIG } from '../../apps/cf_erp/lib/listSpec.js';
import { createSpec } from '../../apps/cf_erp/services/specificationService.js';
import { createFormula, checkFormula } from '../../apps/cf_erp/services/formulaService.js';
import { createRule } from '../../apps/cf_erp/services/assignmentService.js';
import { coerce } from '../../apps/cf_erp/services/valueService.js';
import { FORMULAS, CNC_DRILL } from './coats-holes-cleanup.mjs';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const near = (a, b, tol = 1e-6) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;

/* 1 ------------------------------------------------------------------------ */
console.log('\n  1. lib/listSpec');
ok('HOLE_SET\'s columns pass', !checkListConfig(HOLE_SET_CONFIG).problem);
ok('a list with no columns is refused', !!checkListConfig({ columns: [] }).problem && !!checkListConfig(null).problem);
ok('a column twice is refused', !!checkListConfig({ columns: [{ code: 'A' }, { code: 'a' }] }).problem);
const typed = checkListValue('HOLE_SET', HOLE_SET_CONFIG, [{ dia: '22', count: 12 }, { DIA: 26, COUNT: 4, KIND: 'Countersunk', DEPTH: 40 }, { DIA: '', COUNT: '' }]);
ok('a typed list: numbers read, words matched to their option, empty rows dropped', JSON.stringify(typed.rows) === JSON.stringify([{ DIA: 22, COUNT: 12 }, { DIA: 26, COUNT: 4, KIND: 'countersunk', DEPTH: 40 }]), JSON.stringify(typed));
ok('a required cell left out is refused, in words', /Holes is needed/.test(checkListValue('HOLE_SET', HOLE_SET_CONFIG, [{ DIA: 22 }]).problem ?? ''));
ok('a count must be whole', /whole number/.test(checkListValue('HOLE_SET', HOLE_SET_CONFIG, [{ DIA: 22, COUNT: 1.5 }]).problem ?? ''));
ok('a kind not in the list is refused', /not one of/.test(checkListValue('HOLE_SET', HOLE_SET_CONFIG, [{ DIA: 22, COUNT: 1, KIND: 'burnt' }]).problem ?? ''));
ok('an unknown column is refused', /no column/.test(checkListValue('HOLE_SET', HOLE_SET_CONFIG, [{ DIA: 22, COUNT: 1, X: 1 }]).problem ?? ''));
ok('a plain value is not a list', !!checkListValue('HOLE_SET', HOLE_SET_CONFIG, 5).problem);
ok('an empty list is a value (no holes)', JSON.stringify(checkListValue('HOLE_SET', HOLE_SET_CONFIG, []).rows) === '[]');
ok('its words', listSummary(HOLE_SET_CONFIG, typed.rows) === '12 × Ø22 · 4 × Ø26 countersunk (40 deep)' && listSummary(HOLE_SET_CONFIG, []) === 'none', listSummary(HOLE_SET_CONFIG, typed.rows));
ok('the drawing\'s holes as a set: one row per diameter, the commonest first', JSON.stringify(holeSetOf([22, 22, 26, 22, 26.04])) === JSON.stringify([{ DIA: 22, COUNT: 3, KIND: 'drilled' }, { DIA: 26, COUNT: 2, KIND: 'drilled' }]));
ok('sameList compares rows by value', sameList([{ DIA: 22, COUNT: 3 }], [{ COUNT: 3, DIA: 22 }]) && !sameList([{ DIA: 22, COUNT: 3 }], [{ DIA: 22, COUNT: 4 }]));

/* 2 ------------------------------------------------------------------------ */
console.log('\n  2. EACH in the formula language');
const holes = [{ DIA: 22, COUNT: 12, KIND: 'drilled' }, { DIA: 26, COUNT: 4, KIND: 'countersunk', DEPTH: 40 }];
const chart = { axes: [{ field: 'HOLE_DIA' }, { field: 'THICKNESS' }], mode: 'linear', rows: [[21, 10, 50], [21, 20, 80], [21, 40, 180], [26, 10, 55], [26, 20, 100], [26, 40, 210]] };
const ctx = (list) => ({ item: (c) => ({ THICKNESS: 20, HOLES: 7, HOLE_DRILL_THICKNESS: 20 })[c] ?? null, machine: () => null, itemLevel: () => null,
  itemTable: (c) => (c === 'HOLE_SET' ? list : null), machineTable: (c) => (c === 'CNC_DRILL_TIME' ? chart : null) });
const timing = (f, list = holes) => evaluateFormula(parseFormula(f), () => null, null, ctx(list));
ok('EACH adds an expression over the rows', timing('EACH(item.HOLE_SET, row.COUNT)').value === 16);
ok('row words compare: IF(row.KIND = "drilled", …)', timing('EACH(item.HOLE_SET, IF(row.KIND = "drilled", row.COUNT, 0))').value === 12);
const cnc = timing(CNC_DRILL);
// 12 holes Ø22 through 20 → between Ø21 (80) and Ø26 (100) at 20 = 84 s; 4 holes Ø26 through 40 = 210 s → (12×84 + 4×210)/60
ok('CNC drilling times every row at its own diameter and depth', near(cnc.value, (12 * 84 + 4 * 210) / 60, 1e-4), JSON.stringify(cnc));
ok('an empty list is 0', timing('EACH(item.HOLE_SET, row.COUNT)', []).value === 0);
ok('a list not there makes it wait, named', JSON.stringify(timing('EACH(item.HOLE_SET, row.COUNT)', null).missing) === '["item · HOLE_SET"]');
ok('FIRST falls back past a missing list', timing('FIRST(EACH(item.HOLE_SET, row.COUNT), item.HOLES)', null).value === 7);
ok('a missing cell says which row', JSON.stringify(timing('EACH(item.HOLE_SET, row.DEPTH)').missing) === '["item.HOLE_SET row 1 · DEPTH"]');
const refuses = (f, re) => { try { parseFormula(f); return false; } catch (e) { return re.test(e.message); } };
ok('row.X outside EACH is refused', refuses('row.DIA * 2', /inside EACH/));
ok('EACH inside EACH is refused', refuses('EACH(A, EACH(B, row.X))', /inside another EACH/));
ok('EACH needs a list and an expression', refuses('EACH(A)', /EACH takes a list/));
ok('the list is reported as a list read, not a number', JSON.stringify(parseFormula('EACH(item.HOLE_SET, row.COUNT)').lookupRefs) === JSON.stringify([{ role: 'item', code: 'HOLE_SET', arity: 0, list: true }]));
ok('LOOKUP on a list says to use EACH', /EACH/.test(timing('LOOKUP(item.HOLE_SET, 1)').error ?? ''));

/* 3 ------------------------------------------------------------------------ */
console.log('\n  3. what the drawing says');
const f = factsOfShape({ areaMm2: 100000, cutLengthMm: 1400, holes: 3, holeDiameters: [22, 22, 26] });
ok('DRAWN_EDGE_LENGTH = outline and cut-outs + the walls of its holes', near(f.DRAWN_EDGE_LENGTH, Math.round((1400 + Math.PI * 70) * 1000) / 1000), String(f.DRAWN_EDGE_LENGTH));
ok('DRAWN_HOLE_SET = the holes by diameter', JSON.stringify(f.DRAWN_HOLE_SET) === JSON.stringify([{ DIA: 22, COUNT: 2, KIND: 'drilled' }, { DIA: 26, COUNT: 1, KIND: 'drilled' }]));
ok('a drawing with no holes: an empty set (none), not no value', JSON.stringify(factsOfShape({ areaMm2: 5, cutLengthMm: 10, holes: 0, holeDiameters: [] }).DRAWN_HOLE_SET) === '[]');
ok('a drawing not read for holes: no set', factsOfShape({ areaMm2: 5 }).DRAWN_HOLE_SET === null && factsOfShape({ areaMm2: 5 }).DRAWN_EDGE_LENGTH === null);

/* 4 ------------------------------------------------------------------------ */
console.log('\n  4. resolution');
const parse = (e) => { try { return parseFormula(e); } catch (err) { return err; } };
const entry = (id, code, dataType, rule, value = null, extra = {}) => ({
  spec: { id, code, dataType, decimals: null, unit: null, tableConfig: dataType === 'list' ? HOLE_SET_CONFIG : null }, rule, value, applicable: true, captureAt: 'item', ...extra,
});
const formula = (code) => ({ code, expression: FORMULAS[code].expression });
const plate = (typedHoles = null, facts = new Map([['TRUE_AREA', 1e6 - 3 * 380], ['DRAWN_EDGE_LENGTH', 4000 + Math.PI * 66], ['DRAWN_HOLES', 3], ['DRAWN_HOLE_SET', [{ DIA: 22, COUNT: 3, KIND: 'drilled' }]]])) => {
  const specs = [
    entry(1, 'LENGTH', 'number', { valueRule: 'entered' }, { raw: 1000, source: 'entered' }),
    entry(2, 'WIDTH', 'number', { valueRule: 'entered' }, { raw: 1000, source: 'entered' }),
    entry(3, 'THICKNESS', 'number', { valueRule: 'entered' }, { raw: 20, source: 'entered' }),
    entry(4, 'HOLE_SET', 'list', { valueRule: 'defaulted', formula: formula('PART_HOLE_SET') }, typedHoles ? { raw: typedHoles, source: 'entered' } : null),
    entry(5, 'HOLES', 'number', { valueRule: 'defaulted', formula: formula('PART_HOLES') }),
    entry(6, 'SURFACE_AREA', 'number', { valueRule: 'defaulted', formula: formula('PART_PLATE_AREA') }),
  ];
  workOutFormulas(specs, { parse, optionById: new Map(), effectiveRows: new Map(), facts });
  return Object.fromEntries(specs.map((s) => [s.spec.code, s]));
};
const p1 = plate();
ok('HOLE_SET is the drawing\'s set, from the drawing', JSON.stringify(p1.HOLE_SET.value?.raw) === '[{"DIA":22,"COUNT":3,"KIND":"drilled"}]' && p1.HOLE_SET.derived?.source === 'drawing', JSON.stringify(p1.HOLE_SET));
ok('…shown in words', p1.HOLE_SET.value?.display === '3 × Ø22');
ok('HOLES is the set\'s count, said to come from the drawing', p1.HOLES.value?.raw === 3 && p1.HOLES.derived?.source === 'drawing', JSON.stringify(p1.HOLES));
const p2 = plate([{ DIA: 22, COUNT: 3 }, { DIA: 18, COUNT: 4, KIND: 'tapped' }]);
ok('a typed set stands over the drawing\'s, with the drawing\'s beside it', p2.HOLE_SET.derived?.source === 'typed' && p2.HOLE_SET.derived?.calculated?.display === '3 × Ø22', JSON.stringify(p2.HOLE_SET.derived));
ok('…and HOLES follows the typed set', p2.HOLES.value?.raw === 7, JSON.stringify(p2.HOLES.value));
const p3 = plate([{ DIA: 22, COUNT: 3, KIND: 'drilled' }]);
ok('a typed set equal to the drawing\'s is the drawing\'s', p3.HOLE_SET.status === 'default' && p3.HOLE_SET.derived?.held === true);
const whole = (2 * (1e6 - 3 * 380) + (4000 + Math.PI * 66) * 20) / 1e6;
ok('SURFACE_AREA is the WHOLE surface: both faces + edges and hole walls', near(p1.SURFACE_AREA.value?.raw, whole, 1e-5), `${p1.SURFACE_AREA.value?.raw} vs ${whole}`);
const p4 = plate(null, new Map());
ok('no drawing: both faces of the rectangle + its perimeter × thickness', near(p4.SURFACE_AREA.value?.raw, (2 * 1e6 + 4000 * 20) / 1e6) && p4.HOLE_SET.value == null && p4.HOLES.value == null);
const section = evaluateFormula(parseFormula(FORMULAS.PART_SECTION_AREA.expression), (c) => ({ SECTION_AREA: 1900, THICKNESS: 10, LENGTH: 2000, DEPTH: 100, WIDTH: 100 })[c] ?? null);
ok('a profile part: girth (2 × area ÷ thickness) × length + two ends', near(section.value, (380 * 2000 + 2 * 1900) / 1e6), JSON.stringify(section));
const kid = (label, quantity, area, family) => ({ label, quantity, get: (c) => (c === 'SURFACE_AREA' ? area : null), word: (c) => (c === 'FAMILY' ? family : null) });
const assy = evaluateFormula(parseFormula(FORMULAS.CG_ASSY_SURFACE_AREA.expression), () => null, [kid('WEB', 1, 2.5, { code: 'FABRICATED', name: 'Fabricated' }), kid('TF', 2, 1, { code: 'FABRICATED', name: 'Fabricated' }), kid('BOLT', 40, null, { code: 'BOUGHT', name: 'Bought out' })]);
ok('an assembly sums its parts, and does not wait for a bolt set', assy.value === 4.5, JSON.stringify(assy));

/* 5 ------------------------------------------------------------------------ */
console.log('\n  5. the services (company 2, rolled back)');
const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const c = { companyId: 2, userId: null };
  const stamp = Date.now().toString(36).toUpperCase();
  const HS = `HS_${stamp}`; const DHS = `DHS_${stamp}`;
  const hs = await createSpec(db, c, { code: HS, name: 'Holes (test)', dataType: 'list', tableConfig: HOLE_SET_CONFIG });
  await createSpec(db, c, { code: DHS, name: 'Drawn holes (test)', dataType: 'list', tableConfig: HOLE_SET_CONFIG });
  ok('a list specification is created with its columns', hs.dataType === 'list' && hs.tableConfig?.columns?.length === 4, JSON.stringify(hs).slice(0, 200));
  let bad = null; try { await createSpec(db, c, { code: `BAD_${stamp}`, name: 'x', dataType: 'list', tableConfig: { columns: [] } }); } catch (e) { bad = e; }
  ok('a list with no columns is refused', !!bad);
  bad = null; try { await createSpec(db, c, { code: `BAD2_${stamp}`, name: 'x', dataType: 'list', tableConfig: HOLE_SET_CONFIG, orderLevel: true }); } catch (e) { bad = e; }
  ok('a list cannot be set for a whole order', !!bad);
  const [[row]] = await db.query('SELECT * FROM cf_specifications WHERE company_id = 2 AND code = ?', [HS]);
  const co = await coerce(db, 2, row, [{ DIA: 22, COUNT: 6 }]);
  ok('a typed list is stored as value_json', JSON.stringify(co.typed?.value_json) === '[{"DIA":22,"COUNT":6}]', JSON.stringify(co));
  ok('…and a plain value refused for it', !!(await coerce(db, 2, row, 'six')).problem);
  ok('a formula that is one list\'s name passes', (await checkFormula(db, 2, DHS)).problems.length === 0, JSON.stringify((await checkFormula(db, 2, DHS)).problems));
  ok('EACH over a list passes', (await checkFormula(db, 2, `EACH(${HS}, row.COUNT)`)).problems.length === 0);
  ok('a list read as a number is refused', /is a list/.test((await checkFormula(db, 2, `${HS} + 1`)).problems.join()));
  const fl = await createFormula(db, c, { code: `F_${stamp}`, name: 'from drawn', expression: DHS });
  const [[nodeRow]] = await db.query("SELECT id FROM cf_classification_nodes WHERE company_id = 2 AND deleted_at IS NULL AND scope = 'item' ORDER BY id DESC LIMIT 1");
  const rule = await createRule(db, c, { specificationId: hs.id, subjectType: 'classification', subjectId: nodeRow.id, captureAt: 'item', valueRule: 'defaulted', formulaId: fl.id });
  ok('a list rule defaulted from another list is accepted', rule?.valueRule === 'defaulted', JSON.stringify(rule).slice(0, 200));
  const [[num]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = 2 AND data_type = 'number' AND deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1");
  bad = null; try { await createRule(db, c, { specificationId: num.id, subjectType: 'classification', subjectId: nodeRow.id, captureAt: 'item', valueRule: 'defaulted', formulaId: fl.id }); } catch (e) { bad = e; }
  ok('a number rule cannot take a list formula', !!bad && /list/.test(JSON.stringify(bad)), JSON.stringify(bad));
} catch (e) {
  failed++; console.log('  FAIL  services —', e.stack ?? e.message);
} finally {
  await db.rollback(); db.release();
}

console.log(`\n  ${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
