/**
 * mdOverviewService.js — THE MD'S PAGE (init.sql §113; user, 2026-11-19): "MD needs to see where his action is needed,
 * what reports he needs to verify, what are still pending for his eye, what all requests have come to him" — from
 * engineering, planning, production, stores, maintenance, procurement (and accounts).
 *
 * GET /md/overview → four bands, one answer:
 *   decisions     everything waiting for a yes or no, from all three places a request can wait: the Approvals inbox
 *                 (twelve kinds), plate changes, purchase requests. Oldest first, each with its department.
 *   reports       the weekly reports he has not marked seen (stores audit, week plan, maintenance, purchase).
 *   alerts        the open alerts addressed to the MD (alertService — only what has passed HIS limits).
 *   departments   one tile a department: three lines and a colour, each opening that department's own screen.
 *
 * WEEKLY REPORTS. One row of cf_md_reports a kind a week, made the first time the page is read after the week ended:
 * the figures as they were then (a report is a record — it does not change after he has read it). "Seen" keeps his
 * name and the time. Every report is { figures: [{ label, value, tone? }], tables: [{ title, columns, rows }], notes }.
 */
import { invalid, notFound } from '../lib/errors.js';
import { listAlerts } from './alertService.js';
import { queryOpening } from '../lib/schemaOpening.js';
import { listApprovals } from './approvalService.js';
import { getSettings, isStandIn } from './settingsService.js';
import { deskSettings } from './storesDeskService.js';
import { maintenanceSummary, machinesDownNow, planStatus } from './maintenanceService.js';
import { billingDueCount } from './billingService.js';

const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10));
const todayText = () => dateText(new Date());
const addDays = (text, n) => { const d = new Date(`${text}T00:00:00`); d.setDate(d.getDate() + n); return dateText(d); };
const num = (v) => Number(v ?? 0) || 0;
const r1 = (n) => Math.round(Number(n) * 10) / 10;
const plural = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;
const rupees = (n) => `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;
const ageDays = (at) => (at ? Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 86400000)) : 0);
const quiet = (p, fallback) => p.catch((e) => { if (e?.errno !== 1054 && e?.errno !== 1146) console.error('[cf_erp md]', e?.message ?? e); return fallback; });
const STORE_PURPOSES = ['storage', 'quarantine'];

/** Which department a kind of approval comes from. */
const APPROVAL_DEPT = {
  order_acceptance: 'Sales', rate_change: 'Sales', purchase_order: 'Procurement', po_close_short: 'Procurement', contractor_po: 'Production',
  rebaseline: 'Planning', month_plan: 'Planning', machine_pr_maintenance: 'Maintenance', machine_pr_md: 'Maintenance', machine_condemn: 'Maintenance', stock_count: 'Stores',
};

// --- decisions -----------------------------------------------------------------------------

async function decisions(db, companyId, can) {
  const [inbox, plates, prs] = await Promise.all([
    quiet(listApprovals(db, companyId, can, { status: 'pending' }), { rows: [] }),
    can('cf_erp_plate_change_approve') ? quiet(db.query(
      `SELECT r.id, r.code, r.kind, r.reason, r.requested_at, u.name AS by_name, so.id AS order_id, so.code AS order_code
         FROM cf_plate_change_requests r LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN cf_sales_orders so ON so.id = r.order_id
        WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.status = 'pending' ORDER BY r.requested_at LIMIT 100`, [companyId]).then(([x]) => x), []) : [],
    can('cf_erp_purchase_approve') ? quiet(db.query(
      `SELECT r.id, r.code, r.notes, r.needed_by, r.submitted_at, u.name AS by_name,
              (SELECT COUNT(*) FROM cf_purchase_request_lines l WHERE l.purchase_request_id = r.id AND l.deleted_at IS NULL) AS lines_n
         FROM cf_purchase_requests r LEFT JOIN users u ON u.id = r.requested_by
        WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.status = 'submitted' ORDER BY r.submitted_at LIMIT 100`, [companyId]).then(([x]) => x), []) : [],
  ]);
  const rows = [
    ...inbox.rows.map((a) => ({
      source: 'approval', id: a.id, type: a.type, typeLabel: a.typeLabel, department: APPROVAL_DEPT[a.type] ?? 'Management',
      title: a.title, summary: a.summary ?? null, amount: a.amount ?? null, order: a.order ?? null,
      requestedBy: a.requestedBy?.name ?? null, requestedAt: a.requestedAt, ageDays: ageDays(a.requestedAt), link: 'approvals', decideHere: true,
    })),
    ...plates.map((p) => ({
      source: 'plate_change', id: p.id, type: 'plate_change', typeLabel: p.kind === 'substitute' ? 'Plate substitute' : 'Plate change', department: 'Engineering',
      title: `${p.code ?? 'Plate change'}${p.order_code ? ` on ${p.order_code}` : ''}`, summary: p.reason ?? null, amount: null,
      order: p.order_id ? { id: p.order_id, code: p.order_code } : null,
      requestedBy: p.by_name ?? null, requestedAt: p.requested_at, ageDays: ageDays(p.requested_at), link: 'plate-changes', decideHere: false,
    })),
    ...prs.map((p) => ({
      source: 'purchase_request', id: p.id, type: 'purchase_request', typeLabel: 'Purchase request', department: 'Procurement',
      title: `${p.code ?? 'Purchase request'}: ${plural(num(p.lines_n), 'item')}${p.needed_by ? `, needed by ${dateText(p.needed_by)}` : ''}`, summary: p.notes ?? null, amount: null, order: null,
      requestedBy: p.by_name ?? null, requestedAt: p.submitted_at, ageDays: ageDays(p.submitted_at), link: `purchase-requests/${p.id}`, decideHere: false,
    })),
  ].sort((a, b) => new Date(a.requestedAt ?? 0) - new Date(b.requestedAt ?? 0));
  return { rows, oldestDays: rows.length ? rows[0].ageDays : 0 };
}

// --- the departments strip ---------------------------------------------------------------------

async function departments(db, companyId, alerts, dec) {
  const t = todayText();
  const desk = await deskSettings(db, companyId);
  const one = (sql, params) => quiet(db.query(sql, params).then(([[r]]) => r ?? {}), {});
  const [inq, steps, late, stores, custody, maint, down, po, pr, billDue, unpaid] = await Promise.all([
    one("SELECT COUNT(*) AS n, MAX(DATEDIFF(CURDATE(), created_at)) AS oldest FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status = 'inquiry'", [companyId]),
    // §121: a step done by an opening position is not today's work.
    quiet(queryOpening(db, (has) =>
      `SELECT SUM(s.state = 'done' AND DATE(s.finished_at) = CURDATE()${has ? ' AND s.opening = 0' : ''}) AS done, SUM(s.state = 'in_progress') AS running,
              SUM(p.step_id IS NOT NULL AND DATE(p.planned_start) <= CURDATE() AND DATE(p.planned_end) >= CURDATE()) AS planned
         FROM cf_production_steps s LEFT JOIN cf_plan3_steps p ON p.step_id = s.id AND p.company_id = s.company_id
        WHERE s.company_id = ? AND s.deleted_at IS NULL AND (s.state = 'in_progress' OR DATE(s.finished_at) = CURDATE() OR p.step_id IS NOT NULL)`, [companyId]).then(([[r]]) => r ?? {}), {}),
    one('SELECT COUNT(*) AS n, SUM(late = 1) AS late, MAX(run_at) AS run_at FROM cf_plan3_orders WHERE company_id = ?', [companyId]),
    one(
      `SELECT (SELECT COUNT(*) FROM cf_stock_counts WHERE company_id = ? AND deleted_at IS NULL AND count_date = ?) AS counted,
              (SELECT COUNT(*) FROM cf_procurement_settings ps
                WHERE ps.company_id = ? AND ps.min_qty IS NOT NULL AND ps.min_qty > COALESCE((SELECT SUM(k.quantity) FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
                       WHERE k.company_id = ps.company_id AND k.item_id = ps.master_id AND a.purpose IN (?)), 0)) AS low`, [companyId, t, companyId, STORE_PURPOSES]),
    one(
      `SELECT COUNT(*) AS n, SUM((due_on IS NOT NULL AND due_on < CURDATE()) OR (due_on IS NULL AND DATEDIFF(CURDATE(), issued_on) > ?)) AS overdue
         FROM cf_stock_custody WHERE company_id = ? AND deleted_at IS NULL AND status = 'open'`, [desk.toolsOutDays, companyId]),
    quiet(maintenanceSummary(db, companyId), null),
    quiet(machinesDownNow(db, companyId), []),
    one(
      `SELECT COUNT(DISTINCT IF(COALESCE(l.expected_date, p.expected_date) < CURDATE(), p.id, NULL)) AS late, COUNT(DISTINCT p.id) AS open_n
         FROM cf_purchase_order_lines l JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND p.status IN ('ordered', 'partially_received')
          AND l.quantity - l.qty_received - COALESCE(l.qty_closed, 0) > 0.000001`, [companyId]),
    one("SELECT COUNT(*) AS n FROM cf_purchase_requests WHERE company_id = ? AND deleted_at IS NULL AND status IN ('submitted', 'approved')", [companyId]),
    quiet(billingDueCount(db, companyId), null),
    one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(x.due), 0) AS amount FROM (
         SELECT i.grand_total - COALESCE((SELECT SUM(a.amount) FROM cf_receipt_allocations a WHERE a.company_id = i.company_id AND a.invoice_id = i.id AND a.deleted_at IS NULL), 0) AS due
           FROM cf_invoices i WHERE i.company_id = ? AND i.deleted_at IS NULL AND i.status = 'issued') x WHERE x.due > 1`, [companyId]),
  ]);
  // Alerts of each department: red when one is a danger, amber when there is any.
  const byDept = {};
  for (const a of alerts) for (const d of a.departments) { byDept[d] ??= { n: 0, danger: 0 }; byDept[d].n += 1; if (a.severity === 'danger') byDept[d].danger += 1; }
  const tone = (keys, warnIf = false) => (keys.some((k) => byDept[k]?.danger) ? 'bad' : keys.some((k) => byDept[k]?.n) || warnIf ? 'warn' : 'ok');
  const waiting = (dept) => dec.rows.filter((r) => r.department === dept).length;
  const stepsText = num(steps.planned) ? `${num(steps.done)} done today of ${num(steps.planned)} in today's plan` : `${plural(num(steps.done), 'step')} done today`;
  return [
    { key: 'engineering', label: 'Engineering', status: tone(['engineering'], num(inq.n) > 0), link: 'orders?status=inquiry', lines: [
      `${plural(num(inq.n), 'inquiry', 'inquiries')} not confirmed${num(inq.n) ? `, oldest ${plural(num(inq.oldest), 'day')}` : ''}`,
      `${plural(waiting('Engineering'), 'plate change')} waiting for you`,
      `${plural(waiting('Sales'), 'acceptance or rate change', 'acceptances or rate changes')} waiting for you`] },
    { key: 'planning', label: 'Planning', status: tone(['planning'], num(late.late) > 0), link: 'planning', lines: [
      late.run_at ? `${plural(num(late.late), 'order')} of ${num(late.n)} late in the plan` : 'The planner has not been run',
      `${plural(byDept.planning?.n ?? 0, 'delay alert')} open`,
      `${plural(waiting('Planning'), 'plan')} waiting for you`] },
    { key: 'production', label: 'Production', status: tone(['floor']), link: 'tracker', lines: [
      stepsText, `${plural(num(steps.running), 'step')} running now`, `${plural(waiting('Production'), 'contractor PO')} waiting for you`] },
    { key: 'stores', label: 'Stores', status: tone(['stores'], num(custody.overdue) > 0), link: desk.storesV2 ? 'stores-today' : 'stock', lines: [
      desk.storesV2 ? (num(stores.counted) ? 'Audited today' : 'Not audited today') : 'Stock audits are not in use',
      `${plural(num(stores.low), 'item')} below minimum`,
      `${plural(num(custody.overdue), 'thing')} out too long (of ${num(custody.n)} out)`] },
    { key: 'maintenance', label: 'Maintenance', status: tone(['maintenance'], down.length > 0), link: 'maintenance', lines: [
      `${plural(down.length, 'machine')} down now`,
      `${plural(num(maint?.openOrders), 'maintenance order')} open`,
      `${r1(num(maint?.downtimeHours))} h downtime this week`] },
    { key: 'procurement', label: 'Procurement', status: tone(['purchase'], num(po.late) > 0), link: 'purchase-orders', lines: [
      `${plural(num(po.late), 'PO')} late of ${num(po.open_n)} open`,
      `${plural(num(pr.n), 'purchase request')} in hand`,
      `${plural(waiting('Procurement'), 'PO or request', 'POs or requests')} waiting for you`] },
    { key: 'accounts', label: 'Accounts', status: tone(['accounts'], num(billDue) > 0), link: 'billing', lines: [
      billDue == null ? 'Billing is not in use' : `${plural(num(billDue), 'bill')} due to raise`,
      `${plural(num(unpaid.n), 'invoice')} unpaid`,
      `${rupees(num(unpaid.amount))} to come in`] },
  ];
}

// --- weekly reports ------------------------------------------------------------------------------

export const REPORT_KINDS = {
  stores_week: { label: 'Weekly stock audit', department: 'Stores', setting: 'report_stores' },
  plan_week: { label: 'Week plan against actual', department: 'Planning', setting: 'report_plan' },
  maintenance_week: { label: 'Maintenance week', department: 'Maintenance', setting: 'report_maintenance' },
  purchase_week: { label: 'Purchase week', department: 'Procurement', setting: 'report_purchase' },
};

/** The last week that has ended, by the company's week start: { from, to } (dates, inclusive). */
export function lastWeek(weekStart, today = todayText()) {
  const dow = new Date(`${today}T00:00:00`).getDay();
  const thisStart = addDays(today, -((dow - Number(weekStart) + 7) % 7));
  return { from: addDays(thisStart, -7), to: addDays(thisStart, -1) };
}

const table = (title, columns, rows, empty = null) => ({ title, columns, rows, empty });

async function storesWeek(db, companyId, from, to) {
  const desk = await deskSettings(db, companyId);
  const q = (sql, p) => db.query(sql, p).then(([x]) => x);
  const [counts, moved, events, long, low, byDept, byMachine, top, checks] = await Promise.all([
    q('SELECT count_date, status, diff_n, diff_value FROM cf_stock_counts WHERE company_id = ? AND deleted_at IS NULL AND count_date BETWEEN ? AND ?', [companyId, from, to]),
    q(`SELECT COUNT(DISTINCT mm.movement_date) AS days, COUNT(DISTINCT mm.id) AS n FROM cf_stock_movements mm
        WHERE mm.company_id = ? AND mm.movement_date BETWEEN ? AND ? AND mm.movement_type IN ('receipt', 'issue') AND mm.reversed_by_id IS NULL AND mm.reversal_of_id IS NULL`, [companyId, from, to]),
    q(`SELECT e.kind, e.quantity, e.note, m.name AS item_name, i.uom, c.holder_type, pe.name AS person_name, dp.name AS department_name, pa.name AS party_name, c.unit_cost
         FROM cf_stock_custody_events e JOIN cf_stock_custody c ON c.id = e.custody_id JOIN cf_master_records m ON m.id = c.item_id JOIN cf_item_details i ON i.master_id = c.item_id
         LEFT JOIN cf_store_people pe ON pe.id = c.person_id LEFT JOIN cf_departments dp ON dp.id = c.department_id LEFT JOIN cf_parties pa ON pa.id = c.party_id
        WHERE e.company_id = ? AND DATE(e.created_at) BETWEEN ? AND ?`, [companyId, from, to]),
    q(`SELECT COUNT(*) AS n FROM cf_stock_custody WHERE company_id = ? AND deleted_at IS NULL AND status = 'open'
          AND ((due_on IS NOT NULL AND due_on < CURDATE()) OR (due_on IS NULL AND DATEDIFF(CURDATE(), issued_on) > ?))`, [companyId, desk.toolsOutDays]),
    q(`SELECT COUNT(*) AS n FROM cf_procurement_settings ps WHERE ps.company_id = ? AND ps.min_qty IS NOT NULL
          AND ps.min_qty > COALESCE((SELECT SUM(k.quantity) FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
               WHERE k.company_id = ps.company_id AND k.item_id = ps.master_id AND a.purpose IN (?)), 0)`, [companyId, STORE_PURPOSES]),
    q(`SELECT COALESCE(dp.name, IF(mm.order_id IS NOT NULL, 'Sales orders', IF(mm.used_for = 'vendor', 'Vendors', 'Not said'))) AS who, COUNT(DISTINCT mm.id) AS n, SUM(-l.quantity * l.unit_cost) AS value, SUM(l.unit_cost IS NULL) AS uncosted
         FROM cf_stock_movements mm JOIN cf_stock_ledger l ON l.movement_id = mm.id AND l.deleted_at IS NULL AND l.quantity < 0
         LEFT JOIN cf_departments dp ON dp.id = mm.department_id
        WHERE mm.company_id = ? AND mm.movement_type = 'issue' AND COALESCE(mm.used_for, '') <> 'asset' AND mm.movement_date BETWEEN ? AND ? AND mm.reversed_by_id IS NULL AND mm.reversal_of_id IS NULL
        GROUP BY who ORDER BY value DESC, n DESC LIMIT 10`, [companyId, from, to]),
    q(`SELECT CONCAT(mc.code, ' ', mc.name) AS who, COUNT(DISTINCT mm.id) AS n, SUM(-l.quantity * l.unit_cost) AS value
         FROM cf_stock_movements mm JOIN cf_stock_ledger l ON l.movement_id = mm.id AND l.deleted_at IS NULL AND l.quantity < 0
         JOIN cf_machines mc ON mc.id = mm.machine_id
        WHERE mm.company_id = ? AND mm.movement_type = 'issue' AND COALESCE(mm.used_for, '') <> 'asset' AND mm.movement_date BETWEEN ? AND ? AND mm.reversed_by_id IS NULL AND mm.reversal_of_id IS NULL
        GROUP BY who ORDER BY value DESC, n DESC LIMIT 10`, [companyId, from, to]),
    q(`SELECT m.name AS item_name, i.uom, SUM(-l.quantity) AS qty, SUM(-l.quantity * l.unit_cost) AS value
         FROM cf_stock_movements mm JOIN cf_stock_ledger l ON l.movement_id = mm.id AND l.deleted_at IS NULL AND l.quantity < 0
         JOIN cf_master_records m ON m.id = l.item_id JOIN cf_item_details i ON i.master_id = l.item_id
        WHERE mm.company_id = ? AND mm.movement_type = 'issue' AND COALESCE(mm.used_for, '') NOT IN ('vendor', 'asset') AND mm.movement_date BETWEEN ? AND ? AND mm.reversed_by_id IS NULL AND mm.reversal_of_id IS NULL
        GROUP BY m.id, m.name, i.uom ORDER BY value DESC, qty DESC LIMIT 12`, [companyId, from, to]),
    q('SELECT COUNT(*) AS n FROM cf_store_night_checks WHERE company_id = ? AND DATE(checked_at) BETWEEN ? AND ?', [companyId, from, to]),
  ]);
  const daysCounted = new Set(counts.map((c) => dateText(c.count_date))).size;
  const daysMoved = num(moved[0]?.days);
  const diffValue = counts.reduce((s, c) => s + num(c.diff_value), 0);
  const pending = counts.filter((c) => c.status === 'pending').length;
  const lost = events.filter((e) => e.kind === 'lost');
  const worn = events.filter((e) => e.kind === 'worn');
  const holder = (e) => (e.holder_type === 'vendor' ? e.party_name : e.person_name ?? e.department_name) ?? '—';
  const money = (v) => (v == null ? 'not costed' : rupees(v));
  return {
    headline: `${daysCounted} of ${daysMoved} working days audited · ${plural(lost.length, 'item')} lost · ${plural(num(long[0]?.n), 'thing')} out too long`,
    data: {
      figures: [
        { label: 'Days audited', value: `${daysCounted} of ${daysMoved}`, tone: daysMoved && daysCounted < daysMoved ? 'warn' : 'ok' },
        { label: 'Audits that differed', value: String(counts.filter((c) => num(c.diff_n) > 0).length), tone: 'neutral' },
        { label: 'Value of differences', value: rupees(diffValue), tone: diffValue > 0 ? 'warn' : 'ok' },
        { label: 'Waiting for approval', value: String(pending), tone: pending ? 'warn' : 'ok' },
        { label: 'Lost', value: String(lost.length), tone: lost.length ? 'bad' : 'ok' },
        { label: 'Worn out', value: String(worn.length), tone: 'neutral' },
        { label: 'Out too long now', value: String(num(long[0]?.n)), tone: num(long[0]?.n) ? 'warn' : 'ok' },
        { label: 'Below minimum now', value: String(num(low[0]?.n)), tone: num(low[0]?.n) ? 'warn' : 'ok' },
        { label: 'Morning checks done', value: String(num(checks[0]?.n)), tone: 'neutral' },
      ],
      tables: [
        table('Lost this week', ['Item', 'Quantity', 'Was with', 'What is known'], lost.map((e) => [e.item_name, `${Number(e.quantity)} ${e.uom}`, holder(e), e.note ?? '—']), 'Nothing was recorded as lost.'),
        table('Given out, by who it was for', ['For', 'Issues', 'Value'], byDept.map((r) => [r.who, String(r.n), money(r.value)]), 'Nothing was given out.'),
        table('Given out, by machine', ['Machine', 'Issues', 'Value'], byMachine.map((r) => [r.who, String(r.n), money(r.value)]), 'No give-out named a machine.'),
        table('Most used items', ['Item', 'Quantity', 'Value'], top.map((r) => [r.item_name, `${Number(Number(r.qty).toFixed(3))} ${r.uom}`, money(r.value)]), 'Nothing was used.'),
      ],
      notes: desk.storesV2 ? [] : ['This company does not run the Stores desk: audits, lost items and "out with" are not recorded yet.'],
    },
  };
}

async function planWeek(db, companyId, from, to) {
  const q = (sql, p) => db.query(sql, p).then(([x]) => x);
  const [tot, byOrder, late, al] = await Promise.all([
    q(`SELECT COUNT(*) AS planned, SUM(s.state = 'done') AS done, SUM(s.state = 'done' AND s.finished_at <= p.planned_end) AS on_time
         FROM cf_plan3_steps p JOIN cf_production_steps s ON s.id = p.step_id AND s.deleted_at IS NULL
        WHERE p.company_id = ? AND DATE(p.planned_end) BETWEEN ? AND ?`, [companyId, from, to]),
    q(`SELECT so.code, COUNT(*) AS planned, SUM(s.state = 'done') AS done
         FROM cf_plan3_steps p JOIN cf_production_steps s ON s.id = p.step_id AND s.deleted_at IS NULL
         JOIN cf_production_items pi ON pi.id = s.production_item_id JOIN cf_production_releases r ON r.id = pi.release_id JOIN cf_sales_orders so ON so.id = r.order_id
        WHERE p.company_id = ? AND DATE(p.planned_end) BETWEEN ? AND ?
        GROUP BY so.id, so.code HAVING planned > done ORDER BY planned - done DESC LIMIT 15`, [companyId, from, to]),
    q('SELECT COUNT(*) AS n, SUM(late = 1) AS late FROM cf_plan3_orders WHERE company_id = ?', [companyId]),
    q("SELECT kind, COUNT(*) AS n FROM cf_alerts WHERE company_id = ? AND kind IN ('start_late', 'finish_late', 'unplanned_start') AND DATE(first_at) BETWEEN ? AND ? GROUP BY kind", [companyId, from, to]),
  ]);
  const planned = num(tot[0]?.planned); const done = num(tot[0]?.done);
  const pct = planned ? Math.round((done / planned) * 100) : null;
  const k = Object.fromEntries(al.map((a) => [a.kind, num(a.n)]));
  return {
    headline: planned ? `${done} of ${planned} planned steps done (${pct}%) · ${plural(num(late[0]?.late), 'order')} late in the plan` : 'Nothing was planned to finish this week',
    data: {
      figures: [
        { label: 'Steps planned to finish', value: String(planned), tone: 'neutral' },
        { label: 'Done', value: pct == null ? '—' : `${done} (${pct}%)`, tone: pct == null ? 'neutral' : pct >= 90 ? 'ok' : pct >= 70 ? 'warn' : 'bad' },
        { label: 'Done on time', value: String(num(tot[0]?.on_time)), tone: 'neutral' },
        { label: 'Orders late in the plan now', value: `${num(late[0]?.late)} of ${num(late[0]?.n)}`, tone: num(late[0]?.late) ? 'bad' : 'ok' },
        { label: 'Late starts raised', value: String(k.start_late ?? 0), tone: 'neutral' },
        { label: 'Late finishes raised', value: String(k.finish_late ?? 0), tone: 'neutral' },
        { label: 'Work started outside the plan', value: String(k.unplanned_start ?? 0), tone: 'neutral' },
      ],
      tables: [table('Orders that fell behind', ['Sales order', 'Planned', 'Done', 'Left'], byOrder.map((r) => [r.code, String(r.planned), String(num(r.done)), String(num(r.planned) - num(r.done))]), 'Every order did what the plan had for it.')],
      notes: planned ? [] : ['The planner had no step finishing in this week. Run the plan, or the week has no released work.'],
    },
  };
}

async function maintenanceWeek(db, companyId, from, to) {
  const q = (sql, p) => db.query(sql, p).then(([x]) => x);
  const [mo, closed, byMachine, open, plans, down] = await Promise.all([
    q('SELECT source, COUNT(*) AS n, SUM(false_alarm = 1) AS false_n FROM cf_maintenance_orders WHERE company_id = ? AND deleted_at IS NULL AND DATE(raised_at) BETWEEN ? AND ? GROUP BY source', [companyId, from, to]),
    q("SELECT COUNT(*) AS n, COALESCE(SUM(downtime_minutes), 0) AS minutes, COALESCE(SUM(COALESCE(parts_cost, 0) + other_cost), 0) AS cost FROM cf_maintenance_orders WHERE company_id = ? AND deleted_at IS NULL AND status = 'done' AND DATE(done_at) BETWEEN ? AND ?", [companyId, from, to]),
    q(`SELECT CONCAT(m.code, ' ', m.name) AS machine, m.owner_name, COUNT(*) AS n, COALESCE(SUM(mo.downtime_minutes), 0) AS minutes
         FROM cf_maintenance_orders mo JOIN cf_machines m ON m.id = mo.machine_id
        WHERE mo.company_id = ? AND mo.deleted_at IS NULL AND mo.source = 'fault' AND mo.false_alarm = 0 AND DATE(mo.raised_at) BETWEEN ? AND ?
        GROUP BY m.id, m.code, m.name, m.owner_name ORDER BY n DESC, minutes DESC LIMIT 12`, [companyId, from, to]),
    q("SELECT COUNT(*) AS n FROM cf_maintenance_orders WHERE company_id = ? AND deleted_at IS NULL AND status IN ('open', 'in_progress', 'waiting_parts')", [companyId]),
    planStatus(db, companyId, {}).catch(() => []),
    machinesDownNow(db, companyId).catch(() => []),
  ]);
  const raised = mo.reduce((s, r) => s + num(r.n), 0);
  const faults = num(mo.find((r) => r.source === 'fault')?.n);
  const due = plans.filter((p) => p.due && !p.openOrder).length;
  const hours = r1(num(closed[0]?.minutes) / 60);
  return {
    headline: `${plural(raised, 'ticket')} raised, ${num(closed[0]?.n)} closed · ${hours} h downtime · ${plural(due, 'preventive job')} overdue`,
    data: {
      figures: [
        { label: 'Tickets raised', value: String(raised), tone: 'neutral' },
        { label: 'Of them breakdowns', value: String(faults), tone: faults ? 'warn' : 'ok' },
        { label: 'Closed', value: String(num(closed[0]?.n)), tone: 'neutral' },
        { label: 'Open now', value: String(num(open[0]?.n)), tone: num(open[0]?.n) ? 'warn' : 'ok' },
        { label: 'Downtime of closed tickets', value: `${hours} h`, tone: 'neutral' },
        { label: 'Maintenance cost', value: rupees(num(closed[0]?.cost)), tone: 'neutral' },
        { label: 'Machines down now', value: String(down.length), tone: down.length ? 'bad' : 'ok' },
        { label: 'Preventive jobs overdue', value: String(due), tone: due ? 'warn' : 'ok' },
      ],
      tables: [
        table('Breakdowns by machine', ['Machine', 'Owner', 'Breakdowns', 'Downtime'], byMachine.map((r) => [r.machine, r.owner_name ?? '—', String(r.n), `${r1(num(r.minutes) / 60)} h`]), 'No breakdown was raised.'),
        table('Down now', ['Machine', 'Ticket', 'For'], down.map((d) => [`${d.machine.code} ${d.machine.name}`, `${d.code}: ${d.title}`, `${d.hours} h`]), 'Every machine is up.'),
      ],
      notes: [],
    },
  };
}

async function purchaseWeek(db, companyId, from, to) {
  const q = (sql, p) => db.query(sql, p).then(([x]) => x);
  const [ordered, received, lateNow, moved, prs, bySupplier] = await Promise.all([
    q(`SELECT COUNT(DISTINCT p.id) AS n, SUM(l.quantity * l.unit_price) AS value, SUM(l.unit_price IS NULL) AS unpriced
         FROM cf_purchase_orders p JOIN cf_purchase_order_lines l ON l.purchase_order_id = p.id AND l.deleted_at IS NULL
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND DATE(p.ordered_at) BETWEEN ? AND ?`, [companyId, from, to]),
    q(`SELECT COUNT(DISTINCT mm.id) AS n, COUNT(DISTINCT pl.purchase_order_id) AS pos FROM cf_stock_movements mm
         JOIN cf_purchase_order_lines pl ON pl.id = mm.purchase_line_id
        WHERE mm.company_id = ? AND mm.movement_type = 'receipt' AND mm.movement_date BETWEEN ? AND ? AND mm.reversed_by_id IS NULL AND mm.reversal_of_id IS NULL`, [companyId, from, to]).catch(() => [{ n: 0, pos: 0 }]),
    q(`SELECT p.code, s.name AS supplier, DATEDIFF(CURDATE(), MIN(COALESCE(l.expected_date, p.expected_date))) AS days, COUNT(*) AS n
         FROM cf_purchase_order_lines l JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL LEFT JOIN cf_parties s ON s.id = p.supplier_id
        WHERE l.company_id = ? AND l.deleted_at IS NULL AND p.status IN ('ordered', 'partially_received') AND l.quantity - l.qty_received - COALESCE(l.qty_closed, 0) > 0.000001
          AND COALESCE(l.expected_date, p.expected_date) < CURDATE()
        GROUP BY p.id, p.code, s.name ORDER BY days DESC LIMIT 15`, [companyId]),
    q('SELECT COUNT(*) AS n, SUM(to_date > from_date) AS later FROM cf_purchase_date_changes WHERE company_id = ? AND deleted_at IS NULL AND DATE(changed_at) BETWEEN ? AND ?', [companyId, from, to]).catch(() => [{ n: 0, later: 0 }]),
    q("SELECT SUM(status = 'submitted') AS waiting, SUM(status = 'approved') AS to_buy FROM cf_purchase_requests WHERE company_id = ? AND deleted_at IS NULL", [companyId]),
    q(`SELECT s.name AS supplier, COUNT(DISTINCT p.id) AS n, SUM(l.quantity * l.unit_price) AS value
         FROM cf_purchase_orders p JOIN cf_purchase_order_lines l ON l.purchase_order_id = p.id AND l.deleted_at IS NULL LEFT JOIN cf_parties s ON s.id = p.supplier_id
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND DATE(p.ordered_at) BETWEEN ? AND ? GROUP BY s.id, s.name ORDER BY value DESC LIMIT 10`, [companyId, from, to]),
  ]);
  const o = ordered[0] ?? {};
  return {
    headline: `${plural(num(o.n), 'PO')} ordered${o.value != null ? ` (${rupees(o.value)})` : ''} · ${plural(num(received[0]?.n), 'receipt')} · ${plural(lateNow.length, 'PO')} late now`,
    data: {
      figures: [
        { label: 'POs ordered', value: String(num(o.n)), tone: 'neutral' },
        { label: 'Value ordered', value: o.value == null ? '—' : rupees(o.value), tone: 'neutral' },
        { label: 'Receipts against POs', value: String(num(received[0]?.n)), tone: 'neutral' },
        { label: 'POs late now', value: String(lateNow.length), tone: lateNow.length ? 'bad' : 'ok' },
        { label: 'Delivery dates moved', value: `${num(moved[0]?.n)} (${num(moved[0]?.later)} later)`, tone: num(moved[0]?.later) ? 'warn' : 'ok' },
        { label: 'Requests waiting for approval', value: String(num(prs[0]?.waiting)), tone: num(prs[0]?.waiting) ? 'warn' : 'ok' },
        { label: 'Requests approved, to buy', value: String(num(prs[0]?.to_buy)), tone: 'neutral' },
      ],
      tables: [
        table('Late now', ['PO', 'Supplier', 'Lines', 'Late by'], lateNow.map((r) => [r.code, r.supplier ?? '—', String(r.n), plural(num(r.days), 'day')]), 'No purchase order is late.'),
        table('Ordered this week, by supplier', ['Supplier', 'POs', 'Value'], bySupplier.map((r) => [r.supplier ?? '—', String(r.n), r.value == null ? '—' : rupees(r.value)]), 'Nothing was ordered.'),
      ],
      notes: num(o.unpriced) ? [`${plural(num(o.unpriced), 'line')} ordered this week ${num(o.unpriced) === 1 ? 'has' : 'have'} no price, so the value is short.`] : [],
    },
  };
}

const BUILDERS = { stores_week: storesWeek, plan_week: planWeek, maintenance_week: maintenanceWeek, purchase_week: purchaseWeek };

/** Makes last week's reports that are switched on and not there yet. One read when all exist. */
export async function ensureReports(db, companyId, S = null) {
  const s = S ?? await getSettings(db, companyId);
  const { from, to } = lastWeek(s.week_start);
  const want = Object.keys(REPORT_KINDS).filter((k) => s[REPORT_KINDS[k].setting]);
  if (!want.length) return { from, to, made: 0 };
  const [have] = await db.query('SELECT kind FROM cf_md_reports WHERE company_id = ? AND period_start = ? AND kind IN (?)', [companyId, from, want]);
  let made = 0;
  for (const kind of want) {
    if (have.some((h) => h.kind === kind)) continue;
    try {
      const r = await BUILDERS[kind](db, companyId, from, to);
      await db.query('INSERT IGNORE INTO cf_md_reports (company_id, kind, period_start, period_end, headline, data) VALUES (?, ?, ?, ?, ?, ?)',
        [companyId, kind, from, to, String(r.headline).slice(0, 300), JSON.stringify(r.data)]);
      made += 1;
    } catch (e) { console.error(`[cf_erp md] report ${kind}:`, e?.message ?? e); }
  }
  return { from, to, made };
}

const shapeReport = (r, full = false) => ({
  id: r.id, kind: r.kind, label: REPORT_KINDS[r.kind]?.label ?? r.kind, department: REPORT_KINDS[r.kind]?.department ?? '',
  periodStart: dateText(r.period_start), periodEnd: dateText(r.period_end), headline: r.headline ?? null,
  seenAt: r.seen_at ?? null, seenBy: r.seen_name ?? null, seenNote: r.seen_note ?? null,
  ...(full ? { data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data ?? { figures: [], tables: [], notes: [] } } : {}),
});

/** The reports not yet seen (within the keep window), and those seen in the last 14 days. */
export async function listReports(db, companyId, S = null) {
  const s = S ?? await getSettings(db, companyId);
  const [rows] = await db.query(
    `SELECT r.id, r.kind, r.period_start, r.period_end, r.headline, r.seen_at, r.seen_note, u.name AS seen_name
       FROM cf_md_reports r LEFT JOIN users u ON u.id = r.seen_by
      WHERE r.company_id = ? AND ((r.seen_at IS NULL AND r.period_end >= CURDATE() - INTERVAL ? DAY) OR r.seen_at >= NOW() - INTERVAL 14 DAY)
      ORDER BY (r.seen_at IS NULL) DESC, r.period_start DESC, r.id`, [companyId, Number(s.report_keep_weeks) * 7 + 7]);
  return rows.map((r) => shapeReport(r));
}
export async function getReport(db, companyId, id) {
  const [[r]] = await db.query('SELECT r.*, u.name AS seen_name FROM cf_md_reports r LEFT JOIN users u ON u.id = r.seen_by WHERE r.company_id = ? AND r.id = ?', [companyId, Number(id)]);
  if (!r) throw notFound('Report');
  return shapeReport(r, true);
}
/** POST /md/reports/:id/seen { note? } — "I have read it". Kept with the name and the time; a second press changes nothing. */
export async function markSeen(db, c, id, input = {}) {
  const [[r]] = await db.query('SELECT id, seen_at FROM cf_md_reports WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, Number(id)]);
  if (!r) throw notFound('Report');
  if (!c.userId) throw invalid('NO_USER', 'A report is marked seen by a person.');
  if (!r.seen_at) {
    const note = input.note == null || String(input.note).trim() === '' ? null : String(input.note).trim().slice(0, 500);
    await db.query('UPDATE cf_md_reports SET seen_by = ?, seen_at = NOW(), seen_note = ? WHERE id = ?', [c.userId, note, r.id]);
  }
  return getReport(db, c.companyId, r.id);
}

// --- the page ----------------------------------------------------------------------------------------

/** GET /md/overview */
export async function mdOverview(db, companyId, can, userId = null) {
  const S = await getSettings(db, companyId);
  await quiet(ensureReports(db, companyId, S), null);
  const [dec, mine, everyone, reports, standIn] = await Promise.all([
    decisions(db, companyId, can),
    quiet(listAlerts(db, companyId, can, { department: 'md' }), { alerts: [] }),
    quiet(db.query("SELECT departments, severity FROM cf_alerts WHERE company_id = ? AND status IN ('open', 'acknowledged')", [companyId])
      .then(([x]) => x.map((a) => ({ severity: a.severity, departments: String(a.departments).split(',').filter(Boolean) }))), []),
    quiet(listReports(db, companyId, S), []),
    isStandIn(db, companyId, userId).catch(() => false),
  ]);
  const depts = await departments(db, companyId, everyone, dec);
  let standInName = null;
  if (S.md_standin_user) { const [[u]] = await db.query('SELECT name FROM users WHERE id = ? AND company_id = ?', [S.md_standin_user, companyId]).catch(() => [[null]]); standInName = u?.name ?? null; }
  return {
    date: todayText(),
    decisions: dec,
    reports: { toVerify: reports.filter((r) => !r.seenAt), seen: reports.filter((r) => r.seenAt) },
    alerts: mine.alerts.slice(0, 40),
    departments: depts,
    standIn: { on: S.md_standin_on === true, name: standInName, you: standIn },
  };
}
