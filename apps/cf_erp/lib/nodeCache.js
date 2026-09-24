/**
 * nodeCache.js — one read per classification node per transaction.
 *
 * The Family > Subfamily > Variant chain above a record is asked for over and
 * over while one record is written: the code generator wants it, the rule
 * resolver wants it, the record shaper wants it. Creating a single catalog item
 * read the same three rows twenty-two times. Over a link to TiDB that is
 * seconds per item.
 *
 * A classification node cannot change underneath a transaction that is not
 * itself changing it, so inside one transaction the same node only needs
 * reading once. That is the whole idea; everything below is about making sure
 * the memo cannot outlive the transaction that owns it.
 *
 * WHY THE CACHE LIVES ON THE TRANSACTION AND NOT ON THE CONNECTION
 * Connections come from a pool and are handed to the next request when they
 * are released. A cache keyed on the connection object — a WeakMap, a property
 * set once — would survive that release and serve one company's tree to the
 * next company's request. So withTransaction attaches a fresh Map on the way
 * in and deletes it in its finally on the way out. Outside a transaction
 * (a read straight off the pool) the symbol is absent and nothing is cached:
 * loadNode simply queries, exactly as before.
 *
 * WRITES CLEAR IT
 * createNode, updateNode and deleteNode clear the whole cache, because the
 * transaction that writes the tree then reads it back — cf_bridge_setup.mjs
 * creates a Family and immediately asks for its path. The cache holds a handful
 * of rows, so clearing all of it is cheaper to be sure about than working out
 * which entries a move invalidated.
 */

/** Per-transaction memo of classification-node rows. Never set on a pool. */
const NODE_CACHE = Symbol('cf_erp.nodeCache');

export const nodeCacheKey = (companyId, id) => `${companyId}:${id}`;

/** Called by withTransaction, once, on the connection it owns for the transaction. */
export function attachNodeCache(conn) {
  if (conn) conn[NODE_CACHE] = new Map();
}

/** Called by withTransaction in its finally, so the cache dies with the transaction. */
export function detachNodeCache(conn) {
  if (conn) delete conn[NODE_CACHE];
}

/** The live cache, or null when this db handle is not inside a transaction that owns one. */
export function nodeCacheOf(db) {
  return db?.[NODE_CACHE] ?? null;
}

/** Every classification write calls this: the tree just changed under the reader. */
export function invalidateNodeCache(db) {
  db?.[NODE_CACHE]?.clear();
}
