/**
 * planCheckService.js — is this work in the plan? (2026-10-17)
 *
 * User: "when starting work on the floor for a step whose unit has no plan entry, show 'This work
 * is not in the plan' with the order / line, and still allow the start. Record it, so the
 * dashboard can count started unplanned. Do not change the queue order." WARN ONLY — nothing here
 * ever refuses a start.
 *
 * The plan's units (cf_plan_entries.unit_key): p<piece>, p<piece>#<n> (planner v2: the n-th of a
 * row of N), l<line>, and g<parent piece>.<bom line> (an old lot card: no longer made, but live
 * entries still exist, so it is still read). A step is PLANNED when the unit holding its piece has
 * a ship date: the piece itself, its lot, up the locked-piece tree, then the whole line
 * (shipDateResolver, the floor queue's own walk).
 *
 * The queue's sort reads keys p / g / l only; for the plan CHECK a p<piece>#<n> entry counts for
 * its piece too (plannedEntries), so a row planned copy by copy is never reported as unplanned.
 *
 * COST: 2 round trips, 4 queries, whatever the number of steps (steps; then items, pieces and
 * entries of their lines together). The flag write (flagUnplanned) is 1–2 more statements, only
 * when something was unplanned.
 */
import { invalid } from '../lib/errors.js';

export const UNPLANNED_TEXT = 'This work is not in the plan.';

/**
 * Where the planner ships the unit that holds each production item
 * (cf_plan_entries, keys p<piece> | g<parent piece>.<bom line> | l<line>).
 * The nearest planned unit wins: the piece itself, its lot, then up the
 * locked-piece tree, then the whole line. A grouped tracker node (no locked
 * piece of its own) is looked up through its parent's piece and its BOM row.
 */
export function shipDateResolver(items, pieces, entries) {
  const pieceById = new Map(pieces.map((p) => [p.id, p]));
  const itemById = new Map(items.map((x) => [x.id, x]));
  const entry = new Map(entries.map((e) => [e.unit_key, e.ship_date]));
  const memo = new Map();
  const fromPiece = (pid) => {
    if (memo.has(pid)) return memo.get(pid);
    const p = pieceById.get(pid);
    let d = null;
    if (p) {
      d = entry.get(`p${p.id}`) ?? (p.parent_id != null && p.bom_line_id != null ? entry.get(`g${p.parent_id}.${p.bom_line_id}`) : null) ?? null;
      if (d == null && p.parent_id != null) d = fromPiece(p.parent_id);
    }
    memo.set(pid, d);
    return d;
  };
  const pieceOfItem = (it) => {
    for (let x = it, hop = 0; x && hop < 50; x = itemById.get(x.parent_id), hop++) if (x.order_piece_id) return x.order_piece_id;
    return null;
  };
  const sortOf = (it) => {
    const pid = it.order_piece_id ?? pieceOfItem(it);
    return pid && pieceById.has(pid) ? pieceById.get(pid).sort_order : null;
  };
  return {
    shipDate(it, lineId) {
      let d = null;
      if (it.order_piece_id) d = fromPiece(it.order_piece_id);
      else {
        const parent = itemById.get(it.parent_id);
        const parentPiece = parent ? pieceOfItem(parent) : null;
        if (parentPiece && it.bom_line_id != null) d = entry.get(`g${parentPiece}.${it.bom_line_id}`) ?? null;
        if (d == null && parentPiece) d = fromPiece(parentPiece);
      }
      return d ?? entry.get(`l${lineId}`) ?? null;
    },
    sortOf,
  };
}

/** The entries for the plan CHECK: a p<piece>#<n> entry also stands for p<piece> (its earliest date). */
export function plannedEntries(entries) {
  const out = new Map();
  for (const e of entries) {
    const m = /^p([1-9]\d*)#[1-9]\d*$/.exec(String(e.unit_key));
    const key = m ? `p${m[1]}` : e.unit_key;
    const prev = out.get(key);
    if (prev == null || (e.ship_date != null && String(e.ship_date) < String(prev))) out.set(key, e.ship_date);
  }
  return [...out].map(([unit_key, ship_date]) => ({ unit_key, ship_date }));
}

const idsOf = (raw) => {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const ids = [...new Set(list.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
  return ids.slice(0, 500);
};

/**
 * The steps among `stepIds` whose unit the plan has no ship date for:
 * Map stepId -> { stepId, orderId, orderCode, lineId, lineNo, pieceCode, operation }.
 */
export async function unplannedOf(db, companyId, stepIds) {
  const out = new Map();
  const ids = idsOf(stepIds);
  if (!ids.length) return out;
  const [steps] = await db.query(
    `SELECT s.id, s.production_item_id, pi.release_id, pi.code AS piece_code, r.order_line_id, r.order_id,
            o.code AS order_code, l.line_no, op.name AS op_name, s.step_name
       FROM cf_production_steps s
       JOIN cf_production_items pi ON pi.id = s.production_item_id
       JOIN cf_production_releases r ON r.id = pi.release_id
       JOIN cf_sales_orders o ON o.id = r.order_id
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id
       JOIN cf_operations op ON op.id = s.operation_id
      WHERE s.company_id = ? AND s.id IN (?)`,
    [companyId, ids],
  );
  if (!steps.length) return out;
  const releaseIds = [...new Set(steps.map((s) => s.release_id))];
  const lineIds = [...new Set(steps.map((s) => s.order_line_id))];
  const [[items], [pieces], [entries]] = await Promise.all([
    db.query('SELECT id, parent_id, order_piece_id, bom_line_id FROM cf_production_items WHERE company_id = ? AND release_id IN (?) AND deleted_at IS NULL', [companyId, releaseIds]),
    db.query('SELECT id, parent_id, bom_line_id, sort_order FROM cf_order_pieces WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [companyId, lineIds]),
    db.query('SELECT unit_key, ship_date FROM cf_plan_entries WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL AND ship_date IS NOT NULL', [companyId, lineIds]),
  ]);
  const resolver = shipDateResolver(items, pieces, plannedEntries(entries));
  const itemById = new Map(items.map((x) => [x.id, x]));
  for (const s of steps) {
    const it = itemById.get(s.production_item_id) ?? { id: s.production_item_id, parent_id: null, order_piece_id: null, bom_line_id: null };
    if (resolver.shipDate(it, s.order_line_id) != null) continue;
    out.set(s.id, {
      stepId: s.id, orderId: s.order_id, orderCode: s.order_code, lineId: s.order_line_id, lineNo: s.line_no,
      pieceCode: s.piece_code ?? null, operation: s.step_name || s.op_name,
    });
  }
  return out;
}

/** GET /floor/plan-check?stepIds=1,2 (and /tracker/plan-check) — { unplanned: [...], message } . Warn only. */
export async function planCheck(db, companyId, q = {}) {
  const ids = idsOf(q.stepIds);
  if (!ids.length) throw invalid('INVALID', 'stepIds is a list of step ids.');
  const un = await unplannedOf(db, companyId, ids);
  return { checked: ids.length, unplanned: [...un.values()], message: un.size ? UNPLANNED_TEXT : null };
}

/**
 * Marks the start as unplanned (init.sql §70): the sessions by id, the start events by session or,
 * for a start without a session (the tracker's), the step's latest start event. A database
 * without §70 has no column: the start stands, nothing is flagged, and the answer says so.
 */
export async function flagUnplanned(db, companyId, { sessionIds = [], stepIds = [] } = {}) {
  try {
    if (sessionIds.length) {
      await db.query('UPDATE cf_work_sessions SET unplanned = 1 WHERE company_id = ? AND id IN (?)', [companyId, sessionIds]);
      await db.query("UPDATE cf_step_events SET unplanned = 1 WHERE company_id = ? AND event = 'start' AND session_id IN (?)", [companyId, sessionIds]);
    }
    for (const stepId of stepIds) {
      await db.query("UPDATE cf_step_events SET unplanned = 1 WHERE company_id = ? AND step_id = ? AND event = 'start' ORDER BY id DESC LIMIT 1", [companyId, stepId]);
    }
    return true;
  } catch (e) {
    if (e?.errno === 1054) return false;
    throw e;
  }
}
