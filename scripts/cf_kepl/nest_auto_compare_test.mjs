/**
 * nest_auto_compare_test.mjs — OUR OWN NESTING AFTER AN UPLOAD, IN THE BACKGROUND (2026-10-16; TM/CF_ERP_NESTING_V2.md
 * "Our nesting after an upload"). Through REAL HTTP, as nest_v2_http_test: express in this process, a JWT per user,
 * the routes' own pool and transactions, a COMMITTED fixture that this test deletes again. Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_auto_compare_test.mjs
 *   CF_NEST_COMPANY=2 (the tenant that owns the fixture)
 *
 *   1. an upload saved → the answer says the run is queued and comes back WITHOUT waiting for it
 *   2. the run: Standard, the pieces the upload holds (like for like), stored with the upload it was made for
 *   3. the comparison: both sides, per thickness, the headline, the left-over said apart; cost "not costed" never 0
 *   4. read later: the server's memory gone (a restart), the stored run is read back with the same figures
 *   5. a preview / a refused save / a viewer queue nothing
 *   6. a new upload of other pieces: the old comparison is out of date (stale), a new run starts and answers
 *   7. the same pieces uploaded again: answered by the run already there, nothing packed
 *   8. a save while our run works is NOT refused (it reads no saved plate); the run of the older upload is cancelled
 *   9. a person's nesting run goes first: the automatic one stops and keeps its best
 *  10. the Compare tab's own start ({ run: true, auto: true }) is the same start
 *  11. CF_NEST_AUTO_COMPARE=off: nothing queued
 *  12. with a purchase order: the upload is a REQUEST — nothing queued; the approval queues it
 *  13. cleanup; line 923 untouched; every cf_ table count back
 *
 * CLEANUP RULE: as nest_v2_http_test (rows above the recorded max id, created by this run, of the tenant).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';

// A Standard run here is capped at 12 s (10 min × 0.02); the fixture line is done in a few seconds anyway.
process.env.CF_NEST_BUDGET_SCALE = process.env.CF_NEST_BUDGET_SCALE ?? '0.02';
delete process.env.CF_NEST_AUTO_COMPARE;

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const C = await imp('apps/cf_erp/services/nestCompareService.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const F = await imp('scripts/cf_kepl/lib/nestV2Fixture.mjs');
const FX = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');
const { signToken } = await imp('core/utils/jwt.js');
const { default: cfApp } = await imp('apps/cf_erp/app.js');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const KEPL_LINE = 923;

let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean (${String(name).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const J = (v) => JSON.stringify(v);
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + Number(f(x) ?? 0), 0);
const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol;

/* ───────────────────────────── snapshot (as nest_v2_http_test) ───────────────────────────── */

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

const [people] = await pool.query(
  `SELECT u.id, u.name FROM users u LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.company_id = ? AND u.deleted_at IS NULL AND LOWER(COALESCE(r.name, '')) <> 'admin' ORDER BY u.id LIMIT 2`, [COMPANY]);
if (people.length < 2) throw new Error(`Company ${COMPANY} needs two users that are not admins.`);
const [[slugRow]] = await pool.query('SELECT slug FROM companies WHERE id = ?', [COMPANY]);

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await C.settleAutoCompares().catch(() => {});
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
        const [r] = await conn.query(`DELETE FROM \`${m.name}\` WHERE company_id = ? AND \`${m.auto}\` > ?${guard(m)}`, args(m, [COMPANY, maxId[m.name]]));
        deleted += r.affectedRows;
      } else if (m.name === 'cf_item_details') {
        const [r] = await conn.query(`DELETE FROM cf_item_details WHERE company_id = ? AND master_id > ?${guard(m)}`, args(m, [COMPANY, maxId.cf_master_records]));
        deleted += r.affectedRows;
      } else if (m.created) {
        const [r] = await conn.query(`DELETE FROM \`${m.name}\` WHERE company_id = ? AND created_at >= ?`, [COMPANY, startedAt]);
        deleted += r.affectedRows;
      }
    }
    console.log(`  cleanup: ${deleted} rows deleted`);
  } finally {
    try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch { /* released next */ }
    conn.release();
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup().catch((e) => console.error(e)).finally(() => process.exit(130)); });

/* ───────────────────────────── http ───────────────────────────── */

const app = express();
app.use(express.json({ limit: '50mb' }));
cfApp.register(app);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const PORT = server.address().port;
const mint = (userId, perms) => signToken({ id: userId, email: 'nest-auto-test@example.com', role: 'operator', companyId: COMPANY, uiPermissions: perms });
const T_MANAGER = mint(people[0].id, ['cf_erp_orders_view', 'cf_erp_orders_manage']);
const T_VIEWER = mint(people[0].id, ['cf_erp_orders_view']);
const T_MD = mint(people[1].id, ['cf_erp_orders_view', 'cf_erp_plate_change_approve']);

async function call(method, url, { token = T_MANAGER, body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${slugRow?.slug ?? 'x'}/cf_erp${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, ms: Date.now() - t0 };
}

const runRows = async (lineId) => (await pool.query(
  "SELECT id, run_uid, scope, purpose, status, demand_hash, params_json FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? AND kind = 'auto' AND deleted_at IS NULL ORDER BY id", [COMPANY, lineId]))[0];
const compareRows = async (lineId) => (await runRows(lineId)).filter((r) => r.purpose === 'compare');

/** Poll the comparison until `done(json)` (or the time is up). */
async function pollCompare(base, done, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call('GET', `${base}/nesting/compare?with=auto`);
    if (r.status !== 200 || done(r.json) || Date.now() - t0 > timeoutMs) return r;
    await wait(250);
  }
}
const ready = (j) => j?.auto?.status === 'ready';

/** What lock does to a custom line (as plate_change_test): its rows rolled out into cf_order_pieces. */
async function rollOut(conn, fx) {
  const [bl] = await conn.query(
    `SELECT b.parent_id, l.id, l.child_id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
      WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`, [COMPANY, [fx.root, ...Object.values(fx.partRow)]]);
  const lineOf = (parent, child) => bl.find((x) => Number(x.parent_id) === Number(parent) && Number(x.child_id) === Number(child))?.id ?? null;
  let sort = 0;
  const piece = async (parentId, itemId, bomLineId, qty, depth) => (await conn.query(
    'INSERT INTO cf_order_pieces (company_id, order_id, order_line_id, parent_id, item_id, bom_line_id, quantity, code, path_key, depth, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, fx.orderId, fx.lineId, parentId, itemId, bomLineId, qty, `${fx.tag}-PCE-${sort}`, `${fx.tag}/${sort}`, depth, sort++],
  ))[0].insertId;
  const root = await piece(null, fx.root, null, 1, 0);
  for (const [sfx, p] of Object.entries(fx.parts)) {
    const row = await piece(root, fx.partRow[sfx], lineOf(fx.root, fx.partRow[sfx]), p.qty, 1);
    await piece(row, fx.cut[sfx], lineOf(fx.partRow[sfx], fx.cut[sfx]), p.qty, 2);
  }
}

let fx = null;
try {
  section('Setup: a committed fixture, express on a random port');
  {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      attachNodeCache(conn);
      fx = await F.buildFixture(conn, { company: COMPANY, tagPrefix: 'NA' });
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch { /* the first error matters */ } throw e; } finally { detachNodeCache(conn); conn.release(); }
  }
  const sets = F.nestings(fx);
  const base = `/orders/${fx.orderId}/lines/${fx.lineId}`;
  const asRequest = (files) => files.map((f) => ({ filename: f.filename, file: f.file, ...(f.style === 'segments' ? { plateCode: fx.plateCode('PS') } : {}) }));
  const pieceTotal = sum(Object.values(fx.parts), (p) => p.qty);
  // Three of set B's five plates: the upload leaves pieces over (like the NECL job).
  const part = sets.B.filter((f) => ['-B1_', '-B2.', '-B5_'].some((k) => f.filename.includes(k)));
  const partPieces = sum(Object.values(F.countsOf(part)));
  console.log(`  ${fx.tag}: order ${fx.orderId}, line ${fx.lineId}, ${pieceTotal} pieces; the upload holds ${partPieces}`);

  /* ───────────── 1 ───────────── */
  section('1. An upload saved: the answer says our run is queued, and does not wait for it');
  let r = await call('POST', `${base}/nesting/files`, { body: { files: asRequest(part), dryRun: false } });
  const finishedAtAnswer = (await compareRows(fx.lineId)).filter((x) => x.status !== 'running').length;
  let a = r.json ?? {};
  ok('200, applied', r.status === 200 && a.applied === true, `${r.status} ${r.text.slice(0, 300)}`);
  ok('autoCompare: { queued: true, effort: "standard", message }', a.autoCompare?.queued === true && a.autoCompare.effort === 'standard' && /Compare tab/.test(a.autoCompare.message), J(a.autoCompare));
  ok('…and no run of ours had finished when the answer came (it never waited)', finishedAtAnswer === 0, String(finishedAtAnswer));
  ok('…the answer holds no comparison figure', a.compare === undefined && a.auto === undefined);
  console.log(`    upload answered in ${r.ms} ms`);
  await C.settleAutoCompares(); await R.settleRuns();
  let rows = await compareRows(fx.lineId);
  if (!rows.length) console.log('    autoCompare state:', J(C.autoCompareState(COMPANY, fx.lineId)));
  ok('right after: ONE comparison run, of the pieces the upload holds (scope subset)', rows.length === 1 && rows[0].scope === 'subset', J(rows.map((x) => [x.scope, x.status])));
  const p1 = JSON.parse(rows[0].params_json);
  ok('…Standard effort, started by the upload, the upload\'s key and pieces stored with it', p1.effort === 'standard' && p1.trigger === 'upload' && typeof p1.upload?.key === 'string' && p1.upload.pieces === partPieces && p1.upload.plates === 3, J(p1.upload));
  ok('…like for like: `only` = exactly what the upload nests', sum(Object.values(p1.only)) === partPieces, J(p1.only));

  /* ───────────── 2 + 3 ───────────── */
  section('2. The run finishes and is stored; 3. the comparison');
  r = await pollCompare(base, ready);
  let cmp = r.json ?? {};
  ok('the comparison answers: auto ready', r.status === 200 && cmp.auto?.status === 'ready', J([r.status, cmp.auto?.status, cmp.auto?.reason, cmp.lastFailure]));
  const run1 = cmp.auto?.runId;
  ok('auto.trigger "upload", made for THIS upload, Standard', cmp.auto?.trigger === 'upload' && cmp.auto.forThisUpload === true && cmp.auto.params?.effort === 'standard', J([cmp.auto?.trigger, cmp.auto?.forThisUpload, cmp.auto?.params]));
  ok('like for like: both sides hold the same pieces', cmp.likeForLike?.same === true && cmp.likeForLike.uploadedPieces === partPieces && cmp.likeForLike.autoPieces === partPieces, J(cmp.likeForLike));
  ok('the uploaded side: the 3 plates, their pieces', cmp.uploaded?.metrics?.plates === 3 && cmp.uploaded.metrics.pieces === partPieces, J(cmp.uploaded?.metrics));
  const um = cmp.uploaded.metrics; const am = cmp.auto.metrics;
  ok('waste INCLUDES the offcuts on both sides: waste kg = bought − parts, offcut kg ≤ it', [um, am].every((m) => near(m.wasteKgTotal, (m.tonnesBought - m.partsTonnes) * 1000, 1.5) && m.offcuts.kg <= m.wasteKgTotal + 0.5), J([um.wasteKgTotal, um.offcuts, am.wasteKgTotal, am.offcuts]));
  ok('the parts weigh the same on both sides (the same pieces)', near(um.partsTonnes, am.partsTonnes, 0.002), J([um.partsTonnes, am.partsTonnes]));
  ok('cost at the plate rate (list price per kg × plate kg), never 0', um.cost?.value > 0 && am.cost?.value > 0 && um.cost.basis === 'list price', J([um.cost, am.cost]));
  ok('cut length and piercings on both sides', um.cutLengthM > 0 && am.cutLengthM > 0 && um.piercings > 0 && am.piercings > 0);
  ok('byThickness: one row per thickness, each side\'s plates and steel add up', Array.isArray(cmp.byThickness) && cmp.byThickness.length >= 1
    && sum(cmp.byThickness, (t) => t.uploaded?.plates ?? 0) === um.plates && sum(cmp.byThickness, (t) => t.auto?.plates ?? 0) === am.plates
    && near(sum(cmp.byThickness, (t) => t.uploaded?.tonnesBought ?? 0), um.tonnesBought, 0.003), J(cmp.byThickness));
  ok('a one-line headline ("AI\'s nesting uses …")', typeof cmp.headline === 'string' && /^AI's nesting (uses|and the customer)/.test(cmp.headline), cmp.headline);
  console.log(`    headline: ${cmp.headline}`);
  console.log(`    verdict:  ${cmp.verdict}`);
  const left = pieceTotal - partPieces;
  ok(`the left-over is said apart: ${left} pieces, with kg, in neither side`, cmp.leftOverSummary?.pieces === left && cmp.leftOverSummary.kg > 0 && /neither side/.test(cmp.leftOverSummary.sentence ?? ''), J(cmp.leftOverSummary));
  ok('the server says what it did: autoCompare.status started', cmp.autoCompare?.status === 'started' && cmp.autoCompare.trigger === 'upload', J(cmp.autoCompare));
  r = await call('GET', `${base}/nesting/compare?with=auto&detail=1`);
  ok('detail=1 carries our plan, to draw its plates', (r.json?.auto?.plan?.groups ?? []).flatMap((g) => g.nests ?? []).length === am.plates);

  /* ───────────── 4 ───────────── */
  section('4. Read later: the server restarted (its memory gone) — the stored run is read back');
  const figures = J([cmp.uploaded.metrics, cmp.auto.metrics, cmp.headline]);
  await R._forgetMemory();
  r = await call('GET', `${base}/nesting/compare?with=auto`);
  ok('the same run, ready, the same figures', r.json?.auto?.runId === run1 && r.json.auto.status === 'ready' && J([r.json.uploaded.metrics, r.json.auto.metrics, r.json.headline]) === figures, J([r.json?.auto?.runId, run1]));

  /* ───────────── 5 ───────────── */
  section('5. A preview, a refused save and a viewer queue nothing');
  const nRuns = (await runRows(fx.lineId)).length;
  r = await call('POST', `${base}/nesting/files`, { body: { files: asRequest(sets.B.filter((f) => f.filename.includes('-B3_'))) } });
  ok('a preview: no autoCompare in the answer', r.status === 200 && r.json?.dryRun === true && r.json.autoCompare === undefined);
  const overlap = F.nestFile(`${fx.tag}-X1_${F.T}mm_3000x1500.dxf`, { length: 3000, width: 1500 }, [F.place(fx, 'R', 100, 100), F.place(fx, 'R', 700, 300)]);
  r = await call('POST', `${base}/nesting/files`, { body: { files: [{ filename: overlap.filename, file: overlap.file }], dryRun: false } });
  ok('a save refused by its own check (overlap): applied false, no autoCompare', r.status === 200 && r.json?.applied === false && r.json.autoCompare === undefined, J([r.json?.applied, r.json?.message]));
  r = await call('POST', `${base}/nesting/files`, { token: T_VIEWER, body: { files: asRequest(part), dryRun: false } });
  ok('a viewer: 403', r.status === 403);
  await C.settleAutoCompares(); await R.settleRuns();
  ok('…no run was started', (await runRows(fx.lineId)).length === nRuns);

  /* ───────────── 6 ───────────── */
  section('6. A new upload of other pieces: the old comparison is out of date, a new run answers');
  const more = sets.B.filter((f) => f.filename.includes('-B3_'));
  r = await call('POST', `${base}/nesting/files`, { body: { files: asRequest(more), dryRun: false } });
  ok('saved (merge: a 4th plate), queued', r.status === 200 && r.json?.applied === true && r.json.autoCompare?.queued === true, `${r.status} ${r.json?.message}`);
  await C.settleAutoCompares();
  r = await call('GET', `${base}/nesting/compare?with=auto`);
  cmp = r.json ?? {};
  ok('right away: our side is running (or already ready) — never the old figures as current', ['running', 'ready'].includes(cmp.auto?.status) && cmp.auto.runId !== run1, J([cmp.auto?.status, cmp.auto?.runId]));
  if (cmp.auto?.status === 'running') ok('…and the old run is reported stale, with why', cmp.stale?.runId === run1 && /different demand/.test(cmp.stale.reason), J(cmp.stale));
  r = await pollCompare(base, (j) => ready(j) && j.auto.runId !== run1);
  cmp = r.json ?? {};
  const run2 = cmp.auto?.runId;
  ok('the new run answers: ready, for this upload, 4 plates of pieces on the customer side', ready(cmp) && run2 !== run1 && cmp.auto.forThisUpload === true && cmp.uploaded.metrics.plates === 4 && cmp.likeForLike?.same === true, J([cmp.auto?.status, cmp.uploaded?.metrics?.plates, cmp.likeForLike]));
  rows = await compareRows(fx.lineId);
  ok('the old run is kept (ready, its own demand) — a second row, not overwritten', rows.length === 2 && rows.every((x) => x.status === 'ready') && rows[0].demand_hash !== rows[1].demand_hash, J(rows.map((x) => [x.run_uid.slice(0, 8), x.status])));

  /* ───────────── 7 ───────────── */
  section('7. A customer plate taken off, then put back: the runs already there answer, nothing is packed');
  const allFour = sets.B.filter((f) => ['-B1_', '-B2.', '-B3_', '-B5_'].some((k) => f.filename.includes(k)));
  const b3Lot = (await call('GET', `${base}/nesting/files`)).json?.plates?.find((p) => p.file?.filename?.includes('-B3_'));
  r = await call('DELETE', `${base}/nesting/lots/${b3Lot?.lotId}`);
  ok('a customer\'s plate taken off: applied, queued (the upload changed)', r.status === 200 && r.json?.applied === true && r.json.autoCompare?.queued === true, `${r.status} ${r.text.slice(0, 200)}`);
  await C.settleAutoCompares(); await R.settleRuns();
  r = await call('GET', `${base}/nesting/compare?with=auto`);
  ok('…the first run answers the three plates again (no third run)', (await compareRows(fx.lineId)).length === 2 && r.json?.auto?.runId === run1 && ready(r.json), J([r.json?.auto?.runId, run1]));
  ok('…the server said so: autoCompare.status answered', r.json?.autoCompare?.status === 'answered', J(r.json?.autoCompare));
  r = await call('POST', `${base}/nesting/files`, { body: { files: asRequest(more), dryRun: false } });
  ok('the plate put back: saved, queued', r.status === 200 && r.json?.applied === true && r.json.autoCompare?.queued === true, `${r.status} ${r.json?.message}`);
  await C.settleAutoCompares(); await R.settleRuns();
  r = await call('GET', `${base}/nesting/compare?with=auto`);
  ok('…the second run answers (the same pieces), still no third run', (await compareRows(fx.lineId)).length === 2 && r.json?.auto?.runId === run2 && ready(r.json), J([r.json?.auto?.runId, run2]));
  ok('…it was made for an earlier upload of the same pieces: forThisUpload false', r.json?.auto?.forThisUpload === false);

  /* ───────────── 8 ───────────── */
  section('8. A save while our run works is not refused; the older upload\'s run is cancelled');
  r = await call('POST', `${base}/nesting/files`, { body: { remove: [], files: asRequest(part), dryRun: false, mode: 'replace' } });
  ok('back to 3 plates: saved, queued', r.status === 200 && r.json?.applied === true, `${r.status} ${r.json?.message}`);
  // That demand (3 plates) is answered by run 1. Now a demand nobody answered: 2 plates only — and at once a third save.
  const two = sets.B.filter((f) => ['-B1_', '-B2.'].some((k) => f.filename.includes(k)));
  r = await call('POST', `${base}/nesting/files`, { body: { files: asRequest(two), dryRun: false, mode: 'replace' } });
  ok('2 plates: saved, queued', r.status === 200 && r.json?.applied === true && r.json.autoCompare?.queued === true, `${r.status} ${r.json?.message}`);
  await C.settleAutoCompares();
  const mem8 = R.memoryRun(COMPANY, fx.lineId);
  const r8 = await call('POST', `${base}/nesting/files`, { body: { files: asRequest(sets.B.filter((f) => f.filename.includes('-B1_'))), dryRun: false, mode: 'replace' } });
  ok(`a save while our run ${mem8?.status === 'running' ? 'IS working' : 'had just finished'}: 200 applied, never RUN_BUSY`, r8.status === 200 && r8.json?.applied === true, `${r8.status} ${r8.text.slice(0, 300)}`);
  await C.settleAutoCompares();
  r = await pollCompare(base, (j) => ready(j) && j.auto.forThisUpload === true);
  cmp = r.json ?? {};
  ok('the newest upload (1 plate) is the one answered', ready(cmp) && cmp.uploaded?.metrics?.plates === 1 && cmp.likeForLike?.same === true, J([cmp.auto?.status, cmp.uploaded?.metrics?.plates]));
  await R.settleRuns();
  rows = await compareRows(fx.lineId);
  ok('no comparison run is left running', rows.every((x) => x.status !== 'running'), J(rows.map((x) => x.status)));

  /* ───────────── 9 ───────────── */
  section('9. A person\'s nesting run goes first');
  r = await call('POST', `${base}/nesting/files`, { body: { files: asRequest(two), dryRun: false, mode: 'replace' } });
  await C.settleAutoCompares();
  const wasRunning = R.memoryRun(COMPANY, fx.lineId)?.status === 'running';
  const t9 = Date.now();
  r = await call('POST', `${base}/nesting/runs`, { body: { effort: 'quick' } });
  ok(`POST …/nesting/runs while our run ${wasRunning ? 'works' : 'is done'}: 200, the person's run starts (never RUN_BUSY)`, r.status === 200 && r.json?.status === 'running' && r.json.purpose === 'nest', `${r.status} ${r.text.slice(0, 300)}`);
  console.log(`    started in ${Date.now() - t9} ms (our run ${wasRunning ? 'was stopped first' : 'had finished'})`);
  const t0 = Date.now();
  for (;;) { const s = await call('GET', `${base}/nesting/runs/current`); if (s.json?.status !== 'running' || Date.now() - t0 > 60_000) break; await wait(300); }
  await call('DELETE', `${base}/nesting/runs/current`);
  await R.settleRuns();
  r = await call('GET', `${base}/nesting/compare?with=auto`);
  ok('our run of the upload is kept: ready (stopped early when it was cut short)', ready(r.json) && (wasRunning ? typeof r.json.auto.stoppedEarly === 'boolean' : r.json.auto.stoppedEarly === false), J([r.json?.auto?.status, r.json?.auto?.stoppedEarly]));

  /* ───────────── 10 ───────────── */
  section('10. The Compare tab\'s own start: { run: true, auto: true }');
  r = await call('POST', `${base}/nesting/compare`, { token: T_VIEWER, body: { run: true, auto: true } });
  ok('a viewer may ask; a run already answers: answered, nothing packed', r.status === 200 && r.json?.answered === true && r.json.started === false, `${r.status} ${r.text.slice(0, 200)}`);
  const nC = (await compareRows(fx.lineId)).length;
  await pool.query("UPDATE cf_nest_runs SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND purpose = 'compare' AND deleted_at IS NULL", [COMPANY, fx.lineId]);
  r = await call('GET', `${base}/nesting/compare?with=auto`);
  ok('with every run gone (lost before it began): auto.status none', r.json?.auto?.status === 'none', r.json?.auto?.status);
  r = await call('POST', `${base}/nesting/compare`, { body: { run: true, auto: true } });
  ok('…the tab starts it: started, Standard, the upload\'s pieces', r.status === 200 && r.json?.started === true, `${r.status} ${r.text.slice(0, 200)}`);
  r = await pollCompare(base, ready);
  ok('…and it answers', ready(r.json) && r.json.auto.trigger === 'screen' && r.json.auto.forThisUpload === true, J([r.json?.auto?.status, r.json?.auto?.trigger]));
  void nC;

  /* ───────────── 11 ───────────── */
  section('11. CF_NEST_AUTO_COMPARE=off');
  process.env.CF_NEST_AUTO_COMPARE = 'off';
  r = await call('POST', `${base}/nesting/files`, { body: { files: asRequest(part), dryRun: false, mode: 'replace' } });
  ok('saved, nothing queued (no autoCompare)', r.status === 200 && r.json?.applied === true && r.json.autoCompare === undefined, J([r.json?.applied, r.json?.autoCompare]));
  delete process.env.CF_NEST_AUTO_COMPARE;
  await R.settleRuns();

  /* ───────────── 12 ───────────── */
  section('12. With a purchase order: the upload is SAVED directly (§71: the plate-change gate is off) and our comparison runs');
  {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      attachNodeCache(conn);
      await rollOut(conn, fx);
      const asker = { companyId: COMPANY, userId: people[0].id, userName: people[0].name };
      const raised = await RQ.raiseRequisitions(conn, asker, fx.orderId, { lineIds: [fx.lineId] });
      const pr = raised.requisitions.find((x) => x.line.id === fx.lineId);
      const plateLines = pr.lines.filter((l) => Object.values(fx.plates).includes(Number(l.item.id)));
      await FX.buyThroughPr(conn, asker, { place: false, lines: plateLines.map((l) => ({ prLineId: l.id })) });
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch { /* first error */ } throw e; } finally { detachNodeCache(conn); conn.release(); }
  }
  await R.settleRuns();
  const n12 = (await compareRows(fx.lineId)).length;
  r = await call('POST', `${base}/nesting/files`, { body: { files: asRequest(allFour), dryRun: false, mode: 'replace', reason: 'The customer sent one more plate.' } });
  ok('a PO covers the line, yet the upload is SAVED at once — no request, no MD (§71)', r.status === 200 && r.json?.applied === true && !r.json?.requested && !r.json?.plateChange?.code, `${r.status} ${r.text.slice(0, 300)}`);
  void n12;
  await C.settleAutoCompares();
  r = await pollCompare(base, (j) => ready(j) && j.auto.forThisUpload === true);
  ok('…and our nesting of the approved upload runs and answers (4 plates of pieces)', ready(r.json) && r.json.uploaded?.metrics?.plates === 4 && r.json.auto.trigger === 'upload', J([r.json?.auto?.status, r.json?.uploaded?.metrics?.plates, r.json?.auto?.trigger]));
} catch (err) {
  failed += 1; fails.push(`ERROR ${err?.message}`);
  console.error('\nERROR', err);
} finally {
  section('13. Cleanup');
  try { await cleanup(); } catch (e) { failed += 1; fails.push(`cleanup: ${e.message}`); console.error(e); }
  server.close();
}
ok('order line 923 is untouched (its row and release count)', (await kepl()) === keplBefore);
const after = await counts();
const changed = after.filter((x) => Number(x.n) !== Number(before.find((b) => b.name === x.name)?.n));
ok('every cf_ table is back to the count it started at', changed.length === 0, changed.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
