/**
 * work_order_test.mjs — contractor work orders (services/workOrderService.js,
 * init.sql §30): assigning (piece x operation) cells of a LOCKED line to
 * contractors, reassigning, back to in-house, reuse of the open work order,
 * the started-cell refusal (all or nothing), status transitions, cancel frees
 * cells, release stamps work_order_id (and est_* times), and a new revision
 * retires the cells. Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/work_order_test.mjs
 *   CF_WO_COMPANY=2 CF_WO_ORDER=887 CF_WO_LINE=923 (the defaults: the local KEPL copy)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK — the lock, the
 * revision (inside a savepoint), the release — and the last thing it does is
 * re-count every cf_ table. It owns its contractors, dispatch area and coding
 * rule-free numbering (WO-000123); every name carries this run's tag.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { lockLine } from '../../apps/cf_erp/services/lockService.js';
import { releaseLine, getRelease } from '../../apps/cf_erp/services/releaseService.js';
import { reviseOrder } from '../../apps/cf_erp/services/revisionService.js';
import {
  getAssignment, assignCells, listWorkOrders, getWorkOrder, updateWorkOrder, setWorkOrderStatus,
} from '../../apps/cf_erp/services/workOrderService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_WO_COMPANY ?? 2);
const ORDER = Number(process.env.CF_WO_ORDER ?? 887);
const LINE = Number(process.env.CF_WO_LINE ?? 923);
const tag = `WO${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let n = 0;
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { n++; return t.query(...a); } : Reflect.get(t, p)) });
const measured = async (fn) => { const at = n; const result = await fn(); return { result, queries: n - at }; };
const report = {};

/** Every cell of these rows, as { pieceId, operationId }. */
const cellsOf = (rows, opFilter = null) => rows.flatMap((r) => Object.keys(r.cells).map(Number)
  .filter((o) => !opFilter || opFilter(o)).map((operationId) => ({ pieceId: r.pieceId, operationId })));
/** A row and everything under it, the way the grid's row header selects a subtree. */
function subtree(view, key) {
  const kids = new Map();
  for (const r of view.rows) {
    if (!kids.has(r.parentKey)) kids.set(r.parentKey, []);
    kids.get(r.parentKey).push(r);
  }
  const out = [];
  const walk = (r) => { out.push(r); for (const k of kids.get(r.key) ?? []) walk(k); };
  walk(view.rows.find((r) => r.key === key));
  return out;
}
const ownerOf = (view, cell) => view.rows.find((r) => r.pieceId === cell.pieceId)?.cells[cell.operationId];

try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };
  const insert = async (table, body) => { const [r] = await conn.query(`INSERT INTO ${table} SET ?`, body); return r.insertId; };
  // Numbering: switch off any work-order coding rule for the transaction, so WO-000123 is what we get.
  await conn.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type = 'work_order'", [COMPANY]);
  const party = (suffix, sub = 1) => insert('cf_parties', { company_id: COMPANY, code: `${tag}-${suffix}`, name: `${tag} ${suffix}`, is_subcontractor: sub });
  const A = await party('A');
  const B = await party('B');
  const notSub = await party('CUST', 0);

  section('Not locked');
  // The local KEPL line may already be locked (the planner's local set-up locks it):
  // it is unlocked inside this transaction for this section and put back after.
  const [[lockState]] = await conn.query('SELECT locked_at FROM cf_sales_order_lines WHERE company_id = ? AND id = ?', [COMPANY, LINE]);
  const wasLocked = !!lockState?.locked_at;
  if (wasLocked) await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE company_id = ? AND id = ?', [COMPANY, LINE]);
  let v = await getAssignment(conn, COMPANY, ORDER, LINE);
  ok('before lock: no rows, and one line of why', v.line.locked === false && v.rows.length === 0 && /Freeze the design first/.test(v.line.why ?? ''), JSON.stringify(v.line));
  ok('the contractors are listed (subcontractors only)', v.contractors.some((p) => p.id === A) && !v.contractors.some((p) => p.id === notSub));
  let err = await refusal(() => assignCells(conn, c, ORDER, LINE, { cells: [{ pieceId: 1, operationId: 1 }], contractorId: A }));
  ok('assigning on an unlocked line is refused (422 NOT_LOCKED)', err?.status === 422 && err.code === 'NOT_LOCKED', err?.message);

  if (wasLocked) await conn.query('UPDATE cf_sales_order_lines SET locked_at = ? WHERE company_id = ? AND id = ?', [lockState.locked_at, COMPANY, LINE]);
  else await lockLine(conn, c, LINE);
  section('Locked: the grid');
  let g = await measured(() => getAssignment(db, COMPANY, ORDER, LINE));
  report.getQueries = g.queries;
  v = g.result;
  report.rows = v.rows.length;
  ok(`GET reads the piece tree in a fixed number of round trips (${g.queries}, ${v.rows.length} pieces)`, g.queries <= 12, `${g.queries}`);
  ok('every piece is a row keyed by its id', v.rows.length > 0 && v.rows.every((r) => r.key === String(r.pieceId)));
  ok('every cell starts in-house and editable', v.rows.every((r) => Object.values(r.cells).every((cl) => cl.workOrderId === null && cl.editable && !cl.started)));
  ok('no work orders yet', v.workOrders.length === 0);

  const [[bl]] = await conn.query('SELECT id, bom_line_id FROM cf_order_pieces WHERE id = ?', [v.rows[v.rows.length - 1].pieceId]);
  ok('every row carries its bomLineId (null only for the line\'s own item)', v.rows.every((r) => r.bomLineId === null || Number.isInteger(r.bomLineId))
    && v.rows.some((r) => r.bomLineId != null) && v.rows[v.rows.length - 1].bomLineId === bl.bom_line_id);

  // The sales order's committed date becomes a new work order's due date.
  await conn.query("UPDATE cf_sales_orders SET committed_date = '2026-11-15' WHERE id = ?", [ORDER]);
  // A segment piece with parts under it: the row header selects its subtree.
  const seg = v.rows.find((r) => r.depth === 2 && v.rows.some((x) => x.parentKey === r.key));
  const sub = subtree(v, seg.key);
  const subCells = cellsOf(sub);
  section(`Assign a subtree (${seg.code}, ${sub.length} pieces, ${subCells.length} cells) to contractor A`);
  let p = await measured(() => assignCells(db, c, ORDER, LINE, { cells: subCells, contractorId: A }));
  report.postQueries = p.queries;
  ok(`POST in a fixed number of round trips (${p.queries})`, p.queries <= 25, `${p.queries}`);
  v = p.result;
  const woA = v.workOrders.find((w) => w.contractorId === A);
  ok('a draft work order is made for A, numbered WO-000123 without a rule', !!woA && woA.status === 'draft' && /^WO-\d{6}$/.test(woA.code), JSON.stringify(woA));
  ok('it holds exactly the subtree\'s cells', woA.cellCount === subCells.length);
  ok('every one of them now shows A', subCells.every((cl) => ownerOf(v, cl).contractorId === A && ownerOf(v, cl).workOrderId === woA.id && ownerOf(v, cl).contractorName === `${tag} A`));
  ok('a new work order\'s due date defaults to the sales order\'s committed date', (await getWorkOrder(conn, COMPANY, woA.id)).dueDate === '2026-11-15');
  const subKeys = new Set(sub.map((r) => r.key));
  const outside = v.rows.filter((r) => !subKeys.has(r.key)).slice(0, 200);
  ok('cells outside it stay in-house', cellsOf(outside).every((cl) => ownerOf(v, cl).workOrderId === null));

  section('Reassign part of it to B');
  const first = sub.find((r) => r.key !== seg.key);
  const firstCells = cellsOf([first]);
  v = await assignCells(conn, c, ORDER, LINE, { cells: firstCells, contractorId: B });
  const woB = v.workOrders.find((w) => w.contractorId === B);
  ok('B gets its own draft', !!woB && woB.id !== woA.id && woB.cellCount === firstCells.length);
  ok('A loses those cells (one owner per cell)', v.workOrders.find((w) => w.id === woA.id).cellCount === subCells.length - firstCells.length);
  const [[{ dup }]] = await conn.query(
    'SELECT COUNT(*) AS dup FROM (SELECT order_piece_id, operation_id FROM cf_work_order_cells WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL GROUP BY 1, 2 HAVING COUNT(*) > 1) x',
    [COMPANY, LINE]);
  ok('no cell has two live owners', Number(dup) === 0);

  section('Open work order reuse');
  const more = cellsOf(v.rows.filter((r) => !subKeys.has(r.key)).slice(0, 3));
  v = await assignCells(conn, c, ORDER, LINE, { cells: more, contractorId: A });
  ok('more cells for A land on the SAME open work order', v.workOrders.filter((w) => w.contractorId === A).length === 1
    && v.workOrders.find((w) => w.id === woA.id).cellCount === subCells.length - firstCells.length + more.length);
  v = await assignCells(conn, c, ORDER, LINE, { cells: more, contractorId: A });
  ok('assigning cells already there changes nothing', v.workOrders.find((w) => w.id === woA.id).cellCount === subCells.length - firstCells.length + more.length);

  section('Back to in-house');
  v = await assignCells(conn, c, ORDER, LINE, { cells: firstCells, contractorId: null });
  ok('null takes cells back in-house', firstCells.every((cl) => ownerOf(v, cl).workOrderId === null));
  ok('B\'s draft, left empty, is removed', !v.workOrders.some((w) => w.id === woB.id));
  const [[{ gone }]] = await conn.query('SELECT deleted_at IS NOT NULL AS gone FROM cf_work_orders WHERE id = ?', [woB.id]);
  ok('(soft-deleted, not dropped)', Number(gone) === 1);

  section('Refusals');
  err = await refusal(() => assignCells(conn, c, ORDER, LINE, { cells: firstCells, contractorId: notSub }));
  ok('a party that is not a subcontractor is refused', err?.status === 422 && err.code === 'NOT_A_CONTRACTOR', err?.message);
  const notInFlow = v.operations.find((o) => !first.cells[o.id]);
  err = await refusal(() => assignCells(conn, c, ORDER, LINE, { cells: [firstCells[0], { pieceId: first.pieceId, operationId: notInFlow.id }], contractorId: B }));
  ok('an operation not in the piece\'s flow is refused, and nothing is written', err?.status === 422 && ownerOf(await getAssignment(conn, COMPANY, ORDER, LINE), firstCells[0]).workOrderId === null, err?.message);
  err = await refusal(() => assignCells(conn, c, ORDER, LINE, { cells: [{ pieceId: 999999999, operationId: notInFlow.id }], contractorId: B }));
  ok('a piece of another line is refused', err?.status === 422, err?.message);
  err = await refusal(() => assignCells(conn, c, ORDER + 100000, LINE, { cells: firstCells, contractorId: B }));
  ok('a line addressed through the wrong order is refused', err?.code === 'WRONG_ORDER', err?.message);

  section('Several groups in one call (one transaction)');
  const inFirst = new Set(firstCells.map((x) => `${x.pieceId}:${x.operationId}`));
  const xCell = subCells.find((x) => !inFirst.has(`${x.pieceId}:${x.operationId}`) && ownerOf(v, x).contractorId === A);
  v = await assignCells(conn, c, ORDER, LINE, { assignments: [{ cells: firstCells, contractorId: B }, { cells: [xCell], contractorId: null }] });
  ok('two groups apply together: first cells go to B, the other back in-house', firstCells.every((cl) => ownerOf(v, cl).contractorId === B) && ownerOf(v, xCell).workOrderId === null);
  ok('B got ONE work order for its group', v.workOrders.filter((x) => x.contractorId === B).length === 1);
  err = await refusal(() => assignCells(conn, c, ORDER, LINE, { assignments: [{ cells: [xCell], contractorId: A }, { cells: [{ pieceId: first.pieceId, operationId: notInFlow.id }], contractorId: B }] }));
  v = await getAssignment(conn, COMPANY, ORDER, LINE);
  ok('all or nothing: a bad second group leaves the first unapplied', err?.status === 422 && ownerOf(v, xCell).workOrderId === null, err?.message);
  err = await refusal(() => assignCells(conn, c, ORDER, LINE, { assignments: [{ cells: [xCell], contractorId: A }, { cells: firstCells, contractorId: notSub }] }));
  v = await getAssignment(conn, COMPANY, ORDER, LINE);
  ok('a non-subcontractor in a later group refuses the whole call', err?.code === 'NOT_A_CONTRACTOR' && ownerOf(v, xCell).workOrderId === null, err?.message);
  err = await refusal(() => assignCells(conn, c, ORDER, LINE, { assignments: [] }));
  ok('an empty assignments list is refused', err?.status === 422, err?.message);
  v = await assignCells(conn, c, ORDER, LINE, { assignments: [{ cells: [xCell], contractorId: B }, { cells: [xCell], contractorId: A }] });
  ok('a cell named twice takes the last group', ownerOf(v, xCell).contractorId === A && v.workOrders.filter((x) => x.contractorId === A).length === 1);
  v = await assignCells(conn, c, ORDER, LINE, { assignments: [{ cells: firstCells, contractorId: null }] });
  ok('(cleaned up: B\'s draft is gone, x is A\'s again)', !v.workOrders.some((x) => x.contractorId === B) && ownerOf(v, xCell).contractorId === A);

  section('Status transitions');
  v = await assignCells(conn, c, ORDER, LINE, { cells: firstCells, contractorId: B });
  const woB2 = v.workOrders.find((w) => w.contractorId === B);
  ok('B gets a fresh draft', !!woB2 && woB2.id !== woB.id);
  let w = await setWorkOrderStatus(conn, c, woB2.id, 'issued');
  ok('draft -> issued', w.status === 'issued' && w.next.includes('in_progress'));
  err = await refusal(() => setWorkOrderStatus(conn, c, woB2.id, 'done'));
  ok('issued -> done is refused (409): in progress first', err?.status === 409 && err.code === 'BAD_TRANSITION', err?.message);
  v = await assignCells(conn, c, ORDER, LINE, { cells: cellsOf([sub[sub.length - 1]]), contractorId: B });
  ok('an ISSUED work order still takes cells (it is open)', v.workOrders.filter((x) => x.contractorId === B && x.status !== 'cancelled').length === 1);
  w = await setWorkOrderStatus(conn, c, woB2.id, 'cancelled');
  ok('issued -> cancelled', w.status === 'cancelled' && w.cellCount === 0);
  v = await getAssignment(conn, COMPANY, ORDER, LINE);
  ok('cancel frees its cells: back in-house', firstCells.every((cl) => ownerOf(v, cl).workOrderId === null));
  ok('a cancelled work order leaves the line\'s strip', !v.workOrders.some((x) => x.id === woB2.id));
  err = await refusal(() => setWorkOrderStatus(conn, c, woB2.id, 'issued'));
  ok('a cancelled work order goes nowhere', err?.status === 409, err?.message);

  // What A holds now, from the database: the subtree, less the piece moved to B
  // and the one B took and gave back by cancelling, plus the three added later.
  const [aRows] = await conn.query('SELECT order_piece_id, operation_id FROM cf_work_order_cells WHERE company_id = ? AND work_order_id = ? AND deleted_at IS NULL', [COMPANY, woA.id]);
  const owned = new Set(aRows.map((x) => `${x.order_piece_id}:${x.operation_id}`));
  const aPieces = new Set(aRows.map((x) => x.order_piece_id));

  section('Dates, list, detail');
  err = await refusal(() => updateWorkOrder(conn, c, woA.id, { startDate: '2026-10-10', dueDate: '2026-10-01' }));
  ok('a due date before the start is refused', err?.status === 422, err?.message);
  w = await updateWorkOrder(conn, c, woA.id, { startDate: '2026-10-01', dueDate: '2026-10-20', notes: 'Fit-up and welding' });
  ok('dates and notes are saved', w.startDate === '2026-10-01' && w.dueDate === '2026-10-20' && w.notes === 'Fit-up and welding');
  const list = await listWorkOrders(conn, COMPANY, { contractorId: A });
  ok('the list filters by contractor', list.length === 1 && list[0].id === woA.id && list[0].order.id === ORDER);
  ok('the list filters by status', (await listWorkOrders(conn, COMPANY, { status: 'cancelled', orderId: ORDER })).some((x) => x.id === woB2.id));
  w = await getWorkOrder(conn, COMPANY, woA.id);
  ok('the detail groups its scope by piece, in tree order', w.scope.length === aPieces.size && w.cellCount === owned.size
    && JSON.stringify(w.scope.map((x) => x.pieceId)) === JSON.stringify(v.rows.filter((r) => aPieces.has(r.pieceId)).map((r) => r.pieceId)) && w.scope.every((s) => s.operations.length > 0), JSON.stringify(w.scope.slice(0, 2)));
  ok('no progress before release', w.progress === null);

  section('A new revision retires the cells');
  await conn.query('SAVEPOINT before_revision');
  await reviseOrder(conn, c, ORDER);
  const [[newLine]] = await conn.query('SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND revises_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  // The local KEPL copy has an old top coding rule that reads item.code; the
  // copied line item has none yet, so give it one (production rules do not need it).
  await conn.query("UPDATE cf_master_records m JOIN cf_sales_order_lines l ON l.item_id = m.id JOIN cf_master_records o ON o.id = (SELECT item_id FROM cf_sales_order_lines WHERE id = ?) SET m.code = CONCAT(o.code, '-R2') WHERE l.id = ? AND m.code IS NULL", [LINE, newLine.id]);
  await lockLine(conn, c, newLine.id);
  const [[{ liveCells }]] = await conn.query('SELECT COUNT(*) AS liveCells FROM cf_work_order_cells WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  ok('locking rev 2 retires rev 1\'s pieces AND their work-order cells', Number(liveCells) === 0);
  const [[woAfter]] = await conn.query('SELECT status FROM cf_work_orders WHERE id = ?', [woA.id]);
  ok('an open work order left empty is cancelled', woAfter.status === 'cancelled');
  const [newOrder] = (await conn.query('SELECT order_id FROM cf_sales_order_lines WHERE id = ?', [newLine.id]))[0];
  const vNew = await getAssignment(conn, COMPANY, newOrder.order_id, newLine.id);
  ok('rev 2\'s pieces start in-house', vNew.rows.length > 0 && vNew.rows.every((r) => Object.values(r.cells).every((cl) => cl.workOrderId === null)));
  const vOld = await getAssignment(conn, COMPANY, ORDER, LINE);
  ok('rev 1 is read-only (revised)', /revised/.test(vOld.line.why ?? '') || vOld.rows.length === 0, JSON.stringify(vOld.line));
  await conn.query('ROLLBACK TO SAVEPOINT before_revision');
  const [[{ backCells }]] = await conn.query('SELECT COUNT(*) AS backCells FROM cf_work_order_cells WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  ok('(rolled back to before the revision: A holds its cells again)', Number(backCells) === owned.size);

  section('Release stamps work orders and times');
  await conn.query("UPDATE cf_sales_orders SET status = 'confirmed' WHERE id = ?", [ORDER]);
  await insert('cf_stocking_areas', { company_id: COMPANY, code: `${tag}-DSP`, name: `${tag} dispatch`, purpose: 'dispatch' });
  // Some time to copy onto the steps: CRNMV 5 per piece + 2 setup.
  const [[crn]] = await conn.query("SELECT id FROM cf_operations WHERE company_id = ? AND code = 'CRNMV' AND deleted_at IS NULL", [COMPANY]);
  // Only CRNMV gets a time; every other rule is cleared inside the transaction (local rules may carry placeholder times).
  await conn.query('UPDATE cf_operation_machine_rules SET work_minutes = NULL, setup_minutes = NULL WHERE company_id = ? AND deleted_at IS NULL AND work_formula_id IS NULL', [COMPANY]);
  await conn.query('UPDATE cf_operation_machine_rules SET work_minutes = 5, setup_minutes = 2 WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [COMPANY, crn.id]);
  // A typed time wins over the formula at release too.
  const segBomLine = (await conn.query('SELECT bom_line_id FROM cf_order_pieces WHERE id = ?', [seg.pieceId]))[0][0].bom_line_id;
  await insert('cf_time_overrides', { company_id: COMPANY, order_line_id: LINE, bom_line_id: segBomLine, operation_id: crn.id, work_minutes: 11 });
  const t0 = Date.now();
  const rel = await measured(() => releaseLine(db, c, LINE, {}));
  report.releaseMs = Date.now() - t0;
  report.releaseQueries = rel.queries;
  const [steps] = await conn.query(
    `SELECT s.id, s.operation_id, s.work_order_id, s.quantity, s.est_setup_minutes, s.est_work_minutes, s.est_minutes, pi.order_piece_id, pi.code
       FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.company_id = ? AND pi.release_id = (SELECT id FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL)
        AND s.deleted_at IS NULL`, [COMPANY, COMPANY, LINE]);
  const stamped = steps.filter((s) => s.work_order_id != null);
  ok('every production item remembers its locked piece', steps.every((s) => s.order_piece_id != null));
  ok('release sets work_order_id on exactly the steps of A\'s cells', stamped.length > 0 && stamped.every((s) => s.work_order_id === woA.id && owned.has(`${s.order_piece_id}:${s.operation_id}`))
    && steps.filter((s) => owned.has(`${s.order_piece_id}:${s.operation_id}`)).every((s) => s.work_order_id === woA.id), `${stamped.length} stamped`);
  const crnSteps = steps.filter((s) => s.operation_id === crn.id);
  ok('CRNMV steps carry the estimate: est = setup + work × quantity', crnSteps.length > 0 && crnSteps.every((s) => Number(s.est_setup_minutes) === 2
    && Math.abs(Number(s.est_minutes) - (2 + Number(s.est_work_minutes) * Number(s.quantity))) < 0.01));
  ok('the typed time (11) wins over the formula (5) on the segment\'s steps', crnSteps.filter((s) => s.order_piece_id === seg.pieceId).every((s) => Number(s.est_work_minutes) === 11)
    && crnSteps.some((s) => s.order_piece_id === seg.pieceId) && crnSteps.filter((s) => s.order_piece_id !== seg.pieceId).every((s) => [5, 11].includes(Number(s.est_work_minutes))));
  ok('a step with no rule time has no estimate (never invented)', steps.filter((s) => s.operation_id !== crn.id).every((s) => s.est_work_minutes === null && s.est_minutes === null));

  section('After release');
  v = await getAssignment(conn, COMPANY, ORDER, LINE);
  const pendingCell = firstCells[0];
  v = await assignCells(conn, c, ORDER, LINE, { cells: [pendingCell], contractorId: B });
  const woB3 = v.workOrders.find((x) => x.contractorId === B);
  let [moved] = await conn.query(
    `SELECT s.work_order_id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.order_piece_id = ? AND s.operation_id = ? AND s.deleted_at IS NULL AND pi.deleted_at IS NULL`, [pendingCell.pieceId, pendingCell.operationId]);
  ok('a released line: assigning moves the pending steps to the work order', moved.length > 0 && moved.every((s) => s.work_order_id === woB3.id));
  await assignCells(conn, c, ORDER, LINE, { cells: [pendingCell], contractorId: null });
  [moved] = await conn.query(
    `SELECT s.work_order_id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.order_piece_id = ? AND s.operation_id = ? AND s.deleted_at IS NULL AND pi.deleted_at IS NULL`, [pendingCell.pieceId, pendingCell.operationId]);
  ok('... and back in-house clears them', moved.every((s) => s.work_order_id === null));

  // Start one of A's cells on the floor.
  const startedStep = stamped[0];
  await conn.query("UPDATE cf_production_steps SET state = 'in_progress', started_at = NOW() WHERE id = ?", [startedStep.id]);
  const startedCell = { pieceId: startedStep.order_piece_id, operationId: startedStep.operation_id };
  const freeCell = [...owned].map((k) => k.split(':').map(Number)).map(([pieceId, operationId]) => ({ pieceId, operationId }))
    .find((x) => !(x.pieceId === startedCell.pieceId && x.operationId === startedCell.operationId));
  v = await getAssignment(conn, COMPANY, ORDER, LINE);
  ok('a started cell shows started and not editable', ownerOf(v, startedCell).started === true && ownerOf(v, startedCell).editable === false);
  err = await refusal(() => assignCells(conn, c, ORDER, LINE, { cells: [freeCell, startedCell], contractorId: B }));
  ok('a request touching a started cell is refused (422 STARTED), naming piece and operation', err?.status === 422 && err.code === 'STARTED'
    && (err.problems ?? []).length === 1 && err.problems[0].startsWith(startedStep.code), JSON.stringify(err?.problems));
  v = await getAssignment(conn, COMPANY, ORDER, LINE);
  ok('all or nothing: the other cell did not move either', ownerOf(v, freeCell).workOrderId === woA.id);
  err = await refusal(() => setWorkOrderStatus(conn, c, woA.id, 'cancelled'));
  ok('a work order with started work cannot be cancelled', err?.status === 409 && err.code === 'STARTED', err?.message);
  await setWorkOrderStatus(conn, c, woA.id, 'issued');
  await setWorkOrderStatus(conn, c, woA.id, 'in_progress');
  w = await setWorkOrderStatus(conn, c, woA.id, 'done');
  ok('issued -> in_progress -> done', w.status === 'done' && w.next.length === 0);
  ok('progress counts its released steps', w.progress && w.progress.total === stamped.length && w.progress.started >= 1, JSON.stringify(w.progress));
  const [listed] = await listWorkOrders(conn, COMPANY, { contractorId: A });
  ok('the list row is flat, as the Work orders page reads it', listed.orderId === ORDER && typeof listed.orderCode === 'string' && listed.orderLineId === LINE
    && listed.lineNo != null && listed.contractorName === `${tag} A` && listed.progress?.total === stamped.length, JSON.stringify(listed).slice(0, 300));
  ok('status=open leaves out a done work order', !(await listWorkOrders(conn, COMPANY, { status: 'open', contractorId: A })).length);
  const [[relRow]] = await conn.query('SELECT id FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  const relView = await getRelease(conn, COMPANY, relRow.id);
  const trackerSteps = JSON.stringify(relView).match(/"workOrderId":\d+,"workOrderCode":"[^"]+","contractorName":"[^"]+"/g) ?? [];
  ok('the tracker\'s steps carry workOrderId, workOrderCode and contractorName', trackerSteps.length === stamped.length, `${trackerSteps.length}`);
  err = await refusal(() => updateWorkOrder(conn, c, woA.id, { notes: 'late change' }));
  ok('a done work order no longer changes', err?.status === 422, err?.message);
} catch (e) {
  failed++;
  console.error('FAIL', e.stack, e.problems ?? '');
} finally {
  await conn.rollback();
  detachNodeCache(conn);
  conn.release();
}
ok('every CF table count restored', JSON.stringify(before) === JSON.stringify(await counts()));
await pool.end();
console.log(`\nround trips: GET assignment ${report.getQueries} (${report.rows} pieces), POST ${report.postQueries}; release ${report.releaseQueries} queries in ${report.releaseMs} ms (row-by-row inserts, unchanged)`);
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
