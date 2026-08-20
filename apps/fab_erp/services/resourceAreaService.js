/**
 * resourceAreaService.js — reassigning a machine's WORK AREA, and taking its
 * stock with it.
 *
 * THE BUG THIS EXISTS FOR. `fab_resources.stock_location_id` is the area a
 * machine's work-in-process lives in: `openOrMoveWipOnStart` puts the WIP piece
 * there when a task starts on that machine, and moves it to the next machine's
 * area at the next step. Until now the column was edited through the generic
 * `/mutate` endpoint, which does exactly what it is designed to do — write the
 * column — and nothing else. The stock stayed behind. Production is the proof:
 * `Machine - CNC 2 - Cutting WIP` and `Machine - CNC Drilling WIP` are two live
 * areas holding stock that no machine points at any more, and nothing in the
 * ledger records how they got that way, because nothing recorded anything.
 *
 * NOT THE SAME THING AS `machineLocationService`. That one moves the machine's
 * own asset piece (`fab_resources.stock_piece_id`) — where the lump of metal
 * physically stands, including off site. This one moves the WORK that sits at
 * the machine. Two different columns, two different questions, and this service
 * deliberately refuses to touch the other one (see ASSET PIECES below).
 *
 * ── WHAT MOVES ──────────────────────────────────────────────────────────────
 *
 * The hard part is not the move, it is deciding what is the machine's. Most
 * shops pool: locally three machines have their own areas, in production
 * fifteen of eighteen share one "Machines - on site". "Move that machine's
 * stock out of the pool" has no answer at the level of the pool, so the rule
 * depends on whether the area is the machine's alone:
 *
 *   DEDICATED (no other live resource points at it, by
 *     `fab_resources.stock_location_id` or an active `fab_resource_stock_areas`
 *     row) — everything in it is this machine's by construction. Move it all.
 *
 *   SHARED — only pieces this machine can be shown to hold move: a `wip` piece
 *     whose `wip_item_id` resolves to a task on THIS machine. Everything else
 *     stays, and the response names it. Guessing here would mean carrying other
 *     machines' work off to a new area on the strength of it having been in the
 *     same room.
 *
 * ATTRIBUTION, precisely. A WIP piece is held by the machine of the task that
 * put it there, and the thing that put it there is a task START — see
 * `openOrMoveWipOnStart`. So the holder is the item's most recently STARTED
 * task, preferring one that is still `in_progress` when there is one (that is
 * the piece under the tool right now). "Currently in progress" alone is not
 * enough: a piece whose step finished and whose next step has not begun is
 * still physically at that machine, and it is exactly the piece a reassignment
 * needs to carry with it.
 *
 * ASSET PIECES ARE NEVER MOVED — an addition to the proposed rule, and the one
 * place it was genuinely unsafe. A pooled machine area like `MACH-ON` holds
 * every machine's own asset piece. If a resource were pointed at such an area
 * and nothing else pointed at it, the dedicated rule would fire and cheerfully
 * relocate the entire machine fleet as a side effect of one dropdown. So any
 * piece that is some resource's `stock_piece_id` — this machine's included — is
 * skipped and reported. Where a machine physically stands has its own endpoint
 * (`POST /assets/resources/:id/move`) and must stay a deliberate act.
 *
 * NOTHING SILENT. Every piece in the old area comes back in the response, in
 * `moved` or in `skipped` with a reason. A partial move nobody is told about is
 * worse than a refusal, because the refusal is at least visible.
 */

import { pool } from '../../../db.js';
import { movePiece } from './stockMovementService.js';
import { provisionMachineWipLocation } from './wipInventoryService.js';

const httpError = (status, message, code = null) => {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
};

/** Why a piece stayed behind. Grouped in the summary sentence. */
const SKIP_REASONS = {
  machine_asset: 'is a machine asset piece — use the machine\'s own location move',
  other_machine: 'belongs to another machine\'s work in progress',
  not_attributable: 'cannot be attributed to this machine in a shared area',
};

/**
 * Everybody else pointing at an area — the test for "dedicated".
 *
 * Both models are consulted because both are live: `fab_resources
 * .stock_location_id` is the one column the scheduler and `openOrMoveWipOnStart`
 * read, and `fab_resource_stock_areas` is the newer many-areas-per-machine
 * structure `bufferService` reads. An area claimed by either is shared.
 */
async function otherResourcesUsing(conn, companyId, locationId, exceptResourceId) {
  if (!locationId) return [];
  const [rows] = await conn.query(
    `SELECT DISTINCT r.id, r.name, r.code
       FROM fab_resources r
      WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.id <> ?
        AND (
          r.stock_location_id = ?
          OR EXISTS (
            SELECT 1 FROM fab_resource_stock_areas a
             WHERE a.company_id = r.company_id AND a.resource_id = r.id
               AND a.stock_location_id = ? AND a.active = 1 AND a.deleted_at IS NULL
          )
        )
      ORDER BY r.name`,
    [companyId, exceptResourceId, locationId, locationId],
  );
  return rows;
}

/**
 * Live pieces sitting in an area, each tagged with who — if anyone — holds it.
 *
 * `qty > 0 AND deleted_at IS NULL` is the floor: a consumed piece is a row of
 * history, not a thing on a shelf, and moving it would put a fictional
 * departure in the ledger.
 */
async function piecesIn(conn, companyId, locationId) {
  if (!locationId) return [];

  // Lock the rows first, plainly. The enriched read below carries correlated
  // subqueries and `FOR UPDATE` there would take locks on tasks and resources
  // as well, for no benefit.
  await conn.query(
    `SELECT id FROM fab_stock_pieces
      WHERE company_id = ? AND stock_location_id = ? AND qty > 0 AND deleted_at IS NULL
      FOR UPDATE`,
    [companyId, locationId],
  );

  const [rows] = await conn.query(
    `SELECT p.id, p.code, p.qty, p.status, p.wip_item_id AS wipItemId,
            (SELECT ra.id FROM fab_resources ra
              WHERE ra.company_id = p.company_id AND ra.stock_piece_id = p.id
                AND ra.deleted_at IS NULL LIMIT 1)          AS assetOfResourceId,
            (SELECT ra.name FROM fab_resources ra
              WHERE ra.company_id = p.company_id AND ra.stock_piece_id = p.id
                AND ra.deleted_at IS NULL LIMIT 1)          AS assetOfResourceName,
            (SELECT t.assigned_resource_id FROM fab_project_tasks t
              WHERE t.company_id = p.company_id AND t.item_id = p.wip_item_id
                AND t.deleted_at IS NULL AND t.assigned_resource_id IS NOT NULL
                AND t.started_at IS NOT NULL
              ORDER BY (t.status = 'in_progress') DESC, t.started_at DESC,
                       t.seq_no DESC, t.id DESC
              LIMIT 1)                                      AS holderResourceId
       FROM fab_stock_pieces p
      WHERE p.company_id = ? AND p.stock_location_id = ? AND p.qty > 0
        AND p.deleted_at IS NULL
      ORDER BY p.id`,
    [companyId, locationId],
  );
  return rows;
}

/**
 * The machine's WIP link in `fab_resource_stock_areas`, brought into step.
 *
 * WHY THIS IS HERE AT ALL. `fab_resource_stock_areas` is meant to be the
 * canonical machine→area link, but nothing in the codebase has ever WRITTEN it:
 * it was filled once by the catalog-unification backfill on 2026-08-17 and
 * never again. Machine create and edit write only `fab_resources
 * .stock_location_id`. So every machine created since exists in the legacy
 * column alone, and every machine reassigned since has left a link pointing at
 * an area it no longer uses. That is the same defect as the orphaned stock,
 * one table over, and the two together are what produced the production
 * symptom: areas still linked here that no `stock_location_id` points at.
 *
 * ROLE = 'wip'. `fab_resources.stock_location_id` IS the machine's
 * work-in-process area — `openOrMoveWipOnStart` reads it as exactly that — and
 * `wip` is what the 2026-08-17 backfill wrote for the rows it derived from this
 * same column. `role` is free text by design (see init.sql) and stays that way;
 * this only picks one of the values already in use.
 *
 * RETIRING THE OLD LINK MATTERS AS MUCH AS WRITING THE NEW ONE. A link left
 * live goes on marking a dead area as a machine area for ever, which is the bug
 * being fixed. Soft-deleted rather than deleted — `deleted_at` is what the
 * generic query engine filters on, and the history of which machine used which
 * area is worth keeping. `active = 0` is set alongside it because
 * `bufferService.resourceAreas` filters on THAT, and a row that says
 * "deleted but active" is a row two readers disagree about.
 *
 * ONLY `wip` LINKS ARE TOUCHED. A machine's `input`/`output` areas are separate
 * deliberate structure that `stock_location_id` says nothing about; retiring
 * them here would delete configuration on the strength of an unrelated edit.
 *
 * NOTE: machine CREATE still goes through the generic `/mutate`, which writes
 * the column only. Until that path calls this too (it is exported for exactly
 * that), a brand-new machine still has no link until its area is next changed
 * — or until any save re-runs this, which the no-op path below does on purpose.
 *
 * @param {number|null} fromId the area being left, or null when nothing is.
 * @returns {Promise<{retired:number, created:boolean, revived:boolean, kept:boolean}>}
 */
export async function syncResourceAreaLink(conn, companyId, resourceId, { fromId = null, toId, role = 'wip' }) {
  const out = { retired: 0, created: false, revived: false, kept: false };
  if (!toId) return out;

  if (fromId && Number(fromId) !== Number(toId)) {
    const [ret] = await conn.query(
      `UPDATE fab_resource_stock_areas
          SET active = 0, deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND resource_id = ? AND stock_location_id = ?
          AND role = ? AND deleted_at IS NULL`,
      [companyId, resourceId, fromId, role],
    );
    out.retired = ret.affectedRows ?? 0;
  }

  const [[live]] = await conn.query(
    `SELECT id, active FROM fab_resource_stock_areas
      WHERE company_id = ? AND resource_id = ? AND stock_location_id = ? AND role = ?
        AND deleted_at IS NULL LIMIT 1`,
    [companyId, resourceId, toId, role],
  );
  if (live) {
    if (!live.active) {
      await conn.query('UPDATE fab_resource_stock_areas SET active = 1 WHERE id = ?', [live.id]);
      out.revived = true;
    } else {
      out.kept = true;
    }
    return out;
  }

  // Revive a link this machine had to this area before, rather than stacking a
  // second row for the same fact — a machine moved back and forth would
  // otherwise accumulate one row per trip.
  const [[old]] = await conn.query(
    `SELECT id FROM fab_resource_stock_areas
      WHERE company_id = ? AND resource_id = ? AND stock_location_id = ? AND role = ?
      ORDER BY id DESC LIMIT 1`,
    [companyId, resourceId, toId, role],
  );
  if (old) {
    await conn.query(
      `UPDATE fab_resource_stock_areas SET active = 1, deleted_at = NULL WHERE id = ?`,
      [old.id],
    );
    out.revived = true;
    return out;
  }

  await conn.query(
    `INSERT INTO fab_resource_stock_areas
       (company_id, resource_id, stock_location_id, role, active, notes)
     VALUES (?, ?, ?, ?, 1, 'Kept in step with fab_resources.stock_location_id by /resources/:id/area')`,
    [companyId, resourceId, toId, role],
  );
  out.created = true;
  return out;
}

/** Names for holder ids, so the response can say "held by Welder-1". */
async function resourceNames(conn, companyId, ids) {
  const list = [...new Set(ids.filter((n) => Number.isInteger(Number(n)) && Number(n) > 0))];
  if (!list.length) return new Map();
  const [rows] = await conn.query(
    `SELECT id, name FROM fab_resources
      WHERE company_id = ? AND id IN (${list.map(() => '?').join(',')})`,
    [companyId, ...list],
  );
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

/** One readable sentence covering both halves of the outcome. */
function summarise({ resourceName, fromName, toName, ownership, moved, skipped, provisioned }) {
  if (!moved.length && !skipped.length) {
    return `${resourceName} now works out of ${toName}`
      + `${provisioned ? ' (a new area created for it)' : ''}.`
      + `${fromName ? ` ${fromName} held no stock, so nothing moved.` : ''}`;
  }
  const movedPart = moved.length
    ? `Moved ${moved.length} piece${moved.length === 1 ? '' : 's'} from ${fromName} to ${toName}`
    : `Moved nothing out of ${fromName}`;
  if (!skipped.length) return `${movedPart}.`;

  const byReason = new Map();
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  const left = [...byReason.entries()]
    .map(([reason, n]) => `${n} that ${SKIP_REASONS[reason] ?? reason}`)
    .join(', ');
  const because = ownership === 'shared'
    ? ` ${fromName} is shared with other machines, so`
    : '';
  return `${movedPart}.${because} ${skipped.length} piece${skipped.length === 1 ? '' : 's'}`
    + ` stayed in ${fromName}: ${left}.`;
}

/**
 * Reassign a resource's work area, moving what is demonstrably its stock and
 * recording every move in the ledger, in ONE transaction.
 *
 * @param {number}  companyId
 * @param {number}  resourceId
 * @param {object}  opts
 * @param {number}  [opts.toLocationId] target area. Required unless mode is 'dedicated'.
 * @param {'area'|'dedicated'} [opts.mode] 'dedicated' provisions the machine's
 *   own `WIP-M<id>` area and moves it there — the "give this crane its own area"
 *   case. `toLocationId` is ignored when this is set.
 * @param {string|null} [opts.note] appended to every ledger row's notes.
 * @param {string[]|null} [opts.grants] the caller's uiPermissions, or null for
 *   an admin. Moving stock is inventory work and is checked HERE rather than at
 *   the route, because whether any stock moves is only knowable after looking.
 * @param {number|null} [opts.userId]
 */
export async function reassignResourceArea(companyId, resourceId, {
  toLocationId = null, mode = 'area', note = null, grants = null, userId = null,
} = {}) {
  if (!companyId) throw httpError(400, 'Unable to determine the company.');
  const rid = Number(resourceId);
  if (!Number.isInteger(rid) || rid <= 0) throw httpError(400, 'A resource id is required.');
  const dedicated = mode === 'dedicated';
  // `Number(null)` is 0 and `Number.isInteger(0)` is true, so a missing target
  // used to slip through this guard and fail later as "that stock area does not
  // exist" — a 404 about an area nobody named. Check for absence first.
  if (!dedicated && (toLocationId == null || !(Number(toLocationId) > 0)
    || !Number.isInteger(Number(toLocationId)))) {
    throw httpError(400, 'Give either a stock area to move to, or mode "dedicated".');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[resource]] = await conn.query(
      `SELECT id, name, code, plant_id, stock_location_id, stock_piece_id
         FROM fab_resources
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL
        FOR UPDATE`,
      [rid, companyId],
    );
    if (!resource) throw httpError(404, 'That resource does not exist.');

    // ── Resolve the target ────────────────────────────────────────────────
    let targetId = Number(toLocationId);
    let provisioned = false;
    if (dedicated) {
      if (!resource.plant_id) {
        throw httpError(409,
          `${resource.name} has no plant, and a stock area belongs to a plant. `
          + 'Give it a plant first and it can have its own area.');
      }
      const [[before]] = await conn.query(
        `SELECT id FROM fab_stock_locations
          WHERE company_id = ? AND plant_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
        [companyId, resource.plant_id, `WIP-M${resource.id}`.slice(0, 20)],
      );
      targetId = await provisionMachineWipLocation(conn, companyId, resource);
      provisioned = !before;
    }

    const [[to]] = await conn.query(
      `SELECT id, code, name, plant_id FROM fab_stock_locations
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [targetId, companyId],
    );
    if (!to) throw httpError(404, 'That stock area does not exist.');

    const fromId = resource.stock_location_id ?? null;
    const [[from]] = fromId
      ? await conn.query(
        `SELECT id, code, name FROM fab_stock_locations
          WHERE id = ? AND company_id = ? LIMIT 1`, [fromId, companyId])
      : [[null]];

    /**
     * A machine does not change plant through a stock-area dropdown.
     *
     * `movePiece` stamps the target area's plant onto every piece it moves, so
     * accepting a cross-plant area here would leave the machine in one plant
     * and its work in another — findable in one view, invisible in the next.
     * A machine with NO plant adopts the area's, which is the only reading of
     * "company-wide machine put in a specific area" that leaves the two
     * agreeing.
     */
    if (resource.plant_id && to.plant_id && Number(resource.plant_id) !== Number(to.plant_id)) {
      throw httpError(409,
        `${to.name} belongs to a different plant than ${resource.name}. `
        + 'Move the machine to that plant first — changing its work area cannot do it.');
    }

    // ── Already there: a true no-op, not an error ─────────────────────────
    // The edit dialog re-sends every field on every Save, so "no change" is the
    // common case, not a mistake. Writing a ledger pair for it would invent
    // movements that never happened.
    if (fromId && Number(fromId) === Number(to.id)) {
      // Still SYNC THE LINK. A machine created after 2026-08-17 has no row in
      // `fab_resource_stock_areas` at all, because only the one-off backfill
      // ever wrote that table; this is the cheap moment to give it one. Nothing
      // is retired (there is no old area) and a link that already exists is
      // left alone, so re-saving stays a true no-op.
      const link = await syncResourceAreaLink(conn, companyId, rid, { fromId: null, toId: to.id });
      await conn.commit();
      return {
        ok: true, changed: false, provisioned,
        resource: { id: resource.id, name: resource.name, code: resource.code },
        from: from ? { id: from.id, code: from.code, name: from.name } : null,
        to: { id: to.id, code: to.code, name: to.name },
        areaOwnership: 'unchanged',
        sharedWith: [], moved: [], skipped: [], moveRefs: [],
        movedCount: 0, movedQty: 0, skippedCount: 0, skippedQty: 0,
        link,
        message: `${resource.name} already works out of ${to.name}. Nothing moved.`
          + (link.created || link.revived ? ' Its area link was missing and has been recorded.' : ''),
      };
    }

    // ── Dedicated or shared? ──────────────────────────────────────────────
    const sharedWith = await otherResourcesUsing(conn, companyId, fromId, rid);
    const candidates = await piecesIn(conn, companyId, fromId);
    const ownership = !fromId
      ? 'none'
      : (sharedWith.length ? 'shared' : (candidates.length ? 'dedicated' : 'empty'));

    // ── Split them ────────────────────────────────────────────────────────
    const movers = [];
    const skipped = [];
    for (const p of candidates) {
      if (p.assetOfResourceId) {
        skipped.push({ ...p, reason: 'machine_asset' });
        continue;
      }
      if (ownership === 'dedicated') { movers.push(p); continue; }
      // Shared: only what this machine can be shown to hold.
      if (p.status === 'wip' && Number(p.holderResourceId) === rid) { movers.push(p); continue; }
      skipped.push({
        ...p,
        reason: p.status === 'wip' && p.holderResourceId ? 'other_machine' : 'not_attributable',
      });
    }

    /**
     * The inventory permission is checked against what will ACTUALLY move.
     *
     * Requiring it unconditionally would 403 somebody with every right to edit
     * a machine for pointing it at an empty area; not requiring it at all would
     * let the resources permission move stock, which is what the inventory
     * permission exists to gate. So: `fab_erp_resources_manage` gets you the
     * reassignment (the route enforces that), and the moment real pieces are
     * involved `fab_erp_inventory_manage` is required too — checked before any
     * write, so a refusal leaves nothing half-done.
     */
    if (movers.length && grants && !grants.includes('fab_erp_inventory_manage')) {
      throw httpError(403,
        `${from?.name ?? 'That area'} holds ${movers.length} piece`
        + `${movers.length === 1 ? '' : 's'} that would move with ${resource.name}. `
        + 'Moving stock needs the "fab_erp_inventory_manage" permission.',
        'PERMISSION_REQUIRED');
    }

    // ── Move ──────────────────────────────────────────────────────────────
    const moved = [];
    const moveRefs = [];
    for (const p of movers) {
      const res = await movePiece(conn, companyId, {
        pieceId: p.id,
        toLocationId: to.id,
        reason: 'machine',
        notes: `${resource.name} (resource #${rid}) reassigned from `
          + `${from?.name ?? 'unknown'} to ${to.name}; its stock followed`
          + `${note ? ` — ${note}` : ''}`,
      });
      moveRefs.push(res.moveRef);
      moved.push({
        pieceId: p.id, pieceCode: res.pieceCode ?? p.code,
        qty: Number(p.qty), status: p.status, moveRef: res.moveRef,
      });
    }

    // ── Repoint the resource ──────────────────────────────────────────────
    await conn.query(
      `UPDATE fab_resources SET stock_location_id = ?${resource.plant_id ? '' : ', plant_id = ?'}
        WHERE id = ? AND company_id = ?`,
      resource.plant_id
        ? [to.id, rid, companyId]
        : [to.id, to.plant_id, rid, companyId],
    );

    // And the canonical link table, in the same transaction. See
    // syncResourceAreaLink for why this is the endpoint's job.
    const link = await syncResourceAreaLink(conn, companyId, rid, { fromId, toId: to.id });

    // Read the names BEFORE committing: a failure here must still roll back,
    // and after a commit there would be nothing left to roll back to.
    const holderNames = await resourceNames(conn, companyId, skipped.map((s) => s.holderResourceId));

    await conn.commit();

    const sum = (rows) => rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);

    return {
      ok: true,
      changed: true,
      provisioned,
      resource: { id: resource.id, name: resource.name, code: resource.code },
      from: from ? { id: from.id, code: from.code, name: from.name } : null,
      to: { id: to.id, code: to.code, name: to.name },
      /** 'dedicated' | 'shared' | 'empty' | 'none' — why the split came out as it did. */
      areaOwnership: ownership,
      sharedWith: sharedWith.map((r) => ({ id: r.id, name: r.name, code: r.code })),
      moved,
      moveRefs,
      movedCount: moved.length,
      movedQty: sum(moved),
      skipped: skipped.map((s) => ({
        pieceId: s.id, pieceCode: s.code, qty: Number(s.qty), status: s.status,
        reason: s.reason,
        reasonText: SKIP_REASONS[s.reason] ?? s.reason,
        heldBy: s.reason === 'machine_asset'
          ? (s.assetOfResourceName ?? null)
          : (holderNames.get(Number(s.holderResourceId)) ?? null),
      })),
      skippedCount: skipped.length,
      skippedQty: sum(skipped),
      /** What happened to the `fab_resource_stock_areas` link: {retired, created, revived, kept}. */
      link,
      userId,
      message: summarise({
        resourceName: resource.name,
        fromName: from?.name ?? null,
        toName: to.name,
        ownership, moved, skipped, provisioned,
      }),
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * What WOULD happen, without doing it — same split, no writes.
 *
 * The dialog can then warn before somebody saves, which is the difference
 * between a considered move and a discovered one.
 */
export async function previewResourceArea(companyId, resourceId) {
  const [[resource]] = await pool.query(
    `SELECT id, name, code, plant_id, stock_location_id FROM fab_resources
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [Number(resourceId), companyId],
  );
  if (!resource) throw httpError(404, 'That resource does not exist.');

  const fromId = resource.stock_location_id ?? null;
  const conn = await pool.getConnection();
  try {
    const sharedWith = await otherResourcesUsing(conn, companyId, fromId, Number(resourceId));
    const [pieces] = fromId
      ? await conn.query(
        `SELECT id, code, qty, status FROM fab_stock_pieces
          WHERE company_id = ? AND stock_location_id = ? AND qty > 0 AND deleted_at IS NULL`,
        [companyId, fromId])
      : [[]];
    return {
      resourceId: resource.id,
      currentLocationId: fromId,
      areaOwnership: !fromId ? 'none' : (sharedWith.length ? 'shared' : (pieces.length ? 'dedicated' : 'empty')),
      sharedWith: sharedWith.map((r) => ({ id: r.id, name: r.name, code: r.code })),
      pieceCount: pieces.length,
    };
  } finally {
    conn.release();
  }
}
