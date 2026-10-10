/**
 * Regression tests for the organisation workbook round trip (org-template.mjs, org-apply-workbook.mjs and the two modules
 * under lib/). One entry point; it runs everything and exits non-zero on failure.
 *
 *   node apps/cf_hrms/scripts/workbook-tests/run.mjs                  everything, against LOCAL Karni
 *   node .../run.mjs --company=<slug>                                  another LOCAL company that has HRMS data
 *   node .../run.mjs --only=<text>                                     only the suites or cases whose name contains <text>
 *   node .../run.mjs --list                                            what there is, and nothing is run
 *   node .../run.mjs --verbose                                         print every check (default: failures, plus a line per case)
 *   node .../run.mjs --commit                                          ALSO the one case that really commits (see below)
 *   node .../run.mjs --excel                                           ALSO drive real Excel through COM (Windows with Excel only)
 *
 * EXIT CODE   0  every check passed (skipped cases are listed and do not fail the run)
 *             1  a check failed, or a case threw
 *             2  the run could not be trusted: the database kept changing under a case, the company has no data, or the
 *                target was production. Fix the cause and run it again; it is not a pass.
 *
 * WHAT IT DOES TO THE DATABASE. Nothing, by default. Every apply is REHEARSED: it runs inside a transaction, the case reads the
 * database as the apply left it, and the transaction is rolled back. The two opt-in cases are the exceptions:
 *   --commit   commits a headcount change and puts it back (it also leaves two EXCEL rows in hrms_import_runs and two audit rows)
 *   --excel    opens a copy of an export in real Excel, edits and saves it; it touches no database row beyond a rehearsal
 * It REFUSES --target=prod: tests that create and roll back rows do not belong on production, and a prod export is stale the
 * moment the chart is re-imported.
 *
 * NO HARD-CODED DATA. Every case picks its rows from a fresh export of whatever the company holds now, and skips (saying why)
 * when the data has nothing to test it with. Every name a case creates carries a per-run tag, so nothing collides with the data.
 * Karni's chart has been re-imported four times in a single day; this suite is written for that.
 *
 * THE DATABASE MOVING UNDER A CASE. Before and after each case a cheap signature of the company's rows is taken; if it changed,
 * the case is run again (up to three times) and only the last, undisturbed attempt is counted. A case that never gets a quiet
 * database is reported as UNSTABLE and makes the run exit 2. Before the first case the runner waits for the database to settle.
 */
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from '../dbTarget.mjs';
import { makeCase, Skip, T } from './harness.mjs';
import * as identity from './cases/identity.mjs';
import * as seats from './cases/seats.mjs';
import * as people from './cases/people.mjs';
import * as duties from './cases/duties.mjs';
import * as removals from './cases/removals.mjs';
import * as safety from './cases/safety.mjs';
import * as departments from './cases/departments.mjs';
import * as blank from './cases/blank.mjs';
import * as commit from './cases/commit.mjs';
import * as excel from './cases/excel.mjs';

const SUITES = [identity, seats, departments, people, duties, removals, safety, blank, commit, excel];
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

if (flag('help') || flag('h')) {
  console.log('usage: node run.mjs [--company=<slug>] [--only=<text>] [--list] [--verbose] [--commit] [--excel]\nSee the comment at the top of this file.');
  process.exit(0);
}
if (args.some((a) => a === '--target=prod' || a === '--prod')) {
  console.error('REFUSED: these tests never run against production. Run them against local; for production, take a fresh export and use a dry run of org-apply-workbook.mjs.');
  process.exit(2);
}

const wanted = (suite) => !suite.optIn || flag(suite.optIn);
const matches = (suite, c) => {
  const only = value('only')?.toLowerCase();
  return !only || `${suite.name} ${c.name}`.toLowerCase().includes(only);
};

if (flag('list')) {
  for (const s of SUITES) {
    console.log(`${s.name}${s.optIn ? `   (opt-in: --${s.optIn})` : ''}`);
    for (const c of s.cases) console.log(`    ${c.name}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- is the database holding still? ----
const SIGNED = ['hrms_positions', 'hrms_roles', 'hrms_employees', 'hrms_work_assignments', 'hrms_open_points', 'hrms_work_contexts',
  'hrms_responsibility_definitions', 'hrms_role_responsibility_assignments', 'hrms_position_reporting_relationships',
  'hrms_position_work_contexts', 'hrms_manpower_requirements', 'hrms_departments', 'hrms_department_serves', 'hrms_locations', 'hrms_shifts', 'hrms_import_runs'];
/** Row count, highest id and latest update of everything an export reads, as one string. Rolled-back rehearsals do not change it. */
async function signature(conn, companyId) {
  const sql = SIGNED.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n, COALESCE(MAX(id), 0) AS mx, COALESCE(MAX(updated_at), '') AS u FROM ${t} WHERE company_id = ?`).join(' UNION ALL ');
  const [rows] = await conn.query(sql, SIGNED.map(() => companyId));
  return rows.map((r) => `${r.t}:${r.n}:${r.mx}:${r.u}`).join('|');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForQuiet(conn, companyId, { quietMs = 2500, maxMs = 60000 } = {}) {
  const t0 = Date.now();
  let last = await signature(conn, companyId);
  let since = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(500);
    const now = await signature(conn, companyId);
    if (now !== last) { last = now; since = Date.now(); }
    else if (Date.now() - since >= quietMs) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------------- running a case ----
async function runCase(conn, ctx, suite, c) {
  const attempts = c.commits ? 1 : 3; // a case that commits changes the signature itself, so it cannot be told apart from interference
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const before = await signature(conn, ctx.company.id);
    const t = makeCase({ conn, target: ctx.target, company: ctx.company, tag: ctx.tag });
    let error = null;
    let skipped = null;
    const t0 = Date.now();
    try { await c.run(t); } catch (e) { if (e instanceof Skip) skipped = e.message; else error = e; }
    try { await conn.rollback(); } catch { /* nothing was open */ }
    const after = await signature(conn, ctx.company.id);
    if (c.commits || before === after) return { t, error, skipped, attempt, ms: Date.now() - t0 };
  }
  return { unstable: true };
}

async function main() {
  const target = resolveTarget();
  if (target.isProd) { console.error('REFUSED: production.'); process.exit(2); }
  announce(target);
  const slug = value('company') ?? 'karni';
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  const started = Date.now();
  try {
    const [[company]] = await conn.query('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
    if (!company) { console.error(`No company "${slug}" on ${target.name}.`); process.exitCode = 2; return; }
    let header;
    try {
      const { data } = await T.exportWorkbook(conn, slug, target);
      header = `${data.seats.length} seats, ${data.people.length} people, ${data.responsibilities.length} duties, ${data.departments.length} departments, ${data.questions.length} questions`;
    } catch (e) {
      console.error(`${company.name} has nothing to export (${e.message}). Import its chart first.`);
      process.exitCode = 2;
      return;
    }
    console.log(`  company: ${company.name} (id ${company.id}, slug ${company.slug}): ${header}`);
    if (!(await waitForQuiet(conn, company.id))) {
      console.error('The database is still changing (is an import running?). Wait for it to finish and run the tests again.');
      process.exitCode = 2;
      return;
    }

    const ctx = { target, company, tag: Math.random().toString(36).slice(2, 6) };
    const totals = { checks: 0, passed: 0, failed: 0, cases: 0, ran: 0, skipped: 0, unstable: 0, threw: 0 };
    const skips = [];
    const verbose = flag('verbose');

    for (const suite of SUITES) {
      if (!wanted(suite)) continue;
      const cases = suite.cases.filter((c) => matches(suite, c));
      if (!cases.length) continue;
      console.log(`\n${suite.name}`);
      for (const c of cases) {
        totals.cases++;
        const r = await runCase(conn, ctx, suite, c);
        if (r.unstable) {
          totals.unstable++;
          console.log(`  ????  ${c.name}\n          the database changed while it ran, three times in a row: not counted`);
          continue;
        }
        if (r.skipped) {
          totals.skipped++;
          skips.push(`${suite.name} / ${c.name}: ${r.skipped}`);
          console.log(`  SKIP  ${c.name}\n          ${r.skipped}`);
          continue;
        }
        const bad = r.t.results.filter((x) => !x.pass);
        const failed = bad.length > 0 || Boolean(r.error);
        totals.ran++;
        totals.checks += r.t.results.length;
        totals.passed += r.t.results.length - bad.length;
        totals.failed += bad.length + (r.error ? 1 : 0);
        if (r.error) totals.threw++;
        const extra = [r.attempt > 1 ? `ran again ${r.attempt - 1}x, the database moved` : null, r.t.partial.length ? `part skipped: ${r.t.partial.join('; ')}` : null].filter(Boolean);
        const n = r.t.results.length;
        console.log(`  ${failed ? 'FAIL' : 'PASS'}  ${c.name}  (${n} check${n === 1 ? '' : 's'}, ${(r.ms / 1000).toFixed(1)}s${extra.length ? `; ${extra.join('; ')}` : ''})`);
        for (const x of r.t.results) if (verbose || !x.pass) console.log(`          ${x.pass ? 'ok  ' : 'FAIL'}  ${x.message}`);
        if (r.error) console.log(`          threw: ${r.error.message}\n${String(r.error.stack ?? '').split('\n').slice(1, 5).map((l) => `            ${l.trim()}`).join('\n')}`);
        if (failed || verbose) for (const n of r.t.notes) console.log(`          note: ${n.replace(/\n/g, '\n                ')}`);
      }
    }

    console.log(`\n${'-'.repeat(78)}`);
    console.log(`${totals.checks} checks: ${totals.passed} passed, ${totals.failed} failed.  ${totals.cases} cases: ${totals.ran} ran, ${totals.skipped} skipped, ${totals.unstable} unstable.  ${((Date.now() - started) / 1000).toFixed(0)}s`);
    if (skips.length) console.log(`skipped because the data had nothing to test them with:\n${skips.map((s) => `  - ${s}`).join('\n')}`);
    if (totals.failed) process.exitCode = 1;
    else if (totals.unstable || totals.checks === 0) process.exitCode = 2;
  } finally {
    try { await conn.rollback(); } catch { /* nothing open */ }
    await conn.end();
  }
}

main().catch((e) => { console.error(e.stack ?? e.message ?? e); process.exit(2); });
