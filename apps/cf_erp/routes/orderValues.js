/**
 * orderValues.js — every specification value of one order line's structure,
 * for the Values stage of the sales-order flow (services/orderValuesService.js).
 *
 *   GET /order-lines/:id/values
 *       every node of the line's structure that takes values, grouped by kind of
 *       thing, with each applicable item-level spec, its rule and its value
 *   GET /order-lines/:id/design-uses?group=|recordId=|drawingId=
 *       the rows a design is used by (a link group, a row and its copies, a drawing's rows)
 *       with their codes and pieces
 *   PUT /order-lines/:id/values   { dryRun?: boolean, links?: 'all' | 'one', writes: [{ recordId, specCode, value, links? }] }
 *       `links` — on a linked copy ("same design"): 'all' gives every copy the value, 'one' only
 *       the rows named (they stop being copies); said nothing, only the rows named change and the
 *       answer's `links.needsChoice` says a choice was due. The answer carries `links`
 *       { needsChoice, touched, breaks, skipped, after } and `view.links`.
 *       one transaction, all or nothing, every problem at once (422 `problems`,
 *       and `detail.cells` as { recordId, specCode, problem }); a closed order or
 *       a released line is a 409. A dry run is the real write in a SAVEPOINT,
 *       rolled back. Answers with the grid as it now stands (`view`).
 *
 *   GET /orders/:id/spec-defaults
 *       ORDER and LINE values (init.sql §65, services/orderDefaultService.js): the specifications flagged
 *       "Can be set for a whole order", the order's values, each line's, and how each line's rows take them
 *   PUT /orders/:id/spec-defaults   { lineId?: number | null, dryRun?, writes: [{ specCode, value }] }
 *       lineId null = the whole order; value null / '' takes it away. Every open line it reaches is worked
 *       out again at once, then its cut pieces follow (withCutPieces); a locked line keeps what it locked with.
 *
 * WHICH GRANT WRITES
 * Either of two. `PUT /records/:id/values` asks for the catalog grant whatever
 * the record belongs to, so today only a catalog editor can type an order's
 * values — and the people who work an order's stages hold the ORDERS grant.
 * Asking for the catalog grant alone here would build the dead end this app has
 * closed three times already (a screen whose users cannot do its one job). Only
 * the order's own temporary items can be written through this route — shared
 * catalog records are refused whatever the grant — so the orders grant reaches
 * nothing it does not already shape through the order's structure, and the
 * catalog grant keeps what it can do in the structure tree today.
 */
import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { readLineValues, writeLineValues } from '../services/orderValuesService.js';
import { withCutPieces } from '../services/cutPlateService.js';
import { designUses } from '../services/partDrawingService.js';
import { readOrderDefaults, writeOrderDefaults } from '../services/orderDefaultService.js';

const router = Router();
const id = (req) => intParam(req.params.id);

/** The grants that may write an order line's values — either one. The Values panel asks the same question. */
export const VALUES_WRITE_PERMS = [PERM.orders, PERM.catalog];

/** requirePerm for "any of these" — admins pass, as everywhere. */
const requireAny = (tags) => (req, res, next) => {
  if (tags.some((t) => isPermitted(req.user, t))) return next();
  return res.status(403).json({ error: 'FORBIDDEN', message: `Permission required: ${tags.join(' or ')}` });
};

router.get('/order-lines/:id/values', guard(PERM.ordersView), handle((req) => readLineValues(pool, ctx(req).companyId, id(req))));
// The rows one design is used by, and their pieces ("used by N pieces") — for a link group, a row
// or a drawing: ?group= | ?recordId= | ?drawingId= (linked copies, init.sql §59). Read only.
router.get('/order-lines/:id/design-uses', guard(PERM.ordersView), handle((req) => designUses(pool, ctx(req).companyId, id(req), req.query ?? {})));
// Saved values are followed by the line's cut pieces: made as soon as the
// required values are complete, and made again when they change (user,
// 2026-09-26) — cutPlateService.refreshCutPieces, which never fails the save.
router.put('/order-lines/:id/values', protect, requireAny(VALUES_WRITE_PERMS),
  handle((req) => withTransaction(async (db) => {
    const c = ctx(req);
    const out = await writeLineValues(db, c, id(req), req.body ?? {});
    return out.applied ? withCutPieces(db, c, id(req), out) : out;
  })));


// Order and line values (init.sql §65). The same grants as the Values stage: they are its values.
router.get('/orders/:id/spec-defaults', guard(PERM.ordersView), handle((req) => readOrderDefaults(pool, ctx(req).companyId, id(req), { usage: req.query?.usage !== '0' })));
router.put('/orders/:id/spec-defaults', protect, requireAny(VALUES_WRITE_PERMS),
  handle((req) => withTransaction(async (db) => {
    const c = ctx(req);
    const out = await writeOrderDefaults(db, c, id(req), req.body ?? {});
    // Each line whose rows moved: its cut pieces (a grade or a size may have changed), as after a Values save.
    const cutPieces = [];
    for (const lineId of out.linesWorked) {
      const r = await withCutPieces(db, c, lineId, {});
      cutPieces.push({ lineId, ...(r?.cutPieces ?? {}) });
    }
    return cutPieces.length ? { ...out, cutPieces } : out;
  })));

export default router;
