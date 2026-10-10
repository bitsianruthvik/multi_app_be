/**
 * nest_upload_test.mjs — Nesting v2 (init.sql §55): upload the customer's nesting files, a
 * re-upload is a difference, nest the rest into the free space, compare with our automatic
 * nesting, runs that survive a restart, drawings in automatic nesting. Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest_upload_test.mjs            # every scenario
 *   node scripts/cf_kepl/nest_upload_test.mjs 1 4 13                        # only these
 *   NEST_V2_DOC=1 …                                                         # print real request/response examples
 *
 * ONE TRANSACTION, ROLLED BACK, and every cf_ table is re-counted at the end. IT OWNS ITS
 * FIXTURE (lib/nestV2Fixture.mjs): its own plates, grades, cut settings, order, line, parts,
 * cut plates and drawings at a thickness nothing else has. The customer's files are written by
 * lib/nestDxfFixtures.mjs the way different nesting programs write them.
 *
 * Background runs are given the test's own connection (startRun's `db`), so they see the
 * uncommitted fixture; the real packers run (worker pool, shapePacker).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

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
const S = await imp('apps/cf_erp/services/nestShapes.js');
const CNC = await imp('apps/cf_erp/services/cncExportService.js');
const DR = await imp('apps/cf_erp/services/partDrawingService.js');
const RD = await imp('apps/cf_erp/lib/nestDxfReader.js');
const F = await imp('scripts/cf_kepl/lib/nestV2Fixture.mjs');
const D = await imp('scripts/cf_kepl/lib/nestDxfFixtures.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const ONLY = new Set(process.argv.slice(2).map(Number).filter(Boolean));
const want = (n) => !ONLY.size || ONLY.has(n);
const DOC = process.env.NEST_V2_DOC === '1';
const doc = {};

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean — got ${typeof name}, ${typeof cond} (${String(name).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 700)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + Number(f(x) ?? 0), 0);
const J = (v) => JSON.stringify(v);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

/** Counts the round trips made through it (a Proxy, so the transaction's node cache still rides on the connection). */
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, {
    get: (target, prop) => (prop === 'query' || prop === 'execute'
      ? (...args) => { tally.n += 1; if (process.env.NEST_V2_TRACE) console.log(`    ${String(tally.n).padStart(4)}  ${String(args[0]?.sql ?? args[0]).replace(/\s+/g, ' ').slice(0, 120)}`); return target[prop](...args); }
      : Reflect.get(target, prop)),
  });
  return { db: proxy, tally };
}

const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'nest v2 test' };

/* ───────────────────────────── helpers on a fixture ───────────────────────────── */

/** The files of a set as the request takes them; a file that does not draw its plate is told which plate it is. */
const asRequest = (fx, files) => files.map((f) => ({ filename: f.filename, file: f.file, ...(f.style === 'segments' ? { plateCode: fx.plateCode('PS') } : {}) }));
const upload = (fx, files, opts = {}) => U.uploadNestFiles(conn, c, fx.lineId, { files: Array.isArray(files) && files[0]?.text ? asRequest(fx, files) : files, ...opts });
const liveLots = async (fx) => (await conn.query("SELECT * FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate' ORDER BY lot_no", [COMPANY, fx.lineId]))[0];
const liveCount = async (table, fx) => Number((await conn.query(`SELECT COUNT(*) n FROM ${table} WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL`, [COMPANY, fx.lineId]))[0][0].n);
const clearLine = async (fx) => { const lots = await liveLots(fx); for (const l of lots) await U.deleteNestLot(conn, c, fx.lineId, l.id); };

/** What the file's generator drew for one part, in plate mm: [outline, …openings]. */
const drawn = (part) => RD.placeRings(part.shape.loops.map(D.flattenLoop), { x: part.x, y: part.y, rotationDeg: part.rotationDeg ?? 0, mirrored: !!part.mirrored });
const boxMin = (rings) => [Math.min(...rings[0].map((p) => p[0])), Math.min(...rings[0].map((p) => p[1]))];
/** A saved piece as the API gives it, as rings in plate mm. */
/** A drilled hole comes back as a circle { cx, cy, d }: as a ring again, for measuring. */
const holeRing = (h) => (Array.isArray(h) ? h : Array.from({ length: 72 }, (_, k) => [h.cx + (h.d / 2) * Math.cos((k * 5 * Math.PI) / 180), h.cy + (h.d / 2) * Math.sin((k * 5 * Math.PI) / 180)]));
const ringsOfPiece = (p) => (p.rings ? [p.rings.outline, ...p.rings.cutouts, ...p.rings.holes.map(holeRing)] : [[[p.x, p.y], [p.x + p.length, p.y], [p.x + p.length, p.y + p.width], [p.x, p.y + p.width]]]);

/**
 * Every part the files drew is stored where it was drawn: the worst distance, over all parts,
 * between the saved piece's outline and the file's (offset = where a file with no plate drawn was put).
 */
async function worstDeviation(fx, files, answer) {
  const view = await N.getNesting(conn, COMPANY, fx.lineId);
  const nests = view.groups.flatMap((g) => g.nests);
  let worst = 0; let unmatched = 0; let pieces = 0;
  for (const f of files) {
    const entry = answer.files.find((e) => e.filename === f.filename);
    const nest = nests.find((n) => n.lotNo.toUpperCase() === entry.lotNo.toUpperCase());
    if (!nest) { unmatched += f.parts.length; continue; }
    const expected = f.parts.map((p) => ({ sfx: p.sfx, rings: drawn(p) }));
    // A file with no plate drawn is measured from the corner of its parts, then moved by the offset the answer states.
    let shift = [0, 0];
    if (!entry.plate.drawn) {
      const mins = expected.map((e) => boxMin(e.rings));
      shift = [entry.plate.offset[0] - Math.min(...mins.map((m) => m[0])), entry.plate.offset[1] - Math.min(...mins.map((m) => m[1]))];
    }
    const left = nest.pieces.slice();
    for (const e of expected) {
      const rings = e.rings.map((r) => r.map(([x, y]) => [x + shift[0], y + shift[1]]));
      const [bx, by] = boxMin(rings);
      const i = left.findIndex((p) => Number(p.cutPlateId) === Number(fx.cut[e.sfx]) && Math.abs(p.x - bx) <= 0.6 && Math.abs(p.y - by) <= 0.6);
      if (i < 0) { unmatched += 1; continue; }
      const [piece] = left.splice(i, 1);
      pieces += 1;
      worst = Math.max(worst, RD.ringsDeviation(ringsOfPiece(piece), rings));
    }
    unmatched += left.filter((p) => p.placedBy === 'customer').length;
  }
  return { worst, unmatched, pieces, view, nests };
}

/** parts + waste by cause = the plate, for every saved plate (mm²). */
const identityGap = (nests) => Math.max(0, ...nests.map((n) => Math.abs(n.usedArea + sum(Object.values(n.waste)) - n.sheetArea)));

const valueOf = async (masterId, code) => {
  const [[r]] = await conn.query("SELECT v.value_number FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.deleted_at IS NULL AND s.code = ?", [COMPANY, masterId, code]);
  return r ? Number(r.value_number) : null;
};
const bomQty = async (lineIdOfBom) => { const [[r]] = await conn.query('SELECT child_id, quantity FROM cf_bom_lines WHERE id = ?', [lineIdOfBom]); return { childId: Number(r.child_id), quantity: Number(r.quantity) }; };

/** Starts the automatic side and polls like the page does, until it is there. */
async function runCompare(fx, input = {}) {
  const started = await C.startCompare(conn, c, fx.lineId, { run: true, effort: 'quick', ...input });
  let view = null;
  for (let i = 0; i < 900; i += 1) {
    await wait(200);
    if (R.memoryRun(COMPANY, fx.lineId)?.status === 'running') continue;
    await R.settleRuns();
    view = await C.getCompare(conn, COMPANY, fx.lineId, {});
    break;
  }
  return { started, view };
}

try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  section('Fixture');
  const fx = await F.buildFixture(conn, { company: COMPANY });
  const sets = F.nestings(fx);
  const need = Object.fromEntries(Object.entries(fx.parts).map(([k, p]) => [k, p.qty]));
  const pieceTotal = sum(Object.values(need));
  console.log(`  ${fx.tag}: line ${fx.lineId}, ${Object.keys(fx.cut).length} cut plates, ${pieceTotal} pieces; verify engine ${S.VERIFY_ENGINE}, shape metrics ${S.hasShapeMetrics}`);
  ok('the fixture is the line the survey sees: every cut plate with its quantity', await (async () => {
    const ctx = await N.importContext(conn, COMPANY, fx.lineId);
    return Object.entries(fx.cut).every(([sfx, id]) => ctx.cutPlates.find((cp) => cp.id === id)?.pieces === need[sfx]);
  })());
  const facts = await DR.drawingFactsOfLine(conn, COMPANY, fx.lineId);
  ok('five cut plates have a drawing (one shape each), six are rectangles', [...facts.values()].filter((f) => f.rings).length === 5, String(facts.size));

  /* ───────────── 1. three complete nestings ───────────── */
  const measured = {};
  if (want(1)) {
    section('1. Three different complete nestings of the same line — each uploads clean, stored exactly as drawn');
    for (const name of ['A', 'B', 'C']) {
      const files = sets[name];
      const lotsBefore = (await liveLots(fx)).length;
      const dry = await upload(fx, files, { mode: 'replace' });
      if (DOC && name === 'B') doc.uploadDryRun = { request: { files: asRequest(fx, files).map((f) => ({ ...f, file: `${f.file.slice(0, 24)}…` })), mode: 'replace' }, response: dry };
      ok(`${name}: the dry run is clean — ${files.length} files, no problem, no warning, nothing to force`, dry.dryRun === true && dry.applied === false && dry.canSave === true && dry.needsForce === false && dry.problems.length === 0 && dry.warnings.length === 0, J([dry.problems, dry.warnings]));
      ok(`${name}: …and wrote nothing`, (await liveLots(fx)).length === lotsBefore);
      ok(`${name}: every part of every file is matched (${sum(dry.files, (f) => f.parts)} parts), nothing left over`, dry.files.every((f) => f.placed === f.parts && f.status === 'ok') && sum(dry.files, (f) => f.placed) === pieceTotal && dry.leftOver.length === 0, J(dry.leftOver));
      ok(`${name}: the diff says ${files.length} added${lotsBefore ? `, ${lotsBefore} removed` : ''}`, dry.diff.added.length === files.length && dry.diff.removed.length === lotsBefore && dry.diff.replaced.length === 0);
      const saved = await upload(fx, files, { mode: 'replace', dryRun: false });
      if (DOC && name === 'B') doc.uploadSave = { response: { ...saved, files: saved.files.map((f) => ({ ...f, placements: f.placements.slice(0, 2) })) } };
      ok(`${name}: saved — ${files.length} plates, ${pieceTotal} pieces`, saved.applied === true && saved.saved.lots === files.length && saved.saved.pieces === pieceTotal, J(saved.saved ?? saved.message));
      const lots = await liveLots(fx);
      ok(`${name}: every lot is imported, laid out by the customer, from a DXF, with its file kept`, lots.length === files.length && lots.every((l) => l.origin === 'imported' && l.layout_origin === 'customer' && l.source_kind === 'dxf' && l.nest_file_id && l.source_hash?.length === 64 && l.check_verdict === 'fits' && !l.forced));
      const dev = await worstDeviation(fx, files, saved);
      ok(`${name}: every stored placement, placed again, is the file's geometry (worst ${dev.worst.toFixed(3)} mm over ${dev.pieces} parts)`, dev.unmatched === 0 && dev.pieces === pieceTotal && dev.worst <= 0.5, J({ unmatched: dev.unmatched, pieces: dev.pieces }));
      const gap = identityGap(dev.nests);
      ok(`${name}: parts + waste by cause = the plate, on every plate (worst ${gap.toFixed(4)} mm²)`, gap <= 1);
      const splice = dev.nests.flatMap((n) => n.pieces).find((p) => p.cutPlateId === fx.cut.P);
      ok(`${name}: a drilled hole is shown as a circle, not seventy points (splice plate: 12 holes of 26 mm)`, splice.rings.holes.length === 12 && splice.rings.holes.every((h) => Number.isFinite(h.cx) && Number.isFinite(h.cy) && Math.abs(h.d - 26) < 0.2) && splice.rings.cutouts.length === 0);
      ok(`${name}: every piece says who placed it (the customer) and its turn`, dev.nests.every((n) => n.layoutOrigin === 'customer' && n.pieces.every((p) => p.placedBy === 'customer' && Number.isFinite(p.rotationDeg) && typeof p.mirrored === 'boolean')));
      // The plate quantity on each cut plate's BOM line: over all cut plates it is the steel of the plates.
      const q = saved.saved.quantities;
      const plateArea = (itemId) => { const k = Object.keys(fx.plates).find((s) => fx.plates[s] === itemId); return fx.plateSize[k][0] * fx.plateSize[k][1]; };
      const charged = sum(q, (x) => x.quantity * x.blanks * plateArea(x.plateItemId));
      const bought = sum(lots, (l) => Number(l.length_mm) * Number(l.width_mm));
      ok(`${name}: the plate quantities on the BOM lines add up to the plates bought (${(bought / 1e6).toFixed(3)} m²)`, q.length === Object.keys(fx.cut).length && q.every((x) => x.applied && x.basis === 'nesting plan') && Math.abs(charged - bought) / bought < 1e-4, `${charged} vs ${bought}`);
      const bl = await bomQty(fx.plateLine.G);
      ok(`${name}: …and are written (gusset line: ${bl.quantity})`, Math.abs(bl.quantity - q.find((x) => x.cutPlateId === fx.cut.G).quantity) < 1e-6);
      ok(`${name}: offcuts are recorded for the saved plates (${saved.saved.offcuts})`, (await liveCount('cf_offcuts', fx)) === saved.saved.offcuts && saved.saved.offcuts === sum(saved.files, (f) => f.metrics.offcuts));
      ok(`${name}: cut length and piercings are on the cut plates — drilled holes do not pierce, a window does`, saved.saved.cuts.nested === Object.keys(fx.cut).length && (await valueOf(fx.cut.F, 'PIERCINGS')) === 2 && ((await valueOf(fx.cut.P, 'PIERCINGS')) ?? 1) === 1 && (await valueOf(fx.cut.G, 'CUT_LENGTH')) > 0);
      const cmp = await C.getCompare(conn, COMPANY, fx.lineId, {});
      measured[name] = cmp.uploaded.metrics;
      ok(`${name}: measured — ${measured[name].plates} plates, ${measured[name].tonnesBought} t bought, ${measured[name].wastePct}% waste, ${measured[name].cutLengthM} m of cut, ${measured[name].piercings} piercings, ₹${measured[name].cost.value}`,
        measured[name].plates === files.length && measured[name].pieces === pieceTotal && measured[name].cost.value > 0 && measured[name].cutLengthM > 0 && measured[name].piercings >= pieceTotal);
    }
    const [a, b, cc] = [measured.A, measured.B, measured.C];
    ok('the three differ as they should: A buys least and wastes least, B most (2 / 5 / 3 plates)', a.plates === 2 && b.plates === 5 && cc.plates === 3 && a.tonnesBought < cc.tonnesBought && cc.tonnesBought < b.tonnesBought && a.wastePct < cc.wastePct && cc.wastePct < b.wastePct && a.cost.value < cc.cost.value && cc.cost.value < b.cost.value, J([a.tonnesBought, b.tonnesBought, cc.tonnesBought]));
    ok('the parts are the same steel in all three', Math.abs(a.partsTonnes - b.partsTonnes) < 1e-3 && Math.abs(a.partsTonnes - cc.partsTonnes) < 1e-3, J([a.partsTonnes, b.partsTonnes, cc.partsTonnes]));
    ok('the common-cut nesting cuts less than the same rectangles standing apart', cc.sharedCutM > a.sharedCutM, J([a.sharedCutM, cc.sharedCutM]));
  }

  /* ───────────── 13. export → re-import ───────────── */
  if (want(13)) {
    section('13. Our own CNC export of an imported nest reads back to the same placements');
    await clearLine(fx);
    const savedB = await upload(fx, sets.B, { dryRun: false });
    const lots = await liveLots(fx);
    const exported = [];
    for (const l of lots) exported.push({ lot: l, file: await CNC.lotDxf(conn, COMPANY, fx.lineId, l.id) });
    ok('every imported plate has a CNC file (free angles and flipped parts included)', savedB.applied && exported.length === sets.B.length && exported.every((e) => e.file.buffer.length > 200));
    const again = await upload(fx, exported.map((e) => ({ filename: e.file.filename, file: e.file.buffer.toString('base64') })));
    ok('uploading the exported files back: read clean, each one recognised as the plate it came from', again.problems.length === 0 && again.diff.replaced.length === lots.length && again.diff.added.length === 0, J([again.problems, again.diff.added.map((x) => x.lotNo)]));
    ok('…with the same parts, none moved: the placements are the ones stored', again.diff.replaced.every((r) => r.parts.length === 0 && r.moved === 0), J(again.diff.replaced.map((r) => [r.lotNo, r.parts, r.moved])));
    const turned = again.files.flatMap((f) => f.placements).filter((p) => !S.isQuarterTurn(p.rotationDeg));
    ok(`…free angles came back as free angles (${turned.length} parts), flipped parts as flipped`, turned.length === 6 && again.files.flatMap((f) => f.placements).some((p) => p.mirrored));
  }

  /* ───────────── 2. one extra plate ───────────── */
  if (want(2)) {
    section('2. One extra plate added to a saved nesting — the surplus is refused, named; without it, saved');
    await clearLine(fx);
    const base = sets.B.filter((f) => !f.filename.includes('-B4_'));      // B without the gusset plate: 6 gussets left over
    const first = await upload(fx, base, { dryRun: false });
    ok('saved nesting: 4 plates, the six gussets left over', first.applied && first.leftOver.length === 1 && first.leftOver[0].cutPlateCode === fx.code('G') && first.leftOver[0].qty === 6, J(first.leftOver));
    const PS = { length: 3000, width: 1500 };
    const extra = F.nestFile(`${fx.tag}-E1_${F.T}mm_3000x1500.dxf`, PS, F.rows(fx, [['G'], ['G'], ['G'], ['G'], ['G'], ['G'], ['R'], ['H']], PS));
    const dry = await upload(fx, [extra]);
    ok('the diff says 1 added, the four saved plates untouched', dry.diff.added.length === 1 && dry.diff.added[0].lotNo === `${fx.tag}-E1` && dry.diff.replaced.length === 0 && dry.diff.removed.length === 0 && dry.totals.plates === 5, J(dry.diff));
    const over = dry.warningList.filter((w) => w.code === 'OVER_COVERAGE');
    ok('the line is now over-covered: an error that names the surplus parts and where they are', dry.needsForce === true && over.length === 2 && dry.surplus.length === 2
      && over.some((w) => w.cutPlateCode === fx.code('R') && w.surplus === 1 && w.message.includes(extra.filename) && /needs only 5/.test(w.message))
      && over.some((w) => w.cutPlateCode === fx.code('H') && w.surplus === 1), J(dry.warnings));
    const refused = await upload(fx, [extra], { dryRun: false });
    ok('…and it is NOT saved without force', refused.applied === false && /Not saved/.test(refused.message) && (await liveLots(fx)).length === 4, refused.message);
    if (DOC) doc.overCoverage = { warnings: dry.warnings, surplus: dry.surplus, message: refused.message };
    const fixed = F.nestFile(`${fx.tag}-E1_${F.T}mm_3000x1500.dxf`, PS, F.rows(fx, [['G'], ['G'], ['G'], ['G'], ['G'], ['G']], PS));
    const done = await upload(fx, [fixed], { dryRun: false });
    ok('with the surplus taken off the file it saves: 5 plates, every piece covered once, nothing left over', done.applied === true && done.needsForce === false && done.totals.plates === 5 && done.totals.pieces === pieceTotal && done.leftOver.length === 0 && done.coverage.every((x) => x.diff === 0), J([done.message, done.leftOver]));
  }

  /* ───────────── 3. one plate removed ───────────── */
  if (want(3)) {
    section('3. One plate removed — its parts are left over, its offcuts gone, the rest untouched');
    await clearLine(fx);
    await upload(fx, sets.B, { dryRun: false });
    const lots = await liveLots(fx);
    const victim = lots.find((l) => l.lot_no === `${fx.tag}-B3`);
    const offBefore = Number((await conn.query('SELECT COUNT(*) n FROM cf_offcuts WHERE plate_lot_id = ? AND deleted_at IS NULL', [victim.id]))[0][0].n);
    const others = lots.filter((l) => l.id !== victim.id).map((l) => l.id);
    const dry = await U.uploadNestFiles(conn, c, fx.lineId, { remove: [victim.lot_no] });
    const b3 = D.STYLES && F.countsOf([sets.B.find((f) => f.filename.includes('-B3_'))]);
    ok('the diff says 1 removed, with what was on it', dry.diff.removed.length === 1 && dry.diff.removed[0].lotNo === victim.lot_no && dry.diff.added.length === 0 && dry.canSave === true && dry.applied === false, J(dry.diff.removed));
    const leftWant = Object.entries(b3).map(([sfx, qty]) => `${fx.code(sfx)}:${qty}`).sort().join(' ');
    ok(`its parts are listed as left over, with quantities (${leftWant.replaceAll(`${fx.tag}-`, '')})`, dry.leftOver.map((x) => `${x.cutPlateCode}:${x.qty}`).sort().join(' ') === leftWant, J(dry.leftOver));
    if (DOC) doc.removePlate = { request: { remove: [victim.lot_no] }, response: dry };
    const done = await U.uploadNestFiles(conn, c, fx.lineId, { remove: [victim.lot_no], dryRun: false });
    ok('saved: 4 plates stay, the same rows as before', done.applied === true && done.totals.plates === 4 && (await liveLots(fx)).map((l) => l.id).sort().join() === others.sort().join());
    ok(`the removed plate's offcuts are gone (it had ${offBefore})`, offBefore > 0 && Number((await conn.query('SELECT COUNT(*) n FROM cf_offcuts WHERE plate_lot_id = ? AND deleted_at IS NULL', [victim.id]))[0][0].n) === 0);
    ok('its file is gone with it', Number((await conn.query('SELECT COUNT(*) n FROM cf_nest_files WHERE id = ? AND deleted_at IS NULL', [victim.nest_file_id]))[0][0].n) === 0);
    const m = await bomQty(fx.plateLine.M);
    ok('a cut plate on no plate now goes back to its area fraction on the BOM line', Math.abs(m.quantity - (250 * 200) / (3000 * 1500)) < 1e-6 && done.saved.quantities.some((x) => x.cutPlateId === fx.cut.M && x.basis === 'area fraction'), J(m));
    const one = (await liveLots(fx)).find((l) => l.lot_no === `${fx.tag}-B5`);
    const del = await U.deleteNestLot(conn, c, fx.lineId, one.id);
    if (DOC) doc.deleteLot = { response: del };
    ok('DELETE of one lot: gone, its two grade-B pieces left over, totals follow', del.applied && del.removed.lotNo === one.lot_no && del.totals.plates === 3 && del.leftOver.some((x) => x.cutPlateCode === fx.code('B') && x.qty === 2), J(del.leftOver));
    const view = await U.getNestFiles(conn, COMPANY, fx.lineId);
    if (DOC) doc.getFiles = { response: view };
    ok('GET files says the same: 3 plates, each with its file, and what is left over', view.plates.length === 3 && view.plates.every((p) => p.file?.filename && p.customerPieces === p.pieces && p.ourPieces === 0) && view.totals.leftOverPieces === sum(view.leftOver, (x) => x.qty) && view.canUpload === true);
    const file = await U.nestFileOf(conn, COMPANY, fx.lineId, view.plates[0].lotId);
    ok('…and the customer\'s file comes back byte for byte', file.buffer.toString('latin1') === sets.B.find((f) => f.filename === view.plates[0].file.filename).text);
  }

  /* ───────────── 4. errors ───────────── */
  if (want(4)) {
    section('4. Errors — each names the file, the plate and the part');
    await clearLine(fx);
    const PS = { length: 3000, width: 1500 };
    const psCode = fx.plateCode('PS');
    const name = (sfx) => `${fx.tag}-${sfx}_${F.T}mm_3000x1500.dxf`;
    const one = async (file, opts = {}) => upload(fx, [file], opts);
    const has = (out, code, ...words) => out.problemList.some((p) => p.code === code && words.every((w) => p.message.includes(w)));
    const warned = (out, code, ...words) => out.warningList.some((p) => p.code === code && words.every((w) => p.message.includes(w)));

    let f = F.nestFile(name('X1'), PS, [F.place(fx, 'R', 100, 100), F.place(fx, 'R', 700, 300)]);
    let out = await one(f);
    ok('overlapping parts: a blocker', out.canSave === false && has(out, 'OVERLAP', f.filename, psCode, fx.code('R'), 'overlap'), J(out.problems));
    if (DOC) doc.errorOverlap = out.problems;

    f = F.nestFile(name('X2'), PS, [F.place(fx, 'R', 100, 100), F.place(fx, 'R', 2400, 600)]);
    out = await one(f);
    ok('a part hanging off the drawn plate: a blocker', out.canSave === false && has(out, 'OUTSIDE_PLATE', f.filename, psCode, 'runs off the plate'), J([out.problems, out.files[0].notes]));
    f = F.nestFile(`${fx.tag}-X2b.dxf`, { length: 3400, width: 1500 }, [F.place(fx, 'R', 20, 20), F.place(fx, 'R', 1300, 20), F.place(fx, 'R', 2150, 500)], { style: 'segments' });
    out = await upload(fx, [{ filename: f.filename, file: f.file, plateCode: psCode }]);
    ok('…and off a plate the file does not draw (named in the request): a blocker', out.canSave === false && has(out, 'OUTSIDE_PLATE', f.filename, psCode, fx.code('R')), J(out.problems));

    f = F.nestFile(name('X3'), PS, [F.place(fx, 'R', 1, 100), F.place(fx, 'H', 1300, 100), F.place(fx, 'H', 1601.5, 100)]);
    out = await one(f);
    ok('inside the rim, and nearer than the kerf: WARNINGS that need force, not blockers', out.canSave === true && out.needsForce === true && out.problems.length === 0
      && warned(out, 'IN_RIM', f.filename, psCode, fx.code('R'), 'kerf') && warned(out, 'TOO_CLOSE', f.filename, psCode, fx.code('H'), '1.5 mm apart'), J(out.warnings));
    if (DOC) doc.warnings = out.warnings;
    out = await one(f, { dryRun: false });
    ok('…not saved without force', out.applied === false);
    out = await one(f, { dryRun: false, force: true });
    const forcedLot = (await liveLots(fx))[0];
    ok('…saved with force, and the plate says so (verdict tight, forced, the warnings kept)', out.applied === true && forcedLot.check_verdict === 'tight' && !!forcedLot.forced && /kerf/.test(String(forcedLot.check_json)));
    const viewF = await N.getNesting(conn, COMPANY, fx.lineId);
    ok('…and the screen\'s rule badge for it is a warning', viewF.groups[0].nests[0].rules.status === 'warn' && viewF.groups[0].nests[0].reasons.length === 2);
    await clearLine(fx);

    f = F.nestFile(name('X4'), PS, [F.place(fx, 'R', 100, 100), { shape: D.rectShape(333, 222), x: 1500, y: 100, label: 'ZZ-9' }]);
    out = await one(f);
    ok('a part that is none of the line\'s cut plates', out.canSave === false && has(out, 'PART_UNKNOWN', f.filename, psCode, 'P2', 'ZZ-9', '333 x 222'), J(out.problems));

    f = F.nestFile(name('X5'), PS, [F.place(fx, 'R', 100, 100), F.place(fx, 'X1', 1500, 100, 0, false, null)]);
    out = await one(f);
    const amb = out.problemList.find((p) => p.code === 'PART_AMBIGUOUS');
    ok('an unlabelled part that could be two cut plates: the choices are listed', out.canSave === false && !!amb && amb.message.includes(f.filename) && amb.message.includes(psCode) && amb.message.includes(fx.code('X1')) && amb.message.includes(fx.code('X2')) && amb.choices.length === 2, J(out.problems));
    if (DOC) doc.ambiguous = amb;
    out = await upload(fx, [{ filename: f.filename, file: f.file }], { choices: { [f.filename]: { [amb.partId]: fx.cut.X2 } } });
    ok('…settled by `choices`', out.canSave === true && out.problems.length === 0 && out.files[0].counts.some((x) => x.cutPlateId === fx.cut.X2 && x.qty === 1) && out.files[0].placements.find((p) => p.partId === amb.partId).by === 'choice', J(out.problems));
    out = await upload(fx, [{ filename: f.filename, file: f.file }], { choices: { [f.filename]: { [amb.partId]: fx.code('R') } } });
    ok('…and a choice it cannot be is refused', has(out, 'CHOICE_INVALID', f.filename, fx.code('X1')), J(out.problems));

    f = F.nestFile(name('X6'), PS, [F.place(fx, 'R', 100, 100), F.place(fx, 'R', 100, 600, 0, false, fx.code('G'))]);
    out = await one(f);
    ok('the label says gusset, the shape is the rectangle', out.canSave === false && has(out, 'PART_LABEL_MISMATCH', f.filename, psCode, 'labelled', fx.code('G')), J(out.problems));

    f = F.nestFile(`${fx.tag}-X7_${F.T + 2}mm_3000x1500.dxf`, PS, [F.place(fx, 'R', 100, 100)]);
    out = await one(f);
    ok('wrong thickness: the file says the thicker plate, the part is thinner', out.canSave === false && has(out, 'PART_WRONG_THICKNESS', f.filename, fx.plateCode('PW'), fx.code('R'), '16.137'), J(out.problems));

    f = F.nestFile(name('X8'), PS, [F.place(fx, 'R', 100, 100), F.place(fx, 'B', 100, 600)]);
    out = await upload(fx, [{ filename: f.filename, file: f.file, plateCode: psCode }]);
    ok('wrong grade: a grade-B part on a grade-A plate', out.canSave === false && has(out, 'PART_WRONG_GRADE', f.filename, psCode, fx.code('B'), fx.GB, fx.GA), J(out.problems));

    f = F.nestFile(`${fx.tag}-X9_${F.T}mm_2750x1300.dxf`, { length: 2750, width: 1300 }, [F.place(fx, 'R', 100, 100)]);
    out = await one(f);
    ok('a plate size the catalog does not have', out.canSave === false && has(out, 'PLATE_NOT_FOUND', f.filename, '2750 × 1300'), J(out.problems));
    f = F.nestFile(`${fx.tag}-X9b.dxf`, PS, [F.place(fx, 'R', 100, 100)]);
    out = await one(f);
    ok('a plate size with nothing to say which of the same-size plates: decided by the parts\' own steel', out.problems.length === 0 && out.files[0].plate.code === psCode && out.files[0].plate.resolvedBy === 'size', J([out.problems, out.files[0].plate]));

    f = F.nestFile(name('X10'), PS, [F.place(fx, 'R', 100, 100)]);
    out = await upload(fx, [{ filename: f.filename, file: f.file }, { filename: `${fx.tag}-copy.dxf`, file: f.file }]);
    ok('the same file twice', out.canSave === false && has(out, 'DUPLICATE_FILE', `${fx.tag}-copy.dxf`, f.filename), J(out.problems));
    const g = F.nestFile(name('X10'), PS, [F.place(fx, 'R', 400, 400)]);
    out = await upload(fx, [{ filename: f.filename, file: f.file, nestNo: 'N7' }, { filename: `${fx.tag}-other.dxf`, file: g.file, nestNo: 'n7' }]);
    ok('two files claiming one nest number', out.canSave === false && has(out, 'DUPLICATE_NEST', `${fx.tag}-other.dxf`, 'nest n7', f.filename), J(out.problems));

    out = await upload(fx, [{ filename: `${fx.tag}-drawing.dwg`, file: Buffer.concat([Buffer.from('AC1027\0\0\0\0\0', 'latin1'), Buffer.alloc(64, 7)]).toString('base64') }]);
    ok('a DWG (binary) file', out.canSave === false && has(out, 'BAD_FILE', `${fx.tag}-drawing.dwg`, 'DWG'), J(out.problems));
    out = await upload(fx, [{ filename: `${fx.tag}-empty.dxf`, file: '' }, { filename: `${fx.tag}-nothing.dxf`, file: Buffer.from('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n').toString('base64') }]);
    ok('an empty file, and a DXF with nothing nested in it', out.canSave === false && has(out, 'BAD_FILE', `${fx.tag}-empty.dxf`) && has(out, 'EMPTY_NEST', `${fx.tag}-nothing.dxf`), J(out.problems));
    ok('one bad file does not hide the others: every file has its own entry and status', out.files.length === 2 && out.files.every((e) => e.status === 'error' && e.errors.length === 1));
    if (DOC) doc.badFiles = out.problems;

    f = F.nestFile(name('X11'), PS, [F.place(fx, 'R', 100, 100)]);
    await conn.query('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 1)', [COMPANY, fx.orderId, fx.lineId, fx.root]);
    out = await one(f);
    ok('a released line', out.canSave === false && out.problemList.some((p) => p.code === 'RELEASED' && /released to production/.test(p.message)), J(out.problems));
    let threw = null; try { await one(f, { dryRun: false }); } catch (e) { threw = e; }
    ok('…and a save attempt writes nothing', threw === null && (await liveLots(fx)).length === 0);
    await conn.query('DELETE FROM cf_production_releases WHERE company_id = ? AND order_line_id = ?', [COMPANY, fx.lineId]);
    await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [fx.lineId]);
    out = await one(f);
    ok('an unfrozen line', out.canSave === false && out.problemList.some((p) => p.code === 'NOT_FROZEN' && /Freeze the design first/.test(p.message)), J(out.problems));
    await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [fx.lineId]);
    out = await one(f);
    ok('frozen again, the same file is clean', out.canSave === true && out.problems.length === 0);
    let noFile = null; try { await U.uploadNestFiles(conn, c, fx.lineId, { files: [] }); } catch (e) { noFile = e; }
    ok('no file at all is the one thing that throws', noFile?.code === 'NO_FILE');
  }

  /* ───────────── 5 + 6. partial upload, nest the rest, re-upload ───────────── */
  if (want(5) || want(6)) {
    section('5. A partial upload (about 60 % of the pieces) — the rest is nested into the free space of the customer\'s plates first, then onto new ones');
    await clearLine(fx);
    const PS = { length: 3000, width: 1500 };
    const part = sets.B.filter((f) => ['-B1_', '-B2.', '-B5_'].some((k) => f.filename.includes(k)));
    const up = await upload(fx, part, { dryRun: false });
    const upCounts = F.countsOf(part);
    const wantLeft = Object.entries(need).map(([sfx, n]) => [fx.code(sfx), n - (upCounts[sfx] ?? 0)]).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).sort().join(' ');
    ok(`uploaded ${up.totals.pieces} of ${pieceTotal} pieces on 3 plates`, up.applied && up.totals.pieces === 24 && up.totals.plates === 3);
    ok(`the left-over list is exact (${wantLeft.replaceAll(`${fx.tag}-`, '')})`, up.leftOver.map((x) => `${x.cutPlateCode}:${x.qty}`).sort().join(' ') === wantLeft && up.leftOver.find((x) => x.cutPlateCode === fx.code('M')).manual === true && up.totals.leftOverToNest === 13, J(up.leftOver));
    const theirs = async () => (await conn.query(
      `SELECT l.lot_no, p.cut_plate_id, CAST(p.x_mm AS CHAR) x, CAST(p.y_mm AS CHAR) y, CAST(p.length_mm AS CHAR) l, CAST(p.width_mm AS CHAR) w, CAST(p.rotation_deg AS CHAR) r, p.mirrored
         FROM cf_plate_lots l JOIN cf_nest_placements p ON p.plate_lot_id = l.id AND p.deleted_at IS NULL
        WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL AND p.placed_by = 'customer' ORDER BY l.lot_no, p.x_mm, p.y_mm, p.cut_plate_id`, [COMPANY, fx.lineId]))[0];
    const customerBefore = J(await theirs());

    const plan = await N.planNesting(conn, COMPANY, fx.lineId, { effort: 'quick', seed: 1 });
    const plain = await N.planNesting(conn, COMPANY, fx.lineId, { effort: 'quick', seed: 1, fillExisting: false });
    if (DOC) doc.planRest = { response: { ...plan, groups: plan.groups.map((g) => ({ ...g, cutPlates: g.cutPlates.slice(0, 1), candidates: g.candidates.slice(0, 1), nests: g.nests.slice(0, 1).map((n) => ({ ...n, pieces: n.pieces.slice(0, 2), offcuts: n.offcuts.slice(0, 1) })) })), additions: plan.additions.slice(0, 1).map((a) => ({ ...a, pieces: a.pieces.slice(0, 2), after: { ...a.after, offcuts: a.after.offcuts.slice(0, 1) } })), rest: { ...plan.rest, pieces: plan.rest.pieces.slice(0, 3) } } };
    ok('the proposal leaves the uploaded plates alone and nests only what is left (13 pieces; the hand-held ones stay out)', plan.imported.lots === 3 && plan.imported.pieces === 24 && plan.rest.onExisting + plan.rest.onNew === 13 && plan.rest.unplaced === 0 && plan.manual.length === 1, J(plan.rest));
    ok(`free space on the customer's plates is used FIRST: ${plan.rest.onExisting} pieces land on ${plan.additions.length} of them, ${plan.rest.onNew} on ${plan.totals.plates} new plate(s)`, plan.rest.onExisting >= 1 && plan.additions.length >= 1 && plan.additions.every((a) => a.pieces.every((p) => p.placedBy === 'ours') && a.layoutOrigin === 'customer'));
    ok(`…which buys no more than new plates alone would (${plan.totals.plates} against ${plain.totals.plates} new plates, ${plan.totals.areaBought} against ${plain.totals.areaBought} mm²)`, plain.additions.length === 0 && plan.totals.plates <= plain.totals.plates && plan.totals.areaBought <= plain.totals.areaBought + 1e-6);
    ok('the proposal says, per left-over piece, where it went', plan.rest.pieces.every((r) => sum(r.onExisting, (x) => x.qty) + sum(r.onNew, (x) => x.qty) + r.unplaced === r.qty) && plan.rest.pieces.some((r) => r.onExisting.length && r.onExisting[0].lotId));
    ok('nothing of grade A is added to the grade-B plate, and no plate of another thickness is touched', plan.additions.every((a) => a.lotNo !== `${fx.tag}-B5` && Math.abs(a.thickness - F.T) < 1e-6));

    const acc = await N.acceptNesting(conn, c, fx.lineId, plan);
    if (DOC) doc.acceptRest = { response: { ...acc, quantities: acc.quantities.slice(0, 1), choices: undefined } };
    ok(`accepted: ${acc.additions.pieces} pieces added to ${acc.additions.lots} customer plate(s), ${acc.lots} new plate(s)`, acc.additions.pieces === plan.rest.onExisting && acc.additions.lots === plan.additions.length && acc.lots === plan.totals.plates && acc.keptImportedLots === 3, J(acc.additions));
    ok('the customer\'s placements did not move by a micron', J(await theirs()) === customerBefore);
    const state = await U.getNestFiles(conn, COMPANY, fx.lineId);
    ok('every piece of the line is covered exactly once (the hand-held pieces are the only ones left)', state.coverage.filter((x) => !x.manual).every((x) => x.diff === 0) && state.leftOver.length === 1 && state.leftOver[0].manual === true && state.totals.pieces === pieceTotal - need.M, J(state.leftOver));
    ok('each plate says what the customer nested and what we added', state.totals.piecesAddedByUs === plan.rest.onExisting && state.plates.filter((p) => p.origin === 'imported' && p.ourPieces > 0).length === plan.additions.length && state.plates.filter((p) => p.origin === 'imported').every((p) => p.customerPieces === part.find((f) => f.filename === p.file.filename).parts.length));
    const view = await N.getNesting(conn, COMPANY, fx.lineId);
    const nests = view.groups.flatMap((g) => g.nests);
    let bad = 0;
    for (const n of nests) bad += S.verifyPlate({ length: n.length, width: n.width, kerf: 3, margin: 3, placements: n.pieces.map((p, i) => ({ key: i, rings: p.rings ?? S.ringsObject(ringsOfPiece(p)) })), tolerance: 0.005 }).problems.length;
    ok(`every plate is a legal layout on the true outlines (${nests.length} plates, kerf 3)`, bad === 0 && nests.length === 3 + acc.lots);
    ok('…and adds up: parts + waste by cause = the plate', identityGap(nests) <= 1, String(identityGap(nests)));
    const added = nests.find((n) => n.pieces.some((p) => p.placedBy === 'ours') && n.layoutOrigin === 'customer');
    ok('the screen can tell them apart on the plate: placedBy customer / ours, each with its turn', !!added && added.pieces.some((p) => p.placedBy === 'customer') && added.pieces.filter((p) => p.placedBy === 'ours').every((p) => Number.isFinite(p.rotationDeg)));
    if (DOC) doc.getNesting = { response: { ...view, groups: view.groups.slice(0, 1).map((g) => ({ ...g, cutPlates: g.cutPlates.slice(0, 1), nests: [added].map((n) => ({ ...n, pieces: [n.pieces.find((p) => p.placedBy === 'customer' && p.rings), n.pieces.find((p) => p.placedBy === 'customer' && !p.rings), n.pieces.find((p) => p.placedBy === 'ours')].filter(Boolean), offcuts: n.offcuts.slice(0, 1) })) })), coverage: view.coverage.slice(0, 2) } };
    const again = await N.planNesting(conn, COMPANY, fx.lineId, { effort: 'quick', seed: 1 });
    ok('nesting the rest again asks for the same 13 pieces (what we added is ours to place again, not the customer\'s)', again.rest.onExisting + again.rest.onNew + again.rest.unplaced === 13 && again.imported.pieces === 24);

    if (want(6)) {
      section('6. Re-upload one changed file after "nest the rest" added parts to that plate — our additions are dropped and said, the rest untouched');
      const target = state.plates.find((p) => p.origin === 'imported' && p.ourPieces > 0);
      const src = part.find((f) => f.filename === target.file.filename);
      const items = src.parts.map((p) => [p.sfx, p.rotationDeg ?? 0, !!p.mirrored]);
      const changed = F.nestFile(src.filename, PS, F.rows(fx, items, PS, { gap: 31 }), { style: src.style });
      const othersBefore = J((await conn.query('SELECT p.id FROM cf_plate_lots l JOIN cf_nest_placements p ON p.plate_lot_id = l.id AND p.deleted_at IS NULL WHERE l.order_line_id = ? AND l.deleted_at IS NULL AND l.id <> ? ORDER BY p.id', [fx.lineId, target.lotId]))[0]);
      const dry = await upload(fx, [changed]);
      const rep = dry.diff.replaced[0];
      ok('the diff says 1 replaced: same parts, moved', dry.diff.replaced.length === 1 && dry.diff.added.length === 0 && dry.diff.removed.length === 0 && rep.lotNo === target.lotNo && rep.parts.length === 0 && rep.moved > 0, J(rep));
      ok(`our ${target.ourPieces} additions on it are dropped, and reported`, sum(rep.droppedOurs, (x) => x.qty) === target.ourPieces && dry.diff.droppedOurs.some((d) => d.lotNo === target.lotNo && sum(d.parts, (x) => x.qty) === target.ourPieces), J(dry.diff.droppedOurs));
      ok('…and they are back in the left-over list', sum(dry.leftOver.filter((x) => !x.manual), (x) => x.qty) === target.ourPieces, J(dry.leftOver));
      if (DOC) doc.reuploadDiff = { diff: dry.diff, leftOver: dry.leftOver };
      const done = await upload(fx, [changed], { dryRun: false });
      const now = await U.getNestFiles(conn, COMPANY, fx.lineId);
      const plate = now.plates.find((p) => p.lotNo === target.lotNo);
      ok('saved: the plate holds the customer\'s parts only, as the new file draws them', done.applied && plate.ourPieces === 0 && plate.customerPieces === src.parts.length && plate.file.hash === done.files[0].hash);
      ok('the rest of the nesting is untouched (the same rows)', J((await conn.query('SELECT p.id FROM cf_plate_lots l JOIN cf_nest_placements p ON p.plate_lot_id = l.id AND p.deleted_at IS NULL WHERE l.order_line_id = ? AND l.deleted_at IS NULL AND l.lot_no <> ? ORDER BY p.id', [fx.lineId, target.lotNo]))[0]) === othersBefore);
      // An upload that makes an AUTOMATIC plate's pieces surplus: the plate is named, and dropped only by the save.
      const autoLot = (await liveLots(fx)).find((l) => l.origin === 'auto');
      const onAuto = (await conn.query('SELECT cut_plate_id, COUNT(*) n FROM cf_nest_placements WHERE plate_lot_id = ? AND deleted_at IS NULL GROUP BY cut_plate_id ORDER BY n DESC', [autoLot.id]))[0];
      const sfx = fx.sfxOfCut(onAuto[0].cut_plate_id);
      // …every piece of it the line needs, so what the automatic plate holds of it is now surplus.
      const dup = F.nestFile(`${fx.tag}-Z1_${F.T}mm_3000x1500.dxf`, PS, F.rows(fx, Array.from({ length: need[sfx] }, () => [sfx]), PS));
      const dz = await upload(fx, [dup]);
      ok(`a file that nests a piece an automatic plate already holds: that plate (${autoLot.lot_no}) is reported, to be dropped by the save`, dz.diff.droppedAuto.length >= 1 && dz.diff.droppedAuto.some((d) => d.lotNo === autoLot.lot_no && d.because.includes(fx.code(sfx))) && dz.needsForce === false && (await liveLots(fx)).some((l) => l.id === autoLot.id), J(dz.diff.droppedAuto));
      const dzs = await upload(fx, [dup], { dryRun: false });
      ok('…and the save drops it — never silently, never before', dzs.applied && !(await liveLots(fx)).some((l) => l.id === autoLot.id) && dzs.leftOver.length >= 1);
    }
  }

  /* ───────────── 11. drawings in automatic nesting ───────────── */
  if (want(11)) {
    section('11. The true-shape packer on every steel — never worse than rows, legal on the outlines, coverage exact, with and without drawings');
    await clearLine(fx);
    const input = { effort: 'quick', seed: 1 };
    const withDrawings = await N.planNesting(conn, COMPANY, fx.lineId, input);
    await F.removeDrawings(conn, fx);
    const without = await N.planNesting(conn, COMPANY, fx.lineId, input);
    /*
     * SINCE 2026-10-10 EVERY STEEL GOES THROUGH THE TRUE-SHAPE PACKER, drawings or not, so a line
     * with no drawings no longer gives the row packer's plan to the byte. What is promised instead:
     * never worse than the row packer (plates, then steel), every plate legal on its outlines,
     * every piece the line needs placed exactly once. The row packer itself is still there
     * (`shapes: false`) and still gives the plan it always gave — the golden snapshot, less the
     * `budget` block (the budgets changed, the layout did not).
     */
    const rowsOnly = await N.planNesting(conn, COMPANY, fx.lineId, { ...input, shapes: false });
    // NEST_V2_GOLDEN=write regenerates the snapshot — ONLY for a deliberate change of the row packer's input
    // (last: 2026-10-10, one kerf at the plate edge instead of two). Say so in HANDOFF.md when you do.
    if (process.env.NEST_V2_GOLDEN === 'write') fs.writeFileSync(path.join(BE, 'scripts/cf_kepl/golden/nest_v2_plan_golden.json'), `${JSON.stringify(F.normalisePlan(rowsOnly, fx), null, 1)}
`);
    const golden = JSON.parse(fs.readFileSync(path.join(BE, 'scripts/cf_kepl/golden/nest_v2_plan_golden.json'), 'utf8'));
    const noBudget = (plan) => { const q = JSON.parse(JSON.stringify(plan)); delete q.budget; return JSON.stringify(q); };
    ok('the row packer alone (shapes: false) still lays the line out exactly as the golden snapshot has it', noBudget(F.normalisePlan(rowsOnly, fx)) === noBudget(golden));
    ok(`no drawings, the new packer: never worse than the row packer — ${without.totals.plates} plates / ${(without.totals.areaBought / 1e6).toFixed(3)} m² against ${rowsOnly.totals.plates} / ${(rowsOnly.totals.areaBought / 1e6).toFixed(3)}`,
      without.totals.unplaced === 0 && (without.totals.plates < rowsOnly.totals.plates || (without.totals.plates === rowsOnly.totals.plates && without.totals.areaBought <= rowsOnly.totals.areaBought + 1e-6)) && without.totals.wastePct <= rowsOnly.totals.wastePct + 1e-6);
    let illegal = 0;
    for (const n of without.groups.flatMap((g) => g.nests)) illegal += S.verifyPlate({ length: n.length, width: n.width, kerf: 3, margin: 3, placements: n.pieces.map((q, i) => ({ key: i, rings: q.rings ?? S.ringsObject(ringsOfPiece(q)) })), tolerance: 0.005 }).problems.length;
    ok('…every plate is legal on its outlines: no overlap, a kerf between parts, a kerf at the edge', illegal === 0, String(illegal));
    const placedBy = new Map();
    for (const q of without.groups.flatMap((g) => g.nests).flatMap((n) => n.pieces)) placedBy.set(q.cutPlateId, (placedBy.get(q.cutPlateId) ?? 0) + 1);
    ok('…coverage is exact: every piece the line needs from automatic nesting is placed once, the hand-held ones not at all', Object.entries(fx.cut).every(([sfx, id]) => (placedBy.get(id) ?? 0) === (fx.parts[sfx].manual ? 0 : need[sfx])), J([...placedBy]));
    ok('ONE RULE for which layout a plate keeps: a steel says "shape" (its plates are free layouts, no rows) or "rectangles" (the row layout was not beaten: rows and sequences stay)',
      without.groups.filter((g) => g.nests.length).every((g) => (g.shapes.taken === 'shape' ? g.nests.every((n) => n.layout === 'free' && n.sequences.length === 0) : g.shapes.taken === 'rectangles' && g.nests.every((n) => n.layout === undefined && n.sequences.length > 0))), J(without.groups.map((g) => [g.shapes?.taken, g.nests.map((n) => n.layout ?? 'rows')])));
    ok('a free layout numbers its pieces in cut order: along the plate, by x then y', without.groups.flatMap((g) => g.nests).filter((n) => n.layout === 'free').every((n) => n.pieces.every((q, i) => q.posNo === i + 1 && (i === 0 || q.x > n.pieces[i - 1].x - 1e-9 || (Math.abs(q.x - n.pieces[i - 1].x) < 1e-9 && q.y >= n.pieces[i - 1].y)))));
    await F.addDrawings(conn, fx);
    const taken = withDrawings.groups.map((g) => g.shapes?.taken ?? 'rectangles (no drawing in this steel)');
    console.log(`    with drawings: ${withDrawings.totals.plates} plates, ${(withDrawings.totals.areaBought / 1e6).toFixed(3)} m² — ${taken.join(' / ')}; without: ${without.totals.plates} plates, ${(without.totals.areaBought / 1e6).toFixed(3)} m²`);
    ok('with drawings: no more plates, no more steel bought, nothing left off', withDrawings.totals.plates <= without.totals.plates && withDrawings.totals.areaBought <= without.totals.areaBought + 1e-6 && withDrawings.totals.unplaced === 0 && withDrawings.totals.pieces === without.totals.pieces);
    ok('…so, measured on the same true parts, no more waste', withDrawings.totals.weightKg <= without.totals.weightKg + 1e-6 && withDrawings.totals.partsKg < without.totals.partsKg);
    const gA = withDrawings.groups.find((g) => g.shapes);
    ok('the steel with drawings in it was a shape job, and says which layout it took', !!gA && ['shape', 'rectangles'].includes(gA.shapes.taken) && gA.shapes.drawings === 5 && gA.shapes.rectangles.plates >= gA.nests.length, J(gA?.shapes));
    const drawnPiece = withDrawings.groups.flatMap((g) => g.nests).flatMap((n) => n.pieces).find((p) => p.cutPlateId === fx.cut.G);
    ok('a drawn part carries its true steel and its outline on the plate', drawnPiece.area < 520 * 320 && drawnPiece.rings?.outline?.length === 4 && Number.isFinite(drawnPiece.rotationDeg), J(drawnPiece));
    let bad = 0;
    for (const n of withDrawings.groups.flatMap((g) => g.nests)) bad += S.verifyPlate({ length: n.length, width: n.width, kerf: 3, margin: 3, placements: n.pieces.map((p, i) => ({ key: i, rings: p.rings ?? S.ringsObject(ringsOfPiece(p)) })), tolerance: 0.005 }).problems.length;
    ok('no overlap, nothing nearer than the kerf, on the true shapes', bad === 0);
    ok('…and each plate adds up on the true shapes', identityGap(withDrawings.groups.flatMap((g) => g.nests)) <= 1);
    // THE RIM IS ONE RULE (nestShapes.rimOf): the plates laid by true shape and the plates laid in
    // rows (the same line without its drawings) start the same distance in from the plate edge.
    const rimOfPlan = (plan) => Math.min(...plan.groups.flatMap((g) => g.nests).flatMap((n) => n.pieces.map((q) => Math.min(q.x, q.y, n.length - q.x - q.length, n.width - q.y - q.width))));
    const want = S.rimOf(3).clearance;
    ok(`the rim is one rule: ${want} mm at the plate edge on the true-shape plates and on the row plates alike`, withDrawings.groups.some((g) => g.shapes?.taken === 'shape') && Math.abs(rimOfPlan(withDrawings) - want) < 1e-6 && Math.abs(rimOfPlan(without) - want) < 1e-6, J([rimOfPlan(withDrawings), rimOfPlan(without), want]));
    const acc = await N.acceptNesting(conn, c, fx.lineId, withDrawings);
    ok('the plan is accepted as proposed', acc.lots === withDrawings.totals.plates && acc.pieces === withDrawings.totals.pieces);
    const saved = await N.getNesting(conn, COMPANY, fx.lineId);
    ok('the saved plan reads back with the same steel bought and the same true parts', Math.abs(saved.totals.areaBought - withDrawings.totals.areaBought) < 1e-3 && Math.abs(saved.totals.partsKg - withDrawings.totals.partsKg) < 0.01 && saved.drift.filter((d) => !d.manual).length === 0, J([saved.totals.partsKg, withDrawings.totals.partsKg]));

    // A FREE layout, made by hand from that plan: two gussets taken onto a plate of their own, one
    // of them turned 30° and flipped.
    const flat = JSON.parse(JSON.stringify(withDrawings));
    const allNests = flat.groups.find((g) => g.shapes).nests;
    const take = () => { const from = allNests.find((n) => n.pieces.filter((p) => p.cutPlateId === fx.cut.G).length && n.pieces.length > 1); return from.pieces.splice(from.pieces.findIndex((p) => p.cutPlateId === fx.cut.G), 1)[0]; };
    const g1 = Object.assign(take(), { x: 100, y: 100, rotationDeg: 30, mirrored: true, rotated: false, rings: undefined });
    const g2 = Object.assign(take(), { x: 1000, y: 100, rotationDeg: 0, mirrored: false, rotated: false, rings: undefined });
    allNests.push({ ...JSON.parse(JSON.stringify(allNests[0])), lotNo: 'N-099', layout: 'free', offcuts: [], pieces: [g1, g2] });
    const accFree = await N.acceptNesting(conn, c, fx.lineId, flat);
    const [[row]] = await conn.query("SELECT p.rotation_deg, p.mirrored, p.rotated, p.area_mm2, l.source_kind FROM cf_nest_placements p JOIN cf_plate_lots l ON l.id = p.plate_lot_id WHERE l.order_line_id = ? AND l.deleted_at IS NULL AND p.deleted_at IS NULL AND p.cut_plate_id = ? AND p.rotation_deg = 30", [fx.lineId, fx.cut.G]);
    ok('a part at a free angle, flipped, is accepted and stored as that (rotation 30, mirrored, rotated 0, its true area) on a free-layout plate', accFree.lots === acc.lots + 1 && !!row && Number(row.mirrored) === 1 && Number(row.rotated) === 0 && Number(row.area_mm2) < 520 * 320 && row.source_kind === 'shape', J(row));
    const back = await N.getNesting(conn, COMPANY, fx.lineId);
    const freeNest = back.groups.flatMap((g) => g.nests).find((n) => n.layout === 'free' && n.pieces.some((p) => p.rotationDeg === 30));
    ok('the saved plan shows it: layout free, a rule badge that does not hold it to rows, the outline at 30°', !!freeNest && freeNest.rules.status === 'ok' && freeNest.rules.checks[0].key === 'freeLayout' && freeNest.pieces.some((p) => p.rotationDeg === 30 && p.mirrored && p.rings));
    const clash = JSON.parse(JSON.stringify(flat));
    const h2 = clash.groups.flatMap((g) => g.nests).find((n) => n.lotNo === 'N-099');
    const other = h2.pieces.find((p) => p !== h2.pieces.find((q) => q.rotationDeg === 30));
    Object.assign(h2.pieces.find((q) => q.rotationDeg === 30), { x: other.x + 5, y: other.y + 5 });
    let refused = null; try { await N.acceptNesting(conn, c, fx.lineId, clash); } catch (e) { refused = e; }
    ok('…and the same part dropped onto another is refused in words (overlap, on the outlines)', refused?.code === 'INVALID' && refused.problems.some((p) => /overlap/.test(p) && p.includes(fx.code('G'))), J(refused?.problems ?? refused?.message));
  }

  /* ───────────── 7–9. compare ───────────── */
  if (want(7) || want(8) || want(9)) {
    section('7. Compare with NO automatic run: one is started, polled to ready, both sides measured');
    await clearLine(fx);
    await upload(fx, sets.B, { dryRun: false });
    const none = await C.getCompare(conn, COMPANY, fx.lineId, { with: 'auto' });
    ok('before any run: the uploaded side is measured, the automatic side says there is none', !!none.uploaded && none.uploaded.metrics.plates === 5 && none.auto.status === 'none' && none.auto.metrics === null && /No automatic run/.test(none.auto.reason) && none.delta === null && none.canAccept.auto === false, J(none.auto));
    const { started, view } = await runCompare(fx);
    ok('POST { run: true } starts one and returns its id', started.started === true && started.status === 'running' && typeof started.runId === 'string' && started.jobs.join() === 'subset,line', J(started));
    ok('polled to ready: the automatic side is there, from that run', view?.auto?.status === 'ready' && view.auto.runId === started.runId && !!view.auto.ranAt && view.auto.params.effort === 'quick', J(view?.auto?.reason ?? view?.lastFailure));
    const flat = (m) => [m.plates, m.pieces, m.tonnesBought, m.partsTonnes, m.wastePct, m.wasteKgTotal, ...Object.values(m.wasteKg), m.offcuts.count, m.offcuts.kg, m.offcuts.largestKg, m.cutLengthM, m.piercings, m.cost.value];
    ok('every metric on both sides is a number (none null)', flat(view.uploaded.metrics).every((v) => typeof v === 'number' && Number.isFinite(v)) && flat(view.auto.metrics).every((v) => typeof v === 'number' && Number.isFinite(v)), J([view.uploaded.metrics, view.auto.metrics]));
    ok(`like for like: both sides hold the same ${view.likeForLike.uploadedPieces} pieces, cut plate by cut plate`, view.likeForLike.same === true && view.likeForLike.uploadedPieces === pieceTotal && view.likeForLike.autoPieces === pieceTotal && view.auto.unplaced.length === 0 && Math.abs(view.auto.metrics.partsTonnes - view.uploaded.metrics.partsTonnes) < 1e-3, J(view.likeForLike));
    ok(`the delta is automatic − uploaded, and the verdict is a sentence ("${view.verdict}")`, view.delta.plates === view.auto.metrics.plates - view.uploaded.metrics.plates && Math.abs(view.delta.tonnesBought - (view.auto.metrics.tonnesBought - view.uploaded.metrics.tonnesBought)) < 1e-3 && typeof view.verdict === 'string' && view.verdict.length > 20);
    ok('per plate on both sides', view.uploaded.perPlate.length === 5 && view.auto.perPlate.length === view.auto.metrics.plates && view.auto.perPlate.every((p) => p.plateKg > 0 && p.cost > 0));
    ok('the whole line, as a second figure: saved against automatic (the hand-held pieces are not in ours)', view.wholeLine.saved.metrics.pieces === pieceTotal && view.wholeLine.auto.metrics.pieces === pieceTotal - need.M && view.demand.coversWholeLine === false, J([view.wholeLine.auto.metrics?.pieces, view.demand]));
    if (DOC) doc.compare = { response: { ...view, uploaded: { ...view.uploaded, perPlate: view.uploaded.perPlate.slice(0, 2) }, auto: { ...view.auto, perPlate: view.auto.perPlate.slice(0, 2) }, wholeLine: { saved: { ...view.wholeLine.saved, perPlate: undefined }, auto: { ...view.wholeLine.auto, perPlate: undefined } }, coverage: view.coverage.slice(0, 2) } };
    ok(`willReplace says, in numbers, what taking the automatic side replaces ("${view.willReplace?.message}")`, view.willReplace?.side === 'auto' && view.willReplace.customerPlates === 5 && view.willReplace.ourPlates === 0 && view.willReplace.plates === 5
      && view.willReplace.customerPieces === pieceTotal && view.willReplace.ourPieces === 0 && view.willReplace.customerFiles === 5
      && view.willReplace.withPlates === view.wholeLine.auto.metrics.plates && view.willReplace.withPieces === pieceTotal - need.M && view.willReplace.notNestedAfter === need.M
      && /5 uploaded plates/.test(view.willReplace.message) && /In their place/.test(view.willReplace.message), J(view.willReplace));
    ok('…and before any run it already counts what is saved (what would come in its place is not known yet)', none.willReplace?.customerPlates === 5 && none.willReplace.withPlates === null && /not worked out yet/.test(none.willReplace.message), J(none.willReplace));
    if (DOC) doc.compareStart = { request: { run: true, effort: 'quick' }, response: { ...started, run: { ...started.run, log: started.run.log.slice(0, 1) } } };

    if (want(8) || want(9)) {
      section('8. Compare with an automatic run ALREADY there: it is pulled up, nothing is packed');
      let packs = 0;
      const spy = async () => { packs += 1; return { nests: [], unplaced: [] }; };
      const again = await C.startCompare(conn, c, fx.lineId, { run: true, effort: 'quick', pack: spy });
      await R.settleRuns();
      ok('POST { run: true } starts nothing: same run id, the packer never called', again.started === false && again.runId === started.runId && packs === 0 && R.memoryRun(COMPANY, fx.lineId)?.id === started.runId, J(again));
      const pulled = await C.getCompare(conn, COMPANY, fx.lineId, {});
      ok('the GET shows that run again, with the same figures', pulled.auto.runId === started.runId && J(pulled.auto.metrics) === J(view.auto.metrics));
      const [[runRows]] = await conn.query('SELECT COUNT(*) n FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ?', [COMPANY, fx.lineId]);
      ok('one run, two rows (the pieces the files cover, and the whole line)', Number(runRows.n) === 2);
      // The demand changes: the kerf for this thickness.
      await conn.query('UPDATE cf_cut_settings SET kerf_mm = 4 WHERE company_id = ? AND thickness_min_mm = ? AND thickness_max_mm = ?', [COMPANY, F.T, F.T]);
      const stale = await C.getCompare(conn, COMPANY, fx.lineId, {});
      ok('after the demand changes (another kerf) the run is reported STALE, not shown as current', stale.auto.status === 'stale' && stale.auto.metrics === null && stale.stale?.runId === started.runId && /different demand/.test(stale.stale.reason) && stale.demand.hash !== view.demand.hash, J([stale.auto, stale.stale]));
      let staleAccept = null; try { await C.acceptCompare(conn, c, fx.lineId, { side: 'auto', runId: started.runId }); } catch (e) { staleAccept = e; }
      ok('…and cannot be accepted', staleAccept?.code === 'STALE_RUN', staleAccept?.message);
      await conn.query('UPDATE cf_cut_settings SET kerf_mm = 3 WHERE company_id = ? AND thickness_min_mm = ? AND thickness_max_mm = ?', [COMPANY, F.T, F.T]);
      ok('the kerf put back, the same run answers again', (await C.getCompare(conn, COMPANY, fx.lineId, {})).auto.runId === started.runId);
    }

    if (want(9)) {
      section('9. Accept uploaded / accept automatic — the other side is discarded, everything derived follows');
      const lotsBefore = (await liveLots(fx)).map((l) => l.id).join();
      const keep = await C.acceptCompare(conn, c, fx.lineId, { side: 'uploaded', runId: started.runId });
      if (DOC) doc.acceptUploaded = { request: { side: 'uploaded', runId: started.runId }, response: keep };
      const [st1] = await conn.query('SELECT kind, scope, status FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? ORDER BY id', [COMPANY, fx.lineId]);
      ok('accept uploaded: the saved plates are untouched, the run is discarded, the uploaded side recorded as taken', keep.decision === 'uploaded' && (await liveLots(fx)).map((l) => l.id).join() === lotsBefore
        && st1.filter((r) => r.kind === 'auto').every((r) => r.status === 'discarded') && st1.some((r) => r.kind === 'upload' && r.status === 'accepted'), J(st1));
      let twice = null; try { await C.acceptCompare(conn, c, fx.lineId, { side: 'auto', runId: started.runId }); } catch (e) { twice = e; }
      ok('a second accept is refused cleanly', twice?.code === 'ALREADY_DECIDED' && twice.status === 422 && /already decided/.test(twice.message), twice?.message);
      const after = await C.getCompare(conn, COMPANY, fx.lineId, {});
      ok('the comparison now reads as decided', after.auto.decision === 'uploaded' && after.canAccept.auto === false && /Already decided/.test(after.canAccept.reason));

      const second = await runCompare(fx, { rerun: true });
      ok('compare again (rerun): a NEW run, ready', second.started.started === true && second.started.runId !== started.runId && second.view.auto.status === 'ready' && second.view.auto.runId === second.started.runId && second.view.canAccept.auto === true, J(second.view?.canAccept));
      const fileIds = (await liveLots(fx)).map((l) => l.nest_file_id);
      const took = await C.acceptCompare(conn, c, fx.lineId, { side: 'auto', runId: second.started.runId });
      if (DOC) doc.acceptAuto = { request: { side: 'auto', runId: second.started.runId }, response: { ...took, accepted: { ...took.accepted, quantities: took.accepted.quantities.slice(0, 1) } } };
      const lots = await liveLots(fx);
      ok(`accept automatic: the ${fileIds.length} uploaded plates are replaced by our ${lots.length}`, took.decision === 'auto' && lots.length === second.view.wholeLine.auto.metrics.plates && lots.every((l) => l.origin === 'auto' && l.layout_origin === 'ours' && [null, 'shape'].includes(l.source_kind)), J(lots.map((l) => [l.lot_no, l.origin])));
      ok('…and the answer says what went, in the same numbers the comparison promised', took.replaced.uploadedPlates === 5 && took.replaced.customerPlates === 5 && took.replaced.ourPlates === 0 && took.replaced.removedPlates === 5 && took.replaced.customerPieces === pieceTotal
        && took.replaced.customerFiles === 5 && took.replaced.withPlates === lots.length && took.replaced.withPieces === took.accepted.pieces, J(took.replaced));
      ok('…their files are gone, the hand-held pieces are left over (they are never in an automatic plan)', Number((await conn.query('SELECT COUNT(*) n FROM cf_nest_files WHERE id IN (?) AND deleted_at IS NULL', [fileIds]))[0][0].n) === 0
        && took.leftOver.length === 1 && took.leftOver[0].cutPlateCode === fx.code('M') && took.leftOver[0].manual === true, J(took.leftOver));
      const q = took.accepted.quantities.find((x) => x.cutPlateId === fx.cut.G);
      ok('…the plate quantities, offcuts and cut lengths follow the new plates', (await bomQty(fx.plateLine.G)).quantity === q.quantity && took.accepted.cuts.nested === Object.keys(fx.cut).length - 1 && (await liveCount('cf_offcuts', fx)) === took.accepted.offcuts);
      const [st2] = await conn.query('SELECT kind, status FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? AND run_uid = ? ORDER BY id', [COMPANY, fx.lineId, second.started.runId]);
      ok('…the run is accepted, the uploaded nesting kept as the discarded side (its plates and positions)', st2.filter((r) => r.kind === 'auto').every((r) => r.status === 'accepted') && st2.some((r) => r.kind === 'upload' && r.status === 'discarded'), J(st2));
      let twice2 = null; try { await C.acceptCompare(conn, c, fx.lineId, { side: 'uploaded', runId: second.started.runId }); } catch (e) { twice2 = e; }
      ok('a second accept is refused cleanly', twice2?.code === 'ALREADY_DECIDED');
      const gone = await C.getCompare(conn, COMPANY, fx.lineId, {});
      ok('with nothing uploaded any more the comparison says so', gone.uploaded === null && /Nothing is uploaded/.test(gone.auto.reason ?? gone.canAccept.reason ?? ''), J([gone.auto.reason, gone.canAccept]));
      let bad = null; try { await C.acceptCompare(conn, c, fx.lineId, { side: 'sideways', runId: 'x' }); } catch (e) { bad = e; }
      ok('a side that is not a side is refused in words', bad?.code === 'INVALID');
    }
  }

  /* ───────────── 10. runs survive a restart ───────────── */
  if (want(10)) {
    section('10. A finished run survives a restart; an interrupted one reads as failed');
    await clearLine(fx);
    await R._forgetMemory();
    const first = R.startRun(COMPANY, c, fx.lineId, { effort: 'quick', seed: 1 }, { db: conn });
    ok('a nesting run starts at once', first.status === 'running' && first.purpose === 'nest');
    let busy = null; try { await C.startCompare(conn, c, fx.lineId, { run: true }); } catch (e) { busy = e; }
    ok('one run per line: a comparison is refused while it works (or there is nothing uploaded)', ['RUN_BUSY', 'NOTHING_UPLOADED'].includes(busy?.code), busy?.message);
    let now = first;
    for (let i = 0; i < 900 && now.status === 'running'; i += 1) { await wait(200); now = R.currentRun(COMPANY, fx.lineId); }
    await R.settleRuns();
    ok('it finishes', now.status === 'done', J(now.error));
    const [[row]] = await conn.query('SELECT status, demand_hash, plan_encoding, (plan_json IS NOT NULL) has_plan, metrics_json FROM cf_nest_runs WHERE company_id = ? AND run_uid = ?', [COMPANY, first.runId]);
    ok('its row is ready, with the proposal, its figures and the fingerprint of what it was asked', row?.status === 'ready' && Number(row.has_plan) === 1 && row.demand_hash?.length === 64 && JSON.parse(row.metrics_json).plates === now.summary.plates, J(row));
    const inMemory = R.currentRun(COMPANY, fx.lineId, { withPlan: true });
    await R._forgetMemory();                                    // "the server restarted"
    ok('after the restart nothing is in memory', R.currentRun(COMPANY, fx.lineId).status === 'none');
    const back = await R.readRun(COMPANY, fx.lineId, { withPlan: true, db: conn });
    ok('…and the run reads back from the database: done, the same proposal', back.status === 'done' && back.restored === true && back.runId === first.runId && back.summary.plates === inMemory.summary.plates && J(back.plan.totals) === J(inMemory.plan.totals) && back.plan.groups.length === inMemory.plan.groups.length, J([back.status, back.summary]));
    if (DOC) doc.runRestored = { response: { ...back, plan: '… the proposal, as POST …/nesting/plan …', log: back.log.slice(0, 2) } };
    const acc = await N.acceptNesting(conn, c, fx.lineId, back.plan);
    ok('…and can still be accepted', acc.lots === back.summary.plates);
    R.dismissRun(COMPANY, fx.lineId, { accepted: true, db: conn });
    await R.settleRuns();
    ok('accepted: off the poll, but the row stays ready (a later comparison can pull it up)', (await R.readRun(COMPANY, fx.lineId, { db: conn })).status === 'none'
      && (await conn.query('SELECT status, dismissed_at FROM cf_nest_runs WHERE company_id = ? AND run_uid = ?', [COMPANY, first.runId]))[0][0].status === 'ready');

    await conn.query("INSERT INTO cf_nest_runs (company_id, order_line_id, run_uid, kind, scope, purpose, status, params_json, started_at) VALUES (?, ?, '00000000-dead-4000-8000-000000000001', 'auto', 'rest', 'nest', 'running', '{\"effort\":\"standard\"}', NOW(3))", [COMPANY, fx.lineId]);
    const cut = await R.readRun(COMPANY, fx.lineId, { db: conn });
    ok('a run the restart cut off reads as FAILED, with the reason', cut.status === 'failed' && cut.error?.code === 'INTERRUPTED' && /restarted/.test(cut.error.message) && cut.restored === true, J(cut));
    ok('…and its row is marked failed', (await conn.query("SELECT status FROM cf_nest_runs WHERE run_uid = '00000000-dead-4000-8000-000000000001'"))[0][0].status === 'failed');
    R.dismissRun(COMPANY, fx.lineId, { db: conn });
    await R.settleRuns();
    ok('dismissed, it is gone', (await R.readRun(COMPANY, fx.lineId, { db: conn })).status === 'none');
    await clearLine(fx);
  }

  /* ───────────── 12. round trips ───────────── */
  if (want(12)) {
    section('12. Round trips do not grow with parts or plates (measured at two sizes)');
    await clearLine(fx);
    // Two FRESH lines, so nothing an earlier scenario left behind (a value already written, a run already kept) is in the count.
    const small = await F.buildFixture(conn, { company: COMPANY });
    const smallSets = F.nestings(small);
    const big = await F.buildFixture(conn, { company: COMPANY, scale: 2 });
    const bigSets = F.nestings(big);
    const trips = {};
    for (const [label, f, files] of [['small', small, smallSets.B], ['large', big, bigSets.B]]) {
      const t = {};
      let k = counting(conn);
      const dry = await U.uploadNestFiles(k.db, c, f.lineId, { files: asRequest(f, files) });
      t.dryRun = k.tally.n;
      k = counting(conn);
      const saved = await U.uploadNestFiles(k.db, c, f.lineId, { files: asRequest(f, files), dryRun: false });
      t.save = k.tally.n;
      if (!saved.applied) console.log('    not saved (' + label + '):', saved.message, J(saved.problems.slice(0, 3)), J(saved.warnings.slice(0, 2)));
      k = counting(conn);
      await C.getCompare(k.db, COMPANY, f.lineId, {});
      t.compare = k.tally.n;
      k = counting(conn);
      await U.getNestFiles(k.db, COMPANY, f.lineId);
      t.files = k.tally.n;
      const lot = (await liveLots(f))[0];
      k = counting(conn);
      await U.deleteNestLot(k.db, c, f.lineId, lot.id);
      t.delete = k.tally.n;
      trips[label] = { ...t, plates: files.length, parts: sum(dry.files, (x) => x.parts), ok: saved.applied && dry.problems.length === 0 };
    }
    console.log(`    small ${J(trips.small)}\n    large ${J(trips.large)}`);
    ok('both sizes upload clean (the large one is twice the plates and the parts)', trips.small.ok && trips.large.ok && trips.large.plates === 2 * trips.small.plates && trips.large.parts === 2 * trips.small.parts);
    for (const key of ['dryRun', 'save', 'compare', 'files', 'delete']) ok(`${key}: ${trips.small[key]} round trips at either size`, trips.small[key] === trips.large[key] && trips.small[key] > 0, `${trips.small[key]} vs ${trips.large[key]}`);
    doc.trips = trips;
  }

  /* ───────────── 14–18. common cuts, the plate edge, scrap, the customer's own outline, one writer ───────────── */
  if (want(14)) {
    section('14. Common cuts: a block of equal parts cut edge to edge is read cell by cell, and its cut length is the outlines\' less the shared cuts');
    await clearLine(fx);
    const PS = { length: 3000, width: 1500 };
    const name = (sfx) => `${fx.tag}-${sfx}_${F.T}mm_3000x1500.dxf`;
    // 2 × 2 of the 1200 × 400 rectangle, the two cuts crossing in the middle; the fifth stands clear.
    const grid = D.gridParts({ shape: fx.parts.R.shape, cols: 2, rows: 2, x: 100, y: 100, label: fx.code('R') }).map((q) => ({ ...q, sfx: 'R' }));
    const f = F.nestFile(name('CC1'), PS, [...grid, F.place(fx, 'R', 100, 1000)], { style: 'commoncut-grid' });
    const out = await upload(fx, [f], { dryRun: false });
    const e = out.files[0];
    ok('a 2 × 2 common-cut block + one free part: five parts, all of them the rectangle, saved clean', out.applied === true && out.problems.length === 0 && out.warnings.length === 0 && e.parts === 5 && e.placed === 5 && e.counts.length === 1 && e.counts[0].cutPlateId === fx.cut.R && e.counts[0].qty === 5, J([out.problems, out.warnings, e.counts, e.notes]));
    ok('…the touching cells are said to be common cuts, not parts too close', e.notes.some((n) => /common cut/.test(n)) && !out.warningList.some((w) => w.code === 'TOO_CLOSE'), J(e.notes));
    ok('…and each cell is stored where it was drawn', ['100,100', '1300,100', '100,500', '1300,500', '100,1000'].every((at) => e.placements.some((q) => `${q.x},${q.y}` === at)), J(e.placements.map((q) => [q.x, q.y])));
    // Each cell of the block shares one long side (1200) and one short side (400) with a neighbour:
    // 2 × (1200 + 400) − (1200 + 400) / 2 = 2400. The free one is 3200. Mean of the five: 2560.
    const cut = await valueOf(fx.cut.R, 'CUT_LENGTH');
    ok(`CUT_LENGTH of the rectangle is the outlines less the shared cuts: ${cut} (2560 = four at 2400 and one at 3200)`, Math.abs(cut - 2560) < 0.01 && out.saved.cuts.shared === 3200, J([cut, out.saved.cuts]));
    const cmp = await C.getCompare(conn, COMPANY, fx.lineId, {});
    ok('…and the comparison quotes the same cut for the uploaded side: 12.8 m, 3.2 m of it shared', Math.abs(cmp.uploaded.metrics.cutLengthM - 12.8) < 1e-6 && Math.abs(cmp.uploaded.metrics.sharedCutM - 3.2) < 1e-6, J(cmp.uploaded.metrics));
  }

  if (want(15)) {
    section('15. A block common-cut against the plate\'s own edge: the rest of the plate is its remainder, not a part');
    await clearLine(fx);
    const PS = { length: 3000, width: 1500 };
    const grid = D.gridParts({ shape: fx.parts.H.shape, cols: 2, rows: 2, x: 0, y: 0, label: fx.code('H') }).map((q) => ({ ...q, sfx: 'H' }));
    const f = F.nestFile(`${fx.tag}-CC2_${F.T}mm_3000x1500.dxf`, PS, [...grid, F.place(fx, 'R', 1000, 600)], { style: 'commoncut-grid' });
    const dry = await upload(fx, [f]);
    const e = dry.files[0];
    ok('the four cells in the plate\'s corner and the free part are parts; the remainder of the plate is not', dry.problems.length === 0 && e.parts === 5 && e.placed === 5 && e.plate.drawn === true && e.plate.length === 3000 && e.plate.width === 1500
      && e.counts.find((x) => x.cutPlateId === fx.cut.H)?.qty === 4 && e.counts.find((x) => x.cutPlateId === fx.cut.R)?.qty === 1, J([dry.problems, e.parts, e.counts, e.plate]));
    ok('…it says so', e.notes.some((n) => /cut against the plate's own edge/.test(n) && /not a part/.test(n)), J(e.notes));
    ok('…and parts on the very edge are a warning that needs force, not a blocker (the customer cut there)', dry.canSave === true && dry.needsForce === true && dry.warningList.some((w) => w.code === 'IN_RIM'), J(dry.warnings));
    const saved = await upload(fx, [f], { dryRun: false, force: true });
    ok('saved with force: one plate, five pieces, stored tight with its warning', saved.applied === true && saved.saved.lots === 1 && saved.saved.pieces === 5 && (await liveLots(fx))[0].check_verdict === 'tight');
  }

  if (want(16)) {
    section('16. A part lying across the plate\'s edge is reported and NOT counted as nested');
    await clearLine(fx);
    const PS = { length: 3000, width: 1500 };
    for (const style of ['polyline', 'blocks']) {
      const f = F.nestFile(`${fx.tag}-OV_${style}_${F.T}mm_3000x1500.dxf`, PS, [F.place(fx, 'R', 100, 100), F.place(fx, 'R', 2400, 600), F.place(fx, 'G', 400, 1300)], { style });
      const out = await upload(fx, [f], { dryRun: false });
      const e = out.files[0];
      const outside = out.problemList.filter((q) => q.code === 'OUTSIDE_PLATE');
      ok(`${style}: both parts hanging off the plate are blockers, each named with how far it runs off`, out.canSave === false && out.applied === false && outside.length === 2
        && outside.some((q) => q.message.includes(fx.code('R')) && /runs off the plate by 600 mm/.test(q.message)) && outside.some((q) => q.message.includes(fx.code('G')) && /by 120 mm/.test(q.message)), J(out.problems));
      ok(`${style}: …and neither is counted: one part placed, one piece of the rectangle nested, the gusset none`, e.parts === 3 && e.placed === 1 && e.counts.length === 1 && e.counts[0].cutPlateId === fx.cut.R && e.counts[0].qty === 1
        && out.coverage.find((x) => x.cutPlateId === fx.cut.R).nested === 1 && out.coverage.find((x) => x.cutPlateId === fx.cut.G).nested === 0 && outside.every((q) => /not counted as nested/.test(q.message)), J([e.counts, out.coverage.filter((x) => [fx.cut.R, fx.cut.G].includes(x.cutPlateId))]));
      ok(`${style}: …nothing was written`, (await liveLots(fx)).length === 0);
    }
  }

  if (want(17)) {
    section('17. The scrap closed in by common-cut parts is noted, not refused as an unknown part');
    await clearLine(fx);
    const PS = { length: 3000, width: 1500 };
    // Four 300 × 180 shims in a pinwheel close in a 120 × 120 square of scrap.
    const pin = [F.place(fx, 'H', 100, 100), F.place(fx, 'H', 400, 100, 90), F.place(fx, 'H', 280, 400), F.place(fx, 'H', 100, 280, 90)];
    const f = F.nestFile(`${fx.tag}-PIN_${F.T}mm_3000x1500.dxf`, PS, pin, { style: 'commoncut-grid' });
    const out = await upload(fx, [f], { dryRun: false });
    const e = out.files[0];
    ok('the pinwheel: four shims placed, the 120 × 120 void is no blocker', out.applied === true && out.problems.length === 0 && e.parts === 5 && e.placed === 4 && e.counts[0].cutPlateId === fx.cut.H && e.counts[0].qty === 4 && !out.problemList.some((q) => q.code === 'PART_UNKNOWN'), J([out.problems, e.parts, e.placed]));
    ok('…it is noted as scrap, with where it is', e.notes.some((n) => /scrap between the parts/.test(n) && n.includes('(280, 280)') && n.includes('120 × 120')) && e.scrap?.length === 1 && e.scrap[0].x === 280 && e.scrap[0].length === 120, J([e.notes, e.scrap]));
    const view = await N.getNesting(conn, COMPANY, fx.lineId);
    ok('…and it is not a piece of the saved plate', view.groups.flatMap((g) => g.nests).flatMap((n) => n.pieces).length === 4);
    // A free unknown shape is still a blocker.
    const g = F.nestFile(`${fx.tag}-UNK_${F.T}mm_3000x1500.dxf`, PS, [F.place(fx, 'R', 100, 100), { shape: D.rectShape(333, 222), x: 1500, y: 100 }]);
    const bad = await upload(fx, [g]);
    ok('a free shape nobody can name still blocks', bad.canSave === false && bad.problemList.some((q) => q.code === 'PART_UNKNOWN'));
  }

  if (want(18)) {
    section('18. A cut plate with no drawing that is not a rectangle in the customer\'s file keeps the customer\'s outline');
    await clearLine(fx);
    const PS = { length: 3000, width: 1500 };
    // The 1200 × 400 rectangle (no drawing) drawn with a corner cut away, and a shim sitting IN that
    // corner: inside the rectangle's box, clear of the real outline.
    const notched = D.ringsShape([[[0, 0], [1200, 0], [1200, 400], [600, 400], [0, 100]]], 'notched');
    const f = F.nestFile(`${fx.tag}-NT_${F.T}mm_3000x1500.dxf`, PS, [{ sfx: 'R', shape: notched, x: 100, y: 100, label: fx.code('R') }, F.place(fx, 'H', 100, 360)]);
    const dry = await upload(fx, [f]);
    const e = dry.files[0];
    const r = e.placements.find((q) => q.cutPlateId === fx.cut.R);
    ok('the part is matched, and its shape is taken from the nesting file (five corners, not four)', dry.problems.length === 0 && !!r && r.shapeFrom === 'nesting file' && r.rings.outline.length === 5 && r.x === 100 && r.y === 100 && r.length === 1200 && r.width === 400, J([dry.problems, r]));
    ok('…on this plate its steel is the outline (390,000 mm², not 480,000); the cut plate itself is not touched, and the answer says so', r.area === 390000 && e.notes.some((n) => /taken from the nesting file/.test(n) && /stay the catalog/.test(n)), J([r.area, e.notes]));
    ok('…the shim in the cut-away corner is NOT an overlap (it would be, against the rectangle)', !dry.problemList.some((q) => q.code === 'OVERLAP') && dry.warnings.length === 0 && e.placed === 2, J([dry.problems, dry.warnings]));
    const saved = await upload(fx, [f], { dryRun: false });
    const [[row]] = await conn.query('SELECT p.rings_json, p.area_mm2, p.length_mm, p.width_mm FROM cf_nest_placements p WHERE p.company_id = ? AND p.plate_lot_id = ? AND p.cut_plate_id = ? AND p.deleted_at IS NULL', [COMPANY, saved.files[0].lotId, fx.cut.R]);
    const [[plain]] = await conn.query('SELECT COUNT(*) n FROM cf_nest_placements p WHERE p.company_id = ? AND p.plate_lot_id = ? AND p.cut_plate_id = ? AND p.deleted_at IS NULL AND p.rings_json IS NOT NULL', [COMPANY, saved.files[0].lotId, fx.cut.H]);
    ok('saved: the outline is on that placement (and only on it), the steel still the catalog\'s', saved.applied === true && JSON.parse(row.rings_json).outline.length === 5 && Number(row.area_mm2) === 390000 && (await valueOf(fx.cut.R, 'LENGTH')) === 1200 && Number(row.length_mm) === 1200 && Number(plain.n) === 0, J(row));
    const view = await N.getNesting(conn, COMPANY, fx.lineId);
    const nest = view.groups.flatMap((g) => g.nests)[0];
    const piece = nest.pieces.find((q) => q.cutPlateId === fx.cut.R);
    ok('the saved plan draws it: rings with five corners, shapeFrom said, the plate still adds up', piece.rings?.outline?.length === 5 && piece.shapeFrom === 'nesting file' && piece.area === 390000 && Math.abs(nest.usedArea + sum(Object.values(nest.waste)) - nest.sheetArea) <= 1, J([piece, nest.waste]));
    // Nest the rest sees the real shape too: the customer's parts are fixed by their outlines.
    const plan = await N.planNesting(conn, COMPANY, fx.lineId, { effort: 'quick', seed: 1 });
    const acc = await N.acceptNesting(conn, c, fx.lineId, plan);
    const [[kept]] = await conn.query('SELECT COUNT(*) n FROM cf_nest_placements p JOIN cf_plate_lots l ON l.id = p.plate_lot_id WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL AND p.deleted_at IS NULL AND p.rings_json IS NOT NULL', [COMPANY, fx.lineId]);
    ok('nest the rest is accepted on it, and a customer plate written again keeps the outline', acc.lots + acc.additions.lots > 0 && Number(kept.n) === 1, J([acc.lots, acc.additions, kept]));
    // A drawing, once uploaded, wins over the file's outline.
    const facts2 = new Map([[fx.cut.R, { rings: [[[0, 0], [1200, 0], [1200, 400], [0, 400]]] }]]);
    ok('a drawing, once there, wins over the outline from the file', N.placedRingsOfPiece({ x: 100, y: 100, rotationDeg: 0, mirrored: false, fileRings: JSON.parse(row.rings_json) }, { id: fx.cut.R, steel: { length: 1200, width: 400 } }, (cp) => S.shapeOfCutPlate(cp, facts2)).outline.length === 4);
  }

  if (want(19)) {
    section('19. One writer at a time: a save is refused while a run works on the line, and when the line changed under it');
    await clearLine(fx);
    await upload(fx, sets.B.slice(0, 2), { dryRun: false });
    const started = await C.startCompare(conn, c, fx.lineId, { run: true, effort: 'quick' });
    let busy = null; try { await upload(fx, sets.B.slice(2, 3), { dryRun: false }); } catch (e) { busy = e; }
    let busyDel = null; try { await U.deleteNestLot(conn, c, fx.lineId, (await liveLots(fx))[0].id); } catch (e) { busyDel = e; }
    const dryStill = started.running ? await upload(fx, sets.B.slice(2, 3)) : null;
    for (let i = 0; i < 900 && R.memoryRun(COMPANY, fx.lineId)?.status === 'running'; i += 1) await wait(200);
    await R.settleRuns();
    ok('a save while a nesting run is working on the line is refused in words (RUN_BUSY), and nothing is written', started.running === true && busy?.code === 'RUN_BUSY' && busy.status === 422 && /nesting run is working on this line/.test(busy.message) && (await liveLots(fx)).length === 2, J([started.running, busy?.code, busy?.message]));
    ok('…so is taking a plate off; a preview is still answered', busyDel?.code === 'RUN_BUSY' && dryStill?.applied === false && dryStill.canSave === true, J([busyDel?.code, dryStill?.canSave]));
    const after = await upload(fx, sets.B.slice(2, 3), { dryRun: false });
    ok('once the run is done the same save goes through', after.applied === true && (await liveLots(fx)).length === 3);
    // The line changes between working the difference out and writing it (another save got in first).
    const ctx = await U._test.uploadContext(conn, COMPANY, fx.lineId);
    await U.deleteNestLot(conn, c, fx.lineId, (await liveLots(fx))[0].id);
    let stale = null; try { await U._test.applyChanges(conn, c, fx.lineId, ctx, { removeIds: [ctx.saved[1].id], keep: ctx.saved.filter((l) => l.id !== ctx.saved[1].id) }); } catch (e) { stale = e; }
    ok('a save worked out against plates that have changed since is refused (CHANGED_MEANWHILE, 409), nothing written', stale?.code === 'CHANGED_MEANWHILE' && stale.status === 409 && /changed while/.test(stale.message) && (await liveLots(fx)).length === 2, J([stale?.code, stale?.message]));
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
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
ok('every cf_ table is back to the count it started at', drift.length === 0, drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));

if (DOC) fs.writeFileSync(path.join(BE, 'scripts/_scratch/nest_v2_doc_examples.json'), JSON.stringify(doc, null, 1));
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
