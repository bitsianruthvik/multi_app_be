/**
 * nestRunService.js — a nesting run that keeps going when the person leaves the
 * page (user, 2026-10-03: "once I start nesting, if I go somewhere else, the
 * nesting is closing") — and, since 2026-10-10 (init.sql §55), one whose answer
 * is KEPT: "if an auto run already happened, then just pull that up and compare".
 *
 * WHY. /plan ran inside the HTTP request: leaving the page dropped the request,
 * and the proposal — the only output, since /plan writes nothing — went with it.
 * A run is a JOB the server owns, one per order line: started by POST, read
 * by GET while it works (progress + a short log), its proposal kept until it is
 * accepted or dismissed. The page polls; leave and come back and it is still
 * there.
 *
 * WHAT IS IN MEMORY AND WHAT IS IN THE DATABASE.
 *   memory          the run while it works: phase, progress, log. One instance
 *                   (render.yaml), so the poll reads it here, at no round trip.
 *   cf_nest_runs    one row per run and scope, written when it STARTS (status
 *                   running) and when it ENDS (ready + the whole proposal, or
 *                   failed + why), with the fingerprint of what it was asked
 *                   (nestingService.demandOf). So:
 *                     - a finished run survives a restart: readRun finds it;
 *                     - a run the restart killed reads as FAILED, with the reason
 *                       (a row still `running` that no run in memory owns);
 *                     - a comparison can pull up the run that already answers
 *                       its demand instead of packing again (nestCompareService).
 *   The row is the run's own record and nothing reads a layout from it except a
 *   person accepting it: accepting is still /accept, which verifies everything.
 *
 * STATUS WORDS. The page's poll says running | done | failed, as it always did.
 * The table says running | ready | failed | accepted | discarded: `ready` is
 * `done`; `accepted` and `discarded` are what a COMPARISON decided — the automatic
 * side taken, or the uploaded side taken (nestCompareService.acceptCompare).
 *
 * One run per line at a time, of either purpose (a nesting run, or the automatic
 * side of a comparison): starting the same purpose while one runs returns that
 * run; starting the other is refused in words. Finished runs are kept in memory
 * for KEEP_MS, then forgotten there (the row stays).
 *
 * TIME, PROGRESS, STOP, CANCEL (2026-10-10 — runs are 5, 10 and 20 minutes now).
 *   budget     ONE for the whole run (nestingService.NEST_BUDGET_MS by effort), shared equally by
 *              the plans the run makes (a comparison makes two) and, inside a plan, by the steels.
 *              It is a ceiling: a small line is done in seconds (shapePacker.SHAPE_EFFORT).
 *   progress   `progress.best` — plates, steel bought, waste %, pieces not placed, of the best
 *              layout of the WHOLE line so far — and `progress.curve`, every time it got better
 *              (at most CURVE_CAP points). `elapsedMs` / `budgetMs` were there already.
 *   stop       stopRun(): "stop and use this". Every job in flight finishes with the best layout
 *              it has, within a rebuild; the run then ends as any other — `done`, a proposal to
 *              accept — with `stopped: true`. Nothing is thrown away.
 *   cancel     cancelRun(): the same stop, and the run is DISCARDED: forgotten at once (a new one
 *              may start), its row deleted, whatever its workers hand back seconds later dropped.
 * The stop is one flag in shared memory for the whole run (run.control.stop — lib/packerPool
 * hands it to every worker), because a pack is one synchronous stretch no message can reach.
 *
 * DISMISS (the page's "close this proposal") forgets the run and DELETES its row:
 * a proposal a person threw away is not something to pull up later. Accepting it
 * (/accept) keeps the row — still `ready`, with `dismissed_at` set so the page's
 * poll no longer offers it — because it IS the automatic nesting of that demand,
 * and a later comparison should find it.
 *
 * LONG RUNS ON A SMALL INSTANCE THAT SLEEPS AND RESTARTS (2026-10-10; user: "We can even run it
 * for one hour in production and wait for that to happen before working on it").
 *   heartbeat    the process working a run touches its head row every HEARTBEAT_MS. "Live" is
 *                then a fact any process can read: a row `running` whose heartbeat is older than
 *                STALE_MS belongs to nobody.
 *   checkpoint   every CHECKPOINT_MS, and at once when a whole plate is saved, the run writes ONE
 *                UPDATE on its head row: the best layout of every steel so far (placements only —
 *                a few hundred kB gzipped for a bridge-size line, far under the 6 MB row), which
 *                steels are finished, the curve, the budget used. From this thread, on a timer:
 *                the workers only hand layouts out, they never write.
 *   resume       a run found `running` and not live is PICKED UP AGAIN, not failed: on the next
 *                read of the line's run (the page's poll, a comparison) or AT BOOT (resumeAtBoot).
 *                It is claimed with one guarded UPDATE (…WHERE id = ? AND the heartbeat is stale —
 *                affectedRows says who won; two resumes cannot both), then continues with the
 *                budget that was left, every steel started from its checkpointed layout, finished
 *                steels and finished plans not redone. It FAILS, with the reason, only when there
 *                is no checkpoint (INTERRUPTED), the line's demand changed (DEMAND_CHANGED), it has
 *                been resumed MAX_RESUMES times (RESUME_LIMIT), or two resumes in a row died within
 *                a minute (CRASH_LOOP — a run that kills the server must not loop).
 *   stop         "stop and use this" on a run that is not live resumes it WITH THE STOP SET: every
 *                steel hands back its checkpointed layout at once and the run ends `done`.
 *   keep awake   while a run is live the server pings its own public /health (lib/keepAwake.js).
 */
import { randomUUID } from 'node:crypto';
import { gzip, gzipSync, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { pool } from '../lib/db.js';
import { invalid } from '../lib/errors.js';
import { holdAwake, releaseAwake, keepAwakeState } from '../lib/keepAwake.js';
import { planNesting, runBudgetMs, effortOf } from './nestingService.js';
// One run per line packs plates AND sections (CF_ERP_CUT_FROM_PLAN.md §4.5).
import { planSectionNesting } from './sectionNestingService.js';

const KEEP_MS = 6 * 60 * 60 * 1000;
const LOG_CAP = 200;
/** Points kept of a run's improvement curve (the first, then every better layout; the oldest middle ones go). */
const CURVE_CAP = 240;
/** No run is given more than this, whatever a request asks (the Long budget, unscaled). */
const MAX_RUN_BUDGET_MS = 60 * 60_000;
/** A proposal bigger than this is stored gzipped; one still over ROW_CAP is not stored (TiDB: 6 MB an entry). */
const GZIP_OVER = 1024 * 1024;
const ROW_CAP = 5 * 1024 * 1024;
/** The process working a run says so this often; a heartbeat older than STALE_MS is nobody's. */
export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 90_000;
/** A checkpoint at least this often while the best layout keeps changing (and at once when a plate is saved). */
export const CHECKPOINT_MS = 60_000;
/** A checkpoint row may be at most this big (gzip + base64). Measured on a bridge-size line: ~0.2 MB. */
export const CHECKPOINT_CAP = 4 * 1024 * 1024;
/** A run is picked up again at most this many times; and not after two resumes in a row that died within QUICK_DEATH_S. */
export const MAX_RESUMES = 10;
export const QUICK_DEATH_S = 60;
const runs = new Map();          // `${companyId}:${lineId}` -> run (the line's ONE run, of either purpose)
const pending = new Set();       // database writes still on their way (tests wait on them)

const keyOf = (companyId, lineId) => `${Number(companyId)}:${Number(lineId)}`;
const missingTable = (e) => e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146;
const missingColumn = (e) => e?.code === 'ER_BAD_FIELD_ERROR' || e?.errno === 1054;
export const INTERRUPTED = 'The server restarted while this run was in flight, so it never finished — start it again.';
/** CF_NEST_BUDGET_SCALE (tests only) also scales how often a run checkpoints, so a scaled run still does. */
const scale = () => { const v = Number(process.env.CF_NEST_BUDGET_SCALE); return Number.isFinite(v) && v > 0 ? v : 1; };
const checkpointEveryMs = () => Math.max(300, Math.round(CHECKPOINT_MS * scale()));

function sweep(now = Date.now()) {
  for (const [k, r] of runs) if (r.finishedAt && now - r.finishedAt > KEEP_MS) runs.delete(k);
}

function log(run, text) {
  run.log.push({ at: new Date().toISOString(), text });
  if (run.log.length > LOG_CAP) run.log.splice(0, run.log.length - LOG_CAP);
}

/**
 * A database write that must never break (or delay) a run: tracked, one after another per run,
 * and a failure is only remembered (`persistError`) — the run's own log stays the run's story.
 */
function keep(run, fn) {
  const p = (run?.persist ?? Promise.resolve()).then(fn).catch((e) => { if (run && !missingTable(e)) run.persistError = e?.message ?? String(e); });
  if (run) run.persist = p;
  pending.add(p);
  p.finally(() => pending.delete(p));
  return p;
}

/** Every database write a run has started has landed. For tests, and for a caller that must read its own write. */
export async function settleRuns() { while (pending.size) await Promise.allSettled([...pending]); }

/* ───────────────────────────── packing a proposal into a row ───────────────────────────── */

export function packPlan(value) {
  if (value == null) return { text: null, encoding: null, bytes: 0 };
  const json = JSON.stringify(value);
  if (json.length <= GZIP_OVER) return { text: json, encoding: 'json', bytes: json.length };
  const gz = gzipSync(Buffer.from(json, 'utf8')).toString('base64');
  if (gz.length > ROW_CAP) return { text: null, encoding: null, bytes: json.length, tooBig: true };
  return { text: gz, encoding: 'gzip', bytes: json.length };
}

/**
 * packPlan for a RUN's proposal: the same answer, with the compression done off this thread
 * (zlib's own pool). A bridge-size proposal is several megabytes of JSON; gzipSync on it was the
 * one stretch over 200 ms seen on the event loop during a five-minute run.
 */
const gzipAsync = promisify(gzip);
export async function packPlanAsync(value) {
  if (value == null) return { text: null, encoding: null, bytes: 0 };
  const json = JSON.stringify(value);
  if (json.length <= GZIP_OVER) return { text: json, encoding: 'json', bytes: json.length };
  const gz = (await gzipAsync(Buffer.from(json, 'utf8'))).toString('base64');
  if (gz.length > ROW_CAP) return { text: null, encoding: null, bytes: json.length, tooBig: true };
  return { text: gz, encoding: 'gzip', bytes: json.length };
}

export function unpackPlan(text, encoding) {
  if (text == null) return null;
  try { return JSON.parse(encoding === 'gzip' ? gunzipSync(Buffer.from(text, 'base64')).toString('utf8') : text); } catch { return null; }
}

const parseJson = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

/** A checkpoint as its column holds it: always gzip + base64 (it is layouts — repetitive, and written every minute). */
export async function packCheckpoint(value) {
  const json = JSON.stringify(value);
  const text = (await gzipAsync(Buffer.from(json, 'utf8'))).toString('base64');
  return { text, bytes: text.length, rawBytes: json.length };
}
export function unpackCheckpoint(text) {
  if (text == null) return null;
  try { return JSON.parse(gunzipSync(Buffer.from(String(text), 'base64')).toString('utf8')); } catch { return null; }
}

/* ───────────────────────────── what a caller sees ───────────────────────────── */

/** How much of its budget a run has used: what earlier lives of it used, and this one so far. */
const usedMs = (run, now = Date.now()) => (run.usedBeforeMs ?? 0) + Math.max(0, (run.finishedAt ?? now) - (run.liveSince ?? run.startedAt));

/** What a caller sees. The proposal only on request (it is big), and only once the run is done. */
export function snapshot(run, { withPlan = false } = {}) {
  if (!run) return { status: 'none' };
  const now = Date.now();
  const { done, total } = run.progress;
  // Jobs settled is the honest measure while packing; before and after it the phase says where it is.
  const pct = run.status === 'done' ? 100
    : run.phase === 'shaping' ? 97
      : total ? Math.min(95, Math.round(5 + (90 * done) / total))
        : run.phase === 'grouping' ? 4 : 2;
  return {
    runId: run.id,
    lineId: run.lineId,
    status: run.status,               // running | done | failed
    phase: run.phase,                 // reading | grouping | packing | shaping | done | failed
    progress: {
      done, total, pct,
      // The best layout of the whole line so far: { plates, areaBoughtM2, wastePct, unplaced, atMs } — null until every steel has one.
      best: run.best ?? null,
      // Every time it got better: [{ atMs, plates, areaBoughtM2, wastePct, unplaced }], oldest first.
      curve: run.curve ?? [],
      // The last checkpoint written (what a restart would continue from), and how many times this run was picked up again.
      checkpointAt: run.checkpointAt ? new Date(run.checkpointAt).toISOString() : null,
      checkpointAgeMs: run.checkpointAt && run.status === 'running' ? now - run.checkpointAt : null,
      checkpointBytes: run.checkpointBytes ?? null,
      resumes: run.resumes ?? 0,
      // The server pinging its own public health URL while a run is live (lib/keepAwake.js).
      keepAwake: keepAwakeState(),
    },
    // "Stop and use this" is possible while it works; `stopRequested` once somebody asked; `stopped` when that is how it ended.
    canStop: run.status === 'running' && !run.stopRequested,
    stopRequested: run.stopRequested === true,
    stopped: run.stopped === true,
    // true = this run was picked up again after the server slept or restarted, and is working again.
    resumed: (run.resumes ?? 0) > 0,
    startedAt: new Date(run.startedAt).toISOString(),
    startedBy: run.startedBy,
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    // Time WORKED (a run that slept does not count the sleep), against its budget.
    elapsedMs: run.restored ? (run.finishedAt ?? now) - run.startedAt : usedMs(run, now),
    budgetMs: run.budgetMs,
    effort: effortOf(run.input.effort ?? 'standard'),
    // Accept needs it back: a 'Redo all' proposal replaces the imported nests too.
    replaceImported: run.input.replaceImported === true,
    // §55: a nesting run, or the automatic side of a comparison; and whether it came back from the database.
    purpose: run.purpose ?? 'nest',
    restored: run.restored === true,
    log: run.log,
    error: run.error,
    summary: run.summary,
    // The section plan (SectionNestingView, as POST …/section-nesting/plan) made by the same run.
    ...(withPlan && run.status === 'done' ? { plan: run.plan, sections: run.sections } : {}),
  };
}

const summaryOf = (plan, sections) => {
  const t = plan?.totals ?? {};
  return {
    plates: t.plates ?? 0, pieces: t.pieces ?? 0, wastePct: t.wastePct ?? null, problems: (plan?.problems ?? []).length,
    bars: sections ? sections.profiles.reduce((a, p) => a + (p.plan?.barsBought ?? 0), 0) : 0,
  };
};

const metricsOfJob = (run, j, first) => JSON.stringify({
  ...summaryOf(j.plan, first ? run.sections : null),
  demand: j.demand ? { pieces: j.demand.pieces, pieceCount: j.demand.pieceCount, drawings: j.demand.drawings } : null,
  budgetMs: run.budgetMs, effort: effortOf(j.input.effort ?? 'standard'),
});

/* ───────────────────────────── start ───────────────────────────── */

/**
 * POST …/nesting/runs — starts a run for the line (input as /plan: effort,
 * guillotine, seed, replaceImported, ignoreChoices…), or returns the one
 * already running. The checks /plan makes up front (frozen, plates left…) run
 * inside the job, so a refusal arrives as a failed run with the same words.
 *
 * `opts` is the service's own (never a request body):
 *   purpose  'nest' (the default) | 'compare'
 *   jobs     [{ scope, input }] — the plans this run makes, in order. A nesting
 *            run is one job; a comparison may make two (the pieces the upload
 *            covers, and the whole line). Each job is one row of cf_nest_runs.
 */
export function startRun(companyId, c, lineId, input = {}, opts = {}) {
  sweep();
  const purpose = opts.purpose === 'compare' ? 'compare' : 'nest';
  const key = keyOf(companyId, lineId);
  const existing = runs.get(key);
  if (existing?.status === 'running') {
    if ((existing.purpose ?? 'nest') === purpose) return snapshot(existing);
    throw invalid('RUN_BUSY', existing.purpose === 'compare'
      ? 'A comparison is working out our automatic nesting for this line — wait for it to finish before starting a nesting run.'
      : 'A nesting run is working on this line — wait for it to finish before comparing.');
  }
  const clean = { ...input };
  delete clean.pack; delete clean.onProgress; delete clean.onDemand; delete clean.demandOnly;   // never from a request body
  delete clean.control; delete clean.background; delete clean.workers; delete clean.resume; delete clean.onCheckpoint; delete clean.checkpointMs;
  if (purpose === 'nest') delete clean.only;
  clean.effort = effortOf(clean.effort);
  const jobs = (opts.jobs?.length ? opts.jobs : [{ scope: clean.replaceImported === true ? 'line' : 'rest', input: clean }])
    .map((j) => ({ scope: j.scope, input: { ...j.input, effort: effortOf(j.input.effort ?? clean.effort) }, plan: null, demand: null }));
  const asked = Number(clean.budgetMs);
  const run = {
    id: randomUUID(), companyId: Number(companyId), lineId: Number(lineId), purpose,
    status: 'running', phase: 'reading', progress: { done: 0, total: 0 },
    startedAt: Date.now(), finishedAt: null, startedBy: c?.userName ?? c?.email ?? c?.userId ?? null, userId: c?.userId ?? null,
    // THE RUN'S BUDGET: the level's (or what the caller asked, never above the Long budget), shared
    // equally by the plans this run makes.
    budgetMs: Math.min(MAX_RUN_BUDGET_MS, Number.isFinite(asked) && asked > 0 ? asked : runBudgetMs(clean.effort)),
    input: clean, log: [], error: null, plan: null, summary: null, sections: null,
    jobs, persist: null, persisted: false, pack: opts.pack ?? null,
    best: null, curve: [], stopRequested: false, stopped: false, cancelled: false, killed: false, lost: false,
    usedBeforeMs: 0, liveSince: Date.now(), resumes: 0, claim: randomUUID(),
    checkpointAt: null, checkpointBytes: null,
    // What a checkpoint is made of: the best layout of each steel of the plan being made now.
    ck: { jobIndex: 0, groups: {}, demand: {}, dirty: false, now: false, lastAt: 0 },
    // One flag for every worker of the run: 1 = finish now with the best layout so far.
    control: { stop: new Int32Array(new SharedArrayBuffer(4)) },
    // The pool in the app. A test hands in its own connection (`opts.db`) so the run sees its uncommitted rows.
    db: opts.db ?? pool,
  };
  const dbh = run.db;
  runs.set(key, run);
  log(run, `Started (${clean.effort} effort, up to ${run.budgetMs >= 60_000 ? `${Math.round(run.budgetMs / 60_000)} min` : `${Math.round(run.budgetMs / 1000)} s`}${jobs.length > 1 ? `, ${jobs.length} plans` : ''})`);

  // The row, straight away: the run exists even if this process dies before it ends. The FIRST
  // row is the run's head: it carries the claim, the heartbeat and the checkpoint.
  keep(run, async () => {
    for (const [i, j] of jobs.entries()) {
      const base = [run.companyId, run.lineId, run.id, j.scope, purpose, JSON.stringify({ ...j.input, only: j.input.only ? Object.fromEntries(Object.entries(j.input.only)) : undefined }),
        new Date(run.startedAt), run.startedBy == null ? null : String(run.startedBy).slice(0, 190), run.userId];
      try {
        await dbh.query(
          `INSERT INTO cf_nest_runs (company_id, order_line_id, run_uid, kind, scope, purpose, status, params_json, started_at, started_by_name, created_by, heartbeat_at, claim_token, claimed_at, budget_ms, budget_used_ms)
           VALUES (?, ?, ?, 'auto', ?, ?, 'running', ?, ?, ?, ?, NOW(3), ?, NOW(3), ?, 0)`,
          [...base, i === 0 ? run.claim : null, run.budgetMs],
        );
      } catch (e) {
        // A database that has not had the run columns yet: the run still works, it only cannot be picked up again.
        if (!missingColumn(e)) throw e;
        run.noResume = true;
        await dbh.query(
          `INSERT INTO cf_nest_runs (company_id, order_line_id, run_uid, kind, scope, purpose, status, params_json, started_at, started_by_name, created_by)
           VALUES (?, ?, ?, 'auto', ?, ?, 'running', ?, ?, ?, ?)`, base,
        );
      }
    }
    run.persisted = true;
  });
  launch(run, key);
  return snapshot(run);
}

/* ───────────────────────────── the run itself ───────────────────────────── */

/**
 * ONE UPDATE: the run's checkpoint on its head row (and its heartbeat with it). Guarded by the
 * claim: if another process has claimed the run meanwhile (this one was thought dead), nothing is
 * written, and THIS process lets go — it stops its workers and keeps nothing.
 */
async function writeCheckpoint(run) {
  if (!run.persisted || run.noResume || run.lost || run.cancelled || run.killed) return;
  const body = {
    v: 1, jobIndex: run.ck.jobIndex, scope: run.jobs[run.ck.jobIndex]?.scope ?? null,
    demand: run.ck.demand, groups: run.ck.groups, best: run.best, curve: run.curve, log: run.log.slice(-40),
  };
  let packed = await packCheckpoint(body);
  // Never over the row: the curve and the log go first — the layouts are what a resume needs.
  if (packed.bytes > CHECKPOINT_CAP) packed = await packCheckpoint({ ...body, curve: body.curve.slice(-20), log: [] });
  if (packed.bytes > CHECKPOINT_CAP) { run.persistError = `The checkpoint is ${(packed.bytes / 1048576).toFixed(1)} MB — too large to keep; this run cannot be picked up again after a restart.`; return; }
  const used = usedMs(run);
  const [res] = await run.db.query(
    `UPDATE cf_nest_runs SET checkpoint_json = ?, checkpoint_at = NOW(3), heartbeat_at = NOW(3), budget_used_ms = ?
      WHERE company_id = ? AND run_uid = ? AND scope = ? AND status = 'running' AND claim_token = ?`,
    [packed.text, Math.round(used), run.companyId, run.id, run.jobs[0].scope, run.claim],
  );
  if ((res.affectedRows ?? 0) === 0) { letGo(run); return; }
  run.checkpointAt = Date.now();
  run.checkpointBytes = packed.bytes;
  run.checkpoints = (run.checkpoints ?? 0) + 1;
}

async function writeHeartbeat(run) {
  if (!run.persisted || run.noResume || run.lost || run.cancelled || run.killed) return;
  const [res] = await run.db.query(
    "UPDATE cf_nest_runs SET heartbeat_at = NOW(3), budget_used_ms = ? WHERE company_id = ? AND run_uid = ? AND scope = ? AND status = 'running' AND claim_token = ?",
    [Math.round(usedMs(run)), run.companyId, run.id, run.jobs[0].scope, run.claim],
  );
  if ((res.affectedRows ?? 0) === 0) letGo(run);
}

/** Another process owns this run now (or its row is gone): stop working it, keep nothing of it. */
function letGo(run) {
  if (run.lost) return;
  run.lost = true;
  Atomics.store(run.control.stop, 0, 1);
  const key = keyOf(run.companyId, run.lineId);
  if (runs.get(key) === run) runs.delete(key);
}

/**
 * Works a run to its end, detached: the request that started (or resumed) it has returned.
 * `resume` = the checkpoint a resumed run continues from.
 */
function launch(run, key, { resume = null } = {}) {
  const dbh = run.db;
  const { jobs, purpose } = run;
  holdAwake(run.id);

  // Heartbeat and checkpoint, from THIS thread, on one small timer. Never from a worker.
  let lastBeat = Date.now();
  const every = checkpointEveryMs();
  const tick = setInterval(() => {
    if (run.status !== 'running') return;
    const now = Date.now();
    if (run.ck.dirty && (run.ck.now || now - run.ck.lastAt >= every)) {
      run.ck.dirty = false; run.ck.now = false; run.ck.lastAt = now; lastBeat = now;
      keep(run, () => writeCheckpoint(run));
    } else if (now - lastBeat >= Math.min(HEARTBEAT_MS, Math.max(300, every))) {
      lastBeat = now;
      keep(run, () => writeHeartbeat(run));
    }
  }, Math.min(1000, Math.max(100, Math.round(every / 4))));
  if (typeof tick.unref === 'function') tick.unref();

  let base = 0;                                      // jobs settled by the plans before this one
  let bestPlates = run.best?.plates ?? Infinity;
  const onProgress = (e) => {
    if (e.phase) run.phase = e.phase;
    if (e.total != null) run.progress.total = base + e.total;
    if (e.done != null) run.progress.done = base + e.done;
    if (e.text) log(run, e.text);
    // A run picked up again begins from its checkpoint: the first figures that come in (each steel's row floor,
    // before its search has re-read the kept layout) are worse than what it already had, and are not its best.
    if (e.best && run.best && (e.best.unplaced > run.best.unplaced || (e.best.unplaced === run.best.unplaced && e.best.areaBoughtM2 > run.best.areaBoughtM2 + 1e-9))) return;
    if (e.best) {
      const at = Math.round(usedMs(run));
      run.best = { plates: e.best.plates, areaBoughtM2: e.best.areaBoughtM2, wastePct: e.best.wastePct, unplaced: e.best.unplaced, atMs: at, scope: run.scopeNow ?? null };
      const last = run.curve.at(-1);
      // A resumed run starts from where it was: its figure is a new point only when it is a better one.
      if (!last || e.best.unplaced < last.unplaced || e.best.areaBoughtM2 < last.areaBoughtM2 - 1e-9 || e.best.plates < last.plates) {
        run.curve.push({ atMs: at, plates: e.best.plates, areaBoughtM2: e.best.areaBoughtM2, wastePct: e.best.wastePct, unplaced: e.best.unplaced });
        // Too many points: every other one of the older half goes (the first and the newest stay).
        if (run.curve.length > CURVE_CAP) run.curve = run.curve.filter((pt, i, all) => i === 0 || i >= all.length / 2 || i % 2 === 0);
      }
      // A whole plate saved: checkpoint now, not at the next minute.
      if (e.best.plates < bestPlates) { bestPlates = e.best.plates; run.ck.now = true; }
    }
  };
  // Detached on purpose: the request returns now and the run carries on.
  (async () => {
    try {
      const todo = jobs.filter((j) => !j.plan).length;
      const left = Math.max(1, run.budgetMs - (run.usedBeforeMs ?? 0));
      const perPlanMs = Math.max(1, Math.floor(left / Math.max(1, todo)));
      for (const [i, j] of jobs.entries()) {
        if (j.plan) { if (i === 0) run.plan = j.plan; continue; }      // a plan an earlier life of this run finished
        if (jobs.length > 1) log(run, j.scope === 'line' ? 'The whole line, for the second figure' : 'The pieces the uploaded files cover');
        run.scopeNow = j.scope;
        const kept = resume && resume.jobIndex === i ? resume : null;
        // Another plan starts its own best-so-far: the last one's figure is another question's answer.
        if (!kept) { run.best = null; bestPlates = Infinity; if (i > 0) run.curve = []; }
        run.ck.jobIndex = i;
        run.ck.groups = kept ? { ...kept.groups } : {};
        j.plan = await planNesting(dbh, run.companyId, run.lineId, {
          ...j.input, ...(run.pack ? { pack: run.pack } : {}), onProgress,
          onDemand: (d) => {
            j.demand = d;
            // THE LINE CHANGED UNDER A RUN THAT IS BEING PICKED UP AGAIN: its checkpoint answers another question.
            if (kept?.demand?.[j.scope] && kept.demand[j.scope] !== d.hash) { j.demandChanged = true; Atomics.store(run.control.stop, 0, 1); }
            run.ck.demand = { ...run.ck.demand, [j.scope]: d.hash };
          },
          // A background run: the level's budget (its share of what is left), the stop flag, never the short synchronous budget.
          background: true, budgetMs: perPlanMs, control: run.control,
          // Checkpoints: each steel's best layout as it gets better, and its final one. Kept here; written by the timer.
          checkpointMs: every,
          onCheckpoint: (groupKey, c) => { run.ck.groups[groupKey] = { start: c.start ?? null, fill: c.fill ?? null, done: c.done === true, plates: c.plates, areaBought: c.areaBought, unplaced: c.unplaced, seed: c.seed ?? null }; run.ck.dirty = true; if (c.done) run.ck.now = true; },
          ...(kept ? { resume: { groups: kept.groups ?? {}, count: run.resumes } } : {}),
        });
        if (run.cancelled || run.killed || run.lost) throw Object.assign(new Error('The run was cancelled.'), { code: 'CANCELLED' });
        if (j.demandChanged) throw invalid('DEMAND_CHANGED', 'The line changed while this run was asleep — its pieces, their quantities, the cut settings, the plate choices or the drawings are not what the run was nesting. Start a new run.');
        base = run.progress.total;
        if (i === 0) run.plan = j.plan;
        // A finished plan is kept AT ONCE (the row stays `running` until the whole run ends): a run
        // picked up again does not make it a second time.
        if (jobs.length > 1 && i < jobs.length - 1) {
          keep(run, async () => {
            if (!run.persisted || run.lost) return;
            const packed = await packPlanAsync({ plan: j.plan });
            j.packed = packed;
            await dbh.query("UPDATE cf_nest_runs SET demand_hash = ?, plan_json = ?, plan_encoding = ? WHERE company_id = ? AND run_uid = ? AND scope = ? AND status = 'running'",
              [j.demand?.hash ?? null, packed.text, packed.encoding, run.companyId, run.id, j.scope]);
          });
          run.ck.groups = {}; run.ck.jobIndex = i + 1; run.ck.dirty = true; run.ck.now = true;
        }
      }
      // Sections next: a failure there is logged, never fails the plate run.
      if (purpose === 'nest') {
        try {
          const sec = await planSectionNesting(dbh, run.companyId, run.lineId);
          if (sec.profiles.length) {
            run.sections = sec;
            const bars = sec.profiles.reduce((a, p) => a + (p.plan?.barsBought ?? 0), 0);
            log(run, `Sections: ${sec.profiles.length} profile${sec.profiles.length === 1 ? '' : 's'}, ${bars} bar${bars === 1 ? '' : 's'} to buy${sec.problems.length ? ` · ${sec.problems.length} problem${sec.problems.length === 1 ? '' : 's'} to read` : ''}`);
          }
        } catch (e) {
          log(run, `Sections not planned: ${e?.message ?? e}`);
        }
      }
      const plan = run.plan;
      const t = plan.totals ?? {};
      run.summary = summaryOf(plan, run.sections);
      run.status = 'done'; run.phase = 'done';
      run.stopped = run.stopRequested === true && jobs.some((j) => j.plan?.budget?.stopped);
      if (run.stopped) log(run, 'Stopped on request: this is the best layout it had.');
      log(run, `Finished: ${t.plates ?? 0} plate${t.plates === 1 ? '' : 's'}, ${t.pieces ?? 0} pieces placed${t.wastePct != null ? `, ${t.wastePct}% waste` : ''}${run.summary.problems ? ` · ${run.summary.problems} problem${run.summary.problems === 1 ? '' : 's'} to read` : ''}`);
    } catch (err) {
      run.status = 'failed'; run.phase = 'failed';
      run.error = { code: err?.code ?? 'FAILED', message: err?.message ?? String(err), problems: err?.problems ?? null };
      log(run, `Stopped: ${run.error.message}`);
    } finally {
      clearInterval(tick);
      releaseAwake(run.id);
      run.finishedAt = Date.now();
      // A cancelled run was forgotten when it was cancelled; a killed or lost one is not this process's to write.
      if (run.cancelled || run.killed || run.lost) return;      // eslint-disable-line no-unsafe-finally
      // The answer, kept: the proposal and what it was asked — or why it failed.
      keep(run, async () => {
        if (!run.persisted || run.dismissed) return;
        for (const [i, j] of jobs.entries()) {
          const ok = run.status === 'done' && j.plan;
          const packed = ok ? (j.packed ?? await packPlanAsync(i === 0 && purpose === 'nest' ? { plan: j.plan, sections: run.sections } : { plan: j.plan })) : { text: null, encoding: null };
          if (packed.tooBig) run.persistError = 'The proposal is too large to keep in the database; it is held in memory only.';
          await dbh.query(
            `UPDATE cf_nest_runs SET status = ?, demand_hash = ?, plan_json = ?, plan_encoding = ?, metrics_json = ?, error_json = ?, log_json = ?, finished_at = ?${run.noResume ? '' : ', checkpoint_json = NULL, budget_used_ms = ?'}
              WHERE company_id = ? AND run_uid = ? AND scope = ? AND status = 'running'`,
            [ok ? 'ready' : 'failed', j.demand?.hash ?? null, packed.text, packed.encoding,
              ok ? metricsOfJob(run, j, i === 0) : null,
              ok ? null : JSON.stringify(run.error ?? { code: 'FAILED', message: 'Another part of this run failed.' }), JSON.stringify(run.log.slice(-LOG_CAP)), new Date(run.finishedAt),
              ...(run.noResume ? [] : [Math.round(usedMs(run))]),
              run.companyId, run.id, j.scope],
          );
        }
      });
    }
  })();
  void key;
}

/* ───────────────────────────── read ───────────────────────────── */

/** GET …/nesting/runs/current — the line's run IN MEMORY (running, or finished and not yet dismissed). Synchronous. */
export function currentRun(companyId, lineId, { withPlan = false } = {}) {
  sweep();
  const run = runs.get(keyOf(companyId, lineId));
  return snapshot(run && (run.purpose ?? 'nest') === 'nest' ? run : null, { withPlan });
}

/** The run of either purpose the line has in memory (nestCompareService polls a comparison through this). */
export function memoryRun(companyId, lineId) { sweep(); return runs.get(keyOf(companyId, lineId)) ?? null; }

/** A row of cf_nest_runs as the run the page knows. */
function runOfRow(row, { withPlan }) {
  const startedAt = row.started_at ? new Date(row.started_at).getTime() : Date.now();
  const finishedAt = row.finished_at ? new Date(row.finished_at).getTime() : null;
  const m = parseJson(row.metrics_json) ?? null;
  const stored = withPlan && row.status !== 'failed' ? unpackPlan(row.plan_json, row.plan_encoding) : null;
  const params = parseJson(row.params_json) ?? {};
  return {
    id: row.run_uid, companyId: row.company_id, lineId: row.order_line_id, purpose: row.purpose ?? 'nest',
    status: row.status === 'failed' ? 'failed' : 'done', phase: row.status === 'failed' ? 'failed' : 'done',
    progress: { done: 0, total: 0 }, startedAt, finishedAt: finishedAt ?? startedAt, startedBy: row.started_by_name ?? null,
    budgetMs: m?.budgetMs ?? row.budget_ms ?? null, input: params, log: parseJson(row.log_json) ?? [],
    error: parseJson(row.error_json), plan: stored?.plan ?? null, sections: stored?.sections ?? null,
    summary: m ? { plates: m.plates, pieces: m.pieces, wastePct: m.wastePct, problems: m.problems, bars: m.bars } : null,
    resumes: Number(row.resume_count ?? 0), restored: true,
  };
}

/**
 * GET …/nesting/runs/current, restart-proof: the run in memory, else the newest one the database
 * kept for this line (a nesting run, not dismissed, not yet accepted, no older than KEEP_MS).
 * A row still `running` that nothing in memory owns was cut off by a sleep or a restart: it is
 * PICKED UP AGAIN from its checkpoint (resumeRun) and read back as the running run it is; only
 * when it cannot be (no checkpoint, too many resumes…) is it marked failed, with the reason.
 */
export async function readRun(companyId, lineId, { withPlan = false, db = pool } = {}) {
  const mem = currentRun(companyId, lineId, { withPlan });
  if (mem.status !== 'none') return mem;
  let rows;
  try {
    [rows] = await db.query(
      // The proposal (megabytes) only when it is asked for: this is the page's poll.
      `SELECT id, company_id, order_line_id, run_uid, purpose, status, params_json, metrics_json, error_json, log_json, started_at, finished_at, started_by_name${withPlan ? ', plan_json, plan_encoding' : ''}
         FROM cf_nest_runs
        WHERE company_id = ? AND order_line_id = ? AND kind = 'auto' AND purpose = 'nest' AND deleted_at IS NULL AND dismissed_at IS NULL
          AND status IN ('running', 'ready', 'failed')
        ORDER BY id DESC LIMIT 1`,
      [companyId, lineId],
    );
  } catch (e) { if (missingTable(e)) return { status: 'none' }; throw e; }
  const row = rows[0];
  if (!row) return { status: 'none' };
  if (row.status !== 'running' && Date.now() - new Date(row.started_at ?? Date.now()).getTime() > KEEP_MS) return { status: 'none' };
  if (row.status === 'running') {
    if (memoryRun(companyId, lineId)?.id === row.run_uid) return { status: 'none' };   // a comparison's rows are not this endpoint's
    const back = await resumeRun(companyId, lineId, { db, purpose: 'nest' });
    if (back.snapshot) return withPlan ? currentRun(companyId, lineId, { withPlan }) : back.snapshot;
    if (back.live) return { ...snapshot({ ...runOfRow(row, { withPlan: false }), status: 'running', phase: 'packing', finishedAt: null, restored: false }), elsewhere: true };
    row.status = 'failed';
    row.error_json = JSON.stringify(back.error ?? { code: 'INTERRUPTED', message: INTERRUPTED });
    row.finished_at = new Date();
  }
  return snapshot(runOfRow(row, { withPlan }), { withPlan });
}

/** Rows still `running` whose run this process does not own: failed, with the reason. One statement. */
export async function markInterrupted(db, companyId, uids, error = { code: 'INTERRUPTED', message: INTERRUPTED }) {
  const mine = new Set([...runs.values()].filter((r) => r.status === 'running').map((r) => r.id));
  const lost = uids.filter((u) => !mine.has(u));
  if (!lost.length) return 0;
  const [res] = await db.query(
    "UPDATE cf_nest_runs SET status = 'failed', error_json = ?, finished_at = NOW(3) WHERE company_id = ? AND run_uid IN (?) AND status = 'running'",
    [JSON.stringify(error), companyId, lost],
  );
  return res.affectedRows ?? 0;
}

/* ───────────────────────────── resume ───────────────────────────── */

/**
 * PICK UP AGAIN the run a line has `running` in the database that no process is working
 * (heartbeat older than STALE_MS): claim it atomically, rebuild it from its checkpoint, and work
 * it with the budget that was left. `stop: true` = pick it up only to finish at once with what the
 * checkpoint holds ("stop and use this" on a run that is not live).
 *
 * → { snapshot }            it is running again here (or already was)
 *   { live: true }          another process is working it (its heartbeat is fresh), or just claimed it
 *   { failed: true, error } it could not be picked up, and is now `failed` with that reason
 *   { none: true }          the line has no such run
 */
export async function resumeRun(companyId, lineId, { db = pool, purpose = null, stop = false } = {}) {
  const key = keyOf(companyId, lineId);
  const inMemory = runs.get(key);
  if (inMemory?.status === 'running') return { snapshot: snapshot(inMemory) };
  let rows;
  try {
    [rows] = await db.query(
      `SELECT r.*, (r.heartbeat_at IS NOT NULL AND r.heartbeat_at >= NOW(3) - INTERVAL ? SECOND) AS is_live
         FROM cf_nest_runs r
        WHERE r.company_id = ? AND r.order_line_id = ? AND r.kind = 'auto' AND r.deleted_at IS NULL AND r.status = 'running'${purpose ? ' AND r.purpose = ?' : ''}
        ORDER BY r.id`,
      [STALE_MS / 1000, companyId, lineId, ...(purpose ? [purpose] : [])],
    );
  } catch (e) {
    if (missingTable(e)) return { none: true };
    if (!missingColumn(e)) throw e;
    return { failed: true, error: { code: 'INTERRUPTED', message: INTERRUPTED }, legacy: true };   // no run columns yet: as before §55's additions
  }
  if (!rows.length) return { none: true };
  // The newest run with a row still running; its head is its first row (lowest id of that run).
  const uid = rows.at(-1).run_uid;
  const mine = rows.filter((r) => r.run_uid === uid);
  const fail = async (error) => { await markInterrupted(db, companyId, [uid], error); return { failed: true, error }; };
  const [allRows] = await db.query('SELECT * FROM cf_nest_runs WHERE company_id = ? AND run_uid = ? AND deleted_at IS NULL ORDER BY id', [companyId, uid]);
  const head = allRows[0];
  // "Live" is the head row's heartbeat: fresh = some process is working this run.
  if (Number(rows.find((r) => r.id === head.id)?.is_live ?? 0) === 1) return { live: true };
  if (head.status !== 'running') return fail({ code: 'INTERRUPTED', message: INTERRUPTED });
  void mine;
  if (head.checkpoint_json == null) return fail({ code: 'INTERRUPTED', message: INTERRUPTED });

  // THE CLAIM. One UPDATE, guarded by the stale heartbeat: of two resumes at once exactly one changes
  // the row. `quick_deaths` counts resumes in a row that died within a minute of being claimed —
  // worked out from the row's OLD values (written first, and reading nothing this statement sets,
  // so MySQL's left-to-right and TiDB's read-the-old-row give the same answer).
  const token = randomUUID();
  const [claim] = await db.query(
    `UPDATE cf_nest_runs SET
        quick_deaths = IF(resume_count > 0 AND claimed_at IS NOT NULL AND TIMESTAMPDIFF(SECOND, claimed_at, COALESCE(heartbeat_at, claimed_at)) < ?, quick_deaths + 1, 0),
        resume_count = resume_count + 1, claim_token = ?, claimed_at = NOW(3), heartbeat_at = NOW(3)
      WHERE id = ? AND status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < NOW(3) - INTERVAL ? SECOND)`,
    [QUICK_DEATH_S, token, head.id, STALE_MS / 1000],
  );
  if ((claim.affectedRows ?? 0) !== 1) return { live: true };
  const [[now]] = await db.query('SELECT resume_count, quick_deaths FROM cf_nest_runs WHERE id = ?', [head.id]);
  if (Number(now.quick_deaths) >= 2) return fail({ code: 'CRASH_LOOP', message: `This run was picked up again twice in a row and died within a minute each time, so it is not picked up a third time — it may be what is bringing the server down. Start a new run (a lower effort, or fewer pieces at once).` });
  if (Number(now.resume_count) > MAX_RESUMES) return fail({ code: 'RESUME_LIMIT', message: `This run was interrupted and picked up again ${MAX_RESUMES} times without finishing, so it is stopped here. Start it again — or run it on a machine that stays up (scripts/cf_kepl/nest-line.mjs).` });
  const ck = unpackCheckpoint(head.checkpoint_json);
  if (!ck || ck.v !== 1) return fail({ code: 'INTERRUPTED', message: INTERRUPTED });

  const jobs = allRows.map((r) => {
    const input = parseJson(r.params_json) ?? {};
    const done = r.plan_json != null ? unpackPlan(r.plan_json, r.plan_encoding)?.plan ?? null : null;
    return { scope: r.scope, input: { ...input, effort: effortOf(input.effort) }, plan: done, demand: done && r.demand_hash ? { hash: r.demand_hash } : null, packed: done ? { text: r.plan_json, encoding: r.plan_encoding } : undefined };
  });
  const startedAt = head.started_at ? new Date(head.started_at).getTime() : Date.now();
  const run = {
    id: uid, companyId: Number(companyId), lineId: Number(lineId), purpose: head.purpose ?? 'nest',
    status: 'running', phase: 'packing', progress: { done: 0, total: 0 },
    startedAt, finishedAt: null, startedBy: head.started_by_name ?? null, userId: head.created_by ?? null,
    budgetMs: Number(head.budget_ms) || runBudgetMs(effortOf(jobs[0].input.effort)),
    input: jobs[0].input, log: Array.isArray(ck.log) ? ck.log.slice() : [], error: null, plan: null, summary: null, sections: null,
    jobs, persist: null, persisted: true, pack: null,
    best: ck.best ?? null, curve: Array.isArray(ck.curve) ? ck.curve.slice() : [], stopRequested: false, stopped: false, cancelled: false, killed: false, lost: false,
    usedBeforeMs: Math.max(0, Number(head.budget_used_ms) || 0), liveSince: Date.now(), resumes: Number(now.resume_count), claim: token,
    checkpointAt: head.checkpoint_at ? new Date(head.checkpoint_at).getTime() : null, checkpointBytes: String(head.checkpoint_json).length,
    ck: { jobIndex: ck.jobIndex ?? 0, groups: { ...(ck.groups ?? {}) }, demand: { ...(ck.demand ?? {}) }, dirty: false, now: false, lastAt: Date.now() },
    control: { stop: new Int32Array(new SharedArrayBuffer(4)) },
    db,
  };
  // Lost a race inside this process (another call got here first while this one was reading).
  if (runs.get(key)?.status === 'running') return { snapshot: snapshot(runs.get(key)) };
  runs.set(key, run);
  const leftMs = Math.max(0, run.budgetMs - run.usedBeforeMs);
  log(run, `Picked up again (${run.resumes}${run.resumes === 1 ? 'st' : run.resumes === 2 ? 'nd' : run.resumes === 3 ? 'rd' : 'th'} time) from its checkpoint${run.best ? ` — ${run.best.plates} plates so far` : ''}; ${leftMs >= 60_000 ? `${Math.round(leftMs / 60_000)} min` : `${Math.round(leftMs / 1000)} s`} of its budget left`);
  if (stop) {
    run.stopRequested = true;
    Atomics.store(run.control.stop, 0, 1);
    log(run, 'Stop asked for: finishing with what the checkpoint holds');
  }
  launch(run, key, { resume: { jobIndex: ck.jobIndex ?? 0, groups: ck.groups ?? {}, demand: ck.demand ?? {} } });
  return { snapshot: snapshot(run) };
}

/**
 * AT BOOT (apps/cf_erp/app.js, a moment after the server is listening): every run left `running`
 * with a stale heartbeat — a deploy or a sleep cut it — is picked up again through the same claim,
 * so it carries on with nobody opening the screen. A boot-resume counts as a resume (MAX_RESUMES,
 * CRASH_LOOP). → { found, resumed, failed, live }
 */
export async function resumeAtBoot({ db = pool } = {}) {
  const out = { found: 0, resumed: 0, failed: 0, live: 0 };
  let rows;
  try {
    [rows] = await db.query(
      `SELECT DISTINCT company_id, order_line_id FROM cf_nest_runs
        WHERE kind = 'auto' AND status = 'running' AND deleted_at IS NULL AND (heartbeat_at IS NULL OR heartbeat_at < NOW(3) - INTERVAL ? SECOND)`,
      [STALE_MS / 1000],
    );
  } catch (e) { if (missingTable(e) || missingColumn(e)) return out; throw e; }
  out.found = rows.length;
  for (const r of rows) {
    try {
      const back = await resumeRun(r.company_id, r.order_line_id, { db });
      if (back.snapshot) out.resumed += 1; else if (back.failed) out.failed += 1; else if (back.live) out.live += 1;
    } catch { out.failed += 1; }
  }
  return out;
}

/* ───────────────────────────── stop, cancel ───────────────────────────── */

/**
 * POST …/nesting/runs/current/stop (and …/nesting/compare/stop) — "STOP AND USE THIS". The run of
 * the line (either purpose, or only `purpose`) finishes now with the best layout it has: every
 * job in flight ends within a rebuild, a steel not yet started gets its floor, and the run ends
 * `done` with `stopped: true` — a proposal like any other. Returns the run's snapshot; a run
 * that is not working is returned as it is (`stopRequested: false`).
 */
export function stopRun(companyId, lineId, { purpose = null } = {}) {
  const run = runs.get(keyOf(companyId, lineId));
  if (!run || (purpose && (run.purpose ?? 'nest') !== purpose)) return { status: 'none' };
  if (run.status === 'running' && !run.stopRequested) {
    run.stopRequested = true;
    Atomics.store(run.control.stop, 0, 1);
    log(run, 'Stop asked for: finishing with the best layout so far');
  }
  return snapshot(run);
}

/**
 * stopRun for the routes: also for a run that is NOT LIVE (the server slept or restarted under
 * it). Such a run is picked up again with the stop already set — every steel hands back the layout
 * its checkpoint holds and the run ends `done`, `stopped: true`, in seconds: the best-so-far of an
 * interrupted run can always be taken.
 */
export async function stopRunAnywhere(companyId, lineId, { purpose = null, db = pool } = {}) {
  const here = stopRun(companyId, lineId, { purpose });
  if (here.status !== 'none') return here;
  const back = await resumeRun(companyId, lineId, { db, purpose, stop: true });
  if (back.snapshot) return back.snapshot;
  if (back.failed) return { status: 'failed', error: back.error };
  return { status: 'none', ...(back.live ? { elsewhere: true } : {}) };
}

/**
 * CANCEL a run that is working (DELETE …/nesting/runs/current while it runs; DELETE
 * …/nesting/compare): its workers are told to stop — they do within a rebuild — and the run is
 * discarded at once: gone from memory (a new one may start straight away), its row deleted,
 * whatever comes back from the pool dropped. Returns { ok, cancelled }.
 */
export function cancelRun(companyId, lineId, { purpose = null } = {}) {
  const key = keyOf(companyId, lineId);
  const run = runs.get(key);
  if (!run || run.status !== 'running' || (purpose && (run.purpose ?? 'nest') !== purpose)) return { ok: true, cancelled: false };
  run.cancelled = true;
  run.stopRequested = true;
  Atomics.store(run.control.stop, 0, 1);
  runs.delete(key);
  releaseAwake(run.id);
  keep(run, async () => { await run.db.query('DELETE FROM cf_nest_runs WHERE company_id = ? AND run_uid = ?', [run.companyId, run.id]); });
  return { ok: true, cancelled: true, runId: run.id };
}

/* ───────────────────────────── dismiss ───────────────────────────── */

/**
 * DELETE …/nesting/runs/current, and after an accept: the finished run is forgotten. A running one
 * is CANCELLED. Dismissed = its row is deleted (a proposal thrown away is not pulled up
 * later); `accepted: true` (the route, after /accept) keeps the row and only takes it off the poll.
 * Returns at once; the database write follows (settleRuns waits for it).
 */
export function dismissRun(companyId, lineId, { accepted = false, db = pool } = {}) {
  const key = keyOf(companyId, lineId);
  const r = runs.get(key);
  if (r && (r.purpose ?? 'nest') !== 'nest') return { ok: true, running: false };
  // A run still working: dismissing it CANCELS it (2026-10-10 — it used to be left to finish, which
  // at twenty minutes is not what "close this" means).
  if (r && r.status === 'running' && !accepted) return { ok: true, running: false, ...cancelRun(companyId, lineId, { purpose: 'nest' }) };
  if (r && r.status !== 'running') {
    runs.delete(key);
    r.dismissed = !accepted;
    keep(r, async () => {
      if (!r.persisted) return;
      if (accepted) await r.db.query("UPDATE cf_nest_runs SET dismissed_at = NOW() WHERE company_id = ? AND run_uid = ? AND dismissed_at IS NULL", [r.companyId, r.id]);
      else await r.db.query('DELETE FROM cf_nest_runs WHERE company_id = ? AND run_uid = ?', [r.companyId, r.id]);
    });
  } else if (!r) {
    // Nothing in memory (a restart since): the newest undecided row of the line is the one meant —
    // a run cut off and never picked up again goes too (a `running` row nobody is working).
    keep(null, async () => {
      if (accepted) {
        await db.query(
          "UPDATE cf_nest_runs SET dismissed_at = NOW() WHERE company_id = ? AND order_line_id = ? AND kind = 'auto' AND purpose = 'nest' AND status = 'ready' AND dismissed_at IS NULL AND deleted_at IS NULL",
          [companyId, lineId],
        );
      } else {
        await db.query(
          "DELETE FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? AND kind = 'auto' AND purpose = 'nest' AND status IN ('ready', 'failed') AND dismissed_at IS NULL",
          [companyId, lineId],
        );
        await db.query(
          "DELETE FROM cf_nest_runs WHERE company_id = ? AND order_line_id = ? AND kind = 'auto' AND purpose = 'nest' AND status = 'running' AND dismissed_at IS NULL AND (heartbeat_at IS NULL OR heartbeat_at < NOW(3) - INTERVAL ? SECOND)",
          [companyId, lineId, STALE_MS / 1000],
        ).catch((e) => { if (!missingColumn(e)) throw e; });
      }
    });
  }
  return { ok: true, running: r?.status === 'running' };
}

/* ───────────────────────────── a run made elsewhere ───────────────────────────── */

/**
 * ONE finished run, written as the server writes its own: status `ready`, the demand fingerprint,
 * the proposal, its metrics and log. For a plan made OUTSIDE the server (scripts/cf_kepl/nest-line.mjs
 * — nested on a machine with all its cores, against the same database) so that the screen shows it,
 * a comparison finds it by its fingerprint, and /accept applies it. One INSERT.
 *   run: { companyId, lineId, plan, demand ({ hash, … } from planNesting's onDemand), input (params), scope,
 *          startedAt, finishedAt, startedBy, log?, sections?, userId? }
 * → { runId, rowId, bytes, encoding } — or throws TOO_BIG when the proposal does not fit a row.
 */
export async function insertFinishedRun(db, run) {
  const uid = randomUUID();
  const scope = run.scope ?? (run.input?.replaceImported === true ? 'line' : 'rest');
  const input = { ...(run.input ?? {}), effort: effortOf(run.input?.effort) };
  const packed = await packPlanAsync({ plan: run.plan, sections: run.sections ?? null });
  if (packed.tooBig) throw invalid('TOO_BIG', `The proposal is ${(packed.bytes / 1048576).toFixed(1)} MB of JSON and does not fit one database row even compressed.`);
  const j = { plan: run.plan, demand: run.demand ?? null, input };
  const budgetMs = Number(run.budgetMs) || runBudgetMs(input.effort);
  const [res] = await db.query(
    `INSERT INTO cf_nest_runs (company_id, order_line_id, run_uid, kind, scope, purpose, status, demand_hash, params_json, plan_json, plan_encoding, metrics_json, log_json, started_at, finished_at, started_by_name, created_by, budget_ms, budget_used_ms)
     VALUES (?, ?, ?, 'auto', ?, 'nest', 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [run.companyId, run.lineId, uid, scope, run.demand?.hash ?? null, JSON.stringify(input), packed.text, packed.encoding,
      metricsOfJob({ budgetMs, sections: run.sections ?? null }, j, true), JSON.stringify((run.log ?? []).slice(-LOG_CAP)),
      new Date(run.startedAt ?? Date.now()), new Date(run.finishedAt ?? Date.now()), String(run.startedBy ?? 'offline runner').slice(0, 190), run.userId ?? null,
      budgetMs, Math.max(0, Math.round((run.finishedAt ?? Date.now()) - (run.startedAt ?? Date.now())))],
  );
  return { runId: uid, rowId: res.insertId, bytes: packed.text.length, encoding: packed.encoding };
}

/** Tests only: the in-memory runs, and "the process restarted" (memory gone, rows left as they are). */
export const _runs = runs;
export async function _forgetMemory() { await settleRuns(); runs.clear(); }
/**
 * Tests only: THE PROCESS DIED under a run. Its workers are stopped and whatever they hand back is
 * dropped, its memory is gone — and its row is left exactly as it was: `running`, with the last
 * checkpoint and heartbeat it wrote. What a sleep, a deploy or a crash leaves behind.
 */
export async function _kill(companyId, lineId) {
  const key = keyOf(companyId, lineId);
  const run = runs.get(key);
  if (!run) return null;
  run.killed = true;
  Atomics.store(run.control.stop, 0, 1);
  runs.delete(key);
  releaseAwake(run.id);
  await settleRuns();
  return run;
}
