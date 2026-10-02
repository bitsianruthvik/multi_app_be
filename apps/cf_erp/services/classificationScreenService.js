/**
 * classificationScreenService.js — which part of the ONE classification tree a
 * screen shows (Items, Definitions, Machines), and what a branch holds.
 *
 * The user's rule (2026-10-02): NO hand tagging. A screen's tree is DERIVED:
 *   - Machines:    every machine-scope node (a machine family and its levels —
 *                  createNode forces scope 'machine' on everything under one, and
 *                  requireMachineType keeps machines off any other node, so the
 *                  scope IS "holds machines or is a machine-type node").
 *   - Items:       every node holding ≥1 item (catalog or temporary) in its subtree.
 *   - Definitions: every node holding ≥1 definition in its subtree, plus every
 *                  branch a selection definition picks from (its candidate node,
 *                  and the nodes of the items on its allowed list).
 *   - An EMPTY node (nothing in its subtree) has nothing to derive from, so it
 *     shows on the screen whose pop-up created it (cf_classification_nodes
 *     .created_in, stamped at creation). NULL / 'setup' (made before §41, by a
 *     script, or by the command palette) shows on Items AND Definitions.
 *   - Every ancestor of a visible node is visible, so a branch is reachable.
 *
 * Set-based on purpose (prod is ~49 ms a round trip): six aggregate reads, run
 * side by side, and the roll-up in memory. No query per node.
 */
import { invalid, conflict } from '../lib/errors.js';
import { LEAF_DEPTH, LEVELS, levelName } from './tree.js';

export const SCREENS = ['items', 'definitions', 'machines'];
/** What created_in may hold. 'setup' reads like NULL. */
export const CREATED_IN = ['items', 'definitions', 'machines', 'setup'];

/**
 * The visible tree for one screen. `all` returns the whole side of the tree
 * (non-machine for items/definitions, machine for machines) with the hidden
 * nodes flagged — the pickers' "Show all branches", so a branch made elsewhere
 * is never a dead end.
 */
export async function screenTree(db, companyId, screen, { all = false } = {}) {
  if (!SCREENS.includes(screen)) throw invalid('INVALID', 'screen is items, definitions or machines.');
  const [[nodes], [records], [machines], [rules], [candidates], [allowed]] = await Promise.all([
    db.query(
      `SELECT id, parent_id, depth, scope, code, name, description, sort_order, status, created_in
         FROM cf_classification_nodes
        WHERE company_id = ? AND deleted_at IS NULL
        ORDER BY depth, sort_order, name`,
      [companyId],
    ),
    db.query(
      `SELECT classification_id AS id, record_kind AS kind, COUNT(*) AS n
         FROM cf_master_records
        WHERE company_id = ? AND deleted_at IS NULL AND classification_id IS NOT NULL
        GROUP BY classification_id, record_kind`,
      [companyId],
    ),
    db.query(
      `SELECT classification_id AS id, COUNT(*) AS n FROM cf_machines
        WHERE company_id = ? AND deleted_at IS NULL GROUP BY classification_id`,
      [companyId],
    ),
    db.query(
      `SELECT subject_id AS id, COUNT(*) AS n FROM cf_spec_assignments
        WHERE company_id = ? AND subject_type = 'classification' AND deleted_at IS NULL GROUP BY subject_id`,
      [companyId],
    ),
    // A selection's candidate branch — the node it searches.
    db.query(
      `SELECT d.candidate_classification_id AS id, COUNT(*) AS n
         FROM cf_definition_details d
         JOIN cf_master_records m ON m.company_id = d.company_id AND m.id = d.master_id AND m.deleted_at IS NULL
        WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.definition_type = 'selection'
          AND d.candidate_classification_id IS NOT NULL
        GROUP BY d.candidate_classification_id`,
      [companyId],
    ),
    // ...and the branches of the items on its allowed list.
    db.query(
      `SELECT i.classification_id AS id, COUNT(DISTINCT a.definition_id) AS n
         FROM cf_definition_allowed_items a
         JOIN cf_master_records d ON d.company_id = a.company_id AND d.id = a.definition_id AND d.deleted_at IS NULL
         JOIN cf_master_records i ON i.company_id = a.company_id AND i.id = a.item_id AND i.deleted_at IS NULL
        WHERE a.company_id = ? AND a.deleted_at IS NULL AND i.classification_id IS NOT NULL
        GROUP BY i.classification_id`,
      [companyId],
    ),
  ]);

  const byId = new Map();
  for (const n of nodes) {
    byId.set(n.id, {
      id: n.id, parentId: n.parent_id, depth: n.depth, level: levelName(n.depth), scope: n.scope,
      code: n.code, name: n.name, description: n.description, sortOrder: n.sort_order, status: n.status,
      createdIn: n.created_in ?? null,
      itemCount: 0, definitionCount: 0, machineCount: 0, ruleCount: 0, selectionSources: 0,
      subtree: { items: 0, definitions: 0, machines: 0 },
      visibleBecause: [],
      children: [],
    });
  }
  for (const r of records) {
    const node = byId.get(r.id);
    if (!node) continue;
    if (r.kind === 'item') node.itemCount += Number(r.n);
    else if (r.kind === 'definition') node.definitionCount += Number(r.n);
  }
  for (const r of machines) { const node = byId.get(r.id); if (node) node.machineCount = Number(r.n); }
  for (const r of rules) { const node = byId.get(r.id); if (node) node.ruleCount = Number(r.n); }
  for (const r of [...candidates, ...allowed]) { const node = byId.get(r.id); if (node) node.selectionSources += Number(r.n); }

  // Roll up, deepest first: a parent's subtree is its own plus its children's.
  const parentOf = (node) => (node.parentId != null ? byId.get(node.parentId) ?? null : null);
  const deepestFirst = [...byId.values()].sort((a, b) => b.depth - a.depth);
  for (const node of deepestFirst) {
    node.subtree.items += node.itemCount;
    node.subtree.definitions += node.definitionCount;
    node.subtree.machines += node.machineCount;
    const parent = parentOf(node);
    if (parent) {
      parent.subtree.items += node.subtree.items;
      parent.subtree.definitions += node.subtree.definitions;
      parent.subtree.machines += node.subtree.machines;
    }
  }

  const onSide = (node) => (screen === 'machines' ? node.scope === 'machine' : node.scope !== 'machine');
  for (const node of byId.values()) {
    if (!onSide(node)) continue;
    const why = node.visibleBecause;
    const s = node.subtree;
    const empty = s.items + s.definitions + s.machines === 0;
    if (screen === 'machines') {
      if (s.machines > 0) why.push('holds_machines');
      else if (node.createdIn === 'machines') why.push('created_here');
      else why.push('machine_family');
      continue;
    }
    if (screen === 'items' && s.items > 0) why.push('holds_items');
    if (screen === 'definitions' && s.definitions > 0) why.push('holds_definitions');
    if (screen === 'definitions' && node.selectionSources > 0) why.push('selection_source');
    if (empty) {
      if (node.createdIn === screen) why.push('created_here');
      else if (node.createdIn == null || node.createdIn === 'setup') why.push('legacy_empty');
    }
  }
  // Ancestors of anything visible, so every visible node can be reached.
  for (const node of byId.values()) {
    if (!node.visibleBecause.length || node.visibleBecause[0] === 'ancestor') continue;
    let up = parentOf(node);
    while (up && !up.visibleBecause.length) {
      up.visibleBecause.push('ancestor');
      up = parentOf(up);
    }
  }

  let hiddenCount = 0;
  const roots = [];
  // byId keeps the query's order (depth, sort_order, name), so children land in order.
  for (const node of byId.values()) {
    if (!onSide(node)) continue;
    const visible = node.visibleBecause.length > 0;
    if (!visible) hiddenCount++;
    if (!visible && !all) continue;
    node.hidden = !visible;
    const parent = parentOf(node);
    if (parent && onSide(parent)) parent.children.push(node);
    else roots.push(node);
  }
  // Without `all`, a hidden parent cannot have reached here — the ancestor pass
  // made every visible node's parent visible — so no orphan is ever promoted.
  return { screen, all: !!all, levels: LEVELS, leafDepth: LEAF_DEPTH, hiddenCount, roots };
}

/**
 * What lives in a branch, in one round trip: items, definitions and machines
 * anywhere in the node's subtree. The refusal for moving or retiring a branch
 * that still holds things is built from it.
 */
export async function subtreeHoldings(db, companyId, id) {
  const [[r]] = await db.query(
    `WITH RECURSIVE sub AS (
       SELECT id FROM cf_classification_nodes WHERE company_id = ? AND id = ? AND deleted_at IS NULL
       UNION ALL
       SELECT n.id FROM cf_classification_nodes n JOIN sub ON n.parent_id = sub.id
        WHERE n.company_id = ? AND n.deleted_at IS NULL
     )
     SELECT
       (SELECT COUNT(*) FROM cf_master_records m WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND m.classification_id IN (SELECT id FROM sub)) AS items,
       (SELECT COUNT(*) FROM cf_master_records m WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'definition' AND m.classification_id IN (SELECT id FROM sub)) AS definitions,
       (SELECT COUNT(*) FROM cf_machines mc WHERE mc.company_id = ? AND mc.deleted_at IS NULL AND mc.classification_id IN (SELECT id FROM sub)) AS machines`,
    [companyId, id, companyId, companyId, companyId, companyId],
  );
  return { items: Number(r.items), definitions: Number(r.definitions), machines: Number(r.machines) };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "holds 3 items · 1 definition · 0 machines" */
export function holdingsText(h) {
  return `holds ${plural(h.items, 'item', 'items')} · ${plural(h.definitions, 'definition', 'definitions')} · ${plural(h.machines, 'machine', 'machines')}`;
}

export const holdsAnything = (h) => h.items + h.definitions + h.machines > 0;

/** Refuses when the branch still holds things. `doing` finishes the sentence. */
export async function assertBranchEmpty(db, companyId, node, doing) {
  const h = await subtreeHoldings(db, companyId, node.id);
  if (holdsAnything(h)) {
    throw conflict('NOT_EMPTY', `${node.name} ${holdingsText(h)} — ${doing}.`, { holdings: h, problems: [`${node.name} ${holdingsText(h)}`] });
  }
  return h;
}
