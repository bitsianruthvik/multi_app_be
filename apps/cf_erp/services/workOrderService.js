/**
 * workOrderService.js — contractor work orders (init.sql §30).
 *
 * The user, 2026-09-29: split the production order into WORK ORDERS done by
 * contractors — "L11 by one contractor for some operations, L12 by another" —
 * easy to do, and kept separate from the production order (which is the
 * in-house work). So the unit of assignment is a CELL: one locked piece
 * (cf_order_pieces) x one operation of that piece's flow. A cell on no work
 * order is in-house; a cell has at most one work order (uq_cwoc_cell).
 *
 *   GET  /orders/:o/lines/:l/assignment    the piece tree x operations grid
 *   POST /orders/:o/lines/:l/assignment    { cells: [{ pieceId, operationId }], contractorId | null }
 *   GET  /work-orders, GET /work-orders/:id, PATCH /work-orders/:id, POST /work-orders/:id/status
 *
 * RULES (decisions 2 and 4 of TM/CF_ERP_TIMES_WORKORDERS_PLAN.md)
 *   - The line must be LOCKED: that is when L11 and L12 exist as pieces.
 *   - A cell may be assigned and reassigned until that operation STARTS on the
 *     floor; after that it belongs to whoever started it. A request that
 *     touches a started cell is refused whole (all or nothing), naming each.
 *   - Contractor = a party with is_subcontractor = 1. No new master.
 *   - Assigning puts the cells on that contractor's OPEN (draft / issued) work
 *     order for the line, making a draft one if there is none. A draft left
 *     with no cells by a move is removed — nobody issued it, it was only the
 *     container this screen made. An issued one stays, even empty, because it
 *     may already be on paper at the contractor's.
 *   - A released line: the pending steps of the moved cells take the new
 *     work_order_id (NULL = back in-house) in the same transaction.
 *   - Cancelling a work order frees its cells (they go back in-house) and
 *     clears its pending steps.
 *
 * ROUND TRIPS: GET about 10 whatever the size of the line (line, pieces,
 * flows, flow steps, cells, steps when released, contractors, work orders);
 * POST the same load FOR UPDATE, plus a fixed handful of writes (retire, insert,
 * steps, an emptied draft) and 3-4 for a new work order's number.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { generate } from '../modules/codegen/index.js';
import { lineOnOrder, orderClosedWhy, flowSteps, opsOfFlow } from './timeEstimateService.js';
import { dateText } from './resolutionService.js';

export const WO_STATUSES = ['draft', 'issued', 'in_progress', 'done', 'cancelled'];
/** Where a cell can be added: a work order the contractor has not started on. */
const OPEN_FOR_CELLS = new Set(['draft', 'issued']);
const NEXT = {
  draft: ['issued', 'cancelled'],
  issued: ['in_progress', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};
const MAX_CELLS = 100000;
const CHUNK = 1000;
const NOT_LOCKED_WHY = 'Freeze the design first — contractors are assigned to pieces.';
const STARTED_WHY = 'Started on the floor — it stays with whoever started it.';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const chunks = (xs, n = CHUNK) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** A step has started when the floor did anything with it (releaseService.unrelease's test, plus a hold taken mid-work). */
const stepStarted = (s) => s.started_at != null || Number(s.qty_good) > 0 || Number(s.qty_scrap) > 0
  || s.state === 'in_progress' || s.state === 'done' || (s.state === 'on_hold' && s.held_from === 'in_progress');

/* ===========================================================================
 * Loading one line's assignment
 * ======================================================================== */

async function loadAssignment(db, companyId, orderId, lineId, { lock = false } = {}) {
  const line = await lineOnOrder(db, companyId, orderId, lineId, { lock });
  const forUpdate = lock ? ' FOR UPDATE' : '';
  const ctx = {
    line, locked: !!line.locked_at, closedWhy: orderClosedWhy(line),
    pieces: [], pieceById: new Map(), opsOfPiece: new Map(), operations: new Map(),
    cells: new Map(), stepsOfCell: new Map(), contractors: [], workOrders: new Map(),
  };
  const [[contractors], [workOrders]] = await Promise.all([
    db.query(
      `SELECT id, code, name FROM cf_parties
        WHERE company_id = ? AND is_subcontractor = 1 AND status = 'active' AND deleted_at IS NULL ORDER BY name, code`,
      [companyId],
    ),
    db.query(
      `SELECT w.id, w.code, w.status, w.contractor_id, p.name AS contractor_name, p.code AS contractor_code
         FROM cf_work_orders w JOIN cf_parties p ON p.id = w.contractor_id
        WHERE w.company_id = ? AND w.order_line_id = ? AND w.deleted_at IS NULL ORDER BY w.id${forUpdate}`,
      [companyId, line.id],
    ),
  ]);
  ctx.contractors = contractors.map((p) => ({ id: p.id, code: p.code, name: p.name }));
  for (const w of workOrders) ctx.workOrders.set(w.id, w);
  if (!ctx.locked) return ctx;

  const [pieces] = await db.query(
    `SELECT p.id, p.parent_id, p.item_id, p.bom_line_id, p.quantity, p.code, p.depth, p.sort_order, m.name
       FROM cf_order_pieces p JOIN cf_master_records m ON m.id = p.item_id
      WHERE p.company_id = ? AND p.order_line_id = ? AND p.deleted_at IS NULL
      ORDER BY p.sort_order, p.id`,
    [companyId, line.id],
  );
  ctx.pieces = pieces;
  for (const p of pieces) ctx.pieceById.set(p.id, p);

  // How each piece is made: its row's flow (bomGraph.effectiveFlowOf — the
  // row's own, else the item's, else its template's); the line's own item
  // (no row) the same way from the item itself (bomService.explode's root).
  const bomLineIds = [...new Set(pieces.map((p) => p.bom_line_id).filter((v) => v != null))];
  const [flowRows] = await db.query(
    `SELECT l.id AS bom_line_id, l.operation_flow_id, ch.default_flow_id AS child_flow_id, sdef.default_flow_id AS def_flow_id
       FROM cf_bom_lines l
       JOIN cf_master_records ch ON ch.id = l.child_id
       LEFT JOIN cf_item_details ci ON ci.master_id = l.child_id AND ci.deleted_at IS NULL
       LEFT JOIN cf_master_records sdef ON sdef.id = ci.source_definition_id
      WHERE l.company_id = ? AND l.id IN (?)
     UNION ALL
     SELECT NULL, NULL, m.default_flow_id, sd.default_flow_id
       FROM cf_master_records m
       LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_master_records sd ON sd.id = i.source_definition_id
      WHERE m.company_id = ? AND m.id = ?`,
    [companyId, bomLineIds.length ? bomLineIds : [0], companyId, line.item_id ?? 0],
  );
  const flowOf = new Map(flowRows.map((r) => [r.bom_line_id ?? 0, r.operation_flow_id ?? r.child_flow_id ?? r.def_flow_id ?? null]));
  const steps = await flowSteps(db, companyId, [...new Set([...flowOf.values()].filter(Boolean))]);
  const opsOfFlowId = new Map([...steps].map(([id, s]) => [id, opsOfFlow(s)]));
  for (const p of pieces) {
    const ops = opsOfFlowId.get(flowOf.get(p.bom_line_id ?? 0)) ?? new Map();
    ctx.opsOfPiece.set(p.id, ops);
    for (const o of ops.values()) if (!ctx.operations.has(o.id)) ctx.operations.set(o.id, o);
  }

  const [cells] = await db.query(
    `SELECT id, order_piece_id, operation_id, work_order_id FROM cf_work_order_cells
      WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL${forUpdate}`,
    [companyId, line.id],
  );
  for (const c of cells) ctx.cells.set(`${c.order_piece_id}:${c.operation_id}`, { id: c.id, workOrderId: c.work_order_id });

  if (line.release_id) {
    // The tracker's steps, found back to their pieces: by order_piece_id, or —
    // for a release made before that column — by code (a locked line's
    // tracker codes ARE its piece codes; code is identity).
    const [rows] = await db.query(
      `SELECT s.id, s.operation_id, s.state, s.held_from, s.started_at, s.qty_good, s.qty_scrap, s.work_order_id,
              pi.order_piece_id, pi.code
         FROM cf_production_steps s
         JOIN cf_production_items pi ON pi.company_id = s.company_id AND pi.id = s.production_item_id
        WHERE pi.company_id = ? AND pi.release_id = ? AND pi.deleted_at IS NULL AND s.deleted_at IS NULL${forUpdate}`,
      [companyId, line.release_id],
    );
    const pieceByCode = new Map(pieces.map((p) => [p.code, p.id]));
    for (const s of rows) {
      const pieceId = s.order_piece_id ?? pieceByCode.get(s.code) ?? null;
      if (pieceId == null) continue;
      const k = `${pieceId}:${s.operation_id}`;
      if (!ctx.stepsOfCell.has(k)) ctx.stepsOfCell.set(k, []);
      ctx.stepsOfCell.get(k).push(s);
    }
  }
  return ctx;
}

const cellStarted = (ctx, key) => (ctx.stepsOfCell.get(key) ?? []).some(stepStarted);

function buildAssignmentView(ctx) {
  const { line } = ctx;
  const out = {
    line: { id: line.id, lineNo: line.line_no, locked: ctx.locked, released: !!line.release_id },
    operations: [],
    rows: [],
    contractors: ctx.contractors,
    workOrders: [],
  };
  const why = !ctx.locked ? NOT_LOCKED_WHY : ctx.closedWhy;
  if (why) out.line.why = why;
  // Columns in the order the pieces' flows first name them.
  const seen = [];
  for (const p of ctx.pieces) {
    let at = -1;
    for (const o of ctx.opsOfPiece.get(p.id).values()) {
      const i = seen.indexOf(o.id);
      if (i >= 0) { at = Math.max(at, i); continue; }
      seen.splice(at + 1, 0, o.id);
      at += 1;
    }
  }
  out.operations = seen.map((id) => {
    const o = ctx.operations.get(id);
    return { id: o.id, code: o.code, name: o.name };
  });
  const counts = new Map();
  for (const c of ctx.cells.values()) counts.set(c.workOrderId, (counts.get(c.workOrderId) ?? 0) + 1);
  for (const p of ctx.pieces) {
    const cells = {};
    for (const o of ctx.opsOfPiece.get(p.id).values()) {
      const key = `${p.id}:${o.id}`;
      const cell = ctx.cells.get(key);
      const wo = cell ? ctx.workOrders.get(cell.workOrderId) : null;
      const started = cellStarted(ctx, key);
      const cellWhy = ctx.closedWhy ?? (started ? STARTED_WHY : null);
      cells[o.id] = {
        workOrderId: wo?.id ?? null,
        workOrderCode: wo?.code ?? null,
        contractorId: wo?.contractor_id ?? null,
        contractorName: wo?.contractor_name ?? null,
        started,
        editable: !cellWhy,
        why: cellWhy,
      };
    }
    out.rows.push({
      key: String(p.id),
      pieceId: p.id,
      bomLineId: p.bom_line_id ?? null,
      parentKey: p.parent_id != null ? String(p.parent_id) : null,
      depth: p.depth,
      code: p.code,
      name: p.name,
      quantity: Number(p.quantity),
      cells,
    });
  }
  for (const w of ctx.workOrders.values()) {
    if (w.status === 'cancelled') continue;
    out.workOrders.push({
      id: w.id, code: w.code, contractorId: w.contractor_id, contractorName: w.contractor_name,
      status: w.status, cellCount: counts.get(w.id) ?? 0,
    });
  }
  return out;
}

export async function getAssignment(db, companyId, orderId, lineId) {
  return buildAssignmentView(await loadAssignment(db, companyId, orderId, lineId));
}

/* ===========================================================================
 * Assigning
 * ======================================================================== */

async function requireContractor(db, companyId, id) {
  const [[p]] = await db.query('SELECT id, code, name, is_subcontractor, status FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!p) throw invalid('NO_CONTRACTOR', 'That contractor does not exist.');
  if (!p.is_subcontractor) throw invalid('NOT_A_CONTRACTOR', `${p.name} is not marked as a subcontractor — tick Subcontractor on the party first.`);
  if (p.status !== 'active') throw invalid('INACTIVE_CONTRACTOR', `${p.name} is inactive.`);
  return p;
}

/** A new draft work order for a contractor on a line, numbered by the code generator or WO-000123. */
async function createWorkOrder(db, c, line, contractor) {
  const g = await generate(db, c.companyId, 'work_order', 'code', { draft: { contractorId: contractor.id, lineId: line.id } }, { consume: true });
  const code = g?.text && !(g.missing?.length) ? g.text : null;
  const [r] = await db.query(
    // due_date starts as the sales order's committed date (else the line's), when it has one.
    `INSERT INTO cf_work_orders (company_id, code, order_id, order_line_id, contractor_id, status, due_date, created_by)
     VALUES (?, ?, ?, ?, ?, 'draft',
       COALESCE((SELECT committed_date FROM cf_sales_orders WHERE company_id = ? AND id = ?),
                (SELECT committed_date FROM cf_sales_order_lines WHERE company_id = ? AND id = ?)), ?)`,
    [c.companyId, code, line.order_id, line.id, contractor.id, c.companyId, line.order_id, c.companyId, line.id, c.userId ?? null],
  );
  const finalCode = code ?? `WO-${String(r.insertId).padStart(6, '0')}`;
  if (!code) await db.query('UPDATE cf_work_orders SET code = ? WHERE company_id = ? AND id = ?', [finalCode, c.companyId, r.insertId]);
  return { id: r.insertId, code: finalCode, status: 'draft', contractor_id: contractor.id, contractor_name: contractor.name, contractor_code: contractor.code };
}

/** Pending steps of these cells take this work order (null = in-house). One statement per chunk. */
async function repointPendingSteps(db, companyId, stepIds, workOrderId) {
  for (const part of chunks(stepIds)) {
    await db.query("UPDATE cf_production_steps SET work_order_id = ? WHERE company_id = ? AND id IN (?) AND state = 'pending'", [workOrderId, companyId, part]);
  }
}

const parseContractorId = (v) => {
  const id = v == null || v === '' ? null : Number(v);
  if (id != null && (!Number.isInteger(id) || id <= 0)) throw invalid('INVALID', 'contractorId is a party id, or null for in-house.');
  return id;
};

/**
 * The body is either the original { cells, contractorId } or several groups in
 * ONE call: { assignments: [{ cells, contractorId | null }] }. Groups are
 * validated together and applied in one transaction (all or nothing); a cell
 * named twice takes its LAST group's contractor.
 */
function readGroups(input) {
  if (Array.isArray(input.assignments)) {
    if (!input.assignments.length) throw invalid('INVALID', 'assignments is empty: { assignments: [{ cells: [{ pieceId, operationId }], contractorId }] }.');
    return input.assignments.map((g) => {
      if (!g || !Array.isArray(g.cells) || g.contractorId === undefined) throw invalid('INVALID', 'Each assignment is { cells: [{ pieceId, operationId }], contractorId | null }.');
      return { cells: g.cells, contractorId: parseContractorId(g.contractorId) };
    });
  }
  if (!Array.isArray(input.cells) || !input.cells.length) throw invalid('INVALID', 'Choose the cells to assign: { cells: [{ pieceId, operationId }], contractorId }.');
  if (input.contractorId === undefined) throw invalid('INVALID', 'Say who does the work: contractorId, or null for in-house.');
  return [{ cells: input.cells, contractorId: parseContractorId(input.contractorId) }];
}

export async function assignCells(db, c, orderId, lineId, input = {}) {
  const groups = readGroups(input);
  if (groups.reduce((n, g) => n + g.cells.length, 0) > MAX_CELLS) throw invalid('TOO_MANY', `At most ${MAX_CELLS} cells in one go.`);

  const ctx = await loadAssignment(db, c.companyId, orderId, lineId, { lock: true });
  if (!ctx.locked) throw invalid('NOT_LOCKED', NOT_LOCKED_WHY);
  if (ctx.closedWhy) throw invalid('READ_ONLY', ctx.closedWhy);
  const contractors = new Map();
  for (const id of new Set(groups.map((g) => g.contractorId).filter((v) => v != null))) contractors.set(id, await requireContractor(db, c.companyId, id));

  // Validate every group before writing anything.
  const problems = [];
  const started = [];
  const resolved = groups.map((g) => {
    const keys = new Map(); // key -> { pieceId, operationId }
    g.cells.forEach((cell, i) => {
      const pieceId = Number(cell?.pieceId);
      const operationId = Number(cell?.operationId);
      const piece = ctx.pieceById.get(pieceId);
      if (!piece) { problems.push(`Cell ${i + 1}: piece ${cell?.pieceId ?? '?'} is not a piece of line ${ctx.line.line_no}.`); return; }
      const op = ctx.opsOfPiece.get(pieceId).get(operationId);
      if (!op) {
        const name = ctx.operations.get(operationId)?.code ?? `operation ${cell?.operationId ?? '?'}`;
        problems.push(`${piece.code}: ${name} is not in its flow.`);
        return;
      }
      const key = `${pieceId}:${operationId}`;
      if (cellStarted(ctx, key)) started.push(`${piece.code} · ${op.name}`);
      keys.set(key, { pieceId, operationId });
    });
    return { contractor: g.contractorId != null ? contractors.get(g.contractorId) : null, keys };
  });
  assertNoProblems(problems, 'Some cells cannot be assigned.');
  if (started.length) {
    throw invalid('STARTED', `${started.length} of the cells ${started.length === 1 ? 'has' : 'have'} started on the floor — they stay with whoever started them. Nothing was changed; leave ${started.length === 1 ? 'it' : 'them'} out and assign the rest.`, { problems: started });
  }

  const retire = [];
  const inserts = [];
  const emptied = new Set();
  const stepEnds = new Map(); // step id -> the work order it should end on (null = in-house); the last group wins
  for (const { contractor, keys } of resolved) {
    // The contractor's open work order on this line, or a new draft one.
    let target = contractor
      ? [...ctx.workOrders.values()].find((w) => w.contractor_id === contractor.id && OPEN_FOR_CELLS.has(w.status)) ?? null
      : null;
    const moved = [];
    for (const [key, { pieceId, operationId }] of keys) {
      const cur = ctx.cells.get(key);
      if (cur && contractor && target && cur.workOrderId === target.id) continue; // already there
      if (!cur && !contractor) continue;                                          // already in-house
      moved.push({ key, pieceId, operationId, cur });
    }
    if (moved.length && contractor && !target) {
      target = await createWorkOrder(db, c, ctx.line, contractor);
      ctx.workOrders.set(target.id, target);
    }
    for (const { key, pieceId, operationId, cur } of moved) {
      if (cur) {
        emptied.add(cur.workOrderId);
        ctx.cells.delete(key);
        if (cur.id != null) retire.push(cur.id);
        else { // added by an earlier group of this same call: not written yet
          const at = inserts.findIndex((r) => r[3] === pieceId && r[4] === operationId);
          if (at >= 0) inserts.splice(at, 1);
        }
      }
      if (target) {
        inserts.push([c.companyId, target.id, ctx.line.id, pieceId, operationId]);
        ctx.cells.set(key, { id: null, workOrderId: target.id });
      }
      for (const s of ctx.stepsOfCell.get(key) ?? []) if (s.state === 'pending') stepEnds.set(s.id, target?.id ?? null);
    }
  }
  // Retire first: the unique key allows one LIVE owner per cell.
  for (const part of chunks(retire)) {
    await db.query('UPDATE cf_work_order_cells SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, part]);
  }
  if (inserts.length) {
    await insertRows(db, 'cf_work_order_cells', ['company_id', 'work_order_id', 'order_line_id', 'order_piece_id', 'operation_id'], inserts, 500);
  }
  const byWorkOrder = new Map();
  for (const [stepId, woId] of stepEnds) byWorkOrder.set(woId, [...(byWorkOrder.get(woId) ?? []), stepId]);
  for (const [woId, ids] of byWorkOrder) await repointPendingSteps(db, c.companyId, ids, woId);

  // A draft this call left empty was only the container this screen made — remove it.
  const remaining = new Map();
  for (const cell of ctx.cells.values()) remaining.set(cell.workOrderId, (remaining.get(cell.workOrderId) ?? 0) + 1);
  const drop = [...emptied].filter((id) => ctx.workOrders.get(id)?.status === 'draft' && !remaining.get(id));
  if (drop.length) {
    await db.query("UPDATE cf_work_orders SET deleted_at = NOW() WHERE company_id = ? AND id IN (?) AND status = 'draft'", [c.companyId, drop]);
    for (const id of drop) ctx.workOrders.delete(id);
  }
  return buildAssignmentView(ctx);
}

/* ===========================================================================
 * Work orders themselves
 * ======================================================================== */

const WO_SELECT = `SELECT w.*, p.code AS contractor_code, p.name AS contractor_name,
       o.code AS order_code, o.revision AS order_revision, o.status AS order_status, l.line_no,
       m.name AS item_name,
       (SELECT COUNT(*) FROM cf_work_order_cells c WHERE c.company_id = w.company_id AND c.work_order_id = w.id AND c.deleted_at IS NULL) AS cell_count,
       (SELECT COUNT(DISTINCT c.order_piece_id) FROM cf_work_order_cells c WHERE c.company_id = w.company_id AND c.work_order_id = w.id AND c.deleted_at IS NULL) AS piece_count,
       (SELECT COUNT(*) FROM cf_production_steps s WHERE s.company_id = w.company_id AND s.work_order_id = w.id AND s.deleted_at IS NULL) AS steps_total,
       (SELECT COUNT(*) FROM cf_production_steps s WHERE s.company_id = w.company_id AND s.work_order_id = w.id AND s.deleted_at IS NULL AND s.state = 'done') AS steps_done,
       (SELECT COUNT(*) FROM cf_production_steps s WHERE s.company_id = w.company_id AND s.work_order_id = w.id AND s.deleted_at IS NULL AND s.state <> 'pending') AS steps_started
  FROM cf_work_orders w
  JOIN cf_parties p ON p.id = w.contractor_id
  JOIN cf_sales_orders o ON o.id = w.order_id
  JOIN cf_sales_order_lines l ON l.id = w.order_line_id
  LEFT JOIN cf_master_records m ON m.id = l.item_id`;

const shapeWorkOrder = (w) => ({
  id: w.id,
  code: w.code,
  status: w.status,
  contractorId: w.contractor_id,
  contractorCode: w.contractor_code,
  contractorName: w.contractor_name,
  // Flat, as the Work orders page reads them ...
  orderId: w.order_id,
  orderCode: w.order_code,
  orderLineId: w.order_line_id,
  lineNo: w.line_no,
  // ... and grouped, for anything that wants the revision or the item.
  order: { id: w.order_id, code: w.order_code, revision: w.order_revision ?? 1, status: w.order_status },
  line: { id: w.order_line_id, lineNo: w.line_no, itemName: w.item_name ?? null },
  // Once the line is released: the steps on this work order, done out of all.
  progress: Number(w.steps_total) ? { done: Number(w.steps_done ?? 0), started: Number(w.steps_started ?? 0), total: Number(w.steps_total) } : null,
  startDate: dateText(w.start_date),
  dueDate: dateText(w.due_date),
  notes: w.notes ?? null,
  cellCount: Number(w.cell_count ?? 0),
  pieceCount: Number(w.piece_count ?? 0),
  next: NEXT[w.status] ?? [],
  createdAt: w.created_at,
  updatedAt: w.updated_at,
});

export async function listWorkOrders(db, companyId, q = {}) {
  const where = ['w.company_id = ?', 'w.deleted_at IS NULL'];
  const params = [companyId];
  if (!blank(q.status)) {
    // "open" = not finished and not cancelled: draft, issued, in progress.
    const statuses = String(q.status).split(',').map((s) => s.trim())
      .flatMap((s) => (s === 'open' ? ['draft', 'issued', 'in_progress'] : [s])).filter((s) => WO_STATUSES.includes(s));
    if (statuses.length) { where.push('w.status IN (?)'); params.push(statuses); }
  }
  if (!blank(q.contractorId)) { where.push('w.contractor_id = ?'); params.push(Number(q.contractorId)); }
  if (!blank(q.orderId)) { where.push('w.order_id = ?'); params.push(Number(q.orderId)); }
  if (!blank(q.lineId)) { where.push('w.order_line_id = ?'); params.push(Number(q.lineId)); }
  const [rows] = await db.query(`${WO_SELECT} WHERE ${where.join(' AND ')} ORDER BY w.id DESC LIMIT 1000`, params);
  let out = rows.map(shapeWorkOrder);
  if (!blank(q.search)) {
    const term = String(q.search).trim().toLowerCase();
    out = out.filter((w) => [w.code, w.contractorName, w.contractorCode, w.order.code].some((t) => t && String(t).toLowerCase().includes(term)));
  }
  return out;
}

async function requireWorkOrder(db, companyId, id, { lock = false } = {}) {
  const [[w]] = await db.query(`${WO_SELECT} WHERE w.company_id = ? AND w.id = ? AND w.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, id]);
  if (!w) throw notFound('Work order');
  return w;
}

/**
 * One work order: its header, its scope grouped by piece (in the tree's order,
 * operations in flow order) and, once the line is released, its progress —
 * the steps on it done out of all of them.
 */
export async function getWorkOrder(db, companyId, id) {
  const w = await requireWorkOrder(db, companyId, id);
  // The header (WO_SELECT) already carries the progress; this is the scope.
  const [cells] = await db.query(
    `SELECT c.order_piece_id, c.operation_id, p.code AS piece_code, p.sort_order, p.quantity, m.name AS item_name,
            o.code AS op_code, o.name AS op_name
       FROM cf_work_order_cells c
       JOIN cf_order_pieces p ON p.id = c.order_piece_id
       JOIN cf_master_records m ON m.id = p.item_id
       JOIN cf_operations o ON o.id = c.operation_id
      WHERE c.company_id = ? AND c.work_order_id = ? AND c.deleted_at IS NULL
      ORDER BY p.sort_order, p.id, c.operation_id`,
    [companyId, id],
  );
  const scope = [];
  const byPiece = new Map();
  for (const c of cells) {
    let row = byPiece.get(c.order_piece_id);
    if (!row) {
      row = { pieceId: c.order_piece_id, pieceCode: c.piece_code, name: c.item_name, quantity: Number(c.quantity), operations: [], operationIds: [] };
      byPiece.set(c.order_piece_id, row);
      scope.push(row);
    }
    row.operations.push(c.op_name);
    row.operationIds.push(c.operation_id);
  }
  return { ...shapeWorkOrder(w), scope };
}

function readDate(raw, label, problems) {
  if (raw === undefined) return undefined;
  if (blank(raw)) return null;
  const s = String(raw).slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) { problems.push(`${label} is a date (YYYY-MM-DD).`); return undefined; }
  return s;
}

/** Dates and notes — nothing else of a work order is edited here. */
export async function updateWorkOrder(db, c, id, input = {}) {
  const w = await requireWorkOrder(db, c.companyId, id, { lock: true });
  if (w.status === 'cancelled' || w.status === 'done') throw invalid('CLOSED', `${w.code} is ${w.status === 'done' ? 'done' : 'cancelled'} — it no longer changes.`);
  const problems = [];
  const sets = {};
  const start = readDate(input.startDate, 'Start date', problems);
  const due = readDate(input.dueDate, 'Due date', problems);
  if (start !== undefined) sets.start_date = start;
  if (due !== undefined) sets.due_date = due;
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : String(input.notes);
  const s2 = sets.start_date !== undefined ? sets.start_date : dateText(w.start_date);
  const d2 = sets.due_date !== undefined ? sets.due_date : dateText(w.due_date);
  if (s2 && d2 && d2 < s2) problems.push('The due date is before the start date.');
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_work_orders SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, id]);
  }
  return getWorkOrder(db, c.companyId, id);
}

/**
 * draft -> issued -> in_progress -> done; any open one -> cancelled. Cancelling
 * frees the cells (back in-house) and clears the work order off its pending
 * steps; a work order with started work is finished, not cancelled.
 */
export async function setWorkOrderStatus(db, c, id, status) {
  const w = await requireWorkOrder(db, c.companyId, id, { lock: true });
  if (!WO_STATUSES.includes(status)) throw invalid('INVALID', `Status is one of ${WO_STATUSES.join(', ')}.`);
  if (status === w.status) return getWorkOrder(db, c.companyId, id);
  if (!(NEXT[w.status] ?? []).includes(status)) {
    const next = NEXT[w.status] ?? [];
    throw conflict('BAD_TRANSITION', `${w.code} is ${w.status.replace('_', ' ')} — it can go to ${next.length ? next.map((s) => s.replace('_', ' ')).join(' or ') : 'nothing else'}, not ${status.replace('_', ' ')}.`);
  }
  if (status !== 'cancelled' && orderClosedWhy({ order_status: w.order_status, order_code: w.order_code, order_revision: w.order_revision })) {
    throw invalid('READ_ONLY', orderClosedWhy({ order_status: w.order_status, order_code: w.order_code, order_revision: w.order_revision }));
  }
  if (status === 'issued' && !Number(w.cell_count)) throw invalid('EMPTY', `${w.code} has no cells — assign work to it before issuing it.`);
  if (status === 'cancelled') {
    const [[{ started }]] = await db.query(
      `SELECT COUNT(*) AS started FROM cf_production_steps
        WHERE company_id = ? AND work_order_id = ? AND deleted_at IS NULL
          AND (started_at IS NOT NULL OR qty_good > 0 OR qty_scrap > 0 OR state IN ('in_progress','done') OR (state = 'on_hold' AND held_from = 'in_progress'))`,
      [c.companyId, id],
    );
    if (Number(started)) throw conflict('STARTED', `Work has started on ${w.code} (${started} step${Number(started) === 1 ? '' : 's'}) — mark it done instead of cancelling it.`);
    await db.query('UPDATE cf_work_order_cells SET deleted_at = NOW() WHERE company_id = ? AND work_order_id = ? AND deleted_at IS NULL', [c.companyId, id]);
    await db.query("UPDATE cf_production_steps SET work_order_id = NULL WHERE company_id = ? AND work_order_id = ? AND state = 'pending'", [c.companyId, id]);
  }
  await db.query('UPDATE cf_work_orders SET status = ? WHERE company_id = ? AND id = ?', [status, c.companyId, id]);
  return getWorkOrder(db, c.companyId, id);
}

/* ===========================================================================
 * For release, lock and revisions
 * ======================================================================== */

/** piece id:operation id -> work order id, for a line's live cells. One read. */
export async function cellOwnersOfLine(db, companyId, lineId) {
  const [rows] = await db.query(
    'SELECT order_piece_id, operation_id, work_order_id FROM cf_work_order_cells WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL',
    [companyId, lineId],
  );
  return new Map(rows.map((r) => [`${r.order_piece_id}:${r.operation_id}`, r.work_order_id]));
}

/**
 * A later revision retires the older revisions' pieces (lockService); their
 * work-order cells go with them — a cell of a retired piece is work nobody will
 * do. An open (draft / issued) work order left with no live cell is cancelled:
 * it was for a revision that no longer exists. In-progress and done ones are
 * left as they are (a revision after release is not something the app allows).
 * Two statements whatever the size.
 *
 *   scope  { orderCode, beforeRevision }  every revision of that order below it
 *          { lineId }                     one line (a deleted line)
 */
export async function retireCellsOfRetiredPieces(db, companyId, scope) {
  const byOrder = scope.orderCode != null;
  const lineFilter = byOrder
    ? 'e.code_active = LOWER(?) AND e.revision < ?'
    : 'l.id = ?';
  const params = byOrder ? [scope.orderCode, Number(scope.beforeRevision)] : [Number(scope.lineId)];
  await db.query(
    `UPDATE cf_work_order_cells c
       JOIN cf_order_pieces p ON p.company_id = c.company_id AND p.id = c.order_piece_id
       JOIN cf_sales_order_lines l ON l.company_id = c.company_id AND l.id = c.order_line_id
       JOIN cf_sales_orders e ON e.company_id = l.company_id AND e.id = l.order_id
        SET c.deleted_at = NOW()
      WHERE c.company_id = ? AND c.deleted_at IS NULL AND p.deleted_at IS NOT NULL AND ${lineFilter}`,
    [companyId, ...params],
  );
  await db.query(
    `UPDATE cf_work_orders w
       JOIN cf_sales_order_lines l ON l.company_id = w.company_id AND l.id = w.order_line_id
       JOIN cf_sales_orders e ON e.company_id = l.company_id AND e.id = l.order_id
        SET w.status = 'cancelled'
      WHERE w.company_id = ? AND w.deleted_at IS NULL AND w.status IN ('draft','issued') AND ${lineFilter}
        AND NOT EXISTS (SELECT 1 FROM cf_work_order_cells c WHERE c.company_id = w.company_id AND c.work_order_id = w.id AND c.deleted_at IS NULL)`,
    [companyId, ...params],
  );
}
