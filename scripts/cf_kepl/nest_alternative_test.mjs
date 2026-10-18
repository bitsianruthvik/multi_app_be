/**
 * nest_alternative_test.mjs — AI'S NESTING STORED BESIDE THE MANUAL ONE (init.sql §87, 2026-10-18), BUG 9 and
 * PERFORMANCE 17. Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_alternative_test.mjs          # every scenario
 *   node scripts/cf_kepl/nest_alternative_test.mjs 1 3                         # only these
 *   CF_NEST_COMPANY=2 (the tenant that owns the fixture)
 *
 *   1. an upload saved → AI's run of the same pieces (Standard, the server's own start) is the line's ALTERNATIVE:
 *      the row points at it, the uploaded nesting stays the main one, the comparison carries both sides and net steel
 *   2. "Make AI's the main nesting": AI's plates replace the customer's, through the plate-change gate with its
 *      before / after sheet; the customer's plates are kept; the comparison still shows both (main: ai); plate
 *      quantities and cut lengths worked out again; held-back pieces said and left over
 *   3. survives a reload (another read, the server's memory gone) — and switch back: the customer's plates come back
 *      exactly (placements, offcuts, files, plate quantities); swap again and back again
 *   4. refused: a stale run id, an already-main side, a line with a production order (locked) — in words
 *   5. a new upload makes the alternative the new upload's; a stale swapped state is not swapped back
 *   6. BUG 9: after "Use this nesting" an older finished proposal is NOT shown again on the next read
 *   7. PERFORMANCE 17: round trips of "Use this nesting" (with the before / after sheet) and of the swaps — the same
 *      at two sizes and within the budget (≤ 80)
 *   8. the backfill (runAlternative): dry run writes nothing; --commit stores it once; a second run is a no-op
 *   9. nothing survived the rollback; line 923 untouched
 *
 * ONE TRANSACTION, ROLLED BACK, every cf_ table re-counted at the end. It owns its fixture (lib/nestV2Fixture.mjs).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// A Standard run here is capped at 3 s (10 min × 0.005); the fixture line is small.
process.env.CF_NEST_BUDGET_SCALE = process.env.CF_NEST_BUDGET_SCALE ?? '0.005';
process.env.CF_NEST_AUTO_COMPARE = 'off';     // the test starts AI's run itself, on its own connection

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const U = await imp('apps/cf_erp/services/nestDxfImportService.js');
const C = await imp('apps/cf_erp/services/nestCompareService.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const A = await imp('apps/cf_erp/services/nestAlternativeService.js');
const PC = await imp('apps/cf_erp/services/plateChangeService.js');
const F = await imp('scripts/cf_kepl/lib/nestV2Fixture.mjs');
const BF = await imp('scripts/cf_kepl/lib/backfillAlternatives.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const KEPL_LINE = 923;
/** PERFORMANCE 17: the most round trips one plate save may take (TiDB ~49 ms each: ~4 s). */
const TRIP_BUDGET = 80;
const ONLY = new Set(process.argv.slice(2).map(Number).filter(Boolean));
const want = (n) => !ONLY.size || ONLY.has(n);

let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean (${String(name).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const J = (v) => JSON.stringify(v);
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + Number(f(x) ?? 0), 0);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const [[kepl0]] = await pool.query('SELECT COUNT(*) n FROM cf_production_releases WHERE order_line_id = ? AND deleted_at IS NULL', [KEPL_LINE]);

/** Counts the round trips made through it (a Proxy: a memo set on it lands on the connection, as in the app). */
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, {
    get: (target, prop) => (prop === 'query' || prop === 'execute'
      ? (...args) => { tally.n += 1; if (process.env.NEST_ALT_TRACE) console.log(`    ${String(tally.n).padStart(4)}  ${String(args[0]?.sql ?? args[0]).replace(/\s+/g, ' ').slice(0, 120)}`); return target[prop](...args); }
      : Reflect.get(target, prop)),
  });
  return { db: proxy, tally };
}

const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'nest alternative test' };

const asRequest = (fx, files) => files.map((f) => ({ filename: f.filename, file: f.file, ...(f.style === 'segments' ? { plateCode: fx.plateCode('PS') } : {}) }));
const uploadSave = (fx, files, opts = {}) => U.uploadNestFiles(conn, c, fx.lineId, { files: asRequest(fx, files), dryRun: false, ...opts });
const lotsOf = async (fx, { live = true } = {}) => (await conn.query(`SELECT * FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND kind = 'plate'${live ? ' AND deleted_at IS NULL' : ''} ORDER BY id`, [COMPANY, fx.lineId]))[0];
const placementsOf = async (ids) => (ids.length ? (await conn.query('SELECT plate_lot_id, cut_plate_id, x_mm, y_mm, rotation_deg, deleted_at FROM cf_nest_placements WHERE company_id = ? AND plate_lot_id IN (?) ORDER BY id', [COMPANY, ids]))[0] : []);
const offcutsOf = async (ids) => (ids.length ? (await conn.query('SELECT id, plate_lot_id, deleted_at FROM cf_offcuts WHERE company_id = ? AND plate_lot_id IN (?)', [COMPANY, ids]))[0] : []);
const filesOf = async (fx) => (await conn.query('SELECT id, deleted_at FROM cf_nest_files WHERE company_id = ? AND order_line_id = ?', [COMPANY, fx.lineId]))[0];
const plateLines = async (fx) => Object.fromEntries(await Promise.all(Object.entries(fx.plateLine).map(async ([sfx, id]) => { const [[r]] = await conn.query('SELECT child_id, quantity FROM cf_bom_lines WHERE id = ?', [id]); return [sfx, `${r.child_id}:${Number(r.quantity).toFixed(6)}`]; })));
const valueOf = async (masterId, code) => {
  const [[r]] = await conn.query("SELECT v.value_number FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL AND s.code = ?", [COMPANY, masterId, code]);
  return r ? Number(r.value_number) : null;
};
const clearLine = async (fx) => { const lots = await lotsOf(fx); if (lots.length) await N.clearLots(conn, c, fx.lineId, { ids: lots.map((l) => l.id) }); };

/** The server's own start after an upload (startAutoCompare on this connection), waited for to the end. */
async function aiRun(fx, opts = {}) {
  const out = await C.startAutoCompare(conn, c, fx.lineId, { trigger: 'upload', ...opts });
  for (let i = 0; i < 600; i += 1) {
    if (R.memoryRun(COMPANY, fx.lineId)?.status !== 'running') break;
    await wait(100);
  }
  await R.settleRuns();
  return out;
}
const swap = (fx, to, extra = {}, db = conn) => PC.plateChangeGate(db, c, fx.lineId, 'swap_alternative', { to, ...extra }, (b) => A.swapAlternative(db, c, fx.lineId, b));

try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  section('Fixture');
  const fx = await F.buildFixture(conn, { company: COMPANY });
  const sets = F.nestings(fx);
  console.log(`  ${fx.tag}: line ${fx.lineId}, ${Object.keys(fx.cut).length} cut plates, ${sum(Object.values(fx.parts), (p) => p.qty)} pieces`);

  /* ───────────── 1 ───────────── */
  section('1. An upload saved: AI nests the same pieces and it is STORED as the line\'s alternative');
  const up = await uploadSave(fx, sets.B);
  ok('the customer\'s nesting (5 plates) is saved', up.applied === true, J([up.message, up.problems?.slice(0, 2)]));
  const upLots = await lotsOf(fx);
  const started = await aiRun(fx);
  ok('AI\'s Standard run of the uploaded pieces started (the server\'s start after an upload)', started.started === true && !!started.runId, J(started));
  let alt = await A.readAlternative(conn, COMPANY, fx.lineId);
  ok('the line\'s alternative row points at that run; the uploaded nesting is the MAIN one', !!alt && alt.runUid === started.runId && alt.main === 'uploaded' && !!alt.uploadKey, J(alt));
  ok('…and nothing on the line changed: the same customer\'s plates are saved', J((await lotsOf(fx)).map((l) => l.id)) === J(upLots.map((l) => l.id)));
  let cmp = await C.getCompare(conn, COMPANY, fx.lineId, {});
  ok('the comparison has both sides ready', !!cmp.uploaded && cmp.auto.status === 'ready' && cmp.auto.runId === started.runId, J([cmp.auto.status, cmp.auto.reason]));
  ok('both sides carry steel bought, NET steel (offcuts kept), waste, cut length, piercings and plates', ['tonnesBought', 'netTonnes', 'wasteKgTotal', 'cutLengthM', 'piercings', 'plates'].every((k) => cmp.uploaded.metrics[k] != null && cmp.auto.metrics[k] != null)
    && Math.abs(cmp.uploaded.metrics.netTonnes - (cmp.uploaded.metrics.tonnesBought - cmp.uploaded.metrics.offcuts.kg / 1000)) < 0.002, J(cmp.uploaded.metrics));
  ok('the alternative block: main "uploaded", may be swapped to "ai", not locked', cmp.alternative?.main === 'uploaded' && cmp.alternative.canSwap.to === 'ai' && cmp.alternative.canSwap.ok === true && cmp.alternative.locked === false && cmp.alternative.runId === started.runId, J(cmp.alternative));
  const heldBack = sum((cmp.likeForLike?.differ ?? []).filter((d) => d.uploaded > d.auto), (d) => d.uploaded - d.auto);
  ok('like for like: AI nests every piece the customer did — the NEST_MANUAL ones too — so nothing is left over after a swap', cmp.likeForLike?.same === true && cmp.alternative.leftOverAfter === heldBack && heldBack === 0, J([cmp.alternative.leftOverAfter, heldBack, cmp.likeForLike]));
  const upMetrics = cmp.uploaded.metrics; const aiMetrics = cmp.auto.metrics;
  const aiPlan = (await C.getCompare(conn, COMPANY, fx.lineId, { detail: true })).auto.plan;
  const aiNests = aiPlan.groups.flatMap((g) => g.nests);

  /* ───────────── 2 ───────────── */
  let qtyUploaded = null; let swapped1 = null;
  if (want(2) || want(3) || want(4) || want(5)) {
    section('2. Make AI\'s nesting the main one');
    qtyUploaded = await plateLines(fx);
    const cutBefore = await valueOf(fx.cut.R, 'CUT_LENGTH');
    swapped1 = await swap(fx, 'ai', { runId: started.runId, impact: true });
    ok('swapped through the gate: AI is the main one, with the before / after sheet', swapped1.main === 'ai' && swapped1.plateChange?.direct === true && !!swapped1.plateChange.impact, J([swapped1.message, swapped1.plateChange?.impact?.sentence]));
    const live = await lotsOf(fx);
    ok(`the line now holds AI's ${aiNests.length} plates (ours), none of the customer's`, live.length === aiNests.length && live.every((l) => l.origin === 'auto'), J(live.map((l) => [l.lot_no, l.origin])));
    ok('AI\'s plates never wear a customer plate\'s number', live.every((l) => !upLots.some((u) => u.lot_no.toUpperCase() === l.lot_no.toUpperCase())));
    const kept = await lotsOf(fx, { live: false });
    ok('the customer\'s plates are KEPT (soft-deleted), their placements and files too', upLots.every((u) => kept.find((k) => k.id === u.id)?.deleted_at != null) && (await filesOf(fx)).every((f) => f.deleted_at != null));
    alt = await A.readAlternative(conn, COMPANY, fx.lineId);
    ok('the row: main ai, valid, the customer\'s plate ids and AI\'s plate ids, one swap', alt.main === 'ai' && alt.valid === true && J(alt.uploadLotIds.sort()) === J(upLots.map((l) => l.id).sort()) && J(alt.aiLotIds.sort()) === J(live.map((l) => l.id).sort()) && alt.swapCount === 1, J(alt));
    const manualOn = Number((await conn.query('SELECT COUNT(*) n FROM cf_nest_placements WHERE plate_lot_id IN (?) AND cut_plate_id = ? AND deleted_at IS NULL', [live.map((l) => l.id), fx.cut.M]))[0][0].n);
    ok("nothing is left over; the NEST_MANUAL pieces the customer nested are on AI's plates", swapped1.leftOver === heldBack && manualOn === fx.parts.M.qty, J([swapped1.leftOver, manualOn]));
    const qtyAi = await plateLines(fx);
    ok('the plate quantities are worked out again from AI\'s plates', J(qtyAi) !== J(qtyUploaded), J([qtyUploaded, qtyAi]));
    ok('…and the cut lengths', (await valueOf(fx.cut.R, 'CUT_LENGTH')) > 0, J([cutBefore, await valueOf(fx.cut.R, 'CUT_LENGTH')]));
    cmp = await C.getCompare(conn, COMPANY, fx.lineId, {});
    ok('the comparison still stands, the same two sides, now main "ai", may switch back', cmp.alternative.main === 'ai' && cmp.alternative.canSwap.to === 'uploaded' && cmp.alternative.canSwap.ok === true
      && cmp.uploaded?.metrics.tonnesBought === upMetrics.tonnesBought && cmp.auto.metrics.tonnesBought === aiMetrics.tonnesBought && cmp.auto.runId === started.runId, J([cmp.alternative, cmp.uploaded?.metrics.tonnesBought, upMetrics.tonnesBought, cmp.auto.status]));
    const view = await N.getNesting(conn, COMPANY, fx.lineId);
    ok('the Nesting screen\'s saved plan is AI\'s plates', view.groups.flatMap((g) => g.nests).length === aiNests.length);
  }

  /* ───────────── 3 ───────────── */
  if (want(3) || want(4)) {
    section('3. It survives a reload; switch back, and again');
    await R._forgetMemory();
    alt = await A.readAlternative(conn, COMPANY, fx.lineId);
    const light = await A.alternativeOf(conn, COMPANY, fx.lineId);
    ok('after the server forgot everything, the row still says AI is the main one', alt.main === 'ai' && alt.valid && light.main === 'ai' && light.locked === false, J(light));
    const back = await swap(fx, 'uploaded', { impact: true });
    const live = await lotsOf(fx);
    ok('switched back: the customer\'s plates are the main ones again — the SAME rows', back.main === 'uploaded' && J(live.map((l) => l.id)) === J(upLots.map((l) => l.id)), J([back.message, live.map((l) => l.id)]));
    const pl = await placementsOf(upLots.map((l) => l.id));
    ok('…with every placement and offcut live again, and the files', pl.length > 0 && pl.every((p) => p.deleted_at == null) && (await offcutsOf(upLots.map((l) => l.id))).every((o) => o.deleted_at == null) && (await filesOf(fx)).every((f) => f.deleted_at == null));
    ok('…and the plate quantities exactly as they were before the swap', J(await plateLines(fx)) === J(qtyUploaded), J([qtyUploaded, await plateLines(fx)]));
    cmp = await C.getCompare(conn, COMPANY, fx.lineId, {});
    ok('the comparison: main "uploaded" again, AI\'s nesting still beside it', cmp.alternative.main === 'uploaded' && cmp.auto.status === 'ready' && cmp.auto.runId === started.runId && cmp.uploaded.metrics.tonnesBought === upMetrics.tonnesBought, J(cmp.alternative));
    const again = await swap(fx, 'ai', { runId: started.runId });
    ok('swap to AI a second time', again.main === 'ai' && (await lotsOf(fx)).length === aiNests.length && (await A.readAlternative(conn, COMPANY, fx.lineId)).swapCount === 3);
    const back2 = await swap(fx, 'uploaded', {});
    ok('…and back a second time', back2.main === 'uploaded' && J((await lotsOf(fx)).map((l) => l.id)) === J(upLots.map((l) => l.id)) && J(await plateLines(fx)) === J(qtyUploaded));
  }

  /* ───────────── 4 ───────────── */
  if (want(4)) {
    section('4. Refused, in words');
    let e = await refusal(() => swap(fx, 'ai', { runId: '00000000-0000-0000-0000-000000000000' }));
    ok('a run id the screen showed that is no longer the alternative: STALE_RUN', e?.code === 'STALE_RUN', e?.message);
    e = await refusal(() => swap(fx, 'uploaded', {}));
    ok('switching to the side that already is the main one: ALREADY_MAIN', e?.code === 'ALREADY_MAIN', e?.message);
    e = await refusal(() => swap(fx, 'sideways', {}));
    ok('a side that does not exist: INVALID', e?.code === 'INVALID', e?.message);
    // The line gets a production order (step 4's freeze): the nesting is locked.
    await conn.query("INSERT INTO cf_production_orders (company_id, order_id, seq, code, label, level, order_line_id, scope_key, lines_json) VALUES (?, ?, 1, ?, 'Alt test', 'line', ?, ?, JSON_ARRAY(?))", [COMPANY, fx.orderId, `${fx.tag}-PO1`, fx.lineId, `line:${fx.lineId}`, fx.lineId]);
    e = await refusal(() => swap(fx, 'ai', { runId: started.runId }));
    ok('a line with a production order: PRODUCTION_ORDER — its nesting is frozen', e?.code === 'PRODUCTION_ORDER', e?.message);
    cmp = await C.getCompare(conn, COMPANY, fx.lineId, {});
    ok('…and the comparison says locked, with the reason, and may not swap', cmp.alternative.locked === true && cmp.alternative.canSwap.ok === false && /frozen/.test(cmp.alternative.canSwap.reason ?? ''), J(cmp.alternative));
    await conn.query('DELETE FROM cf_production_orders WHERE company_id = ? AND code = ?', [COMPANY, `${fx.tag}-PO1`]);
  }

  /* ───────────── 5 ───────────── */
  if (want(5)) {
    section('5. A new upload: the alternative is the new upload\'s; a stale swapped state is not swapped back');
    await swap(fx, 'ai', { runId: started.runId });
    await clearLine(fx);                              // somebody re-nested: AI's plates gone
    alt = await A.readAlternative(conn, COMPANY, fx.lineId);
    ok('AI\'s plates taken off under it: the swapped state is no longer valid', alt.main === 'ai' && alt.valid === false);
    const e = await refusal(() => swap(fx, 'uploaded', {}));
    ok('…so switching back is refused (ALTERNATIVE_STALE), nothing brought back', e?.code === 'ALTERNATIVE_STALE' && (await lotsOf(fx)).length === 0, e?.message);
    const up2 = await uploadSave(fx, sets.A);
    const run2 = await aiRun(fx);
    alt = await A.readAlternative(conn, COMPANY, fx.lineId);
    // Set A nests the very same pieces as set B: the same demand, so the run already there answers it (nothing packed).
    ok("a new upload saved (the same pieces on other plates): AI's run of those pieces is its alternative, the new upload the main one", up2.applied === true && run2.answered === true && alt.runUid === run2.runId && alt.main === 'uploaded' && alt.uploadLotIds.length === 0 && alt.uploadKey !== null, J([alt, run2.message]));
    cmp = await C.getCompare(conn, COMPANY, fx.lineId, {});
    ok('…and the comparison is of the new upload', cmp.auto.runId === run2.runId && cmp.uploaded.metrics.plates === sets.A.length, J([cmp.auto.runId, cmp.uploaded?.metrics.plates]));
    await clearLine(fx);
  }

  /* ───────────── 6 ───────────── */
  if (want(6)) {
    section('6. BUG 9: after "Use this nesting" an older unused proposal is not shown again');
    await clearLine(fx);
    const plan = await N.planNesting(conn, COMPANY, fx.lineId, { effort: 'quick', seed: 1, budgetMs: 1500 });
    const demand = { hash: 'bug9-older' };
    const older = await R.insertFinishedRun(conn, { companyId: COMPANY, lineId: fx.lineId, plan, demand, input: { effort: 'quick' }, startedAt: Date.now() - 60_000, finishedAt: Date.now() - 50_000, startedBy: 'older run' });
    const newer = await R.insertFinishedRun(conn, { companyId: COMPANY, lineId: fx.lineId, plan, demand: { hash: 'bug9-newer' }, input: { effort: 'quick' }, startedBy: 'newer run' });
    let seen = await R.readRun(COMPANY, fx.lineId, { db: conn });
    ok('before: the newest proposal is the one on the page', seen.status === 'done' && seen.runId === newer.runId, J([seen.status, seen.runId]));
    // "Use this nesting" = the route: the gate with the before / after sheet, then the run dismissed as accepted.
    await PC.plateChangeGate(conn, c, fx.lineId, 'accept', { ...plan, impact: true }, (b) => N.acceptNesting(conn, c, fx.lineId, b));
    R.dismissRun(COMPANY, fx.lineId, { accepted: true, db: conn });
    await R.settleRuns();
    seen = await R.readRun(COMPANY, fx.lineId, { db: conn });
    ok('after: the OLDER proposal is not shown in place of the saved plan (none is)', seen.status === 'none', J([seen.status, seen.runId, older.runId]));
    const [rows] = await conn.query('SELECT run_uid, status, dismissed_at FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? AND run_uid IN (?)', [COMPANY, fx.lineId, [older.runId, newer.runId]]);
    ok('…both proposals are kept as rows, superseded (dismissed), still `ready` for a comparison', rows.length === 2 && rows.every((r) => r.status === 'ready' && r.dismissed_at != null), J(rows));
    await clearLine(fx);
  }

  /* ───────────── 7 ───────────── */
  if (want(7)) {
    section(`7. PERFORMANCE 17: round trips of a plate save do not grow with pieces or plates, and stay within ${TRIP_BUDGET}`);
    const trips = {};
    for (const [label, scale] of [['small', 1], ['large', 4]]) {
      const f = await F.buildFixture(conn, { company: COMPANY, scale });
      const plan = await N.planNesting(conn, COMPANY, f.lineId, { effort: 'quick', seed: 1, budgetMs: 1500 });
      const t = { plates: plan.groups.flatMap((g) => g.nests).length, pieces: sum(plan.groups.flatMap((g) => g.nests), (n) => n.pieces.length) };
      await N.acceptNesting(conn, c, f.lineId, plan);            // something saved, so the "before" has plates to measure
      let k = counting(conn);
      let t0 = Date.now();
      await PC.plateChangeGate(k.db, c, f.lineId, 'accept', { ...plan, impact: true }, (b) => N.acceptNesting(k.db, c, f.lineId, b));
      t.accept = k.tally.n; t.acceptMs = Date.now() - t0;
      k = counting(conn);
      await PC.plateChangeGate(k.db, c, f.lineId, 'accept', { ...plan }, (b) => N.acceptNesting(k.db, c, f.lineId, b));
      t.acceptNoSheet = k.tally.n;
      // The swaps, on an upload of this size (every set copied `scale` times).
      await N.clearLots(conn, c, f.lineId, { ids: (await conn.query("SELECT id FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [f.lineId]))[0].map((r) => r.id) });
      const files = F.nestings(f).B;
      const saved = await U.uploadNestFiles(conn, c, f.lineId, { files: asRequest(f, files), dryRun: false });
      const run = await aiRun(f);
      k = counting(conn); t0 = Date.now();
      await swap(f, 'ai', { runId: run.runId, impact: true }, k.db);
      t.toAi = k.tally.n; t.toAiMs = Date.now() - t0;
      k = counting(conn);
      await swap(f, 'uploaded', { impact: true }, k.db);
      t.back = k.tally.n;
      k = counting(conn);
      await A.alternativeOf(k.db, COMPANY, f.lineId);
      t.light = k.tally.n;
      trips[label] = { ...t, uploaded: saved.applied, uploadPlates: files.length };
    }
    console.log(`    small ${J(trips.small)}\n    large ${J(trips.large)}`);
    ok('the large line has more plates and four times the pieces', trips.large.pieces === 4 * trips.small.pieces && trips.large.uploadPlates === 4 * trips.small.uploadPlates && trips.large.uploaded && trips.small.uploaded, J(trips));
    for (const key of ['accept', 'acceptNoSheet', 'toAi', 'back', 'light']) {
      ok(`${key}: ${trips.small[key]} round trips at either size, within ${TRIP_BUDGET}`, trips.small[key] === trips.large[key] && trips.small[key] > 0 && trips.large[key] <= TRIP_BUDGET, `${trips.small[key]} vs ${trips.large[key]}`);
    }
    ok('"Use this nesting" with its before / after sheet: at most 75 round trips (it was 150)', trips.large.accept <= 75, String(trips.large.accept));
  }

  /* ───────────── 8 ───────────── */
  if (want(8)) {
    section('8. The backfill: AI\'s alternative for an upload saved before this existed');
    const f = await F.buildFixture(conn, { company: COMPANY });
    await U.uploadNestFiles(conn, c, f.lineId, { files: asRequest(f, F.nestings(f).B), dryRun: false });
    const listed = await A.linesToBackfill(conn, { companyId: COMPANY, orderIds: [f.orderId] });
    ok('the line with an uploaded nesting is found', listed.length === 1 && listed[0].lineId === f.lineId, J(listed));
    const runsOf = async () => Number((await conn.query("SELECT COUNT(*) n FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ?", [COMPANY, f.lineId]))[0][0].n);
    const n0 = await runsOf();
    // The script's own engine (scripts/cf_kepl/lib/backfillAlternatives.mjs), on this connection; Standard capped at 0.05 min.
    const run = (mode) => BF.backfill({ db: conn, companyId: COMPANY, orderIds: [f.orderId], mode, minutes: 0.05 });
    const dryList = await run('dry');
    ok('dry run (the default): the line is listed as "would be nested", nothing nested, nothing written', dryList.length === 1 && dryList[0].status === 'would' && (await runsOf()) === n0, J(dryList));
    const tried = await run('try');
    ok('--try: nested here, the result said, nothing written', tried[0]?.status === 'tried' && tried[0].plates > 0 && !tried[0].runId && (await runsOf()) === n0 && !(await A.readAlternative(conn, COMPANY, f.lineId)), J(tried));
    const done = (await run('commit'))[0];
    const alt8 = await A.readAlternative(conn, COMPANY, f.lineId);
    const [[row8]] = await conn.query('SELECT purpose, scope, status, kind FROM cf_nest_runs WHERE company_id = ? AND run_uid = ?', [COMPANY, done?.runId ?? '']);
    ok('--commit stores ONE finished run (purpose compare, scope subset) and the alternative row points at it', done?.status === 'stored' && (await runsOf()) === n0 + 1 && alt8?.runUid === done.runId && alt8.main === 'uploaded'
      && row8?.purpose === 'compare' && row8.scope === 'subset' && row8.status === 'ready', J([done, alt8, row8]));
    const cmp8 = await C.getCompare(conn, COMPANY, f.lineId, {});
    ok('…which the comparison shows as the AI side, ready to swap', cmp8.auto.status === 'ready' && cmp8.auto.runId === done.runId && cmp8.alternative.canSwap.ok === true, J([cmp8.auto.status, cmp8.auto.reason]));
    const again = (await run('commit'))[0];
    ok('--commit again: nothing nested, nothing written (idempotent)', again?.status === 'skipped' && again.runId === done.runId && (await runsOf()) === n0 + 1, J(again));
    ok('…and the dry run now says the line has its alternative', (await run('dry'))[0]?.status === 'has');
    const busyRow = await R.insertFinishedRun(conn, { companyId: COMPANY, lineId: f.lineId, plan: { groups: [] }, demand: { hash: 'x' }, input: {} });
    await conn.query("UPDATE cf_nest_runs SET status = 'running' WHERE run_uid = ?", [busyRow.runId]);
    ok('a run working on the line on the server: skipped, in words', (await run('commit'))[0]?.status === 'busy');
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

section('9. Nothing survived the rollback; line 923 untouched');
const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
ok('every cf_ table is back to the count it started at', drift.length === 0, drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));
const [[kepl1]] = await pool.query('SELECT COUNT(*) n FROM cf_production_releases WHERE order_line_id = ? AND deleted_at IS NULL', [KEPL_LINE]);
ok('line 923 is not released (as before)', Number(kepl1.n) === Number(kepl0.n) && Number(kepl1.n) === 0, `${kepl0.n} -> ${kepl1.n}`);

console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
