/**
 * salesOrderService.js — sales orders (the projects) and their lines.
 *
 * Decided 2026-09-22 (models/init.sql §9):
 *   - the sales order IS the project — nothing sits above it;
 *   - a customer inquiry is the first stage of the same record, so the design
 *     work done while estimating is never copied across;
 *   - stock orders make standard products for stock, with no customer, so every
 *     production run hangs off an order line.
 *
 * A line always sells an item. Choosing a catalog item makes a standard line;
 * choosing a template definition makes a custom line, and creates at once (Q21)
 * the temporary item it sells, with the whole Custom BOM copied from the
 * template (instantiationService). Lines and their structures may change while
 * the order is open; release to production — and change control after it —
 * arrive in later phases.
 *
 * REVISIONS (init.sql §27, revisionService). A change after LOCK is a new
 * revision of the same order: another row with the same number and revision
 * + 1. The row it replaced is 'revised' — kept as it was, frozen like a closed
 * order — and lists show the latest revision only unless asked for all.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { requireMaster, kindOf, LOCKED_ORDER_STATUSES as LOCKED, lockedLineMessage, revisedOrderMessage, latestRevisionSql } from './records.js';
import { bomOfParent } from './bomGraph.js';
import { refreshValues } from './valueService.js';
import { instantiateTemplate, deleteTemporaryTree, checkTemplate, temporaryTree } from './instantiationService.js';
import { explode } from './bomService.js';
import { generate } from '../modules/codegen/index.js';
import { resolveProcess } from './processService.js';

export const ORDER_TYPES = ['customer', 'stock'];
export const TRANSITIONS = {
  customer: {
    inquiry: ['quoted', 'confirmed', 'lost', 'cancelled'],
    quoted: ['inquiry', 'confirmed', 'lost', 'cancelled'],
    confirmed: ['closed', 'cancelled'],
    lost: ['inquiry'],
    closed: [],
    cancelled: [],
  },
  stock: {
    draft: ['confirmed', 'cancelled'],
    confirmed: ['closed', 'cancelled'],
    closed: [],
    cancelled: [],
  },
};
const FIRST_STATUS = { customer: 'inquiry', stock: 'draft' };
const DELETABLE = new Set(['draft', 'inquiry', 'lost', 'cancelled']);
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const blank = (v) => v == null || String(v).trim() === '';
const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => {
  if (!d) return null;
  if (d instanceof Date) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return String(d).slice(0, 10);
};
const today = () => dateText(new Date());

function readDate(value, label, problems) {
  if (blank(value)) return null;
  const s = String(value).trim();
  const d = new Date(`${s}T00:00:00`);
  if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || dateText(d) !== s) { problems.push(`${label} needs a date as YYYY-MM-DD.`); return null; }
  return s;
}

function readText(value, label, max, problems) {
  if (blank(value)) return null;
  const s = String(value).trim();
  if (s.length > max) problems.push(`${label} is up to ${max} characters.`);
  return s;
}

async function requireCustomer(db, companyId, id, problems) {
  const [[p]] = await db.query('SELECT id, name, is_customer, status FROM cf_parties WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!p) { problems.push('That customer does not exist.'); return null; }
  if (!Number(p.is_customer)) problems.push(`${p.name} is not marked as a customer.`);
  if (p.status !== 'active') problems.push(`${p.name} is inactive.`);
  return p;
}

async function requireOrder(db, companyId, id, { lock = false } = {}) {
  const [[o]] = await db.query(
    `SELECT o.*, ${latestRevisionSql('o')} AS latest_revision
       FROM cf_sales_orders o WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, id],
  );
  if (!o) throw notFound('Sales order');
  return o;
}

/** The sentence a revised order is refused with — naming the revision to change instead. */
const revisedWords = (o) => revisedOrderMessage(o.code, o.revision, o.latest_revision);

function assertOpen(order) {
  if (order.status === 'revised') throw invalid('ORDER_LOCKED', revisedWords(order));
  if (LOCKED.has(order.status)) throw invalid('ORDER_LOCKED', `Order ${order.code} is ${order.status} — reopen it before changing it.`);
}

// --- orders --------------------------------------------------------------------

/**
 * The orders, newest first. Only the LATEST revision of each by default: an
 * earlier one was replaced and is kept for the record (init.sql §27).
 * `revisions=all` lists them too, and so does asking for status=revised.
 */
export async function listOrders(db, companyId, q = {}) {
  const where = ['o.company_id = ?', 'o.deleted_at IS NULL'];
  const params = [companyId];
  if (q.revisions !== 'all' && q.status !== 'revised') where.push("o.status <> 'revised'");
  if (!blank(q.status)) { where.push('o.status = ?'); params.push(q.status); }
  if (!blank(q.orderType)) { where.push('o.order_type = ?'); params.push(q.orderType); }
  if (!blank(q.customerId)) { where.push('o.customer_id = ?'); params.push(Number(q.customerId)); }
  if (q.open === '1' || q.open === 1 || q.open === true) where.push("o.status NOT IN ('closed','lost','cancelled','revised')");
  if (!blank(q.search)) {
    const like = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push('(o.code LIKE ? OR o.title LIKE ? OR o.customer_reference LIKE ? OR p.name LIKE ?)');
    params.push(like, like, like, like);
  }
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
  const [rows] = await db.query(
    `SELECT o.*, p.code AS customer_code, p.name AS customer_name,
            (SELECT COUNT(*) FROM cf_sales_order_lines l WHERE l.company_id = o.company_id AND l.order_id = o.id AND l.deleted_at IS NULL) AS line_count
       FROM cf_sales_orders o
       LEFT JOIN cf_parties p ON p.id = o.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ?`,
    [...params, limit],
  );
  return rows.map(shapeOrder);
}

function shapeOrder(o) {
  const committed = dateText(o.committed_date);
  return {
    id: o.id,
    code: o.code,
    orderType: o.order_type,
    title: o.title,
    customer: o.customer_id ? { id: o.customer_id, code: o.customer_code ?? null, name: o.customer_name ?? null } : null,
    customerReference: o.customer_reference,
    status: o.status,
    receivedOn: dateText(o.received_on),
    committedDate: committed,
    confirmedAt: o.confirmed_at,
    deliveryAddress: o.delivery_address,
    notes: o.notes,
    // Revisions (init.sql §27): the same number across them, this one's place.
    revision: Number(o.revision ?? 1),
    revisionOfId: o.revision_of_id ?? null,
    revisedAt: o.revised_at ?? null,
    statusBeforeRevised: o.status_before_revised ?? null,
    lineCount: o.line_count == null ? undefined : Number(o.line_count),
    overdue: !!committed && committed < today() && !LOCKED.has(o.status),
    allowedTransitions: TRANSITIONS[o.order_type]?.[o.status] ?? [],
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

/**
 * Per custom line: how many rows its structure has (its temporary items, cut
 * plates included) and how many selections are unchosen. No draft count: a row
 * has no draft life of its own — locking the line activates it (lockService).
 */
async function structureStats(db, companyId, lineIds) {
  const out = new Map(lineIds.map((id) => [id, { temporaryItems: 0, unresolvedSelections: 0 }]));
  if (!lineIds.length) return out;
  const [items] = await db.query(
    `SELECT i.owner_order_line_id AS line_id, COUNT(*) AS n
       FROM cf_item_details i JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL
      WHERE i.company_id = ? AND i.owner_order_line_id IN (?) AND i.deleted_at IS NULL
      GROUP BY i.owner_order_line_id`,
    [companyId, lineIds],
  );
  for (const r of items) out.get(r.line_id).temporaryItems = Number(r.n);
  const [sel] = await db.query(
    `SELECT pi.owner_order_line_id AS line_id, COUNT(*) AS n
       FROM cf_bom_lines l
       JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
       JOIN cf_item_details pi ON pi.master_id = b.parent_id AND pi.deleted_at IS NULL
       JOIN cf_master_records ch ON ch.id = l.child_id AND ch.record_kind = 'definition'
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.selection_definition_id IS NOT NULL
        AND pi.owner_order_line_id IN (?)
      GROUP BY pi.owner_order_line_id`,
    [companyId, lineIds],
  );
  for (const r of sel) out.get(r.line_id).unresolvedSelections = Number(r.n);
  return out;
}

export async function getOrder(db, companyId, id) {
  const o = await requireOrder(db, companyId, id);
  const [[cust]] = o.customer_id
    ? await db.query('SELECT code, name FROM cf_parties WHERE id = ?', [o.customer_id])
    : [[null]];
  const order = shapeOrder({ ...o, customer_code: cust?.code, customer_name: cust?.name });
  // Every revision of this order, oldest first — one index lookup on the number.
  const [revs] = await db.query(
    'SELECT id, revision, status, revised_at FROM cf_sales_orders WHERE company_id = ? AND code_active = ? ORDER BY revision',
    [companyId, String(o.code).toLowerCase()],
  );
  order.revisions = revs.map((r) => ({ id: r.id, revision: Number(r.revision), status: r.status, revisedAt: r.revised_at ?? null }));
  const [lines] = await db.query(
    `SELECT l.*, m.code AS item_code, m.name AS item_name, m.status AS item_status, m.revision AS item_revision,
            i.item_type, i.uom, dz.code AS design_code, dz.name AS design_name,
            b.status AS bom_status, b.revision AS current_bom_revision,
            rel.id AS release_id, rel.created_at AS released_at
       FROM cf_sales_order_lines l
       LEFT JOIN cf_master_records m ON m.id = l.item_id
       LEFT JOIN cf_item_details i ON i.master_id = l.item_id
       JOIN cf_master_records dz ON dz.id = l.design_id
       LEFT JOIN cf_boms b ON b.parent_id = l.item_id AND b.deleted_at IS NULL
       LEFT JOIN cf_production_releases rel ON rel.order_line_id = l.id AND rel.deleted_at IS NULL
      WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL
      ORDER BY l.line_no, l.id`,
    [companyId, id],
  );
  const stats = await structureStats(db, companyId, lines.filter((l) => l.line_type === 'custom').map((l) => l.id));
  order.lines = lines.map((l) => ({
    id: l.id,
    lineNo: l.line_no,
    lineType: l.line_type,
    position: l.position,
    quantity: Number(l.quantity),
    // What has been made into stock and what has left the yard (Idea A).
    made: Number(l.made_qty ?? 0),
    delivered: Number(l.delivered_qty ?? 0),
    committedDate: dateText(l.committed_date),
    description: l.description,
    notes: l.notes,
    item: l.item_id ? { id: l.item_id, code: l.item_code, name: l.item_name, status: l.item_status, kind: l.item_type, uom: l.uom, revision: l.item_revision } : null,
    design: { id: l.design_id, code: l.design_code, name: l.design_name },
    bomRevision: l.bom_revision,
    bom: l.bom_status ? { status: l.bom_status, currentRevision: l.current_bom_revision } : null,
    structure: stats.get(l.id) ?? null,
    release: l.release_id ? { id: l.release_id, releasedAt: l.released_at } : null,
    // Locked (lockService): its pieces carry their codes, and its structure,
    // values and cut pieces no longer change. `position` is its line.position.
    lock: l.locked_at ? { lockedAt: l.locked_at, position: l.lock_position } : null,
    // The line of the previous revision this one was copied from (init.sql §27).
    revisesLineId: l.revises_line_id ?? null,
  }));
  return order;
}

/** The live release of a line, if it was released to production. */
async function releaseOfLine(db, companyId, lineId) {
  const [[r]] = await db.query('SELECT id FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [companyId, lineId]);
  return r || null;
}

/**
 * Creates an order. input: { orderType, customerId?, title?, customerReference?,
 * receivedOn?, committedDate?, deliveryAddress?, notes?, code? }.
 * The number is typed or comes from a coding rule for sales orders — and stays
 * the same from first inquiry to closure.
 */
export async function createOrder(db, c, input = {}) {
  const problems = [];
  const orderType = input.orderType ?? 'customer';
  if (!ORDER_TYPES.includes(orderType)) problems.push('An order is a customer order or a stock order.');
  let customerId = null;
  if (orderType === 'customer') {
    if (blank(input.customerId)) problems.push('A customer order needs a customer.');
    else if (await requireCustomer(db, c.companyId, Number(input.customerId), problems)) customerId = Number(input.customerId);
  } else if (!blank(input.customerId)) {
    problems.push('A stock order has no customer.');
  }
  const body = {
    title: readText(input.title, 'Title', 255, problems),
    customer_reference: readText(input.customerReference, 'Customer reference', 100, problems),
    received_on: readDate(input.receivedOn, 'Received on', problems) ?? today(),
    committed_date: readDate(input.committedDate, 'Committed date', problems),
    delivery_address: blank(input.deliveryAddress) ? null : String(input.deliveryAddress),
    notes: blank(input.notes) ? null : String(input.notes),
  };
  let code = blank(input.code) ? null : String(input.code).trim();
  if (code && (!CODE_RE.test(code) || code.length > 100)) problems.push('Order number: up to 100 letters, digits and - _ . /, no spaces.');
  assertNoProblems(problems);

  if (!code) {
    const g = await generate(db, c.companyId, 'sales_order', 'code', { draft: { orderType, customerId } }, { consume: true });
    code = g?.text ?? null;
    if (!code) throw invalid('CODE_REQUIRED', 'Type an order number, or add a coding rule for sales orders under Coding rules.');
  }
  // The process is STAMPED here, not looked up later (init.sql §18): changing
  // a customer's process must not move orders already running. No rule and no
  // house default leaves it NULL — the order simply has no process, which the
  // process endpoint says in words rather than inventing one.
  const { processId } = await resolveProcess(db, c.companyId, { customerId, orderType });
  const [r] = await db.query(
    `INSERT INTO cf_sales_orders
       (company_id, code, order_type, title, customer_id, customer_reference, status, received_on, committed_date, delivery_address, notes, process_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, code, orderType, body.title, customerId, body.customer_reference, FIRST_STATUS[orderType],
      body.received_on, body.committed_date, body.delivery_address, body.notes, processId, c.userId],
  );
  return getOrder(db, c.companyId, r.insertId);
}

export async function updateOrder(db, c, id, input = {}) {
  const o = await requireOrder(db, c.companyId, id, { lock: true });
  assertOpen(o);
  const problems = [];
  const sets = {};
  if (input.orderType !== undefined && input.orderType !== o.order_type) problems.push('An order stays a customer order or a stock order.');
  if (input.code !== undefined) {
    const code = String(input.code ?? '').trim();
    if (code !== o.code) {
      const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ?', [c.companyId, id]);
      if (Number(o.revision) > 1) problems.push(`A revision keeps its order's number — this is rev ${o.revision} of ${o.code}.`);
      else if (Number(n)) problems.push('The order number is fixed once the order has lines — item codes are built from it.');
      else if (!code || !CODE_RE.test(code) || code.length > 100) problems.push('Order number: up to 100 letters, digits and - _ . /, no spaces.');
      sets.code = code;
    }
  }
  if (input.customerId !== undefined) {
    if (o.order_type === 'stock') { if (!blank(input.customerId)) problems.push('A stock order has no customer.'); }
    else if (blank(input.customerId)) problems.push('A customer order needs a customer.');
    else if (await requireCustomer(db, c.companyId, Number(input.customerId), problems)) sets.customer_id = Number(input.customerId);
  }
  if (input.title !== undefined) sets.title = readText(input.title, 'Title', 255, problems);
  if (input.customerReference !== undefined) sets.customer_reference = readText(input.customerReference, 'Customer reference', 100, problems);
  if (input.receivedOn !== undefined) sets.received_on = readDate(input.receivedOn, 'Received on', problems);
  if (input.committedDate !== undefined) sets.committed_date = readDate(input.committedDate, 'Committed date', problems);
  if (input.deliveryAddress !== undefined) sets.delivery_address = blank(input.deliveryAddress) ? null : String(input.deliveryAddress);
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : String(input.notes);
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_sales_orders SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, id]);
  }
  return getOrder(db, c.companyId, id);
}

/**
 * Moves an order through its lifecycle (TRANSITIONS). Confirming is the
 * commitment, so it needs lines and — for a customer — a committed date.
 * Drafts and unchosen selections do not block confirming; they will block
 * release to production.
 */
export async function setOrderStatus(db, c, id, status) {
  const o = await requireOrder(db, c.companyId, id, { lock: true });
  if (o.status === status) return getOrder(db, c.companyId, id);
  // 'revised' is set by revising and cleared by discarding the revision — never by hand.
  if (o.status === 'revised') throw invalid('ORDER_LOCKED', revisedWords(o));
  const allowed = TRANSITIONS[o.order_type]?.[o.status] ?? [];
  if (!allowed.includes(status)) throw invalid('BAD_TRANSITION', `A ${o.status} ${o.order_type} order cannot become ${status}.`);
  const wasLocked = LOCKED.has(o.status);
  const willLock = LOCKED.has(status);
  if (status === 'confirmed') {
    const problems = [];
    const [lines] = await db.query('SELECT line_no, committed_date FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [c.companyId, id]);
    if (!lines.length) problems.push('It has no lines.');
    if (o.order_type === 'customer') {
      if (!o.customer_id) problems.push('It has no customer.');
      const undated = lines.filter((l) => !l.committed_date).map((l) => l.line_no);
      if (!o.committed_date && undated.length) problems.push(`Give the order a committed date, or date line${undated.length > 1 ? 's' : ''} ${undated.join(', ')}.`);
    }
    if (problems.length) throw invalid('INCOMPLETE', `${o.code} cannot be confirmed yet.`, { problems });
  }
  if (status === 'cancelled') {
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_production_releases WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [c.companyId, id]);
    if (Number(n)) throw invalid('RELEASED', `${o.code} has ${n} line${Number(n) === 1 ? '' : 's'} released to production — take ${Number(n) === 1 ? 'it' : 'them'} back (while nothing has started) before cancelling.`);
  }
  // A closed order's leftover reservations are let go, so the stock is free
  // again — the material it never used, and anything made for it that was never
  // shipped (it is still on the dispatch shelf; closing only unclaims it).
  if (status === 'closed') {
    await db.query(
      `UPDATE cf_stock_reservations v
         JOIN cf_material_requirements q ON q.id = v.requirement_id
         JOIN cf_production_releases r ON r.id = q.release_id
          SET v.status = 'released', v.closed_at = NOW()
        WHERE v.company_id = ? AND r.order_id = ? AND v.status = 'active'`,
      [c.companyId, id],
    );
    await db.query(
      `UPDATE cf_stock_reservations v
         JOIN cf_sales_order_lines l ON l.id = v.order_line_id
          SET v.status = 'released', v.closed_at = NOW()
        WHERE v.company_id = ? AND l.order_id = ? AND v.status = 'active'`,
      [c.companyId, id],
    );
  }
  // Locking freezes the values its items hold, so bring them up to date first;
  // reopening a lost order lets them catch up with setup changes made meanwhile.
  if (!wasLocked && willLock) await refreshOrderValues(db, c, id);
  await db.query(
    `UPDATE cf_sales_orders SET status = ?, confirmed_at = ${status === 'confirmed' ? 'NOW()' : 'confirmed_at'} WHERE company_id = ? AND id = ?`,
    [status, c.companyId, id],
  );
  if (wasLocked && !willLock) await refreshOrderValues(db, c, id);
  return getOrder(db, c.companyId, id);
}

/** Re-works the values of every temporary item on an order, children before parents. */
async function refreshOrderValues(db, c, orderId) {
  const [lines] = await db.query(
    "SELECT item_id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND line_type = 'custom' AND item_id IS NOT NULL AND deleted_at IS NULL",
    [c.companyId, orderId],
  );
  const ids = [];
  for (const l of lines) ids.push(...(await temporaryTree(db, c.companyId, l.item_id)));
  if (ids.length) await refreshValues(db, c, ids);
}

export async function deleteOrder(db, c, id) {
  const o = await requireOrder(db, c.companyId, id, { lock: true });
  if (o.status === 'revised') throw conflict('ORDER_ACTIVE', revisedWords(o));
  // Deleting a revision would leave the one it replaced frozen with nothing after it.
  if (Number(o.revision) > 1) {
    throw conflict('ORDER_ACTIVE', `${o.code} rev ${o.revision} is a revision — discard the revision instead, which gives rev ${Number(o.revision) - 1} back as it was.`);
  }
  if (!DELETABLE.has(o.status)) {
    throw conflict('ORDER_ACTIVE', `A ${o.status} order cannot be deleted — cancel it instead, so its history stays.`);
  }
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM cf_stock_movements WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (Number(n)) throw conflict('IN_USE', `Stock was issued to ${o.code} (${n} movement${Number(n) === 1 ? '' : 's'}) — cancel it instead, so its history stays.`);
  const [lines] = await db.query('SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  for (const l of lines) await removeLineRows(db, c, l.id);
  await db.query('UPDATE cf_sales_orders SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

// --- lines ---------------------------------------------------------------------

async function requireOrderLine(db, companyId, lineId) {
  const [[l]] = await db.query('SELECT * FROM cf_sales_order_lines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, lineId]);
  if (!l) throw notFound('Order line');
  return l;
}

/**
 * Adds a line. input: { recordId, quantity, committedDate?, description?, lineNo?, notes? }.
 * recordId is a catalog item (standard line) or a template definition (custom
 * line — its temporary item and Custom BOM are created now).
 */
export async function addOrderLine(db, c, orderId, input = {}) {
  const o = await requireOrder(db, c.companyId, orderId, { lock: true });
  assertOpen(o);
  const problems = [];
  const quantity = Number(input.quantity);
  if (blank(input.quantity) || !Number.isFinite(quantity) || quantity <= 0) problems.push('Quantity must be more than zero.');
  else if (quantity >= 1e9) problems.push('Quantity is too large.');
  const committedDate = readDate(input.committedDate, 'Committed date', problems);
  const description = readText(input.description, 'Description', 500, problems);
  let lineNo = null;
  if (!blank(input.lineNo)) {
    lineNo = Number(input.lineNo);
    if (!Number.isInteger(lineNo) || lineNo <= 0 || lineNo > 1e6) problems.push('Line number is a positive whole number.');
  }
  if (blank(input.recordId)) problems.push('Choose a catalog item or a template definition.');
  assertNoProblems(problems);

  const rec = await requireMaster(db, c.companyId, Number(input.recordId), 'That record');
  const kind = kindOf(rec);
  if (!['catalog', 'template'].includes(kind)) {
    throw invalid('WRONG_RECORD', kind === 'selection'
      ? 'A line sells an item: choose the catalog item itself, or a template definition.'
      : 'That is a row of another order line’s structure — add the template it was made from.');
  }
  if (o.order_type === 'stock' && kind !== 'catalog') throw invalid('STOCK_STANDARD_ONLY', 'A stock order makes standard products — choose a catalog item.');
  if (kind === 'template') await checkTemplate(db, c.companyId, rec);
  if (kind === 'catalog' && rec.status !== 'active') throw invalid('NOT_ACTIVE', `${rec.code ?? rec.name} is ${rec.status} — only active catalog items can be sold.`);

  if (lineNo == null) {
    const [[{ top }]] = await db.query('SELECT MAX(line_no) AS top FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [c.companyId, orderId]);
    lineNo = (Number(top) || 0) + 10;
  }
  // Counts deleted lines too: a position is never given out twice.
  const [[{ top: topPos }]] = await db.query('SELECT MAX(position) AS top FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND design_id = ?', [c.companyId, orderId, rec.id]);
  const position = (Number(topPos) || 0) + 1;

  let bomRevision = null;
  if (kind === 'catalog') {
    const bom = await bomOfParent(db, c.companyId, rec.id);
    if (bom && bom.status === 'active') bomRevision = bom.revision;
  }
  const [r] = await db.query(
    `INSERT INTO cf_sales_order_lines
       (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, committed_date, bom_revision, description, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, orderId, lineNo, kind === 'catalog' ? 'standard' : 'custom', kind === 'catalog' ? rec.id : null, rec.id, position,
      Number(quantity.toFixed(6)), committedDate, bomRevision, description, blank(input.notes) ? null : String(input.notes), c.userId],
  );
  if (kind === 'template') {
    // The copy points the line at the item it makes, and settles the values,
    // names and codes of everything it creates — in bulk (instantiationService).
    await instantiateTemplate(db, c, { definition: rec, ownerLineId: r.insertId });
  }
  return getOrder(db, c.companyId, orderId);
}

/** input: { quantity?, committedDate?, description?, lineNo?, notes? } — what a line sells cannot change. */
export async function updateOrderLine(db, c, lineId, input = {}) {
  const line = await requireOrderLine(db, c.companyId, lineId);
  const o = await requireOrder(db, c.companyId, line.order_id, { lock: true });
  assertOpen(o);
  if (input.recordId !== undefined && Number(input.recordId) !== line.design_id) {
    throw invalid('IDENTITY', 'What a line sells cannot change — remove it and add another line.');
  }
  if (input.quantity !== undefined && Number(input.quantity) !== Number(line.quantity) && await releaseOfLine(db, c.companyId, lineId)) {
    throw invalid('RELEASED', `Line ${line.line_no} is released to production — its quantity is fixed. Take the release back (while nothing has started) to change it.`);
  }
  // The quantity is what a locked line was rolled out from: its pieces exist.
  if (input.quantity !== undefined && Number(input.quantity) !== Number(line.quantity) && line.locked_at) {
    throw invalid('LOCKED', lockedLineMessage(line.line_no, o.code));
  }
  const problems = [];
  const sets = {};
  if (input.quantity !== undefined) {
    const q = Number(input.quantity);
    if (blank(input.quantity) || !Number.isFinite(q) || q <= 0 || q >= 1e9) problems.push('Quantity must be more than zero.');
    else sets.quantity = Number(q.toFixed(6));
  }
  if (input.committedDate !== undefined) sets.committed_date = readDate(input.committedDate, 'Committed date', problems);
  if (input.description !== undefined) sets.description = readText(input.description, 'Description', 500, problems);
  if (input.notes !== undefined) sets.notes = blank(input.notes) ? null : String(input.notes);
  if (input.lineNo !== undefined) {
    const n = Number(input.lineNo);
    if (!Number.isInteger(n) || n <= 0 || n > 1e6) problems.push('Line number is a positive whole number.');
    else sets.line_no = n;
  }
  assertNoProblems(problems);
  if (Object.keys(sets).length) {
    await db.query(`UPDATE cf_sales_order_lines SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...Object.values(sets), c.companyId, lineId]);
  }
  return getOrder(db, c.companyId, line.order_id);
}

async function removeLineRows(db, c, lineId) {
  const line = await requireOrderLine(db, c.companyId, lineId);
  if (line.line_type === 'custom' && line.item_id) await deleteTemporaryTree(db, c, line.item_id);
  // A deleted order takes its locked pieces with it, so their codes are free again.
  if (line.locked_at) {
    await db.query('UPDATE cf_order_pieces SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [c.companyId, lineId]);
  }
  await db.query('UPDATE cf_sales_order_lines SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, lineId]);
  return line;
}

/** Removes a line; a custom line takes its whole structure with it. */
export async function removeOrderLine(db, c, lineId) {
  const line = await requireOrderLine(db, c.companyId, lineId);
  const o = await requireOrder(db, c.companyId, line.order_id, { lock: true });
  assertOpen(o);
  if (await releaseOfLine(db, c.companyId, lineId)) {
    throw invalid('RELEASED', `Line ${line.line_no} is released to production — take the release back (while nothing has started) before removing it.`);
  }
  if (line.locked_at) throw invalid('LOCKED', lockedLineMessage(line.line_no, o.code));
  await removeLineRows(db, c, lineId);
  return getOrder(db, c.companyId, line.order_id);
}

/** The full structure a line sells: its Custom BOM, or the catalog item's Standard BOM. */
export async function lineStructure(db, companyId, lineId) {
  const line = await requireOrderLine(db, companyId, lineId);
  const o = await requireOrder(db, companyId, line.order_id);
  if (!line.item_id) throw invalid('NO_ITEM', 'This line has no item yet.');
  const tree = await explode(db, companyId, line.item_id, { rootQuantity: Number(line.quantity) });
  return {
    line: { id: line.id, lineNo: line.line_no, lineType: line.line_type, quantity: Number(line.quantity) },
    order: { id: o.id, code: o.code, status: o.status, editable: !LOCKED.has(o.status) && !line.locked_at && !(await releaseOfLine(db, companyId, line.id)) },
    ...tree,
  };
}

/** For the parties module: sales orders that name a party. */
export async function partyReferences(db, companyId, partyId) {
  const [rows] = await db.query(
    'SELECT code FROM cf_sales_orders WHERE company_id = ? AND customer_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 6',
    [companyId, partyId],
  );
  // The revisions of one order share its number, so it is named once.
  return rows.length ? [`it is the customer on sales order ${[...new Set(rows.map((r) => r.code))].join(', ')}`] : [];
}
