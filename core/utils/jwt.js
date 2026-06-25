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

export const verifyToken = (token) => {
  // Verify and decode JWT token
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
};
