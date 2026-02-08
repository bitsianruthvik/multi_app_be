// db.js
// This file is responsible for connecting our backend to MySQL

import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { join } from "path";
import fs from "fs";
// Load .env explicitly from the repository root to avoid cases where the process
// CWD differs from repo root (nodemon, editors, etc.). This ensures DB_ vars
// defined in role-based-auth/.env are available.
const envPath = join(process.cwd(), ".env");
const result = dotenv.config({ path: envPath });
if (result.error) {
  // If .env is not present, continue — variables may be provided via environment.
  console.info("dotenv: .env not loaded from", envPath);
} else {
  // result.parsed contains the parsed key/values
  const count = result.parsed ? Object.keys(result.parsed).length : 0;
  console.info(`[dotenv] loaded ${count} entries from ${envPath}`);
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
      console.info("[dotenv-fallback] applied manual parse of .env");
    } catch (e) {
      console.warn(
        "[dotenv-fallback] failed to parse .env fallback",
        e.message || e,
      );
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
  console.error(
    "Missing DB credentials: ensure DB_USER and DB_PASSWORD are set in .env or environment variables.",
  );
  console.error(
    `DB_USER=${mask(process.env.DB_USER)}, DB_PASSWORD=${mask(
      process.env.DB_PASSWORD,
    )}`,
  );
  // Do not exit here to allow some admin routes to run in limited local modes,
  // but log prominently so it's obvious in logs. If you want hard-fail, uncomment:
  // process.exit(1);
}

// Create a connection pool (better than single connection for performance)
export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306), // ✅ ADD THIS
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});