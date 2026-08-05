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
 *   - At the TERMINAL operation's completion the WIP piece is finalized
 *     (wip→in_stock), i.e. it "changes to the next BOM level". A top-level node's
 *     finished piece posts to a Finished-Goods location; sub-assemblies stay in
 *     their terminal machine's area for the parent node to pull.
 *
 * Every movement also appends an audit row to fab_stock_ledger. All functions
 * take an explicit connection so they run inside the task-lifecycle transaction.
 */

import { generateCode } from './codegenService.js';

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
async function consumeStock(conn, companyId, catalogItemId, required, { txnType, notes }) {
  if (!(required > 0)) return true;
  const [pieces] = await conn.query(
    `SELECT id, qty, plant_id, stock_location_id, batch_no FROM fab_stock_pieces
      WHERE company_id = ? AND catalog_item_id = ? AND status = 'in_stock'
        AND deleted_at IS NULL AND qty > 0
      ORDER BY (received_date IS NULL), received_date ASC, id ASC
      FOR UPDATE`,
    [companyId, catalogItemId],
  );
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
    remaining -= take;
  }
  return remaining <= EPS;
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
            txnType: 'wip_consume', notes: `consumed by item ${node.id} (task ${task.id})`,
          });
          if (!ok) throw insufficientStock(`Not enough of component item #${inp.producing_item_id} in stock to start this task.`);
        }
      } else if (inp.ref_catalog_item_id) {
        const ok = await consumeStock(conn, companyId, inp.ref_catalog_item_id, required, {
          txnType: 'wip_issue', notes: `issued to item ${node.id} (task ${task.id})`,
        });
        if (!ok) throw insufficientStock(`Not enough raw material (catalog item #${inp.ref_catalog_item_id}) in stock to start this task.`);
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
