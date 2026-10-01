/**
 * kepl_quantities_test.mjs — scripts/cf_kepl/cf_kepl_quantities.mjs on the
 * local KEPL copy (line 923, company 2): the derivations, the dry run writes
 * nothing, a started or issued release is refused BEFORE anything is written,
 * the commit takes the release back, writes the values with history and
 * releases again with more timed steps, the Times grid then equals the
 * projection, and a second run changes nothing and leaves the release alone.
 *
 *   cd multi_app_be && node scripts/cf_kepl/kepl_quantities_test.mjs
 *   CF_KQ_DB=sqldb_optimes CF_KQ_COMPANY=2 CF_KQ_LINE=923 (the defaults)
 *
 * The scratch schema sqldb_optimes is the one with the CG plant set up and
 * cf_operation_times applied (HANDOFF 2026-10-01); plain sqldb company 2 has no
 * CG flows, so nothing there reads these quantities.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK — the confirm,
 * the dispatch area, the release, the take-back, the values — and the last
 * thing it does is re-count every cf_ table. Line 923 is never left released.
 */
process.env.DB_NAME = process.env.CF_KQ_DB ?? process.env.DB_NAME_KQ ?? 'sqldb_optimes';
const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await import('../../apps/cf_erp/lib/db.js');
const { releaseLine, releaseCheck, liveReleaseOfLine } = await import('../../apps/cf_erp/services/releaseService.js');
const { setOrderStatus } = await import('../../apps/cf_erp/services/salesOrderService.js');
const { createArea } = await import('../../apps/cf_erp/services/stockingAreaService.js');
const { run, shareWhole, sizeBand } = await import('./cf_kepl_quantities.mjs');

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_KQ_COMPANY ?? 2);
const LINE = Number(process.env.CF_KQ_LINE ?? 923);
const tag = `KQ${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(Number(a) - Number(b)) < eps;
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }

const [[{ db: schema }]] = await pool.query('SELECT DATABASE() AS db');
const [[hasSpec]] = await pool.query("SELECT COUNT(*) AS n FROM cf_specifications WHERE company_id = ? AND code = 'SAW_WELD_LENGTH' AND deleted_at IS NULL", [COMPANY]);
if (!Number(hasSpec.n)) throw new Error(`${schema} has no SAW_WELD_LENGTH for company ${COMPANY} — run against the scratch schema with cf_operation_times applied (CF_KQ_DB=sqldb_optimes).`);
console.log(`schema ${schema}, company ${COMPANY}, line ${LINE}`);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let trips = 0;
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { trips++; return t.query(...a); } : Reflect.get(t, p)) });

try {
  await conn.beginTransaction();
  attachNodeCache(db);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const q1 = async (sql, args) => (await conn.query(sql, args))[0][0];
  const valueRows = async () => Number((await q1("SELECT COUNT(*) AS n FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND deleted_at IS NULL", [COMPANY])).n);

  /* ------------------------------------------------------------------------ */
  section('0. Pure rules');
  ok('size band: 25 mm plates -> 12 (fill-up)', sizeBand(25) === 12);
  ok('size band: 8 mm plate -> 6 (root)', sizeBand(8) === 6);
  ok('size band: 10 mm -> 12 (fill-up starts at 10)', sizeBand(10) === 12);
  const s = shareWhole(1803, [{ qty: 1, weight: 11650 }, { qty: 3, weight: 12000 }, { qty: 1, weight: 11650 }]);
  ok('studs 1803 over end / 3 middle / end -> 354 / 365 / 354', JSON.stringify(s.values) === '[354,365,354]' && s.residual === 0, JSON.stringify(s));
  const s2 = shareWhole(10, [{ qty: 3, weight: 1 }]);
  ok('a share that cannot be whole says so (10 over 3 equal pieces)', s2.residual !== 0, JSON.stringify(s2));

  /* ------------------------------------------------------------------------ */
  section('1. Setup inside the transaction: confirm, dispatch area, release line 923');
  const line = await q1(`SELECT l.id, l.line_no, l.locked_at, l.order_id, o.code AS order_code, o.status FROM cf_sales_order_lines l
                           JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?`, [COMPANY, LINE]);
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (!line.locked_at) throw new Error(`Line ${LINE} is not locked — this suite expects the locked KEPL copy.`);
  if (await liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — this suite releases it itself.`);

  // An unreleased line: the plan works, and nothing is taken back.
  const dry0 = await run(db, COMPANY, { lineId: LINE, times: false });
  ok('unreleased: the plan reads the line and has values to write', dry0.changes.length > 0 && !dry0.data.release, `${dry0.changes.length}`);

  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await setOrderStatus(conn, c, line.order_id, 'confirmed');
  }
  let check = await releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await createArea(conn, c, { code: `${tag}-DSP`, name: `${tag} dispatch`, purpose: 'dispatch' });
    check = await releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const area = check.areas.find((a) => a.purpose === 'dispatch');
  const rel0 = await releaseLine(conn, c, LINE, area ? { finishedAreaId: area.id, notes: `${tag} first release` } : { notes: `${tag} first release` });
  ok('line 923 released inside the transaction', !!rel0?.id);

  /* ------------------------------------------------------------------------ */
  section('2. Dry run on the released line: derivations, nothing written');
  const v0 = await valueRows();
  const dry = await run(db, COMPANY, { lineId: LINE });
  ok('dry run wrote no value rows', (await valueRows()) === v0);
  ok('dry run kept release', (await liveReleaseOfLine(conn, COMPANY, LINE))?.id === rel0.id);
  ok('the release is seen, nothing started, nothing issued', dry.data.release?.id === rel0.id && dry.data.release.started === 0 && dry.data.release.issued === 0 && !dry.stopped);
  const W = (code) => dry.writes.filter((w) => w.code === code);
  const segRows = dry.data.nodes.filter((n) => n.cls === 'GIRDER_SEGMENT');
  const segOf = (len) => segRows.find((n) => n.children.some((k) => /top\s*flange/i.test(k.name) && Math.max(k.vals.LENGTH, k.vals.WIDTH) === len));
  const endSeg = segOf(11650);
  const midSeg = segOf(12000);
  const wv = (n, code) => dry.writes.find((w) => w.itemId === n?.id && w.code === code)?.value;
  ok('end segment SAW = 4 x 11.65 = 46.6 m', near(wv(endSeg, 'SAW_WELD_LENGTH'), 46.6), `${wv(endSeg, 'SAW_WELD_LENGTH')}`);
  ok('middle segment SAW = 4 x 12 = 48 m', near(wv(midSeg, 'SAW_WELD_LENGTH'), 48), `${wv(midSeg, 'SAW_WELD_LENGTH')}`);
  ok('every SAW / MIG size is 12 (fill-up band, all joints >= 12 mm)', [...W('SAW_WELD_SIZE'), ...W('MIG_WELD_SIZE'), ...W('ARC_WELD_SIZE')].every((w) => w.value === 12));
  ok('end segment (30 stiffeners) -> 15 before / 15 after the flip', wv(endSeg, 'STIFFENERS') === 15 && wv(endSeg, 'STIFFENERS_AFTER_FLIP') === 15, `${wv(endSeg, 'STIFFENERS')}/${wv(endSeg, 'STIFFENERS_AFTER_FLIP')}`);
  ok('middle segment (26 stiffeners) -> 13 / 13', wv(midSeg, 'STIFFENERS') === 13 && wv(midSeg, 'STIFFENERS_AFTER_FLIP') === 13);
  ok('end segment MIG = 15 x 2 x 2.995 = 89.85 m each side', near(wv(endSeg, 'MIG_WELD_LENGTH'), 89.85) && near(wv(endSeg, 'MIG_WELD_LENGTH_AFTER_FLIP'), 89.85));
  ok('middle segment MIG = 13 x 2 x 2.995 = 77.87 m each side', near(wv(midSeg, 'MIG_WELD_LENGTH'), 77.87) && near(wv(midSeg, 'MIG_WELD_LENGTH_AFTER_FLIP'), 77.87));
  ok('studs: end 354, middle 365', wv(endSeg, 'STUDS') === 354 && wv(midSeg, 'STUDS') === 365, `${wv(endSeg, 'STUDS')}/${wv(midSeg, 'STUDS')}`);
  const studsTotal = W('STUDS').reduce((t, w) => t + w.value * w.pieces, 0);
  ok('studs on the line = 14,424 (BOQ)', studsTotal === 14424, `${studsTotal}`);
  for (const gl of dry.data.nodes.filter((n) => n.cls === 'GIRDER_LINE')) {
    const sum = gl.children.filter((k) => k.cls === 'GIRDER_SEGMENT').reduce((t, k) => t + k.quantity * (wv(k, 'STUDS') ?? 0), 0);
    ok(`girder line ${gl.id}: its segments' studs add up to 1,803`, sum === 1803, `${sum}`);
  }
  const dia = (re) => dry.data.nodes.find((n) => n.cls === 'DIAPHRAGM' && re.test(n.name));
  ok('end diaphragm SAW = 2 x (3.048 + 3.048) = 12.192 m', near(wv(dia(/end/i), 'SAW_WELD_LENGTH'), 12.192));
  ok('end diaphragm ARC = 12 jacking x 2 x 1.7 + 2 pads x 2 x 0.18 = 41.52 m', near(wv(dia(/end/i), 'ARC_WELD_LENGTH'), 41.52));
  ok('intermediate diaphragm ARC = 2x2x1.982 + 2x2x1.25 + 4x2x0.106 = 13.776 m', near(wv(dia(/intermediate/i), 'ARC_WELD_LENGTH'), 13.776));
  ok('METALLISE_COATS = 1 wherever the flow metallises', W('METALLISE_COATS').length > 0 && W('METALLISE_COATS').every((w) => w.value === 1));
  ok('no PAINT_COATS, HOLES, HOLE_DIA, HOLE_TRANSFERS written', !dry.writes.some((w) => /^(PAINT_COATS|HOLES|HOLE_)/.test(w.code)));
  ok('no MIG length on a diaphragm', !dry.writes.some((w) => w.code === 'MIG_WELD_LENGTH' && w.item.cls === 'DIAPHRAGM'));
  ok('painting and holes are reported as left empty', ['PAINT_COATS', 'HOLES'].every((code) => dry.empty.some((e) => e.code === code)));
  ok('nothing blocked (every input assignable in the scratch schema)', dry.blocked.length === 0, dry.blocked.map((b) => `${b.code}:${b.why}`).slice(0, 3).join(' | '));
  const proj = dry.projected.byCode;
  ok('projected SAW 305.5 h, MIG 826.6 + 826.6 h, stiffener fit-up 184 + 184 h, studs 100.2 h',
    near(proj.get('CG-SAWWELD').minutes / 60, 305.5, 0.1) && near(proj.get('CG-MIGWELD').minutes / 60, 826.6, 0.1) && near(proj.get('CG-MIGWELD-2').minutes / 60, 826.6, 0.1)
    && near(proj.get('CG-STIFFFIT').minutes / 60, 184, 0.1) && near(proj.get('CG-STIFFFIT-2').minutes / 60, 184, 0.1) && near(proj.get('CG-STUDWELD').minutes / 60, 100.2, 0.1),
    [...proj].map(([k, v]) => `${k}=${v.minutes == null ? '-' : (v.minutes / 60).toFixed(1)}`).join(' '));
  ok('arc welding stays untimed (no ARC_RATE)', proj.get('CG-ARCWELD').minutes == null && dry.projected.untimed.has('CG-ARCWELD'));

  /* ------------------------------------------------------------------------ */
  section('3. Refusals: started or issued -> stopped before anything is written');
  await conn.query('SAVEPOINT started');
  const [[step]] = await conn.query(`SELECT s.id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
                                       WHERE pi.release_id = ? AND s.deleted_at IS NULL ORDER BY s.id LIMIT 1`, [rel0.id]);
  await conn.query("UPDATE cf_production_steps SET state = 'in_progress', started_at = NOW() WHERE id = ?", [step.id]);
  const vS = await valueRows();
  const eStarted = await refusal(() => run(db, COMPANY, { lineId: LINE, commit: true, times: false }));
  ok('a started step: --commit refuses (STARTED, says it has started)', eStarted?.code === 'STARTED' && /started/i.test(eStarted.message), eStarted?.message);
  ok('…and wrote no value', (await valueRows()) === vS);
  ok('…and the release is still the same one', (await liveReleaseOfLine(conn, COMPANY, LINE))?.id === rel0.id);
  const dryStarted = await run(db, COMPANY, { lineId: LINE, times: false });
  ok('the dry run says STOP too', !!dryStarted.stopped && /cannot be taken back/.test(dryStarted.stopped));
  await conn.query('ROLLBACK TO SAVEPOINT started');

  await conn.query('SAVEPOINT issued');
  await conn.query('UPDATE cf_material_requirements SET issued = quantity WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY, rel0.id]);
  const eIssued = await refusal(() => run(db, COMPANY, { lineId: LINE, commit: true, times: false }));
  ok('material issued: --commit refuses before writing', eIssued?.code === 'STARTED' && /issued/i.test(eIssued.message), eIssued?.message);
  ok('…release kept', (await liveReleaseOfLine(conn, COMPANY, LINE))?.id === rel0.id);
  await conn.query('ROLLBACK TO SAVEPOINT issued');

  /* ------------------------------------------------------------------------ */
  section('4. --commit: take back, values with history, release again');
  const hist0 = Number((await q1('SELECT COUNT(*) AS n FROM cf_spec_value_history WHERE company_id = ?', [COMPANY])).n);
  const t0 = trips;
  const out = await run(db, COMPANY, { lineId: LINE, commit: true, userId: c.userId });
  const commitTrips = trips - t0;
  ok('took back the first release', out.tookBack?.id === rel0.id && !!(await q1('SELECT deleted_at FROM cf_production_releases WHERE id = ?', [rel0.id])).deleted_at);
  ok(`wrote ${dry.changes.length} values`, out.written === dry.changes.length, `${out.written}`);
  const hist1 = Number((await q1('SELECT COUNT(*) AS n FROM cf_spec_value_history WHERE company_id = ?', [COMPANY])).n);
  ok('one history row per value', hist1 - hist0 === out.written, `${hist1 - hist0}`);
  const live = await liveReleaseOfLine(conn, COMPANY, LINE);
  ok('released again: a new release, same finished area and notes', !!live && live.id !== rel0.id && live.id === out.released.id && live.finished_area_id === area?.id && live.notes === `${tag} first release`);
  ok('the new release has more timed steps and more hours', out.released.timed > out.tookBack.timed && out.released.minutes > out.tookBack.minutes, `${out.tookBack.timed}->${out.released.timed}, ${(out.tookBack.minutes / 60).toFixed(1)}->${(out.released.minutes / 60).toFixed(1)} h`);
  ok('same number of steps as before', out.released.steps === out.tookBack.steps, `${out.tookBack.steps} vs ${out.released.steps}`);
  const diffs = [...out.projected.byCode].filter(([code, p]) => !near(p.minutes ?? 0, out.after.byCode.get(code)?.minutes ?? 0, 0.01));
  ok('the Times grid after = the projection, operation by operation', diffs.length === 0, diffs.map(([k, p]) => `${k} ${p.minutes} vs ${out.after.byCode.get(k)?.minutes}`).join('; '));
  // Release and grid differ by the setup minutes (once a row in the grid, once a
  // step on the release) — that gap was there before; what this run adds must match.
  ok('the release gained exactly the hours the grid gained', near(out.released.minutes - out.tookBack.minutes, out.after.all - out.before.all, 0.5),
    `${(out.released.minutes - out.tookBack.minutes).toFixed(1)} vs ${(out.after.all - out.before.all).toFixed(1)} min`);
  const sawEnd = await q1(`SELECT v.value_number, v.source FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
                            WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND s.code = 'SAW_WELD_LENGTH' AND v.deleted_at IS NULL`, [COMPANY, endSeg.id]);
  ok('the end segment holds SAW_WELD_LENGTH 46.6 (entered)', near(sawEnd?.value_number, 46.6) && sawEnd.source === 'entered');
  console.log(`  (commit: ${commitTrips} round trips)`);

  /* ------------------------------------------------------------------------ */
  section('5. Idempotent: a second run changes nothing and leaves the release alone');
  const again = await run(db, COMPANY, { lineId: LINE, commit: true, times: false });
  ok('second run: 0 value changes', again.changes.length === 0, `${again.changes.length}`);
  ok('second run: nothing taken back, nothing released', !again.tookBack && !again.released && (await liveReleaseOfLine(conn, COMPANY, LINE))?.id === live.id);
  ok('second run: no new history rows', Number((await q1('SELECT COUNT(*) AS n FROM cf_spec_value_history WHERE company_id = ?', [COMPANY])).n) === hist1);

  detachNodeCache(db);
} catch (e) {
  failed++;
  console.error('\nUNEXPECTED ERROR:', e.code ?? '', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 4).join('\n'));
} finally {
  await conn.query('ROLLBACK');
  conn.release();
}

section('6. Rolled back');
const after = await counts();
const changed = after.filter((r, i) => Number(r.n) !== Number(before[i].n)).map((r, i) => `${r.name} ${before.find((b) => b.name === r.name)?.n}->${r.n}`);
ok('every cf_ table has the row count it started with', changed.length === 0, changed.slice(0, 5).join(', '));
ok('line 923 is not left released', !(await liveReleaseOfLine(pool, COMPANY, LINE)));
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
