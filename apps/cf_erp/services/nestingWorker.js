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
import { nest } from './nestingPacker.js';

if (!parentPort) throw new Error('nestingWorker must be started as a worker thread');

parentPort.on('message', (job) => {
  try {
    const out = nest(job.input);
    parentPort.postMessage({ id: job.id, ok: true, out });
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false, error: err?.message ?? String(err) });
  }
});

// Say hello so the pool knows the module loaded rather than waiting on a job.
parentPort.postMessage({ ready: true, pid: workerData?.pid ?? null });
