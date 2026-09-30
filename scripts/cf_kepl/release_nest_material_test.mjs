/**
 * release_nest_material_test.mjs — a NESTED line's raw plate comes from its
 * nest: one whole plate per catalog plate lot, not the cut plates' fractional
 * plate lines (releaseService "raw plate from the nest", 2026-09-30).
 * Against the local database.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/release_nest_material_test.mjs
 *
 *   CF_NESTMAT_COMPANY (2), CF_NESTMAT_LINE (923 — the local KEPL copy: locked, 120 lots)
 *   CF_NESTMAT_MAX_TRIPS (100) — the most round trips release may take
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table and prove each is back where it
 * started. Like release_batch_test it BORROWS the real line on purpose (the
 * point is the real nest): inside the transaction the order is confirmed, a
 * dispatch / storage area made when there is none, and the line released.
 *
 *   1. an un-nested line behaves as before (savepoint: lots taken away, the line
 *      released, every cut plate asks for its plate line's fraction; rolled back)
 *   2. a nest that does not lay out every piece stops release (savepoint)
 *   3. the nested release: requirements per plate item == lots per plate item,
 *      whole plates, total == catalog lot count; cut-plate plate lines make none;
 *      lots sharing a cut plate are one nest group whose gate (the cut plate with
 *      most pieces across the group) holds their plates on its first step; every
 *      other node of a nested cut plate waits (origin 'nest', 'started') for the
 *      gate of each lot it is on, so no cutting step is ready without its plate
 *   4. the tracker names each lot requirement's lot (N-012 · PL-…)
 *   5. the buy list asks for exactly the nest's plates
 *   6. reserve one, reserve all and issue work on lot requirements; a gate with
 *      its plates reserved is ready, and starting it frees the cut plates on them
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const STOCK = await imp('apps/cf_erp/services/stockService.js');
const BUY = await imp('apps/cf_erp/services/purchaseService.js');

const COMPANY = Number(process.env.CF_NESTMAT_COMPANY ?? 2);
const LINE = Number(process.env.CF_NESTMAT_LINE ?? 923);
const MAX_TRIPS = Number(process.env.CF_NESTMAT_MAX_TRIPS ?? 100);
const RUN = `NM${Date.now().toString(36).toUpperCase()}`;
const EPS = 1e-6;

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, {
    get: (target, prop) => (prop === 'query' || prop === 'execute'
      ? (...args) => { tally.n += 1; return target[prop](...args); }
      : Reflect.get(target, prop)),
  });
  return { db: proxy, tally };
}
const countBy = (rows, key) => { const m = new Map(); for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1); return m; };
const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => Math.abs((b.get(k) ?? -1) - v) < EPS);

async function releaseInput(db, c) {
  let check = await REL.releaseCheck(db, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await AREAS.createArea(db, c, { code: `${RUN}-DSP`, name: 'Nest material test dispatch', purpose: 'dispatch' });
    check = await REL.releaseCheck(db, COMPANY, LINE);
  }
  return { check, input: check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {} };
}

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[line]] = await conn.query(
    `SELECT l.id, l.line_no, l.locked_at, l.order_id, o.code AS order_code, o.status
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?`,
    [COMPANY, LINE],
  );
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (await REL.liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released.`);
  console.log(`\nCompany ${COMPANY}, ${line.order_code} line ${line.line_no} (${LINE}) — run ${RUN}`);
  if (!line.locked_at) await LOCK.lockLine(conn, c, LINE);
  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
  }

  // The nest, read straight from its tables.
  const [lots] = await conn.query(
    `SELECT pl.id, pl.lot_no, pl.source, pl.plate_item_id, m.code AS plate_code
       FROM cf_plate_lots pl JOIN cf_master_records m ON m.id = pl.plate_item_id
      WHERE pl.company_id = ? AND pl.order_line_id = ? AND pl.deleted_at IS NULL ORDER BY pl.id`,
    [COMPANY, LINE],
  );
  const catalogLots = lots.filter((l) => l.source === 'catalog');
  if (!catalogLots.length) throw new Error(`Line ${LINE} has no saved nest — nothing to test.`);
  const [placements] = await conn.query(
    `SELECT np.plate_lot_id, np.cut_plate_id, COUNT(*) AS n FROM cf_nest_placements np
      WHERE np.company_id = ? AND np.deleted_at IS NULL AND np.plate_lot_id IN (?) GROUP BY np.plate_lot_id, np.cut_plate_id`,
    [COMPANY, lots.map((l) => l.id)],
  );
  const nested = new Set(placements.map((p) => Number(p.cut_plate_id)));
  const lotsPerPlate = countBy(catalogLots, (l) => Number(l.plate_item_id));
  console.log(`  nest: ${lots.length} lots (${catalogLots.length} catalog) over ${lotsPerPlate.size} plate items, ${nested.size} cut plates`);

  // --- 1. an un-nested line is released as before ------------------------------
  console.log('\n1. without a nest');
  await conn.query('SAVEPOINT no_nest');
  await conn.query('UPDATE cf_plate_lots SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  {
    const { check, input } = await releaseInput(conn, c);
    ok('1: the line can be released without its nest', check.ok, check.problems.slice(0, 3).join(' | '));
    const rel = await REL.releaseLine(conn, c, LINE, input);
    const [reqs] = await conn.query(
      `SELECT q.*, pi.item_id AS piece_item FROM cf_material_requirements q JOIN cf_production_items pi ON pi.id = q.production_item_id
        WHERE q.release_id = ? AND q.deleted_at IS NULL`, [rel.id]);
    const [cpNodes] = await conn.query('SELECT id FROM cf_production_items WHERE release_id = ? AND item_id IN (?)', [rel.id, [...nested]]);
    const cpReqs = reqs.filter((q) => nested.has(Number(q.piece_item)));
    ok('1: no requirement without its BOM line (no lot requirements)', reqs.every((q) => q.bom_line_id != null));
    ok('1: every cut plate node asks for its plate line', cpReqs.length === cpNodes.length && new Set(cpReqs.map((q) => q.production_item_id)).size === cpNodes.length);
    ok('1: those are fractions, as before (some not whole)', cpReqs.some((q) => Math.abs(Number(q.quantity) - Math.round(Number(q.quantity))) > EPS));
    ok('1: the tracker names no lot', rel.requirements.every((q) => q.lot === null));
    console.log(`     ${reqs.length} requirements, ${cpReqs.length} on cut plates`);
  }
  await conn.query('ROLLBACK TO SAVEPOINT no_nest');

  // --- 2. a nest short of a piece stops release --------------------------------
  console.log('\n2. a stale nest');
  await conn.query('SAVEPOINT stale');
  await conn.query(
    'UPDATE cf_nest_placements SET deleted_at = NOW() WHERE company_id = ? AND plate_lot_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1',
    [COMPANY, catalogLots[0].id],
  );
  {
    const { check } = await releaseInput(conn, c);
    ok('2: release is refused', !check.ok);
    ok('2: it says to nest the line again', check.problems.some((p) => /nest the line again/.test(p)), check.problems.slice(0, 3).join(' | '));
  }
  await conn.query('ROLLBACK TO SAVEPOINT stale');

  // --- 3. the nested release -----------------------------------------------------
  console.log('\n3. the nested release');
  // Released rows only: before release the line is confirmed, frozen and nested,
  // so its material is already on the buy list as PLANNED rows (CF_ERP_ORDER_FLOW_PLAN).
  const listBefore = await BUY.buyList(conn, COMPANY, { show: 'all' });
  const buyBefore = new Map(listBefore.filter((r) => !r.planned).map((r) => [r.item.id, r.wanted]));
  const plannedPlates = new Map(listBefore.filter((r) => r.planned && r.source?.lineId === LINE && lotsPerPlate.has(r.item.id)).map((r) => [r.item.id, r.wanted]));
  ok('3: before release, the buy list already plans the nest\'s plates for the line', sameMap(lotsPerPlate, plannedPlates),
    [...lotsPerPlate].filter(([id, n]) => plannedPlates.get(id) !== n).slice(0, 4).map(([id, n]) => `${id}: ${plannedPlates.get(id)} vs ${n}`).join(', '));
  const { check, input } = await releaseInput(conn, c);
  ok('3: the nested line can be released', check.ok, check.problems.slice(0, 3).join(' | '));
  const checkPlates = new Map(check.materials.filter((m) => lotsPerPlate.has(m.item.id)).map((m) => [m.item.id, m.required]));
  ok('3: the release check asks for the nest\'s plates', sameMap(lotsPerPlate, checkPlates));
  const { db, tally } = counting(conn);
  const rel = await REL.releaseLine(db, c, LINE, input);
  console.log(`     release: ${tally.n} round trips`);
  ok(`3: release takes at most ${MAX_TRIPS} round trips (took ${tally.n})`, tally.n <= MAX_TRIPS);
  const [reqs] = await conn.query('SELECT * FROM cf_material_requirements WHERE release_id = ? AND deleted_at IS NULL ORDER BY id', [rel.id]);
  const lotReqs = reqs.filter((q) => q.bom_line_id == null && q.production_item_id != null);
  ok(`3: one requirement per catalog lot (${lotReqs.length} of ${catalogLots.length})`, lotReqs.length === catalogLots.length);
  ok('3: each is one whole plate', lotReqs.every((q) => Math.abs(Number(q.quantity) - 1) < EPS));
  ok('3: requirements per plate item == lots per plate item', sameMap(lotsPerPlate, countBy(lotReqs, (q) => Number(q.item_id))));
  const [plateLineReqs] = await conn.query(
    `SELECT COUNT(*) AS n FROM cf_material_requirements q
       JOIN cf_bom_lines bl ON bl.id = q.bom_line_id JOIN cf_boms b ON b.id = bl.bom_id
      WHERE q.release_id = ? AND q.deleted_at IS NULL AND b.parent_id IN (?)`,
    [rel.id, [...nested]],
  );
  ok('3: the nested cut plates\' plate lines make no requirement', Number(plateLineReqs[0].n) === 0);
  // Which cut plate each lot's plate gates: lots sharing a cut plate are one nest
  // group; the group's gate is the cut plate with the most pieces across it,
  // then the first in the tracker — worked out here independently of the service.
  const [pieces] = await conn.query('SELECT id, item_id, sort_order FROM cf_production_items WHERE release_id = ? ORDER BY sort_order', [rel.id]);
  const firstNode = new Map();
  for (const p of pieces) if (!firstNode.has(p.item_id)) firstNode.set(p.item_id, p);
  const pieceById = new Map(pieces.map((p) => [p.id, p]));
  const [firstSteps] = await conn.query(
    `SELECT s.production_item_id, MIN(s.sequence) AS seq FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.release_id = ? GROUP BY s.production_item_id`, [rel.id]);
  const firstSeq = new Map(firstSteps.map((s) => [s.production_item_id, Number(s.seq)]));
  const [stepRows] = lotReqs.length ? await conn.query('SELECT id, production_item_id, sequence FROM cf_production_steps WHERE id IN (?)', [lotReqs.map((q) => q.step_id)]) : [[]];
  const stepById = new Map(stepRows.map((s) => [s.id, s]));
  const groupOf = new Map(lots.map((l) => [l.id, l.id]));
  const find = (x) => (groupOf.get(x) === x ? x : find(groupOf.get(x)));
  const lotsOfCp = new Map();
  for (const pl of placements) { const cp = Number(pl.cut_plate_id); if (!lotsOfCp.has(cp)) lotsOfCp.set(cp, []); lotsOfCp.get(cp).push(pl.plate_lot_id); }
  for (const ls of lotsOfCp.values()) for (const l of ls.slice(1)) { const a = find(ls[0]); const b = find(l); if (a !== b) groupOf.set(b, a); }
  const byGroup = new Map();                        // group -> Map(cp -> pieces)
  for (const pl of placements) {
    const g = find(pl.plate_lot_id);
    if (!byGroup.has(g)) byGroup.set(g, new Map());
    byGroup.get(g).set(Number(pl.cut_plate_id), (byGroup.get(g).get(Number(pl.cut_plate_id)) ?? 0) + Number(pl.n));
  }
  const gateOfGroup = new Map();
  for (const [g, m] of byGroup) {
    const on = [...m].map(([cp, n]) => ({ cp, n, order: firstNode.get(cp)?.sort_order ?? Infinity })).sort((a, b) => b.n - a.n || a.order - b.order);
    gateOfGroup.set(g, on[0].cp);
  }
  const expectedGate = new Map(catalogLots.map((lot) => [lot.id, gateOfGroup.get(find(lot.id))]));   // lot id -> cut plate item
  console.log(`     ${byGroup.size} nest groups, ${new Set(gateOfGroup.values()).size} gate cut plates`);
  const gateCount = countBy([...expectedGate.values()].map((cp) => firstNode.get(cp).id), (x) => x);
  ok('3: lot requirements sit on the expected cut plates\' first nodes', sameMap(gateCount, countBy(lotReqs, (q) => q.production_item_id)));
  ok('3: each gates its piece\'s first step', lotReqs.every((q) => {
    const s = stepById.get(q.step_id);
    return s && s.production_item_id === q.production_item_id && Number(s.sequence) === firstSeq.get(q.production_item_id) && nested.has(Number(pieceById.get(q.production_item_id)?.item_id));
  }));
  ok('3: the other requirements are unchanged in kind (all carry a BOM line)', reqs.filter((q) => !lotReqs.includes(q)).every((q) => q.bom_line_id != null || q.production_item_id == null));

  // Every other node of a nested cut plate waits for the gate of each lot its cut plate sits on.
  const [nestDeps] = await conn.query(
    `SELECT d.step_id, d.target_step_id, d.required, s.production_item_id FROM cf_step_dependencies d
       JOIN cf_production_steps s ON s.id = d.step_id JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.release_id = ? AND d.origin = 'nest' AND d.deleted_at IS NULL`, [rel.id]);
  ok('3: nest waits were written', nestDeps.length > 0);
  ok('3: every nest wait is "started" on a step that holds a lot plate', nestDeps.every((d) => d.required === 'started' && lotReqs.some((q) => q.step_id === d.target_step_id)));
  const waitsOf = new Map();                        // production item -> Set(target step)
  for (const d of nestDeps) { if (!waitsOf.has(d.production_item_id)) waitsOf.set(d.production_item_id, new Set()); waitsOf.get(d.production_item_id).add(d.target_step_id); }
  const reqStepOfLot = new Map(catalogLots.map((lot) => [lot.id, null]));
  const gatePiece = new Map([...expectedGate].map(([lot, cp]) => [lot, firstNode.get(cp).id]));
  // The lot's requirement is on its gate piece; any one of the gate's lot requirements names its step.
  for (const [lot, pid] of gatePiece) reqStepOfLot.set(lot, lotReqs.find((q) => q.production_item_id === pid)?.step_id ?? null);
  let missing = 0; let checkedNodes = 0; let multi = null;
  for (const p of pieces) {
    const cp = Number(p.item_id);
    if (!nested.has(cp)) continue;
    const onLots = [...new Set(lotsOfCp.get(cp) ?? [])].filter((l) => reqStepOfLot.has(l));
    for (const l of onLots) {
      checkedNodes += 1;
      if (gatePiece.get(l) === p.id) continue;                    // it is the gate itself
      if (!waitsOf.get(p.id)?.has(reqStepOfLot.get(l))) missing += 1;
    }
    if (!multi && onLots.length >= 2 && ![...gatePiece.values()].includes(p.id)) multi = { p, onLots };
  }
  ok(`3: every cut-plate node waits for the gate of every lot it is on (${checkedNodes} node-lot pairs)`, missing === 0, `${missing} missing`);
  ok('3: a node on two or more lots waits for each of their gates', !!multi && multi.onLots.every((l) => waitsOf.get(multi.p.id)?.has(reqStepOfLot.get(l))));
  if (multi) console.log(`     e.g. production item ${multi.p.id} (cut plate ${multi.p.item_id}) is on ${multi.onLots.length} lots and waits for ${waitsOf.get(multi.p.id)?.size} gate step(s)`);
  const cpFirstSteps = rel.items.filter((it) => nested.has(it.item.id)).map((it) => it.steps[0]).filter(Boolean);
  ok('3: no cut-plate first step is ready without its lot plate', cpFirstSteps.every((s) => s.status !== 'ready'));
  const allStatus = {}; for (const it of rel.items) for (const s of it.steps) allStatus[s.status] = (allStatus[s.status] ?? 0) + 1;
  console.log(`     step status right after release: ${JSON.stringify(allStatus)}`);

  // --- 4. the tracker names the lot ------------------------------------------------
  console.log('\n4. the tracker');
  const shown = rel.requirements.filter((q) => q.lot);
  ok('4: every lot requirement is named by its lot', shown.length === catalogLots.length);
  ok('4: each lot once', new Set(shown.map((q) => q.lot.lotNo)).size === catalogLots.length);
  const lotById = new Map(catalogLots.map((l) => [l.id, l]));
  ok('4: the named lot is the requirement\'s plate', shown.every((q) => Number(lotById.get(q.lot.id)?.plate_item_id) === q.item.id));
  ok('4: the named lot is on the piece it gates', shown.every((q) => expectedGate.get(q.lot.id) === Number(pieceById.get(q.piece.id)?.item_id)));
  const blockerText = rel.items.flatMap((it) => it.steps.flatMap((s) => s.blockers)).filter((b) => b.kind === 'material').map((b) => b.text);
  ok('4: a material blocker names its lot ("N-… · PL-…")', blockerText.some((t) => t.startsWith(`${shown[0].lot.lotNo} · ${shown[0].item.code}`)));
  const again = await REL.getRelease(conn, COMPANY, rel.id);
  ok('4: a fresh read names the same lots', JSON.stringify(again.requirements.map((q) => q.lot)) === JSON.stringify(rel.requirements.map((q) => q.lot)));
  const listed = await REL.listTrackerMaterials(conn, COMPANY, { show: 'all' });
  ok('4: the tracker\'s material list carries the lot', listed.filter((m) => m.release?.id === rel.id && m.lot).length === catalogLots.length);
  console.log(`     e.g. "${shown[0].lot.lotNo} · ${shown[0].item.code}" for ${shown[0].step?.label}`);

  // --- 5. the buy list is the nest ---------------------------------------------------
  console.log('\n5. the buy list');
  const listAfter = await BUY.buyList(conn, COMPANY, { show: 'all' });
  const buyAfter = new Map(listAfter.filter((r) => !r.planned).map((r) => [r.item.id, r.wanted]));
  ok('5: once released, the line is no longer planned — nothing is counted twice', !listAfter.some((r) => r.planned && r.source?.lineId === LINE));
  const delta = new Map();
  for (const [id, w] of buyAfter) { const d = Number((w - (buyBefore.get(id) ?? 0)).toFixed(6)); if (Math.abs(d) > EPS) delta.set(id, d); }
  const plateDelta = new Map([...delta].filter(([id]) => lotsPerPlate.has(id)));
  ok('5: the buy list wants the nest\'s plates, plate item by plate item', sameMap(lotsPerPlate, plateDelta),
    [...lotsPerPlate].filter(([id, n]) => plateDelta.get(id) !== n).slice(0, 4).map(([id, n]) => `${id}: ${plateDelta.get(id)} vs ${n}`).join(', '));
  ok('5: whole plates only', [...plateDelta.values()].every((d) => Math.abs(d - Math.round(d)) < EPS));
  const buyRows = await BUY.buyList(conn, COMPANY, { show: 'all' });
  const big = [...lotsPerPlate].sort((a, b) => b[1] - a[1])[0];
  const bigRow = buyRows.find((r) => r.item.id === big[0] && !r.planned);
  console.log(`     ${bigRow?.item.code}: wanted ${bigRow?.wanted} (nest ${big[1]}), to buy ${bigRow?.toBuy}`);

  // --- 6. reserve and issue on lot requirements ------------------------------------------
  console.log('\n6. reserve and issue');
  const [areas] = await conn.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const storeId = areas[0]?.id ?? (await AREAS.createArea(conn, c, { code: `${RUN}-STO`, name: 'Nest material test store', purpose: 'storage' })).id;
  const plateId = big[0];
  const [[pd]] = await conn.query('SELECT tracked_by FROM cf_item_details WHERE master_id = ?', [plateId]);
  const free0 = (await REL.availability(conn, COMPANY, [plateId])).get(plateId).free;
  const mine = rel.requirements.filter((q) => q.lot && q.item.id === plateId);
  // Enough for all but one of this plate's lots, on top of whatever is free now.
  const receive = Math.max(1, mine.length - 1);
  await STOCK.postMovement(conn, c, {
    movementType: 'receipt', movementDate: '2026-09-30', toAreaId: storeId, reference: RUN,
    lines: [{ itemId: plateId, quantity: receive, ...(pd.tracked_by === 'batch' ? { batch: { code: `${RUN}-B` } } : {}) }],
  });
  const one = await REL.reserveRequirement(conn, c, mine[0].id);
  const oneQ = one.requirements.find((q) => q.id === mine[0].id);
  ok('6: reserve one covers a lot requirement with one plate', oneQ.covered && Math.abs(oneQ.reserved - 1) < EPS);
  ok('6: it still names its lot', oneQ.lot?.lotNo === mine[0].lot.lotNo);
  const all = await REL.reserveRelease(conn, c, rel.id);
  const after = all.release.requirements.filter((q) => q.lot && q.item.id === plateId);
  const coveredNow = after.filter((q) => q.covered).length;
  ok('6: reserve all covers as many more whole plates as are free', coveredNow === Math.min(mine.length, Math.floor(free0 + receive + EPS)), `${coveredNow} covered, free ${free0} + ${receive}`);
  ok('6: reserve all reports this plate short by whole plates', (() => {
    const s = all.short.find((x) => x.code === mine[0].item.code);
    const want = Math.max(0, mine.length - Math.floor(free0 + receive + EPS));
    return want === 0 ? !s : !!s && Math.abs(s.short - want) < EPS;
  })());
  const issued = await REL.issueRequirement(conn, c, mine[0].id);
  const iq = issued.requirements.find((q) => q.id === mine[0].id);
  ok('6: issue takes the reserved plate', Math.abs(iq.issued - 1) < EPS && iq.covered);
  const [[{ n: issueRows }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM cf_stock_movements WHERE company_id = ? AND movement_type = 'issue' AND order_id = ? AND created_at >= NOW() - INTERVAL 1 HOUR", [COMPANY, line.order_id]);
  ok('6: a stock issue was posted', Number(issueRows) >= 1);
  const gateStep = issued.items.flatMap((it) => it.steps).find((s) => s.requirementIds.includes(mine[0].id));
  ok('6: the gated step no longer lists that plate as a blocker', !!gateStep && !gateStep.blockers.some((b) => b.text.startsWith(`${mine[0].lot.lotNo} ·`)));

  // A gate whose plates are all reserved is ready; once it starts, the cut plates waiting on it are free to start.
  const gateStepIds = new Set(lotReqs.map((q) => q.step_id));
  const stepsNow = issued.items.flatMap((it) => it.steps);
  const readyGate = stepsNow.find((st) => gateStepIds.has(st.id) && st.status === 'ready');
  ok('6: a gate with all its plates reserved is ready', !!readyGate);
  if (readyGate) {
    const waiting = nestDeps.filter((d) => d.target_step_id === readyGate.id).map((d) => d.step_id);
    const beforeStart = stepsNow.filter((st) => waiting.includes(st.id));
    ok('6: before the gate starts, the cut plates on its plates are not ready', beforeStart.length > 0 && beforeStart.every((st) => st.status === 'not_ready'));
    const started = await REL.startStep(conn, c, readyGate.id, {});
    const afterStart = started.items.flatMap((it) => it.steps).filter((st) => waiting.includes(st.id));
    ok(`6: once it starts, they are ready (${afterStart.filter((st) => st.status === 'ready').length} of ${afterStart.length})`, afterStart.every((st) => st.status === 'ready'));
  }

  await conn.rollback();
  detachNodeCache(conn);
  const afterCensus = await census(conn);
  const moved = Object.keys(before).filter((t) => before[t] !== afterCensus[t]);
  ok('every cf_ table is back to its count', moved.length === 0);
  if (moved.length) console.log(`    moved: ${moved.map((t) => `${t} ${before[t]} -> ${afterCensus[t]}`).join(', ')}`);
} catch (err) {
  try { await conn.rollback(); } catch { /* the error below is the one that matters */ }
  console.error(`\nERROR: ${err.stack ?? err.message}${err.problems?.length ? `\n  ${err.problems.slice(0, 10).join('\n  ')}` : ''}`);
  exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exitCode = exitCode || (failed ? 1 : 0);
