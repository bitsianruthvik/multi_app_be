/**
 * stores-desk-prod-check.mjs — the Stores desk against the PRODUCTION database, for ONE company (the sandbox by default).
 *
 *   node scripts/cf_kepl/stores-desk-prod-check.mjs [--company 180005]
 *
 * Reads the Today page, the ledger and Out with as the screens do, then — inside ONE transaction that is ROLLED BACK —
 * receives a tool, gives it to a person, and reads it back from Out with. Nothing is kept.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const TM = path.join(__dir, '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const COMPANY = Number(arg('--company', 180005));
const env = {};
fs.readFileSync(path.join(TM, '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  if (!l.includes('=') || l.trim().startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const D = await imp('apps/cf_erp/services/storesDeskService.js');
const T = await imp('apps/cf_erp/services/storesTodayService.js');
const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

let bad = 0;
const say = (name, cond, detail = '') => { if (!cond) bad += 1; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const db = await pool.getConnection();
try {
  const s = await D.deskSettings(db, COMPANY);
  say('the desk is on for this company', s.storesV2 === true, `closed through ${s.closedThrough ?? 'nothing'}, back ${s.backdateDays} days, hours ${s.openTime}–${s.closeTime}`);
  const led = await D.ledger(db, COMPANY, { paged: 1, limit: 5, show: 'all' });
  say('the ledger reads', led.total > 0, `${led.total} items, ${led.counts.groups.length} groups, ${led.counts.areas.length} store area(s)`);
  const td = await T.today(db, COMPANY);
  say('Today reads', !!td.date, `POs ${td.purchaseOrders.late} late / ${td.purchaseOrders.dueSoon} due, after hours ${td.afterHours.entries.length}, to count ${td.count.toCount}, out too long ${td.outTooLong.count}, below minimum ${td.belowMinimum.count}, level suggestions ${td.levels.rows.length} (items with use ${td.levels.summary.itemsWithUse})`);
  const ow = await D.outWith(db, COMPANY, {});
  say('Out with reads', typeof ow.counts.all === 'number', JSON.stringify(ow.counts));

  await db.beginTransaction(); attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[tool]] = await db.query(
    `SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND i.stores_kind = 'returnable' AND i.tracked_by = 'quantity' ORDER BY m.id LIMIT 1`, [COMPANY]);
  const [[area]] = await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  say('a returnable tool and a store area exist', !!tool && !!area, tool?.name);
  await postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: tool.id, quantity: 5, toAreaId: area.id, unitCost: 100 }] });
  const dept = await D.addDepartment(db, c, { name: `Check ${Date.now()}` });
  const person = await D.addPerson(db, c, { name: `Check person ${Date.now()}`, departmentId: dept.id });
  const g = await D.giveOut(db, c, { givenFor: { type: 'department', departmentId: dept.id }, personId: person.id, lines: [{ itemId: tool.id, quantity: 2 }] });
  say('a tool given out is expected back', g.outWith === 1, g.movement.code);
  const mine = (await D.outWith(db, COMPANY, { search: tool.name })).rows.find((r) => r.movementId === g.movement.id);
  say('it is on Out with, in the 0–30 day bucket', !!mine && mine.left === 2 && mine.daysOut <= 1);
  const back = await D.custodyBack(db, c, mine.id, { kind: 'returned', quantity: 1 });
  say('one returned: one still out', back.left === 1);
  const cl = await D.countList(db, COMPANY, { kind: 'daily' });
  const line = cl.lines.find((l) => l.item.id === tool.id);
  say('it is on today\'s count list with the book quantity', line?.book === 4, String(line?.book));
  const cnt = await D.postCount(db, c, { areaId: cl.area.id, kind: 'daily', lines: [{ itemId: tool.id, counted: 4 }] });
  say('a count that matches the book', cnt.status === 'matched');
  const refused = await postMovement(db, c, { movementType: 'transfer', movementDate: '2026-01-01', lines: [{ itemId: tool.id, quantity: 1, fromAreaId: area.id, toAreaId: area.id }] }).then(() => null, (e) => e);
  say('an old date is refused', refused?.code === 'BACKDATED');
  console.log(bad ? `\n${bad} FAILED` : '\nall ok — rolled back, nothing kept');
  process.exitCode = bad ? 1 : 0;
} catch (e) {
  console.log('THREW:', e.message, e.problems ?? '', '\n', e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
} finally {
  try { await db.rollback(); } catch { /* going back anyway */ }
  detachNodeCache(db); db.release(); await pool.end();
}
