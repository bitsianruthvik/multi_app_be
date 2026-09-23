/**
 * dispatchService.js — shipping what has been made (Idea A, user 2026-09-23).
 *
 * "Once it enters as the done stock for the line item in the order, it is ready
 * to be shipped." So shipping is not a new kind of document: the finished piece
 * is already stock, earmarked for its line, and a shipment is an ordinary
 * ISSUE against the order — same ledger, same balances, reversible like any
 * other movement.
 *
 * WHAT CAN GO. Only what is earmarked for the line: its own finished stock,
 * never another job's. The earmark falls first and the issue follows, so the
 * issue does not trip over the rule that keeps reserved stock reserved.
 *
 * PART LOADS ARE NORMAL. Four girders are rarely delivered at once, so a line
 * carries `delivered_qty` and is shipped as many times as it takes.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { LOCKED_ORDER_STATUSES } from './records.js';
import { postMovement } from './stockService.js';
import { getRelease, liveReleaseOfLine } from './releaseService.js';

const EPS = 1e-6;
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const fmt = (n) => Number(Number(n).toFixed(3));

async function requireLine(db, companyId, lineId) {
  const [[l]] = await db.query(
    `SELECT l.*, o.code AS order_code, o.status AS order_status, o.order_type, m.code AS item_code, m.name AS item_name, i.uom
       FROM cf_sales_order_lines l
       JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
       LEFT JOIN cf_master_records m ON m.id = l.item_id
       LEFT JOIN cf_item_details i ON i.master_id = l.item_id
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL FOR UPDATE`,
    [companyId, Number(lineId)],
  );
  if (!l) throw notFound('Order line');
  return l;
}

/** Active earmarks of finished stock for a line, oldest first. */
async function earmarks(db, companyId, lineId) {
  const [rows] = await db.query(
    `SELECT v.*, b.code AS batch_code, b.status AS batch_status
       FROM cf_stock_reservations v
       LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
      WHERE v.company_id = ? AND v.order_line_id = ? AND v.status = 'active' AND v.deleted_at IS NULL
      ORDER BY v.id FOR UPDATE`,
    [companyId, lineId],
  );
  return rows;
}

/** What a line has made, shipped and still owes. */
export async function shipmentView(db, companyId, lineId) {
  const l = await requireLine(db, companyId, lineId);
  const res = await earmarks(db, companyId, l.id);
  return {
    line: { id: l.id, lineNo: l.line_no, orderId: l.order_id, orderCode: l.order_code, item: { code: l.item_code, name: l.item_name, uom: l.uom } },
    quantity: Number(l.quantity),
    made: Number(l.made_qty),
    delivered: Number(l.delivered_qty),
    readyToShip: round6(res.reduce((t, v) => t + Number(v.quantity), 0)),
  };
}

/**
 * Ships a line: issues its earmarked finished stock to the order.
 * input: { quantity?, reference?, movementDate?, notes? } — quantity defaults
 * to everything standing ready.
 */
export async function shipLine(db, c, lineId, input = {}) {
  const l = await requireLine(db, c.companyId, lineId);
  if (LOCKED_ORDER_STATUSES.has(l.order_status)) throw invalid('LOCKED', `Order ${l.order_code} is ${l.order_status} — nothing more is shipped against it.`);
  if (l.order_type === 'stock') throw invalid('STOCK_ORDER', `${l.order_code} is a stock order: what it makes goes on the shelf, it is not shipped to anybody.`);
  await db.query('SELECT master_id FROM cf_item_details WHERE company_id = ? AND master_id = ? FOR UPDATE', [c.companyId, l.item_id]);
  const res = await earmarks(db, c.companyId, l.id);
  const ready = round6(res.reduce((t, v) => t + Number(v.quantity), 0));
  const owed = round6(Number(l.quantity) - Number(l.delivered_qty));
  if (ready <= EPS) {
    throw invalid('NOTHING_READY', Number(l.made_qty) > EPS
      ? `Nothing of line ${l.line_no} is standing ready — all ${fmt(l.made_qty)} made ${Number(l.made_qty) === 1 ? 'has' : 'have'} been shipped or moved elsewhere.`
      : `Nothing of line ${l.line_no} has been made yet. A piece becomes ready to ship when its last step is recorded.`);
  }
  const problems = [];
  let quantity = blank(input.quantity) ? ready : Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) problems.push('Quantity is a number above zero.');
  else {
    if (quantity > ready + EPS) problems.push(`Only ${fmt(ready)} ${l.uom ?? ''} of line ${l.line_no} is ready to ship.`.replace('  ', ' '));
    if (quantity > owed + EPS) problems.push(`Line ${l.line_no} only owes ${fmt(owed)} more.`);
  }
  assertNoProblems(problems, `Line ${l.line_no} of ${l.order_code} cannot be shipped.`);
  quantity = round6(quantity);

  // The earmarks fall first, oldest first, so the issue below does not trip
  // over the rule that keeps made-for-a-line stock standing.
  const byArea = new Map();
  let left = quantity;
  for (const v of res) {
    if (left <= EPS) break;
    const take = round6(Math.min(left, Number(v.quantity)));
    const [bal] = await db.query(
      `SELECT k.stocking_area_id, k.quantity FROM cf_stock_balances k
         JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose = 'dispatch'
        WHERE k.company_id = ? AND k.item_id = ? AND k.batch_key = ? AND k.quantity > 0
        ORDER BY k.quantity DESC, a.code`,
      [c.companyId, l.item_id, v.batch_id ?? 0],
    );
    let need = take;
    for (const b of bal) {
      if (need <= EPS) break;
      const part = round6(Math.min(need, Number(b.quantity)));
      if (!byArea.has(b.stocking_area_id)) byArea.set(b.stocking_area_id, []);
      byArea.get(b.stocking_area_id).push({ itemId: l.item_id, batchId: v.batch_id, quantity: part });
      need = round6(need - part);
    }
    const taken = round6(take - need);
    if (taken <= EPS) continue;
    const rest = round6(Number(v.quantity) - taken);
    await db.query(
      `UPDATE cf_stock_reservations SET quantity = ?, status = ?, closed_at = ${rest <= EPS ? 'NOW()' : 'NULL'} WHERE company_id = ? AND id = ?`,
      [rest <= EPS ? 0 : rest, rest <= EPS ? 'consumed' : 'active', c.companyId, v.id],
    );
    left = round6(left - taken);
  }
  const shipped = round6(quantity - left);
  if (shipped <= EPS) throw invalid('NOT_THERE', `What was made for line ${l.line_no} is not on the dispatch shelf any more — find it before shipping.`);

  let movement = null;
  for (const [areaId, lines] of byArea) {
    movement = await postMovement(db, c, {
      movementType: 'issue',
      orderId: l.order_id,
      fromAreaId: areaId,
      lines,
      movementDate: input.movementDate,
      reference: blank(input.reference) ? `${l.order_code}/${l.line_no}` : String(input.reference).slice(0, 100),
      notes: blank(input.notes) ? `Shipped against line ${l.line_no} of ${l.order_code}` : String(input.notes),
    }, { fromProduction: true });   // production's own stock, going back out
    await db.query('UPDATE cf_stock_movements SET order_line_id = ? WHERE company_id = ? AND id = ?', [l.id, c.companyId, movement.id]);
  }
  await db.query('UPDATE cf_sales_order_lines SET delivered_qty = delivered_qty + ? WHERE company_id = ? AND id = ?', [shipped, c.companyId, l.id]);
  const release = await liveReleaseOfLine(db, c.companyId, l.id);
  return {
    movement,
    shipped,
    line: await shipmentView(db, c.companyId, l.id),
    release: release ? await getRelease(db, c.companyId, release.id) : null,
  };
}
