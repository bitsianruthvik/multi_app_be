/**
 * maintenance_today_test.mjs — Maintenance today (init.sql §114): the ticket's owner and target, the four alerts, machines
 * with no cycle, spares against the store's stock, worn tools to read, tool rules and what Stores checks at give-out.
 *
 *   cd multi_app_be && node scripts/cf_kepl/maintenance_today_test.mjs        CF_COMPANY=2 (the default)
 *
 * One transaction, ROLLED BACK at the end: nothing is kept.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const St = await imp('apps/cf_erp/services/settingsService.js');
const M = await imp('apps/cf_erp/services/maintenanceService.js');
const T = await imp('apps/cf_erp/services/maintenanceDeskService.js');
const DA = await imp('apps/cf_erp/services/departmentAlerts.js');
const A = await imp('apps/cf_erp/services/alertService.js');
const D = await imp('apps/cf_erp/services/storesDeskService.js');
const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const COMPANY = Number(process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
const refusal = (p) => p.then(() => null, (e) => e);

const db = await pool.getConnection();
try {
  await db.beginTransaction(); attachNodeCache(db);
  const [[user]] = await db.query('SELECT id, name FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id };
  await db.query('DELETE FROM cf_settings WHERE company_id = ?', [COMPANY]);
  St.clearSettingsCache();
  // 2026-11-22: departments and "collected by" are company settings, off by default — this suite runs with both on.
  { const St_ = await imp('apps/cf_erp/services/settingsService.js'); await St_.saveSettings(db, c, { values: { giveout_departments: true, giveout_person: true } }); St_.clearSettingsCache(); }
  const S = await St.getSettings(db, COMPANY, { fresh: true });
  const [[mc]] = await db.query("SELECT id, code FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND COALESCE(kind, 'machine') = 'machine' AND COALESCE(stage, 'live') = 'live' ORDER BY id LIMIT 1", [COMPANY]);
  if (!mc) throw new Error('No live machine in this company.');

  console.log('1. settings and the ticket');
  ok('the targets are settings, in their own group', S.maint_target_fault_hours === 24 && S.maint_target_setup_hours === 168 && St.GROUPS.some((g) => g.key === 'maintenance') && St.SETTINGS.filter((x) => x.group === 'maintenance').length === 7);
  const made = await M.createOrder(db, c, { machineId: mc.id, title: 'Test: change the belt' });
  let mo = await M.getOrder(db, COMPANY, made.order.id);
  ok('a new ticket has a due time from the target hours of its kind', !!mo.dueAt && Math.round((Date.parse(mo.dueAt.replace(' ', 'T') + 'Z') - Date.parse(mo.raisedAt.replace(' ', 'T') + 'Z')) / 3600000) === 72, `${mo.raisedAt} → ${mo.dueAt}`);
  ok('it has no owner and is not late', mo.owner === null && mo.late === false && mo.minutesLeft > 0);
  mo = await M.assignOrder(db, c, mo.id, { ownerUserId: user.id });
  ok('it is given to a person; the history says so', mo.owner?.id === user.id && mo.events.some((e) => e.event === 'assigned' && /Owner/.test(e.note ?? '')));
  ok('a person of another company is refused', (await refusal(M.assignOrder(db, c, mo.id, { ownerUserId: 999999999 })))?.code === 'INVALID');
  const before = await refusal(M.assignOrder(db, c, mo.id, { dueAt: '2000-01-01 10:00' }));
  ok('a due time before it was raised is refused', before?.code === 'INVALID' && /after the ticket was raised/.test(before.message), before?.message);
  const moved = await M.assignOrder(db, c, mo.id, { dueAt: `${mo.dueAt.slice(0, 10)}T${mo.dueAt.slice(11, 16)}` });
  ok('a due time as the screen sends it is taken', moved.dueAt === mo.dueAt.slice(0, 16) + ':00', moved.dueAt);

  console.log('2. late tickets and their alert');
  await db.query('UPDATE cf_maintenance_orders SET raised_at = raised_at - INTERVAL 100 HOUR, due_at = due_at - INTERVAL 100 HOUR WHERE id = ?', [mo.id]);
  mo = await M.getOrder(db, COMPANY, mo.id);
  ok('past its target it is late, by about 28 hours', mo.late === true && Math.abs(mo.lateMinutes - 28 * 60) <= 2, String(mo.lateMinutes));
  let page = await T.today(db, c);
  ok('Maintenance today lists it first, counted as late and as mine', page.tickets[0]?.id === mo.id && page.counts.late >= 1 && page.counts.mine >= 1 && page.people.some((p) => p.id === user.id));
  let found = await T.findMaintenanceDeskAlerts(db, COMPANY, S);
  let a = found.find((x) => x.key === `ticket_late:${mo.id}`);
  ok('a late ticket is an alert to maintenance only', !!a && a.departments.join() === 'maintenance' && a.severity === 'warning' && /Owner/.test(a.detail), a?.title);
  await db.query('UPDATE cf_maintenance_orders SET due_at = due_at - INTERVAL 48 HOUR WHERE id = ?', [mo.id]);
  found = await T.findMaintenanceDeskAlerts(db, COMPANY, S);
  a = found.find((x) => x.key === `ticket_late:${mo.id}`);
  ok('past the MD limit it reaches the MD', a?.departments.includes('md') && a.severity === 'danger');
  const dept = await DA.findDepartmentAlerts(db, COMPANY, S);
  ok('the department check runs these kinds with the others', T.MAINTENANCE_DESK_KINDS.every((k) => dept.ok.includes(k)) && dept.found.some((x) => x.kind === 'ticket_late') && A.KIND_LABEL.ticket_late === 'Ticket past its target');
  const closed = await M.closeOrder(db, c, mo.id, { workDone: 'Belt changed' });
  ok('closed late: it stays "closed late" and leaves the list', closed.order.late === true && closed.order.takenMinutes > 0 && !(await T.today(db, c)).tickets.some((t) => t.id === mo.id));

  console.log('3. machines with no cycle');
  await db.query('UPDATE cf_maintenance_plans SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ?', [COMPANY, mc.id]);
  await db.query('UPDATE cf_machines SET no_plan_reason = NULL WHERE id = ?', [mc.id]);
  let none = await T.machinesWithoutPlan(db, COMPANY);
  ok('a live machine with no plan is listed', none.some((m) => m.id === mc.id));
  found = await T.findMaintenanceDeskAlerts(db, COMPANY, S);
  ok('one alert says how many', found.filter((x) => x.kind === 'machine_no_plan').length === 1 && found.find((x) => x.kind === 'machine_no_plan').count === none.length);
  ok('"needs none" wants a reason key', (await refusal(T.setNoPlan(db, c, mc.id, {})))?.code === 'INVALID');
  await T.setNoPlan(db, c, mc.id, { reason: 'Hand tool bench, nothing to service' });
  ok('with a reason it leaves the list', !(await T.machinesWithoutPlan(db, COMPANY)).some((m) => m.id === mc.id));
  await T.setNoPlan(db, c, mc.id, { reason: null });
  await M.createPlan(db, c, { machineId: mc.id, title: 'Test: grease every month', everyDays: 30 });
  none = await T.machinesWithoutPlan(db, COMPANY);
  ok('with a cycle set it leaves the list', !none.some((m) => m.id === mc.id));
  const health = await T.machineHealth(db, COMPANY, S);
  const h = health.rows.find((r) => r.id === mc.id);
  ok('machine health has the machine with its cycle and its cost columns', health.days === 90 && h?.cycle === 'set' && typeof h.faults === 'number' && typeof h.downHours === 'number' && typeof h.cost === 'number');

  console.log('4. spares against the store');
  const [[area]] = await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const [[spare]] = await db.query(
    `SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND i.item_type = 'catalog' AND i.tracked_by = 'quantity'
        AND NOT EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.item_id = m.id AND k.quantity <> 0) ORDER BY m.id DESC LIMIT 1`, [COMPANY]);
  await db.query("INSERT INTO cf_machine_resources (company_id, machine_id, item_id, kind, qty, created_by) VALUES (?, ?, ?, 'spare', 1, ?)", [COMPANY, mc.id, spare.id, user.id]);
  let sp = (await T.sparesToWatch(db, COMPANY)).find((x) => x.item.id === spare.id);
  ok('a machine spare with none in the store and no minimum is listed', !!sp && sp.stock === 0 && sp.noMinimum === true && sp.machines.includes(mc.code));
  await postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: spare.id, quantity: 3, toAreaId: area.id, unitCost: 100 }] });
  ok('in stock, no minimum: not listed', !(await T.sparesToWatch(db, COMPANY)).some((x) => x.item.id === spare.id));
  await db.query('INSERT INTO cf_procurement_settings (company_id, master_id, method, min_qty, max_qty) VALUES (?, ?, ?, 5, 10) ON DUPLICATE KEY UPDATE min_qty = 5, max_qty = 10', [COMPANY, spare.id, 'buy_min_max']);
  sp = (await T.sparesToWatch(db, COMPANY)).find((x) => x.item.id === spare.id);
  ok('at or under its minimum: listed with the minimum', sp?.stock === 3 && sp.min === 5);
  found = await T.findMaintenanceDeskAlerts(db, COMPANY, S);
  ok('one alert to maintenance and stores', found.filter((x) => x.kind === 'spare_low').length === 1 && found.find((x) => x.kind === 'spare_low').departments.join() === 'maintenance,stores');

  console.log('5. tool rules, give-out and wear');
  const [[tool]] = await db.query(
    `SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND i.item_type = 'catalog' AND i.tracked_by = 'quantity' AND m.id <> ? ORDER BY m.id DESC LIMIT 1 OFFSET 1`, [COMPANY, spare.id]);
  await db.query("UPDATE cf_item_details SET stores_kind = 'returnable', life_days = NULL, issue_conditions = NULL WHERE master_id = ?", [tool.id]);
  await postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: tool.id, quantity: 4, toAreaId: area.id, unitCost: 250 }] });
  ok('the tool is on the rules list', (await T.toolRules(db, COMPANY, { search: tool.name })).rows.some((r) => r.id === tool.id));
  ok('a life of 0 days is refused', (await refusal(T.setToolRule(db, c, tool.id, { lifeDays: 0 })))?.code === 'INVALID');
  await T.setToolRule(db, c, tool.id, { lifeDays: 30, issueConditions: 'Ask what size is being drilled. Bit must match.' });
  const rule = (await T.toolRules(db, COMPANY, { set: 1, search: tool.name })).rows.find((r) => r.id === tool.id);
  ok('life and the check are kept', rule?.lifeDays === 30 && /size/.test(rule.issueConditions));
  const dep = await D.addDepartment(db, c, { name: `Test dept ${Date.now()}` });
  const person = await D.addPerson(db, c, { name: `Test contractor ${Date.now()}`, departmentId: dep.id });
  const give = (extra) => D.giveOut(db, c, { givenFor: { type: 'department', departmentId: dep.id }, personId: person.id, lines: [{ itemId: tool.id, quantity: 2, ...extra }] });
  const no = await refusal(give({}));
  ok('give-out without the check ticked is refused, in the words maintenance wrote', /check before giving it out/.test((no?.problems ?? []).join(' ')) && /size is being drilled/.test((no?.problems ?? []).join(' ')), JSON.stringify(no?.problems ?? no?.message));
  const g = await give({ conditionsChecked: true });
  ok('with the tick it goes out and is expected back', g.outWith === 1);
  const row = (await D.outWith(db, COMPANY, { search: tool.name })).rows.find((r) => r.movementId === g.movement.id);
  const early = await refusal(D.custodyBack(db, c, row.id, { kind: 'worn', quantity: 1 }));
  ok('worn out on day 0 of 30 with no word is refused', early?.code === 'REASON' && /should last 30/.test(early.message), early?.message);
  await D.custodyBack(db, c, row.id, { kind: 'worn', quantity: 1, note: 'Bit snapped drilling 20 mm plate' });
  let wear = await T.wearToReview(db, COMPANY, {}, S);
  let w = wear.find((x) => x.item.id === tool.id);
  ok('it is on the list to read, flagged early, with who had it', !!w && w.early === true && w.daysUsed === 0 && w.lifeDays === 30 && /Test contractor/.test(w.wasWith ?? ''));
  found = await T.findMaintenanceDeskAlerts(db, COMPANY, S);
  ok('an early wear is an alert to maintenance', found.some((x) => x.key === `tool_worn_early:${w.id}` && x.departments.join() === 'maintenance'));
  ok('reading it wants what was found', (await refusal(T.reviewWear(db, c, w.id, {})))?.code === 'REASON');
  await T.reviewWear(db, c, w.id, { note: 'Wrong bit for the job — contractor told' });
  wear = await T.wearToReview(db, COMPANY, {}, S);
  ok('read: off the list and no alert', !wear.some((x) => x.id === w.id) && !(await T.findMaintenanceDeskAlerts(db, COMPANY, S)).some((x) => x.key === `tool_worn_early:${w.id}`));
  ok('still there with ?all=1, with the finding', (await T.wearToReview(db, COMPANY, { all: '1' }, S)).find((x) => x.id === w.id)?.reviewed?.note?.includes('Wrong bit'));
  await db.query('UPDATE cf_stock_custody SET issued_on = CURDATE() - INTERVAL 40 DAY WHERE id = ?', [row.id]);
  const fair = await D.custodyBack(db, c, row.id, { kind: 'worn', quantity: 1 });
  w = (await T.wearToReview(db, COMPANY, {}, S)).find((x) => x.item.id === tool.id);
  ok('worn after its life needs no word and is not early', fair.left === 0 && w?.early === false && w.daysUsed === 40);
  page = await T.today(db, c);
  ok('the page carries all five lists and the targets', Array.isArray(page.tickets) && Array.isArray(page.noPlan) && page.spares.some((x) => x.item.id === spare.id) && page.wear.some((x) => x.item.id === tool.id) && page.targets.fault === 24 && page.counts.wear === page.wear.length);

  console.log(`\n${pass} passed, ${fail} failed — rolled back`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('ERROR', e.message, e.problems ?? '', e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
} finally {
  try { await db.rollback(); } catch { /* going back anyway */ }
  detachNodeCache(db); db.release(); await pool.end();
}
