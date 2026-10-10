/**
 * revisionService.js — a change after LOCK is a new REVISION of the same order
 * (models/init.sql §27).
 *
 * After lock a line's structure, values and cut pieces never change. The user,
 * 2026-09-27: "If it changes, the whole sales order basically changes so it
 * should be a new one anyways" — and chose a new revision of the same order
 * ("SO-…-0001 rev 2") over a new order number.
 *
 *   POST   /orders/:id/revise     reviseOrder
 *   DELETE /orders/:id/revision   discardRevision
 *
 * REVISE copies the order into its next revision: the header (same number,
 * revision + 1, revision_of_id -> the old row) and every live line
 * (revises_line_id -> its old line), each custom line with a DEEP COPY of its
 * rows — the rows, their details, Custom BOMs and lines, specification values
 * with their history rows, and the rules the rows carry themselves — all
 * unlocked, the rows drafts again. CUT PLATES ARE NOT COPIED: a cut plate
 * belongs to a rectangle on its line, so the new line's own are derived from
 * its values (cutPlateService.refreshCutPieces), which are complete — they were
 * locked complete. Each rectangle is cut from the plate, and made by the flow,
 * it had on the old line (cutPlateService.rectangleChoices): the plate was
 * somebody's choice, or nesting's, and a revision must not quietly drop it back
 * to the selection's default and no flow. The quantity is the area fraction
 * again — nesting follows lock. The DRAWINGS each row is built to come too:
 * its links are copied onto the new row, never the drawings themselves (a link
 * names one revision of a drawing, and that revision is its own row). The old
 * revision becomes 'revised': kept exactly as it was, read-only everywhere a
 * closed order is (records.LOCKED_ORDER_STATUSES).
 *
 * Nothing is nested, bought or released in the new revision: nesting follows
 * lock. Locking the new revision's first line retires the old revision's pieces
 * (lockService.lockLine), so an unchanged line locks to exactly the codes it
 * had — piece codes are built from the ORDER number, which the revisions share.
 *
 * DISCARD takes the latest revision away again while none of its lines is
 * locked: the revision it replaced gets its status back and is the latest again.
 *
 * ROUND TRIPS (production is ~49 ms away). Revising is a fixed number of
 * statements whatever the size of the order — the header and the lines each
 * INSERT … SELECT, the rows through treeCopyService (the deep copy a paste into
 * a Custom BOM also uses), then one refreshCutPieces per custom line. Never a
 * record at a time. Discarding is the same: a fixed set of bulk statements.
 */
import { invalid, notFound } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { revisedOrderMessage, latestRevisionSql } from './records.js';
import { snapshotSubtrees, writeCopies, cutPlateNodes, deleteTemporaryItems } from './treeCopyService.js';
import { refreshCutPieces, rectangleChoices } from './cutPlateService.js';
import { getOrder } from './salesOrderService.js';
import { carryRequisitions, returnRequisitions } from './requisitionLifecycle.js';

/** The commercial stages a customer order may be revised in. */
const REVISABLE = new Set(['inquiry', 'quoted', 'confirmed']);
/** Rows per multi-row INSERT for a revision's copy: an order's values run to thousands. */
const COPY_CHUNK = 1000;
const ID_CHUNK = 500;

const chunk = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs) => (xs.length === 1 ? String(xs[0]) : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "SO-0001" for a first revision, "SO-0001 rev 2" after — how a person tells them apart. */
export const orderLabel = (o) => (Number(o.revision) > 1 ? `${o.code} rev ${o.revision}` : o.code);

async function requireOrder(db, companyId, id, { lock = false } = {}) {
  const [[o]] = await db.query(
    `SELECT o.*, ${latestRevisionSql('o')} AS latest_revision
       FROM cf_sales_orders o WHERE o.company_id = ? AND o.id = ? AND o.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, id],
  );
  if (!o) throw notFound('Sales order');
  return o;
}

/** The order's live lines, with whether each is locked or released. One query. */
async function linesOf(db, companyId, orderId) {
  const [rows] = await db.query(
    `SELECT l.id, l.line_no, l.line_type, l.item_id, l.locked_at,
            (SELECT r.id FROM cf_production_releases r
              WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_sales_order_lines l
      WHERE l.company_id = ? AND l.order_id = ? AND l.deleted_at IS NULL
      ORDER BY l.line_no, l.id`,
    [companyId, orderId],
  );
  return rows;
}

// --- revise -------------------------------------------------------------------

/**
 * POST /orders/:id/revise — the next revision of an order, as a copy of this
 * one. Allowed on the LATEST revision of an open customer order (an inquiry,
 * quoted or confirmed) with at least one locked line and no line released to
 * production. Needs a transaction. Returns the new revision (getOrder) with
 * `cutPieces`: what refreshCutPieces said for each of its custom lines.
 */
export async function reviseOrder(db, c, orderId) {
  const { companyId } = c;
  const o = await requireOrder(db, companyId, orderId, { lock: true });
  const label = orderLabel(o);

  // ---- every refusal before anything is written ---------------------------
  if (o.status === 'revised' || Number(o.latest_revision) > Number(o.revision)) {
    throw invalid('NOT_LATEST', revisedOrderMessage(o.code, o.revision, o.latest_revision));
  }
  if (o.order_type !== 'customer') {
    throw invalid('NOT_REVISABLE', `${label} is a stock order — it makes standard products and has nothing locked to revise. Only a customer order is revised.`);
  }
  if (!REVISABLE.has(o.status)) {
    throw invalid('NOT_REVISABLE', `${label} is ${o.status} — only an open order (an inquiry, quoted or confirmed) is revised.`);
  }
  const lines = await linesOf(db, companyId, o.id);
  if (!lines.some((l) => l.locked_at)) {
    throw invalid('NOTHING_LOCKED', `Nothing on ${label} is locked yet, so it can still be changed as it is — a revision is only needed once a line is locked.`);
  }
  const released = lines.filter((l) => l.release_id).map((l) => l.line_no);
  if (released.length) {
    throw invalid('RELEASED', `${released.length === 1 ? 'Line' : 'Lines'} ${list(released)} of ${label} ${released.length === 1 ? 'is' : 'are'} released to production — take the release back first, while nothing has started. (Changing a released structure comes later.)`);
  }

  // ---- the new revision's header: the same number, revision + 1 --------------
  // INSERT … SELECT, so the dates are copied by the database and never pass
  // through JavaScript on the way (ARCHITECTURE.md §13: a DATE can shift a day).
  const [ins] = await db.query(
    `INSERT INTO cf_sales_orders
       (company_id, code, order_type, title, customer_id, customer_reference, status, received_on, committed_date, confirmed_at,
        delivery_address, notes, process_id, created_by, revision, revision_of_id)
     SELECT company_id, code, order_type, title, customer_id, customer_reference, status, received_on, committed_date, confirmed_at,
            delivery_address, notes, process_id, ?, revision + 1, id
       FROM cf_sales_orders WHERE company_id = ? AND id = ?`,
    [c.userId ?? null, companyId, o.id],
  );
  const newId = ins.insertId;   // one row: its id, not a count forward from it

  // ---- every live line, pointing back at the line it was copied from ----------
  // A custom line's item is its copied root, set once the rows are written.
  await db.query(
    `INSERT INTO cf_sales_order_lines
       (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, committed_date, bom_revision,
        description, notes, created_by, revises_line_id, rate, rate_basis, currency)
     SELECT company_id, ?, line_no, line_type, IF(line_type = 'custom', NULL, item_id), design_id, position, quantity, committed_date, bom_revision,
            description, notes, ?, id, rate, rate_basis, currency
       FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [newId, c.userId ?? null, companyId, o.id],
  );
  const [fresh] = await db.query(
    'SELECT id, revises_line_id, line_no FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL',
    [companyId, newId],
  );
  const newLineOf = new Map(fresh.map((l) => [Number(l.revises_line_id), l]));
  // Each line's requisition (§56) moves to its copy: the holds, purchase allocations and skips stay with the live line.
  await carryRequisitions(db, companyId, newId);

  // ---- the rows of every custom line: one deep copy for the whole order -------
  const custom = lines.filter((l) => l.line_type === 'custom' && l.item_id);
  if (custom.length) {
    const cutPlates = await cutPlateNodes(db, companyId);
    const isCutPlate = (l) => l.child_item_type === 'temporary' && cutPlates.has(l.child_classification_id);
    const snap = await snapshotSubtrees(db, companyId, custom.map((l) => l.item_id), (l) => l.child_item_type === 'temporary' && !isCutPlate(l));
    const { idMap } = await writeCopies(db, c, snap, custom.map((l) => ({ srcId: l.item_id, ownerLineId: newLineOf.get(l.id).id })), {
      // A line to a cut plate is not copied: the new line derives its own.
      keepLine: (l) => !isCutPlate(l),
      chunk: COPY_CHUNK,
    });
    const missing = custom.filter((l) => !idMap.has(Number(l.item_id)));
    if (missing.length) throw new Error(`cf_erp: the rows of line ${missing.map((l) => l.line_no).join(', ')} of ${label} could not be read to copy them.`);

    // The drawings each row is built to: every live LINK is copied onto the
    // row's copy, pointing at the same drawing revision with the same note. The
    // drawings are never touched — a revision of a drawing is its own row — and
    // the old row keeps its links exactly as they were (drawingService copies
    // links forward, never moves them). One read per 500 rows, one INSERT.
    const links = [];
    for (const part of chunk([...idMap.keys()], ID_CHUNK)) {
      const [rows] = await db.query(
        `SELECT drawing_id, subject_type, subject_id, note FROM cf_drawing_links
          WHERE company_id = ? AND subject_type = 'master_record' AND subject_id IN (?) AND deleted_at IS NULL
          ORDER BY id`,
        [companyId, part],
      );
      links.push(...rows);
    }
    if (links.length) {
      await insertRows(db, 'cf_drawing_links', ['company_id', 'drawing_id', 'subject_type', 'subject_id', 'note', 'created_by'],
        links.map((l) => [companyId, l.drawing_id, l.subject_type, idMap.get(Number(l.subject_id)), l.note, c.userId ?? null]), COPY_CHUNK);
    }

    for (const part of chunk(custom, ID_CHUNK)) {
      const params = [];
      const cases = part.map((l) => { params.push(newLineOf.get(l.id).id, idMap.get(Number(l.item_id))); return 'WHEN ? THEN ?'; }).join(' ');
      params.push(companyId, part.map((l) => newLineOf.get(l.id).id));
      await db.query(`UPDATE cf_sales_order_lines SET item_id = CASE id ${cases} END WHERE company_id = ? AND id IN (?)`, params);
    }
  }

  // ---- the old revision is kept as it was ------------------------------------
  await db.query(
    "UPDATE cf_sales_orders SET status = 'revised', revised_at = NOW(), status_before_revised = ? WHERE company_id = ? AND id = ?",
    [o.status, companyId, o.id],
  );

  // ---- cut pieces, derived for each new line from its (complete) values -------
  // Each rectangle cut from the plate, and by the flow, the old line had for it.
  // refreshCutPieces never throws for a reason a person can act on — it says why.
  const cutPieces = [];
  for (const l of custom) {
    const nl = newLineOf.get(l.id);
    const r = await refreshCutPieces(db, c, nl.id, { carry: await rectangleChoices(db, companyId, l.id) });
    cutPieces.push({ lineId: nl.id, lineNo: nl.line_no, made: r.made, reason: r.reason, message: r.message });
  }

  const order = await getOrder(db, companyId, newId);
  return { ...order, cutPieces };
}

// --- discard ------------------------------------------------------------------

/**
 * DELETE /orders/:id/revision — takes the LATEST revision away while none of
 * its lines is locked (and nothing was released or issued against it): its
 * lines and every row, value and cut piece they hold are deleted, and the
 * revision it replaced gets back the status it had, the latest again. Needs a
 * transaction. Returns the revision that is current again (getOrder).
 */
export async function discardRevision(db, c, orderId) {
  const { companyId } = c;
  const o = await requireOrder(db, companyId, orderId, { lock: true });
  const label = orderLabel(o);

  if (o.status === 'revised' || Number(o.latest_revision) > Number(o.revision)) {
    throw invalid('NOT_LATEST', `${o.code} rev ${o.revision} was revised — it is kept as it was. Only the latest revision, rev ${o.latest_revision ?? Number(o.revision) + 1}, can be discarded.`);
  }
  if (Number(o.revision) <= 1 || !o.revision_of_id) {
    throw invalid('NOT_A_REVISION', `${o.code} is its first revision — there is no earlier one to go back to. Delete or cancel the order instead.`);
  }
  const lines = await linesOf(db, companyId, o.id);
  const locked = lines.filter((l) => l.locked_at).map((l) => l.line_no);
  if (locked.length) {
    throw invalid('LOCKED', `${locked.length === 1 ? 'Line' : 'Lines'} ${list(locked)} of ${label} ${locked.length === 1 ? 'is' : 'are'} locked — ${locked.length === 1 ? 'its' : 'their'} pieces carry their codes, so the revision stays. A change now means another revision.`);
  }
  const released = lines.filter((l) => l.release_id).map((l) => l.line_no);
  if (released.length) {
    throw invalid('RELEASED', `${released.length === 1 ? 'Line' : 'Lines'} ${list(released)} of ${label} ${released.length === 1 ? 'is' : 'are'} released to production — take the release back first.`);
  }
  const [[{ n: moves }]] = await db.query('SELECT COUNT(*) AS n FROM cf_stock_movements WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, o.id]);
  if (Number(moves)) {
    throw invalid('IN_USE', `Stock was issued to ${label} (${plural(Number(moves), 'movement')}) — the revision stays, so its history does.`);
  }
  const [[prev]] = await db.query(
    'SELECT id, status, status_before_revised FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
    [companyId, o.revision_of_id],
  );
  if (!prev || prev.status !== 'revised') {
    throw invalid('NO_PREVIOUS', `The revision ${label} replaced is not there to go back to, so it cannot be discarded. Cancel it instead.`);
  }

  // The requisitions go back to the lines they came from (§56), before this revision's lines are deleted.
  await returnRequisitions(db, companyId, o.id);

  // ---- everything the revision holds, in bulk ---------------------------------
  const lineIds = lines.map((l) => l.id);
  if (lineIds.length) {
    const items = [];
    for (const part of chunk(lineIds, ID_CHUNK)) {
      const [rows] = await db.query(
        `SELECT i.master_id FROM cf_item_details i
          WHERE i.company_id = ? AND i.owner_order_line_id IN (?) AND i.item_type = 'temporary' AND i.deleted_at IS NULL`,
        [companyId, part],
      );
      items.push(...rows.map((r) => r.master_id));
    }
    await deleteTemporaryItems(db, c, items);
    for (const part of chunk(lineIds, ID_CHUNK)) {
      await db.query('UPDATE cf_sales_order_lines SET deleted_at = NOW() WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [companyId, part]);
    }
  }
  await db.query('UPDATE cf_sales_orders SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [companyId, o.id]);

  // ---- the revision it replaced is the latest again, as it stood ----------------
  // The status goes back as a value read above, never as the column it is also
  // clearing: an UPDATE sees its own earlier assignments (ARCHITECTURE.md §13).
  await db.query(
    'UPDATE cf_sales_orders SET status = ?, revised_at = NULL, status_before_revised = NULL WHERE company_id = ? AND id = ?',
    [prev.status_before_revised ?? 'inquiry', companyId, prev.id],
  );
  return getOrder(db, companyId, prev.id);
}
