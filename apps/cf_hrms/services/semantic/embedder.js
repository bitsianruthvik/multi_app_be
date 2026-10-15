/**
 * embedder.js — the built-in sentence-embedding model behind "search by meaning".
 *
 * WHY BUILT IN. The company's job content must not leave the system, so there is
 * no outside AI service and no API key: the model runs inside this Node process
 * (transformers.js on onnxruntime). The only network call it ever makes is the
 * one-time download of the model files from the Hugging Face hub into
 * `CF_HRMS_MODEL_CACHE` (default `multi_app_be/tmp/hf-models`, git-ignored). On
 * Render the disk is ephemeral, so the first search after a deploy downloads it
 * again (~23 MB) — accepted.
 *
 * THE MODEL. `Xenova/all-MiniLM-L6-v2`, int8-quantized: 384 dimensions, ~23 MB on
 * disk, the smallest well-known English sentence model that is good at short
 * duty-style sentences. Changing it changes `MODEL_ID`, and every stored vector
 * is keyed by model, so the index simply rebuilds — nothing is mixed.
 *
 * MEMORY. Production is a 512 MB box. So the model is NEVER loaded at server
 * start: it loads on the first search that needs it, and unloads after
 * `CF_HRMS_MODEL_IDLE_MS` (default 10 minutes) without use. If it cannot load —
 * no network for the first download, out of memory, a broken native binary — the
 * caller gets `ModelUnavailable` and falls back to keyword search. After a failed
 * load we do not retry for a minute, so a broken model does not cost every
 * request a fresh attempt.
 *
 * MEMORY GUARD (2026-10-15). An out-of-memory kill takes the whole server down and
 * the keyword fallback never gets to run, so before LOADING the model we check
 * the headroom: the model needs about MODEL_NEED_MB (measured: +82 MB loaded,
 * +94 after a batch of 64; 140 leaves margin). The limit is
 *   CF_HRMS_MEMORY_LIMIT_MB when set (an explicit override — to rehearse a small
 *   instance, or to pin it), else process.constrainedMemory() (the container's
 *   limit, Render's 512 MB) when it reports one below the machine's memory,
 *   else 512.
 * Loading is refused when rss + MODEL_NEED_MB would pass 80 % of the limit; the
 * search then answers by exact words with a plain notice and does not try again
 * for a minute. A model that is already loaded is used as it is.
 *
 * THE NESTING POOL (apps/cf_erp/lib/packerPool.js) runs worker THREADS in this
 * same process. It has no shared budget to reserve from: it sizes itself once
 * per run from the limit (60 % of it for workers, ~217 MB a worker on 512 MB)
 * and does not look at what else is loaded. What protects the two from each
 * other here: worker threads count in this process's rss, so while a nesting run
 * holds a worker the guard sees that memory and refuses to load. What is NOT
 * covered: the model already loaded (~+90 MB) when a nesting run then starts —
 * server ~150 + model ~90 + one worker ~217 is ~460 MB of 512. That is the
 * remaining risk; the 10-minute idle unload keeps the window short, and
 * CF_HRMS_MODEL_IDLE_MS can shorten it further.
 *
 * `embed(texts)` returns one normalised Float32Array per text (so cosine is a dot
 * product), computed in batches so one call with 1,000 texts does not build one
 * 1,000-row tensor.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_DIMS = 384;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE = path.resolve(HERE, '../../../../tmp/hf-models');
const IDLE_MS = Number(process.env.CF_HRMS_MODEL_IDLE_MS) || 10 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 1000;
const BATCH = 32;
export const MODEL_NEED_MB = 140;
const MEMORY_SHARE = 0.8;
const MB = 1048576;

/** The memory this process may use, MB, and where that figure came from. */
export function memoryLimitMb() {
  const forced = Number(process.env.CF_HRMS_MEMORY_LIMIT_MB);
  if (Number.isFinite(forced) && forced > 0) return { mb: forced, source: 'CF_HRMS_MEMORY_LIMIT_MB' };
  let limit = 0;
  try { limit = typeof process.constrainedMemory === 'function' ? Number(process.constrainedMemory()) || 0 : 0; } catch { limit = 0; }
  if (limit > 0 && limit < os.totalmem()) return { mb: Math.round(limit / MB), source: 'container' };
  return { mb: 512, source: 'assumed' };
}

/** Is there room to load the model now? */
export function memoryHeadroom() {
  const { mb: limitMb, source } = memoryLimitMb();
  const rssMb = Math.round(process.memoryUsage().rss / MB);
  const ceilingMb = Math.round(limitMb * MEMORY_SHARE);
  return { ok: rssMb + MODEL_NEED_MB <= ceilingMb, rssMb, needMb: MODEL_NEED_MB, ceilingMb, limitMb, source };
}

export class ModelUnavailable extends Error {
  constructor(message, cause, reason = 'load') {
    super(message);
    this.name = 'ModelUnavailable';
    this.cause = cause;
    this.reason = reason;   // 'load' | 'memory'
  }
}

let extractor = null;        // the loaded pipeline
let loading = null;          // the in-flight load, shared by concurrent callers
let idleTimer = null;
let lastFailure = null;      // { at, message, reason }
let forcedUnavailable = null; // tests: simulate a model that cannot load
let lastLoadMs = null;

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { unload().catch(() => {}); }, IDLE_MS);
  // Never keep a script or the server alive just to unload a model.
  idleTimer.unref?.();
}

async function load() {
  if (forcedUnavailable) throw new ModelUnavailable(forcedUnavailable);
  if (extractor) return extractor;
  if (lastFailure && Date.now() - lastFailure.at < RETRY_AFTER_MS) {
    throw new ModelUnavailable(lastFailure.message, null, lastFailure.reason);
  }
  if (!loading) {
    const room = memoryHeadroom();
    if (!room.ok) {
      lastFailure = {
        at: Date.now(),
        reason: 'memory',
        message: `not enough memory to load the search model (using ${room.rssMb} MB, the model needs about ${room.needMb} MB, the limit for it is ${room.ceilingMb} MB)`,
      };
      throw new ModelUnavailable(lastFailure.message, null, 'memory');
    }
    loading = (async () => {
      const started = Date.now();
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = process.env.CF_HRMS_MODEL_CACHE || DEFAULT_CACHE;
        env.allowLocalModels = false;   // only the hub id above; never a path from input
        // One thread and no memory arena: production has 0.1 CPU and 512 MB, and the
        // arena kept ~40 MB more after a batch for no speed it could use.
        const pipe = await pipeline('feature-extraction', MODEL_ID, {
          dtype: 'q8',
          device: 'cpu',
          session_options: { enableCpuMemArena: false, intraOpNumThreads: 1 },
        });
        extractor = pipe;
        lastFailure = null;
        lastLoadMs = Date.now() - started;
        return pipe;
      } catch (err) {
        lastFailure = { at: Date.now(), message: err?.message || String(err), reason: 'load' };
        throw new ModelUnavailable(`The search model could not load: ${lastFailure.message}`, err);
      } finally {
        loading = null;
      }
    })();
  }
  return loading;
}

/** Normalised embeddings, one Float32Array (length MODEL_DIMS) per text, in input order. */
export async function embed(texts) {
  const list = (texts ?? []).map((t) => String(t ?? ''));
  if (!list.length) return [];
  const pipe = await load();
  touch();
  const out = [];
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    let tensor;
    try {
      tensor = await pipe(chunk, { pooling: 'mean', normalize: true });
    } catch (err) {
      throw new ModelUnavailable(`The search model failed: ${err?.message || err}`, err);
    }
    const data = tensor.data;
    const dims = tensor.dims[tensor.dims.length - 1];
    for (let r = 0; r < chunk.length; r += 1) out.push(Float32Array.from(data.subarray(r * dims, (r + 1) * dims)));
    tensor.dispose?.();
    touch();
  }
  return out;
}

/** Frees the model. Called by the idle timer; exported for scripts and tests. */
export async function unload() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const pipe = extractor;
  extractor = null;
  if (pipe?.dispose) await pipe.dispose();
}

export function modelStatus() {
  return {
    model: MODEL_ID,
    loaded: Boolean(extractor),
    lastLoadMs,
    lastFailure: lastFailure?.message ?? null,
    headroom: memoryHeadroom(),
  };
}

/** Tests only: forget a failed load, so the next search tries again at once. */
export function __clearFailure() { lastFailure = null; }

/** Tests only: make the next loads fail (a string reason) or work again (null). */
export function __simulateUnavailable(reason) {
  forcedUnavailable = reason || null;
  if (reason) { extractor = null; }
  lastFailure = null;
}

/** Float32 little-endian <-> Buffer, the BLOB format of hrms_search_vectors.vector. */
export function toBlob(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i += 1) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

export function fromBlob(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const out = new Float32Array(b.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = b.readFloatLE(i * 4);
  return out;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

export default { embed, unload, modelStatus, MODEL_ID, MODEL_DIMS, toBlob, fromBlob, dot };
