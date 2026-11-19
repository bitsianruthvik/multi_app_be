/**
 * maintenanceDeskService.js — MAINTENANCE TODAY (init.sql §114; user, 2026-11-20: "consolidate as much as you can" —
 * use the tickets, the alerts, the store's stock and the preventive plans; one place to work from).
 *
 * Nothing here is a new record of its own. The page reads what the rest of the app already keeps:
 *   tickets        cf_maintenance_orders — breakdowns, preventive jobs, jobs of maintenance's own AND the set-up of a new
 *                  machine (source 'setup'), each with an owner and a target time (maintenanceService.ensureDue).
 *   no cycle       a live machine with no active preventive plan (cf_maintenance_plans) and no "needs none" reason.
 *   spares         the spares on the machines' lists (cf_machine_resources) against the store's stock and the item's
 *                  minimum (cf_procurement_settings) — Stores buys by the same minimum.
 *   wear           what Stores recorded worn out or lost on "Out with" (cf_stock_custody_events), with how long it
 *                  lasted against the tool's life; maintenance reads each and signs it off.
 *   tool rules     the tool's life and what the storekeeper checks before giving it out (cf_item_details).
 *   health         a machine's breakdowns, hours down, repair time, cost and preventive jobs on time, from the tickets.
 * The four alerts (ticket_late, machine_no_plan, spare_low, tool_worn_early) are found here and raised by alertService
 * with the other department alerts (departmentAlerts.js) — one row a matter, resolved when no longer found.
 * Every limit is a setting (settingsService, group "Maintenance").
 */
import { invalid, notFound } from '../lib/errors.js';
import { getSettings } from './settingsService.js';
import { listOrders, ensureDue, planStatus } from './maintenanceService.js';

const blank = (v) => v == null || String(v).trim() === '';
const num = (v) => (v == null ? 0 : Number(v));
const r1 = (n) => Math.round(n * 10) / 10;
const missing = (e) => e?.errno === 1054 || e?.errno === 1146;
const plural = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;
const hoursText = (min) => (min >= 2880 ? `${Math.round(min / 1440)} days` : `${Math.max(1, Math.round(min / 60))} hours`);
const STORES_ITEM = "(m.record_kind = 'item' AND m.deleted_at IS NULL)";

// --- machines with no cycle --------------------------------------------------------------------------------

/** Live machines (not tools) with no active preventive plan and no reason recorded for having none. */
export async function machinesWithoutPlan(db, companyId) {
  try {
    const [rows] = await db.query(
      `SELECT mc.id, mc.code, mc.name, mc.owner_name, mc.live_on
         FROM cf_machines mc
        WHERE mc.company_id = ? AND mc.deleted_at IS NULL AND mc.status = 'active' AND COALESCE(mc.kind, 'machine') = 'machine' AND COALESCE(mc.stage, 'live') = 'live'
          AND mc.no_plan_reason IS NULL
          AND NOT EXISTS (SELECT 1 FROM cf_maintenance_plans p WHERE p.company_id = mc.company_id AND p.machine_id = mc.id AND p.deleted_at IS NULL AND p.status = 'active')
        ORDER BY mc.code LIMIT 500`, [companyId]);
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, owner: r.owner_name ?? null, liveOn: r.live_on ? String(r.live_on instanceof Date ? r.live_on.toISOString() : r.live_on).slice(0, 10) : null }));
  } catch (e) { if (missing(e)) return []; throw e; }
}

/** POST /maintenance/machines/:id/no-plan { reason } — "needs no cycle, because …"; { reason: null } puts it back on the list. */
export async function setNoPlan(db, c, machineId, input = {}) {
  const [[m]] = await db.query('SELECT id, code FROM cf_machines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(machineId)]);
  if (!m) throw notFound('Machine');
  const reason = blank(input.reason) ? null : String(input.reason).trim().slice(0, 255);
  if (!('reason' in input)) throw invalid('INVALID', 'Say why this machine needs no maintenance cycle.');
  await db.query('UPDATE cf_machines SET no_plan_reason = ? WHERE company_id = ? AND id = ?', [reason, c.companyId, m.id]);
  return { id: m.id, code: m.code, noPlanReason: reason };
}

// --- spares against the store's stock ----------------------------------------------------------------------

/**
 * The spares on the machines' lists that the store is short of: at or under the item's minimum, or — with no minimum
 * set — none in stock at all. → [{ item, stock, min, machines: [code], noMinimum }]
 */
export async function sparesToWatch(db, companyId) {
  try {
    const [rows] = await db.query(
      `SELECT m.id, m.code, m.name, i.uom, ps.min_qty,
              COALESCE((SELECT SUM(k.quantity) FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
                         WHERE k.company_id = m.company_id AND k.item_id = m.id AND a.purpose = 'storage' AND a.deleted_at IS NULL), 0) AS stock,
              GROUP_CONCAT(DISTINCT mc.code ORDER BY mc.code SEPARATOR ', ') AS machines, COUNT(DISTINCT mc.id) AS machine_n
         FROM cf_machine_resources r
         JOIN cf_machines mc ON mc.id = r.machine_id AND mc.deleted_at IS NULL AND mc.status = 'active'
         JOIN cf_master_records m ON m.id = r.item_id AND ${STORES_ITEM}
         JOIN cf_item_details i ON i.master_id = m.id
         LEFT JOIN cf_procurement_settings ps ON ps.company_id = m.company_id AND ps.master_id = m.id
        WHERE r.company_id = ? AND r.deleted_at IS NULL AND r.kind = 'spare'
        GROUP BY m.id, m.code, m.name, i.uom, ps.min_qty
       HAVING (ps.min_qty IS NOT NULL AND ps.min_qty > 0 AND stock <= ps.min_qty) OR ((ps.min_qty IS NULL OR ps.min_qty = 0) AND stock <= 0)
        ORDER BY stock, m.name LIMIT 200`, [companyId]);
    return rows.map((r) => ({
      item: { id: r.id, code: r.code, name: r.name, uom: r.uom }, stock: num(r.stock), min: r.min_qty == null || num(r.min_qty) === 0 ? null : num(r.min_qty),
      noMinimum: r.min_qty == null || num(r.min_qty) === 0, machines: r.machines, machineCount: num(r.machine_n),
    }));
  } catch (e) { if (missing(e)) return []; throw e; }
}

// --- wear: what was recorded worn out or lost --------------------------------------------------------------

const WEAR_SELECT = `SELECT e.id, e.kind, e.quantity, e.note, e.created_at, e.days_used, e.reviewed_at, e.review_note, ru.name AS reviewed_by_name,
       c.issued_on, c.holder_type, m.id AS item_id, m.code AS item_code, m.name AS item_name, i.uom, i.life_days,
       pe.name AS person_name, dp.name AS department_name, pa.name AS party_name, mc.code AS machine_code, so.code AS order_code,
       DATEDIFF(e.created_at, c.issued_on) AS days_calc
  FROM cf_stock_custody_events e
  JOIN cf_stock_custody c ON c.id = e.custody_id
  JOIN cf_master_records m ON m.id = c.item_id
  JOIN cf_item_details i ON i.master_id = c.item_id
  LEFT JOIN cf_store_people pe ON pe.id = c.person_id
  LEFT JOIN cf_departments dp ON dp.id = c.department_id
  LEFT JOIN cf_parties pa ON pa.id = c.party_id
  LEFT JOIN cf_machines mc ON mc.id = c.machine_id
  LEFT JOIN cf_sales_orders so ON so.id = c.order_id
  LEFT JOIN users ru ON ru.id = e.reviewed_by`;

function shapeWear(r, S) {
  const days = r.days_used != null ? Number(r.days_used) : Math.max(0, num(r.days_calc));
  const life = r.life_days == null ? null : Number(r.life_days);
  const early = r.kind === 'worn' && life != null && life > 0 && days < (life * Number(S.maint_early_wear_pct)) / 100;
  return {
    id: r.id, kind: r.kind, quantity: num(r.quantity), note: r.note ?? null, at: r.created_at,
    item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom },
    wasWith: r.holder_type === 'vendor' ? r.party_name : r.person_name ?? r.department_name ?? null,
    department: r.department_name ?? null, machine: r.machine_code ?? null, order: r.order_code ?? null,
    daysUsed: days, lifeDays: life, early, lifePct: life ? Math.round((days / life) * 100) : null,
    reviewed: r.reviewed_at ? { at: r.reviewed_at, by: r.reviewed_by_name ?? null, note: r.review_note ?? null } : null,
  };
}

/** Worn-out and lost entries of the last N days (settings) that maintenance has not read yet; ?all=1 includes the read ones. */
export async function wearToReview(db, companyId, q = {}, S = null) {
  const set = S ?? await getSettings(db, companyId);
  try {
    const [rows] = await db.query(
      `${WEAR_SELECT} WHERE e.company_id = ? AND e.kind IN ('worn', 'lost') AND e.created_at >= NOW() - INTERVAL ? DAY
         ${String(q.all) === '1' ? '' : 'AND e.reviewed_at IS NULL'} ORDER BY e.id DESC LIMIT 300`, [companyId, Number(set.maint_wear_review_days)]);
    return rows.map((r) => shapeWear(r, set));
  } catch (e) { if (missing(e)) return []; throw e; }
}

/** POST /maintenance/wear/:id/review { note } — maintenance has read it: what was found (misuse, a bad batch, fair wear). */
export async function reviewWear(db, c, id, input = {}) {
  const note = blank(input.note) ? null : String(input.note).trim().slice(0, 500);
  if (!note) throw invalid('REASON', 'Say what you found: fair wear, wrong use, a bad batch.');
  const [r] = await db.query("UPDATE cf_stock_custody_events SET reviewed_at = NOW(), reviewed_by = ?, review_note = ? WHERE company_id = ? AND id = ? AND kind IN ('worn', 'lost')",
    [c.userId ?? null, note, c.companyId, Number(id)]);
  if (!r.affectedRows) throw notFound('This entry');
  return { id: Number(id), reviewed: true };
}

// --- tool rules: life, and what to check before giving out -------------------------------------------------

/** GET /maintenance/tool-rules?search=&set=1 — the things that come back to the store (returnable), with their rules. */
export async function toolRules(db, companyId, q = {}) {
  const where = ['m.company_id = ?', STORES_ITEM, "i.stores_kind = 'returnable'"];
  const args = [companyId];
  if (!blank(q.search)) { where.push('(m.name LIKE ? OR m.code LIKE ?)'); const s = `%${String(q.search).trim()}%`; args.push(s, s); }
  if (String(q.set) === '1') where.push('(i.life_days IS NOT NULL OR i.issue_conditions IS NOT NULL)');
  try {
    const [rows] = await db.query(
      `SELECT m.id, m.code, m.name, i.uom, i.life_days, i.issue_conditions, i.due_days,
              (SELECT COUNT(*) FROM cf_stock_custody_events e JOIN cf_stock_custody c ON c.id = e.custody_id
                WHERE e.company_id = m.company_id AND c.item_id = m.id AND e.kind = 'worn' AND e.created_at >= NOW() - INTERVAL 365 DAY) AS worn_n,
              (SELECT ROUND(AVG(COALESCE(e.days_used, DATEDIFF(e.created_at, c.issued_on)))) FROM cf_stock_custody_events e JOIN cf_stock_custody c ON c.id = e.custody_id
                WHERE e.company_id = m.company_id AND c.item_id = m.id AND e.kind = 'worn' AND e.created_at >= NOW() - INTERVAL 365 DAY) AS worn_avg_days
         FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
        WHERE ${where.join(' AND ')} ORDER BY (i.life_days IS NULL AND i.issue_conditions IS NULL), m.name LIMIT 500`, args);
    return { rows: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, uom: r.uom, lifeDays: r.life_days == null ? null : Number(r.life_days), issueConditions: r.issue_conditions ?? null,
      dueDays: r.due_days == null ? null : Number(r.due_days), wornLastYear: num(r.worn_n), wornAfterDays: r.worn_avg_days == null ? null : Number(r.worn_avg_days) })) };
  } catch (e) { if (missing(e)) return { rows: [] }; throw e; }
}

/** PUT /maintenance/tool-rules/:itemId { lifeDays?: number | null, issueConditions?: string | null } */
export async function setToolRule(db, c, itemId, input = {}) {
  const [[it]] = await db.query(`SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.company_id = ? AND m.id = ? AND ${STORES_ITEM}`, [c.companyId, Number(itemId)]);
  if (!it) throw notFound('Item');
  const sets = []; const args = [];
  if ('lifeDays' in input) {
    if (blank(input.lifeDays)) sets.push('life_days = NULL');
    else { const n = Number(input.lifeDays); if (!Number.isInteger(n) || n < 1 || n > 36500) throw invalid('INVALID', 'The life is a whole number of days.'); sets.push('life_days = ?'); args.push(n); }
  }
  if ('issueConditions' in input) { sets.push('issue_conditions = ?'); args.push(blank(input.issueConditions) ? null : String(input.issueConditions).trim().slice(0, 1000)); }
  if (!sets.length) throw invalid('INVALID', 'Nothing to change.');
  await db.query(`UPDATE cf_item_details SET ${sets.join(', ')} WHERE master_id = ?`, [...args, it.id]);
  return { id: it.id };
}

// --- machine health ----------------------------------------------------------------------------------------

/**
 * A row a live machine over the last N days (settings): breakdowns, hours down, average repair time, days between
 * breakdowns, cost, preventive jobs done on time, and whether it has a cycle. Worst first.
 */
export async function machineHealth(db, companyId, S = null) {
  const set = S ?? await getSettings(db, companyId);
  const days = Number(set.maint_health_days);
  let rows;
  try {
    [rows] = await db.query(
      `SELECT mc.id, mc.code, mc.name, mc.owner_name, mc.no_plan_reason,
              (SELECT COUNT(*) FROM cf_maintenance_plans p WHERE p.company_id = mc.company_id AND p.machine_id = mc.id AND p.deleted_at IS NULL AND p.status = 'active') AS plans,
              SUM(mo.source = 'fault' AND mo.false_alarm = 0 AND mo.status <> 'cancelled') AS faults,
              SUM(IF(mo.source = 'fault' AND mo.false_alarm = 0 AND mo.status = 'done', mo.downtime_minutes, 0)) AS fault_minutes,
              SUM(mo.source = 'fault' AND mo.false_alarm = 0 AND mo.status = 'done' AND mo.downtime_minutes IS NOT NULL) AS fault_done,
              SUM(IF(mo.status = 'done', COALESCE(mo.downtime_minutes, 0), 0)) AS down_minutes,
              SUM(IF(mo.status = 'done', COALESCE(mo.parts_cost, 0) + COALESCE(mo.other_cost, 0), 0)) AS cost,
              SUM(mo.source = 'preventive' AND mo.status = 'done') AS pm_done,
              SUM(mo.source = 'preventive' AND mo.status = 'done' AND (mo.due_at IS NULL OR mo.done_at <= mo.due_at)) AS pm_on_time,
              SUM(mo.status IN ('open','in_progress','waiting_parts')) AS open_n
         FROM cf_machines mc
         LEFT JOIN cf_maintenance_orders mo ON mo.company_id = mc.company_id AND mo.machine_id = mc.id AND mo.deleted_at IS NULL
              AND (mo.raised_at >= NOW() - INTERVAL ? DAY OR mo.status IN ('open','in_progress','waiting_parts'))
        WHERE mc.company_id = ? AND mc.deleted_at IS NULL AND mc.status = 'active' AND COALESCE(mc.kind, 'machine') = 'machine' AND COALESCE(mc.stage, 'live') = 'live'
        GROUP BY mc.id, mc.code, mc.name, mc.owner_name, mc.no_plan_reason LIMIT 1000`, [days, companyId]);
  } catch (e) { if (missing(e)) return { days, rows: [] }; throw e; }
  const due = new Map();
  try { for (const p of await planStatus(db, companyId, {})) if (p.due) due.set(p.machine.id, (due.get(p.machine.id) ?? 0) + 1); } catch (e) { if (!missing(e)) throw e; }
  const out = rows.map((r) => {
    const faults = num(r.faults);
    const done = num(r.fault_done);
    const pm = num(r.pm_done);
    return {
      id: r.id, code: r.code, name: r.name, owner: r.owner_name ?? null,
      faults, downHours: r1(num(r.down_minutes) / 60), repairHours: done ? r1(num(r.fault_minutes) / done / 60) : null,
      daysBetweenFaults: faults ? r1(days / faults) : null, cost: Math.round(num(r.cost)), openTickets: num(r.open_n),
      preventiveDone: pm, preventiveOnTimePct: pm ? Math.round((num(r.pm_on_time) / pm) * 100) : null, preventiveDue: due.get(r.id) ?? 0,
      cycle: num(r.plans) > 0 ? 'set' : r.no_plan_reason ? 'none_needed' : 'missing', noPlanReason: r.no_plan_reason ?? null,
    };
  });
  out.sort((a, b) => b.faults - a.faults || b.downHours - a.downHours || a.code.localeCompare(b.code));
  return { days, rows: out };
}

// --- the page ----------------------------------------------------------------------------------------------

/** People a ticket can be given to: the company's active people (the admin panel says who may work in maintenance). */
async function people(db, companyId) {
  try {
    const [rows] = await db.query('SELECT id, name FROM users WHERE company_id = ? AND deleted_at IS NULL AND deactivated_at IS NULL ORDER BY name LIMIT 500', [companyId]);
    return rows;
  } catch (e) {
    if (!missing(e)) throw e;
    const [rows] = await db.query('SELECT id, name FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY name LIMIT 500', [companyId]);
    return rows;
  }
}

/** GET /maintenance/today → everything maintenance has to clear, in one read. */
export async function today(db, c) {
  const S = await getSettings(db, c.companyId);
  await ensureDue(db, c.companyId);
  const [orders, noPlan, spares, wear, who] = await Promise.all([
    listOrders(db, c.companyId, { status: 'active' }), machinesWithoutPlan(db, c.companyId), sparesToWatch(db, c.companyId), wearToReview(db, c.companyId, {}, S), people(db, c.companyId),
  ]);
  const rank = (o) => (o.late ? 0 : o.machineDown ? 1 : o.status === 'waiting_parts' ? 2 : 3);
  const tickets = [...orders.rows].sort((a, b) => rank(a) - rank(b) || (b.lateMinutes - a.lateMinutes) || String(a.dueAt ?? '9').localeCompare(String(b.dueAt ?? '9')));
  return {
    now: orders.now,
    counts: {
      open: tickets.length, late: tickets.filter((t) => t.late).length, down: tickets.filter((t) => t.machineDown).length,
      waitingParts: tickets.filter((t) => t.status === 'waiting_parts').length, noOwner: tickets.filter((t) => !t.owner).length,
      setups: tickets.filter((t) => t.source === 'setup').length, mine: tickets.filter((t) => t.owner?.id === c.userId).length,
      noPlan: noPlan.length, spares: spares.length, wear: wear.length, wearEarly: wear.filter((w) => w.early).length,
    },
    tickets, noPlan, spares, wear, people: who.map((u) => ({ id: u.id, name: u.name })),
    targets: { fault: Number(S.maint_target_fault_hours), preventive: Number(S.maint_target_preventive_hours), setup: Number(S.maint_target_setup_hours), manual: Number(S.maint_target_manual_hours) },
  };
}

// --- the alerts (run by departmentAlerts.findDepartmentAlerts) ---------------------------------------------

export const MAINTENANCE_DESK_KINDS = ['ticket_late', 'machine_no_plan', 'spare_low', 'tool_worn_early'];
export const MAINTENANCE_DESK_KIND_LABEL = { ticket_late: 'Ticket past its target', machine_no_plan: 'Machine with no cycle', spare_low: 'Spare running low', tool_worn_early: 'Tool worn early' };

export async function findMaintenanceDeskAlerts(db, companyId, S) {
  const out = [];
  await ensureDue(db, companyId);
  const { rows } = await listOrders(db, companyId, { status: 'active' });
  for (const t of rows) {
    if (!t.late || t.lateMinutes < Number(S.alert_ticket_late_hours) * 60) continue;
    const md = t.lateMinutes >= Number(S.md_ticket_late_hours) * 60;
    const what = { fault: 'Breakdown', preventive: 'Preventive job', setup: 'Machine set-up', manual: 'Job' }[t.source] ?? 'Ticket';
    out.push({
      key: `ticket_late:${t.id}`, kind: 'ticket_late', severity: md ? 'danger' : 'warning',
      title: `${t.code} · ${t.machine.code}: ${what.toLowerCase()} is ${hoursText(t.lateMinutes)} past its target`,
      detail: `${t.title}. Due ${String(t.dueAt).slice(0, 16)}. ${t.owner ? `Owner: ${t.owner.name}.` : 'Nobody owns this ticket yet.'}${t.status === 'waiting_parts' ? ' Waiting for parts.' : ''}`,
      departments: ['maintenance', ...(md ? ['md'] : [])], subjectType: 'maintenance_order', subjectId: t.id, link: `maintenance-orders/${t.id}`, daysLate: Math.round((t.lateMinutes / 1440) * 100) / 100,
    });
  }
  const noPlan = await machinesWithoutPlan(db, companyId);
  if (noPlan.length) {
    out.push({
      key: 'machine_no_plan', kind: 'machine_no_plan', severity: 'warning',
      title: `${plural(noPlan.length, 'machine')} ${noPlan.length === 1 ? 'has' : 'have'} no maintenance cycle`,
      detail: `${noPlan.slice(0, 6).map((m) => m.code).join(', ')}${noPlan.length > 6 ? ` and ${noPlan.length - 6} more` : ''}. Set a cycle for each on Maintenance today, or say why it needs none.`,
      departments: ['maintenance'], link: 'maintenance-today', count: noPlan.length,
    });
  }
  const spares = await sparesToWatch(db, companyId);
  if (spares.length) {
    out.push({
      key: 'spare_low', kind: 'spare_low', severity: spares.some((s) => s.stock <= 0) ? 'danger' : 'warning',
      title: `${plural(spares.length, 'machine spare')} ${spares.length === 1 ? 'is' : 'are'} short in the store`,
      detail: `${spares.slice(0, 4).map((s) => `${s.item.name} (${s.stock} ${s.item.uom ?? ''}, for ${s.machines})`).join('; ')}${spares.length > 4 ? ` and ${spares.length - 4} more` : ''}.`,
      departments: ['maintenance', 'stores'], link: 'maintenance-today', count: spares.length,
    });
  }
  const wear = (await wearToReview(db, companyId, {}, S)).filter((w) => w.early);
  for (const w of wear) {
    out.push({
      key: `tool_worn_early:${w.id}`, kind: 'tool_worn_early', severity: 'warning',
      title: `${w.item.name} wore out in ${plural(w.daysUsed, 'day')} — it should last ${w.lifeDays}`,
      detail: `${w.wasWith ? `Was with ${w.wasWith}. ` : ''}${w.note ? `Stores wrote: ${w.note}. ` : ''}Read it and record what you found on Maintenance today.`,
      departments: ['maintenance'], subjectType: 'custody_event', subjectId: w.id, link: 'maintenance-today',
    });
  }
  return out;
}
