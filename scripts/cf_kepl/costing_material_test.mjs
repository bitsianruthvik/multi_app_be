// costing_material_test.mjs — Order costing earns the MATERIAL charge on its share dispatched when "material in place"
// was never observed (an order billed on dispatch, not on a material_in_place milestone). Pure: no database.
// Run: node scripts/cf_kepl/costing_material_test.mjs
import { earnedOf } from '../../apps/cf_erp/services/costingService.js';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass += 1; console.log(`  PASS  ${name}`); } else { fail += 1; console.log(`  FAIL  ${name} ${extra}`); } };

const F = { terms: { charges: [] }, estimate: { material: { quantity: 27.659, rate: 75000, amount: 2074407 }, lumpSums: [] }, opName: new Map() };
const base = { ops: new Map(), fullyOn: null };

let e = earnedOf(F, { ...base, materialShare: 0, shipments: [] });
ok('nothing in place, nothing shipped: material earns 0', e.rows[0].amount === 0, JSON.stringify(e.rows[0]));

e = earnedOf(F, { ...base, materialShare: 0, shipments: [{ frac: 1 }] });
ok('never observed, fully dispatched: the whole material is earned', e.rows[0].amount === 2074407 && /dispatched/.test(e.rows[0].note), JSON.stringify(e.rows[0]));

e = earnedOf(F, { ...base, materialShare: 0, shipments: [{ frac: 0.25 }, { frac: 0.25 }] });
ok('half dispatched: half the material', Math.abs(e.rows[0].amount - 1037203.5) < 0.01, JSON.stringify(e.rows[0]));

e = earnedOf(F, { ...base, materialShare: 0.8, shipments: [{ frac: 0.5 }] });
ok('observed in place beats dispatched when larger', Math.abs(e.rows[0].amount - 1659525.6) < 0.01 && /in place/.test(e.rows[0].note), JSON.stringify(e.rows[0]));

e = earnedOf(F, { ...base, materialShare: 0, shipments: [{ frac: 0.7 }, { frac: 0.7 }] });
ok('shares above 1 are capped', e.rows[0].amount === 2074407);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
