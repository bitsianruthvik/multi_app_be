/**
 * tracker_tree_test.mjs — the Tracker's progress tree (trackerTreeService) on
 * the real KEPL line: shape, roll-ups, partial counts on a grouped row, the
 * blocked reason, search / only-blocked / branch / piece reads, round trips and
 * payload sizes. Against the local database.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/tracker_tree_test.mjs
 *
 *   CF_TREE_COMPANY (2), CF_TREE_LINE (923 — the local KEPL copy, 6,072 pieces)
 *   CF_TREE_MAX_TRIPS (16) — the most round trips one tree read may take
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK (line 923 is
 * NEVER left released), and the last thing it does is re-count every cf_ table
 * and prove each is back where it started. It borrows the line on purpose, as
 * release_batch_test does: inside the transaction the line is locked if it is
 * not, its order confirmed and the line released; then some work is recorded
 * through the tracker's own calls.
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
const TREE = await imp('apps/cf_erp/services/trackerTreeService.js');

const COMPANY = Number(process.env.CF_TREE_COMPANY ?? 2);
const LINE = Number(process.env.CF_TREE_LINE ?? 923);
const MAX_TRIPS = Number(process.env.CF_TREE_MAX_TRIPS ?? 16);

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}
function counting(db) {
  const tally = { n: 0, sql: [] };
  const proxy = new Proxy(db, {
    get: (target, prop) => (prop === 'query' || prop === 'execute'
      ? async (...args) => {
        tally.n += 1;
        const t = Date.now();
        const r = await target[prop](...args);
        tally.sql.push(`${Date.now() - t} ms  ${String(args[0]?.sql ?? args[0]).replace(/\s+/g, ' ').slice(0, 80)}`);
        return r;
      }
      : Reflect.get(target, prop)),
  });
  return { db: proxy, tally };
}
const kb = (o) => `${(Buffer.byteLength(JSON.stringify(o)) / 1024).toFixed(0)} KB`;
const bytes = (o) => Buffer.byteLength(JSON.stringify(o));
async function timed(label, conn, fn) {
  const { db, tally } = counting(conn);
  const t = Date.now();
  const out = await fn(db);
  const ms = Date.now() - t;
  console.log(`    ${label}: ${tally.n} round trips, ${ms} ms (${tally.sql.reduce((t, x) => t + parseInt(x, 10), 0)} ms in SQL), ${kb(out)}`);
  if (process.env.CF_TREE_TRACE) for (const q of tally.sql) console.log(`        ${q}`);
  return { out, trips: tally.n, ms, sql: tally.sql };
}
const near = (a, b, eps = 1e-3) => a != null && b != null && Math.abs(a - b) <= eps;

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[line]] = await conn.query(
    'SELECT l.id, l.line_no, l.locked_at, l.order_id, o.code AS order_code, o.status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?',
    [COMPANY, LINE],
  );
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (await REL.liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — it must not be; stopping.`);
  console.log(`\nCompany ${COMPANY}, ${line.order_code} line ${line.line_no} (${LINE})`);
  if (!line.locked_at) await LOCK.lockLine(conn, c, LINE);
  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
  }
  let check = await REL.releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await AREAS.createArea(conn, c, { code: 'TTT-DSP', name: 'Tracker tree test dispatch', purpose: 'dispatch' });
    check = await REL.releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const rel = await REL.releaseLine(conn, c, LINE, check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {});
  console.log(`  released inside the transaction: ${rel.items.length} pieces/groups`);
  const [[{ nSteps }]] = await conn.query('SELECT COUNT(*) AS nSteps FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id WHERE pi.release_id = ? AND s.deleted_at IS NULL', [rel.id]);

  // --- 1. the default read and its cost --------------------------------------------
  console.log('\n1. Reads, round trips and payload');
  const def = await timed('tree (line, default depth)', conn, (db) => TREE.trackerTree(db, COMPANY, { lineId: LINE }));
  const full = await timed('tree (line, every level)', conn, (db) => TREE.trackerTree(db, COMPANY, { lineId: LINE, depth: 50 }));
  const allOpen = await timed('tree (all released lines)', conn, (db) => TREE.trackerTree(db, COMPANY, {}));
  ok(`one tree read takes at most ${MAX_TRIPS} round trips (took ${def.trips})`, def.trips <= MAX_TRIPS, def.sql.join(' | '));
  ok('the full read costs the same round trips as the default (pruning is in memory)', full.trips === def.trips);
  ok('the default read is small (under 200 KB) and well under the full one', bytes(def.out) < 200 * 1024 && bytes(def.out) * 10 < bytes(full.out), `${kb(def.out)} vs ${kb(full.out)}`);
  ok('all released lines include this one', allOpen.out.nodes.some((n) => n.id === `l${LINE}`));

  // --- 2. shape -----------------------------------------------------------------
  console.log('\n2. Shape');
  const T = full.out;
  const byId = new Map(T.nodes.map((n) => [n.id, n]));
  const kids = (id) => T.nodes.filter((n) => n.parentId === id);
  const pieces = T.nodes.filter((n) => n.kind === 'piece');
  ok('the root is the order, then the line', T.nodes[0].id === `o${line.order_id}` && T.nodes[0].kind === 'order' && T.nodes[1].id === `l${LINE}` && T.nodes[1].parentId === T.nodes[0].id);
  ok('one piece node per production item', pieces.length === rel.items.length, `${pieces.length} vs ${rel.items.length}`);
  ok('total counts every node', T.total === T.nodes.length && T.returned === T.nodes.length);
  const [locked] = await conn.query('SELECT code FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  const lockedCodes = new Set(locked.map((p) => p.code));
  ok('every piece node is a frozen piece code of the line', pieces.every((n) => lockedCodes.has(n.code)), pieces.find((n) => !lockedCodes.has(n.code))?.code);
  ok('every frozen code appears once', new Set(pieces.map((n) => n.code)).size === lockedCodes.size, `${new Set(pieces.map((n) => n.code)).size} vs ${lockedCodes.size}`);
  ok('levels: order 0, line 1, top piece 2, each child one below its parent', T.nodes.every((n) => (n.parentId ? n.level === byId.get(n.parentId).level + 1 : n.level === 0)));
  ok('depth-first order: every node comes after its parent', T.nodes.every((n, i) => !n.parentId || T.nodes.findIndex((x) => x.id === n.parentId) < i));
  ok('childCount = the children listed', T.nodes.slice(0, 400).every((n) => n.childCount === kids(n.id).length));
  ok('every step is an operation entry on its piece', pieces.reduce((t, n) => t + n.ops.length, 0) === Number(nSteps), `${pieces.reduce((t, n) => t + n.ops.length, 0)} vs ${nSteps}`);
  ok('KEPL is all piece nodes (basis piece — exact per piece)', pieces.every((n) => n.basis === 'piece'));
  ok('the default depth stops at its last level with child counts', def.out.nodes.every((n) => n.level < TREE.DEFAULT_DEPTH) && def.out.nodes.some((n) => n.level === TREE.DEFAULT_DEPTH - 1 && n.childCount > 0 && !n.childrenIncluded));
  ok('a parent whose children all came says so', def.out.nodes.find((n) => n.kind === 'line').childrenIncluded === true);
  ok('the picker lists the order and the line', T.orders.some((o) => o.id === line.order_id && o.lines.some((l) => l.id === LINE)));

  // --- 3. fresh release: nothing done; the nest gates are blocked by material ----------
  console.log('\n3. Straight after release');
  const lineNode = byId.get(`l${LINE}`);
  ok('nothing done: completion 0', lineNode.completion === 0);
  ok('the weight basis is named', ['minutes', 'count'].includes(lineNode.weight));
  ok('every op is todo or blocked', pieces.every((n) => n.ops.every((o) => o.state === 'todo' || o.state === 'blocked')));
  const blockedPieces = pieces.filter((n) => n.blocked);
  ok('pieces whose only wait is material are blocked', blockedPieces.length > 0, `${blockedPieces.length}`);
  ok('the line counts its blocked pieces', lineNode.blockedCount === blockedPieces.length, `${lineNode.blockedCount} vs ${blockedPieces.length}`);
  ok('a material block says what to reserve', /^Needs .+ to reserve$/.test(blockedPieces[0].ops.find((o) => o.state === 'blocked').reason ?? ''), blockedPieces[0].ops.find((o) => o.state === 'blocked').reason);
  ok('the line names the first blocked piece and its reason', lineNode.blockedAt === blockedPieces[0].code && lineNode.blockedReason === blockedPieces[0].ops.find((o) => o.state === 'blocked').reason);
  ok('summary counts blocked pieces', T.summary.blockedPieces === blockedPieces.length && T.summary.pieces === pieces.length);
  ok('a parent lists its work by operation over its subtree', (lineNode.byOperation ?? []).reduce((t, b) => t + b.total, 0) === pieces.reduce((t, n) => t + n.ops.reduce((u, o) => u + o.total, 0), 0));

  // --- 4. record work and read again -------------------------------------------------
  console.log('\n4. Work recorded');
  // A leaf with two or more steps whose parent has only leaves.
  const leaf = pieces.find((n) => n.childCount === 0 && n.ops.length >= 1 && !n.blocked);
  const leafSteps = leaf.ops.map((o) => o.stepId);
  await REL.startStep(conn, c, leafSteps[0], { allowNotReady: true });
  await REL.recordProgress(conn, c, leafSteps[0], { good: leaf.ops[0].total });
  // A second leaf: started, nothing recorded (running — the tracker's start keeps no session).
  const leaf2 = pieces.find((n) => n.childCount === 0 && n.id !== leaf.id && !n.blocked && n.ops.length);
  await REL.startStep(conn, c, leaf2.ops[0].stepId, { allowNotReady: true });
  // A third: put on hold with a reason.
  const leaf3 = pieces.find((n) => n.childCount === 0 && ![leaf.id, leaf2.id].includes(n.id) && !n.blocked && n.ops.length);
  await REL.holdStep(conn, c, leaf3.ops[0].stepId, { note: 'Crane under repair' });
  // A grouped row: make a leaf a group of 6 with 2 done (rolled back with the rest).
  const grp = pieces.find((n) => n.childCount === 0 && ![leaf.id, leaf2.id, leaf3.id].includes(n.id) && !n.blocked && n.ops.length);
  const grpItem = Number(grp.id.slice(1));
  await conn.query('UPDATE cf_production_items SET quantity = 6 WHERE id = ?', [grpItem]);
  await conn.query("UPDATE cf_production_steps SET quantity = 6, qty_good = 2, state = 'in_progress', started_at = NOW() WHERE production_item_id = ? AND id = ?", [grpItem, grp.ops[0].stepId]);
  await conn.query('INSERT INTO cf_work_sessions (company_id, machine_id, step_id, started_at, ended_at, end_kind, source, qty_good) SELECT ?, id, ?, NOW(), NOW(), \'pause\', \'live\', 2 FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY, grp.ops[0].stepId, COMPANY]);

  const after = await timed('tree (line, every level) after work', conn, (db) => TREE.trackerTree(db, COMPANY, { lineId: LINE, depth: 50 }));
  const A = new Map(after.out.nodes.map((n) => [n.id, n]));
  ok('with work in progress the read still takes at most the budget', after.trips <= MAX_TRIPS, `${after.trips}`);
  const l1 = A.get(leaf.id);
  ok('the finished step is done', l1.ops[0].state === 'done' && l1.ops[0].done === l1.ops[0].total);
  const own = l1.ops.reduce((t, o) => t + o.done, 0) / l1.ops.reduce((t, o) => t + o.total, 0);
  ok('the leaf completion is its share of operations (count basis when a step has no minutes)', l1.weight === 'minutes' ? l1.completion > 0 : near(l1.completion, own), `${l1.completion} vs ${own} (${l1.weight})`);
  const parent = A.get(l1.parentId);
  ok('the parent shows some completion', parent.completion > 0 && parent.completion < 1);
  const lineAfter = A.get(`l${LINE}`);
  ok('the line shows a little completion', lineAfter.completion > 0 && lineAfter.completion < 0.01, `${lineAfter.completion}`);
  // Check the roll-up by hand for the parent, on its own basis.
  const sub = [];
  const collect = (id) => { const n = A.get(id); sub.push(n); for (const k of after.out.nodes.filter((x) => x.parentId === id)) collect(k.id); };
  collect(parent.id);
  const cntT = sub.reduce((t, n) => t + n.ops.reduce((u, o) => u + o.total, 0), 0);
  const cntD = sub.reduce((t, n) => t + n.ops.reduce((u, o) => u + o.done, 0), 0);
  if (parent.weight === 'count') ok('the parent roll-up = operations done / all, by count', near(parent.completion, cntD / cntT), `${parent.completion} vs ${cntD / cntT}`);
  else {
    const [ests] = await conn.query('SELECT s.id, s.est_minutes FROM cf_production_steps s WHERE s.id IN (?)', [sub.flatMap((n) => n.ops.map((o) => o.stepId))]);
    const est = new Map(ests.map((r) => [r.id, Number(r.est_minutes)]));
    const mT = sub.reduce((t, n) => t + n.ops.reduce((u, o) => u + est.get(o.stepId), 0), 0);
    const mD = sub.reduce((t, n) => t + n.ops.reduce((u, o) => u + est.get(o.stepId) * (o.done / o.total), 0), 0);
    ok('the parent roll-up = planned minutes done / all', near(parent.completion, mD / mT), `${parent.completion} vs ${mD / mT}`);
  }
  ok('a started step with no session is running', A.get(leaf2.id).ops[0].state === 'running');
  ok('running counts roll up', lineAfter.running >= 1);
  const held = A.get(leaf3.id);
  ok('a held step is blocked with its note', held.ops[0].state === 'blocked' && held.ops[0].reason === 'On hold: Crane under repair', JSON.stringify(held.ops[0]));
  ok('the held piece counts as blocked above it', lineAfter.blockedCount === lineNode.blockedCount + 1, `${lineAfter.blockedCount} vs ${lineNode.blockedCount}+1`);
  ok('its parent names it', A.get(held.parentId).blockedReason === 'On hold: Crane under repair' || A.get(held.parentId).blockedCount > 1);
  const g = A.get(grp.id);
  ok('a grouped row says basis row', g.basis === 'row' && g.qty === 6);
  ok('a grouped row counts k of n: 2 of 6, partial (paused — its session ended)', g.ops[0].done === 2 && g.ops[0].total === 6 && g.ops[0].state === 'partial', JSON.stringify(g.ops[0]));
  ok('the basis notes are sent', !!after.out.basisNote?.row && !!after.out.basisNote?.piece);
  const allOps = after.out.nodes.flatMap((n) => n.ops);
  ok('every operation is named once per read (ops carry a name only for a pass)', allOps.every((o) => after.out.operations[o.operationId]?.name) && allOps.filter((o) => o.name).every((o) => o.name !== after.out.operations[o.operationId].name));
  ok('byOperation names are in the dictionary', after.out.nodes.filter((n) => n.byOperation).every((n) => n.byOperation.every((b) => after.out.operations[b.operationId])));

  // --- 5. filters, branches, one piece --------------------------------------------------
  console.log('\n5. Filters and branches');
  const deep = pieces.filter((n) => n.level >= 5)[7];
  const found = await timed(`search "${deep.code.slice(-12)}"`, conn, (db) => TREE.trackerTree(db, COMPANY, { lineId: LINE, search: deep.code }));
  ok('search returns the match marked', found.out.nodes.some((n) => n.id === deep.id && n.match));
  ok('search returns its ancestors, all the way up', (() => { let x = A.get(deep.id); while (x.parentId) { if (!found.out.nodes.some((n) => n.id === x.parentId)) return false; x = A.get(x.parentId); } return true; })());
  ok('an ancestor in a search result does not claim all its children', found.out.nodes.some((n) => n.kind === 'piece' && n.childCount > 1 && !n.childrenIncluded));
  const name = await TREE.trackerTree(conn, COMPANY, { lineId: LINE, search: 'zz-no-such-code-zz' });
  ok('a search with no match returns nothing', name.nodes.length === 0);
  const onlyBlocked = await timed('only blocked', conn, (db) => TREE.trackerTree(db, COMPANY, { lineId: LINE, onlyBlocked: '1' }));
  ok('only blocked: every node returned has something blocked under it', onlyBlocked.out.nodes.every((n) => n.blockedCount > 0));
  ok('only blocked: the held piece is there', onlyBlocked.out.nodes.some((n) => n.id === leaf3.id));
  ok('only blocked stays under the cap', onlyBlocked.out.nodes.length <= TREE.FILTER_CAP);
  const segment = after.out.nodes.find((n) => n.level === 4 && n.childCount > 0);
  const branch = await timed(`children of ${segment.code.slice(-14)}`, conn, (db) => TREE.trackerTreeChildren(db, COMPANY, { nodeId: segment.id }));
  ok('a branch returns exactly the node\'s children', branch.out.nodes.length === segment.childCount && branch.out.nodes.every((n) => n.parentId === segment.id));
  ok('a branch costs one read more than a tree read (which piece is it)', branch.trips <= after.trips + 1, `${branch.trips} vs ${after.trips}`);
  const branch2 = await TREE.trackerTreeChildren(conn, COMPANY, { nodeId: segment.id, depth: 2 });
  ok('a branch two deep includes the grandchildren', branch2.nodes.length > segment.childCount && branch2.nodes.some((n) => n.level === segment.level + 2));
  const piece = await timed(`piece ${leaf.code.slice(-14)}`, conn, (db) => TREE.trackerTreeNode(db, COMPANY, { nodeId: leaf.id }));
  ok('a piece read gives every step in full', piece.out.steps.length === leaf.ops.length && piece.out.steps[0].status === 'done' && Array.isArray(piece.out.steps[0].waits));
  ok('a piece read gives the path from the order', piece.out.path[0].kind === 'order' && piece.out.path[1].kind === 'line' && piece.out.path.length === l1.level);
  let refused = false;
  try { await TREE.trackerTreeNode(conn, COMPANY, { nodeId: 'x1' }); } catch { refused = true; }
  ok('a bad node id is refused', refused);
  const other = await TREE.trackerTree(conn, COMPANY, { orderId: 999999999 });
  ok('an order with nothing released reads empty', other.nodes.length === 0 && other.summary.pieces === 0);

  // --- 6. the order line's grid (Production › Tracker on the order) -------------------------
  console.log('\n6. The order line\'s grid');
  const grid = await timed('grid (line, default depth)', conn, (db) => TREE.lineGrid(db, COMPANY, { lineId: LINE }));
  const G = grid.out;
  ok(`a grid read takes at most ${MAX_TRIPS} round trips (took ${grid.trips})`, grid.trips <= MAX_TRIPS);
  ok('the default grid is small (under 300 KB)', bytes(G) < 300 * 1024, kb(G));
  ok('the grid says the line is released, and which release', G.released === true && G.releaseId === rel.id);
  ok('the first row is the line, level 0, no parent', G.nodes[0].id === `l${LINE}` && G.nodes[0].level === 0 && G.nodes[0].parentId === null);
  ok('the default read stops GRID_DEFAULT_DEPTH levels under the line', G.nodes.every((n) => n.level <= TREE.GRID_DEFAULT_DEPTH) && G.nodes.some((n) => n.level === TREE.GRID_DEFAULT_DEPTH && n.childCount > 0 && !n.childrenIncluded));
  const allOpIds = new Set(after.out.nodes.flatMap((n) => n.ops.map((o) => o.operationId)));
  ok('the columns are every operation of the line, once each', G.operations.length === allOpIds.size && G.operations.every((o) => allOpIds.has(o.id)) && new Set(G.operations.map((o) => o.id)).size === G.operations.length);
  ok('every column is named', G.operations.every((o) => o.name && o.name === after.out.operations[o.id].name));
  const colAt = new Map(G.operations.map((o, i) => [o.id, i]));
  const inOrder = pieces.filter((n) => {
    const firsts = [...new Set(n.ops.map((o) => o.operationId))].map((id) => colAt.get(id));
    return firsts.every((x, i) => i === 0 || x > firsts[i - 1]);
  });
  ok('columns follow flow order: each piece\'s own operations run left to right', inOrder.length >= pieces.length * 0.99, `${inOrder.length} of ${pieces.length}`);
  const gridFull = await TREE.lineGrid(conn, COMPANY, { lineId: LINE, depth: 50 });
  const GF = new Map(gridFull.nodes.map((n) => [n.id, n]));
  ok('every piece is a row of the full grid (the line\'s pieces, no order row)', gridFull.nodes.length === pieces.length + 1 && gridFull.total === gridFull.nodes.length && G.total === gridFull.total);
  // States, from the work recorded in section 4.
  const opOf = (n, i = 0) => String(n.ops[i].operationId);
  const c1 = GF.get(leaf.id).cells[opOf(leaf)];
  ok('done: the finished step\'s cell is done, all of it', c1.state === 'done' && c1.done === c1.total && c1.stepIds.includes(leafSteps[0]), JSON.stringify(c1));
  ok('running: a started step\'s cell is running', GF.get(leaf2.id).cells[opOf(leaf2)].state === 'running');
  const c3 = GF.get(leaf3.id).cells[opOf(leaf3)];
  ok('blocked: a held step\'s cell is blocked with its reason', c3.state === 'blocked' && c3.reason === 'On hold: Crane under repair', JSON.stringify(c3));
  const cg = GF.get(grp.id).cells[opOf(grp)];
  ok('partial: the grouped row\'s cell says 2 of 6', cg.state === 'partial' && cg.done === 2 && cg.total === 6, JSON.stringify(cg));
  const naLeaf = pieces.find((n) => n.childCount === 0 && new Set(n.ops.map((o) => o.operationId)).size < allOpIds.size);
  const naOp = G.operations.find((o) => !naLeaf.ops.some((x) => x.operationId === o.id));
  ok('n/a: an operation not in a leaf\'s flow has no cell', !(String(naOp.id) in GF.get(naLeaf.id).cells));
  ok('a leaf has a cell for each of its own operations and nothing else', pieces.filter((n) => n.childCount === 0).slice(0, 500).every((n) => Object.keys(GF.get(n.id).cells).length === new Set(n.ops.map((o) => o.operationId)).size));
  ok('passes of one operation fold into one cell (the cell names each step)', pieces.every((n) => n.ops.every((o) => GF.get(n.id).cells[String(o.operationId)].stepIds.includes(o.stepId))));
  // Parent % per operation = what is under it.
  const subOf = (id) => { const out = []; const walk = (x) => { for (const k of after.out.nodes.filter((y) => y.parentId === x)) { out.push(k); walk(k.id); } }; walk(id); return out; };
  const par = GF.get(l1.parentId);
  const under = subOf(par.id);
  const sums = new Map();
  for (const n of under) for (const o of n.ops) { const e = sums.get(o.operationId) ?? { done: 0, total: 0 }; e.done += o.done; e.total += o.total; sums.set(o.operationId, e); }
  const ownOps = new Set(A.get(par.id).ops.map((o) => o.operationId));
  const rollups = [...sums].filter(([id]) => !ownOps.has(id));
  ok('a parent shows a rolled-up cell for each operation only below it', rollups.length > 0 && rollups.every(([id, e]) => { const c = par.cells[String(id)]; return c?.rollup === true && near(c.done, e.done) && near(c.total, e.total); }),
    JSON.stringify(rollups.slice(0, 3).map(([id, e]) => [id, e, par.cells[String(id)]])));
  ok('the rolled-up cell for the finished step counts it', near(par.cells[opOf(leaf)].done ?? par.cells[opOf(leaf)].below?.done ?? 0, sums.get(leaf.ops[0].operationId).done));
  const ownBelow = [...ownOps].filter((id) => sums.has(id));
  ok('a parent\'s own operation that also runs below says how much below is done', ownBelow.every((id) => { const c = par.cells[String(id)]; return !c.rollup && near(c.below.done, sums.get(id).done) && near(c.below.total, sums.get(id).total); }));
  ok('a parent row carries its completion (the % column) — the tree\'s', near(par.completion, A.get(par.id).completion) && near(GF.get(`l${LINE}`).completion, lineAfter.completion));
  ok('the column header carries the line\'s count for the operation', G.operations.every((o) => near(o.total, sums.size ? (lineAfter.byOperation.find((b) => b.operationId === o.id)?.total ?? 0) : 0)));
  ok('the summary counts ready steps and the work done', G.summary.stepsDone === after.out.summary.stepsDone && G.summary.steps === after.out.summary.steps && G.summary.ready + G.summary.notReady <= G.summary.steps);
  // Branches.
  const segRow = gridFull.nodes.find((n) => n.level === 3 && n.childCount > 0);
  const kidsG = await timed(`grid children of ${segRow.code.slice(-14)}`, conn, (db) => TREE.lineGridChildren(db, COMPANY, { nodeId: segRow.id }));
  ok('a grid branch returns exactly the row\'s children, with their cells', kidsG.out.nodes.length === segRow.childCount && kidsG.out.nodes.every((n) => n.parentId === segRow.id && n.cells) && kidsG.out.node.id === segRow.id);
  ok('a grid branch costs at most one read more than a grid read', kidsG.trips <= grid.trips + 1, `${kidsG.trips} vs ${grid.trips}`);
  // open=: the rows on screen come back in one read — a row named comes with its children when the row itself comes.
  const segParent = GF.get(segRow.parentId);
  const onlySeg = await TREE.lineGrid(conn, COMPANY, { lineId: LINE, open: segRow.id });
  ok('open=: a row whose parent is not open does not come, so neither do its children', segParent.level === TREE.GRID_DEFAULT_DEPTH && !onlySeg.nodes.some((n) => n.id === segRow.id || n.parentId === segRow.id));
  const pathOpen = await TREE.lineGrid(conn, COMPANY, { lineId: LINE, open: [segRow.parentId, segRow.id].join(',') });
  ok('open=: with its parent open too, the row and its children come in the same read', pathOpen.nodes.some((n) => n.id === segRow.id)
    && pathOpen.nodes.filter((n) => n.parentId === segRow.id).length === segRow.childCount
    && pathOpen.nodes.filter((n) => n.parentId === segParent.id).length === segParent.childCount);
  ok('open=: each row says whether all its children came', pathOpen.nodes.find((n) => n.id === segRow.id).childrenIncluded === true);
  let gridRefused = false;
  try { await TREE.lineGridChildren(conn, COMPANY, { nodeId: 'o1' }); } catch { gridRefused = true; }
  ok('a grid branch of an order id is refused', gridRefused);
  const notReleased = await TREE.lineGrid(conn, COMPANY, { lineId: 999999999 });
  ok('a line not released answers released: false', notReleased.released === false && notReleased.nodes.length === 0);
  ok('operationOrder is pure and puts deeper pieces\' work first when flows do not say', JSON.stringify(TREE.operationOrder(
    [{ id: 1, depth: 0 }, { id: 2, depth: 1 }],
    new Map([[1, [{ operation_id: 30 }, { operation_id: 40 }]], [2, [{ operation_id: 10 }, { operation_id: 20 }]]]),
  )) === JSON.stringify([10, 20, 30, 40]));

  // --- 7. the order page's first load: figures, not the whole tracker ---------------------------
  console.log('\n7. The order page\'s first load');
  const SALES = await imp('apps/cf_erp/services/salesOrderService.js');
  const PROC = await imp('apps/cf_erp/services/processService.js');
  const STOCK = await imp('apps/cf_erp/services/stockService.js');
  const fOrder = await timed('GET /orders/:id', conn, (db) => SALES.getOrder(db, COMPANY, line.order_id));
  const fProc = await timed('GET /orders/:id/process', conn, (db) => PROC.orderProcess(db, COMPANY, line.order_id));
  const fProd = await timed('GET /orders/:id/production (figures)', conn, (db) => REL.orderProductionSummary(db, COMPANY, line.order_id));
  const fMoves = await timed('GET /movements?orderId', conn, (db) => STOCK.listMovements(db, COMPANY, { orderId: line.order_id }));
  const fFull = await timed('GET /orders/:id/production?full=1 (the old first load)', conn, (db) => REL.orderProduction(db, COMPANY, line.order_id));
  const firstTrips = fOrder.trips + fProc.trips + fProd.trips + fMoves.trips + grid.trips;
  ok(`the production figures take at most 6 round trips (took ${fProd.trips})`, fProd.trips <= 6);
  ok('the production figures are tiny (under 10 KB) where the full tracker is megabytes', bytes(fProd.out) < 10 * 1024 && bytes(fFull.out) > 1024 * 1024, `${kb(fProd.out)} vs ${kb(fFull.out)}`);
  ok(`the order page's first load (order, process, figures, movements, grid) takes at most 90 round trips (took ${firstTrips})`, firstTrips <= 90);
  ok(`the order's process read takes at most 50 round trips (took ${fProc.trips})`, fProc.trips <= 50);
  ok(`the order read takes at most 10 round trips (took ${fOrder.trips})`, fOrder.trips <= 10);
  const sumRel = fProd.out.releases.find((r) => r.id === rel.id);
  const fullRel = fFull.out.releases.find((r) => r.id === rel.id);
  const { items: _i, requirements: _q, ...fullHead } = fullRel;
  const { summary: _s, ...sumHead } = sumRel;
  ok('the figures agree with the full release (all but readiness)', JSON.stringify({ ...fullHead, progress: { ...fullHead.progress, ready: null, notReady: null } }) === JSON.stringify(sumHead), `${JSON.stringify(sumHead.progress)} vs ${JSON.stringify(fullHead.progress)}`);
  ok('the figures carry no tree', !('items' in sumRel) && !('requirements' in sumRel) && sumRel.summary === true);
  ok('unreleased lines agree too', JSON.stringify(fProd.out.unreleased) === JSON.stringify(fFull.out.unreleased));
  const reqsOnly = await timed('GET /releases/:id/requirements', conn, (db) => REL.releaseRequirements(db, COMPANY, rel.id));
  ok('the material, read on its own, is the full release\'s', JSON.stringify(reqsOnly.out.requirements) === JSON.stringify(fullRel.requirements) && reqsOnly.out.release.id === rel.id);
  const resumed = await REL.resumeStep(conn, c, leaf3.ops[0].stepId, { view: 'summary' });
  ok('a write asked ?view=summary answers with the figures only', resumed.summary === true && resumed.id === rel.id && !('items' in resumed) && resumed.progress.onHold === fullRel.progress.onHold - 1);
  const none = await REL.holdStep(conn, c, leaf3.ops[0].stepId, { note: 'again', view: 'none' });
  ok('a write asked ?view=none answers with the id only', JSON.stringify(none) === JSON.stringify({ id: rel.id }));

  console.log(`\n  PERF (local, KEPL line ${LINE}: ${pieces.length} pieces, ${nSteps} steps): tree ${def.trips} trips / ${def.ms} ms / ${kb(def.out)} default (${def.out.nodes.length} nodes), ${kb(full.out)} every level; branch ${branch.trips} trips / ${branch.ms} ms / ${kb(branch.out)}; piece ${piece.trips} trips / ${piece.ms} ms`);
  console.log(`  PERF grid: ${grid.trips} trips / ${grid.ms} ms / ${kb(G)} default (${G.nodes.length} rows × ${G.operations.length} operations), ${kb(gridFull)} every level; first load ${firstTrips} trips (figures ${fProd.trips} trips / ${kb(fProd.out)} vs the old full read ${fFull.trips} trips / ${kb(fFull.out)})`);

  await conn.rollback();
  detachNodeCache(conn);
  const afterCounts = await census(conn);
  const moved = Object.keys(before).filter((t) => before[t] !== afterCounts[t]);
  ok('every cf_ table is back to its count', moved.length === 0);
  if (moved.length) console.log(`    moved: ${moved.map((t) => `${t} ${before[t]} -> ${afterCounts[t]}`).join(', ')}`);
  ok(`line ${LINE} is not released`, !(await REL.liveReleaseOfLine(conn, COMPANY, LINE)));

  // --- 8. the short memory: only on the shared pool, cleared by any committed write -------------
  console.log('\n8. The tracker\'s short memory (shared pool, a committed release — read only)');
  const CACHE = await imp('apps/cf_erp/lib/trackerCache.js');
  const { withTransaction } = await imp('apps/cf_erp/lib/db.js');
  const [[live]] = await pool.query(
    `SELECT r.company_id, r.order_line_id FROM cf_production_releases r
      WHERE r.deleted_at IS NULL AND EXISTS (SELECT 1 FROM cf_production_items pi WHERE pi.release_id = r.id AND pi.deleted_at IS NULL) ORDER BY r.id LIMIT 1`,
  );
  if (!live) console.log('    (no committed release in this database — skipped)');
  else {
    CACHE.invalidateTrackerCache();
    const h0 = CACHE.trackerCacheStats().hits;
    const g1 = await TREE.lineGrid(pool, live.company_id, { lineId: live.order_line_id });
    const h1 = CACHE.trackerCacheStats().hits;
    const g2 = await TREE.lineGrid(pool, live.company_id, { lineId: live.order_line_id });
    const h2 = CACHE.trackerCacheStats().hits;
    ok('a second read on the pool comes from memory, unchanged', h1 === h0 && h2 > h1 && JSON.stringify(g1) === JSON.stringify(g2));
    const both = await Promise.all([REL.evaluatedTracker(pool, live.company_id, [g1.releaseId]), REL.evaluatedTracker(pool, live.company_id, [g1.releaseId])]);
    both[0].steps[0]._status = 'tampered';
    ok('each reader gets its own copy of the rows', both[1].steps[0]._status !== 'tampered' && both[0].steps[0] !== both[1].steps[0]);
    await withTransaction(async () => {});
    const h3 = CACHE.trackerCacheStats().hits;
    await TREE.lineGrid(pool, live.company_id, { lineId: live.order_line_id });
    ok('any committed write clears it (the next read goes to the database)', CACHE.trackerCacheStats().hits === h3);
    const inTx = await pool.getConnection();
    try {
      const h4 = CACHE.trackerCacheStats().hits;
      await TREE.lineGrid(inTx, live.company_id, { lineId: live.order_line_id });
      ok('a read on a connection (a transaction) never uses it', CACHE.trackerCacheStats().hits === h4);
    } finally { inTx.release(); }
  }
} catch (err) {
  try { await conn.rollback(); } catch { /* the error below matters */ }
  console.error(`\nERROR: ${err.stack}${err.problems?.length ? `\n  ${err.problems.slice(0, 10).join('\n  ')}` : ''}`);
  exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exitCode = exitCode || (failed ? 1 : 0);
