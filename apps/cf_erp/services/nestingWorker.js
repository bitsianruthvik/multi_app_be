/**
 * nestingWorker.js — one packer run, on its own CPU.
 *
 * This file exists because the packer is PURE GEOMETRY. It imports no database,
 * knows nothing about a tenant or an order, and takes plain numbers and plain
 * objects — so it can be handed to a worker thread with nothing but a
 * structured clone, and there is no shared state to get wrong. That boundary
 * was worth keeping for testability; parallelism is what it pays a second time.
 *
 * Node's event loop does NOT make a synchronous pack parallel. `nestAsync`
 * yields so the server stays answerable, but eight yields on one thread still
 * take eight times as long. Real seeds in real parallel need real threads.
 */
import { parentPort, workerData } from 'worker_threads';
// A job is a rectangle job (nestingPacker, as ever) or a shape job (services/packJob.js, init.sql §55).
import { runPackJob } from './packJob.js';

if (!parentPort) throw new Error('nestingWorker must be started as a worker thread');

parentPort.on('message', (job) => {
  try {
    // STOP AND PROGRESS (2026-10-10). A pack is one long synchronous stretch: no message can reach
    // it. So the stop is a flag in SHARED memory the search reads as it goes (job.stop, set by the
    // pool for every job of a run at once), and progress is posted out as the layout gets better.
    const stop = job.stop ? new Int32Array(job.stop) : null;
    const out = runPackJob(job.input, {
      shouldStop: () => !!stop && Atomics.load(stop, 0) !== 0,
      onProgress: (progress) => parentPort.postMessage({ id: job.id, progress }),
      // The best layout so far, for the run's checkpoint: when a plate is saved, else once a minute.
      onCheckpoint: (checkpoint) => parentPort.postMessage({ id: job.id, checkpoint }),
    });
    parentPort.postMessage({ id: job.id, ok: true, out });
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false, error: err?.message ?? String(err) });
  }
});

// Say hello so the pool knows the module loaded rather than waiting on a job.
parentPort.postMessage({ ready: true, pid: workerData?.pid ?? null });
