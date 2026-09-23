/**
 * tree.js — reading the classification tree. No other service imports go in
 * here, so anything (resolution, values, codegen) can walk the tree without
 * creating an import cycle.
 *
 * Depth is the stored fact; the level names are labels for it (decision Q17).
 * Items and definitions may only sit on the deepest level.
 */
import { notFound } from '../lib/errors.js';

export const LEVELS = ['Family', 'Subfamily', 'Variant'];
export const LEAF_DEPTH = LEVELS.length - 1;
export const levelName = (depth) => LEVELS[depth] ?? `Level ${depth + 1}`;

export async function loadNode(db, companyId, id) {
  if (id == null) return null;
  const [[node]] = await db.query(
    'SELECT * FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
    [companyId, id],
  );
  return node || null;
}

export async function requireNode(db, companyId, id, what = 'Classification node') {
  const node = await loadNode(db, companyId, id);
  if (!node) throw notFound(what);
  return node;
}

/** Root first, the node itself last. */
export async function ancestors(db, companyId, id) {
  const chain = [];
  let current = await loadNode(db, companyId, id);
  let guard = 0;
  while (current && guard++ <= LEAF_DEPTH + 2) {
    chain.unshift(current);
    current = current.parent_id ? await loadNode(db, companyId, current.parent_id) : null;
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
