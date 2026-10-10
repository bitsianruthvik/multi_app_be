/**
 * keepAwake.js — CF_ERP. Keep the server from going to sleep WHILE A NESTING RUN IS WORKING
 * (user, 2026-10-10: "Instead of opening the nesting screen again continuing, can we actually run
 * something dummy to ensure it is on till the run is done?").
 *
 * Production is one small instance that is put to sleep after ~15 minutes with no INBOUND
 * request. A nesting run may take an hour and nobody need be looking at it. So while at least one
 * run is live on this instance, the server GETs its own PUBLIC health URL every few minutes: a
 * request that comes in through the front door counts as traffic (one to localhost does not).
 *
 *   base URL    KEEP_AWAKE_URL, else RENDER_EXTERNAL_URL (the platform sets it). Neither set
 *               (a developer's machine): this whole file does nothing.
 *   what        GET <base>/health — no auth, no body, a 10 s timeout.
 *   when        once when the first run goes live, then every KEEP_AWAKE_MS (4 minutes) until the
 *               last one ends, fails or is cancelled. ONE timer for the process, not one per run.
 *   failures    counted and remembered (`lastError`), never thrown: a ping that fails changes
 *               nothing about the run.
 *   shutdown    the timer is unref()'d — it never keeps the process alive.
 *
 * `keepAwakeState()` is what a run's progress shows, so that it can be SEEN to work in production.
 */
export const KEEP_AWAKE_MS = 4 * 60_000;
const PING_TIMEOUT_MS = 10_000;

const live = new Set();                 // ids of the runs holding the server awake
let timer = null;
const stats = { pings: 0, failures: 0, lastPingAt: null, lastOkAt: null, lastStatus: null, lastError: null };
// Replaceable in a test: the clock and the network.
let deps = { fetch: (...a) => globalThis.fetch(...a), setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t), now: () => Date.now() };

/** The URL pinged, or null when there is none to ping (then nothing here does anything). */
export function keepAwakeUrl() {
  const base = String(process.env.KEEP_AWAKE_URL ?? '').trim() || String(process.env.RENDER_EXTERNAL_URL ?? '').trim();
  if (!base || !/^https?:\/\//i.test(base)) return null;
  const clean = base.replace(/\/+$/, '');
  return /\/health$/i.test(clean) ? clean : `${clean}/health`;
}

const intervalMs = () => { const v = Number(process.env.KEEP_AWAKE_MS); return Number.isFinite(v) && v >= 1000 ? v : KEEP_AWAKE_MS; };

/** One ping. Never throws. */
export async function pingNow() {
  const url = keepAwakeUrl();
  if (!url) return false;
  stats.pings += 1;
  stats.lastPingAt = new Date(deps.now()).toISOString();
  try {
    const res = await deps.fetch(url, { method: 'GET', signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(PING_TIMEOUT_MS) : undefined, headers: { 'user-agent': 'cf-erp-keep-awake' } });
    stats.lastStatus = res?.status ?? null;
    if (res && res.status >= 200 && res.status < 500) { stats.lastOkAt = stats.lastPingAt; stats.lastError = null; return true; }
    stats.failures += 1; stats.lastError = `HTTP ${res?.status ?? '?'}`;
  } catch (e) {
    stats.failures += 1; stats.lastStatus = null; stats.lastError = String(e?.message ?? e).slice(0, 200);
  }
  return false;
}

/** A run went live: hold the server awake for it. Starts the timer with the first one. */
export function holdAwake(id) {
  if (id == null) return;
  live.add(String(id));
  if (timer || !keepAwakeUrl()) return;
  timer = deps.setInterval(() => { pingNow().catch(() => {}); }, intervalMs());
  if (typeof timer?.unref === 'function') timer.unref();
  pingNow().catch(() => {});
}

/** A run ended (done, failed, cancelled, lost): let go. Stops the timer with the last one. */
export function releaseAwake(id) {
  if (id != null) live.delete(String(id));
  if (live.size || !timer) return;
  deps.clearInterval(timer);
  timer = null;
}

/** For a run's progress: is the server being kept awake, and is it working? */
export function keepAwakeState() {
  return { on: !!timer, configured: !!keepAwakeUrl(), runs: live.size, everyMs: intervalMs(), pings: stats.pings, failures: stats.failures, lastPingAt: stats.lastPingAt, lastOkAt: stats.lastOkAt, lastStatus: stats.lastStatus, lastError: stats.lastError };
}

/** Tests only: stand-ins for fetch / the timer / the clock, and a clean slate. */
export function _keepAwakeTest(next = null) {
  if (timer) { deps.clearInterval(timer); timer = null; }
  live.clear();
  Object.assign(stats, { pings: 0, failures: 0, lastPingAt: null, lastOkAt: null, lastStatus: null, lastError: null });
  deps = next ? { ...deps, ...next } : { fetch: (...a) => globalThis.fetch(...a), setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t), now: () => Date.now() };
}
