/**
 * part_geometry_test.mjs — reading plate parts from DXF (partGeometry.js, 2026-10-08).
 * Drawings are written in the test, the way CAD writes them.
 *
 *   cd multi_app_be && node scripts/cf_kepl/part_geometry_test.mjs
 */
import { readPartDrawing, orientTo } from '../../apps/cf_erp/services/partGeometry.js';

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const near = (a, b, t = 0.2) => Math.abs(a - b) <= t;

const dxf = (entities, units = 4) => ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(units), '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES', ...entities.flat(), '0', 'ENDSEC', '0', 'EOF'].join('\n');
const line = (x0, y0, x1, y1, layer = '0') => ['0', 'LINE', '8', layer, '10', x0, '20', y0, '11', x1, '21', y1].map(String);
const circle = (cx, cy, r, layer = '0') => ['0', 'CIRCLE', '8', layer, '10', cx, '20', cy, '40', r].map(String);
const arc = (cx, cy, r, a0, a1) => ['0', 'ARC', '8', '0', '10', cx, '20', cy, '40', r, '50', a0, '51', a1].map(String);
const lw = (pts, closed = true) => ['0', 'LWPOLYLINE', '8', 'PART', '90', pts.length, '70', closed ? 1 : 0,
  ...pts.flatMap(([x, y, b]) => ['10', x, '20', y, ...(b ? ['42', b] : [])])].map(String);
const rect = (x, y, l, w) => [line(x, y, x + l, y), line(x + l, y, x + l, y + w), line(x + l, y + w, x, y + w), line(x, y + w, x, y)];

// 1. A plain rectangle from four lines, with two drilled holes and a dimension line.
let g = readPartDrawing(dxf([...rect(10, 20, 500, 300), circle(60, 70, 11), circle(460, 270, 11), line(10, -40, 510, -40, 'DIM')])).geometry;
ok('a rectangle of four lines: 500 × 300', g && near(g.lengthMm, 500) && near(g.widthMm, 300), JSON.stringify(g && [g.lengthMm, g.widthMm]));
ok('…cut round its outline only: 1,600 mm, one piercing', near(g.cutLengthMm, 1600) && g.piercings === 1);
ok('…two 22 mm holes are drilled, not cut', g.holes === 2 && g.holeDiameters.every((d) => near(d, 22)));
ok('…its area is the rectangle less the holes', near(g.areaMm2, 150000 - 2 * Math.PI * 121, 2));
ok('…every side of the rectangle is cut', ['bottom', 'top', 'left', 'right'].every((k) => g.sideCover[k] === 1), JSON.stringify(g.sideCover));

// 2. A triangle gusset (closed polyline): half its rectangle.
g = readPartDrawing(dxf([lw([[0, 0], [400, 0], [0, 300]])])).geometry;
ok('a triangle gusset uses half its rectangle', near(g.usePct, 50), String(g.usePct));
ok('…its cut length is 400 + 300 + 500', near(g.cutLengthMm, 1200));
ok('…the hypotenuse is on no side of the rectangle', g.sideCover.top === 0 && g.sideCover.right === 0 && g.sideCover.bottom === 1 && g.sideCover.left === 1, JSON.stringify(g.sideCover));

// 3. A plate with an inner cut-out (a 100 mm circle — too big to drill) and a slot.
g = readPartDrawing(dxf([...rect(0, 0, 600, 400), circle(300, 200, 50), ...rect(50, 50, 80, 20)])).geometry;
ok('a 100 mm opening and a slot are cut-outs: 3 piercings', g.innerCuts === 2 && g.piercings === 3 && g.holes === 0);
ok('…cut length counts them: 2,000 + 314.2 + 200', near(g.cutLengthMm, 2000 + Math.PI * 100 + 200, 0.5), String(g.cutLengthMm));

// 4. Rounded corners as polyline bulges (radius 20): a 200 × 100 rounded rectangle.
const b = Math.tan(Math.PI / 8);   // a quarter circle
g = readPartDrawing(dxf([lw([[20, 0], [180, 0, b], [200, 20], [200, 80, b], [180, 100], [20, 100, b], [0, 80], [0, 20, b]])])).geometry;
ok('rounded corners from bulges: still 200 × 100', near(g.lengthMm, 200, 0.3) && near(g.widthMm, 100, 0.3), JSON.stringify([g.lengthMm, g.widthMm]));
ok('…cut length 2·160 + 2·60 + 2π·20', near(g.cutLengthMm, 320 + 120 + 2 * Math.PI * 20, 0.5), String(g.cutLengthMm));
ok('…area 200·100 − (4 − π)·20²', near(g.areaMm2, 20000 - (4 - Math.PI) * 400, 5), String(g.areaMm2));

// 5. Lines and arcs drawn in any order and direction close into one outline (a snipe corner).
g = readPartDrawing(dxf([line(0, 0, 300, 0), line(300, 0, 300, 150), line(0, 200, 0, 0), arc(300, 200, 50, 180, 270), line(250, 200, 0, 200)].reverse())).geometry;
ok('mixed lines and an arc, any order: one outline 300 × 200', g && near(g.lengthMm, 300) && near(g.widthMm, 200), JSON.stringify(g && [g.lengthMm, g.widthMm]));
ok('…the snipe shortens two sides of the rectangle', g.sideCover.top < 1 && g.sideCover.right < 1 && g.sideCover.bottom === 1, JSON.stringify(g.sideCover));

// 6. Inches are turned into millimetres.
g = readPartDrawing(dxf(rect(0, 0, 10, 5), 1)).geometry;
ok('a drawing in inches: 254 × 127 mm', near(g.lengthMm, 254) && near(g.widthMm, 127));

// 7. Refusals and warnings.
let r = readPartDrawing(dxf([...rect(0, 0, 100, 100), ...rect(300, 0, 100, 100)]));
ok('two parts in one file are refused in words', !r.geometry && /more than one part/.test(r.problems.join(' ')));
r = readPartDrawing(dxf([line(0, 0, 100, 0), line(100, 0, 100, 50)]));
ok('nothing closed is refused in words', !r.geometry && /No closed outline/.test(r.problems.join(' ')));
r = readPartDrawing('AC1027 binary stuff');
ok('a DWG is refused, saying to export a DXF', !r.geometry && /DWG/.test(r.problems.join(' ')));
r = readPartDrawing(dxf([...rect(0, 0, 100, 100), line(0, -20, 100, -20)]));
ok('a stray open line is ignored with a warning', r.geometry && /do not close/.test(r.warnings.join(' ')));

// 8. Orientation against the row's size.
g = readPartDrawing(dxf(rect(0, 0, 300, 500))).geometry;
let o = orientTo(g, 500, 300);
ok('drawn standing up: matched to the row 500 × 300 by turning it', o.swap === true && o.sizeMatches === true);
o = orientTo(g, 520, 300);
ok('a row size 20 mm off is reported', o.sizeMatches === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
