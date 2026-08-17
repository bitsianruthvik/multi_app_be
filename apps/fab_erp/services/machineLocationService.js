/**
 * machineLocationService.js — where a machine physically is, and moving it.
 *
 * A machine is a stock piece (Phase 8), so "where is it" is an ordinary stock
 * question and moving it is an ordinary transfer with a ledger row behind it.
 * Before this, a machine taken off site was a fact that lived in somebody's
 * head: nothing recorded it, so nothing could report it and nothing could be
 * asked about it afterwards.
 *
 * MOVING A MACHINE DOES NOT STOP IT BEING SCHEDULED — decided 2026-08-16.
 * Off-site work is real work, and a machine at a job site is still doing the
 * company's work. This records WHERE a machine is, not WHETHER it may be used.
 * The thing that stops a machine being scheduled is its state (`down`, via
 * maintenance or a breakdown), which is a different question with its own
 * mechanism, and conflating the two would mean sending a machine to a customer
 * site silently cancelled its work.
 */

import { pool } from '../../../db.js';
import { movePiece } from './stockMovementService.js';

/** Stock areas a machine can be moved between, for one plant. */
export async function machineLocations(companyId, plantId = null) {
  const [rows] = await pool.query(
    `SELECT l.id, l.code, l.name, l.plant_id AS plantId, p.name AS plantName
       FROM fab_stock_locations l
       LEFT JOIN fab_plants p ON p.id = l.plant_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL
        ${plantId ? 'AND l.plant_id = ?' : ''}
      ORDER BY (l.code NOT LIKE 'MACH-%'), l.plant_id, l.code`,
    plantId ? [companyId, plantId] : [companyId],
  );
  return rows;
}

/** Where one machine is now, with its whole movement history. */
export async function machineLocation(companyId, resourceId) {
  const [[r]] = await pool.query(
    `SELECT r.id, r.name, r.code, r.plant_id AS plantId, r.stock_piece_id AS pieceId,
            p.stock_location_id AS locationId, p.serial_no AS serialNo,
            l.code AS locationCode, l.name AS locationName,
            pl.name AS plantName
       FROM fab_resources r
       LEFT JOIN fab_stock_pieces p ON p.id = r.stock_piece_id AND p.deleted_at IS NULL
       LEFT JOIN fab_stock_locations l ON l.id = p.stock_location_id
       LEFT JOIN fab_plants pl ON pl.id = r.plant_id
      WHERE r.id = ? AND r.company_id = ? AND r.deleted_at IS NULL LIMIT 1`,
    [resourceId, companyId],
  );
  if (!r) { const e = new Error('Machine not found.'); e.status = 404; throw e; }

  // The ledger is the history. A transfer writes one row out and one row in, so
  // reading it back in order IS the movement log — there is no second table
  // recording the same thing differently.
  const history = r.pieceId
    ? (await pool.query(
        `SELECT g.id, g.txn_type AS txnType, g.qty, g.txn_date AS txnDate, g.notes,
                l.code AS locationCode, l.name AS locationName
           FROM fab_stock_ledger g
           LEFT JOIN fab_stock_locations l ON l.id = g.stock_location_id
          WHERE g.company_id = ? AND g.catalog_item_id = (
                  SELECT catalog_item_id FROM fab_stock_pieces WHERE id = ?)
            AND g.notes LIKE ?
          ORDER BY g.id DESC LIMIT 50`,
        [companyId, r.pieceId, `%resource #${resourceId}%`],
      ))[0]
    : [];

  return {
    resourceId: r.id, name: r.name, code: r.code,
    pieceId: r.pieceId, serialNo: r.serialNo,
    locationId: r.locationId ?? null,
    locationCode: r.locationCode ?? null,
    locationName: r.locationName ?? null,
    plantName: r.plantName ?? null,
    /** True when the machine is in an off-site area. It is still schedulable. */
    offSite: r.locationCode === 'MACH-OFF',
    history,
  };
}

/**
 * Move a machine to another stock area.
 *
 * Written as a transfer PAIR in the ledger — one row leaving the old area and
 * one arriving in the new — rather than a single "moved" row. A single row
 * cannot be summed: stock on hand per location is derived by adding the ledger
 * up, and a move that only ever adds would show the machine in both places.
 */
export async function moveMachine(companyId, resourceId, toLocationId, { note = null, userId = null } = {}) {
  if (!toLocationId) throw new Error('Where should it move to?');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[r]] = await conn.query(
      `SELECT r.id, r.name, r.stock_piece_id AS pieceId, p.stock_location_id AS fromId,
              p.catalog_item_id AS catalogItemId, p.plant_id AS plantId
         FROM fab_resources r
         LEFT JOIN fab_stock_pieces p ON p.id = r.stock_piece_id AND p.deleted_at IS NULL
        WHERE r.id = ? AND r.company_id = ? AND r.deleted_at IS NULL LIMIT 1`,
      [resourceId, companyId],
    );
    if (!r) { const e = new Error('Machine not found.'); e.status = 404; throw e; }
    if (!r.pieceId) {
      // A machine with no piece has no location to move FROM. That happens when
      // its resource carries no plant — saying so beats inventing a start point.
      const e = new Error(
        `${r.name} is not tracked as a physical asset yet, so it has no location to move from. `
        + 'Give its resource a plant and it will be registered automatically.',
      );
      e.status = 409;
      throw e;
    }

    const [[to]] = await conn.query(
      `SELECT id, code, name, plant_id AS plantId FROM fab_stock_locations
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [toLocationId, companyId],
    );
    if (!to) { const e = new Error('That stock area does not exist.'); e.status = 404; throw e; }
    if (Number(to.id) === Number(r.fromId)) {
      const e = new Error(`${r.name} is already in ${to.name}.`);
      e.status = 409;
      throw e;
    }

    const [[from]] = await conn.query(
      `SELECT id, code, name FROM fab_stock_locations WHERE id = ? AND company_id = ? LIMIT 1`,
      [r.fromId, companyId],
    );

    /**
     * The move itself goes through stockMovementService (2026-08-17).
     *
     * This used to update the piece and hand-write the ledger pair here, with
     * `batch_code = 'MACHINE'` and no piece reference — so the ledger recorded
     * that a machine TYPE had moved without recording WHICH machine, which is
     * most of the value of having recorded it. Going through the shared mover
     * gets the piece's code, a `move_ref` tying the two halves together, and
     * from/to on both rows, identical to every other kind of movement.
     */
    const move = await movePiece(conn, companyId, {
      pieceId: r.pieceId,
      toLocationId: to.id,
      reason: 'machine',
      notes: `moved ${r.name} (resource #${resourceId}) `
        + `from ${from?.name ?? 'unknown'} to ${to.name}${note ? ` — ${note}` : ''}`,
    });

    await conn.commit();
    return {
      resourceId: Number(resourceId),
      from: from ? { id: from.id, code: from.code, name: from.name } : null,
      to: { id: to.id, code: to.code, name: to.name },
      offSite: to.code === 'MACH-OFF',
      /** Stated back, because it is the thing people expect to change and it does not. */
      stillSchedulable: true,
      moveRef: move.moveRef,
      machineCode: move.pieceCode,
      userId,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
