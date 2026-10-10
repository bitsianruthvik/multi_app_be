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
const weightOf = (j) => (j.input?.pieces ?? j.input?.rect?.pieces ?? []).reduce((a, p) => a + (Number(p.length) || 0) * (Number(p.width) || 0) * (Number(p.qty) || 1), 0);

/**
 * Roughly how long one TRIAL of a job costs, for ordering under a deadline.
 * Area is a poor proxy for that — on the KEPL line the largest group by area
 * (28 mm, forty identical webs) builds its floor in 11 ms and the 16 mm group
 * (nine distinct rows, 1,320 pieces) in 2 s. A trial places every piece and
 * weighs it against the distinct rows, so pieces x rows tracks it.
 */
const costOf = (j) => {
  const ps = j.input?.pieces ?? j.input?.rect?.pieces ?? [];
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
 * HOW MANY WORKERS THE HOST'S MEMORY CAN CARRY (2026-10-10).
 *
 * Every worker is its own V8 heap. Measured on a job the size of the KEPL bridge order
 * (scripts/cf_kepl/nest_v2_scale_bench.mjs): the server alone ~100 MB, each worker packing true
 * shapes up to ~320 MB at its worst (its heap is capped, below). The core count says nothing about that — a small
 * container reports its HOST's cores (Render's free plan: 512 MB and a tenth of a CPU, on a machine
 * with many) — so the pool also asks how much memory the process may use
 * (`process.constrainedMemory()`: the container's limit, where there is one) and never starts more
 * workers than fit in 60 % of it. On a developer's machine this changes nothing.
 */
/** What this process may use, bytes: CF_NEST_MEMORY_MB (to rehearse a small instance), else the container's limit, else the machine's memory. */
export const memoryLimitBytes = () => {
  const forced = Number(process.env.CF_NEST_MEMORY_MB);
  if (Number.isFinite(forced) && forced > 0) return forced * 1048576;
  let limit = 0;
  try { limit = typeof process.constrainedMemory === 'function' ? Number(process.constrainedMemory()) || 0 : 0; } catch { limit = 0; }
  const total = os.totalmem();
  return limit > 0 && limit < total ? limit : total;
};
/** A worker's footprint for the count below: its heap cap + 32 young + the thread's own. */
const workerMb = () => heapCapMb() + 64;
/**
 * EACH WORKER'S HEAP IS CAPPED. Left alone, V8 sizes a worker's heap from the MACHINE's memory and
 * collects lazily: the same 6,000-piece job that needs under 96 MB live (it completes with a 96 MB
 * old space) was seen holding 380 MB a worker — 2.7 GB with seven — almost all of it garbage. With
 * a cap the collector keeps up, and the pool's footprint is workers × this, not whatever the host
 * allows. A job that really does not fit is not lost: its worker dies with an out-of-memory error
 * and the job is run again in a fresh worker with twice the room, then with no cap (see runAll).
 * CF_NEST_WORKER_HEAP_MB overrides it (0 = no cap).
 */
const WORKER_HEAP_MB = 256;
/**
 * The cap follows the instance: 30 % of what the process may use, between 96 MB (a bridge-size
 * steel completes in that) and WORKER_HEAP_MB. On a 512 MB instance: 153 MB, one worker — the
 * server (~150 MB with a plan in hand) + the worker (cap + ~64) stays under 400 MB.
 */
function heapCapMb() {
  const v = Number(process.env.CF_NEST_WORKER_HEAP_MB);
  if (Number.isFinite(v) && v >= 0 && process.env.CF_NEST_WORKER_HEAP_MB !== '' && process.env.CF_NEST_WORKER_HEAP_MB != null) return v;
  return Math.round(Math.min(WORKER_HEAP_MB, Math.max(96, (memoryLimitBytes() / 1048576) * 0.3)));
}
/** A worker with `mb` of old space (0 / Infinity = whatever V8 gives). */
const startWorker = (mb) => new Worker(WORKER, mb > 0 && Number.isFinite(mb) ? { resourceLimits: { maxOldGenerationSizeMb: mb, maxYoungGenerationSizeMb: 32 } } : {});
const memoryWorkers = () => Math.max(1, Math.floor((memoryLimitBytes() * 0.6) / (workerMb() * 1048576)));

/**
 * Leave a core for the server itself; never more workers than there is work.
 * `cap` (or CF_NEST_WORKERS) can only LOWER it — the request body reaches this,
 * and a caller must not be able to ask for a thousand threads.
 */
export const poolSize = (jobs, cap = null) => {
  const envCap = Number(process.env.CF_NEST_WORKERS);
  let n = Math.max(1, Math.min(hostThreads() - 1, memoryWorkers()));
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
export async function runAll(jobs, { onFallback = null, workers: workerCap = null, deadlineAt = null, onJob = null, stop = null, onProgress = null, onCheckpoint = null } = {}) {
  if (!jobs.length) return [];
  /*
   * STOP AND PROGRESS (2026-10-10 — runs of 5, 10 and 20 minutes).
   *   stop        an Int32Array over a SharedArrayBuffer, one for the whole plan. Whoever holds it
   *               stores 1 and EVERY job in flight finishes with the best layout it has, within a
   *               rebuild (the search reads the flag as it goes — services/nestingWorker.js). A
   *               group's FIRST seed not yet started still runs, with no time at all, because a
   *               plan needs a layout for every steel; later seeds are skipped ('stopped').
   *   onProgress  hears { index, job, progress } whenever a job's layout gets better
   *               (progress = { plates, areaBought, unplaced, … }, packJob's words).
   * Neither can change an answer except by ending the search early, which `deterministic: false`
   * and `stopped: true` on the job's result say.
   */
  const stopped = () => !!stop && Atomics.load(stop, 0) !== 0;
  const progressed = (i, progress) => { if (onProgress) { try { onProgress({ index: i, job: jobs[i], progress }); } catch { /* progress only */ } } };
  //   onCheckpoint  hears { index, job, checkpoint }: a job's best layout so far, in the form it can
  //                 be started from again (packJob) — when a plate is saved, else once a minute.
  const checkpointed = (i, checkpoint) => { if (onCheckpoint) { try { onCheckpoint({ index: i, job: jobs[i], checkpoint }); } catch { /* a listener never breaks a pack */ } } };
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
  const stats = { workers: size, jobs: jobs.length, run: 0, skippedTime: 0, skippedProven: 0, skippedStopped: 0, capped: 0, stopped: false };

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
    if (stopped()) {
      stats.stopped = true;
      // A first seed still has to give its steel a layout: the floor, and nothing more.
      if (roundOf(j) !== 0) { stats.skippedStopped += 1; return { skip: 'stopped' }; }
      stats.run += 1;
      return { input: { ...j.input, budgetMs: 0, deadlineAt: Date.now() } };
    }
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
      /*
       * WAVES (2026-10-10). With more first seeds than workers somebody has to go second on a
       * worker, and the old rule — everyone gets (time left × workers / first seeds) — let the first
       * seven of eight run seven eighths of the budget each and left the eighth, the COSTLIEST
       * (cheapest go first), one eighth. Now a first seed gets time left ÷ the number of waves
       * still to fit in: with eight steels on seven workers the cheapest gets half and hands its
       * worker to the costliest for the other half, and the six in between get all of it. With
       * one worker it is the equal split it always was, slack flowing to the later ones.
       */
      share = left / Math.max(1, Math.ceil(unstarted((x) => roundOf(x) === 0) / size));
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
  const cap = heapCapMb();
  try {
    workers = Array.from({ length: size }, () => startWorker(cap));
  } catch (err) {
    if (onFallback) onFallback(err);
    // The same job runner the workers use: a rectangle job, or a shape job (services/packJob.js).
    const { runPackJob: nest } = await import('../services/packJob.js');
    stats.workers = 1;
    for (const i of order) {
      const p = prepare(i);
      if (p.skip) { results[i] = { ok: false, skipped: p.skip }; told(i); continue; }
      const out = nest(p.input, { shouldStop: stopped, onProgress: (progress) => progressed(i, progress), onCheckpoint: (checkpoint) => checkpointed(i, checkpoint) });
      results[i] = { ok: true, out };
      note(i, out);
      told(i);
    }
    results.stats = stats;
    return results;
  }

  try {
    let next = 0;
    stats.heapRetries = 0;
    await Promise.all(workers.map((first, slot) => new Promise((resolve, reject) => {
      /*
       * ONE SLOT, ONE WORKER AT A TIME — and a worker that runs out of heap is REPLACED, not fatal.
       * `doing` is the job in flight: if its worker dies of ERR_WORKER_OUT_OF_MEMORY the same job
       * (the same absolute deadline) goes to a fresh worker OF THE SAME SIZE, marked `coarse: 1` and
       * then `coarse: 2` (services/packJob.js: fewer convex pieces and a smaller cache, then the row
       * layout alone). It used to be given twice the room and then no cap at all — on a 512 MB
       * instance that is how the whole server dies. Any other death fails the plan, as before.
       */
      let w = first;
      let doing = null;                               // { i, input, tries }
      let room = cap;
      const take = () => {
        while (next < jobs.length) {
          const i = order[next]; next += 1;
          const p = prepare(i);
          if (p.skip) { results[i] = { ok: false, skipped: p.skip }; told(i); continue; }
          doing = { i, input: p.input, tries: 0 };
          w.postMessage({ id: i, input: p.input, stop: stop?.buffer ?? null });
          return;
        }
        doing = null;
        resolve();
      };
      const wire = (worker) => {
        worker.on('message', (msg) => {
          if (worker !== w) return;
          if (msg?.ready) {
            if (doing) worker.postMessage({ id: doing.i, input: doing.input, stop: stop?.buffer ?? null });   // a replacement: the job that killed the last one
            else take();                                                           // the module loaded; start work
            return;
          }
          if (msg.progress) { progressed(msg.id, msg.progress); return; }
          if (msg.checkpoint) { checkpointed(msg.id, msg.checkpoint); return; }
          results[msg.id] = msg.ok ? { ok: true, out: msg.out } : { ok: false, error: msg.error };
          if (msg.ok) note(msg.id, msg.out);
          told(msg.id);
          take();
        });
        worker.on('error', (err) => {
          if (worker !== w) return;
          const oom = err?.code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory/i.test(err?.message ?? '');
          if (!oom || !doing || doing.tries >= 2 || !(room > 0)) { reject(err); return; }
          doing.tries += 1;
          stats.heapRetries += 1;
          doing.input = { ...doing.input, coarse: doing.tries };
          try { w = startWorker(room); workers[slot] = w; wire(w); } catch (e) { reject(e); }
        });
        worker.on('exit', (code) => { if (worker === w && code !== 0 && doing && doing.tries >= 2) reject(new Error(`packer worker exited ${code}`)); });
      };
      wire(w);
    })));
    if (stopped()) stats.stopped = true;
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
