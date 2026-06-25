// Resource registry — merges the core resourceDef.json and each app's resourceDef.json
// at startup. Replaces the previous per-call file read in resourceParser.js.
//
// Bootstrapping order:
//   1. This module loads — core resources are registered immediately.
//   2. apps/_loader.js iterates each app module and calls registerResources(slug, defs).
//   3. By the time any request is served, the registry is complete.
//
// Collisions throw at startup, not at request time — silent shadowing would be far worse.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const _registry = new Map(); // slug -> { ...def, _source }

export function registerResources(source, defs) {
  if (!defs || typeof defs !== "object") return;
  for (const [slug, def] of Object.entries(defs)) {
    if (_registry.has(slug)) {
      const existing = _registry.get(slug)._source;
      throw new Error(
        `Resource '${slug}' is already registered by '${existing}'. Conflicting source: '${source}'. Each resource must be owned by exactly one source.`,
      );
    }
    _registry.set(slug, { ...def, _source: source });
  }
}

export function getResource(slug) {
  const def = _registry.get(slug);
  if (!def) {
    throw new Error(`Resource definition not found for: ${slug}`);
  }
  return def;
}

export function hasResource(slug) {
  return _registry.has(slug);
}

export function getAllResources() {
  // Return a plain object copy so callers can't mutate the registry.
  const out = {};
  for (const [slug, def] of _registry.entries()) {
    const { _source, ...rest } = def;
    out[slug] = rest;
  }
  return out;
}

// Build a write-column allowlist for a resource. Derives allowed columns from
// (a) field expressions whose alias matches the resource's primary table alias,
// and (b) an explicit writeFields array for server-set / write-only columns.
// Returns null if the resource is not registered (caller falls back to schema cache).
export function getResourceWriteAllowlist(slug) {
  if (!_registry.has(slug)) return null;
  const def = _registry.get(slug);
  const alias = def.alias;
  const cols = new Set();

  for (const expr of Object.values(def.fields || {})) {
    const parts = String(expr).split(".");
    if (parts.length === 2 && parts[0] === alias) {
      cols.add(parts[1]);
    }
  }
  for (const f of def.writeFields || []) {
    cols.add(f);
  }
  return cols;
}

// Bootstrap with core resources synchronously at module load.
// Apps register themselves later via apps/_loader.js.
const coreDefsPath = path.join(__dirname, "..", "..", "resourceDef.json");
try {
  const raw = fs.readFileSync(coreDefsPath, "utf-8");
  const coreDefs = JSON.parse(raw);
  registerResources("core", coreDefs);
} catch (err) {
  // Fatal at startup — without core resources, no query can be built.
  logger.error(
    `[resourceRegistry] failed to load core resourceDef.json from ${coreDefsPath}:`,
    err.message,
  );
  throw err;
}
