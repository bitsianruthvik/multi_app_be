/**
 * contractorWorkOrderService.js — CONTRACTOR WORK ORDERS (init.sql §85; contract TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — Step 6: contractor work orders").
 *
 * The user, 2026-10-18: a work order is EXTERNAL (contractor) work only. It is made from a PRODUCTION ORDER by picking
 * cells of a grid — the production order's BOM rows × operations. Making it raises a CONTRACTOR PO to the contractor
 * (a party with the subcontractor role): one PO line per operation, its quantity the TONNES of the rows picked for it
 * (their weight × how many the production order makes), the rate per tonne → the amount. The PO goes to Management
 * ('contractor_po', the §73 inbox); approved, the work order is ISSUED. Work orders live in ACCOUNTS (lanes Waiting
 * approval → Issued → In progress → Completed → Paid in full); Accounts records WEEKLY PAYMENTS against one (date, tonnes
 * done and / or an amount, rate per tonne, reference) — they move the PO like a GRN does (qty_received = tonnes done;
 * all done → the PO closes by itself; close short = the existing approval). The steps it covers show on the production
 * order and the tracker as "with <contractor> (WO-…)": released steps carry cf_production_steps.work_order_id, which the
 * floor (not done in-house), the machine queue and the planner already read. Payments are the order's CONTRACTOR COST
 * on its cost sheet (costingService).
 *
 *   contractorGrid          GET  /production-orders/:id/contractor-grid
 *   createContractorWorkOrder POST /production-orders/:id/contractor-work-orders
 *   workOrderBoard          GET  /accounts/work-orders                    lanes
 *   readContractorWorkOrder GET  /accounts/work-orders/:id
 *   recordPayment           POST /accounts/work-orders/:id/payments
 *   removePayment           DELETE /accounts/work-order-payments/:id
 *   askCloseShort / cancelContractorWorkOrder / sendAgain
 *   contractorCellsOf       which BOM row × operation cells (and released steps) are under an open work order — for the
 *                           planner (GET /contractor-work/cells)
 *   stampContractorSteps    released steps take their work order (called from productionOrderService.stampLines)
 *   contractorCostOf        payments per sales order (costingService)
 *
 * A CELL is (production order, path, operation). path = "<order line id>:<BOM line ids from the line's item down,
 * '/'-joined>" — the same chain the production order scope keys and the tracker's pieces use, so a cell meets its
 * released steps. One live owner per cell (uq_cwos_cell). Older work orders (§30, cells on locked pieces) stay readable
 * through workOrderService; nothing here writes them.
 *
 * ROUND TRIPS (TiDB ~49 ms each): the grid ≈ 12 + one per BOM level of each line; creating one ≈ the grid + 12 writes
 * whatever the number of cells; a payment 6; the board 4.
 */
import crypto from 'crypto';
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { likeOf } from '../lib/listing.js';
import { generate } from '../modules/codegen/index.js';
import { LOCKED_ORDER_STATUSES } from './records.js';
import { explode } from './bomService.js';
import { frozenFlowsOfLine, freezeTree } from './frozenFlowService.js';
import { flowSteps, opsOfFlow } from './timeEstimateService.js';
import { unitKgOf } from './valuationService.js';
import { listProductionOrdersOf } from './productionOrderService.js';
import {
  insertOrder, askPoApproval, poApprovalHandler, poStage, PO_STAGE_LABEL, requestCloseShort, cancelPurchaseOrder, markOrdered,
} from './purchaseService.js';
import { pendingFor } from './approvalService.js';

const EPS = 1e-6;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const hashOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const dateText = (d) => (d == null ? null : d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
const today = () => dateText(new Date());

export const WO_LANES = ['waiting_approval', 'issued', 'in_progress', 'completed', 'paid'];
export const WO_LANE_LABEL = {
  waiting_approval: 'Waiting approval', issued: 'Issued', in_progress: 'In progress', completed: 'Completed', paid: 'Paid in full', cancelled: 'Cancelled',
};
/** The service item a contractor PO line is for: one per operation, in the "Contractor services" family. */
const SVC = { family: 'SVC-CONTRACT', sub: 'SVC-CONTRACT-GEN', variant: 'SVC-CONTRACT-GEN-V', prefix: 'CW-' };

/* ===========================================================================
 * The grid: the production order's BOM rows × operations
 * ======================================================================== */

/** "L12U1A7:501/503#2" → { kind: 'assembly', path: '501/503' }; "L12U1R" → { kind: 'rest' }; else { kind: 'all' }. */
export function scopeOf(po) {
  if (po.level !== 'assembly') return { kind: 'all', perUnit: po.level === 'unit' };
  const key = String(po.scopeKey ?? '');
  if (/U\d+R$/.test(key)) return { kind: 'rest', levelId: Number(po.levelId) };
  const m = key.match(/A\d+:(.*)#\d+$/);
  return m ? { kind: 'assembly', path: m[1] } : { kind: 'rest', levelId: Number(po.levelId) };
}

/**
 * The rows a production order makes, from a line's exploded tree. PURE.
 * tree: bomService.explode's root (rootQuantity = the line's quantity for a line / order production order, else 1).
 * scope: scopeOf(po). defOf(itemId) → definition id | null (sub-assembly levels).
 * → [{ path, node, depth, quantity }] in tree order; quantity = how many the production order makes.
 */
export function rowsOfScope(lineId, root, scope, defOf = () => null) {
  const out = [];
  if (!root) return out;
  const seg = (n) => (n.lineId != null ? String(n.lineId) : `i${n.id}`);
  const kids = (n) => [...(n.children ?? [])].sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0) || (a.lineId ?? 0) - (b.lineId ?? 0));
  if (scope.kind === 'assembly') {
    // The sub-assembly row at that path: itself once, everything under it per one of it.
    const find = (n, chain) => {
      for (const k of kids(n)) {
        const p = [...chain, seg(k)];
        if (p.join('/') === scope.path) return { node: k, chain: p };
        const hit = find(k, p);
        if (hit) return hit;
      }
      return null;
    };
    const hit = find(root, []);
    if (!hit) return out;
    const per = Number(hit.node.total) || 1;
    const walk = (n, chain, depth) => {
      out.push({ path: `${lineId}:${chain.join('/')}`, node: n, depth, quantity: round6(Number(n.total) / per) });
      for (const k of kids(n)) walk(k, [...chain, seg(k)], depth + 1);
    };
    walk(hit.node, hit.chain, 0);
    return out;
  }
  const walk = (n, chain, depth) => {
    if (scope.kind === 'rest' && depth > 0 && n.children?.length && Number(defOf(n.id)) === Number(scope.levelId)) return;
    out.push({ path: `${lineId}:${chain.join('/')}`, node: n, depth, quantity: round6(Number(n.total)) });
    for (const k of kids(n)) walk(k, [...chain, seg(k)], depth + 1);
  };
  walk(root, [], 0);
  return out;
}

/** Columns: the union of the rows' flows, in flow order (the Times grid's rule). PURE. */
export function columnsOf(rows, flowOps) {
  const order = [];
  const seen = new Set();
  for (const r of rows) {
    const ops = flowOps.get(r.node.flow?.id);
    if (!ops) continue;
    let at = -1;
    for (const o of ops.values()) {
      if (seen.has(o.id)) { at = Math.max(at, order.indexOf(o.id)); continue; }
      order.splice(at + 1, 0, o.id);
      seen.add(o.id);
      at += 1;
    }
  }
  return order;
}

/** A released line's pieces → their path (the same chain as rowsOfScope's). PURE. items: [{ id, parent_id, depth, bom_line_id, item_id }] */
export function piecePaths(lineId, items) {
  const byId = new Map(items.map((i) => [Number(i.id), i]));
  const memo = new Map();
  const chainOf = (it) => {
    if (memo.has(it.id)) return memo.get(it.id);
    let c;
    if (Number(it.depth) === 0 || it.parent_id == null) c = [];
    else {
      const parent = byId.get(Number(it.parent_id));
      c = [...(parent ? chainOf(parent) : []), it.bom_line_id != null ? String(it.bom_line_id) : `i${it.item_id}`];
    }
    memo.set(it.id, c);
    return c;
  };
  const out = new Map();
  for (const it of items) out.set(Number(it.id), `${lineId}:${chainOf(it).join('/')}`);
  return out;
}

const OWNER_SQL = `SELECT s.id, s.work_order_id, s.production_order_id, s.order_line_id, s.path_key, s.operation_id, s.po_line_id,
                          w.code AS wo_code, w.status AS wo_status, w.contractor_id, p.name AS contractor_name, p.code AS contractor_code,
                          po.id AS po_id, po.code AS po_code, po.status AS po_status, po.approval_status, po.closed_at
                     FROM cf_work_order_scope s
                     JOIN cf_work_orders w ON w.company_id = s.company_id AND w.id = s.work_order_id AND w.deleted_at IS NULL AND w.status <> 'cancelled'
                     JOIN cf_parties p ON p.id = w.contractor_id
                     LEFT JOIN cf_purchase_orders po ON po.id = w.purchase_order_id
                    WHERE s.company_id = ? AND s.deleted_at IS NULL AND (po.id IS NULL OR po.status <> 'cancelled')`;

/**
 * A work order whose PO was cancelled from the Purchase pages lets go of its cells: it is cancelled and its cells freed,
 * so the grid can give them again. Two statements.
 */
async function sweepCancelled(db, companyId, productionOrderIds) {
  if (!productionOrderIds.length) return;
  await db.query(
    `UPDATE cf_work_order_scope s
       JOIN cf_work_orders w ON w.id = s.work_order_id
       JOIN cf_purchase_orders po ON po.id = w.purchase_order_id
        SET s.deleted_at = NOW()
      WHERE s.company_id = ? AND s.production_order_id IN (?) AND s.deleted_at IS NULL AND (po.status = 'cancelled' OR w.status = 'cancelled')`,
    [companyId, productionOrderIds],
  );
  await db.query(
    `UPDATE cf_work_orders w JOIN cf_purchase_orders po ON po.id = w.purchase_order_id
        SET w.status = 'cancelled'
      WHERE w.company_id = ? AND w.production_order_id IN (?) AND w.status <> 'cancelled' AND po.status = 'cancelled'`,
    [companyId, productionOrderIds],
  );
}

/** Everything the grid and the create read. */
async function loadGrid(db, companyId, productionOrderId, { lock = false } = {}) {
  if (lock) {
    const [[row]] = await db.query('SELECT id FROM cf_production_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, Number(productionOrderId)]);
    if (!row) throw notFound('Production order');
  }
  const [po] = await listProductionOrdersOf(db, companyId, { ids: [Number(productionOrderId)] });
  if (!po) throw notFound('Production order');
  const lineIds = po.lineIds.map(Number);
  const [lines] = lineIds.length ? await db.query(
    `SELECT l.id, l.order_id, l.line_no, l.line_type, l.item_id, l.quantity, l.locked_at, m.name AS item_name
       FROM cf_sales_order_lines l LEFT JOIN cf_master_records m ON m.id = l.item_id
      WHERE l.company_id = ? AND l.id IN (?) AND l.deleted_at IS NULL ORDER BY l.line_no, l.id`,
    [companyId, lineIds],
  ) : [[]];
  const scope = scopeOf(po);
  const perUnit = scope.kind !== 'all' || scope.perUnit;
  // Each line's tree (one read a BOM level) with its own copy of each flow once frozen.
  const trees = await Promise.all(lines.map(async (l) => {
    if (!l.item_id) return null;
    const t = await explode(db, companyId, l.item_id, { rootQuantity: perUnit ? 1 : Number(l.quantity), maxDepth: 15 });
    freezeTree(t.root, await frozenFlowsOfLine(db, companyId, l));
    return t.root;
  }));
  const allNodes = [];
  const collect = (n) => { allNodes.push(n); for (const k of n.children ?? []) collect(k); };
  for (const t of trees) if (t) collect(t);
  const itemIds = [...new Set(allNodes.map((n) => Number(n.id)).filter(Boolean))];
  const [defRows] = scope.kind === 'rest' && itemIds.length
    ? await db.query('SELECT master_id, source_definition_id FROM cf_item_details WHERE company_id = ? AND master_id IN (?) AND source_definition_id IS NOT NULL', [companyId, itemIds])
    : [[]];
  const defMap = new Map(defRows.map((d) => [Number(d.master_id), Number(d.source_definition_id)]));
  const rows = [];
  lines.forEach((l, i) => { for (const r of rowsOfScope(l.id, trees[i], scope, (id) => defMap.get(Number(id)) ?? null)) rows.push({ ...r, line: l }); });

  const flowIds = [...new Set(rows.map((r) => r.node.flow?.id).filter(Boolean))];
  const [flows, kg, [owners], [contractors]] = await Promise.all([
    flowSteps(db, companyId, flowIds),
    unitKgOf(db, companyId, [...new Set(rows.map((r) => Number(r.node.id)))]),
    db.query(`${OWNER_SQL} AND s.production_order_id = ?`, [companyId, po.id]),
    db.query(
      "SELECT id, code, name FROM cf_parties WHERE company_id = ? AND is_subcontractor = 1 AND status = 'active' AND deleted_at IS NULL ORDER BY name LIMIT 500",
      [companyId],
    ),
  ]);
  const flowOps = new Map();
  for (const [fid, steps] of flows) flowOps.set(fid, opsOfFlow(steps));
  const operations = new Map();
  for (const ops of flowOps.values()) for (const o of ops.values()) if (!operations.has(o.id)) operations.set(o.id, o);

  // Released: which cells' steps already started in-house (they cannot be given away).
  const started = new Set();
  if (po.status !== 'yet_to_plan' && lineIds.length) {
    const [items] = await db.query(
      `SELECT pi.id, pi.parent_id, pi.depth, pi.bom_line_id, pi.item_id, r.order_line_id
         FROM cf_production_items pi JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
        WHERE pi.company_id = ? AND r.order_line_id IN (?) AND pi.deleted_at IS NULL`,
      [companyId, lineIds],
    );
    const [steps] = await db.query(
      `SELECT s.production_item_id, s.operation_id FROM cf_production_steps s
        WHERE s.company_id = ? AND s.production_order_id = ? AND s.deleted_at IS NULL AND s.work_order_id IS NULL
          AND (s.started_at IS NOT NULL OR s.qty_good > 0 OR s.qty_scrap > 0 OR s.state IN ('in_progress','done'))`,
      [companyId, po.id],
    );
    const pathOf = new Map();
    for (const lid of lineIds) for (const [k, v] of piecePaths(lid, items.filter((x) => Number(x.order_line_id) === lid))) pathOf.set(k, v);
    for (const s of steps) { const p = pathOf.get(Number(s.production_item_id)); if (p) started.add(`${p}|${s.operation_id}`); }
  }
  // The rate each contractor last agreed for an operation (prefill).
  const opIds = [...operations.keys()];
  const [rateRows] = opIds.length ? await db.query(
    `SELECT w.contractor_id, s.operation_id, pl.unit_price
       FROM cf_work_order_scope s
       JOIN cf_work_orders w ON w.id = s.work_order_id AND w.deleted_at IS NULL
       JOIN cf_purchase_order_lines pl ON pl.id = s.po_line_id AND pl.unit_price IS NOT NULL
       JOIN cf_purchase_orders p ON p.id = pl.purchase_order_id AND p.status <> 'cancelled'
      WHERE s.company_id = ? AND s.operation_id IN (?)
      ORDER BY s.id DESC LIMIT 2000`,
    [companyId, opIds],
  ) : [[]];
  const lastRates = {};
  for (const r of rateRows) {
    const c = (lastRates[r.contractor_id] ??= {});
    if (c[r.operation_id] == null) c[r.operation_id] = Number(r.unit_price);
  }
  return { po, lines, rows, flowOps, operations, kg, owners, contractors, started, lastRates };
}

function buildGrid(g) {
  const { po } = g;
  const ownerOf = new Map(g.owners.map((o) => [`${o.path_key}|${o.operation_id}`, o]));
  const cols = columnsOf(g.rows, g.flowOps);
  const workOrders = new Map();
  for (const o of g.owners) {
    if (!workOrders.has(o.work_order_id)) {
      workOrders.set(o.work_order_id, {
        id: o.work_order_id, code: o.wo_code, contractor: { id: o.contractor_id, name: o.contractor_name },
        purchaseOrder: o.po_id ? { id: o.po_id, code: o.po_code } : null,
        lane: laneOf({ status: o.wo_status }, o.po_id ? { status: o.po_status, approval_status: o.approval_status, closed_at: o.closed_at } : null, 0, 0),
        cells: 0,
      });
    }
    workOrders.get(o.work_order_id).cells += 1;
  }
  const closedWhy = po.state === 'closed' ? `${po.code} is closed — nothing more is given out on it.` : null;
  return {
    productionOrder: { id: po.id, code: po.code, label: po.label, state: po.state, stateLabel: po.stateLabel, order: po.order, level: po.level },
    editable: !closedWhy, why: closedWhy,
    operations: cols.map((id) => { const o = g.operations.get(id); return { id: o.id, code: o.code, name: o.name }; }),
    rows: g.rows.map((r) => {
      const unitKg = g.kg.get(Number(r.node.id)) ?? null;
      const cells = {};
      for (const o of g.flowOps.get(r.node.flow?.id)?.values() ?? []) {
        const own = ownerOf.get(`${r.path}|${o.id}`);
        const isStarted = g.started.has(`${r.path}|${o.id}`);
        cells[o.id] = {
          workOrder: own ? { id: own.work_order_id, code: own.wo_code, contractor: { id: own.contractor_id, name: own.contractor_name } } : null,
          started: isStarted,
          editable: !closedWhy && !own && !isStarted,
          why: own ? `With ${own.contractor_name} (${own.wo_code}).` : isStarted ? 'Started in-house on the floor — it stays in-house.' : closedWhy,
        };
      }
      return {
        key: r.path,
        lineId: r.line.id, lineNo: r.line.line_no, bomLineId: r.node.lineId ?? null, itemId: r.node.id ?? null,
        depth: r.depth, name: r.node.name, code: r.node.kind === 'temporary' ? null : r.node.code ?? null,
        quantity: r.quantity, unitKg, tonnes: unitKg == null ? null : round6((unitKg * r.quantity) / 1000),
        flowName: r.node.flow?.name ?? null, cells,
      };
    }),
    contractors: g.contractors.map((c) => ({ id: c.id, code: c.code, name: c.name })),
    lastRates: g.lastRates,
    workOrders: [...workOrders.values()],
  };
}

/** GET /production-orders/:id/contractor-grid */
export async function contractorGrid(db, companyId, productionOrderId) {
  return buildGrid(await loadGrid(db, companyId, productionOrderId));
}

/* ===========================================================================
 * Giving cells to a contractor: a contractor PO + the work order
 * ======================================================================== */

/** The service items (one per operation, "CW-<op code>", uom t) — made the first time an operation is contracted. ~6 statements. */
export async function ensureServiceItems(db, c, operations) {
  const ops = [...operations];
  const codeOf = (o) => `${SVC.prefix}${o.code}`.slice(0, 100);
  const [have] = await db.query(
    `SELECT m.id, LOWER(m.code) AS code FROM cf_master_records m JOIN cf_item_details d ON d.company_id = m.company_id AND d.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND LOWER(m.code) IN (?)`,
    [c.companyId, ops.map((o) => codeOf(o).toLowerCase())],
  );
  const out = new Map();
  const byCode = new Map(have.map((h) => [h.code, h.id]));
  const missing = ops.filter((o) => !byCode.has(codeOf(o).toLowerCase()));
  if (missing.length) {
    // The family: Contractor services › General › General (made once per company).
    const [nodes] = await db.query(
      'SELECT id, code, depth FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)',
      [c.companyId, [SVC.family, SVC.sub, SVC.variant]],
    );
    const node = (code) => nodes.find((n) => n.code === code)?.id ?? null;
    let fam = node(SVC.family);
    if (!fam) {
      const [r] = await db.query(
        "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, description, sort_order) VALUES (?, NULL, 0, 'item', ?, 'Contractor services', 'Work given to contractors: one service per operation, bought by the tonne on a contractor PO.', 950)",
        [c.companyId, SVC.family],
      );
      fam = r.insertId;
    }
    let sub = node(SVC.sub);
    if (!sub) sub = (await db.query("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, sort_order) VALUES (?, ?, 1, 'item', ?, 'General', 0)", [c.companyId, fam, SVC.sub]))[0].insertId;
    let variant = node(SVC.variant);
    if (!variant) variant = (await db.query("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, sort_order) VALUES (?, ?, 2, 'item', ?, 'General', 0)", [c.companyId, sub, SVC.variant]))[0].insertId;
    await insertRows(db, 'cf_master_records', ['company_id', 'record_kind', 'code', 'name', 'description', 'classification_id', 'status'],
      missing.map((o) => [c.companyId, 'item', codeOf(o), `Contractor work — ${o.name}`.slice(0, 255), `Contractor service for the operation ${o.code}, by the tonne.`, variant, 'active']));
    const [made] = await db.query(
      'SELECT id, LOWER(code) AS code FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND LOWER(code) IN (?)',
      [c.companyId, missing.map((o) => codeOf(o).toLowerCase())],
    );
    await insertRows(db, 'cf_item_details', ['master_id', 'company_id', 'item_type', 'tracked_by', 'uom', 'sourcing'],
      made.map((m) => [m.id, c.companyId, 'catalog', 'quantity', 't', 'stock']));
    for (const m of made) byCode.set(m.code, m.id);
  }
  for (const o of ops) out.set(Number(o.id), byCode.get(codeOf(o).toLowerCase()));
  return out;
}

async function requireContractor(db, companyId, id, problems) {
  if (blank(id)) { problems.push('Choose the contractor.'); return null; }
  const [[p]] = await db.query('SELECT id, code, name, is_subcontractor, status FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(id)]);
  if (!p) { problems.push('That contractor does not exist.'); return null; }
  if (!Number(p.is_subcontractor)) problems.push(`${p.name} is not a subcontractor — tick Subcontractor on the party first.`);
  if (p.status !== 'active') problems.push(`${p.name} is inactive.`);
  return p;
}

/**
 * POST /production-orders/:id/contractor-work-orders
 *   { contractorId, cells: [{ rowKey, operationId }], rates: { [operationId]: rate per tonne }, dueDate?, notes?, dryRun? }
 * → the plan (dryRun) or the work order. Every problem at once. One PO line per operation: tonnes = Σ the picked rows'
 * tonnes for it; amount = tonnes × rate. The PO waits for Management ('contractor_po').
 */
export async function createContractorWorkOrder(db, c, productionOrderId, input = {}) {
  const dryRun = !!input.dryRun;
  if (!dryRun) await sweepCancelled(db, c.companyId, [Number(productionOrderId)]);
  const g = await loadGrid(db, c.companyId, productionOrderId, { lock: !dryRun });
  const grid = buildGrid(g);
  const problems = [];
  if (!grid.editable) problems.push(grid.why);
  if (LOCKED_ORDER_STATUSES.has(g.po.order.status) || g.po.order.status === 'revised') problems.push(`Order ${g.po.order.code} is ${g.po.order.status} — nothing more is given out on it.`);
  const contractor = await requireContractor(db, c.companyId, input.contractorId, problems);
  const cells = Array.isArray(input.cells) ? input.cells : [];
  if (!cells.length) problems.push('Pick the cells to give — BOM rows × operations.');
  const rowOf = new Map(grid.rows.map((r) => [r.key, r]));
  const byOp = new Map();
  const seen = new Set();
  for (const cell of cells) {
    const r = rowOf.get(String(cell?.rowKey));
    const opId = Number(cell?.operationId);
    if (!r) { problems.push('A picked row is not part of this production order.'); continue; }
    const k = `${r.key}|${opId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const cl = r.cells[opId];
    const opName = g.operations.get(opId)?.name ?? `operation ${opId}`;
    if (!cl) { problems.push(`${r.name}: ${opName} is not in its flow.`); continue; }
    if (cl.workOrder) { problems.push(`${r.name} · ${opName} is already with ${cl.workOrder.contractor.name} (${cl.workOrder.code}).`); continue; }
    if (cl.started) { problems.push(`${r.name} · ${opName} has started in-house — it stays in-house.`); continue; }
    if (r.tonnes == null) { problems.push(`${r.name} has no weight yet — its tonnes are unknown. Complete its values in Structure first.`); continue; }
    if (!byOp.has(opId)) byOp.set(opId, { op: g.operations.get(opId), rows: [] });
    byOp.get(opId).rows.push(r);
  }
  const rates = input.rates ?? {};
  const lines = [];
  for (const [opId, x] of byOp) {
    const tonnes = round6(x.rows.reduce((t, r) => t + r.tonnes, 0));
    const rate = Number(rates[opId] ?? rates[String(opId)]);
    if (!(tonnes > EPS)) problems.push(`${x.op.name}: the picked rows weigh nothing — nothing to pay by the tonne.`);
    if (!Number.isFinite(rate) || rate <= 0) problems.push(`${x.op.name}: give the rate per tonne.`);
    lines.push({ operation: { id: x.op.id, code: x.op.code, name: x.op.name }, rows: x.rows.length, tonnes: round3(tonnes), exactTonnes: tonnes, rate: Number.isFinite(rate) ? rate : null,
      amount: Number.isFinite(rate) ? round2(tonnes * rate) : null, cells: x.rows.map((r) => ({ rowKey: r.key, bomLineId: r.bomLineId, lineId: r.lineId, quantity: r.quantity, unitKg: r.unitKg, tonnes: r.tonnes })) });
  }
  let dueDate = null;
  if (!blank(input.dueDate)) {
    dueDate = String(input.dueDate).slice(0, 10);
    if (!DATE_RE.test(dueDate)) problems.push('Due date: YYYY-MM-DD.');
  }
  const plan = {
    dryRun: true,
    productionOrder: grid.productionOrder,
    contractor: contractor ? { id: contractor.id, name: contractor.name } : null,
    lines: lines.map(({ cells: cs, exactTonnes, ...l }) => ({ ...l, cellCount: cs.length })),
    tonnes: round3(lines.reduce((t, l) => t + l.exactTonnes, 0)),
    amount: round2(lines.reduce((t, l) => t + (l.amount ?? 0), 0)),
    problems,
  };
  if (dryRun) return plan;
  assertNoProblems(problems, problems.length === 1 ? problems[0] : 'The work order cannot be made yet.');

  // 1. the service items, 2. the contractor PO (pending Management), 3. its lines, 4. the work order, 5. its cells.
  const items = await ensureServiceItems(db, c, lines.map((l) => l.operation));
  const g1 = await generate(db, c.companyId, 'purchase_order', 'code', { draft: { suggested: false } }, { consume: true });
  const notes = blank(input.notes) ? null : String(input.notes).slice(0, 1000);
  const poId = await insertOrder(db, c, {
    code: g1?.text && !(g1.missing?.length) ? g1.text : null, supplierId: contractor.id, expectedDate: dueDate,
    notes: `Contractor work for ${g.po.code}${notes ? ` — ${notes}` : ''}`, suggested: false, forOrderId: g.po.order.id,
  });
  await db.query("UPDATE cf_purchase_orders SET po_type = 'contractor', approval_status = 'pending' WHERE company_id = ? AND id = ?", [c.companyId, poId]);
  await insertRows(db, 'cf_purchase_order_lines', ['company_id', 'purchase_order_id', 'line_no', 'item_id', 'quantity', 'uom', 'unit_price', 'note'],
    lines.map((l, i) => [c.companyId, poId, (i + 1) * 10, items.get(Number(l.operation.id)), round6(l.exactTonnes), 't', l.rate,
      `${l.operation.name}: ${l.rows} row${l.rows === 1 ? '' : 's'} of ${g.po.code}`.slice(0, 500)]));
  const [poLines] = await db.query('SELECT id, item_id FROM cf_purchase_order_lines WHERE company_id = ? AND purchase_order_id = ? AND deleted_at IS NULL', [c.companyId, poId]);
  const lineOfItem = new Map(poLines.map((l) => [Number(l.item_id), l.id]));
  const lineId = g.po.line?.id ?? g.po.lineIds[0];
  const gw = await generate(db, c.companyId, 'work_order', 'code', { draft: { contractorId: contractor.id, lineId } }, { consume: true });
  const woCode = gw?.text && !(gw.missing?.length) ? gw.text : null;
  const [w] = await db.query(
    `INSERT INTO cf_work_orders (company_id, code, order_id, order_line_id, contractor_id, status, due_date, notes, created_by, kind, purchase_order_id, production_order_id)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, 'po', ?, ?)`,
    [c.companyId, woCode, g.po.order.id, lineId, contractor.id, dueDate, notes, c.userId ?? null, poId, g.po.id],
  );
  const woId = w.insertId;
  if (!woCode) await db.query('UPDATE cf_work_orders SET code = ? WHERE company_id = ? AND id = ?', [`WO-${String(woId).padStart(6, '0')}`, c.companyId, woId]);
  await insertRows(db, 'cf_work_order_scope',
    ['company_id', 'work_order_id', 'production_order_id', 'order_line_id', 'bom_line_id', 'path_key', 'path_hash', 'operation_id', 'po_line_id', 'quantity', 'unit_kg', 'tonnes'],
    lines.flatMap((l) => l.cells.map((x) => [c.companyId, woId, g.po.id, x.lineId, x.bomLineId, x.rowKey.slice(0, 1000), hashOf(x.rowKey), l.operation.id,
      lineOfItem.get(Number(items.get(Number(l.operation.id)))), x.quantity, x.unitKg, x.tonnes])));
  await askPoApproval(db, c, poId);
  if (g.po.status !== 'yet_to_plan') await stampContractorSteps(db, c, { productionOrderIds: [g.po.id] });
  return readContractorWorkOrder(db, c.companyId, woId);
}

/* ===========================================================================
 * Released steps carry their work order
 * ======================================================================== */

/**
 * Every NOT-STARTED step of these production orders (or lines) whose cell is on an open work order takes its id; a
 * step whose cell no longer is (cancelled) goes back in-house. Steps on the older (§30) work orders are left alone.
 * 4 reads + one UPDATE per work order touched.
 */
export async function stampContractorSteps(db, c, { productionOrderIds = null, lineIds = null } = {}) {
  let poIds = (productionOrderIds ?? []).map(Number);
  if (lineIds?.length) {
    const [rows] = await db.query(
      'SELECT DISTINCT production_order_id AS id FROM cf_work_order_scope WHERE company_id = ? AND order_line_id IN (?) AND production_order_id IS NOT NULL',
      [c.companyId, lineIds.map(Number)],
    ).catch(() => [[]]);
    poIds = [...new Set([...poIds, ...rows.map((r) => Number(r.id))])];
  }
  if (!poIds.length) return 0;
  const [scope] = await db.query(
    `SELECT s.production_order_id, s.path_key, s.operation_id, s.work_order_id, s.deleted_at, w.status AS wo_status, po.status AS po_status
       FROM cf_work_order_scope s
       JOIN cf_work_orders w ON w.id = s.work_order_id AND w.deleted_at IS NULL
       LEFT JOIN cf_purchase_orders po ON po.id = w.purchase_order_id
      WHERE s.company_id = ? AND s.production_order_id IN (?)`,
    [c.companyId, poIds],
  );
  // Every work order of these production orders is "ours" (a step carrying one may be cleared); the live cells say who
  // holds a cell now. A step on an older (§30) work order is never touched.
  const ours = new Set(scope.map((s) => Number(s.work_order_id)));
  const live = new Map();
  for (const s of scope) {
    if (s.deleted_at || s.wo_status === 'cancelled' || s.po_status === 'cancelled') continue;
    live.set(`${s.production_order_id}|${s.path_key}|${s.operation_id}`, Number(s.work_order_id));
  }
  const [items] = await db.query(
    `SELECT pi.id, pi.parent_id, pi.depth, pi.bom_line_id, pi.item_id, pi.production_order_id, r.order_line_id
       FROM cf_production_items pi JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
      WHERE pi.company_id = ? AND r.order_line_id IN (SELECT DISTINCT order_line_id FROM cf_work_order_scope WHERE company_id = ? AND production_order_id IN (?))
        AND pi.deleted_at IS NULL`,
    [c.companyId, c.companyId, poIds],
  );
  if (!items.length) return 0;
  const pathOf = new Map();
  for (const lid of [...new Set(items.map((i) => Number(i.order_line_id)))]) {
    for (const [k, v] of piecePaths(lid, items.filter((x) => Number(x.order_line_id) === lid))) pathOf.set(k, v);
  }
  const poOfItem = new Map(items.map((i) => [Number(i.id), Number(i.production_order_id)]));
  const [steps] = await db.query(
    `SELECT s.id, s.production_item_id, s.operation_id, s.work_order_id FROM cf_production_steps s
      WHERE s.company_id = ? AND s.production_order_id IN (?) AND s.deleted_at IS NULL AND s.state = 'pending' AND s.started_at IS NULL AND s.qty_good = 0`,
    [c.companyId, poIds],
  );
  const to = new Map();
  for (const s of steps) {
    const key = `${poOfItem.get(Number(s.production_item_id))}|${pathOf.get(Number(s.production_item_id))}|${s.operation_id}`;
    const want = live.get(key) ?? null;
    const has = s.work_order_id == null ? null : Number(s.work_order_id);
    if (want === has) continue;
    if (want == null && has != null && !ours.has(has)) continue;     // an older (§30) work order's step
    const k = want ?? 0;
    if (!to.has(k)) to.set(k, []);
    to.get(k).push(s.id);
  }
  let n = 0;
  for (const [wo, ids] of to) {
    for (let i = 0; i < ids.length; i += 1000) {
      const part = ids.slice(i, i + 1000);
      await db.query('UPDATE cf_production_steps SET work_order_id = ? WHERE company_id = ? AND id IN (?)', [wo || null, c.companyId, part]);
      n += part.length;
    }
  }
  return n;
}

/* ===========================================================================
 * Reading work orders: lanes, one, the planner's cells
 * ======================================================================== */

/** The lane of a work order from its PO and payments. PURE. */
export function laneOf(w, po, done, paid, doneValue = 0) {
  if (w.status === 'cancelled' || po?.status === 'cancelled') return 'cancelled';
  if (!po) return w.status === 'draft' ? 'waiting_approval' : w.status === 'done' ? 'completed' : w.status === 'issued' ? 'issued' : 'in_progress';
  const stage = poStage(po);
  if (stage === 'pending_approval' || stage === 'requested') return 'waiting_approval';
  if (stage === 'closed' || stage === 'closed_short') return paid + 0.005 >= doneValue ? 'paid' : 'completed';
  return done > EPS || paid > EPS ? 'in_progress' : 'issued';
}

const WO_SQL = `SELECT w.*, p.name AS contractor_name, p.code AS contractor_code, o.code AS order_code, o.title AS order_title, o.status AS order_status,
                       pr.code AS prod_code, pr.label AS prod_label,
                       po.code AS po_code, po.status AS po_status, po.approval_status, po.closed_at, po.close_reason, po.notes AS po_notes, po.approved_at,
                       (SELECT COALESCE(SUM(l.quantity), 0) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = po.id AND l.deleted_at IS NULL) AS tonnes,
                       (SELECT COALESCE(SUM(l.qty_received), 0) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = po.id AND l.deleted_at IS NULL) AS done,
                       (SELECT COALESCE(SUM(l.quantity * l.unit_price), 0) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = po.id AND l.deleted_at IS NULL) AS value,
                       (SELECT COALESCE(SUM(l.qty_received * l.unit_price), 0) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = po.id AND l.deleted_at IS NULL) AS done_value,
                       (SELECT COALESCE(SUM(x.amount), 0) FROM cf_work_order_payments x WHERE x.work_order_id = w.id AND x.deleted_at IS NULL) AS paid,
                       (SELECT MAX(x.payment_date) FROM cf_work_order_payments x WHERE x.work_order_id = w.id AND x.deleted_at IS NULL) AS last_paid
                  FROM cf_work_orders w
                  JOIN cf_parties p ON p.id = w.contractor_id
                  JOIN cf_sales_orders o ON o.id = w.order_id
                  LEFT JOIN cf_production_orders pr ON pr.id = w.production_order_id
                  LEFT JOIN cf_purchase_orders po ON po.id = w.purchase_order_id`;

function shapeWo(w) {
  const po = w.purchase_order_id ? { status: w.po_status, approval_status: w.approval_status, closed_at: w.closed_at } : null;
  const tonnes = round3(w.tonnes ?? 0);
  const done = round3(w.done ?? 0);
  const paid = round2(w.paid ?? 0);
  const value = round2(w.value ?? 0);
  const doneValue = round2(w.done_value ?? 0);
  const lane = laneOf(w, po, done, paid, doneValue);
  const stage = po ? poStage(po) : null;
  return {
    id: w.id, code: w.code, kind: w.kind ?? 'cells', status: w.status, lane, laneLabel: WO_LANE_LABEL[lane],
    contractor: { id: w.contractor_id, code: w.contractor_code, name: w.contractor_name },
    order: { id: w.order_id, code: w.order_code, title: w.order_title ?? null, status: w.order_status },
    productionOrder: w.production_order_id ? { id: w.production_order_id, code: w.prod_code, label: w.prod_label } : null,
    purchaseOrder: po ? { id: w.purchase_order_id, code: w.po_code, stage, stageLabel: PO_STAGE_LABEL[stage] } : null,
    sentBack: stage === 'requested' ? (String(w.po_notes ?? '').split('\n').reverse().find((x) => x.startsWith('Sent back by Management:')) ?? 'Sent back by Management.') : null,
    tonnes, done, pending: stage === 'closed' || stage === 'closed_short' ? 0 : round3(Math.max(0, tonnes - done)),
    value, doneValue, paid, owed: round2(Math.max(0, doneValue - paid)),
    pct: tonnes > EPS ? Math.min(100, Math.round((done / tonnes) * 1000) / 10) : 0,
    dueDate: dateText(w.due_date), startDate: dateText(w.start_date), lastPaid: dateText(w.last_paid),
    approvedAt: w.approved_at ?? null, closeReason: w.close_reason ?? null,
    notes: w.notes ?? null, createdAt: w.created_at,
  };
}

/** GET /accounts/work-orders?search=&contractorId=&orderId= — the lanes. Paid in full shows the last 90 days. 2 reads. */
export async function workOrderBoard(db, companyId, q = {}) {
  const where = ["w.company_id = ?", 'w.deleted_at IS NULL', "w.kind = 'po'", "w.status <> 'cancelled'", "(po.id IS NULL OR po.status <> 'cancelled')"];
  const args = [companyId];
  if (!blank(q.contractorId)) { where.push('w.contractor_id = ?'); args.push(Number(q.contractorId)); }
  if (!blank(q.orderId)) { where.push('w.order_id = ?'); args.push(Number(q.orderId)); }
  if (!blank(q.productionOrderId)) { where.push('w.production_order_id = ?'); args.push(Number(q.productionOrderId)); }
  const like = likeOf(q.search);
  if (like) { where.push('(w.code LIKE ? OR p.name LIKE ? OR o.code LIKE ? OR po.code LIKE ? OR pr.code LIKE ?)'); args.push(like, like, like, like, like); }
  const [rows] = await db.query(`${WO_SQL} WHERE ${where.join(' AND ')} ORDER BY w.id DESC LIMIT 1000`, args);
  const shaped = rows.map(shapeWo);
  const cutoff = new Date(Date.now() - 90 * 86400000);
  const lanes = WO_LANES.map((key) => {
    let cards = shaped.filter((x) => x.lane === key);
    if (key === 'paid') cards = cards.filter((x) => !x.lastPaid || new Date(x.lastPaid) >= cutoff);
    return { key, label: WO_LANE_LABEL[key], cards, value: round2(cards.reduce((t, x) => t + x.value, 0)), owed: round2(cards.reduce((t, x) => t + x.owed, 0)) };
  });
  return {
    lanes,
    counts: { waitingApproval: lanes[0].cards.length, owed: round2(shaped.reduce((t, x) => t + x.owed, 0)), open: shaped.filter((x) => x.lane !== 'paid').length },
    today: today(),
  };
}

async function requireWo(db, companyId, id, { lock = false } = {}) {
  const [[w]] = await db.query(`${WO_SQL} WHERE w.company_id = ? AND w.id = ? AND w.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(id)]);
  if (!w) throw notFound('Work order');
  return w;
}
const requirePoWo = async (db, companyId, id, opts) => {
  const w = await requireWo(db, companyId, id, opts);
  if (w.kind !== 'po' || !w.purchase_order_id) throw invalid('OLD_WORK_ORDER', `${w.code} is an older work order (cells on pieces) — it is read-only here.`);
  return w;
};

/** GET /accounts/work-orders/:id — head, lines (operation, tonnes, rate, done, paid), the cells, payments, actions. 5 reads. */
export async function readContractorWorkOrder(db, companyId, id) {
  const w = await requireWo(db, companyId, id);
  const head = shapeWo(w);
  if (!w.purchase_order_id) return { ...head, lines: [], scope: [], payments: [], actions: {} };
  const [[lines], [scope], [pays], [payLines], waits] = await Promise.all([
    db.query(
      `SELECT l.id, l.line_no, l.quantity, l.qty_received, l.qty_closed, l.unit_price, m.code AS item_code, m.name AS item_name,
              (SELECT MIN(s.operation_id) FROM cf_work_order_scope s WHERE s.po_line_id = l.id) AS operation_id
         FROM cf_purchase_order_lines l JOIN cf_master_records m ON m.id = l.item_id
        WHERE l.company_id = ? AND l.purchase_order_id = ? AND l.deleted_at IS NULL ORDER BY l.line_no, l.id`,
      [companyId, w.purchase_order_id]),
    db.query(
      `SELECT s.id, s.path_key, s.order_line_id, s.bom_line_id, s.operation_id, s.po_line_id, s.quantity, s.unit_kg, s.tonnes, s.deleted_at,
              op.code AS op_code, op.name AS op_name, m.name AS row_name, sl.line_no
         FROM cf_work_order_scope s
         JOIN cf_operations op ON op.id = s.operation_id
         JOIN cf_sales_order_lines sl ON sl.id = s.order_line_id
         LEFT JOIN cf_bom_lines bl ON bl.id = s.bom_line_id
         LEFT JOIN cf_master_records m ON m.id = COALESCE(bl.child_id, sl.item_id)
        WHERE s.company_id = ? AND s.work_order_id = ? ORDER BY s.id`,
      [companyId, w.id]),
    db.query(
      `SELECT x.*, u.name AS by_name, r.name AS removed_by_name FROM cf_work_order_payments x
         LEFT JOIN users u ON u.id = x.created_by LEFT JOIN users r ON r.id = x.removed_by
        WHERE x.company_id = ? AND x.work_order_id = ? ORDER BY x.payment_date DESC, x.id DESC`,
      [companyId, w.id]),
    db.query('SELECT y.* FROM cf_work_order_payment_lines y JOIN cf_work_order_payments x ON x.id = y.payment_id WHERE y.company_id = ? AND x.work_order_id = ?', [companyId, w.id]),
    pendingFor(db, companyId, 'purchase_order', [w.purchase_order_id]),
  ]);
  const opName = new Map(scope.map((s) => [Number(s.operation_id), { id: s.operation_id, code: s.op_code, name: s.op_name }]));
  const paidOf = new Map();
  for (const y of payLines) {
    const x = pays.find((p) => p.id === y.payment_id);
    if (!x || x.deleted_at) continue;
    paidOf.set(Number(y.po_line_id), round2((paidOf.get(Number(y.po_line_id)) ?? 0) + Number(y.amount)));
  }
  const open = ['waiting_approval', 'issued', 'in_progress'].includes(head.lane);
  const waiting = waits.get(Number(w.purchase_order_id)) ?? [];
  return {
    ...head,
    pendingApprovals: waiting.map((a) => ({ id: a.id, type: a.type, typeLabel: a.typeLabel, requestedAt: a.requestedAt })),
    lines: lines.map((l) => ({
      id: l.id, lineNo: l.line_no, operation: opName.get(Number(l.operation_id)) ?? { id: l.operation_id, code: l.item_code, name: l.item_name },
      tonnes: round3(l.quantity), done: round3(l.qty_received), closed: round3(l.qty_closed ?? 0),
      pending: head.pending === 0 ? 0 : round3(Math.max(0, Number(l.quantity) - Number(l.qty_received))),
      rate: l.unit_price == null ? null : Number(l.unit_price), value: round2(Number(l.quantity) * Number(l.unit_price ?? 0)),
      doneValue: round2(Number(l.qty_received) * Number(l.unit_price ?? 0)), paid: paidOf.get(Number(l.id)) ?? 0,
    })),
    scope: scope.filter((s) => !s.deleted_at).map((s) => ({
      rowKey: s.path_key, lineNo: s.line_no, name: s.row_name ?? `Line ${s.line_no}`, operation: { id: s.operation_id, code: s.op_code, name: s.op_name },
      quantity: Number(s.quantity), unitKg: s.unit_kg == null ? null : Number(s.unit_kg), tonnes: s.tonnes == null ? null : round3(s.tonnes),
    })),
    payments: pays.map((x) => ({
      id: x.id, date: dateText(x.payment_date), reference: x.reference ?? null, notes: x.notes ?? null, tonnes: round3(x.tonnes), amount: round2(x.amount),
      by: x.by_name ?? null, at: x.created_at, removed: x.deleted_at ? { at: x.deleted_at, by: x.removed_by_name ?? null, reason: x.remove_reason ?? null } : null,
      lines: payLines.filter((y) => y.payment_id === x.id).map((y) => ({ poLineId: y.po_line_id, operationId: y.operation_id, tonnes: round3(y.tonnes), rate: y.rate == null ? null : Number(y.rate), amount: round2(y.amount) })),
    })),
    actions: {
      pay: ['issued', 'in_progress', 'completed'].includes(head.lane),
      closeShort: ['issued', 'in_progress'].includes(head.lane) && !waiting.some((a) => a.type === 'po_close_short'),
      cancel: open && head.done < EPS && head.paid < EPS,
      sendAgain: !!head.sentBack,
    },
  };
}

/**
 * GET /contractor-work/cells?productionOrderIds=&orderIds= — FOR THE PLANNER: which cells (BOM row × operation of a
 * production order) are under an open work order, with the contractor, and the released steps that carry it.
 * → { cells: [{ productionOrderId, orderLineId, bomLineId, rowKey, operationId, workOrder: { id, code, lane }, contractor }],
 *     stepIds: { [workOrderId]: [step ids] } }. 2 reads.
 */
export async function contractorCellsOf(db, companyId, q = {}) {
  const ids = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const poIds = ids(q.productionOrderIds);
  const orderIds = ids(q.orderIds);
  const cond = [];
  const args = [companyId];
  if (poIds.length) { cond.push('s.production_order_id IN (?)'); args.push(poIds); }
  if (orderIds.length) { cond.push('w.order_id IN (?)'); args.push(orderIds); }
  const [rows] = await db.query(
    `${OWNER_SQL} AND (po.id IS NULL OR NOT (po.status = 'received')) ${cond.length ? `AND (${cond.join(' OR ')})` : ''} ORDER BY s.id LIMIT 20000`,
    args,
  );
  const woIds = [...new Set(rows.map((r) => Number(r.work_order_id)))];
  const [steps] = woIds.length ? await db.query(
    "SELECT id, work_order_id FROM cf_production_steps WHERE company_id = ? AND work_order_id IN (?) AND deleted_at IS NULL AND state <> 'done'",
    [companyId, woIds],
  ) : [[]];
  const stepIds = {};
  for (const s of steps) (stepIds[s.work_order_id] ??= []).push(s.id);
  return {
    cells: rows.map((r) => ({
      productionOrderId: r.production_order_id, orderLineId: r.order_line_id, rowKey: r.path_key, operationId: r.operation_id,
      bomLineId: Number(String(r.path_key).split(':')[1]?.split('/').pop()) || null,
      workOrder: { id: r.work_order_id, code: r.wo_code, lane: laneOf({ status: r.wo_status }, r.po_id ? { status: r.po_status, approval_status: r.approval_status, closed_at: r.closed_at } : null, 0, 0) },
      contractor: { id: r.contractor_id, name: r.contractor_name },
      text: `with ${r.contractor_name} (${r.wo_code})`,
    })),
    stepIds,
  };
}

/* ===========================================================================
 * Weekly payments
 * ======================================================================== */

/** The PO's status from its lines after done tonnes moved (purchaseService.restate's rule; a PO closed short stays). */
async function restatePo(db, companyId, poId) {
  await db.query(
    `UPDATE cf_purchase_orders p
        SET p.status = (SELECT CASE WHEN COUNT(*) > 0 AND SUM(l.qty_received >= l.quantity - 0.000001) = COUNT(*) THEN 'received'
                                    WHEN SUM(l.qty_received > 0.000001) > 0 THEN 'partially_received' ELSE 'ordered' END
                          FROM cf_purchase_order_lines l WHERE l.company_id = p.company_id AND l.purchase_order_id = p.id AND l.deleted_at IS NULL)
      WHERE p.company_id = ? AND p.id = ? AND p.closed_at IS NULL AND p.status IN ('ordered','partially_received','received')`,
    [companyId, poId],
  );
}
/** The stored status of a work order follows its lane (older screens and the dashboard read it). */
async function syncStatus(db, companyId, id) {
  const w = shapeWo(await requireWo(db, companyId, id));
  const status = { waiting_approval: 'draft', issued: 'issued', in_progress: 'in_progress', completed: 'done', paid: 'done', cancelled: 'cancelled' }[w.lane];
  if (status && status !== w.status) await db.query('UPDATE cf_work_orders SET status = ? WHERE company_id = ? AND id = ?', [status, companyId, id]);
}

/**
 * POST /accounts/work-orders/:id/payments
 *   { paymentDate?, reference?, notes?, lines: [{ poLineId, tonnes?, rate?, amount? }], dryRun? }
 * A week's payment: per operation the tonnes done (≤ pending) and/or an amount; rate defaults to the PO's, amount to
 * tonnes × rate. Tonnes done go onto the PO line (qty_received) — all done → the PO closes by itself. 6 statements.
 */
export async function recordPayment(db, c, id, input = {}) {
  const dryRun = !!input.dryRun;
  const w = await requirePoWo(db, c.companyId, id, { lock: !dryRun });
  const head = shapeWo(w);
  const problems = [];
  if (!['issued', 'in_progress', 'completed'].includes(head.lane)) {
    problems.push(head.lane === 'waiting_approval' ? `${w.code} waits for Management approval — pay it once it is issued.` : `${w.code} is ${head.laneLabel.toLowerCase()}.`);
  }
  const date = blank(input.paymentDate) ? today() : String(input.paymentDate).slice(0, 10);
  if (!DATE_RE.test(date)) problems.push('Date: YYYY-MM-DD.');
  else if (date > today()) problems.push('The payment date is in the future.');
  const [poLines] = await db.query(
    `SELECT l.id, l.quantity, l.qty_received, l.unit_price, (SELECT MIN(s.operation_id) FROM cf_work_order_scope s WHERE s.po_line_id = l.id) AS operation_id, m.name AS item_name
       FROM cf_purchase_order_lines l JOIN cf_master_records m ON m.id = l.item_id
      WHERE l.company_id = ? AND l.purchase_order_id = ? AND l.deleted_at IS NULL${dryRun ? '' : ' FOR UPDATE'}`,
    [c.companyId, w.purchase_order_id],
  );
  const byId = new Map(poLines.map((l) => [Number(l.id), l]));
  const closed = head.lane === 'completed';
  const out = [];
  for (const raw of Array.isArray(input.lines) ? input.lines : []) {
    const l = byId.get(Number(raw?.poLineId));
    if (!l) { problems.push('A payment line is not on this work order.'); continue; }
    const name = String(l.item_name).replace(/^Contractor work — /, '');
    const tonnes = blank(raw.tonnes) ? 0 : Number(raw.tonnes);
    const rate = blank(raw.rate) ? Number(l.unit_price ?? 0) : Number(raw.rate);
    if (!Number.isFinite(tonnes) || tonnes < 0) { problems.push(`${name}: tonnes done is a number, 0 or more.`); continue; }
    if (!Number.isFinite(rate) || rate < 0) { problems.push(`${name}: the rate is a number, 0 or more.`); continue; }
    const pending = Math.max(0, Number(l.quantity) - Number(l.qty_received));
    if (closed && tonnes > EPS) problems.push(`${name}: the work order is complete — record an amount only.`);
    else if (tonnes > pending + 0.0005) problems.push(`${name}: only ${round3(pending)} t is still to do.`);
    const amount = blank(raw.amount) ? round2(tonnes * rate) : Number(raw.amount);
    if (!Number.isFinite(amount) || amount < 0) { problems.push(`${name}: the amount is a number, 0 or more.`); continue; }
    if (tonnes <= EPS && amount <= EPS) continue;
    out.push({ poLineId: l.id, operationId: l.operation_id, name, tonnes: round6(Math.min(tonnes, pending)), rate, amount: round2(amount) });
  }
  if (!out.length) problems.push('Enter the tonnes done or an amount on at least one operation.');
  const total = round2(out.reduce((t, x) => t + x.amount, 0));
  const tonnes = round6(out.reduce((t, x) => t + x.tonnes, 0));
  if (dryRun) return { dryRun: true, lines: out, amount: total, tonnes: round3(tonnes), problems };
  assertNoProblems(problems, problems.length === 1 ? problems[0] : 'The payment cannot be recorded.');
  const [r] = await db.query(
    `INSERT INTO cf_work_order_payments (company_id, work_order_id, purchase_order_id, payment_date, reference, notes, tonnes, amount, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, w.id, w.purchase_order_id, date, blank(input.reference) ? null : String(input.reference).slice(0, 100),
      blank(input.notes) ? null : String(input.notes).slice(0, 500), tonnes, total, c.userId ?? null],
  );
  await insertRows(db, 'cf_work_order_payment_lines', ['company_id', 'payment_id', 'po_line_id', 'operation_id', 'tonnes', 'rate', 'amount'],
    out.map((x) => [c.companyId, r.insertId, x.poLineId, x.operationId, x.tonnes, x.rate, x.amount]));
  const moving = out.filter((x) => x.tonnes > EPS);
  if (moving.length) {
    await db.query(
      `UPDATE cf_purchase_order_lines SET qty_received = qty_received + CASE id ${moving.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE company_id = ? AND id IN (?)`,
      [...moving.flatMap((x) => [x.poLineId, x.tonnes]), c.companyId, moving.map((x) => x.poLineId)],
    );
    await restatePo(db, c.companyId, w.purchase_order_id);
  }
  await syncStatus(db, c.companyId, w.id);
  const wo = await readContractorWorkOrder(db, c.companyId, w.id);
  return { payment: { id: r.insertId, amount: total, tonnes: round3(tonnes) }, workOrder: wo, closed: wo.lane === 'completed' || wo.lane === 'paid' };
}

/** DELETE /accounts/work-order-payments/:id { reason } — entered by mistake: the tonnes go back off the PO. */
export async function removePayment(db, c, paymentId, input = {}) {
  if (blank(input.reason)) throw invalid('REASON', 'Say why the payment is removed.');
  const [[x]] = await db.query('SELECT * FROM cf_work_order_payments WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, Number(paymentId)]);
  if (!x) throw notFound('Payment');
  if (x.deleted_at) throw conflict('REMOVED', 'That payment was removed already.');
  const [[po]] = await db.query('SELECT closed_at FROM cf_purchase_orders WHERE company_id = ? AND id = ?', [c.companyId, x.purchase_order_id]);
  const [lines] = await db.query('SELECT po_line_id, tonnes FROM cf_work_order_payment_lines WHERE company_id = ? AND payment_id = ? AND tonnes > 0', [c.companyId, x.id]);
  if (lines.length && po?.closed_at) throw conflict('CLOSED_SHORT', 'The work order was closed short after this payment — its tonnes cannot go back.');
  await db.query('UPDATE cf_work_order_payments SET deleted_at = NOW(), removed_by = ?, remove_reason = ? WHERE id = ?', [c.userId ?? null, String(input.reason).slice(0, 500), x.id]);
  if (lines.length) {
    await db.query(
      `UPDATE cf_purchase_order_lines SET qty_received = GREATEST(0, qty_received - CASE id ${lines.map(() => 'WHEN ? THEN ?').join(' ')} END) WHERE company_id = ? AND id IN (?)`,
      [...lines.flatMap((l) => [l.po_line_id, Number(l.tonnes)]), c.companyId, lines.map((l) => l.po_line_id)],
    );
    await restatePo(db, c.companyId, x.purchase_order_id);
  }
  await syncStatus(db, c.companyId, x.work_order_id);
  return readContractorWorkOrder(db, c.companyId, x.work_order_id);
}

/* ===========================================================================
 * Close short, cancel, send again
 * ======================================================================== */

/** POST /accounts/work-orders/:id/close-short { reason } — asks Management (the PO's close-short approval). */
export async function askCloseShort(db, c, id, input = {}) {
  const w = await requirePoWo(db, c.companyId, id);
  await requestCloseShort(db, c, w.purchase_order_id, { reason: input.reason });
  return readContractorWorkOrder(db, c.companyId, w.id);
}

/** POST /accounts/work-orders/:id/send-again — after Management sent it back. */
export async function sendAgain(db, c, id) {
  const w = await requirePoWo(db, c.companyId, id);
  await markOrdered(db, c, w.purchase_order_id, {});
  return readContractorWorkOrder(db, c.companyId, w.id);
}

/**
 * POST /accounts/work-orders/:id/cancel { reason } — nothing done, nothing paid: the PO is cancelled, the cells go back
 * in-house (free for another work order) and the steps that carried it are in-house again.
 */
export async function cancelContractorWorkOrder(db, c, id, input = {}) {
  const w = await requirePoWo(db, c.companyId, id, { lock: true });
  const head = shapeWo(w);
  if (head.lane === 'cancelled') throw conflict('CANCELLED', `${w.code} is cancelled already.`);
  if (head.done > EPS || head.paid > EPS) throw conflict('STARTED', `${w.code} has work done or paid — close it short instead.`);
  if (blank(input.reason)) throw invalid('REASON', 'Say why the work order is cancelled.');
  if (w.po_status !== 'cancelled') await cancelPurchaseOrder(db, c, w.purchase_order_id, { reason: input.reason });
  await db.query("UPDATE cf_work_orders SET status = 'cancelled', notes = CONCAT(COALESCE(notes, ''), IF(notes IS NULL, '', '\\n'), ?) WHERE company_id = ? AND id = ?",
    [`Cancelled: ${String(input.reason).slice(0, 255)}`, c.companyId, w.id]);
  await db.query('UPDATE cf_work_order_scope SET deleted_at = NOW() WHERE company_id = ? AND work_order_id = ? AND deleted_at IS NULL', [c.companyId, w.id]);
  await db.query("UPDATE cf_production_steps SET work_order_id = NULL WHERE company_id = ? AND work_order_id = ? AND state = 'pending'", [c.companyId, w.id]);
  return readContractorWorkOrder(db, c.companyId, w.id);
}

/* ===========================================================================
 * Approval: the contractor PO's Management inbox row issues the work order
 * ======================================================================== */

/** approvalService handler for 'contractor_po': the PO's own handling, then its work order follows. */
export const contractorPoApprovalHandler = {
  onApprove: async (db, c, row, note) => {
    const out = await poApprovalHandler.onApprove(db, c, row, note);
    await db.query(
      "UPDATE cf_work_orders SET status = 'issued', start_date = COALESCE(start_date, CURDATE()) WHERE company_id = ? AND purchase_order_id = ? AND status = 'draft' AND deleted_at IS NULL",
      [c.companyId, row.subject_id],
    );
    return out;
  },
  onReject: (db, c, row, note) => poApprovalHandler.onReject(db, c, row, note),
  onWithdraw: (db, c, row) => poApprovalHandler.onWithdraw(db, c, row),
  // The inbox shows the PO (lines, rates, quotes) and, for a work order, what it covers.
  context: async (db, companyId, rows) => {
    const out = await poApprovalHandler.context(db, companyId, rows);
    const poIds = rows.map((r) => Number(r.subject.id));
    if (!poIds.length) return out;
    const [wos] = await db.query(
      `SELECT w.id, w.code, w.purchase_order_id, pr.code AS prod_code, pr.label AS prod_label,
              (SELECT COUNT(*) FROM cf_work_order_scope s WHERE s.work_order_id = w.id AND s.deleted_at IS NULL) AS cells
         FROM cf_work_orders w LEFT JOIN cf_production_orders pr ON pr.id = w.production_order_id
        WHERE w.company_id = ? AND w.purchase_order_id IN (?) AND w.deleted_at IS NULL`,
      [companyId, poIds],
    );
    for (const r of rows) {
      const ctx = out.get(r.id);
      const w = wos.find((x) => Number(x.purchase_order_id) === Number(r.subject.id));
      if (ctx && w) ctx.workOrder = { id: w.id, code: w.code, productionOrder: w.prod_code ? { code: w.prod_code, label: w.prod_label } : null, cells: Number(w.cells) };
    }
    return out;
  },
};

/* ===========================================================================
 * Cost: what was paid to contractors for each sales order
 * ======================================================================== */

/** order id → { paid, doneValue, committed, workOrders }. One read for any number of orders (revisions by code). */
export async function contractorCostOf(db, companyId, orderIds) {
  const ids = [...new Set((orderIds ?? []).map(Number))];
  const out = new Map(ids.map((id) => [id, { paid: 0, doneValue: 0, committed: 0, workOrders: [] }]));
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT a.id AS asked_id, w.id, w.code, p.name AS contractor_name,
            (SELECT COALESCE(SUM(x.amount), 0) FROM cf_work_order_payments x WHERE x.work_order_id = w.id AND x.deleted_at IS NULL) AS paid,
            (SELECT COALESCE(SUM(l.qty_received * l.unit_price), 0) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = w.purchase_order_id AND l.deleted_at IS NULL) AS done_value,
            (SELECT COALESCE(SUM(l.quantity * l.unit_price), 0) FROM cf_purchase_order_lines l WHERE l.purchase_order_id = w.purchase_order_id AND l.deleted_at IS NULL) AS committed
       FROM cf_sales_orders a
       JOIN cf_sales_orders o ON o.company_id = a.company_id AND o.code_active = a.code_active AND o.deleted_at IS NULL
       JOIN cf_work_orders w ON w.company_id = o.company_id AND w.order_id = o.id AND w.deleted_at IS NULL AND w.kind = 'po' AND w.status <> 'cancelled'
       JOIN cf_parties p ON p.id = w.contractor_id
       JOIN cf_purchase_orders po ON po.id = w.purchase_order_id AND po.status <> 'cancelled'
      WHERE a.company_id = ? AND a.id IN (?)`,
    [companyId, ids],
  ).catch((e) => { if (e?.code === 'ER_NO_SUCH_TABLE' || e?.code === 'ER_BAD_FIELD_ERROR') return [[]]; throw e; });
  for (const r of rows) {
    const s = out.get(Number(r.asked_id));
    if (!s) continue;
    s.paid = round2(s.paid + Number(r.paid));
    s.doneValue = round2(s.doneValue + Number(r.done_value));
    s.committed = round2(s.committed + Number(r.committed));
    s.workOrders.push({ id: r.id, code: r.code, contractor: r.contractor_name, paid: round2(r.paid), doneValue: round2(r.done_value), committed: round2(r.committed) });
  }
  return out;
}
