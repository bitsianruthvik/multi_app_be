/**
 * rowProgressService.js — CF_ERP. Where every row of an order line is in its flow, for the 3D progress view
 * (user, 2026-11-01: "the production order and sales order should show 3D diagrams of all the lines × quantities and
 * everything should be colored based on what step of flow it is at. If it is done to a sub assembly level, then the
 * entire subassembly should get one single color … if the cut pieces itself are not cut yet, it can look dotted").
 *
 * GET /orders/:orderId/lines/:lineId/row-progress[?productionOrderId=] →
 *   { lineId, orderId, quantity, released, operations: [{ code, name, seq }],
 *     rows: [{ rowId, parentRowId, mark, markNorm, depth, level, units: [UnitState] }] }
 *   UnitState (one per unit of the line, unit 1 … quantity):
 *     { state: 'not_released' | 'waiting' | 'working' | 'done' | 'joined', op: { code, name } | null,
 *       inProgress: bool, pieces, done, cut: { done, total } | null, inOrder: bool }
 *   - 'working' with op: the earliest step not done across the row's pieces in that unit (inProgress when a step of
 *     that operation is being worked);
 *   - 'joined': every piece of the row has gone into its parent (the parent's first step has started) — the 3D view
 *     then paints it with its parent, so a sub-assembly at assembly level is one colour, at any depth;
 *   - cut: the row's cut pieces (cut plate / blank nodes under it) and how many are cut (their first step done);
 *   - inOrder: false when a production order was asked for and this unit's pieces of the row are not in it;
 *   - now / last (2026-11-14): { code, name } of the operation being worked on the row's pieces right now, and of
 *     the furthest one done (its cut pieces' when none of its own is) — the 3D view glows the first and paints the
 *     second.
 * Rows come from partDrawingService.rowsOfLine (marks = DRAWING_MARK, the model's `mark` / `in`). One tracker read
 * (releaseService.evaluatedTracker), so a step is never "ready" here and "waiting" on the tracker.
 */
import { evaluatedTracker } from './releaseService.js';
import { rowsOfLine } from './partDrawingService.js';
import { notFound } from '../lib/errors.js';

export async function lineRowProgress(db, companyId, orderId, lineId, { productionOrderId = null } = {}) {
  const [[line]] = await db.query(
    `SELECT l.*, o.code AS order_code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.order_id = ? AND l.deleted_at IS NULL`,
    [companyId, Number(lineId), Number(orderId)],
  );
  if (!line) throw notFound('Order line');
  const qty = Math.max(1, Math.round(Number(line.quantity) || 1));
  const rows = await rowsOfLine(db, companyId, line);
  const [[rel]] = await db.query('SELECT id FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [companyId, line.id]);
  const shell = (state) => Array.from({ length: qty }, () => ({ state, op: null, inProgress: false, now: null, last: null, pieces: 0, done: 0, cut: null, inOrder: true }));
  const head = { lineId: Number(line.id), orderId: Number(line.order_id), orderCode: line.order_code, quantity: qty };
  if (!rel) {
    return { ...head, released: false, operations: [], rows: rows.map((r) => ({ ...rowHead(r), units: shell('not_released') })) };
  }
  const data = await evaluatedTracker(db, companyId, [Number(rel.id)]);
  if (!data) return { ...head, released: false, operations: [], rows: rows.map((r) => ({ ...rowHead(r), units: shell('not_released') })) };

  const items = data.items ?? [];
  const byId = new Map(items.map((it) => [Number(it.id), it]));
  const stepsOf = new Map();
  for (const s of data.steps ?? []) { const k = Number(s.production_item_id); if (!stepsOf.has(k)) stepsOf.set(k, []); stepsOf.get(k).push(s); }
  for (const ss of stepsOf.values()) ss.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  // The unit an item belongs to: its top item's place among the line's top items (piece_no where set).
  const tops = items.filter((it) => it.parent_id == null).sort((a, b) => (Number(a.piece_no) || 0) - (Number(b.piece_no) || 0) || Number(a.id) - Number(b.id));
  const unitOfTop = new Map(tops.map((t, i) => [Number(t.id), Math.min(i, qty - 1)]));
  const topOf = (it) => { let x = it; for (let h = 0; x?.parent_id != null && h < 60; h++) x = byId.get(Number(x.parent_id)); return x; };
  const unitOf = (it) => unitOfTop.get(Number(topOf(it)?.id)) ?? 0;
  // A production order holds an item when it or an item above it carries it.
  const inPo = (it) => { if (productionOrderId == null) return true; for (let x = it, h = 0; x && h < 60; h++, x = x.parent_id != null ? byId.get(Number(x.parent_id)) : null) if (Number(x.production_order_id) === Number(productionOrderId)) return true; return false; };
  const started = (it) => (stepsOf.get(Number(it.id)) ?? []).some((s) => s.state === 'done' || s.state === 'in_progress');
  const finished = (it) => { const ss = stepsOf.get(Number(it.id)) ?? []; return ss.length > 0 && ss.every((s) => s._status === 'done' || s.state === 'done'); };

  const rowIds = new Set(rows.map((r) => r.id));
  const cutOwner = new Map();
  for (const r of rows) for (const cp of r.cutPlateIds ?? []) cutOwner.set(Number(cp), r.id);
  const byRow = new Map();      // rowId → [items]
  const cutsOf = new Map();     // rowId → [cut items]
  for (const it of items) {
    const rid = Number(it.item_id);
    if (rowIds.has(rid)) { if (!byRow.has(rid)) byRow.set(rid, []); byRow.get(rid).push(it); continue; }
    // A cut piece node: owned by the row of the item above it (or the row whose cut plate it is).
    const parent = it.parent_id != null ? byId.get(Number(it.parent_id)) : null;
    const owner = cutOwner.get(rid) ?? (parent && rowIds.has(Number(parent.item_id)) ? Number(parent.item_id) : null);
    if (owner != null) { if (!cutsOf.has(owner)) cutsOf.set(owner, []); cutsOf.get(owner).push(it); }
  }

  const ops = new Map();
  for (const s of data.steps ?? []) if (!ops.has(s.op_code)) ops.set(s.op_code, { code: s.op_code, name: s.op_name, seq: Number(s.sequence) });
  const out = rows.map((r) => {
    const units = shell('waiting');
    const its = byRow.get(r.id) ?? [];
    for (let u = 0; u < qty; u++) {
      const mine = its.filter((it) => unitOf(it) === u);
      const st = units[u];
      st.inOrder = mine.some(inPo) || (!mine.length && productionOrderId == null);
      st.pieces = mine.reduce((a, it) => a + (Number(it.quantity) || 1), 0);
      st.done = mine.filter(finished).reduce((a, it) => a + (Number(it.quantity) || 1), 0);
      const cuts = (cutsOf.get(r.id) ?? []).filter((it) => unitOf(it) === u);
      if (cuts.length) {
        const cutDone = (it) => { const first = (stepsOf.get(Number(it.id)) ?? [])[0]; return !first || first.state === 'done'; };
        st.cut = { done: cuts.filter(cutDone).reduce((a, it) => a + (Number(it.quantity) || 1), 0), total: cuts.reduce((a, it) => a + (Number(it.quantity) || 1), 0) };
      }
      // 2026-11-14 (user: "which part is in which step right now"): the operation being worked now, and else the
      // last one done — over the row's own pieces and, before any of them has a step done, its cut pieces.
      const stepsHere = mine.flatMap((it) => stepsOf.get(Number(it.id)) ?? []);
      const cutSteps = cuts.flatMap((it) => stepsOf.get(Number(it.id)) ?? []);
      const latest = (ss, pred) => ss.filter(pred).sort((a, b) => Number(b.sequence) - Number(a.sequence)
        || String(b.finished_at ?? b.started_at ?? '').localeCompare(String(a.finished_at ?? a.started_at ?? '')))[0] ?? null;
      const working = latest(stepsHere, (s) => s.state === 'in_progress') ?? latest(cutSteps, (s) => s.state === 'in_progress');
      const lastDone = latest(stepsHere, (s) => s.state === 'done') ?? latest(cutSteps, (s) => s.state === 'done');
      st.now = working ? { code: working.op_code, name: working.op_name } : null;
      st.last = lastDone ? { code: lastDone.op_code, name: lastDone.op_name } : null;
      if (!mine.length) { st.state = 'waiting'; continue; }
      const joined = mine.every((it) => { const p = it.parent_id != null ? byId.get(Number(it.parent_id)) : null; return p && rowIds.has(Number(p.item_id)) && started(p); });
      if (joined) { st.state = 'joined'; continue; }
      if (mine.every(finished)) { st.state = 'done'; continue; }
      const open = mine.flatMap((it) => (stepsOf.get(Number(it.id)) ?? []).filter((s) => s.state !== 'done'));
      open.sort((a, b) => Number(a.sequence) - Number(b.sequence));
      const first = open[0];
      if (!first) { st.state = 'waiting'; continue; }
      const anyStarted = mine.some(started);
      st.state = anyStarted ? 'working' : 'waiting';
      st.op = { code: first.op_code, name: first.op_name };
      st.inProgress = open.some((s) => s.op_code === first.op_code && s.state === 'in_progress');
    }
    return { ...rowHead(r), units };
  });
  return { ...head, released: true, productionOrderId: productionOrderId != null ? Number(productionOrderId) : null, operations: [...ops.values()].sort((a, b) => a.seq - b.seq), rows: out };
}

const rowHead = (r) => ({ rowId: r.id, parentRowId: r.parentId ?? null, mark: r.mark ?? null, markNorm: r.markNorm ?? null, depth: r.depth, level: r.level, name: r.name });

/** The released lines of a production order (cf_production_orders.lines_json, else its own line). */
export async function productionOrderLines(db, companyId, productionOrderId) {
  const [[po]] = await db.query('SELECT id, order_id, order_line_id, lines_json, code FROM cf_production_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(productionOrderId)]);
  if (!po) throw notFound('Production order');
  let lines = [];
  try { lines = (typeof po.lines_json === 'string' ? JSON.parse(po.lines_json) : po.lines_json) ?? []; } catch { lines = []; }
  if (!lines.length && po.order_line_id) lines = [po.order_line_id];
  return { id: Number(po.id), code: po.code, orderId: Number(po.order_id), lineIds: lines.map(Number) };
}
