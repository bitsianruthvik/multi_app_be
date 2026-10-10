#!/usr/bin/env node
/**
 * nest-line.mjs — NEST ONE ORDER LINE ON THIS MACHINE (all its cores), against whatever database
 * the environment points at, and — only with --apply — leave the result on the line as a finished
 * run, ready to look at, compare and accept on the screen.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/nest-line.mjs --company 30005 --order SO-20260930-0001 --line 1 --effort deep
 *   … --apply                 write the finished run (ONE row of cf_nest_runs); without it NOTHING is written
 *   … --whole                 nest the whole line as if nothing were uploaded (default: nest the rest)
 *   … --workers 6             fewer threads than cores − 1
 *   … --minutes 45            another budget than the level's (quick 5 · normal 10 · deep 20 · long 60)
 *
 * AGAINST PRODUCTION: the database is whatever DB_HOST / DB_USER / … say, exactly as for the
 * server. With the TiDB variables exported into the shell first (the values in TM/.env.tidb), the
 * line is read from production, nested here, and with --apply one row is written there. Nothing
 * else is touched: accepting it is done on the screen, by the server, which verifies every plate.
 *
 * It refuses, in words, when the line is not frozen, is released, or its order is locked, and when
 * a nesting run is working on the line on the server. Ctrl-C before the end writes nothing.
 */
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const usage = 'usage: node scripts/cf_kepl/nest-line.mjs --company <id> --order <code> [--line <no>] [--effort quick|normal|deep|long] [--workers n] [--minutes n] [--whole] [--apply]';
if (!opt('company') || !opt('order') || opt('help')) { console.log(usage); process.exit(opt('help') ? 0 : 2); }
const effort = String(opt('effort') ?? 'normal');
if (!['quick', 'normal', 'standard', 'deep', 'long'].includes(effort)) { console.error(`--effort is quick, normal, deep or long — not "${effort}".\n${usage}`); process.exit(2); }

const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const { nestLine } = await import('./lib/nestLineRunner.mjs');
const apply = opt('apply') === true;
const host = process.env.DB_HOST ?? 'localhost';
console.log(`database: ${host} · company ${opt('company')} · order ${opt('order')}${opt('line') ? ` line ${opt('line')}` : ''} · ${effort}${apply ? ' · WILL WRITE one finished run' : ' · dry run (nothing is written; add --apply to keep the result)'}`);
let code = 0;
try {
  const out = await nestLine({
    db: pool, companyId: Number(opt('company')), orderCode: String(opt('order')), lineNo: opt('line') == null ? null : Number(opt('line')),
    effort, workers: opt('workers') == null ? null : Number(opt('workers')), apply, whole: opt('whole') === true,
    budgetMs: opt('minutes') == null ? null : Number(opt('minutes')) * 60_000,
    startedBy: `offline runner (${process.env.USERNAME ?? process.env.USER ?? 'someone'})`,
    say: (text) => console.log(`  ${text}`),
  });
  console.log('\nIMPROVEMENT CURVE');
  console.log('  at        plates   bought m²   waste %');
  for (const pt of out.curve) console.log(`  ${`${(pt.atMs / 1000).toFixed(1)} s`.padEnd(9)} ${String(pt.plates).padEnd(8)} ${String(pt.areaBoughtM2).padEnd(11)} ${pt.wastePct}`);
  console.log(`\nline ${out.line.lineNo} of ${out.line.orderCode}: ${out.totals.plates} plates, ${out.totals.pieces} pieces placed, ${out.totals.unplaced} not placed, ${out.totals.areaBoughtM2} m² bought, waste ${out.totals.wastePct}% — ${Math.round(out.elapsedMs / 1000)} s of ${Math.round(out.budgetMs / 1000)}`);
  for (const g of out.plan.groups) console.log(`  ${String(g.thickness).padStart(7)} mm ${String(g.grade ?? '').padEnd(10)} ${String(g.nests.length).padStart(3)} plates  ${g.shapes?.taken ?? 'rows'}${g.unplaced.length ? `  — ${g.unplaced.reduce((a, u) => a + u.qty, 0)} not placed` : ''}`);
  if (out.problems.length) { console.log(`\n${out.problems.length} problem(s) to read:`); for (const p of out.problems.slice(0, 20)) console.log(`  - ${p}`); }
  console.log(out.applied
    ? `\nWRITTEN: run ${out.runId} (row ${out.rowId}, ${(out.rowBytes / 1024).toFixed(0)} kB) is on the line as a finished run — open the Nesting screen of the line to see it, compare it, and accept it.`
    : '\nDry run: nothing was written. Run it again with --apply to keep a result like this one on the line.');
} catch (e) {
  code = 1;
  console.error(`\nNOT DONE: ${e?.message ?? e}${e?.problems?.length ? `\n  - ${e.problems.join('\n  - ')}` : ''}`);
}
await pool.end();
process.exit(code);
