/**
 * storesDashboardService.js — THE STORES DASHBOARD (user, 2026-11-23: "Instead of 'Today', we should create a proper
 * dashboard for the stores with a bunch of alerts and notifications and actions to be taken. This must include checking on
 * PRs, checking on out machines/tools, monthly audits.")
 *
 * GET /stores-desk/dashboard — one answer:
 *   tiles     the numbers at the top (each opens its list)
 *   actions   what someone has to do, worst first: { key, tone: danger|warning|info, title, detail, count, link, rows[] }
 *   plus the Today page's own parts (purchase orders to follow, after-hours entries, levels to review) and:
 *   audit     this month's audit: lines, audited, days left, waiting for approval
 *   prs       open purchase requests, the ones past dash_pr_stale_days with something still to order first
 *   mrs       open material requests, the ones past dash_mr_stale_days first
 *   out       tools / returnables out (by holder), the ones out too long; machines and tools checked out, overdue first
 *   entry     the stock entry week (stock_entry_until), when it is open
 * Every limit is a company setting (Setup › Settings › Stores: the day).
 */
import { today as todayPage } from './storesTodayService.js';
import { outWith } from './storesDeskService.js';
import { listPrs, listMrs } from './purchaseRequestService.js';
import { listCheckouts } from './machineLifeService.js';
import { entryWindow } from './stockEntryService.js';
import { getSettings } from './settingsService.js';

const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10));
// whole days from d to t, never below 0 (a timestamp read in another time zone may land on the next day)
const daysSince = (d, t) => (d ? Math.max(0, Math.round((new Date(`${t}T00:00:00`) - new Date(`${dateText(d)}T00:00:00`)) / 86400000)) : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function dashboard(db, companyId) {
  const S = await getSettings(db, companyId);
  const [base, prs, mrs, out, checkouts, win] = await Promise.all([
    todayPage(db, companyId),
    listPrs(db, companyId, { status: 'open' }).catch(() => ({ rows: [] })),
    listMrs(db, companyId, {}).catch(() => ({ rows: [] })),
    outWith(db, companyId, {}),
    listCheckouts(db, companyId, {}).catch(() => ({ rows: [] })),
    entryWindow(db, companyId),
  ]);
  const t = base.date;

  // --- purchase requests: something still to order
  const prRows = prs.rows.filter((p) => p.toOrder > 0).map((p) => ({
    id: p.id, code: p.code, statusLabel: p.statusLabel, order: p.order ?? null, requisition: p.requisition ?? null,
    lines: p.lines, toOrder: p.toOrder, vendors: p.vendors, purchaseOrders: p.purchaseOrders.length, age: daysSince(p.createdAt, t),
  })).sort((a, b) => b.age - a.age);
  const prStale = prRows.filter((p) => p.age >= Number(S.dash_pr_stale_days));
  const prNoVendor = prRows.filter((p) => p.vendors === 0);

  // --- material requests still open (something to give out or buy)
  const mrRows = mrs.rows.filter((m) => !m.done).map((m) => ({
    id: m.id, code: m.code, forLabel: m.forLabel, order: m.order ?? null, statusLabel: m.statusLabel, contractor: m.contractor ?? null,
    purchaseRequest: m.purchaseRequest ?? null, age: daysSince(m.raisedAt, t), raisedAt: dateText(m.raisedAt),
  })).sort((a, b) => b.age - a.age);
  const mrStale = mrRows.filter((m) => m.age >= Number(S.dash_mr_stale_days));
  const mrNew = mrRows.filter((m) => m.raisedAt === t);

  // --- out: tools and returnables (stock custody), machines and tools checked out (§104)
  const outLong = base.outTooLong;
  const machinesOut = checkouts.rows.filter((r) => !r.inAt);
  const machinesLate = machinesOut.filter((r) => r.overdue);

  // --- the month's audit
  const month = base.count.month ?? { total: 0, audited: 0, done: true };
  const left = Math.max(0, month.total - month.audited);
  const [y, mo] = t.split('-').map(Number);
  const monthEnd = dateText(new Date(y, mo, 0));
  const daysLeft = daysSince(t, monthEnd);
  const auditLate = left > 0 && daysLeft < Number(S.dash_audit_warn_days);

  const actions = [];
  const add = (a) => { if (a.count > 0) actions.push(a); };
  add({ key: 'audit-approval', tone: 'warning', count: base.count.pending, title: `${plural(base.count.pending, 'audit')} waiting for approval`, detail: 'The book does not change until Management decides.', link: 'approvals' });
  add({
    key: 'audit-month', tone: auditLate ? 'danger' : 'info', count: left,
    title: `This month's audit: ${left} of ${month.total} lines left`,
    detail: `${daysLeft} day${daysLeft === 1 ? '' : 's'} left in the month${month.audited ? ` · ${month.audited} audited` : ''}.`, link: 'stores-count',
  });
  add({ key: 'po-late', tone: 'danger', count: base.purchaseOrders.late, title: `${plural(base.purchaseOrders.late, 'purchase order')} late`, detail: 'Expected and not received — follow up with the supplier.', link: 'receive' });
  add({ key: 'pr-stale', tone: 'warning', count: prStale.length, title: `${plural(prStale.length, 'purchase request')} not ordered after ${S.dash_pr_stale_days} days`, detail: prNoVendor.length ? `${prNoVendor.length} have no vendor asked yet.` : 'Quotes and a purchase order are still to come.', link: 'purchase-requests', rows: prStale.slice(0, 6) });
  add({ key: 'mr-stale', tone: 'warning', count: mrStale.length, title: `${plural(mrStale.length, 'material request')} open after ${S.dash_mr_stale_days} days`, detail: 'Give out what is in store, or raise a PR for the rest.', link: 'material-requests', rows: mrStale.slice(0, 6) });
  add({ key: 'tools-out', tone: 'warning', count: outLong.count, title: `${plural(outLong.count, 'thing')} out too long`, detail: `Out more than ${outLong.longDays} days (or past its own due days) — ask for it back, or mark it worn or lost.`, link: 'stores-out?overdue=1' });
  add({ key: 'machines-late', tone: 'warning', count: machinesLate.length, title: `${plural(machinesLate.length, 'machine or tool', 'machines or tools')} past the date it was due back`, detail: 'Checked out to a person, contractor, order or area.', link: 'machine-custody', rows: machinesLate.slice(0, 6).map((r) => ({ id: r.machine.id, code: r.machine.code, name: r.machine.name, to: r.to?.name ?? null, dueOn: r.dueOn })) });
  add({ key: 'below-min', tone: 'warning', count: base.belowMinimum.count, title: `${plural(base.belowMinimum.count, 'item')} below minimum and not on order`, detail: 'Raise a PR from the item, or check the minimum.', link: 'stores?show=low' });
  add({ key: 'after-hours', tone: 'info', count: base.afterHours.entries.length, title: `${plural(base.afterHours.entries.length, 'entry', 'entries')} made after hours`, detail: `Outside ${base.afterHours.hours.open}–${base.afterHours.hours.close} — look them over and mark them checked.`, link: null });
  add({ key: 'mr-new', tone: 'info', count: mrNew.length, title: `${plural(mrNew.length, 'new material request')} today`, detail: 'Open each to give out or raise a PR.', link: 'material-requests' });
  add({ key: 'po-due', tone: 'info', count: base.purchaseOrders.dueSoon, title: `${plural(base.purchaseOrders.dueSoon, 'purchase order')} due within ${base.purchaseOrders.followDays} days`, detail: 'Expect the goods; keep space.', link: 'receive' });
  add({ key: 'levels', tone: 'info', count: base.levels?.rows?.length ?? 0, title: `${plural(base.levels?.rows?.length ?? 0, 'item')} with a suggested minimum / maximum`, detail: 'Worked out from use — apply or leave.', link: null });
  if (win.open) actions.unshift({ key: 'entry', tone: 'info', count: 1, title: `Stock entry is open until ${win.until}`, detail: 'Type every item as it is on the shelf, split by lot, brand and vendor.', link: 'stock-entry' });
  const rank = { danger: 0, warning: 1, info: 2 };
  actions.sort((a, b) => rank[a.tone] - rank[b.tone]);

  return {
    ...base,
    tiles: {
      mrsOpen: mrRows.length, prsToOrder: prRows.length, posLate: base.purchaseOrders.late, outWith: out.counts.all, outLong: outLong.count,
      machinesOut: machinesOut.length, machinesLate: machinesLate.length, auditLeft: left, auditTotal: month.total, belowMin: base.belowMinimum.count,
    },
    actions,
    audit: { ...month, left, daysLeft, monthEnd, late: auditLate, pending: base.count.pending, rejected: base.count.rejected, lastCount: base.count.lastCount },
    prs: { rows: prRows.slice(0, 12), stale: prStale.length, noVendor: prNoVendor.length, staleDays: Number(S.dash_pr_stale_days) },
    mrs: { rows: mrRows.slice(0, 12), stale: mrStale.length, staleDays: Number(S.dash_mr_stale_days) },
    out: { counts: out.counts, longDays: outLong.longDays, rows: outLong.rows, machines: machinesOut.slice(0, 12).map((r) => ({ id: r.id, machine: r.machine, to: r.to ?? null, takenBy: r.takenBy, outAt: r.outAt, dueOn: r.dueOn, overdue: !!r.overdue })), machinesLate: machinesLate.length },
    entry: win,
  };
}
