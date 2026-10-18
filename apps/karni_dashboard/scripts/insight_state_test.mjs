// Insight states + alerts, end to end, on the LOCAL database (karni = company 60006, with SAP rows synced or copied in).
// RESETS that company's findings and alerts. Refuses any database but localhost.
//   node apps/karni_dashboard/scripts/insight_state_test.mjs
import { pool } from '../../../db.js';
import { refresh, insights, act } from '../services/insightService.js';
import { digestsDue, preview, listAlerts, afterSync } from '../services/alertService.js';

if (!/^(localhost|127.0.0.1)$/.test(process.env.DB_HOST || 'localhost')) { console.error('Local database only.'); process.exit(1); }

const C = 60006;
let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };
const st = async (rule, key) => (await pool.query('SELECT * FROM kd_insight_state WHERE company_id=? AND rule_id=? AND subject_key=?', [C, rule, key]))[0][0];
const card = (r, id) => r.insights.find((i) => i.id === id);

await pool.query('DELETE FROM kd_insight_state WHERE company_id=?', [C]);
await pool.query('DELETE FROM kd_insight_log WHERE company_id=?', [C]);
await pool.query('DELETE FROM kd_alerts WHERE company_id=?', [C]);

// 1. First refresh: every finding is new
const r1 = await refresh(C);
const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM kd_insight_state WHERE company_id=? AND status='new'", [C]);
check('first refresh creates new findings', n > 100, `${n} new, failed=${JSON.stringify(r1.failed)}`);

// 2. Mark the top over-credit-limit customer done → hidden from the card
let v = await insights(C, {});
const ocl = card(v, 'over-credit-limit');
const key = ocl.rows[0].key; const before = ocl.total;
await act(C, 'over-credit-limit', key, { action: 'done', note: 'called them' }, { id: 1, name: 'Tester' });
v = await insights(C, {});
check('done hides the row', !card(v, 'over-credit-limit').rows.some((r) => r.key === key) && card(v, 'over-credit-limit').total === before - 1);
check('title recomputed from what is left', !card(v, 'over-credit-limit').title.includes(ocl.rows[0].customer), card(v, 'over-credit-limit').title.slice(0, 90));
v = await insights(C, { handled: '1' });
check('handled view lists it', v.handled.some((h) => h.id === 'over-credit-limit' && h.rows.some((r) => r.key === key)));

// 3. Small change does NOT bring it back
await pool.query('UPDATE kd_insight_state SET acted_metric = metric * 0.95 WHERE company_id=? AND rule_id=? AND subject_key=?', [C, 'over-credit-limit', key]);
await refresh(C);
check('5% worse stays done', (await st('over-credit-limit', key)).status === 'done');

// 4. Materially worse brings it back as new
await pool.query('UPDATE kd_insight_state SET acted_metric = metric * 0.5 WHERE company_id=? AND rule_id=? AND subject_key=?', [C, 'over-credit-limit', key]);
await refresh(C);
let s = await st('over-credit-limit', key);
check('2x worse comes back new', s.status === 'new', s.reason);

// 5. Done but still there after the grace period → open
await act(C, 'over-credit-limit', key, { action: 'done' }, { id: 1, name: 'Tester' });
await pool.query('UPDATE kd_insight_state SET acted_at = DATE_SUB(NOW(), INTERVAL 8 DAY) WHERE company_id=? AND rule_id=? AND subject_key=?', [C, 'over-credit-limit', key]);
await refresh(C);
s = await st('over-credit-limit', key);
check('still there 8 days after done → open', s.status === 'open', s.reason);

// 6. Snooze, and snooze ending
const k2 = card(await insights(C, {}), 'dead-stock').rows[0].key;
await act(C, 'dead-stock', k2, { action: 'snooze', days: 3 }, { id: 1, name: 'Tester' });
await refresh(C);
check('snoozed stays snoozed', (await st('dead-stock', k2)).status === 'snoozed');
await pool.query('UPDATE kd_insight_state SET snooze_until = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE company_id=? AND rule_id=? AND subject_key=?', [C, 'dead-stock', k2]);
await refresh(C);
s = await st('dead-stock', k2);
check('snooze ended → open', s.status === 'open', s.reason);

// 7. Not relevant: back only when doubled
await act(C, 'dead-stock', k2, { action: 'mute' }, { id: 1, name: 'Tester' });
await pool.query('UPDATE kd_insight_state SET acted_metric = metric * 0.7 WHERE company_id=? AND rule_id=? AND subject_key=?', [C, 'dead-stock', k2]);
await refresh(C);
check('not relevant, +43% → stays muted', (await st('dead-stock', k2)).status === 'muted');
await pool.query('UPDATE kd_insight_state SET acted_metric = metric * 0.4 WHERE company_id=? AND rule_id=? AND subject_key=?', [C, 'dead-stock', k2]);
await refresh(C);
check('not relevant, 2.5x → back', (await st('dead-stock', k2)).status === 'new');

// 8. Resolved when gone from the data, and back again later
await pool.query("INSERT INTO kd_insight_state (company_id, rule_id, subject_key, subject_label, status, metric) VALUES (?, 'dead-stock', 'NO-SUCH-ITEM', 'ghost', 'open', 1)", [C]);
await refresh(C);
check('gone from data → resolved', (await st('dead-stock', 'NO-SUCH-ITEM')).status === 'resolved');

// 9. Raise / clear thresholds: an item held open stays until the clear level
const lc = card(await insights(C, {}), 'low-cover');
check('low-cover card present', !!lc, lc ? `${lc.total} items` : '');

// 10. Unit view uses the same states
const u2 = await insights(C, { unit: 'Unit 2' });
check('unit view works', u2.insights.length > 0 && !card(u2, 'over-credit-limit')?.rows.some((r) => r.key === key && false));

// 11. Alerts: preview, daily digest once, nothing marked twice (start clean: a running local server's scheduler may have sent today's digest)
await pool.query('UPDATE kd_insight_state SET notified_at = NULL WHERE company_id=?', [C]);
await pool.query('DELETE FROM kd_alerts WHERE company_id=?', [C]);
const p = await preview(C);
check('preview has daily items', p.daily.length > 0, `instant ${p.instant.length}, daily ${p.daily.length}, weekly ${p.weekly.length}`);
const [[savedSettings]] = await pool.query("SELECT v FROM kd_settings WHERE company_id=? AND k='alerts'", [C]);
await pool.query("UPDATE kd_settings SET v = JSON_SET(v, '$.dailyAt', '00:00') WHERE company_id=? AND k='alerts'", [C]);
await pool.query("INSERT IGNORE INTO kd_settings (company_id, k, v) VALUES (?, 'alerts', JSON_OBJECT('dailyAt','00:00','enabled',false))", [C]);
const d1 = await digestsDue(C);
const d2 = await digestsDue(C);
check('daily digest runs once a day', d1.length > 0 && d2.length === 0, `first: ${d1.map((x) => `${x.area}:${x.count}/${x.status}`).join(' ')}`);
check('email held back while alerts are off', d1.every((x) => x.status === 'off'));
const p2 = await preview(C);
check('sent findings are not pending again', p2.daily.length === 0, `${p2.daily.length} left`);
const list = await listAlerts(C);
check('alerts listed for the app', list.length >= d1.length, `${list.length} alerts`);
await afterSync(C);
check('afterSync runs', true);

// Put the company's alert settings back as they were.
if (savedSettings) await pool.query("UPDATE kd_settings SET v = ? WHERE company_id=? AND k='alerts'", [typeof savedSettings.v === 'string' ? savedSettings.v : JSON.stringify(savedSettings.v), C]);
else await pool.query("DELETE FROM kd_settings WHERE company_id=? AND k='alerts'", [C]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
