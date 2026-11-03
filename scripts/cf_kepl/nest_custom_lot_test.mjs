/**
 * nest_custom_lot_test.mjs — CUSTOM PLATES UNDER THE MILL'S RULES (user, 2026-11-02): width 1250–3000, length 6000–14000, a
 * size only in a lot of 5 pieces or 20 tonnes over the order; standard sizes no rule. Pure, no database.
 *   cd multi_app_be && node scripts/cf_kepl/nest_custom_lot_test.mjs
 */
import assert from 'node:assert/strict';
import { customPlateInput, customPlateSetting, lotCandidates, lotKey, lotPasses, lotRuleOf, lotSizeAllowed } from '../../apps/cf_erp/services/nestCustomPlate.js';

let passed = 0; let failed = 0;
const check = (label, fn) => { try { fn(); passed += 1; console.log(`  PASS  ${label}`); } catch (e) { failed += 1; console.log(`  FAIL  ${label}: ${e.message}`); } };
const limits = { maxLength: 14000, maxWidth: 3000, minLength: 6000, minWidth: 1250, step: 50 };

check('the setting keeps the lot, and says nothing of one when none is stated', () => {
  const s = customPlateSetting({ on: true, ...limits, minLotPieces: 5, minLotTonnes: 20 });
  assert.equal(s.minLotPieces, 5); assert.equal(s.minLotTonnes, 20);
  assert.ok(!('minLotPieces' in customPlateSetting({ on: true, ...limits })));
  assert.equal(lotRuleOf(customPlateSetting({ on: true, ...limits })), null);
});
check('a lot that is no number is refused in words', () => {
  assert.ok(customPlateInput({ on: true, ...limits, minLotPieces: 'x' }).problems.some((p) => /pieces/.test(p)));
  assert.equal(customPlateInput({ on: true, ...limits, minLotPieces: 5, minLotTonnes: 20 }).problems.length, 0);
});
check('a size holds its lot on EITHER count', () => {
  const rule = lotRuleOf({ minLotPieces: 5, minLotTonnes: 20 });
  assert.equal(lotPasses(rule, 5, 1000), true);
  assert.equal(lotPasses(rule, 2, 20000), true);
  assert.equal(lotPasses(rule, 4, 19999), false);
});
check('a size is the same size either way round', () => assert.equal(lotKey(12, 12000, 2000), lotKey(12, 2000, 12000)));
const webs = [{ length: 12161, width: 1491, qty: 12 }, { length: 9124, width: 1585, qty: 16 }, { length: 400, width: 300, qty: 40 }];
check('every size offered lies within the limits, on the step', () => {
  const sizes = lotCandidates(webs, { limits, kerf: 3, thickness: 12 });
  assert.ok(sizes.length > 0);
  for (const z of sizes) {
    assert.ok(z.length >= 6000 && z.length <= 14000, `length ${z.length}`);
    assert.ok(z.width >= 1250 && z.width <= 3000, `width ${z.width}`);
    assert.equal(z.length % 50, 0); assert.equal(z.width % 50, 0);
  }
});
check('the long pieces can go on what is offered', () => {
  const sizes = lotCandidates(webs, { limits, kerf: 3, thickness: 12 });
  assert.ok(sizes.some((z) => z.length >= 12161 + 20 && z.width >= 1491 + 20));
  assert.ok(sizes.some((z) => z.length >= 9124 + 20 && z.width >= 1585 + 20));
});
check('a size refused is not offered again', () => {
  const sizes = lotCandidates(webs, { limits, kerf: 3, thickness: 12 });
  const removed = new Set([lotKey(12, sizes[0].length, sizes[0].width)]);
  assert.ok(!lotCandidates(webs, { limits, kerf: 3, thickness: 12, removed }).some((z) => z.length === sizes[0].length && z.width === sizes[0].width));
});
check('settled sizes let no other custom size in; none settled means none', () => {
  const a = lotKey(12, 9150, 1650); const b = lotKey(12, 12050, 2300);
  assert.equal(lotSizeAllowed(b), true);
  assert.equal(lotSizeAllowed(b, { removed: new Set([b]) }), false);
  assert.equal(lotSizeAllowed(b, { only: new Set([a]) }), false);
  assert.equal(lotSizeAllowed(a, { only: new Set([a]), removed: new Set([a]) }), false);
  assert.equal(lotSizeAllowed(a, { only: new Set() }), false);
});
check('a piece beyond the limits asks for no size', () => assert.deepEqual(lotCandidates([{ length: 17550, width: 1200, qty: 4 }], { limits }), []));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
