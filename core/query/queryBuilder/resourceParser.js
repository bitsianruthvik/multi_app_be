import { getResource } from "../resourceRegistry.js";

/**
 * Parses the given resource name and returns
 * its table, alias, fields, and relationships.
 *
 * Reads from the in-memory resource registry, which is populated at startup
 * (core resourceDef.json + each app's resourceDef.json).
 */
export function parseResource(resourceName) {
  return getResource(resourceName);
}
