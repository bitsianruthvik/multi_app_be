/**
 * flowAllocationService.js — stage 3 of a sales order: what gets made how.
 *
 * The insight this is built on: assigning flows is not a per-item job. On a real
 * order every girder segment gets the same assembly flow, and every part gets
 * the same fabrication flow except the drilled ones. So flow follows the LEVEL,
 * with a marker on the code for variants:
 *
 *   (structure type, level, code suffix) -> flow      [fab_flow_rules]
 *
 * A default is a rule with no suffix; `/D` on a code picks the drilled variant.
 * Applying the rules to a 417-item order is one action.
 *
 * NO FLOW MEANS NOTHING TO DO. Spans and girders are groupings and carry no
 * flow at all, which is a valid end state — so nothing here treats a flow-less
 * item as an error, and applying rules never invents one for a level with no
 * rule.
 *
 * APPLYING NEVER OVERWRITES A CHOICE SOMEONE MADE. Only items with no flow are
 * touched, unless the caller explicitly asks to re-apply — otherwise re-running
 * after a BOQ re-upload would silently undo every exception.
 */

import { pool } from '../../../db.js';
import { codeSuffix } from './itemCodeService.js';

/** The levels that can carry work. Order matters — it is the shop's order. */
export const FLOW_LEVELS = ['part', 'segment', 'girder', 'span'];

/**
 * Pick the rule that best fits an item. More specific wins:
 *   1. exact structure type + matching suffix
 *   2. exact structure type, no suffix (the type's default)
 *   3. any type + matching suffix
 *   4. any type, no suffix (the global default)
 * A suffix rule never applies to an item whose code does not carry it.
 */
export function pickRule(rules, { levelKind, lineType, suffix }) {
  const candidates = rules.filter((r) => r.level_kind === levelKind
    && (r.line_type == null || r.line_type === lineType)
    && (r.code_suffix == null || r.code_suffix === suffix));
  if (!candidates.length) return null;

  const score = (r) => (r.line_type != null ? 2 : 0) + (r.code_suffix != null ? 1 : 0);
  return candidates.reduce((best, r) => (score(r) > score(best) ? r : best), candidates[0]);
}

/** Every active rule for a company, newest-priority resolved at pick time. */
export async function loadRules(companyId, conn) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT r.id, r.line_type, r.level_kind, r.code_suffix, r.flow_id, f.name AS flow_name
       FROM fab_flow_rules r
       JOIN fab_operation_flows f ON f.id = r.flow_id AND f.deleted_at IS NULL
      WHERE r.company_id = ? AND r.active = 1 AND r.deleted_at IS NULL
      -- id last so two rules of equal specificity resolve the same way every
      -- time (the older wins). The screen warns about such a pair rather than
      -- leaving anyone to discover it from a wrong flow on the shop floor.
      ORDER BY r.level_kind, r.line_type, r.code_suffix, r.id`,
    [companyId],
  );
  return rows;
}

/**
 * What the order looks like right now, per level: how many items, how many
 * already have a flow, and what applying the rules would do.
 *
 * Reported, never warned about — an item with no flow is an item with nothing
 * to do, and on a normal order that describes every span and girder.
 */
export async function flowSummary(companyId, orderId) {
  const [[order]] = await pool.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

  const rules = await loadRules(companyId);
  const lineType = await orderLineType(companyId, orderId);
  const items = await loadItems(companyId, orderId);

  const byLevel = new Map();
  for (const lv of FLOW_LEVELS) byLevel.set(lv, { level: lv, items: 0, withFlow: 0, wouldAssign: 0, flows: new Map() });

  for (const it of items) {
    const lv = it.level_kind;
    if (!byLevel.has(lv)) continue;
    /*
     * A BOUGHT part is not counted at all, not counted as unassigned.
     *
     * `applyFlowRules` skips it — a stud is not fabricated — so counting it here
     * reports work that will never be done and can never be cleared: the stage
     * says "2 items match a rule, press Apply", Apply correctly does nothing,
     * and the order is stuck one step short of confirmable forever.
     *
     * The rule and the count that reports on it have to agree.
     */
    if ((it.procurement_type || 'make') !== 'make') continue;
    const bucket = byLevel.get(lv);
    bucket.items++;
    if (it.flow_id) {
      bucket.withFlow++;
      const n = it.flow_name ?? `#${it.flow_id}`;
      bucket.flows.set(n, (bucket.flows.get(n) ?? 0) + 1);
    } else if (pickRule(rules, { levelKind: lv, lineType, suffix: codeSuffix(it.code) })) {
      bucket.wouldAssign++;
    }
  }

  return {
    lineType,
    rules: rules.map((r) => ({
      id: r.id, lineType: r.line_type, level: r.level_kind,
      suffix: r.code_suffix, flowId: r.flow_id, flowName: r.flow_name,
    })),
    levels: [...byLevel.values()].map((b) => ({
      ...b,
      flows: [...b.flows.entries()].map(([name, count]) => ({ name, count })),
    })),
    wouldAssign: [...byLevel.values()].reduce((n, b) => n + b.wouldAssign, 0),
  };
}

/**
 * Apply the rules to one order.
 *
 * @param {boolean} [reassign=false] also overwrite items that already have a
 *        flow. Off by default: re-running after a BOQ re-upload must not undo
 *        every exception someone set by hand.
 */
export async function applyFlowRules(companyId, orderId, { reassign = false } = {}) {
  const [[order]] = await pool.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

  const rules = await loadRules(companyId);
  if (!rules.length) {
    return { assigned: 0, unchanged: 0, noRule: 0, byFlow: [], message: 'No flow rules are set up yet.' };
  }

  const lineType = await orderLineType(companyId, orderId);
  const items = await loadItems(companyId, orderId);

  let assigned = 0, unchanged = 0, noRule = 0;
  const byFlow = new Map();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const it of items) {
      if (!FLOW_LEVELS.includes(it.level_kind)) continue;
      /*
       * A BOUGHT part is not fabricated, so no fabrication flow belongs on it.
       * The rules match on level and code suffix, which a shear stud satisfies
       * as readily as a web plate — and it came out routed through Part
       * Fabrication, then asked for the plate thickness and weld length of a
       * thing that arrives in a box. Procurement is where a bought part is
       * answered for.
       */
      if ((it.procurement_type || 'make') !== 'make') { noRule++; continue; }
      if (it.flow_id && !reassign) { unchanged++; continue; }

      const rule = pickRule(rules, {
        levelKind: it.level_kind, lineType, suffix: codeSuffix(it.code),
      });
      // No rule for this level is not a failure — it means nothing to do here.
      if (!rule) { noRule++; continue; }
      if (it.flow_id === rule.flow_id) { unchanged++; continue; }

      await conn.query(
        'UPDATE fab_items SET flow_id = ?, flow_source = ? WHERE id = ? AND company_id = ?',
        [rule.flow_id, 'rule', it.id, companyId],
      );
      assigned++;
      byFlow.set(rule.flow_name, (byFlow.get(rule.flow_name) ?? 0) + 1);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return {
    assigned, unchanged, noRule,
    byFlow: [...byFlow.entries()].map(([flow, count]) => ({ flow, count })),
  };
}

/**
 * Set one item's flow by hand — the exception path.
 *
 * Returns the item's order so the caller can refresh that order's readiness;
 * the route is keyed on the item, and making the caller re-derive which order
 * it belongs to would be asking it to know the item's shape.
 */
export async function setItemFlow(companyId, itemId, flowId) {
  const [res] = await pool.query(
    `UPDATE fab_items SET flow_id = ?, flow_source = ?
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [flowId ?? null, flowId ? 'manual' : null, itemId, companyId],
  );
  if (!res.affectedRows) { const e = new Error('Item not found'); e.status = 404; throw e; }
  const [[row]] = await pool.query(
    'SELECT order_id FROM fab_items WHERE id = ? AND company_id = ?', [itemId, companyId],
  );
  return { ok: true, orderId: row?.order_id ?? null };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * The order's structure type, from its lines. Mixed-type orders fall back to
 * "any" rather than picking one arbitrarily — a rule that fired on the wrong
 * half of an order is worse than one that did not fire.
 */
async function orderLineType(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT line_type FROM fab_order_lines
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND line_type IS NOT NULL`,
    [companyId, orderId],
  );
  return rows.length === 1 ? rows[0].line_type : null;
}

async function loadItems(companyId, orderId) {
  const [rows] = await pool.query(
    `SELECT fi.id, fi.code, fi.level_kind, fi.flow_id, fi.procurement_type, f.name AS flow_name
       FROM fab_items fi
       LEFT JOIN fab_operation_flows f ON f.id = fi.flow_id AND f.deleted_at IS NULL
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
        AND fi.level_kind IS NOT NULL
      ORDER BY fi.id`,
    [companyId, orderId],
  );
  return rows;
}
