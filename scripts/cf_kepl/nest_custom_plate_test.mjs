/**
 * nest_custom_plate_test.mjs — THE AI PROPOSES ONE CUSTOM PLATE SIZE PER STEEL, WITHIN THE MILL'S SIZES, AND IT IS
 * ADDED TO THE CATALOG WHEN THAT NESTING IS USED (user, 2026-10-18, item 20; init.sql §90, services/nestCustomPlate.js).
 * Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_custom_plate_test.mjs
 *
 *   1. the proposal itself (pure): the setting, its checks, the limits (set, else the catalog's range), the size picked by
 *      cost — within the limits, on the order step, with the ordering margins; nothing when tight / off / over the size limit
 *   2. off by default: every plate a catalog plate, no custom size
 *   3. on: the slack plates move to the size they need — "custom size, not in the catalog yet"; steel bought falls by the
 *      saving; the plate's steel is the pieces' (grade, the strictest impact class asked)
 *   4. accepted through the plate-change gate (with its before / after sheet): the custom sizes become CATALOG PLATES
 *      first — code by the coding rule, values by the rules, HSN / GST / rate from the nearest plate — and the plates are
 *      saved on them
 *   5. idempotent: planned again the size is the catalog's (inCatalog, its code); accepted again nothing new is made;
 *      the same size twice in one call is made once (ensureCatalogPlates)
 *   6. refused in words, nothing written: custom sizes switched off, a size past the limits, a line of standard plates
 *      only, a size the layout does not fit
 *   7. the comparison prices a custom plate at the rate of the plate it replaces, and marks it
 *   8. nothing survived the rollback; line 923 untouched
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
const CP = await imp('apps/cf_erp/services/nestCustomPlate.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const P = await imp('apps/cf_erp/services/nestPlateCatalogService.js');
const C = await imp('apps/cf_erp/services/nestCompareService.js');
const PC = await imp('apps/cf_erp/services/plateChangeService.js');
const S = await imp('apps/cf_erp/services/shopRules.js');
const F = await imp('scripts/cf_kepl/lib/plateRulesFixture.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const KEPL_LINE = 923;

let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean (${String(name).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
const textOf = (e) => [e?.message, ...(e?.details?.problems ?? e?.problems ?? e?.detail?.problems ?? [])].join(' | ');
const said = (e, ...bits) => bits.every((b) => textOf(e).includes(b));

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const [[kepl0]] = await pool.query('SELECT COUNT(*) n FROM cf_production_releases WHERE order_line_id = ? AND deleted_at IS NULL', [KEPL_LINE]);

function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, { get: (target, prop) => (prop === 'query' || prop === 'execute' ? (...args) => { tally.n += 1; return target[prop](...args); } : Reflect.get(target, prop)) });
  return { db: proxy, tally };
}

const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'custom plate test' };
const LIMITS = { on: true, maxLength: 6000, maxWidth: 2000, minLength: 1000, minWidth: 500 };

try {
  /* ───────────── 1 ───────────── */
  section('1. The proposal (services/nestCustomPlate.js)');
  {
    ok('the setting: off unless on; JSON text or an object; blank limits are null', CP.customPlateSetting(null) === null && CP.customPlateSetting('{"on":false,"maxLength":9000}') === null
      && J(CP.customPlateSetting('{"on":true,"maxLength":"12500","maxWidth":2500,"step":""}')) === J({ on: true, maxLength: 12500, maxWidth: 2500, minLength: null, minWidth: null, step: null }));
    const badIn = CP.customPlateInput({ on: true, maxLength: 2000, maxWidth: 2500, minLength: 3000 });
    ok('what is saved is checked: shortest over longest, widest over longest — said in words', badIn.problems.includes('The shortest length is more than the longest.') && badIn.problems.some((p) => p.includes('widest width is more than the longest length')), J(badIn.problems));
    ok('switched off keeps the limits (on: false)', CP.customPlateInput({ on: false, maxLength: 9000 }).value === J({ on: false, maxLength: 9000, maxWidth: null, minLength: null, minWidth: null, step: null }));
    const catalog = [{ steel: { thickness: 12, length: 6000, width: 2000 } }, { steel: { thickness: 12, length: 12000, width: 2500 } }, { steel: { thickness: 10, length: 2500, width: 1250 } }];
    const band = { orderMarginLengthMm: 100, orderMarginWidthMm: 50, orderStepMm: 50 };
    const lim = CP.customLimits({ on: true, maxLength: 12500 }, catalog, 12, band);
    ok('limits: the setting where it says, else the catalog — the widest 12 mm plate, the shortest / narrowest of all; the band\'s step and margins',
      lim.maxLength === 12500 && lim.maxWidth === 2500 && lim.minLength === 2500 && lim.minWidth === 1250 && lim.step === 50 && lim.marginLength === 100 && lim.marginWidth === 50 && /widest, shortest, narrowest from the catalog/.test(lim.basis), J(lim));
    const L = { maxLength: 6000, maxWidth: 2000, minLength: 1000, minWidth: 500, step: 50, marginLength: 100, marginWidth: 50 };
    const nests = [
      { length: 6000, width: 2000, requiredLength: 3520, requiredWidth: 1830, plateItemId: 1, plateCode: 'PA' },
      { length: 6000, width: 2000, requiredLength: 3410, requiredWidth: 1700, plateItemId: 1, plateCode: 'PA' },
      { length: 6000, width: 2000, requiredLength: 5990, requiredWidth: 1990, plateItemId: 1, plateCode: 'PA' },
    ];
    const p = CP.proposeCustomSize(nests, { limits: L, thickness: 12 });
    ok('the two slack plates move to ONE size that holds both, on the step, with the margins (3650 × 1900); the full one stays',
      p && p.length === 3650 && p.width === 1900 && J(p.moves) === '[0,1]' && p.replaces[0].plates === 2 && p.length % 50 === 0 && p.width % 50 === 0 && p.length >= 3520 + 100 && p.width >= 1830 + 50, J(p));
    ok('the saving is steel bought (and the same waste): 2 × (6000 × 2000 − 3650 × 1900) × 12 mm', Math.abs(p.savingKg - Math.round(2 * (12e6 - 3650 * 1900) * 12 * 7.85e-6 * 1000) / 1000) < 0.01 && p.after.kg < p.before.kg, J(p));
    ok('nothing when the limits do not allow a smaller size (max 3000 long)', CP.proposeCustomSize(nests, { limits: { ...L, maxLength: 3000 }, thickness: 12 }) === null);
    ok('nothing when every plate is full', CP.proposeCustomSize([nests[2]], { limits: L, thickness: 12 }) === null);
    ok("nothing on the customer's own plates or offcuts (not bought)", CP.proposeCustomSize(nests.slice(0, 2).map((n) => ({ ...n, ownerPartyId: 9 })), { limits: L, thickness: 12 }) === null);
    ok('the minimum is kept (min 4000 long → 4000)', CP.proposeCustomSize(nests, { limits: { ...L, minLength: 4000 }, thickness: 12 })?.length === 4000);
    const two = [...nests, { length: 3000, width: 1500, requiredLength: 2990, requiredWidth: 1490, plateItemId: 2, plateCode: 'PS' }];
    ok('one more size where the company allows only 2 sizes per thickness (and 2 are in use): nothing', CP.proposeCustomSize(two, { limits: L, thickness: 12, maxSizes: 2 }) === null);
    ok('…allowed with no limit', CP.proposeCustomSize(two, { limits: L, thickness: 12, maxSizes: null })?.length === 3650);
  }

  await conn.beginTransaction();
  attachNodeCache(conn);
  section('Fixture');
  const fx = await F.buildPlateRulesFixture(conn, { company: COMPANY, parts: [['A', 12, 1200, 400, 4, 'E350', 'BR'], ['B', 12, 900, 300, 4, 'E350', 'BO'], ['C', 16, 800, 400, 2, 'E350', 'BR']] });
  // This suite is about custom sizes, not grades: the rule is pinned to 'better' so the 12 mm BR and BO pieces are one
  // steel (under the default 'exact' each class is its own steel, with its own custom size — nest_grade_check covers that).
  await F.setPlateRules(conn, COMPANY, { gradeRule: 'better', customPlates: null });
  console.log(`  ${fx.tag}: line ${fx.lineId}`);
  const plan = (input = {}) => N.planNesting(conn, COMPANY, fx.lineId, input);
  const nests = (p) => p.groups.flatMap((g) => g.nests);
  const plateCount = async () => Number((await conn.query('SELECT COUNT(*) AS n FROM cf_master_records WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL', [COMPANY, fx.plateNode]))[0][0].n);
  const itemOf = async (id) => {
    const [[m]] = await conn.query('SELECT m.*, i.item_type, i.tracked_by, i.uom, i.sourcing, i.list_price, i.price_basis, i.hsn_code, i.gst_rate FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL', [COMPANY, id]);
    const [vals] = await conn.query("SELECT s.code, v.value_number, v.source, o.value AS opt FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id LEFT JOIN cf_spec_options o ON o.id = v.option_id WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL", [COMPANY, id]);
    return { m, v: Object.fromEntries(vals.map((r) => [r.code, r])) };
  };

  /* ───────────── 2 ───────────── */
  section('2. Off by default');
  let planOff;
  {
    planOff = await plan();
    ok('no custom size: every plate is a catalog plate', (planOff.customPlates ?? []).length === 0 && nests(planOff).every((n) => n.plateItemId != null && !n.customPlate), J(planOff.customPlates));
  }

  /* ───────────── 3 ───────────── */
  section('3. On: the plates move to the size their layout needs');
  let planOn;
  {
    await F.setPlateRules(conn, COMPANY, { customPlates: LIMITS });
    planOn = await plan();
    const moved = nests(planOn).filter((n) => n.customPlate);
    const cp12 = planOn.customPlates.find((x) => x.thickness === 12);
    const cp16 = planOn.customPlates.find((x) => x.thickness === 16);
    ok('one custom size per steel (12 mm and 16 mm), each said in a sentence: "custom size, not in the catalog yet"',
      planOn.customPlates.length === 2 && !!cp12 && !!cp16 && planOn.customPlates.every((x) => x.inCatalog === false && x.sentence.includes('Custom size, not in the catalog yet')) && planOn.notes.filter((t) => t.includes('AI proposes a custom plate')).length === 2, J(planOn.customPlates.map((x) => x.sentence)));
    ok('the moved plates: no catalog plate yet (plateItemId null), the custom size as the plate, what it replaces kept',
      moved.length >= 2 && moved.every((n) => n.plateItemId === null && n.customPlate.inCatalog === false && n.length === n.customPlate.length && n.width === n.customPlate.width && /^CUSTOM \d+ × \d+$/.test(n.plateCode) && n.customPlate.replaces?.plateItemId != null && n.customPlate.note === N.CUSTOM_NOT_IN_CATALOG), J(moved.map((n) => [n.plateCode, n.customPlate])));
    ok('each size holds its layout with the ordering margins (100 / 50), on the 50 mm step, within the limits',
      moved.every((n) => n.length >= n.requiredLength + 100 - 1e-6 && n.width >= n.requiredWidth + 50 - 1e-6 && n.length % 50 === 0 && n.width % 50 === 0 && n.length <= 6000 && n.width <= 2000 && n.length >= 1000 && n.width >= 500), J(moved.map((n) => [n.length, n.width, n.requiredLength, n.requiredWidth])));
    ok("the 12 mm custom plate is the pieces' steel: E350 BO (the strictest class asked: BR and BO pieces)", cp12.grade === 'E350' && cp12.impactClass === 'BO' && cp12.material === fx.MS, J(cp12));
    ok('the 16 mm custom plate asks BR (its pieces\'), though the plate it replaces states no class', cp16.impactClass === 'BR', J(cp16));
    const off = planOff.totals.weightKg; const on = planOn.totals.weightKg;
    ok('steel bought falls by the saving the proposal states', Math.abs((off - on) - planOn.customPlates.reduce((a, x) => a + x.savingKg, 0)) < 1 && on < off, J([off, on, planOn.customPlates.map((x) => x.savingKg)]));
    const noCustom = await plan({ customPlates: false });
    ok('a caller may switch it off for one plan (customPlates: false)', (noCustom.customPlates ?? []).length === 0);
  }

  /* ───────────── 4 ───────────── */
  section('4. Accepted: the custom sizes become catalog plates first, then the plates are saved on them');
  let made;
  {
    const n0 = await plateCount();
    const t = counting(conn);
    const out = await PC.plateChangeGate(t.db, c, fx.lineId, 'accept', { ...planOn, impact: true }, (b) => N.acceptNesting(t.db, c, fx.lineId, b));
    made = out.customPlates;
    console.log(`  (round trips, accept with its before / after sheet and two new catalog plates: ${t.tally.n})`);
    ok('two catalog plates made, none reused; the plates saved; the before / after sheet came back', made?.created?.length === 2 && made.reused.length === 0 && out.lots === nests(planOn).length && !!out.plateChange?.impact && (await plateCount()) === n0 + 2, J([made, out.lots]));
    const c12 = planOn.customPlates.find((x) => x.thickness === 12);
    const code12 = `${fx.SHORT}-12X${c12.width}X${c12.length}-E350BO`;
    const id12 = made.created.find((x) => x.code === code12)?.itemId;
    ok(`its code is the coding rule's: ${code12}`, Number.isInteger(id12), J(made.created));
    const it = await itemOf(id12);
    ok('an ACTIVE catalog plate, filed with the plates, the model\'s short name', it.m.status === 'active' && it.m.item_type === 'catalog' && Number(it.m.classification_id) === fx.plateNode && it.m.short_name === fx.SHORT);
    ok('HSN, GST, unit, tracking and the per-tonne rate come from the nearest plate (12 mm E350 BO)', it.m.hsn_code === '7208' && Number(it.m.gst_rate) === 18 && Number(it.m.list_price) === 64000 && it.m.price_basis === 'tonne' && it.m.tracked_by === 'batch', J([it.m.hsn_code, it.m.gst_rate, it.m.list_price, it.m.price_basis]));
    ok('its values: thickness, length, width, grade and impact class entered; weight by its formula; material / density fixed; PLATE_KIND custom',
      Number(it.v.THICKNESS?.value_number) === 12 && Number(it.v.LENGTH?.value_number) === c12.length && Number(it.v.WIDTH?.value_number) === c12.width && it.v.GRADE?.opt === 'E350' && it.v.IMPACT_CLASS?.opt === 'BO'
      && it.v.WEIGHT?.source === 'calculated' && Math.abs(Number(it.v.WEIGHT.value_number) - (c12.length * c12.width * 12 * 7850) / 1e9) < 0.01 && it.v.MATERIAL?.source === 'fixed', J(it.v));
    const [lots] = await conn.query("SELECT plate_item_id, length_mm, width_mm FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [COMPANY, fx.lineId]);
    const ids = new Set(made.created.map((x) => x.itemId));
    ok('the plates are saved on the new catalog plates, at the custom size', lots.filter((l) => ids.has(Number(l.plate_item_id))).length === nests(planOn).filter((n) => n.customPlate).length
      && lots.filter((l) => Number(l.plate_item_id) === id12).every((l) => Number(l.length_mm) === c12.length && Number(l.width_mm) === c12.width), J(lots));
  }

  /* ───────────── 5 ───────────── */
  section('5. Idempotent');
  {
    const n0 = await plateCount();
    await N.clearLots(conn, c, fx.lineId, {});
    const again = await plan();
    const all = nests(again);
    const ids = new Set(made.created.map((x) => Number(x.itemId)));
    ok('planned again, the size is the catalog\'s now: every plate names a catalog plate (the made one, or the packer chose it outright)',
      all.every((n) => n.plateItemId != null) && all.some((n) => ids.has(Number(n.plateItemId))) && (again.customPlates ?? []).every((x) => x.inCatalog === true && ids.has(Number(x.itemId))), J([again.customPlates, all.map((n) => [n.plateCode, n.length, n.width])]));
    const out = await N.acceptNesting(conn, c, fx.lineId, again);
    ok('accepted again: nothing new in the catalog', !out.customPlates?.created?.length && (await plateCount()) === n0, J(out.customPlates));
    // The plan from before the plates existed, accepted once more: the same sizes are FOUND, not made again.
    await N.clearLots(conn, c, fx.lineId, {});
    const out2 = await N.acceptNesting(conn, c, fx.lineId, planOn);
    ok('the first plan (custom sizes, not in the catalog when proposed) accepted again: both sizes reused, none made', out2.customPlates?.created?.length === 0 && out2.customPlates.reused.length === 2 && (await plateCount()) === n0, J(out2.customPlates));
    const twice = await P.ensureCatalogPlates(conn, c, [
      { thickness: 12, length: 2500, width: 1250, grade: 'E350', impactClass: 'BR', kind: 'custom' },
      { thickness: 12, length: 1250, width: 2500, grade: 'E350', impactClass: 'BR', kind: 'custom' },
    ], { plates: await N.candidatePlates(conn, COMPANY, [fx.plateNode]) });
    ok('ensureCatalogPlates: the same size twice (either way round) in one call is made ONCE, both answers name it', twice.created.length === 1 && twice.plates[0].itemId === twice.plates[1].itemId && (await plateCount()) === n0 + 1, J(twice));
  }

  /* ───────────── 6 ───────────── */
  section('6. Refused in words, nothing written');
  {
    await N.clearLots(conn, c, fx.lineId, {});
    const fresh = await (async () => { await conn.query('UPDATE cf_master_records SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, made.created.map((x) => x.itemId)]); return plan(); })();
    ok('(a fresh plan with the made sizes gone from the catalog proposes custom sizes again)', fresh.customPlates.some((x) => x.inCatalog === false), J(fresh.customPlates));
    const n0 = await plateCount();
    await F.setPlateRules(conn, COMPANY, { customPlates: { ...LIMITS, on: false } });
    const off = await refusal(() => N.acceptNesting(conn, c, fx.lineId, fresh));
    ok('custom sizes switched off since: refused, "switched off in Setup › Cutting"', said(off, 'custom plate size', 'switched off in Setup › Cutting') && (await plateCount()) === n0, textOf(off));
    await F.setPlateRules(conn, COMPANY, { customPlates: { ...LIMITS, maxLength: 1500 } });
    const big = await refusal(() => N.acceptNesting(conn, c, fx.lineId, fresh));
    ok('a size past the limits: refused, naming the size and the limits', said(big, 'outside the plate sizes the mill can roll', '1000–1500 long') && (await plateCount()) === n0, textOf(big));
    await F.setPlateRules(conn, COMPANY, { customPlates: LIMITS });
    await conn.query("UPDATE cf_sales_order_lines SET nest_plates = 'standard' WHERE id = ?", [fx.lineId]);
    const std = await refusal(() => N.acceptNesting(conn, c, fx.lineId, fresh));
    ok('a line of standard plates only: refused', said(std, 'standard plates only') && (await plateCount()) === n0, textOf(std));
    await conn.query("UPDATE cf_sales_order_lines SET nest_plates = 'any' WHERE id = ?", [fx.lineId]);
    const small = structuredClone(fresh);
    for (const g of small.groups) for (const n of g.nests) if (n.customPlate) { n.customPlate.length = 1000; n.customPlate.width = 500; }
    const tight = await refusal(() => N.acceptNesting(conn, c, fx.lineId, small));
    ok('a size the layout does not fit on: refused by the layout check, nothing made', !!tight && (await plateCount()) === n0, textOf(tight));
  }

  /* ───────────── 7 ───────────── */
  section('7. The comparison prices and marks a custom plate');
  {
    const costs = new Map([[101, { unit: 10000, basis: 'list price', perKg: 64 }]]);
    const custom = { lotNo: 'N-001', plateItemId: null, plateCode: 'CUSTOM 2000 × 1000', length: 2000, width: 1000, thickness: 10, density: 7850, kerfMm: 3, pieces: [], partsKg: 0, offcuts: [], customPlate: { length: 2000, width: 1000, grade: 'E350', impactClass: 'BR', inCatalog: false, replaces: { plateItemId: 101, plateCode: 'PA', length: 6000, width: 2000 } } };
    const m = await C.nestingMetrics([custom], { facts: new Map(), sizeOf: new Map(), costs, cuts: false });
    const kg = (2000 * 1000 * 10 * 7850) / 1e9;
    ok('cost: the per-kg rate of the plate it replaces × its own weight; marked custom, not in the catalog', Math.abs(m.metrics.cost.value - Math.round(64 * kg * 100) / 100) < 0.01 && m.perPlate[0].custom?.inCatalog === false && /the rate of the plate it replaces/.test(m.perPlate[0].costBasis), J([m.metrics.cost, m.perPlate[0]]));
  }

  /* ───────────── setting ───────────── */
  section('Setup › Cutting');
  {
    const saved = await S.saveShopRules(conn, c, { customPlates: { on: true, maxLength: 12500, maxWidth: 2500, minLength: '', step: 100 } });
    ok('saved and read back: on, the limits, blank = null', J(saved.customPlates) === J({ on: true, maxLength: 12500, maxWidth: 2500, minLength: null, minWidth: null, step: 100 }), J(saved.customPlates));
    ok('nesting reads it', J(N.cutSettingRows ? (await N.cutSettingRows(conn, COMPANY)).customPlates : null) === J({ on: true, maxLength: 12500, maxWidth: 2500, minLength: null, minWidth: null, step: 100 }));
    const bad = await refusal(() => S.saveShopRules(conn, c, { customPlates: { on: true, maxLength: 2000, maxWidth: 2500 } }));
    ok('limits that contradict each other are refused in words', said(bad, 'Custom plate sizes:', 'widest width is more than the longest length'), textOf(bad));
  }
} catch (e) {
  failed += 1; fails.push(`crashed: ${e.message}`);
  console.log(`  CRASH  ${e.stack}\n${textOf(e)}`);
} finally {
  try { await conn.rollback(); } catch { /* gone */ }
  detachNodeCache(conn);
  conn.release();
}

section('8. Nothing survived');
{
  const after = await counts();
  const diff = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
  ok('every cf_ table counts what it did before (rolled back)', diff.length === 0, J(diff));
  const [[kepl1]] = await pool.query('SELECT COUNT(*) n FROM cf_production_releases WHERE order_line_id = ? AND deleted_at IS NULL', [KEPL_LINE]);
  ok('line 923 is not released by this suite', Number(kepl1.n) === Number(kepl0.n));
}
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(`FAILED: ${fails.join(' | ')}`); process.exit(1); }
