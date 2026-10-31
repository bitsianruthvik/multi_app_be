/**
 * po_batches_test.mjs — BATCHES (init.sql §97, user 2026-11-01): several units or sub-assemblies of a line in ONE
 * production order, of any sizes, rows mixed freely. Local DB only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/po_batches_test.mjs
 *   CF_FLOW_COMPANY (2)
 *
 *   A. pure: a line's pieces at its split level (levelPieces), batches → production orders with members, labels,
 *      counts, which production order each released piece belongs to (assignPieces), the checks (checkGroups)
 *   B. the service: pieces in the answer, a dry run with batches (preview, counts), refusals said in words (a piece
 *      in two batches, a piece the line does not have, a batch mixing lines, an empty batch), save + read back,
 *      a change of level clears them, a line of its own holds its own batches; production orders made from a plan
 *      with batches carry their members (members_json)
 *
 * Its own TEST-PB-… order, INSIDE ONE TRANSACTION THAT IS ROLLED BACK; the last thing it does is re-count every cf_
 * table.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const MODEL = await imp('apps/cf_erp/services/productionOrderModel.js');
const M = await imp('apps/cf_erp/services/executionPlanModel.js');
const EP = await imp('apps/cf_erp/services/executionPlanService.js');
const POS = await imp('apps/cf_erp/services/productionOrderService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_FLOW_COMPANY ?? 2);
const RUN = `TEST-PB-${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)?.slice(0, 500)}, wanted ${JSON.stringify(want)?.slice(0, 500)}`);
const section = (s) => console.log(`\n${s}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}

// ---- A. pure ------------------------------------------------------------------------
section('A. Pure: pieces, batches → production orders, pieces stamped, checks');
{
  // As production_orders_test: a line of 2 spans; each span has 2 girder lines (definition 10, row 501, qty 2) with
  // a segment under each, and a loose item (row 502). Per Girder line: 4 girder lines + the rest of each span.
  const seg = { id: 3, lineId: 503, code: null, name: 'Segment', quantity: 1, children: [] };
  const girder = { id: 2, lineId: 501, code: null, name: 'Girder line', quantity: 2, children: [seg] };
  const loose = { id: 4, lineId: 502, code: null, name: 'Bolt set', quantity: 1, children: [] };
  const tree = { root: { id: 1, code: 'SO-X', name: 'Span', quantity: 2, children: [girder, loose] } };
  const defOf = (id) => (Number(id) === 2 ? { id: 10, name: 'Girder line' } : null);
  const shape = { levels: [{ id: 10, name: 'Girder line', perUnit: 2 }], outside: new Map([[10, true]]), hasRootFlow: false };
  const P = (level, levelId = null, groups = []) => ({ production: { level, levelId }, dispatch: { level: 'same', levelId: null }, groups });
  const line = (plan, more = {}) => ({ lineId: 77, lineNo: 1, quantity: 2, itemName: 'Span', plan, shape, tree, ...more });

  const pieces = MODEL.levelPieces(line(P('assembly', 10)), defOf);
  eq('per Girder line: 4 pieces in tree order, keyed as their own production orders would be', pieces.map((p) => p.key),
    ['L77U1A10:501#1', 'L77U1A10:501#2', 'L77U2A10:501#1', 'L77U2A10:501#2']);
  eq('…labelled with their span when the line has more than one', pieces.map((p) => p.label),
    ['Span 1 · Girder line #1', 'Span 1 · Girder line #2', 'Span 2 · Girder line #1', 'Span 2 · Girder line #2']);
  eq('per unit: the units', MODEL.levelPieces(line(P('unit')), defOf).map((p) => [p.key, p.label]), [['L77U1', 'Span 1'], ['L77U2', 'Span 2']]);
  eq('per line: nothing to batch', MODEL.levelPieces(line(P('line')), defOf), []);
  eq('a quantity that is not whole falls back to one per line: nothing to batch', MODEL.levelPieces(line(P('unit'), { quantity: 2.5 }), defOf), []);

  // Batch 1: span 1's first girder line with span 2's second (rows mixed freely); batch 2: span 1's second.
  const groups = [{ name: null, keys: ['L77U1A10:501#1', 'L77U2A10:501#2'] }, { name: 'Erection set B', keys: ['L77U1A10:501#2'] }];
  const asm = MODEL.plannedProductionOrders('SO260014', [line(P('assembly', 10, groups))], defOf);
  eq('batches: 2 batches + span 2\'s first girder line on its own + the rest of each span = 5', asm.map((x) => x.scopeKey),
    ['L77G1', 'L77G2', 'L77U1R', 'L77U2A10:501#1', 'L77U2R']);
  eq('a batch carries its members (their own scope keys), in tree order', asm[0].members, ['L77U1A10:501#1', 'L77U2A10:501#2']);
  ok('a batch\'s label names its first pieces; a named batch goes by its name',
    asm[0].label === 'SO260014 · Batch 1: Span 1 · Girder line #1, Span 2 · Girder line #2' && asm[1].label === 'SO260014 · Erection set B: Span 1 · Girder line #2', `${asm[0].label} | ${asm[1].label}`);
  ok('a batch across spans has no unit; one inside a span keeps it', asm[0].unitNo === null && asm[1].unitNo === 1 && asm[0].level === 'assembly' && asm[0].levelId === 10);
  ok('pieces on their own carry no members', asm[3].members === null && asm[2].members === null);
  const many = MODEL.plannedProductionOrders('SO260014', [line(P('assembly', 10, [{ name: null, keys: pieces.map((p) => p.key) }]))], defOf);
  ok('a big batch: "(+2 more)"', many[0].label === 'SO260014 · Batch 1: Span 1 · Girder line #1, Span 1 · Girder line #2 (+2 more)', many[0].label);

  // Counts agree: the model's quick count, the preview's exact one and the planned list.
  const L = line(P('assembly', 10, groups));
  eq('productionCount with batches: 6 - (2 - 1) = 5', M.productionCount(L, L.plan, shape), 5);
  const pv = M.previewOrder('SO260014', [L], defOf);
  eq('the preview counts and lists the batches', [pv.production.count, pv.production.items[0], pv.dispatch.count], [5, asm[0].label, 5]);
  ok('the plan in words says so', /2 batches together/.test(M.planWords(L.plan, shape)), M.planWords(L.plan, shape));

  // Release: every piece → its production order.
  let k = 0;
  const items = [];
  const add = (id, parent, depth, bom, itemId, pieceNo = 1, quantity = 1) => items.push({ id, parent_id: parent, depth, sort_order: ++k, bom_line_id: bom, item_id: itemId, piece_no: pieceNo, quantity });
  for (const u of [0, 1]) {
    const r = 100 + u * 10;
    add(r, null, 0, null, 1);
    add(r + 1, r, 1, 501, 2); add(r + 2, r + 1, 2, 503, 3);
    add(r + 3, r, 1, 501, 2); add(r + 4, r + 3, 2, 503, 3);
    add(r + 5, r, 1, 502, 4, null, 1);
  }
  // As stored: members_json is a JSON string on the row.
  const orders = asm.map((x, i) => ({ id: 900 + i, scope_key: x.scopeKey, level: x.level, level_id: x.levelId, members_json: x.members ? JSON.stringify(x.members) : null }));
  const map = MODEL.assignPieces(77, items, orders, defOf);
  const po = (key) => orders.find((o) => o.scope_key === key).id;
  ok('span 1 girder 1 (and its segment) and span 2 girder 2 (and its segment) → batch 1',
    [101, 102, 113, 114].every((i) => map.get(i) === po('L77G1')), JSON.stringify([...map]));
  ok('span 1 girder 2 → batch 2; span 2 girder 1 → its own', map.get(103) === po('L77G2') && map.get(104) === po('L77G2') && map.get(111) === po('L77U2A10:501#1'));
  ok('the spans and the loose items → the rest of each span, as before', map.get(100) === po('L77U1R') && map.get(105) === po('L77U1R') && map.get(110) === po('L77U2R') && map.get(115) === po('L77U2R'));

  // Per unit, batched: both spans in one production order.
  const units = MODEL.plannedProductionOrders('SO260014', [line(P('unit', null, [{ name: null, keys: ['L77U1', 'L77U2'] }]))], defOf);
  eq('per unit, both spans in one batch: one production order holding both', [units.length, units[0].scopeKey, units[0].members, units[0].level], [1, 'L77G1', ['L77U1', 'L77U2'], 'unit']);
  const uMap = MODEL.assignPieces(77, items, units.map((x, i) => ({ id: 800 + i, scope_key: x.scopeKey, level: x.level, level_id: null, members_json: JSON.stringify(x.members) })), defOf);
  ok('…every piece of both spans → it', items.every((it) => uMap.get(it.id) === 800));

  // No "rest": everything of a unit inside a girder line, all batched — the span itself joins a batch of its own.
  const tree2 = { root: { id: 1, code: 'SO-X', name: 'Span', quantity: 2, children: [girder] } };
  const shape2 = { levels: shape.levels, outside: new Map([[10, false]]), hasRootFlow: false };
  const g2 = [{ name: null, keys: ['L77U1A10:501#1', 'L77U1A10:501#2', 'L77U2A10:501#1'] }];
  const noRest = MODEL.plannedProductionOrders('SO260014', [line(P('assembly', 10, g2), { tree: tree2, shape: shape2 })], defOf);
  eq('no rest: one batch + the last girder line on its own', noRest.map((x) => x.scopeKey), ['L77G1', 'L77U2A10:501#2']);
  const items2 = items.filter((it) => ![105, 115].includes(it.id));
  const map2 = MODEL.assignPieces(77, items2, noRest.map((x, i) => ({ id: 700 + i, scope_key: x.scopeKey, level: x.level, level_id: x.levelId, members_json: x.members ? JSON.stringify(x.members) : null })), defOf);
  ok('…span 1 itself → the batch holding its girder lines; span 2 itself too (its first girder line is in it)', map2.get(100) === 700 && map2.get(110) === 700 && map2.get(113) === 701);

  // The checks.
  const plan = (gs) => P('assembly', 10, gs);
  eq('fine batches: no problem', M.checkGroups({ lineNo: 1 }, plan(groups), pieces), []);
  eq('a piece in two batches is named', M.checkGroups({ lineNo: 1 }, plan([{ name: null, keys: ['L77U1A10:501#1'] }, { name: null, keys: ['L77U1A10:501#1'] }]), pieces),
    ['Line 1: Span 1 · Girder line #1 is in Batch 1 and in Batch 2 — a piece goes in one batch only.']);
  eq('a piece the line does not have', M.checkGroups({ lineNo: 1 }, plan([{ name: null, keys: ['L77U9A10:501#1', 'L77U8A10:501#1'] }]), pieces),
    ['Line 1: Batch 1 names a piece the line does not have (L77U9A10:501#1) — choose its pieces again.']);
  eq('an empty batch', M.checkGroups({ lineNo: 2 }, plan([{ name: 'B', keys: [] }]), pieces), ['Line 2: B is empty — put pieces in it or remove it.']);
  eq('batches on a level that is not split', M.checkGroups({ lineNo: 1 }, P('line', null, groups), pieces), ['Line 1: batches need "Split into batches". Choose it again or clear the batches.']);

  // Plans: batches stored, read per line, compared.
  const row = { order_line_id: null, production_level: 'assembly', production_level_id: 10, dispatch_level: 'same', dispatch_level_id: null,
    groups_json: JSON.stringify([{ keys: ['L5U1A10:1#1', 'L5U1A10:1#2'] }, { keys: ['L6U1A10:1#1', 'L6U2A10:1#1'] }]) };
  eq('the order\'s row read whole: both lines\' batches', M.effectivePlan([row], -1).plan.groups.length, 2);
  eq('a line reading the order\'s row gets only its own batches', M.effectivePlan([row], 6).plan.groups, [{ name: null, keys: ['L6U1A10:1#1', 'L6U2A10:1#1'] }]);
  eq('batches count only on a split level', M.planOfRow({ ...row, production_level: 'line' }).groups, []);
  ok('samePlan sees batches', !M.samePlan(M.planOfRow(row), M.planOfRow({ ...row, groups_json: null })) && M.samePlan(M.planOfRow(row), M.planOfRow({ ...row })));
}

// ---- B. the service -----------------------------------------------------------------
const conn = await pool.getConnection();
let exitCode = 0;
let before = null;
try {
  before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const defId = async (name) => {
    const [[r]] = await conn.query("SELECT id FROM cf_master_records WHERE company_id = ? AND record_kind = 'definition' AND name = ? AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY, name]);
    if (!r) throw new Error(`Company ${COMPANY} has no active definition "${name}".`);
    return r.id;
  };
  const SPAN = await defId('Bridge span');
  const GL = await defId('Girder line');
  const [[cust]] = await conn.query('SELECT id FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  console.log(`\nCompany ${COMPANY}, run ${RUN}: Bridge span ${SPAN}, Girder line ${GL}`);

  section('B. The service: pieces, dry runs, refusals, save, production orders');
  const order0 = await SO.createOrder(conn, c, { orderType: 'customer', customerId: cust.id, title: 'batches test', code: RUN, committedDate: '2026-12-31' });
  await SO.addOrderLine(conn, c, order0.id, { recordId: SPAN, quantity: 3 });
  const order = await SO.addOrderLine(conn, c, order0.id, { recordId: SPAN, quantity: 1 });
  const [L1, L2] = order.lines;
  const tryPlan = (body) => EP.saveExecutionPlan(conn, c, order.id, { ...body, dryRun: true });
  const asm = { level: 'assembly', levelId: GL };

  let v = await EP.getExecutionPlan(conn, COMPANY, order.id);
  ok('per line: no pieces to batch', v.lines.every((l) => l.pieces.length === 0 && l.groups.length === 0));
  v = await tryPlan({ production: asm });
  const p1 = v.lines.find((l) => l.lineId === L1.id).pieces;
  const p2 = v.lines.find((l) => l.lineId === L2.id).pieces;
  ok('per Girder line: line 1 (×3) has 12 pieces, line 2 (×1) has 4', p1.length === 12 && p2.length === 4 && v.lines[0].piecesTotal === 12, `${p1.length} ${p2.length}`);
  ok('…keyed by line, span, level, path and instance; labelled "Bridge span 1 · Girder line 1"', p1[0].key.startsWith(`L${L1.id}U1A${GL}:`) && p1[0].label === 'Bridge span 1 · Girder line 1' && p2[0].label === 'Girder line 1', `${p1[0].key} ${p1[0].label} ${p2[0].label}`);
  const before20 = v.preview.production.count;
  eq('without batches: (4 + the rest) × 3 + (4 + the rest) = 20', before20, 20);

  // "Batch sizes 4, 8": line 1's first four girder lines, then the other eight.
  const g48 = [{ keys: p1.slice(0, 4).map((p) => p.key) }, { keys: p1.slice(4).map((p) => p.key) }];
  v = await tryPlan({ production: asm, groups: g48 });
  eq('batches of 4 and 8 on line 1: 2 + the rest of 3 spans + line 2\'s 5 = 10 production orders, no problem', [v.preview.production.count, v.problems], [10, []]);
  ok('…the first is "Batch 1: …(+2 more)"', v.preview.production.items[0] === `${RUN} · Line 1 · Batch 1: Bridge span 1 · Girder line 1, Bridge span 1 · Girder line 2 (+2 more)`, v.preview.production.items[0]);
  eq('…line 1 makes 5, and says it', [v.lines[0].productionCount, v.lines[0].groups.length], [5, 2]);
  ok('…the dispatch units follow (same as production orders)', v.preview.dispatch.count === 10);

  // Refusals, in words.
  v = await tryPlan({ production: asm, groups: [{ keys: [p1[0].key] }, { keys: [p1[0].key, p1[1].key] }] });
  ok('a piece in two batches is named', v.problems.some((p) => p === 'Line 1: Bridge span 1 · Girder line 1 is in Batch 1 and in Batch 2 — a piece goes in one batch only.'), JSON.stringify(v.problems));
  v = await tryPlan({ production: asm, groups: [{ keys: [`L${L1.id}U7A${GL}:1#1`] }] });
  ok('a piece the line does not have', v.problems.some((p) => /^Line 1: Batch 1 names a piece the line does not have/.test(p)), JSON.stringify(v.problems));
  v = await tryPlan({ production: asm, groups: [{ keys: [p1[0].key, p2[0].key] }] });
  ok('a batch mixing lines', v.problems.some((p) => p === 'Batches: Batch 1 mixes lines 1 and 2 — a batch holds pieces of one line.'), JSON.stringify(v.problems));
  v = await tryPlan({ production: asm, groups: [{ name: 'Empty', keys: [] }] });
  ok('an empty batch', v.problems.some((p) => p === 'Batches: Empty is empty — put pieces in it or remove it.'), JSON.stringify(v.problems));
  v = await tryPlan({ production: asm, groups: [{ keys: ['L999999U1'] }] });
  ok('a piece of no line of this order', v.problems.some((p) => /names a piece that is not on this order/.test(p)), JSON.stringify(v.problems));
  const refused = await refusal(() => EP.saveExecutionPlan(conn, c, order.id, { production: asm, groups: [{ keys: [p1[0].key] }, { keys: [p1[0].key] }] }));
  ok('a save with a bad batch is refused, the problem listed', refused?.status === 400 || /needs attention/.test(refused?.message ?? ''), String(refused?.message));

  // Save, read back.
  const saved = await EP.saveExecutionPlan(conn, c, order.id, { production: asm, dispatch: { level: 'same' }, groups: g48 });
  eq('saved: the order\'s plan holds the batches; line 1 reads them', [saved.plan.groups.length, saved.lines[0].groups.length, saved.lines[1].groups.length], [2, 2, 0]);
  const rows = await EP.planRowsOf(conn, COMPANY, [order.id]);
  ok('one row, the order\'s, with groups_json', rows.length === 1 && rows[0].order_line_id == null && (typeof rows[0].groups_json === 'string' ? JSON.parse(rows[0].groups_json) : rows[0].groups_json).length === 2);
  const again = await EP.saveExecutionPlan(conn, c, order.id, { production: asm, groups: g48 });
  eq('the same again writes nothing new', (await EP.planRowsOf(conn, COMPANY, [order.id])).map((r) => r.id), rows.map((r) => r.id));
  ok('not sent = kept', again.plan.groups.length === 2 && (await EP.saveExecutionPlan(conn, c, order.id, { dispatch: { level: 'same' } })).plan.groups.length === 2);
  ok('the stage words say so', /2 batches together/.test(saved.lines[0].words), saved.lines[0].words);
  v = await tryPlan({ production: { level: 'unit' } });
  ok('a change of level clears them', v.plan.groups.length === 0 && v.lines[0].pieces.length === 3 && v.lines[0].pieces[2].label === 'Bridge span 3', JSON.stringify(v.lines[0].pieces[2]));
  v = await tryPlan({ production: { level: 'line' }, groups: g48 });
  ok('batches on "one per line" are dropped, not stored', v.plan.groups.length === 0 && v.problems.length === 0);

  // A line of its own holds its own batches.
  v = await tryPlan({ production: { level: 'line' }, groups: [], lines: [{ lineId: L1.id, own: { production: { level: 'unit' }, dispatch: { level: 'same' }, groups: [{ keys: [`L${L1.id}U1`, `L${L1.id}U3`] }] } }] });
  eq('line 1 per unit with spans 1 and 3 together: 2 + line 2\'s 1 = 3', [v.preview.production.count, v.lines[0].groups.length, v.lines[0].source, v.problems], [3, 1, 'line', []]);
  v = await tryPlan({ lines: [{ lineId: L1.id, own: { production: { level: 'unit' }, dispatch: { level: 'same' }, groups: [{ keys: [`L${L2.id}U1`] }] } }] });
  ok('a line\'s own batch holding another line\'s piece is refused', v.problems.some((p) => p === 'Line 1, batches: Batch 1 holds pieces of another line.'), JSON.stringify(v.problems));

  // Production orders from the saved plan (4 + 8 on line 1).
  await EP.saveExecutionPlan(conn, c, order.id, { production: asm, dispatch: { level: 'same' }, groups: g48 });
  await conn.query("UPDATE cf_sales_orders SET status = 'confirmed' WHERE id = ?", [order.id]);
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE order_id = ?', [order.id]);
  const dry = await POS.createProductionOrders(conn, c, order.id, { dryRun: true });
  eq('create (dry run): 10 to make', [dry.toCreate, dry.why], [10, null]);
  await POS.createProductionOrders(conn, c, order.id, {});
  const [made] = await conn.query('SELECT scope_key, label, members_json FROM cf_production_orders WHERE order_id = ? AND deleted_at IS NULL ORDER BY seq', [order.id]);
  const mem = (r) => (r.members_json == null ? null : typeof r.members_json === 'string' ? JSON.parse(r.members_json) : r.members_json);
  // Each batch stands where its first piece stood: batch 1 (span 1), the rest of span 1, batch 2 (spans 2-3), …
  eq('10 production orders, a batch where its first piece stood (L<line>G1 / G2)', made.map((r) => r.scope_key).slice(0, 5),
    [`L${L1.id}G1`, `L${L1.id}U1R`, `L${L1.id}G2`, `L${L1.id}U2R`, `L${L1.id}U3R`]);
  eq('…each batch carrying its members', [made.length, mem(made[0])?.length, mem(made[1]), mem(made[2])?.length], [10, 4, null, 8]);
  eq('…members are the pieces\' own keys', mem(made[0]), g48[0].keys);
  const list = await POS.listProductionOrdersOf(conn, COMPANY, { orderIds: [order.id] });
  ok('the list shows a batch\'s members', list[0].members?.length === 4 && list[1].members === null);
} catch (e) {
  exitCode = 1;
  console.error(e);
} finally {
  try { detachNodeCache(conn); } catch { /* none */ }
  await conn.rollback();
  const after = await census(conn);
  const moved = Object.keys(after).filter((t) => after[t] !== before?.[t]);
  ok('rolled back: every cf_ table has the count it had', moved.length === 0, moved.join(', '));
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (fails.length) console.log(`Failed:\n  ${fails.join('\n  ')}`);
process.exit(failed || exitCode ? 1 : 0);
