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

// Can this resource be written through the generic write path at all?
//
// Opt-in, and only via an explicit `writable: true` on the definition. A
// definition that says nothing is NOT writable — most tables here are owned by
// a service that enforces rules the generic path knows nothing about (stock
// movements write a ledger row and a balance together, a BOM line re-works
// roll-ups, releasing production writes the tracker whole), and the default has
// to be the safe one.
//
// `writeFields` is NOT this gate. It only narrows *which columns* a resource
// that is already writable accepts.
export function isResourceWritable(slug) {
  const def = _registry.get(slug);
  return !!def && def.writable === true;
}

// Build a write-column allowlist for a resource. For a writable resource the
// allowed columns are (a) field expressions whose alias matches the resource's
// primary table alias, and (b) the explicit writeFields array for server-set /
// write-only columns.
//
// Returns:
//   null       — the slug is not registered
//   empty Set  — registered, but not marked `writable: true`: write nothing
//   Set<col>   — the writable columns
//
// The empty-Set case previously returned the full derived field set, so
// `writeFields: []` read like a gate while in fact granting every readable
// column. Callers must treat an empty Set as "refuse the write", not as
// "nothing to filter" — resolveWriteTarget() below does that for them.
export function getResourceWriteAllowlist(slug) {
  if (!_registry.has(slug)) return null;
  const def = _registry.get(slug);
  const cols = new Set();
  if (def.writable !== true) return cols;

  const alias = def.alias;
  for (const expr of Object.values(def.fields || {})) {
    const parts = String(expr).split(".");
    if (parts.length === 2 && parts[0] === alias) {
      cols.add(parts[1]);
    }
  }
  for (const f of def.writeFields || []) {
    cols.add(f);
  }

  // The primary key is never a writable column. `id` is derivable from `fields`
  // on all 134 resources and explicitly requested by none, so leaving it in let
  // a client choose its own primary key on insert. UPDATE never wanted it
  // either — it takes the id from the payload for the WHERE clause and drops it
  // from the SET list.
  cols.delete("id");

  return cols;
}

// Resolve a client-supplied `resource` for a write operation.
//
// Writes must name a registered resourceDef slug, exactly as reads do. The raw
// DB table name is not accepted: it used to resolve past the registry into the
// schema cache, which handed back every column in the table and so skipped the
// allowlist entirely — reads demanded a slug while writes quietly took either.
//
// Returns { ok: true, table, allowlist } or { ok: false, reason }.
export function resolveWriteTarget(slug) {
  if (typeof slug !== "string" || !_registry.has(slug)) {
    return { ok: false, reason: "unknown_resource" };
  }
  const def = _registry.get(slug);
  if (def.writable !== true) {
    return { ok: false, reason: "not_writable" };
  }
  if (!def.table) {
    // A writable definition with no table is a packaging bug, not a client error.
    return { ok: false, reason: "no_table" };
  }
  return { ok: true, table: def.table, allowlist: getResourceWriteAllowlist(slug) };
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
