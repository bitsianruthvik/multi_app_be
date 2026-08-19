/**
 * fieldLadder.js — the rungs, and how to climb them.
 *
 * One ladder with one meaning, replacing two columns that were both called
 * `level` and meant different things:
 *
 *   category -> group -> subgroup -> catalog_item -> order_item -> stock_piece
 *
 * WHY THIS IS A WALK AND NOT A LIST OF SIX STEPS. The BOM redesign makes an
 * order item's parent another order item — a part under a segment under a
 * girder under a span — so the chain is not a fixed depth. Written as six
 * hardcoded lookups the resolver would have to be rewritten the day templates
 * nest. Written as "keep asking each rung for its parent until there is none",
 * a nested template is simply more parents and nothing here changes.
 *
 * That is constraint C1 in FAB_ERP_FIELDS_REDESIGN.md, and it is the one thing
 * that is cheap now and expensive later.
 */

import { pool } from '../../../db.js';

/**
 * Broadest first. The index is the rung number, and that ordering is the whole
 * precedence rule: later in this list wins.
 */
export const RUNGS = ['category', 'group', 'subgroup', 'catalog_item', 'order_item', 'stock_piece'];

export const rungOf = (scope) => RUNGS.indexOf(scope);

/**
 * May a value for this field be set at this scope?
 *
 * The narrowest rung the field may be set on. BROADER is always allowed,
 * because a broad value is a DEFAULT, and a default is meaningful at any width
 * -- "our plate is normally 6000 long" belongs on the catalog item even though
 * length genuinely varies per piece.
 *
 * NARROWER is what gets refused, and that is the old gate purpose exactly: a
 * field declared not to vary per instance (applies_at = catalog_item) must not
 * acquire a different value on one piece, because then two rows disagree and
 * nothing says which is right.
 *
 * It deliberately does NOT stop something odd-but-harmless, such as a heat
 * number set on a whole category. Separating "varies per piece" from "only
 * meaningful per piece" needs a second axis -- and that second axis is exactly
 * the item|piece|both-plus-a-runtime-gate complexity this replaces.
 */
export function mayHoldValue(field, scope) {
  const limit = rungOf(field?.applies_at ?? 'catalog_item');
  const at = rungOf(scope);
  if (at < 0 || limit < 0) return false;
  return at <= limit;
}

/**
 * The parent of one node, or null at the top.
 *
 * Each rung answers for itself, which is what keeps the walk generic. The only
 * two interesting cases:
 *
 *   stock_piece  a WIP piece belongs to the order item it was made for; a
 *                bought piece belongs to its catalog item. Same rung, two
 *                different parents, decided by the row.
 *   order_item   its parent is ANOTHER order item when it sits inside an
 *                assembly, and only falls through to the catalog item at the
 *                top of the tree. This is the variable-depth part.
 */
async function parentOf(exec, companyId, scope, scopeId) {
  switch (scope) {
    case 'stock_piece': {
      const [[p]] = await exec.query(
        `SELECT wip_item_id AS wipItemId, catalog_item_id AS catalogItemId
           FROM fab_stock_pieces WHERE id = ? AND company_id = ? LIMIT 1`,
        [scopeId, companyId],
      );
      if (!p) return null;
      if (p.wipItemId) return { scope: 'order_item', scopeId: Number(p.wipItemId) };
      if (p.catalogItemId) return { scope: 'catalog_item', scopeId: Number(p.catalogItemId) };
      return null;
    }
    case 'order_item': {
      const [[i]] = await exec.query(
        `SELECT parent_item_id AS parentItemId, catalog_item_id AS catalogItemId
           FROM fab_items WHERE id = ? AND company_id = ? LIMIT 1`,
        [scopeId, companyId],
      );
      if (!i) return null;
      /**
       * PURE INSTANCE WALK. The catalog item is NOT reached from here.
       *
       * An instantiated part has two parents — the segment it sits in, and the
       * Top Flange type it is an instance of — and a single walk can only
       * follow one. Following the type short-circuits the climb (the part never
       * sees its span); following the parent loses the type's defaults.
       *
       * So the two are composed in `chainFor` instead, and this function
       * answers only "what contains this". See the precedence argument there.
       */
      if (i.parentItemId) return { scope: 'order_item', scopeId: Number(i.parentItemId) };
      if (i.catalogItemId) return { scope: 'catalog_item', scopeId: Number(i.catalogItemId) };
      return null;
    }
    case 'catalog_item': {
      const [[c]] = await exec.query(
        `SELECT category_id AS categoryId, group_id AS groupId, subgroup_id AS subgroupId
           FROM fab_item_catalog WHERE id = ? AND company_id = ? LIMIT 1`,
        [scopeId, companyId],
      );
      if (!c) return null;
      if (c.subgroupId) return { scope: 'subgroup', scopeId: Number(c.subgroupId) };
      if (c.groupId) return { scope: 'group', scopeId: Number(c.groupId) };
      if (c.categoryId) return { scope: 'category', scopeId: Number(c.categoryId) };
      return null;
    }
    case 'subgroup': {
      const [[s]] = await exec.query(
        `SELECT group_id AS groupId FROM fab_item_subgroups WHERE id = ? AND company_id = ? LIMIT 1`,
        [scopeId, companyId],
      );
      return s?.groupId ? { scope: 'group', scopeId: Number(s.groupId) } : null;
    }
    case 'group': {
      const [[g]] = await exec.query(
        `SELECT category_id AS categoryId FROM fab_item_groups WHERE id = ? AND company_id = ? LIMIT 1`,
        [scopeId, companyId],
      );
      return g?.categoryId ? { scope: 'category', scopeId: Number(g.categoryId) } : null;
    }
    default:
      return null;
  }
}

/** Depth guard. A BOM that references itself would otherwise climb forever. */
const MAX_DEPTH = 32;

/**
 * The chain from a node up to its broadest ancestor, BROADEST FIRST.
 *
 * Broadest first because that is the order values are applied in — each rung
 * overwrites the one above it, so the narrowest wins by being last. Returning
 * it the other way round would make every caller reverse it.
 *
 * @returns {Promise<Array<{scope, scopeId}>>} always includes the node itself
 */
export async function chainFor(companyId, scope, scopeId, conn = null) {
  const exec = conn ?? pool;
  const chain = [{ scope, scopeId: Number(scopeId) }];
  const seen = new Set([`${scope}:${scopeId}`]);

  let cursor = { scope, scopeId: Number(scopeId) };
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next = await parentOf(exec, companyId, cursor.scope, cursor.scopeId);
    if (!next) break;
    const key = `${next.scope}:${next.scopeId}`;
    // A cycle is a data error, not something to recurse on. Stopping quietly
    // yields a shorter chain rather than a hang; the integrity check reports it.
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(next);
    cursor = next;
  }

  return withOwnType(exec, companyId, scope, scopeId, chain.reverse(), seen);
}

/**
 * Splice an order item's OWN type in above the job it belongs to.
 *
 * The chain from an instantiated part has two segments and they are not one
 * walk. Broadest to narrowest, the answer should be:
 *
 *   category / group / subgroup      of the Top Flange TYPE
 *   the Top Flange type              "all top flanges are E350"
 *   span -> girder -> segment        what THIS job says
 *   the part itself
 *
 * A job-specific value beats a type default, so the instance ancestors sit
 * below the type and win. Without this the part would reach its span and the
 * span's taxonomy, and its own type's defaults would never apply — which is
 * most of the point of catalogueing the type at all.
 *
 * Only inserted when the item is not already reaching its catalog item through
 * the walk (that happens at the top of the tree, where there is no parent).
 */
async function withOwnType(exec, companyId, scope, scopeId, chain, seen) {
  if (scope !== 'order_item') return chain;
  const [[i]] = await exec.query(
    'SELECT catalog_item_id AS catalogItemId FROM fab_items WHERE id = ? AND company_id = ? LIMIT 1',
    [scopeId, companyId],
  );
  if (!i?.catalogItemId) return chain;
  if (seen.has(`catalog_item:${i.catalogItemId}`)) return chain;

  // The type and everything above it, broadest first.
  const typeChain = [{ scope: 'catalog_item', scopeId: Number(i.catalogItemId) }];
  let cursor = typeChain[0];
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next = await parentOf(exec, companyId, cursor.scope, cursor.scopeId);
    if (!next || seen.has(`${next.scope}:${next.scopeId}`)) break;
    seen.add(`${next.scope}:${next.scopeId}`);
    typeChain.push(next);
    cursor = next;
  }
  typeChain.reverse();

  // Everything the instance walk found that is BROADER than an order item
  // (the root's own catalog item and taxonomy) stays outermost; the type chain
  // goes immediately before the job's own rungs.
  const jobRungs = chain.filter((c) => c.scope === 'order_item');
  const outer = chain.filter((c) => c.scope !== 'order_item');
  return [...outer, ...typeChain, ...jobRungs];
}

/**
 * Chains for many nodes at once, sharing the lookups they have in common.
 *
 * The parameters grid resolves a few hundred parts that mostly share a handful
 * of ancestors, so walking each independently would re-query the same girder
 * and the same category hundreds of times.
 */
export async function chainsFor(companyId, targets, conn = null) {
  const exec = conn ?? pool;
  const memo = new Map(); // "scope:id" -> parent or null
  const out = new Map();

  for (const t of targets ?? []) {
    const startKey = `${t.scope}:${t.scopeId}`;
    const chain = [{ scope: t.scope, scopeId: Number(t.scopeId) }];
    const seen = new Set([startKey]);
    let cursor = chain[0];

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const key = `${cursor.scope}:${cursor.scopeId}`;
      if (!memo.has(key)) memo.set(key, await parentOf(exec, companyId, cursor.scope, cursor.scopeId));
      const next = memo.get(key);
      if (!next) break;
      const nk = `${next.scope}:${next.scopeId}`;
      if (seen.has(nk)) break;
      seen.add(nk);
      chain.push(next);
      cursor = next;
    }
    out.set(startKey, await withOwnType(exec, companyId, t.scope, t.scopeId, chain.reverse(), seen));
  }
  return out;
}
