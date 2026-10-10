/**
 * nest_v2_scale_test.mjs — Nesting v2 on a line THE SIZE OF THE KEPL BRIDGE ORDER, through the
 * real services and the real worker pool. Local only; ONE TRANSACTION, ROLLED BACK.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_v2_scale_test.mjs            # ~1 minute
 *   SCALE_PIECES=1500 SCALE_PARTS=80 SCALE_PLATES=30 …                        # a smaller line
 *
 * The line: ~6,000 pieces of ~250 cut plates in eight thicknesses (lib/nestScaleJob.mjs — the same
 * job nest_v2_scale_bench.mjs times through the pool alone), 30 % of the cut plates drawn, plates
 * of 12000 × 2500 and 6300 × 2500. It owns everything it uses (its own thicknesses, cut settings,
 * plates, grade, order, line, parts, cut plates, drawings).
 *
 * WHAT IS PROVED
 *   1. automatic nesting as a plan made INSIDE a request (the 20 s synchronous budget — the 5 / 10 /
 *      20 minute budgets belong to background runs: nest_run_test, nest_soak_test): back inside the
 *      budget (+10 %), every piece placed, never worse than rectangles alone, and the server's own thread never held (event loop) — the
 *      packing is in the worker pool, and so is the measuring of the plates;
 *   2. accepting that plan (a hundred true-shape plates): written, the thread never held;
 *   3. reading it back (GET …/nesting);
 *   4. 40 customer plates uploaded as DXF files, then "nest the rest" into their free space and
 *      onto new plates, and accepting that.
 * "Never held" = no single stretch over LOOP_MS (default 250 ms; the target is ~200 and a loaded
 * developer machine needs the slack). Every figure is printed.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache, insertRows } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const U = await imp('apps/cf_erp/services/nestDxfImportService.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const { readPartDrawing } = await imp('apps/cf_erp/services/partGeometry.js');
const { cutPlaces } = await imp('apps/cf_erp/lib/cutPlaces.js');
const { normMark } = await imp('apps/cf_erp/services/partDrawingService.js');
const { shapeToPartDxf, makeNestDxf, rectShape } = await imp('scripts/cf_kepl/lib/nestDxfFixtures.mjs');
const { buildScaleFixture } = await imp('scripts/cf_kepl/lib/nestScaleFixture.mjs');
const SYNC_MS = N.SYNC_PLAN_BUDGET_MS;

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const LOOP_MS = Number(process.env.LOOP_MS ?? 250);
const DENSITY = 7850;
const tag = `NS${Date.now().toString(36).toUpperCase()}`;

let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 600)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const J = (v) => JSON.stringify(v);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let trips = 0;
const db = new Proxy(conn, { get: (t, p) => (p === 'query' || p === 'execute' ? (...a) => { trips += 1; return t[p](...a); } : Reflect.get(t, p)) });
const c = { companyId: COMPANY, userId: null, userName: 'nest v2 scale test' };

/** Runs fn and says how long it took, how long the event loop was ever held, the peak memory and the round trips. */
async function timed(fn) {
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let peak = 0;
  const tick = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r; }, 25);
  const t0 = Date.now(); const at = trips;
  try {
    const result = await fn();
    return { result, ms: Date.now() - t0, loopMs: Math.round(lag.max / 1e6), peakMb: Math.round(Math.max(peak, process.memoryUsage().rss) / 1048576), trips: trips - at };
  } finally { clearInterval(tick); lag.disable(); }
}
const figures = {};
const say = (name, m, extra = {}) => { figures[name] = { ms: m.ms, loopMs: m.loopMs, peakMb: m.peakMb, trips: m.trips, ...extra }; console.log(`    ${name}: ${J(figures[name])}`); };

const build = () => buildScaleFixture(conn, { company: COMPANY, tag, pieces: Number(process.env.SCALE_PIECES ?? 6000), parts: Number(process.env.SCALE_PARTS ?? 250), plates: Number(process.env.SCALE_PLATES ?? 125) });

/** A drilled hole comes back as a circle { cx, cy, d }: as a ring again, to draw it in a file. */
const holeRing = (h) => (Array.isArray(h) ? h : Array.from({ length: 72 }, (_, k) => [h.cx + (h.d / 2) * Math.cos((k * 5 * Math.PI) / 180), h.cy + (h.d / 2) * Math.sin((k * 5 * Math.PI) / 180)]));
const nestsOf = (plan) => plan.groups.flatMap((g) => g.nests);
const piecesOf = (plan) => nestsOf(plan).reduce((a, n) => a + n.pieces.length, 0);

try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  section('Fixture');
  const built = await timed(build);
  const fx = built.result;
  console.log(`  ${tag}: line ${fx.lineId} — ${fx.pieces} pieces of ${fx.parts.length} cut plates (${fx.drawn} drawn) in ${fx.groups.length} thicknesses; built in ${built.ms} ms`);
  const partByCut = new Map(fx.parts.map((p) => [p.cutPlateId, p]));

  section('1. Automatic nesting at Quick — the plan');
  const rect = await timed(() => N.planNesting(db, COMPANY, fx.lineId, { effort: 'quick', seed: 1, shapes: false }));
  say('rectangles only', rect, { plates: rect.result.totals.plates, boughtM2: +(rect.result.totals.areaBought / 1e6).toFixed(1), wastePct: +((1 - rect.result.totals.partsKg / rect.result.totals.weightKg) * 100).toFixed(2) });
  const shaped = await timed(() => N.planNesting(db, COMPANY, fx.lineId, { effort: 'quick', seed: 1 }));
  const plan = shaped.result;
  say('with drawings', shaped, { plates: plan.totals.plates, boughtM2: +(plan.totals.areaBought / 1e6).toFixed(1), wastePct: +((1 - plan.totals.partsKg / plan.totals.weightKg) * 100).toFixed(2), budgetMs: plan.budget.capMs, workers: plan.budget.workers, taken: plan.groups.map((g) => g.shapes?.taken ?? '-').join(',') });
  ok('every piece is placed, on both', rect.result.totals.unplaced === 0 && plan.totals.unplaced === 0 && piecesOf(plan) === fx.pieces && piecesOf(rect.result) === fx.pieces, J([piecesOf(plan), piecesOf(rect.result), fx.pieces]));
  ok(`with drawings is never worse than rectangles alone: ${plan.totals.plates} plates against ${rect.result.totals.plates}`, plan.totals.plates <= rect.result.totals.plates && plan.totals.areaBought <= rect.result.totals.areaBought + 1e-6);
  ok(`a plan made inside a request is held to the synchronous budget (${SYNC_MS} ms), and is back inside it (+10 %): ${shaped.ms} ms`, plan.budget.capMs === SYNC_MS && plan.budget.sync === true && shaped.ms <= plan.budget.capMs * 1.1, J(plan.budget));
  ok(`the server's thread is never held while it plans: the longest stretch was ${shaped.loopMs} ms (rectangles: ${rect.loopMs} ms)`, shaped.loopMs <= LOOP_MS && rect.loopMs <= LOOP_MS);
  ok('every steel with a drawing was a shape job and says which layout it took', plan.groups.every((g) => !g.cutPlates.some((cp) => partByCut.get(cp.id)?.shape) || ['shape', 'rectangles'].includes(g.shapes?.taken)));
  ok('each plate adds up on the true shapes (parts + waste by cause = the plate, to 1 mm²)', nestsOf(plan).every((n) => Math.abs(n.usedArea + Object.values(n.waste).reduce((a, b) => a + b, 0) - n.sheetArea) <= 1));

  section('2. Accepting it');
  const acc = await timed(() => N.acceptNesting(db, c, fx.lineId, plan));
  say('accept', acc, { lots: acc.result.lots, pieces: acc.result.pieces });
  ok('the whole plan is written', acc.result.lots === plan.totals.plates && acc.result.pieces === fx.pieces);
  ok(`the thread is never held while it is checked and written: longest stretch ${acc.loopMs} ms`, acc.loopMs <= LOOP_MS);
  ok(`in a number of round trips that does not come from the size of the line: ${acc.trips}`, acc.trips <= 80);

  section('3. Reading it back');
  const got = await timed(() => N.getNesting(db, COMPANY, fx.lineId));
  say('GET nesting', got, { plates: got.result.totals.plates });
  ok('the saved plan reads back whole', got.result.totals.plates === plan.totals.plates && Math.abs(got.result.totals.areaBought - plan.totals.areaBought) < 1e-3);

  section('4. 40 customer plates uploaded, then nest the rest');
  // The customer's nesting: 40 plates of the rectangle plan, each with every other part left off —
  // so there is free space on each, and most of the line is still to be nested.
  await N.clearLots(db, c, fx.lineId, {});
  const customer = nestsOf(rect.result).filter((nst) => nst.pieces.length >= 4).slice(0, 40);
  const files = customer.map((nst, i) => {
    const parts = nst.pieces.filter((q, k) => k % 2 === 0).map((q) => {
      const part = partByCut.get(q.cutPlateId);
      // A drawn part exactly as the plan has it on the plate (its outline, cut-outs and holes); a
      // rectangle as the line states it (LENGTH along x at 0°).
      if (q.rings) return { rings: [q.rings.outline, ...q.rings.cutouts, ...q.rings.holes.map(holeRing)], x: q.x, y: q.y, rotationDeg: 0, label: part.cpCode };
      return { shape: rectShape(part.L, part.W), x: q.x, y: q.y, rotationDeg: Math.abs(q.length - part.L) < 0.01 ? 0 : 90, label: part.cpCode };
    });
    // Its own nest number in the title: two plates cut the same way are still two files.
    const text = makeNestDxf({ plate: { length: nst.length, width: nst.width }, parts, style: 'polyline', options: { title: [`NEST NO: ${tag}-U${i + 1}`] } });
    return { filename: `${tag}-U${i + 1}_${nst.thickness}mm_${nst.length}x${nst.width}.dxf`, file: Buffer.from(text, 'latin1').toString('base64'), parts: parts.length };
  });
  const up = await timed(() => U.uploadNestFiles(db, c, fx.lineId, { files: files.map(({ filename, file }) => ({ filename, file })), dryRun: false }));
  say('upload 40 files (save)', up, { plates: up.result.saved?.lots ?? 0, pieces: up.result.saved?.pieces ?? 0, leftOverToNest: up.result.totals.leftOverToNest });
  ok(`the ${files.length} files are read, checked and saved clean: ${up.result.saved?.pieces} pieces on ${up.result.saved?.lots} plates`, up.result.applied === true && up.result.saved.lots === files.length && up.result.saved.pieces === files.reduce((a, f) => a + f.parts, 0) && up.result.problems.length === 0, J([up.result.problems.slice(0, 3), up.result.warnings.slice(0, 3)]));
  ok(`the thread is never held while 40 files are read and checked: longest stretch ${up.loopMs} ms`, up.loopMs <= LOOP_MS);

  const rest = await timed(() => N.planNesting(db, COMPANY, fx.lineId, { effort: 'quick', seed: 1 }));
  const rp = rest.result;
  say('nest the rest', rest, { newPlates: rp.totals.plates, onExisting: rp.rest.onExisting, existingPlatesUsed: rp.rest.existingPlatesUsed, onNew: rp.rest.onNew, unplaced: rp.rest.unplaced, budgetMs: rp.budget.capMs });
  ok(`everything left over is placed: ${rp.rest.onExisting} pieces into ${rp.rest.existingPlatesUsed} of the customer's plates, ${rp.rest.onNew} onto ${rp.totals.plates} new ones`, rp.rest.unplaced === 0 && rp.rest.onExisting + rp.rest.onNew === up.result.totals.leftOverToNest && rp.rest.onExisting > 0, J(rp.rest && { ...rp.rest, pieces: undefined }));
  ok(`inside the plan's budget (+10 %): ${rest.ms} ms of ${rp.budget.capMs}`, rest.ms <= rp.budget.capMs * 1.1);
  ok(`the thread is never held: longest stretch ${rest.loopMs} ms`, rest.loopMs <= LOOP_MS);
  const acc2 = await timed(() => N.acceptNesting(db, c, fx.lineId, rp));
  say('accept nest the rest', acc2, { lots: acc2.result.lots, additions: acc2.result.additions });
  ok('accepted: the additions are written on the customer\'s plates, the new plates beside them', acc2.result.additions.pieces === rp.rest.onExisting && acc2.result.lots === rp.totals.plates && acc2.loopMs <= LOOP_MS, J([acc2.result.additions, acc2.loopMs]));
  const [[left]] = await conn.query("SELECT COUNT(*) n FROM cf_nest_placements p JOIN cf_plate_lots l ON l.id = p.plate_lot_id WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL AND p.deleted_at IS NULL", [COMPANY, fx.lineId]);
  ok('the line is nested whole: every piece is on a plate', Number(left.n) === fx.pieces, `${left.n} of ${fx.pieces}`);

  console.log(`\n  figures: ${J(figures)}`);
} catch (err) {
  failed += 1; fails.push(`ERROR ${err?.message}`);
  console.error('\nERROR', err);
} finally {
  await R.settleRuns().catch(() => {});
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  detachNodeCache(conn);
  conn.release();
}

section('Nothing survived the rollback');
const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
ok('every cf_ table is back to the count it started at', drift.length === 0, drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
