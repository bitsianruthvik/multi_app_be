/**
 * departmentAlerts.js — the alerts of maintenance, engineering, stores and accounts (init.sql §113; user 2026-11-19:
 * the MD "needs to see updates from engineering, planning, production, stores, maintenance, procurement").
 *
 * alertService runs these with its own (procurement and the plan). Same rules: ONE ROW PER MATTER, found again by its
 * key, resolved by itself when the check no longer finds it. Every limit is a setting (settingsService, groups
 * "Alerts: when one is raised" and "Alerts: when it reaches the MD").
 *
 *   machine_down      a machine stopped under an open maintenance order for longer than the limit → maintenance,
 *                     planning; the MD past his limit.
 *   repeat_breakdown  N faults on one machine within D days → maintenance, md.
 *   pm_overdue        a preventive plan that is due with no maintenance order opened for it → maintenance.
 *   inquiry_waiting   a sales order still an inquiry after N days → engineering; the MD past his limit.
 *   count_skipped     (Stores desk) stock moved in a store area and nobody has counted it for N days → stores; MD later.
 *   tool_lost         something recorded as lost in the last N days → stores, md.
 *   out_too_long      things given out past their due date / the company's limit → stores; the MD when one is a
 *                     further M days over.
 *   ticket_late · machine_no_plan · spare_low · tool_worn_early   §114, found by maintenanceDeskService (Maintenance today).
 *   invoice_unpaid    an issued invoice with money still to come, N days after its date → accounts; the MD later.
 */
import { machinesDownNow, planStatus } from './maintenanceService.js';
import { deskSettings } from './storesDeskService.js';
import { findMaintenanceDeskAlerts, MAINTENANCE_DESK_KINDS, MAINTENANCE_DESK_KIND_LABEL } from './maintenanceDeskService.js';

export const DEPARTMENT_KINDS = ['machine_down', 'repeat_breakdown', 'pm_overdue', 'inquiry_waiting', 'count_skipped', 'tool_lost', 'out_too_long', 'invoice_unpaid', ...MAINTENANCE_DESK_KINDS];
export const DEPARTMENT_KIND_LABEL = {
  machine_down: 'Machine down', repeat_breakdown: 'Repeat breakdown', pm_overdue: 'Preventive job overdue', inquiry_waiting: 'Inquiry waiting',
  count_skipped: 'Count not done', tool_lost: 'Item lost', out_too_long: 'Out too long', invoice_unpaid: 'Invoice unpaid', ...MAINTENANCE_DESK_KIND_LABEL,
};
const plural = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;
const rupees = (n) => `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;
const pad = (n) => String(n).padStart(2, '0');
const todayText = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const daysSince = (text) => Math.round((new Date(`${todayText()}T00:00:00`) - new Date(`${String(text).slice(0, 10)}T00:00:00`)) / 86400000);

async function machineDown(db, companyId, S) {
  const down = await machinesDownNow(db, companyId);
  return down.filter((d) => d.hours >= Number(S.alert_machine_down_hours)).map((d) => {
    const md = d.hours >= Number(S.md_machine_down_hours);
    return {
      key: `machine_down:${d.orderId}`, kind: 'machine_down', severity: md ? 'danger' : 'warning',
      title: `${d.machine.code} ${d.machine.name} has been down for ${d.hours >= 48 ? `${Math.round(d.hours / 24)} days` : `${Math.round(d.hours)} hours`}`,
      detail: `${d.code}: ${d.title}${d.status === 'waiting_parts' ? ' — waiting for parts' : ''}.${d.machine.owner ? ` Owner: ${d.machine.owner}.` : ''} Down since ${d.since.slice(0, 16)}.`,
      departments: ['maintenance', 'planning', ...(md ? ['md'] : [])], subjectType: 'maintenance_order', subjectId: d.orderId,
      link: `maintenance-orders/${d.orderId}`, daysLate: Math.round((d.hours / 24) * 100) / 100,
    };
  });
}

async function repeatBreakdowns(db, companyId, S) {
  const [rows] = await db.query(
    `SELECT mo.machine_id, m.code, m.name, m.owner_name, COUNT(*) AS n, MAX(mo.raised_at) AS last_at
       FROM cf_maintenance_orders mo JOIN cf_machines m ON m.id = mo.machine_id
      WHERE mo.company_id = ? AND mo.deleted_at IS NULL AND mo.source = 'fault' AND mo.false_alarm = 0 AND mo.status <> 'cancelled'
        AND mo.raised_at >= NOW() - INTERVAL ? DAY
      GROUP BY mo.machine_id, m.code, m.name, m.owner_name HAVING n >= ?`,
    [companyId, Number(S.alert_repeat_days), Number(S.alert_repeat_breakdowns)]);
  return rows.map((r) => ({
    key: `repeat_breakdown:${r.machine_id}`, kind: 'repeat_breakdown', severity: 'danger',
    title: `${r.code} ${r.name}: ${plural(r.n, 'breakdown')} in ${S.alert_repeat_days} days`,
    detail: `The same machine keeps failing.${r.owner_name ? ` Owner: ${r.owner_name}.` : ''} Look at its maintenance orders for a common cause, or plan a replacement.`,
    departments: ['maintenance', 'md'], subjectType: 'machine', subjectId: r.machine_id, link: `machines/${r.machine_id}`, count: Number(r.n),
  }));
}

async function pmOverdue(db, companyId) {
  const plans = await planStatus(db, companyId, {});
  return plans.filter((p) => p.due && !p.openOrder).map((p) => ({
    key: `pm_overdue:${p.id}`, kind: 'pm_overdue', severity: 'warning',
    title: `${p.machine.code} ${p.machine.name}: "${p.title}" is due`,
    detail: `The preventive plan has reached ${p.progressPct}% of its interval and no maintenance order is open for it.`,
    departments: ['maintenance'], subjectType: 'maintenance_plan', subjectId: p.id, link: 'maintenance-plans',
  }));
}

async function inquiriesWaiting(db, companyId, S) {
  const [rows] = await db.query(
    `SELECT o.id, o.code, cu.name AS customer, DATEDIFF(CURDATE(), o.created_at) AS days
       FROM cf_sales_orders o LEFT JOIN cf_parties cu ON cu.id = o.customer_id
      WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.status = 'inquiry' AND DATEDIFF(CURDATE(), o.created_at) >= ?
      ORDER BY days DESC LIMIT 60`, [companyId, Number(S.alert_inquiry_days)]);
  return rows.map((r) => {
    const days = Number(r.days);
    const md = days >= Number(S.md_inquiry_days);
    return {
      key: `inquiry_waiting:${r.id}`, kind: 'inquiry_waiting', severity: md ? 'danger' : 'warning',
      title: `${r.code}${r.customer ? ` · ${r.customer}` : ''}: an inquiry for ${plural(days, 'day')}`,
      detail: 'Not confirmed yet. Finish its structure and send the acceptance, or mark it lost.',
      departments: ['engineering', ...(md ? ['md'] : [])], orderId: r.id, orderCode: r.code, subjectType: 'sales_order', subjectId: r.id, link: `orders/${r.id}`, daysLate: days,
    };
  });
}

async function storesAlerts(db, companyId, S) {
  const desk = await deskSettings(db, companyId);
  const out = [];
  // Lost items and things out too long exist wherever custody is used; a skipped count only where the desk is on.
  const [lost] = await db.query(
    `SELECT e.id, e.quantity, e.note, m.name AS item_name, i.uom, c.holder_type, pe.name AS person_name, dp.name AS department_name, pa.name AS party_name, e.created_at
       FROM cf_stock_custody_events e JOIN cf_stock_custody c ON c.id = e.custody_id
       JOIN cf_master_records m ON m.id = c.item_id JOIN cf_item_details i ON i.master_id = c.item_id
       LEFT JOIN cf_store_people pe ON pe.id = c.person_id LEFT JOIN cf_departments dp ON dp.id = c.department_id LEFT JOIN cf_parties pa ON pa.id = c.party_id
      WHERE e.company_id = ? AND e.kind = 'lost' AND e.created_at >= NOW() - INTERVAL ? DAY ORDER BY e.id DESC LIMIT 60`, [companyId, Number(S.alert_lost_days)]);
  for (const r of lost) {
    const holder = r.holder_type === 'vendor' ? r.party_name : r.person_name ?? r.department_name;
    out.push({
      key: `tool_lost:${r.id}`, kind: 'tool_lost', severity: 'danger',
      title: `Lost: ${Number(r.quantity)} ${r.uom} of ${r.item_name}${holder ? ` — was with ${holder}` : ''}`,
      detail: r.note ? `Stores wrote: ${r.note}` : 'Recorded as lost by Stores.',
      departments: ['stores', 'md'], subjectType: 'custody_event', subjectId: r.id, link: 'stores-out?status=closed',
    });
  }
  const [[long]] = await db.query(
    `SELECT COUNT(*) AS n, MAX(IF(c.due_on IS NOT NULL, DATEDIFF(CURDATE(), c.due_on), DATEDIFF(CURDATE(), c.issued_on) - ?)) AS worst
       FROM cf_stock_custody c
      WHERE c.company_id = ? AND c.deleted_at IS NULL AND c.status = 'open'
        AND ((c.due_on IS NOT NULL AND c.due_on < CURDATE()) OR (c.due_on IS NULL AND DATEDIFF(CURDATE(), c.issued_on) > ?))`,
    [desk.toolsOutDays, companyId, desk.toolsOutDays]);
  if (Number(long?.n) > 0) {
    const worst = Number(long.worst) || 0;
    const md = worst >= Number(S.md_out_extra_days);
    out.push({
      key: 'out_too_long', kind: 'out_too_long', severity: md ? 'danger' : 'warning',
      title: `${plural(long.n, 'thing')} given out ${Number(long.n) === 1 ? 'is' : 'are'} out too long — the oldest by ${plural(worst, 'day')}`,
      detail: 'Ask for each back, or record it worn out or lost on Stores › Out with.',
      departments: ['stores', ...(md ? ['md'] : [])], link: 'stores-out?holder=overdue', daysLate: worst, count: Number(long.n),
    });
  }
  if (desk.storesV2) {
    const [areas] = await db.query(
      `SELECT a.id, a.name,
              (SELECT MAX(n.count_date) FROM cf_stock_counts n WHERE n.company_id = a.company_id AND n.area_id = a.id AND n.deleted_at IS NULL) AS last_on
         FROM cf_stocking_areas a WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.status = 'active' AND a.purpose = 'storage'`, [companyId]);
    for (const a of areas) {
      const [[mv]] = await db.query(
        `SELECT MIN(mm.movement_date) AS first_on, COUNT(DISTINCT l.item_id) AS items
           FROM cf_stock_ledger l JOIN cf_stock_movements mm ON mm.id = l.movement_id
          WHERE l.company_id = ? AND l.stocking_area_id = ? AND l.deleted_at IS NULL AND mm.movement_type <> 'adjustment' AND mm.movement_date > ?`,
        [companyId, a.id, a.last_on ?? '2000-01-01']);
      if (!mv?.first_on) continue;
      const days = daysSince(mv.first_on);
      if (days < Number(S.alert_count_skip_days)) continue;
      const md = days >= Number(S.md_count_skip_days);
      out.push({
        key: `count_skipped:${a.id}`, kind: 'count_skipped', severity: md ? 'danger' : 'warning',
        title: `${a.name}: ${plural(mv.items, 'item')} moved and not counted for ${plural(days, 'day')}`,
        detail: a.last_on ? `Last counted on ${String(a.last_on).slice(0, 10)}.` : 'This area has never been counted.',
        departments: ['stores', ...(md ? ['md'] : [])], subjectType: 'stocking_area', subjectId: a.id, link: 'stores-count', daysLate: days, count: Number(mv.items),
      });
    }
  }
  return out;
}

async function invoicesUnpaid(db, companyId, S) {
  const [rows] = await db.query(
    `SELECT i.id, i.invoice_no, i.invoice_date, i.due_date, i.grand_total, so.id AS order_id, so.code AS order_code, cu.name AS customer,
            COALESCE((SELECT SUM(a.amount) FROM cf_receipt_allocations a WHERE a.company_id = i.company_id AND a.invoice_id = i.id AND a.deleted_at IS NULL), 0) AS paid,
            DATEDIFF(CURDATE(), i.invoice_date) AS days
       FROM cf_invoices i LEFT JOIN cf_sales_orders so ON so.id = i.order_id LEFT JOIN cf_parties cu ON cu.id = i.customer_id
      WHERE i.company_id = ? AND i.deleted_at IS NULL AND i.status = 'issued' AND i.invoice_date IS NOT NULL
        AND DATEDIFF(CURDATE(), i.invoice_date) >= ?
     HAVING grand_total - paid > 1 ORDER BY days DESC LIMIT 60`, [companyId, Number(S.alert_billing_days)]);
  return rows.map((r) => {
    const days = Number(r.days);
    const md = days >= Number(S.md_billing_days);
    return {
      key: `invoice_unpaid:${r.id}`, kind: 'invoice_unpaid', severity: md ? 'danger' : 'warning',
      title: `${r.invoice_no ?? 'Invoice'}${r.customer ? ` · ${r.customer}` : ''}: ${rupees(Number(r.grand_total) - Number(r.paid))} unpaid after ${plural(days, 'day')}`,
      detail: `Invoice of ${String(r.invoice_date).slice(0, 10)} for ${rupees(r.grand_total)}; ${rupees(r.paid)} received.`,
      departments: ['accounts', ...(md ? ['md'] : [])], orderId: r.order_id ?? null, orderCode: r.order_code ?? null, subjectType: 'invoice', subjectId: r.id, link: `invoices/${r.id}`, daysLate: days,
    };
  });
}

const missing = (e) => e?.errno === 1054 || e?.errno === 1146;
/** Runs every department check. → { found, ok } — `ok` are the kinds whose check ran (only those may be resolved). */
export async function findDepartmentAlerts(db, companyId, S) {
  const found = []; const ok = [];
  const run = async (kinds, fn) => {
    try { found.push(...(await fn())); ok.push(...kinds); } catch (e) { if (missing(e)) ok.push(...kinds); else console.error(`[cf_erp alerts] ${kinds[0]}:`, e?.message ?? e); }
  };
  await run(['machine_down'], () => machineDown(db, companyId, S));
  await run(['repeat_breakdown'], () => repeatBreakdowns(db, companyId, S));
  await run(['pm_overdue'], () => pmOverdue(db, companyId));
  await run(['inquiry_waiting'], () => inquiriesWaiting(db, companyId, S));
  await run(['tool_lost', 'out_too_long', 'count_skipped'], () => storesAlerts(db, companyId, S));
  await run(MAINTENANCE_DESK_KINDS, () => findMaintenanceDeskAlerts(db, companyId, S));
  await run(['invoice_unpaid'], () => invoicesUnpaid(db, companyId, S));
  return { found, ok };
}
