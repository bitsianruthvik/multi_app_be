/**
 * placeholders.js — the codes an order line's rows will give their pieces.
 *
 *   GET /order-lines/:id/placeholders   one code per row, # where each piece's number goes
 *
 * Read-only: nothing is written and no running number moves (placeholderService).
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { linePlaceholders } from '../services/placeholderService.js';

const router = Router();

router.get('/order-lines/:id/placeholders', guard(PERM.ordersView),
  handle((req) => linePlaceholders(pool, ctx(req).companyId, intParam(req.params.id))));

export default router;
