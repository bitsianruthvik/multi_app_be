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
 * is the release snapshot, and change after release is a later phase. And
 * since 2026-09-26 so does a LOCKED line: lock rolls the structure out into
 * pieces with their codes, and a change after that is a new revision — whose
 * predecessor is then REVISED (2026-09-27), and frozen like a closed order.
 */
import { notFound, invalid } from '../lib/errors.js';

/**
 * Order statuses in which nothing on the order changes. A lost order can be
 * reopened, which unfreezes it. A REVISED one (init.sql §27) was replaced by a
 * later revision of the same order and is kept exactly as it was — frozen like
 * a closed one, everywhere a closed one is.
 */
export const LOCKED_ORDER_STATUSES = new Set(['closed', 'lost', 'cancelled', 'revised']);

/**
 * The one sentence for an order a later revision replaced (user, 2026-09-27:
 * "If it changes, the whole sales order basically changes so it should be a new
 * one anyways"). Every refusal on a revised order says this rather than "is
 * revised", and names the revision to change instead — the latest one.
 */
export const revisedOrderMessage = (orderCode, revision, latestRevision = null) => {
  const rev = Number(revision) || 1;
  const latest = Number(latestRevision) || rev + 1;
  return `${orderCode ?? 'This order'} rev ${rev} was revised — it is kept as it was; change rev ${latest} instead.`;
};

/**
 * SQL for the latest revision of the order `alias` names: the highest revision
 * among the live rows sharing its number. For the sentence above, read with the
 * order in the same query — an index lookup on uq_csor_code_revision.
 */
export const latestRevisionSql = (alias) =>
  `(SELECT MAX(lr.revision) FROM cf_sales_orders lr WHERE lr.company_id = ${alias}.company_id AND lr.code_active = ${alias}.code_active)`;

// The latest revision is only looked up for a revised owner order: this select
// loads thousands of records at a time, and only a refusal needs the number.
const MASTER_SELECT = `SELECT m.*,
            i.item_type, i.tracked_by, i.uom, i.sourcing, i.source_definition_id, i.owner_order_line_id,
            i.list_price, i.price_basis, i.currency AS price_currency,
            COALESCE(i.hsn_code, d.hsn_code) AS hsn_code, COALESCE(i.gst_rate, d.gst_rate) AS gst_rate, COALESCE(i.is_service, d.is_service, 0) AS is_service,
            d.definition_type, d.selection_mode, d.candidate_classification_id,
            so.id AS owner_order_id, so.code AS owner_order_code, so.status AS owner_order_status,
            so.revision AS owner_order_revision,
            IF(so.status = 'revised', ${latestRevisionSql('so')}, NULL) AS owner_order_latest_revision,
            ol.line_no AS owner_line_no, ol.locked_at AS owner_line_locked_at, rel.id AS owner_release_id
       FROM cf_master_records m
       LEFT JOIN cf_item_details i       ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
       LEFT JOIN cf_sales_order_lines ol ON ol.id = i.owner_order_line_id
       LEFT JOIN cf_sales_orders so      ON so.id = ol.order_id
       LEFT JOIN cf_production_releases rel ON rel.order_line_id = ol.id AND rel.deleted_at IS NULL`;

export async function loadMaster(db, companyId, id) {
  if (id == null) return null;
  const [[row]] = await db.query(`${MASTER_SELECT} WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL`, [companyId, id]);
  return row || null;
}

/**
 * loadMaster for many ids in ONE query — the same row shape, keyed by id. For
 * code that would otherwise load record after record: every one is ~49 ms on
 * production. A missing or deleted id is simply absent from the map.
 */
export async function loadMasters(db, companyId, ids) {
  const want = [...new Set(ids.filter((id) => id != null).map(Number))];
  if (!want.length) return new Map();
  const [rows] = await db.query(`${MASTER_SELECT} WHERE m.company_id = ? AND m.id IN (?) AND m.deleted_at IS NULL`, [companyId, want]);
  return new Map(rows.map((r) => [r.id, r]));
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
 * The one sentence for a LOCKED line (user, 2026-09-26: "once entered and
 * locked I don't see a reason for it to change. If it changes, the whole sales
 * order changes, so it should be a new one"). Every refusal on a locked line
 * says this, whichever service refuses.
 */
export const lockedLineMessage = (lineNo, orderCode) =>
  `Line ${lineNo ?? '?'} of ${orderCode ?? 'its order'} is locked — its structure, values and cut pieces no longer change. A change means a new revision of the order.`;

/**
 * HOW A THING IS MADE stays open on a locked line until the line is released
 * (user, 2026-09-30). Lock fixes WHAT is made — structure, codes, quantities,
 * values, cut pieces — but flows are release's business (rollOutService does
 * not read them; release refuses a made thing with no flow). A locked line
 * whose cut plates had no flow could otherwise never be released at all. So a
 * temporary item's default_flow_id and a BOM line's operation_flow_id still
 * change while the line is locked, and ONLY those. Released, or on a closed or
 * revised order: frozen like everything else.
 */
export const flowStillOpen = (frozen) => frozen?.reason === 'locked';

/**
 * Values that are material planning, not design. Nesting comes AFTER lock, and
 * holding a rectangle back from the packer (NEST_MANUAL on a cut plate) is part
 * of nesting — so a locked line's items still take these, and only these. A
 * released or closed line takes none.
 */
export const AFTER_LOCK_SPECS = new Set(['NEST_MANUAL']);

/**
 * Values a FROZEN record still works out from its chain, as if it were live.
 * A frozen record normally shows only what it holds, so a later setup change
 * cannot alter what was locked or delivered. SHIP_UNIT (init.sql §31) is
 * planning, not design: it is set ONCE on the template definition — usually
 * after the line is locked, because the planner plans the locked pieces — and
 * it must reach those pieces. Both resolve() and orderValuesService's mirror
 * read this set, so the two stay equal.
 */
export const LIVE_WHEN_FROZEN = new Set(['SHIP_UNIT']);

/**
 * What freezes this record, or null: its order is closed, lost, cancelled or
 * revised (reason 'closed'; orderStatus says which), its line was released to
 * production ('released'), or its line was LOCKED ('locked' — the pieces and
 * their codes are written, and the
 * structure, values and cut pieces stay as they were locked). A released line
 * is also locked; 'released' is the stronger fact, so it is reported first.
 * Only temporary items belong to orders.
 */
export function frozenBy(m) {
  if (!m || m.record_kind !== 'item' || m.item_type !== 'temporary') return null;
  const base = {
    orderId: m.owner_order_id, orderCode: m.owner_order_code, orderStatus: m.owner_order_status, lineNo: m.owner_line_no ?? null,
    orderRevision: m.owner_order_revision ?? null, latestRevision: m.owner_order_latest_revision ?? null,
  };
  if (LOCKED_ORDER_STATUSES.has(m.owner_order_status)) return { ...base, reason: 'closed' };
  if (m.owner_release_id) return { ...base, reason: 'released', releaseId: m.owner_release_id };
  if (m.owner_line_locked_at) return { ...base, reason: 'locked', lockedAt: m.owner_line_locked_at };
  return null;
}

/**
 * Refuses a change to a record of a closed or revised order, a released line or
 * a locked line. `what` names the change: "values", "rules" …
 */
export function assertNotFrozen(m, what) {
  const f = frozenBy(m);
  if (f?.reason === 'released') {
    throw invalid('RELEASED', `${m.code ?? m.name} was released to production with line ${f.lineNo} of ${f.orderCode} — its ${what} can no longer change. (Changing a released structure comes later; until then, take the release back while nothing has started.)`);
  }
  if (f?.reason === 'locked') throw invalid('LOCKED', lockedLineMessage(f.lineNo, f.orderCode));
  if (f?.orderStatus === 'revised') throw invalid('ORDER_CLOSED', revisedOrderMessage(f.orderCode, f.orderRevision, f.latestRevision));
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
