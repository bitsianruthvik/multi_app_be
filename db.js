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