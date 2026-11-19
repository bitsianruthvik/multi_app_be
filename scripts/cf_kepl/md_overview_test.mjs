/**
 * md_overview_test.mjs — company settings, department alerts, the MD's page and the weekly reports (init.sql §113).
 *
 *   cd multi_app_be && node scripts/cf_kepl/md_overview_test.mjs        CF_COMPANY=2 (the default)
 *
 * One transaction, ROLLED BACK at the end: nothing is kept.
 *   1. settings: defaults, a change, a refusal in words, back to the default, the column-backed ones
 *   2. the limits the code reads ARE the settings (level gate, out-with bands, alert limits)
 *   3. department alerts: an inquiry that waits; where it goes; the MD's limit
 *   4. the MD's page: every band; a request from Stores is on it
 *   5. weekly reports: made once, read, marked seen
 *   6. the stand-in
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const St = await imp('apps/cf_erp/services/settingsService.js');
const A = await imp('apps/cf_erp/services/alertService.js');
const DA = await imp('apps/cf_erp/services/departmentAlerts.js');
const M = await imp('apps/cf_erp/services/mdOverviewService.js');
const T = await imp('apps/cf_erp/services/storesTodayService.js');
const D = await imp('apps/cf_erp/services/storesDeskService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const COMPANY = Number(process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
const refusal = (p) => p.then(() => null, (e) => e);
const all = () => true;

const db = await pool.getConnection();
try {
  await db.beginTransaction(); attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id };
  await db.query('DELETE FROM cf_settings WHERE company_id = ?', [COMPANY]);
  St.clearSettingsCache();

  console.log('1. settings');
  let S = await St.getSettings(db, COMPANY, { fresh: true });
  ok('every setting has a value, the defaults the code had', S.level_min_weeks === 8 && S.md_po_late_days === 3 && S.alert_grace_min === 60 && S.out_bucket_2_days === 90 && S.report_stores === true && S.md_standin_on === false);
  const page = await St.settingsPage(db, COMPANY);
  ok('the page groups them, every setting in a group', page.groups.length === St.GROUPS.length && page.groups.reduce((n, g) => n + g.items.length, 0) === St.SETTINGS.length && page.groups.every((g) => g.items.length > 0));
  await St.saveSettings(db, c, { values: { level_min_weeks: 6, md_po_late_days: 5, report_purchase: false } });
  S = await St.getSettings(db, COMPANY);
  ok('a change is read back', S.level_min_weeks === 6 && S.md_po_late_days === 5 && S.report_purchase === false);
  const [[n1]] = await db.query('SELECT COUNT(*) AS n FROM cf_settings WHERE company_id = ?', [COMPANY]);
  await St.saveSettings(db, c, { values: { md_po_late_days: 3 } });
  const [[n2]] = await db.query('SELECT COUNT(*) AS n FROM cf_settings WHERE company_id = ?', [COMPANY]);
  ok('back to the default removes the row', n1.n === 3 && n2.n === 2);
  const bad = await refusal(St.saveSettings(db, c, { values: { level_min_weeks: 0, out_bucket_1_days: 200, nonsense: 1 } }));
  ok('an unknown key is refused', /not a setting/.test(JSON.stringify(bad?.problems ?? bad?.message)));
  const bad2 = await refusal(St.saveSettings(db, c, { values: { level_min_weeks: 0, out_bucket_1_days: 200 } }));
  ok('out of range and bands out of order, both said at once', (bad2?.problems ?? []).length >= 2, JSON.stringify(bad2?.problems));
  ok('a stand-in cannot be switched on without a person', !!(await refusal(St.saveSettings(db, c, { values: { md_standin_on: true } }))));
  await St.saveSettings(db, c, { values: { tools_out_days: 45, store_close_time: '17:30' } });
  const desk = await D.deskSettings(db, COMPANY);
  ok('the stores settings are the same columns the desk reads', desk.toolsOutDays === 45 && desk.closeTime === '17:30');
  ok('z for 95 % is 1.645, for 99 % 2.326', Math.abs(St.zOf(0.95) - 1.645) < 0.002 && Math.abs(St.zOf(0.99) - 2.326) < 0.002);

  console.log('2. the code reads the settings');
  const gate = T.gateOf(S);
  ok('the level gate is 6 weeks now', gate.weeks === 6 && gate.usedWeeks === 4 && gate.z === 1.65);
  ok('six weeks of steady use is suggested under the new gate, not under the old', !!T.suggestLevels([5, 5, 5, 5, 5, 5], { leadDays: 14 }, gate) && T.suggestLevels([5, 5, 5, 5, 5, 5], { leadDays: 14 }) === null);
  await St.saveSettings(db, c, { values: { out_bucket_1_days: 10, out_bucket_2_days: 20 } });
  ok('Out with answers with the bands set', JSON.stringify((await D.outWith(db, COMPANY, {})).bands) === '[10,20]');

  console.log('3. department alerts');
  const [[cust]] = await db.query('SELECT id FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL AND is_customer = 1 LIMIT 1', [COMPANY]);
  const [[inq]] = await db.query("SELECT id, code FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND status = 'inquiry' ORDER BY id LIMIT 1", [COMPANY]);
  if (!inq) console.log('  (no inquiry in this company: skipped)');
  else {
    await db.query('UPDATE cf_sales_orders SET created_at = NOW() - INTERVAL 6 DAY WHERE id = ?', [inq.id]);
    S = await St.getSettings(db, COMPANY, { fresh: true });
    let f = (await DA.findDepartmentAlerts(db, COMPANY, S)).found.find((a) => a.key === `inquiry_waiting:${inq.id}`);
    ok('an inquiry of 6 days goes to Engineering, not yet to the MD (5 / 7)', !!f && f.departments.join() === 'engineering' && f.severity === 'warning', JSON.stringify(f));
    await St.saveSettings(db, c, { values: { md_inquiry_days: 6 } });
    S = await St.getSettings(db, COMPANY);
    f = (await DA.findDepartmentAlerts(db, COMPANY, S)).found.find((a) => a.key === `inquiry_waiting:${inq.id}`);
    ok('with the MD limit at 6 days it reaches the MD', f.departments.includes('md') && f.severity === 'danger');
    await St.saveSettings(db, c, { values: { alert_inquiry_days: 30, md_inquiry_days: 40 } });
    S = await St.getSettings(db, COMPANY);
    ok('with the limit at 30 days it is no alert', !(await DA.findDepartmentAlerts(db, COMPANY, S)).found.some((a) => a.key === `inquiry_waiting:${inq.id}`));
    await St.saveSettings(db, c, { values: { alert_inquiry_days: 5, md_inquiry_days: 6 } });
    await A.checkCompany(db, COMPANY);
    const [[row]] = await db.query("SELECT status, departments FROM cf_alerts WHERE company_id = ? AND dedupe_key = ?", [COMPANY, `inquiry_waiting:${inq.id}`]);
    ok('the check writes it once, open', row?.status === 'open' && row.departments === 'engineering,md');
    await db.query("UPDATE cf_sales_orders SET status = 'lost' WHERE id = ?", [inq.id]);
    await A.checkCompany(db, COMPANY);
    const [[row2]] = await db.query("SELECT status FROM cf_alerts WHERE company_id = ? AND dedupe_key = ?", [COMPANY, `inquiry_waiting:${inq.id}`]);
    ok('and resolves it when the order is no longer an inquiry', row2?.status === 'resolved');
  }
  ok('every department is known to the alerts', ['maintenance', 'engineering', 'accounts', 'stores', 'md'].every((d) => A.DEPARTMENTS[d]?.length) && A.DEPARTMENTS.md.includes('cf_erp_md_dashboard'));
  ok('someone with only the maintenance tag is in Maintenance', A.departmentsOf((t) => t === 'cf_erp_maintenance').join() === 'maintenance');

  console.log('4. the MD\'s page');
  const [[area]] = await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const [[item]] = await db.query(
    `SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active' AND i.item_type = 'catalog' AND i.tracked_by = 'quantity'
        AND NOT EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.item_id = m.id AND k.quantity <> 0) ORDER BY m.id DESC LIMIT 1`, [COMPANY]);
  const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
  await postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: item.id, quantity: 500, toAreaId: area.id, unitCost: 100 }] });
  const cnt = await D.postCount(db, c, { areaId: area.id, kind: 'spot', lines: [{ itemId: item.id, counted: 300, reason: 'test' }] });
  let o = await M.mdOverview(db, COMPANY, all, user.id);
  ok('a count over the limit is waiting', cnt.status === 'pending');
  const dRow = o.decisions.rows.find((r) => r.source === 'approval' && r.type === 'stock_count' && r.title.includes(cnt.code));
  ok('it is on the MD\'s page as a decision from Stores', !!dRow && dRow.department === 'Stores' && dRow.decideHere === true && dRow.amount === 20000, JSON.stringify(dRow));
  ok('seven departments, three lines each, a colour and a link', o.departments.length === 7 && o.departments.every((d) => d.lines.length === 3 && ['ok', 'warn', 'bad'].includes(d.status) && d.link));
  ok('the Stores tile says a request waits... on the Procurement / Stores lines', o.departments.find((d) => d.key === 'stores').lines.every((l) => typeof l === 'string'));
  ok('the MD\'s alerts are the MD\'s', Array.isArray(o.alerts) && o.alerts.every((a) => a.departments.includes('md')));
  const none = await M.mdOverview(db, COMPANY, () => false, user.id);
  ok('someone who approves nothing sees no decision', none.decisions.rows.length === 0);

  console.log('5. weekly reports');
  const wk = M.lastWeek('1', '2026-11-19');
  ok('the last week that ended before Thu 19 Nov is Mon 9 – Sun 15', wk.from === '2026-11-09' && wk.to === '2026-11-15', JSON.stringify(wk));
  ok('with the week starting on Sunday: 8 – 14', JSON.stringify(M.lastWeek('0', '2026-11-19')) === '{"from":"2026-11-08","to":"2026-11-14"}');
  await db.query('DELETE FROM cf_md_reports WHERE company_id = ?', [COMPANY]);
  const made = await M.ensureReports(db, COMPANY);
  ok('three reports are made (the purchase one is switched off)', made.made === 3, JSON.stringify(made));
  ok('a second read makes none', (await M.ensureReports(db, COMPANY)).made === 0);
  o = await M.mdOverview(db, COMPANY, all, user.id);
  ok('they wait to be verified', o.reports.toVerify.length === 3 && o.reports.toVerify.every((r) => r.headline && r.department));
  const rep = await M.getReport(db, COMPANY, o.reports.toVerify.find((r) => r.kind === 'stores_week').id);
  ok('the stores report has its figures and tables', rep.data.figures.length >= 8 && rep.data.tables.length === 4 && rep.data.tables.every((t) => Array.isArray(t.columns) && Array.isArray(t.rows)));
  const seen = await M.markSeen(db, c, rep.id, { note: 'ok' });
  ok('marked seen with a name and a time', !!seen.seenAt && !!seen.seenBy && seen.seenNote === 'ok');
  o = await M.mdOverview(db, COMPANY, all, user.id);
  ok('it leaves "to verify" and shows under seen', o.reports.toVerify.length === 2 && o.reports.seen.some((r) => r.id === rep.id));
  for (const k of ['plan_week', 'maintenance_week']) {
    const r = await M.getReport(db, COMPANY, o.reports.toVerify.find((x) => x.kind === k).id);
    ok(`${k} reads`, r.data.figures.length >= 6 && typeof r.headline === 'string', r.headline);
  }
  await St.saveSettings(db, c, { values: { report_purchase: true } });
  ok('switched on, the purchase report is made', (await M.ensureReports(db, COMPANY)).made === 1);

  console.log('6. the stand-in');
  const [[other]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL AND id <> ? ORDER BY id LIMIT 1', [COMPANY, user.id]);
  if (!other) console.log('  (one user in this company: skipped)');
  else {
    ok('nobody stands in by default', !(await St.isStandIn(db, COMPANY, other.id)));
    await St.saveSettings(db, c, { values: { md_standin_user: other.id, md_standin_on: true } });
    ok('switched on, that person stands in — and only that person', (await St.isStandIn(db, COMPANY, other.id)) && !(await St.isStandIn(db, COMPANY, user.id)));
    ok('the page says who', (await M.mdOverview(db, COMPANY, all, other.id)).standIn.you === true);
    await St.saveSettings(db, c, { values: { md_standin_on: false } });
    ok('switched off, at once', !(await St.isStandIn(db, COMPANY, other.id)));
    ok('the tags a stand-in borrows include every approval and the dashboard', St.MD_STANDIN_TAGS.includes('cf_erp_approve_purchase_order') && St.MD_STANDIN_TAGS.includes('cf_erp_md_dashboard') && !St.MD_STANDIN_TAGS.includes('cf_erp_maintenance'));
  }
  void cust;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.log('THREW:', e.message, e.problems ?? '', '\n', e.stack?.split('\n').slice(1, 5).join('\n'));
  process.exitCode = 1;
} finally {
  try { await db.rollback(); } catch { /* going back anyway */ }
  St.clearSettingsCache();
  detachNodeCache(db); db.release(); await pool.end();
}
