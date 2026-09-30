/**
 * order_flow_test.mjs — the sales-order flow, straightened (CF_ERP_ORDER_FLOW_PLAN,
 * decided 2026-09-30). Against the local database.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/order_flow_test.mjs
 *
 *   CF_FLOW_COMPANY (2), CF_FLOW_LINE (923 — the local KEPL copy: locked, nested)
 *
 * The flow: lines → structure → values → cut pieces → FREEZE DESIGN (key lock)
 * → nesting → buying → production. Confirm is the order's sales status, not a
 * stage, and buying needs it.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK; the last thing
 * it does is re-count every cf_ table. Like release_nest_material_test it
 * BORROWS the real line on purpose (the point is the real nest and the real
 * 6,072-piece roll-out): inside the transaction it is un-frozen, re-cut,
 * re-frozen, confirmed, copied and released — never left so.
 *
 *   1. the stage train: the new order, confirm gone (a stored confirm row kept)
 *   2. confirm is allowed before the freeze; buying and production wait on it
 *      with action 'confirm'
 *   3. nesting is refused before the freeze, allowed after
 *   4. a NEW blank has no plate ("chosen at nesting"); the freeze works without
 *      it; release, buying and production then wait on the nest; a plate chosen
 *      by hand before the freeze does as well as a nest
 *   5. the buy list: a confirmed, frozen, nested, unreleased line is PLANNED
 *      rows, equal item for item to what release will ask; round trips for 1
 *      and 3 planned lines; after release it is released rows and nothing is
 *      counted twice
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache, invalidateNodeCache } = await imp('apps/cf_erp/lib/db.js');
const PROC = await imp('apps/cf_erp/services/processService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const CUT = await imp('apps/cf_erp/services/cutPlateService.js');
const NEST = await imp('apps/cf_erp/services/nestingService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const BUY = await imp('apps/cf_erp/services/purchaseService.js');

const COMPANY = Number(process.env.CF_FLOW_COMPANY ?? 2);
const LINE = Number(process.env.CF_FLOW_LINE ?? 923);
const RUN = `OF${Date.now().toString(36).toUpperCase()}`;
const EPS = 1e-6;
const TRAIN = ['lines', 'structure', 'values', 'cut_pieces', 'lock', 'nesting', 'buying', 'production'];

let passed = 0;
let failed = 0;
const fails = [];
/** ok(label, cond, detail?) — the LABEL FIRST, and a boolean; anything else throws rather than passing. */
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)?.slice(0, 300)}, wanted ${JSON.stringify(want)?.slice(0, 300)}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const section = (s) => console.log(`\n${s}`);

async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
/** Runs fn over a connection that counts its round trips. */
async function trips(conn, fn) {
  const tally = { n: 0 };
  const db = new Proxy(conn, {
    get: (target, prop) => (prop === 'query' || prop === 'execute'
      ? (...args) => { tally.n += 1; return target[prop](...args); }
      : Reflect.get(target, prop)),
  });
  const out = await fn(db);
  return { out, n: tally.n };
}
const sumBy = (rows, key, val) => { const m = new Map(); for (const r of rows) m.set(key(r), Number(((m.get(key(r)) ?? 0) + val(r)).toFixed(6))); return m; };
const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => Math.abs((b.get(k) ?? Number.NaN) - v) < EPS);
const mapDiff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => !(Math.abs((a.get(k) ?? Number.NaN) - (b.get(k) ?? Number.NaN)) < EPS))
  .slice(0, 5).map((k) => `${k}: ${a.get(k)} vs ${b.get(k)}`).join(', ');
const stageOf = (proc, key) => proc.lines.find((l) => l.lineId === LINE)?.stages.find((s) => s.stageKey === key);

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[line]] = await conn.query(
    `SELECT l.id, l.line_no, l.locked_at, l.order_id, l.item_id, l.quantity, o.code AS order_code, o.status, o.process_id, o.order_type
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?`,
    [COMPANY, LINE],
  );
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (await REL.liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is released — take it back first.`);
  if (!line.locked_at) throw new Error(`Line ${LINE} is not locked — this suite starts from a frozen, nested line.`);
  if (['confirmed', 'closed'].includes(line.status)) throw new Error(`${line.order_code} is ${line.status} — this suite starts from an unconfirmed order.`);
  console.log(`\nCompany ${COMPANY}, ${line.order_code} line ${line.line_no} (${LINE}) — run ${RUN}`);
  // A committed date, so the order can be confirmed (setOrderStatus asks for one).
  await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);

  /* ---- 1. the train ---------------------------------------------------------- */
  section('1. The stage train');
  eq('the catalogue is lines, structure, values, cut pieces, freeze, nesting, buying, production', PROC.STAGE_KEYS, TRAIN);
  eq('lock reads "Freeze design"', PROC.stageCatalogue().find((s) => s.key === 'lock')?.label, 'Freeze design');
  ok('confirm is not a stage a process can be built from', !PROC.stageCatalogue().some((s) => s.key === 'confirm'));
  if (line.process_id) {
    const proc = await PROC.getProcess(conn, COMPANY, line.process_id);
    ok('the order\'s process reads in the new order, without confirm', JSON.stringify(proc.stages.map((s) => s.stageKey)) === JSON.stringify(TRAIN.filter((k) => proc.stages.some((s) => s.stageKey === k))) && !proc.stages.some((s) => s.stageKey === 'confirm'),
      proc.stages.map((s) => s.stageKey).join(', '));
    const [[{ n: confirmRows }]] = await conn.query("SELECT COUNT(*) AS n FROM cf_process_stages WHERE company_id = ? AND process_id = ? AND stage_key = 'confirm' AND deleted_at IS NULL", [COMPANY, line.process_id]);
    // Saving the process again with a confirm stage in it (an older screen) is not refused; the stored row stays.
    await conn.query('SAVEPOINT resave');
    const resaved = await PROC.replaceStages(conn, c, line.process_id, { stages: [...proc.stages.map((s) => ({ stageKey: s.stageKey, requirement: s.requirement })), { stageKey: 'confirm' }] });
    const [[{ n: confirmAfter }]] = await conn.query("SELECT COUNT(*) AS n FROM cf_process_stages WHERE company_id = ? AND process_id = ? AND stage_key = 'confirm' AND deleted_at IS NULL", [COMPANY, line.process_id]);
    ok('re-saving with confirm in the list is accepted, and confirm is dropped from it', !resaved.stages.some((s) => s.stageKey === 'confirm') && resaved.stages.length === proc.stages.length);
    eq('a stored confirm row is not deleted', Number(confirmAfter), Number(confirmRows));
    await conn.query('ROLLBACK TO SAVEPOINT resave');
  }

  /* ---- 2. confirm before the freeze ------------------------------------------- */
  section('2. Confirm is the customer\'s yes — allowed before the freeze; buying waits on it');
  let proc = await PROC.orderProcess(conn, COMPANY, line.order_id);
  ok('the order\'s stages carry no confirm stage', !proc.stages.some((s) => s.stageKey === 'confirm'));
  const buyWait0 = stageOf(proc, 'buying')?.waitingOn;
  eq('buying waits on the header Confirm: no stage key, action confirm', [buyWait0?.stageKey, buyWait0?.action], [null, 'confirm']);
  eq('…in words', buyWait0?.message, 'Confirm the order first — nothing is bought for an inquiry.');
  eq('production waits on the same Confirm', stageOf(proc, 'production')?.waitingOn?.action, 'confirm');

  await conn.query('SAVEPOINT unfrozen');
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE company_id = ? AND id = ?', [COMPANY, LINE]);
  await conn.query('UPDATE cf_plate_lots SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  invalidateNodeCache(conn);
  proc = await PROC.orderProcess(conn, COMPANY, line.order_id);
  eq('with the design not frozen, the order can still be confirmed', proc.canConfirm, true);
  eq('nesting waits on the freeze', stageOf(proc, 'nesting')?.waitingOn?.stageKey, 'lock');
  const lockStage = stageOf(proc, 'lock');
  ok('the freeze does not wait on nesting or say anything about plates', lockStage?.waitingOn?.stageKey !== 'nesting' && !(lockStage?.blockers ?? []).some((b) => /plate/i.test(b.message)),
    JSON.stringify(lockStage?.blockers));

  section('3. Nesting is refused before the freeze');
  const planErr = await refusal(() => NEST.planNesting(conn, COMPANY, LINE, { effort: 'quick' }));
  ok('planNesting: "Freeze the design first"', planErr?.code === 'NOT_FROZEN' && /Freeze the design first — nesting lays out the frozen pieces\./.test(planErr.message), planErr?.message);
  eq('acceptNesting refuses it too', (await refusal(() => NEST.acceptNesting(conn, c, LINE, { groups: [] })))?.code, 'NOT_FROZEN');
  eq('and an imported sheet cannot be saved', NEST.importBlocker((await NEST.importContext(conn, COMPANY, LINE)).line)?.code, 'NOT_FROZEN');
  eq('the Nesting screen says the line is not frozen', (await NEST.getNesting(conn, COMPANY, LINE)).line?.frozen, false);

  await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
  const [[st]] = await conn.query('SELECT status FROM cf_sales_orders WHERE id = ?', [line.order_id]);
  eq('confirmed with the design not frozen', st.status, 'confirmed');
  proc = await PROC.orderProcess(conn, COMPANY, line.order_id);
  eq('confirmed, buying now waits on the freeze', stageOf(proc, 'buying')?.waitingOn?.stageKey, 'lock');
  eq('and production too', stageOf(proc, 'production')?.waitingOn?.stageKey, 'lock');
  await conn.query('ROLLBACK TO SAVEPOINT unfrozen');
  invalidateNodeCache(conn);

  section('3b. …and allowed after it');
  eq('frozen, an imported sheet can be saved', NEST.importBlocker((await NEST.importContext(conn, COMPANY, LINE)).line), null);
  eq('the Nesting screen says the line is frozen', (await NEST.getNesting(conn, COMPANY, LINE)).line?.frozen, true);

  /* ---- 4. a new blank: no plate; freeze without plates ------------------------ */
  section('4. A new cut piece has no plate; the design freezes without one');
  await conn.query('SAVEPOINT newblank');
  // Un-frozen for real: no stamp, no pieces (the freeze below writes them again).
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE company_id = ? AND id = ?', [COMPANY, LINE]);
  await conn.query('UPDATE cf_order_pieces SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  await conn.query('UPDATE cf_plate_lots SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  // The cut plate with the fewest parts: its parts let go of it, so the next
  // refresh drops it and makes a NEW blank for the same rectangle.
  const [cps] = await conn.query(
    `SELECT cp.id, COUNT(pl.id) AS parts
       FROM cf_master_records cp
       JOIN cf_item_details i ON i.master_id = cp.id AND i.deleted_at IS NULL AND i.owner_order_line_id = ?
       JOIN cf_classification_nodes n ON n.id = cp.classification_id AND n.code = 'CUT_PLATE'
       JOIN cf_bom_lines pl ON pl.company_id = cp.company_id AND pl.child_id = cp.id AND pl.deleted_at IS NULL
      WHERE cp.company_id = ? AND cp.deleted_at IS NULL
      GROUP BY cp.id ORDER BY parts, cp.id LIMIT 1`,
    [LINE, COMPANY],
  );
  const oldBlank = cps[0]?.id;
  if (!oldBlank) throw new Error('Line has no cut plates.');
  // The old blank goes altogether (its code with it), so the rectangle's next blank is a new one.
  await conn.query('UPDATE cf_bom_lines SET deleted_at = NOW() WHERE company_id = ? AND child_id = ? AND deleted_at IS NULL', [COMPANY, oldBlank]);
  await conn.query('UPDATE cf_boms SET deleted_at = NOW() WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, oldBlank]);
  await conn.query('UPDATE cf_master_records SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [COMPANY, oldBlank]);
  invalidateNodeCache(conn);
  const made = await CUT.refreshCutPieces(conn, c, LINE);
  ok('the refresh made one new cut piece', made.made === true && made.summary?.created === 1, JSON.stringify(made));
  const view = await CUT.getCutPlates(conn, COMPANY, LINE);
  const fresh = view.cutPlates.filter((x) => x.plateState === 'at_nesting');
  ok('exactly one cut piece shows "chosen at nesting" — the new one — with no plate', fresh.length === 1 && fresh[0].plate === null && fresh[0].id !== oldBlank && /chosen at nesting/.test(fresh[0].note ?? ''),
    JSON.stringify(view.cutPlates.map((x) => [x.code, x.plateState, x.plate?.code ?? null])));
  ok('every other cut piece keeps the plate it had', view.cutPlates.filter((x) => x.id !== fresh[0]?.id).every((x) => x.plateState === 'chosen' && x.plate != null));
  const [[freshLine]] = await conn.query(
    `SELECT ch.record_kind, l.selection_definition_id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
       JOIN cf_master_records ch ON ch.id = l.child_id WHERE b.parent_id = ? AND b.deleted_at IS NULL`, [fresh[0]?.id ?? 0]);
  ok('its Raw plate line holds the plate SELECTION, not a default plate', freshLine?.record_kind === 'definition' && freshLine.selection_definition_id != null, JSON.stringify(freshLine));
  proc = await PROC.orderProcess(conn, COMPANY, line.order_id);
  ok('the structure stage says nothing about the plate', !(stageOf(proc, 'structure')?.blockers ?? []).some((b) => /plate/i.test(b.message)));

  // A plate chosen by hand BEFORE the freeze does as well as a nest.
  await conn.query('SAVEPOINT byhand');
  const [[plateLine]] = await conn.query(
    'SELECT l.id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL WHERE b.parent_id = ? AND b.deleted_at IS NULL', [fresh[0].id]);
  const [[someone]] = await conn.query(
    `SELECT l.child_id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL JOIN cf_master_records ch ON ch.id = l.child_id AND ch.record_kind = 'item'
      WHERE b.parent_id IN (?) AND b.deleted_at IS NULL LIMIT 1`, [view.cutPlates.filter((x) => x.id !== fresh[0].id).map((x) => x.id)]);
  const handErr = await refusal(() => B.resolveLine(conn, c, plateLine.id, { itemId: someone.child_id }));
  if (handErr) {
    console.log(`        (a hand choice of that plate was refused: ${handErr.message} — skipping the by-hand path)`);
  } else {
    await CUT.refreshCutPieces(conn, c, LINE);
    await LOCK.lockLine(conn, c, LINE);
    await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
    const handCheck = await REL.releaseCheck(conn, COMPANY, LINE);
    ok('a plate chosen by hand: release does not ask for a nest', !handCheck.problems.some((p) => /no plate yet/.test(p)), handCheck.problems.slice(0, 3).join(' | '));
    const handPlanned = (await REL.plannedMaterialOfLines(conn, COMPANY, [line])).get(LINE);
    eq('…and the line is ready for the buy list', handPlanned?.ready, true);
  }
  await conn.query('ROLLBACK TO SAVEPOINT byhand');
  invalidateNodeCache(conn);

  const plan = await LOCK.lockPlan(conn, COMPANY, LINE);
  ok('the freeze check passes with a cut piece whose plate is chosen at nesting', plan.canLock === true, plan.problems.slice(0, 3).join(' | '));
  ok('…and says the plate comes at nesting', /gets its plate at nesting/.test(plan.checks.find((x) => x.key === 'structure')?.detail ?? ''), plan.checks.find((x) => x.key === 'structure')?.detail);
  const locked = await LOCK.lockLine(conn, c, LINE);
  ok('the design is frozen without the plate', !!locked.locked?.at && locked.locked.pieces > 0);
  await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
  const check = await REL.releaseCheck(conn, COMPANY, LINE);
  ok('release refuses a cut plate with no plate and no nest', check.problems.includes('1 cut plate has no plate yet — nest the line (or choose a plate).'), check.problems.slice(0, 4).join(' | '));
  const preview = await REL.releasePreview(conn, COMPANY, LINE);
  ok('the release preview says the same', preview.problems.includes('1 cut plate has no plate yet — nest the line (or choose a plate).'), preview.problems.slice(0, 4).join(' | '));
  const notReady = (await REL.plannedMaterialOfLines(conn, COMPANY, [line])).get(LINE);
  eq('the buy list does not plan it yet: 1 cut plate still without a plate', [notReady?.ready, notReady?.openPlates], [false, 1]);
  ok('…so it has no planned rows', !(await BUY.buyList(conn, COMPANY, { show: 'all' })).some((r) => r.planned && r.source?.lineId === LINE));
  proc = await PROC.orderProcess(conn, COMPANY, line.order_id);
  eq('buying waits on nesting', stageOf(proc, 'buying')?.waitingOn?.stageKey, 'nesting');
  eq('production waits on nesting too', stageOf(proc, 'production')?.waitingOn?.stageKey, 'nesting');
  await conn.query('ROLLBACK TO SAVEPOINT newblank');
  invalidateNodeCache(conn);

  /* ---- 5. the buy list plans the frozen, nested line --------------------------- */
  section('5. The buy list plans a confirmed, frozen, nested line before release');
  const listInquiry = await BUY.buyList(conn, COMPANY, { show: 'all' });
  ok('while the order is an inquiry the line is not on the buy list', !listInquiry.some((r) => r.planned && r.source?.lineId === LINE));
  await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
  proc = await PROC.orderProcess(conn, COMPANY, line.order_id);
  const buyStage = stageOf(proc, 'buying');
  ok('confirmed, frozen and nested: buying waits on nothing', buyStage?.waitingOn == null, JSON.stringify(buyStage?.waitingOn));
  console.log(`        buying: ${buyStage?.state} — ${buyStage?.detail}`);

  const one = await trips(conn, (db) => BUY.buyList(db, COMPANY, { show: 'all' }));
  const listPlanned = one.out;
  const mine = listPlanned.filter((r) => r.planned && r.source?.lineId === LINE);
  ok('the line is on the buy list as planned rows', mine.length > 0);
  ok('each names its order and line', mine.every((r) => r.source.orderId === line.order_id && r.source.orderCode === line.order_code && r.source.lineNo === line.line_no));
  const relCheck = await REL.releaseCheck(conn, COMPANY, LINE);
  const releaseWants = new Map(relCheck.materials.map((m) => [m.item.id, m.required]));
  const plannedWants = sumBy(mine, (r) => r.item.id, (r) => r.wanted);
  ok(`planned = what release will ask, item for item (${releaseWants.size} items)`, sameMap(releaseWants, plannedWants), mapDiff(releaseWants, plannedWants));
  const pm = await trips(conn, (db) => REL.plannedMaterialOfLines(db, COMPANY, [line]));
  console.log(`        round trips: plannedMaterialOfLines 1 line ${pm.n}; buy list with 1 planned line ${one.n}`);

  // Three planned lines: two copies of the frozen line (its pieces copied, codes suffixed; no nest, so their plates are the chosen ones).
  await conn.query('SAVEPOINT three');
  const copies = [];
  for (const k of [1, 2]) {
    const [ins] = await conn.query(
      `INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position)
       SELECT company_id, order_id, line_no + ?, line_type, item_id, design_id, position + ?, quantity, NOW(), lock_position + ? FROM cf_sales_order_lines WHERE id = ?`,
      [k * 1000, k * 1000, k * 1000, LINE],
    );
    const id = ins.insertId;
    await conn.query(
      `INSERT INTO cf_order_pieces (company_id, order_id, order_line_id, parent_id, item_id, bom_line_id, piece_no, piece_seq, quantity, code, rule_code, path_key, depth, sort_order, created_by)
       SELECT company_id, order_id, ?, parent_id, item_id, bom_line_id, piece_no, piece_seq, quantity, CONCAT(code, '-${RUN}${k}'), rule_code, path_key, depth, sort_order, created_by
         FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL`,
      [id, COMPANY, LINE],
    );
    // Point each copied piece at its parent's COPY (matched by path key, worked out here —
    // a path-key self-join over 6,072 rows has no index to use).
    const [orig] = await conn.query('SELECT id, path_key FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
    const [copy] = await conn.query('SELECT id, parent_id, path_key FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ?', [COMPANY, id]);
    const pathOf = new Map(orig.map((r) => [r.id, r.path_key]));
    const copyOf = new Map(copy.map((r) => [r.path_key, r.id]));
    const pairs = copy.filter((r) => r.parent_id != null).map((r) => [r.id, copyOf.get(pathOf.get(r.parent_id))]);
    for (let i = 0; i < pairs.length; i += 2000) {
      const chunk = pairs.slice(i, i + 2000);
      await conn.query(
        `UPDATE cf_order_pieces c JOIN (${chunk.map(() => 'SELECT ? AS id, ? AS parent').join(' UNION ALL ')}) m ON m.id = c.id SET c.parent_id = m.parent`,
        chunk.flat(),
      );
    }
    copies.push({ ...line, id, line_no: line.line_no + k * 1000 });
  }
  const pm3 = await trips(conn, (db) => REL.plannedMaterialOfLines(db, COMPANY, [line, ...copies]));
  const three = await trips(conn, (db) => BUY.buyList(db, COMPANY, { show: 'all' }));
  console.log(`        round trips: plannedMaterialOfLines 3 lines ${pm3.n}; buy list with 3 planned lines ${three.n}`);
  eq('plannedMaterialOfLines costs the same round trips for 3 lines as for 1', pm3.n, pm.n);
  eq('…and so does the buy list', three.n, one.n);
  ok('three planned lines are on the buy list', new Set(three.out.filter((r) => r.planned).map((r) => r.source.lineId)).size >= 3);
  await conn.query('ROLLBACK TO SAVEPOINT three');

  // Coverage is handed out once per item: the total to buy per item is wanted − held − free − on order.
  const byItem = new Map();
  for (const r of listPlanned) {
    const e = byItem.get(r.item.id) ?? { wanted: 0, reserved: 0, toBuy: 0, free: null, onOrder: null };
    e.wanted += r.wanted; e.reserved += r.reserved; e.toBuy += r.toBuy;
    if (e.free == null) { e.free = r.free; e.onOrder = r.onOrder; }       // the first row sees all of it
    byItem.set(r.item.id, e);
  }
  ok('per item, the rows\' to-buy adds up to wanted − held − free − on order (nothing covered twice)',
    [...byItem.values()].every((e) => Math.abs(e.toBuy - Math.max(0, e.wanted - e.reserved - e.free - e.onOrder)) < EPS));
  const suggestTotals = sumBy(listPlanned.filter((r) => r.toBuy > EPS), (r) => r.item.id, (r) => r.toBuy);
  await conn.query('SAVEPOINT suggest');
  const sug = await BUY.suggestPurchase(conn, c);
  const sugLines = sug.order?.lines ?? [];
  ok('Suggest PO includes the planned shortage — one line per item, the rows\' to-buy summed',
    sugLines.length === suggestTotals.size && new Set(sugLines.map((l) => l.item.id)).size === sugLines.length
      && sameMap(suggestTotals, new Map(sugLines.map((l) => [l.item.id, l.quantity]))), `${sugLines.length} lines vs ${suggestTotals.size} items`);
  await conn.query('ROLLBACK TO SAVEPOINT suggest');

  // Release: the planned rows become released rows, and nothing is counted twice.
  const releasedBefore = sumBy(listPlanned.filter((r) => !r.planned), (r) => r.item.id, (r) => r.wanted);
  const allBefore = sumBy(listPlanned, (r) => r.item.id, (r) => r.wanted);
  let rc = await REL.releaseCheck(conn, COMPANY, LINE);
  if (rc.needsFinishedArea && !rc.areas.some((a) => a.purpose === 'dispatch')) {
    await AREAS.createArea(conn, c, { code: `${RUN}-DSP`, name: 'Order flow test dispatch', purpose: 'dispatch' });
    rc = await REL.releaseCheck(conn, COMPANY, LINE);
  }
  ok('the nested line can be released', rc.ok, rc.problems.slice(0, 3).join(' | '));
  await REL.releaseLine(conn, c, LINE, rc.needsFinishedArea ? { finishedAreaId: rc.areas.find((a) => a.purpose === 'dispatch')?.id } : {});
  const listReleased = await BUY.buyList(conn, COMPANY, { show: 'all' });
  ok('released, the line has no planned rows any more', !listReleased.some((r) => r.planned && r.source?.lineId === LINE));
  const releasedAfter = sumBy(listReleased.filter((r) => !r.planned), (r) => r.item.id, (r) => r.wanted);
  const delta = new Map([...releasedAfter].map(([k, v]) => [k, Number((v - (releasedBefore.get(k) ?? 0)).toFixed(6))]).filter(([, v]) => Math.abs(v) > EPS));
  ok('the released rows grew by exactly what was planned', sameMap(plannedWants, delta), mapDiff(plannedWants, delta));
  const allAfter = sumBy(listReleased, (r) => r.item.id, (r) => r.wanted);
  ok('the buy list wants the same in all, item for item — never counted twice', sameMap(allBefore, allAfter), mapDiff(allBefore, allAfter));

  await conn.rollback();
  detachNodeCache(conn);
  const afterCensus = await census(conn);
  const moved = Object.keys(before).filter((t) => before[t] !== afterCensus[t]);
  ok('every cf_ table is back to its count', moved.length === 0, moved.map((t) => `${t} ${before[t]} -> ${afterCensus[t]}`).join(', '));
  const [[still]] = await conn.query('SELECT (SELECT COUNT(*) FROM cf_production_releases WHERE order_line_id = ? AND deleted_at IS NULL) AS rel, locked_at FROM cf_sales_order_lines WHERE id = ?', [LINE, LINE]);
  ok('line left as it was: frozen, not released', Number(still.rel) === 0 && !!still.locked_at);
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
