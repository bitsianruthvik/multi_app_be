/**
 * lock.js — locking an order line (services/lockService.js).
 *
 *   GET  /order-lines/:id/lock?nodes=1
 *        what locking would do: every check in words, the line's position among
 *        the order's lines of the same design, and what it would write — with
 *        `nodes=1`, the piece tree itself, each piece's code exactly as lock
 *        would write it (heavy: 6,072 pieces on the KEPL line). Once locked, the
 *        locked pieces as they were written.
 *   POST /order-lines/:id/lock
 *        locks the line in one transaction: its pieces are written with their
 *        codes, its rows activated, and its structure, values and cut pieces
 *        frozen. Every problem at once (422) when it cannot be locked yet.
 *
 * Behind the orders grants, like the rest of an order's stages: seeing is
 * reading the order, locking is managing it.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { lockPlan, lockLine } from '../services/lockService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const flag = (v) => v === '1' || v === 'true' || v === true;

router.get('/order-lines/:id/lock', guard(PERM.ordersView),
  handle((req) => lockPlan(pool, ctx(req).companyId, id(req), { nodes: flag(req.query.nodes) })));
router.post('/order-lines/:id/lock', guard(PERM.orders),
  handle((req) => withTransaction((db) => lockLine(db, ctx(req), id(req)))));

export default router;
