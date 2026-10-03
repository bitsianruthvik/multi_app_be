/**
 * packerPool.js — run several packs at once, and keep the BEST.
 *
 * WHY BEST-OF-N AND NOT JUST MORE RESTARTS
 *
 * Inside a single pack, the repair budget is spent on whichever restart came
 * out best; the other starting points are explored and abandoned. N independent
 * seeds give each starting point its own full budget, and — because the packer
 * is pure geometry — they run on N cores instead of one after another.
 *
 * Measured on the real KEPL line at 8 restarts, the seed alone moved the answer
 * by ~500 kg (651.158 t to 651.644 t across seeds 1-5). Seed 1 happened to be
 * the lucky one there. On the next order it will not be. Best-of-N is not
 * mainly a better average — it is not having to be lucky.
 *
 * DETERMINISM IS NOT NEGOTIABLE
 *
 * The winner is chosen by SCORE, with the seed as the tie-break — never by
 * which worker happened to finish first. Two runs of the same order return the
 * same layout whatever the machine load, which is what makes an answer
 * reproducible and a complaint about one investigable.
 */
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { rngFor } from '../services/nestingPacker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, '..', 'services', 'nestingWorker.js');

/**
 * N SEEDS THAT ARE ACTUALLY DIFFERENT, WORKED OUT IN ONE GO.
 *
 * Distinct integers are not the question. What matters is whether two seeds
 * drive DIFFERENT SEARCHES — two seeds whose random streams start in the same
 * place do identical work twice and one of the CPUs is wasted.
 *
 * So the seeds are stepped by the 32-bit golden ratio rather than by one.
 * Consecutive integers go into the same hash a few bits apart and can come out
 * correlated; a large odd stride spreads them across the space by construction,
 * which is why the usual answer is "generate them all at once" rather than
 * "draw one and hope".
 *
 * Then it is CHECKED rather than assumed, against the real generator the packer
 * will use. A seed whose first draw matches one already accepted is stepped
 * again, up to FIVE times; if it still collides it is dropped, because paying a
 * core to repeat a search already running buys nothing. Fewer seeds that differ
 * beats eight that do not.
 */
export function seedsFor(base, n) {
  const GOLDEN = 0x9E3779B1;                 // 2^32 / phi, odd: a full-period stride
  const MAX_TRIES = 5;
  const out = [];
  const streams = new Set();
  const dropped = [];
  for (let k = 0; k < n; k += 1) {
    let seed = (Math.imul(k, GOLDEN) + (Number(base) | 0)) | 0;
    let taken = false;
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      // The first draw of trial 1 IS the start of the search this seed runs.
      const first = rngFor(seed, 1)();
      if (!streams.has(first)) { streams.add(first); out.push(seed); taken = true; break; }
      seed = (Math.imul(seed ^ (k + 1), GOLDEN) + 1) | 0;   // step and try again
    }
    if (!taken) dropped.push(k);
  }
  out.dropped = dropped.length;
  return out;
}

/**
 * Roughly how long a job will take, for scheduling only. Total piece area is a
 * good enough proxy: it tracks both how many plates will be opened and how big
 * the knapsacks are. It never affects the answer, only the order of dispatch.
 */
const weightOf = (j) => (j.input?.pieces ?? []).reduce((a, p) => a + (Number(p.length) || 0) * (Number(p.width) || 0) * (Number(p.qty) || 1), 0);

/**
 * Roughly how long one TRIAL of a job costs, for ordering under a deadline.
 * Area is a poor proxy for that — on the KEPL line the largest group by area
 * (28 mm, forty identical webs) builds its floor in 11 ms and the 16 mm group
 * (nine distinct rows, 1,320 pieces) in 2 s. A trial places every piece and
 * weighs it against the distinct rows, so pieces x rows tracks it.
 */
const costOf = (j) => {
  const ps = j.input?.pieces ?? [];
  const qty = ps.reduce((a, p) => a + (Number(p.qty) || 1), 0);
  return qty * Math.max(1, ps.length);
};

/**
 * How many threads the host will let us have. `os.availableParallelism()`
 * where the runtime has it (it honours CPU affinity, and on newer runtimes the
 * container's CPU quota), `os.cpus().length` otherwise. Either can overstate a
 * container's real share, which is why the plan budget below is an ABSOLUTE
 * deadline and not a sum of per-job allowances: a wrong worker count can make
 * the search shallower, never the plan later.
 */
const hostThreads = () => {
  try { if (typeof os.availableParallelism === 'function') return os.availableParallelism(); } catch { /* fall through */ }
  return os.cpus()?.length ?? 2;
};

/**
 * Leave a core for the server itself; never more workers than there is work.
 * `cap` (or CF_NEST_WORKERS) can only LOWER it — the request body reaches this,
 * and a caller must not be able to ask for a thousand threads.
 */
export const poolSize = (jobs, cap = null) => {
  const envCap = Number(process.env.CF_NEST_WORKERS);
  let n = Math.max(1, hostThreads() - 1);
  for (const c of [cap, envCap]) {
    const v = Math.trunc(Number(c));
    if (c != null && c !== '' && Number.isFinite(v) && v >= 1) n = Math.min(n, v);
  }
  return Math.max(1, Math.min(jobs, n));
};

/**
 * THE PLAN'S CLOCK, SHARED BY EVERY JOB.
 *
 * An effort's capMs used to be each job's own allowance. A plan is one job per
 * (steel group x seed) — 48 of them at Standard on a real order — so on a host
 * with one or two cores they queued and the plan ran for (jobs / workers) x
 * capMs: over half an hour, long after the browser had given up.
 *
 * Now the whole plan has one deadline and every job is handed it:
 *
 *   PRIMARIES FIRST. Round 0 is one job per group, dispatched before any extra
 *   seed. Each gets (time left) x workers / (primaries not yet started), capped
 *   at the time left — so with enough workers a group's first seed has the
 *   whole budget, and with one worker six groups split it and any time an early
 *   one does not use flows to the later ones.
 *
 *   EXTRA SEEDS ONLY WITH TIME TO USE. A later round gets (time left) x workers
 *   / (jobs not yet started), and is SKIPPED — not run — when that share could
 *   not buy more than its floor (the first trial, which is the same layout for
 *   every seed and so cannot beat the primary), when its group's primary has
 *   already proved it hit the lower bound, or when the deadline has passed.
 *   Fewer seeds that each get a real search beat eight that each get a floor
 *   and a truncated restart: the packer's own measurements show a truncated
 *   search throwing away most of what restarts buy.
 *
 * With `deadlineAt` null this is the old behaviour exactly: every job, with
 * whatever budget its input carried.
 */
const MIN_EXTRA_SEED_MS = 500;

/**
 * Run every job, in parallel, and hand back the results IN THE ORDER GIVEN —
 * not the order they finished. Order is what keeps the answer reproducible.
 *
 * A job is `{ input, key?, round? }`: `key` names its steel group and `round`
 * is its seed's position (0 = the group's primary). A skipped job comes back
 * as `{ ok: false, skipped: 'time' | 'proven' }` so pickBest ignores it.
 *
 * Falls back to running them one after another in this thread if workers cannot
 * be started at all (a restricted host, an older runtime). Slower, same answer,
 * same deadline.
 */
export async function runAll(jobs, { onFallback = null, workers: workerCap = null, deadlineAt = null, onJob = null } = {}) {
  if (!jobs.length) return [];
  const results = new Array(jobs.length);
  const size = poolSize(jobs.length, workerCap);

  /*
   * LONGEST JOB FIRST, within a round.
   *
   * The jobs are wildly unequal — on a real order one steel group is forty
   * plates and another is three — and a pool is only as fast as its last
   * finisher. Handing them out in the order they were built lets a big job
   * start when the pool is nearly drained, and it becomes the tail everyone
   * waits on. Starting the big ones first is the classic fix and costs a sort.
   * Every group's primary goes before any group's extra seed.
   *
   * Dispatch ORDER changes; results still land in the caller's order, because
   * they are written by index. The answer cannot depend on scheduling (except
   * through the clock, which `deterministic: false` reports).
   */
  const roundOf = (j) => Math.max(0, Math.trunc(Number(j.round) || 0));
  // Under a deadline the order is CHEAPEST FIRST instead: each job's share is
  // worked out when it starts, so a cheap group that finishes well inside its
  // share hands the rest to the expensive ones behind it. Longest-first would
  // give the one group that needs the time an equal slice and then leave the
  // slack to groups that cannot use it. (With enough workers every primary
  // starts at once and the order does not matter to them.)
  const cheapFirst = deadlineAt != null;
  const order = jobs.map((j, i) => i).sort((x, y) => (roundOf(jobs[x]) - roundOf(jobs[y]))
    || (cheapFirst ? costOf(jobs[x]) - costOf(jobs[y]) : weightOf(jobs[y]) - weightOf(jobs[x]))
    || (x - y));

  const primary = new Map();          // group key -> { floorMs, proven } once its round 0 is back
  const started = new Array(jobs.length).fill(false);
  const stats = { workers: size, jobs: jobs.length, run: 0, skippedTime: 0, skippedProven: 0, capped: 0 };

  const note = (i, out) => {
    if (roundOf(jobs[i]) === 0 && out) primary.set(jobs[i].key, { floorMs: Number(out.floorMs) || 0, proven: !!out.proven });
    if (out && out.deterministic === false) stats.capped += 1;
  };
  /*
   * PROGRESS (2026-10-03): `onJob` hears about every job as it settles — run,
   * skipped or failed — with how many have settled so far. It is for the
   * background run's progress bar and log only; a throw in it is swallowed so
   * a progress listener can never break a pack.
   */
  let settled = 0;
  const told = (i) => {
    settled += 1;
    if (!onJob) return;
    try { onJob({ index: i, job: jobs[i], result: results[i], done: settled, total: jobs.length }); } catch { /* progress only */ }
  };

  /** The input to send for job i, or a skip verdict. Called at dispatch time. */
  const prepare = (i) => {
    started[i] = true;
    const j = jobs[i];
    if (deadlineAt == null) { stats.run += 1; return { input: j.input }; }
    const now = Date.now();
    const left = Math.max(0, deadlineAt - now);
    const unstarted = (pred) => {
      let n = 1;                                   // this job
      for (let k = 0; k < jobs.length; k += 1) if (!started[k] && pred(jobs[k])) n += 1;
      return n;
    };
    let share;
    if (roundOf(j) === 0) {
      share = Math.min(left, (left * size) / Math.max(size, unstarted((x) => roundOf(x) === 0)));
    } else {
      const p = primary.get(j.key);
      if (p?.proven) { stats.skippedProven += 1; return { skip: 'proven' }; }
      share = Math.min(left, (left * size) / Math.max(size, unstarted((x) => !primary.get(x.key)?.proven)));
      const floor = p ? p.floorMs : 0;
      if (left <= 0 || share < MIN_EXTRA_SEED_MS || (p && share < 2 * floor)) { stats.skippedTime += 1; return { skip: 'time' }; }
    }
    stats.run += 1;
    return { input: { ...j.input, budgetMs: Math.floor(share), deadlineAt } };
  };

  let workers;
  try {
    workers = Array.from({ length: size }, () => new Worker(WORKER));
  } catch (err) {
    if (onFallback) onFallback(err);
    const { nest } = await import('../services/nestingPacker.js');
    stats.workers = 1;
    for (const i of order) {
      const p = prepare(i);
      if (p.skip) { results[i] = { ok: false, skipped: p.skip }; told(i); continue; }
      const out = nest(p.input);
      results[i] = { ok: true, out };
      note(i, out);
      told(i);
    }
    results.stats = stats;
    return results;
  }

  try {
    let next = 0;
    await Promise.all(workers.map((w) => new Promise((resolve, reject) => {
      const take = () => {
        while (next < jobs.length) {
          const i = order[next]; next += 1;
          const p = prepare(i);
          if (p.skip) { results[i] = { ok: false, skipped: p.skip }; told(i); continue; }
          w.postMessage({ id: i, input: p.input });
          return;
        }
        resolve();
      };
      w.on('message', (msg) => {
        if (msg?.ready) { take(); return; }         // the module loaded; start work
        results[msg.id] = msg.ok ? { ok: true, out: msg.out } : { ok: false, error: msg.error };
        if (msg.ok) note(msg.id, msg.out);
        told(msg.id);
        take();
      });
      w.on('error', reject);
      w.on('exit', (code) => { if (code !== 0 && next < jobs.length) reject(new Error(`packer worker exited ${code}`)); });
    })));
    results.stats = stats;
    return results;
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }
}

/**
 * The best of several packs of the SAME input.
 *
 * Better means less steel bought. `areaBought` is the packer's own score and is
 * the money — utilisation is a per-plate ratio that improves by using more
 * plates, so it is never the thing to compare. Fewer pieces left unplaced beats
 * cheaper steel, because an answer that does not make the job is not an answer.
 */
export function pickBest(runs) {
  let best = null;
  for (const r of runs) {
    if (!r?.ok || !r.out) continue;
    const out = r.out;
    const stranded = (out.unplaced ?? []).reduce((a, u) => a + (Number(u.qty) || 0), 0);
    const cand = { out, seed: r.seed, stranded, area: Number(out.areaBought) || 0 };
    if (!best) { best = cand; continue; }
    if (cand.stranded !== best.stranded) { if (cand.stranded < best.stranded) best = cand; continue; }
    if (cand.area + 1e-6 < best.area) { best = cand; continue; }
    // Equal on both: the lowest seed wins, so the answer never depends on
    // which worker finished first.
    if (Math.abs(cand.area - best.area) <= 1e-6 && cand.seed < best.seed) best = cand;
  }
  return best;
}
