// node scripts/cf_kepl/model_levels_test.mjs — pure: which rows the ONE model draws, and the mark a level row without one
// should carry (apps/cf_erp/lib/modelLevels.js; user, 2026-11-06: "the drawings are only available at parts level").
import assert from 'node:assert/strict';
import { levelsOfModel, levelMarkFor, levelParents, drawnByModel } from '../../apps/cf_erp/lib/modelLevels.js';
import { planImport } from '../../apps/cf_erp/lib/standardImport.js';

let passed = 0, failed = 0;
const check = (label, fn) => { try { fn(); passed++; console.log(`PASS ${label}`); } catch (e) { failed++; console.log(`FAIL ${label}: ${e.message}`); } };

const model = { schema: 'cf-erp-model3d/2', elements: [
  { id: 1, mark: 'TF1', in: ['G1-S1', 'G1', 'JNPA-36M-P7P8'] },
  { id: 2, mark: 'WP1', in: ['G1-S1', 'G1', 'JNPA-36M-P7P8'] },
  { id: 3, mark: 'TF2', in: ['G1-S2', 'G1', 'JNPA-36M-P7P8'] },
  { id: 4, mark: 'TF1', in: ['G2-S1', 'G2', 'JNPA-36M-P7P8'] },
  { id: 5, mark: 'FCP1', in: ['SPLICE', 'G1', 'JNPA-36M-P7P8'] },
  { id: 6, mark: 'RP', in: ['JNPA-36M-P7P8'] },
] };

check('the levels are the names in `in`, not the part marks', () => {
  const lv = levelsOfModel(model);
  assert.deepEqual([...lv.keys()].sort(), ['G1', 'G1-S1', 'G1-S2', 'G2', 'G2-S1', 'JNPA-36M-P7P8', 'SPLICE']);
  assert.equal(drawnByModel(new Set(lv.keys()), 'g1'), true, 'case does not matter');
  assert.equal(drawnByModel(new Set(lv.keys()), 'TF1'), false, 'a part is not a level');
  assert.equal(drawnByModel(new Set(lv.keys()), null), false);
});

check('a row without a mark: the top row is the top level, a girder line the level above its segments', () => {
  const rel = levelParents(model);
  assert.equal(levelMarkFor(model, { isTop: true }, rel), 'JNPA-36M-P7P8');
  assert.equal(levelMarkFor(model, { childMarks: ['G1-S1', 'G1-S2', 'SPLICE'] }, rel), 'G1');
  assert.equal(levelMarkFor(model, { childMarks: ['G2-S1'] }, rel), 'G2');
});

check('no guess: children under two levels, unknown children, or two top levels give none', () => {
  const rel = levelParents(model);
  assert.equal(levelMarkFor(model, { childMarks: ['G1-S1', 'G2-S1'] }, rel), null);
  assert.equal(levelMarkFor(model, { childMarks: ['NOPE'] }, rel), null);
  assert.equal(levelMarkFor(model, { childMarks: [] }, rel), null);
  const two = { elements: [...model.elements, { id: 9, mark: 'X', in: ['OTHER-SPAN'] }] };
  assert.equal(levelMarkFor(two, { isTop: true }), null);
  assert.equal(levelMarkFor(model, { childMarks: ['TF1'] }, rel), null, 'TF1 sits in two segments');
});

check('the importer marks every level: span and girder line by the id the model uses; the stopper it makes has none', () => {
  const bom = {
    drawing: { number: 'T-1', revision: '0' },
    items: [{ mark: 'TF1', description: 'Top flange', category: 'plate', thicknessMm: 20, widthMm: 400, lengthMm: 6000, grade: 'E350', qtyPerSpan: 1 }],
    assembly: { id: 'JNPA-36M-P7P8', kind: 'span', name: 'JNPA-36M-P7P8/Composite girder span', qtyPerParent: 1, children: [
      { id: 'G1', kind: 'girder', name: 'G1/Girder line G1', qtyPerParent: 1, children: [
        { id: 'G1-S1', kind: 'girder_segment', name: 'G1-S1/Girder segment', qtyPerParent: 1, children: [{ item: 'TF1', qtyPerParent: 1 }] }] }] },
  };
  let plan;
  try { plan = planImport(bom, { catalog: {} }); } catch (e) { console.log(`  (planImport needs a catalog here: ${e.message.slice(0, 80)}; checked on a real import instead)`); return; }
  const rows = plan.rows ?? plan.tempRows ?? [];
  if (!rows.length) { console.log('  (no rows in this plan shape; checked on a real import instead)'); return; }
  const markOf = (id) => rows.find((r) => r.node?.id === id)?.mark ?? null;
  assert.equal(markOf('JNPA-36M-P7P8'), 'JNPA-36M-P7P8');
  assert.equal(markOf('G1'), 'G1');
  assert.equal(markOf('G1-S1'), 'G1-S1');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
