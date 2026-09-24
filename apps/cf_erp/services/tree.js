/**
 * tree.js — reading the classification tree. No other service imports go in
 * here, so anything (resolution, values, codegen) can walk the tree without
 * creating an import cycle.
 *
 * Depth is the stored fact; the level names are labels for it (decision Q17).
 * Items and definitions may only sit on the deepest level.
 *
 * Reads are memoised for the life of one transaction — see lib/nodeCache.js for
 * why the memo belongs to the transaction and not to the pooled connection.
 * Off a transaction nothing is cached and every call queries, as it always did.
 */
import { notFound } from '../lib/errors.js';
import { nodeCacheOf, nodeCacheKey } from '../lib/nodeCache.js';

export const LEVELS = ['Family', 'Subfamily', 'Variant'];
export const LEAF_DEPTH = LEVELS.length - 1;
export const levelName = (depth) => LEVELS[depth] ?? `Level ${depth + 1}`;

/** The old walk's cycle guard: at most this many nodes come back from one chain. */
const MAX_CHAIN = LEAF_DEPTH + 3;

const NODE_SELECT = 'SELECT * FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND deleted_at IS NULL';

/**
 * The whole chain in one round trip. Recursive CTEs are already how fab_erp
 * walks its trees on TiDB, so this is not a new bet on the engine.
 *
 * `hop` is 0 for the node itself and counts upwards; it is stripped from the
 * rows before they leave, so a caller sees exactly what `SELECT *` gives.
 */
const CHAIN_SQL = `
  WITH RECURSIVE chain AS (
    SELECT n.*, CAST(0 AS SIGNED) AS hop
      FROM cf_classification_nodes n
     WHERE n.company_id = ? AND n.id = ? AND n.deleted_at IS NULL
     UNION ALL
    SELECT p.*, c.hop + 1
      FROM chain c
      JOIN cf_classification_nodes p
        ON p.company_id = c.company_id AND p.id = c.parent_id AND p.deleted_at IS NULL
     WHERE c.hop < ?
  )
  SELECT * FROM chain`;

export async function loadNode(db, companyId, id) {
  if (id == null) return null;
  const cache = nodeCacheOf(db);
  const key = cache && nodeCacheKey(companyId, id);
  // A miss is cached too: "this id is not a live node of this company" is an
  // answer, and asking again inside the same transaction cannot change it.
  if (cache && cache.has(key)) return cache.get(key);
  const [[node]] = await db.query(NODE_SELECT, [companyId, id]);
  const result = node || null;
  if (cache) cache.set(key, result);
  return result;
}

export async function requireNode(db, companyId, id, what = 'Classification node') {
  const node = await loadNode(db, companyId, id);
  if (!node) throw notFound(what);
  return node;
}

/**
 * Root first, the node itself last.
 *
 * Cached chain -> no query. Otherwise one query for the whole chain, and every
 * row it returns goes into the memo, so the next caller in this transaction
 * (there are about seven of them while one item is created) pays nothing.
 */
export async function ancestors(db, companyId, id) {
  if (id == null) return [];
  const cache = nodeCacheOf(db);
  if (cache) {
    const known = chainFromCache(cache, companyId, id);
    if (known) return known;
  }
  const [rows] = await db.query(CHAIN_SQL, [companyId, id, MAX_CHAIN - 1]);
  rows.sort((a, b) => b.hop - a.hop);          // root first, whatever order the engine returned
  for (const row of rows) delete row.hop;
  if (cache) {
    if (!rows.length) cache.set(nodeCacheKey(companyId, id), null);
    for (const row of rows) cache.set(nodeCacheKey(companyId, row.id), row);
  }
  return rows;
}

/**
 * The chain read out of the memo, or null when any link in it has never been
 * read and the query is still needed. Follows exactly what the one-node-at-a-
 * time walk used to do: a missing (soft-deleted, other company) parent ends the
 * chain rather than failing.
 */
function chainFromCache(cache, companyId, id) {
  const chain = [];
  let currentId = id;
  while (chain.length < MAX_CHAIN) {
    const key = nodeCacheKey(companyId, currentId);
    if (!cache.has(key)) return null;
    const node = cache.get(key);
    if (!node) break;
    chain.unshift(node);
    if (!node.parent_id) break;
    currentId = node.parent_id;
  }
  return chain;
}

/** The node and every live node below it. */
export async function subtreeIds(db, companyId, id) {
  const ids = [id];
  let frontier = [id];
  while (frontier.length) {
    const [rows] = await db.query(
      'SELECT id FROM cf_classification_nodes WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL',
      [companyId, frontier],
    );
    frontier = rows.map((r) => r.id);
    ids.push(...frontier);
  }
  return ids;
}

export function pathText(chain) {
  return chain.map((n) => n.name).join(' › ');
}
