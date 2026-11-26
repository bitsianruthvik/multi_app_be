// Utility functions for signing and verifying JWT tokens

import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { logger } from "./logger.js";
dotenv.config();

export const signToken = (payload) => {
  // Generate JWT token using user info as payload
  // Normalize and validate expiresIn value coming from env
  const raw = process.env.JWT_EXPIRES_IN;
  let expiresIn = raw;

  if (!raw) {
    // default to 7 days
    expiresIn = "7d";
  } else if (/^\d+$/.test(raw)) {
    // pure number (seconds)
    expiresIn = Number(raw);
  } else if (/^\d+s$/.test(raw)) {
    // e.g. '3600s' -> number of seconds
    expiresIn = Number(raw.slice(0, -1));
  } else if (/^\d+[smhd]$/.test(raw)) {
    // e.g. '7d', '1h', '30m', '45s' -> pass through
    expiresIn = raw;
  } else {
    // invalid value -> fallback to 7d
    logger.warn({ raw }, `Invalid JWT_EXPIRES_IN value. Falling back to '7d'.`);
    expiresIn = "7d";
  }

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn,
  });
};

/**
 * ONE SIGN-IN PER COMPANY IN A BROWSER (2026-11-26). The browser keeps a separate sign-in for every company and each
 * page sends the one for the company in its address (Authorization: Bearer). The cookie is shared by all companies
 * (the last sign-in wins), so it is only the fallback for a request that sends no sign-in of its own; it was read first
 * until now, which sent the last company's sign-in with a page of another.
 */
export function tokenFrom(req) {
  const auth = req.headers?.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  return req.cookies?.token || null;
}

/** The company an /api/<company>/... address names (null for /api/public, /api/query, /api/platform and the like). */
const NOT_A_COMPANY = new Set(["public", "query", "platform", "files", "health"]);
export function companyInUrl(req) {
  const parts = String(req.originalUrl || "").split("?")[0].split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() !== "api" || !parts[1]) return null;
  const slug = decodeURIComponent(parts[1]).toLowerCase();
  return NOT_A_COMPANY.has(slug) ? null : slug;
}

/** Whether a decoded sign-in is for the company the address names (true when it names none). */
export function tokenFitsUrl(decoded, req) {
  const slug = companyInUrl(req);
  if (!slug) return true;
  return String(decoded?.company || "").toLowerCase() === slug;
}

export const verifyToken = (token) => {
  // Verify and decode JWT token
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
};
