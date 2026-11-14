/**
 * alertService.js — CF_ERP ALERTS (init.sql §110; user, 2026-11-14):
 *
 *   "alerts for different sorts of delays, like delays in procurement, delays in start of an activity and start of
 *    unplanned activity, delays in completion on previous activities. And these should be filtered alerts and right
 *    departments should get the notifications."
 *   "procurement manager should have ability to change the procurement dates of each line based on any new update
 *    that he received from vendor and an alert should go to stores, planning and MD"
 *
 * ONE ROW PER MATTER, NOT PER STEP. A late start is "12 Cutting steps of SO260021-P01 have not started — planned from
 * 13 Nov 08:00", not twelve alerts: the check groups by production order × operation (and a purchase order by PO),
 * and finds the same row again next time by its dedupe_key. What the check no longer finds is resolved by itself.
 *
 * KINDS, AND WHO GETS THEM
 *   po_date_moved    a PO / PO line's expected date moved (the vendor's word in the note) → stores, planning, md,
 *                    purchase. Raised by the change itself; a person closes it.
 *   po_late          PO lines past their expected date with quantity still to come → purchase, stores, planning;
 *                    the MD as well past PO_LATE_MD_DAYS.
 *   start_late       steps the planner put to start before now − GRACE, still not started → planning, floor; the MD
 *                    as well past a day.
 *   unplanned_start  steps started that the plan does not have, or started a day or more ahead of their slot, on an
 *                    order the planner did plan → planning, md.
 *   finish_late      steps the planner put to finish before now − GRACE, not done → planning, floor (the next
 *                    steps wait on them); the MD as well past a day.
 * Delays of activities read the planner's slots (cf_plan3_steps) against the floor (cf_production_steps): nothing is
 * said about an order the planner has not planned.
 *
 * WHEN. checkCompany() on a timer (startAlertChecks, every CHECK_MS, production only) and on reading the alerts when
 * the last check is older than STALE_MS — so a screen never shows an hour-old picture.
 */
import { invalid, notFound } from '../lib/errors.js';

export const DEPARTMENTS = {
  md: ['cf_erp_plate_change_approve', 'cf_erp_approve_month_plan', 'cf_erp_approve_purchase_order'],
  planning: ['cf_erp_production_manage'],
  stores: ['cf_erp_stores', 'cf_erp_inventory_manage'],
  purchase: ['cf_erp_purchase'],
  floor: ['cf_erp_floor'],
};
export const DEPARTMENT_LABEL = { md: 'MD', planning: 'Planning', stores: 'Stores', purchase: 'Purchase', floor: 'Shop floor' };
export const KIND_LABEL = {
  po_date_moved: 'Delivery date moved', po_late: 'Procurement late', start_late: 'Start late', unplanned_start: 'Unplanned start', finish_late: 'Finish late',
};
/** The kinds the check finds (and resolves); po_date_moved is raised by the change and closed by a person. */
const CHECKED = ['po_late', 'start_late', 'unplanned_start', 'finish_late'];

const GRACE_MIN = 60;          // a step an hour behind its slot is not yet an alert
const PO_LATE_MD_DAYS = 3;
const CHECK_MS = 10 * 60 * 1000;
const STALE_MS = 3 * 60 * 1000;
const lastCheck = new Map();   // companyId -> ms

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const when = (d) => {
  if (!d) return '';
  const t = d instanceof Date ? d : new Date(String(d).replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};
const dateText = (d) => {
  if (!d) return 'none';
  const t = d instanceof Date ? d : new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** The departments a person is in, from their tags (an admin is in every one). */
export function departmentsOf(can) {
  return Object.entries(DEPARTMENTS).filter(([, tags]) => tags.some((t) => can(t))).map(([d]) => d);
}

/** Inserts or refreshes one alert by its key; a resolved one found again opens again. */
export async function raise(db, companyId, a) {
  const deps = [...new Set(a.departments)].join(',');
  await db.query(
    `INSERT INTO cf_alerts (company_id, dedupe_key, kind, severity, title, detail, departments, order_id, order_code, production_order_id,
                            operation_id, operation_name, subject_type, subject_id, link, days_late, count_n, status, first_at, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NOW(), NOW())
     ON DUPLICATE KEY UPDATE severity = VALUES(severity), title = VALUES(title), detail = VALUES(detail), departments = VALUES(departments),
       order_id = VALUES(order_id), order_code = VALUES(order_code), production_order_id = VALUES(production_order_id),
       operation_id = VALUES(operation_id), operation_name = VALUES(operation_name), link = VALUES(link),
       days_late = VALUES(days_late), count_n = VALUES(count_n), last_at = NOW(),
       status = IF(status = 'resolved', 'open', status), resolved_at = IF(status = 'resolved', NULL, resolved_at), resolved_by = IF(status = 'resolved', NULL, resolved_by)`,
    [companyId, a.key.slice(0, 160), a.kind, a.severity ?? 'warning', a.title.slice(0, 300), a.detail ? String(a.detail).slice(0, 1000) : null, deps,
      a.orderId ?? null, a.orderCode ?? null, a.productionOrderId ?? null, a.operationId ?? null, a.operationName ?? null,
      a.subjectType ?? null, a.subjectId ?? null, a.link ?? null, a.daysLate ?? null, a.count ?? null],
  );
}

// --- the checks --------------------------------------------------------------------------

/** PO lines past their expected date with something still to come, one alert per purchase order. */
async function findPoLate(db, companyId) {
  const [rows] = await db.query(
    `SELECT p.id, p.code, s.name AS supplier, COUNT(*) AS n,
            MIN(COALESCE(l.expected_date, p.expected_date)) AS due, DATEDIFF(CURDATE(), MIN(COALESCE(l.expected_date, p.expected_date))) AS days,
            MAX(p.for_order_id) AS for_order_id, MAX(so.code) AS order_code
       FROM cf_purchase_order_lines l
       JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
       LEFT JOIN cf_parties s ON s.id = p.supplier_id
       LEFT JOIN cf_sales_orders so ON so.id = p.for_order_id
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND p.status IN ('ordered', 'partially_received')
        AND l.quantity - l.qty_received - COALESCE(l.qty_closed, 0) > 0.000001
        AND COALESCE(l.expected_date, p.expected_date) < CURDATE()
      GROUP BY p.id, p.code, s.name`,
    [companyId],
  );
  return rows.map((r) => {
    const days = Number(r.days);
    return {
      key: `po_late:${r.id}`, kind: 'po_late', severity: days > PO_LATE_MD_DAYS ? 'danger' : 'warning',
      title: `${r.code}${r.supplier ? ` · ${r.supplier}` : ''}: ${r.n} line${Number(r.n) === 1 ? '' : 's'} overdue by ${days} day${days === 1 ? '' : 's'}`,
      detail: `Expected by ${dateText(r.due)} and not received. Ask the vendor for a new date and set it on the line, so the plan moves with it.`,
      departments: ['purchase', 'stores', 'planning', ...(days > PO_LATE_MD_DAYS ? ['md'] : [])],
      orderId: r.for_order_id ?? null, orderCode: r.order_code ?? null, subjectType: 'purchase_order', subjectId: r.id,
      link: `purchase-orders/${r.id}`, daysLate: days, count: Number(r.n),
    };
  });
}

/** Steps of planned orders against their slots: late starts, late finishes and unplanned starts, per PO × operation. */
async function findStepDelays(db, companyId) {
  const [late] = await db.query(
    `SELECT s.production_order_id AS po_id, po.code AS po_code, r.order_id, so.code AS order_code, s.operation_id, o.name AS op_name,
            SUM(s.state = 'pending' AND p.planned_start < NOW() - INTERVAL ${GRACE_MIN} MINUTE) AS start_n,
            MIN(IF(s.state = 'pending' AND p.planned_start < NOW() - INTERVAL ${GRACE_MIN} MINUTE, p.planned_start, NULL)) AS start_from,
            SUM(s.state <> 'done' AND p.planned_end < NOW() - INTERVAL ${GRACE_MIN} MINUTE) AS finish_n,
            MIN(IF(s.state <> 'done' AND p.planned_end < NOW() - INTERVAL ${GRACE_MIN} MINUTE, p.planned_end, NULL)) AS finish_from
       FROM cf_plan3_steps p
       JOIN cf_production_steps s ON s.id = p.step_id AND s.deleted_at IS NULL
       JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
       JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
       JOIN cf_sales_orders so ON so.id = r.order_id AND so.deleted_at IS NULL AND so.status = 'confirmed'
       JOIN cf_operations o ON o.id = s.operation_id
       LEFT JOIN cf_production_orders po ON po.id = s.production_order_id
      WHERE p.company_id = ? AND s.state <> 'done'
      GROUP BY s.production_order_id, po.code, r.order_id, so.code, s.operation_id, o.name`,
    [companyId],
  );
  const out = [];
  const hours = (t) => (Date.now() - new Date(t).getTime()) / 3600000;
  for (const g of late) {
    const where = g.po_code ?? g.order_code;
    const base = { orderId: g.order_id, orderCode: g.order_code, productionOrderId: g.po_id ?? null, operationId: g.operation_id, operationName: g.op_name, link: `tracker?view=steps&group=order_machine&status=open` };
    // A late finish says it all for that operation; the late start is only its own alert when nothing is said yet.
    if (Number(g.finish_n) > 0) {
      const d = r2(hours(g.finish_from) / 24);
      out.push({
        ...base, key: `finish_late:${g.po_id ?? `o${g.order_id}`}:${g.operation_id}`, kind: 'finish_late', severity: d >= 1 ? 'danger' : 'warning',
        title: `${where}: ${g.finish_n} ${g.op_name} step${Number(g.finish_n) === 1 ? '' : 's'} not finished — due by ${when(g.finish_from)}`,
        detail: 'Planned to be done by now. The steps after them wait; check what holds them, or re-run the plan.',
        departments: ['planning', 'floor', ...(d >= 1 ? ['md'] : [])], daysLate: d, count: Number(g.finish_n),
      });
    } else if (Number(g.start_n) > 0) {
      const d = r2(hours(g.start_from) / 24);
      out.push({
        ...base, key: `start_late:${g.po_id ?? `o${g.order_id}`}:${g.operation_id}`, kind: 'start_late', severity: d >= 1 ? 'danger' : 'warning',
        title: `${where}: ${g.start_n} ${g.op_name} step${Number(g.start_n) === 1 ? '' : 's'} not started — planned from ${when(g.start_from)}`,
        detail: 'Planned to have started by now. Start them on the floor, or see in Steps what they wait for.',
        departments: ['planning', 'floor', ...(d >= 1 ? ['md'] : [])], daysLate: d, count: Number(g.start_n),
      });
    }
  }
  // Unplanned starts: started in the last 3 days on an order the planner planned, with no slot, or a day+ ahead of it.
  const [unplanned] = await db.query(
    `SELECT s.production_order_id AS po_id, po.code AS po_code, r.order_id, so.code AS order_code, s.operation_id, o.name AS op_name,
            COUNT(*) AS n, MIN(s.started_at) AS first_start, SUM(p.step_id IS NULL) AS no_slot
       FROM cf_production_steps s
       JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
       JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
       JOIN cf_sales_orders so ON so.id = r.order_id AND so.deleted_at IS NULL AND so.status = 'confirmed'
       JOIN cf_operations o ON o.id = s.operation_id
       LEFT JOIN cf_production_orders po ON po.id = s.production_order_id
       LEFT JOIN cf_plan3_steps p ON p.step_id = s.id AND p.company_id = s.company_id
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.started_at >= NOW() - INTERVAL 3 DAY
        AND s.production_order_id IN (SELECT production_order_id FROM cf_plan3_orders WHERE company_id = ?)
        AND (p.step_id IS NULL OR p.planned_start > s.started_at + INTERVAL 1 DAY)
      GROUP BY s.production_order_id, po.code, r.order_id, so.code, s.operation_id, o.name`,
    [companyId, companyId],
  );
  for (const g of unplanned) {
    out.push({
      key: `unplanned_start:${g.po_id ?? `o${g.order_id}`}:${g.operation_id}`, kind: 'unplanned_start', severity: 'warning',
      title: `${g.po_code ?? g.order_code}: ${g.n} ${g.op_name} step${Number(g.n) === 1 ? '' : 's'} started outside the plan`,
      detail: `${Number(g.no_slot) === Number(g.n) ? 'Not in the plan at all' : Number(g.no_slot) ? `${g.no_slot} not in the plan, the rest a day or more early` : 'Started a day or more ahead of the plan'} — first at ${when(g.first_start)}. Machine time went to work the plan did not expect; re-run the plan if it should count.`,
      departments: ['planning', 'md'], orderId: g.order_id, orderCode: g.order_code, productionOrderId: g.po_id ?? null,
      operationId: g.operation_id, operationName: g.op_name, link: 'tracker?view=steps&group=order_machine&status=open', count: Number(g.n),
    });
  }
  return out;
}

/** Runs every check for a company: raises what it finds, resolves what it no longer finds. */
export async function checkCompany(db, companyId) {
  const found = [];
  let planOk = true;
  try { found.push(...(await findPoLate(db, companyId))); } catch (e) { console.error('[cf_erp alerts] po_late:', e?.message ?? e); }
  try { found.push(...(await findStepDelays(db, companyId))); } catch (e) { planOk = false; console.error('[cf_erp alerts] steps:', e?.message ?? e); }
  for (const a of found) await raise(db, companyId, a);
  const keys = found.map((a) => a.key);
  // A check that failed resolves nothing it would have found.
  const kinds = planOk ? CHECKED : ['po_late'];
  await db.query(
    `UPDATE cf_alerts SET status = 'resolved', resolved_at = NOW() WHERE company_id = ? AND status <> 'resolved' AND kind IN (?)
       ${keys.length ? 'AND dedupe_key NOT IN (?)' : ''}`,
    keys.length ? [companyId, kinds, keys] : [companyId, kinds],
  );
  lastCheck.set(companyId, Date.now());
  return { found: found.length };
}

/** Checks again when the last check is older than STALE_MS (a read never waits on a fresh one twice in a row). */
async function fresh(db, companyId) {
  const at = lastCheck.get(companyId) ?? 0;
  if (Date.now() - at < STALE_MS) return;
  lastCheck.set(companyId, Date.now());
  await checkCompany(db, companyId);
}

// --- reading and acting ------------------------------------------------------------------------

const shape = (r) => ({
  id: r.id, kind: r.kind, kindLabel: KIND_LABEL[r.kind] ?? r.kind, severity: r.severity, title: r.title, detail: r.detail,
  departments: String(r.departments).split(',').filter(Boolean),
  order: r.order_id ? { id: r.order_id, code: r.order_code } : null, productionOrderId: r.production_order_id,
  operation: r.operation_id ? { id: r.operation_id, name: r.operation_name } : null,
  subject: r.subject_type ? { type: r.subject_type, id: r.subject_id } : null, link: r.link,
  daysLate: r.days_late == null ? null : Number(r.days_late), count: r.count_n,
  status: r.status, firstAt: r.first_at, lastAt: r.last_at, ackedAt: r.acked_at, ackedBy: r.acked_name ?? null,
});

/**
 * GET /alerts?status=open|acknowledged|active|resolved&department=&kind=&orderId=&all=1
 *   The alerts addressed to the person's departments (all=1: every department — an admin's or the MD's look).
 *   active (default) = open + acknowledged. Newest danger first. Also the counts by kind, department and order.
 */
export async function listAlerts(db, companyId, can, q = {}) {
  await fresh(db, companyId);
  const mine = departmentsOf(can);
  const all = String(q.all) === '1';
  const deps = q.department ? [String(q.department)] : all ? Object.keys(DEPARTMENTS) : mine;
  const status = String(q.status ?? 'active');
  const where = ['a.company_id = ?'];
  const args = [companyId];
  if (status === 'active') where.push("a.status IN ('open', 'acknowledged')");
  else { where.push('a.status = ?'); args.push(status); }
  if (q.kind) { where.push('a.kind = ?'); args.push(String(q.kind)); }
  if (q.orderId) { where.push('a.order_id = ?'); args.push(Number(q.orderId)); }
  if (!deps.length) return { departments: mine, alerts: [], counts: { total: 0, open: 0, byKind: {}, byDepartment: {} } };
  where.push(`(${deps.map(() => 'FIND_IN_SET(?, a.departments)').join(' OR ')})`);
  args.push(...deps);
  const [rows] = await db.query(
    `SELECT a.*, u.name AS acked_name FROM cf_alerts a LEFT JOIN users u ON u.id = a.acked_by
      WHERE ${where.join(' AND ')}
      ORDER BY a.status = 'open' DESC, a.severity = 'danger' DESC, a.last_at DESC LIMIT 300`,
    args,
  );
  const alerts = rows.map(shape);
  const byKind = {};
  const byDepartment = {};
  for (const a of alerts) {
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    for (const d of a.departments) byDepartment[d] = (byDepartment[d] ?? 0) + 1;
  }
  return { departments: mine, alerts, counts: { total: alerts.length, open: alerts.filter((a) => a.status === 'open').length, byKind, byDepartment } };
}

/** The bell: how many open (not yet acknowledged) alerts reach this person. One read, no check. */
export async function alertCount(db, companyId, can) {
  const deps = departmentsOf(can);
  if (!deps.length) return 0;
  try {
    const [[r]] = await db.query(
      `SELECT COUNT(*) AS n FROM cf_alerts WHERE company_id = ? AND status = 'open' AND (${deps.map(() => 'FIND_IN_SET(?, departments)').join(' OR ')})`,
      [companyId, ...deps],
    );
    return Number(r.n);
  } catch { return 0; }
}

/** POST /alerts/:id/ack { } · /alerts/:id/resolve — someone has it / it is dealt with. */
export async function actOnAlert(db, c, id, action) {
  const [[a]] = await db.query('SELECT id, status FROM cf_alerts WHERE company_id = ? AND id = ?', [c.companyId, Number(id)]);
  if (!a) throw notFound('Alert');
  if (action === 'ack') {
    if (a.status !== 'open') return { id: a.id, status: a.status };
    await db.query("UPDATE cf_alerts SET status = 'acknowledged', acked_by = ?, acked_at = NOW() WHERE company_id = ? AND id = ?", [c.userId ?? null, c.companyId, a.id]);
    return { id: a.id, status: 'acknowledged' };
  }
  if (action === 'resolve') {
    await db.query("UPDATE cf_alerts SET status = 'resolved', resolved_by = ?, resolved_at = NOW() WHERE company_id = ? AND id = ?", [c.userId ?? null, c.companyId, a.id]);
    return { id: a.id, status: 'resolved' };
  }
  throw invalid('ACTION', 'An alert is acknowledged or resolved.');
}

/**
 * A procurement date moved (purchaseService, after the write): the vendor's word goes to Stores, Planning, the MD and
 * Purchase, with what it does to the plan (the planned units it makes late). change: { poId, poCode, supplier,
 * lineId, item, from, to, note, late, orderId, orderCode, changeId }.
 */
export async function raiseDateMoved(db, companyId, ch) {
  const later = ch.from && ch.to ? ch.to > ch.from : !!ch.to;
  const what = ch.item ? `${ch.item} on ${ch.poCode}` : `${ch.poCode} (all its lines without their own date)`;
  const days = ch.from && ch.to ? Math.round((new Date(ch.to) - new Date(ch.from)) / 86400000) : null;
  await raise(db, companyId, {
    key: `po_date_moved:${ch.changeId ?? `${ch.poId}:${ch.lineId ?? 'po'}:${ch.to}`}`, kind: 'po_date_moved',
    severity: later && (ch.late > 0 || (days ?? 0) > PO_LATE_MD_DAYS) ? 'danger' : later ? 'warning' : 'info',
    title: `${what}: delivery ${dateText(ch.from)} → ${dateText(ch.to)}${days ? ` (${days > 0 ? '+' : ''}${days} d)` : ''}`,
    detail: [ch.note ? `Vendor: ${String(ch.note).trim().replace(/[.!?]?$/, '.')}` : null, ch.supplier ? `Supplier ${ch.supplier}.` : null,
      ch.late > 0 ? `${ch.late} planned unit${ch.late === 1 ? '' : 's'} now late — re-run the plan.` : later ? 'The plan uses the new date when it is run next.' : null].filter(Boolean).join(' '),
    departments: ['stores', 'planning', 'md', 'purchase'], orderId: ch.orderId ?? null, orderCode: ch.orderCode ?? null,
    subjectType: 'purchase_order', subjectId: ch.poId, link: `purchase-orders/${ch.poId}`, daysLate: days, count: ch.late ?? null,
  });
}

// --- the timer ------------------------------------------------------------------------------------

/** Every CHECK_MS, each company that has cf_erp: the checks. Production only (or CF_ALERT_CHECKS=1). */
export function startAlertChecks(pool) {
  const on = process.env.CF_ALERT_CHECKS === '1' || (process.env.NODE_ENV === 'production' && process.env.CF_ALERT_CHECKS !== '0');
  if (!on) return;
  const run = async () => {
    try {
      const [cos] = await pool.query("SELECT DISTINCT company_id FROM apps WHERE slug = 'cf_erp' AND deleted_at IS NULL");
      for (const { company_id: id } of cos) {
        try { await checkCompany(pool, Number(id)); } catch (e) { console.error(`[cf_erp alerts] company ${id}:`, e?.message ?? e); }
      }
    } catch (e) { console.error('[cf_erp alerts]', e?.message ?? e); }
  };
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, CHECK_MS);
  if (typeof first.unref === 'function') first.unref();
  if (typeof every.unref === 'function') every.unref();
}
