/**
 * times.js — the Times tab of an order's Production stage (services/timeEstimateService.js).
 *
 *   GET /orders/:orderId/lines/:lineId/times
 *       rows = the line's BOM tree, columns = the operations of the rows' flows;
 *       each cell the formula's work minutes per piece (and setup per run), the
 *       machine (type) it read, what is missing, and any typed override
 *   PUT /orders/:orderId/lines/:lineId/times   { cells: [{ bomLineId|null, operationId, work?, setup?, note? }] }
 *       null clears an override. All or nothing; returns the grid as GET does.
 *       Refused (422) for an operation not in the row's flow, a negative number,
 *       or a released line.
 *
 * The line is addressed through its order and the two are checked against each
 * other. Grants are production's: cf_erp_production_view to see,
 * cf_erp_production_manage to type (the Production stage's screens use them).
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { getLineTimes, setLineTimes } from '../services/timeEstimateService.js';

const router = Router();
const orderId = (req) => intParam(req.params.orderId, 'orderId');
const lineId = (req) => intParam(req.params.lineId, 'lineId');

router.get('/orders/:orderId/lines/:lineId/times', guard(PERM.productionView),
  handle((req) => getLineTimes(pool, ctx(req).companyId, orderId(req), lineId(req))));
router.put('/orders/:orderId/lines/:lineId/times', guard(PERM.production),
  handle((req) => withTransaction((db) => setLineTimes(db, ctx(req), orderId(req), lineId(req), req.body ?? {}))));

export default router;
