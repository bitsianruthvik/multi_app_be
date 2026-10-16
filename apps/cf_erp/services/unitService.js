/**
 * unitService.js — one record per piece of an item tracked 'individual'
 * (init.sql §67, cf_stock_units). The user, 2026-10-16: "individual items = a
 * record PER PIECE. Never add tracking an item doesn't ask for."
 *
 * A tracker node's lot (cf_stock_batches.production_item_id) holds `quantity`
 * pieces; each is a unit with a serial in its lot and the piece code the lock
 * gave its node. UNITS FOLLOW THE LEDGER: every movement that touches a lot of
 * an individual item calls syncUnits, which makes the lot's live units in each
 * area equal its balance there —
 *   a balance that moved to another area   the same units move (finished at a
 *                                          dispatch or storage shelf)
 *   a balance that left stock               units leave, with the reason the
 *                                          caller gives (joined into their parent
 *                                          piece, split, scrapped, dispatched,
 *                                          returned, undone)
 *   a balance that (re)appeared             the units that left last come back
 *                                          (an undo, a dismantle, a reversal) —
 *                                          the SAME records — else new ones are
 *                                          made (a cut, a join, a piece made again)
 * So join / split / cut / complete / dispatch / scrap move units with the
 * quantity, and an undo gives the same pieces back. Fixed queries per movement:
 * three reads, then at most one update, one insert (+ one read back) and one
 * insert of events.
 *
 * LIVE = in_process (in a WIP area) or finished (on a storage / dispatch
 * shelf). Everything else is history. checkUnits says where live units and
 * balances disagree (none is the normal answer).
 */
import { notFound } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { wantsPage, pageArgs, pageOf, countsBy } from '../lib/listing.js';

export const LIVE = ['in_process', 'finished'];
export const UNIT_STATUSES = ['in_process', 'finished', 'joined', 'split', 'dispatched', 'scrapped', 'returned', 'undone'];
const EPS = 1e-6;
const statusIn = (purpose) => (purpose === 'wip' ? 'in_process' : purpose === 'scrap' ? 'scrapped' : 'finished');
const blank = (v) => v == null || String(v).trim() === '';

/** The default reason pieces leave stock, by movement type. */
const LEAVE_BY_TYPE = { issue: 'dispatched', scrap: 'scrapped', return: 'returned', adjustment: 'scrapped', transform: 'joined' };

/**
 * Makes the units of the lots a movement touched agree with their balances.
 * opts: {
 *   movementId, movementType ('transform' | a postMovement type),
 *   batchIds   every lot the movement touched (others are ignored),
 *   reason     why pieces that leave stock leave: a string, or Map batchId -> string
 *   parentLot  Map childBatchId -> parentBatchId (a join: each leaving piece goes INSIDE a piece of the parent)
 *   fresh      Set of batch ids whose new pieces are MADE AGAIN (never the old records), each replacing a scrapped one
 *   restore    which kind of piece that left comes back first (a string, or Map batchId -> string), e.g. 'scrapped'
 * }
 */
export async function syncUnits(db, c, opts = {}) {
  const ids = [...new Set((opts.batchIds ?? []).filter((x) => x != null).map(Number))];
  if (!ids.length) return { made: 0, moved: 0, left: 0, back: 0 };
  const [lots] = await db.query(
    `SELECT b.id, b.item_id, b.code, b.owner_party_id, b.production_item_id, pi.code AS piece_code, pi.order_piece_id, pi.quantity AS node_qty
       FROM cf_stock_batches b
       JOIN cf_item_details i ON i.company_id = b.company_id AND i.master_id = b.item_id AND i.tracked_by = 'individual'
       LEFT JOIN cf_production_items pi ON pi.id = b.production_item_id
      WHERE b.company_id = ? AND b.id IN (?)`,
    [c.companyId, ids],
  );
  if (!lots.length) return { made: 0, moved: 0, left: 0, back: 0 };
  const lotIds = lots.map((l) => l.id);
  const [[bals], [units]] = await Promise.all([
    db.query(
      `SELECT k.batch_id, k.stocking_area_id, k.quantity, a.purpose FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
        WHERE k.company_id = ? AND k.batch_id IN (?) AND k.quantity > 0`, [c.companyId, lotIds]),
    db.query('SELECT * FROM cf_stock_units WHERE company_id = ? AND batch_id IN (?) AND deleted_at IS NULL ORDER BY batch_id, serial FOR UPDATE', [c.companyId, lotIds]),
  ]);
  const reasonOf = (batchId) => (opts.reason instanceof Map ? opts.reason.get(batchId) : opts.reason) ?? LEAVE_BY_TYPE[opts.movementType] ?? 'joined';
  const changes = new Map();             // unit id -> { unit, area, status, parent, event, from }
  const created = [];                    // { lot, serial, area, status, replaces }
  const leaving = [];                    // { unit, lot }
  const purposeOf = new Map(bals.map((b) => [b.stocking_area_id, b.purpose]));
  const byLot = new Map(lotIds.map((id) => [id, []]));
  for (const u of units) byLot.get(u.batch_id)?.push(u);

  for (const lot of lots) {
    const mine = byLot.get(lot.id) ?? [];
    const target = new Map();
    for (const b of bals.filter((x) => x.batch_id === lot.id)) target.set(b.stocking_area_id, Math.floor(Number(b.quantity) + EPS));
    const live = mine.filter((u) => LIVE.includes(u.status) && u.stocking_area_id != null);
    const liveBy = new Map();
    for (const u of live) {
      if (!liveBy.has(u.stocking_area_id)) liveBy.set(u.stocking_area_id, []);
      liveBy.get(u.stocking_area_id).push(u);
    }
    // Surplus (highest serial first) and deficit per area.
    const pool = [];
    for (const [areaId, list] of liveBy) {
      const extra = list.length - (target.get(areaId) ?? 0);
      if (extra > 0) pool.push(...[...list].sort((a, b) => b.serial - a.serial).slice(0, extra));
    }
    const deficits = [...target.entries()].map(([areaId, n]) => ({ areaId, need: n - (liveBy.get(areaId)?.length ?? 0) })).filter((d) => d.need > 0);
    // Moves: surplus somewhere goes where it is missing (lowest serial first, so pieces keep their order).
    pool.sort((a, b) => a.serial - b.serial);
    for (const d of deficits) {
      while (d.need > 0 && pool.length) {
        const u = pool.shift();
        const status = statusIn(purposeOf.get(d.areaId));
        changes.set(u.id, { unit: u, area: d.areaId, status, parent: null, event: status === 'finished' && u.status !== 'finished' ? 'finished' : 'moved', from: u.stocking_area_id });
        d.need -= 1;
      }
    }
    // Still missing: the pieces that left last come back, unless these are made again.
    const isFresh = opts.fresh?.has?.(lot.id);
    // Which pieces come back first: the kind the caller names (an undone scrap brings back the scrapped
    // ones), else the latest to leave — a scrapped piece only when nothing else is there to come back.
    const prefer = (opts.restore instanceof Map ? opts.restore.get(lot.id) : opts.restore) ?? null;
    const rank = (u) => (prefer && u.status === prefer ? 0 : u.status === 'scrapped' ? 2 : 1);
    const gone = mine.filter((u) => !LIVE.includes(u.status) || u.stocking_area_id == null)
      .filter((u) => !changes.has(u.id))
      .sort((a, b) => (rank(a) - rank(b)) || (Number(b.last_movement_id ?? 0) - Number(a.last_movement_id ?? 0)) || (b.serial - a.serial));
    const replaceable = mine.filter((u) => u.status === 'scrapped' && !mine.some((x) => x.replaces_unit_id === u.id)).sort((a, b) => a.serial - b.serial);
    let nextSerial = mine.reduce((m, u) => Math.max(m, u.serial), 0) + 1;
    for (const d of deficits) {
      while (d.need > 0) {
        const status = statusIn(purposeOf.get(d.areaId));
        if (!isFresh && gone.length) {
          const u = gone.shift();
          changes.set(u.id, { unit: u, area: d.areaId, status, parent: null, event: 'back', from: null });
        } else {
          created.push({ lot, serial: nextSerial, area: d.areaId, status, replaces: isFresh ? (replaceable.shift()?.id ?? null) : null });
          nextSerial += 1;
        }
        d.need -= 1;
      }
    }
    for (const u of pool) leaving.push({ unit: u, lot });
  }

  // New pieces first (one insert, one read back): a parent made in this same movement is there to go inside.
  let made = [];
  if (created.length) {
    await insertRows(db, 'cf_stock_units',
      ['company_id', 'item_id', 'batch_id', 'production_item_id', 'order_piece_id', 'piece_code', 'serial', 'unit_code', 'stocking_area_id', 'status', 'owner_party_id', 'replaces_unit_id', 'last_movement_id', 'created_by'],
      created.map((x) => {
        const code = x.lot.piece_code ?? x.lot.code;
        return [c.companyId, x.lot.item_id, x.lot.id, x.lot.production_item_id, x.lot.order_piece_id ?? null, x.lot.piece_code ?? null, x.serial,
          Number(x.lot.node_qty ?? 1) > 1 || x.serial > 1 ? `${code}#${x.serial}` : code, x.area, x.status, x.lot.owner_party_id ?? null, x.replaces, opts.movementId ?? null, c.userId ?? null];
      }), 500);
    const [rows] = await db.query(
      `SELECT id, batch_id, serial, stocking_area_id, status, replaces_unit_id FROM cf_stock_units WHERE company_id = ? AND batch_id IN (?) AND last_movement_id <=> ? AND deleted_at IS NULL`,
      [c.companyId, [...new Set(created.map((x) => x.lot.id))], opts.movementId ?? null],
    );
    const want = new Set(created.map((x) => `${x.lot.id}:${x.serial}`));
    made = rows.filter((r) => want.has(`${r.batch_id}:${r.serial}`));
  }

  // Leaving pieces: why, and — for a join — the piece of the parent they go inside.
  const parentLive = new Map();
  const liveAfter = (batchId) => {
    if (parentLive.has(batchId)) return parentLive.get(batchId);
    const list = [
      ...units.filter((u) => u.batch_id === batchId && ((LIVE.includes(u.status) && u.stocking_area_id != null && !changes.has(u.id)) || (changes.has(u.id) && LIVE.includes(changes.get(u.id).status)))),
      ...made.filter((r) => r.batch_id === batchId && LIVE.includes(r.status)),
    ].sort((a, b) => a.serial - b.serial);
    parentLive.set(batchId, list);
    return list;
  };
  const byLeavingLot = new Map();
  for (const x of leaving) {
    if (!byLeavingLot.has(x.lot.id)) byLeavingLot.set(x.lot.id, []);
    byLeavingLot.get(x.lot.id).push(x.unit);
  }
  for (const [lotId, list] of byLeavingLot) {
    const reason = reasonOf(lotId);
    const parentBatch = opts.parentLot?.get?.(lotId) ?? null;
    const parents = reason === 'joined' && parentBatch ? liveAfter(parentBatch) : [];
    list.sort((a, b) => a.serial - b.serial);
    list.forEach((u, i) => {
      const parent = parents.length ? parents[Math.min(parents.length - 1, Math.floor((i * parents.length) / list.length))].id : null;
      changes.set(u.id, { unit: u, area: null, status: reason, parent, event: reason, from: u.stocking_area_id });
    });
  }

  // Writes: one update, one insert of events.
  const owners = new Map(lots.map((l) => [l.id, l.owner_party_id ?? null]));
  const ch = [...changes.values()];
  if (ch.length) {
    for (let i = 0; i < ch.length; i += 500) {
      const part = ch.slice(i, i + 500);
      const when = (f) => part.flatMap((x) => [x.unit.id, f(x)]);
      await db.query(
        `UPDATE cf_stock_units
            SET stocking_area_id = CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} END,
                status = CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} END,
                parent_unit_id = CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} END,
                owner_party_id = CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} END,
                last_movement_id = ?
          WHERE company_id = ? AND id IN (?)`,
        [...when((x) => x.area), ...when((x) => x.status), ...when((x) => x.parent), ...when((x) => owners.get(x.unit.batch_id)),
          opts.movementId ?? null, c.companyId, part.map((x) => x.unit.id)],
      );
    }
  }
  const events = [
    ...ch.map((x) => [c.companyId, x.unit.id, opts.movementId ?? null, x.event, x.from ?? null, x.area ?? null, x.parent ?? null, null, c.userId ?? null]),
    ...made.map((r) => [c.companyId, r.id, opts.movementId ?? null, 'made', null, r.stocking_area_id, null, r.replaces_unit_id ? `Made again in place of a scrapped piece (unit ${r.replaces_unit_id})` : null, c.userId ?? null]),
  ];
  if (events.length) {
    await insertRows(db, 'cf_stock_unit_events', ['company_id', 'unit_id', 'movement_id', 'event', 'from_area_id', 'to_area_id', 'parent_unit_id', 'note', 'created_by'], events, 500);
  }
  return {
    made: made.length,
    moved: ch.filter((x) => x.event === 'moved' || x.event === 'finished').length,
    left: ch.filter((x) => !['moved', 'finished', 'back'].includes(x.event)).length,
    back: ch.filter((x) => x.event === 'back').length,
  };
}

// --- reading ---------------------------------------------------------------------------

const UNIT_SELECT = `SELECT u.*, m.code AS item_code, m.name AS item_name, b.code AS batch_code, a.code AS area_code, a.name AS area_name, a.purpose,
       op.code AS owner_code, op.name AS owner_name, pu.unit_code AS parent_code, ru.unit_code AS replaces_code,
       o.id AS order_id, o.code AS order_code, sl.line_no
  FROM cf_stock_units u
  JOIN cf_master_records m ON m.id = u.item_id
  JOIN cf_stock_batches b ON b.id = u.batch_id
  LEFT JOIN cf_stocking_areas a ON a.id = u.stocking_area_id
  LEFT JOIN cf_parties op ON op.id = u.owner_party_id
  LEFT JOIN cf_stock_units pu ON pu.id = u.parent_unit_id
  LEFT JOIN cf_stock_units ru ON ru.id = u.replaces_unit_id
  LEFT JOIN cf_production_items pi ON pi.id = u.production_item_id
  LEFT JOIN cf_production_releases r ON r.id = pi.release_id
  LEFT JOIN cf_sales_orders o ON o.id = r.order_id
  LEFT JOIN cf_sales_order_lines sl ON sl.id = r.order_line_id`;

function shapeUnit(u) {
  return {
    id: u.id,
    code: u.unit_code,
    pieceCode: u.piece_code,
    serial: u.serial,
    status: u.status,
    item: { id: u.item_id, code: u.item_code, name: u.item_name },
    batch: { id: u.batch_id, code: u.batch_code },
    area: u.stocking_area_id ? { id: u.stocking_area_id, code: u.area_code, name: u.area_name, purpose: u.purpose } : null,
    owner: u.owner_party_id ? { id: u.owner_party_id, code: u.owner_code ?? null, name: u.owner_name ?? null } : null,
    parent: u.parent_unit_id ? { id: u.parent_unit_id, code: u.parent_code ?? null } : null,
    replaces: u.replaces_unit_id ? { id: u.replaces_unit_id, code: u.replaces_code ?? null } : null,
    order: u.order_id ? { id: u.order_id, code: u.order_code, lineNo: u.line_no ?? null } : null,
    productionItemId: u.production_item_id ?? null,
    updatedAt: u.updated_at,
  };
}

/**
 * GET /stock/units?itemId=&batchId=&areaId=&owner=&status=live|<status>|all&search=  (paged=1 for the list contract)
 * Pieces of individual items — by default the live ones (in process or finished).
 */
export async function listUnits(db, companyId, q = {}) {
  const base = ['u.company_id = ?', 'u.deleted_at IS NULL'];
  const args = [companyId];
  for (const [key, col] of [['itemId', 'u.item_id'], ['batchId', 'u.batch_id'], ['areaId', 'u.stocking_area_id'], ['productionItemId', 'u.production_item_id']]) {
    if (!blank(q[key])) { base.push(`${col} = ?`); args.push(Number(q[key])); }
  }
  if (q.owner === 'ours') base.push('u.owner_party_id IS NULL');
  else if (q.owner === 'customer') base.push('u.owner_party_id IS NOT NULL');
  else if (!blank(q.owner) && Number.isInteger(Number(q.owner))) { base.push('u.owner_party_id = ?'); args.push(Number(q.owner)); }
  if (!blank(q.search)) {
    const s = `%${String(q.search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    base.push('(u.unit_code LIKE ? OR u.piece_code LIKE ? OR m.code LIKE ?)');
    args.push(s, s, s);
  }
  const where = [...base];
  const rowArgs = [...args];
  const status = blank(q.status) ? 'live' : String(q.status);
  if (status === 'live') where.push(`u.status IN ('${LIVE.join("','")}')`);
  else if (status !== 'all') { where.push('u.status = ?'); rowArgs.push(status); }
  const sql = `${UNIT_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.code, u.batch_id, u.serial`;
  if (!wantsPage(q)) {
    const [rows] = await db.query(`${sql} LIMIT 2000`, rowArgs);
    return rows.map(shapeUnit);
  }
  const page = pageArgs(q, { def: 100 });
  const [[rows], [[n]], [byStatus]] = await Promise.all([
    db.query(`${sql} LIMIT ? OFFSET ?`, [...rowArgs, page.limit, page.offset]),
    db.query(`SELECT COUNT(*) AS n FROM cf_stock_units u JOIN cf_master_records m ON m.id = u.item_id WHERE ${where.join(' AND ')}`, rowArgs),
    db.query(`SELECT u.status AS k, COUNT(*) AS n FROM cf_stock_units u JOIN cf_master_records m ON m.id = u.item_id WHERE ${base.join(' AND ')} GROUP BY u.status`, args),
  ]);
  return pageOf(rows.map(shapeUnit), n.n, page, { counts: { status: countsBy(byStatus, UNIT_STATUSES) } });
}

const EVENT_WORDS = {
  made: 'Made', moved: 'Moved', joined: 'Went into', split: 'Taken apart', finished: 'Finished', dispatched: 'Dispatched',
  scrapped: 'Scrapped', returned: 'Returned to the customer', back: 'Back', undone: 'Undone',
};

/** GET /stock/units/:id — one piece: where it is, its history (oldest first), the pieces inside it. Four reads. */
export async function unitHistory(db, companyId, id) {
  const [[u]] = await db.query(`${UNIT_SELECT} WHERE u.company_id = ? AND u.id = ? AND u.deleted_at IS NULL`, [companyId, Number(id)]);
  if (!u) throw notFound('Piece');
  const [[events], [inside], [made]] = await Promise.all([
    db.query(
      `SELECT e.*, m.code AS movement_code, m.movement_type, m.movement_date, m.reference, fa.code AS from_code, ta.code AS to_code, pu.unit_code AS parent_code
         FROM cf_stock_unit_events e
         LEFT JOIN cf_stock_movements m ON m.id = e.movement_id
         LEFT JOIN cf_stocking_areas fa ON fa.id = e.from_area_id
         LEFT JOIN cf_stocking_areas ta ON ta.id = e.to_area_id
         LEFT JOIN cf_stock_units pu ON pu.id = e.parent_unit_id
        WHERE e.company_id = ? AND e.unit_id = ? ORDER BY e.id`, [companyId, u.id]),
    db.query(`${UNIT_SELECT} WHERE u.company_id = ? AND u.parent_unit_id = ? AND u.status = 'joined' AND u.deleted_at IS NULL ORDER BY u.unit_code`, [companyId, u.id]),
    db.query(`${UNIT_SELECT} WHERE u.company_id = ? AND u.replaces_unit_id = ? AND u.deleted_at IS NULL`, [companyId, u.id]),
  ]);
  return {
    unit: shapeUnit(u),
    history: events.map((e) => ({
      id: e.id, event: e.event, words: EVENT_WORDS[e.event] ?? e.event, at: e.created_at,
      movement: e.movement_id ? { id: e.movement_id, code: e.movement_code, type: e.movement_type, date: e.movement_date, reference: e.reference } : null,
      from: e.from_area_id ? { id: e.from_area_id, code: e.from_code } : null,
      to: e.to_area_id ? { id: e.to_area_id, code: e.to_code } : null,
      parent: e.parent_unit_id ? { id: e.parent_unit_id, code: e.parent_code } : null,
      note: e.note,
    })),
    inside: inside.map(shapeUnit),
    madeAgainAs: made.map(shapeUnit),
  };
}

/**
 * Where live units and balances disagree, for lots of individual items: one
 * set-based read. [{ batchId, areaId, balance, units }] — none is the normal answer.
 */
export async function checkUnits(db, companyId) {
  try {
    const [rows] = await db.query(
      `SELECT x.batch_id, x.area_id, SUM(x.bal) AS balance, SUM(x.n) AS units
         FROM (SELECT k.batch_id, k.stocking_area_id AS area_id, FLOOR(k.quantity + 0.000001) AS bal, 0 AS n
                 FROM cf_stock_balances k
                 JOIN cf_stock_batches b ON b.id = k.batch_id
                 JOIN cf_item_details i ON i.company_id = k.company_id AND i.master_id = k.item_id AND i.tracked_by = 'individual'
                WHERE k.company_id = ? AND k.quantity > 0
               UNION ALL
               SELECT u.batch_id, u.stocking_area_id, 0, 1 FROM cf_stock_units u
                WHERE u.company_id = ? AND u.deleted_at IS NULL AND u.status IN ('in_process', 'finished')) x
        GROUP BY x.batch_id, x.area_id
       HAVING SUM(x.bal) <> SUM(x.n)`,
      [companyId, companyId],
    );
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM cf_stock_units WHERE company_id = ? AND deleted_at IS NULL AND status IN ('in_process', 'finished')", [companyId]);
    return { ok: rows.length === 0, liveUnits: Number(n), differences: rows.map((r) => ({ batchId: r.batch_id, areaId: r.area_id, balance: Number(r.balance), units: Number(r.units) })) };
  } catch (e) {
    if (e?.errno === 1146) return { ok: true, liveUnits: 0, differences: [], note: 'Per-piece tracking is not set up on this database (§67).' };
    throw e;
  }
}
