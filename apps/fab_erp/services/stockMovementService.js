/**
 * stockMovementService.js — the one place a physical thing changes location.
 *
 * Asked for on 2026-08-17: "let's maintain ledger entry whenever something
 * moves — from one stock area to another, either through an operation like a
 * crane operation or just a machine being carried from one place to another.
 * These ledger entries would be very valuable later."
 *
 * They are valuable only if they are COMPLETE, which is the whole argument for
 * this being one function rather than an INSERT at each call site. Production
 * had exactly three ledger transaction types — grn_receipt, wip_issue and
 * wip_open — so stock arriving was recorded and stock moving was not. The one
 * mover that did write a ledger pair (machineLocationService) recorded
 * `batch_code = 'MACHINE'` and no piece reference, so the row said a machine
 * TYPE had moved without saying which machine.
 *
 * THE SHAPE OF A MOVE. `fab_stock_ledger` carries a single `stock_location_id`
 * and every row means "this much, in this place". A move is therefore two rows
 * — `-qty` leaving, `+qty` arriving — which keeps "what is in this area" a
 * plain SUM with no special case. Both rows share a `move_ref`, which is what
 * makes them recoverable as ONE event later; `from_location_id` /
 * `to_location_id` are stamped on both halves so a single row is readable
 * without having to find its partner.
 *
 * EVERY ROW CARRIES THE PIECE'S CODE. Denormalised on purpose — see init.sql.
 * A ledger is history, and history must not change when a piece is later
 * consumed, renumbered or deleted.
 *
 * IT REFUSES RATHER THAN GUESSES. Same rule wipInventoryService already
 * established: if the move cannot be recorded properly, the move does not
 * happen. Silently skipping the ledger is how stock leaves a building with no
 * record of leaving, and that is strictly worse than an error someone has to
 * deal with.
 */

import { ensurePieceCode } from './stockCodeService.js';

/**
 * Reasons a thing moves. Free text would drift into a dozen spellings of the
 * same event, and these are what the later analysis will group by.
 */
export const MOVE_REASONS = {
  /** Carried/craned between areas by a person, no operation behind it. */
  manual: 'transfer',
  /** A crane or transport OPERATION moved it as part of the routing. */
  operation: 'transfer_op',
  /** Work in progress advancing to the next machine's WIP area. */
  wip_advance: 'wip_move',
  /** A machine relocated, including off-site (which stays schedulable). */
  machine: 'machine_move',
};

const newMoveRef = () =>
  `mv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Move one stock piece from one area to another, recording the pair.
 *
 * Updates the piece's `stock_location_id` (and `plant_id`, since an area
 * belongs to a plant and leaving them disagreeing is how a piece ends up
 * findable in one view and invisible in another) and writes both ledger halves.
 *
 * @param {object} conn REQUIRED — an open transaction. The piece update and
 *   both ledger rows must land together or not at all.
 * @param {object} opts
 * @param {number} opts.pieceId
 * @param {number} opts.toLocationId
 * @param {string} [opts.reason] one of MOVE_REASONS' keys
 * @param {number|null} [opts.taskId] the task that caused it, when there is one
 * @param {string|null} [opts.notes] human sentence, shown in the ledger
 * @returns {Promise<{moveRef, pieceCode, fromLocationId, toLocationId, qty}>}
 */
export async function movePiece(conn, companyId, {
  pieceId, toLocationId, reason = 'manual', taskId = null, notes = null,
}) {
  if (!conn) throw new Error('movePiece requires a transaction.');

  const [[piece]] = await conn.query(
    `SELECT p.id, p.code, p.qty, p.uom, p.catalog_item_id AS catalogItemId,
            p.stock_location_id AS fromId, p.plant_id AS plantId,
            p.wip_item_id AS wipItemId
       FROM fab_stock_pieces p
      WHERE p.id = ? AND p.company_id = ? AND p.deleted_at IS NULL LIMIT 1`,
    [pieceId, companyId],
  );
  if (!piece) {
    const e = new Error(`Stock piece ${pieceId} does not exist.`);
    e.status = 404;
    throw e;
  }
  if (Number(piece.fromId) === Number(toLocationId)) {
    const e = new Error('That piece is already in this stock area.');
    e.status = 409;
    throw e;
  }

  const [[to]] = await conn.query(
    `SELECT id, name, plant_id AS plantId FROM fab_stock_locations
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [toLocationId, companyId],
  );
  if (!to) {
    const e = new Error('That stock area does not exist.');
    e.status = 404;
    throw e;
  }

  const [[from]] = await conn.query(
    `SELECT id, name FROM fab_stock_locations WHERE id = ? AND company_id = ? LIMIT 1`,
    [piece.fromId, companyId],
  );

  // Self-healing: a piece created by a migration has no code until something
  // needs to name it, and a ledger row is exactly that moment.
  const pieceCode = await ensurePieceCode(conn, companyId, pieceId);

  const plantId = to.plantId ?? piece.plantId;
  if (!plantId) {
    const e = new Error(
      `Cannot move piece ${pieceCode ?? pieceId}: neither the piece nor `
      + `${to.name} belongs to a plant. Refusing to move stock untracked.`,
    );
    e.code = 'LEDGER_INCOMPLETE';
    throw e;
  }

  await conn.query(
    `UPDATE fab_stock_pieces SET stock_location_id = ?, plant_id = ?
      WHERE id = ? AND company_id = ?`,
    [to.id, plantId, pieceId, companyId],
  );

  const txnType = MOVE_REASONS[reason] ?? MOVE_REASONS.manual;
  const moveRef = newMoveRef();
  const qty = Number(piece.qty) || 1;
  const label = notes
    ?? `moved ${pieceCode ?? `piece ${pieceId}`} from ${from?.name ?? 'unknown'} to ${to.name}`;

  // Two halves, same move_ref. The leaving row is written against the area it
  // left, which is why from/to are stamped on both — a row read on its own
  // still says where the thing went.
  for (const [locId, signedQty] of [[piece.fromId, -qty], [to.id, qty]]) {
    if (!locId) continue;
    await conn.query(
      `INSERT INTO fab_stock_ledger
         (company_id, catalog_item_id, plant_id, stock_location_id, batch_id,
          piece_id, piece_code, move_ref, from_location_id, to_location_id,
          txn_type, qty, txn_date, notes)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?)`,
      [companyId, piece.catalogItemId, plantId, locId,
        pieceId, pieceCode, moveRef, piece.fromId ?? null, to.id,
        txnType, signedQty, taskId ? `${label} (task ${taskId})` : label],
    );
  }

  return {
    moveRef,
    pieceCode,
    fromLocationId: piece.fromId ?? null,
    fromName: from?.name ?? null,
    toLocationId: to.id,
    toName: to.name,
    qty,
    txnType,
  };
}

/**
 * Both halves of a recorded move, newest first.
 *
 * The reason `move_ref` exists: without it these two rows are just a decrement
 * and an increment that happen to share a date.
 */
export async function moveHistory(conn, companyId, { pieceId = null, limit = 100 } = {}) {
  const [rows] = await conn.query(
    `SELECT g.move_ref AS moveRef, g.piece_id AS pieceId, g.piece_code AS pieceCode,
            g.txn_type AS txnType, g.qty, g.txn_date AS txnDate, g.notes,
            g.from_location_id AS fromId, g.to_location_id AS toId,
            lf.name AS fromName, lt.name AS toName
       FROM fab_stock_ledger g
       LEFT JOIN fab_stock_locations lf ON lf.id = g.from_location_id
       LEFT JOIN fab_stock_locations lt ON lt.id = g.to_location_id
      WHERE g.company_id = ? AND g.deleted_at IS NULL AND g.move_ref IS NOT NULL
        ${pieceId ? 'AND g.piece_id = ?' : ''}
        AND g.qty > 0
      ORDER BY g.id DESC
      LIMIT ?`,
    pieceId ? [companyId, pieceId, limit] : [companyId, limit],
  );
  return rows;
}
