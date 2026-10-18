/**
 * processGuard.js — ONE REQUEST MUST NOT TAKE THE SERVER DOWN, and when the server does go down the log must
 * say why (2026-10-18).
 *
 * Production is one Render "free" instance: 512 MB, 0.15 CPU, one process. On 2026-10-18 07:36–07:39 UTC the
 * instance serving the SO260014 walkthrough disappeared with NOTHING in the log: no stack, no "Uncaught
 * exception", no OOM event, memory 150 of 512 MB and CPU 0.03 of 0.15 in the last samples, no deploy. The last
 * request it finished was 07:36:35; the next instance booted at 07:39:11. pino-http writes a line only when a
 * request FINISHES, so a request that was running when the process went could not be named, and a SIGTERM from
 * the platform left no trace either. This module closes those gaps and bounds what one request can do:
 *
 *   in flight     every request is registered on arrival (id, method, path, start) and removed when it ends,
 *                 so anything below can name what was running.
 *   slow          a request still running after GUARD_SLOW_MS (30 s) is logged once (again at 2 and 5 min).
 *   event loop    a stall of ≥ GUARD_STALL_MS (1 s) — synchronous work holding the only thread — is logged with
 *                 the requests in flight (the culprit is among them).
 *   memory        RSS sampled every 5 s; above 75 % of the limit it is logged (once a minute at most) with the
 *                 heap and the requests in flight; the peak is kept for /health.
 *   big bodies    a body over GUARD_BIG_BODY_MB (5 MB) is parsed by at most GUARD_BIG_BODIES (1) request at a
 *                 time, and not at all when memory is above 85 %: a 50 MB JSON body is several times that once
 *                 parsed, and two at once on 512 MB was the most direct way for one person to end the process.
 *                 The second gets a 503 in words and tries again.
 *   errors        unhandledRejection: logged, keeps serving (it belongs to one request or timer).
 *                 uncaughtException: logged FATAL with the requests in flight, keeps serving — unless
 *                 GUARD_FATAL_LIMIT (5) arrive within a minute, then the server drains and exits so the
 *                 platform starts a clean one.
 *   shutdown      SIGTERM / SIGINT (a deploy, the platform moving the instance, spin-down): logged with uptime,
 *                 memory and the requests in flight; the server stops taking new requests and waits up to
 *                 GUARD_DRAIN_MS (25 s; Render waits 30 s before SIGKILL) for the running ones — a save half
 *                 way through its transaction is allowed to finish instead of being cut off.
 *   timeouts      keep-alive 65 s (longer than the proxy's, so it never reuses a socket Node already closed —
 *                 a source of stray 502s), headers 66 s, and a request may run GUARD_REQUEST_TIMEOUT_MS (10 min;
 *                 Node's own default of 5 min would cut the screens' 5-minute long writes off at the socket).
 *
 * Everything is in-process and allocation-light; no request is slowed by more than a Map insert and delete.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { logger as defaultLogger } from "./logger.js";

const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const MB = 1048576;

export function guardSettings(env = process.env) {
  const limit = num(env.GUARD_MEMORY_LIMIT_MB, 0) * MB
    || (typeof process.constrainedMemory === "function" && process.constrainedMemory() > 0 && process.constrainedMemory() < 2 ** 50 ? process.constrainedMemory() : 0)
    || 512 * MB;
  return {
    slowMs: num(env.GUARD_SLOW_MS, 30_000),
    stallMs: num(env.GUARD_STALL_MS, 1_000),
    memoryLimit: limit,
    memoryWarn: num(env.GUARD_MEMORY_WARN, 0.75),
    memoryRefuse: num(env.GUARD_MEMORY_REFUSE, 0.85),
    bigBodyBytes: num(env.GUARD_BIG_BODY_MB, 5) * MB,
    bigBodies: Math.max(1, num(env.GUARD_BIG_BODIES, 1)),
    fatalLimit: num(env.GUARD_FATAL_LIMIT, 5),
    drainMs: num(env.GUARD_DRAIN_MS, 25_000),
    requestTimeoutMs: num(env.GUARD_REQUEST_TIMEOUT_MS, 10 * 60_000),
    sampleMs: num(env.GUARD_SAMPLE_MS, 5_000),
  };
}

/** Builds a guard. `exit` and `logger` are replaceable for a test; nothing starts until `start()`. */
export function createProcessGuard(opts = {}) {
  const cfg = { ...guardSettings(opts.env), ...(opts.settings ?? {}) };
  const log = opts.logger ?? defaultLogger;
  const exit = opts.exit ?? ((code) => process.exit(code));
  const memory = opts.memoryUsage ?? (() => process.memoryUsage());
  const inflight = new Map();
  const recent = []; // the last requests that ENDED, for a stall noticed just after its culprit finished
  let seq = 0;
  let bigActive = 0;
  let server = null;
  let draining = false;
  const fatals = [];
  const timers = [];
  const stats = { started: Date.now(), requests: 0, peakRssMb: 0, lastStall: null, stalls: 0, slow: 0, bigRefused: 0, fatal: 0, rejections: 0, lastMemoryWarnAt: 0 };

  const snapshot = (limit = 10) => {
    const now = Date.now();
    return [...inflight.values()].sort((a, b) => a.start - b.start).slice(0, limit)
      .map((r) => ({ id: r.id, method: r.method, path: r.path, ms: now - r.start, ...(r.bytes ? { bytes: r.bytes } : {}) }));
  };
  const rssRatio = () => memory().rss / cfg.memoryLimit;

  /** Express middleware: registers the request; mount it FIRST, before the body parsers. */
  function track(req, res, next) {
    if (draining) {
      res.setHeader("Connection", "close");
      return res.status(503).json({ code: "RESTARTING", message: "The server is restarting. Try again in a few seconds." });
    }
    seq += 1;
    stats.requests += 1;
    const bytes = Number(req.headers["content-length"]) || 0;
    const entry = { id: seq, method: req.method, path: String(req.originalUrl || req.url || "").split("?")[0].slice(0, 200), start: Date.now(), bytes, warned: 0, big: false };
    inflight.set(entry.id, entry);
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      inflight.delete(entry.id);
      recent.push({ id: entry.id, method: entry.method, path: entry.path, start: entry.start, end: Date.now() });
      if (recent.length > 50) recent.shift();
      if (entry.big) bigActive = Math.max(0, bigActive - 1);
    };
    res.once("finish", end);
    res.once("close", end);
    if (bytes >= cfg.bigBodyBytes) {
      const tooFull = rssRatio() >= cfg.memoryRefuse;
      if (bigActive >= cfg.bigBodies || tooFull) {
        stats.bigRefused += 1;
        log.warn({ path: entry.path, mb: +(bytes / MB).toFixed(1), bigActive, rssMb: Math.round(memory().rss / MB) }, "[guard] large request turned away for now");
        res.setHeader("Retry-After", "5");
        return res.status(503).json({ code: "BUSY_LARGE", message: tooFull
          ? "The server is short of memory just now, so it cannot take a request this large. Try again in a minute."
          : "The server is taking another large upload. Try again in a few seconds." });
      }
      entry.big = true;
      bigActive += 1;
    }
    return next();
  }

  function checkSlow() {
    const now = Date.now();
    for (const r of inflight.values()) {
      const ms = now - r.start;
      const marks = [cfg.slowMs, 120_000, 300_000];
      if (r.warned < marks.length && ms >= marks[r.warned]) {
        r.warned += 1;
        stats.slow += 1;
        log.warn({ id: r.id, method: r.method, path: r.path, ms, inflight: inflight.size }, "[guard] request still running");
      }
    }
  }

  function checkMemory() {
    const m = memory();
    const rssMb = Math.round(m.rss / MB);
    if (rssMb > stats.peakRssMb) stats.peakRssMb = rssMb;
    const now = Date.now();
    if (m.rss / cfg.memoryLimit >= cfg.memoryWarn && now - stats.lastMemoryWarnAt >= 60_000) {
      stats.lastMemoryWarnAt = now;
      log.warn({ rssMb, heapUsedMb: Math.round((m.heapUsed ?? 0) / MB), externalMb: Math.round((m.external ?? 0) / MB), limitMb: Math.round(cfg.memoryLimit / MB), inflight: snapshot() }, "[guard] memory high");
    }
  }

  let lastTick = Date.now();
  let histogram = null;
  function checkLoop() {
    const now = Date.now();
    const lag = now - lastTick - cfg.sampleStepMs;
    lastTick = now;
    if (lag >= cfg.stallMs) {
      stats.stalls += 1;
      stats.lastStall = { at: new Date(now).toISOString(), ms: lag };
      // The culprit is running now, or ended during the stall (its answer went out before this timer could run).
      const from = now - lag - cfg.sampleStepMs;
      const ended = recent.filter((r) => r.end >= from).map((r) => ({ id: r.id, method: r.method, path: r.path, ms: r.end - r.start, ended: true }));
      log.warn({ stallMs: lag, inflight: [...snapshot(), ...ended] }, "[guard] event loop was blocked");
    }
  }

  function onRejection(reason) {
    stats.rejections += 1;
    log.error({ err: reason, inflight: snapshot(5) }, "Unhandled rejection");
  }
  function onException(err) {
    stats.fatal += 1;
    const now = Date.now();
    fatals.push(now);
    while (fatals.length && now - fatals[0] > 60_000) fatals.shift();
    log.fatal({ err, inflight: snapshot(), rssMb: Math.round(memory().rss / MB) }, "Uncaught exception");
    if (cfg.fatalLimit > 0 && fatals.length >= cfg.fatalLimit) {
      log.fatal({ count: fatals.length }, "[guard] too many uncaught exceptions in a minute — draining and exiting for a clean start");
      shutdown("FATAL_LIMIT", 1);
    }
  }

  function shutdown(signal, code = 0) {
    if (draining) return;
    draining = true;
    const m = memory();
    log.warn({ signal, uptimeS: Math.round(process.uptime()), rssMb: Math.round(m.rss / MB), peakRssMb: stats.peakRssMb, inflight: snapshot(20) }, "[guard] shutting down");
    try { server?.close?.(); } catch { /* already closed */ }
    try { server?.closeIdleConnections?.(); } catch { /* older node */ }
    const t0 = Date.now();
    const wait = setInterval(() => {
      if (inflight.size === 0 || Date.now() - t0 >= cfg.drainMs) {
        clearInterval(wait);
        if (inflight.size) log.warn({ left: snapshot(20) }, "[guard] drain time over — exiting with requests still running");
        else log.info({ ms: Date.now() - t0 }, "[guard] drained");
        Promise.resolve(opts.beforeExit?.()).catch(() => {}).finally(() => exit(code));
      }
    }, 100);
    wait.unref?.();
  }
  const onTerm = () => shutdown("SIGTERM", 0);
  const onInt = () => shutdown("SIGINT", 0);

  function attachServer(s) {
    server = s;
    s.keepAliveTimeout = num(process.env.GUARD_KEEPALIVE_MS, 65_000);
    s.headersTimeout = s.keepAliveTimeout + 1_000;
    s.requestTimeout = cfg.requestTimeoutMs;
    return s;
  }

  function start({ processHandlers = true } = {}) {
    cfg.sampleStepMs = 250;
    lastTick = Date.now();
    timers.push(setInterval(checkLoop, cfg.sampleStepMs));
    timers.push(setInterval(checkMemory, cfg.sampleMs));
    timers.push(setInterval(checkSlow, Math.min(5_000, Math.max(250, Math.floor(cfg.slowMs / 2)))));
    for (const t of timers) t.unref?.();
    try { histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable(); } catch { histogram = null; }
    if (processHandlers) {
      process.on("unhandledRejection", onRejection);
      process.on("uncaughtException", onException);
      process.on("SIGTERM", onTerm);
      process.on("SIGINT", onInt);
    }
    log.info({ memoryLimitMb: Math.round(cfg.memoryLimit / MB), bigBodyMb: cfg.bigBodyBytes / MB, bigBodies: cfg.bigBodies, requestTimeoutMs: cfg.requestTimeoutMs }, "[guard] started");
  }

  function stop() {
    for (const t of timers.splice(0)) clearInterval(t);
    histogram?.disable?.();
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }

  /** For /health: small, no request details. */
  function health() {
    return {
      inflight: inflight.size,
      rssMb: Math.round(memory().rss / MB),
      peakRssMb: stats.peakRssMb,
      limitMb: Math.round(cfg.memoryLimit / MB),
      stalls: stats.stalls,
      lastStall: stats.lastStall,
      loopDelayMaxMs: histogram ? Math.round(histogram.max / 1e6) : null,
      slow: stats.slow,
      bigRefused: stats.bigRefused,
      uncaught: stats.fatal,
      rejections: stats.rejections,
      draining,
    };
  }

  return { track, start, stop, attachServer, shutdown, health, snapshot, onException, onRejection, checkSlow, checkMemory, checkLoop, settings: cfg, get draining() { return draining; } };
}

export const processGuard = createProcessGuard();
