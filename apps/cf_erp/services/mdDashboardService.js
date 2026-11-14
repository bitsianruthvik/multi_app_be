/**
 * mdDashboardService.js — THE MD'S DASHBOARD (user, 2026-11-14): "today's activities, planned versus reality, alerts and
 * requests raised should be visible with actions also doable from the same … very succinct and quick to look and work
 * on. They should be able to view by sales order and also by operations."
 *
 * GET /md-dashboard?by=order|operation → one read for the whole screen:
 *   today       per sales order (or operation): steps the plan has on today, started today, done today, running now,
 *               and those whose slot has ended without them being done ("behind"); work done today the plan did not
 *               have today is counted too ("unplanned").
 *   plan        per sales order (or operation), over the open released work: steps, done, due by now per the plan,
 *               planned finish against the committed date (orders only).
 *   alerts      the open alerts addressed to the MD (alertService), newest danger first, with counts by kind.
 *   requests    the approvals waiting for this person (approvalService), decided from the screen.
 * The plan is the planner's (cf_plan3_steps); an order it has not planned shows its steps and progress only.
 */
import { listAlerts } from './alertService.js';
import { listApprovals } from './approvalService.js';

const r1 = (n) => Math.round(Number(n) * 10) / 10;

export async function mdDashboard(db, companyId, can, q = {}) {
  const by = q.by === 'operation' ? 'operation' : 'order';
  const key = by === 'order' ? 'so.id' : 's.operation_id';
  const label = by === 'order' ? 'so.code' : 'o.name';
  const extra = by === 'order' ? ', MAX(so.committed_date) AS committed, MAX(p3.planned_end) AS plan_end, MAX(cu.name) AS customer' : ', MAX(o.code) AS op_code';
  const [today, plan, alerts, requests, planRun] = await Promise.all([
    db.query(
      `SELECT ${key} AS id, ${label} AS label,
              SUM(p.step_id IS NOT NULL AND DATE(p.planned_start) <= CURDATE() AND DATE(p.planned_end) >= CURDATE()) AS planned,
              SUM(DATE(s.started_at) = CURDATE()) AS started,
              SUM(s.state = 'done' AND DATE(s.finished_at) = CURDATE()) AS done,
              SUM(s.state = 'in_progress') AS running,
              SUM(p.step_id IS NOT NULL AND s.state <> 'done' AND p.planned_end < NOW() AND DATE(p.planned_start) <= CURDATE() AND DATE(p.planned_end) >= CURDATE()) AS behind,
              SUM(DATE(s.started_at) = CURDATE() AND (p.step_id IS NULL OR DATE(p.planned_start) > CURDATE())) AS unplanned
         FROM cf_production_steps s
         JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
         JOIN cf_sales_orders so ON so.id = r.order_id AND so.deleted_at IS NULL AND so.status = 'confirmed'
         JOIN cf_operations o ON o.id = s.operation_id
         LEFT JOIN cf_plan3_steps p ON p.step_id = s.id AND p.company_id = s.company_id
        WHERE s.company_id = ? AND s.deleted_at IS NULL
        GROUP BY ${key}, ${label}
       HAVING planned > 0 OR started > 0 OR done > 0 OR running > 0`,
      [companyId],
    ).catch(() => [[]]),
    db.query(
      `SELECT ${key} AS id, ${label} AS label, COUNT(*) AS steps, SUM(s.state = 'done') AS done,
              SUM(p.step_id IS NOT NULL AND p.planned_end <= NOW()) AS due,
              SUM(p.step_id IS NOT NULL AND p.planned_end <= NOW() AND s.state <> 'done') AS overdue,
              SUM(p.step_id IS NOT NULL) AS planned, SUM(s.state = 'in_progress') AS running${extra}
         FROM cf_production_steps s
         JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
         JOIN cf_sales_orders so ON so.id = r.order_id AND so.deleted_at IS NULL AND so.status = 'confirmed'
         JOIN cf_operations o ON o.id = s.operation_id
         LEFT JOIN cf_parties cu ON cu.id = so.customer_id
         LEFT JOIN cf_plan3_steps p ON p.step_id = s.id AND p.company_id = s.company_id
         LEFT JOIN cf_plan3_orders p3 ON p3.production_order_id = s.production_order_id AND p3.company_id = s.company_id
        WHERE s.company_id = ? AND s.deleted_at IS NULL
        GROUP BY ${key}, ${label}`,
      [companyId],
    ).catch(() => [[]]),
    listAlerts(db, companyId, can, { department: 'md' }).catch(() => ({ alerts: [], counts: { byKind: {} } })),
    listApprovals(db, companyId, can, { status: 'pending' }).catch(() => ({ rows: [], types: [] })),
    // Whether the planner has run at all: without it there is nothing to be behind, and the screen says so.
    db.query('SELECT MAX(run_at) AS at, COUNT(*) AS n FROM cf_plan3_orders WHERE company_id = ?', [companyId]).then(([[r]]) => (Number(r?.n) ? r.at : null)).catch(() => null),
  ]);
  const num = (v) => Number(v ?? 0);
  const todayRows = today[0].map((r) => ({
    id: r.id, label: r.label, planned: num(r.planned), started: num(r.started), done: num(r.done), running: num(r.running),
    behind: num(r.behind), unplanned: num(r.unplanned),
  })).sort((a, b) => b.behind - a.behind || b.running - a.running || b.planned - a.planned);
  const planRows = plan[0].map((r) => {
    const steps = num(r.steps); const done = num(r.done); const due = num(r.due);
    const row = {
      id: r.id, label: r.label, steps, done, due, overdue: num(r.overdue), planned: num(r.planned), running: num(r.running),
      donePct: steps ? r1((done / steps) * 100) : 0, duePct: steps ? r1((due / steps) * 100) : 0,
    };
    if (by === 'order') {
      Object.assign(row, {
        customer: r.customer ?? null, committed: r.committed ?? null, planEnd: r.plan_end ?? null,
        late: !!(r.committed && r.plan_end && new Date(r.plan_end) > new Date(`${String(r.committed instanceof Date ? r.committed.toISOString() : r.committed).slice(0, 10)}T23:59:59`)),
      });
    } else row.code = r.op_code ?? null;
    return row;
  }).filter((r) => r.done < r.steps || r.running > 0)
    .sort((a, b) => (b.duePct - b.donePct) - (a.duePct - a.donePct) || b.steps - a.steps);
  const t = todayRows.reduce((s, r) => ({ planned: s.planned + r.planned, started: s.started + r.started, done: s.done + r.done, running: s.running + r.running, behind: s.behind + r.behind, unplanned: s.unplanned + r.unplanned }),
    { planned: 0, started: 0, done: 0, running: 0, behind: 0, unplanned: 0 });
  return {
    by,
    planRunAt: planRun,
    summary: { ...t, alerts: alerts.alerts.length, danger: alerts.alerts.filter((a) => a.severity === 'danger').length, requests: requests.rows.length },
    today: todayRows,
    plan: planRows,
    alerts: { rows: alerts.alerts.slice(0, 60), byKind: alerts.counts.byKind },
    requests: requests.rows.slice(0, 60),
  };
}
