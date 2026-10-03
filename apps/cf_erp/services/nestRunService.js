/**
 * nestRunService.js — a nesting run that keeps going when the person leaves the
 * page (user, 2026-10-03: "once I start nesting, if I go somewhere else, the
 * nesting is closing").
 *
 * WHY. /plan ran inside the HTTP request: leaving the page dropped the request,
 * and the proposal — the only output, since /plan writes nothing — went with it.
 * A run is now a JOB the server owns, one per order line: started by POST, read
 * by GET while it works (progress + a short log), its proposal kept until it is
 * accepted or dismissed. The page polls; leave and come back and it is still
 * there.
 *
 * IN MEMORY, ON PURPOSE. A proposal is large (thousands of placed pieces) and
 * lives minutes, not days; the backend is one instance (render.yaml). A restart
 * loses a run in flight — the page says it was interrupted and offers to start
 * again. Nothing here writes the database: accepting is still /accept.
 *
 * One run per line at a time: starting while one runs returns that run.
 * Finished runs are kept for KEEP_MS, then forgotten.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../lib/db.js';
import { planNesting } from './nestingService.js';

const KEEP_MS = 6 * 60 * 60 * 1000;
const LOG_CAP = 200;
const runs = new Map();          // `${companyId}:${lineId}` -> run

const keyOf = (companyId, lineId) => `${Number(companyId)}:${Number(lineId)}`;

function sweep(now = Date.now()) {
  for (const [k, r] of runs) if (r.finishedAt && now - r.finishedAt > KEEP_MS) runs.delete(k);
}

function log(run, text) {
  run.log.push({ at: new Date().toISOString(), text });
  if (run.log.length > LOG_CAP) run.log.splice(0, run.log.length - LOG_CAP);
}

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
    progress: { done, total, pct },
    startedAt: new Date(run.startedAt).toISOString(),
    startedBy: run.startedBy,
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    elapsedMs: (run.finishedAt ?? now) - run.startedAt,
    budgetMs: run.budgetMs,
    effort: run.input.effort ?? 'standard',
    // Accept needs it back: a 'Redo all' proposal replaces the imported nests too.
    replaceImported: run.input.replaceImported === true,
    log: run.log,
    error: run.error,
    summary: run.summary,
    ...(withPlan && run.status === 'done' ? { plan: run.plan } : {}),
  };
}

/**
 * POST …/nesting/runs — starts a run for the line (input as /plan: effort,
 * guillotine, seed, replaceImported, ignoreChoices…), or returns the one
 * already running. The checks /plan makes up front (frozen, plates left…) run
 * inside the job, so a refusal arrives as a failed run with the same words.
 */
export function startRun(companyId, c, lineId, input = {}) {
  sweep();
  const key = keyOf(companyId, lineId);
  const existing = runs.get(key);
  if (existing?.status === 'running') return snapshot(existing);
  const clean = { ...input };
  delete clean.pack; delete clean.onProgress;          // never from a request body
  const run = {
    id: randomUUID(), companyId: Number(companyId), lineId: Number(lineId),
    status: 'running', phase: 'reading', progress: { done: 0, total: 0 },
    startedAt: Date.now(), finishedAt: null, startedBy: c?.userName ?? c?.email ?? c?.userId ?? null,
    budgetMs: null, input: clean, log: [], error: null, plan: null, summary: null,
  };
  runs.set(key, run);
  log(run, `Started (${clean.effort ?? 'standard'} effort)`);
  const onProgress = (e) => {
    if (e.phase) run.phase = e.phase;
    if (e.total != null) run.progress.total = e.total;
    if (e.done != null) run.progress.done = e.done;
    if (e.budgetMs) run.budgetMs = e.budgetMs;
    if (e.text) log(run, e.text);
  };
  // Detached on purpose: the request returns now and the run carries on.
  (async () => {
    try {
      const plan = await planNesting(pool, companyId, lineId, { ...clean, onProgress });
      run.plan = plan;
      const t = plan.totals ?? {};
      run.summary = { plates: t.plates ?? 0, pieces: t.pieces ?? 0, wastePct: t.wastePct ?? null, problems: (plan.problems ?? []).length };
      run.status = 'done'; run.phase = 'done';
      log(run, `Finished: ${t.plates ?? 0} plate${t.plates === 1 ? '' : 's'}, ${t.pieces ?? 0} pieces placed${t.wastePct != null ? `, ${t.wastePct}% waste` : ''}${run.summary.problems ? ` · ${run.summary.problems} problem${run.summary.problems === 1 ? '' : 's'} to read` : ''}`);
    } catch (err) {
      run.status = 'failed'; run.phase = 'failed';
      run.error = { code: err?.code ?? 'FAILED', message: err?.message ?? String(err), problems: err?.problems ?? null };
      log(run, `Stopped: ${run.error.message}`);
    } finally {
      run.finishedAt = Date.now();
    }
  })();
  return snapshot(run);
}

/** GET …/nesting/runs/current — the line's run (running, or finished and not yet dismissed). */
export function currentRun(companyId, lineId, { withPlan = false } = {}) {
  sweep();
  return snapshot(runs.get(keyOf(companyId, lineId)), { withPlan });
}

/** DELETE …/nesting/runs/current, and after an accept: the finished run is forgotten. A running one is left to finish. */
export function dismissRun(companyId, lineId) {
  const key = keyOf(companyId, lineId);
  const r = runs.get(key);
  if (r && r.status !== 'running') runs.delete(key);
  return { ok: true, running: r?.status === 'running' };
}

/** Tests only. */
export const _runs = runs;
