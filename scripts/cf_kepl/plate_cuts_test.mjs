/**
 * plate_cuts_test.mjs — a cut plate's cut length from its nest (plateCutsService, 2026-10-08).
 * Pure geometry: perimeter less half of every edge shared with a neighbour one kerf away.
 *
 *   cd multi_app_be && node scripts/cf_kepl/plate_cuts_test.mjs
 */
import { cutLengthsOnPlate } from '../../apps/cf_erp/services/plateCutsService.js';

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// Alone: its perimeter.
let m = cutLengthsOnPlate([{ key: 'a', x: 3, y: 3, length: 100, width: 50 }], 3);
ok('a piece alone is cut round its perimeter: 2 × (100 + 50) = 300', near(m.get('a'), 300), m.get('a'));

// Side by side one kerf apart: the 50 mm edge is cut once for both.
m = cutLengthsOnPlate([{ key: 'a', x: 3, y: 3, length: 100, width: 50 }, { key: 'b', x: 106, y: 3, length: 100, width: 50 }], 3);
ok('two pieces one kerf apart share one 50 mm cut: 275 each', near(m.get('a'), 275) && near(m.get('b'), 275), JSON.stringify([...m]));

// One above the other, overlapping only part of the edge.
m = cutLengthsOnPlate([{ key: 'a', x: 3, y: 3, length: 100, width: 50 }, { key: 'b', x: 53, y: 56, length: 100, width: 50 }], 3);
ok('stacked, sharing 50 mm of a 100 mm edge: 275 each', near(m.get('a'), 275) && near(m.get('b'), 275), JSON.stringify([...m]));

// A sequence gap (8 mm) is not a shared cut.
m = cutLengthsOnPlate([{ key: 'a', x: 3, y: 3, length: 100, width: 50 }, { key: 'b', x: 111, y: 3, length: 100, width: 50 }], 3);
ok('8 mm apart (a sequence gap) is two cuts', near(m.get('a'), 300) && near(m.get('b'), 300), JSON.stringify([...m]));

// Corner to corner only: no edge shared.
m = cutLengthsOnPlate([{ key: 'a', x: 3, y: 3, length: 100, width: 50 }, { key: 'b', x: 106, y: 56, length: 100, width: 50 }], 3);
ok('touching only at a corner shares nothing', near(m.get('a'), 300) && near(m.get('b'), 300), JSON.stringify([...m]));

// A row of three: the middle one shares two edges.
m = cutLengthsOnPlate([0, 1, 2].map((i) => ({ key: `p${i}`, x: 3 + i * 103, y: 3, length: 100, width: 50 })), 3);
ok('a row of three: ends 275, middle 250', near(m.get('p0'), 275) && near(m.get('p1'), 250) && near(m.get('p2'), 275), JSON.stringify([...m]));

// No layout: its perimeter.
m = cutLengthsOnPlate([{ key: 'a', x: null, y: null, length: 100, width: 50 }, { key: 'b', x: 106, y: 3, length: 100, width: 50 }], 3);
ok('a piece with no place on the plate keeps its perimeter', near(m.get('a'), 300) && near(m.get('b'), 300), JSON.stringify([...m]));

// A 2 × 2 block: each shares one long and one short edge.
m = cutLengthsOnPlate([[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => ({ key: `${i}${j}`, x: 3 + i * 103, y: 3 + j * 53, length: 100, width: 50 })), 3);
ok('a 2 × 2 block: 300 − 25 − 50 = 225 each', [...m.values()].every((v) => near(v, 225)), JSON.stringify([...m]));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
