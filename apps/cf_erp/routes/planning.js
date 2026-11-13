/**
 * planning.js — PLANNING (init.sql §105; services/monthPlanService.js, planFollowService.js, monthPlanEngine.js).
 *
 *   GET  /planning                               home: the month, the week, tomorrow's roster, the alerts
 *   GET  /planning/month?month=YYYY-MM           the month plan (working + frozen) and the machine choices
 *   POST /planning/month/run                     { month, machineIds?, ranks?, toleranceDays?, save?, note? }
 *   POST /planning/month/:id/send                { note? }  → the MD (approval 'month_plan'); approved = frozen
 *   POST /planning/month/:id/withdraw
 *   GET  /planning/months                        the months that have plans
 *   GET  /planning/week?week=YYYY-MM-DD|id=      a week: plan + what happened
 *   POST /planning/week/run                      { weekStart?, machineIds?, ranks?, toleranceDays?, note? }
 *   POST /planning/week/:id/publish              the MD is told
 *   POST /planning/week/:id/close                { notes? }
 *   PUT  /planning/week/:id/notes                { notes }
 *   GET  /planning/day?date=&fresh=1             the roster of a day (default tomorrow)
 *   PUT  /planning/day                           { date, tasks, machines?, note?, publish? }
 *   GET  /planning/roster?date=                  the published roster — what production reads
 *   GET  /planning/alerts?all=1                  what changed against the plan (detected on read)
 *   POST /planning/alerts/:id/dismiss
 *   GET  /planning/review?month=                 the month looked back on
 *   GET  /planning/contractors                   work orders and contractors: planned, done, behind, machines out
 *   POST /planning/consumables/mr                { month, items: [{ itemId, qty, needBy }] }
 *   GET  /operations/:id/consumables · PUT /operations/:id/consumables { rows: [{ itemId, per, quantity }] }
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guardAny, handle, ctx, intParam } from '../lib/http.js';
import * as M from '../services/monthPlanService.js';
import * as F from '../services/planFollowService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const company = (req) => ctx(req).companyId;
const body = (req) => req.body ?? {};
const view = guardAny(PERM.productionView, PERM.production, 'cf_erp_approve_month_plan');
const manage = guardAny(PERM.production);
const floor = guardAny(PERM.productionView, PERM.production, PERM.floor);

router.get('/planning', view, handle((req) => F.planningHome(pool, ctx(req))));
router.get('/planning/month', view, handle((req) => M.getMonth(pool, company(req), req.query)));
router.post('/planning/month/run', manage, handle((req) => tx(req, (db, c) => M.runMonth(db, c, body(req)))));
router.post('/planning/month/:id/send', manage, handle((req) => tx(req, (db, c) => M.sendMonth(db, c, id(req), body(req)))));
router.post('/planning/month/:id/withdraw', manage, handle((req) => tx(req, (db, c) => M.withdrawMonth(db, c, id(req)))));
router.get('/planning/months', view, handle((req) => M.listMonths(pool, company(req))));

router.get('/planning/week', view, handle((req) => F.getWeek(pool, company(req), req.query)));
router.post('/planning/week/run', manage, handle((req) => tx(req, (db, c) => F.runWeek(db, c, body(req)))));
router.post('/planning/week/:id/publish', manage, handle((req) => tx(req, (db, c) => F.publishWeek(db, c, id(req)))));
router.post('/planning/week/:id/close', manage, handle((req) => tx(req, (db, c) => F.closeWeek(db, c, id(req), body(req)))));
router.put('/planning/week/:id/notes', manage, handle((req) => tx(req, (db, c) => F.setWeekNotes(db, c, id(req), body(req)))));

router.get('/planning/day', view, handle((req) => F.getDay(pool, company(req), req.query)));
router.put('/planning/day', manage, handle((req) => tx(req, (db, c) => F.saveDay(db, c, body(req)))));
router.get('/planning/roster', floor, handle((req) => F.publishedRoster(pool, company(req), req.query)));
// Production ticks a roster task done (work recorded on the Machine log / Tracker shows as done by itself).
router.post('/planning/roster/task', floor, handle((req) => tx(req, (db, c) => F.markRosterTask(db, c, body(req)))));

router.get('/planning/alerts', view, handle(async (req) => (req.query.all === '1' ? { alerts: await F.openAlerts(pool, company(req), { all: true }), source: null } : F.detectAlerts(pool, ctx(req)))));
router.post('/planning/alerts/:id/dismiss', manage, handle((req) => tx(req, (db, c) => F.dismissAlert(db, c, id(req)))));
router.get('/planning/review', view, handle((req) => F.reviewMonth(pool, company(req), req.query)));
router.get('/planning/contractors', view, handle((req) => F.contractorStanding(pool, company(req), {})));
router.post('/planning/consumables/mr', manage, handle((req) => tx(req, (db, c) => F.raiseConsumableMr(db, c, body(req)))));

router.get('/operations/:id/consumables', view, handle(async (req) => {
  const [rows] = await pool.query(
    `SELECT c.id, c.item_id, c.per, c.quantity, i.code, i.name, d.uom FROM cf_operation_consumables c JOIN cf_master_records i ON i.id = c.item_id JOIN cf_item_details d ON d.master_id = c.item_id
      WHERE c.company_id = ? AND c.operation_id = ? AND c.deleted_at IS NULL ORDER BY i.code`, [company(req), id(req)]);
  return { rows: rows.map((r) => ({ id: r.id, itemId: r.item_id, code: r.code, name: r.name, uom: r.uom, per: r.per, quantity: Number(r.quantity) })) };
}));
router.put('/operations/:id/consumables', manage, handle((req) => tx(req, async (db, c) => {
  const rows = (Array.isArray(body(req).rows) ? body(req).rows : []).filter((r) => Number(r.itemId) > 0 && Number(r.quantity) > 0).slice(0, 50);
  await db.query('UPDATE cf_operation_consumables SET deleted_at = NOW() WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [c.companyId, id(req)]);
  for (const r of rows) {
    await db.query('INSERT INTO cf_operation_consumables (company_id, operation_id, item_id, per, quantity, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [c.companyId, id(req), Number(r.itemId), r.per === 'tonne' ? 'tonne' : 'hour', Number(r.quantity), c.userId ?? null]);
  }
  return { ok: true, rows: rows.length };
})));

export default router;
