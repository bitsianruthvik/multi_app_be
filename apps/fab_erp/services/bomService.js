/**
 * bomService.js — what a catalog item is made of, and how that becomes an order.
 *
 * Step 5 of FAB_ERP_FIELDS_REDESIGN.md. This is the generic replacement for
 * `buildWizardRows`, which is a hardcoded four-level nest with `span`,
 * `girders` and `segmentsPerGirder` written into the source and an `if
 * (!girders)` branch for a PEB.
 *
 * Here the depth is whatever the BOM has. A PEB is not a branch, it is a
 * template with no Girder line. "Girders but no segments" is not a special case,
 * it is a quantity of zero. The four-level assumption disappears rather than
 * being parameterised.
 *
 * PARAMETERS ARE DERIVED, NOT DECLARED. A line whose quantity is `qty_param`
 * contributes a question the wizard asks; the set of questions is the distinct
 * set of parameter names in the tree. A separate parameters table would be a
 * second place to keep the same fact, and it would go stale the first time
 * somebody deleted a line.
 *
 * IT EXPANDS IN MEMORY. `expand` returns a tree of what WOULD be created and
 * writes nothing. That is what lets the wizard show a person the shape before
 * anything exists, and it is why a wrong answer costs a re-run rather than a
 * half-built order.
 */

import { pool } from '../../../db.js';
import { recomputeDerived } from './fieldDeriveService.js';

/** A BOM deep enough to hit this is a cycle or a mistake, not a real structure. */
const MAX_DEPTH = 16;

/** Every line under one parent, child details included. */
export async function bomFor(companyId, parentItemId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT b.id, b.parent_item_id AS parentItemId, b.child_item_id AS childItemId,
            b.qty_num AS qtyNum, b.qty_param AS qtyParam, b.default_qty AS defaultQty,
            b.per_instance_qty AS perInstanceQty, b.code_segment AS codeSegment,
            b.help_text AS helpText, b.sort_order AS sortOrder,
            b.default_flow_id AS defaultFlowId, f.name AS defaultFlowName, b.code_join AS codeJoin,
            b.explode AS explode,
            c.code AS childCode, c.name AS childName, c.unit AS childUnit,
            c.category_id AS childCategoryId
       FROM fab_item_bom b
       JOIN fab_item_catalog c ON c.id = b.child_item_id AND c.deleted_at IS NULL
       LEFT JOIN fab_operation_flows f ON f.id = b.default_flow_id AND f.deleted_at IS NULL
      WHERE b.company_id = ? AND b.parent_item_id = ? AND b.deleted_at IS NULL AND b.active = 1
      ORDER BY b.sort_order, c.code`,
    [companyId, parentItemId],
  );
  if (!rows.length) return rows;

  /*
   * The sizes the recipe states, if it states any. One query for the whole
   * list rather than one per line, and attached as a plain object so a client
   * renders `line.defaults.length_mm` without knowing the field registry.
   */
  const [vals] = await exec.query(
    `SELECT v.scope_id AS lineId, f.field_key AS k, v.value_num AS n
       FROM fab_field_values v
       JOIN fab_fields f ON f.id = v.field_id
      WHERE v.company_id = ? AND v.scope = 'bom_line'
        AND v.scope_id IN (?) AND v.deleted_at IS NULL`,
    [companyId, rows.map((r) => r.id)],
  );
  const byLine = new Map();
  for (const v of vals) {
    const e = byLine.get(Number(v.lineId)) ?? {};
    e[v.k] = v.n == null ? null : Number(v.n);
    byLine.set(Number(v.lineId), e);
  }
  for (const r of rows) r.defaults = byLine.get(Number(r.id)) ?? {};
  return rows;
}

/** Every line in the company, indexed by parent — one query for a whole walk. */
async function bomIndex(companyId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT b.id AS lineId,
            b.parent_item_id AS parentItemId, b.child_item_id AS childItemId,
            b.qty_num AS qtyNum, b.qty_param AS qtyParam, b.default_qty AS defaultQty,
            b.per_instance_qty AS perInstanceQty, b.code_segment AS codeSegment,
            b.help_text AS helpText, b.sort_order AS sortOrder,
            b.default_flow_id AS defaultFlowId, b.code_join AS codeJoin, b.explode AS explode,
            c.code AS childCode, c.name AS childName, c.unit AS childUnit
       FROM fab_item_bom b
       JOIN fab_item_catalog c ON c.id = b.child_item_id AND c.deleted_at IS NULL
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.active = 1
      ORDER BY b.sort_order, c.code`,
    [companyId],
  );
  const byParent = new Map();
  for (const r of rows) {
    if (!byParent.has(r.parentItemId)) byParent.set(r.parentItemId, []);
    byParent.get(r.parentItemId).push(r);
  }
  return byParent;
}

/**
 * The questions this template asks, in the order they are met walking down.
 *
 * Order matters to a person filling the form in: "how many girders" before "how
 * many segments per girder" reads as the structure being described top-down,
 * which is how somebody thinks about a span.
 *
 * @returns {Promise<Array<{param, defaultQty, askedBy, perInstance, helpText}>>}
 */
export async function parametersFor(companyId, rootItemId, conn = null) {
  const byParent = await bomIndex(companyId, conn);
  const found = new Map();
  const seen = new Set();

  const walk = (itemId, depth) => {
    if (depth > MAX_DEPTH || seen.has(itemId)) return;
    seen.add(itemId);
    for (const line of byParent.get(itemId) ?? []) {
      if (line.qtyParam && !found.has(line.qtyParam)) {
        found.set(line.qtyParam, {
          param: line.qtyParam,
          defaultQty: line.defaultQty == null ? null : Number(line.defaultQty),
          askedBy: line.childName,
          perInstance: !!Number(line.perInstanceQty),
          helpText: line.helpText,
        });
      }
      walk(line.childItemId, depth + 1);
    }
  };
  walk(Number(rootItemId), 0);
  return [...found.values()];
}

/**
 * Does this BOM reference itself, directly or through anything below it?
 *
 * Checked on SAVE rather than only guarded at expansion. A depth cap turns a
 * cycle into a truncated tree, which looks like a structure somebody
 * mis-entered rather than a rule they broke — so it gets shipped and discovered
 * much later.
 *
 * @returns {Promise<string[]>} the path forming the cycle, empty when clean
 */
export async function findCycle(companyId, parentItemId, childItemId, conn = null) {
  const byParent = await bomIndex(companyId, conn);
  const target = Number(parentItemId);
  const path = [];

  const walk = (itemId, depth) => {
    if (depth > MAX_DEPTH) return false;
    if (Number(itemId) === target) return true;
    for (const line of byParent.get(Number(itemId)) ?? []) {
      path.push(line.childName ?? line.childItemId);
      if (walk(line.childItemId, depth + 1)) return true;
      path.pop();
    }
    return false;
  };

  // Adding parent -> child is a cycle when the child can already reach the
  // parent. Asked before the row exists, so it prevents rather than reports.
  return walk(Number(childItemId), 0) ? path : [];
}

/**
 * A STRUCTURE SPEC — the drill-down wizard's complete answer sheet.
 *
 * ```json
 * { "version": 2,
 *   "defaults": { "450085": { "417": 5 } },
 *   "nodes": {
 *     "":   { "children": { "412": 6 } },
 *     "G1": { "children": { "417": 4 } },
 *     "G6": { "sameAs": "G1" } } }
 * ```
 *
 * TWO SCOPES, because the wizard asks two different questions. `defaults` is
 * keyed by CATALOG ITEM and means "every girder takes five segments" — the
 * uniform answer, one entry however many girders there are. `nodes` is keyed by
 * path and means "except this one". Writing the uniform answer out per node
 * instead would put a thousand entries in a column to say one thing, and the
 * spec would stop being something a person can read.
 *
 * KEYED BY CODE PATH relative to the line's root — `G1`, `G1-1` — because that
 * is what a person sees on screen and what makes the saved spec readable a year
 * later. The inner key is the `fab_item_bom` row id rather than the child's
 * name: names get edited, and a spec that silently stops matching after a rename
 * would rebuild a different structure while looking untouched.
 *
 * AN ABSENT NODE INHERITS. A six-girder span where every girder is the same is
 * one line of JSON, not six — so the ordinary case costs nothing and the spec
 * stays diffable.
 *
 * `sameAs` is the similarity link AND the grouping control's only output. Split
 * and Similar are inverses of one another at the same rung, so they are one
 * concept here: a group is a set of paths pointing at one canonical path.
 * Two separate notions of identity would have an undefined state when both
 * were used.
 */
const resolveSpecNode = (nodes, path) => {
  if (!nodes) return null;
  let cur = nodes[path];
  const seen = new Set([path]);
  // A `sameAs` chain, defensively bounded: a spec is user data and a cycle in
  // it must not hang the expander.
  while (cur?.sameAs != null && !seen.has(cur.sameAs)) {
    seen.add(cur.sameAs);
    cur = nodes[cur.sameAs];
  }
  return cur ?? null;
};

/**
 * The canonical path a node's answers come from — itself, or what it points at.
 * Nodes sharing a canonical path are the same thing said more than once, which
 * is exactly what `similar_group` records.
 */
export const canonicalPath = (nodes, path) => {
  if (!nodes) return path;
  let cur = path;
  const seen = new Set([path]);
  while (nodes[cur]?.sameAs != null && !seen.has(nodes[cur].sameAs)) {
    cur = nodes[cur].sameAs;
    seen.add(cur);
  }
  return cur;
};

/**
 * Expand a template into the tree it would produce. WRITES NOTHING.
 *
 * @param {Record<string, number>} params  parameter name -> quantity
 * @param {object} [opts]
 * @param {object} [opts.spec]  structure spec v2 (see above). Per-node answers
 *        beat everything else; where it says nothing, the old behaviour stands.
 * @param {Record<string, number[]>} [opts.perInstance]  param -> per-instance
 *        counts, e.g. `{ segmentsPerGirder: [4,5,5,5,5,4] }` for the case the
 *        old wizard called `segmentCounts`. Short or absent falls back to the
 *        single figure, so the simple case stays one number. Kept because
 *        orders built before the spec existed still carry it.
 * @returns {Promise<{root, nodes:number, byName:Record<string,number>}>}
 */
export async function expand(companyId, rootItemId, params = {}, opts = {}) {
  const exec = opts.conn ?? pool;
  const byParent = await bomIndex(companyId, exec);

  const [[root]] = await exec.query(
    `SELECT id, code, name, unit FROM fab_item_catalog
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [rootItemId, companyId],
  );
  if (!root) { const e = new Error('That template item does not exist.'); e.status = 404; throw e; }

  const byName = {};
  let nodes = 0;

  const specNodes = opts.spec?.nodes ?? null;
  /** Keyed by catalog item: the uniform answer for every node of that kind. */
  const specDefaults = opts.spec?.defaults ?? null;
  /**
   * A path relative to the line root, computed from the composed code exactly
   * as `instantiate` computes the stored code — one rule, so the key the wizard
   * wrote and the key the expander reads can never drift apart.
   */
  const pathOf = (childCode) => childCode.slice(String(root.code).length).replace(/^-/, '');
  /**
   * Paths that other paths point AT. A group's canonical member is in the group
   * too — otherwise "G2..G5 are the same as G1" would stamp four rows and leave
   * G1 outside the set it defines.
   */
  const groupRoots = new Set(
    Object.values(specNodes ?? {}).map((n) => n?.sameAs).filter((p) => p != null),
  );

  /**
   * `ordinal` is this node's 1-based position among its siblings, which is what
   * `perInstance` indexes and what the code segment numbers. G1's segments and
   * G2's segments differ by nothing else.
   */
  /**
   * Add whatever `itemId` contains to `target`.
   *
   * Separate from node creation so a COLLAPSED level can call it with the same
   * target — see below.
   */
  const addChildren = (target, itemId, code, depth, ancestry, path) => {
    if (depth >= MAX_DEPTH) return;

    for (const line of byParent.get(Number(itemId)) ?? []) {
      let qty = line.qtyNum != null ? Number(line.qtyNum) : Number(params[line.qtyParam] ?? line.defaultQty ?? 0);

      // Per-instance override: this parent's ordinal picks its own count.
      if (Number(line.perInstanceQty) && line.qtyParam) {
        const per = opts.perInstance?.[line.qtyParam];
        const mine = Array.isArray(per) ? per[ancestry.ordinal - 1] : undefined;
        if (mine != null && Number.isFinite(Number(mine))) qty = Number(mine);
      }

      /**
       * THE SPEC WINS, and it wins over `qty_num` too.
       *
       * A fixed quantity on the BOM line is the template's opinion about the
       * usual case, not a constraint on this order — the whole point of the
       * drill-down is that a person can say "this girder takes four segments,
       * that one takes five" about anything the template contains. Letting
       * `qty_num` outrank the answer would make some rows quietly unanswerable
       * while still showing a box to type in.
       *
       * Read against the PARENT's path, because a quantity is a fact about what
       * this parent contains.
       */
      const uniform = specDefaults?.[String(itemId)]?.[String(line.lineId)];
      if (uniform != null && Number.isFinite(Number(uniform))) qty = Number(uniform);
      const mine = resolveSpecNode(specNodes, path)?.children?.[String(line.lineId)];
      if (mine != null && Number.isFinite(Number(mine))) qty = Number(mine);

      /**
       * A QUANTITY OF ZERO COLLAPSES THE LEVEL AND HOISTS WHAT IT CONTAINED.
       *
       * Not "skips it". A PEB has no girders, but it still has parts — they
       * hang off the span instead of off a segment. Three girders cut in one
       * piece have no segments, but each girder still has its seven parts.
       *
       * This is the BOQ format's own rule, stated in boqSheetService's header:
       * "Blank intermediate levels collapse: a PEB with no girders or segments
       * is just Span + Part". The old wizard implemented it as two branches —
       * `if (!girders)` and "girders but no segments, the girder is the
       * assembly" — and I wrongly took those for special cases that would
       * disappear. They are not special cases; they are this rule, written out
       * twice for the only two depths a four-level loop could reach.
       *
       * Recursing with the SAME `target` and the SAME `code` is what hoists:
       * the skipped level contributes no node and no code segment, so a PEB's
       * part is SPANA-TF exactly as it was before.
       *
       * Caught by scripts/compare-wizard.mjs, which is the entire reason that
       * script exists — the normal cases matched and these two did not.
       */
      if (!Number.isFinite(qty) || qty <= 0) {
        addChildren(target, line.childItemId, code, depth + 1, ancestry, path);
        continue;
      }

      /**
       * DOES A QUANTITY MEAN MANY THINGS, OR ONE THING MANY TIMES?
       *
       * Both, and the BOM has to say which. Four girders are four girders: each
       * carries its own mark, its own tasks, its own place on the drawing, so
       * each is its own row. Twenty-one identical stiffeners are ONE part with a
       * quantity — that is how the BOQ writes them, how the shop marks them, and
       * how nesting wants them, because a row is cut from one plate.
       *
       * Exploding everything is what turned 7,212 shear studs into 7,212 items
       * and an order into 17,648 rows. Exploding nothing would give four girders
       * one code between them.
       *
       * The rule that falls out: assemblies explode, parts do not.
       */
      if (!line.explode) {
        nodes++;
        byName[line.childName] = (byName[line.childName] ?? 0) + qty;
        const seg = line.codeSegment ?? String(1);
        const childCode = line.codeJoin === 'absorb' ? `${code}${seg}` : `${code}-${seg}`;
        target.children.push({
          catalogItemId: line.childItemId,
          name: line.childName,
          code: childCode,
          path: pathOf(childCode),
          depth: depth + 1,
          bomLineId: Number(line.lineId),
          defaultFlowId: line.defaultFlowId ?? null,
          qty,
          children: [],
        });
        continue;
      }

      for (let i = 1; i <= qty; i++) {
        /**
         * How this level reads in the composed code.
         *
         *   'G' with qty 6   ->  G1 G2 G3 ...      numbered, because there are several
         *   'TF' with qty 1  ->  TF                bare, because there is only one
         *   null             ->  1 2 3 ...         which is how segments already read
         *
         * The qty-1 case is not cosmetic: a real BOQ says `...-1-TF`, not
         * `...-1-TF1`. Appending an index to a thing there is only one of reads
         * as though a second is expected, and it would not match any code
         * already in the system.
         *
         * THE INDEX GOES BEFORE THE SLASH, NOT AFTER IT.
         *
         * A '/' suffix is what routes an item to a different flow: '/D' means
         * drilled. The flow now comes from the BOM line, but the suffix is
         * EXACTLY. Appending the index blindly turned 'BS/D' at qty 2 into
         * 'BS/D1', whose suffix reads '/D1', which no rule names — so the
         * drilled part was silently given the PLAIN flow and never drilled.
         * Numbering the part rather than the variant ('BS1/D', 'BS2/D') keeps
         * the suffix intact and still tells the two apart.
         *
         * This never bit the old data only because every drilled line there
         * happened to be qty 1.
         */
        const numbered = (segment) => {
          const slash = segment.indexOf('/');
          return slash === -1
            ? `${segment}${i}`
            : `${segment.slice(0, slash)}${i}${segment.slice(slash)}`;
        };
        const seg = line.codeSegment != null
          ? (qty === 1 ? line.codeSegment : numbered(line.codeSegment))
          : String(i);
        /*
         * ABSORB joins without a dash, so girder L1 segment 1 reads L11 —
         * the mark the shop paints on the steel. Anything else keeps the
         * dash, which is what makes a code readable by eye.
         */
        const childCode = line.codeJoin === 'absorb' ? `${code}${seg}` : `${code}-${seg}`;

        nodes++;
        byName[line.childName] = (byName[line.childName] ?? 0) + 1;
        /**
         * THE FLOW COMES FROM THE LINE, not from the child type.
         *
         * The line is the item IN CONTEXT of its parent, which is the whole
         * reason this replaced `fab_flow_rules`: a Top Flange inside a Girder
         * Segment can be made differently from a Top Flange inside a PEB
         * member, and a rule keyed on the type alone could never say so.
         */
        const childPath = pathOf(childCode);
        const child = {
          catalogItemId: line.childItemId,
          name: line.childName,
          code: childCode,
          path: childPath,
          depth: depth + 1,
          bomLineId: Number(line.lineId),
          /**
           * The group this node's answers came from, or null when it answers
           * for itself. Stamped onto `similar_group` at instantiate time, which
           * is what lets `similarityService` propagate a field value written on
           * one girder to the five like it.
           */
          similarGroup: specNodes && canonicalPath(specNodes, childPath) !== childPath
            ? canonicalPath(specNodes, childPath)
            : (groupRoots.has(childPath) ? childPath : null),
          defaultFlowId: line.defaultFlowId ?? null,
          children: [],
        };
        target.children.push(child);
        addChildren(child, line.childItemId, childCode, depth + 1, { ordinal: i }, childPath);
      }
    }
  };

  nodes++;
  byName[root.name] = (byName[root.name] ?? 0) + 1;
  // The root hangs off no BOM line, so it has no default flow. In practice it
  // is the line's top assembly and carries no work of its own anyway.
  const tree = {
    catalogItemId: Number(root.id), name: root.name, code: root.code,
    path: '', depth: 0, bomLineId: null, similarGroup: null,
    defaultFlowId: null, children: [],
  };
  addChildren(tree, Number(root.id), root.code, 0, { ordinal: 1 }, '');
  return { root: tree, nodes, byName };
}

/**
 * The structure, one rung at a time — what the drill-down wizard asks from.
 *
 * ONE STEP PER DEPTH, because that is how somebody describes a span out loud:
 * how many girders, then how many segments each girder takes, then what a
 * segment is made of. The old wizard asked every question at once on one form,
 * which reads as a list of unrelated numbers and gives no place to say "this
 * girder is different".
 *
 * WHAT A STEP CONTAINS. `parents` are the nodes whose contents this step
 * decides; `lines` are the BOM rows available under them; `values` is the count
 * currently in force for each pairing. A step where every parent holds the same
 * counts is the uniform case and needs one number per line — the grid only
 * matters once somebody disagrees with it.
 *
 * COUNTED FROM THE EXPANSION, not re-derived. Asking the expander what it
 * actually built is the only way the screen and the result cannot disagree —
 * and it gets the collapse rule for free: a line answered 0 contributes no
 * children, so its count reads 0 and its own children appear one rung higher,
 * exactly where the tree puts them.
 *
 * ABOVE `maxParents` A STEP IS UNIFORM-ONLY. Eight hundred and ninety corner
 * plates cannot be given individual quantities through a grid of 890 rows; the
 * step says so rather than rendering a wall of boxes nobody will fill in.
 */
export async function structureOutline(companyId, rootItemId, opts = {}) {
  const {
    params = {}, spec = null, perInstance = {}, maxParents = 100, conn = null,
  } = opts;
  const byParent = await bomIndex(companyId, conn);
  const tree = await expand(companyId, rootItemId, params, { spec, perInstance, conn });

  /** Every node, bucketed by its depth. */
  const atDepth = new Map();
  const walk = (n) => {
    if (!atDepth.has(n.depth)) atDepth.set(n.depth, []);
    atDepth.get(n.depth).push(n);
    n.children.forEach(walk);
  };
  walk(tree.root);

  const steps = [];
  for (const depth of [...atDepth.keys()].sort((a, b) => a - b)) {
    // Only nodes the BOM says can contain something are worth a step.
    const holders = atDepth.get(depth).filter((n) => (byParent.get(Number(n.catalogItemId)) ?? []).length);
    if (!holders.length) continue;

    /**
     * ONE STEP PER KIND OF PARENT, not per depth.
     *
     * Depth 1 of a composite span holds Lines, End Diaphragms, Intermediate
     * Diaphragms and Splices — 69 nodes and 18 BOM lines between them, and
     * almost every pairing is meaningless: an End Diaphragm has no Segment
     * line. One grid over all of it is 69 rows of mostly empty boxes.
     *
     * Split by catalog item and each step asks one honest question — "each Line
     * contains how many Segments?" — which is also how somebody describes the
     * structure out loud. Depth still orders the steps, so the drill-down still
     * runs top-down.
     */
    const byKind = new Map();
    for (const n of holders) {
      const k = Number(n.catalogItemId);
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(n);
    }

    for (const [catalogItemId, parents] of byKind) {
      const lineById = new Map();
      for (const p of parents) {
        for (const l of byParent.get(Number(p.catalogItemId)) ?? []) {
          if (!lineById.has(Number(l.lineId))) {
            lineById.set(Number(l.lineId), {
              lineId: Number(l.lineId),
              parentCatalogItemId: Number(l.parentItemId),
              childItemId: Number(l.childItemId),
              childName: l.childName,
              codeSegment: l.codeSegment,
              helpText: l.helpText,
              qtyParam: l.qtyParam,
              defaultQty: l.defaultQty == null ? null : Number(l.defaultQty),
              // A line that does not explode is a PART with a quantity — twenty
              // stiffeners are one row of twenty, not twenty rows. Saying so lets
              // the wizard label the box "quantity" instead of "how many".
              explode: !!Number(l.explode),
              // A line with children of its own is an assembly, and answering it 0
              // hoists those children rather than deleting them. The screen has to
              // be able to say that, or a 0 looks destructive.
              hasChildren: (byParent.get(Number(l.childItemId)) ?? []).length > 0,
            });
          }
        }
      }

      const values = {};
      for (const p of parents) {
        const mine = {};
        for (const l of byParent.get(Number(p.catalogItemId)) ?? []) {
          const kids = p.children.filter((c) => Number(c.bomLineId) === Number(l.lineId));
          mine[String(l.lineId)] = Number(l.explode)
            ? kids.length
            : (kids[0]?.qty ?? 0);
        }
        values[p.path] = mine;
      }

      steps.push({
        // Stable across re-outlines, so the wizard can stay on the same step
        // while the answers underneath it change.
        key: `${depth}:${catalogItemId}`,
        depth,
        catalogItemId,
        // Named from the catalog, never from an enum — "Girder" is on screen
        // because a catalog item is called Girder.
        label: parents[0].name,
        parents: parents.slice(0, maxParents).map((p) => ({
          path: p.path, code: p.code, name: p.name,
          catalogItemId: Number(p.catalogItemId),
          similarGroup: p.similarGroup ?? null,
        })),
        parentCount: parents.length,
        // Beyond the cap the grid is withheld, and the step says why.
        perNode: parents.length <= maxParents,
        lines: [...lineById.values()],
        values,
      });
    }
  }

  return { steps, nodes: tree.nodes, byName: tree.byName, rootCode: tree.root.code };
}

/**
 * The BOM as a tree to EDIT, one node per line, quantities as they default.
 *
 * ── WHY THIS IS NOT `expand` ──────────────────────────────────────────────
 * `expand` produces what would be BUILT: six girders become six nodes. This
 * produces what the BOM SAYS: one Girder node reading x6. That is the shape
 * somebody edits — you change a 6 to a 4 in one place, not in six — and it is
 * also the shape the order should end up in, because a row is a design and its
 * quantity says how many exist. `markService` has said so all along: "twelve
 * identical stiffeners are all S3 with qty 12 — a mark names a design. We never
 * mint twelve marks."
 *
 * Nothing here answers questions. A parameterised quantity comes back as its
 * default and the editor changes it like any other number, so there is no
 * separate notion of "the questions this template asks" to keep in step with
 * the BOM that asks them.
 *
 * @returns {Promise<object>} the root, children nested, ready to be edited
 */
export async function draftTree(companyId, rootItemId, conn = null) {
  const exec = conn ?? pool;
  const byParent = await bomIndex(companyId, exec);
  const [[root]] = await exec.query(
    `SELECT id, code, name, unit FROM fab_item_catalog
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [rootItemId, companyId],
  );
  if (!root) { const e = new Error('That item does not exist.'); e.status = 404; throw e; }

  let seq = 0;
  /** A local id, so the editor can address a node before it exists anywhere. */
  const key = () => `n${++seq}`;

  const build = (itemId, depth, seen) => {
    if (depth >= MAX_DEPTH) return [];
    return (byParent.get(Number(itemId)) ?? []).map((line) => {
      /*
       * A cycle is guarded by the path, not by a global visited set: the same
       * item legitimately appears twice in one tree — a Top Flange under a
       * Segment and another under a Diaphragm — and a global set would silently
       * drop the second.
       */
      const cyclic = seen.has(Number(line.childItemId));
      /**
       * A PARAMETERISED LINE WITH NO ANSWER IS null, NOT A NUMBER.
       *
       * It used to fall back to `default_qty`, and with the defaults removed it
       * would have fallen to 0 — which both writers then turned into 1, because
       * "0 of something" reads as a mistake. So "nobody has said how many
       * splices" would have quietly become "one splice", and 1 looks like a
       * decision in a way that a blank never does.
       *
       * null travels to the editor as an empty box, and the writers refuse it.
       */
      const qty = line.qtyNum != null
        ? Number(line.qtyNum)
        : (line.defaultQty == null ? null : Number(line.defaultQty));
      return {
        key: key(),
        catalogItemId: Number(line.childItemId),
        name: line.childName,
        unit: line.childUnit ?? 'nos',
        // null survives — see the comment above. Coercing it to 0 here was the
        // last place a blank could quietly become a number.
        qty: qty === null ? null : (Number.isFinite(qty) ? qty : null),
        codeSegment: line.codeSegment,
        codeJoin: line.codeJoin ?? 'dash',
        defaultFlowId: line.defaultFlowId ?? null,
        // Where it came from, so an untouched tree can be recognised as the
        // BOM's own shape rather than something hand-built.
        bomLineId: Number(line.lineId),
        /** What the BOM called this quantity, if it asked for one. */
        qtyParam: line.qtyParam ?? null,
        children: cyclic ? [] : build(line.childItemId, depth + 1, new Set([...seen, Number(line.childItemId)])),
      };
    });
  };

  const tree = {
    key: 'root',
    catalogItemId: Number(root.id),
    name: root.name,
    unit: root.unit ?? 'nos',
    qty: 1,
    codeSegment: null,
    codeJoin: 'dash',
    defaultFlowId: null,
    bomLineId: null,
    qtyParam: null,
    dims: {},
    children: build(Number(root.id), 0, new Set([Number(root.id)])),
  };

  /*
   * SIZES THE RECIPE STATES, attached to the nodes that came from a line.
   *
   * One query for the whole tree rather than one per node — a span walks 32
   * lines and a deeper template many more. Nodes with no size get {}, which the
   * editor renders as empty boxes to fill in rather than as nothing to fill.
   */
  const lineIds = [];
  const collect = (n) => { if (n.bomLineId) lineIds.push(Number(n.bomLineId)); (n.children ?? []).forEach(collect); };
  collect(tree);
  if (lineIds.length) {
    const [vals] = await exec.query(
      `SELECT v.scope_id AS lineId, f.field_key AS k, v.value_num AS n
         FROM fab_field_values v
         JOIN fab_fields f ON f.id = v.field_id
        WHERE v.company_id = ? AND v.scope = 'bom_line' AND v.scope_id IN (?)
          AND v.deleted_at IS NULL
          AND f.field_key IN ('thickness_mm','width_mm','length_mm')`,
      [companyId, lineIds],
    );
    const byLine = new Map();
    for (const v of vals) {
      const e = byLine.get(Number(v.lineId)) ?? {};
      e[v.k] = v.n == null ? null : Number(v.n);
      byLine.set(Number(v.lineId), e);
    }
    const attach = (n) => {
      n.dims = n.bomLineId ? (byLine.get(Number(n.bomLineId)) ?? {}) : {};
      (n.children ?? []).forEach(attach);
    };
    attach(tree);
  }

  return tree;
}

/**
 * How many of this row — or a refusal.
 *
 * There is no sensible default. Coercing a missing answer to 1 is what makes it
 * dangerous: one splice on a bridge that needs sixteen is a number somebody
 * will read as deliberate and never question. A blank cannot be mistaken for
 * an answer, so it is carried as one all the way to here and refused.
 */
function requireQty(node) {
  const n = Number(node?.qty);
  if (!Number.isFinite(n) || n <= 0) {
    const e = new Error(
      `"${node?.name ?? 'A row'}" has no quantity. Fill it in before building — `
      + 'there is no sensible number to assume.',
    );
    e.status = 400;
    throw e;
  }
  return n;
}

/** Flatten an expanded tree into rows, parents before children. */
export function flatten(node, parentPath = null, out = []) {
  out.push({ catalogItemId: node.catalogItemId, name: node.name, code: node.code, parentPath });
  for (const c of node.children) flatten(c, node.code, out);
  return out;
}

/**
 * Add or update one BOM line, refusing a cycle and refusing an ambiguous qty.
 */
export async function setBomLine(companyId, line, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();
    const { id, parentItemId, childItemId } = line;
    const hasNum = line.qtyNum != null && line.qtyNum !== '';
    const hasParam = !!(line.qtyParam && String(line.qtyParam).trim());

    // Exactly one. Both would mean two answers to "how many"; neither would
    // silently expand to zero and collapse the level with no explanation.
    if (hasNum === hasParam) {
      const e = new Error('A BOM line needs either a fixed quantity or a parameter name, not both and not neither.');
      e.status = 400;
      throw e;
    }
    if (Number(parentItemId) === Number(childItemId)) {
      const e = new Error('An item cannot contain itself.');
      e.status = 400;
      throw e;
    }
    const cycle = await findCycle(companyId, parentItemId, childItemId, conn);
    if (cycle.length) {
      const e = new Error(`That would make a loop: ${cycle.join(' -> ')} already leads back here.`);
      e.status = 400;
      throw e;
    }

    const cols = [
      companyId, parentItemId, childItemId,
      hasNum ? Number(line.qtyNum) : null,
      hasParam ? String(line.qtyParam).trim() : null,
      line.defaultQty == null || line.defaultQty === '' ? null : Number(line.defaultQty),
      line.perInstanceQty ? 1 : 0,
      line.codeSegment ?? null,
      line.helpText ?? null,
      line.sortOrder ?? 0,
      // Null is a real answer, not "unset": a grouping level carries no flow.
      line.defaultFlowId == null || line.defaultFlowId === '' ? null : Number(line.defaultFlowId),
    ];

    let lineId = id ? Number(id) : null;
    if (id) {
      await conn.query(
        `UPDATE fab_item_bom
            SET parent_item_id=?, child_item_id=?, qty_num=?, qty_param=?, default_qty=?,
                per_instance_qty=?, code_segment=?, help_text=?, sort_order=?, default_flow_id=?
          WHERE id=? AND company_id=?`,
        [...cols.slice(1), id, companyId],
      );
    } else {
      const [ins] = await conn.query(
        `INSERT INTO fab_item_bom
           (company_id, parent_item_id, child_item_id, qty_num, qty_param, default_qty,
            per_instance_qty, code_segment, help_text, sort_order, default_flow_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        cols,
      );
      lineId = ins.insertId;
    }

    /**
     * SIZES ON THE RECIPE, optional.
     *
     * "A Top Flange inside a Composite Girder Segment is 40 x 700 x 12000" is a
     * fact about the design, and stating it here means nobody retypes it on
     * every order. Leaving it blank is equally valid — plenty of parts are sized
     * per job — which is why nothing is required.
     *
     * Held as field values at scope 'bom_line' rather than as columns on this
     * table, so the next field somebody wants a default for (hole count, weld
     * length) needs no migration.
     *
     * A blank CLEARS. Passing `{ length_mm: '' }` means "the recipe no longer
     * says", which has to be expressible or a wrong default could never be
     * withdrawn — and it is soft-deleted rather than removed because
     * `uq_ffv_target` counts deleted rows and a later re-entry must not collide.
     */
    if (line.defaults && typeof line.defaults === 'object' && lineId) {
      const keys = Object.keys(line.defaults);
      if (keys.length) {
        const [fields] = await conn.query(
          `SELECT id, field_key, default_unit FROM fab_fields
            WHERE company_id = ? AND deleted_at IS NULL AND field_key IN (?)`,
          [companyId, keys],
        );
        for (const f of fields) {
          const raw = line.defaults[f.field_key];
          const blank = raw === '' || raw === null || raw === undefined;
          if (blank) {
            await conn.query(
              `UPDATE fab_field_values SET deleted_at = NOW()
                WHERE company_id = ? AND field_id = ? AND scope = 'bom_line' AND scope_id = ?
                  AND deleted_at IS NULL`,
              [companyId, f.id, lineId],
            );
            continue;
          }
          const num = Number(raw);
          await conn.query(
            `INSERT INTO fab_field_values
               (company_id, field_id, scope, scope_id, value_num, unit_code, created_at)
             VALUES (?,?,'bom_line',?,?,?,NOW())
             ON DUPLICATE KEY UPDATE value_num = VALUES(value_num),
                                     unit_code = VALUES(unit_code), deleted_at = NULL`,
            [companyId, f.id, lineId, Number.isFinite(num) ? num : null, f.default_unit ?? null],
          );
        }
      }
    }

    if (owned) await conn.commit();
    return { ok: true, id: lineId };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

export async function removeBomLine(companyId, id) {
  const [r] = await pool.query(
    'UPDATE fab_item_bom SET deleted_at = NOW() WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [id, companyId],
  );
  if (!r.affectedRows) { const e = new Error('That BOM line does not exist.'); e.status = 404; throw e; }
  return { id: Number(id) };
}

/**
 * Create the order's items from a template. COPY ON FORMATION.
 *
 * The instance is a copy, not a live reference. A template edit next month must
 * not silently redefine a span somebody already promised a customer — and the
 * wizard lets you deviate from the template anyway, so a live reference could
 * never have described what was actually being built.
 *
 * INSTANCES ARE NOT CATALOGUED. Each row points AT its catalog item via
 * `catalog_item_id`; it does not become one. Thirty top flanges are thirty
 * fab_items rows and one catalog row.
 *
 * `catalog_item_id` on a made item is constraint C2 coming true. Two things had
 * to be right first, and both now are:
 *
 *   - a child's ROLE comes from `node_kind`, not from "has a catalog id", or
 *     every girder here would be classified as raw material for its span and
 *     gated on as steel waiting to arrive (H1)
 *   - `procurement_type` is written explicitly as 'make', because
 *     procurementService treats a null one as make-by-absence and would
 *     otherwise mirror the catalog row and could flip these to BUY (H2)
 *
 * @returns {Promise<{created:number, rootItemId:number, byDepth:Record<number,number>}>}
 */
export async function instantiate(companyId, spec, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();
    const {
      orderId, orderLineId = null, rootItemId,
      params = {}, perInstance = {}, structure = null, codePrefix = null, replace = false,
    } = spec;

    /**
     * BUILDING TWICE MUST NOT BUILD TWICE.
     *
     * This appends. Nothing stopped a second run, so pressing the structure
     * wizard again gave a line two spans, two sets of girders and two of
     * everything below — silently, because every code is prefixed by the line
     * and the duplicates look like ordinary rows. It never came up while the
     * only caller was a dialog nothing mounted; it is the first thing that
     * happens once the button is real.
     *
     * So: refuse when the line already has a structure, and say how much, unless
     * the caller has explicitly asked to replace it.
     *
     * Scoped to the LINE, not the order. An order with three lines is three
     * structures, and rebuilding one must not take the others with it.
     */
    const lineScope = orderLineId == null
      ? { sql: 'AND order_line_id IS NULL', args: [] }
      : { sql: 'AND order_line_id = ?', args: [orderLineId] };

    const [[already]] = await conn.query(
      `SELECT COUNT(*) AS n FROM fab_items
        WHERE company_id = ? AND order_id = ? ${lineScope.sql} AND deleted_at IS NULL`,
      [companyId, orderId, ...lineScope.args],
    );

    if (already.n > 0) {
      if (!replace) {
        const e = new Error(
          `This line already has ${already.n} item(s). Building again would add a second copy `
          + 'of everything — replace the existing structure, or pick a different line.',
        );
        e.status = 409;
        e.code = 'ALREADY_BUILT';
        e.existing = already.n;
        throw e;
      }

      /**
       * Replacing throws away the item tree, so it may not throw away history.
       * The same rule the BOQ import already applies, at line granularity.
       */
      const [[worked]] = await conn.query(
        `SELECT COUNT(*) AS n FROM fab_project_tasks t
           JOIN fab_items i ON i.id = t.item_id AND i.company_id = t.company_id
          WHERE t.company_id = ? AND t.order_id = ? ${lineScope.sql.replace('order_line_id', 'i.order_line_id')}
            AND i.deleted_at IS NULL AND t.deleted_at IS NULL
            AND (t.started_at IS NOT NULL OR t.status IN ('in_progress','paused','done'))`,
        [companyId, orderId, ...lineScope.args],
      );
      if (worked.n > 0) {
        const e = new Error(
          `Replace refused: ${worked.n} task(s) on this line have already been started or finished. `
          + 'Rebuilding the structure would throw that shop-floor history away.',
        );
        e.status = 409;
        e.code = 'WORK_STARTED';
        throw e;
      }

      const [ids] = await conn.query(
        `SELECT id FROM fab_items
          WHERE company_id = ? AND order_id = ? ${lineScope.sql} AND deleted_at IS NULL`,
        [companyId, orderId, ...lineScope.args],
      );
      const itemIds = ids.map((r) => r.id);
      if (itemIds.length) {
        await conn.query(
          `UPDATE fab_task_inputs SET deleted_at = NOW()
            WHERE company_id = ? AND task_id IN (
              SELECT id FROM (SELECT id FROM fab_project_tasks
                WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL) x
            ) AND deleted_at IS NULL`,
          [companyId, companyId, itemIds],
        );
        await conn.query(
          `UPDATE fab_project_tasks SET deleted_at = NOW()
            WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL`,
          [companyId, itemIds],
        );
        await conn.query(
          `UPDATE fab_items SET deleted_at = NOW()
            WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
          [companyId, itemIds],
        );
      }
    }

    const tree = await expand(companyId, rootItemId, params, { perInstance, spec: structure, conn });

    const [kinds] = await conn.query(
      `SELECT id, unit FROM fab_item_catalog
        WHERE company_id = ? AND deleted_at IS NULL`,
      [companyId],
    );
    const kindOf = new Map(kinds.map((k) => [Number(k.id), k]));

    const byDepth = {};
    let created = 0;

    /** Depth-first, parents before children, because a child needs its id. */
    const write = async (node, parentItemId, prefix, depth) => {
      const meta = kindOf.get(Number(node.catalogItemId)) ?? {};
      /**
       * EVERYTHING A TEMPLATE BUILDS IS STRUCTURE.
       *
       * A material link is a different thing entirely — it is created by
       * `itemMaterialService` as a child of a part once nesting decides which
       * plate that part is cut from, and it is what gates the task on steel
       * arriving. A template that produced material rows would have every
       * girder waiting on a delivery that is never coming.
       */
      const isLeaf = node.children.length === 0 ? 1 : 0;
      /**
       * The template's code is relative to its ROOT; the order's prefix makes
       * it absolute.
       *
       * Strip the whole root code, not its first segment. The root's own code
       * is `COMPOS-SPAN` — two segments — so slicing one left `SPAN` embedded
       * in every descendant and produced `TST-SPAN-G1-1-TF` where the real
       * order says `…-G1-1-TF`.
       */
      const rel = node.code.slice(tree.root.code.length).replace(/^-/, '');
      const code = prefix ? (rel ? `${prefix}-${rel}` : prefix) : node.code;

      const [r] = await conn.query(
        // The FLOW comes from the BOM LINE this node was expanded from — see
        // `expand`. Nothing here parses a code, and nothing consults a rules
        // table; `fab_flow_rules` is gone.
        //
        // `similar_group` is the wizard's "these are the same" answer, written
        // into the column `similarityService` already reads — so a value typed
        // on one girder reaches its peers with no new machinery. The group key
        // is the canonical path, which is stable across a rebuild from the same
        // spec.
        `INSERT INTO fab_items
           (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
            name, unit, qty, code, node_kind, depth, is_leaf, procurement_type, flow_id,
            similar_group)
         VALUES (?,?,?,?,?,?,?,?,?,'structure',?,?,'make',?,?)`,
        [
          companyId, orderId, orderLineId, parentItemId, node.catalogItemId,
          node.name, meta.unit ?? 'nos', node.qty ?? 1, code, depth, isLeaf, node.defaultFlowId ?? null,
          node.similarGroup ?? null,
        ],
      );
      created++;
      byDepth[depth] = (byDepth[depth] ?? 0) + 1;

      for (const child of node.children) await write(child, r.insertId, prefix, depth + 1);
      return r.insertId;
    };

    const rootId = await write(tree.root, null, codePrefix, 0);

    // Remember what it was built from, and when the copy was taken. Recomputing
    // this later would give the template's CURRENT shape, which is exactly the
    // thing that must not move under a confirmed order.
    if (orderLineId) {
      await conn.query(
        `UPDATE fab_order_lines
            SET template_item_id = ?, template_params = ?, template_snapshot_at = NOW()
          WHERE id = ? AND company_id = ?`,
        // The spec travels with the line so the wizard can be REOPENED on it —
        // a structure you cannot read back is a structure you can only rebuild
        // from memory.
        [rootItemId, JSON.stringify({ params, perInstance, structure }), orderLineId, companyId],
      );
    }

    if (owned) await conn.commit();
    return { created, rootItemId: rootId, byDepth };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/**
 * Write an EXPLICIT tree onto an order line. What you send is what gets built.
 *
 * ── WHY THIS EXISTS BESIDE `instantiate` ──────────────────────────────────
 * `instantiate` takes ANSWERS and expands a BOM into them. That is right when a
 * wizard asks questions, and wrong when somebody has an editable tree in front
 * of them: they have already said exactly what they want, and re-deriving it
 * from a spec is a second chance to build something else. Here the client sends
 * the tree and this writes it, unchanged.
 *
 * ── ONE ROW PER NODE, QUANTITY ON THE ROW ─────────────────────────────────
 * Six diaphragms are one row reading 6, not six rows. That is what the rest of
 * the system already assumes — weights multiply unit by qty, a task covers
 * `task_qty` pieces, and a mark names a design — and it is why an order that
 * described 669 t needed 1,276 rows to do it.
 *
 * The same refusals as `instantiate`: it will not build twice over an existing
 * structure, and it will not replace one whose tasks have been started.
 */
export async function buildFromTree(companyId, spec, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();
    const { orderId, orderLineId = null, tree, replace = false } = spec;
    if (!tree || !tree.catalogItemId) {
      const e = new Error('No structure was sent.'); e.status = 400; throw e;
    }

    const lineScope = orderLineId == null
      ? { sql: 'AND order_line_id IS NULL', args: [] }
      : { sql: 'AND order_line_id = ?', args: [orderLineId] };

    const [[already]] = await conn.query(
      `SELECT COUNT(*) AS n FROM fab_items
        WHERE company_id = ? AND order_id = ? ${lineScope.sql} AND deleted_at IS NULL`,
      [companyId, orderId, ...lineScope.args]);
    if (already.n > 0) {
      if (!replace) {
        const e = new Error(
          `This line already has ${already.n} item(s). Building again would add a second copy `
          + 'of everything — replace what is there, or pick a different line.');
        e.status = 409; e.code = 'ALREADY_BUILT'; e.existing = already.n; throw e;
      }
      const [[worked]] = await conn.query(
        `SELECT COUNT(*) AS n FROM fab_project_tasks t
           JOIN fab_items i ON i.id = t.item_id AND i.company_id = t.company_id
          WHERE t.company_id = ? AND t.order_id = ? ${lineScope.sql.replace('order_line_id', 'i.order_line_id')}
            AND i.deleted_at IS NULL AND t.deleted_at IS NULL
            AND (t.started_at IS NOT NULL OR t.status IN ('in_progress','paused','done'))`,
        [companyId, orderId, ...lineScope.args]);
      if (worked.n > 0) {
        const e = new Error(
          `Replace refused: ${worked.n} task(s) on this line have been started or finished. `
          + 'Rebuilding would throw that shop-floor history away.');
        e.status = 409; e.code = 'WORK_STARTED'; throw e;
      }
      const [ids] = await conn.query(
        `SELECT id FROM fab_items WHERE company_id = ? AND order_id = ? ${lineScope.sql} AND deleted_at IS NULL`,
        [companyId, orderId, ...lineScope.args]);
      const itemIds = ids.map((r) => r.id);
      if (itemIds.length) {
        await conn.query(
          `UPDATE fab_project_tasks SET deleted_at = NOW()
            WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL`, [companyId, itemIds]);
        await conn.query(
          `UPDATE fab_items SET deleted_at = NOW()
            WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`, [companyId, itemIds]);
      }
    }

    const [kinds] = await conn.query(
      `SELECT id, unit, procurement_type FROM fab_item_catalog
        WHERE company_id = ? AND deleted_at IS NULL`, [companyId]);
    const unitOf = new Map(kinds.map((k) => [Number(k.id), k.unit]));
    /*
     * MAKE OR BUY COMES FROM THE CATALOG, not from a constant.
     *
     * This wrote 'make' for every row, which is right for 31 rows of a span and
     * wrong for the 32nd: a headed shear stud arrives on a lorry. Marked 'make'
     * it would be handed to the shop as 7,212 things to manufacture, and it
     * would be offered to nesting as something to cut out of plate.
     *
     * The catalog answers for anything bound to it; a row bound to nothing is
     * made here, which is the same rule the importer used.
     */
    const procurementOf = new Map(kinds.map((k) => [Number(k.id), k.procurement_type]));

    let created = 0;
    let seeded = 0;
    const byDepth = {};
    /** (bom line id, new item id) for every row that came from a recipe line. */
    const fromBomLine = [];
    /** (item id, field key, value) for sizes stated on the tree that was sent. */
    const nodeDims = [];

    /**
     * Depth-first, parents before children, one row at a time — a child needs
     * its parent's id, and counting up from a bulk insert's insertId is the
     * trap ARCHITECTURE warns about.
     */
    /**
     * NO CODE IS WRITTEN HERE, deliberately.
     *
     * A code names a piece somebody can point at on the floor, and at BOM time
     * no such piece exists — the row says "six end diaphragms of this design",
     * which is a requirement, not six things. Writing `…-SPAN1-ED-EDBF` anyway
     * did two harmful things at once: it minted identity for something that had
     * none, and it baked TREE POSITION into that identity, so the same plate cut
     * to the same size under a different parent got a different name.
     *
     * Codes are minted later, at production-order time, where the pieces become
     * real: assemblies get one code each, parts share a code derived from order
     * + material + grade + dimensions. `itemCodeService` only ever fills blanks,
     * so leaving NULL here is exactly what that pass expects to find.
     *
     * `codeSegment` and `codeJoin` still ride along on the tree. They are the
     * BOM's own abbreviations and the code pass will want them — they are data
     * being carried, not a decision being made here.
     */
    const write = async (node, parentItemId, depth) => {
      const kids = Array.isArray(node.children) ? node.children : [];
      const [r] = await conn.query(
        `INSERT INTO fab_items
           (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
            name, unit, qty, code, node_kind, depth, is_leaf, procurement_type, flow_id)
         VALUES (?,?,?,?,?,?,?,?,NULL,'structure',?,?,?,?)`,
        [companyId, orderId, orderLineId, parentItemId, node.catalogItemId,
          node.name, node.unit ?? unitOf.get(Number(node.catalogItemId)) ?? 'nos',
          requireQty(node),
          depth, kids.length ? 0 : 1,
          procurementOf.get(Number(node.catalogItemId)) ?? 'make',
          node.defaultFlowId ?? null]);
      created++;
      byDepth[depth] = (byDepth[depth] ?? 0) + 1;
      if (node.bomLineId) fromBomLine.push([Number(node.bomLineId), r.insertId]);
      /*
       * Sizes carried on the node itself — how the spreadsheet import gets its
       * dimensions in. They beat a BOM-line default because they are what this
       * order was told, and the recipe is only a starting point.
       */
      if (node.dims && typeof node.dims === 'object') {
        for (const [k, v] of Object.entries(node.dims)) {
          if (Number.isFinite(Number(v))) nodeDims.push([r.insertId, k, Number(v)]);
        }
      }

      for (const child of kids) await write(child, r.insertId, depth + 1);
      return r.insertId;
    };

    const rootId = await write(tree, null, 0);

    /**
     * DEFAULTS COME DOWN FROM THE BOM LINE, the same way the flow does.
     *
     * A recipe may state a size — "a Top Flange inside a Composite Girder
     * Segment is 40 x 700 x 12000" — held as field values at scope 'bom_line'.
     * They are COPIED onto the rows here rather than resolved through at read
     * time, for two reasons: the numbers are then visible and editable on the
     * Parameters step instead of arriving from somewhere the reader cannot see,
     * and editing the BOM later cannot silently move an order already built.
     * That order was built from what the recipe said then.
     *
     * A value already on the row wins — nothing here overwrites, because this
     * runs once at build when there is nothing to overwrite, and a rebuild that
     * clobbered somebody's typed dimension would be the worst kind of quiet.
     */
    if (fromBomLine.length) {
      const lineIds = [...new Set(fromBomLine.map(([lineId]) => lineId))];
      const [defaults] = await conn.query(
        `SELECT scope_id AS lineId, field_id AS fieldId, value_num, value_text, value_date, unit_code
           FROM fab_field_values
          WHERE company_id = ? AND scope = 'bom_line' AND scope_id IN (?) AND deleted_at IS NULL`,
        [companyId, lineIds],
      );
      if (defaults.length) {
        const byLine = new Map();
        for (const d of defaults) byLine.set(Number(d.lineId), [...(byLine.get(Number(d.lineId)) ?? []), d]);
        const rows = [];
        for (const [lineId, itemId] of fromBomLine) {
          for (const d of byLine.get(lineId) ?? []) {
            rows.push([companyId, d.fieldId, 'order_item', itemId,
              d.value_num, d.value_text, d.value_date, d.unit_code, new Date()]);
          }
        }
        for (let i = 0; i < rows.length; i += 500) {
          await conn.query(
            `INSERT INTO fab_field_values
               (company_id, field_id, scope, scope_id, value_num, value_text, value_date, unit_code, created_at)
             VALUES ?`,
            [rows.slice(i, i + 500)],
          );
        }
        seeded = rows.length;
        /*
         * A recipe that stated a size has just given every row one, so the
         * numbers computed from it are computed now rather than waiting for
         * somebody to open Parameters and save something.
         */
        await recomputeDerived(companyId, [...new Set(fromBomLine.map(([, itemId]) => itemId))], conn);
      }
    }

    if (orderLineId) {
      await conn.query(
        `UPDATE fab_order_lines
            SET template_item_id = ?, template_params = ?, template_snapshot_at = NOW()
          WHERE id = ? AND company_id = ?`,
        // The TREE is the record of what was built, not a set of answers that
        // would have to be re-expanded to find out.
        [tree.catalogItemId, JSON.stringify({ version: 3, tree }), orderLineId, companyId]);
    }

    /*
     * Written AFTER the BOM-line defaults so they win: a size on the sheet is
     * what this order was told, and the recipe is only where it started.
     */
    if (nodeDims.length) {
      const keys = [...new Set(nodeDims.map(([, k]) => k))];
      const [fdefs] = await conn.query(
        `SELECT id, field_key, default_unit FROM fab_fields
          WHERE company_id = ? AND deleted_at IS NULL AND field_key IN (?)`,
        [companyId, keys],
      );
      const fieldOf = new Map(fdefs.map((f) => [f.field_key, f]));
      for (const [itemId, key, value] of nodeDims) {
        const f = fieldOf.get(key);
        if (!f) continue;
        await conn.query(
          `INSERT INTO fab_field_values
             (company_id, field_id, scope, scope_id, value_num, unit_code, created_at)
           VALUES (?,?,'order_item',?,?,?,NOW())
           ON DUPLICATE KEY UPDATE value_num = VALUES(value_num), deleted_at = NULL`,
          [companyId, f.id, itemId, value, f.default_unit ?? null],
        );
      }
      await recomputeDerived(companyId, [...new Set(nodeDims.map(([id]) => id))], conn);
    }

    if (owned) await conn.commit();
    return { created, seeded, sized: nodeDims.length, rootItemId: rootId, byDepth };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/**
 * duplicateSubtree — copy one structure row and everything under it.
 *
 * The copy lands beside the original, under the same parent, so "six of these
 * and four of those" is: build the BOM, copy the row, change the copy. That is
 * the same gesture the structure editor offers before anything is written; this
 * is it after, on the tree, where somebody is looking at what they built and
 * wants a second one that is nearly the same.
 *
 * WHAT IS NOT COPIED, and why each one:
 *   `code`      — nothing at this stage has one, and identity is not duplicable
 *                 anyway. A copy is a different thing, not the same thing twice.
 *   `mark`      — the same, for the paint pen.
 *   `nest_no`   — the original's pieces were assigned to a plate; the copy's
 *                 have not been cut and must not claim that steel.
 *   `blank_catalog_item_id` — derived from material, grade and size, so it is
 *                 re-derived rather than carried.
 *   weights     — server-owned roll-ups; they recompute.
 *
 * FIELD VALUES DO COME ALONG. Dimensions live in the field registry now, and a
 * copy that arrives with empty sizes would have to be filled in from scratch,
 * which is most of the reason somebody copies a row rather than adding one.
 *
 * MATERIAL LINKS DO NOT. A `node_kind = 'material'` row says which plate a part
 * was cut from — that belongs to a nest, not to the design being copied.
 */
export async function duplicateSubtree(companyId, orderId, itemId, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();

    const [[root]] = await conn.query(
      `SELECT * FROM fab_items
        WHERE company_id = ? AND order_id = ? AND id = ? AND deleted_at IS NULL`,
      [companyId, orderId, itemId],
    );
    if (!root) { const e = new Error('That row is not on this order.'); e.status = 404; throw e; }
    if (root.node_kind === 'material') {
      const e = new Error('A material link belongs to a nest, not to the structure — it cannot be copied.');
      e.status = 400; throw e;
    }

    /*
     * The whole subtree in ONE query rather than a walk per level: an order can
     * be a thousand rows and a recursive read would be a thousand round trips
     * to TiDB. Levels are walked in memory instead.
     */
    const [all] = await conn.query(
      `SELECT id, parent_item_id, order_line_id, catalog_item_id, name, unit, qty,
              flow_id, procurement_type, node_kind, depth, is_leaf, dim_unit, weight_unit
         FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
          AND NOT node_kind = 'material'`,
      [companyId, orderId],
    );
    const kidsOf = new Map();
    for (const r of all) {
      const k = r.parent_item_id == null ? 'root' : String(r.parent_item_id);
      kidsOf.set(k, [...(kidsOf.get(k) ?? []), r]);
    }

    const idMap = new Map();       // old id -> new id
    let created = 0;

    const copy = async (row, newParentId) => {
      const [ins] = await conn.query(
        `INSERT INTO fab_items
           (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
            name, unit, qty, flow_id, procurement_type, node_kind, depth, is_leaf,
            dim_unit, weight_unit)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [companyId, orderId, row.order_line_id, newParentId, row.catalog_item_id,
          row.name, row.unit, row.qty, row.flow_id, row.procurement_type,
          row.node_kind, row.depth, row.is_leaf, row.dim_unit, row.weight_unit],
      );
      idMap.set(Number(row.id), ins.insertId);
      created += 1;
      for (const kid of kidsOf.get(String(row.id)) ?? []) await copy(kid, ins.insertId);
      return ins.insertId;
    };

    const newRootId = await copy(root, root.parent_item_id);

    /*
     * Field values, in one statement per source row rather than a read and a
     * write each. `uq_ffv_target` is unique on (company, field, scope, scope_id)
     * and the copies have ids nothing has ever used, so there is nothing to
     * collide with.
     */
    const oldIds = [...idMap.keys()];
    if (oldIds.length) {
      const [vals] = await conn.query(
        `SELECT field_id, scope_id, value_num, value_text, value_date, unit_code
           FROM fab_field_values
          WHERE company_id = ? AND scope = 'order_item' AND scope_id IN (?)
            AND deleted_at IS NULL`,
        [companyId, oldIds],
      );
      if (vals.length) {
        await conn.query(
          `INSERT INTO fab_field_values
             (company_id, field_id, scope, scope_id, value_num, value_text, value_date, unit_code, created_at)
           VALUES ?`,
          [vals.map((v) => [companyId, v.field_id, 'order_item', idMap.get(Number(v.scope_id)),
            v.value_num, v.value_text, v.value_date, v.unit_code, new Date()])],
        );
      }
    }

    if (owned) await conn.commit();
    return { created, newRootItemId: newRootId };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/**
 * currentTree — the structure as it STANDS, in the shape the editor speaks.
 *
 * `draftTree` answers "what does the catalogue say this is made of". This
 * answers "what did we decide", which stops being the same thing the moment
 * somebody changes a quantity. Editing needs the second; rebuilding needs the
 * first, and offering only the first meant the only way to change one row was
 * to throw away all of them and start again.
 *
 * Every node carries `itemId`, which is what lets a save be a DIFF rather than
 * a replace — a row that survives keeps its id, and with it the dimensions
 * somebody typed and the plate it was nested onto.
 */
export async function currentTree(companyId, orderId, orderLineId = null, conn = null) {
  const exec = conn ?? pool;
  const lineScope = orderLineId == null ? '' : 'AND order_line_id = ?';
  const [rows] = await exec.query(
    `SELECT id, parent_item_id AS parentItemId, catalog_item_id AS catalogItemId,
            name, unit, qty, flow_id AS flowId
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
        AND NOT node_kind = 'material' ${lineScope}
      ORDER BY id`,
    orderLineId == null ? [companyId, orderId] : [companyId, orderId, orderLineId],
  );
  if (!rows.length) return null;

  const kids = new Map();
  for (const r of rows) {
    const k = r.parentItemId == null ? 'root' : String(r.parentItemId);
    kids.set(k, [...(kids.get(k) ?? []), r]);
  }
  const build = (r) => ({
    key: `i${r.id}`,
    itemId: Number(r.id),
    catalogItemId: r.catalogItemId == null ? null : Number(r.catalogItemId),
    name: r.name,
    unit: r.unit ?? 'nos',
    qty: Number(r.qty),
    codeSegment: null,
    codeJoin: 'dash',
    defaultFlowId: r.flowId == null ? null : Number(r.flowId),
    bomLineId: null,
    qtyParam: null,
    children: (kids.get(String(r.id)) ?? []).map(build),
  });
  const roots = kids.get('root') ?? [];
  if (!roots.length) return null;
  // One line, one top. Several roots means the order has several lines and the
  // caller did not say which — answer with the first rather than inventing a
  // parent that is not in the data.
  const tree = build(roots[0]);

  /*
   * The sizes this order actually states, so the editor can show and change them
   * beside the row they belong to. One query, not one per node.
   */
  const [vals] = await exec.query(
    `SELECT v.scope_id AS itemId, f.field_key AS k, v.value_num AS n
       FROM fab_field_values v
       JOIN fab_fields f ON f.id = v.field_id
      WHERE v.company_id = ? AND v.scope = 'order_item' AND v.scope_id IN (?)
        AND v.deleted_at IS NULL
        AND f.field_key IN ('thickness_mm','width_mm','length_mm')`,
    [companyId, rows.map((r) => r.id)],
  );
  const byItem = new Map();
  for (const v of vals) {
    const e = byItem.get(Number(v.itemId)) ?? {};
    e[v.k] = v.n == null ? null : Number(v.n);
    byItem.set(Number(v.itemId), e);
  }
  const attach = (n) => {
    n.dims = byItem.get(Number(n.itemId)) ?? {};
    (n.children ?? []).forEach(attach);
  };
  attach(tree);
  return tree;
}

/**
 * applyTree — save an EDITED structure by diffing it against what is there.
 *
 * WHY NOT JUST REPLACE. `buildFromTree(replace)` soft-deletes every row and
 * writes fresh ones, which is right when the recipe is being taken again and
 * wrong for an edit: new ids mean the dimensions somebody typed, the plate a
 * part was nested onto and every field value hanging off the row all point at
 * rows that no longer exist. Changing one quantity would quietly cost all of it.
 *
 * So a row still in the tree keeps its id, and only what actually changed is
 * written.
 *
 * WHAT IT REFUSES: deleting a row whose work has started. Everything else is
 * allowed, including deleting a row with tasks that have not begun — those are
 * a plan, not history.
 */
export async function applyTree(companyId, spec, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();
    const { orderId, orderLineId = null, tree } = spec;
    if (!tree) { const e = new Error('No structure was sent.'); e.status = 400; throw e; }

    const lineScope = orderLineId == null
      ? { sql: '', args: [] }
      : { sql: 'AND order_line_id = ?', args: [orderLineId] };

    const [existing] = await conn.query(
      `SELECT id, parent_item_id AS parentItemId, name, unit, qty, depth, is_leaf AS isLeaf
         FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
          AND NOT node_kind = 'material' ${lineScope.sql}`,
      [companyId, orderId, ...lineScope.args],
    );
    const byId = new Map(existing.map((r) => [Number(r.id), r]));

    const [kinds] = await conn.query(
      `SELECT id, unit, procurement_type FROM fab_item_catalog
        WHERE company_id = ? AND deleted_at IS NULL`,
      [companyId],
    );
    const unitOf = new Map(kinds.map((k) => [Number(k.id), k.unit]));
    const procurementOf = new Map(kinds.map((k) => [Number(k.id), k.procurement_type]));

    const seen = new Set();
    let created = 0;
    let updated = 0;
    /** (item id, field key, value|null) for every size the tree carried. */
    const dimEdits = [];

    const walk = async (node, parentItemId, depth) => {
      const kids = Array.isArray(node.children) ? node.children : [];
      const isLeaf = kids.length ? 0 : 1;
      const qty = requireQty(node);
      const unit = node.unit ?? unitOf.get(Number(node.catalogItemId)) ?? 'nos';

      let id = node.itemId && byId.has(Number(node.itemId)) ? Number(node.itemId) : null;
      if (id) {
        const was = byId.get(id);
        const same = was.name === node.name
          && (was.unit ?? '') === (unit ?? '')
          && Number(was.qty) === qty
          && Number(was.parentItemId ?? 0) === Number(parentItemId ?? 0)
          && Number(was.depth) === depth
          && Number(was.isLeaf) === isLeaf;
        if (!same) {
          await conn.query(
            `UPDATE fab_items
                SET name = ?, unit = ?, qty = ?, parent_item_id = ?, depth = ?, is_leaf = ?
              WHERE id = ? AND company_id = ?`,
            [node.name, unit, qty, parentItemId, depth, isLeaf, id, companyId],
          );
          updated += 1;
        }
        seen.add(id);
      } else {
        const [r] = await conn.query(
          `INSERT INTO fab_items
             (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
              name, unit, qty, code, node_kind, depth, is_leaf, procurement_type, flow_id)
           VALUES (?,?,?,?,?,?,?,?,NULL,'structure',?,?,?,?)`,
          [companyId, orderId, orderLineId, parentItemId, node.catalogItemId,
            node.name, unit, qty, depth, isLeaf,
            procurementOf.get(Number(node.catalogItemId)) ?? 'make',
            node.defaultFlowId ?? null],
        );
        id = r.insertId;
        created += 1;
      }

      /*
       * Sizes come back with the tree, because the editor now shows them on the
       * row they belong to. A key present and blank CLEARS: "this part no longer
       * states a length" has to be sayable, or a wrong number could never be
       * withdrawn from the row it was typed on.
       */
      if (node.dims && typeof node.dims === 'object') {
        for (const [k, v] of Object.entries(node.dims)) {
          dimEdits.push([id, k, v === '' || v == null ? null : Number(v)]);
        }
      }

      for (const kid of kids) await walk(kid, id, depth + 1);
      return id;
    };

    await walk(tree, null, 0);

    if (dimEdits.length) {
      const keys = [...new Set(dimEdits.map(([, k]) => k))];
      const [fdefs] = await conn.query(
        `SELECT id, field_key, default_unit FROM fab_fields
          WHERE company_id = ? AND deleted_at IS NULL AND field_key IN (?)`,
        [companyId, keys],
      );
      const fieldOf = new Map(fdefs.map((f) => [f.field_key, f]));
      for (const [itemId, key, value] of dimEdits) {
        const f = fieldOf.get(key);
        if (!f) continue;
        if (value == null || !Number.isFinite(value)) {
          await conn.query(
            `UPDATE fab_field_values SET deleted_at = NOW()
              WHERE company_id = ? AND field_id = ? AND scope = 'order_item' AND scope_id = ?
                AND deleted_at IS NULL`,
            [companyId, f.id, itemId],
          );
          continue;
        }
        await conn.query(
          `INSERT INTO fab_field_values
             (company_id, field_id, scope, scope_id, value_num, unit_code, created_at)
           VALUES (?,?,'order_item',?,?,?,NOW())
           ON DUPLICATE KEY UPDATE value_num = VALUES(value_num), deleted_at = NULL`,
          [companyId, f.id, itemId, value, f.default_unit ?? null],
        );
      }
      // Weight and area are arithmetic on what just changed.
      await recomputeDerived(companyId, [...new Set(dimEdits.map(([id]) => id))], conn);
    }

    const gone = existing.map((r) => Number(r.id)).filter((id) => !seen.has(id));
    if (gone.length) {
      const [[worked]] = await conn.query(
        `SELECT COUNT(*) AS n FROM fab_project_tasks
          WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL
            AND (started_at IS NOT NULL OR status IN ('in_progress','paused','done'))`,
        [companyId, gone],
      );
      if (worked.n > 0) {
        const e = new Error(
          `Refused: ${worked.n} task(s) on the row(s) you removed have been started or finished. `
          + 'Removing them would throw that shop-floor history away.',
        );
        e.status = 409; e.code = 'WORK_STARTED'; throw e;
      }
      await conn.query(
        `UPDATE fab_project_tasks SET deleted_at = NOW()
          WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL`,
        [companyId, gone],
      );
      /*
       * Material links go with their part. A link says "this part comes off that
       * plate", and the part is gone — leaving it would hold steel for something
       * nobody is making.
       */
      await conn.query(
        `UPDATE fab_items SET deleted_at = NOW()
          WHERE company_id = ?
            AND (id IN (?) OR (parent_item_id IN (?) AND node_kind = 'material'))
            AND deleted_at IS NULL`,
        [companyId, gone, gone],
      );
    }

    if (owned) await conn.commit();
    return { created, updated, removed: gone.length, sized: dimEdits.length };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}
