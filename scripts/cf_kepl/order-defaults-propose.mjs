/**
 * order-defaults-propose.mjs — ONE-OFF, for an order made before ORDER VALUES existed (init.sql §65,
 * services/orderDefaultService.js). Existing orders are never changed silently; this proposes, and
 * applies only when asked.
 *
 * For one order, per specification: the most common value TYPED on its rows becomes the proposed
 * ORDER value; the rows typed with exactly that value lose their entry and take it from the order
 * (nothing they read changes); rows typed differently keep their entry as a row override. A LOCKED
 * or released line is reported but never touched.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/order-defaults-propose.mjs --company 2 --order SO-20260924-0003 [--revision 2]
 *        [--specs GRADE,IMPACT_CLASS]     look at these (flagged or not) — the default is every flagged one
 *        [--apply]                        write it (flagged specifications only), in one transaction
 *
 * Dry run (the default) is read-only. LOCAL DATABASE ONLY: it uses multi_app_be/.env (localhost); it
 * has no production target on purpose.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const ORDER = arg('order');
const REVISION = arg('revision') ? Number(arg('revision')) : null;
const SPECS = arg('specs') ? arg('specs').split(',').map((s) => s.trim()).filter(Boolean) : null;
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY) || !ORDER) throw new Error('Usage: --company <id> --order <code> [--revision <n>] [--specs A,B] [--apply]');

const { pool } = await import('../../db.js');
const OD = await import('../../apps/cf_erp/services/orderDefaultService.js');

const [[host]] = await pool.query('SELECT @@hostname AS h, DATABASE() AS d');
const db = await pool.getConnection();
try {
  const [[o]] = await db.query(
    `SELECT id, code, revision FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL
      ${REVISION ? 'AND revision = ?' : ''} ORDER BY revision DESC LIMIT 1`,
    REVISION ? [COMPANY, ORDER, REVISION] : [COMPANY, ORDER],
  );
  if (!o) throw new Error(`No order ${ORDER}${REVISION ? ` rev ${REVISION}` : ''} in company ${COMPANY}.`);
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (read-only)'} — ${host.d} on ${host.h}, company ${COMPANY}`);
  const p = await OD.proposeOrderDefaults(db, COMPANY, o.id, { specCodes: SPECS });
  console.log(`\nOrder ${p.order.label} (${p.order.status}) — lines: ${p.lines.map((l) => `${l.lineNo}${l.frozen ? ` (${l.frozen})` : ''}`).join(', ')}`);
  for (const x of p.proposals) {
    console.log(`\n${x.code} — ${x.name}`);
    if (!x.rows) { console.log('  no row of this order takes it'); continue; }
    console.log(`  rows that take it: ${x.rows} · typed: ${x.typedSame + x.typedOther} · empty: ${x.empty} · already from the order: ${x.fromOrder}`);
    if (!x.value) { console.log('  nothing typed — no order value to propose'); continue; }
    const cleared = Object.values(x.clear).reduce((n, ids) => n + ids.length, 0);
    console.log(`  proposed ORDER value: ${x.value.display} (typed on ${x.typedSame} rows)`);
    console.log(`  rows whose entry would go (they then read it from the order): ${cleared}${x.typedSame > cleared ? ` — ${x.typedSame - cleared} more are on locked lines and stay as they are` : ''}`);
    console.log(`  rows that keep their own value (overrides): ${x.typedOther}${x.others.length ? ` — ${x.others.map((v) => `${v.display} × ${v.n}`).join(', ')}` : ''}`);
    for (const [lineNo, pl] of Object.entries(x.perLine)) console.log(`    line ${lineNo}${pl.frozen ? ` (${pl.frozen}, untouched)` : ''}: ${pl.rows} rows · ${pl.typed} typed · ${pl.empty} empty · ${pl.fromOrder} from the order`);
  }
  if (APPLY) {
    await db.beginTransaction();
    const out = await OD.applyOrderDefaultsProposal(db, { companyId: COMPANY, userId: null }, o.id, p);
    await db.commit();
    console.log('\nApplied:', out.order?.sentence ?? 'nothing (no flagged specification with a value to propose)');
    for (const l of out.lines) console.log(`  line #${l.lineId}: ${l.sentence}`);
  } else console.log('\nNothing written. --apply writes it (flagged specifications only).');
} catch (err) {
  try { await db.rollback(); } catch { /* not in a transaction */ }
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
