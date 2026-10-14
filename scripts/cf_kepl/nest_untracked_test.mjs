/**
 * nest_untracked_test.mjs — "mark the rest as cut from untracked offcuts" (init.sql §61, 2026-10-14):
 * services/nestUntrackedService.js and every reader of lib/nestUntracked.js. Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_untracked_test.mjs
 *   CF_NEST_COMPANY (2) · CF_UNTRACKED_RELEASE_LINE (923 — the local KEPL copy; 0 = skip section 8)
 *
 * ONE TRANSACTION, ROLLED BACK, and every cf_ table is re-counted at the end. IT OWNS ITS FIXTURE
 * (lib/nestV2Fixture.mjs, as nest_upload_test): the customer's set B is uploaded without the plate
 * that holds the six gussets, so six gussets are left over — the pieces the shop cuts from loose
 * offcuts. Section 8 BORROWS the real nested line 923 the way release_nest_material_test does,
 * inside the same transaction: the line is released there and rolled back with everything else.
 *
 *   1. what is left over, its kg and its cost at the plate rate (GET)
 *   2. marking: refusals in words, a dry run writes nothing, part of a cut piece, then all of it
 *   3. every reader: the files route, the saved plan (coverage, drift, the summary line), Steps A/B
 *   4. our packer is never asked for a marked piece (rest, and the whole line again)
 *   5. the order's costs: the steel at the plate rate per kg, apart from the plates; no plate, no waste
 *   6. a later upload that nests a marked piece covers it: the mark shrinks, said and written
 *   7. undo
 *   8. release on a real nested line: a marked piece does not stop release and asks for no plate
 *   9. the release rule itself (releaseService.plateMaterial, pure)
 *  10. round trips: a fixed number whatever the line holds
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const U = await imp('apps/cf_erp/services/nestDxfImportService.js');
const UT = await imp('apps/cf_erp/services/nestUntrackedService.js');
const V = await imp('apps/cf_erp/services/valuationService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const L = await imp('apps/cf_erp/lib/nestUntracked.js');
const F = await imp('scripts/cf_kepl/lib/nestV2Fixture.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const RELEASE_LINE = Number(process.env.CF_UNTRACKED_RELEASE_LINE ?? 923);
const EPS = 1e-6;

let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean (${String(name).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, { get: (target, prop) => (prop === 'query' || prop === 'execute' ? (...args) => { tally.n += 1; return target[prop](...args); } : Reflect.get(target, prop)) });
  return { db: proxy, tally };
}
/** The refusal a call throws, or null. */
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'untracked offcuts test' };
const asRequest = (fx, files) => files.map((f) => ({ filename: f.filename, file: f.file, ...(f.style === 'segments' ? { plateCode: fx.plateCode('PS') } : {}) }));
const upload = (fx, files, opts = {}) => U.uploadNestFiles(conn, c, fx.lineId, { files: asRequest(fx, files), ...opts });
const markRows = async (fx) => (await conn.query('SELECT cut_plate_id, quantity, rate_plate_item_id, deleted_at FROM cf_nest_untracked WHERE company_id = ? AND order_line_id = ? ORDER BY cut_plate_id', [COMPANY, fx.lineId]))[0];

try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  section('Fixture');
  const fx = await F.buildFixture(conn, { company: COMPANY, tagPrefix: 'UT' });
  const sets = F.nestings(fx);
  const G = fx.cut.G;
  const gNeed = fx.parts.G.qty;
  const base = sets.B.filter((f) => !f.filename.includes('-B4_'));        // set B without the gusset plate
  const first = await upload(fx, base, { dryRun: false });
  ok(`set B without its gusset plate is saved: ${first.saved?.lots} plates, the ${gNeed} gussets left over`, first.applied === true && first.leftOver.length === 1 && first.leftOver[0].cutPlateId === G && first.leftOver[0].qty === gNeed, J(first.leftOver));
  ok('the upload answer says nothing is marked yet', first.untracked?.pieces === 0 && first.untracked.shrinks.length === 0 && first.totals.untrackedPieces === 0, J(first.untracked));
  const plateValueBefore = (await V.orderCosts(conn, COMPANY, fx.orderId)).lines.find((l) => l.line.id === fx.lineId).nest;

  /* ───────────── 1. what is left over ───────────── */
  section('1. GET …/nesting/untracked — what is left over, its kg, its cost at the plate rate');
  const kgEach = (520 * 320 / 1e6) * (F.T / 1000) * F.DENSITY;
  const g0 = await UT.getUntracked(conn, COMPANY, fx.lineId);
  const gRow = g0.leftOver.find((r) => r.cutPlateId === G);
  ok('one left-over cut piece: the gusset ×6, with its size, grade and parts (name + mark)', g0.leftOver.length === 1 && gRow?.qty === gNeed && gRow.thickness === F.T && gRow.length === 520 && gRow.width === 320
    && gRow.parts.length === 1 && gRow.parts[0].mark === fx.mark.G && /part G/.test(gRow.parts[0].name), J(gRow));
  ok(`its kg: 6 × ${kgEach.toFixed(3)} kg (L × W × T × density)`, near(gRow.kgEach, kgEach, 0.001) && near(gRow.kg, kgEach * gNeed, 0.01), J([gRow.kgEach, gRow.kg]));
  ok('its rate is the plate rate per kg of a catalog plate of its steel the line uses (list price 62,000 / t = ₹62 / kg)', gRow.ratePlate != null && [fx.plates.PA, fx.plates.PS].includes(gRow.ratePlate.id) && near(gRow.rate?.perKg, 62, 0.001) && gRow.rate.basis === 'list price', J([gRow.ratePlate, gRow.rate]));
  ok('its cost = kg × rate, and the totals add up', near(gRow.cost, gRow.kg * 62, 0.02) && g0.totals.leftOver.pieces === gNeed && near(g0.totals.leftOver.cost, gRow.cost) && g0.totals.leftOver.uncostedPieces === 0, J(g0.totals));
  ok('nothing is marked, no summary line, the line may be marked', g0.marked.length === 0 && g0.totals.marked.pieces === 0 && g0.summary === null && g0.canMark === true);

  /* ───────────── 2. marking ───────────── */
  section('2. POST — refusals in words, a dry run, part of a cut piece, then the rest');
  let e = await refusal(() => UT.markUntracked(conn, c, fx.lineId, { pieces: [{ cutPlateId: G, quantity: 7 }] }));
  ok('more than is left over is refused, in words', e?.code === 'UNTRACKED_INVALID' && e.problems?.some((p) => /only 6 pieces are left over, so 7 cannot be marked/.test(p)), J([e?.code, e?.problems]));
  e = await refusal(() => UT.markUntracked(conn, c, fx.lineId, { pieces: [{ cutPlateId: fx.cut.R, quantity: 1 }, { cutPlateId: 999999999 }, { cutPlateId: G, quantity: 0 }] }));
  ok('a cut piece with nothing left over, one that is not the line\'s, and 0 pieces — each named', e?.code === 'UNTRACKED_INVALID' && e.problems.length === 3
    && e.problems.some((p) => /nothing of it is left over/.test(p)) && e.problems.some((p) => /999999999 is not one of line/.test(p)) && e.problems.some((p) => /not a number of pieces/.test(p)), J(e?.problems));
  ok('…and nothing was written', (await markRows(fx)).length === 0);
  const dry = await UT.markUntracked(conn, c, fx.lineId, { all: true, dryRun: true });
  ok('a dry run says what it would mark, and writes nothing', dry.dryRun === true && dry.applied === false && dry.adding.totals.pieces === gNeed && /^Would mark 6 pieces/.test(dry.message) && (await markRows(fx)).length === 0, dry.message);
  const m4 = await UT.markUntracked(conn, c, fx.lineId, { pieces: [{ cutPlateId: G, quantity: 4 }] });
  ok('4 of the 6 marked: 2 left over, 4 marked, the plate rate kept on the mark', m4.applied === true && m4.leftOver[0]?.qty === 2 && m4.marked[0]?.qty === 4 && m4.totals.marked.pieces === 4
    && (await markRows(fx))[0]?.quantity === 4 && (await markRows(fx))[0]?.rate_plate_item_id === gRow.ratePlate.id, J([m4.leftOver, m4.marked]));
  ok('the message says pieces, kg and cost', /^Marked 4 pieces \(\d[\d,]* kg, ₹[\d,]+ at the plate rate\) as cut from untracked offcuts\.$/.test(m4.message), m4.message);
  ok('the summary line: "4 pieces · n kg cut from untracked offcuts"', /^4 pieces · \d[\d,]* kg cut from untracked offcuts$/.test(m4.summary ?? ''), m4.summary);

  /* ───────────── 3. the readers ───────────── */
  section('3. Every reader counts a marked piece as not left over');
  let files = await U.getNestFiles(conn, COMPANY, fx.lineId);
  ok('GET …/nesting/files: 2 left over, coverage says 4 untracked, totals too', files.leftOver.length === 1 && files.leftOver[0].qty === 2 && files.coverage.find((x) => x.cutPlateId === G)?.untracked === 4
    && files.untracked?.[0]?.qty === 4 && files.totals.untrackedPieces === 4 && files.totals.leftOverPieces === 2, J([files.leftOver, files.totals]));
  let plan = await N.getNesting(conn, COMPANY, fx.lineId);
  let cov = plan.coverage.find((x) => x.cutPlateId === G);
  ok('GET …/nesting: coverage keeps diff (nested − needed) and adds untracked 4 and leftOver 2', cov.diff === -gNeed && cov.untracked === 4 && cov.leftOver === 2, J(cov));
  ok('…the plan\'s summary: 4 pieces and their kg, apart from the plates', plan.untracked?.pieces === 4 && near(plan.untracked.kg, kgEach * 4, 0.01) && plan.untracked.cutPieces[0]?.cutPlateId === G, J(plan.untracked));
  ok('…still out of date for the 2 that are on no plate and not marked', plan.drift.length === 1 && plan.drift[0].cutPlateId === G, J(plan.drift));
  const plates4 = plan.totals.plates;
  const all = await UT.markUntracked(conn, c, fx.lineId, {});
  ok('marking "the rest" (no pieces named) marks the 2 left: 6 marked, nothing left over', all.leftOver.length === 0 && all.marked[0]?.qty === gNeed && (await markRows(fx))[0]?.quantity === gNeed, J([all.leftOver, all.marked]));
  e = await refusal(() => UT.markUntracked(conn, c, fx.lineId, { all: true }));
  ok('with nothing left over, marking is refused (NOTHING_LEFT)', e?.code === 'NOTHING_LEFT', e?.message);
  plan = await N.getNesting(conn, COMPANY, fx.lineId);
  cov = plan.coverage.find((x) => x.cutPlateId === G);
  ok('the saved plan: no drift, nothing left over, 6 untracked — and the plates and their waste are what they were', plan.drift.length === 0 && cov.leftOver === 0 && cov.untracked === gNeed && plan.untracked.pieces === gNeed && plan.totals.plates === plates4, J([plan.drift, cov, plan.totals.plates]));
  files = await U.getNestFiles(conn, COMPANY, fx.lineId);
  ok('the files route: nothing left over', files.leftOver.length === 0 && files.totals.leftOverPieces === 0 && files.totals.untrackedPieces === gNeed);
  const choices = await N.nestingChoices(conn, COMPANY, fx.lineId);
  const gChoice = choices.groups.flatMap((g) => g.pieces).find((p) => p.cutPlateId === G);
  ok('Steps A / B: the gusset has nothing to nest, and says why', gChoice?.toNest === 0 && gChoice.untracked === gNeed && /cut from untracked offcuts/.test(gChoice.note ?? ''), J(gChoice));
  const drift = await N.layoutDriftOfLines(conn, COMPANY, [fx.lineId], new Map([[fx.lineId, (await N.surveyLine(conn, COMPANY, await N.requireLine(conn, COMPANY, fx.lineId))).tree]]), { untracked: new Map() });
  ok('the process stage\'s drift (layoutDriftOfLines): none', (drift.get(fx.lineId) ?? []).length === 0, J(drift.get(fx.lineId)));
  const tally = new Map();
  await N.layoutDriftOfLines(conn, COMPANY, [fx.lineId], new Map([[fx.lineId, (await N.surveyLine(conn, COMPANY, await N.requireLine(conn, COMPANY, fx.lineId))).tree]]), { untracked: tally });
  ok('…and it counts the marked pieces for the stage\'s words', tally.get(fx.lineId)?.pieces === gNeed && tally.get(fx.lineId)?.cutPlates === 1, J([...tally]));

  /* ───────────── 4. our packer ───────────── */
  section('4. Our packer is never asked for a marked piece');
  const rest = await N.planNesting(conn, COMPANY, fx.lineId, { demandOnly: true });
  ok('nest the rest: the demand holds no gusset (and nothing else: the files hold the rest)', !rest.demand.pieces.some((p) => p.cutPlateId === G) && rest.demand.pieceCount === 0, J(rest.demand.pieces));
  const whole = await N.planNesting(conn, COMPANY, fx.lineId, { demandOnly: true, replaceImported: true });
  const total = Object.values(fx.parts).filter((p) => !p.manual).reduce((a, p) => a + p.qty, 0);
  ok(`the whole line again: every piece but the 6 gussets (${total - gNeed})`, !whole.demand.pieces.some((p) => p.cutPlateId === G) && whole.demand.pieceCount === total - gNeed, J(whole.demand.pieceCount));
  const ctx = await N.importContext(conn, COMPANY, fx.lineId);
  const fp = N.demandFor({ line: ctx.line, needed: ctx.cutPlates, everyPlate: ctx.plates, settingRows: ctx.settingRows, excl: await N.exclusionsOfLine(conn, COMPANY, fx.lineId), facts: await (await imp('apps/cf_erp/services/partDrawingService.js')).drawingFactsOfLine(conn, COMPANY, fx.lineId), replaceImported: true, untracked: await L.untrackedOfLine(conn, COMPANY, fx.lineId) });
  ok('the comparison\'s fingerprint of the whole line is the run\'s own (demandFor takes the marks off the same way)', fp.hash === whole.demand.hash, J([fp.pieceCount, whole.demand.pieceCount]));
  const accepted = await refusal(() => N.acceptNesting(conn, c, fx.lineId, { groups: [] }));
  ok('an empty "nest the rest" accept is fine: nothing is left to nest', accepted === null, accepted?.message);

  /* ───────────── 5. costs ───────────── */
  section('5. The order\'s costs — the steel at the plate rate per kg, apart from the plates');
  const costs = await V.orderCosts(conn, COMPANY, fx.orderId);
  const nest = costs.lines.find((l) => l.line.id === fx.lineId).nest;
  ok('nest.untracked: 6 pieces, their kg, kg × ₹62', nest.untracked.pieces === gNeed && near(nest.untracked.kg, kgEach * gNeed, 0.01) && near(nest.untracked.value, nest.untracked.kg * 62, 0.05) && nest.untracked.uncostedPieces === 0, J(nest.untracked));
  ok('…the same money the screen showed when they were marked', near(nest.untracked.value, all.totals.marked.cost, 0.05), J([nest.untracked.value, all.totals.marked.cost]));
  ok('no plate and no waste was added: plates, steel bought, wastage and offcuts as before', nest.lots === plateValueBefore.lots && nest.plateValue === plateValueBefore.plateValue && nest.wastageKg === plateValueBefore.wastageKg && nest.offcutKg === plateValueBefore.offcutKg, J([nest, plateValueBefore]));
  ok('totals.untrackedValue and untrackedKg', near(costs.totals.untrackedValue, nest.untracked.value) && near(costs.totals.untrackedKg, nest.untracked.kg), J(costs.totals));
  await conn.query('SAVEPOINT norate');
  await conn.query('UPDATE cf_item_details SET list_price = NULL WHERE company_id = ? AND master_id IN (?)', [COMPANY, Object.values(fx.plates)]);
  const unpriced = (await V.orderCosts(conn, COMPANY, fx.orderId)).lines.find((l) => l.line.id === fx.lineId).nest.untracked;
  ok('a plate with no price: the pieces are "not costed", never zero-valued silently', unpriced.value === 0 && unpriced.uncostedPieces === gNeed && unpriced.pieces === gNeed, J(unpriced));
  const g1 = await UT.getUntracked(conn, COMPANY, fx.lineId);
  ok('…and the screen says the same (cost null, uncosted 6)', g1.marked[0].cost === null && g1.marked[0].rate === null && g1.totals.marked.uncostedPieces === gNeed, J(g1.marked[0]));
  await conn.query('ROLLBACK TO SAVEPOINT norate');

  /* ───────────── 6. a later upload covers marked pieces ───────────── */
  section('6. A later upload that nests marked pieces covers them — the mark shrinks, said and written');
  const PS = { length: 3000, width: 1500 };
  const two = F.nestFile(`${fx.tag}-E2_${F.T}mm_3000x1500.dxf`, PS, F.rows(fx, [['G'], ['G']], PS));
  const pre = await upload(fx, [two]);
  ok('the preview: 2 gussets nested, no surplus, nothing left over', pre.canSave === true && pre.needsForce === false && pre.surplus.length === 0 && pre.leftOver.length === 0, J([pre.problems, pre.warnings, pre.leftOver]));
  ok('…and it says the mark shrinks 6 → 4', pre.untracked.shrinks.length === 1 && pre.untracked.shrinks[0].cutPlateId === G && pre.untracked.shrinks[0].was === 6 && pre.untracked.shrinks[0].now === 4 && pre.untracked.pieces === 4
    && /2 pieces marked as cut from untracked offcuts are nested in these files now, so the mark shrinks \(.*6 → 4\)/.test(pre.untracked.message) && pre.message.includes('the mark shrinks'), J(pre.untracked));
  ok('…the preview wrote nothing', (await markRows(fx))[0].quantity === 6);
  const saved2 = await upload(fx, [two], { dryRun: false });
  ok('saved: the mark is written as 4', saved2.applied === true && (await markRows(fx))[0].quantity === 4 && (await markRows(fx))[0].deleted_at === null, J(await markRows(fx)));
  const after2 = await UT.getUntracked(conn, COMPANY, fx.lineId);
  ok('…4 marked, nothing left over, 2 more on plates', after2.marked[0]?.qty === 4 && after2.leftOver.length === 0 && after2.marked[0].nested === 2, J(after2.marked));
  const full = sets.B.filter((f) => f.filename.includes('-B4_'));
  const pre6 = await upload(fx, full);
  ok('the gusset plate itself on top: 6 more — 2 over the line (needs force), and the mark goes to 0', pre6.untracked.shrinks[0]?.now === 0 && pre6.untracked.pieces === 0 && pre6.needsForce === true, J([pre6.untracked, pre6.warnings]));
  const lots = (await conn.query("SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND lot_no LIKE ?", [COMPANY, fx.lineId, `${fx.tag}-E2%`]))[0];
  const swap = await upload(fx, full, { dryRun: false, remove: lots.map((l) => l.id) });
  ok('swapping the 2-gusset plate for the 6-gusset one: saved, the mark undone (quantity 0, deleted)', swap.applied === true && (await markRows(fx))[0].quantity === 0 && (await markRows(fx))[0].deleted_at !== null && swap.leftOver.length === 0, J([swap.message, await markRows(fx)]));
  const del = await U.deleteNestLot(conn, c, fx.lineId, (await conn.query("SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND lot_no LIKE ?", [COMPANY, fx.lineId, `%-B4%`]))[0][0].id);
  ok('taking that plate off again: the 6 gussets are left over (the undone mark does not come back)', del.leftOver.length === 1 && del.leftOver[0].qty === gNeed && del.totals.untrackedPieces === 0, J(del.leftOver));

  /* ───────────── 7. undo ───────────── */
  section('7. Undo');
  await UT.markUntracked(conn, c, fx.lineId, { all: true });
  e = await refusal(() => UT.unmarkUntracked(conn, c, fx.lineId, { cutPlateIds: [fx.cut.R] }));
  ok('undoing a cut piece that is not marked is refused, nothing done', e?.code === 'UNTRACKED_INVALID' && (await markRows(fx))[0].deleted_at === null, e?.message);
  const undo = await UT.unmarkUntracked(conn, c, fx.lineId, {});
  ok('undo: the 6 are left over again, the row is soft-deleted', undo.applied === true && undo.undone.pieces === gNeed && undo.leftOver[0]?.qty === gNeed && undo.marked.length === 0 && (await markRows(fx))[0].deleted_at !== null && undo.message === 'Undone: 6 pieces are left over again.', J([undo.message, undo.leftOver]));
  e = await refusal(() => UT.unmarkUntracked(conn, c, fx.lineId, {}));
  ok('undo with nothing marked: NOTHING_MARKED', e?.code === 'NOTHING_MARKED', e?.message);
  const again = await UT.markUntracked(conn, c, fx.lineId, { pieces: [{ cutPlateId: G, quantity: 3 }] });
  ok('marking again revives the one row (one row per line and cut piece)', again.marked[0]?.qty === 3 && (await markRows(fx)).length === 1 && (await markRows(fx))[0].deleted_at === null && (await markRows(fx))[0].quantity === 3);
  await conn.query("UPDATE cf_sales_orders SET status = 'revised' WHERE company_id = ? AND id = ?", [COMPANY, fx.orderId]).catch(() => null);
  e = await refusal(() => UT.markUntracked(conn, c, fx.lineId, { all: true }));
  const e2 = await refusal(() => UT.unmarkUntracked(conn, c, fx.lineId, {}));
  ok('a line no longer open to nesting (its order revised) can be neither marked nor undone', e?.code === 'ORDER_LOCKED' && e2?.code === 'ORDER_LOCKED' && (await UT.getUntracked(conn, COMPANY, fx.lineId)).canMark === false, J([e?.code, e2?.code]));
  await conn.query("UPDATE cf_sales_orders SET status = 'confirmed' WHERE company_id = ? AND id = ?", [COMPANY, fx.orderId]);

  /* ───────────── 10. round trips ───────────── */
  section('10. Round trips — a fixed number whatever the line holds');
  {
    const { db, tally: t1 } = counting(conn);
    await UT.getUntracked(db, COMPANY, fx.lineId);
    const { db: db2, tally: t2 } = counting(conn);
    await UT.markUntracked(db2, c, fx.lineId, { all: true });
    const { db: db3, tally: t3 } = counting(conn);
    await UT.unmarkUntracked(db3, c, fx.lineId, {});
    console.log(`     GET ${t1.n}, mark ${t2.n}, undo ${t3.n}`);
    // The GET is the line, its structure and cut pieces, the plates, what is on them, the marks, the choices, the parts and the plate rates.
    ok(`GET ${t1.n} round trips (at most 30), mark and undo each the same + ONE write (${t2.n}, ${t3.n})`, t1.n <= 30 && t2.n === t1.n + 1 && t3.n === t1.n + 1, J([t1.n, t2.n, t3.n]));
  }

  /* ───────────── 9. the release rule, pure ───────────── */
  section('9. The release rule (releaseService.plateMaterial) — pure');
  {
    // Cut plate 11 (10 pieces, on lots 1 and 2), cut plate 22 (4 pieces, on no lot), plate item 900.
    const nodes = [{ k: 0, itemId: 11, quantity: 10, design: { code: 'CP11' } }, { k: 1, itemId: 22, quantity: 4, design: { code: 'CP22' } }];
    const reqs = () => [
      { nodeK: 0, itemId: 900, bomLineId: 1, quantity: 0.4, design: { selection: null } },
      { nodeK: 1, itemId: 900, bomLineId: 2, quantity: 0.2, design: { selection: null } },
    ];
    const lots = new Map([
      [1, { id: 1, lotNo: 'N-001', source: 'catalog', plateItemId: 900, plate: { code: 'PL', uom: 'nos' }, byCutPlate: new Map([[11, 5]]) }],
      [2, { id: 2, lotNo: 'N-002', source: 'catalog', plateItemId: 900, plate: { code: 'PL', uom: 'nos' }, byCutPlate: new Map([[11, 3]]) }],
    ]);
    let p = { nodes, reqs: reqs(), problems: [] };
    let cov = REL.plateMaterial(p, nodes, lots);
    ok('no marks: 8 of 10 nested is a problem (as before)', p.problems.length === 1 && /makes 10 but the saved nest lays out 8/.test(p.problems[0]) && cov.get(11) === 8, J(p.problems));
    p = { nodes, reqs: reqs(), problems: [] };
    cov = REL.plateMaterial(p, nodes, lots, new Map([[11, { qty: 2 }]]));
    ok('2 marked: no problem, covered 10, two whole plates asked, cut plate 11\'s plate line gone', p.problems.length === 0 && cov.get(11) === 10 && p.reqs.filter((r) => r.lot).length === 2 && !p.reqs.some((r) => r.bomLineId === 1), J([p.problems, p.reqs]));
    p = { nodes, reqs: reqs(), problems: [] };
    cov = REL.plateMaterial(p, nodes, lots, new Map([[11, { qty: 2 }], [22, { qty: 4 }]]));
    ok('a cut plate on no plate whose 4 pieces are all marked: covered, its plate line asks for nothing', cov.get(22) === 4 && !p.reqs.some((r) => r.bomLineId === 2) && p.problems.length === 0, J(p.reqs));
    ok('…so openPlateProblem has nothing to say about it', REL.openPlateProblem({ openPlates: [{ cutPlateId: 22 }] }, cov) === null);
    p = { nodes, reqs: reqs(), problems: [] };
    cov = REL.plateMaterial(p, nodes, lots, new Map([[11, { qty: 2 }], [22, { qty: 3 }]]));
    ok('3 of its 4 marked: NOT covered — its plate line stays, a selection would still be "no plate yet"', !cov.has(22) && p.reqs.some((r) => r.bomLineId === 2) && REL.openPlateProblem({ openPlates: [{ cutPlateId: 22 }] }, cov) !== null, J([...cov]));
    p = { nodes, reqs: reqs(), problems: [] };
    cov = REL.plateMaterial(p, nodes, lots, new Map([[11, { qty: 9 }]]));
    ok('a mark that holds more than is left counts only what is left (min(9, 10 − 8) = 2)', cov.get(11) === 10 && p.problems.length === 0);
    p = { nodes, reqs: reqs(), problems: [] };
    cov = REL.plateMaterial(p, nodes, lots, new Map([[11, { qty: 1 }]]));
    ok('1 marked of the 2 missing: still a problem, and it names the marked one', p.problems.length === 1 && /lays out 8 and 1 is cut from untracked offcuts/.test(p.problems[0]), J(p.problems));
    ok('lib: effectiveUntracked holds a mark to needed − nested; shrunkUntracked says what shrank', J([...L.effectiveUntracked(new Map([[1, { qty: 5 }], [2, { qty: 2 }], [3, { qty: 1 }]]), new Map([[1, 10], [2, 4], [3, 1]]), new Map([[1, 8], [3, 1]]))]) === J([[1, 2], [2, 2]])
      && J(L.shrunkUntracked(new Map([[1, { qty: 5 }], [2, { qty: 2 }]]), new Map([[1, 2], [2, 2]]))) === J([{ cutPlateId: 1, was: 5, now: 2 }]));
  }

  /* ───────────── 8. release on a real nested line ───────────── */
  if (RELEASE_LINE) {
    section(`8. Release on the real nested line ${RELEASE_LINE} — a marked piece does not stop release and asks for no plate`);
    const [[line]] = await conn.query('SELECT l.id, l.order_id, l.locked_at, o.status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?', [COMPANY, RELEASE_LINE]);
    if (!line || !line.locked_at || await REL.liveReleaseOfLine(conn, COMPANY, RELEASE_LINE)) {
      console.log(`  (skipped: line ${RELEASE_LINE} is not a locked, unreleased line of company ${COMPANY})`);
    } else {
      // Two cut plates of the nest: X (all its pieces taken off their plates) and Y (one piece taken off), on lots that keep other pieces.
      const [pl] = await conn.query(
        `SELECT np.cut_plate_id, np.plate_lot_id, COUNT(*) AS n FROM cf_nest_placements np JOIN cf_plate_lots l ON l.id = np.plate_lot_id
          WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL AND np.deleted_at IS NULL AND l.source = 'catalog'
          GROUP BY np.cut_plate_id, np.plate_lot_id`, [COMPANY, RELEASE_LINE]);
      const byCp = new Map(); const perLot = new Map();
      for (const r of pl) { if (!byCp.has(r.cut_plate_id)) byCp.set(r.cut_plate_id, []); byCp.get(r.cut_plate_id).push(r); perLot.set(r.plate_lot_id, (perLot.get(r.plate_lot_id) ?? 0) + Number(r.n)); }
      const cands = [...byCp].filter(([, rs]) => rs.every((r) => perLot.get(r.plate_lot_id) > Number(r.n))).sort((a, b) => a[1].reduce((s, r) => s + Number(r.n), 0) - b[1].reduce((s, r) => s + Number(r.n), 0));
      const [X, xRows] = cands[0]; const [Y, yRows] = cands[1];
      const xPieces = xRows.reduce((s, r) => s + Number(r.n), 0);
      console.log(`     X = cut plate ${X} (${xPieces} pieces on ${xRows.length} lot(s)), Y = cut plate ${Y} (one of ${yRows.reduce((s, r) => s + Number(r.n), 0)} taken off)`);
      await conn.query('UPDATE cf_nest_placements SET deleted_at = NOW() WHERE company_id = ? AND cut_plate_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL', [COMPANY, X, xRows.map((r) => r.plate_lot_id)]);
      await conn.query('UPDATE cf_nest_placements SET deleted_at = NOW() WHERE company_id = ? AND cut_plate_id = ? AND plate_lot_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY, Y, yRows[0].plate_lot_id]);
      const c923 = { companyId: COMPANY, userId: (await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]))[0][0]?.id ?? null };
      const left = await UT.getUntracked(conn, COMPANY, RELEASE_LINE);
      ok(`the line's left over is X ×${xPieces} and Y ×1`, left.leftOver.find((r) => r.cutPlateId === X)?.qty === xPieces && left.leftOver.find((r) => r.cutPlateId === Y)?.qty === 1, J(left.leftOver.map((r) => [r.cutPlateId, r.qty])));
      if (line.status !== 'confirmed') {
        await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
        await SO.setOrderStatus(conn, c923, line.order_id, 'confirmed');
      }
      let check = await REL.releaseCheck(conn, COMPANY, RELEASE_LINE);
      ok('before marking, release is refused for Y (the nest lays out one fewer)', !check.ok && check.problems.some((p) => /nest the line again/.test(p)), check.problems.slice(0, 3).join(' | '));
      await UT.markUntracked(conn, c923, RELEASE_LINE, { pieces: [{ cutPlateId: X }, { cutPlateId: Y }] }).catch(async (err) => {
        // A confirmed order may be closed to nesting in this tenant: mark as the screen would have, before confirming.
        if (err?.code !== 'ORDER_LOCKED') throw err;
        await conn.query('INSERT INTO cf_nest_untracked (company_id, order_line_id, cut_plate_id, quantity) VALUES (?, ?, ?, ?), (?, ?, ?, 1)', [COMPANY, RELEASE_LINE, X, xPieces, COMPANY, RELEASE_LINE, Y]);
      });
      check = await REL.releaseCheck(conn, COMPANY, RELEASE_LINE);
      if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
        await AREAS.createArea(conn, c923, { code: `UT${Date.now().toString(36).toUpperCase()}-DSP`, name: 'Untracked test dispatch', purpose: 'dispatch' });
        check = await REL.releaseCheck(conn, COMPANY, RELEASE_LINE);
      }
      ok('marked: release is allowed — no "nest again", no "no plate yet", no heat or lot asked', check.ok, check.problems.slice(0, 3).join(' | '));
      const planned = (await REL.plannedMaterialOfLines(conn, COMPANY, [{ id: RELEASE_LINE }])).get(RELEASE_LINE);
      ok('the buy list\'s plan for the line is ready (no cut plate without a plate) and has no problem', planned.ready === true && planned.problems.length === 0, J([planned.openPlates, planned.problems.slice(0, 2)]));
      const rel = await REL.releaseLine(conn, c923, RELEASE_LINE, check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {});
      const [xReqs] = await conn.query(
        `SELECT q.id FROM cf_material_requirements q JOIN cf_production_items pi ON pi.id = q.production_item_id
          WHERE q.release_id = ? AND q.deleted_at IS NULL AND pi.item_id = ?`, [rel.id, X]);
      const [xNodes] = await conn.query('SELECT id FROM cf_production_items WHERE release_id = ? AND item_id = ?', [rel.id, X]);
      ok(`released: X's ${xNodes.length} piece node(s) ask for no material at all`, xNodes.length > 0 && xReqs.length === 0, J([xNodes.length, xReqs.length]));
      const [lotReqs] = await conn.query('SELECT COUNT(*) AS n FROM cf_material_requirements WHERE release_id = ? AND deleted_at IS NULL AND bom_line_id IS NULL AND production_item_id IS NOT NULL', [rel.id]);
      const [catLots] = await conn.query("SELECT COUNT(*) AS n FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND source = 'catalog'", [COMPANY, RELEASE_LINE]);
      ok('the plates asked are still one whole plate per catalog lot', Number(lotReqs[0].n) === Number(catLots[0].n), J([lotReqs[0].n, catLots[0].n]));
      ok('(the release is rolled back with the rest of this suite)', true);
    }
  }
} catch (err) {
  failed += 1;
  fails.push(`ERROR ${err?.message}`);
  console.error('\nERROR', err);
} finally {
  await R.settleRuns().catch(() => {});
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  detachNodeCache(conn);
  conn.release();
}

section('Nothing survived the rollback');
const after = await counts();
const changed = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
ok('every cf_ table is back to the count it started at', changed.length === 0, changed.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));
const [[rel923]] = await pool.query('SELECT COUNT(*) AS n FROM cf_production_releases WHERE order_line_id = ? AND deleted_at IS NULL', [RELEASE_LINE]);
ok(`line ${RELEASE_LINE} is not released`, Number(rel923.n) === 0);
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
