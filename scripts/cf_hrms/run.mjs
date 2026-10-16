/**
 * run.mjs — run the CF_HRMS suites a change needs, one after another.
 *
 *   node scripts/cf_hrms/run.mjs                    = --changed (the default)
 *   node scripts/cf_hrms/run.mjs --changed          suites for what changed: commits not on origin/main,
 *                                                   plus staged, unstaged and untracked files
 *   node scripts/cf_hrms/run.mjs --since=<ref>      the same from <ref> (a release batch: the last released commit)
 *   node scripts/cf_hrms/run.mjs --area=leave,performance
 *   node scripts/cf_hrms/run.mjs --suite=label      (label, label_test or label_test.mjs; several with commas)
 *   node scripts/cf_hrms/run.mjs --all              every *_test.mjs (wide changes, or a weekly check)
 *   node scripts/cf_hrms/run.mjs --list             the map, and what --changed would pick; runs nothing
 *
 * Any other flag (--company=karni, --verbose …) is passed to every suite. --verbose
 * also prints each suite's own output; otherwise it goes to a log file, named on failure.
 *
 * The suites share the LOCAL database, so they run one at a time. A suite that
 * counts rows (hrms_audit_log …) can trip when another agent writes at the same
 * moment: rerun that suite alone (--suite=<name>) before believing a count failure.
 *
 * Run from multi_app_be. Local only, like the suites themselves.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

/* ══════════════════════════════════════════════════════════════════════════
 * THE MAP — edit here. Paths are relative to multi_app_be; `*` is one path
 * part, `**` any depth. A file may be in several areas: every one counts.
 * ════════════════════════════════════════════════════════════════════════ */
const H = 'apps/cf_hrms';
const AREAS = {
  access: {
    suites: ['access_test'],
    paths: [`${H}/lib/access.js`, `${H}/lib/accessContext.js`, `${H}/lib/routeTable.js`, `${H}/lib/redact.js`, `${H}/services/access*.js`,
      `${H}/routes/access.js`, `${H}/ACCESS.md`, `${H}/resourceDef.json`, `${H}/scripts/make-access-doc.mjs`, `${H}/scripts/setup-access.mjs`,
      `${H}/scripts/apply-access-schema.mjs`, `${H}/scripts/make-owner-admin.mjs`, `${H}/scripts/create-employee-logins.mjs`, 'core/query/**'],
  },
  team: {
    suites: ['team_scope_test'],
    paths: [`${H}/services/teamScopeService.js`],
  },
  labels: {
    suites: ['label_test'],
    paths: [`${H}/services/departmentLabelService.js`, `${H}/services/labelGroupService.js`, `${H}/services/newPositionShift.js`,
      `${H}/services/excel/entities/_labels.js`, `${H}/scripts/cleanupALabels.mjs`, `${H}/scripts/labelGroupsMigration.mjs`,
      `${H}/scripts/apply-label-*.mjs`, `${H}/scripts/apply-cleanup-a.mjs`],
  },
  departments: {
    suites: ['departments_model_test', 'label_test'],
    paths: [`${H}/services/departmentRollupService.js`, `${H}/routes/organisation.js`],
  },
  chart: {
    suites: ['one_chair_test', 'departments_model_test', 'team_scope_test', 'semantic_search_test'],
    paths: [`${H}/services/orgChartService.js`, `${H}/services/selfOrgChartService.js`, `${H}/services/positionCards.js`, `${H}/services/seatCount.js`,
      `${H}/routes/orgchart.js`, `${H}/routes/overview.js`, `${H}/scripts/lib/oneChairGuard.mjs`, `${H}/scripts/one-chair-positions.mjs`],
  },
  positions: {
    suites: ['one_chair_test', 'hiring_test', 'team_scope_test'],
    paths: [`${H}/services/positionService.js`, `${H}/services/employeePositionsService.js`, `${H}/services/assignmentService.js`,
      `${H}/services/reportingResolver.js`, `${H}/routes/positions.js`, `${H}/routes/assignments.js`, `${H}/routes/workforce.js`],
  },
  imports: {
    suites: ['one_chair_test'],
    paths: [`${H}/scripts/import-org-chart.mjs`, `${H}/scripts/org-apply-workbook.mjs`, `${H}/scripts/org-template.mjs`, `${H}/scripts/orgChartSource.mjs`,
      `${H}/scripts/verify-against-source.mjs`, `${H}/scripts/lib/orgWorkbookReader.mjs`, `${H}/scripts/lib/orgTemplateSheets.mjs`, `${H}/routes/imports.js`],
  },
  roles: {
    suites: ['content_copy_test', 'job_history_test', 'kpi_targets_test'],
    paths: [`${H}/services/roleContentService.js`, `${H}/services/kpiTarget.js`, `${H}/scripts/apply-kpi-targets-schema.mjs`, `${H}/scripts/structure-kpi-targets.mjs`, `${H}/services/contentCopyService.js`, `${H}/services/jobContentService.js`,
      `${H}/services/jobHistoryService.js`, `${H}/services/datedChange.js`, `${H}/routes/roles.js`, `${H}/scripts/apply-history-schema.mjs`, `${H}/scripts/kra-review.mjs`],
  },
  documents: {
    suites: ['content_copy_test', 'job_history_test', 'hiring_test'],
    paths: [`${H}/services/documentService.js`, `${H}/services/documentStorage.js`, `${H}/services/render/**`, `${H}/routes/documents.js`],
  },
  people: {
    suites: ['exit_test', 'hiring_test', 'team_scope_test'],
    paths: [`${H}/services/peopleService.js`, `${H}/services/exitService.js`, `${H}/services/exitRead.js`, `${H}/routes/people.js`, `${H}/routes/exits.js`],
  },
  hiring: {
    suites: ['hiring_test'],
    paths: [`${H}/services/hiringService.js`, `${H}/services/hiringRead.js`, `${H}/services/letterRenderer.js`, `${H}/services/docxText.js`,
      `${H}/routes/hiring.js`, `${H}/scripts/make-letter-templates.mjs`, `${H}/scripts/apply-hiring-tables.mjs`],
  },
  codes: {
    suites: ['hiring_test', 'label_test'],
    paths: [`${H}/services/codeService.js`, `${H}/services/codegenProvider.js`, `${H}/services/codegenOrgProvider.js`, `${H}/routes/codegen.js`,
      `${H}/scripts/setup-codes.mjs`, `${H}/scripts/recode-company.mjs`, 'apps/cf_erp/modules/codegen/**'],
  },
  time: {
    suites: ['shift_calendar_test'],
    paths: [`${H}/services/shiftRead.js`, `${H}/scripts/apply-shift-calendar-schema.mjs`, `${H}/services/excel/entities/shifts.js`,
      `${H}/services/excel/entities/holidays.js`, `${H}/routes/organisation.js`],
  },
  self: {
    suites: ['one_chair_test', 'exit_test', 'shift_calendar_test', 'leave_policy_test', 'leave_request_test'],
    paths: [`${H}/services/selfService.js`, `${H}/routes/self.js`],
  },
  leave: {
    suites: ['leave_policy_test', 'leave_rules_test', 'leave_request_test', 'label_test'],
    paths: [`${H}/services/leavePolicy*.js`, `${H}/services/leave/**`, `${H}/routes/leave.js`, `${H}/scripts/apply-leave-*.mjs`,
      `${H}/scripts/setup-karni-exec-leave.mjs`, `${H}/services/excel/entities/leaveBalances.js`, `${H}/services/reportingResolver.js`],
  },
  performance: {
    suites: ['performance_test', 'actuals_test', 'reviews_test', 'kpi_targets_test'],
    paths: [`${H}/services/performance/**`, `${H}/routes/performance.js`, `${H}/scripts/apply-performance-schema.mjs`, `${H}/scripts/apply-actuals-schema.mjs`,
      `${H}/scripts/apply-reviews-schema.mjs`, `${H}/scripts/setup-performance.mjs`, `${H}/services/excel/entities/actuals.js`],
  },
  ask: {
    suites: ['ask_test', 'semantic_search_test'],
    paths: [`${H}/services/semantic/**`, `${H}/scripts/build-search-index.mjs`, `${H}/scripts/apply-search-schema.mjs`],
  },
  commands: {
    suites: ['command_bar_test', 'job_history_test', 'label_test'],
    paths: [`${H}/services/commands/**`, `${H}/routes/commands.js`],
  },
  excel: {
    suites: ['excel_test'],
    paths: [`${H}/services/excel/**`, `${H}/routes/excel.js`],
  },
};

/** A change here can break any suite: --all, with the reason. */
const CORE = [`${H}/app.js`, `${H}/lib/errors.js`, `${H}/lib/listFilters.js`, `${H}/lib/db.js`, `${H}/lib/http.js`, `${H}/lib/batch.js`, `${H}/lib/gates.js`,
  `${H}/services/organisationService.js`, `${H}/services/contentResolver.js`, 'db.js', 'core/middleware/**', 'core/utils/jwt.js', 'package.json'];

/** Always-include rules: [glob, suite, why]. */
const ALWAYS = [
  [`${H}/routes/**`, 'access_test', 'a route changed (every route has a guard and a row in ACCESS.md)'],
  [`${H}/lib/access.js`, 'access_test', 'the catalogue of rights changed'],
  [`${H}/services/accessScope.js`, 'access_test', 'department scope changed'],
  [`${H}/services/excel/**`, 'excel_test', 'an Excel entity or the engine changed'],
];
/** These changes also run the ACCESS.md check. */
const ACCESS_DOC = [`${H}/routes/**`, `${H}/lib/access.js`, `${H}/lib/routeTable.js`, `${H}/lib/http.js`];
/** Changed files outside these roots are not cf_hrms backend: they pick nothing. */
const WATCHED = [`${H}/**`, 'scripts/cf_hrms/**', 'core/**', 'db.js', 'package.json', 'apps/cf_erp/modules/codegen/**'];
/** Watched files that no test covers, on purpose (one-off and operations scripts, data). Said, not run. */
const NO_SUITE = [`${H}/models/**`, `${H}/scripts/backup-company.mjs`, `${H}/scripts/restore-company.mjs`, `${H}/scripts/clear-company-hrms.mjs`,
  `${H}/scripts/schema-diff.mjs`, `${H}/scripts/dbTarget.mjs`, `${H}/scripts/setup-karni.mjs`, `${H}/scripts/workbook-tests/**`, 'scripts/cf_hrms/run.mjs',
  `${H}/routes/index.js`];

/* ══════════════════════════════════════════════════════════════════════════ */
const BE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FE = path.resolve(BE, '../multi_app_fe');
const SUITES_DIR = path.join(BE, 'scripts/cf_hrms');
const ALL = fs.readdirSync(SUITES_DIR).filter((f) => f.endsWith('_test.mjs')).map((f) => f.replace(/\.mjs$/, '')).sort();

const OWN = ['--changed', '--all', '--list'];
const args = process.argv.slice(2);
const val = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const has = (name) => args.includes(`--${name}`);
const pass = args.filter((a) => !OWN.includes(a) && !/^--(area|suite|since)=/.test(a));
const VERBOSE = pass.includes('--verbose');

const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
const matches = (file, globs) => globs.some((g) => globRe(g).test(file));
const sec = (ms) => (ms / 1000).toFixed(1);

function git(cwd, ...a) {
  try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map((s) => s.trim()).filter(Boolean); } catch { return null; }
}

/** The changed files of a repo: commits since `base` (merge-base), plus staged, unstaged and untracked. */
function changedFiles(cwd, base, roots) {
  const committed = git(cwd, 'diff', '--name-only', `${base}...HEAD`);
  if (committed === null) throw new Error(`git cannot compare with "${base}" in ${cwd}. Is the ref right (git fetch?)`);
  const work = [
    ...(git(cwd, 'diff', '--name-only') ?? []),
    ...(git(cwd, 'diff', '--name-only', '--cached') ?? []),
    ...(git(cwd, 'ls-files', '--others', '--exclude-standard', '--', ...roots) ?? []),
  ];
  return [...new Set([...committed, ...work])].sort();
}

/** What a set of changed files needs: { suites: Map(suite -> [why]), all: [why], unmapped, ignored, accessDoc }. */
function pick(files) {
  const suites = new Map();
  const add = (s, why) => { if (!ALL.includes(s)) return; if (!suites.has(s)) suites.set(s, []); suites.get(s).push(why); };
  const all = [];
  const unmapped = [];
  const ignored = [];
  let accessDoc = false;
  for (const f of files) {
    if (!matches(f, WATCHED)) { ignored.push(f); continue; }
    let hit = false;
    if (matches(f, CORE)) { all.push(`${f} is shared by every area`); hit = true; }
    const suiteFile = /^scripts\/cf_hrms\/([a-z_]+_test)\.mjs$/.exec(f);
    if (suiteFile) {
      if (fs.existsSync(path.join(BE, f))) add(suiteFile[1], `${f} (the suite itself)`);
      hit = true; // a deleted suite runs nothing
    }
    for (const [area, def] of Object.entries(AREAS)) if (matches(f, def.paths)) { for (const s of def.suites) add(s, `${f} (${area})`); hit = true; }
    for (const [g, s, why] of ALWAYS) if (matches(f, [g])) { add(s, `${f}: ${why}`); hit = true; }
    if (matches(f, ACCESS_DOC)) accessDoc = true;
    if (!hit && matches(f, NO_SUITE)) hit = true;
    if (!hit) unmapped.push(f);
  }
  return { suites, all, unmapped, ignored, accessDoc };
}

function frontendChanges(base) {
  if (!fs.existsSync(path.join(FE, '.git'))) return [];
  try { return changedFiles(FE, base, ['src']).filter((f) => f.startsWith('src/')); } catch { return []; }
}

/* ── run ─────────────────────────────────────────────────────────────────── */
function runSuite(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(SUITES_DIR, `${name}.mjs`), ...pass], { cwd: BE, env: process.env });
    let out = '';
    const take = (d) => { const t = d.toString(); out += t; if (VERBOSE) process.stdout.write(t); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => {
      const ms = Date.now() - started;
      const m = /(\d+) passed, (\d+) failed/.exec(out.split('\n').filter((l) => /\d+ passed, \d+ failed/.test(l)).pop() ?? '');
      const logDir = path.join(os.tmpdir(), 'cf_hrms_test_logs');
      fs.mkdirSync(logDir, { recursive: true });
      const log = path.join(logDir, `${name}.log`);
      fs.writeFileSync(log, out);
      const fails = out.split('\n').filter((l) => /^\s*(FAIL|-)\s/.test(l) && /FAIL/.test(l)).map((l) => l.trim());
      resolve({ name, ok: code === 0, code, ms, passed: m ? Number(m[1]) : null, failed: m ? Number(m[2]) : null, log, fails });
    });
  });
}

function accessDocCheck() {
  const started = Date.now();
  try {
    const out = execFileSync(process.execPath, ['apps/cf_hrms/scripts/make-access-doc.mjs', '--check'], { cwd: BE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, ms: Date.now() - started, line: (out.split('\n').find((l) => /ACCESS\.md/.test(l)) ?? 'up to date').trim() };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, line: `${String(e.stderr ?? '').split('\n').filter((l) => /ACCESS|-/.test(l)).join(' ').trim() || 'out of date'} — run node apps/cf_hrms/scripts/make-access-doc.mjs` };
  }
}

function printMap() {
  console.log('The map (scripts/cf_hrms/run.mjs, top of the file):');
  const w = Math.max(...Object.keys(AREAS).map((a) => a.length));
  for (const [area, def] of Object.entries(AREAS)) console.log(`  ${area.padEnd(w)}  ${def.suites.join(', ')}`);
  console.log(`  ${'core'.padEnd(w)}  --all (${CORE.join(', ')})`);
  const inMap = new Set(Object.values(AREAS).flatMap((d) => d.suites));
  const orphan = ALL.filter((s) => !inMap.has(s));
  if (orphan.length) console.log(`  suites in no area (run only by --all, --suite or their own change): ${orphan.join(', ')}`);
}

function describe(picked, label) {
  if (picked.all.length) {
    console.log(`${label}: EVERY suite (${ALL.length}) — a shared core file changed:`);
    for (const why of picked.all.slice(0, 5)) console.log(`  - ${why}`);
  } else if (!picked.suites.size) console.log(`${label}: no suite.`);
  else {
    console.log(`${label}: ${picked.suites.size} suite(s)`);
    for (const s of ALL.filter((x) => picked.suites.has(x))) {
      const why = picked.suites.get(s);
      console.log(`  ${s.padEnd(24)} ${why.slice(0, 2).join('; ')}${why.length > 2 ? ` (+${why.length - 2} more)` : ''}`);
    }
  }
  if (picked.unmapped.length) console.log(`  not in the map (add them to AREAS if a suite should cover them): ${picked.unmapped.join(', ')}`);
  if (picked.accessDoc) console.log('  routes or rights changed: the ACCESS.md check runs too');
}

/* ── main ────────────────────────────────────────────────────────────────── */
const area = val('area');
const suiteArg = val('suite');
const since = val('since');
let chosen = [];
let accessDoc = false;
let mode = 'changed';

if (has('all')) {
  mode = 'all';
  chosen = [...ALL];
  accessDoc = true;
} else if (area) {
  mode = 'area';
  const names = area.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !AREAS[n]);
  if (bad.length) { console.error(`Unknown area: ${bad.join(', ')}. Areas: ${Object.keys(AREAS).join(', ')}`); process.exit(2); }
  const set = new Set(names.flatMap((n) => AREAS[n].suites));
  chosen = ALL.filter((s) => set.has(s));
} else if (suiteArg) {
  mode = 'suite';
  for (const raw of suiteArg.split(',').map((s) => s.trim()).filter(Boolean)) {
    const n = raw.replace(/\.mjs$/, '');
    const name = ALL.includes(n) ? n : ALL.includes(`${n}_test`) ? `${n}_test` : null;
    if (!name) { console.error(`No suite "${raw}". Suites: ${ALL.join(', ')}`); process.exit(2); }
    if (!chosen.includes(name)) chosen.push(name);
  }
} else {
  const base = since ?? 'origin/main';
  const files = changedFiles(BE, base, [H, 'scripts/cf_hrms']);
  const picked = pick(files);
  const fe = frontendChanges(base);
  const label = `--${since ? `since=${since}` : 'changed'} (${files.length - picked.ignored.length} backend file(s) changed${since ? '' : ' since origin/main, committed or not'})`;
  if (has('list')) {
    printMap();
    console.log('');
    describe(picked, label);
    if (fe.length) console.log(`  multi_app_fe: ${fe.length} changed file(s) — frontend changes run no backend suite`);
    if (picked.ignored.length) console.log(`  outside cf_hrms (ignored): ${picked.ignored.length} file(s)`);
    process.exit(0);
  }
  describe(picked, label);
  if (!picked.all.length && !picked.suites.size) {
    if (fe.length) console.log(`Frontend-only change (${fe.length} file(s) in multi_app_fe): nothing to run here.`);
    else console.log('Nothing to run.');
    if (!picked.accessDoc) process.exit(0);
  }
  chosen = picked.all.length ? [...ALL] : ALL.filter((s) => picked.suites.has(s));
  accessDoc = picked.accessDoc;
}

if (has('list')) {
  printMap();
  console.log(`\n--${mode} would run: ${chosen.join(', ') || 'nothing'}`);
  process.exit(0);
}

console.log(`\nRunning ${chosen.length} suite(s), one at a time (they share the local database)${pass.length ? `, with ${pass.join(' ')}` : ''}:`);
const results = [];
const t0 = Date.now();
for (const name of chosen) {
  const r = await runSuite(name);
  results.push(r);
  const counts = r.passed == null ? `exit ${r.code}` : `${r.passed} passed, ${r.failed} failed`;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} ${counts.padEnd(22)} ${sec(r.ms).padStart(6)} s`);
  if (!r.ok) {
    for (const f of r.fails.slice(0, 6)) console.log(`          ${f.slice(0, 220)}`);
    console.log(`          log: ${r.log}`);
  }
}
let doc = null;
if (accessDoc) {
  doc = accessDocCheck();
  console.log(`  ${doc.ok ? 'PASS' : 'FAIL'}  ${'ACCESS.md --check'.padEnd(24)} ${doc.line.slice(0, 60).padEnd(22)} ${sec(doc.ms).padStart(6)} s`);
}

const total = Date.now() - t0;
const bad = results.filter((r) => !r.ok);
console.log('\nSummary');
console.log(`  ${'suite'.padEnd(24)} ${'result'.padEnd(6)} ${'passed'.padStart(6)} ${'failed'.padStart(6)} ${'seconds'.padStart(8)}`);
for (const r of results) console.log(`  ${r.name.padEnd(24)} ${(r.ok ? 'pass' : 'FAIL').padEnd(6)} ${String(r.passed ?? '-').padStart(6)} ${String(r.failed ?? '-').padStart(6)} ${sec(r.ms).padStart(8)}`);
if (doc) console.log(`  ${'ACCESS.md --check'.padEnd(24)} ${(doc.ok ? 'pass' : 'FAIL').padEnd(6)} ${''.padStart(6)} ${''.padStart(6)} ${sec(doc.ms).padStart(8)}`);
const checks = results.reduce((t, r) => t + (r.passed ?? 0), 0);
console.log(`  ${'total'.padEnd(24)} ${(bad.length || (doc && !doc.ok) ? 'FAIL' : 'pass').padEnd(6)} ${String(checks).padStart(6)} ${String(results.reduce((t, r) => t + (r.failed ?? 0), 0)).padStart(6)} ${sec(total).padStart(8)}`);
if (bad.some((r) => r.fails.some((f) => /count|rows|left behind|as it was|as it started/i.test(f)))) {
  console.log('\nA count check failed. The local DB is shared: if another agent was running suites, rerun that suite alone (--suite=<name>) before believing it.');
}
process.exit(bad.length || (doc && !doc.ok) ? 1 : 0);
