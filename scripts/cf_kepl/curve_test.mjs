/**
 * curve_test.mjs — an order line on a curved track (curveService.js, init.sql §98; user, 2026-11-01). Local only;
 * the database part is ONE TRANSACTION, ROLLED BACK.
 *   cd multi_app_be && node scripts/cf_kepl/curve_test.mjs
 *
 *   1. the RDSO rule reproduces the drawings: at 4° the geometric half-versine of each span is within 5 mm of the
 *      series' stated eccentricity (18.3 m 56, 24.4 m 97 / 99, 30.5 m 150) — girders on chords
 *   2. scaled to the site: 2° gives half the 4° eccentricity, +100 standard; radius 15.25 / sin(D/2)
 *   3. beyond the series (5°) → a problem in words; a straight-only series refuses any curve; no rule → says so
 *   4. the layout: angle between spans 2·asin(L/2R), the outer gap opening = spacing × angle, the plan SVG
 *   5. saved on a line through the service: read back; 5° refused and nothing saved; 0 clears it
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const C = await imp('apps/cf_erp/services/curveService.js');

let passed = 0; let failed = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 600)}` : ''}`); } };
const J = (v) => JSON.stringify(v);
const rule = (e4, overallMm) => ({ maxDeg: 4, eccentricityAtMaxMm: e4, standardEccentricityMm: 100, layout: 'chords', girderSpacingMm: 2400, overallMm });

for (const [name, e4, L] of [['18.3 m (11753R3 / 11767)', 56, 19250], ['24.4 m (11751R3)', 97, 25550], ['24.4 m (11766)', 99, 25550], ['30.5 m (11754R3 / 11765)', 150, 31860]]) {
  const c = C.curveOf(rule(e4, L), 4);
  ok(`1. ${name}: at 4° the chords' half-versine ${c.results.halfVersineMm} mm is within 6 mm of the drawing's ${e4} mm`, Math.abs(c.results.halfVersineMm - e4) <= 6, J(c.results));
}
const r = rule(56, 19250);
const c2 = C.curveOf(r, 2); const c4 = C.curveOf(r, 4);
ok('2. 2° gives half the 4° eccentricity for curvature, and the 100 mm standard on top', c2.results.eccentricityCurveMm === 28 && c2.results.eccentricityTotalMm === 128 && c4.results.eccentricityTotalMm === 156, J([c2.results, c4.results]));
ok('…radius by the 30.5 m chord: 4° → 437 m, 2° → 873.8 m', c4.results.radiusM === 437 && c2.results.radiusM === 873.8, J([c4.results.radiusM, c2.results.radiusM]));
const c5 = C.curveOf(r, 5);
ok('3. 5° on a series up to 4°: said in words', c5.problems.length === 1 && /up to 4°; a 5° curve is outside it/.test(c5.problems[0]), J(c5.problems));
const straight = C.curveOf({ maxDeg: 0, note: 'straight only' }, 1);
ok('…a straight-only series refuses any curve', !straight.available && /straight alignment only/.test(straight.problems[0] ?? ''), J(straight));
const none = C.curveOf(null, 2);
ok('…no rule on the standard: says so, nothing worked out', !none.available && none.results === null && /does not say/.test(none.note), J(none));
const c43 = C.curveOf(r, 4, { spans: 3 });
const theta = 2 * Math.asin(19.25 / (2 * 437.0)) * 180 / Math.PI;
ok('4. angle between spans = 2·asin(L/2R); outer gap opening = 2400 × angle; the run turns by (n−1) × angle', Math.abs(c43.results.angleBetweenSpansDeg - theta) < 0.01 && Math.abs(c43.results.outerGapOpeningMm - 2400 * theta * Math.PI / 180) < 0.5 && Math.abs(c43.results.turnDeg - 2 * theta) < 0.02, J(c43.results));
const svg = C.curveSvg(c43, r);
ok('…the plan: an SVG with the track arc and two girders per span', typeof svg === 'string' && svg.startsWith('<svg') && (svg.match(/stroke="#2563eb"/g) ?? []).length === 6 && svg.includes('stroke="#dc2626"'), svg?.slice(0, 200));

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const [[line]] = await conn.query("SELECT l.id, l.company_id FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.status NOT IN ('closed','cancelled','revised','lost') WHERE l.deleted_at IS NULL ORDER BY l.id LIMIT 1");
  const [[std]] = await conn.query('SELECT id FROM cf_standard_drawings WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [line.company_id]);
  let sid = std?.id;
  if (!sid) { const [ins] = await conn.query("INSERT INTO cf_standard_drawings (company_id, number, name) VALUES (?, 'CURVE-TEST', 'curve test')", [line.company_id]); sid = ins.insertId; }
  await conn.query('UPDATE cf_standard_drawings SET curve_json = ? WHERE id = ?', [J(r), sid]);
  await conn.query('UPDATE cf_sales_order_lines SET standard_id = ?, curve_deg = NULL WHERE id = ?', [sid, line.id]);
  const c = { companyId: line.company_id, userId: null };
  const a = await C.setLineCurve(conn, c, line.id, { deg: 3 });
  ok('5. saved on a line: 3° read back with its layout and plan', a.deg === 3 && a.results?.eccentricityCurveMm === 42 && typeof a.svg === 'string', J({ deg: a.deg, results: a.results }));
  let refused = null; try { await C.setLineCurve(conn, c, line.id, { deg: 5 }); } catch (e) { refused = e; }
  const back = await C.lineCurve(conn, line.company_id, line.id);
  ok('…5° refused in words, the 3° kept', refused?.code === 'OUT_OF_SERIES' && back.deg === 3, `${refused?.message} / ${back.deg}`);
  const z = await C.setLineCurve(conn, c, line.id, { deg: 0 });
  ok('…0 clears it (straight)', z.deg === null && z.results === null, J(z));
} catch (e) { failed += 1; fails.push(`crashed: ${e.message}`); console.log(e); } finally { await conn.rollback(); conn.release(); await pool.end(); }
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exit(failed ? 1 : 0);
