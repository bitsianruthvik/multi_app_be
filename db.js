// db.js
// This file is responsible for connecting our backend to MySQL

import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { join } from "path";
import fs from "fs";
import { logger } from "./core/utils/logger.js";
// Load .env explicitly from the repository root to avoid cases where the process
// CWD differs from repo root (nodemon, editors, etc.). This ensures DB_ vars
// defined in role-based-auth/.env are available.
const envPath = join(process.cwd(), ".env");
const result = dotenv.config({ path: envPath });
if (result.error) {
  // If .env is not present, continue — variables may be provided via environment.
  logger.info({ envPath }, "dotenv: .env not loaded from");
} else {
  // result.parsed contains the parsed key/values
  const count = result.parsed ? Object.keys(result.parsed).length : 0;
  logger.info({ count, envPath }, "[dotenv] loaded entries from");
  // If dotenv parsed zero entries (some environments or encoding may confuse it),
  // fall back to a simple manual parser for critical DB_ vars so the server can start.
  if (count === 0) {
    try {
      const raw = fs.readFileSync(envPath, { encoding: "utf8" });
      raw.split(/\r?\n/).forEach((line) => {
        const s = line.trim();
        if (!s || s.startsWith("#") || s.indexOf("=") === -1) return;
        const parts = s.split("=");
        const k = parts.shift().trim();
        const v = parts
          .join("=")
          .trim()
          .replace(/^"|"$/g, "")
          .replace(/^'|'$/g, "");
        if (!process.env[k]) process.env[k] = v;
      });
      // Also ensure critical DB keys are set if present in file but not parsed
      const find = (key) => {
        const m = raw.match(new RegExp("^" + key + "\\s*=\\s*(.*)$", "m"));
        return m
          ? m[1].trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "")
          : null;
      };
      if (!process.env.DB_USER) {
        const v = find("DB_USER");
        if (v) process.env.DB_USER = v;
      }
      if (!process.env.DB_PASSWORD) {
        const v = find("DB_PASSWORD");
        if (v) process.env.DB_PASSWORD = v;
      }
      if (!process.env.DB_NAME) {
        const v = find("DB_NAME");
        if (v) process.env.DB_NAME = v;
      }
      logger.info("[dotenv-fallback] applied manual parse of .env");
    } catch (e) {
      logger.warn({ err: e }, "[dotenv-fallback] failed to parse .env fallback");
    }
  }
}

function mask(s) {
  if (!s) return "<missing>";
  s = String(s);
  if (s.length <= 6) return s[0] + ".." + s.slice(-1);
  return s.slice(0, 3) + ".." + s.slice(-2);
}

// Fail fast with a clear message if DB credentials are not present
if (!process.env.DB_USER || !process.env.DB_PASSWORD) {
  logger.error(
    "Missing DB credentials: ensure DB_USER and DB_PASSWORD are set in .env or environment variables.",
  );
  logger.error(
    { DB_USER: mask(process.env.DB_USER), DB_PASSWORD: mask(process.env.DB_PASSWORD) },
    "DB credential mask",
  );
  // Do not exit here to allow some admin routes to run in limited local modes,
  // but log prominently so it's obvious in logs. If you want hard-fail, uncomment:
  // process.exit(1);
}

// Create a connection pool (better than single connection for performance)
const DB_POOL_SIZE = parseInt(process.env.DB_POOL_SIZE, 10) || 10;
const DB_POOL_WARN_THRESHOLD = parseInt(
  process.env.DB_POOL_WARN_THRESHOLD,
  10,
) || 3;

// Managed MySQL-compatible hosts (TiDB Cloud, PlanetScale, Aiven, etc.) require
// TLS. Set DB_SSL=true in their env vars; local MySQL leaves this unset.
const useSsl = String(process.env.DB_SSL || "").toLowerCase() === "true";

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: DB_POOL_SIZE,
  queueLimit: 0,
  // DATE columns: return plain 'YYYY-MM-DD' strings instead of JS Date objects.
  // Date objects serialize via toJSON() in UTC, which shifts a wall-clock date
  // back a day for timezones east of UTC. DATETIME/TIMESTAMP are unaffected —
  // they represent real instants and serialize correctly as Date objects.
  dateStrings: ["DATE"],
  // DATETIME columns are UTC wall-clock. Without this, mysql2 defaults to
  // timezone:'local' and interprets every DATETIME it reads in the HOST's zone —
  // while the app writes them via toISOString() (UTC). On a UTC host those agree
  // and nothing is visibly wrong, which is why this survived: prod (Render +
  // TiDB, both UTC) is self-consistent.
  //
  // On any other host they disagree by the offset, and the error COMPOUNDS on
  // every read-modify-write: an interval corrected twice moved 08:00 → 02:30 →
  // 21:00 on an IST machine. See FAB_ERP_PEOPLE_PLAN.md §10.3 / §10.3a.
  //
  // Pinning to 'Z' makes reads and writes agree on every host, and is a no-op
  // wherever the server is already UTC.
  //
  // CAVEAT: MySQL's NOW() still evaluates in the SERVER's zone. On a non-UTC
  // server, NOW()-written values are now read back shifted. fab_erp uses
  // UTC_TIMESTAMP() instead (see fab_erp/routes, fab_erp/services); other apps
  // still use NOW() and are only correct on a UTC server — which is what prod is.
  timezone: "Z",
  // Managed databases reap connections that look idle, and a long transaction
  // looks idle between statements. When the far end goes away mid-work the
  // driver has nothing to notice it by and simply waits — a rebuild of one
  // large order's task graph sat on a dead socket for forty minutes and then
  // rolled back with nothing written. TCP keepalive is what makes the socket
  // fail loudly instead of silently.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  ...(useSsl ? { ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true } } : {}),
});

// Pool saturation visibility — these events are emitted on the underlying mysql2 pool.
// `enqueue` fires whenever a request has to wait for a connection (pool is at capacity).
// We log a warn when the wait queue exceeds the configured threshold.
const underlying = pool.pool;
if (underlying && typeof underlying.on === "function") {
  underlying.on("enqueue", () => {
    const waiting = (underlying._connectionQueue || []).length;
    if (waiting >= DB_POOL_WARN_THRESHOLD) {
      logger.warn(
        { waiting, limit: DB_POOL_SIZE },
        "[db] pool saturated",
      );
    }
  });
}

/**
 * Snapshot of pool state — exposed for the /health endpoint.
 * `total` / `idle` / `waiting` come from internal mysql2 fields; if those
 * change shape upstream we degrade to nulls rather than throwing.
 */
export function getPoolStats() {
  const u = pool.pool || {};
  return {
    limit: DB_POOL_SIZE,
    total: Array.isArray(u._allConnections) ? u._allConnections.length : null,
    idle: Array.isArray(u._freeConnections) ? u._freeConnections.length : null,
    waiting: Array.isArray(u._connectionQueue)
      ? u._connectionQueue.length
      : null,
  };
}

/**
 * Error codes that mean THE SOCKET IS GONE, as opposed to the query being wrong.
 *
 * The distinction is the whole point of the two helpers below: a dead socket is
 * worth retrying because nothing was executed, and a rejected statement is not.
 * `err.fatal` catches the driver's own view of the same thing for codes not
 * listed here.
 */
const DEAD_SOCKET = new Set([
  "ECONNRESET",
  "PROTOCOL_CONNECTION_LOST",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNABORTED",
]);
export const isDeadConnection = (err) =>
  !!err && (DEAD_SOCKET.has(err.code) || err.fatal === true);

/**
 * A pooled connection that has been PROVEN alive, for work that begins after a
 * long pause.
 *
 * TCP keepalive above keeps the socket from dying of neglect, but it cannot
 * stop the far end from hanging up on purpose: TiDB Cloud closes a session that
 * has been idle past its own timeout, and mysql2 hands the closed one straight
 * back out of the free list. The first statement then fails with ECONNRESET —
 * which is indistinguishable, to the caller, from the work being impossible.
 *
 * This bit on the nesting suggestor. A deep nest is minutes of pure computation
 * with no queries in between; by the time a person looked at the proposal and
 * pressed Accept, every connection in the pool had been idle long enough to be
 * reaped. 129 plates were computed and thrown away, and the order still read
 * "1090 of 1090 parts have no material".
 *
 * A ping costs one round trip. Use it where the pause is expected — a long
 * computation, a queue worker waking up, a request that follows a person
 * thinking — not on the hot path of ordinary reads.
 *
 * A connection that fails the ping is DESTROYED rather than released, so it
 * leaves the pool instead of being handed to the next caller.
 *
 * ANY ping failure counts, not just the codes below. There is no such thing as
 * a connection that cannot answer a ping but is otherwise fine, and the codes a
 * broken socket reports vary with how it broke — a server hangup gives
 * ECONNRESET, a locally torn-down stream gives ERR_STREAM_DESTROYED, and a test
 * that killed the socket by hand found the second one leaking straight through
 * a check written for the first. `isDeadConnection` stays for
 * `retryOnDeadConnection`, where telling a dropped socket from a rejected
 * statement is the entire point.
 */
export async function getLiveConnection(attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    const conn = await pool.getConnection();
    try {
      await conn.ping();
      return conn;
    } catch (err) {
      last = err;
      conn.destroy();
      logger.warn(
        { attempt: i, code: err.code },
        "[db] discarded a pooled connection that failed its ping",
      );
    }
  }
  throw last;
}

/**
 * Run IDEMPOTENT pool work, retrying if the connection turned out to be dead.
 *
 * Idempotent, not read-only: a full recompute qualifies, because running it
 * twice lands on the same answer. What does NOT qualify is anything that
 * appends or increments — a retry there could re-apply a commit that actually
 * landed before the socket dropped, and the caller would never know. Work like
 * that belongs in a transaction on a `getLiveConnection()`, where a dead socket
 * means nothing was committed at all.
 *
 * One stale connection does not imply the next one is good: the pool is a list,
 * and a long pause can have left several in it. Each attempt draws a different
 * connection, and mysql2 drops the fatally-errored one on the way out.
 */
export async function retryOnDeadConnection(fn, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isDeadConnection(err) || i === attempts) throw err;
      logger.warn({ attempt: i, code: err.code }, "[db] retrying after a dead connection");
    }
  }
  throw last;
}
