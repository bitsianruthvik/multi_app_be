/**
 * monthFitService.js — what the plant can put out THIS MONTH.
 *
 * The Board answers "when does each operation run". This answers the question
 * that comes before it: of everything open, how much fits in what is left of
 * the month, and which station decides that.
 *
 * It is a rough-cut, on purpose. Work is poured into ONE bucket — the rest of
 * the month — per station, with no sequencing inside it. That is wrong in the
 * small and right in the large, and the large is what is being decided here:
 * which orders, which pieces of them, and whether another machine or another
 * shift would move the number.
 *
 * So this file only MEASURES. It returns two things and decides nothing:
 *   - capacity: working minutes each station has between now and month end,
 *     from the same calendars/crews the leveller uses (capacityService);
 *   - demand: every open task, rolled onto its BOM node, grouped by the
 *     production order that claims it — cutting and fabrication separately,
 *     because they are separate documents with separate stations.
 * The fit itself runs in the browser, so trying "one more SAW machine" is
 * instant and never touches the server.
 *
 * The one thing it WRITES is the planner's own marks — "this piece this month",
 * "this piece later" — in fab_month_marks. Everything unmarked is the engine's
 * to place.
 */

import { pool } from '../../../db.js';
import { PlanError, plannerTimezone } from './planService.js';
import { zonedYMD, zonedWallClockToUtc } from './plantTime.js';
import { resolveCapacityForResource, capacityMinutes, isUnbounded } from './capacityService.js';
import { shiftWorld } from './shiftCache.js';
import { taskMinutes } from './taskDuration.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MARK_STATES = new Set(['in', 'out']);
const NODE_KEY_RE = /^(po|l\d+|i\d+)$/;

/** First day of the month after `month` ('YYYY-MM'), as YYYY-MM-DD. */
function nextMonthStart(month) {
  const [y, m] = month.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m, 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * The window being filled: from NOW (or the month's start, if it has not begun)
 * to the end of the month, in the plant's zone. The days already gone are not
 * capacity, and pretending they are is how a plan looks fine on the 25th.
 */
async function monthWindow(companyId, month, now) {
  const tz = await plannerTimezone(companyId);
  const wanted = month || zonedYMD(now, tz).slice(0, 7);
  if (!MONTH_RE.test(wanted)) throw new PlanError('BAD_MONTH', 'month must be YYYY-MM.');
  const start = zonedWallClockToUtc(`${wanted}-01`, '00:00:00', tz);
  const end = zonedWallClockToUtc(nextMonthStart(wanted), '00:00:00', tz);
  if (end.getTime() <= now.getTime()) throw new PlanError('MONTH_OVER', 'That month has already ended.');
  const from = start.getTime() > now.getTime() ? start : now;
  return { tz, month: wanted, from, to: end, monthStart: start };
}

/** Working minutes per station between `from` and `to`. */
async function loadStations(companyId, from, to) {
  const [types] = await pool.query(
    `SELECT rt.id, rt.name, rt.num_units AS numUnits, rt.plant_id AS plantId
       FROM fab_resource_types rt
      WHERE rt.company_id = ? AND rt.deleted_at IS NULL
      ORDER BY rt.name ASC`,
    [companyId],
  );
  if (types.length === 0) return [];

  const [resources] = await pool.query(
    `SELECT r.id, r.resource_type_id AS typeId, r.plant_id AS plantId, ev.state AS machineState
       FROM fab_resources r
       LEFT JOIN (
         SELECT resource_id, state,
                ROW_NUMBER() OVER (PARTITION BY resource_id ORDER BY at DESC, id DESC) AS rn
           FROM fab_resource_events
          WHERE company_id = ? AND deleted_at IS NULL AND superseded_by_event_id IS NULL
       ) ev ON ev.resource_id = r.id AND ev.rn = 1
      WHERE r.company_id = ? AND r.deleted_at IS NULL`,
    [companyId, companyId],
  );
  const byType = new Map(types.map((t) => [Number(t.id), []]));
  for (const r of resources) byType.get(Number(r.typeId))?.push(r);

  const world = await shiftWorld(companyId);
  const out = [];
  for (const t of types) {
    const machines = byType.get(Number(t.id)) ?? [];
    let capacityMin = 0;
    let unbounded = false;
    let shifts = 0;
    let down = 0;

    /**
     * A type with no machine rows still has `num_units` — the leveller plans
     * against that number, so this must too, or a station configured only by
     * count reads as "no capacity at all".
     */
    const seats = machines.length > 0
      ? machines.map((m) => ({ id: m.id, plantId: m.plantId ?? t.plantId, down: m.machineState === 'down' }))
      : Array.from({ length: Number(t.numUnits) || 0 }, () => ({ id: null, plantId: t.plantId, down: false }));

    for (const seat of seats) {
      if (seat.down) { down += 1; continue; }
      const cap = await resolveCapacityForResource(companyId, seat.id, seat.plantId);
      if (isUnbounded(cap)) { unbounded = true; continue; }
      capacityMin += await capacityMinutes(companyId, cap, from, to);
      for (const calId of cap.calendarIds ?? []) {
        shifts = Math.max(shifts, (world.shiftsByCalendar[calId] ?? []).length);
      }
    }
    out.push({
      id: Number(t.id),
      name: t.name,
      machines: seats.length,
      machinesDown: down,
      // Crew mode has no calendar to count shifts from; 1 keeps the what-if
      // multiplier meaningful ("twice the crewed time") without inventing a number.
      shifts: Math.max(shifts, 1),
      capacityMin: Math.round(capacityMin),
      unbounded,
    });
  }
  return out;
}

/**
 * Every open task, as minutes on a BOM node at a station, grouped by the
 * production order that claims it.
 */
async function loadDemand(companyId, now) {
  const [tasks] = await pool.query(
    `SELECT t.id, t.order_id AS orderId, t.production_order_id AS poId, t.item_id AS itemId,
            t.resource_type_id AS typeId, t.status, t.computed_hours, t.setup_hours, t.task_qty, t.started_at
       FROM fab_project_tasks t
       JOIN fab_orders o ON o.id = t.order_id AND o.company_id = t.company_id AND o.deleted_at IS NULL
      WHERE t.company_id = ? AND t.deleted_at IS NULL
        AND t.status NOT IN ('cancelled', 'done')
        AND o.status NOT IN ('cancelled', 'completed', 'closed')`,
    [companyId],
  );
  if (tasks.length === 0) return { orders: [] };

  const salesIds = [...new Set(tasks.map((t) => Number(t.orderId)))];
  const poIds = [...new Set(tasks.map((t) => t.poId).filter((v) => v != null).map(Number))];

  // DATE columns are formatted in SQL: a DATE through a JS Date picks up the
  // server's zone and can come back as the day before.
  const [orderRows] = await pool.query(
    `SELECT o.id, o.order_number AS orderNumber, o.status, o.customer_name AS customerName,
            o.mo_purpose AS purpose, o.priority_rank AS priorityRank,
            DATE_FORMAT(o.required_date, '%Y-%m-%d') AS requiredDate,
            DATE_FORMAT(o.must_finish_by, '%Y-%m-%d') AS mustFinishBy
       FROM fab_orders o
      WHERE o.company_id = ? AND o.id IN (?)`,
    [companyId, [...salesIds, ...poIds]],
  );
  const orderById = new Map(orderRows.map((o) => [Number(o.id), o]));

  const [items] = await pool.query(
    `SELECT i.id, i.parent_item_id AS parentId, i.order_id AS orderId, i.order_line_id AS lineId,
            i.depth, i.node_kind AS nodeKind, i.code, i.name, i.mark, i.qty, i.total_weight AS totalWeight,
            (bc.material_form = 'blank') AS isBlank
       FROM fab_items i
       LEFT JOIN fab_item_catalog bc ON bc.id = i.catalog_item_id AND bc.company_id = i.company_id
      WHERE i.company_id = ? AND i.order_id IN (?) AND i.deleted_at IS NULL`,
    [companyId, salesIds],
  );
  const itemById = new Map(items.map((i) => [Number(i.id), i]));

  const [lines] = await pool.query(
    `SELECT id, order_id AS orderId, line_no AS lineNo, code, description
       FROM fab_order_lines
      WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL`,
    [companyId, salesIds],
  );
  const lineById = new Map(lines.map((l) => [Number(l.id), l]));

  /**
   * group = one production order's share of one sales order. `0` is work no
   * production order has claimed yet — deployed tasks waiting for their PO.
   */
  const groups = new Map(); // `${salesId}:${poId|0}` -> { nodes: Map }
  const groupOf = (salesId, poId) => {
    const key = `${salesId}:${poId ?? 0}`;
    if (!groups.has(key)) groups.set(key, { salesId, poId: poId ?? 0, nodes: new Map() });
    return groups.get(key);
  };

  const ensureNode = (group, key, make) => {
    if (!group.nodes.has(key)) group.nodes.set(key, { key, own: {}, taskCount: 0, ...make() });
    return group.nodes.get(key);
  };

  /** The item's node, with every ancestor up to its order line in place above it. */
  const nodeForItem = (group, itemId) => {
    let cur = itemById.get(Number(itemId));
    if (!cur) return null;
    const leaf = ensureNode(group, `i${cur.id}`, () => itemNode(cur));
    let guard = 0;
    while (cur && guard < 32) {
      guard += 1;
      const parent = cur.parentId != null ? itemById.get(Number(cur.parentId)) : null;
      if (parent) {
        ensureNode(group, `i${parent.id}`, () => itemNode(parent));
        cur = parent;
        continue;
      }
      const line = cur.lineId != null ? lineById.get(Number(cur.lineId)) : null;
      if (line) {
        ensureNode(group, `l${line.id}`, () => ({
          parentKey: null, kind: 'line', depth: -1, isBlank: false, tonnes: 0, qty: null,
          label: line.code || `Line ${line.lineNo}`,
          sub: line.description || '',
        }));
      }
      break;
    }
    return leaf;
  };

  const itemNode = (i) => {
    const parent = i.parentId != null ? itemById.get(Number(i.parentId)) : null;
    const parentKey = parent ? `i${parent.id}` : (i.lineId != null && lineById.has(Number(i.lineId)) ? `l${i.lineId}` : null);
    return {
      parentKey,
      kind: 'item',
      depth: Number(i.depth) || 0,
      isBlank: !!i.isBlank,
      // Structure rows carry a rolled-up weight; material rows are the stock a
      // part is cut from and would count the same steel twice.
      tonnes: i.nodeKind === 'structure' && i.totalWeight != null ? Number(i.totalWeight) / 1000 : 0,
      qty: i.qty != null ? Number(i.qty) : null,
      label: i.code || i.mark || i.name || `Item ${i.id}`,
      sub: i.code && i.name && i.name !== i.code ? i.name : '',
    };
  };

  for (const t of tasks) {
    const group = groupOf(Number(t.orderId), t.poId != null ? Number(t.poId) : null);
    const node = t.itemId != null ? nodeForItem(group, t.itemId) : null;
    const target = node ?? ensureNode(group, 'i0', () => ({
      parentKey: null, kind: 'loose', depth: 0, isBlank: false, tonnes: 0, qty: null,
      label: 'Work with no BOM row', sub: '',
    }));

    let minutes = taskMinutes(t);
    if (t.status === 'in_progress' && t.started_at) {
      // What is still ahead of the machine, not what was estimated at the start.
      const elapsed = Math.max(0, (now.getTime() - new Date(t.started_at).getTime()) / 60000);
      minutes = Math.max(minutes - elapsed, 15);
    }
    const typeKey = t.typeId != null ? String(t.typeId) : '0';
    target.own[typeKey] = Math.round((target.own[typeKey] ?? 0) + minutes);
    target.taskCount += 1;
  }

  // Line tonnes are the sum of the top rows present under them.
  for (const group of groups.values()) {
    for (const n of group.nodes.values()) {
      if (n.kind !== 'item' || n.isBlank || !n.parentKey?.startsWith('l')) continue;
      const line = group.nodes.get(n.parentKey);
      if (line) line.tonnes += n.tonnes;
    }
  }

  const bySales = new Map();
  for (const group of groups.values()) {
    const so = orderById.get(group.salesId);
    if (!so) continue;
    if (!bySales.has(group.salesId)) {
      bySales.set(group.salesId, {
        id: group.salesId,
        orderNumber: so.orderNumber,
        customerName: so.customerName || '',
        status: so.status,
        priorityRank: so.priorityRank != null ? Number(so.priorityRank) : null,
        // The planner's own deadline wins over the customer's: it is the date
        // the engine is forbidden to pass.
        committed: so.mustFinishBy || so.requiredDate || null,
        committedKind: so.mustFinishBy ? 'must' : 'required',
        pos: [],
      });
    }
    const po = group.poId ? orderById.get(group.poId) : null;
    bySales.get(group.salesId).pos.push({
      id: group.poId,
      orderNumber: po?.orderNumber ?? null,
      status: po?.status ?? null,
      purpose: !group.poId ? 'unreleased' : (po?.purpose === 'cutting' ? 'cutting' : 'fabrication'),
      committed: po?.mustFinishBy || null,
      nodes: [...group.nodes.values()].map((n) => ({ ...n, tonnes: +n.tonnes.toFixed(3) })),
    });
  }

  const purposeOrder = { cutting: 0, fabrication: 1, unreleased: 2 };
  const orders = [...bySales.values()];
  for (const o of orders) o.pos.sort((a, b) => purposeOrder[a.purpose] - purposeOrder[b.purpose]);
  orders.sort((a, b) => String(a.committed ?? '9999').localeCompare(String(b.committed ?? '9999')) || a.id - b.id);
  return { orders };
}

async function loadMarks(companyId, month) {
  const [rows] = await pool.query(
    `SELECT order_id AS orderId, production_order_id AS poId, node_key AS nodeKey, state
       FROM fab_month_marks
      WHERE company_id = ? AND month = ? AND deleted_at IS NULL`,
    [companyId, month],
  );
  return rows.map((r) => ({ orderId: Number(r.orderId), poId: Number(r.poId), nodeKey: r.nodeKey, state: r.state }));
}

export async function monthFit(companyId, { month = null } = {}) {
  const now = new Date();
  const win = await monthWindow(companyId, month, now);
  const [stations, demand, marks] = await Promise.all([
    loadStations(companyId, win.from, win.to),
    loadDemand(companyId, now),
    loadMarks(companyId, win.month),
  ]);
  return {
    month: win.month,
    timezone: win.tz,
    from: win.from.toISOString(),
    to: win.to.toISOString(),
    monthEnd: zonedYMD(new Date(win.to.getTime() - 1000), win.tz),
    today: zonedYMD(now, win.tz),
    stations,
    orders: demand.orders,
    marks,
  };
}

/**
 * Save the planner's marks for a month. `state: null` clears one.
 *
 * Upsert, never delete-then-insert: the unique key has no `deleted_at` in it,
 * so a cleared mark is revived in place the next time the same row is marked.
 */
export async function saveMonthMarks(companyId, { month, marks }, userId = null) {
  if (!MONTH_RE.test(String(month ?? ''))) throw new PlanError('BAD_MONTH', 'month must be YYYY-MM.');
  if (!Array.isArray(marks) || marks.length === 0) return { saved: 0, cleared: 0 };
  if (marks.length > 5000) throw new PlanError('TOO_MANY_MARKS', 'At most 5000 marks per save.');

  const upserts = [];
  const clears = [];
  for (const m of marks) {
    const orderId = Number(m?.orderId);
    const poId = Number(m?.poId ?? 0);
    const nodeKey = String(m?.nodeKey ?? '');
    if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isInteger(poId) || poId < 0 || !NODE_KEY_RE.test(nodeKey)) {
      throw new PlanError('BAD_MARK', 'Each mark needs orderId, poId and a nodeKey of po, l<id> or i<id>.');
    }
    if (m.state == null) clears.push([orderId, poId, nodeKey]);
    else if (MARK_STATES.has(m.state)) upserts.push([companyId, month, orderId, poId, nodeKey, m.state, userId]);
    else throw new PlanError('BAD_MARK', 'state must be in, out or null.');
  }

  // The orders must be this company's — ids come from the client.
  const orderIds = [...new Set(marks.map((m) => Number(m.orderId)))];
  const [owned] = await pool.query(
    'SELECT id FROM fab_orders WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL',
    [companyId, orderIds],
  );
  if (owned.length !== orderIds.length) throw new PlanError('UNKNOWN_ORDER', 'One of those orders does not exist.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < upserts.length; i += 500) {
      await conn.query(
        `INSERT INTO fab_month_marks (company_id, month, order_id, production_order_id, node_key, state, updated_by)
         VALUES ?
         ON DUPLICATE KEY UPDATE state = VALUES(state), updated_by = VALUES(updated_by), deleted_at = NULL`,
        [upserts.slice(i, i + 500)],
      );
    }
    for (const [orderId, poId, nodeKey] of clears) {
      await conn.query(
        `UPDATE fab_month_marks SET deleted_at = NOW(), updated_by = ?
          WHERE company_id = ? AND month = ? AND order_id = ? AND production_order_id = ? AND node_key = ?
            AND deleted_at IS NULL`,
        [userId, companyId, month, orderId, poId, nodeKey],
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { saved: upserts.length, cleared: clears.length };
}
