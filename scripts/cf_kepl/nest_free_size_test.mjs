/**
 * nest_free_size_test.mjs — FREE-SIZE NESTING (user, 2026-11-01: "three modes - standard sizes, standard + custom, free
 * size in a range of length and width"; init.sql §96, nestingService.sizeFreeNests). Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_free_size_test.mjs
 *
 *   1. the choice: 'free' is taken with its range; the range is checked (in words); kept when another choice is made
 *   2. planned free: every plate is sized to its layout — on the order step, with the margins, inside the range, the
 *      pieces' steel — and no catalog size is needed; steel bought is no more than on the catalog plates
 *   3. accepted: the sizes become catalog plates and the plates are saved on them; no company switch needed
 *   4. a range with no longest length and a catalog with no plate of the steel: refused in words
 *   5. nothing survived the rollback
 *
 * ONE TRANSACTION, ROLLED BACK. It owns its fixture (lib/plateRulesFixture.mjs).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.CF_NEST_BUDGET_SCALE = process.env.CF_NEST_BUDGET_SCALE ?? '0.005';
process.env.CF_NEST_AUTO_COMPARE = 'off';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const F = await imp('scripts/cf_kepl/lib/plateRulesFixture.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
const textOf = (e) => [e?.message, ...(e?.details?.problems ?? e?.problems ?? [])].join(' | ');

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'free size test' };
const RANGE = { minLength: 1500, maxLength: 8000, minWidth: 800, maxWidth: 2500 };

try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const fx = await F.buildPlateRulesFixture(conn, { company: COMPANY, parts: [['A', 12, 1200, 400, 4, 'E350', 'BR'], ['B', 12, 900, 300, 4, 'E350', 'BO'], ['C', 16, 800, 400, 2, 'E350', 'BR']] });
  await F.setPlateRules(conn, COMPANY, { gradeRule: 'better', customPlates: null });
  console.log(`  fixture ${fx.tag}: line ${fx.lineId}`);
  const plan = (input = {}) => N.planNesting(conn, COMPANY, fx.lineId, input);
  const nestsOf = (p) => p.groups.flatMap((g) => g.nests);

  section('1. The choice');
  {
    const bad = await refusal(() => N.setNestPlates(conn, c, fx.lineId, { plates: 'free', range: { minLength: 9000, maxLength: 8000 } }));
    ok('a range whose shortest is over its longest is refused in words', !!bad && textOf(bad).includes('The shortest length is more than the longest.'), textOf(bad));
    const neg = await refusal(() => N.setNestPlates(conn, c, fx.lineId, { plates: 'free', range: { maxWidth: -5 } }));
    ok('a length that is not a length is refused', !!neg && textOf(neg).includes('maxWidth must be a length in mm.'), textOf(neg));
    const r = await N.setNestPlates(conn, c, fx.lineId, { plates: 'free', range: RANGE });
    ok("'free' is taken with its range", r.plateChoice === 'free' && J(r.freeRange) === J(RANGE), J(r));
    const r2 = await N.setNestPlates(conn, c, fx.lineId, { plates: 'any' });
    ok('another choice keeps the range, so switching back finds it', r2.plateChoice === 'any' && J(r2.freeRange) === J(RANGE), J(r2));
    await N.setNestPlates(conn, c, fx.lineId, { plates: 'free' });
  }

  section('2. Planned free: every plate sized to its layout');
  let free;
  {
    const catalogPlan = await (async () => { await N.setNestPlates(conn, c, fx.lineId, { plates: 'any' }); const p = await plan({ effort: 'quick' }); await N.setNestPlates(conn, c, fx.lineId, { plates: 'free' }); return p; })();
    free = await plan({ effort: 'quick' });
    const ns = nestsOf(free);
    ok('there are plates, and every one is a free size (a custom plate, not a catalog size)', ns.length > 0 && ns.every((n) => n.customPlate?.free === true), J(ns.map((n) => [n.plateCode, n.customPlate?.free])));
    ok('every size is inside the range', ns.every((n) => n.length >= RANGE.minLength && n.length <= RANGE.maxLength && n.width >= RANGE.minWidth && n.width <= RANGE.maxWidth), J(ns.map((n) => [n.length, n.width])));
    ok('every size holds its layout', ns.every((n) => n.length + 0.001 >= n.requiredLength && n.width + 0.001 >= n.requiredWidth), J(ns.map((n) => [n.length, n.requiredLength, n.width, n.requiredWidth])));
    ok('…on the order step (50) or at the range minimum', ns.every((n) => (n.length % 50 === 0 || n.length === RANGE.minLength) && (n.width % 50 === 0 || n.width === RANGE.minWidth)), J(ns.map((n) => [n.length, n.width])));
    ok("the plate's steel is the pieces' (thickness and grade)", ns.every((n) => n.customPlate.thickness === n.thickness && n.customPlate.grade === n.grade));
    const kg = (p) => nestsOf(p).reduce((a, n) => a + Number(n.weightKg || 0), 0);
    ok('steel bought is no more than on the catalog plates', kg(free) <= kg(catalogPlan) + 0.01, `${kg(free)} vs ${kg(catalogPlan)}`);
    ok('no §90 custom-size proposal on a free line', (free.customPlates ?? []).length === 0);
  }

  section('3. Accepted: the sizes become catalog plates, no company switch needed');
  {
    const out = await N.acceptNesting(conn, c, fx.lineId, free);
    const made = out.customPlates;
    const sizes = new Set(nestsOf(free).map((n) => `${n.thickness}|${n.length}|${n.width}|${n.customPlate.impactClass}`));
    ok('one catalog plate per distinct size made (or reused), the plates saved on them', (made?.created?.length ?? 0) + (made?.reused?.length ?? 0) === sizes.size && out.lots === nestsOf(free).length, J([made, out.lots, [...sizes]]));
    const [lots] = await conn.query("SELECT length_mm, width_mm FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [COMPANY, fx.lineId]);
    ok('the saved plates are at the free sizes', lots.length === nestsOf(free).length && lots.every((l) => Number(l.length_mm) >= RANGE.minLength && Number(l.length_mm) <= RANGE.maxLength), J(lots));
    const again = await plan({ effort: 'quick' });
    ok('planned again, the sizes are the catalog\'s now (inCatalog)', nestsOf(again).every((n) => n.customPlate?.inCatalog === true || n.plateItemId != null), J(nestsOf(again).map((n) => n.customPlate)));
  }

  section('4. No size to work from');
  {
    await conn.query("UPDATE cf_sales_order_lines SET nest_free_range = JSON_OBJECT('minLength', 1000) WHERE company_id = ? AND id = ?", [COMPANY, fx.lineId]);
    await conn.query("UPDATE cf_master_records SET deleted_at = NOW() WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL", [COMPANY, fx.plateNode]);
    N.forgetLine?.(conn, fx.lineId);
    const e = await refusal(() => plan({ effort: 'quick' }));
    const p = e ? null : await plan({ effort: 'quick' }).catch(() => null);
    ok('with no longest length and no plate in the catalog it says to set the range', (e && textOf(e).includes('Set the range')) || (p && (p.problems ?? []).some((x) => x.includes('Set the range'))), e ? textOf(e) : J(p?.problems));
  }
} catch (e) {
  failed += 1; fails.push(`crashed: ${e.message}`); console.log(e);
} finally {
  try { await conn.rollback(); } catch { /* none */ }
  detachNodeCache(conn);
  conn.release();
}

section('5. Nothing survived');
{
  const after = await counts();
  const moved = after.filter((r, i) => Number(r.n) !== Number(before[i].n)).map((r) => r.name);
  ok('every cf_ table has the rows it had', moved.length === 0, moved.join(', '));
}
await pool.end();
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exit(failed ? 1 : 0);
