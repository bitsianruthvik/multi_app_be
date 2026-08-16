/**
 * wipInventoryService.js
 * ----------------------
 * Work-in-process (WIP) inventory for fab_erp production (BUG-01/02/07 fix).
 *
 * Model (per user decision, 2026-07-23):
 *   - Each machine has its own stock area (fab_resources.stock_location_id),
 *     auto-provisioned on first use.
 *   - A BOM node (fab_items row) is carried through its operation flow as a
 *     SINGLE WIP piece identified by the node's own catalog item
 *     (fab_stock_pieces.status='wip', wip_item_id=<node id>). The piece moves
 *     machine→machine as the flow progresses.
 *   - Inputs are consumed at the FIRST operation's start (deduct, same-unit qty):
 *       · raw_material / consumable → from in-stock pieces of the catalog item
 *       · component (child node)    → from the child's produced (in_stock) pieces
 *     A shortage aborts the start (throws INSUFFICIENT_STOCK) — this is the real
 *     enforcement of the material gate.
 *   - ONE PLATE PER NEST (2026-08): raw material on a link carrying a `nest_no`
 *     is issued once for the whole nest, not once per part. The shop takes one
 *     plate to the machine and cuts everything out of it; issuing per part drew
 *     the same plate from stock as many times as it had parts on it. The first
 *     part to start claims the nest (see claimNest) and draws the plate; the rest
 *     start normally and draw nothing. Links with `nest_no` NULL are unchanged.
 *   - At the TERMINAL operation's completion the WIP piece is finalized
 *     (wip→in_stock), i.e. it "changes to the next BOM level". A top-level node's
 *     finished piece posts to a Finished-Goods location; sub-assemblies stay in
 *     their terminal machine's area for the parent node to pull.
 *
 * Every movement also appends an audit row to fab_stock_ledger. All functions
 * take an explicit connection so they run inside the task-lifecycle transaction.
 */

import { generateCode } from './codegenService.js';
import { isConsumable } from './itemFieldService.js';
import { piecesHeldByOthers, piecesReservedFor } from './availabilityService.js';

const FG_LOCATION_CODE = 'FG-AUTO'; // per-plant finished-goods sink (auto-provisioned)
const EPS = 1e-9;

/** Insufficient-stock error the start handler turns into a 409. */
function insufficientStock(message) {
  const err = new Error(message);
  err.code = 'INSUFFICIENT_STOCK';
  return err;
}

async function getItemNode(conn, companyId, itemId) {
  const [[row]] = await conn.query(
    `SELECT id, order_id, parent_item_id, catalog_item_id, qty, unit
       FROM fab_items WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [itemId, companyId],
  );
  return row ?? null;
}

/** Min & max step seq_no for a node's tasks (a node has one flow). */
async function stepBounds(conn, companyId, itemId) {
  const [[b]] = await conn.query(
    `SELECT MIN(seq_no) AS minSeq, MAX(seq_no) AS maxSeq
       FROM fab_project_tasks
      WHERE company_id = ? AND item_id = ? AND deleted_at IS NULL`,
    [companyId, itemId],
  );
  return { minSeq: b?.minSeq ?? null, maxSeq: b?.maxSeq ?? null };
}

/** Available on-hand quantity of a catalog item across in-stock pieces. */
export async function availableQty(conn, companyId, catalogItemId) {
  const [[r]] = await conn.query(
    `SELECT COALESCE(SUM(qty), 0) AS q FROM fab_stock_pieces
      WHERE company_id = ? AND catalog_item_id = ? AND status = 'in_stock' AND deleted_at IS NULL`,
    [companyId, catalogItemId],
  );
  return Number(r?.q) || 0;
}

async function writeLedger(conn, companyId, { catalogItemId, plantId, stockLocationId, txnType, qty, batchCode = 'WIP', notes = null }) {
  // Throw, do not return. This used to skip quietly when a piece carried no
  // plant or location — but the caller has ALREADY decremented that piece by the
  // time it gets here, so skipping turned a data-quality problem into stock that
  // left the system with no record of leaving. Failing loudly rolls the whole
  // movement back instead, which is the only outcome that keeps stock and ledger
  // telling the same story.
  if (!catalogItemId || !plantId || !stockLocationId) {
    const err = new Error(
      `Cannot write a stock-ledger row for catalog item ${catalogItemId ?? 'null'}: ` +
      `missing ${!plantId ? 'plant' : 'stock location'}. Refusing to move stock untracked.`,
    );
    err.code = 'LEDGER_INCOMPLETE';
    throw err;
  }
  await conn.query(
    `INSERT INTO fab_stock_ledger
       (company_id, catalog_item_id, plant_id, stock_location_id, batch_id, batch_code, txn_type, qty, txn_date, notes)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, CURDATE(), ?)`,
    [companyId, catalogItemId, plantId, stockLocationId, batchCode, txnType, qty, notes],
  );
}

/** Machine's WIP stock area, provisioning one if the machine has none. */
async function ensureMachineWipLocation(conn, companyId, machine) {
  if (machine.stock_location_id) return machine.stock_location_id;
  if (!machine.plant_id) return null; // a location must be scoped to a plant
  const code = `WIP-M${machine.id}`.slice(0, 20);
  const [[existing]] = await conn.query(
    `SELECT id FROM fab_stock_locations
      WHERE company_id = ? AND plant_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId, machine.plant_id, code],
  );
  let locId = existing?.id;
  if (!locId) {
    const [ins] = await conn.query(
      `INSERT INTO fab_stock_locations (company_id, plant_id, name, code, description)
       VALUES (?, ?, ?, ?, 'Auto-provisioned per-machine work-in-process area')`,
      [companyId, machine.plant_id, `${machine.name || `Machine #${machine.id}`} WIP`, code],
    );
    locId = ins.insertId;
  }
  await conn.query(
    `UPDATE fab_resources SET stock_location_id = ? WHERE id = ? AND company_id = ?`,
    [locId, machine.id, companyId],
  );
  return locId;
}

/** Finished-goods location for a plant, provisioning one if absent. */
async function ensureFinishedGoodsLocation(conn, companyId, plantId) {
  if (!plantId) return null;
  const [[existing]] = await conn.query(
    `SELECT id FROM fab_stock_locations
      WHERE company_id = ? AND plant_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId, plantId, FG_LOCATION_CODE],
  );
  if (existing) return existing.id;
  const [ins] = await conn.query(
    `INSERT INTO fab_stock_locations (company_id, plant_id, name, code, description)
     VALUES (?, ?, 'Finished Goods', ?, 'Auto-provisioned finished-goods receipt location')`,
    [companyId, plantId, FG_LOCATION_CODE],
  );
  return ins.insertId;
}

/** Plant of the task's assigned machine (for FG receipt), or null. */
async function resolveTaskPlant(conn, companyId, assignedResourceId) {
  if (!assignedResourceId) return null;
  const [[m]] = await conn.query(
    `SELECT plant_id FROM fab_resources WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [assignedResourceId, companyId],
  );
  return m?.plant_id ?? null;
}

/** FIFO-consume `required` units of a catalog item from in-stock pieces. */
/**
 * Draw `required` of a catalog item from stock.
 *
 * @param {{lengthMm?:number|null, widthMm?:number|null}} [want]
 *        The size NESTING declared for the plate. When present, only pieces of
 *        exactly that size are eligible.
 *
 * TWO RULES, BOTH ADDED 2026-08-16, BOTH ABOUT TAKING THE WRONG THING.
 *
 * SIZE. This used to FIFO-pick any in-stock piece of the catalog item with no
 * size check at all, so a job needing a 2000x1000 offcut would happily consume
 * the 12000x2500 sheet that happened to arrive first. Nesting is done outside,
 * deliberately, and a declared plate size is a decision — every plate in the
 * yard is already earmarked for a specific nest, so taking a larger one does
 * not merely create an offcut, it steals the plate another nest needs. The
 * match is therefore EXACT, never "at least as large".
 *
 * A requirement with NO declared size falls back to catalog-only matching, so
 * orders created before nesting existed keep working exactly as they did.
 *
 * CONSUMABILITY. A category marked `consumable = no` — machines, tooling,
 * spares — is refused outright. That is what will stop a machine being issued
 * into a girder once machines become catalog items in Phase 8, and it is
 * enforced here rather than as a machine special-case so it holds for anything
 * anybody classifies that way later. It fails OPEN on an unset value: refusing
 * to issue material is a hard block on shop-floor work, and an unclassified
 * category must not stop a job that runs fine today.
 */
async function consumeStock(conn, companyId, catalogItemId, required, { txnType, notes, want = null, orderId = null }) {
  if (!(required > 0)) return true;

  if (!(await isConsumable(companyId, catalogItemId, conn))) {
    // Not a shortage — a category error. Saying "not enough stock" about a
    // machine would send somebody to buy another one.
    const e = new Error(
      `Catalog item #${catalogItemId} is marked as not consumable, so it cannot be issued as material.`,
    );
    e.code = 'NOT_CONSUMABLE';
    throw e;
  }

  /**
   * The size filter engages PER ITEM, only once that item has measured stock.
   *
   * `fab_stock_pieces.length_mm`/`width_mm` were dead columns until 2026-08-16 —
   * nothing ever wrote them — so every piece in an existing yard has no recorded
   * size. Applying an exact-size filter against that would match nothing and
   * refuse every material issue: replaying production before this guard existed
   * showed all six live material links failing, which would have stopped both
   * open orders at the first Start button.
   *
   * So: if no in-stock piece of this item carries a size, the filter has no
   * information to act on and is skipped — behaviour is exactly as before. The
   * moment a measured piece of that item is received (the GRN screen now asks),
   * matching engages for that item and stays engaged. The rule arrives with the
   * data rather than ahead of it, per item, with no flag to remember to flip.
   */
  const wantsSize = want && (want.lengthMm != null || want.widthMm != null);
  let sized = false;
  if (wantsSize) {
    const [[m]] = await conn.query(
      `SELECT COUNT(*) AS measured FROM fab_stock_pieces
        WHERE company_id = ? AND catalog_item_id = ? AND status = 'in_stock'
          AND deleted_at IS NULL AND qty > 0
          AND (length_mm IS NOT NULL OR width_mm IS NOT NULL)`,
      [companyId, catalogItemId],
    );
    sized = Number(m?.measured) > 0;
  }

  /**
   * Plates another order has already named, and plates THIS order has named.
   *
   * A piece-level reservation is the only thing that can stop two orders both
   * believing they hold the one 3000x1500 plate in the yard — catalog-level
   * quantities cannot express it, so before this both would pass their checks
   * and the second would find out at a machine.
   *
   * `orderId` may be absent (a component consume, or an older call site); with
   * no order there is nothing to prefer and nothing of one's own to exclude, so
   * the query simply avoids everybody else's named plates.
   */
  const held = await piecesHeldByOthers(companyId, catalogItemId, { forOrderId: orderId ?? null, conn });
  const mine = orderId
    ? await piecesReservedFor(companyId, orderId, catalogItemId, conn)
    : [];

  const params = [companyId, catalogItemId];
  let sizeWhere = '';
  if (sized) {
    // NULL-safe equality: a piece with no recorded size does not match a sized
    // requirement, which is the point — an unmeasured plate is not evidence of
    // the right plate.
    sizeWhere = ' AND length_mm <=> ? AND width_mm <=> ?';
    params.push(want.lengthMm ?? null, want.widthMm ?? null);
  }

  // Everybody else's named plates are excluded outright. This is the one thing
  // that stops two orders taking the same physical plate.
  let heldWhere = '';
  if (held.size) {
    heldWhere = ` AND id NOT IN (${[...held].map(() => '?').join(',')})`;
    params.push(...held);
  }

  const [pieces] = await conn.query(
    `SELECT id, qty, plant_id, stock_location_id, batch_no FROM fab_stock_pieces
      WHERE company_id = ? AND catalog_item_id = ? AND status = 'in_stock'
        AND deleted_at IS NULL AND qty > 0${sizeWhere}${heldWhere}
      ORDER BY (received_date IS NULL), received_date ASC, id ASC
      FOR UPDATE`,
    params,
  );

  /**
   * Take what this order RESERVED first, then anything else eligible.
   *
   * Without this the FIFO order could hand an order a different plate from the
   * one it earmarked — which still cuts, but leaves its own reservation held
   * against a plate it no longer needs, and quietly denies that plate to
   * whoever else could have used it. Reserving a thing and then taking a
   * different thing is how a reservation system stops meaning anything.
   */
  const minePriority = new Set(mine);
  pieces.sort((a, b) => (minePriority.has(Number(b.id)) ? 1 : 0) - (minePriority.has(Number(a.id)) ? 1 : 0));

  let remaining = Number(required);
  for (const p of pieces) {
    if (remaining <= EPS) break;
    const take = Math.min(Number(p.qty), remaining);
    const newQty = Number(p.qty) - take;
    await conn.query(
      `UPDATE fab_stock_pieces SET qty = ?, status = ? WHERE id = ?`,
      [newQty, newQty <= EPS ? 'consumed' : 'in_stock', p.id],
    );
    await writeLedger(conn, companyId, {
      catalogItemId, plantId: p.plant_id, stockLocationId: p.stock_location_id,
      txnType, qty: -take, batchCode: p.batch_no || 'WIP', notes,
    });

    /**
     * A plate that has been taken stops being reserved.
     *
     * Left active, the earmark would go on excluding that piece from every
     * other order for ever — and since the piece is now consumed, that is a
     * reservation against something that no longer exists. Marked `consumed`
     * rather than `released` so the history still says what happened to it: it
     * was used, not given back.
     */
    if (newQty <= EPS) {
      await conn.query(
        `UPDATE fab_stock_reservations
            SET status = 'consumed', released_at = UTC_TIMESTAMP()
          WHERE company_id = ? AND stock_piece_id = ? AND status = 'active'
            AND deleted_at IS NULL`,
        [companyId, p.id],
      );
    }
    remaining -= take;
  }
  return remaining <= EPS;
}

/**
 * Claim the raw material for this part's first operation.
 *
 * Returns `{ qty, nestNo, claimId }` when the caller should go ahead and draw
 * stock, or `null` when the plate has already gone to the floor for another
 * part on the same nest — twenty parts nested on one plate must draw that plate
 * once, not twenty times.
 *
 * The claim is an INSERT against a UNIQUE key rather than a read-then-write:
 * two operators pressing Start in the same second would both pass a check, but
 * only one can win the index.
 *
 * A link with no nest_no returns the per-part quantity unchanged, which is what
 * every order created before nesting existed depends on.
 */
async function claimNest(conn, companyId, task, node, inp, required) {
  const [[link]] = await conn.query(
    // length/width are the PLATE's, as declared in nesting — never the part's.
    // Comparing a part's own size against stock would match the thing being
    // made with the thing it is made from.
    `SELECT nest_no, qty, length, width FROM fab_items
      WHERE company_id = ? AND parent_item_id = ? AND catalog_item_id = ?
        AND flow_id IS NULL AND deleted_at IS NULL
      LIMIT 1`,
    [companyId, node.id, inp.ref_catalog_item_id],
  );

  const nestNo = link?.nest_no ?? null;
  const want = {
    lengthMm: link?.length != null ? Number(link.length) : null,
    widthMm: link?.width != null ? Number(link.width) : null,
  };
  // An un-nested link still carries a declared plate size when the BOQ gave it
  // one, and it should still be honoured — nesting is what names the plate, not
  // what makes the size real.
  if (!nestNo) return { qty: required, nestNo: null, claimId: null, want };

  // On a nested link the quantity describes the PLATE, not the part — the
  // Nesting sheet carries one row per plate, so every link cut from it inherits
  // that same figure. Falling back to `required` keeps a blank column working.
  const qty = link.qty != null && Number(link.qty) > 0 ? Number(link.qty) : required;
  const orderId = task.order_id ?? node.order_id;

  try {
    const [ins] = await conn.query(
      `INSERT INTO fab_nest_issues
         (company_id, order_id, catalog_item_id, nest_no, qty, unit, task_id, item_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [companyId, orderId, inp.ref_catalog_item_id, nestNo, qty, inp.unit ?? null, task.id, node.id],
    );
    return { qty, nestNo, claimId: ins.insertId, want };
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') return null; // already on the floor
    throw err;
  }
}

/**
 * On task START: for the first step, consume gated inputs and open the node's
 * WIP piece; for a later step, move the WIP piece to this machine's area.
 * Throws INSUFFICIENT_STOCK if any input can't be fully consumed.
 *
 * @param {object} task    { id, item_id, seq_no, order_id }
 * @param {object} machine { id, plant_id, stock_location_id, name }
 */
export async function openOrMoveWipOnStart(conn, companyId, task, machine) {
  const node = await getItemNode(conn, companyId, task.item_id);
  if (!node) return;

  const { minSeq } = await stepBounds(conn, companyId, task.item_id);
  const isFirst = minSeq != null && Number(task.seq_no) === Number(minSeq);
  const wipLoc = await ensureMachineWipLocation(conn, companyId, machine);

  if (isFirst) {
    // Consume this step's declared inputs (deduct at start, same-unit qty).
    const [inputs] = await conn.query(
      `SELECT id, input_role, ref_catalog_item_id, producing_item_id, qty
         FROM fab_task_inputs
        WHERE company_id = ? AND task_id = ? AND deleted_at IS NULL`,
      [companyId, task.id],
    );
    for (const inp of inputs) {
      const required = Number(inp.qty) > 0 ? Number(inp.qty) : (Number(node.qty) || 1);
      if (inp.input_role === 'component' && inp.producing_item_id) {
        const child = await getItemNode(conn, companyId, inp.producing_item_id);
        if (child?.catalog_item_id) {
          const ok = await consumeStock(conn, companyId, child.catalog_item_id, required, {
            txnType: 'wip_consume', orderId: task.order_id ?? node.order_id ?? null,
            notes: `consumed by item ${node.id} (task ${task.id})`,
          });
          if (!ok) throw insufficientStock(`Not enough of component item #${inp.producing_item_id} in stock to start this task.`);
        }
      } else if (inp.ref_catalog_item_id) {
        // A nested plate goes to the machine ONCE and everything is cut out of
        // it. Issuing per part would draw the same plate from stock twenty
        // times over. claimNest returns null when this nest has already gone to
        // the floor — the part still starts, it just does not re-issue.
        const nest = await claimNest(conn, companyId, task, node, inp, required);
        if (nest === null) continue;

        const ok = await consumeStock(conn, companyId, inp.ref_catalog_item_id, nest.qty, {
          txnType: 'wip_issue',
          // The size nesting declared for this plate. Only a piece of exactly
          // that size will do — see consumeStock.
          want: nest.want,
          // So the plate this order EARMARKED is the plate it takes.
          orderId: task.order_id ?? node.order_id ?? null,
          notes: nest.nestNo
            ? `issued nest ${nest.nestNo} to item ${node.id} (task ${task.id})`
            : `issued to item ${node.id} (task ${task.id})`,
        });
        if (!ok) {
          // The claim and the stock movement have to stand or fall together, or
          // a shortage would leave the nest marked as issued and every other
          // part on it silently skipping its material.
          if (nest.claimId) {
            await conn.query('DELETE FROM fab_nest_issues WHERE id = ?', [nest.claimId]);
          }
          /**
           * Name the SIZE when one was asked for.
           *
           * "Not enough raw material in stock" sends somebody to look at a
           * shelf that may be full of the same item in the wrong size, and
           * conclude the system is wrong. "No 3000×1500 plate of MSP-16 in
           * stock" is the actual situation and says what to order.
           */
          const size = nest.want && (nest.want.lengthMm != null || nest.want.widthMm != null)
            ? ` at ${nest.want.lengthMm ?? '?'}×${nest.want.widthMm ?? '?'} mm`
            : '';
          throw insufficientStock(
            `Not enough raw material (catalog item #${inp.ref_catalog_item_id})${size} in stock to start this task.`
            + (size ? ' Stock of the same item in other sizes does not count — the nest names this plate.' : ''),
          );
        }
      }
    }

    // FEAT-02: the earmark is now physically consumed. Flip this task's active
    // reservations to 'consumed' so on-hand and reserved drop together (net
    // availability for other tasks is unchanged by the start).

    // Open the single WIP piece for this node (idempotent).
    if (node.catalog_item_id && wipLoc) {
      const [[existing]] = await conn.query(
        `SELECT id FROM fab_stock_pieces
          WHERE company_id = ? AND wip_item_id = ? AND deleted_at IS NULL LIMIT 1`,
        [companyId, node.id],
      );
      if (!existing) {
        const qty = Number(node.qty) || 1;
        await conn.query(
          `INSERT INTO fab_stock_pieces
             (company_id, code, catalog_item_id, plant_id, stock_location_id, qty, uom, status, wip_item_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'wip', ?, ?)`,
          // On the caller's connection: the code is part of the task-start
          // transaction, so a start that fails leaves neither a piece nor a gap.
          [companyId, await generateCode(companyId, 'stock_piece', {}, conn),
           node.catalog_item_id, machine.plant_id, wipLoc, qty, node.unit || null, node.id,
           `WIP order ${node.order_id} item ${node.id}`],
        );
        await writeLedger(conn, companyId, {
          catalogItemId: node.catalog_item_id, plantId: machine.plant_id, stockLocationId: wipLoc,
          txnType: 'wip_open', qty,
        });
      }
    }
    return;
  }

  // Later step — move the existing WIP piece to this machine's area.
  if (!wipLoc) return;
  const [[piece]] = await conn.query(
    `SELECT id, catalog_item_id, qty, stock_location_id FROM fab_stock_pieces
      WHERE company_id = ? AND wip_item_id = ? AND status = 'wip' AND deleted_at IS NULL LIMIT 1`,
    [companyId, node.id],
  );
  if (piece && piece.stock_location_id !== wipLoc) {
    await conn.query(
      `UPDATE fab_stock_pieces SET stock_location_id = ?, plant_id = ? WHERE id = ?`,
      [wipLoc, machine.plant_id, piece.id],
    );
    await writeLedger(conn, companyId, {
      catalogItemId: piece.catalog_item_id, plantId: machine.plant_id, stockLocationId: wipLoc,
      txnType: 'wip_move', qty: Number(piece.qty),
    });
  }
}

/**
 * On task COMPLETE: if this is the node's terminal step, finalize the WIP piece
 * (wip→in_stock, "transform up one BOM level"). A top-level node's output posts
 * to Finished Goods. Idempotent, and self-heals if no WIP piece was opened.
 *
 * FEAT-05: the receipt is booked at the GOOD quantity produced, not blindly at
 * the planned qty. `opts.scrapQty` is written off to a `scrap` ledger txn for
 * traceability. Callers that don't report output (back-compat) receive the whole
 * planned/piece qty as good, preserving the prior 1:1 behaviour.
 *
 * @param {object} task { id, item_id, seq_no, assigned_resource_id }
 * @param {object} [opts] { goodQty?: number, scrapQty?: number }
 */
export async function finalizeWipOnComplete(conn, companyId, task, opts = {}) {
  const node = await getItemNode(conn, companyId, task.item_id);
  if (!node || !node.catalog_item_id) return; // can't produce inventory for an unlinked node

  const { maxSeq } = await stepBounds(conn, companyId, task.item_id);
  if (maxSeq == null || Number(task.seq_no) !== Number(maxSeq)) return; // not the terminal step
  const isTopLevel = node.parent_item_id == null;
  const plannedQty = Number(node.qty) || 1;

  const [[piece]] = await conn.query(
    `SELECT id, catalog_item_id, qty, plant_id, stock_location_id, status FROM fab_stock_pieces
      WHERE company_id = ? AND wip_item_id = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId, node.id],
  );

  // Good units to receive; default = the whole piece/planned qty (back-compat).
  const goodQty = opts.goodQty != null ? Math.max(0, Number(opts.goodQty))
    : (piece ? Number(piece.qty) : plannedQty);
  const scrapQty = opts.scrapQty != null ? Math.max(0, Number(opts.scrapQty)) : 0;

  // Resolve where the finished item should land.
  const plantId = piece?.plant_id ?? (await resolveTaskPlant(conn, companyId, task.assigned_resource_id));
  let targetLoc = piece?.stock_location_id ?? null;
  if (isTopLevel) {
    const fgLoc = await ensureFinishedGoodsLocation(conn, companyId, plantId);
    if (fgLoc) targetLoc = fgLoc;
  }

  // Scrap write-off (traceability) — booked once, on the wip→in_stock transition,
  // against the location the scrap physically sat in.
  const bookScrap = async (scrapLoc) => {
    if (scrapQty > EPS && plantId && scrapLoc) {
      await writeLedger(conn, companyId, {
        catalogItemId: node.catalog_item_id, plantId, stockLocationId: scrapLoc,
        txnType: 'scrap', qty: -scrapQty, notes: `scrap at item ${node.id} (task ${task.id})`,
      });
    }
  };

  if (piece) {
    if (piece.status === 'wip') {
      if (goodQty > EPS) {
        await conn.query(
          `UPDATE fab_stock_pieces SET qty = ?, status = 'in_stock', stock_location_id = ?, plant_id = ? WHERE id = ?`,
          [goodQty, targetLoc ?? piece.stock_location_id, plantId ?? piece.plant_id, piece.id],
        );
        await writeLedger(conn, companyId, {
          catalogItemId: piece.catalog_item_id, plantId: plantId ?? piece.plant_id,
          stockLocationId: targetLoc ?? piece.stock_location_id,
          txnType: isTopLevel ? 'fg_receipt' : 'wip_finalize', qty: goodQty,
        });
      } else {
        // Nothing good produced — write the piece off entirely (no receipt).
        //
        // The write-off is itself ledgered. Only the separately reported
        // scrapQty used to be, so an operator recording "0 good, 0 scrap" made
        // the whole piece vanish from stock with no row anywhere saying where it
        // went — the one case where the ledger and the shelf could disagree
        // without anybody being able to find out why.
        const writtenOff = Number(piece.qty) || 0;
        await conn.query(
          `UPDATE fab_stock_pieces SET qty = 0, status = 'scrapped' WHERE id = ?`,
          [piece.id],
        );
        if (writtenOff > EPS) {
          await writeLedger(conn, companyId, {
            catalogItemId: node.catalog_item_id,
            plantId: piece.plant_id ?? plantId,
            stockLocationId: piece.stock_location_id ?? targetLoc,
            txnType: 'scrap',
            qty: -writtenOff,
            notes: `written off: nothing good produced`,
          });
        }
      }
      await bookScrap(piece.stock_location_id ?? targetLoc);
    }
    // already in_stock → idempotent no-op
    return;
  }

  // No WIP piece was ever opened — still book the produced output as a receipt.
  const loc = isTopLevel
    ? await ensureFinishedGoodsLocation(conn, companyId, plantId)
    : (task.assigned_resource_id ? await ensureMachineWipLocation(conn, companyId, {
        id: task.assigned_resource_id, plant_id: plantId, stock_location_id: null, name: null,
      }) : null);
  if (!loc || !plantId) return;
  if (goodQty > EPS) {
    await conn.query(
      `INSERT INTO fab_stock_pieces
         (company_id, code, catalog_item_id, plant_id, stock_location_id, qty, uom, status, wip_item_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?)`,
      [companyId, await generateCode(companyId, 'stock_piece', {}, conn),
       node.catalog_item_id, plantId, loc, goodQty, node.unit || null, node.id,
       `produced order ${node.order_id} item ${node.id}`],
    );
    await writeLedger(conn, companyId, {
      catalogItemId: node.catalog_item_id, plantId, stockLocationId: loc,
      txnType: isTopLevel ? 'fg_receipt' : 'wip_finalize', qty: goodQty,
    });
  }
  await bookScrap(loc);
}
