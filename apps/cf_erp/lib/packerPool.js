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

/** Leave a core for the server itself; never more workers than there is work. */
export const poolSize = (jobs) => Math.max(1, Math.min(jobs, (os.cpus()?.length ?? 2) - 1));

/**
 * Run every job, in parallel, and hand back the results IN THE ORDER GIVEN —
 * not the order they finished. Order is what keeps the answer reproducible.
 *
 * Falls back to running them one after another in this thread if workers cannot
 * be started at all (a restricted host, an older runtime). Slower, same answer.
 */
export async function runAll(jobs, { onFallback = null } = {}) {
  if (!jobs.length) return [];
  const results = new Array(jobs.length);

  let workers;
  try {
    workers = Array.from({ length: poolSize(jobs.length) }, () => new Worker(WORKER));
  } catch (err) {
    if (onFallback) onFallback(err);
    const { nest } = await import('../services/nestingPacker.js');
    return jobs.map((j) => ({ ok: true, out: nest(j.input) }));
  }

  try {
    /*
     * LONGEST JOB FIRST.
     *
     * The jobs are wildly unequal — on a real order one steel group is forty
     * plates and another is three — and a pool is only as fast as its last
     * finisher. Handing them out in the order they were built lets a big job
     * start when the pool is nearly drained, and it becomes the tail everyone
     * waits on. Starting the big ones first is the classic fix and costs a sort.
     *
     * Dispatch ORDER changes; results still land in the caller's order, because
     * they are written by index. The answer cannot depend on scheduling.
     */
    const order = jobs.map((j, i) => i).sort((x, y) => (weightOf(jobs[y]) - weightOf(jobs[x])) || (x - y));
    let next = 0;
    await Promise.all(workers.map((w) => new Promise((resolve, reject) => {
      const take = () => {
        if (next >= jobs.length) { resolve(); return; }
        const i = order[next]; next += 1;
        w.postMessage({ id: i, input: jobs[i].input });
      };
      w.on('message', (msg) => {
        if (msg?.ready) { take(); return; }         // the module loaded; start work
        results[msg.id] = msg.ok ? { ok: true, out: msg.out } : { ok: false, error: msg.error };
        take();
      });
      w.on('error', reject);
      w.on('exit', (code) => { if (code !== 0 && next < jobs.length) reject(new Error(`packer worker exited ${code}`)); });
    })));
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
