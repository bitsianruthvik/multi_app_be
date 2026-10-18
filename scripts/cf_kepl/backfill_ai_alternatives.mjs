#!/usr/bin/env node
/**
 * backfill_ai_alternatives.mjs — AI'S NESTING BESIDE EVERY UPLOADED ONE, for nestings uploaded before §87 (2026-10-18).
 *
 * Since §87 an uploaded nesting (ProNest .nif / DXF) starts AI's Standard nesting of the same pieces in the background,
 * and the result is stored as the line's ALTERNATIVE (cf_nest_alternatives → the run in cf_nest_runs). Lines uploaded
 * before that — NECL (SO260009, company 30005 on production), NithinSai, VRC — have none. This makes it, the same way:
 * Standard effort, scope 'subset' (exactly the pieces the uploaded plates hold), stored as a finished run of purpose
 * 'compare' and pointed at by the line's alternative row. The uploaded nesting stays the main one; nothing on the line's
 * plates, BOM or buying is touched.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/backfill_ai_alternatives.mjs                      # DRY RUN: the lines it would do, nothing nested, nothing written
 *   node scripts/cf_kepl/backfill_ai_alternatives.mjs --try                # nest them here and say the result — still nothing written
 *   node scripts/cf_kepl/backfill_ai_alternatives.mjs --commit             # nest them and STORE each as the line's alternative
 *   … --orders 31983,32030      only these sales order ids (default: every line with an uploaded nesting and no stored AI alternative)
 *   … --company 30005           only this company
 *   … --minutes 10              another budget than Standard's (10 min a line); --workers 6 fewer threads than cores − 1
 *
 * AGAINST PRODUCTION: the database is whatever DB_HOST / DB_USER / … say, exactly as for the server (the variables of
 * TM/.env.tidb exported into the shell first; without them, multi_app_be/.env — the local database). Only the host and
 * the database name are printed, never a credential.
 *
 * IDEMPOTENT. A line whose upload already has AI's run stored (the server's own, or an earlier backfill) is not nested
 * again — with --commit only its alternative row is pointed at that run. Two writes per line done (one INSERT of the run,
 * one upsert of the row), each on its own, after the nesting: a line stopped half-way has written nothing.
 * SKIPPED for a line, in words, and the next line goes on: nothing uploaded any more, not frozen, or a nesting run
 * working on it on the server right now. The engine is scripts/cf_kepl/lib/backfillAlternatives.mjs (tested in
 * nest_alternative_test.mjs, section 8, inside a rolled-back transaction).
 */
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
if (opt('help')) {
  console.log('usage: node scripts/cf_kepl/backfill_ai_alternatives.mjs [--orders id,id] [--company id] [--try | --commit] [--minutes n] [--workers n]');
  process.exit(0);
}
const commit = opt('commit') === true;
const tryIt = commit || opt('try') === true;
const orderIds = typeof opt('orders') === 'string' ? opt('orders').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0) : null;
const companyId = typeof opt('company') === 'string' ? Number(opt('company')) : null;
const minutes = typeof opt('minutes') === 'string' ? Number(opt('minutes')) : null;
const workers = typeof opt('workers') === 'string' ? Number(opt('workers')) : null;

const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const { backfill } = await import('./lib/backfillAlternatives.mjs');

const host = process.env.DB_HOST ?? 'localhost';
const mode = commit ? 'commit' : tryIt ? 'try' : 'dry';
console.log(`database: ${host} / ${process.env.DB_NAME ?? '(default)'} · ${commit ? "COMMIT — AI's nesting of each line is stored as its alternative" : tryIt ? 'try — nested here, nothing written' : 'dry run — nothing nested, nothing written (add --try to nest, --commit to store)'}`);
let code = 0;
try {
  const out = await backfill({ db: pool, companyId, orderIds, mode, minutes, workers, say: (t) => console.log(t) });
  if (!out.length) console.log(`No line ${orderIds ? `of order(s) ${orderIds.join(', ')} ` : ''}has an uploaded nesting.`);
  const n = (st) => out.filter((x) => x.status === st).length;
  console.log(`
${out.length} line(s): ${['would', 'has', 'tried', 'stored', 'skipped', 'busy', 'failed'].filter((st) => n(st)).map((st) => `${n(st)} ${st}`).join(', ') || 'none'}`);
  if (n('failed')) code = 1;
} catch (e) {
  code = 1;
  console.error(`
NOT DONE: ${e?.message ?? e}`);
}
await pool.end();
process.exit(code);
