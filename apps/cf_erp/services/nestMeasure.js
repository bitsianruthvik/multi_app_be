/**
 * nestMeasure.js — CF_ERP. The exact polygon work on plates ALREADY LAID OUT, kept off the server's
 * own thread (2026-10-10 hardening).
 *
 * Two questions are asked of a plate of true shapes, and both are exact geometry:
 *   verify   nestShapes.verifyPlate   — is it legal (overlap, kerf, the edge)?
 *   waste    nestShapes.shapedWaste   — what is it made of (parts, kerf, rim, offcuts, wastage)?
 * Measured on a job the size of the KEPL bridge order: 5–250 ms a plate, ~5 s for the line's 113
 * plates. Node runs one thing at a time, so asked inline that is five seconds in which no other
 * request of any tenant is answered — the mistake nestAsync was written to end for the packer.
 *
 * So callers hand the whole batch here. A SMALL batch (a few plates of a few parts) is worked out
 * in this thread, one task at a time with the event loop let through between tasks. A larger one
 * goes to the packer's worker pool (lib/packerPool.runAll → nestingWorker → packJob `measure`),
 * split across the workers by weight. If no worker can be started, or one fails, the tasks are
 * worked out here instead — slower, same answers. The answers are the same wherever they are made:
 * it is the same pure function on the same arguments.
 *
 *   measurePlates([{ kind: 'verify' | 'waste', args }, …]) → [result, …]   (same order)
 */
import { runAll, poolSize } from '../lib/packerPool.js';
import { runMeasureTask } from './packJob.js';

/** Up to this many parts in the whole batch are measured where they stand (≈ 50 ms). */
export const MEASURE_INLINE_PARTS = 60;
/** Parts per worker job, at least: starting a worker costs more than measuring a small plate. */
const PARTS_PER_JOB = 300;

const breathe = () => new Promise((resolve) => { setImmediate(resolve); });
const weightOf = (t) => Math.max(1, (t.args?.pieces ?? t.args?.placements ?? []).length + (t.args?.fixed ?? []).length);

export async function measurePlates(tasks, { workers = null, inline = false } = {}) {
  const n = tasks.length;
  if (!n) return [];
  const out = new Array(n);
  const total = tasks.reduce((a, t) => a + weightOf(t), 0);
  const here = async (idx) => { for (const i of idx) { out[i] = runMeasureTask(tasks[i]); await breathe(); } };
  if (inline || total <= MEASURE_INLINE_PARTS) { await here(tasks.map((t, i) => i)); return out; }

  // Heaviest first into the lightest bucket: the buckets end up near equal.
  const buckets = Array.from({ length: Math.max(1, Math.min(poolSize(n, workers), Math.ceil(total / PARTS_PER_JOB))) }, () => ({ idx: [], w: 0 }));
  for (const i of tasks.map((t, k) => k).sort((a, b) => weightOf(tasks[b]) - weightOf(tasks[a]) || a - b)) {
    const b = buckets.reduce((m, x) => (x.w < m.w ? x : m));
    b.idx.push(i); b.w += weightOf(tasks[i]);
  }
  const jobs = buckets.filter((b) => b.idx.length).map((b) => ({ key: 'measure', round: 0, idx: b.idx, input: { packer: 'measure', tasks: b.idx.map((i) => tasks[i]) } }));
  let runs = null;
  try { runs = await runAll(jobs, { workers }); } catch { runs = null; }
  const missed = [];
  jobs.forEach((j, k) => {
    const res = runs?.[k]?.ok ? runs[k].out?.results : null;
    if (Array.isArray(res) && res.length === j.idx.length) j.idx.forEach((i, m) => { out[i] = res[m]; });
    else missed.push(...j.idx);
  });
  if (missed.length) await here(missed);
  return out;
}
