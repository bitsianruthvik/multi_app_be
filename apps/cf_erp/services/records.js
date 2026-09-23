/**
 * records.js — loading a master record with its detail row. Low level on
 * purpose: resolution, values, rules and the code generator all need a record,
 * and none of them should have to import the service that creates records.
 *
 * A temporary item also carries its owner order's number and status, because
 * one rule depends on it everywhere: an order that is closed, lost or cancelled
 * is FROZEN (decided 2026-09-22) — its items' values, rules and status no
 * longer change, not by a person and not by a setup change recalculating them.
 * A line released to production freezes its items the same way: the tracker
 * is the release snapshot, and change after release is a later phase.
 */
import { notFound, invalid } from '../lib/errors.js';

/** Order statuses in which nothing on the order changes. A lost order can be reopened, which unfreezes it. */
export const LOCKED_ORDER_STATUSES = new Set(['closed', 'lost', 'cancelled']);

export async function loadMaster(db, companyId, id) {
  if (id == null) return null;
  const [[row]] = await db.query(
    `SELECT m.*,
            i.item_type, i.tracked_by, i.uom, i.sourcing, i.source_definition_id, i.owner_order_line_id,
            d.definition_type, d.selection_mode, d.candidate_classification_id,
            so.id AS owner_order_id, so.code AS owner_order_code, so.status AS owner_order_status,
            ol.line_no AS owner_line_no, rel.id AS owner_release_id
       FROM cf_master_records m
       LEFT JOIN cf_item_details i       ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
       LEFT JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
       LEFT JOIN cf_sales_orders so      ON so.id = ol.order_id
       LEFT JOIN cf_production_releases rel ON rel.order_line_id = ol.id AND rel.deleted_at IS NULL
      WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL`,
    [companyId, id],
  );
  return row || null;
}

export async function requireMaster(db, companyId, id, what = 'Record') {
  const row = await loadMaster(db, companyId, id);
  if (!row) throw notFound(what);
  return row;
}

/** catalog | temporary | template | selection — the one word for what a record is. */
export const kindOf = (m) => (m.record_kind === 'item' ? m.item_type : m.definition_type);

export const isItem = (m) => m.record_kind === 'item';
export const isTemplate = (m) => m.record_kind === 'definition' && m.definition_type === 'template';
export const isSelection = (m) => m.record_kind === 'definition' && m.definition_type === 'selection';

/**
 * What freezes this record, or null: its order is closed, lost or cancelled
 * (reason 'closed'), or its line was released to production ('released').
 * Only temporary items belong to orders.
 */
export function frozenBy(m) {
  if (!m || m.record_kind !== 'item' || m.item_type !== 'temporary') return null;
  const base = { orderId: m.owner_order_id, orderCode: m.owner_order_code, orderStatus: m.owner_order_status, lineNo: m.owner_line_no ?? null };
  if (LOCKED_ORDER_STATUSES.has(m.owner_order_status)) return { ...base, reason: 'closed' };
  if (m.owner_release_id) return { ...base, reason: 'released', releaseId: m.owner_release_id };
  return null;
}

/** Refuses a change to a record of a closed order or a released line. `what` names the change: "values", "rules" … */
export function assertNotFrozen(m, what) {
  const f = frozenBy(m);
  if (f?.reason === 'released') {
    throw invalid('RELEASED', `${m.code ?? m.name} was released to production with line ${f.lineNo} of ${f.orderCode} — its ${what} can no longer change. (Changing a released structure comes later; until then, take the release back while nothing has started.)`);
  }
  if (f) {
    throw invalid('ORDER_CLOSED', `${m.code ?? m.name} belongs to order ${f.orderCode}, which is ${f.orderStatus} — its ${what} can no longer change.`);
  }
}

/** A machine row, with nothing joined — resolution and values need only this. */
export async function loadMachine(db, companyId, id) {
  if (id == null) return null;
  const [[row]] = await db.query('SELECT * FROM cf_machines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  return row || null;
}

export async function requireMachine(db, companyId, id) {
  const row = await loadMachine(db, companyId, id);
  if (!row) throw notFound('Machine');
  return row;
}
