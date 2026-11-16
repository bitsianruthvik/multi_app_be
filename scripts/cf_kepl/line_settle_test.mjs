/**
 * line_settle_test.mjs — a structure read never does a line's choosing inside the request (services/lineSettle.js, 2026-11-16).
 *
 *   cd multi_app_be && node scripts/cf_kepl/line_settle_test.mjs
 *   CF_SETTLE_COMPANY=2 (the default: the local KEPL copy)
 *
 * Reads only, plus the app's own first-open work on one existing line (the same the page does). No fixtures.
 *   1. a slow run: the read's wait ends first → settling, seconds; a second read JOINS the same run (the work runs once);
 *      when it ends the next read says how many were chosen, once and again within the short memory
 *   2. a failing run is caught: the read still answers, nothing is said to be settling
 *   3. the real work on a real line: settles inside the wait; lineStructure({ settled }) carries autofilled / settling and
 *      the same tree as a plain read
 *   4. orderStructure({ settle }) settles every line of the order first and gives each line its own answer
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const LS = await imp('apps/cf_erp/services/lineSettle.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');

const COMPANY = Number(process.env.CF_SETTLE_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const [[user]] = await pool.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? 1 };

  console.log('1. a slow run');
  let runs = 0;
  const slow = async () => { runs += 1; await sleep(700); return { filled: 3, parents: [] }; };
  const t0 = Date.now();
  const a = (await LS.settleLines(c, [990001], { waitMs: 150, run: slow })).get(990001);
  ok('the read answers when its wait ends, not when the work does', Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  ok('it says the line is settling', a.settling === true && a.filled === 0);
  ok('the run is in flight', LS.isSettling(COMPANY, 990001));
  const b = (await LS.settleLines(c, [990001], { waitMs: 150, run: slow })).get(990001);
  ok('a second read joins the same run', runs === 1 && b.settling === true);
  await sleep(700);
  ok('the run has ended', !LS.isSettling(COMPANY, 990001));
  const d = (await LS.settleLines(c, [990001], { waitMs: 150, run: async () => ({ filled: 0 }) })).get(990001);
  ok('the next read is settled and says what the finished run chose', d.settling === false && d.filled === 3, JSON.stringify(d));
  const e = (await LS.settleLines(c, [990001], { waitMs: 150, run: async () => ({ filled: 0 }) })).get(990001);
  ok('and so does the read beside it (short memory)', e.filled === 3);

  console.log('2. a failing run');
  const f = (await LS.settleLines(c, [990002], { waitMs: 300, run: async () => { throw new Error('boom'); } })).get(990002);
  ok('the read still answers, not settling', f.settling === false && f.filled === 0 && !LS.isSettling(COMPANY, 990002));

  console.log('3. the real work on a real line');
  const [[line]] = await pool.query(
    `SELECT l.id, l.order_id FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.item_id IS NOT NULL ORDER BY l.id DESC LIMIT 1`, [COMPANY]);
  if (!line) { console.log('  (no order line with an item in this company: skipped)'); }
  else {
    const t1 = Date.now();
    const s = (await LS.settleLines(c, [line.id])).get(Number(line.id));
    ok(`line ${line.id} settles inside the wait`, s.settling === false, `${Date.now() - t1} ms`);
    const withSettled = await SO.lineStructure(pool, COMPANY, line.id, { settled: s });
    const plain = await SO.lineStructure(pool, COMPANY, line.id);
    ok('the answer carries settling and autofilled', withSettled.settling === false && withSettled.autofilled === s.filled);
    ok('a settling answer says so', (await SO.lineStructure(pool, COMPANY, line.id, { settled: { settling: true, filled: 0, seconds: 42 } })).settlingSeconds === 42);
    const strip = (o) => JSON.stringify({ ...o, autofilled: 0, settling: false });
    ok('and the same tree as a plain read', strip(withSettled) === strip(plain));

    console.log('4. the whole order');
    let asked = null;
    const whole = await SO.orderStructure(pool, COMPANY, line.order_id, { settle: (ids) => { asked = ids; return LS.settleLines(c, ids); } });
    ok('every line with an item is settled first', Array.isArray(asked) && asked.map(Number).includes(Number(line.id)));
    ok('each line has its own answer', whole.lines.every((l) => l.structure == null || l.structure.settling === false));
  }
} catch (err) {
  fail += 1; console.log('  FAIL (threw)', err?.stack ?? err);
} finally {
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
