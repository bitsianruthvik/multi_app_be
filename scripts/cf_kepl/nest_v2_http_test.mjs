/**
 * nest_v2_http_test.mjs — the Nesting v2 routes (TM/CF_ERP_NESTING_V2.md) through REAL HTTP:
 * express in this process on a random port, a JWT per user, the routes' own pool and transactions.
 * Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_v2_http_test.mjs
 *   CF_NEST_COMPANY=2 (the tenant that owns the fixture)   CF_NEST_OTHER_COMPANY=<id> (company B, default: the first other one)
 *
 * WHY THIS ONE COMMITS. The service-level suite (nest_upload_test.mjs) runs everything in one
 * transaction and rolls back. Real HTTP uses the POOL and each write route opens its OWN
 * transaction, so the fixture has to be COMMITTED and then DELETED by this test.
 *
 * CLEANUP RULE (the only rows this test ever deletes), done in a `finally` and on SIGINT/SIGTERM:
 *   before the fixture is built, for every cf_ table that has an AUTO_INCREMENT `id` we record
 *   MAX(id) and every cf_ table's exact COUNT(*). Afterwards, on one connection with
 *   FOREIGN_KEY_CHECKS = 0 (restored), we hard-DELETE from each such table the rows with
 *        company_id = <the tenant>  AND  id > <the recorded max>
 *        AND (the table has no created_at  OR  created_at IS NULL  OR  created_at >= the run's start - 5 s)
 *   cf_item_details (keyed by master_id, no id) is cleaned by master_id > MAX(cf_master_records.id)
 *   with the same company/created_at guard; the few other tables with neither an id nor a created
 *   trail (settings tables) by company_id + created_at >= start. Rows with id > max that fail the
 *   created_at guard are another process's rows: they are REPORTED, never deleted. Order line 923
 *   (the KEPL copy) is never touched: its row and its release count are asserted unchanged.
 *   Then every cf_ table's COUNT(*) is compared with the snapshot ("table counts are back").
 *   Background runs are allowed to finish first (settleRuns), so no late cf_nest_runs row appears.
 */
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const F = await imp('scripts/cf_kepl/lib/nestV2Fixture.mjs');
const { signToken } = await imp('core/utils/jwt.js');
// The app's own manifest mounts the routes (and the JSON answer for an unreadable body), as index.js does through apps/_loader.js.
const { default: cfApp } = await imp('apps/cf_erp/app.js');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const KEPL_LINE = 923;

let passed = 0;
let failed = 0;
const fails = [];
const findings = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean — got ${typeof name}, ${typeof cond} (${String(name).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + Number(f(x) ?? 0), 0);
const J = (v) => JSON.stringify(v);

/* ───────────────────────────── snapshot ───────────────────────────── */

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const [colRows] = await pool.query("SELECT TABLE_NAME t, COLUMN_NAME c, EXTRA e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%'");
const meta = new Map(tables.map((t) => [t.name, { name: t.name, auto: null, company: false, created: false }]));
for (const r of colRows) {
  const m = meta.get(r.t); if (!m) continue;
  if (/auto_increment/i.test(r.e)) m.auto = r.c;
  if (r.c === 'company_id') m.company = true;
  if (r.c === 'created_at') m.created = true;
}
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const maxId = {};
{
  const autos = [...meta.values()].filter((m) => m.auto);
  const [rows] = await pool.query(autos.map((m) => `SELECT '${m.name}' AS name, COALESCE(MAX(\`${m.auto}\`),0) AS mx FROM \`${m.name}\``).join(' UNION ALL '));
  for (const r of rows) maxId[r.name] = Number(r.mx);
}
const [[{ startedAt }]] = await pool.query("SELECT DATE_FORMAT(NOW() - INTERVAL 5 SECOND, '%Y-%m-%d %H:%i:%s') AS startedAt");
const kepl = async () => {
  const [[l]] = await pool.query('SELECT id, order_id, locked_at FROM cf_sales_order_lines WHERE id = ?', [KEPL_LINE]).then((x) => (x[0].length ? x : [[null]]));
  const [[r]] = await pool.query('SELECT COUNT(*) n FROM cf_production_releases WHERE order_line_id = ?', [KEPL_LINE]);
  return J([l ?? null, Number(r.n)]);
};
const keplBefore = await kepl();

const [[userA]] = await pool.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
const [companiesB] = await pool.query('SELECT id FROM companies WHERE id <> ? AND deleted_at IS NULL ORDER BY id', [COMPANY]);
const COMPANY_B = Number(process.env.CF_NEST_OTHER_COMPANY ?? companiesB[0]?.id);
if (!COMPANY_B) throw new Error('There is no second company to test tenant isolation with.');
const [[userB]] = await pool.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY_B]);
const [[slugRow]] = await pool.query('SELECT slug FROM companies WHERE id = ?', [COMPANY]);

/* ───────────────────────────── cleanup ───────────────────────────── */

let fx = null;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await R.settleRuns().catch(() => {});
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const guard = (m) => (m.created ? ' AND (created_at IS NULL OR created_at >= ?)' : '');
    const args = (m, base) => (m.created ? [...base, startedAt] : base);
    let deleted = 0;
    for (const m of meta.values()) {
      if (!m.company) continue;
      if (m.auto) {
        // Rows above the recorded max that are older than the run belong to someone else: say so, do not delete.
        if (m.created) {
          const [[f]] = await conn.query(`SELECT COUNT(*) n FROM \`${m.name}\` WHERE company_id = ? AND \`${m.auto}\` > ? AND created_at < ?`, [COMPANY, maxId[m.name], startedAt]);
          if (Number(f.n)) console.log(`  NOTE  ${m.name}: ${f.n} row(s) above the snapshot id were created before this run started — left alone (another process)`);
        }
        const [r] = await conn.query(`DELETE FROM \`${m.name}\` WHERE company_id = ? AND \`${m.auto}\` > ?${guard(m)}`, args(m, [COMPANY, maxId[m.name]]));
        deleted += r.affectedRows;
      } else if (m.name === 'cf_item_details') {
        const [r] = await conn.query(`DELETE FROM cf_item_details WHERE company_id = ? AND master_id > ?${guard(m)}`, args(m, [COMPANY, maxId.cf_master_records]));
        deleted += r.affectedRows;
      } else if (m.created) {
        // settings-style tables (one row per company): only a row this run created
        const [r] = await conn.query(`DELETE FROM \`${m.name}\` WHERE company_id = ? AND created_at >= ?`, [COMPANY, startedAt]);
        deleted += r.affectedRows;
      }
    }
    console.log(`  cleanup: ${deleted} rows deleted`);
  } finally {
    try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch { /* connection is released next */ }
    conn.release();
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`\n${sig}: cleaning up…`); cleanup().catch((e) => console.error(e)).finally(() => process.exit(130)); });
}

/* ───────────────────────────── http ───────────────────────────── */

const app = express();
app.use(express.json({ limit: '50mb' }));                 // as index.js
cfApp.register(app);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const PORT = server.address().port;
const mint = (companyId, userId, perms, role = 'operator') => signToken({ id: userId ?? 1, email: 'nest-http-test@example.com', role, companyId, uiPermissions: perms });
const T_MANAGER = mint(COMPANY, userA?.id, ['cf_erp_orders_view', 'cf_erp_orders_manage']);
const T_VIEWER = mint(COMPANY, userA?.id, ['cf_erp_orders_view']);
const T_B = mint(COMPANY_B, userB?.id ?? userA?.id, ['cf_erp_orders_view', 'cf_erp_orders_manage']);

/** One call: { status, ct, json, text, buf }. token undefined = manager, null = none. */
async function call(method, url, { token = T_MANAGER, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${slugRow?.slug ?? 'x'}/cf_erp${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') ?? '';
  const text = buf.toString('utf8');
  let json = null;
  if (/json/.test(ct)) { try { json = JSON.parse(text); } catch { /* not json */ } }
  return { status: r.status, ct, json, text, buf, headers: r.headers };
}

/* ───────────────────────────── line state ───────────────────────────── */

/** Everything a nesting route could change on the line, deleted rows included, as one comparable string. */
async function lineState(lineId) {
  const q = async (sql, a) => (await pool.query(sql, a))[0];
  const lots = await q('SELECT id, lot_no, deleted_at, origin, nest_file_id FROM cf_plate_lots WHERE order_line_id = ? ORDER BY id', [lineId]);
  const files = await q('SELECT id, deleted_at, file_hash FROM cf_nest_files WHERE order_line_id = ? ORDER BY id', [lineId]);
  const runs = await q('SELECT id, status, deleted_at, dismissed_at FROM cf_nest_runs WHERE order_line_id = ? ORDER BY id', [lineId]);
  const placements = await q('SELECT COUNT(*) n, COALESCE(SUM(deleted_at IS NULL),0) live FROM cf_nest_placements WHERE plate_lot_id IN (SELECT id FROM cf_plate_lots WHERE order_line_id = ?)', [lineId]);
  const offcuts = await q('SELECT COUNT(*) n FROM cf_offcuts WHERE order_line_id = ?', [lineId]);
  return { lots: lots.length, files: files.length, runs: runs.length, placements: Number(placements[0].n), offcuts: Number(offcuts[0].n), hash: J([lots, files, runs, placements, offcuts]) };
}
const same = (a, b) => a.hash === b.hash;
const brief = (s) => `lots ${s.lots} files ${s.files} runs ${s.runs} placements ${s.placements} offcuts ${s.offcuts}`;

const asRequest = (files) => files.map((f) => ({ filename: f.filename, file: f.file, ...(f.style === 'segments' ? { plateCode: fx.plateCode('PS') } : {}) }));

async function pollRun(url, doneWhen, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call('GET', url);
    if (r.status !== 200) return { r, timedOut: false };
    if (doneWhen(r.json)) return { r, timedOut: false };
    if (Date.now() - t0 > timeoutMs) return { r, timedOut: true };
    await wait(300);
  }
}

/* ───────────────────────────── the run ───────────────────────────── */

let exitCode = 0;
try {
  section('Setup: committed fixture, express on a random port');
  {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      attachNodeCache(conn);
      fx = await F.buildFixture(conn, { company: COMPANY });
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch { /* original error matters */ } throw e; } finally { detachNodeCache(conn); conn.release(); }
  }
  const sets = F.nestings(fx);
  const need = Object.fromEntries(Object.entries(fx.parts).map(([k, p]) => [k, p.qty]));
  const pieceTotal = sum(Object.values(need));
  const PS = { length: 3000, width: 1500 };
  const base = `/orders/${fx.orderId}/lines/${fx.lineId}`;
  console.log(`  ${fx.tag}: order ${fx.orderId}, line ${fx.lineId}, ${pieceTotal} pieces; server :${PORT}; company B = ${COMPANY_B}; token user ${userA?.id}`);
  ok('the fixture is committed and visible to the pool', Number((await pool.query('SELECT COUNT(*) n FROM cf_master_records WHERE code LIKE ?', [`${fx.tag}%`]))[0][0].n) > 10);

  const part = sets.B.filter((f) => ['-B1_', '-B2.', '-B5_'].some((k) => f.filename.includes(k)));
  const partCounts = F.countsOf(part);
  const partPieces = sum(Object.values(partCounts));
  const reqFiles = asRequest(part);

  /* ───────────── 1 ───────────── */
  section('1. POST …/nesting/files, three files, dryRun by default: a preview that writes nothing');
  const s0 = await lineState(fx.lineId);
  let r = await call('POST', `${base}/nesting/files`, { body: { files: reqFiles } });
  ok('200 with a JSON body', r.status === 200 && !!r.json, `${r.status} ${r.text.slice(0, 300)}`);
  let a = r.json ?? {};
  ok('applied false, dryRun true, canSave true, nothing to force', a.applied === false && a.dryRun === true && a.canSave === true && a.needsForce === false, J([a.applied, a.dryRun, a.canSave, a.needsForce, a.problems]));
  ok('three files read, each ok, every part placed', Array.isArray(a.files) && a.files.length === 3 && a.files.every((f) => f.status === 'ok' && f.placed === f.parts && !('lotId' in f && f.lotId)), J(a.files?.map((f) => [f.filename, f.status, f.placed, f.parts])));
  ok(`the preview describes the line as it would be (${partPieces} pieces on 3 plates, the rest left over)`, a.totals?.plates === 3 && a.totals?.pieces === partPieces && sum(a.leftOver ?? [], (x) => x.qty) + partPieces === pieceTotal, J(a.totals));
  ok('the diff says three added', a.diff?.added?.length === 3 && a.diff.replaced.length === 0 && a.diff.removed.length === 0);
  r = await call('GET', `${base}/nesting/files`);
  ok('GET …/nesting/files: 200, 0 plates', r.status === 200 && r.json?.plates?.length === 0 && r.json.canUpload === true, `${r.status} ${r.text.slice(0, 200)}`);
  ok('nothing written to the database', same(s0, await lineState(fx.lineId)), brief(await lineState(fx.lineId)));

  /* ───────────── 2 ───────────── */
  section('2. The same, dryRun:false: saved');
  r = await call('POST', `${base}/nesting/files`, { body: { files: reqFiles, dryRun: false } });
  a = r.json ?? {};
  ok('200, applied true', r.status === 200 && a.applied === true && a.dryRun === false, `${r.status} ${r.text.slice(0, 300)}`);
  ok('every file has its lotId', a.files?.length === 3 && a.files.every((f) => Number.isInteger(f.lotId) && f.lotId > 0), J(a.files?.map((f) => f.lotId)));
  ok('saved: 3 lots, the pieces of the files', a.saved?.lots === 3 && a.saved?.pieces === partPieces, J(a.saved));

  /* ───────────── 3 ───────────── */
  section('3. GET …/nesting/files and the file itself');
  r = await call('GET', `${base}/nesting/files`);
  let v = r.json ?? {};
  ok('200: 3 plates, each with its file and its parts', r.status === 200 && v.plates?.length === 3 && v.plates.every((p) => p.origin === 'imported' && p.file?.filename && p.pieces === p.customerPieces && p.ourPieces === 0), `${r.status}`);
  ok('totals agree with the plates', v.totals?.plates === 3 && v.totals.uploadedPlates === 3 && v.totals.pieces === sum(v.plates, (p) => p.pieces) && v.totals.pieces === partPieces, J(v.totals));
  ok('coverage agrees: nested over all cut plates = the pieces on the plates', sum(v.coverage ?? [], (x) => x.nested) === v.totals?.pieces && v.coverage.every((x) => x.nested === x.customer + x.ours), J(v.coverage?.slice(0, 3)));
  ok('leftOver agrees: what is left + what is nested = the line', sum(v.leftOver ?? [], (x) => x.qty) === v.totals?.leftOverPieces && v.totals.leftOverPieces + v.totals.pieces === pieceTotal, J([v.totals, v.leftOver?.length]));
  ok('leftOverToNest excludes the hand-held pieces', v.totals?.leftOverToNest === v.totals?.leftOverPieces - need.M && v.leftOver.find((x) => x.cutPlateCode === fx.code('M'))?.manual === true, J(v.totals));
  const lot0 = v.plates[0];
  const src0 = part.find((f) => f.filename === lot0.file.filename);
  r = await call('GET', `${base}/nesting/files/${lot0.lotId}`);
  ok('GET files/:lotId: 200, application/dxf', r.status === 200 && /application\/dxf/.test(r.ct), `${r.status} ${r.ct}`);
  ok('…the exact bytes uploaded', !!src0 && Buffer.compare(r.buf, Buffer.from(src0.text, 'latin1')) === 0, `${r.buf.length} bytes vs ${src0 ? Buffer.byteLength(src0.text, 'latin1') : '?'}`);
  ok('…as an attachment under its own name', /attachment/.test(r.headers.get('content-disposition') ?? '') && (r.headers.get('content-disposition') ?? '').includes(lot0.file.filename));
  const stateAfterSave = await lineState(fx.lineId);
  const piecesAfterSave = v.totals.pieces;

  /* ───────────── 4 ───────────── */
  section('4. An extra plate that over-covers a cut plate: refused without force, saved with it');
  const extra = F.nestFile(`${fx.tag}-E1_${F.T}mm_3000x1500.dxf`, PS, F.rows(fx, [['H']], PS));
  r = await call('POST', `${base}/nesting/files`, { body: { files: [{ filename: extra.filename, file: extra.file }], dryRun: false } });
  a = r.json ?? {};
  ok('200, applied false, needsForce true', r.status === 200 && a.applied === false && a.needsForce === true && a.canSave === true, `${r.status} ${J([a.applied, a.needsForce, a.canSave, a.problems])}`);
  ok('warningList has OVER_COVERAGE naming the shim and the file', !!a.warningList?.some((w) => w.code === 'OVER_COVERAGE' && w.cutPlateCode === fx.code('H') && w.needsForce === true && w.message.includes(extra.filename)), J(a.warningList));
  ok('…and surplus[] says one too many', a.surplus?.some((s) => s.cutPlateCode === fx.code('H') && s.surplus === 1), J(a.surplus));
  ok('…"Not saved" in the message, nothing written', /Not saved/.test(a.message ?? '') && same(stateAfterSave, await lineState(fx.lineId)), a.message);
  r = await call('POST', `${base}/nesting/files`, { body: { files: [{ filename: extra.filename, file: extra.file }], dryRun: false, force: true } });
  a = r.json ?? {};
  ok('force:true: applied true, forced, a lotId', r.status === 200 && a.applied === true && a.forced === true && Number.isInteger(a.files?.[0]?.lotId), `${r.status} ${a.message}`);
  const extraLot = a.files?.[0]?.lotId;
  r = await call('GET', `${base}/nesting/files`);
  ok('four plates now, the extra one holds its one shim', r.json?.plates?.length === 4 && r.json.plates.some((p) => p.lotId === extraLot && p.pieces === 1), J(r.json?.plates?.map((p) => [p.lotId, p.verdict, p.forced])));

  /* ───────────── 5 ───────────── */
  section('5. DELETE …/nesting/lots/:lotId (the extra plate)');
  r = await call('DELETE', `${base}/nesting/lots/${extraLot}`);
  a = r.json ?? {};
  ok('200, applied, the lot removed', r.status === 200 && a.applied === true && a.removed?.lotId === extraLot && a.removed.plateCode === fx.plateCode('PS'), `${r.status} ${r.text.slice(0, 300)}`);
  ok('totals are back: 3 plates, the earlier piece count', a.totals?.plates === 3 && a.totals.uploadedPlates === 3 && a.totals.pieces === piecesAfterSave, J(a.totals));
  r = await call('GET', `${base}/nesting/files`);
  ok('GET files agrees', r.json?.plates?.length === 3 && r.json.totals.pieces === piecesAfterSave && !r.json.plates.some((p) => p.lotId === extraLot));
  r = await call('GET', `${base}/nesting/files/${extraLot}`);
  ok('the deleted plate\'s file is gone (404)', r.status === 404, `${r.status} ${r.text.slice(0, 200)}`);
  r = await call('DELETE', `${base}/nesting/lots/${extraLot}`);
  ok('deleting it again is a 404', r.status === 404, `${r.status} ${r.text.slice(0, 200)}`);
  const stateBase = await lineState(fx.lineId);
  const baseLotIds = (await pool.query("SELECT id FROM cf_plate_lots WHERE order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [fx.lineId]))[0].map((l) => l.id);

  /* ───────────── 13 (here: needs the saved partial state) ───────────── */
  section('13. A failing upload writes nothing');
  const goodB3 = sets.B.find((f) => f.filename.includes('-B3_'));
  const goodB4 = sets.B.find((f) => f.filename.includes('-B4_'));
  const overlap = F.nestFile(`${fx.tag}-X1_${F.T}mm_3000x1500.dxf`, PS, [F.place(fx, 'R', 100, 100), F.place(fx, 'R', 700, 300)]);
  r = await call('POST', `${base}/nesting/files`, { body: { files: [goodB3, goodB4, overlap].map((f) => ({ filename: f.filename, file: f.file })), dryRun: false } });
  a = r.json ?? {};
  ok('2 good files + 1 overlapping: 200, canSave false, applied false', r.status === 200 && a.canSave === false && a.applied === false, `${r.status} ${a.message}`);
  ok('…OVERLAP is named, the two good files are still read ok', !!a.problemList?.some((p) => p.code === 'OVERLAP' && p.message.includes(overlap.filename)) && a.files?.filter((f) => f.status === 'ok').length === 2, J(a.problems));
  ok('…cf_plate_lots / cf_nest_placements / cf_nest_files / cf_offcuts are exactly as before', same(stateBase, await lineState(fx.lineId)), brief(await lineState(fx.lineId)));
  // Failures INSIDE the write: a request that could break an INSERT after earlier statements ran.
  // Over-long values do not (the service clamps / sanitises them — said below); a CONCURRENT identical
  // save is the one real way to make an INSERT fail half way (the lot number is unique per line).
  const strays = async () => (await pool.query("SELECT l.id, l.lot_no, l.source_file, f.nest_no, f.file_name FROM cf_plate_lots l LEFT JOIN cf_nest_files f ON f.id = l.nest_file_id WHERE l.order_line_id = ? AND l.deleted_at IS NULL AND l.kind = 'plate'", [fx.lineId]))[0].filter((l) => !baseLotIds.includes(l.id));
  const dropStrays = async () => { const s = await strays(); if (s.length) await call('POST', `${base}/nesting/files`, { body: { remove: s.map((l) => l.id), dryRun: false } }); };
  const attempt = async (label, mutate) => {
    const files = [goodB3, goodB4].map((f) => ({ filename: f.filename, file: f.file }));
    mutate(files[1]);
    const res = await call('POST', `${base}/nesting/files`, { body: { files, dryRun: false } });
    const stored = await strays();
    console.log(`    ${label}: HTTP ${res.status} ${res.json ? J({ applied: res.json.applied, canSave: res.json.canSave, message: String(res.json.message ?? '').slice(0, 120), problems: (res.json.problems ?? []).slice(0, 2) }) : res.text.slice(0, 160)}; stored ${J(stored.map((l) => [l.lot_no.length, String(l.nest_no ?? '').length, String(l.file_name ?? '').length]))}`);
    const refused = res.status < 500 && res.json && res.json.applied !== true;
    ok(`${label}: either refused with nothing written, or saved with every value inside its column`,
      res.status < 500 && (refused ? stored.length === 0 : (stored.length === 2 && stored.every((l) => l.lot_no.length <= 30 && String(l.nest_no ?? '').length <= 60 && String(l.file_name ?? '').length <= 255))), `${res.status} ${res.text.slice(0, 200)}`);
    await dropStrays();
    return res;
  };
  await attempt('a nest number of 100 characters (nest_no is 60, lot_no 30)', (f) => { f.nestNo = 'N'.repeat(100); });
  await attempt('a file name of 400 characters (file_name is 255)', (f) => { f.filename = `${'f'.repeat(380)}_${F.T}mm_3000x1500.dxf`; f.nestNo = 'LONGNAME'; });
  console.log('    (an over-long value cannot break the INSERT: the service clamps it, so no input-driven failure inside the write could be provoked)');
  // Two identical saves at the same moment: the second INSERT of the same lot number meets the first's row.
  {
    const files = [goodB3, goodB4].map((f) => ({ filename: f.filename, file: f.file }));
    const both = await Promise.all([0, 1].map(() => call('POST', `${base}/nesting/files`, { body: { files, dryRun: false } })));
    const stored = await strays();
    console.log(`    two concurrent identical saves: HTTP ${both.map((x) => x.status).join(' + ')} (${both.map((x) => (x.json ? (x.json.applied ? 'applied' : x.json.code ?? 'not applied') : x.text.slice(0, 60))).join(' / ')}); lots stored: ${stored.length}`);
    ok('two concurrent identical saves: no 5xx, and the line holds exactly one copy of the two plates (the loser rolled back whole)', both.every((x) => x.status < 500) && stored.length === 2 && new Set(stored.map((l) => l.lot_no.toUpperCase())).size === 2, both.map((x) => `${x.status} ${x.text.slice(0, 150)}`).join(' | '));
    const pl = (await pool.query('SELECT COUNT(*) n FROM cf_nest_placements p JOIN cf_plate_lots l ON l.id = p.plate_lot_id WHERE l.order_line_id = ? AND l.deleted_at IS NULL AND p.deleted_at IS NULL AND l.id IN (?)', [fx.lineId, stored.map((l) => l.id).concat([0])]))[0][0].n;
    ok('…and each stored plate has its placements (none half-written)', Number(pl) === sum(Object.values(F.countsOf([goodB3, goodB4]))), String(pl));
    await dropStrays();
  }
  {
    const live = (await call('GET', `${base}/nesting/files`)).json;
    ok('the line has exactly its 3 plates again', live.plates.length === 3 && live.totals.pieces === piecesAfterSave, J(live.plates.map((p) => p.lotNo)));
  }


  /* ───────────── 6 ───────────── */
  section('6. Nest the rest: runs → poll → accept the whole plan');
  const filesBefore6 = (await call('GET', `${base}/nesting/files`)).json;
  r = await call('POST', `${base}/nesting/runs`, { body: { effort: 'quick' } });
  ok('POST …/nesting/runs: 200, running', r.status === 200 && ['running', 'done'].includes(r.json?.status), `${r.status} ${r.text.slice(0, 300)}`);
  let polled = await pollRun(`${base}/nesting/runs/current?plan=1`, (j) => j.status !== 'running');
  let run = polled.r.json ?? {};
  ok('the run finished within 120 s with a proposal', !polled.timedOut && polled.r.status === 200 && run.status === 'done' && !!run.plan, `${polled.r.status} ${run.status} ${J(run.error)}`);
  const plan = run.plan ?? {};
  ok('the plan has additions and/or groups, and a rest', ((plan.additions?.length ?? 0) > 0 || (plan.groups?.length ?? 0) > 0) && !!plan.rest && plan.rest.unplaced === 0, J({ additions: plan.additions?.length, groups: plan.groups?.length, rest: { ...plan.rest, pieces: undefined } }));
  ok('…it nests only what is left over (hand-held pieces stay out)', plan.rest?.onExisting + plan.rest?.onNew === filesBefore6.totals.leftOverToNest, J([plan.rest?.onExisting, plan.rest?.onNew, filesBefore6.totals.leftOverToNest]));
  const sBeforeAccept = await lineState(fx.lineId);
  r = await call('POST', `${base}/nesting/accept`, { body: plan });
  a = r.json ?? {};
  ok('POST …/nesting/accept with the whole plan: 200', r.status === 200 && !a.code, `${r.status} ${r.text.slice(0, 400)}`);
  ok('…additions and/or new plates written', (a.additions?.pieces ?? 0) + (a.pieces ?? 0) > 0 && a.keptImportedLots === 3, J({ additions: a.additions, lots: a.lots, pieces: a.pieces, kept: a.keptImportedLots }));
  r = await call('GET', `${base}/nesting/files`);
  v = r.json ?? {};
  ok('after accept every piece is covered but the hand-held ones', v.leftOver?.length === 1 && v.leftOver[0].manual === true && v.coverage.filter((x) => !x.manual).every((x) => x.diff === 0), J(v.leftOver));
  ok('…the customer\'s three plates are still the customer\'s', v.plates.filter((p) => p.origin === 'imported').length === 3 && !same(sBeforeAccept, await lineState(fx.lineId)));
  r = await call('GET', `${base}/nesting/runs/current`);
  ok('…and the finished run is off the poll', r.status === 200 && r.json?.status === 'none', J(r.json?.status));

  /* ───────────── 7 ───────────── */
  section('7. Compare: start, poll, a complete payload');
  r = await call('POST', `${base}/nesting/compare`, { body: { run: true, effort: 'quick' } });
  const started = r.json ?? {};
  ok('POST …/nesting/compare {run:true}: 200, started, a runId', r.status === 200 && started.started === true && started.running === true && typeof started.runId === 'string' && started.runId.length > 8, `${r.status} ${r.text.slice(0, 300)}`);
  polled = await pollRun(`${base}/nesting/compare?with=auto`, (j) => j.auto?.status !== 'running');
  let cmp = polled.r.json ?? {};
  ok('polled to a result within 120 s', !polled.timedOut && polled.r.status === 200 && cmp.auto?.status === 'ready', `${polled.r.status} ${cmp.auto?.status} ${J(cmp.lastFailure ?? cmp.auto?.reason)}`);
  ok('the automatic side is that run', cmp.auto?.runId === started.runId && typeof cmp.auto.ranAt === 'string');
  const metricKeys = ['plates', 'pieces', 'tonnesBought', 'partsTonnes', 'wastePct', 'wasteKgTotal', 'wasteKg', 'offcuts', 'cutLengthM', 'piercings', 'cost'];
  ok('uploaded.metrics complete', !!cmp.uploaded?.metrics && metricKeys.every((k) => k in cmp.uploaded.metrics) && Array.isArray(cmp.uploaded.perPlate) && cmp.uploaded.perPlate.length === 3, J(Object.keys(cmp.uploaded?.metrics ?? {})));
  ok('auto.metrics complete', !!cmp.auto?.metrics && metricKeys.every((k) => k in cmp.auto.metrics) && Array.isArray(cmp.auto.perPlate), J(Object.keys(cmp.auto?.metrics ?? {})));
  ok('delta = automatic − uploaded', !!cmp.delta && cmp.delta.plates === cmp.auto.metrics.plates - cmp.uploaded.metrics.plates && Math.abs(cmp.delta.tonnesBought - (cmp.auto.metrics.tonnesBought - cmp.uploaded.metrics.tonnesBought)) < 1e-3, J(cmp.delta));
  ok('verdict is a sentence', typeof cmp.verdict === 'string' && cmp.verdict.length > 20, String(cmp.verdict));
  ok('likeForLike has its fields', cmp.likeForLike && typeof cmp.likeForLike.same === 'boolean' && 'uploadedPieces' in cmp.likeForLike && Array.isArray(cmp.likeForLike.differ) && Array.isArray(cmp.likeForLike.overNested), J(cmp.likeForLike));
  ok('wholeLine has saved + auto', cmp.wholeLine?.saved?.metrics && cmp.wholeLine?.auto?.metrics && typeof cmp.wholeLine.saved.complete === 'boolean', J(Object.keys(cmp.wholeLine ?? {})));
  ok('canAccept says both sides can be taken', cmp.canAccept?.uploaded === true && cmp.canAccept?.auto === true, J(cmp.canAccept));
  ok('demand + coverage + leftOver present, no failure', !!cmp.demand?.hash && Array.isArray(cmp.coverage) && Array.isArray(cmp.leftOver) && cmp.lastFailure == null && cmp.stale == null, J([cmp.lastFailure, cmp.stale]));
  // What taking the automatic side would replace, in numbers — for the confirm on the screen.
  const wr = cmp.willReplace;
  console.log(`    willReplace: ${J(wr).slice(0, 600)}`);
  ok('willReplace counts what is saved (the customer plates and ours) and what would come in its place', !!wr && wr.side === 'auto' && wr.customerPlates === cmp.uploaded.metrics.plates && Number.isInteger(wr.ourPlates) && wr.plates === wr.customerPlates + wr.ourPlates
    && wr.pieces === wr.customerPieces + wr.ourPiecesOnCustomerPlates + wr.ourPieces && wr.withPlates === cmp.wholeLine.auto.metrics.plates && typeof wr.message === 'string' && /replaces everything saved on this line/.test(wr.message), J(wr));
  r = await call('GET', `${base}/nesting/compare?with=auto&detail=1`);
  ok('?detail=1 adds the automatic plan', r.status === 200 && !!r.json?.auto?.plan, `${r.status}`);

  /* ───────────── 8 ───────────── */
  section('8. Compare again: the same run is pulled up, nothing is packed');
  const runsBefore = Number((await pool.query('SELECT COUNT(*) n FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ?', [COMPANY, fx.lineId]))[0][0].n);
  r = await call('POST', `${base}/nesting/compare`, { body: { run: true } });
  ok('started false, the SAME runId', r.status === 200 && r.json?.started === false && r.json?.runId === started.runId && r.json?.running === false, `${r.status} ${r.text.slice(0, 300)}`);
  ok('cf_nest_runs has no new row for the line', Number((await pool.query('SELECT COUNT(*) n FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ?', [COMPANY, fx.lineId]))[0][0].n) === runsBefore, `${runsBefore}`);
  ok('…and no run is working', (await call('GET', `${base}/nesting/compare`)).json?.auto?.status === 'ready');

  /* ───────────── 10 + 11 run before 9: they need the uploaded plates and a ready run, and 9 replaces them ───────────── */
  section('10. Permission: a viewer reads, writes are 403; no token is 401');
  const stateBeforePerm = await lineState(fx.lineId);
  const oneLot = (await call('GET', `${base}/nesting/files`)).json.plates.find((p) => p.origin === 'imported');
  const writes = [
    ['POST', `${base}/nesting/files`, { files: reqFiles, dryRun: false }],
    ['DELETE', `${base}/nesting/lots/${oneLot.lotId}`, undefined],
    ['POST', `${base}/nesting/accept`, plan],
    ['POST', `${base}/nesting/compare/accept`, { side: 'auto', runId: started.runId }],
    ['PUT', `${base}/nesting/choices`, { excludedCutPlateIds: [], excludedPlateIds: [] }],
    ['PUT', `${base}/nesting/plates`, { plates: 'any' }],
    ['POST', `${base}/nesting/sheet`, { dryRun: false }],
  ];
  for (const [m, u, b] of writes) {
    r = await call(m, u, { token: T_VIEWER, body: b ?? (m === 'DELETE' ? undefined : {}) });
    ok(`viewer ${m} ${u.replace(base, '…')} → 403`, r.status === 403 && /FORBIDDEN|Permission/.test(r.text), `${r.status} ${r.text.slice(0, 160)}`);
  }
  ok('…and not one of them changed anything', same(stateBeforePerm, await lineState(fx.lineId)));
  const reads = [`${base}/nesting`, `${base}/nesting/files`, `${base}/nesting/files/${oneLot.lotId}`, `${base}/nesting/compare?with=auto`, `${base}/nesting/runs/current`, `${base}/nesting/choices`];
  for (const u of reads) {
    r = await call('GET', u, { token: T_VIEWER });
    ok(`viewer GET ${u.replace(base, '…')} → 200`, r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
  }
  for (const [m, u, b] of [...writes, ...reads.map((u) => ['GET', u, undefined])]) {
    r = await call(m, u, { token: null, body: b ?? (m === 'GET' || m === 'DELETE' ? undefined : {}) });
    if (r.status !== 401) ok(`no token ${m} ${u.replace(base, '…')} → 401`, false, `${r.status} ${r.text.slice(0, 120)}`);
  }
  ok('without a token every route answers 401', true);
  r = await call('GET', `${base}/nesting`, { token: 'not.a.jwt' });
  ok('a garbage token is refused (403 invalid token)', r.status === 403, `${r.status}`);

  /* ───────────── 11 ───────────── */
  section('11. Tenant isolation: company B with company A\'s ids is 404 everywhere, A is untouched');
  const sA = await lineState(fx.lineId);
  const bTrip = [
    ['GET', `${base}/nesting`],
    ['GET', `${base}/nesting/files`],
    ['GET', `${base}/nesting/files/${oneLot.lotId}`],
    ['POST', `${base}/nesting/files`, { files: reqFiles, dryRun: false, mode: 'replace', force: true }],
    ['DELETE', `${base}/nesting/lots/${oneLot.lotId}`],
    ['POST', `${base}/nesting/plan`, {}],
    ['POST', `${base}/nesting/runs`, { effort: 'quick' }],
    ['GET', `${base}/nesting/runs/current`],
    ['DELETE', `${base}/nesting/runs/current`],
    ['GET', `${base}/nesting/compare?with=auto`],
    ['POST', `${base}/nesting/compare`, { run: true, effort: 'quick', rerun: true }],
    ['POST', `${base}/nesting/compare/accept`, { side: 'auto', runId: started.runId }],
    ['POST', `${base}/nesting/accept`, plan],
    ['GET', `${base}/nesting/choices`],
    ['PUT', `${base}/nesting/choices`, { excludedCutPlateIds: [fx.cut.R], excludedPlateIds: [] }],
    ['PUT', `${base}/nesting/plates`, { plates: 'standard' }],
    ['POST', `${base}/nesting/sheet`, { dryRun: false }],
    ['GET', `${base}/nesting/cnc`],
    ['GET', `${base}/nesting/cnc/${oneLot.lotId}`],
  ];
  for (const [m, u, b] of bTrip) {
    r = await call(m, u, { token: T_B, body: b });
    ok(`company B ${m} ${u.replace(base, '…')} → 404`, r.status === 404, `${r.status} ${r.text.slice(0, 200)}`);
  }
  const sA2 = await lineState(fx.lineId);
  ok('company A\'s lots, files, runs, placements and offcuts did not change at all', same(sA, sA2), `${brief(sA)} -> ${brief(sA2)}`);
  r = await call('GET', `${base}/nesting/compare?with=auto`);
  ok('…and A\'s ready run is still ready', r.json?.auto?.status === 'ready' && r.json.auto.runId === started.runId);

  /* ───────────── 9 ───────────── */
  section('9. Accept the automatic side');
  const rightRun = (await call('GET', `${base}/nesting/compare?with=auto`)).json.auto.runId;
  r = await call('POST', `${base}/nesting/compare/accept`, { body: { side: 'auto', runId: rightRun } });
  a = r.json ?? {};
  ok('200, decision auto', r.status === 200 && a.decision === 'auto' && a.runId === rightRun, `${r.status} ${r.text.slice(0, 400)}`);
  ok('…it replaced the uploaded plates with the run\'s plan', a.replaced?.uploadedPlates === 3 && a.replaced?.plates > 0 && a.accepted?.lots > 0, J(a.replaced));
  r = await call('GET', `${base}/nesting`);
  const nests = (r.json?.groups ?? []).flatMap((g) => g.nests);
  ok('GET …/nesting shows only our plates', r.status === 200 && nests.length > 0 && nests.every((n) => n.origin === 'auto' && n.layoutOrigin !== 'customer'), J(nests.map((n) => [n.lotNo, n.origin, n.layoutOrigin])));
  r = await call('GET', `${base}/nesting/files`);
  ok('GET …/nesting/files: no uploaded plate left', r.json?.plates?.every((p) => p.origin === 'auto') && r.json.totals.uploadedPlates === 0, J(r.json?.totals));
  r = await call('POST', `${base}/nesting/compare/accept`, { body: { side: 'auto', runId: rightRun } });
  ok('a second accept → 422 ALREADY_DECIDED', r.status === 422 && r.json?.code === 'ALREADY_DECIDED', `${r.status} ${r.text.slice(0, 300)}`);
  r = await call('POST', `${base}/nesting/compare/accept`, { body: { side: 'sideways', runId: rightRun } });
  ok('a side that is not a side → 422', r.status === 422, `${r.status} ${r.text.slice(0, 200)}`);

  /* ───────────── 12 ───────────── */
  section('12. Body size');
  const stateBefore12 = await lineState(fx.lineId);
  const big = Buffer.concat([Buffer.from('0\nSECTION\n2\nENTITIES\n', 'latin1'), Buffer.alloc(4 * 1024 * 1024 + 4096, 0x20), Buffer.from('0\nENDSEC\n0\nEOF\n', 'latin1')]);
  r = await call('POST', `${base}/nesting/files`, { body: { files: [{ filename: `${fx.tag}-BIG_${F.T}mm_3000x1500.dxf`, file: big.toString('base64') }], dryRun: false } });
  a = r.json ?? {};
  ok(`(a) a ${(big.length / 1048576).toFixed(2)} MB file (cap 4 MB): a clean 200`, r.status === 200 && !!r.json, `${r.status} ${r.text.slice(0, 200)}`);
  ok('…reported as FILE_TOO_BIG, canSave false, applied false', a.canSave === false && a.applied === false && !!a.problemList?.some((p) => p.code === 'FILE_TOO_BIG') && a.files?.[0]?.status === 'error', J([a.problemList?.map((p) => p.code), a.files?.[0]?.status]));
  ok('…nothing written', same(stateBefore12, await lineState(fx.lineId)));

  const bodyHead = Buffer.from('{"files":[{"filename":"huge.dxf","file":"', 'latin1');
  const bodyTail = Buffer.from('"}]}', 'latin1');
  const huge = Buffer.concat([bodyHead, Buffer.alloc(52 * 1024 * 1024, 0x41), bodyTail]);
  const raw = await new Promise((resolve) => {
    const out = { status: null, ct: null, body: '', error: null, hung: false };
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: `/api/${slugRow?.slug ?? 'x'}/cf_erp${base}/nesting/files`, headers: { Authorization: `Bearer ${T_MANAGER}`, 'Content-Type': 'application/json', 'Content-Length': huge.length } }, (res) => {
      out.status = res.statusCode; out.ct = res.headers['content-type'];
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { out.body = Buffer.concat(chunks).toString('utf8'); finish(); });
    });
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(out); } };
    const timer = setTimeout(() => { out.hung = true; req.destroy(); finish(); }, 60000);
    req.on('error', (e) => { out.error = `${e.code ?? ''} ${e.message}`; setTimeout(finish, 500); });
    req.end(huge);
  });
  console.log(`    (b) ${(huge.length / 1048576).toFixed(1)} MB body -> status ${raw.status}, content-type ${raw.ct}, error ${raw.error}, hung ${raw.hung}\n        body: ${raw.body.replace(/\s+/g, ' ').slice(0, 300)}`);
  ok('(b) a body over the 50 MB express limit: not a hung socket', !raw.hung, J(raw));
  ok('(b) …a clean 413 answer, not a socket error and not a 500', raw.status === 413, J({ status: raw.status, error: raw.error }));
  let jsonBody = null; try { jsonBody = JSON.parse(raw.body); } catch { /* not json */ }
  ok('(b) …whose body is JSON/a sentence, not an HTML error page', raw.status !== null && /json/.test(raw.ct ?? '') && !/<html|<!doctype/i.test(raw.body) && jsonBody !== null, `${raw.ct}: ${raw.body.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (raw.status === 413 && !/json/.test(raw.ct ?? '')) findings.push(`oversized body (${(huge.length / 1048576).toFixed(0)} MB): HTTP ${raw.status} ${raw.ct} — no JSON error handler on the app (index.js has none), express's default HTML page`);
  ok('(b) …and nothing written', same(stateBefore12, await lineState(fx.lineId)));
  r = await call('GET', `${base}/nesting/files`);
  ok('(b) …and the server still answers afterwards', r.status === 200);
} catch (err) {
  failed += 1;
  fails.push(`ERROR ${err?.message}`);
  console.error('\nERROR', err);
} finally {
  /* ───────────── 14 ───────────── */
  section('14. Cleanup');
  try {
    await R.settleRuns().catch(() => {});
    await cleanup();
  } catch (e) { failed += 1; fails.push(`CLEANUP ${e.message}`); console.error('cleanup failed', e); }
  await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); setTimeout(resolve, 2000); });
  const after = await counts();
  const drift = after.filter((x) => Number(x.n) !== Number(before.find((b) => b.name === x.name)?.n));
  ok('table counts are back: every cf_ table has the count it started with', drift.length === 0, drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));
  if (drift.length) console.log(`    differing: ${drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', ')}`);
  ok('order line 923 is untouched', (await kepl()) === keplBefore);
  if (fx) {
    const [[left]] = await pool.query('SELECT COUNT(*) n FROM cf_master_records WHERE code LIKE ?', [`${fx.tag}%`]);
    ok(`no cf_master_records with the prefix ${fx.tag} remain`, Number(left.n) === 0, String(left.n));
  }
  if (findings.length) console.log(`\nFindings:\n  - ${findings.join('\n  - ')}`);
  console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
  exitCode = failed ? 1 : 0;
  await pool.end();
  process.exit(exitCode);
}
